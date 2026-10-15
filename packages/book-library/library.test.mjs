import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {BookLibrary} from './index.mjs';
test('Node provider persists, returns Response and uses exact identity without server', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'desktop-library-'));
  try {
    const file = path.join(dir, 'book.epub');
    execFileSync('python3', ['-c', 'import sys; from pathlib import Path; sys.path.insert(0,sys.argv[1]); from test_library import fixture; fixture(Path(sys.argv[2]))', fileURLToPath(new URL('.', import.meta.url)), file]);
    const library = new BookLibrary({root:path.join(dir, 'library')});
    const book = await library.importFile(file);
    assert.equal((await library.get(book.id)).bookId, book.bookId);
    const response = await library.engineRequest('/book-identity?path='+encodeURIComponent(book.enginePath));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).book_id, book.bookId);
    const mapped = await library.getSourceMapping(`sp_${book.bookId}_0_0_7`);
    assert.equal(mapped.span.quote, 'Chapter');
    const controller = new AbortController(); controller.abort();
    await assert.rejects(library.engineRequest('/books', {signal:controller.signal}));
  } finally { await rm(dir,{recursive:true,force:true}); }
});
