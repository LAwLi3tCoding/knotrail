import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PiRunner } from '../src/runtime/pi-runner.js';
import type { RunnerRequest, RunControl, ToolCall } from '../src/runtime/contracts.js';
import type { PlanDraft } from '../src/shared/contracts.js';

const draft: PlanDraft = { sequence: 1, summary: 'Inspect fixture', observations: [{ kind: 'fact', text: 'Fixture exists' }], nodes: [{ id: 'inspect', title: 'Inspect', goal: 'Read fixture', dependsOn: [], kind: 'research', inputs: [{ kind: 'file', path: 'fixture.txt', expect: 'present' }], outputs: [{ id: 'summary', kind: 'text' }], checkIds: [] }] };
async function fixture(t: { after(fn: () => Promise<void>): void }, responses: { name?: string; args?: unknown; text?: string; error?: boolean }[][], reported?: boolean[]) {
  const root = await mkdtemp(join(tmpdir(), 'knotrail-runtime-')); await mkdir(join(root, 'session'));
  const requests: Record<string, any>[] = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    requests.push(JSON.parse(body));
    const index = requests.length - 1;
    const chunks = responses[index] || [{ text: 'unexpected turn' }];
    if (chunks[0]?.error) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: `Denied ${req.headers.authorization}`, type: 'invalid_api_key' } })); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const calls = chunks.filter(item => item.name);
    for (const part of chunks.filter(item => item.text !== undefined)) res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: { content: part.text }, finish_reason: null }] })}\n\n`);
    const delta = { ...(calls.length ? { tool_calls: calls.map((item, i) => ({ index: i, id: `call-${index}-${i}`, type: 'function', function: { name: item.name, arguments: JSON.stringify(item.args) } })) } : {}) };
    res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: calls.length ? 'tool_calls' : 'stop' }], ...(reported?.[index]===false?{}:{usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 }}) })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  const address = server.address() as { port: number };
  const key = randomUUID();
  const request: RunnerRequest = { runId: 'run-fixture', purpose: 'planning', workdir: root, sessionDir: join(root, 'session'), model: { baseUrl: `http://127.0.0.1:${address.port}/v1`, modelId: 'fixture', apiKey: key, thinking: 'off', contextWindow: 32000, maxTokens: 1024 }, objective: 'Inspect fixture', checks: [], context: '', maxTurns: 4, timeoutMs: 20000, responseLanguage: 'en' };
  return { request, requests, root };
}

test('real pi SDK streams planning with only read-only tools and closes admission after submit', async t => {
  const f = await fixture(t, [[{ name: 'read_file', args: { path: 'fixture.txt' }, text: 'I will inspect the fixture.' }], [{ name: 'update_plan', args: { draft, submit: true } }, { name: 'read_file', args: { path: 'late.txt' } }]]);
  await mkdir(join(f.root, '.pi', 'extensions'), { recursive: true });
  await writeFile(join(f.root, '.pi', 'extensions', 'poison.ts'), "throw new Error('Extension discovery must stay disabled')");
  const calls: ToolCall[] = [], controls: RunControl[] = [], events: string[] = [];
  const result = await new PiRunner().run(f.request, { onEvent: (_kind, text) => events.push(text), onTool: async call => { calls.push(call); return { text: 'fixture' }; }, onControl: async control => { controls.push(control); return { text: 'accepted' }; } }, new AbortController().signal);
  assert.equal(result.aborted, false); assert.equal(result.turns, 2); assert.ok(result.sessionPath); assert.ok(result.usage && result.usage.input > 0);
  assert.equal((await readFile(result.sessionPath!, 'utf8')).includes(f.request.model.apiKey!), false);
  assert.deepEqual(calls.map(call => call.args.path), ['fixture.txt']); assert.deepEqual(controls, [{ kind: 'update_plan', draft, submit: true }]); assert.ok(events.join('').includes('inspect'));
  const names = f.requests[0].tools.map((tool: { function: { name: string } }) => tool.function.name).sort();
  assert.deepEqual(names, ['list_files', 'outcome', 'read_file', 'search_files', 'update_plan']);
  for (const tool of f.requests[0].tools) assert.equal(tool.function.parameters.type, 'object');
});
test('real pi rejects string declarations before forwarding a typed plan to the coordinator', async t => {
  const typed: PlanDraft = { ...draft, nodes: [...draft.nodes, { id: 'edit', title: 'Use report', goal: 'Create result from the report', kind: 'edit', dependsOn: ['inspect'], inputs: [{ kind: 'artifact', nodeId: 'inspect', outputId: 'summary' }, { kind: 'file', path: 'new.txt', expect: 'absent' }], outputs: [{ id: 'result', kind: 'file', path: 'new.txt', expect: 'present' }], checkIds: [] }] };
  const invalid = { ...draft, nodes: [{ ...draft.nodes[0], inputs: ['fixture.txt'], outputs: ['report'] }] };
  const f = await fixture(t, [[{ name: 'update_plan', args: { draft: invalid, submit: true } }], [{ name: 'update_plan', args: { draft: typed, submit: true } }]]);
  const controls: RunControl[] = [];
  const result = await new PiRunner().run(f.request, { onEvent() {}, onTool: async () => ({ text: 'unexpected', isError: true }), onControl: async control => { controls.push(control); return { text: 'accepted' }; } }, new AbortController().signal);
  assert.equal(result.turns, 2); assert.deepEqual(controls, [{ kind: 'update_plan', draft: typed, submit: true }]);
  assert.ok(f.requests[1]!.messages.some((message: any) => message.role === 'tool' && /validation|invalid|expected/i.test(message.content)));
});
test('real pi research receives bound artifact content and read_input slices without admitting writes or late tools', async t => {
  const content = 'Bound predecessor report.\nThe omitted section establishes the exact compatibility requirement.';
  const digest = createHash('sha256').update(content).digest('hex'), end = 25;
  const input = { ref: { kind: 'artifact', nodeId: 'upstream', outputId: 'summary' }, artifactId: 'artifact-current-attempt', producerRunId: 'run-upstream-2', digest, content: content.slice(0, end), characters: content.length, end, redacted: false };
  const f = await fixture(t, [[
    { name: 'write_file', args: { path: 'forbidden.txt', content: 'forbidden', expectedContent: null } },
    { name: 'edit_file', args: { path: 'forbidden.txt', oldText: 'old', newText: 'new', expectedContent: 'old' } },
    { name: 'run_command', args: { argv: ['/usr/bin/true'] } },
    { name: 'read_input', args: { index: 0, offset: end, length: 48000 } },
  ], [{ name: 'outcome', args: { kind: 'complete', summary: 'Used the bound report' } }, { name: 'read_input', args: { index: 0 } }]]);
  const calls: ToolCall[] = [], controls: RunControl[] = [];
  const slice = { index: 0, offset: end, end: content.length, characters: content.length, digest, content: content.slice(end), redacted: false };
  // This fixture proves Worker delivery through the real SDK, not Core source resolution.
  const result = await new PiRunner().run({ ...f.request, purpose: 'node', node: { ...draft.nodes[0]!, dependsOn: ['upstream'], inputs: [{ kind: 'artifact', nodeId: 'upstream', outputId: 'summary' }] }, context: JSON.stringify({ inputs: [input] }) }, {
    onEvent() {}, onTool: async call => { calls.push(call); return { text: JSON.stringify(slice) }; }, onControl: async control => { controls.push(control); return { text: 'accepted' }; },
  }, new AbortController().signal);
  assert.equal(result.summary, 'Used the bound report'); assert.equal(result.turns, 2);
  assert.deepEqual(calls.map(({ name, args }) => ({ name, args })), [{ name: 'read_input', args: { index: 0, offset: end, length: 48000 } }]);
  assert.deepEqual(controls, [{ kind: 'complete', summary: 'Used the bound report' }]);
  const message = f.requests[0]!.messages.find((message: any) => message.role === 'user');
  const prompt = JSON.parse(typeof message.content === 'string' ? message.content : message.content.map((part: any) => part.text ?? '').join(''));
  assert.deepEqual(JSON.parse(prompt.context).inputs, [input]);
  assert.equal(JSON.stringify(f.requests[0]!.messages).includes(content.slice(end)), false);
  assert.deepEqual(f.requests[0]!.tools.map((tool: any) => tool.function.name).sort(), ['list_files', 'outcome', 'read_file', 'read_input', 'search_files']);
  assert.ok(f.requests[1]!.messages.some((message: any) => message.role === 'tool' && message.content === JSON.stringify(slice)));
});
test('real pi read_input validates slice bounds and cannot forward an arbitrary artifact selector', async t => {
  const invalid = [{ index: -1 }, { index: 0.5 }, { index: 0, offset: -1 }, { index: 0, offset: 0.5 }, { index: 0, length: 0 }, { index: 0, length: 48001 }, { index: 0, length: 1.5 }, { artifactId: 'unbound-old-artifact' }, { index: 0, artifactId: 'unbound-old-artifact' }];
  const f = await fixture(t, [invalid.map(args => ({ name: 'read_input', args })), [{ name: 'read_input', args: { index: 0, offset: 0, length: 1 } }], [{ name: 'outcome', args: { kind: 'complete', summary: 'Bound read completed' } }]]);
  const calls: ToolCall[] = [];
  const result = await new PiRunner().run({ ...f.request, purpose: 'node', node: draft.nodes[0] }, { onEvent() {}, onTool: async call => { calls.push(call); return { text: 'x' }; }, onControl: async () => ({ text: 'accepted' }) }, new AbortController().signal);
  assert.equal(result.turns, 3);
  assert.deepEqual(calls.map(({ name, args }) => ({ name, args })), [{ name: 'read_input', args: { index: 0, offset: 0, length: 1 } }]);
  assert.equal(f.requests[1]!.messages.filter((message: any) => message.role === 'tool').length, invalid.length);
});
test('node pi Run routes writes and terminal outcome through parent callbacks', async t => {
  const f = await fixture(t, [[{ name: 'write_file', args: { path: 'new.txt', content: 'ok', expectedContent: null } }], [{ name: 'outcome', args: { kind: 'complete', summary: 'Created file' } }]]);
  const names: string[] = [];
  const result = await new PiRunner().run({ ...f.request, purpose: 'node' }, { onEvent() {}, onTool: async call => { names.push(call.name); return { text: 'saved' }; }, onControl: async () => ({ text: 'accepted' }) }, new AbortController().signal);
  assert.deepEqual(names, ['write_file']); assert.equal(result.summary, 'Created file');
});
test('pi Run fails if the model stops without a terminal outcome', async t => {
  const f = await fixture(t, [[{ text: 'Done, trust me.' }]]);
  const turns: unknown[] = [];
  await assert.rejects(new PiRunner().run(f.request, { onEvent: (kind, _text, data) => { if (kind === 'turn.started') turns.push(data); }, onTool: async () => ({ text: 'ok' }), onControl: async () => ({ text: 'ok' }) }, new AbortController().signal), /without submitting/);
  assert.deepEqual(turns, [{ turn: 1 }]);
});
test('pi Run turn budget stops repeated tools', async t => {
  const f = await fixture(t, [[{ name: 'read_file', args: { path: 'one.txt' } }], [{ name: 'read_file', args: { path: 'two.txt' } }]]);
  let count = 0;
  await assert.rejects(new PiRunner().run({ ...f.request, maxTurns: 1 }, { onEvent() {}, onTool: async () => { count++; return { text: 'ok' }; }, onControl: async () => ({ text: 'ok' }) }, new AbortController().signal), /turn limit/);
  assert.equal(count, 1);
});
test('aborting a pi Run waits for an admitted parent tool to finish cleanup', async t => {
  const f = await fixture(t, [[{ name: 'read_file', args: { path: 'fixture.txt' } }]]);
  const controller = new AbortController(); let cleaned = false;
  const result = await new PiRunner().run(f.request, {
    onEvent() {}, onTool: async () => { controller.abort(); await new Promise(resolve => setTimeout(resolve, 80)); cleaned = true; return { text: 'cancelled', isError: true }; }, onControl: async () => ({ text: 'unexpected', isError: true }),
  }, controller.signal);
  assert.equal(result.aborted, true); assert.equal(cleaned, true);
});

test('real pi usage stays unknown or partial when provider responses omit token counts',async t=>{
 for(const reported of [[false,false],[true,false]]){
  const f=await fixture(t,[[{name:'read_file',args:{path:'fixture.txt'}}],[{name:'update_plan',args:{draft,submit:true}}]],reported);
  const result=await new PiRunner().run(f.request,{onEvent(){},onTool:async()=>({text:'fixture'}),onControl:async()=>({text:'accepted'})},new AbortController().signal);
  assert.equal(result.turns,2);if(reported[0])assert.deepEqual(result.usage,{input:12,output:8,partial:true});else assert.equal(result.usage,undefined);
 }
});


test('real pi wait outcome requires a source and condition and closes later tool admission',async t=>{
 const f=await fixture(t,[[{name:'outcome',args:{kind:'wait',reason:'Waiting for input',minutes:1}}],[{name:'outcome',args:{kind:'wait',reason:'Waiting for input',minutes:1,source:{kind:'project_file',path:'status.txt'},condition:{kind:'contains',text:'ready'}}},{name:'write_file',args:{path:'late.txt',content:'must not execute',expectedContent:null}}]]);
 const controls:RunControl[]=[],tools:ToolCall[]=[];
 const result=await new PiRunner().run({...f.request,purpose:'node'}, {onEvent(){},onTool:async c=>{tools.push(c);return {text:'unexpected'};},onControl:async c=>{controls.push(c);return {text:'accepted'};}},new AbortController().signal);
 assert.equal(result.turns,2);assert.equal(controls.length,1);assert.deepEqual(controls[0],{kind:'wait',reason:'Waiting for input',minutes:1,source:{kind:'project_file',path:'status.txt'},condition:{kind:'contains',text:'ready'}});assert.equal(tools.length,0);
 assert.ok(JSON.stringify(f.requests[1].messages).includes('source'));
});

test('runtime redacts split token deltas, tool/control values, replies, results and persisted sessions', async t => {
  const responses: { name?: string; args?: unknown; text?: string }[][] = [[], []];
  const f = await fixture(t, responses), key = f.request.model.apiKey!, split = Math.floor(key.length / 2);
  responses[0] = [{ text: `Before ${key.slice(0, split)}` }, { text: `${key.slice(split)} after.` }, { name: 'write_file', args: { path: 'safe.txt', content: `nested ${key}`, expectedContent: null } }];
  responses[1] = [{ name: 'outcome', args: { kind: 'complete', summary: `Done ${key}` } }];
  const events: unknown[] = [], calls: ToolCall[] = [], controls: RunControl[] = [], text: string[] = [];
  const result = await new PiRunner().run({ ...f.request, purpose: 'node', objective: `Protect ${key}` }, {
    onEvent(kind, value, data) { events.push({ kind, value, data }); if (kind === 'assistant.delta') text.push(value); },
    onTool: async call => { calls.push(call); return { text: `reply ${key}` }; },
    onControl: async control => { controls.push(control); return { text: 'accepted' }; },
  }, new AbortController().signal);
  assert.equal(text.join(''), 'Before [redacted] after.');
  assert.equal(calls[0]!.args.content, 'nested [redacted]');
  assert.deepEqual(controls, [{ kind: 'complete', summary: 'Done [redacted]' }]);
  assert.equal(result.summary, 'Done [redacted]');
  assert.equal(JSON.stringify({ events, calls, controls, result, requests: f.requests }).includes(key), false);
  const saved = await readFile(result.sessionPath!, 'utf8');
  assert.equal(saved.includes(key), false); assert.ok(saved.includes('reply [redacted]'));
});

test('runtime redacts provider errors before returning them or saving the session', async t => {
  const f = await fixture(t, [[{ error: true }]]), key = f.request.model.apiKey!;
  await assert.rejects(new PiRunner().run(f.request, { onEvent() {}, onTool: async () => ({ text: 'unexpected' }), onControl: async () => ({ text: 'unexpected' }) }, new AbortController().signal), (error: Error) => {
    assert.equal(error.message.includes(key), false); assert.match(error.message, /Denied Bearer \[redacted\]/); return true;
  });
  const files = (await readdir(f.request.sessionDir, { recursive: true })).filter(path => path.endsWith('.jsonl'));
  for (const path of files) assert.equal((await readFile(join(f.request.sessionDir, path), 'utf8')).includes(key), false);
});
