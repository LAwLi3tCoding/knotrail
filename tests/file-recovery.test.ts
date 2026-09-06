import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createAppService } from '../src/core/service.js';
import { acquireOwnerLock } from '../src/execution/lock.js';
import { sandboxCapability } from '../src/execution/sandbox.js';
import type { Runner } from '../src/runtime/contracts.js';
import type { TaskSnapshot } from '../src/shared/contracts.js';

const capability=sandboxCapability();
// Real host, SQLite, worktree and sandbox helper. Kill at the durable-intent/receipt boundaries.
const host=`
import {createAppService} from './src/core/service.ts';
import {SandboxExecutor} from './src/execution/sandbox.ts';
import {acquireOwnerLock} from './src/execution/lock.ts';
const [dataDir,source,phase]=process.argv.slice(1),lock=acquireOwnerLock(dataDir),sandbox=new SandboxExecutor();
const runner={async run(r,c,signal){
 if(r.purpose==='planning')await c.onControl({kind:'update_plan',submit:true,draft:{sequence:1,summary:'Write the requested file',observations:[],nodes:[{id:'edit',title:'Edit',goal:'Update file',kind:'edit',dependsOn:[],inputs:[{kind:'file',path:'sample.txt',expect:'present'}],outputs:[{id:'sample',kind:'file',path:'sample.txt',expect:'present'}],checkIds:[]}]}});
 else await c.onTool({toolCallId:'crash-window',name:'write_file',args:{path:'sample.txt',content:phase==='noop'?'old\\n':'new\\n',expectedContent:'old\\n'}});
 return {summary:'fixture',turns:1,aborted:signal.aborted};
}};
const executor={async execute(call,options,signal){
 const result=await sandbox.execute(call,{...options,onFileIntent:async intent=>{
  await options.onFileIntent(intent);
  if(phase==='before'||phase==='noop')process.kill(process.pid,'SIGKILL');
 }},signal);
 process.kill(process.pid,'SIGKILL');return result;
}};
const app=createAppService({dataDir,secretStore:{get:()=>undefined,set:()=>{}},notify:()=>{},capabilities:{sandbox:true,platform:'darwin'},lockFd:lock.fd,runner,executor});
await app.command({type:'settings.save',patch:{model:{modelId:'fixture',baseUrl:'http://127.0.0.1:12345/v1'}}});
const project=await app.command({type:'project.add',path:source});
await app.command({type:'task.create',requestId:'real-crash',projectId:project.id,objective:'Change the sample',checks:[],executionPolicy:'autoWithinGrant',mode:'once'});
setInterval(()=>{},1000);
`;
for(const phase of ['before','after','noop'])test(`real host death ${phase}: persist intent before effects and recover without replay`,{skip:!capability.sandbox},async t=>{
 const root=mkdtempSync(join(tmpdir(),'knotrail-file-crash-')),dataDir=join(root,'data'),source=join(root,'source');mkdirSync(source);writeFileSync(join(source,'sample.txt'),'old\n');
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const env={...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.org',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.org'};
 for(const args of [['init'],['add','.'],['commit','-m','fixture']])execFileSync('git',args,{cwd:source,env,stdio:'ignore'});
 const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',host,dataDir,source,phase],{cwd:process.cwd(),stdio:['ignore','ignore','pipe']});
 let stderr='';child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-8000);});
 const timer=setTimeout(()=>child.kill('SIGKILL'),15000);t.after(()=>{clearTimeout(timer);child.kill('SIGKILL');});
 const result=await new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});
 clearTimeout(timer);assert.equal(result.signal,'SIGKILL',stderr);
 let lock:ReturnType<typeof acquireOwnerLock>|undefined;
 for(let i=0;i<200;i++){try{lock=acquireOwnerLock(dataDir);break;}catch{await delay(20);}}
 assert.ok(lock,'The file helper must release the owner lock before recovery');t.after(()=>lock!.release());
 const runner:Runner={async run(r,c,signal){
  assert.equal(r.purpose,'planning','Recovery must never resume the interrupted node');
  assert.equal(readFileSync(join(r.workdir,'sample.txt'),'utf8'),phase==='after'?'new\n':'old\n');
  const context=JSON.parse(r.context!);assert.equal(context.filePostconditions.length,1);
  await c.onControl({kind:'update_plan',submit:true,draft:{sequence:1,summary:'Inspect the current result',observations:[],nodes:[{id:'inspect',title:'Inspect',goal:'Review current files',kind:'research',dependsOn:[],inputs:[{kind:'file',path:'sample.txt',expect:'present'}],outputs:[{id:'summary',kind:'text'}],checkIds:[]}]}});
  return {summary:'fresh plan',turns:1,aborted:signal.aborted};
 }};
 const app=createAppService({dataDir,secretStore:{get:()=>undefined,set:()=>{}},notify:()=>{},capabilities:capability,lockFd:lock.fd,runner,executor:{async execute(){throw new Error('A previous effect must not be replayed');}}});t.after(()=>app.shutdown());
 const recovered=app.store.list()[0]!;assert.ok(recovered,stderr);assert.equal(recovered.actions.length,1,stderr);assert.equal(recovered.actions[0]!.status,'unknown');assert.ok(recovered.actions[0]!.fileIntent,'Intent must survive real owner death');
 assert.equal(readFileSync(join(recovered.task.workdir,'sample.txt'),'utf8'),phase==='after'?'new\n':'old\n');
 app.store.update(recovered.task.id,s=>{s.task.executionPolicy='reviewBeforeExecute';});
 await app.command({type:'task.resume',taskId:recovered.task.id,expectedRevision:1});
 let next:TaskSnapshot=app.store.get(recovered.task.id);
 if(phase==='before'){
  assert.equal(next.task.status,'waiting_user');assert.equal(next.actions[0]!.filePostcondition,undefined,'Old state does not prove whether an operation executed');assert.equal(next.runs.length,2);
 }else{
  for(let i=0;i<200&&next.task.status!=='ready';i++){await delay(10);next=app.store.get(recovered.task.id);}
  assert.equal(next.task.status,'ready',next.task.error);assert.equal(next.actions.length,1);assert.ok(next.actions[0]!.filePostcondition);assert.equal(next.actions[0]!.status,'unknown');assert.notEqual(next.plan!.id,recovered.plan!.id);
  // The no-op was killed before acknowledgement: matching bytes cannot establish causality.
  assert.equal(next.actions[0]!.resolution,undefined);assert.equal(next.checks.length,0);assert.equal(next.task.acceptedDigest,undefined);
 }
 await delay(80);assert.equal(readFileSync(join(next.task.workdir,'sample.txt'),'utf8'),phase==='after'?'new\n':'old\n');
});
