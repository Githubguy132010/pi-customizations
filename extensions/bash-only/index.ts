import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { keepOnlyBashToolset } from "../shared/events/toolPolicy";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", () => {
    keepOnlyBashToolset(pi);
  });

  pi.on("before_agent_start", () => {
    keepOnlyBashToolset(pi);
  });

  pi.on("tool_call", (event: { toolName: string }) => {
    const optional = process.env.PI_EPHEMERAL_CHILD === "1" ? "request_parent_input" : "ephemeral_agent";
    if (event.toolName === "bash" || event.toolName === optional) {
      return;
    }

    return {
      block: true,
      terminate: true,
    };
  });
}
