import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TurnMetrics } from "../types";

const STATUS_THROTTLE_MS = 250;
const CHARS_PER_TOKEN = 4;

type ContentKind = "text" | "thinking" | "toolCall";

interface ContentEstimate {
  kind: ContentKind;
  chars: number;
}

const TpsState: {
  metrics: TurnMetrics;
  contentByIndex: Map<number, ContentEstimate>;
} = {
  metrics: createMetrics(false),
  contentByIndex: new Map(),
};

function createMetrics(active: boolean): TurnMetrics {
  return {
    active,
    startAt: active ? Date.now() : 0,
    generationStartAt: 0,
    lastStatusAt: 0,
    outputChars: 0,
    outputTokens: 0,
    reportedOutputTokens: 0,
  };
}

function generationElapsedMs(): number {
  // `start` is emitted once the provider stream is available. Using it avoids
  // counting request latency as generation time, while still including silent
  // (summarized or encrypted) reasoning before the first visible delta.
  const startedAt = TpsState.metrics.generationStartAt || TpsState.metrics.startAt;
  return Math.max(0, Date.now() - startedAt);
}

function setTpsStatus(ctx: ExtensionContext, final = false) {
  const elapsedSeconds = generationElapsedMs() / 1000;
  const rate = elapsedSeconds > 0 ? TpsState.metrics.outputTokens / elapsedSeconds : 0;
  const label = final ? "done" : "live";
  const icon = final ? "✓" : "⚡";
  ctx.ui.setStatus("live-tps", `${icon} ${rate.toFixed(1)} t/s (${label})`);
}

function maybeSetTps(ctx: ExtensionContext, force = false) {
  const now = Date.now();
  if (!TpsState.metrics.active) {
    return;
  }

  const shouldUpdate = force || now - TpsState.metrics.lastStatusAt >= STATUS_THROTTLE_MS;
  if (shouldUpdate) {
    TpsState.metrics.lastStatusAt = now;
    setTpsStatus(ctx);
  }
}

function finitePositive(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function estimatedTokens(includeThinking = true): number {
  let chars = 0;
  for (const content of TpsState.contentByIndex.values()) {
    if (includeThinking || content.kind !== "thinking") {
      chars += content.chars;
    }
  }
  return chars > 0 ? Math.max(1, Math.round(chars / CHARS_PER_TOKEN)) : 0;
}

function refreshEstimate(): void {
  TpsState.metrics.outputChars = Array.from(TpsState.contentByIndex.values()).reduce(
    (total, content) => total + content.chars,
    0,
  );
  TpsState.metrics.outputTokens =
    TpsState.metrics.reportedOutputTokens || estimatedTokens();
}

function updateContent(index: unknown, kind: ContentKind, chars: number, replace = false): void {
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || !Number.isFinite(chars)) {
    return;
  }

  const current = TpsState.contentByIndex.get(index);
  TpsState.contentByIndex.set(index, {
    kind,
    chars: replace ? Math.max(0, chars) : (current?.chars ?? 0) + Math.max(0, chars),
  });
}

function maybeRecordStreamUpdate(event: { assistantMessageEvent: unknown }): void {
  const update = event.assistantMessageEvent as {
    type?: string;
    contentIndex?: unknown;
    delta?: unknown;
    content?: unknown;
    toolCall?: { name?: unknown; arguments?: unknown };
    partial?: { usage?: { output?: unknown } };
  };

  if (update.type === "start" || TpsState.metrics.generationStartAt === 0) {
    TpsState.metrics.generationStartAt = Date.now();
  }

  // Some providers expose cumulative usage during the stream. Prefer it over a
  // character estimate, but keep tracking content so providers without live
  // usage (and failed/aborted responses) still get a useful rate.
  TpsState.metrics.reportedOutputTokens = Math.max(
    TpsState.metrics.reportedOutputTokens,
    finitePositive(update.partial?.usage?.output),
  );

  if (typeof update.delta === "string") {
    if (update.type === "text_delta") {
      updateContent(update.contentIndex, "text", update.delta.length);
    } else if (update.type === "thinking_delta") {
      updateContent(update.contentIndex, "thinking", update.delta.length);
    } else if (update.type === "toolcall_delta") {
      updateContent(update.contentIndex, "toolCall", update.delta.length);
    }
  } else if (typeof update.content === "string") {
    if (update.type === "text_end") {
      updateContent(update.contentIndex, "text", update.content.length, true);
    } else if (update.type === "thinking_end") {
      // This may be only a reasoning summary. Final provider usage, when
      // available, replaces this visible-content estimate below.
      updateContent(update.contentIndex, "thinking", update.content.length, true);
    }
  }

  if (update.type === "toolcall_end" && update.toolCall) {
    // Reconcile each content index independently. This counts every call in a
    // parallel/batched tool-call response instead of treating the batch as one
    // stream or accidentally retaining duplicated partial JSON.
    const name = typeof update.toolCall.name === "string" ? update.toolCall.name : "";
    let args = "";
    try {
      args = JSON.stringify(update.toolCall.arguments ?? {}) ?? "";
    } catch {
      // Keep the streamed argument length if a custom provider supplies a
      // value that cannot be serialized.
      return refreshEstimate();
    }
    updateContent(update.contentIndex, "toolCall", name.length + args.length, true);
  }

  refreshEstimate();
}

function finalOutputTokens(usage: {
  output?: unknown;
  reasoning?: unknown;
  totalTokens?: unknown;
  input?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
} | undefined): number {
  const output = finitePositive(usage?.output);
  if (output > 0) {
    // Reasoning is documented as a subset of output, so never add it twice.
    return Math.round(output);
  }

  const total = finitePositive(usage?.totalTokens);
  if (total > 0) {
    const derivedOutput = total
      - finitePositive(usage?.input)
      - finitePositive(usage?.cacheRead)
      - finitePositive(usage?.cacheWrite);
    if (derivedOutput > 0) {
      return Math.round(derivedOutput);
    }
  }

  const reasoning = finitePositive(usage?.reasoning);
  if (reasoning > 0) {
    // Defensive fallback for providers that report a reasoning breakdown but
    // omit output. Add only visible non-thinking content; the reasoning count
    // already includes any displayed summary.
    return Math.round(reasoning) + estimatedTokens(false);
  }

  return estimatedTokens();
}

export function startTurn() {
  TpsState.metrics = createMetrics(true);
  TpsState.contentByIndex.clear();
}

export function stopTurn() {
  TpsState.metrics.active = false;
}

export function handleTurnStart(_event: unknown, ctx: ExtensionContext) {
  startTurn();
  setTpsStatus(ctx);
}

export function handleMessageUpdate(event: { message: { role: string }; assistantMessageEvent: unknown }, ctx: ExtensionContext) {
  if (event.message.role !== "assistant" || !TpsState.metrics.active) {
    return;
  }

  maybeRecordStreamUpdate(event);
  maybeSetTps(ctx);
}

export function handleMessageEnd(
  event: {
    message: {
      role: string;
      usage?: {
        output?: number;
        reasoning?: number;
        totalTokens?: number;
        input?: number;
        cacheRead?: number;
        cacheWrite?: number;
      };
    };
  },
  ctx: ExtensionContext,
) {
  if (!TpsState.metrics.active || event.message.role !== "assistant") {
    return;
  }

  // Final usage is authoritative and may include summarized, redacted, or
  // encrypted reasoning that never appeared as text deltas.
  TpsState.metrics.outputTokens = finalOutputTokens(event.message.usage);
  setTpsStatus(ctx, true);
  stopTurn();
}

export function handleTurnEnd(_event: unknown, ctx: ExtensionContext) {
  if (TpsState.metrics.active) {
    setTpsStatus(ctx, true);
    stopTurn();
  }
}

export function clearTpsStatus(ctx: ExtensionContext) {
  ctx.ui.setStatus("live-tps", undefined);
}
