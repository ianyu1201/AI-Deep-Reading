// Host-controlled activation only; no paths, code strings, or RPC are accepted.
export function installLifecycle({view,activate,flush}){
  let activation=Promise.resolve(), scheduled=false;
  window.addEventListener('ai-reading:activate',()=>{
    if(scheduled)return;scheduled=true;
    activation=activation.catch(()=>{}).then(async()=>{scheduled=false;await activate()});
    activation.catch(error=>window.dispatchEvent(new CustomEvent('ai-reading:lifecycle-error',{detail:{view,message:error.message}})));
  });
  Object.defineProperty(window,'aiReadingLifecycle',{
    configurable:false,writable:false,
    value:Object.freeze({ready:()=>activation,flush:async()=>{
      try{return {ok:await flush()===true,kind:'browser-draft',view};}
      catch(error){return {ok:false,kind:'browser-draft',view,error:error.message};}
    }})
  });
}
