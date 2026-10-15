import test from 'node:test';import assert from 'node:assert/strict';import {guideDisplay,projectSourceTitles} from './business-display.mjs';
const generated={recommendations:[{section_id:'s1',title:'反馈与延迟',reason:'结合库存与流量理解为什么调节可能过度。',source_refs:['r1']}],sources:{r1:{title:'反馈与延迟'}}};
const recommendations={result:{book_guide:{items:[{source_refs:['r1'],reason:{definition_count:3}}]}}};
const note={confirmation:'confirmed',statement:'我想用反馈方法复盘库存决策',section_id:'s1',kind:'explicit_preference',span_id:'r1'};
test('none, unconfirmed, test and other-book/chapter evidence cannot invent personalization',()=>{for(const notes of [[],[{...note,confirmation:'unconfirmed'}],[{...note,test_evidence:true}],[{...note,section_id:'s2'}]]){const out=guideDisplay({recommendations,evidence:{notes},generated});assert.equal(out.personal.length,0);assert.equal(out.items[0].reason,generated.recommendations[0].reason);assert.equal(JSON.stringify(out.items).includes('definition_count'),false);}});
test('confirmed preference, self-report and one performance retain their specific evidence and limits',()=>{for(const [kind,label,limit] of [['explicit_preference','兴趣','兴趣不作为能力判断'],['self_report','自述','不能据此判断掌握或缺口'],['observed_performance','表现','一次表现不代表稳定掌握']]){const out=guideDisplay({recommendations,evidence:{notes:[{...note,kind}]},generated});assert.equal(out.personal.length,1);assert.equal(out.personal[0].statement,note.statement);assert.match(out.personal[0].title,new RegExp(label));assert.ok(out.personal[0].explanation.includes(limit));assert.ok(out.personal[0].explanation.includes(generated.recommendations[0].reason));}});
test('old extractive dictionaries are described honestly rather than shown as JSON',()=>{const out=guideDisplay({recommendations});assert.equal(out.items[0].reason,'已从原文提取这段；具体价值解释尚待生成。');});

test('same chapter without overlapping source is not presented as a specific thematic match',()=>{const out=guideDisplay({recommendations,evidence:{notes:[{...note,span_id:'unrelated'}]},generated});assert.equal(out.personal[0].match,'chapter-only');assert.equal(out.personal[0].title,'同章可回看');assert.ok(!out.personal[0].explanation.includes(generated.recommendations[0].reason));});
test('same chapter identity in a different book version is rejected',()=>{const out=guideDisplay({recommendations,evidence:{notes:[{...note,book_version_id:'old'}]},generated:{...generated,book_version_id:'current'}});assert.equal(out.personal.length,0);});

test('specific source overlap includes a subrange but not adjacent or other-section text',()=>{
 const ref='sp_abcdef_2_100_300',g={book_version_id:'bv_a',recommendations:[{section_id:'s1',title:'这一段',reason:'只讨论这个来源',source_refs:[ref]}],sources:{[ref]:{title:'长章'}}};
 for(const [span,match] of [['sp_abcdef_2_200_400','source-overlap'],['sp_abcdef_2_300_400','chapter-only'],['sp_abcdef_3_100_200','chapter-only'],['sp_123456_2_100_200','chapter-only']]){const out=guideDisplay({recommendations,evidence:{notes:[{...note,span_id:span}]},generated:g});assert.equal(out.personal[0].match,match);}
});
test('selected recommendation uses its whole source set, not the first overlapping recommendation',()=>{
 const g={recommendations:[{title:'旧线索',reason:'第一处',source_refs:['r1','r2']},{title:'另一线索',reason:'第二处',source_refs:['r2','r3']}],sources:{}};
 const out=guideDisplay({generated:g,recommendations:{result:{book_guide:{items:[{source_refs:['r2','r3']}]}}}});assert.equal(out.items[0].title,'另一线索');assert.equal(out.items[0].reason,'第二处');
});

test('source title projection uses actual opening heading while preserving identity, text and stored manifest',()=>{
 const a='sp_abcdef_0_0_90',b='sp_abcdef_0_90_150',c='sp_abcdef_1_0_100';
 const g={chapters:[{section_id:'s1',kind:'body'},{section_id:'s2',kind:'body'}],sources:{[a]:{section_id:'s1',title:'重复书名',text:'重复书名\n第一部分 结构\n第1章 反馈基础\n原文'},[b]:{section_id:'s1',title:'重复书名',text:'第二段原文'},[c]:{section_id:'s2',title:'重复书名',text:'重复书名\n第2章 干预边界\n原文'}}};const before=JSON.stringify(g),out=projectSourceTitles(g);assert.equal(out[a].title,'第1章 反馈基础');assert.equal(out[b].title,'第1章 反馈基础');assert.equal(out[c].title,'第2章 干预边界');assert.equal(out[b].text,g.sources[b].text);assert.deepEqual(Object.keys(out),Object.keys(g.sources));assert.equal(JSON.stringify(g),before);
});
test('contents and non-opening excerpts cannot invent a chapter label from a mentioned heading',()=>{
 const a='sp_abcdef_0_0_90',b='sp_abcdef_1_20_100';const out=projectSourceTitles({chapters:[{section_id:'s1',kind:'contents'}],sources:{[a]:{section_id:'s1',title:'重复书名',text:'目录\n第1章 基础\n第2章 干预'},[b]:{section_id:'s2',title:'重复书名',text:'第9章 某引用'}}});assert.equal(out[a].title,'原文片段');assert.equal(out[b].title,'原文片段');
});
test('short opening label remains a quoted source label, not an invented chapter number',()=>{
 const ref='sp_abcdef_0_0_200';const out=projectSourceTitles({sources:{[ref]:{section_id:'s1',title:'重复书名',text:'重复书名\n模型公式\n'+ '实际正文描述'.repeat(20)}}});assert.equal(out[ref].title,'模型公式');assert.equal(out[ref].title_origin,'source-opening-label');
});
