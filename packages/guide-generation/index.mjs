import {GUIDE_REVISIONS} from '../../dsh-apple-read/lib/reading/guide-prompts.js';
import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
export const VERSION='grounded-guide-v1';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const fail=message=>Object.assign(new Error(message),{code:'GUIDE_INVALID'});
const kinds=new Set(['body','preface','copyright','contents','endorsement','acknowledgments','other']);
export function paragraphs(text,digest,order,segments=null){
 const chars=Array.from(text),out=[];
 const ranges=segments??[{start_codepoint:0,end_codepoint:chars.length}];
 let previous=0;
 for(const segment of ranges){
  const startAt=segment.start_codepoint,endAt=segment.end_codepoint;
  if(!Number.isInteger(startAt)||!Number.isInteger(endAt)||startAt<previous||endAt<startAt||endAt>chars.length||chars.slice(previous,startAt).join('').trim())throw fail('章节文件边界无效，未生成跨文件引用');
  if(typeof segment.text==='string'&&segment.text!==chars.slice(startAt,endAt).join(''))throw fail('章节文件文本与绝对坐标不一致');
  let start=startAt;
  while(start<endAt){let end=Math.min(start+500,endAt);const cut=chars.slice(start,end).lastIndexOf('\n');if(cut>120)end=start+cut+1;const excerpt=chars.slice(start,end).join('');if(excerpt.trim())out.push({ref:`sp_${digest}_${order}_${start}_${end}`,text:excerpt});start=end;}
  previous=endAt;
 }
 if(chars.slice(previous).join('').trim())throw fail('章节文件映射未覆盖正文');
 return out;
}
function validateRows(out,allowed){if(!Array.isArray(out)||!out.length||out.length>6)throw fail('模型没有返回有来源的内容');for(const row of out){if(typeof row.text!=='string'||!row.text.trim()||row.text.length>3000||!Array.isArray(row.source_refs)||!row.source_refs.length||row.source_refs.length>12||row.source_refs.some(x=>!allowed.has(x)))throw fail('生成内容缺少有效的本次材料来源（'+(typeof row.text!=='string'?'正文类型':!row.text.trim()?'空正文':row.text.length>3000?'正文过长':!Array.isArray(row.source_refs)?'缺少引用列表':!row.source_refs.length?'引用为空':row.source_refs.length>12?'单段引用超过12条':'引用不在本次材料')+'）');}return out;}
export class GuideGeneration {
 constructor({root,library,generate,model}){Object.assign(this,{root,library,generate,model});this.jobs=new Map();}
 async read(book,versionRef=null){if(versionRef&&!new RegExp('^'+VERSION+':[a-f0-9]{64}$').test(versionRef))return null;try{return JSON.parse(await readFile(join(this.root,versionRef?'guide-'+book.bookVersionId+'-'+versionRef.split(':')[1]+'.json':book.bookVersionId+'.json'),'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
 async save(name,value){await mkdir(this.root,{recursive:true,mode:0o700});const path=join(this.root,name+'.json'),tmp=path+'.tmp';await writeFile(tmp,JSON.stringify(value,null,2),{mode:0o600});await rename(tmp,path);}
 async generateAnalysis(book,analysis,{signal,onProgress=()=>{}}={}){
  const localAbort=new AbortController();signal=signal?AbortSignal.any([signal,localAbort.signal]):localAbort.signal;
  const receipts=[],sourceMap={},parts=[];let calls=0,hits=0;
  const stage=async(task,input,validate)=>{signal?.throwIfAborted();if(JSON.stringify(input).length>50000)throw fail('本阶段材料超过字符预算；已完成阶段保留');const key=hash([VERSION,this.model,task,GUIDE_REVISIONS[task],input]);const domain=new Set(input.sources?.map(x=>x.ref));const check=out=>{if(JSON.stringify(out).length>18000)throw fail('模型输出超过字符预算');validate(out);const visit=x=>{if(!x||typeof x!=='object')return;if(Array.isArray(x.source_refs)&&x.source_refs.some(ref=>!domain.has(ref)))throw fail('引用超出本阶段实际材料');for(const value of Object.values(x))if(value&&typeof value==='object')visit(value);};visit(out);};let output;try{output=JSON.parse(await readFile(join(this.root,'stage-'+key+'.json'),'utf8'));check(output);hits++;}catch(e){if(e.code!=='ENOENT'&&!(e instanceof SyntaxError)&&e.code!=='GUIDE_INVALID')throw e;if(calls>=256)throw fail('本书模型调用预算已用完，已完成阶段保留');calls++;onProgress({phase:task,calls,hits});output=await this.generate({task:'grounded_guide',stage:task,input},{signal,timeoutMs:300000});try{check(output);}catch(error){await this.save('rejected-'+key,{task,reason:error.message,output,created_at:new Date().toISOString()});throw error;}signal?.throwIfAborted();await this.save('stage-'+key,output);}receipts.push({task,input_hash:key,method:VERSION,model:this.model,source_refs:input.sources?.map(x=>x.ref),completed_at:new Date().toISOString()});return task==='coverage'?{missing_topics:output.missing_topics.map(({topic,text,source_refs})=>({topic,text,source_refs}))}:['book','reduce','verify'].includes(task)?{overview_paragraphs:output.overview_paragraphs.map(({text,source_refs})=>({text,source_refs})),recommendations:output.recommendations.map(({section_id,title,reason,value_score,source_refs})=>({section_id,title,reason,value_score,source_refs}))}:{kind:output.kind,summary:output.summary,claims:output.claims.map(({text,source_refs})=>({text,source_refs}))};};
  // Read exact normalized chapter text. Source offsets remain the engine's codepoint coordinates.
  for(const chapter of analysis.chapters){signal?.throwIfAborted();if(!chapter.chars)continue;
   const spanId=`sp_${analysis.content_id}_${chapter.section_order}_0_${chapter.chars}`;
   const mapping=await (await this.library.engineRequest('/source-mapping',{body:{span_id:spanId},signal})).json(),source=mapping.span;
   if(!mapping.ok||mapping.book_version_id!==book.bookVersionId||!source?.ok||source.book_version_id!==book.bookVersionId||!Array.isArray(mapping.segments)||!mapping.segments.length)throw fail('章节来源版本或文件映射核验失败');
   const spans=paragraphs(source.quote,analysis.content_id,chapter.section_order,mapping.segments);for(const item of spans)sourceMap[item.ref]={...item,title:chapter.title||`第 ${chapter.section_order+1} 节`,section_id:chapter.section_id,order:chapter.section_order};
   let group=[],size=0,index=0;for(const item of spans){if(size+item.text.length>21000&&group.length){parts.push({chapter,index:index++,sources:group});group=[];size=0;}group.push(item);size+=item.text.length;}if(group.length)parts.push({chapter,index,sources:group});
  }
  const consumed=[];let cursor=0;
  const worker=async()=>{while(cursor<parts.length){const part=parts[cursor++];const input={title:part.chapter.title,section_id:part.chapter.section_id,part:part.index,sources:part.sources};const allowed=new Set(part.sources.map(x=>x.ref));const value=await stage('chunk',input,out=>{if(!kinds.has(out.kind)||typeof out.summary!=='string'||!out.summary.trim()||out.summary.length>3000)throw fail('分段理解结构不完整');validateRows(out.claims,allowed);});consumed.push({...part,value});onProgress({phase:'chunk',done:consumed.length,total:parts.length,calls,hits});}};
  const workers=[worker(),worker()];try{await Promise.all(workers);}catch(error){localAbort.abort();await Promise.allSettled(workers);throw error;}signal?.throwIfAborted();
  const chapters=[];
  for(const chapter of analysis.chapters){const rows=consumed.filter(x=>x.chapter.section_id===chapter.section_id).sort((a,b)=>a.index-b.index);if(!rows.length)continue;let value=rows[0].value;
   if(rows.length>1){
    const chapterInput=rows=>({title:chapter.title,parts:rows,sources:[...new Set(rows.flatMap(c=>c.claims.flatMap(x=>x.source_refs)))].map(ref=>sourceMap[ref])});
    let layer=rows.map(x=>x.value);for(let depth=0;JSON.stringify(chapterInput(layer)).length>42000;depth++){
     if(depth>4)throw fail('长章节超出分层预算');const groups=[];let group=[];for(const row of layer){if(group.length&&JSON.stringify(chapterInput([...group,row])).length>25000){groups.push(group);group=[];}group.push(row);}if(group.length)groups.push(group);if(groups.length===layer.length)throw fail('单段归纳过长');
     const next=[];for(const group of groups){const input=chapterInput(group);next.push(await stage('chapter',input,out=>{if(!kinds.has(out.kind)||typeof out.summary!=='string'||!out.summary.trim()||out.summary.length>3000)throw fail('章节归纳不完整');validateRows(out.claims,new Set(input.sources.map(x=>x.ref)));}));}layer=next;
    }
    const input=chapterInput(layer);value=await stage('chapter',input,out=>{if(!kinds.has(out.kind)||typeof out.summary!=='string'||!out.summary.trim()||out.summary.length>3000)throw fail('章节归纳不完整');validateRows(out.claims,new Set(input.sources.map(x=>x.ref)));});
   }
   chapters.push({section_id:chapter.section_id,title:chapter.title,section_order:chapter.section_order,kind:value.kind,summary:value.summary,claims:value.claims});
  }
  const relevant=chapters.filter(c=>['body','preface'].includes(c.kind));if(!relevant.some(x=>x.kind==='body'))throw fail('没有足够正文可综合');
  const refs=[...new Set(relevant.flatMap(c=>c.claims.flatMap(x=>x.source_refs)))];
  // Original excerpts are re-read into final synthesis, avoiding summary-only recursive distortion.
  const validateFinal=out=>{validateRows(out.overview_paragraphs,new Set(refs));if(!Array.isArray(out.recommendations)||!out.recommendations.length||out.recommendations.length>3)throw fail('缺少阅读推荐');for(const row of out.recommendations){if(!relevant.some(c=>c.section_id===row.section_id)||typeof row.title!=='string'||!row.title.trim()||row.title.length>160||typeof row.reason!=='string'||!row.reason.trim()||row.reason.length>2000||![1,2,3].includes(row.value_score))throw fail('推荐范围无效');validateRows([{text:row.reason,source_refs:row.source_refs}],new Set(refs));if(row.source_refs.some(ref=>sourceMap[ref].section_id!==row.section_id))throw fail('推荐章节与来源不一致');}};
  const inputFor=rows=>{const ids=[...new Set(rows.flatMap(c=>c.claims?c.claims.flatMap(x=>x.source_refs):[...c.overview_paragraphs.flatMap(x=>x.source_refs),...c.recommendations.flatMap(x=>x.source_refs)]))];return {title:book.title,chapters:rows,sources:ids.map(ref=>sourceMap[ref])};};
  let layer=relevant;
  // Bound every synthesis prompt; large books form an evidence-linked reduction tree.
  for(let depth=0;JSON.stringify(inputFor(layer)).length>42000;depth++){
   if(depth>4)throw fail('综合材料超过预算，请缩小范围');const groups=[];let group=[];
   for(const row of layer){if(group.length&&JSON.stringify(inputFor([...group,row])).length>30000){groups.push(group);group=[];}group.push(row);}if(group.length)groups.push(group);
   if(groups.length===layer.length)throw fail('单章综合材料超过预算');
   const next=[];for(const group of groups)next.push(await stage('reduce',inputFor(group),out=>{validateFinal(out);const ids=new Set([...out.overview_paragraphs.flatMap(x=>x.source_refs),...out.recommendations.flatMap(x=>x.source_refs)]);if(out.overview_paragraphs.length>2||out.recommendations.length>3||[...out.overview_paragraphs,...out.recommendations].some(row=>row.source_refs.length>3)||ids.size>15)throw fail('中间归纳超过引用预算，尚未发布导读');}));layer=next;
  }
  const synthesisInput=inputFor(layer);
  const draft=await stage('book',synthesisInput,validateFinal);
  // Review against the exact original excerpts supplied to synthesis, not a second summary.
  const reviewInput={title:book.title,draft,coverage_themes:relevant.map(({section_id,summary})=>({section_id,summary})),sources:synthesisInput.sources};
  const coverageReview=await stage('coverage',reviewInput,out=>{if(!Array.isArray(out.missing_topics)||out.missing_topics.length>2)throw fail('主题复核结构无效');for(const row of out.missing_topics){if(typeof row.topic!=='string'||!row.topic.trim()||row.topic.length>160)throw fail('主题复核标题无效');validateRows([row],new Set(reviewInput.sources.map(s=>s.ref)));}});
  const final=await stage('verify',{title:book.title,draft,coverage_review:coverageReview,sources:synthesisInput.sources},out=>{validateFinal(out);const used=new Set(out.overview_paragraphs.flatMap(p=>p.source_refs));for(const missing of coverageReview.missing_topics)if(!missing.source_refs.some(ref=>used.has(ref)))throw fail('浓缩尚未处理有直接原文依据的核心主题遗漏');});
  const result={version:VERSION,status:'ready',model:this.model,method:'分段理解 → 章节归纳 → 跨章综合 → 逐段引用复核',verification:{completed:true,method:GUIDE_REVISIONS.verify,scope:'每段主张与本次综合原文对应；模型复核不等于人工质量验收'},prompt_revisions:GUIDE_REVISIONS,book_version_id:book.bookVersionId,created_at:new Date().toISOString(),coverage:{processed_sections:chapters.map(c=>c.section_id),body_sections:relevant.map(c=>c.section_id),excluded:chapters.filter(c=>!['body','preface'].includes(c.kind)).map(c=>({section_id:c.section_id,title:c.title,kind:c.kind})),parsed_only:true,parts:parts.length,parsed_units:chapters.map(c=>({section_id:c.section_id,title:c.title,kind:c.kind,characters:analysis.chapters.find(a=>a.section_id===c.section_id)?.chars??0})),body_characters:analysis.chapters.filter(a=>chapters.some(c=>c.kind==='body'&&c.section_id===a.section_id)).reduce((sum,c)=>sum+(c.chars||0),0),body_unit_count:chapters.filter(c=>c.kind==='body').length,preface_unit_count:chapters.filter(c=>c.kind==='preface').length,unit_explanation:'解析单元由 EPUB 结构抽取，不等同于作品章节或印刷页；仅覆盖本次实际消费材料'},overview_paragraphs:final.overview_paragraphs,recommendations:final.recommendations,chapters,coverage_review:coverageReview,sources:sourceMap,receipts,calls,cache_hits:hits};
  result.generation_id=hash([VERSION,this.model,book.bookVersionId,result.overview_paragraphs,result.recommendations,result.coverage,result.verification]);
  signal?.throwIfAborted();await this.save('guide-'+book.bookVersionId+'-'+result.generation_id,result);await this.save('pending-'+book.bookVersionId,result);
  // Adapt into existing source-checked ranking and transactional note persistence.
  const adapted=structuredClone(analysis);adapted.generated=result;
  adapted.candidates=final.recommendations.map((rec,i)=>({candidate_id:'ca_'+analysis.content_id+'_'+i,section_id:rec.section_id,section_order:sourceMap[rec.source_refs[0]].order,title:rec.title,summary:chapters.find(c=>c.section_id===rec.section_id).summary,slice_ids:rec.source_refs,proposed_b:{score:rec.value_score,reason:rec.reason}}));
  for(const ref of final.recommendations.flatMap(r=>r.source_refs)){const src=sourceMap[ref];adapted.slices.push({slice_id:ref,window_id:analysis.windows.find(w=>w.section_id===src.section_id&&w.consumed)?.window_id,text:src.text,text_hash:createHash('sha256').update(src.text).digest('hex')});}
  return adapted;
 }
 async commit(book){const next=await readFile(join(this.root,'pending-'+book.bookVersionId+'.json'),'utf8');await this.save(book.bookVersionId,JSON.parse(next));}
}
