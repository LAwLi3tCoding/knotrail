import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { SandboxExecutor, sandboxCapability } from '../src/execution/sandbox.js';
import { acquireOwnerLock } from '../src/execution/lock.js';
import type { SandboxOptions } from '../src/execution/contracts.js';
import type { ToolCall } from '../src/runtime/contracts.js';

const capability = sandboxCapability();
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'knotrail-sandbox-test-'));
  const workdir = join(root, 'work'); const dataDir = join(root, 'data'); await mkdir(workdir); await mkdir(dataDir);
  const lock = acquireOwnerLock(dataDir);
  t.after(async () => { lock.release(); await rm(root, { recursive: true, force: true }); });
  const options: SandboxOptions = { workdir, dataDir, lockFd: lock.fd, timeoutMs: 8000, allowNetwork: false, protectedPaths: ['verification.txt'] };
  const executor = new SandboxExecutor();
  const run = (name: ToolCall['name'], args: Record<string, unknown>, signal = new AbortController().signal) => executor.execute({ name, args, toolCallId: 'fixture' }, options, signal);
  return { root, workdir, dataDir, lock, options, run };
}

test('owner kernel lock rejects duplicate hosts and symlink aliases', async t => {
  const f = await fixture(t); const alias = join(f.root, 'alias'); await symlink(f.dataDir, alias);
  assert.throws(() => acquireOwnerLock(f.dataDir), /active owner/); assert.throws(() => acquireOwnerLock(alias), /active owner/);
  f.lock.release(); const next = acquireOwnerLock(alias); next.release();
});
test('unsupported or nested sandbox fails closed', { skip: capability.sandbox }, async t => {
  const f = await fixture(t);
  await assert.rejects(f.run('list_files', {}), /sandbox-exec/);
});
test('sandbox text operations require exact preconditions, deny escape/symlinks/protected files', { skip: !capability.sandbox }, async t => {
  const f = await fixture(t);
  assert.equal((await f.run('write_file', { path: 'file.txt', content: 'hello', expectedContent: null })).isError, undefined);
  assert.match((await f.run('read_file', { path: 'file.txt' })).text, /hello/);
  assert.equal((await f.run('write_file', { path: 'file.txt', content: 'lost', expectedContent: null })).isError, true);
  await chmod(join(f.workdir, 'file.txt'), 0o755);
  assert.equal((await f.run('edit_file', { path: 'file.txt', expectedContent: 'hello', oldText: 'hello', newText: 'world' })).isError, undefined);
  assert.equal(await readFile(join(f.workdir, 'file.txt'), 'utf8'), 'world');
  assert.equal((await stat(join(f.workdir, 'file.txt'))).mode & 0o777, 0o755);
  await writeFile(join(f.root, 'outside.txt'), 'secret'); await symlink(join(f.root, 'outside.txt'), join(f.workdir, 'alias.txt'));
  for (const path of ['../outside.txt', 'alias.txt', '.git/config']) assert.equal((await f.run('read_file', { path })).isError, true);
  assert.equal((await f.run('write_file', { path: 'verification.txt', content: 'changed', expectedContent: null })).isError, true);
});
test('OS sandbox blocks command writes outside worktree and into protected paths; environment has no inherited secrets', { skip: !capability.sandbox }, async t => {
  const f = await fixture(t); await writeFile(join(f.root, 'outside.txt'), 'original'); await writeFile(join(f.workdir, 'verification.txt'), 'expected'); await mkdir(join(f.workdir, '.git'));
  const result = await f.run('run_command', { argv: [process.execPath, '-e', `const fs=require('fs');let denied=0;for(const p of ${JSON.stringify([join(f.root, 'outside.txt'), join(f.workdir, 'verification.txt'), join(f.workdir, '.git', 'config')])}){try{fs.writeFileSync(p,'bad')}catch{denied++}};console.log(JSON.stringify({denied,env:Object.keys(process.env)}));if(denied!==3)process.exit(1)`] });
  assert.equal(result.isError, false, result.text); assert.match(result.text, /"denied":3/); assert.doesNotMatch(result.text, /OPENAI_API_KEY|ANTHROPIC_API_KEY|GH_TOKEN/);
  assert.equal(await readFile(join(f.root, 'outside.txt'), 'utf8'), 'original');
});
test('OS sandbox denies network and truncated output is bounded', { skip: !capability.sandbox }, async t => {
  const f = await fixture(t);
  const blocked = await f.run('run_command', { argv: [process.execPath, '-e', "require('net').connect(443,'1.1.1.1').on('connect',()=>process.exit(2)).on('error',()=>{console.log('network denied');process.exit(0)})"] });
  assert.equal(blocked.isError, false, blocked.text); assert.match(blocked.text, /network denied/);
  const huge = await f.run('run_command', { argv: [process.execPath, '-e', "console.log('a'.repeat(200000))"] });
  assert.equal(huge.truncated, true); assert.ok(huge.text.length <= 65536);
});
test('cancellation kills command descendants before execute resolves', { skip: !capability.sandbox }, async t => {
  const f = await fixture(t); const controller = new AbortController();
  const command = `require('child_process').spawn(process.execPath,['-e',"setInterval(()=>require('fs').appendFileSync('ticks.txt','x'),15)"],{stdio:'inherit'});setInterval(()=>{},1000)`;
  const run = f.run('run_command', { argv: [process.execPath, '-e', command] }, controller.signal);
  for (let i = 0; i < 200; i++) { try { if ((await readFile(join(f.workdir, 'ticks.txt'))).length) break; } catch {} await delay(20); }
  controller.abort(); assert.equal((await run).isError, true);
  const before = await readFile(join(f.workdir, 'ticks.txt'), 'utf8'); await delay(150);
  assert.equal(await readFile(join(f.workdir, 'ticks.txt'), 'utf8'), before);
});
test('abrupt owner death disconnects helper and kills descendants before a new owner can write', { skip: !capability.sandbox }, async t => {
  const f = await fixture(t); f.lock.release();
  const childSource = `import {acquireOwnerLock} from './src/execution/lock.ts';import {SandboxExecutor} from './src/execution/sandbox.ts';const lock=acquireOwnerLock(process.argv[1]);const command="require('child_process').spawn(process.execPath,['-e',\\"setInterval(()=>require('fs').appendFileSync('orphan.txt','x'),15)\\"],{stdio:'inherit'});setInterval(()=>{},1000)";await new SandboxExecutor().execute({name:'run_command',toolCallId:'kill-test',args:{argv:[process.execPath,'-e',command]}},{workdir:process.argv[2],dataDir:process.argv[1],lockFd:lock.fd,timeoutMs:10000,allowNetwork:false,protectedPaths:[]},new AbortController().signal);lock.release();`;
  const owner = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', childSource, f.dataDir, f.workdir], { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; owner.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => { owner.kill('SIGKILL'); });
  let started = false;
  for (let i = 0; i < 250; i++) { try { if ((await readFile(join(f.workdir, 'orphan.txt'))).length) { started = true; break; } } catch {} if (owner.exitCode !== null) break; await delay(20); }
  assert.ok(started, stderr || 'Descendant did not start');
  assert.throws(() => acquireOwnerLock(f.dataDir), /active owner/);
  const exited = new Promise(resolve => owner.once('exit', resolve)); owner.kill('SIGKILL'); await exited;
  let replacement;
  for (let i = 0; i < 150; i++) { try { replacement = acquireOwnerLock(f.dataDir); break; } catch {} await delay(20); }
  assert.ok(replacement, 'Owner lock remained held after helper cleanup'); replacement?.release();
  const before = await readFile(join(f.workdir, 'orphan.txt'), 'utf8'); await delay(150);
  assert.equal(await readFile(join(f.workdir, 'orphan.txt'), 'utf8'), before);
});

test('protected parent directories cannot be renamed and commands cannot read external files', { skip: !capability.sandbox }, async t => {
  const f = await fixture(t); await mkdir(join(f.workdir, 'checks')); await writeFile(join(f.workdir, 'checks', 'condition.txt'), 'expected'); await writeFile(join(f.root, 'private.txt'), 'outside');
  f.options.protectedPaths = ['checks/condition.txt'];
  const result = await f.run('run_command', { argv: [process.execPath, '-e', `const fs=require('fs');let denied=0;try{fs.renameSync('checks','moved')}catch{denied++};try{fs.readFileSync(${JSON.stringify(join(f.root, 'private.txt'))})}catch{denied++};console.log(denied);if(denied!==2)process.exit(1)`] });
  assert.equal(result.isError, false, result.text); assert.match(result.text, /2/);
  assert.equal(await readFile(join(f.workdir, 'checks', 'condition.txt'), 'utf8'), 'expected');
});
test('granted network supports IP sockets while command timeout quiesces effects', { skip: !capability.sandbox }, async t => {
  const f = await fixture(t); f.options.allowNetwork = true;
  const result = await f.run('run_command', { argv: [process.execPath, '-e', "const net=require('net');const server=net.createServer(c=>c.end('ok'));server.listen(0,'127.0.0.1',()=>{const c=net.connect(server.address().port,'127.0.0.1');c.on('data',d=>console.log(d.toString()));c.on('end',()=>server.close())})"] });
  assert.equal(result.isError, false, result.text); assert.match(result.text, /ok/);
  const timeout = await f.run('run_command', { argv: [process.execPath, '-e', "setInterval(()=>require('fs').appendFileSync('timed.txt','x'),10)"], timeoutMs: 150 });
  assert.equal(timeout.isError, true); assert.match(timeout.text, /timed out/);
  const before = await readFile(join(f.workdir, 'timed.txt'), 'utf8'); await delay(100); assert.equal(await readFile(join(f.workdir, 'timed.txt'), 'utf8'), before);
});

test('ownership remains locked when the parent closes its fd while a helper still runs', { skip: !capability.sandbox }, async t => {
  const f = await fixture(t); const controller = new AbortController();
  const run = f.run('run_command', { argv: [process.execPath, '-e', "require('fs').writeFileSync('holding.txt','yes');setInterval(()=>{},1000)"] }, controller.signal);
  let started = false;
  for (let i = 0; i < 150; i++) { try { await readFile(join(f.workdir, 'holding.txt')); started = true; break; } catch {} await delay(20); }
  assert.equal(started, true); f.lock.release(); assert.throws(() => acquireOwnerLock(f.dataDir), /active owner/);
  controller.abort(); await run; const replacement = acquireOwnerLock(f.dataDir); replacement.release();
});
test('hash preconditions allow safe edits of truncated reads and reject stale evidence', { skip: !capability.sandbox }, async t => {
  const f = await fixture(t); await writeFile(join(f.workdir, 'large.txt'), 'target\n' + 'a'.repeat(80000));
  const read = await f.run('read_file', { path: 'large.txt' }); assert.equal(read.truncated, true);
  const expectedHash = /^sha256: ([a-f0-9]{64})/.exec(read.text)![1];
  const edit = await f.run('edit_file', { path: 'large.txt', oldText: 'target', newText: 'changed', expectedHash }); assert.equal(edit.isError, undefined, edit.text);
  const stale = await f.run('edit_file', { path: 'large.txt', oldText: 'changed', newText: 'lost', expectedHash }); assert.equal(stale.isError, true);
  assert.ok((await readFile(join(f.workdir, 'large.txt'), 'utf8')).startsWith('changed'));
});


test('network grant enables system DNS while the default grant cannot resolve external names', { skip: !capability.sandbox }, async t => {
  try { await lookup('example.com'); } catch { t.skip('Host DNS is unavailable'); return; }
  const f = await fixture(t);
  const argv = [process.execPath, '-e', "require('dns').lookup('example.com',error=>{console.log(JSON.stringify({resolved:!error,error:error?.code}));process.exit(error?1:0)})"];
  const denied = await f.run('run_command', { argv }); assert.equal(denied.isError, true); assert.match(denied.text, /\"resolved\":false/);
  f.options.allowNetwork = true;
  const granted = await f.run('run_command', { argv }); assert.equal(granted.isError, false, granted.text); assert.match(granted.text, /\"resolved\":true/);
});
