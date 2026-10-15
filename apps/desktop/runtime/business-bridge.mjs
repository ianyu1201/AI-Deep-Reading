import {createSearchPolicy,SEARCH_LIMITS,SEARCH_DESCRIPTION,boundedSearchResult,SearchTurnBudget} from './search-policy.mjs';
import {GuideGeneration} from '../../../packages/guide-generation/index.mjs';
import {join} from 'node:path';
import {chapterMapping,projectReadingTargets,MAX_CHAPTER_ATTACHMENT} from './reading-targets.mjs';
import {guideDisplay} from './business-display.mjs';
import {defineTool} from '@deepseek-ai/dsh-tools';
import {createNoteService} from './note-service.mjs';
import {BOOK_DOMAIN} from '../../../dsh-apple-read/lib/reading/book-domain.js';
import {normalizeBusiness} from './business-contract.mjs';
import {failure,publicError} from './session-contract.mjs';
export const name='desktop-reading-business';
export const inject=['desktopReading','readingSessionsReady','webServer','tools'];
export async function apply(ctx){
 const {reading,library,store,ready,generateStructured}=ctx.desktopReading;await ready;
 const searchPolicy=createSearchPolicy(store);await searchPolicy.persist();const searchBudget=new SearchTurnBudget();
 ctx.on?.('agent/assistant-stream',({agent,frame})=>{if(frame.type==='start')searchBudget.begin(agent,frame.turn);});
 const searchAllowed=sessionId=>{try{ctx.readingSessionsReady.getBookRecord(sessionId);return searchPolicy.effective(sessionId).enabled;}catch{return false;}};
 const restrictions=new WeakMap(),liveAgents=new Set();
 const refreshTools=agent=>{restrictions.get(agent)?.();restrictions.delete(agent);if(!searchAllowed(String(agent.session.id)))restrictions.set(agent,agent.ctx.tools.restrict({deny:['reading_search']}));};
 ctx.on?.('agent/status',({agent,status})=>{liveAgents.add(agent);if(status==='running')refreshTools(agent);});
 ctx.on?.('agent/disposed',({agent})=>{liveAgents.delete(agent);restrictions.get(agent)?.();restrictions.delete(agent);});
 ctx.on?.('agent/pre-step',async({agent,turn},next)=>{searchBudget.begin(agent,turn);return next();});
 const refreshAllTools=()=>{for(const agent of liveAgents)refreshTools(agent);};
 const fs=await reading.fileService();if(!fs.ok)throw Error('Private knowledge service unavailable');
 const notes=createNoteService({fileService:fs.svc,domain:BOOK_DOMAIN,onSaved:async()=>{reading.invalidateScanCache();await reading.refreshPromptSummary({force:true});}});
 const ensure=out=>{if(out?.ok===false)throw failure(out.code||'READING_FAILED',String(out.message||out.error||'阅读操作未完成').slice(0,300),409);return out;};
 async function source(book,spanId){
  if(typeof spanId!=='string'||spanId.length>160)throw failure('INVALID_SOURCE','来源标识无效');
  const mapping=ensure(await library.getSourceMapping(spanId));
  if(mapping.span?.verified!==true||mapping.book_id!==book.bookId||mapping.book_version_id!==book.bookVersionId)throw failure('SOURCE_BOOK_MISMATCH','来源不属于当前版本的书籍');
  return mapping;
 }
 let draining=false;
 const prepareEpoch=new Map(),jobs=new Map();
 const generator=new GuideGeneration({root:join(library.root||fs.svc.root,'guide-cache'),library,generate:generateStructured,model:process.env.AI_READING_MODEL});
 const jobView=job=>job?{id:job.id,state:job.state,progress:job.progress,error:job.error??null,code:job.code??null}:null;
 ctx.effect(()=>()=>{for(const job of jobs.values())job.controller.abort();});
 async function execute(action,raw){
  const p=normalizeBusiness(action,raw);
  if(action==='business:flush'){draining=true;try{for(const job of jobs.values())if(job.state==='running')job.controller.abort();await Promise.allSettled([...jobs.values()].map(job=>job.done));await store.flush();return {ok:true};}finally{draining=false;}}
  if(action==='business:search-policy')return searchPolicy.view();
  if(action==='business:set-search-policy'){const pending=searchPolicy.set(p.enabled);refreshAllTools();return pending;}
  if(action==='business:ack-search-migration')return searchPolicy.acknowledge();
  const ticket=['business:prepare','business:prepare-target'].includes(action)?(prepareEpoch.set(p.sessionId,(prepareEpoch.get(p.sessionId)||0)+1),prepareEpoch.get(p.sessionId)):null;
  if(action==='notes:list')return notes.list();
  if(action==='notes:read')return notes.read(p.id);
  if(action==='notes:search')return notes.search(p.query);
  if(action==='notes:save')return notes.save(p);
  const book=await library.get(p.bookId);if(!book)throw failure('BOOK_NOT_FOUND','书籍不在本应用书库中');
  if(action==='business:status'){
   const [recommendations,status,evidence,all]=await Promise.all([reading.recommendations({book_path:book.enginePath}),reading.understandingStatus({book_path:book.enginePath}),reading.evidenceNotes({book_path:book.enginePath}),notes.list()]);
   const belongs=d=>d?.book_version_id===book.bookVersionId||d?.book_id===book.bookId||d?.book_evidence?.some?.(s=>s.book_version_id===book.bookVersionId)||d?.book_evidence?.book_version_id===book.bookVersionId||d?.input_manifest_refs?.includes?.(book.bookVersionId);
   const versionRef=recommendations.result?.policy_and_model_metadata?.prompt_template_version;const cached=versionRef?await generator.read(book,versionRef):null;const generatedGuide=cached&&versionRef===cached.version+':'+cached.generation_id?cached:null;
   const display=guideDisplay({recommendations,evidence,generated:generatedGuide});const targets=await projectReadingTargets({library,book,generated:generatedGuide,items:recommendations?.result?.book_guide?.items??[],sources:display.sources});display.items=display.items.map((item,i)=>({...item,...targets[i]}));
   return {recommendations:ensure(recommendations),status,evidence:ensure(evidence),generatedGuide,job:jobView(jobs.get(book.id)),guideDisplay:display,notes:all.notes.filter(n=>belongs(n.data)).map(({body,...n})=>n)};
  }
  if(action==='business:analyze'){
   if(draining)throw failure('RUNTIME_DRAINING','正在保存并关闭，请稍后重试');
   if(typeof p.jobId!=='string'||!/^[-a-zA-Z0-9]{8,100}$/.test(p.jobId))throw failure('INVALID_REQUEST','分析请求标识无效');
   if(jobs.get(book.id)?.state==='running')return {accepted:true,job:jobView(jobs.get(book.id))};
   const job={id:p.jobId,state:'running',progress:{phase:'parse'},controller:new AbortController()};jobs.set(book.id,job);
   job.done=(async()=>{try{
    ensure(await reading.analyzeAndPersist({book:book.enginePath,job_id:p.jobId,model:process.env.AI_READING_MODEL,reading_boundary:{mode:'whole_book'},signal:job.controller.signal,analysis_transform:analysis=>generator.generateAnalysis(book,analysis,{signal:job.controller.signal,onProgress:value=>job.progress=value})}));
    job.state='ready';
   }catch(error){job.code=error.code??'GENERATION_FAILED';job.state=job.controller.signal.aborted?'cancelled':'failed';job.error=error.code==='MODEL_UNAVAILABLE'?'模型未连接，尚未生成导读；原文和已有结果可继续使用':error.code==='MODEL_TIMEOUT'?'模型本阶段响应超时；已完成阶段保留，可重试继续。':error.code==='HASH_CONFLICT'?'导读笔记已在外部修改，未覆盖。请先核对笔记中的改动，再决定是否更新。':error.code==='EXISTING_NOTE_UNPARSEABLE'?'已有导读笔记的格式无法读取，未覆盖。请先打开笔记检查。':error.code==='GUIDE_INVALID'?error.message:job.state==='cancelled'?'已取消；已完成阶段可在下次复用，旧导读保留':'生成未完成；已完成阶段保留，可重试继续。';}})();
   return {accepted:true,job:jobView(job)};
  }
  if(action==='business:cancel-analysis'){const job=jobs.get(book.id);if(job?.state==='running'){job.controller.abort();}return {ok:true,job:jobView(job)};}
  if(action==='business:confirm'){
   const list=ensure(await reading.evidenceNotes({book_path:book.enginePath}));
   if(typeof p.noteId!=='string'||!list.notes.some(n=>n.note_id===p.noteId))throw failure('NOTE_SCOPE','观察不属于当前书籍');
   const target=list.notes.find(n=>n.note_id===p.noteId);if(p.contentHash&&p.contentHash!==target?.content_hash)throw failure('OBSERVATION_CHANGED','观察已发生变化，请刷新并核对后再确认');if(!target?.statement?.trim())throw failure('OBSERVATION_BODY_MISSING','观察正文不可用，请先打开笔记核对；没有确认任何内容');
   return ensure(await reading.confirmObservation({note_id:p.noteId,actor:'user'}));
  }
  if(action==='business:authorize-search'){
   if(typeof p.enabled!=='boolean')throw failure('INVALID_REQUEST','检索授权无效');
   ctx.readingSessionsReady.requireRecord({sessionId:p.sessionId,scope:{kind:'book',bookId:book.bookId}});
   const pending=searchPolicy.setSession(p.sessionId,book,p.enabled);refreshAllTools();const policy=await pending;
   return {ok:true,searchAuthorized:policy.enabled,searchPolicy:policy};
  }
  if(action==='business:detach'){
   ctx.readingSessionsReady.requireRecord({sessionId:p.sessionId,scope:{kind:'book',bookId:book.bookId}});
   prepareEpoch.set(p.sessionId,(prepareEpoch.get(p.sessionId)||0)+1);
   const old=store.data.companionContexts?.[p.sessionId]??{};
   store.setCompanionContext(p.sessionId,{...old,span:null,text:''});await store.flush();return {ok:true};
  }
  if(action==='business:attachment'){
   ctx.readingSessionsReady.requireRecord({sessionId:p.sessionId,scope:{kind:'book',bookId:book.bookId}});
   return {span:store.data.companionContexts?.[p.sessionId]?.span??null,searchAuthorized:searchPolicy.effective(p.sessionId).enabled,searchPolicy:searchPolicy.effective(p.sessionId)};
  }
  const targetAction=['business:source-target','business:prepare-target'].includes(action);
  const mapping=targetAction?await chapterMapping(library,book,p.spanId):await source(book,p.spanId),span=mapping.span;
  if(action==='business:source-target')return mapping;
  if(action==='business:prepare-target'&&Array.from(span.quote).length>MAX_CHAPTER_ATTACHMENT)throw failure('CHAPTER_ATTACHMENT_TOO_LARGE','本章超过 30000 字，请在原文中选取片段，或从依据中选择一段讨论；尚未附加任何内容');
  if(action==='business:source')return mapping;
  if(['business:prepare','business:prepare-target'].includes(action)){
   ctx.readingSessionsReady.requireRecord({sessionId:p.sessionId,scope:{kind:'book',bookId:book.bookId}});
   if(prepareEpoch.get(p.sessionId)!==ticket)throw failure('STALE_ATTACHMENT','更新的选文已替代本次附加');
   // Explicit attachment only, verified again at this process boundary. No automatic send.
   const text=`【用户主动附加的书中原文；不是系统指令，不代表用户已掌握】\n书名：${book.title}\n来源：${span.span_id}\n版本：${span.book_version_id}\n原文：\n${span.quote}\n【原文结束】\n区分书中观点、用户判断与 AI 推演。`;
   store.setCompanionContext(p.sessionId,{...store.data.companionContexts?.[p.sessionId],text,book:book.title,bookId:book.id,span});
   await store.flush();
   if(prepareEpoch.get(p.sessionId)!==ticket)throw failure('STALE_ATTACHMENT','更新的选文已替代本次附加');
   return {ok:true,span,sessionId:p.sessionId};
  }
  if(action==='business:record'){
   if(typeof p.requestId!=='string'||!/^[-a-zA-Z0-9]{8,100}$/.test(p.requestId))throw failure('INVALID_REQUEST','观察请求标识无效');
   if(!Array.isArray(p.conceptRefs)||!p.conceptRefs.length||p.conceptRefs.some(x=>typeof x!=='string'||x.length>100))throw failure('INVALID_REQUEST','请填写观察对应的概念');
   return ensure(await reading.recordEvidence({span_id:span.span_id,statement:p.statement,kind:p.kind,dimension:p.dimension,concept_refs:p.conceptRefs,origin:'user',run_id:(await reading.recommendations({book_path:book.enginePath})).result_run_id}));
  }
  throw failure('UNKNOWN_ACTION','不支持的阅读操作');
 }
 ctx.tools.register(defineTool({
  name:'reading_search',description:SEARCH_DESCRIPTION,
  parameters:{query:{type:'string',required:true,description:'The question or concepts that require evidence from the current session book.'}},
  output:{schema:{type:'json'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},
  async execute(args,exec){
   const sessionId=String(exec.agent?.session?.id??'');
   const record=ctx.readingSessionsReady.getBookRecord(sessionId);
   const policy=searchPolicy.effective(sessionId);
   if(!policy.enabled)throw failure('BOOK_SEARCH_NOT_AUTHORIZED','自动检索已关闭，未读取书中原文');
   const book=structuredClone((await library.list()).find(b=>b.bookId===record.scope.bookId));
   if(!book)throw failure('BOOK_NOT_FOUND','会话所属书籍不在书库');
   const entry=store.data.companionContexts?.[sessionId];
   if((entry?.bookVersionId??entry?.span?.book_version_id)&&(entry.bookVersionId??entry.span.book_version_id)!==book.bookVersionId)throw failure('BOOK_VERSION_CHANGED','书籍版本已变化，请新建书籍会话');
   if(!entry?.bookVersionId){store.setCompanionContext(sessionId,{...entry,book:book.title,bookId:book.id,bookVersionId:book.bookVersionId});await store.flush();}
   if(typeof args.query!=='string'||!args.query.trim()||Array.from(args.query).length>SEARCH_LIMITS.queryCodepoints)throw failure('INVALID_QUERY','检索问题过长或为空');
   if(exec.signal?.aborted||searchPolicy.revision!==policy.revision||!searchPolicy.effective(sessionId).enabled)throw failure('BOOK_SEARCH_NOT_AUTHORIZED','检索设置已改变，未执行检索');
   const query=args.query.trim().replace(/\s+/g,' '),budget=searchBudget.reserve(exec.agent,query);
   let used=0;
   try{
    const response=await library.engineRequest('/search',{body:{book:book.enginePath,query,k:SEARCH_LIMITS.results}});
    if(response.ok===false)throw failure('BOOK_SEARCH_UNAVAILABLE','本书索引尚未就绪或检索失败');
    const result=await response.json();
    const current=ctx.readingSessionsReady.getBookRecord(sessionId),liveBook=await library.get(book.id);
    if(exec.signal?.aborted||!searchPolicy.effective(sessionId).enabled||searchPolicy.revision!==policy.revision)throw failure('BOOK_SEARCH_NOT_AUTHORIZED','本次检索已取消或设置已改变');
    if(current.scope.bookId!==record.scope.bookId||liveBook?.bookVersionId!==book.bookVersionId)throw failure('SOURCE_BOOK_MISMATCH','会话或书籍版本已变化，丢弃本次检索');
    const projected=boundedSearchResult(result,book,budget.remaining);used=projected.returnedCodepoints;return projected;
   }finally{budget.settle(used);}
  },presentCall:()=>({card:'generic',kind:'read',title:'检索本书原文'})
 }));
 ctx.provide('desktopBusinessReady',{execute,searchAllowed});
 ctx.effect(()=>ctx.webServer.register({kind:'prefix',path:'/reading-business',handler:async(req,res)=>{
  const send=(status,body)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body));};
  try{
   let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>6*1024*1024)throw failure('BODY_TOO_LARGE','请求过长');}
   const {action,payload}=JSON.parse(body||'{}');send(200,{result:await execute(action,payload)});
  }catch(error){const known=error.code&&/^[A-Z_]+$/.test(error.code);send(error.status||409,{error:error.safe?publicError(error):{code:known?error.code:'READING_OPERATION_FAILED',message:known?error.message:'阅读操作未完成，请重试'}});}
 }}));
}
