import { Type } from "@earendil-works/pi-ai";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import {
  SessionManager,
  createAgentSession,
  createReadOnlyTools,
  type AgentSession,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { ExplorerManager, findRepository, type ExplorerHandle } from "../shared/subagents/manager";

const managers = new Map<string, Promise<ExplorerManager>>();

function textResult(text: string, details?: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}

function finalText(session: AgentSession): string {
  const message = [...session.messages].reverse().find((item: any) => item.role === "assistant") as any;
  return (message?.content ?? [])
    .filter((item: any) => item.type === "text")
    .map((item: any) => item.text)
    .join("\n") || "Explorer completed without a textual report.";
}

async function assertInside(root: string, requested: string): Promise<void> {
  const canonicalRoot = await realpath(root);
  const candidate = await realpath(resolve(root, requested || "."));
  const rel = relative(canonicalRoot, candidate);
  if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
    throw new Error("Explorer tools cannot access paths outside their worktree");
  }
}

function confinedReadOnlyTools(worktree: string) {
  return createReadOnlyTools(worktree).map((tool: any) => ({
    ...tool,
    async execute(toolCallId: string, params: Record<string, unknown>, ...rest: unknown[]) {
      const requested = params.path ?? params.searchDir ?? ".";
      if (typeof requested === "string") await assertInside(worktree, requested);
      return tool.execute(toolCallId, params, ...rest);
    },
  }));
}

async function createExplorer(
  worktree: string,
  ctx: ExtensionContext,
  sendToPeer: (targetId: string, message: string) => Promise<void>,
): Promise<ExplorerHandle> {
  const peerMessageTool = {
    name: "message_peer", label: "Message peer explorer",
    description: "Send a message to another explorer belonging to this same main session.",
    parameters: Type.Object({ targetId: Type.String(), message: Type.String() }),
    async execute(_call: string, { targetId, message }: { targetId: string; message: string }) {
      await sendToPeer(targetId, message);
      return textResult(`Message sent to ${targetId}.`);
    },
  };
  const { session } = await createAgentSession({
    cwd: worktree,
    model: ctx.model,
    thinkingLevel: ctx.thinkingLevel,
    sessionManager: SessionManager.inMemory(worktree),
    noTools: "all",
    customTools: [...confinedReadOnlyTools(worktree), peerMessageTool],
  });
  return {
    async run(task) {
      await session.prompt(`You are a repository explorer. Inventory and analyze only; never modify files, commit, or push. Stay inside your worktree. Report findings for this task:\n\n${task}`);
      return finalText(session);
    },
    async send(message) {
      if (session.isStreaming) session.steer(message);
      else await session.prompt(message);
    },
    dispose: () => session.dispose(),
  };
}

async function manager(ctx: ExtensionContext): Promise<ExplorerManager> {
  const sessionId = ctx.sessionManager.getSessionId();
  let current = managers.get(sessionId);
  if (!current) {
    current = findRepository(ctx.cwd).then((repository) =>
      new ExplorerManager(repository, sessionId, ({ worktree, sendToPeer }) => createExplorer(worktree, ctx, sendToPeer)),
    );
    managers.set(sessionId, current);
  }
  return current;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "spawn_explorer", label: "Spawn explorer",
    description: "Start a read-only repository explorer in an isolated Git worktree. It runs in the background.",
    promptSnippet: "Start background repository exploration",
    parameters: Type.Object({ task: Type.String({ description: "A bounded repository investigation" }) }),
    async execute(_id, { task }, _signal, _update, ctx) {
      const explorer = await (await manager(ctx)).spawn(task);
      return textResult(`${explorer.id} started in the background.`, explorer);
    },
  });
  pi.registerTool({
    name: "list_explorers", label: "List explorers",
    description: "List this main session's explorers and collect completed reports.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _update, ctx) {
      const explorers = (await manager(ctx)).list();
      return textResult(JSON.stringify(explorers, null, 2), explorers);
    },
  });
  pi.registerTool({
    name: "message_explorer", label: "Message explorer",
    description: "Send steering information to a running explorer in this main session.",
    parameters: Type.Object({ id: Type.String(), message: Type.String() }),
    async execute(_call, { id, message }, _signal, _update, ctx) {
      await (await manager(ctx)).send(id, message);
      return textResult(`Message sent to ${id}.`);
    },
  });
}
