// Source overlap is stronger than chapter co-location; a long chapter is not one topic.
export function spansOverlap(a,b){
 if(typeof a!=='string'||typeof b!=='string')return false;
 if(a===b)return true;
 const parse=x=>/^sp_([a-f0-9]+)_(\d+)_(\d+)_(\d+)$/.exec(x);
 const x=parse(a),y=parse(b);return !!(x&&y&&x[1]===y[1]&&x[2]===y[2]&&Math.max(+x[3],+y[3])<Math.min(+x[4],+y[4]));
}
// Presentation only: labels come from the actual opening text; no offsets, source
// quotes, generation hashes or stored manifests are changed, and no chapter is invented.
export function projectSourceTitles(generated){
 const input=generated?.sources??{},groups=new Map(),titleSections=new Map();
 for(const [ref,source] of Object.entries(input)){
  const group=groups.get(source.section_id)??[];group.push({ref,...source});groups.set(source.section_id,group);
  const sections=titleSections.get(source.title)??new Set();sections.add(source.section_id);titleSections.set(source.title,sections);
 }
 const headings=new Map();
 for(const [id,rows] of groups){
  rows.sort((a,b)=>Number(a.ref.split('_').at(-2))-Number(b.ref.split('_').at(-2)));
  if(Number(rows[0]?.ref.split('_').at(-2))!==0)continue;
  const lines=rows.slice(0,3).map(r=>r.text??'').join('\n').slice(0,650).split(/\r?\n/).map(x=>x.trim()).filter(Boolean).slice(0,5);
  // Contents lists can contain many valid chapter names; none names that unit.
  if(generated?.chapters?.find(c=>c.section_id===id)?.kind==='contents')continue;
  const number='[〇零一二三四五六七八九十百千0-9]+';
  const chapter=lines.find(x=>new RegExp('^第\\s*'+number+'\\s*[章节]').test(x)&&x.length<=80);
  const part=lines.find(x=>new RegExp('^第\\s*'+number+'\\s*[部篇卷]').test(x)&&x.length<=80);
  const heading=chapter||part||lines.find(x=>/^(前言|引言|序言|附\s*录|译者后记|导读|献词)(?:\s|$)/.test(x)&&x.length<=80);
  if(heading){headings.set(id,{title:heading,title_origin:'source-heading'});continue;}
  // A short opening label following the repeated document title is quoted as a
  // label, not converted into a numeric chapter or treated as a TOC identity.
  const next=lines[0]===rows[0].title?lines[1]:null;
  if(next&&next.length<=40&&!/[。！？；.!?;]/.test(next)&&lines[2]?.length>40)headings.set(id,{title:next,title_origin:'source-opening-label'});
 }
 return Object.fromEntries(Object.entries(input).map(([ref,source])=>[ref,{...source,...(headings.get(source.section_id)??((titleSections.get(source.title)?.size??0)>1?{title:'原文片段',title_origin:'fallback'}:{}))}]));
}
export function guideDisplay({recommendations,evidence,generated}){
 const items=recommendations?.result?.book_guide?.items??[],sources=projectSourceTitles(generated);
 const personal=(evidence?.notes??[]).filter(n=>n.confirmation==='confirmed'&&!n.test_evidence&&n.statement).flatMap(n=>{
  const same=(generated?.recommendations??[]).filter(r=>r.section_id===n.section_id);if(!same.length||n.book_version_id&&generated?.book_version_id&&n.book_version_id!==generated.book_version_id)return [];
  const related=same.find(r=>r.source_refs.some(ref=>spansOverlap(ref,n.span_id)));
  if(!related)return [{title:'同章可回看',statement:n.statement,match:'chapter-only',explanation:'这条已确认记录与推荐位于同一解析单元；尚无具体来源重合依据，不能据此声称主题精准匹配，也不能判断掌握或缺口。'}];
  return [{match:'source-overlap',title:({explicit_preference:'兴趣记录的原文可对照',self_report:'自述记录的原文可对照',observed_performance:'这次表现的原文可对照'})[n.kind]||'观察记录的原文可对照',statement:n.statement,explanation:`「${related.title}」：${related.reason} 来源重合提供核对入口，不等于已确认主题或能力匹配。 `+(({explicit_preference:'推荐原文与你记录的来源重合；兴趣不作为能力判断。',self_report:'你的自述仅供参考，不能据此判断掌握或缺口。',observed_performance:'与这条表现来自同一章节，可核对方法和适用条件；一次表现不代表稳定掌握。'})[n.kind]||'此记录仅用于回看原文，不自动推断掌握或能力。')}];
 });
 return {generationStatus:generated?'verified':recommendations?.result?.policy_and_model_metadata?.prompt_template_version?.startsWith('grounded-guide-')?'details-unavailable':'extractive',personalStatus:personal.length?'有已确认记录；下方区分原文重合与仅同章可回看。':(evidence?.notes??[]).some(n=>n.test_evidence)?'当前含验收观察，测试内容不作为你的真实偏好或能力依据。':(evidence?.notes??[]).length?'已保存的观察可在下方核对；尚无已确认且与本次推荐对应的个人依据。':'尚无个人证据，以上推荐只依据书本。',items:items.map(row=>{const original=generated?.recommendations?.find(r=>r.source_refs.length===row.source_refs?.length&&r.source_refs.every(ref=>row.source_refs.includes(ref)));return {title:original?.title||sources[row.source_refs?.[0]]?.title||'原文片段',reason:original?.reason||(typeof row.reason==='string'&&!row.reason.includes('结构标记')?row.reason:'已从原文提取这段；具体价值解释尚待生成。')};}),sources,personal};
}
