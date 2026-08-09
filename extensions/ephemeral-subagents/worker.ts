/** Inline, dependency-free authenticated bridge between the manager and Pi RPC. */
export const WORKER_SOURCE = String.raw`
const {spawn}=require('node:child_process'),{createHmac,timingSafeEqual}=require('node:crypto');
const token=process.env.PI_SUBAGENT_CONTROL_TOKEN,jobId=process.env.PI_SUBAGENT_JOB_ID;if(!token||!jobId)process.exit(125);
const [command,...args]=process.argv.slice(1),env={...process.env};delete env.PI_SUBAGENT_CONTROL_TOKEN;delete env.PI_SUBAGENT_JOB_ID;
const child=spawn(command,args,{stdio:['pipe','pipe','pipe'],env});let inSeq=0,outSeq=0,ib='',ob='';
function auth(x){return createHmac('sha256',token).update(JSON.stringify(x)).digest('hex')}
function send(type,payload){const u={version:1,jobId,seq:++outSeq,type,payload},line=JSON.stringify({...u,auth:auth(u)});if(Buffer.byteLength(line)<=65536)process.stdout.write(line+'\n')}
function input(line){if(Buffer.byteLength(line)>65536)return send('protocol_error','oversize');let x;try{x=JSON.parse(line)}catch{return send('protocol_error','malformed')};const {auth:a,...u}=x,e=Buffer.from(auth(u)),g=Buffer.from(String(a));if(x.version!==1||x.jobId!==jobId||!Number.isSafeInteger(x.seq)||x.seq<=inSeq||e.length!==g.length||!timingSafeEqual(e,g))return send('protocol_error','invalid');inSeq=x.seq;child.stdin.write(JSON.stringify(x.payload)+'\n')}
process.stdin.on('data',d=>{ib+=d;for(;;){const n=ib.indexOf('\n');if(n<0)break;input(ib.slice(0,n));ib=ib.slice(n+1)}});
child.stdout.on('data',d=>{ob+=d;for(;;){const n=ob.indexOf('\n');if(n<0)break;const line=ob.slice(0,n);ob=ob.slice(n+1);let e;try{e=JSON.parse(line)}catch{e={type:'protocol_error',raw:line.slice(0,1024)}}send('rpc_event',e)}});
child.stderr.pipe(process.stderr);child.on('error',e=>send('worker_error',e.message));child.on('close',(code,signal)=>{send('worker_exit',{code,signal});process.exit(code??1)});
process.on('SIGTERM',()=>child.kill('SIGTERM'));process.on('SIGINT',()=>child.kill('SIGINT'));
`;
