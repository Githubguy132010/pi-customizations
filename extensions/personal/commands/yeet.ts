import { join, relative } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { runCommand, summarizeError } from "../utils/exec";
import {
  collectGitRemotes,
  formatPrBody,
  formatRemoteOption,
  findPullRequestTemplates,
  getChangedFiles,
  getLatestCommitMessage,
  parseRemoteChoice,
  readTemplate,
  resolveRepoRoot,
} from "../utils/git";

export const YEET_STATUS_PREFIX = "yeet";

const COMMIT_MESSAGE_MODEL = {
  provider: "openai-codex",
  id: "gpt-5.6-luna",
} as const;
const MAX_DIFF_CHARS = 80_000;

async function generateCommitMessage(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  repoRoot: string,
  status: string,
): Promise<string> {
  const model = ctx.modelRegistry.find(COMMIT_MESSAGE_MODEL.provider, COMMIT_MESSAGE_MODEL.id);
  if (!model) {
    throw new Error(`${COMMIT_MESSAGE_MODEL.provider}/${COMMIT_MESSAGE_MODEL.id} is not available`);
  }
  if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
    throw new Error(`no authentication configured for ${COMMIT_MESSAGE_MODEL.provider}/${COMMIT_MESSAGE_MODEL.id}`);
  }

  const diffResult = await runCommand(
    pi,
    "git",
    ["diff", "--no-ext-diff", "--no-color", "HEAD"],
    repoRoot,
  );
  const rawDiff = diffResult.code === 0 ? diffResult.stdout : "(Diff unavailable; infer from git status.)";
  const diff = rawDiff.length > MAX_DIFF_CHARS
    ? `${rawDiff.slice(0, MAX_DIFF_CHARS)}\n\n[diff truncated]`
    : rawDiff;

  const response = await ctx.modelRegistry.complete(
    model,
    {
      systemPrompt: [
        "Generate one concise git commit subject for the supplied changes.",
        "Use conventional commits when appropriate (for example feat:, fix:, refactor:, docs:, chore:).",
        "Use imperative mood, keep it at most 72 characters, and output only the subject with no quotes or markdown.",
      ].join(" "),
      messages: [{
        role: "user",
        content: [{
          type: "text",
          text: `Git status:\n${status.trim()}\n\nDiff:\n${diff}`,
        }],
        timestamp: Date.now(),
      }],
    },
    {
      reasoningEffort: "minimal",
      textVerbosity: "low",
      cacheRetention: "none",
      maxTokens: 256,
    },
  );

  if (response.stopReason !== "stop") {
    throw new Error(response.errorMessage || `model stopped with ${response.stopReason}`);
  }

  const generated = response.content
    .filter((content): content is { type: "text"; text: string } => content.type === "text")
    .map((content) => content.text)
    .join("\n")
    .trim()
    .split("\n")
    .find((line) => line.trim().length > 0)
    ?.trim()
    .replace(/^`+|`+$/g, "")
    .replace(/^["']|["']$/g, "");

  if (!generated) {
    throw new Error("model returned an empty commit message");
  }

  return generated;
}

export async function runYeetWorkflow(args: string, pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("/yeet requires interactive UI for now", "warning");
    return;
  }

  const repoRoot = await resolveRepoRoot(pi, ctx);
  if (!repoRoot) {
    ctx.ui.notify("/yeet: not in a git repository", "error");
    return;
  }

  const status = await runCommand(pi, "git", ["status", "--short"], repoRoot);
  if (status.code !== 0) {
    ctx.ui.notify(`/yeet: failed to read git status: ${summarizeError(status)}`, "error");
    return;
  }

  const changed = getChangedFiles(status);
  const hasChanges = changed.length > 0;

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
  if (hasChanges && !commitMessage) {
    ctx.ui.setStatus(YEET_STATUS_PREFIX, "Generating commit message...");
    try {
      commitMessage = await generateCommitMessage(pi, ctx, repoRoot, status.stdout);
      ctx.ui.notify(`/yeet: generated commit message: "${commitMessage}"`, "info");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`/yeet: commit message generation failed (${detail}); enter one manually`, "warning");
      const message = await ctx.ui.input("Commit message", "chore: ");
      if (!message) {
        ctx.ui.notify("/yeet canceled", "warning");
        return;
      }
      commitMessage = message.trim();
    } finally {
      ctx.ui.setStatus(YEET_STATUS_PREFIX, undefined);
    }
  }

  if (hasChanges && !commitMessage) {
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

  if (!hasChanges) {
    if (workflow === "Commit only") {
      ctx.ui.notify("/yeet: nothing to commit", "warning");
      return;
    }

    if (!commitMessage) {
      const latestMessage = await getLatestCommitMessage(pi, repoRoot);
      if (!latestMessage) {
        ctx.ui.notify("/yeet: no local changes found and no previous commit message available", "warning");
        return;
      }
      commitMessage = latestMessage;
    }
  }

  if (!commitMessage) {
    ctx.ui.notify("/yeet: commit message cannot be empty", "warning");
    return;
  }

  ctx.ui.setStatus(YEET_STATUS_PREFIX, "Preparing yeet...");
  let pushBranch: string | undefined;

  try {
    if (hasChanges) {
      const addAll = await runCommand(pi, "git", ["add", "-A"], repoRoot);
      if (addAll.code !== 0) {
        ctx.ui.notify(`/yeet: git add failed: ${summarizeError(addAll)}`, "error");
        return;
      }

      ctx.ui.setStatus(YEET_STATUS_PREFIX, "Committing...");
      const commit = await runCommand(pi, "git", ["commit", "-m", commitMessage], repoRoot);
      if (commit.code !== 0) {
        ctx.ui.notify(`/yeet: git commit failed: ${summarizeError(commit)}`, "error");
        return;
      }
    }

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

    const summary = [
      hasChanges ? `/yeet: committed "${commitMessage}"` : `/yeet: using latest commit`,
      `Branch: ${pushBranch ?? "current"}`,
    ];
    if (doPush && remoteName) {
      summary.push(`Pushed: ${remoteName}/${pushBranch ?? "HEAD"}`);
    }
    if (doPr) {
      summary.push("PR requested");
    }
    ctx.ui.notify(summary.join(" | "), "info");
  } finally {
    ctx.ui.setStatus(YEET_STATUS_PREFIX, undefined);
  }
}
