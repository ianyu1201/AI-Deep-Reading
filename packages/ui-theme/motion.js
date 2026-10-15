// Shared across isolated documents. Animation completion never means content readiness.
(() => {
 const reduced=matchMedia('(prefers-reduced-motion: reduce)'), active=new Map(), targets=new WeakMap();
 const duration=Object.fromEntries(['feedback','local','page','immersive'].map(k=>[k,parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--motion-'+k))||0]));
 const ease=getComputedStyle(document.documentElement).getPropertyValue('--motion-ease').trim()||'ease-out';
 function cancel(node){const item=active.get(node);if(item){active.delete(node);item.cancel();}delete node.dataset.motion;}
 async function animate(node,frames,kind='local',ms=duration[kind]){
  cancel(node);if(reduced.matches||!node.animate)return;
  const a=node.animate(frames,{duration:ms,easing:ease});active.set(node,a);node.dataset.motion='running';
  try{await a.finished}catch{}finally{if(active.get(node)===a){active.delete(node);delete node.dataset.motion;}}
 }
 async function visibility(node,visible,{trigger,kind='local'}={}){
  const previous=targets.get(node)??!node.hidden;if(previous===visible)return;
  targets.set(node,visible);cancel(node);
  if(!visible){node.inert=true;node.setAttribute('aria-hidden','true');if(node.contains(document.activeElement)&&trigger?.isConnected)trigger.focus();}
  else {node.hidden=false;node.inert=false;node.removeAttribute('aria-hidden');}
  await animate(node,visible?[{opacity:0,transform:'translateY(4px)'},{opacity:1,transform:'none'}]:[{opacity:1,transform:'none'},{opacity:0,transform:'translateY(3px)'}],kind);
  if(targets.get(node)!==visible)return;
  node.hidden=!visible;node.inert=!visible;
  if(!visible&&trigger?.isConnected&&document.activeElement===document.body)trigger.focus();
 }
 function shown(node){return targets.get(node)??!node.hidden}
 function enter(node,kind='local'){return animate(node,[{opacity:0,transform:'translateY(4px)'},{opacity:1,transform:'none'}],kind)}
 let surfaceVersion=0;
 const surfaces=(ids)=>document.getElementById('guide-panel')?(ids??['guide-panel','resources','chat-panel']).map(id=>document.getElementById(id)):[document.body];
 async function surface(phase,kind='page',ids){
  const version=++surfaceVersion;
  // Superseding a partial transition must not strand surfaces from its predecessor.
  const selected=surfaces(ids);for(const node of surfaces())if(!selected.includes(node)&&(node.style.opacity!==''||node.style.pointerEvents==='none')){cancel(node);node.style.opacity='';node.style.pointerEvents='';}
  await Promise.all(selected.map(async node=>{
   cancel(node);
   if(phase==='cancel'){node.style.opacity='';node.style.pointerEvents='';return;}
   if(phase==='hold'){node.style.opacity='0';node.style.pointerEvents='none';return;}
   if(phase==='out'){
    node.style.pointerEvents='none';
    if(!node.hidden)await animate(node,[{opacity:1},{opacity:0}],'feedback');
    if(version===surfaceVersion)node.style.opacity='0';
   }else{
    node.style.opacity='';node.style.pointerEvents='none';
    if(!node.hidden)await animate(node,[{opacity:0},{opacity:1}],kind,Math.max(0,duration[kind]-duration.feedback));
    if(version===surfaceVersion)node.style.pointerEvents='';
   }
  }));
 }
 function cleanup(){surfaceVersion++;for(const node of [...active.keys()])cancel(node);for(const node of surfaces()){node.style.opacity='';node.style.pointerEvents='';}}
 reduced.addEventListener('change',()=>{for(const node of [...active.keys()])cancel(node)});
 window.addEventListener('pagehide',cleanup);
 Object.defineProperty(window,'readingMotion',{value:Object.freeze({visibility,shown,enter,animate,cancel,surface,cleanup,reduced,duration})});
})();
