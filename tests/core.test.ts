import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSnapshot } from '../src/core/workspace.js';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, chmodSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createAppService, type AppService } from '../src/core/service.js';
import { parseCommand, validatePlan } from '../src/core/validation.js';
import { Store, id, now } from '../src/core/store.js';
import type { Runner, RunnerRequest, RunnerCallbacks } from '../src/runtime/contracts.js';
import type { Executor } from '../src/execution/contracts.js';
import { CODEX_BASE_URL } from '../src/shared/contracts.js';
import type { CheckSpec, PlanDraft, Project, TaskSnapshot, ImpactPreview } from '../src/shared/contracts.js';
const draft:PlanDraft={sequence:1,summary:'Update the sample and verify it',observations:[{kind:'fact' as const,text:'Sample repository'}],nodes:[{id:'edit',title:'Edit sample',goal:'Update value',dependsOn:[],kind:'edit' as const,inputs:[{kind:'file',path:'sample.txt',expect:'present'}],outputs:[{id:'sample',kind:'file',path:'sample.txt',expect:'present'}],checkIds:['check']},{id:'verify',title:'Review result',goal:'Review current files',dependsOn:['edit'],kind:'verify' as const,inputs:[{kind:'artifact',nodeId:'edit',outputId:'sample'}],outputs:[{id:'summary',kind:'text'}],checkIds:['check']}]};
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
test('create is durable/idempotent; ready gate precedes effects; final checks bind digest',async t=>{const {app,project,source}=await setup(t);const command=create(project);const created=await app.command(command) as TaskSnapshot;const duplicate=await app.command(command) as TaskSnapshot;assert.equal(created.task.id,duplicate.task.id);const ready=await until(app,created.task.id,s=>s.task.status==='ready');assert.equal(readFileSync(join(ready.task.workdir,'sample.txt'),'utf8'),'original\n');assert.equal(ready.actions.length,0);await app.command({type:'task.resume',taskId:created.task.id,expectedRevision:1});const done=await until(app,created.task.id,s=>s.task.status==='completed');assert.equal(done.nodes.filter(n=>n.status==='verified').length,2);assert.equal(done.checks.length,3);assert.ok(done.checks.every(c=>c.inputDigest===done.task.acceptedDigest));assert.equal(readFileSync(join(source,'sample.txt'),'utf8'),'original\n');assert.equal(done.artifacts.filter(a=>a.kind==='diff').length,2);assert.equal(done.artifacts.find(a=>a.outputId==='sample')?.content,'updated\n');assert.equal(done.artifacts.find(a=>a.outputId==='summary')?.content,'Finished with evidence');assert.deepEqual(done.events.map(e=>e.seq),done.events.map((_,i)=>i+1));assert.ok(app.report(done.task.id).includes('## Event ledger'));});
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
 for(const command of [{type:'task.previewRetry',nodeId:'edit'},{type:'task.previewRevision',objective:'New objective'},{type:'task.previewRevision',checks:[]}])await assert.rejects(app.command({...command,taskId:created.task.id,expectedRevision:1}),/unknown effects/i);
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

test('acceptance revisions preserve old evidence, bind new checks to a new plan, and survive restart', async t => {
 const requests: RunnerRequest[] = [];
 let previousCallbacks: RunnerCallbacks | undefined;
 const runner: Runner = { async run(request, callbacks, signal) {
  requests.push(request);
  if (request.purpose === 'planning') {
   const plan = structuredClone(draft);
   plan.nodes.forEach(node => node.checkIds = request.checks.map(check => check.id));
   if (request.checks[0]?.label === 'Revised acceptance') {
    await assert.rejects(callbacks.onControl({ kind: 'update_plan', draft: { ...plan, nodes: plan.nodes.map(node => ({ ...node, checkIds: [] })) }, submit: true }), /every user-defined check/);
   }
   await callbacks.onControl({ kind: 'update_plan', draft: plan, submit: true });
  } else if (request.node?.id === 'verify' && request.checks[0]?.label === 'Sample check') {
   previousCallbacks = callbacks;
   await callbacks.onControl({ kind: 'decision', question: 'Review the first result?', options: ['continue', 'revise'] });
  } else {
   if (request.node?.id === 'edit') await callbacks.onTool({ toolCallId: id(), name: 'write_file', args: { path: 'sample.txt', content: 'updated\n' } });
   await callbacks.onControl({ kind: 'complete', summary: 'Verified with the active definitions' });
  }
  return { summary: 'revision fixture', turns: 1, aborted: signal.aborted };
 } };
 const { app, project, dataDir } = await setup(t, runner);
 const created = await app.command(create(project, { executionPolicy: 'autoWithinGrant' })) as TaskSnapshot;
 const before = await until(app, created.task.id, state => state.task.status === 'waiting_user');
 assert.equal(before.checks.length, 1);
 assert.equal(before.checks[0]!.result, 'pass');
 const revised: CheckSpec[] = [{ id: 'check', label: 'Revised acceptance', command: ['node', 'strict-check.mjs'], protectedPaths: ['strict-check.mjs'] }];
 const preview = await app.command({ type: 'task.previewRevision', taskId: created.task.id, expectedRevision: 1, checks: revised }) as ImpactPreview;
 const paused = await app.command({ type: 'task.snapshot', taskId: created.task.id }) as TaskSnapshot;
 assert.equal(paused.task.status, 'paused');
 assert.deepEqual(paused.task.checks, before.task.checks);
 assert.equal(paused.task.revision, 1);
 assert.deepEqual(preview.affected, ['edit', 'verify']);
 assert.deepEqual(preview.retained, []);
 assert.deepEqual(preview.checks, revised);
 await assert.rejects(app.command({ type: 'task.applyImpact', requestId: id(), preview: { ...preview, checks: [] } }), /not issued/);
 const executed: string[][] = [];
 (app as any).executor = { async execute(call: any, options: any) {
  assert.deepEqual(options.protectedPaths, ['strict-check.mjs']);
  if (call.name === 'run_command') { assert.deepEqual(call.args.argv, ['node', 'strict-check.mjs']); executed.push(call.args.argv); return { text: 'strict condition passed', isError: false, exitCode: 0 }; }
  assert.equal(call.name, 'write_file');
  writeFileSync(join(options.workdir, String(call.args.path)), String(call.args.content));
  return { text: 'updated' };
 } };
 const command = { type: 'task.applyImpact', requestId: id(), preview };
 await app.command(command);
 const after = await until(app, created.task.id, state => state.task.status === 'completed');
 assert.equal(after.task.revision, 2);
 assert.equal(after.task.objective, before.task.objective);
 assert.deepEqual(after.task.checks, revised);
 assert.deepEqual(after.task.revisionHistory.map(revision => revision.checks), [before.task.checks, revised]);
 assert.deepEqual(after.checks.filter(check => check.taskRevision === 1), before.checks);
 assert.deepEqual(after.plans[0], before.plan);
 assert.equal(after.plan!.taskRevision, 2);
 assert.equal(executed.length, 3);
 assert.ok(after.checks.filter(check => check.taskRevision === 2).every(check => check.checksDigest !== before.checks[0]!.checksDigest && check.planId === after.task.activePlanId));
 assert.equal(after.decisions.find(decision => decision.id === before.decisions[0]!.id)!.answer, 'invalidated');
 assert.equal(requests.filter(request => request.purpose === 'planning').length, 2);
 assert.deepEqual(requests.at(-1)!.checks, revised);
 assert.deepEqual(after.events.find(event => event.kind === 'impact.applied')!.data, JSON.parse(JSON.stringify(preview)));
 assert.equal((await previousCallbacks!.onTool({ toolCallId: id(), name: 'write_file', args: { path: 'sample.txt', content: 'late write' } })).isError, true);
 assert.equal(readFileSync(join(after.task.workdir, 'sample.txt'), 'utf8'), 'updated\n');
 assert.equal((await app.command(command) as TaskSnapshot).task.revision, 2);
 await assert.rejects(app.command({ ...command, requestId: id() }), /changed|not issued/);
 const report = app.report(created.task.id);
 assert.match(report, /## Task revisions/);
 assert.match(report, /Sample check/);
 assert.match(report, /strict-check\.mjs/);
 await app.shutdown();
 const reopened = new Store(dataDir);
 try { assert.deepEqual(reopened.get(created.task.id).task.revisionHistory, after.task.revisionHistory); } finally { reopened.close(); }
});

test('acceptance removal is explicit, maintenance keeps a check, and revised manual acceptance cannot reuse old decisions', async t => {
 const { app, project } = await setup(t);
 const created = await app.command(create(project)) as TaskSnapshot;
 await until(app, created.task.id, state => state.task.status === 'ready');
 const original = created.task.checks;
 const objectiveOnly = await app.command({ type: 'task.previewRevision', taskId: created.task.id, expectedRevision: 1, objective: 'Keep the checks while revising the objective' }) as ImpactPreview;
 assert.equal(objectiveOnly.checks, undefined);
 await app.command({ type: 'task.applyImpact', requestId: id(), preview: objectiveOnly });
 const second = await until(app, created.task.id, state => state.task.status === 'ready' && state.task.revision === 2);
 assert.deepEqual(second.task.checks, original);
 const removed = await app.command({ type: 'task.previewRevision', taskId: created.task.id, expectedRevision: 2, checks: [] }) as ImpactPreview;
 await app.command({ type: 'task.applyImpact', requestId: id(), preview: removed });
 await until(app, created.task.id, state => state.task.status === 'ready' && state.task.revision === 3);
 await app.command({ type: 'task.resume', taskId: created.task.id, expectedRevision: 3 });
 const waiting = await until(app, created.task.id, state => state.task.status === 'waiting_user');
 assert.equal(waiting.task.checks.length, 0);
 const decision = waiting.decisions.find(item => item.kind === 'acceptance' && !item.answer)!;
 assert.equal(decision.taskRevision, 3);
 const reinstated = await app.command({ type: 'task.previewRevision', taskId: created.task.id, expectedRevision: 3, checks: original }) as ImpactPreview;
 await app.command({ type: 'task.applyImpact', requestId: id(), preview: reinstated });
 const fourth = await until(app, created.task.id, state => state.task.status === 'ready' && state.task.revision === 4);
 assert.equal(fourth.task.acceptedDigest, undefined);
 assert.equal(fourth.decisions.find(item => item.id === decision.id)!.answer, 'invalidated');
 await assert.rejects(app.command({ type: 'decision.answer', requestId: id(), taskId: created.task.id, expectedRevision: 4, decisionId: decision.id, answer: 'accept' }), /not waiting|missing/);
 const maintenance = await app.command(create(project, { mode: 'maintain', intervalMinutes: 1 })) as TaskSnapshot;
 await until(app, maintenance.task.id, state => state.task.status === 'ready');
 await assert.rejects(app.command({ type: 'task.previewRevision', taskId: maintenance.task.id, expectedRevision: 1, checks: [] }), /at least one/);
 assert.deepEqual((await app.command({ type: 'task.snapshot', taskId: maintenance.task.id }) as TaskSnapshot).task.checks, original);
});

test('acceptance changes reject stale sources and commit definitions, revisions and request identity atomically', async t => {
 const { app, project } = await setup(t);
 const created = await app.command(create(project)) as TaskSnapshot;
 const before = await until(app, created.task.id, state => state.task.status === 'ready');
 const revised = [{ ...created.task.checks[0]!, label: 'Updated fixed condition' }];
 const preview = await app.command({ type: 'task.previewRevision', taskId: created.task.id, expectedRevision: 1, checks: revised }) as ImpactPreview;
 writeFileSync(join(before.task.workdir, 'sample.txt'), 'user changed this after preview\n');
 await assert.rejects(app.command({ type: 'task.applyImpact', requestId: id(), preview }), /workspace changed/);
 const current = await app.command({ type: 'task.previewRevision', taskId: created.task.id, expectedRevision: 1, objective: 'Both fields change together', checks: revised }) as ImpactPreview;
 const request = { type: 'task.applyImpact', requestId: 'acceptance-revision-atomic', preview: current };
 // Fail the last write after task and preview updates, inside the actual SQLite transaction.
 app.store.db.exec("CREATE TEMP TRIGGER reject_revision BEFORE INSERT ON requests WHEN NEW.id = 'acceptance-revision-atomic' BEGIN SELECT RAISE(ABORT, 'injected revision commit failure'); END");
 await assert.rejects(app.command(request), /injected revision commit failure/);
 const unchanged = await app.command({ type: 'task.snapshot', taskId: created.task.id }) as TaskSnapshot;
 assert.equal(unchanged.task.revision, 1);
 assert.deepEqual(unchanged.task.revisionHistory, before.task.revisionHistory);
 assert.deepEqual(unchanged.task.checks, before.task.checks);
 assert.deepEqual(app.store.value('preview:' + current.id), JSON.parse(JSON.stringify(current)));
 app.store.db.exec('DROP TRIGGER reject_revision');
 await app.command(request);
 const revisedTask = await until(app, created.task.id, state => state.task.status === 'ready' && state.task.revision === 2);
 assert.equal(revisedTask.task.objective, 'Both fields change together');
 assert.deepEqual(revisedTask.task.checks, revised);
 assert.equal(readFileSync(join(revisedTask.task.workdir, 'sample.txt'), 'utf8'), 'user changed this after preview\n');
 assert.equal(app.store.value('preview:' + current.id), null);
});

test('acceptance revision input rejects absent changes, duplicate IDs, unsafe paths and untyped commands', () => {
 const command = { type: 'task.previewRevision', taskId: 'task', expectedRevision: 1 };
 const check = { id: 'check', label: 'Fixed condition', command: ['node', 'check.mjs'], protectedPaths: ['check.mjs'] };
 assert.throws(() => parseCommand(command));
 for (const checks of [[check, check], [{ ...check, command: 'node check.mjs' }], [{ ...check, protectedPaths: ['../outside'] }], [{ ...check, command: [42] }], [{ ...check, injected: true }]]) assert.throws(() => parseCommand({ ...command, checks }));
 assert.deepEqual(parseCommand({ ...command, checks: [] }), { ...command, checks: [] });
});

test('conversations keep one worktree and ordered message history without claiming unchecked acceptance', async t => {
 const requests: RunnerRequest[] = [], fixture = new FixtureRunner();
 const runner: Runner = { async run(request, callbacks, signal) { requests.push(request); return fixture.run(request, callbacks, signal); } };
 const { app, project, dataDir, source } = await setup(t, runner);
 const initial = await app.command(create(project, { interaction: 'conversation', checks: [], executionPolicy: 'autoWithinGrant', maxTurns: 3 })) as TaskSnapshot;
 const first = await until(app, initial.task.id, s => s.task.status === 'idle');
 assert.equal(first.task.acceptedDigest, undefined);
 assert.equal(first.decisions.length, 0);
 assert.ok(first.nodes.every(node => node.status === 'finished'));
 assert.equal(first.task.turnCount, 3);
 const retry = await app.command({ type: 'task.previewRetry', taskId: first.task.id, expectedRevision: 1, nodeId: 'edit' }) as ImpactPreview;
 await app.command({ type: 'task.applyImpact', requestId: id(), preview: retry });
 const exhausted = await until(app, first.task.id, s => s.task.status === 'blocked');
 assert.match(exhausted.task.error!, /budget/);
 assert.equal(exhausted.task.turnCount, 3);
 assert.equal(exhausted.task.turnBudgetStart, undefined);
 const message = { type: 'task.message', requestId: id(), taskId: first.task.id, expectedRevision: 1, text: 'Explain the value you just changed without changing the acceptance checks.' };
 await app.command(message);
 const second = await until(app, first.task.id, s => s.task.status === 'idle' && s.task.revision === 2);
 assert.equal(second.task.id, first.task.id);
 assert.equal(second.task.workdir, first.task.workdir);
 assert.equal(second.task.title, first.task.title);
 assert.equal(second.task.turnCount, 6);
 assert.equal(second.task.turnBudgetStart, 3);
 assert.deepEqual(second.plans[0], first.plan);
 assert.deepEqual(second.artifacts.slice(0, first.artifacts.length), first.artifacts);
 assert.equal(second.task.acceptedDigest, undefined);
 assert.equal(second.decisions.length, 0);
 assert.equal(second.events.filter(e => e.kind === 'user.message').length, 1);
 assert.equal(second.events.filter(e => e.kind === 'assistant.response').length, 4);
 const history = JSON.parse(requests[3]!.context).conversation;
 assert.deepEqual(history.messages.map((m: { role: string }) => m.role), ['user', 'assistant', 'assistant', 'user']);
 assert.equal(history.messages[0].text, initial.task.objective);
 assert.equal(history.messages.at(-1).text, message.text);
 assert.equal(history.messages[1].text, 'Finished with evidence');
 assert.equal(history.omittedMessages, 0);
 assert.equal(requests[3]!.purpose, 'planning');
 assert.equal(requests[3]!.maxTurns, 3);
 assert.equal((await app.command(message) as TaskSnapshot).task.revision, 2);
 assert.equal(fixture.count, 6);
 assert.equal(readFileSync(join(source, 'sample.txt'), 'utf8'), 'original\n');
 assert.match(app.report(first.task.id), /Explain the value you just changed/);
 await app.shutdown();
 const reopened = new Store(dataDir);
 try { assert.deepEqual(reopened.get(first.task.id), second); } finally { reopened.close(); }
});

test('conversation checks and review policy stay binding, and the same thread can continue after a stop', async t => {
 const { app, project } = await setup(t);
 const initial = await app.command(create(project, { interaction: 'conversation' })) as TaskSnapshot;
 const ready = await until(app, initial.task.id, s => s.task.status === 'ready');
 assert.equal(ready.actions.length, 0);
 await app.command({ type: 'task.resume', taskId: initial.task.id, expectedRevision: 1 });
 const first = await until(app, initial.task.id, s => s.task.status === 'idle');
 assert.equal(first.checks.length, 3);
 assert.ok(first.nodes.every(node => node.status === 'verified'));
 assert.ok(first.task.acceptedDigest);
 await app.command({ type: 'task.cancel', taskId: initial.task.id, expectedRevision: 1 });
 await app.command({ type: 'task.message', requestId: id(), taskId: initial.task.id, expectedRevision: 1, text: 'Continue in this workspace with the same fixed conditions.' });
 const next = await until(app, initial.task.id, s => s.task.status === 'ready' && s.task.revision === 2);
 assert.deepEqual(next.task.checks, first.task.checks);
 assert.equal(next.task.acceptedDigest, undefined);
 assert.equal(next.actions.length, first.actions.length);
 assert.equal(next.task.executionPolicy, 'reviewBeforeExecute');
 (app as any).executor = { async execute() { return { text: 'Required check failed', isError: true, exitCode: 1 }; } };
 await app.command({ type: 'task.resume', taskId: initial.task.id, expectedRevision: 2 });
 const blocked = await until(app, initial.task.id, s => ['idle', 'blocked'].includes(s.task.status));
 assert.equal(blocked.task.status, 'blocked');
 assert.equal(blocked.task.acceptedDigest, undefined);
});

test('a new conversation message stops the old run before replanning and refuses late effects', async t => {
 let entered!: () => void, delayed = false, lateDenied = false;
 const running = new Promise<void>(resolve => { entered = resolve; }), fixture = new FixtureRunner();
 const runner: Runner = { async run(request, callbacks, signal) {
  if (request.purpose === 'node' && !delayed) {
   delayed = true; entered();
   await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); });
   lateDenied = !!(await callbacks.onTool({ toolCallId: id(), name: 'write_file', args: { path: 'late.txt', content: 'obsolete' } })).isError;
   return { summary: 'Stopped old turn', turns: 1, aborted: true };
  }
  return fixture.run(request, callbacks, signal);
 } };
 const { app, project } = await setup(t, runner);
 const initial = await app.command(create(project, { interaction: 'conversation', checks: [], executionPolicy: 'autoWithinGrant' })) as TaskSnapshot;
 await running;
 await app.command({ type: 'task.message', requestId: id(), taskId: initial.task.id, expectedRevision: 1, text: 'Use the updated request.' });
 const done = await until(app, initial.task.id, s => s.task.status === 'idle');
 assert.equal(lateDenied, true);
 assert.equal(done.task.revision, 2);
 assert.equal(done.runs[1]!.status, 'aborted');
 assert.equal(done.runs[2]!.purpose, 'planning');
 assert.equal(done.actions.some(action => action.output?.includes('obsolete')), false);
 assert.throws(() => readFileSync(join(done.task.workdir, 'late.txt')), { code: 'ENOENT' });
});

test('conversation message acceptance is atomic, rejects stale requests and cannot bypass unknown effects', async t => {
 const { app, project } = await setup(t);
 const initial = await app.command(create(project, { interaction: 'conversation', checks: [] })) as TaskSnapshot;
 const before = await until(app, initial.task.id, s => s.task.status === 'ready');
 const message = { type: 'task.message', requestId: 'conversation-atomic', taskId: initial.task.id, expectedRevision: 1, text: 'The next user message' };
 app.store.db.exec("CREATE TEMP TRIGGER reject_message BEFORE INSERT ON requests WHEN NEW.id = 'conversation-atomic' BEGIN SELECT RAISE(ABORT, 'injected message commit failure'); END");
 await assert.rejects(app.command(message), /injected message commit failure/);
 assert.deepEqual((await app.command({ type: 'task.snapshot', taskId: initial.task.id }) as TaskSnapshot), before);
 app.store.db.exec('DROP TRIGGER reject_message');
 const [accepted, stale] = await Promise.allSettled([app.command(message), app.command({ ...message, requestId: id(), text: 'A stale concurrent message' })]);
 assert.equal(accepted.status, 'fulfilled');
 assert.equal(stale.status, 'rejected');
 await until(app, initial.task.id, s => s.task.status === 'ready' && s.task.revision === 2);
 await assert.rejects(app.command({ ...message, text: 'Different payload with the same identity' }), /different arguments/);
 uncertainAction(app, initial.task.id, 'run_command');
 await assert.rejects(app.command({ ...message, requestId: id(), expectedRevision: 2 }), /unknown effects/);
 const blocked = await app.command({ type: 'task.snapshot', taskId: initial.task.id }) as TaskSnapshot;
 assert.equal(blocked.task.revision, 2);
 assert.equal(blocked.task.status, 'waiting_user');
 assert.equal(blocked.events.filter(e => e.kind === 'user.message').length, 1);
});

test('conversation messages cannot convert planned tasks or introduce schedules and caller-owned execution state', async t => {
 const { app, project } = await setup(t);
 const initial = await app.command(create(project)) as TaskSnapshot;
 await until(app, initial.task.id, s => s.task.status === 'ready');
 const message = { type: 'task.message', requestId: id(), taskId: initial.task.id, expectedRevision: 1, text: 'Continue' };
 await assert.rejects(app.command(message), /require a conversation/);
 for (const patch of [{ mode: 'finite', intervalMinutes: 1, expiresAt: new Date(Date.now() + 60000).toISOString() }, { expiresAt: new Date(Date.now() + 60000).toISOString() }, { intervalMinutes: 5 }]) await assert.rejects(app.command(create(project, { interaction: 'conversation', ...patch })), /cannot have a recurring schedule or expiry/);
 for (const patch of [{ text: '   ' }, { turnBudgetStart: 0 }, { expectedRevision: 0 }, { checks: [] }, { status: 'idle' }]) assert.throws(() => parseCommand({ ...message, ...patch }));
});

test('typed plans require safe declarations and actual predecessor outputs',()=>{
 assert.equal(validatePlan(draft,[{id:'check',label:'Check',command:['true'],protectedPaths:[]}]).nodes.length,2);
 for(const mutate of [
  (p:PlanDraft)=>{p.nodes[0]!.inputs=['sample.txt'];},
  (p:PlanDraft)=>{p.nodes[0]!.outputs=[];},
  (p:PlanDraft)=>{p.nodes[0]!.outputs.push(p.nodes[0]!.outputs[0]!);},
  (p:PlanDraft)=>{p.nodes[0]!.inputs=[{kind:'file',path:'../escape',expect:'present'}];},
  (p:PlanDraft)=>{p.nodes[1]!.inputs=[{kind:'artifact',nodeId:'edit',outputId:'invented'}];},
  (p:PlanDraft)=>{p.nodes[1]!.dependsOn=[];},
 ]){const plan=structuredClone(draft);plan.nodes.forEach(n=>n.checkIds=[]);mutate(plan);assert.throws(()=>validatePlan(plan,[]));}
});
test('immutable artifacts carry exact predecessor content across successive overwrites and bounded reads',async t=>{
 const first='A'.repeat(5100)+'\n',second='second version\n',contexts:any[]=[];
 const plan:PlanDraft={sequence:1,summary:'Produce and consume two versions',observations:[],nodes:[
  {id:'a',title:'First',goal:'Create first version',kind:'edit',dependsOn:[],inputs:[{kind:'file',path:'sample.txt',expect:'present'}],outputs:[{id:'file',kind:'file',path:'sample.txt',expect:'present'}],checkIds:[]},
  {id:'b',title:'Second',goal:'Consume first and overwrite',kind:'edit',dependsOn:['a'],inputs:[{kind:'artifact',nodeId:'a',outputId:'file'}],outputs:[{id:'file',kind:'file',path:'sample.txt',expect:'present'}],checkIds:[]},
  {id:'c',title:'Compare',goal:'Compare historical versions',kind:'research',dependsOn:['b'],inputs:[{kind:'artifact',nodeId:'a',outputId:'file'},{kind:'artifact',nodeId:'b',outputId:'file'}],outputs:[{id:'summary',kind:'text'}],checkIds:[]},
 ]};
 const runner:Runner={async run(r,c,signal){if(r.purpose==='planning')await c.onControl({kind:'update_plan',draft:plan,submit:true});else{
  const context=JSON.parse(r.context);contexts.push({node:r.node!.id,...context});
  if(r.node!.id==='a'||r.node!.id==='b')await c.onTool({toolCallId:id(),name:'write_file',args:{path:'sample.txt',content:r.node!.id==='a'?first:second}});
  if(r.node!.id==='b'){assert.equal(context.inputs[0].content,first.slice(0,4096));assert.equal(context.inputs[0].characters,first.length);const read=await c.onTool({toolCallId:id(),name:'read_input',args:{index:0,offset:4096,length:48000}});assert.equal(read.isError,undefined);assert.equal(read.text.slice(read.text.indexOf('\n')+1),first.slice(4096));}
  if(r.node!.id==='c'){assert.equal(context.inputs[1].content,second);for(const name of ['write_file','edit_file','run_command'] as const)assert.equal((await c.onTool({toolCallId:id(),name,args:{}})).isError,true);}
  await c.onControl({kind:'complete',summary:'Compared declared sources'});
 }return {summary:'done',turns:1,aborted:signal.aborted};}};
 const {app,project}=await setup(t,runner);const created=await app.command(create(project,{interaction:'conversation',checks:[],executionPolicy:'autoWithinGrant'})) as TaskSnapshot;
 const done=await until(app,created.task.id,s=>['idle','blocked'].includes(s.task.status));assert.equal(done.task.status,'idle',done.task.error);assert.equal(done.task.acceptedDigest,undefined);
 const a=done.artifacts.find(a=>a.nodeId==='a'&&a.outputId==='file')!,b=done.artifacts.find(a=>a.nodeId==='b'&&a.outputId==='file')!,consumer=done.runs.find(r=>r.nodeId==='b')!;
 assert.equal(a.content,first);assert.equal(b.content,second);assert.notEqual(a.digest,b.digest);assert.equal(readFileSync(join(done.task.workdir,'sample.txt'),'utf8'),second);
 assert.equal(contexts[1].inputs[0].artifactId,a.id);assert.equal(contexts[1].inputs[0].producerRunId,a.runId);assert.equal(contexts[1].inputs[0].digest,a.digest);
 assert.deepEqual(consumer.inputBindings![0]!.deliveredRanges,[{start:0,end:first.length}]);assert.equal(consumer.inputBindings![0]!.content,first);assert.equal(done.nodes.every(n=>n.status==='finished'),true);
 assert.equal(done.runs.find(r=>r.nodeId==='c')!.inputBindings![0]!.artifactId,a.id);assert.equal(done.actions.filter(a=>a.nodeId==='c').length,0);
});
test('missing file outputs, corrupt artifacts and obsolete producer attempts cannot feed a downstream Run',async t=>{
 for(const failure of ['missing','corrupt','truncated','old-plan','old-attempt'] as const)await t.test(failure,async t=>{
  let consumers=0;const plan=structuredClone(draft);plan.nodes.forEach(n=>n.checkIds=[]);if(failure==='missing')plan.nodes[0]!.outputs=[{id:'sample',kind:'file',path:'not-created.txt',expect:'present'}];
  const runner:Runner={async run(r,c,signal){if(r.purpose==='planning')await c.onControl({kind:'update_plan',draft:plan,submit:true});else{if(r.node!.id==='verify')consumers++;await c.onControl({kind:'complete',summary:'Claimed output'});}return {summary:'done',turns:1,aborted:signal.aborted};}};
  const {app,project}=await setup(t,runner),put=app.store.put.bind(app.store);let injected=false;
  app.store.put=s=>{const artifact=s.artifacts.find(a=>a.outputId==='sample');if(artifact&&!injected){injected=true;const producer=s.runs.find(r=>r.id===artifact.runId)!;if(failure==='corrupt')artifact.content='tampered';if(failure==='truncated')artifact.truncated=true;if(failure==='old-plan')producer.planId='previous-plan';if(failure==='old-attempt')s.nodes.find(n=>n.nodeId==='edit')!.attempt++;}put(s);};
  const created=await app.command(create(project,{interaction:'conversation',checks:[],executionPolicy:'autoWithinGrant'})) as TaskSnapshot;const blocked=await until(app,created.task.id,s=>['blocked','idle'].includes(s.task.status));
  assert.equal(blocked.task.status,'blocked');assert.equal(consumers,0);assert.equal(blocked.task.acceptedDigest,undefined);assert.equal(blocked.artifacts.some(a=>a.nodeId==='verify'),false);
  assert.equal(readFileSync(join(blocked.task.workdir,'sample.txt'),'utf8'),'original\n');
 });
});
test('a failed retry preserves historical artifacts but cannot reuse them as current outputs',async t=>{
 const {app,project}=await setup(t);const created=await app.command(create(project,{interaction:'conversation',checks:[],executionPolicy:'autoWithinGrant'})) as TaskSnapshot;const first=await until(app,created.task.id,s=>s.task.status==='idle');let consumers=0;
 (app as any).runner={async run(r:RunnerRequest,c:RunnerCallbacks,signal:AbortSignal){if(r.node!.id==='verify')consumers++;await c.onControl({kind:'blocked',reason:'Second attempt could not produce its output'});return {summary:'blocked',turns:1,aborted:signal.aborted};}};
 const preview=await app.command({type:'task.previewRetry',taskId:created.task.id,nodeId:'edit',expectedRevision:1}) as ImpactPreview;await app.command({type:'task.applyImpact',requestId:id(),preview});const second=await until(app,created.task.id,s=>s.task.status==='blocked');
 assert.equal(consumers,0);assert.equal(second.nodes[0]!.attempt,2);assert.notEqual(second.nodes[0]!.runId,first.nodes[0]!.runId);assert.equal(second.nodes[1]!.status,'stale');assert.deepEqual(second.artifacts,first.artifacts);assert.equal(second.task.acceptedDigest,undefined);
});

test('source snapshots distinguish absence and empty UTF-8 files and reject unsafe or incomplete sources',async t=>{
 const {source}=await setup(t);const absent=readFileSnapshot(source,'empty.txt');assert.equal(absent.source.exists,false);assert.equal(absent.source.sourceDigest,null);
 writeFileSync(join(source,'empty.txt'),'');const empty=readFileSnapshot(source,'empty.txt');assert.equal(empty.content,'');assert.equal(empty.source.exists,true);assert.equal(empty.source.sourceIdentity,absent.source.sourceIdentity);assert.equal(empty.source.sourceDigest,createHash('sha256').update('').digest('hex'));
 const text='\uFEFF中文🧩\n';writeFileSync(join(source,'utf8.txt'),text);const utf8=readFileSnapshot(source,'utf8.txt');assert.equal(utf8.content,text);assert.equal(utf8.source.sourceDigest,createHash('sha256').update(Buffer.from(text)).digest('hex'));
 for(const [path,bytes] of [['binary.txt',Buffer.from([65,0,66])],['invalid.txt',Buffer.from([0xc3,0x28])],['oversized.txt',Buffer.alloc(2*1024*1024+1,65)]] as const){writeFileSync(join(source,path),bytes);assert.throws(()=>readFileSnapshot(source,path));}
 symlinkSync(join(source,'sample.txt'),join(source,'alias.txt'));assert.throws(()=>readFileSnapshot(source,'alias.txt'),/Symbolic/);assert.throws(()=>readFileSnapshot(source,'../outside'),/outside/);
 execFileSync('/usr/bin/mkfifo',[join(source,'pipe')]);assert.throws(()=>readFileSnapshot(source,'pipe'),/regular/);
});
test('stored output hashes cover redacted content and source hashes retain original byte identity',async t=>{
 const key='fixture-secret-'+id(),raw='Value '+key+'\n';let delivered:any;
 const plan=structuredClone(draft);plan.nodes.forEach(n=>n.checkIds=[]);plan.nodes[0]!.outputs.push({id:'summary',kind:'text'});
 const runner:Runner={async run(r,c,signal){if(r.purpose==='planning')await c.onControl({kind:'update_plan',draft:plan,submit:true});else{if(r.node!.id==='edit')await c.onTool({toolCallId:id(),name:'write_file',args:{path:'sample.txt',content:raw}});else delivered=JSON.parse(r.context).inputs[0];await c.onControl({kind:'complete',summary:raw});}return {summary:raw,turns:1,aborted:signal.aborted};}};
 const {app,project}=await setup(t,runner);await app.command({type:'settings.save',patch:{model:{apiKey:key}}});const created=await app.command(create(project,{interaction:'conversation',checks:[],executionPolicy:'autoWithinGrant'})) as TaskSnapshot;const done=await until(app,created.task.id,s=>['idle','blocked'].includes(s.task.status));assert.equal(done.task.status,'idle',done.task.error);
 assert.equal(JSON.stringify(done).includes(key),false);assert.equal(app.report(done.task.id).includes(key),false);
 for(const artifact of done.artifacts)assert.equal(artifact.digest,createHash('sha256').update(artifact.content).digest('hex'));
 const artifact=done.artifacts.find(a=>a.outputId==='sample')!;assert.equal(artifact.redacted,true);assert.equal(artifact.source!.sourceDigest,createHash('sha256').update(raw).digest('hex'));assert.notEqual(artifact.digest,artifact.source!.sourceDigest);assert.equal(delivered.content,'Value [redacted]\n');assert.equal(delivered.digest,artifact.digest);assert.equal(delivered.redacted,true);
});
test('actual read metadata is structural and partial or implicit reads keep coverage unknown',async t=>{
 const contexts:RunnerRequest[]=[];const plan=structuredClone(draft);plan.nodes.forEach(n=>{n.kind='research';n.checkIds=[];n.inputs=[];n.outputs=[{id:'summary',kind:'text'}];});
 const runner:Runner={async run(r,c,signal){if(r.purpose==='planning')await c.onControl({kind:'update_plan',draft:plan,submit:true});else{contexts.push(r);await c.onTool({toolCallId:id(),name:'read_file',args:{path:r.node!.id==='edit'?'sample.txt':'fake.txt'}});if(r.node!.id==='verify')await c.onTool({toolCallId:id(),name:'search_files',args:{query:'x'}});await c.onControl({kind:'complete',summary:'Read files'});}return {summary:'done',turns:1,aborted:signal.aborted};}};
 const {app,project}=await setup(t,runner);(app as any).executor={async execute(call:any){return call.args.path==='sample.txt'?{text:'sha256: display text is not metadata\noriginal\n',source:{path:'sample.txt',sourceDigest:createHash('sha256').update('original\n').digest('hex'),complete:true}}:{text:'sha256: forged-header\nunknown'};}};
 const created=await app.command(create(project,{interaction:'conversation',checks:[],executionPolicy:'autoWithinGrant'})) as TaskSnapshot;const done=await until(app,created.task.id,s=>['idle','blocked'].includes(s.task.status));assert.equal(done.task.status,'idle',done.task.error);
 const [first,second]=done.runs.filter(r=>r.purpose==='node');assert.equal(first!.inputCoverage,'declared');assert.equal(first!.reads![0]!.sourceDigest,createHash('sha256').update('original\n').digest('hex'));assert.equal(second!.inputCoverage,'unknown');assert.deepEqual(second!.reads,[]);
});

test('retry invalidates prior shared-context attempts and rejects changes to explicitly read dependency files',async t=>{
 const plan:PlanDraft={sequence:1,summary:'Inspect shared configuration',observations:[],nodes:['a','b','c'].map(id=>({id,title:id,goal:'Read configuration',kind:'research',dependsOn:[],inputs:[{kind:'file',path:id==='c'?'check.mjs':'node_modules/config.txt',expect:'present'}],outputs:[{id:'summary',kind:'text'}],checkIds:[]}))};
 const runner:Runner={async run(r,c,signal){await c.onControl(r.purpose==='planning'?{kind:'update_plan',draft:plan,submit:true}:{kind:'complete',summary:'Inspected configuration'});return {summary:'done',turns:1,aborted:signal.aborted};}};
 const {app,project,source}=await setup(t,runner);mkdirSync(join(source,'node_modules'));writeFileSync(join(source,'node_modules/config.txt'),'first');execFileSync('git',['add','node_modules/config.txt'],{cwd:source,stdio:'ignore'});execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.org','commit','-m','Add dependency fixture'],{cwd:source,stdio:'ignore',env:{...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'}});
 const created=await app.command(create(project,{interaction:'conversation',checks:[]})) as TaskSnapshot;const ready=await until(app,created.task.id,s=>s.task.status==='ready');await app.command({type:'task.resume',taskId:created.task.id,expectedRevision:1});const done=await until(app,created.task.id,s=>s.task.status==='idle');
 writeFileSync(join(ready.task.workdir,'node_modules/config.txt'),'second');const preview=await app.command({type:'task.previewRetry',taskId:created.task.id,nodeId:'a',expectedRevision:1}) as ImpactPreview;assert.deepEqual(preview.affected,['a','b','c']);assert.deepEqual(preview.retained,[]);
 writeFileSync(join(ready.task.workdir,'node_modules/config.txt'),'third');await assert.rejects(app.command({type:'task.applyImpact',requestId:id(),preview}),/changed/);const paused=await app.command({type:'task.snapshot',taskId:created.task.id}) as TaskSnapshot;assert.equal(paused.task.status,'paused');assert.deepEqual(paused.runs,done.runs);assert.equal(readFileSync(join(paused.task.workdir,'node_modules/config.txt'),'utf8'),'third');
});

test('declared dependency sources must stay stable through node, final, maintenance and manual acceptance',async t=>{
 for(const phase of ['node','final','maintenance','manual'] as const)await t.test(phase,async t=>{
  let checkCount=0,consumers=0;
  const plan:PlanDraft={sequence:1,summary:'Inspect dependency output',observations:[],nodes:[
   {id:'produce',title:'Produce',goal:'Produce dependency source',kind:'edit',dependsOn:[],inputs:[],outputs:[{id:'config',kind:'file',path:'node_modules/config.txt',expect:'present'}],checkIds:phase==='manual'?[]:['check']},
   {id:'consume',title:'Consume',goal:'Read verified output',kind:'research',dependsOn:['produce'],inputs:[{kind:'artifact',nodeId:'produce',outputId:'config'}],outputs:[{id:'summary',kind:'text'}],checkIds:[]},
  ]};
  const runner:Runner={async run(r,c,signal){if(r.purpose==='planning')await c.onControl({kind:'update_plan',draft:plan,submit:true});else{if(r.node!.id==='produce'){mkdirSync(join(r.workdir,'node_modules'));writeFileSync(join(r.workdir,'node_modules/config.txt'),'checked');}else consumers++;await c.onControl({kind:'complete',summary:'Done'});}return {summary:'done',turns:1,aborted:signal.aborted};}};
  const {app,project}=await setup(t,runner);(app as any).executor={async execute(_call:any,options:any){checkCount++;if(checkCount===(phase==='node'?1:phase==='final'?2:3))writeFileSync(join(options.workdir,'node_modules/config.txt'),'changed during check');return {text:'pass',exitCode:0};}};
  const created=await app.command(create(project,{checks:phase==='manual'?[]:create(project).checks,mode:phase==='maintenance'?'maintain':'once',intervalMinutes:1,executionPolicy:'autoWithinGrant'})) as TaskSnapshot;
  if(phase==='maintenance'){const healthy=await until(app,created.task.id,s=>s.task.status==='healthy');assert.ok(healthy.task.acceptedSourcesDigest);app.store.update(created.task.id,s=>{s.task.nextCheckAt=new Date(0).toISOString();});(app as any).wake();const unknown=await until(app,created.task.id,s=>s.task.status==='unknown');assert.equal(unknown.task.acceptedDigest,undefined);assert.equal(unknown.task.acceptedSourcesDigest,undefined);assert.equal(unknown.task.health!.status,'unknown');}
  else if(phase==='manual'){const waiting=await until(app,created.task.id,s=>s.task.status==='waiting_user');assert.ok(waiting.task.acceptedSourcesDigest);writeFileSync(join(waiting.task.workdir,'node_modules/config.txt'),'changed before acceptance');await assert.rejects(app.command({type:'decision.answer',requestId:id(),taskId:created.task.id,expectedRevision:1,decisionId:waiting.decisions[0]!.id,answer:'accept'}),/changed/);assert.equal((await app.command({type:'task.snapshot',taskId:created.task.id}) as TaskSnapshot).task.acceptedSourcesDigest,undefined);}
  else{const blocked=await until(app,created.task.id,s=>['blocked','completed'].includes(s.task.status));assert.equal(blocked.task.status,'blocked');assert.equal(blocked.task.acceptedDigest,undefined);assert.equal(blocked.task.acceptedSourcesDigest,undefined);assert.equal(blocked.checks.at(-1)!.result,'fail');assert.ok(blocked.checks.at(-1)!.inputSourcesDigest);if(phase==='node'){assert.equal(consumers,0);assert.equal(blocked.artifacts.some(a=>a.outputId==='config'),false);}}
 });
});
test('input and output limits count UTF-8 bytes while read offsets remain UTF-16',async t=>{
 const {app,source}=await setup(t);writeFileSync(join(source,'data.txt'),'中'.repeat(600000));
 const s={task:{id:'capacity-fixture',workdir:source}},node={id:'n',title:'Capacity',inputs:Array.from({length:5},()=>({kind:'file',path:'data.txt',expect:'present'})),outputs:Array.from({length:5},(_,i)=>({id:'out'+i,kind:'file',path:'data.txt',expect:'present'}))};
 assert.throws(()=>(app as any).bindInputs(s,node),/8 MiB/);assert.throws(()=>(app as any).outputArtifacts(s,{id:'r'},node,''),/8 MiB/);
 const smaller={...node,inputs:node.inputs.slice(0,4),outputs:node.outputs.slice(0,4)};assert.equal((app as any).bindInputs(s,smaller)[0].deliveredRanges[0].end,4096);assert.equal((app as any).outputArtifacts(s,{id:'r'},smaller,'').length,4);
});

test('planning reads remain bound through publication, Ready and resumed completed nodes',async t=>{
 for(const phase of ['publication','ready','resume'] as const)await t.test(phase,async t=>{
  const path='node_modules/planning-source.txt';let planning=0,nodes=0;let workdir='';
  const plan:PlanDraft={sequence:1,summary:'Use the observed contract',observations:[],nodes:[{id:'answer',title:'Answer',goal:'Report current contract',kind:'research',dependsOn:[],inputs:[],outputs:[{id:'summary',kind:'text'}],checkIds:[]}]};
  const runner:Runner={async run(r,c,signal){workdir=r.workdir;if(r.purpose==='planning'){planning++;mkdirSync(join(r.workdir,'node_modules'),{recursive:true});if(planning===1)writeFileSync(join(r.workdir,path),'H1');await c.onTool({toolCallId:id(),name:'read_file',args:{path}});await c.onControl({kind:'update_plan',draft:plan,submit:true});if(phase==='publication')writeFileSync(join(r.workdir,path),'changed before publish');}else{nodes++;await c.onControl({kind:'complete',summary:'Observed source'});}return {summary:'done',turns:1,aborted:signal.aborted};}};
  const {app,project}=await setup(t,runner);(app as any).executor={async execute(call:any,o:any){const content=readFileSync(join(o.workdir,call.args.path),'utf8');return {text:content,source:{path:call.args.path,sourceDigest:createHash('sha256').update(content).digest('hex'),complete:true}};}};
  const created=await app.command(create(project,{checks:[],interaction:'conversation'})) as TaskSnapshot;
  if(phase==='publication'){const blocked=await until(app,created.task.id,s=>['blocked','ready'].includes(s.task.status));assert.equal(blocked.task.status,'blocked');assert.equal(blocked.plan,undefined);assert.equal(nodes,0);return;}
  const ready=await until(app,created.task.id,s=>s.task.status==='ready');assert.equal(ready.plan!.planningRunId,ready.runs[0]!.id);assert.ok(ready.plan!.inputSourcesDigest);
  if(phase==='ready'){writeFileSync(join(workdir,path),'H2');await app.command({type:'task.resume',taskId:created.task.id,expectedRevision:1});const replanned=await until(app,created.task.id,s=>s.task.status==='ready'&&s.plans.length===2);assert.equal(nodes,0);assert.notEqual(replanned.plan!.planningRunId,ready.plan!.planningRunId);assert.notEqual(replanned.plan!.inputSourcesDigest,ready.plan!.inputSourcesDigest);return;}
  await app.command({type:'task.resume',taskId:created.task.id,expectedRevision:1});const first=await until(app,created.task.id,s=>s.task.status==='idle');assert.ok(first.nodes[0]!.outputSourcesDigest);await app.command({type:'task.pause',taskId:created.task.id,expectedRevision:1});writeFileSync(join(workdir,path),'H2');await app.command({type:'task.resume',taskId:created.task.id,expectedRevision:1});const second=await until(app,created.task.id,s=>s.task.status==='idle'&&s.runs.length>first.runs.length);assert.equal(nodes,2);assert.equal(second.nodes[0]!.attempt,2);assert.notEqual(second.nodes[0]!.outputSourcesDigest,first.nodes[0]!.outputSourcesDigest);assert.ok(second.events.some(e=>e.kind==='evidence.stale'));assert.deepEqual(second.artifacts.slice(0,first.artifacts.length),first.artifacts);
 });
});

test('node premises cannot rebind changed sources between observation, effects and publication',async t=>{
 for(const phase of ['binding','read','planner','before-effect','publication','declared-edit','other-edit-source'] as const)await t.test(phase,async t=>{
  const path='node_modules/contract.txt';let checks=0,effects=0,consumers=0,observed='';
  const editing=['before-effect','declared-edit','other-edit-source'].includes(phase);
  const plan:PlanDraft={sequence:1,summary:'Use stable current sources',observations:[],nodes:[
   {id:'produce',title:'Observe',goal:'Report current contract',kind:editing?'edit':'research',dependsOn:[],inputs:phase==='read'||phase==='planner'?[]:[{kind:'file',path,expect:'present'}],outputs:editing?[{id:'summary',kind:'text'},{id:'file',kind:'file',path:phase==='declared-edit'?'./node_modules/contract.txt':'sample.txt',expect:'present'}]:[{id:'summary',kind:'text'}],checkIds:['check']},
   {id:'consume',title:'Consume',goal:'Use the result',kind:'research',dependsOn:['produce'],inputs:[{kind:'artifact',nodeId:'produce',outputId:'summary'}],outputs:[{id:'summary',kind:'text'}],checkIds:[]}
  ]};
  const runner:Runner={async run(r,c,signal){
   if(r.purpose==='planning'){mkdirSync(join(r.workdir,'node_modules'));writeFileSync(join(r.workdir,path),'H1');if(phase==='planner')await c.onTool({toolCallId:id(),name:'read_file',args:{path}});await c.onControl({kind:'update_plan',draft:plan,submit:true});}
   else if(r.node!.id==='produce'){
    observed=JSON.parse(r.context).inputs[0]?.content??'H1';
    if(phase==='read')await c.onTool({toolCallId:id(),name:'read_file',args:{path}});
    if(phase!=='publication')writeFileSync(join(r.workdir,path),'H2');
    if(phase==='before-effect')await c.onTool({toolCallId:id(),name:'write_file',args:{path:'sample.txt',content:'must not run'}});
    await c.onControl({kind:'complete',summary:'Current contract is '+(phase==='declared-edit'?'H2':observed)});
   }else{consumers++;await c.onControl({kind:'complete',summary:JSON.parse(r.context).inputs[0].content});}
   return {summary:'done',turns:1,aborted:signal.aborted};
  }};
  const {app,project}=await setup(t,runner);(app as any).executor={async execute(call:any,o:any){
   if(call.name==='read_file'){const content=readFileSync(join(o.workdir,call.args.path),'utf8');return {text:content,source:{path:call.args.path,sourceDigest:createHash('sha256').update(content).digest('hex'),complete:true}};}
   if(call.name==='write_file'){effects++;writeFileSync(join(o.workdir,call.args.path),call.args.content);}else checks++;return {text:'pass',exitCode:0};
  }};
  if(phase==='publication'){const collect=(app as any).outputArtifacts.bind(app);(app as any).outputArtifacts=(s:TaskSnapshot,...args:any[])=>{const outputs=collect(s,...args);writeFileSync(join(s.task.workdir,path),'H2');return outputs;};}
  const created=await app.command(create(project,{executionPolicy:'autoWithinGrant'})) as TaskSnapshot,done=await until(app,created.task.id,s=>['completed','blocked'].includes(s.task.status));
  const run=done.runs.find(r=>r.nodeId==='produce')!;assert.equal(observed,'H1');assert.equal(readFileSync(join(done.task.workdir,path),'utf8'),'H2');assert.equal(effects,0);
  if(phase!=='read')assert.equal(run.sourcePremises!.find(source=>source.path===path)!.sourceDigest,createHash('sha256').update('H1').digest('hex'));
  else assert.equal(run.reads![0]!.sourceDigest,createHash('sha256').update('H1').digest('hex'));
  if(phase==='declared-edit'){assert.equal(done.task.status,'completed',done.task.error);assert.equal(consumers,1);assert.ok(done.task.acceptedDigest);assert.equal(done.artifacts.find(a=>a.outputId==='file')!.content,'H2');}
  else{assert.equal(done.task.status,'blocked');assert.equal(consumers,0);assert.equal(done.task.acceptedDigest,undefined);assert.equal(done.artifacts.some(a=>a.outputId),false);assert.equal(checks,phase==='publication'?1:0);assert.equal(readFileSync(join(done.task.workdir,'sample.txt'),'utf8'),'original\n');}
 });
});

test('node handoffs preserve the completed source state before downstream work or final acceptance',async t=>{
 for(const phase of ['next','final','manual'] as const)for(const path of ['sample.txt','node_modules/contract.txt'])await t.test(phase+': '+path,async t=>{
  let changed=false,consumers=0,checks=0;const plan:PlanDraft={sequence:1,summary:'Report current contract',observations:[],nodes:[{id:'observe',title:'Observe',goal:'Read the contract',kind:'research',dependsOn:[],inputs:[{kind:'file',path,expect:'present'}],outputs:[{id:'summary',kind:'text'}],checkIds:phase==='manual'?[]:['check']}]};
  if(phase==='next')plan.nodes.push({id:'consume',title:'Consume',goal:'Use the result',kind:'edit',dependsOn:['observe'],inputs:[{kind:'artifact',nodeId:'observe',outputId:'summary'}],outputs:[{id:'file',kind:'file',path,expect:'present'}],checkIds:[]});
  const runner:Runner={async run(r,c,signal){if(r.purpose==='planning'){if(path.startsWith('node_modules')){mkdirSync(join(r.workdir,'node_modules'));writeFileSync(join(r.workdir,path),'H1');}await c.onControl({kind:'update_plan',draft:plan,submit:true});}else{if(r.node!.id==='consume')consumers++;await c.onControl({kind:'complete',summary:JSON.parse(r.context).inputs[0].content});}return {summary:'done',turns:1,aborted:signal.aborted};}};
  const {app,project}=await setup(t,runner);(app as any).executor={async execute(){checks++;return {text:'pass',exitCode:0};}};
  (app as any).options.notify=({taskId}:any)=>{if(!taskId||changed)return;const s=app.store.get(taskId);if(s.events.at(-1)?.kind==='node.finished'){changed=true;writeFileSync(join(s.task.workdir,path),'H2');}};
  const created=await app.command(create(project,{checks:phase==='manual'?[]:create(project).checks,executionPolicy:'autoWithinGrant'})) as TaskSnapshot,done=await until(app,created.task.id,s=>['blocked','completed','waiting_user'].includes(s.task.status));
  assert.equal(changed,true);assert.equal(done.task.status,'blocked');assert.equal(done.task.acceptedDigest,undefined);assert.equal(done.task.acceptedSourcesDigest,undefined);assert.equal(done.decisions.length,0);assert.equal(consumers,0);assert.equal(checks,phase==='manual'?0:1);assert.equal(done.checks.some(c=>c.scope==='final'),false);assert.equal(done.nodes.every(n=>n.status==='stale'),true);
  assert.equal(done.artifacts.find(a=>a.outputId==='summary')!.content,path==='sample.txt'?'original\n':'H1');assert.equal(readFileSync(join(done.task.workdir,path),'utf8'),'H2');assert.ok(done.events.some(e=>e.kind==='evidence.stale'));
 });
});

test('decision and external-wait Runs cannot hide changed upstream sources on continuation',async t=>{
 for(const mode of ['decision','wait'] as const)for(const scenario of ['ordinary-change','ignored-change','unchanged-new-read'] as const)await t.test(mode+': '+scenario,async t=>{
  const path=scenario==='ordinary-change'?'sample.txt':'node_modules/contract.txt';let interrupted=false,consumers=0;
  const plan:PlanDraft={sequence:1,summary:'Inspect then format',observations:[],nodes:[
   {id:'inspect',title:'Inspect',goal:'Report contract',kind:'research',dependsOn:[],inputs:[{kind:'file',path,expect:'present'}],outputs:[{id:'summary',kind:'text'}],checkIds:[]},
   {id:'format',title:'Format',goal:'Format report',kind:'research',dependsOn:['inspect'],inputs:[{kind:'artifact',nodeId:'inspect',outputId:'summary'}],outputs:[{id:'summary',kind:'text'}],checkIds:['check']}
  ]};
  const runner:Runner={async run(r,c,signal){
   if(r.purpose==='planning'){mkdirSync(join(r.workdir,'node_modules'));writeFileSync(join(r.workdir,'node_modules/contract.txt'),'H1');writeFileSync(join(r.workdir,'node_modules/extra.txt'),'extra');await c.onControl({kind:'update_plan',draft:plan,submit:true});}
   else if(r.node!.id==='inspect')await c.onControl({kind:'complete',summary:JSON.parse(r.context).inputs[0].content});
   else if(!interrupted){interrupted=true;if(scenario==='unchanged-new-read')await c.onTool({toolCallId:id(),name:'read_file',args:{path:'node_modules/extra.txt'}});await c.onControl(mode==='decision'?{kind:'decision',question:'Choose report format',options:['short','long']}:{kind:'wait',reason:'Await report format',minutes:1,source:{kind:'project_file',path:'signal.txt'},condition:{kind:'exists'}});}
   else{consumers++;await c.onControl({kind:'complete',summary:JSON.parse(r.context).inputs[0].content});}
   return {summary:'done',turns:1,aborted:signal.aborted};
  }};
  const {app,project,source}=await setup(t,runner);(app as any).executor={async execute(call:any,o:any){if(call.name==='read_file'){const snapshot=readFileSnapshot(o.workdir,call.args.path);return {text:snapshot.content,source:{path:call.args.path,sourceDigest:snapshot.source.sourceDigest,complete:true}};}return {text:'pass',exitCode:0};}};
  const created=await app.command(create(project,{mode:mode==='wait'?'finite':'once',intervalMinutes:1,expiresAt:mode==='wait'?new Date(Date.now()+600000).toISOString():undefined,executionPolicy:'autoWithinGrant'})) as TaskSnapshot;
  const waiting=await until(app,created.task.id,s=>s.task.status===(mode==='decision'?'waiting_user':'waiting_external'));
  if(scenario!=='unchanged-new-read')writeFileSync(join(waiting.task.workdir,path),'H2');
  if(mode==='decision')await app.command({type:'decision.answer',requestId:id(),taskId:created.task.id,expectedRevision:1,decisionId:waiting.decisions.find(d=>d.kind==='model')!.id,answer:'short'});
  else{writeFileSync(join(source,'signal.txt'),'ready');app.store.update(created.task.id,s=>{s.task.nextCheckAt=new Date(0).toISOString();});(app as any).wake();}
  const done=await until(app,created.task.id,s=>['completed','blocked'].includes(s.task.status));
  if(scenario==='unchanged-new-read'){assert.equal(done.task.status,'completed',done.task.error);assert.equal(consumers,1);assert.ok(done.task.acceptedDigest);assert.equal(done.nodes[0]!.attempt,1);}
  else{assert.equal(done.task.status,'blocked');assert.equal(consumers,0);assert.equal(done.task.acceptedDigest,undefined);assert.equal(done.nodes.every(n=>n.status==='stale'),true);assert.equal(done.checks.length,0);assert.deepEqual(done.artifacts,waiting.artifacts);assert.equal(readFileSync(join(done.task.workdir,path),'utf8'),'H2');}
 });
});

test('declared writes survive decisions and waits only while their suspended state stays current',async t=>{
 for(const mode of ['decision','wait'] as const)for(const change of ['none','input','output'] as const)await t.test(mode+': '+change,async t=>{
  const output='node_modules/output.txt';let edits=0,writes=0;
  const plan:PlanDraft={sequence:1,summary:'Inspect, edit, then choose format',observations:[],nodes:[
   {id:'inspect',title:'Inspect',goal:'Read input',kind:'research',dependsOn:[],inputs:[{kind:'file',path:'sample.txt',expect:'present'}],outputs:[{id:'summary',kind:'text'}],checkIds:[]},
   {id:'edit',title:'Edit',goal:'Write output',kind:'edit',dependsOn:['inspect'],inputs:[{kind:'artifact',nodeId:'inspect',outputId:'summary'}],outputs:[{id:'file',kind:'file',path:output,expect:'present'}],checkIds:['check']}
  ]};
  const runner:Runner={async run(r,c,signal){if(r.purpose==='planning')await c.onControl({kind:'update_plan',draft:plan,submit:true});else if(r.node!.id==='inspect')await c.onControl({kind:'complete',summary:JSON.parse(r.context).inputs[0].content});else if(++edits===1){await c.onTool({toolCallId:id(),name:'write_file',args:{path:output,content:'draft',expectedContent:null}});await c.onControl(mode==='decision'?{kind:'decision',question:'Choose format',options:['short','long']}:{kind:'wait',reason:'Await format',minutes:1,source:{kind:'project_file',path:'signal.txt'},condition:{kind:'exists'}});}else await c.onControl({kind:'complete',summary:'Formatted output'});return {summary:'done',turns:1,aborted:signal.aborted};}};
  const {app,project,source}=await setup(t,runner);(app as any).executor={async execute(call:any,o:any){if(call.name==='write_file'){writes++;mkdirSync(join(o.workdir,'node_modules'),{recursive:true});writeFileSync(join(o.workdir,call.args.path),call.args.content);}return {text:'pass',exitCode:0};}};
  const created=await app.command(create(project,{mode:mode==='wait'?'finite':'once',intervalMinutes:1,expiresAt:mode==='wait'?new Date(Date.now()+600000).toISOString():undefined,executionPolicy:'autoWithinGrant'})) as TaskSnapshot;
  const waiting=await until(app,created.task.id,s=>s.task.status===(mode==='decision'?'waiting_user':'waiting_external'));assert.ok(waiting.runs.at(-1)!.suspendedState);assert.equal(waiting.actions[0]!.status,'succeeded');
  if(change!=='none')writeFileSync(join(waiting.task.workdir,change==='input'?'sample.txt':output),'external');
  if(mode==='decision')await app.command({type:'decision.answer',requestId:id(),taskId:created.task.id,expectedRevision:1,decisionId:waiting.decisions[0]!.id,answer:'short'});else{writeFileSync(join(source,'signal.txt'),'ready');due(app,created.task.id);}
  const done=await until(app,created.task.id,s=>['completed','blocked'].includes(s.task.status));assert.equal(writes,1);
  if(change==='none'){assert.equal(done.task.status,'completed',done.task.error);assert.equal(edits,2);assert.equal(done.nodes[0]!.attempt,1);assert.equal(done.artifacts.find(a=>a.outputId==='file')!.content,'draft');}
  else{assert.equal(done.task.status,'blocked');assert.equal(edits,1);assert.equal(done.task.acceptedDigest,undefined);assert.equal(done.nodes.every(n=>n.status==='stale'),true);assert.deepEqual(done.artifacts,waiting.artifacts);assert.equal(readFileSync(join(done.task.workdir,change==='input'?'sample.txt':output),'utf8'),'external');}
 });
});

test('a declared workspace-file wait re-evaluates nodes on its new observed source',async t=>{
 let waited=false;const plan:PlanDraft={sequence:1,summary:'Report changed sample',observations:[],nodes:[{id:'observe',title:'Observe',goal:'Report the next sample',kind:'research',dependsOn:[],inputs:[{kind:'file',path:'sample.txt',expect:'present'}],outputs:[{id:'summary',kind:'text'}],checkIds:['check']}]};
 const runner:Runner={async run(r,c,signal){if(r.purpose==='planning')await c.onControl({kind:'update_plan',draft:plan,submit:true});else if(!waited){waited=true;await c.onControl({kind:'wait',reason:'Await the next sample',minutes:1,source:{kind:'workspace_file',path:'sample.txt'},condition:{kind:'changed'}});}else await c.onControl({kind:'complete',summary:JSON.parse(r.context).inputs[0].content});return {summary:'done',turns:1,aborted:signal.aborted};}};
 const {app,project}=await setup(t,runner);(app as any).executor={async execute(_call:any,o:any){const ok=readFileSync(join(o.workdir,'sample.txt'),'utf8')==='external result\n';return {text:ok?'pass':'fail',exitCode:ok?0:1,isError:!ok};}};
 const created=await app.command(create(project,{objective:'Report changed sample',mode:'finite',intervalMinutes:1,expiresAt:new Date(Date.now()+600000).toISOString(),executionPolicy:'autoWithinGrant'})) as TaskSnapshot;
 const waiting=await until(app,created.task.id,s=>s.task.status==='waiting_external');assert.ok(waiting.runs.at(-1)!.suspendedState);
 writeFileSync(join(waiting.task.workdir,'sample.txt'),'external result\n');due(app,created.task.id);
 const done=await until(app,created.task.id,s=>['completed','blocked'].includes(s.task.status));assert.equal(done.task.status,'completed',done.task.error);assert.equal(done.nodes[0]!.attempt,2);assert.equal(done.runs.at(-1)!.inputBindings![0]!.content,'external result\n');assert.ok(done.events.some(e=>e.kind==='evidence.stale'));assert.ok(done.task.acceptedDigest);assert.equal(done.artifacts.find(a=>a.outputId==='summary')!.content,'external result\n');assert.equal(readFileSync(join(done.task.workdir,'sample.txt'),'utf8'),'external result\n');
});

// These tests exercise the durable callback, not a claimed success response from the tool.
const fileIntentExecutor:Executor={async execute(call,options,signal){
 if(call.name==='write_file'){
  const before=readFileSnapshot(options.workdir,String(call.args.path)).source;
  await options.onFileIntent!({id:id(),path:before.path,before:{exists:before.exists,sourceDigest:before.sourceDigest,...(before.exists?{mode:before.mode!}:{})},after:{exists:true,sourceDigest:createHash('sha256').update(String(call.args.content)).digest('hex'),mode:before.mode??0o644}});
 }
 return executor.execute(call,options,signal);
}};
function fileRecoveryRunner():Runner {
 return {async run(r,c,signal){
  if(r.purpose==='planning')await c.onControl({kind:'update_plan',draft,submit:true});
  else {if(r.node?.id==='edit')await c.onTool({toolCallId:id(),name:'write_file',args:{path:'sample.txt',content:'updated\n',expectedContent:'original\n'}});await c.onControl({kind:'complete',summary:'Updated'});}
  return {summary:'file recovery fixture',turns:1,aborted:signal.aborted};
 }};
}
async function lostFileReceipt(t:test.TestContext){
 const f=await setup(t,fileRecoveryRunner());(f.app as any).executor=fileIntentExecutor;
 const put=f.app.store.put.bind(f.app.store);let injected=false;
 f.app.store.put=s=>{if(!injected&&s.actions.some(a=>a.fileIntent&&a.status==='succeeded')){injected=true;throw new Error('Receipt commit interrupted');}put(s);};
 const created=await f.app.command(create(f.project)) as TaskSnapshot;await until(f.app,created.task.id,s=>s.task.status==='ready');
 await f.app.command({type:'task.resume',taskId:created.task.id,expectedRevision:1});const blocked=await until(f.app,created.task.id,s=>s.task.status==='blocked');
 assert.equal(blocked.actions[0]!.status,'unknown');assert.ok(blocked.actions[0]!.fileIntent);assert.equal(readFileSync(join(blocked.task.workdir,'sample.txt'),'utf8'),'updated\n');
 return {...f,blocked};
}
test('a durable file intent precedes effects; postcondition recovery keeps unknown history and creates a fresh plan',async t=>{
 const {app,blocked}=await lostFileReceipt(t);const oldPlan=blocked.plan!.id;
 const resumed=await app.command({type:'task.resume',taskId:blocked.task.id,expectedRevision:1}) as TaskSnapshot;
 assert.equal(resumed.task.acceptedDigest,undefined);
 const ready=await until(app,blocked.task.id,s=>s.task.status==='ready');
 assert.notEqual(ready.plan!.id,oldPlan);assert.equal(ready.plans.length,2);assert.equal(ready.actions.length,1,'Recovery must not replay the old tool call');
 assert.equal(ready.actions[0]!.status,'unknown');assert.ok(ready.actions[0]!.filePostcondition);assert.equal(ready.actions[0]!.resolution,undefined);
 assert.equal(ready.decisions.filter(d=>!d.answer).length,0);assert.equal(ready.runs.length,3);
 assert.equal(readFileSync(join(ready.task.workdir,'sample.txt'),'utf8'),'updated\n');assert.match(app.report(ready.task.id),/filePostcondition/);
});
test('intent persistence failure prevents the file mutation',async t=>{
 const {app,project}=await setup(t,fileRecoveryRunner());(app as any).executor=fileIntentExecutor;
 const put=app.store.put.bind(app.store);app.store.put=s=>{if(s.actions.some(a=>a.fileIntent))throw new Error('Intent disk write failed');put(s);};
 const created=await app.command(create(project,{executionPolicy:'autoWithinGrant'})) as TaskSnapshot;const blocked=await until(app,created.task.id,s=>s.task.status==='blocked');
 assert.equal(readFileSync(join(blocked.task.workdir,'sample.txt'),'utf8'),'original\n');assert.equal(blocked.actions[0]!.fileIntent,undefined);
});
test('file recovery does not infer an outcome from old bytes, different modes or replaced workspace identity',async t=>{
 for(const change of ['old-bytes','mode','root']){
  const {app,blocked}=await lostFileReceipt(t);const path=join(blocked.task.workdir,'sample.txt');
  if(change==='old-bytes')writeFileSync(path,'original\n');
  if(change==='mode')chmodSync(path,0o600);
  if(change==='root'){renameSync(blocked.task.workdir,blocked.task.workdir+'-old');mkdirSync(blocked.task.workdir);writeFileSync(path,'updated\n');writeFileSync(join(blocked.task.workdir,'check.mjs'),'// immutable acceptance script\n');}
  if(change==='root')await assert.rejects(app.command({type:'task.inspectEffects',taskId:blocked.task.id}));
  else await app.command({type:'task.resume',taskId:blocked.task.id,expectedRevision:1});
  const after=app.store.get(blocked.task.id);assert.equal(after.actions[0]!.filePostcondition,undefined);assert.equal(after.runs.length,2);assert.equal(after.actions[0]!.status,'unknown');
 }
});
test('postcondition commit failure keeps recovery frozen; successful inspection never revives a cancelled task',async t=>{
 const {app,blocked}=await lostFileReceipt(t);const put=app.store.put.bind(app.store);let fail=true;
 app.store.put=s=>{if(fail&&s.actions.some(a=>a.filePostcondition))throw new Error('Proof disk write failed');put(s);};
 await assert.rejects(app.command({type:'task.resume',taskId:blocked.task.id,expectedRevision:1}),/Proof disk write failed/);
 assert.equal(app.store.get(blocked.task.id).actions[0]!.filePostcondition,undefined);
 fail=false;await app.command({type:'task.cancel',taskId:blocked.task.id,expectedRevision:1});
 const after=await app.command({type:'task.inspectEffects',taskId:blocked.task.id}) as TaskSnapshot;
 assert.equal(after.task.status,'cancelled');assert.equal(after.runs.length,2);assert.ok(after.actions[0]!.filePostcondition);assert.equal(after.actions[0]!.status,'unknown');
});
test('unknown commands prevent automatic file reconciliation across tasks',async t=>{
 const {app,project,blocked}=await lostFileReceipt(t);
 const other=await app.command(create(project)) as TaskSnapshot;await until(app,other.task.id,s=>s.task.status==='ready');uncertainAction(app,other.task.id,'run_command');
 await app.command({type:'task.resume',taskId:blocked.task.id,expectedRevision:1});
 assert.equal(app.store.get(blocked.task.id).actions[0]!.filePostcondition,undefined);assert.equal(app.store.get(blocked.task.id).runs.length,2);
});
test('file intent validates original path, raw preimage, expected output and operation identity before acknowledgement',async t=>{
 for(const corruption of ['path','preimage','output','duplicate']){
  const {app,project}=await setup(t,fileRecoveryRunner());let effects=0;
  (app as any).executor={async execute(call:Parameters<Executor['execute']>[0],options:Parameters<Executor['execute']>[1]){
   const before=readFileSnapshot(options.workdir,'sample.txt').source,intent={id:id(),path:corruption==='path'?'other.txt':'sample.txt',before:{exists:true,sourceDigest:corruption==='preimage'?'f'.repeat(64):before.sourceDigest,mode:before.mode!},after:{exists:true as const,sourceDigest:createHash('sha256').update(corruption==='output'?'bad':'updated\n').digest('hex'),mode:before.mode!}};
   await options.onFileIntent!(intent);if(corruption==='duplicate')await options.onFileIntent!(intent);effects++;return {text:'not reached'};
  }};
  const created=await app.command(create(project,{executionPolicy:'autoWithinGrant'})) as TaskSnapshot;const blocked=await until(app,created.task.id,s=>s.task.status==='blocked');
  assert.equal(effects,0);assert.equal(readFileSync(join(blocked.task.workdir,'sample.txt'),'utf8'),'original\n');
 }
});
