// Presentation version only: the generation cache and its evidence are never rewritten.
export const TARGET_VERSION='reading-target-v1';
export const MAX_CHAPTER_ATTACHMENT=30000;
const parse=ref=>/^sp_([a-f0-9]{16})_(\d+)_(\d+)_(\d+)$/.exec(ref);
const fail=message=>Object.assign(Error(message),{code:'READING_TARGET_UNAVAILABLE'});
export async function chapterMapping(library,book,spanId){
 const p=parse(spanId);if(!p||p[1]!==book.bookId)throw fail('阅读对象不属于当前书籍');
 const mapping=await library.getSourceMapping(spanId),s=mapping?.span;
 if(!s?.verified||mapping.book_id!==book.bookId||mapping.book_version_id!==book.bookVersionId)throw fail('阅读对象版本已变化，请重新选择');
 const matches=mapping.segments?.filter(x=>x.start_codepoint===s.start_codepoint&&x.end_codepoint===s.end_codepoint);
 if(matches?.length!==1||matches[0].text!==s.quote)throw fail('无法核验完整章节范围');
 return {...mapping,targetKind:'chapter',targetVersion:TARGET_VERSION};
}
export async function projectReadingTargets({library,book,generated,items,sources}){
 const out=[];const mappings=new Map();
 for(const row of items){
  const refs=[...new Set(row.source_refs??[])],original=generated?.recommendations?.find(r=>r.source_refs.length===refs.length&&r.source_refs.every(x=>refs.includes(x)));
  let target=null,message='此旧导读尚未明确阅读对象，请从依据中选择原文。';
  try{
   const ids=refs.map(parse);if(!refs.length||ids.some(p=>!p||p[1]!==book.bookId))throw fail('部分来源已失效，请核对原文依据。');
   // Exactly one source is itself a continuous reading object; never choose the first of many.
   if(refs.length===1){const mapping=await library.getSourceMapping(refs[0]),s=mapping.span;if(!s?.verified||mapping.book_id!==book.bookId||s.book_version_id!==book.bookVersionId)throw fail('原文版本已变化。');if(mapping.segments?.filter(x=>x.start_codepoint<=s.start_codepoint&&x.end_codepoint>=s.end_codepoint).length!==1)throw fail('旧来源跨越多个文件，请重新核对阅读范围。');target={version:TARGET_VERSION,kind:'fragment',bookId:book.bookId,bookVersionId:book.bookVersionId,spanId:s.span_id,title:sources[refs[0]]?.title||s.section_title,preview:s.quote.slice(0,240),characters:Array.from(s.quote).length};}
   else if(original?.section_id&&refs.every(ref=>sources[ref]?.section_id===original.section_id)&&ids.every(p=>p[2]===ids[0][2])){
    // The model selected this chapter. All evidence must fit the same real content file.
    const key=original.section_id;if(!mappings.has(key))mappings.set(key,await library.getSourceMapping([...refs].sort()[0]));const mapping=mappings.get(key);
    if(mapping.book_id!==book.bookId||mapping.book_version_id!==book.bookVersionId)throw fail('原文版本已变化。');
    const segments=mapping.segments.filter(seg=>ids.every(p=>+p[3]>=seg.start_codepoint&&+p[4]<=seg.end_codepoint));if(segments.length!==1)throw fail('这项推荐的依据分布在多处原文，请展开依据分别阅读。');
    const seg=segments[0];for(let i=0;i<refs.length;i++)if(Array.from(seg.text).slice(+ids[i][3]-seg.start_codepoint,+ids[i][4]-seg.start_codepoint).join('')!==sources[refs[i]]?.text)throw fail('原文依据核验失败。');
    const spanId=`sp_${book.bookId}_${ids[0][2]}_${seg.start_codepoint}_${seg.end_codepoint}`;await chapterMapping(library,book,spanId);
    const title=sources[refs.find(ref=>sources[ref]?.title_origin==='source-heading')]?.title||mapping.title;
    if(!title||['原文片段',book.title].includes(title))throw fail('章节名称尚无法核验，请展开原文依据。');
    target={version:TARGET_VERSION,kind:'chapter',bookId:book.bookId,bookVersionId:book.bookVersionId,spanId,title,href:seg.href,preview:seg.text.slice(0,240),characters:Array.from(seg.text).length,canDiscuss:Array.from(seg.text).length<=MAX_CHAPTER_ATTACHMENT};
   }
  }catch(error){message=error.message;}
  out.push({target,targetStatus:target?'ready':'legacy',targetMessage:target?null:message,evidenceRefs:refs});
 }
 return out;
}
