import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {ReadingPosition} from '../src/reading-position.js';
import {installLifecycle} from '../src/lifecycle.js';

const read=path=>readFile(new URL(path,import.meta.url),'utf8');

test('both EPUB layout paths disable content scripts and retain native blob loading',async()=>{
 for(const file of ['paginator.js','fixed-layout.js']){
  const source=await read('../vendor/foliate-js/'+file);
  assert.match(source,/setAttribute\('sandbox', 'allow-same-origin'\)/);
  assert.doesNotMatch(source,/allow-scripts|\.srcdoc/);
 }
});

// Original provenance remains historical; both CSS files now have authorized UI changes.
test('each isolated page receives the canonical semantic palette',async()=>{
 const canonical=await read('../../ui-theme/theme.css');
 assert.equal(await read('../dist/theme.css'),canonical);
 assert.equal(await read('../../../apps/desktop/shell/theme.css'),canonical);
 for(const page of ['books','markdown'])assert.match(await read('../src/'+page+'.html'),/href="theme.css"/);
 assert.match(await read('../../../apps/desktop/shell/index.html'),/href="\.\/theme.css"/);
});

test('source release starts with an empty catalog and contains no bundled books',async()=>{
 const catalog=JSON.parse(await read('../fixtures/books-assets/catalog.json'));
 assert.deepEqual(catalog,[]);
 const {readdir}=await import('node:fs/promises');
 assert.deepEqual(await readdir(new URL('../fixtures/books-assets/',import.meta.url)),['catalog.json']);
});

test('layout activation preserves the last stable reading anchor',async()=>{
 const writes=[],position=new ReadingPosition(value=>writes.push({...value}));
 const stable={cfi:'epubcfi(/6/2!/4/2:4)',fraction:0.25};
 position.begin();position.loaded(stable);
 const restored=[];
 await position.reflow({
  apply:async()=>position.observe({cfi:'epubcfi(/6/2!/4/2:0)',fraction:0.2}),
  settle:async()=>{},restore:async value=>restored.push(value)
 });
 assert.deepEqual(restored,[stable.cfi]);
 assert.deepEqual(writes,[stable,stable]);
 assert.equal(position.locked,false);
});

test('closing/replacing a book during activation cannot restore its stale anchor',async()=>{
 const position=new ReadingPosition(()=>{});let restored=false;
 position.begin();position.loaded({cfi:'epubcfi(/6/2!/4/2:4)',fraction:0.25});
 const result=await position.reflow({apply:async()=>position.begin(),settle:async()=>{},restore:async()=>{restored=true}});
 assert.equal(result,false);assert.equal(restored,false);
});

test('lifecycle exposes fixed readiness and flush, reports persistence failure, and activates through a fixed event',async()=>{
 const previous=globalThis.window,window=new EventTarget();globalThis.window=window;
 let activated=0,shouldSave=false;
 try{
  installLifecycle({view:'markdown',activate:()=>{activated++},flush:()=>shouldSave});
  assert.deepEqual(Object.keys(window.aiReadingLifecycle),['ready','flush']);
  assert.equal(Object.isFrozen(window.aiReadingLifecycle),true);
  assert.deepEqual(await window.aiReadingLifecycle.flush(),{ok:false,kind:'browser-draft',view:'markdown'});
  shouldSave=true;
  assert.equal((await window.aiReadingLifecycle.flush()).ok,true);
  window.dispatchEvent(new Event('ai-reading:activate'));
  await Promise.resolve();await Promise.resolve();
  assert.equal(activated,1);
 }finally{globalThis.window=previous}
});

test('resize protection starts before debounced reflow and releases for real page turns',async()=>{
 const writes=[],position=new ReadingPosition(value=>writes.push({...value}));
 const anchor={cfi:'epubcfi(/6/6!/4/2/16)',fraction:0.3};
 const resized={cfi:'epubcfi(/6/6!/4/2/14)',fraction:0.28};
 const next={cfi:'epubcfi(/6/6!/4/2/24)',fraction:0.4};
 position.begin();position.loaded(anchor);position.hold();
 assert.equal(position.observe(resized),false);assert.deepEqual(position.last,anchor);
 const restored=[];await position.reflow({apply:async()=>{},settle:async()=>{},restore:async cfi=>restored.push(cfi)});
 assert.deepEqual(restored,[anchor.cfi]);assert.equal(position.suspended,false);
 assert.equal(position.observe(next),true);assert.deepEqual(position.last,next);
});

test('hold during an active reflow is replayed and never leaves page saving suspended',async()=>{
 const position=new ReadingPosition(()=>{});position.begin();position.loaded({cfi:'epubcfi(/6/6!/4/2/16)',fraction:0.3});
 let passes=0;
 await position.reflow({apply:async()=>{if(++passes===1)position.hold()},settle:async()=>{},restore:async()=>{}});
 assert.equal(passes,2);assert.equal(position.suspended,false);assert.equal(position.locked,false);
 assert.equal(position.observe({cfi:'epubcfi(/6/6!/4/2/24)',fraction:0.4}),true);
});
test('activation requested during preference reflow is queued instead of dropped',async()=>{
 const position=new ReadingPosition(()=>{});position.begin();position.loaded({cfi:'epubcfi(/6/6!/4/2/16)',fraction:0.3});
 let queued,activations=0;
 await position.reflow({apply:async()=>{if(!queued){position.hold();queued=position.reflow({apply:async()=>{activations++},settle:async()=>{},restore:async()=>{}})}},settle:async()=>{},restore:async()=>{}});
 await queued;assert.equal(activations,1);assert.equal(position.suspended,false);assert.equal(position.locked,false);
});
