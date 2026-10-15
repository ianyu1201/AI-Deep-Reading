import { randomUUID } from 'node:crypto';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionRegistry } from './session-registry.mjs';
import { normalizeCall, sameScope, failure, publicError } from './session-contract.mjs';
import { projectMessage, projectOutcome } from './session-projection.mjs';
import { TurnAdmission, effectiveSessionStatus } from './turn-admission.mjs';

export const name = 'reading-desktop-sessions';
export const inject = ['agents', 'sessions', 'sessionQuery', 'sessionProjections', 'webServer'];
export async function apply(ctx) {
  const registry = new SessionRegistry(process.env.AI_READING_REGISTRY);
  await registry.load();
  const model = JSON.parse(process.env.AI_READING_MODEL_STATUS);
  const options = { provider: process.env.AI_READING_PROVIDER, model: process.env.AI_READING_MODEL };
  const handles = new Map();
  const scopeQueues = new Map(), mutating = new Set();
  const serial = (scope, work) => { const key=JSON.stringify(scope), p=(scopeQueues.get(key)||Promise.resolve()).then(work); scopeQueues.set(key,p.catch(()=>{})); return p; };
  const opening = new Map();
  const admission = new TurnAdmission();
  const persistQueues = new Map();
  const streams = new Map();
  const clients = new Set();
  let disposed = false;
  // Transport-only bytes prevent idle HTTP body timeouts. They are not session
  // events, never persisted, and must not alter turn or model semantics.
  const eventHeartbeat = setInterval(() => {
    if (disposed) return;
    for (const response of clients) {
      if (response.destroyed || !response.write(JSON.stringify({ type: 'transport-heartbeat' }) + '\n')) {
        clients.delete(response); response.destroy();
      }
    }
  }, 15000);
  eventHeartbeat.unref();
  const emit = (sessionId, value) => {
    const record = registry.get(sessionId);
    if (!record || record.lifecycle === 'deleted' || disposed) return;
    const line = JSON.stringify({ sessionId, scope: record.scope, ...value }) + '\n';
    for (const response of clients) if (!response.write(line)) { clients.delete(response); response.destroy(); }
  };
  const status = id => effectiveSessionStatus(handles.get(id)?.agent);
  const emitStatus = id => { if (handles.has(id)) emit(id, { type: 'status', status: status(id) }); };
  const requireRecord = ({ sessionId, scope }, includeInactive=false) => {
    const record = registry.get(sessionId);
    if (!record || (!includeInactive&&record.lifecycle!=='active') || !sameScope(record.scope, scope)) throw failure('SESSION_NOT_FOUND', '当前范围内没有此会话', 404);
    return record;
  };
  const ensure = async record => {
    if (handles.has(record.sessionId)) return handles.get(record.sessionId).agent;
    if (!opening.has(record.sessionId)) opening.set(record.sessionId, (async () => {
      const handle = await ctx.agents.resume({ resumeSessionId: record.sessionId, agentOptions: options });
      handles.set(record.sessionId, handle);
      return handle.agent;
    })().finally(() => opening.delete(record.sessionId)));
    return opening.get(record.sessionId);
  };
  const flush = async agent => {
    if (!(await ctx.sessions.flush(agent.session))) throw failure('SESSION_NOT_DURABLE', '会话暂未确认保存，请重试', 500);
  };
  const history = async record => {
    const agent = await ensure(record);
    await flush(agent);
    const log = await ctx.sessionQuery.readSession(record.sessionId);
    record=requireRecord({sessionId:record.sessionId,scope:record.scope});
    if(mutating.has(record.sessionId))throw failure('SESSION_INACTIVE','会话状态正在变更，请稍后重试',409);
    return { sessionId: record.sessionId, scope: record.scope, title: record.title, role: record.role, lifecycle: record.lifecycle, status: status(record.sessionId), messages: (log?.events ?? []).map(event => projectMessage(record.sessionId, event)).filter(Boolean), model };
  };
  ctx.on('agent/status', ({ agent }) => emitStatus(String(agent.session.id)));
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    const id = String(agent.session.id);
    if (!handles.has(id)) return;
    if (frame.type === 'start') {
      const stream = { messageId: `stream:${id}:${randomUUID()}`, turn: frame.turn, step: frame.step, attemptId: frame.attemptId };
      streams.set(id, stream);
      emit(id, { type: 'assistant-start', messageId: stream.messageId });
    } else {
      const stream = streams.get(id);
      if (!stream || stream.attemptId !== frame.attemptId) return;
      if (frame.type === 'chunk' && frame.chunk?.type === 'text-delta') emit(id, { type: 'text-delta', messageId: stream.messageId, text: frame.chunk.text });
      if (frame.type === 'end') emit(id, { type: 'assistant-end', messageId: stream.messageId, ...(frame.outcome?.kind === 'committed' ? { id: `${id}:${frame.outcome.seq}`, seq: frame.outcome.seq } : {}), committed: frame.outcome?.kind === 'committed' });
    }
  });
  ctx.on('session/event', (session, event) => {
    const id = String(session.id);
    if (!handles.has(id)) return;
    if (event.type === 'agent/inbox/spliced') {
      // Project after the synchronous inbox fold and driver wake have settled.
      queueMicrotask(() => emitStatus(id));
      return;
    }
    if (!['user/message', 'assistant/message', 'turn/end'].includes(event.type)) return;
    // session/event is a synchronous publication hook. Drain persistence outside
    // that call stack, then publish only acknowledged, allowlisted UI messages.
    const stream = streams.get(id);
    const streamId = event.type === 'assistant/message' && stream?.turn === event.data.turn && stream?.step === event.data.step ? stream.messageId : undefined;
    const work = (persistQueues.get(id) ?? Promise.resolve()).then(async () => {
      await flush(handles.get(id).agent);
      const message = projectMessage(id, event);
      if (message) emit(id, { type: 'message', message, ...(streamId ? { messageId: streamId } : {}) });
      if (event.type === 'turn/end') {
        await registry.touch(id);
        const outcome = projectOutcome(event);
        emit(id, { type: 'turn-complete', status: outcome === 'error' ? 'error' : status(id), outcome, ...(outcome === 'error' ? { error: { code: 'TURN_FAILED', message: 'AI 回复未完成，请重试' } } : {}) });
      }
    }).catch(() => emit(id, { type: 'status', status: 'error', error: { code: 'PERSISTENCE_FAILED', message: '会话保存未确认，请重试' } }));
    persistQueues.set(id, work);
  });
  const createRecord = async (scope, title, role='topic', persist=true) => {
    const sessionId = `reading-${randomUUID()}`, now = new Date().toISOString();
    const record = { sessionId, scope, title, role, lifecycle:'active', createdAt:now, updatedAt:now, lastUsedAt:now };
    const handle = await ctx.agents.create({sessionId,meta:{cwd:process.env.AI_READING_WORKSPACE},agentOptions:options});
    try { await flush(handle.agent); if(persist)await registry.add(record); handles.set(sessionId,handle); }
    catch(error) { await handle.dispose(); throw error; }
    return record;
  };
  const defaultFor = async scope => registry.list().find(r=>sameScope(r.scope,scope)&&r.role==='default'&&r.lifecycle==='active') || createRecord(scope,'阅读讨论','default');
  const execute = async (action, raw) => {
    const data = normalizeCall(action, raw);
    if (action === 'sessions:list') {
      const records = registry.list().filter(record => !data.scope || sameScope(record.scope, data.scope));
      // Never label a persisted but unattached inbox idle. Restore only the
      // registry-owned records in the requested scope through the official API.
      const sessions = await Promise.all(records.map(async record => {
        if(record.lifecycle !== 'deleted') await ensure(record);
        return { ...record, status: status(record.sessionId) };
      }));
      return { sessions: sessions.sort((a,b) => b.updatedAt.localeCompare(a.updatedAt)), model, warning:registry.durabilityWarning||undefined };
    }
    if (action === 'sessions:ensure' || action === 'sessions:create') return serial(data.scope, async()=>{
      const defaultRecord = await defaultFor(data.scope);
      const record = action === 'sessions:create' ? await createRecord(data.scope,data.title) : registry.list().filter(r=>sameScope(r.scope,data.scope)&&r.lifecycle==='active').sort((a,b)=>(b.lastUsedAt||b.updatedAt).localeCompare(a.lastUsedAt||a.updatedAt))[0] || defaultRecord;
      await registry.update(record.sessionId,{lastUsedAt:new Date().toISOString()});
      return history(record);
    });
    const record = requireRecord(data,true);
    if (['sessions:rename','sessions:archive','sessions:restore','sessions:trash'].includes(action)) return serial(record.scope,async()=>{
      const current = requireRecord(data,true);
      if((action==='sessions:archive'&&current.lifecycle!=='active'||action==='sessions:trash'&&current.lifecycle==='deleted'))throw failure('SESSION_INACTIVE','请先恢复此会话',409);
      if(action === 'sessions:rename') { await registry.update(current.sessionId,{title:data.title,updatedAt:new Date().toISOString()}); return {ok:true}; }
      if(action === 'sessions:archive' && current.role==='default') throw failure('DEFAULT_REQUIRED','默认会话不能归档',409);
      if(action === 'sessions:restore') { await registry.update(current.sessionId,{lifecycle:'active',updatedAt:new Date().toISOString(),role:current.role==='default'&&registry.list().some(r=>r.sessionId!==current.sessionId&&sameScope(r.scope,current.scope)&&r.role==='default'&&r.lifecycle==='active')?'topic':current.role}); return {ok:true}; }
      mutating.add(current.sessionId);
      try {
        if(action === 'sessions:trash') {
          const agent=await ensure(current);
          await admission.cancel(current.sessionId,agent,async()=>{await flush(agent);await persistQueues.get(current.sessionId)});
        }
        if(current.role==='default' && action==='sessions:trash') {
          const replacement=await createRecord(current.scope,'阅读讨论','default',false);
          try {await registry.change(rows=>[...rows.map(r=>r.sessionId===current.sessionId?{...r,lifecycle:'deleted',updatedAt:new Date().toISOString()}:r),replacement]);}
          catch(error){await handles.get(replacement.sessionId)?.dispose();handles.delete(replacement.sessionId);throw error}
        } else await registry.update(current.sessionId,{lifecycle:action==='sessions:trash'?'deleted':'archived',updatedAt:new Date().toISOString()});
      } finally {mutating.delete(current.sessionId)}
      // Replacement creation is idempotent and retriable via ensure. Never resurrect deleted messages.
      if(current.role==='default') await defaultFor(current.scope);
      return {ok:true};
    });
    if(record.lifecycle!=='active' || mutating.has(record.sessionId)) throw failure('SESSION_INACTIVE','请先恢复此会话',409);
    if (action === 'sessions:history' || action === 'sessions:resume') {if(action==='sessions:resume')await registry.update(record.sessionId,{lastUsedAt:new Date().toISOString()});return history(record);}

    const agent = await ensure(record);
    if (action === 'sessions:cancel') {
      await admission.cancel(record.sessionId, agent, async () => {
        await flush(agent);
        await persistQueues.get(record.sessionId);
      });
      emitStatus(record.sessionId);
      return { sessionId: record.sessionId, status: status(record.sessionId) };
    }
    if (!model.available) throw failure('MODEL_UNAVAILABLE', model.reason || '尚未配置可用模型', 503);
    return admission.prompt(record.sessionId, agent, async () => {
      if(registry.get(record.sessionId)?.lifecycle!=='active'||mutating.has(record.sessionId))throw failure('SESSION_INACTIVE','请先恢复此会话',409);
      await persistQueues.get(record.sessionId);
      await registry.touch(record.sessionId);
    }, () => {
      const message = createUserMessage({ content: [{ type: 'text', text: data.text }], source: { kind: 'user' } });
      agent.followup(message);
      emitStatus(record.sessionId);
      return { accepted: true, messageId: message.id, sessionId: record.sessionId };
    });
  };
  const disposeRoute = ctx.webServer.register({ kind: 'prefix', path: '/reading-internal', handler: async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (req.method === 'GET' && path === '/reading-internal/events') {
      res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
      res.write(JSON.stringify({ type: 'connected' }) + '\n');
      clients.add(res);
      res.on('close', () => clients.delete(res));
      return;
    }
    const send = (status, data) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };
    try {
      let body = '';
      for await (const part of req) { body += part; if (Buffer.byteLength(body) > 160000) throw failure('BODY_TOO_LARGE', '请求内容过长', 413); }
      let payload;
      try { payload = JSON.parse(body || '{}'); } catch { throw failure('INVALID_JSON', '会话参数不合法'); }
      const action = `sessions:${path.slice('/reading-internal/sessions/'.length)}`;
      send(200, { result: await execute(action, payload) });
    } catch (error) { send(error.safe ? error.status : 500, { error: publicError(error) }); }
  }});
  ctx.provide('readingSessionsReady', { ready: true, requireRecord, getBookRecord: sessionId => { const record=registry.get(sessionId); if(!record||record.lifecycle!=='active'||record.scope.kind!=='book'||mutating.has(sessionId))throw failure('SESSION_NOT_FOUND','当前书籍会话不可用',404); return record; } });
  ctx.effect(() => async () => {
    disposed = true;
    clearInterval(eventHeartbeat);
    disposeRoute();
    for (const client of clients) client.end();
    await Promise.allSettled([...persistQueues.values()]);
    await Promise.allSettled([...handles.values()].map(handle => handle.dispose()));
    handles.clear();
  });
}
