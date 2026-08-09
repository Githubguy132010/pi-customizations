import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setStatus("custom", `pi-customizations loaded in ${ctx.cwd}`);
  });

  pi.registerCommand("hello", {
    description: "Say hello from your Pi customization pack",
    handler: (_args, ctx) => {
      ctx.ui.notify("Hello from pi-customizations 👋", "info");
    },
  });

  pi.registerTool({
    name: "show_timestamp",
    label: "Current timestamp",
    description: "Return the current date/time in ISO format",
    parameters: Type.Object({
      label: Type.Optional(Type.String({ description: "Optional label for the response" })),
    }),
    async execute(_toolCallId, params) {
      const value = new Date().toISOString();
      const text = params.label ? `${params.label}: ${value}` : `Current timestamp: ${value}`;
      return {
        content: [{ type: "text", text }],
        details: {},
      };
    },
  });
}
