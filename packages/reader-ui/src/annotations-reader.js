import {canonicalHref,verifyMapping,mappedDisplay} from './source-mapping.js';

export const annotationHighlightCSS=`
::highlight(reading-annotation-yellow){background:#f3df91;color:#28221b}
::highlight(reading-annotation-purple){background:#ddd0fa;color:#29223b}
::highlight(reading-annotation-green){background:#cbe6cf;color:#1e3123}
html[data-annotation-theme="dark"] ::highlight(reading-annotation-yellow){background:#685726;color:#fff4c7}
html[data-annotation-theme="dark"] ::highlight(reading-annotation-purple){background:#56436f;color:#f4eaff}
html[data-annotation-theme="dark"] ::highlight(reading-annotation-green){background:#355e43;color:#e8ffec}`;

/** Uses the existing reader; selected text remains a source candidate until main verifies it. */
export function installAnnotationsReader({getState,bridge,discuss,toast}){
 if(!bridge?.annotations)return {load(){},refresh:async()=>{},flush:()=>true};
 const draftsKey='books-r1:annotation-drafts-v1';let drafts={};try{drafts=JSON.parse(localStorage.getItem(draftsKey)||'{}');}catch{}
 let current=null,range=null,epoch=0,busy=false,composing=false,refreshEpoch=0;
 const wired=new WeakSet();
 const toolbar=document.querySelector('.reader-right');
 const trigger=document.createElement('button');trigger.id='annotation-create';trigger.className='text-button';trigger.textContent='标注选文';trigger.hidden=true;trigger.title='高亮或备注选中的原文';trigger.setAttribute('aria-haspopup','dialog');trigger.setAttribute('aria-expanded','false');toolbar.prepend(trigger);
 const bubble=document.createElement('button');bubble.id='annotation-selection-action';bubble.className='annotation-selection-action';bubble.textContent='高亮／备注';bubble.hidden=true;bubble.setAttribute('aria-haspopup','dialog');document.querySelector('#reading-view').append(bubble);
 const panel=document.createElement('section');panel.id='annotation-editor';panel.className='annotation-editor';panel.hidden=true;panel.setAttribute('role','dialog');panel.setAttribute('aria-label','本地阅读标注');
 panel.innerHTML='<header><strong>本地阅读标注</strong><button type="button" id="annotation-close" aria-label="关闭标注面板" title="关闭，保留草稿">关闭</button></header><blockquote id="annotation-quote"></blockquote><label>高亮颜色<select id="annotation-style"><option value="yellow">黄色</option><option value="purple">紫色</option><option value="green">绿色</option></select></label><label>备注（可选）<textarea id="annotation-note" rows="3" maxlength="30000" placeholder="写下你的阅读备注"></textarea></label><p id="annotation-status" role="status" aria-live="polite"></p><footer><button type="button" id="annotation-save">保存标注</button><button type="button" id="annotation-discuss">向 AI 提问</button></footer>';
 document.querySelector('#reading-view').append(panel);
 const find=id=>panel.querySelector('#'+id),note=find('annotation-note'),style=find('annotation-style'),status=find('annotation-status'),save=find('annotation-save');
 const bookKey=()=>getState().book?.id;
 async function call(action,payload){const result=await bridge.annotations(action,payload);if(result?.ok===false)throw Error(result.message??result.error??'标注操作未完成');return result;}
 function flush(){if(current){current.note=note.value;current.style=style.value;drafts[current.bookId]=current;}try{localStorage.setItem(draftsKey,JSON.stringify(drafts));return !composing;}catch{return false;}}
 function selection(){const items=(getState().view?.renderer?.getContents?.()??[]).filter(x=>x.doc?.getSelection()?.rangeCount&&!x.doc.getSelection().isCollapsed);if(items.length!==1)return null;const item=items[0],r=item.doc.getSelection().getRangeAt(0);return r.toString().trim()?{...item,range:r.cloneRange()}:null;}
 function close(){epoch++;flush();panel.hidden=true;panel.inert=true;trigger.setAttribute('aria-expanded','false');current=null;range=null;trigger.focus();update();}
 function update(){if(!panel.hidden)return;const selected=selection();trigger.hidden=!selected&&!drafts[bookKey()];trigger.textContent=selected?'标注选文':'继续标注草稿';bubble.hidden=!selected;if(selected){const rect=selected.range.getBoundingClientRect(),frame=selected.doc.defaultView.frameElement?.getBoundingClientRect();const x=(frame?.left??0)+rect.left,y=(frame?.top??0)+rect.bottom;bubble.style.left=Math.max(8,Math.min(innerWidth-130,x))+'px';bubble.style.top=Math.max(52,Math.min(innerHeight-70,y+6))+'px';}}
 async function open(){
  if(busy)return;const state=getState(),selected=selection(),book=state.book;if(!book)return;
  const token=++epoch;
  if(selected){
   range=selected.range;const href=state.view.book.sections[selected.index]?.id;
   try{const mapping=await call('chapter',{bookId:book.id,bookVersionId:book.bookVersionId,href});if(token!==epoch||getState().book!==book)return;
    const s=selected.doc.getSelection(),live=s?.rangeCount?s.getRangeAt(0):null;if(!live||live.startContainer!==range.startContainer||live.startOffset!==range.startOffset||live.endContainer!==range.endContainer||live.endOffset!==range.endOffset)throw Error('选文已改变，请重新打开标注');
    const candidate=await window.aiReadingSource.selection(mapping);
    if(token!==epoch||getState().book!==book)return;
    const existing=drafts[book.id];if(existing&&existing.quote!==candidate.quote&&existing.note&&!confirm('已有尚未保存的标注备注。替换这份草稿？'))return;
    current=existing?.quote===candidate.quote?structuredClone(existing):{...candidate,bookId:book.id,bookVersionId:book.bookVersionId,request_id:'annotation_'+crypto.randomUUID(),style:'yellow',note:'',cfi:state.view.getCFI(selected.index,range)};
   }catch(error){toast('无法标注：'+error.message);return;}
  }else current=drafts[book.id]?structuredClone(drafts[book.id]):null;
  if(!current)return;
  note.value=current.note;style.value=current.style;find('annotation-quote').textContent=current.quote;status.textContent='保存在客户端，不会自动成为学习证据。';save.disabled=false;
  bubble.hidden=true;panel.hidden=false;panel.inert=false;trigger.setAttribute('aria-expanded','true');
  panel.style.left=Math.max(12,Math.min(innerWidth-356,parseFloat(bubble.style.left)||24))+'px';panel.style.top=Math.max(58,Math.min(innerHeight-380,parseFloat(bubble.style.top)||70))+'px';
  flush();note.focus();
 }
 async function submit(){if(busy||composing||!current)return;flush();const candidate=structuredClone(current),token=epoch;busy=true;save.disabled=true;note.disabled=true;style.disabled=true;status.textContent='正在保存标注…';
  try{await call('create',candidate);if(drafts[candidate.bookId]?.request_id===candidate.request_id)delete drafts[candidate.bookId];if(token===epoch){current=null;for(const {doc} of getState().view?.renderer?.getContents?.()??[])doc.getSelection()?.removeAllRanges();window.aiReadingSource?.clear?.();note.value='';status.textContent='标注已保存';panel.hidden=true;panel.inert=true;trigger.setAttribute('aria-expanded','false');range?.startContainer?.ownerDocument?.getSelection()?.removeAllRanges();range=null;}try{localStorage.setItem(draftsKey,JSON.stringify(drafts));}catch{/* Durable annotation already committed; never report a false save failure. */}await refresh();toast('标注已保存');}
  catch(error){if(token===epoch)status.textContent='未保存：'+error.message+'。草稿仍在本窗口，可重试。';}
  finally{busy=false;save.disabled=false;note.disabled=false;style.disabled=false;update();}}
 for(const element of [trigger,bubble]){element.addEventListener('pointerdown',e=>e.preventDefault());element.addEventListener('click',()=>void open());}
 find('annotation-close').onclick=close;save.onclick=()=>void submit();
 find('annotation-discuss').onclick=()=>{if(range){const s=range.startContainer.ownerDocument.getSelection();s.removeAllRanges();s.addRange(range);close();void discuss();}else status.textContent='请重新选择原文后附加讨论，尚未发送内容。';};
 note.addEventListener('compositionstart',()=>{composing=true;save.disabled=true;});note.addEventListener('compositionend',()=>{composing=false;save.disabled=busy;flush();});
 note.addEventListener('input',()=>{if(current){current.request_id='annotation_'+crypto.randomUUID();flush();}});style.addEventListener('change',()=>{if(current){current.request_id='annotation_'+crypto.randomUUID();flush();}});
 panel.addEventListener('wheel',event=>event.stopPropagation());
 panel.addEventListener('keydown',event=>{if(event.isComposing)return;if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();}if(event.key==='Tab'){const nodes=[...panel.querySelectorAll('button,select,textarea')].filter(x=>!x.disabled);const i=nodes.indexOf(document.activeElement);if(event.shiftKey&&i===0){event.preventDefault();nodes.at(-1).focus();}else if(!event.shiftKey&&i===nodes.length-1){event.preventDefault();nodes[0].focus();}}});
 async function refresh(){const token=++refreshEpoch,state=getState(),view=state.view,book=state.book;if(!view||!book?.bookVersionId)return;
  let records;try{records=await call('list',{bookId:book.id,bookVersionId:book.bookVersionId});}catch{return;}
  if(token!==refreshEpoch||getState().view!==view)return;
  for(const {doc,index} of view.renderer.getContents()??[]){
   const api=doc.defaultView;if(!api?.CSS?.highlights||!api.Highlight)continue;
   doc.documentElement.dataset.annotationTheme=document.body.dataset.readingTheme??'white';
   let css=doc.getElementById('reading-annotation-styles');if(!css){css=doc.createElement('style');css.id='reading-annotation-styles';css.textContent=annotationHighlightCSS;doc.head.append(css);}
   const href=view.book.sections[index]?.id,items=records.filter(r=>r.bookVersionId===book.bookVersionId&&canonicalHref(state.meta.root+r.span.href)===canonicalHref(href));if(!items.length){for(const color of ['yellow','purple','green'])api.CSS.highlights.delete('reading-annotation-'+color);continue;}
   let chapter;try{chapter=await call('chapter',{bookId:book.id,bookVersionId:book.bookVersionId,href});}catch{continue;}
   if(token!==refreshEpoch||getState().view!==view)return;
   const groups={yellow:[],purple:[],green:[]};for(const record of items){try{const mapping={...chapter,span:record.span};const checked=await verifyMapping(mapping,{book_id:book.bookId,book_version_id:book.bookVersionId});const display=mappedDisplay(doc,checked.segment,checked.start,checked.end);if(display.partialDisplay)continue;groups[record.style]?.push(display.range);}catch{/* Keep record; never fuzzy-reattach. */}}
   if(token!==refreshEpoch||getState().view!==view)return;
   for(const [color,ranges] of Object.entries(groups)){api.CSS.highlights.delete('reading-annotation-'+color);if(ranges.length){const highlight=new api.Highlight(...ranges);highlight.priority=-1;api.CSS.highlights.set('reading-annotation-'+color,highlight);}}
  }
 }
 function load({doc}){if(!wired.has(doc)){wired.add(doc);doc.addEventListener('selectionchange',update);doc.addEventListener('pointerup',update);doc.addEventListener('keydown',e=>{if(e.isComposing)return;if((e.metaKey||e.ctrlKey)&&e.shiftKey&&e.key.toLowerCase()==='h'){e.preventDefault();void open();}});}void refresh();}
 window.addEventListener('ai-reading:book-context',()=>{flush();epoch++;refreshEpoch++;current=null;range=null;panel.hidden=true;panel.inert=true;bubble.hidden=true;trigger.hidden=true;trigger.setAttribute('aria-expanded','false');});
 window.addEventListener('ai-reading:book-ready',()=>{for(const item of getState().view?.renderer?.getContents?.()??[])load(item);update();});
 new MutationObserver(()=>{for(const {doc} of getState().view?.renderer?.getContents?.()??[])doc.documentElement.dataset.annotationTheme=document.body.dataset.readingTheme??'white';}).observe(document.body,{attributes:true,attributeFilter:['data-reading-theme']});
 window.addEventListener('resize',()=>{bubble.hidden=true;});bridge.onAnnotationsChanged?.(()=>void refresh());
 return {load,refresh,flush};
}
