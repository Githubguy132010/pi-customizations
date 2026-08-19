import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EphemeralAgentManager } from "../../extensions/shared/ephemeralAgents";

class FakeClient {
  streaming = false;
  response = "finished";
  listeners: Array<(event: { type: string }) => void> = [];
  start = vi.fn(async () => {});
  stop = vi.fn(async () => {});
  prompt = vi.fn(async () => { this.streaming = true; this.emit("agent_start"); });
  followUp = vi.fn(async () => {});
  getState = vi.fn(async () => ({ isStreaming: this.streaming }));
  getLastAssistantText = vi.fn(async () => this.response);
  onEvent = vi.fn((listener: (event: { type: string }) => void) => {
    this.listeners.push(listener);
    return () => { this.listeners = this.listeners.filter((candidate) => candidate !== listener); };
  });

  settle(response = this.response) {
    this.response = response;
    this.streaming = false;
    this.emit("agent_settled");
  }

  private emit(type: string) {
    for (const listener of this.listeners) listener({ type });
  }
}

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function setup() {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "ephemeral-manager-test-"));
  roots.push(workspaceRoot);
  const clients: FakeClient[] = [];
  const clientOptions: unknown[] = [];
  const cloneRepo = vi.fn(async (_source: string, destination: string) => { mkdirSync(destination, { recursive: true }); });
  const manager = new EphemeralAgentManager({
    cliPath: "/package/bin/pi-coding-agent.mjs",
    workspaceRoot,
    cloneRepo,
    createClient: (options) => {
      clientOptions.push(options);
      const client = new FakeClient();
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
    expect(cloneRepo).toHaveBeenCalledWith("/source", result.repo);
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

  it("receives completion, queues follow-ups, and starts a fresh turn when idle", async () => {
    const { manager, clients } = setup();
    const started = await manager.spawn({ task: "First task", sourceRepo: "/source", background: true });
    const client = clients[0];

    await manager.send(started.id, "Also check tests");
    expect(client.followUp).toHaveBeenCalledWith("Also check tests");

    const waiting = manager.wait(started.id, 1000);
    client.settle("first answer");
    await expect(waiting).resolves.toMatchObject({ status: "idle", response: "first answer" });

    await manager.send(started.id, "Now summarize");
    expect(client.prompt).toHaveBeenLastCalledWith("Now summarize");
    const secondWait = manager.wait(started.id, 1000);
    client.settle("second answer");
    await expect(secondWait).resolves.toMatchObject({ status: "idle", response: "second answer" });
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
      "malformed",
    ].join("\n"));

    await expect(manager.status()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: one.id, status: "running" }),
      expect.objectContaining({
        id: two.id, status: "idle", response: "two done",
        reports: [{ kind: "update", message: "tests pass", timestamp: "2026-08-19T12:00:00.000Z" }],
      }),
    ]));
    await manager.close(one.id);
    expect(clients[0].stop).toHaveBeenCalledOnce();
    expect(existsSync(one.workspace)).toBe(false);
    expect(existsSync(two.workspace)).toBe(true);

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
