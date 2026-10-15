export function installSessionUI({bridge,getScope,getCurrent,selectSession,refresh,showError,getDraft}) {
 const $=id=>document.getElementById(id),panel=$('session-drawer');let rows=[],generation=0;
 const visible=value=>{for(const node of panel.parentElement.children)if(node!==panel)node.inert=value;return window.readingMotion?.visibility(panel,value,{trigger:$('session-history'),kind:'menu'})??(panel.hidden=!value)};
 const close=()=>{generation++;visible(false);$('session-history').focus()};
 function render(){
  const query=$('session-search').value.trim().toLocaleLowerCase(),filter=$('session-filter').value,list=$('session-list');list.replaceChildren();
  for(const row of rows.filter(r=>(r.lifecycle||'active')===filter&&r.title.toLocaleLowerCase().includes(query))){
   const item=document.createElement('article');item.className='session-row';item.dataset.current=String(row.sessionId===getCurrent());item.dataset.sessionId=row.sessionId;
   const open=document.createElement('button');open.className='session-open';open.textContent=row.title+(row.role==='default'?' · 默认':'');open.disabled=filter!=='active';open.onclick=async()=>{if(await selectSession(row.sessionId))close()};
   const detail=document.createElement('small');detail.textContent=(row.status==='running'?'回答中 · ':row.status==='queued'?'排队中 · ':'')+new Date(row.updatedAt).toLocaleString('zh-CN');
   item.append(open,detail);
   const actions=document.createElement('div');actions.className='session-row-actions';
   const add=(text,action)=>{const b=document.createElement('button');b.textContent=text;b.onclick=()=>confirm(row,action,b);actions.append(b)};
   add('改名','rename');if(filter==='active'&&row.role!=='default')add('归档','archive');if(filter!=='active')add('恢复','restore');if(filter!=='deleted')add('移入回收站','trash');item.append(actions);list.append(item);
  }
  if(!list.children.length){const p=document.createElement('p');p.textContent=query?'没有匹配的会话':'这里还没有会话';list.append(p)}
 }
 async function load(){const g=++generation,scope=getScope();$('session-list').textContent='正在载入会话…';try{const data=await bridge.sessions('list',{scope});if(g!==generation||JSON.stringify(scope)!==JSON.stringify(getScope()))return;rows=data.sessions;if(data.warning)showError(data.warning);render()}catch(e){if(g!==generation)return;$('session-list').textContent='会话载入失败，请关闭后重试';showError(e.message)}}
 function confirm(row,action,trigger){
  const confirmScope=getScope(),ticket=generation;const valid=()=>ticket===generation&&JSON.stringify(confirmScope)===JSON.stringify(getScope());
  const box=$('session-confirm');box.hidden=false;box.replaceChildren();const title=document.createElement('h3');title.textContent=action==='trash'?'将会话移入回收站？':action==='rename'?'修改会话名称':action==='archive'?'归档会话？':'恢复会话？';box.append(title);
  const info=document.createElement('p');info.textContent=`「${row.title}」`+(action==='trash'?`${getDraft(row.sessionId)?'含未发送草稿，将一并保留。':''}${['running','queued'].includes(row.status)?'将先停止此会话本轮回答。':''}不会删除书籍、标注或知识笔记；可从回收站恢复。${row.role==='default'?'删除后建立空的替代默认会话。':''}`:'');box.append(info);
  const input=document.createElement('input');input.value=row.title;input.maxLength=120;input.setAttribute('aria-label','会话名称');if(action==='rename')box.append(input);
  const cancel=document.createElement('button');cancel.textContent='取消';cancel.onclick=()=>{box.hidden=true;trigger.focus()};
  const save=document.createElement('button');save.textContent='确认';let composing=false;input.addEventListener('compositionstart',()=>composing=true);input.addEventListener('compositionend',()=>composing=false);
  save.onclick=async()=>{if(composing)return;save.disabled=true;cancel.disabled=true;const scope=confirmScope;try{await bridge.sessions(action,{scope,sessionId:row.sessionId,...(action==='rename'?{title:input.value.trim()}: {})});if(!valid())return;box.hidden=true;trigger.focus();await refresh(row.sessionId===getCurrent()&&['trash','archive'].includes(action));if(valid())await load()}catch(e){if(valid()){showError(e.message);let error=box.querySelector('[role=alert]');if(!error){error=document.createElement('p');error.setAttribute('role','alert');box.append(error)}error.textContent=e.message}}finally{save.disabled=false;cancel.disabled=false}};box.append(cancel,save);(action==='rename'?input:cancel).focus();
 }
 $('session-history').onclick=()=>{visible(true);load();$('session-search').focus()};$('session-close').onclick=close;$('session-search').oninput=render;$('session-filter').onchange=render;
 panel.addEventListener('keydown',e=>{if(e.key==='Escape'&&!e.isComposing){e.preventDefault();e.stopPropagation();if(!$('session-confirm').hidden){$('session-confirm').hidden=true;$('session-search').focus()}else close()}});
 return {status(event){if(!event.status)return;const row=rows.find(r=>r.sessionId===event.sessionId);if(!row)return;row.status=event.status;const node=[...panel.querySelectorAll('.session-row')].find(n=>n.dataset.sessionId===event.sessionId)?.querySelector('small');if(node)node.textContent=(row.status==='running'?'回答中 · ':row.status==='queued'?'排队中 · ':'')+new Date(row.updatedAt).toLocaleString('zh-CN')},changed(){generation++;visible(false);$('session-confirm').hidden=true;$('session-search').value='';$('session-filter').value='active'},load};
}
