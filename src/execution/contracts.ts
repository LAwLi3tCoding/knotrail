import type { ToolCall, ToolResult } from '../runtime/contracts.js';
export interface SandboxOptions { workdir: string; dataDir: string; allowNetwork: boolean; lockFd: number; timeoutMs: number; protectedPaths: string[] }
export interface ExecutionResult extends ToolResult { exitCode?: number; truncated?: boolean }
export interface Executor { execute(call: ToolCall, options: SandboxOptions, signal: AbortSignal): Promise<ExecutionResult> }
export interface OwnerLock { fd: number; release(): void }
