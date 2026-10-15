// Read-only presentation of known, bodyless book records. Never rewrites source.
export function bookMetadata(note){
 if(note?.data?.object_type!=='book'||String(note.body??'').trim())return null;
 const data=note.data;
 const text=value=>typeof value==='string'?value.trim():'';
 const fields=[['书名',text(data.title)],['作者',text(data.author)],['语言',text(data.language)],['出版社',text(data.publisher)],['出版日期',text(data.publication_date)]];
 return fields.filter(([,v])=>v&&!/(?:\/Users\/|[A-Za-z]:\\|file:\/\/|(?:api[_-]?key|token|secret)\s*[:=])/i.test(v));
}
export function renderBookMetadata(root,note){
 const fields=bookMetadata(note);if(!fields)return false;
 root.replaceChildren();const d=root.ownerDocument,dl=d.createElement('dl');dl.className='book-metadata';
 for(const [label,value] of fields){const dt=d.createElement('dt'),dd=d.createElement('dd');dt.textContent=label;dd.textContent=value;dl.append(dt,dd);}
 const p=d.createElement('p');p.className='book-metadata-status';p.textContent='书籍资料 · 只读';root.append(p,dl);return true;
}
