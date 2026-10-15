import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RuntimeManager } from './manager.mjs';
import { SessionRegistry } from './session-registry.mjs';
import { normalizeCall, publicError } from './session-contract.mjs';
import { readAuthorizedHostModel, selectPublicModel } from './model-config.mjs';
import { projectMessage, projectOutcome } from './session-projection.mjs';
const fixtureParent = resolve('runtime/.fixtures');
await mkdir(fixtureParent, { recursive: true });
const fixture = name => mkdtemp(join(fixtureParent, name));
const id = () => `reading-${randomUUID()}`;

test('action and scope boundary rejects foreign paths, unknown fields and session IDs', () => {
  assert.throws(() => normalizeCall('sessions:remove', {}), { code: 'UNKNOWN_ACTION' });
  assert.throws(() => normalizeCall('sessions:history', { sessionId: '../../.dsh/session' }), { code: 'INVALID_SESSION' });
  assert.throws(() => normalizeCall('sessions:create', { scope: { kind: 'book', bookId: '/Users/vault/book' } }), { code: 'INVALID_SCOPE' });
  assert.throws(() => normalizeCall('sessions:prompt', { sessionId: id(), text: 'hi', provider: 'other' }), { code: 'INVALID_PAYLOAD' });
  assert.throws(() => normalizeCall('sessions:prompt', { sessionId: id(), text: ' '.repeat(5) }), { code: 'INVALID_PROMPT' });
  assert.deepEqual(publicError(new Error('Authorization Bearer synthetic-secret')), { code: 'SESSION_OPERATION_FAILED', message: '会话操作未完成，请重试或重新启动运行时' });
});

test('model opt-in never reads on disabled, selected key only, public provider allowlist', async () => {
  let reads = 0;
  assert.equal((await readAuthorizedHostModel({ read: async () => { reads++; throw Error('must not read'); } })).public.available, false);
  assert.equal(reads, 0);
  const rows = [
    { id: 'agent-default-model', config: { provider: 'test-provider', model: 'test-model' } },
    { id: 'llm-pi-ai', config: { providers: { 'test-provider': { api: 'anthropic-messages', apiKeyEnv: 'TEST_KEY', baseURL: 'https://example.test/api', models: [{ id: 'test-model', headers: { secret: 'do-not-copy' } }], headers: { Authorization: 'do-not-copy' } } } } },
  ];
  const publicConfig = selectPublicModel(rows);
  assert.deepEqual(publicConfig.providerConfig, { api: 'anthropic-messages', apiKeyEnv: 'TEST_KEY', baseURL: 'https://example.test/api', models: [{ id: 'test-model' }] });
  const selected = await readAuthorizedHostModel({ enabled: true, home: '/synthetic', read: async path => {
    reads++;
    if (path.endsWith('cordis.patch.yml')) return JSON.stringify(rows);
    return 'refs:\n  TEST_KEY: selected-fixture-value\n  OTHER_KEY: unselected-fixture-value\n';
  }});
  assert.equal(selected.key, 'selected-fixture-value');
  assert.equal(JSON.stringify(selected).includes('unselected-fixture'), false);
  assert.equal(JSON.stringify(selected.public).includes('selected-fixture'), false);
  rows[1].config.providers['test-provider'].baseURL = 'https://example.test/?api_key=foo';
  assert.throws(() => selectPublicModel(rows));
});

test('real business provenance excludes checkpoint/runtime context; durable messages retain text', () => {
  const sessionId = id();
  const user = { type: 'user/message', seq: 1, data: { id: 'original-user-id', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'original' }] } };
  assert.deepEqual(projectMessage(sessionId, user), { id: 'original-user-id', role: 'user', text: 'original', seq: 1 });
  for (const kind of ['compact-checkpoint', 'runtime-context', 'agent-notify']) assert.equal(projectMessage(sessionId, { ...user, data: { ...user.data, source: { kind } } }), null);
  assert.equal(projectMessage(sessionId, { type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'text', text: 'answer' }, { type: 'tool-call', secret: 'hidden' }] } } }).text, 'answer');
  assert.equal(projectOutcome({ data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } }), 'cancelled');
});

test('registry concurrent writes survive reload without conversation content', async () => {
  const path = join(await fixture('registry-'), 'sessions.json');
  const r = new SessionRegistry(path); await r.load();
  const now = new Date().toISOString();
  await Promise.all(Array.from({ length: 8 }, (_, i) => r.add({ sessionId: id(), title: `fixture ${i}`, scope: { kind: 'general' }, createdAt: now, updatedAt: now })));
  const restored = new SessionRegistry(path); await restored.load();
  assert.equal(restored.list().length, 8);
  assert.deepEqual(restored.list(), r.list());
  assert.equal((await readFile(path, 'utf8')).includes('messages'), false);
});

test('real no-model runtime: own sessions, exact book scopes, prompt refused, restart/resume', { timeout: 90000 }, async () => {
  assert.notEqual(process.env.AI_READING_USE_HOST_MODEL, '1', 'No-model tests must run without host-model opt-in');
  const dataDir = await fixture('sessions-');
  const manager = new RuntimeManager({ dataDir, nodePath: process.execPath });
  try {
    const state = await manager.start();
    assert.equal(state.model.available, false);
    const general = await manager.call('sessions:create', { title: '合成普通会话' });
    const scope = { kind: 'book', bookId: 'prototype:alice' };
    const book = await manager.call('sessions:create', { title: '合成书籍会话', scope });
    assert.deepEqual(book.messages, []);
    assert.equal((await manager.call('sessions:list', {})).sessions.length, 4);
    assert.equal((await manager.call('sessions:list', { scope })).sessions[0].sessionId, book.sessionId);
    await assert.rejects(manager.call('sessions:history', { sessionId: book.sessionId }), { code: 'SESSION_NOT_FOUND' });
    await assert.rejects(manager.call('sessions:resume', { sessionId: id() }), { code: 'SESSION_NOT_FOUND' });
    await assert.rejects(manager.call('sessions:prompt', { sessionId: general.sessionId, text: 'This must not invoke a model' }), { code: 'MODEL_UNAVAILABLE' });
    assert.equal((await manager.call('sessions:cancel', { sessionId: general.sessionId })).status, 'idle');
    const pid = manager.getStatus().runtimePid;
    await manager.restart();
    assert.notEqual(manager.getStatus().runtimePid, pid);
    const resumed = await manager.call('sessions:resume', { sessionId: book.sessionId, scope });
    assert.deepEqual(resumed.messages, []);
    assert.equal(resumed.title, '合成书籍会话');
    await assert.rejects(manager.call('sessions:history', { sessionId: book.sessionId, scope: { kind: 'book', bookId: 'prototype:other' } }), { code: 'SESSION_NOT_FOUND' });
  } finally { await manager.stop(); }
  await assert.rejects(manager.call('sessions:list'), { code: 'RUNTIME_UNAVAILABLE' });
});
