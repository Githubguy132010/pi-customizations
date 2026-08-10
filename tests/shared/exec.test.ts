import { describe, expect, it, vi } from "vitest";
import { runCommand, summarizeError } from "../../extensions/shared/utils/exec";
import { createPi, result } from "../helpers";

describe("command utilities", () => {
  it("executes with the requested cwd", async () => {
    const expected = result("ok");
    const pi = createPi({ exec: vi.fn().mockResolvedValue(expected) });
    await expect(runCommand(pi, "git", ["status"], "/work")).resolves.toBe(expected);
    expect(pi.exec).toHaveBeenCalledWith("git", ["status"], { cwd: "/work" });
  });

  it.each([new Error("boom"), "plain failure"])("normalizes thrown errors", async (error) => {
    const pi = createPi({ exec: vi.fn().mockRejectedValue(error) });
    await expect(runCommand(pi, "bad", [])).resolves.toMatchObject({
      code: 1, stdout: "", stderr: error instanceof Error ? "boom" : "plain failure", killed: false,
    });
  });

  it("summarizes stderr, then stdout, then the exit code", () => {
    expect(summarizeError(result("out", 2, " err \n"))).toBe("err");
    expect(summarizeError(result(" out ", 2))).toBe("out");
    expect(summarizeError(result("", 27))).toBe("Command failed with exit code 27");
  });
});
