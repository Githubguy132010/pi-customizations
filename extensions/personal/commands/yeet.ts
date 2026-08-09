import { join, relative } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { runCommand, summarizeError } from "../utils/exec";
import { runLandWorkflow } from "./land";
import { refreshPullRequestStatus } from "../events/prStatus";
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

const YEET_MODEL = {
  provider: "openai-codex",
  id: "gpt-5.6-luna",
} as const;
const MAX_DIFF_CHARS = 80_000;

async function completeWithLuna(
  ctx: ExtensionContext,
  systemPrompt: string,
  prompt: string,
  maxTokens: number,
): Promise<string> {
  const model = ctx.modelRegistry.find(YEET_MODEL.provider, YEET_MODEL.id);
  if (!model) {
    throw new Error(`${YEET_MODEL.provider}/${YEET_MODEL.id} is not available`);
  }
  if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
    throw new Error(`no authentication configured for ${YEET_MODEL.provider}/${YEET_MODEL.id}`);
  }

  const response = await ctx.modelRegistry.complete(
    model,
    {
      systemPrompt,
      messages: [{
        role: "user",
        content: [{ type: "text", text: prompt }],
        timestamp: Date.now(),
      }],
    },
    {
      reasoningEffort: "minimal",
      textVerbosity: "low",
      cacheRetention: "none",
      maxTokens,
    },
  );

  if (response.stopReason !== "stop") {
    throw new Error(response.errorMessage || `model stopped with ${response.stopReason}`);
  }

  const text = response.content
    .filter((content): content is { type: "text"; text: string } => content.type === "text")
    .map((content) => content.text)
    .join("\n")
    .trim();

  if (!text) {
    throw new Error("model returned an empty response");
  }

  return text;
}

async function readDiff(pi: ExtensionAPI, repoRoot: string, ref = "HEAD"): Promise<string> {
  const result = await runCommand(
    pi,
    "git",
    ["diff", "--no-ext-diff", "--no-color", ref],
    repoRoot,
  );
  const rawDiff = result.code === 0 ? result.stdout : "(Diff unavailable; infer from the other context.)";
  return rawDiff.length > MAX_DIFF_CHARS
    ? `${rawDiff.slice(0, MAX_DIFF_CHARS)}\n\n[diff truncated]`
    : rawDiff;
}

function normalizeFeatureBranch(value: string): string {
  const unwrapped = value
    .trim()
    .split("\n")
    .find((line) => line.trim().length > 0)
    ?.trim()
    .replace(/^`+|`+$/g, "")
    .replace(/^["']|["']$/g, "")
    .toLowerCase() ?? "";
  const withoutPrefix = unwrapped.replace(/^feature[/-]+/, "");
  const slug = withoutPrefix
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56)
    .replace(/-+$/g, "");

  if (!slug) {
    throw new Error("model returned an invalid branch name");
  }
  return `feature/${slug}`;
}

async function generateFeatureBranch(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  repoRoot: string,
  status: string,
  commitMessage: string,
): Promise<string> {
  const diff = await readDiff(pi, repoRoot);
  const generated = await completeWithLuna(
    ctx,
    [
      "Generate a concise git feature branch name for the supplied changes.",
      "Use the form feature/kebab-case, keep it descriptive and under 64 characters,",
      "and output only the branch name with no quotes or markdown.",
    ].join(" "),
    `Commit subject: ${commitMessage}\n\nGit status:\n${status.trim()}\n\nDiff:\n${diff}`,
    128,
  );
  return normalizeFeatureBranch(generated);
}

async function findAvailableFeatureBranch(
  pi: ExtensionAPI,
  repoRoot: string,
  remoteName: string,
  requested: string,
): Promise<string> {
  for (let attempt = 1; attempt <= 100; attempt += 1) {
    const candidate = attempt === 1 ? requested : `${requested}-${attempt}`;
    const local = await runCommand(
      pi,
      "git",
      ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`],
      repoRoot,
    );
    if (local.code === 0) {
      continue;
    }

    const remote = await runCommand(
      pi,
      "git",
      ["ls-remote", "--heads", remoteName, `refs/heads/${candidate}`],
      repoRoot,
    );
    if (remote.code !== 0) {
      throw new Error(`failed to check ${remoteName} for existing branches: ${summarizeError(remote)}`);
    }
    if (!remote.stdout.trim()) {
      return candidate;
    }
  }

  throw new Error(`could not find an available branch name based on ${requested}`);
}

async function resolvePrBaseRef(
  pi: ExtensionAPI,
  repoRoot: string,
  remoteName: string,
): Promise<string | undefined> {
  const symbolic = await runCommand(
    pi,
    "git",
    ["symbolic-ref", "--quiet", "--short", `refs/remotes/${remoteName}/HEAD`],
    repoRoot,
  );
  if (symbolic.code === 0 && symbolic.stdout.trim()) {
    return symbolic.stdout.trim();
  }

  const defaultBranch = await runCommand(
    pi,
    "gh",
    ["repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"],
    repoRoot,
  );
  return defaultBranch.code === 0 && defaultBranch.stdout.trim()
    ? `${remoteName}/${defaultBranch.stdout.trim()}`
    : undefined;
}

async function generatePrBody(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  repoRoot: string,
  remoteName: string,
  title: string,
  templateBody?: string,
): Promise<string> {
  const baseRef = await resolvePrBaseRef(pi, repoRoot, remoteName);
  let diff = baseRef ? await readDiff(pi, repoRoot, `${baseRef}...HEAD`) : "";
  if (!diff.trim()) {
    const latest = await runCommand(
      pi,
      "git",
      ["show", "--no-ext-diff", "--no-color", "--format=fuller", "--stat", "--patch", "HEAD"],
      repoRoot,
    );
    diff = latest.code === 0 ? latest.stdout : "(Diff unavailable.)";
    if (diff.length > MAX_DIFF_CHARS) {
      diff = `${diff.slice(0, MAX_DIFF_CHARS)}\n\n[diff truncated]`;
    }
  }

  const templateInstruction = templateBody?.trim()
    ? `\n\nUse and complete this repository PR template. Preserve relevant checklists and headings; remove placeholder instructions that do not belong in the final description:\n\n${templateBody.trim()}`
    : "";

  return completeWithLuna(
    ctx,
    [
      "Write a clear pull request description in Markdown for the supplied changes.",
      "Explain what changed and why, call out important implementation details, and include testing status.",
      "Do not invent tests or claims not supported by the context.",
      "Output only the final PR body with no surrounding code fence.",
    ].join(" "),
    `PR title: ${title}\nBase: ${baseRef ?? "repository default branch"}\n\nChanges:\n${diff}${templateInstruction}`,
    1_500,
  );
}

async function generateCommitMessage(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  repoRoot: string,
  status: string,
): Promise<string> {
  const diff = await readDiff(pi, repoRoot);
  const generatedText = await completeWithLuna(
    ctx,
    [
      "Generate one concise git commit subject for the supplied changes.",
      "Use conventional commits when appropriate (for example feat:, fix:, refactor:, docs:, chore:).",
      "Use imperative mood, keep it at most 72 characters, and output only the subject with no quotes or markdown.",
    ].join(" "),
    `Git status:\n${status.trim()}\n\nDiff:\n${diff}`,
    256,
  );

  const generated = generatedText
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
    "Commit + push + create PR + land",
  ]);

  if (!workflow) {
    ctx.ui.notify("/yeet canceled", "warning");
    return;
  }

  const doPush = workflow !== "Commit only";
  const doPr = workflow === "Commit + push + create PR" || workflow === "Commit + push + create PR + land";
  const doLand = workflow === "Commit + push + create PR + land";

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
  let createdPrUrl: string | undefined;

  try {
    if (doPr) {
      ctx.ui.setStatus(YEET_STATUS_PREFIX, "Generating feature branch...");
      let featureBranch: string;
      try {
        featureBranch = await generateFeatureBranch(pi, ctx, repoRoot, status.stdout, commitMessage);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`/yeet: branch generation failed (${detail}); enter one manually`, "warning");
        const branch = await ctx.ui.input("Feature branch", "feature/");
        if (!branch) {
          ctx.ui.notify("/yeet canceled", "warning");
          return;
        }
        featureBranch = branch.trim();
      }

      const requestedBranch = featureBranch;
      try {
        featureBranch = await findAvailableFeatureBranch(pi, repoRoot, remoteName!, requestedBranch);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`/yeet: unable to choose a feature branch: ${detail}`, "error");
        return;
      }
      ctx.ui.notify(
        featureBranch === requestedBranch
          ? `/yeet: generated feature branch: ${featureBranch}`
          : `/yeet: feature branch ${requestedBranch} exists; using ${featureBranch}`,
        "info",
      );

      const validBranch = await runCommand(pi, "git", ["check-ref-format", "--branch", featureBranch], repoRoot);
      if (validBranch.code !== 0) {
        ctx.ui.notify(`/yeet: invalid feature branch name: ${featureBranch}`, "error");
        return;
      }

      ctx.ui.setStatus(YEET_STATUS_PREFIX, "Creating feature branch...");
      const createBranch = await runCommand(pi, "git", ["checkout", "-b", featureBranch], repoRoot);
      if (createBranch.code !== 0) {
        ctx.ui.notify(`/yeet: failed to create feature branch: ${summarizeError(createBranch)}`, "error");
        return;
      }
      pushBranch = featureBranch;
    }

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
      pushBranch = pushBranch ?? head.stdout.trim();

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

      ctx.ui.setStatus(YEET_STATUS_PREFIX, "Writing PR description...");
      let prBody: string;
      try {
        prBody = await generatePrBody(pi, ctx, repoRoot, remoteName!, commitMessage, templateBody);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`/yeet: PR description generation failed (${detail}); using commit summary`, "warning");
        prBody = formatPrBody(commitMessage, templateBody);
      } finally {
        ctx.ui.setStatus(YEET_STATUS_PREFIX, undefined);
      }

      const prArgs = [
        "pr",
        "create",
        "--title",
        commitMessage,
        "--body",
        prBody,
      ];
      if (prType === "Draft PR") {
        prArgs.push("--draft");
      }

      ctx.ui.setStatus(YEET_STATUS_PREFIX, "Creating pull request...");
      const pr = await runCommand(pi, "gh", prArgs, repoRoot);
      ctx.ui.setStatus(YEET_STATUS_PREFIX, undefined);
      if (pr.code !== 0) {
        ctx.ui.notify(`/yeet: failed to create PR: ${summarizeError(pr)}`, "error");
        return;
      }

      createdPrUrl = pr.stdout.trim() || undefined;
      ctx.ui.notify(`/yeet: PR created\n${createdPrUrl || "(no URL returned)"}`, "info");
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

    if (doLand && createdPrUrl) {
      await runLandWorkflow(createdPrUrl, pi, ctx);
    } else if (doPr) {
      ctx.ui.notify("/yeet: run /land from this branch when the PR is ready", "info");
    }
  } finally {
    ctx.ui.setStatus(YEET_STATUS_PREFIX, undefined);
    await refreshPullRequestStatus(pi, ctx);
  }
}
