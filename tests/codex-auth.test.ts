import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readCodexLogin } from '../src/core/codex-auth.js';

const authClaim = 'https://api.openai.com/auth';
const future = () => Math.floor(Date.now() / 1000) + 3600;
const jwt = (claims: unknown) => [
  Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url'),
  Buffer.from(JSON.stringify(claims)).toString('base64url'),
  Buffer.from('synthetic-signature').toString('base64url'),
].join('.');
const validToken = (exp = future(), extra = {}) => jwt({ exp, [authClaim]: { chatgpt_account_id: 'synthetic-account' }, ...extra });
const cache = (token = validToken()) => ({ auth_mode: 'chatgpt', tokens: { access_token: token, refresh_token: 'synthetic-refresh-secret', id_token: 'synthetic-id-token' } });
function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'knotrail-auth-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, path: join(root, 'auth.json') };
}
function message(action: () => unknown): string {
  try { action(); } catch (error) {
    assert.ok(error instanceof Error);
    return error.message;
  }
  assert.fail('Expected a fixed login error');
}

test('login reads access token and millisecond expiry without returning or modifying other credentials', t => {
  const { path } = fixture(t), exp = future(), token = validToken(exp);
  const bytes = Buffer.from(JSON.stringify(cache(token), null, 2) + '\n');
  writeFileSync(path, bytes, { mode: 0o600 });
  const before = statSync(path), result = readCodexLogin(path);
  assert.deepEqual(result, { accessToken: token, expiresAt: exp * 1000 });
  assert.deepEqual(Object.keys(result).sort(), ['accessToken', 'expiresAt']);
  assert.equal(JSON.stringify(result).includes('synthetic-refresh-secret'), false);
  assert.deepEqual(readFileSync(path), bytes);
  const after = statSync(path);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(after.mode, before.mode);
});

test('each login read observes a rotated cache and never falls back to a previous token', t => {
  const { path } = fixture(t), first = validToken(future(), { version: 1 }), second = validToken(future(), { version: 2 });
  writeFileSync(path, JSON.stringify(cache(first)));
  assert.equal(readCodexLogin(path).accessToken, first);
  writeFileSync(path, JSON.stringify(cache(second)));
  assert.equal(readCodexLogin(path).accessToken, second);
  rmSync(path);
  assert.equal(message(() => readCodexLogin(path)), 'Codex login cache is unavailable. Sign in to Codex and try again.');
});

test('default login path uses the current CODEX_HOME on every call', t => {
  const { root, path } = fixture(t), secondRoot = join(root, 'second');
  mkdirSync(secondRoot);
  const previous = process.env.CODEX_HOME;
  t.after(() => { if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous; });
  const first = validToken(future(), { version: 1 }), second = validToken(future(), { version: 2 });
  writeFileSync(path, JSON.stringify(cache(first)));
  writeFileSync(join(secondRoot, 'auth.json'), JSON.stringify(cache(second)));
  process.env.CODEX_HOME = root;
  assert.equal(readCodexLogin().accessToken, first);
  process.env.CODEX_HOME = secondRoot;
  assert.equal(readCodexLogin().accessToken, second);
});

test('missing, symbolic, directory, oversized and FIFO caches reject without exposing source values', t => {
  const { root, path } = fixture(t), target = join(root, 'target.json');
  const unavailable = 'Codex login cache is unavailable. Sign in to Codex and try again.';
  const invalid = 'Codex login cache is invalid. Sign in to Codex again.';
  assert.equal(message(() => readCodexLogin(path)), unavailable);
  writeFileSync(target, JSON.stringify(cache()));
  symlinkSync(target, path);
  assert.equal(message(() => readCodexLogin(path)), unavailable);
  rmSync(path); mkdirSync(path);
  assert.equal(message(() => readCodexLogin(path)), invalid);
  rmSync(path, { recursive: true });
  writeFileSync(path, Buffer.alloc(64 * 1024 + 1, 32));
  assert.equal(message(() => readCodexLogin(path)), invalid);
  rmSync(path);
  execFileSync('mkfifo', [path]);
  assert.equal(message(() => readCodexLogin(path)), invalid);
  assert.equal(readFileSync(target).includes(Buffer.from('synthetic-refresh-secret')), true);
});

test('malformed JSON, invalid UTF-8 and the wrong authentication mode use fixed errors', t => {
  const { path } = fixture(t), invalid = 'Codex login cache is invalid. Sign in to Codex again.';
  for (const content of ['', '{synthetic-private-json', 'null', '[]', Buffer.from([0xff, 0xfe])]) {
    writeFileSync(path, content);
    assert.equal(message(() => readCodexLogin(path)), invalid);
  }
  for (const auth_mode of [undefined, 'apikey', 'chatgpt-auth-tokens', 1]) {
    writeFileSync(path, JSON.stringify({ ...cache(), auth_mode }));
    assert.equal(message(() => readCodexLogin(path)), 'Codex login requires ChatGPT authentication.');
  }
});

test('invalid JWT expiry, account claim or token shape fails before any credential is returned', t => {
  const { path } = fixture(t), exp = future(), invalid = 'Codex login access token is invalid. Sign in to Codex again.';
  const claims = [
    {}, { exp }, { exp, [authClaim]: {} }, { exp, [authClaim]: { chatgpt_account_id: '' } },
    { exp, [authClaim]: { chatgpt_account_id: 1 } },
    { [authClaim]: { chatgpt_account_id: 'synthetic-account' } },
    ...[String(exp), 1.5, 0, -1, Number.MAX_SAFE_INTEGER, null].map(value => ({ exp: value, [authClaim]: { chatgpt_account_id: 'synthetic-account' } })),
    null, [], 'claims',
  ];
  for (const token of [...claims.map(jwt), '', 'not-a-jwt', 'a.b.c.d', 'a.!.c', 'a..c', undefined, 42]) {
    writeFileSync(path, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: token } }));
    assert.equal(message(() => readCodexLogin(path)), invalid);
  }
});

test('expired login reports only the fixed expiry error and preserves the cache', t => {
  const { path } = fixture(t), source = JSON.stringify(cache(validToken(Math.floor(Date.now() / 1000) - 1)));
  writeFileSync(path, source);
  assert.equal(message(() => readCodexLogin(path)), 'Codex login has expired. Sign in to Codex again.');
  assert.equal(readFileSync(path, 'utf8'), source);
});
