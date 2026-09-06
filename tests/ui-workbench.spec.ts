import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import type { AppCommand, Bootstrap, ImpactPreview, TaskSnapshot } from '../src/shared/contracts';

// This suite verifies the real renderer against a deterministic IPC bridge.
// Runtime, sandbox, model calls, and persistence are exercised by separate integration tests.
const appDirectory = dirname(resolve(process.env.KNOTRAIL_UI_PATH ?? 'dist/renderer/index.html'));
const appUrl = 'https://knotrail.test/index.html';
const now = '2026-09-06T09:00:00.000Z';
// String declarations intentionally represent historical plans; new-plan validation is tested in Core.
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

async function start(page: Page, selectExisting = true) {
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
    const priorSnapshots: Record<string, TaskSnapshot> = {};
    const preferences: Record<string, unknown> = {};
    const notify = () => listeners.forEach(listener => listener({ taskId: data.task.id, kind: 'changed' }));
    Object.assign(window, { uiTest: {
      commands,
      previews,
      change: (patch: Partial<TaskSnapshot>) => { Object.assign(data, patch); data.lastSequence++; boot.tasks = boot.tasks.map(task => task.id === data.task.id ? data.task : task); notify(); },
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
            case 'task.snapshot': return command.taskId === data.task.id ? data : priorSnapshots[command.taskId];
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
            case 'task.message': {
              if (data.task.interaction !== 'conversation' || command.taskId !== data.task.id || command.expectedRevision !== data.task.revision) throw new Error('Conversation changed');
              data.task.revision++; data.task.objective = command.text; data.task.status = 'planning'; data.task.turnBudgetStart = data.task.turnCount;
              data.task.revisionHistory.push({ revision: data.task.revision, objective: command.text, checks: structuredClone(data.task.checks), createdAt });
              data.task.activePlanId = undefined; data.task.error = undefined; data.plan = undefined; data.nodes = [];
              data.events.push({ id: `message-${data.task.revision}`, seq: ++data.lastSequence, taskId: data.task.id, taskRevision: data.task.revision, kind: 'user.message', text: command.text, createdAt });
              notify(); return data;
            }
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
            case 'task.create': {
              priorSnapshots[data.task.id] = structuredClone(data);
              const taskId = `task-${boot.tasks.length + 1}`;
              data.task = { ...data.task, id: taskId, projectId: command.projectId, title: command.objective.split('\n')[0]!.slice(0, 100), objective: command.objective, interaction: command.interaction, checks: command.checks, mode: command.mode, executionPolicy: command.executionPolicy, status: 'planning', revision: 1, activePlanId: undefined, intervalMinutes: command.intervalMinutes, expiresAt: command.expiresAt, turnCount: 0, turnBudgetStart: 0, maxTurns: command.maxTurns ?? 40, maxRunMs: command.maxRunMs ?? 900000, revisionHistory: [{ revision: 1, objective: command.objective, checks: structuredClone(command.checks), createdAt }] };
              Object.assign(data, { plan: undefined, plans: [], nodes: [], runs: [], checks: [], actions: [], artifacts: [], decisions: [], events: [{ id: `created-${taskId}`, seq: 1, taskId, taskRevision: 1, kind: 'task.created', text: command.objective, createdAt }], lastSequence: 1 });
              boot.tasks = [data.task, ...boot.tasks]; notify(); return data;
            }
            case 'project.add': return boot.projects[0];
            default: return { ok: true };
          }
        })();
        return structuredClone(result) as T;
      },
    };
  }, { snapshot: fixture, createdAt: now });
  await page.goto(appUrl);
  if (selectExisting) {
    await page.getByRole('button', { name: /Upgrade the adapter/ }).click();
    await expect(page.getByRole('heading', { name: 'Upgrade the adapter' })).toBeVisible();
  } else await expect(page.getByRole('heading', { name: 'New conversation', exact: true })).toBeVisible();
}

async function startConversation(page: Page) {
  await start(page, false);
  await page.getByLabel('Message', { exact: true }).fill('Explain the adapter lifecycle.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Message…', exact: true })).toBeVisible();
}

async function finishConversationRound(page: Page, response: string) {
  await page.evaluate(response => {
    const state = (window as unknown as { uiTest: { snapshot: TaskSnapshot; change: (patch: Partial<TaskSnapshot>) => void } }).uiTest;
    const s = state.snapshot, revision = s.task.revision, runId = `conversation-run-${revision}`;
    const plan: NonNullable<TaskSnapshot['plan']> = { id: `conversation-plan-${revision}`, revision, taskRevision: revision, sequence: 1, summary: 'Read the project and answer this message.', observations: [], nodes: [{ id: 'respond', title: 'Respond to the message', goal: s.task.objective, kind: 'research', dependsOn: [], inputs: ['src/adapter.ts'], outputs: ['Answer'], checkIds: [] }], createdAt: s.task.updatedAt, digest: `conversation-plan-digest-${revision}` };
    state.change({ task: { ...s.task, status: 'idle', activePlanId: plan.id, turnCount: s.task.turnCount + 2 }, plan, plans: [...s.plans, plan], nodes: [{ nodeId: 'respond', status: 'finished', attempt: 1, runId }], runs: [...s.runs, { id: runId, taskId: s.task.id, taskRevision: revision, planId: plan.id, nodeId: 'respond', purpose: 'node', attempt: 1, status: 'succeeded', summary: response, inputDigest: 'conversation-input', startedAt: s.task.updatedAt, endedAt: s.task.updatedAt }], events: [...s.events, { id: `response-${revision}`, seq: s.lastSequence + 1, taskId: s.task.id, taskRevision: revision, planId: plan.id, nodeId: 'respond', runId, kind: 'assistant.response', text: response, createdAt: s.task.updatedAt }] });
  }, response);
  await expect(page.locator('.titlebar .status')).toHaveText('Ready for next message');
}

async function showInputEvidence(page: Page) {
  await start(page);
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  const plans = [1, 2].map(revision => ({ ...fixture.plan!, id: `typed-plan-${revision}`, revision, taskRevision: revision, nodes: [
    { id: 'research', title: 'Capture the inventory', goal: 'Record a stable caller inventory.', kind: 'research' as const, dependsOn: [], inputs: [{ kind: 'file' as const, path: `docs/input-v${revision}.txt`, expect: 'present' as const }], outputs: [{ id: 'inventory', kind: 'file' as const, path: 'build/inventory.json', expect: 'present' as const }, { id: 'summary' as const, kind: 'text' as const }], checkIds: [] },
    { id: 'edit', title: 'Use the fixed inventory', goal: 'Use the recorded upstream output.', kind: 'edit' as const, dependsOn: ['research'], inputs: [{ kind: 'artifact' as const, nodeId: 'research', outputId: 'inventory' }, { kind: 'file' as const, path: `config-v${revision}.json`, expect: 'present' as const }, { kind: 'file' as const, path: 'obsolete.json', expect: 'absent' as const }, { kind: 'file' as const, path: 'private-settings.txt', expect: 'present' as const }, { kind: 'file' as const, path: 'empty.txt', expect: 'present' as const }], outputs: [{ id: 'adapter', kind: 'file' as const, path: 'src/adapter.ts', expect: 'present' as const }, { id: 'summary' as const, kind: 'text' as const }], checkIds: [] },
  ] }));
  const artifacts: TaskSnapshot['artifacts'] = ['before', 'current'].map(version => {
    const content = version === 'before' ? 'Original caller inventory from the earlier run.' : 'Revised caller inventory from the current run.';
    return { id: `inventory-${version}`, taskId: 'task-1', nodeId: 'research', runId: `producer-${version}`, outputId: 'inventory', kind: 'file', name: 'build/inventory.json', content, truncated: false, redacted: false, digest: hash(content), source: { path: 'build/inventory.json', exists: true, sourceDigest: hash(content), sourceIdentity: `inventory-source-${version}`, mode: 0o644 }, createdAt: now };
  });
  const outputContent = 'export const adapter = "recorded";';
  artifacts.push({ id: 'adapter-current', taskId: 'task-1', nodeId: 'edit', runId: 'consumer-current', outputId: 'adapter', kind: 'file', name: 'src/adapter.ts', content: outputContent, truncated: false, redacted: false, digest: hash(outputContent), source: { path: 'src/adapter.ts', exists: true, sourceDigest: hash(outputContent), sourceIdentity: 'adapter-source-current', mode: 0o644 }, createdAt: now });
  const runs: TaskSnapshot['runs'] = ['before', 'current'].flatMap((version, index) => {
    const artifact = artifacts[index]!, revision = index + 1, config = `Configuration version ${revision}.`, redacted = 'setting=[REDACTED]';
    const base = { taskId: 'task-1', taskRevision: revision, planId: plans[index]!.id, purpose: 'node' as const, attempt: 1, startedAt: now, inputDigest: `run-input-${version}` };
    return [
      { ...base, id: `producer-${version}`, nodeId: 'research', status: 'succeeded' as const, endedAt: now, summary: artifact.content, inputCoverage: 'declared' as const, inputBindings: [], reads: [] },
      { ...base, id: `consumer-${version}`, nodeId: 'edit', status: version === 'current' ? 'running' as const : 'succeeded' as const, inputCoverage: 'unknown' as const, inputBindings: [
        { ref: { kind: 'artifact' as const, nodeId: 'research', outputId: 'inventory' }, artifactId: artifact.id, producerRunId: artifact.runId, source: artifact.source, digest: artifact.digest, content: artifact.content, redacted: false, deliveredRanges: [{ start: 0, end: 10 }, { start: 10, end: artifact.content.length }] },
        { ref: { kind: 'file' as const, path: `config-v${revision}.json`, expect: 'present' as const }, source: { path: `config-v${revision}.json`, exists: true, sourceDigest: hash(config), sourceIdentity: `config-source-${version}` }, digest: hash(config), content: config, redacted: false, deliveredRanges: [{ start: 0, end: 3 }, { start: 7, end: config.length }] },
        { ref: { kind: 'file' as const, path: 'obsolete.json', expect: 'absent' as const }, source: { path: 'obsolete.json', exists: false, sourceDigest: null, sourceIdentity: 'missing-source' }, digest: hash(''), content: '', redacted: false, deliveredRanges: [] },
        { ref: { kind: 'file' as const, path: 'private-settings.txt', expect: 'present' as const }, source: { path: 'private-settings.txt', exists: true, sourceDigest: hash('setting=original omitted value'), sourceIdentity: 'redacted-source' }, digest: hash(redacted), content: redacted, redacted: true, deliveredRanges: [{ start: 0, end: redacted.length }] },
        { ref: { kind: 'file' as const, path: 'empty.txt', expect: 'present' as const }, source: { path: 'empty.txt', exists: true, sourceDigest: hash(''), sourceIdentity: 'empty-source' }, digest: hash(''), content: '', redacted: false, deliveredRanges: [] },
      ], reads: [{ path: `config-v${revision}.json`, sourceDigest: hash(config), complete: false }, { path: 'build/inventory.json', sourceDigest: artifact.source!.sourceDigest!, complete: true }] },
    ];
  });
  await page.evaluate(({ plans, artifacts, runs }) => {
    const state = (window as unknown as { uiTest: { snapshot: TaskSnapshot; change: (patch: Partial<TaskSnapshot>) => void } }).uiTest;
    state.change({ task: { ...state.snapshot.task, interaction: 'conversation', revision: 2, activePlanId: plans[1]!.id, status: 'executing', checks: [] }, plan: plans[1], plans, artifacts, runs, nodes: [{ nodeId: 'research', status: 'finished', attempt: 1, runId: 'producer-current' }, { nodeId: 'edit', status: 'running', attempt: 1, runId: 'consumer-current' }], checks: [], actions: [] });
  }, { plans, artifacts, runs });
  await expect(page.locator('.plan-tracker [data-node-id="research"] .step-progress')).toHaveText('Finished');
}

async function delayRevisionResponses(page: Page, commandType: 'task.previewRevision' | 'task.applyImpact' | 'task.message' | 'task.create' = 'task.previewRevision') {
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
  await page.locator('.advanced-options > summary').click();
  await page.getByLabel('Interaction', { exact: true }).selectOption('task');
  await page.getByLabel('Objective', { exact: true }).fill('Implement the missing validation.');
  await page.getByRole('button', { name: 'Add check' }).click();
  await page.getByLabel('Command argv (JSON array)').fill('["npm", "test", "--", "api"]');
  await page.getByLabel('Protected paths (one per line)').fill('test/api.test.ts');
  await page.getByLabel('Execution policy').selectOption('reviewBeforeExecute');
  await page.getByRole('button', { name: 'Create and plan' }).click();
  await expect(page.getByRole('heading', { name: 'Implement the missing validation.' })).toBeVisible();
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

test('the default new page starts a conversation with only a project and message', async ({ page }) => {
  await start(page, false);
  await expect(page.getByLabel('Project', { exact: true })).toHaveValue('project-1');
  await expect(page.locator('.advanced-options')).not.toHaveAttribute('open', '');
  await expect(page.getByLabel('Execution policy')).not.toBeVisible();
  await expect(page.getByLabel('Maximum turns')).not.toBeVisible();
  await page.getByLabel('Message', { exact: true }).fill('Explain the adapter lifecycle.');
  await page.screenshot({ path: test.info().outputPath('new-conversation.png') });
  await page.getByLabel('Message', { exact: true }).press('Enter');
  await expect(page.getByRole('heading', { name: 'Explain the adapter lifecycle.', exact: true })).toBeVisible();
  await expect(page.locator('.conversation [data-event-kind="task.created"]')).toHaveText('Explain the adapter lifecycle.');
  await expect(page.getByRole('textbox', { name: 'Message…', exact: true })).toHaveValue('');
  const commands = await page.evaluate(() => (window as unknown as { uiTest: { commands: AppCommand[] } }).uiTest.commands);
  expect(commands.filter(command => command.type === 'task.create')).toMatchObject([{ interaction: 'conversation', projectId: 'project-1', objective: 'Explain the adapter lifecycle.', mode: 'once', checks: [], executionPolicy: 'autoWithinGrant', maxTurns: 40, maxRunMs: 900000 }]);
  expect(commands.some(command => ['settings.save', 'task.previewRevision', 'task.applyImpact'].includes(command.type))).toBe(false);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.conversation')).not.toContainText('Completion will require your acceptance.');
});

test('a new conversation submits once under rapid Enter and button clicks and retains its draft on failure', async ({ page }) => {
  await start(page, false);
  await delayRevisionResponses(page, 'task.create');
  const message = page.getByLabel('Message', { exact: true });
  await message.fill('Keep this first message if creation fails.');
  await page.locator('.new-task-page form').evaluate(form => {
    const field = form.querySelector('textarea')!;
    const button = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    button.click();
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await expect(page.getByRole('button', { name: 'Working…', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => (window as unknown as { uiTest: { commands: AppCommand[] } }).uiTest.commands.filter(command => command.type === 'task.create'))).toHaveLength(1);
  await page.evaluate(() => (window as unknown as { uiTest: { settleRevision: (index: number, error?: string) => void } }).uiTest.settleRevision(0, 'Could not create conversation'));
  await expect(page.getByRole('alert')).toContainText('Could not create conversation');
  await expect(message).toHaveValue('Keep this first message if creation fails.');
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
});

for (const outcome of ['success', 'failure'] as const) test(`a late conversation creation ${outcome} cannot replace a reopened new-page draft`, async ({ page }) => {
  await start(page, false);
  await delayRevisionResponses(page, 'task.create');
  await page.getByLabel('Message', { exact: true }).fill('First creation');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  await page.getByLabel('Message', { exact: true }).fill('Keep the newly opened draft');
  await page.evaluate(outcome => (window as unknown as { uiTest: { settleRevision: (index: number, error?: string) => void } }).uiTest.settleRevision(0, outcome === 'failure' ? 'Earlier creation failed' : undefined), outcome);
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Keep the newly opened draft');
  await expect(page.getByRole('heading', { name: 'New conversation', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('a conversation retains messages and plans across rounds, displays finished steps without claiming verification, and remains open', async ({ page }) => {
  await startConversation(page);
  await finishConversationRound(page, 'The adapter normalizes the input before calling the service.');
  await expect(page.getByRole('progressbar', { name: 'Finished steps', exact: true })).toHaveAttribute('value', '1');
  await expect(page.locator('.plan-tracker .section-heading')).toContainText('1 / 1 Finished steps · 0 Verified');
  await expect(page.locator('.tracker-step .step-progress')).toHaveText('Finished');
  await expect(page.locator('.titlebar .status')).toHaveClass(/status-idle/);
  await expect(page.getByRole('button', { name: 'Accept result', exact: true })).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Message…', exact: true }).fill('Which tests cover this behavior?');
  await page.getByRole('textbox', { name: 'Message…', exact: true }).press('Enter');
  await expect(page.getByRole('textbox', { name: 'Message…', exact: true })).toHaveValue('');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.conversation [data-event-kind="user.message"] p')).toHaveText('Which tests cover this behavior?');
  await finishConversationRound(page, 'The adapter tests exercise valid input and rejected input.');
  await expect(page.locator('.conversation > [data-event-kind]')).toHaveText(['Explain the adapter lifecycle.', /The adapter normalizes the input before calling the service\./, /Which tests cover this behavior\?/, /The adapter tests exercise valid input and rejected input\./]);
  await page.locator('.composer-footer > details > summary').click();
  await expect(page.locator('.composer-footer dd').nth(0)).toHaveText('2 / 40');
  await expect(page.locator('.composer-footer dd').nth(1)).toHaveText('4');
  await page.getByRole('button', { name: 'Planning', exact: true }).click();
  const planning = page.getByRole('complementary', { name: 'Planning', exact: true });
  await planning.getByRole('button', { name: 'Steps', exact: true }).click();
  await expect(planning.getByRole('button', { name: /Respond to the message.*Finished/ })).toBeVisible();
  await planning.getByLabel('Plan versions').selectOption('conversation-plan-1');
  await expect(planning).toContainText('Historical plan');
  await page.getByRole('button', { name: 'Close planning', exact: true }).click();
  const state = await page.evaluate(() => (window as unknown as { uiTest: { snapshot: TaskSnapshot; commands: AppCommand[] } }).uiTest);
  expect(state.snapshot.plans).toHaveLength(2);
  expect(state.snapshot.task.revisionHistory).toHaveLength(2);
  expect(state.snapshot.task.status).toBe('idle');
  expect(state.snapshot.task.acceptedDigest).toBeUndefined();
  expect(state.commands.filter(command => command.type === 'task.create')).toHaveLength(1);
  expect(state.commands.filter(command => command.type === 'task.message')).toMatchObject([{ taskId: state.snapshot.task.id, expectedRevision: 1, text: 'Which tests cover this behavior?' }]);
  expect(state.commands.some(command => command.type === 'task.previewRevision' || command.type === 'task.applyImpact')).toBe(false);
  await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('zh-CN');
  await expect(page.locator('.titlebar .status')).toHaveText('等待下一条消息');
  await expect(page.locator('.tracker-step .step-progress')).toHaveText('已结束');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.sidebar').getByRole('button', { name: '收起导航', exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: test.info().outputPath('conversation-zh-narrow.png') });
});

for (const readingHistory of [false, true]) test(`conversation streaming ${readingHistory ? 'respects an intentional upward scroll' : 'keeps the newest answer in the scroll viewport after replanning'}`, async ({ page }) => {
  await startConversation(page);
  await page.getByRole('button', { name: 'Planning', exact: true }).click();
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  await page.evaluate(() => {
    const state = (window as unknown as { uiTest: { snapshot: TaskSnapshot; change: (patch: Partial<TaskSnapshot>) => void } }).uiTest, s = state.snapshot;
    state.change({ events: [...s.events, ...['Inspecting the current value before planning.', 'I will read the value and explain it.', 'Planning complete; the execution policy determines when work starts'].map((text, index) => ({ id: `intro-${index}`, taskId: s.task.id, taskRevision: 1, seq: s.lastSequence + index + 1, kind: index === 2 ? 'plan.ready' : 'assistant.delta', runId: `intro-run-${index}`, text, createdAt: s.task.updatedAt }))], artifacts: [{ id: 'conversation-diff', taskId: s.task.id, runId: 'conversation-run-1', kind: 'diff', name: 'Workspace diff', content: '', digest: 'unchanged-files', truncated: false, createdAt: s.task.updatedAt }] });
  });
  await finishConversationRound(page, 'The adapter returns the validated service response.');
  const scroll = page.locator('.main-scroll');
  await scroll.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect.poll(() => scroll.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThanOrEqual(1);
  await page.evaluate(() => {
    const original = window.knotrail.command;
    window.knotrail.command = async <T,>(command: AppCommand): Promise<T> => {
      // Real IPC replies arrive in a later browser task, after the click has painted.
      if (command.type === 'task.message') await new Promise(resolve => setTimeout(resolve, 30));
      return original<T>(command);
    };
  });
  await page.getByRole('textbox', { name: 'Message…', exact: true }).fill('Continue with the error path.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('.plan-tracker')).toHaveCount(0);
  await page.evaluate(() => {
    const state = (window as unknown as { uiTest: { snapshot: TaskSnapshot; change: (patch: Partial<TaskSnapshot>) => void } }).uiTest;
    const s = state.snapshot, plan = { ...s.plans[0]!, id: 'streaming-plan', taskRevision: s.task.revision, revision: 2, summary: 'Inspect the error path and explain the result.' };
    state.change({ task: { ...s.task, status: 'executing', activePlanId: plan.id }, plan, plans: [...s.plans, plan], nodes: [{ nodeId: 'respond', status: 'running', attempt: 1, runId: 'streaming-run' }] });
  });
  await expect(page.locator('.plan-tracker')).toBeVisible();
  let historyPosition = 0;
  for (let index = 0; index < 4; index++) {
    await page.evaluate(index => {
      const state = (window as unknown as { uiTest: { snapshot: TaskSnapshot; change: (patch: Partial<TaskSnapshot>) => void } }).uiTest;
      const s = state.snapshot;
      state.change({ events: [...s.events, { id: `stream-${index}`, taskId: s.task.id, taskRevision: s.task.revision, planId: s.plan!.id, seq: s.lastSequence + 1, kind: 'assistant.delta', text: `Stream section ${index + 1}.\n${'Inspecting the service error and its caller.\n'.repeat(8)}`, createdAt: s.task.updatedAt, runId: 'streaming-run', nodeId: 'respond' }] });
    }, index);
    await expect(page.locator('[data-event-kind="assistant.delta"] p').last()).toContainText(`Stream section ${index + 1}.`);
    if (readingHistory && index === 0) {
      await scroll.hover();
      await page.mouse.wheel(0, -500);
      await expect.poll(() => scroll.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeGreaterThan(100);
      historyPosition = await scroll.evaluate(element => element.scrollTop);
    }
  }
  await finishConversationRound(page, 'The final answer explains the error path without changing the file.');
  const answer = page.locator('[data-event-kind="assistant.response"]').last();
  if (readingHistory) {
    await expect(answer).not.toBeInViewport();
    await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBeLessThanOrEqual(historyPosition + 2);
  } else {
    await expect(answer).toBeInViewport({ ratio: 1 });
    const bounds = await answer.evaluate(element => { const viewport = element.closest('.main-scroll')!.getBoundingClientRect(), response = element.getBoundingClientRect(); return { top: response.top - viewport.top, bottom: response.bottom - viewport.bottom }; });
    expect(bounds.top).toBeGreaterThanOrEqual(0);
    expect(bounds.bottom).toBeLessThanOrEqual(0);
  }
});

test('conversation sends preserve newer drafts, ignore duplicate submissions and respect newline and IME input', async ({ page }) => {
  await startConversation(page);
  await delayRevisionResponses(page, 'task.message');
  const composer = page.getByRole('textbox', { name: 'Message…', exact: true });
  await composer.fill('First line');
  await composer.press('Shift+Enter');
  await composer.pressSequentially('Second line');
  await expect(composer).toHaveValue('First line\nSecond line');
  await composer.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
  await composer.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229 });
  await composer.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', repeat: true });
  expect(await page.evaluate(() => (window as unknown as { uiTest: { commands: AppCommand[] } }).uiTest.commands.filter(command => command.type === 'task.message'))).toHaveLength(0);
  await composer.press('Enter');
  await composer.fill('Keep this newer draft');
  await composer.press('Enter');
  await composer.press('Control+Enter');
  expect(await page.evaluate(() => (window as unknown as { uiTest: { commands: AppCommand[] } }).uiTest.commands.filter(command => command.type === 'task.message'))).toHaveLength(1);
  await page.evaluate(() => (window as unknown as { uiTest: { settleRevision: (index: number) => void } }).uiTest.settleRevision(0));
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
  await expect(composer).toHaveValue('Keep this newer draft');
  await composer.press('Control+Enter');
  await page.evaluate(() => (window as unknown as { uiTest: { settleRevision: (index: number) => void } }).uiTest.settleRevision(1));
  await expect(composer).toHaveValue('');
  const state = await page.evaluate(() => (window as unknown as { uiTest: { snapshot: TaskSnapshot; commands: AppCommand[] } }).uiTest);
  expect(state.commands.filter(command => command.type === 'task.message')).toMatchObject([{ expectedRevision: 1, text: 'First line\nSecond line' }, { expectedRevision: 2, text: 'Keep this newer draft' }]);
  expect(state.snapshot.events.filter(event => event.kind === 'user.message')).toHaveLength(2);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('late conversation snapshots preserve newer status in both the conversation and sidebar', async ({ page }) => {
  await startConversation(page);
  await delayRevisionResponses(page, 'task.message');
  const composer = page.getByRole('textbox', { name: 'Message…', exact: true });
  await composer.fill('Explain the error path too.');
  await composer.press('Enter');
  await finishConversationRound(page, 'The service errors are returned to the caller.');
  const sidebarTask = page.locator('.task-row').filter({ hasText: 'Explain the adapter lifecycle.' });
  await expect(sidebarTask).toContainText('Ready for next message');
  await composer.fill('Keep the next question');
  await page.evaluate(() => (window as unknown as { uiTest: { settleRevision: (index: number) => void } }).uiTest.settleRevision(0));
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
  await expect(page.locator('.titlebar .status')).toHaveText('Ready for next message');
  await expect(sidebarTask).toContainText('Ready for next message');
  await expect(composer).toHaveValue('Keep the next question');
  await expect(page.locator('.conversation [data-event-kind="assistant.response"] p')).toHaveText('The service errors are returned to the caller.');
});

for (const delayed of ['preferences.get', 'task.snapshot'] as const) test(`a selected conversation snapshot delayed by ${delayed} cannot undo a same-sequence acceptance preview pause`, async ({ page }) => {
  await startConversation(page);
  await finishConversationRound(page, 'Original response');
  await page.getByRole('button', { name: /Upgrade the adapter/ }).click();
  await expect(page.getByRole('heading', { name: 'Upgrade the adapter', exact: true })).toBeVisible();
  await page.evaluate(delayed => {
    const state = (window as unknown as { uiTest: { snapshot: TaskSnapshot; readHeld?: boolean; releaseRead?: () => void; readReturned?: boolean } }).uiTest;
    const original = window.knotrail.command; let hold = true;
    window.knotrail.command = async <T,>(command: AppCommand): Promise<T> => {
      const result = await original<T>(command);
      if (command.type === 'task.previewRevision') state.snapshot.lastSequence--;
      if (command.type === delayed && command.taskId === state.snapshot.task.id && hold) {
        if (delayed === 'preferences.get') Object.assign(result as object, { draft: 'Loaded preference marker' });
        hold = false; state.readHeld = true;
        await new Promise<void>(resolve => { state.releaseRead = resolve; });
        state.readReturned = true;
      }
      return result;
    };
  }, delayed);
  await page.getByRole('button', { name: /Explain the adapter lifecycle/ }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { uiTest: { readHeld?: boolean } }).uiTest.readHeld)).toBe(true);
  await page.evaluate(() => window.knotrail.command({ type: 'settings.save', patch: { locale: 'en' } }));
  await expect(page.locator('.titlebar .status')).toHaveText('Ready for next message');
  await page.getByRole('button', { name: 'Edit checks', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Edit checks', exact: true });
  await editor.getByRole('button', { name: 'Add check', exact: true }).click();
  await editor.getByLabel('Command argv (JSON array)').fill('["node","check.mjs"]');
  await editor.getByRole('button', { name: 'Preview impact', exact: true }).click();
  await expect(page.locator('.titlebar .status')).toHaveText('Paused');
  await page.getByRole('dialog', { name: 'Review impact', exact: true }).getByRole('button', { name: 'Dismiss', exact: true }).click();
  await page.evaluate(async () => {
    (window as unknown as { uiTest: { releaseRead: () => void } }).uiTest.releaseRead();
    await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
  });
  if (delayed === 'preferences.get') await expect(page.getByRole('textbox', { name: 'Message…', exact: true })).toHaveValue('Loaded preference marker');
  await expect.poll(() => page.evaluate(() => (window as unknown as { uiTest: { readReturned?: boolean } }).uiTest.readReturned)).toBe(true);
  await expect(page.locator('.titlebar .status')).toHaveText('Paused');
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
  await expect(page.locator('.task-row').filter({ hasText: 'Explain the adapter lifecycle.' })).toContainText('Paused');
});

test('a delayed refresh snapshot cannot undo a newer same-sequence pause response', async ({ page }) => {
  await startConversation(page);
  await page.evaluate(() => {
    const state = (window as unknown as { uiTest: { snapshot: TaskSnapshot; commands: AppCommand[]; readHeld?: boolean; releaseRead?: () => void } }).uiTest;
    const original = window.knotrail.command; let hold = true;
    window.knotrail.command = async <T,>(command: AppCommand): Promise<T> => {
      if (command.type === 'task.pause') { state.commands.push(command); state.snapshot.task.status = 'paused'; return structuredClone(state.snapshot) as T; }
      const result = await original<T>(command);
      if (command.type === 'task.snapshot' && hold) { hold = false; state.readHeld = true; await new Promise<void>(resolve => { state.releaseRead = resolve; }); }
      return result;
    };
  });
  await page.evaluate(() => window.knotrail.command({ type: 'settings.save', patch: { locale: 'en' } }));
  await expect.poll(() => page.evaluate(() => (window as unknown as { uiTest: { readHeld?: boolean } }).uiTest.readHeld)).toBe(true);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.locator('.titlebar .status')).toHaveText('Paused');
  await page.evaluate(async () => {
    (window as unknown as { uiTest: { releaseRead: () => void } }).uiTest.releaseRead();
    await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
  });
  await expect(page.locator('.titlebar .status')).toHaveText('Paused');
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
  await expect(page.locator('.task-row').filter({ hasText: 'Explain the adapter lifecycle.' })).toContainText('Paused');
});

for (const update of ['notification', 'command'] as const) test(`a late bootstrap cannot replace a newer conversation ${update} after switching tasks`, async ({ page }) => {
  await startConversation(page);
  await page.evaluate(() => {
    const state = (window as unknown as { uiTest: { snapshot: TaskSnapshot; change: (patch: Partial<TaskSnapshot>) => void } }).uiTest;
    state.change({ task: { ...state.snapshot.task, status: 'executing' } });
  });
  await expect(page.locator('.titlebar .status')).toHaveText('Executing');
  await page.evaluate(() => {
    const original = window.knotrail.command;
    const state = (window as unknown as { uiTest: { snapshot: TaskSnapshot; commands: AppCommand[]; bootstrapHeld?: boolean; releaseBootstrap?: () => void } }).uiTest;
    let hold = true;
    window.knotrail.command = async <T,>(command: AppCommand): Promise<T> => {
      // A Store.update without an event can return a changed task at the same lastSequence.
      if (command.type === 'task.pause') { state.commands.push(command); state.snapshot.task.status = 'paused'; return structuredClone(state.snapshot) as T; }
      const result = await original<T>(command);
      if (command.type === 'bootstrap' && hold) { hold = false; state.bootstrapHeld = true; await new Promise<void>(resolve => { state.releaseBootstrap = resolve; }); }
      return result;
    };
  });
  await page.getByRole('button', { name: 'Add project', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { uiTest: { bootstrapHeld?: boolean } }).uiTest.bootstrapHeld)).toBe(true);
  if (update === 'notification') await page.evaluate(() => {
    const state = (window as unknown as { uiTest: { snapshot: TaskSnapshot; change: (patch: Partial<TaskSnapshot>) => void } }).uiTest;
    state.change({ task: { ...state.snapshot.task, status: 'blocked', error: 'Current response failed.' } });
  });
  else await page.getByRole('button', { name: 'Pause', exact: true }).click();
  const expected = update === 'notification' ? 'Blocked' : 'Paused';
  await expect(page.locator('.titlebar .status')).toHaveText(expected);
  const sidebar = page.locator('.task-row').filter({ hasText: 'Explain the adapter lifecycle.' });
  await expect(sidebar).toContainText(expected);
  await page.getByRole('button', { name: /Upgrade the adapter/ }).click();
  await expect(page.getByRole('heading', { name: 'Upgrade the adapter', exact: true })).toBeVisible();
  await page.evaluate(() => (window as unknown as { uiTest: { releaseBootstrap: () => void } }).uiTest.releaseBootstrap());
  await expect(page.getByRole('heading', { name: 'New conversation', exact: true })).toBeVisible();
  await expect(sidebar).toContainText(expected);
});

test('late conversation preference loading preserves new edits and restores untouched saved preferences', async ({ page }) => {
  await startConversation(page);
  await finishConversationRound(page, 'First response is complete.');
  await page.getByRole('button', { name: /Upgrade the adapter/ }).click();
  await expect(page.getByRole('heading', { name: 'Upgrade the adapter', exact: true })).toBeVisible();
  await page.evaluate(async () => {
    const state = (window as unknown as { uiTest: { snapshot: TaskSnapshot; preferencesHeld?: boolean; releasePreferences?: () => void } }).uiTest;
    await window.knotrail.command({ type: 'preferences.save', taskId: state.snapshot.task.id, value: { draft: 'Saved older draft', toolPanel: 'terminal', mainView: 'chat', panelView: 'process', detailTab: 'overview', graphView: 'graph' } });
    const original = window.knotrail.command; let hold = true;
    window.knotrail.command = async <T,>(command: AppCommand): Promise<T> => {
      const result = await original<T>(command);
      if (command.type === 'preferences.get' && command.taskId === state.snapshot.task.id && hold) { hold = false; state.preferencesHeld = true; await new Promise<void>(resolve => { state.releasePreferences = resolve; }); }
      return result;
    };
  });
  await page.getByRole('button', { name: /Explain the adapter lifecycle/ }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { uiTest: { preferencesHeld?: boolean } }).uiTest.preferencesHeld)).toBe(true);
  await page.evaluate(() => {
    const state = (window as unknown as { uiTest: { snapshot: TaskSnapshot; change: (patch: Partial<TaskSnapshot>) => void } }).uiTest;
    state.change({ task: { ...state.snapshot.task, status: 'idle' } });
  });
  const composer = page.getByRole('textbox', { name: 'Message…', exact: true });
  await composer.fill('Important unsent conversation draft');
  await page.evaluate(() => (window as unknown as { uiTest: { releasePreferences: () => void } }).uiTest.releasePreferences());
  await expect(composer).toHaveValue('Important unsent conversation draft');
  await expect(page.locator('.tool-toggles').getByRole('button', { name: 'Terminal', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.evaluate(async () => {
    const state = (window as unknown as { uiTest: { snapshot: TaskSnapshot } }).uiTest;
    return window.knotrail.command({ type: 'preferences.get', taskId: state.snapshot.task.id });
  })).toMatchObject({ draft: 'Important unsent conversation draft', toolPanel: 'terminal' });
});

for (const editWhileLoading of [false, true]) test(`leaving a loading conversation ${editWhileLoading ? 'merges its edits into its own saved preferences' : 'does not replace unread saved preferences with defaults'}`, async ({ page }) => {
  await startConversation(page);
  await finishConversationRound(page, 'First response is complete.');
  await page.getByRole('button', { name: /Upgrade the adapter/ }).click();
  await expect(page.getByRole('heading', { name: 'Upgrade the adapter', exact: true })).toBeVisible();
  await page.evaluate(async () => {
    const state = (window as unknown as { uiTest: { snapshot: TaskSnapshot; preferencesHeld?: boolean; releasePreferences?: () => void } }).uiTest;
    await window.knotrail.command({ type: 'preferences.save', taskId: state.snapshot.task.id, value: { draft: 'Saved unread conversation draft', toolPanel: 'terminal', mainView: 'chat', panelView: 'process', detailTab: 'artifacts', graphView: 'graph' } });
    const original = window.knotrail.command; let hold = true;
    window.knotrail.command = async <T,>(command: AppCommand): Promise<T> => {
      const result = await original<T>(command);
      if (command.type === 'preferences.get' && command.taskId === state.snapshot.task.id && hold) { hold = false; state.preferencesHeld = true; await new Promise<void>(resolve => { state.releasePreferences = resolve; }); }
      return result;
    };
  });
  await page.getByRole('button', { name: /Explain the adapter lifecycle/ }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { uiTest: { preferencesHeld?: boolean } }).uiTest.preferencesHeld)).toBe(true);
  if (editWhileLoading) {
    await page.evaluate(() => {
      const state = (window as unknown as { uiTest: { snapshot: TaskSnapshot; change: (patch: Partial<TaskSnapshot>) => void } }).uiTest;
      state.change({ task: { ...state.snapshot.task, status: 'idle' } });
    });
    await page.getByRole('textbox', { name: 'Message…', exact: true }).fill('New draft written before switching away');
  }
  await page.getByRole('button', { name: /Upgrade the adapter/ }).click();
  const otherDraft = page.getByRole('textbox', { name: 'Describe a requirement change…', exact: true });
  await otherDraft.fill('Keep the separately selected task draft');
  await page.evaluate(() => (window as unknown as { uiTest: { releasePreferences: () => void } }).uiTest.releasePreferences());
  await expect.poll(() => page.evaluate(async () => {
    const state = (window as unknown as { uiTest: { snapshot: TaskSnapshot } }).uiTest;
    return window.knotrail.command({ type: 'preferences.get', taskId: state.snapshot.task.id });
  })).toMatchObject({ draft: editWhileLoading ? 'New draft written before switching away' : 'Saved unread conversation draft', toolPanel: 'terminal', detailTab: 'artifacts' });
  await expect(otherDraft).toHaveValue('Keep the separately selected task draft');
  await expect(page.getByRole('heading', { name: 'Upgrade the adapter', exact: true })).toBeVisible();
});

test('returning to a loading conversation keeps its pending edits and an older read cannot overwrite the new selection', async ({ page }) => {
  await startConversation(page);
  await finishConversationRound(page, 'First response is complete.');
  await page.getByRole('button', { name: /Upgrade the adapter/ }).click();
  await expect(page.getByRole('heading', { name: 'Upgrade the adapter', exact: true })).toBeVisible();
  await page.evaluate(async () => {
    const state = (window as unknown as { uiTest: { snapshot: TaskSnapshot; preferencesHeld?: boolean; releasePreferences?: () => void } }).uiTest;
    await window.knotrail.command({ type: 'preferences.save', taskId: state.snapshot.task.id, value: { draft: 'Saved older conversation draft', toolPanel: 'terminal', mainView: 'chat', panelView: 'process', detailTab: 'overview', graphView: 'graph' } });
    const original = window.knotrail.command; let hold = true;
    window.knotrail.command = async <T,>(command: AppCommand): Promise<T> => {
      const result = await original<T>(command);
      if (command.type === 'preferences.get' && command.taskId === state.snapshot.task.id && hold) { hold = false; state.preferencesHeld = true; await new Promise<void>(resolve => { state.releasePreferences = resolve; }); }
      return result;
    };
  });
  await page.getByRole('button', { name: /Explain the adapter lifecycle/ }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { uiTest: { preferencesHeld?: boolean } }).uiTest.preferencesHeld)).toBe(true);
  await page.evaluate(() => {
    const state = (window as unknown as { uiTest: { snapshot: TaskSnapshot; change: (patch: Partial<TaskSnapshot>) => void } }).uiTest;
    state.change({ task: { ...state.snapshot.task, status: 'idle' } });
  });
  const composer = page.getByRole('textbox', { name: 'Message…', exact: true });
  await composer.fill('Pending draft from the first selection');
  await page.getByRole('button', { name: /Upgrade the adapter/ }).click();
  await expect(page.getByRole('heading', { name: 'Upgrade the adapter', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Explain the adapter lifecycle/ }).click();
  await expect(page.locator('.tool-toggles').getByRole('button', { name: 'Terminal', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(composer).toHaveValue('Pending draft from the first selection');
  await composer.fill('Newer draft from the returned selection');
  await page.evaluate(() => (window as unknown as { uiTest: { releasePreferences: () => void } }).uiTest.releasePreferences());
  await expect(composer).toHaveValue('Newer draft from the returned selection');
  await expect.poll(() => page.evaluate(async () => {
    const state = (window as unknown as { uiTest: { snapshot: TaskSnapshot } }).uiTest;
    return window.knotrail.command({ type: 'preferences.get', taskId: state.snapshot.task.id });
  })).toMatchObject({ draft: 'Newer draft from the returned selection', toolPanel: 'terminal' });
});

test('a failed conversation send remains visible and retains the original message draft', async ({ page }) => {
  await startConversation(page);
  await delayRevisionResponses(page, 'task.message');
  const composer = page.getByRole('textbox', { name: 'Message…', exact: true });
  await composer.fill('Keep this message after an error.');
  await composer.press('Enter');
  await page.evaluate(() => (window as unknown as { uiTest: { settleRevision: (index: number, error?: string) => void } }).uiTest.settleRevision(0, 'Could not send message'));
  await expect(page.getByRole('alert')).toContainText('Could not send message');
  await expect(composer).toHaveValue('Keep this message after an error.');
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
});

for (const outcome of ['success', 'failure'] as const) test(`a late conversation send ${outcome} cannot alter another task's draft or error`, async ({ page }) => {
  await startConversation(page);
  await delayRevisionResponses(page, 'task.message');
  await page.getByRole('textbox', { name: 'Message…', exact: true }).fill('Send in the conversation');
  await page.getByRole('textbox', { name: 'Message…', exact: true }).press('Enter');
  await page.getByRole('button', { name: /Upgrade the adapter/ }).click();
  const composer = page.getByRole('textbox', { name: 'Describe a requirement change…', exact: true });
  await composer.fill('Keep the separate task draft');
  await page.evaluate(outcome => (window as unknown as { uiTest: { settleRevision: (index: number, error?: string) => void } }).uiTest.settleRevision(0, outcome === 'failure' ? 'Earlier conversation response failed' : undefined), outcome);
  await expect(page.getByRole('button', { name: 'Preview requirement change', exact: true })).toBeEnabled();
  await expect(composer).toHaveValue('Keep the separate task draft');
  await expect(page.getByRole('heading', { name: 'Upgrade the adapter', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('planned task advanced options retain finite scheduling and conversation mode omits it', async ({ page }) => {
  await start(page, false);
  await page.locator('.advanced-options > summary').click();
  await page.getByLabel('Interaction', { exact: true }).selectOption('task');
  await page.getByLabel('Task mode', { exact: true }).selectOption('finite');
  await page.getByLabel('Expires at', { exact: true }).fill('2099-01-01T12:00');
  await page.getByLabel('Check interval (minutes)', { exact: true }).fill('12');
  await page.getByLabel('Maximum turns', { exact: true }).fill('18');
  await page.getByLabel('Execution policy').selectOption('reviewBeforeExecute');
  await page.getByRole('button', { name: 'Add check', exact: true }).click();
  await page.getByLabel('Command argv (JSON array)').fill('["npm","test"]');
  await page.getByLabel('Interaction', { exact: true }).selectOption('conversation');
  await expect(page.getByLabel('Task mode', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Expires at', { exact: true })).toHaveCount(0);
  await page.getByLabel('Message', { exact: true }).fill('Continue with these optional checks.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const commands = await page.evaluate(() => (window as unknown as { uiTest: { commands: AppCommand[] } }).uiTest.commands);
  const created = commands.find(command => command.type === 'task.create');
  expect(created).toMatchObject({ interaction: 'conversation', mode: 'once', maxTurns: 18, executionPolicy: 'reviewBeforeExecute', checks: [{ command: ['npm', 'test'] }] });
  expect(created).not.toHaveProperty('expiresAt');
  expect(created).not.toHaveProperty('intervalMinutes');
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

test('typed declarations and fixed upstream inputs show output IDs, producer runs and recorded hashes', async ({ page }) => {
  await showInputEvidence(page);
  const step = page.locator('.plan-tracker [data-node-id="edit"]');
  await step.locator(':scope > summary').click();
  const declarations = step.locator('.tracker-detail > dl');
  await expect(declarations).toContainText('research / inventory');
  await expect(declarations).toContainText('config-v2.json');
  await expect(declarations).toContainText('Must be absent');
  await expect(declarations).toContainText('adapter');
  await expect(declarations).toContainText('Text summary');
  await expect(page.locator('.app')).not.toContainText('[object Object]');
  const run = step.locator('[data-run-id="consumer-current"]'), binding = run.locator('[data-input-index="0"]');
  await expect(binding).not.toHaveAttribute('open', '');
  await expect(binding.locator('pre')).not.toBeVisible();
  await expect(binding.locator(':scope > summary')).toContainText('All saved content delivered');
  await binding.locator(':scope > summary').click();
  await expect(binding).toContainText('inventory-current');
  await expect(binding).toContainText('producer-current');
  await expect(binding).toContainText('inventory-source-current');
  await expect(binding).toContainText('0o644');
  const artifact = await page.evaluate(() => (window as unknown as { uiTest: { snapshot: TaskSnapshot } }).uiTest.snapshot.artifacts.find(artifact => artifact.id === 'inventory-current')!);
  await expect(binding.locator('.io-metadata')).toContainText(artifact.digest);
  await expect(binding.locator('.io-metadata')).toContainText(artifact.source!.sourceDigest!);
  await binding.locator('.saved-input-content > summary').click();
  await expect(binding.locator('pre')).toHaveText('Revised caller inventory from the current run.');
  const output = run.locator('[data-artifact-id="adapter-current"]');
  await output.locator(':scope > summary').click();
  await expect(output).toContainText('Output ID');
  await expect(output).toContainText('adapter-source-current');
  await expect(output).toContainText('consumer-current');
  await expect(output.locator('pre')).toHaveText('export const adapter = "recorded";');
  await page.getByRole('button', { name: 'Planning', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Planning', exact: true });
  await panel.getByRole('button', { name: 'Steps', exact: true }).click();
  await panel.getByRole('button', { name: /Use the fixed inventory.*Current|Use the fixed inventory.*Running/ }).click();
  await expect(panel.locator('.detail-content > dl')).toContainText('research / inventory');
  await expect(panel.locator('.detail-content > dl')).toContainText('src/adapter.ts');
  await expect(panel).not.toContainText('[object Object]');
  await expect(page.locator('.plan-tracker .section-heading')).toContainText('1 / 2 Finished steps · 0 Verified');
});

test('same-ID historical runs retain their own fixed input content, producing runs and declarations', async ({ page }) => {
  await showInputEvidence(page);
  const step = page.locator('.plan-tracker [data-node-id="edit"]');
  await step.locator(':scope > summary').click();
  await step.locator('.step-history > summary').click();
  const earlier = step.locator('[data-run-id="consumer-before"]');
  await earlier.locator(':scope > summary').click();
  await earlier.locator('.run-declarations > summary').click();
  await expect(earlier.locator('.run-declarations')).toContainText('config-v1.json');
  await expect(earlier.locator('.run-declarations')).not.toContainText('config-v2.json');
  const oldInput = earlier.locator('[data-input-index="0"]');
  await oldInput.locator(':scope > summary').click();
  await oldInput.locator('.saved-input-content > summary').click();
  await expect(oldInput).toContainText('producer-before');
  await expect(oldInput).toContainText('inventory-before');
  await expect(oldInput.locator('pre')).toHaveText('Original caller inventory from the earlier run.');
  await expect(earlier).not.toContainText('producer-current');
  await expect(earlier).not.toContainText('Revised caller inventory');
  const currentInput = step.locator('[data-run-id="consumer-current"] [data-input-index="0"]');
  await currentInput.locator(':scope > summary').click();
  await currentInput.locator('.saved-input-content > summary').click();
  await expect(currentInput.locator('pre')).toHaveText('Revised caller inventory from the current run.');
  await expect(currentInput).not.toContainText('producer-before');
});

test('input evidence distinguishes delivery gaps, redaction, known absence, empty files and unknown read coverage', async ({ page }) => {
  await showInputEvidence(page);
  const step = page.locator('.plan-tracker [data-node-id="edit"]');
  await step.locator(':scope > summary').click();
  const run = step.locator('[data-run-id="consumer-current"]');
  await expect(run.locator('.input-coverage')).toHaveText('Input coverage: Unknown');
  await expect(run).toContainText('Input coverage is unknown; additional reads may not be recorded.');
  const partial = run.locator('[data-input-index="1"]');
  await expect(partial.locator(':scope > summary')).toContainText('Partly delivered');
  await partial.locator(':scope > summary').click();
  await expect(partial).toContainText('[0, 3)');
  await expect(partial).toContainText('[7, 24)');
  await expect(partial).toContainText('Ranges record content supplied to the runner, not provider receipt or model comprehension.');
  await expect(partial).not.toContainText('All saved content delivered');
  const missing = run.locator('[data-input-index="2"]');
  await missing.locator(':scope > summary').click();
  await expect(missing).toContainText('Known missing file');
  await expect(missing).toContainText('Must be absent');
  await expect(missing).toContainText('File missing');
  await expect(missing).not.toContainText('All saved content delivered');
  const redacted = run.locator('[data-input-index="3"]');
  await redacted.locator(':scope > summary').click();
  await expect(redacted.locator(':scope > summary')).toContainText('All saved redacted content delivered');
  await expect(redacted).toContainText('not the original bytes');
  const binding = await page.evaluate(() => (window as unknown as { uiTest: { snapshot: TaskSnapshot } }).uiTest.snapshot.runs.find(run => run.id === 'consumer-current')!.inputBindings![3]!);
  expect(binding.digest).not.toBe(binding.source!.sourceDigest);
  await expect(redacted).toContainText(binding.digest);
  await expect(redacted).toContainText(binding.source!.sourceDigest!);
  const empty = run.locator('[data-input-index="4"]');
  await empty.locator(':scope > summary').click();
  await expect(empty).toContainText('Empty saved content');
  await expect(empty).toContainText('File exists');
  await expect(empty).not.toContainText('File missing');
  await run.locator('.file-reads > summary').click();
  await expect(run.locator('.file-reads')).toContainText('Partial read');
  await expect(run.locator('.file-reads')).toContainText('Read in full');
  await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('zh-CN');
  await expect(run).toContainText('输入覆盖范围未知');
  await expect(redacted).toContainText('已交付全部已保存的脱敏内容');
  await expect(partial).toContainText('范围记录交给运行器的内容，不代表服务商已收到或模型已理解。');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.sidebar').getByRole('button', { name: '收起导航', exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  expect(await step.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('input-evidence-zh-narrow.png') });
});

test('legacy string declarations and truncated artifacts preserve unknown input evidence and conservative hashes', async ({ page }) => {
  await start(page);
  await page.evaluate(() => {
    const state = (window as unknown as { uiTest: { snapshot: TaskSnapshot; change: (patch: Partial<TaskSnapshot>) => void } }).uiTest;
    state.change({ artifacts: state.snapshot.artifacts.map(artifact => ({ ...artifact, truncated: true, redacted: true })) });
  });
  const step = page.locator('.plan-tracker [data-node-id="edit"]');
  await step.locator(':scope > summary').click();
  await expect(step.locator('.tracker-detail > dl')).toContainText('Caller inventory');
  const run = step.locator('[data-run-id="run-2"]');
  await expect(run.locator('.input-coverage')).toHaveText('Input coverage: Unknown');
  await expect(run).toContainText('Fixed inputs were not recorded for this run.');
  await run.locator('.file-reads > summary').click();
  await expect(run.locator('.file-reads')).toContainText('File reads were not recorded for this run.');
  const artifact = run.locator('[data-artifact-id="artifact-1"]');
  await expect(artifact.locator(':scope > summary')).toContainText('Redacted');
  await expect(artifact.locator(':scope > summary')).toContainText('Truncated');
  await artifact.locator(':scope > summary').click();
  await expect(artifact).toContainText('Recorded artifact hash');
  await expect(artifact).not.toContainText('Saved content hash (SHA-256)');
  await expect(artifact).toContainText('Not recorded');
  await expect(artifact).toContainText('Saved content is redacted; it does not reproduce the original bytes.');
  await page.locator('.tool-toggles').getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.locator('.artifact-preview')).toContainText('Recorded artifact hash');
  await expect(page.locator('.artifact-preview')).toContainText('Truncated');
  await expect(page.locator('.artifact-preview')).not.toContainText('Saved content hash (SHA-256)');
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
