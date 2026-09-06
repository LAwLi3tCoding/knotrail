// Opt-in diagnostics, not the application's executor or a VM safety certification.
// Requires a running Apple container 1.3.1 service. Only new temporary fixtures are shared.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

assert.equal(process.platform, 'darwin', 'This probe requires macOS');
assert.equal(process.arch, 'arm64', 'This probe requires Apple silicon');
assert.ok(process.argv.length <= 3, 'Usage: node scripts/probe-vm-isolation.mjs [container-executable]');
const cli = process.argv[2] ? resolve(process.argv[2]) : 'container';
const image = 'docker.io/library/alpine@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce';
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
const root = await mkdtemp(join(tmpdir(), 'knotrail-vm-probe-'));
const results = [];

function start(executable, args) {
  const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-64000); });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-64000); });
  const done = new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('CLI observation timed out; VM cleanup is still required'));
    }, 45000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timer); resolveExit({ code, signal, stdout, stderr }); });
  });
  // A readiness check may still be pending when the process fails.
  void done.catch(() => {});
  return { child, done };
}
const run = (executable, args) => start(executable, args).done;
const ok = result => { assert.equal(result.code, 0, result.stderr || result.stdout); return result; };
const text = path => readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
const size = path => stat(path).then(value => value.size).catch(error => { if (error.code === 'ENOENT') return 0; throw error; });
async function ready(path) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await size(path) >= 2) return; await delay(50); }
  throw new Error('Guest writer did not become ready');
}
async function fixture(name, extra, command, observe) {
  const workdir = join(root, name), id = `knotrail-probe-${randomUUID()}`;
  await mkdir(join(workdir, 'checks'), { recursive: true });
  await mkdir(join(workdir, '.git'));
  await writeFile(join(workdir, 'checks/fixed.txt'), 'expected');
  await writeFile(join(workdir, '.git/config'), 'protected-git');
  await writeFile(join(workdir, 'ordinary.txt'), 'before');
  const args = ['run', '--name', id, '--network', 'none', '--cap-drop', 'ALL', '--cpus', '1', '--memory', '256m', '--progress', 'none', '--workdir', '/work', '--mount', `type=bind,source=${workdir},target=/work`, ...extra(workdir), image, '/bin/sh', '-c', command];
  const running = start(cli, args);
  try {
    const result = { name, ...await observe({ workdir, id, running }) };
    results.push(result);
    console.log(JSON.stringify(result));
  } finally {
    running.child.kill('SIGKILL');
    await running.done.catch(() => {});
    // Target only this fixture. No global prune/stop, even on assertion failure.
    ok(await run(cli, ['rm', '--force', id]));
  }
}

const attacks = `set +e
printf updated > ordinary.txt || exit 90
printf created > fresh.txt || exit 91
rm fresh.txt || exit 92
attempt() { label="$1"; shift; "$@" >/dev/null 2>&1; printf '%s=%s\\n' "$label" "$?"; }
attempt write sh -c 'printf changed > checks/fixed.txt'
attempt delete rm checks/fixed.txt
attempt replace sh -c 'printf changed > replacement; mv replacement checks/fixed.txt'
attempt hardlink ln checks/fixed.txt alias
attempt git-write sh -c 'printf changed > .git/config'
attempt git-delete rm .git/config
attempt git-rename mv .git moved-git
attempt ancestor-rename mv checks moved
attempt remount mount -o remount,rw /work/checks/fixed.txt
attempt userns unshare -Ur /bin/true
`;
try {
  const version = ok(await run(cli, ['--version'])).stdout.trim();
  assert.match(version, /\b1\.3\.1\b/, 'Revalidate source and assumptions before using another runtime version');
  const session = ok(await run('/bin/launchctl', ['managername'])).stdout.trim();
  const domain = { Aqua: `gui/${process.getuid()}`, Background: `user/${process.getuid()}`, System: 'system' }[session];
  assert.ok(domain, 'Unsupported launchd session type');
  console.log(JSON.stringify({ runtime: version, image }));
  for (const protectAncestor of [false, true]) {
    await fixture(protectAncestor ? 'ancestor-mount' : 'leaf-only', dir => [
      '--read-only-path', '/work/.git', '--read-only-path', '/work/checks/fixed.txt',
      ...(protectAncestor ? ['--mount', `type=bind,source=${dir}/checks,target=/work/checks`] : []),
    ], attacks, async ({ workdir, running }) => {
      const output = ok(await running.done).stdout.trim();
      const attempts = Object.fromEntries(output.split('\n').map(line => { const [name, code] = line.split('='); return [name, Number(code)]; }));
      for (const name of ['write', 'delete', 'replace', 'hardlink', 'git-write', 'git-delete', 'git-rename', 'remount', 'userns']) assert.ok(Number.isInteger(attempts[name]) && attempts[name] > 0, `${name} was not denied`);
      assert.equal(attempts['ancestor-rename'], protectAncestor ? 1 : 0);
      assert.equal(await text(join(workdir, protectAncestor ? 'checks/fixed.txt' : 'moved/fixed.txt')), 'expected');
      assert.equal(await text(join(workdir, '.git/config')), 'protected-git');
      assert.equal(await text(join(workdir, 'ordinary.txt')), 'updated');
      assert.equal(await text(join(workdir, 'fresh.txt')), null);
      return { attempts, ordinaryWritesPreserved: true };
    });
  }
  // The child deliberately closes inherited I/O and creates a new session.
  const writer = "setsid /bin/sh -c 'i=0; while [ $i -lt 600 ]; do printf x >> /work/ticks; i=$((i+1)); sleep 0.05; done' </dev/null >/dev/null 2>&1 & while [ ! -s /work/ticks ]; do sleep 0.01; done;";
  await fixture('natural-exit', () => [], writer + ' exit 0', async ({ workdir, running }) => {
    ok(await running.done);
    const path = join(workdir, 'ticks'), before = await size(path);
    assert.ok(before > 0);
    await delay(500); assert.equal(await size(path), before);
    return { detachedWriterStopped: true };
  });
  for (const method of ['stop', 'bootout', 'runtime-kill']) {
    await fixture(method, () => [], writer + ' sleep 30', async ({ workdir, id, running }) => {
      const path = join(workdir, 'ticks'); await ready(path);
      const service = `${domain}/com.apple.container.container-runtime-linux.${id}`;
      const state = ok(await run('/bin/launchctl', ['print', service])).stdout;
      const runtimePid = Number(state.match(/\bpid = (\d+)/)?.[1]); assert.ok(runtimePid > 1);
      running.child.kill('SIGKILL'); await running.done;
      const killed = await size(path); await delay(250); const continued = await size(path);
      assert.ok(continued > killed, 'Expected to reproduce CLI death leaving the VM writer alive');
      ok(await (method === 'stop' ? run(cli, ['stop', '--time', '1', id])
        : run('/bin/launchctl', method === 'bootout' ? ['bootout', '--wait', service] : ['kill', 'SIGKILL', service])));
      const stopped = await size(path); await delay(500); assert.equal(await size(path), stopped);
      assert.equal((await run('/bin/ps', ['-p', String(runtimePid), '-o', 'pid='])).code, 1, 'Original runtime process still exists');
      const late = await run(cli, ['exec', id, '/bin/sh', '-c', 'printf late > /work/late']);
      assert.ok(Number.isInteger(late.code) && late.code !== 0, 'Late exec was not rejected');
      assert.equal(await text(join(workdir, 'late')), null);
      return { cliDeathLeftWriterAlive: true, detachedWriterStopped: true, originalRuntimeExited: true, lateExecRejected: true };
    });
  }
  await rm(root, { recursive: true });
  console.log(JSON.stringify({ result: 'passed', cases: results.length, scope: 'VM primitives only; application integration and owner recovery remain unverified' }));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
