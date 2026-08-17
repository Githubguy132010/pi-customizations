import { readFile, rm, writeFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { EphemeralAgentManager } from "./manager";
import type { AgentPaths } from "./types";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const PARENT_INPUT_TIMEOUT_MS = 30 * 60_000;

function registerChildTool(pi: ExtensionAPI): void {
  const paths = JSON.parse(process.env.PI_EPHEMERAL_PATHS ?? "null") as AgentPaths | null;
  if (!paths) return;
  pi.registerTool({
    name: "request_parent_input", label: "Ask parent", description: "Ask the parent agent for information required to continue, then wait for its response.",
    parameters: Type.Object({ question: Type.String() }),
    async execute(_id, params, signal) {
      await rm(paths.response, { force: true });
      await writeFile(paths.request, JSON.stringify({ question: params.question }), { mode: 0o600 });
      const deadline = Date.now() + PARENT_INPUT_TIMEOUT_MS;
      while (!signal?.aborted) {
        try { const response = JSON.parse(await readFile(paths.response, "utf8")) as { message: string }; await rm(paths.request, { force: true }); await rm(paths.response, { force: true }); return { content: [{ type: "text" as const, text: response.message }], details: {} }; } catch { await sleep(200); }
        if (Date.now() >= deadline) {
          throw new Error(`timed out after ${PARENT_INPUT_TIMEOUT_MS}ms waiting for a valid parent response`);
        }
      }
      throw new Error("cancelled while waiting for parent input");
    },
  });
}

const Params = Type.Object({
  action: Type.Union([Type.Literal("spawn"), Type.Literal("status"), Type.Literal("message"), Type.Literal("cancel"), Type.Literal("cleanup")]),
  task: Type.Optional(Type.String()), id: Type.Optional(Type.String()), message: Type.Optional(Type.String()), background: Type.Optional(Type.Boolean()), timeoutMs: Type.Optional(Type.Number({ minimum: 1000 })),
});

export default function (pi: ExtensionAPI) {
  if (process.env.PI_EPHEMERAL_CHILD === "1") { registerChildTool(pi); return; }
  let manager: EphemeralAgentManager | undefined;
  pi.on("session_start", async (_event, ctx) => {
    manager = new EphemeralAgentManager({ repoRoot: ctx.cwd, onNudge: (agent) => ctx.ui.notify(`Ephemeral agent ${agent.id}: ${agent.state}${agent.question ? ` — ${agent.question}` : ""}`, agent.state === "failed" ? "error" : "info") });
    try { await manager.initialize(); } catch (error) { ctx.ui.notify(`Ephemeral agents unavailable: ${error instanceof Error ? error.message : String(error)}`, "warning"); }
  });
  pi.registerTool({
    name: "ephemeral_agent", label: "Ephemeral agent", description: "Create and manage isolated, non-recursive subagents. Background completion and input requests produce a brief notification; use status for detailed output.", parameters: Params,
    async execute(_id, params) {
      if (!manager) throw new Error("ephemeral agent manager is not initialized");
      let result: unknown;
      if (params.action === "spawn") result = await manager.spawn({ task: params.task ?? "", background: params.background, timeoutMs: params.timeoutMs });
      else if (!params.id) throw new Error(`id is required for ${params.action}`);
      else if (params.action === "status") result = await manager.status(params.id);
      else if (params.action === "message") result = await manager.message(params.id, params.message ?? "");
      else if (params.action === "cancel") result = await manager.cancel(params.id);
      else { await manager.cleanup(params.id); result = { id: params.id, cleaned: true }; }
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }], details: result };
    },
  });
}
