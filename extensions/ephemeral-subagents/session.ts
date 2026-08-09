import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Session } from "./types.ts";
const exec = promisify(execFile);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export class SessionStore {
  readonly baseDir: string; constructor(baseDir = join(tmpdir(), "pi-ephemeral-subagents")) { this.baseDir = baseDir; }
  async create(repoRoot: string, jobId: string): Promise<Session> {
    const canonical = resolve(repoRoot);
    const info = await stat(canonical).catch(() => undefined);
    if (!info?.isDirectory()) throw new Error(`repository moved or missing: ${canonical}`);
    await mkdir(this.baseDir, { recursive: true, mode: 0o700 });
    const root = await mkdtemp(join(this.baseDir, `${jobId}-`));
    const repos = join(root, "repos"); await mkdir(repos, { mode: 0o700 });
    const worktree = join(repos, basename(canonical));
    try {
      await this.gitRetry(["-C", canonical, "worktree", "add", "--detach", "--no-checkout", worktree, "HEAD"]);
      await exec("git", ["-C", worktree, "checkout", "--force", "HEAD"], { timeout: 60_000 });
      return { root, worktree, repoRoot: canonical };
    } catch (e) { await this.remove({ root, worktree, repoRoot: canonical }).catch(() => {}); throw new Error(`worktree creation failed: ${e instanceof Error ? e.message : e}`); }
  }
  private async gitRetry(args: string[]) {
    let last: unknown;
    for (let i = 0; i < 4; i++) { try { return await exec("git", args, { timeout: 60_000 }); } catch (e) { last = e; await sleep(40 * 2 ** i); } }
    throw last;
  }
  async diskUsage(session: Session): Promise<number> { const { stdout } = await exec("du", ["-sk", session.root], { timeout: 30_000 }); const kib = Number.parseInt(stdout, 10); if (!Number.isFinite(kib)) throw new Error("could not measure session disk use"); return kib * 1024; }
  async remove(session: Session): Promise<void> {
    let error: unknown;
    for (let i = 0; i < 4; i++) {
      try {
        await exec("git", ["-C", session.repoRoot, "worktree", "remove", "--force", session.worktree], { timeout: 30_000 }).catch(() => {});
        await rm(session.root, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
        return;
      } catch (e) { error = e; await sleep(50 * 2 ** i); }
    }
    throw error;
  }
  async reapStale(repoRoot?: string, maxAgeMs = 24 * 60 * 60_000): Promise<string[]> {
    const removed: string[] = []; const now = Date.now();
    for (const name of await readdir(this.baseDir).catch(() => [])) {
      const root = join(this.baseDir, name); const s = await stat(root).catch(() => undefined);
      if (!s || now - s.mtimeMs <= maxAgeMs) continue;
      if (repoRoot) {
        const repos = join(root, "repos");
        for (const child of await readdir(repos).catch(() => [])) {
          await exec("git", ["-C", repoRoot, "worktree", "remove", "--force", join(repos, child)], { timeout: 30_000 }).catch(() => {});
        }
      }
      await rm(root, { recursive: true, force: true, maxRetries: 3 }).catch(() => {}); removed.push(root);
    }
    if (repoRoot) await exec("git", ["-C", repoRoot, "worktree", "prune", "--expire", "now"], { timeout: 30_000 }).catch(() => {});
    return removed;
  }
}
