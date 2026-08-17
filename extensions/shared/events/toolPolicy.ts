import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function keepOnlyBashToolset(pi: ExtensionAPI) {
  const active = pi.getActiveTools();
  const optional = process.env.PI_EPHEMERAL_CHILD === "1" ? "request_parent_input" : "ephemeral_agent";
  const available = new Set(active);
  const desired = ["bash", ...(available.has(optional) ? [optional] : [])];
  const shouldKeep = active.length === desired.length && desired.every((name) => active.includes(name));
  if (!shouldKeep) {
    pi.setActiveTools(desired);
  }
}
