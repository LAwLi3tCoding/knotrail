import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, chmodSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createAppService, type AppService } from '../src/core/service.js';
import { validatePlan } from '../src/core/validation.js';
import { Store, id, now } from '../src/core/store.js';
import type { Runner, RunnerRequest, RunnerCallbacks } from '../src/runtime/contracts.js';
import type { Executor } from '../src/execution/contracts.js';
import { CODEX_BASE_URL } from '../src/shared/contracts.js';
import type { Project, TaskSnapshot, ImpactPreview } from '../src/shared/contracts.js';
const draft={sequence:1,summary:'Update the sample and verify it',observations:[{kind:'fact' as const,text:'Sample repository'}],nodes:[{id:'edit',title:'Edit sample',goal:'Update value',dependsOn:[],kind:'edit' as const,inputs:['sample.txt'],outputs:['sample.txt'],checkIds:['check']},{id:'verify',title:'Review result',goal:'Review current files',dependsOn:['edit'],kind:'verify' as const,inputs:['sample.txt'],outputs:['report'],checkIds:['check']}]};
class FixtureRunner implements Runner {
 count=0;pause?:{entered:()=>void;released:Promise<void>};
 async run(r:RunnerRequest,c:RunnerCallbacks,signal:AbortSignal){this.count++;if(r.purpose==='planning'){
  const denied=await c.onTool({toolCallId:id(),name:'write_file',args:{path:'not-allowed',content:'bad'}});assert.equal(denied.isError,true);
  const plan=structuredClone(draft);if(!r.checks.length)plan.nodes.forEach(n=>n.checkIds=[]);assert.equal((await c.onControl({kind:'update_plan',draft:plan,submit:true})).isError,undefined);
 }else {if(this.pause){this.pause.entered();await this.pause.released;}if(!signal.aborted){if(r.node?.id==='edit')await c.onTool({toolCallId:id(),name:'write_file',args:{path:'sample.txt',content:'updated\n'}});await c.onControl({kind:'complete',summary:'Finished with evidence'});}}
 return {summary:'fixture outcome',turns:1,usage:{input:5,output:3},aborted:signal.aborted};}
}
const executor:Executor={async execute(call,options,signal){if(signal.aborted)return {text:'aborted',isError:true};if(call.name==='write_file')writeFileSync(join(options.workdir,String(call.args.path)),String(call.args.content));if(call.name==='run_command'){assert.deepEqual(call.args.argv,['node','check.mjs']);return {text:readFileSync(join(options.workdir,'sample.txt'),'utf8')==='updated\n'?'pass':'fail',isError:readFileSync(join(options.workdir,'sample.txt'),'utf8')!=='updated\n'};}return {text:'ok'};}};
async function setup(t:test.TestContext,runner:Runner=new FixtureRunner()){
 const root=mkdtempSync(join(tmpdir(),'knotrail-core-')),source=join(root,'source'),dataDir=join(root,'data');mkdirSync(source);writeFileSync(join(source,'sample.txt'),'original\n');writeFileSync(join(source,'check.mjs'),'// immutable acceptance script\n');
 const env={...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.org',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.org'};
 for(const args of [['init'],['add','.'],['commit','-m','fixture']])execFileSync('git',args,{cwd:source,env,stdio:'ignore'});
 let secret:string|undefined;const app=createAppService({dataDir,secretStore:{get:()=>secret,set:v=>{secret=v;}},notify:()=>{},capabilities:{sandbox:true,platform:'darwin'},lockFd:-1,runner,executor});
 t.after(async()=>{if(!(app as any).closing)await app.shutdown();rmSync(root,{recursive:true,force:true});});
 await app.command({type:'settings.save',patch:{model:{baseUrl:'http://127.0.0.1:12345/v1',modelId:'fixture'}}});const project=await app.command({type:'project.add',path:source}) as Project;
 return {app,source,dataDir,project,runner};
}
async function until(app:AppService,taskId:string,predicate:(s:TaskSnapshot)=>boolean):Promise<TaskSnapshot>{const deadline=Date.now()+5000;while(Date.now()<deadline){const s=await app.command({type:'task.snapshot',taskId}) as TaskSnapshot;if(predicate(s))return s;await new Promise(r=>setTimeout(r,10));}throw new Error('State did not settle: '+JSON.stringify(await app.command({type:'task.snapshot',taskId})));}
const create=(project:Project,overrides={})=>({type:'task.create',requestId:id(),projectId:project.id,objective:'Update sample',checks:[{id:'check',label:'Sample check',command:['node','check.mjs'],protectedPaths:['check.mjs']}],executionPolicy:'reviewBeforeExecute',mode:'once',...overrides});
test('validated plan rejects cycles, unknown dependencies and omitted user checks',()=>{assert.throws(()=>validatePlan({...draft,nodes:[{...draft.nodes[0],dependsOn:['edit']}]},[]),/cycle/);assert.throws(()=>validatePlan({...draft,nodes:[{...draft.nodes[0],dependsOn:['missing']}]},[]),/unknown/);assert.throws(()=>validatePlan({...draft,nodes:[{...draft.nodes[0],checkIds:[]}]},[{id:'check',label:'Required',command:['true'],protectedPaths:[]}]),/every/);});
test('create is durable/idempotent; ready gate precedes effects; final checks bind digest',async t=>{const {app,project,source}=await setup(t);const command=create(project);const created=await app.command(command) as TaskSnapshot;const duplicate=await app.command(command) as TaskSnapshot;assert.equal(created.task.id,duplicate.task.id);const ready=await until(app,created.task.id,s=>s.task.status==='ready');assert.equal(readFileSync(join(ready.task.workdir,'sample.txt'),'utf8'),'original\n');assert.equal(ready.actions.length,0);await app.command({type:'task.resume',taskId:created.task.id,expectedRevision:1});const done=await until(app,created.task.id,s=>s.task.status==='completed');assert.equal(done.nodes.filter(n=>n.status==='verified').length,2);assert.equal(done.checks.length,3);assert.ok(done.checks.every(c=>c.inputDigest===done.task.acceptedDigest));assert.equal(readFileSync(join(source,'sample.txt'),'utf8'),'original\n');assert.ok(done.artifacts.length===2&&done.artifacts[0]!.content.includes('updated'));assert.deepEqual(done.events.map(e=>e.seq),done.events.map((_,i)=>i+1));assert.ok(app.report(done.task.id).includes('## Event ledger'));});
test('no acceptance commands requires explicit user acceptance; stale decisions cannot complete',async t=>{const {app,project}=await setup(t);const created=await app.command(create(project,{checks:[],executionPolicy:'autoWithinGrant'})) as TaskSnapshot;const pending=await until(app,created.task.id,s=>s.task.status==='waiting_user');assert.equal(pending.decisions.length,1);const decision=pending.decisions[0]!;writeFileSync(join(pending.task.workdir,'sample.txt'),'external\n');await assert.rejects(app.command({type:'decision.answer',requestId:id(),taskId:created.task.id,decisionId:decision.id,answer:'accept',expectedRevision:1}),/changed/);});
test('goal change preserves immutable plans and rejects stale revision; retries invalidate downstream',async t=>{const {app,project}=await setup(t);const created=await app.command(create(project)) as TaskSnapshot;await until(app,created.task.id,s=>s.task.status==='ready');const preview=await app.command({type:'task.previewRetry',taskId:created.task.id,nodeId:'edit',expectedRevision:1}) as ImpactPreview;assert.deepEqual(preview.affected,['edit','verify']);assert.equal(preview.retained.length,0);const changed=await app.command({type:'task.previewRevision',taskId:created.task.id,objective:'Different goal',expectedRevision:1}) as ImpactPreview;await app.command({type:'task.applyImpact',requestId:id(),preview:changed});const ready=await until(app,created.task.id,s=>s.task.status==='ready');assert.equal(ready.task.revision,2);assert.equal(ready.plans.length,2);assert.equal(ready.plans[0]!.taskRevision,1);await assert.rejects(app.command({type:'task.applyImpact',requestId:id(),preview}),/changed/);});
test('crash recovery marks unfinished effects unknown and blocks automatic replay',async t=>{const {app,project}=await setup(t);const created=await app.command(create(project)) as TaskSnapshot;await until(app,created.task.id,s=>s.task.status==='ready');app.store.update(created.task.id,s=>{s.task.status='executing';s.runs.push({id:id(),taskId:s.task.id,taskRevision:1,purpose:'node',attempt:1,status:'running',startedAt:now(),inputDigest:'digest'});s.actions.push({id:id(),taskId:s.task.id,runId:s.runs.at(-1)!.id,toolCallId:id(),name:'write_file',argsDigest:'digest',status:'pending',startedAt:now()});});
 // A second service is a test-only reconstruction; desktop owner lock forbids two real owners.
 const reconstructed=createAppService({dataDir:(app as any).options.dataDir,secretStore:{get:()=>undefined,set:()=>{}},notify:()=>{},capabilities:{sandbox:true,platform:'darwin'},lockFd:-1,runner:new FixtureRunner(),executor});t.after(()=>reconstructed.shutdown());const recovered=await reconstructed.command({type:'task.snapshot',taskId:created.task.id}) as TaskSnapshot;assert.equal(recovered.task.status,'blocked');assert.equal(recovered.actions[0]!.status,'unknown');assert.equal(recovered.runs.at(-1)!.status,'unknown');});
test('IPC input rejects unknown fields and provider credentials in URLs; secrets never read back',async t=>{const {app}=await setup(t);await assert.rejects(app.command({type:'bootstrap',exec:'anything'}));await assert.rejects(app.command({type:'settings.save',patch:{model:{baseUrl:'https://name:secret@example.org'}}}));const key=id();const settings=await app.command({type:'settings.save',patch:{model:{apiKey:key}}});assert.ok(!JSON.stringify(settings).includes(key));assert.ok(!JSON.stringify(await app.command({type:'bootstrap'})).includes(key));});

test('the last permitted turn may complete the task without a phantom extra turn',async t=>{const {app,project}=await setup(t);const created=await app.command(create(project,{maxTurns:3,executionPolicy:'autoWithinGrant'})) as TaskSnapshot;const done=await until(app,created.task.id,s=>['completed','blocked'].includes(s.task.status));assert.equal(done.task.status,'completed');assert.equal(done.task.turnCount,3);});

test('cancellation makes pending decisions permanently unable to restart a task',async t=>{
 const runner:Runner={async run(r,c,signal){if(r.purpose==='planning'){const p=structuredClone(draft);p.nodes.forEach(n=>n.checkIds=[]);await c.onControl({kind:'update_plan',draft:p,submit:true});}else await c.onControl({kind:'decision',question:'Choose a format',options:['a','b']});return {summary:'decision',turns:1,usage:{input:0,output:0},aborted:signal.aborted};}};
 const {app,project}=await setup(t,runner);const created=await app.command(create(project,{checks:[],executionPolicy:'autoWithinGrant'})) as TaskSnapshot;const waiting=await until(app,created.task.id,s=>s.task.status==='waiting_user');const decision=waiting.decisions[0]!;
 await app.command({type:'task.cancel',taskId:created.task.id,expectedRevision:1});await assert.rejects(app.command({type:'decision.answer',requestId:id(),taskId:created.task.id,decisionId:decision.id,answer:'a',expectedRevision:1}),/not waiting/);
 const cancelled=await app.command({type:'task.snapshot',taskId:created.task.id}) as TaskSnapshot;assert.equal(cancelled.task.status,'cancelled');assert.equal(cancelled.runs.length,waiting.runs.length);assert.equal(cancelled.decisions[0]!.answer,'cancelled');app.store.update(created.task.id,s=>{s.task.expiresAt=new Date(Date.now()-1000).toISOString();});await assert.rejects(app.command({type:'decision.answer',requestId:id(),taskId:created.task.id,decisionId:decision.id,answer:'a',expectedRevision:1}),/not waiting/);assert.equal((await app.command({type:'task.snapshot',taskId:created.task.id}) as TaskSnapshot).task.status,'cancelled');
});
test('invalid merged settings do not replace a key, and endpoint changes clear old credentials',async t=>{
 const {app}=await setup(t);const key=id(),other=id();await app.command({type:'settings.save',patch:{model:{apiKey:key}}});const previous=(app as any).options.secretStore.get();
 await assert.rejects(app.command({type:'settings.save',patch:{model:{baseUrl:'https://provider.example.org/v1',apiKey:other,contextWindow:4096,maxTokens:8192}}}),/fit/);
 assert.equal((app as any).options.secretStore.get(),previous);
 const changed=await app.command({type:'settings.save',patch:{model:{baseUrl:'https://provider.example.org/v1'}}}) as any;assert.equal(changed.model.hasApiKey,false);assert.equal((app as any).options.secretStore.get(),'');
});
test('plan drafts may be incomplete, but only a complete plan can be committed',()=>{const partial={sequence:1,summary:'Reading the project',observations:[],nodes:[]};assert.equal(validatePlan(partial,[],false).nodes.length,0);assert.throws(()=>validatePlan(partial,[],true));});
test('issued impact previews cannot be forged or replayed with a new request ID',async t=>{
 const {app,project}=await setup(t);const created=await app.command(create(project)) as TaskSnapshot;await until(app,created.task.id,s=>s.task.status==='ready');const p=await app.command({type:'task.previewRetry',taskId:created.task.id,nodeId:'edit',expectedRevision:1}) as ImpactPreview;
 await assert.rejects(app.command({type:'task.applyImpact',requestId:id(),preview:{...p,affected:[]}}),/not issued/);
 const request={type:'task.applyImpact',requestId:id(),preview:p};await app.command(request);await app.command(request);await assert.rejects(app.command({...request,requestId:id()}),/not issued/);
});
test('Run deadline aborts an admitted parent tool and blocks automatic retry',async t=>{
 let cleaned=false,admitted=0;
 const runner:Runner={async run(r,c,signal){if(r.purpose==='planning'){const p=structuredClone(draft);p.nodes.forEach(n=>n.checkIds=[]);await c.onControl({kind:'update_plan',draft:p,submit:true});}else{await c.onTool({toolCallId:id(),name:'run_command',args:{argv:['never']}});if(!signal.aborted)await c.onControl({kind:'complete',summary:'unexpected'});}return {summary:'fixture',turns:1,usage:{input:0,output:0},aborted:signal.aborted};}};
 const {app,project}=await setup(t,runner);(app as any).executor={execute:async(_call:unknown,_options:unknown,signal:AbortSignal)=>{admitted++;await new Promise<void>(resolve=>signal.addEventListener('abort',()=>{cleaned=true;resolve();},{once:true}));return {text:'cancelled',isError:true};}};
 const created=await app.command(create(project,{checks:[],executionPolicy:'autoWithinGrant',maxRunMs:1000})) as TaskSnapshot;const blocked=await until(app,created.task.id,s=>s.task.status==='blocked');assert.ok(cleaned);assert.equal(admitted,1);assert.equal(blocked.nodes[0]!.status,'unknown');assert.match(blocked.task.error!,/timed out/);
});

test('an absolute task deadline cannot race the final node into completed',async t=>{
 const {app,project}=await setup(t);const created=await app.command(create(project,{mode:'finite',intervalMinutes:1,expiresAt:new Date(Date.now()+60000).toISOString()})) as TaskSnapshot;await until(app,created.task.id,s=>s.task.status==='ready');
 const slow:Runner={async run(_r,c,signal){await new Promise(resolve=>setTimeout(resolve,350));if(!signal.aborted)await c.onControl({kind:'complete',summary:'late'});return {summary:'late',turns:1,usage:{input:0,output:0},aborted:signal.aborted};}};(app as any).runner=slow;app.store.update(created.task.id,s=>{s.task.expiresAt=new Date(Date.now()+150).toISOString();});
 await app.command({type:'task.resume',taskId:created.task.id,expectedRevision:1});const expired=await until(app,created.task.id,s=>['expired','completed'].includes(s.task.status));assert.equal(expired.task.status,'expired');assert.equal(expired.task.acceptedDigest,undefined);
});

test('a change after the final check receipt cannot be accepted as checked output', async t => {
 const {app,project}=await setup(t);
 const originalNotify=(app as any).options.notify;
 let changed=false;
 (app as any).options.notify=(event:any)=>{originalNotify(event);if(!event.taskId)return;const current=app.store.get(event.taskId);const last=current.events.at(-1);if(!changed&&last?.kind==='check.finished'&&!last.nodeId){changed=true;writeFileSync(join(current.task.workdir,'sample.txt'),'external after verification\n');}};
 const created=await app.command(create(project,{executionPolicy:'autoWithinGrant'})) as TaskSnapshot;
 const end=await until(app,created.task.id,s=>['completed','blocked'].includes(s.task.status));
 assert.ok(changed);assert.equal(end.task.status,'blocked');assert.equal(end.task.acceptedDigest,undefined);assert.match(end.task.error!,/changed|stale|verification/i);
});

test('checks from different workspace revisions cannot form one successful acceptance batch', async t=>{
 const runner:Runner={async run(r,c,signal){if(r.purpose==='planning')await c.onControl({kind:'update_plan',draft:{...draft,nodes:[{...draft.nodes[0]!,checkIds:['first','second']}]},submit:true});else await c.onControl({kind:'complete',summary:'Review both conditions'});return {summary:'fixture',turns:1,usage:{input:0,output:0},aborted:signal.aborted};}};
 const {app,project}=await setup(t,runner);
 (app as any).executor={execute:async(call:any,options:any)=>{const content=readFileSync(join(options.workdir,'sample.txt'),'utf8');return {text:'Observed '+content,isError:content!==call.args.argv[0]};}};
 (app as any).options.notify=(event:any)=>{if(!event.taskId)return;const s=app.store.get(event.taskId);const last=s.events.at(-1);if(last?.kind==='check.finished'&&(last.data as any).conditionId==='first')writeFileSync(join(s.task.workdir,'sample.txt'),'updated\n');if(last?.kind==='check.finished'&&(last.data as any).conditionId==='second'&&last.nodeId)writeFileSync(join(s.task.workdir,'sample.txt'),'original\n');};
 const created=await app.command(create(project,{executionPolicy:'autoWithinGrant',checks:[{id:'first',label:'Requires original',command:['original\n'],protectedPaths:[]},{id:'second',label:'Requires updated',command:['updated\n'],protectedPaths:[]}]})) as TaskSnapshot;
 const end=await until(app,created.task.id,s=>['completed','blocked'].includes(s.task.status));assert.equal(end.task.status,'blocked');assert.equal(end.task.acceptedDigest,undefined);
});

test('a planner candidate is not published when its source changed before worker shutdown',async t=>{
 const runner:Runner={async run(r,c,signal){await c.onControl({kind:'update_plan',draft:structuredClone(draft),submit:true});writeFileSync(join(r.workdir,'sample.txt'),'concurrent source change\n');return {summary:'candidate',turns:1,usage:{input:0,output:0},aborted:signal.aborted};}};
 const {app,project}=await setup(t,runner);const created=await app.command(create(project)) as TaskSnapshot;
 const end=await until(app,created.task.id,s=>['ready','blocked'].includes(s.task.status));assert.equal(end.task.status,'blocked');assert.equal(end.plan,undefined);assert.equal(end.plans.length,0);assert.ok(end.draft);
});

function uncertainAction(app:AppService,taskId:string,name='write_file') {
 app.store.update(taskId,s=>{s.actions.push({id:id(),taskId,runId:s.runs[0]!.id,nodeId:'edit',toolCallId:id(),name,argsDigest:'unavailable',status:'unknown',startedAt:now()});s.task.status='blocked';});
}
test('unknown effects freeze resume and every impact path until a bound recovery decision',async t=>{
 const {app,project}=await setup(t);const created=await app.command(create(project)) as TaskSnapshot;await until(app,created.task.id,s=>s.task.status==='ready');
 const preview=await app.command({type:'task.previewRetry',taskId:created.task.id,nodeId:'edit',expectedRevision:1}) as ImpactPreview;uncertainAction(app,created.task.id);
 await assert.rejects(app.command({type:'task.applyImpact',requestId:id(),preview}),/unknown effects/i);
 for(const command of [{type:'task.previewRetry',nodeId:'edit'},{type:'task.previewRevision',objective:'New objective'}])await assert.rejects(app.command({...command,taskId:created.task.id,expectedRevision:1}),/unknown effects/i);
 const waiting=await app.command({type:'task.snapshot',taskId:created.task.id}) as TaskSnapshot;assert.equal(waiting.task.status,'waiting_user');assert.equal(waiting.runs.length,1);assert.equal(readFileSync(join(waiting.task.workdir,'sample.txt'),'utf8'),'original\n');
 const decision=waiting.decisions.find(d=>d.kind==='recovery')!;assert.ok(decision);assert.ok(waiting.artifacts.some(a=>a.id===decision.recovery?.artifactId));
 writeFileSync(join(waiting.task.workdir,'sample.txt'),'user kept this\n');await assert.rejects(app.command({type:'decision.answer',requestId:id(),taskId:created.task.id,decisionId:decision.id,answer:'preserve-and-replan',expectedRevision:1}),/changed/);
 await app.command({type:'task.resume',taskId:created.task.id,expectedRevision:1});const refreshed=await app.command({type:'task.snapshot',taskId:created.task.id}) as TaskSnapshot;const next=refreshed.decisions.find(d=>d.kind==='recovery'&&!d.answer)!;
 assert.notEqual(next.id,decision.id);await app.command({type:'decision.answer',requestId:id(),taskId:created.task.id,decisionId:next.id,answer:'preserve-and-replan',expectedRevision:1});const ready=await until(app,created.task.id,s=>s.task.status==='ready');assert.equal(ready.task.revision,2);assert.equal(ready.actions[0]!.status,'unknown');assert.equal(ready.actions[0]!.resolution?.decisionId,next.id);assert.equal(readFileSync(join(ready.task.workdir,'sample.txt'),'utf8'),'user kept this\n');assert.equal(ready.runs.length,2);
});
test('an unknown read does not create a false unknown-effect gate',async t=>{
 const {app,project}=await setup(t);const created=await app.command(create(project)) as TaskSnapshot;await until(app,created.task.id,s=>s.task.status==='ready');uncertainAction(app,created.task.id,'read_file');await app.command({type:'task.resume',taskId:created.task.id,expectedRevision:1});const done=await until(app,created.task.id,s=>['completed','waiting_user','blocked'].includes(s.task.status));assert.equal(done.task.status,'completed');assert.equal(done.decisions.length,0);
});
test('a lost receipt after a file effect aborts admission and cannot replay with a new tool call ID',async t=>{
 let admitted=0;
 const runner:Runner={async run(r,c,signal){if(r.purpose==='planning'){await c.onControl({kind:'update_plan',draft,submit:true});}else{for(let i=0;i<2;i++){try{await c.onTool({toolCallId:id(),name:'write_file',args:{path:'sample.txt',content:'updated\n'}});}catch{}}await c.onControl({kind:'complete',summary:'not authoritative'});}return {summary:'fixture',turns:1,usage:{input:0,output:0},aborted:signal.aborted};}};
 const {app,project}=await setup(t,runner);(app as any).executor={async execute(...args:Parameters<Executor['execute']>){admitted++;return executor.execute(...args);}};
 const put=app.store.put.bind(app.store);let failed=false;app.store.put=(s)=>{if(!failed&&s.actions.some(a=>a.name==='write_file'&&a.status==='succeeded')){failed=true;throw new Error('Injected receipt commit failure');}put(s);};
 const created=await app.command(create(project,{executionPolicy:'autoWithinGrant'})) as TaskSnapshot;const blocked=await until(app,created.task.id,s=>['completed','blocked'].includes(s.task.status));assert.equal(blocked.task.status,'blocked');assert.equal(admitted,1);assert.equal(blocked.actions[0]!.status,'unknown');assert.equal(readFileSync(join(blocked.task.workdir,'sample.txt'),'utf8'),'updated\n');
 await app.command({type:'task.resume',taskId:created.task.id,expectedRevision:1});const waiting=await app.command({type:'task.snapshot',taskId:created.task.id}) as TaskSnapshot;assert.equal(waiting.task.status,'waiting_user');assert.equal(admitted,1);
});
test('terminal tasks can dispose unknown effects without starting another run',async t=>{
 const {app,project}=await setup(t);const created=await app.command(create(project)) as TaskSnapshot;await until(app,created.task.id,s=>s.task.status==='ready');uncertainAction(app,created.task.id,'run_command');await app.command({type:'task.cancel',taskId:created.task.id,expectedRevision:1});
 await app.command({type:'task.inspectEffects',taskId:created.task.id});const cancelled=await app.command({type:'task.snapshot',taskId:created.task.id}) as TaskSnapshot;assert.equal(cancelled.task.status,'cancelled');const decision=cancelled.decisions.find(d=>d.kind==='recovery'&&!d.answer)!;assert.deepEqual(decision.options,['preserve-and-stop']);
 const answer={type:'decision.answer',requestId:id(),taskId:created.task.id,decisionId:decision.id,answer:'preserve-and-stop',expectedRevision:1};await app.command(answer);await app.command(answer);const done=await app.command({type:'task.snapshot',taskId:created.task.id}) as TaskSnapshot;assert.equal(done.task.status,'cancelled');assert.equal(done.runs.length,1);assert.equal(done.actions[0]!.status,'unknown');assert.equal(done.actions[0]!.resolution?.disposition,'preserve-and-stop');await assert.rejects(app.command({type:'task.resume',taskId:created.task.id,expectedRevision:1}),/terminal/);
});
test('failed pending persistence cannot admit the effect; failed artifact persistence cannot complete',async t=>{
 for(const failure of ['pending','artifact']){const {app,project}=await setup(t);const put=app.store.put.bind(app.store);let injected=false,calls=0;(app as any).executor={async execute(...args:Parameters<Executor['execute']>){calls++;return executor.execute(...args);}};
 app.store.put=s=>{if(!injected&&(failure==='pending'?s.actions.some(a=>a.status==='pending'):s.artifacts.length)){injected=true;throw new Error('Injected '+failure+' persistence failure');}put(s);};
 const created=await app.command(create(project,{executionPolicy:'autoWithinGrant'})) as TaskSnapshot;const done=await until(app,created.task.id,s=>['completed','blocked'].includes(s.task.status));assert.equal(done.task.status,'blocked');assert.equal(done.task.acceptedDigest,undefined);if(failure==='pending')assert.equal(calls,0);else assert.equal(done.artifacts.length,0);
 }
});
test('an unknown check command prevents timer wake and other task effects',async t=>{
 const {app,project}=await setup(t);const first=await app.command(create(project,{mode:'finite',intervalMinutes:1,expiresAt:new Date(Date.now()+60000).toISOString()})) as TaskSnapshot;await until(app,first.task.id,s=>s.task.status==='ready');uncertainAction(app,first.task.id,'required_check');app.store.update(first.task.id,s=>{s.task.status='waiting_external';s.task.nextCheckAt=new Date(0).toISOString();});(app as any).wake();const waiting=await until(app,first.task.id,s=>s.task.status==='waiting_user');assert.equal(waiting.runs.length,1);
 const second=await app.command(create(project,{executionPolicy:'autoWithinGrant'})) as TaskSnapshot;const blocked=await until(app,second.task.id,s=>s.task.status==='blocked');assert.equal(blocked.runs.length,0);assert.match(blocked.task.error!,/unknown command effects/i);
});
test('a failed recovery disposition commit leaves the effect gate closed',async t=>{
 const {app,project}=await setup(t);const created=await app.command(create(project)) as TaskSnapshot;await until(app,created.task.id,s=>s.task.status==='ready');uncertainAction(app,created.task.id);await app.command({type:'task.resume',taskId:created.task.id,expectedRevision:1});const waiting=await app.command({type:'task.snapshot',taskId:created.task.id}) as TaskSnapshot;const decision=waiting.decisions.find(d=>d.kind==='recovery')!;
 const put=app.store.put.bind(app.store);app.store.put=s=>{if(s.actions.some(a=>a.resolution))throw new Error('Injected disposition persistence failure');put(s);};await assert.rejects(app.command({type:'decision.answer',requestId:id(),taskId:created.task.id,decisionId:decision.id,answer:'preserve-and-replan',expectedRevision:1}),/persistence/);const unchanged=await app.command({type:'task.snapshot',taskId:created.task.id}) as TaskSnapshot;assert.equal(unchanged.task.status,'waiting_user');assert.equal(unchanged.actions[0]!.resolution,undefined);assert.equal(unchanged.runs.length,1);
});
test('source changes after Ready require a new plan before the first node can run',async t=>{
 const {app,project}=await setup(t);const created=await app.command(create(project)) as TaskSnapshot;const first=await until(app,created.task.id,s=>s.task.status==='ready');writeFileSync(join(first.task.workdir,'sample.txt'),'changed after ready\n');await app.command({type:'task.resume',taskId:created.task.id,expectedRevision:1});const next=await until(app,created.task.id,s=>s.task.status==='ready'||s.task.status==='completed');assert.equal(next.task.status,'ready');assert.equal(next.plans.length,2);assert.equal(next.actions.length,0);assert.equal(readFileSync(join(next.task.workdir,'sample.txt'),'utf8'),'changed after ready\n');
});
test('foreign unknown commands cannot turn a terminal task into a resumable task',async t=>{
 const {app,project}=await setup(t);const a=await app.command(create(project)) as TaskSnapshot;await until(app,a.task.id,s=>s.task.status==='ready');await app.command({type:'task.cancel',taskId:a.task.id,expectedRevision:1});
 const b=await app.command(create(project)) as TaskSnapshot;await until(app,b.task.id,s=>s.task.status==='ready');uncertainAction(app,b.task.id,'run_command');await app.command({type:'task.cancel',taskId:b.task.id,expectedRevision:1});
 const inspected=await app.command({type:'task.inspectEffects',taskId:a.task.id}) as TaskSnapshot;assert.equal(inspected.task.status,'cancelled');assert.equal(inspected.runs.length,1);
 const recovery=await app.command({type:'task.inspectEffects',taskId:b.task.id}) as TaskSnapshot;await app.command({type:'decision.answer',requestId:id(),taskId:b.task.id,decisionId:recovery.decisions.find(d=>d.kind==='recovery')!.id,answer:'preserve-and-stop',expectedRevision:1});await assert.rejects(app.command({type:'task.resume',taskId:a.task.id,expectedRevision:1}),/terminal/);
});

class WaitRunner extends FixtureRunner {
 waited=false;contexts:string[]=[];
 constructor(readonly source:'workspace_file'|'project_file'='project_file',readonly condition:'changed'|'exists'|'contains'='contains'){super();}
 override async run(r:RunnerRequest,c:RunnerCallbacks,signal:AbortSignal){
  this.contexts.push(r.context);
  if(r.purpose==='node'&&!this.waited){this.waited=true;this.count++;if(this.source==='workspace_file')await c.onTool({toolCallId:id(),name:'write_file',args:{path:'sample.txt',content:'self-written\n'}});await c.onControl({kind:'wait',reason:'Wait for the declared source',minutes:1,source:{kind:this.source,path:this.source==='project_file'?'signal.txt':'sample.txt'},condition:this.condition==='contains'?{kind:'contains',text:'ready'}:{kind:this.condition}});return {summary:'waiting',turns:1,usage:{input:4,output:2},aborted:signal.aborted};}
  return super.run(r,c,signal);
 }
}
function due(app:AppService,taskId:string,missedMinutes=0){app.store.update(taskId,s=>{s.task.nextCheckAt=new Date(Date.now()-missedMinutes*60000-10).toISOString();});for(let i=0;i<12;i++)(app as any).wake();}
test('file waits coalesce missed observations, preserve unknown sources, and wake only on new qualifying information',async t=>{
 const runner=new WaitRunner(),{app,project,source}=await setup(t,runner);const created=await app.command(create(project,{mode:'finite',intervalMinutes:1,expiresAt:new Date(Date.now()+3600000).toISOString(),executionPolicy:'autoWithinGrant'})) as TaskSnapshot;
 const waiting=await until(app,created.task.id,s=>s.task.status==='waiting_external');assert.equal(waiting.task.wait?.source.path,'signal.txt');
 due(app,created.task.id,4);const unchanged=await until(app,created.task.id,s=>s.task.status==='waiting_external'&&Date.parse(s.task.nextCheckAt!)>Date.now());assert.equal(unchanged.task.status,'waiting_external');assert.equal(unchanged.task.wait!.last.missedIntervals,4);assert.equal(runner.count,2);
 mkdirSync(join(source,'signal.txt'));due(app,created.task.id);const unavailable=await until(app,created.task.id,s=>s.task.wait?.last.status==='unknown');assert.equal(unavailable.task.status,'waiting_external');assert.equal(runner.count,2);
 rmSync(join(source,'signal.txt'),{recursive:true});writeFileSync(join(source,'signal.txt'),'ready with an external change\n');due(app,created.task.id);const done=await until(app,created.task.id,s=>['completed','blocked'].includes(s.task.status));assert.equal(done.task.status,'completed');assert.equal(runner.count,4);assert.ok(runner.contexts.at(-2)!.includes('ready with an external change'));assert.equal(done.events.filter(e=>e.kind==='wait.satisfied').length,1);
});
test('self writes establish the wait baseline and pause/resume without new input does not spend model turns',async t=>{
 const runner=new WaitRunner('workspace_file','changed'),{app,project}=await setup(t,runner);const created=await app.command(create(project,{mode:'finite',intervalMinutes:1,expiresAt:new Date(Date.now()+3600000).toISOString(),executionPolicy:'autoWithinGrant'})) as TaskSnapshot;
 const waiting=await until(app,created.task.id,s=>s.task.status==='waiting_external');assert.ok(waiting.task.wait?.baselineDigest);due(app,created.task.id);await until(app,created.task.id,s=>Date.parse(s.task.nextCheckAt!)>Date.now());assert.equal(runner.count,2);
 await app.command({type:'task.pause',taskId:created.task.id,expectedRevision:1});await app.command({type:'task.resume',taskId:created.task.id,expectedRevision:1});const resumed=await until(app,created.task.id,s=>s.task.status==='waiting_external'&&!!s.task.nextCheckAt);assert.equal(resumed.task.turnCount,2);assert.equal(runner.count,2);assert.equal(readFileSync(join(resumed.task.workdir,'sample.txt'),'utf8'),'self-written\n');
});
test('maintenance verifies current files without replaying edit nodes and records unhealthy until repaired externally',async t=>{
 const {app,project,runner}=await setup(t);const created=await app.command(create(project,{mode:'maintain',intervalMinutes:1,executionPolicy:'autoWithinGrant'})) as TaskSnapshot;const healthy=await until(app,created.task.id,s=>s.task.status==='healthy');const modelRuns=(runner as FixtureRunner).count;
 (app as any).executor={async execute(...args:Parameters<Executor['execute']>){const result=await executor.execute(...args);return {...result,exitCode:result.isError?1:0};}};
 writeFileSync(join(healthy.task.workdir,'sample.txt'),'user changed this\n');due(app,created.task.id,3);const unhealthy=await until(app,created.task.id,s=>s.task.status==='unhealthy'||s.task.status==='blocked');assert.equal(unhealthy.task.status,'unhealthy');assert.equal(unhealthy.task.health?.missedIntervals,3);assert.equal((runner as FixtureRunner).count,modelRuns);assert.equal(readFileSync(join(healthy.task.workdir,'sample.txt'),'utf8'),'user changed this\n');assert.equal(unhealthy.task.acceptedDigest,undefined);assert.equal(unhealthy.runs.at(-1)?.purpose,'verification');assert.ok(unhealthy.checks.some(c=>c.scope==='maintenance'&&c.runId===unhealthy.runs.at(-1)!.id));
 writeFileSync(join(healthy.task.workdir,'sample.txt'),'updated\n');due(app,created.task.id);const restored=await until(app,created.task.id,s=>s.task.status==='healthy');assert.equal((runner as FixtureRunner).count,modelRuns);assert.equal(restored.task.health!.inputDigest,restored.task.acceptedDigest);
});


test('already satisfied input advances once and repeated waits cannot bypass consumption through resume',async t=>{
 class RepeatWaitRunner extends FixtureRunner {
  override async run(r:RunnerRequest,c:RunnerCallbacks,signal:AbortSignal){
   if(r.purpose==='planning')return super.run(r,c,signal);this.count++;
   await c.onControl({kind:'wait',reason:'Waiting for ready input',minutes:1,source:{kind:'project_file',path:'signal.txt'},condition:{kind:'contains',text:'ready'}});
   return {summary:'waiting',turns:1,usage:{input:4,output:2},aborted:signal.aborted};
  }
 }
 const runner=new RepeatWaitRunner(),{app,project,source}=await setup(t,runner);
 const created=await app.command(create(project,{mode:'finite',intervalMinutes:1,expiresAt:new Date(Date.now()+3600000).toISOString(),maxTurns:3})) as TaskSnapshot;
 await until(app,created.task.id,s=>s.task.status==='ready');writeFileSync(join(source,'signal.txt'),'ready v1');await app.command({type:'task.resume',taskId:created.task.id,expectedRevision:1});
 const waiting=await until(app,created.task.id,s=>s.task.status==='waiting_external'&&s.runs.length===3);
 assert.equal(Object.keys(waiting.task.consumedObservations??{}).length,1);assert.equal(waiting.task.wait?.consumedAt,undefined);assert.equal(waiting.task.wait?.last.status,'satisfied');
 await app.command({type:'task.pause',taskId:created.task.id,expectedRevision:1});await app.command({type:'task.resume',taskId:created.task.id,expectedRevision:1});
 const resumed=await until(app,created.task.id,s=>s.task.status==='waiting_external'&&Date.parse(s.task.nextCheckAt!)>Date.now());assert.equal(runner.count,3);
 due(app,created.task.id);await until(app,created.task.id,s=>Date.parse(s.task.nextCheckAt!)>Date.now());assert.equal(runner.count,3);
 writeFileSync(join(source,'signal.txt'),'ready v2');due(app,created.task.id);const exhausted=await until(app,created.task.id,s=>s.task.status==='blocked');assert.match(exhausted.task.error!,/budget/);assert.equal(runner.count,3);assert.equal(exhausted.events.filter(e=>e.kind==='wait.satisfied').length,2);
});

test('wait observations distinguish absent files from unreadable, oversized and replaced sources',async t=>{
 const runner=new WaitRunner('project_file','changed'),{app,project,source}=await setup(t,runner);
 const created=await app.command(create(project,{mode:'finite',intervalMinutes:1,expiresAt:new Date(Date.now()+3600000).toISOString()})) as TaskSnapshot;
 await until(app,created.task.id,s=>s.task.status==='ready');writeFileSync(join(source,'signal.txt'),'before');await app.command({type:'task.resume',taskId:created.task.id,expectedRevision:1});const waiting=await until(app,created.task.id,s=>s.task.status==='waiting_external');
 const observe=()=>{const s=app.store.get(created.task.id);return (app as any).readObservation(s,s.task.wait,s.task.wait);};
 chmodSync(join(source,'signal.txt'),0);assert.equal(observe().status,'unknown');chmodSync(join(source,'signal.txt'),0o600);
 writeFileSync(join(source,'signal.txt'),'x'.repeat(32001)+'ready');assert.equal(observe().status,'unknown');
 rmSync(join(source,'signal.txt'));symlinkSync('absent-target',join(source,'signal.txt'));assert.equal(observe().status,'unknown');rmSync(join(source,'signal.txt'));
 assert.equal(observe().status,'satisfied');assert.equal(observe().digest,null);
 renameSync(source,source+'-previous');mkdirSync(source);assert.equal(observe().status,'unknown');rmSync(source,{recursive:true});renameSync(source+'-previous',source);
 due(app,created.task.id);const done=await until(app,created.task.id,s=>['completed','blocked'].includes(s.task.status));assert.equal(done.task.status,'completed');assert.ok(done.checks.every(c=>c.observationDigest));assert.ok(waiting.task.wait!.sourceIdentity);
});

test('verification rejects a consumed observation that changes after its checks',async t=>{
 const runner=new WaitRunner(),{app,project,source}=await setup(t,runner);const created=await app.command(create(project,{mode:'finite',intervalMinutes:1,expiresAt:new Date(Date.now()+3600000).toISOString(),executionPolicy:'autoWithinGrant'})) as TaskSnapshot;
 await until(app,created.task.id,s=>s.task.status==='waiting_external');
 const put=app.store.put.bind(app.store);let changed=false;app.store.put=s=>{put(s);if(!changed&&s.checks.some(c=>c.observationDigest)){changed=true;writeFileSync(join(source,'signal.txt'),'revoked');}};
 writeFileSync(join(source,'signal.txt'),'ready');due(app,created.task.id);const blocked=await until(app,created.task.id,s=>s.task.status==='blocked');assert.equal(changed,true);assert.equal(blocked.task.acceptedDigest,undefined);assert.equal(blocked.nodes[0]!.status,'failed');assert.equal(blocked.runs.length,3);
});

test('maintenance requires checks and records interrupted or changing verification as unknown',async t=>{
 const {app,project,runner}=await setup(t);await assert.rejects(app.command(create(project,{mode:'maintain',intervalMinutes:1,checks:[]})),/requires at least one/);
 const created=await app.command(create(project,{mode:'maintain',intervalMinutes:1,executionPolicy:'autoWithinGrant',maxTurns:3})) as TaskSnapshot;const healthy=await until(app,created.task.id,s=>s.task.status==='healthy');
 (app as any).executor={async execute(){writeFileSync(join(healthy.task.workdir,'sample.txt'),'changed during check');return {text:'check passed before change',exitCode:0};}};due(app,created.task.id);const stale=await until(app,created.task.id,s=>s.task.status==='unknown');assert.equal(stale.task.health?.status,'unknown');assert.equal(stale.task.acceptedDigest,undefined);assert.equal((runner as FixtureRunner).count,3);
 (app as any).executor={async execute(){return {text:'command did not establish an exit status',isError:true};}};due(app,created.task.id);const interrupted=await until(app,created.task.id,s=>s.runs.filter(r=>r.purpose==='verification').length===2&&s.task.status==='unknown');assert.equal(interrupted.checks.at(-1)!.result,'unknown');assert.equal(interrupted.actions.at(-1)!.status,'unknown');
 due(app,created.task.id);const recovery=await until(app,created.task.id,s=>s.task.status==='waiting_user');assert.equal(recovery.decisions.at(-1)!.kind,'recovery');assert.equal((runner as FixtureRunner).count,3);
});


test('durable waits catch up after reconstruction and preserve a release saved before the next Run',async t=>{
 for(const point of ['due','released']){
  const runner=new WaitRunner(),{app,project,source}=await setup(t,runner);const created=await app.command(create(project,{mode:'finite',intervalMinutes:1,expiresAt:new Date(Date.now()+3600000).toISOString(),executionPolicy:'autoWithinGrant'})) as TaskSnapshot;
  await until(app,created.task.id,s=>s.task.status==='waiting_external');await (app as any).stop(created.task.id);
  writeFileSync(join(source,'signal.txt'),'ready after restart');app.store.update(created.task.id,s=>{s.task.nextCheckAt=new Date(Date.now()-5*60000-10).toISOString();});
  if(point==='released')assert.equal((app as any).observeWait(created.task.id),true);
  // Reconstruct a persisted boundary with no active effect. Real process-kill coverage is separate.
  (app as any).closing=true;clearInterval((app as any).timer);app.store.close();
  const reconstructed=createAppService((app as any).options);
  try{
   if(point==='released'){const recovered=reconstructed.store.get(created.task.id);assert.equal(recovered.task.status,'blocked');assert.ok(recovered.task.wait?.consumedAt);await reconstructed.command({type:'task.resume',taskId:created.task.id,expectedRevision:1});}
   const done=await until(reconstructed,created.task.id,s=>s.task.status==='completed');assert.equal(runner.count,4);assert.equal(done.events.filter(e=>e.kind==='wait.satisfied').length,1);assert.equal(done.task.wait?.last.missedIntervals,5);
  }finally{await reconstructed.shutdown();}
 }
});

test('a released wait must be reobserved before resumed model effects',async t=>{
 const runner=new WaitRunner(),{app,project,source}=await setup(t,runner);
 const created=await app.command(create(project,{mode:'finite',intervalMinutes:1,expiresAt:new Date(Date.now()+3600000).toISOString(),executionPolicy:'autoWithinGrant'})) as TaskSnapshot;
 await until(app,created.task.id,s=>s.task.status==='waiting_external');await (app as any).stop(created.task.id);
 writeFileSync(join(source,'signal.txt'),'ready');app.store.update(created.task.id,s=>s.task.nextCheckAt=new Date(0).toISOString());assert.equal((app as any).observeWait(created.task.id),true);
 await app.command({type:'task.pause',taskId:created.task.id,expectedRevision:1});writeFileSync(join(source,'signal.txt'),'revoked');
 await app.command({type:'task.resume',taskId:created.task.id,expectedRevision:1});const end=await until(app,created.task.id,s=>['blocked','waiting_external','completed'].includes(s.task.status));
 assert.equal(readFileSync(join(end.task.workdir,'sample.txt'),'utf8'),'original\n','revoked source must not admit a resumed write');assert.equal(runner.count,2);
});
test('explicit new objective can consume the existing qualifying source once',async t=>{
 class Repeat extends FixtureRunner {override async run(r:RunnerRequest,c:RunnerCallbacks,signal:AbortSignal){if(r.purpose==='planning')return super.run(r,c,signal);this.count++;await c.onControl({kind:'wait',reason:'Need current readiness',minutes:1,source:{kind:'project_file',path:'signal.txt'},condition:{kind:'contains',text:'ready'}});return {summary:'wait',turns:1,usage:{input:4,output:2},aborted:signal.aborted};}}
 const runner=new Repeat(),{app,project,source}=await setup(t,runner);const created=await app.command(create(project,{mode:'finite',intervalMinutes:1,expiresAt:new Date(Date.now()+3600000).toISOString()})) as TaskSnapshot;
 await until(app,created.task.id,s=>s.task.status==='ready');writeFileSync(join(source,'signal.txt'),'ready');await app.command({type:'task.resume',taskId:created.task.id,expectedRevision:1});await until(app,created.task.id,s=>s.task.status==='waiting_external'&&s.runs.length===3);
 const preview=await app.command({type:'task.previewRevision',taskId:created.task.id,expectedRevision:1,objective:'A different user-authorized objective using current readiness'}) as ImpactPreview;await app.command({type:'task.applyImpact',requestId:id(),preview});await until(app,created.task.id,s=>s.task.status==='ready'&&s.task.revision===2);
 await app.command({type:'task.resume',taskId:created.task.id,expectedRevision:2});await until(app,created.task.id,s=>s.task.status==='waiting_external'&&s.runs.length>=5);await new Promise(r=>setTimeout(r,50));assert.equal(runner.count,6);
});
test('a later real A-B-A-B source transition is new information',async t=>{
 class RepeatChanged extends FixtureRunner {override async run(r:RunnerRequest,c:RunnerCallbacks,signal:AbortSignal){if(r.purpose==='planning')return super.run(r,c,signal);this.count++;await c.onControl({kind:'wait',reason:'Wait for next status transition',minutes:1,source:{kind:'project_file',path:'signal.txt'},condition:{kind:'changed'}});return {summary:'wait',turns:1,usage:{input:4,output:2},aborted:signal.aborted};}}
 const runner=new RepeatChanged(),{app,project,source}=await setup(t,runner);const created=await app.command(create(project,{mode:'finite',intervalMinutes:1,expiresAt:new Date(Date.now()+3600000).toISOString()})) as TaskSnapshot;
 await until(app,created.task.id,s=>s.task.status==='ready');writeFileSync(join(source,'signal.txt'),'A');await app.command({type:'task.resume',taskId:created.task.id,expectedRevision:1});await until(app,created.task.id,s=>s.task.status==='waiting_external');
 writeFileSync(join(source,'signal.txt'),'B');due(app,created.task.id);await until(app,created.task.id,s=>s.task.status==='waiting_external'&&s.runs.length===3);
 writeFileSync(join(source,'signal.txt'),'A');due(app,created.task.id);await until(app,created.task.id,s=>s.task.status==='waiting_external'&&s.runs.length===4);
 writeFileSync(join(source,'signal.txt'),'B');due(app,created.task.id);await until(app,created.task.id,s=>s.task.status==='waiting_external'&&Date.parse(s.task.nextCheckAt!)>Date.now());assert.equal(runner.count,5);
});


test('source revocation during a Run blocks tool admission before any write',async t=>{
 const runner=new WaitRunner(),{app,project,source}=await setup(t,runner);const created=await app.command(create(project,{mode:'finite',intervalMinutes:1,expiresAt:new Date(Date.now()+3600000).toISOString(),executionPolicy:'autoWithinGrant'})) as TaskSnapshot;
 await until(app,created.task.id,s=>s.task.status==='waiting_external');let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;}),released=new Promise<void>(resolve=>{release=resolve;});runner.pause={entered,released};writeFileSync(join(source,'signal.txt'),'ready');due(app,created.task.id);await started;
 writeFileSync(join(source,'signal.txt'),'revoked');release();const blocked=await until(app,created.task.id,s=>s.task.status==='blocked');assert.equal(readFileSync(join(blocked.task.workdir,'sample.txt'),'utf8'),'original\n');assert.equal(blocked.actions.length,0);assert.equal(blocked.task.acceptedDigest,undefined);
});

test('a false condition followed by the same qualifying content is new observed information',async t=>{
 class Repeating extends FixtureRunner {override async run(r:RunnerRequest,c:RunnerCallbacks,signal:AbortSignal){if(r.purpose==='planning')return super.run(r,c,signal);this.count++;await c.onControl({kind:'wait',reason:'Ready condition',minutes:1,source:{kind:'project_file',path:'signal.txt'},condition:{kind:'contains',text:'ready'}});return {summary:'wait',turns:1,usage:{input:4,output:2},aborted:signal.aborted};}}
 const runner=new Repeating(),{app,project,source}=await setup(t,runner);const created=await app.command(create(project,{mode:'finite',intervalMinutes:1,expiresAt:new Date(Date.now()+3600000).toISOString()})) as TaskSnapshot;
 await until(app,created.task.id,s=>s.task.status==='ready');writeFileSync(join(source,'signal.txt'),'ready');await app.command({type:'task.resume',taskId:created.task.id,expectedRevision:1});await until(app,created.task.id,s=>s.task.status==='waiting_external'&&s.runs.length===3);
 writeFileSync(join(source,'signal.txt'),'not yet');due(app,created.task.id);await until(app,created.task.id,s=>s.task.wait?.last.status==='waiting');assert.equal(runner.count,3);
 writeFileSync(join(source,'signal.txt'),'ready');due(app,created.task.id);await until(app,created.task.id,s=>s.task.status==='waiting_external'&&s.runs.length===4);assert.equal(runner.count,4);
});


function loginToken(label:string,seconds=Math.floor(Date.now()/1000)+300){return [Buffer.from(JSON.stringify({alg:'RS256'})).toString('base64url'),Buffer.from(JSON.stringify({exp:seconds,jti:label,'https://api.openai.com/auth':{chatgpt_account_id:'synthetic-account'}})).toString('base64url'),'synthetic-signature'].join('.');}
function loginCache(path:string,token:string){writeFileSync(path,JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:token,refresh_token:'synthetic-refresh-must-stay-local'}}),{mode:0o600});}
test('Codex login uses a fixed endpoint and rereads access-only credentials for each Run',async t=>{
 const seen:RunnerRequest['model'][]=[],first=loginToken('first'),second=loginToken('second');let cache='';const fixture=new FixtureRunner();
 const runner:Runner={async run(r,c,signal){seen.push(r.model);c.onEvent('assistant.delta','safe '+first,{nested:{value:first}});const result=await fixture.run(r,c,signal);if(r.purpose==='planning')loginCache(cache,second);return {...result,summary:'summary '+r.model.apiKey};}};
 const {app,project,dataDir}=await setup(t,runner);cache=join(dataDir,'synthetic-codex-auth.json');loginCache(cache,first);(app as any).options.codexAuthPath=cache;
 const saved=await app.command({type:'settings.save',patch:{model:{authSource:'codex-login',modelId:'gpt-6-astra'}}}) as any;assert.equal(saved.model.baseUrl,CODEX_BASE_URL);assert.equal(saved.model.hasApiKey,false);
 const request=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('Local login check must not request a remote model list');};try{const check=await app.command({type:'model.check'});assert.match(JSON.stringify(check),/Run a task to verify/);}finally{globalThis.fetch=request;}
 const created=await app.command(create(project,{executionPolicy:'autoWithinGrant'})) as TaskSnapshot;const done=await until(app,created.task.id,s=>s.task.status==='completed');
 assert.equal(seen.length,3);assert.equal(seen[0]!.apiKey,first);assert.ok(seen.slice(1).every(m=>m.apiKey === second));assert.ok(seen.every(m=>m.authSource==='codex-login'&&m.baseUrl===CODEX_BASE_URL&&m.expiresAt!>Date.now()));
 const exposed=JSON.stringify(await app.command({type:'bootstrap'}))+JSON.stringify(done)+app.report(done.task.id);assert.ok(!exposed.includes(first)&&!exposed.includes(second));assert.ok(!JSON.stringify(seen).includes('synthetic-refresh-must-stay-local'));assert.equal(JSON.parse(readFileSync(cache,'utf8')).tokens.refresh_token,'synthetic-refresh-must-stay-local');
});
test('Codex login rejects caller endpoints, pasted keys and missing cache without creating a task',async t=>{
 const {app,project,dataDir}=await setup(t);(app as any).options.codexAuthPath=join(dataDir,'absent-login.json');
 await assert.rejects(app.command({type:'settings.save',patch:{model:{authSource:'codex-login',baseUrl:'https://untrusted.example/v1'}}}),/fixed official/);
 await assert.rejects(app.command({type:'settings.save',patch:{model:{authSource:'codex-login',apiKey:'x'}}}),/do not enter/);
 await assert.rejects(app.command({type:'settings.save',patch:{model:{expiresAt:Date.now()+1000}}}));
 await app.command({type:'settings.save',patch:{model:{authSource:'codex-login',modelId:'gpt-6-astra'}}});await assert.rejects(app.command(create(project)),/cache is unavailable/);assert.equal(app.store.list().length,0);
});
test('the Codex access-token expiry bounds an active Run without refreshing the login cache',async t=>{
 const fixture=new FixtureRunner();const runner:Runner={async run(r,c,signal){if(r.purpose==='planning')return fixture.run(r,c,signal);await new Promise<void>(resolve=>{if(signal.aborted)resolve();else signal.addEventListener('abort',()=>resolve(),{once:true});});return {summary:'aborted at expiry',turns:1,aborted:true};}};
 const {app,project,dataDir}=await setup(t,runner),cache=join(dataDir,'short-login.json');loginCache(cache,loginToken('short',Math.floor(Date.now()/1000)+2));const before=readFileSync(cache,'utf8');(app as any).options.codexAuthPath=cache;await app.command({type:'settings.save',patch:{model:{authSource:'codex-login',modelId:'gpt-6-astra'}}});
 const created=await app.command(create(project,{executionPolicy:'autoWithinGrant',maxRunMs:10000})) as TaskSnapshot;const stopped=await until(app,created.task.id,s=>s.task.status==='blocked');assert.match(stopped.task.error!,/Codex login has expired/);assert.equal(stopped.task.acceptedDigest,undefined);assert.equal(stopped.actions.length,0);assert.equal(readFileSync(cache,'utf8'),before);
});
