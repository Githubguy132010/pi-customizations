import { access } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import type { AgentPaths } from "./types";

export interface Invocation { command: string; args: string[]; env: NodeJS.ProcessEnv; }
export interface SandboxBackend { readonly name: string; wrap(invocation: Invocation, paths: AgentPaths): Promise<Invocation>; }

async function onPath(command: string): Promise<boolean> {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) try { await access(join(dir, command)); return true; } catch { /* continue */ }
  return false;
}

export class LinuxBubblewrapBackend implements SandboxBackend {
  readonly name = "bubblewrap";
  async wrap(invocation: Invocation, paths: AgentPaths): Promise<Invocation> {
    if (!(await onPath("bwrap"))) throw new Error("bubblewrap is required for ephemeral subagents on Linux/WSL");
    const runtime = dirname(invocation.command);
    const args = ["--die-with-parent", "--new-session", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp"];
    for (const system of ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc"]) args.push("--ro-bind-try", system, system);
    // The executable may be in /opt or another installation prefix.
    if (!["/usr", "/bin", "/sbin", "/lib", "/lib64"].some((p) => invocation.command.startsWith(`${p}/`))) args.push("--ro-bind", runtime, runtime);
    const packageRoot = invocation.env.PI_EPHEMERAL_RUNTIME_ROOT;
    if (packageRoot) args.push("--ro-bind", packageRoot, packageRoot);
    args.push("--bind", paths.repo, paths.repo, "--bind", paths.scratch, paths.scratch, "--chdir", paths.repo, "--setenv", "HOME", paths.scratch, "--setenv", "PI_EPHEMERAL_CHILD", "1", "--", invocation.command, ...invocation.args);
    return { command: "bwrap", args, env: { ...invocation.env, HOME: paths.scratch, PI_EPHEMERAL_CHILD: "1" } };
  }
}

export class MacOSSandboxBackend implements SandboxBackend {
  readonly name = "sandbox-exec-experimental";
  async wrap(invocation: Invocation, paths: AgentPaths): Promise<Invocation> {
    if (!(await onPath("sandbox-exec"))) throw new Error("experimental macOS backend requires sandbox-exec");
    const quote = (s: string) => s.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    const profile = `(version 1)(deny default)(import \"system.sb\")(allow process*)(allow network*)(allow file-read* (subpath \"${quote(paths.repo)}\") (subpath \"${quote(paths.scratch)}\"))(allow file-write* (subpath \"${quote(paths.repo)}\") (subpath \"${quote(paths.scratch)}\"))`;
    return { command: "sandbox-exec", args: ["-p", profile, invocation.command, ...invocation.args], env: { ...invocation.env, HOME: paths.scratch, PI_EPHEMERAL_CHILD: "1" } };
  }
}

export function platformBackend(platform = process.platform): SandboxBackend {
  if (platform === "linux") return new LinuxBubblewrapBackend();
  if (platform === "darwin") return new MacOSSandboxBackend();
  throw new Error(`ephemeral subagents are unsupported on ${platform}; use WSL on Windows`);
}
