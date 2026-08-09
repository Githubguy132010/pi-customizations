import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { YEET_STATUS_PREFIX, runYeetWorkflow } from "../shared/commands/yeet";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("yeet", {
    description: "Generate commit and PR details, commit changes, and optionally push/create a PR",
    handler: (args: string, ctx: ExtensionContext) => runYeetWorkflow(args, pi, ctx),
  });

  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setStatus(YEET_STATUS_PREFIX, undefined);
  });
}
