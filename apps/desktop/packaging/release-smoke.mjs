import {_electron as electron} from 'playwright';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {composeNote} from '../../../dsh-apple-read/lib/reading/schema.js';

const root=resolve(import.meta.dirname,'../../..');
const appPath=resolve(process.argv[2]??join(root,'dist/release-v0.1.0/AI 深度阅读.app'));
const output=resolve(process.argv[3]??join(appPath,'../release-smoke.json'));
const baselineApp=process.argv[4]?resolve(process.argv[4]):null;
const directory=await mkdtemp(join(tmpdir(),'reading-release-'));
await mkdir(join(directory,'home'));
const env={PATH:'/usr/bin:/bin',HOME:join(directory,'home'),TMPDIR:tmpdir(),LANG:'en_US.UTF-8',AI_READING_DATA_DIR:join(directory,'data'),AI_READING_DISABLE_AI:'1',AI_READING_USE_HOST_MODEL:'0'};
const checks=[];let app,shell,books,failure;
const noteId='理解变化/发布验收合成笔记.md';
const notePath=join(directory,'data/runtime/knowledge/45-书籍',noteId);
const initialBody='## 合成笔记\n\n发布验收正文。\n';
const savedBody='## 合成笔记\n\n已显式保存的中文正文。\n';
const draftBody=savedBody+'\n尚未保存的冲突草稿。\n';
const noteData={schema_version:'1.1',object_type:'insight',id:'in_release_smoke',revision:1,title:'发布验收合成笔记',tags:['reading','knowledge'],scope:'reading',knowledge_status:'active',created_at:'2026-10-15T00:00:00Z',updated_at:'2026-10-15T00:00:00Z',origin:'user',confirmation:'unconfirmed',confirmation_evidence:null,book_evidence:[{book_id:'bk_synthetic',book_version_id:'bv_synthetic',section_id:'sec_1',block_id:'bl_1',span_id:'sp_1',href:'Text/1.xhtml',start_codepoint:0,end_codepoint:3,text_hash:'a'.repeat(64),locator_quality:'exact_normalized_text',quote_type:'paraphrase'}],session_evidence:[],external_master:{status:'unverified',outcome:'not_authorized',check_id:'dc_synthetic',scope_refs:[],checked_at:null,authorization_revision:'consent_synthetic',candidate_refs:[],ref:null},dedup_check_ref:'dc_synthetic'};
await rm(output,{force:true});
async function until(predicate,label){
  const deadline=Date.now()+60000;
  while(Date.now()<deadline){if(await predicate())return;await new Promise(r=>setTimeout(r,100));}
  throw Error('Timed out: '+label);
}
async function launch(executableApp=appPath){
  app=await electron.launch({executablePath:join(executableApp,'Contents/MacOS/AIReading'),env,args:[]});
  shell=await app.firstWindow();await shell.waitForURL('reading-app://shell/index.html');
  await until(()=>shell.evaluate(async()=>(await readingApp.getState()).runtime.state==='ready'),'real bundled Harness readiness');
  books=app.context().pages().find(page=>page.url()==='reading-app://reader/books.html');assert.ok(books);
  const info=await app.evaluate(({app,BrowserWindow})=>({packaged:app.isPackaged,visible:BrowserWindow.getAllWindows()[0].isVisible(),node:process.env.AI_READING_NODE,python:process.env.AI_READING_PYTHON,codex:process.env.AI_READING_CODEX,noBytecode:process.env.PYTHONDONTWRITEBYTECODE}));
  assert.equal(info.packaged,true);assert.equal(info.visible,true);assert.equal(info.noBytecode,'1');
  for(const key of ['node','python','codex'])assert.ok(info[key].startsWith(executableApp+'/'));
  assert.equal((await shell.evaluate(()=>readingApp.getState())).runtime.model.available,false);
}
async function close(){
  if(!app)return;const current=app;app=null;const done=current.waitForEvent('close',{timeout:30000});
  await current.evaluate(({app})=>app.quit());await done;
}
async function readable(){await until(()=>books.evaluate(()=>document.querySelector('foliate-view')?.renderer?.getContents?.().some(x=>x.doc?.querySelector('#readable-token')?.textContent==='REFLOW_READABLE')),'synthetic EPUB text');}
async function openSyntheticNote(){
  await readable();
  await until(()=>shell.evaluate(async()=>!!(await readingApp.getState()).book?.open),'restored book context');
  await shell.evaluate(()=>readingApp.setNotesScope('all'));
  await until(()=>shell.evaluate(async id=>{const state=await readingApp.getState();return state.notesScope==='all'&&state.allNotes.notes.some(note=>note.id===id);},noteId),'all-note membership');
  await shell.evaluate(id=>readingApp.openNote(id),noteId);
  const markdown=app.context().pages().find(page=>page.url()==='reading-app://reader/markdown.html?formalNotes=1');
  assert.ok(markdown);
  await until(()=>markdown.evaluate(id=>aiReadingNotes.getSnapshot().activeId===id,noteId),'formal note open');
  return markdown;
}
try{
  const generated=spawnSync(process.execPath,[join(root,'packages/reader-ui/scripts/make-security-fixtures.mjs')],{stdio:'inherit'});
  assert.equal(generated.status,0);
  await mkdir(join(directory,'data/runtime/knowledge/45-书籍/理解变化'),{recursive:true});
  await writeFile(notePath,composeNote(noteData,initialBody));
  await launch(baselineApp??appPath);assert.deepEqual((await books.evaluate(()=>readingDesktopBooks.list())).books,[]);
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
  if(baselineApp)checks.push('upgrade-from-previous-bundle-preserves-the-same-synthetic-library-reading-and-draft');
  const markdown=await openSyntheticNote();
  const before=await markdown.evaluate(id=>readingNotes.call('read',{id}),noteId);
  assert.equal(before.result.readOnly,false);assert.equal(before.result.body,initialBody);
  if(await markdown.locator('#editor').isHidden())await markdown.locator('#note-mode').click();
  await markdown.locator('.cm-content').fill(savedBody);
  await markdown.locator('.cm-content').press('Meta+s');
  await until(()=>markdown.locator('#save-state').textContent().then(text=>text==='已保存'),'explicit Markdown save');
  const after=await markdown.evaluate(id=>readingNotes.call('read',{id}),noteId);
  assert.equal(after.result.body,savedBody);assert.equal(after.result.data.revision,2);
  assert.deepEqual(after.result.data.book_evidence,before.result.data.book_evidence);
  assert.equal(after.result.data.confirmation,'unconfirmed');
  checks.push('formal-Markdown-editor-explicit-save-preserves-YAML-source-and-confirmation');
  await markdown.locator('.cm-content').fill(draftBody);
  const diskVersion=(await readFile(notePath,'utf8')).replace(savedBody,savedBody+'\n外部编辑保留。\n');
  await writeFile(notePath,diskVersion);
  await markdown.locator('.cm-content').press('Meta+s');
  await markdown.getByRole('textbox',{name:'本地草稿',exact:true}).waitFor();
  assert.equal(await markdown.getByRole('textbox',{name:'本地草稿',exact:true}).inputValue(),draftBody);
  assert.equal(await readFile(notePath,'utf8'),diskVersion);
  checks.push('external-note-conflict-refuses-overwrite-and-retains-local-draft');
  await close();await launch();
  const restored=await openSyntheticNote();
  await restored.locator('#note-mode').click();
  assert.equal(await restored.evaluate(id=>{const {scope}=aiReadingNotes.getSnapshot();return JSON.parse(localStorage.getItem('markdown-formal:'+scope)||'{}')[id]?.body;},noteId),draftBody);
  assert.ok((await restored.locator('.cm-content').innerText()).includes('尚未保存的冲突草稿。'));
  assert.equal(await readFile(notePath,'utf8'),diskVersion);
  await shell.locator('#current-reading').click();await readable();
  assert.equal(await books.evaluate(()=>document.querySelector('foliate-view').lastLocation.cfi),anchor);
  checks.push('restart-restores-conflict-draft-and-return-restores-EPUB-location');
}catch(error){failure=error;}
finally{
  try{await close();}catch(error){failure??=error;}
  try{await rm(directory,{recursive:true,force:true});}catch(error){failure??=error;}
  const result={passed:!failure,checks,modelCalls:0,syntheticBooksOnly:true,globalNodePythonRequired:false,upgradeFromPreviousBundle:!!baselineApp,...failure?{error:failure.message}:{}};
  await writeFile(output,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
}
if(failure)throw failure;
