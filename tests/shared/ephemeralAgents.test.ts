import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EphemeralAgentManager } from "../../extensions/shared/ephemeralAgents";

class FakeClient {
  streaming = false;
  response: string | null = "finished";
  stateError: unknown;
  listeners: Array<(event: { type: string; message?: { role?: string; stopReason?: string; errorMessage?: string } }) => void> = [];
  start = vi.fn(async () => {});
  stop = vi.fn(async () => {});
  prompt = vi.fn(async () => { this.streaming = true; this.emit("agent_start"); });
  steer = vi.fn(async () => {});
  getState = vi.fn(async () => {
    if (this.stateError) throw this.stateError;
    return { isStreaming: this.streaming };
  });
  getLastAssistantText = vi.fn(async () => this.response);
  onEvent = vi.fn((listener: (event: { type: string; message?: { role?: string; stopReason?: string; errorMessage?: string } }) => void) => {
    this.listeners.push(listener);
    return () => { this.listeners = this.listeners.filter((candidate) => candidate !== listener); };
  });

  settle(response = this.response) {
    this.response = response;
    this.streaming = false;
    this.emit("agent_settled");
  }

  emit(event: string | { type: string; message?: { role?: string; stopReason?: string; errorMessage?: string } }) {
    const value = typeof event === "string" ? { type: event } : event;
    for (const listener of this.listeners) listener(value);
  }
}

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

function setup(setupOptions: {
  cloneRepo?: (source: string, destination: string) => Promise<void>;
  createClient?: () => FakeClient;
} = {}) {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "ephemeral-manager-test-"));
  roots.push(workspaceRoot);
  const clients: FakeClient[] = [];
  const clientOptions: unknown[] = [];
  const cloneRepo = vi.fn(setupOptions.cloneRepo ?? (async (_source: string, destination: string) => {
    mkdirSync(destination, { recursive: true });
  }));
  const manager = new EphemeralAgentManager({
    cliPath: "/package/bin/pi-coding-agent.mjs",
    workspaceRoot,
    cloneRepo,
    createClient: (options) => {
      clientOptions.push(options);
      const client = setupOptions.createClient?.() ?? new FakeClient();
      clients.push(client);
      return client;
    },
  });
  return { manager, workspaceRoot, clients, clientOptions, cloneRepo };
}

describe("ephemeral agent manager", () => {
  it("creates a private scratch/repo checkout and starts in the background", async () => {
    const { manager, clients, clientOptions, cloneRepo } = setup();
    const result = await manager.spawn({
      name: "Review API", task: "Inspect the public interface", sourceRepo: "/source",
      model: { provider: "openai", id: "gpt-test" }, thinkingLevel: "high", background: true,
    });

    expect(result.id).toMatch(/^review-api-[0-9a-f]{8}$/);
    expect(result.status).toBe("running");
    expect(result.repo).toBe(join(result.workspace, "scratch", "repo"));
    expect(existsSync(result.repo)).toBe(true);
    expect(cloneRepo).toHaveBeenCalledWith("/source", result.repo, expect.any(AbortSignal), undefined);
    expect(clientOptions[0]).toMatchObject({
      cliPath: "/package/bin/pi-coding-agent.mjs", cwd: result.repo,
      provider: "openai", model: "gpt-test", args: ["--no-session", "--thinking", "high"],
      env: {
        PI_EPHEMERAL_SUBAGENT: result.id,
        PI_EPHEMERAL_MAILBOX: join(result.workspace, "reports.jsonl"),
      },
    });
    const initialPrompt = (clients[0].prompt.mock.calls as unknown as string[][])[0][0];
    expect(initialPrompt).toContain(`Your private workspace is ${result.workspace}.`);
    expect(initialPrompt).toContain("Task: Inspect the public interface");
  });

  it("receives completion, steers active work, and starts a fresh turn when idle", async () => {
    const { manager, clients } = setup();
    const started = await manager.spawn({ task: "First task", sourceRepo: "/source", background: true });
    const client = clients[0];

    await manager.send(started.id, "Also check tests");
    expect(client.steer).toHaveBeenCalledWith("Also check tests");

    const waiting = manager.wait(started.id, 1000);
    client.settle("first answer");
    await expect(waiting).resolves.toMatchObject({ status: "idle", response: "first answer" });

    await manager.send(started.id, "Now summarize");
    expect(client.prompt).toHaveBeenLastCalledWith("Now summarize");
    const secondWait = manager.wait(started.id, 1000);
    client.settle("second answer");
    await expect(secondWait).resolves.toMatchObject({ status: "idle", response: "second answer" });
  });

  it("starts a fresh turn when RPC settles before the settlement event arrives", async () => {
    const { manager, clients } = setup();
    const started = await manager.spawn({ task: "First task", sourceRepo: "/source", background: true });
    const client = clients[0];
    client.streaming = false;

    await expect(manager.send(started.id, "Start another turn")).resolves.toMatchObject({ status: "running" });
    expect(client.steer).not.toHaveBeenCalled();
    expect(client.prompt).toHaveBeenLastCalledWith("Start another turn");
    expect(client.stop).not.toHaveBeenCalled();
  });

  it("keeps a healthy running agent alive when steering rejects", async () => {
    const { manager, clients } = setup();
    const started = await manager.spawn({ task: "First task", sourceRepo: "/source", background: true });
    const client = clients[0];
    client.steer.mockRejectedValueOnce(new Error("steer rejected"));

    await expect(manager.send(started.id, "Try to steer")).rejects.toThrow("steer rejected");
    expect(client.getState).toHaveBeenCalledTimes(2);
    expect(client.stop).not.toHaveBeenCalled();
    await expect(manager.status(started.id)).resolves.toEqual([
      expect.objectContaining({ status: "running", error: undefined }),
    ]);
  });

  it("retries a rejected steer as a fresh turn after the agent settles", async () => {
    const { manager, clients } = setup();
    const started = await manager.spawn({ task: "First task", sourceRepo: "/source", background: true });
    const client = clients[0];
    client.steer.mockImplementationOnce(async () => {
      client.streaming = false;
      throw new Error("run already settled");
    });

    await expect(manager.send(started.id, "Start another turn")).resolves.toMatchObject({ status: "running" });
    expect(client.prompt).toHaveBeenLastCalledWith("Start another turn");
    expect(client.stop).not.toHaveBeenCalled();
  });

  it("steers during the prompt acknowledgement gap instead of starting a second prompt", async () => {
    const client = new FakeClient();
    client.prompt.mockImplementationOnce(async () => {});
    const { manager } = setup({ createClient: () => client });
    const started = await manager.spawn({ task: "First task", sourceRepo: "/source", background: true });

    await manager.send(started.id, "Queue this too");
    expect(client.steer).toHaveBeenCalledWith("Queue this too");
    expect(client.prompt).toHaveBeenCalledOnce();
    expect(client.stop).not.toHaveBeenCalled();
  });

  it("waits for settlement when prompt acknowledgement arrives before streaming starts", async () => {
    const { manager, clients } = setup();
    const started = await manager.spawn({ task: "Race startup", sourceRepo: "/source", background: true });
    const client = clients[0];
    client.streaming = false;

    const waiting = manager.wait(started.id, 1000);
    const earlyResult = await Promise.race([
      waiting.then(() => "finished"),
      new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 20)),
    ]);
    expect(earlyResult).toBe("pending");

    client.streaming = true;
    client.emit("agent_start");
    client.settle("finished after start");
    await expect(waiting).resolves.toMatchObject({ status: "idle", response: "finished after start" });
  });

  it("keeps a newly acknowledged prompt running until settlement", async () => {
    const { manager, clients } = setup();
    const started = await manager.spawn({ task: "Race status", sourceRepo: "/source", background: true });
    clients[0].streaming = false;

    await expect(manager.status(started.id)).resolves.toEqual([
      expect.objectContaining({ id: started.id, status: "running", response: undefined }),
    ]);
  });

  it("fails a running agent promptly when its RPC process exits", async () => {
    const { manager, clients } = setup();
    const started = await manager.spawn({ task: "Crash", sourceRepo: "/source", background: true });
    clients[0].stateError = new Error("Agent process exited");
    clients[0].stop.mockRejectedValueOnce(new Error("already exited"));

    await expect(manager.wait(started.id, 100)).resolves.toMatchObject({
      status: "failed",
      error: "Agent process exited",
    });
  });

  it("checks RPC liveness every 500 ms while waiting", async () => {
    vi.useFakeTimers();
    const { manager, clients } = setup();
    const started = await manager.spawn({ task: "Wait", sourceRepo: "/source", background: true });
    const client = clients[0];

    const waiting = manager.wait(started.id, 1000);
    await vi.advanceTimersByTimeAsync(499);
    expect(client.getState).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(client.getState).toHaveBeenCalledOnce();

    client.settle("done");
    await expect(waiting).resolves.toMatchObject({ status: "idle", response: "done" });
  });

  it("reports a failed final assistant response as a failed agent", async () => {
    const { manager, clients } = setup();
    const started = await manager.spawn({ task: "Fail", sourceRepo: "/source", background: true });
    const waiting = manager.wait(started.id, 1000);

    clients[0].emit({
      type: "message_end",
      message: { role: "assistant", stopReason: "error", errorMessage: "Provider failed" },
    });
    clients[0].settle("failed response");

    await expect(waiting).resolves.toMatchObject({ status: "failed", error: "Provider failed" });
  });

  it("uses the final successful assistant message after a retried error", async () => {
    const { manager, clients } = setup();
    const started = await manager.spawn({ task: "Retry", sourceRepo: "/source", background: true });
    const waiting = manager.wait(started.id, 1000);
    clients[0].emit({
      type: "message_end",
      message: { role: "assistant", stopReason: "aborted" },
    });
    clients[0].emit({
      type: "message_end",
      message: { role: "assistant", stopReason: "stop" },
    });
    clients[0].settle("recovered");

    await expect(waiting).resolves.toMatchObject({ status: "idle", response: "recovered", error: undefined });
  });

  it("does not start an agent when shutdown begins during checkout creation", async () => {
    let releaseClone = () => {};
    const cloneBlocked = new Promise<void>((resolve) => { releaseClone = resolve; });
    const { manager, clients, workspaceRoot, cloneRepo } = setup({
      cloneRepo: async (_source, destination) => {
        await cloneBlocked;
        mkdirSync(destination, { recursive: true });
      },
    });

    const spawning = manager.spawn({ task: "Too late", sourceRepo: "/source", background: true });
    await vi.waitFor(() => expect(cloneRepo).toHaveBeenCalledOnce());
    const disposing = manager.dispose();
    releaseClone();

    await expect(spawning).rejects.toThrow("manager is closed");
    await disposing;
    expect(clients).toHaveLength(0);
    expect(existsSync(workspaceRoot)).toBe(false);
  });

  it("cancels a blocked prompt acknowledgement during shutdown", async () => {
    let releasePrompt = () => {};
    const promptBlocked = new Promise<void>((resolve) => { releasePrompt = resolve; });
    const client = new FakeClient();
    client.prompt.mockImplementation(async () => promptBlocked);
    const { manager, workspaceRoot } = setup({ createClient: () => client });

    const spawning = manager.spawn({ task: "Blocked", sourceRepo: "/source", background: true });
    await vi.waitFor(() => expect(client.prompt).toHaveBeenCalledOnce());
    const disposing = manager.dispose();

    try {
      await expect(Promise.race([
        disposing.then(() => "disposed"),
        new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 20)),
      ])).resolves.toBe("disposed");
    } finally {
      releasePrompt();
      await spawning.catch(() => {});
    }
    await expect(spawning).rejects.toThrow("Operation cancelled");
    expect(client.stop).toHaveBeenCalledOnce();
    expect(existsSync(workspaceRoot)).toBe(false);
  });

  it("stops startup and removes its record when the tool call is cancelled", async () => {
    let releasePrompt = () => {};
    const promptBlocked = new Promise<void>((resolve) => { releasePrompt = resolve; });
    const client = new FakeClient();
    client.prompt.mockImplementation(async () => promptBlocked);
    const { manager } = setup({ createClient: () => client });
    const controller = new AbortController();

    const spawning = manager.spawn({
      task: "Cancel me",
      sourceRepo: "/source",
      background: true,
      timeoutMs: 1000,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(client.prompt).toHaveBeenCalledOnce());
    controller.abort();

    try {
      const outcome = await Promise.race([
        spawning.then(() => "resolved", () => "rejected"),
        new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 20)),
      ]);
      expect(outcome).toBe("rejected");
    } finally {
      releasePrompt();
      await spawning.catch(() => {});
    }
    expect(client.stop).toHaveBeenCalledOnce();
    await expect(manager.status()).resolves.toEqual([]);
  });

  it("marks an idle agent failed when a new prompt is cancelled", async () => {
    let releasePrompt = () => {};
    const promptBlocked = new Promise<void>((resolve) => { releasePrompt = resolve; });
    const { manager, clients } = setup();
    const started = await manager.spawn({ task: "First", sourceRepo: "/source", background: true });
    clients[0].settle("first done");
    clients[0].prompt.mockImplementationOnce(async () => promptBlocked);
    const controller = new AbortController();

    const sending = manager.send(started.id, "Second", { timeoutMs: 1000, signal: controller.signal });
    await vi.waitFor(() => expect(clients[0].prompt).toHaveBeenCalledTimes(2));
    clients[0].stop.mockRejectedValueOnce(new Error("already stopped"));
    controller.abort();

    try {
      await expect(Promise.race([
        sending.then(() => "resolved", () => "rejected"),
        new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 20)),
      ])).resolves.toBe("rejected");
    } finally {
      releasePrompt();
      await sending.catch(() => {});
    }
    await expect(manager.status(started.id)).resolves.toEqual([
      expect.objectContaining({ status: "failed", error: "Operation cancelled" }),
    ]);
    await expect(manager.send(started.id, "Too late")).rejects.toThrow(`Agent ${started.id} is failed`);
    await expect(manager.wait(started.id)).resolves.toMatchObject({ status: "failed" });
  });

  it("times out a prompt acknowledgement and tolerates stop failure", async () => {
    const client = new FakeClient();
    client.prompt.mockImplementation(async () => new Promise<void>(() => {}));
    client.stop.mockRejectedValueOnce("stop failed");
    const { manager } = setup({ createClient: () => client });

    await expect(manager.spawn({
      task: "Never acknowledged", sourceRepo: "/source", background: true, timeoutMs: 5,
    })).rejects.toThrow("Agent did not finish within 1 seconds");
    await expect(manager.status()).resolves.toEqual([]);
  });

  it("rejects startup when its signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { manager, clients } = setup();

    await expect(manager.spawn({
      task: "Already cancelled", sourceRepo: "/source", background: true, signal: controller.signal,
    })).rejects.toThrow("Operation cancelled");
    expect(clients[0].stop).toHaveBeenCalledOnce();
  });

  it("cancels waits for both pre-aborted and later-aborted signals", async () => {
    const { manager, clients } = setup();
    const started = await manager.spawn({ task: "Wait", sourceRepo: "/source", background: true });

    const preAborted = new AbortController();
    preAborted.abort();
    await expect(manager.wait(started.id, 1000, preAborted.signal)).rejects.toThrow("Operation cancelled");

    const laterAborted = new AbortController();
    const waiting = manager.wait(started.id, 1000, laterAborted.signal);
    laterAborted.abort();
    await expect(waiting).rejects.toThrow("Operation cancelled");

    clients[0].settle("done");
    await manager.close(started.id);
  });

  it("cleans up when prompt preflight rejects", async () => {
    const client = new FakeClient();
    client.prompt.mockRejectedValueOnce(new Error("prompt rejected"));
    const { manager } = setup({ createClient: () => client });

    await expect(manager.spawn({ task: "Reject", sourceRepo: "/source", background: true }))
      .rejects.toThrow("prompt rejected");
    expect(client.stop).toHaveBeenCalledOnce();
    await expect(manager.status()).resolves.toEqual([]);
  });

  it("supports waiting sends and nullable idle responses", async () => {
    const { manager, clients } = setup();
    const started = await manager.spawn({ task: "First", sourceRepo: "/source", background: true });
    clients[0].settle("first");

    const sending = manager.send(started.id, "Second", { wait: true, timeoutMs: 1000 });
    await vi.waitFor(() => expect(clients[0].prompt).toHaveBeenCalledTimes(2));
    clients[0].settle("second");
    await expect(sending).resolves.toMatchObject({ status: "idle", response: "second" });

    clients[0].response = null;
    await expect(manager.wait(started.id)).resolves.toMatchObject({ response: undefined });
    await expect(manager.status(started.id)).resolves.toEqual([
      expect.objectContaining({ status: "idle", response: undefined }),
    ]);
  });

  it("handles status failure, retained workspaces, stop errors, and repeated disposal", async () => {
    const { manager, clients } = setup();
    const failed = await manager.spawn({ name: " -- ", task: "Fail status", sourceRepo: "/source", background: true });
    expect(failed.name).toBe("agent");
    writeFileSync(join(failed.workspace, "reports.jsonl"), "malformed\n");
    clients[0].stateError = "RPC unavailable";
    await expect(manager.status(failed.id)).resolves.toEqual([
      expect.objectContaining({ status: "failed", error: "RPC unavailable", reports: undefined }),
    ]);
    await expect(manager.status(failed.id)).resolves.toEqual([
      expect.objectContaining({ status: "failed" }),
    ]);

    const retained = await manager.spawn({ name: "retained", task: "Retain", sourceRepo: "/source", background: true });
    clients[1].stop.mockRejectedValueOnce(new Error("stop failed"));
    await expect(manager.close(retained.id, false)).resolves.toMatchObject({
      status: "closed", error: "stop failed",
    });
    expect(existsSync(retained.workspace)).toBe(true);
    await expect(manager.wait(retained.id)).resolves.toMatchObject({ status: "closed" });
    await manager.close(retained.id, true);

    await expect(manager.status("missing")).rejects.toThrow("Unknown ephemeral agent: missing");
    await manager.dispose();
    await manager.dispose();
    await expect(manager.spawn({ task: "After dispose", sourceRepo: "/source" }))
      .rejects.toThrow("manager is closed");
  });

  it("creates and removes its own temporary root when one is not supplied", async () => {
    const manager = new EphemeralAgentManager({
      cliPath: "/package/bin/pi-coding-agent.mjs",
      cloneRepo: async () => { throw "clone failed"; },
      createClient: () => new FakeClient(),
    });
    const root = manager.workspaceRoot;
    expect(existsSync(root)).toBe(true);
    await expect(manager.spawn({ task: "No clone", sourceRepo: "/source" })).rejects.toBe("clone failed");
    await manager.dispose();
    expect(existsSync(root)).toBe(false);
  });

  it("can wait during start and times out without stopping background work", async () => {
    const { manager, clients } = setup();
    const foreground = manager.spawn({ task: "Finish", sourceRepo: "/source", timeoutMs: 1000 });
    await vi.waitFor(() => expect(clients).toHaveLength(1));
    clients[0].settle("done");
    await expect(foreground).resolves.toMatchObject({ status: "idle", response: "done" });

    await expect(manager.spawn({ name: "slow", task: "Keep going", sourceRepo: "/source", timeoutMs: 5 }))
      .rejects.toThrow("did not finish");
    expect(clients[1].stop).not.toHaveBeenCalled();
    await expect(manager.status()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "slow", status: "running" }),
    ]));
  });

  it("lists parallel agents and closes only the selected workspace", async () => {
    const { manager, clients, workspaceRoot } = setup();
    const [one, two] = await Promise.all([
      manager.spawn({ name: "one", task: "One", sourceRepo: "/source", background: true }),
      manager.spawn({ name: "two", task: "Two", sourceRepo: "/source", background: true }),
    ]);
    clients[1].settle("two done");
    writeFileSync(join(two.workspace, "reports.jsonl"), [
      JSON.stringify({ kind: "update", message: "tests pass", timestamp: "2026-08-19T12:00:00.000Z" }),
      JSON.stringify({ kind: "question", message: "need input", timestamp: "2026-08-19T12:01:00.000Z" }),
      JSON.stringify({ kind: "question", message: "missing timestamp" }),
      JSON.stringify({ kind: "unknown", message: "wrong kind", timestamp: "2026-08-19T12:02:00.000Z" }),
      JSON.stringify({ kind: "update", message: 42, timestamp: "2026-08-19T12:03:00.000Z" }),
      JSON.stringify({ kind: "update", message: "bad timestamp", timestamp: 42 }),
      "null",
      "malformed",
    ].join("\n"));

    await expect(manager.status()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: one.id, status: "running" }),
      expect.objectContaining({
        id: two.id, status: "idle", response: "two done",
        reports: [
          { kind: "update", message: "tests pass", timestamp: "2026-08-19T12:00:00.000Z" },
          { kind: "question", message: "need input", timestamp: "2026-08-19T12:01:00.000Z" },
        ],
      }),
    ]));
    await manager.close(one.id);
    expect(clients[0].stop).toHaveBeenCalledOnce();
    expect(existsSync(one.workspace)).toBe(false);
    expect(existsSync(two.workspace)).toBe(true);
    await expect(manager.status()).resolves.not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: one.id }),
    ]));

    await manager.dispose();
    expect(clients[1].stop).toHaveBeenCalledOnce();
    expect(existsSync(workspaceRoot)).toBe(false);
  });

  it("cleans up a workspace when checkout creation fails", async () => {
    const { manager, workspaceRoot, cloneRepo } = setup();
    cloneRepo.mockRejectedValueOnce(new Error("clone failed"));
    await expect(manager.spawn({ task: "Nope", sourceRepo: "/source" })).rejects.toThrow("clone failed");
    expect(readdirSync(workspaceRoot)).toEqual([]);
  });
});
