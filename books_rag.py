#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["fastembed>=0.4.0", "numpy", "jieba", "mcp<2"]
# ///
"""Apple Books 向量伴读引擎 —— 把 macOS「图书」App 的书库变成可语义检索的知识库。

和 books-ai-reader 那套 BM25 关键词检索不同：这里是真正的向量检索（本地 embedding
模型，离线、免费、书稿不出本机），换个说法也能召回；再叠一点字面加权，兼顾中文
人名/专名。

数据来源（全部只读）：
  · 全书正文  ~/Library/Mobile Documents/iCloud~com~apple~iBooks/Documents/<书名>.epub/
              —— 是「解包后的目录」不是 zip，内部有 4 种布局，统一走 META-INF/container.xml
  · 书目元数据 .../com.apple.iBooksX/Data/Documents/BKLibrary/BKLibrary*.sqlite
              —— ZBKLIBRARYASSET，提供 ZPATH（书 ↔ asset id 的可靠映射）、标题、作者、进度
  · 高亮/笔记 .../com.apple.iBooksX/Data/Documents/AEAnnotation/AEAnnotation*.sqlite
              —— ZAEANNOTATION，需「完全磁盘访问权限」
  后两者读不到时自动降级：正文检索照常可用。

子命令：
    list                      列出书库（含索引/标注状态）
    index --book X | --all    建/重建向量索引（--all 增量）
    search --book X "问题"    向量检索
    annotations [--book X]    列出高亮/笔记
    context --id N            还原某条标注的前后原文
    open --book X             在「图书」App 中打开
    analyze-chapter --book X  逐章分析：连续窗口 + 逐窗消费证据 + 概括/切片候选（M8）
    source-span --id SP       按 span_id 取原文（M8；PRD :917 的 get_source_span）
    book-identity --path P    按路径给出这本书的**内容身份**（M13：路径只定位，内容才是身份）
    serve                     以 MCP stdio server 运行（给 DeepSeek Harness 用）
    serve-http [--port N]     起本地 HTTP 服务（给侧边栏面板用）
全局 --json 输出机器可读结果。

M13（内容寻址）：书的身份 = `book_version_id`（各章正文的 sha256 前 16 位，同内容同 id、
与路径无关）。派生 id（`sec_*` / `sp_*` / `ca_*`）里嵌的是它的 16 位摘要。
**不再有 `path_hash8`**：书被移动/改名，身份不变。
"""
from __future__ import annotations

import argparse
import glob
import hashlib
import json
import os
import re
import sqlite3
import sys
import time
import unicodedata
from datetime import datetime, timedelta
from html import unescape
from pathlib import Path
from xml.etree import ElementTree as ET

# --------------------------------------------------------------------------- #
# 配置
# --------------------------------------------------------------------------- #
#
# M16 阶段 2：**「书源」的唯一入口就在这里**（全仓库只有这一处决定书从哪来）。
# 换书源只动这里，不要散到别处去：
#   · 正文书源（换书源就换它）—— `BOOKS_DIR`：环境变量 `APPLE_READ_DIR` 优先，
#     没设才回落到 iCloud 里「图书」App 的 Documents 目录。
#     目录里每本书是**解包后的 EPUB 目录**（不是 zip），内部 4 种布局统一走 META-INF/container.xml。
#   · 书目元数据（书名/作者/进度）—— `LIBRARY_DB`（Apple 的 BKLibrary）。
#     **读不到不算失败**：`find_books()` 会继续扫 `BOOKS_DIR` 并把两边**合并**（按路径去重），
#     所以没有 BKLibrary 也能列书（代价是 author/progress/last_opened 为空）。
#   · 高亮/笔记 —— `ANNOTATION_DB`（Apple 的 AEAnnotation）。**这一条没有兜底**：
#     读不到就返回空数组（`load_annotations` 直接 return []），因为非 Apple 的高亮
#     现在没有公认格式。换书源时这一侧要单独决定，方案见
#     `AI 深度阅读/docs/书源接口说明.md` §4（本轮不动它）。
# 插件侧**不认识书源**：它只 spawn `uv run books_rag.py serve-http`，并透传 process.env，
# 所以上面这些环境变量从宿主一路生效，插件里没有第二个书源假设。

HOME = Path.home()
BOOK_PROVIDER = os.environ.get("AI_READING_BOOK_PROVIDER", "apple")
STANDALONE_LIBRARY_ROOT = os.environ.get("AI_READING_LIBRARY_ROOT")
if BOOK_PROVIDER not in ("apple", "standalone"):
    raise RuntimeError("Unknown book provider")
if BOOK_PROVIDER == "standalone" and not STANDALONE_LIBRARY_ROOT:
    raise RuntimeError("Standalone book provider requires AI_READING_LIBRARY_ROOT")

def standalone_entries():
    import importlib.util
    spec = importlib.util.spec_from_file_location("desktop_library", Path(__file__).parent / "packages/book-library/library.py")
    provider = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(provider)
    return provider.list_books(STANDALONE_LIBRARY_ROOT)

BOOKS_DIR = Path(os.environ.get(
    "APPLE_READ_DIR",
    HOME / "Library/Mobile Documents/iCloud~com~apple~iBooks/Documents",
))
INDEX_DIR = Path(os.environ.get("APPLE_READ_INDEX", HOME / "DSH-apple-Read" / "index"))
MODEL = os.environ.get("APPLE_READ_MODEL", "BAAI/bge-small-zh-v1.5")
MODEL_CACHE = os.environ.get("FASTEMBED_CACHE_PATH") or str(HOME / ".cache" / "fastembed")

CONTAINER = HOME / "Library/Containers/com.apple.iBooksX/Data/Documents"
LIBRARY_DB = CONTAINER / "BKLibrary"
ANNOTATION_DB = CONTAINER / "AEAnnotation"

CHUNK_SIZE = 480
CHUNK_OVERLAP = 80
MIN_CHAPTER_CHARS = 120
LEXICAL_WEIGHT = 0.25
# 精排（cross-encoder）：先按混合分取这么多候选，再让 reranker 重新打分排序。
# 只在模型已缓存时才启用 —— 1GB 的模型不该在用户搜一下的时候偷偷下载。
RERANK_MODEL = "BAAI/bge-reranker-base"
# 20 是实测的性价比点：池子 5→50 质量都在 20~22/24 之间（噪声），
# 但耗时从 0.6s 涨到 4.3s。20 留了余量又不太慢。
RERANK_POOL = 20
# 置信度闸门：cross-encoder 的最高分低于这个值，说明它认为「没有一段真的相关」，
# 此时它的排序不可信 —— 实测抽象问题（「这本书到底想说什么」）会被它排乱，
# 而这类问题恰恰是伴读的主场景。低于闸门就退回混合排序。
RERANK_MIN_CONF = 0.5
# spine 抽出来的正文少于这个字数，就怀疑 spine 不完整，去 manifest 里补其余 HTML
SPINE_FALLBACK_CHARS = 20000
# 全书正文少于这个字数，判定为扫描版/空壳书，直接报错而不是建一个没用的索引
MIN_BOOK_CHARS = 3000
_HTML_EXT = (".xhtml", ".html", ".htm")
_IMAGE_EXT = (".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tif", ".tiff")

CD_EPOCH = datetime(2001, 1, 1)
ANNOTATION_TYPES = {0: "未知", 1: "书签", 2: "高亮", 3: "阅读位置"}
HIGHLIGHT_STYLES = {0: "下划线", 1: "绿色", 2: "蓝色", 3: "黄色", 4: "粉色", 5: "紫色"}


# --------------------------------------------------------------------------- #
# 通用小工具
# --------------------------------------------------------------------------- #

def book_id(name: str) -> str:
    """**列表句柄**（不是书身份）：`sha1(epub 目录名)[:16]`。

    M13 起书的**身份**是内容寻址的 `book_version_id`（见 `book_version_id` / `content_digest`）。
    这个函数只剩两个用途：① 向量索引文件名（`INDEX_DIR/<book_id>.json|.npy`，改名会让
    已有索引变孤儿，所以刻意不动）；② 目录扫描兜底时的兜底键。
    它**不得**再被当作身份写进知识库（书档 id / run_id / cov_id / dedup_ref 都不用它）。
    """
    return hashlib.sha1(name.encode("utf-8")).hexdigest()[:16]


def listing_id(path: Path) -> str:
    """列表句柄：`sha1(书目录绝对路径)[:16]`。

    与 `book_id`（只看目录名）的区别：两本**不同内容、同名**的书会撞在 `book_id` 上，
    而面板按 id 做会话内去重 ⇒ 会互相顶掉。这里用完整路径，保证同一份列表里不重复。
    它仍是**路径派生**的临时句柄、**不是身份**（书一挪位置它就变，这是允许的：它不落盘、
    也不出现在任何笔记里）。书身份是 `book_version_id`（内容寻址，要解包才知）。
    """
    return hashlib.sha1(str(path).encode("utf-8")).hexdigest()[:16]


def fold(s: str) -> str:
    """匹配用折叠：全角/半角统一 + 去掉所有空白。只用于比较，不改显示文本。"""
    s = unicodedata.normalize("NFKC", s)
    return re.sub(r"\s+", "", s)


def _fold_map(s: str) -> tuple[str, list[int]]:
    """折叠并把每个输出字符映射回原文下标（NFKC 可能一字变多字）。"""
    out: list[str] = []
    pos: list[int] = []
    for i, ch in enumerate(s):
        if ch.isspace():
            continue
        for c in unicodedata.normalize("NFKC", ch):
            out.append(c)
            pos.append(i)
    return "".join(out), pos


def locate(haystack: str, needle: str) -> tuple[int, int] | None:
    """在原文里定位一段可能标点宽度不同的文字，返回原文下标区间。"""
    n = fold(needle)
    if not n:
        return None
    folded, pos = _fold_map(haystack)
    i = folded.find(n)
    if i < 0:
        return None
    return pos[i], pos[i + len(n) - 1] + 1


def cd_time(ts) -> str | None:
    if not ts:
        return None
    try:
        return (CD_EPOCH + timedelta(seconds=float(ts))).strftime("%Y-%m-%d %H:%M")
    except (TypeError, ValueError):
        return None


def _ro(db: Path):
    """只读打开 sqlite。

    优先 mode=ro：能读到 WAL 里尚未 checkpoint 的最新数据（「图书」App 常驻时数据都在 WAL）。
    只有在 -shm 缺失导致打不开时才退回 immutable，此时可能读到稍旧的快照。
    """
    try:
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        con.execute("select count(*) from sqlite_master").fetchone()
        return con
    except sqlite3.Error:
        return sqlite3.connect(f"file:{db}?immutable=1", uri=True)


# --------------------------------------------------------------------------- #
# 书库：BKLibrary（拿可靠的 path/title/author），失败则降级为扫目录
# --------------------------------------------------------------------------- #

_library_cache: dict | None = None
_library_stamp: tuple | None = None


def _library_fingerprint() -> tuple:
    """BKLibrary 主库 + WAL 的指纹（文件名、mtime_ns、大小）。

    「图书」App 常驻时，新增的书和阅读进度往往先进 WAL 而不落主库，
    所以只看主库文件会漏掉变化——必须把 -wal 一起算进来。

    但**不能**把 `-shm` 算进来：那只是 WAL 的索引，SQLite 每次读都会动它的
    mtime（实测：连续两次只读，-shm 的 mtime_ns 每次都变，主库与 -wal 不动）。
    把它算进去会让指纹永远在变、缓存永远不命中，等于每次都重读一遍库。
    任何逻辑变化都会落到主库或 -wal 上，看这两个就够了。

    注意：函数名不能叫 `_library_stamp`——那个名字是缓存指纹本身，
    同名的话 def 会先把全局值顶掉，随后赋值又把函数顶掉，第二次调用就崩。
    """
    out: list[tuple] = []
    for db in sorted(glob.glob(str(LIBRARY_DB / "BKLibrary*.sqlite"))):
        for suffix in ("", "-wal"):
            p = Path(str(db) + suffix)
            try:
                st = p.stat()
                out.append((p.name, st.st_mtime_ns, st.st_size))
            except OSError:
                out.append((p.name, None, None))
    return tuple(out)


def load_library(force: bool = False) -> dict:
    """asset_id -> {title, author, path, progress, last_opened, finished}。读不到返回 {}。

    缓存按上面的指纹失效：常驻引擎里「图书」App 新增书、更新阅读进度后，
    下一次调用就能读到新值，不必重启。force=True 可强制重读。
    """
    global _library_cache, _library_stamp
    if BOOK_PROVIDER == "standalone":
        return {}
    stamp = _library_fingerprint()
    if (not force and _library_cache is not None and _library_stamp is not None
            and stamp == _library_stamp):
        return _library_cache
    _library_cache = {}
    dbs = sorted(glob.glob(str(LIBRARY_DB / "BKLibrary*.sqlite")))
    if not dbs:
        _library_stamp = stamp
        return _library_cache
    try:
        con = _ro(Path(dbs[0]))
        cur = con.execute("""select ZASSETID, ZTITLE, ZAUTHOR, ZPATH, ZREADINGPROGRESS,
                                    ZLASTOPENDATE, ZISFINISHED, ZGENRE
                             from ZBKLIBRARYASSET""")
        for aid, title, author, path, prog, last, fin, genre in cur:
            if not aid:
                continue
            _library_cache[aid] = {
                "title": title or "", "author": author or "", "path": path or "",
                "progress": float(prog) if prog is not None else 0.0,
                "last_opened": cd_time(last), "finished": bool(fin), "genre": genre or "",
            }
        con.close()
        _library_stamp = stamp
    except sqlite3.Error:
        # 读失败不留指纹：下次调用重试，而不是把空结果一直缓存下去
        _library_cache = {}
        _library_stamp = None
    return _library_cache


def find_books() -> list[dict]:
    """书库列表。优先用 BKLibrary 的 ZPATH（书名与目录名常常不一致），兜底扫目录。

    M13 起这里返回两个**不同**的键，别混：
      · `id`        —— **列表句柄**（`listing_id(路径)`，同一份列表里唯一）。面板拿它做
                       会话内去重/状态键。它**不是书身份**，也不落盘。
      · `index_key` —— 向量索引文件名（`book_id(目录名)`，保持旧值 ⇒ 已有索引不作废）。
    书的**身份**是 `book_version_id`（内容寻址），要解包才算得出来，**不在这里算**
    （列表要快；一次列 29 本书不该解包 29 次）。需要身份走 `/book-identity` 或分析结果。
    """
    if BOOK_PROVIDER == "standalone":
        return [{"id": listing_id(Path(b["enginePath"])), "index_key": b["bookId"],
                 "name": b["id"] + ".epub", "title": b["title"], "author": b["author"],
                 "path": b["enginePath"], "asset_id": None, "progress": 0.0,
                 "last_opened": None, "genre": "", "book_id": b["bookId"],
                 "book_version_id": b["bookVersionId"],
                 "indexed": (INDEX_DIR / (b["bookId"] + ".json")).exists()}
                for b in standalone_entries()]
    books: list[dict] = []
    for aid, rec in load_library().items():
        p = rec.get("path") or ""
        if not p.endswith(".epub"):
            continue
        path = Path(p)
        if not path.is_dir():
            continue
        key = book_id(path.name)
        books.append({
            "id": listing_id(path), "index_key": key,
            "name": path.name, "title": rec["title"] or path.name[:-5],
            "author": rec["author"], "path": str(path), "asset_id": aid,
            "progress": round(rec["progress"] * 100, 1), "last_opened": rec["last_opened"],
            "genre": rec["genre"],
            "indexed": (INDEX_DIR / f"{key}.json").exists(),
        })
    if BOOKS_DIR.is_dir():
        # 与 BKLibrary 合并，而不是「书库为空才扫目录」：刚加进来、还没被「图书」App
        # 登记（或只存在于目录里）的书，也能出现在列表里，否则「刷新书库」永远看不到它。
        #
        # 去重按**路径**（M13 改）：原先按 `id`（只看目录名）去重，两本不同内容、同名的书
        # 会互相顶掉、列表里只剩一本 —— 那是「按文件名当身份」的残留，不是书库真只有一本。
        seen = {b["path"] for b in books}
        for entry in sorted(BOOKS_DIR.iterdir()):
            if entry.name.startswith(".") or not entry.name.endswith(".epub") or not entry.is_dir():
                continue
            if str(entry) in seen:
                continue
            key = book_id(entry.name)
            books.append({
                "id": listing_id(entry), "index_key": key,
                "name": entry.name, "title": entry.name[:-5], "author": "",
                "path": str(entry), "asset_id": None, "progress": 0.0,
                "last_opened": None, "genre": "",
                "indexed": (INDEX_DIR / f"{key}.json").exists(),
            })
    books.sort(key=lambda b: b["title"])
    return books


def resolve_book(query: str) -> dict | None:
    """按书名 / 目录名 / asset id 定位一本书。"""
    q = (query or "").strip()
    if not q:
        return None
    ql = q.lower()
    books = find_books()
    if BOOK_PROVIDER == "standalone":
        # Desktop callers use exact registered path or business identity, never title substrings.
        return next((b for b in books if q in (b["path"], b.get("book_id"), b.get("book_version_id"), b["id"])), None)
    for b in books:
        if b["title"].lower() == ql or b["name"][:-5].lower() == ql:
            return b
    for b in books:
        if b["asset_id"] and b["asset_id"].lower() == ql:
            return b
    for b in books:
        if b["title"].lower().startswith(ql) or b["name"][:-5].lower().startswith(ql):
            return b
    for b in books:
        if ql in b["title"].lower() or ql in b["name"].lower():
            return b
    return None


# --------------------------------------------------------------------------- #
# epub 解析（四种布局：content.opf 在根 / OEBPS / EPUB / OPS）
# --------------------------------------------------------------------------- #

def _find_opf(bundle: Path) -> Path | None:
    container = bundle / "META-INF" / "container.xml"
    if container.is_file():
        try:
            for node in ET.parse(container).getroot().iter():
                if node.tag.endswith("rootfile"):
                    full = node.get("full-path")
                    if full and (bundle / full).is_file():
                        return bundle / full
        except ET.ParseError:
            pass
    cands = sorted(bundle.rglob("*.opf"))
    return cands[0] if cands else None


def _localname(tag: str) -> str:
    return tag.rsplit("}", 1)[-1].lower()


def read_opf(opf: Path) -> dict:
    try:
        root = ET.parse(opf).getroot()
    except ET.ParseError:
        return {"spine": [], "manifest": {}, "title": "", "author": ""}
    manifest: dict[str, str] = {}
    for el in root.iter():
        if _localname(el.tag) == "item":
            iid, href = el.get("id"), el.get("href")
            if iid and href:
                manifest[iid] = href
    spine: list[str] = []
    for el in root.iter():
        if _localname(el.tag) == "itemref":
            idref = el.get("idref")
            if idref and idref in manifest:
                spine.append(manifest[idref])
    title = author = ""
    for el in root.iter():
        if _localname(el.tag) == "title" and not title:
            title = (el.text or "").strip()
        elif _localname(el.tag) == "creator" and not author:
            author = (el.text or "").strip()
    return {"spine": spine, "manifest": manifest, "title": title, "author": author}


_TAG_RE = re.compile(r"<(script|style)\b.*?</\1>", re.S | re.I)
_BLOCK_RE = re.compile(r"</?(p|div|br|h[1-6]|li|tr|section|article)\b[^>]*>", re.I)
_ANY_TAG_RE = re.compile(r"<[^>]+>")
_H_RE = re.compile(r"<h[1-3][^>]*>(.*?)</h[1-3]>", re.S | re.I)
_TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.S | re.I)


def html_to_text(raw: str) -> str:
    """XHTML -> 纯文本。保留原文标点（不做 NFKC），匹配时用 fold() 另行折叠。"""
    raw = _TAG_RE.sub(" ", raw)
    raw = _BLOCK_RE.sub("\n", raw)
    raw = _ANY_TAG_RE.sub("", raw)
    raw = unescape(raw).replace("\u00a0", " ").replace("\u3000", " ")
    lines = [re.sub(r"[ \t]+", " ", ln).strip() for ln in raw.splitlines()]
    return "\n".join(ln for ln in lines if ln)


def guess_chapter_title(raw: str, fallback: str) -> str:
    for rx in (_H_RE, _TITLE_RE):
        m = rx.search(raw)
        if m:
            t = html_to_text(m.group(1)).strip()
            if 0 < len(t) <= 60:
                return t
    return fallback


def _is_html(href: str) -> bool:
    return href.split("?")[0].split("#")[0].lower().endswith(_HTML_EXT)


def _read_docs(base: Path, hrefs, seen: set) -> list[tuple[str, str, str]]:
    """读入若干文档，返回 [(href, 原始 HTML, 纯文本)]；按真实路径去重、保持传入顺序。"""
    out: list[tuple[str, str, str]] = []
    for href in hrefs:
        doc = (base / href).resolve()
        if doc in seen or not doc.is_file():
            continue
        seen.add(doc)
        try:
            raw = doc.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        out.append((href, raw, html_to_text(raw)))
    return out


def _merge_docs(buf: list[tuple[str, str, str]], idx: int) -> dict:
    """把若干短文档并成一个章节（用第一个文档的标题）。

    **保留 segment map**（规范 `:94`）：每篇原始文档在合并正文里的区间 + 它的 href。
    没有它，合并后就没法回答「这一段出自哪个 xhtml」，`/source-span` 只能把整章
    的引用都算到第一篇文件上（那是编的）。
    """
    href, raw, _ = buf[0]
    if len(buf) > 1:
        parts: list[str] = []
        segments: list[dict] = []
        pos = 0
        for h, _raw, t in buf:
            segments.append({"href": h, "start_codepoint": pos, "end_codepoint": pos + len(t)})
            parts.append(t)
            pos += len(t) + 1             # 与 "\n".join 对齐
        text = "\n".join(parts)
    else:
        text = buf[0][2]
        segments = [{"href": href, "start_codepoint": 0, "end_codepoint": len(text)}]
    return {"order": idx, "href": href, "segments": segments,
            "title": guess_chapter_title(raw, f"第 {idx + 1} 节"), "text": text}


def recommendation_exclusion(ch: dict, bundle: Path) -> str | None:
    """Filter explicit paratext from recommendations without changing source identity/offsets."""
    text = ch.get("text", "")
    lead = text[:240]
    if len(text) < 1500 and re.search(r"版权信息|版权所有|Copyright ©|All rights reserved", lead, re.I):
        return "publication_metadata"
    if int(ch.get("order", 0)) < 5 and re.search(r"(?:^|\n)(?:各方赞誉|赞誉|献词|推荐语)(?:[\s：:]|$)", lead):
        return "front_matter"
    # EPUB2 often merges its short cover/title page with a plain-text TOC.
    if len(text) < 6000 and re.search(r"^目录$", text, re.M) and len(re.findall(r"^第[0-9一二三四五六七八九十百]+章", text, re.M)) >= 8:
        return "navigation_document"
    opf = _find_opf(bundle)
    if opf:
        segments = ch.get("segments") or [{"href": ch.get("href")}]
        navigation = []
        for segment in segments:
            href = segment.get("href")
            if not href:
                return None
            path = (opf.parent / href).resolve()
            if not path.is_relative_to(bundle.resolve()) or not path.is_file():
                return None
            raw = path.read_text(encoding="utf-8", errors="replace")
            links = re.findall(r'<a\b[^>]*href=["\'][^"\']+["\'][^>]*>(.*?)</a>', raw, re.I | re.S)
            link_chars = sum(len(html_to_text(x).strip()) for x in links)
            visible_chars = max(1, len(html_to_text(raw).strip()))
            semantic_nav = bool(re.search(r'<nav\b[^>]*(?:epub:type=["\']toc["\']|role=["\']doc-toc["\'])', raw, re.I))
            navigation.append(semantic_nav or (len(links) >= 8 and link_chars / visible_chars > 0.7))
        if navigation and all(navigation):
            return "navigation_document"
    return None


def extract_chapters(bundle: Path) -> dict:
    opf = _find_opf(bundle)
    if opf is None:
        raise RuntimeError("这本书里找不到 OPF 清单，可能不是标准 EPUB")
    meta = read_opf(opf)
    base = opf.parent
    seen: set = set()

    spine = meta["spine"] or [
        p.name for p in sorted(base.iterdir()) if p.suffix.lower() in _HTML_EXT
    ]
    docs = _read_docs(base, spine, seen)

    # 有些书的 spine 是坏的：只列一个占位文件，或列一堆空壳，真正的正文躺在
    # manifest 里没被 spine 引用。实测两本：一本 spine 只有 1 个文件（2174 字）
    # 而 manifest 有 307 个；另一本 spine 68 个文件合计只有 127 字。
    # 判据：spine 抽出来的正文少得不像一本书，就把 manifest 里其余的 HTML 补上。
    if sum(len(t) for _, _, t in docs) < SPINE_FALLBACK_CHARS:
        in_spine = set(spine)
        extra = [h for h in meta["manifest"].values() if _is_html(h) and h not in in_spine]
        if extra:
            docs += _read_docs(base, extra, seen)

    # 正文被切成很多小文件的 EPUB，不能因为单篇太短就把整本丢掉，
    # 所以短的先攒着，攒够 MIN_CHAPTER_CHARS 再落成一个章节。
    chapters: list[dict] = []
    buf: list[tuple[str, str, str]] = []
    buf_len = 0
    for item in docs:
        if not item[2].strip():
            continue
        buf.append(item)
        buf_len += len(item[2])
        if buf_len >= MIN_CHAPTER_CHARS:
            chapters.append(_merge_docs(buf, len(chapters)))
            buf, buf_len = [], 0
    if buf:
        chapters.append(_merge_docs(buf, len(chapters)))

    return {"title": meta["title"] or bundle.name[:-5], "author": meta["author"],
            "chapters": chapters}


def chunk_text(text: str) -> list[str]:
    paras = [p.strip() for p in text.split("\n") if p.strip()]
    chunks: list[str] = []
    buf = ""
    for p in paras:
        if buf and len(buf) + len(p) + 1 > CHUNK_SIZE:
            chunks.append(buf)
            tail = buf[-CHUNK_OVERLAP:] if CHUNK_OVERLAP else ""
            buf = (tail + "\n" + p).strip() if tail else p
        else:
            buf = f"{buf}\n{p}".strip() if buf else p
    if buf.strip():
        chunks.append(buf)
    return [c for c in chunks if c.strip()]


# --------------------------------------------------------------------------- #
# 向量索引
# --------------------------------------------------------------------------- #

_model = None
_model_last_use = 0.0


def get_model():
    global _model, _model_last_use
    if _model is None:
        from fastembed import TextEmbedding
        Path(MODEL_CACHE).mkdir(parents=True, exist_ok=True)
        if BOOK_PROVIDER == "standalone":
            model_path = Path(os.environ.get("AI_READING_EMBED_MODEL_PATH") or
                              (Path(sys.prefix) / "models/bge-small-zh-v1.5"))
            if not (model_path / "model_optimized.onnx").is_file():
                raise RuntimeError("SEMANTIC_MODEL_NOT_PREPARED: 请安装包含本地语义模型的客户端，或运行 scripts/prepare-semantic.py 准备模型")
            import onnxruntime
            onnxruntime.disable_telemetry_events()
            _model = TextEmbedding(MODEL, cache_dir=MODEL_CACHE, specific_model_path=str(model_path),
                                   local_files_only=True, threads=2)
        else:
            _model = TextEmbedding(MODEL, cache_dir=MODEL_CACHE)
    _model_last_use = time.monotonic()
    return _model


def embed_passages(texts: list[str]):
    import numpy as np
    vecs = np.array(list(get_model().embed(texts, batch_size=32)), dtype="float32")
    return vecs / np.clip(np.linalg.norm(vecs, axis=1, keepdims=True), 1e-9, None)


def embed_query(text: str):
    import numpy as np
    model = get_model()
    try:
        vec = np.array(list(model.query_embed([text]))[0], dtype="float32")
    except Exception:  # noqa: BLE001
        vec = np.array(list(model.embed([text]))[0], dtype="float32")
    return vec / max(float(np.linalg.norm(vec)), 1e-9)


def _paths(book: dict) -> tuple[Path, Path]:
    """向量索引文件路径。键用 `index_key`（= 旧的 `book_id(目录名)`），**不是**列表句柄 `id`。

    为什么不用 `id`：`id` 现在是 `listing_id(路径)`，改了名字/挪了位置就变，
    已有索引会全部变成孤儿。索引是缓存、键稳定比「跟身份一致」更重要（M13 决策）。
    兼容：调用方若传的是老 dict（只有 `id`），退回 `id`。
    """
    key = book.get("index_key") or book["id"]
    return INDEX_DIR / f"{key}.json", INDEX_DIR / f"{key}.npy"


def _log(msg: str = "") -> None:
    """带 flush 的 print。

    `index --all` 常常被重定向到文件或管道，此时 Python 默认块缓冲，
    进度会憋到结束才出现、看起来像卡死了，所以这里强制 flush。
    """
    print(msg, flush=True)


def build_index(book: dict, log=_log, force: bool = False) -> dict:
    import numpy as np
    jp, np_ = _paths(book)
    bundle = Path(book["path"])
    src_mtime = bundle.stat().st_mtime
    if not force and jp.is_file() and np_.is_file():
        try:
            old = json.loads(jp.read_text(encoding="utf-8"))
            if abs(old.get("source_mtime", 0) - src_mtime) < 1:
                log(f"  · 《{book['title']}》未变动，跳过")
                return old
        except (OSError, json.JSONDecodeError):
            pass
    log(f"  读取《{book['title']}》…")
    data = extract_chapters(bundle)

    # 扫描版（图片）图书没有文字层，硬建索引只会得到一堆噪音，不如直接说清楚。
    # 实测某本扫描版：305 张 jpg + 一个只含 <img> 的 html，正文仅 2174 字。
    text_len = sum(len(ch["text"]) for ch in data["chapters"])
    if text_len < MIN_BOOK_CHARS:
        imgs = sum(1 for p in bundle.rglob("*") if p.suffix.lower() in _IMAGE_EXT)
        if imgs > 10:
            raise RuntimeError(
                f"这是扫描版（图片）图书：{imgs} 张图片、正文只有 {text_len} 字，"
                "没有文字层，无法做文本检索")
        raise RuntimeError(
            f"正文只有 {text_len} 字，可能不是标准 EPUB、内容为空或带 DRM")

    chunks: list[dict] = []
    for ch in data["chapters"]:
        for piece in chunk_text(ch["text"]):
            chunks.append({"i": len(chunks), "chapter": ch["title"],
                           "href": ch["href"], "text": piece})
    if not chunks:
        raise RuntimeError("这本书没有可检索的正文（可能是 DRM 或空内容）")
    log(f"  {len(chunks)} 个片段，正在向量化…")
    vectors = embed_passages([c["text"] for c in chunks])
    INDEX_DIR.mkdir(parents=True, exist_ok=True)
    meta = {
        "id": book["id"], "name": book["name"], "title": data["title"] or book["title"],
        "author": data["author"] or book.get("author", ""), "model": MODEL,
        "dim": int(vectors.shape[1]), "source_mtime": src_mtime, "chunks": chunks,
    }
    jp.write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
    np.save(np_, vectors)
    log(f"  ✓ 完成：{len(chunks)} 段 / {vectors.shape[1]} 维")
    return meta


def load_index(book: dict):
    import numpy as np
    jp, np_ = _paths(book)
    if not (jp.is_file() and np_.is_file()):
        return None
    return json.loads(jp.read_text(encoding="utf-8")), np.load(np_)


_jieba = None


def tokenize(text: str) -> list[str]:
    global _jieba
    if _jieba is None:
        try:
            import jieba
            _jieba = jieba
        except ImportError:
            _jieba = False
    raw = _jieba.lcut(text) if _jieba else [text[i:i + 2] for i in range(max(len(text) - 1, 1))]
    return [t.strip().lower() for t in raw if t.strip() and re.search(r"[一-鿿\w]", t)]


_doc_tokens: dict[str, list[list[str]]] = {}


def _docs_tokens(chunks: list[dict], cache_key: str | None) -> list[list[str]]:
    """分词结果按书缓存。

    原来每查一次就把整本书重新分词一遍 —— 一本 1543 段的书要 740ms，
    比向量检索本身（2ms）贵两个数量级。只留最近两本，避免常驻进程吃内存。
    """
    if cache_key is None:
        return [tokenize(c["text"]) for c in chunks]
    hit = _doc_tokens.get(cache_key)
    if hit is None:
        hit = [tokenize(c["text"]) for c in chunks]
        _doc_tokens[cache_key] = hit
        while len(_doc_tokens) > 2:
            _doc_tokens.pop(next(iter(_doc_tokens)))
    return hit


def lexical_scores(query: str, chunks: list[dict], cache_key: str | None = None) -> list[float]:
    import math
    qterms = set(tokenize(query))
    if not qterms:
        return [0.0] * len(chunks)
    docs = _docs_tokens(chunks, cache_key)
    df: dict[str, int] = {}
    for d in docs:
        for t in set(d):
            df[t] = df.get(t, 0) + 1
    n = len(docs) or 1
    idf = {t: math.log(1 + (n - df.get(t, 0) + 0.5) / (df.get(t, 0) + 0.5)) for t in qterms}
    out = []
    for d in docs:
        counts: dict[str, int] = {}
        for t in d:
            counts[t] = counts.get(t, 0) + 1
        out.append(sum(idf[t] * min(counts.get(t, 0), 3) for t in qterms))
    return out


def _sigmoid(x: float) -> float:
    """cross-encoder 输出的是 logit（可为负），转成 0~1 好显示。"""
    import math
    try:
        return 1.0 / (1.0 + math.exp(-x))
    except OverflowError:
        return 0.0


def _fastembed_cache() -> Path:
    env = os.environ.get("FASTEMBED_CACHE_PATH")
    return Path(env) if env else Path.home() / ".cache" / "fastembed"


def rerank_available() -> bool:
    """reranker 模型是否已在本地缓存。

    **刻意不触发下载**：这个模型 1GB，在用户随手搜一下的时候静默拉取是不可接受的。
    没缓存就退回混合排序，想启用跑 `rerank-setup`。
    """
    return (_fastembed_cache() / ("models--" + RERANK_MODEL.replace("/", "--"))).is_dir()


_reranker = None
_reranker_failed = False
_reranker_last_use = 0.0


def get_reranker():
    """懒加载 reranker；加载失败只记一次，不反复重试。"""
    global _reranker, _reranker_failed, _reranker_last_use
    if _reranker is None and not _reranker_failed:
        try:
            from fastembed.rerank.cross_encoder import TextCrossEncoder
            _reranker = TextCrossEncoder(model_name=RERANK_MODEL)
        except Exception as e:  # noqa: BLE001
            _reranker_failed = True
            _log(f"  ⚠️ reranker 加载失败，退回混合排序：{e}")
    _reranker_last_use = time.monotonic()
    return _reranker


# --------------------------------------------------------------------------- #
# 模型空闲回收
# --------------------------------------------------------------------------- #
# 精排模型（cross-encoder）一个就占 ~1.1GB，而它只在开了「精排」时才用到。
# 之前它是模块级全局、永不释放——每个常驻的 serve-http / MCP 进程用一次
# 就长期占着 1GB，几个进程叠加就能把内存吃光。
#
# 这里加空闲回收：超过 TTL 没被用过就把模型丢掉、内存还给系统。
# 安全性靠 Python 的引用计数：正在推理的调用持有自己的引用，把全局置空
# 只会让「下一个」请求重新加载，不会打断在飞的调用。
#
# TTL 设 0 表示永不回收（想常驻换速度就用它）。

_evictor_started = False


def _env_ttl(name: str, default: int) -> int:
    try:
        return max(0, int(os.environ.get(name, default)))
    except (TypeError, ValueError):
        return default


EMBED_TTL = _env_ttl("APPLE_READ_EMBED_TTL", 900)     # 嵌入模型小（~94MB），可以留久点
RERANK_TTL = _env_ttl("APPLE_READ_RERANK_TTL", 180)   # 精排模型大（~1.1GB），尽早回收
_EVICT_INTERVAL = 30


def _release_heap() -> None:
    """尽力把空闲堆还给系统。

    `gc.collect()` 只让 Python 对象可回收，glibc / macOS 的分配器仍可能攥着已经 free
    掉的大块内存不还给 OS（表现为 RSS 不降）。这里调一把分配器的「压力释放」。
    纯尽力而为：失败、或平台没有这个符号，都直接跳过。
    """
    try:
        import ctypes
        import ctypes.util
        libc = ctypes.CDLL(ctypes.util.find_library("c") or None)
        relief = getattr(libc, "malloc_zone_pressure_relief", None)   # macOS
        if relief is not None:
            relief(None, 0)
            return
        trim = getattr(libc, "malloc_trim", None)                     # glibc
        if trim is not None:
            trim(0)
    except Exception:  # noqa: BLE001
        pass


def evict_idle_models(now: float | None = None) -> list[str]:
    """把空闲超时的模型丢掉，返回被回收的名字。"""
    global _model, _reranker
    import gc
    now = time.monotonic() if now is None else now
    freed = []
    if _reranker is not None and RERANK_TTL and now - _reranker_last_use > RERANK_TTL:
        _reranker = None
        freed.append("reranker")
    if _model is not None and EMBED_TTL and now - _model_last_use > EMBED_TTL:
        _model = None
        freed.append("embedding")
    if freed:
        gc.collect()
        _release_heap()
    return freed


def start_model_evictor() -> None:
    """后台线程：定期回收空闲模型。已经在跑就什么都不做。"""
    global _evictor_started
    if _evictor_started:
        return
    _evictor_started = True
    import threading

    def loop():
        while True:
            time.sleep(_EVICT_INTERVAL)
            try:
                freed = evict_idle_models()
                if freed:
                    _log(f"  ♻️ 回收空闲模型：{', '.join(freed)}")
            except Exception:  # noqa: BLE001
                pass  # 回收失败绝不能影响服务

    threading.Thread(target=loop, name="model-evictor", daemon=True).start()


def search(book: dict, query: str, k: int = 5, auto_index: bool = True,
           rerank: bool | None = None) -> dict:
    import numpy as np
    loaded = load_index(book)
    if loaded is None:
        if not auto_index:
            raise RuntimeError(f"《{book['title']}》还没有索引，先执行 index")
        build_index(book, log=lambda m: print(m, file=sys.stderr))
        loaded = load_index(book)
    meta, vectors = loaded
    chunks = meta["chunks"]
    qvec = embed_query(query)
    cos = vectors @ qvec
    # 用「书 id + 索引文件 mtime」当缓存键：索引重建后自动失效
    jp, _ = _paths(book)
    try:
        ck = f"{book['id']}:{jp.stat().st_mtime_ns}"
    except OSError:
        ck = None
    lex = np.array(lexical_scores(query, chunks, cache_key=ck), dtype="float32")
    if lex.max() > 0:
        lex = lex / lex.max()
    scores = (1 - LEXICAL_WEIGHT) * cos + LEXICAL_WEIGHT * lex

    # 粗排多取一些候选（向量+字面只能到这儿了），精排交给 cross-encoder：
    # 它同时看 query 和正文，能分辨「字面像」和「真的在回答这个问题」。
    # RERANK_POOL 是主控旋钮，k 只是下限（要 20 条就不能只精排 5 条）。
    pool_n = min(max(RERANK_POOL, k), len(chunks))
    order = np.argsort(-scores)[:pool_n]
    cands = [{
        "score": round(float(scores[i]), 4), "cosine": round(float(cos[i]), 4),
        "chapter": chunks[i]["chapter"], "text": chunks[i]["text"],
    } for i in order]

    used = False
    if rerank is None:
        rerank = rerank_available()
    if rerank and len(cands) > 1:
        model = get_reranker()
        if model is not None:
            try:
                raw = [float(x) for x in model.rerank(query, [c["text"] for c in cands])]
                for c, s in zip(cands, raw):
                    c["hybrid_score"] = c["score"]
                    c["rerank_score"] = round(s, 4)
                    c["score"] = round(_sigmoid(s), 4)
                conf = max(c["score"] for c in cands)
                if conf >= RERANK_MIN_CONF:
                    cands.sort(key=lambda c: c["rerank_score"], reverse=True)
                    used = True
                else:
                    # 精排没找到「真的相关」的段落，排序不可信 → 保持混合排序，
                    # 但把精排分数留着，方便排查
                    cands.sort(key=lambda c: c["hybrid_score"], reverse=True)
                    for c in cands:
                        c["score"] = c["hybrid_score"]
            except Exception as e:  # noqa: BLE001
                _log(f"  ⚠️ rerank 失败，退回混合排序：{e}")

    hits = cands[:k]
    for r, h in enumerate(hits):
        h["rank"] = r + 1
        h["reranked"] = used
    return {
        "title": meta["title"], "author": meta.get("author", ""), "query": query,
        "reranked": used, "hits": hits,
    }


# --------------------------------------------------------------------------- #
# 高亮 / 笔记（AEAnnotation，需要完全磁盘访问权限）
# --------------------------------------------------------------------------- #

def annotations_available() -> bool:
    if BOOK_PROVIDER == "standalone":
        return False
    return bool(glob.glob(str(ANNOTATION_DB / "AEAnnotation*.sqlite")))


def attach_annotation_context(anns: list[dict], before: int = 300, after: int = 300) -> None:
    """给一批标注就地补上「所在章节 + 前后原文」。

    按书分组，每本书只解析一次 EPUB —— extract_chapters 是这里的开销大头，
    逐条调 annotation_context() 会把同一本书解析 N 遍。
    """
    by_asset: dict[str, list[dict]] = {}
    for a in anns:
        by_asset.setdefault(a["asset_id"], []).append(a)
    lib = load_library()
    for aid, group in by_asset.items():
        rec = lib.get(aid)
        book = resolve_book(Path(rec["path"]).name) if rec and rec.get("path") else None
        chapters = []
        if book:
            try:
                chapters = extract_chapters(Path(book["path"]))["chapters"]
            except Exception:  # noqa: BLE001
                chapters = []
        for a in group:
            a.setdefault("chapter", None)
            a.setdefault("context", "")
            a.setdefault("exact", False)
            if book:
                a["book"] = book["title"]
            needle = a["text"] or a["note"]
            if not needle or not chapters:
                continue
            for ch in chapters:
                span = locate(ch["text"], needle)
                if span:
                    s, e = span
                    a["chapter"] = ch["title"]
                    a["exact"] = True
                    a["context"] = ch["text"][max(0, s - before):min(len(ch["text"]), e + after)]
                    break


def load_annotations(book: dict | None = None, limit: int | None = None,
                     include_empty: bool = False, with_context: bool = False) -> list[dict]:
    """读取高亮/笔记。book 为 None 时返回全库。

    with_context=True 时，每条会多带 chapter / context / exact 三个字段
    （标注所在的章节名、前后原文、是否精确定位到）—— 让模型能围绕「你划的这句」聊。
    """
    if BOOK_PROVIDER == "standalone":
        return []
    dbs = sorted(glob.glob(str(ANNOTATION_DB / "AEAnnotation*.sqlite")))
    if not dbs:
        return []
    lib = load_library()
    try:
        con = _ro(Path(dbs[0]))
        rows = con.execute("""select Z_PK, ZANNOTATIONASSETID, ZANNOTATIONTYPE, ZANNOTATIONSTYLE,
                                     ZANNOTATIONISUNDERLINE, ZANNOTATIONSELECTEDTEXT,
                                     ZANNOTATIONREPRESENTATIVETEXT, ZANNOTATIONNOTE,
                                     ZANNOTATIONLOCATION, ZANNOTATIONCREATIONDATE,
                                     ZANNOTATIONMODIFICATIONDATE, ZANNOTATIONUUID
                              from ZAEANNOTATION where ZANNOTATIONDELETED = 0""").fetchall()
        con.close()
    except sqlite3.Error:
        return []

    want_asset = book.get("asset_id") if book else None
    want_title = book.get("title") if book else None
    out: list[dict] = []
    for (pk, aid, atype, style, underline, sel, rep, note, cfi, created, modified, uuid) in rows:
        text = (sel or rep or "").strip()
        note = (note or "").strip()
        if not include_empty and not text and not note:
            continue
        rec = lib.get(aid) or {}
        title = rec.get("title") or f"<{aid}>"
        if want_asset and aid != want_asset:
            continue
        if want_asset is None and want_title and title != want_title:
            continue
        out.append({
            "id": pk, "uuid": uuid, "asset_id": aid, "book": title,
            "type": ANNOTATION_TYPES.get(atype, str(atype)),
            "color": "下划线" if underline else HIGHLIGHT_STYLES.get(style, str(style)),
            "text": text, "note": note, "cfi": cfi or "",
            "created": cd_time(created), "modified": cd_time(modified),
        })
    out.sort(key=lambda a: a["modified"] or "", reverse=True)
    if limit:
        out = out[:limit]
    if with_context:
        attach_annotation_context(out)
    return out


def annotation_context(annotation_id: int, before: int = 400, after: int = 400) -> dict:
    """还原某条标注在全书里的位置 + 前后原文。"""
    ann = next((a for a in load_annotations(include_empty=True) if a["id"] == annotation_id), None)
    if ann is None:
        return {"error": f"找不到 id={annotation_id} 的标注"}
    rec = load_library().get(ann["asset_id"])
    if not rec or not rec.get("path"):
        return {"error": "这条标注对应的书不在本地（可能未下载或已删除）", "annotation": ann}
    book = resolve_book(Path(rec["path"]).name)
    if not book:
        return {"error": "找不到对应书籍目录", "annotation": ann}
    data = extract_chapters(Path(book["path"]))
    needle = ann["text"] or ann["note"]
    if needle:
        for ch in data["chapters"]:
            span = locate(ch["text"], needle)
            if span:
                s, e = span
                ctx = ch["text"][max(0, s - before):min(len(ch["text"]), e + after)]
                return {"annotation": ann, "book": book["title"], "chapter": ch["title"],
                        "offset": s, "context": ctx, "exact": True}
    m = re.search(r"\[([^\]]+\.x?html)\]", ann["cfi"] or "")
    if m:
        base = m.group(1).split("/")[-1]
        for ch in data["chapters"]:
            if ch["href"].split("/")[-1] == base:
                return {"annotation": ann, "book": book["title"], "chapter": ch["title"],
                        "offset": None, "context": ch["text"][:before + after], "exact": False,
                        "note_hint": "高亮文字与正文标点不一致，已按 CFI 定位到章节开头"}
    return {"annotation": ann, "book": book["title"], "chapter": None, "offset": None,
            "context": "", "exact": False, "note_hint": "无法在正文中定位这段高亮"}


# --------------------------------------------------------------------------- #
# 打开「图书」App
# --------------------------------------------------------------------------- #

def open_in_books(book: dict | None) -> str:
    if BOOK_PROVIDER == "standalone":
        return "独立客户端书源：请在客户端原文视图打开"
    import subprocess
    if book:
        r = subprocess.run(["open", "-a", "Books", book["path"]], capture_output=True, text=True)
        if r.returncode == 0:
            return f"已在「图书」App 中打开《{book['title']}》"
        subprocess.run(["open", "-a", "Books"], capture_output=True)
        return f"未能直接定位《{book['title']}》，已切到「图书」App"
    subprocess.run(["open", "-a", "Books"], capture_output=True)
    return "已切到「图书」App"


# --------------------------------------------------------------------------- #
# 逐章分析（M8 / 执行计划 §1 表 #9）
# --------------------------------------------------------------------------- #
# 目的：把「已解析正文」逐章切成**连续窗口**并逐窗产出「概括 + 代表切片」，
#       供 policy.rank 当候选；同时给出**可核验的窗口消费证据**与**排队中的失败窗口**。
#
# 四条不许含糊的纪律（对应 PRD :247 / :346 与用户点名的反例）：
#   1. **窗口必须连续**：首尾相接、无洞、无叠，并集恰为 [0, len(chapter_text))。
#      规划完立刻自校验（`verify_windows`），校验不过就**一个窗口都不消费**。
#   2. **消费必须有证据**：consumer 必须回执 `window_id` + `text_hash`，且给出非空概括；
#      引擎逐项核验，任一不符 ⇒ `consumed=False`，**不记成已处理**。
#   3. **失败窗口留在队列**：`queue.pending_window_ids` / `failed_window_ids` 如实列出，
#      绝不静默丢弃；`analyzed_units` 只数**真消费**的窗口。
#   4. **分母与未知必显**：分母 = 已解析正文的窗口数；图片页/不可解析项数量**不可知**，
#      因此 `whole_book_claim_allowed=False`、`whole_book_percent=None`。
#      「已读懂」恒不可宣称（`honesty.book_understood.allowed` 恒 False）。

ANALYSIS_VERSION = "1.0.0"
ANALYZE_WINDOW_CHARS = int(os.environ.get("APPLE_READ_WINDOW_CHARS", "3000"))
ANALYZE_SLICE_CHARS = int(os.environ.get("APPLE_READ_SLICE_CHARS", "400"))
ANALYZE_MAX_SLICES = int(os.environ.get("APPLE_READ_MAX_SLICES", "4"))
ANALYZE_SUMMARY_SENTENCES = int(os.environ.get("APPLE_READ_SUMMARY_SENTENCES", "3"))

#: 句子结束符（中文为主，兼容英文与换行）。切窗口与挑代表句都用它。
_SENT_END = re.compile(r"[。！？!?；;…]+[\"'”’）)\]]*|\n+")


def _sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def split_sentences(text: str) -> list[tuple[int, int]]:
    """句子区间（左闭右开，codepoint）。纯空白片段不算句子。"""
    out: list[tuple[int, int]] = []
    start = 0
    for m in _SENT_END.finditer(text):
        end = m.end()
        if end > start:
            out.append((start, end))
            start = end
    if start < len(text):
        out.append((start, len(text)))
    return [(s, e) for (s, e) in out if text[s:e].strip()]


def _boundary_near(text: str, lo: int, hi: int) -> int:
    """在 (lo, hi] 内找**最靠后**的句子边界当切点；没有就返回 hi。

    只挑切点、不丢字：窗口边界落在正文里的某个下标上，[lo, cut) 的内容全部保留。
    """
    best = None
    for m in _SENT_END.finditer(text, lo, hi):
        if lo < m.end() <= hi:
            best = m.end()
    return best if best is not None else hi


def plan_chapter_windows(text: str, window_chars: int = ANALYZE_WINDOW_CHARS) -> list[dict]:
    """把一章正文切成**首尾相接**的窗口。

    返回的每个窗口只有元数据（区间 + hash），正文由消费方按区间自取 ——
    这样「计划」与「正文」不会各存一份、也不会不一致。
    """
    n = len(text)
    if n == 0:
        return []
    size = max(int(window_chars), 1)
    bounds = [0]
    pos = 0
    while pos < n:
        nxt = min(pos + size, n)
        if nxt < n:
            nxt = _boundary_near(text, pos, nxt)
            if nxt <= pos:            # 兜底：句子边界找不出来也必须前进
                nxt = min(pos + size, n)
        bounds.append(nxt)
        pos = nxt
    windows: list[dict] = []
    for i in range(len(bounds) - 1):
        s, e = bounds[i], bounds[i + 1]
        seg = text[s:e]
        windows.append({
            "window_id": f"w{i:04d}",
            "index": i,
            "start_codepoint": s,
            "end_codepoint": e,
            "chars": e - s,
            "text_hash": _sha256_text(seg),
        })
    return windows


def verify_windows(text: str, windows: list[dict]) -> dict:
    """核验窗口规划：连续、无叠、并集恰为全文、每窗 hash 与正文相符。"""
    problems: list[str] = []
    if not windows:
        if text:
            problems.append("非空正文却没有任何窗口")
        return {"ok": not problems, "problems": problems, "covered_chars": 0}
    if windows[0]["start_codepoint"] != 0:
        problems.append("首个窗口不从 0 开始")
    for a, b in zip(windows, windows[1:]):
        if a["end_codepoint"] != b["start_codepoint"]:
            problems.append(f"窗口 {a['index']}→{b['index']} 之间有洞或重叠")
        if b["start_codepoint"] >= b["end_codepoint"]:
            problems.append(f"窗口 {b['index']} 为空窗口")
    if windows[-1]["end_codepoint"] != len(text):
        problems.append("末个窗口没有覆盖到正文末尾")
    for w in windows:
        seg = text[w["start_codepoint"]:w["end_codepoint"]]
        if _sha256_text(seg) != w["text_hash"]:
            problems.append(f"窗口 {w['window_id']} 的 text_hash 与正文不符")
    return {
        "ok": not problems,
        "problems": problems,
        "covered_chars": sum(w["chars"] for w in windows),
    }


def _representative_sentence_indexes(text: str, max_n: int) -> list[int]:
    """按词频-逆句频挑代表句（确定性；并列按出现顺序）。返回**原序**下标。"""
    sents = split_sentences(text)
    if not sents:
        return []
    if len(sents) <= max_n:
        return list(range(len(sents)))
    toks = [tokenize(text[s:e]) for s, e in sents]
    df: dict[str, int] = {}
    for ts in toks:
        for t in set(ts):
            df[t] = df.get(t, 0) + 1
    import math
    total = len(sents)
    scored: list[tuple[float, int]] = []
    for i, ts in enumerate(toks):
        if not ts:
            continue
        score = sum(math.log(1.0 + total / df[t]) for t in ts) / (len(ts) ** 0.5)
        scored.append((score, i))
    scored.sort(key=lambda x: (-x[0], x[1]))
    return sorted(i for _, i in scored[:max_n])


def extractive_summary(text: str, max_sentences: int = ANALYZE_SUMMARY_SENTENCES) -> str:
    """抽取式概括：挑代表句、按原文顺序拼接。**不用检索相似度**（PRD :267）。"""
    sents = split_sentences(text)
    if not sents:
        return ""
    picked = _representative_sentence_indexes(text, max_sentences)
    return "".join(text[sents[i][0]:sents[i][1]].strip() for i in picked)


def pick_slices(text: str, window: dict, section_id: str, span_prefix: str,
                max_n: int = ANALYZE_MAX_SLICES,
                max_chars: int = ANALYZE_SLICE_CHARS) -> list[dict]:
    """从窗口里挑代表切片（= 概括所用的那些句子），每片带精确区间与 hash。

    **切片就是概括的来源**：`extractive_summary` 用同一套代表句挑选，
    所以「概括有来源」不是一句话，而是可核对的区间对应关系。
    """
    seg = text[window["start_codepoint"]:window["end_codepoint"]]
    sents = split_sentences(seg)
    picked = _representative_sentence_indexes(seg, max_n)
    out: list[dict] = []
    for i in picked:
        s, e = sents[i]
        if e - s > max_chars:
            e = s + max_chars
        quote = seg[s:e]
        if not quote.strip():
            continue
        abs_s = window["start_codepoint"] + s
        abs_e = window["start_codepoint"] + e
        out.append({
            "slice_id": f"{span_prefix}_{abs_s}_{abs_e}",
            "section_id": section_id,
            "window_id": window["window_id"],
            "start_codepoint": abs_s,
            "end_codepoint": abs_e,
            "text": quote,
            "text_hash": _sha256_text(quote),
            "quote_type": "sentence",
            "truncated": (sents[i][1] - sents[i][0]) > (e - s),
        })
    return out


def extractive_consumer(window: dict, text: str) -> dict:
    """默认消费方：抽取式概括。回执必须带 window_id + text_hash（消费证据）。"""
    return {
        "window_id": window["window_id"],
        "text_hash": window["text_hash"],
        "summary": extractive_summary(text),
        "consumer": "extractive",
    }


def consume_window(consumer, window: dict, text: str) -> dict:
    """让 `consumer` 消费一个窗口，并**逐项核验回执**。

    核验不过一律 `consumed=False` —— 这就是「模型没真消费的窗口不得记成已消费」的落点。
    """
    seg = text[window["start_codepoint"]:window["end_codepoint"]]
    real_hash = _sha256_text(seg)
    if real_hash != window["text_hash"]:
        return {"consumed": False, "failure_reason": "WINDOW_TEXT_HASH_MISMATCH",
                "detail": {"expected": window["text_hash"], "actual": real_hash}}
    try:
        receipt = consumer(window, seg)
    except Exception as e:  # noqa: BLE001 —— 消费方抛错就是**该窗口失败**，不是整个任务失败
        return {"consumed": False, "failure_reason": "CONSUMER_ERROR", "detail": {"error": str(e)}}
    if not isinstance(receipt, dict):
        return {"consumed": False, "failure_reason": "CONSUMER_BAD_RECEIPT",
                "detail": {"type": type(receipt).__name__}}
    if receipt.get("window_id") != window["window_id"]:
        return {"consumed": False, "failure_reason": "RECEIPT_WINDOW_ID_MISMATCH",
                "detail": {"expected": window["window_id"], "actual": receipt.get("window_id")}}
    if receipt.get("text_hash") != real_hash:
        return {"consumed": False, "failure_reason": "RECEIPT_HASH_MISMATCH",
                "detail": {"expected": real_hash, "actual": receipt.get("text_hash")}}
    summary = receipt.get("summary")
    if not isinstance(summary, str) or not summary.strip():
        return {"consumed": False, "failure_reason": "EMPTY_SUMMARY",
                "detail": {"note": "回执没给出非空概括 ⇒ 不算真消费"}}
    summary = summary.strip()
    return {
        "consumed": True,
        "summary": summary,
        "summary_hash": _sha256_text(summary),
        "consumer": str(receipt.get("consumer") or "unknown"),
        "evidence": {
            "window_id_echo": receipt.get("window_id"),
            "text_hash_echo": receipt.get("text_hash"),
            "window_chars": len(seg),
            "summary_chars": len(summary),
            "verified": True,
        },
    }


def book_version_id(chapters: list[dict]) -> str:
    """内容寻址的书版本 id（同内容同 id，与文件路径无关；PRD :462 content_hash 语义）。"""
    h = hashlib.sha256()
    for ch in chapters:
        h.update(ch["text"].encode("utf-8"))
        h.update(b"\x00")
    return "bv_" + h.hexdigest()[:16]


def content_digest(book_version: str) -> str:
    """`bv_<16hex>` ⇒ `<16hex>`：书的**内容身份摘要**（M13 起所有派生 id 都从它来）。

    为什么去掉前缀：`section_id` / `span_id` / `candidate_id` / `cov_id` / `dedup_ref`
    里嵌的是这 16 位；带上 `bv_` 会多出下划线、也更容易和别的字段混淆。
    与路径无关 —— 这是 M13 换地基的落点。
    """
    s = str(book_version or "").strip()
    return s[3:] if s.startswith("bv_") else s


def is_content_digest(x: str) -> bool:
    return bool(re.fullmatch(r"[0-9a-f]{16}", str(x or "")))


# --------------------------------------------------------------------------- #
# 块（block）：原始 XHTML 块级元素在归一化章节文本里的区间
# --------------------------------------------------------------------------- #
def chapter_blocks(text: str) -> list[dict]:
    """归一化章节文本 → 块列表（**块 = 一行 = 原始 XHTML 的一个块级元素**）。

    为什么这样定义：`html_to_text` 把 `</p>` / `</div>` / `<br>` / `<li>` 等块级标签
    一律换成 `\\n`，再把空行去掉 ⇒ 「非空行」就是从纯文本能**忠实重建**的原始块边界。
    这里**不假装知道 HTML 树**（引擎没有那份信息），只给能自证的东西。

    返回 `{index, start_codepoint, end_codepoint}`，区间左闭右开、单位是 Unicode codepoint，
    与 `SpanRef.start_codepoint/end_codepoint` 同一套坐标（同一段归一化文本）。
    """
    out: list[dict] = []
    pos = 0
    for line in str(text or "").split("\n"):
        start, end = pos, pos + len(line)
        if line.strip():
            out.append({"index": len(out), "start_codepoint": start, "end_codepoint": end})
        pos = end + 1                     # 跳过那个 "\n"
    return out


def block_id_of(digest: str, order: int, block_index: int) -> str:
    """块的**内容寻址** id：`blk_<内容摘要16位>_<章序>_<块序>`。

    与 `section_id`（`sec_<摘要>_<章序>`）、`span_id`（`sp_<摘要>_<章序>_<起>_<止>`）
    同一套地基：只用**内容身份 + 结构位置**，**不含路径** ⇒ 书挪位置/改名，block_id 不变。
    内容是它唯一的来源，任何一处都能就地复算（无需常驻状态）。
    """
    return f"blk_{digest}_{int(order)}_{int(block_index)}"


def block_at(text: str, codepoint: int) -> dict | None:
    """取包含 `codepoint` 的那个块。

    落在块与块之间的那个 `\\n` 上时（句子切片的右端常常正好含换行），
    取**前一个**块 —— 「这段从哪个块开始」才是块锚点的语义，不假装它整个落在块内。
    """
    blocks = chapter_blocks(text)
    if not blocks:
        return None
    pos = int(codepoint)
    for b in blocks:
        if b["start_codepoint"] <= pos < b["end_codepoint"]:
            return b
    prev = None
    for b in blocks:
        if b["start_codepoint"] <= pos:
            prev = b
        else:
            break
    return prev if prev is not None else blocks[0]


def href_at(chapter: dict, codepoint: int) -> str | None:
    """取 `codepoint` 所在的**原始文档** href（合并短文件时每篇的 segment map）。

    规范 `:94`：「合并短文件保留每个原始 href/block 的 segment map。跨 href 分开 refs，
    不都继承首文件。」这里就是那份 map 的用法 —— 不再一律返回章节第一篇的 href。
    """
    segs = chapter.get("segments")
    if not segs:
        return chapter.get("href")
    pos = int(codepoint)
    for s in segs:
        if s["start_codepoint"] <= pos < s["end_codepoint"]:
            return s.get("href")
    # 落在 segment 之间的分隔符上 ⇒ 取前一段（与 block_at 同一约定）
    prev = None
    for s in segs:
        if s["start_codepoint"] <= pos:
            prev = s
        else:
            break
    return (prev or segs[0]).get("href")


_chapter_cache: dict[str, tuple] = {}

# 内容身份 ⇒ 书目录。**缓存，不是权威**：命中后仍要用内容复核一次（见 find_book_by_content_id）。
_IDENTITY_CACHE: dict[str, str] = {}
_IDENTITY_LOADED = False


def _identity_map_file() -> Path:
    return INDEX_DIR / "identity.json"


def _identity_load() -> None:
    """把 `INDEX_DIR/identity.json` 读进内存（只读一次）。读不到/坏掉都当空，不报错。"""
    global _IDENTITY_LOADED
    if _IDENTITY_LOADED:
        return
    _IDENTITY_LOADED = True
    try:
        raw = json.loads(_identity_map_file().read_text("utf-8"))
    except Exception:  # noqa: BLE001 —— 缓存读不出来就当没有（宁慢不错）
        return
    entries = raw.get("entries") if isinstance(raw, dict) and isinstance(raw.get("entries"), dict) else raw
    if not isinstance(entries, dict):
        return
    for k, v in entries.items():
        if is_content_digest(k) and isinstance(v, str) and v:
            _IDENTITY_CACHE[k] = v


def _identity_save() -> None:
    """尽力写回映射；写不进去也不影响正确性（只是下次要重新扫描）。"""
    try:
        INDEX_DIR.mkdir(parents=True, exist_ok=True)
        payload = {"kind": "book_identity_map",
                   "note": "内容身份 ⇒ 书目录。只是缓存；每次命中仍会用内容复核，不作权威。",
                   "entries": dict(_IDENTITY_CACHE)}
        tmp = _identity_map_file().with_suffix(".json.tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), "utf-8")
        tmp.replace(_identity_map_file())
    except OSError:
        pass


def remember_book_identity(bundle: Path, digest: str) -> None:
    """把「这份内容 = 这个目录」记下来（分析 / 查身份时都会调）。"""
    if not is_content_digest(digest):
        return
    _identity_load()
    _IDENTITY_CACHE[digest] = str(bundle)
    _identity_save()


def _bundle_fingerprint(bundle: Path) -> tuple:
    """书目录的内容指纹：**每个文件**的 (相对路径, mtime_ns, size)。

    不能只用目录自身的 mtime —— 原地改掉里面某个 HTML 时目录 mtime 不变，
    缓存会继续吐出旧正文，`read_source_span` 就会返回**过期的 hash**，
    于是 policy 的 `source_hash_mismatch` 永远抓不到「原文已经变了」。
    """
    rows = []
    try:
        for p in sorted(bundle.rglob("*")):
            if p.is_file():
                st = p.stat()
                rows.append((str(p.relative_to(bundle)), st.st_mtime_ns, st.st_size))
    except OSError as e:  # noqa: BLE001 —— 指纹算不出来就别用缓存（宁慢不错）
        return (f"<unstatable:{e}>",)
    return tuple(rows)


def cached_extract_chapters(bundle: Path) -> dict:
    """按**内容指纹**缓存章节抽取：`/source-span` 会被逐条 span 调用，不能每次重解包。"""
    key = _bundle_fingerprint(bundle)
    hit = _chapter_cache.get(str(bundle))
    if hit and hit[0] == key:
        return hit[1]
    data = extract_chapters(bundle)
    _chapter_cache[str(bundle)] = (key, data)
    if len(_chapter_cache) > 4:
        _chapter_cache.pop(next(iter(_chapter_cache)))
    return data


def find_book_by_content_id(digest: str) -> dict | None:
    """按**内容身份**找书（M13 起 `span_id` 里嵌的就是它）。

    为什么不能像以前那样「按路径指纹反查」：书一挪位置/改名，路径指纹就变了，
    而内容身份不变 —— 这正是 M13 要的性质。

    两步，**映射只当线索、内容才是权威**：
      1. 映射（内存 + `INDEX_DIR/identity.json`）给出候选目录 ⇒ **重新解包复核**内容摘要；
         复核不过（书被换掉了/目录没了）⇒ 丢掉这条线索，走第 2 步；
      2. 逐本按内容算（解包有内容指纹缓存）—— 第一次找某本书要解包，之后靠映射。
    代价如实说：**冷启动后第一次**按内容找书可能要解包若干本；分析过的书会写进映射，之后是直查。
    """
    want = str(digest or "").strip().lower()
    if not is_content_digest(want):
        return None
    _identity_load()
    books = find_books()
    by_path = {b["path"]: b for b in books}

    hint = _IDENTITY_CACHE.get(want)
    if hint and Path(hint).is_dir() and (BOOK_PROVIDER != "standalone" or hint in by_path):
        try:
            got = content_digest(book_version_id(cached_extract_chapters(Path(hint))["chapters"]))
            if got == want:
                return by_path.get(hint) or {
                    "id": listing_id(Path(hint)), "index_key": book_id(Path(hint).name),
                    "name": Path(hint).name, "title": None, "author": None,
                    "path": hint, "asset_id": None, "progress": 0.0,
                    "last_opened": None, "genre": "", "indexed": False,
                }
        except Exception:  # noqa: BLE001 —— 线索坏了就丢，不用它当结论
            pass
        _IDENTITY_CACHE.pop(want, None)
        _identity_save()

    for b in books:
        try:
            got = content_digest(book_version_id(cached_extract_chapters(Path(b["path"]))["chapters"]))
        except Exception:  # noqa: BLE001 —— 解不开的书跳过，不影响别的书
            continue
        _IDENTITY_CACHE[got] = b["path"]
        if got == want:
            _identity_save()
            return b
    _identity_save()
    return None


def book_identity(book_path: str) -> dict:
    """按**绝对路径**给出这本书的**内容身份**（路径只用来定位，不参与身份）。

    给面板用：打开一本书时要知道「盘上有没有这本书的当前理解」，而理解笔记的 id 由
    **内容身份**派生 ⇒ 必须先拿到身份。**插件不算这个哈希**（那会造出第二套身份实现）。

    只接受**书库里已有的路径**（`find_books()` 的那一份原串）：不允许拿任意绝对路径来探。
    """
    want = str(Path(str(book_path or ""))) if str(book_path or "").strip() else ""
    if want == "":
        return {"ok": False, "code": "BAD_REQUEST", "path": None,
                "message": "book_identity 需要书的绝对路径（引擎 /books 返回的那一份原串）"}
    entry = next((b for b in find_books() if b["path"] == want), None)
    if entry is None:
        return {"ok": False, "code": "BOOK_NOT_IN_LIBRARY", "path": want,
                "message": "这个路径不在当前书库里 ⇒ 不猜身份（书被移走/改名后请先刷新书库）"}
    try:
        extracted = cached_extract_chapters(Path(entry["path"]))
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "code": "EXTRACT_FAILED", "path": entry["path"], "message": str(e)}
    bv = book_version_id(extracted["chapters"])
    digest = content_digest(bv)
    remember_book_identity(Path(entry["path"]), digest)
    return {
        "ok": True,
        "path": entry["path"],
        "title": extracted.get("title") or entry.get("title"),
        "author": extracted.get("author"),
        "book_id": digest,
        "book_version_id": bv,
        "identity_basis": "content",
        "read_only": True,
    }


def read_source_span(span_id: str) -> dict:
    """按 `span_id` 取原文（PRD :917 的 `get_source_span`）。

    span_id 自描述：`sp_<内容摘要 16 位>_<章节序>_<起>_<止>` ⇒ 无需常驻状态即可复算，
    并且返回的 `text_hash` 是**重新算出来的**，不是记下来的。

    M13：里面的指纹从「路径 sha1 前 8 位」换成「**内容摘要 16 位**」——
    书挪了位置/改了名，同一个 span_id 仍然取得到原文（这才是内容寻址该有的性质）。
    """
    m = re.fullmatch(r"sp_([0-9a-f]{16})_(\d+)_(\d+)_(\d+)", str(span_id or ""))
    if not m:
        return {"ok": False, "code": "BAD_SPAN_ID", "span_id": span_id or None,
                "message": "span_id 形状必须是 sp_<内容摘要16位>_<order>_<start>_<end>"}
    digest, order, start, end = m.group(1), int(m.group(2)), int(m.group(3)), int(m.group(4))
    _identity_load()
    hint = _IDENTITY_CACHE.get(digest)
    book = find_book_by_content_id(digest)
    if not book:
        # 「书还在、但内容变了」要**说准**，不能混成「找不到书」：
        # 内容寻址下，改了正文 ⇒ book_version_id 变 ⇒ 老 span_id 不再指向任何版本。
        # 这时**绝不拿现在的内容顶替那段原文**（那会显示一段根本不是当时分析的引文）。
        if hint and Path(hint).is_dir():
            try:
                now_bv = book_version_id(cached_extract_chapters(Path(hint))["chapters"])
            except Exception:  # noqa: BLE001
                now_bv = None
            if now_bv and content_digest(now_bv) != digest:
                return {"ok": False, "code": "SPAN_BOOK_CONTENT_CHANGED", "span_id": span_id,
                        "path": hint, "book_version_id": now_bv,
                        "message": "书还在，但内容已经变了（book_version_id 不是 span_id 里那一个）"
                                   "⇒ 不拿现在的内容顶替那段原文，请重新分析这本书"}
        return {"ok": False, "code": "SPAN_BOOK_NOT_FOUND", "span_id": span_id,
                "message": "按 span_id 里的内容摘要找不到书（这本书的内容不在当前书库里）"}
    bundle = Path(book["path"])
    try:
        extracted = cached_extract_chapters(bundle)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "code": "SPAN_EXTRACT_FAILED", "span_id": span_id, "message": str(e)}
    chapters = extracted["chapters"]
    if order >= len(chapters):
        return {"ok": False, "code": "SPAN_SECTION_NOT_FOUND", "span_id": span_id,
                "message": f"章节序 {order} 超出范围（共 {len(chapters)} 章）"}
    text = chapters[order]["text"]
    if not (0 <= start < end <= len(text)):
        return {"ok": False, "code": "SPAN_RANGE_INVALID", "span_id": span_id,
                "message": f"区间 [{start},{end}) 越界（该章 {len(text)} 字）"}
    quote = text[start:end]
    bv = book_version_id(chapters)
    # M15（0b）：把 SpanRef 需要的**书内定位**补齐 —— `book_id` / `href` / `block_id`。
    # 在此之前 `/source-span` 没有 block 概念 ⇒ 插件写不出结构合法的 SpanRef，
    # 证据笔记里的 `book_evidence` 只能是空数组（M14 的已知债）。
    blk = block_at(text, start)
    chapter = chapters[order]
    return {
        "ok": True,
        "span_id": span_id,
        "book_version_id": bv,
        "book_id": content_digest(bv),
        "book": extracted["title"],
        "section_id": f"sec_{digest}_{order}",
        "section_order": order,
        "href": href_at(chapter, blk["start_codepoint"]) if blk else chapter.get("href"),
        "block_id": block_id_of(digest, order, blk["index"]) if blk else None,
        "block_index": blk["index"] if blk else None,
        "block_start_codepoint": blk["start_codepoint"] if blk else None,
        "block_end_codepoint": blk["end_codepoint"] if blk else None,
        "start_codepoint": start,
        "end_codepoint": end,
        "text_hash": _sha256_text(quote),
        "quote": quote,
        "quote_chars": len(quote),
        "verified": True,
    }


def analyze_chapter(book: dict, opts: dict | None = None) -> dict:
    """逐章分析：**切片（连续窗口）+ 概括（逐窗消费）+ 候选**，并如实报队列与未知。

    opts:
      window_chars  窗口大小（默认 ANALYZE_WINDOW_CHARS）
      consumer      消费方（默认抽取式；测试可注入坏消费方）
      sections      只分析这些章节序（默认全部）
    """
    opts = opts or {}
    consumer = opts.get("consumer") or extractive_consumer
    window_chars = int(opts.get("window_chars") or ANALYZE_WINDOW_CHARS)
    only = opts.get("sections")
    only_set = set(int(x) for x in only) if only else None

    bundle = Path(str(book.get("path") or ""))
    if not bundle.exists():
        return {"ok": False, "code": "BOOK_NOT_FOUND", "message": f"读不到书目录：{bundle}"}
    try:
        extracted = cached_extract_chapters(bundle)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "code": "EXTRACT_FAILED", "message": str(e)}
    chapters = extracted["chapters"]
    bv = book_version_id(chapters)
    # M13：书身份 = **内容**摘要（不再是 sha1(路径)）。书挪位置/改名 ⇒ 这一串不变。
    digest = content_digest(bv)
    remember_book_identity(bundle, digest)

    chapter_reports: list[dict] = []
    windows_out: list[dict] = []
    slices_out: list[dict] = []
    candidates: list[dict] = []
    pending: list[str] = []
    failed: list[str] = []
    total_windows = 0
    consumed_windows = 0
    covered_codepoints = 0
    total_codepoints = 0

    for order, ch in enumerate(chapters):
        # extract_chapters 里 order == enumerate 下标（_merge_docs(buf, len(chapters))）；
        # 显式取 ch["order"] 以免将来两处漂移。
        order = int(ch.get("order", order))
        if only_set is not None and order not in only_set:
            continue
        text = ch["text"]
        section_id = f"sec_{digest}_{order}"
        span_prefix = f"sp_{digest}_{order}"
        windows = plan_chapter_windows(text, window_chars)
        plan_check = verify_windows(text, windows)
        rep: dict = {
            "section_id": section_id,
            "section_order": order,
            "href": ch.get("href"),
            "title": ch.get("title"),
            "chars": len(text),
            "window_count": len(windows),
            "plan_verified": plan_check["ok"],
            "plan_problems": plan_check["problems"],
            "consumed_windows": 0,
            "failed_windows": 0,
            "window_ids": [w["window_id"] for w in windows],
        }
        if not plan_check["ok"]:
            # 计划本身不连续 ⇒ **一个窗口都不消费**（宁可报失败，也不在坏分母上产出候选）
            rep["status"] = "plan_invalid"
            rep["no_candidate_reason"] = "窗口规划未通过连续性自校验：不消费、不产出候选"
            for w in windows:
                pending.append(f"{section_id}#{w['window_id']}")
            total_windows += len(windows)
            total_codepoints += sum(w["chars"] for w in windows)
            chapter_reports.append(rep)
            continue

        chapter_summaries: list[str] = []
        chapter_slice_ids: list[str] = []
        chapter_window_ids: list[str] = []
        for w in windows:
            wid = f"{section_id}#{w['window_id']}"
            total_windows += 1
            total_codepoints += w["chars"]
            got = consume_window(consumer, w, text)
            row = {
                "window_id": wid,
                "section_id": section_id,
                "index": w["index"],
                "start_codepoint": w["start_codepoint"],
                "end_codepoint": w["end_codepoint"],
                "chars": w["chars"],
                "text_hash": w["text_hash"],
                "status": "processed" if got["consumed"] else "failed",
                "consumed": bool(got["consumed"]),
                "summary": got.get("summary"),
                "summary_hash": got.get("summary_hash"),
                "consumer": got.get("consumer"),
                "evidence": got.get("evidence"),
                "failure_reason": got.get("failure_reason"),
                "failure_detail": got.get("detail"),
                # 失败窗口**留在队列**（不是丢掉）：attempts 至少 1
                "queued": not got["consumed"],
                "attempts": 1,
            }
            windows_out.append(row)
            if got["consumed"]:
                consumed_windows += 1
                covered_codepoints += w["chars"]
                rep["consumed_windows"] += 1
                chapter_summaries.append(got["summary"])
                chapter_window_ids.append(wid)
                sl = pick_slices(text, w, section_id, span_prefix)
                for s in sl:
                    s["window_id"] = wid
                    slices_out.append(s)
                    chapter_slice_ids.append(s["slice_id"])
            else:
                rep["failed_windows"] += 1
                failed.append(wid)
                pending.append(wid)

        rep["status"] = "analyzed" if rep["failed_windows"] == 0 else "partial"
        rep["summary"] = "\n".join(chapter_summaries) if chapter_summaries else None
        rep["slice_ids"] = chapter_slice_ids
        exclusion = recommendation_exclusion(ch, bundle)
        if exclusion:
            rep["recommendation_excluded_reason"] = exclusion
            rep["no_candidate_reason"] = "非正文材料不进入导读候选；原文与消费记录保留"
        elif not chapter_summaries:
            rep["no_candidate_reason"] = "该章没有任何窗口被真消费 ⇒ 不产出候选（不编造概括）"
        else:
            if rep["failed_windows"] > 0:
                rep["no_candidate_reason"] = None
                rep["partial_note"] = (f"该章 {rep['failed_windows']}/{rep['window_count']} 个窗口失败，"
                                       "已留在队列；候选只覆盖真消费过的窗口")
            candidates.append({
                "candidate_id": f"ca_{digest}_{order}",
                "section_id": section_id,
                "section_order": order,
                "title": ch.get("title"),
                "summary": rep["summary"],
                "slice_ids": chapter_slice_ids,
                "window_ids": chapter_window_ids,
                "book_version_id": bv,
                "source_refs": chapter_slice_ids,
                "proposed_b": _propose_b(text, chapter_summaries, chapter_slice_ids),
                "b_is_proposed": True,
                "proposed_b_note": "B 由引擎的结构分析给出（basis.kind=book_analysis），"
                                   "不是检索相似度；编排器可覆盖，覆盖时必须留下理由。",
            })
        chapter_reports.append(rep)

    failed_set = set(failed)
    queue = {
        "pending_window_ids": [w for w in pending if w not in failed_set],
        "failed_window_ids": list(failed),
        "note": "失败窗口**继续排队**，不静默丢弃；重试需要显式调度",
        "retry_requires_explicit_schedule": True,
    }
    analysis_complete = (total_windows > 0 and not failed and not queue["pending_window_ids"])
    result = {
        "ok": True,
        "analysis_version": ANALYSIS_VERSION,
        "book": extracted["title"],
        "author": extracted.get("author"),
        "book_path": str(bundle),
        "book_version_id": bv,
        # M13：书身份 = 内容摘要（16 位）。**不再有 `path_hash8`** —— 路径不参与身份。
        "content_id": digest,
        "identity_basis": "content",
        "chapters": chapter_reports,
        "windows": windows_out,
        "slices": slices_out,
        "candidates": candidates,
        "queue": queue,
        "coverage": {
            "scope": "parsed_body",
            "total_units": total_windows,
            "analyzed_units": consumed_windows,
            "failed_units": len(failed),
            "excluded_units": 0,
            "excluded_reasons": [],
            "covered_codepoints": covered_codepoints,
            "total_codepoints": total_codepoints,
            "units_note": "分母 = 已解析正文的连续窗口数（PRD :346）；重叠不重复计，窗口本身不重叠",
            "unknown": {
                "kinds": ["image_pages", "unparsable_files", "non_spine_manifest_items"],
                "counts_known": False,
                "ratio_known": False,
                "note": "引擎只读 OPF spine/manifest 里的 HTML；图片页与不可解析项**未计数** ⇒ 数量与占比不可知",
            },
            "whole_book_claim_allowed": False,
            "whole_book_percent": None,
        },
        "honesty": {
            "book_understood": {
                "allowed": False,
                "reason": "「已读懂」恒不可宣称（PRD :240 / 规范 §4）：本输出只说明窗口被消费过",
            },
            "whole_book_claim_allowed": False,
            "layers": {
                "extraction": {
                    "scope": "parsed_body",
                    "units": total_windows,
                    "note": "切片完成（窗口已规划并自校验）",
                },
                "analysis": {
                    "scope": "parsed_body",
                    "units": consumed_windows,
                    "total_units": total_windows,
                    "complete_for_parsed_body": analysis_complete,
                    "note": "只有**真消费**（有回执核验）的窗口才计入分析；切片完成 ≠ 分析完成",
                },
                "reading": {
                    "known": False,
                    "note": "用户实际读到哪，引擎不知道，也不推断（阅读完成与否未知）",
                },
            },
            "note": "切片完成 ≠ 分析完成 ≠ 阅读完成：三层分开，且都不等于「已读懂」",
        },
        "engine": {
            "name": "books_rag.py",
            "analysis_version": ANALYSIS_VERSION,
            "window_chars": window_chars,
            "consumer": "extractive",
            "lexical_weight": LEXICAL_WEIGHT,
            "rerank_pool": RERANK_POOL,
            "rerank_min_conf": RERANK_MIN_CONF,
            "note": "LEXICAL_WEIGHT / RERANK_POOL / RERANK_MIN_CONF 语义未变（本入口不碰检索排序）",
        },
    }
    return result


def _propose_b(text: str, summaries: list[str], slice_ids: list[str]) -> dict:
    """给一个**有说明的** B 序位建议（0—3），依据是章节的结构观察。

    刻意不用检索相似度（PRD :267 明令禁止）。这里的依据只有三类可核对的观察：
      · 章节体量（字数）与代表切片数；
      · 论证/条件标记词的出现次数（因此/所以/因为/如果/但是/反之…）；
      · 是否为「定义/命题」式陈述。
    """
    marks = {
        "argument": len(re.findall(r"因此|所以|因而|由此可见|故而|因为|由于", text)),
        "condition": len(re.findall(r"如果|假如|若|前提|条件|除非|否则", text)),
        "contrast": len(re.findall(r"但是|然而|反之|相反|不过|可是", text)),
        "definition": len(re.findall(r"所谓|定义|意味着|即是|乃是|指的是", text)),
    }
    score = 0
    reasons: list[str] = []
    if marks["definition"] > 0:
        score += 1
        reasons.append(f"含定义/命题式陈述 {marks['definition']} 处")
    if marks["argument"] >= 2:
        score += 1
        reasons.append(f"论证连接词 {marks['argument']} 处")
    if marks["condition"] > 0 and marks["contrast"] > 0:
        score += 1
        reasons.append(f"同时出现条件（{marks['condition']}）与转折/边界（{marks['contrast']}）")
    if len(slice_ids) >= ANALYZE_MAX_SLICES:
        score += 1
        reasons.append(f"代表切片 {len(slice_ids)} 条（覆盖充分）")
    score = max(0, min(3, score))
    return {
        "score": score,
        "reason": ("；".join(reasons) if reasons else "结构观察不足：仅有体量信息")
                  + f"；结构标记 {marks}",
        "basis": {"kind": "book_analysis", "marks": marks,
                  "note": "结构观察（非检索相似度），编排器可覆盖"},
        "anchors": {
            0: "有来源但缺阅读价值", 1: "局部补充", 2: "代表性论点/必要前提", 3: "核心论证或关键边界",
        }[score],
    }


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #

def cmd_analyze_chapter(args) -> int:
    b = resolve_book(args.book)
    if not b:
        print(f"书库里没有匹配「{args.book}」的书。", file=sys.stderr)
        return 1
    opts = {}
    if args.window_chars:
        opts["window_chars"] = args.window_chars
    if args.sections:
        opts["sections"] = [int(x) for x in args.sections.split(",") if x.strip()]
    out = analyze_chapter(b, opts)
    if args.json:
        print(json.dumps(out, ensure_ascii=False, indent=2))
    else:
        if not out.get("ok"):
            print(f"分析失败：{out.get('code')} {out.get('message')}", file=sys.stderr)
            return 1
        cov = out["coverage"]
        print(f"《{out['book']}》{len(out['chapters'])} 章 / 窗口 {cov['total_units']}"
              f"（已消费 {cov['analyzed_units']}，失败 {cov['failed_units']}）")
        for c in out["chapters"]:
            print(f"  [{c['section_order']:>3}] {c.get('title')} · {c['chars']} 字 · "
                  f"{c['consumed_windows']}/{c['window_count']} 窗口 · {c['status']}")
        if out["queue"]["failed_window_ids"]:
            print(f"  失败窗口仍在队列：{len(out['queue']['failed_window_ids'])} 个")
    return 0 if out.get("ok") else 1


def cmd_source_span(args) -> int:
    out = read_source_span(args.id)
    if args.json:
        print(json.dumps(out, ensure_ascii=False, indent=2))
    elif out.get("ok"):
        print(out["quote"])
    else:
        print(f"{out.get('code')}: {out.get('message')}", file=sys.stderr)
    return 0 if out.get("ok") else 1


def cmd_book_identity(args) -> int:
    out = book_identity(args.path)
    if args.json:
        print(json.dumps(out, ensure_ascii=False, indent=2))
    elif out.get("ok"):
        print(f"{out['book_version_id']}  book_id={out['book_id']}  {out['path']}")
    else:
        print(f"{out.get('code')}: {out.get('message')}", file=sys.stderr)
    return 0 if out.get("ok") else 1


def cmd_list(args) -> int:
    books = find_books()
    anns = load_annotations()
    per_book: dict[str, int] = {}
    for a in anns:
        per_book[a["book"]] = per_book.get(a["book"], 0) + 1
    if args.json:
        print(json.dumps({"books": books, "annotation_count": len(anns),
                          "annotations_available": annotations_available()},
                         ensure_ascii=False, indent=2))
        return 0
    if not books:
        print(f"没找到书库：{BOOKS_DIR}")
        return 1
    lib_ok = "✓" if load_library() else "✗（未授权，书名可能不准）"
    ann_ok = "✓" if annotations_available() else "✗（未授权，读不到高亮）"
    print(f"书库 {BOOKS_DIR}")
    print(f"共 {len(books)} 本 · 书目元数据 {lib_ok} · 标注 {ann_ok}（{len(anns)} 条）\n")
    for b in books:
        marks = []
        if b["indexed"]:
            marks.append("已索引")
        n = per_book.get(b["title"], 0)
        if n:
            marks.append(f"{n} 标注")
        if b["progress"]:
            marks.append(f"{b['progress']:.0f}%")
        tail = ("  " + " · ".join(marks)) if marks else ""
        author = f" — {b['author']}" if b["author"] else ""
        print(f"  {b['title']}{author}{tail}")
    return 0


def cmd_index(args) -> int:
    targets = find_books() if args.all else None
    if targets is None:
        book = resolve_book(args.book)
        if not book:
            print(f"书库里没有匹配「{args.book}」的书", file=sys.stderr)
            return 1
        targets = [book]
    built = failed = 0
    for b in targets:
        try:
            build_index(b, force=args.force)
            built += 1
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"  ✗ 《{b['title']}》：{e}", file=sys.stderr)
    print(f"\n完成：处理 {built} 本，失败 {failed} 本，共 {len(targets)} 本", flush=True)
    return 0 if built else 1


def cmd_search(args) -> int:
    book = resolve_book(args.book)
    if not book:
        print(f"书库里没有匹配「{args.book}」的书", file=sys.stderr)
        return 1
    result = search(book, args.query, k=args.k, rerank=not args.no_rerank)
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    tag = "精排" if result.get("reranked") else "混合排序"
    if not result.get("reranked") and not args.no_rerank and not rerank_available():
        tag += "（reranker 未下载，跑 rerank-setup 启用精排）"
    print(f"《{result['title']}》{result['author']} — 「{result['query']}」〔{tag}〕\n")
    for h in result["hits"]:
        print(f"[{h['rank']}] ({h['score']:.3f}) 「{h['chapter']}」")
        print(f"    {h['text'][:300]}{'…' if len(h['text']) > 300 else ''}\n")
    return 0


def cmd_rerank_setup(args) -> int:
    """显式下载精排模型（1GB）。不放在搜索路径里，是为了不偷偷吃掉用户的带宽。"""
    if rerank_available():
        print(f"精排模型已在本地：{RERANK_MODEL}")
    else:
        print(f"正在下载精排模型 {RERANK_MODEL}（约 1 GB，一次性）…")
        print("它能把「字面像」和「真的在回答这个问题」区分开，检索精度会明显提升。")
    model = get_reranker()
    if model is None:
        print("下载失败。没网也能用，只是退回混合排序。", file=sys.stderr)
        return 1
    # 真跑一次，确认能用（顺便把 ONNX 会话建起来）
    scores = [float(x) for x in model.rerank("测试查询", ["相关的一段文字", "完全无关的一句话"])]
    print(f"就绪。自检打分：相关 {scores[0]:+.3f} / 无关 {scores[1]:+.3f}")
    print(f"缓存位置：{_fastembed_cache()}")
    return 0


def cmd_annotations(args) -> int:
    book = resolve_book(args.book) if args.book else None
    if args.book and not book:
        print(f"书库里没有匹配「{args.book}」的书", file=sys.stderr)
        return 1
    if not annotations_available():
        msg = ("读不到标注库。需要给 DeepSeek Harness（以及启动它的终端）授予"
               "「完全磁盘访问权限」后重启。")
        print(json.dumps({"error": msg}, ensure_ascii=False) if args.json else msg,
              file=sys.stderr)
        return 1
    anns = load_annotations(book=book, limit=args.limit, with_context=args.context)
    if args.json:
        print(json.dumps(anns, ensure_ascii=False, indent=2))
        return 0
    if not anns:
        print("没有高亮或笔记。")
        return 0
    print(f"{len(anns)} 条标注：\n")
    for a in anns:
        print(f"  #{a['id']} 《{a['book']}》 {a['type']}/{a['color']} · {a['modified']}")
        if a["text"]:
            print(f"      「{a['text'][:120]}」")
        if a["note"]:
            print(f"      笔记：{a['note'][:120]}")
        if a.get("chapter"):
            print(f"      章节「{a['chapter']}」")
        if a.get("context"):
            print(f"      上下文：…{a['context'][:200]}…")
        print()
    return 0


def cmd_context(args) -> int:
    res = annotation_context(args.id, before=args.before, after=args.after)
    if args.json:
        print(json.dumps(res, ensure_ascii=False, indent=2))
        return 0 if "error" not in res else 1
    if "error" in res:
        print(res["error"], file=sys.stderr)
        return 1
    a = res["annotation"]
    print(f"《{res['book']}》 章节「{res['chapter']}」 偏移 {res['offset']}"
          f"{'' if res['exact'] else '（近似）'}")
    if res.get("note_hint"):
        print(f"  提示：{res['note_hint']}")
    print(f"\n标注原文：{a['text'][:200]}\n")
    print("前后原文：\n" + res["context"])
    return 0


def cmd_open(args) -> int:
    book = resolve_book(args.book) if args.book else None
    if args.book and not book:
        print(f"书库里没有匹配「{args.book}」的书", file=sys.stderr)
        return 1
    print(open_in_books(book))
    return 0


# --------------------------------------------------------------------------- #
# MCP server（给 DeepSeek Harness 用）
# --------------------------------------------------------------------------- #

def serve() -> int:
    from mcp.server.fastmcp import FastMCP
    start_model_evictor()   # MCP 也是长驻进程，同样要回收空闲模型
    mcp = FastMCP("apple_read")

    @mcp.tool()
    def list_books() -> str:
        """列出 macOS「图书」App 书库里的所有书，含作者、阅读进度、是否已建向量索引、
        以及每本书的高亮数量。问书之前先用它拿到准确书名。"""
        books = find_books()
        if not books:
            return "书库为空或读不到。"
        anns = load_annotations()
        cnt: dict[str, int] = {}
        for a in anns:
            cnt[a["book"]] = cnt.get(a["book"], 0) + 1
        lines = [f"共 {len(books)} 本" + (f"，标注 {len(anns)} 条" if anns else
                 "（读不到标注：需授予「完全磁盘访问权限」）")]
        for b in books:
            bits = []
            if b["author"]:
                bits.append(b["author"])
            if b["progress"]:
                bits.append(f"读 {b['progress']:.0f}%")
            bits.append("已索引" if b["indexed"] else "未索引")
            if cnt.get(b["title"]):
                bits.append(f"{cnt[b['title']]} 条标注")
            lines.append(f"· {b['title']}（{'，'.join(bits)}）")
        return "\n".join(lines)

    @mcp.tool()
    def search_book(book: str, query: str, top_k: int = 5) -> str:
        """在某一本书的【全文】里做向量语义检索，返回最相关的段落原文 + 所在章节。

        语义检索：换个说法也能召回，不只是字面匹配。回答关于书里内容的问题时，
        应该先用这个工具拿原文依据再作答。book 传书名（支持子串，先用 list_books 查）。
        未建索引的书会在首次检索时自动建索引（会慢几十秒）。
        """
        b = resolve_book(book)
        if not b:
            return f"书库里没有匹配「{book}」的书。先用 list_books 看准确书名。"
        try:
            r = search(b, query, k=max(1, min(int(top_k), 20)))
        except Exception as e:  # noqa: BLE001
            return f"检索失败：{e}"
        out = [f"《{r['title']}》{r['author']} — 检索「{query}」，命中 {len(r['hits'])} 段："]
        if not r.get("reranked") and not rerank_available():
            out.append("（注：精排模型未下载，本次是向量+字面混合排序；"
                       "运行 books_rag.py rerank-setup 可开启精排，命中率更高）")
        for h in r["hits"]:
            out.append(f"\n[{h['rank']}] 相关度 {h['score']:.3f} · 章节「{h['chapter']}」\n{h['text']}")
        return "\n".join(out)

    @mcp.tool()
    def list_annotations(book: str = "", limit: int = 30) -> str:
        """列出你在「图书」App 里的高亮和笔记（只有原文，不含上下文）。
        book 留空表示整个书库；填书名则只看那一本。

        想围绕「我划的这句」聊、或要看标注的前后原文，用 recent_annotations 更好。
        需要已授予「完全磁盘访问权限」。"""
        if not annotations_available():
            return ("读不到标注库：需要给 DeepSeek Harness 授予「完全磁盘访问权限」并重启。"
                    "全文检索不受影响，仍可用 search_book。")
        b = None
        if book:
            b = resolve_book(book)
            if not b:
                return f"书库里没有匹配「{book}」的书。"
        anns = load_annotations(book=b, limit=max(1, min(int(limit), 200)))
        if not anns:
            return f"《{b['title']}》没有高亮或笔记。" if b else "书库里还没有高亮或笔记。"
        out = [f"{len(anns)} 条标注："]
        for a in anns:
            line = f"\n#{a['id']} 《{a['book']}》{a['type']}/{a['color']} · {a['modified']}"
            if a["text"]:
                line += f"\n   高亮：{a['text'][:200]}"
            if a["note"]:
                line += f"\n   笔记：{a['note'][:200]}"
            out.append(line)
        return "\n".join(out)

    @mcp.tool()
    def recent_annotations(limit: int = 10, book: str = "") -> str:
        """读取用户在「图书」App 里标记的高亮/笔记，**并附带每条的所在章节和前后原文**。

        当用户提到「我标的」「我划的线」「我的高亮」「我的笔记」「我标注的地方」
        「我刚标记的那句」，或者想围绕自己划过的内容聊、要 AI 伴读时，**先用这个工具**。
        一次调用就能拿到标注原文 + 上下文，不必再逐条调 get_annotation_context。
        需要「完全磁盘访问权限」。
        """
        if not annotations_available():
            return ("读不到标注库：需要给 DeepSeek Harness 授予「完全磁盘访问权限」并重启。"
                    "全文检索不受影响，仍可用 search_book。")
        b = None
        if book:
            b = resolve_book(book)
            if not b:
                return f"书库里没有匹配「{book}」的书。"
        anns = load_annotations(book=b, limit=max(1, min(int(limit), 50)), with_context=True)
        if not anns:
            return f"《{b['title']}》没有高亮或笔记。" if b else "书库里还没有高亮或笔记。"
        out = [f"{len(anns)} 条标注（新的在前）："]
        for a in anns:
            head = f"\n#{a['id']} 《{a['book']}》{a['type']}/{a['color']} · {a['modified']}"
            if a.get("chapter"):
                head += f" · 章节「{a['chapter']}」"
            out.append(head)
            out.append(f"   我划的：{a['text'][:400]}")
            if a["note"]:
                out.append(f"   我的笔记：{a['note'][:300]}")
            if a.get("context"):
                out.append(f"   前后原文：{a['context'][:600]}")
        return "\n".join(out)

    @mcp.tool()
    def get_annotation_context(annotation_id: int, chars_before: int = 400,
                               chars_after: int = 400) -> str:
        """还原某条高亮/笔记在全书里的位置和前后原文。annotation_id 从 list_annotations 拿。
        想知道「我标这句的上下文是什么」时用它。"""
        res = annotation_context(int(annotation_id), before=int(chars_before),
                                 after=int(chars_after))
        if "error" in res:
            return res["error"]
        head = f"《{res['book']}》章节「{res['chapter']}」"
        if not res["exact"]:
            head += "（标点不一致，按位置近似定位）"
        return (f"{head}\n\n标注原文：{res['annotation']['text'][:300]}"
                f"\n\n前后原文：\n{res['context']}")

    @mcp.tool()
    def index_book(book: str) -> str:
        """为单本书建立或重建向量索引。"""
        b = resolve_book(book)
        if not b:
            return f"书库里没有匹配「{book}」的书。"
        try:
            meta = build_index(b, log=lambda m: None, force=True)
        except Exception as e:  # noqa: BLE001
            return f"建索引失败：{e}"
        return f"《{meta['title']}》索引完成：{len(meta['chunks'])} 段 / {meta['dim']} 维。"

    @mcp.tool()
    def open_in_books_app(book: str = "") -> str:
        """在 macOS「图书」App 中打开某本书（用户想接着读、或想看原文位置时用）。"""
        b = None
        if book:
            b = resolve_book(book)
            if not b:
                return f"书库里没有匹配「{book}」的书。"
        return open_in_books(b)

    mcp.run()
    return 0


# --------------------------------------------------------------------------- #
# HTTP sidecar（给侧边栏面板用，常驻以复用已加载的模型）
# --------------------------------------------------------------------------- #

def serve_http(port: int = 0) -> int:
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from urllib.parse import parse_qs, urlparse

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *a):  # 静音
            pass

        def _json(self, obj, code=200):
            body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("content-type", "application/json; charset=utf-8")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):  # noqa: N802
            path = self.path.split("?")[0]
            if path == "/health":
                return self._json({"ok": True, "annotations": annotations_available(),
                                   "rerank": rerank_available(),
                                   "rerank_model": RERANK_MODEL})
            if path == "/books":
                return self._json({"books": find_books(),
                                   "annotations_available": annotations_available()})
            # M13：按**绝对路径**给出**内容身份**（路径只用来定位，不参与身份）。
            # 面板打开一本书时要问「盘上有没有这本书的当前理解」，而理解笔记的 id 由内容身份
            # 派生 ⇒ 必须先拿到身份。插件**不自己算**这个哈希（那会造出第二套身份实现）。
            if path == "/book-identity":
                q = parse_qs(urlparse(self.path).query)
                return self._json(book_identity((q.get("path") or [""])[0]))
            if path == "/annotations":
                q = parse_qs(urlparse(self.path).query)
                book = resolve_book(q["book"][0]) if q.get("book") else None
                want_ctx = q.get("context", ["0"])[0].lower() not in ("0", "", "false")
                return self._json({"annotations": load_annotations(
                    book=book, limit=int(q.get("limit", ["50"])[0]), with_context=want_ctx)})
            return self._json({"error": "not found"}, 404)

        def do_POST(self):  # noqa: N802
            n = int(self.headers.get("content-length") or 0)
            try:
                payload = json.loads(self.rfile.read(n) or b"{}")
            except json.JSONDecodeError:
                return self._json({"error": "bad json"}, 400)
            path = self.path.split("?")[0]
            if path == "/search":
                b = resolve_book(payload.get("book", ""))
                if not b:
                    return self._json({"error": "没有这本书"}, 404)
                try:
                    return self._json(search(b, payload.get("query", ""),
                                             k=int(payload.get("k", 6)),
                                             rerank=payload.get("rerank")))
                except Exception as e:  # noqa: BLE001
                    return self._json({"error": str(e)}, 500)
            if path == "/index":
                b = resolve_book(payload.get("book", ""))
                if not b:
                    return self._json({"error": "没有这本书"}, 404)
                try:
                    meta = build_index(b, log=lambda m: None, force=bool(payload.get("force")))
                    return self._json({"ok": True, "title": meta["title"],
                                       "chunks": len(meta["chunks"]), "dim": meta["dim"]})
                except Exception as e:  # noqa: BLE001
                    return self._json({"error": str(e)}, 500)
            if path == "/open":
                b = resolve_book(payload.get("book", "")) if payload.get("book") else None
                return self._json({"message": open_in_books(b)})
            if path == "/context":
                return self._json(annotation_context(int(payload.get("id", 0)),
                                                     before=int(payload.get("before", 400)),
                                                     after=int(payload.get("after", 400))))
            # ---- M8 新增入口（**不触碰**上面 7 个既有路由的签名与行为）----
            if path == "/analyze-chapter":
                b = resolve_book(payload.get("book", ""))
                if not b:
                    return self._json({"error": "没有这本书"}, 404)
                try:
                    opts = {}
                    if payload.get("window_chars"):
                        opts["window_chars"] = int(payload["window_chars"])
                    if payload.get("sections"):
                        opts["sections"] = payload["sections"]
                    return self._json(analyze_chapter(b, opts))
                except Exception as e:  # noqa: BLE001
                    return self._json({"error": str(e)}, 500)
            if path == "/source-span":
                return self._json(read_source_span(str(payload.get("span_id") or "")))
            return self._json({"error": "not found"}, 404)

    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(json.dumps({"port": srv.server_address[1]}), flush=True)
    start_model_evictor()                                     # 空闲回收（精排模型 1GB）
    threading.Thread(target=get_model, daemon=True).start()   # 预热模型
    srv.serve_forever()
    return 0


# --------------------------------------------------------------------------- #

def main() -> int:
    p = argparse.ArgumentParser(description="Apple Books 向量伴读引擎")
    p.add_argument("--json", action="store_true", help="输出 JSON")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("list", help="列出书库").set_defaults(func=cmd_list)

    pi = sub.add_parser("index", help="建立/重建向量索引")
    pi.add_argument("--book")
    pi.add_argument("--all", action="store_true")
    pi.add_argument("--force", action="store_true", help="忽略 mtime，强制重建")
    pi.set_defaults(func=cmd_index)

    ps = sub.add_parser("search", help="向量检索")
    ps.add_argument("--book", required=True)
    ps.add_argument("query")
    ps.add_argument("-k", type=int, default=5)
    ps.add_argument("--no-rerank", action="store_true", help="跳过精排，只用向量+字面")
    ps.set_defaults(func=cmd_search)

    pr = sub.add_parser("rerank-setup", help="下载精排模型（约 1GB，一次性）")
    pr.set_defaults(func=cmd_rerank_setup)

    pa = sub.add_parser("annotations", help="列出高亮/笔记")
    pa.add_argument("--book")
    pa.add_argument("--limit", type=int, default=30)
    pa.add_argument("--context", action="store_true", help="附带所在章节与前后原文")
    pa.set_defaults(func=cmd_annotations)

    pc = sub.add_parser("context", help="还原标注前后原文")
    pc.add_argument("--id", type=int, required=True)
    pc.add_argument("--before", type=int, default=400)
    pc.add_argument("--after", type=int, default=400)
    pc.set_defaults(func=cmd_context)

    po = sub.add_parser("open", help="在「图书」App 中打开")
    po.add_argument("--book")
    po.set_defaults(func=cmd_open)

    pac = sub.add_parser("analyze-chapter", help="逐章分析：连续窗口 + 概括 + 代表切片（M8）")
    pac.add_argument("--book", required=True)
    pac.add_argument("--window-chars", type=int, default=0, help="窗口大小（默认 3000 字）")
    pac.add_argument("--sections", default="", help="只分析这些章节序，逗号分隔")
    pac.set_defaults(func=cmd_analyze_chapter)

    psp = sub.add_parser("source-span", help="按 span_id 取原文（M8，PRD :917 get_source_span）")
    psp.add_argument("--id", required=True)
    psp.set_defaults(func=cmd_source_span)

    pbi = sub.add_parser("book-identity", help="按路径给出这本书的**内容身份**（M13）")
    pbi.add_argument("--path", required=True, help="书的绝对路径（引擎 /books 返回的那一份原串）")
    pbi.set_defaults(func=cmd_book_identity)

    sub.add_parser("serve", help="MCP stdio server").set_defaults(func=lambda a: serve())

    ph = sub.add_parser("serve-http", help="本地 HTTP 服务（面板用）")
    ph.add_argument("--port", type=int, default=0)
    ph.set_defaults(func=lambda a: serve_http(a.port))

    args = p.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
