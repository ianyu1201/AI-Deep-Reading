// These IDs belong to the prototype catalog (or temporary imported File).
// They are not business book_id / book_version_id values.
export function installBookContext(target=window){
 let snapshot=Object.freeze({id:'',title:'',author:'',open:false,intent:''});
 const publish=()=>target.dispatchEvent(new CustomEvent('ai-reading:book-context',{
  detail:snapshot
 }));
 const text=value=>typeof value==='string'?value:'';
 Object.defineProperty(target,'aiReadingContext',{
  configurable:false,writable:false,
  value:Object.freeze({getSnapshot:()=>snapshot})
 });
 target.addEventListener('ai-reading:context-request',publish);
 publish();
 return Object.freeze({
  begin(id){const intent=crypto.randomUUID();target.dispatchEvent(new CustomEvent('ai-reading:book-opening',{detail:{id,intent}}));return intent;},
  opened(book,intent){
   snapshot=Object.freeze({id:text(book.id),title:text(book.title),author:text(book.author),open:true,intent});
   publish();
  },
  closed(){
   if(!snapshot.open)return;
   snapshot=Object.freeze({...snapshot,open:false});
   publish();
  }
 });
}
