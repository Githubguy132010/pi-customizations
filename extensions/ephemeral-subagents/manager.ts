import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import type { AgentMetadata, AgentPaths, AgentSnapshot, SpawnRequest } from "./types";
import { ensureIgnored, findMetadata, pathsFor, preparePaths, readMetadata, removeEmptyParents, writeJsonAtomic, writeMetadata } from "./storage";
import { platformBackend, type Invocation, type SandboxBackend } from "./sandbox";

const execFileAsync = promisify(execFile);
const terminal = new Set(["completed", "failed", "timed_out", "cancelled"]);
interface LiveAgent { paths: AgentPaths; metadata: AgentMetadata; process: ChildProcessWithoutNullStreams; outputBuffer: string; slotReleased: boolean; timer?: NodeJS.Timeout; requestTimer?: NodeJS.Timeout; resolve: (value: AgentSnapshot) => void; promise: Promise<AgentSnapshot>; }
export interface ManagerOptions { repoRoot: string; sessionId?: string; concurrency?: number; backend?: SandboxBackend; invocation?: () => Invocation; onNudge?: (agent: AgentMetadata) => void; }

export class EphemeralAgentManager {
  readonly sessionId: string;
  readonly agentsRoot: string;
  private readonly live = new Map<string, LiveAgent>();
  private readonly pending: Array<() => void> = [];
  private active = 0;
  private readonly concurrency: number;
  constructor(private readonly options: ManagerOptions) {
    this.sessionId = options.sessionId ?? randomUUID();
    this.agentsRoot = join(options.repoRoot, ".pi-agents");
    this.concurrency = Math.max(1, options.concurrency ?? Number(process.env.PI_SUBAGENT_CONCURRENCY ?? 4));
  }

  async initialize(): Promise<void> {
    const excludeOutput = (await execFileAsync("git", ["rev-parse", "--git-path", "info/exclude"], { cwd: this.options.repoRoot })).stdout.trim();
    const exclude = excludeOutput.startsWith("/") ? excludeOutput : join(this.options.repoRoot, excludeOutput);
    await ensureIgnored(exclude);
    await this.recover();
  }

  async spawn(request: SpawnRequest): Promise<AgentSnapshot> {
    if (!request.task.trim()) throw new Error("task must not be empty");
    const id = randomUUID().slice(0, 12);
    const paths = pathsFor(this.options.repoRoot, this.sessionId, id);
    const now = new Date().toISOString();
    const metadata: AgentMetadata = { id, sessionId: this.sessionId, task: request.task, state: "running", createdAt: now, updatedAt: now };
    await preparePaths(paths);
    await writeMetadata(paths, metadata);
    const run = async () => this.start(paths, metadata, request.timeoutMs);
    const promise = this.active < this.concurrency ? run() : new Promise<AgentSnapshot>((resolve, reject) => this.pending.push(() => void run().then(resolve, reject)));
    if (request.background) return { ...metadata, workspacePresent: true };
    return promise;
  }

  private async start(paths: AgentPaths, metadata: AgentMetadata, timeoutMs = 30 * 60_000): Promise<AgentSnapshot> {
    this.active++;
    try {
      await execFileAsync("git", ["worktree", "add", "--detach", paths.repo, "HEAD"], { cwd: this.options.repoRoot });
      const base = this.options.invocation?.() ?? this.defaultInvocation();
      const invocation = await (this.options.backend ?? platformBackend()).wrap(base, paths);
      const child = spawn(invocation.command, invocation.args, { cwd: paths.repo, env: { ...invocation.env, PI_EPHEMERAL_PATHS: JSON.stringify(paths) }, stdio: ["pipe", "pipe", "pipe"], detached: true });
      metadata.pid = child.pid; metadata.updatedAt = new Date().toISOString(); await writeMetadata(paths, metadata);
      let resolve!: (value: AgentSnapshot) => void;
      const promise = new Promise<AgentSnapshot>((r) => { resolve = r; });
      const live: LiveAgent = { paths, metadata, process: child, outputBuffer: "", slotReleased: false, resolve, promise };
      this.live.set(metadata.id, live);
      child.stdout.on("data", (data) => void this.consume(live, data.toString()));
      child.stderr.on("data", (data) => void appendFile(paths.transcript, JSON.stringify({ type: "stderr", text: data.toString() }) + "\n"));
      child.on("error", (error) => void this.finish(live, "failed", undefined, error.message));
      child.on("close", (code) => void this.finish(live, code === 0 ? "completed" : "failed", code ?? undefined));
      live.timer = setTimeout(() => { this.kill(child); void this.finish(live, "timed_out", undefined, `timed out after ${timeoutMs}ms`); }, timeoutMs);
      live.requestTimer = setInterval(() => void this.checkRequest(live), 200);
      child.stdin.write(`${JSON.stringify({ type: "prompt", message: metadata.task })}\n`);
      return promise;
    } catch (error) {
      metadata.state = "failed"; metadata.error = error instanceof Error ? error.message : String(error); metadata.updatedAt = new Date().toISOString();
      try {
        await writeMetadata(paths, metadata);
        try { this.options.onNudge?.(metadata); } catch { /* notifications must not consume a slot */ }
        return { ...metadata, workspacePresent: true };
      } finally {
        this.releaseSlot();
      }
    }
  }

  private async checkRequest(live: LiveAgent): Promise<void> {
    if (live.metadata.state === "waiting_for_input" || terminal.has(live.metadata.state)) return;
    try {
      const request = JSON.parse(await readFile(live.paths.request, "utf8")) as { question?: string };
      if (!request.question) return;
      live.metadata.state = "waiting_for_input"; live.metadata.question = request.question; live.metadata.updatedAt = new Date().toISOString();
      await writeMetadata(live.paths, live.metadata); this.options.onNudge?.(live.metadata);
    } catch { /* no request */ }
  }

  private defaultInvocation(): Invocation {
    const script = process.argv[1];
    if (!script) throw new Error("cannot locate the pi-coding-agent executable");
    const runtimeRoot = dirname(dirname(script));
    if (!relative(this.options.repoRoot, runtimeRoot).startsWith("..")) throw new Error("secure subagents require pi-coding-agent to be installed outside the repository checkout; the development entrypoint cannot be exposed without also exposing the parent checkout");
    return { command: process.execPath, args: [script, "--mode", "rpc", "--no-session"], env: childEnvironment(runtimeRoot) };
  }

  private async consume(live: LiveAgent, chunk: string): Promise<void> {
    await appendFile(live.paths.transcript, chunk);
    live.outputBuffer += chunk;
    const lines = live.outputBuffer.split("\n");
    live.outputBuffer = lines.pop() ?? "";
    for (const line of lines) {
      try {
        const event = JSON.parse(line) as any;
        if (event.type === "message_end" && event.message?.role === "assistant") live.metadata.result = event.message.content?.filter((x: any) => x.type === "text").map((x: any) => x.text).join("\n") || live.metadata.result;
        if (event.type === "agent_end") { this.kill(live.process); await this.finish(live, "completed", 0); }
      } catch { /* partial line is still preserved */ }
    }
  }

  private async finish(live: LiveAgent, state: AgentMetadata["state"], exitCode?: number, error?: string): Promise<void> {
    if (terminal.has(live.metadata.state)) return;
    if (live.timer) clearTimeout(live.timer);
    if (live.requestTimer) clearInterval(live.requestTimer);
    live.metadata.state = state; live.metadata.exitCode = exitCode; live.metadata.error = error; live.metadata.updatedAt = new Date().toISOString();
    try { live.metadata.changeSummary = (await execFileAsync("git", ["status", "--short"], { cwd: live.paths.repo })).stdout; } catch { /* keep result */ }
    try {
      await writeMetadata(live.paths, live.metadata);
    } catch (persistError) {
      live.metadata.state = "failed";
      live.metadata.error = `could not persist terminal state: ${persistError instanceof Error ? persistError.message : String(persistError)}`;
    } finally {
      this.live.delete(live.metadata.id);
      try { this.options.onNudge?.(live.metadata); } catch { /* notifications are non-critical */ }
      if (!live.slotReleased) { live.slotReleased = true; this.releaseSlot(); }
      live.resolve({ ...live.metadata, workspacePresent: true });
    }
  }

  async status(id: string): Promise<AgentSnapshot> {
    const live = this.live.get(id); const paths = live?.paths ?? pathsFor(this.options.repoRoot, this.sessionId, id);
    const metadata = live?.metadata ?? await readMetadata(paths);
    return { ...metadata, workspacePresent: true };
  }

  async message(id: string, message: string): Promise<AgentSnapshot> {
    const live = this.live.get(id); if (!live) throw new Error(`agent ${id} is not running`);
    if (live.metadata.state === "waiting_for_input") await writeJsonAtomic(live.paths.response, { message });
    else live.process.stdin.write(`${JSON.stringify({ type: "follow_up", message })}\n`);
    live.metadata.state = "running"; live.metadata.question = undefined; live.metadata.updatedAt = new Date().toISOString(); await writeMetadata(live.paths, live.metadata);
    return { ...live.metadata, workspacePresent: true };
  }

  async cancel(id: string): Promise<AgentSnapshot> { const live = this.live.get(id); if (!live) throw new Error(`agent ${id} is not running`); this.kill(live.process); await this.finish(live, "cancelled"); return this.status(id); }
  private kill(child: ChildProcessWithoutNullStreams): void { try { if (child.pid) process.kill(-child.pid, "SIGTERM"); else child.kill("SIGTERM"); } catch { child.kill("SIGTERM"); } }
  private releaseSlot(): void { this.active = Math.max(0, this.active - 1); this.pending.shift()?.(); }

  async cleanup(id: string, sessionId = this.sessionId): Promise<void> {
    const paths = pathsFor(this.options.repoRoot, sessionId, id); const metadata = await readMetadata(paths);
    if (!terminal.has(metadata.state) && metadata.state !== "cleaning_up") throw new Error(`cannot clean up agent in ${metadata.state}`);
    const archive = join(await this.gitCommonDir(), "pi-agent-results", metadata.sessionId); await mkdir(archive, { recursive: true });
    await writeFile(join(archive, `${id}.json`), JSON.stringify(metadata, null, 2));
    metadata.state = "cleaning_up"; metadata.updatedAt = new Date().toISOString(); await writeMetadata(paths, metadata);
    try {
      let repoPresent = true; try { await access(paths.repo); } catch { repoPresent = false; }
      if (repoPresent) await this.retry(async () => { await execFileAsync("git", ["worktree", "remove", "--force", paths.repo], { cwd: this.options.repoRoot }); });
      await execFileAsync("git", ["worktree", "prune"], { cwd: this.options.repoRoot });
      await rm(paths.root, { recursive: true, force: true }); await removeEmptyParents(paths, this.agentsRoot);
    } catch (error) {
      metadata.state = "failed"; metadata.error = `cleanup failed after retries: ${error instanceof Error ? error.message : String(error)}`; metadata.updatedAt = new Date().toISOString();
      await writeMetadata(paths, metadata); throw error;
    }
  }

  private async gitCommonDir(): Promise<string> { const out = (await execFileAsync("git", ["rev-parse", "--git-common-dir"], { cwd: this.options.repoRoot })).stdout.trim(); return out.startsWith("/") ? out : join(this.options.repoRoot, out); }
  private async retry(operation: () => Promise<void>): Promise<void> { let last: unknown; for (let attempt = 0; attempt < 3; attempt++) { try { await operation(); return; } catch (error) { last = error; if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1))); } } throw last; }
  async recover(): Promise<void> {
    for (const file of await findMetadata(this.agentsRoot)) {
      try {
        const m = JSON.parse(await readFile(file, "utf8")) as AgentMetadata;
        const paths = pathsFor(this.options.repoRoot, m.sessionId, m.id);
        if (m.state === "cleaning_up") {
          try {
            await this.cleanup(m.id, m.sessionId);
          } catch (cleanupError) {
            m.state = "failed";
            m.error = `startup cleanup recovery failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`;
            m.updatedAt = new Date().toISOString();
            try { await writeMetadata(paths, m); } catch { /* preserve workspace and archived result for manual recovery */ }
          }
          continue;
        }
        if (!terminal.has(m.state)) {
          m.state = "failed"; m.error = "recovered after parent process exited"; m.updatedAt = new Date().toISOString(); await writeMetadata(paths, m);
        }
      } catch { /* preserve corrupt workspace for manual recovery */ }
    }
  }
}

const CHILD_ENV_KEYS = ["PATH", "LANG", "LC_ALL", "TZ", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY", "AZURE_OPENAI_API_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_REGION", "AWS_DEFAULT_REGION"] as const;
export function childEnvironment(runtimeRoot: string, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PI_EPHEMERAL_RUNTIME_ROOT: runtimeRoot };
  for (const key of CHILD_ENV_KEYS) if (source[key] !== undefined) env[key] = source[key];
  return env;
}
