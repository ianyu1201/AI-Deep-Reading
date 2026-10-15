import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createFileService} from '../../../dsh-apple-read/lib/reading/file-service.js';
import {BOOK_DOMAIN} from '../../../dsh-apple-read/lib/reading/book-domain.js';
import {composeNote} from '../../../dsh-apple-read/lib/reading/schema.js';
import {createNoteService} from './note-service.mjs';
const ISO='2026-10-10T09:00:00Z';
const data={schema_version:'1.1',object_type:'insight',id:'in_test',revision:1,title:'洞见',tags:['reading','knowledge'],scope:'reading',knowledge_status:'active',created_at:ISO,updated_at:ISO,origin:'user',confirmation:'unconfirmed',confirmation_evidence:null,book_evidence:[{book_id:'bk_1',book_version_id:'bv_1',section_id:'sec_1',block_id:'bl_1',span_id:'sp_1',href:'Text/1.xhtml',start_codepoint:0,end_codepoint:3,text_hash:'a'.repeat(64),locator_quality:'exact_normalized_text',quote_type:'paraphrase'}],session_evidence:[],external_master:{status:'unverified',outcome:'not_authorized',check_id:'dc_1',scope_refs:[],checked_at:null,authorization_revision:'consent_1',candidate_refs:[],ref:null},dedup_check_ref:'dc_1'};
test('formal existing note roundtrip, replay, conflict, YAML, managed blocks and scope',async()=>{
 const root=await mkdtemp(join(tmpdir(),'reading-notes-'));try{
 await mkdir(join(root,'理解变化'));const id='理解变化/洞见.md';await writeFile(join(root,id),composeNote(data,'原文\n'));
 const fs=await createFileService({root});let invalidations=0;const svc=createNoteService({fileService:fs,domain:BOOK_DOMAIN,onSaved:()=>invalidations++});
 const initial=await svc.read(id);assert.equal(initial.readOnly,false);assert.equal((await svc.list()).notes.length,1);
 const request={id,base_hash:initial.base_hash,body:'编辑后中文\n',request_id:'save-request-01'};
 const saved=await svc.save(request);assert.equal(saved.body,request.body);assert.equal(saved.data.revision,2);assert.equal(saved.data.confirmation,'unconfirmed');assert.deepEqual(saved.data.book_evidence,data.book_evidence);assert.equal(invalidations,1);
 assert.equal((await svc.save(request)).base_hash,saved.base_hash);assert.equal(invalidations,1);
 assert.equal((await svc.search('编辑后')).notes.length,1);
 const restart=createNoteService({fileService:await createFileService({root}),domain:BOOK_DOMAIN});assert.equal((await restart.read(id)).body,request.body);
 await writeFile(join(root,id),composeNote({...data,revision:3},'外部修改\n'));
 await assert.rejects(()=>svc.save({...request,request_id:'save-request-02'}),{code:'NOTE_CONFLICT'});assert.match(await readFile(join(root,id),'utf8'),/外部修改/);
 await assert.rejects(()=>svc.save(request),{code:'NOTE_CONFLICT'});
 await writeFile(join(root,id),'---\nbad: [\n---\n正文');assert.equal((await svc.read(id)).readOnly,true);const bad=await svc.read(id);await assert.rejects(()=>svc.save({id,base_hash:bad.base_hash,body:'不丢草稿',request_id:'save-bad-yaml'}),{code:'INVALID_NOTE_SCHEMA'});
 const block='<!-- reading-index:books:start -->\n自动区\n<!-- reading-index:books:end -->';await writeFile(join(root,id),composeNote(data,'前言\n'+block));const managed=await svc.read(id);
 await assert.rejects(()=>svc.save({id,base_hash:managed.base_hash,body:'删除全部',request_id:'save-managed-01'}),{code:'MANAGED_REGION_CHANGED'});
 await svc.save({id,base_hash:managed.base_hash,body:'改前言\n'+block,request_id:'save-managed-02'});
 await assert.rejects(()=>svc.read('../escape.md'),{code:'INVALID_NOTE_PATH'});await symlink('/etc/hosts',join(root,'outside.md'));await assert.rejects(()=>svc.read('outside.md'));
 assert.equal((await svc.list()).notes.length,1);
 const beforeBarrier=await svc.read(id);await fs.addDeletionBarrier({scopeId:'blocked_test',pathPrefixes:['理解变化']});await assert.rejects(()=>svc.save({id,base_hash:beforeBarrier.base_hash,body:beforeBarrier.body+'新内容',request_id:'barrier-save-01'}),{code:'DELETION_BARRIER'});assert.equal((await svc.read(id)).base_hash,beforeBarrier.base_hash);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('display projection retains storage identity and hierarchy without touching source',async()=>{
 const root=await mkdtemp(join(tmpdir(),'reading-note-projection-'));try{
 const folder='书籍/原始书名｜作者/读书笔记/第一章';await mkdir(join(root,folder),{recursive:true});const id=folder+'/技术名_abcdef0123456789.md';const body='## 用户判断\n\n原始内容不变\n';await writeFile(join(root,id),composeNote({...data,title:'理解反馈回路'},body));
 const svc=createNoteService({fileService:await createFileService({root}),domain:BOOK_DOMAIN});const before=await readFile(join(root,id),'utf8');const n=await svc.read(id);
 assert.equal(n.id,id);assert.equal(n.name,'技术名_abcdef0123456789');assert.equal(n.folder,folder);assert.equal(n.displayFolder,folder);assert.equal(n.bookRelativeFolder,'读书笔记/第一章');assert.equal(n.displayTitle,'理解反馈回路');assert.equal(n.body,body);assert.equal((await svc.search('理解反馈回路')).notes[0].id,id);assert.equal(await readFile(join(root,id),'utf8'),before);
 }finally{await rm(root,{recursive:true,force:true});}
});
