import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PiRunner } from '../src/runtime/pi-runner.js';
import type { RunnerRequest, RunControl, ToolCall } from '../src/runtime/contracts.js';

const draft = { sequence: 1, summary: 'Inspect fixture', observations: [{ kind: 'fact', text: 'Fixture exists' }], nodes: [{ id: 'inspect', title: 'Inspect', goal: 'Read fixture', dependsOn: [], kind: 'research', inputs: ['fixture.txt'], outputs: ['report'], checkIds: [] }] };
async function fixture(t: { after(fn: () => Promise<void>): void }, responses: { name?: string; args?: unknown; text?: string }[][], reported?: boolean[]) {
  const root = await mkdtemp(join(tmpdir(), 'knotrail-runtime-')); await mkdir(join(root, 'session'));
  const requests: Record<string, any>[] = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    requests.push(JSON.parse(body));
    const index = requests.length - 1;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunks = responses[index] || [{ text: 'unexpected turn' }];
    const calls = chunks.filter(item => item.name);
    const delta = { content: chunks.map(item => item.text || '').join(''), ...(calls.length ? { tool_calls: calls.map((item, i) => ({ index: i, id: `call-${index}-${i}`, type: 'function', function: { name: item.name, arguments: JSON.stringify(item.args) } })) } : {}) };
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
  assert.deepEqual(calls.map(call => call.args.path), ['fixture.txt']); assert.equal(controls.length, 1); assert.ok(events.join('').includes('inspect'));
  const names = f.requests[0].tools.map((tool: { function: { name: string } }) => tool.function.name).sort();
  assert.deepEqual(names, ['list_files', 'outcome', 'read_file', 'search_files', 'update_plan']);
  for (const tool of f.requests[0].tools) assert.equal(tool.function.parameters.type, 'object');
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
