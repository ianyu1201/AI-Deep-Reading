import {readFile} from 'node:fs/promises';
import {isAbsolute,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {writeAtomicJson} from './atomic-json-store.mjs';

/** Position-only local records. No annotation, knowledge, model or Apple writes. */
export function createBookmarkService({root,library,beforeCommit=async()=>{}}){
 if(!isAbsolute(root)||!library?.get)throw Error('Bookmark storage requires a trusted root and library');
 const file=join(root,'bookmarks-v1.json');let queue=Promise.resolve();
 const serial=fn=>{const next=queue.then(fn);queue=next.catch(()=>{});return next;};
 async function load(){try{const data=JSON.parse(await readFile(file,'utf8'));if(data.version!==1||!Array.isArray(data.records))throw Error('schema');return data;}catch(e){if(e.code==='ENOENT')return {version:1,records:[]};throw Error('书签存储无法读取，原记录未改动');}}
 const commit=value=>writeAtomicJson({root,file,value,beforeCommit});
 async function entry(p){const book=await library.get(p.bookId);if(!book||book.bookVersionId!==p.bookVersionId)throw Error('书籍版本已变化，书签保留但无法定位');return book;}
 function position(p){if(typeof p.cfi!=='string'||p.cfi.length>4000||!/^epubcfi\([^\r\n]+\)$/.test(p.cfi)||typeof p.href!=='string'||!p.href||p.href.length>2000||/^(?:https?:|file:)|\.\./i.test(p.href))throw Error('书签位置无效');if(typeof p.chapter!=='string'||p.chapter.length>300)throw Error('书签章节无效');}
 const project=(r,b)=>({...r,status:b&&b.bookVersionId===r.bookVersionId?'available':'unresolved'});
 return {
  list:p=>serial(async()=>{const data=await load(),b=await library.get(p.bookId);return data.records.filter(r=>r.bookId===p.bookId&&!r.deletedAt).map(r=>project(r,b));}),
  add:p=>serial(async()=>{await entry(p);position(p);const data=await load();const existing=data.records.find(r=>r.bookId===p.bookId&&r.bookVersionId===p.bookVersionId&&r.cfi===p.cfi);if(existing&&!existing.deletedAt)return {...existing,status:'available'};const now=new Date().toISOString();const record=existing??{id:'bm_'+randomUUID(),bookId:p.bookId,bookVersionId:p.bookVersionId,cfi:p.cfi,href:p.href,chapter:p.chapter,createdAt:now};record.deletedAt=null;record.updatedAt=now;if(!existing)data.records.push(record);await commit(data);return {...record,status:'available'};}),
  remove:p=>serial(async()=>{const data=await load(),r=data.records.find(x=>x.id===p.id&&x.bookId===p.bookId);if(!r)throw Error('书签不存在');if(!r.deletedAt){r.deletedAt=new Date().toISOString();await commit(data);}return {ok:true};}),
  locate:p=>serial(async()=>{const data=await load(),r=data.records.find(x=>x.id===p.id&&x.bookId===p.bookId&&!x.deletedAt);if(!r)throw Error('书签不存在');await entry(r);position(r);return {...r};}),
  flush:()=>queue,
 };
}
