export type Locale = 'system' | 'zh-CN' | 'en';
export type TaskMode = 'once' | 'finite' | 'maintain';
export type TaskStatus = 'planning' | 'ready' | 'executing' | 'verifying' | 'waiting_user' | 'waiting_external' | 'reconciling' | 'blocked' | 'paused' | 'cancelled' | 'expired' | 'completed' | 'healthy' | 'unhealthy';
export type NodeStatus = 'queued' | 'running' | 'verified' | 'stale' | 'failed' | 'unknown';
export interface CheckSpec { id: string; label: string; command: string[]; protectedPaths: string[] }
export interface PlanNode { id: string; title: string; goal: string; dependsOn: string[]; kind: 'research' | 'edit' | 'verify'; inputs: string[]; outputs: string[]; checkIds: string[] }
export interface PlanDraft { sequence: number; summary: string; observations: { kind: 'fact' | 'constraint' | 'proposal'; text: string; source?: string }[]; nodes: PlanNode[] }
export interface PlanRevision extends PlanDraft { id: string; taskRevision: number; revision: number; createdAt: string; digest: string }
export interface TaskRevision { revision: number; objective: string; checks: CheckSpec[]; createdAt: string }
export interface Task {
  id: string; projectId: string; title: string; objective: string; mode: TaskMode; status: TaskStatus;
  revision: number; activePlanId?: string; workdir: string; baseline: string; createdAt: string; updatedAt: string;
  executionPolicy: 'autoWithinGrant' | 'reviewBeforeExecute'; checks: CheckSpec[]; error?: string;
  maxTurns: number; maxRunMs: number; turnCount: number; intervalMinutes?: number; nextCheckAt?: string; expiresAt?: string;
  acceptedDigest?: string; revisionHistory: TaskRevision[];
}
export interface Project { id: string; name: string; path: string; createdAt: string }
export interface NodeState { nodeId: string; status: NodeStatus; attempt: number; runId?: string; inputDigest?: string; outputDigest?: string; reason?: string }
export interface Run { id: string; taskId: string; taskRevision: number; planId?: string; nodeId?: string; purpose: 'planning' | 'node'; attempt: number; status: 'running' | 'succeeded' | 'failed' | 'aborted' | 'unknown'; startedAt: string; endedAt?: string; inputDigest: string; summary?: string; sessionPath?: string; usage?: { input: number; output: number } }
export interface TaskEvent { seq: number; id: string; taskId: string; taskRevision: number; planId?: string; nodeId?: string; runId?: string; kind: string; text: string; data?: unknown; createdAt: string }
export interface Artifact { id: string; taskId: string; runId: string; nodeId?: string; kind: 'diff' | 'text' | 'file'; name: string; digest: string; createdAt: string; content: string; truncated: boolean }
export interface ActionReceipt { id: string; taskId: string; runId: string; nodeId?: string; toolCallId: string; name: string; argsDigest: string; status: 'pending' | 'succeeded' | 'failed' | 'unknown'; output?: string; startedAt: string; endedAt?: string }
export interface CheckReceipt { id: string; taskId: string; runId: string; nodeId?: string; conditionId: string; result: 'pass' | 'fail' | 'unknown'; inputDigest: string; output: string; checkedAt: string }
export interface Decision { id: string; taskId: string; taskRevision: number; planId?: string; nodeId?: string; question: string; options: string[]; answer?: string; createdAt: string }
export interface ImpactPreview { id: string; taskId: string; expectedRevision: number; expectedPlanId?: string; workspaceDigest: string; objective?: string; nodeId?: string; affected: string[]; retained: string[]; reason: string }
export interface TaskSnapshot { task: Task; plan?: PlanRevision; plans: PlanRevision[]; draft?: PlanDraft; nodes: NodeState[]; runs: Run[]; events: TaskEvent[]; artifacts: Artifact[]; actions: ActionReceipt[]; checks: CheckReceipt[]; decisions: Decision[]; lastSequence: number }
export interface ModelConfig { baseUrl: string; modelId: string; apiKey?: string; thinking: 'off' | 'low' | 'medium' | 'high'; contextWindow: number; maxTokens: number }
export interface AppSettings { locale: Locale; model: Omit<ModelConfig, 'apiKey'> & { hasApiKey: boolean }; planningOpen: boolean; responseLanguage: 'task' | 'zh-CN' | 'en'; allowNetwork: boolean }
export interface TaskPreferences { panelView: 'process' | 'steps'; selectedNode?: string; detailTab: 'overview' | 'artifacts' | 'checks' | 'history'; mainView: 'chat' | 'activity' | 'changes'; toolPanel: 'files' | 'terminal' | 'preview' | null; graphView: 'graph' | 'list'; draft: string }
export interface Bootstrap { projects: Project[]; tasks: Task[]; settings: AppSettings; capabilities: { sandbox: boolean; reason?: string; platform: string }; version: string }
export type AppCommand =
 | { type: 'bootstrap' }
 | { type: 'project.add'; path: string }
 | { type: 'task.create'; requestId: string; projectId: string; objective: string; checks: CheckSpec[]; executionPolicy: Task['executionPolicy']; mode: TaskMode; intervalMinutes?: number; maxTurns?: number; maxRunMs?: number; expiresAt?: string }
 | { type: 'task.snapshot'; taskId: string }
 | { type: 'task.pause' | 'task.resume' | 'task.cancel'; taskId: string; expectedRevision: number }
 | { type: 'task.previewRevision'; taskId: string; objective: string; expectedRevision: number }
 | { type: 'task.previewRetry'; taskId: string; nodeId: string; expectedRevision: number }
 | { type: 'task.applyImpact'; requestId: string; preview: ImpactPreview }
 | { type: 'decision.answer'; requestId: string; taskId: string; decisionId: string; answer: string; expectedRevision: number }
 | { type: 'task.export'; taskId: string }
 | { type: 'task.files'; taskId: string }
 | { type: 'task.readFile'; taskId: string; path: string }
 | { type: 'settings.save'; patch: Partial<Omit<AppSettings, 'model'>> & { model?: Partial<ModelConfig> } }
 | { type: 'model.check' }
 | { type: 'preferences.get'; taskId: string }
 | { type: 'preferences.save'; taskId: string; value: TaskPreferences };
export type CommandResult = Bootstrap | Project | TaskSnapshot | ImpactPreview | AppSettings | TaskPreferences | { path: string } | { files: string[] } | { content: string; truncated: boolean } | { ok: true; message?: string };
export interface DesktopAPI { command<T = CommandResult>(command: AppCommand): Promise<T>; subscribe(listener: (event: { taskId?: string; seq?: number; kind: string }) => void): () => void; chooseProject(): Promise<string | null>; exportReport(taskId: string): Promise<string | null> }
declare global { interface Window { knotrail: DesktopAPI } }
