import {$,el} from './shared.js';

export function installAppleLibraryPanel({bridge,onImported}) {
 const trigger=$('#apple-connect'),dialog=$('#apple-books-dialog');
 trigger.hidden=!bridge;
 if(!bridge)return;
 const state={books:[],selected:new Set(),busy:false,connected:false,results:new Map()};
 const status=$('#apple-status');
 function controls(){
  $('#apple-refresh').disabled=state.busy;$('#apple-disconnect').disabled=state.busy||!state.connected;
  $('#apple-select-all').disabled=state.busy||!state.books.some(b=>b.available);
  $('#apple-import').disabled=state.busy||!state.selected.size;
  $('#apple-import').textContent=`纳入所选书籍${state.selected.size?'（'+state.selected.size+'）':''}`;
  for(const checkbox of dialog.querySelectorAll('[data-apple-id]'))checkbox.disabled=state.busy||!state.books.find(b=>b.id===checkbox.dataset.appleId)?.available;
 }
 function render(){
  const list=$('#apple-books-list');list.replaceChildren();
  for(const book of state.books){
   const row=el('label','apple-book-row'),check=el('input');check.type='checkbox';check.dataset.appleId=book.id;check.checked=state.selected.has(book.id);check.setAttribute('aria-label',book.title);
   check.onchange=()=>{check.checked?state.selected.add(book.id):state.selected.delete(book.id);controls();};
   const text=el('span','apple-book-details'),title=el('strong','',book.title),author=el('span','',book.author);title.title=book.title;
   const result=state.results.get(book.id);text.append(title,author,el('span','apple-book-status',result?.message??book.reason));row.append(check,text);list.append(row);
  }
  controls();
 }
 async function scan(){
  if(state.busy)return;state.busy=true;controls();status.textContent='正在只读扫描本机 Apple Books…';
  try{const result=await bridge.appleBooks('scan');state.books=result.books;state.connected=true;state.selected=new Set();state.results.clear();render();status.textContent=`找到 ${result.books.length} 本书，${result.books.filter(b=>b.available).length} 本可纳入。${result.issues.map(x=>x.message).join('；')}`;}
  catch(error){status.textContent='扫描未完成：'+error.message;}
  finally{state.busy=false;controls();}
 }
 trigger.onclick=()=>{dialog.showModal();if(!state.connected)void scan();};
 $('#apple-close').onclick=()=>{dialog.close();trigger.focus();};
 dialog.addEventListener('cancel',()=>{requestAnimationFrame(()=>trigger.focus());});
 $('#apple-refresh').onclick=scan;
 $('#apple-select-all').onclick=()=>{const available=state.books.filter(b=>b.available);const all=available.every(b=>state.selected.has(b.id));state.selected=new Set(all?[]:available.map(b=>b.id));render();};
 $('#apple-disconnect').onclick=async()=>{
  try{await bridge.appleBooks('disconnect');state.connected=false;state.books=[];state.selected.clear();state.results.clear();render();status.textContent='已解除连接。已纳入的书籍、笔记和学习记录保持不变。';}
  catch(error){status.textContent=error.message;}
 };
 $('#apple-import').onclick=async()=>{
  if(state.busy||!state.selected.size)return;state.busy=true;state.results.clear();controls();status.textContent='准备纳入所选书籍…';
  try{const result=await bridge.appleBooks('import',{ids:[...state.selected]});for(const r of result.results)state.results.set(r.id,r);onImported(result.books);render();status.textContent=`纳入完成：新增 ${result.imported} 本，已存在 ${result.duplicates} 本，失败 ${result.failed} 本。`;}
  catch(error){status.textContent='纳入未完成：'+error.message;}
  finally{state.busy=false;controls();}
 };
 bridge.onAppleProgress(progress=>{
  if(progress.result){state.results.set(progress.result.id,progress.result);render();}
  if(progress.phase!=='complete')status.textContent=`正在纳入 ${progress.completed}/${progress.total}${progress.title?'：'+progress.title:''}`;
 });
}
