import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { clearTpsStatus } from "./tps";
import { LAND_STATUS_PREFIX } from "../commands/land";
import { YEET_STATUS_PREFIX } from "../commands/yeet";
import { syncSessionWorkdirFromHistory, persistSessionWorkdir } from "../utils/sessionWorkdir";

export function handleSessionStart(pi: ExtensionAPI, event: { reason: "startup" | "reload" | "new" | "resume" | "fork" }, ctx: ExtensionContext) {
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
  clearTpsStatus(ctx);
  ctx.ui.setStatus(YEET_STATUS_PREFIX, undefined);
  ctx.ui.setStatus(LAND_STATUS_PREFIX, undefined);
}
