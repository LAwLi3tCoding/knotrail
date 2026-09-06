import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareWorktree, workspaceDiff } from '../src/core/workspace.js';
test('Git broker never invokes repository clean filters when rejecting dirty files or generating diffs',t=>{
 const root=mkdtempSync(join(tmpdir(),'knotrail-filter-')),source=join(root,'source'),marker=join(root,'filter-ran');mkdirSync(source);t.after(()=>rmSync(root,{recursive:true,force:true}));
 const env={...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.org',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.org'};
 const git=(args:string[])=>execFileSync('git',args,{cwd:source,env,stdio:'ignore'});git(['init']);writeFileSync(join(source,'sample.txt'),'sample');writeFileSync(join(source,'.gitattributes'),'sample.txt filter=fixture\n');git(['add','.']);git(['commit','-m','fixture']);
 const script=join(root,'filter.sh');writeFileSync(script,`#!/bin/sh\nprintf called > '${marker.replaceAll("'","'\\''")}'\ncat\n`,{mode:0o755});git(['config','filter.fixture.clean',script]);
 writeFileSync(join(source,'sample.txt'),'change');assert.throws(()=>prepareWorktree(source,join(root,'worktree')),/source changes/);assert.equal(existsSync(marker),false);assert.ok(workspaceDiff(source).includes('+change'));assert.equal(existsSync(marker),false);
});
