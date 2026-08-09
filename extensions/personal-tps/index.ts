import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  handleMessageEnd,
  handleMessageUpdate,
  handleTurnEnd,
  handleTurnStart,
} from "../personal/events/tps";

export default function (pi: ExtensionAPI) {
  pi.on("turn_start", handleTurnStart);
  pi.on("message_update", handleMessageUpdate);
  pi.on("message_end", handleMessageEnd);
  pi.on("turn_end", handleTurnEnd);
}
