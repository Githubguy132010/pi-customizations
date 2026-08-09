import { statSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SessionWorkdirEntry } from "../types";

export const WORKDIR_ENTRY_TYPE = "pi-workdir";

let sessionWorkdir = process.cwd();

export function isExistingDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function extractSavedWorkdir(entries: readonly unknown[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as SessionWorkdirEntry | undefined;
    if (!entry || entry.type !== "custom" || entry.customType !== WORKDIR_ENTRY_TYPE) {
      continue;
    }

    const cwd = entry.data?.cwd;
    if (typeof cwd === "string" && cwd.trim().length > 0) {
      return cwd.trim();
    }
  }

  return undefined;
}

export function syncSessionWorkdirFromHistory(ctx: ExtensionContext): string {
  const entries = ctx.sessionManager.getEntries();
  const fromSession = extractSavedWorkdir(entries);
  const headerCwd = ctx.sessionManager.getCwd();

  const chosen = fromSession || headerCwd || process.cwd();
  if (isExistingDirectory(chosen)) {
    sessionWorkdir = chosen;

    try {
      if (process.cwd() !== chosen) {
        process.chdir(chosen);
      }
    } catch {
      sessionWorkdir = process.cwd();
    }

    return sessionWorkdir;
  }

  sessionWorkdir = process.cwd();
  return sessionWorkdir;
}

export function persistSessionWorkdir(pi: ExtensionAPI, reason: string) {
  const cwd = sessionWorkdir;
  if (!isExistingDirectory(cwd)) {
    return;
  }

  pi.appendEntry(WORKDIR_ENTRY_TYPE, {
    cwd,
    reason,
    timestamp: new Date().toISOString(),
  });
}

export function getSessionWorkdir(): string {
  return sessionWorkdir;
}
