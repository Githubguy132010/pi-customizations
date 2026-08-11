import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { SETTLE_STATUS_PREFIX, runSettleWorkflow } from "../shared/commands/settle";
import { registerSettleWorkflow } from "../shared/integrations/settle";

export default function (pi: ExtensionAPI) {
  registerSettleWorkflow(pi, (args, ctx) => runSettleWorkflow(args, pi, ctx));

  pi.registerCommand("settle", {
    description: "Merge or close one or more GitHub PRs and optionally clean up their branches",
    handler: (args: string, ctx: ExtensionContext) => runSettleWorkflow(args, pi, ctx),
  });

  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setStatus(SETTLE_STATUS_PREFIX, undefined);
  });
}
