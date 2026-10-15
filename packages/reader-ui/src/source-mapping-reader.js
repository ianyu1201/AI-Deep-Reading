import {ensureScrolledAnchorVisible} from './reading-position.js';
import {verifyMapping,mappedDisplay,selectionCoordinates,canonicalHref,textHash} from './source-mapping.js';
export function installSourceMapping({getState,ready}){
 let epoch=0,highlightDoc=null;
 const status=document.createElement('div');status.id='source-location-status';status.hidden=true;status.setAttribute('role','status');status.setAttribute('aria-live','polite');
 status.style.cssText='position:absolute;top:62px;left:28px;right:28px;font-size:13px;line-height:18px;color:var(--ui-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;z-index:1;pointer-events:none';
 document.querySelector('#reading-view').append(status);
 const identity=state=>({book_id:state.book?.bookId??state.book?.book_id,book_version_id:state.book?.bookVersionId??state.book?.book_version_id});
 const clear=()=>{epoch++;status.hidden=true;status.textContent='';highlightDoc?.defaultView?.CSS?.highlights?.delete('reading-source');highlightDoc=null;};
 async function locate(mapping){
  clear();const generation=epoch;
  try{
   await ready();const state=getState(),view=state.view;
   if(!view)throw Error('请先打开对应原文');
   const checked=await verifyMapping(mapping,identity(state));await ready();
   if(generation!==epoch||getState().view!==view)throw Error('书籍已切换，定位已取消');
   const resolved=await view.resolveNavigation(state.meta.root+checked.segment.href);
   if(!Number.isInteger(resolved?.index))throw Error('原文文件不可用');
   let range,doc,display;
   window.dispatchEvent(new CustomEvent('ai-reading:before-jump',{detail:{requestId:generation}}));
   // A single renderer navigation performs layout and anchor resolution together.
   await view.renderer.goTo({index:resolved.index,anchor:document=>{doc=document;display=mappedDisplay(document,checked.segment,checked.start,checked.end);range=display.range;return range;}});
   if(generation!==epoch||getState().view!==view)throw Error('书籍已切换，定位已取消');
   if(!range||!doc)throw Error('原文尚未就绪');
   const api=doc.defaultView;
   if(!api.CSS?.highlights||!api.Highlight)throw Error('当前阅读环境不支持临时高亮');

   const cfi=view.getCFI(resolved.index,range);
   // New chapter fonts/ResizeObserver expansion can reapply Foliate's anchor
   // after goTo resolves. Finish that actual layout before correcting rounding.
   let fontTimer;
   try{await Promise.race([doc.fonts?.ready??Promise.resolve(),new Promise((_,reject)=>fontTimer=setTimeout(()=>reject(Error('字体排版尚未完成，请重试定位')),5000))]);}
   finally{clearTimeout(fontTimer);}
   await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
   if(generation!==epoch||getState().view!==view)throw Error('书籍已切换，定位已取消');
   await ensureScrolledAnchorVisible(view,cfi);
   if(generation!==epoch||getState().view!==view)throw Error('书籍已切换，定位已取消');
   api.CSS.highlights.set('reading-source',new api.Highlight(range));highlightDoc=doc;
   const message=display.partialDisplay?'引用含文档标题，已定位正文部分':null;
   status.hidden=!display.partialDisplay;status.textContent=message??'';status.title=display.partialDisplay?'未在正文显示的文档元信息：'+display.quoteParts.before+display.quoteParts.after:'';
   window.dispatchEvent(new CustomEvent('ai-reading:after-jump',{detail:{ok:true,requestId:generation}}));
   return {ok:true,verified:true,partialDisplay:display.partialDisplay,displayCoverage:display.partialDisplay?'body-only':'full-quote',quoteParts:display.quoteParts,message,span_id:checked.span.span_id,cfi};
  }catch(error){window.dispatchEvent(new CustomEvent('ai-reading:after-jump',{detail:{ok:false,requestId:generation}}));return {ok:false,verified:false,message:error.message};}
 }
 async function locateChapter(mapping){
  clear();const generation=epoch;
  try{
   await ready();const state=getState(),view=state.view;
   if(!view)throw Error('请先打开对应原文');
   const checked=await verifyMapping(mapping,identity(state));
   const resolved=await view.resolveNavigation(state.meta.root+checked.segment.href);
   if(!Number.isInteger(resolved?.index))throw Error('原文章节不可用');
   if(generation!==epoch||getState().view!==view)throw Error('书籍已切换，定位已取消');
   await ready();
   if(generation!==epoch||getState().view!==view)throw Error('书籍已切换，定位已取消');
   window.dispatchEvent(new CustomEvent('ai-reading:before-jump',{detail:{requestId:generation}}));
   await view.renderer.goTo({index:resolved.index,anchor:0});
   const renderer=view.renderer,primary=renderer.getContents?.()[0];
   if(primary?.index!==resolved.index||!primary.doc?.body)throw Error('章节尚未完成定位，请重试');
   if(!view.isFixedLayout && (renderer.scrolled ? (renderer.sectionStart??renderer.start)>1 : renderer.page>1.01))throw Error('章节开头尚未完成定位，请重试');
   if(generation!==epoch||getState().view!==view)throw Error('书籍已切换，定位已取消');
   window.dispatchEvent(new CustomEvent('ai-reading:after-jump',{detail:{ok:true,requestId:generation}}));
   return {ok:true,verified:true,chapterLocated:true,highlighted:false,cfi:view.lastLocation?.cfi};
  }catch(error){window.dispatchEvent(new CustomEvent('ai-reading:after-jump',{detail:{ok:false,requestId:generation}}));return {ok:false,verified:false,chapterLocated:false,message:error.message};}
 }
 async function selection(mapping){
  const state=getState(),view=state.view,id=identity(state);
  if(!view||id.book_id!==mapping.book_id||id.book_version_id!==mapping.book_version_id)throw Error('选文书籍身份不匹配');
  const selected=(view.renderer.getContents()??[]).filter(x=>!x.doc?.getSelection()?.isCollapsed&&x.doc?.getSelection()?.rangeCount);
  if(selected.length!==1)throw Error('请在单个原文文件内选择文字');
  const {doc,index}=selected[0],href=view.book.sections[index]?.id;
  const segments=mapping.segments.filter(s=>canonicalHref(state.meta.root+s.href)===canonicalHref(href));
  if(segments.length!==1)throw Error('选文文件映射不唯一');
  const segment=segments[0],candidate=selectionCoordinates(doc,segment,doc.getSelection().getRangeAt(0));
  return {...candidate,book_id:id.book_id,book_version_id:id.book_version_id,section_order:mapping.section_order??mapping.chapterOrder,text_hash:await textHash(candidate.quote),verified:false,verificationRequired:true};
 }
 Object.defineProperty(window,'aiReadingSource',{value:Object.freeze({locate,locateChapter,selection,clear,ready,current:()=>{const state=getState(),view=state.view;return {...identity(state),href:view?.book?.sections?.[(view.renderer?.getContents?.()??[]).find(x=>x.doc?.getSelection()?.type==='Range')?.index??view.renderer?.getContents?.()?.[0]?.index]?.id??null};}}),configurable:false});
 window.addEventListener('ai-reading:book-context',clear);
 return {clear};
}
