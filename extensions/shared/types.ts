export interface ExecResultLike {
  code: number;
  stdout: string;
  stderr: string;
  killed: boolean;
}

export interface GitRemote {
  name: string;
  fetch?: string;
  push?: string;
}

export interface SessionWorkdirEntry {
  type: "custom";
  customType: string;
  data?: {
    cwd?: string;
    reason?: string;
    timestamp?: string;
  };
}
