import {_electron as electron} from 'playwright';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {spawnSync} from 'node:child_process';

const base=resolve(import.meta.dirname,'..'),root=resolve(base,'../..');
const directory=await mkdtemp(join(tmpdir(),'ai-reading-public-smoke-'));
const home=join(directory,'home');await mkdir(home);
const fixtureScript=join(root,'packages/reader-ui/scripts/make-security-fixtures.mjs');
const generated=spawnSync(process.execPath,[fixtureScript],{stdio:'inherit'});
if(generated.status!==0)throw Error('Could not generate original EPUB fixtures');
const fixture=join(root,'packages/reader-ui/fixtures/security/security-reflow.epub');
const env={...Object.fromEntries(['PATH','TMPDIR','LANG','LC_ALL'].filter(k=>process.env[k]).map(k=>[k,process.env[k]])),HOME:home,AI_READING_NODE:process.execPath,AI_READING_TEST:'1',AI_READING_BUSINESS_TEST:'1',AI_READING_DATA_DIR:join(directory,'data'),AI_READING_DISABLE_AI:'1',AI_READING_USE_HOST_MODEL:'0'};
const checks=[];let app,shell,books;
async function until(predicate,label){
  const end=Date.now()+45000;
  while(Date.now()<end){if(await predicate())return;await new Promise(r=>setTimeout(r,80));}
  throw Error('Timed out: '+label);
}
async function launch(){
  app=await electron.launch({args:[base],env});shell=await app.firstWindow();
  await shell.waitForURL('reading-app://shell/index.html');
  await until(()=>app.evaluate(()=>!!globalThis.__readingTest),'test hooks');
  await until(()=>app.evaluate(()=>globalThis.__readingTest.runtime.getStatus().state==='ready'),'real Harness readiness');
  books=app.context().pages().find(page=>page.url()==='reading-app://reader/books.html');
  assert.ok(books);
  assert.equal(await app.evaluate(()=>globalThis.__readingTest.runtime.getStatus().model.available),false);
}
async function close(){
  if(!app)return;const current=app;app=null;
  const done=current.waitForEvent('close');
  await current.evaluate(()=>void globalThis.__readingTest.closeApp());await done;
}
async function readable(){
  await until(()=>books.evaluate(()=>document.querySelector('foliate-view')?.renderer?.getContents?.().some(item=>item.doc?.querySelector('#readable-token')?.textContent==='REFLOW_READABLE')),'original synthetic EPUB text');
}
try{
  await launch();checks.push('native-window-and-real-Harness-with-AI-disabled');
  assert.deepEqual((await books.evaluate(()=>readingDesktopBooks.list())).books,[]);
  await shell.evaluate(()=>readingApp.selectView('books'));
  await books.locator('#library-empty').waitFor({state:'visible'});
  checks.push('clean-empty-library');
  // The file dialog is deterministic; import, copy, IPC and renderer are real.
  await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},fixture);
  await books.locator('#library-menu').click();
  await books.getByRole('button',{name:'导入 EPUB…',exact:true}).click();
  await until(async()=>(await books.evaluate(()=>readingDesktopBooks.list())).books.length===1,'EPUB import');
  await books.locator('.cover-open').click();await readable();
  const original=await shell.evaluate(()=>readingApp.getState());assert.ok(original.book?.id);
  const source=await books.evaluate(()=>{
    const doc=document.querySelector('foliate-view').renderer.getContents()[0].doc;
    return {probe:doc.documentElement.hasAttribute('data-security-probe-executed'),node:typeof doc.defaultView.process,script:typeof doc.defaultView.__epubSecurityProbe};
  });
  assert.deepEqual(source,{probe:false,node:'undefined',script:'undefined'});
  checks.push('original-EPUB-import-and-readable-text-with-content-scripts-disabled');
  await until(()=>shell.locator('#question').isVisible(),'chat composer');
  await shell.locator('#question').fill('合成测试：未发送的阅读问题');
  const anchor=await books.evaluate(()=>document.querySelector('foliate-view').lastLocation.cfi);
  for(const tool of ['notes','guide','annotations','chat']){
    await shell.locator('#tool-'+tool).click();
    await until(()=>shell.evaluate(async name=>(await readingApp.getState()).rightTool===name,tool),'right tool '+tool);
    assert.equal((await shell.evaluate(()=>readingApp.getState())).book.id,original.book.id);
    assert.equal(await books.evaluate(()=>document.querySelector('foliate-view').lastLocation.cfi),anchor);
  }
  assert.equal(await shell.locator('#question').inputValue(),'合成测试：未发送的阅读问题');
  checks.push('four-tools-preserve-book-anchor-and-unsent-draft');
  await close();await launch();
  assert.equal((await books.evaluate(()=>readingDesktopBooks.list())).books.length,1);
  await readable();
  await until(async()=>await shell.locator('#question').inputValue()==='合成测试：未发送的阅读问题','draft restoration');
  checks.push('restart-restores-library-reading-and-draft');
  console.log(JSON.stringify({passed:true,checks,modelCalls:0,syntheticBooksOnly:true},null,2));
}finally{await close();await rm(directory,{recursive:true,force:true});}
