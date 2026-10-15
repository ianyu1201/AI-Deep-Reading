import test from 'node:test';import assert from 'node:assert/strict';import {notePresentation} from './note-presentation.mjs';
test('display categories distinguish evidence without fabricating confirmation or renaming paths',()=>{
 const base={id:'阅读背景/学习证据/hash.md',name:'hash',folder:'阅读背景/学习证据'};
 assert.deepEqual(notePresentation({...base,data:{object_type:'reading_evidence',kind:'preference',title:'系统思考'}}),{displayTitle:'阅读偏好 · 系统思考',displayFolder:base.folder,bookRelativeFolder:base.folder,displayCategory:'学习证据',systemRecord:false,storagePath:base.id});
 assert.equal(notePresentation({...base,data:{object_type:'recommendation_run',title:'两层阅读推荐运行'}}).systemRecord,true);
 assert.equal(notePresentation({...base,data:{object_type:'book',title:'很长的书名'}}).displayTitle,'书籍信息');
 assert.equal(notePresentation({...base,data:{}}).displayTitle,'hash');
});
