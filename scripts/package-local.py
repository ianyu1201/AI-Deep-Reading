#!/usr/bin/env python3
"""Build a relocatable local macOS application from pinned, installed dependencies.
No package download, credentials, reports, fixture books or private data are copied.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
APP_SRC = ROOT / 'apps/desktop'

def run(args, **kwargs):
    return subprocess.run([str(a) for a in args], check=True, text=True, capture_output=True, **kwargs).stdout.strip()

def copy(src, dst, ignore=None):
    dst.parent.mkdir(parents=True, exist_ok=True)
    if src.is_dir():
        shutil.copytree(src, dst, symlinks=True, ignore=ignore, dirs_exist_ok=True)
    else:
        shutil.copy2(src, dst, follow_symlinks=True)

def ignored(directory, names):
    return [n for n in names if n in {'__pycache__', '.DS_Store', '.git', 'reports', 'diagnostics', '.fixtures', '.test-data', '.private', '.codex', '.dsh', 'auth.json', 'credentials.json', '.credentials.yaml', 'tests', 'test', 'fixtures', 'site-packages', 'idlelib', 'tkinter', 'ensurepip', 'turtledemo'} or n.startswith(('_tkinter.', '.env')) or n.endswith(('.pyc', '.pyo'))]

def sanitize_semantic_python(dest):
    # Build-only sysconfig paths must not disclose the developer's home.
    for source in dest.glob('lib/python*/_sysconfigdata*.py'):
        contents = source.read_text()
        contents = re.sub(r'/Users/[^/\s\'";]+', '/build-user', contents)
        source.write_text(contents)
    # This unused shared-library install ID can still contain the original uv prefix.
    for library in dest.glob('lib/libpython*.dylib'):
        run(['install_name_tool', '-id', '@rpath/' + library.name, library])
        run(['codesign', '--force', '--sign', '-', library])

def macho(path):
    if not path.is_file() or path.is_symlink(): return False
    with path.open('rb') as f: magic=f.read(4)
    return magic in (b'\xfe\xed\xfa\xcf', b'\xcf\xfa\xed\xfe', b'\xca\xfe\xba\xbe', b'\xbe\xba\xfe\xca')

def python_runtime(dest):
    semantic = ROOT / '.build/semantic-python'
    if (semantic / 'semantic-manifest.json').is_file():
        copy(semantic, dest, shutil.ignore_patterns('__pycache__', '*.pyc', 'tests', 'test'))
        sanitize_semantic_python(dest)
        copy(dest/'lib/python3.12/LICENSE.txt', dest/'LICENSE.txt')
        model = dest/'models/bge-small-zh-v1.5'
        model_license = APP_SRC/'packaging/licenses/third-party/model/LICENSE'
        if not model_license.is_file(): raise RuntimeError('Missing bundled model license')
        copy(model_license, model/'LICENSE')
        (model/'MODEL-NOTICE.txt').write_text('BAAI/bge-small-zh-v1.5, ONNX distribution Qdrant/bge-small-zh-v1.5.\nMIT license retained as LICENSE. Upstream model cards and provenance are in Resources/licenses/third-party/model/.\nModel files match semantic-manifest.json SHA-256 entries. No personal index or reranker included.\n')
        result=run([dest/'bin/python3','-B','-I','-c','import sys,json,zipfile,sqlite3,ssl,fastembed,numpy,jieba,onnxruntime; print(json.dumps({"version":sys.version,"prefix":sys.prefix}))'], env={'PATH':'/usr/bin:/bin'})
        parsed=json.loads(result)
        if not Path(parsed['prefix']).resolve().is_relative_to(dest.resolve()):
            raise RuntimeError('Semantic Python is not relocated')
        return parsed
    prefix = Path(sys.base_prefix).resolve()
    version = f'{sys.version_info.major}.{sys.version_info.minor}'
    if not (prefix/'Python').is_file():
        raise RuntimeError('This builder expects the python.org macOS framework distribution')
    copy(prefix/'Resources/Python.app/Contents/MacOS/Python', dest/'bin/python3')
    copy(prefix/'Python', dest/'Python')
    copy(prefix/'lib'/f'python{version}', dest/'lib'/f'python{version}', ignored)
    # Python's extension modules refer to bundled OpenSSL/ncurses/zstd dylibs.
    for lib in (prefix/'lib').glob('*.dylib'):
        if not lib.is_symlink(): copy(lib, dest/'lib'/lib.name)
    license_file = prefix/'lib'/f'python{version}'/'LICENSE.txt'
    if license_file.exists(): copy(license_file, dest/'LICENSE.txt')
    for item in list(dest.rglob('*')):
        if not macho(item): continue
        dependencies=set()
        for line in run(['otool','-L',item]).splitlines():
            value=line.strip().split(' (compatibility')[0]
            if value.startswith(str(prefix)+'/'): dependencies.add(value)
        for old in dependencies:
            target = dest/Path(old).relative_to(prefix)
            if not target.exists():
                # Usually a dylib compatibility alias; resolve within source prefix.
                resolved=Path(old).resolve()
                if not resolved.is_relative_to(prefix): raise RuntimeError('External Python dependency: '+old)
                target=dest/resolved.relative_to(prefix)
            if not target.exists(): raise RuntimeError('Missing bundled Python dependency: '+old)
            new='@loader_path/'+os.path.relpath(target,item.parent)
            run(['install_name_tool','-change',old,new,item])
        # A local ad-hoc signature is needed for modified arm64 Mach-O files; no identity/notarization.
        run(['codesign','--force','--sign','-',item])
    result=run([dest/'bin/python3','-B','-I','-c','import sys,json,zipfile,sqlite3,hashlib,ssl; print(json.dumps({"version":sys.version,"prefix":sys.prefix}))'], env={'PATH':'/usr/bin:/bin'})
    parsed=json.loads(result)
    if not Path(parsed['prefix']).resolve().is_relative_to(dest.resolve()):
        raise RuntimeError('Python is not relocated: '+result)
    return parsed

def codex_runtime(resources, node):
    module=(APP_SRC/'runtime/codex-path.mjs').as_uri()
    command='import {resolveCodexPath} from '+json.dumps(module)+'; console.log(JSON.stringify(await resolveCodexPath()));'
    found=json.loads(run([node,'--input-type=module','-e',command]))
    executable=Path(found['path'])
    version=run([executable,'--version'])
    if version != 'codex-cli 0.144.6':
        raise RuntimeError('Codex CLI version differs from pinned license/native baseline: '+version)
    output=resources/'runtime/codex'
    copy(executable,output/'bin/codex')
    vendor=executable.parent.parent
    for relative in ('bin/codex-code-mode-host','codex-path/rg','codex-package.json'):
        if (vendor/relative).is_file():copy(vendor/relative,output/relative)
    for name in ('LICENSE','NOTICE'):
        source=APP_SRC/'packaging/licenses/codex'/name
        if not source.is_file():raise RuntimeError('Missing pinned Codex '+name)
        copy(source,output/name)
    return {'version':version,'source':'official installed native binary, resolved without reading auth',
            'sourceSha256':hashlib.sha256(executable.read_bytes()).hexdigest(),
            'license':'Apache-2.0','licenseTag':'rust-v0.144.6',
            'authCopied':False,'requiresCodexApp':False,
            'licenseSha256':hashlib.sha256((output/'LICENSE').read_bytes()).hexdigest(),
            'noticeSha256':hashlib.sha256((output/'NOTICE').read_bytes()).hexdigest()}

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--node', default=shutil.which('node'))
    parser.add_argument('--output', default=str(ROOT/'dist/AI 深度阅读.app'))
    parser.add_argument('--minimum-macos', default='13.0', help='Declared minimum; audit-release.py checks every bundled Mach-O')
    parser.add_argument('--build-number', default='1')
    parser.add_argument('--slim', action='store_true', help='Remove reviewed unused assets for the dedicated arm64 reading client')
    args=parser.parse_args()
    if not re.fullmatch(r'\d+\.\d+(?:\.\d+)?', args.minimum_macos): raise ValueError('Invalid minimum macOS version')
    if not args.build_number.isdecimal(): raise ValueError('Build number must be numeric')
    out=Path(args.output).resolve()
    if not out.is_relative_to(ROOT/'dist') or out.suffix!='.app': raise RuntimeError('Output must be .app under desktop/dist')
    electron=APP_SRC/'node_modules/electron/dist/Electron.app'
    electron_version=(APP_SRC/'node_modules/electron/dist/version').read_text().strip()
    if electron_version!='44.7.0': raise RuntimeError('Unexpected Electron version: '+electron_version)
    manifest=json.loads((APP_SRC/'package.json').read_text())
    lock=json.loads((APP_SRC/'package-lock.json').read_text())
    for name,version in manifest['dependencies'].items():
        actual=json.loads((APP_SRC/'node_modules'/name/'package.json').read_text())['version']
        if actual!=version: raise RuntimeError('Dependency version mismatch: '+name)
    if out.exists(): shutil.rmtree(out)
    copy(electron,out)
    resources=out/'Contents/Resources'
    for candidate in ('default_app.asar',):
        (resources/candidate).unlink(missing_ok=True)
    app=resources/'app'
    app.mkdir()
    (app/'package.json').write_text(json.dumps({'name':'ai-reading-desktop','productName':'AI 深度阅读','version':'0.1.0','main':'apps/desktop/packaging/bootstrap.cjs'}))
    for folder in ('electron','shell','runtime'):
        copy(APP_SRC/folder,app/'apps/desktop'/folder, ignored)
    copy(APP_SRC/'packaging/bootstrap.cjs',app/'apps/desktop/packaging/bootstrap.cjs')
    # Source-based diagnostics/test launchers are never shipped.
    for p in (app/'apps/desktop').rglob('*'):
        if p.is_file() and (p.name.endswith(('.test.mjs','-test.mjs','-probe.mjs','-smoke.mjs')) or p.name=='start.mjs'):
            p.unlink()
    copy(APP_SRC/'package.json',app/'apps/desktop/package.json')
    for folder in ('lib','assets','locale'):
        if (ROOT/'dsh-apple-read'/folder).exists(): copy(ROOT/'dsh-apple-read'/folder,app/'dsh-apple-read'/folder, ignored)
    for name in ('package.json','cordis.patch.yml','LICENSE','icon.svg'):
        if (ROOT/'dsh-apple-read'/name).exists(): copy(ROOT/'dsh-apple-read'/name,app/'dsh-apple-read'/name)
    copy(ROOT/'packages/reader-ui/dist',app/'packages/reader-ui/dist',lambda d,n: ignored(d,n)+(['books-assets'] if 'books-assets' in n else []))
    assets=app/'packages/reader-ui/dist/books-assets';assets.mkdir()
    (assets/'catalog.json').write_text('[]\n')
    for name in ('library.py','index.mjs'):
        copy(ROOT/'packages/book-library'/name,app/'packages/book-library'/name)
    copy(ROOT/'packages/guide-generation/index.mjs',app/'packages/guide-generation/index.mjs')
    copy(ROOT/'books_rag.py',app/'books_rag.py')
    copy(ROOT/'LICENSE',app/'LICENSE')
    # Exact production graph from package-lock; nested installs retain their relative locations.
    dependencies=run(['npm','ls','--omit=dev','--all','--parseable'],cwd=APP_SRC).splitlines()[1:]
    nm=APP_SRC/'node_modules'
    top=set()
    for dependency in dependencies:
        rel=Path(dependency).relative_to(nm)
        count=2 if rel.parts[0].startswith('@') else 1
        top.add(Path(*rel.parts[:count]))
    # Native macOS sharp is retained and tested; do not ship a non-target wasm
    # fallback whose upstream build references an unpinned source HEAD.
    excluded_optional = {'@img/sharp-wasm32'}
    for rel in sorted(top):
        if rel.as_posix() not in excluded_optional:
            copy(nm/rel,app/'apps/desktop/node_modules'/rel,ignored)
    node=Path(args.node).resolve()
    copy(node,resources/'runtimes/node/bin/node')
    node_license=node.parent.parent/'LICENSE'
    if not node_license.is_file(): raise RuntimeError('Node license not found beside distribution')
    copy(node_license,resources/'runtimes/node/LICENSE')
    py_info=python_runtime(resources/'runtimes/python')
    codex_info=codex_runtime(resources,node)
    plist_path=out/'Contents/Info.plist'
    plist=plistlib.loads(plist_path.read_bytes())
    (out/'Contents/MacOS/Electron').rename(out/'Contents/MacOS/AIReading')
    plist.pop('ElectronAsarIntegrity', None)
    plist.update(CFBundleExecutable='AIReading', CFBundleDisplayName='AI 深度阅读',CFBundleName='AI 深度阅读',CFBundleIdentifier='local.aireading.desktop',CFBundleShortVersionString='0.1.0',CFBundleVersion=args.build_number,LSMinimumSystemVersion=args.minimum_macos,NSHumanReadableCopyright='Copyright 2026 ianyu1201; third-party notices included.')
    plist_path.write_bytes(plistlib.dumps(plist))
    copy(APP_SRC/'node_modules/electron/LICENSE',resources/'ELECTRON-LICENSE')
    copy(APP_SRC/'node_modules/electron/dist/LICENSES.chromium.html',resources/'LICENSES.chromium.html')
    copy(APP_SRC/'packaging/licenses',resources/'licenses',ignored)
    copy(ROOT/'THIRD_PARTY_NOTICES.md',resources/'THIRD_PARTY_NOTICES.md')
    notice='''AI 深度阅读 — Apple Silicon 预览构建\n\nElectron 44.7.0 / Chromium: ELECTRON-LICENSE 及 LICENSES.chromium.html。\nCodex CLI 0.144.6: runtime/codex/LICENSE 和 NOTICE；不包含认证数据。\nNode: runtimes/node/LICENSE。Python: runtimes/python/LICENSE.txt 与 licenses/third-party/。\nHarness SDK及依赖: app/apps/desktop/node_modules 内各包许可证及 package.json；补充声明在 licenses/third-party/。\nEPUB/Markdown: app/packages/reader-ui/dist/THIRD_PARTY.md 与 licenses。\n完整声明与对应上游源码见 THIRD_PARTY_NOTICES.md、licenses/third-party/ 和同一 GitHub Release 的源码材料。\n未纳入 Apple Books、Obsidian 专有资源。ad-hoc 签名，未公证。\n无模型密钥、个人数据、测试数据或示例书籍；具体结果见发布审计报告。\n'''
    (resources/'THIRD-PARTY-NOTICES.txt').write_text(notice)
    pruning = None
    if args.slim:
        spec = importlib.util.spec_from_file_location('prune_package', ROOT/'scripts/prune-package.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        pruning = module.prune_package(out)
        (out.parent/'pruning-report.json').write_text(json.dumps(pruning,ensure_ascii=False,indent=2)+'\n')
    # Changed bundle gets an ad-hoc development signature, not a Developer ID signature.
    run(['codesign','--force','--deep','--sign','-',out])
    evidence={'app':str(out.relative_to(ROOT)),'electron':electron_version,'node':run([resources/'runtimes/node/bin/node','--version']),
      'python':py_info['version'], 'semantic':json.loads((resources/'runtimes/python/semantic-manifest.json').read_text()) if (resources/'runtimes/python/semantic-manifest.json').exists() else None,'dependencies':manifest['dependencies'],'lockSha256':hashlib.sha256((APP_SRC/'package-lock.json').read_bytes()).hexdigest(),
      'codex':{**codex_info,'bundledSha256':hashlib.sha256((resources/'runtime/codex/bin/codex').read_bytes()).hexdigest()},
      'architecture':run(['uname','-m']), 'minimumMacOS':plist.get('LSMinimumSystemVersion'),
      'excludedOptionalPackages':sorted(excluded_optional),
      'slim':args.slim,
      'pruning':pruning,
      'sourceHashes':{str(p.relative_to(app)):hashlib.sha256(p.read_bytes()).hexdigest() for p in app.rglob('*') if p.is_file() and 'node_modules' not in p.parts and '__pycache__' not in p.parts},
      'signature':'ad-hoc; not notarized','fixturesIncluded':False,'hostCredentialsIncluded':False}
    # A candidate built under dist/<staging>/ must not replace the current package's evidence.
    (out.parent/'package-evidence.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2))
    summary={k:v for k,v in evidence.items() if k not in {'sourceHashes','pruning'}}
    if pruning is not None:
        summary['pruning']={k:pruning[k] for k in ('groups','removedFiles','removedBytes','protectedFilesUnchanged')}
    print(json.dumps(summary,ensure_ascii=False,indent=2))

if __name__=='__main__': main()
