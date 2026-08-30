import { describe, it, expect, vi, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runYeetWorkflow } from "../../extensions/shared/commands/yeet";
import { createContext, createPi, createUi, result } from "../helpers";

const projectsRoot = mkdtempSync(join(tmpdir(), "yeet-projects-"));
const projA = join(projectsRoot, "ProjectA");
const projB = join(projectsRoot, "ProjectB");
mkdirSync(join(projA, ".git"), {recursive:true});
mkdirSync(join(projB, ".git"), {recursive:true});

afterAll(() => rmSync(projectsRoot, {recursive:true, force:true}));

describe("yeet multi-repo", () => {
  it("prompts for repo when multiple found", async () => {
    const pi = createPi({
      exec: vi.fn(async (cmd, args, opts) => {
        const cwd = (opts as any)?.cwd || "";
        if (cmd==="git" && args[0]==="rev-parse" && cwd===projectsRoot) return result("",1);
        if (cmd==="git" && args[0]==="status" && cwd===projB) return result(" M file.ts\n");
        if (cmd==="git" && args[0]==="add" && cwd===projB) return result();
        if (cmd==="git" && args[0]==="commit") return result();
        return result("",1, `unexpected ${cmd} ${args.join(" ")} @ ${cwd}`);
      })
    });
    const select = vi.fn();
    select.mockResolvedValueOnce("ProjectB").mockResolvedValueOnce("Commit only");
    const ui = createUi({ select });
    const ctx = createContext({ ui, cwd: projectsRoot, sessionManager: { getEntries: vi.fn(()=>[]), getCwd: vi.fn(()=>projectsRoot) } });
    await runYeetWorkflow("feat: test", pi, ctx);
    expect(select).toHaveBeenCalledWith("Multiple repositories found. Select repository for /yeet", ["ProjectA","ProjectB"]);
    expect(select).toHaveBeenCalledWith("Select yeet workflow", expect.any(Array));
    expect(pi.exec).toHaveBeenCalledWith("git", ["status","--short"], expect.objectContaining({cwd: projB}));
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining('committed "feat: test"'), "info");
  });

  it("auto-selects when single repo found", async () => {
    const singleRoot = mkdtempSync(join(tmpdir(), "single-"));
    const singleProj = join(singleRoot, "OnlyOne");
    mkdirSync(join(singleProj,".git"),{recursive:true});
    const pi = createPi({
      exec: vi.fn(async (cmd,args,opts)=>{
        const cwd=(opts as any)?.cwd||"";
        if(cmd==="git"&&args[0]==="rev-parse"&&cwd===singleRoot) return result("",1);
        if(cmd==="git"&&args[0]==="status"&&cwd===singleProj) return result(" M x\n");
        if(cmd==="git"&&args[0]==="add") return result();
        if(cmd==="git"&&args[0]==="commit") return result();
        return result("",1,`unexpected ${cmd} ${args.join(" ")} @ ${cwd}`);
      })
    });
    const select = vi.fn().mockResolvedValue("Commit only");
    const ui = createUi({ select });
    const ctx = createContext({ ui, cwd: singleRoot, sessionManager:{getEntries:vi.fn(()=>[]), getCwd:vi.fn(()=>singleRoot)}});
    await runYeetWorkflow("feat: solo", pi, ctx);
    expect(select).not.toHaveBeenCalledWith("Multiple repositories found. Select repository for /yeet", expect.anything());
    expect(select).toHaveBeenCalledWith("Select yeet workflow", expect.any(Array));
    rmSync(singleRoot,{recursive:true,force:true});
  });

  it("cancels when repo selector dismissed", async () => {
    const pi = createPi({
      exec: vi.fn(async (cmd,args,opts)=>{
        const cwd=(opts as any)?.cwd||"";
        if(cmd==="git"&&args[0]==="rev-parse"&&cwd===projectsRoot) return result("",1);
        return result("",1);
      })
    });
    const select = vi.fn().mockResolvedValue(undefined);
    const ui = createUi({ select });
    const ctx = createContext({ ui, cwd: projectsRoot, sessionManager:{getEntries:vi.fn(()=>[]), getCwd:vi.fn(()=>projectsRoot)}});
    await runYeetWorkflow("msg", pi, ctx);
    expect(ui.notify).toHaveBeenCalledWith("/yeet canceled", "warning");
  });

  it("still errors when no child repos", async () => {
    const emptyRoot = mkdtempSync(join(tmpdir(),"empty-"));
    const pi = createPi({
      exec: vi.fn(async (cmd,args,opts)=>{
        if(cmd==="git"&&args[0]==="rev-parse") return result("",1);
        return result("",1);
      })
    });
    const ui = createUi({ select: vi.fn() });
    const ctx = createContext({ ui, cwd: emptyRoot, sessionManager:{getEntries:vi.fn(()=>[]), getCwd:vi.fn(()=>emptyRoot)}});
    await runYeetWorkflow("msg", pi, ctx);
    expect(ui.notify).toHaveBeenCalledWith("/yeet: not in a git repository","error");
    rmSync(emptyRoot,{recursive:true,force:true});
  });

  it("respects --depth flag and nested repos", async () => {
    const nestedRoot = mkdtempSync(join(tmpdir(), "nested-"));
    const shallow = join(nestedRoot, "shallow");
    const group = join(nestedRoot, "group");
    const nestedProj = join(group, "NestedProj");
    mkdirSync(nestedProj, {recursive:true});
    mkdirSync(join(nestedProj,".git"),{recursive:true});
    mkdirSync(shallow,{recursive:true});
    let pi = createPi({
      exec: vi.fn(async (cmd,args,opts)=>{
        if(cmd==="git"&&args[0]==="rev-parse") return result("",1);
        return result("",1);
      })
    });
    let ui = createUi({ select: vi.fn() });
    let ctx = createContext({ ui, cwd: nestedRoot, sessionManager:{getEntries:vi.fn(()=>[]), getCwd:vi.fn(()=>nestedRoot)}});
    await runYeetWorkflow("msg", pi, ctx);
    expect(ui.notify).toHaveBeenCalledWith("/yeet: not in a git repository","error");

    pi = createPi({
      exec: vi.fn(async (cmd,args,opts)=>{
        const cwd=(opts as any)?.cwd||"";
        if(cmd==="git"&&args[0]==="rev-parse"&&cwd===nestedRoot) return result("",1);
        if(cmd==="git"&&args[0]==="status"&&cwd===nestedProj) return result(" M x\n");
        if(cmd==="git"&&args[0]==="add") return result();
        if(cmd==="git"&&args[0]==="commit") return result();
        return result("",1,`unexpected ${cmd} ${args.join(" ")} @ ${cwd}`);
      })
    });
    const select = vi.fn().mockResolvedValue("Commit only");
    ui = createUi({ select });
    ctx = createContext({ ui, cwd: nestedRoot, sessionManager:{getEntries:vi.fn(()=>[]), getCwd:vi.fn(()=>nestedRoot)}});
    await runYeetWorkflow("--depth 2 feat: nested", pi, ctx);
    expect(select).toHaveBeenCalledWith("Select yeet workflow", expect.any(Array));
    expect(pi.exec).toHaveBeenCalledWith("git", ["commit","-m","feat: nested"], expect.objectContaining({cwd: nestedProj}));
    rmSync(nestedRoot,{recursive:true,force:true});
  });

  it("parses --depth= form and strips it from commit message", async () => {
    const nestedRoot = mkdtempSync(join(tmpdir(), "depth-eq-"));
    const group = join(nestedRoot, "grp");
    const proj = join(group, "ProjEq");
    mkdirSync(proj,{recursive:true});
    mkdirSync(join(proj,".git"),{recursive:true});
    const pi = createPi({
      exec: vi.fn(async (cmd,args,opts)=>{
        const cwd=(opts as any)?.cwd||"";
        if(cmd==="git"&&args[0]==="rev-parse"&&cwd===nestedRoot) return result("",1);
        if(cmd==="git"&&args[0]==="status"&&cwd===proj) return result(" M y\n");
        if(cmd==="git"&&args[0]==="add") return result();
        if(cmd==="git"&&args[0]==="commit") return result();
        return result("",1);
      })
    });
    const select = vi.fn().mockResolvedValue("Commit only");
    const ui = createUi({ select });
    const ctx = createContext({ ui, cwd: nestedRoot, sessionManager:{getEntries:vi.fn(()=>[]), getCwd:vi.fn(()=>nestedRoot)}});
    await runYeetWorkflow("--depth=2 my commit", pi, ctx);
    expect(pi.exec).toHaveBeenCalledWith("git", ["commit","-m","my commit"], expect.anything());
    rmSync(nestedRoot,{recursive:true,force:true});
  });
});
