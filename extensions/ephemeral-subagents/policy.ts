import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { FallbackPolicy } from "./types.ts";
interface PolicyFile { version: 1; platforms: Record<string, FallbackPolicy>; }
export class FallbackPolicyStore {
  readonly file: string; constructor(file = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "ephemeral-subagents.json")) { this.file=file; }
  async get(platform = process.platform): Promise<FallbackPolicy> { try { const p = JSON.parse(await readFile(this.file, "utf8")) as PolicyFile; return p.platforms?.[platform] ?? "ask"; } catch { return "ask"; } }
  async set(value: FallbackPolicy, platform = process.platform) { let p: PolicyFile = { version: 1, platforms: {} }; try { p = JSON.parse(await readFile(this.file, "utf8")); } catch {} p.version = 1; p.platforms ??= {}; p.platforms[platform] = value; await mkdir(dirname(this.file), { recursive: true, mode: 0o700 }); const tmp = `${this.file}.${process.pid}.tmp`; await writeFile(tmp, `${JSON.stringify(p, null, 2)}\n`, { mode: 0o600 }); await rename(tmp, this.file); }
}
