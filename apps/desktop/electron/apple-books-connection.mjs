/** Main-process-only discovery handles. Renderer never supplies a filesystem path. */
export class AppleBooksConnection {
  constructor({library, onProgress = () => {}}) {
    this.library = library; this.onProgress = onProgress; this.sources = new Map(); this.busy = false;
    this.connected = false; this.scanning = false;
  }
  async scan() {
    if (this.busy || this.scanning) throw new Error('正在扫描或导入，请稍后刷新');
    this.scanning = true;
    try {
      const result = await this.library.scanAppleBooks();
      this.sources = new Map(result.books.map(book => [book.id, book])); this.connected = true;
      return { ...result, books: result.books.map(({path, ...book}) => book) };
    } finally {this.scanning = false;}
  }
  disconnect() {
    if (this.busy || this.scanning) throw new Error('正在扫描或导入，请稍后解除连接');
    this.connected = false; this.sources.clear();
    return {connected: false, retainedLibrary: true};
  }
  async importSelected(ids) {
    if (this.busy || this.scanning) throw new Error('正在扫描或导入，请勿重复提交');
    if (!Array.isArray(ids) || ids.length > 1000 || ids.some(id => typeof id !== 'string' || !this.sources.has(id)))
      throw new Error('书目已失效，请先刷新 Apple Books');
    const selected = [...new Set(ids)];
    this.busy = true; const results = [];
    try {
      for (const id of selected) {
        const source = this.sources.get(id);
        this.emit({phase:'importing', completed:results.length, total:selected.length, title:source.title});
        let result;
        if (!source.available) result = {id, title:source.title, ok:false, status:source.status, message:source.reason};
        else try {
          const book = await this.library.importFile(source.path);
          result = {id, title:book.title, ok:true, bookId:book.id, alreadyImported:!!book.alreadyImported,
            status:book.alreadyImported?'already-imported':'imported', message:book.alreadyImported?'已在独立书库中':'已纳入独立书库'};
        } catch {
          result = {id, title:source.title, ok:false, status:'import-failed', message:'导入失败：原书可能已移动、未下载、受保护或损坏，请刷新后重试'};
        }
        results.push(result);
        this.emit({phase:'progress', completed:results.length, total:selected.length, result});
      }
      return {results, imported:results.filter(r=>r.ok&&!r.alreadyImported).length,
        duplicates:results.filter(r=>r.alreadyImported).length, failed:results.filter(r=>!r.ok).length};
    } finally {this.busy = false; this.emit({phase:'complete', completed:results.length, total:selected.length});}
  }
  emit(progress) { try { this.onProgress(progress); } catch {} }
}

// Display-only shortening of trailing marketing brackets. Never use this as identity.
export function displayBookTitle(title) {
  const original = String(title || '未命名书籍');
  const shortened = original.replace(/[（(][^（）()]{12,}[）)]\s*$/, '').trim();
  return shortened || original;
}
