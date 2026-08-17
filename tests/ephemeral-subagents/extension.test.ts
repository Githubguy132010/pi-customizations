import { afterEach, describe, expect, it } from "vitest";
import ephemeralAgents from "../../extensions/ephemeral-subagents";
import { createPi } from "../helpers";

const oldChild = process.env.PI_EPHEMERAL_CHILD;
const oldPaths = process.env.PI_EPHEMERAL_PATHS;
afterEach(() => { if (oldChild === undefined) delete process.env.PI_EPHEMERAL_CHILD; else process.env.PI_EPHEMERAL_CHILD = oldChild; if (oldPaths === undefined) delete process.env.PI_EPHEMERAL_PATHS; else process.env.PI_EPHEMERAL_PATHS = oldPaths; });

describe("ephemeral subagent tool exposure", () => {
  it("registers management only in the parent", () => {
    delete process.env.PI_EPHEMERAL_CHILD; const pi = createPi({ registerTool: (() => undefined) as any });
    const names: string[] = []; pi.registerTool = (tool: any) => names.push(tool.name); ephemeralAgents(pi);
    expect(names).toEqual(["ephemeral_agent"]);
  });

  it("excludes all management capabilities in children", () => {
    process.env.PI_EPHEMERAL_CHILD = "1"; process.env.PI_EPHEMERAL_PATHS = JSON.stringify({ request: "/tmp/request", response: "/tmp/response" });
    const pi = createPi(); const names: string[] = []; pi.registerTool = (tool: any) => names.push(tool.name); ephemeralAgents(pi);
    expect(names).toEqual(["request_parent_input"]); expect(names).not.toContain("ephemeral_agent");
  });
});
