import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { isAllowedToolName, keepAllowedToolset } from "../shared/events/toolPolicy";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", () => {
    keepAllowedToolset(pi);
  });

  pi.on("before_agent_start", () => {
    keepAllowedToolset(pi);
  });

  pi.on("tool_call", (event: { toolName: string }) => {
    if (isAllowedToolName(event.toolName)) {
      return;
    }

    return {
      block: true,
      terminate: true,
    };
  });
}
