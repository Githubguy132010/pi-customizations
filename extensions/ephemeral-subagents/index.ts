import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { resolveRepoRoot } from "../shared/utils/git.ts";
import { JobManager } from "./manager.ts";

const Action = StringEnum(["launch","status","collect","wait","message","answer","pause","resume","cancel"] as const);
const Params = Type.Object({
  action: Action,
  task: Type.Optional(Type.String()), tasks: Type.Optional(Type.Array(Type.String(), { maxItems: 16 })), model: Type.Optional(Type.String()),
  background: Type.Optional(Type.Boolean({ default: false })), jobId: Type.Optional(Type.String()), groupId: Type.Optional(Type.String()),
  message: Type.Optional(Type.String()), requestId: Type.Optional(Type.String()), answer: Type.Optional(Type.Union([Type.String(),Type.Boolean()])), followUp: Type.Optional(Type.Boolean()),
  concurrency: Type.Optional(Type.Integer({minimum:1,maximum:16})), diskMb: Type.Optional(Type.Integer({minimum:16})), runtimeMs: Type.Optional(Type.Integer({minimum:1000})), outputBytes: Type.Optional(Type.Integer({minimum:1024})),
});

export default function(pi:ExtensionAPI){
  let manager:JobManager|undefined;
  async function getManager(params:any,ctx:ExtensionContext){
    if(manager)return manager; const repoRoot=await resolveRepoRoot(pi,ctx); if(!repoRoot)throw new Error(`Not inside a Git repository: ${ctx.cwd}`);
    const auth=ctx.model?await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model):undefined; manager=new JobManager({repoRoot,cwd:ctx.cwd,defaultModel:ctx.model?.id,defaultProvider:ctx.model?.provider,apiKey:auth?.ok?auth.apiKey:undefined,limits:{concurrency:params.concurrency,diskMb:params.diskMb,runtimeMs:params.runtimeMs,outputBytes:params.outputBytes}}); return manager;
  }
  pi.registerTool({name:"subagent_jobs",label:"Ephemeral subagents",description:"Launch repository investigation agents in independent disposable Git worktrees. Jobs are unsandboxed host processes. Supports foreground/background groups plus status, collect, wait, messaging, answering, pause/resume, and cancellation.",parameters:Params,
    async execute(_id,p,_signal,onUpdate,ctx){
      const m=await getManager(p,ctx);
      if(p.action==="launch"){
        const tasks=p.tasks?.length?p.tasks:p.task?[p.task]:[];if(!tasks.length)throw new Error("launch requires task or tasks");const h=m.launch(tasks.map(task=>({task,model:p.model})));
        if(p.background)return {content:[{type:"text",text:`Started group ${h.groupId}: ${h.jobIds.join(", ")}`}],details:h};
        const pending=m.waitGroup(h.groupId);const ticker=setInterval(()=>onUpdate?.({content:[{type:"text",text:h.jobIds.map(id=>`${id}: ${m.status(id).state}`).join("\n")}],details:h}),250);try{const results=await pending;return {content:[{type:"text",text:results.map(r=>`### ${r.jobId} (${r.state}, ${r.sandbox})\n${r.output||r.stderr||r.terminalReason}`).join("\n\n")}],details:{...h,results}};}finally{clearInterval(ticker);}
      }
      if(p.action==="status"){if(!p.jobId)throw new Error("status requires jobId");const s=m.status(p.jobId);return {content:[{type:"text",text:JSON.stringify(s,null,2)}],details:s};}
      if(p.action==="collect"){if(!p.jobId)throw new Error("collect requires jobId");const r=m.collect(p.jobId);return {content:[{type:"text",text:r?r.output||r.stderr||r.terminalReason:"Job has not completed"}],details:r};}
      if(p.action==="wait"){const results=p.groupId?await m.waitGroup(p.groupId):p.jobId?[await m.wait(p.jobId)]:(()=>{throw new Error("wait requires jobId or groupId")})();return {content:[{type:"text",text:results.map(r=>r.output||r.stderr||r.terminalReason).join("\n\n---\n\n")}],details:{results}};}
      if(!p.jobId)throw new Error(`${p.action} requires jobId`);
      if(p.action==="message"){if(!p.message)throw new Error("message requires message");m.message(p.jobId,p.message,p.followUp);}
      else if(p.action==="answer"){if(!p.requestId||p.answer===undefined)throw new Error("answer requires requestId and answer");m.answer(p.jobId,p.requestId,p.answer);}
      else if(p.action==="pause")m.pause(p.jobId);else if(p.action==="resume")m.resume(p.jobId);else if(p.action==="cancel")m.cancel(p.jobId);
      const s=m.status(p.jobId);return {content:[{type:"text",text:`${p.jobId}: ${s.state}`}],details:s};
    }});
  pi.on("session_shutdown",async()=>{await manager?.shutdown();manager=undefined;});
}
