import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LinuxBubblewrapBackend, MacOSSandboxBackend, platformBackend } from "../../extensions/ephemeral-subagents/sandbox";
import { pathsFor } from "../../extensions/ephemeral-subagents/storage";

const oldPath = process.env.PATH;
afterEach(() => { process.env.PATH = oldPath; });

async function fakeCommand(name: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-command-"));
  const file = join(dir, name); await writeFile(file, "#!/bin/sh\nexit 0\n"); await chmod(file, 0o755); process.env.PATH = `${dir}:${oldPath}`;
}

describe("ephemeral sandbox contract", () => {
  it("uses bubblewrap with only the agent repo and scratch writable", async () => {
    await fakeCommand("bwrap"); const paths = pathsFor("/parent", "session", "agent");
    const wrapped = await new LinuxBubblewrapBackend().wrap({ command: "/usr/bin/node", args: ["/opt/pi/bin/pi.mjs"], env: { PI_EPHEMERAL_RUNTIME_ROOT: "/opt/pi" } }, paths);
    expect(wrapped.command).toBe("bwrap");
    expect(wrapped.args).toContain("--new-session");
    expect(wrapped.args.join(" ")).toContain(`--bind ${paths.repo} ${paths.repo}`);
    expect(wrapped.args.join(" ")).toContain(`--bind ${paths.scratch} ${paths.scratch}`);
    expect(wrapped.args.join(" ")).not.toContain("--bind /parent /parent");
  });

  it("keeps the experimental macOS implementation behind the same interface", async () => {
    await fakeCommand("sandbox-exec"); const paths = pathsFor("/parent", "session", "agent");
    const wrapped = await new MacOSSandboxBackend().wrap({ command: "/usr/bin/node", args: [], env: {} }, paths);
    expect(wrapped.command).toBe("sandbox-exec"); expect(wrapped.args[1]).toContain("(deny default)"); expect(wrapped.args[1]).toContain(paths.scratch);
  });

  it("rejects native Windows", () => expect(() => platformBackend("win32")).toThrow(/WSL/));
});
