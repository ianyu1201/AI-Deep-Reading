#!/usr/bin/env python3
"""Materialize only public runtime packages and an explicit public model snapshot.
No user index, credentials, reranker, general cache, or environment config is copied.
"""
import argparse, hashlib, json, shutil, subprocess
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def prepare(python, model_snapshot, output):
    output=Path(output).resolve()
    if not output.is_relative_to(ROOT/'.build'): raise ValueError('Preparation output must be inside desktop/.build')
    probe=r'''
import sys,json,importlib.metadata as m
from packaging.requirements import Requirement
pending=['fastembed','numpy','jieba']; seen={}; tops=set()
while pending:
 name=pending.pop()
 d=m.distribution(name); name=d.metadata['Name']
 if name.lower() in seen: continue
 seen[name.lower()]=d.version
 for file in d.files or []:
  if file.parts and file.parts[0] not in ('..','.'):
   tops.add(str(d.locate_file(file.parts[0])))
 for req in d.requires or []:
  r=Requirement(req)
  if r.marker is None or r.marker.evaluate({'extra':''}): pending.append(r.name)
print(json.dumps({'prefix':sys.base_prefix,'version':f'{sys.version_info.major}.{sys.version_info.minor}','packages':seen,'paths':sorted(tops)}))
'''
    info=json.loads(subprocess.check_output([python,'-c',probe],text=True))
    expected=dict(line.strip().split('==',1) for line in (ROOT/'scripts/semantic-requirements.lock').read_text().splitlines() if line.strip())
    if info['packages'] != expected: raise ValueError('Semantic environment version mismatch')
    if output.exists(): shutil.rmtree(output)
    output.mkdir(parents=True)
    prefix=Path(info['prefix'])
    shutil.copytree(prefix/'lib', output/'lib', symlinks=False, ignore=shutil.ignore_patterns('site-packages','__pycache__','*.pyc','test','tests','idlelib','tkinter','ensurepip','turtledemo'))
    (output/'bin').mkdir()
    shutil.copy2(prefix/'bin'/('python'+info['version']),output/'bin/python3')
    site=output/'lib'/('python'+info['version'])/'site-packages';site.mkdir()
    for original in info['paths']:
        source=Path(original);dest=site/source.name
        if not source.exists():continue
        if source.is_dir():shutil.copytree(source,dest,dirs_exist_ok=True,symlinks=False,ignore=shutil.ignore_patterns('__pycache__','*.pyc','test','tests'))
        else:shutil.copy2(source,dest)
    model=output/'models/bge-small-zh-v1.5';model.mkdir(parents=True)
    (model/'MODEL-NOTICE.txt').write_text('BAAI/bge-small-zh-v1.5, ONNX distribution Qdrant/bge-small-zh-v1.5.\nModel license is listed as MIT by fastembed 0.9.0 model metadata.\nPublic source: https://huggingface.co/Qdrant/bge-small-zh-v1.5\nOriginal: https://huggingface.co/BAAI/bge-small-zh-v1.5\nNo personal index or reranker included. Full redistribution license review remains required for public distribution.\n')
    hashes={}
    for name in ('model_optimized.onnx','config.json','tokenizer.json','tokenizer_config.json','special_tokens_map.json'):
        src=Path(model_snapshot)/name
        if not src.is_file():raise ValueError('Incomplete public model snapshot: '+name)
        shutil.copy2(src,model/name)
        hashes[name]=hashlib.sha256((model/name).read_bytes()).hexdigest()
    manifest={'python':info['version'],'packages':info['packages'],'model':'BAAI/bge-small-zh-v1.5','modelSource':'Qdrant/bge-small-zh-v1.5','modelFilesSha256':hashes,'personalIndexesCopied':False}
    (output/'semantic-manifest.json').write_text(json.dumps(manifest,indent=2))
    # Python standalone distribution includes license notices in share; keep only notice files.
    for item in prefix.rglob('*'):
        if item.is_file() and ('license' in item.name.lower() or 'copying' in item.name.lower()) and 'site-packages' not in item.parts:
            dest=output/'licenses'/item.relative_to(prefix);dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(item,dest)
    subprocess.run([output/'bin/python3','-I','-c','import fastembed,numpy,jieba,onnxruntime;print("Semantic dependencies ready")'],check=True)
    print(json.dumps(manifest,indent=2))
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--python',required=True);p.add_argument('--model-snapshot',required=True);p.add_argument('--output',default=str(ROOT/'.build/semantic-python'))
    a=p.parse_args();prepare(a.python,a.model_snapshot,a.output)
