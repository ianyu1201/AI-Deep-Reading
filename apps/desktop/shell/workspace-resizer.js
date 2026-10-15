// One in-flight native resize, at most one every 160ms. Final sizes await
// reader readiness; pointer capture keeps the drag on this separator.
export function installWorkspaceResizer(node, bridge, getState, onError) {
 let gesture=null, timer=null, busy=false, last=0;
 const pump=async()=>{
  clearTimeout(timer);timer=null;
  if(busy||!gesture)return;
  const g=gesture,phase=g.phase,width=g.width;
  if(phase==='update'&&performance.now()-last<160){timer=setTimeout(pump,160-(performance.now()-last));return;}
  busy=true;last=performance.now();g.dirty=false;
  try{
   const result=await bridge.setChatWidth({id:g.id,phase,width});
   if(gesture!==g)return;
   if(!result.accepted||phase==='end'||phase==='cancel'){gesture=null;node.classList.remove('dragging');delete node.dataset.dragging;return;}
   if(g.phase==='begin')g.phase='update';
  }catch(e){gesture=null;node.classList.remove('dragging');delete node.dataset.dragging;onError(e);}
  finally{busy=false;if(gesture&&(gesture.dirty||['end','cancel'].includes(gesture.phase)))void pump();}
 };
 const finish=(cancel=false)=>{if(!gesture)return;gesture.phase=cancel?'cancel':'end';gesture.dirty=true;void pump();};
 node.addEventListener('pointerdown',e=>{
  if(e.button!==0||gesture)return;e.preventDefault();node.focus();node.setPointerCapture(e.pointerId);
  gesture={id:crypto.randomUUID(),phase:'begin',width:getState().layout.chatWidth,startWidth:getState().layout.chatWidth,startX:e.clientX,dirty:true};node.classList.add('dragging');node.dataset.dragging='true';void pump();
 });
 node.addEventListener('pointermove',e=>{if(!gesture||!['begin','update'].includes(gesture.phase))return;const l=getState().layout;gesture.width=Math.max(l.chatMin,Math.min(l.chatMax,gesture.startWidth+gesture.startX-e.clientX));gesture.dirty=true;void pump();});
 node.addEventListener('pointerup',()=>finish());node.addEventListener('lostpointercapture',()=>{if(gesture&&['begin','update'].includes(gesture.phase))finish(true);});node.addEventListener('pointercancel',()=>finish(true));
 node.addEventListener('keydown',async e=>{
  if(e.key==='Escape'&&gesture){e.preventDefault();finish(true);return;}
  if(gesture||!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();
  const l=getState().layout,width=e.key==='Home'?l.chatMin:e.key==='End'?l.chatMax:l.chatWidth+(e.key==='ArrowLeft'?1:-1)*(e.shiftKey?40:16),id=crypto.randomUUID();
  try{const result=await bridge.setChatWidth({id,phase:'begin',width});if(result.accepted)await bridge.setChatWidth({id,phase:'end',width});}catch(error){onError(error);}
 });
 window.addEventListener('blur',()=>finish(true));
 return ()=>{if(gesture&&(node.hidden||getState().immersive)){gesture=null;clearTimeout(timer);node.classList.remove('dragging');delete node.dataset.dragging;}};
}
