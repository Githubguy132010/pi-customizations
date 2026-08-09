import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { LAND_STATUS_PREFIX } from "../commands/land";
import { YEET_STATUS_PREFIX } from "../commands/yeet";
import { syncSessionWorkdirFromHistory, persistSessionWorkdir } from "../utils/sessionWorkdir";
import { clearPullRequestStatus, refreshPullRequestStatus } from "./prStatus";

export function handleSessionStart(pi: ExtensionAPI, event: { reason: "startup" | "reload" | "new" | "resume" | "fork" }, ctx: ExtensionContext) {
  syncSessionWorkdirFromHistory(ctx);
  persistSessionWorkdir(pi, event.reason);
  void refreshPullRequestStatus(pi, ctx);
}

export function handleSessionShutdown(
  pi: ExtensionAPI,
  event: { reason: "quit" | "reload" | "new" | "resume" | "fork"; targetSessionFile?: string },
  ctx: ExtensionContext,
) {
  syncSessionWorkdirFromHistory(ctx);
  persistSessionWorkdir(pi, event.reason);
  ctx.ui.setStatus(YEET_STATUS_PREFIX, undefined);
  ctx.ui.setStatus(LAND_STATUS_PREFIX, undefined);
  clearPullRequestStatus(ctx);
}
