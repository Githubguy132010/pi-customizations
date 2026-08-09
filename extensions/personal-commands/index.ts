import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { runYeetWorkflow } from "../personal/commands/yeet";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("yeet", {
    description: "Commit changes, and optionally push and/or create a PR",
    handler: (args: string, ctx: ExtensionContext) => runYeetWorkflow(args, pi, ctx),
  });
}
