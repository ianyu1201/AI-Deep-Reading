// No real vault provider is connected yet. UI book labels never authorize a vault read.
const fixtures = Object.freeze({
  'workspace-links': [
    {id:'fixture-alice-summary',bookId:'11',name:'阅读摘录',folder:'阅读笔记/章节摘录',body:'# 合成验收笔记\n\nAlice 专属测试内容。不是实际知识库结果。\n'},
    {id:'fixture-alice-question',bookId:'11',name:'待讨论的问题',folder:'阅读笔记/问题',body:'# 合成问题\n\n仅用于验证工作台文件联动。\n'},
    {id:'fixture-pride-summary',bookId:'1342',name:'阅读摘录',folder:'阅读笔记/章节摘录',body:'# 另一册合成验收笔记\n\n与 Alice 同名，但身份不同。\n'}
  ]
});
function fixtureNotes(fixture){
  if(process.env.AI_READING_TEST!=='1'||typeof fixture!=='string'||!Object.hasOwn(fixtures,fixture))return null;
  return fixtures[fixture];
}
export function getFixtureNotes(fixture){return (fixtureNotes(fixture)??[]).map(note=>({...note}))}
export function getBookNotes(bookId,{fixture}={}){
  const data=fixtureNotes(fixture);
  if(!data)return {available:false,kind:'unavailable',notes:[],reason:'本书笔记关联尚未接入；可在全部笔记中浏览独立草稿。'};
  const notes=data.filter(note=>note.bookId===bookId).map(({body,...note})=>({...note}));
  return {available:true,kind:'synthetic-fixture',notes,reason:'隔离合成夹具，仅用于验证稳定书籍身份关联。'};
}
