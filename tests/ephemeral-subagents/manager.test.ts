import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { childEnvironment, defaultInvocation, EphemeralAgentManager } from "../../extensions/ephemeral-subagents/manager";
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
  it("rejects a symlink chain resolving to a development entrypoint", async () => {
    const repoRoot = await repository();
    const script = join(repoRoot, "bin", "pi-coding-agent.mjs");
    const links = await mkdtemp(join(tmpdir(), "pi-links-")); roots.push(links);
    await mkdir(join(repoRoot, "bin"));
    await writeFile(script, "#!/usr/bin/env node\n");
    await symlink(script, join(links, "first"));
    await symlink(join(links, "first"), join(links, "pi-coding-agent"));

    await expect(defaultInvocation(repoRoot, join(links, "pi-coding-agent"))).rejects.toThrow(/development pi-coding-agent entrypoint.*install pi-coding-agent outside/s);
  });

  it("canonicalizes a symlinked external installation for sandbox mounting and invocation", async () => {
    const repoRoot = await repository();
    const installation = await mkdtemp(join(tmpdir(), "pi-install-")); roots.push(installation);
    const links = await mkdtemp(join(tmpdir(), "pi-links-")); roots.push(links);
    const script = join(installation, "bin", "pi-coding-agent.mjs");
    await mkdir(join(installation, "bin"));
    await writeFile(script, "#!/usr/bin/env node\n");
    await symlink(script, join(links, "pi-coding-agent"));

    const invocation = await defaultInvocation(repoRoot, join(links, "pi-coding-agent"));
    expect(invocation.args[0]).toBe(script);
    expect(invocation.env.PI_EPHEMERAL_RUNTIME_ROOT).toBe(installation);
    expect(invocation.command).toBe(await realpath(process.execPath));
  });

  it("surfaces bounded startup stderr through foreground spawn and status while preserving the transcript", async () => {
    const repoRoot = await repository();
    const stderr = `startup module resolution failed: missing-package\n${"x".repeat(20_000)}`;
    const invocation = (): Invocation => ({ command: process.execPath, args: ["-e", `process.stderr.write(${JSON.stringify(stderr)}); process.exit(1)`], env: { PATH: process.env.PATH } });
    const manager = new EphemeralAgentManager({ repoRoot, sessionId: "session", backend: passthrough, invocation });
    await manager.initialize();

    const agent = await manager.spawn({ task: "fail during startup" });
    expect(agent.state).toBe("failed");
    expect(agent.error).toContain("startup module resolution failed: missing-package");
    expect(agent.error).toContain("stderr truncated");
    expect(agent.error!.length).toBeLessThan(17_000);
    expect((await manager.status(agent.id)).error).toBe(agent.error);
    const transcript = await readFile(pathsFor(repoRoot, "session", agent.id).transcript, "utf8");
    expect(transcript).toContain("x".repeat(20_000));
    await manager.cleanup(agent.id);
  });

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

  it("does not execute Git config from a child-replaced .git directory", async () => {
    const repoRoot = await repository();
    const marker = join(repoRoot, "fsmonitor-ran");
    const script = `
      const fs=require("node:fs"), p=require("node:path"), marker=${JSON.stringify(marker)};
      fs.rmSync(".git",{force:true,recursive:true}); fs.mkdirSync(".git");
      const hook=p.join(process.cwd(),"evil-fsmonitor");
      fs.writeFileSync(hook,"#!/bin/sh\\ntouch " + JSON.stringify(marker) + "\\n"); fs.chmodSync(hook,0o755);
      fs.writeFileSync(".git/config","[core]\\nrepositoryformatversion = 0\\nbare = false\\nfsmonitor = " + hook + "\\n");
      console.log(JSON.stringify({type:"agent_end"}));`;
    const invocation = (): Invocation => ({ command: process.execPath, args: ["-e", script], env: { PATH: process.env.PATH } });
    const manager = new EphemeralAgentManager({ repoRoot, sessionId: "session", backend: passthrough, invocation });
    await manager.initialize(); const agent = await manager.spawn({ task: "attack" });
    expect(agent.state).toBe("completed");
    await expect(access(marker)).rejects.toThrow();
    const paths = pathsFor(repoRoot, "session", agent.id);
    const hook = join(paths.repo, "evil-fsmonitor");
    await rm(join(paths.repo, ".git"), { recursive: true, force: true });
    await symlink(hook, join(paths.repo, ".git"));
    await manager.cleanup(agent.id);
  });
});
