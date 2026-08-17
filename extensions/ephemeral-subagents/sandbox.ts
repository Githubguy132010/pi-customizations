import { existsSync } from "node:fs";
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
    if (!existsSync(invocation.command)) throw new Error(`ephemeral sandbox runtime does not exist: ${invocation.command}`);
    const args = ["--die-with-parent", "--new-session", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp"];
    const systemMounts = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc"].filter(existsSync);
    if (!systemMounts.some((path) => path === "/usr" || path === "/bin")) throw new Error("ephemeral sandbox cannot find /usr or /bin; this Linux layout is not supported");
    for (const system of systemMounts) args.push("--ro-bind", system, system);
    // Mount the complete installation prefix for non-system runtimes so sibling
    // lib/ directories and loader assets are available, not just bin/node.
    if (!["/usr", "/bin", "/sbin", "/lib", "/lib64"].some((p) => invocation.command.startsWith(`${p}/`))) {
      const runtimePrefix = dirname(runtime);
      args.push("--ro-bind", runtimePrefix, runtimePrefix);
    }
    const packageRoot = invocation.env.PI_EPHEMERAL_RUNTIME_ROOT;
    if (packageRoot) {
      if (!existsSync(packageRoot)) throw new Error(`ephemeral sandbox package runtime does not exist: ${packageRoot}`);
      args.push("--ro-bind", packageRoot, packageRoot);
    }
    args.push("--bind", paths.repo, paths.repo, "--bind", paths.scratch, paths.scratch, "--chdir", paths.repo, "--setenv", "HOME", paths.scratch, "--setenv", "PI_EPHEMERAL_CHILD", "1", "--", invocation.command, ...invocation.args);
    return { command: "bwrap", args, env: { ...invocation.env, HOME: paths.scratch, PI_EPHEMERAL_CHILD: "1" } };
  }
}

export class MacOSSandboxBackend implements SandboxBackend {
  readonly name = "sandbox-exec-experimental";
  async wrap(invocation: Invocation, paths: AgentPaths): Promise<Invocation> {
    if (!(await onPath("sandbox-exec"))) throw new Error("experimental macOS backend requires sandbox-exec");
    const quote = (s: string) => s.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    const runtimeRead = invocation.env.PI_EPHEMERAL_RUNTIME_ROOT ? ` (subpath \"${quote(invocation.env.PI_EPHEMERAL_RUNTIME_ROOT)}\")` : "";
    const profile = `(version 1)(deny default)(import \"system.sb\")(allow process*)(allow network*)(allow file-read* (subpath \"${quote(paths.repo)}\") (subpath \"${quote(paths.scratch)}\")${runtimeRead})(allow file-write* (subpath \"${quote(paths.repo)}\") (subpath \"${quote(paths.scratch)}\"))`;
    return { command: "sandbox-exec", args: ["-p", profile, invocation.command, ...invocation.args], env: { ...invocation.env, HOME: paths.scratch, PI_EPHEMERAL_CHILD: "1" } };
  }
}

export function platformBackend(platform = process.platform): SandboxBackend {
  if (platform === "linux") return new LinuxBubblewrapBackend();
  if (platform === "darwin") return new MacOSSandboxBackend();
  throw new Error(`ephemeral subagents are unsupported on ${platform}; use WSL on Windows`);
}
