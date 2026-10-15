import test from 'node:test';
import assert from 'node:assert/strict';
import {domTextMap,verifyMapping,textHash,canonicalHref} from '../src/source-mapping.js';
const text=data=>({nodeType:3,data,childNodes:[]});
function element(localName,...children){const node={nodeType:1,localName,childNodes:children};for(const c of children)c.parentNode=node;return node;}
const identity={book_id:'abc',book_version_id:'bv_abc'};
async function mapping(){const quote='😀重复';return {span:{ok:true,verified:true,...identity,href:'a.xhtml',start_codepoint:5,end_codepoint:8,quote,text_hash:await textHash(quote)},segments:[{href:'a.xhtml',start_codepoint:0,end_codepoint:8,text:'😀重复\n再😀重复'}]};}
test('DOM map follows engine block, spaces, script and Unicode coordinates',()=>{
 const doc=element('html',element('head',element('title',text('标题')),element('style',text('x'))),element('body',element('p',text(' A\u00a0\t'),element('em',text('😀')),text(' B ')),element('div',text('二\u2028三'))));
 const map=domTextMap(doc);assert.equal(map.text,'标题\nA 😀 B\n二\n三');const emoji=map.points.find(x=>x.char==='😀');assert.equal(emoji.end.offset-emoji.start.offset,2);
});
test('verified repeated quote uses offsets, not first text search',async()=>{const r=await verifyMapping(await mapping(),identity);assert.equal(r.start,5);assert.equal(r.end,8);});
test('stale identity, mismatched hash, cross-href and ambiguous segments rejected',async()=>{
 const m=await mapping();await assert.rejects(verifyMapping(m,{...identity,book_version_id:'other'}));
 await assert.rejects(verifyMapping({...m,span:{...m.span,text_hash:'wrong'}},identity));
 await assert.rejects(verifyMapping({...m,segments:[...m.segments,...m.segments]},identity));
 await assert.rejects(verifyMapping({...m,segments:[{...m.segments[0],end_codepoint:6}]},identity));
});
test('OPF-relative canonical href handles dot segments and encoded names',()=>{assert.equal(canonicalHref('OPS/../Text/%E4%B9%A6.xhtml'),'Text/书.xhtml');});
test('head title remains in authoritative quote, while displayed range is body only',async()=>{
 const {mappedDisplay}=await import('../src/source-mapping.js');
 const title=text('未知'),css=text('html{color:red}'),body=text('正文😀与方法');
 const doc=element('html',element('head',element('title',title),element('style',css)),element('body',element('p',body)));
 doc.createRange=()=>({setStart(node,offset){this.startContainer=node;this.startOffset=offset;},setEnd(node,offset){this.endContainer=node;this.endOffset=offset;}});
 const source=domTextMap(doc).text,display=mappedDisplay(doc,{text:source},0,Array.from(source).length);
 assert.equal(source,'未知\n正文😀与方法');assert.equal(display.partialDisplay,true);assert.equal(display.range.startContainer,body);assert.equal(display.range.endContainer,body);
 assert.deepEqual(display.quoteParts,{before:'未知\n',body:'正文😀与方法',after:''});assert.equal(Object.values(display.quoteParts).join(''),source);assert.ok(!Object.values(display.quoteParts).join('').includes('color:red'));
 assert.throws(()=>mappedDisplay(doc,{text:source},0,2),/没有可定位的正文/);
 const full=mappedDisplay(doc,{text:source},3,Array.from(source).length);assert.equal(full.partialDisplay,false);assert.equal(full.quoteParts.body,'正文😀与方法');
});
