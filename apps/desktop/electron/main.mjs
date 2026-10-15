import {createBookmarkService} from '../runtime/bookmark-service.mjs';
import {createAnnotationService} from '../runtime/annotation-service.mjs';
import {randomUUID} from 'node:crypto';
import {BookLibrary} from '../../../packages/book-library/index.mjs';
import {AppleBooksConnection,displayBookTitle} from './apple-books-connection.mjs';
import { app, BrowserWindow, WebContentsView, protocol, session, ipcMain, dialog, Menu, shell, nativeTheme } from 'electron';
import { readFile, realpath, mkdir, writeFile, rename } from 'node:fs/promises';
import { resolve, dirname, join, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RuntimeManager } from '../runtime/manager.mjs';
import {beginCodexLogin} from '../runtime/codex-login.mjs';
import { shutdownApplication } from './shutdown.mjs';
import { workspaceLayout } from './layout.mjs';
import { getBookNotes, getFixtureNotes } from './note-context.mjs';

const base = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const roots = { shell: join(base, 'shell'), reader: resolve(base, '../../packages/reader-ui/dist') };
const shellURL = 'reading-app://shell/index.html';
protocol.registerSchemesAsPrivileged([{ scheme: 'reading-app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
const fixtureEnabled = process.env.AI_READING_TEST === '1' && process.env.AI_READING_UI_FIXTURE === '1';
app.setName('AI 深度阅读');
if (process.env.AI_READING_DATA_DIR) app.setPath('userData', resolve(process.env.AI_READING_DATA_DIR));
else app.setPath('userData', join(app.getPath('appData'), fixtureEnabled ? 'AI 深度阅读 UI Fixtures' : app.isPackaged ? 'AI 深度阅读' : 'AI 深度阅读 Development'));
if (!app.requestSingleInstanceLock()) app.quit();

let appearance={mode:'system',accent:'blue'},appearanceSaved=false,appearanceWrite=Promise.resolve();
const appearanceState=()=>({...appearance,resolved:appearance.mode==='system'?(nativeTheme.shouldUseDarkColors?'dark':'light'):appearance.mode});
function appearanceNotify(){for(const c of [window?.webContents,...[...pages.values()].map(p=>p.webContents)])if(c&&!c.isDestroyed())c.send('reading:appearance',appearanceState());}
let appearanceModal=false;
let window;
let runtime;
let codexLogin=null,loginStarting=false;
let view = 'reading';
let immersive = false, sidebarCollapsed = true, activeNoteId = null, workbenchNote=false;
let previousLayout = null;
let notesScope='book', allNotes={available:false,notes:[]};
let preferredChatWidth=null, widthGesture=null, layoutWrite=Promise.resolve();
const businessEnabled = process.env.AI_READING_TEST !== '1' || process.env.AI_READING_BUSINESS_TEST === '1';
let library, runtimeData, appleBooks, annotations, bookmarks;
let businessStates=new Map();
let businessPoll=null;
let activeSession=null;
const selectionTokens=new Map();
let catalog = [], recentIds = [], uiFixture = null;
const markdownURL = 'reading-app://reader/markdown.html' + (fixtureEnabled ? '?testFixtures=1' : businessEnabled ? '?formalNotes=1' : '');
let readingTab = 'original', rightTool = 'chat';
let notesScopeEpoch=0;const bookToolScopes=new Map();
let book = null;
let bookOpenIntent = null;
let chatVisible = true;
let chatExpanded = false;
let compactChat = false;
let closing = false;
let closed = false;
const pages = new Map();
const readerVisibility = new WeakMap();
const diagnostic = [];
const layoutInput = () => ({ width: window.getContentSize()[0], height: window.getContentSize()[1], view, readingTab, workbenchNote, bookOpen: !!book?.open, chatVisible, chatExpanded, compactChat, immersive, sidebarCollapsed, preferredChatWidth });
const state = () => ({ view, readingTab, rightTool, book, chatVisible, chatExpanded, compactChat, immersive, sidebarCollapsed, activeNoteId, workbenchNote, notesScope, allNotes,
  recentBooks: recentIds.map(id => catalog.find(row => row.id === id) ?? (book?.id === id ? book : null)).filter(Boolean).slice(0, 5),
  bookInfo: catalog.find(row => row.id === book?.id) ?? book,
  testProfile: app.getPath('userData').split(/[\\/]/).includes('.test-data')||fixtureEnabled,
  businessEnabled, business:businessStates.get(book?.id)??null,
  bookNotes:businessEnabled ? {available:true,notes:businessStates.get(book?.id)?.notes??[]} : getBookNotes(book?.id, { fixture: fixtureEnabled ? 'workspace-links' : undefined }), fixture: fixtureEnabled, guide: uiFixture?.guideByBook?.[book?.id] ?? null,
  layout: window && !window.isDestroyed() ? workspaceLayout(layoutInput()) : null,
  runtime: runtime?.getStatus() ?? { state: 'starting', message: '正在启动内置运行时。' } });
const notify = () => { if (window && !window.isDestroyed()) window.webContents.send('reading:state', state()); };
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.epub': 'application/epub+zip', '.woff2': 'font/woff2' };
const csp = "default-src 'none'; script-src 'self'; style-src 'self' blob: 'unsafe-inline'; img-src 'self' reading-app://reader reading-app://library blob: data:; font-src 'self' blob: data:; connect-src 'self' reading-app://library blob:; frame-src 'self' blob: data:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'none'";

function harden(contents, expectedURL) {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event, url) => {
    if (url.split('#')[0] !== expectedURL) event.preventDefault();
  });
  contents.on('will-attach-webview', event => event.preventDefault());
  contents.on('render-process-gone', (_event, details) => diagnostic.push({ event: 'renderer-exit', page: expectedURL, reason: details.reason }));
}
function resize() {
  if (!window || window.isDestroyed()) return;
  const [width, height] = window.getContentSize();
  const layout = workspaceLayout(layoutInput());
  if(preferredChatWidth===null&&layout.showChat&&!layout.fullChat)preferredChatWidth=layout.chatWidth;
  for (const [name, page] of pages) {
    // Keep valid dimensions for hidden resident documents, preserving editor
    // measurements and EPUB position. Visible content never sits under chat.
    page.setBounds(layout.content);
    const visible = !appearanceModal && name === layout.visibleReader;
    page.setVisible(visible);
    if (page.webContents.getURL() && readerVisibility.get(page) !== visible) {
      readerVisibility.set(page, visible);
      void page.webContents.executeJavaScript(`${!visible?'window.readingMotion?.cleanup();':''}document.body.inert=${!visible};document.body.setAttribute('aria-hidden','${!visible}');`).catch(() => readerVisibility.delete(page));
    }
  }
  if (appearanceModal || !layout.visibleReader) window.webContents.focus();
}
async function readerEvent(name, type, detail) {
  const contents = pages.get(name)?.webContents;
  if (!contents?.getURL()) return;
  return contents.executeJavaScript(`window.dispatchEvent(new CustomEvent(${JSON.stringify(type)}, {detail:${JSON.stringify(detail ?? null)}}));`);
}
let transitionEpoch=0;
// Layout changes must not cancel a pending document-open intent.
let navigationEpoch=0;
async function surface(contents,phase,kind='page',ids){
 if(!contents||contents.isDestroyed()||!contents.getURL())return;
 try{await contents.executeJavaScript(`window.readingMotion?.surface(${JSON.stringify(phase)},${JSON.stringify(kind)},${JSON.stringify(ids)})`)}
 catch(error){if(!closing)diagnostic.push({event:'motion-unavailable',phase});}
}
function cancelTransition(invalidate=true){
 transitionEpoch++;
 widthGesture=null;
 for(const contents of [window?.webContents,...[...pages.values()].map(p=>p.webContents)])void surface(contents,'cancel');
}
let currentTransition=Promise.resolve();
function transitionLayout(...args){currentTransition=performTransition(...args);return currentTransition;}
async function performTransition(change,kind='page'){
 widthGesture=null;
 const ticket=++transitionEpoch;
 const before=state().layout;
 const contents=[window.webContents,...[...pages].filter(([,page])=>readerVisibility.get(page)===true).map(([,p])=>p.webContents)];
 change(); // Merge the requested state immediately; later independent controls must not discard it.
 const after=state().layout;const ids=['guide-panel'];if(before.sidebarWidth!==after.sidebarWidth)ids.push('resources');if(before.showChat!==after.showChat||before.chatWidth!==after.chatWidth||before.fullChat!==after.fullChat)ids.push('chat-panel');
 // Renderer fades cover actual WebContentsViews. Native bounds change once, never per frame.
 await Promise.all(contents.map(c=>surface(c,'out',kind,c===window.webContents?ids:undefined)));
 if(ticket!==transitionEpoch||closing)return state();
 const name=state().layout?.visibleReader;
 if(name)await surface(pages.get(name).webContents,'hold');
 if(ticket!==transitionEpoch||closing)return state();
 resize();notify();
 try{
  if(name==='books'){
   await readerEvent('books','ai-reading:display-mode',{immersive,container:view});
   if(ticket!==transitionEpoch||closing)return state();
   await readerEvent('books',view==='books'?'ai-reading:show-library':'ai-reading:show-reader');
  }
  if(ticket!==transitionEpoch||closing)return state();
  if(name==='markdown')await readerEvent('markdown','ai-reading:container',{inline:true});
  if(name){
   await readerEvent(name,'ai-reading:activate');
   await pages.get(name).webContents.executeJavaScript('window.aiReadingLifecycle?.ready()');
  }
 }catch(error){diagnostic.push({event:'view-activation-failed',page:name});}
 finally{
  if(ticket===transitionEpoch&&!closing){
   // Cancel old hidden surfaces too, so future activation cannot inherit zero opacity.
   await Promise.all([...pages].filter(([n])=>n!==name).map(([,p])=>surface(p.webContents,'cancel')));
   await Promise.all([surface(window.webContents,'in',kind,ids),name?surface(pages.get(name).webContents,'in',kind):Promise.resolve()]);
  }
 }
 return state();
}
function leaveImmersive(){
 if(immersive&&previousLayout){({sidebarCollapsed,chatVisible,chatExpanded,compactChat}=previousLayout);previousLayout=null;}
 immersive=false;
}
async function selectView(next){
 if(next==='markdown')return setNotesScope('all');
 notesScopeEpoch++;navigationEpoch++;
 if(!['books','reading','epub','markdown'].includes(next))throw new Error('Unknown reading view');
 return transitionLayout(()=>{leaveImmersive();view=next;workbenchNote=false;if(next==='reading')readingTab='original';chatExpanded=false;compactChat=false;});
}
async function selectReadingTab(tab){
 navigationEpoch++;
 if(!['guide','original','annotations'].includes(tab))throw new Error('Unknown reading tab');
 return transitionLayout(()=>{leaveImmersive();view='reading';workbenchNote=false;readingTab=tab;chatExpanded=false;compactChat=false;});
}
async function setImmersive(value){
 navigationEpoch++;
 if(typeof value!=='boolean'||value&&!book?.open)throw new Error('Open a book first');
 return transitionLayout(()=>{
  if(value&&!immersive)previousLayout={sidebarCollapsed,chatVisible,chatExpanded,compactChat};
  if(!value)leaveImmersive();else immersive=true;
  view='reading';workbenchNote=false;readingTab='original';
 },'immersive');
}
async function openBook(id) {
  const request=++navigationEpoch;
  if (typeof id !== 'string' || !catalog.some(row => row.id === id) && book?.id !== id) throw new Error('Unknown book');
  if (book?.open && book.id === id) return selectView('reading');
  const intent=randomUUID();bookOpenIntent={token:intent,id,epoch:request,fromLibrary:false};
  cancelTransition();view = 'reading'; readingTab = 'original';
  await pages.get('books').webContents.executeJavaScript(`window.aiReadingBooksReady?true:new Promise(resolve=>window.addEventListener('ai-reading:books-initialized',()=>resolve(true),{once:true}))`);
  if(request!==navigationEpoch||closing)return state();
  await readerEvent('books', 'ai-reading:open-book', { id, intent });
  await pages.get('books').webContents.executeJavaScript('window.aiReadingSource?.ready()');
  if(request!==navigationEpoch||closing)return state();
  resize(); notify(); return state();
}
async function openNote(id) {
  const notes = notesScope==='all'?allNotes.notes:state().bookNotes.notes;
  if (typeof id !== 'string' || !notes.some(note => note.id === id)) throw new Error('Note does not belong to this book');
  const request=++navigationEpoch;
  const contents = pages.get('markdown').webContents;
  if(businessEnabled)await contents.executeJavaScript('window.aiReadingNotes.refresh()');
  if(request!==navigationEpoch||closing||!(notesScope==='all'?allNotes.notes:state().bookNotes.notes).some(n=>n.id===id))return state();
  const result = await contents.executeJavaScript(`window.aiReadingNotes.open(${JSON.stringify(id)})`);
  if (!result?.ok) throw new Error(result?.reason === 'composition-active' ? '请先完成正在输入的文字' : '笔记当前不可用');
  if(request!==navigationEpoch||closing)return state();
  activeNoteId = id; return transitionLayout(()=>{leaveImmersive();view='reading';workbenchNote=true;chatExpanded=false;compactChat=false;});
}
async function resourceNotes(query='') {
 const c=pages.get('markdown').webContents;
 await c.executeJavaScript('window.aiReadingNotes.refresh()');
 return c.executeJavaScript(`window.aiReadingNotes.search(${JSON.stringify(query)})`);
}
async function setNotesScope(scope){
 if(!['book','all'].includes(scope))throw Error('Invalid notes scope');
 const ticket=++notesScopeEpoch, targetBook=book?.id;
 const snapshot=await resourceNotes();
 if(ticket!==notesScopeEpoch||targetBook!==book?.id||closing)return state();
 allNotes={available:true,notes:snapshot.notes};notesScope=scope;bookToolScopes.set(book?.id||'general',scope);
 return transitionLayout(()=>{leaveImmersive();if(view==='books')view='reading';rightTool='notes';chatVisible=true;compactChat=true;});
}
async function refreshBusiness(id=book?.id){
 if(!businessEnabled||!id||runtime?.getStatus().state!=='ready')return;
 try{const data=await runtime.call('business:status',{bookId:id});businessStates.set(id,{...data,loading:false,analyzing:data.job?.state==='running',error:data.job?.error??null});
 if(data.job?.state==='running'&&!businessPoll)businessPoll=setTimeout(async()=>{businessPoll=null;await Promise.all([...businessStates].filter(([,x])=>x.analyzing).map(([key])=>refreshBusiness(key)));},1500);}
 catch(error){businessStates.set(id,{...businessStates.get(id),loading:false,error:error.message});}
 if(pages.has('books'))void readerEvent('books','ai-reading:library-status',{books:catalog.map(row=>({...row,analysisStatus:analysisLabel(row.id)}))}).catch(()=>{});
 notify();
}
function analysisLabel(id){const cached=businessStates.get(id);return cached?.status?cached.job?.state==='running'?'正在生成导读':cached.generatedGuide?'已有生成导读':cached.recommendations?.result?.book_guide?cached.guideDisplay?.generationStatus==='details-unavailable'?'导读详情待恢复':'已有原文摘录':'尚未分析':cached?.error?'分析状态暂不可用':'正在核对分析状态';}
let libraryStatusRefresh;
function refreshLibraryStatuses(){
 if(!businessEnabled||runtime?.getStatus().state!=='ready')return Promise.resolve();
 return libraryStatusRefresh??=(async()=>{
  const pending=catalog.map(row=>row.id);let cursor=0;
  await Promise.all(Array.from({length:Math.min(3,pending.length)},async()=>{while(cursor<pending.length)await refreshBusiness(pending[cursor++]);}));
 })().finally(()=>{libraryStatusRefresh=null;});
}
function publicBook(row){return {id:row.id,bookId:row.bookId,bookVersionId:row.bookVersionId,title:row.title,displayTitle:displayBookTitle(row.title),author:row.author,url:'reading-app://library/'+row.id+'.epub',cover:row.coverPath?'reading-app://library/'+row.id+'/cover?v='+row.coverDigest:'',coverStatus:row.coverStatus,analysisStatus:analysisLabel(row.id)};}
async function reloadLibrary(){catalog=(await library.list()).map(publicBook);void refreshLibraryStatuses();return {books:catalog};}
async function businessAction(action,payload){
 if(!businessEnabled)throw Error('业务功能未启用');
 if(['search-policy','set-search-policy','ack-search-migration'].includes(action))return runtime.call('business:'+action,payload??{});
 if(!book?.id||payload?.bookId!==book.id)throw Error('书籍已切换，请重新选择来源');
 const id=book.id;
 if(action==='analyze'){
  if(businessStates.get(id)?.analyzing)throw Error('本书分析正在进行');
  businessStates.set(id,{...businessStates.get(id),analyzing:true,error:null});notify();
  try{return await runtime.call('business:analyze',payload);}finally{await refreshBusiness(id);}
 }
 if(action==='locate'||action==='locate-target'){
  const intent=navigationEpoch;
  const mapping=await runtime.call(action==='locate-target'?'business:source-target':'business:source',payload);
  if(book?.id!==id||navigationEpoch!==intent)throw Error('书籍或导航已切换，定位取消');
  await selectReadingTab('original');
  const navigation=transitionEpoch;
  if(book?.id!==id)throw Error('书籍已切换，定位取消');
  const method=action==='locate-target'?'locateChapter':'locate';
  const result=await pages.get('books').webContents.executeJavaScript(`window.aiReadingSource.${method}(${JSON.stringify(mapping)})`);
  if(book?.id!==id||transitionEpoch!==navigation)throw Error('导航已改变，原文跳转取消');
  if(!result?.ok)throw Error(result?.message||'原文无法定位');return result;
 }
 const result=await runtime.call('business:'+action,payload);
 if(['record','confirm','cancel-analysis'].includes(action))await refreshBusiness(id);
 return result;
}
function shellOnly(event) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== shellURL) throw new Error('Untrusted application sender');
}
async function closeApp() {
  if (closing || closed) return;
  closing = true;cancelTransition();
  try {
    await shutdownApplication({
      flushDrafts: async () => { await annotations?.flush(); await bookmarks?.flush(); return Promise.all([window, ...pages.values()].map(async page => {
        try {
          return await Promise.race([
            page.webContents.executeJavaScript('window.aiReadingLifecycle?.flush() ?? window.readingShellLifecycle?.flush() ?? {ok:false}'),
            new Promise(resolve => setTimeout(() => resolve({ ok: false }), 3000)),
          ]);
        } catch { return { ok: false }; }
      })); },
      confirmExit: async () => {
        const { response } = await dialog.showMessageBox(window, { type: 'warning', message: '部分草稿尚未确认保存', detail: '可以返回检查，或退出并保留最近一次成功保存的版本。', buttons: ['返回检查', '仍然退出'], defaultId: 0, cancelId: 0 });
        return response !== 0;
      },
      stopRuntime: async () => {await runtime?.stop();await codexLogin?.cancel();codexLogin=null;},
      writeDiagnostics: async results => {
        await mkdir(join(app.getPath('userData'), 'diagnostics'), { recursive: true });
        await writeFile(join(app.getPath('userData'), 'diagnostics', 'last-exit.json'), JSON.stringify({ timestamp: new Date().toISOString(), draftResults: results, runtime: runtime?.getStatus(), diagnostic }, null, 2));
      },
      onDiagnosticError: () => diagnostic.push({ event: 'exit-diagnostics-unavailable' }),
      onBlocked: async stage => {
        diagnostic.push({ event: 'exit-blocked', stage });
        notify();
        await dialog.showMessageBox(window, {
          type: 'error',
          message: stage === 'runtime-stop' ? '内置运行时尚未确认停止，暂未退出' : '暂时无法确认草稿状态，暂未退出',
          detail: '阅读页面已保留。请返回检查，稍后可以再次尝试退出。',
          buttons: ['返回检查'], defaultId: 0, cancelId: 0,
        });
      },
      closeViews: () => {
        for (const page of pages.values()) {
          try { if (!page.webContents.isDestroyed()) page.webContents.close(); }
          catch { diagnostic.push({ event: 'reader-close-unavailable' }); }
        }
      },
      finishExit: () => {
        closed = true;
        if (!window.isDestroyed()) window.destroy();
        app.quit();
      },
    });
  } finally {
    if (!closed) closing = false;
  }
}

app.on('before-quit', event => { if (!closed && window) { event.preventDefault(); void closeApp(); } });
app.on('second-instance', () => { window?.show(); window?.focus(); });
app.on('window-all-closed', () => app.quit());

app.whenReady().then(async () => {
try{const p=JSON.parse(await readFile(join(app.getPath('userData'),'workspace-layout.json'),'utf8'));if(Number.isFinite(p.chatWidth)&&p.chatWidth>=340&&p.chatWidth<=4000)preferredChatWidth=p.chatWidth;}catch{}
try{const p=JSON.parse(await readFile(join(app.getPath('userData'),'appearance.json'),'utf8'));if(['light','dark','system'].includes(p.mode)&&['purple','blue','green','purple-panels'].includes(p.accent)){appearance=p;appearanceSaved=true;}}catch{}
function trustedAppearance(e){const c=e.sender;return e.senderFrame===c.mainFrame&&(c===window?.webContents||[...pages.values()].some(p=>p.webContents===c));}
ipcMain.handle('reading:appearance-modal',(e,value)=>{shellOnly(e);if(typeof value!=='boolean')throw Error('Invalid modal');appearanceModal=value;resize();});
ipcMain.handle('reading:appearance-get',e=>{if(!trustedAppearance(e))throw Error('Untrusted appearance sender');return appearanceState();});
ipcMain.handle('reading:appearance-set',async(e,p)=>{if(!trustedAppearance(e)||!['light','dark','system'].includes(p?.mode)||!['purple','blue','green','purple-panels'].includes(p?.accent))throw Error('Invalid appearance');const next={mode:p.mode,accent:p.accent};return appearanceWrite=appearanceWrite.catch(()=>{}).then(async()=>{const path=join(app.getPath('userData'),'appearance.json');await mkdir(app.getPath('userData'),{recursive:true});await writeFile(path+'.tmp',JSON.stringify(next));await rename(path+'.tmp',path);appearance=next;appearanceSaved=true;appearanceNotify();return appearanceState();});});
ipcMain.on('reading:appearance-open',e=>{if(trustedAppearance(e))window.webContents.send('reading:appearance-open');});
nativeTheme.on('updated',appearanceNotify);

protocol.handle('reading-app', async request => {
  try {
    const url = new URL(request.url);
    if(url.hostname==='library'&&businessEnabled&&request.method==='GET'){
      const cover=url.pathname.match(/^\/(book_[a-zA-Z0-9]+)\/cover$/);
      if(cover){const entry=await library.get(cover[1]);if(!entry?.coverPath)return new Response('Not found',{status:404});return new Response(await readFile(entry.coverPath),{headers:{'content-type':entry.coverMime,'access-control-allow-origin':'*','content-security-policy':"default-src 'none'",'x-content-type-options':'nosniff','cache-control':'private, max-age=3600'}});}
      const id=url.pathname.slice(1).replace(/\.epub$/,'');const entry=await library.get(id);
      if(!entry||url.pathname!=='/'+id+'.epub')return new Response('Not found',{status:404});
      return new Response(await readFile(entry.archivePath),{headers:{'content-type':'application/epub+zip','access-control-allow-origin':'reading-app://reader','content-security-policy':csp}});
    }
    const root = roots[url.hostname];
    if (!root || request.method !== 'GET') return new Response('Not found', { status: 404 });
    const path = resolve(root, '.' + decodeURIComponent(url.pathname));
    const canonicalRoot = await realpath(root);
    const canonicalPath = await realpath(path);
    if (!canonicalPath.startsWith(canonicalRoot + sep)) return new Response('Forbidden', { status: 403 });
    return new Response(await readFile(canonicalPath), { headers: { 'content-type': mime[extname(path)] ?? 'application/octet-stream', 'content-security-policy': csp, 'x-content-type-options': 'nosniff' } });
  } catch { return new Response('Resource not available', { status: 404 }); }
});
session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
session.defaultSession.setPermissionCheckHandler(() => false);
session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
  const url = new URL(details.url);
  callback({ cancel: !['reading-app:', 'blob:', 'data:', 'devtools:'].includes(url.protocol) });
});

if (fixtureEnabled) uiFixture = JSON.parse(await readFile(join(base,'tests/fixtures/workbench.json'),'utf8'));
runtimeData=join(app.getPath('userData'),'runtime');
library=new BookLibrary({root:join(runtimeData,'library'),pythonPath:process.env.AI_READING_PYTHON});
annotations=createAnnotationService({root:join(runtimeData,'annotations'),library});
bookmarks=createBookmarkService({root:join(runtimeData,'bookmarks'),library});
appleBooks=new AppleBooksConnection({library,onProgress:progress=>{const contents=pages.get('books')?.webContents;if(contents&&!contents.isDestroyed())contents.send('reading:apple-progress',progress);}});
if(businessEnabled)await reloadLibrary();
else catalog = JSON.parse(await readFile(join(roots.reader, 'books-assets/catalog.json'), 'utf8')).map(({id,title,author,cover}) => ({id,title,author,cover}));
try { recentIds = JSON.parse(await readFile(join(app.getPath('userData'), 'recent-books.json'), 'utf8')).filter(id => typeof id === 'string' && catalog.some(row => row.id === id)).slice(0,5); } catch {}

runtime = new RuntimeManager({ dataDir: join(app.getPath('userData'), 'runtime'), nodePath: process.env.AI_READING_NODE });
runtime.on('status', status=>{notify();if(status.state==='ready'){void refreshLibraryStatuses();if(businessEnabled)void pages.get('markdown')?.webContents.executeJavaScript('window.aiReadingNotes?.refresh()').catch(()=>{});}});
runtime.on('session-event', event => { if (window && !window.isDestroyed()) window.webContents.send('reading:session-event', event); });
window = new BrowserWindow({ width: 1440, height: 960, minWidth: 700, minHeight: 540, title: app.isPackaged?'AI 深度阅读':'AI 深度阅读 · 开发预览', titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 17 }, backgroundColor: '#fafafd', show: false, webPreferences: { preload: join(base, 'electron/preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true } });
harden(window.webContents, shellURL);
window.on('resize', () => { cancelTransition(false);resize();notify(); });
window.on('close', event => { if (!closed) { event.preventDefault(); void closeApp(); } });
ipcMain.handle('reading:business',async(event,action,payload)=>{shellOnly(event);return businessAction(action,payload);});
let noteSourceEpoch=0;
ipcMain.handle('reading:note-source',async(event,p)=>{
 const c=pages.get('markdown')?.webContents;
 if(!businessEnabled||closing||event.sender!==c||event.senderFrame!==c.mainFrame||event.senderFrame.url!==markdownURL)throw Error('Untrusted notes sender');
 const ticket=++noteSourceEpoch,startNavigation=transitionEpoch;
 const current=()=>ticket===noteSourceEpoch&&!closing;
 try {
  if(!p||typeof p.noteId!=='string'||typeof p.spanId!=='string')throw Error('笔记来源参数无效');
  const note=await runtime.call('notes:read',{id:p.noteId});
  const ref=note.data?.book_evidence?.find?.(r=>r.span_id===p.spanId);
  if(!ref||!/^[a-f0-9]{16}$/.test(ref.book_id))throw Error('正式笔记没有该来源');
  const entry=await library.get('book_'+ref.book_id);
  if(!entry||entry.bookVersionId!==ref.book_version_id)throw Error('请先导入该来源的同版本 EPUB');
  const mapping=await runtime.call('business:source',{bookId:entry.id,spanId:p.spanId});
  if(['text_hash','href','start_codepoint','end_codepoint','book_version_id'].some(k=>mapping.span[k]!==ref[k]))throw Error('笔记来源未通过原文核验');
  if(!current()||transitionEpoch!==startNavigation)throw Error('导航已改变，原文跳转取消');
  await openBook(entry.id);
  if(!current()||book?.id!==entry.id)throw Error('书籍已切换，原文跳转取消');
  await selectReadingTab('original');
  const navigation=transitionEpoch;
  const result=await pages.get('books').webContents.executeJavaScript(`window.aiReadingSource.locate(${JSON.stringify(mapping)})`);
  if(!current()||transitionEpoch!==navigation)throw Error('导航已改变，原文跳转取消');
  return result;
 }catch(error){return {ok:false,message:error.message};}
});
ipcMain.handle('reading:notes',async(event,action,payload)=>{
 const c=pages.get('markdown')?.webContents;
 if(!businessEnabled||event.sender!==c||event.senderFrame!==c.mainFrame||event.senderFrame.url!==markdownURL)throw Error('Untrusted notes sender');
 try{const result=await runtime.call('notes:'+action,payload);if(action==='save')await refreshBusiness();return {result};}catch(error){return {error:{code:error.code,message:error.message}};}
});
ipcMain.on('reading:active-session',(event,value)=>{shellOnly(event);activeSession=typeof value==='string'&&value.length<200?value:null;});
ipcMain.handle('reading:right-tool', (event, tool) => { shellOnly(event); if(!['chat','notes','guide','annotations'].includes(tool))throw Error('Invalid tool'); notesScopeEpoch++;if(tool==='notes')notesScope='book';if(state().layout.showChat){rightTool=tool;notify();return state();}return transitionLayout(()=>{rightTool=tool;chatVisible=true;compactChat=true;}); });
ipcMain.handle('reading:state', event => { shellOnly(event); return state(); });
ipcMain.handle('reading:select', (event, next) => { shellOnly(event); return selectView(next); });
ipcMain.handle('reading:tab', (event, tab) => { shellOnly(event); return selectReadingTab(tab); });
ipcMain.handle('reading:open-book', (event, id) => { shellOnly(event); return openBook(id); });
ipcMain.handle('reading:notes-scope',(e,scope)=>{shellOnly(e);return setNotesScope(scope);});
ipcMain.handle('reading:notes-search',async(e,query)=>{shellOnly(e);if(typeof query!=='string'||query.length>1000)throw Error('Invalid search');const snapshot=await resourceNotes(query);return snapshot.notes;});
ipcMain.on('reading:child-navigation',(e,target)=>{const name=e.sender===pages.get('books')?.webContents?'books':e.sender===pages.get('markdown')?.webContents?'markdown':null;if(!name||e.senderFrame!==e.sender.mainFrame||e.senderFrame.url!==(name==='books'?'reading-app://reader/books.html':markdownURL))return;if(['guide','original','annotations'].includes(target))void selectReadingTab(target);else if(target==='reading')void selectView('reading');});
ipcMain.handle('reading:open-note', (event, id) => { shellOnly(event); return openNote(id); });
ipcMain.handle('reading:immersive', (event, value) => { shellOnly(event); return setImmersive(value); });
ipcMain.handle('reading:sidebar', (event, value) => { shellOnly(event); if (typeof value !== 'boolean') throw new TypeError('Invalid sidebar state'); return transitionLayout(()=>{sidebarCollapsed=value;if(!value&&!workspaceLayout(layoutInput()).sidebarWidth){chatVisible=false;chatExpanded=false;compactChat=false;}}); });
ipcMain.on('reading:reader-mode', (event, value) => {
  const contents = pages.get('books')?.webContents;
  if (event.sender !== contents || event.senderFrame !== contents.mainFrame || event.senderFrame.url !== 'reading-app://reader/books.html' || typeof value !== 'boolean') return;
  void setImmersive(value);
});

function trustedBooks(event) {
 const contents = pages.get('books')?.webContents;
 return contents && event.sender === contents && event.senderFrame === contents.mainFrame && event.senderFrame.url === 'reading-app://reader/books.html';
}
ipcMain.handle('reading:bookmarks',async(event,action,p={})=>{
 if(!trustedBooks(event)||!businessEnabled||closing||!book?.id||p.bookId!==book.id)throw Error('书籍已切换或正在退出');
 const id=book.id, intent=navigationEpoch;
 if(!['list','add','remove','locate'].includes(action))throw Error('无效书签操作');
 if(action==='add'){
  // Capture the actual reader position, not a renderer-provided file path/title.
  const current=await pages.get('books').webContents.executeJavaScript('window.aiReadingBookmarks.current()');
  if(book?.id!==id||navigationEpoch!==intent||current?.bookId!==id)throw Error('阅读位置已改变，请重试');
  return bookmarks.add(current);
 }
 const result=await bookmarks[action](p);
 if(book?.id!==id||navigationEpoch!==intent)throw Error('书籍已切换');
 return result;
});
ipcMain.handle('reading:annotations',async(event,action,p={})=>{
 const fromReader=trustedBooks(event);if(!fromReader)shellOnly(event);if(closing)throw Error('应用正在退出，标注草稿已保留');
 if(!businessEnabled||!book?.id||p.bookId!==book.id)throw Error('书籍已切换，请重试');
 const id=book.id,intent=navigationEpoch;
 if(action==='chapter')return library.getSourceChapter(id,p.href);
 if(!['list','create','update','remove','restore','locate'].includes(action))throw Error('无效标注操作');
 if(p.id){const records=await annotations.list({bookId:id,includeDeleted:true});if(!records.some(r=>r.id===p.id))throw Error('标注不属于当前书籍');}
 const result=await annotations[action](p);
 if(action==='locate'&&!fromReader){
  if(book?.id!==id||intent!==navigationEpoch)throw Error('书籍或导航已切换，标注定位取消');await selectReadingTab('original');
  const located=await pages.get('books').webContents.executeJavaScript(`window.aiReadingSource.locate(${JSON.stringify(result.mapping)})`);
  if(!located?.ok)throw Error(located?.message||'标注无法精确定位');return located;
 }
 if(['create','update','remove','restore'].includes(action))for(const c of [window.webContents,pages.get('books').webContents])c.send('reading:annotations-changed',{bookId:id});
 return result;
});
ipcMain.handle('reading:source-chapter',async(event,p)=>{
 if(!trustedBooks(event)||!businessEnabled||p?.bookId!==book?.id||typeof p.href!=='string'||p.href.length>2000)throw Error('选文书籍范围无效');
 const selectionSession=activeSession;
 if(!selectionSession)throw Error('请等待当前会话就绪');
 const result=await library.getSourceChapter(p.bookId,p.href);
 if(activeSession!==selectionSession||book?.id!==p.bookId)throw Error('会话或书籍已切换，请重新选择');
 const token=randomUUID();selectionTokens.clear();selectionTokens.set(token,{sessionId:selectionSession,bookId:p.bookId,expires:Date.now()+60000});
 return {...result,selectionToken:token};
});
ipcMain.handle('reading:selection',async(event,p)=>{
 try{
  if(!trustedBooks(event)||!businessEnabled||p?.bookId!==book?.id)throw Error('书籍已切换');
  const intent=selectionTokens.get(p.selectionToken);selectionTokens.delete(p.selectionToken);
  if(!intent||intent.expires<Date.now()||intent.sessionId!==activeSession||intent.bookId!==p.bookId)throw Error('选文讨论对象已改变，请重新选择');
  const selectionSession=intent.sessionId;
  const entry=await library.get(p.bookId);
  if(!entry||!['section_order','start_codepoint','end_codepoint'].every(k=>Number.isSafeInteger(p[k])&&p[k]>=0)||p.end_codepoint<=p.start_codepoint||p.end_codepoint-p.start_codepoint>30000)throw Error('选文范围无效');
  const spanId=`sp_${entry.bookId}_${p.section_order}_${p.start_codepoint}_${p.end_codepoint}`;
  const mapping=await runtime.call('business:source',{bookId:entry.id,spanId});
  if(book?.id!==entry.id||mapping.span.quote!==p.quote||mapping.span.text_hash!==p.text_hash||mapping.span.href!==p.href)throw Error('选文未通过原文核验');
  await setImmersive(false);await transitionLayout(()=>{rightTool='chat';chatVisible=true;chatExpanded=false;compactChat=true;});
  if(activeSession!==selectionSession||book?.id!==entry.id)throw Error('会话或书籍已切换，请重新附加选文');
  await runtime.call('business:prepare',{bookId:entry.id,sessionId:selectionSession,spanId});
  if(activeSession!==selectionSession||book?.id!==entry.id)throw Error('选文已保留在原会话，当前会话已改变');
  window.webContents.send('reading:source-selected',{spanId,sessionId:selectionSession,bookId:entry.id,prepared:true});return {ok:true};
 }catch(error){return {ok:false,message:error.message};}
});
ipcMain.handle('reading:books-ready',event=>{if(!trustedBooks(event))throw Error('Untrusted books sender');return businessEnabled;});
ipcMain.handle('reading:books-list',event=>{if(!trustedBooks(event)||!businessEnabled)throw Error('Untrusted books sender');return reloadLibrary();});
ipcMain.handle('reading:apple-books',async(event,action,payload)=>{
 if(!trustedBooks(event)||!businessEnabled)throw Error('Untrusted books sender');
 if(action==='scan')return appleBooks.scan();
 if(action==='disconnect')return appleBooks.disconnect();
 if(action==='import'){const result=await appleBooks.importSelected(payload?.ids);const updated=await reloadLibrary();notify();return {...result,...updated};}
 throw Error('Unknown Apple Books action');
});
ipcMain.handle('reading:books-import',async event=>{
 if(!trustedBooks(event)||!businessEnabled)throw Error('Untrusted books sender');
 const chosen=await dialog.showOpenDialog(window,{title:'导入 EPUB',filters:[{name:'EPUB',extensions:['epub']}],properties:['openFile','openDirectory']});
 if(chosen.canceled)return {cancelled:true};
 await library.importFile(chosen.filePaths[0]);const result=await reloadLibrary();notify();return result;
});
ipcMain.on('reading:library-request', event => {
 if (trustedBooks(event)) void selectView('books');
});
ipcMain.on('reading:library-changed', async event => {
 if (!trustedBooks(event)) return;
 const rows = await pages.get('books').webContents.executeJavaScript('window.aiReadingLibrary.getSnapshot()');
 if (!Array.isArray(rows)) return;
 for (const row of rows) {
  if (!row || !/^local:[a-zA-Z0-9-]{1,128}$/.test(row.id) || typeof row.title !== 'string' || typeof row.author !== 'string') continue;
  if (!catalog.some(item => item.id === row.id)) catalog.push({id:row.id,title:row.title.slice(0,300),author:row.author.slice(0,300),cover:''});
 }
 notify();
});

ipcMain.on('reading:note-context', (event, value) => {
  const contents = pages.get('markdown')?.webContents;
  if (event.sender !== contents || event.senderFrame !== contents.mainFrame || event.senderFrame.url !== markdownURL || typeof value?.id !== 'string' || value.id.length > 1024) return;
  activeNoteId = value.id; notify();
});

// Resizing is bounded by the renderer pump and awaits the existing layout queue.
// A navigation/resize invalidates the gesture so late messages cannot restore it.
ipcMain.handle('reading:chat-width', async(event, request)=>{
 shellOnly(event);
 const {id,phase,width}=request??{};
 if(typeof id!=='string'||id.length>80||!['begin','update','end','cancel'].includes(phase)||!Number.isFinite(width))throw new TypeError('Invalid width gesture');
 if(phase==='begin'){
  cancelTransition();
  widthGesture={id,initial:preferredChatWidth};
 }
 if(widthGesture?.id!==id||closing)return {accepted:false};
 const layout=state().layout;
 if(!layout.showChat||layout.fullChat||immersive){widthGesture=null;return {accepted:false};}
 const initial=widthGesture.initial;
 preferredChatWidth=phase==='cancel'?initial:Math.max(layout.chatMin,Math.min(layout.chatMax,width));
 resize();notify();
 const reader=pages.get(layout.visibleReader)?.webContents;
 if(reader&&!reader.isDestroyed())await reader.executeJavaScript('window.aiReadingLifecycle?.ready()');
 if(widthGesture?.id!==id||closing)return {accepted:false};
 if(phase==='end'||phase==='cancel'){
  widthGesture=null;
  if(phase==='end'){
   const value=preferredChatWidth;
   layoutWrite=layoutWrite.catch(()=>{}).then(async()=>{const path=join(app.getPath('userData'),'workspace-layout.json');await mkdir(app.getPath('userData'),{recursive:true});await writeFile(path+'.tmp',JSON.stringify({chatWidth:value}));await rename(path+'.tmp',path);});
   await layoutWrite;
  }
 }
 return {accepted:true};
});
ipcMain.handle('reading:chat-layout', (event, options) => {
  shellOnly(event);
  if (!options || Object.keys(options).some(key => !['visible', 'expanded', 'compact'].includes(key)) || Object.values(options).some(value => typeof value !== 'boolean')) throw new TypeError('Invalid chat layout');
  return transitionLayout(()=>{
   if('visible' in options)chatVisible=options.visible;
   if('expanded' in options)chatExpanded=options.expanded;
   if('compact' in options)compactChat=options.compact;
  });
});
const sessionActions = new Set(['list', 'create', 'ensure', 'resume', 'history', 'prompt', 'cancel', 'rename', 'archive', 'restore', 'trash']);
ipcMain.handle('reading:sessions', async (event, action, payload) => {
  shellOnly(event);
  if (!sessionActions.has(action) || !payload || typeof payload !== 'object' || Array.isArray(payload) || JSON.stringify(payload).length > 24000) throw new TypeError('Invalid session request');
  const scope=book?.id?{kind:'book',bookId:(catalog.find(row=>row.id===book.id)??book)?.bookId||'prototype:'+book.id}:{kind:'general'};
  if((payload.scope?.kind??'general')!==scope.kind||(scope.kind==='book'&&payload.scope?.bookId!==scope.bookId))throw new Error('会话书籍范围已改变，请重试');
  return runtime.call(`sessions:${action}`, payload);
});
ipcMain.on('reading:book-opening', (event,value) => {
  if(!trustedBooks(event)||!value||typeof value.id!=='string'||value.id.length>256||typeof value.intent!=='string'||value.intent.length>128||!value.intent)return;
  if(businessEnabled&&!catalog.some(row=>row.id===value.id))return;
  bookOpenIntent={token:value.intent,id:value.id,epoch:++navigationEpoch,fromLibrary:view==='books'};
});
ipcMain.on('reading:book-context', (event, value) => {
  const contents = pages.get('books')?.webContents;
  if (!contents || event.sender !== contents || event.senderFrame !== contents.mainFrame || event.senderFrame.url !== 'reading-app://reader/books.html') return;
  if (!value || Object.keys(value).sort().join(',') !== 'author,id,intent,open,title' || typeof value.open !== 'boolean' || ['id', 'title', 'author'].some(key => typeof value[key] !== 'string' || value[key].length > (key === 'id' ? 256 : 300))) return;
  if(!bookOpenIntent||value.intent!==bookOpenIntent.token||businessEnabled&&value.id!==bookOpenIntent.id)return;
  const fromLibrary = bookOpenIntent.fromLibrary&&bookOpenIntent.epoch===navigationEpoch;
  if(businessEnabled&&!catalog.some(row=>row.id===value.id))return;
  if(book?.id!==value.id){notesScopeEpoch++;notesScope=bookToolScopes.get(value.id)||'book';}
  book = { ...value };
  if(value.open)void refreshBusiness(value.id);
  if (value.open) {
    recentIds = [value.id, ...recentIds.filter(id => id !== value.id)].slice(0, 5);
    void mkdir(app.getPath('userData'), {recursive:true}).then(() => writeFile(join(app.getPath('userData'), 'recent-books.json'), JSON.stringify(recentIds))).catch(() => {});
    if (fromLibrary) { readingTab = 'original'; void selectView('epub'); }
    else { resize(); notify(); }
  } else { resize(); notify(); }
});
ipcMain.handle('reading:restart', async event => { shellOnly(event); await runtime.restart(); return state(); });
ipcMain.handle('reading:show-status', async event => {
  shellOnly(event);
  const status = runtime.getStatus();
  const result = await dialog.showMessageBox(window, { type: status.state === 'error' ? 'warning' : 'info', message: status.message, detail: businessEnabled ? '书籍与知识保存在本应用数据目录，聊天由内置 Harness 保存，AI 使用本应用独立的 Codex ChatGPT 登录。当前不会自动读取 Apple 书库、旧 Codex 全局指令或原宿主会话。' : '隔离 UI 验收模式：样书与合成数据。', buttons: businessEnabled ? ['关闭', '重新启动运行时', codexLogin?'取消 ChatGPT 登录':'登录 ChatGPT', '打开知识文件夹'] : ['关闭', '重新启动运行时'], defaultId: 0, cancelId: 0 });
  if (result.response === 1) await runtime.restart();
  if (result.response === 2) {
    if(loginStarting||closing||closed)return;
    if(codexLogin){await codexLogin.cancel();codexLogin=null;return;}
    loginStarting=true;
    try{
      codexLogin=await beginCodexLogin({codexHome:join(runtimeData,'codex-home'),pythonPath:process.env.AI_READING_PYTHON,openURL:url=>{if(closing||closed)throw Error('应用正在关闭');return shell.openExternal(url)}});
      const pending=codexLogin;
      void pending.completed.then(async()=>{if(!closing&&!closed)await runtime.restart();}).catch(async()=>{if(!closing&&!closed)await dialog.showMessageBox(window,{type:'warning',message:'ChatGPT 登录未完成',detail:'阅读和笔记不受影响。可再次打开运行状态，选择“登录 ChatGPT”。'});}).finally(()=>{if(codexLogin===pending)codexLogin=null;});
    }catch{await dialog.showMessageBox(window,{type:'warning',message:'无法开始 ChatGPT 登录',detail:'请检查网络后重试。阅读和笔记仍可使用。'});}finally{loginStarting=false;}

  }
  if(result.response===3)await shell.openPath(join(runtimeData,'knowledge','45-书籍'));
});
Menu.setApplicationMenu(Menu.buildFromTemplate([
  { label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
  { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
  { label: '视图', submenu: [{ label: '全部书籍', accelerator: 'CmdOrCtrl+1', click: () => selectView('books') }, { label: '返回工作台', accelerator: 'CmdOrCtrl+2', click: () => selectView('reading') }, { label: '全部笔记', accelerator: 'CmdOrCtrl+3', click: () => selectView('markdown') }, { type: 'separator' }, { role: 'togglefullscreen' }] },
  { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }] },
]));
await window.loadURL(shellURL);
for (const name of ['books', 'markdown']) {
  const page = new WebContentsView({ webPreferences: { preload: join(base, 'electron', name === 'books' ? 'book-preload.cjs' : 'markdown-preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  pages.set(name, page);
  window.contentView.addChildView(page);
  resize();
  page.setVisible(name === view);
  const url = name === 'markdown' ? markdownURL : 'reading-app://reader/books.html';
  harden(page.webContents, url);
  await page.webContents.loadURL(url);
  if(name==='markdown'&&!appearanceSaved){
    const legacy=await page.webContents.executeJavaScript(`(()=>{try{return JSON.parse(localStorage.getItem('markdown-r1:theme'))}catch{return null}})()`);
    if(['light','dark'].includes(legacy)){appearance={mode:legacy,accent:'purple-panels'};await writeFile(join(app.getPath('userData'),'appearance.json'),JSON.stringify(appearance));appearanceSaved=true;appearanceNotify();}
  }
  if (name === 'markdown' && fixtureEnabled) await readerEvent('markdown', 'ai-reading:seed-notes', { notes: getFixtureNotes('workspace-links') });
  readerVisibility.delete(page); resize();
}
resize();
notify();
window.show();
void runtime.start().then(async()=>{if(businessEnabled&&recentIds[0]&&!book?.open)await openBook(recentIds[0]);}).catch(() => notify());
if (process.env.AI_READING_TEST === '1') globalThis.__readingTest = { whenSettled:()=>currentTransition, state, runtime, pages, window, selectView, selectReadingTab, openBook, openNote, setImmersive, closeApp, diagnostic,library,refreshBusiness,businessAction };

}).catch(error => { console.error('Desktop startup failed:', error.message); closed = true; app.quit(); });
