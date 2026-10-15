import {readdir, readFile} from 'node:fs/promises';
import {join, dirname, basename} from 'node:path';
import {createHash} from 'node:crypto';
import {notePresentation} from './note-presentation.mjs';
import {validateNote} from '../../../dsh-apple-read/lib/reading/schema.js';

const hash=s=>createHash('sha256').update(s).digest('hex');
const fail=(code,message,details)=>Object.assign(new Error(message),{code,details});
function managed(body){
 const re=/<!-- reading-index:([a-z]+):(start|end) -->/g; const blocks=[];let open=null;
 for(const m of body.matchAll(re)){
  if(m[2]==='start'){if(open)throw fail('MANAGED_REGION_INVALID','受管区标记不完整');open=m;}
  else{if(!open||open[1]!==m[1])throw fail('MANAGED_REGION_INVALID','受管区标记不匹配');blocks.push(body.slice(open.index,m.index+m[0].length));open=null;}
 }if(open)throw fail('MANAGED_REGION_INVALID','受管区缺少结束标记');return blocks;
}
/** Inject the SAME file-service used by reading runtime; never creates a second writer. */
export function createNoteService({fileService:fs,domain,onSaved=async()=>{}}){
 if(!fs?.readNote||!fs?.commit||!domain)throw new Error('Shared file service and domain required');
 const scope=hash(fs.root).slice(0,24);let queue=Promise.resolve();
 function path(id){if(typeof id!=='string'||id.length>1024||!id.endsWith('.md')||id.startsWith('/')||id.split('/').some(x=>!x||x==='.'||x==='..'||x.startsWith('.'))||id.includes('\\'))throw fail('INVALID_NOTE_PATH','只允许知识目录中的既有 Markdown');return id;}
 async function read(id){id=path(id);const n=await fs.readNote(id);if(!n.exists)throw fail('NOTE_NOT_FOUND','笔记已不存在');const check=validateNote(n.data,{domain});const identity={id,name:basename(id,'.md'),folder:dirname(id)==='.'?'':dirname(id)};return {...identity,...notePresentation({...identity,data:n.data}),body:n.body,base_hash:n.hash,data:n.data,readOnly:!!n.errors.length||!check.ok,errors:[...n.errors,...check.errors],scope};}
 async function list(){const notes=[];async function walk(rel=''){for(const ent of await readdir(join(fs.root,rel),{withFileTypes:true})){if(ent.name.startsWith('.')||ent.isSymbolicLink())continue;const id=rel?rel+'/'+ent.name:ent.name;if(ent.isDirectory())await walk(id);else if(ent.isFile()&&id.endsWith('.md')){try{notes.push(await read(id));}catch(error){if(error.code!=='NOTE_NOT_FOUND')throw error;}}}}await walk();return {scope,notes};}
 async function save(input){
  const {id:raw,base_hash,body,request_id}=input??{};const id=path(raw);
  if(typeof body!=='string'||Buffer.byteLength(body)>5*1024*1024||typeof base_hash!=='string'||!/^[a-f0-9]{64}$/.test(base_hash)||typeof request_id!=='string'||!/^[a-zA-Z0-9_-]{8,100}$/.test(request_id))throw fail('INVALID_NOTE_SAVE','保存请求无效');
  const fingerprint=hash(JSON.stringify({id,base_hash,body}));const key='desktop-note:'+request_id;
  const old=await fs.findByIdempotencyKey(key);
  if(old){if(old.input_fingerprint!==fingerprint&&old.inputFingerprint!==fingerprint)throw fail('IDEMPOTENCY_CONFLICT','请求标识已用于不同内容');if(old.state!=='committed')throw fail('RECOVERY_REQUIRED','上次保存事务尚未完成，需要先恢复事务');const drift=await fs.findCommittedDrift(old);if(drift?.length)throw fail('NOTE_CONFLICT','已保存文件后来发生变化');return read(id);}
  const n=await read(id);
  if(n.base_hash!==base_hash)throw fail('NOTE_CONFLICT','文件已被外部修改，草稿保留，请对照磁盘版本合并',{disk:n});
  if(n.readOnly)throw fail('INVALID_NOTE_SCHEMA','YAML 或正式对象合同无效，正文草稿仍可保留');
  if(JSON.stringify(managed(n.body))!==JSON.stringify(managed(body)))throw fail('MANAGED_REGION_CHANGED','索引受管区不能通过正文编辑改写');
  const {abs}=await fs.resolveRel(id);const original=await readFile(abs,'utf8');
  if(hash(original)!==base_hash)throw fail('NOTE_CONFLICT','文件已发生变化');
  // Preserve untouched YAML bytes (comments, ordering, source and confirmation fields).
  const header=original.slice(0,original.length-n.body.length);
  const revision=(n.data.revision??0)+1, now=new Date().toISOString();
  const nextHeader=header.replace(/^revision:[^\r\n]*$/m,'revision: '+revision).replace(/^updated_at:[^\r\n]*$/m,'updated_at: '+JSON.stringify(now));
  const validation=validateNote({...n.data,revision,updated_at:now},{domain});if(!validation.ok)throw fail('INVALID_NOTE_SCHEMA','修订后的元数据未通过正式合同');
  const result=await fs.commit({purpose:'update_note',idempotencyKey:key,inputFingerprint:fingerprint,targets:[{path:id,kind:'update',content:nextHeader+body,expectedBeforeHash:base_hash}]});
  if(result.state!=='committed')throw fail('NOTE_SAVE_INCOMPLETE','文件事务尚未提交');
  await onSaved(id);return read(id);
 }
 return {list,read,search:async query=>{if(typeof query!=='string'||query.length>1000)throw fail('INVALID_SEARCH','检索条件无效');const r=await list();return {...r,notes:r.notes.filter(n=>(n.name+' '+n.displayTitle+' '+n.body).toLowerCase().includes(query.toLowerCase()))};},save:input=>{const next=queue.then(()=>save(input));queue=next.catch(()=>{});return next;}};
}
