"""Actual offline embeddings against synthetic EPUB; not a mocked vector test."""
import json, os, sys, tempfile, time, zipfile
from pathlib import Path
sys.path.insert(0,str(Path(__file__).parent))
if os.environ.get('AI_READING_LIBRARY_MODULE'):
    import importlib.util
    spec=importlib.util.spec_from_file_location('library',os.environ['AI_READING_LIBRARY_MODULE'])
    library=importlib.util.module_from_spec(spec);spec.loader.exec_module(library)
else:
    import library
started=time.monotonic()
with tempfile.TemporaryDirectory(prefix='reading-semantic-') as tmp:
    root=Path(tmp); book=root/'synthetic.epub'
    sections=[('学习方法','主动回忆能帮助记忆长久保持。阅读后合上书，根据问题复述内容，再对照原文查漏补缺。间隔重复把复习安排在遗忘之前，通过反馈修正误解。'),('城市园艺','番茄需要充足阳光和适当浇水。花盆必须具备排水孔，土壤过湿可能导致根部腐烂。春季播种之后，逐步适应室外温度。'),('运动恢复','跑步训练需要安排休息。肌肉在恢复时逐渐适应负荷，睡眠和饮食帮助身体修复。突然增加里程可能导致损伤，应循序渐进。')]
    with zipfile.ZipFile(book,'w') as z:
        z.writestr('mimetype','application/epub+zip')
        z.writestr('META-INF/container.xml','<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>')
        z.writestr('book.opf','<package><metadata><title>隔离语义验收合成书</title></metadata><manifest>'+''.join(f'<item id="c{i}" href="c{i}.xhtml"/>' for i in range(3))+'</manifest><spine>'+''.join(f'<itemref idref="c{i}"/>' for i in range(3))+'</spine></package>')
        for i,(title,text) in enumerate(sections):
            paragraphs=''.join(f'<p>练习情境{j}：{text}</p>' for j in range(24))
            z.writestr(f'c{i}.xhtml',f'<html><body><h1>{title}</h1>{paragraphs}</body></html>')
    entry=library.import_book(root/'library',book)
    index_start=time.monotonic()
    indexed=library.engine_request(root/'library','/index',{'book':entry['enginePath']})
    assert indexed.get('ok'),indexed
    assert indexed['meta']['dim']==512,indexed
    index_seconds=time.monotonic()-index_start
    search_start=time.monotonic()
    found=library.engine_request(root/'library','/search',{'book':entry['enginePath'],'query':'怎样避免看完一本书很快就忘记？','k':3})
    assert found.get('ok'),found
    assert found['retrieval']=='semantic-hybrid'
    assert found['hits'][0]['chapter']=='学习方法',found
    assert all(isinstance(h['cosine'],float) for h in found['hits'])
    assert all(not h.get('exact') or h['source_ref']['quote']==h['text'] for h in found['hits'])
    result={'ok':True,'synthetic':True,'model':found['model'],'dimensions':512,'chunks':len(indexed['meta']['chunks']),'indexSeconds':round(index_seconds,3),'searchSeconds':round(time.monotonic()-search_start,3),'topChapter':found['hits'][0]['chapter'],'scores':[{'score':h['score'],'cosine':h['cosine'],'exact':h['exact']} for h in found['hits']],'reranked':found['reranked'],'modelDownloaded':False,'paidModelCalls':0,'totalSeconds':round(time.monotonic()-started,3)}
    os.environ['AI_READING_EMBED_MODEL_PATH']=str(root/'missing-public-model')
    missing=library.engine_request(root/'library','/search',{'book':entry['enginePath'],'query':'记忆'})
    assert missing.get('ok') is False and 'SEMANTIC_MODEL_NOT_PREPARED' in missing.get('error',''),missing
    result['missingModelTruthful']=True
    print(json.dumps(result,ensure_ascii=False,indent=2))
