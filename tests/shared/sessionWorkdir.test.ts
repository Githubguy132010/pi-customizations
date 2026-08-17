import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  WORKDIR_ENTRY_TYPE, getSessionWorkdir, isExistingDirectory, persistSessionWorkdir,
  syncSessionWorkdirFromHistory,
} from "../../extensions/shared/utils/sessionWorkdir";
import { handleSessionShutdown, handleSessionStart } from "../../extensions/shared/events/session";
import { createContext, createPi } from "../helpers";

const originalCwd = process.cwd();
const root = mkdtempSync(join(tmpdir(), "pi-session-test-"));
const canonicalRoot = (() => { const before = process.cwd(); process.chdir(root); const resolved = process.cwd(); process.chdir(before); return resolved; })();
afterAll(() => { process.chdir(originalCwd); rmSync(root, { recursive: true, force: true }); });

function context(entries: unknown[], header = originalCwd) {
  return createContext({ sessionManager: { getEntries: vi.fn(() => entries), getCwd: vi.fn(() => header) } });
}

describe("session working directory", () => {
  it("recognizes directories and rejects files/missing paths", () => {
    const file = join(root, "file"); writeFileSync(file, "x");
    expect(isExistingDirectory(root)).toBe(true);
    expect(isExistingDirectory(file)).toBe(false);
    expect(isExistingDirectory(join(root, "missing"))).toBe(false);
    expect(syncSessionWorkdirFromHistory(context([{ type: "custom", customType: WORKDIR_ENTRY_TYPE }], ""))).toBe(process.cwd());
  });

  it("uses the newest valid saved entry and changes process cwd", () => {
    const entries = [
      { type: "custom", customType: WORKDIR_ENTRY_TYPE, data: { cwd: originalCwd } },
      { type: "custom", customType: "other", data: { cwd: "/ignored" } },
      { type: "custom", customType: WORKDIR_ENTRY_TYPE, data: { cwd: ` ${root} ` } },
      null,
    ];
    expect(syncSessionWorkdirFromHistory(context(entries))).toBe(canonicalRoot);
    expect(process.cwd()).toBe(canonicalRoot);
    expect(getSessionWorkdir()).toBe(canonicalRoot);
  });

  it("falls back from blank/missing entries to header, then current cwd", () => {
    process.chdir(originalCwd);
    expect(syncSessionWorkdirFromHistory(context([{ type: "custom", customType: WORKDIR_ENTRY_TYPE, data: { cwd: " " } }], root))).toBe(canonicalRoot);
    expect(syncSessionWorkdirFromHistory(context([], "/definitely/missing"))).toBe(canonicalRoot);
  });

  it("recovers if changing to a saved directory fails", () => {
    process.chdir(originalCwd);
    const change = vi.spyOn(process, "chdir").mockImplementation(() => { throw new Error("denied"); });
    expect(syncSessionWorkdirFromHistory(context([], root))).toBe(originalCwd);
    change.mockRestore();
  });

  it("persists the selected workdir with metadata", () => {
    syncSessionWorkdirFromHistory(context([], root));
    const pi = createPi();
    persistSessionWorkdir(pi, "reload");
    expect(pi.appendEntry).toHaveBeenCalledWith(WORKDIR_ENTRY_TYPE, expect.objectContaining({ cwd: canonicalRoot, reason: "reload", timestamp: expect.any(String) }));
    expect(new Date(pi.appendEntry.mock.calls[0][1].timestamp).toString()).not.toBe("Invalid Date");
  });

  it("does not persist a workdir that disappeared", () => {
    const transient = mkdtempSync(join(tmpdir(), "pi-removed-workdir-"));
    syncSessionWorkdirFromHistory(context([], transient));
    process.chdir(originalCwd);
    rmSync(transient, { recursive: true });
    const pi = createPi(); persistSessionWorkdir(pi, "quit");
    expect(pi.appendEntry).not.toHaveBeenCalled();
  });

  it("start and shutdown handlers synchronize and persist their reasons", () => {
    const pi = createPi(); const ctx = context([], root);
    handleSessionStart(pi, { reason: "startup" }, ctx);
    handleSessionShutdown(pi, { reason: "quit" }, ctx);
    expect(pi.appendEntry.mock.calls.map((call: any[]) => call[1].reason)).toEqual(["startup", "quit"]);
  });
});
