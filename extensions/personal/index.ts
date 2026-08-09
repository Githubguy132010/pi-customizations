import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

interface TurnMetrics {
  active: boolean;
  startAt: number;
  lastStatusAt: number;
  outputChars: number;
  outputTokens: number;
}

const TpsState = {
  metrics: {
    active: false,
    startAt: 0,
    lastStatusAt: 0,
    outputChars: 0,
    outputTokens: 0,
  } satisfies TurnMetrics,
};

const STATUS_THROTTLE_MS = 250;

function keepOnlyBashToolset(pi: ExtensionAPI) {
  const active = pi.getActiveTools();
  const shouldKeep = active.length === 1 && active[0] === "bash";
  if (!shouldKeep) {
    pi.setActiveTools(["bash"]);
  }
}

function startTurn() {
  TpsState.metrics = {
    active: true,
    startAt: Date.now(),
    lastStatusAt: 0,
    outputChars: 0,
    outputTokens: 0,
  };
}

function stopTurn() {
  TpsState.metrics.active = false;
}

function maybeRecordDeltaTokens(event: { assistantMessageEvent: unknown }): void {
  const update = event.assistantMessageEvent as {
    type?: string;
    delta?: unknown;
    partial?: {
      usage?: {
        output?: number;
      };
    };
  };

  const typedUsage = update.partial?.usage;
  if (typeof typedUsage?.output === "number" && Number.isFinite(typedUsage.output) && typedUsage.output > 0) {
    TpsState.metrics.outputTokens = Math.max(TpsState.metrics.outputTokens, typedUsage.output);
    return;
  }

  if (update.type === "text_delta" || update.type === "thinking_delta" || update.type === "toolcall_delta") {
    if (typeof update.delta === "string") {
      TpsState.metrics.outputChars += update.delta.length;
      const estimatedTokens = Math.max(1, Math.round(update.delta.length / 4));
      TpsState.metrics.outputTokens = Math.max(TpsState.metrics.outputTokens, TpsState.metrics.outputTokens + estimatedTokens);
    }
  }
}

function setTpsStatus(ctx: ExtensionContext, final = false) {
  const elapsedMs = Date.now() - TpsState.metrics.startAt;
  if (elapsedMs <= 0) {
    return;
  }

  const elapsedSeconds = elapsedMs / 1000;
  const rate = TpsState.metrics.outputTokens / elapsedSeconds;
  const label = final ? "done" : "live";
  const icon = final ? "✓" : "⚡";
  ctx.ui.setStatus("live-tps", `${icon} ${rate.toFixed(1)} t/s (${label})`);
}

function maybeSetTps(ctx: ExtensionContext, force = false) {
  const now = Date.now();
  if (TpsState.metrics.active) {
    const shouldUpdate = force || now - TpsState.metrics.lastStatusAt > STATUS_THROTTLE_MS;
    if (shouldUpdate) {
      TpsState.metrics.lastStatusAt = now;
      setTpsStatus(ctx);
    }
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, _ctx) => {
    keepOnlyBashToolset(pi);
  });

  pi.on("before_agent_start", (_event, _ctx) => {
    keepOnlyBashToolset(pi);
  });

  pi.on("turn_start", (_event, ctx) => {
    startTurn();
    setTpsStatus(ctx);
  });

  pi.on("message_update", (event, ctx) => {
    if (event.message.role !== "assistant") {
      return;
    }

    if (!TpsState.metrics.active) {
      return;
    }

    maybeRecordDeltaTokens(event);
    maybeSetTps(ctx);
  });

  pi.on("message_end", (event, ctx) => {
    if (!TpsState.metrics.active) {
      return;
    }

    if (event.message.role !== "assistant") {
      return;
    }

    if (typeof event.message.usage?.output === "number" && event.message.usage.output > 0) {
      TpsState.metrics.outputTokens = Math.max(TpsState.metrics.outputTokens, event.message.usage.output);
    } else if (event.message.usage && typeof event.message.usage.totalTokens === "number") {
      const output = event.message.usage.totalTokens - (event.message.usage.input ?? 0);
      if (Number.isFinite(output) && output > 0) {
        TpsState.metrics.outputTokens = Math.max(TpsState.metrics.outputTokens, Math.round(output));
      }
    }

    if (TpsState.metrics.outputChars > 0 && TpsState.metrics.outputTokens === 0) {
      TpsState.metrics.outputTokens = Math.max(1, Math.round(TpsState.metrics.outputChars / 4));
    }

    setTpsStatus(ctx, true);
    stopTurn();
  });

  pi.on("tool_call", (event) => {
    if (event.toolName === "bash") {
      return;
    }

    return {
      block: true,
      terminate: true,
    };
  });

  pi.on("turn_end", (_event, ctx) => {
    if (TpsState.metrics.active) {
      setTpsStatus(ctx, true);
      stopTurn();
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    stopTurn();
    ctx.ui.setStatus("live-tps", undefined);
  });
}
