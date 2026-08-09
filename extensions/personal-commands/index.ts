import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { runLandWorkflow } from "../personal/commands/land";
import { runYeetWorkflow } from "../personal/commands/yeet";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("land", {
    description: "Merge or close one or more GitHub PRs and optionally clean up their branches",
    handler: (args: string, ctx: ExtensionContext) => runLandWorkflow(args, pi, ctx),
  });

  pi.registerCommand("yeet", {
    description: "Generate commit and PR details, commit changes, and optionally push/create a PR",
    handler: (args: string, ctx: ExtensionContext) => runYeetWorkflow(args, pi, ctx),
  });
}
