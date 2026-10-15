export const SESSION_ACTIONS = Object.freeze(['sessions:list', 'sessions:create', 'sessions:resume', 'sessions:history', 'sessions:prompt', 'sessions:cancel', 'sessions:ensure', 'sessions:rename', 'sessions:archive', 'sessions:restore', 'sessions:trash']);
export const validSessionId = value => typeof value === 'string' && /^reading-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
export function failure(code, message, status = 400) { return Object.assign(new Error(message), { code, status, safe: true }); }
export function normalizeScope(scope = { kind: 'general' }) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) throw failure('INVALID_SCOPE', '会话范围不合法');
  if (scope.kind === 'general' && Object.keys(scope).every(key => key === 'kind')) return { kind: 'general' };
  if (scope.kind === 'book' && Object.keys(scope).every(key => ['kind', 'bookId'].includes(key)) && typeof scope.bookId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,239}$/.test(scope.bookId)) return { kind: 'book', bookId: scope.bookId };
  throw failure('INVALID_SCOPE', '会话书籍范围不合法');
}
export const sameScope = (a, b) => a.kind === b.kind && (a.kind === 'general' || a.bookId === b.bookId);
export function normalizeCall(action, payload = {}) {
  if (!SESSION_ACTIONS.includes(action)) throw failure('UNKNOWN_ACTION', '不支持的会话操作');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw failure('INVALID_PAYLOAD', '会话参数不合法');
  const allowed = ['sessions:list','sessions:ensure'].includes(action) ? ['scope'] : action === 'sessions:create' ? ['scope', 'title'] : action === 'sessions:rename' ? ['scope','sessionId','title'] : action === 'sessions:prompt' ? ['sessionId', 'scope', 'text'] : ['sessionId', 'scope'];
  if (Object.keys(payload).some(key => !allowed.includes(key))) throw failure('INVALID_PAYLOAD', '会话参数包含未知字段');
  const scope = action === 'sessions:list' && payload.scope === undefined ? undefined : normalizeScope(payload.scope);
  const result = scope ? { scope } : {};
  if (!['sessions:list', 'sessions:create', 'sessions:ensure'].includes(action)) {
    if (!validSessionId(payload.sessionId)) throw failure('INVALID_SESSION', '会话标识不合法');
    result.sessionId = payload.sessionId;
  }
  if (['sessions:create','sessions:rename'].includes(action)) {
    if (payload.title !== undefined && (typeof payload.title !== 'string' || payload.title.length > 120 || /[\u0000-\u001f]/.test(payload.title))) throw failure('INVALID_TITLE', '会话标题不合法');
    result.title = payload.title?.trim() || (scope.kind === 'book' ? '新主题' : '新对话');
  }
  if (action === 'sessions:prompt') {
    if (typeof payload.text !== 'string' || !payload.text.trim() || payload.text.length > 30000) throw failure('INVALID_PROMPT', '请输入不超过 30000 字符的问题');
    result.text = payload.text;
  }
  return result;
}
export function publicError(error) {
  return error?.safe ? { code: error.code, message: error.message } : { code: 'SESSION_OPERATION_FAILED', message: '会话操作未完成，请重试或重新启动运行时' };
}
