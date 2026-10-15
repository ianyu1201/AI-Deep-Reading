import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Execute the shipped controller, replacing only its top-level async bootstrap.
// The bridge deliberately delays replies while real input/event handlers run.
const source = await readFile(new URL('../shell/shell.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../shell/index.html', import.meta.url), 'utf8');
const bootstrap = 'bridge.onState(render); render(await bridge.getState());';
assert.ok(source.includes(bootstrap), 'update the fixture when shell bootstrap changes');
const controller = source.replace(/^import .*?;\n/gm, '').replace(bootstrap, 'bridge.onState(render); render(initialState);');
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(setImmediate); };

class Element {
  constructor() {
    this.value = ''; this.hidden = false; this.disabled = false;
    this.textContent = ''; this.children = []; this.dataset = {}; this.className = '';
    this.scrollTop = 0; this.clientHeight = 300; this.scrollHeight = 300;
    this.classList = { toggle() {} }; this.style = { setProperty() {} };
  }
  addEventListener(type, handler) { this['on' + type] = handler; }
  replaceChildren(...children) { this.children = children; }
  append(...children) { for(const child of children){child.parent=this;this.children.push(child);} }
  querySelectorAll() {return [];}
  querySelector() { return this.children.find(x=>x.className==='chat-empty')??null; }
  closest(selector) {
    assert.match(selector, /^\.[\w-]+$/, 'the mock supports the class ancestor selectors used by shell');
    for(let node=this;node;node=node.parent)if(node.className.split(/\s+/).includes(selector.slice(1)))return node;
    return null;
  }
  remove() { if(this.parent)this.parent.children=this.parent.children.filter(x=>x!==this); }
  get lastChild(){return this.children.at(-1)??this;}
  get firstChild(){return this.children[0]??null;}
  get nextSibling(){return this.parent?.children[this.parent.children.indexOf(this)+1]??null;}
  insertBefore(node,before){node.remove();node.parent=this;node.isConnected=true;const i=this.children.indexOf(before);if(i<0)this.children.push(node);else this.children.splice(i,0,node);}
  setAttribute() {}
  after() {}
  contains() {return false;}
  focus() {}
  click() { return this.onclick?.(); }
}

function harness() {
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => [id, new Element()]));
  // The real resource tree is inside a scrollable section without an ID.
  assert.match(html, /<section class="notes-section">[\s\S]*?<nav id="note-tree"[^>]*><\/nav><\/section>/);
  const notesSection = new Element(); notesSection.className = 'notes-section';
  notesSection.append(elements.get('note-tree')); elements.get('resources').append(notesSection);
  for(const id of ['global-chat','sidebar-toggle','chat-expand','return-workbench'])elements.get(id).append(new Element());
  const storage = new Map(), requests = [];
  const model = { available: true, model: 'synthetic-no-network' };
  let stateListener, sessionListener;
  const h = {
    rows: [{ sessionId: 'session-a', title: 'A' }], requests, storage,
    el(id) { assert.ok(elements.has(id), `unknown real DOM id: ${id}`); return elements.get(id); },
    input(text) { h.el('question').value = text; h.el('question').oninput(); },
    event(event) { sessionListener(event); },
    state(bookId = 'a') {
      stateListener({ ...initialState, runtime: { state: 'ready' }, book: { id: bookId, title: bookId, author: '', open: true } });
    },
    next(action) {
      const request = requests.find(row => row.action === action && !row.consumed);
      assert.ok(request, `expected pending ${action}; received ${requests.map(row => row.action).join(',')}`);
      request.consumed = true; return request;
    },
    history(sessionId = 'session-a', status = 'idle') { return { sessionId, status, messages: [], model }; },
    async boot() { h.state(); await settle(); h.next('ensure').resolve(h.history()); await settle(); assert.equal(h.activeSession,'session-a'); },
    async finishHistory(request, sessionId = 'session-a') { request.resolve(h.history(sessionId)); await settle(); },
  };
  const initialState = { view: 'reading', readingTab: 'guide', runtime: { state: 'stopped' }, book: null, layout: {} };
  const bridge = {
    searchNotes:async()=>[], selectRightTool:async()=>{},
    setActiveSession(id) { h.activeSession = id; },
    onState(callback) { stateListener = callback; }, onSessionEvent(callback) { sessionListener = callback; },
    sessions(action, payload) {
      if (action === 'list') return Promise.resolve({ sessions: h.rows, model });
      return new Promise((resolve, reject) => requests.push({ action, payload, resolve, reject }));
    },
  };
  vm.runInNewContext(controller, {
    window: { readingApp: bridge, addEventListener() {} }, requestAnimationFrame:fn=>fn(), initialState,
    installWorkspaceResizer:()=>()=>{},
    installSessionUI: options => {h.sessionUI=options;return {changed(){},status(){}}},
    installAnnotationsUI:()=>({render(){},flush(){return true}}),
    installBusinessUI: () => ({ render: () => false, restoreAttachment: async () => {}, discuss: async () => {} }),
    document: { getElementById: id => h.el(id), createElement: () => new Element(), body: new Element(), documentElement: new Element() },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) },
  }, { filename: 'real-shell.js' });
  return h;
}

test('delayed history reply preserves the next question and its durable draft', async () => {
  const h = harness(); await h.boot(); h.input('下一问草稿');
  const refresh = h.sessionUI.refresh(false);
  const request = h.next('history');
  h.input('下一问草稿：在等待回读期间补充的文字');
  await h.finishHistory(request); await refresh;
  assert.equal(h.el('question').value, '下一问草稿：在等待回读期间补充的文字');
  assert.equal(h.storage.get('reading:draft:session-a'), h.el('question').value);
});

test('late accepted reply does not clear text typed after submission', async () => {
  const h = harness(); await h.boot(); h.input('已经提交的问题');
  const submission = h.el('composer').onsubmit({ preventDefault() {} });
  const request = h.next('prompt');
  assert.equal(request.payload.text, '已经提交的问题');
  h.input('发送等待期间写好的下一问');
  request.resolve({ accepted: true }); await submission; await settle();
  await h.finishHistory(h.next('history'));
  assert.equal(h.el('question').value, '发送等待期间写好的下一问');
  assert.equal(h.storage.get('reading:draft:session-a'), '发送等待期间写好的下一问');
});

test('completion before accepted cannot put an idle conversation back into busy state', async () => {
  const h = harness(); await h.boot(); h.input('很快结束的问题');
  const submission = h.el('composer').onsubmit({ preventDefault() {} });
  const request = h.next('prompt');
  h.event({ type: 'status', sessionId: 'session-a', status: 'running' });
  h.event({ type: 'turn-complete', sessionId: 'session-a' });
  await h.finishHistory(h.next('history'));
  request.resolve({ accepted: true }); await submission; await settle();
  // Check before the post-acceptance history reply: stale acknowledgement
  // alone must not undo the already observed completion.
  assert.equal(h.el('send').hidden, false);
  assert.equal(h.el('stop').hidden, true);
  await h.finishHistory(h.next('history'));
  assert.equal(h.el('stop').hidden, true);
  assert.equal(h.el('question').value, '');
  assert.equal(h.storage.get('reading:draft:session-a'), '');
});

test('accepted queued input retains stop after history refresh and blocks another submission', async () => {
  const h = harness(); await h.boot(); h.input('待执行的问题');
  const submission = h.el('composer').onsubmit({ preventDefault() {} });
  h.next('prompt').resolve({ accepted: true }); await submission; await settle();
  const refresh = h.next('history'); refresh.resolve(h.history('session-a', 'queued')); await settle();
  assert.equal(h.el('send').hidden, true);
  assert.equal(h.el('stop').hidden, false);
  assert.equal(h.el('chat-status').textContent, '问题已接收，等待回答');
  h.input('不应重复排队的问题');
  await h.el('composer').onsubmit({ preventDefault() {} });
  assert.equal(h.requests.filter(row => row.action === 'prompt').length, 1);
  const stopping = h.el('stop').onclick();
  h.next('cancel').resolve({ status: 'idle' }); await settle();
  await h.finishHistory(h.next('history')); await stopping;
  assert.equal(h.el('stop').hidden, true);
  assert.equal(h.el('send').hidden, false);
  assert.equal(h.el('question').value, '不应重复排队的问题');
});

test('queued status event keeps the same conversation cancellable', async () => {
  const h = harness(); await h.boot();
  h.event({ type: 'status', sessionId: 'session-a', status: 'queued' });
  assert.equal(h.el('stop').hidden, false);
  assert.equal(h.el('send').hidden, true);
  h.event({ type: 'status', sessionId: 'session-a', status: 'running' });
  assert.equal(h.el('chat-status').textContent, 'AI 正在回答');
});

test('typing while a new book session is being created survives the reply', async () => {
  const h = harness(); await h.boot(); h.input('A 书保留的草稿');
  h.rows = []; h.state('b'); await settle();
  const request = h.next('ensure');
  h.input('B 书在创建等待期间的新草稿');
  h.rows = [{ sessionId: 'session-b', title: 'B' }];
  request.resolve(h.history('session-b')); await settle();
  assert.equal(h.el('question').value, 'B 书在创建等待期间的新草稿');
  assert.equal(h.storage.get('reading:draft:session-b'), h.el('question').value);
  assert.equal(h.storage.get('reading:draft:session-a'), 'A 书保留的草稿');
});

test('typing while a book session resumes takes precedence over its older saved draft', async () => {
  const h = harness(); await h.boot();
  h.storage.set('reading:draft:session-b', 'B 书以前保存的草稿');
  h.rows = [{ sessionId: 'session-b', title: 'B' }]; h.state('b'); await settle();
  const request = h.next('ensure'); h.input('B 书恢复期间输入的新草稿');
  request.resolve(h.history('session-b')); await settle();
  assert.equal(h.el('question').value, 'B 书恢复期间输入的新草稿');
  assert.equal(h.storage.get('reading:draft:session-b'), h.el('question').value);
});

test('a previous book late response cannot replace the newly selected book draft', async () => {
  const h = harness(); await h.boot();
  h.rows = [{ sessionId: 'session-b', title: 'B' }]; h.state('b'); await settle();
  const previous = h.next('ensure');
  h.rows = [{ sessionId: 'session-c', title: 'C' }]; h.state('c'); await settle();
  const current = h.next('ensure'); h.input('C 书的新草稿');
  current.resolve(h.history('session-c')); await settle();
  previous.resolve(h.history('session-b')); await settle();
  assert.equal(h.el('question').value, 'C 书的新草稿');
  assert.equal(h.storage.get('reading:last-session:prototype:c'), 'session-c');
  assert.equal(h.storage.get('reading:draft:session-c'), 'C 书的新草稿');
});

test('manual create preserves edits made while its response is pending', async () => {
 const h = harness(); await h.boot(); h.input('old draft');
 const pending = h.el('new-session').onclick(); await settle();
 h.input('written during create'); h.next('create').resolve(h.history('session-new')); await pending;
 assert.equal(h.el('question').value, 'written during create');
 assert.equal(h.storage.get('reading:draft:session-a'), 'written during create');
 assert.equal(h.storage.get('reading:draft:session-new'), 'written during create');
});
test('manual resume preserves edits made while its response is pending', async () => {
 const h = harness(); await h.boot();
 const pending = h.sessionUI.selectSession('session-b'); await settle();
 h.input('written during resume'); h.next('resume').resolve(h.history('session-b')); await pending;
 assert.equal(h.el('question').value, 'written during resume');
 assert.equal(h.storage.get('reading:draft:session-b'), 'written during resume');
});
