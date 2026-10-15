import { open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { normalizeScope, validSessionId, failure, sameScope } from './session-contract.mjs';

export class SessionRegistry {
  constructor(path, {syncDirectory}={}) { this.syncDirectory=syncDirectory; this.path = path; this.records = []; this.queue = Promise.resolve(); }
  async load() {
    let text;
    try { text = await readFile(this.path, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    const value = JSON.parse(text);
    if (![1,2].includes(value?.version) || !Array.isArray(value.sessions)) throw failure('REGISTRY_INVALID', '应用会话索引损坏，请恢复备份', 500);
    const ids = new Set();
    this.records = value.sessions.map(row => {
      if (!validSessionId(row?.sessionId) || ids.has(row.sessionId) || typeof row.title !== 'string' || row.title.length > 120 || !Number.isFinite(Date.parse(row.createdAt)) || !Number.isFinite(Date.parse(row.updatedAt))) throw failure('REGISTRY_INVALID', '应用会话索引损坏，请恢复备份', 500);
      if(value.version===2&&(!['default','topic'].includes(row.role)||!['active','archived','deleted'].includes(row.lifecycle)))throw failure('REGISTRY_INVALID','会话状态损坏，请恢复备份',500);
      ids.add(row.sessionId);
      return { sessionId: row.sessionId, title: row.title, scope: normalizeScope(row.scope), createdAt: row.createdAt, updatedAt: row.updatedAt, lastUsedAt: row.lastUsedAt || row.updatedAt, role: row.role === 'default' ? 'default' : 'topic', lifecycle: ['active','archived','deleted'].includes(row.lifecycle) ? row.lifecycle : 'active' };
    });
    if(value.version === 1) {
      this.migrationBackup=this.path+'.v1-backup';
      await writeFile(this.migrationBackup,text,{flag:'wx',mode:0o600}).catch(error=>{if(error.code!=='EEXIST')throw error});
      for(const row of [...this.records].sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.sessionId.localeCompare(b.sessionId))) if(!this.records.some(r=>sameScope(r.scope,row.scope)&&r.role==='default')) row.role='default';
      await this.change(rows=>rows);
    }
  }
  get(id) { return this.records.find(row => row.sessionId === id); }
  list() { return this.records.map(row => ({ ...row, scope: { ...row.scope } })); }
  change(update) {
    const work = this.queue.then(async () => {
      const next = update(this.list());
      const temp = `${this.path}.${randomUUID()}.tmp`;
      try {
        const file = await open(temp, 'wx', 0o600);
        try { await file.writeFile(JSON.stringify({ version: 2, migration: 'v1 IDs and history retained; earliest-created session is default', sessions: next })); await file.sync(); } finally { await file.close(); }
        await rename(temp, this.path);
        this.records = next;
        // rename is the commit point: a later directory fsync error cannot be reported as a rolled-back mutation.
        try { if(this.syncDirectory)await this.syncDirectory(dirname(this.path)); else {const parent = await open(dirname(this.path), 'r'); try { await parent.sync(); } finally { await parent.close(); }} this.durabilityWarning=null; }
        catch {this.durabilityWarning='会话索引已提交，但目录持久化未确认；请保留应用并备份。';}
      } finally { await unlink(temp).catch(() => {}); }
    });
    this.queue = work.catch(() => {});
    return work;
  }
  add(record) { return this.change(rows => { if (rows.some(row => row.sessionId === record.sessionId)) throw failure('SESSION_EXISTS', '会话已存在', 409); return [...rows, {lastUsedAt:record.updatedAt,role:'topic',lifecycle:'active',...record}]; }); }
  update(id, patch) { return this.change(rows=>rows.map(row=>row.sessionId===id?{...row,...patch}:row)); }
  touch(id) { return this.change(rows => rows.map(row => row.sessionId === id ? { ...row, updatedAt: new Date().toISOString() } : row)); }
}
