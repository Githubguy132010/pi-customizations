import { describe, expect, it, vi } from "vitest";
import { registerLandWorkflow, resolveLandWorkflow } from "../../extensions/shared/integrations/land";
import { registerWorkdirResolver, resolveExtensionWorkdir } from "../../extensions/shared/integrations/workdir";
import { createContext, createPi } from "../helpers";

describe("optional extension integrations", () => {
  it("resolves a registered land workflow", () => {
    const pi = createPi();
    const workflow = vi.fn();
    expect(resolveLandWorkflow(pi)).toBeUndefined();
    registerLandWorkflow(pi, workflow);
    expect(resolveLandWorkflow(pi)).toBe(workflow);
  });

  it("keeps the first land provider", () => {
    const pi = createPi();
    const first = vi.fn();
    registerLandWorkflow(pi, first);
    registerLandWorkflow(pi, vi.fn());
    expect(resolveLandWorkflow(pi)).toBe(first);
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
