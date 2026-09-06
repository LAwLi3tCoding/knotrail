import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { zstdDecompressSync } from 'node:zlib';
import { test } from 'node:test';
import { InMemoryCredentialStore, type Context } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { CODEX_BASE_URL, CODEX_RESPONSES_URL, type ModelConfig } from '../src/shared/contracts.js';
import { codexProvider } from '../src/runtime/codex-provider.js';
import { redact, RedactedStream } from '../src/runtime/redaction.js';

function config(): ModelConfig {
  const expiresAt = Date.now() + 60_000;
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const key = [encode({ alg: 'none' }), encode({ exp: Math.ceil(expiresAt / 1000), 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account' } }), encode(randomUUID())].join('.');
  return { authSource: 'codex-login', baseUrl: CODEX_BASE_URL, apiKey: key, expiresAt, modelId: 'gpt-6-astra', thinking: 'low', contextWindow: 272000, maxTokens: 4096 };
}
function response(callId: string, name: string, args: unknown): Response {
  const item = { type: 'function_call', id: `fc_${callId}`, call_id: callId, name, arguments: JSON.stringify(args), status: 'completed' };
  const events = [{ type: 'response.created', response: { id: `resp_${callId}` } }, { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '' } }, { type: 'response.function_call_arguments.delta', output_index: 0, delta: item.arguments }, { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response: { id: `resp_${callId}`, status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } }];
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
}
const context: Context = { systemPrompt: 'Use the supplied tools.', messages: [{ role: 'user', content: 'Inspect then finish.', timestamp: 1 }], tools: [{ name: 'read_file', description: 'Read', parameters: Type.Object({ path: Type.String() }) }, { name: 'outcome', description: 'Finish', parameters: Type.Object({ kind: Type.String(), summary: Type.String() }) }] };

test('Codex access-only runtime uses official SSE and preserves tool IDs across two Responses turns', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network'); });
  const websocket = t.mock.method(globalThis, 'WebSocket', function () { throw new Error('Unexpected WebSocket'); });
  const options = config(), bodies: Record<string, any>[] = [], headers: Headers[] = [];
  const provider = codexProvider(options, async (url, init) => {
    assert.equal(url, CODEX_RESPONSES_URL); assert.equal(init?.redirect, 'error');
    const header = new Headers(init?.headers); headers.push(header);
    const body = typeof init!.body === 'string' ? init!.body : zstdDecompressSync(init!.body as Uint8Array).toString('utf8');
    bodies.push(JSON.parse(body));
    return bodies.length === 1 ? response('call_a', 'read_file', { path: 'fixture.txt' }) : response('call_b', 'outcome', { kind: 'complete', summary: 'Done' });
  });
  const credentials = new InMemoryCredentialStore();
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerProvider('openai-codex', provider);
  const model = runtime.getModel('openai-codex', options.modelId)!;
  assert.ok(model); assert.equal(model.provider, 'openai-codex');
  assert.notEqual(model.maxTokens, options.maxTokens); // Keep the offline catalog metadata for subscription models.
  assert.equal(runtime.getModel('openai-codex', 'unavailable-fixture-model'), undefined);
  const first = await runtime.completeSimple(model, context, { transport: 'websocket', headers: { Authorization: 'wrong', 'chatgpt-account-id': 'wrong' } });
  assert.equal(first.stopReason, 'toolUse');
  const call = first.content.find(block => block.type === 'toolCall')!;
  assert.equal(call.id, 'call_a|fc_call_a');
  const second = await runtime.completeSimple(model, { ...context, messages: [...context.messages, first, { role: 'toolResult', toolCallId: call.id, toolName: call.name, content: [{ type: 'text', text: 'File contents' }], isError: false, timestamp: 2 }] });
  assert.equal(second.stopReason, 'toolUse');
  assert.deepEqual(second.content.find(block => block.type === 'toolCall')?.arguments, { kind: 'complete', summary: 'Done' });
  assert.ok(bodies[1]!.input.some((item: any) => item.type === 'function_call' && item.call_id === 'call_a' && item.id === 'fc_call_a'));
  assert.ok(bodies[1]!.input.some((item: any) => item.type === 'function_call_output' && item.call_id === 'call_a' && item.output === 'File contents'));
  for (const header of headers) { assert.equal(header.get('authorization'), `Bearer ${options.apiKey}`); assert.equal(header.get('chatgpt-account-id'), 'fixture-account'); assert.equal(header.get('openai-beta'), 'responses=experimental'); }
  assert.equal(bodies[0]!.store, false); assert.equal(bodies[0]!.stream, true); assert.equal(bodies[0]!.instructions, context.systemPrompt);
  assert.equal(websocket.mock.callCount(), 0); assert.deepEqual(await credentials.list(), []);
});

test('Codex rejects custom endpoints, invalid access tokens and expired credentials before sending', async () => {
  const options = config(); let calls = 0;
  const requestFetch: typeof fetch = async () => { calls++; return response('call', 'outcome', { kind: 'complete', summary: 'Done' }); };
  assert.throws(() => codexProvider({ ...options, baseUrl: 'https://example.invalid' }, requestFetch), /fixed official endpoint/);
  const key = randomUUID();
  assert.throws(() => codexProvider({ ...options, apiKey: key }, requestFetch), /invalid/);
  assert.throws(() => codexProvider({ ...options, expiresAt: Date.now() - 1 }, requestFetch), /expired/);
  const provider = codexProvider(options, requestFetch);
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerProvider('openai-codex', provider); const model = runtime.getModel('openai-codex', options.modelId)!;
  const wrong = await runtime.completeSimple({ ...model, baseUrl: `${CODEX_BASE_URL}?redirect=bad` }, context);
  assert.equal(wrong.stopReason, 'error'); assert.match(wrong.errorMessage!, /binding/); assert.equal(calls, 0);
});

test('Codex redirects, failed streams and cancellation never become successful completion', async () => {
  for (const failure of ['redirect', 'failed', 'truncated', 'aborted'] as const) {
    const options = config(), controller = new AbortController(); let calls = 0;
    const provider = codexProvider(options, async (_url, init) => {
      calls++; assert.equal(init?.redirect, 'error');
      if (failure === 'redirect') return new Response('', { status: 302, headers: { Location: 'https://example.invalid/collect' } });
      if (failure === 'failed') return new Response('data: {"type":"response.failed","response":{"status":"failed","error":{"code":"denied","message":"Denied fixture"}}}\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
      if (failure === 'truncated') return new Response('data: {"type":"response.created","response":{"id":"fixture"}}\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
      controller.abort(); throw new DOMException('Aborted', 'AbortError');
    });
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
    runtime.registerProvider('openai-codex', provider);
    const result = await runtime.completeSimple(runtime.getModel('openai-codex', options.modelId)!, context, { signal: controller.signal });
    assert.equal(result.stopReason, failure === 'aborted' ? 'aborted' : 'error'); assert.equal(calls, 1);
  }
});

test('Codex rechecks access expiry before every request without refreshing', async t => {
  const options = config(); let calls = 0;
  const provider = codexProvider(options, async () => { calls++; return response('call', 'outcome', { kind: 'complete', summary: 'Done' }); });
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerProvider('openai-codex', provider);
  t.mock.method(Date, 'now', () => options.expiresAt! + 1);
  const result = await runtime.completeSimple(runtime.getModel('openai-codex', options.modelId)!, context);
  assert.equal(result.stopReason, 'error'); assert.match(result.errorMessage!, /expired/); assert.equal(calls, 0);
});

test('Codex retries only bounded pre-header network failures and exposes no private causes', async () => {
  for (const code of ['UND_ERR_SOCKET', 'private-request-data']) {
    const options = config(); let calls = 0;
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
    runtime.registerProvider('openai-codex', codexProvider(options, async () => { calls++; throw new TypeError(options.apiKey, { cause: { code, message: options.apiKey } }); }));
    const result = await runtime.completeSimple(runtime.getModel('openai-codex', options.modelId)!, context);
    assert.equal(result.stopReason, 'error'); assert.equal(calls, code === 'UND_ERR_SOCKET' ? 3 : 1);
    assert.equal(result.errorMessage, `Codex connection failed${code === 'UND_ERR_SOCKET' ? ' (UND_ERR_SOCKET)' : ''}. Check the network and resume the task.`);
    assert.equal(result.errorMessage.includes(options.apiKey!), false);
  }
});

test('Codex retry stops on cancellation or credential expiry before another request', async t => {
  for (const failure of ['expired', 'aborted'] as const) {
    const options = config(), controller = new AbortController(); let calls = 0, time = Date.now();
    t.mock.method(Date, 'now', () => time);
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
    runtime.registerProvider('openai-codex', codexProvider(options, async () => { calls++; throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }); }, () => { if (failure === 'expired') time = options.expiresAt! + 1; else controller.abort(); }));
    const result = await runtime.completeSimple(runtime.getModel('openai-codex', options.modelId)!, context, { signal: controller.signal });
    assert.equal(calls, 1); assert.equal(result.stopReason, failure === 'expired' ? 'error' : 'aborted');
    if (failure === 'expired') assert.match(result.errorMessage!, /expired/);
    t.mock.restoreAll();
  }
});

test('Codex recovered pre-header connection submits the same request and returns one tool call', async () => {
  const options = config(), bodies: unknown[] = [], retries: number[] = [];
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerProvider('openai-codex', codexProvider(options, async (_url, init) => {
    bodies.push(init?.body);
    if (bodies.length === 1) throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
    return response('call_a', 'read_file', { path: 'fixture.txt' });
  }, attempt => retries.push(attempt)));
  const result = await runtime.completeSimple(runtime.getModel('openai-codex', options.modelId)!, context);
  assert.equal(result.stopReason, 'toolUse'); assert.equal(result.content.filter(block => block.type === 'toolCall').length, 1);
  assert.deepEqual(retries, [1]); assert.deepEqual(bodies[0], bodies[1]);
});

test('sensitive values are removed structurally and across every stream split point', () => {
  const key = randomUUID();
  const value = redact({ data: { [key]: [key, { text: `prefix ${key} suffix` }] }, empty: undefined }, key);
  assert.equal(JSON.stringify(value).includes(key), false); assert.ok('empty' in value);
  for (let split = 1; split < key.length; split++) {
    const stream = new RedactedStream(key);
    assert.equal(stream.push(`Before ${key.slice(0, split)}`) + stream.push(`${key.slice(split)} after`) + stream.finish(), 'Before [redacted] after');
  }
  for (const key of [undefined, '']) {
    const stream = new RedactedStream(key); assert.equal(stream.push('Ordinary text') + stream.finish(), 'Ordinary text');
  }
});
