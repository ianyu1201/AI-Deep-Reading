import {installReadingNavigation} from './reading-navigation.js';
import {installReadingControls} from './reading-controls.js';
import {PageTurnCoordinator,WheelGesture} from './page-input.js';
import {installAnnotationsReader} from './annotations-reader.js';
import {installSourceMapping} from './source-mapping-reader.js';
import {readingPrefs,effectiveTheme,readingPalette,effectiveFlow} from './reading-theme.js';
import {ImportedBooks} from './imported-books.js';
import {ReadingPosition,ensureScrolledAnchorVisible} from './reading-position.js';
import {installLifecycle} from './lifecycle.js';
import {installBookContext} from './book-context.js';
import '../vendor/foliate-js/view.js';
import {$,el,button,icons,storage,toast} from './shared.js';
import {inspectFile} from './preflight.js';
import {installAppleLibraryPanel} from './apple-library-panel.js';
const motion=window.readingMotion;
const desktopBooks=window.readingDesktopBooks;
const managedBooks=desktopBooks?await desktopBooks.ready():false;
const catalog=managedBooks?(await desktopBooks.list()).books.map(x=>({...x,file:x.url})):await (await fetch('books-assets/catalog.json')).json();
if(managedBooks)$('.library-tip-title').textContent='书籍保存在本应用的独立书库 · 可从右上角导入 EPUB';
const state={catalog,query:'',immersive:false,book:null,meta:null,view:null,loc:null,busy:false,prefs:readingPrefs(storage.get('books-r1:prefs',{}))};
const importedBooks=new ImportedBooks();
const bookContext=installBookContext();
const key=s=>'books-r1:'+s;
const position=new ReadingPosition(loc=>{storage.set(key('position:'+state.meta.id),loc.cfi);storage.set(key('progress:'+state.book.id),loc.fraction)});
const flatten=(items,depth=0)=>items.flatMap(x=>[{...x,depth},...flatten(x.subitems??[],depth+1)]);
Object.defineProperty(window,'aiReadingLibrary',{value:Object.freeze({getSnapshot:()=>state.catalog.map(({id,title,author,cover})=>Object.freeze({id,title,author,cover}))}),writable:false,configurable:false});
function progress(book){return storage.get(key('progress:'+book.id),0)}
function renderLibrary(){
 closeBookMenu();
 const rows=state.catalog.filter(x=>(x.title+' '+x.author).toLowerCase().includes(state.query.trim().toLowerCase()));
 $('#book-grid').replaceChildren();
 for(const book of rows){
  const tile=el('article','book-tile');tile.setAttribute('data-book-id',book.id);
  const open=button('阅读 '+book.title,null,()=>openBook(book),'cover-open');open.textContent='';
  if(book.cover){const img=el('img');img.src=book.cover;img.alt=book.title;open.append(img)}else{const fallback=el('span','local-cover',book.displayTitle??book.title);fallback.title=book.coverStatus==='unsupported'?'封面格式暂不支持':book.coverStatus==='unavailable'?'封面暂不可读取':'此书未提供封面';open.append(fallback)}
  const cover=el('div','book-cover');
  const actions=button('书籍操作：'+book.title,'Ellipsis',e=>showBookMenu(book,e.currentTarget),'book-actions-trigger');actions.setAttribute('aria-haspopup','menu');actions.setAttribute('aria-expanded','false');actions.setAttribute('aria-controls','book-actions');cover.append(open,actions);
  const fraction=Math.max(0,Math.min(1,Number(progress(book))||0));
  const meta=el('div','cover-meta'),position=el('span','book-progress-label',fraction>0?Math.round(fraction*100)+'%':'未开始');
  const bar=el('progress','book-progress');bar.max=1;bar.value=fraction;bar.setAttribute('aria-label',book.title+' 阅读位置');bar.setAttribute('aria-valuetext',position.textContent);
  meta.title='阅读位置，不代表分析覆盖率或掌握程度';meta.append(bar,position);
  const title=el('h2','book-name',book.displayTitle??book.title);title.title=book.title;
  tile.append(cover,title,el('p','book-author',book.author),meta,el('p','analysis-status',book.analysisStatus??'分析未接入'));$('#book-grid').append(tile);
 }
 $('#library-empty').hidden=rows.length>0;$('#library-empty').textContent=state.catalog.length?'没有匹配的书籍，请尝试其他书名或作者。':'这里还没有图书，可从右上角导入 EPUB。';
}
async function importBook(){if(!managedBooks){$('#epub-file').click();return;}try{const result=await desktopBooks.importFile();if(result?.cancelled||result?.canceled||result?.cancel)return;if(result?.books){state.catalog=result.books.map(x=>({...x,file:x.url}));renderLibrary();window.dispatchEvent(new Event('ai-reading:library-changed'));}}catch(error){toast('导入失败：'+error.message)}}
installAppleLibraryPanel({bridge:managedBooks?desktopBooks:null,onImported:books=>{state.catalog=books.map(x=>({...x,file:x.url}));renderLibrary();}});
let bookMenuTrigger=null;
function closeBookMenu(restore=false){
 const menu=$('#book-actions');menu.hidden=true;
 if(bookMenuTrigger){bookMenuTrigger.setAttribute('aria-expanded','false');if(restore&&bookMenuTrigger.isConnected)bookMenuTrigger.focus();}
 bookMenuTrigger=null;
}
function showBookMenu(book,trigger){
 const same=bookMenuTrigger===trigger&&!$('#book-actions').hidden;closeBookMenu();if(same)return;
 void motion.visibility($('#library-actions'),false);
 const menu=$('#book-actions');bookMenuTrigger=trigger;
 const read=button(progress(book)>0?'继续阅读':'开始阅读','BookOpen',async()=>{closeBookMenu();await openBook(book)},'');
 const contents=button('查看目录','List',async()=>{closeBookMenu();await openBook(book);if(state.view&&state.book?.id===book.id)togglePanel('#toc-panel')},'');
 for(const item of [read,contents]){item.append(document.createTextNode(item.getAttribute('aria-label')));item.setAttribute('role','menuitem');item.tabIndex=-1;}
 menu.replaceChildren(read,contents);menu.hidden=false;trigger.setAttribute('aria-expanded','true');
 const a=trigger.getBoundingClientRect(),box=menu.getBoundingClientRect();
 menu.style.right=Math.max(12,innerWidth-a.right)+'px';menu.style.top=Math.max(12,Math.min(a.bottom+8,innerHeight-box.height-12))+'px';read.focus();
}
function globalMenu(){closeBookMenu();const menu=$('#library-actions');const anchor=$('#library-menu').getBoundingClientRect();menu.style.top=(anchor.bottom+8)+'px';menu.style.right=Math.max(12,innerWidth-anchor.right)+'px';menu.replaceChildren(button('导入 EPUB…','Upload',()=>{void importBook();void motion.visibility(menu,false,{trigger:$('#library-menu')})},''),button('按书名排序','ArrowUpDown',()=>{state.catalog.sort((a,b)=>a.title.localeCompare(b.title));renderLibrary();void motion.visibility(menu,false,{trigger:$('#library-menu')})},''));for(const item of menu.children)if(!item.textContent.trim())item.append(document.createTextNode(item.getAttribute('aria-label')??''));void motion.visibility(menu,!motion.shown(menu),{trigger:$('#library-menu')})}
const panelTriggers={'toc-panel':'toc-toggle','appearance-panel':'appearance-toggle','search-panel':'reader-search-toggle'};
function closePanels(){for(const p of document.querySelectorAll('.popover')){void motion.visibility(p,false,{trigger:$('#'+panelTriggers[p.id])});$('#'+panelTriggers[p.id]).setAttribute('aria-expanded','false')}}
function togglePanel(id){readingControls.reveal();void cancelPageInput();const open=!motion.shown($(id));closePanels();void motion.visibility($(id),open,{trigger:$('#'+panelTriggers[$(id).id])});$('#'+panelTriggers[$(id).id]).setAttribute('aria-expanded',String(open));if(id==='#search-panel'&&open)$('#reader-query').focus()}
function css(palette){const p=state.prefs;return `html{font-size:${p.font}px!important;color:${palette.ink}!important;background:${palette.paper}!important;color-scheme:${effectiveTheme(p,state.immersive)==='dark'?'dark':'light'}!important}body{font-family:Georgia,"Songti SC",serif!important;font-size:1rem!important;background:transparent!important;color:inherit!important}p,li,blockquote,td{line-height:${p.spacing}!important}h1,h2,h3,p,span,small{color:inherit!important}a,a:visited{color:${palette.link}!important}img{max-width:100%}::selection{background:${palette.selection};color:${palette['selection-text']}}::highlight(reading-source){background:${palette.selection};color:${palette['selection-text']}}`}
const appliedStyles=new WeakMap();
async function applyPrefs(){
 const p=state.prefs,theme=effectiveTheme(p,state.immersive),flow=effectiveFlow(state.immersive);
 if(!window.readingAppearance)document.body.dataset.theme=theme==='dark'?'dark':'light';
 document.body.dataset.readingTheme=theme;
 const palette=readingPalette($('#reading-view'));
 $('#font-size').textContent=p.font;$('#reading-flow').textContent=state.view?.isFixedLayout?'固定版式（按原书分页）':state.immersive?'沉浸分页':'纵向滚动';
 for(const id of ['previous-page','next-page'])$('#'+id).hidden=!state.immersive&&!state.view?.isFixedLayout;
 $('#reading-flow').title=state.view?.isFixedLayout?'此书采用固定版式，无法转换为连续流式正文。':'普通阅读连续滚动；沉浸阅读按窗口宽度分页。';$('#reading-spacing').value=String(p.spacing);
 for(const b of document.querySelectorAll('button[data-theme]')){const selected=b.dataset.theme===theme;b.classList.toggle('selected',selected);b.setAttribute('aria-pressed',String(selected))}
 storage.set(key('prefs'),p);
 const r=state.view?.renderer;
 if(r&&!state.view.isFixedLayout){for(const [name,value] of Object.entries({flow,margin:'0px',gap:'6.2%','max-column-count':state.immersive&&innerWidth>=960?'2':'1','max-inline-size':'620px'}))if(r.getAttribute(name)!==value)r.setAttribute(name,value);const styles=css(palette);if(appliedStyles.get(r)!==styles){r.setStyles(styles);appliedStyles.set(r,styles)}}
}
function controlBusy(value){state.busy=value;if(!value)window.dispatchEvent(new Event('ai-reading:book-ready'));$('#reader-loading').hidden=!value;for(const id of ['next-page','previous-page','font-plus','font-minus','reading-spacing'])$('#'+id).disabled=value||!!state.view?.isFixedLayout&&['font-plus','font-minus','reading-spacing'].includes(id)}

const sectionStatus=el('div','section-load-status');sectionStatus.hidden=true;sectionStatus.setAttribute('role','status');$('#reading-view').append(sectionStatus);
function installSectionStatus(view){
 const pending=new Set(),failed=new Map();
 view.renderer?.addEventListener('section-load-state',({detail:d})=>{
  if(state.view!==view)return;
  if(d.state==='loading'){pending.add(d.index);failed.delete(d.index);}
  else {pending.delete(d.index);if(d.state==='error')failed.set(d.index,d.message);else failed.delete(d.index);}
  sectionStatus.replaceChildren();sectionStatus.hidden=!pending.size&&!failed.size;
  if(failed.size){sectionStatus.append(el('span','','相邻章节暂不可用，当前正文已保留。'));const retry=button('重试',null,async()=>{retry.disabled=true;try{await view.renderer.retrySections?.();}catch(e){toast('重试未完成：'+e.message);}finally{retry.disabled=false;}},'text-button');retry.textContent='重试';sectionStatus.append(retry);}
  else if(pending.size)sectionStatus.textContent='正在载入相邻章节…';
 });
}
window.addEventListener('ai-reading:book-context',()=>{sectionStatus.hidden=true;});

let pendingBook=null;
async function openBook(book,file,intent){intent??=bookContext.begin(book.id);if(state.busy){pendingBook={book,file,intent};return;}if(state.view&&state.book?.id===book.id&&!file){showReader();bookContext.opened({id:book.id.startsWith('local:')?'local:'+state.meta.id:book.id,title:state.meta.title,author:book.author},intent);return;}await cancelPageInput();position.begin();closePanels();state.view?.close();state.view?.book?.destroy?.();state.view?.remove();state.view=null;bookContext.closed();state.loc=null;state.book=book;discussSelection.hidden=true;$('#reading-title').textContent=book.title;$('#library-view').hidden=true;$('#reading-view').hidden=false;$('#reader-error').hidden=true;controlBusy(true);let timer;
 try{file??=importedBooks.get(book.id);if(!file){const r=await fetch(book.file);if(!r.ok)throw Error('无法获取 EPUB 文件');file=new File([await r.blob()],book.id+'.epub',{type:'application/epub+zip'})}const meta=await inspectFile(file);state.meta=meta;if(book.id.startsWith('local:')){book=importedBooks.remember(meta,file);state.book=book;}$('#reading-title').textContent=meta.title;$('#reading-title').hidden=(!!desktopBooks||state.desktopContainer)&&!state.immersive;$('#reading-title').title=meta.title;const view=document.createElement('foliate-view');state.view=view;$('#reader').replaceChildren(view);view.addEventListener('relocate',({detail:d})=>{state.loc=d;if(!$('#reading-view').hidden)position.observe(d);$('#reading-location').textContent=d.tocItem?.label??book.title;$('#reading-progress').textContent=Math.round((d.fraction??0)*100)+'%';window.dispatchEvent(new Event('ai-reading:location-changed'))});view.addEventListener('link',e=>{e.preventDefault();void go(e.detail.href)});view.addEventListener('external-link',e=>{e.preventDefault();toast('原型不打开书内外部链接')});view.addEventListener('load',()=>{$('#reader-loading').textContent='正在准备阅读位置…'});view.addEventListener('load',({detail:{doc}})=>{readingControls.load(doc);doc.addEventListener('keydown',e=>{readerKey(e)});doc.addEventListener('selectionchange',updateSelectionAction);annotations.load({doc});doc.addEventListener('wheel',scrollAcrossChapter,{passive:false});updateSelectionAction();});
 await Promise.race([(async()=>{$('#reader-loading').textContent='正在解析 EPUB…';await view.open(file);installSectionStatus(view);$('#reader-loading').textContent='正在排版正文…';if(!view.isFixedLayout){const r=view.renderer,render=r.render.bind(r);r.render=()=>{if(r.getContents().some(x=>x.doc?.body))return render()}}await applyPrefs();await view.init({lastLocation:storage.get(key('position:'+meta.id),undefined),showTextStart:true})})(),new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('打开超时，请返回书库换一本书')),15000))]);
 position.loaded(state.loc);renderTOC();if(book.id.startsWith('local:')){const existing=state.catalog.findIndex(x=>x.id===book.id);if(existing<0)state.catalog.push(book);else state.catalog[existing]=book;window.dispatchEvent(new Event('ai-reading:library-changed'));}bookContext.opened({id:book.id.startsWith('local:')?'local:'+meta.id:book.id,title:meta.title,author:book.author},intent);if(meta.missing.length)toast('部分资源缺失，正文可试读');
 }catch(e){position.begin();state.view?.close();state.view?.remove();state.view=null;$('#reader-error').textContent='无法打开这本书\n'+(/zip|central directory/i.test(e.message)?'EPUB 文件损坏或不是有效压缩包。':e.message)+'\n可通过左上角返回书库。';$('#reader-error').hidden=false}finally{clearTimeout(timer);controlBusy(false);if(!state.view){$('#next-page').disabled=true;$('#previous-page').disabled=true}if(pendingBook){const next=pendingBook;pendingBook=null;await openBook(next.book,next.file,next.intent)}}
}
let navigation=Promise.resolve();
const wheelGesture=new WheelGesture();
const pageInput=new PageTurnCoordinator({
 available:()=>!state.busy&&!position.locked&&!position.suspended&&!!state.view&&!$('#reading-view').hidden,
 changed:status=>{$('#reader').dataset.pageTurn=status;$('#reader').setAttribute('aria-busy',String(status==='turning'))},
 error:error=>toast('翻页未完成：'+error.message),
 turn:async dir=>{const view=state.view,renderer=view.renderer;renderer?.toggleAttribute('animated',!motion.reduced.matches&&state.immersive&&!view.isFixedLayout);try{await view[dir]()}finally{renderer?.removeAttribute('animated')}}
});
function cancelPageInput(){wheelGesture.reset();return pageInput.cancel()}
function navigate(dir){navigation=pageInput.request(dir);return navigation}
function inputBlocked(event){return event.ctrlKey||event.metaKey||event.altKey||event.shiftKey||event.buttons>0||event.target?.closest?.('input,select,textarea,[contenteditable="true"],.popover,.annotation-editor,[role="menu"],dialog')||(event.type==='wheel'&&event.target?.closest?.('button,a'))||[...document.querySelectorAll('.popover,.annotation-editor,dialog')].some(p=>p.tagName==='DIALOG'?p.open:motion.shown(p))||!!selectionSnapshot()}
window.addEventListener('ai-reading:cancel-page-input',cancelPageInput);
$('#reader').addEventListener('wheel',scrollAcrossChapter,{passive:false});
// Ordinary reading uses a bounded adjacent-document window; immersive input
// is separately coordinated as page-turn intentions.
function scrollAcrossChapter(event){
 if(inputBlocked(event))return;
 if(state.immersive){const gesture=wheelGesture.feed(event);if(gesture.consume)event.preventDefault();if(gesture.direction)void navigate(gesture.direction);return;}
 if(state.view?.isFixedLayout||Math.abs(event.deltaY)<=Math.abs(event.deltaX))return;
 const r=state.view?.renderer;if(!r)return;
 if(r.continuousScroll){event.preventDefault();const unit=event.deltaMode===1?state.prefs.font*state.prefs.spacing:event.deltaMode===2?Math.max(100,innerHeight-100):1;r.scrollContinuous(event.deltaY*unit);return;}
 const forward=event.deltaY>0;
 const edge=forward?r.viewSize-r.end<=2:r.start<=1;
 if(!edge)return;
 event.preventDefault();void navigate(forward?'next':'prev');
}
async function go(href,{remember=true}={}){await cancelPageInput();const target=state.view;if(position.locked||position.suspended){window.dispatchEvent(new Event('ai-reading:activate'));await window.aiReadingLifecycle.ready();}if(state.view!==target||!target)return;const token=remember?readingControls.beforeJump():null;try{if(typeof href==='string'&&!href.startsWith('epubcfi(')&&!href.startsWith(state.meta.root))href=state.meta.root+href;const resolved=await target.resolveNavigation(href);if(!resolved)throw Error('位置不可用');await target.renderer.goTo(resolved);readingControls.afterJump(token);closePanels();return true;}catch(e){readingControls.afterJump(token,false);toast('无法跳转：'+e.message);if(!remember)throw e;return false;}}
const readingControls=installReadingControls({getState:()=>state,go,toast});
function renderTOC(){$('#toc').replaceChildren();for(const item of flatten(state.view.book.toc??[])){const b=button(item.label,null,()=>go(item.href),'');b.style.paddingLeft=(8+item.depth*14)+'px';$('#toc').append(b)}}
function showLibrary(){
 void cancelPageInput();
 $('#reading-view').hidden=true;$('#library-view').hidden=false;
 if(!window.readingAppearance)document.body.dataset.theme='white';closePanels();renderLibrary();
}
function showReader(){
 if(!state.view)return;
 $('#library-view').hidden=true;$('#reading-view').hidden=false;
 closePanels();

}
$('#back-library').onclick=()=>{showLibrary();window.dispatchEvent(new Event('ai-reading:library-request'))};
window.addEventListener('ai-reading:show-library',showLibrary);
window.addEventListener('ai-reading:show-reader',showReader);
$('#library-menu').onclick=globalMenu;$('#library-query').oninput=e=>{state.query=e.target.value;renderLibrary()};$('#epub-file').onchange=async e=>{const file=e.target.files[0];if(file){await openBook({id:'local:'+file.name,title:file.name.replace(/\.epub$/i,''),author:'本地文件'},file)}e.target.value=''};
$('#next-page').onclick=()=>navigate('next');$('#previous-page').onclick=()=>navigate('prev');$('#toc-toggle').onclick=()=>togglePanel('#toc-panel');$('#appearance-toggle').onclick=()=>togglePanel('#appearance-panel');$('#reader-search-toggle').onclick=()=>togglePanel('#search-panel');for(const b of document.querySelectorAll('.close-popover'))b.onclick=closePanels;
async function settleLayout(view){
 await view.renderer?.ready?.();
 const docs=view.renderer?.getContents?.()??[];
 let timer;
 try {await Promise.race([Promise.all(docs.map(x=>x.doc?.fonts?.ready)),new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('字体加载超时，已保留之前的阅读位置')),5000))])}
 finally {clearTimeout(timer)}
 await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
}
async function restoreTextPosition(view,cfi){
 await view.goTo(cfi);
 await ensureScrolledAnchorVisible(view,cfi);
}
async function changePrefs(patch){
 await cancelPageInput();
 if(state.busy||position.locked)return;
 Object.assign(state.prefs,patch);
 const view=state.view;
 if(!view||view.isFixedLayout){await applyPrefs();return}
 for(const id of ['next-page','previous-page','font-plus','font-minus','reading-spacing'])$('#'+id).disabled=true;
 try {await position.reflow({apply:applyPrefs,settle:()=>settleLayout(view),restore:cfi=>restoreTextPosition(view,cfi)})}
 catch(e){toast('调整显示未完成：'+e.message)}
 finally {if(state.view===view)controlBusy(state.busy)}
}
$('#font-plus').onclick=()=>changePrefs({font:Math.min(36,state.prefs.font+2)});
$('#font-minus').onclick=()=>changePrefs({font:Math.max(14,state.prefs.font-2)});
for(const b of document.querySelectorAll('button[data-theme]'))b.onclick=()=>changePrefs({theme:b.dataset.theme,themeOrigin:'user'});
$('#reading-spacing').onchange=e=>changePrefs({spacing:Number(e.target.value)});
$('#reader-query').oninput=e=>{const q=e.target.value.trim().toLowerCase();$('#reader-results').replaceChildren();if(!q)return;const hits=state.meta?.search.filter(x=>x.text.toLowerCase().includes(q)).slice(0,40)??[];for(const hit of hits)$('#reader-results').append(button(hit.text.slice(0,140),null,()=>go(hit.href),''));if(!hits.length)$('#reader-results').textContent='没有找到匹配文字'};
function readerKey(e){
 if(e.isComposing||e.keyCode===229)return;
 if($('#apple-books-dialog').open)return;
 if(e.key==='Escape'){
  void cancelPageInput();
  const panel=[...document.querySelectorAll('.popover')].some(p=>motion.shown(p));
  closePanels();void motion.visibility($('#library-actions'),false,{trigger:$('#library-menu')});
  if(state.immersive&&!panel)window.dispatchEvent(new Event('ai-reading:exit-immersive'));
  e.preventDefault();return;
 }
 if(inputBlocked(e)||$('#reading-view').hidden)return;
 if(!state.immersive&&!state.view?.isFixedLayout)return;
 if(e.key==='ArrowRight'){e.preventDefault();navigate('next')}
 if(e.key==='ArrowLeft'){e.preventDefault();navigate('prev')}
}
window.addEventListener('keydown',readerKey);
$('#immersive-toggle').onclick=()=>window.dispatchEvent(new Event('ai-reading:enter-immersive'));
$('#immersive-previous').onclick=()=>navigate('prev');
$('#immersive-next').onclick=()=>navigate('next');
$('#immersive-return').onclick=()=>window.dispatchEvent(new Event('ai-reading:exit-immersive'));
window.addEventListener('ai-reading:display-mode',e=>{
 if(typeof e.detail?.immersive!=='boolean')return;
 state.desktopContainer=true;document.body.classList.add('workspace-reader');document.querySelector('#workspace-reading-tabs').hidden=true;
 $('#reading-title').hidden=!e.detail.immersive;
 $('#back-library').hidden=e.detail.immersive||e.detail.container==='reading';
 if(state.immersive===e.detail.immersive)return;
 void cancelPageInput();position.hold();state.immersive=e.detail.immersive;
 $('.immersive-pages').hidden=!state.immersive;
 document.body.classList.toggle('immersive',state.immersive);
 $('#reading-title').hidden=(!!desktopBooks||state.desktopContainer)&&!state.immersive;
 $('#immersive-toggle').hidden=state.immersive;$('#immersive-return').hidden=!state.immersive;$('#back-library').hidden=state.immersive||e.detail?.container==='reading';

});
window.addEventListener('ai-reading:open-book',e=>{
 const id=e.detail?.id;
 if(typeof id!=='string')return;
 const book=state.catalog.find(x=>x.id===id);
 if(book)openBook(book,undefined,e.detail.intent);
});
let resizeTimer;
window.addEventListener('ai-reading:activate',()=>{void cancelPageInput();clearTimeout(resizeTimer);position.hold()});
window.addEventListener('resize',()=>{void cancelPageInput();position.hold();clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>window.dispatchEvent(new Event('ai-reading:activate')),160)});
document.addEventListener('click',e=>{if(!e.target.closest('#book-actions,.book-actions-trigger'))closeBookMenu();if(!e.target.closest('#library-actions,#library-menu'))void motion.visibility($('#library-actions'),false,{trigger:$('#library-menu')})});
motion.reduced.addEventListener('change',()=>state.view?.renderer?.removeAttribute('animated'));
icons();renderLibrary();

installLifecycle({
 view:'books',
 activate:async()=>{
  await cancelPageInput();await navigation.catch(()=>{});
  const view=state.view;
  if(!view||state.busy||$('#reading-view').hidden)return;
  await position.reflow({
   apply:async()=>{await applyPrefs();view.renderer?.render?.()},
   settle:()=>settleLayout(view),restore:cfi=>restoreTextPosition(view,cfi)
  });
  // Current document may have been replaced by pagination. Restore verified
  // persistent marks before declaring the reader lifecycle ready.
  await annotations.refresh();
 },
 flush:()=>{
  let ok=annotations.flush()&&storage.set(key('prefs'),state.prefs);
  const stable=position.last;
  if(stable&&state.meta&&state.book){
   ok=storage.set(key('position:'+state.meta.id),stable.cfi)&&ok;
   ok=storage.set(key('progress:'+state.book.id),stable.fraction)&&ok;
  }
  return ok;
 }
});

const discussSelection=button('向 AI 提问','MessageCircle',()=>attachSelection(),'text-button');
discussSelection.append(document.createTextNode('向 AI 提问'));
discussSelection.id='discuss-selection';discussSelection.hidden=true;
discussSelection.title='附加选文到当前会话，不自动发送';
discussSelection.addEventListener('mousedown',event=>event.preventDefault());
$('.reader-right').prepend(discussSelection);
let selectingBusy=false;
function selectionSnapshot(){
 const documents=state.view?.renderer?.getContents?.()??[];
 const selected=documents.map(({doc})=>doc?.getSelection()).filter(x=>x?.rangeCount&&!x.isCollapsed);
 return selected.length===1?selected[0].getRangeAt(0).cloneRange():null;
}
function updateSelectionAction(){const range=selectionSnapshot();discussSelection.hidden=!managedBooks||!range||!range.toString().trim();discussSelection.disabled=selectingBusy;}
async function attachSelection(){
 if(selectingBusy)return;
 const view=state.view,book=state.book,range=selectionSnapshot();if(!range)return;
 selectingBusy=true;updateSelectionAction();
 try{
  const current=window.aiReadingSource.current();
  const mapping=await desktopBooks.sourceChapter({bookId:book.id,href:current.href});
  const live=selectionSnapshot();
  if(state.view!==view||!live||live.startContainer!==range.startContainer||live.startOffset!==range.startOffset||live.endContainer!==range.endContainer||live.endOffset!==range.endOffset)throw Error('选文已变化，请重新选择后附加');
  const candidate=await window.aiReadingSource.selection(mapping);
  const result=await desktopBooks.discussSelection({...candidate,bookId:book.id,selectionToken:mapping.selectionToken});
  if(result?.ok===false)throw Error(result.message??result.error??'选文核验未完成');
  toast('选文已附加到当前会话，尚未发送');
 }catch(error){toast('选文未附加：'+error.message)}
 finally{selectingBusy=false;updateSelectionAction();}
}


installSourceMapping({getState:()=>state,ready:async()=>{await cancelPageInput();if(state.busy)await new Promise(resolve=>window.addEventListener('ai-reading:book-ready',resolve,{once:true}));if(position.locked||position.suspended){window.dispatchEvent(new Event('ai-reading:activate'));await window.aiReadingLifecycle.ready();}}});

const annotations=installAnnotationsReader({getState:()=>state,bridge:managedBooks?desktopBooks:null,discuss:attachSelection,toast});
installReadingNavigation({getState:()=>state,bridge:managedBooks?desktopBooks:null,go,closePanels,reveal:()=>readingControls.reveal()});

window.addEventListener('ai-reading:library-status',event=>{
 if(!managedBooks||!Array.isArray(event.detail?.books))return;
 const updates=new Map(event.detail.books.map(row=>[row.id,row]));
 let structureChanged=false;
 state.catalog=state.catalog.map(row=>{const next={...row,...updates.get(row.id)};if(['title','displayTitle','author','cover','coverStatus'].some(k=>row[k]!==next[k]))structureChanged=true;return next;});
 if(structureChanged){renderLibrary();return;}
 // Status refreshes must not replace focused cover/menu triggers.
 const current=new Map(state.catalog.map(row=>[row.id,row]));
 for(const tile of $('#book-grid').querySelectorAll('.book-tile')){const row=current.get(tile.getAttribute('data-book-id'));if(row)tile.querySelector('.analysis-status').textContent=row.analysisStatus??'分析未接入';}

});
window.aiReadingBooksReady=true;
window.dispatchEvent(new Event('ai-reading:books-initialized'));

// One content toolbar, owned by the resident reader while it is visible.
const workspaceTabs=el('nav');workspaceTabs.id='workspace-reading-tabs';workspaceTabs.setAttribute('aria-label','阅读内容');workspaceTabs.hidden=true;
for(const [target,label] of []){const b=button(label,null,()=>window.dispatchEvent(new CustomEvent('ai-reading:workspace-navigation',{detail:target})));b.textContent=label;b.setAttribute('aria-pressed',String(target==='original'));workspaceTabs.append(b)}
$('.reading-toolbar').prepend(workspaceTabs);

$('#book-actions').addEventListener('keydown',e=>{
 const items=[...$('#book-actions').querySelectorAll('[role=menuitem]')],i=items.indexOf(document.activeElement);
 if(e.key==='Escape'){e.preventDefault();e.stopPropagation();closeBookMenu(true);return;}
 if(e.key==='Tab'){closeBookMenu(true);return;}
 const next=e.key==='ArrowDown'?(i+1)%items.length:e.key==='ArrowUp'?(i+items.length-1)%items.length:e.key==='Home'?0:e.key==='End'?items.length-1:-1;
 if(next>=0){e.preventDefault();items[next].focus();}
});
window.addEventListener('resize',()=>closeBookMenu());
$('.library-scroll').addEventListener('scroll',()=>closeBookMenu(),{passive:true});
