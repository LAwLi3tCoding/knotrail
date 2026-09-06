import { fork, type Serializable } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Runner, RunnerCallbacks, RunnerRequest, RunnerResult, RunControl, ToolCall, ToolResult } from './contracts.js';

/** One isolated pi SDK session per Run. Tool effects remain owned by the Coordinator. */
export class PiRunner implements Runner {
  async run(request: RunnerRequest, callbacks: RunnerCallbacks, signal: AbortSignal): Promise<RunnerResult> {
    if (signal.aborted) return { summary: 'Run cancelled', turns: 0, aborted: true };
    const bundled = fileURLToPath(new URL('./pi-worker.mjs', import.meta.url));
    const source = fileURLToPath(new URL('./pi-worker.ts', import.meta.url));
    const child = fork(existsSync(bundled) ? bundled : source, [], {
      execArgv: existsSync(bundled) ? [] : ['--import', 'tsx'],
      env: { PATH: process.env.PATH, HOME: request.sessionDir, TMPDIR: process.env.TMPDIR, ELECTRON_RUN_AS_NODE: '1', PI_OFFLINE: '1' },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      serialization: 'json',
    });
    const clean = (value: string) => request.model.apiKey ? value.split(request.model.apiKey).join('[redacted]') : value;
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
    const deadline = setTimeout(abort, request.timeoutMs);
    child.stderr?.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-8_000); });
    child.on('message', (raw: unknown) => {
      const msg = raw as { kind: string; id: number; call: ToolCall; control: RunControl; eventKind: string; text: string; data?: unknown; result: RunnerResult; error: string };
      if (msg.kind === 'event') callbacks.onEvent(msg.eventKind, clean(msg.text), msg.data);
      else if (msg.kind === 'result') result = msg.result;
      else if (msg.kind === 'error') failure = clean(msg.error);
      else if (msg.kind === 'tool' || msg.kind === 'control') {
        pending = pending.then(async () => {
          let value: ToolResult;
          try {
            value = cancelled ? { text: 'Run cancelled; tool admission closed', isError: true }
              : msg.kind === 'tool' ? await callbacks.onTool(msg.call) : await callbacks.onControl(msg.control);
          } catch (error) { value = { text: clean(error instanceof Error ? error.message : String(error)), isError: true }; }
          send({ kind: 'reply', id: msg.id, value });
        });
      }
    });
    send({ kind: 'start', request });
    return new Promise<RunnerResult>((resolve, reject) => {
      child.once('error', error => { failure = clean(error.message); });
      child.once('close', async code => {
        clearTimeout(deadline); clearTimeout(killTimer); signal.removeEventListener('abort', abort);
        await pending;
        if (cancelled) return resolve({ ...result, summary: result?.summary || 'Run cancelled or timed out', turns: result?.turns || 0, usage: result?.usage?{...result.usage,partial:true}:undefined, aborted: true });
        if (failure || code !== 0 || !result) return reject(new Error(failure || clean(stderr) || `pi worker exited (${code})`));
        resolve(result);
      });
    });
  }
}
