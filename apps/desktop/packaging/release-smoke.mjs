import {_electron as electron} from 'playwright';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

const root=resolve(import.meta.dirname,'../../..');
const appPath=resolve(process.argv[2]??join(root,'dist/release-v0.1.0/AI 深度阅读.app'));
const output=resolve(process.argv[3]??join(root,'dist/release-v0.1.0/release-smoke.json'));
const directory=await mkdtemp(join(tmpdir(),'reading-release-'));
await mkdir(join(directory,'home'));
const env={PATH:'/usr/bin:/bin',HOME:join(directory,'home'),TMPDIR:tmpdir(),LANG:'en_US.UTF-8',AI_READING_DATA_DIR:join(directory,'data'),AI_READING_DISABLE_AI:'1',AI_READING_USE_HOST_MODEL:'0'};
const checks=[];let app,shell,books,failure;
await rm(output,{force:true});
async function until(predicate,label){
  const deadline=Date.now()+60000;
  while(Date.now()<deadline){if(await predicate())return;await new Promise(r=>setTimeout(r,100));}
  throw Error('Timed out: '+label);
}
async function launch(){
  app=await electron.launch({executablePath:join(appPath,'Contents/MacOS/AIReading'),env,args:[]});
  shell=await app.firstWindow();await shell.waitForURL('reading-app://shell/index.html');
  await until(()=>shell.evaluate(async()=>(await readingApp.getState()).runtime.state==='ready'),'real bundled Harness readiness');
  books=app.context().pages().find(page=>page.url()==='reading-app://reader/books.html');assert.ok(books);
  const info=await app.evaluate(({app,BrowserWindow})=>({packaged:app.isPackaged,visible:BrowserWindow.getAllWindows()[0].isVisible(),node:process.env.AI_READING_NODE,python:process.env.AI_READING_PYTHON,codex:process.env.AI_READING_CODEX,noBytecode:process.env.PYTHONDONTWRITEBYTECODE}));
  assert.equal(info.packaged,true);assert.equal(info.visible,true);assert.equal(info.noBytecode,'1');
  for(const key of ['node','python','codex'])assert.ok(info[key].startsWith(appPath+'/'));
  assert.equal((await shell.evaluate(()=>readingApp.getState())).runtime.model.available,false);
}
async function close(){
  if(!app)return;const current=app;app=null;const done=current.waitForEvent('close',{timeout:30000});
  await current.evaluate(({app})=>app.quit());await done;
}
async function readable(){await until(()=>books.evaluate(()=>document.querySelector('foliate-view')?.renderer?.getContents?.().some(x=>x.doc?.querySelector('#readable-token')?.textContent==='REFLOW_READABLE')),'synthetic EPUB text');}
try{
  const generated=spawnSync(process.execPath,[join(root,'packages/reader-ui/scripts/make-security-fixtures.mjs')],{stdio:'inherit'});
  assert.equal(generated.status,0);
  await launch();assert.deepEqual((await books.evaluate(()=>readingDesktopBooks.list())).books,[]);
  checks.push('packaged-native-window-empty-library-and-bundled-runtimes-ready-with-restricted-PATH');
  await shell.evaluate(()=>readingApp.selectView('books'));
  await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},join(root,'packages/reader-ui/fixtures/security/security-reflow.epub'));
  await books.locator('#library-menu').click();await books.getByRole('button',{name:'导入 EPUB…',exact:true}).click();
  await until(async()=>(await books.evaluate(()=>readingDesktopBooks.list())).books.length===1,'import synthetic EPUB');
  await books.locator('.cover-open').click();await readable();
  const original=await shell.evaluate(()=>readingApp.getState());
  const source=await books.evaluate(()=>{const doc=document.querySelector('foliate-view').renderer.getContents()[0].doc;return {ran:doc.documentElement.hasAttribute('data-security-probe-executed'),node:typeof doc.defaultView.process,script:typeof doc.defaultView.__epubSecurityProbe}});
  assert.deepEqual(source,{ran:false,node:'undefined',script:'undefined'});
  checks.push('synthetic-EPUB-copy-import-readable-text-and-script-isolation');
  await shell.locator('#question').fill('合成发布测试：未发送问题');
  const anchor=await books.evaluate(()=>document.querySelector('foliate-view').lastLocation.cfi);
  for(const tool of ['notes','guide','annotations','chat']){
    await shell.locator('#tool-'+tool).click();
    await until(()=>shell.evaluate(async t=>(await readingApp.getState()).rightTool===t,tool),'tool '+tool);
    assert.equal((await shell.evaluate(()=>readingApp.getState())).book.id,original.book.id);
    assert.equal(await books.evaluate(()=>document.querySelector('foliate-view').lastLocation.cfi),anchor);
  }
  assert.equal(await shell.locator('#question').inputValue(),'合成发布测试：未发送问题');
  checks.push('four-tools-preserve-book-location-and-unsent-draft');
  await close();await launch();assert.equal((await books.evaluate(()=>readingDesktopBooks.list())).books.length,1);await readable();
  await until(async()=>await shell.locator('#question').inputValue()==='合成发布测试：未发送问题','restored draft');
  checks.push('restart-restores-library-reading-and-unsent-draft');
}catch(error){failure=error;}
finally{
  try{await close();}catch(error){failure??=error;}
  try{await rm(directory,{recursive:true,force:true});}catch(error){failure??=error;}
  const result={passed:!failure,checks,modelCalls:0,syntheticBooksOnly:true,globalNodePythonRequired:false,...failure?{error:failure.message}:{}};
  await writeFile(output,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
}
if(failure)throw failure;
