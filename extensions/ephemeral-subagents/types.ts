import type { ChildProcess } from "node:child_process";

export type JobState = "queued" | "starting" | "running" | "needs_input" | "paused" | "completed" | "failed" | "cancelled" | "timed_out";
export type TerminalState = Extract<JobState, "completed" | "failed" | "cancelled" | "timed_out">;
export interface Limits {
  concurrency: number;
  diskMb: number;
  runtimeMs: number;
  outputBytes: number;
}
export const DEFAULT_LIMITS: Limits = { concurrency: 4, diskMb: 2048, runtimeMs: 15 * 60_000, outputBytes: 512 * 1024 };

export interface JobSpec { task: string; model?: string; }
export interface JobEvent { seq: number; at: string; type: string; data?: unknown; }
export interface JobResult { jobId: string; groupId: string; state: TerminalState; terminalReason: string; output: string; stderr: string; sandbox: string; sandboxed: boolean; startedAt?: string; finishedAt: string; truncated: boolean; cleanupPending: boolean; }
export interface Session { root: string; worktree: string; repoRoot: string; }
export interface JobRecord {
  id: string; groupId: string; spec: JobSpec; state: JobState; createdAt: string; session?: Session;
  child?: ChildProcess; events: JobEvent[]; nextSeq: number; output: string; stderr: string; truncated: boolean;
  backend?: string; sandboxed?: boolean; startedAt?: string; result?: JobResult; timer?: NodeJS.Timeout;
  settleWaiters: Array<(r: JobResult) => void>; cancellationRequested: boolean; cleanupPending: boolean; finalizationDone?: boolean;
}
export const TERMINAL = new Set<JobState>(["completed", "failed", "cancelled", "timed_out"]);
