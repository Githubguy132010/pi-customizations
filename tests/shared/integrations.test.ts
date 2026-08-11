import { describe, expect, it, vi } from "vitest";
import { registerSettleWorkflow, resolveSettleWorkflow } from "../../extensions/shared/integrations/settle";
import { registerWorkdirResolver, resolveExtensionWorkdir } from "../../extensions/shared/integrations/workdir";
import { createContext, createPi } from "../helpers";

describe("optional extension integrations", () => {
  it("resolves a registered settle workflow", () => {
    const pi = createPi();
    const workflow = vi.fn();
    expect(resolveSettleWorkflow(pi)).toBeUndefined();
    registerSettleWorkflow(pi, workflow);
    expect(resolveSettleWorkflow(pi)).toBe(workflow);
  });

  it("keeps the first settle provider", () => {
    const pi = createPi();
    const first = vi.fn();
    registerSettleWorkflow(pi, first);
    registerSettleWorkflow(pi, vi.fn());
    expect(resolveSettleWorkflow(pi)).toBe(first);
  });

  it("uses the registered workdir resolver or context fallback", () => {
    const pi = createPi();
    const ctx = createContext({ cwd: "/fallback" });
    expect(resolveExtensionWorkdir(pi, ctx)).toBe("/fallback");
    const resolver = vi.fn(() => "/restored");
    registerWorkdirResolver(pi, resolver);
    expect(resolveExtensionWorkdir(pi, ctx)).toBe("/restored");
    expect(resolver).toHaveBeenCalledWith(ctx);
  });
});
