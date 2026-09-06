import { z } from 'zod';
import type { AppCommand, PlanDraft, CheckSpec } from '../shared/contracts.js';
const text=z.string().min(1).max(32_000), key=z.string().min(1).max(200), revision=z.number().int().positive();
const path=z.string().min(1).max(4096).refine(p=>!p.startsWith('/')&&!p.split(/[\\/]/).some(s=>s==='..'||s==='.git')&&!p.includes('\0'),'Expected a safe relative path');
const fileHash=z.string().regex(/^[a-f0-9]{64}$/),fileMode=z.number().int().min(0).max(0o777);
const presentFile=z.object({exists:z.literal(true),sourceDigest:fileHash,mode:fileMode}).strict();
export const fileIntentSchema=z.object({id:key,path,before:z.union([presentFile,z.object({exists:z.literal(false),sourceDigest:z.null()}).strict()]),after:presentFile}).strict();
const fileRef=z.object({kind:z.literal('file'),path,expect:z.enum(['present','absent'])}).strict();
const inputRef=z.union([fileRef,z.object({kind:z.literal('artifact'),nodeId:key,outputId:key}).strict()]);
const outputSpec=z.union([fileRef.extend({id:key.refine(v=>v!=='summary','summary is reserved for text output')}),z.object({id:z.literal('summary'),kind:z.literal('text')}).strict()]);
export const checksSchema=z.array(z.object({id:key,label:text,command:z.array(z.string().max(8192)).min(1).max(100),protectedPaths:z.array(path).max(100)}).strict()).max(30).refine(v=>new Set(v.map(x=>x.id)).size===v.length,'Check IDs must be unique');
export const waitSchema=z.object({kind:z.literal('wait'),reason:text,minutes:z.number().int().min(1).max(43200),source:z.object({kind:z.enum(['workspace_file','project_file']),path}).strict(),condition:z.union([z.object({kind:z.enum(['changed','exists'])}).strict(),z.object({kind:z.literal('contains'),text:z.string().min(1).max(4096)}).strict()])}).strict();
const secret=z.string().max(8192);
const prefs=z.object({panelView:z.enum(['process','steps']),selectedNode:key.optional(),detailTab:z.enum(['overview','artifacts','checks','history']),mainView:z.enum(['chat','activity','changes']),toolPanel:z.enum(['files','terminal','preview']).nullable(),graphView:z.enum(['graph','list']),draft:z.string().max(32_000)}).strict();
const impact=z.object({id:key,taskId:key,expectedRevision:revision,expectedPlanId:key.optional(),workspaceDigest:key,inputSourcesDigest:key.optional(),objective:text.optional(),checks:checksSchema.optional(),nodeId:key.optional(),affected:z.array(key),retained:z.array(key),reason:text}).strict();
const schemas:Record<string,z.ZodType>={
 'bootstrap':z.object({type:z.literal('bootstrap')}).strict(),
 'project.add':z.object({type:z.literal('project.add'),path:text}).strict(),
 'task.create':z.object({type:z.literal('task.create'),requestId:key,projectId:key,objective:text,checks:checksSchema,executionPolicy:z.enum(['autoWithinGrant','reviewBeforeExecute']),mode:z.enum(['once','finite','maintain']),interaction:z.enum(['conversation','task']).optional(),intervalMinutes:z.number().int().min(1).max(43200).optional(),maxTurns:z.number().int().min(1).max(500).optional(),maxRunMs:z.number().int().min(1000).max(3600000).optional(),expiresAt:z.iso.datetime().optional()}).strict(),
 'task.message':z.object({type:z.literal('task.message'),requestId:key,taskId:key,expectedRevision:revision,text:text.refine(v=>v.trim().length>0,'Enter a message')}).strict(),
 'task.applyImpact':z.object({type:z.literal('task.applyImpact'),requestId:key,preview:impact}).strict(),
 'task.previewRevision':z.object({type:z.literal('task.previewRevision'),taskId:key,objective:text.optional(),checks:checksSchema.optional(),expectedRevision:revision}).strict().refine(v=>v.objective!==undefined||v.checks!==undefined,'Provide a revised objective or acceptance checks'),
 'task.previewRetry':z.object({type:z.literal('task.previewRetry'),taskId:key,nodeId:key,expectedRevision:revision}).strict(),
 'decision.answer':z.object({type:z.literal('decision.answer'),requestId:key,taskId:key,decisionId:key,answer:text,expectedRevision:revision}).strict(),
 'task.readFile':z.object({type:z.literal('task.readFile'),taskId:key,path}).strict(),
 'preferences.save':z.object({type:z.literal('preferences.save'),taskId:key,value:prefs}).strict(),
 'settings.save':z.object({type:z.literal('settings.save'),patch:z.object({locale:z.enum(['system','zh-CN','en']).optional(),planningOpen:z.boolean().optional(),responseLanguage:z.enum(['task','zh-CN','en']).optional(),allowNetwork:z.boolean().optional(),model:z.object({authSource:z.enum(['api-key','codex-login']),baseUrl:z.url().refine(v=>{const u=new URL(v);return !u.username&&!u.password&&!u.search&&!u.hash&&(u.protocol==='https:'||(u.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(u.hostname)));},'Use HTTPS or a loopback HTTP endpoint without embedded credentials'),modelId:key,apiKey:secret,thinking:z.enum(['off','low','medium','high']),contextWindow:z.number().int().min(4096).max(2_000_000),maxTokens:z.number().int().min(128).max(100_000)}).partial().strict().optional()}).strict()}).strict(),
 'model.check':z.object({type:z.literal('model.check')}).strict(),
};
for(const type of ['task.snapshot','task.inspectEffects','task.files','task.export','preferences.get']) schemas[type]=z.object({type:z.literal(type),taskId:key}).strict();
for(const type of ['task.pause','task.resume','task.cancel']) schemas[type]=z.object({type:z.literal(type),taskId:key,expectedRevision:revision}).strict();
export function parseCommand(input:unknown):AppCommand { const type=(input as {type?:string})?.type; if(!type||!schemas[type]) throw new Error('Unsupported command'); return schemas[type].parse(input) as AppCommand; }
export function validatePlan(input:unknown, checks:CheckSpec[], committed = true):PlanDraft {
 const value=z.object({sequence:z.number().int().nonnegative(),summary:text,observations:z.array(z.object({kind:z.enum(['fact','constraint','proposal']),text,source:z.string().max(4096).optional()}).strict()).max(100),nodes:z.array(z.object({id:key,title:text,goal:text,dependsOn:z.array(key).max(100),kind:z.enum(['research','edit','verify']),inputs:z.array(inputRef).max(100),outputs:z.array(outputSpec).min(committed?1:0).max(100),checkIds:z.array(key).max(30)}).strict()).min(committed ? 1 : 0).max(60)}).strict().parse(input);
 const nodes=new Map(value.nodes.map(n=>[n.id,n])); if(nodes.size!==value.nodes.length) throw new Error('Plan node IDs must be unique');
 const visiting=new Set<string>(),done=new Set<string>();
 function visit(nodeId:string) { if(visiting.has(nodeId))throw new Error('Plan dependencies contain a cycle'); if(done.has(nodeId))return; const n=nodes.get(nodeId);if(!n){if(committed)throw new Error('Plan references an unknown dependency');return;}visiting.add(nodeId);n.dependsOn.forEach(visit);visiting.delete(nodeId);done.add(nodeId); }
 value.nodes.forEach(n=>{ visit(n.id); for(const checkId of n.checkIds)if(!checks.some(c=>c.id===checkId))throw new Error('Plan references an unknown check'); });
 for(const node of value.nodes){
  if(new Set(node.outputs.map(o=>o.id)).size!==node.outputs.length)throw new Error('Node output IDs must be unique');
  const ancestors=new Set<string>();function collect(id:string){if(ancestors.has(id))return;ancestors.add(id);nodes.get(id)?.dependsOn.forEach(collect);}node.dependsOn.forEach(collect);
  for(const ref of node.inputs)if(ref.kind==='artifact'&&committed&&(!ancestors.has(ref.nodeId)||!nodes.get(ref.nodeId)?.outputs.some(o=>o.id===ref.outputId)))throw new Error('Artifact input must reference a declared output of a predecessor');
 }
 for(const check of checks) if(committed&&!value.nodes.some(n=>n.checkIds.includes(check.id)))throw new Error('Plan must cover every user-defined check');
 return value;
}
