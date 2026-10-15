import JSZip from 'jszip';
import {mkdir, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const output=new URL('../fixtures/security/',import.meta.url);
const date=new Date('2026-10-11T00:00:00.000Z');
const escapeXML=text=>text.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;');

// Each payload only records execution in this frame/its direct parent. It never
// invokes an exposed bridge, reads files, uses credentials, or makes a request.
function payload(id,channel){
 return `(()=>{const hit={fixture:${JSON.stringify(id)},channel:${JSON.stringify(channel)},nodeVisible:typeof require!=='undefined'||typeof process!=='undefined',parentBridgeNames:[]};window.__epubSecurityProbe=window.__epubSecurityProbe||[];window.__epubSecurityProbe.push(hit);document.documentElement.setAttribute('data-security-probe-executed',${JSON.stringify(channel)});try{hit.parentBridgeNames=['aiReadingLifecycle','aiReadingDesktop','desktop','desktopAPI','electron'].filter(name=>typeof parent[name]!=='undefined');parent.__epubSecurityProbe=parent.__epubSecurityProbe||[];parent.__epubSecurityProbe.push(hit)}catch{}})()`;
}

await mkdir(output,{recursive:true});
const manifest=[];
for(const fixed of [false,true]){
 const id=fixed?'security-fixed-layout':'security-reflow';
 const title=fixed?'安全验证 · 固定版式':'安全验证 · 流式排版';
 const visibleToken=fixed?'FIXED_LAYOUT_READABLE':'REFLOW_READABLE';
 const script=payload(id,'inline-script');
 const onload=payload(id,'body-onload');
 const javascript=payload(id,'javascript-link');
 const chapter=`<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" lang="zh-CN"><head><title>${title}</title>${fixed?'<meta name="viewport" content="width=640,height=800"/>':''}
<style>html{background:#fff;color:#222}body{font-family:serif;line-height:1.8;padding:32px;${fixed?'box-sizing:border-box;width:640px;height:800px;margin:0;':''}}h1{font-size:26px}a{color:#365c88}</style>
<script type="text/javascript"><![CDATA[${script}]]></script></head>
<body onload="${escapeXML(onload)}"><h1>${title}</h1>
<p id="readable-token">${visibleToken}</p><p>这是原创的隔离验证正文。即使书内脚本被禁用，这段文字也应正常显示。</p>
<p><a id="security-javascript-link" href="javascript:${escapeXML(javascript)}">点击测试链接（不得执行脚本）</a></p>
<p id="plain-target"><a id="security-plain-link" href="#readable-token">正常的书内跳转</a></p></body></html>`;
 const opf=`<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid" prefix="rendition: http://www.idpf.org/vocab/rendition/#"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">urn:ai-reading:${id}:1</dc:identifier><dc:title>${title}</dc:title><dc:language>zh-CN</dc:language><dc:creator>AI 深度阅读 · 原创测试夹具</dc:creator><meta property="dcterms:modified">2026-10-11T00:00:00Z</meta>${fixed?'<meta property="rendition:layout">pre-paginated</meta><meta property="rendition:spread">none</meta>':''}</metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml" properties="scripted"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest><spine><itemref idref="chapter"/></spine></package>`;
 const nav=`<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body><nav epub:type="toc"><ol><li><a href="chapter.xhtml">${title}</a></li></ol></nav></body></html>`;
 const zip=new JSZip();
 const files={
  mimetype:'application/epub+zip',
  'META-INF/container.xml':'<?xml version="1.0" encoding="UTF-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  'OEBPS/package.opf':opf,'OEBPS/nav.xhtml':nav,'OEBPS/chapter.xhtml':chapter
 };
 for(const [name,body]of Object.entries(files))zip.file(name,body,{date,createFolders:false,compression:name==='mimetype'?'STORE':'DEFLATE'});
 const bytes=await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE',compressionOptions:{level:6},platform:'UNIX'});
 await writeFile(new URL(id+'.epub',output),bytes);
 manifest.push({id,file:id+'.epub',fixedLayout:fixed,title,visibleToken,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,probeChannels:['inline-script','body-onload','javascript-link']});
}
await writeFile(new URL('manifest.json',output),JSON.stringify({parentFlag:'__epubSecurityProbe',frameAttribute:'data-security-probe-executed',javascriptLinkSelector:'#security-javascript-link',fixtures:manifest},null,2)+'\n');
console.log('Generated original security EPUBs in '+fileURLToPath(output));
