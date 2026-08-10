import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, describe, expect, it, vi } from "vitest";
import { __testing, runYeetWorkflow } from "../../extensions/shared/commands/yeet";
import { registerLandWorkflow } from "../../extensions/shared/integrations/land";
import { createContext, createPi, createUi, result } from "../helpers";

const root=mkdtempSync(join(tmpdir(),"yeet-cov-")); afterAll(()=>rmSync(root,{recursive:true,force:true}));
const k=(c:string,a:string[])=>`${c} ${a.join(" ")}`;
const base:any={
 "git rev-parse --show-toplevel":result(root),"git status --short":result(" M x"),
 "git remote -v":result("origin url (fetch)\norigin url (push)"),
 "git diff --no-ext-diff --no-color HEAD":result("diff"),
 "git show-ref --verify --quiet refs/heads/feature/x":result("",1),
 "git ls-remote --heads origin refs/heads/feature/x":result(""),
 "git check-ref-format --branch feature/x":result(),"git checkout -b feature/x":result(),
 "git add -A":result(),"git commit -m msg":result(),"git rev-parse --abbrev-ref HEAD":result("feature/x"),
 "git push -u origin feature/x":result(),"gh --version":result("gh"),
 "git symbolic-ref --quiet --short refs/remotes/origin/HEAD":result("origin/main"),
 "git diff --no-ext-diff --no-color origin/main...HEAD":result("diff"),
 "gh pr create --title msg --body body":result("url"),
};
function setup(opts:any={}){
 const routes={...base,...opts.routes};
 const exec=vi.fn(async(c:string,a:string[])=>routes[k(c,a)]??result("",1,`missing ${k(c,a)}`));
 const selectValues=[...(opts.select??["Commit + push + create PR","Ready for review"])];
 const inputValues=[...(opts.input??[])]; const confirmValues=[...(opts.confirm??[])];
 const ui=createUi({select:vi.fn(async()=>selectValues.shift()),input:vi.fn(async()=>inputValues.shift()),confirm:vi.fn(async()=>confirmValues.shift())});
 const completions=[...(opts.completions??["feature/x","body"])];
 const complete=vi.fn(async()=>{const x=completions.shift();if(x instanceof Error||typeof x==="object"&&x?.reject)throw x instanceof Error?x:x.reject;return {stopReason:"stop",content:[{type:"text",text:x}]}});
 const ctx=createContext({ui,modelRegistry:{find:vi.fn(()=>({id:"m"})),hasConfiguredAuth:vi.fn(()=>true),complete}});
 const pi=createPi({exec}); return {pi,ctx,exec,ui};
}
async function run(opts:any={}){const x=setup(opts);await runYeetWorkflow(opts.args??"msg",x.pi,x.ctx);return x;}

describe("remaining yeet decisions",()=>{
 it("generates a commit message successfully",async()=>{const x=setup({select:["Commit only"],completions:["feat: generated"],routes:{"git commit -m feat: generated":result()}});await runYeetWorkflow("",x.pi,x.ctx);expect(x.ui.notify).toHaveBeenCalledWith(expect.stringContaining("generated commit"),"info")});
 it("handles canceled and blank manual commit messages",async()=>{
  for(const input of [undefined," "]){const x=setup({select:["Commit only"],completions:[new Error("model")],input:[input]});await runYeetWorkflow("",x.pi,x.ctx);expect(x.ui.notify).toHaveBeenCalled();}
 });
 it("handles missing and multiple remotes",async()=>{
  let x=await run({select:["Commit + push"],routes:{"git remote -v":result("")}});expect(x.ui.notify).toHaveBeenCalledWith("/yeet: no remotes found","error");
  const remotes=result("a a-url (fetch)\na a-url (push)\nb b-url (fetch)\nb b-url (push)");
  x=await run({select:["Commit + push",undefined],routes:{"git remote -v":remotes}});expect(x.ui.notify).toHaveBeenCalledWith("/yeet canceled","warning");
 });
 it("handles no changes without a usable previous commit",async()=>{
  let x=await run({args:"",select:["Commit + push"],routes:{"git status --short":result(""),"git log -1 --pretty=%B":result("",1)}});expect(x.ui.notify).toHaveBeenCalledWith(expect.stringContaining("no previous"),"warning");
  x=await run({args:"msg",select:["Commit + push"],routes:{"git status --short":result(""),"git rev-parse --abbrev-ref HEAD":result("main"),"git push -u origin main":result()}});expect(x.ui.notify).toHaveBeenCalledWith(expect.stringContaining("using latest"),"info");
 });
 it("handles manual feature branches and availability errors",async()=>{
  let x=await run({completions:[new Error("model")],input:[undefined]});expect(x.ui.notify).toHaveBeenCalledWith("/yeet canceled","warning");
  x=await run({completions:[{reject:"string failure"}],input:["feature/x"],routes:{"git ls-remote --heads origin refs/heads/feature/x":result("",1,"network")}});expect(x.ui.notify).toHaveBeenCalledWith(expect.stringContaining("unable to choose"),"error");
 });
 it("uses a suffixed branch after collisions",async()=>{
  const x=await run({routes:{"git show-ref --verify --quiet refs/heads/feature/x":result(),"git show-ref --verify --quiet refs/heads/feature/x-2":result("",1),"git ls-remote --heads origin refs/heads/feature/x-2":result(""),"git check-ref-format --branch feature/x-2":result(),"git checkout -b feature/x-2":result(),"git rev-parse --abbrev-ref HEAD":result("feature/x-2"),"git push -u origin feature/x-2":result()}});
  expect(x.ui.notify).toHaveBeenCalledWith(expect.stringContaining("using feature/x-2"),"info");
 });
 it.each([
  ["invalid branch",{"git check-ref-format --branch feature/x":result("",1)}],
  ["create branch",{"git checkout -b feature/x":result("",1,"bad")}],
  ["git add",{"git add -A":result("",1,"bad")}],
  ["git commit",{"git commit -m msg":result("",1,"bad")}],
  ["current branch",{"git rev-parse --abbrev-ref HEAD":result("",1)}],
  ["current branch blank",{"git rev-parse --abbrev-ref HEAD":result(" ")}],
  ["git push",{"git push -u origin feature/x":result("",1,"bad")}],
  ["GitHub CLI",{"gh --version":result("",1)}],
 ])("reports %s failure",async(_name,routes)=>{const x=await run({routes});expect(x.ui.notify).toHaveBeenCalledWith(expect.any(String),"error")});
 it("handles PR type cancellation and description fallback",async()=>{
  let x=await run({select:["Commit + push + create PR",undefined]});expect(x.ui.setStatus).toHaveBeenLastCalledWith("yeet",undefined);
  x=await run({completions:["feature/x",new Error("description")],routes:{"gh pr create --title msg --body ## Summary\n\nmsg":result("url")}});expect(x.ui.notify).toHaveBeenCalledWith(expect.stringContaining("description generation failed"),"warning");
  x=await run({completions:["feature/x",{reject:"description"}],routes:{"gh pr create --title msg --body ## Summary\n\nmsg":result("url")}});expect(x.ui.notify).toHaveBeenCalled();
 });
 it("creates drafts, reports create failures, and handles an empty URL",async()=>{
  let x=await run({select:["Commit + push + create PR","Draft PR"],routes:{"gh pr create --title msg --body body --draft":result("url")}});expect(x.exec).toHaveBeenCalledWith("gh",expect.arrayContaining(["--draft"]),expect.anything());
  x=await run({routes:{"gh pr create --title msg --body body":result("",1,"bad")}});expect(x.ui.notify).toHaveBeenCalledWith(expect.stringContaining("failed to create PR"),"error");
  x=await run({routes:{"gh pr create --title msg --body body":result("")}});expect(x.ui.notify).toHaveBeenCalledWith(expect.stringContaining("no URL returned"),"info");
 });
 it("invokes optional land integration",async()=>{
  const x=setup({select:["Commit + push + create PR + land","Ready for review"]});const landing=vi.fn();registerLandWorkflow(x.pi,landing);await runYeetWorkflow("msg",x.pi,x.ctx);expect(landing).toHaveBeenCalledWith("url",x.ctx);
 });
 it("handles one and multiple templates including unreadable choices",async()=>{
  mkdirSync(join(root,".github"),{recursive:true});const one=join(root,".github","PULL_REQUEST_TEMPLATE.md");writeFileSync(one,"template");
  let x=await run({confirm:[false]});expect(x.ui.confirm).toHaveBeenCalled();
  x=await run({confirm:[true],routes:{"gh pr create --title msg --body body":result("url")}});expect(x.ui.confirm).toHaveBeenCalled();
  mkdirSync(join(root,".github","PULL_REQUEST_TEMPLATE"),{recursive:true});writeFileSync(join(root,".github","PULL_REQUEST_TEMPLATE","two.md"),"two");
  x=await run({confirm:[true],select:["Commit + push + create PR","missing.md","Ready for review"]});expect(x.ui.notify).toHaveBeenCalledWith("/yeet: failed to read PR template","warning");
  x=setup({confirm:[true]});
  x.ui.select.mockImplementation(async (title:string) => title === "Select yeet workflow" ? "Commit + push + create PR" : title === "Select PR template to include" ? undefined : "Ready for review");
  await runYeetWorkflow("msg",x.pi,x.ctx);
  expect(x.ui.select).toHaveBeenCalledWith("Select PR template to include",expect.any(Array));
  expect(x.ui.notify).toHaveBeenCalledWith(expect.stringContaining("PR created"),"info");
 });
});

describe("last yeet branches",()=>{
 it("uses a successfully selected remote among several",async()=>{
  const remotes=result("a a-url (fetch)\na a-url (push)\nb b-url (fetch)\nb b-url (push)");
  const x=await run({select:["Commit + push","b (b-url)"],routes:{"git remote -v":remotes,"git rev-parse --abbrev-ref HEAD":result("main"),"git push -u b main":result()}});expect(x.ui.notify).toHaveBeenCalledWith("/yeet: pushed main to b","info");
 });
 it("handles a non-Error commit generation rejection",async()=>{
  const x=setup({select:["Commit only"],completions:[{reject:"plain"}],input:[undefined]});await runYeetWorkflow("",x.pi,x.ctx);expect(x.ui.notify).toHaveBeenCalledWith(expect.stringContaining("plain"),"warning");
 });
 it("continues after a remote branch collision",async()=>{
  const pi=createPi({exec:vi.fn(async(_c:string,a:string[])=>a[0]==="show-ref"?result("",1):a.at(-1)?.endsWith("feature/x")?result("hash"):result(""))});
  expect(await __testing.findAvailableFeatureBranch(pi,"/r","origin","feature/x")).toBe("feature/x-2");
 });
});
