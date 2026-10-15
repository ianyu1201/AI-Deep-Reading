import {installWorkspaceResizer} from './workspace-resizer.js';
import {installSessionUI} from './session-ui.js';
import {installAnnotationsUI} from './annotations-ui.js';
import {installBusinessUI} from './business-ui.js';
const bridge = window.readingApp;
const $ = id => document.getElementById(id);
// Keep the original mounted components and their listeners; only change their host.
$('chat-panel').append($('resources'),$('annotations-panel'));
$('right-tools').after($('chat-error'));
$('resources').setAttribute('role','tabpanel');$('resources').setAttribute('aria-labelledby','tool-notes');
$('annotations-panel').setAttribute('role','tabpanel');$('annotations-panel').setAttribute('aria-labelledby','tool-annotations');
$('tool-guide-panel').append($('book-guide'));
const toolNames=['chat','notes','guide','annotations'];
function renderTools(){
 if(!state)return;
 const tool=state.rightTool||'chat';
 for(const name of toolNames){const tab=$('tool-'+name);tab.setAttribute('aria-selected',String(tool===name));tab.tabIndex=tool===name?0:-1;}
 for(const [name,id] of [['chat','tool-chat-panel'],['notes','resources'],['guide','tool-guide-panel'],['annotations','annotations-panel']]){const panel=$(id);if(tool!==name&&panel.contains(document.activeElement))$('tool-'+tool).focus();panel.hidden=tool!==name;panel.inert=tool!==name;}
 const expanded=state.view==='reading'&&!state.workbenchNote&&state.readingTab==='guide';
 const host=expanded?$('guide-panel'):$('tool-guide-panel');if($('book-guide').parentElement!==host)host.append($('book-guide'));
 $('book-guide').hidden=!state.book?.open;
 $('tool-guide-empty').hidden=!!state.book?.open;
 $('expand-guide').hidden=expanded||!state.book?.open;$('guide-expanded-hint').hidden=!expanded;
 $('tool-running').hidden=!busy||tool==='chat';
 $('resource-close').hidden=true;$('sidebar-toggle').hidden=true;$('reading-tabs').hidden=true;
 $('chat-context').hidden=false;
}
for(const name of toolNames){const tab=$('tool-'+name);tab.onclick=()=>action(()=>bridge.selectRightTool(name));tab.onkeydown=e=>{if(e.isComposing)return;let i=toolNames.indexOf(name);if(e.key==='ArrowRight')i=(i+1)%4;else if(e.key==='ArrowLeft')i=(i+3)%4;else if(e.key==='Home')i=0;else if(e.key==='End')i=3;else return;e.preventDefault();$('tool-'+toolNames[i]).focus();void action(()=>bridge.selectRightTool(toolNames[i]));};}
$('return-chat').onclick=()=>action(()=>bridge.selectRightTool('chat'));
$('tool-stop').onclick=()=>$('stop').click();
$('expand-guide').onclick=()=>action(()=>bridge.selectReadingTab('guide'));

let state, currentSession = null, epoch = 0, loading = false, busy = false, composing = false, modelAvailable = false;
let currentScope = { kind: 'general' }, historyMessages = [];
let draftRevision = 0, statusRevision = 0;
let resourceKey = '', guideKey = '', resourceQuery='', resourceResults=null, resourceSearchEpoch=0;
const collapsedFolders = new Set(), initializedFolders = new Set();
let turnStatus = 'idle';
const toolBrowse=new Map();let browseBook=null, notePreviews=new Map();
function preserveToolBrowse(next){
 const id=next.book?.id||'general';if(id===browseBook)return;
 if(browseBook!==null)toolBrowse.set(browseBook,{query:resourceQuery,results:resourceResults,previews:notePreviews,scroll:$('resources').scrollTop,guideScroll:$('tool-guide-panel').scrollTop,annotationScroll:$('annotations-panel').scrollTop,guideOpen:[...$('book-guide').querySelectorAll('details')].map((n,i)=>n.open?i:null).filter(i=>i!==null)});
 const prior=toolBrowse.get(id);browseBook=id;resourceSearchEpoch++;resourceQuery=prior?.query||'';resourceResults=prior?.results??null;notePreviews=prior?.previews??new Map();$('resource-search').value=resourceQuery;resourceKey='';
 requestAnimationFrame(()=>{if(browseBook===id){$('resources').scrollTop=prior?.scroll||0;$('tool-guide-panel').scrollTop=prior?.guideScroll||0;$('annotations-panel').scrollTop=prior?.annotationScroll||0;}});
 if(next.runtime?.state==='ready')void action(searchResources);
}
async function searchResources(){const ticket=++resourceSearchEpoch,bookId=browseBook,scope=state?.notesScope;const notes=await bridge.searchNotes(resourceQuery);if(ticket!==resourceSearchEpoch||bookId!==browseBook||scope!==state?.notesScope)return;resourceResults=notes.map(n=>n.id);notePreviews=new Map(notes.map(n=>[n.id,n.preview]));resourceKey='';renderResources(state);}

$('book-guide').addEventListener('toggle',()=>{const prior=toolBrowse.get(browseBook)||{};prior.guideOpen=[...$('book-guide').querySelectorAll('details')].map((n,i)=>n.open?i:null).filter(i=>i!==null);toolBrowse.set(browseBook,prior);},true);
const isBusy = status => status === 'running' || status === 'queued';
function setTurnStatus(status) { turnStatus = status; busy = isBusy(status); }
const businessUI=installBusinessUI({bridge,getSession:()=>currentSession,getState:()=>state,showError,attach:()=>{void bridge.selectRightTool('chat').then(()=>$('question').focus());controls();}});
const streams = new Map();
const scopeKey = scope => scope.kind === 'book' ? scope.bookId : 'general';
const key = () => 'reading:draft:' + (currentSession ?? scopeKey(currentScope));
const saved = (name, fallback = '') => { try { return localStorage.getItem(name) ?? fallback; } catch { return fallback; } };
function persistDraft() {
  try { localStorage.setItem(key(), $('question').value); return true; }
  catch { showError('草稿暂时无法保存，请保留当前窗口。'); return false; }
}
function showError(message = '') { $('chat-error').textContent = message; $('chat-error').hidden = !message; }
function controls() {
  renderTools();
  $('send').hidden = busy; $('stop').hidden = !busy;
  $('send').disabled = loading || !modelAvailable || !currentSession || !$('question').value.trim() || composing;
  $('new-session').disabled = loading || composing; $('session-history').disabled = loading || composing;
  $('chat-status').textContent = loading ? '正在载入会话…' : busy ? (turnStatus === 'queued' ? '问题已接收，等待回答' : 'AI 正在回答') : !modelAvailable ? '模型尚未连接' : '⌘ Enter 发送 · 草稿自动保留';
}
function conversationEmpty() {
  const empty=element('div','chat-empty');
  const art=document.createElement('img');art.src='./assets/reading-conversation.png';art.alt='';art.width=180;art.height=120;art.setAttribute('aria-hidden','true');
  empty.append(art,element('h3','','和 AI 一起深入阅读'),element('p','chat-empty-description','提问、讨论、梳理思路，让阅读更有收获'));
  const tips=element('div','conversation-tips');
  for(const [icon,title,detail] of [['book-open','从原文出发','选中书中一段文字，带着依据向 AI 提问'],['square-pen','留下自己的思考','在下方写下问题或理解，草稿会自动保留']]) {
    const tip=element('div','conversation-tip'),mark=element('span','ui-icon');mark.style.setProperty('--icon','url(./icons/'+icon+'.svg)');mark.setAttribute('aria-hidden','true');
    const copy=element('div');copy.append(element('strong','',title),element('p','',detail));tip.append(mark,copy);tips.append(tip);
  }
  empty.append(tips);return empty;
}
const messageNodes = new Map();
function renderMessages() {
  const list=$('messages'),followEnd=list.scrollTop+list.clientHeight>=list.scrollHeight-80;
  const items=[...historyMessages,...[...streams.values()].filter(m=>!historyMessages.some(row=>row.id===m.id))];
  const ids=new Set(items.map(m=>m.id));
  for(const [id,node] of messageNodes)if(!ids.has(id)){node.remove();messageNodes.delete(id);}
  if(!items.length){if(!list.querySelector('.chat-empty')){list.append(conversationEmpty());}return;}
  list.querySelector('.chat-empty')?.remove();
  let previous=null;
  for(const message of items){
    let article=messageNodes.get(message.id);
    if(!article){article=element('article','message');article.append(element('p','message-label',message.role==='user'?'你':'AI Agent'),element('div','message-content',''));messageNodes.set(message.id,article);}
    article.dataset.messageId=message.id;article.className='message '+message.role+(message.streaming?' streaming':'');
    const content=article.children[1],old=content.textContent,text=message.text??'';
    if(text!==old){if(text.startsWith(old)&&content.firstChild)content.firstChild.appendData(text.slice(old.length));else content.textContent=text;}
    const expected=previous?previous.nextSibling:list.firstChild;
    if(expected!==article){const fresh=!article.isConnected;list.insertBefore(article,expected);if(fresh)window.readingMotion?.enter(article);}
    previous=article;
  }
  if(followEnd)list.scrollTop=list.scrollHeight;
}
function updateModel(model) {
  if (!model) return;
  modelAvailable = !!model.available;
  $('chat-notice').textContent = ''; $('chat-notice').hidden = true; $('send').title = modelAvailable ? '发送问题' : (model.reason || '模型尚未连接，请在设置中查看运行详情');
  controls();
}
async function listSessions(ticket = epoch) {
  const data = await bridge.sessions('list', { scope: currentScope });
  if (ticket !== epoch) return null;
  updateModel(data.model);
  return data.sessions ?? [];
}
function applyHistory(data, { restoreDraft = true, keepStreams = false } = {}) {
  bridge.setActiveSession?.(data.sessionId);
  currentSession = data.sessionId; $('session-title').textContent=data.title||'阅读讨论'; historyMessages = data.messages ?? [];
  if (!keepStreams) streams.clear();
  else for (const message of historyMessages) streams.delete(message.id);
  setTurnStatus(data.status); statusRevision++;
  updateModel(data.model); if (restoreDraft) $('question').value = saved(key());
  try { localStorage.setItem('reading:last-session:' + scopeKey(currentScope), currentSession); } catch {}
  renderMessages(); controls();void businessUI.restoreAttachment();
}
async function loadScope(scope, force = false) {
  if (!force && scopeKey(scope) === scopeKey(currentScope) && currentSession) return;
  persistDraft(); const ticket = ++epoch, revision = draftRevision;
  bridge.setActiveSession?.(null);
  currentScope = scope; currentSession = null; loading = true; busy = false; historyMessages = []; streams.clear();
  $('question').value = saved(key()); showError(); renderMessages(); controls();
  try {
    sessionUI.changed();
    const data = await bridge.sessions('ensure', {scope});
    if(ticket!==epoch)return;
    applyHistory(data,{restoreDraft:draftRevision===revision});
    if(draftRevision!==revision)persistDraft();
  } catch (error) { if (ticket === epoch) showError(error.message || '会话载入失败，可以刷新重试。'); }
  finally { if (ticket === epoch) { loading = false; controls(); } }
}
async function refreshHistory({ clearError = true } = {}) {
  if (!currentSession) return loadScope(currentScope, true);
  const ticket = epoch, id = currentSession;
  loading = true; controls();
  try {
    const data = await bridge.sessions('history', { sessionId: id, scope: currentScope });
    if (ticket !== epoch || currentSession !== id) return;
    applyHistory(data, { restoreDraft: false, keepStreams: isBusy(data.status) }); if (clearError) showError(); await listSessions(ticket);
  } catch (error) { if (ticket === epoch) showError(error.message); }
  finally { if (ticket === epoch) { loading = false; controls(); } }
}
function element(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
function imageIcon(name) { const node = element('span', 'ui-icon'); node.style.setProperty('--icon', 'url(./icons/' + name + '.svg)'); node.setAttribute('aria-hidden', 'true'); return node; }
async function action(task) { try { await task(); } catch (error) { showError(error.message || '操作未完成，请重试。'); } }
function renderResources(next) {
  const signature = JSON.stringify([next.recentBooks, next.book?.id, next.bookNotes, next.allNotes, next.notesScope, resourceQuery, resourceResults, next.activeNoteId]);
  if (signature === resourceKey) return; resourceKey = signature;
  $('current-book-label').textContent = next.bookInfo?.displayTitle || next.book?.title || '选择一本书开始阅读';
  $('current-book-label').title=next.book?.title||'';
  const source = next.bookNotes ?? {available:false,notes:[]};
  const data={...source,notes:source.notes.filter(n=>!resourceQuery||resourceResults?.includes(n.id))};
  $('note-tree').setAttribute('aria-label','本书笔记树');
  $('notes-heading').textContent = '本书笔记';
  $('notes-status').textContent = !next.book ? '选择书籍后查看关联笔记。' : !data.available ? '正在读取本书笔记…' : !data.notes.length ? (resourceQuery ? '没有匹配的笔记' : '本书暂无笔记') : '';
  $('notes-status').hidden = !$('notes-status').textContent;
  const tree = { folders: new Map(), notes: [] };
  for (const note of data.notes ?? []) { let node = tree; for (const segment of ((note.systemRecord||note.displayCategory==='书籍信息'?'书籍资料与系统记录/':'')+(note.bookRelativeFolder ?? note.folder ?? '')).split('/').filter(Boolean)) { if (!node.folders.has(segment)) node.folders.set(segment, {folders:new Map(),notes:[]}); node = node.folders.get(segment); } node.notes.push(note); }
  const root = $('note-tree'), scroller=root.closest('.notes-section'), oldScroll=scroller?.scrollTop; root.replaceChildren();
  const draw = (node, target, prefix = '') => {
    const secondary=[];
    for (const [name, child] of [...node.folders].sort(([a],[b])=>Number(a==='书籍资料与系统记录')-Number(b==='书籍资料与系统记录'))) {
      const path = prefix + '/' + name, key = next.notesScope+':'+next.book?.id + ':' + path;
      const systemOnly=node=>node.notes.every(n=>n.systemRecord||n.displayCategory==='书籍信息')&&[...node.folders.values()].every(systemOnly);if(!initializedFolders.has(key)){initializedFolders.add(key);if(systemOnly(child))collapsedFolders.add(key);}
      const wrapper = element('div', 'tree-folder'), toggle = element('button','folder-toggle');
      toggle.setAttribute('aria-expanded',String(!!resourceQuery||!collapsedFolders.has(key))); toggle.append(imageIcon('chevron-right'),imageIcon(collapsedFolders.has(key)?'folder-closed':'folder-open'),element('span','',name));
      const children = element('div','tree-children'); children.hidden = !resourceQuery&&collapsedFolders.has(key);
      toggle.onclick = () => { const visible=collapsedFolders.has(key);if(visible)collapsedFolders.delete(key);else collapsedFolders.add(key);toggle.setAttribute('aria-expanded',String(visible));toggle.children[1].style.setProperty('--icon','url(./icons/'+(visible?'folder-open':'folder-closed')+'.svg)');void window.readingMotion.visibility(children,visible,{trigger:toggle}); };
      draw(child,children,path); wrapper.append(toggle,children); if(!prefix&&name==='书籍资料与系统记录')secondary.push(wrapper);else target.append(wrapper);
    }
    for (const note of node.notes) { const button = element('button','note-row' + (next.activeNoteId === note.id ? ' selected' : ''));button.title=note.displayTitle||note.name;button.dataset.noteId=note.id;button.setAttribute('aria-current',next.activeNoteId===note.id?'page':'false');button.append(imageIcon('file-text'),element('span','',note.displayTitle||note.name));const text=element('span','note-description');text.append(element('small','note-preview',notePreviews.get(note.id)||note.body?.replace(/\s+/g,' ').slice(0,160)||'打开查看完整内容'),element('small','note-origin',(note.bookRelativeFolder||note.folder||'')+(note.systemRecord?' · 系统记录':'')));button.append(text);button.onclick=()=>action(()=>bridge.openNote(note.id));target.append(button); }
    target.append(...secondary);
  }; draw(tree,root);if(scroller)scroller.scrollTop=oldScroll;
}
function renderGuide(next) {
  const signature = JSON.stringify([next.book, next.bookInfo, next.guide, next.fixture,next.business]);
  if (signature === guideKey) return; guideKey = signature;
  const info = next.bookInfo ?? next.book ?? {};
  $('guide-title').textContent = info.displayTitle || info.title || '';$('guide-title').title=info.title||''; $('guide-author').textContent = info.author || '';
  $('guide-cover').hidden = !info.cover;
  if(info.cover&&/^reading-app:\/\/library\/book_[a-f0-9]{16}\/cover(?:\?v=[a-f0-9]{16})?$/.test(info.cover))$('guide-cover').src=info.cover;else if(info.cover&&/^books-assets\/[a-z0-9]+\.jpg$/.test(info.cover))$('guide-cover').src='reading-app://reader/'+info.cover;
  if(businessUI.render(next))return;
  const guide = next.fixture ? next.guide : null;
  $('fixture-banner').hidden = !next.fixture; $('guide-empty').hidden = !!guide; $('guide-details').hidden = !guide;
  $('analysis-scope').textContent = guide?.scope || '分析状态：尚未接入'; $('guide-details').replaceChildren();
  if (!guide) return;
  const content = $('guide-details'); content.append(element('h2','','本书浓缩'));
  for (const text of guide.overview) content.append(element('p','guide-overview',text));
  content.append(element('h2','','值得阅读的片段'));
  for (const row of guide.recommendations) {
    const card = element('section','recommendation');card.append(element('h3','',row.title),element('p','',row.text),element('p','','为什么值得读：'+row.reason),element('p','','来源：'+row.source));
    const actions = element('div','recommendation-actions'); const read = element('button','');read.append(imageIcon('book-open'),element('span','','读原文'));read.onclick=()=>action(()=>bridge.selectReadingTab('original'));
    const discuss = element('button','','讨论这段'); discuss.onclick=()=>{const text='【主动附加 · 合成验收材料，非真实原文引用】\n'+row.text+'\n'+row.source+'\n\n';$('question').value=text+$('question').value;draftRevision++;persistDraft();controls();void bridge.selectRightTool('chat');$('question').focus();};actions.append(read,discuss);card.append(actions);content.append(card);
  }
  const details=element('details','guide-evidence');details.append(element('summary','','展开分析依据与覆盖信息'),element('p','','这是隔离的视觉与交互验收夹具。没有真实分析覆盖、精确来源映射或用户知识推断。'));content.append(details,element('h2','','为什么推荐给你'),element('p','personalization',guide.personalization));
}
function render(next) {
  const wasReady = state?.runtime?.state === 'ready'; state = next; preserveToolBrowse(next);
  $('test-profile').hidden=!state.testProfile;$('runtime').title=state.runtime.message;
  const layout = state.layout ?? {};
  const windowTitle = state.view === 'books' ? 'AI 深度阅读' : state.view === 'markdown' && !state.workbenchNote ? '全部笔记' : (state.bookInfo?.displayTitle || state.book?.title || 'AI 深度阅读');
  document.body.classList.toggle('library-active',state.view==='books');
  $('window-title').textContent=windowTitle; $('window-title').title=state.book?.title && !['books','markdown'].includes(state.view) ? state.book.title : windowTitle;
  document.documentElement.style.setProperty('--top', (layout.top ?? 96) + 'px');
  document.documentElement.style.setProperty('--chat-width', (layout.chatWidth ?? 410) + 'px');
  document.documentElement.style.setProperty('--sidebar', (layout.sidebarWidth ?? 0) + 'px');
  document.documentElement.style.setProperty('--rail', (layout.railWidth ?? 60) + 'px');
  document.documentElement.style.setProperty('--content-left', (layout.content?.x ?? 60) + 'px');
  $('navigation-rail').hidden=!!state.immersive;
  $('all-books').setAttribute('aria-current',state.view==='books'?'page':'false');
  $('current-reading').setAttribute('aria-current',['reading','epub'].includes(state.view)?'page':'false');
  $('chat-resizer').hidden=!layout.showChat||layout.fullChat||state.immersive;
  for(const [key,value] of Object.entries({min:layout.chatMin,max:layout.chatMax,now:layout.chatWidth}))$('chat-resizer').setAttribute('aria-value'+key,String(value));
  $('chat-resizer').setAttribute('aria-valuetext',layout.chatWidth+' 像素');
  document.documentElement.style.setProperty('--content-right', layout.showChat && !layout.fullChat ? (layout.chatWidth + (layout.splitWidth||0)) + 'px' : '0px');
  document.body.classList.toggle('full-chat', !!layout.fullChat); document.body.classList.toggle('immersive',!!state.immersive);

  $('exit-immersive').hidden = !state.immersive;
  $('reading-bar').hidden = !!state.immersive || !!layout.fullChat || layout.top===48;
  $('reading-tabs').hidden = state.view !== 'reading'||state.workbenchNote; $('sidebar-toggle').hidden = false;
  $('sidebar-toggle').setAttribute('aria-label','笔记');$('sidebar-toggle').setAttribute('aria-current',state.workbenchNote||state.view==='markdown'?'page':'false');$('sidebar-toggle').setAttribute('aria-expanded',String(!!layout.sidebarWidth));
  $('return-workbench').hidden = state.view === 'reading'&&!state.workbenchNote&&state.readingTab==='original';$('return-workbench').lastChild.textContent=state.workbenchNote?'返回阅读':'返回工作台'; $('full-view-title').hidden = true;
  $('full-view-title').textContent = state.workbenchNote?(state.bookNotes?.notes?.find(n=>n.id===state.activeNoteId)?.displayTitle||'本书笔记'):{books:'AI 深度阅读',epub:'EPUB 阅读器',markdown:'全部笔记'}[state.view] ?? '';
  $('guide-panel').hidden = state.workbenchNote || state.view !== 'reading' || layout.fullChat || state.immersive || (state.readingTab === 'original' && state.book?.open);
  $('no-book').hidden = !!state.book?.open; $('book-guide').hidden = !state.book?.open || state.readingTab === 'annotations';
  $('annotations-panel').hidden = !state.book?.open || state.readingTab !== 'annotations';$('annotations-book').textContent = state.book?.title || '';
  for (const tab of ['guide', 'original','annotations']) { $(tab + '-tab').classList.toggle('selected', state.readingTab === tab); $(tab + '-tab').setAttribute('aria-pressed', String(state.readingTab === tab)); }
  void window.readingMotion?.visibility($('chat-panel'),!!layout.showChat,{trigger:$('global-chat'),kind:'page'}); $('chat-context').textContent = state.book?.id ? '当前讨论：' + (loading?'正在切换会话…':(state.bookInfo?.displayTitle||state.book.title)) : '当前讨论：一般阅读会话';
  $('global-chat').hidden=state.immersive||state.view==='books';$('global-chat').setAttribute('aria-expanded',String(!!layout.showChat));$('global-chat').title=layout.showChat?'收起阅读工具':'打开阅读工具';$('global-chat').setAttribute('aria-label',$('global-chat').title);$('global-chat').children[0].style.setProperty('--icon','url(./icons/'+(layout.showChat?'panel-right-close':'panel-right-open')+'.svg)');$('appearance-open').hidden=state.immersive;
  $('chat-expand').setAttribute('aria-label',state.chatExpanded?'恢复并排':'展开对话');
  for(const [id,name,label] of [['chat-expand',state.chatExpanded?'minimize':'maximize',state.chatExpanded?'恢复并排':'展开对话']]){const b=$(id);b.title=label;b.setAttribute('aria-label',label);b.children[0]?.style.setProperty('--icon','url(./icons/'+name+'.svg)');}
  $('chat-expand').hidden=!!layout.narrow;
  $('chat-expand').setAttribute('aria-expanded',String(!!state.chatExpanded));
  const guideChanged=JSON.stringify([next.book,next.bookInfo,next.guide,next.fixture,next.business])!==guideKey;
  const guideOpen=toolBrowse.get(browseBook)?.guideOpen;
  renderResources(next); renderGuide(next);annotationsUI.render(next);renderTools();
  if(guideChanged&&guideOpen)for(const [i,node] of [...$('book-guide').querySelectorAll('details')].entries())node.open=guideOpen.includes(i);
  if (state.runtime.state === 'ready') {
    const scope = state.book?.id ? { kind: 'book', bookId: state.bookInfo?.bookId || 'prototype:' + state.book.id } : { kind: 'general' };
    if(!wasReady)void action(searchResources);
    if (!wasReady || scopeKey(scope) !== scopeKey(currentScope)) void loadScope(scope, !wasReady);
  } else { modelAvailable = false; controls(); }
}
$('all-books').onclick = $('choose-book').onclick = () => action(()=>bridge.selectView('books'));
$('notes-search-toggle').onclick=()=>{const input=$('resource-search'),open=input.hidden;input.hidden=!open;$('notes-search-toggle').setAttribute('aria-expanded',String(open));if(open)input.focus();else{resourceQuery='';resourceResults=null;input.value='';resourceSearchEpoch++;resourceKey='';renderResources(state);}};
$('resource-search').onkeydown=e=>{if(e.key==='Escape'&&!e.isComposing){$('notes-search-toggle').click();$('notes-search-toggle').focus();}};
$('resource-search').oninput=()=>{resourceQuery=$('resource-search').value.trim();void action(searchResources);};
$('resource-close').onclick=()=>action(async()=>{await bridge.setSidebar(true);$('sidebar-toggle').focus();});
$('return-workbench').onclick = () => action(()=>bridge.selectView('reading'));
for (const tab of ['guide', 'original','annotations']) $(tab + '-tab').onclick = () => action(()=>bridge.selectReadingTab(tab));
$('read-original').onclick = () => action(()=>bridge.selectReadingTab('original')); $('runtime').onclick = () => bridge.showRuntimeStatus();
$('sidebar-toggle').onclick = () => action(async()=>{if(state.layout.sidebarWidth)await bridge.setSidebar(true);else await changeNoteScope(state.notesScope||'book');});
$('current-reading').onclick=()=>action(()=>bridge.selectView('reading'));
$('exit-immersive').onclick = () => action(()=>bridge.setImmersive(false));
async function closeChat() { await bridge.setChat({ visible: false, expanded: false, compact: false }); $('global-chat').focus(); }

$('global-chat').onclick = () => state.layout.showChat?closeChat():bridge.setChat({visible:true,compact:true});$('chat-expand').onclick=()=>bridge.setChat({expanded:!state.chatExpanded});
$('question').oninput = () => { draftRevision++; persistDraft(); controls(); };
$('question').addEventListener('compositionstart', () => { composing = true; controls(); }); $('question').addEventListener('compositionend', () => { composing = false; draftRevision++; persistDraft(); controls(); });
window.addEventListener('keydown', event => { if (event.key === 'Escape' && state?.immersive && !event.isComposing && !composing) void bridge.setImmersive(false); });
$('question').onkeydown = event => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !event.isComposing && !composing) { event.preventDefault(); $('composer').requestSubmit(); } };
$('composer').onsubmit = async event => {
  event.preventDefault(); if (busy || loading || composing || !modelAvailable || !currentSession) return;
  const text = $('question').value.trim(); if (!text) return;
  const ticket = epoch, id = currentSession, scope = { ...currentScope }, revision = draftRevision, statusAtSubmit = statusRevision, rawText = $('question').value, submissionKey = key(); loading = true; controls(); showError();
  try {
    const result = await bridge.sessions('prompt', { sessionId: id, scope, text });
    if (!result.accepted) throw new Error('发送未确认，请刷新会话核对。');
    if (saved(submissionKey) === rawText) { try { localStorage.setItem(submissionKey, ''); } catch {} }
    if (ticket !== epoch || currentSession !== id) return;
    if (draftRevision === revision && $('question').value === rawText) { $('question').value = ''; persistDraft(); }
    if (statusRevision === statusAtSubmit) setTurnStatus('queued');
    controls();
    void refreshHistory({ clearError: false });
  } catch (error) { if (ticket === epoch) showError(error.message || '发送结果未确认，请刷新会话后检查。'); }
  finally { if (ticket === epoch) { loading = false; controls(); } }
};
$('stop').onclick = async () => {
  const ticket = epoch, id = currentSession;
  try { await bridge.sessions('cancel', { sessionId: id, scope: currentScope }); if (ticket === epoch) { busy = false; await refreshHistory(); } }
  catch (error) { if (ticket === epoch) showError(error.message || '尚未确认停止，请重试。'); } controls();
};

$('new-session').onclick = async () => {
  if (loading || composing) return; persistDraft(); const ticket = ++epoch, revision = draftRevision; loading = true; controls();
  try { const data = await bridge.sessions('create', { scope: currentScope, title: '新主题' }); if (ticket !== epoch) return; applyHistory(data, { restoreDraft: draftRevision === revision }); if (draftRevision !== revision) persistDraft(); await listSessions(ticket); showError(); }
  catch (error) { if (ticket === epoch) showError(error.message); } finally { if (ticket === epoch) { loading = false; controls(); } }
};
async function selectSession(id) {
  if (loading || composing) return; persistDraft(); const ticket=++epoch,revision=draftRevision; loading=true;controls();
  try {const data=await bridge.sessions('resume',{sessionId:id,scope:currentScope});if(ticket===epoch){applyHistory(data,{restoreDraft:draftRevision===revision});if(draftRevision!==revision)persistDraft();showError();$('question').focus();return true}}
  catch(error){if(ticket===epoch)showError(error.message)}finally{if(ticket===epoch){loading=false;controls()}}
}
const sessionUI=installSessionUI({bridge,getScope:()=>({...currentScope}),getCurrent:()=>currentSession,selectSession,showError,getDraft:id=>id===currentSession?$('question').value:saved('reading:draft:'+id),refresh:async switched=>switched?loadScope(currentScope,true):refreshHistory()});
bridge.onSessionEvent(event => {
  sessionUI.status(event);
  if (event.sessionId !== currentSession || event.scope && scopeKey(event.scope) !== scopeKey(currentScope)) return;
  if (event.type === 'status') { setTurnStatus(event.status); statusRevision++; if (event.error) showError(event.error.message); controls(); }
  else if (event.type === 'assistant-start') streams.set(event.messageId, { id: event.messageId, role: 'assistant', text: '', streaming: true });
  else if (event.type === 'text-delta') {
    const message = streams.get(event.messageId) ?? { id: event.messageId, role: 'assistant', text: '', streaming: true };
    message.text += event.text; streams.set(event.messageId, message); renderMessages();
  } else if (event.type === 'message' && event.message) {
    const pending=messageNodes.get(event.messageId);
    if(pending&&event.messageId!==event.message.id&&!messageNodes.has(event.message.id)){messageNodes.delete(event.messageId);messageNodes.set(event.message.id,pending);}
    if (event.messageId) streams.delete(event.messageId);
    streams.delete(event.message.id);
    const existing = historyMessages.findIndex(message => message.id === event.message.id);
    if (existing >= 0) historyMessages[existing] = event.message; else historyMessages.push(event.message); renderMessages();
  } else if (event.type === 'assistant-end') { if (streams.has(event.messageId)) { streams.get(event.messageId).streaming = false; renderMessages(); } }
  else if (event.type === 'turn-complete') { busy = false; statusRevision++; if (event.error) showError(event.error.message); controls(); void refreshHistory({ clearError: !event.error }); }
});
Object.defineProperty(window, 'readingShellLifecycle', { value: Object.freeze({ flush: () => ({ ok: !composing && persistDraft() && annotationsUI.flush(), kind: 'chat-draft', view: 'shell' }) }) });
for(const b of document.querySelectorAll?.('button[aria-label]')??[])if(!b.title)b.title=b.getAttribute('aria-label');
const annotationsUI=installAnnotationsUI({bridge,getState:()=>state,discuss:id=>businessUI.discuss(id),observe:span=>businessUI.observation(span),showError});
bridge.onState(render); render(await bridge.getState());

bridge.onSource?.(value=>action(()=>value?.prepared?businessUI.restoreAttachment():businessUI.discuss(typeof value==='string'?value:value.spanId,typeof value==='object'?value:undefined)));

const appearanceDialog=$('appearance-dialog');
let appearanceOpening=null;
function openAppearance(){
 if(appearanceOpening)return appearanceOpening;
 if(appearanceDialog.open){$('appearance-close').focus();return Promise.resolve();}
 appearanceOpening=(async()=>{
  try{
   const p=await window.readingAppearance.get();
   $('app-mode').value=p.mode;$('app-accent').value=p.accent;$('appearance-status').textContent='';
   await window.readingAppearance.modal(true);
   appearanceDialog.showModal();
   void loadSearchPolicy();
   $('appearance-close').focus();
  }catch(error){
   // A failed dialog must never leave resident native readers hidden.
   await window.readingAppearance.modal(false).catch(()=>{});
   showError('未能打开外观设置，请重试');
  }finally{appearanceOpening=null;}
 })();
 return appearanceOpening;
}
$('appearance-open').onclick=openAppearance;
$('appearance-close').onclick=()=>appearanceDialog.close();
appearanceDialog.addEventListener('close',()=>{
 void window.readingAppearance.modal(false).then(()=>$('appearance-open').focus()).catch(()=>showError('未能恢复阅读视图，请重试打开并关闭设置'));
});
for(const id of ['app-mode','app-accent'])$(id).onchange=async()=>{try{await window.readingAppearance.set({mode:$('app-mode').value,accent:$('app-accent').value});$('appearance-status').textContent='外观偏好已保存';}catch{$('appearance-status').textContent='未能保存外观，请重试';}};
window.addEventListener('ai-reading:open-appearance',openAppearance);



let searchPolicyRevision=0;
async function loadSearchPolicy(){const ticket=++searchPolicyRevision;const input=$('auto-book-search');input.disabled=true;try{const p=await bridge.business('search-policy',{});if(ticket!==searchPolicyRevision)return;input.checked=p.enabled;$('search-policy-migration').hidden=!p.migration?.pending;$('search-policy-status').textContent='';}catch(e){$('search-policy-status').textContent='检索设置暂不可用：'+e.message;}finally{if(ticket===searchPolicyRevision)input.disabled=false;}}
$('auto-book-search').onchange=async()=>{const input=$('auto-book-search');const ticket=++searchPolicyRevision;input.disabled=true;try{const p=await bridge.business('set-search-policy',{enabled:input.checked});if(ticket!==searchPolicyRevision)return;input.checked=p.enabled;$('search-policy-migration').hidden=true;$('search-policy-status').textContent=p.enabled?'自动检索已开启':'自动检索已关闭';void businessUI.restoreAttachment();}catch(e){$('search-policy-status').textContent='未能保存：'+e.message;await loadSearchPolicy();}finally{if(ticket===searchPolicyRevision)input.disabled=false;}};
$('search-policy-ack').onclick=async()=>{try{await bridge.business('ack-search-migration',{});$('search-policy-migration').hidden=true;}catch(e){$('search-policy-status').textContent=e.message;}};

installWorkspaceResizer($('chat-resizer'),bridge,()=>state,error=>showError(error.message));
