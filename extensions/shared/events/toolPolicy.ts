import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function allowedToolNames(): string[] {
  return ["bash"];
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
