import test from 'node:test';
import assert from 'node:assert/strict';
process.env.AI_READING_BOOK_PROVIDER = 'standalone';
process.env.AI_READING_PROVIDER = 'codex-cli';
process.env.AI_READING_MODEL = 'configured-model';
process.env.AI_READING_MODEL_STATUS = JSON.stringify({available:true});
const {makeGenerateStructured,inject} = await import('../lib/index.js');
const spec = {task:'compile_change_operations', evidence:'synthetic isolated fixture'};
const originalFetch = globalThis.fetch;
globalThis.fetch = () => { throw Error('Standalone must never use direct HTTP'); };
process.on('exit', () => { globalThis.fetch = originalFetch; });
const generate = stream => makeGenerateStructured(() => ({}), {llm:{stream}});
const output = async function* () {
 yield {type:'reasoning-delta',text:'ignored'};
 yield {type:'text-delta',text:'{"outcome":"no_'};
 yield {type:'text-delta',text:'change","reason":"fixture"}'};
 yield {type:'finish',reason:{kind:'stop'}};
};
test('same Harness route, no API key or HTTP, valid JSON', async () => {
 assert.ok(inject.includes('llm'));
 let options;
 const call = generate(opts => { options=opts; return output(); });
 assert.deepEqual(await call(spec), {outcome:'no_change',reason:'fixture'});
 assert.equal(options.provider,'codex-cli');
 assert.equal(options.model,'configured-model');
 assert.equal(options.messages[0].role,'user');
 assert.match(options.messages[0].content[0].text,/synthetic isolated fixture/);
 assert.ok(options.signal instanceof AbortSignal);
});
test('unavailable status fails before calling provider', async () => {
 process.env.AI_READING_MODEL_STATUS = '{"available":false}';
 try { await assert.rejects(generate(() => {throw Error('must not call')})(spec), {code:'MODEL_UNAVAILABLE'}); }
 finally { process.env.AI_READING_MODEL_STATUS = '{"available":true}'; }
});
test('error, aborted, token limit and missing terminal are failures even with valid JSON', async () => {
 for (const kind of ['error','aborted','max-tokens',null]) {
  const call = generate(async function* () {
   yield {type:'text-delta',text:'{"outcome":"no_change"}'};
   if(kind) yield {type:'finish',reason:{kind}};
  });
  await assert.rejects(call(spec), {code:kind === 'aborted' ? 'MODEL_ABORTED' : 'MODEL_FAILED'});
 }
});
test('bad JSON and invalid structured task schema are rejected', async () => {
 for (const text of ['not json','{"outcome":"wrong"}']) {
  await assert.rejects(generate(async function* () {
   yield {type:'text-delta',text}; yield {type:'finish',reason:{kind:'stop'}};
  })(spec));
 }
 await assert.rejects(generate(output)({task:'unsupported'}), {code:'MODEL_UNSUPPORTED_TASK'});
});
test('overview uses same adapter and validates array', async () => {
 const call = generate(async function* () {
  yield {type:'text-delta',text:'{"overview_paragraphs":[{"text":"summary","source_refs":["s1"]}]}'};
  yield {type:'finish',reason:{kind:'stop'}};
 });
 assert.equal((await call({task:'recommendation_overview',items:[]})).overview_paragraphs[0].text,'summary');
});
test('timeout aborts provider and external cancellation settles promptly', async () => {
 let seenSignal;
 const call = generate(async function* (opts) {
  seenSignal = opts.signal;
  await new Promise(resolve => opts.signal.addEventListener('abort',resolve,{once:true}));
 });
 await assert.rejects(call(spec,{timeoutMs:20}), {code:'MODEL_TIMEOUT'});
 assert.equal(seenSignal.aborted,true);
 const aborter = new AbortController();
 const pending = call(spec,{signal:aborter.signal});
 aborter.abort();
 await assert.rejects(pending,{code:'MODEL_ABORTED'});
 assert.equal(seenSignal.aborted,true);
 const preAborted = new AbortController();preAborted.abort();
 await assert.rejects(call(spec,{signal:preAborted.signal}), {code:'MODEL_ABORTED'});
});
test('structured failure preserves only categorical safe provider codes, never raw failure details',async()=>{
 for(const [input,expected] of [['CODEX_MODEL_BUSY','CODEX_MODEL_BUSY'],['CODEX_TRANSIENT_NETWORK','CODEX_TRANSIENT_NETWORK'],['untrusted private detail','MODEL_FAILED']]){
 const call=generate(async function*(){yield {type:'finish',reason:{kind:'error',failure:{code:input,message:'secret material must not escape'}}};});
 await assert.rejects(call(spec),error=>error.code===expected&&!error.message.includes('secret')&&!error.message.includes('private'));
 }
});
