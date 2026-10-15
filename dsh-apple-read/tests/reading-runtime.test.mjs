/**
 * tests/reading-runtime.test.mjs · M6 接线层 / runtime.js + lib/index.js 的 inject
 *
 * ## 这份测试在防什么
 *
 * M6 是**接线**里程碑，最容易出的不是算错，而是**接了个假的**：
 *   · `inject` 忘了声明 `sessionQuery` ⇒ 插件在真宿主上根本不装载，却没人发现
 *   · 服务不在时不是明确报错，而是崩掉整个插件（把面板/检索/SSE 一起带走）
 *   · 直接 `ctx.sessionQuery` 访问 ⇒ cordis 抛 "without inject"
 *   · 写盘根设错（复用伴读会话目录）⇒ 知识被写进错的地方；越界写没被拦
 *   · 把「没读到」显示成 0（覆盖单元、书籍数）—— 规范 §4 明确禁止
 *   · 九项能力缺后端却报 `ok:true`（假装读到了）
 *   · 提示词摘要超预算 / 把完整会话塞进提示词
 *
 * ## 每条检查「在什么情况下会失败」
 *   [0]  模块形状        — 导出面/六区顺序/常量一旦偏离规范 §4 就失败
 *   [1]  知识库目录      — 复用 DEFAULT_READING_DIR、或优先级写反（env 不生效）立刻失败
 *   [2]  索引六区解析    — 缺/重/错序/嵌套/未配对任一放过（writable 仍 true）立刻失败
 *   [3]  提示词预算      — trimToBudget 不截断、或截断后仍超预算立刻失败
 *   [4]  只读投影        — 真临时知识库上各投影形状/计数不对立刻失败
 *   [5]  未知≠0          — 覆盖单元未知时给数字、或 counts_known 撒谎立刻失败
 *   [6]  能力诚实        — readSourceSpan 报 ready（其实没后端）、或能力清单缺项立刻失败
 *   [7]  服务缺失降级    — sessionQuery 不在时不报 HOST_UNSUPPORTED、或抛出去立刻失败
 *   [8]  替身忠实性元检查 — 替身退化（缺方法/服务缺失）必须被识破，不能「看起来能用」
 *   [9]  写盘越界守卫    — 写盘根不是 bookKbDir、或越界路径不被 realpath+isInside 拦下立刻失败
 *   [10] inject 声明     — index.js 少声明 sessionQuery、或直接访问 ctx.sessionQuery 立刻失败
 *   [11] 提示词不塞会话  — 摘要里出现会话正文/完整 prompt 立刻失败
 *   [12] 无法离线验证    — 显式跳过（三分处理），不算通过
 *
 * 跑法：node tests/reading-runtime.test.mjs
 *
 * 被测文件路径可用环境变量覆盖（变异测试把改坏的副本写到临时目录）：
 *   READING_RUNTIME   → runtime.js
 *   READING_INDEX_JS  → lib/index.js
 */
import { existsSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNTIME_PATH = process.env.READING_RUNTIME ?? join(HERE, "..", "lib", "reading", "runtime.js");
const INDEX_PATH = process.env.READING_INDEX_JS ?? join(HERE, "..", "lib", "index.js");

let pass = 0, fail = 0, skipped = 0;
const ok = (m) => { pass++; console.log("  ✓ " + m); };
const bad = (m, d) => { fail++; console.log("  ✗ " + m + (d ? "\n      " + d : "")); };
const skip = (m, why) => { skipped++; console.log("  ⊘ 跳过 " + m + " —— " + why); };
const is = (m, got, want) => (got === want ? ok(m) : bad(m, `得到 ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}`));
const truthy = (m, v) => (v ? ok(m) : bad(m, `得到 ${JSON.stringify(v)}，期望真值`));
const falsy = (m, v) => (!v ? ok(m) : bad(m, `得到 ${JSON.stringify(v)}，期望假值`));

const rt = await import(RUNTIME_PATH);
const {
  RUNTIME_VERSION, INDEX_ZONES, PROMPT_SUMMARY_MAX_CHARS, BOOK_KB_DIR_ENV,
  indexMarkers, resolveBookKbDir, parseIndexZones, trimToBudget, createReadingRuntime,
} = rt;

// M10 收口 A：默认根常量已从 file-service.js 上移到域层 book-domain.js。
const { DEFAULT_KNOWLEDGE_ROOT } = await import(join(dirname(RUNTIME_PATH), "book-domain.js"));
const { createSessionQueryDouble, sampleSessions } = await import("./fakes/session-query-double.mjs");

// =========================================================================== //
console.log("\n[0] 模块形状与规范 §4 的六个区");

is("RUNTIME_VERSION", typeof RUNTIME_VERSION, "string");
is("六区恰好六个", INDEX_ZONES.length, 6);
is("六区顺序 = 规范 §4 表格顺序", INDEX_ZONES.join(","), "books,evidence,recommendations,proposals,maintenance,health");
is("标记串字面形状", indexMarkers("books").start, "<!-- reading-index:books:start -->");
is("标记串字面形状（end）", indexMarkers("books").end, "<!-- reading-index:books:end -->");
truthy("导出了 resolveBookKbDir", typeof resolveBookKbDir === "function");
truthy("导出了 parseIndexZones", typeof parseIndexZones === "function");
truthy("导出了 trimToBudget", typeof trimToBudget === "function");
truthy("导出了 createReadingRuntime", typeof createReadingRuntime === "function");
is("环境变量名不与伴读会话目录共用", BOOK_KB_DIR_ENV, "APPLE_READ_BOOK_KB_DIR");
falsy("环境变量名不是伴读会话那个", /READING_DIR/.test(BOOK_KB_DIR_ENV));

// =========================================================================== //
console.log("\n[1] 书籍知识库目录解析（env > 设置 > 默认）");

const ENV_DIR = "/tmp/kb-from-env";
const SET_DIR = "/tmp/kb-from-settings";
{
  const r1 = resolveBookKbDir({ bookKbDir: SET_DIR }, { [BOOK_KB_DIR_ENV]: ENV_DIR });
  is("env 优先于设置项", r1.path, ENV_DIR);
  is("并标出来源", r1.source, "env");

  const r2 = resolveBookKbDir({ bookKbDir: SET_DIR }, {});
  is("没有 env 时用设置项", r2.path, SET_DIR);
  is("来源标 settings", r2.source, "settings");

  const r3 = resolveBookKbDir({}, {});
  is("都没有时用 M1 默认根", r3.path, DEFAULT_KNOWLEDGE_ROOT);
  is("来源标 default", r3.source, "default");
  truthy("默认根就是 45-书籍", /45-书籍$/.test(r3.path));
  // 这条是本里程碑的硬要求：**不得**复用伴读会话归拢目录
  falsy("默认根不是伴读会话目录", /读书会话/.test(r3.path));

  const r4 = resolveBookKbDir({ bookKbDir: "   " }, { [BOOK_KB_DIR_ENV]: "  " });
  is("空白值不当路径", r4.path, DEFAULT_KNOWLEDGE_ROOT);

  const r5 = resolveBookKbDir({ bookKbDir: "/x" }, { [BOOK_KB_DIR_ENV]: "~/kb" });
  is("env 里的 ~/ 原样交给 file-service（不在这里展开）", r5.path, "~/kb");
}

// =========================================================================== //
console.log("\n[2] 索引六区解析（规范 §4 的五条硬规则）");

const zone = (z, body) => `<!-- reading-index:${z}:start -->\n${body}\n<!-- reading-index:${z}:end -->`;
const goodIndex = INDEX_ZONES.map((z) => zone(z, z + "-内容")).join("\n\n");
{
  const g = parseIndexZones(goodIndex);
  truthy("合法索引 ⇒ ok", g.ok);
  truthy("合法索引 ⇒ writable（允许自动写入）", g.writable);
  is("六个区都配成对", g.zones.filter((z) => z.paired).length, 6);
  is("无问题", g.problems.length, 0);

  const missing = parseIndexZones(goodIndex.replace("<!-- reading-index:evidence:end -->", ""));
  falsy("缺 end ⇒ 不可写", missing.writable);
  truthy("并精确报 MARKER_MISSING/evidence",
    missing.problems.some((p) => p.code === "MARKER_MISSING" && p.zone === "evidence"));
  truthy("不可写时给原因", typeof missing.reason === "string" && missing.reason.length > 0);

  const dup = parseIndexZones(goodIndex.replace("<!-- reading-index:books:start -->", "<!-- reading-index:books:start --><!-- reading-index:books:start -->"));
  falsy("重复 start ⇒ 不可写", dup.writable);
  truthy("报 MARKER_DUPLICATE", dup.problems.some((p) => p.code === "MARKER_DUPLICATE" && p.zone === "books"));

  const swapped = parseIndexZones(zone("books", "x").replace(
    /(<!-- reading-index:books:start -->)\n(x)\n(<!-- reading-index:books:end -->)/,
    "$3\n$2\n$1"));
  falsy("start 在 end 之后 ⇒ 不可写", swapped.writable);
  truthy("报 MARKER_OUT_OF_ORDER", swapped.problems.some((p) => p.code === "MARKER_OUT_OF_ORDER"));

  // 错序：把 books 整块挪到 evidence 后面
  const blocks = INDEX_ZONES.map((z) => zone(z, z));
  const reordered = [blocks[1], blocks[0], ...blocks.slice(2)].join("\n\n");
  const ro = parseIndexZones(reordered);
  falsy("区顺序颠倒 ⇒ 不可写", ro.writable);
  truthy("报 ZONE_OUT_OF_ORDER", ro.problems.some((p) => p.code === "ZONE_OUT_OF_ORDER"));

  // 嵌套：把 evidence 整块塞进 books 里（evidence 自己那块必须去掉，否则是「重复」而不是「嵌套」）
  const nested = INDEX_ZONES.filter((z) => z !== "evidence")
    .map((z) => zone(z, z === "books" ? `books\n${zone("evidence", "e")}` : z)).join("\n\n");
  const ne = parseIndexZones(nested);
  falsy("区块嵌套 ⇒ 不可写", ne.writable);
  truthy("报 ZONE_NESTED", ne.problems.some((p) => p.code === "ZONE_NESTED"));

  const empty = parseIndexZones("");
  falsy("空文本 ⇒ 不可写", empty.writable);
  is("空文本六个区都缺", empty.zones.filter((z) => !z.paired).length, 6);

  const nan = parseIndexZones(null);
  falsy("非字符串输入不崩且不可写", nan.writable);
}

// =========================================================================== //
console.log("\n[3] 提示词预算");

is("预算是有限正整数", PROMPT_SUMMARY_MAX_CHARS > 0 && Number.isInteger(PROMPT_SUMMARY_MAX_CHARS), true);
is("短文本原样返回", trimToBudget("abc", 10), "abc");
is("正好等于上限不截断", trimToBudget("x".repeat(10), 10).length, 10);
{
  const long = trimToBudget("x".repeat(5000), 100);
  is("超长截到上限", long.length, 100);
  truthy("截断有省略号标记", long.endsWith("…"));
  const t = trimToBudget("y".repeat(99999));
  truthy("默认上限也被遵守", t.length <= PROMPT_SUMMARY_MAX_CHARS);
}
is("null 不崩", trimToBudget(null, 5), "");
is("undefined 不崩", trimToBudget(undefined, 5), "");

// =========================================================================== //
console.log("\n[4] 只读投影（真临时知识库）");

const KB = mkdtempSync(join(tmpdir(), "ab-m6-kb-"));
const H64 = "b".repeat(64);
function bookNote(id, title) {
  return `---\nschema_version: '1.1'\nobject_type: book\nid: ${id}\nrevision: 1\ntitle: ${title}\n`
    + `tags:\n- reading\nscope: reading\nknowledge_status: active\n`
    + `created_at: '2026-10-10T00:00:00.000Z'\nupdated_at: '2026-10-10T00:00:00.000Z'\n`
    + `book_id: ${id}\nauthor: 测试作者\nbook_version_id: bv-${id}\ncontent_hash: ${H64}\n`
    + `parser_version: '1.0.0'\nnormalization_version: '1.0.0'\nsource_assets: []\n`
    + `source_page_ref: 40-来源/测试.md\n`
    + `external_master:\n  status: unverified\n  outcome: not_checked\n  check_id: ext-1\n`
    + `  scope_refs: []\n  checked_at: null\n  authorization_revision: '1'\n  candidate_refs: []\n  ref: null\n`
    + `dedup_check_ref: dedup-1\n---\n\n# ${title}\n\n正文（不得进提示词摘要）。\n`;
}
mkdirSync(join(KB, "书籍"), { recursive: true });
mkdirSync(join(KB, "待确认"), { recursive: true });
mkdirSync(join(KB, ".state"), { recursive: true });     // 必须被跳过
writeFileSync(join(KB, "索引.md"), `---\nschema_version: '1.1'\nobject_type: index\nid: idx-1\nrevision: 1\n`
  + `title: 索引\ntags:\n- index\n- reading\nscope: reading\nknowledge_status: active\n`
  + `created_at: '2026-10-10T00:00:00.000Z'\nupdated_at: '2026-10-10T00:00:00.000Z'\n`
  + `index_generation:\n  mode: manual_seed\n  generated_at: '2026-10-10T00:00:00.000Z'\n  source_digest: null\n`
  + `---\n\n# 索引\n\n${goodIndex}\n`);
writeFileSync(join(KB, "书籍", "测试书.md"), bookNote("book-fixture-1", "测试书"));
writeFileSync(join(KB, "书籍", "坏书.md"), "---\nobject_type: book\nid: broken-1\n---\n\n没有必填字段。\n");
writeFileSync(join(KB, "书籍", "没法解析.md"), "没有 frontmatter 的纯文本。\n");
writeFileSync(join(KB, ".state", "不该被扫.md"), bookNote("hidden-1", "隐藏"));

const RTO = createReadingRuntime({ getSettings: () => ({ bookKbDir: KB }) });
{
  const h = await RTO.health();
  truthy("health ok", h.ok);
  is("health 的根 = bookKbDir", h.book_kb_dir.path, KB);
  truthy("health 报告知识库存在", h.book_kb_dir.exists === true);
  is("health 的写盘根 = 知识库根（realpath 归一，不是伴读会话目录）",
    h.file_service.writes_limited_to, realpathSync(KB));
  falsy("health 的写盘根不是读书会话", /读书会话/.test(h.file_service.writes_limited_to));
  is("schema 版本透出", h.schema_version, "1.1");
  truthy("覆盖单元未知被显式标出", h.honesty.zero_vs_unknown.coverage_units_known === false);

  const lib = await RTO.library();
  truthy("library ok", lib.ok);
  is("只算 formal 通过的书籍", lib.counts.book, 1);
  truthy("坏书进 invalid 而不是被静默丢掉", lib.invalid_notes.some((n) => n.rel === "书籍/坏书.md"));
  truthy("纯文本解析失败单独计数", lib.parse_failures.some((p) => p.rel === "书籍/没法解析.md"));
  falsy(".state 下的文件被扫进来", lib.books.some((b) => /隐藏/.test(b.title ?? "")) || lib.invalid_notes.some((n) => /state/.test(n.rel)));
  is("正式有效总数 = 1 书 + 1 索引", lib.counts.formal_valid_total, 2);

  const idx = await RTO.indexZones();
  truthy("indexZones ok", idx.ok);
  truthy("索引可写（标记合法）", idx.writable);
  is("读到六个区", idx.zones.length, 6);
  is("索引内容 hash 是 64 位 hex", idx.content_hash.length, 64);

  const cov = await RTO.coverage();
  truthy("coverage ok", cov.ok);
  is("覆盖单元未知", cov.units_known, false);
  is("analyzed_units 是 null（不是 0）", cov.report.coverage.analyzed_units, null);
  is("total_units 是 null（不是 0）", cov.report.coverage.total_units, null);
  is("units.total 也是 null", cov.report.units.total, null);
  truthy("三层都 known:false",
    cov.report.layers.extraction.known === false && cov.report.layers.analysis.known === false
    && cov.report.layers.reading.known === false);

  const rec = await RTO.recommendations();
  is("推荐运行计数为 0（真的没有）", rec.count, 0);
  truthy("并给真实空态文案", rec.empty_state?.message === "尚无已保存的推荐运行");
  const prop = await RTO.proposals();
  is("提案计数为 0", prop.count, 0);
  const mnt = await RTO.maintenance();
  is("维护待办为 0", mnt.pending_count, 0);

  const sc = await RTO.scanVault();
  is("扫描只数 Markdown 文件（4 个，.state 被跳过）", sc.markdown_seen, 4);
  truthy("by_object_type 与 formal 版本都给出", typeof sc.by_object_type.book === "number" && typeof sc.by_object_type_formal.book === "number");
  is("formal 版书籍计数 = 1", sc.by_object_type_formal.book, 1);
  is("全量版书籍计数 = 2（含坏书）", sc.by_object_type.book, 2);
}

// =========================================================================== //
console.log("\n[5] 未知与 0 必须分开（规范 §4）");

{
  const emptyKb = mkdtempSync(join(tmpdir(), "ab-m6-empty-"));
  const rtEmpty = createReadingRuntime({ getSettings: () => ({ bookKbDir: emptyKb }) });
  const cov = await rtEmpty.coverage();
  is("空库的覆盖仍是「未知」而不是 0", cov.units_known, false);
  is("空库 analyzed_units = null", cov.report.coverage.analyzed_units, null);
  const lib = await rtEmpty.library();
  is("空库书籍数 = 0（这是**真** 0）", lib.counts.book, 0);
  truthy("空库有真实空态文案", lib.empty_state?.message === "尚无书籍记录");
  const idx = await rtEmpty.indexZones();
  falsy("空库没有索引页 ⇒ 明确报错而不是假装可写", idx.ok);
  is("并给明确错误码", idx.code, "INDEX_NOT_FOUND");

  // 知识库目录不存在：如实报，不崩
  const missing = createReadingRuntime({ getSettings: () => ({ bookKbDir: join(emptyKb, "根本不存在") }) });
  const h = await missing.health();
  falsy("目录不存在时 health.ok=false", h.ok);
  is("并报出真实原因码", h.file_service.ok, false);
  truthy("原因码非空", typeof h.file_service.code === "string" && h.file_service.code.length > 0);
  rmSync(emptyKb, { recursive: true, force: true });
}

// =========================================================================== //
console.log("\n[6] 九项能力的诚实状态");

{
  const caps = RTO.capabilities();
  is("能力清单去重后 7 项（policy 4 + compiler 5，重叠 2）", caps.report.length, 7);
  const byName = Object.fromEntries(caps.report.map((c) => [c.name, c]));
  for (const n of ["readSourceSpan", "readKnowledge", "retrieve", "generateStructured"]) {
    truthy(`policy 能力 ${n} 在清单里`, !!byName[n]);
  }
  for (const n of ["readCheckedNote", "requestAdditionalCandidates", "readHostTurns"]) {
    truthy(`compiler 独有能力 ${n} 在清单里`, !!byName[n]);
  }
  // M8 起 readSourceSpan 接上了真实后端（引擎 /source-span）。这里没注入 sidecar 转发，
  // 所以它必须如实报 degraded —— 关键仍是「不许假装成功」。
  is("readSourceSpan 无 sidecar 时如实报 degraded", byName.readSourceSpan.status, "degraded");
  truthy("并说明原因", /sidecar/.test(byName.readSourceSpan.detail ?? ""));
  is("readKnowledge 有真实后端", byName.readKnowledge.status, "ready");
  is("readCheckedNote 有真实后端", byName.readCheckedNote.status, "ready");
  is("没有注入 sidecar 转发时 retrieve 报 degraded", byName.retrieve.status, "degraded");
  is("没有注入 LLM 时 generateStructured 报 degraded", byName.generateStructured.status, "degraded");
  truthy("policy 能力对象四键齐全",
    ["readSourceSpan", "readKnowledge", "retrieve", "generateStructured"].every((k) => typeof caps.policy[k] === "function"));
  truthy("compiler 能力对象五键齐全",
    ["readSourceSpan", "readCheckedNote", "requestAdditionalCandidates", "readHostTurns", "generateStructured"]
      .every((k) => typeof caps.compiler[k] === "function"));

  // readSourceSpan 必须**失败**而不是假装成功
  const span = await caps.policy.readSourceSpan("span-1");
  falsy("readSourceSpan 调用后 ok=false", span.ok);
  is("并给精确错误码", span.code, "SIDECAR_UNAVAILABLE");
  const span2 = await caps.policy.readSourceSpan("");
  falsy("空 span_id 也 ok=false", span2.ok);
  is("空 span_id 给 BAD_SPAN_ID", span2.code, "BAD_SPAN_ID");

  // retrieve 没注入转发时返回空数组（不抛），不假装有命中
  const hits = await caps.policy.retrieve("随便问问", {});
  is("retrieve 无后端时返回空数组", hits.length, 0);

  // readHostTurns 没有 sessionQuery 时必须失败
  const turns = await caps.compiler.readHostTurns({ session_id: "s1" });
  falsy("无 sessionQuery 时 readHostTurns.ok=false", turns.ok);
  is("并给 HOST_UNSUPPORTED", turns.code, "HOST_UNSUPPORTED");
  // 服务在、但入参缺 session_id ⇒ 走的是**参数校验**分支（须有服务才能到达）
  const rtWithQuery = createReadingRuntime({
    ctx: { get: (n) => (n === "sessionQuery" ? createSessionQueryDouble({ sessions: sampleSessions() }) : undefined) },
    getSettings: () => ({ bookKbDir: KB }),
  });
  const noSid = await rtWithQuery.capabilities().compiler.readHostTurns({});
  is("服务在、缺 session_id 时明确报 MISSING_REQUIRED", noSid.code, "MISSING_REQUIRED");
}

// =========================================================================== //
console.log("\n[7] 服务缺失时的降级（不许崩、不许假装）");

{
  // 一个「服务永远不在」的 ctx：get 返回 undefined（真 cordis 的 get 语义）
  const ctxNone = { get: () => undefined };
  const rtNone = createReadingRuntime({ ctx: ctxNone, getSettings: () => ({ bookKbDir: KB }) });
  const s = rtNone.sessionReader();
  falsy("sessionQuery 不在 ⇒ sessionReader.ok=false", s.ok);
  is("并给 HOST_UNSUPPORTED", s.code, "HOST_UNSUPPORTED");
  const h = await rtNone.health();
  falsy("health 如实报未注入", h.session_query.injected);
  truthy("并给原因", /sessionQuery/.test(h.session_query.message ?? ""));
  truthy("但知识库部分照常工作（不因会话服务缺失而全废）", h.ok === true && h.vault.markdown_seen === 4);

  // ctx 完全没有 get（比真 cordis 更糟）：也不能抛
  const rtNoGet = createReadingRuntime({ ctx: {}, getSettings: () => ({ bookKbDir: KB }) });
  const s2 = rtNoGet.sessionReader();
  falsy("ctx 没有 get 也不崩", s2.ok);
  is("仍报 HOST_UNSUPPORTED", s2.code, "HOST_UNSUPPORTED");

  // ctx.get 抛错（宿主实现异常）：要兜住并降级
  const rtThrow = createReadingRuntime({ ctx: { get() { throw new Error("boom"); } }, getSettings: () => ({ bookKbDir: KB }) });
  const s3 = rtThrow.sessionReader();
  falsy("ctx.get 抛错也不崩", s3.ok);
}

// =========================================================================== //
console.log("\n[8] 替身忠实性元检查（不忠实的替身必须被识破）");

{
  // 忠实替身：真会话 + 真服务，并记录它被调用了哪些契约方法
  const calls = [];
  const faithful = createSessionQueryDouble({ sessions: sampleSessions() });
  const rawPush = faithful.__calls.push.bind(faithful.__calls);
  faithful.__calls.push = (x) => { calls.push(x); return rawPush(x); };
  const ctxOk = { get: (n) => (n === "sessionQuery" ? faithful : undefined) };
  const rtOk = createReadingRuntime({ ctx: ctxOk, getSettings: () => ({ bookKbDir: KB }) });
  const s = rtOk.sessionReader();
  truthy("忠实替身下 sessionReader.ok=true", s.ok);
  const caps = rtOk.capabilities();
  const turns = await caps.compiler.readHostTurns({ session_id: "session-double-1" });
  truthy("忠实替身下 readHostTurns.ok=true", turns.ok);
  is("并给出 ready 的来源门槛", turns.source_gate, "ready");
  is("耐久上界来自替身的 revision", turns.durable_through_seq, 3);
  truthy("替身**真的被调用过**（不是被绕过）", calls.length > 0);
  truthy("调用的是 sessionQuery 的契约方法",
    calls.some((c) => /listSessions|readSession|listEvents|readSurface|observeSession/.test(String(c))));

  // 退化替身：缺 listEvents/readSurface（宿主能力不全）
  // 期望：**不假装 ready**——调用仍能返回，但来源门槛必须降级并把原因说清。
  const partial = createSessionQueryDouble({ sessions: sampleSessions(), mode: "missing-methods" });
  const rtPartial = createReadingRuntime({
    ctx: { get: (n) => (n === "sessionQuery" ? partial : undefined) },
    getSettings: () => ({ bookKbDir: KB }),
  });
  const t2 = await rtPartial.capabilities().compiler.readHostTurns({ session_id: "session-double-1" });
  truthy("能力不全的替身下调用不崩", t2.ok);
  falsy("但**不得**报 ready（surface 分类不可用必须显式降级）", t2.source_gate === "ready");
  is("降级状态是 partial", t2.source_gate, "partial");

  // 不忠实替身：listSessions 与 readSession 互相矛盾（声称有会话，却不在列表里）
  // 期望：被 reader 自己的存在性检查识破，**不得**当成可读来源。
  const fakeAlways = {
    listSessions: async () => [],
    readSession: async () => ({ session: { id: "ghost", createdAt: 0 }, inheritedEventCount: 0, events: [] }),
    listEvents: async () => [],
    readSurface: async () => ({ session: {}, events: [] }),
    filterEvents: async () => [],
    readEvent: async () => ({ session: {}, events: [] }),
    traceEvent: async () => ({}),
    observeSession: async () => ({
      source: "prepared", revision: "r", header: { id: "ghost" }, events: [],
      cursor: { seq: null }, retain() {}, [Symbol.dispose]() {},
    }),
  };
  const rtFake = createReadingRuntime({
    ctx: { get: (n) => (n === "sessionQuery" ? fakeAlways : undefined) },
    getSettings: () => ({ bookKbDir: KB }),
  });
  const t3 = await rtFake.capabilities().compiler.readHostTurns({ session_id: "ghost" });
  falsy("自相矛盾的替身必须让调用失败（不假装读到了）", t3.ok);
  is("并给 SOURCE_UNAVAILABLE", t3.code, "SOURCE_UNAVAILABLE");
  truthy("忠实替身对未知会话必须抛错（真宿主契约）",
    await (async () => { try { await faithful.readSession("根本不存在"); return false; } catch (e) { return e.code === "SESSION_NOT_FOUND"; } })());
}

// =========================================================================== //
console.log("\n[9] 写盘越界守卫（唯一写盘口 = file-service，根 = bookKbDir）");

{
  const fsOk = await RTO.fileService();
  truthy("file-service 可用", fsOk.ok);
  is("根就是 bookKbDir（realpath 归一）", fsOk.root, resolve(KB));
  truthy("capabilities 声明写盘被限定", typeof fsOk.svc.capabilities().writesLimitedTo === "string");

  // M1 的第一道守卫：normalizeRel 拒绝 `..` 语法与绝对路径
  let dotdot = false;
  let code = null;
  try {
    await fsOk.svc.resolveRel("../../外面.md");
  } catch (e) {
    dotdot = true;
    code = e?.code ?? null;
  }
  truthy("../../ 越界路径被拒绝（normalizeRel 语法守卫）", dotdot);
  truthy("并给越界错误码", typeof code === "string" && code.length > 0);

  let absRejected = false;
  try { await fsOk.svc.resolveRel("/etc/hosts"); } catch { absRejected = true; }
  truthy("绝对路径越界被拒绝", absRejected);

  // M1 的第二道守卫（**真正靠 isInside 的那道**）：realpath 之后必须仍在根内。
  // 语法检查拦不住符号链接逃逸，所以这里必须用真 symlink 打。
  // （早先只测 `..` 时，变异「isInside 恒真」抓不到——那道检查是假绿。）
  const OUT = mkdtempSync(join(tmpdir(), "ab-m6-outside-"));
  writeFileSync(join(OUT, "秘密.md"), "不该被 45-书籍 读到\n");
  symlinkSync(OUT, join(KB, "外链"), "dir");
  let symEscaped = false;
  try {
    await fsOk.svc.resolveRel("外链/秘密.md");
  } catch {
    symEscaped = true;
  }
  truthy("符号链接逃逸（realpath 后越界）被 isInside 拒绝", symEscaped);

  // 写盘同样必须被拦：越界写入不得落到根外
  let writeEscaped = false;
  let writeErr = null;
  try {
    await fsOk.svc.writeNote("外链/新文件.md", { data: { object_type: "book", id: "x", schema_version: "1.1" }, body: "越界" });
    writeEscaped = true;
  } catch (e) {
    writeErr = e?.code ?? null;
  }
  falsy("越界写入被拒绝（不许写到 45-书籍 之外）", writeEscaped);
  truthy("并给越界错误码", typeof writeErr === "string" && writeErr.length > 0);
  falsy("越界目标目录里没有新文件落地", existsSync(join(OUT, "新文件.md")));
  rmSync(OUT, { recursive: true, force: true });

  // 根内的相对路径要能正常解析（守卫不是「一律拒绝」）
  const inside = await fsOk.svc.resolveRel("书籍/测试书.md");
  truthy("根内路径可解析", /45-书籍|ab-m6-kb/.test(inside.abs) || inside.abs.startsWith(resolve(KB)));

  // runtime 自己不写盘：源码层面无写接口（延续 M2 只读纪律）
  const rtCode = readFileSync(RUNTIME_PATH, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  falsy("runtime 无写盘接口", /writeFile|appendFile|createWriteStream|mkdirSync/.test(rtCode));
}

// =========================================================================== //
console.log("\n[10] lib/index.js 的 inject 声明与访问方式");

{
  const idxCode = readFileSync(INDEX_PATH, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").map((l) => l.replace(/(^|[^:"'`\\])\/\/.*$/, "$1")).join("\n");
  truthy("inject 里声明了 sessionQuery（cordis 硬依赖）",
    /const inject = \[[^\]]*"sessionQuery"/.test(idxCode));
  truthy("inject 仍然保留 skills", /const inject = \[[^\]]*"skills"/.test(idxCode));
  falsy("没有直接访问 ctx.sessionQuery（否则 cordis 抛 without inject）",
    /ctx\.sessionQuery\b/.test(idxCode));
  truthy("接线走单一注入点 runtime.js", /reading\/runtime\.js/.test(idxCode));
  truthy("没有为阅读域另注册一条 webServer 路由（M0 的教训：多了注册点会顶掉面板路由）",
    (idxCode.match(/webServer\.register\(/g) ?? []).length === 1);
  truthy("bookKbDir 是独立设置项（不复用 readingDir）",
    /bookKbDir/.test(idxCode) && /readingDir/.test(idxCode));
  // 方案 B：路由必须把 `?path=` 透传下去，否则 runtime 那层再对也没用（接线断在路由上）。
  truthy("recommendations 路由把 ?path= 透传给 runtime（方案 B）",
    /reading\.recommendations\(\{\s*book_path:\s*q\.get\("path"\)\s*\}\)/.test(idxCode),
    (idxCode.match(/reading\.recommendations\([^)]*\)/g) ?? []).join(" | "));

  const mod = await import(INDEX_PATH);
  truthy("inject 是数组且含 sessionQuery", Array.isArray(mod.inject) && mod.inject.includes("sessionQuery"));
  truthy("BASE_PATH 仍是 /apple-read", mod.BASE_PATH === "/apple-read");
}

// =========================================================================== //
console.log("\n[11] 提示词摘要：预算内、不塞完整会话/正文");

{
  const rtP = createReadingRuntime({
    ctx: { get: (n) => (n === "sessionQuery" ? createSessionQueryDouble({ sessions: sampleSessions() }) : undefined) },
    getSettings: () => ({ bookKbDir: KB }),
  });
  const text = await rtP.promptSummary();
  truthy("摘要非空", text.length > 0);
  truthy(`摘要 ${text.length} ≤ 预算 ${PROMPT_SUMMARY_MAX_CHARS}`, text.length <= PROMPT_SUMMARY_MAX_CHARS);
  truthy("摘要说明是「已保存的阅读知识」", /已保存的阅读知识/.test(text));
  truthy("摘要明确覆盖情况未知（不吹读懂）", /覆盖情况未知|覆盖情况/.test(text));
  truthy("摘要给出正式有效条目数", /正式有效条目/.test(text));
  // 不得把知识库正文塞进来
  falsy("不含知识库正文", /正文（不得进提示词摘要）/.test(text));
  // 不得把会话内容塞进来
  falsy("不含会话正文", /我在读什么/.test(text));
  falsy("不含完整 prompt 片段", /你是「DSH-apple-Read」/.test(text));
  falsy("不含整段标注原文", /检索到的原文/.test(text));
  // 空库也要给得出话（不能是空串，否则模型以为没有约束）
  const rtEmpty = createReadingRuntime({ getSettings: () => ({ bookKbDir: mkdtempSync(join(tmpdir(), "ab-m6-p-")) }) });
  const t2 = await rtEmpty.promptSummary();
  truthy("空库摘要非空且说明没有索引/书籍", t2.length > 0 && /书库为空|没有索引|尚无/.test(t2));

  // 缓存读法必须与异步算出来的同源（宿主 systemPrompt.context 的 text 是同步的，
  // 所以插件只能读缓存——缓存与真值不一致就会把过期/错误的知识计数喂给模型）
  is("未刷新前缓存为空（不会凭空造一段摘要）", rtP.promptSummaryCached(), "");
  const refreshed = await rtP.refreshPromptSummary({ force: true });
  is("刷新后仍在预算内", refreshed.length <= PROMPT_SUMMARY_MAX_CHARS, true);
  is("缓存读法与异步结果一致", rtP.promptSummaryCached(), refreshed);
}

// =========================================================================== //
console.log("\n[13] 回归护栏：现有 7 个 MCP 工具签名不得漂移");

{
  // M6 只改宿主半端，**不碰** books_rag.py 的 MCP 工具。但「不碰」要靠检查保证：
  // 用户把这些工具当稳定接口用（Claude/面板/技能都按签名调用），签名一漂移就是
  // 静默破坏。这里逐条钉住名称 + 参数 + 默认值 + 返回注解。
  const PY = process.env.APPLE_READ_BOOKS_RAG ?? join(HERE, "..", "..", "books_rag.py");
  let py = null;
  try { py = readFileSync(PY, "utf8"); } catch { /* 下面按缺失处理 */ }
  if (!py) {
    skip("7 个 MCP 工具签名护栏", `读不到 ${PY}（本环境没有该文件）；护栏未生效，不得算通过`);
  } else {
    const toolDefs = [...py.matchAll(/@mcp\.tool\(\)\s*\n\s*def\s+(\w+)\s*\(([\s\S]*?)\)\s*->\s*(\w+):/g)]
      .map((m) => ({ name: m[1], params: m[2].replace(/\s+/g, " ").trim(), ret: m[3] }));
    const EXPECTED = [
      { name: "list_books", params: "", ret: "str" },
      { name: "search_book", params: "book: str, query: str, top_k: int = 5", ret: "str" },
      { name: "list_annotations", params: 'book: str = "", limit: int = 30', ret: "str" },
      { name: "recent_annotations", params: "limit: int = 10, book: str = \"\"", ret: "str" },
      { name: "get_annotation_context", params: "annotation_id: int, chars_before: int = 400, chars_after: int = 400", ret: "str" },
      { name: "index_book", params: "book: str", ret: "str" },
      { name: "open_in_books_app", params: 'book: str = ""', ret: "str" },
    ];
    is("MCP 工具恰好 7 个", toolDefs.length, 7);
    for (const want of EXPECTED) {
      const got = toolDefs.find((t) => t.name === want.name);
      truthy(`工具 ${want.name} 仍存在`, !!got);
      if (!got) continue;
      is(`${want.name} 参数签名不变`, got.params, want.params);
      is(`${want.name} 返回注解不变`, got.ret, want.ret);
    }
    is("工具名集合与期望一致（顺序也一致）",
      toolDefs.map((t) => t.name).join(","), EXPECTED.map((t) => t.name).join(","));
  }
}

// =========================================================================== //
console.log("\n[12] M8：逐章分析入口 / span 读取 / 分析→候选→rank→落盘（离线忠实替身）");

{
  const { sha256Hex } = await import(join(dirname(RUNTIME_PATH), "schema.js"));
  // M13：书的身份 = **内容摘要**（16 位 hex）；book_version_id = "bv_" + 摘要。
  // 夹具给一个**形状真实**的值：面板的 SPAN_ID_RE 要求 16 位，旧的 8 位会被判非法。
  const CID = "0123456789abcdef";
  const BVM = `bv_${CID}`;
  const s1Text = "上帝存在的证明是本书的核心论证，笛卡尔由此推出结论。";
  const s2Text = "灵魂与肉体之间的实在区别需要另行说明。";
  const slice = (id, order, start, text) => ({
    slice_id: id, section_id: `sec_${CID}_${order}`, window_id: `sec_${CID}_${order}#w0000`,
    start_codepoint: start, end_codepoint: start + text.length, text,
    text_hash: sha256Hex(text), quote_type: "sentence", truncated: false,
  });
  const SLICES = [slice(`sp_${CID}_0_0_30`, 0, 0, s1Text), slice(`sp_${CID}_1_0_22`, 1, 0, s2Text)];
  const ANALYSIS = {
    ok: true,
    analysis_version: "1.0.0",
    book: "M8 替身书",
    author: "替身作者",
    // 真引擎总是给 book_path（`str(bundle)`）；M13 起 book_id 由引擎给（content_id），
    // 插件**不再**从路径算 —— 所以这里必须给 content_id，而不是 path_hash8。
    book_path: "/tmp/替身书库/M8 替身书.epub",
    book_version_id: BVM,
    content_id: CID,
    identity_basis: "content",
    chapters: [
      { section_id: `sec_${CID}_0`, section_order: 0, title: "第一章", chars: s1Text.length,
        window_count: 1, plan_verified: true, consumed_windows: 1, failed_windows: 0,
        window_ids: ["w0000"], status: "analyzed", summary: s1Text, slice_ids: [SLICES[0].slice_id] },
      { section_id: `sec_${CID}_1`, section_order: 1, title: "第二章", chars: s2Text.length,
        window_count: 1, plan_verified: true, consumed_windows: 1, failed_windows: 0,
        window_ids: ["w0000"], status: "analyzed", summary: s2Text, slice_ids: [SLICES[1].slice_id] },
    ],
    windows: [
      { window_id: `sec_${CID}_0#w0000`, section_id: `sec_${CID}_0`, index: 0, start_codepoint: 0,
        end_codepoint: s1Text.length, chars: s1Text.length, text_hash: sha256Hex(s1Text),
        status: "processed", consumed: true, summary: s1Text, summary_hash: sha256Hex(s1Text),
        evidence: { verified: true }, failure_reason: null, queued: false, attempts: 1 },
      { window_id: `sec_${CID}_1#w0000`, section_id: `sec_${CID}_1`, index: 0, start_codepoint: 0,
        end_codepoint: s2Text.length, chars: s2Text.length, text_hash: sha256Hex(s2Text),
        status: "processed", consumed: true, summary: s2Text, summary_hash: sha256Hex(s2Text),
        evidence: { verified: true }, failure_reason: null, queued: false, attempts: 1 },
    ],
    slices: SLICES,
    candidates: [
      { candidate_id: `ca_${CID}_0`, section_id: `sec_${CID}_0`, section_order: 0, title: "第一章",
        summary: s1Text, slice_ids: [SLICES[0].slice_id], window_ids: [`sec_${CID}_0#w0000`],
        book_version_id: BVM, source_refs: [SLICES[0].slice_id],
        proposed_b: { score: 3, reason: "核心论证", basis: { kind: "book_analysis" } }, b_is_proposed: true },
      { candidate_id: `ca_${CID}_1`, section_id: `sec_${CID}_1`, section_order: 1, title: "第二章",
        summary: s2Text, slice_ids: [SLICES[1].slice_id], window_ids: [`sec_${CID}_1#w0000`],
        book_version_id: BVM, source_refs: [SLICES[1].slice_id],
        proposed_b: { score: 1, reason: "局部补充", basis: { kind: "book_analysis" } }, b_is_proposed: true },
    ],
    queue: { pending_window_ids: [], failed_window_ids: [], retry_requires_explicit_schedule: true },
    coverage: { scope: "parsed_body", total_units: 2, analyzed_units: 2, failed_units: 0,
      excluded_units: 0, excluded_reasons: [], covered_codepoints: s1Text.length + s2Text.length,
      total_codepoints: s1Text.length + s2Text.length,
      unknown: { kinds: ["image_pages"], counts_known: false, ratio_known: false, note: "不可知" },
      whole_book_claim_allowed: false, whole_book_percent: null },
    honesty: { book_understood: { allowed: false, reason: "恒不可宣称" }, whole_book_claim_allowed: false,
      layers: { extraction: { units: 2 }, analysis: { units: 2 }, reading: { known: false } } },
    engine: { name: "books_rag.py", lexical_weight: 0.25, rerank_pool: 20, rerank_min_conf: 0.5 },
  };

  /**
   * `/book-identity` 的替身登记表：**路径 ⇒ 内容身份**。
   * 真引擎是「解包这本书、对正文算内容摘要」；替身做不到，只要满足三条：
   *   ① 同一路径永远同一身份 ② 不同路径身份不同 ③ **身份由引擎给**（插件不自己算）。
   * 想指定某条路径对应哪本书，测试里往这张表登记即可。
   */
  const IDENTITY_BY_PATH = new Map();
  const identityOf = (p) => {
    const hit = IDENTITY_BY_PATH.get(p);
    if (hit) return hit;
    // 未登记的路径：确定性派生一个假身份（这是**替身行为**，不是真引擎的算法）。
    // 字段名照引擎的 /book-identity 回包：`book_id` 就是内容摘要（16 位），不是另一个哈希。
    const cid = sha256Hex(`fixture|${p}`).slice(0, 16);
    return { book_id: cid, book_version_id: `bv_${cid}` };
  };

  /** 忠实替身：/analyze-chapter 给 ANALYSIS，/source-span 按 slice 表返回原文，/book-identity 给内容身份。 */
  const fakeSidecar = (analysis = ANALYSIS) => async (path, init = {}) => {
    if (path === "/analyze-chapter") return { ok: true, status: 200, json: async () => analysis };
    if (path.startsWith("/book-identity")) {
      const p = decodeURIComponent(String(path).split("path=")[1] ?? "");
      return { ok: true, status: 200,
        json: async () => ({ ok: true, path: p, ...identityOf(p), identity_basis: "content", read_only: true }) };
    }
    if (path === "/source-span") {
      const { span_id: sid } = JSON.parse(init.body);
      const s = SLICES.find((x) => x.slice_id === sid);
      if (!s) return { ok: false, status: 200, json: async () => ({ ok: false, code: "SPAN_BOOK_NOT_FOUND" }) };
      // M15 0b：真实引擎还会给 `book_id` / `href` / `block_id` / 块区间 —— 替身必须同形，
      // 否则「透传」这条路径在离线测试里根本没被走到（不忠实替身 = 假绿）。
      return { ok: true, status: 200, json: async () => ({ ok: true, span_id: s.slice_id, book_version_id: BVM,
        book_id: CID, href: "text/part0001.html",
        block_id: `blk_${CID}_${s.section_id.slice(-1)}_2`, block_index: 2,
        block_start_codepoint: s.start_codepoint, block_end_codepoint: s.end_codepoint + 3,
        section_id: s.section_id, section_order: Number(s.section_id.slice(-1)),
        start_codepoint: s.start_codepoint, end_codepoint: s.end_codepoint,
        text_hash: s.text_hash, quote: s.text, quote_chars: [...s.text].length, verified: true }) };
    }
    return { ok: false, status: 404, json: async () => ({ ok: false, code: "NOT_FOUND" }) };
  };

  // ---- 没有 sidecar 时如实失败 ----
  const rtNoSide = createReadingRuntime({ getSettings: () => ({ bookKbDir: KB }) });
  const noSide = await rtNoSide.analyzeChapter({ book: "随便" });
  falsy("无 sidecar 时 analyzeChapter ok=false", noSide.ok);
  is("并给 SIDECAR_UNAVAILABLE", noSide.code, "SIDECAR_UNAVAILABLE");

  const rtFake = createReadingRuntime({ getSettings: () => ({ bookKbDir: KB }), sidecarFetch: fakeSidecar() });
  const capsM8 = rtFake.capabilities();
  const spanCapM8 = capsM8.report.find((c) => c.name === "readSourceSpan");
  is("注入 sidecar 后 readSourceSpan 报 ready", spanCapM8.status, "ready");

  // ---- readSourceSpan：成功映射 + 失败必须如实传播（O2 变异靶）----
  const goodSpan = await capsM8.policy.readSourceSpan(SLICES[0].slice_id);
  truthy("readSourceSpan 成功时 ok=true", goodSpan.ok);
  is("并原样带出 text_hash", goodSpan.text_hash, SLICES[0].text_hash);
  is("并原样带出 book_version_id", goodSpan.book_version_id, BVM);
  // M15 0b：SpanRef 要的书内定位必须**原样透传**（不重算、不编造）
  is("并原样带出 book_id（SpanRef 必填）", goodSpan.book_id, CID);
  is("并原样带出 href", goodSpan.href, "text/part0001.html");
  truthy("并原样带出 block_id", /^blk_[0-9a-f]{16}_\d+_\d+$/.test(goodSpan.block_id ?? ""));
  is("并原样带出块区间起点", goodSpan.block_start_codepoint, SLICES[0].start_codepoint);
  truthy("并原样带出块区间终点", Number.isInteger(goodSpan.block_end_codepoint));
  is("引擎没给的字段一律 null（不编）", goodSpan.locator_quality ?? null, null);
  const missingSpan = await capsM8.policy.readSourceSpan(`sp_${CID}_9_0_5`);
  falsy("引擎说 ok:false 时 readSourceSpan 必须 ok=false（不得吞掉失败）", missingSpan.ok);
  is("并把引擎的错误码带出来", missingSpan.code, "SPAN_BOOK_NOT_FOUND");

  // ---- analyzeChapter 诚实守卫 ----
  const good = await rtFake.analyzeChapter({ book: "M8 替身书" });
  truthy("诚实输出被接受", good.ok);
  is("并自报只读", good.read_only, true);
  const dishonest = { ...ANALYSIS, coverage: { ...ANALYSIS.coverage, whole_book_claim_allowed: true } };
  const rtBad = createReadingRuntime({ getSettings: () => ({ bookKbDir: KB }), sidecarFetch: fakeSidecar(dishonest) });
  const rejected = await rtBad.analyzeChapter({ book: "M8 替身书" });
  falsy("声称「全书」的输出被拒绝（ANALYSIS_HONESTY_VIOLATION）", rejected.ok);
  is("错误码精确", rejected.code, "ANALYSIS_HONESTY_VIOLATION");
  const noUnknown = { ...ANALYSIS, coverage: { ...ANALYSIS.coverage, unknown: { counts_known: true } } };
  const rtBad2 = createReadingRuntime({ getSettings: () => ({ bookKbDir: KB }), sidecarFetch: fakeSidecar(noUnknown) });
  falsy("未知部分说「已知」也被拒绝", (await rtBad2.analyzeChapter({ book: "x" })).ok);

  // ---- M13：引擎没给内容身份（content_id）⇒ 定不出身份，**不猜、不落盘** ----
  {
    const noIdent = { ...ANALYSIS };
    delete noIdent.content_id;
    const rtNoIdent = createReadingRuntime({
      getSettings: () => ({ bookKbDir: KB }), sidecarFetch: fakeSidecar(noIdent),
    });
    const r = await rtNoIdent.analyzeAndPersist({ book: "M8 替身书" });
    falsy("引擎没给 content_id ⇒ 拒绝落盘（不猜身份）", r.ok);
    is("错误码是 BOOK_IDENTITY_MISSING", r.code, "BOOK_IDENTITY_MISSING");
    is("被拒时 persisted=false", r.honest_report?.persisted, false);
    is("被拒时不编 run_id", r.honest_report?.run_id, null);
    truthy("原因里说明是「定不出身份」，不是「没有理解」", /身份/.test(String(r.message)), r.message);
    // 反证：只把 content_id 补回来就该成功（证明拒绝的原因是身份缺失，而不是别的）
    const rtOk = createReadingRuntime({
      getSettings: () => ({ bookKbDir: KB }), sidecarFetch: fakeSidecar(ANALYSIS),
    });
    truthy("补回 content_id ⇒ 同样输入就能落盘（反证拒绝原因）",
      (await rtOk.analyzeAndPersist({ book: "M8 替身书" })).ok);
  }

  // ---- candidatesFromAnalysis：未真消费的窗口不得当依据（O4 变异靶）----
  const withUnconsumed = {
    ...ANALYSIS,
    windows: ANALYSIS.windows.map((w, i) => (i === 0 ? { ...w, consumed: false, status: "failed" } : w)),
  };
  const built = rtFake.candidatesFromAnalysis(withUnconsumed);
  is("未真消费窗口的候选被剔除，只剩 1 个", built.candidates.length, 1);
  is("被剔除的候选给了原因", built.skipped[0]?.reason, "no_consumed_slice");
  is("留下的候选只引用真消费窗口的切片", built.candidates[0]?.book_evidence_refs.length, 1);

  // ---- R 只给「与目标确有字面重合」的候选 ----
  const noGoal = rtFake.candidatesFromAnalysis(ANALYSIS);
  truthy("没有目标时不编 R（personal 为空）", Object.keys(noGoal.candidates[0].personal).length === 0);
  const withGoal = rtFake.candidatesFromAnalysis(ANALYSIS, { goal: "上帝存在的证明" });
  truthy("有目标且切片确有重合时给 R", !!withGoal.candidates[0].personal.R);
  is("R 的依据指向 goal:current", withGoal.candidates[0].personal.R.evidence_refs[0], "goal:current");
  truthy("R 的理由写出真实重合词（可复核）",
    /重合：/.test(withGoal.candidates[0].personal.R.reason), withGoal.candidates[0].personal.R.reason);
  truthy("与目标无重合的候选不给 R（不编相关）", !withGoal.candidates[1].personal.R);

  // ---- analyzeAndPersist：必须经 file-service 事务落盘（O5 变异靶）----
  const KB2 = mkdtempSync(join(tmpdir(), "ab-m8-persist-"));
  try {
    for (const d of ["书籍", "待确认", "推荐反馈", "概念", "理解变化", "阅读背景", ".state"]) {
      mkdirSync(join(KB2, d), { recursive: true });
    }
    writeFileSync(join(KB2, "索引.md"), "---\nschema_version: '1.1'\nobject_type: index\nid: idx-2\nrevision: 1\n"
      + "title: 索引\ntags:\n- index\nscope: reading\nknowledge_status: active\n"
      + "created_at: '2026-10-10T00:00:00.000Z'\nupdated_at: '2026-10-10T00:00:00.000Z'\n"
      + `index_generation:\n  mode: manual_seed\n  generated_at: '2026-10-10T00:00:00.000Z'\n  source_digest: null\n`
      + `---\n\n# 索引\n\n${goodIndex}\n`);
    const rtPersist = createReadingRuntime({
      getSettings: () => ({ bookKbDir: KB2 }),
      sidecarFetch: fakeSidecar(),
    });
    const saved = await rtPersist.analyzeAndPersist({ book: "M8 替身书", goal: "上帝存在的证明" });
    truthy("落盘成功", saved.ok, JSON.stringify(saved).slice(0, 300));
    truthy("拿到 run_id", /^rr_/.test(saved.run_id ?? ""));
    is("写盘事务已 committed", saved.transaction?.state, "committed");
    truthy("笔记落在 推荐反馈/ 下", String(saved.note_rel).startsWith("推荐反馈/"));
    // ★ 关键：事务必须**真的登记在 file-service 里**（绕过事务直接写文件就会在这里露馅）
    const svc = (await rtPersist.fileService()).svc;
    const txs = await svc.listTransactions();
    const found = txs.find((t) => t.id === saved.transaction.id);
    truthy("该事务确实登记在 file-service 的事务表里（没有绕过事务）", !!found, JSON.stringify(txs.map((t) => t.id)));
    is("登记的事务状态是 committed", found?.state, "committed");
    truthy("落盘回执不宣称「已读懂」", saved.honesty?.book_understood?.allowed === false);

    // ---- 落盘后只读投影能读到两层 ----
    const rec2 = await rtPersist.recommendations();
    is("runs 里有 1 条", rec2.count, 1);
    is("invalid_count=0", rec2.invalid_count, 0);
    truthy("result 不为 null", rec2.result !== null && typeof rec2.result === "object");
    is("result_run_id 就是刚落盘那次", rec2.result_run_id, saved.run_id);
    is("投影给出 result_run_id", rec2.result_run_id, saved.run_id);
    is("这本书只有 1 条 ready 理解", rec2.ready_run_count, 1);
    is("没有歧义", rec2.result_ambiguous, false);
    truthy("第一层有真实内容（book_guide.items 非空）",
      Array.isArray(rec2.result?.book_guide?.items) && rec2.result.book_guide.items.length > 0,
      JSON.stringify(rec2.result?.book_guide?.items?.length));
    truthy("第一层有带来源的浓缩段落",
      Array.isArray(rec2.result?.book_guide?.overview_paragraphs)
      && rec2.result.book_guide.overview_paragraphs.length > 0
      && Array.isArray(rec2.result?.book_guide?.source_refs)
      && rec2.result.book_guide.source_refs.length > 0);
    truthy("第二层有真实内容（R 来自目标重合）",
      Array.isArray(rec2.result?.personalized_items) && rec2.result.personalized_items.length > 0,
      JSON.stringify(rec2.result?.personalization_status));
    is("个性化状态为 limited（只有 R，G/T 未知）", rec2.result?.personalization_status, "limited");
    truthy("第二层条目带来源", rec2.result?.personalized_items?.[0]?.source_refs?.length > 0);

    // ---- 2a：复算**覆盖同一条笔记**，run_id 不变、revision 递增（M10 阶段 2）----
    // 旧模型是「换新 run_id + 把旧 run 标 stale」，真实库里因此堆了 13 条 run 笔记。
    is("笔记路径就是 推荐反馈/<run_id>.md（一本书一条）", saved.note_rel, `推荐反馈/${saved.run_id}.md`);
    is("首次 revision = 1", saved.revision, 1);
    is("首次没有上一版", saved.previous_revision, null);

    const again = await rtPersist.analyzeAndPersist({ book: "M8 替身书", goal: "上帝存在的证明" });
    truthy("复算成功", again.ok, JSON.stringify(again).slice(0, 300));
    is("复算复用**同一个** run_id（一本书一个理解）", again.run_id, saved.run_id);
    is("复算写的是**同一条**笔记", again.note_rel, saved.note_rel);
    is("revision 从 1 递增到 2", again.revision, 2);
    is("并如实给出上一版 revision", again.previous_revision, 1);
    is("如实标注这是复算", again.is_recompute, true);
    is("同输入复算 ⇒ input_fingerprint_changed=false", again.input_fingerprint_changed, false);
    is("手改检测通过（盘上还是我们写的那份）", again.honest_report?.manual_edit_check, "match");
    const rec3 = await rtPersist.recommendations();
    is("运行记录仍然是 1 条（覆盖，不是新增）", rec3.count, 1);
    truthy("投影的扫描缓存已作废（内容 hash 变了，不是读回上一版）",
      rec3.runs?.[0]?.content_hash !== rec2.runs?.[0]?.content_hash,
      `${rec2.runs?.[0]?.content_hash} vs ${rec3.runs?.[0]?.content_hash}`);
    is("投影给出的当前运行还是它", rec3.result_run_id, again.run_id);
    truthy("两层仍然有真实内容", Array.isArray(rec3.result?.book_guide?.items)
      && rec3.result.book_guide.items.length > 0
      && Array.isArray(rec3.result?.personalized_items)
      && rec3.result.personalized_items.length > 0);
    const noteNow = await svc.readNote(saved.note_rel);
    is("盘上那条笔记的 revision 已是 2", noteNow.data?.revision, 2);
    is("盘上那条笔记仍是 ready（新模型不再写 stale）", noteNow.data?.state, "ready");

    // 换输入（goal 变了）也必须**保持同一个身份** —— 身份按书定，不按输入指纹定。
    // 这一条专门挡「又按输入指纹算 run_id」的退化：同输入时那种写法看起来也稳定，只有换输入才露馅。
    const changed = await rtPersist.analyzeAndPersist({ book: "M8 替身书", goal: "完全不同的目标：灵魂不朽" });
    truthy("换输入复算成功", changed.ok, JSON.stringify(changed).slice(0, 300));
    is("换输入后 run_id 仍然不变（身份按书，不按输入指纹）", changed.run_id, saved.run_id);
    is("换输入后写的是同一条笔记", changed.note_rel, saved.note_rel);
    is("revision 继续递增到 3", changed.revision, 3);
    is("并如实标注输入变了", changed.input_fingerprint_changed, true);
    const rec3b = await rtPersist.recommendations();
    is("换输入后运行记录仍然是 1 条（没有堆出新理解）", rec3b.count, 1);
    is("换输入后投影读到的仍是这条 run", rec3b.result_run_id, saved.run_id);

    // ---- 2b：手改保护 —— 用户改过就**不覆盖**，并如实说明 ---------------------
    const absNote = join(KB2, saved.note_rel);
    const serviceText = readFileSync(absNote, "utf8");
    appendFileSync(absNote, "\n\n<!-- 用户手改：这句是我自己加的 -->\n");
    const afterEdit = await svc.readNote(saved.note_rel);
    truthy("手改后 bytes hash 确实变了", afterEdit.hash !== noteNow.hash);

    const blocked = await rtPersist.analyzeAndPersist({ book: "M8 替身书", goal: "上帝存在的证明" });
    is("手改后复算被拒", blocked.ok, false);
    is("错误码是 HASH_CONFLICT", blocked.code, "HASH_CONFLICT");
    truthy("如实告诉用户「这条笔记你改过，我没有覆盖」",
      /你改过/.test(String(blocked.message)) && /没有覆盖/.test(String(blocked.message)), String(blocked.message));
    is("honest_report 标明手改不匹配", blocked.honest_report?.manual_edit_check, "mismatch");
    is("被拒时 persisted=false", blocked.honest_report?.persisted, false);
    const stillEdited = readFileSync(absNote, "utf8");
    truthy("盘上的手改内容**没有被覆盖**", stillEdited.includes("用户手改"));
    is("笔记 revision 仍是 3（被拒时没有写成第 4 版）", (await svc.readNote(saved.note_rel)).data?.revision, 3);

    // 还原成服务写过的那份 ⇒ 应该又能继续复算（证明拒绝的是「手改」而不是「复算」）
    writeFileSync(absNote, serviceText);
    const afterRestore = await rtPersist.analyzeAndPersist({ book: "M8 替身书", goal: "上帝存在的证明" });
    truthy("把手改还原后可以继续复算", afterRestore.ok, JSON.stringify(afterRestore).slice(0, 300));
    is("revision 继续递增到 4", afterRestore.revision, 4);
    is("还原后手改检测通过", afterRestore.honest_report?.manual_edit_check, "match");

    // ---- 2c：并发锁 —— 同一本书第二个并发请求立刻被拒，不排队、不写盘 ----------
    let release = null;
    const gate = new Promise((res) => { release = res; });
    const inner = fakeSidecar();
    const rtLock = createReadingRuntime({
      getSettings: () => ({ bookKbDir: KB2 }),
      sidecarFetch: async (path, init = {}) => { await gate; return inner(path, init); },
    });
    const firstCall = rtLock.analyzeAndPersist({ book: "M8 替身书", goal: "并发" });
    const secondCall = await rtLock.analyzeAndPersist({ book: "M8 替身书", goal: "并发" });
    is("第二个并发请求被拒", secondCall.ok, false);
    is("错误码是 ANALYSIS_IN_PROGRESS", secondCall.code, "ANALYSIS_IN_PROGRESS");
    truthy("如实说「正在分析中」", /正在分析中/.test(String(secondCall.message)), String(secondCall.message));
    truthy("并发被拒时不带 honest_report（没写盘就没报告）", secondCall.honest_report === null);
    release();
    const firstDone = await firstCall;
    truthy("第一个请求正常跑完（锁不影响正常路径）", firstDone.ok, JSON.stringify(firstDone).slice(0, 240));
    is("锁在结束后释放：同一本书可以再分析", (await rtLock.analyzeAndPersist({ book: "M8 替身书", goal: "并发" })).ok, true);

    // ---- 2d：「文件存在但解析不了」≠「文件不存在」（不得按新文件覆盖）---------
    //
    // 事故形状：盘上有 <run_id>.md，但 frontmatter 是**自己解析不了**的多行裸标量
    // （旧写出器的产物）。旧行为：扫描把它丢掉 ⇒ 重算以为「这本书还没写过理解」
    // ⇒ revision 从 1 开始 ⇒ 幂等键 recommendation_run:<run_id>:rev1 与上次撞车
    // （IDEMPOTENCY_CONFLICT）；真写下去还会覆盖掉一份读不懂的旧内容。
    const KB_UNP = mkdtempSync(join(tmpdir(), "ab-m8-unparseable-"));
    try {
      for (const d of ["书籍", "待确认", "推荐反馈", "概念", "理解变化", "阅读背景", ".state"]) {
        mkdirSync(join(KB_UNP, d), { recursive: true });
      }
      writeFileSync(join(KB_UNP, "索引.md"), "---\nschema_version: '1.1'\nobject_type: index\nid: idx-unp\nrevision: 1\n"
        + "title: 索引\ntags:\n- index\nscope: reading\nknowledge_status: active\n"
        + "created_at: '2026-10-10T00:00:00.000Z'\nupdated_at: '2026-10-10T00:00:00.000Z'\n"
        + `index_generation:\n  mode: manual_seed\n  generated_at: '2026-10-10T00:00:00.000Z'\n  source_digest: null\n`
        + `---\n\n# 索引\n\n${goodIndex}\n`);
      const { bookRunId } = await import("../lib/reading/policy.js");
      const badRunId = bookRunId({ book_version_id: BVM });
      const badRel = `推荐反馈/${badRunId}.md`;
      // 旧写出器会产出这种形状：列表项里含 \n 的正文，续行顶格（列 0）
      const brokenText = "---\n"
        + "schema_version: '1.1'\n"
        + "object_type: recommendation_run\n"
        + `id: ${badRunId}\n`
        + "revision: 1\n"
        + "title: 两层阅读推荐运行\n"
        + "book_guide:\n"
        + "  overview_paragraphs:\n"
        + "    - 第一段\n"
        + "第二段顶格续行\n"
        + "---\n\n# 正文\n";
      writeFileSync(join(KB_UNP, badRel), brokenText);

      const rtUnp = createReadingRuntime({
        getSettings: () => ({ bookKbDir: KB_UNP }),
        sidecarFetch: fakeSidecar(),
      });

      // 扫描必须**看得见**这条坏文件（rel + 错误码 + 行号），不能无声消失
      const scanUnp = await rtUnp.scanVault();
      const listed = (scanUnp.unparseable ?? []).find((x) => x.rel === badRel);
      truthy("scanVault 的 unparseable 列出坏文件（rel/错误码/行号）", !!listed, JSON.stringify(scanUnp.unparseable));
      is("坏文件的错误码原样带出", listed?.code, "UNSUPPORTED_YAML");
      truthy("坏文件带出行号", Number.isInteger(listed?.line), JSON.stringify(listed));
      is("坏文件不混进正式 notes 集合", scanUnp.notes.some((n) => n.rel === badRel), false);

      const r = await rtUnp.analyzeAndPersist({ book: "M8 替身书" });
      is("文件存在但解析不了 ⇒ 报 EXISTING_NOTE_UNPARSEABLE（不按新文件覆盖）", r.code, "EXISTING_NOTE_UNPARSEABLE");
      is("被拒时 ok=false", r.ok, false);
      truthy("点名是哪个文件", String(r.message).includes(badRel) || r.note_rel === badRel, String(r.message));
      truthy("把解析错误带出来（含行号）",
        Array.isArray(r.errors) && r.errors.length > 0 && Number.isInteger(r.errors[0]?.line),
        JSON.stringify(r.errors));
      is("被拒时 persisted=false", r.honest_report?.persisted, false);
      is("**没有写盘**（文件字节原样）", readFileSync(join(KB_UNP, badRel), "utf8"), brokenText);
    } finally { rmSync(KB_UNP, { recursive: true, force: true }); }

    // ======================================================================= //
    // [12b] 3b：understandingStatus —— 打开书前的「有没有当前理解」真实判定
    //
    // 这一段**不手写 run 笔记夹具**：直接用**真的** analyzeAndPersist 把笔记写出来，
    // 再问 understandingStatus。手写夹具会随 schema 漂移（第一版就是这么红的：
    // 漏了 book_guide.overview_paragraphs / coverage_scope / source_refs，formal_valid=false）。
    // ======================================================================= //
    console.log("\n[12b] 3b：understandingStatus —— 打开书前的「有没有当前理解」真实判定");
    {
      const { bookRunId } = await import("../lib/reading/policy.js");

      // 12b-1 M13：身份**由引擎给**（`/book-identity`），插件不再从路径算哈希。
      //
      // 这里必须是**另一本书**（端到端书），不能复用 [12] 的 M8 替身书：
      // M13 起运行身份按**内容**定，同一本书就是同一条 run 笔记。以前靠「路径不同 ⇒
      // path_hash8 不同」偶然错开，现在路径不参与身份了，复用就会写进同一条笔记、
      // revision 接着涨（这条曾经真的红过：期望 1 得到 7）。
      const MY_CID = "fedcba9876543210";
      const MY_BVM = `bv_${MY_CID}`;
      const MY_ANALYSIS = {
        ...ANALYSIS, book: "端到端书", author: "端到端作者",
        book_path: "/Users/someone/Library/Books/端到端书.epub",
        book_version_id: MY_BVM, content_id: MY_CID,
      };
      const MY_PATH = "/Users/someone/Library/Books/端到端书.epub";
      IDENTITY_BY_PATH.set(MY_PATH, { book_id: MY_CID, book_version_id: MY_BVM });
      const MY_RUN = bookRunId({ book_version_id: MY_BVM });
      truthy("端到端书的身份与 M8 替身书不同（否则会撞同一条笔记）",
        MY_BVM !== BVM && MY_RUN !== bookRunId({ book_version_id: BVM }), `${MY_BVM} vs ${BVM}`);
      truthy("引擎给的身份派生出的 run_id 形状正确", /^rr_[0-9a-f]{24}$/.test(MY_RUN), MY_RUN);
      truthy("同一身份两次派生结果相同（确定性）", bookRunId({ book_version_id: MY_BVM }) === MY_RUN);
      truthy("换一本书 ⇒ 换 run_id",
        bookRunId({ book_version_id: "bv_eebaf9a3988b59f4" }) !== MY_RUN);

      // 12b-1b 引擎说「认不出这本书」⇒ 不猜（checked=false，且绝不 auto_trigger_allowed）
      // 这是 M13 新增的关键防线：路径没了/内容变了，引擎给不出身份时**不能**当成「没有理解」，
      // 否则自动流程会覆盖掉已有的那份理解。
      {
        const rtUnknown = createReadingRuntime({
          getSettings: () => ({ bookKbDir: KB2 }),
          sidecarFetch: async (path) => {
            if (String(path).startsWith("/book-identity")) {
              return { ok: true, status: 200,
                json: async () => ({ ok: false, code: "BOOK_NOT_IN_LIBRARY" }) };
            }
            return fakeSidecar()(path);
          },
        });
        const r = await rtUnknown.understandingStatus({ book_path: "/Users/someone/Books/没了.epub" });
        falsy("引擎认不出这本书 ⇒ ok=false", r.ok);
        is("引擎认不出这本书 ⇒ checked=false（不许当成「没有理解」）", r.checked, false);
        is("引擎认不出这本书 ⇒ 绝不自动跑", r.auto_trigger_allowed, false);
        is("引擎认不出这本书 ⇒ has_current_understanding 是 null（不是 false）",
          r.has_current_understanding, null);
        is("引擎认不出这本书 ⇒ 原样带回引擎的错误码", r.code, "BOOK_NOT_IN_LIBRARY");
        is("引擎认不出这本书 ⇒ 不假装「已读懂」", /读懂/.test(r.message), false);
      }

      // 12b-2 缺 path ⇒ 不猜（checked=false，且绝不 auto_trigger_allowed）
      {
        const r = await rtPersist.understandingStatus({});
        falsy("缺 book_path ⇒ ok=false", r.ok);
        is("缺 book_path ⇒ checked=false", r.checked, false);
        is("缺 book_path ⇒ 绝不自动跑", r.auto_trigger_allowed, false);
        is("缺 book_path ⇒ has_current_understanding 是 null（不是 false）", r.has_current_understanding, null);
      }

      // 12b-3 这本书盘上没有笔记 ⇒ 可以自动跑第一次
      {
        const NEVER = "/Users/someone/Books/从未分析过.epub";
        const r = await rtPersist.understandingStatus({ book_path: NEVER });
        truthy("没有笔记 ⇒ ok", r.ok);
        is("没有笔记 ⇒ checked=true", r.checked, true);
        is("没有笔记 ⇒ auto_trigger_allowed=true（可以自动跑第一次）", r.auto_trigger_allowed, true);
        is("没有笔记 ⇒ has_current_understanding=false", r.has_current_understanding, false);
        is("只读（read_only）", r.read_only, true);
        // note_rel 必须由**引擎给的身份**派生（不是插件从路径算的）
        is("note_rel 指向 推荐反馈/<run_id>.md",
          r.note_rel, `推荐反馈/${bookRunId({ book_version_id: identityOf(NEVER).book_version_id })}.md`);
        is("如实回显引擎给的内容摘要", r.content_id, identityOf(NEVER).book_id);
        is("如实回显引擎给的 book_version_id", r.book_version_id, identityOf(NEVER).book_version_id);
      }

      // 12b-4 **真的**跑一次 analyzeAndPersist，再问 understandingStatus
      {
        const rtE2E = createReadingRuntime({
          getSettings: () => ({ bookKbDir: KB2 }),
          sidecarFetch: fakeSidecar(MY_ANALYSIS),
        });
        const saved = await rtE2E.analyzeAndPersist({ book: "端到端书" });
        truthy("真落盘成功（用真 analyzeAndPersist 造夹具）", saved.ok, JSON.stringify(saved).slice(0, 240));
        is("run_id 就是 bookRunId(引擎给的内容身份)", saved.run_id, MY_RUN);

        const r = await rtE2E.understandingStatus({ book_path: MY_PATH });
        truthy("有理解 ⇒ ok", r.ok);
        is("有理解 ⇒ checked=true", r.checked, true);
        is("有理解 ⇒ has_current_understanding=true", r.has_current_understanding, true);
        is("有理解 ⇒ auto_trigger_allowed=false（**不自动重跑**）", r.auto_trigger_allowed, false);
        is("有理解 ⇒ state=ready", r.state, "ready");
        is("有理解 ⇒ revision 如实报出（首次=1）", r.revision, 1);
        is("有理解 ⇒ run_id 与刚落盘那次一致", r.run_id, saved.run_id);
        is("有理解 ⇒ note_rel 与刚落盘那次一致", r.note_rel, saved.note_rel);
        truthy("消息里明说「不自动重跑」", /不自动重跑/.test(r.message), r.message);
        is("没有假装「已读懂」", /读懂/.test(r.message), false);
      }

      // 12b-5 复算之后仍然「有当前理解」，revision 递增（一本书一条，不新增）
      {
        const rtE2E = createReadingRuntime({
          getSettings: () => ({ bookKbDir: KB2 }),
          sidecarFetch: fakeSidecar(MY_ANALYSIS),
        });
        const again = await rtE2E.analyzeAndPersist({ book: "端到端书" });
        truthy("复算成功", again.ok, JSON.stringify(again).slice(0, 240));
        is("复算覆盖同一条笔记（run_id 不变）", again.run_id, MY_RUN);
        is("revision 递增到 2", again.revision, 2);
        const r = await rtE2E.understandingStatus({ book_path: MY_PATH });
        is("复算后仍报「有当前理解」", r.has_current_understanding, true);
        is("复算后 revision 是 2", r.revision, 2);
        is("复算后依然不自动重跑", r.auto_trigger_allowed, false);
      }

      // 12b-6 同名路径上放一条**不是** recommendation_run 的笔记 ⇒ 不认，也不用自动流程覆盖它
      {
        const OTHER_PATH = "/Users/someone/Library/Books/别的东西.epub";
        const OTHER = identityOf(OTHER_PATH);
        truthy("替身给这条路径的身份与 MY_PATH 不同（否则下面测不出东西）",
          OTHER.book_version_id !== BVM, JSON.stringify(OTHER));
        const OTHER_RID = bookRunId({ book_version_id: OTHER.book_version_id });
        writeFileSync(join(KB2, "推荐反馈", `${OTHER_RID}.md`),
          "---\nschema_version: '1.1'\nobject_type: book_summary\nid: bs-1\nrevision: 1\n"
          + "title: 不是运行\ntags:\n- reading\nscope: reading\nknowledge_status: active\n"
          + "created_at: '2026-10-11T00:00:00.000Z'\nupdated_at: '2026-10-11T00:00:00.000Z'\n"
          + "book_id: book-fixture-1\n---\n\n# 不是运行\n");
        const rtOther = createReadingRuntime({
          getSettings: () => ({ bookKbDir: KB2 }),
          sidecarFetch: fakeSidecar(),
        });
        const r = await rtOther.understandingStatus({ book_path: OTHER_PATH });
        truthy("object_type 不对 ⇒ 仍然 ok（如实报告，不是错误）", r.ok);
        is("object_type 不对 ⇒ checked=true", r.checked, true);
        is("object_type 不对 ⇒ auto_trigger_allowed=false（不用自动流程覆盖它）", r.auto_trigger_allowed, false);
        is("object_type 不对 ⇒ has_current_understanding=false", r.has_current_understanding, false);
        truthy("消息里报出真实的 object_type", /book_summary/.test(r.message), r.message);
      }

      // 12b-7 方案 B：recommendations({book_path}) —— 按**这本书**取理解，且**不回退**
      //
      // 面板以前只能读「全库最新一条」，于是选中 A 书会看到 B 书的导读
      //（用户点名的「切书之后导读没变化」根因就在这里）。这一段把「按书取」与
      // 「定不出来/没有 ⇒ 绝不拿别的书顶替」两件事都钉死。
      {
        const rtB = createReadingRuntime({
          getSettings: () => ({ bookKbDir: KB2 }),
          sidecarFetch: fakeSidecar(MY_ANALYSIS),
        });

        // (1) 不带 book_path ⇒ 行为与以前**一字不变**（全库扫描 + 挑最新 ready）
        const global = await rtB.recommendations();
        truthy("不带 book_path ⇒ 仍然 ok（向后兼容）", global.ok, JSON.stringify(global).slice(0, 200));
        truthy("不带 book_path ⇒ 仍给出 result", global.result !== null);
        is("不带 book_path ⇒ 不带 book_scoped 标记", global.book_scoped ?? null, null);

        // (2) 带 book_path 且这本书**有** ready 理解 ⇒ 拿到**这本的** result
        const mine = await rtB.recommendations({ book_path: MY_PATH });
        truthy("带 book_path ⇒ ok", mine.ok, JSON.stringify(mine).slice(0, 200));
        is("带 book_path ⇒ 自报按书取", mine.book_scoped, true);
        is("带 book_path ⇒ result_run_id 就是这本书的 run", mine.result_run_id, MY_RUN);
        truthy("带 book_path ⇒ 真的投影出了 result", mine.result !== null);
        is("带 book_path ⇒ 只列出这本书的 run（1 条）", mine.runs.length, 1);
        is("带 book_path ⇒ runs 里的 run_id 是这本的", mine.runs[0]?.run_id, MY_RUN);
        is("带 book_path ⇒ ready_run_count=1", mine.ready_run_count, 1);
        is("带 book_path ⇒ 无歧义", mine.result_ambiguous, false);
        is("带 book_path ⇒ 如实回显引擎给的 book_version_id", mine.book_version_id, MY_BVM);
        is("带 book_path ⇒ 如实回显内容摘要", mine.content_id, MY_CID);
        is("带 book_path ⇒ 只读", mine.read_only, true);
        // runs 每项仍是**恰好 7 键**（契约测试钉死了，不许偷偷加字段）
        is("带 book_path ⇒ runs 每项仍是原来的 7 个元数据键",
          Object.keys(mine.runs[0] ?? {}).sort().join(","),
          "content_hash,created_at,rel,run_id,state,title,updated_at");

        // (3) 带 book_path 但**这本书没有**理解 ⇒ 诚实空态，**绝不**回退到全库最新一条
        const NEVER2 = "/Users/someone/Books/这本书从没分析过.epub";
        const never = await rtB.recommendations({ book_path: NEVER2 });
        truthy("没有理解 ⇒ ok（是空态，不是错误）", never.ok, JSON.stringify(never).slice(0, 200));
        is("没有理解 ⇒ result=null（**不拿别的书的 result 冒充**）", never.result, null);
        is("没有理解 ⇒ result_run_id=null", never.result_run_id, null);
        is("没有理解 ⇒ runs 为空", never.runs.length, 0);
        is("没有理解 ⇒ ready_run_count=0", never.ready_run_count, 0);
        truthy("没有理解 ⇒ 给出诚实的空态说明",
          typeof never.empty_state?.message === "string" && /还没有理解/.test(never.empty_state.message),
          JSON.stringify(never.empty_state));
        truthy("没有理解 ⇒ result_note 明说「不拿别的书的理解冒充这本的」",
          /不拿别的书/.test(never.result_note ?? ""), never.result_note);
        is("没有理解 ⇒ 仍然自报按书取", never.book_scoped, true);
        // 关键负控：全库那条 result 明明在，但这本书的空态**没有**被它填上
        truthy("负控：全库有 result，但这本书的空态没有被它填上",
          global.result !== null && never.result === null);

        // (4) 身份定不出来 ⇒ 明确报错，**绝不**回退
        const rtNoSide2 = createReadingRuntime({ getSettings: () => ({ bookKbDir: KB2 }) });
        const noSideB = await rtNoSide2.recommendations({ book_path: MY_PATH });
        falsy("没有引擎 ⇒ ok=false（定不出身份就不猜）", noSideB.ok);
        is("没有引擎 ⇒ 错误码 SIDECAR_UNAVAILABLE", noSideB.code, "SIDECAR_UNAVAILABLE");
        is("没有引擎 ⇒ result=null（不回退到全库最新一条）", noSideB.result, null);
        is("没有引擎 ⇒ runs 为空", noSideB.runs.length, 0);

        // 引擎认不出这本书 ⇒ 原样带回引擎的错误码，同样不回退
        const rtUnknown2 = createReadingRuntime({
          getSettings: () => ({ bookKbDir: KB2 }),
          sidecarFetch: async (path) => {
            if (String(path).startsWith("/book-identity")) {
              return { ok: true, status: 200, json: async () => ({ ok: false, code: "BOOK_NOT_IN_LIBRARY" }) };
            }
            return fakeSidecar()(path);
          },
        });
        const unknownB = await rtUnknown2.recommendations({ book_path: "/Users/someone/Books/没了.epub" });
        falsy("引擎认不出这本书 ⇒ ok=false", unknownB.ok);
        is("引擎认不出这本书 ⇒ 原样带回引擎错误码", unknownB.code, "BOOK_NOT_IN_LIBRARY");
        is("引擎认不出这本书 ⇒ result=null（不回退）", unknownB.result, null);
      }
    }

    // ======================================================================= //
    // [12c] F4：书籍信息笔记（4a）+ 覆盖账本（4b）+ 覆盖路由真读（4c）
    // ======================================================================= //
    console.log("\n[12c] F4：书籍信息笔记 + .cache/coverage 账本 + coverage() 真读");
    {
      const { validateNote } = await import("../lib/reading/schema.js");
      const { BOOK_DOMAIN } = await import("../lib/reading/book-domain.js");

      // ── 4a 书籍信息笔记：由**真的** analyzeAndPersist 写出（不是手写夹具）──
      const BOOK_REL = "书籍/M8 替身书｜替身作者/书籍信息.md";
      const bookNote = await svc.readNote(BOOK_REL);
      truthy("4a 书籍信息笔记真的落盘了", bookNote.exists === true, BOOK_REL);
      const bv = validateNote(bookNote.data, { mode: "formal", objectType: "book", domain: BOOK_DOMAIN });
      truthy("4a 通过 M1 formal 校验（能被 library() 当正式记录）", bv.ok,
        JSON.stringify(bv.errors?.[0] ?? null));
      is("4a object_type=book", bookNote.data.object_type, "book");
      is("4a id === book_id（规范 §2 交叉规则）", bookNote.data.id, bookNote.data.book_id);
      is("4a book_id = 引擎给的内容摘要（插件不再从路径 basename 算）(M13)",
        bookNote.data.book_id, CID);
      is("4a book_version_id 用引擎给的真值", bookNote.data.book_version_id, BVM);
      is("4a external_master.status **仍是 unverified**（本次只读了书本身，没去外部主库核对）",
        bookNote.data.external_master.status, "unverified");
      is("4a external_master.outcome 是 not_checked", bookNote.data.external_master.outcome, "not_checked");
      is("4a content_hash=null（引擎没给整书 bytes hash ⇒ 不编造，也不拿 book_version_id 冒充）",
        bookNote.data.content_hash, null);
      is("4a parser_version=null（引擎没报这个版本）", bookNote.data.parser_version, null);
      is("4a source_assets 记了 original_epub 来源", bookNote.data.source_assets?.[0]?.source_kind, "original_epub");
      truthy("4a 正文里没有「已读懂」这类宣称", !/已读懂/.test(bookNote.body ?? ""), bookNote.body);

      // ── 4a 幂等：同 book_version_id + 同 content_hash ⇒ 不重写 ──
      {
        const before = bookNote.hash;
        const rtAgain = createReadingRuntime({
          getSettings: () => ({ bookKbDir: KB2 }),
          sidecarFetch: fakeSidecar(),
        });
        const again = await rtAgain.analyzeAndPersist({ book: "M8 替身书", goal: "上帝存在的证明" });
        truthy("4a 复算成功", again.ok, JSON.stringify(again).slice(0, 200));
        is("4a 同版本 ⇒ 书籍信息笔记**不重写**（NO_CHANGE）",
          again.vault_integrity?.book_note?.code, "NO_CHANGE");
        is("4a 书籍信息笔记的 bytes hash 没变（确实没被重写）",
          (await svc.readNote(BOOK_REL)).hash, before);
      }

      // ── 4b 覆盖账本：`.cache/coverage/cov_<内容摘要>.json`，原始 JSON（不是笔记）──
      const LEDGER_REL = `.cache/coverage/cov_${CID}.json`;
      const ledgerNote = await svc.readNote(LEDGER_REL);
      truthy("4b 覆盖账本真的落盘了", ledgerNote.exists === true, LEDGER_REL);
      truthy("4b 账本里没有 frontmatter（它是缓存 JSON，不是笔记）", ledgerNote.hasFrontmatter !== true);
      const ledger = JSON.parse(ledgerNote.body);
      is("4b kind=coverage_ledger", ledger.kind, "coverage_ledger");
      is("4b cov_id 与 input_manifest_refs 里的 coverage: 引用一致", ledger.cov_id, `cov_${CID}`);
      is("4b total_units 是引擎给的真值", ledger.total_units, 2);
      is("4b analyzed_units 是引擎给的真值", ledger.analyzed_units, 2);
      is("4b unknown.counts_known 保持 false（未知部分不假装已知）", ledger.unknown.counts_known, false);
      is("4b whole_book_claim_allowed 保持 false", ledger.whole_book_claim_allowed, false);
      is("4b whole_book_percent 保持 null（不编百分比）", ledger.whole_book_percent, null);

      // ── input_manifest_refs 必须**都能解析**（这是 F4 的目的：引用不悬空）──
      {
        // 用 CID 这本书**自己**的 run 笔记：[12b] 在同一个 KB2 里还写过另一条（MY_PATH 那本）的 run 笔记，
        // 而 recommendations() 只报「最新一条 ready」，拿它当 CID 的凭据会张冠李戴。
        const { bookRunId } = await import("../lib/reading/policy.js");
        const runRel = `推荐反馈/${bookRunId({ book_version_id: BVM })}.md`;
        const refs = (await svc.readNote(runRel)).data.input_manifest_refs;
        const bvRef = refs.find((x) => x.startsWith("book_version:"));
        const covRef = refs.find((x) => x.startsWith("coverage:"));
        truthy("manifest 里有 book_version: 引用", typeof bvRef === "string", JSON.stringify(refs));
        truthy("manifest 里有 coverage: 引用", typeof covRef === "string", JSON.stringify(refs));
        is("book_version:<id> 能解析到刚写的书籍信息笔记（book_version_id 对得上）",
          bookNote.data.book_version_id, bvRef.slice("book_version:".length));
        is("coverage:<cov_id> 能解析到刚写的覆盖账本",
          ledger.cov_id, covRef.slice("coverage:".length));
      }

      // ── 4c coverage() 真读账本：给真实数字，且 units_known=true ──
      const cov = await rtPersist.coverage();
      truthy("4c coverage() ok", cov.ok);
      is("4c 找到账本 ⇒ units_known=true", cov.units_known, true);
      is("4c units_source 指向 .cache/coverage", cov.units_source, ".cache/coverage");
      // KB2 里有两份账本（CID 这份 + [12b] 那条 MY_PATH 的）⇒ 报告是**各账本之和**。
      // 这里不写死数字，而是核对「报告的数字 == 各账本之和」，并确认它是真数字（不是 null / 不是 0）。
      const sumOf = (k) => cov.ledgers.map((l) => l[k]).filter((x) => Number.isInteger(x)).reduce((a, b) => a + b, 0);
      truthy("4c 找到的账本数 ≥ 1", cov.ledgers.length >= 1, String(cov.ledgers.length));
      truthy("4c 报告里的 total_units 是真数字（不是 null、不是 0）",
        Number.isInteger(cov.report.coverage.total_units) && cov.report.coverage.total_units > 0,
        JSON.stringify(cov.report.coverage.total_units));
      is("4c total_units == 各账本 total_units 之和",
        cov.report.coverage.total_units, sumOf("total_units"));
      is("4c analyzed_units == 各账本 analyzed_units 之和",
        cov.report.coverage.analyzed_units, sumOf("analyzed_units"));
      truthy("4c 本测试这本书（cov_<CID>）确实在账本列表里",
        cov.ledgers.some((l) => l.cov_id === `cov_${CID}` && l.total_units === 2),
        JSON.stringify(cov.ledgers.map((l) => [l.cov_id, l.total_units])));
      truthy("4c 仍然不宣称「读懂」", cov.report.units.counts_as_understood === null);
      truthy("4c 说明白「只统计有账本的书」", /没有账本的书未计入/.test(cov.units_reason), cov.units_reason);
      truthy("4c 说明白「聚合计数 ⇒ 分层账仍未知」", /layers\.\*/.test(cov.units_reason), cov.units_reason);
      truthy("4c 账本目录确实存在", cov.ledger_dir_present === true);

      // ── 4c `.cache/` 不是知识：不进 library() 的书籍/知识计数 ──
      {
        const lib = await rtPersist.library();
        truthy("4c library() ok", lib.ok);
        // KB2 里现在有**两本**书：[12] 的 M8 替身书 + [12b] 的端到端书。
        // 核对「正好是这两本」，而不是「大于 0」—— 否则账本被误算进去也看不出来。
        is("4c 账本没被当成 book 笔记（只数真 book 笔记：2 本）", lib.counts.book, 2);
        const bookRels = lib.books.map((b) => b.rel);
        truthy("4c 正式知识里包含刚写的 book 笔记（两本都在，不是 0）",
          bookRels.includes("书籍/M8 替身书｜替身作者/书籍信息.md")
          && bookRels.includes("书籍/端到端书｜端到端作者/书籍信息.md"),
          JSON.stringify(bookRels));
        truthy("4c 账本没有被算成 book 笔记（.cache/ 下的一个都没进来）",
          bookRels.every((r) => !r.startsWith(".cache/")), JSON.stringify(bookRels));
        is("4c notes_total 与扫描结果一致（没有把 .cache/ 混进去）",
          lib.counts.notes_total, lib.counts.formal_valid_total + lib.counts.invalid_total);
        truthy("4c 扫描里根本没有 .cache/ 下的条目",
          lib.invalid_notes.every((n) => !n.rel.startsWith(".cache/")));
      }

      // ── 4c 负控：账本坏掉 ⇒ 未知（不是 0），且不崩 ──
      {
        const KB3 = mkdtempSync(join(tmpdir(), "ab-f4-bad-"));
        try {
          for (const d of ["书籍", "推荐反馈", ".cache/coverage"]) mkdirSync(join(KB3, d), { recursive: true });
          writeFileSync(join(KB3, ".cache", "coverage", "cov_broken.json"), "{ 这不是合法 JSON");
          writeFileSync(join(KB3, ".cache", "coverage", "cov_wrong.json"),
            JSON.stringify({ kind: "something_else", total_units: 999 }));
          const rtBad = createReadingRuntime({ getSettings: () => ({ bookKbDir: KB3 }) });
          const c = await rtBad.coverage();
          truthy("4c 坏账本不让 coverage() 崩", c.ok === true);
          is("4c 一个可用账本都没有 ⇒ units_known=false（未知，**不是 0**）", c.units_known, false);
          is("4c 未知时 total_units 是 null（不是 0）", c.report.coverage.total_units, null);
          is("4c 未知时 analyzed_units 是 null", c.report.coverage.analyzed_units, null);
          is("4c 坏文件被如实列出（2 个）", c.unreadable_ledgers.length, 2);
          truthy("4c 原因里明说「不按 0 处理」", /不按 0 处理/.test(c.units_reason), c.units_reason);
        } finally {
          rmSync(KB3, { recursive: true, force: true });
        }
      }

      // ── 4a 负控：引擎没给作者 ⇒ **不编造**、不写 book 笔记，但 run 笔记照写 ──
      {
        const KB4 = mkdtempSync(join(tmpdir(), "ab-f4-noauthor-"));
        try {
          for (const d of ["书籍", "推荐反馈", ".cache"]) mkdirSync(join(KB4, d), { recursive: true });
          const rtNoAuthor = createReadingRuntime({
            getSettings: () => ({ bookKbDir: KB4 }),
            sidecarFetch: fakeSidecar({ ...ANALYSIS, book: "无作者的书", author: null }),
          });
          const r = await rtNoAuthor.analyzeAndPersist({ book: "无作者的书" });
          truthy("4a 没作者时 run 笔记照常落盘（派生物失败不回滚主产物）", r.ok, JSON.stringify(r).slice(0, 200));
          is("4a 没作者 ⇒ 不写 book 笔记，且如实报 MISSING_AUTHOR",
            r.vault_integrity?.book_note?.code, "MISSING_AUTHOR");
          is("4a 没作者 ⇒ 确实没写出 book 笔记",
            (await (await rtNoAuthor.fileService()).svc.readNote("书籍/无作者的书｜/书籍信息.md")).exists, false);
          truthy("4a 原因里明说「不编造作者」",
            /不编造作者/.test(String(r.vault_integrity?.book_note?.message)),
            String(r.vault_integrity?.book_note?.message));
        } finally {
          rmSync(KB4, { recursive: true, force: true });
        }
      }
    }
  } finally {
    rmSync(KB2, { recursive: true, force: true });
  }
}

// =========================================================================== //
console.log("\n[13] 无法离线验证的项（显式跳过，三分处理）");

{
  skip("真宿主上插件装载 / sessionQuery 运行期注入 / /api/reading/* 真响应",
    "需重启 DSH 宿主才能验证；离线层已由本文件 + test-host.mjs [11] 用忠实替身覆盖。"
    + "重启属 M6 运行期验证步骤，须先征得用户同意");
  skip("真实 45-书籍/ 上的落盘与幂等重放",
    "本文件只在 mkdtemp 临时知识库上做只读投影与越界守卫验证；"
    + "真写盘会改动用户知识库，须先与用户确认目标目录");
}

rmSync(KB, { recursive: true, force: true });

console.log(`\n结果：${pass} 通过 / ${fail} 失败${skipped ? ` / ${skipped} 跳过（环境限制，非通过）` : ""}`);
if (skipped) console.log("注：跳过项在本环境无法验证，不得算作通过。");
process.exit(fail ? 1 : 0);
