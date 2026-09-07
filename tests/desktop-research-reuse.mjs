// Ordinary product flow: real Electron/Core/pi, with a loopback model fixture.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { _electron, expect } from '@playwright/test';

const repository=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const temporary=await mkdtemp(join(tmpdir(),'knotrail-research-desktop-')),source=join(temporary,'project'),dataDir=join(temporary,'data');
const objective='Inspect the reference and update target.txt';
const draft={sequence:1,summary:'Inspect reference, update target, read saved results',observations:[],nodes:[
 {id:'research',title:'Inspect reference',goal:'Explain the reference text',kind:'research',dependsOn:[],inputs:[{kind:'file',path:'reference.txt',expect:'present'}],outputs:[{id:'summary',kind:'text'}],checkIds:[]},
 {id:'edit',title:'Update target',goal:'Replace target with the requested result',kind:'edit',dependsOn:[],inputs:[{kind:'file',path:'target.txt',expect:'present'}],outputs:[{id:'target',kind:'file',path:'target.txt',expect:'present'}],checkIds:[]},
 {id:'compare',title:'Read saved results',goal:'Read both predecessor outputs',kind:'research',dependsOn:['research','edit'],inputs:[{kind:'artifact',nodeId:'research',outputId:'summary'},{kind:'artifact',nodeId:'edit',outputId:'target'}],outputs:[{id:'summary',kind:'text'}],checkIds:[]},
]};
const complete=summary=>({name:'outcome',args:{kind:'complete',summary}});
const responses=[
 {name:'update_plan',args:{draft,submit:true}},complete('The reference is stable.'),
 {name:'read_file',args:{path:'target.txt'}},
 {name:'write_file',args:{path:'target.txt',expectedContent:'before\n',content:'first result\n'}},complete('Updated target.'),
 {name:'read_input',args:{index:0}},{name:'read_input',args:{index:1}},complete('Read both saved results.'),
 {name:'read_file',args:{path:'target.txt'}},
 {name:'write_file',args:{path:'target.txt',expectedContent:'manual target\n',content:'second result\n'}},complete('Updated target again.'),
 {name:'read_input',args:{index:0}},{name:'read_input',args:{index:1}},complete('Read retained research and the new target.'),
];
const requests=[],rendererErrors=[];let application,editHeld=false,releaseEdit;
const editGate=new Promise(resolve=>{releaseEdit=resolve;});
const server=createServer(async(request,response)=>{
 let body='';for await(const chunk of request)body+=chunk;
 const index=requests.length;requests.push(JSON.parse(body));
 if(index===2){editHeld=true;await editGate;}
 const item=responses[index]??{name:'outcome',args:{kind:'blocked',reason:'Unexpected fixture request'}};
 const call={index:0,id:`call-${index}`,type:'function',function:{name:item.name,arguments:JSON.stringify(item.args)}};
 response.writeHead(200,{'Content-Type':'text/event-stream'});
 for(const [delta,finish_reason] of [[{tool_calls:[call]},null],[{},'tool_calls']])response.write(`data: ${JSON.stringify({id:`response-${index}`,object:'chat.completion.chunk',created:1,model:'research-fixture',choices:[{index:0,delta,finish_reason}],...(finish_reason?{usage:{prompt_tokens:20,completion_tokens:12,total_tokens:32}}:{})})}\n\n`);
 response.end('data: [DONE]\n\n');
});
const boot=async()=>{
 application=await _electron.launch({...(process.env.KNOTRAIL_ELECTRON_EXECUTABLE?{executablePath:process.env.KNOTRAIL_ELECTRON_EXECUTABLE,args:[]}:{args:[repository]}),env:{...process.env,KNOTRAIL_DATA_DIR:dataDir},timeout:30000});
 const page=await application.firstWindow();page.on('pageerror',error=>rendererErrors.push(error.message));await page.waitForFunction(()=>Boolean(window.knotrail));return page;
};
const command=(page,input)=>page.evaluate(input=>window.knotrail.command(input),input);
const snapshot=(page,taskId)=>command(page,{type:'task.snapshot',taskId});
try{
 await mkdir(source);await writeFile(join(source,'reference.txt'),'stable reference\n');await writeFile(join(source,'target.txt'),'before\n');
 const env={...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_AUTHOR_NAME:'Knotrail Fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_NAME:'Knotrail Fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid'};
 for(const args of [['init','-q'],['add','.'],['commit','-qm','Fixture baseline']])execFileSync('/usr/bin/git',args,{cwd:source,env,stdio:'ignore'});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 let page=await boot();
 await command(page,{type:'settings.save',patch:{locale:'en',planningOpen:true,model:{baseUrl:`http://127.0.0.1:${server.address().port}/v1`,modelId:'research-fixture',thinking:'off'}}});
 const project=await command(page,{type:'project.add',path:source});
 const created=await command(page,{type:'task.create',requestId:randomUUID(),projectId:project.id,objective,interaction:'conversation',mode:'once',checks:[],executionPolicy:'autoWithinGrant'});
 await expect.poll(()=>editHeld,{timeout:30000}).toBe(true);
 const inFlight=await snapshot(page,created.task.id);assert.equal(inFlight.nodes.find(n=>n.nodeId==='edit').status,'running');
 await command(page,{type:'preferences.save',taskId:created.task.id,value:{panelView:'steps',detailTab:'overview',mainView:'chat',toolPanel:null,graphView:'graph',draft:'Keep this unsent draft'}});
 await command(page,{type:'settings.save',patch:{locale:'zh-CN'}});
 await page.reload();await page.getByRole('button',{name:new RegExp(objective)}).click();
 await expect(page.getByRole('textbox',{name:'发送消息…',exact:true})).toHaveValue('Keep this unsent draft');
 const reconnected=await snapshot(page,created.task.id);assert.deepEqual(reconnected.runs,inFlight.runs);assert.equal(requests.length,3);
 releaseEdit();
 await expect.poll(async()=> (await snapshot(page,created.task.id)).task.status,{timeout:30000}).toBe('idle');
 const first=await snapshot(page,created.task.id),research=first.nodes.find(n=>n.nodeId==='research'),originalRun=first.runs.find(r=>r.id===research.runId),originalArtifacts=first.artifacts.filter(a=>a.runId===research.runId);
 await writeFile(join(first.task.workdir,'target.txt'),'manual target\n');await writeFile(join(first.task.workdir,'user-notes.txt'),'preserve user notes\n');
 const preview=await command(page,{type:'task.previewRetry',taskId:created.task.id,expectedRevision:1,nodeId:'edit'});
 assert.deepEqual(preview.retained,['research']);assert.deepEqual(preview.affected,['edit','compare']);
 await command(page,{type:'task.applyImpact',requestId:randomUUID(),preview});
 await expect.poll(async()=> (await snapshot(page,created.task.id)).task.status,{timeout:30000}).toBe('idle');
 const done=await snapshot(page,created.task.id);assert.deepEqual(done.runs.find(r=>r.id===research.runId),originalRun);assert.deepEqual(done.artifacts.filter(a=>a.runId===research.runId),originalArtifacts);
 assert.deepEqual(done.nodes.map(n=>n.attempt),[1,2,2]);assert.equal(await readFile(join(done.task.workdir,'target.txt'),'utf8'),'second result\n');assert.equal(await readFile(join(done.task.workdir,'user-notes.txt'),'utf8'),'preserve user notes\n');
 const newConsumer=done.runs.filter(r=>r.nodeId==='compare').at(-1);assert.equal(newConsumer.inputBindings[0].producerRunId,research.runId);
 await page.locator('.tracker-step[data-node-id="research"] > summary').click();
 await expect(page.getByTestId('research-reused').first()).toContainText('已复用研究结果');
 if(process.env.KNOTRAIL_SMOKE_SCREENSHOT)await page.screenshot({path:process.env.KNOTRAIL_SMOKE_SCREENSHOT});
 await command(page,{type:'settings.save',patch:{locale:'en'}});await expect(page.getByTestId('research-reused').first()).toContainText('Research retained');
 assert.equal(requests.length,responses.length);assert.equal(rendererErrors.length,0);
 await application.close();application=undefined;page=await boot();
 const restored=await snapshot(page,created.task.id);assert.deepEqual(restored,done);assert.equal((await command(page,{type:'bootstrap'})).settings.locale,'en');
 console.log(JSON.stringify({result:'passed',packaged:!!process.env.KNOTRAIL_ELECTRON_EXECUTABLE,model:'scripted loopback through real pi SDK',rendererReloadDuringRun:true,unsentDraftPreserved:true,duplicateModelRequests:0,originalResearchRunPreserved:true,attempts:done.nodes.map(n=>n.attempt),retainedArtifactConsumed:true,userNotesPreserved:true,languages:['en','zh-CN'],desktopRestartPreservedSnapshot:true,rendererErrors:rendererErrors.length}));
}catch(error){console.error(error);throw error;}finally{releaseEdit();await application?.close().catch(()=>{});server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(temporary,{recursive:true,force:true});}
