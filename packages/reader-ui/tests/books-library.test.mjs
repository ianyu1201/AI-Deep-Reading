import {readingPrefs} from '../src/reading-theme.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

// Exercise the shipping renderer against a small DOM surface, without EPUB/network/model work.
function node(tag='div') { return {tag,children:[],hidden:false,textContent:'',attributes:{},setAttribute(name,value){this.attributes[name]=String(value)},append(...items){this.children.push(...items)},replaceChildren(...items){this.children=[...items]}} }
async function library(catalog) {
 const source=await readFile(new URL('../src/books.js',import.meta.url),'utf8');
 const nodes=new Map();const $=selector=>{if(!nodes.has(selector))nodes.set(selector,node());return nodes.get(selector)};
 const context={installAppleLibraryPanel:()=>{},managedBooks:false,desktopBooks:null,readingPrefs,window:{},catalog,$,el:(tag,cls,text)=>Object.assign(node(tag),{className:cls,textContent:text??''}),button:label=>Object.assign(node('button'),{label}),storage:{get:(_key,fallback)=>fallback},ReadingPosition:class{},ImportedBooks:class{},installBookContext:()=>({})};
 const prefix=source.slice(0,source.indexOf('function globalMenu')).replace(/^import .*;\n/gm,'').replace(/^const (desktopBooks|managedBooks|catalog)=.*;$/gm,'');
 vm.runInNewContext(prefix+';this.update=q=>{state.query=q;renderLibrary()};',context);
 return {...context,nodes};
}
test('library filters title and author in place, clearing restores all books',async()=>{
 const app=await library([{id:'a',title:'Pride and Prejudice',author:'Jane Austen',cover:'a.jpg'},{id:'b',title:'Alice',author:'Lewis Carroll',cover:'b.jpg'}]);
 app.update(' JANE ');assert.equal(app.$('#book-grid').children.length,1);assert.equal(app.$('#book-grid').children[0].children[1].textContent,'Pride and Prejudice');
 app.update('alice');assert.equal(app.$('#book-grid').children.length,1);
 app.update('');assert.equal(app.$('#book-grid').children.length,2);assert.equal(app.$('#library-empty').hidden,true);
 app.update('missing');assert.equal(app.$('#book-grid').children.length,0);assert.match(app.$('#library-empty').textContent,/没有匹配/);assert.equal(app.$('#library-empty').hidden,false);
});
test('empty collection has import guidance and catalogue snapshots cannot mutate catalogue',async()=>{
 const empty=await library([]);empty.update('');assert.match(empty.$('#library-empty').textContent,/还没有图书/);
 const app=await library([{id:'a',title:'A',author:'B',cover:'a.jpg'}]);const snap=app.window.aiReadingLibrary.getSnapshot();assert.ok(Object.isFrozen(snap[0]));snap.pop();assert.equal(app.window.aiReadingLibrary.getSnapshot().length,1);
 app.update('');const tile=app.$('#book-grid').children[0];const status=tile.children.at(-2);assert.equal(status.children[1].textContent,'未开始');assert.equal(status.children[0].value,0);assert.equal(status.children[0].attributes['aria-label'],'A 阅读位置');assert.equal(tile.children.at(-1).textContent,'分析未接入');
});
