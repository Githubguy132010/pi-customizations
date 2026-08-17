export type AgentState = "running" | "waiting_for_input" | "completed" | "failed" | "timed_out" | "cancelled" | "cleaning_up";

export interface AgentMetadata {
  id: string;
  sessionId: string;
  task: string;
  state: AgentState;
  createdAt: string;
  updatedAt: string;
  pid?: number;
  exitCode?: number;
  error?: string;
  question?: string;
  result?: string;
  changeSummary?: string;
}

export interface AgentPaths {
  root: string;
  repo: string;
  scratch: string;
  metadata: string;
  transcript: string;
  request: string;
  response: string;
}

export interface SpawnRequest {
  task: string;
  background?: boolean;
  timeoutMs?: number;
}

export interface AgentSnapshot extends AgentMetadata {
  workspacePresent: boolean;
}
