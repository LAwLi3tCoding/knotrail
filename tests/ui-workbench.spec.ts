import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import type { AppCommand, Bootstrap, TaskSnapshot } from '../src/shared/contracts';

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
    const preferences: Record<string, unknown> = {};
    const notify = () => listeners.forEach(listener => listener({ taskId: data.task.id, kind: 'changed' }));
    Object.assign(window, { uiTest: {
      commands,
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
            case 'task.previewRevision': return { id: 'impact-fixture', taskId: data.task.id, expectedRevision: data.task.revision, expectedPlanId: data.plan?.id, workspaceDigest: 'workspace', objective: command.objective, affected: ['edit', 'verify'], retained: ['research'], reason: 'Legacy configuration support changes adapter and checks.' };
            case 'task.previewRetry': return { id: 'retry-fixture', taskId: data.task.id, expectedRevision: data.task.revision, expectedPlanId: data.plan?.id, workspaceDigest: 'workspace', nodeId: command.nodeId, affected: [command.nodeId], retained: [], reason: 'The selected step must run again.' };
            case 'task.applyImpact': data.task.revision++; if (command.preview.objective) data.task.objective = command.preview.objective; data.lastSequence++; notify(); return data;
            case 'task.inspectEffects': {
              data.decisions.push({ id: 'terminal-recovery', kind: 'recovery', taskId: data.task.id, taskRevision: data.task.revision, planId: data.plan?.id, question: 'Inspect unknown terminal effects.', options: ['preserve-and-stop'], recovery: { actionIds: ['action-1'], actionsDigest: 'actions-digest', workspaceDigest: 'workspace-digest', artifactId: 'artifact-1', terminalStatus: 'cancelled' }, createdAt });
              data.lastSequence++; notify(); return data;
            }
            case 'decision.answer': { const decision = data.decisions.find(item => item.id === command.decisionId); if (decision) decision.answer = command.answer; data.task.status = decision?.recovery?.terminalStatus ?? 'executing'; data.lastSequence++; notify(); return data; }
            case 'task.files': return { files: ['src/adapter.ts', 'README.md'] };
            case 'task.readFile': return { content: 'export const adapter = "safe";', truncated: false };
            case 'model.check': return { ok: true, message: 'Connection passed' };
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
