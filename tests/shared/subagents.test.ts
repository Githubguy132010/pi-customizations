import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExplorerManager, findRepository, type ExplorerHandle } from "../../extensions/shared/subagents/manager";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "pi-subagents-test-")); roots.push(root);
  await exec("git", ["init", "-q"], { cwd: root });
  await exec("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await exec("git", ["config", "user.name", "Test"], { cwd: root });
  await writeFile(join(root, "README.md"), "inventory me\n");
  await exec("git", ["add", "."], { cwd: root });
  await exec("git", ["commit", "-qm", "initial"], { cwd: root });
  return root;
}

async function eventually(check: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out");
}

describe("ExplorerManager", () => {
  it("creates a detached worktree and permanently removes it after success", async () => {
    const repo = await repository();
    const sessions = join(repo, "sessions");
    let observedWorktree = "";
    const handle: ExplorerHandle = {
      run: vi.fn(async () => readFile(join(observedWorktree, "README.md"), "utf8")),
      send: vi.fn(), dispose: vi.fn(),
    };
    const manager = new ExplorerManager(repo, "main/session", async ({ worktree }) => {
      observedWorktree = worktree; return handle;
    }, sessions);
    expect(await manager.spawn("inventory docs")).toMatchObject({ id: "explorer-1", state: "running" });
    await eventually(() => manager.list()[0].state === "completed");
    expect(manager.list()[0]).toMatchObject({ result: "inventory me\n", state: "completed" });
    await expect(access(observedWorktree)).rejects.toThrow();
    expect(handle.dispose).toHaveBeenCalledOnce();
  });

  it("routes messages only to its own running explorers", async () => {
    const repo = await repository();
    let finish!: (value: string) => void;
    const send = vi.fn();
    const manager = new ExplorerManager(repo, "main", async () => ({
      run: () => new Promise((resolve) => { finish = resolve; }), send, dispose: vi.fn(),
    }), join(repo, "sessions"));
    await manager.spawn("inspect");
    await manager.send("explorer-1", "focus on tests");
    expect(send).toHaveBeenCalledWith("focus on tests");
    await expect(manager.send("other-session-agent", "nope")).rejects.toThrow("Unknown explorer");
    finish("done");
    await eventually(() => manager.list()[0].state === "completed");
  });

  it("retains a failed workspace and records the error", async () => {
    const repo = await repository();
    let worktree = "";
    const manager = new ExplorerManager(repo, "main", async (options) => {
      worktree = options.worktree;
      return { run: async () => { throw new Error("model failed"); }, send: vi.fn(), dispose: vi.fn() };
    }, join(repo, "sessions"));
    await manager.spawn("inspect");
    await eventually(() => manager.list()[0].state === "failed");
    expect(manager.list()[0].error).toBe("model failed");
    await expect(access(worktree)).resolves.toBeUndefined();
  });

  it("finds the repository from a nested directory", async () => {
    const repo = await repository();
    expect(await findRepository(repo)).toBe(repo);
  });
});
