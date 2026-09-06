import { streamSimple } from '@earendil-works/pi-ai/api/openai-codex-responses';
import { setTimeout as delay } from 'node:timers/promises';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { CODEX_BASE_URL, CODEX_RESPONSES_URL, type ModelConfig } from '../shared/contracts.js';

/** Access-only, per-Run configuration. No OAuth store, login, or refresh is used. */
export function codexProvider(config: ModelConfig, requestFetch: typeof fetch = globalThis.fetch, onRetry?: (attempt: number, code: string) => void): Parameters<ModelRuntime['registerProvider']>[1] {
  if (config.baseUrl !== CODEX_BASE_URL) throw new Error('Codex sign-in requires the fixed official endpoint');
  const key = config.apiKey;
  if (!key) throw new Error('Codex access token is unavailable');
  let expiry: number;
  try {
    const parts = key.split('.');
    if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw new Error();
    const claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
    const account = claims['https://api.openai.com/auth']?.chatgpt_account_id;
    if (typeof account !== 'string' || !account || typeof claims.exp !== 'number') throw new Error();
    expiry = Math.min(claims.exp * 1000, config.expiresAt ?? Infinity);
    if (!Number.isFinite(expiry)) throw new Error();
  } catch { throw new Error('Codex access token is invalid'); }
  const checkExpiry = () => { if (Date.now() >= expiry) throw new Error('Codex sign-in expired. Update the sign-in in Codex, then resume.'); };
  checkExpiry();
  const officialFetch: typeof fetch = async (input, init) => {
    checkExpiry();
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url !== CODEX_RESPONSES_URL || init?.method !== 'POST') throw new Error('Codex request must use the fixed official endpoint');
    let response: Response;
    for (let attempt = 0; ; attempt++) {
      checkExpiry();
      try { response = await requestFetch(input, { ...init, redirect: 'error' }); break; }
      catch (error) {
        if (init?.signal?.aborted) throw error;
        const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
        // Retry only before response headers; no streamed output or local tool can be replayed.
        if (attempt < 2 && typeof code === 'string' && ['ECONNRESET', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'ETIMEDOUT'].includes(code)) {
          onRetry?.(attempt + 1, code);
          await delay(250 * (attempt + 1), undefined, { signal: init?.signal ?? undefined });
          continue;
        }
        // Include only known network codes; raw causes can contain private request data.
        const safe = typeof code === 'string' && ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(code) ? ` (${code})` : '';
        throw new Error(`Codex connection failed${safe}. Check the network and resume the task.`);
      }
    }
    if (response.redirected || (response.url && response.url !== CODEX_RESPONSES_URL)) throw new Error('Codex redirects are forbidden');
    return response;
  };
  return {
    api: 'openai-codex-responses', baseUrl: CODEX_BASE_URL, apiKey: key,
    streamSimple(model, context, options) {
      if (model.provider !== 'openai-codex' || model.api !== 'openai-codex-responses' || model.baseUrl !== CODEX_BASE_URL) throw new Error('Invalid Codex provider binding');
      return streamSimple(model as Parameters<typeof streamSimple>[0], context, { ...options, transport: 'sse', fetch: officialFetch, maxRetries: 0 });
    },
  };
}
