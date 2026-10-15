import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,isAbsolute,resolve} from 'node:path';
const exec=promisify(execFile);
const disabled=['shell_tool','unified_exec','shell_snapshot','apps','plugins','hooks','browser_use','browser_use_external','browser_use_full_cdp_access','computer_use','in_app_browser','multi_agent','code_mode','code_mode_host','artifact','image_generation','memories','workspace_dependencies','tool_suggest','skill_mcp_dependency_install','realtime_conversation'];
export async function isolationArguments({home,pythonPath='python3'}={}){
 if(typeof home!=='string'||!isAbsolute(home))throw Error('Codex 配置目录必须是绝对路径');
 // Read configuration keys only; credentials remain owned exclusively by Codex CLI.
 let names=[];
 try{const {stdout}=await exec(pythonPath,['-B','-c','import tomllib,sys,json; print(json.dumps(list(tomllib.load(open(sys.argv[1],"rb")).get("mcp_servers",{}))))',join(home,'config.toml')],{maxBuffer:1024*1024});names=JSON.parse(stdout);}catch(error){try{await readFile(join(home,'config.toml'));}catch(e){if(e.code==='ENOENT')return isolationArgumentsFromNames([]);throw Error('无法确认 Codex 扩展隔离配置');}throw Error('无法确认 Codex 扩展隔离配置');}
 return isolationArgumentsFromNames(names);
}
export function isolationArgumentsFromNames(names){
 if(names.some(name=>!/^[-a-zA-Z0-9_]+$/.test(name)))throw Error('MCP 配置键无法安全覆盖，传输未启动');
 const overrides=['approval_policy="never"','sandbox_mode="read-only"','web_search="disabled"','notify=[]','tools.experimental_request_user_input.enabled=false','orchestrator.skills.enabled=false','orchestrator.mcp.enabled=false','skills.include_instructions=false','project_doc_max_bytes=0','project_doc_fallback_filenames=[]','developer_instructions=""','analytics.enabled=false',...disabled.map(name=>'features.'+name+'=false'),...names.map(name=>'mcp_servers.'+name+'={command="/usr/bin/false",enabled=false}')];
 return overrides.flatMap(value=>['-c',value]);
}
// Only recognize transient transport failures; never persist upstream error text or URLs.
export function transientNetworkFailure(error){
 const detail=String(error?.message??'')+' '+String(error?.additionalDetails??'');
 return /tls handshake eof|connection reset by peer|connection closed before message completed|unexpected eof|connection timed out/i.test(detail);
}
export function temporaryModelCapacity(error){return /selected model is at capacity/i.test(String(error?.message??'')+' '+String(error?.additionalDetails??''));}
export class CodexTransport extends EventEmitter{
 constructor({command='codex',pythonPath='python3',spawnImpl=spawn,extraArgs=[],allowProbeProvider=false,codexHome}={}){super();if(typeof codexHome!=='string'||!isAbsolute(codexHome))throw Error('Codex 配置目录必须是绝对路径');this.codexHome=resolve(codexHome);this.command=command;this.pythonPath=pythonPath;this.spawnImpl=spawnImpl;this.extraArgs=extraArgs;this.allowProbeProvider=allowProbeProvider;this.pending=new Map();this.nextId=0;this.active=null;this.closed=false;}
 async start(){
  if(this.closed)throw Error('Codex 传输已关闭');
  if(this.child)return this.refreshStatus();
  await mkdir(this.codexHome,{recursive:true,mode:0o700});
  this.cwd=await mkdtemp(join(tmpdir(),'ai-reading-codex-'));
  await writeFile(join(this.cwd,'instructions.txt'),'You are a model serving a reading assistant. Use only explicitly supplied tools.');
  const args=['app-server','--stdio',...await isolationArguments({home:this.codexHome,pythonPath:this.pythonPath}),'-c','model_instructions_file='+JSON.stringify(join(this.cwd,'instructions.txt')),...this.extraArgs];
  const env=Object.fromEntries(['PATH','HOME','TMPDIR','LANG','LC_ALL','CODEX_HOME'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
  env.CODEX_HOME=this.codexHome;
  if(this.allowProbeProvider){env.NO_PROXY='127.0.0.1,localhost';env.no_proxy=env.NO_PROXY;}
  this.child=this.spawnImpl(this.command,args,{cwd:this.cwd,env,stdio:['pipe','pipe','pipe']});
  this.child.stderr.resume();let buffer='';
  this.child.stdout.setEncoding('utf8');this.child.stdout.on('data',chunk=>{buffer+=chunk;if(buffer.length>16*1024*1024){this.fail(Error('Codex 响应超过传输上限'));return;}let cut;while((cut=buffer.indexOf('\n'))>=0){const row=buffer.slice(0,cut);buffer=buffer.slice(cut+1);try{this.receive(JSON.parse(row));}catch{this.fail(Error('Codex 返回了无效协议消息'));}}});
  this.child.on('error',()=>this.fail(Error('无法启动本机 Codex CLI')));this.child.on('exit',()=>this.fail(Error('Codex 连接已关闭')));
  try{
   await this.request('initialize',{clientInfo:{name:'ai_reading_model_transport',version:'0.1.0'},capabilities:{experimentalApi:true}});this.notify('initialized',{});
   return await this.refreshStatus();
  }catch(error){await this.close();throw error;}
 }
 async refreshStatus(){
   const account=await this.request('account/read',{refreshToken:false});

   const models=await this.request('model/list',{}),model=models.data?.find(x=>x.isDefault&&!x.hidden)??models.data?.find(x=>!x.hidden);

   const check=await this.request('thread/start',this.threadParams({model:model?.model??model?.id,dynamicTools:[]}));
   const instructionAllowed=this.instructionsAllowed(check.instructionSources??[]);
   const mcp=await this.request('mcpServerStatus/list',{});
   const extensionsDisabled=(mcp.data??[]).every(x=>!x.serverInfo&&!Object.keys(x.tools??{}).length&&!(x.resources??[]).length&&!(x.resourceTemplates??[]).length);
   const {stdout:versionText}=await exec(this.command,['--version'],{maxBuffer:4096});
   const versionVerified=/^codex-cli 0\.144\.6\s*$/.test(versionText);
   const isolationVerified=instructionAllowed&&extensionsDisabled&&versionVerified;
   const loggedIn=account.account?.type==='chatgpt';
   this.public={available:loggedIn&&!!model&&isolationVerified,reason:!isolationVerified?'Codex 指令或扩展隔离检查未通过':!loggedIn?'请先登录 ChatGPT':!model?'Codex 暂无可用模型':null,isolationVerified,authType:loggedIn?'chatgpt':'unavailable',model:model?.model??model?.id??null};
   return this.public;
 }
 instructionsAllowed(sources){return sources.length===0;}
 threadParams({model,developerInstructions='',dynamicTools=[],modelProvider}={}){return {model,...(modelProvider&&this.allowProbeProvider?{modelProvider}:{}),cwd:this.cwd,ephemeral:true,environments:[],runtimeWorkspaceRoots:[],selectedCapabilityRoots:[],sandbox:'read-only',approvalPolicy:'never',baseInstructions:'You are a model serving an external reading agent. Use only explicitly supplied dynamic tools. Do not access files, commands, projects, extensions or external resources.',developerInstructions,dynamicTools,config:{web_search:'disabled',project_doc_max_bytes:0}};}
 async login(){await this.start();const result=await this.request('account/login/start',{type:'chatgpt'});if(result.type!=='chatgpt')throw Error('Codex 返回了非 ChatGPT 登录流程');return {type:result.type,loginId:result.loginId,authUrl:result.authUrl};}
 async cancelLogin(loginId){return this.request('account/login/cancel',{loginId});}
 send(message){if(!this.child?.stdin.writable)throw Error('Codex 传输未连接');this.child.stdin.write(JSON.stringify(message)+'\n');}
 notify(method,params){this.send({method,params});}
 request(method,params,timeoutMs=30000){const id=++this.nextId;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('Codex 请求超时：'+method));},timeoutMs);this.pending.set(id,{resolve,reject,timer});try{this.send({id,method,params});}catch(e){clearTimeout(timer);this.pending.delete(id);reject(e);}});}
 receive(message){
  if(message.id!==undefined&&!message.method){const p=this.pending.get(message.id);if(!p)return;this.pending.delete(message.id);clearTimeout(p.timer);message.error?p.reject(Error('Codex 协议请求失败（'+String(message.error.code??'unknown')+'）')):p.resolve(message.result);return;}
  const active=this.active,p=message.params??{};
  if(message.id!==undefined){
   if(message.method==='item/tool/call'&&active&&p.threadId===active.threadId&&active.allowed.has(p.tool)){
    active.turnId??=p.turnId;active.push({type:'toolCall',callId:p.callId,name:p.tool,arguments:p.arguments});
    // Outer Harness executes the tool. This ephemeral turn never receives a fabricated success.
    active.toolRequested=true;active.finish('tool-calls');void this.interrupt();return;
   }
   this.send({id:message.id,error:{code:-32601,message:'This model-only client does not authorize this operation'}});if(active)active.fail(Error('Codex 请求了未授权工具'));return;
  }
  if(message.method==='account/login/completed')this.emit('loginCompleted',{loginId:p.loginId,success:p.success===true,error:p.success?null:'ChatGPT 登录未完成'});
  this.emit('notification',{method:message.method,params:p});
  if(!active||p.threadId&&p.threadId!==active.threadId)return;
  if(message.method==='error'){active.transientNetwork=transientNetworkFailure(p.error);active.modelBusy=temporaryModelCapacity(p.error);}
  if(message.method==='turn/started'){active.turnId=p.turn?.id??p.turnId;}
  if(message.method==='item/agentMessage/delta')active.push({type:'textDelta',text:p.delta??'',itemId:p.itemId});
  if(message.method==='turn/completed'){
   const status=p.turn?.status;active.completed=true;
   const terminalError=p.turn?.error;
   const transient=terminalError?transientNetworkFailure(terminalError):active.transientNetwork;
   const busy=terminalError?temporaryModelCapacity(terminalError):active.modelBusy;
   if(status==='failed')active.fail(Object.assign(Error('Codex 本轮回答失败'),{code:transient?'CODEX_TRANSIENT_NETWORK':busy?'CODEX_MODEL_BUSY':'CODEX_TURN_FAILED'}));
   else if(status==='completed'||status==='interrupted')active.finish(status==='interrupted'?'cancelled':'stop');
   else active.fail(Error('Codex 返回了未知回合结束状态'));
  }
 }
 async *stream({prompt,developerInstructions='',model,dynamicTools=[],signal,modelProvider}={}){
  if(this.active)throw Error('该 Codex 传输已有活动请求');await this.start();
  if(signal?.aborted)return;
  if(!this.allowProbeProvider&&!this.public.available)throw Error(this.public.reason??'Codex 模型隔离尚未验证');
  if(typeof prompt!=='string'||typeof developerInstructions!=='string')throw TypeError('文本上下文无效');
  const tools=dynamicTools.map(t=>({type:'function',name:t.name,description:t.description??'',inputSchema:t.inputSchema??t.parameters,deferLoading:false}));
  if(tools.length>1||tools.some(t=>t.name!=='reading_search'||!t.inputSchema))throw Error('动态工具定义无效');
  const thread=await this.request('thread/start',this.threadParams({model:model??this.public.model,developerInstructions,dynamicTools:tools,modelProvider}));
  if(!this.instructionsAllowed(thread.instructionSources??[]))throw Error('检测到未授权的工程指令，已停止');
  let queue=[],waiter,error,done=false,finishReason;
  const wake=()=>{waiter?.();waiter=null;};
  const active={threadId:thread.thread.id,turnId:null,allowed:new Set(tools.map(x=>x.name)),push:value=>{queue.push(value);wake();},finish:reason=>{if(done)return;done=true;finishReason=reason;wake();},fail:e=>{error=e;done=true;wake();}};this.active=active;
  const abort=()=>{active.finish('cancelled');void this.interrupt();};signal?.addEventListener('abort',abort,{once:true});
  try{
   const started=await this.request('turn/start',{threadId:active.threadId,input:[{type:'text',text:prompt}],environments:[],runtimeWorkspaceRoots:[]});active.turnId??=started.turn?.id;
   if(signal?.aborted)abort();
   while(!done||queue.length){if(queue.length){yield queue.shift();continue;}await new Promise(resolve=>waiter=resolve);}
   if(error)throw error;yield {type:'done',finishReason};
  }finally{signal?.removeEventListener('abort',abort);await this.interrupt().catch(()=>{});if(this.active===active)this.active=null;}
 }
 async interrupt(){const active=this.active;if(!active?.completed&&active?.threadId&&active?.turnId&&this.child?.stdin.writable)try{await this.request('turn/interrupt',{threadId:active.threadId,turnId:active.turnId},1500);}catch{}}
 fail(error){for(const item of this.pending.values()){clearTimeout(item.timer);item.reject(error);}this.pending.clear();if(!this.closed)this.active?.fail(error);}
 async close(){
  if(this.closePromise)return this.closePromise;
  this.closePromise=this.closeOwnedProcess();return this.closePromise;
 }
 async closeOwnedProcess(){
  this.closed=true;this.active?.finish('cancelled');await this.interrupt();this.fail(Error('Codex 传输已关闭'));
  const child=this.child;this.child=null;
  if(child){
   const exited=()=>child.exitCode!==null&&child.exitCode!==undefined||child.signalCode!=null;
   const waitExit=ms=>new Promise(resolve=>{
    if(exited()){resolve(true);return;}
    const onExit=()=>{clearTimeout(timer);resolve(true);};
    const timer=setTimeout(()=>{child.removeListener('exit',onExit);resolve(exited());},ms);
    child.once('exit',onExit);
   });
   child.stdin.end();
   if(!await waitExit(1000)){child.kill('SIGTERM');if(!await waitExit(1000)){child.kill('SIGKILL');if(!await waitExit(1000))throw Error('Codex 子进程退出未得到确认');}}
  }
  if(this.cwd)await rm(this.cwd,{recursive:true,force:true});
 }
}
