import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {existsSync} from 'node:fs';
const preparedPython = fileURLToPath(new URL('../../.build/semantic-python/bin/python3', import.meta.url));
const exec = promisify(execFile);
const script = fileURLToPath(new URL('./library.py', import.meta.url));
export class BookLibrary {
  constructor({ root, pythonPath = process.env.AI_READING_PYTHON || (existsSync(preparedPython) ? preparedPython : 'python3') }) {
    if (!path.isAbsolute(root)) throw new Error('Book library root must be absolute');
    this.root = root; this.pythonPath = pythonPath;
    this.pending = Promise.resolve();
  }
  async run(command, args = [], options = {}) {
    try {
      const { stdout } = await exec(this.pythonPath, ['-B', script, command, '--root', this.root, ...args], { signal: options.signal, timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
      const data = JSON.parse(stdout); if (!data.ok) throw new Error(data.error); return data.result;
    } catch (error) {
      let detail; try { detail = JSON.parse(error.stdout).error; } catch {}
      throw new Error(detail || 'Book library operation failed', { cause: error });
    }
  }
  list() { return this.run('list'); }
  scanAppleBooks() { return this.run('apple-scan'); }
  async get(id) { return (await this.list()).find(book => book.id === id) ?? null; }
  importFile(file) {
    const task = this.pending.then(() => this.run('import', ['--file', file]));
    this.pending = task.catch(() => {}); return task;
  }
  async engineRequest(route, init = {}) {
    const payload = typeof init.body === 'string' ? JSON.parse(init.body) : (init.body ?? {});
    const data = await this.run('engine', ['--route', route, '--payload', JSON.stringify(payload)], {signal: init.signal});
    return new Response(JSON.stringify(data), {status: 200, headers: {'content-type': 'application/json'}});
  }
  async getSourceMapping(spanId) { return (await this.engineRequest('/source-mapping', {body: {span_id: spanId}})).json(); }
  async getSourceChapter(bookId, href) { return (await this.engineRequest('/source-chapter', {body: {bookId, href}})).json(); }
  environment() { return { AI_READING_BOOK_PROVIDER: 'standalone', AI_READING_LIBRARY_ROOT: this.root }; }
}
