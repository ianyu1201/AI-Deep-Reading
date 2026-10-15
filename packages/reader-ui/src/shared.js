import {createElement} from 'lucide';
import {nodes} from './icon-map.js';
export const $=s=>document.querySelector(s);
export function icon(name){return createElement(nodes[name]??FileText,{width:20,height:20,'stroke-width':1.75,'aria-hidden':'true'})}
export function icons(){for(const el of document.querySelectorAll('[data-icon]')){el.replaceChildren(icon(el.dataset.icon));if(el.tagName==='BUTTON'&&el.getAttribute('aria-label')&&!el.title)el.title=el.getAttribute('aria-label')}}
export function el(tag,cls,content){const x=document.createElement(tag);if(cls)x.className=cls;if(content!==undefined)x.textContent=content;return x}
export function button(label,name,fn,cls='icon-button'){const b=el('button',cls);b.type='button';b.title=label;b.setAttribute('aria-label',label);if(name)b.append(icon(name));else b.textContent=label;if(fn)b.onclick=fn;return b}
export const storage={get(k,d){try{return JSON.parse(localStorage.getItem(k))??d}catch{return d}},set(k,v){try{localStorage.setItem(k,JSON.stringify(v));return true}catch{return false}}};
export function toast(msg){let n=$('#toast');if(!n){n=el('div','toast');n.id='toast';n.role='status';document.body.append(n)}n.textContent=msg;n.hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>n.hidden=true,3500)}
export function download(name,body){const url=URL.createObjectURL(new Blob([body],{type:'text/markdown;charset=utf-8'}));const a=el('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}

window.addEventListener('ai-reading:lifecycle-error',e=>toast('显示调整未完成：'+e.detail.message));
