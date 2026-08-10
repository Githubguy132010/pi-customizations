import { describe, expect, it, vi } from "vitest";
import { keepOnlyBashToolset } from "../../extensions/shared/events/toolPolicy";
import { createPi } from "../helpers";

describe("bash-only tool policy", () => {
  it("does nothing when bash is the sole tool", () => {
    const pi = createPi();
    keepOnlyBashToolset(pi);
    expect(pi.setActiveTools).not.toHaveBeenCalled();
  });

  it.each([{ tools: [] }, { tools: ["read", "bash"] }, { tools: ["read"] }])("replaces toolset $tools", ({ tools }) => {
    const pi = createPi({ getActiveTools: vi.fn(() => tools) });
    keepOnlyBashToolset(pi);
    expect(pi.setActiveTools).toHaveBeenCalledWith(["bash"]);
  });
});
