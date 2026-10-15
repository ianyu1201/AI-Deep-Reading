import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GuideGeneration,VERSION} from './index.mjs';
import {apply} from '../../apps/desktop/runtime/business-bridge.mjs';
const digest='a'.repeat(16),book={id:'book_'+digest,bookId:digest,bookVersionId:'bv_test',title:'隔离合成书',enginePath:'/synthetic'};
const text='反馈决定行为，约束影响目标。';
const analysis={content_id:digest,chapters:[{section_id:'sec_a',section_order:0,chars:Array.from(text).length,title:'反馈'}],windows:[{window_id:'w1',section_id:'sec_a',consumed:true}],slices:[],candidates:[]};
const output=p=>p.stage==='coverage'?{missing_topics:[]}:p.stage==='verify'?structuredClone(p.input.draft):p.stage==='book'?{overview_paragraphs:[{text:'反馈影响系统行为。',source_refs:[p.input.sources[0].ref]}],recommendations:[{section_id:'sec_a',title:'反馈',reason:'考察反馈。',value_score:3,source_refs:[p.input.sources[0].ref]}]}:{kind:'body',summary:'反馈影响系统行为。',claims:[{text:'反馈影响行为',source_refs:[p.input.sources[0].ref]}]};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function fixture(generate=async p=>output(p)){
 const root=await mkdtemp(join(tmpdir(),'guide-risk-')),library={root,get:async()=>book,engineRequest:async()=>new Response(JSON.stringify({ok:true,book_version_id:book.bookVersionId,span:{ok:true,book_version_id:book.bookVersionId,quote:text},segments:[{href:'chapter.xhtml',start_codepoint:0,end_codepoint:Array.from(text).length,text}]}))};
 const service=new GuideGeneration({root:join(root,'guide-cache'),library,generate,model:'isolated-fake'});
 return {root,library,service,close:()=>rm(root,{recursive:true,force:true})};
}
async function bridge(h,{analyzeAndPersist=async()=>({ok:true}),versionRef=()=>null,flush=async()=>{}}={}){
 let execute;const ctx={desktopReading:{ready:Promise.resolve(),library:h.library,store:{flush,data:{}},generateStructured:async()=>{throw Error('No model allowed');},reading:{fileService:async()=>({ok:true,svc:{root:h.root,readNote:async()=>({exists:false}),commit:async()=>{}}}),analyzeAndPersist,recommendations:async()=>({ok:true,result:{policy_and_model_metadata:{prompt_template_version:versionRef()}}}),understandingStatus:async()=>({}),evidenceNotes:async()=>({ok:true,notes:[]})}},readingSessionsReady:{},tools:{register(){}},webServer:{register:()=>()=>{}},effect:fn=>fn(),provide:(name,value)=>{if(name==='desktopBusinessReady')execute=value.execute;}};
 await apply(ctx);return execute;
}
test('model extras cannot replace section identity, coverage, generation metadata or source map',async()=>{
 const h=await fixture(async p=>({...output(p),section_id:'forged',section_order:666,version:'forged',model:'forged',book_version_id:'forged',generation_id:'forged',status:'forged',coverage:{body_sections:['forged']},sources:{forged:{}}}));
 try{const {generated:g}=await h.service.generateAnalysis(book,analysis);assert.equal(g.version,VERSION);assert.equal(g.model,'isolated-fake');assert.equal(g.book_version_id,book.bookVersionId);assert.equal(g.status,'ready');assert.equal(g.chapters[0].section_id,'sec_a');assert.deepEqual(g.coverage.body_sections,['sec_a']);assert.match(g.generation_id,/^[a-f0-9]{64}$/);assert.ok(!g.sources.forged);}finally{await h.close();}
});
test('cancel during a running model stage rejects and preserves previously committed guide',async()=>{
 const h=await fixture();try{const first=await h.service.generateAnalysis(book,analysis);await h.service.commit(book);const started=deferred();h.service.model='second-synthetic-model';h.service.generate=async(_p,{signal})=>{started.resolve();return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));};const ac=new AbortController(),work=h.service.generateAnalysis(book,analysis,{signal:ac.signal});const rejected=assert.rejects(work,{name:'AbortError'});await started.promise;ac.abort();await rejected;assert.equal((await h.service.read(book)).generation_id,first.generated.generation_id);}finally{await h.close();}
});
test('a valid same-book ref from another chapter cannot enter a chunk claims domain',async()=>{
 const firstRef=`sp_${digest}_0_0_${Array.from(text).length}`;const h=await fixture(async p=>{const out=output(p);if(p.stage==='chunk'&&p.input.section_id==='sec_b')out.claims[0].source_refs=[firstRef];return out;});try{const a=structuredClone(analysis);a.chapters.push({...a.chapters[0],section_id:'sec_b',section_order:1});await assert.rejects(()=>h.service.generateAnalysis(book,a),{code:'GUIDE_INVALID'});assert.equal(await h.service.read(book),null);}finally{await h.close();}
});
test('run selects exact manifest hash; mismatch or missing manifest never falls back to legacy latest',async()=>{
 const h=await fixture();try{const {generated:g}=await h.service.generateAnalysis(book,analysis);await h.service.commit(book);let ref=VERSION+':'+g.generation_id;const execute=await bridge(h,{versionRef:()=>ref});assert.equal((await execute('business:status',{bookId:book.id})).generatedGuide.generation_id,g.generation_id);ref=VERSION+':'+ 'f'.repeat(64);assert.equal((await execute('business:status',{bookId:book.id})).generatedGuide,null);await h.service.save('guide-'+book.bookVersionId+'-'+ 'f'.repeat(64),g);assert.equal((await execute('business:status',{bookId:book.id})).generatedGuide,null);ref=VERSION;assert.equal((await execute('business:status',{bookId:book.id})).generatedGuide,null);}finally{await h.close();}
});
test('flush cancels background job, waits for asynchronous cleanup and then flushes store',async()=>{
 const h=await fixture();try{const started=deferred(),aborted=deferred(),release=deferred(),order=[];const execute=await bridge(h,{analyzeAndPersist:async({signal})=>{started.resolve();await new Promise(resolve=>signal.addEventListener('abort',()=>{aborted.resolve();resolve();},{once:true}));order.push('aborted');await release.promise;order.push('job-cleaned');throw signal.reason;},flush:async()=>{order.push('store-flushed');}});
 // apply() persists the search policy before any generation job is started.
 // Check that initialization separately, then observe only cancellation events.
 assert.deepEqual(order,['store-flushed']);order.length=0;
 const accepted=await execute('business:analyze',{bookId:book.id,jobId:'synthetic-job-01'});assert.equal(accepted.accepted,true);await started.promise;let complete=false;const flush=execute('business:flush',{}).then(()=>complete=true);await aborted.promise;assert.equal(complete,false);await assert.rejects(()=>execute('business:analyze',{bookId:book.id,jobId:'synthetic-job-02'}),{code:'RUNTIME_DRAINING'});release.resolve();await flush;assert.deepEqual(order,['aborted','job-cleaned','store-flushed']);assert.equal((await execute('business:status',{bookId:book.id})).job.state,'cancelled');}finally{await h.close();}
});
test('structured recommendation titles cannot cross the readable display contract',async()=>{
 const h=await fixture(async p=>{const out=output(p);if(p.stage==='book')out.recommendations[0].title={internal_id:'forged'};return out;});try{await assert.rejects(()=>h.service.generateAnalysis(book,analysis),{code:'GUIDE_INVALID'});}finally{await h.close();}
});
test('oversized stage output fails closed without creating a published guide',async()=>{
 const h=await fixture(async p=>({...output(p),unexpected:'x'.repeat(18001)}));try{await assert.rejects(()=>h.service.generateAnalysis(book,analysis),{code:'GUIDE_INVALID'});assert.equal(await h.service.read(book),null);}finally{await h.close();}
});
test('citation review receives original excerpts, can correct text, and fails closed on invented refs',async()=>{
 let invalid=false;const seen=[];const h=await fixture(async p=>{seen.push(p);const out=output(p);if(p.stage==='verify'){out.overview_paragraphs[0].text='仅保留有原文直接支持的反馈主张。';if(invalid)out.overview_paragraphs[0].source_refs=['invented'];}return out;});
 try{const first=await h.service.generateAnalysis(book,analysis);assert.equal(first.generated.verification.completed,true);assert.equal(first.generated.verification.method,'citation-genre-review-v5c');assert.deepEqual(seen.find(p=>p.stage==='coverage').input.coverage_themes,[{section_id:'sec_a',summary:'反馈影响系统行为。'}]);assert.equal(first.generated.overview_paragraphs[0].text,'仅保留有原文直接支持的反馈主张。');assert.equal(seen.find(p=>p.stage==='verify').input.sources[0].text,text);await h.service.commit(book);h.service.model='new-model';invalid=true;await assert.rejects(()=>h.service.generateAnalysis(book,analysis),{code:'GUIDE_INVALID'});assert.equal((await h.service.read(book)).generation_id,first.generated.generation_id);}finally{await h.close();}
});
test('a rejected worker waits for cancelled sibling cleanup before ending the generation job',async()=>{
 const started=deferred(),aborted=deferred(),release=deferred();const h=await fixture(async(p,{signal})=>{if(p.input.section_id==='sec_a'){await started.promise;throw Object.assign(Error('bad stage'),{code:'GUIDE_INVALID'});}started.resolve();await new Promise(resolve=>signal.addEventListener('abort',()=>{aborted.resolve();resolve();},{once:true}));await release.promise;throw signal.reason;});
 try{const a=structuredClone(analysis);a.chapters.push({...a.chapters[0],section_id:'sec_b',section_order:1});let ended=false;const work=h.service.generateAnalysis(book,a).finally(()=>ended=true),rejected=assert.rejects(work,{code:'GUIDE_INVALID'});await aborted.promise;assert.equal(ended,false);release.resolve();await rejected;assert.equal(ended,true);}finally{release.resolve();await h.close();}
});
test('many chapters reduce within bounded source budgets before final synthesis and citation review',async()=>{
 const h=await fixture();try{
  const longText='甲'.repeat(1500),a={content_id:digest,chapters:Array.from({length:70},(_,i)=>({section_id:'sec_'+i,section_order:i,title:'隔离合成章'+i,chars:1500})),windows:Array.from({length:70},(_,i)=>({section_id:'sec_'+i,window_id:'w'+i,consumed:true})),slices:[],candidates:[]};
  h.service.library.engineRequest=async()=>new Response(JSON.stringify({ok:true,book_version_id:book.bookVersionId,span:{ok:true,book_version_id:book.bookVersionId,quote:longText},segments:[{href:'test.xhtml',start_codepoint:0,end_codepoint:1500,text:longText}]}));
  let tooMany=true;const phases=[];h.service.generate=async p=>{phases.push(p.stage);assert.ok(JSON.stringify(p.input).length<=50000);if(p.stage==='chunk')return {kind:'body',summary:'合成章节归纳。'.repeat(30),claims:p.input.sources.map(s=>({text:'合成主张，仅测试边界。'.repeat(12),source_refs:[s.ref]}))};if(p.stage==='coverage')return {missing_topics:[]};if(p.stage==='verify')return p.input.draft;const ref=p.input.sources[0];return {overview_paragraphs:[{text:'合成归并摘要。',source_refs:p.stage==='reduce'&&tooMany?p.input.sources.slice(0,4).map(s=>s.ref):[ref.ref]}],recommendations:[{section_id:ref.section_id,title:'合成入口',reason:'测试真实来源身份透传。',value_score:3,source_refs:[ref.ref]}]};};
  await assert.rejects(()=>h.service.generateAnalysis(book,a),{code:'GUIDE_INVALID'});tooMany=false;phases.length=0;const result=await h.service.generateAnalysis(book,a);assert.ok(result.generated.cache_hits>=70);assert.ok(phases.filter(p=>p==='reduce').length>=2);assert.equal(phases.at(-1),'verify');assert.equal(result.generated.coverage.processed_sections.length,70);assert.equal(result.generated.verification.completed,true);
 }finally{await h.close();}
});
test('theme audit requires a supported missing theme to reach overview, not merely a recommendation',async()=>{
 let repair=false;const h=await fixture(async p=>{const out=output(p);if(p.stage==='coverage')return {missing_topics:[{topic:'遗漏的条件',text:'第二段原文提供必要条件。',source_refs:[p.input.sources[1].ref]}]};if(p.stage==='verify'&&repair)out.overview_paragraphs[0].source_refs.push(p.input.coverage_review.missing_topics[0].source_refs[0]);return out;});
 try{const long='甲'.repeat(600);h.service.library={engineRequest:async()=>new Response(JSON.stringify({ok:true,book_version_id:book.bookVersionId,span:{ok:true,book_version_id:book.bookVersionId,quote:long},segments:[{href:'a.xhtml',start_codepoint:0,end_codepoint:600,text:long}]}))};const a=structuredClone(analysis);a.chapters[0].chars=600;const original=h.service.generate;h.service.generate=async p=>{if(p.stage==='chunk'){const out=output(p);out.claims=[{text:'两个互补主张',source_refs:p.input.sources.map(s=>s.ref)}];return out;}return original(p);};await assert.rejects(()=>h.service.generateAnalysis(book,a),{code:'GUIDE_INVALID'});assert.equal(await h.service.read(book),null);repair=true;const result=await h.service.generateAnalysis(book,a);assert.equal(result.generated.coverage_review.missing_topics.length,1);assert.equal(result.generated.overview_paragraphs[0].source_refs.length,2);}finally{await h.close();}
});
