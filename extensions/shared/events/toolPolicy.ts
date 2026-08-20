import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { areExperimentalFeaturesEnabled } from "../experimental.mjs";

const EXPERIMENTAL_TOOL_NAMES = ["ephemeral_agent", "ephemeral_report"];

export function allowedToolNames(): string[] {
  return [
    "bash",
    ...(areExperimentalFeaturesEnabled() ? EXPERIMENTAL_TOOL_NAMES : []),
  ];
}

export function isAllowedToolName(name: string): boolean {
  return allowedToolNames().includes(name);
}

export function keepAllowedToolset(pi: ExtensionAPI) {
  const active = pi.getActiveTools();
  const desired = allowedToolNames().filter((name) =>
    pi.getAllTools?.().some((tool) => tool.name === name) ?? name === "bash"
  );
  const shouldKeep = active.length === desired.length && desired.every((name) => active.includes(name));
  if (!shouldKeep) {
    pi.setActiveTools(desired);
  }
}
