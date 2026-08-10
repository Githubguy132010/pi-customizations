import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectGitRemotes, findPullRequestTemplates, formatPrBody, formatRemoteOption,
  getChangedFiles, getLatestCommitMessage, parseRemoteChoice, readTemplate, resolveRepoRoot,
} from "../../extensions/shared/utils/git";
import { registerWorkdirResolver } from "../../extensions/shared/integrations/workdir";
import { createContext, createPi, result } from "../helpers";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe("git utilities", () => {
  it("extracts nonblank porcelain lines", () => {
    expect(getChangedFiles(result(" M one.ts\n?? two.ts\n\n"))).toEqual(["M one.ts", "?? two.ts"]);
  });

  it("resolves a repository from the integrated workdir", async () => {
    const exec = vi.fn().mockResolvedValue(result("/actual/repo\n"));
    const pi = createPi({ exec });
    registerWorkdirResolver(pi, () => "/session/path");
    await expect(resolveRepoRoot(pi, createContext())).resolves.toBe("/actual/repo");
    expect(exec).toHaveBeenCalledWith("git", ["rev-parse", "--show-toplevel"], { cwd: "/session/path" });
  });

  it("returns undefined when repository resolution fails", async () => {
    const pi = createPi({ exec: vi.fn().mockResolvedValue(result("", 128)) });
    await expect(resolveRepoRoot(pi, createContext())).resolves.toBeUndefined();
  });

  it("reads and trims the latest commit message", async () => {
    const pi = createPi({ exec: vi.fn().mockResolvedValue(result(" subject\n\n")) });
    await expect(getLatestCommitMessage(pi, "/repo")).resolves.toBe("subject");
    pi.exec.mockResolvedValue(result("", 1));
    await expect(getLatestCommitMessage(pi, "/repo")).resolves.toBeUndefined();
    pi.exec.mockResolvedValue(result(" \n"));
    await expect(getLatestCommitMessage(pi, "/repo")).resolves.toBeUndefined();
  });

  it("parses, merges, and sorts fetch/push remotes", async () => {
    const stdout = [
      "upstream git@example/up.git (push)", "origin git@example/origin.git (fetch)",
      "malformed", "mirror some-url (mirror)", "origin ssh://push/origin (push)", "upstream git@example/up.git (fetch)",
    ].join("\n");
    const pi = createPi({ exec: vi.fn().mockResolvedValue(result(stdout)) });
    await expect(collectGitRemotes(pi, "/repo")).resolves.toEqual([
      { name: "mirror" },
      { name: "origin", fetch: "git@example/origin.git", push: "ssh://push/origin" },
      { name: "upstream", fetch: "git@example/up.git", push: "git@example/up.git" },
    ]);
    pi.exec.mockResolvedValue(result("", 1));
    await expect(collectGitRemotes(pi, "/repo")).resolves.toEqual([]);
  });

  it("formats and parses remote choices", () => {
    expect(formatRemoteOption({ name: "origin", fetch: "fetch-url", push: "push-url" })).toBe("origin (push-url)");
    expect(formatRemoteOption({ name: "local" })).toBe("local");
    expect(parseRemoteChoice("upstream (url)")).toBe("upstream");
    expect(parseRemoteChoice(undefined)).toBeUndefined();
    expect(parseRemoteChoice("")).toBeUndefined();
  });

  it("discovers conventional and directory PR templates without duplicates", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-git-test-")); dirs.push(root);
    const templateDir = join(root, ".github", "PULL_REQUEST_TEMPLATE");
    mkdirSync(templateDir, { recursive: true });
    const top = join(root, ".github", "PULL_REQUEST_TEMPLATE.md");
    const conventional = join(templateDir, "pull_request_template.md");
    writeFileSync(top, "top"); writeFileSync(conventional, "default");
    writeFileSync(join(templateDir, "bug.md"), "bug");
    writeFileSync(join(templateDir, "config.yml"), "config");
    writeFileSync(join(templateDir, "ignore.txt"), "ignore");
    mkdirSync(join(templateDir, "nested"));

    expect(findPullRequestTemplates(root)).toEqual([top, conventional, join(templateDir, "bug.md"), join(templateDir, "config.yml")]);
    expect(readTemplate(top)).toBe("top");
  });

  it("formats fallback PR bodies with or without a template", () => {
    expect(formatPrBody(" fix it ")).toBe("## Summary\n\nfix it");
    expect(formatPrBody("fix it", " # Checklist \n")).toBe("# Checklist\n\n## Summary\n\nfix it");
  });
});
