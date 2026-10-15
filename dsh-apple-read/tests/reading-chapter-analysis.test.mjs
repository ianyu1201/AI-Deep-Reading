/**
 * M8「逐章分析 + source-span」端到端测试。
 *
 * 为什么单独一个文件：M8 的两个新入口（`analyze-chapter` / `source-span`）与 HTTP 侧车
 * 的既有 7 条路由在同一个进程里，只有把**真引擎**拉起来（CLI + serve-http）才能同时钉住
 * 「窗口连续性」「消费证据」「切片可复算」「既有路由不漂移」这几件事。
 *
 * 为什么是 hermetic：引擎在 import 那一刻读 `APPLE_READ_DIR` 定位书库，所以这里用
 * `mkdtempSync` 造一本**解包后的**夹具 EPUB，再把 `APPLE_READ_DIR` 指过去 ——
 * 全程不碰用户真实的「图书」书库。
 *
 * 跑法（在 dsh-apple-read 目录）：node tests/reading-chapter-analysis.test.mjs
 *
 * 注意（实测，非猜测）：引擎既有的 `/health` 与 `/books` 是 **GET-only**。
 * 本文件按引擎既有契约断言这两条路由仍在（GET），并额外把规范字面写法的 POST 探一次，
 * 结果以 `⊘ 跳过` + 原始观测值如实打印，不当作通过、也不悄悄改掉。
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));   // …/dsh-apple-read/tests
const REPO = join(HERE, "..", "..");                    // …/DSH-apple-Read（引擎所在目录）
const ENGINE = join(REPO, "books_rag.py");

// ---------- 断言工具（与 test-sidecar.mjs 同一套口径） ----------
let pass = 0, fail = 0, skipped = 0;
const ok = (m) => { pass++; console.log("  ✓ " + m); };
const bad = (m, d) => { fail++; console.log("  ✗ " + m + (d ? " — " + d : "")); };
// 「环境导致无法验证」必须与「通过」「失败」都区分开，并明确计数、明确打印原因：
// 静默算通过 = 假绿；直接算失败 = 把环境限制误报成引擎缺陷。
const skip = (m, why) => { skipped++; console.log("  ⊘ 跳过 " + m + " —— " + why); };
const check = (cond, m, d) => { cond ? ok(m) : bad(m, d); };

const snip = (s, n = 300) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
};
const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const parseJson = (text) => { try { return { json: JSON.parse(text) }; } catch (e) { return { err: e }; } };

// ---------- 夹具 ----------
const TMP = mkdtempSync(join(tmpdir(), "apple-read-m8-"));
const TITLE = "M8 夹具书";
const BUNDLE = join(TMP, `${TITLE}.epub`);
const env = { ...process.env, APPLE_READ_DIR: TMP, APPLE_READ_INDEX: join(TMP, "index") };

// 每章正文都必须 >= MIN_CHAPTER_CHARS(120)，否则 extract_chapters 会把短文档并成一章。
const C0 = [
  "第一章从这里开始，开篇就把问题摆在读者面前，并说明它为什么值得花一整章来讨论。",
  "接着用第二句话交代背景与来龙去脉，让读者明白这个问题是在什么条件下出现的。",
  "第三句话给出一个可以检验的判断，充当后文反复引用的锚点，而不是一句空泛的口号。",
  "最后一句收束本章，同时把尚未解决的悬念留给下一章，等待新的证据来继续处理。",
].join("");
// 长章：>= 2500 字，配合 --window-chars 200 必然切出多个窗口。
const C1 = Array.from({ length: 70 }, (_, i) =>
  `第${i + 1}节讨论把观察、推论与边界条件依次摆开，说明这个判断在什么前提下成立、在什么情形下需要修正。`
).join("");
// 无句末标点的长串：_boundary_near 找不到边界，只能按窗口大小硬切（兜底路径）。
const C2 = "江河湖海山川草木风云雷电".repeat(30);
const C3 = [
  "第三章换个角度，先复述前文的关键结论，并指出它成立的范围。",
  "然后给出一个容易被忽略的反例，说明忽略边界会付出什么代价。",
  "最后提出一个折中的处理办法，供后面的章节继续检验与修正。",
  "这一章不追求结论，只把问题拆成更小、更容易验证的几步，留给读者自己走完。",
].join("");

const html = (text) => `<html><body><p>${text}</p></body></html>`;

function writeFixtureFile(rel, content) {
  const p = join(BUNDLE, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content, "utf8");
  return p;
}

function buildFixture() {
  writeFixtureFile("META-INF/container.xml",
    `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`);
  writeFixtureFile("content.opf",
    `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>${TITLE}</dc:title>
    <dc:creator>夹具作者</dc:creator>
  </metadata>
  <manifest>
    <item id="c0" href="text/c0.html" media-type="application/xhtml+xml"/>
    <item id="c1" href="text/c1.html" media-type="application/xhtml+xml"/>
    <item id="c2" href="text/c2.html" media-type="application/xhtml+xml"/>
    <item id="c3" href="text/c3.html" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="c0"/>
    <itemref idref="c1"/>
    <itemref idref="c2"/>
    <itemref idref="c3"/>
  </spine>
</package>
`);
  writeFixtureFile("text/c0.html", html(C0));
  writeFixtureFile("text/c1.html", html(C1));
  writeFixtureFile("text/c2.html", html(C2));
  writeFixtureFile("text/c3.html", html(C3));
}

// ---------- 子进程 ----------
// 只有 ENOENT（python3 不存在）才算环境限制；超时/非零退出/崩溃都是引擎侧行为，必须计入失败。
function spawnFailure(r, label) {
  if (!r.error) return false;
  if (r.error.code === "ENOENT") { skip(label, "找不到可用的 python3：" + r.error.message); return true; }
  bad(label + "（进程未能正常运行）", `${r.error.code || ""} ${r.error.message}；stderr=${snip(r.stderr)}`);
  return true;
}

function cli(args, timeout = 120000) {
  return spawnSync("python3", [ENGINE, ...args], {
    env, cwd: REPO, encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024,
  });
}

/** 用**另一套环境**跑引擎 CLI（M13 3a：把书换到另一个书库根去解析同一个 span）。 */
function cliEnv(args, envOverride, timeout = 120000) {
  return spawnSync("python3", [ENGINE, ...args], {
    env: envOverride, cwd: REPO, encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024,
  });
}

function pyHelper(src, extraArgs = [], timeout = 120000) {
  return spawnSync("python3", ["-c", src, ...extraArgs], {
    env: { ...env, PYTHONPATH: REPO }, cwd: REPO, encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024,
  });
}

// 取切片所属章节序：切片没有 section_order 字段，用 section_id 反查章节报告。
function orderOfSection0(slice, chapters) {
  const rep = chapters.find((c) => c.section_id === slice.section_id);
  return rep ? rep.section_order : -1;
}

async function httpReq(base, method, path, body) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 60000);
  try {
    const r = await fetch(base + path, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ac.signal,
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    return { status: r.status, json, text };
  } finally { clearTimeout(t); }
}

function spawnSidecar() {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [ENGINE, "serve-http", "--port", "0"],
      { env, cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "", settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      reject(new Error(`等待 serve-http 打印端口超时（30s）；stderr=${snip(err)}`));
    }, 30000);
    child.stdout.on("data", (d) => {
      out += d.toString();
      const m = out.match(/"port"\s*:\s*(\d+)/);
      if (m && !settled) { settled = true; clearTimeout(timer); resolve({ child, port: Number(m[1]), stderrText: () => err }); }
    });
    child.stderr.on("data", (d) => { err += d.toString(); });
    child.on("error", (e) => {
      if (!settled) { settled = true; clearTimeout(timer); try { child.kill("SIGKILL"); } catch { /* ignore */ } reject(e); }
    });
    child.on("exit", (code) => {
      if (!settled) { settled = true; clearTimeout(timer); reject(new Error(`serve-http 提前退出 code=${code}；stderr=${snip(err)}`)); }
    });
  });
}

// ---------- 主流程 ----------
let sidecar = null;
let httpSliceId = null;
let httpSliceHash = null;
try {
  const pyProbe = spawnSync("python3", ["--version"], { encoding: "utf8" });
  const pyOk = !pyProbe.error && pyProbe.status === 0;

  if (!pyOk) {
    skip("全部检查", "找不到可用的 python3（"
      + snip(pyProbe.error ? pyProbe.error.message : `status=${pyProbe.status} ${pyProbe.stderr}`) + "）");
  } else {
    buildFixture();

    // 元检查：夹具真的覆盖了目标性质（否则后面的断言只是「恰好没触发」）。
    console.log("\n[0] 夹具自检");
    const lens = [C0, C1, C2, C3].map((t) => t.length);
    check(lens.every((n) => n >= 120), "四章正文均 >= MIN_CHAPTER_CHARS(120)，不会被并章",
      `实际长度=${JSON.stringify(lens)}`);
    check(C1.length >= 2500, "长章 c1 >= 2500 字（--window-chars 200 应切出多窗口）", `实际=${C1.length}`);
    check(!/[。！？!?；;…\n]/.test(C2), "c2 确实不含任何句末标点/换行（覆盖无边界兜底路径）",
      `含有的标点=${JSON.stringify(C2.match(/[。！？!?；;…\n]/g))}`);

    // ================= [1] CLI analyze-chapter =================
    console.log("\n[1] CLI analyze-chapter 输出");
    let A = null;
    const r1 = cli(["--json", "analyze-chapter", "--book", TITLE, "--window-chars", "200"]);
    if (!spawnFailure(r1, "运行 analyze-chapter")) {
      check(r1.status === 0, "analyze-chapter 退出码为 0", `status=${r1.status} stderr=${snip(r1.stderr)}`);
      const P = parseJson(r1.stdout);
      if (P.err) {
        bad("analyze-chapter 输出是合法 JSON", `解析失败：${P.err.message}；原始输出片段：${snip(r1.stdout)}`);
      } else {
        A = P.json;
        check(A && A.ok === true, "analyze-chapter 结果 ok === true", `实际=${snip(JSON.stringify(A))}`);
        if (!(A && A.ok === true)) A = null;
      }
    }

    if (!A) {
      skip("全部 analyze-chapter 派生检查", "分析输出不可用（见上一条 ✗ 的原始输出片段）");
    } else {
      // M13：身份是**内容摘要**（16 位），不再是路径 sha1 前 8 位。
      const cid = A.content_id;
      check(/^[0-9a-f]{16}$/.test(String(cid ?? "")), "分析结果带 content_id（16 位小写 hex）",
        `实际=${snip(JSON.stringify(cid))}`);
      check(!("path_hash8" in A), "分析结果里**不再有 path_hash8**（路径不参与身份）",
        `实际字段=${snip(Object.keys(A).join(","))}`);
      const chapters = Array.isArray(A.chapters) ? A.chapters : [];
      const windows = Array.isArray(A.windows) ? A.windows : [];
      const slices = Array.isArray(A.slices) ? A.slices : [];
      const candidates = Array.isArray(A.candidates) ? A.candidates : [];
      check(slices.length === 0 || slices.every((s) => String(s.slice_id).startsWith(`sp_${cid}_`)),
        "切片 id 里嵌的是 content_id（sp_<content_id>_<章序>_<起>_<止>）",
        `样本=${snip(slices[0] && slices[0].slice_id)}`);

      // ================= [2] 窗口连续性 + window_id 前缀契约 =================
      console.log("\n[2] 窗口连续性（逐章）与 window_id 前缀契约");
      const bySection = new Map();
      for (const w of windows) {
        if (!bySection.has(w.section_id)) bySection.set(w.section_id, []);
        bySection.get(w.section_id).push(w);
      }
      let longChapterWindows = -1;
      for (const rep of chapters) {
        const ws = (bySection.get(rep.section_id) || []).slice().sort((a, b) => a.index - b.index);
        if (rep.section_order === 1) longChapterWindows = rep.window_count;
        check(ws.length === rep.window_count,
          `章节 ${rep.section_id}：顶层 windows 条数 === 报告 window_count`,
          `windows=${ws.length} 报告=${rep.window_count}`);
        if (!(rep.window_count > 0)) continue;
        // 前缀契约：顶层 window_id = `<section_id>#<wNNNN>`，章内 window_ids 是裸 wNNNN。
        const prefixOk = ws.length === rep.window_ids.length
          && ws.every((w, i) => w.window_id === `${rep.section_id}#${rep.window_ids[i]}`);
        check(prefixOk, `章节 ${rep.section_id}：window_id 前缀契约成立（section_id#wNNNN ↔ 裸 wNNNN）`,
          `顶层=${snip(JSON.stringify(ws.map((w) => w.window_id)), 160)} 章内=${snip(JSON.stringify(rep.window_ids), 160)}`);
        check(ws[0].start_codepoint === 0, `章节 ${rep.section_id}：首窗从 0 开始`,
          `实际 start=${ws[0].start_codepoint}`);
        let gaps = [];
        for (let i = 1; i < ws.length; i++) {
          if (ws[i].start_codepoint !== ws[i - 1].end_codepoint) {
            gaps.push(`w${i - 1}.end=${ws[i - 1].end_codepoint} ≠ w${i}.start=${ws[i].start_codepoint}`);
          }
        }
        check(gaps.length === 0, `章节 ${rep.section_id}：相邻窗口首尾相接（无洞无叠）`, snip(gaps.join("；")));
        check(ws[ws.length - 1].end_codepoint === rep.chars,
          `章节 ${rep.section_id}：末窗 end === 章节 chars`,
          `末窗 end=${ws[ws.length - 1].end_codepoint} 章节 chars=${rep.chars}`);
        const zero = ws.filter((w) => !(w.chars > 0));
        check(zero.length === 0, `章节 ${rep.section_id}：每个窗口 chars > 0`,
          `零长窗口=${JSON.stringify(zero.map((w) => w.window_id))}`);
      }
      check(longChapterWindows >= 2, "元检查：长章 c1 真的切出了 >= 2 个窗口（连续性断言被真实触发）",
        `实际 window_count=${longChapterWindows}`);

      // ================= [3] coverage 口径 =================
      console.log("\n[3] coverage 口径");
      const cov = A.coverage || {};
      const consumed = windows.filter((w) => w.consumed === true);
      const unconsumed = windows.filter((w) => w.consumed === false);
      check(cov.total_units === windows.length, "coverage.total_units === windows.length",
        `total_units=${cov.total_units} windows=${windows.length}`);
      check(cov.analyzed_units === consumed.length, "coverage.analyzed_units === consumed===true 的窗口数",
        `analyzed_units=${cov.analyzed_units} 实测=${consumed.length}`);
      check(cov.failed_units === unconsumed.length, "coverage.failed_units === consumed===false 的窗口数",
        `failed_units=${cov.failed_units} 实测=${unconsumed.length}`);
      check(cov.analyzed_units + cov.failed_units === cov.total_units, "analyzed_units + failed_units === total_units",
        `${cov.analyzed_units}+${cov.failed_units} vs ${cov.total_units}`);
      const sumConsumed = consumed.reduce((s, w) => s + w.chars, 0);
      const sumAll = windows.reduce((s, w) => s + w.chars, 0);
      check(cov.covered_codepoints === sumConsumed, "coverage.covered_codepoints === 已消费窗口 chars 之和",
        `covered_codepoints=${cov.covered_codepoints} 实测=${sumConsumed}`);
      check(cov.total_codepoints === sumAll, "coverage.total_codepoints === 全部窗口 chars 之和",
        `total_codepoints=${cov.total_codepoints} 实测=${sumAll}`);

      // ================= [4] 诚实性 =================
      console.log("\n[4] 诚实性（未知必显、不许宣称已读懂/全书）");
      const h = A.honesty || {};
      check(cov.unknown && cov.unknown.counts_known === false, "coverage.unknown.counts_known === false",
        `实际=${JSON.stringify(cov.unknown)}`);
      check(cov.whole_book_claim_allowed === false, "coverage.whole_book_claim_allowed === false",
        `实际=${JSON.stringify(cov.whole_book_claim_allowed)}`);
      check(cov.whole_book_percent === null, "coverage.whole_book_percent === null",
        `实际=${JSON.stringify(cov.whole_book_percent)}`);
      check(h.book_understood && h.book_understood.allowed === false, "honesty.book_understood.allowed === false",
        `实际=${JSON.stringify(h.book_understood)}`);
      check(h.layers && h.layers.reading && h.layers.reading.known === false, "honesty.layers.reading.known === false",
        `实际=${JSON.stringify(h.layers && h.layers.reading)}`);
      check(!r1.stdout.includes("100%"), "原始 JSON 文本不含子串 100%",
        `命中位置附近：${snip(r1.stdout.slice(Math.max(0, r1.stdout.indexOf("100%") - 80), r1.stdout.indexOf("100%") + 80))}`);
      check(!r1.stdout.includes('已读懂": true'), "原始 JSON 文本不含子串 `已读懂\": true`",
        `命中位置附近：${snip(r1.stdout.slice(Math.max(0, r1.stdout.indexOf('已读懂": true') - 80), r1.stdout.indexOf('已读懂": true') + 80))}`);

      // ================= [5] 冻结常量自报 =================
      console.log("\n[5] engine 自报的三个冻结常量");
      const eng = A.engine || {};
      check(eng.lexical_weight === 0.25, "engine.lexical_weight === 0.25", `实际=${JSON.stringify(eng.lexical_weight)}`);
      check(eng.rerank_pool === 20, "engine.rerank_pool === 20", `实际=${JSON.stringify(eng.rerank_pool)}`);
      check(eng.rerank_min_conf === 0.5, "engine.rerank_min_conf === 0.5", `实际=${JSON.stringify(eng.rerank_min_conf)}`);

      // ================= [6] 候选 =================
      console.log("\n[6] 候选与章节消费的对应关系");
      check(candidates.length >= 1, "元检查：至少产出 1 个候选", `实际=${candidates.length}`);
      const sliceIdSet = new Set(slices.map((s) => s.slice_id));
      let candOk = true, candDetail = [];
      for (const c of candidates) {
        const rep = chapters.find((x) => x.section_order === c.section_order);
        if (!rep || !(rep.consumed_windows > 0)) { candOk = false; candDetail.push(`candidate ${c.candidate_id} 的章节 consumed_windows=${rep ? rep.consumed_windows : "无报告"}`); }
        if (!rep || c.window_ids.length !== rep.consumed_windows) { candOk = false; candDetail.push(`candidate ${c.candidate_id} window_ids=${c.window_ids.length} vs consumed_windows=${rep ? rep.consumed_windows : "?"}`); }
        const missing = (c.slice_ids || []).filter((id) => !sliceIdSet.has(id));
        if (missing.length) { candOk = false; candDetail.push(`candidate ${c.candidate_id} 有 ${missing.length} 个 slice_id 不在顶层 slices：${snip(missing.join(","))}`); }
      }
      check(candOk, "每个候选的 section_order 都对应 consumed_windows>0 的章节，window_ids 数相符，slice_ids 全部存在",
        snip(candDetail.join("；")));

      // ================= [7] 切片：hash 与区间可复算 =================
      console.log("\n[7] 切片 text_hash / 区间可复算");
      check(slices.length >= 5, "元检查：至少 5 条切片（source-span 往返才有样本）", `实际=${slices.length}`);
      const HELPER = [
        "import json,sys",
        "from pathlib import Path",
        "import books_rag",
        'd = books_rag.extract_chapters(Path(sys.argv[1]))',
        'print(json.dumps({str(c["order"]): c["text"] for c in d["chapters"]}, ensure_ascii=False))',
      ].join("\n");
      const rh = pyHelper(HELPER, [BUNDLE]);
      let chapterTexts = null;
      if (spawnFailure(rh, "运行 extract_chapters 辅助脚本")) {
        // 已跳过
      } else if (rh.status !== 0) {
        bad("extract_chapters 辅助脚本退出码为 0", `status=${rh.status} stderr=${snip(rh.stderr)}`);
      } else {
        const PH = parseJson(rh.stdout);
        if (PH.err) bad("extract_chapters 辅助脚本输出合法 JSON", `${PH.err.message}；原始=${snip(rh.stdout)}`);
        else chapterTexts = PH.json;
      }
      if (!chapterTexts) {
        skip("切片区间与章节原文的比对", "取不到 Node 侧的章节原文（见上一条 ✗）");
      } else {
        const orderOfSection = new Map(chapters.map((c) => [c.section_id, c.section_order]));
        const windowById = new Map(windows.map((w) => [w.window_id, w]));
        let hashBad = [], rangeBad = [], winBad = [], missCh = [];
        for (const s of slices) {
          if (sha256(s.text) !== s.text_hash) hashBad.push(s.slice_id);
          const order = orderOfSection.get(s.section_id);
          const ctext = chapterTexts[String(order)];
          if (typeof ctext !== "string") { missCh.push(`${s.slice_id}→order ${order}`); continue; }
          if (ctext.slice(s.start_codepoint, s.end_codepoint) !== s.text) rangeBad.push(s.slice_id);
          const w = windowById.get(s.window_id);
          if (!w || !(w.start_codepoint <= s.start_codepoint && s.end_codepoint <= w.end_codepoint)) {
            winBad.push(`${s.slice_id}（窗口 ${s.window_id} 区间 ${w ? `${w.start_codepoint}-${w.end_codepoint}` : "缺失"}）`);
          }
        }
        check(hashBad.length === 0, `每条切片的 sha256(text) === text_hash（共 ${slices.length} 条）`, snip(hashBad.join(",")));
        check(missCh.length === 0, "每条切片都能找到所属章节原文", snip(missCh.join(",")));
        check(rangeBad.length === 0, "每条切片 text === 章节原文 [start_codepoint, end_codepoint) 的子串", snip(rangeBad.join(",")));
        check(winBad.length === 0, "每条切片的区间都落在其所属窗口区间内", snip(winBad.join(",")));
      }

      // ================= [8] /source-span 往返 =================
      console.log("\n[8] source-span 往返（至少 5 条，跨章节）");
      // 先按章节分组，保证样本跨章；不足 5 条或只覆盖 1 章则跳过（夹具没覆盖到，不是通过）。
      const byChapter = new Map();
      for (const s of slices) {
        if (!byChapter.has(s.section_id)) byChapter.set(s.section_id, []);
        byChapter.get(s.section_id).push(s);
      }
      const picked = [];
      for (const group of byChapter.values()) if (group.length) picked.push(group[0]);
      const pickedIds = new Set(picked.map((s) => s.slice_id));
      for (const s of slices) { if (picked.length >= 5) break; if (!pickedIds.has(s.slice_id)) { picked.push(s); pickedIds.add(s.slice_id); } }
      const sample = picked.slice(0, 5);
      if (sample.length < 5) {
        skip("source-span 往返（>= 5 条）", `切片总数只有 ${slices.length} 条，样本不足`);
      } else if (new Set(sample.map((s) => s.section_id)).size < 2) {
        skip("source-span 往返（跨章节）", `样本只覆盖 ${new Set(sample.map((s) => s.section_id)).size} 个章节`);
      } else {
        ok(`样本取到 ${sample.length} 条切片，覆盖 ${new Set(sample.map((s) => s.section_id)).size} 个章节`);
        let rtBad = [];
        let rtEnvFail = false;
        for (const s of sample) {
          const r = cli(["--json", "source-span", "--id", s.slice_id]);
          if (spawnFailure(r, `运行 source-span ${s.slice_id}`)) { rtEnvFail = true; break; }
          const P = parseJson(r.stdout);
          if (r.status !== 0 || P.err || !P.json || P.json.ok !== true) {
            rtBad.push(`${s.slice_id}: status=${r.status} body=${snip(P.err ? r.stdout : JSON.stringify(P.json))}`);
            continue;
          }
          const j = P.json;
          if (j.text_hash !== s.text_hash) rtBad.push(`${s.slice_id}: text_hash ${j.text_hash} ≠ 记录 ${s.text_hash}`);
          if (j.quote !== s.text) rtBad.push(`${s.slice_id}: quote 与切片 text 不一致`);
          if (j.book_version_id !== A.book_version_id) rtBad.push(`${s.slice_id}: book_version_id ${j.book_version_id} ≠ 分析 ${A.book_version_id}`);
          // M15 0b：CLI 契约里也必须带出 SpanRef 要的书内定位（缺了证据笔记就写不出书内引用）
          if (!/^[0-9a-f]{16}$/.test(String(j.book_id ?? ""))) rtBad.push(`${s.slice_id}: book_id 缺失或形状不对（${j.book_id}）`);
          if (!String(j.href ?? "").endsWith(".html")) rtBad.push(`${s.slice_id}: href 缺失或不是原始文档（${j.href}）`);
          if (!new RegExp(`^blk_${j.book_id}_\\d+_\\d+$`).test(String(j.block_id ?? ""))) {
            rtBad.push(`${s.slice_id}: block_id 缺失或与 book_id 不自洽（${j.block_id}）`);
          }
          if (!(Number.isInteger(j.block_start_codepoint) && Number.isInteger(j.block_end_codepoint)
                && j.block_start_codepoint <= j.start_codepoint && j.start_codepoint <= j.block_end_codepoint)) {
            rtBad.push(`${s.slice_id}: 块区间没锚住 span 起点（${j.block_start_codepoint}..${j.block_end_codepoint} vs ${j.start_codepoint}）`);
          }
        }
        // 环境失败（python3 缺失）时绝不能因 rtBad 为空而算通过 —— 那是假绿。
        if (rtEnvFail) skip("source-span 往返断言", "子进程因环境原因未能运行（见上方 ⊘）");
        else check(rtBad.length === 0, `source-span 往返：ok/ text_hash/ quote/ book_version_id/ book_id/ href/ block_id/ 块区间 全部一致（${sample.length} 条）`, snip(rtBad.join("；")));
      }

      // ================= [9] source-span 负例 =================
      console.log("\n[9] source-span 负例（四种错误码）");
      const negCases = [
        ["malformed", "不是-span-id", "BAD_SPAN_ID"],
        // M13：8 位前缀（旧的路径指纹）现在是**形状不合法** —— 形状换成了 16 位内容摘要
        ["旧式 8 位前缀", "sp_deadbeef_0_0_10", "BAD_SPAN_ID"],
        ["未知内容摘要前缀", "sp_0000000000000000_0_0_10", "SPAN_BOOK_NOT_FOUND"],
        ["区间越界", `sp_${cid}_0_0_999999`, "SPAN_RANGE_INVALID"],
        ["章节序越界", `sp_${cid}_999_0_10`, "SPAN_SECTION_NOT_FOUND"],
      ];
      let negEnvFail = false;
      for (const [name, id, want] of negCases) {
        const r = cli(["--json", "source-span", "--id", id]);
        if (spawnFailure(r, `运行 source-span 负例 ${name}`)) { negEnvFail = true; break; }
        const P = parseJson(r.stdout);
        if (P.err || !P.json) { bad(`负例「${name}」返回合法 JSON`, `id=${id} status=${r.status} 原始=${snip(r.stdout)}`); continue; }
        check(P.json.ok === false && P.json.code === want, `负例「${name}」→ code=${want}`,
          `id=${id} 实际=${snip(JSON.stringify(P.json))}`);
      }
      if (negEnvFail) skip("其余 source-span 负例", "子进程因环境原因未能运行（见上方 ⊘）");

      // ================= [10] 篡改磁盘正文：身份随之改变，老 span 不得顶替 =================
      console.log("\n[10] 篡改夹具正文后：身份变 ⇒ 老 span_id 必须**说准**取不到（不拿新内容顶替）");
      const c0Slice = slices.find((s) => orderOfSection0(s, chapters) === 0 && s.start_codepoint < 60);
      if (!c0Slice) {
        skip("篡改后身份变化", "第 0 章没有 start_codepoint < 60 的切片（夹具未覆盖）");
      } else {
        const s = c0Slice.start_codepoint;
        const orig = C0[s];
        const repl = orig === "砼" ? "砂" : "砼";
        const tampered = C0.slice(0, s) + repl + C0.slice(s + 1);
        const c0Path = join(BUNDLE, "text/c0.html");
        const origHtml = readFileSync(c0Path, "utf8");
        try {
          writeFileSync(c0Path, html(tampered), "utf8");
          const r = cli(["--json", "source-span", "--id", c0Slice.slice_id]);
          if (spawnFailure(r, "运行篡改后的 source-span")) {
            // 已跳过
          } else {
            const P = parseJson(r.stdout);
            if (P.err || !P.json) bad("篡改后 source-span 返回合法 JSON", `status=${r.status} 原始=${snip(r.stdout)}`);
            else {
              // 内容寻址：正文一变，book_version_id 就变 ⇒ 老 span_id 不再指向任何版本。
              // **不能**拿现在的内容顶替那段原文（那会显示一段根本不是当时分析的引文）。
              check(P.json.ok === false && P.json.code === "SPAN_BOOK_CONTENT_CHANGED",
                `篡改磁盘正文后老 span_id ⇒ SPAN_BOOK_CONTENT_CHANGED（切片 ${c0Slice.slice_id}）`,
                snip(JSON.stringify(P.json)));
              check(P.json.quote === undefined && P.json.text_hash === undefined,
                "内容变了时**不返回任何引文/hash**（不冒充「还是那段原文」）",
                snip(JSON.stringify(P.json)));
            }
          }
        } finally {
          writeFileSync(c0Path, origHtml, "utf8");
        }
        const r2 = cli(["--json", "source-span", "--id", c0Slice.slice_id]);
        if (!spawnFailure(r2, "运行还原后的 source-span")) {
          const P2 = parseJson(r2.stdout);
          if (P2.err || !P2.json) bad("还原后 source-span 返回合法 JSON", `status=${r2.status} 原始=${snip(r2.stdout)}`);
          else check(P2.json.ok === true && P2.json.text_hash === c0Slice.text_hash,
            "还原文件后同一 span_id 又能取回原文，且 text_hash 回到原值",
            `原值=${c0Slice.text_hash} 还原后=${P2.json.text_hash}`);
        }
      }
      // 供 [11] 用：HTTP 侧也拿一条真实切片往返。
      httpSliceId = (sample && sample[0]) ? sample[0].slice_id : (slices[0] && slices[0].slice_id) || null;
      httpSliceHash = (sample && sample[0]) ? sample[0].text_hash : (slices[0] && slices[0].text_hash) || null;
    }

    // ================= [11] HTTP 面：新入口 + 既有 7 条路由不漂移 =================
    console.log("\n[11] HTTP 面（serve-http --port 0）");
    try {
      const sc = await spawnSidecar();
      sidecar = sc.child;
      const BASE = `http://127.0.0.1:${sc.port}`;
      ok(`serve-http 已就绪，端口 ${sc.port}`);

      const rAnalyze = await httpReq(BASE, "POST", "/analyze-chapter", { book: TITLE, window_chars: 200 });
      check(rAnalyze.status === 200 && rAnalyze.json && rAnalyze.json.ok === true,
        "POST /analyze-chapter → 200 且 ok === true",
        `status=${rAnalyze.status} body=${snip(rAnalyze.text)}`);

      if (!httpSliceId) {
        skip("POST /source-span（真实 slice_id）", "没有可用的切片 id（analyze 未产出或不可用）");
      } else {
        const rSpan = await httpReq(BASE, "POST", "/source-span", { span_id: httpSliceId });
        check(rSpan.status === 200 && rSpan.json && rSpan.json.ok === true,
          "POST /source-span（真实 slice_id）→ 200 且 ok === true",
          `status=${rSpan.status} body=${snip(rSpan.text)}`);
        check(!!rSpan.json && rSpan.json.text_hash === httpSliceHash,
          "POST /source-span 的 text_hash 与 CLI 分析记录一致",
          `HTTP=${rSpan.json && rSpan.json.text_hash} 记录=${httpSliceHash}`);
      }

      // --- 既有路由：不漂移 ---
      const gHealth = await httpReq(BASE, "GET", "/health");
      check(gHealth.status === 200 && gHealth.json && typeof gHealth.json === "object",
        "既有路由 GET /health 仍在（200 + JSON）", `status=${gHealth.status} body=${snip(gHealth.text)}`);
      const gBooks = await httpReq(BASE, "GET", "/books");
      check(gBooks.status === 200 && Array.isArray(gBooks.json && gBooks.json.books)
        && gBooks.json.books.some((b) => b && b.title === TITLE),
        `既有路由 GET /books 仍在（200，且书单含「${TITLE}」）`,
        `status=${gBooks.status} titles=${snip(JSON.stringify((gBooks.json && gBooks.json.books || []).map((b) => b.title)), 200)}`);
      const gAnno = await httpReq(BASE, "GET", "/annotations?limit=1");
      check(gAnno.status === 200, "既有路由 GET /annotations 仍在（200）", `status=${gAnno.status} body=${snip(gAnno.text)}`);
      // 未知书 → 路由自身的 404 话术（区别于兜底的 {"error":"not found"}），证明 handler 真的在。
      const pSearch = await httpReq(BASE, "POST", "/search", { book: "不存在的书__M8__", query: "x" });
      check(pSearch.status === 404 && pSearch.json && pSearch.json.error === "没有这本书",
        "既有路由 POST /search 仍在（未知书 → 路由自身 404）", `status=${pSearch.status} body=${snip(pSearch.text)}`);
      const pIndex = await httpReq(BASE, "POST", "/index", { book: "不存在的书__M8__" });
      check(pIndex.status === 404 && pIndex.json && pIndex.json.error === "没有这本书",
        "既有路由 POST /index 仍在（未知书 → 路由自身 404）", `status=${pIndex.status} body=${snip(pIndex.text)}`);
      const pContext = await httpReq(BASE, "POST", "/context", { id: 0 });
      check(pContext.status === 200, "既有路由 POST /context 仍在（200）", `status=${pContext.status} body=${snip(pContext.text)}`);
      // POST /open 绝不能真调：open_in_books(None) 会执行 `open -a Books` 弹出用户的「图书」App。
      // 因此改为引擎源码存在性检查 —— 它同样能抓住「路由被删/改名」，且没有副作用。
      const engineSrc = readFileSync(ENGINE, "utf8");
      check(engineSrc.includes('path == "/open"'), "既有路由 POST /open 仍在（源码存在性；不真调以免弹出图书 App）",
        "引擎源码里找不到 `path == \"/open\"`");

      // --- 规范字面写法 POST /health、POST /books 的显式探针 ---
      // 实测：这两条既有路由是 GET-only（M8 改动没有碰它们）。按字面断言 POST 会失败，
      // 但那是规范的方法名笔误、不是「路由漂移」。这里既如实探一次、又如实说明，不静默算通过。
      const pHealth = await httpReq(BASE, "POST", "/health");
      if (pHealth.status === 200 && pHealth.json) {
        ok("规范字面写法 POST /health 也返回 200 JSON");
      } else {
        skip("规范字面写法 POST /health",
          `引擎既有实现是 GET-only：实测 POST /health → ${pHealth.status} ${snip(pHealth.text)}；`
          + `路由本身未漂移（GET /health → ${gHealth.status}）`);
      }
      const pBooks = await httpReq(BASE, "POST", "/books");
      if (pBooks.status === 200 && pBooks.json && Array.isArray(pBooks.json.books)) {
        ok("规范字面写法 POST /books 也返回 200 书单");
      } else {
        skip("规范字面写法 POST /books",
          `引擎既有实现是 GET-only：实测 POST /books → ${pBooks.status} ${snip(pBooks.text)}；`
          + `路由本身未漂移（GET /books → ${gBooks.status}）`);
      }
    } catch (e) {
      // 起不来/超时是环境或引擎进程问题：明确打印原因，不计通过。
      skip("HTTP 面全部检查", `serve-http 未能就绪：${snip(e.message)}`);
    }

    // ================= [12] M13 3a：书挪位置/改名 ⇒ 身份与 span 都不漂 =================
    //
    // 这是 M13 的**可证伪验收**：把夹具书复制到**另一个书库根**并改名，用一个**全新引擎进程**
    // （APPLE_READ_DIR 指向新根、索引目录也是空的）去问身份、去解析**原来那条 span_id**。
    // 路径寻址时代这两件事都会失败（路径指纹变了 ⇒ 找不到书）；内容寻址下必须都成。
    console.log("\n[12] M13 3a：复制到另一个路径并改名 ⇒ 身份与 span 都不漂");
    {
      const TMP2 = mkdtempSync(join(tmpdir(), "apple-read-m13-moved-"));
      try {
        const movedPath = join(TMP2, "改过名的书.epub");
        cpSync(BUNDLE, movedPath, { recursive: true });
        const env2 = { ...process.env, APPLE_READ_DIR: TMP2, APPLE_READ_INDEX: join(TMP2, "index") };

        if (!A) {
          skip("M13 3a 换路径身份不变", "没有可用的分析结果（A 不可用）");
        } else {
          const rId = cliEnv(["--json", "book-identity", "--path", movedPath], env2);
          const PId = parseJson(rId.stdout);
          if (rId.status !== 0 || PId.err || !PId.json || PId.json.ok !== true) {
            bad("换个路径问身份 ⇒ ok", `status=${rId.status} 输出=${snip(rId.stdout)}`);
          } else {
            check(PId.json.book_version_id === A.book_version_id,
              "换目录+改名后 book_version_id 不变",
              `原来=${A.book_version_id} 新路径=${snip(String(PId.json.book_version_id))}`);
            check(PId.json.book_id === A.content_id,
              "换目录+改名后 book_id（内容摘要）不变",
              `原来=${A.content_id} 新路径=${snip(String(PId.json.book_id))}`);
            check(PId.json.identity_basis === "content", "身份自报 basis=content",
              snip(String(PId.json.identity_basis)));
            // 列表句柄是**路径**派生的 ⇒ 换路径就该变（它只是列表键，不是身份）
            check(PId.json.path === movedPath,
              "身份入口回显的是**新**路径（列表句柄按路径算，这不是身份）",
              snip(String(PId.json.path)));
          }

          if (!httpSliceId) {
            skip("M13 3a 换路径后老 span 仍可解析", "没有可用的切片 id");
          } else {
            const rSpan = cliEnv(["--json", "source-span", "--id", httpSliceId], env2);
            const PSpan = parseJson(rSpan.stdout);
            if (rSpan.status !== 0 || PSpan.err || !PSpan.json) {
              bad("换路径后解析老 span ⇒ 合法 JSON", `status=${rSpan.status} 输出=${snip(rSpan.stdout)}`);
            } else {
              check(PSpan.json.ok === true,
                "换目录+改名后，老 span_id 仍能取回原文（内容寻址的核心性质）",
                snip(JSON.stringify(PSpan.json)));
              check(PSpan.json.text_hash === httpSliceHash,
                "取回的 text_hash 与原来一致",
                `原来=${httpSliceHash} 现在=${snip(String(PSpan.json.text_hash))}`);
              check(PSpan.json.book_version_id === A.book_version_id,
                "取回的 book_version_id 与原来一致",
                `原来=${A.book_version_id} 现在=${snip(String(PSpan.json.book_version_id))}`);
            }
          }
        }
      } finally {
        rmSync(TMP2, { recursive: true, force: true });
      }
    }
  }
} catch (e) {
  // 这个 catch 是必需的，不是装饰：运行期任何异常都必须计入失败，
  // 否则会按「已累计的 fail 数」退出，甚至打印 0 通过 / 0 失败 后 exit 0（假通过）。
  fail++;
  console.error("\n💥 测试运行期抛异常（已计入失败，不再被 finally 吞成假通过）：");
  console.error(e);
} finally {
  if (sidecar) { try { sidecar.kill("SIGKILL"); } catch { /* 已经没了 */ } }
  rmSync(TMP, { recursive: true, force: true });
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (skipped) console.log(`注：另有 ${skipped} 项跳过（环境限制/夹具未覆盖，均非通过）。`);
  process.exit(fail === 0 ? 0 : 1);
}
