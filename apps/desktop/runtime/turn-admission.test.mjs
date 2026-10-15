import test from 'node:test';
import assert from 'node:assert/strict';
import { TurnAdmission, effectiveSessionStatus } from './turn-admission.mjs';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const agentDouble = () => {
  const state = { status: 'idle', inbox: { nextTurn: [], nextStep: [] }, calls: [], cancel(...args) { this.calls.push(args); this.inbox.nextTurn.length = 0; this.inbox.nextStep.length = 0; this.status = 'idle'; }, async whenIdle() {} };
  return state;
};

test('cancel during delayed persistence prevents a later followup and releases gates', async () => {
  const gate = new TurnAdmission(); const agent = agentDouble(); const disk = deferred(); let submitted = 0;
  const prompt = gate.prompt('one', agent, () => disk.promise, () => { submitted++; return { accepted: true }; });
  const rejection = assert.rejects(prompt, { code: 'PROMPT_CANCELLED' });
  const cancel = gate.cancel('one', agent, async () => {});
  await assert.rejects(gate.prompt('one', agent, async () => {}, () => {}), { code: 'SESSION_BUSY' });
  // Other sessions are independent while this one's save is pending.
  assert.equal(await gate.prompt('other', agentDouble(), async () => {}, () => 'independent'), 'independent');
  disk.resolve(); await rejection; await cancel;
  assert.equal(submitted, 0);
  assert.deepEqual(agent.calls, [[{ kind: 'user' }]]);
  assert.equal(await gate.prompt('one', agent, async () => {}, () => 'retry'), 'retry');
});

test('accepted but not started inbox is cleared by default cancel', async () => {
  const gate = new TurnAdmission(); const agent = agentDouble();
  await gate.prompt('one', agent, async () => {}, () => { agent.inbox.nextTurn.push('accepted'); return { accepted: true }; });
  assert.equal(agent.inbox.nextTurn.length, 1);
  assert.equal(agent.status, 'idle');
  assert.equal(effectiveSessionStatus(agent), 'queued');
  await assert.rejects(gate.prompt('one', agent, async () => {}, () => agent.inbox.nextTurn.push('duplicate')), { code: 'SESSION_BUSY' });
  await gate.cancel('one', agent, async () => {});
  assert.equal(agent.inbox.nextTurn.length, 0);
  assert.equal(effectiveSessionStatus(agent), 'idle');
  assert.deepEqual(agent.calls[0], [{ kind: 'user' }]);
});

test('running cancellation waits idle and durability, rejects new admission until done', async () => {
  const gate = new TurnAdmission(); const agent = agentDouble(); const idle = deferred(); const flushed = deferred();
  agent.status = 'running'; agent.whenIdle = () => idle.promise;
  const first = gate.cancel('one', agent, () => flushed.promise);
  assert.equal(gate.cancel('one', agent, async () => {}), first);
  await Promise.resolve();
  await assert.rejects(gate.prompt('one', agent, async () => {}, () => {}), { code: 'SESSION_BUSY' });
  idle.resolve(); await Promise.resolve();
  await assert.rejects(gate.prompt('one', agent, async () => {}, () => {}), { code: 'SESSION_BUSY' });
  flushed.resolve(); await first;
  assert.equal(await gate.prompt('one', agent, async () => {}, () => 'next'), 'next');
});

test('persistence failure emits no followup and cancellation can still finish', async () => {
  const gate = new TurnAdmission(); const agent = agentDouble(); const disk = deferred(); let sends = 0;
  const prompt = gate.prompt('one', agent, async () => { await disk.promise; throw new Error('synthetic disk failure'); }, () => { sends++; });
  const rejection = assert.rejects(prompt, /synthetic disk failure/);
  const cancel = gate.cancel('one', agent, async () => {});
  disk.resolve(); await rejection; await cancel;
  assert.equal(sends, 0);
  assert.equal(gate.pending.size + gate.cancelling.size, 0);
});

test('queued projection includes next-step work and running takes precedence', async () => {
  const agent = agentDouble(); const gate = new TurnAdmission();
  agent.inbox.nextStep.push('accepted');
  assert.equal(effectiveSessionStatus(agent), 'queued');
  await assert.rejects(gate.prompt('one', agent, async () => {}, () => {}), { code: 'SESSION_BUSY' });
  agent.status = 'running';
  assert.equal(effectiveSessionStatus(agent), 'running');
  await gate.cancel('one', agent, async () => {});
  assert.equal(effectiveSessionStatus(agent), 'idle');
});
