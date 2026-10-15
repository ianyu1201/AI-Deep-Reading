import { classifyProvenance } from '../../../dsh-apple-read/lib/reading/session-reader.js';
const textOf = content => Array.isArray(content) ? content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('') : '';
export function projectMessage(sessionId, event) {
  if (!Number.isSafeInteger(event?.seq)) return null;
  const provenance = classifyProvenance(event);
  if (event.type === 'user/message' && provenance.human_input_candidate && !provenance.navigation_only) {
    return { id: typeof event.data.id === 'string' ? event.data.id : `${sessionId}:${event.seq}`, role: 'user', text: textOf(event.data.content), seq: event.seq };
  }
  if (event.type === 'assistant/message') return { id: `${sessionId}:${event.seq}`, role: 'assistant', text: textOf(event.data?.message?.content), seq: event.seq, ...(event.data?.interrupted ? { interrupted: true } : {}) };
  return null;
}
export function projectOutcome(event) {
  const reason = event?.data?.reason;
  if (reason?.kind === 'completed') return 'completed';
  if (reason?.kind === 'aborted' && reason.reason?.kind === 'user') return 'cancelled';
  return 'error';
}
