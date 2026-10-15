/** Readable companion to authoritative recommendation_run YAML. Does not rank or infer. */
const text=x=>typeof x==='string'?x.trim():'';
const line=x=>text(x).replace(/[\r\n]+/g,' ').replace(/([\\`*_{}\[\]<>#])/g,'\\$1');
export function recommendationNoteBody({result,generated,bookTitle,revision}){
 const guide=result?.book_guide??{};const complete=generated?.status==='ready';
 const rows=['# 导读与推荐记录','',line(bookTitle)||'当前书籍','',complete?'以下为 AI 根据实际读取材料综合的导读，仍需结合原文判断。':'以下为原文抽取材料，尚未完成生成式跨章综合。','',`记录版本：${Number.isInteger(revision)?revision:'未提供'}。保存此记录不代表用户已确认其中的观点。`,'',complete?'## 本书浓缩':'## 原文摘录',''];
 const paragraphs=Array.isArray(guide.overview_paragraphs)?guide.overview_paragraphs:[];
 for(const p of paragraphs){const value=text(p)||text(p?.text);if(value)rows.push(value,'');}
 if(!paragraphs.length)rows.push('当前记录没有可展示的概括。','');
 const scope=generated?.coverage;
 if(scope)rows.push('## 实际范围','',`已处理 ${scope.processed_sections?.length??0} 个解析单元；其中 ${scope.body_sections?.length??0} 个正文或实质前言单元参与综合。此范围仅指 EPUB 中成功解析的材料。`,'');
 rows.push('## 值得阅读的片段','');
 const items=Array.isArray(guide.items)?guide.items:[];
 if(!items.length)rows.push('本次没有可用的片段推荐。','');
 const usedRefs=new Set(guide.source_refs??[]);
 for(const [index,item] of items.entries()){
  const rec=generated?.recommendations?.find(r=>r.section_id===item.section_id);
  rows.push(`### ${index+1}. ${line(rec?.title)||'阅读片段'}`,'');
  const reason=complete?text(rec?.reason):'';
  if(reason)rows.push(reason,'');else rows.push('本条记录未提供可读的推荐理由，请核对原文。','');
  const refs=(item.source_refs??[]).filter(ref=>typeof ref==='string');for(const ref of refs)usedRefs.add(ref);
  for(const ref of refs.slice(0,2)){
   const source=generated?.sources?.[ref];if(!source?.text)continue;
   rows.push('原文依据：','',...source.text.slice(0,400).trim().split('\n').map(p=>'> '+p),source.text.length>400?'> （节选）':'','');
  }
 }
 rows.push('## 来源校验详情','',`生成方法：${line(generated?.method)||'抽取式章节分析'}。`, `模型：${line(generated?.model)||'未记录生成式模型'}。`, `方法版本：${line(generated?.version)||'旧抽取记录'}。`,'');
 if(!complete)for(const item of items){const reason=text(item.reason);if(reason)rows.push('抽取分析记录：'+reason,'');}
 for(const ref of usedRefs)rows.push('- 来源：`'+String(ref).replaceAll('`','')+'`');
 return rows.join('\n').trim()+'\n';
}
