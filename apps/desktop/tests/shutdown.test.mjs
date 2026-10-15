import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { join } from 'node:path';
import { shutdownApplication } from '../electron/shutdown.mjs';

function fixture(overrides = {}) {
  const calls = [];
  const draftResults = [{ ok: true }, { ok: true }];
  const operations = {
    flushDrafts: async () => { calls.push('flush'); return draftResults; },
    confirmExit: async () => { calls.push('confirm'); return false; },
    stopRuntime: async () => { calls.push('stop'); },
    writeDiagnostics: async results => { assert.equal(results, draftResults); calls.push('diagnostics'); },
    closeViews: () => { calls.push('close-views'); },
    finishExit: () => { calls.push('exit'); },
    onBlocked: stage => { calls.push(`blocked:${stage}`); },
    onDiagnosticError: () => { calls.push('diagnostic-error'); },
    ...overrides,
  };
  return { calls, operations, draftResults };
}

test('normal exit disposes runtime before any view closes', async () => {
  const f = fixture();
  assert.deepEqual(await shutdownApplication(f.operations), { closed: true });
  assert.deepEqual(f.calls, ['flush', 'stop', 'diagnostics', 'close-views', 'exit']);
});

test('runtime stop rejection preserves every view and allows a retry', async () => {
  let failed = true;
  const f = fixture({ stopRuntime: async () => { f.calls.push('stop'); if (failed) throw new Error('termination unproved'); } });
  assert.deepEqual(await shutdownApplication(f.operations), { closed: false, reason: 'runtime-stop' });
  assert.deepEqual(f.calls, ['flush', 'stop', 'blocked:runtime-stop']);
  failed = false;
  assert.deepEqual(await shutdownApplication(f.operations), { closed: true });
  assert.deepEqual(f.calls.slice(3), ['flush', 'stop', 'diagnostics', 'close-views', 'exit']);
});

for (const operation of ['mkdir', 'writeFile']) {
  test(`${operation} diagnostic failure cannot block exit`, async () => {
    const f = fixture({ writeDiagnostics: async () => { f.calls.push('diagnostics'); throw new Error(`${operation} failed`); } });
    assert.deepEqual(await shutdownApplication(f.operations), { closed: true });
    assert.deepEqual(f.calls, ['flush', 'stop', 'diagnostics', 'diagnostic-error', 'close-views', 'exit']);
  });
}

test('failed draft flush keeps the return-to-review choice and does not stop runtime', async () => {
  const f = fixture();
  f.draftResults[1] = { ok: false };
  assert.deepEqual(await shutdownApplication(f.operations), { closed: false, reason: 'draft-review' });
  assert.deepEqual(f.calls, ['flush', 'confirm']);
});

test('only the existing explicit exit choice proceeds after failed flush', async () => {
  const f = fixture({ confirmExit: async () => { f.calls.push('confirm'); return true; } });
  f.draftResults[0] = { ok: false };
  assert.deepEqual(await shutdownApplication(f.operations), { closed: true });
  assert.deepEqual(f.calls, ['flush', 'confirm', 'stop', 'diagnostics', 'close-views', 'exit']);
});

test('a failed warning dialog cannot reject shutdown or close views', async () => {
  const f = fixture({ stopRuntime: async () => { throw new Error('stop'); }, onBlocked: async () => { throw new Error('dialog'); } });
  assert.deepEqual(await shutdownApplication(f.operations), { closed: false, reason: 'runtime-stop' });
  assert.deepEqual(f.calls, ['flush']);
});

test('actual main closeApp preserves views and resets closing after stop failure, then retries', async () => {
  const main = await readFile(new URL('../electron/main.mjs', import.meta.url), 'utf8');
  const source = main.slice(main.indexOf('async function closeApp()'), main.indexOf("app.on('before-quit'"));
  const calls = [];
  let failStop = true;
  let failAnnotations = true;
  let failBookmarks = true;
  const context = vm.createContext({
    bookmarks: { flush: async () => { if(failBookmarks)throw new Error('bookmark write pending'); } },
    annotations: { flush: async () => { if(failAnnotations)throw new Error('annotation write pending'); } },
    codexLogin: { cancel: async () => calls.push('cancel-login') }, closing: false, closed: false, diagnostic: [], cancelTransition:()=>{},shutdownApplication, join,
    // No deadline is needed here: both renderer flushes resolve immediately.
    setTimeout: () => 0,
    pages: new Map([['markdown', { webContents: { executeJavaScript: async () => ({ ok: true }), isDestroyed: () => false, close: () => calls.push('close-view') } }]]),
    runtime: { stop: async () => { calls.push('stop'); if (failStop) throw new Error('stop failure'); }, getStatus: () => ({ state: 'stopped' }) },
    dialog: { showMessageBox: async () => { calls.push('error-dialog'); return { response: 0 }; } },
    notify: () => {}, mkdir: async () => {}, writeFile: async () => {},
    window: { webContents: { executeJavaScript: async () => ({ ok: true }) }, isDestroyed: () => false, destroy: () => calls.push('destroy-window') },
    app: { getPath: () => '/unused-test-directory', quit: () => calls.push('quit') },
  });
  vm.runInContext(source, context);
  await context.closeApp();
  assert.equal(context.closing, false);
  assert.equal(context.closed, false);
  assert.deepEqual(calls, ['error-dialog']);
  calls.length = 0;
  failAnnotations = false;
  await context.closeApp();
  assert.equal(context.closed, false);
  assert.equal(context.closing, false);
  assert.deepEqual(calls, ['error-dialog']);
  calls.length = 0;
  failBookmarks = false;
  await context.closeApp();
  assert.equal(context.closing, false);
  assert.equal(context.closed, false);
  assert.deepEqual(calls, ['stop', 'error-dialog']);
  failStop = false;
  await context.closeApp();
  assert.equal(context.closed, true);
  assert.deepEqual(calls, ['stop', 'error-dialog', 'stop', 'cancel-login', 'close-view', 'destroy-window', 'quit']);
});
