import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { handleSessionShutdown, handleSessionStart } from "../personal/events/session";

export default function (pi: ExtensionAPI) {
  pi.on(
    "session_start",
    (event: { reason: "startup" | "reload" | "new" | "resume" | "fork" }, ctx: ExtensionContext) => {
      handleSessionStart(pi, event, ctx);
    },
  );

  pi.on(
    "session_shutdown",
    (
      event: { reason: "quit" | "reload" | "new" | "resume" | "fork"; targetSessionFile?: string },
      ctx: ExtensionContext,
    ) => {
      handleSessionShutdown(pi, event, ctx);
    },
  );
}
