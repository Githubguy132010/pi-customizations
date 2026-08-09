import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { ExecResultLike, GitRemote } from "../types";
import { runCommand } from "./exec";
import { syncSessionWorkdirFromHistory } from "./sessionWorkdir";

export function getChangedFiles(result: ExecResultLike): string[] {
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export async function resolveRepoRoot(pi: ExtensionAPI, ctx: ExtensionContext): Promise<string | undefined> {
  const cwd = syncSessionWorkdirFromHistory(ctx);
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
  return choice.split(" ", 1)[0] ?? undefined;
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
