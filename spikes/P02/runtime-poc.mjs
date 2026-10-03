import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as c } from "node:fs";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const main = "E:/Xiadie/Xiadie";
const out = path.join(main, ".runtime/P02/experiments/u02/runtime");
const node = "E:/Xiadie/Xiadie/.runtime/P01/desktop-build-evidence/toolchain/node-v24.14.0-win-x64/node.exe";
const source = "E:/Xiadie/Xiadie/.runtime/P01/desktop-source";
const commit = "29628c9acdb81b703bbd4080c207a0e7ce5e276e";
const tsxLoader = pathToFileURL(path.join(source, "node_modules/tsx/dist/loader.mjs")).href;
const tsxArgs = ["--import", tsxLoader];
const childScript = path.join(here, "hook-child.mjs");
const inputFile = path.join(source, "apps/zcode-cli/packages/core/dist/hooks/configured-runner-input.js");
const callbackFile = path.join(source, "apps/zcode-cli/packages/core/dist/hooks/configured-runner-callback.js");
const storeFile = path.join(source, "apps/zcode-cli/packages/contracts/dist/events/in-memory-session-event-store.js");
const eventsFile = path.join(source, "apps/zcode-cli/packages/contracts/dist/events/session.events.js");
const retentionFile = path.join(source, "apps/zcode-cli/packages/contracts/dist/events/session-event-retention.js");
const maxBytes = 512 * 1024;
const outputCap = 32 * 1024;
const now = "2026-10-03T00:00:00.000Z";
const hash = (b) => createHash("sha256").update(b).digest("hex");
async function hashFile(p) { return new Promise((resolve,reject)=>{const h=createHash("sha256"),s=createReadStream(p);s.on("data",x=>h.update(x));s.on("error",reject);s.on("end",()=>resolve(h.digest("hex")));}); }
async function exists(p) { try { await fs.access(p); return true; } catch(e) { if(e.code==="ENOENT") return false; throw e; } }
function makeInput(prompt, hookEventName="UserPromptSubmit") {
  return { agentName:"synthetic-agent", cwd:root, hookEventName, mode:"plan", prompt, sessionId:"synthetic-session-u02", timestamp:now, traceId:"synthetic-trace-u02", turnId:"synthetic-turn-u02",
    syntheticPriorHistory:[{role:"user",text:"SYNTHETIC_OLD_USER_MUST_NOT_APPEAR"},{role:"assistant",text:"SYNTHETIC_OLD_ASSISTANT_MUST_NOT_APPEAR"}] };
}
function evt(id,sid,tid,type,sequenceNumber=0,payload={}) { return {id,sessionId:sid,turnId:tid,type,timestamp:new Date(now),traceId:"synthetic-trace-u02",sequenceNumber,payload}; }
async function boundedCandidate(file, savePath) {
  let fd;
  try {
    const ls=await fs.lstat(file); if(ls.isSymbolicLink()||!ls.isFile()) return {status:"unreadable",saved:false,reason:"not_regular"};
    fd=await fs.open(file,c.O_RDONLY); const a=await fd.stat();
    if(a.size>maxBytes) return {status:"oversize",saved:false,observed:a.size,maxBytes};
    const chunks=[]; let n=0;
    while(n<=maxBytes){const b=Buffer.alloc(Math.min(65536,maxBytes+1-n));const r=await fd.read(b,0,b.length,null);if(!r.bytesRead)break;n+=r.bytesRead;if(n>maxBytes)return {status:"oversize",saved:false,observed:n,maxBytes};chunks.push(b.subarray(0,r.bytesRead));}
    const z=await fd.stat();if(a.size!==z.size||a.mtimeMs!==z.mtimeMs||n!==z.size)return {status:"unstable",saved:false,observed:n};
    const bytes=Buffer.concat(chunks,n), text=bytes.toString("utf8");if(!text.endsWith("\n"))return {status:"incomplete",saved:false,observed:n};
    let messages;try{messages=text.slice(0,-1).split("\n").map(line=>{const x=JSON.parse(line),m=x.message,body=(m.content||[]).filter(p=>p.type==="text").map(p=>p.text||"").join("");return {role:m.role,text:"[REDACTED]",textBytes:Buffer.byteLength(body),textSha256:hash(Buffer.from(body))};});}catch{return {status:"invalid",saved:false,observed:n};}
    const snap={version:1,messages}, sb=Buffer.from(JSON.stringify(snap));
    await fs.writeFile(savePath,JSON.stringify({rawRetained:false,source:{locator:path.resolve(file),bytes:n,sha256:hash(bytes)},redactedSnapshot:snap,redactedSnapshotSha256:hash(sb)},null,2)+"\n",{flag:"wx"});
    return {status:"saved",saved:true,sourceBytes:n,sourceSha256:hash(bytes),redactedSha256:hash(sb)};
  }catch(e){return {status:"unreadable",saved:false,reason:e.code||"read_failed"};}
  finally{await fd?.close().catch(()=>{});}
}
const runRecords=[];
const active={name:"success"};
const nativeHome=path.join(out,"profile/home"), parentTmp=path.join(out,"profile/native-temp"), childTmp=path.join(out,"profile/hook-child-temp"), faultTmp=path.join(out,"profile/fault-child-temp");
const port={
  run(req,opts={}) {
    assert.equal(req.command.mode,"argv");assert.equal(path.resolve(req.command.file),path.resolve(node));assert.deepEqual(req.command.args.slice(0,2),tsxArgs);assert.equal(path.resolve(req.command.args[2]),path.resolve(childScript));assert.equal(path.resolve(req.cwd),path.resolve(root));
    const hookInput=JSON.parse(req.stdin), temp=childTmp;
    const command={file:req.command.file,args:req.command.args,cwd:req.cwd,shell:false,pid:null,temp,transcriptPath:hookInput.transcriptPath,trace:req.trace};
    const env={PATH:process.env.PATH||"",...(process.env.SystemRoot?{SystemRoot:process.env.SystemRoot}:{}),...(process.env.WINDIR?{WINDIR:process.env.WINDIR}:{}),
      HOME:nativeHome,USERPROFILE:nativeHome,TEMP:temp,TMP:temp,P02_U02_ZCODE_SOURCE:source,P02_U02_OUTPUT_DIR:out,
      P02_U02_SCENARIO:active.name,P02_U02_CAPTURE_NAME:"capture-"+active.name+".json",
      ZCODE_SESSION_ID:hookInput.sessionId,ZCODE_PROJECT_DIR:root};
    return new Promise(resolve=>{
      const ch=spawn(node,req.command.args,{cwd:root,env,shell:false,windowsHide:true,stdio:["pipe","pipe","pipe"]});
      command.pid=ch.pid||null;const so=[],se=[];let nb=0,ne=0,cut=false,timeout=false,abort=false,done=false;
      const add=(arr,total,buf)=>{const room=Math.max(0,outputCap-total);if(room)arr.push(buf.subarray(0,room));return total+buf.length;};
      const kill=setTimeout(()=>{timeout=true;ch.kill();},5000);
      const stop=()=>{abort=true;ch.kill();};if(opts.signal){if(opts.signal.aborted)stop();else opts.signal.addEventListener("abort",stop,{once:true});}
      ch.stdout.on("data",b=>{nb=add(so,nb,b);if(nb>outputCap){cut=true;ch.kill();}});
      ch.stderr.on("data",b=>{ne=add(se,ne,b);if(ne>outputCap){cut=true;ch.kill();}});
      ch.stdin.end(req.stdin);
      const finish=(status,code,error)=>{if(done)return;done=true;clearTimeout(kill);opts.signal?.removeEventListener("abort",stop);
        const stdout=Buffer.concat(so).toString("utf8"),stderr=Buffer.concat(se).toString("utf8");
        const record={command,status,exitCode:code,timedOut:timeout,aborted:abort,truncated:cut,stdoutBytes:nb,stderrBytes:ne,stdout,stderr,...(error?{error}: {})};runRecords.push(record);
        resolve({status,exitCode:code,stdout:{text:stdout,bytes:nb,truncated:cut},stderr:{text:stderr,bytes:ne,truncated:cut},...(error?{error:{message:error}}:{})});};
      ch.once("error",e=>finish("failed",null,String(e.message||e)));
      ch.once("close",(code,signal)=>finish(timeout||abort||cut||(code!==0&&code!==2)?"failed":"completed",code,timeout?"timeout":abort?"abort":cut?"output_limit":signal||undefined));
    });
  },
};
async function invoke(callback,name,input) {
  active.name=name;let result,failure;
  try{result=await callback(input,{hookIndex:0});}catch(e){failure=e;}
  const rec=runRecords.at(-1), pathExists=await exists(rec.command.transcriptPath);
  assert.equal(pathExists,false,"native callback cleanup before return/rejection");
  return {result,failure,exitCode:rec.exitCode,pathExists};
}
async function ownChild(args,env,timeout=10000){
  return new Promise((resolve,reject)=>{const ch=spawn(node,[...tsxArgs,...args],{cwd:root,env,shell:false,windowsHide:true,stdio:["ignore","pipe","pipe"]});let stdout="",stderr="",timedOut=false;const t=setTimeout(()=>{timedOut=true;ch.kill();},timeout);ch.stdout.setEncoding("utf8");ch.stderr.setEncoding("utf8");ch.stdout.on("data",x=>stdout+=x);ch.stderr.on("data",x=>stderr+=x);ch.once("error",reject);ch.once("close",(code,signal)=>{clearTimeout(t);resolve({exitCode:code,signal,timedOut,stdout,stderr,pid:ch.pid||null});});});
}

assert.equal(execFileSync("git",["-C",source,"rev-parse","HEAD"],{encoding:"utf8"}).trim(),commit);
assert.equal(path.resolve(process.execPath),path.resolve(node));
assert.equal(path.resolve(process.env.P02_U02_ZCODE_SOURCE||""),path.resolve(source));
assert.equal(path.resolve(process.env.P02_U02_OUTPUT_DIR||""),path.resolve(out));
assert.equal(path.resolve(os.tmpdir()),path.resolve(process.env.TEMP||process.env.TMP));
await fs.mkdir(out,{recursive:true});
await Promise.all([nativeHome,parentTmp,childTmp,faultTmp].map(p=>fs.mkdir(p,{recursive:true})));
assert.equal(path.resolve(os.tmpdir()),path.resolve(parentTmp));

const inputApi=await import(pathToFileURL(inputFile).href);
const {createConfiguredHookCallback}=await import(pathToFileURL(callbackFile).href);
const {InMemorySessionEventStore}=await import(pathToFileURL(storeFile).href);
const {SessionEventType}=await import(pathToFileURL(eventsFile).href);

const prompt="SYNTHETIC_CURRENT_MESSAGE_ONLY";
const direct=await inputApi.createCompatibleHookStdin(makeInput(prompt));
const directEnv=JSON.parse(direct.value), directPath=directEnv.transcriptPath, directBytes=await fs.readFile(directPath);
const directRows=directBytes.toString("utf8").trimEnd().split("\n").map(x=>JSON.parse(x));
assert.equal(directRows.length,1);assert.equal(directRows[0].message.role,"user");assert.equal(directRows[0].message.content[0].text,prompt);
assert.equal(directBytes.includes(Buffer.from("SYNTHETIC_OLD_USER_MUST_NOT_APPEAR")),false);
assert.equal(directBytes.includes(Buffer.from("SYNTHETIC_OLD_ASSISTANT_MUST_NOT_APPEAR")),false);
await direct.cleanup();assert.equal(await exists(directPath),false);
const other=await inputApi.createCompatibleHookStdin({...makeInput(prompt,"PostToolUse"),toolCallId:"synthetic-tool",toolName:"Synthetic",toolInput:{},toolResponse:{},toolResultPreview:""});
const otherEnv=JSON.parse(other.value),otherPath=otherEnv.transcriptPath,otherBytes=await fs.readFile(otherPath);
assert.equal(otherBytes.length,0);await other.cleanup();assert.equal(await exists(otherPath),false);

const callback=createConfiguredHookCallback({executionPort:port,getWorkingDirectory:()=>root},"UserPromptSubmit",{type:"process",command:node,args:[...tsxArgs,childScript]},0,0,{maxOutputBytes:outputCap,timeoutMs:5000});
const success=await invoke(callback,"success",makeInput(prompt));assert.equal(success.failure,undefined);assert.equal(success.result.additionalContext,"P02 synthetic Hook success");
const capPath=path.join(out,"capture-success.json"),cap=JSON.parse(await fs.readFile(capPath,"utf8"));
assert.equal(cap.rawRetained,false);assert.equal(cap.redactedSnapshot.messages.length,1);assert.equal(cap.redactedSnapshot.messages[0].text,"[REDACTED]");
assert.equal(cap.redactedSnapshotSha256,hash(Buffer.from(JSON.stringify(cap.redactedSnapshot))));
const capText=await fs.readFile(capPath,"utf8");assert.equal(capText.includes(prompt),false);assert.equal(capText.includes("SYNTHETIC_OLD_USER_MUST_NOT_APPEAR"),false);assert.equal(await exists(cap.source.locator),false);
const block=await invoke(callback,"block",makeInput(prompt));assert.equal(block.failure,undefined);assert.equal(block.result.kind,"hookCallbackResult");assert.equal(block.result.output.continue,false);
const failed=await invoke(callback,"fail",makeInput(prompt));assert.ok(failed.failure);assert.match(String(failed.failure.message),/Hook process failed/);

const candidates=path.join(out,"candidate-inputs");await fs.mkdir(candidates,{recursive:true});
const over=path.join(candidates,"oversize.bin"),half=path.join(candidates,"half.jsonl"),missing=path.join(candidates,"missing.jsonl");
await fs.writeFile(over,Buffer.alloc(maxBytes+1,120));await fs.writeFile(half,'{"message":{"role":"user","content":[');
const bounded={
  oversize:await boundedCandidate(over,path.join(out,"oversize-redacted.json")),
  halfWrite:await boundedCandidate(half,path.join(out,"half-redacted.json")),
  unreadable:await boundedCandidate(missing,path.join(out,"missing-redacted.json")),
};
assert.equal(bounded.oversize.status,"oversize");assert.equal(bounded.oversize.saved,false);
assert.equal(bounded.halfWrite.status,"incomplete");assert.equal(bounded.halfWrite.saved,false);
assert.equal(bounded.unreadable.status,"unreadable");assert.equal(bounded.unreadable.saved,false);

const dup=new InMemorySessionEventStore({retention:"unbounded"});
const d1=await dup.append(evt("same-source-id","session-dup","turn-dup",SessionEventType.ModelStreaming,0,{v:"a"}));
const d2=await dup.append(evt("same-source-id","session-dup","turn-dup",SessionEventType.ModelStreaming,0,{v:"b"}));
const dupRows=await dup.getEvents("session-dup");assert.deepEqual([d1.sequenceNumber,d2.sequenceNumber],[1,2]);assert.equal(dupRows.length,2);
const order=new InMemorySessionEventStore({retention:"unbounded"});
await order.append(evt("order-a","session-order","turn-order",SessionEventType.ModelStreaming,20));
await order.append(evt("order-b","session-order","turn-order",SessionEventType.ModelStreaming,5));
await order.append(evt("order-c","session-order","turn-order",SessionEventType.ModelStreaming,0));
const orderRows=await order.getEvents("session-order");assert.deepEqual(orderRows.map(x=>x.sequenceNumber),[20,5,21]);
const retention=new InMemorySessionEventStore({retention:"turn-window"});
await retention.append(evt("t1-start","session-ret","t1",SessionEventType.TurnStarted));
await retention.append(evt("t1-stream","session-ret","t1",SessionEventType.ModelStreaming));
await retention.append(evt("t1-complete","session-ret","t1",SessionEventType.TurnComplete,0,{resultType:"success"}));
const before=await retention.getEvents("session-ret");
await retention.append(evt("t2-start","session-ret","t2",SessionEventType.TurnStarted));
const after=await retention.getEvents("session-ret");
assert.ok(before.some(x=>x.id==="t1-stream"));assert.equal(after.some(x=>x.id==="t1-stream"),false);assert.equal(after.some(x=>x.id==="t1-complete"),true);
const fresh=new InMemorySessionEventStore({retention:"turn-window"});assert.equal((await fresh.getEvents("session-ret")).length,0);

const faultOut=path.join(out,"fault-write");await fs.mkdir(faultOut,{recursive:true});
const safeEnv={PATH:process.env.PATH||"",...(process.env.SystemRoot?{SystemRoot:process.env.SystemRoot}:{}),...(process.env.WINDIR?{WINDIR:process.env.WINDIR}:{}),
  HOME:nativeHome,USERPROFILE:nativeHome,TEMP:faultTmp,TMP:faultTmp,P02_U02_ZCODE_SOURCE:source,P02_U02_OUTPUT_DIR:faultOut};
const faultRun=await ownChild([childScript,"fault-write"],safeEnv);assert.equal(faultRun.exitCode,0);const fault=JSON.parse(faultRun.stdout.trim().split("\n").at(-1));assert.equal(fault.provesCleanupGap,true);

const sourceFiles=[inputFile,callbackFile,storeFile,eventsFile,retentionFile],sourceHashes=[];
for(const p of sourceFiles)sourceHashes.push({path:p,bytes:(await fs.stat(p)).size,sha256:await hashFile(p)});
const nodeHash=await hashFile(node),childHash=await hashFile(childScript);
const summary={
  status:"passed",createdAt:new Date().toISOString(),
  worktree:{path:root,head:execFileSync("git",["-C",root,"rev-parse","HEAD"],{encoding:"utf8"}).trim(),branch:"p02-u02"},
  runtime:{nodeExe:node,nodeVersion:process.version,nodeSha256:nodeHash,cwd:process.cwd()},
  zcode:{path:source,commit,distInputs:sourceHashes},
  syntheticOnly:true,networkUsed:false,modelOrServiceStarted:false,
  hook:{
    nativeFunctions:["createCompatibleHookStdin","createConfiguredHookCallback"],
    success:{exitCode:runRecords[0].exitCode,sourceBytes:cap.source.bytes,sourceSha256:cap.source.sha256,redactedSha256:cap.redactedSnapshotSha256,messageCount:cap.redactedSnapshot.messages.length,rawRetained:false,tempDeletedBeforeReturn:true,priorHistoryExcluded:true},
    exit2Block:{exitCode:runRecords[1].exitCode,continue:block.result.output.continue,tempDeletedBeforeReturn:true},
    nonzeroFailure:{exitCode:runRecords[2].exitCode,callbackRejected:Boolean(failed.failure),tempDeletedBeforeRejection:true},
    directTranscript:{messageCount:directRows.length,exactCurrentMessage:true,priorHistoryExcluded:true,otherHook:"PostToolUse",otherHookBytes:otherBytes.length,pathsDeleted:true}
  },
  boundedCaptureCandidate:{maxBytes,cases:bounded},
  writeFailureInjection:fault,
  nativeEventStore:{
    duplicateId:{records:dupRows.length,ids:dupRows.map(x=>x.id),seqs:dupRows.map(x=>x.sequenceNumber),deduplicated:false},
    outOfOrder:{appendSeqs:orderRows.map(x=>x.sequenceNumber),latestSequence:await order.getLatestSequenceNumber("session-order"),readResorts:false},
    retention:{beforeNextTurn:before.map(x=>x.id),afterNextTurn:after.map(x=>x.id),transientEvicted:true,terminalRetained:true,freshInstanceEvents:(await fresh.getEvents("session-ret")).length,persistenceClaim:false}
  },
  limitations:{timeoutCancel:"NOT_RUN; bounded executor kills only its own direct child pid",realModel:"NOT_RUN",unreadable:"missing synthetic file/ENOENT tested; ACL denial NOT_RUN",crashRecovery:"NOT_RUN; new in-memory store is not a crash test"},
  childRuns:runRecords.map(x=>({pid:x.command.pid,exitCode:x.exitCode,status:x.status,temp:x.command.temp,transcriptPath:x.command.transcriptPath,stdoutBytes:x.stdoutBytes,stderrBytes:x.stderrBytes,stdout:x.stdout,stderr:x.stderr}))
};
await fs.writeFile(path.join(out,"summary.json"),JSON.stringify(summary,null,2)+"\n");
await fs.writeFile(path.join(out,"child-runs.json"),JSON.stringify(runRecords,null,2)+"\n");
await fs.writeFile(path.join(out,"input-sha256.json"),JSON.stringify({
  runtimePoc:{path:path.join(here,"runtime-poc.mjs"),sha256:await hashFile(path.join(here,"runtime-poc.mjs"))},
  hookChild:{path:childScript,sha256:childHash},nodeExe:{path:node,sha256:nodeHash},zcode:{commit,distInputs:sourceHashes}
},null,2)+"\n");
console.log(JSON.stringify({status:summary.status,commit,hookExitCodes:runRecords.map(x=>x.exitCode),duplicateSeqs:summary.nativeEventStore.duplicateId.seqs,outOfOrderSeqs:summary.nativeEventStore.outOfOrder.appendSeqs,writeFailureObserved:fault.provesCleanupGap,outputRoot:out}));
