import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile(new URL('../electron/main.mjs',import.meta.url),'utf8');
const code=source.slice(source.indexOf("ipcMain.handle('reading:source-chapter'"),source.indexOf("ipcMain.handle('reading:books-ready'"));
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
function harness(){
 const handlers=new Map(),events=[],calls=[];
 const entry={id:'book_0123456789abcdef',bookId:'0123456789abcdef'};
 const span={quote:'核验原文',text_hash:'a'.repeat(64),href:'a.xhtml'};
 const context={ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},trustedBooks:()=>true,businessEnabled:true,book:{id:entry.id},activeSession:'session-one',selectionTokens:new Map(),randomUUID:()=> 'test-selection-token',Date,Error,Number,library:{getSourceChapter:async()=>({ok:true}),get:async()=>entry},runtime:{call:async(action,payload)=>{calls.push({action,payload});return action==='business:source'?{span}:{ok:true};}},setImmersive:async()=>{},transitionLayout:async callback=>callback(),chatVisible:true,chatExpanded:false,compactChat:false,window:{webContents:{send:(...args)=>events.push(args)}}};
 vm.runInNewContext(code,context);
 return {context,events,calls,entry,span,chapter:()=>handlers.get('reading:source-chapter')({}, {bookId:entry.id,href:'a.xhtml'}),select:token=>handlers.get('reading:selection')({}, {bookId:entry.id,selectionToken:token,section_order:0,start_codepoint:0,end_codepoint:4,...span})};
}
test('session change while source chapter awaits refuses token before selection',async()=>{const h=harness(),wait=deferred();h.context.library.getSourceChapter=()=>wait.promise;const pending=h.chapter();h.context.activeSession='session-two';wait.resolve({ok:true});await assert.rejects(pending,/会话或书籍已切换/);assert.equal(h.context.selectionTokens.size,0);assert.equal(h.events.length,0);});
test('session change after chapter response rejects one-use selection token',async()=>{const h=harness(),mapping=await h.chapter();h.context.activeSession='session-two';const result=await h.select(mapping.selectionToken);assert.equal(result.ok,false);assert.equal(h.calls.length,0);assert.equal(h.events.length,0);assert.equal(h.context.selectionTokens.size,0);});
test('prepare failure never returns success or emits prepared event',async()=>{const h=harness(),mapping=await h.chapter();h.context.runtime.call=async action=>{if(action==='business:prepare')throw Error('注入的保存失败');return {span:h.span};};const result=await h.select(mapping.selectionToken);assert.equal(result.ok,false);assert.match(result.message,/保存失败/);assert.equal(h.events.length,0);const retry=await h.select(mapping.selectionToken);assert.equal(retry.ok,false);});
test('success waits for prepare durability and targets original session',async()=>{const h=harness(),mapping=await h.chapter(),wait=deferred(),entered=deferred();h.context.runtime.call=async(action,payload)=>{h.calls.push({action,payload});if(action==='business:prepare'){entered.resolve();return wait.promise;}return {span:h.span};};let finished=false;const pending=h.select(mapping.selectionToken).then(x=>{finished=true;return x;});await entered.promise;assert.equal(finished,false);assert.equal(h.events.length,0);wait.resolve({ok:true});assert.equal((await pending).ok,true);assert.equal(h.events[0][1].sessionId,'session-one');assert.equal(h.events[0][1].prepared,true);});
