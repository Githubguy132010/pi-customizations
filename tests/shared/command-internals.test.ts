import { describe, expect, it, vi } from "vitest";
import { __testing as land, runLandWorkflow } from "../../extensions/shared/commands/land";
import { __testing as yeet } from "../../extensions/shared/commands/yeet";
import { createContext, createPi, createUi, result } from "../helpers";

const pr = (overrides: any = {}) => ({ number: 1, title: "Test", state: "OPEN", isDraft: false, headRefName: "feat", baseRefName: "main", url: "url", statusCheckRollup: [], ...overrides });
const key = (c: string, a: string[]) => `${c} ${a.join(" ")}`;
const dispatcher = (routes: Record<string, any>) => vi.fn(async (c: string, a: string[]) => routes[key(c, a)] ?? result("", 1, `missing ${key(c,a)}`));
const fields = "number,title,state,isDraft,headRefName,baseRefName,url,mergeable,mergeStateStatus,statusCheckRollup";

describe("land internals", () => {
  it("parses JSON and classifies checks", () => {
    expect(land.parseJson('{"a":1}')).toEqual({a:1}); expect(land.parseJson("x")).toBeUndefined();
    expect(land.hasPendingChecks(pr())).toBe(false);
    for (const value of ["expected","pending","queued","in_progress","requested","waiting"]) {
      expect(land.hasPendingChecks(pr({ statusCheckRollup: [{ status: value }] }))).toBe(true);
      expect(land.hasPendingChecks(pr({ statusCheckRollup: [{ state: value }] }))).toBe(true);
    }
    expect(land.hasPendingChecks(pr({ statusCheckRollup: [{ status: "complete", state: "success" }] }))).toBe(false);
  });

  it("summarizes every check category", () => {
    expect(land.checkSummary(pr())).toBe("checks unavailable");
    const checks = ["SUCCESS","NEUTRAL","SKIPPED"].map(conclusion => ({conclusion}));
    checks.push(...["FAILURE","ERROR","CANCELLED","TIMED_OUT","ACTION_REQUIRED"].map(conclusion => ({conclusion})) as any);
    checks.push(...["EXPECTED","PENDING","QUEUED","IN_PROGRESS","REQUESTED","WAITING"].map(status => ({status})) as any);
    checks.push({ conclusion: "UNKNOWN" } as any);
    expect(land.checkSummary(pr({statusCheckRollup: checks}))).toBe("3 passing, 5 failing, 6 pending");
  });

  it("offers actions based on state and pending checks", () => {
    expect(land.actionOptions(pr()).map((x:any)=>x.action)).toEqual(["merge","close"]);
    expect(land.actionOptions(pr({statusCheckRollup:[{status:"PENDING"}]})).map((x:any)=>x.action)).toEqual(["merge","auto","close"]);
    expect(land.actionOptions(pr({state:"MERGED"}))).toEqual([{label:"Clean up branches for merged PR",action:"cleanup"}]);
  });

  it("reads valid, invalid, and failed pull requests", async () => {
    for (const [response, expected] of [[result(JSON.stringify(pr())), "pr"], [result("bad"), "error"], [result("",1,"fail"), "error"]] as const) {
      const pi=createPi({exec:vi.fn().mockResolvedValue(response)}); const got=await land.readPullRequest(pi,"/r","1");
      expect(got[expected]).toBeTruthy();
    }
  });

  it("selects PRs in RPC mode and handles listing variants", async () => {
    const listKey=`gh pr list --state open --limit 50 --json ${fields}`;
    const viewKey=`gh pr view --json ${fields}`;
    let pi=createPi({exec:dispatcher({[viewKey]:result(JSON.stringify(pr({state:"CLOSED"})) )})});
    expect(await land.selectOpenPullRequests(pi,createContext(),"/r")).toHaveLength(1);
    pi=createPi({exec:dispatcher({[viewKey]:result(JSON.stringify(pr())),[listKey]:result("",1)})});
    expect(await land.selectOpenPullRequests(pi,createContext(),"/r")).toHaveLength(1);
    pi=createPi({exec:dispatcher({[viewKey]:result("",1),[listKey]:result("",1,"oops")})});
    let ctx=createContext(); expect(await land.selectOpenPullRequests(pi,ctx,"/r")).toEqual([]); expect(ctx.ui.notify).toHaveBeenCalled();
    pi=createPi({exec:dispatcher({[viewKey]:result(JSON.stringify(pr())),[listKey]:result(JSON.stringify([pr()]))})});
    expect(await land.selectOpenPullRequests(pi,createContext(),"/r")).toHaveLength(1);
    const prs=[pr(),pr({number:2,title:"Two"})];
    pi=createPi({exec:dispatcher({[viewKey]:result("",1),[listKey]:result(JSON.stringify(prs))})});
    ctx=createContext({ui:createUi({select:vi.fn().mockResolvedValue("#2 Two (feat → main)")})});
    expect((await land.selectOpenPullRequests(pi,ctx,"/r"))[0].number).toBe(2);
    ctx=createContext({ui:createUi({select:vi.fn().mockResolvedValue(undefined)})});
    expect(await land.selectOpenPullRequests(pi,ctx,"/r")).toEqual([]);
  });

  it("drives the TUI checklist renderer and every input", async () => {
    const prs=Array.from({length:13},(_,i)=>pr({number:i+1,title:`P${i+1}`}));
    const exec=dispatcher({[`gh pr view --json ${fields}`]:result(JSON.stringify(prs[0])),[`gh pr list --state open --limit 50 --json ${fields}`]:result(JSON.stringify(prs))});
    const custom=vi.fn(async (factory:any)=>{
      let doneValue:any; const tui={requestRender:vi.fn()}; const theme={fg:(_c:string,s:string)=>s,bold:(s:string)=>s};
      const component=factory(tui,theme,{},(v:any)=>{doneValue=v});
      expect(component.render(50).length).toBeGreaterThan(3); component.invalidate();
      for(const input of ["\x1b[B","\x1b[A"," ","a","a"," ","\r"]) component.handleInput(input);
      return doneValue;
    });
    const ctx=createContext({mode:"tui",ui:createUi({custom})});
    expect(await land.selectOpenPullRequests(createPi({exec}),ctx,"/r")).toHaveLength(1);
    const cancel=vi.fn(async(factory:any)=>{let value:any;const c=factory({requestRender:vi.fn()},{fg:(_c:string,s:string)=>s,bold:(s:string)=>s},{},(v:any)=>value=v);c.handleInput("\x1b");return value});
    ctx.ui.custom=cancel; expect(await land.selectOpenPullRequests(createPi({exec}),ctx,"/r")).toEqual([]);
  });

  it("chooses configured, origin, sole, selected, and absent remotes", async () => {
    const remoteOut=(names:string[])=>names.map(n=>`${n} url (${n==="x"?"other":"fetch"})`).join("\n");
    let pi=createPi({exec:dispatcher({"git config --get branch.main.remote":result("upstream\n")})});
    expect(await land.chooseRemote(pi,createContext(),"/r","main")).toBe("upstream");
    for(const [names,want] of [[[],undefined],[["origin","up"],"origin"],[["solo"],"solo"]] as any) {
      pi=createPi({exec:dispatcher({"git config --get branch.main.remote":result("",1),"git remote -v":result(remoteOut(names))})});
      expect(await land.chooseRemote(pi,createContext(),"/r","main")).toBe(want);
    }
    pi=createPi({exec:dispatcher({"git config --get branch.main.remote":result(".\n"),"git remote -v":result(remoteOut(["a","b"]))})});
    expect(await land.chooseRemote(pi,createContext({ui:createUi({select:vi.fn().mockResolvedValue("b (url)")})}),"/r","main")).toBe("b");
  });

  it("checks branch existence", async()=>{
    expect(await land.branchExists(createPi({exec:vi.fn().mockResolvedValue(result())}),"/r","x")).toBe(true);
    expect(await land.branchExists(createPi({exec:vi.fn().mockResolvedValue(result("",1))}),"/r","x")).toBe(false);
  });
});

describe("yeet internals",()=>{
  const model={id:"m"};
  const registry=(response:any, found:any=model, auth=true)=>({find:vi.fn(()=>found),hasConfiguredAuth:vi.fn(()=>auth),complete:vi.fn().mockResolvedValue(response)});
  it("completes text and validates model responses",async()=>{
    let ctx=createContext({modelRegistry:registry({stopReason:"stop",content:[{type:"text",text:" a "},{type:"tool"},{type:"text",text:"b"}]})});
    expect(await yeet.completeWithLuna(ctx,"s","p",10)).toBe("a \nb");
    for(const r of [registry({},undefined),registry({},model,false),registry({stopReason:"error",errorMessage:"bad"}),registry({stopReason:"length",content:[]}),registry({stopReason:"stop",content:[]})]) {
      ctx=createContext({modelRegistry:r}); await expect(yeet.completeWithLuna(ctx,"s","p",1)).rejects.toThrow();
    }
  });
  it("normalizes branch names and rejects invalid output",()=>{
    expect(yeet.normalizeFeatureBranch("\n`Feature/Hello, WORLD!!!`\nother")).toBe("feature/hello-world");
    expect(yeet.normalizeFeatureBranch(`feature/${"a".repeat(80)}---`)).toBe(`feature/${"a".repeat(56)}`);
    expect(()=>yeet.normalizeFeatureBranch("!!!")).toThrow("invalid branch");
    expect(()=>yeet.normalizeFeatureBranch("  \n ")).toThrow("invalid branch");
  });
  it("reads normal, failed, and truncated diffs",async()=>{
    expect(await yeet.readDiff(createPi({exec:vi.fn().mockResolvedValue(result("abc"))}),"/r")).toBe("abc");
    expect(await yeet.readDiff(createPi({exec:vi.fn().mockResolvedValue(result("",1))}),"/r")).toContain("unavailable");
    expect(await yeet.readDiff(createPi({exec:vi.fn().mockResolvedValue(result("x".repeat(80001)))}),"/r")).toContain("[diff truncated]");
  });
  it("finds an available feature branch and handles failures/exhaustion",async()=>{
    let calls=0;let pi=createPi({exec:vi.fn(async(c:string,a:string[])=>{if(a[0]==="show-ref")return result("",calls++===0?0:1);return result("")})});
    expect(await yeet.findAvailableFeatureBranch(pi,"/r","origin","feature/x")).toBe("feature/x-2");
    pi=createPi({exec:vi.fn(async(_c:string,a:string[])=>a[0]==="show-ref"?result("",1):result("",2,"network"))});
    await expect(yeet.findAvailableFeatureBranch(pi,"/r","origin","feature/x")).rejects.toThrow("failed to check");
    pi=createPi({exec:vi.fn(async(_c:string,a:string[])=>a[0]==="show-ref"?result():result())});
    await expect(yeet.findAvailableFeatureBranch(pi,"/r","origin","feature/x")).rejects.toThrow("could not find");
  });
  it("resolves PR base from symbolic ref or gh",async()=>{
    let pi=createPi({exec:dispatcher({"git symbolic-ref --quiet --short refs/remotes/origin/HEAD":result("origin/main\n")})});
    expect(await yeet.resolvePrBaseRef(pi,"/r","origin")).toBe("origin/main");
    pi=createPi({exec:dispatcher({"git symbolic-ref --quiet --short refs/remotes/origin/HEAD":result("",1),"gh repo view --json defaultBranchRef --jq .defaultBranchRef.name":result("trunk\n")})});
    expect(await yeet.resolvePrBaseRef(pi,"/r","origin")).toBe("origin/trunk");
    pi=createPi({exec:vi.fn().mockResolvedValue(result("",1))}); expect(await yeet.resolvePrBaseRef(pi,"/r","origin")).toBeUndefined();
  });
});

describe("land cleanup and action execution", () => {
  const baseRoutes = {
    "git show-ref --verify --quiet refs/heads/feat": result(),
    "git status --porcelain": result(""), "git branch --show-current": result("feat\n"),
    "git config --get branch.main.remote": result("origin\n"), "git fetch --prune origin": result(),
    "git show-ref --verify --quiet refs/heads/main": result(), "git checkout main": result(),
    "git pull --ff-only origin main": result(), "git branch -D feat": result(),
  };
  it("cleans an existing local feature branch", async () => {
    const ctx=createContext(); expect(await land.cleanupLocalBranch(createPi({exec:dispatcher(baseRoutes)}),ctx,"/r",pr())).toBe(true);
    expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("failed"),expect.anything());
  });
  it("handles local cleanup preconditions", async()=>{
    let ctx=createContext(); expect(await land.cleanupLocalBranch(createPi(),ctx,"/r",pr({headRefName:"main"}))).toBe(false);
    ctx=createContext(); expect(await land.cleanupLocalBranch(createPi({exec:dispatcher({"git show-ref --verify --quiet refs/heads/feat":result("",1)})}),ctx,"/r",pr())).toBe(true);
    for(const routes of [
      {...baseRoutes,"git status --porcelain":result(" M x")},
      {...baseRoutes,"git status --porcelain":result("",1)},
      {...baseRoutes,"git branch --show-current":result("",1,"bad")},
      {...baseRoutes,"git config --get branch.main.remote":result("",1),"git remote -v":result("")},
      {...baseRoutes,"git fetch --prune origin":result("",1,"fetch bad")},
      {...baseRoutes,"git checkout main":result("",1,"checkout bad")},
      {...baseRoutes,"git pull --ff-only origin main":result("",1,"pull bad")},
      {...baseRoutes,"git branch -D feat":result("",1,"delete bad")},
    ]) { ctx=createContext(); expect(await land.cleanupLocalBranch(createPi({exec:dispatcher(routes)}),ctx,"/r",pr())).toBe(routes["git pull --ff-only origin main"]?.code===1); }
  });
  it("creates a missing base branch and skips checkout when already on it",async()=>{
    let routes={...baseRoutes,"git show-ref --verify --quiet refs/heads/main":result("",1),"git checkout -b main --track origin/main":result()}; delete (routes as any)["git checkout main"];
    expect(await land.cleanupLocalBranch(createPi({exec:dispatcher(routes)}),createContext(),"/r",pr())).toBe(true);
    routes={...baseRoutes,"git branch --show-current":result("main\n")} as any;
    expect(await land.cleanupLocalBranch(createPi({exec:dispatcher(routes)}),createContext(),"/r",pr())).toBe(true);
  });

  const action = async (p:any, selections:any[], confirmations:any[], routes:any={}, dry=false) => {
    const ui=createUi({select:vi.fn().mockImplementation(async()=>selections.shift()),confirm:vi.fn().mockImplementation(async()=>confirmations.shift())});
    const ctx=createContext({ui}); const ok=await land.landPullRequest(createPi({exec:dispatcher(routes)}),ctx,"/r",p,dry); return {ok,ctx};
  };
  it("handles cancellation and draft/method decisions",async()=>{
    expect((await action(pr(),["Cancel"],[])).ok).toBe(false);
    expect((await action(pr({isDraft:true}),["Merge PR now"],[false])).ok).toBe(false);
    expect((await action(pr(),["Merge PR now",undefined],[])).ok).toBe(false);
    expect((await action(pr(),["Merge PR now","Rebase"],[false,false,false])).ok).toBe(false);
    expect((await action(pr(),["Merge PR now","Merge commit"],[false,false,false])).ok).toBe(false);
  });
  it("handles draft readiness and PR action failures",async()=>{
    let got=await action(pr({isDraft:true}),["Merge PR now","Squash"],[true,false,false,true],{"gh pr ready url":result("",1,"no")}); expect(got.ok).toBe(true);
    got=await action(pr({isDraft:true}),["Merge PR now","Squash"],[true,false,false,true],{"gh pr ready url":result(),"gh pr merge url --squash":result("",1,"no")}); expect(got.ok).toBe(true);
    got=await action(pr(),["Merge PR now","Squash"],[false,false,true],{"gh pr merge url --squash":result(),[`gh pr view url --json ${fields}`]:result(JSON.stringify(pr()))});
    expect(got.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("remains open"),"info");
  });
  it("deletes remote branches and reports deletion outcomes",async()=>{
    const closed=pr({state:"CLOSED"});
    for(const push of [result(),result("",1,"remote ref does not exist"),result("",1,"permission")]) {
      const routes={"git config --get branch.feat.remote":result("origin"),"git push origin --delete feat":push};
      expect((await action(closed,["Clean up branches for closed PR"],[true,false,true],routes)).ok).toBe(true);
    }
    expect((await action(closed,["Clean up branches for closed PR"],[true,false,true],{"git config --get branch.feat.remote":result("",1),"git remote -v":result("")})).ok).toBe(true);
  });
});

describe("yeet generators",()=>{
  const response=(text:string)=>({stopReason:"stop",content:[{type:"text",text}]});
  const ctxFor=(...texts:string[])=>createContext({modelRegistry:{find:vi.fn(()=>({id:"m"})),hasConfiguredAuth:vi.fn(()=>true),complete:vi.fn().mockImplementation(async()=>response(texts.shift()!))}});
  it("generates feature branches and commit messages",async()=>{
    const pi=createPi({exec:vi.fn().mockResolvedValue(result("diff"))});
    expect(await yeet.generateFeatureBranch(pi,ctxFor("feature/nice-name"),"/r"," M x","feat: x")).toBe("feature/nice-name");
    expect(await yeet.generateCommitMessage(pi,ctxFor("`fix: thing`\nextra"),"/r"," M x")).toBe("fix: thing");
  });
  it("generates PR bodies from diffs and fallback commit shows",async()=>{
    let exec=dispatcher({"git symbolic-ref --quiet --short refs/remotes/origin/HEAD":result("origin/main"),"git diff --no-ext-diff --no-color origin/main...HEAD":result("diff")});
    expect(await yeet.generatePrBody(createPi({exec}),ctxFor("body"),"/r","origin","title"," # template ")).toBe("body");
    exec=dispatcher({"git symbolic-ref --quiet --short refs/remotes/origin/HEAD":result("",1),"gh repo view --json defaultBranchRef --jq .defaultBranchRef.name":result("",1),"git show --no-ext-diff --no-color --format=fuller --stat --patch HEAD":result("x".repeat(80001))});
    expect(await yeet.generatePrBody(createPi({exec}),ctxFor("fallback"),"/r","origin","title")).toBe("fallback");
    exec=vi.fn().mockResolvedValue(result("",1)); expect(await yeet.generatePrBody(createPi({exec}),ctxFor("none"),"/r","origin","title")).toBe("none");
  });
});

describe("final land branch cases",()=>{
 it("handles absent check arrays and values",()=>{
  expect(land.hasPendingChecks(pr({statusCheckRollup:undefined}))).toBe(false);
  expect(land.hasPendingChecks(pr({statusCheckRollup:[{}]}))).toBe(false);
  expect(land.checkSummary(pr({statusCheckRollup:undefined}))).toBe("checks unavailable");
  expect(land.checkSummary(pr({statusCheckRollup:[{}]}))).toBe("0 passing, 0 failing, 0 pending");
 });
 it("handles malformed lists, current empty lists, and current RPC selection",async()=>{
  const view=`gh pr view --json ${fields}`, list=`gh pr list --state open --limit 50 --json ${fields}`;
  let pi=createPi({exec:dispatcher({[view]:result(JSON.stringify(pr())),[list]:result("bad")})}); expect(await land.selectOpenPullRequests(pi,createContext(),"/r")).toHaveLength(1);
  pi=createPi({exec:dispatcher({[view]:result(JSON.stringify(pr())),[list]:result(JSON.stringify([pr(),pr({number:2})]))})}); expect(await land.selectOpenPullRequests(pi,createContext(),"/r")).toHaveLength(1);
 });
 it("covers TUI without a current PR, short rendering, empty enter, and sorting",async()=>{
  const ps=[pr({number:2}),pr({number:1})],view=`gh pr view --json ${fields}`,list=`gh pr list --state open --limit 50 --json ${fields}`;
  const exec=dispatcher({[view]:result("",1),[list]:result(JSON.stringify(ps))});
  const custom=vi.fn(async(factory:any)=>{let val:any;const c=factory({requestRender:vi.fn()},{fg:(_x:string,s:string)=>s,bold:(s:string)=>s},{},(v:any)=>val=v);c.render(100);c.handleInput("x");c.handleInput("\r");c.handleInput(" ");c.handleInput("\x1b[B");c.handleInput(" ");c.handleInput("\r");return val});
  expect(await land.selectOpenPullRequests(createPi({exec}),createContext({mode:"tui",ui:createUi({custom})}),"/r")).toHaveLength(2);
 });
 it("covers auto merge, absent refresh, draft close, and successful local cleanup",async()=>{
  const ui=createUi({select:vi.fn().mockResolvedValueOnce("Enable auto-merge after checks pass").mockResolvedValueOnce("Squash"),confirm:vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValueOnce(true)});
  let routes:any={"gh pr merge url --squash --auto":result(),[`gh pr view url --json ${fields}`]:result("bad")};
  await land.landPullRequest(createPi({exec:dispatcher(routes)}),createContext({ui}),"/r",pr({statusCheckRollup:[{status:"PENDING"}]}),false);
  ui.select.mockReset().mockResolvedValue("Close PR without merging");ui.confirm.mockReset().mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  routes={"gh pr close url":result(),[`gh pr view url --json ${fields}`]:result(JSON.stringify(pr({state:"CLOSED"})))};
  await land.landPullRequest(createPi({exec:dispatcher(routes)}),createContext({ui}),"/r",pr({isDraft:true}),false);
  ui.select.mockReset().mockResolvedValue("Clean up branches for closed PR");ui.confirm.mockReset().mockResolvedValueOnce(false).mockResolvedValueOnce(true).mockResolvedValueOnce(true);
  routes={"git show-ref --verify --quiet refs/heads/feat":result("",1)};
  const ctx=createContext({ui});await land.landPullRequest(createPi({exec:dispatcher(routes)}),ctx,"/r",pr({state:"CLOSED"}),false);
  expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("deleted local feat"),"info");
 });
 it("breaks a multi-PR workflow when an action is canceled",async()=>{
  const list=`gh pr list --state open --limit 50 --json ${fields}`,view=`gh pr view --json ${fields}`;const ps=[pr(),pr({number:2})];
  const exec=dispatcher({"git rev-parse --show-toplevel":result("/r"),"gh --version":result("gh"),[view]:result("",1),[list]:result(JSON.stringify(ps))});
  const ui=createUi({select:vi.fn().mockResolvedValueOnce("#1 Test (feat → main)").mockResolvedValueOnce("Cancel")});
  await runLandWorkflow("",createPi({exec}),createContext({ui}));expect(ui.select).toHaveBeenCalledTimes(2);
 });
});
