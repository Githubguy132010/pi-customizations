import { existsSync, readdirSync, readFileSync, realpathSync, statSync, type Dirent } from "node:fs";
import { join, sep } from "node:path";
import type { ExtensionContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { ExecResultLike, GitRemote } from "../types";
import { runCommand } from "./exec";
import { resolveExtensionWorkdir } from "../integrations/workdir";

export function getChangedFiles(result: ExecResultLike): string[] {
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export async function resolveRepoRoot(pi: ExtensionAPI, ctx: ExtensionContext): Promise<string | undefined> {
  const cwd = resolveExtensionWorkdir(pi, ctx);
  const result = await runCommand(pi, "git", ["rev-parse", "--show-toplevel"], cwd);
  if (result.code !== 0) {
    return undefined;
  }

  return result.stdout.trim();
}

export async function getLatestCommitMessage(pi: ExtensionAPI, cwd: string): Promise<string | undefined> {
  const result = await runCommand(pi, "git", ["log", "-1", "--pretty=%B"], cwd);
  if (result.code !== 0) {
    return undefined;
  }

  const message = result.stdout.trim();
  return message.length > 0 ? message : undefined;
}

export async function collectGitRemotes(pi: ExtensionAPI, cwd: string): Promise<GitRemote[]> {
  const result = await runCommand(pi, "git", ["remote", "-v"], cwd);
  if (result.code !== 0) {
    return [];
  }

  const remoteMap = new Map<string, GitRemote>();

  for (const line of result.stdout.split("\n")) {
    const match = line.trim().match(/^(\S+)\s+(\S+)\s+\(([^)]+)\)$/);
    if (!match) {
      continue;
    }

    const [, name, url, kind] = match;
    const existing: GitRemote = remoteMap.get(name) ?? { name };
    if (kind === "fetch") {
      existing.fetch = url;
    } else if (kind === "push") {
      existing.push = url;
    }
    remoteMap.set(name, existing);
  }

  return Array.from(remoteMap.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export function formatRemoteOption(remote: GitRemote): string {
  const url = remote.push ?? remote.fetch;
  return url ? `${remote.name} (${url})` : remote.name;
}

export function parseRemoteChoice(choice: string | undefined): string | undefined {
  if (!choice) {
    return undefined;
  }
  return choice.split(" ", 1)[0];
}

export function findPullRequestTemplates(repoRoot: string): string[] {
  const candidates: string[] = [
    join(repoRoot, ".github", "PULL_REQUEST_TEMPLATE.md"),
    join(repoRoot, ".github", "pull_request_template.md"),
    join(repoRoot, ".github", "PULL_REQUEST_TEMPLATE", "pull_request_template.md"),
    join(repoRoot, ".github", "PULL_REQUEST_TEMPLATE", "PULL_REQUEST_TEMPLATE.md"),
  ];

  const templates = candidates.filter((candidate) => existsSync(candidate));

  const templateDir = join(repoRoot, ".github", "PULL_REQUEST_TEMPLATE");
  if (existsSync(templateDir) && statSync(templateDir).isDirectory()) {
    for (const entry of readdirSync(templateDir, { withFileTypes: true })) {
      if (!entry.isFile()) {
        continue;
      }
      if (!entry.name.match(/\.(md|markdown|ya?ml)$/i)) {
        continue;
      }

      const candidate = join(templateDir, entry.name);
      if (!templates.includes(candidate)) {
        templates.push(candidate);
      }
    }
  }

  return templates;
}

export function readTemplate(file: string): string {
  return readFileSync(file, "utf-8");
}

export function formatPrBody(message: string, templateBody?: string): string {
  const sections = ["## Summary", message.trim()];
  if (templateBody && templateBody.trim()) {
    return `${templateBody.trim()}\n\n${sections.join("\n\n")}`;
  }

  return sections.join("\n\n");
}

export const DEFAULT_YEET_DEPTH = 1;
export const MAX_YEET_DEPTH = 10;

export function parseYeetDepth(rawArgs: string): number | undefined {
  const regex = /(?:^|\s)(?:--depth|--max-depth)(?:=|\s+)(\d+)\b/g;
  let match: RegExpExecArray | null;
  let last: string | undefined;
  while ((match = regex.exec(rawArgs)) !== null) {
    last = match[1];
  }
  if (last === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(last, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  return Math.min(parsed, MAX_YEET_DEPTH);
}

export function stripYeetDepthArgs(rawArgs: string): string {
  // Remove depth flags and normalize whitespace
  const cleaned = rawArgs.replace(
    /(?:^|\s)(?:--depth|--max-depth)(?:=|\s+)(\d+)\b/g,
    (flag, value: string) => {
      const parsed = Number.parseInt(value, 10);
      return Number.isFinite(parsed) && parsed > 0 ? " " : flag;
    },
  );
  return cleaned.replace(/\s+/g, " ").trim();
}

export function findChildGitRepos(cwd: string, maxDepth = DEFAULT_YEET_DEPTH): string[] {
  const depth = Math.min(Math.max(1, Math.floor(maxDepth)), MAX_YEET_DEPTH);
  const repos: string[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: cwd, depth: 0 }];
  const visited = new Set<string>();
  const startReal = (() => {
    try {
      return realpathSync(cwd);
    } catch {
      return cwd;
    }
  })();
  visited.add(startReal);

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= depth) {
      continue;
    }
    let entries: Dirent[];
    try {
      entries = readdirSync(current.dir, { withFileTypes: true }) as unknown as Dirent[];
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) {
        continue;
      }
      if (entry.name.startsWith(".")) {
        continue;
      }
      const full = join(current.dir, entry.name);
      let real = full;
      try {
        real = realpathSync(full);
      } catch {
        continue;
      }
      if (visited.has(real)) {
        continue;
      }
      if (entry.isSymbolicLink() && !(real === startReal || real.startsWith(startReal + sep))) {
        continue;
      }
      visited.add(real);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) {
        continue;
      }
      const gitPath = join(full, ".git");
      if (existsSync(gitPath)) {
        repos.push(full);
        continue;
      }
      if (current.depth + 1 < depth) {
        queue.push({ dir: full, depth: current.depth + 1 });
      }
    }
  }

  return repos.sort((a, b) => a.localeCompare(b));
}
