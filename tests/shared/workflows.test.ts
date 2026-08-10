import { describe, expect, it, vi } from "vitest";
import { runLandWorkflow } from "../../extensions/shared/commands/land";
import { runYeetWorkflow } from "../../extensions/shared/commands/yeet";
import { createContext, createPi, createUi, result } from "../helpers";

function commandKey(command: string, args: string[]) { return `${command} ${args.join(" ")}`; }
function dispatch(routes: Record<string, ReturnType<typeof result>>) {
  return vi.fn(async (command: string, args: string[]) => routes[commandKey(command, args)] ?? result("", 1, `unexpected: ${commandKey(command, args)}`));
}

describe("/yeet workflow", () => {
  it("requires UI and a git repository", async () => {
    const noUi = createContext({ hasUI: false });
    await runYeetWorkflow("", createPi(), noUi);
    expect(noUi.ui.notify).toHaveBeenCalledWith("/yeet requires interactive UI for now", "warning");

    const ctx = createContext();
    const pi = createPi({ exec: vi.fn().mockResolvedValue(result("", 128)) });
    await runYeetWorkflow("", pi, ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("/yeet: not in a git repository", "error");
  });

  it("commits all changes with an explicitly supplied message", async () => {
    const exec = dispatch({
      "git rev-parse --show-toplevel": result("/repo\n"),
      "git status --short": result(" M src/a.ts\n?? test.ts\n"),
      "git add -A": result(),
      "git commit -m feat: tested": result(),
    });
    const ui = createUi({ select: vi.fn().mockResolvedValue("Commit only") });
    const ctx = createContext({ ui });
    await runYeetWorkflow(" feat: tested ", createPi({ exec }), ctx);
    expect(exec).toHaveBeenCalledWith("git", ["add", "-A"], { cwd: "/repo" });
    expect(exec).toHaveBeenCalledWith("git", ["commit", "-m", "feat: tested"], { cwd: "/repo" });
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining('committed "feat: tested"'), "info");
    expect(ui.setStatus).toHaveBeenLastCalledWith("yeet", undefined);
  });

  it("cancels cleanly when workflow selection is dismissed", async () => {
    const exec = dispatch({ "git rev-parse --show-toplevel": result("/repo"), "git status --short": result(" M x") });
    const ctx = createContext({ ui: createUi({ select: vi.fn().mockResolvedValue(undefined) }) });
    await runYeetWorkflow("msg", createPi({ exec }), ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("/yeet canceled", "warning");
  });

  it("pushes the latest commit when there are no changes", async () => {
    const exec = dispatch({
      "git rev-parse --show-toplevel": result("/repo"), "git status --short": result(""),
      "git remote -v": result("origin git@example/repo.git (fetch)\norigin git@example/repo.git (push)"),
      "git log -1 --pretty=%B": result("last subject\n"),
      "git rev-parse --abbrev-ref HEAD": result("main\n"), "git push -u origin main": result(),
    });
    const ctx = createContext({ ui: createUi({ select: vi.fn().mockResolvedValue("Commit + push") }) });
    await runYeetWorkflow("", createPi({ exec }), ctx);
    expect(exec).toHaveBeenCalledWith("git", ["push", "-u", "origin", "main"], { cwd: "/repo" });
    expect(ctx.ui.notify).toHaveBeenCalledWith("/yeet: pushed main to origin", "info");
  });

  it("creates and pushes a feature branch and pull request with model-generated text", async () => {
    const createdBody = "## Summary\n\nGenerated body";
    const exec = dispatch({
      "git rev-parse --show-toplevel": result("/repo"), "git status --short": result(" M src/a.ts"),
      "git remote -v": result("origin git@example/repo.git (fetch)\norigin git@example/repo.git (push)"),
      "git diff --no-ext-diff --no-color HEAD": result("diff --git a/src/a.ts b/src/a.ts"),
      "git show-ref --verify --quiet refs/heads/feature/better-tests": result("", 1),
      "git ls-remote --heads origin refs/heads/feature/better-tests": result(""),
      "git check-ref-format --branch feature/better-tests": result(),
      "git checkout -b feature/better-tests": result(), "git add -A": result(),
      "git commit -m feat: improve tests": result(),
      "git rev-parse --abbrev-ref HEAD": result("feature/better-tests\n"),
      "git push -u origin feature/better-tests": result(), "gh --version": result("gh"),
      "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": result("origin/main\n"),
      "git diff --no-ext-diff --no-color origin/main...HEAD": result("complete diff"),
      [`gh pr create --title feat: improve tests --body ${createdBody}`]: result("https://github/pr/7\n"),
    });
    const complete = vi.fn()
      .mockResolvedValueOnce({ stopReason: "stop", content: [{ type: "text", text: "`FEATURE/Better Tests`" }] })
      .mockResolvedValueOnce({ stopReason: "stop", content: [{ type: "text", text: createdBody }] });
    const model = { id: "gpt-5.6-luna" };
    const modelRegistry = { find: vi.fn(() => model), hasConfiguredAuth: vi.fn(() => true), complete };
    const select = vi.fn().mockResolvedValueOnce("Commit + push + create PR").mockResolvedValueOnce("Ready for review");
    const ctx = createContext({ modelRegistry, ui: createUi({ select, confirm: vi.fn() }) });
    await runYeetWorkflow("feat: improve tests", createPi({ exec }), ctx);
    expect(exec).toHaveBeenCalledWith("git", ["checkout", "-b", "feature/better-tests"], { cwd: "/repo" });
    expect(exec).toHaveBeenCalledWith("gh", ["pr", "create", "--title", "feat: improve tests", "--body", createdBody], { cwd: "/repo" });
    expect(ctx.ui.notify).toHaveBeenCalledWith("/yeet: PR created\nhttps://github/pr/7", "info");
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("falls back to manual input when commit-message generation is unavailable", async () => {
    const exec = dispatch({
      "git rev-parse --show-toplevel": result("/repo"), "git status --short": result(" M x"),
      "git diff --no-ext-diff --no-color HEAD": result("diff"), "git add -A": result(),
      "git commit -m manual message": result(),
    });
    const ui = createUi({ select: vi.fn().mockResolvedValue("Commit only"), input: vi.fn().mockResolvedValue(" manual message ") });
    const ctx = createContext({ ui, modelRegistry: { find: vi.fn(() => undefined) } });
    await runYeetWorkflow("", createPi({ exec }), ctx);
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("commit message generation failed"), "warning");
    expect(exec).toHaveBeenCalledWith("git", ["commit", "-m", "manual message"], { cwd: "/repo" });
  });

  it("reports status errors and nothing-to-commit", async () => {
    let ctx = createContext();
    await runYeetWorkflow("", createPi({ exec: dispatch({ "git rev-parse --show-toplevel": result("/repo"), "git status --short": result("", 1, "broken") }) }), ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("/yeet: failed to read git status: broken", "error");

    ctx = createContext({ ui: createUi({ select: vi.fn().mockResolvedValue("Commit only") }) });
    await runYeetWorkflow("", createPi({ exec: dispatch({ "git rev-parse --show-toplevel": result("/repo"), "git status --short": result("") }) }), ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("/yeet: nothing to commit", "warning");
  });
});

describe("/land workflow", () => {
  const pr = { number: 12, title: "Ship it", state: "OPEN", isDraft: false, headRefName: "feature/x", baseRefName: "main", url: "https://github/pr/12", mergeable: "MERGEABLE", statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }] };

  it("requires UI, a repository, and gh", async () => {
    let ctx = createContext({ hasUI: false }); await runLandWorkflow("", createPi(), ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("/land requires interactive UI for now", "warning");
    ctx = createContext(); await runLandWorkflow("", createPi({ exec: vi.fn().mockResolvedValue(result("", 1)) }), ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("/land: not in a git repository", "error");
    ctx = createContext();
    await runLandWorkflow("", createPi({ exec: dispatch({ "git rev-parse --show-toplevel": result("/repo"), "gh --version": result("", 1) }) }), ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("/land: GitHub CLI (gh) is required", "error");
  });

  it("previews an explicit PR without making changes", async () => {
    const exec = dispatch({
      "git rev-parse --show-toplevel": result("/repo"), "gh --version": result("gh 1"),
      "gh pr view 12 --json number,title,state,isDraft,headRefName,baseRefName,url,mergeable,mergeStateStatus,statusCheckRollup": result(JSON.stringify(pr)),
    });
    const select = vi.fn().mockResolvedValueOnce("Merge PR now").mockResolvedValueOnce("Squash");
    const confirm = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const ctx = createContext({ ui: createUi({ select, confirm }) });
    await runLandWorkflow("12 --dry-run", createPi({ exec }), ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("/land dry run; no changes made"), "info");
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("1 passing, 0 failing, 0 pending"), "info");
    expect(exec).toHaveBeenCalledTimes(3);
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("land", undefined);
  });

  it("closes an open PR after confirmation", async () => {
    const closed = { ...pr, state: "CLOSED" };
    const viewKey = "gh pr view 12 --json number,title,state,isDraft,headRefName,baseRefName,url,mergeable,mergeStateStatus,statusCheckRollup";
    const urlViewKey = "gh pr view https://github/pr/12 --json number,title,state,isDraft,headRefName,baseRefName,url,mergeable,mergeStateStatus,statusCheckRollup";
    const exec = dispatch({
      "git rev-parse --show-toplevel": result("/repo"), "gh --version": result("gh"),
      [viewKey]: result(JSON.stringify(pr)), "gh pr close https://github/pr/12": result(),
      [urlViewKey]: result(JSON.stringify(closed)),
    });
    const select = vi.fn().mockResolvedValue("Close PR without merging");
    const confirm = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const ctx = createContext({ ui: createUi({ select, confirm }) });
    await runLandWorkflow("12", createPi({ exec }), ctx);
    expect(exec).toHaveBeenCalledWith("gh", ["pr", "close", "https://github/pr/12"], { cwd: "/repo" });
    expect(ctx.ui.notify).toHaveBeenCalledWith("/land: PR #12 closed", "info");
  });

  it("lists open PRs and handles no results", async () => {
    const fields = "number,title,state,isDraft,headRefName,baseRefName,url,mergeable,mergeStateStatus,statusCheckRollup";
    const exec = dispatch({
      "git rev-parse --show-toplevel": result("/repo"), "gh --version": result("gh"),
      [`gh pr view --json ${fields}`]: result("", 1, "no branch PR"),
      [`gh pr list --state open --limit 50 --json ${fields}`]: result("[]"),
    });
    const ctx = createContext(); await runLandWorkflow("", createPi({ exec }), ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("no pull request is associated"), "warning");
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("land", undefined);
  });

  it("reports malformed or failed PR lookup and always clears status", async () => {
    for (const view of [result("not-json"), result("", 1, "not found")]) {
      const ctx = createContext();
      await runLandWorkflow("99", createPi({ exec: dispatch({
        "git rev-parse --show-toplevel": result("/repo"), "gh --version": result("gh"),
        "gh pr view 99 --json number,title,state,isDraft,headRefName,baseRefName,url,mergeable,mergeStateStatus,statusCheckRollup": view,
      }) }), ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("/land: failed to read PR 99"), "error");
      expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("land", undefined);
    }
  });
});
