import { failure } from './session-contract.mjs';

// Harness reports maintenance as idle even when accepted input is latched in
// its public inbox. This projection is only used for app-owned agent handles.
export function effectiveSessionStatus(agent) {
  if (agent?.status === 'running') return 'running';
  if (agent?.inbox?.nextTurn?.length || agent?.inbox?.nextStep?.length) return 'queued';
  return 'idle';
}

// Only one UI prompt may be admitted per agent. Cancellation covers both the
// asynchronous persistence preflight and any inbox item already handed to the
// actual Harness agent. It never cancels the runtime or unrelated sessions.
export class TurnAdmission {
  constructor() { this.pending = new Map(); this.cancelling = new Map(); }
  async prompt(id, agent, prepare, submit) {
    if (effectiveSessionStatus(agent) !== 'idle' || this.pending.has(id) || this.cancelling.has(id)) throw failure('SESSION_BUSY', '请等待当前回复完成或停止后再发送', 409);
    let settled;
    const ticket = { cancelled: false, done: new Promise(resolve => { settled = resolve; }) };
    this.pending.set(id, ticket);
    try {
      await prepare();
      if (ticket.cancelled) throw failure('PROMPT_CANCELLED', '本次问题已停止', 409);
      return submit();
    } finally {
      this.pending.delete(id);
      settled();
    }
  }
  cancel(id, agent, afterIdle) {
    if (this.cancelling.has(id)) return this.cancelling.get(id);
    const ticket = this.pending.get(id);
    if (ticket) ticket.cancelled = true;
    // Defer continuation so the cancellation gate is installed before either
    // whenIdle or a synchronous test/runtime callback can admit another input.
    const operation = Promise.resolve().then(async () => {
      await ticket?.done;
      agent.cancel({ kind: 'user' }); // default clears this client's only inbox
      await agent.whenIdle();
      await afterIdle();
    }).finally(() => this.cancelling.delete(id));
    this.cancelling.set(id, operation);
    return operation;
  }
}
