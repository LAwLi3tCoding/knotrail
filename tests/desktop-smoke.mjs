// Real Electron -> preload IPC -> Coordinator -> pi SDK -> OS sandbox integration.
// The loopback provider is scripted; this does not measure a production model's quality.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { _electron, expect } from 'playwright/test';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(join(tmpdir(), 'knotrail-desktop-smoke-'));
const source = join(temporary, 'project');
const dataDir = join(temporary, 'app-data');
const objective = 'Replace the fixture text and verify it against the protected expected file';
const draft = {
  sequence: 1, summary: 'Update the fixture and run the fixed comparison check',
  observations: [{ kind: 'fact', text: 'The fixture currently contains the old value', source: 'target.txt' }],
  nodes: [{ id: 'edit-fixture', title: 'Update fixture', goal: objective, dependsOn: [], kind: 'edit', inputs: ['target.txt', 'expected.txt'], outputs: ['target.txt'], checkIds: ['compare'] }],
};
const responses = [
  { name: 'read_file', args: { path: 'target.txt' }, text: 'Inspecting the file before planning.' },
  { name: 'update_plan', args: { draft, submit: true }, text: 'The plan is ready for review.' },
  { name: 'read_file', args: { path: 'target.txt' }, text: 'Checking the current file before editing.' },
  { name: 'write_file', args: { path: 'target.txt', content: 'verified result\n', expectedContent: 'before\n' } },
  { name: 'outcome', args: { kind: 'complete', summary: 'Updated target.txt; independent comparison is ready.' } },
];
const requests = [];
let application;
let snapshot;
const errors = [];
let hostOutput = '';
const server = createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/v1/models') {
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ data: [{ id: 'desktop-fixture' }] })); return;
  }
  let body = ''; for await (const chunk of request) body += chunk;
  requests.push(JSON.parse(body));
  const index = requests.length - 1;
  const item = responses[index] ?? { name: 'outcome', args: { kind: 'blocked', reason: 'Unexpected fixture request' } };
  const call = { index: 0, id: `fixture-call-${index}`, type: 'function', function: { name: item.name, arguments: JSON.stringify(item.args) } };
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const [delta, finish_reason] of [[{ content: item.text ?? '', tool_calls: [call] }, null], [{}, 'tool_calls']]) {
    response.write(`data: ${JSON.stringify({ id: `fixture-${index}`, object: 'chat.completion.chunk', created: 1, model: 'desktop-fixture', choices: [{ index: 0, delta, finish_reason }], ...(finish_reason ? { usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } } : {}) })}\n\n`);
  }
  response.end('data: [DONE]\n\n');
});
try {
  await mkdir(source);
  await writeFile(join(source, 'target.txt'), 'before\n');
  await writeFile(join(source, 'expected.txt'), 'verified result\n');
  const git = args => execFileSync('/usr/bin/git', args, { cwd: source, stdio: 'pipe' });
  git(['init', '-q']); git(['add', 'target.txt', 'expected.txt']);
  git(['-c', 'user.name=Knotrail Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'Fixture baseline']);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const env = { ...process.env, KNOTRAIL_DATA_DIR: dataDir };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await _electron.launch({
    ...(process.env.KNOTRAIL_ELECTRON_EXECUTABLE ? { executablePath: process.env.KNOTRAIL_ELECTRON_EXECUTABLE, args: [] } : { args: [repository] }),
    cwd: repository, env, timeout: 30_000,
  });
  application.process().stderr?.on('data', chunk => { hostOutput = (hostOutput + chunk.toString()).slice(-16000); });
  const page = await application.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.waitForFunction(() => !!window.knotrail);
  const command = value => page.evaluate(input => window.knotrail.command(input), value);
  const bootstrap = await command({ type: 'bootstrap' });
  assert.equal(bootstrap.capabilities.sandbox, true, bootstrap.capabilities.reason);
  const webPreferences = await application.evaluate(({ BrowserWindow }) => {
    const preferences = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return { sandbox: preferences.sandbox, contextIsolation: preferences.contextIsolation, nodeIntegration: preferences.nodeIntegration };
  });
  assert.deepEqual(webPreferences, { sandbox: true, contextIsolation: true, nodeIntegration: false });
  const key = `synthetic-desktop-fixture-${randomUUID()}`;
  const saved = await command({ type: 'settings.save', patch: { model: { apiKey: key } } });
  assert.equal(saved.model.hasApiKey, true);
  assert.equal('apiKey' in saved.model, false);
  assert.equal(JSON.stringify(saved).includes(key), false, 'Saving a key must not echo it to the renderer');
  const withKey = await command({ type: 'bootstrap' });
  assert.equal(withKey.settings.model.hasApiKey, true);
  assert.equal('apiKey' in withKey.settings.model, false);
  assert.equal(JSON.stringify(withKey).includes(key), false, 'Bootstrap must not reveal the key');
  const encryptedPath = join(dataDir, 'model-key.enc');
  const encrypted = await readFile(encryptedPath);
  assert.ok(encrypted.length > 0);
  assert.equal(encrypted.includes(Buffer.from(key)), false, 'Stored credentials must be encrypted');
  assert.equal((await stat(encryptedPath)).mode & 0o777, 0o600);
  await command({ type: 'settings.save', patch: { model: { apiKey: '' } } });
  assert.equal((await command({ type: 'bootstrap' })).settings.model.hasApiKey, false);
  await assert.rejects(stat(encryptedPath), { code: 'ENOENT' });
  await command({ type: 'settings.save', patch: { locale: 'en', model: { baseUrl, modelId: 'desktop-fixture', thinking: 'off', contextWindow: 32000, maxTokens: 1024 } } });
  await command({ type: 'model.check' });
  const project = await command({ type: 'project.add', path: source });
  snapshot = await command({ type: 'task.create', requestId: 'desktop-fixture-create', projectId: project.id, objective, checks: [{ id: 'compare', label: 'Compare the result', command: ['/usr/bin/cmp', 'target.txt', 'expected.txt'], protectedPaths: ['expected.txt'] }], executionPolicy: 'reviewBeforeExecute', mode: 'once', maxTurns: 10, maxRunMs: 30000 });
  const taskId = snapshot.task.id;
  const until = async status => {
    await expect.poll(async () => {
      snapshot = await command({ type: 'task.snapshot', taskId });
      assert.ok(!['blocked', 'cancelled', 'expired'].includes(snapshot.task.status), snapshot.task.error || snapshot.task.status);
      return snapshot.task.status;
    }, { timeout: 45_000, intervals: [100, 200, 500] }).toBe(status);
  };
  await until('ready');
  assert.equal(await readFile(join(snapshot.task.workdir, 'target.txt'), 'utf8'), 'before\n');
  assert.equal(snapshot.actions.filter(action => action.name === 'write_file').length, 0);
  await page.locator('.task-row', { hasText: objective }).click();
  await page.getByRole('button', { name: 'Planning', exact: true }).click();
  await expect(page.locator('#planning-panel')).toBeVisible();
  const planning = await page.locator('#planning-panel').boundingBox();
  const center = await page.locator('.center').boundingBox();
  assert.ok(planning.x >= center.x + center.width - 1, 'Planning must open to the right of the task');
  await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('zh-CN');
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect(page.getByRole('button', { name: '规划', exact: true })).toBeVisible();
  await page.locator('.language-control select').selectOption('en');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.getByRole('button', { name: 'Start execution', exact: true }).click();
  await until('completed');
  assert.equal(await readFile(join(snapshot.task.workdir, 'target.txt'), 'utf8'), 'verified result\n');
  assert.equal(await readFile(join(source, 'target.txt'), 'utf8'), 'before\n');
  assert.equal(snapshot.runs.length, 2);
  assert.ok(snapshot.checks.length >= 2 && snapshot.checks.every(check => check.result === 'pass'));
  assert.equal(snapshot.nodes[0].status, 'verified');
  assert.ok(snapshot.artifacts.some(artifact => artifact.content.includes('verified result')));
  assert.deepEqual(snapshot.events.map(event => event.seq), Array.from({ length: snapshot.events.length }, (_, index) => index + 1));
  assert.equal(requests.length, responses.length);
  assert.equal((await command({ type: 'task.readFile', taskId, path: 'target.txt' })).content, 'verified result\n');
  await assert.rejects(command({ type: 'task.readFile', taskId, path: '../model-key.enc' }));
  const report = await command({ type: 'task.export', taskId });
  assert.match(await readFile(report.path, 'utf8'), /Status: completed/);
  assert.deepEqual(errors, [], 'Renderer should not have console or page errors');
  if (process.env.KNOTRAIL_SMOKE_SCREENSHOT) await page.screenshot({ path: process.env.KNOTRAIL_SMOKE_SCREENSHOT });
  console.log(JSON.stringify({ result: 'passed', packaged: !!process.env.KNOTRAIL_ELECTRON_EXECUTABLE, model: 'scripted loopback provider through real pi SDK', planningBeforeExecution: true, verifiedChecks: snapshot.checks.length, rightPlanningPanel: true, languages: ['en', 'zh-CN'], isolatedWorktree: true, encryptedCredentialStorage: true, credentialReadbackRedacted: true, rendererErrors: errors.length }));
} catch (error) {
  console.error(JSON.stringify({ lastStatus: snapshot?.task.status, lastError: snapshot?.task.error, lastEvents: snapshot?.events.slice(-5).map(event => ({ kind: event.kind, text: event.text })), providerRequests: requests.length, hostOutput, rendererErrors: errors }));
  throw error;
} finally {
  await application?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(() => resolve()));
  await rm(temporary, { recursive: true, force: true });
}
