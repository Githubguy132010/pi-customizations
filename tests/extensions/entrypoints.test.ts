import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import bashOnly from "../../extensions/bash-only";
import ephemeralAgents, { cloneIsolatedRepo, createRpcClient } from "../../extensions/ephemeral-agents";
import settle from "../../extensions/settle";
import sessionWorkdir from "../../extensions/session-workdir";
import slashVisibility from "../../extensions/slash-command-visibility";
import yeet from "../../extensions/yeet";
import { createContext, createPi, result } from "../helpers";

const execFileAsync = promisify(execFile);

function handlers(pi: any) {
  return Object.fromEntries(pi.on.mock.calls.map(([name, handler]: any[]) => [name, handler]));
}

function agentSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    id: "agent-1",
    name: "agent",
    status: "idle",
    workspace: "/tmp/agent-1",
    repo: "/tmp/agent-1/scratch/repo",
    ...overrides,
  } as any;
}

function createAgentController() {
  const snapshot = agentSnapshot();
  return {
    spawn: vi.fn(async () => snapshot),
    status: vi.fn(async () => [snapshot]),
    send: vi.fn(async () => snapshot),
    wait: vi.fn(async () => snapshot),
    close: vi.fn(async () => snapshot),
    dispose: vi.fn(async () => {}),
  };
}

describe("extension entrypoints", () => {
  it("bash-only registers guards for lifecycle and tool calls", () => {
    const pi = createPi({
      getActiveTools: vi.fn(() => ["read", "bash"]),
      getAllTools: vi.fn(() => [{ name: "bash" }, { name: "ephemeral_agent" }]),
    });
    bashOnly(pi);
    const h = handlers(pi);
    h.session_start(); h.before_agent_start();
    expect(pi.setActiveTools).toHaveBeenCalledTimes(2);
    expect(pi.setActiveTools).toHaveBeenCalledWith(["bash", "ephemeral_agent"]);
    expect(h.tool_call({ toolName: "bash" })).toBeUndefined();
    expect(h.tool_call({ toolName: "ephemeral_agent" })).toBeUndefined();
    expect(h.tool_call({ toolName: "ephemeral_report" })).toBeUndefined();
    expect(h.tool_call({ toolName: "read" })).toEqual({ block: true, terminate: true });
  });

  it("does not reset the allowed toolset when only its order differs", () => {
    const pi = createPi({
      getActiveTools: vi.fn(() => ["ephemeral_agent", "bash"]),
      getAllTools: vi.fn(() => [{ name: "bash" }, { name: "ephemeral_agent" }]),
    });
    bashOnly(pi);

    handlers(pi).session_start();

    expect(pi.setActiveTools).not.toHaveBeenCalled();
  });

  it("ephemeral-agents registers its parallel management tool and cleans up on shutdown", async () => {
    const pi = createPi(); ephemeralAgents(pi);
    expect(pi.registerTool).toHaveBeenCalledWith(expect.objectContaining({
      name: "ephemeral_agent", executionMode: "parallel", execute: expect.any(Function),
    }));
    const tool = pi.registerTool.mock.calls[0][0];
    await expect(tool.execute("call", { action: "status" }, undefined, undefined, createContext()))
      .resolves.toMatchObject({ isError: false });
    await handlers(pi).session_shutdown({}, createContext());
  });

  it("creates the production RPC client without starting a process", () => {
    const client = createRpcClient({ cliPath: "/unused" });
    expect(client).toBeInstanceOf(RpcClient);
    expect(client.followUp).toBe(RpcClient.prototype.followUp);
  });

  it("routes every ephemeral-agent action through the controller", async () => {
    const manager = createAgentController();
    const pi = createPi({ exec: vi.fn(async () => result("/repo\n")) });
    ephemeralAgents(pi, manager);
    const tool = pi.registerTool.mock.calls[0][0];
    const signal = new AbortController().signal;
    const ctx = createContext({ model: { provider: "openai", id: "gpt-test" }, thinkingLevel: "high" });

    await tool.execute("start", {
      action: "start", task: " Inspect ", name: "review", background: true, timeout_seconds: 5,
    }, signal, undefined, ctx);
    expect(manager.spawn).toHaveBeenCalledWith(expect.objectContaining({
      task: "Inspect", sourceRepo: "/repo", background: true, timeoutMs: 5000, signal,
      model: { provider: "openai", id: "gpt-test" }, thinkingLevel: "high",
    }));

    await tool.execute("status", {
      action: "status", id: "agent-1", timeout_seconds: 5,
    }, signal, undefined, ctx);
    expect(manager.status).toHaveBeenCalledWith("agent-1", 5000, signal);

    await tool.execute("message", {
      action: "message", id: " agent-1 ", message: " Continue ", wait: true,
    }, signal, undefined, ctx);
    expect(manager.send).toHaveBeenCalledWith("agent-1", "Continue", {
      wait: true, timeoutMs: 600000, signal,
    });

    await tool.execute("wait", { action: "wait", id: "agent-1" }, signal, undefined, ctx);
    expect(manager.wait).toHaveBeenCalledWith("agent-1", 600000, signal);

    await tool.execute("close", {
      action: "close", id: "agent-1", remove_workspace: false,
    }, signal, undefined, ctx);
    expect(manager.close).toHaveBeenCalledWith("agent-1", false);

    await handlers(pi).session_shutdown();
    expect(manager.dispose).toHaveBeenCalledOnce();
  });

  it("returns action validation and controller failures as tool errors", async () => {
    const manager = createAgentController();
    const pi = createPi({ exec: vi.fn(async () => result("", 1, "not a repo")) });
    ephemeralAgents(pi, manager);
    const tool = pi.registerTool.mock.calls[0][0];
    const ctx = createContext();

    await expect(tool.execute("start", { action: "start", task: "task" }, undefined, undefined, ctx))
      .resolves.toMatchObject({ isError: true, content: [{ text: "Start ephemeral agents from inside a Git repository" }] });
    await expect(tool.execute("message", { action: "message", id: " ", message: "x" }, undefined, undefined, ctx))
      .resolves.toMatchObject({ isError: true, content: [{ text: "id is required for this action" }] });
    await expect(tool.execute("wait", { action: "wait" }, undefined, undefined, ctx))
      .resolves.toMatchObject({ isError: true });
    await expect(tool.execute("close", { action: "close", id: " " }, undefined, undefined, ctx))
      .resolves.toMatchObject({ isError: true });

    manager.status.mockRejectedValueOnce("status failed");
    await expect(tool.execute("status", { action: "status" }, undefined, undefined, ctx))
      .resolves.toMatchObject({ isError: true, content: [{ text: "status failed" }] });
  });

  it("applies defaults for start, message, and close actions", async () => {
    const manager = createAgentController();
    const pi = createPi({ exec: vi.fn(async () => result("/repo\n")) });
    ephemeralAgents(pi, manager);
    const tool = pi.registerTool.mock.calls[0][0];
    const ctx = createContext();

    await tool.execute("start", { action: "start", task: "task" }, undefined, undefined, ctx);
    expect(manager.spawn).toHaveBeenCalledWith(expect.objectContaining({
      background: false, timeoutMs: 600000, model: undefined,
    }));

    await tool.execute("message", {
      action: "message", id: "agent-1", message: "next",
    }, undefined, undefined, ctx);
    expect(manager.send).toHaveBeenCalledWith("agent-1", "next", expect.objectContaining({ wait: false }));

    await tool.execute("close", { action: "close", id: "agent-1" }, undefined, undefined, ctx);
    expect(manager.close).toHaveBeenCalledWith("agent-1", true);

    await expect(tool.execute("start", { action: "start", task: " " }, undefined, undefined, ctx))
      .resolves.toMatchObject({ isError: true, content: [{ text: "task is required for this action" }] });
    await expect(tool.execute("message", {
      action: "message", id: "agent-1", message: " ",
    }, undefined, undefined, ctx)).resolves.toMatchObject({
      isError: true, content: [{ text: "message is required for this action" }],
    });
  });

  it("ephemeral-agents gives child processes a parent-reporting tool", async () => {
    const root = mkdtempSync(join(tmpdir(), "ephemeral-report-test-"));
    const mailbox = join(root, "reports.jsonl");
    vi.stubEnv("PI_EPHEMERAL_SUBAGENT", "child-1");
    vi.stubEnv("PI_EPHEMERAL_MAILBOX", mailbox);
    try {
      const pi = createPi(); ephemeralAgents(pi);
      expect(pi.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "ephemeral_report" }));
      const tool = pi.registerTool.mock.calls[0][0];
      await expect(tool.execute("call", { kind: "question", message: " Need input " }))
        .resolves.toMatchObject({ isError: false });
      expect(JSON.parse(readFileSync(mailbox, "utf8"))).toMatchObject({ kind: "question", message: "Need input" });
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires a mailbox and non-empty child report messages", async () => {
    vi.stubEnv("PI_EPHEMERAL_SUBAGENT", "child-1");
    vi.stubEnv("PI_EPHEMERAL_MAILBOX", undefined);
    try {
      const withoutMailbox = createPi();
      ephemeralAgents(withoutMailbox);
      expect(withoutMailbox.registerTool).not.toHaveBeenCalled();

      vi.stubEnv("PI_EPHEMERAL_MAILBOX", join(tmpdir(), "unused-ephemeral-mailbox.jsonl"));
      const pi = createPi();
      ephemeralAgents(pi);
      const tool = pi.registerTool.mock.calls[0][0];
      await expect(tool.execute("call", { kind: "update", message: "  " }))
        .resolves.toMatchObject({ isError: true, content: [{ text: "message is required" }] });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("creates agent checkouts without a remote back to the source repository", async () => {
    const root = mkdtempSync(join(tmpdir(), "ephemeral-checkout-test-"));
    const source = join(root, "source");
    const destination = join(root, "agent");
    try {
      await execFileAsync("git", ["init", "--quiet", source]);
      await execFileAsync("git", ["-C", source, "config", "user.email", "test@example.invalid"]);
      await execFileAsync("git", ["-C", source, "config", "user.name", "Test"]);
      writeFileSync(join(source, "README.md"), "source\n");
      await execFileAsync("git", ["-C", source, "add", "README.md"]);
      await execFileAsync("git", ["-C", source, "commit", "--quiet", "-m", "base"]);

      const pi = createPi({
        exec: vi.fn(async (command: string, args: string[], options: { cwd?: string } = {}) => {
          try {
            const result = await execFileAsync(command, args, { cwd: options.cwd });
            return { code: 0, stdout: result.stdout, stderr: result.stderr, killed: false };
          } catch (error: any) {
            return { code: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? error.message, killed: false };
          }
        }),
      });

      await cloneIsolatedRepo(pi, source, destination);
      const remotes = await execFileAsync("git", ["-C", destination, "remote"]);
      expect(remotes.stdout.trim()).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports checkout and isolation command failures", async () => {
    const cloneFailure = createPi({ exec: vi.fn(async () => result("", 1, "clone failed")) });
    await expect(cloneIsolatedRepo(cloneFailure, "/source", "/destination"))
      .rejects.toThrow("Could not create the agent checkout: clone failed");

    const isolationFailure = createPi({
      exec: vi.fn()
        .mockResolvedValueOnce(result())
        .mockResolvedValueOnce(result("", 1, "remove failed")),
    });
    await expect(cloneIsolatedRepo(isolationFailure, "/source", "/destination"))
      .rejects.toThrow("Could not isolate the agent checkout: remove failed");
  });

  it("settle registers its command, integration, and status cleanup", async () => {
    const pi = createPi(); settle(pi);
    expect(pi.registerCommand).toHaveBeenCalledWith("settle", expect.objectContaining({ description: expect.any(String), handler: expect.any(Function) }));
    const ctx = createContext();
    handlers(pi).session_shutdown({}, ctx);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("settle", undefined);
    const request: any = {}; pi.events.emit("pi-customizations:settle-workflow-request", request);
    expect(request.workflow).toEqual(expect.any(Function));
    const noUi = createContext({ hasUI: false });
    await request.workflow("", noUi);
    expect(noUi.ui.notify).toHaveBeenCalledWith("/settle requires interactive UI for now", "warning");
    await pi.registerCommand.mock.calls[0][1].handler("", noUi);
  });

  it("yeet registers its command and clears status on shutdown", async () => {
    const pi = createPi(); yeet(pi);
    expect(pi.registerCommand).toHaveBeenCalledWith("yeet", expect.objectContaining({ description: expect.any(String), handler: expect.any(Function) }));
    const ctx = createContext(); handlers(pi).session_shutdown({}, ctx);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("yeet", undefined);
    const command = pi.registerCommand.mock.calls[0][1];
    const noUi = createContext({ hasUI: false });
    await command.handler("", noUi);
    expect(noUi.ui.notify).toHaveBeenCalledWith("/yeet requires interactive UI for now", "warning");
  });

  it("session-workdir registers lifecycle handlers and resolver", () => {
    const pi = createPi(); sessionWorkdir(pi);
    expect(pi.on.mock.calls.map((call: any[]) => call[0])).toEqual(["session_start", "session_shutdown"]);
    const request: any = {}; pi.events.emit("pi-customizations:workdir-resolver-request", request);
    expect(request.resolver).toEqual(expect.any(Function));
    const ctx = createContext({ cwd: process.cwd(), sessionManager: { getEntries: vi.fn(() => []), getCwd: vi.fn(() => process.cwd()) } });
    const h = handlers(pi); h.session_start({ reason: "startup" }, ctx); h.session_shutdown({ reason: "quit" }, ctx);
    expect(pi.appendEntry).toHaveBeenCalledTimes(2);
  });
});

describe("slash command visibility", () => {
  it("wraps autocomplete and removes hidden slash commands", async () => {
    const pi = createPi(); slashVisibility(pi);
    const ctx = createContext(); handlers(pi).session_start({}, ctx);
    expect(ctx.ui.addAutocompleteProvider).toHaveBeenCalledOnce();

    const applyCompletion = vi.fn(() => ({ lines: ["done"], cursorLine: 0, cursorCol: 4 }));
    const current = {
      triggerCharacters: ["/"],
      getSuggestions: vi.fn().mockResolvedValue({ prefix: "/", items: [{ value: "name" }, { value: "settle" }, { value: "compact" }] }),
      applyCompletion,
      shouldTriggerFileCompletion: vi.fn(() => false),
    };
    const provider = ctx.ui.addAutocompleteProvider.mock.calls[0][0](current);
    await expect(provider.getSuggestions(["/"], 0, 1, {})).resolves.toEqual({ prefix: "/", items: [{ value: "settle" }] });
    expect(provider.applyCompletion([], 0, 0, { value: "settle" }, "/")).toEqual({ lines: ["done"], cursorLine: 0, cursorCol: 4 });
    expect(provider.shouldTriggerFileCompletion([], 0, 0)).toBe(false);
  });

  it("passes through non-slash/null suggestions and returns null when all are hidden", async () => {
    const pi = createPi(); slashVisibility(pi); const ctx = createContext(); handlers(pi).session_start({}, ctx);
    const make = (suggestions: any, trigger?: any) => ctx.ui.addAutocompleteProvider.mock.calls[0][0]({
      triggerCharacters: [], getSuggestions: vi.fn().mockResolvedValue(suggestions), applyCompletion: vi.fn(), shouldTriggerFileCompletion: trigger,
    });
    const ordinary = { prefix: "abc", items: [{ value: "name" }] };
    await expect(make(ordinary).getSuggestions([], 0, 0, {})).resolves.toBe(ordinary);
    await expect(make(null).getSuggestions([], 0, 0, {})).resolves.toBeNull();
    await expect(make({ prefix: "/n", items: [{ value: "name" }] }).getSuggestions([], 0, 0, {})).resolves.toBeNull();
    expect(make(ordinary).shouldTriggerFileCompletion([], 0, 0)).toBe(true);
  });
});
