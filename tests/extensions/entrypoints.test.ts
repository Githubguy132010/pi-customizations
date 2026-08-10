import { describe, expect, it, vi } from "vitest";
import bashOnly from "../../extensions/bash-only";
import land from "../../extensions/land";
import sessionWorkdir from "../../extensions/session-workdir";
import slashVisibility from "../../extensions/slash-command-visibility";
import yeet from "../../extensions/yeet";
import { createContext, createPi } from "../helpers";

function handlers(pi: any) {
  return Object.fromEntries(pi.on.mock.calls.map(([name, handler]: any[]) => [name, handler]));
}

describe("extension entrypoints", () => {
  it("bash-only registers guards for lifecycle and tool calls", () => {
    const pi = createPi({ getActiveTools: vi.fn(() => ["read", "bash"]) });
    bashOnly(pi);
    const h = handlers(pi);
    h.session_start(); h.before_agent_start();
    expect(pi.setActiveTools).toHaveBeenCalledTimes(2);
    expect(h.tool_call({ toolName: "bash" })).toBeUndefined();
    expect(h.tool_call({ toolName: "read" })).toEqual({ block: true, terminate: true });
  });

  it("land registers its command, integration, and status cleanup", async () => {
    const pi = createPi(); land(pi);
    expect(pi.registerCommand).toHaveBeenCalledWith("land", expect.objectContaining({ description: expect.any(String), handler: expect.any(Function) }));
    const ctx = createContext();
    handlers(pi).session_shutdown({}, ctx);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("land", undefined);
    const request: any = {}; pi.events.emit("pi-customizations:land-workflow-request", request);
    expect(request.workflow).toEqual(expect.any(Function));
    const noUi = createContext({ hasUI: false });
    await request.workflow("", noUi);
    expect(noUi.ui.notify).toHaveBeenCalledWith("/land requires interactive UI for now", "warning");
    await pi.registerCommand.mock.calls[0][1].handler("", noUi);
  });

  it("yeet registers its command and clears status on shutdown", async () => {
    const pi = createPi(); yeet(pi);
    expect(pi.registerCommand).toHaveBeenCalledWith("yeet", expect.objectContaining({ description: expect.any(String), handler: expect.any(Function) }));
    const ctx = createContext(); handlers(pi).session_shutdown({}, ctx);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("yeet", undefined);
    const command = pi.registerCommand.mock.calls[0][1];
    const noUi = createContext({ hasUI: false });
    await command.handler("", noUi);
    expect(noUi.ui.notify).toHaveBeenCalledWith("/yeet requires interactive UI for now", "warning");
  });

  it("session-workdir registers lifecycle handlers and resolver", () => {
    const pi = createPi(); sessionWorkdir(pi);
    expect(pi.on.mock.calls.map((call: any[]) => call[0])).toEqual(["session_start", "session_shutdown"]);
    const request: any = {}; pi.events.emit("pi-customizations:workdir-resolver-request", request);
    expect(request.resolver).toEqual(expect.any(Function));
    const ctx = createContext({ cwd: process.cwd(), sessionManager: { getEntries: vi.fn(() => []), getCwd: vi.fn(() => process.cwd()) } });
    const h = handlers(pi); h.session_start({ reason: "startup" }, ctx); h.session_shutdown({ reason: "quit" }, ctx);
    expect(pi.appendEntry).toHaveBeenCalledTimes(2);
  });
});

describe("slash command visibility", () => {
  it("wraps autocomplete and removes hidden slash commands", async () => {
    const pi = createPi(); slashVisibility(pi);
    const ctx = createContext(); handlers(pi).session_start({}, ctx);
    expect(ctx.ui.addAutocompleteProvider).toHaveBeenCalledOnce();

    const applyCompletion = vi.fn(() => ({ lines: ["done"], cursorLine: 0, cursorCol: 4 }));
    const current = {
      triggerCharacters: ["/"],
      getSuggestions: vi.fn().mockResolvedValue({ prefix: "/", items: [{ value: "name" }, { value: "land" }, { value: "compact" }] }),
      applyCompletion,
      shouldTriggerFileCompletion: vi.fn(() => false),
    };
    const provider = ctx.ui.addAutocompleteProvider.mock.calls[0][0](current);
    await expect(provider.getSuggestions(["/"], 0, 1, {})).resolves.toEqual({ prefix: "/", items: [{ value: "land" }] });
    expect(provider.applyCompletion([], 0, 0, { value: "land" }, "/")).toEqual({ lines: ["done"], cursorLine: 0, cursorCol: 4 });
    expect(provider.shouldTriggerFileCompletion([], 0, 0)).toBe(false);
  });

  it("passes through non-slash/null suggestions and returns null when all are hidden", async () => {
    const pi = createPi(); slashVisibility(pi); const ctx = createContext(); handlers(pi).session_start({}, ctx);
    const make = (suggestions: any, trigger?: any) => ctx.ui.addAutocompleteProvider.mock.calls[0][0]({
      triggerCharacters: [], getSuggestions: vi.fn().mockResolvedValue(suggestions), applyCompletion: vi.fn(), shouldTriggerFileCompletion: trigger,
    });
    const ordinary = { prefix: "abc", items: [{ value: "name" }] };
    await expect(make(ordinary).getSuggestions([], 0, 0, {})).resolves.toBe(ordinary);
    await expect(make(null).getSuggestions([], 0, 0, {})).resolves.toBeNull();
    await expect(make({ prefix: "/n", items: [{ value: "name" }] }).getSuggestions([], 0, 0, {})).resolves.toBeNull();
    expect(make(ordinary).shouldTriggerFileCompletion([], 0, 0)).toBe(true);
  });
});
