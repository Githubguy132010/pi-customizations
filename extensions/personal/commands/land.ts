import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

import { runCommand, summarizeError } from "../utils/exec";
import { refreshPullRequestStatus } from "../events/prStatus";
import {
  collectGitRemotes,
  formatRemoteOption,
  parseRemoteChoice,
  resolveRepoRoot,
} from "../utils/git";

export const LAND_STATUS_PREFIX = "land";

const PR_FIELDS = [
  "number",
  "title",
  "state",
  "isDraft",
  "headRefName",
  "baseRefName",
  "url",
  "mergeable",
  "mergeStateStatus",
  "statusCheckRollup",
].join(",");

interface PullRequest {
  number: number;
  title: string;
  state: string;
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
  url: string;
  mergeable?: string;
  mergeStateStatus?: string;
  statusCheckRollup?: Array<{ status?: string; conclusion?: string; state?: string }>;
}

type LandAction = "merge" | "auto" | "close" | "cleanup";
type MergeMethod = "merge" | "squash" | "rebase";

function parseJson<T>(value: string): T | undefined {
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function hasPendingChecks(pr: PullRequest): boolean {
  return (pr.statusCheckRollup ?? []).some((check) => {
    const status = check.status?.toUpperCase();
    const state = check.state?.toUpperCase();
    return ["EXPECTED", "PENDING", "QUEUED", "IN_PROGRESS", "REQUESTED", "WAITING"].includes(
      status ?? state ?? "",
    );
  });
}

function checkSummary(pr: PullRequest): string {
  const checks = pr.statusCheckRollup ?? [];
  if (checks.length === 0) return "checks unavailable";

  let passing = 0;
  let failing = 0;
  let pending = 0;
  for (const check of checks) {
    const result = (check.conclusion ?? check.state)?.toUpperCase();
    const status = check.status?.toUpperCase();
    if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(result ?? "")) passing += 1;
    else if (["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"].includes(result ?? "")) failing += 1;
    else if (["EXPECTED", "PENDING", "QUEUED", "IN_PROGRESS", "REQUESTED", "WAITING"].includes(status ?? result ?? "")) pending += 1;
  }

  return `${passing} passing, ${failing} failing, ${pending} pending`;
}

async function readPullRequest(
  pi: ExtensionAPI,
  repoRoot: string,
  target?: string,
): Promise<{ pr?: PullRequest; error?: string }> {
  const args = ["pr", "view"];
  if (target) args.push(target);
  args.push("--json", PR_FIELDS);
  const result = await runCommand(pi, "gh", args, repoRoot);
  if (result.code !== 0) return { error: summarizeError(result) };

  const pr = parseJson<PullRequest>(result.stdout);
  return pr ? { pr } : { error: "GitHub CLI returned invalid PR data" };
}

async function selectOpenPullRequests(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  repoRoot: string,
): Promise<PullRequest[]> {
  const current = await readPullRequest(pi, repoRoot);
  if (current.pr && current.pr.state !== "OPEN") return [current.pr];

  const result = await runCommand(
    pi,
    "gh",
    ["pr", "list", "--state", "open", "--limit", "50", "--json", PR_FIELDS],
    repoRoot,
  );
  if (result.code !== 0) {
    if (current.pr) return [current.pr];
    ctx.ui.notify(`/land: failed to find pull requests: ${summarizeError(result)}`, "error");
    return [];
  }

  const prs = parseJson<PullRequest[]>(result.stdout) ?? [];
  if (prs.length === 0) {
    if (current.pr) return [current.pr];
    ctx.ui.notify("/land: no pull request is associated with this branch and no open PRs were found", "warning");
    return [];
  }

  if (current.pr && prs.length === 1 && prs[0].number === current.pr.number) return [current.pr];

  const labels = prs.map((pr) => `#${pr.number} ${pr.title} (${pr.headRefName} → ${pr.baseRefName})`);
  ctx.ui.setStatus(LAND_STATUS_PREFIX, undefined);

  // RPC supports the standard select dialog but not custom checklist components.
  if (ctx.mode !== "tui") {
    if (current.pr) return [current.pr];
    const choice = await ctx.ui.select("Select pull request", labels);
    const index = choice ? labels.indexOf(choice) : -1;
    return index >= 0 ? [prs[index]] : [];
  }

  const selected = await ctx.ui.custom<number[] | null>((tui, theme, _keybindings, done) => {
    const currentIndex = current.pr ? prs.findIndex((pr) => pr.number === current.pr!.number) : -1;
    let cursor = Math.max(0, currentIndex);
    const checked = new Set<number>(currentIndex >= 0 ? [currentIndex] : []);
    const pageSize = Math.min(prs.length, 12);

    return {
      render(width: number): string[] {
        const start = Math.max(0, Math.min(cursor - Math.floor(pageSize / 2), prs.length - pageSize));
        const visible = prs.slice(start, start + pageSize);
        const lines = [
          truncateToWidth(theme.fg("accent", theme.bold(`Select pull requests (${checked.size} selected)`)), width),
          ...visible.map((pr, offset) => {
            const index = start + offset;
            const pointer = index === cursor ? "›" : " ";
            const mark = checked.has(index) ? "◉" : "○";
            const label = `${pointer} ${mark} ${labels[index]}`;
            return truncateToWidth(
              index === cursor ? theme.fg("accent", label) : label,
              width,
            );
          }),
        ];
        if (prs.length > pageSize) {
          lines.push(theme.fg("dim", `${start + 1}-${start + visible.length} of ${prs.length}`));
        }
        lines.push(theme.fg("dim", "↑↓ navigate • space toggle • a toggle all • enter continue • esc cancel"));
        return lines.map((line) => truncateToWidth(line, width));
      },
      handleInput(data: string): void {
        if (matchesKey(data, Key.up)) {
          cursor = (cursor - 1 + prs.length) % prs.length;
        } else if (matchesKey(data, Key.down)) {
          cursor = (cursor + 1) % prs.length;
        } else if (matchesKey(data, Key.space)) {
          if (checked.has(cursor)) checked.delete(cursor);
          else checked.add(cursor);
        } else if (matchesKey(data, "a")) {
          if (checked.size === prs.length) checked.clear();
          else prs.forEach((_pr, index) => checked.add(index));
        } else if (matchesKey(data, Key.enter)) {
          if (checked.size > 0) done([...checked].sort((a, b) => a - b));
        } else if (matchesKey(data, Key.escape)) {
          done(null);
        }
        tui.requestRender();
      },
      invalidate(): void {},
    };
  });

  return selected?.map((index) => prs[index]) ?? [];
}

async function chooseRemote(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  repoRoot: string,
  branch: string,
): Promise<string | undefined> {
  const configured = await runCommand(pi, "git", ["config", "--get", `branch.${branch}.remote`], repoRoot);
  if (configured.code === 0 && configured.stdout.trim() && configured.stdout.trim() !== ".") {
    return configured.stdout.trim();
  }

  const remotes = await collectGitRemotes(pi, repoRoot);
  if (remotes.length === 0) return undefined;
  const origin = remotes.find((remote) => remote.name === "origin");
  if (origin) return origin.name;
  if (remotes.length === 1) return remotes[0].name;

  const choice = await ctx.ui.select("Choose remote used for base-branch cleanup", remotes.map(formatRemoteOption));
  return parseRemoteChoice(choice);
}

async function branchExists(pi: ExtensionAPI, repoRoot: string, branch: string): Promise<boolean> {
  const result = await runCommand(
    pi,
    "git",
    ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    repoRoot,
  );
  return result.code === 0;
}

async function cleanupLocalBranch(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  repoRoot: string,
  pr: PullRequest,
): Promise<boolean> {
  if (pr.headRefName === pr.baseRefName) {
    ctx.ui.notify("/land: refusing to delete the PR base branch", "error");
    return false;
  }
  if (!(await branchExists(pi, repoRoot, pr.headRefName))) {
    ctx.ui.notify(`/land: local branch ${pr.headRefName} is already absent`, "info");
    return true;
  }

  const status = await runCommand(pi, "git", ["status", "--porcelain"], repoRoot);
  if (status.code !== 0 || status.stdout.trim()) {
    ctx.ui.notify("/land: local cleanup skipped because the working tree is not clean", "warning");
    return false;
  }

  const current = await runCommand(pi, "git", ["branch", "--show-current"], repoRoot);
  if (current.code !== 0) {
    ctx.ui.notify(`/land: unable to determine current branch: ${summarizeError(current)}`, "warning");
    return false;
  }

  const remote = await chooseRemote(pi, ctx, repoRoot, pr.baseRefName);
  if (!remote) {
    ctx.ui.notify("/land: local cleanup skipped because no Git remote could be selected", "warning");
    return false;
  }

  ctx.ui.setStatus(LAND_STATUS_PREFIX, `Updating ${pr.baseRefName}...`);
  const fetch = await runCommand(pi, "git", ["fetch", "--prune", remote], repoRoot);
  if (fetch.code !== 0) {
    ctx.ui.notify(`/land: fetch failed: ${summarizeError(fetch)}`, "warning");
    return false;
  }

  if (current.stdout.trim() !== pr.baseRefName) {
    let checkout;
    if (await branchExists(pi, repoRoot, pr.baseRefName)) {
      checkout = await runCommand(pi, "git", ["checkout", pr.baseRefName], repoRoot);
    } else {
      checkout = await runCommand(
        pi,
        "git",
        ["checkout", "-b", pr.baseRefName, "--track", `${remote}/${pr.baseRefName}`],
        repoRoot,
      );
    }
    if (checkout.code !== 0) {
      ctx.ui.notify(`/land: failed to check out ${pr.baseRefName}: ${summarizeError(checkout)}`, "warning");
      return false;
    }
  }

  const update = await runCommand(pi, "git", ["pull", "--ff-only", remote, pr.baseRefName], repoRoot);
  if (update.code !== 0) {
    ctx.ui.notify(`/land: could not fast-forward ${pr.baseRefName}: ${summarizeError(update)}`, "warning");
  }

  ctx.ui.setStatus(LAND_STATUS_PREFIX, `Deleting ${pr.headRefName}...`);
  // Squash and rebase merges do not make the feature tip an ancestor of the
  // base branch, so Git's safe delete (-d) rejects branches that were already
  // landed. The user explicitly approved deleting this branch in the plan.
  const remove = await runCommand(pi, "git", ["branch", "-D", pr.headRefName], repoRoot);
  if (remove.code !== 0) {
    ctx.ui.notify(`/land: failed to delete local branch: ${summarizeError(remove)}`, "error");
    return false;
  }
  return true;
}

function actionOptions(pr: PullRequest): Array<{ label: string; action: LandAction }> {
  if (pr.state === "OPEN") {
    const actions: Array<{ label: string; action: LandAction }> = [
      { label: "Merge PR now", action: "merge" },
    ];
    if (hasPendingChecks(pr)) {
      actions.push({ label: "Enable auto-merge after checks pass", action: "auto" });
    }
    actions.push({ label: "Close PR without merging", action: "close" });
    return actions;
  }
  return [{ label: `Clean up branches for ${pr.state.toLowerCase()} PR`, action: "cleanup" }];
}

async function landPullRequest(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  repoRoot: string,
  pr: PullRequest,
  dryRun: boolean,
): Promise<boolean> {
  // The inspection is complete before the interactive action UI opens. Leaving
  // this status set renders it below the dialog's bottom border.
  ctx.ui.setStatus(LAND_STATUS_PREFIX, undefined);

  ctx.ui.notify(
    `PR #${pr.number}: ${pr.title}\n${pr.headRefName} → ${pr.baseRefName} | ${pr.state}`
      + `${pr.isDraft ? " | draft" : ""} | ${pr.mergeStateStatus ?? pr.mergeable ?? "status unknown"}`
      + ` | ${checkSummary(pr)}`,
    "info",
  );

  const actions = actionOptions(pr);
  const actionLabel = await ctx.ui.select(`Select action for PR #${pr.number}`, [...actions.map((item) => item.label), "Cancel"]);
  const action = actions.find((item) => item.label === actionLabel)?.action;
  if (!action) {
    ctx.ui.notify("/land canceled", "warning");
    return false;
  }

  let method: MergeMethod | undefined;
  const markReady = pr.isDraft && (action === "merge" || action === "auto");
  if (markReady) {
    const ready = await ctx.ui.confirm(
      "Draft pull request",
      `PR #${pr.number} is a draft. Mark it ready for review before merging?`,
    );
    if (!ready) {
      ctx.ui.notify("/land canceled; draft PR was not changed", "warning");
      return false;
    }
  }
  if (action === "merge" || action === "auto") {
    const methodLabel = await ctx.ui.select("Merge method", ["Squash", "Merge commit", "Rebase"]);
    method = methodLabel === "Squash" ? "squash" : methodLabel === "Merge commit" ? "merge" : methodLabel === "Rebase" ? "rebase" : undefined;
    if (!method) {
      ctx.ui.notify("/land canceled", "warning");
      return false;
    }
  }

  const deleteRemote = await ctx.ui.confirm(
    "Remote branch cleanup",
    `Delete remote branch ${pr.headRefName} after the PR action?`,
  );
  const deleteLocal = await ctx.ui.confirm(
    "Local branch cleanup",
    `Switch to ${pr.baseRefName}, update it, and delete local branch ${pr.headRefName}?`,
  );

  const plan = [
    `PR: #${pr.number} ${pr.title}`,
    `Action: ${action === "cleanup" ? "cleanup only" : action}${method ? ` (${method})` : ""}`,
    `Mark draft ready: ${markReady ? "yes" : "no"}`,
    `Delete remote branch: ${deleteRemote ? "yes" : "no"}`,
    `Delete local branch: ${deleteLocal ? "yes" : "no"}`,
  ].join("\n");
  if (!(await ctx.ui.confirm("Confirm /land", `${plan}\n\n${dryRun ? "Preview only?" : "Proceed?"}`))) {
    ctx.ui.notify("/land canceled", "warning");
    return false;
  }
  if (dryRun) {
    ctx.ui.notify(`/land dry run; no changes made\n${plan}`, "info");
    return true;
  }

  let finalState = pr.state;
  if (markReady) {
    ctx.ui.setStatus(LAND_STATUS_PREFIX, "Marking pull request ready...");
    const ready = await runCommand(pi, "gh", ["pr", "ready", pr.url], repoRoot);
    if (ready.code !== 0) {
      ctx.ui.notify(`/land: failed to mark PR ready: ${summarizeError(ready)}`, "error");
      return true;
    }
    pr = { ...pr, isDraft: false };
    ctx.ui.notify(`/land: PR #${pr.number} marked ready for review`, "info");
  }

  if (action !== "cleanup") {
    ctx.ui.setStatus(LAND_STATUS_PREFIX, action === "close" ? "Closing pull request..." : "Merging pull request...");
    const commandArgs = action === "close"
      ? ["pr", "close", pr.url]
      : ["pr", "merge", pr.url, `--${method!}`, ...(action === "auto" ? ["--auto"] : [])];

    const result = await runCommand(pi, "gh", commandArgs, repoRoot);
    if (result.code !== 0) {
      ctx.ui.notify(`/land: PR action failed: ${summarizeError(result)}`, "error");
      return true;
    }

    const refreshed = await readPullRequest(pi, repoRoot, pr.url);
    if (refreshed.pr) {
      pr = refreshed.pr;
      finalState = pr.state;
    }
    if (finalState === "OPEN") {
      ctx.ui.notify(
        `/land: PR #${pr.number} remains open; merge is queued or auto-merge is enabled. Branch cleanup deferred.`,
        "info",
      );
      return true;
    }
  }

  if (deleteRemote) {
    ctx.ui.setStatus(LAND_STATUS_PREFIX, `Deleting remote branch ${pr.headRefName}...`);
    const remote = await chooseRemote(pi, ctx, repoRoot, pr.headRefName);
    if (!remote) {
      ctx.ui.notify("/land: no remote available for branch deletion", "warning");
    } else {
      const removeRemote = await runCommand(pi, "git", ["push", remote, "--delete", pr.headRefName], repoRoot);
      if (removeRemote.code !== 0) {
        const detail = summarizeError(removeRemote);
        if (/remote ref does not exist|unable to delete/i.test(detail)) {
          ctx.ui.notify(`/land: remote branch ${pr.headRefName} is already absent`, "info");
        } else {
          ctx.ui.notify(`/land: failed to delete remote branch: ${detail}`, "warning");
        }
      }
    }
  }

  const localCleaned = deleteLocal ? await cleanupLocalBranch(pi, ctx, repoRoot, pr) : false;
  ctx.ui.notify(
    `/land: PR #${pr.number} ${finalState.toLowerCase()}`
      + `${deleteRemote ? " | remote cleanup requested" : ""}`
      + `${localCleaned ? ` | deleted local ${pr.headRefName}` : ""}`,
    "info",
  );
  return true;
}

export async function runLandWorkflow(
  args: string,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("/land requires interactive UI for now", "warning");
    return;
  }

  const repoRoot = await resolveRepoRoot(pi, ctx);
  if (!repoRoot) {
    ctx.ui.notify("/land: not in a git repository", "error");
    return;
  }

  const gh = await runCommand(pi, "gh", ["--version"], repoRoot);
  if (gh.code !== 0) {
    ctx.ui.notify("/land: GitHub CLI (gh) is required", "error");
    return;
  }

  ctx.ui.setStatus(LAND_STATUS_PREFIX, "Inspecting pull request...");
  try {
    const tokens = args.trim().split(/\s+/).filter(Boolean);
    const dryRun = tokens.includes("--dry-run");
    const target = tokens.find((token) => token !== "--dry-run") ?? "";
    let prs: PullRequest[];
    if (target) {
      const result = await readPullRequest(pi, repoRoot, target);
      if (!result.pr) {
        ctx.ui.notify(`/land: failed to read PR ${target}: ${result.error}`, "error");
        return;
      }
      prs = [result.pr];
    } else {
      prs = await selectOpenPullRequests(pi, ctx, repoRoot);
    }
    if (prs.length === 0) return;

    for (const pr of prs) {
      if (!(await landPullRequest(pi, ctx, repoRoot, pr, dryRun))) break;
    }
  } finally {
    ctx.ui.setStatus(LAND_STATUS_PREFIX, undefined);
    await refreshPullRequestStatus(pi, ctx);
  }
}
