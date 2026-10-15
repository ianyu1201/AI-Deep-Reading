import { normalizeBusiness } from './business-contract.mjs';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes } from 'node:crypto';
import { HarnessClient } from '@deepseek-ai/dsh-sdk-client';
import {resolveCodexPath} from './codex-path.mjs';
import {CodexTransport} from './codex-transport.mjs';
import { normalizeCall, publicError, failure } from './session-contract.mjs';

const runtimeDir = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.AI_READING_DATA_DIR;
if (!dataDir || !isAbsolute(dataDir) || !process.send) throw new Error('Carrier requires an absolute private data directory and parent IPC');
const stateDir = join(dataDir, 'runtime');
const workspace = join(stateDir, 'workspace');
const knowledgeRoot = join(dataDir, 'knowledge', '45-书籍');
const home = join(stateDir, 'harness-home');
const readyFile = join(stateDir, `ready-${randomUUID()}.json`);
const internalToken = randomBytes(32).toString('hex');
let sdk;
let shuttingDown;
let baseInternal;
let eventsAbort;
const send = message => { if (process.connected) process.send(message); };

async function stop(exitCode = 0) {
  if (shuttingDown) return shuttingDown;
  shuttingDown = (async () => {
    eventsAbort?.abort();
    try { await sdk?.close(); }
    catch { exitCode = 1; }
    await unlink(readyFile).catch(() => {});
    send({ type: 'stopped' });
    process.exit(exitCode);
  })();
  return shuttingDown;
}
process.on('message', message => {
  if (message?.type === 'shutdown') void stop();
  if (message?.type === 'call') void (async () => {
    try {
      const payload = (message.action.startsWith("sessions:") ? normalizeCall : normalizeBusiness)(message.action, message.payload);
      if (!baseInternal || shuttingDown) throw failure('RUNTIME_UNAVAILABLE', '阅读运行时尚未就绪', 503);
      const response = await fetch(message.action.startsWith('sessions:') ? `${baseInternal}/sessions/${message.action.slice('sessions:'.length)}` : `${baseInternal.replace('/reading-internal','/reading-business')}`, {
        method: 'POST', headers: { authorization: `Bearer ${internalToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(message.action.startsWith('sessions:') ? payload : {action:message.action,payload}), signal: AbortSignal.timeout(message.action.startsWith('sessions:')?90000:300000),
      });
      const body = await response.json();
      if (!response.ok) return send({ type: 'call-result', id: message.id, error: body.error });
      send({ type: 'call-result', id: message.id, result: body.result });
    } catch (error) { send({ type: 'call-result', id: message.id, error: publicError(error) }); }
  })();
});
process.on('disconnect', () => void stop());
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
process.on('uncaughtException', () => { send({ type: 'error', message: '运行时载体发生未处理错误' }); void stop(1); });
process.on('unhandledRejection', () => { send({ type: 'error', message: '运行时载体发生异步错误' }); void stop(1); });

try {
  await Promise.all([stateDir, workspace, knowledgeRoot, home, join(stateDir, 'books'), join(stateDir, 'cache'), join(stateDir, 'reading')].map(path => mkdir(path, { recursive: true, mode: 0o700 })));
  let modelStatus={available:false,reason:'Codex CLI 尚未连接；阅读和编辑仍可使用'},codexPath;
  const provider='codex-cli';
  const codexHome=process.env.AI_READING_CODEX_HOME||join(dataDir,'codex-home');
  // Explicit offline test mode never starts an authenticated model transport.
  if(process.env.AI_READING_DISABLE_AI!=='1'&&process.env.AI_READING_USE_HOST_MODEL!=='0'){
    let probe;
    try{
      codexPath=(await resolveCodexPath()).path;
      probe=new CodexTransport({command:codexPath,codexHome,pythonPath:process.env.AI_READING_PYTHON});
      const status=await probe.start();
      modelStatus={...status,provider};
    }catch{modelStatus={available:false,provider,reason:'Codex CLI 暂不可用，请在本机登录 ChatGPT 后重新连接运行时'};}
    finally{await probe?.close();}
  }
  const model=modelStatus.model??'codex-unavailable';
  const baseManifest = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-base/package.json'));
  const basePatch = await readFile(join(dirname(baseManifest), 'cordis.patch.yml'), 'utf8');
  const tools = [...basePatch.matchAll(/^\s*- id: (tool-[^\s]+)\s*$/gm)].map(match => match[1]);
  const disabled = [...new Set(['plan-mode', 'credentials', 'deepseek-account', 'skill-filesystem', 'agent-instructions', 'shell-env', 'session-telemetry-otel', ...tools])];
  let patch = disabled.map(id => `- id: ${id}\n  disabled: true`).join('\n');

  patch += `\n- insert:\n    - id: reading-codex-adapter\n      name: ${JSON.stringify(join(runtimeDir, 'codex-adapter.mjs'))}\n    - id: reading-webserver\n      name: ${JSON.stringify(join(runtimeDir, 'guarded-webserver.mjs'))}\n      config: {host: '127.0.0.1', port: 0}\n    - id: reading-turn-outline\n      name: '@deepseek-ai/dsh-session-turn-outline'\n    - id: reading-plugin\n      name: ${JSON.stringify(resolve(runtimeDir, '../../../dsh-apple-read/lib/index.js'))}\n    - id: reading-session-bridge\n      name: ${JSON.stringify(join(runtimeDir, 'session-bridge.mjs'))}\n    - id: reading-business\n      name: ${JSON.stringify(join(runtimeDir, 'business-bridge.mjs'))}\n    - id: reading-readiness\n      name: ${JSON.stringify(join(runtimeDir, 'readiness.mjs'))}\n`;
  const patchFile = join(stateDir, 'desktop.patch.yml');
  await writeFile(patchFile, patch);
  // Authentication stays with the official Codex CLI; the client never reads or copies credentials.
  const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  if(codexPath)env.AI_READING_CODEX=codexPath;
  env.AI_READING_CODEX_HOME=codexHome;
  Object.assign(env, {
    AI_READING_BOOK_PROVIDER:'standalone', AI_READING_LIBRARY_ROOT:join(dataDir,'library'), ...(process.env.AI_READING_PYTHON?{AI_READING_PYTHON:process.env.AI_READING_PYTHON}:{}),
    AI_READING_REGISTRY: join(stateDir, 'sessions.json'), AI_READING_WORKSPACE: workspace,
    AI_READING_MODEL_STATUS: JSON.stringify(modelStatus), AI_READING_PROVIDER: provider, AI_READING_MODEL: model,
    DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', AI_READING_READY_FILE: readyFile, AI_READING_INTERNAL_TOKEN: internalToken,
    APPLE_READ_STORE: join(stateDir, 'reading-store.json'), APPLE_READ_SIDECAR: join(stateDir, 'sidecar.json'),
    APPLE_READ_READING_DIR: join(stateDir, 'reading'), APPLE_READ_BOOK_KB_DIR: knowledgeRoot,
    APPLE_READ_DIR: join(stateDir, 'books'), APPLE_READ_UV: join(stateDir, 'disabled-uv'),
    APPLE_READ_ENGINE: join(stateDir, 'unused-engine.py'), XDG_CACHE_HOME: join(stateDir, 'cache'),
  });
  sdk = new HarnessClient({ profile: 'sdk', patches: [patchFile], dshHome: home, processCwd: workspace, env, initializeTimeoutMs: 25000, requestTimeoutMs: 25000 });
  sdk.start();
  await sdk.initialize({ cwd: workspace, provider, model });
  let ready;const readyDeadline=Date.now()+20000;
  while(!ready){try{ready=JSON.parse(await readFile(readyFile,'utf8'));}catch(error){if(error.code!=='ENOENT'||Date.now()>readyDeadline)throw error;await new Promise(resolve=>setTimeout(resolve,50));}}
  const baseURL = `http://127.0.0.1:${ready.port}/apple-read/api`;
  const headers = { authorization: `Bearer ${internalToken}` };
  const request = (path, options = {}) => fetch(`${baseURL}${path}`, { signal: AbortSignal.timeout(10000), ...options });
  if ((await request('/reading/library')).status !== 401) throw new Error('Unauthenticated route was not refused');
  if ((await request('/reading/library', { headers: { ...headers, origin: 'https://example.com' } })).status !== 403) throw new Error('Browser origin was not refused');
  for (const path of ['/config', '/settings', '/health', '/books', '/reading/analyze-and-persist']) {
    if ((await request(path, { headers })).status !== 403) throw new Error('D1 forbidden route was not refused');
  }
  if ((await request('/reading/library', { method: 'POST', headers })).status !== 403) throw new Error('D1 write route was not refused');
  const response = await request('/reading/library', { headers });
  const library = await response.json();
  if (!response.ok || library.ok !== true || library.root !== knowledgeRoot) throw new Error('Private reading-library boundary failed');
  baseInternal = `http://127.0.0.1:${ready.port}/reading-internal`;
  eventsAbort = new AbortController();
  const eventResponse = await fetch(`${baseInternal}/events`, { headers, signal: eventsAbort.signal });
  if (!eventResponse.ok) throw new Error('Session event transport unavailable');
  const eventReader = eventResponse.body.getReader();
  const decoder = new TextDecoder();
  const first = await eventReader.read();
  let buffered = decoder.decode(first.value, { stream: true });
  if (!buffered.includes('"connected"')) throw new Error('Session event handshake unavailable');
  buffered = buffered.slice(buffered.indexOf('\n') + 1);
  void (async () => {
    try {
      while (!shuttingDown) {
        let cut;
        while ((cut = buffered.indexOf('\n')) >= 0) {
          const event = JSON.parse(buffered.slice(0, cut)); buffered = buffered.slice(cut + 1);
          if (event.type !== 'connected' && event.type !== 'transport-heartbeat') send({ type: 'session-event', event });
        }
        const { done, value } = await eventReader.read();
        if (done) throw new Error('Event stream ended');
        buffered += decoder.decode(value, { stream: true });
        if (buffered.length > 1000000) throw new Error('Event buffer overflow');
      }
    } catch { if (!shuttingDown) { send({ type: 'error', message: '会话事件连接已断开，请重启以恢复历史' }); void stop(1); } }
  })();
  if (!shuttingDown) send({ type: 'ready', runtimePid: ready.pid, model: modelStatus });
  // SDK has no public subprocess exit event. A low-cost initialize heartbeat
  // detects transport loss; it neither creates a session nor invokes a model.
  const heartbeat = setInterval(async () => {
    if (shuttingDown) return;
    try { await sdk.initialize({ cwd: workspace, provider, model }); }
    catch { send({ type: 'error', message: 'Harness 运行时连接已断开' }); void stop(1); }
  }, 5000);
  heartbeat.unref();
} catch (error) {
  send({ type: 'error', message: 'Harness 运行时启动失败，请检查运行环境或重启' });
  await stop(1);
}
