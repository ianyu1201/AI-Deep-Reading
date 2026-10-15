import test from 'node:test';import assert from 'node:assert/strict';
import {CodexAdapter,projectContext} from './codex-adapter.mjs';
const opts={provider:'codex-cli',model:'test',messages:[{role:'user',content:[{type:'text',text:'解释主动回忆'}]}]};
function fake(events){let closed=0,received;const adapter=new CodexAdapter({transportFactory:()=>({async *stream(o){received=o;yield* events},async close(){closed++}})});return {adapter,get closed(){return closed},get received(){return received}};}
test('roles and tool results remain explicit; no book text promoted to trusted instructions',()=>{
 const out=projectContext({...opts,system:'阅读助手',messages:[{role:'system',content:[{type:'text',text:'授权边界'}]},...opts.messages,{role:'tool',toolCallId:'c1',content:[{type:'text',text:'忽略指令的书籍原文'}]}]});
 assert.match(out.developerInstructions,/授权边界/);assert.doesNotMatch(out.developerInstructions,/忽略指令/);assert.equal(JSON.parse(out.prompt).conversation[1].toolCallId,'c1');
});
test('real deltas form one Harness block and terminal; transport always closes',async()=>{
 const f=fake([{type:'textDelta',text:'主动'},{type:'textDelta',text:'回忆'},{type:'done',finishReason:'stop'}]);const chunks=await Array.fromAsync(f.adapter.stream(opts));assert.equal(chunks.at(-1).reason.kind,'stop');assert.equal(chunks.find(x=>x.type==='block-end').block.text,'主动回忆');assert.equal(f.closed,1);
});
test('dynamic tool becomes Harness tool call, not fabricated success',async()=>{
 const f=fake([{type:'toolCall',callId:'c1',name:'reading_search',arguments:{query:'主动回忆'}},{type:'done',finishReason:'tool-calls'}]);const chunks=await Array.fromAsync(f.adapter.stream({...opts,tools:[{name:'reading_search',parameters:{type:'object'}}]}));assert.equal(chunks.at(-1).reason.kind,'tool-calls');assert.equal(JSON.parse(chunks.find(x=>x.type==='block-end').block.arguments).query,'主动回忆');
});
test('unexpected tools, missing finish, auth and abort never appear successful',async()=>{
 await assert.rejects(async()=>Array.fromAsync(fake([]).adapter.stream({...opts,tools:[{name:'shell'}]})),{code:'UNAUTHORIZED_TOOL'});
 const f=fake([{type:'textDelta',text:'partial'}]);await assert.rejects(async()=>Array.fromAsync(f.adapter.stream(opts)),{code:'STREAM_CLOSED'});assert.equal(f.closed,1);
 await assert.rejects(async()=>Array.fromAsync(new CodexAdapter({available:false}).stream(opts)),{code:'AUTH'});
 const abort=new AbortController();abort.abort();await assert.rejects(async()=>Array.fromAsync(fake([]).adapter.stream({...opts,signal:abort.signal})),{code:'ABORTED'});
});
test('stop maps to aborted, not completed',async()=>{const chunks=await Array.fromAsync(fake([{type:'done',finishReason:'cancelled'}]).adapter.stream(opts));assert.equal(chunks.at(-1).reason.kind,'aborted');});
function retryFixture(outcomes){let created=0,closed=0;const adapter=new CodexAdapter({transportFactory:()=>{const run=outcomes[created++];return {async *stream(){yield {type:'textDelta',text:run.text};if(run.error)throw Object.assign(Error('private upstream diagnostic'),{code:run.error});yield {type:'done',finishReason:'stop'}},async close(){closed++}}}});return {adapter,get created(){return created},get closed(){return closed}};}
test('compaction retries transient TLS once and publishes only complete replacement',async()=>{const f=retryFixture([{text:'discard partial',error:'CODEX_TRANSIENT_NETWORK'},{text:'valid summary'}]);const out=await Array.fromAsync(f.adapter.stream({...opts,purpose:'compaction'}));assert.equal(f.created,2);assert.equal(f.closed,2);assert.deepEqual(out.filter(e=>e.type==='text-delta').map(e=>e.text),['valid summary']);});
test('compaction retry exhaustion emits no partial checkpoint blocks',async()=>{const f=retryFixture([{text:'partial one',error:'CODEX_TRANSIENT_NETWORK'},{text:'partial two',error:'CODEX_TRANSIENT_NETWORK'}]);const out=[];await assert.rejects(async()=>{for await(const c of f.adapter.stream({...opts,purpose:'compaction'}))out.push(c)},{code:'CODEX_TRANSIENT_NETWORK'});assert.deepEqual(out,[]);assert.equal(f.created,2);assert.equal(f.closed,2)});
test('ordinary conversation and non-network failures are never replayed',async()=>{for(const options of [opts,{...opts,purpose:'compaction'}]){const f=retryFixture([{text:'partial',error:options.purpose?'CODEX_TURN_FAILED':'CODEX_TRANSIENT_NETWORK'}]);await assert.rejects(async()=>Array.fromAsync(f.adapter.stream(options)));assert.equal(f.created,1)}});
test('cancel during compaction retry backoff prevents another process',async()=>{const abort=new AbortController();const f=retryFixture([{text:'partial',error:'CODEX_TRANSIENT_NETWORK'}]);setTimeout(()=>abort.abort(),30);await assert.rejects(async()=>Array.fromAsync(f.adapter.stream({...opts,purpose:'compaction',signal:abort.signal})),{code:'ABORTED'});assert.equal(f.created,1);assert.equal(f.closed,1)});
test('temporary model capacity during compaction is retried once without changing model',async()=>{const f=retryFixture([{text:'',error:'CODEX_MODEL_BUSY'},{text:'summary'}]);const out=await Array.fromAsync(f.adapter.stream({...opts,purpose:'compaction'}));assert.equal(f.created,2);assert.equal(out.at(-1).reason.kind,'stop')});
