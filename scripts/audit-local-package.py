"""Compare packaged first-party sources and verify post-launch resource seal."""
from pathlib import Path
import argparse, json, hashlib, subprocess
root=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser()
parser.add_argument('--app',type=Path,default=root/'dist/AI 深度阅读.app')
parser.add_argument('--evidence',type=Path,default=root/'dist/package-evidence.json')
parser.add_argument('--output',type=Path,default=root/'dist/final-package-audit.json')
args=parser.parse_args()
app=args.app.resolve();base=app/'Contents/Resources/app'
e=json.loads(args.evidence.read_text());errors=[];checked=0
for rel,digest in e['sourceHashes'].items():
 if rel in ['package.json','packages/reader-ui/dist/books-assets/catalog.json']:continue
 src=root/rel
 if not src.is_file() or hashlib.sha256(src.read_bytes()).hexdigest()!=digest:errors.append(rel)
 packed=base/rel
 if not packed.is_file() or hashlib.sha256(packed.read_bytes()).hexdigest()!=digest:errors.append('packaged:'+rel)
 checked+=1
for p in app.rglob('*'):
 if p.name in ['auth.json','.test-data','__pycache__'] or p.suffix=='.pyc':errors.append(str(p.relative_to(app)))
sig=subprocess.run(['codesign','--verify','--deep','--strict',str(app)],capture_output=True)
out={'passed':not errors and sig.returncode==0,'firstPartyFiles':checked,'mismatches':errors,'signatureValid':sig.returncode==0,'notarized':False,'codexVersion':e['codex']['version'],'authCopied':False}
args.output.write_text(json.dumps(out,indent=2));print(json.dumps(out));assert out['passed']
