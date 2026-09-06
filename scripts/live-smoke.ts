import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAppService } from '../src/core/service.js';
import { acquireOwnerLock } from '../src/execution/lock.js';
import { sandboxCapability } from '../src/execution/sandbox.js';
import type { Project, TaskSnapshot } from '../src/shared/contracts.js';
const modelId=process.env.KNOTRAIL_MODEL_ID;
if(!modelId)throw new Error('Set KNOTRAIL_MODEL_ID to an exact model ID available at your provider');
const key=process.env.KNOTRAIL_API_KEY;
const capability=sandboxCapability();if(!capability.sandbox)throw new Error(capability.reason);
const root=mkdtempSync(join(tmpdir(),'knotrail-live-')),source=join(root,'source'),dataDir=join(root,'data');mkdirSync(source);
writeFileSync(join(source,'target.txt'),'before\n');writeFileSync(join(source,'expected.txt'),'after\n');
const env={PATH:process.env.PATH,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_AUTHOR_NAME:'Knotrail Fixture',GIT_AUTHOR_EMAIL:'fixture@example.org',GIT_COMMITTER_NAME:'Knotrail Fixture',GIT_COMMITTER_EMAIL:'fixture@example.org'};
for(const args of [['init'],['add','.'],['commit','-m','Live verification fixture']])execFileSync('git',args,{cwd:source,env,stdio:'ignore'});
const owner=acquireOwnerLock(dataDir);
const app=createAppService({dataDir,secretStore:{get:()=>key?JSON.stringify({key,baseUrl:process.env.KNOTRAIL_BASE_URL??'https://api.openai.com/v1'}):undefined,set:()=>{}},lockFd:owner.fd,capabilities:capability,notify:()=>{}});
try {
 await app.command({type:'settings.save',patch:{model:{baseUrl:process.env.KNOTRAIL_BASE_URL??'https://api.openai.com/v1',modelId},responseLanguage:'en'}});
 const project=await app.command({type:'project.add',path:source}) as Project;
 const task=await app.command({type:'task.create',requestId:crypto.randomUUID(),projectId:project.id,objective:'Change target.txt from before to after, preserving the final newline. First inspect and submit one plan node, then edit using write_file with expectedContent. Do not change expected.txt. Complete only after doing the edit. Use required check ID exact-match in the plan.',checks:[{id:'exact-match',label:'Protected expected text',command:['/usr/bin/cmp','target.txt','expected.txt'],protectedPaths:['expected.txt']}],executionPolicy:'autoWithinGrant',mode:'once',maxTurns:16,maxRunMs:180000}) as TaskSnapshot;
 const deadline=Date.now()+360000;
 while(Date.now()<deadline){const s=await app.command({type:'task.snapshot',taskId:task.task.id}) as TaskSnapshot;if(s.task.status==='completed'){if(readFileSync(join(s.task.workdir,'target.txt'),'utf8')!=='after\n')throw new Error('Final output mismatch');console.log(JSON.stringify({status:'passed',modelId,plans:s.plans.length,runs:s.runs.length,checks:s.checks.length,usage:s.runs.map(r=>r.usage)}));break;}if(['blocked','waiting_user','expired','cancelled'].includes(s.task.status))throw new Error(`Live task stopped: ${s.task.status}: ${s.task.error??'Requires a user decision'}`);await new Promise(resolve=>setTimeout(resolve,500));if(Date.now()>=deadline)throw new Error('Live smoke deadline exceeded');}
}finally{await app.shutdown();owner.release();rmSync(root,{recursive:true,force:true});}
