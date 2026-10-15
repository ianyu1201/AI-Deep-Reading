import test from 'node:test';
import assert from 'node:assert/strict';
import {ImportedBooks} from '../src/imported-books.js';
test('imported EPUB bytes remain reopenable by content identity after selecting other books',()=>{
 const imports=new ImportedBooks(),a=new File(['A'],'same.epub'),b=new File(['B'],'same.epub');
 const first=imports.remember({id:'hash-A',title:'A'},a);
 const second=imports.remember({id:'hash-B',title:'B'},b);
 assert.equal(first.id,'local:hash-A');assert.equal(second.id,'local:hash-B');
 assert.equal(imports.get(first.id),a);assert.equal(imports.get(second.id),b);
 assert.equal(imports.get('/arbitrary/path.epub'),undefined);
 const duplicate=imports.remember({id:'hash-A',title:'A'},a);assert.equal(duplicate.id,first.id);
 assert.equal(imports.get(first.id),a);assert.deepEqual(Object.keys(first),['id','title','author','cover']);
});
