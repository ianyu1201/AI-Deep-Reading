import {_electron as electron} from 'playwright';
import {mkdtemp,rm,writeFile,readFile,readdir,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
const desktop=fileURLToPath(new URL('../../../',import.meta.url));
const appPath=path.resolve(process.argv[2] || path.join(desktop,'dist/AI 深度阅读.app'));
const evidencePath=path.resolve(process.argv[3] || path.join(desktop,process.env.AI_READING_TEST_SYSTEM_KEYCHAIN==='1'?'dist/package-keychain-smoke.json':'dist/package-smoke.json'));
const data=await mkdtemp(path.join(tmpdir(),'ai-reading-packaged-'));
let app;
const systemKeychain=process.env.AI_READING_TEST_SYSTEM_KEYCHAIN==='1';
try {
 const env={PATH:'/usr/bin:/bin',HOME:systemKeychain?process.env.HOME:data,AI_READING_DISABLE_AI:'1',AI_READING_USE_HOST_MODEL:'0',TMPDIR:tmpdir(),LANG:'en_US.UTF-8',AI_READING_DATA_DIR:path.join(data,'data')};
 app=await electron.launch({executablePath:path.join(appPath,'Contents/MacOS/AIReading'),env,args:[]});
 console.log('smoke: launched isolated package');
 const page=await app.firstWindow();
 await page.waitForURL('reading-app://shell/index.html');
 await page.waitForLoadState('domcontentloaded');
 const readyDeadline=Date.now()+60000;
 while((await page.evaluate(async()=>(await window.readingApp?.getState())?.runtime?.state))!=='ready'){
  if(Date.now()>readyDeadline)throw Error('Packaged Harness readiness timed out');
  await new Promise(resolve=>setTimeout(resolve,100));
 }
 console.log('smoke: Harness ready');
 for(let attempt=0;attempt<100&&!await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible());attempt++)await new Promise(r=>setTimeout(r,100));
 const state=await app.evaluate(({app,BrowserWindow})=>({packaged:app.isPackaged,appPath:app.getAppPath(),name:app.getName(),visible:BrowserWindow.getAllWindows()[0].isVisible(),node:process.env.AI_READING_NODE,python:process.env.AI_READING_PYTHON}));
 assert.equal(state.packaged,true);assert.equal(state.visible,true);
 assert(state.node.startsWith(appPath));assert(state.python.startsWith(appPath));
 const python=execFileSync(state.python,['-B','-I','-c','import sys,zipfile,sqlite3,ssl,json; print(json.dumps({"prefix":sys.prefix,"executable":sys.executable}))'],{env,encoding:'utf8'});
 assert(JSON.parse(python).prefix.startsWith(appPath));
 const text=await page.locator('body').innerText();
 assert(!text.includes('未启用本机模型配置') || !text.includes('模型已连接'));
 assert(!text.includes('Sherlock'));
 // Codex authentication uses its own private home. OS Keychain probing is explicit opt-in.
 const secure=systemKeychain?await app.evaluate(({safeStorage})=>{if(!safeStorage.isEncryptionAvailable())return {available:false};const sample='synthetic-credential-storage-probe';const encrypted=safeStorage.encryptString(sample);return {available:true,roundtrip:safeStorage.decryptString(encrypted)===sample,ciphertextDoesNotContainPlaintext:!encrypted.includes(Buffer.from(sample))};}):{checked:false};
 if(systemKeychain){assert.equal(secure.available,true);assert.equal(secure.roundtrip,true);assert.equal(secure.ciphertextDoesNotContainPlaintext,true);}
 const evidence={ok:true,secureStorage:secure,...state,python:JSON.parse(python),globalNodePythonRequired:false,privateHome:!systemKeychain,hostModelAccessEnabled:false,paidModelCalls:0};
 await writeFile(evidencePath,JSON.stringify(evidence,null,2));
 console.log(JSON.stringify(evidence,null,2));
} finally {
 if(app){
  const closed=app.waitForEvent('close',{timeout:30000});
  // Empty isolated libraries have no unsaved user notes to review; do not block on that dialog.
  await app.evaluate(({app,dialog})=>{const original=dialog.showMessageBox;dialog.showMessageBox=async(...args)=>{const options=args.at(-1);if(options?.message==='部分草稿尚未确认保存')return {response:1};return original(...args)};app.quit()});
  await closed;
 }
 await rm(data,{recursive:true,force:true});
}
