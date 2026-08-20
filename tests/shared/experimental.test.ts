import { describe, expect, it } from "vitest";
import { areExperimentalFeaturesEnabled } from "../../extensions/shared/experimental.mjs";

describe("experimental features", () => {
  it("only enables experimental features for the exact opt-in value", () => {
    expect(areExperimentalFeaturesEnabled({})).toBe(false);
    expect(areExperimentalFeaturesEnabled({ PI_EXPERIMENTAL: "true" })).toBe(false);
    expect(areExperimentalFeaturesEnabled({ PI_EXPERIMENTAL: "1" })).toBe(true);
  });
});
