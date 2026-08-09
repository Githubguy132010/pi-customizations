import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { hyperlink } from "@earendil-works/pi-tui";

import { runCommand } from "../utils/exec";
import { resolveRepoRoot } from "../utils/git";

export const PR_STATUS_PREFIX = "pull-request";

interface PullRequestStatus {
  number: number;
  url: string;
}

let refreshGeneration = 0;

export function clearPullRequestStatus(ctx: ExtensionContext): void {
  refreshGeneration += 1;
  ctx.ui.setStatus(PR_STATUS_PREFIX, undefined);
}

function parsePullRequest(value: string): PullRequestStatus | undefined {
  try {
    const parsed = JSON.parse(value) as Partial<PullRequestStatus>;
    if (typeof parsed.number !== "number" || !Number.isInteger(parsed.number) || typeof parsed.url !== "string") {
      return undefined;
    }

    const url = new URL(parsed.url);
    if (url.protocol !== "https:") return undefined;

    return { number: parsed.number, url: url.toString() };
  } catch {
    return undefined;
  }
}

/** Refresh the current branch's pull-request indicator without surfacing gh errors. */
export async function refreshPullRequestStatus(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  const generation = ++refreshGeneration;
  const repoRoot = await resolveRepoRoot(pi, ctx);
  if (generation !== refreshGeneration) return;

  if (!repoRoot) {
    clearPullRequestStatus(ctx);
    return;
  }

  const result = await runCommand(pi, "gh", ["pr", "view", "--json", "number,url"], repoRoot);
  if (generation !== refreshGeneration) return;

  const pr = result.code === 0 ? parsePullRequest(result.stdout) : undefined;
  if (!pr) {
    clearPullRequestStatus(ctx);
    return;
  }

  const label = ctx.ui.theme.fg("accent", `PR #${pr.number}`);
  ctx.ui.setStatus(PR_STATUS_PREFIX, hyperlink(label, pr.url));
}
