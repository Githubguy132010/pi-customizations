import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentMetadata, AgentPaths } from "./types";

export function pathsFor(repoRoot: string, sessionId: string, agentId: string): AgentPaths {
  const root = join(repoRoot, ".pi-agents", sessionId, agentId);
  return { root, repo: join(root, "repo"), scratch: join(root, "scratch"), metadata: join(root, "lifecycle.json"), transcript: join(root, "result.jsonl"), request: join(root, "scratch", "parent-request.json"), response: join(root, "scratch", "parent-response.json") };
}

export async function ensureIgnored(exclude: string): Promise<void> {
  await mkdir(dirname(exclude), { recursive: true });
  let old = "";
  try { old = await readFile(exclude, "utf8"); } catch { /* create below */ }
  if (!old.split(/\r?\n/).includes("/.pi-agents/")) {
    await appendFile(exclude, `${old && !old.endsWith("\n") ? "\n" : ""}/.pi-agents/\n`);
  }
}

export async function preparePaths(paths: AgentPaths): Promise<void> {
  await mkdir(paths.scratch, { recursive: true, mode: 0o700 });
}

export async function writeMetadata(paths: AgentPaths, value: AgentMetadata): Promise<void> {
  const temporary = `${paths.metadata}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, paths.metadata);
}

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await rename(temporary, file);
}

export async function readMetadata(paths: AgentPaths): Promise<AgentMetadata> {
  return JSON.parse(await readFile(paths.metadata, "utf8")) as AgentMetadata;
}

export async function removeEmptyParents(paths: AgentPaths, agentsRoot: string): Promise<void> {
  let current = dirname(paths.root);
  while (current.startsWith(agentsRoot)) {
    try { await rm(current, { recursive: false }); } catch { break; }
    if (current === agentsRoot) break;
    current = dirname(current);
  }
}

export async function findMetadata(agentsRoot: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string): Promise<void> {
    let names: string[];
    try { names = await readdir(dir); } catch { return; }
    for (const name of names) {
      const file = join(dir, name);
      if (name === "lifecycle.json") found.push(file);
      else if ((await stat(file)).isDirectory()) await walk(file);
    }
  }
  await walk(agentsRoot);
  return found;
}
