import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import type { AppCommand, Bootstrap, ImpactPreview, TaskSnapshot } from '../src/shared/contracts';

// This suite verifies the real renderer against a deterministic IPC bridge.
// Runtime, sandbox, model calls, and persistence are exercised by separate integration tests.
const appDirectory = dirname(resolve(process.env.KNOTRAIL_UI_PATH ?? 'dist/renderer/index.html'));
const appUrl = 'https://knotrail.test/index.html';
const now = '2026-09-06T09:00:00.000Z';
const fixture: TaskSnapshot = {
  task: { id: 'task-1', projectId: 'project-1', title: 'Upgrade the adapter', objective: 'Upgrade the adapter and preserve the public API.', mode: 'once', status: 'executing', revision: 1, activePlanId: 'plan-1', workdir: 'worktree', baseline: 'abc123def456', createdAt: now, updatedAt: now, executionPolicy: 'autoWithinGrant', checks: [{ id: 'test', label: 'API tests', command: ['npm', 'test'], protectedPaths: ['test/api.test.ts'] }], maxTurns: 40, maxRunMs: 900000, turnCount: 3, revisionHistory: [{ revision: 1, objective: 'Upgrade the adapter and preserve the public API.', checks: [], createdAt: now }] },
  plan: { id: 'plan-1', taskRevision: 1, revision: 1, sequence: 1, summary: 'Inspect callers, adapt the implementation, and verify compatibility.', observations: [{ kind: 'fact', text: 'Three callers depend on the adapter.', source: 'src/adapter.ts' }], nodes: [
    { id: 'research', title: 'Inspect callers', goal: 'Understand current usage.', kind: 'research', dependsOn: [], inputs: ['src/adapter.ts'], outputs: ['Caller inventory'], checkIds: [] },
    { id: 'edit', title: 'Update the adapter', goal: 'Preserve exported signatures.', kind: 'edit', dependsOn: ['research'], inputs: ['Caller inventory'], outputs: ['src/adapter.ts'], checkIds: ['test'] },
    { id: 'verify', title: 'Verify public APIs', goal: 'Run the fixed API check.', kind: 'verify', dependsOn: ['edit'], inputs: ['src/adapter.ts'], outputs: ['Check result'], checkIds: ['test'] },
  ], createdAt: now, digest: 'plan-digest' }, plans: [],
  nodes: [{ nodeId: 'research', status: 'verified', attempt: 1, runId: 'run-1' }, { nodeId: 'edit', status: 'running', attempt: 1, runId: 'run-2' }, { nodeId: 'verify', status: 'queued', attempt: 0 }],
  runs: [{ id: 'run-1', taskId: 'task-1', taskRevision: 1, planId: 'plan-1', nodeId: 'research', purpose: 'node', attempt: 1, status: 'succeeded', startedAt: now, endedAt: now, inputDigest: 'input-1', summary: 'Three callers inspected.' }, { id: 'run-2', taskId: 'task-1', taskRevision: 1, planId: 'plan-1', nodeId: 'edit', purpose: 'node', attempt: 1, status: 'running', startedAt: now, inputDigest: 'input-2', usage: { input: 1234, output: 456 } }],
  events: [{ id: 'event-1', seq: 1, taskId: 'task-1', taskRevision: 1, kind: 'assistant.delta', text: 'The caller inventory is ready. ', createdAt: now, runId: 'run-1', nodeId: 'research' }, { id: 'event-2', seq: 2, taskId: 'task-1', taskRevision: 1, kind: 'assistant.delta', text: 'I am updating the adapter.', createdAt: now, runId: 'run-1', nodeId: 'research' }],
  artifacts: [{ id: 'artifact-1', taskId: 'task-1', runId: 'run-2', nodeId: 'edit', kind: 'diff', name: 'src/adapter.ts', digest: 'artifact-digest', createdAt: now, content: '- oldAdapter(input)\n+ nextAdapter(input)\n<script>window.injected = true</script>', truncated: false }],
  actions: [{ id: 'action-1', taskId: 'task-1', runId: 'run-2', nodeId: 'edit', toolCallId: 'call-1', name: 'read', argsDigest: 'args-1', status: 'succeeded', output: 'export function adapter(input) {}', startedAt: now }], checks: [], decisions: [], lastSequence: 2,
};
fixture.plans = [fixture.plan!];
fixture.task.revisionHistory[0]!.checks = structuredClone(fixture.task.checks);

async function start(page: Page) {
  await page.route('https://knotrail.test/**', async route => {
    const name = new URL(route.request().url()).pathname.slice(1);
    if (!['index.html', 'app.js', 'app.css'].includes(name)) return route.abort();
    await route.fulfill({ body: await readFile(resolve(appDirectory, name)), contentType: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html' });
  });
  await page.addInitScript(({ snapshot, createdAt }) => {
    const data = structuredClone(snapshot);
    const boot: Bootstrap = { projects: [{ id: 'project-1', name: 'adapter-project', path: 'project', createdAt }], tasks: [data.task], settings: { locale: 'en', planningOpen: false, model: { baseUrl: 'https://example.invalid/v1', modelId: 'test-model', thinking: 'high', contextWindow: 128000, maxTokens: 4096, hasApiKey: true }, responseLanguage: 'task', allowNetwork: false }, capabilities: { sandbox: true, platform: 'test' }, version: '0.1.0' };
    const listeners: ((event: { taskId?: string; kind: string }) => void)[] = [];
    const commands: AppCommand[] = [];
    const previews: ImpactPreview[] = [];
    const preferences: Record<string, unknown> = {};
    const notify = () => listeners.forEach(listener => listener({ taskId: data.task.id, kind: 'changed' }));
    Object.assign(window, { uiTest: {
      commands,
      previews,
      change: (patch: Partial<TaskSnapshot>) => { Object.assign(data, patch); data.lastSequence++; boot.tasks[0] = data.task; notify(); },
      snapshot: data,
    } });
    window.knotrail = {
      chooseProject: async () => 'chosen-project', exportReport: async () => 'task-report.md',
      subscribe: listener => { listeners.push(listener); return () => { const index = listeners.indexOf(listener); if (index >= 0) listeners.splice(index, 1); }; },
      command: async <T,>(command: AppCommand): Promise<T> => {
        commands.push(command);
        const result = (() => {
          switch (command.type) {
            case 'bootstrap': return boot;
            case 'task.snapshot': return data;
            case 'preferences.get': return preferences[command.taskId] ?? {};
            case 'preferences.save': preferences[command.taskId] = command.value; return { ok: true };
            case 'settings.save': {
              const { model, ...general } = command.patch;
              Object.assign(boot.settings, general);
              if (model) { const { apiKey, ...rest } = model; Object.assign(boot.settings.model, rest); if (apiKey) boot.settings.model.hasApiKey = true; }
              notify(); return boot.settings;
            }
            case 'task.pause': data.task.status = 'paused'; data.lastSequence++; notify(); return data;
            case 'task.resume': data.task.status = 'executing'; data.lastSequence++; notify(); return data;
            case 'task.cancel': data.task.status = 'cancelled'; data.lastSequence++; notify(); return data;
            case 'task.previewRevision': {
              if (command.taskId !== data.task.id || command.expectedRevision !== data.task.revision) throw new Error('Task revision changed');
              if (data.task.mode === 'maintain' && command.checks?.length === 0) throw new Error('Maintenance requires at least one fixed acceptance check');
              const preview: ImpactPreview = { id: `impact-fixture-${previews.length}`, taskId: data.task.id, expectedRevision: data.task.revision, expectedPlanId: data.plan?.id, workspaceDigest: 'workspace', ...(command.objective !== undefined ? { objective: command.objective } : {}), ...(command.checks !== undefined ? { checks: command.checks } : {}), affected: data.plan?.nodes.map(node => node.id) ?? [], retained: [], reason: command.checks !== undefined ? 'Acceptance checks changed: previous results remain historical; the revised task must be planned and verified again.' : 'Legacy configuration support changes adapter and checks.' };
              previews.push(structuredClone(preview)); data.task.status = 'paused'; data.lastSequence++; notify(); return preview;
            }
            case 'task.previewRetry': return { id: 'retry-fixture', taskId: data.task.id, expectedRevision: data.task.revision, expectedPlanId: data.plan?.id, workspaceDigest: 'workspace', nodeId: command.nodeId, affected: [command.nodeId], retained: [], reason: 'The selected step must run again.' };
            case 'task.applyImpact': {
              if (!previews.some(preview => JSON.stringify(preview) === JSON.stringify(command.preview))) throw new Error('Impact preview is stale or was not issued by this host');
              data.task.revision++;
              if (command.preview.objective !== undefined) data.task.objective = command.preview.objective;
              if (command.preview.checks !== undefined) data.task.checks = structuredClone(command.preview.checks);
              data.task.revisionHistory.push({ revision: data.task.revision, objective: data.task.objective, checks: structuredClone(data.task.checks), createdAt });
              if (data.plan) { data.plan = { ...data.plan, id: `plan-${data.task.revision}`, revision: data.plan.revision + 1, taskRevision: data.task.revision }; data.plans.push(data.plan); data.task.activePlanId = data.plan.id; }
              data.task.status = 'ready'; data.nodes = data.nodes.map(node => ({ nodeId: node.nodeId, status: 'queued', attempt: 0 })); data.lastSequence++; notify(); return data;
            }
            case 'task.inspectEffects': {
              data.decisions.push({ id: 'terminal-recovery', kind: 'recovery', taskId: data.task.id, taskRevision: data.task.revision, planId: data.plan?.id, question: 'Inspect unknown terminal effects.', options: ['preserve-and-stop'], recovery: { actionIds: ['action-1'], actionsDigest: 'actions-digest', workspaceDigest: 'workspace-digest', artifactId: 'artifact-1', terminalStatus: 'cancelled' }, createdAt });
              data.lastSequence++; notify(); return data;
            }
            case 'decision.answer': { const decision = data.decisions.find(item => item.id === command.decisionId); if (decision) decision.answer = command.answer; data.task.status = decision?.recovery?.terminalStatus ?? 'executing'; data.lastSequence++; notify(); return data; }
            case 'task.files': return { files: ['src/adapter.ts', 'README.md'] };
            case 'task.readFile': return { content: 'export const adapter = "safe";', truncated: false };
            case 'model.check': return { ok: true, message: boot.settings.model.authSource === 'codex-login' ? 'Local Codex login is available. Run a task to verify model access and tool calling.' : 'Connection passed' };
            case 'task.create': Object.assign(data.task, { objective: command.objective, checks: command.checks, mode: command.mode, executionPolicy: command.executionPolicy, status: 'planning', intervalMinutes: command.intervalMinutes, expiresAt: command.expiresAt }); data.lastSequence++; notify(); return data;
            case 'project.add': return boot.projects[0];
            default: return { ok: true };
          }
        })();
        return structuredClone(result) as T;
      },
    };
  }, { snapshot: fixture, createdAt: now });
  await page.goto(appUrl);
  await page.getByRole('button', { name: /Upgrade the adapter/ }).click();
  await expect(page.getByRole('heading', { name: 'Upgrade the adapter' })).toBeVisible();
}

async function delayRevisionResponses(page: Page, commandType: 'task.previewRevision' | 'task.applyImpact' = 'task.previewRevision') {
  await page.evaluate(commandType => {
    const pending: { resolve: () => void; reject: (error: Error) => void }[] = [];
    const state = (window as unknown as { uiTest: object }).uiTest;
    Object.assign(state, { pendingRevisions: pending, settleRevision: (index: number, error?: string) => error ? pending[index]!.reject(new Error(error)) : pending[index]!.resolve() });
    const original = window.knotrail.command;
    window.knotrail.command = async <T,>(command: AppCommand): Promise<T> => {
      // Host state and notifications precede the delayed command response.
      const result = await original<T>(command);
      if (command.type === commandType) await new Promise<void>((resolve, reject) => pending.push({ resolve, reject }));
      return result;
    };
  }, commandType);
}

test('planning stays on the right and observes updates while hidden; locale and view changes preserve drafts', async ({ page }) => {
  await start(page);
  await expect(page.getByRole('complementary', { name: 'Planning' })).not.toBeVisible();
  await page.getByRole('textbox', { name: 'Describe a requirement change…' }).fill('Keep legacy config unchanged');
  await page.getByRole('button', { name: 'Planning', exact: true }).click();
  await page.getByRole('button', { name: 'Steps', exact: true }).click();
  await page.getByRole('button', { name: /Update the adapter.*Edit/ }).click();
  await page.getByRole('button', { name: 'Artifacts', exact: true }).click();
  await page.getByRole('button', { name: 'Close planning' }).click();
  await page.evaluate(() => {
    const bridge = (window as unknown as { uiTest: { snapshot: TaskSnapshot; change: (patch: Partial<TaskSnapshot>) => void } }).uiTest;
    bridge.change({ nodes: bridge.snapshot.nodes.map(node => node.nodeId === 'edit' ? { ...node, status: 'verified' } : node) });
  });
  await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('zh-CN');
  await expect(page.getByRole('textbox', { name: '补充或修改任务要求…' })).toHaveValue('Keep legacy config unchanged');
  await page.getByRole('button', { name: '规划', exact: true }).click();
  await expect(page.getByRole('button', { name: '产物', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: /Update the adapter.*已验证/ })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('complementary', { name: '规划' }).locator('.artifact summary').click();
  await expect(page.getByRole('complementary', { name: '规划' }).locator('pre')).toContainText('<script>window.injected = true</script>');
  expect(await page.evaluate(() => (window as unknown as { injected?: boolean }).injected)).toBeUndefined();
  const positions = await page.evaluate(() => ({ center: document.querySelector('.center')!.getBoundingClientRect().right, panel: document.querySelector('.planning-panel')!.getBoundingClientRect().left }));
  expect(positions.panel).toBeGreaterThanOrEqual(positions.center - 1);
  await page.screenshot({ path: test.info().outputPath('workbench-zh-right-plan.png') });
});

test('decisions remain in chat, requirement changes preview before applying, and retries use impact previews', async ({ page }) => {
  await start(page);
  await page.evaluate(() => {
    const state=(window as unknown as { uiTest: { snapshot:TaskSnapshot; change: (patch: Partial<TaskSnapshot>) => void } }).uiTest;state.change({task:{...state.snapshot.task,status:'waiting_user'}, decisions: [{ id: 'decision-1', taskId: 'task-1', taskRevision: 1, question: 'Keep the legacy input format?', options: ['Keep it', 'Migrate it'], createdAt: '2026-09-06T09:00:00Z' }] });
  });
  await page.getByRole('button', { name: 'Keep it', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Keep it', exact: true })).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Describe a requirement change…' }).fill('Also support the old configuration file.');
  await page.getByRole('button', { name: 'Preview requirement change' }).click();
  await expect(page.getByRole('dialog', { name: 'Review impact' })).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText('Inspect callers');
  expect(await page.evaluate(() => (window as unknown as { uiTest: { commands: AppCommand[] } }).uiTest.commands.some(command => command.type === 'task.applyImpact'))).toBe(false);
  await page.getByRole('button', { name: 'Apply and continue' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Describe a requirement change…' })).toHaveValue('');
  await page.getByRole('button', { name: 'Planning', exact: true }).click();
  await page.getByRole('button', { name: 'Steps', exact: true }).click();
  await page.getByRole('button', { name: 'Retry step' }).click();
  await expect(page.getByRole('dialog')).toContainText('The selected step must run again.');
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
  const commands = await page.evaluate(() => (window as unknown as { uiTest: { commands: AppCommand[] } }).uiTest.commands);
  expect(commands.find(command => command.type === 'decision.answer')).toMatchObject({ answer: 'Keep it' });
  expect(commands.filter(command => command.type === 'task.applyImpact')).toHaveLength(1);
});

test('new tasks send typed checks, settings save and test a real bridge command, and files use scoped readers', async ({ page }) => {
  await start(page);
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await page.getByRole('button', { name: 'src/adapter.ts', exact: true }).click();
  await expect(page.locator('.file-content pre')).toHaveText('export const adapter = "safe";');
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  await page.getByLabel('Objective', { exact: true }).fill('Implement the missing validation.');
  await page.getByRole('button', { name: 'Add check' }).click();
  await page.getByLabel('Command argv (JSON array)').fill('["npm", "test", "--", "api"]');
  await page.getByLabel('Protected paths (one per line)').fill('test/api.test.ts');
  await page.getByLabel('Execution policy').selectOption('reviewBeforeExecute');
  await page.getByRole('button', { name: 'Create and plan' }).click();
  await expect(page.getByRole('heading', { name: 'Upgrade the adapter' })).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Models', exact: true }).click();
  await page.getByLabel('API key', { exact: true }).fill('test-only-secret');
  await page.getByLabel('Model ID', { exact: true }).fill('changed-model');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByLabel('API key', { exact: true })).toHaveValue('');
  await page.getByRole('button', { name: 'Test saved connection' }).click();
  await expect(page.getByRole('status')).toContainText('Connection passed');
  const commands = await page.evaluate(() => (window as unknown as { uiTest: { commands: AppCommand[] } }).uiTest.commands);
  expect(commands.find(command => command.type === 'task.create')).toMatchObject({ checks: [{ command: ['npm', 'test', '--', 'api'], protectedPaths: ['test/api.test.ts'] }], executionPolicy: 'reviewBeforeExecute' });
  expect(commands.some(command => command.type === 'model.check')).toBe(true);
});

test('fixed acceptance edits preview every changed field, preserve cancellation and apply the exact host preview', async ({ page }) => {
  await start(page);
  await page.getByRole('textbox', { name: 'Describe a requirement change…' }).fill('Keep this unsent requirement draft.');
  await page.getByRole('button', { name: 'Edit checks', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Edit checks', exact: true });
  await editor.getByLabel('Check label', { exact: true }).fill('Discard this local edit');
  await editor.getByRole('button', { name: 'Cancel editing', exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { uiTest: { commands: AppCommand[] } }).uiTest.commands.some(command => command.type === 'task.previewRevision'))).toBe(false);
  for (const apply of [false, true]) {
    await page.getByRole('button', { name: 'Edit checks', exact: true }).click();
    await expect(editor.getByLabel('Check label', { exact: true })).toHaveValue('API tests');
    await editor.getByLabel('Check label', { exact: true }).fill('Contract checks');
    await editor.getByLabel('Command argv (JSON array)').fill('["npm","run","verify:contract"]');
    await editor.getByLabel('Protected paths (one per line)').fill('test/contracts.test.ts\npackage.json');
    await editor.getByRole('button', { name: 'Preview impact', exact: true }).click();
    const preview = page.getByRole('dialog', { name: 'Review impact', exact: true });
    await expect(preview.locator('.check-change > h4 > code')).toHaveText('test');
    await expect(preview.getByText('Changed', { exact: true })).toBeVisible();
    const before = preview.getByRole('region', { name: 'Before', exact: true });
    const after = preview.getByRole('region', { name: 'After', exact: true });
    await expect(before).toContainText('API tests');
    await expect(before).toContainText('["npm","test"]');
    await expect(before).toContainText('test/api.test.ts');
    await expect(after).toContainText('Contract checks');
    await expect(after).toContainText('["npm","run","verify:contract"]');
    await expect(after).toContainText('test/contracts.test.ts');
    await expect(after).toContainText('package.json');
    await expect(preview).toContainText('Inspect callers');
    await expect(preview).toContainText('Verify public APIs');
    const pending = await page.evaluate(() => (window as unknown as { uiTest: { snapshot: TaskSnapshot; commands: AppCommand[] } }).uiTest);
    expect(pending.snapshot.task.checks).toEqual(fixture.task.checks);
    expect(pending.snapshot.task.status).toBe('paused');
    expect(pending.commands.some(command => command.type === 'task.applyImpact')).toBe(false);
    await preview.getByRole('button', { name: apply ? 'Apply and continue' : 'Dismiss', exact: true }).click();
    await expect(preview).toHaveCount(0);
  }
  const state = await page.evaluate(() => (window as unknown as { uiTest: { snapshot: TaskSnapshot; commands: AppCommand[]; previews: ImpactPreview[] } }).uiTest);
  const applied = state.commands.filter(command => command.type === 'task.applyImpact');
  expect(applied).toHaveLength(1);
  expect(applied[0]!.preview).toEqual(state.previews.at(-1));
  expect(state.previews.at(-1)).toMatchObject({ taskId: 'task-1', expectedRevision: 1, checks: [{ id: 'test', label: 'Contract checks', command: ['npm', 'run', 'verify:contract'], protectedPaths: ['test/contracts.test.ts', 'package.json'] }] });
  expect(state.previews.at(-1)).not.toHaveProperty('objective');
  expect(state.snapshot.task.revision).toBe(2);
  await expect(page.getByRole('textbox', { name: 'Describe a requirement change…' })).toHaveValue('Keep this unsent requirement draft.');
});

test('historical check receipts, plan conditions and terminal commands resolve their own task revision', async ({ page }) => {
  await start(page);
  await page.evaluate(() => {
    const state = (window as unknown as { uiTest: { snapshot: TaskSnapshot; change: (patch: Partial<TaskSnapshot>) => void } }).uiTest;
    const s = state.snapshot;
    const checks = [{ id: 'test', label: 'Contract checks', command: ['npm', 'run', 'verify:contract'], protectedPaths: ['test/contracts.test.ts'] }];
    const plan = { ...s.plan!, id: 'plan-2', taskRevision: 2, revision: 2 };
    state.change({ task: { ...s.task, revision: 2, activePlanId: 'plan-2', checks, revisionHistory: [...s.task.revisionHistory, { revision: 2, objective: s.task.objective, checks, createdAt: s.task.updatedAt }] }, plan, plans: [...s.plans, plan], checks: [
      { id: 'old-check', conditionId: 'test', taskId: s.task.id, taskRevision: 1, planId: 'plan-1', runId: 'run-2', nodeId: 'edit', batchId: 'batch-old', scope: 'node', checksDigest: 'old-definition', result: 'pass', inputDigest: 'old-input', output: 'Historical API output', checkedAt: s.task.updatedAt },
      { id: 'legacy-check', conditionId: 'test', taskId: s.task.id, runId: 'run-2', nodeId: 'edit', result: 'pass', inputDigest: 'legacy-input', output: 'Legacy output without a revision', checkedAt: s.task.updatedAt },
    ] });
  });
  await page.getByRole('button', { name: 'Planning', exact: true }).click();
  const planning = page.getByRole('complementary', { name: 'Planning', exact: true });
  await expect(planning.locator('.conditions')).toContainText('Contract checks');
  await planning.getByRole('button', { name: 'Steps', exact: true }).click();
  await planning.getByLabel('Plan versions').selectOption('plan-1');
  await planning.getByRole('button', { name: /Update the adapter.*Historical plan/ }).click();
  await expect(planning.locator('.detail-content > dl')).toContainText('API tests');
  await expect(planning.locator('.detail-content > dl')).not.toContainText('Contract checks');
  await planning.getByRole('button', { name: 'Checks', exact: true }).click();
  const old = planning.locator('.receipt').filter({ hasText: 'Historical API output' });
  await expect(old.locator(':scope > summary')).toContainText('API tests');
  await old.locator(':scope > summary').click();
  await expect(old.locator('.check-definition')).toContainText('["npm","test"]');
  await expect(old.locator('.check-definition')).toContainText('test/api.test.ts');
  await expect(old).not.toContainText('Contract checks');
  const legacy = planning.locator('.receipt').filter({ hasText: 'Legacy output without a revision' });
  await expect(legacy.locator(':scope > summary')).toContainText('test');
  await expect(legacy.locator(':scope > summary')).not.toContainText('Contract checks');
  await legacy.locator(':scope > summary').click();
  await expect(legacy).toContainText('Check definitions were not recorded for this revision.');
  await planning.getByRole('button', { name: 'Process', exact: true }).click();
  await planning.locator('.conditions summary').click();
  await expect(planning.locator('.conditions')).toContainText('API tests');
  await expect(planning.locator('.conditions')).toContainText('["npm","test"]');
  await expect(planning.locator('.conditions')).not.toContainText('Contract checks');
  await page.getByRole('button', { name: 'Close planning', exact: true }).click();
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  const terminalOld = page.locator('.terminal-record').filter({ hasText: 'Historical API output' });
  await expect(terminalOld.locator('summary')).toContainText('npm test');
  await expect(terminalOld.locator('summary')).not.toContainText('verify:contract');
  const terminalLegacy = page.locator('.terminal-record').filter({ hasText: 'Legacy output without a revision' });
  await expect(terminalLegacy.locator('summary')).toContainText('test · Not recorded');
  await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('zh-CN');
  await expect(terminalLegacy.locator('summary')).toContainText('test · 未记录');
  await page.locator('.task-revisions > summary').click();
  const original = page.locator('.task-revisions > details').first();
  await original.locator(':scope > summary').click();
  await expect(original).toContainText('API tests');
  await expect(original).not.toContainText('Contract checks');
});

test('stale acceptance editors cannot submit and a delayed preview cannot target a newly selected task', async ({ page }) => {
  await start(page);
  await delayRevisionResponses(page);
  await page.getByRole('button', { name: 'Edit checks', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Edit checks', exact: true });
  await editor.getByLabel('Check label', { exact: true }).fill('An old draft');
  await page.evaluate(() => {
    const state = (window as unknown as { uiTest: { snapshot: TaskSnapshot; change: (patch: Partial<TaskSnapshot>) => void } }).uiTest;
    state.change({ task: { ...state.snapshot.task, revision: 2, checks: [{ ...state.snapshot.task.checks[0]!, label: 'Updated elsewhere' }] } });
  });
  await expect(editor.getByRole('alert')).toContainText('This task has changed');
  await expect(editor.getByLabel('Check label', { exact: true })).toHaveValue('An old draft');
  await expect(editor.getByRole('button', { name: 'Preview impact', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => (window as unknown as { uiTest: { commands: AppCommand[] } }).uiTest.commands.some(command => command.type === 'task.previewRevision'))).toBe(false);
  await editor.getByRole('button', { name: 'Cancel editing', exact: true }).click();
  await page.evaluate(() => {
    const state = (window as unknown as { uiTest: { snapshot: TaskSnapshot; change: (patch: Partial<TaskSnapshot>) => void } }).uiTest;
    const original = window.knotrail.command;
    const second = structuredClone(state.snapshot); second.task = { ...second.task, id: 'task-2', title: 'Another task' };
    window.knotrail.command = async <T,>(command: AppCommand): Promise<T> => {
      if (command.type === 'task.snapshot' && command.taskId === 'task-2') return structuredClone(second) as T;
      const result = await original<T>(command);
      if (command.type === 'bootstrap') return { ...(result as Bootstrap), tasks: [...(result as Bootstrap).tasks, second.task] } as T;
      return result;
    };
    state.change({});
  });
  await page.getByRole('button', { name: 'Edit checks', exact: true }).click();
  await expect(editor.getByLabel('Check label', { exact: true })).toHaveValue('Updated elsewhere');
  await editor.getByLabel('Check label', { exact: true }).fill('Bound to the first task');
  await editor.getByRole('button', { name: 'Preview impact', exact: true }).click();
  await editor.getByRole('button', { name: 'Cancel editing', exact: true }).click();
  await page.getByRole('button', { name: /Another task/ }).click();
  await expect(page.getByRole('heading', { name: 'Another task', exact: true })).toBeVisible();
  await page.evaluate(() => (window as unknown as { uiTest: { settleRevision: (index: number) => void } }).uiTest.settleRevision(0));
  await expect(page.getByRole('button', { name: 'Edit checks', exact: true })).toBeEnabled();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const commands = await page.evaluate(() => (window as unknown as { uiTest: { commands: AppCommand[] } }).uiTest.commands);
  expect(commands.filter(command => command.type === 'task.previewRevision')).toMatchObject([{ taskId: 'task-1', expectedRevision: 2, checks: [{ label: 'Bound to the first task' }] }]);
  expect(commands.some(command => command.type === 'task.applyImpact')).toBe(false);
});

test('all acceptance editor exits discard late responses while preserving the host pause', async ({ page }) => {
  await start(page);
  await delayRevisionResponses(page);
  for (const [index, exit] of ['Cancel editing', 'Escape', 'Close'].entries()) {
    await page.getByRole('button', { name: 'Edit checks', exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'Edit checks', exact: true });
    await editor.getByLabel('Check label', { exact: true }).fill(`Discarded by ${exit}`);
    await editor.getByRole('button', { name: 'Preview impact', exact: true }).click();
    if (exit === 'Escape') await page.keyboard.press('Escape');
    else await editor.getByRole('button', { name: exit, exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.evaluate(({ index, reject }) => (window as unknown as { uiTest: { settleRevision: (index: number, error?: string) => void } }).uiTest.settleRevision(index, reject ? 'Discarded preview failure' : undefined), { index, reject: exit === 'Close' });
    await expect(page.getByRole('button', { name: 'Edit checks', exact: true })).toBeEnabled();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
  }
  const state = await page.evaluate(() => (window as unknown as { uiTest: { snapshot: TaskSnapshot; commands: AppCommand[] } }).uiTest);
  expect(state.snapshot.task.checks).toEqual(fixture.task.checks);
  expect(state.snapshot.task.status).toBe('paused');
  expect(state.commands.filter(command => command.type === 'task.previewRevision')).toHaveLength(3);
  expect(state.commands.some(command => command.type === 'task.applyImpact' || command.type === 'task.resume')).toBe(false);
});

for (const outcome of ['success', 'failure'] as const) test(`a discarded acceptance preview ${outcome} cannot replace a later requirement preview`, async ({ page }) => {
  await start(page);
  await delayRevisionResponses(page);
  await page.getByRole('button', { name: 'Edit checks', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Edit checks', exact: true });
  await editor.getByLabel('Check label', { exact: true }).fill('Discarded acceptance draft');
  await editor.getByRole('button', { name: 'Preview impact', exact: true }).click();
  await editor.getByRole('button', { name: 'Cancel editing', exact: true }).click();
  const draft = page.getByRole('textbox', { name: 'Describe a requirement change…' });
  await draft.fill('A later requirement draft');
  await draft.press('Control+Enter');
  await expect.poll(() => page.evaluate(() => (window as unknown as { uiTest: { pendingRevisions: unknown[] } }).uiTest.pendingRevisions.length)).toBe(2);
  await page.evaluate(() => (window as unknown as { uiTest: { settleRevision: (index: number) => void } }).uiTest.settleRevision(1));
  const preview = page.getByRole('dialog', { name: 'Review impact', exact: true });
  await expect(preview).toBeVisible();
  await page.evaluate(outcome => (window as unknown as { uiTest: { settleRevision: (index: number, error?: string) => void } }).uiTest.settleRevision(0, outcome === 'failure' ? 'Old acceptance preview failure' : undefined), outcome);
  await expect(preview.getByRole('button', { name: 'Apply and continue', exact: true })).toBeEnabled();
  await expect(preview.locator('.check-comparison')).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await preview.getByRole('button', { name: 'Apply and continue', exact: true }).click();
  const state = await page.evaluate(() => (window as unknown as { uiTest: { snapshot: TaskSnapshot; commands: AppCommand[]; previews: ImpactPreview[] } }).uiTest);
  const applied = state.commands.filter(command => command.type === 'task.applyImpact');
  expect(applied).toHaveLength(1);
  expect(applied[0]!.preview).toEqual(state.previews[1]);
  expect(state.snapshot.task.objective).toContain('A later requirement draft');
  expect(state.snapshot.task.checks).toEqual(fixture.task.checks);
});

for (const outcome of ['success', 'failure'] as const) test(`a dismissed Apply ${outcome} cannot close a newer preview or clear its draft`, async ({ page }) => {
  await start(page);
  await delayRevisionResponses(page, 'task.applyImpact');
  const composer = page.getByRole('textbox', { name: 'Describe a requirement change…' });
  await composer.fill('First accepted requirement');
  await composer.press('Control+Enter');
  const preview = page.getByRole('dialog', { name: 'Review impact', exact: true });
  await preview.getByRole('button', { name: 'Apply and continue', exact: true }).click();
  await preview.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(page.locator('.subtitle')).toContainText('Version 2');
  await composer.fill('Keep this newer requirement draft');
  await composer.press('Control+Enter');
  await expect(preview).toContainText('Task revision 2');
  await page.evaluate(outcome => (window as unknown as { uiTest: { settleRevision: (index: number, error?: string) => void } }).uiTest.settleRevision(0, outcome === 'failure' ? 'Earlier Apply response failed' : undefined), outcome);
  await expect(preview.getByRole('button', { name: 'Apply and continue', exact: true })).toBeEnabled();
  await expect(composer).toHaveValue('Keep this newer requirement draft');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.locator('.titlebar .status')).toHaveText('Paused');
  await preview.getByRole('button', { name: 'Apply and continue', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { uiTest: { pendingRevisions: unknown[] } }).uiTest.pendingRevisions.length)).toBe(2);
  await page.evaluate(() => (window as unknown as { uiTest: { settleRevision: (index: number) => void } }).uiTest.settleRevision(1));
  await expect(preview).toHaveCount(0);
  await expect(composer).toHaveValue('');
  const state = await page.evaluate(() => (window as unknown as { uiTest: { snapshot: TaskSnapshot; commands: AppCommand[]; previews: ImpactPreview[] } }).uiTest);
  expect(state.snapshot.task.revision).toBe(3);
  expect(state.commands.filter(command => command.type === 'task.applyImpact').map(command => command.preview)).toEqual(state.previews);
  expect(state.snapshot.task.checks).toEqual(fixture.task.checks);
});

test('applying a requirement preserves text entered while its preview response was pending', async ({ page }) => {
  await start(page);
  await delayRevisionResponses(page);
  const composer = page.getByRole('textbox', { name: 'Describe a requirement change…' });
  await composer.fill('The requirement being submitted');
  await composer.press('Control+Enter');
  await composer.fill('Later text that has not been submitted');
  await page.evaluate(() => (window as unknown as { uiTest: { settleRevision: (index: number) => void } }).uiTest.settleRevision(0));
  const preview = page.getByRole('dialog', { name: 'Review impact', exact: true });
  await preview.getByRole('button', { name: 'Apply and continue', exact: true }).click();
  await expect(preview).toHaveCount(0);
  await expect(composer).toHaveValue('Later text that has not been submitted');
  const state = await page.evaluate(() => (window as unknown as { uiTest: { snapshot: TaskSnapshot; commands: AppCommand[] } }).uiTest);
  expect(state.snapshot.task.revision).toBe(2);
  expect(state.snapshot.task.objective).toContain('The requirement being submitted');
  expect(state.snapshot.task.objective).not.toContain('Later text that has not been submitted');
});

test('acceptance removal explains manual review, maintenance keeps a check, and host errors remain visible in the bilingual narrow editor', async ({ page }) => {
  await start(page);
  await page.evaluate(() => {
    const state = (window as unknown as { uiTest: { snapshot: TaskSnapshot; change: (patch: Partial<TaskSnapshot>) => void } }).uiTest;
    state.change({ task: { ...state.snapshot.task, mode: 'maintain', status: 'healthy' } });
  });
  await expect(page.locator('.titlebar .status')).toHaveText('Healthy');
  await page.getByRole('button', { name: 'Edit checks', exact: true }).click();
  let editor = page.getByRole('dialog', { name: 'Edit checks', exact: true });
  await editor.getByRole('button', { name: 'Remove check 1', exact: true }).click();
  await expect(editor.getByRole('alert')).toHaveText('Maintenance requires at least one fixed acceptance check');
  await expect(editor.getByRole('button', { name: 'Preview impact', exact: true })).toBeDisabled();
  await expect(editor).not.toContainText('Completion will require your acceptance.');
  await editor.getByRole('button', { name: 'Cancel editing', exact: true }).click();
  await page.evaluate(() => {
    const state = (window as unknown as { uiTest: { snapshot: TaskSnapshot; change: (patch: Partial<TaskSnapshot>) => void } }).uiTest;
    state.change({ task: { ...state.snapshot.task, mode: 'once', status: 'paused' } });
  });
  await expect(page.locator('.titlebar .status')).toHaveText('Paused');
  await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('zh-CN');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.sidebar').getByRole('button', { name: '收起导航', exact: true }).click();
  await page.getByRole('button', { name: '编辑验收', exact: true }).click();
  editor = page.getByRole('dialog', { name: '编辑验收', exact: true });
  await editor.getByRole('button', { name: '移除检查 1', exact: true }).click();
  await editor.getByRole('button', { name: '预览影响', exact: true }).click();
  const preview = page.getByRole('dialog', { name: '审阅影响', exact: true });
  await expect(preview).toContainText('将移除全部自动检查。任务完成将改为由你人工验收结果。');
  await expect(preview).toContainText('新版本必须重新规划并验证');
  await expect(preview.getByRole('region', { name: '修改前', exact: true })).toContainText('API tests');
  await expect(preview.getByRole('region', { name: '修改后', exact: true })).toContainText('无');
  expect(await preview.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.keyboard.press('Shift+Tab');
  expect(await preview.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await page.screenshot({ path: test.info().outputPath('acceptance-removal-zh-narrow.png') });
  await page.keyboard.press('Escape');
  await expect(preview).toHaveCount(0);
  await page.getByRole('button', { name: '编辑验收', exact: true }).click();
  await editor.getByLabel('命令参数（JSON 数组）').fill('[1]');
  await editor.getByRole('button', { name: '预览影响', exact: true }).click();
  await expect(editor.getByRole('alert')).toHaveText('每条命令必须是非空字符串组成的 JSON 数组。');
  await editor.getByLabel('命令参数（JSON 数组）').fill('["npm","test","--","contract"]');
  await page.evaluate(() => {
    const original = window.knotrail.command;
    window.knotrail.command = async <T,>(command: AppCommand): Promise<T> => {
      if (command.type === 'task.previewRevision') throw new Error('Workspace inspection failed for acceptance preview');
      return original<T>(command);
    };
  });
  await editor.getByRole('button', { name: '预览影响', exact: true }).click();
  await expect(editor.getByRole('alert')).toHaveText('Workspace inspection failed for acceptance preview');
  await expect(editor.getByLabel('命令参数（JSON 数组）')).toHaveValue('["npm","test","--","contract"]');
  const state = await page.evaluate(() => (window as unknown as { uiTest: { snapshot: TaskSnapshot; commands: AppCommand[] } }).uiTest);
  expect(state.snapshot.task.checks).toEqual(fixture.task.checks);
  expect(state.commands.filter(command => command.type === 'task.previewRevision')).toMatchObject([{ checks: [] }]);
  expect(state.commands.some(command => command.type === 'task.applyImpact')).toBe(false);
});

test('narrow screens use a right drawer with keyboard containment, no horizontal overflow, and accessible navigation', async ({ page }) => {
  await start(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.sidebar').getByRole('button', { name: 'Collapse navigation', exact: true }).click();
  await page.getByRole('button', { name: 'Planning', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Planning', exact: true });
  await expect(drawer).toBeVisible();
  const drawerBox = await drawer.boundingBox();
  expect(drawerBox!.x).toBeGreaterThanOrEqual(0);
  expect(drawerBox!.x + drawerBox!.width).toBeLessThanOrEqual(390);
  expect(drawerBox!.width).toBeGreaterThan(280);
  await expect(page.getByRole('button', { name: 'Close planning', exact: true }).last()).toBeFocused();
  await page.screenshot({ path: test.info().outputPath('workbench-narrow-right-plan.png') });
  await page.keyboard.press('Shift+Tab');
  expect(await drawer.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Planning', exact: true })).toBeFocused();
  for (const width of [390, 736, 1024]) {
    await page.setViewportSize({ width, height: 844 });
    const sizes = await page.evaluate(() => ({ actual: document.documentElement.scrollWidth, viewport: window.innerWidth }));
    expect(sizes.actual).toBeLessThanOrEqual(sizes.viewport);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Expand navigation' }).click();
  await expect(page.getByRole('button', { name: /Upgrade the adapter/ })).toBeVisible();
});

test('recovery decisions show evidence, translate host choices, and inspect terminal effects without resuming', async ({ page }) => {
  await start(page);
  await page.evaluate(() => {
    const state = (window as unknown as { uiTest: { snapshot: TaskSnapshot; change: (patch: Partial<TaskSnapshot>) => void } }).uiTest;
    state.change({ task: { ...state.snapshot.task, status: 'waiting_user' }, artifacts: [{ ...state.snapshot.artifacts[0]!, content: 'Unknown action: call-1 run_command\nCurrent diff:\n+ preserved edit' }], decisions: [{ id: 'recovery-1', kind: 'recovery', taskId: 'task-1', taskRevision: 1, planId: 'plan-1', question: 'Host recovery question', options: ['preserve-and-replan', 'stop-task'], recovery: { actionIds: ['action-1'], actionsDigest: 'actions-digest', workspaceDigest: 'workspace-digest', artifactId: 'artifact-1' }, createdAt: '2026-09-06T09:00:00Z' }] });
  });
  const card = page.locator('.conversation .decision-card');
  await expect(card.getByRole('button', { name: 'Preserve files and replan', exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
  await expect(card.locator('pre')).toContainText('Unknown action: call-1 run_command');
  await expect(card.locator('pre')).toContainText('+ preserved edit');
  await expect(card).toContainText('artifact-1');
  await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('zh-CN');
  await expect(card).toContainText('保留文件不代表确认此前操作成功');
  await expect(card.getByRole('button', { name: '停止任务', exact: true })).toBeVisible();
  await expect(card.getByText('恢复证据', { exact: true })).toBeVisible();
  await card.getByRole('button', { name: '保留文件并重新规划', exact: true }).click();
  await expect(card).toHaveCount(0);
  await page.evaluate(() => {
    const state = (window as unknown as { uiTest: { snapshot: TaskSnapshot; change: (patch: Partial<TaskSnapshot>) => void } }).uiTest;
    state.change({ task: { ...state.snapshot.task, status: 'cancelled' }, runs: state.snapshot.runs.map(run => run.status === 'running' ? { ...run, status: 'aborted' } : run), actions: [{ ...state.snapshot.actions[0]!, name: 'run_command', status: 'unknown' }] });
  });
  await expect(page.getByRole('button', { name: '继续', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '查看未确认的操作影响', exact: true }).click();
  await expect(card).toContainText('任务将保持终止');
  await expect(card.getByRole('button', { name: '保留文件并保持终止', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: '界面语言', exact: true }).selectOption('en');
  await expect(page.getByRole('button', { name: 'Inspect unknown effects', exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('terminal-recovery.png') });
  await card.getByRole('button', { name: 'Preserve files and keep stopped', exact: true }).click();
  await expect(card).toHaveCount(0);
  const state = await page.evaluate(() => (window as unknown as { uiTest: { commands: AppCommand[]; snapshot: TaskSnapshot } }).uiTest);
  expect(state.snapshot.task.status).toBe('cancelled');
  expect(state.commands.filter(command => command.type === 'decision.answer').map(command => command.answer)).toEqual(['preserve-and-replan', 'preserve-and-stop']);
  expect(state.commands.some(command => command.type === 'task.inspectEffects')).toBe(true);
  expect(state.commands.some(command => command.type === 'task.resume')).toBe(false);
});

test('check receipts distinguish current bindings from history and missing usage is visible', async ({ page }) => {
  await start(page);
  await page.evaluate(() => {
    const state = (window as unknown as { uiTest: { snapshot: TaskSnapshot; change: (patch: Partial<TaskSnapshot>) => void } }).uiTest;
    const current = { id: 'current', batchId: 'batch-current', scope: 'node' as const, taskRevision: 1, planId: 'plan-1', checksDigest: 'checks-current', taskId: 'task-1', nodeId: 'edit', runId: 'run-2', conditionId: 'test', result: 'pass' as const, inputDigest: 'verified-source-digest', output: 'Current check output', checkedAt: '2026-09-06T09:00:00Z' };
    state.change({ checks: [current, { ...current, id: 'old-plan', planId: 'plan-0', output: 'Old plan check output' }, { ...current, id: 'old-run', runId: 'run-old', output: 'Old attempt check output' }, { id: 'legacy', taskId: 'task-1', nodeId: 'edit', runId: 'run-2', conditionId: 'test', result: 'pass', inputDigest: 'legacy-source', output: 'Legacy check output', checkedAt: current.checkedAt }] });
  });
  await page.locator('.composer-footer summary').click();
  await expect(page.locator('.composer-footer dd').nth(1)).toHaveText('1,234 · Partial usage');
  await page.evaluate(() => {
    const state = (window as unknown as { uiTest: { snapshot: TaskSnapshot; change: (patch: Partial<TaskSnapshot>) => void } }).uiTest;
    state.change({runs:state.snapshot.runs.map(run=>({...run,usage:{input:3,output:2,partial:true}}))});
  });
  await expect(page.locator('.composer-footer dd').nth(1)).toContainText('Partial usage');
  await page.getByRole('button', { name: 'Planning', exact: true }).click();
  await page.getByRole('button', { name: 'Steps', exact: true }).click();
  await page.getByRole('button', { name: /Update the adapter.*Edit/ }).click();
  await page.getByRole('button', { name: 'Checks', exact: true }).click();
  const receipts = page.locator('.node-detail .receipt');
  await expect(receipts).toHaveCount(4);
  await expect(receipts.getByText('Current', { exact: true })).toHaveCount(1);
  await expect(receipts.getByText('Historical', { exact: true })).toHaveCount(3);
  await expect(receipts.locator('.status-pass')).toHaveCount(1);
  await receipts.first().locator('summary').click();
  for (const binding of ['batch-current', 'plan-1', 'verified-source-digest', 'checks-current', 'run-2']) await expect(receipts.first()).toContainText(binding);
  await receipts.last().locator('summary').click();
  await expect(receipts.last()).toContainText('Not recorded');
  await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('zh-CN');
  await expect(receipts.getByText('历史记录', { exact: true })).toHaveCount(3);
  await expect(receipts.first()).toContainText('批次');
  await page.screenshot({ path: test.info().outputPath('checks-current-and-history-zh.png') });
  await page.evaluate(() => {
    const state = (window as unknown as { uiTest: { snapshot: TaskSnapshot; change: (patch: Partial<TaskSnapshot>) => void } }).uiTest;
    state.change({ nodes: state.snapshot.nodes.map(node => node.nodeId === 'edit' ? { ...node, status: 'stale' } : node), runs: state.snapshot.runs.map(run => ({ ...run, usage: undefined })) });
  });
  await expect(receipts.getByText('历史记录', { exact: true })).toHaveCount(4);
  await expect(receipts.locator('.status-pass')).toHaveCount(0);
  await expect(page.locator('.composer-footer dd').nth(1)).toHaveText('不可用');
});

test('acceptance copy is translated without translating model-authored choices', async ({ page }) => {
  await start(page);
  await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('zh-CN');
  await page.evaluate(() => {
    const state = (window as unknown as { uiTest: { snapshot: TaskSnapshot; change: (patch: Partial<TaskSnapshot>) => void } }).uiTest;
    state.change({ task: { ...state.snapshot.task, status: 'waiting_user' }, decisions: [{ id: 'acceptance-1', kind: 'acceptance', taskId: 'task-1', taskRevision: 1, question: 'Host acceptance question', options: ['accept', 'reject'], createdAt: '2026-09-06T09:00:00Z' }, { id: 'model-1', kind: 'model', taskId: 'task-1', taskRevision: 1, question: 'Model-authored question?', options: ['accept'], createdAt: '2026-09-06T09:00:00Z' }] });
  });
  await expect(page.getByRole('button', { name: '接受结果', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '不接受结果', exact: true })).toBeVisible();
  await expect(page.getByText('Model-authored question?', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'accept', exact: true })).toBeVisible();
});

test('external wait observations stay visible with planning closed and preserve source values across languages', async ({ page }) => {
  await start(page);
  await page.evaluate(() => {
    const state = (window as unknown as { uiTest: { snapshot: TaskSnapshot; change: (patch: Partial<TaskSnapshot>) => void } }).uiTest;
    state.change({ task: { ...state.snapshot.task, mode: 'finite', status: 'waiting_external', nextCheckAt: '2026-09-06T09:15:00Z', wait: { id: 'wait-1', taskRevision: 1, planId: 'plan-1', runId: 'run-2', nodeId: 'edit', registeredAt: '2026-09-06T09:00:00Z', reason: 'Wait for release readiness.', minutes: 5, source: { kind: 'project_file', path: 'status/release.txt' }, condition: { kind: 'contains', text: 'READY=v2' }, last: { checkedAt: '2026-09-06T09:10:00Z', status: 'unknown', error: 'Source temporarily unavailable', missedIntervals: 2, gapSince: '2026-09-06T09:00:00Z' } } }, runs: state.snapshot.runs.map(run => ({ ...run, status: 'succeeded' })) });
  });
  const observation = page.locator('.conversation').getByRole('region', { name: 'External wait', exact: true });
  await expect(page.getByRole('complementary', { name: 'Planning', exact: true })).toHaveCount(0);
  await expect(observation).toContainText('Project file');
  await expect(observation).toContainText('status/release.txt');
  await expect(observation).toContainText('READY=v2');
  await expect(observation).toContainText('Unknown');
  await expect(observation).toContainText('Source temporarily unavailable');
  await expect(observation).toContainText('Repeated source information does not start another model run.');
  await expect(observation.getByText('Consumed at', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
  await expect(observation.locator('time[datetime="2026-09-06T09:10:00Z"]')).toHaveCount(1);
  await expect(observation.locator('time[datetime="2026-09-06T09:15:00Z"]')).toHaveCount(1);
  await expect(observation.getByText('Observation gap since', { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Describe a requirement change…' }).fill('Keep READY=v2 unchanged');
  await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('zh-CN');
  const chinese = page.locator('.conversation').getByRole('region', { name: '外部等待', exact: true });
  await expect(chinese).toContainText('待确认');
  await expect(chinese).toContainText('项目文件');
  await expect(chinese).toContainText('status/release.txt');
  await expect(chinese).toContainText('READY=v2');
  await expect(chinese).toContainText('漏过的周期');
  await expect(chinese).toContainText('观测缺口起点');
  await expect(chinese).toContainText('重复的来源信息不会再次启动模型');
  await expect(page.getByRole('textbox', { name: '补充或修改任务要求…' })).toHaveValue('Keep READY=v2 unchanged');
  await page.evaluate(() => {
    const state = (window as unknown as { uiTest: { snapshot: TaskSnapshot; change: (patch: Partial<TaskSnapshot>) => void } }).uiTest;
    const wait = state.snapshot.task.wait!;
    state.change({ task: { ...state.snapshot.task, wait: { ...wait, last: { ...wait.last, status: 'waiting', content: 'RELEASE=pending', digest: 'source-digest', error: undefined } } } });
  });
  await expect(chinese).toContainText('条件未满足');
  await expect(chinese.locator('pre')).toHaveText('RELEASE=pending');
  await page.getByRole('button', { name: '定时任务', exact: true }).click();
  const scheduled = page.locator('.schedule-list').getByRole('region', { name: '外部等待', exact: true });
  await expect(scheduled).toContainText('status/release.txt');
  await expect(scheduled).toContainText('READY=v2');
  await expect(scheduled).toContainText('RELEASE=pending');
  await expect(scheduled).toContainText('漏过的周期');
  await page.evaluate(() => {
    const state = (window as unknown as { uiTest: { snapshot: TaskSnapshot; change: (patch: Partial<TaskSnapshot>) => void } }).uiTest;
    const wait = state.snapshot.task.wait!;
    state.change({ task: { ...state.snapshot.task, status: 'executing', wait: { ...wait, consumedAt: '2026-09-06T09:15:01Z', last: { ...wait.last, status: 'satisfied', content: 'READY=v2' } } } });
  });
  await expect(scheduled).toContainText('条件已满足');
  await expect(scheduled).toContainText('消费时间');
  await expect(scheduled.locator('time[datetime="2026-09-06T09:15:01Z"]')).toHaveCount(1);
  const commands = await page.evaluate(() => (window as unknown as { uiTest: { commands: AppCommand[] } }).uiTest.commands);
  expect(commands.filter(command => command.type === 'task.pause')).toHaveLength(1);
  expect(commands.some(command => command.type === 'task.cancel')).toBe(false);
});

test('maintenance shows observation bindings, resumes only checks, and verification does not count as model usage', async ({ page }) => {
  await start(page);
  await page.evaluate(() => {
    const state = (window as unknown as { uiTest: { snapshot: TaskSnapshot; change: (patch: Partial<TaskSnapshot>) => void } }).uiTest;
    state.change({ task: { ...state.snapshot.task, mode: 'maintain', status: 'unknown', nextCheckAt: '2026-09-06T09:20:00Z', health: { status: 'unknown', checkedAt: '2026-09-06T09:10:00Z', inputDigest: 'maintenance-input', batchId: 'maintenance-batch', runId: 'verification-1', reason: 'Workspace changed during verification', missedIntervals: 3, gapSince: '2026-09-06T09:00:00Z' } }, runs: [{ ...state.snapshot.runs[1]!, status: 'succeeded' }] });
  });
  const observation = page.locator('.conversation').getByRole('region', { name: 'Maintenance verification', exact: true });
  await expect(observation).toContainText('Unknown');
  await expect(observation).toContainText('Workspace changed during verification');
  await expect(observation).toContainText('maintenance-input');
  await expect(observation).toContainText('maintenance-batch');
  await expect(observation).toContainText('verification-1');
  await expect(observation).toContainText('No automatic repair. Resume reruns checks');
  await expect(observation.locator('time[datetime="2026-09-06T09:10:00Z"]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await page.evaluate(() => {
    const state = (window as unknown as { uiTest: { snapshot: TaskSnapshot; change: (patch: Partial<TaskSnapshot>) => void } }).uiTest;
    state.change({ task: { ...state.snapshot.task, status: 'verifying' }, runs: [...state.snapshot.runs, { id: 'verification-2', taskId: 'task-1', taskRevision: 1, planId: 'plan-1', purpose: 'verification', attempt: 2, status: 'running', inputDigest: 'maintenance-next', startedAt: '2026-09-06T09:15:00Z' }] });
  });
  await expect(page.locator('.running-line')).toContainText('Maintenance verification');
  await expect(page.locator('.running-line')).not.toContainText('Planning');
  await page.locator('.composer-footer summary').click();
  await expect(page.locator('.composer-footer dd').nth(1)).toHaveText('1,234');
  await expect(page.locator('.composer-footer dd').nth(2)).toHaveText('456');
  await page.evaluate(() => {
    const state = (window as unknown as { uiTest: { snapshot: TaskSnapshot; change: (patch: Partial<TaskSnapshot>) => void } }).uiTest;
    state.change({ task: { ...state.snapshot.task, status: 'unhealthy', health: { ...state.snapshot.task.health!, status: 'unhealthy', reason: 'Fixed check exited 1' } }, runs: state.snapshot.runs.map(run => ({ ...run, status: 'succeeded' })) });
  });
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('zh-CN');
  const chinese = page.locator('.conversation').getByRole('region', { name: '维护复验', exact: true });
  await expect(chinese).toContainText('检查异常');
  await expect(chinese).toContainText('Fixed check exited 1');
  await expect(chinese).toContainText('不会自动修复');
  await expect(chinese).toContainText('maintenance-batch');
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await page.evaluate(() => {
    const state = (window as unknown as { uiTest: { snapshot: TaskSnapshot; change: (patch: Partial<TaskSnapshot>) => void } }).uiTest;
    state.change({ task: { ...state.snapshot.task, status: 'healthy', health: { ...state.snapshot.task.health!, status: 'healthy', reason: undefined } } });
  });
  await expect(chinese).toContainText('检查正常');
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await page.getByRole('button', { name: '定时任务', exact: true }).click();
  await expect(page.locator('.schedule-list').getByRole('region', { name: '维护复验', exact: true })).toContainText('maintenance-input');
  const commands = await page.evaluate(() => (window as unknown as { uiTest: { commands: AppCommand[] } }).uiTest.commands);
  expect(commands.filter(command => command.type === 'task.resume')).toHaveLength(1);
  expect(commands.filter(command => command.type === 'task.pause')).toHaveLength(3);
  expect(commands.some(command => command.type === 'task.cancel')).toBe(false);
  expect(commands.some(command => command.type === 'task.applyImpact' || command.type === 'task.previewRetry')).toBe(false);
});


test('Codex subscription login has a separate bilingual settings flow without key or custom endpoint fields',async ({page})=>{
 await start(page);await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('button',{name:'Models',exact:true}).click();
 await page.getByLabel('Authentication',{exact:true}).selectOption('codex-login');await expect(page.getByLabel('API key',{exact:true})).toHaveCount(0);await expect(page.getByLabel('Base URL',{exact:true})).toHaveCount(0);await page.getByLabel('Model ID',{exact:true}).fill('gpt-6-astra');
 await page.getByRole('button',{name:'Save settings',exact:true}).click();await page.getByRole('button',{name:'Check saved login',exact:true}).click();await expect(page.getByRole('status')).toContainText('Run a task to verify model access');
 const commands=await page.evaluate(()=>(window as unknown as {uiTest:{commands:AppCommand[]}}).uiTest.commands);expect(commands.find(c=>c.type==='settings.save')).toMatchObject({patch:{model:{authSource:'codex-login',modelId:'gpt-6-astra',baseUrl:'https://chatgpt.com/backend-api'}}});expect(JSON.stringify(commands)).not.toContain('apiKey');
 await page.getByRole('button',{name:'General',exact:true}).click();await page.locator('#settings-locale').selectOption('zh-CN');await page.getByRole('button',{name:'模型',exact:true}).click();await expect(page.getByLabel('认证方式',{exact:true})).toHaveValue('codex-login');await page.getByRole('button',{name:'检查已保存的登录方式',exact:true}).click();await expect(page.getByRole('status')).toContainText('本机 Codex 登录信息可用');await expect(page.locator('.app')).not.toContainText('程迹');
});

test('task steps stream canonical progress and recorded inputs and outputs with planning closed', async ({ page }) => {
  await start(page);
  const tracker = page.locator('.plan-tracker');
  const edit = tracker.locator('[data-node-id="edit"]');
  await expect(tracker.getByRole('progressbar')).toHaveAttribute('value', '1');
  await edit.locator(':scope > summary').click();
  await expect(edit).toContainText('Preserve exported signatures.');
  await expect(edit.getByText('Declared inputs', { exact: true })).toBeVisible();
  await expect(edit.getByText('Expected outputs', { exact: true })).toBeVisible();
  await expect(edit.getByText('Actual outputs', { exact: true })).toBeVisible();
  await edit.locator('.tool-receipt > summary').click();
  await expect(edit).toContainText('Parameters were not recorded for this operation.');
  await page.evaluate(() => {
    const state = (window as unknown as { uiTest: { snapshot: TaskSnapshot; change: (patch: Partial<TaskSnapshot>) => void } }).uiTest;
    const s = state.snapshot;
    state.change({ actions: [{ ...s.actions[0]!, name: 'write_file', status: 'pending', output: undefined }], events: [...s.events,
      { id: 'other-tool', seq: 3, taskId: s.task.id, taskRevision: 1, planId: 'plan-1', nodeId: 'edit', runId: 'run-other', kind: 'tool.started', text: 'write_file', data: { toolCallId: 'call-1', args: { path: 'WRONG-RUN.txt' } }, createdAt: '2026-09-06T09:01:00Z' },
      { id: 'tool', seq: 4, taskId: s.task.id, taskRevision: 1, planId: 'plan-1', nodeId: 'edit', runId: 'run-2', kind: 'tool.started', text: 'write_file', data: { toolCallId: 'call-1', args: { path: 'src/adapter.ts', content: 'export const nextAdapter = true;', expectedContent: 'old adapter' } }, createdAt: '2026-09-06T09:02:00Z' },
    ] });
  });
  await expect(edit.locator('.tool-receipt')).toContainText('Pending');
  await expect(edit.locator('.tool-fields')).toContainText('export const nextAdapter = true;');
  await expect(edit.locator('.tool-fields')).not.toContainText('WRONG-RUN.txt');
  await expect(edit.locator('.tool-fields')).toContainText('No output recorded yet');
  await page.evaluate(() => {
    const state = (window as unknown as { uiTest: { snapshot: TaskSnapshot; change: (patch: Partial<TaskSnapshot>) => void } }).uiTest;
    const s = state.snapshot;
    state.change({ actions: [{ ...s.actions[0]!, status: 'succeeded', output: 'Saved adapter with conflict-safe replacement', endedAt: '2026-09-06T09:03:00Z' }], runs: s.runs.map(run => run.id === 'run-2' ? { ...run, status: 'succeeded', summary: 'Implementation updated; verification pending.' } : run) });
  });
  await expect(edit.locator('.tool-fields')).toContainText('Saved adapter with conflict-safe replacement');
  await expect(edit).toContainText('Implementation updated; verification pending.');
  await expect(tracker.getByRole('progressbar')).toHaveAttribute('value', '1'); // A model report is not a verified NodeState.
  await page.evaluate(() => {
    const state = (window as unknown as { uiTest: { snapshot: TaskSnapshot; change: (patch: Partial<TaskSnapshot>) => void } }).uiTest;
    state.change({ nodes: state.snapshot.nodes.map(node => node.nodeId === 'edit' ? { ...node, status: 'verified' } : node) });
  });
  await expect(tracker.getByRole('progressbar')).toHaveAttribute('value', '2');
  await expect(page.getByRole('complementary', { name: 'Planning' })).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('zh-CN');
  await expect(edit.getByText('实际产出', { exact: true })).toBeVisible();
  await expect(edit.locator('.tool-fields')).toContainText('export const nextAdapter = true;');
  await page.setViewportSize({ width: 360, height: 844 });
  await page.locator('.sidebar').getByRole('button', { name: '收起导航', exact: true }).click();
  await edit.locator('.artifact > summary').click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  expect(await tracker.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('step-records-360-zh.png') });
});

test('retry and plan revision preserve history without treating prior same-ID outputs as current', async ({ page }) => {
  await start(page);
  const tracker = page.locator('.plan-tracker');
  const edit = tracker.locator('[data-node-id="edit"]');
  await edit.locator(':scope > summary').click();
  await page.evaluate(() => {
    const state = (window as unknown as { uiTest: { snapshot: TaskSnapshot; change: (patch: Partial<TaskSnapshot>) => void } }).uiTest;
    const s = state.snapshot;
    state.change({ nodes: s.nodes.map(node => node.nodeId === 'edit' ? { ...node, status: 'stale', reason: 'Explicit retry invalidated this result' } : node), runs: s.runs.map(run => ({ ...run, status: 'succeeded' })), decisions: [{ id: 'answered-step', kind: 'model', taskId: s.task.id, taskRevision: 1, planId: 'plan-1', nodeId: 'edit', question: 'Keep the adapter signature?', options: ['Keep signature'], answer: 'Keep signature', createdAt: '2026-09-06T09:03:00Z' }] });
  });
  await expect(edit).toContainText('No current attempt output.');
  await expect(edit.locator('.step-evidence > .run-record')).toHaveCount(0);
  await expect(edit).toContainText('Keep signature');
  await edit.locator('.step-history > summary').click();
  await edit.locator('.step-history .run-record > summary').click();
  await edit.locator('.step-history .artifact > summary').click();
  await expect(edit.locator('.step-history')).toContainText('nextAdapter(input)');
  await page.evaluate(() => {
    const state = (window as unknown as { uiTest: { snapshot: TaskSnapshot; change: (patch: Partial<TaskSnapshot>) => void } }).uiTest;
    const s = state.snapshot;
    state.change({ nodes: s.nodes.map(node => node.nodeId === 'edit' ? { ...node, status: 'running', attempt: 2, runId: 'run-retry' } : node), runs: [...s.runs, { ...s.runs[1]!, id: 'run-retry', status: 'running', attempt: 2, startedAt: '2026-09-06T09:05:00Z', summary: 'Second attempt in progress' }] });
  });
  await expect(edit.locator('.step-evidence > .run-record')).toHaveAttribute('data-run-id', 'run-retry');
  await expect(edit.locator('.step-evidence > .run-record')).not.toContainText('nextAdapter(input)');
  await expect(tracker.getByRole('progressbar')).toHaveAttribute('value', '1');
  await page.evaluate(() => {
    const state = (window as unknown as { uiTest: { snapshot: TaskSnapshot; change: (patch: Partial<TaskSnapshot>) => void } }).uiTest;
    const s = state.snapshot;
    const plan = { ...s.plan!, id: 'plan-2', taskRevision: 2, revision: 2, nodes: [s.plan!.nodes[1]!] };
    state.change({ task: { ...s.task, revision: 2, activePlanId: plan.id }, plan, plans: [...s.plans, plan], nodes: [{ nodeId: 'edit', status: 'queued', attempt: 0 }] });
  });
  await expect(tracker.getByRole('progressbar')).toHaveAttribute('value', '0');
  await expect(tracker.locator('.tracker-step')).toHaveCount(1);
  await edit.locator(':scope > summary').click();
  await expect(edit.locator('.step-evidence > .run-record')).toHaveCount(0);
  await expect(edit).toContainText('No current attempt output.');
  await edit.locator('.step-history > summary').click();
  await expect(edit.locator('.step-history .run-record')).toHaveCount(2);
  await expect(edit.locator('.step-history')).toContainText('plan-1');
  await expect(edit.locator('.step-history')).toContainText('Keep signature');
  await page.getByRole('button', { name: 'Planning', exact: true }).click();
  await page.getByRole('button', { name: 'Steps', exact: true }).click();
  await page.getByRole('combobox', { name: 'Plan versions', exact: true }).selectOption('plan-1');
  await page.getByRole('button', { name: /Inspect callers.*Historical plan/ }).click();
  await page.getByRole('combobox', { name: 'Plan versions', exact: true }).selectOption('current');
  await expect(page.locator('.removed-step')).toContainText('This step is absent from this plan.');
  await expect(page.locator('.node-detail')).toHaveCount(0);
});

test('opening a current step exits historical planning while manual history survives sidebar toggles', async ({ page }) => {
  await start(page);
  await page.evaluate(() => {
    const state = (window as unknown as { uiTest: { snapshot: TaskSnapshot; change: (patch: Partial<TaskSnapshot>) => void } }).uiTest;
    const s = state.snapshot;
    const old = { ...s.plan!, id: 'plan-old', revision: 0, nodes: s.plan!.nodes.map(node => node.id === 'edit' ? { ...node, goal: 'Historical goal with a different contract.' } : node) };
    state.change({ plans: [old, ...s.plans] });
  });
  await page.getByRole('button', { name: 'Planning', exact: true }).click();
  await page.getByRole('button', { name: 'Steps', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Planning', exact: true });
  const versions = panel.getByRole('combobox', { name: 'Plan versions', exact: true });
  await versions.selectOption('plan-old');
  await panel.getByRole('button', { name: /Update the adapter.*Historical plan/ }).click();
  await expect(panel.locator('.node-detail')).toContainText('Historical goal with a different contract.');
  await page.getByRole('button', { name: 'Close planning', exact: true }).click();
  await page.getByRole('button', { name: 'Planning', exact: true }).click();
  await expect(versions).toHaveValue('plan-old');
  const step = page.locator('.plan-tracker [data-node-id="edit"]');
  await step.locator(':scope > summary').click();
  await step.getByRole('button', { name: 'Open in planning', exact: true }).click();
  await expect(versions).toHaveValue('current');
  await expect(panel.locator('.node-detail')).toContainText('Preserve exported signatures.');
  await expect(panel.locator('.node-detail > .detail-content > dl')).not.toContainText('Historical goal with a different contract.');
  await versions.selectOption('plan-old');
  await expect(panel.locator('.node-detail')).toContainText('Historical goal with a different contract.');
  await page.getByRole('button', { name: /Upgrade the adapter.*Executing/ }).click();
  await expect(versions).toHaveValue('current');
});

test('activity links only current plan events and labels same-ID historical events without navigation', async ({ page }) => {
  await start(page);
  await page.evaluate(() => {
    const state = (window as unknown as { uiTest: { snapshot: TaskSnapshot; change: (patch: Partial<TaskSnapshot>) => void } }).uiTest;
    const s = state.snapshot;
    const old = { ...s.plan!, id: 'plan-old', revision: 0, nodes: s.plan!.nodes.map(node => node.id === 'edit' ? { ...node, title: 'Retired adapter step', goal: 'Historical adapter contract.' } : node) };
    const base = { taskId: s.task.id, taskRevision: 1, nodeId: 'edit', kind: 'tool.finished', createdAt: '2026-09-06T09:00:00Z' };
    state.change({ plans: [old, ...s.plans], runs: [...s.runs, { ...s.runs[1]!, id: 'run-old', planId: old.id, status: 'succeeded' }], events: [
      { ...base, id: 'old-explicit', seq: 3, planId: old.id, runId: 'run-old', text: 'Historical adapter output.' },
      { ...base, id: 'old-run-bound', seq: 4, runId: 'run-old', text: 'Historical event bound through its run.' },
      { ...base, id: 'current-event', seq: 5, planId: 'plan-1', runId: 'run-2', text: 'Current adapter output.' },
    ] });
  });
  await page.getByRole('button', { name: 'Activity', exact: true }).click();
  for (const text of ['Historical adapter output.', 'Historical event bound through its run.']) {
    const event = page.locator('.event-row').filter({ has: page.locator('.event-copy', { hasText: text }) });
    await event.locator(':scope > summary').click();
    await expect(event.locator('.event-footer')).toContainText('Historical · Retired adapter step');
    await expect(event.locator('.event-footer button')).toHaveCount(0);
  }
  await expect(page.getByRole('complementary', { name: 'Planning', exact: true })).toHaveCount(0);
  const current = page.locator('.event-row').filter({ has: page.locator('.event-copy', { hasText: 'Current adapter output.' }) });
  await current.locator(':scope > summary').click();
  await current.getByRole('button', { name: 'Update the adapter', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Planning', exact: true });
  await expect(panel.getByRole('combobox', { name: 'Plan versions', exact: true })).toHaveValue('current');
  await expect(panel.locator('.node-detail')).toContainText('Preserve exported signatures.');
  await expect(panel.locator('.node-detail > .detail-content > dl')).not.toContainText('Historical adapter contract.');
  await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('zh-CN');
  await expect(page.locator('.event-footer').filter({ hasText: '历史记录 · Retired adapter step' })).toHaveCount(2);
});
