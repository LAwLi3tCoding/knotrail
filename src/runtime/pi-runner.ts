import { fork, type Serializable } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Runner, RunnerCallbacks, RunnerRequest, RunnerResult, RunControl, ToolCall, ToolResult } from './contracts.js';
import { redact, RedactedStream } from './redaction.js';

/** One isolated pi SDK session per Run. Tool effects remain owned by the Coordinator. */
export class PiRunner implements Runner {
  async run(request: RunnerRequest, callbacks: RunnerCallbacks, signal: AbortSignal): Promise<RunnerResult> {
    if (signal.aborted) return { summary: 'Run cancelled', turns: 0, aborted: true };
    const timeoutMs = Math.min(request.timeoutMs, request.model.authSource === 'codex-login' ? (request.model.expiresAt ?? Infinity) - Date.now() : Infinity);
    if (timeoutMs <= 0) throw new Error('Codex sign-in expired. Update the sign-in in Codex, then resume.');
    const bundled = fileURLToPath(new URL('./pi-worker.mjs', import.meta.url));
    const source = fileURLToPath(new URL('./pi-worker.ts', import.meta.url));
    const child = fork(existsSync(bundled) ? bundled : source, [], {
      execArgv: existsSync(bundled) ? [] : ['--import', 'tsx'],
      env: { PATH: process.env.PATH, HOME: request.sessionDir, TMPDIR: process.env.TMPDIR, ELECTRON_RUN_AS_NODE: '1', PI_OFFLINE: '1' },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      serialization: 'json',
    });
    const clean = <T,>(value: T) => redact(value, request.model.apiKey);
    const deltas = new RedactedStream(request.model.apiKey);
    let stderr = '', result: RunnerResult | undefined, failure: string | undefined;
    let cancelled = false;
    let pending = Promise.resolve();
    const send = (value: unknown) => { if (child.connected) child.send(value as Serializable, () => {}); };
    let killTimer: NodeJS.Timeout | undefined;
    const abort = () => {
      if (cancelled) return;
      cancelled = true;
      send({ kind: 'abort' });
      killTimer = setTimeout(() => child.kill('SIGKILL'), 2_000);
    };
    signal.addEventListener('abort', abort, { once: true });
    const deadline = setTimeout(abort, timeoutMs);
    child.stderr?.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-8_000); });
    child.on('message', (raw: unknown) => {
      const msg = raw as { kind: string; id: number; call: ToolCall; control: RunControl; eventKind: string; text: string; data?: unknown; result: RunnerResult; error: string };
      if (msg.kind === 'event') {
        const text = msg.eventKind === 'assistant.delta' ? deltas.push(msg.text) : clean(msg.text);
        if (text || msg.eventKind !== 'assistant.delta') callbacks.onEvent(msg.eventKind, text, clean(msg.data));
      }
      else if (msg.kind === 'result') result = clean(msg.result);
      else if (msg.kind === 'error') failure = clean(msg.error);
      else if (msg.kind === 'tool' || msg.kind === 'control') {
        pending = pending.then(async () => {
          let value: ToolResult;
          try {
            value = cancelled ? { text: 'Run cancelled; tool admission closed', isError: true }
              : msg.kind === 'tool' ? await callbacks.onTool(clean(msg.call)) : await callbacks.onControl(clean(msg.control));
          } catch (error) { value = { text: clean(error instanceof Error ? error.message : String(error)), isError: true }; }
          send({ kind: 'reply', id: msg.id, value: clean(value) });
        });
      }
    });
    send({ kind: 'start', request });
    return new Promise<RunnerResult>((resolve, reject) => {
      child.once('error', error => { failure = clean(error.message); });
      child.once('close', async code => {
        clearTimeout(deadline); clearTimeout(killTimer); signal.removeEventListener('abort', abort);
        await pending;
        const remaining = deltas.finish(); if (remaining) callbacks.onEvent('assistant.delta', remaining);
        if (cancelled) return resolve({ ...result, summary: result?.summary || 'Run cancelled or timed out', turns: result?.turns || 0, usage: result?.usage?{...result.usage,partial:true}:undefined, aborted: true });
        if (failure || code !== 0 || !result) return reject(new Error(failure || clean(stderr) || `pi worker exited (${code})`));
        resolve(result);
      });
    });
  }
}
