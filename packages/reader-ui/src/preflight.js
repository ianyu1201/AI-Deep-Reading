import JSZip from 'jszip';
export async function inspectFile(file){
 if(file.size>30*1024*1024)throw new Error('本原型支持不超过 30 MB 的 EPUB。');
 const buffer=await file.arrayBuffer();
 const zip=await JSZip.loadAsync(buffer);
 const entries=Object.values(zip.files);let expanded=0;
 for(const e of entries){expanded+=e._data?.uncompressedSize??0;if(expanded>120*1024*1024||entries.length>4000)throw new Error('书籍展开后过大，超出原型验证范围。')}
 const parser=new DOMParser();
 const read=async path=>{const entry=zip.file(path);if(!entry)throw new Error('缺少必要书籍文件：'+path);return entry.async('string')};
 const container=parser.parseFromString(await read('META-INF/container.xml'),'application/xml');
 const opfPath=container.querySelector('rootfile')?.getAttribute('full-path');if(!opfPath)throw new Error('无法找到 EPUB 包文件。');
 const opf=parser.parseFromString(await read(opfPath),'application/xml');if(opf.querySelector('parsererror'))throw new Error('EPUB 包信息格式不正确。');
 const root=opfPath.includes('/')?opfPath.slice(0,opfPath.lastIndexOf('/')+1):'';
 const manifest=new Map([...opf.getElementsByTagName('item')].map(i=>[i.getAttribute('id'),i]));
 const sections=[...opf.getElementsByTagName('itemref')].map(ref=>manifest.get(ref.getAttribute('idref'))).filter(Boolean).map(i=>i.getAttribute('href'));
 if(!sections.length)throw new Error('这本书没有可阅读的正文。');
 const missing=[...manifest.values()].filter(i=>!zip.file(root+decodeURIComponent(i.getAttribute('href').split('#')[0]))).map(i=>i.getAttribute('href'));
 const search=[];
 for(const href of sections){
  if(!zip.file(root+href))continue;
  const doc=parser.parseFromString(await read(root+href),'application/xhtml+xml');
  for(const node of doc.querySelectorAll('h1,h2,p,li,td')){
   const value=node.textContent.trim();if(value)search.push({text:value,href:href+(node.id?'#'+node.id:'')});
  }
 }
 const digest=await crypto.subtle.digest('SHA-256',buffer);
 return {buffer,root,id:[...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('').slice(0,24),title:opf.getElementsByTagName('dc:title')[0]?.textContent??file.name,sections,search,missing,fixed:[...opf.getElementsByTagName('meta')].some(m=>m.getAttribute('property')==='rendition:layout'&&m.textContent==='pre-paginated')};
}
