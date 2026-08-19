import { resolve } from "node:path";
import { appendFile } from "node:fs/promises";
import { Type } from "typebox";
import { RpcClient, type ExtensionAPI, type ExtensionContext, type RpcClientOptions } from "@earendil-works/pi-coding-agent";

import { EphemeralAgentManager, type AgentClient, type EphemeralAgentSnapshot } from "../shared/ephemeralAgents";
import { resolveRepoRoot } from "../shared/utils/git";
import { runCommand, summarizeError } from "../shared/utils/exec";

const CLI_PATH = resolve(__dirname, "../../bin/pi-coding-agent.mjs");

const parameters = Type.Object({
  action: Type.Union([
    Type.Literal("start"), Type.Literal("status"), Type.Literal("message"),
    Type.Literal("wait"), Type.Literal("close"),
  ]),
  id: Type.Optional(Type.String({ description: "Agent id for status, message, wait, or close" })),
  name: Type.Optional(Type.String({ description: "Short label used in a new agent id" })),
  task: Type.Optional(Type.String({ description: "Task for a new agent" })),
  message: Type.Optional(Type.String({ description: "Follow-up message for an existing agent" })),
  background: Type.Optional(Type.Boolean({ description: "Return after starting instead of waiting for completion" })),
  wait: Type.Optional(Type.Boolean({ description: "Wait for the agent after sending a message" })),
  timeout_seconds: Type.Optional(Type.Number({ minimum: 1, maximum: 3600 })),
  remove_workspace: Type.Optional(Type.Boolean({ description: "Delete the workspace when closing. Defaults to true" })),
});

const reportParameters = Type.Object({
  kind: Type.Union([Type.Literal("update"), Type.Literal("question")]),
  message: Type.String(),
});

function textResult(value: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
    details: undefined,
    isError,
  };
}

function requireText(value: string | undefined, field: string): string {
  if (!value?.trim()) throw new Error(`${field} is required for this action`);
  return value.trim();
}

function formatSnapshots(snapshots: EphemeralAgentSnapshot | EphemeralAgentSnapshot[]) {
  return Array.isArray(snapshots) ? { agents: snapshots } : snapshots;
}

export async function cloneIsolatedRepo(
  pi: ExtensionAPI,
  source: string,
  destination: string,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<void> {
  const options = { signal, timeout: timeoutMs };
  const clone = await runCommand(
    pi,
    "git",
    ["clone", "--local", "--no-hardlinks", "--quiet", source, destination],
    process.cwd(),
    options,
  );
  if (clone.code !== 0) throw new Error(`Could not create the agent checkout: ${summarizeError(clone)}`);

  const disconnect = await runCommand(
    pi,
    "git",
    ["-C", destination, "remote", "remove", "origin"],
    process.cwd(),
    options,
  );
  if (disconnect.code !== 0) throw new Error(`Could not isolate the agent checkout: ${summarizeError(disconnect)}`);
}

export type EphemeralAgentController = Pick<
  EphemeralAgentManager,
  "spawn" | "status" | "send" | "wait" | "close" | "dispose"
>;

export function createRpcClient(options: RpcClientOptions): AgentClient {
  return new RpcClient(options);
}

export default function (pi: ExtensionAPI, managerOverride?: EphemeralAgentController) {
  if (process.env.PI_EPHEMERAL_SUBAGENT) {
    const mailbox = process.env.PI_EPHEMERAL_MAILBOX;
    if (!mailbox) return;
    pi.registerTool({
      name: "ephemeral_report",
      label: "Report to parent",
      description: "Send a progress update or question to the parent agent. Continue working unless you need an answer.",
      parameters: reportParameters,
      async execute(_toolCallId, params) {
        const message = params.message.trim();
        if (!message) return textResult("message is required", true);
        await appendFile(mailbox, `${JSON.stringify({ kind: params.kind, message, timestamp: new Date().toISOString() })}\n`);
        return textResult("Report sent");
      },
    });
    return;
  }

  const manager = managerOverride ?? new EphemeralAgentManager({
    cliPath: CLI_PATH,
    cloneRepo: cloneIsolatedRepo.bind(undefined, pi),
    createClient: createRpcClient,
  });

  pi.registerTool({
    name: "ephemeral_agent",
    label: "Ephemeral agent",
    description: [
      "Manage separate, short-lived coding agents. Actions: start creates a private scratch/repo checkout and runs a task;",
      "status lists agents; message steers active work or starts a new turn when idle; wait waits for a result; close kills the process and normally deletes its workspace.",
      "Use background starts for parallel work. Changes stay in each checkout until you inspect or copy them.",
    ].join(" "),
    promptSnippet: "Start and coordinate short-lived agents in private repository checkouts",
    promptGuidelines: [
      "Use ephemeral_agent with background=true to run independent tasks in parallel, then wait for their results.",
      "Inspect or copy useful changes from an agent's repo path before closing it, because close deletes the workspace by default.",
    ],
    parameters,
    executionMode: "parallel",
    async execute(_toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) {
      try {
        const timeoutMs = (params.timeout_seconds ?? 600) * 1000;
        switch (params.action) {
          case "start": {
            const repoRoot = await resolveRepoRoot(pi, ctx);
            if (!repoRoot) throw new Error("Start ephemeral agents from inside a Git repository");
            const snapshot = await manager.spawn({
              name: params.name,
              task: requireText(params.task, "task"),
              sourceRepo: repoRoot,
              model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
              thinkingLevel: ctx.thinkingLevel,
              background: params.background ?? false,
              timeoutMs,
              signal,
            });
            return textResult(formatSnapshots(snapshot));
          }
          case "status":
            return textResult(formatSnapshots(await manager.status(params.id)));
          case "message":
            return textResult(formatSnapshots(await manager.send(
              requireText(params.id, "id"), requireText(params.message, "message"),
              { wait: params.wait ?? false, timeoutMs, signal },
            )));
          case "wait":
            return textResult(formatSnapshots(await manager.wait(requireText(params.id, "id"), timeoutMs, signal)));
          case "close":
            return textResult(formatSnapshots(await manager.close(requireText(params.id, "id"), params.remove_workspace ?? true)));
        }
      } catch (error) {
        return textResult(error instanceof Error ? error.message : String(error), true);
      }
    },
  });

  pi.on("session_shutdown", async () => {
    await manager.dispose();
  });
}
