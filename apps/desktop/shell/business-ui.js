import {showNativeDialog} from './native-dialog.js';
import {displayPreview} from './display-preview.js';
import {contentEmpty} from './content-components.js';
import {renderMarkdown} from './safe-markdown.js';
const $=id=>document.getElementById(id);
const el=(tag,text='',cls='')=>{const n=document.createElement(tag);n.textContent=text;n.className=cls;return n;};
export function installBusinessUI({bridge,getSession,getState,showError,attach}){
 let sessionSearchPolicy=null;
 let currentSpan=null,signature='',discussEpoch=0,searchAuthorized=false,authorizationEpoch=0,permissionContext='',authorizationPending=false;
 const markdown=(text,cls='')=>{const node=el('div','',cls);renderMarkdown(node,text);return node;};
 const safe=fn=>async()=>{try{await fn();}catch(error){showError(error.message);}};
 function button(label,fn){const b=el('button',label,'outlined');b.type='button';const icon=({'阅读本章':'book-open','读原文':'book-open','讨论本章':'message-circle','讨论这段':'message-circle','记录观察':'file-text'})[label];if(icon){const node=el('span','','ui-icon');node.style.setProperty('--icon','url(./icons/'+icon+'.svg)');node.setAttribute('aria-hidden','true');b.prepend(node);}b.onclick=async()=>{if(b.disabled)return;b.disabled=true;b.setAttribute('aria-busy','true');try{await safe(fn)();}finally{b.disabled=false;b.removeAttribute('aria-busy');}};return b;}
 function request(action,extra={}){return bridge.business(action,{bookId:getState().book.id,...extra});}
 async function discuss(spanId,expectedContext,targetKind){const ticket=++discussEpoch;const sessionId=getSession();if(expectedContext&&(expectedContext.sessionId!==sessionId||expectedContext.bookId!==getState().book?.id))throw Error('书籍或会话已变化，请重新选择来源');if(!sessionId)throw Error('请等待当前书籍会话就绪');const before=getState().book.id;
  const data=await request(targetKind==='chapter'?'prepare-target':'prepare',{spanId,sessionId});if(ticket!==discussEpoch||getState().book.id!==before||getSession()!==sessionId)return;
  currentSpan=data.span;attach(data.span);showAttached();await bridge.selectRightTool('chat');
 }
 function renderSearchPermission(){ $('book-search-permission')?.remove();const box=$('session-search-override');if(box)box.hidden=!(sessionSearchPolicy?.source==='session-user'&&sessionSearchPolicy.enabled===false); }
 function showAttached(){renderSearchPermission();let panel=$('attached-source');if(!panel){panel=el('div','','attached-source');panel.id='attached-source';$('chat-notice').after(panel);}
  panel.replaceChildren();panel.hidden=!currentSpan;if(!currentSpan)return;
  const details=el('details');details.append(el('summary','已附加原文 · '+(currentSpan.section_title||'查看节选')),el('blockquote',currentSpan.quote));
  panel.append(details,button('记录观察',()=>observation(currentSpan)),button('移除材料',async()=>{await request('detach',{sessionId:getSession()});currentSpan=null;attach(null);showAttached();}));
 }
 async function observation(span){
  const old=$('observation-dialog');old?.remove();const dialog=el('dialog');dialog.id='observation-dialog';dialog.className='observation-dialog';
  const form=el('form');let composing=false;form.addEventListener('compositionstart',()=>composing=true);form.addEventListener('compositionend',()=>composing=false);const statement=el('textarea');statement.required=true;statement.rows=5;statement.setAttribute('aria-label','我的观察');
  const concept=el('input');concept.required=true;concept.placeholder='这条观察涉及的概念，多个用逗号分隔';concept.setAttribute('aria-label','概念');
  const kind=el('select');kind.setAttribute('aria-label','观察类型');for(const [v,t]of [['self_report','自报熟悉程度'],['explicit_preference','阅读兴趣／偏好'],['observed_performance','实际表现']]){const o=el('option',t);o.value=v;kind.append(o);}
  const dimension=el('select');dimension.setAttribute('aria-label','表现维度');for(const [v,t]of [['explanation','解释'],['application','应用'],['retention','回忆']]){const o=el('option',t);o.value=v;dimension.append(o);}dimension.hidden=true;kind.onchange=()=>dimension.hidden=kind.value!=='observed_performance';
  const notice=el('p','保存后仍为未确认；请写自己的判断，不用 AI 回答代替。');const result=el('p');result.setAttribute('role','status');
  const submit=el('button','保存观察','primary');submit.type='submit';const cancel=button('取消',()=>dialog.close());
  form.append(el('h2','记录观察'),el('blockquote',span.quote),concept,kind,dimension,statement,notice,result,submit,cancel);dialog.append(form);document.body.append(dialog);
  const requestId=crypto.randomUUID(),bookId=getState().book.id;
  form.onsubmit=async e=>{e.preventDefault();if(composing||e.isComposing||!statement.value.trim())return;submit.disabled=true;try{
   await bridge.business('record',{bookId,spanId:span.span_id,statement:statement.value,conceptRefs:concept.value.split(/[,，]/).map(x=>x.trim()).filter(Boolean),kind:kind.value,dimension:kind.value==='self_report'?'familiarity':kind.value==='explicit_preference'?null:dimension.value,requestId});
   dialog.close();if(getState().book?.id===bookId)await bridge.selectRightTool('guide');
  }catch(error){result.textContent=error.message;}finally{submit.disabled=false;}};
  dialog.addEventListener('close',()=>dialog.remove(),{once:true});await showNativeDialog(dialog,statement);
 }
 function render(next){if(!next.businessEnabled)return false;
  const sig=JSON.stringify([next.book?.id,next.business]);if(sig===signature)return true;signature=sig;
  if(currentSpan&&currentSpan.book_id!==next.bookInfo?.bookId){currentSpan=null;searchAuthorized=false;discussEpoch++;showAttached();}renderSearchPermission();
  const data=next.business,result=data?.recommendations?.result,guide=result?.book_guide;
  $('fixture-banner').hidden=!next.testProfile;$('fixture-banner').textContent='隔离验收数据 · 测试观察不作为个人能力或偏好的依据';$('guide-empty').hidden=true;$('guide-details').hidden=false;
  const progress=data?.job?.progress,phase={parse:'解析书籍',chunk:'分段理解',chapter:'章节归纳',book:'全书综合',reduce:'归并跨章主题',coverage:'检查核心主题遗漏',verify:'核对段落与原文引用'}[progress?.phase]||'处理材料';
  $('analysis-scope').textContent=data?.analyzing?`正在${phase}${progress?.total?' · '+progress.done+'/'+progress.total:''}`:guide?(guide.coverage_scope?.mode==='whole_book'?'本次导读覆盖已处理的正文':'分析范围见下方详情'):'尚未生成导读';
  const box=$('guide-details');box.replaceChildren();
  if(data?.analyzing){box.append(button('取消生成',()=>request('cancel-analysis')));}
  else {const analyze=button(guide?'更新导读':'生成导读',async()=>{const bookId=next.book.id;if(getState().book?.id!==bookId)throw Error('书籍已切换，请重新生成导读');const key='reading:analysis-disclosure:v1';if(!localStorage.getItem(key)){const accepted=await new Promise(resolve=>{const d=el('dialog');d.append(el('h2','生成导读'),el('p','本书正文将按段交给已登录的 Codex 模型分析。'));const cancel=button('取消',()=>d.close());const proceed=button('继续生成',()=>{d.returnValue='proceed';d.close();});d.append(cancel,proceed);document.body.append(d);const trigger=document.activeElement;d.addEventListener('close',()=>{const ok=d.returnValue==='proceed';d.remove();trigger?.focus();resolve(ok);},{once:true});void showNativeDialog(d,cancel).catch(error=>{d.remove();showError(error.message);resolve(false);});});if(!accepted)return;localStorage.setItem(key,'acknowledged');}if(getState().book?.id!==bookId)throw Error('书籍已切换，请重新生成导读');await bridge.business('analyze',{bookId,jobId:crypto.randomUUID()});});analyze.disabled=!next.book?.id||next.runtime?.state!=='ready';box.append(analyze);}
  if(data?.error||data?.job?.error)box.append(el('p',data.error||data.job.error,'chat-error'));
  if(!guide&&!data?.analyzing)box.append(contentEmpty({title:'尚无导读'}));
  else if(guide){
   const generated=data?.generatedGuide?.status==='ready',missingDetails=data?.guideDisplay?.generationStatus==='details-unavailable';
   if(!generated)box.append(el('p',missingDetails?'导读仍可阅读，详细来源暂不可用。':'当前为原文摘录，尚未完成综合。','guide-scope'));box.append(el('h2',generated||missingDetails?'本书浓缩':'原文摘录'));
   for(const [index,row] of (guide.overview_paragraphs??[]).entries()){
    box.append(markdown(typeof row==='string'?row:row.text??'','guide-overview'));
    const refs=data.generatedGuide?.overview_paragraphs?.[index]?.source_refs??row.source_refs??[];
    if(refs.length){const sources=el('details','','overview-sources');sources.append(el('summary',`本段原文依据 · ${refs.length} 处`));for(const spanId of refs){const detail=el('div');const source=data.generatedGuide?.sources?.find?.(x=>x.span_id===spanId)??data.generatedGuide?.sources?.[spanId];detail.append(el('small',data.guideDisplay?.sources?.[spanId]?.title||source?.title||source?.section_title||'原文节选'));if(source?.quote||source?.text)detail.append(el('blockquote',(source.quote||source.text).slice(0,240)+((source.quote||source.text).length>240?'…':'')));detail.append(button('查看本段来源',()=>request('locate',{spanId})));sources.append(detail);}box.append(sources);}
   }
   box.append(el('h2','值得阅读'));for(const [i,row] of (guide.items??[]).entries()){
    const card=el('section','','recommendation');const display=data?.guideDisplay?.items?.[i],target=display?.target;card.dataset.recommendationIndex=String(i);
    card.append(el('h3',display?.title||`阅读线索 ${i+1}`));const reason=display?.reason||'具体阅读价值尚待生成。';if(Array.from(reason).length>150){card.append(el('p',Array.from(reason).slice(0,150).join('')+'…'));const more=el('details');more.append(el('summary','完整理由'),markdown(reason));card.append(more);}else card.append(markdown(reason));
    if(target){card.dataset.targetKind=target.kind;card.append(el('p',(target.kind==='chapter'?'章节 · ':'片段 · ')+target.title,'target-caption'),el('blockquote',displayPreview(target.preview,target.title)+(target.characters>Array.from(target.preview).length?'…':''),'reading-target'));
     const actions=el('div','','target-actions');actions.append(button(target.kind==='chapter'?'阅读本章':'读原文',()=>request(target.kind==='chapter'?'locate-target':'locate',{spanId:target.spanId})));
     if(target.canDiscuss!==false)actions.append(button(target.kind==='chapter'?'讨论本章':'讨论这段',()=>discuss(target.spanId,{bookId:next.book.id,sessionId:getSession()},target.kind)));card.append(actions);
     if(target.canDiscuss===false)card.append(el('p','本章较长，可选择下方片段讨论。','target-caption'));else if(target.kind==='chapter'){const info=el('details','','target-caption');info.append(el('summary','材料范围'),el('p',`本章原文 ${target.characters.toLocaleString()} 字；附加后可查看。`));card.append(info);}
    }else card.append(el('p',display?.targetMessage||'此旧导读尚未明确阅读对象，请从依据中选择原文。','target-caption'));
    const refs=[...new Set(display?.evidenceRefs??row.source_refs??[])];if(refs.length){const details=el('details','','source-evidence');details.append(el('summary',`查看依据 · ${refs.length} 处`));const groups=new Map();for(const ref of refs){const src=data?.guideDisplay?.sources?.[ref];const k=src?.section_id||'unavailable';if(!groups.has(k))groups.set(k,[]);groups.get(k).push({ref,src});}
     for(const rows of groups.values()){const group=el('section','','evidence-group');group.append(el('h4',rows[0].src?.title||'来源待核对'));for(const {ref,src} of rows){const item=el('div','','evidence-item');item.append(el('blockquote',displayPreview(src?.text||src?.quote,src?.title)||'这条来源的预览暂不可用。'));const actions=el('div','','evidence-actions');actions.append(button('查看原文',()=>request('locate',{spanId:ref})),button('附加这段',()=>discuss(ref)));item.append(actions);group.append(item);}details.append(group);}card.append(details);
    }box.append(card);
   }
   if(data?.guideDisplay?.personal?.length)box.append(el('h2','为什么推荐给你'));
   for(const row of data?.guideDisplay?.personal??[]){const card=el('section','','recommendation');card.append(el('h3',row.title),el('blockquote',row.statement),el('p',row.explanation));box.append(card);}
   const details=el('details','','guide-coverage');details.append(el('summary','分析范围与生成详情'));const coverage=data.generatedGuide?.coverage;details.append(el('p',coverage?`已处理 ${coverage.processed_sections?.length??0} 个原文单元，其中正文 ${coverage.body_unit_count??0} 个；这些不等同于印刷章节或页数。`:'本导读的详细处理范围暂不可用。'));if(coverage?.excluded?.length)details.append(el('p','未用于正文综合：'+coverage.excluded.map(x=>x.title).join('、')));details.append(el('p','仅基于实际处理的材料；来源用于核对书中观点，不代表个人掌握程度。'));box.append(details);
  }
  const evidence=data?.evidence?.notes??[];if(evidence.length){box.append(el('h2','已记录的观察'));for(const n of evidence){const card=el('section','','recommendation');card.append(el('h3',({self_report:'自报理解',explicit_preference:'阅读偏好',observed_performance:'具体表现'})[n.kind]||'理解观察'),el('p',`${({user:'用户陈述',book:'书中观点',ai_inference:'AI 推演'})[n.origin]||'归属待核对'} · ${n.confirmation==='confirmed'?'已确认':'未确认'}${n.test_evidence?' · 验收测试':''}`),el('blockquote',n.statement||'观察正文未能读取，请打开笔记核对。','observation-statement'),el('p','涉及概念：'+(n.concept_refs?.join('、')||'尚未记录')));
   if(n.source_quote){const source=el('details');source.append(el('summary','书中来源（不代表用户判断）'),el('blockquote',n.source_quote));card.append(source);}
   const note=(data.notes??[]).find(x=>x.data?.id===n.note_id);if(note)card.append(button('查看笔记',()=>bridge.openNote(note.id)));
   if(n.confirmation==='unconfirmed'&&n.statement?.trim())card.append(button('我确认这条观察',()=>request('confirm',{noteId:n.note_id,contentHash:n.content_hash})));box.append(card);}}
  return true;
 }
 let attachmentEpoch=0;
 async function restoreAttachment(){const ticket=++attachmentEpoch;discussEpoch++;authorizationEpoch++;authorizationPending=false;currentSpan=null;sessionSearchPolicy=null;searchAuthorized=false;showAttached();const s=getState();if(!s?.businessEnabled||!s.book?.id||!getSession())return;const sessionId=getSession(),bookId=s.book.id;try{const data=await request('attachment',{sessionId});if(ticket===attachmentEpoch&&getSession()===sessionId&&getState().book?.id===bookId){currentSpan=data.span;sessionSearchPolicy=data.searchPolicy;searchAuthorized=data.searchAuthorized===true;showAttached();}}catch{} }
 const restoreSearch=$('session-search-restore');if(restoreSearch)restoreSearch.onclick=async()=>{const sessionId=getSession(),bookId=getState().book?.id;if(!sessionId||!bookId)return;restoreSearch.disabled=true;try{await bridge.business('authorize-search',{bookId,sessionId,enabled:true});if(getSession()===sessionId&&getState().book?.id===bookId)await restoreAttachment();}catch(e){$('search-policy-status').textContent=e.message;}finally{restoreSearch.disabled=false;}};
 return {render,discuss,observation,restoreAttachment,attachSource:span=>{currentSpan=span;showAttached();}};
}
