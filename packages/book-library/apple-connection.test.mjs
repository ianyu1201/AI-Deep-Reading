import test from 'node:test';
import assert from 'node:assert/strict';
import {AppleBooksConnection,displayBookTitle} from '../../apps/desktop/electron/apple-books-connection.mjs';

test('opaque discovery, batch results, duplicate selections and source failure isolation',async()=>{
 const events=[];let imported=[];
 const library={scanAppleBooks:async()=>({books:[
  {id:'a',path:'/private/a',available:true,title:'A'}, {id:'b',path:'/private/b',available:true,title:'B'},
  {id:'c',path:'/private/c',available:false,title:'C',status:'not-downloaded',reason:'尚未下载'},
  {id:'d',path:'/private/d',available:true,title:'D'}],issues:[]}),
  importFile:async path=>{imported.push(path); if(path.endsWith('b'))throw Error('private error');return {id:'book_'+path.at(-1),title:path.at(-1),alreadyImported:path.endsWith('d')};}};
 const connection=new AppleBooksConnection({library,onProgress:e=>events.push(e)});
 const scan=await connection.scan();assert.ok(scan.books.every(b=>!('path'in b)));
 const result=await connection.importSelected(['a','a','b','c','d']);
 assert.equal(result.imported,1);assert.equal(result.duplicates,1);assert.equal(result.failed,2);
 assert.equal(imported.length,3);assert.equal(events.at(-1).completed,4);
 assert.ok(!JSON.stringify(result).includes('/private'));
 await assert.rejects(connection.importSelected(['/etc/passwd']));
 assert.equal(connection.disconnect().retainedLibrary,true);
 await assert.rejects(connection.importSelected(['a']));
});
test('reject overlapping batch and refresh, settle after failures',async()=>{
 let finish;const library={scanAppleBooks:async()=>({books:[{id:'a',path:'x',available:true}],issues:[]}),importFile:()=>new Promise(r=>finish=r)};
 const c=new AppleBooksConnection({library});await c.scan(); const task=c.importSelected(['a']);
 await assert.rejects(c.scan());await assert.rejects(c.importSelected(['a']));assert.throws(()=>c.disconnect());
 finish({id:'book',title:'Book'});await task; assert.equal(c.busy,false);await c.scan();
});
test('display shortening retains meaningful title, original data unchanged',()=>{
 const raw='创造：用非传统方式做有价值的事（罗永浩等推荐，iPod之父、iPhone设计者的成事心法！）';
 assert.equal(displayBookTitle(raw),'创造：用非传统方式做有价值的事');
 assert.equal(displayBookTitle('系统之美（修订版）'),'系统之美（修订版）');
});
