import {failure} from './session-contract.mjs';
export const BUSINESS_ACTIONS = {
 'business:flush':[],
 'business:search-policy':[], 'business:set-search-policy':['enabled'], 'business:ack-search-migration':[],
 'business:authorize-search':['bookId','sessionId','enabled'],
 'business:attachment':['bookId','sessionId'],
 'business:detach':['bookId','sessionId'],
 'business:status':['bookId'], 'business:analyze':['bookId','jobId'], 'business:cancel-analysis':['bookId'],
 'business:source-target':['bookId','spanId'], 'business:prepare-target':['bookId','spanId','sessionId'],
 'business:source':['bookId','spanId'], 'business:prepare':['bookId','spanId','sessionId'],
 'business:record':['bookId','spanId','statement','kind','dimension','requestId','conceptRefs'],
 'business:confirm':['bookId','noteId','contentHash'],
 'notes:list':[], 'notes:read':['id'], 'notes:search':['query'],
 'notes:save':['id','base_hash','body','request_id'],
};
export function normalizeBusiness(action,payload={}) {
 const allowed=BUSINESS_ACTIONS[action];
 if(!allowed||!payload||typeof payload!=='object'||Array.isArray(payload)||Object.keys(payload).some(k=>!allowed.includes(k))||Buffer.byteLength(JSON.stringify(payload))>6*1024*1024)throw failure('INVALID_BUSINESS_REQUEST','阅读操作参数不合法');
 if(!['business:flush','business:search-policy','business:set-search-policy','business:ack-search-migration'].includes(action)&&action.startsWith('business:')&&(typeof payload.bookId!=='string'||!/^book_[a-f0-9]{16}$/.test(payload.bookId)))throw failure('INVALID_BOOK','需要已登记的书籍身份');
 return structuredClone(payload);
}
