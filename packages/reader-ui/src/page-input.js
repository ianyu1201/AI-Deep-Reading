// One in-flight turn and one replaceable pending intent. Navigation/reflow owns
// cancellation: already displayed motion settles, queued input never leaks across views.
export class PageTurnCoordinator {
 constructor({turn,available=()=>true,changed=()=>{},error=()=>{}}){Object.assign(this,{turn,available,changed,error});this.pending=null;this.running=null;this.epoch=0;}
 request(direction){if(!this.available())return this.running??Promise.resolve();this.pending=direction;if(!this.running)this.running=this.drain();return this.running;}
 async drain(){const epoch=this.epoch;this.changed('turning');try{while(this.pending&&epoch===this.epoch&&this.available()){const direction=this.pending;this.pending=null;await this.turn(direction);}}catch(error){this.pending=null;this.error(error)}finally{this.running=null;this.changed('idle');if(this.pending&&this.available())this.running=this.drain();}}
 cancel(){this.epoch++;this.pending=null;return this.running??Promise.resolve();}
}
// Device-agnostic wheel intent: lock the dominant axis for one gesture,
// consume its inertia once, and allow a deliberate opposite threshold to cancel it.
export class WheelGesture {
 constructor({threshold=52,idle=160,lock=12}={}){Object.assign(this,{threshold,idle,lock});this.reset();}
 reset(){this.last=-Infinity;this.x=0;this.y=0;this.axis=null;this.fired=false;this.sign=0;this.reverse=0;}
 feed({deltaX=0,deltaY=0,deltaMode=0,timeStamp}){
  const time=Number.isFinite(timeStamp)?timeStamp:0;if(time-this.last>this.idle)this.reset();this.last=time;
  const scale=deltaMode===1?16:deltaMode===2?600:1;const dx=deltaX*scale,dy=deltaY*scale;
  this.x+=dx;this.y+=dy;
  if(!this.axis&&Math.max(Math.abs(this.x),Math.abs(this.y))>=this.lock)this.axis=Math.abs(this.x)>Math.abs(this.y)*1.25?'x':'y';
  if(!this.axis)return {consume:true};
  const delta=this.axis==='x'?dx:dy,total=this.axis==='x'?this.x:this.y;
  if(this.fired){
   this.reverse=Math.sign(delta)===-this.sign?this.reverse+Math.abs(delta):0;
   if(this.reverse<this.threshold)return {consume:true};
   this.sign=-this.sign;this.reverse=0;return {consume:true,direction:this.sign>0?'next':'prev'};
  }
  if(Math.abs(total)<this.threshold)return {consume:true};
  this.fired=true;this.sign=Math.sign(total);return {consume:true,direction:this.sign>0?'next':'prev'};
 }
}
