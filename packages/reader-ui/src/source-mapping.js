// Derived display coordinates only. Authority remains books_rag.py source-span.
const blocks=new Set(['p','div','br','h1','h2','h3','h4','h5','h6','li','tr','section','article']);
const whitespace=/^[\s\u001c-\u001f]$/u;
export function domTextMap(doc){
 const raw=[];
 const push=(char,start,end)=>raw.push({char,start,end});
 function visit(node){
  if(node.nodeType===3){let offset=0;for(const char of node.data){push(char==='\u00a0'||char==='\u3000'?' ':char,{node,offset},{node,offset:offset+char.length});offset+=char.length;}return;}
  if(node.nodeType!==1&&node.nodeType!==9)return;
  const name=node.localName?.toLowerCase(),parent=node.parentNode,index=parent?[...parent.childNodes].indexOf(node):0;
  const before={node:parent??node,offset:index},after={node:parent??node,offset:parent?index+1:node.childNodes.length};
  if(name==='script'||name==='style'){push(' ',before,after);return;}
  if(blocks.has(name))push('\n',before,before);
  for(const child of node.childNodes)visit(child);
  if(blocks.has(name)&&name!=='br')push('\n',after,after);
 }
 visit(doc);
 const lines=[];let line=[];
 function finish(){while(line.length&&whitespace.test(line[0].char))line.shift();while(line.length&&whitespace.test(line.at(-1).char))line.pop();if(line.length)lines.push(line);line=[];}
 for(let i=0;i<raw.length;i++){
  const item=raw[i];
  if(/[\n\r\v\f\u001c-\u001e\u0085\u2028\u2029]/u.test(item.char)){finish();continue;}
  if(item.char===' '||item.char==='\t'){if(line.at(-1)?.char===' '){line.at(-1).end=item.end;continue;}line.push({...item,char:' '});}
  else line.push(item);
 }
 finish();const points=[];
 for(const row of lines){if(points.length)points.push({char:'\n',start:points.at(-1).end,end:row[0].start});points.push(...row);}
 return {text:points.map(x=>x.char).join(''),points};
}
export async function textHash(text){const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));return [...new Uint8Array(bytes)].map(x=>x.toString(16).padStart(2,'0')).join('');}
export function canonicalHref(href){try{return decodeURIComponent(new URL(href,'https://epub.invalid/').pathname).replace(/^\//,'');}catch{return null;}}
export async function verifyMapping(mapping,identity){
 const span=mapping?.span??mapping;
 if(!span?.verified||!span.ok||!identity?.book_id||identity.book_id!==span.book_id||identity.book_version_id!==span.book_version_id)throw Error('书籍内容身份不匹配，无法精确定位');
 const segments=mapping.segments;
 if(!Array.isArray(segments))throw Error('缺少原文 segment 映射');
 const {start_codepoint:start,end_codepoint:end}=span;
 if(!Number.isInteger(start)||!Number.isInteger(end)||start<0||end<=start)throw Error('引用区间无效');
 const matches=segments.filter(x=>x.start_codepoint<=start&&x.end_codepoint>=end);
 if(matches.length!==1)throw Error('引用跨文件或映射不唯一，需要拆分为可核验引用');
 const segment=matches[0],chars=Array.from(segment.text??'');
 if(chars.length!==segment.end_codepoint-segment.start_codepoint)throw Error('原文 segment 长度不匹配');
 if(canonicalHref(segment.href)!==canonicalHref(span.href))throw Error('引用文件不匹配');
 const quote=chars.slice(start-segment.start_codepoint,end-segment.start_codepoint).join('');
 if(quote!==span.quote||await textHash(quote)!==span.text_hash)throw Error('引文或校验摘要不匹配');
 return {span,segment,start:start-segment.start_codepoint,end:end-segment.start_codepoint};
}
// The engine historically retains <head><title> in normalized source text.
// Preserve those authoritative coordinates, but never make a cross-head/body
// Range (which would also contain injected styles) look like visible prose.
export function mappedDisplay(doc,segment,start,end){
 const map=domTextMap(doc);
 if(map.text!==segment.text)throw Error('当前 EPUB 排版文本与引擎原文不一致，未执行精确高亮');
 if(start<0||end>map.points.length||start>=end)throw Error('DOM 区间无效');
 const inBody=node=>{for(let n=node;n;n=n.parentNode)if(n.localName?.toLowerCase()==='body')return true;return false;};
 let visibleStart=start,visibleEnd=end;
 while(visibleStart<end&&!(inBody(map.points[visibleStart].start.node)&&inBody(map.points[visibleStart].end.node)))visibleStart++;
 while(visibleEnd>visibleStart&&!(inBody(map.points[visibleEnd-1].start.node)&&inBody(map.points[visibleEnd-1].end.node)))visibleEnd--;
 if(visibleStart===visibleEnd)throw Error('引用仅含文档元信息，没有可定位的正文');
 const chars=(a,b)=>map.points.slice(a,b).map(p=>p.char).join('');
 const before=chars(start,visibleStart),body=chars(visibleStart,visibleEnd),after=chars(visibleEnd,end);
 const range=doc.createRange(),a=map.points[visibleStart].start,b=map.points[visibleEnd-1].end;
 range.setStart(a.node,a.offset);range.setEnd(b.node,b.offset);
 return {range,partialDisplay:visibleStart!==start||visibleEnd!==end,quoteParts:{before,body,after}};
}
export function mappedRange(doc,segment,start,end){
 const map=domTextMap(doc);
 if(map.text!==segment.text)throw Error('当前 EPUB 排版文本与引擎原文不一致，未执行精确高亮');
 if(start<0||end>map.points.length||start>=end)throw Error('DOM 区间无效');
 const range=doc.createRange(),a=map.points[start].start,b=map.points[end-1].end;
 range.setStart(a.node,a.offset);range.setEnd(b.node,b.offset);return range;
}
export function selectionCoordinates(doc,segment,range){
 const map=domTextMap(doc);if(map.text!==segment.text)throw Error('选文与原文映射不一致');
 // Point comparison avoids UTF-16/codepoint confusion and rejects partial surrogate selections.
 const compare=(point,node,offset)=>{const a=doc.createRange(),b=doc.createRange();a.setStart(point.node,point.offset);a.collapse(true);b.setStart(node,offset);b.collapse(true);return a.compareBoundaryPoints(0,b);};
 const start=map.points.findIndex(p=>compare(p.start,range.startContainer,range.startOffset)>=0);
 let end=map.points.length;while(end>0&&compare(map.points[end-1].end,range.endContainer,range.endOffset)>0)end--;
 if(start<0||end<=start)throw Error('选文没有可核验正文');
 // Browser paragraph selection can anchor at (element, 0) while the same
 // character begins at (firstTextNode, 0). They are different DOM boundary
 // points but the interval contains no text. Accept only this exact structural
 // equivalence; whitespace, skipped characters and half-surrogates still fail.
 const sameTextBoundary=(point,node,offset)=>{
  const order=compare(point,node,offset);if(order===0)return true;
  const gap=doc.createRange();
  if(order<0){gap.setStart(point.node,point.offset);gap.setEnd(node,offset);}
  else {gap.setStart(node,offset);gap.setEnd(point.node,point.offset);}
  return gap.toString()==='';
 };
 if(!sameTextBoundary(map.points[start].start,range.startContainer,range.startOffset)||!sameTextBoundary(map.points[end-1].end,range.endContainer,range.endOffset))throw Error('选文边界无法精确映射，请重新选择正文');
 return {href:segment.href,start_codepoint:segment.start_codepoint+start,end_codepoint:segment.start_codepoint+end,quote:map.points.slice(start,end).map(p=>p.char).join('')};
}
