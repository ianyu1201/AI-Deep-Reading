import test from 'node:test';
import assert from 'node:assert/strict';
import {getBookNotes,getFixtureNotes} from '../electron/note-context.mjs';
import {makeNoteTree,folderPaths,noteSnapshot} from '../../../packages/reader-ui/src/note-tree.js';
test('production does not infer book links or load fixture data',()=>{
 const previous=process.env.AI_READING_TEST;delete process.env.AI_READING_TEST;
 try{assert.equal(getBookNotes('11',{fixture:'workspace-links'}).available,false);assert.deepEqual(getFixtureNotes('workspace-links'),[])}
 finally{if(previous!==undefined)process.env.AI_READING_TEST=previous}
});
test('explicit test fixture links exact IDs and exposes metadata only',()=>{
 const previous=process.env.AI_READING_TEST;process.env.AI_READING_TEST='1';
 try{
  assert.equal(getBookNotes('11').available,false);
  const alice=getBookNotes('11',{fixture:'workspace-links'}),pride=getBookNotes('1342',{fixture:'workspace-links'});
  assert.equal(alice.kind,'synthetic-fixture');assert.equal(alice.notes.length,2);assert.equal(pride.notes.length,1);
  assert.equal(alice.notes[0].name,pride.notes[0].name);assert.notEqual(alice.notes[0].id,pride.notes[0].id);
  assert.equal('body' in alice.notes[0],false);assert.deepEqual(getBookNotes('Alice',{fixture:'workspace-links'}).notes,[]);
  const seeded=getFixtureNotes('workspace-links');seeded[0].body='mutated';assert.notEqual(getFixtureNotes('workspace-links')[0].body,'mutated');
 }finally{if(previous===undefined)delete process.env.AI_READING_TEST;else process.env.AI_READING_TEST=previous}
});
test('folder projection retains nested paths, root files, same-name identity and draft privacy',()=>{
 const notes=[{id:'a',name:'摘录',folder:'阅读笔记/章节',body:'private a'},{id:'b',name:'摘录',folder:'阅读笔记/问题',body:'private b'},{id:'c',name:'索引',folder:'',body:'private c'}];
 const tree=makeNoteTree(notes);assert.deepEqual(folderPaths(tree),['阅读笔记','阅读笔记/章节','阅读笔记/问题']);
 assert.equal(tree.folders[0].folders[0].notes[0].id,'a');assert.equal(tree.folders[0].folders[1].notes[0].id,'b');assert.equal(tree.notes[0].id,'c');
 const snapshot=noteSnapshot(notes,'b');assert.equal(snapshot.activeId,'b');assert.equal(JSON.stringify(snapshot).includes('private'),false);
 snapshot.notes[0].name='changed';assert.equal(notes[0].name,'摘录');
});
