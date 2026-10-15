import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile,symlink,realpath} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {resolveCodexPath} from './codex-path.mjs';
async function fixture(fn){const root=await realpath(await mkdtemp(path.join(tmpdir(),'codex-path-')));try{await fn(root);}finally{await rm(root,{recursive:true,force:true});}}
async function binary(file){await mkdir(path.dirname(file),{recursive:true});await writeFile(file,Buffer.from('cffaedfe00000000','hex'),{mode:0o755});return file;}
test('explicit native has priority; invalid explicit never silently falls back',()=>fixture(async root=>{const file=await binary(path.join(root,'native'));assert.deepEqual(await resolveCodexPath({env:{AI_READING_CODEX:file,PATH:''},home:root}),{path:file,source:'explicit'});await assert.rejects(resolveCodexPath({env:{AI_READING_CODEX:'/missing/codex',PATH:''},home:root}));}));
test('official npm wrapper unwraps native without evaluating JS',()=>fixture(async root=>{const pkg=path.join(root,'lib/node_modules/@openai/codex');await mkdir(path.join(pkg,'bin'),{recursive:true});await writeFile(path.join(pkg,'package.json'),JSON.stringify({name:'@openai/codex'}));await writeFile(path.join(pkg,'bin/codex.js'),'throw Error("must never execute");');const native=await binary(path.join(pkg,'vendor/aarch64-apple-darwin/bin/codex'));await mkdir(path.join(root,'bin'));await symlink('../lib/node_modules/@openai/codex/bin/codex.js',path.join(root,'bin/codex'));assert.equal((await resolveCodexPath({env:{PATH:path.join(root,'bin')},home:root,platform:'darwin',arch:'arm64'})).path,native);}));
test('nvm lookup is bounded to installed toolchains; absent CLI explicit error',()=>fixture(async root=>{const native=await binary(path.join(root,'.nvm/versions/node/v24.1.0/bin/codex'));assert.deepEqual(await resolveCodexPath({env:{PATH:''},home:root,applicationCandidates:[]}),{path:native,source:'installed-nvm'});await assert.rejects(resolveCodexPath({env:{PATH:''},home:path.join(root,'empty'),applicationCandidates:[]}));}));
