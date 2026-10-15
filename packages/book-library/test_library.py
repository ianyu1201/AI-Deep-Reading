import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile
import plistlib
sys.path.insert(0, str(Path(__file__).parent))
import library


def fixture(path, text='Learning requires feedback. ' * 30, extra=None, href='chapter.xhtml', compression=zipfile.ZIP_STORED):
    with zipfile.ZipFile(path, 'w', compression=compression) as z:
        z.writestr('mimetype', 'application/epub+zip')
        z.writestr('META-INF/container.xml', '<container><rootfiles><rootfile full-path="EPUB/book.opf"/></rootfiles></container>')
        z.writestr('EPUB/book.opf', '<package><metadata><title>Same title</title><creator>Author</creator></metadata><manifest><item id="c" href="'+href+'"/></manifest><spine><itemref idref="c"/></spine></package>')
        z.writestr('EPUB/chapter.xhtml', '<html><body><h1>Chapter</h1><p>'+text+'</p></body></html>')
        if extra:
            z.writestr(*extra)


class LibraryTest(unittest.TestCase):
    def test_cover_cache_and_legacy_refresh(self):
        with zipfile.ZipFile(self.source) as z:
            contents = {n:z.read(n) for n in z.namelist()}
        contents['EPUB/book.opf'] = contents['EPUB/book.opf'].replace(b'</manifest>', b'<item id="cover" href="cover.jpg" properties="cover-image" media-type="image/jpeg"/></manifest>')
        contents['EPUB/cover.jpg'] = b'\xff\xd8\xff' + b'cover-test'
        with zipfile.ZipFile(self.source, 'w') as z:
            for n, data in contents.items(): z.writestr(n, data)
        entry = library.import_book(self.root, self.source)
        self.assertEqual(entry['coverMime'], 'image/jpeg')
        cached = Path(entry['coverPath'])
        self.assertEqual(cached.read_bytes(), contents['EPUB/cover.jpg'])
        cached.unlink()
        self.assertEqual(library.list_books(self.root)[0]['coverDigest'], entry['coverDigest'])
        self.assertTrue(cached.is_file())
        self.assertNotIn('coverPath', json.loads((cached.parent/'record.json').read_text()))

    def test_apple_discovery_status_and_readonly(self):
        local = self.base/'Library/Containers/com.apple.BKAgentService/Data/Documents/iBooks/Books'
        cloud = self.base/'Library/Mobile Documents/iCloud~com~apple~iBooks/Documents'
        local.mkdir(parents=True); cloud.mkdir(parents=True)
        expanded = cloud/'expanded.epub'
        with zipfile.ZipFile(self.source) as z: z.extractall(expanded)
        (cloud/'bad.epub').write_bytes(b'notzip')
        (cloud/'.offline.epub.icloud').write_bytes(b'')
        missing = cloud/'missing.epub'
        plist = local/'Books.plist'
        plist.write_bytes(plistlib.dumps({'Books':[
            {'path':str(expanded),'itemName':'Proper title','artistName':'Real author'},
            {'path':str(missing),'itemName':'Missing'}]}))
        before = {str(p):p.read_bytes() for p in self.base.rglob('*') if p.is_file()}
        result = library.scan_apple_books(self.base)
        by_title = {b['title']:b for b in result['books']}
        self.assertEqual(len(result['books']),4)
        self.assertEqual(by_title['Proper title']['status'],'available')
        self.assertEqual(by_title['Missing']['status'],'not-downloaded')
        self.assertEqual(by_title['offline']['status'],'not-downloaded')
        self.assertEqual(by_title['bad']['status'],'invalid')
        self.assertEqual(before,{str(p):p.read_bytes() for p in self.base.rglob('*') if p.is_file()})
        (expanded/'META-INF/encryption.xml').write_text('<encryption><EncryptionMethod Algorithm="DRM"/></encryption>')
        self.assertEqual(library.inspect_apple_epub(expanded)[0],'protected')

    def test_navigation_title_is_display_only_and_bounded(self):
        bundle = self.base / 'nav-book'
        folder = bundle / 'EPUB'
        folder.mkdir(parents=True)
        opf = folder / 'book.opf'
        opf.write_text('<package><manifest><item href="nav.xhtml" properties="nav"/></manifest></package>')
        (folder / 'chapter.xhtml').write_text('<html><body>Unchanged source</body></html>')
        nav = folder / 'nav.xhtml'
        nav.write_text('<html><body><nav><a href="chapter.xhtml#section">第一章 反馈</a></nav></body></html>')
        before = (folder / 'chapter.xhtml').read_bytes()
        self.assertEqual(library.navigation_title(bundle, opf, 'chapter.xhtml', 'Fallback'), '第一章 反馈')
        self.assertEqual(library.navigation_title(bundle, opf, 'other.xhtml', 'Fallback'), 'Fallback')
        self.assertEqual((folder / 'chapter.xhtml').read_bytes(), before)
        nav.write_text('<!DOCTYPE html [<!ENTITY secret SYSTEM "file:///etc/passwd">]><html>&secret;</html>')
        self.assertEqual(library.navigation_title(bundle, opf, 'chapter.xhtml', 'Fallback'), 'Fallback')

    def test_source_chapter(self):
        entry = library.import_book(self.root, self.source)
        result = library.engine_request(self.root, '/source-chapter', {'bookId': entry['id'], 'href': 'EPUB/chapter.xhtml'})
        self.assertEqual(result['book_id'], entry['bookId'])
        self.assertEqual(result['chapterOrder'], 0)
        self.assertIn('Learning requires feedback.', result['segments'][0]['text'])
        self.assertEqual(len(result['segments'][0]['text']), result['segments'][0]['end_codepoint'])
        with self.assertRaises(ValueError):
            library.engine_request(self.root, '/source-chapter', {'bookId': entry['id'], 'href': 'other.xhtml'})
        with self.assertRaises(ValueError):
            library.engine_request(self.root, '/source-chapter', {'bookId': 'unknown', 'href': 'EPUB/chapter.xhtml'})

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.root = self.base / 'library'
        self.source = self.base / 'sample.epub'
        fixture(self.source)
    def tearDown(self):
        self.temp.cleanup()
    def test_persistence_identity_repack_same_title(self):
        one = library.import_book(self.root, self.source)
        self.assertTrue(Path(one['archivePath']).is_file())
        self.assertTrue(Path(one['enginePath']).is_dir())
        fixture(self.source, compression=zipfile.ZIP_DEFLATED)
        again = library.import_book(self.root, self.source)
        self.assertEqual(one['bookId'], again['bookId'])
        self.assertTrue(again['alreadyImported'])
        fixture(self.source, text='Another book entirely. ' * 40)
        two = library.import_book(self.root, self.source)
        self.assertEqual(one['title'], two['title'])
        self.assertNotEqual(one['bookId'], two['bookId'])
        self.assertEqual(len(library.list_books(self.root)), 2)
    def test_expanded_apple_package(self):
        package = self.base / 'expanded.epub'
        with zipfile.ZipFile(self.source) as z: z.extractall(package)
        before = {str(p): p.read_bytes() for p in package.rglob('*') if p.is_file()}
        expanded = library.import_book(self.root, package)
        zipped = library.import_book(self.root, self.source)
        self.assertEqual(expanded['bookId'], zipped['bookId'])
        self.assertTrue(zipped['alreadyImported'])
        self.assertEqual(before, {str(p): p.read_bytes() for p in package.rglob('*') if p.is_file()})
        (package / 'escape').symlink_to(self.source)
        with self.assertRaises(ValueError): library.import_book(self.root, package)

    def test_non_body_recommendations_preserve_identity(self):
        fixture(self.source, text='版权信息 ISBN 123 版权所有。' * 10)
        entry = library.import_book(self.root, self.source)
        result = library.engine_request(self.root, '/analyze-chapter', {'book': entry['enginePath']})
        self.assertEqual(result['book_version_id'], entry['bookVersionId'])
        self.assertEqual(result['candidates'], [])
        self.assertGreater(result['coverage']['analyzed_units'], 0)
        self.assertEqual(result['chapters'][0]['recommendation_excluded_reason'], 'publication_metadata')
        rag = library.engine()
        package = Path(entry['enginePath'])
        chapter = package / 'EPUB/chapter.xhtml'
        chapter.write_text('<html><body><ul>' + ''.join('<li><a href="chapter.xhtml#s'+str(i)+'">真实章节标题'+str(i)+'</a></li>' for i in range(10)) + '</ul></body></html>')
        ch = rag.extract_chapters(package)['chapters'][0]
        self.assertEqual(rag.recommendation_exclusion(ch, package), 'navigation_document')
        chapter.write_text('<html><body><p>正文讨论书籍版权和系统运行，不是版权页。</p><p>' + '实际内容与论证。'*100 + '</p></body></html>')
        ch = rag.extract_chapters(package)['chapters'][0]
        self.assertIsNone(rag.recommendation_exclusion(ch, package))
        merged = {**ch, 'text':'封面\n书名\n目录\n' + '\n'.join('第'+str(i)+'章 标题' for i in range(12))}
        self.assertEqual(rag.recommendation_exclusion(merged, package), 'navigation_document')

    def test_bad_zip(self):
        self.source.write_text('not zip')
        with self.assertRaises(zipfile.BadZipFile): library.import_book(self.root, self.source)
        self.assertEqual(library.list_books(self.root), [])
    def test_zip_escape(self):
        fixture(self.source, extra=('../escape', 'secret'))
        with self.assertRaises(ValueError): library.import_book(self.root, self.source)
        self.assertFalse((self.base / 'escape').exists())
    def test_opf_escape(self):
        fixture(self.source, href='../../../../outside.xhtml')
        with self.assertRaises(ValueError): library.import_book(self.root, self.source)
    def test_remote_manifest_rejected(self):
        fixture(self.source, href='https://example.com/chapter.xhtml')
        with self.assertRaises(ValueError): library.import_book(self.root, self.source)
    def test_symlink_rejected(self):
        with zipfile.ZipFile(self.source, 'a') as z:
            info = zipfile.ZipInfo('link'); info.external_attr = 0o120777 << 16
            z.writestr(info, '/etc/passwd')
        with self.assertRaises(ValueError): library.import_book(self.root, self.source)
    def test_provider_exact_no_apple(self):
        one = library.import_book(self.root, self.source)
        script = '''
import importlib.util, os
spec=importlib.util.spec_from_file_location('rag',os.environ['RAG'])
r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
assert r.load_library()=={}
assert r.load_annotations()==[]
b=r.find_books();assert len(b)==1
assert r.resolve_book(b[0]['title']) is None
assert r.resolve_book(b[0]['path'])['book_id']==b[0]['book_id']
assert r.book_identity(b[0]['path'])['book_id']==b[0]['book_id']
assert r.book_identity('/etc/passwd')['ok'] is False
'''
        subprocess.run([sys.executable, '-c', script], check=True, env={**os.environ,
            'AI_READING_BOOK_PROVIDER':'standalone', 'AI_READING_LIBRARY_ROOT':str(self.root),
            'APPLE_READ_INDEX':str(self.base / 'index'), 'RAG':str(Path(library.__file__).parents[2] / 'books_rag.py')})
    def test_engine_and_mapping(self):
        one = library.import_book(self.root, self.source)
        original = dict(os.environ)
        try:
            books = library.engine_request(self.root, '/books')['books']
            identity = library.engine_request(self.root, '/book-identity', {'path':one['enginePath']})
            self.assertEqual(identity['book_id'], one['bookId'])
            self.assertEqual(books[0]['path'], one['enginePath'])
            result = library.engine_request(self.root, '/analyze-chapter', {'book':one['enginePath']})
            self.assertEqual(result['book_version_id'], one['bookVersionId'])
            span_id = 'sp_' + one['bookId'] + '_0_0_7'
            mapping = library.engine_request(self.root, '/source-mapping', {'span_id':span_id})
            self.assertTrue(mapping['ok'])
            self.assertEqual(mapping['span']['quote'], 'Chapter')
            self.assertTrue(mapping['segments'][0]['text'].startswith('Chapter'))
            self.assertFalse(library.engine_request(self.root, '/source-span', {'span_id':'sp_' + one['bookId'] + '_0_0_999999'})['ok'])
            self.assertFalse(library.engine_request(self.root, '/analyze-chapter', {'book':'Same title'})['ok'])
        finally:
            os.environ.clear(); os.environ.update(original)
    def test_expansion_limit(self):
        old = library.MAX_EXPANDED
        try:
            library.MAX_EXPANDED = 30
            with self.assertRaises(ValueError): library.import_book(self.root, self.source)
        finally: library.MAX_EXPANDED = old

if __name__ == '__main__': unittest.main()
