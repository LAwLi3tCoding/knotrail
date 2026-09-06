import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const maxCacheBytes = 64 * 1024;
const errors = {
  unavailable: 'Codex login cache is unavailable. Sign in to Codex and try again.',
  cache: 'Codex login cache is invalid. Sign in to Codex again.',
  mode: 'Codex login requires ChatGPT authentication.',
  token: 'Codex login access token is invalid. Sign in to Codex again.',
  expired: 'Codex login has expired. Sign in to Codex again.',
} as const;

function readCache(path: string): string {
  let fd: number;
  try {
    // Nonblocking open also keeps an invalid FIFO cache from hanging the caller.
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    throw new Error(errors.unavailable);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size <= 0 || stat.size > maxCacheBytes) throw new Error();
    const bytes = Buffer.alloc(maxCacheBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > maxCacheBytes) throw new Error();
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
  } catch {
    throw new Error(errors.cache);
  } finally {
    try { closeSync(fd); } catch { throw new Error(errors.cache); }
  }
}

/** Reads local login shape and expiry only; does not verify JWT signatures or server access. */
export function readCodexLogin(path = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json')): { accessToken: string; expiresAt: number } {
  const source = readCache(path);
  let cache: unknown;
  try {
    // Refresh credentials are never retained in the parsed cache or returned to callers.
    cache = JSON.parse(source, (key, value) => key === 'refresh_token' ? undefined : value);
  } catch {
    throw new Error(errors.cache);
  }
  if (!cache || typeof cache !== 'object' || Array.isArray(cache)) throw new Error(errors.cache);
  if ((cache as { auth_mode?: unknown }).auth_mode !== 'chatgpt') throw new Error(errors.mode);
  const tokens = (cache as { tokens?: unknown }).tokens;
  let token: unknown;
  if (tokens && typeof tokens === 'object' && !Array.isArray(tokens)) token = (tokens as { access_token?: unknown }).access_token;
  if (typeof token !== 'string') throw new Error(errors.token);
  let claims: { exp?: unknown; 'https://api.openai.com/auth'?: { chatgpt_account_id?: unknown } };
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw new Error();
    const payload = Buffer.from(parts[1]!, 'base64url');
    if (payload.toString('base64url') !== parts[1]) throw new Error();
    claims = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
    if (!claims || typeof claims !== 'object' || Array.isArray(claims)) throw new Error();
  } catch {
    throw new Error(errors.token);
  }
  const seconds = claims.exp, account = claims['https://api.openai.com/auth']?.chatgpt_account_id;
  if (typeof seconds !== 'number' || !Number.isSafeInteger(seconds) || seconds <= 0 || !Number.isSafeInteger(seconds * 1000) || typeof account !== 'string' || !account.trim()) throw new Error(errors.token);
  const expiresAt = seconds * 1000;
  if (expiresAt <= Date.now()) throw new Error(errors.expired);
  return { accessToken: token, expiresAt };
}
