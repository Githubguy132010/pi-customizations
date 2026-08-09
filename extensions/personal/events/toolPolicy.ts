import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function keepOnlyBashToolset(pi: ExtensionAPI) {
  const active = pi.getActiveTools();
  const shouldKeep = active.length === 1 && active[0] === "bash";
  if (!shouldKeep) {
    pi.setActiveTools(["bash"]);
  }
}
