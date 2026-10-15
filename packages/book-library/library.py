"""Private EPUB registry. ZIP bytes and business text identity are intentionally distinct."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import tempfile
import plistlib
from urllib.parse import unquote, urlsplit
import zipfile
from xml.etree import ElementTree as ET

MAX_ARCHIVE = 256 * 1024 * 1024
MAX_EXPANDED = 512 * 1024 * 1024
MAX_MEMBER = 64 * 1024 * 1024
MAX_FILES = 20000


def cover_resource(bundle, entry):
    """Cache only bounded passive raster covers; never serve arbitrary OPF resources."""
    try:
        root = xml(bundle / 'META-INF/container.xml')
        ref = next(n.get('full-path') for n in root.iter() if n.tag.rsplit('}', 1)[-1] == 'rootfile')
        opf = local_path(bundle, ref, bundle)
        package = xml(opf)
        items = {n.get('id'): n for n in package.iter() if n.tag.rsplit('}', 1)[-1] == 'item'}
        cover_ids = [n.get('content') for n in package.iter() if n.tag.rsplit('}', 1)[-1] == 'meta' and n.get('name') == 'cover']
        candidates = [n for n in items.values() if 'cover-image' in n.get('properties', '').split()]
        candidates += [items[i] for i in cover_ids if i in items]
        # EPUB 2 cover pages may identify the raster only through the guide XHTML.
        candidates += [n for n in items.values() if n.get('media-type', '').startswith('image/') and 'cover' in (n.get('id', '') + n.get('href', '')).lower()]
        for node in candidates:
            image = local_path(opf.parent, node.get('href', ''), bundle)
            if not image.is_file() or image.stat().st_size > 8 * 1024 * 1024:
                continue
            data = image.read_bytes()
            kind = ('png', 'image/png') if data.startswith(b'\x89PNG\r\n\x1a\n') else ('jpg', 'image/jpeg') if data.startswith(b'\xff\xd8\xff') else ('webp', 'image/webp') if data[:4] == b'RIFF' and data[8:12] == b'WEBP' else None
            if not kind:
                continue
            dest = entry / ('cover.' + kind[0])
            if dest.is_symlink():
                continue
            if not dest.exists() or dest.read_bytes() != data:
                dest.write_bytes(data)
            return {'coverPath': str(dest), 'coverMime': kind[1], 'coverDigest': hashlib.sha256(data).hexdigest()[:16], 'coverStatus': 'available'}
        return {'coverStatus': 'unsupported' if candidates else 'missing'}
    except (OSError, ValueError, ET.ParseError, StopIteration, TypeError):
        pass
    return {'coverStatus': 'unavailable'}


def inspect_apple_epub(source):
    try:
        if not source.exists():
            return 'not-downloaded', '尚未下载到本机，或原书已移动'
        if getattr(source.stat(), 'st_flags', 0) & getattr(stat, 'SF_DATALESS', 0):
            return 'not-downloaded', '尚未下载到本机'
        if source.is_symlink():
            raise ValueError('Symbolic links are not supported')
        if source.is_dir():
            # Validate through a disposable snapshot to apply the same link/path limits as import.
            with tempfile.TemporaryDirectory(prefix='ai-reading-scan-') as temp:
                archive = Path(temp) / 'source.epub'
                archive_directory(source, archive)
                unpack(archive, Path(temp) / 'book.epub')
        elif source.stat().st_size > MAX_ARCHIVE:
            return 'too-large', '文件超过导入大小限制'
        else:
            with tempfile.TemporaryDirectory(prefix='ai-reading-scan-') as temp:
                unpack(source, Path(temp) / 'book.epub')
        return 'available', '可导入'
    except PermissionError:
        return 'permission-denied', '没有读取权限'
    except Exception as exc:
        if 'not downloaded' in str(exc):
            return 'not-downloaded', '部分书籍资源尚未下载到本机'
        if 'Encrypted' in str(exc) or 'encrypted' in str(exc):
            return 'protected', '受保护的 EPUB，客户端不解密'
        return 'invalid', 'EPUB 损坏、资源缺失或格式不支持'


def scan_apple_books(home=None):
    """Read local discovery sources, without opening SQLite/WAL or mutating Apple state."""
    home = Path(home or Path.home())
    local = home / 'Library/Containers/com.apple.BKAgentService/Data/Documents/iBooks/Books'
    cloud = home / 'Library/Mobile Documents/iCloud~com~apple~iBooks/Documents'
    found, issues = {}, []
    try:
        with (local / 'Books.plist').open('rb') as stream:
            data = plistlib.load(stream)
        for item in data.get('Books', []) if isinstance(data, dict) else []:
            if not isinstance(item, dict): continue
            raw = item.get('path') or ''
            if not isinstance(raw, str): continue
            parsed = urlsplit(raw)
            source = Path(unquote(parsed.path)) if parsed.scheme == 'file' else Path(raw)
            if raw and source.suffix.lower() == '.epub':
                if not source.is_absolute(): source = local / source
                found[str(source)] = {'title': item.get('itemName') or source.stem, 'author': item.get('artistName') or ''}
    except FileNotFoundError:
        pass
    except PermissionError:
        issues.append({'code': 'permission-denied', 'message': '无法读取 Apple Books 书目权限'})
    except (ValueError, OSError, plistlib.InvalidFileException):
        issues.append({'code': 'invalid-catalog', 'message': 'Apple Books 书目不可读取，尝试本地目录'})
    for folder in (local, cloud):
        try:
            for p in folder.iterdir():
                if p.suffix.lower() == '.epub':
                    found.setdefault(str(p), {'title': p.stem, 'author': ''})
                elif p.name.startswith('.') and p.name.endswith('.epub.icloud'):
                    target = p.with_name(p.name[1:-7])
                    found.setdefault(str(target), {'title': target.stem, 'author': ''})
        except FileNotFoundError:
            pass
        except PermissionError:
            issues.append({'code': 'permission-denied', 'message': 'Apple Books 本地目录没有读取权限'})
    result = []
    for raw, metadata in sorted(found.items()):
        status, reason = inspect_apple_epub(Path(raw))
        result.append({'id': 'apple_' + hashlib.sha256(raw.encode()).hexdigest()[:24], **metadata,
                       'path': raw, 'status': status, 'reason': reason, 'available': status == 'available'})
    return {'books': result, 'issues': issues, 'scope': 'local-readable-epub'}


def engine():
    spec = importlib.util.spec_from_file_location('desktop_books_rag', Path(__file__).parents[2] / 'books_rag.py')
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def local_path(base, href, root):
    decoded = unquote(href)
    url = urlsplit(decoded)
    if url.scheme or url.netloc or '\\' in decoded or '\x00' in decoded:
        raise ValueError('EPUB contains a non-local resource path')
    p = (base / url.path).resolve()
    if not p.is_relative_to(root.resolve()):
        raise ValueError('EPUB resource escapes package')
    return p


def xml(path):
    raw = path.read_bytes()
    if b'<!ENTITY' in raw.upper() or b'<!DOCTYPE' in raw.upper():
        raise ValueError('XML entities/DTD are not supported')
    return ET.fromstring(raw)


def navigation_title(bundle, opf, href, fallback):
    """Display-only TOC lookup. Never changes normalized text, anchors or identity."""
    try:
        target = local_path(opf.parent, href, bundle)
        package = xml(opf)
        for item in package.iter():
            if item.tag.rsplit('}', 1)[-1] != 'item':
                continue
            is_nav = 'nav' in item.get('properties', '').split()
            is_ncx = item.get('media-type') == 'application/x-dtbncx+xml'
            if not (is_nav or is_ncx):
                continue
            nav_path = local_path(opf.parent, item.get('href', ''), bundle)
            if nav_path.stat().st_size > 2 * 1024 * 1024:
                continue
            nav = xml(nav_path)
            for node in nav.iter():
                tag = node.tag.rsplit('}', 1)[-1]
                if is_nav and tag == 'a':
                    ref, label = node.get('href', ''), ''.join(node.itertext()).strip()
                elif is_ncx and tag == 'navPoint':
                    content = next((n for n in node if n.tag.rsplit('}', 1)[-1] == 'content'), None)
                    name = next((n for n in node if n.tag.rsplit('}', 1)[-1] == 'navLabel'), None)
                    ref, label = (content.get('src', '') if content is not None else ''), (''.join(name.itertext()).strip() if name is not None else '')
                else:
                    continue
                if ref and label and local_path(nav_path.parent, ref, bundle) == target:
                    return label[:300]
    except (OSError, ValueError, ET.ParseError):
        pass
    return fallback


def validate_package(bundle):
    root = xml(bundle / 'META-INF/container.xml')
    refs = [n.get('full-path') for n in root.iter() if n.tag.rsplit('}', 1)[-1] == 'rootfile']
    if not refs or not refs[0]:
        raise ValueError('EPUB has no OPF rootfile')
    opf = local_path(bundle, refs[0], bundle)
    package = xml(opf)
    ids = set()
    spine = []
    for node in package.iter():
        tag = node.tag.rsplit('}', 1)[-1]
        if tag == 'item':
            href = node.get('href', '')
            if not href or not local_path(opf.parent, href, bundle).is_file():
                raise ValueError('EPUB manifest resource missing or invalid')
            ids.add(node.get('id'))
        elif tag == 'itemref':
            spine.append(node.get('idref'))
    if not spine or any(i not in ids for i in spine):
        raise ValueError('EPUB spine is missing or invalid')
    if (bundle / 'META-INF/encryption.xml').exists():
        enc = xml(bundle / 'META-INF/encryption.xml')
        # Font obfuscation is allowed; protected publication content is not decrypted.
        allowed = {'http://www.idpf.org/2008/embedding', 'http://ns.adobe.com/pdf/enc#RC'}
        if any(n.get('Algorithm') not in allowed for n in enc.iter() if n.tag.endswith('EncryptionMethod')):
            raise ValueError('Encrypted EPUB content is unsupported')


def unpack(source, bundle):
    with zipfile.ZipFile(source) as z:
        entries = z.infolist()
        if len(entries) > MAX_FILES or sum(i.file_size for i in entries) > MAX_EXPANDED:
            raise ValueError('EPUB exceeds extraction limits')
        names = set()
        for item in entries:
            name = item.filename
            parts = PurePosixPath(name).parts
            if not name or name.startswith('/') or '..' in parts or '\\' in name or '\x00' in name:
                raise ValueError('Unsafe ZIP path')
            folded = name.rstrip('/').casefold()
            if folded in names:
                raise ValueError('Duplicate ZIP path')
            names.add(folded)
            mode = item.external_attr >> 16
            if item.flag_bits & 1:
                raise ValueError('Encrypted ZIP entry is unsupported')
            if stat.S_ISLNK(mode) or item.file_size > MAX_MEMBER:
                raise ValueError('Unsupported ZIP entry')
            dest = local_path(bundle, name, bundle)
            if item.is_dir():
                dest.mkdir(parents=True, exist_ok=True)
            else:
                dest.parent.mkdir(parents=True, exist_ok=True)
                with z.open(item) as src, dest.open('xb') as out:
                    shutil.copyfileobj(src, out)
        if (bundle / 'mimetype').read_text().strip() != 'application/epub+zip':
            raise ValueError('Not an EPUB publication')
    validate_package(bundle)


def list_books(root):
    root = Path(root).resolve()
    books = []
    for record in sorted((root / 'entries').glob('*/record.json')):
        try:
            data = json.loads(record.read_text())
            entry = record.parent
            if entry.is_symlink() or entry.parent.resolve() != root / 'entries':
                continue
            if data['id'] != entry.name:
                continue
            bundle, archive = entry / 'book.epub', entry / 'source.epub'
            if bundle.is_symlink() or archive.is_symlink() or not bundle.is_dir() or not archive.is_file():
                continue
            data.update(enginePath=str(bundle), archivePath=str(archive))
            data.update(cover_resource(bundle, entry))
            books.append(data)
        except (ValueError, KeyError, OSError):
            continue
    return books


def archive_directory(source, archive):
    """Snapshot an expanded Apple Books EPUB without following links or changing it."""
    if source.suffix.lower() != '.epub':
        raise ValueError('Select an EPUB file or .epub book package')
    entries = []
    total = 0
    for base, dirs, files in os.walk(source, followlinks=False):
        for name in sorted(dirs + files):
            path = Path(base) / name
            info = path.lstat()
            if getattr(info, 'st_flags', 0) & getattr(stat, 'SF_DATALESS', 0):
                raise ValueError('EPUB resource not downloaded')
            if stat.S_ISLNK(info.st_mode) or not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)):
                raise ValueError('Unsupported EPUB package entry')
            if stat.S_ISREG(info.st_mode):
                total += info.st_size
                entries.append(path)
                if info.st_size > MAX_MEMBER or total > MAX_EXPANDED or len(entries) > MAX_FILES:
                    raise ValueError('EPUB exceeds extraction limits')
    # EPUB requires uncompressed mimetype as its first archive member.
    entries.sort(key=lambda p: (p.relative_to(source).as_posix() != 'mimetype', p.relative_to(source).as_posix()))
    with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED) as z:
        copied = 0
        for path in entries:
            name = path.relative_to(source).as_posix()
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
            with os.fdopen(fd, 'rb') as stream:
                if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                    raise ValueError('Unsupported EPUB package entry')
                data = stream.read(MAX_MEMBER + 1)
            copied += len(data)
            if len(data) > MAX_MEMBER or copied > MAX_EXPANDED:
                raise ValueError('EPUB exceeds extraction limits')
            z.writestr(name, data, compress_type=zipfile.ZIP_STORED if name == 'mimetype' else zipfile.ZIP_DEFLATED)


def import_book(root, source):
    root, source = Path(root).resolve(), Path(source).resolve()
    if not source.is_dir() and (not source.is_file() or source.stat().st_size > MAX_ARCHIVE):
        raise ValueError('EPUB file missing or exceeds 256 MiB')
    (root / 'entries').mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.import-', dir=root) as temp:
        staging = Path(temp)
        archive = staging / 'source.epub'
        if source.is_dir():
            archive_directory(source, archive)
        else:
            shutil.copyfile(source, archive)
        if archive.stat().st_size > MAX_ARCHIVE:
            raise ValueError('EPUB exceeds 256 MiB')
        archive_hash = hashlib.sha256(archive.read_bytes()).hexdigest()
        bundle = staging / 'book.epub'
        bundle.mkdir()
        unpack(archive, bundle)
        rag = engine()
        data = rag.extract_chapters(bundle)
        if not data['chapters']:
            raise ValueError('EPUB has no readable text')
        version = rag.book_version_id(data['chapters'])
        identity = rag.content_digest(version)
        # Repacked files of identical extracted text resolve to the existing book.
        for existing in list_books(root):
            if existing['bookId'] == identity:
                return {**existing, 'alreadyImported': True}
        entry_id = 'book_' + identity
        record = dict(id=entry_id, bookId=identity, bookVersionId=version,
                      title=data['title'], author=data.get('author') or '',
                      archiveSha256=archive_hash, source='standalone-epub', schemaVersion=1)
        (staging / 'record.json').write_text(json.dumps(record, ensure_ascii=False, indent=2))
        target = root / 'entries' / entry_id
        try:
            os.rename(staging, target)
        except OSError:
            if not (target / 'record.json').exists():
                raise
        return next(b for b in list_books(root) if b['id'] == entry_id)


def engine_request(root, route, payload=None):
    from urllib.parse import urlparse, parse_qs
    root = Path(root).resolve()
    os.environ.update(AI_READING_BOOK_PROVIDER='standalone', AI_READING_LIBRARY_ROOT=str(root),
                      APPLE_READ_INDEX=str(root / 'index'))
    rag = engine()
    url = urlparse(route)
    query = parse_qs(url.query)
    payload = payload or {}
    if url.path == '/books':
        return {'books': rag.find_books(), 'annotations_available': False}
    if url.path == '/health':
        return {'ok': True, 'annotations': False, 'rerank': False, 'provider': 'standalone'}
    if url.path == '/book-identity':
        return rag.book_identity(payload.get('path') or query.get('path', [''])[0])
    if url.path == '/annotations':
        return {'annotations': []}
    if url.path == '/source-chapter':
        from urllib.parse import unquote
        import posixpath
        entry = next((b for b in list_books(root) if b['id'] == payload.get('bookId')), None)
        if not entry:
            raise ValueError('Book is not registered')
        bundle = Path(entry['enginePath'])
        opf = rag._find_opf(bundle)
        if not opf:
            raise ValueError('EPUB package unavailable')
        prefix = opf.parent.relative_to(bundle).as_posix()
        canonical = lambda href: posixpath.normpath(unquote(urlparse(str(href)).path)).lstrip('/')
        wanted = canonical(payload.get('href', ''))
        extracted = rag.cached_extract_chapters(bundle)
        matches = [(order, chapter) for order, chapter in enumerate(extracted['chapters'])
                   if any(canonical(posixpath.join(prefix, seg['href'])) == wanted for seg in chapter['segments'])]
        if len(matches) != 1:
            raise ValueError('EPUB file does not resolve to a unique chapter')
        version = rag.book_version_id(extracted['chapters'])
        if version != entry['bookVersionId']:
            raise ValueError('Book content changed; import the current EPUB again')
        order, chapter = matches[0]
        return {'ok': True, 'book_id': entry['bookId'], 'book_version_id': version,
                'chapterOrder': order, 'title': navigation_title(bundle, opf, chapter['segments'][0]['href'], chapter.get('title', '原文片段')), 'segments': [{**seg, 'text': chapter['text'][seg['start_codepoint']:seg['end_codepoint']]}
                                                   for seg in chapter['segments']]}
    if url.path in ('/source-span', '/source-mapping'):
        span = rag.read_source_span(payload.get('span_id', ''))
        if url.path == '/source-span' or not span.get('ok'):
            return span
        book = rag.find_book_by_content_id(span['book_id'])
        extracted = rag.cached_extract_chapters(Path(book['path']))
        chapter = extracted['chapters'][span['section_order']]
        return {'ok': True, 'title': navigation_title(Path(book['path']), rag._find_opf(Path(book['path'])), span['href'], chapter.get('title', '原文片段')), 'span': span, 'book_id': span['book_id'],
                'book_version_id': span['book_version_id'], 'chapterOrder': span['section_order'],
                'segments': [{**seg, 'text': chapter['text'][seg['start_codepoint']:seg['end_codepoint']]}
                             for seg in chapter['segments']]}
    if url.path in ('/index', '/search'):
        book = rag.resolve_book(payload.get('book', ''))
        if not book:
            return {'ok': False, 'code': 'BOOK_NOT_IN_LIBRARY', 'error': 'Exact registered book identity required'}
        try:
            if url.path == '/index':
                meta = rag.build_index(book, log=lambda _message: None, force=bool(payload.get('force')))
                return {'ok': True, 'meta': meta}
            result = rag.search(book, str(payload.get('query', '')), k=min(30,max(1,int(payload.get('k',6)))), rerank=False)
            chapters = rag.cached_extract_chapters(Path(book['path']))['chapters']
            digest = rag.content_digest(rag.book_version_id(chapters))
            result.update(ok=True, book_id=digest, retrieval='semantic-hybrid', model=rag.MODEL)
            for hit in result['hits']:
                matches = []
                for chapter in chapters:
                    text = chapter['text']; start = text.find(hit['text'])
                    while start >= 0:
                        matches.append((chapter['order'], start, start + len(hit['text'])))
                        if len(matches) > 1: break
                        start = text.find(hit['text'], start + 1)
                    if len(matches) > 1: break
                if len(matches) == 1:
                    order, start, end = matches[0]
                    span_id = f'sp_{digest}_{order}_{start}_{end}'
                    span = rag.read_source_span(span_id)
                    if span.get('verified') and span.get('quote') == hit['text']:
                        hit.update(span_id=span_id, source_ref=span, exact=True)
                        continue
                hit.update(exact=False, source_status='chapter-candidate-only')
            return result
        except ImportError:
            return {'ok': False, 'code': 'SEMANTIC_DEPENDENCIES_MISSING', 'error': '语义依赖未准备，请安装完整客户端或运行 scripts/prepare-semantic.py'}
        except Exception as exc:
            return {'ok': False, 'code': 'SEMANTIC_MODEL_NOT_PREPARED' if 'SEMANTIC_MODEL_NOT_PREPARED' in str(exc) else 'SEMANTIC_OPERATION_FAILED', 'error': str(exc)}
    if url.path == '/analyze-chapter':
        book = rag.resolve_book(payload.get('book', ''))
        if not book:
            return {'ok': False, 'code': 'BOOK_NOT_IN_LIBRARY', 'error': 'Exact registered book identity required'}
        return rag.analyze_chapter(book, {key: payload[key] for key in ('window_chars', 'sections') if key in payload})
    raise ValueError('Unsupported standalone engine route')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['list', 'import', 'engine', 'apple-scan'])
    parser.add_argument('--root', required=True)
    parser.add_argument('--file')
    parser.add_argument('--route')
    parser.add_argument('--payload', default='{}')
    args = parser.parse_args()
    try:
        if args.command == 'apple-scan':
            result = scan_apple_books()
        elif args.command == 'engine':
            result = engine_request(args.root, args.route, json.loads(args.payload))
        else:
            result = list_books(args.root) if args.command == 'list' else import_book(args.root, args.file)
        print(json.dumps({'ok': True, 'result': result}, ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({'ok': False, 'error': str(exc)}, ensure_ascii=False))
        raise SystemExit(1)
