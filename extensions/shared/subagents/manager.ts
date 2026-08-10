import { mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type ExplorerState = "starting" | "running" | "completed" | "failed";

export interface ExplorerSnapshot {
  id: string;
  task: string;
  state: ExplorerState;
  result?: string;
  error?: string;
}

export interface ExplorerHandle {
  run(task: string): Promise<string>;
  send(message: string): Promise<void>;
  dispose(): void;
}

export type ExplorerFactory = (options: {
  id: string;
  worktree: string;
  sessionId: string;
  sendToPeer: (targetId: string, message: string) => Promise<void>;
}) => Promise<ExplorerHandle>;

interface ExplorerRecord extends ExplorerSnapshot {
  sessionFolder: string;
  worktree: string;
  handle?: ExplorerHandle;
}

function safeId(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-");
  return cleaned.slice(0, 80) || "session";
}

export class ExplorerManager {
  private readonly explorers = new Map<string, ExplorerRecord>();
  private sequence = 0;

  constructor(
    readonly repository: string,
    readonly sessionId: string,
    private readonly factory: ExplorerFactory,
    readonly sessionsRoot = join(homedir(), ".pi", "subagents"),
  ) {}

  async spawn(task: string): Promise<ExplorerSnapshot> {
    const id = `explorer-${++this.sequence}`;
    const sessionFolder = join(this.sessionsRoot, safeId(this.sessionId), id);
    const worktree = join(sessionFolder, "worktree");
    const record: ExplorerRecord = { id, task, state: "starting", sessionFolder, worktree };
    this.explorers.set(id, record);

    try {
      await mkdir(sessionFolder, { recursive: true });
      await execFileAsync("git", ["worktree", "add", "--detach", worktree, "HEAD"], { cwd: this.repository });
      record.handle = await this.factory({
        id,
        worktree,
        sessionId: this.sessionId,
        sendToPeer: (targetId, message) => this.send(targetId, `[From ${id}] ${message}`),
      });
      record.state = "running";
      void this.run(record);
    } catch (error) {
      record.state = "failed";
      record.error = error instanceof Error ? error.message : String(error);
    }
    return this.snapshot(record);
  }

  list(): ExplorerSnapshot[] {
    return [...this.explorers.values()].map((record) => this.snapshot(record));
  }

  async send(id: string, message: string): Promise<void> {
    const record = this.require(id);
    if (record.state !== "running" || !record.handle) throw new Error(`${id} is not running`);
    await record.handle.send(message);
  }

  private async run(record: ExplorerRecord): Promise<void> {
    try {
      record.result = await record.handle!.run(record.task);
      record.handle!.dispose();
      record.handle = undefined;
      await this.removeWorkspace(record);
      record.state = "completed";
    } catch (error) {
      record.state = "failed";
      record.error = error instanceof Error ? error.message : String(error);
      record.handle?.dispose();
      record.handle = undefined;
      // Failed explorers deliberately retain their workspace for a future recovery policy.
    }
  }

  private async removeWorkspace(record: ExplorerRecord): Promise<void> {
    await execFileAsync("git", ["worktree", "remove", "--force", record.worktree], { cwd: this.repository });
    await rm(record.sessionFolder, { recursive: true, force: true });
  }

  private require(id: string): ExplorerRecord {
    const record = this.explorers.get(id);
    if (!record) throw new Error(`Unknown explorer: ${id}`);
    return record;
  }

  private snapshot(record: ExplorerRecord): ExplorerSnapshot {
    return { id: record.id, task: record.task, state: record.state, result: record.result, error: record.error };
  }
}

export async function findRepository(path: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: resolve(path) });
  const repository = stdout.trim();
  if (!repository) throw new Error(`${basename(path)} is not a Git repository`);
  return repository;
}
