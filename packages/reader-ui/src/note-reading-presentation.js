/** Fold known generated bookkeeping in a rendered preview, never alter Markdown source.
 * Unknown/user-authored sections are kept intact. No HTML is accepted by this adapter.
 */
export function foldNoteDiagnostics(root, note, document=root.ownerDocument){
 if(!note.data?.object_type)return;
 const details=document.createElement('details');details.className='note-diagnostics';
 const summary=document.createElement('summary');summary.textContent='来源校验与记录详情';details.append(summary);
 // Generated locator rows: require the exact prefix AND technical keys, not arbitrary text.
 for(const list of [...root.querySelectorAll('ul')]){
  for(const row of [...list.children]){
   const text=row.textContent.trim();
   if((/^定位：章节/.test(text)&&/Unicode codepoint/.test(text))||(/^span_id:/.test(text)&&/text_hash/.test(text))||(/^书身份：/.test(text)&&/book_version_id/.test(text))||(/^书内块：/.test(text)&&/block_id/.test(text))){
    let target=details.querySelector('ul');if(!target){target=document.createElement('ul');details.append(target)}target.append(row);
   }
  }if(!list.children.length)list.remove();
 }
 for(const heading of [...root.querySelectorAll('h2,h3')]){
  if(!/^五类证据标签（/.test(heading.textContent)&&heading.textContent!=='来源校验详情')continue;
  const level=Number(heading.tagName.slice(1));let cursor=heading.nextElementSibling;const section=[heading];
  while(cursor&&!(/^H[1-6]$/.test(cursor.tagName)&&Number(cursor.tagName.slice(1))<=level)){section.push(cursor);cursor=cursor.nextElementSibling}
  details.append(...section);
 }
 // Preserve the exact legacy message while presenting its readable meaning up front.
 for(const p of [...root.children])if(p.tagName==='P'&&p.textContent.startsWith('【原来的判断：')&&p.textContent.includes('before_source_refs')){
  const readable=document.createElement('p');readable.textContent='原来的判断尚未记录。以下保留这次的表达，不据此推断已经掌握。';p.before(readable);details.append(p);
 }
 if(details.children.length>1)root.append(details);
}
