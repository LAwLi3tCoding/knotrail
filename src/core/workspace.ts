import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, existsSync, lstatSync, fstatSync, readSync, mkdirSync, mkdtempSync, rmSync, openSync, readFileSync, readdirSync, realpathSync, closeSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { FileSource } from '../shared/contracts.js';
export const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
// These commands never checkout, run hooks, execute diff drivers, or invoke repository filters.
export function git(cwd: string, args: string[]): Buffer {
  return execFileSync('/usr/bin/git', ['-c','core.fsmonitor=false','-c','core.untrackedCache=false',...args], { cwd, env: { PATH:'/usr/bin:/bin', HOME:process.env.HOME, GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:'/dev/null', GIT_TERMINAL_PROMPT:'0' }, maxBuffer:32*1024*1024, timeout:30_000, stdio:['ignore','pipe','pipe'] });
}
export function projectRoot(path: string): string {
  const root = realpathSync(path); const actual = realpathSync(git(root,['rev-parse','--show-toplevel']).toString().trim());
  if (actual !== root) throw new Error('Select the Git repository root');
  git(root,['rev-parse','--verify','HEAD']); return root;
}
export function prepareWorktree(source: string, workdir: string): string {
  projectRoot(source);
  assertClean(source);
  const baseline = git(source,['rev-parse','HEAD']).toString().trim();
  mkdirSync(dirname(workdir), { recursive:true, mode:0o700 });
  git(source,['worktree','add','--detach','--no-checkout',workdir,baseline]);
  for (const entry of git(source,['ls-tree','-rz','--full-tree',baseline]).toString().split('\0').filter(Boolean)) {
    const tab=entry.indexOf('\t'),meta=entry.slice(0,tab),path=entry.slice(tab+1); const [mode,type,oid] = meta!.split(' ');
    if (!path || type !== 'blob' || !['100644','100755'].includes(mode!)) throw new Error('Task worktrees currently require regular files; symlinks and submodules are unsupported');
    const target = safePath(workdir,path,false); mkdirSync(dirname(target),{recursive:true});
    writeFileSync(target,git(source,['cat-file','blob',oid!]),{mode:mode==='100755'?0o755:0o644});
  }
  // Populate index without checkout filters or hooks so diffs have the correct baseline.
  git(workdir,['read-tree',baseline]); return baseline;
}
export function safePath(root: string, path: string, mustExist = true): string {
  if (!path || isAbsolute(path) || path.includes('\0')) throw new Error('Expected a relative file path');
  const base = realpathSync(root), target = resolve(base,path), rel = relative(base,target);
  if (!rel || rel.startsWith('../') || rel==='..' || isAbsolute(rel) || rel.split(/[\\/]/).some(p=>p==='.git')) throw new Error('Path is outside the allowed workspace');
  let cursor=base;
  for (const part of rel.split('/')) { cursor=join(cursor,part); try { if (lstatSync(cursor).isSymbolicLink()) throw new Error('Symbolic links are not supported'); } catch(error) { if ((error as NodeJS.ErrnoException).code!=='ENOENT') throw error; } }
  if (mustExist && !existsSync(target)) throw new Error('File not found'); return target;
}
export function files(root: string): string[] {
  const result:string[]=[]; let bytes=0;
  function walk(dir:string) { for(const item of readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
    if (['.git','node_modules','.knotrail'].includes(item.name)) continue;
    const full=join(dir,item.name), rel=relative(root,full);
    if(item.isSymbolicLink()) throw new Error('Workspace contains a symbolic link; inspect it before resuming');
    if(item.isDirectory()) walk(full); else if(item.isFile()) { bytes+=lstatSync(full).size; result.push(rel); if(result.length>30_000 || bytes>128*1024*1024) throw new Error('Workspace evidence limit exceeded (30,000 files / 128 MiB)'); }
  } }
  walk(root); return result;
}
export function workspaceDigest(root: string): string { const h=createHash('sha256'); for(const path of files(root)) { h.update(path+'\0'); h.update(readFileSync(safePath(root,path))); h.update('\0'+(lstatSync(join(root,path)).mode&0o777)); } return h.digest('hex'); }
export function readText(root: string, path: string): {content:string;truncated:boolean} { const target=safePath(root,path); const stat=lstatSync(target); if(!stat.isFile()) throw new Error('Expected a regular file'); const fd=openSync(target,constants.O_RDONLY|constants.O_NOFOLLOW); try { const bytes=readFileSync(fd); if(bytes.subarray(0,8192).includes(0)) throw new Error('Binary preview is unavailable'); return {content:bytes.subarray(0,256_000).toString('utf8'),truncated:bytes.length>256_000}; } finally {closeSync(fd);} }
// A binding is a complete, bounded snapshot; previews must never stand in for one.
export function readFileSnapshot(root:string,path:string):{source:FileSource;content:string} {
  const canonical=realpathSync(root),base=lstatSync(canonical),target=safePath(canonical,path,false),normalized=relative(canonical,target);
  const sourceIdentity=digest(JSON.stringify([canonical,base.dev,base.ino,normalized]));let fd:number;
  try {fd=openSync(target,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;safePath(canonical,path,false);return {source:{path:normalized,exists:false,sourceDigest:null,sourceIdentity},content:''};}
  try {
    const before=fstatSync(fd),limit=2*1024*1024;
    if(!before.isFile()||before.size>limit)throw new Error('Input/output snapshots require regular UTF-8 files no larger than 2 MiB');
    const buffer=Buffer.alloc(limit+1);let size=0,count=0;
    do {count=readSync(fd,buffer,size,buffer.length-size,null);size+=count;}while(count&&size<buffer.length);
    const after=fstatSync(fd),current=lstatSync(safePath(canonical,path));
    if(size>limit||size!==before.size||after.size!==size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs||current.dev!==before.dev||current.ino!==before.ino||current.ctimeMs!==after.ctimeMs)throw new Error('Input/output source changed during snapshot');
    const bytes=buffer.subarray(0,size);if(bytes.includes(0))throw new Error('Binary input/output snapshots are unsupported');
    const content=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
    return {source:{path:normalized,exists:true,sourceDigest:digest(bytes),sourceIdentity,mode:after.mode&0o777},content};
  } finally {closeSync(fd);}
}
function tree(root: string): {mode:string;oid:string;path:string}[] {
  return git(root,['ls-tree','-rz','--full-tree','HEAD']).toString().split('\0').filter(Boolean).map(entry=>{
    const tab=entry.indexOf('\t'),[mode,type,oid]=entry.slice(0,tab).split(' '),path=entry.slice(tab+1);
    if(tab<0||!path||type!=='blob'||!['100644','100755'].includes(mode!))throw new Error('Task worktrees currently require regular files; symlinks and submodules are unsupported');
    safePath(root,path,false);return {mode:mode!,oid:oid!,path};
  });
}
function assertClean(root:string):void {
  const entries=tree(root),index=git(root,['ls-files','--stage','-z']).toString().split('\0').filter(Boolean).sort();
  const expected=entries.map(e=>`${e.mode} ${e.oid} 0\t${e.path}`).sort();
  let dirty=JSON.stringify(index)!==JSON.stringify(expected)||git(root,['ls-files','--others','--exclude-standard','-z']).length>0;
  for(const entry of entries){const path=safePath(root,entry.path,false);if(!existsSync(path)||!lstatSync(path).isFile()){dirty=true;continue;}if(!readFileSync(path).equals(git(root,['cat-file','blob',entry.oid]))||Boolean(lstatSync(path).mode&0o111)!==(entry.mode==='100755'))dirty=true;}
  if(dirty)throw new Error('Commit or move aside source changes before creating an isolated task. No files were changed.');
}
export function workspaceDiff(root: string): string {
  const temporary=mkdtempSync(join(tmpdir(),'knotrail-diff-'));let output='';
  try {
    const entries=tree(root),untracked=git(root,['ls-files','--others','--exclude-standard','-z']).toString().split('\0').filter(Boolean);
    const items=[...entries,...untracked.map(path=>({mode:'100644',oid:'',path}))];
    for(const entry of items){
      const path=safePath(root,entry.path,false),before=entry.oid?git(root,['cat-file','blob',entry.oid]):Buffer.alloc(0),after=existsSync(path)?readFileSync(path):Buffer.alloc(0);
      const oldMode=entry.oid?entry.mode:'000000',newMode=existsSync(path)?(lstatSync(path).mode&0o111?'100755':'100644'):'000000';
      if(before.equals(after)&&oldMode===newMode)continue;
      output+=`diff --git a/${entry.path} b/${entry.path}\n`;
      if(oldMode!==newMode)output+=`old mode ${oldMode}\nnew mode ${newMode}\n`;
      if(before.includes(0)||after.includes(0)){output+='Binary files differ\n';continue;}
      writeFileSync(join(temporary,'before'),before);writeFileSync(join(temporary,'after'),after);
      const result=spawnSync('/usr/bin/diff',['-u','-L',entry.oid?'a/'+entry.path:'/dev/null','-L',existsSync(path)?'b/'+entry.path:'/dev/null',join(temporary,'before'),join(temporary,'after')],{encoding:'utf8',timeout:10000,maxBuffer:512000,env:{PATH:'/usr/bin:/bin'}});
      if(result.error||!([0,1].includes(result.status??-1)))throw new Error('Could not generate a bounded workspace diff');output+=result.stdout;
      if(output.length>=256000)return output.slice(0,256000);
    }
    return output;
  }finally{rmSync(temporary,{recursive:true,force:true});}
}
