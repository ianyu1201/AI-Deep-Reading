import {bookMetadata,renderBookMetadata} from './book-metadata.js';
import {foldNoteDiagnostics} from './note-reading-presentation.js';
import {noteSources,openNoteSource} from './source-note.js';
const motion=window.readingMotion;
import {livePreview as live} from './live-preview.js';
import {installLifecycle} from './lifecycle.js';
import {makeNoteTree,folderPaths,noteSnapshot} from './note-tree.js';
import {EditorView,keymap,drawSelection} from '@codemirror/view';
import {EditorState} from '@codemirror/state';
import {history,defaultKeymap,historyKeymap,indentWithTab} from '@codemirror/commands';
import {searchKeymap,highlightSelectionMatches} from '@codemirror/search';
import {markdown} from '@codemirror/lang-markdown';
import MarkdownIt from 'markdown-it';
import {installWikiLinks,parseNavigation} from './markdown-navigation.js';
import {$,el,button,icon,icons,storage,toast,download} from './shared.js';
const samples=[
 {id:'welcome',name:'索引',folder:'',body:'## 书籍知识库\n\n这里是演示草稿，尚未连接真实的 45-书籍 目录。\n\n- [[阅读笔记]]：记录原文、观点与疑问\n- [[主动回忆]]：回看自己的理解\n\n## 使用方式\n\n从左侧选择笔记，直接编辑或切换阅读视图。可以搜索、查看大纲和关联笔记，也可以导出 Markdown。\n'},
 {id:'reading',name:'阅读笔记',folder:'书籍',body:'## 原文与理解\n\n这是一篇演示笔记。阅读时，将作者的观点、自己的判断与 AI 的解释分开记录。\n\n- **作者的观点**：记录主张及成立条件。\n- **原文依据**：留下书名、章节和可核验的位置。\n- **我的疑问**：哪些地方尚未理解，或者暂时不同意？\n\n## 回看\n\n把一个需要进一步解释的问题链接到 [[主动回忆]]。\n'},
 {id:'recall',name:'主动回忆',folder:'理解变化',body:'## 回看自己的理解\n\n这是一篇演示笔记。合上原文后，用自己的话解释一个观点，再回去核对遗漏和误解。\n\n## 留下依据\n\n记录当时的回答、核对后的变化，以及仍未解决的问题。\n\n相关笔记：[[阅读笔记]]\n'}];
const formal=new URL(location.href).searchParams.get('formalNotes')==='1';
const emptyNote={id:'',name:'书籍知识库',folder:'',body:'尚无可用笔记。请先完成阅读分析或采集沉淀。',readOnly:true};
let noteScope='',formalReady=false,formalBusy=false;
let notes=formal?[{...emptyNote}]:storage.get('markdown-r1:notes',samples);
async function noteCall(action,payload={}){if(!window.readingNotes)throw new Error('正式文件服务尚未连接');const r=await window.readingNotes.call(action,payload);if(r?.error)throw Object.assign(new Error(r.error.message),r.error);return r?.result??r;}
function draftKey(){return 'markdown-formal:'+noteScope;}
function showSaveState(){const n=current();$('#save-state').textContent=n.externalChanged?'磁盘文件已变化 · 请刷新查看':!formalReady?'正式文件尚未连接':n.conflict?'外部文件已变化 · 草稿已保留':n.dirty?'草稿已保留 · 尚未提交':n.saved?'已保存':bookMetadata(n)?'书籍资料 · 只读':'正式文件 · '+(n.readOnly?'仅可保留草稿（合同校验未通过）':'已读取');}
let formalRefresh;
function refreshFormal(){return formalRefresh??=(performRefreshFormal().finally(()=>{formalRefresh=null}));}
async function performRefreshFormal(){
 if(!formal||formalBusy||isNoteComposing()||notes.some(n=>n.saving))return;formalBusy=true;
 try{const result=await noteCall('list');if(isNoteComposing()||notes.some(n=>n.saving))return;states.set(active,editor.state);noteScope=result.scope;const drafts=storage.get(draftKey(),{});const old=new Map(notes.map(n=>[n.id,n]));
 const fresh=result.notes.map(n=>{const previous=old.get(n.id);const draft=previous?.dirty?previous:drafts[n.id];if(draft&&typeof draft.body==='string'&&draft.dirty){return {...n,body:draft.body,base_hash:draft.base_hash,base_body:draft.base_body,dirty:true,conflict:n.base_hash!==draft.base_hash,disk:n};}if(previous?.base_hash!==n.base_hash)states.delete(n.id);return {...n,base_body:n.body,saved:previous?.base_hash===n.base_hash&&previous?.saved};});
 for(const n of notes)if(n.id&&n.dirty&&!fresh.some(x=>x.id===n.id))fresh.push({...n,conflict:true,deleted:true});
 notes=fresh.length?fresh:[{...emptyNote}];formalReady=true;tabs=tabs.filter(id=>notes.some(n=>n.id===id));selectNote(notes.some(n=>n.id===active)?active:notes[0].id,false,false);showSaveState();
 }catch(error){$('#save-state').textContent='正式文件读取失败：'+error.message;}finally{formalBusy=false;}
}
async function saveFormal(){
 const n=current();if(!formalReady||!n.id||n.readOnly||bookMetadata(n)){toast('当前文件不能正式保存，草稿仍可保留');return;}if(isNoteComposing()){toast('请完成输入法组合后保存');return;}if(n.saving)return;
 n.saving=true;persist();$('#save-state').textContent='正在保存…';const body=n.body;
 try{const result=await noteCall('save',{id:n.id,base_hash:n.base_hash,body,request_id:crypto.randomUUID()});n.base_hash=result.base_hash;n.base_body=result.body;n.data=result.data;n.dirty=n.body!==body;n.saved=true;n.conflict=false;n.externalChanged=false;persist();if(current()===n)showSaveState();}
 catch(error){n.dirty=true;persist();$('#save-state').textContent='保存失败 · 草稿已保留';if(error.code==='NOTE_CONFLICT'||/HASH|CONFLICT/.test(error.code??'')){n.conflict=true;await showConflict(n);}else toast(error.message);}
 finally{n.saving=false;}
}
async function showConflict(n){
 let disk;try{disk=await noteCall('read',{id:n.id});}catch(error){toast('无法读取磁盘版本：'+error.message+'；草稿已保留');return;}
 const box=dialog('文件已变化 · 合并后再保存');box.append(el('p','','原始版本、磁盘版本和你的草稿均保留。复制需要的内容到草稿，确认后再提交。'));
 for(const [label,text]of [['原始版本',n.base_body??''],['磁盘版本',disk.body],['本地草稿',n.body]]){const title=el('h3','',label),area=el('textarea');area.value=text;area.readOnly=true;area.setAttribute('aria-label',label);area.className='conflict-version';box.append(title,area);}
 box.append(button('保留草稿并以磁盘版本为基准',null,()=>{n.base_hash=disk.base_hash;n.base_body=disk.body;n.conflict=false;persist();void closeDialog();toast('已更新基准，请检查草稿后再次保存');},'dialog-action'));
}

function noteFolders(){return folderPaths(makeNoteTree(notes))}
let active=notes.some(n=>n.id===storage.get('markdown-r1:active','reading'))?storage.get('markdown-r1:active','reading'):notes[0].id;
let tabs=storage.get('markdown-r1:tabs',['welcome','reading']).filter(id=>notes.some(n=>n.id===id));if(!tabs.includes(active))tabs.push(active);
let mode=formal?'read':'live',filter='files',query='',collapsed=new Set(),loading=false,back=[],forward=[];
const md=new MarkdownIt({html:false,linkify:false});
installWikiLinks(md);
const states=new Map();
const editor=new EditorView({parent:$('#editor'),state:makeState('')});
let noteComposing=false;const isNoteComposing=()=>noteComposing||editor.composing;
editor.dom.addEventListener('compositionstart',()=>{noteComposing=true});editor.dom.addEventListener('compositionend',()=>{noteComposing=false});
function makeState(doc){return EditorState.create({doc,extensions:[EditorState.readOnly.of(formal&&(!current()?.id||!!bookMetadata(current()))),markdown(),history(),drawSelection(),highlightSelectionMatches(),keymap.of([...defaultKeymap,...historyKeymap,...searchKeymap,indentWithTab]),EditorView.lineWrapping,EditorView.contentAttributes.of({'aria-label':'Markdown 编辑器'}),live,EditorView.updateListener.of(u=>{if(u.docChanged&&!loading){current().body=u.state.doc.toString();if(formal)current().dirty=true;persist();updateContent(false)}})]})}
function noteLabel(note){const label=note.displayTitle||note.name;if(note.data?.object_type!=='recommendation_run')return label;const book=notes.find(n=>n.data?.object_type==='book'&&n.data.book_version_id===note.data.book_version_id);return book?.data?.title?book.data.title.replace(/[（(].*$/u,'').trim()+' · '+label:label}
function showDocumentTitle(){const n=current(),first=$('#note-preview').firstElementChild;$('#note-title').hidden=mode==='read'&&n.data?.object_type==='recommendation_run'&&first?.tagName==='H1'&&first.textContent==='导读与推荐记录';}
function current(){return notes.find(n=>n.id===active)}
function resolveWikiTarget(name,from=current()){
 const target=name.replace(/\.md$/i,'');const exact=notes.filter(n=>n.id.replace(/\.md$/i,'')===target||(n.folder?n.folder+'/':'')+n.name===target);if(exact.length===1)return exact[0];
 const local=notes.filter(n=>n.folder===from?.folder&&n.name===target);if(local.length===1)return local[0];const candidates=notes.filter(n=>n.name===target);return candidates.length===1?candidates[0]:null;
}
function persist(){if(formal){if(!noteScope)return true;const ok=storage.set(draftKey(),Object.fromEntries(notes.filter(n=>n.id&&n.dirty).map(n=>[n.id,{body:n.body,base_body:n.base_body,base_hash:n.base_hash,dirty:true}])));showSaveState();if(!ok)$('#save-state').textContent='草稿保留失败，请导出';return ok;}const results=[storage.set('markdown-r1:notes',notes),storage.set('markdown-r1:active',active),storage.set('markdown-r1:tabs',tabs)];const ok=results.every(Boolean);$('#save-state').textContent=ok?'草稿已保留':'草稿保留失败，请导出';return ok}
function selectNote(id,record=true,resetScroll=true){if(isNoteComposing()){toast('请先完成正在输入的文字');return;}if(!notes.some(n=>n.id===id))return;if(active!==id){states.set(active,editor.state);if(record){back.push(active);forward=[]}}active=id;if(!tabs.includes(id))tabs.push(id);loading=true;editor.setState(states.get(id)??makeState(current().body));loading=false;renderTree();renderTabs();updateContent(resetScroll);persist();window.dispatchEvent(new CustomEvent('ai-reading:note-context',{detail:{id:active}}))}
function renderTree(){
 const root=$('#file-tree');root.replaceChildren();$('#files-tools').hidden=filter!=='files';$('#search-tools').hidden=filter!=='search';
 for(const [id,value]of [['files-tab','files'],['search-tab','search']])$('#'+id).classList.toggle('active',filter===value);
 const result=notes.filter(n=>!query||(noteLabel(n)+' '+n.name+' '+n.body).toLowerCase().includes(query.toLowerCase()));
 const row=(n,nested=false)=>{const b=button(noteLabel(n),null,()=>selectNote(n.id),'file-row'+(nested?' nested':'')+(n.id===active?' active':''));b.textContent='';b.title=noteLabel(n);const label=el('span','file-label',noteLabel(n));Object.assign(label.style,{overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',minWidth:'0'});b.append(label);return b};
 if(filter==='search'){for(const n of result)root.append(row(n));if(!result.length)root.append(el('p','','没有找到匹配笔记'));return}
 const appendTree=(node,parent,depth=0)=>{
  for(const folder of node.folders){
   const expanded=!collapsed.has(folder.path);
   const group=el('div','folder-content');group.hidden=!expanded;
   const b=button(folder.name,'ChevronRight',()=>{const open=collapsed.has(folder.path);if(open)collapsed.delete(folder.path);else collapsed.add(folder.path);b.setAttribute('aria-expanded',String(open));b.children[1].replaceWith(icon(open?'FolderOpen':'FolderClosed'));void motion.visibility(group,open,{trigger:b});},'folder-row');
   b.setAttribute('aria-expanded',String(expanded));b.dataset.folder=folder.path;
   const label=el('span','',folder.name);Object.assign(label.style,{overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',minWidth:'0'});b.title=folder.path;b.append(icon(expanded?'FolderOpen':'FolderClosed'),label);parent.append(b);
   appendTree(folder,group,depth+1);parent.append(group)
  }
  for(const n of node.notes)parent.append(row(n,depth>0));
 };
 appendTree(makeNoteTree(result),root);
}
function renderTabs(){const root=$('#note-tabs');root.replaceChildren();for(const id of tabs){const note=notes.find(n=>n.id===id);if(!note)continue;const tab=el('div','note-tab'+(id===active?' active':''));tab.role='tab';tab.setAttribute('aria-selected',String(id===active));const open=button(noteLabel(note),null,()=>selectNote(id),'');const close=button('关闭 '+noteLabel(note),'X',()=>{if(isNoteComposing()){toast('请先完成正在输入的文字');return;}if(tabs.length===1){toast('至少保留一个笔记标签');return}tabs=tabs.filter(x=>x!==id);if(id===active)selectNote(tabs.at(-1));else{renderTabs();persist()}});open.title=noteLabel(note);Object.assign(open.style,{overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'});tab.append(open,close);root.append(tab)}}
function updateContent(resetScroll){
 const n=current(),navigation=parseNavigation(md,n.body);
 $('#note-title').textContent=noteLabel(n);$('#note-title').title=noteLabel(n);$('#breadcrumb').textContent=(n.folder?n.folder+' / ':'')+noteLabel(n);$('#breadcrumb').title=noteLabel(n);document.title=noteLabel(n)+' · 阅读知识库';
 $('#note-preview').innerHTML=md.renderer.render(navigation.tokens,md.options,navigation.env);
 const metadata=bookMetadata(n);if(metadata){renderBookMetadata($('#note-preview'),n);mode='read';}$('#note-mode').hidden=!!metadata;setMode(mode);
 const count=n.body.replace(/\s/g,'').length;$('#word-count').textContent=metadata?'书籍资料':(n.body.trim()?n.body.trim().split(/\s+/).length:0)+' 个词  '+count+' 个字符';
 $('#note-back').disabled=!back.length;$('#note-forward').disabled=!forward.length;
 const refs=notes.filter(x=>x.id!==n.id&&[...parseNavigation(md,x.body).wikiTargets].some(target=>resolveWikiTarget(target,x)?.id===n.id));
 $('#backlink-count').textContent=refs.length+' 条反向链接';$('#backlinks').replaceChildren(...refs.map(x=>button(noteLabel(x),null,()=>selectNote(x.id),'')));
 const renderedHeadings=[...$('#note-preview').querySelectorAll('h1,h2,h3,h4,h5,h6')],outline=$('#outline-list');outline.replaceChildren();
 if(formal)foldNoteDiagnostics($('#note-preview'),n);showDocumentTitle();
 for(const entry of navigation.headings){
  const heading=renderedHeadings[entry.index];
  const b=button(heading.textContent,null,()=>{
   if(mode==='read'){const details=heading.closest('details');if(details)details.open=true;heading.scrollIntoView({block:'start'});}
   else{const pos=editor.state.doc.line(entry.line).from;editor.dispatch({selection:{anchor:pos},effects:EditorView.scrollIntoView(pos,{y:'start'})});editor.focus()}
  },'');
  b.style.paddingLeft=((entry.level-1)*10+6)+'px';outline.append(b);
 }
 if(resetScroll)$('#note-scroll').scrollTop=0;
}
function setMode(next){mode=bookMetadata(current())?'read':next;$('#editor').hidden=mode==='read';$('#note-preview').hidden=mode!=='read';$('#mode-status').textContent=mode==='read'?'阅读视图':'实时阅览';const label=mode==='read'?'切换至编辑视图':'切换至阅读视图';$('#note-mode').setAttribute('aria-label',label);$('#note-mode').title=label;$('#note-mode').replaceChildren(icon(mode==='read'?'Pencil':'BookOpen'));if(mode==='live')editor.requestMeasure();showDocumentTitle()}
let dialogTrigger,dialogVersion=0,dialogComposing=false;
$('#dialog').addEventListener('compositionstart',()=>dialogComposing=true);$('#dialog').addEventListener('compositionend',()=>dialogComposing=false);
async function closeDialog(){const version=++dialogVersion,d=$('#dialog');d.inert=true;await motion.animate(d,[{opacity:1,transform:'none'},{opacity:0,transform:'translateY(4px)'}]);if(version!==dialogVersion)return;d.close();d.inert=false;if(dialogTrigger?.isConnected)dialogTrigger.focus();}
$('#dialog').addEventListener('cancel',e=>{e.preventDefault();if(!dialogComposing&&!e.isComposing)void closeDialog()});
function dialog(title){dialogVersion++;motion.cancel($('#dialog'));dialogTrigger=document.activeElement;$('#dialog').inert=false;$('#dialog-title').textContent=title;$('#dialog-content').replaceChildren();$('#dialog').showModal();void motion.enter($('#dialog'));return $('#dialog-content')}
function askName(title,onSubmit){const box=dialog(title),input=el('input');input.setAttribute('aria-label',title);input.placeholder='名称';const submit=button('创建',null,()=>{const value=input.value.trim();if(!value||/[\\/]/.test(value)){input.setCustomValidity('请输入不包含路径分隔符的名称');input.reportValidity();return}onSubmit(value);void closeDialog()},'dialog-action');input.oninput=()=>input.setCustomValidity('');input.onkeydown=e=>{if(e.key==='Enter'&&!e.isComposing)submit.click()};box.append(input,submit);input.focus()}
function createNote(name,folder=''){const existing=notes.find(n=>n.name===name&&n.folder===folder);if(existing){selectNote(existing.id);return}const note={id:crypto.randomUUID(),name,folder,body:''};notes.push(note);selectNote(note.id);editor.focus()}
function quickOpen(){const box=dialog('打开笔记'),input=el('input');input.placeholder='输入笔记名称…';input.setAttribute('aria-label','查找笔记');const results=el('div');const render=()=>{results.replaceChildren(...notes.filter(n=>(noteLabel(n)+' '+n.name).includes(input.value)).map(n=>button(formal?(n.folder?n.folder+'/':'')+noteLabel(n):noteLabel(n),null,()=>{selectNote(n.id);void closeDialog()},'result-row')))};input.oninput=render;box.append(input,results);render();input.focus()}
$('#new-note').onclick=()=>askName('新建笔记',name=>createNote(name));$('#new-tab').onclick=quickOpen;$('#quick-open').onclick=quickOpen;$('#sort-notes').onclick=()=>{notes.sort((a,b)=>noteLabel(a).localeCompare(noteLabel(b),'zh'));renderTree();persist()};$('#collapse-all').onclick=()=>{const expand=collapsed.size===noteFolders().length;for(const b of document.querySelectorAll('.folder-row'))if((b.getAttribute('aria-expanded')==='true')!==expand)b.click();$('#collapse-all').title=expand?'全部折叠':'全部展开';$('#collapse-all').setAttribute('aria-label',$('#collapse-all').title)};
for(const [id,type]of [['files-tab','files'],['search-tab','search']])$('#'+id).onclick=()=>{filter=type;query='';$('#note-search').value='';renderTree();if(type==='search')$('#note-search').focus()};$('#note-search').oninput=e=>{query=e.target.value;renderTree()};
$('#hide-sidebar').onclick=()=>{$('.obs-app').classList.add('sidebar-hidden');$('#show-sidebar').hidden=false;void motion.enter($('.note-workspace'),'page');$('#show-sidebar').focus()};$('#show-sidebar').onclick=()=>{$('.obs-app').classList.remove('sidebar-hidden');$('#show-sidebar').hidden=true;void motion.enter($('#file-sidebar'),'page');$('#hide-sidebar').focus()};$('#outline-toggle').onclick=()=>{const open=!motion.shown($('#outline'));$('#outline-toggle').setAttribute('aria-expanded',String(open));$('#outline-toggle').title=open?'收起右侧栏':'展开右侧栏';$('#outline-toggle').setAttribute('aria-label',$('#outline-toggle').title);$('#outline-toggle').replaceChildren(icon(open?'PanelRightClose':'PanelRightOpen'));void motion.visibility($('#outline'),open,{trigger:$('#outline-toggle')});};
$('#note-mode').onclick=()=>setMode(mode==='read'?'live':'read');$('#note-back').onclick=()=>{if(back.length){const id=back.pop();forward.push(active);selectNote(id,false)}};$('#note-forward').onclick=()=>{if(forward.length){const id=forward.pop();back.push(active);selectNote(id,false)}};
function sourceMenuItems(){if(!formal||!formalReady||!window.readingNotes?.viewSource)return [];const note=current(),refs=noteSources(note);return refs.map((ref,index)=>{const item=button(refs.length===1?'查看原文':'查看原文 · 引用 '+(index+1),'BookOpen',async()=>{await motion.visibility($('#note-menu'),false,{trigger:$('#note-options')});try{if(current().id!==note.id)throw Error('笔记已切换，请重新选择来源');await openNoteSource({note,spanId:ref.span_id,composing:isNoteComposing(),persist,request:payload=>window.readingNotes.viewSource(payload)});}catch(error){toast(error.message)}},'');item.append(document.createTextNode(refs.length===1?'查看原文':'查看原文 · 引用 '+(index+1)));item.dataset.sourceSpan=ref.span_id;item.title='查看此笔记关联的真实原文 · '+ref.href;return item;});}
$('#note-options').onclick=()=>{const menu=$('#note-menu');menu.replaceChildren(...sourceMenuItems(),...(formal?[button('保存正文','Check',()=>{void motion.visibility(menu,false,{trigger:$('#note-options')});void saveFormal()},''),button('刷新文件','RefreshCw',()=>{void motion.visibility(menu,false,{trigger:$('#note-options')});void refreshFormal()},'')]:[]),button('导出当前 Markdown','Download',()=>{download(current().name+'.md',current().body);void motion.visibility(menu,false,{trigger:$('#note-options')})},''),...(window.readingAppearance?[button('返回阅读','BookOpen',()=>{$('#workspace-return').click();void motion.visibility(menu,false,{trigger:$('#note-options')})},''),button('大纲与反向链接','ListTree',()=>{$('#outline-toggle').click();void motion.visibility(menu,false,{trigger:$('#note-options')})},'')]:[]),...(!window.readingAppearance?[button('后退','ArrowLeft',()=>{$('#note-back').click();void motion.visibility(menu,false,{trigger:$('#note-options')})},''),button('前进','ArrowRight',()=>{$('#note-forward').click();void motion.visibility(menu,false,{trigger:$('#note-options')})},'')]:[]),button(mode==='read'?'切换至编辑视图':'切换至阅读视图',mode==='read'?'Pencil':'BookOpen',()=>{setMode(mode==='read'?'live':'read');void motion.visibility(menu,false,{trigger:$('#note-options')})},''));for(const item of menu.children)if(!item.textContent.trim())item.append(document.createTextNode(item.getAttribute('aria-label')??''));void motion.visibility(menu,!motion.shown(menu),{trigger:$('#note-options')})};
$('#import-markdown').onclick=()=>$('#markdown-file').click();$('#markdown-file').onchange=async e=>{const file=e.target.files[0];if(file){if(file.size>5*1024*1024){toast('原型支持不超过 5 MB 的 Markdown');return}const note={id:crypto.randomUUID(),name:file.name.replace(/\.(md|markdown|txt)$/i,''),folder:'',body:await file.text()};notes.push(note);selectNote(note.id);toast('已载入独立草稿，原文件未改写')}e.target.value=''};
if(window.readingAppearance)$('#settings').hidden=true;
$('#settings').onclick=()=>{if(window.readingAppearance){window.readingAppearance.open();return;}const box=dialog('外观');box.append(el('p','','选择适合阅读的浅色或深色主题。'));const select=el('select');select.setAttribute('aria-label','基础颜色');for(const [v,t]of [['light','浅色'],['dark','深色']]){const op=el('option','',t);op.value=v;select.append(op)}select.value=document.body.dataset.theme??'light';select.onchange=()=>{document.body.dataset.theme=select.value;storage.set('markdown-r1:theme',select.value)};box.append(select)};
$('#help').onclick=()=>{const box=dialog('独立 Markdown 原型');box.append(el('p','','用于回看和编辑阅读沉淀。支持文件浏览、标签切换、搜索、实时预览、阅读视图、大纲、相关笔记与导出。'),el('p','','当前内容是独立浏览器草稿，尚未连接真实的 45-书籍 目录。AI 导读、原文引用和 DSH 会话衔接由插件接入阶段完成。'))};$('#close-dialog').onclick=()=>void closeDialog();
$('#note-preview').onclick=e=>{const a=e.target.closest('a');if(!a)return;if(a.getAttribute('href')?.startsWith('#note=')){e.preventDefault();const name=decodeURIComponent(a.getAttribute('href').slice(6));const target=resolveWikiTarget(name);if(target)selectNote(target.id);else toast('笔记不存在或名称不唯一，请使用文件夹路径：'+name)}else{e.preventDefault();toast('原型不打开外部链接')}};
window.addEventListener('keydown',e=>{if(e.isComposing||e.keyCode===229||isNoteComposing())return;if((e.metaKey||e.ctrlKey)&&e.key==='o'){e.preventDefault();quickOpen()}if((e.metaKey||e.ctrlKey)&&e.key==='e'){e.preventDefault();setMode(mode==='read'?'live':'read')}if((e.metaKey||e.ctrlKey)&&e.key==='s'){e.preventDefault();formal?void saveFormal():toast(persist()?'草稿已保留':'草稿保留失败，请导出')}if(e.key==='Escape')void motion.visibility($('#note-menu'),false,{trigger:$('#note-options')})});document.addEventListener('click',e=>{if(!e.target.closest('#note-menu,#note-options'))void motion.visibility($('#note-menu'),false,{trigger:$('#note-options')})});
document.body.dataset.theme=storage.get('markdown-r1:theme','light');icons();selectNote(active,false);setMode(mode);

if(innerWidth<700){$('.obs-app').classList.add('sidebar-hidden');$('#show-sidebar').hidden=false}

installLifecycle({
 view:'markdown',
 activate:async()=>{editor.requestMeasure();if(formal)await refreshFormal()},
 flush:()=>{
  if(isNoteComposing())throw new Error('输入法正在组合文字，请完成输入后再退出');
  return persist();
 }
});

// Deliberately supports existing draft IDs only; no file paths or automatic source attachment.
const openExistingNote=id=>{
 if(typeof id!=='string'||!notes.some(note=>note.id===id))return {ok:false,reason:'note-not-found'};
 if(isNoteComposing())return {ok:false,reason:'composition-active'};
 selectNote(id);return {ok:true,id};
};
Object.defineProperty(window,'aiReadingNotes',{value:Object.freeze({
 getSnapshot:()=>formal?{...noteSnapshot(notes.filter(n=>n.id),active),kind:'formal-notes',scope:noteScope}:noteSnapshot(notes,active),
 search:query=>({activeId:active,notes:notes.filter(n=>n.id&&(!query||(noteLabel(n)+' '+n.name+' '+n.body).toLowerCase().includes(query.toLowerCase()))).map(({id,name,folder,displayTitle,displayCategory,systemRecord,body})=>({id,name,folder,displayTitle,displayCategory,systemRecord,preview:(body||'').replace(/^---[\s\S]*?---\s*/, '').replace(/[#*`]/g,'').replace(/\s+/g,' ').trim().slice(0,160)}))}),
 refresh:refreshFormal,
 open:openExistingNote
}),writable:false,configurable:false});
window.addEventListener('ai-reading:open-note',event=>{
 const result=openExistingNote(event.detail?.id);
 window.dispatchEvent(new CustomEvent('ai-reading:note-opened',{detail:result}));
});
// Main process adds this query only to isolated AI_READING_TEST windows.
if(location.protocol==='reading-app:'&&new URL(location.href).searchParams.get('testFixtures')==='1'){
 window.addEventListener('ai-reading:seed-notes',event=>{
  if(!Array.isArray(event.detail?.notes))return;
  for(const note of event.detail.notes){
   if(!note||typeof note.id!=='string'||!note.id.startsWith('fixture-')||
      typeof note.name!=='string'||typeof note.folder!=='string'||typeof note.body!=='string'||notes.some(n=>n.id===note.id))continue;
   notes.push({id:note.id,name:note.name,folder:note.folder,body:note.body});
  }
  persist();renderTree();
 });
}

if(formal){
 for(const id of ['new-note','import-markdown'])$('#'+id).hidden=true;
 $('.vault-bar span').title='正式书籍知识库 · 编辑既有正文';
 $('#help').title='笔记编辑说明';$('#help').setAttribute('aria-label','笔记编辑说明');
 $('#help').onclick=()=>{const box=dialog('正式笔记编辑');box.append(el('p','','只编辑已有正式笔记的正文。元数据与受管区受到保护。输入时保留本地草稿；按 ⌘S 或“保存正文”提交文件。外部修改会提示合并，保存不代表确认。'));};
 void refreshFormal();
}

// Poll only the active hash, never replace an editor or draft as a side effect of external changes.
if(formal){let checking=false;const timer=setInterval(async()=>{const n=current();if(checking||!formalReady||!n.id||n.saving||isNoteComposing())return;checking=true;try{const disk=await noteCall('read',{id:n.id});if(disk.base_hash!==n.base_hash){if(n.dirty)n.conflict=true;else n.externalChanged=true;if(current()===n)showSaveState();}}catch(error){if(error.code==='NOTE_NOT_FOUND'){n.deleted=true;n.conflict=true;if(current()===n)$('#save-state').textContent='磁盘文件已删除 · 草稿保留';}}finally{checking=false;}},5000);window.addEventListener('pagehide',()=>clearInterval(timer),{once:true});}

window.addEventListener('ai-reading:container',()=>{document.body.classList.add('inline-note','workspace-note')});
if(window.readingAppearance){
 document.body.classList.add('inline-note','workspace-note');
 const bar=$('.tab-bar'),backButton=button('返回阅读','ArrowLeft',()=>window.dispatchEvent(new CustomEvent('ai-reading:workspace-navigation',{detail:'reading'})),'icon-button');
 backButton.id='workspace-return';bar.prepend(backButton);
 for(const id of ['note-back','note-forward','note-mode','note-options'])bar.append($('#'+id));
 $('#new-tab').title='快速切换笔记（⌘O）';$('#new-tab').setAttribute('aria-label','快速切换笔记');
 $('#outline-toggle').title='大纲与反向链接';$('#outline-toggle').setAttribute('aria-label','大纲与反向链接');
}
