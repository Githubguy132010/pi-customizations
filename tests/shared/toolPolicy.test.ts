import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { allowedToolNames, keepAllowedToolset } from "../../extensions/shared/events/toolPolicy";
import { createPi } from "../helpers";

describe("bash-only tool policy", () => {
  beforeEach(() => vi.stubEnv("PI_EXPERIMENTAL", undefined));
  afterEach(() => vi.unstubAllEnvs());

  it("does nothing when bash is the sole tool", () => {
    const pi = createPi();
    keepAllowedToolset(pi);
    expect(pi.setActiveTools).not.toHaveBeenCalled();
  });

  it.each([{ tools: [] }, { tools: ["read", "bash"] }, { tools: ["read"] }])("replaces toolset $tools", ({ tools }) => {
    const pi = createPi({ getActiveTools: vi.fn(() => tools) });
    keepAllowedToolset(pi);
    expect(pi.setActiveTools).toHaveBeenCalledWith(["bash"]);
  });

  it("falls back to bash when tool discovery is unavailable", () => {
    const pi = createPi({ getAllTools: undefined });
    keepAllowedToolset(pi);
    expect(pi.setActiveTools).not.toHaveBeenCalled();
  });

  it("includes available coordination tools when experimental features are enabled", () => {
    vi.stubEnv("PI_EXPERIMENTAL", "1");
    try {
      const pi = createPi({
        getActiveTools: vi.fn(() => ["bash"]),
        getAllTools: vi.fn(() => [
          { name: "bash" },
          { name: "ephemeral_agent" },
          { name: "ephemeral_report" },
        ]),
      });

      expect(allowedToolNames()).toEqual(["bash", "ephemeral_agent", "ephemeral_report"]);
      keepAllowedToolset(pi);
      expect(pi.setActiveTools).toHaveBeenCalledWith(["bash", "ephemeral_agent", "ephemeral_report"]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
