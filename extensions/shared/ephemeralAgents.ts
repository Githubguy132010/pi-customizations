import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { RpcClientOptions } from "@earendil-works/pi-coding-agent";

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
  statusError?: string;
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

export interface AgentClient {
  start(): Promise<void>;
  stop(): Promise<void>;
  prompt(message: string): Promise<void>;
  followUp(message: string): Promise<void>;
  getState(): Promise<{ isStreaming: boolean }>;
  getLastAssistantText(): Promise<string | null>;
  onEvent(listener: (event: {
    type: string;
    message?: { role?: string; stopReason?: string; errorMessage?: string };
  }) => void): () => void;
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
  pendingError?: string;
  runStarted: boolean;
  messageQueue: Promise<void>;
}

export interface EphemeralAgentManagerOptions {
  cliPath: string;
  workspaceRoot?: string;
  cloneRepo(source: string, destination: string, signal?: AbortSignal, timeoutMs?: number): Promise<void>;
  createClient(options: RpcClientOptions): AgentClient;
}

const LIVENESS_POLL_INTERVAL_MS = 500;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
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

function isTerminalStatus(status: EphemeralAgentStatus): status is "failed" | "closed" {
  return status === "failed" || status === "closed";
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("Operation cancelled"));

  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error("Operation cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function raceOperation<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
  timeoutSubject = "Agent",
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      callback();
    };
    const abort = () => finish(() => reject(new Error("Operation cancelled")));
    if (signal?.aborted) {
      abort();
      return;
    }
    timer = setTimeout(
      () => finish(() => reject(new Error(`${timeoutSubject} did not finish within ${Math.ceil(timeoutMs / 1000)} seconds`))),
      timeoutMs,
    );
    signal?.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

export class EphemeralAgentManager {
  readonly workspaceRoot: string;
  private readonly records = new Map<string, AgentRecord>();
  private readonly pendingSpawns = new Set<Promise<void>>();
  private readonly shutdownController = new AbortController();
  private readonly options: EphemeralAgentManagerOptions;
  private disposed = false;

  constructor(options: EphemeralAgentManagerOptions) {
    this.options = options;
    this.workspaceRoot = options.workspaceRoot ?? mkdtempSync(join(tmpdir(), "pi-ephemeral-agents-"));
    mkdirSync(this.workspaceRoot, { recursive: true });
  }

  async spawn(options: SpawnEphemeralAgentOptions): Promise<EphemeralAgentSnapshot> {
    if (this.disposed) throw new Error("The ephemeral agent manager is closed");
    const signal = this.operationSignal(options.signal);

    const name = safeName(options.name);
    const id = `${name}-${randomUUID().slice(0, 8)}`;
    const workspace = join(this.workspaceRoot, id);
    const scratch = join(workspace, "scratch");
    const repo = join(scratch, "repo");
    const mailbox = join(workspace, "reports.jsonl");
    mkdirSync(scratch, { recursive: true });
    const pendingSpawn = deferred();
    this.pendingSpawns.add(pendingSpawn.promise);

    let record: AgentRecord;
    try {
      await this.options.cloneRepo(options.sourceRepo, repo, signal, options.timeoutMs);
      if (this.disposed) throw new Error("The ephemeral agent manager is closed");
      const client = this.createClient(repo, id, options);
      const run = deferred();
      record = {
        id, name, status: "starting", workspace, repo, mailbox, client,
        completion: run.promise, resolveCompletion: run.resolve,
        runStarted: false, messageQueue: Promise.resolve(),
      } as AgentRecord;
      record.unsubscribe = client.onEvent((event) => {
        if (event.type === "agent_start") {
          record.status = "running";
          record.pendingError = undefined;
          record.runStarted = true;
        }
        if (event.type === "message_end" && event.message?.role === "assistant") {
          record.pendingError = event.message.stopReason === "error" || event.message.stopReason === "aborted"
            ? event.message.errorMessage ?? `Agent stopped with ${event.message.stopReason}`
            : undefined;
        }
        if (event.type === "agent_settled") {
          record.status = record.pendingError ? "failed" : "idle";
          record.error = record.pendingError;
          record.runStarted = false;
          record.resolveCompletion();
        }
      });
      this.records.set(id, record);

      await client.start();
      record.status = "running";
      await raceOperation(
        client.prompt(this.buildPrompt(options.task, workspace, repo)),
        options.timeoutMs ?? 600_000,
        signal,
      );

    } catch (error) {
      const failedRecord = this.records.get(id);
      if (failedRecord) {
        await this.failRecord(failedRecord, error);
      }
      rmSync(workspace, { recursive: true, force: true });
      this.records.delete(id);
      throw error;
    } finally {
      pendingSpawn.resolve();
      this.pendingSpawns.delete(pendingSpawn.promise);
    }

    if (options.background) return this.snapshot(record);
    return this.wait(id, options.timeoutMs, signal);
  }

  async send(id: string, message: string, options: MessageEphemeralAgentOptions = {}): Promise<EphemeralAgentSnapshot> {
    const record = this.requireRecord(id);
    if (record.status === "closed" || record.status === "failed") {
      throw new Error(`Agent ${id} is ${record.status}`);
    }
    const timeoutMs = options.timeoutMs ?? 600_000;
    const signal = this.operationSignal(options.signal);
    const deadline = Date.now() + timeoutMs;
    const previousMessage = record.messageQueue;
    const queuedMessage = deferred();
    record.messageQueue = previousMessage.then(() => queuedMessage.promise);

    try {
      try {
        await raceOperation(previousMessage, this.remainingTimeout(deadline, timeoutMs), signal);
      } catch (error) {
        if (signal.aborted) throw error;
        throw new Error(`Previous message to agent ${id} is still in progress; message was not delivered`);
      }
      await this.deliverMessage(record, message, deadline, timeoutMs, signal);
    } finally {
      queuedMessage.resolve();
    }

    return options.wait
      ? this.wait(id, this.remainingTimeout(deadline, timeoutMs), options.signal)
      : this.snapshot(record);
  }

  async wait(id: string, timeoutMs = 600_000, signal?: AbortSignal): Promise<EphemeralAgentSnapshot> {
    const record = this.requireRecord(id);
    if (isTerminalStatus(record.status)) return this.snapshot(record);
    const operationSignal = this.operationSignal(signal);
    const deadline = Date.now() + timeoutMs;

    if (record.status === "starting" || record.status === "running") {
      await this.waitForCompletion(record, deadline, timeoutMs, operationSignal);
    }

    if (isTerminalStatus(record.status)) return this.snapshot(record);

    try {
      record.response = (await this.runClientRequest(
        record,
        () => record.client.getLastAssistantText(),
        this.remainingTimeout(deadline, timeoutMs),
        operationSignal,
      )) ?? undefined;
    } catch (error) {
      if (!this.recordFailed(record)) throw error;
    }
    return this.snapshot(record);
  }

  async status(id?: string, timeoutMs = 600_000, signal?: AbortSignal): Promise<EphemeralAgentSnapshot[]> {
    const records = id ? [this.requireRecord(id)] : Array.from(this.records.values());
    const operationSignal = this.operationSignal(signal);
    if (operationSignal.aborted) throw new Error("Operation cancelled");
    const deadline = Date.now() + timeoutMs;
    const results = await Promise.allSettled(records.map(async (record) => {
      if (record.status === "closed" || record.status === "failed") return;
      try {
        const state = await this.getClientState(
          record,
          this.remainingTimeout(deadline, timeoutMs, "Status check"),
          operationSignal,
          "Status check",
        );
        if (state.isStreaming) {
          record.status = "running";
          record.runStarted = true;
        }
        if (record.status === "idle") {
          record.response = (await this.runClientRequest(
            record,
            () => record.client.getLastAssistantText(),
            this.remainingTimeout(deadline, timeoutMs, "Status check"),
            operationSignal,
            "Status check",
          )) ?? undefined;
        }
      } catch (error) {
        if (!this.recordFailed(record)) throw error;
      }
    }));
    if (operationSignal.aborted) throw new Error("Operation cancelled");
    if (id && results[0]?.status === "rejected") throw results[0].reason;
    return records.map((record, index) => this.snapshot(
      record,
      results[index]?.status === "rejected" ? errorMessage(results[index].reason) : undefined,
    ));
  }

  async close(id: string, removeWorkspace = true): Promise<EphemeralAgentSnapshot> {
    const record = this.requireRecord(id);
    if (record.status !== "closed") {
      await this.stopClient(record);
      record.status = "closed";
      record.resolveCompletion();
    }
    const snapshot = this.snapshot(record);
    if (removeWorkspace) {
      rmSync(record.workspace, { recursive: true, force: true });
      this.records.delete(id);
    }
    return snapshot;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.shutdownController.abort();
    await Promise.allSettled(Array.from(this.pendingSpawns));
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
    return this.options.createClient(clientOptions);
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
    record.pendingError = undefined;
    record.runStarted = false;
  }

  private async deliverMessage(
    record: AgentRecord,
    message: string,
    deadline: number,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<void> {
    this.throwIfSettledWithFailure(record);
    const state = await this.getClientState(record, this.remainingTimeout(deadline, timeoutMs), signal);
    this.throwIfSettledWithFailure(record);
    if (state.isStreaming) {
      record.status = "running";
      record.runStarted = true;
    }

    if (!state.isStreaming && (record.status === "idle" || record.runStarted)) {
      await this.awaitSettledRun(record, this.remainingTimeout(deadline, timeoutMs), signal);
      await this.startFreshTurn(record, message, this.remainingTimeout(deadline, timeoutMs), signal);
      return;
    }

    try {
      await raceOperation(record.client.followUp(message), this.remainingTimeout(deadline, timeoutMs), signal);
    } catch (followUpError) {
      const latestState = await this.getClientState(
        record,
        this.remainingTimeout(deadline, timeoutMs),
        signal,
      );
      this.throwIfSettledWithFailure(record);
      if (latestState.isStreaming) {
        record.status = "running";
        record.runStarted = true;
        throw followUpError;
      }
      if (record.status !== "idle" && !record.runStarted) throw followUpError;

      await this.awaitSettledRun(record, this.remainingTimeout(deadline, timeoutMs), signal);
      await this.startFreshTurn(record, message, this.remainingTimeout(deadline, timeoutMs), signal);
    }
  }

  private async startFreshTurn(
    record: AgentRecord,
    message: string,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<void> {
    this.beginRun(record);
    record.status = "running";
    try {
      await raceOperation(record.client.prompt(message), timeoutMs, signal);
    } catch (error) {
      await this.failRecord(record, error);
      throw error;
    }
  }

  private async awaitSettledRun(record: AgentRecord, timeoutMs: number, signal: AbortSignal): Promise<void> {
    if (record.status === "starting" || record.status === "running") {
      await raceOperation(record.completion, timeoutMs, signal);
    }
    if (record.status === "failed") {
      throw new Error(record.error);
    }
    if (record.status !== "idle") {
      throw new Error(`Agent ${record.id} is ${record.status}`);
    }
  }

  private async getClientState(
    record: AgentRecord,
    timeoutMs: number,
    signal: AbortSignal,
    timeoutSubject = "Agent",
  ): Promise<{ isStreaming: boolean }> {
    return this.runClientRequest(record, () => record.client.getState(), timeoutMs, signal, timeoutSubject);
  }

  private async runClientRequest<T>(
    record: AgentRecord,
    request: () => Promise<T>,
    timeoutMs: number,
    signal: AbortSignal,
    timeoutSubject = "Agent",
  ): Promise<T> {
    const rpcRequest = request().catch(async (error) => {
      if (!isTerminalStatus(record.status)) await this.failRecord(record, error);
      throw error;
    });
    return raceOperation(rpcRequest, timeoutMs, signal, timeoutSubject);
  }

  private throwIfSettledWithFailure(record: AgentRecord): void {
    if (record.status === "failed") {
      throw new Error(record.error);
    }
    if (record.status === "closed") {
      throw new Error(`Agent ${record.id} is closed`);
    }
  }

  private async failRecord(record: AgentRecord, error: unknown): Promise<void> {
    record.status = "failed";
    record.error = errorMessage(error);
    record.runStarted = false;
    record.resolveCompletion();
    await this.stopClient(record);
  }

  private operationSignal(signal?: AbortSignal): AbortSignal {
    return signal
      ? AbortSignal.any([signal, this.shutdownController.signal])
      : this.shutdownController.signal;
  }

  private remainingTimeout(deadline: number, timeoutMs: number, timeoutSubject = "Agent"): number {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`${timeoutSubject} did not finish within ${Math.ceil(timeoutMs / 1000)} seconds`);
    }
    return remaining;
  }

  private async waitForCompletion(
    record: AgentRecord,
    deadline: number,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<void> {
    const completion = record.completion;

    while (record.status === "starting" || record.status === "running") {
      const remaining = this.remainingTimeout(deadline, timeoutMs);

      const result = await raceAbort(Promise.race([
        completion.then(() => "settled" as const),
        new Promise<"poll">((resolve) => setTimeout(
          () => resolve("poll"),
          Math.min(LIVENESS_POLL_INTERVAL_MS, Math.max(1, Math.floor(remaining / 2))),
        )),
      ]), signal);
      if (result === "settled") return;

      try {
        await this.getClientState(record, this.remainingTimeout(deadline, timeoutMs), signal);
      } catch (error) {
        if (this.recordFailed(record)) return;
        throw error;
      }
    }
  }

  private async stopClient(record: AgentRecord): Promise<void> {
    try {
      await record.client.stop();
    } catch (error) {
      record.error ??= errorMessage(error);
    } finally {
      record.unsubscribe();
    }
  }

  private requireRecord(id: string): AgentRecord {
    const record = this.records.get(id);
    if (!record) throw new Error(`Unknown ephemeral agent: ${id}`);
    return record;
  }

  private recordFailed(record: AgentRecord): boolean {
    return record.status === "failed";
  }

  private snapshot(record: AgentRecord, statusError?: string): EphemeralAgentSnapshot {
    return {
      id: record.id,
      name: record.name,
      status: record.status,
      workspace: record.workspace,
      repo: record.repo,
      response: record.response,
      reports: this.readReports(record.mailbox),
      error: record.error,
      statusError,
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
          return value && (value.kind === "update" || value.kind === "question")
            && typeof value.message === "string" && typeof value.timestamp === "string"
            ? [value]
            : [];
        } catch {
          return [];
        }
      });
    return reports.length > 0 ? reports : undefined;
  }
}
