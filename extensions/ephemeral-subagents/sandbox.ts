import { execFile } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { FallbackPolicy, Limits, SandboxStrength, Session } from "./types.ts";
import { WORKER_SOURCE } from "./worker.ts";
const exec = promisify(execFile);

export interface LaunchPlan { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; sandboxed: boolean; label: string; notices: string[]; }
export interface SandboxRequest { session: Session; cwd: string; piScript: string; piArgs: string[]; env: NodeJS.ProcessEnv; limits: Limits; control: { jobId: string; token: string }; }
export interface SandboxBackend { readonly id: string; readonly strength: SandboxStrength; detect(): Promise<{ available: boolean; reason?: string }>; plan(request: SandboxRequest): Promise<LaunchPlan>; }

const SAFE_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_BASE_URL", "AZURE_OPENAI_RESOURCE_NAME", "AZURE_OPENAI_API_VERSION", "DEEPSEEK_API_KEY", "GROQ_API_KEY", "CEREBRAS_API_KEY", "XAI_API_KEY", "OPENROUTER_API_KEY", "ZAI_API_KEY", "MISTRAL_API_KEY", "MINIMAX_API_KEY", "MOONSHOT_API_KEY", "KIMI_API_KEY", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"];
function cleanEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/tmp/home", TMPDIR: "/tmp", LANG: source.LANG ?? "C.UTF-8", CI: "1", GIT_TERMINAL_PROMPT: "0", PI_CODING_AGENT_DIR: "/tmp/pi-agent" };
  for (const key of SAFE_ENV) if (source[key]) env[key] = source[key];
  return env;
}
function dirsFor(destination: string): string[] {
  const parts = resolve(destination).split(sep).filter(Boolean); const out: string[] = []; let p = "";
  for (const part of parts.slice(0, -1)) { p += `/${part}`; out.push(p); }
  return out;
}

export class BubblewrapBackend implements SandboxBackend {
  readonly id = "bubblewrap"; readonly strength = "native" as const;
  async detect() {
    if (process.platform !== "linux") return { available: false, reason: "Bubblewrap is Linux-only" };
    try { await exec("bwrap", ["--ro-bind", "/usr", "/usr", "--ro-bind", "/lib", "/lib", "--ro-bind", "/lib64", "/lib64", "--proc", "/proc", "--dev", "/dev", "--unshare-user", "--unshare-pid", "--", "/usr/bin/true"], { timeout: 5000 }); return { available: true }; }
    catch (e) { return { available: false, reason: `Bubblewrap unavailable or user namespaces disabled: ${e instanceof Error ? e.message : e}` }; }
  }
  async plan(r: SandboxRequest): Promise<LaunchPlan> {
    const node = await realpath(process.execPath); const runtime = resolve(dirname(node), "..");
    const cwdRel = relative(r.session.repoRoot, resolve(r.cwd));
    if (cwdRel === ".." || cwdRel.startsWith(`..${sep}`) || resolve(cwdRel) === cwdRel) throw new Error("working directory is outside repository");
    const sandboxCwd = join(r.session.repoRoot, cwdRel);
    const mounts: Array<[string, string]> = [["/usr", "/usr"], [runtime, runtime], [r.session.worktree, r.session.repoRoot]];
    for (const p of ["/bin", "/lib", "/lib64", "/etc/ssl", "/etc/resolv.conf", "/etc/hosts", "/etc/nsswitch.conf"]) await access(p).then(() => mounts.push([p,p])).catch(() => {});
    const dirs = new Set<string>(["/tmp", "/home", "/run", ...mounts.flatMap(([, d]) => dirsFor(d))]);
    const args = ["--die-with-parent", "--new-session", "--unshare-all", "--share-net", "--clearenv"];
    for (const d of dirs) args.push("--dir", d);
    args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp");
    for (const [src, dst] of mounts) args.push("--ro-bind", src, dst);
    const env = cleanEnv(r.env); env.PI_SUBAGENT_JOB_ID=r.control.jobId; env.PI_SUBAGENT_CONTROL_TOKEN=r.control.token; for (const [k,v] of Object.entries(env)) if (v !== undefined) args.push("--setenv", k, v);
    args.push("--chdir", sandboxCwd, "--", node, "-e", WORKER_SOURCE, node, r.piScript, ...r.piArgs);
    return { command: "bwrap", args, cwd: "/", env: {}, sandboxed: true, label: this.id, notices: ["Repository mounted read-only; internet enabled", "Runtime/output limits are enforced by the manager; kernel CPU/memory/process quotas depend on host cgroup support"] };
  }
}

export class ContainerBackend implements SandboxBackend {
  readonly id = "container"; readonly strength = "container" as const;
  private runtime?: string;
  async detect() {
    const image = process.env.PI_SUBAGENT_CONTAINER_IMAGE;
    if (!image) return { available: false, reason: "PI_SUBAGENT_CONTAINER_IMAGE is not configured" };
    for (const candidate of ["podman", "docker"]) try { await exec(candidate, ["info"], { timeout: 5000 }); this.runtime = candidate; return { available: true }; } catch {}
    return { available: false, reason: "No usable Podman or Docker runtime" };
  }
  async plan(r: SandboxRequest): Promise<LaunchPlan> {
    const image = process.env.PI_SUBAGENT_CONTAINER_IMAGE!; const runtime = this.runtime!; const env = cleanEnv(r.env); env.PI_SUBAGENT_JOB_ID=r.control.jobId; env.PI_SUBAGENT_CONTROL_TOKEN=r.control.token;
    const args = ["run", "--rm", "--network", "bridge", "--read-only", "--pids-limit", String(r.limits.processCount), "--memory", `${r.limits.memoryMb}m`, "--cpus", String(Math.max(.1, r.limits.cpuSeconds / Math.max(1, r.limits.runtimeMs / 1000))), "--tmpfs", `/tmp:rw,size=${r.limits.diskMb}m`, "-v", `${r.session.worktree}:${r.session.repoRoot}:ro`, "-w", r.cwd];
    for (const [k,v] of Object.entries(env)) if (v !== undefined) args.push("-e", `${k}=${v}`);
    args.push(image, "node", "-e", WORKER_SOURCE, "pi", ...r.piArgs);
    return { command: runtime, args, cwd: "/", env: {}, sandboxed: true, label: `${runtime}:${image}`, notices: ["Independent per-job container; internet enabled"] };
  }
}

export class UnsandboxedBackend implements SandboxBackend {
  readonly id = "unsandboxed"; readonly strength = "none" as const;
  private readonly reason: string; constructor(reason = "explicit per-run confirmation") { this.reason=reason; }
  async detect() { return { available: true }; }
  async plan(r: SandboxRequest): Promise<LaunchPlan> { const env=cleanEnv(r.env); env.PI_SUBAGENT_JOB_ID=r.control.jobId; env.PI_SUBAGENT_CONTROL_TOKEN=r.control.token; return { command: process.execPath, args: ["-e", WORKER_SOURCE, process.execPath, r.piScript, ...r.piArgs], cwd: r.session.worktree, env, sandboxed: false, label: `unsandboxed by ${this.reason}`, notices: ["WARNING: process has normal host filesystem access"] }; }
}

export async function selectBackend(backends: SandboxBackend[]): Promise<{ backend?: SandboxBackend; notices: string[] }> {
  const notices: string[] = [];
  const rank: Record<SandboxStrength, number> = { native: 0, container: 1, vm: 2, none: 3 };
  for (const b of [...backends].sort((a,b) => rank[a.strength] - rank[b.strength])) {
    const result = await b.detect(); if (result.available) return { backend: b, notices }; notices.push(`${b.id}: ${result.reason ?? "unsupported"}`);
  }
  return { notices };
}
