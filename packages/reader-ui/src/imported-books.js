// Files live only in this renderer's memory. The host sees metadata, never paths or bytes.
export class ImportedBooks {
 #files = new Map();
 remember(meta,file){
  const id='local:'+meta.id;
  this.#files.set(id,file);
  return {id,title:meta.title,author:'本地文件',cover:''};
 }
 get(id){return this.#files.get(id)}
}
