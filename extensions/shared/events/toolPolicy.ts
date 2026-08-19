import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const ALLOWED_TOOL_NAMES = ["bash", "ephemeral_agent", "ephemeral_report"];

export function keepOnlyBashToolset(pi: ExtensionAPI) {
  const active = pi.getActiveTools();
  const desired = ALLOWED_TOOL_NAMES.filter((name) =>
    pi.getAllTools?.().some((tool) => tool.name === name) ?? name === "bash"
  );
  const shouldKeep = active.length === desired.length && active.every((name, index) => name === desired[index]);
  if (!shouldKeep) {
    pi.setActiveTools(desired);
  }
}
