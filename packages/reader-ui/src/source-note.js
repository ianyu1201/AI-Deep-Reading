// UI eligibility only. The main process re-reads the formal note and re-verifies
// its registered book/version/span before opening original text.
export function noteSources(note){
 if(!note?.id||note.deleted||!Array.isArray(note.data?.book_evidence))return [];
 const seen=new Set();
 return note.data.book_evidence.filter(ref=>{
  if(!ref||typeof ref.book_id!=='string'||!/^[a-f0-9]{16}$/.test(ref.book_id)||typeof ref.book_version_id!=='string'||!ref.book_version_id||typeof ref.span_id!=='string'||!new RegExp('^sp_'+ref.book_id+'_\\d+_\\d+_\\d+$').test(ref.span_id)||typeof ref.href!=='string'||!ref.href||!Number.isSafeInteger(ref.start_codepoint)||!Number.isSafeInteger(ref.end_codepoint)||ref.start_codepoint<0||ref.end_codepoint<=ref.start_codepoint||typeof ref.text_hash!=='string'||!/^[a-f0-9]{64}$/.test(ref.text_hash)||seen.has(ref.span_id))return false;
  seen.add(ref.span_id);return true;
 }).map(({span_id,href,book_id,book_version_id})=>Object.freeze({span_id,href,book_id,book_version_id}));
}
export async function openNoteSource({note,spanId,composing,persist,request}){
 if(composing)throw Error('请先完成输入法组合后查看原文');
 if(!noteSources(note).some(ref=>ref.span_id===spanId))throw Error('当前笔记没有这条可用来源');
 if(!persist())throw Error('草稿尚未保留，请先导出或解决保存问题');
 const result=await request({noteId:note.id,spanId});
 if(result?.ok===false)throw Error(result.message??'原文无法定位');
 return result;
}
