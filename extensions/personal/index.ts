import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { handleMessageEnd, handleMessageUpdate, handleTurnEnd, handleTurnStart } from "./events/tps";
import { keepOnlyBashToolset } from "./events/toolPolicy";
import { handleSessionShutdown, handleSessionStart } from "./events/session";
import { runYeetWorkflow } from "./commands/yeet";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (event: { reason: "startup" | "reload" | "new" | "resume" | "fork" }, ctx: ExtensionContext) => {
    handleSessionStart(pi, event, ctx);
    keepOnlyBashToolset(pi);
  });

  pi.on("before_agent_start", (_event: unknown, _ctx: unknown) => {
    keepOnlyBashToolset(pi);
  });

  pi.on("turn_start", handleTurnStart);
  pi.on("message_update", handleMessageUpdate);
  pi.on("message_end", handleMessageEnd);

  pi.on("tool_call", (event: { toolName: string }) => {
    if (event.toolName === "bash") {
      return;
    }

    return {
      block: true,
      terminate: true,
    };
  });

  pi.on("turn_end", handleTurnEnd);

  pi.on("session_shutdown", (event: { reason: "quit" | "reload" | "new" | "resume" | "fork"; targetSessionFile?: string }, ctx: ExtensionContext) => {
    handleSessionShutdown(pi, event, ctx);
  });

  pi.registerCommand("yeet", {
    description: "Commit changes, and optionally push and/or create a PR",
    handler: (args: string, ctx: ExtensionContext) => runYeetWorkflow(args, pi, ctx),
  });
}
