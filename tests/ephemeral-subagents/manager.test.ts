import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { childEnvironment, EphemeralAgentManager } from "../../extensions/ephemeral-subagents/manager";
import type { Invocation, SandboxBackend } from "../../extensions/ephemeral-subagents/sandbox";
import { pathsFor } from "../../extensions/ephemeral-subagents/storage";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

const passthrough: SandboxBackend = { name: "test", async wrap(invocation) { return invocation; } };
const childScript = `process.stdin.once("data",()=>setTimeout(()=>{console.log(JSON.stringify({type:"agent_end"}));},250));`;
async function waitFor(check: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) { if (Date.now() >= deadline) throw new Error("condition timed out"); await new Promise((resolve) => setTimeout(resolve, 25)); }
}

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-manager-")); roots.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "initial"], { cwd: root });
  return root;
}

describe("ephemeral agent manager", () => {
  it("holds a concurrency slot until the child actually finishes", async () => {
    const repoRoot = await repository();
    const invocation = (): Invocation => ({ command: process.execPath, args: ["-e", childScript], env: { PATH: process.env.PATH } });
    const manager = new EphemeralAgentManager({ repoRoot, sessionId: "session", concurrency: 1, backend: passthrough, invocation });
    await manager.initialize();
    const first = await manager.spawn({ task: "one", background: true });
    const second = await manager.spawn({ task: "two", background: true });
    await waitFor(async () => typeof (await manager.status(first.id)).pid === "number");
    expect((await manager.status(first.id)).pid).toEqual(expect.any(Number));
    expect((await manager.status(second.id)).pid).toBeUndefined();
    await waitFor(async () => typeof (await manager.status(second.id)).pid === "number");
    expect((await manager.status(second.id)).pid).toEqual(expect.any(Number));
    await waitFor(async () => (await manager.status(second.id)).state === "completed");
    await manager.cleanup(first.id); await manager.cleanup(second.id);
  });

  it("records a cleanup failure instead of leaving a permanent cleaning_up state", async () => {
    const repoRoot = await repository();
    const invocation = (): Invocation => ({ command: process.execPath, args: ["-e", childScript], env: { PATH: process.env.PATH } });
    const manager = new EphemeralAgentManager({ repoRoot, sessionId: "session", concurrency: 1, backend: passthrough, invocation });
    await manager.initialize(); const agent = await manager.spawn({ task: "one" });
    const paths = pathsFor(repoRoot, "session", agent.id);
    execFileSync("git", ["worktree", "lock", paths.repo], { cwd: repoRoot });
    await expect(manager.cleanup(agent.id)).rejects.toThrow();
    expect((await manager.status(agent.id)).state).toBe("failed");
    expect((await manager.status(agent.id)).error).toMatch(/cleanup failed after retries/);
    execFileSync("git", ["worktree", "unlock", paths.repo], { cwd: repoRoot });
    await manager.cleanup(agent.id);
  });

  it("passes required runtime credentials without unrelated parent secrets", () => {
    const env = childEnvironment("/opt/pi", { PATH: "/bin", OPENAI_API_KEY: "needed", GITHUB_TOKEN: "secret", RANDOM_SECRET: "secret" });
    expect(env).toEqual({ PI_EPHEMERAL_RUNTIME_ROOT: "/opt/pi", PATH: "/bin", OPENAI_API_KEY: "needed" });
  });

  it("releases a setup slot even when failure notification throws", async () => {
    const repoRoot = await repository();
    const failingBackend: SandboxBackend = { name: "failing", async wrap() { throw new Error("sandbox failed"); } };
    const invocation = (): Invocation => ({ command: process.execPath, args: [], env: {} });
    const manager = new EphemeralAgentManager({ repoRoot, sessionId: "session", concurrency: 1, backend: failingBackend, invocation, onNudge: () => { throw new Error("notification failed"); } });
    await manager.initialize();
    const first = await manager.spawn({ task: "one", background: true });
    await waitFor(async () => (await manager.status(first.id)).state === "failed");
    const second = await manager.spawn({ task: "two", background: true });
    await waitFor(async () => (await manager.status(second.id)).state === "failed");
  });
});
