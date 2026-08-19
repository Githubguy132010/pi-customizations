import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RpcClient, type RpcClientOptions } from "@earendil-works/pi-coding-agent";

export type EphemeralAgentStatus = "starting" | "running" | "idle" | "failed" | "closed";

export interface EphemeralAgentSnapshot {
  id: string;
  name: string;
  status: EphemeralAgentStatus;
  workspace: string;
  repo: string;
  response?: string;
  reports?: EphemeralAgentReport[];
  error?: string;
}

export interface EphemeralAgentReport {
  kind: "update" | "question";
  message: string;
  timestamp: string;
}

export interface SpawnEphemeralAgentOptions {
  name?: string;
  task: string;
  sourceRepo: string;
  model?: { provider: string; id: string };
  thinkingLevel?: string;
  background?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface MessageEphemeralAgentOptions {
  wait?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface AgentClient {
  start(): Promise<void>;
  stop(): Promise<void>;
  prompt(message: string): Promise<void>;
  followUp(message: string): Promise<void>;
  getState(): Promise<{ isStreaming: boolean }>;
  getLastAssistantText(): Promise<string | null>;
  onEvent(listener: (event: { type: string }) => void): () => void;
}

interface AgentRecord {
  id: string;
  name: string;
  status: EphemeralAgentStatus;
  workspace: string;
  repo: string;
  mailbox: string;
  client: AgentClient;
  unsubscribe: () => void;
  completion: Promise<void>;
  resolveCompletion: () => void;
  response?: string;
  error?: string;
}

export interface EphemeralAgentManagerOptions {
  cliPath: string;
  workspaceRoot?: string;
  cloneRepo(source: string, destination: string): Promise<void>;
  createClient?: (options: RpcClientOptions) => AgentClient;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function safeName(value: string | undefined): string {
  const normalized = value?.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return normalized || "agent";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new Error("Wait cancelled"));

  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error("Wait cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Agent did not finish within ${Math.ceil(timeoutMs / 1000)} seconds`)), timeoutMs);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

export class EphemeralAgentManager {
  readonly workspaceRoot: string;
  private readonly records = new Map<string, AgentRecord>();
  private readonly options: EphemeralAgentManagerOptions;
  private disposed = false;

  constructor(options: EphemeralAgentManagerOptions) {
    this.options = options;
    this.workspaceRoot = options.workspaceRoot ?? mkdtempSync(join(tmpdir(), "pi-ephemeral-agents-"));
    mkdirSync(this.workspaceRoot, { recursive: true });
  }

  async spawn(options: SpawnEphemeralAgentOptions): Promise<EphemeralAgentSnapshot> {
    if (this.disposed) throw new Error("The ephemeral agent manager is closed");

    const name = safeName(options.name);
    const id = `${name}-${randomUUID().slice(0, 8)}`;
    const workspace = join(this.workspaceRoot, id);
    const scratch = join(workspace, "scratch");
    const repo = join(scratch, "repo");
    const mailbox = join(workspace, "reports.jsonl");
    mkdirSync(scratch, { recursive: true });

    let record: AgentRecord;
    try {
      await this.options.cloneRepo(options.sourceRepo, repo);
      const client = this.createClient(repo, id, options);
      const run = deferred();
      record = {
        id, name, status: "starting", workspace, repo, mailbox, client,
        unsubscribe: () => {}, completion: run.promise, resolveCompletion: run.resolve,
      };
      record.unsubscribe = client.onEvent((event) => {
        if (event.type === "agent_start") record.status = "running";
        if (event.type === "agent_settled") {
          record.status = "idle";
          record.resolveCompletion();
        }
      });
      this.records.set(id, record);

      await client.start();
      record.status = "running";
      await client.prompt(this.buildPrompt(options.task, workspace, repo));

    } catch (error) {
      const failedRecord = this.records.get(id);
      if (failedRecord) {
        failedRecord.status = "failed";
        failedRecord.error = errorMessage(error);
        failedRecord.resolveCompletion();
        await failedRecord.client.stop().catch(() => {});
        failedRecord.unsubscribe();
      }
      rmSync(workspace, { recursive: true, force: true });
      throw error;
    }

    if (options.background) return this.snapshot(record);
    return this.wait(id, options.timeoutMs, options.signal);
  }

  async send(id: string, message: string, options: MessageEphemeralAgentOptions = {}): Promise<EphemeralAgentSnapshot> {
    const record = this.requireRecord(id);
    if (record.status === "closed" || record.status === "failed") {
      throw new Error(`Agent ${id} is ${record.status}`);
    }

    const state = await record.client.getState();
    if (state.isStreaming) {
      await record.client.followUp(message);
    } else {
      this.beginRun(record);
      record.status = "running";
      await record.client.prompt(message);
    }

    return options.wait ? this.wait(id, options.timeoutMs, options.signal) : this.snapshot(record);
  }

  async wait(id: string, timeoutMs = 600_000, signal?: AbortSignal): Promise<EphemeralAgentSnapshot> {
    const record = this.requireRecord(id);
    if (record.status === "closed" || record.status === "failed") return this.snapshot(record);

    const state = await record.client.getState();
    if (state.isStreaming) {
      await raceAbort(withTimeout(record.completion, timeoutMs), signal);
    } else {
      record.status = "idle";
      record.resolveCompletion();
    }

    record.response = (await record.client.getLastAssistantText()) ?? undefined;
    return this.snapshot(record);
  }

  async status(id?: string): Promise<EphemeralAgentSnapshot[]> {
    const records = id ? [this.requireRecord(id)] : Array.from(this.records.values());
    await Promise.all(records.map(async (record) => {
      if (record.status === "closed" || record.status === "failed") return;
      try {
        const state = await record.client.getState();
        record.status = state.isStreaming ? "running" : "idle";
        if (!state.isStreaming) {
          record.resolveCompletion();
          record.response = (await record.client.getLastAssistantText()) ?? undefined;
        }
      } catch (error) {
        record.status = "failed";
        record.error = errorMessage(error);
        record.resolveCompletion();
      }
    }));
    return records.map((record) => this.snapshot(record));
  }

  async close(id: string, removeWorkspace = true): Promise<EphemeralAgentSnapshot> {
    const record = this.requireRecord(id);
    if (record.status !== "closed") {
      await record.client.stop().catch((error) => { record.error = errorMessage(error); });
      record.unsubscribe();
      record.status = "closed";
      record.resolveCompletion();
    }
    if (removeWorkspace) rmSync(record.workspace, { recursive: true, force: true });
    return this.snapshot(record);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await Promise.all(Array.from(this.records.values()).map((record) => this.close(record.id, true)));
    rmSync(this.workspaceRoot, { recursive: true, force: true });
  }

  private createClient(repo: string, id: string, options: SpawnEphemeralAgentOptions): AgentClient {
    const args = ["--no-session"];
    if (options.thinkingLevel) args.push("--thinking", options.thinkingLevel);
    const clientOptions: RpcClientOptions = {
      cliPath: this.options.cliPath,
      cwd: repo,
      env: { PI_EPHEMERAL_SUBAGENT: id, PI_EPHEMERAL_MAILBOX: join(this.workspaceRoot, id, "reports.jsonl") },
      provider: options.model?.provider,
      model: options.model?.id,
      args,
    };
    return this.options.createClient?.(clientOptions) ?? new RpcClient(clientOptions);
  }

  private buildPrompt(task: string, workspace: string, repo: string): string {
    return [
      "You are an ephemeral sub-agent working for a parent agent.",
      `Your private workspace is ${workspace}.`,
      `The repository checkout is ${repo}. Use ${join(workspace, "scratch")} for any other temporary files.`,
      "Work only inside that workspace. Do not read or modify paths outside it.",
      "Use ephemeral_report when you have a useful progress update or need an answer from the parent agent.",
      "Complete the task autonomously. In your final response, report the outcome, files changed, and checks run.",
      "",
      `Task: ${task.trim()}`,
    ].join("\n");
  }

  private beginRun(record: AgentRecord): void {
    const run = deferred();
    record.completion = run.promise;
    record.resolveCompletion = run.resolve;
    record.response = undefined;
    record.error = undefined;
  }

  private requireRecord(id: string): AgentRecord {
    const record = this.records.get(id);
    if (!record) throw new Error(`Unknown ephemeral agent: ${id}`);
    return record;
  }

  private snapshot(record: AgentRecord): EphemeralAgentSnapshot {
    return {
      id: record.id,
      name: record.name,
      status: record.status,
      workspace: record.workspace,
      repo: record.repo,
      response: record.response,
      reports: this.readReports(record.mailbox),
      error: record.error,
    };
  }

  private readReports(mailbox: string): EphemeralAgentReport[] | undefined {
    if (!existsSync(mailbox)) return undefined;
    const reports = readFileSync(mailbox, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const value = JSON.parse(line) as EphemeralAgentReport;
          return value && (value.kind === "update" || value.kind === "question") && typeof value.message === "string"
            ? [value]
            : [];
        } catch {
          return [];
        }
      });
    return reports.length > 0 ? reports : undefined;
  }
}
