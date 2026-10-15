import {CodexTransport} from './codex-transport.mjs';
import {resolveCodexPath} from './codex-path.mjs';

// OAuth is handled by the official CLI. No token is returned to the renderer or read here.
export async function beginCodexLogin({codexHome,pythonPath,openURL,timeoutMs=300000,transportFactory=options=>new CodexTransport(options),resolveCommand=resolveCodexPath}={}){
 const command=(await resolveCommand()).path;
 const transport=transportFactory({command,codexHome,pythonPath});
 let loginId,timer,settled=false,finish,fail;
 const completed=new Promise((resolve,reject)=>{finish=resolve;fail=reject});
 // A browser launch error can occur before the caller receives completed.
 completed.catch(()=>{});
 const cleanup=async()=>{clearTimeout(timer);transport.removeListener('loginCompleted',onCompleted);await transport.close();};
 const settle=async(error)=>{if(settled)return;settled=true;await cleanup();error?fail(error):finish({authenticated:true})};
 const onCompleted=event=>{if(event.loginId!==loginId)return;void settle(event.success?null:Error('ChatGPT 登录未完成，请重试'));};
 try{
  await transport.start();transport.on('loginCompleted',onCompleted);
  const login=await transport.login();loginId=login.loginId;
  const url=new URL(login.authUrl);
  if(login.type!=='chatgpt'||url.protocol!=='https:'||url.hostname!=='auth.openai.com'||url.username||url.password)throw Error('Codex 返回了非预期的登录地址');
  timer=setTimeout(()=>{void transport.cancelLogin(loginId).catch(()=>{});void settle(Error('ChatGPT 登录等待超时，请重新登录'));},timeoutMs);
  await openURL(url.href);
  return {completed,cancel:async()=>{await transport.cancelLogin(loginId).catch(()=>{});await settle(Error('ChatGPT 登录已取消'));}};
 }catch{await settle(Error('无法开始 ChatGPT 登录，请检查网络后重试'));throw Error('无法开始 ChatGPT 登录，请检查网络后重试');}
}
