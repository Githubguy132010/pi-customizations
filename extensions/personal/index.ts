import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

interface TurnMetrics {
  active: boolean;
  startAt: number;
  lastStatusAt: number;
  outputChars: number;
  outputTokens: number;
}

interface ExecResultLike {
  code: number;
  stdout: string;
  stderr: string;
  killed: boolean;
}

interface GitRemote {
  name: string;
  fetch?: string;
  push?: string;
}

interface SessionWorkdirEntry {
  type: "custom";
  customType: string;
  data?: {
    cwd?: string;
    reason?: string;
    timestamp?: string;
  };
}

const TpsState: { metrics: TurnMetrics } = {
  metrics: {
    active: false,
    startAt: 0,
    lastStatusAt: 0,
    outputChars: 0,
    outputTokens: 0,
  } as TurnMetrics,
};

const STATUS_THROTTLE_MS = 250;
const STATUS_PREFIX = "yeet";
const WORKDIR_ENTRY_TYPE = "pi-workdir";

let sessionWorkdir = process.cwd();

function keepOnlyBashToolset(pi: ExtensionAPI) {
  const active = pi.getActiveTools();
  const shouldKeep = active.length === 1 && active[0] === "bash";
  if (!shouldKeep) {
    pi.setActiveTools(["bash"]);
  }
}

async function runCommand(
  pi: ExtensionAPI,
  command: string,
  args: string[],
  cwd: string = sessionWorkdir,
): Promise<ExecResultLike> {
  try {
    return await pi.exec(command, args, { cwd });
  } catch (error) {
    return {
      code: 1,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      killed: false,
    };
  }
}

function isExistingDirectory(path: string): boolean {
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

function syncSessionWorkdirFromHistory(ctx: ExtensionContext): string {
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
      // keep fallback to process cwd if chdir fails
      sessionWorkdir = process.cwd();
    }
    return sessionWorkdir;
  }

  sessionWorkdir = process.cwd();
  return sessionWorkdir;
}

function persistSessionWorkdir(pi: ExtensionAPI, reason: string) {
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

function getChangedFiles(result: ExecResultLike): string[] {
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

async function resolveRepoRoot(pi: ExtensionAPI, ctx: ExtensionContext): Promise<string | undefined> {
  const cwd = syncSessionWorkdirFromHistory(ctx);
  const result = await runCommand(pi, "git", ["rev-parse", "--show-toplevel"], cwd);
  if (result.code !== 0) {
    ctx.ui.notify("/yeet: not in a git repository", "error");
    return undefined;
  }

  return result.stdout.trim();
}

async function collectGitRemotes(pi: ExtensionAPI, cwd: string): Promise<GitRemote[]> {
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
    const existing = remoteMap.get(name) ?? { name };
    if (kind === "fetch") {
      existing.fetch = url;
    } else if (kind === "push") {
      existing.push = url;
    }
    remoteMap.set(name, existing);
  }

  return Array.from(remoteMap.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function formatRemoteOption(remote: GitRemote): string {
  const url = remote.push ?? remote.fetch;
  return url ? `${remote.name} (${url})` : remote.name;
}

function parseRemoteChoice(choice: string | undefined): string | undefined {
  if (!choice) {
    return undefined;
  }
  return choice.split(" ", 1)[0] ?? undefined;
}

function findPullRequestTemplates(repoRoot: string): string[] {
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

function readTemplate(file: string): string {
  return readFileSync(file, "utf-8");
}

function formatPrBody(message: string, templateBody?: string): string {
  const sections = ["## Summary", message.trim()];
  if (templateBody && templateBody.trim()) {
    return `${templateBody.trim()}\n\n${sections.join("\n\n")}`;
  }

  return sections.join("\n\n");
}

function summarizeError(result: ExecResultLike): string {
  const details = (result.stderr || result.stdout).trim();
  return details || `Command failed with exit code ${result.code}`;
}

async function runYeetWorkflow(args: string, pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  syncSessionWorkdirFromHistory(ctx);

  if (!ctx.hasUI) {
    ctx.ui.notify("/yeet requires interactive UI for now", "warning");
    return;
  }

  const repoRoot = await resolveRepoRoot(pi, ctx);
  if (!repoRoot) {
    return;
  }

  const status = await runCommand(pi, "git", ["status", "--short"], repoRoot);
  if (status.code !== 0) {
    ctx.ui.notify(`/yeet: failed to read git status: ${summarizeError(status)}`, "error");
    return;
  }

  const changed = getChangedFiles(status);
  if (changed.length === 0) {
    ctx.ui.notify("/yeet: nothing to commit", "warning");
    return;
  }

  const workflow = await ctx.ui.select("Select yeet workflow", [
    "Commit only",
    "Commit + push",
    "Commit + push + create PR",
  ]);

  if (!workflow) {
    ctx.ui.notify("/yeet canceled", "warning");
    return;
  }

  const doPush = workflow !== "Commit only";
  const doPr = workflow === "Commit + push + create PR";

  let commitMessage = args.trim();
  if (!commitMessage) {
    const message = await ctx.ui.input("Commit message", "chore: ");
    if (!message) {
      ctx.ui.notify("/yeet canceled", "warning");
      return;
    }
    commitMessage = message.trim();
  }

  if (!commitMessage) {
    ctx.ui.notify("/yeet: commit message cannot be empty", "warning");
    return;
  }

  let remoteName: string | undefined;
  if (doPush) {
    const remotes = await collectGitRemotes(pi, repoRoot);
    if (remotes.length === 0) {
      ctx.ui.notify("/yeet: no remotes found", "error");
      return;
    }

    if (remotes.length === 1) {
      remoteName = remotes[0].name;
    } else {
      const remoteChoice = await ctx.ui.select(
        "Multiple remotes found. Choose target push remote",
        remotes.map(formatRemoteOption),
      );
      remoteName = parseRemoteChoice(remoteChoice);
      if (!remoteName) {
        ctx.ui.notify("/yeet canceled", "warning");
        return;
      }
    }
  }

  ctx.ui.setStatus(STATUS_PREFIX, "Preparing yeet...");

  try {
    const addAll = await runCommand(pi, "git", ["add", "-A"], repoRoot);
    if (addAll.code !== 0) {
      ctx.ui.notify(`/yeet: git add failed: ${summarizeError(addAll)}`, "error");
      return;
    }

    ctx.ui.setStatus(STATUS_PREFIX, "Committing...");
    const commit = await runCommand(pi, "git", ["commit", "-m", commitMessage], repoRoot);
    if (commit.code !== 0) {
      ctx.ui.notify(`/yeet: git commit failed: ${summarizeError(commit)}`, "error");
      return;
    }

    let pushBranch: string | undefined;
    if (doPush && remoteName) {
      const head = await runCommand(pi, "git", ["rev-parse", "--abbrev-ref", "HEAD"], repoRoot);
      if (head.code !== 0 || !head.stdout.trim()) {
        ctx.ui.notify("/yeet: unable to determine current branch", "error");
        return;
      }
      pushBranch = head.stdout.trim();

      const push = await runCommand(pi, "git", ["push", "-u", remoteName, pushBranch], repoRoot);
      if (push.code !== 0) {
        const attempt = `${remoteName} ${pushBranch}`;
        ctx.ui.notify(`/yeet: git push failed to ${attempt}: ${summarizeError(push)}`, "error");
        return;
      }
      ctx.ui.notify(`/yeet: pushed ${pushBranch} to ${remoteName}`, "info");
    }

    if (doPr) {
      const gh = await runCommand(pi, "gh", ["--version"], repoRoot);
      if (gh.code !== 0) {
        ctx.ui.notify("/yeet: GitHub CLI (gh) is required for PR creation", "error");
        return;
      }

      const templates = findPullRequestTemplates(repoRoot);
      let templateBody: string | undefined;

      if (templates.length > 0) {
        const includeTemplate = await ctx.ui.confirm(
          "Pull request template detected",
          `Detected ${templates.length} PR template${templates.length === 1 ? "" : "s"}. Include in PR body?`,
        );

        if (includeTemplate) {
          const templateChoice =
            templates.length === 1
              ? templates[0]
              : await ctx.ui.select(
                  "Select PR template to include",
                  templates.map((templatePath) => relative(repoRoot, templatePath)),
                );

          if (templateChoice) {
            const selectedTemplate = templates.length === 1
              ? templateChoice
              : join(repoRoot, templateChoice);
            try {
              templateBody = readTemplate(selectedTemplate);
            } catch {
              ctx.ui.notify("/yeet: failed to read PR template", "warning");
            }
          }
        }
      }

      const prType = await ctx.ui.select("PR type", ["Draft PR", "Ready for review"]);
      if (!prType) {
        return;
      }

      const prArgs = [
        "pr",
        "create",
        "--title",
        commitMessage,
        "--body",
        formatPrBody(commitMessage, templateBody),
      ];
      if (prType === "Draft PR") {
        prArgs.push("--draft");
      }

      const pr = await runCommand(pi, "gh", prArgs, repoRoot);
      if (pr.code !== 0) {
        ctx.ui.notify(`/yeet: failed to create PR: ${summarizeError(pr)}`, "error");
        return;
      }

      ctx.ui.notify(`/yeet: PR created\n${pr.stdout.trim() || "(no URL returned)"}`, "info");
    }

    const summary = [`/yeet: committed \"${commitMessage}\"`, `Branch: ${pushBranch ?? "current"}`];
    if (doPush && remoteName) {
      summary.push(`Pushed: ${remoteName}/${pushBranch ?? "HEAD"}`);
    }
    if (doPr) {
      summary.push("PR requested");
    }
    ctx.ui.notify(summary.join(" | "), "info");
  } finally {
    ctx.ui.setStatus(STATUS_PREFIX, undefined);
  }
}

function startTurn() {
  TpsState.metrics = {
    active: true,
    startAt: Date.now(),
    lastStatusAt: 0,
    outputChars: 0,
    outputTokens: 0,
  };
}

function stopTurn() {
  TpsState.metrics.active = false;
}

function maybeRecordDeltaTokens(event: { assistantMessageEvent: unknown }): void {
  const update = event.assistantMessageEvent as {
    type?: string;
    delta?: unknown;
    partial?: {
      usage?: {
        output?: number;
      };
    };
  };

  const typedUsage = update.partial?.usage;
  if (typeof typedUsage?.output === "number" && Number.isFinite(typedUsage.output) && typedUsage.output > 0) {
    TpsState.metrics.outputTokens = Math.max(TpsState.metrics.outputTokens, typedUsage.output);
    return;
  }

  if (update.type === "text_delta" || update.type === "thinking_delta" || update.type === "toolcall_delta") {
    if (typeof update.delta === "string") {
      TpsState.metrics.outputChars += update.delta.length;
      const estimatedTokens = Math.max(1, Math.round(update.delta.length / 4));
      TpsState.metrics.outputTokens = Math.max(TpsState.metrics.outputTokens, TpsState.metrics.outputTokens + estimatedTokens);
    }
  }
}

function setTpsStatus(ctx: ExtensionContext, final = false) {
  const elapsedMs = Date.now() - TpsState.metrics.startAt;
  if (elapsedMs <= 0) {
    return;
  }

  const elapsedSeconds = elapsedMs / 1000;
  const rate = TpsState.metrics.outputTokens / elapsedSeconds;
  const label = final ? "done" : "live";
  const icon = final ? "✓" : "⚡";
  ctx.ui.setStatus("live-tps", `${icon} ${rate.toFixed(1)} t/s (${label})`);
}

function maybeSetTps(ctx: ExtensionContext, force = false) {
  const now = Date.now();
  if (TpsState.metrics.active) {
    const shouldUpdate = force || now - TpsState.metrics.lastStatusAt > STATUS_THROTTLE_MS;
    if (shouldUpdate) {
      TpsState.metrics.lastStatusAt = now;
      setTpsStatus(ctx);
    }
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (event: { reason: "startup" | "reload" | "new" | "resume" | "fork"; }, ctx: ExtensionContext) => {
    const reason = event.reason;
    syncSessionWorkdirFromHistory(ctx);
    persistSessionWorkdir(pi, reason);
    keepOnlyBashToolset(pi);
  });

  pi.on("before_agent_start", (_event: unknown, _ctx: unknown) => {
    keepOnlyBashToolset(pi);
  });

  pi.on("turn_start", (_event: unknown, ctx: ExtensionContext) => {
    startTurn();
    setTpsStatus(ctx);
  });

  pi.on("message_update", (event: { message: { role: string }; assistantMessageEvent: unknown }, ctx: ExtensionContext) => {
    if (event.message.role !== "assistant") {
      return;
    }

    if (!TpsState.metrics.active) {
      return;
    }

    maybeRecordDeltaTokens(event);
    maybeSetTps(ctx);
  });

  pi.on("message_end", (event: { message: { role: string; usage?: { output?: number; totalTokens?: number; input?: number } } }, ctx: ExtensionContext) => {
    if (!TpsState.metrics.active) {
      return;
    }

    if (event.message.role !== "assistant") {
      return;
    }

    if (typeof event.message.usage?.output === "number" && event.message.usage.output > 0) {
      TpsState.metrics.outputTokens = Math.max(TpsState.metrics.outputTokens, event.message.usage.output);
    } else if (event.message.usage && typeof event.message.usage.totalTokens === "number") {
      const output = event.message.usage.totalTokens - (event.message.usage.input ?? 0);
      if (Number.isFinite(output) && output > 0) {
        TpsState.metrics.outputTokens = Math.max(TpsState.metrics.outputTokens, Math.round(output));
      }
    }

    if (TpsState.metrics.outputChars > 0 && TpsState.metrics.outputTokens === 0) {
      TpsState.metrics.outputTokens = Math.max(1, Math.round(TpsState.metrics.outputChars / 4));
    }

    setTpsStatus(ctx, true);
    stopTurn();
  });

  pi.on("tool_call", (event: { toolName: string }) => {
    if (event.toolName === "bash") {
      return;
    }

    return {
      block: true,
      terminate: true,
    };
  });

  pi.on("turn_end", (_event: unknown, ctx: ExtensionContext) => {
    if (TpsState.metrics.active) {
      setTpsStatus(ctx, true);
      stopTurn();
    }
  });

  pi.on("session_shutdown", async (_event: { reason: "quit" | "reload" | "new" | "resume" | "fork"; targetSessionFile?: string }, ctx: ExtensionContext) => {
    syncSessionWorkdirFromHistory(ctx);
    persistSessionWorkdir(pi, _event.reason);
    stopTurn();
    ctx.ui.setStatus("live-tps", undefined);
    ctx.ui.setStatus(STATUS_PREFIX, undefined);
  });

  pi.registerCommand("yeet", {
    description: "Commit changes, and optionally push and/or create a PR",
    handler: (args: string, ctx: ExtensionContext) => runYeetWorkflow(args, pi, ctx),
  });
}
