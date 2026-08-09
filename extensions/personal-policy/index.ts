import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { keepOnlyPersonalToolset, PERSONAL_TOOLSET } from "../personal/events/toolPolicy";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", () => {
    keepOnlyPersonalToolset(pi);
  });

  pi.on("before_agent_start", () => {
    keepOnlyPersonalToolset(pi);
  });

  pi.on("tool_call", (event: { toolName: string }) => {
    if ((PERSONAL_TOOLSET as readonly string[]).includes(event.toolName)) {
      return;
    }

    return {
      block: true,
      terminate: true,
    };
  });
}
