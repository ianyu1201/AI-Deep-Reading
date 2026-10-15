/** Reading chrome changes visibility only: never changes reader bounds or CFI. */
export function installReadingControls({getState,go,toast}) {
 const toolbar=document.querySelector('.reading-toolbar'),root=document.querySelector('#reading-view');
 const wake=document.createElement('button');wake.id='reading-controls-wake';wake.className='text-button';wake.textContent='显示阅读工具';wake.title='显示阅读工具（Tab）';wake.setAttribute('aria-label','显示阅读工具');wake.hidden=true;root.append(wake);
 const back=document.createElement('button');back.id='reading-jump-back';back.className='text-button';back.textContent='返回跳转前';back.hidden=true;back.title='返回跳转前的原文位置';document.querySelector('.reading-footer').prepend(back);
 let timer,hover=false,keyboard=false,history=[],generation=0,pending=new Map(),inFlight=new Set(),returning=false;
 const blocked=()=>hover||keyboard&&toolbar.contains(document.activeElement)||[...root.querySelectorAll('.popover,.annotation-editor,dialog')].some(x=>x.tagName==='DIALOG'?x.open:!x.hidden)||!!getState().view?.renderer?.getContents?.().some(({doc})=>doc.getSelection()?.type==='Range');
 function reveal(){clearTimeout(timer);root.classList.remove('reading-controls-hidden');wake.hidden=true;if(getState().immersive)timer=setTimeout(hide,2200);}
 function hide(){clearTimeout(timer);if(!getState().immersive)return;if(blocked()){timer=setTimeout(hide,700);return;}root.classList.add('reading-controls-hidden');wake.hidden=false;}
 function activity(e){if(e.target===wake&&e.type!=='keydown')return;if(e.type==='keydown'){keyboard=true;reveal();return;}keyboard=false;if(e.clientY<80)reveal();else if(!root.classList.contains('reading-controls-hidden')){clearTimeout(timer);timer=setTimeout(hide,2200);}}
 toolbar.addEventListener('pointerenter',()=>{hover=true;reveal();});toolbar.addEventListener('pointerleave',()=>{hover=false;reveal();});toolbar.addEventListener('focusin',reveal);wake.onclick=()=>{reveal();toolbar.querySelector('button:not([hidden])')?.focus();};
 window.addEventListener('pointermove',activity,{passive:true});window.addEventListener('keydown',activity,true);
 function load(doc){doc.addEventListener('pointermove',e=>activity({type:e.type,clientY:e.clientY+100}),{passive:true});doc.addEventListener('keydown',activity,true);doc.addEventListener('selectionchange',()=>{if(doc.getSelection()?.type==='Range')reveal();});}
 const render=()=>{back.hidden=!history.length;back.disabled=returning||inFlight.size>0;};
 function beforeJump(){const state=getState();const token=state.loc?.cfi?{bookId:state.book?.id,cfi:state.loc.cfi,generation}:null;if(token)inFlight.add(token);render();return token;}
 function afterJump(token,ok=true){inFlight.delete(token);render();if(!ok||!token||token.generation!==generation||token.bookId!==getState().book?.id||token.cfi===getState().loc?.cfi)return;if(history.at(-1)?.cfi!==token.cfi)history.push(token);history=history.slice(-12);render();reveal();}
 back.onclick=async()=>{if(returning||!history.length)return;const item=history.at(-1),epoch=generation;if(item.bookId!==getState().book?.id)return;returning=true;render();try{await go(item.cfi,{remember:false});if(epoch===generation){history.pop();render();}}catch(e){toast('未能返回原位置：'+e.message);}finally{returning=false;render();}};
 window.addEventListener('ai-reading:before-jump',e=>pending.set(e.detail?.requestId,beforeJump()));window.addEventListener('ai-reading:after-jump',e=>{const key=e.detail?.requestId;afterJump(pending.get(key),e.detail?.ok!==false);pending.delete(key);});
 window.addEventListener('ai-reading:book-context',()=>{generation++;history=[];pending.clear();inFlight.clear();render();reveal();});window.addEventListener('ai-reading:display-mode',()=>{hover=false;reveal();});window.addEventListener('pagehide',()=>clearTimeout(timer));
 return {load,reveal,beforeJump,afterJump};
}
