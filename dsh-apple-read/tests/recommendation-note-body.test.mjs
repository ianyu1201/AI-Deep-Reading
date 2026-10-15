import test from 'node:test';import assert from 'node:assert/strict';import {recommendationNoteBody} from '../lib/reading/recommendation-note-body.js';
test('saved generated guide exposes actual overview, recommendations and existing source references without mutating authority',()=>{
 const input={bookTitle:'真实书籍',revision:3,result:{book_guide:{overview_paragraphs:['有据可查的概括。'],source_refs:['sp_real_1'],items:[{section_id:'sec_1',reason:'真实理由',source_refs:['sp_real_1']}]}},generated:{status:'ready',model:'actual-model',version:'grounded-guide-v1',method:'分段与综合',coverage:{processed_sections:['sec_1'],body_sections:['sec_1']},recommendations:[{section_id:'sec_1',title:'正文章名',reason:'解释方法与前提。'}],sources:{sp_real_1:{text:'书中的实际原文。'}}}};
 const before=JSON.stringify(input);const body=recommendationNoteBody(input);assert.match(body,/有据可查的概括/);assert.match(body,/正文章名/);assert.match(body,/解释方法与前提/);assert.match(body,/> 书中的实际原文/);assert.match(body,/来源校验详情/);assert.match(body,/sp_real_1/);assert.match(body,/保存此记录不代表用户已确认/);assert.equal(JSON.stringify(input),before);
});
test('extractive and missing content are honest, with no invented source or model',()=>{
 const body=recommendationNoteBody({result:{book_guide:{overview_paragraphs:['抽取句子']}},revision:1});assert.match(body,/尚未完成生成式跨章综合/);assert.match(body,/## 原文摘录/);assert.doesNotMatch(body,/## 本书浓缩|sp_/);assert.match(body,/未记录生成式模型/);
});
