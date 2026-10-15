import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {writeAtomicJson} from './atomic-json-store.mjs';

async function fixture(t) {
 const base=await mkdtemp(join(tmpdir(),'reading-atomic-json-'));
 t.after(()=>rm(base,{recursive:true,force:true}));
 const root=join(base,'store'),file=join(root,'records.json');
 return {root,file};
}
test('commit hook sees a complete private temp file while old bytes remain unchanged',async t=>{
 const {root,file}=await fixture(t);await mkdir(root,{mode:0o700});await writeFile(file,'old bytes');
 const value={records:[{note:'😀原文'}]};let inspected=false;
 await writeAtomicJson({root,file,value,beforeCommit:async()=>{
  assert.equal(await readFile(file,'utf8'),'old bytes');
  const temps=(await readdir(root)).filter(n=>n.endsWith('.tmp'));assert.equal(temps.length,1);
  const temp=join(root,temps[0]);assert.equal(await readFile(temp,'utf8'),JSON.stringify(value,null,2));
  assert.equal((await stat(temp)).mode&0o777,0o600);inspected=true;
 }});
 assert.equal(inspected,true);assert.equal((await stat(root)).mode&0o777,0o700);
 assert.equal((await stat(file)).mode&0o777,0o600);assert.deepEqual(JSON.parse(await readFile(file,'utf8')),value);
 assert.deepEqual(await readdir(root),['records.json']);
});
test('serialization and precommit failures retain original bytes and remove temporary files',async t=>{
 const {root,file}=await fixture(t);await mkdir(root);await writeFile(file,'old bytes');
 const circular={};circular.self=circular;
 await assert.rejects(writeAtomicJson({root,file,value:circular,beforeCommit:async()=>{}}),/circular/i);
 await assert.rejects(writeAtomicJson({root,file,value:{changed:true},beforeCommit:async()=>{throw Error('disk full')}}),/disk full/);
 assert.equal(await readFile(file,'utf8'),'old bytes');assert.deepEqual(await readdir(root),['records.json']);
 await writeAtomicJson({root,file,value:{retried:true},beforeCommit:async()=>{}});
 assert.deepEqual(JSON.parse(await readFile(file,'utf8')),{retried:true});
});
test('rename failure preserves destination and cleans temporary files',async t=>{
 const {root,file}=await fixture(t);await mkdir(file,{recursive:true});await writeFile(join(file,'sentinel'),'kept');
 await assert.rejects(writeAtomicJson({root,file,value:{changed:true},beforeCommit:async()=>{}}));
 assert.equal(await readFile(join(file,'sentinel'),'utf8'),'kept');assert.deepEqual(await readdir(root),['records.json']);
});
