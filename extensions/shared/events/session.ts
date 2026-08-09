import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { syncSessionWorkdirFromHistory, persistSessionWorkdir } from "../utils/sessionWorkdir";

export function handleSessionStart(
  pi: ExtensionAPI,
  event: { reason: "startup" | "reload" | "new" | "resume" | "fork" },
  ctx: ExtensionContext,
) {
  syncSessionWorkdirFromHistory(ctx);
  persistSessionWorkdir(pi, event.reason);
}

export function handleSessionShutdown(
  pi: ExtensionAPI,
  event: { reason: "quit" | "reload" | "new" | "resume" | "fork"; targetSessionFile?: string },
  ctx: ExtensionContext,
) {
  syncSessionWorkdirFromHistory(ctx);
  persistSessionWorkdir(pi, event.reason);
}
