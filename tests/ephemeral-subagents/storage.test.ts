import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pathsFor, preparePaths, readMetadata, writeMetadata } from "../../extensions/ephemeral-subagents/storage";

describe("ephemeral agent storage", () => {
  it("organizes private workspaces by session and agent and atomically stores lifecycle data", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-storage-")); const paths = pathsFor(root, "s1", "a1"); await preparePaths(paths);
    expect(paths.repo).toBe(join(root, ".pi-agents", "s1", "a1", "repo")); expect(paths.scratch).toBe(join(root, ".pi-agents", "s1", "a1", "scratch"));
    const metadata = { id: "a1", sessionId: "s1", task: "test", state: "running" as const, createdAt: "now", updatedAt: "now" };
    await writeMetadata(paths, metadata); await expect(readMetadata(paths)).resolves.toEqual(metadata); await expect(readFile(`${paths.metadata}.tmp`, "utf8")).rejects.toThrow();
  });
});
