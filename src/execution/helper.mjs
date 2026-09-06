// The helper deliberately imports only Node stdlib. It receives no model credentials.
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

const LIMIT = 64 * 1024;
const MAX_FILE = 2 * 1024 * 1024;
const skipped = new Set(['.git', 'node_modules', '.next', 'dist', 'release']);
process.stdin.on('end', () => { try { process.kill(-process.pid, 'SIGKILL'); } catch { process.exit(1); } });
let request;
const hash = value => createHash('sha256').update(value).digest('hex');
const contains = (root, path) => path === root || (!relative(root, path).startsWith('..') && !isAbsolute(relative(root, path)));
function bounded(text, extra = {}) { return { text: text.slice(0, LIMIT), truncated: text.length > LIMIT, ...extra }; }
async function checkedPath(input = '.', write = false) {
  if (typeof input !== 'string' || input.includes('\0') || isAbsolute(input)) throw new Error('Expected a relative workspace path');
  const path = resolve(request.workdir, input);
  if (!contains(request.workdir, path)) throw new Error('Path escapes the worktree');
  const parts = relative(request.workdir, path).split('/');
  if (parts.includes('.git')) throw new Error('Git internals are not tool-accessible');
  if (write && request.protectedPaths.some(item => contains(resolve(request.workdir, item), path))) throw new Error('Protected verification path is read-only');
  let current = request.workdir;
  for (const part of parts) {
    if (!part) continue;
    current = join(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error('Symbolic links are not tool-accessible'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return path;
}
async function currentFile(path) {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_FILE) throw new Error('Expected a regular text file no larger than 2 MiB');
      const buffer = Buffer.alloc(stat.size + 1);let size=0,count=0;
      do {({bytesRead:count}=await handle.read(buffer,size,buffer.length-size,null));size+=count;}while(count&&size<buffer.length);
      const after=await handle.stat();
      if(size!==stat.size||after.size!==size||after.mtimeMs!==stat.mtimeMs||after.ctimeMs!==stat.ctimeMs)throw new Error('File changed during read');
      if (buffer.subarray(0,size).includes(0)) throw new Error('Binary files are not supported');
      return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(buffer.subarray(0,size));
    } finally { await handle.close(); }
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function files(root, result = []) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (skipped.has(entry.name) || entry.isSymbolicLink()) continue;
    if (result.length >= 2_000) return result;
    const path = join(root, entry.name);
    if (entry.isDirectory()) await files(path, result);
    else if (entry.isFile()) result.push(path);
  }
  return result;
}
function checkExpected(value, expected, expectedHash) {
  if (expected === undefined && expectedHash === undefined) throw new Error('expectedContent or expectedHash is required');
  if (expected !== undefined && expected !== null && typeof expected !== 'string') throw new Error('Invalid expectedContent');
  if (expectedHash !== undefined && (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedHash))) throw new Error('Invalid expectedHash');
  return (expected === undefined || value === expected) && (expectedHash === undefined || (value !== null && hash(value) === expectedHash));
}
async function replace(path, expected, content, expectedHash) {
  if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_FILE) throw new Error('Content must be text no larger than 2 MiB');
  const before = await currentFile(path);
  if (!checkExpected(before, expected, expectedHash)) throw new Error('File changed: expectedContent does not match. Read it again before editing.');
  await mkdir(dirname(path), { recursive: true });
  await checkedPath(relative(request.workdir, path), true);
  const temp = join(dirname(path), `.knotrail-${randomUUID()}.tmp`);
  const mode = before === null ? 0o644 : (await lstat(path)).mode & 0o777;
  const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, mode);
  try {
    await handle.writeFile(content, 'utf8'); await handle.sync(); await handle.close();
    await checkedPath(relative(request.workdir, path), true);
    if (!checkExpected(await currentFile(path), expected, expectedHash)) throw new Error('Concurrent modification detected before replacement');
    await rename(temp, path);
  } finally { await handle.close().catch(() => {}); await unlink(temp).catch(() => {}); }
  return bounded(`Updated ${relative(request.workdir, path)}\nsha256: ${hash(content)}`);
}
async function execute(call) {
  const args = call.args;
  if (!args || typeof args !== 'object') throw new Error('Tool arguments must be an object');
  if (call.name === 'run_command') {
    if (!Array.isArray(args.argv) || !args.argv.length || args.argv.length > 128 || args.argv.some(value => typeof value !== 'string' || value.includes('\0') || value.length > 64_000)) throw new Error('argv must be a nonempty array of bounded strings');
    const requestedTimeout = args.timeoutMs === undefined ? request.timeoutMs : args.timeoutMs;
    if (!Number.isFinite(requestedTimeout) || requestedTimeout < 1) throw new Error('Invalid command timeout');
    const command = spawn(args.argv[0], args.argv.slice(1), { cwd: request.workdir, env: process.env, shell: false, detached: false, stdio: ['ignore', 'pipe', 'pipe', 'ignore', 4] });
    let output = '', truncated = false;
    const append = buffer => { const value = buffer.toString(); if (output.length + value.length > LIMIT) truncated = true; output = (output + value).slice(0, LIMIT); };
    command.stdout.on('data', append); command.stderr.on('data', append);
    return await new Promise(resolveResult => {
      const timer = setTimeout(() => {
        send({ text: output + '\nCommand timed out', isError: true, truncated }, () => { try { process.kill(-process.pid, 'SIGKILL'); } catch {} });
      }, Math.min(request.timeoutMs, requestedTimeout));
      command.once('error', error => { clearTimeout(timer); resolveResult(bounded(error.message, { isError: true })); });
      // Use exit, not close: background descendants may inherit stdout. Parent kills the group before resolving.
      command.once('exit', code => { clearTimeout(timer); resolveResult({ text: output || `(exit ${code})`, exitCode: code ?? -1, isError: code !== 0, truncated }); });
    });
  }
  if (!['read_file', 'list_files', 'search_files', 'write_file', 'edit_file'].includes(call.name)) throw new Error('Unknown tool');
  const path = await checkedPath(args.path ?? '.', call.name === 'write_file' || call.name === 'edit_file');
  if (call.name === 'read_file') {
    const value = await currentFile(path); if (value === null) throw new Error('File does not exist');
    const text=`sha256: ${hash(value)}\n${value}`;
    return bounded(text,{source:{path:relative(request.workdir,path),sourceDigest:hash(value),complete:text.length<=LIMIT}});
  }
  if (call.name === 'list_files') return bounded((await files(path)).map(path => relative(request.workdir, path)).join('\n'));
  if (call.name === 'search_files') {
    if (typeof args.query !== 'string' || !args.query.length || args.query.length > 4_096) throw new Error('Expected a nonempty literal query');
    const result = [];
    for (const file of await files(path)) {
      let value; try { value = await currentFile(file); } catch { continue; }
      for (const [index, line] of (value || '').split('\n').entries()) if (line.includes(args.query)) result.push(`${relative(request.workdir, file)}:${index + 1}:${line.slice(0, 1_000)}`);
      if (result.length >= 200) break;
    }
    return bounded(result.slice(0, 200).join('\n'));
  }
  if (call.name === 'write_file') return replace(path, args.expectedContent, args.content, args.expectedHash);
  if (typeof args.oldText !== 'string' || !args.oldText || typeof args.newText !== 'string') throw new Error('edit_file requires oldText and newText');
  const value = await currentFile(path);
  if (value === null || !checkExpected(value, args.expectedContent, args.expectedHash)) throw new Error('File changed: expectedContent does not match');
  if (value.split(args.oldText).length !== 2) throw new Error('oldText must occur exactly once');
  return replace(path, args.expectedContent, value.replace(args.oldText, args.newText), args.expectedHash);
}
function send(value, callback) { process.stdout.write(JSON.stringify(value) + '\n', callback); }
let input = '';
process.stdin.on('data', async chunk => {
  if (request) return;
  input += chunk.toString();
  const end = input.indexOf('\n'); if (end < 0) return;
  try { request = JSON.parse(input.slice(0, end)); send(await execute(request.call)); }
  catch (error) { send(bounded(error.message || String(error), { isError: true })); }
  // Keep ownership fd and stdin alive until the parent kills the entire group.
});
