import { normalizeBusiness } from './business-contract.mjs';
import { EventEmitter } from 'node:events';
import { fork } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { normalizeCall, failure } from './session-contract.mjs';

const carrierFile = fileURLToPath(new URL('./carrier.mjs', import.meta.url));
const delay = ms => new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref(); });

export class RuntimeManager extends EventEmitter {
  constructor({ dataDir, nodePath, modelConfig=null, readyTimeoutMs = 40000, stopTimeoutMs = 12000 }) {
    super();
    if (!isAbsolute(dataDir ?? '') || !isAbsolute(nodePath ?? '')) throw new TypeError('Absolute dataDir and nodePath are required');
    this.dataDir = dataDir;
    this.modelConfig=modelConfig;
    this.nodePath = nodePath;
    this.readyTimeoutMs = readyTimeoutMs;
    this.stopTimeoutMs = stopTimeoutMs;
    this.status = { state: 'stopped', message: '阅读运行时尚未启动' };
    this.queue = Promise.resolve();
    this.child = null;
    this.stopping = false;
    this.pending = new Map();
  }
  call(action, payload = {}, internalFlush = false) {
    let normalized;
    try { normalized = (action.startsWith("sessions:") ? normalizeCall : normalizeBusiness)(action, payload); } catch (error) { return Promise.reject(error); }
    if (this.status.state !== 'ready' || (this.stopping && !(internalFlush && action==='business:flush')) || !this.child?.connected) return Promise.reject(failure('RUNTIME_UNAVAILABLE', '阅读运行时尚未就绪'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(failure('REQUEST_TIMEOUT', '会话操作超时，请刷新历史确认结果')); }, action.startsWith('sessions:')?95000:305000);
      this.pending.set(id, { resolve, reject, timer, action });
      this.child.send({ type: 'call', id, action, payload: normalized }, error => {
        if (error && this.pending.has(id)) { clearTimeout(timer); this.pending.delete(id); reject(failure('RUNTIME_UNAVAILABLE', '运行时连接已断开')); }
      });
    });
  }
  rejectPending() {
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(failure('RUNTIME_UNAVAILABLE', '运行时已停止，请重启后恢复会话')); }
    this.pending.clear();
  }
  getStatus() { return { ...this.status }; }
  publish(value) { this.status = { ...value }; this.emit('status', this.getStatus()); }
  serialize(operation) {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => {});
    return result;
  }
  start() { return this.serialize(() => this.startOwned()); }
  stop() { return this.serialize(() => this.stopOwned()); }
  restart() { return this.serialize(async () => { await this.stopOwned(); return this.startOwned(); }); }

  async startOwned() {
    if (this.child && this.status.state === 'ready') return this.getStatus();
    if (this.child) await this.stopOwned();
    this.publish({ state: 'starting', message: '正在启动本地阅读运行时' });
    const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
    env.AI_READING_DATA_DIR = this.dataDir;
    for(const key of ['AI_READING_CODEX','AI_READING_CODEX_HOME','AI_READING_DISABLE_AI'])if(process.env[key])env[key]=process.env[key];
    if(process.env.AI_READING_PYTHON)env.AI_READING_PYTHON=process.env.AI_READING_PYTHON;
    if (process.env.AI_READING_USE_HOST_MODEL === '0') env.AI_READING_USE_HOST_MODEL = '0';
    let child;
    try {
      child = fork(carrierFile, [], { execPath: this.nodePath, execArgv: [], env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], detached: process.platform !== 'win32' });
    } catch {
      this.publish({ state: 'error', message: '无法启动 Node 运行时载体' });
      throw new Error(this.status.message);
    }
    this.child = child;
    this.stopping = false;
    child.stdout?.resume();
    child.stderr?.resume(); // D1 errors are surfaced as safe status, never raw credential-bearing stderr.
    const ready = new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        error ? reject(error) : resolve(this.getStatus());
      };
      const timer = setTimeout(() => {
        this.publish({ state: 'error', message: '运行时启动超时' });
        finish(new Error('Runtime readiness deadline exceeded'));
      }, this.readyTimeoutMs);
      child.on('message', message => {
        if (this.child !== child) return;
        if (message?.type === 'call-result') {
          const item = this.pending.get(message.id);
          if (item) { this.pending.delete(message.id); clearTimeout(item.timer); message.error ? item.reject(failure(message.error.code, message.error.message)) : item.resolve(message.result); }
          return;
        }
        if (message?.type === 'session-event') { this.emit('session-event', message.event); return; }
        if (message?.type === 'ready' && Number.isSafeInteger(message.runtimePid)) {
          this.publish({ state: 'ready', message: '本地阅读运行时已就绪', pid: child.pid, runtimePid: message.runtimePid, model: message.model });
          finish();
        } else if (message?.type === 'error') {
          this.rejectPending();
          this.publish({ state: 'error', message: String(message.message || '运行时发生错误').slice(0, 200) });
          finish(new Error(this.status.message));
        }
      });
      child.on('error', () => {
        if (this.child !== child) return;
        this.publish({ state: 'error', message: 'Node 运行时载体启动失败' });
        if (!child.pid) this.child = null;
        finish(new Error(this.status.message));
      });
      child.on('exit', () => {
        this.rejectPending();
        // Each detached carrier owns a separate group. Reap only that group,
        // including its SDK runtime if the carrier died before SDK.close().
        this.signalGroup(child, 'SIGKILL');
        if (this.child !== child) return;
        this.child = null;
        if (!this.stopping) {
          this.publish({ state: 'error', message: '本地阅读运行时意外退出，可重启恢复' });
          finish(new Error(this.status.message));
        }
      });
    });
    try { return await ready; }
    catch (error) {
      const failed = this.getStatus();
      await this.stopOwned();
      this.publish({ state: 'error', message: failed.message });
      throw error;
    }
  }
  signalGroup(child, signal) {
    if (!child.pid) return;
    try {
      if (process.platform !== 'win32') process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (error) { if (error.code !== 'ESRCH') this.emit('diagnostic', { message: '运行时进程回收未确认' }); }
  }
  async stopOwned() {
    const child = this.child;
    if (!child) { this.publish({ state: 'stopped', message: '阅读运行时已停止' }); return this.getStatus(); }
    const mutations=()=>[...this.pending.values()].some(p=>['business:analyze','business:record','business:confirm','business:prepare','business:authorize-search','notes:save'].includes(p.action));
    this.stopping = true;
    const deadline=Date.now()+15000;
    while(mutations()&&Date.now()<deadline)await delay(50);
    if(mutations()){this.stopping=false;throw failure('BUSINESS_BUSY','业务保存仍在进行，请完成后再次退出');}
    if(this.status.state==='ready'){
      try { await this.call('business:flush',{},true); } catch(error){this.stopping=false;throw error;}
      this.stopping=true;
    }
    this.rejectPending();
    let exited = child.exitCode !== null || child.signalCode !== null;
    const exit = new Promise(resolve => { if (exited) resolve(); else child.once('exit', () => { exited = true; resolve(); }); });
    if (child.connected) child.send({ type: 'shutdown' }, () => {});
    await Promise.race([exit, delay(this.stopTimeoutMs)]);
    if (!exited) { this.signalGroup(child, 'SIGTERM'); await Promise.race([exit, delay(3000)]); }
    if (!exited) { this.signalGroup(child, 'SIGKILL'); await Promise.race([exit, delay(3000)]); }
    if (!exited) {
      this.publish({ state: 'error', message: '尚未确认运行时退出，请稍后重试' });
      throw new Error('Carrier termination not confirmed');
    }
    if (this.child === child) this.child = null;
    this.stopping = false;
    this.publish({ state: 'stopped', message: '阅读运行时已停止' });
    return this.getStatus();
  }
}
