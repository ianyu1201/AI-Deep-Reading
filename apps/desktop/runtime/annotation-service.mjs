import {readFile} from 'node:fs/promises';
import {join, isAbsolute} from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {writeAtomicJson} from './atomic-json-store.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const fail=(code,message)=>Object.assign(new Error(message),{code});
const clone=value=>structuredClone(value);
const canonical=href=>{try{return decodeURIComponent(new URL(href,'https://epub.invalid/').pathname).replace(/^\//,'');}catch{return null;}};
const styles=new Set(['yellow','purple','green']);
const id=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{8,120}$/.test(value);
/** One main-process writer. No knowledge, model, Apple Books or EPUB writes. */
export function createAnnotationService({root,library,beforeCommit=async()=>{}}){
 if(!isAbsolute(root)||!library?.get||!library?.getSourceMapping)throw Error('Annotation root and BookLibrary required');
 const file=join(root,'annotations-v1.json');let queue=Promise.resolve();
 async function load(){try{const value=JSON.parse(await readFile(file,'utf8'));if(value.schemaVersion!==1||!Array.isArray(value.records)||!value.requests)throw Error('schema');return value;}catch(error){if(error.code==='ENOENT')return {schemaVersion:1,records:[],requests:{}};throw fail('ANNOTATION_STORE_INVALID','标注存储无法读取，未覆盖已有记录');}}
 const commit=value=>writeAtomicJson({root,file,value,beforeCommit});
 const serial=fn=>{const next=queue.then(fn);queue=next.catch(()=>{});return next;};
 function note(value=''){if(typeof value!=='string'||value.length>30000)throw fail('INVALID_ANNOTATION_NOTE','备注长度无效');return value;}
 function style(value='yellow'){if(!styles.has(value))throw fail('INVALID_ANNOTATION_STYLE','标注样式无效');return value;}
 async function verify(p){
  const entry=await library.get(p.bookId);
  if(!entry||entry.bookVersionId!==p.bookVersionId)throw fail('ANNOTATION_VERSION_MISMATCH','原文版本不符，请保留旧标注并重新定位');
  if(!['section_order','start_codepoint','end_codepoint'].every(k=>Number.isSafeInteger(p[k])&&p[k]>=0)||p.end_codepoint<=p.start_codepoint||p.end_codepoint-p.start_codepoint>30000||typeof p.quote!=='string'||!p.quote.trim()||typeof p.href!=='string'||p.href.length>2000||hash(p.quote)!==p.text_hash)throw fail('INVALID_ANNOTATION_RANGE','选文为空或原文范围无效');
  const spanId=`sp_${entry.bookId}_${p.section_order}_${p.start_codepoint}_${p.end_codepoint}`;
  const mapping=await library.getSourceMapping(spanId),span=mapping?.span;
  if(!span?.ok||!span.verified||span.book_id!==entry.bookId||span.book_version_id!==p.bookVersionId||span.quote!==p.quote||span.text_hash!==p.text_hash||span.start_codepoint!==p.start_codepoint||span.end_codepoint!==p.end_codepoint||canonical(span.href)!==canonical(p.href))throw fail('ANNOTATION_SOURCE_MISMATCH','选文未通过原文核验，未保存');
  const matches=(mapping.segments??[]).filter(s=>s.start_codepoint<=p.start_codepoint&&s.end_codepoint>=p.end_codepoint);
  if(matches.length!==1)throw fail('ANNOTATION_CROSS_FILE','暂不支持跨文件标注，请在同一章节文件内选择');
  const s=matches[0],quote=Array.from(s.text??'').slice(p.start_codepoint-s.start_codepoint,p.end_codepoint-s.start_codepoint).join('');
  if(canonical(s.href)!==canonical(p.href)||quote!==p.quote||Array.from(s.text??'').length!==s.end_codepoint-s.start_codepoint)throw fail('ANNOTATION_SOURCE_MISMATCH','原文文件映射不一致，未保存');
  return {entry,mapping};
 }
 async function mutate(op,input,apply){
  const p=clone(input??{});if(!id(p.request_id))throw fail('INVALID_ANNOTATION_REQUEST','标注请求标识无效');
  const data=await load(),fingerprint=hash(JSON.stringify({op,...p})),old=data.requests[p.request_id];
  if(old){if(old.fingerprint!==fingerprint)throw fail('ANNOTATION_IDEMPOTENCY_CONFLICT','同一请求不能用于不同标注内容');return clone({...old.result,replayed:true});}
  const result=await apply(data,p);data.requests[p.request_id]={fingerprint,result:clone(result)};await commit(data);return result;
 }
 function getRecord(data,p){if(!id(p.id))throw fail('ANNOTATION_NOT_FOUND','标注不存在');const record=data.records.find(x=>x.id===p.id);if(!record)throw fail('ANNOTATION_NOT_FOUND','标注不存在');if(p.revision!==record.revision)throw fail('ANNOTATION_CONFLICT','标注已经更新，草稿保留，请刷新后重试');return record;}
 const project=(r,entry,version)=>({...clone(r),status:!entry?'unresolved':entry.bookVersionId!==r.bookVersionId||version&&version!==r.bookVersionId?'unresolved':'available',statusReason:!entry?'book-unavailable':entry.bookVersionId!==r.bookVersionId||version&&version!==r.bookVersionId?'version-mismatch':null});
 return {
  list:({bookId,bookVersionId,includeDeleted=false}={})=>serial(async()=>{if(typeof bookId!=='string')throw fail('INVALID_ANNOTATION_BOOK','缺少书籍身份');const data=await load(),entry=await library.get(bookId);return data.records.filter(r=>r.bookId===bookId&&(includeDeleted||!r.deleted_at)).map(r=>project(r,entry,bookVersionId));}),
  create:input=>serial(()=>mutate('create',input,async(data,p)=>{
   const {entry,mapping}=await verify(p);const now=new Date().toISOString();
   const record={id:'ann_'+randomUUID(),bookId:entry.id,bookVersionId:entry.bookVersionId,archive_sha256:entry.archiveSha256??null,span:clone(mapping.span),chapterTitle:typeof mapping.title==='string'?mapping.title:null,cfi:typeof p.cfi==='string'&&p.cfi.length<4000?p.cfi:null,style:style(p.style),note:note(p.note),revision:1,created_at:now,updated_at:now,deleted_at:null};
   data.records.push(record);return clone(record);
  })),
  update:input=>serial(()=>mutate('update',input,async(data,p)=>{const r=getRecord(data,p);if(r.deleted_at)throw fail('ANNOTATION_DELETED','标注已移除，请先撤销移除');r.note=note(p.note);if(p.style!==undefined)r.style=style(p.style);r.revision++;r.updated_at=new Date().toISOString();return clone(r);})),
  remove:input=>serial(()=>mutate('remove',input,async(data,p)=>{if(p.confirmed!==true)throw fail('ANNOTATION_CONFIRM_REQUIRED','移除标注需要明确确认');const r=getRecord(data,p);if(r.deleted_at)throw fail('ANNOTATION_DELETED','标注已经移除');r.deleted_at=r.updated_at=new Date().toISOString();r.revision++;return clone(r);})),
  restore:input=>serial(()=>mutate('restore',input,async(data,p)=>{const r=getRecord(data,p);if(!r.deleted_at)throw fail('ANNOTATION_NOT_DELETED','标注没有被移除');r.deleted_at=null;r.updated_at=new Date().toISOString();r.revision++;return clone(r);})),
  locate:({id:annotationId}={})=>serial(async()=>{const data=await load(),r=data.records.find(x=>x.id===annotationId&&!x.deleted_at);if(!r)throw fail('ANNOTATION_NOT_FOUND','标注不存在');const {mapping}=await verify({bookId:r.bookId,bookVersionId:r.bookVersionId,...r.span});return {record:clone(r),mapping};}),
  flush:()=>queue,
 };
}
