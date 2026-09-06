// The helper deliberately imports only Node stdlib. It receives no model credentials.
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

const LIMIT = 64 * 1024;
const MAX_FILE = 2 * 1024 * 1024;
const MAX_REQUEST = 40 * 1024 * 1024; // Bounded JSON includes escaped content, expectedContent, and edit strings.
const skipped = new Set(['.git', 'node_modules', '.next', 'dist', 'release']);
process.stdin.on('end', () => { try { process.kill(-process.pid, 'SIGKILL'); } catch { process.exit(1); } });
let request, pendingIntent, intentSent = false, protocolFailed = false, resultSent = false;
const hash = value => createHash('sha256').update(value).digest('hex');
const contains = (root, path) => path === root || (!relative(root, path).startsWith('..') && !isAbsolute(relative(root, path)));
function bounded(text, extra = {}) { return { text: text.slice(0, LIMIT), truncated: text.length > LIMIT, ...extra }; }
async function checkedPath(input = '.', write = false) {
  if (typeof input !== 'string' || !input.isWellFormed() || input.includes('\0') || isAbsolute(input)) throw new Error('Expected a relative workspace path');
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
async function fileSnapshot(path) {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_FILE) throw new Error('Expected a regular text file no larger than 2 MiB');
      const buffer = Buffer.alloc(stat.size + 1);let size=0,count=0;
      do {({bytesRead:count}=await handle.read(buffer,size,buffer.length-size,null));size+=count;}while(count&&size<buffer.length);
      const after=await handle.stat(), current=await lstat(path);
      if(size!==stat.size||after.size!==size||after.mtimeMs!==stat.mtimeMs||after.ctimeMs!==stat.ctimeMs||current.dev!==stat.dev||current.ino!==stat.ino||current.ctimeMs!==after.ctimeMs)throw new Error('File changed during read');
      if (buffer.subarray(0,size).includes(0)) throw new Error('Binary files are not supported');
      return { content: new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(buffer.subarray(0,size)), sourceDigest: hash(buffer.subarray(0,size)), mode: after.mode & 0o777 };
    } finally { await handle.close(); }
}
async function currentFile(path) { return (await fileSnapshot(path))?.content ?? null; }
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
  if (typeof content !== 'string' || !content.isWellFormed() || content.includes('\0') || Buffer.byteLength(content) > MAX_FILE) throw new Error('Content must be valid UTF-8 text without NUL, no larger than 2 MiB');
  const before = await fileSnapshot(path), bytes = Buffer.from(content, 'utf8');
  if (!checkExpected(before?.content ?? null, expected, expectedHash)) throw new Error('File changed: expectedContent does not match. Read it again before editing.');
  const mode = before === null ? 0o644 & ~process.umask() : before.mode;
  const intent = { id: randomUUID(), path: relative(request.workdir, path), before: before ? { exists: true, sourceDigest: before.sourceDigest, mode: before.mode } : { exists: false, sourceDigest: null }, after: { exists: true, sourceDigest: hash(bytes), mode } };
  if (request.requireFileIntent) {
    if (intentSent) throw new Error('Duplicate file mutation intent');
    intentSent = true;
    await new Promise((resolveIntent, rejectIntent) => {
      pendingIntent = { id: intent.id, resolve: resolveIntent, reject: rejectIntent };
      send({ kind: 'file_intent', intent }, error => { if (error) failProtocol(error); });
    });
  }
  const checkBefore = async () => {
    if (protocolFailed) throw new Error('File intent protocol failed');
    await checkedPath(intent.path, true);
    const current = await fileSnapshot(path);
    if (!checkExpected(current?.content ?? null, expected, expectedHash) || current?.sourceDigest !== before?.sourceDigest || current?.mode !== before?.mode) throw new Error('Concurrent modification detected before replacement');
  };
  // No directory, temporary file, or write is created before the durable intent acknowledgement.
  await checkBefore();
  await mkdir(dirname(path), { recursive: true });
  await checkBefore();
  const temp = join(dirname(path), `.knotrail-${randomUUID()}.tmp`);
  const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(bytes); await handle.chmod(mode); await handle.sync(); await handle.close();
    await checkBefore();
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
        sendResult({ text: output + '\nCommand timed out', isError: true, truncated }, () => { try { process.kill(-process.pid, 'SIGKILL'); } catch {} });
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
  return replace(path, args.expectedContent, value.replace(args.oldText, () => args.newText), args.expectedHash);
}
function send(value, callback) { process.stdout.write(JSON.stringify(value) + '\n', callback); }
function sendResult(result, callback) { if (!resultSent) { resultSent = true; send({ kind: 'result', result }, callback); } }
function failProtocol(error) {
  protocolFailed = true;
  pendingIntent?.reject(error); pendingIntent = undefined;
  sendResult(bounded(error.message || String(error), { isError: true }));
}
let input = [], inputBytes = 0;
process.stdin.on('data', chunk => {
  if (protocolFailed) return;
  for (let start = 0; start < chunk.length;) {
    const end = chunk.indexOf(10, start), part = chunk.subarray(start, end < 0 ? chunk.length : end);
    inputBytes += part.length;
    if (inputBytes > (request ? 4096 : MAX_REQUEST)) { failProtocol(new Error('Sandbox request exceeds protocol limit')); return; }
    input.push(part); start = end < 0 ? chunk.length : end + 1;
    if (end < 0) break;
    let value;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(input, inputBytes))); }
    catch { failProtocol(new Error('Invalid sandbox request')); return; }
    input = []; inputBytes = 0;
    if (!request) {
      if (!value || typeof value !== 'object' || !value.call) { failProtocol(new Error('Invalid sandbox request')); return; }
      request = value;
      void execute(request.call).then(result => sendResult(result), error => sendResult(bounded(error.message || String(error), { isError: true })));
    } else {
      if (resultSent || !pendingIntent || value?.kind !== 'file_intent_ack' || value.id !== pendingIntent.id || Object.keys(value).length !== 2) { failProtocol(new Error('Invalid or unexpected file intent acknowledgement')); return; }
      const pending = pendingIntent; pendingIntent = undefined; pending.resolve();
    }
  }
  // Keep ownership fd and stdin alive until the parent kills the entire group.
});
