import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { runYeetWorkflow } from "../personal/commands/yeet";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("yeet", {
    description: "Generate a commit message, commit changes, and optionally push/create a PR",
    handler: (args: string, ctx: ExtensionContext) => runYeetWorkflow(args, pi, ctx),
  });
}
