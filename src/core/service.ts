import { basename, join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { AppCommand, AppSettings, Bootstrap, CommandResult, ImpactPreview, ModelConfig, PlanRevision, Run, Task, TaskPreferences, TaskSnapshot } from '../shared/contracts.js';
import type { Runner, RunControl, ToolCall, ToolResult } from '../runtime/contracts.js';
import { PiRunner } from '../runtime/pi-runner.js';
import type { Executor } from '../execution/contracts.js';
import { SandboxExecutor } from '../execution/sandbox.js';
import { Store, id, now } from './store.js';
import { digest, files, prepareWorktree, projectRoot, readText, workspaceDiff, workspaceDigest } from './workspace.js';
import { parseCommand, validatePlan } from './validation.js';
export interface SecretStore { get():string|undefined; set(value:string):void }
interface Options { dataDir:string; secretStore:SecretStore; notify(event:{taskId?:string;seq?:number;kind:string}):void; capabilities:Bootstrap['capabilities']; lockFd:number; runner?:Runner; executor?:Executor }
const defaults:AppSettings={locale:'system',model:{baseUrl:'https://api.openai.com/v1',modelId:'',thinking:'off',contextWindow:128000,maxTokens:8192,hasApiKey:false},planningOpen:false,responseLanguage:'task',allowNetwork:false};
const defaultPreferences:TaskPreferences={panelView:'process',detailTab:'overview',mainView:'chat',toolPanel:'terminal',graphView:'graph',draft:''};
interface CheckBatch { id:string; taskRevision:number; planId?:string; checksDigest:string; inputDigest:string; passed:boolean }
const stopped=new Set(['cancelled','expired','completed']);
export function createAppService(options:Options) { return new AppService(options); }
export class AppService {
 readonly store:Store; private runner:Runner;private executor:Executor;
 private queue=new Set<string>();private active?:{taskId:string;controller:AbortController;done:Promise<void>};private effectsFrozen=false;private closing=false;private serial=Promise.resolve();private timer:NodeJS.Timeout;
 constructor(private options:Options) {
  this.store=new Store(options.dataDir);this.runner=options.runner??new PiRunner();this.executor=options.executor??new SandboxExecutor();
  for(const snapshot of this.store.list()) {
   if(snapshot.runs.some(r=>r.status==='running')||snapshot.actions.some(a=>a.status==='pending')||['planning','executing','verifying','reconciling'].includes(snapshot.task.status)) {
    this.update(snapshot.task.id,s=>{s.task.status='blocked';s.task.error='Previous owner stopped before reconciliation. Inspect receipts and resume explicitly.';s.runs.filter(r=>r.status==='running').forEach(r=>{r.status='unknown';r.endedAt=now();});s.actions.filter(a=>a.status==='pending').forEach(a=>a.status='unknown');s.nodes.filter(n=>n.status==='running').forEach(n=>n.status='unknown');this.store.event(s,'recovered',s.task.error!);});
   }
  }
  this.timer=setInterval(()=>this.wake(),1000);this.timer.unref();
 }
 private settings():AppSettings { const value=this.store.value<AppSettings>('settings')??structuredClone(defaults); value.model.hasApiKey=Boolean(this.options.secretStore.get());return value; }
 private credential():{key:string;baseUrl:string}|undefined {const raw=this.options.secretStore.get();if(!raw)return undefined;const value=JSON.parse(raw) as {key:string;baseUrl:string};if(typeof value.key!=='string'||typeof value.baseUrl!=='string')throw new Error('Invalid saved credential; replace it in Settings');return value;}
 private model():ModelConfig { const {hasApiKey,...model}=this.settings().model; if(!model.modelId)throw new Error('Configure a provider model ID in Settings before running');const credential=this.credential();if(credential&&credential.baseUrl!==model.baseUrl)throw new Error('Saved credential belongs to another endpoint; save the matching key in Settings');const key=credential?.key;return {...model,apiKey:key}; }
 private clean(text:string):string {const key=this.credential()?.key;return key?text.split(key).join('[redacted]'):text;}
 private update(taskId:string,fn:(s:TaskSnapshot)=>void):TaskSnapshot {const s=this.store.update(taskId,fn);this.options.notify({taskId,seq:s.lastSequence,kind:'task.changed'});return s;}
 private event(taskId:string,kind:string,text:string,run?:Run,data?:unknown) { this.update(taskId,s=>this.store.event(s,kind,this.clean(text).slice(0,32000),{runId:run?.id,nodeId:run?.nodeId,data: data===undefined?undefined:JSON.parse(this.clean(JSON.stringify(data)))})); }
 private current(taskId:string,revision?:number):TaskSnapshot {const s=this.store.get(taskId);if(revision!==undefined&&s.task.revision!==revision)throw new Error('Task changed; refresh before retrying this action');return s;}
 command(input:unknown):Promise<CommandResult> { const result=this.serial.then(()=>this.dispatch(parseCommand(input)));this.serial=result.then(()=>{},()=>{});return result; }
 private async dispatch(c:AppCommand):Promise<CommandResult> {
  if(this.closing)throw new Error('Application is shutting down');
  if(c.type==='bootstrap')return {projects:this.store.projects(),tasks:this.store.list().map(s=>s.task).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)),settings:this.settings(),capabilities:this.options.capabilities,version:'0.1.0'};
  if(c.type==='project.add') {const path=projectRoot(c.path);const p=this.store.project({id:id(),name:basename(path),path,createdAt:now()});this.options.notify({kind:'projects.changed'});return p;}
  if(c.type==='settings.save') {
   const settings=this.settings();const {model,...patch}=c.patch;
   const {apiKey,...safeModel}=model??{};const next={...settings,...patch,model:{...settings.model,...safeModel,hasApiKey:Boolean(this.options.secretStore.get())}};
   if(next.model.maxTokens>next.model.contextWindow)throw new Error('Maximum output tokens must fit within the context window');
   const previous=this.options.secretStore.get(),credential=this.credential();const key=model?.apiKey??(next.model.baseUrl===settings.model.baseUrl?credential?.key:undefined);next.model.hasApiKey=Boolean(key);try{if(model?.apiKey!==undefined||next.model.baseUrl!==settings.model.baseUrl)this.options.secretStore.set(key?JSON.stringify({key,baseUrl:next.model.baseUrl}):'');this.store.set('settings',next);}catch(error){this.options.secretStore.set(previous??'');throw error;}this.options.notify({kind:'settings.changed'});return next;
  }
  if(c.type==='model.check') {
   const model=this.model();const url=model.baseUrl.replace(/\/$/,'')+'/models';
   const response=await fetch(url,{headers:model.apiKey?{Authorization:`Bearer ${model.apiKey}`}:{},signal:AbortSignal.timeout(15000),redirect:'error'});
   if(!response.ok)throw new Error(`Provider connection failed (HTTP ${response.status})`);
   const body=await response.json() as {data?:{id:string}[]}; if(!Array.isArray(body.data)||!body.data.some(m=>m.id===model.modelId))throw new Error('Configured model ID was not returned by the provider. Save the exact available model ID.');
   return {ok:true,message:'Endpoint and model ID verified. An actual task is still required to verify tool calling.'};
  }
  if(c.type==='task.create') {
   const fingerprint=digest(JSON.stringify(c)); const old=this.store.request<string>(c.requestId,fingerprint);if(old)return this.store.get(old);
   if(!this.options.capabilities.sandbox)throw new Error(this.options.capabilities.reason??'Sandbox is unavailable');this.model();
   if(c.mode!=='once'&&!c.intervalMinutes)throw new Error('Long-running tasks require a check interval');
   if(c.mode==='finite'&&!c.expiresAt)throw new Error('Finite tasks require an expiry time');
   if(c.expiresAt&&Date.parse(c.expiresAt)<=Date.now())throw new Error('Task expiry must be in the future');
   const project=this.store.projects().find(p=>p.id===c.projectId);if(!project)throw new Error('Project not found');
   const taskId=id(),workdir=join(this.options.dataDir,'worktrees',taskId),baseline=prepareWorktree(project.path,workdir),createdAt=now();
   const task:Task={id:taskId,projectId:project.id,title:c.objective.split('\n')[0]!.slice(0,100),objective:c.objective,mode:c.mode,status:'planning',revision:1,workdir,baseline,createdAt,updatedAt:createdAt,executionPolicy:c.executionPolicy,checks:c.checks,maxTurns:c.maxTurns??40,maxRunMs:c.maxRunMs??600000,turnCount:0,intervalMinutes:c.intervalMinutes,expiresAt:c.expiresAt,revisionHistory:[{revision:1,objective:c.objective,checks:c.checks,createdAt}]};
   const s:TaskSnapshot={task,plans:[],nodes:[],runs:[],events:[],artifacts:[],actions:[],checks:[],decisions:[],lastSequence:0};this.store.event(s,'task.created',c.objective);
   this.store.db.exec('BEGIN IMMEDIATE');try{this.store.put(s);this.store.saveRequest(c.requestId,fingerprint,taskId);this.store.db.exec('COMMIT');}catch(e){this.store.db.exec('ROLLBACK');throw e;}
   this.enqueue(taskId);return s;
  }
  if(c.type==='task.snapshot')return this.current(c.taskId);
  if(c.type==='task.inspectEffects'){this.current(c.taskId);await this.stop(c.taskId);this.requireRecovery(c.taskId);return this.current(c.taskId);}
  if(c.type==='task.files')return {files:files(this.current(c.taskId).task.workdir)};
  if(c.type==='task.readFile')return readText(this.current(c.taskId).task.workdir,c.path);
  if(c.type==='preferences.get'){this.current(c.taskId);return this.store.value<TaskPreferences>('preferences:'+c.taskId)??structuredClone(defaultPreferences);}
  if(c.type==='preferences.save'){this.current(c.taskId);this.store.set('preferences:'+c.taskId,c.value);return c.value;}
  if(c.type==='task.export'){const path=join(this.options.dataDir,'exports',c.taskId+'.md');mkdirSync(join(this.options.dataDir,'exports'),{recursive:true,mode:0o700});writeFileSync(path,this.report(c.taskId),{mode:0o600});return {path};}
  if(c.type==='task.pause'||c.type==='task.cancel') {
   const s=this.current(c.taskId,c.expectedRevision);if(stopped.has(s.task.status))throw new Error('Task is already terminal');
   await this.stop(c.taskId);return this.update(c.taskId,s=>{s.task.status=c.type==='task.cancel'?'cancelled':'paused';s.task.nextCheckAt=undefined;if(c.type==='task.cancel')s.decisions.filter(d=>!d.answer).forEach(d=>d.answer='cancelled');this.store.event(s,s.task.status,s.task.status);});
  }
  if(c.type==='task.resume') {
   const s=this.current(c.taskId,c.expectedRevision);if(stopped.has(s.task.status))throw new Error('Task is terminal; create a new task');
   if(!['ready','paused','blocked','unhealthy','waiting_external'].includes(s.task.status))throw new Error('Task cannot be resumed in its current state');
   await this.stop(c.taskId);if(this.requireRecovery(c.taskId))return this.current(c.taskId);
   if(s.decisions.some(d=>!d.answer&&d.taskRevision===s.task.revision)){return this.update(c.taskId,v=>{v.task.status='waiting_user';this.store.event(v,'decision.resumed','Answer the pending decision to continue');});}
   this.reconcile(c.taskId);this.update(c.taskId,v=>{v.task.status=v.plan?'executing':'planning';v.task.error=undefined;v.task.nextCheckAt=undefined;this.store.event(v,'resumed','Task resumed after workspace reconciliation');});this.enqueue(c.taskId);return this.current(c.taskId);
  }
  if(c.type==='task.previewRevision'||c.type==='task.previewRetry') {this.current(c.taskId,c.expectedRevision);await this.stop(c.taskId);if(this.requireRecovery(c.taskId))throw new Error('Resolve unknown effects before changing the task');this.update(c.taskId,s=>{if(!stopped.has(s.task.status))s.task.status='paused';});const p=this.preview(c.taskId,c.type==='task.previewRevision'?c.objective:undefined,c.type==='task.previewRetry'?c.nodeId:undefined);this.store.set('preview:'+p.id,p);return p;}
  if(c.type==='task.applyImpact') {
   const fingerprint=digest(JSON.stringify(c));const old=this.store.request<string>(c.requestId,fingerprint);if(old)return this.current(old);
   const p=c.preview;this.current(p.taskId,p.expectedRevision);const issued=this.store.value<ImpactPreview>('preview:'+p.id);if(!issued||JSON.stringify(issued)!==JSON.stringify(p))throw new Error('Impact preview is stale or was not issued by this host');await this.stop(p.taskId);if(this.requireRecovery(p.taskId))throw new Error('Resolve unknown effects before applying a change');const s=this.current(p.taskId,p.expectedRevision);
   const fresh=this.preview(p.taskId,p.objective,p.nodeId);if(fresh.expectedPlanId!==p.expectedPlanId||fresh.workspaceDigest!==p.workspaceDigest)throw new Error('Plan or workspace changed; generate a new impact preview');
   this.store.db.exec('BEGIN IMMEDIATE');try{
    if(p.objective){s.task.revision++;s.task.objective=p.objective;s.task.title=p.objective.split('\n')[0]!.slice(0,100);s.task.revisionHistory.push({revision:s.task.revision,objective:p.objective,checks:structuredClone(s.task.checks),createdAt:now()});s.plan=undefined;s.draft=undefined;s.task.activePlanId=undefined;s.nodes=[];s.task.status='planning';}
    else {for(const n of s.nodes)if(fresh.affected.includes(n.nodeId)){n.status='stale';n.reason='Invalidated by explicit retry';}s.task.status='executing';}
    s.decisions.filter(d=>!d.answer).forEach(d=>d.answer='invalidated');s.task.acceptedDigest=undefined;s.task.error=undefined;s.task.nextCheckAt=undefined;this.store.event(s,'impact.applied',fresh.reason,{data:fresh});this.store.put(s);this.store.set('preview:'+p.id,null);this.store.saveRequest(c.requestId,fingerprint,s.task.id);this.store.db.exec('COMMIT');
   }catch(e){this.store.db.exec('ROLLBACK');throw e;}this.enqueue(s.task.id);return s;
  }
  if(c.type==='decision.answer') {
   const fingerprint=digest(JSON.stringify(c));const old=this.store.request<string>(c.requestId,fingerprint);if(old)return this.current(old);
   const s=this.current(c.taskId,c.expectedRevision);const decision=s.decisions.find(d=>d.id===c.decisionId&&d.taskRevision===s.task.revision&&!d.answer);if(s.task.status!=='waiting_user'&&!(decision?.kind==='recovery'&&decision.recovery?.terminalStatus===s.task.status))throw new Error('Task is not waiting for a decision');if(!decision)throw new Error('Decision is missing or already answered');if(!decision.recovery?.terminalStatus&&this.isExpired(s)){this.expire(c.taskId);throw new Error('Task deadline reached');}if(!decision.options.includes(c.answer))throw new Error('Select one of the offered answers');
   if(decision.kind!=='recovery'&&this.requireRecovery(c.taskId))throw new Error('Resolve unknown effects before answering this decision');
   if(decision.kind==='recovery') {
    const recovery=decision.recovery!,actions=this.unresolved(s);
    if(decision.planId!==s.task.activePlanId||recovery.actionsDigest!==digest(JSON.stringify(actions))||recovery.workspaceDigest!==workspaceDigest(s.task.workdir)){
     this.update(c.taskId,v=>{v.decisions.find(d=>d.id===decision.id)!.answer='invalidated';v.task.status=decision.recovery?.terminalStatus??'blocked';this.store.event(v,'recovery.stale','Workspace or unknown actions changed; resume to inspect fresh evidence');});throw new Error('Workspace or unknown actions changed; refresh recovery evidence');
    }
    if(c.answer==='stop-task'){s.task.status='cancelled';s.task.nextCheckAt=undefined;}
    else{
     for(const action of actions)action.resolution={decisionId:decision.id,artifactId:recovery.artifactId,taskRevision:s.task.revision,workspaceDigest:recovery.workspaceDigest,disposition:c.answer as 'preserve-and-replan'|'preserve-and-stop',resolvedAt:now()};
     if(recovery.terminalStatus)s.task.status=recovery.terminalStatus;else{s.task.revision++;s.task.revisionHistory.push({revision:s.task.revision,objective:s.task.objective,checks:structuredClone(s.task.checks),createdAt:now()});s.plan=undefined;s.draft=undefined;s.task.activePlanId=undefined;s.nodes=[];s.task.status='planning';s.task.acceptedDigest=undefined;s.task.error=undefined;s.task.nextCheckAt=undefined;}
    }
    s.decisions.filter(d=>!d.answer&&d.id!==decision.id).forEach(d=>d.answer='invalidated');
   }else if(decision.kind==='acceptance') {
    if(s.task.acceptedDigest!==workspaceDigest(s.task.workdir)){this.update(c.taskId,v=>{v.task.status='blocked';v.task.acceptedDigest=undefined;v.decisions.find(d=>d.id===decision.id)!.answer='invalidated';this.store.event(v,'acceptance.stale','Workspace changed; resume to verify again');});throw new Error('Workspace changed after verification; resume and verify again');}
    if(this.isExpired(s)){this.expire(c.taskId);throw new Error('Task deadline reached');}if(c.answer==='accept')s.task.status=s.task.mode==='maintain'?'healthy':'completed';else{s.task.status='blocked';s.task.error='User rejected the result. Revise the objective or retry a node.';}
   }else{s.task.status=s.plan?'executing':'planning';s.nodes.filter(n=>n.nodeId===decision.nodeId).forEach(n=>n.status='stale');}
   decision.answer=c.answer;this.store.event(s,'decision.answered',c.answer,{data:{decisionId:decision.id}});this.scheduleNext(s);
   this.store.db.exec('BEGIN IMMEDIATE');try{this.store.put(s);this.store.saveRequest(c.requestId,fingerprint,s.task.id);this.store.db.exec('COMMIT');}catch(e){this.store.db.exec('ROLLBACK');throw e;}
   if(['planning','executing'].includes(s.task.status))this.enqueue(s.task.id);this.options.notify({taskId:s.task.id,kind:'task.changed'});return s;
  }
  throw new Error('Unsupported command');
 }
 private preview(taskId:string,objective?:string,nodeId?:string):ImpactPreview {
  const s=this.current(taskId);if(stopped.has(s.task.status))throw new Error('Terminal tasks cannot be changed');
  const all=s.plan?.nodes.map(n=>n.id)??[];if(nodeId&&!all.includes(nodeId))throw new Error('Node not found');if(!objective&&!nodeId)throw new Error('Expected a revised objective or retry node');
  const affected=new Set(objective?all:[nodeId!]);let changed=true;while(changed){changed=false;for(const n of s.plan?.nodes??[])if(n.dependsOn.some(d=>affected.has(d))&&!affected.has(n.id)){affected.add(n.id);changed=true;}}
  return {id:id(),taskId,expectedRevision:s.task.revision,expectedPlanId:s.task.activePlanId,workspaceDigest:workspaceDigest(s.task.workdir),objective,nodeId,affected:[...affected],retained:all.filter(n=>!affected.has(n)),reason:objective?'Objective changed: all previous nodes lose completion authority; history and files remain available.':'Retry invalidates this node and every dependent node. Existing files are retained; no effects are replayed automatically.'};
 }
 private unresolved(s:TaskSnapshot) {return s.actions.filter(a=>['pending','unknown'].includes(a.status)&&!a.resolution&&!['read_file','list_files','search_files'].includes(a.name));}
 private requireRecovery(taskId:string):boolean {
  const s=this.current(taskId),actions=this.unresolved(s);
  if(this.effectsFrozen)throw new Error('Receipt storage failed; restart the app to reconcile effects before continuing');
  if(!actions.length){const foreign=this.store.list().find(v=>v.task.id!==taskId&&this.unresolved(v).some(a=>['run_command','required_check'].includes(a.name)));if(!foreign)return false;if(stopped.has(s.task.status))return true;this.update(taskId,v=>{v.task.status='blocked';v.task.error='Resolve unknown command effects in task '+foreign.task.id+' before continuing';});return true;}
  const terminalStatus=stopped.has(s.task.status)?s.task.status as 'cancelled'|'expired'|'completed':undefined;const workspace=workspaceDigest(s.task.workdir),actionsDigest=digest(JSON.stringify(actions));
  const pending=s.decisions.find(d=>d.kind==='recovery'&&!d.answer&&d.taskRevision===s.task.revision&&d.planId===s.task.activePlanId&&d.recovery?.actionsDigest===actionsDigest&&d.recovery.workspaceDigest===workspace);
  if(pending){if(!terminalStatus&&s.task.status!=='waiting_user')this.update(taskId,v=>{v.task.status='waiting_user';});return true;}
  const artifactId=id(),content=this.clean(JSON.stringify(actions,null,2)+'\n\nCurrent workspace diff (does not prove whether a command ran):\n'+workspaceDiff(s.task.workdir));
  if(workspaceDigest(s.task.workdir)!==workspace)throw new Error('Workspace changed while collecting recovery evidence');
  this.update(taskId,v=>{v.decisions.filter(d=>d.kind==='recovery'&&!d.answer).forEach(d=>d.answer='invalidated');v.task.status=terminalStatus??'waiting_user';v.task.acceptedDigest=undefined;v.task.error=undefined;
   v.artifacts.push({id:artifactId,taskId,runId:actions[0]!.runId,kind:'text',name:'Unknown effects: recovery evidence',digest:digest(content),createdAt:now(),content,truncated:content.length>=256000});
   v.decisions.push({kind:'recovery',id:id(),taskId,taskRevision:v.task.revision,planId:v.task.activePlanId,question:'Some operations have an unknown outcome. Inspect the recovery evidence and any external effects. Preserve the current files and create a fresh plan, or stop. Preserving does not confirm that earlier operations succeeded or authorize their replay.',options:terminalStatus?['preserve-and-stop']:['preserve-and-replan','stop-task'],recovery:{terminalStatus,actionIds:actions.map(a=>a.id),actionsDigest,workspaceDigest:workspace,artifactId},createdAt:now()});this.store.event(v,'recovery.required','Unknown effects require a bound user disposition before a new run',{data:{artifactId,actionIds:actions.map(a=>a.id),workspaceDigest:workspace}});
  });return true;
 }
 private async executeRecorded(taskId:string,run:Run,call:ToolCall,signal:AbortSignal,required=false):Promise<ToolResult> {
  const s=this.current(taskId,run.taskRevision);if(this.effectsFrozen||this.unresolved(s).length||this.store.list().some(v=>v.task.id!==taskId&&this.unresolved(v).some(a=>['run_command','required_check'].includes(a.name))))throw new Error('Resolve unknown effects before admitting another operation');
  const receipt=id(),nodeId=run.nodeId,name=required?'required_check':call.name;
  this.update(taskId,v=>{v.actions.push({id:receipt,taskId,runId:run.id,nodeId,toolCallId:call.toolCallId,name,argsDigest:digest(JSON.stringify(call.args)),inputDigest:workspaceDigest(v.task.workdir),status:'pending',startedAt:now()});this.store.event(v,'tool.started',name,{runId:run.id,nodeId,data:{toolCallId:call.toolCallId,args:JSON.parse(this.clean(JSON.stringify(call.args)))}});});
  try{
   const result=await this.executor.execute(call,{workdir:s.task.workdir,dataDir:this.options.dataDir,allowNetwork:this.settings().allowNetwork,lockFd:this.options.lockFd,timeoutMs:Math.min(s.task.maxRunMs,120000),protectedPaths:[...new Set(s.task.checks.flatMap(c=>c.protectedPaths))]},signal),output=this.clean(result.text).slice(0,64000);
   this.update(taskId,v=>{const a=v.actions.find(a=>a.id===receipt)!;a.status=signal.aborted?'unknown':result.isError?'failed':'succeeded';a.output=output;a.endedAt=now();this.store.event(v,'tool.finished',output,{runId:run.id,nodeId,data:{name,isError:result.isError}});});return {...result,text:output};
  }catch(error){
   // Once admitted, an executor error or failed receipt commit cannot prove that effects did not happen.
   try{this.update(taskId,v=>{const a=v.actions.find(a=>a.id===receipt)!;a.status='unknown';a.output=this.clean(String(error));a.endedAt=now();});}catch{this.effectsFrozen=true;}
   throw error;
  }
 }
 private reconcile(taskId:string):void {const s=this.current(taskId),current=workspaceDigest(s.task.workdir);this.update(taskId,v=>{if(v.plan&&!v.nodes.some(n=>n.attempt>0)&&v.plan.inputDigest!==current){v.plan=undefined;v.draft=undefined;v.task.activePlanId=undefined;v.nodes=[];v.task.status='planning';this.store.event(v,'plan.stale','Planning input changed before execution; a fresh plan is required');return;}const trusted=v.task.acceptedDigest??v.nodes.findLast(n=>n.status==='verified')?.outputDigest;if(trusted&&trusted!==current){for(const n of v.nodes){n.status='stale';n.reason='Workspace changed since verification';}this.store.event(v,'evidence.stale','Workspace changed; node evidence invalidated');}for(const n of v.nodes)if(['running','unknown','failed'].includes(n.status))n.status='stale';});}
 private enqueue(taskId:string):void {this.queue.add(taskId);queueMicrotask(()=>this.pump());}
 private pump():void {
  if(this.active||this.closing)return;const taskId=this.queue.values().next().value as string|undefined;if(!taskId)return;this.queue.delete(taskId);const controller=new AbortController();
  const done=Promise.resolve().then(()=>this.drive(taskId,controller.signal)).catch(error=>{if(!this.closing)try{this.update(taskId,s=>{if(!stopped.has(s.task.status)&&s.task.status!=='paused'){s.task.status=this.isExpired(s)?'expired':'blocked';s.task.error=this.clean(error instanceof Error?error.message:String(error));this.store.event(s,'error',s.task.error);}});}catch{this.effectsFrozen=true;}}).finally(()=>{this.active=undefined;this.pump();});
  this.active={taskId,controller,done};
 }
 private async stop(taskId:string):Promise<void> {this.queue.delete(taskId);if(this.active?.taskId===taskId){const {controller,done}=this.active;controller.abort();await done;}}
 private isExpired(s:TaskSnapshot):boolean {return Boolean(s.task.expiresAt&&Date.parse(s.task.expiresAt)<=Date.now());}
 private expire(taskId:string):void {this.update(taskId,s=>{s.task.status='expired';s.task.nextCheckAt=undefined;s.decisions.filter(d=>!d.answer).forEach(d=>d.answer='expired');this.store.event(s,'expired','Task deadline reached');});}
 private budget(s:TaskSnapshot):void {if(s.task.expiresAt&&Date.parse(s.task.expiresAt)<=Date.now())throw new Error('Task expired');if(s.task.turnCount>=s.task.maxTurns)throw new Error('Task turn budget exhausted; create a new task with a new budget');}
 private async drive(taskId:string,signal:AbortSignal):Promise<void> {
  let s=this.current(taskId);if(!['planning','executing','verifying'].includes(s.task.status)||this.requireRecovery(taskId))return;
  if(!s.plan){this.budget(s);await this.run(taskId,undefined,signal);s=this.current(taskId);if(signal.aborted||!s.plan||s.task.status!=='ready')return;if(s.task.executionPolicy==='reviewBeforeExecute')return;this.update(taskId,v=>{v.task.status='executing';});}
  while(!signal.aborted){s=this.current(taskId);if(s.task.status!=='executing')return;if(s.plan&&!s.nodes.some(n=>n.attempt>0)&&s.plan.inputDigest!==workspaceDigest(s.task.workdir)){this.reconcile(taskId);this.enqueue(taskId);return;}
   const next=s.plan!.nodes.find(n=>s.nodes.find(state=>state.nodeId===n.id)?.status!=='verified'&&n.dependsOn.every(dep=>s.nodes.find(state=>state.nodeId===dep)?.status==='verified'));
   if(!next){if(s.nodes.every(n=>n.status==='verified'))await this.finalize(taskId,signal);else throw new Error('No executable plan node is available');return;}
   this.budget(s);await this.run(taskId,next.id,signal);
  }
 }
 private async run(taskId:string,nodeId:string|undefined,signal:AbortSignal):Promise<void> {
  const start=this.current(taskId);const parentSignal=signal,fault=new AbortController();let toolFailure:unknown;const timeoutMs=Math.max(1,Math.min(start.task.maxRunMs,start.task.expiresAt?Date.parse(start.task.expiresAt)-Date.now():Infinity));signal=AbortSignal.any([signal,fault.signal,AbortSignal.timeout(timeoutMs)]);const node=start.plan?.nodes.find(n=>n.id===nodeId),inputDigest=workspaceDigest(start.task.workdir),before=workspaceDiff(start.task.workdir),runId=id();
  const run:Run={id:runId,taskId,taskRevision:start.task.revision,planId:start.task.activePlanId,nodeId,purpose:node?'node':'planning',attempt:(start.nodes.find(n=>n.nodeId===nodeId)?.attempt??0)+1,status:'running',startedAt:now(),inputDigest};
  this.update(taskId,s=>{s.runs.push(run);if(nodeId){const state=s.nodes.find(n=>n.nodeId===nodeId)!;state.status='running';state.attempt=run.attempt;state.runId=runId;state.inputDigest=inputDigest;}this.store.event(s,'run.started',node?.title??'Planning started',{runId,nodeId});});
  let terminal:RunControl|undefined;let admission=true;let observedTurns=0;let draftSequence=-1;
  const tool=async(call:ToolCall):Promise<ToolResult>=>{
   if(signal.aborted||!admission)return {text:'Run admission is closed',isError:true};
   if(!node&&!['read_file','list_files','search_files'].includes(call.name))return {text:'Planning is read-only',isError:true};
   const current=this.current(taskId);if(current.task.revision!==run.taskRevision)return {text:'Stale run revision',isError:true};
   try{return await this.executeRecorded(taskId,run,call,signal);}catch(error){admission=false;toolFailure=error;fault.abort();throw error;}
  };
  try {
   const result=await this.runner.run({runId,purpose:run.purpose,workdir:start.task.workdir,sessionDir:join(this.options.dataDir,'sessions',runId),model:this.model(),objective:start.task.objective,checks:start.task.checks,plan:start.plan,node,context:JSON.stringify({previousRuns:start.runs.slice(-8).map(r=>({node:r.nodeId,status:r.status,summary:r.summary})),decisions:start.decisions.filter(d=>d.answer),workspaceDigest:inputDigest}),maxTurns:start.task.maxTurns-start.task.turnCount,timeoutMs:start.task.maxRunMs,responseLanguage:this.settings().responseLanguage}, {
    onEvent:(kind,text,data)=>{try{if(admission&&!signal.aborted){if(kind==='turn.started'){observedTurns++;this.update(taskId,s=>{s.task.turnCount++;});}this.event(taskId,kind,text,run,data);}}catch(error){admission=false;toolFailure=error;fault.abort();}},onTool:tool,
    onControl:async(control)=>{
     if(signal.aborted||!admission)return {text:'Run admission is closed',isError:true};
     if(control.kind==='update_plan'){
      if(node)return {text:'Only the planning run can change the plan',isError:true};const draft=validatePlan(control.draft,start.task.checks,control.submit);if(draft.sequence<=draftSequence)return {text:'Plan draft sequence is stale',isError:true};draftSequence=draft.sequence;
      this.update(taskId,v=>{v.draft=draft;this.store.event(v,'plan.draft',draft.summary,{runId,data:draft});});
      if(control.submit){terminal={...control,draft};admission=false;}return {text:control.submit?'Candidate saved; publication awaits runner shutdown and source validation':'Draft saved'};
     }
     if(control.kind==='complete'&&!node)return {text:'Planning must submit a valid plan',isError:true};
     if(control.kind==='wait'&&(start.task.mode==='once'||!Number.isFinite(control.minutes)||control.minutes<1))return {text:'External waits require a long-running task and a positive duration',isError:true};
     if(control.kind==='decision'&&(!control.question||control.options.length<2||control.options.length>6||control.options.some(v=>!v)))return {text:'A decision needs a question and 2–6 options',isError:true};
     terminal=control;admission=false;return {text:'Run outcome recorded; do not call further tools'};
    }
   },signal);
   admission=false;if(toolFailure)throw toolFailure;this.update(taskId,s=>{const r=s.runs.find(r=>r.id===runId)!;r.status=result.aborted||signal.aborted?'aborted':'succeeded';r.endedAt=now();r.summary=this.clean(result.summary);r.usage=result.usage;r.sessionPath=result.sessionPath;if(!observedTurns)s.task.turnCount+=Math.max(1,result.turns);});
   if(result.aborted||signal.aborted){this.update(taskId,s=>{if(nodeId)s.nodes.find(n=>n.nodeId===nodeId)!.status='unknown';});if(!parentSignal.aborted)throw new Error('Run timed out');return;}
   if(!terminal)throw new Error('Model stopped without a structured outcome');
   if(terminal.kind==='update_plan'){
    const candidate=terminal.draft;this.update(taskId,s=>{
     if(s.task.revision!==run.taskRevision||s.task.activePlanId!==run.planId||workspaceDigest(s.task.workdir)!==inputDigest)throw new Error('Planning source changed before publication; revise or resume to plan again');
     const plan:PlanRevision={...candidate,id:id(),taskRevision:run.taskRevision,revision:s.plans.length+1,createdAt:now(),digest:digest(JSON.stringify(candidate)),inputDigest};
     s.plans.push(plan);s.plan=plan;s.task.activePlanId=plan.id;s.nodes=plan.nodes.map(n=>({nodeId:n.id,status:'queued',attempt:0}));s.task.status='ready';
     this.store.event(s,'plan.committed','Validated plan committed after runner shutdown',{runId,data:{planId:plan.id,inputDigest}});this.store.event(s,'plan.ready','Planning complete; the execution policy determines when work starts',{runId});
    });return;
   }
   if(terminal.kind==='complete'){
    const batch=await this.check(taskId,runId,nodeId,node!.checkIds,signal),diff=workspaceDiff(start.task.workdir);
    this.update(taskId,s=>{const after=workspaceDigest(s.task.workdir),ok=this.batchCurrent(s,batch,after),n=s.nodes.find(n=>n.nodeId===nodeId)!;n.status=ok&&!signal.aborted?'verified':signal.aborted?'unknown':'failed';n.outputDigest=after;const content=`${terminal!.kind==='complete'?terminal!.summary:''}\n\nWorkspace diff after this run:\n${diff}`;s.artifacts.push({id:id(),taskId,runId,nodeId,kind:'diff',name:node!.title,digest:digest(content),createdAt:now(),content:this.clean(content),truncated:diff.length>=256000});this.store.event(s,'node.finished',n.status,{runId,nodeId,data:{inputDigest,outputDigest:after,diffChanged:before!==diff}});if(!ok){s.task.status='blocked';s.task.error='A required check failed or verification source changed; inspect evidence before retrying';}});if(signal.aborted&&!parentSignal.aborted)throw new Error('Run timed out during verification');return;
   }
   this.update(taskId,s=>{if(nodeId)s.nodes.find(n=>n.nodeId===nodeId)!.status='stale';if(terminal!.kind==='decision'){s.task.status='waiting_user';s.decisions.push({kind:'model',id:id(),taskId,taskRevision:s.task.revision,planId:s.task.activePlanId,nodeId,question:this.clean(terminal!.question),options:terminal!.options,createdAt:now()});this.store.event(s,'decision.requested',terminal!.question,{runId,nodeId});}else if(terminal!.kind==='wait'){s.task.status='waiting_external';s.task.nextCheckAt=new Date(Date.now()+Math.min(terminal!.minutes,43200)*60000).toISOString();this.store.event(s,'wait.started',terminal!.reason,{runId,nodeId});}else if(terminal!.kind==='blocked'){s.task.status='blocked';s.task.error=this.clean(terminal!.reason);this.store.event(s,'blocked',terminal!.reason,{runId,nodeId});}});
  }catch(error){admission=false;this.update(taskId,s=>{const r=s.runs.find(r=>r.id===runId)!;r.status=signal.aborted?'aborted':'failed';r.endedAt=now();if(!observedTurns)s.task.turnCount++;if(nodeId)s.nodes.find(n=>n.nodeId===nodeId)!.status=signal.aborted?'unknown':'failed';this.store.event(s,'run.failed',this.clean(String(error)),{runId,nodeId});});throw error;}
 }
 private batchCurrent(s:TaskSnapshot,batch:CheckBatch,currentDigest=workspaceDigest(s.task.workdir)):boolean {
  return batch.passed&&s.task.revision===batch.taskRevision&&s.task.activePlanId===batch.planId&&digest(JSON.stringify(s.task.checks))===batch.checksDigest&&currentDigest===batch.inputDigest;
 }
 private async check(taskId:string,runId:string,nodeId:string|undefined,conditionIds:string[],signal:AbortSignal):Promise<CheckBatch> {
  const s=this.current(taskId),batch:CheckBatch={id:id(),taskRevision:s.task.revision,planId:s.task.activePlanId,checksDigest:digest(JSON.stringify(s.task.checks)),inputDigest:workspaceDigest(s.task.workdir),passed:true};
  for(const condition of s.task.checks.filter(c=>conditionIds.includes(c.id))) {
   if(signal.aborted||!this.batchCurrent(this.current(taskId),batch)){batch.passed=false;break;}const checkRun={...s.runs.find(r=>r.id===runId)!,taskRevision:s.task.revision,nodeId};
   const result=await this.executeRecorded(taskId,checkRun,{toolCallId:'check:'+condition.id+':'+id(),name:'run_command',args:{argv:condition.command}},signal,true);
   const changed=!this.batchCurrent(this.current(taskId),batch),status=signal.aborted?'unknown':result.isError||changed?'fail':'pass';if(status!=='pass')batch.passed=false;
   const output=this.clean(result.text)+(changed?'\nVerification source changed during the check batch; verification is invalid.':'');
   this.update(taskId,v=>{v.checks.push({id:id(),batchId:batch.id,scope:nodeId?'node':'final',taskRevision:batch.taskRevision,planId:batch.planId,checksDigest:batch.checksDigest,taskId,runId,nodeId,conditionId:condition.id,result:status,inputDigest:batch.inputDigest,output:output.slice(0,64000),checkedAt:now()});this.store.event(v,'check.finished',condition.label+': '+status,{runId,nodeId,data:{conditionId:condition.id,result:status,batchId:batch.id}});});
  }batch.passed=!signal.aborted&&this.batchCurrent(this.current(taskId),batch);return batch;
 }
 private async finalize(taskId:string,signal:AbortSignal):Promise<void> {
  const s=this.current(taskId);if(this.requireRecovery(taskId))return;if(this.isExpired(s)){this.expire(taskId);return;}this.update(taskId,v=>{v.task.status='verifying';});const runId=s.runs.at(-1)?.id??id();
  const checkSignal=s.task.expiresAt?AbortSignal.any([signal,AbortSignal.timeout(Math.max(1,Date.parse(s.task.expiresAt)-Date.now()))]):signal;const batch=await this.check(taskId,runId,undefined,s.task.checks.map(c=>c.id),checkSignal);if(this.isExpired(this.current(taskId))){this.expire(taskId);return;}if(signal.aborted)return;
  this.update(taskId,v=>{v.task.acceptedDigest=undefined;if(!this.batchCurrent(v,batch)){v.task.status='blocked';v.task.error='Final acceptance checks failed or verification source changed';}else{v.task.acceptedDigest=batch.inputDigest;if(this.isExpired(v)){v.task.status='expired';v.task.acceptedDigest=undefined;this.store.event(v,'expired','Task deadline reached during final verification');return;}if(v.task.checks.length){v.task.status=v.task.mode==='maintain'?'healthy':'completed';this.scheduleNext(v);}else{v.task.status='waiting_user';v.decisions.push({kind:'acceptance',id:id(),taskId,taskRevision:v.task.revision,planId:v.task.activePlanId,question:'No automated acceptance commands were supplied. Review the artifacts and accept this exact workspace result.',options:['accept','reject'],createdAt:now()});}}this.store.event(v,'verification.finished',v.task.status,{data:{digest:v.task.acceptedDigest,batchId:batch.id}});});
 }
 private scheduleNext(s:TaskSnapshot) {if(s.task.mode==='maintain'&&['healthy','unhealthy'].includes(s.task.status))s.task.nextCheckAt=new Date(Date.now()+(s.task.intervalMinutes??60)*60000).toISOString();}
 private wake():void {if(this.closing)return;for(const s of this.store.list()){
  if(stopped.has(s.task.status))continue;
  if(s.task.expiresAt&&Date.parse(s.task.expiresAt)<=Date.now()){void this.command({type:'task.cancel',taskId:s.task.id,expectedRevision:s.task.revision}).then(()=>this.update(s.task.id,v=>{v.task.status='expired';})).catch(()=>{});continue;}
  if(!s.task.nextCheckAt||Date.parse(s.task.nextCheckAt)>Date.now()||this.active?.taskId===s.task.id)continue;
  if(s.task.status==='waiting_external'){this.update(s.task.id,v=>{v.task.nextCheckAt=undefined;v.task.status=v.plan?'executing':'planning';this.store.event(v,'wake','External wait elapsed; rechecking with a fresh run');});this.enqueue(s.task.id);}
  else if(s.task.status==='healthy'||s.task.status==='unhealthy'){
   // ponytail: maintenance reuses fixed acceptance checks; failed checks need an explicit repair decision.
   this.update(s.task.id,v=>{v.task.nextCheckAt=undefined;v.task.status='executing';});this.reconcile(s.task.id);this.enqueue(s.task.id);
  }
 }}
 report(taskId:string):string {const s=this.current(taskId);return this.clean(`# ${s.task.title}\n\nStatus: ${s.task.status}\nTask revision: ${s.task.revision}\nBaseline: ${s.task.baseline}\n\n## Objective\n${s.task.objective}\n\n## Plan revisions\n${s.plans.map(p=>`### Plan ${p.revision}\n${p.summary}\n${p.nodes.map(n=>`- ${n.id}: ${n.title}; depends on ${n.dependsOn.join(', ')||'none'}`).join('\n')}`).join('\n\n')}\n\n## Verification\n${s.checks.map(c=>`- ${c.conditionId}: ${c.result}; digest ${c.inputDigest}\nTask revision: ${c.taskRevision??'legacy'}; Plan: ${c.planId??'legacy'}; Run: ${c.runId}; Node: ${c.nodeId??'final'}; Batch: ${c.batchId??'legacy'}; Scope: ${c.scope??'legacy'}; Check definitions: ${c.checksDigest??'legacy'}\n\n\`\`\`text\n${c.output}\n\`\`\``).join('\n')}\n\n## Action receipts\n${s.actions.map(a=>`\`\`\`json\n${JSON.stringify(a,null,2)}\n\`\`\``).join('\n\n')}\n\n## Decisions\n${s.decisions.map(d=>`\`\`\`json\n${JSON.stringify(d,null,2)}\n\`\`\``).join('\n\n')}\n\n## Artifacts\n${s.artifacts.map(a=>`### ${a.name}\nRun: ${a.runId}\nSHA-256: ${a.digest}\n\n\`\`\`diff\n${a.content}\n\`\`\``).join('\n')}\n\n## Event ledger\n${s.events.map(e=>`${e.seq}. ${e.createdAt} [${e.kind}] ${e.text}`).join('\n')}\n`);}
 async shutdown():Promise<void> {this.closing=true;clearInterval(this.timer);this.queue.clear();if(this.active){this.active.controller.abort();await this.active.done;}for(const s of this.store.list())if(['planning','executing','verifying'].includes(s.task.status))this.update(s.task.id,v=>{v.task.status='paused';this.store.event(v,'shutdown','Paused by application shutdown');});this.store.close();}
}
