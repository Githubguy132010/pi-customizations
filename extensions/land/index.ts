import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { LAND_STATUS_PREFIX, runLandWorkflow } from "../shared/commands/land";
import { registerLandWorkflow } from "../shared/integrations/land";

export default function (pi: ExtensionAPI) {
  registerLandWorkflow(pi, (args, ctx) => runLandWorkflow(args, pi, ctx));

  pi.registerCommand("land", {
    description: "Merge or close one or more GitHub PRs and optionally clean up their branches",
    handler: (args: string, ctx: ExtensionContext) => runLandWorkflow(args, pi, ctx),
  });

  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setStatus(LAND_STATUS_PREFIX, undefined);
  });
}
