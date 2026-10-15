// Explicitly authorized real-model check. No authentication bytes are read or copied.
// The official CLI uses an existing login home and may normally refresh its
// authentication/cache/runtime state. Business data and synthetic books stay
// temporary; production RuntimeManager and Codex isolation are not modified.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,lstat,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';

const root=resolve(import.meta.dirname,'../../..');
if(process.argv.length!==4)throw Error('Usage: ai-release-smoke.mjs <candidate.app> <dist/evidence.json>');
const appPath=resolve(process.argv[2]);
const output=resolve(process.argv[3]);
const outputRelative=relative(join(root,'dist'),output);
if(outputRelative.startsWith('..')||isAbsolute(outputRelative))throw Error('Evidence must stay inside this checkout dist directory');
if(process.env.AI_READING_AI_SMOKE!=='1')throw Error('Set AI_READING_AI_SMOKE=1 only after explicit real-model authorization');
const requestedAuthHome=process.env.AI_READING_CODEX_HOME;
if(!requestedAuthHome||!isAbsolute(requestedAuthHome))throw Error('Explicit existing AI_READING_CODEX_HOME is required; credentials are never copied');
const authHome=await realpath(requestedAuthHome);
const preflightOnly=process.env.AI_READING_AI_SMOKE_PREFLIGHT==='1';
assert.equal((await lstat(join(authHome,'auth.json'))).isFile(),true,'Existing official CLI login is required');
const resources=join(appPath,'Contents/Resources');
const appSource=join(resources,'app');
const nodePath=join(resources,'runtimes/node/bin/node');
const pythonPath=join(resources,'runtimes/python/bin/python3');
const codexPath=join(resources,'runtime/codex/bin/codex');
for(const path of [nodePath,pythonPath,codexPath])assert.equal((await lstat(path)).isFile(),true,'Bundled runtime is required');
const directory=await mkdtemp(join(tmpdir(),'reading-ai-release-'));
const dataDir=join(directory,'data');
const isolatedHome=join(directory,'home');
await Promise.all([dataDir,isolatedHome].map(path=>mkdir(path,{recursive:true,mode:0o700})));
const originalEnvironment={...process.env};
const report={passed:false,kind:preflightOnly?'packaged-real-Harness-Codex-auth-preflight':'packaged-real-Harness-Codex-single-prompt',startedAt:new Date().toISOString(),userPromptsSent:0,realModelResponseVerified:false,syntheticDataOnly:true,authenticationReadByTest:false,authenticationCopied:false,authHomeWritesDenied:false,officialCliStateMayUpdate:true,independentHome:false,independentBusinessData:true,codexThreadsEphemeral:true,logsAndSqliteRedirected:false,testOnlySpawnHook:false,productionIsolationArgumentsPreserved:true,dynamicModelToolCalls:0,checks:[]};
let manager,failure;
const events=[];
const hash=value=>createHash('sha256').update(value).digest('hex');
async function until(predicate,label,timeoutMs=180000){
 const deadline=Date.now()+timeoutMs;
 while(Date.now()<deadline){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,50));}
 throw Object.assign(Error('AI smoke deadline exceeded'),{code:label});
}
try{
 // Only business data is isolated; the existing official login is used normally.
 Object.assign(process.env,{PATH:'/usr/bin:/bin',AI_READING_CODEX_HOME:authHome,AI_READING_CODEX:codexPath,AI_READING_PYTHON:pythonPath,AI_READING_USE_HOST_MODEL:'1',PYTHONDONTWRITEBYTECODE:'1'});
 delete process.env.AI_READING_DISABLE_AI;
 const {RuntimeManager}=await import(pathToFileURL(join(appSource,'apps/desktop/runtime/manager.mjs')));
 const {BookLibrary}=await import(pathToFileURL(join(appSource,'packages/book-library/index.mjs')));
 const {composeNote}=await import(pathToFileURL(join(appSource,'dsh-apple-read/lib/reading/schema.js')));
 const marker='AI_RELEASE_OK_'+randomBytes(6).toString('hex').toUpperCase();
 const epub=join(directory,'synthetic.epub');
 const buildBook='import sys,zipfile\npath,marker=sys.argv[1:]\nwith zipfile.ZipFile(path,"w") as z:\n z.writestr("mimetype","application/epub+zip")\n z.writestr("META-INF/container.xml",\'<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>\')\n z.writestr("book.opf",\'<package><metadata><title>Isolated AI release check</title></metadata><manifest><item id="c" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c"/></spine></package>\')\n z.writestr("chapter.xhtml","<html><body><h1>Synthetic chapter</h1><p>The validation marker is "+marker+".</p>"+"<p>This is original synthetic test material for reading, source attachment and an isolated model response. It contains no personal books or user knowledge.</p>"*12+"</body></html>")\n';
 const generated=spawnSync(pythonPath,['-B','-I','-c',buildBook,epub,marker],{encoding:'utf8',env:{PATH:'/usr/bin:/bin',HOME:isolatedHome,PYTHONDONTWRITEBYTECODE:'1'}});
 assert.equal(generated.status,0,'Synthetic EPUB creation failed');
 const library=new BookLibrary({root:join(dataDir,'library'),pythonPath});
 const book=await library.importFile(epub);
 const chapter=await library.getSourceChapter(book.id,'chapter.xhtml');
 const segment=chapter.segments[0];
 const spanId=`sp_${book.bookId}_${chapter.chapterOrder}_${segment.start_codepoint}_${segment.end_codepoint}`;
 const mapping=await library.getSourceMapping(spanId);
 assert.equal(mapping.span.verified,true);assert.ok(mapping.span.quote.includes(marker));
 report.checks.push('bundled-Python-imports-synthetic-EPUB-and-verifies-source-mapping');
 const noteId='理解变化/合成发布验收.md',noteDirectory=join(dataDir,'knowledge/45-书籍/理解变化');
 const now=new Date().toISOString();
 const noteData={schema_version:'1.1',object_type:'insight',id:'in_ai_release_smoke',revision:1,title:'合成发布验收',tags:['reading','knowledge'],scope:'reading',knowledge_status:'active',created_at:now,updated_at:now,origin:'user',confirmation:'unconfirmed',confirmation_evidence:null,book_evidence:[{book_id:book.bookId,book_version_id:book.bookVersionId,section_id:`sec_${book.bookId}_${chapter.chapterOrder}`,block_id:'bl_ai_release',span_id:spanId,href:'chapter.xhtml',start_codepoint:segment.start_codepoint,end_codepoint:segment.end_codepoint,text_hash:hash(mapping.span.quote),locator_quality:'exact_normalized_text',quote_type:'paraphrase'}],session_evidence:[],external_master:{status:'unverified',outcome:'not_authorized',check_id:'dc_ai_release',scope_refs:[],checked_at:null,authorization_revision:'consent_synthetic',candidate_refs:[],ref:null},dedup_check_ref:'dc_ai_release'};
 await mkdir(noteDirectory,{recursive:true});await writeFile(join(noteDirectory,'合成发布验收.md'),composeNote(noteData,'合成笔记初稿。\n'));
 manager=new RuntimeManager({dataDir,nodePath,readyTimeoutMs:60000});
 manager.on('session-event',event=>events.push(event));
 const state=await manager.start();
 report.runtimeModelStatus=state.model;
 assert.equal(state.model?.available,true,'Existing login or production isolation is unavailable; no model prompt sent');
 assert.equal(state.model.isolationVerified,true);assert.equal(state.model.authType,'chatgpt');
 report.model=state.model.model;report.checks.push('bundled-Harness-ready-with-existing-ChatGPT-login-and-production-isolation');
 if(!preflightOnly){
 const scope={kind:'book',bookId:book.bookId};
 const session=await manager.call('sessions:create',{scope,title:'隔离 AI 发布验收'});
 const payload={scope,sessionId:session.sessionId};
 await manager.call('business:authorize-search',{bookId:book.id,sessionId:session.sessionId,enabled:false});
 await manager.call('business:prepare',{bookId:book.id,sessionId:session.sessionId,spanId});
 const attached=await manager.call('business:attachment',{bookId:book.id,sessionId:session.sessionId});
 assert.equal(attached.span.span_id,spanId);assert.equal(attached.searchAuthorized,false);
 const beforeNote=await manager.call('notes:read',{id:noteId});assert.equal(beforeNote.readOnly,false);
 const noteBody='合成笔记已通过真实运行时显式保存。\n';
 const saved=await manager.call('notes:save',{id:noteId,base_hash:beforeNote.base_hash,body:noteBody,request_id:'ai-release-note-save'});
 assert.equal(saved.body,noteBody);assert.equal(saved.data.revision,2);
 assert.equal((await manager.call('notes:search',{query:'真实运行时显式保存'})).notes.length,1);
 report.checks.push('book-session-source-attachment-and-real-note-save-search-with-model-tools-disabled');
 const eventStart=events.length;
 const sent=await manager.call('sessions:prompt',{...payload,text:'This is an isolated synthetic release test. From the explicitly attached original source, return only its validation marker, with no commentary. Do not call tools. Do not use any other files or sources.'});
 report.userPromptsSent++;
 await until(()=>events.slice(eventStart).some(event=>event.type==='turn-complete'&&event.sessionId===session.sessionId),'MODEL_TURN_TIMEOUT');
 const turnEvents=events.slice(eventStart).filter(event=>event.sessionId===session.sessionId);
 assert.equal(turnEvents.find(event=>event.type==='turn-complete').outcome,'completed');
 const history=await manager.call('sessions:history',payload);
 assert.equal(history.messages.filter(message=>message.role==='user').length,1);
 const user=turnEvents.find(event=>event.type==='message'&&event.message.role==='user');assert.equal(user.message.id,sent.messageId);
 const assistant=turnEvents.find(event=>event.type==='message'&&event.message.role==='assistant');
 assert.ok(assistant?.message.text.includes(marker),'Real response must recover the marker supplied only in the attached source');
 const deltas=turnEvents.filter(event=>event.type==='text-delta'&&event.messageId===assistant.messageId);
 assert.ok(deltas.length);assert.equal(deltas.map(event=>event.text).join(''),assistant.message.text);
 report.assistantChars=assistant.message.text.length;report.streamChunks=deltas.length;
 report.realModelResponseVerified=true;
 report.checks.push('one-real-model-response-uses-attached-synthetic-source-and-stream-equals-durable-message');
 await manager.restart();
 assert.deepEqual((await manager.call('sessions:resume',payload)).messages,history.messages);
 assert.equal((await manager.call('notes:read',{id:noteId})).body,noteBody);
 report.checks.push('bundled-runtime-restart-restores-the-same-conversation-and-saved-note');
 }
 await manager.stop();manager=null;
 report.passed=true;
}catch(error){
 failure=error;report.failure={code:error.code??'AI_SMOKE_FAILED',stage:report.checks.length};
 // Local bridge assertions can contain paths or synthetic protocol payloads.
 // Persist a code and stage only; never persist raw model/CLI exceptions.
}finally{
 try{await manager?.stop();}catch{report.cleanupFailed=true;report.passed=false;failure??=Error('Runtime cleanup failed');}
 for(const key of Object.keys(process.env))if(!(key in originalEnvironment))delete process.env[key];
 Object.assign(process.env,originalEnvironment);
 await rm(directory,{recursive:true,force:true});
 await mkdir(resolve(output,'..'),{recursive:true});
 await writeFile(output,JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report,null,2));
}
if(failure)process.exitCode=1;
