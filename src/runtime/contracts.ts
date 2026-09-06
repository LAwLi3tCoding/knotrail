import type { CheckSpec, ModelConfig, PlanDraft, PlanNode, PlanRevision } from '../shared/contracts.js';
export interface ToolCall { toolCallId: string; name: 'read_file' | 'list_files' | 'search_files' | 'write_file' | 'edit_file' | 'run_command'; args: Record<string, unknown> }
export interface ToolResult { text: string; isError?: boolean }
export type RunControl = { kind: 'update_plan'; draft: PlanDraft; submit: boolean } | { kind: 'complete'; summary: string } | { kind: 'decision'; question: string; options: string[] } | { kind: 'wait'; reason: string; minutes: number } | { kind: 'blocked'; reason: string };
export interface RunnerRequest { runId: string; purpose: 'planning' | 'node'; workdir: string; sessionDir: string; model: ModelConfig; objective: string; checks: CheckSpec[]; plan?: PlanRevision; node?: PlanNode; context: string; maxTurns: number; timeoutMs: number; responseLanguage: 'task' | 'zh-CN' | 'en' }
export interface RunnerCallbacks { onEvent(kind: string, text: string, data?: unknown): void; onTool(call: ToolCall): Promise<ToolResult>; onControl(control: RunControl): Promise<ToolResult> }
export interface RunnerResult { summary: string; sessionPath?: string; turns: number; usage?: { input: number; output: number; partial?: boolean }; aborted: boolean }
export interface Runner { run(request: RunnerRequest, callbacks: RunnerCallbacks, signal: AbortSignal): Promise<RunnerResult> }
