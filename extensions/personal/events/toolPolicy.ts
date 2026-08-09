import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const PERSONAL_TOOLSET = ["bash", "ask_question"] as const;

export function keepOnlyPersonalToolset(pi: ExtensionAPI) {
  const active = pi.getActiveTools();
  const expected = new Set<string>(PERSONAL_TOOLSET);
  const isExpected = active.length === expected.size && active.every((tool) => expected.has(tool));
  if (!isExpected) {
    pi.setActiveTools([...PERSONAL_TOOLSET]);
  }
}
