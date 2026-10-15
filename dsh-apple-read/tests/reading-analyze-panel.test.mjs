/**
 * tests/reading-analyze-panel.test.mjs · M9「通电：面板触发逐章分析」的诚实性断言
 *
 * ## 这个套件在防什么
 *
 * M9 是**第一次真写知识库**的入口，它最容易出的不是崩溃，而是**说谎**：
 *   · 把「部分完成」显示成「完成」；
 *   · 把未知区域算进已覆盖（宣称 100%）；
 *   · 隐藏失败窗口（显示 0 个）；
 *   · 把「切片完成」当「分析完成」；
 *   · 重复触发被说成「新增」而不是「重算」；
 *   · 前端假成功（不真打后端就显示完成）；
 *   · 宣称「已读懂 / 100%」；
 *   · 同输入重复触发导致重复写盘（并发提交没被挡住）。
 *
 * ## 方法（沿用 M7/M8）
 * 1. **静态断言**：按钮接线、POST 的 URL 与 `lib/index.js` 的路由**逐字符对得上**、CSS 规则存在、
 *    源码里没有硬编码的成功分支。
 * 2. **纯函数断言**：把 `app.js` 的 `READING-VIEW` 区原样截取求值，用夹具调
 *    `renderAnalyzeReport`，对**渲染出来的 HTML** 断言「必须有 / 必须没有」两个方向。
 * 3. **跨层契约**：用 `lib/reading/runtime.js` 的**真实** `buildHonestReport` 把一份
 *    引擎形状的分析翻成 `honest_report`，再喂进面板**真实**的渲染器 —— 字段名/形状不一致立刻红。
 * 4. **行为断言**：把 `ANALYZE-FLOW` 区（`runAnalyze`）原样截取求值，用 `fetch` 替身驱动，
 *    断言「真打了后端」「失败不显示完成」「并发只发一个请求」。
 * 5. 每个检查都必须**可证伪**：`tests/reading-analyze-panel.mutations.mjs` 会把源码故意改坏，
 *    要求本套件变红。
 *
 * 跑法：`node tests/reading-analyze-panel.test.mjs`
 *      变异套件用 `APPLE_READ_UI_ROOT` / `READING_RUNTIME` 指向改坏的副本。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.APPLE_READ_UI_ROOT ?? join(HERE, "..");
const RUNTIME_PATH = process.env.READING_RUNTIME ?? join(HERE, "..", "lib", "reading", "runtime.js");
const PANEL = join(ROOT, "assets", "panel");

let pass = 0, fail = 0, skipped = 0;
const ok = (m) => { pass++; console.log("  ✓ " + m); };
const bad = (m, d) => { fail++; console.log("  ✗ " + m + (d ? "\n      " + d : "")); };
const skip = (m, why) => { skipped++; console.log("  ⊘ 跳过 " + m + " —— " + why); };
const check = (c, m, d) => (c ? ok(m) : bad(m, d));
const isMap = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** 段落级兜底网（沿用 M3/M5/M8 的教训）：变异让断言抛异常时，收成一条可定位的 ✗，而不是崩成零条。 */
let currentSection = "（未进入段落）";
function reportAndExit() {
  console.log(`\n结果：${pass} 通过 / ${fail} 失败${skipped ? ` / ${skipped} 跳过` : ""}`);
  if (skipped) console.log("注：跳过项在本环境无法验证，不得算作通过。");
  process.exit(fail === 0 ? 0 : 1);
}
process.on("uncaughtException", (e) => {
  bad(`[${currentSection}] 套件被异常打断（兜底网，这条也算失败）`,
    String(e?.stack || e).split("\n").slice(0, 3).join("\n      "));
  reportAndExit();
});
process.on("unhandledRejection", (e) => {
  bad(`[${currentSection}] 套件被未处理的 Promise 拒绝打断（兜底网）`,
    String(e?.stack || e).split("\n").slice(0, 3).join("\n      "));
  reportAndExit();
});
const section = (name) => { currentSection = name; console.log(`\n${name}`); };
/** 挂起守卫：变异若把套件挂住（top-level await 永不 settle），也要变成一条可定位的 ✗，而不是静默退出。 */
const watchdog = setTimeout(() => {
  bad("[看门狗] 套件超时未结束（挂起）—— 这条也算失败");
  reportAndExit();
}, 90000);
watchdog.unref?.();

// --------------------------------------------------------------------------- //
// 截取面板的两段源码（原样求值，不复制逻辑）
// --------------------------------------------------------------------------- //
const html = readFileSync(join(PANEL, "index.html"), "utf8");
const css = readFileSync(join(PANEL, "style.css"), "utf8");
const js = readFileSync(join(PANEL, "app.js"), "utf8");
const hostSrc = readFileSync(join(HERE, "..", "lib", "index.js"), "utf8");

const V0 = "/* ==== READING-VIEW BEGIN ==== */";
const V1 = "/* ==== READING-VIEW END ==== */";
const F0 = "/* ==== ANALYZE-FLOW BEGIN ==== */";
const F1 = "/* ==== ANALYZE-FLOW END ==== */";
const region = (src, a, b) => {
  const i = src.indexOf(a);
  const j = src.indexOf(b);
  return i < 0 || j <= i ? null : src.slice(i + a.length, j);
};
const viewSrc = region(js, V0, V1);
const flowSrc = region(js, F0, F1);

section("[0] 模块形状（截取不到就立刻失败）");
check(viewSrc !== null, "app.js 有 READING-VIEW 标记区");
check(flowSrc !== null, "app.js 有 ANALYZE-FLOW 标记区（runAnalyze 所在）");
if (viewSrc === null || flowSrc === null) reportAndExit();

let V = null;
let F = null;
try {
  V = new Function(viewSrc + "\n;return { renderAnalyzeReport, analyzePhase, analyzeStateLabel, ANALYZE_STATES, "
    + "renderAnalyzeCoverage, renderAnalyzeFailures, renderAnalyzeRecompute, renderVaultIntegrity, renderAnalyzeConflict };")();
  ok("READING-VIEW 区求值成功");
} catch (e) {
  bad("READING-VIEW 区求值失败", String(e?.message));
}
try {
  F = new Function("fetch", "state", "API", "renderBooks", "loadReading", "console",
    viewSrc + "\n" + flowSrc + "\n;return { runAnalyze };")();
  ok("ANALYZE-FLOW 区求值成功（fetch/state/API/renderBooks/loadReading 可用替身注入）");
} catch (e) {
  bad("ANALYZE-FLOW 区求值失败", String(e?.message));
}
if (V === null || F === null) reportAndExit();

// --------------------------------------------------------------------------- //
// 夹具（形状对齐 lib/reading/runtime.js 的 buildHonestReport）
// --------------------------------------------------------------------------- //
const baseReport = (over = {}) => ({
  run_id: "rr_0123456789abcdef01234567",
  persisted: true,
  is_recompute: false,
  revision: 1,
  previous_revision: null,
  input_fingerprint_changed: null,
  manual_edit_check: null,
  slices: { count: 228, note: "真消费过的窗口产出的代表切片条数（切片完成 ≠ 分析完成）" },
  candidates: { built: 16, engine_candidates: 16, skipped: [] },
  coverage: {
    scope: "parsed_body",
    denominator_kind: "span_interval_union",
    denominator_note: "分母 = 已解析正文的连续窗口区间并集（重叠不重复计）",
    windows_non_overlapping: true,
    windows_contiguity_violations: [],
    total_units: 57, analyzed_units: 57, failed_units: 0, excluded_units: 0,
    covered_codepoints: 123456, total_codepoints: 123456,
    unknown: { kinds: ["image_pages", "unparsable_files", "non_spine_manifest_items"], counts_known: false, ratio_known: false },
    whole_book_claim_allowed: false,
    whole_book_percent: null,
  },
  failed_windows: { count: 0, queued: 0, reasons: [], retry_requires_explicit_schedule: true },
  complete_for_parsed_body: true,
  layers: { extraction: { units: 57 }, analysis: { complete_for_parsed_body: true }, reading: { known: false } },
  honesty: { book_understood: { allowed: false, reason: "「已读懂」恒不可宣称（PRD :240）" },
    whole_book_claim_allowed: false, note: "…" },
  ...over,
});
const partialReport = () => baseReport({
  slices: { count: 210, note: "n" },
  candidates: { built: 15, engine_candidates: 16, skipped: [{ candidate_id: "ca_x", reason: "no_consumed_slice" }] },
  coverage: { ...baseReport().coverage, analyzed_units: 54, failed_units: 3, covered_codepoints: 117000 },
  failed_windows: {
    count: 3, queued: 3,
    reasons: [
      { window_id: "w_a_0_7", section_id: "sec_a_0", failure_reason: "RECEIPT_HASH_MISMATCH", failure_detail: null },
      { window_id: "w_a_0_8", section_id: "sec_a_0", failure_reason: "EMPTY_SUMMARY", failure_detail: null },
      { window_id: "w_a_0_9", section_id: "sec_a_0", failure_reason: "WINDOW_TEXT_HASH_MISMATCH", failure_detail: null },
    ],
    retry_requires_explicit_schedule: true,
  },
  complete_for_parsed_body: false,
});
const st = (over = {}) => ({ book_id: "b1", title: "第一哲学沉思集", phase: "done", report: baseReport(),
  error: null, note_rel: null, requested_url: "/apple-read/api/reading/analyze-and-persist", ...over });

// --------------------------------------------------------------------------- //
section("[1] 静态接线：按钮 + 路由 + 样式 + 没有硬编码成功");
check(/data-analyze="\$\{esc\(b\.id\)\}"/.test(js), "书库行模板里有「切片与理解」按钮（data-analyze）");
check(js.includes("切片与理解"), "按钮文案是「切片与理解」");
check(!js.includes("整理这本书"), "旧文案「整理这本书」已彻底消失");
// 「不得含读懂」只约束**按钮文案**：面板在诚实文案里必须能说「已读懂不可宣称」，
// 所以不能拿整份源码做全文否定（那会把诚实文案一起误杀）。
const btnSrc = (js.match(/data-analyze[\s\S]{0,500}?<\/button>/) || [""])[0];
check(btnSrc !== "" && !/读懂/.test(btnSrc), "按钮文案里不得出现「读懂」（用户点名禁止）", btnSrc.slice(0, 120));
check(/el\.querySelectorAll\("\[data-analyze\]"\)/.test(js), "按钮绑定了点击处理器");
check(/ev\.stopPropagation\(\)/.test(js), "点「切片与理解」不会顺带触发「选书」");
check(js.includes('id="analyze-result"'), "渲染器输出结果容器 id=analyze-result");
check(/analyzeBlock/.test(js) && /renderAnalyzeReport\(state\.analyze\)/.test(js),
  "书库列表用 renderAnalyzeReport(state.analyze) 渲染结果块（唯一取法）");
check(/\banalyze: null\b/.test(js), "state 里有 analyze 字段");

// 跨文件路由契约：面板拼出来的 URL 必须与 lib/index.js 里的路由**逐字符一致**。
// 注意宿主的匹配顺序：先按 BASE_PATH 前缀进 handler，再在 handler 内匹配去掉前缀的 pathname。
const apiMatch = js.match(/const API = "([^"]+)"/);
const baseMatch = hostSrc.match(/const BASE_PATH = "([^"]+)"/);
const panelUrl = apiMatch ? apiMatch[1] + "/reading/analyze-and-persist" : null;
const hostRoute = "/api/reading/analyze-and-persist";
check(panelUrl !== null, "能读出面板的 API 前缀", String(apiMatch && apiMatch[1]));
check(baseMatch !== null && apiMatch !== null && apiMatch[1] === baseMatch[1] + "/api",
  `面板 API 前缀 == 宿主 BASE_PATH + /api（${apiMatch?.[1]} vs ${baseMatch?.[1]}+/api）`);
check(flowSrc.includes('API + "/reading/analyze-and-persist"'),
  "runAnalyze 里拼的是 API + /reading/analyze-and-persist");
check(hostSrc.includes(`pathname === "${hostRoute}"`), `宿主路由存在：${hostRoute}`);
check(panelUrl === (baseMatch?.[1] ?? "") + hostRoute,
  `面板 URL 与宿主路由逐字符一致：${panelUrl}`);
check(/method:\s*"POST"/.test(flowSrc), "用的是 POST");
check(/body:\s*JSON\.stringify\(\{ book: b\.title \}\)/.test(flowSrc), "请求体带 book（整本书，不做选章）");

// 前端假成功：源码里不许有「不请求就成功」的分支
check(/await fetch\(url,/.test(flowSrc), "runAnalyze 真的 await fetch（不是前端假动作）");
check(/analyzePhase\(report\)/.test(flowSrc), "状态由后端 honest_report 推（analyzePhase），不由点击推");
check(!/phase:\s*"done"/.test(flowSrc), "源码里没有硬编码的 phase:\"done\"");
check(/j\.ok === true/.test(flowSrc), "只有后端 ok===true 才算成功分支");

check(css.includes(".anreport"), "结果块有 CSS 规则（.anreport）");
check(css.includes(".bk-analyze"), "按钮有 CSS 规则（.bk-analyze）");
check(/\.anreport\[data-phase="partial"\]/.test(css), "「部分完成」有独立视觉态（不与完成同色）");
check(/\.anreport\[data-phase="error"\]/.test(css), "「未完成（失败）」有独立视觉态");

// --------------------------------------------------------------------------- //
section("[2] 渲染：完成态（六项必须都出现）");
const doneHtml = V.renderAnalyzeReport(st());
check(/id="analyze-result"[^>]*data-phase="done"/.test(doneHtml), "data-phase=done");
check(/id="ar-state"[^>]*data-state="完成"/.test(doneHtml), "状态文案「完成」");
check(/id="ar-slices"[^>]*>切片：228 条/.test(doneHtml), "① 切片数如实（228）");
check(/id="ar-candidates"[^>]*>候选：16 条可用于推荐/.test(doneHtml), "② 候选数如实（16）");
check(/id="ar-coverage"/.test(doneHtml), "③ 覆盖块存在");
check(/id="ar-failed"[^>]*>失败窗口：0 个/.test(doneHtml), "④ 失败窗口 0 个（真的没有失败）");
check(/id="ar-complete"[^>]*>complete_for_parsed_body：true/.test(doneHtml), "⑤ complete_for_parsed_body=true 如实");
check(/id="ar-run"[^>]*>本次 run_id：<code>rr_0123456789abcdef01234567<\/code>/.test(doneHtml),
  "⑥ 显示本次 run_id");
check(/已落盘/.test(doneHtml), "并说明已落盘");
check(!doneHtml.includes("100%"), "不出现任何「100%」（未知部分存在 ⇒ 不许宣称全书）");
check(!doneHtml.includes("已读懂"), "不出现「已读懂」式宣称");
check(/id="ar-understood"/.test(doneHtml) && /不可宣称/.test(doneHtml), "理解程度显式标「不可宣称」");
check(/首次整理/.test(doneHtml), "首次整理（is_recompute=false）如实说");
check(!/重算/.test(doneHtml), "首次整理时不得说成「重算」");

section("[2b] 渲染：完成态也必须给分母口径与未知部分");
check(/span_interval_union/.test(doneHtml), "覆盖分母口径写明 span 区间并集");
check(/重叠不重复计/.test(doneHtml), "写明重叠不重复计");
check(/已消费 57 \/ 分母 57/.test(doneHtml), "分母与已消费数都显示（57/57）");
check(/自校验：通过/.test(doneHtml), "窗口区间自校验结果可见");
check(/图片页 \/ 不可解析项|image_pages/.test(doneHtml), "未知部分种类可见");
check(/数量可知：否/.test(doneHtml), "未知部分数量「不可知」如实显示（不是 0）");
check(/全书覆盖率：不宣称/.test(doneHtml), "全书覆盖率明确「不宣称」");

// --------------------------------------------------------------------------- //
section("[3] 渲染：部分完成（失败窗口必须可见，不得显示成完成）");
const partHtml = V.renderAnalyzeReport(st({ phase: "partial", report: partialReport() }));
check(/data-phase="partial"/.test(partHtml), "data-phase=partial");
check(/id="ar-state"[^>]*data-state="部分完成"/.test(partHtml), "状态文案「部分完成」");
check(!/id="ar-state"[^>]*data-state="完成"/.test(partHtml), "不得显示成「完成」");
check(/失败窗口：3 个/.test(partHtml), "④ 失败窗口数如实（3，不是 0）");
check(/RECEIPT_HASH_MISMATCH/.test(partHtml) && /EMPTY_SUMMARY/.test(partHtml), "逐窗失败原因可见");
check(/留在队列，不静默丢弃/.test(partHtml), "明说失败窗口留在队列");
check(/complete_for_parsed_body：false/.test(partHtml), "⑤ complete_for_parsed_body=false 如实");
check(/切片完成 ≠ 分析完成/.test(partHtml), "明说切片完成 ≠ 分析完成");
check(!partHtml.includes("100%"), "部分完成也不出现「100%」");
check(!partHtml.includes("已读懂"), "部分完成也不出现「已读懂」");
check(/未采用原因：no_consumed_slice/.test(partHtml), "被丢弃的候选给出原因（不静默）");

section("[3b] 渲染：失败窗口原因缺失时不补齐、不假装 0");
const noReasons = partialReport();
noReasons.failed_windows = { count: 3, queued: 3, reasons: [], retry_requires_explicit_schedule: true };
const noReasonHtml = V.renderAnalyzeReport(st({ phase: "partial", report: noReasons }));
check(/失败窗口：3 个/.test(noReasonHtml), "仍显示真实失败数 3");
check(/只给了 0 条原因，少于失败窗口数 3/.test(noReasonHtml), "原因缺失如实说（不补齐、不编造）");

// --------------------------------------------------------------------------- //
section("[4] 渲染：未完成（失败）—— 不许冒充完成/部分完成");
const errHtml = V.renderAnalyzeReport(st({
  phase: "error", report: baseReport({ persisted: false, run_id: null }),
  error: { code: "NO_ELIGIBLE_CANDIDATES", message: "分析没有产出任何「有真消费切片」的候选" },
}));
check(/data-phase="error"/.test(errHtml), "data-phase=error");
check(/data-state="未完成（失败）"/.test(errHtml), "状态文案「未完成（失败）」");
check(/NO_ELIGIBLE_CANDIDATES/.test(errHtml), "错误码可见");
check(/本次没有写入知识库/.test(errHtml), "明说没有写入知识库");
check(!/id="ar-run"[^>]*已落盘/.test(errHtml), "没落盘时不得显示「已落盘」");
check(!errHtml.includes("100%") && !errHtml.includes("已读懂"), "失败态也不出现 100%/已读懂");

const netHtml = V.renderAnalyzeReport(st({
  phase: "error", report: null, error: { code: "NETWORK_ERROR", message: "Failed to fetch" },
}));
check(/NETWORK_ERROR/.test(netHtml), "网络错误码可见");
check(/后端没有返回 honest_report/.test(netHtml), "没有 honest_report 时如实说（不编）");
check(/没有结果就不显示「完成」/.test(netHtml), "明说不显示「完成」");

check(V.renderAnalyzeReport(null) === "", "state.analyze 为空时不渲染结果块（书库列表不被污染）");
const runningHtml = V.renderAnalyzeReport(st({ phase: "running", report: null }));
check(/data-phase="running"/.test(runningHtml) && /分析中/.test(runningHtml), "分析中态可见");
check(/POST/.test(runningHtml) && /analyze-and-persist/.test(runningHtml), "分析中态显示真实请求 URL");
check(!runningHtml.includes("完成<"), "分析中不得显示「完成」");

// --------------------------------------------------------------------------- //
section("[5] 渲染：重算 vs 新增（不得混）");
const recomp = baseReport({
  run_id: "rr_ffffffffffffffffffffffff", is_recompute: true, revision: 2, previous_revision: 1,
  input_fingerprint_changed: false, manual_edit_check: "match",
});
const recompHtml = V.renderAnalyzeReport(st({ phase: "done", report: recomp }));
check(/id="ar-recompute"/.test(recompHtml) && /重算/.test(recompHtml), "明说是「重算」");
check(/覆盖/.test(recompHtml) && /一条/.test(recompHtml), "说清覆盖的是**同一条**理解笔记");
check(/revision 从 1 递增到 2/.test(recompHtml), "显示 revision 从 1 递增到 2");
check(/run_id<\/code> 不变/.test(recompHtml), "明说 run_id 不变（身份没换）");
check(/不是「新增了一次」/.test(recompHtml), "明说不是「新增了一次」");
check(!/首次整理/.test(recompHtml), "重算时不得说成「首次整理」");
check(!/stale/.test(recompHtml), "重算说明里不得再提 stale（新模型不写 stale）");
check(/本次 run_id：<code>rr_ffffffffffffffffffffffff<\/code>/.test(recompHtml), "显示的是这条笔记的 run_id");

// 输入变了 ⇒ 如实说这份理解是按新输入重算的（不假装还是同一份输入）
const recompChanged = baseReport({ is_recompute: true, revision: 3, previous_revision: 2, input_fingerprint_changed: true });
const changedHtml = V.renderAnalyzeReport(st({ phase: "done", report: recompChanged }));
check(/输入与上一版<strong>不同<\/strong>/.test(changedHtml) && /input_fingerprint/.test(changedHtml),
  "输入变化时如实说「按新输入重算」");

// 后端没给「输入是否变化」⇒ 明说不猜（不默认成「没变」）
const recompUnknown = baseReport({ is_recompute: true, revision: 2, previous_revision: 1, input_fingerprint_changed: null });
const unknownHtml = V.renderAnalyzeReport(st({ phase: "done", report: recompUnknown }));
check(/不猜/.test(unknownHtml), "没给「输入是否变化」时明说不猜");
check(!/输入与上一版/.test(unknownHtml), "没给时不得编出「输入变了」");

// 手改被挡（2b）时走的是 error 路径：错误消息必须原样给用户看
const blockedRep = baseReport({ persisted: false, is_recompute: true, revision: 2, previous_revision: 1,
  manual_edit_check: "mismatch" });
const blockedSt = { phase: "error", report: blockedRep,
  error: { code: "HASH_CONFLICT", message: "这条笔记你改过，我没有覆盖：盘上的内容与上次写进去的不一致" } };
const blockedHtml = V.renderAnalyzeReport(st(blockedSt));
check(/你改过/.test(blockedHtml) && /没有覆盖/.test(blockedHtml), "手改被挡时如实把「你改过，我没有覆盖」显示出来");

// --------------------------------------------------------------------------- //
section("[5b] 派生产物（vault_integrity）：成功 / NO_CHANGE / 失败必须分开且看得见");
// 形状对齐 lib/reading/runtime.js 的 writeVaultIntegrity：
//   { book_note: {written, code, note_rel, message}, coverage_ledger: {written, code, ref, message} }
const viBoth = {
  book_note: { written: true, code: null, note_rel: "书籍/《X》｜作者/书籍信息.md", message: "已写入书籍信息笔记（external_master.status=unverified）" },
  coverage_ledger: { written: true, code: null, ref: ".cache/coverage/cov_f7f4f1fc3778c58a.json", message: "已写入覆盖账本" },
};
const okBothHtml = V.renderAnalyzeReport(st({ phase: "done", report: baseReport(), vault_integrity: viBoth }));
check(/id="ar-vault"/.test(okBothHtml), "结果块里有派生产物区（id=ar-vault）");
check(/id="ar-vault-book"/.test(okBothHtml) && /id="ar-vault-ledger"/.test(okBothHtml),
  "书籍信息笔记与覆盖账本**分开**显示（两个独立 id）");
check(/书籍信息笔记：<strong>已写入<\/strong>/.test(okBothHtml), "书档成功显示「已写入」");
check(/覆盖账本：<strong>已写入<\/strong>/.test(okBothHtml), "账本成功显示「已写入」");
check(/cov_f7f4f1fc3778c58a\.json/.test(okBothHtml), "账本显示具体 ref");

// NO_CHANGE 是正常结果，不是失败，但必须如实说明
const viNoChange = {
  book_note: { written: false, code: "NO_CHANGE", note_rel: "书籍/《X》｜作者/书籍信息.md", message: "同一本书同一版本 ⇒ 不重写" },
  coverage_ledger: { written: true, code: null, ref: ".cache/coverage/cov_f7f4f1fc3778c58a.json", message: "已写入覆盖账本" },
};
const ncHtml = V.renderAnalyzeReport(st({ phase: "done", report: baseReport({ is_recompute: true }), vault_integrity: viNoChange }));
check(/书档|书籍信息笔记/.test(ncHtml) && /未改写（NO_CHANGE）/.test(ncHtml), "NO_CHANGE 如实显示为「未改写」，不显示成失败");
check(!/书籍信息笔记：<strong>失败<\/strong>/.test(ncHtml), "NO_CHANGE 不得显示成失败");
check(/同一本书同一版本/.test(ncHtml), "NO_CHANGE 带出后端给的原因");

// 派生产物失败：必须高亮、必须带 code 与原因、必须说清主产物不受影响
const viBookFail = {
  book_note: { written: false, code: "MISSING_AUTHOR", note_rel: null, message: "引擎没给出作者 ⇒ 不编造作者，不写书籍信息笔记" },
  coverage_ledger: { written: true, code: null, ref: ".cache/coverage/cov_f7f4f1fc3778c58a.json", message: "已写入覆盖账本" },
};
const bfHtml = V.renderAnalyzeReport(st({ phase: "done", report: baseReport(), vault_integrity: viBookFail }));
check(/id="ar-vault-book"[^>]*/.test(bfHtml) && /书籍信息笔记：<strong>失败<\/strong>/.test(bfHtml), "书档失败显示为「失败」");
check(/MISSING_AUTHOR/.test(bfHtml), "失败带出 code");
check(/不编造作者/.test(bfHtml), "失败带出后端给的原因");
check(/arbad/.test((bfHtml.match(/<div class="arline[^"]*" id="ar-vault-book"/) || [""])[0]), "失败项用 arbad 高亮（醒目，不静默）");
check(/主产物（run 笔记）不受影响/.test(bfHtml), "说清「派生物失败不回滚主产物」，但不因此吞掉失败");

// 账本失败同样必须看得见（两类不能只报一类）
const viLedgerFail = {
  book_note: { written: true, code: null, note_rel: "书籍/《X》｜作者/书籍信息.md", message: "已写入" },
  coverage_ledger: { written: false, code: "COVERAGE_LEDGER_FAILED", ref: null, message: "账本没写成：磁盘满" },
};
const lfHtml = V.renderAnalyzeReport(st({ phase: "done", report: baseReport(), vault_integrity: viLedgerFail }));
check(/覆盖账本：<strong>失败<\/strong>/.test(lfHtml) && /COVERAGE_LEDGER_FAILED/.test(lfHtml), "账本失败同样看得见（带 code）");
check(/磁盘满/.test(lfHtml), "账本失败带出原因");

// 后端漏给字段 ⇒ unknown，**不当作成功**
const viMissing = { book_note: { written: true, code: null, note_rel: "x", message: "" } };
const missHtml = V.renderAnalyzeReport(st({ phase: "done", report: baseReport(), vault_integrity: viMissing }));
check(/id="ar-vault-ledger"[^>]*unknown/.test(missHtml) || /覆盖账本：unknown/.test(missHtml), "缺账本一项 ⇒ 显示 unknown，不当作成功");
check(/不当作成功/.test(missHtml), "缺字段时明说「不当作成功」");

// 整个 vault_integrity 都没给（且已落盘）⇒ unknown，不当作成功
const noViHtml = V.renderAnalyzeReport(st({ phase: "done", report: baseReport(), vault_integrity: null }));
check(/id="ar-vault"[^>]*/.test(noViHtml) && /unknown/.test(noViHtml), "后端没给 vault_integrity ⇒ 显示 unknown");
check(/不当作成功/.test(noViHtml), "没给时明说「不当作成功」");

// 没落盘 ⇒ 根本没走到写盘，不能说成 unknown（两回事）
const notPersistedHtml = V.renderAnalyzeReport(st({ phase: "error", report: baseReport({ persisted: false }), vault_integrity: null }));
check(/没有落盘/.test(notPersistedHtml) && /没走到写盘这一步/.test(notPersistedHtml),
  "没落盘时说「没走到写盘这一步，没有派生产物可报」，而不是 unknown");

// 纯函数单测：renderVaultIntegrity 的三种输入
check(/unknown/.test(V.renderVaultIntegrity(null, true)), "renderVaultIntegrity(null, persisted=true) ⇒ unknown");
check(/没有落盘/.test(V.renderVaultIntegrity(null, false)), "renderVaultIntegrity(null, persisted=false) ⇒ 没走到写盘");
check(/已写入/.test(V.renderVaultIntegrity({ book_note: { written: true, note_rel: "a", message: "" }, coverage_ledger: { written: true, ref: "b", message: "" } }, true)),
  "renderVaultIntegrity 两项都成功 ⇒ 都显示已写入");

// 诚实：派生产物区不得宣称「已读懂」
check(!/已读懂/.test(okBothHtml) && !/已读懂/.test(bfHtml), "派生产物区不得出现「已读懂」");

// --------------------------------------------------------------------------- //
section("[5c] 手改被挡：说明必须显眼，且**不许**谎称「覆盖了它」");
// 实测形状（真实响应）：手改被挡时 persisted=false + is_recompute=true + revision 3 / previous_revision 2
const conflictRep = (over = {}) => baseReport({
  persisted: false, is_recompute: true, revision: 3, previous_revision: 2,
  manual_edit_check: "mismatch", ...over,
});
const conflictSt = (over = {}, errOver = {}) => st({
  phase: "error", report: conflictRep(over),
  error: { code: "HASH_CONFLICT", message: "这条笔记你改过，我没有覆盖：盘上的内容与上次写进去的不一致", ...errOver },
});
const cHtml = V.renderAnalyzeReport(conflictSt());

check(/id="ar-conflict"/.test(cHtml), "手改被挡时有专门的说明块（id=ar-conflict）");
// 显眼：必须排在六项内容之前（原本埋在结果块最底下）
check(cHtml.indexOf('id="ar-conflict"') < cHtml.indexOf('id="ar-slices"'),
  "说明块排在「切片」等内容**之前**（不埋在最后一行）");
check(/这条笔记你改过，我没有覆盖它/.test(cHtml), "直说「你改过，我没有覆盖它」");
check(/一动没动/.test(cHtml), "说清盘上那份**一动没动**（用户最怕的就是被盖）");
check(/revision 仍是 2/.test(cHtml), "带出盘上那份的真实 revision（2）");
check(/本版没有「强制覆盖」开关/.test(cHtml), "明说没有强制覆盖开关（不假装有）");
check(/并进系统那份/.test(cHtml) && /再点一次/.test(cHtml), "给出下一步怎么办");

// 两种停手原因**不能混**（内容对不上 vs 查不到记录）
const noRecHtml = V.renderAnalyzeReport(conflictSt({ manual_edit_check: "no_record" }));
check(/事务记录已不可考/.test(noRecHtml), "no_record 如实说「查不到这条笔记是谁写的」");
check(!/不一致<\/strong>/.test(noRecHtml), "no_record 不得说成「内容不一致」（两种原因不混）");
const unknownChkHtml = V.renderAnalyzeReport(conflictSt({ manual_edit_check: null }));
check(/没有给出具体原因/.test(unknownChkHtml) && /不猜/.test(unknownChkHtml),
  "后端没给 manual_edit_check ⇒ 说不猜，不编原因");

// 非 HASH_CONFLICT 的失败不得出现这个块（不张冠李戴）
const otherErrHtml = V.renderAnalyzeReport(st({ phase: "error", report: baseReport({ persisted: false }),
  error: { code: "ENGINE_DOWN", message: "引擎没起来" } }));
check(!/id="ar-conflict"/.test(otherErrHtml), "别的失败原因不渲染手改说明块");
check(V.renderAnalyzeConflict({ error: { code: "OTHER" } }) === "", "renderAnalyzeConflict 非 HASH_CONFLICT 返回空串");

// ★ 复算不得撒谎：没落盘 ⇒ **什么都没覆盖**
const ncRecompute = V.renderAnalyzeReport(conflictSt());
check(/没有覆盖任何东西/.test(ncRecompute), "没落盘的复算如实说「没有覆盖任何东西」");
check(!/本次<strong>覆盖<\/strong>了它/.test(ncRecompute), "没落盘的复算**不得**说「本次覆盖了它」（实测过的撒谎点）");
check(/本次想写的是 3，没写成/.test(ncRecompute), "说清「想写 3 但没写成」");

// 回归护栏：**真落盘**的复算仍然要说「覆盖了它」（别把正确的话一起改掉）
const okRecompute = V.renderAnalyzeReport(st({ phase: "done", report: baseReport({
  is_recompute: true, revision: 2, previous_revision: 1, persisted: true, manual_edit_check: "match" }) }));
check(/本次<strong>覆盖<\/strong>了它/.test(okRecompute), "落盘成功的复算仍说「覆盖了它」（回归护栏）");
check(/revision 从 1 递增到 2/.test(okRecompute), "落盘成功仍显示 revision 递增");

// 诚实：手改说明块不得出现「已读懂」
check(!/已读懂/.test(cHtml) && !/已读懂/.test(ncRecompute), "手改说明块不含「已读懂」");

// --------------------------------------------------------------------------- //
section("[6] analyzePhase：缺字段一律不宣称完成（保守）");
check(V.analyzePhase(baseReport()) === "done", "完整且无失败 ⇒ done");
check(V.analyzePhase(partialReport()) === "partial", "有失败窗口 ⇒ partial");
check(V.analyzePhase(baseReport({ complete_for_parsed_body: false })) === "partial",
  "切片完成但 complete=false ⇒ partial（切片完成 ≠ 分析完成）");
check(V.analyzePhase(baseReport({ persisted: false })) === "error", "没落盘 ⇒ error");
check(V.analyzePhase(baseReport({ failed_windows: { count: null } })) === "partial",
  "失败窗口数未知 ⇒ 不宣称完成");
check(V.analyzePhase(null) === "error", "没有 report ⇒ error");
check(V.analyzePhase(baseReport({ slices: { count: 999 }, complete_for_parsed_body: false })) === "partial",
  "切片很多也不能推出「分析完成」");
check(V.analyzeStateLabel("unknown-phase") === "未完成（失败）", "未知 phase 落回失败态（不落回完成）");

// --------------------------------------------------------------------------- //
section("[7] 跨层契约：runtime.buildHonestReport 的真实输出 → 面板真实渲染");
const { createReadingRuntime } = await import(RUNTIME_PATH);
const rt = createReadingRuntime({ getSettings: () => ({}), sidecarFetch: null, logger: () => {} });
check(typeof rt.buildHonestReport === "function", "runtime 导出 buildHonestReport（面板依赖的字段源）");
check(typeof rt.windowsContiguity === "function", "runtime 导出 windowsContiguity（分母口径自校验）");

// 引擎形状的分析（字段照 books_rag.py analyze_chapter 的返回；e2e 会拿真引擎输出对齐键集合）
const engineAnalysis = (over = {}) => ({
  ok: true, analysis_version: "an_m8", book: "第一哲学沉思集", author: "笛卡尔",
  book_version_id: "bv_test", content_id: "abcd1234abcd1234",
  chapters: [{ section_id: "sec_abcd1234abcd1234_0", order: 0, window_count: 2 }],
  windows: [
    { window_id: "w_abcd1234abcd1234_0_0", section_id: "sec_abcd1234abcd1234_0", index: 0, start_codepoint: 0,
      end_codepoint: 3000, chars: 3000, text_hash: "h1", status: "processed", consumed: true, failure_reason: null },
    { window_id: "w_abcd1234abcd1234_0_1", section_id: "sec_abcd1234abcd1234_0", index: 1, start_codepoint: 3000,
      end_codepoint: 5000, chars: 2000, text_hash: "h2", status: "failed", consumed: false,
      failure_reason: "RECEIPT_HASH_MISMATCH", failure_detail: null },
  ],
  slices: [{ slice_id: "sp_abcd1234abcd1234_0_0_100", window_id: "w_abcd1234abcd1234_0_0", text_hash: "s1" }],
  candidates: [{ candidate_id: "ca_abcd1234abcd1234_0", section_id: "sec_abcd1234abcd1234_0", section_order: 0, slice_ids: ["sp_abcd1234abcd1234_0_0_100"] }],
  queue: { pending_window_ids: ["w_abcd1234abcd1234_0_1"], failed_window_ids: ["w_abcd1234abcd1234_0_1"],
    retry_requires_explicit_schedule: true },
  coverage: {
    scope: "parsed_body", total_units: 2, analyzed_units: 1, failed_units: 1, excluded_units: 0,
    covered_codepoints: 3000, total_codepoints: 5000,
    unknown: { kinds: ["image_pages"], counts_known: false, ratio_known: false },
    whole_book_claim_allowed: false, whole_book_percent: null,
  },
  honesty: {
    book_understood: { allowed: false },
    layers: { extraction: { units: 2 }, analysis: { complete_for_parsed_body: false }, reading: { known: false } },
  },
  ...over,
});

const realRep = rt.buildHonestReport(engineAnalysis(), {
  candidates_built: 1, candidates_skipped: [{ candidate_id: "ca_other", reason: "no_consumed_slice" }],
  run_id: "rr_abcabcabcabcabcabcabcabc", persisted: true, is_recompute: false, revision: 1,
  previous_revision: null, input_fingerprint_changed: null, manual_edit_check: null,
});
// 字段契约：渲染器读的每个键都必须真的存在（改名/挪位立刻红）
for (const k of ["run_id", "persisted", "is_recompute", "revision", "previous_revision",
  "input_fingerprint_changed", "slices", "candidates",
  "coverage", "failed_windows", "complete_for_parsed_body", "honesty"]) {
  check(Object.prototype.hasOwnProperty.call(realRep, k), `honest_report 有键 ${k}`);
}
check(realRep.failed_windows?.count === 1, "真失败窗口被数出来（1）");
check(realRep.failed_windows?.reasons?.[0]?.failure_reason === "RECEIPT_HASH_MISMATCH", "逐窗原因被透出");
check(realRep.coverage.denominator_kind === "span_interval_union", "分母口径是区间并集");
check(realRep.coverage.windows_non_overlapping === true, "窗口自校验：无重叠");
check(realRep.coverage.whole_book_percent === null && realRep.coverage.whole_book_claim_allowed === false,
  "不编全书百分比、不许宣称全书");
check(realRep.complete_for_parsed_body === false, "complete_for_parsed_body 由分析层给出（false）");
check(realRep.slices.count === 1, "切片数来自真分析输出");
check(realRep.honesty.book_understood.allowed === false, "「已读懂」恒不可宣称");
check(V.analyzePhase(realRep) === "partial", "真输出喂进面板 ⇒ partial（不是 done）");

const realHtml = V.renderAnalyzeReport({ book_id: "b1", title: "第一哲学沉思集", phase: V.analyzePhase(realRep),
  report: realRep, error: null, note_rel: "推荐反馈/rr_abcabcabcabcabcabcabcabc.md", requested_url: "x" });
check(/失败窗口：1 个/.test(realHtml), "渲染出真实失败数 1");
check(/RECEIPT_HASH_MISMATCH/.test(realHtml), "渲染出真实失败原因");
check(/complete_for_parsed_body：false/.test(realHtml), "渲染出真实 complete=false");
check(/rr_abcabcabcabcabcabcabcabc/.test(realHtml), "渲染出真实 run_id");
check(/推荐反馈\/rr_abcabcabcabcabcabcabcabc\.md/.test(realHtml), "渲染出真实落盘路径");
check(!realHtml.includes("100%") && !realHtml.includes("已读懂"), "真实输出渲染后仍无 100%/已读懂");

section("[7b] 负控：窗口重叠时不许说「通过」（分母会被灌水）");
const overlapping = engineAnalysis({
  windows: [
    { window_id: "w_0", section_id: "sec_a", index: 0, start_codepoint: 0, end_codepoint: 3000, chars: 3000, consumed: true, failure_reason: null },
    { window_id: "w_1", section_id: "sec_a", index: 1, start_codepoint: 2500, end_codepoint: 5000, chars: 2500, consumed: true, failure_reason: null },
  ],
});
const ovRep = rt.buildHonestReport(overlapping, { candidates_built: 1, persisted: true, run_id: "rr_x" });
check(ovRep.coverage.windows_non_overlapping === false, "重叠被自己算出来（不靠引擎自报）");
check(ovRep.coverage?.windows_contiguity_violations?.length === 1, "给出不连续的具体位置");
const ovHtml = V.renderAnalyzeReport({ title: "t", phase: V.analyzePhase(ovRep), report: ovRep, error: null });
check(/自校验：未通过/.test(ovHtml), "渲染成「未通过」（不显示成通过）");
check(/分母可能被灌水/.test(ovHtml), "并说明分母可能被灌水");

// --------------------------------------------------------------------------- //
section("[8] 行为：runAnalyze 真打后端 / 失败不显示完成 / 并发只发一个请求");
const calls = [];
const makeState = (books) => ({
  books: books ?? [{ id: "b1", title: "第一哲学沉思集", path: "/lib/第一哲学沉思集.epub" }],
  analyze: null,
  auto: {},
});
const resp = (obj, status = 200) => ({ status, text: async () => JSON.stringify(obj) });
const FLOW_FACTORY = new Function("fetch", "state", "API", "renderBooks", "loadReading", "console",
  viewSrc + "\n" + flowSrc + "\n;return { runAnalyze, autoUnderstanding, renderAutoNote };");

/** 用 fetch 替身驱动**原样截取**的 runAnalyze（不复制它的逻辑）。 */
function bindFlow({ state, fetchStub, renderBooks = () => {}, loadReading = async () => {} }) {
  return FLOW_FACTORY(fetchStub, state, "/apple-read/api", renderBooks, loadReading, console).runAnalyze;
}

/** 同上，但要 autoUnderstanding（3b）。 */
function bindAuto({ state, fetchStub, renderBooks = () => {}, loadReading = async () => {} }) {
  return FLOW_FACTORY(fetchStub, state, "/apple-read/api", renderBooks, loadReading, console);
}
function queueFetch(responses) {
  return async (url, init) => {
    calls.push({ url, init });
    const r = responses.shift();
    if (r instanceof Error) throw r;
    return r;
  };
}

// 8a 成功：真打后端 + 六项来自响应
calls.length = 0;
{
  const state = makeState();
  let loaded = 0;
  const run = bindFlow({
    state,
    fetchStub: queueFetch([resp({ ok: true, run_id: "rr_1", note_rel: "推荐反馈/rr_1.md", honest_report: baseReport() })]),
    loadReading: async () => { loaded += 1; },
  });
  const r = await run("b1");
  check(calls.length === 1, "发起了 1 次真实请求");
  check(calls[0]?.url === "/apple-read/api/reading/analyze-and-persist", "打到真实路由", calls[0]?.url);
  check(calls[0]?.init?.method === "POST", "方法是 POST");
  check(calls[0]?.init?.body === JSON.stringify({ book: "第一哲学沉思集" }), "请求体只有 book（整本书）");
  check(r.phase === "done" && r.ok === true, "状态由响应推出：done");
  check(state.analyze.report !== null && state.analyze.report.slices.count === 228, "响应里的 honest_report 被保存");
  check(loaded === 1, "落盘成功后刷新「导读」Tab");
}

// 8a-2 派生产物必须被带进 state.analyze（否则渲染器拿不到，失败就看不见了）
calls.length = 0;
{
  const state = makeState();
  const vi = {
    book_note: { written: false, code: "MISSING_AUTHOR", note_rel: null, message: "不编造作者" },
    coverage_ledger: { written: true, code: null, ref: ".cache/coverage/cov_x.json", message: "已写入覆盖账本" },
  };
  const run = bindFlow({ state, fetchStub: queueFetch([resp({ ok: true, run_id: "rr_1", note_rel: "推荐反馈/rr_1.md", honest_report: baseReport(), vault_integrity: vi })]),
    loadReading: async () => {} });
  await run("b1");
  check(state.analyze.vault_integrity !== null && state.analyze.vault_integrity.book_note.code === "MISSING_AUTHOR",
    "成功响应里的 vault_integrity 被原样保存（含失败项）");
  const html = V.renderAnalyzeReport(state.analyze);
  check(/书籍信息笔记：<strong>失败<\/strong>/.test(html) && /MISSING_AUTHOR/.test(html),
    "后端报派生物失败时，面板真的把它渲染出来（失败不静默）");
}
calls.length = 0;
{
  const state = makeState();
  const vi = { book_note: { written: true, code: null, note_rel: "a", message: "" }, coverage_ledger: { written: false, code: "COVERAGE_LEDGER_FAILED", ref: null, message: "磁盘满" } };
  const run = bindFlow({ state, fetchStub: queueFetch([resp({ ok: false, code: "HASH_CONFLICT", message: "你改过", honest_report: baseReport({ persisted: false }), vault_integrity: vi })]) });
  await run("b1");
  check(state.analyze.vault_integrity !== null && state.analyze.vault_integrity.coverage_ledger.code === "COVERAGE_LEDGER_FAILED",
    "失败响应里的 vault_integrity 也被保存（不因 ok=false 就丢掉）");
}
calls.length = 0;
{
  const state = makeState();
  const run = bindFlow({ state, fetchStub: queueFetch([resp({ ok: true, run_id: "rr_1", honest_report: baseReport() })]) });
  await run("b1");
  check(state.analyze.vault_integrity === null, "后端没给 vault_integrity ⇒ 保存为 null（不编一份假的成功）");
}

// 8b 后端失败：不许显示完成
calls.length = 0;
{
  const state = makeState();
  const run = bindFlow({ state, fetchStub: queueFetch([resp({ ok: false, code: "NO_ELIGIBLE_CANDIDATES", message: "没有候选" })]) });
  const r = await run("b1");
  check(r.phase === "error" && r.ok === false, "后端 ok=false ⇒ 状态 error（不是 done）");
  check(state.analyze.error?.code === "NO_ELIGIBLE_CANDIDATES", "错误码被保留");
  const h = V.renderAnalyzeReport(state.analyze);
  check(/data-state="未完成（失败）"/.test(h), "渲染成「未完成（失败）」");
}

// 8c 网络异常
calls.length = 0;
{
  const state = makeState();
  const run = bindFlow({ state, fetchStub: queueFetch([new Error("Failed to fetch")]) });
  const r = await run("b1");
  check(r.phase === "error" && state.analyze.error?.code === "NETWORK_ERROR", "网络异常 ⇒ error（不假装成功）");
}

// 8d 非 JSON 响应
calls.length = 0;
{
  const state = makeState();
  const run = bindFlow({ state, fetchStub: queueFetch([{ status: 502, text: async () => "<html>bad gateway</html>" }]) });
  const r = await run("b1");
  check(r.phase === "error" && state.analyze.error?.code === "BAD_RESPONSE", "非 JSON ⇒ BAD_RESPONSE");
}

// 8e 并发：同一本书连点两次，只发一个请求（防重复提交）
// 用「限时竞速」而不是直接 await：若变异把防重复提交拿掉，第二次调用会真的去打后端并卡在
// gate 上 —— 直接 await 会让套件**挂死**（分不清「抓到」还是「没抓到」），这里必须变成一条 ✗。
calls.length = 0;
{
  const state = makeState();
  let release;
  const gate = new Promise((res) => { release = res; });
  const fetchStub = async (url, init) => {
    calls.push({ url, init });
    await gate;
    return resp({ ok: true, run_id: "rr_1", honest_report: baseReport() });
  };
  const run = bindFlow({ state, fetchStub });
  const p1 = run("b1");
  const r2 = await Promise.race([
    run("b1").then((x) => x),
    new Promise((res) => setTimeout(() => res(null), 400)),
  ]);
  check(calls.length === 1, "并发第二次点击没有发第二个请求", `calls=${calls.length}`);
  check(r2 !== null && r2.code === "ALREADY_RUNNING", "第二次点击被明确拒绝（ALREADY_RUNNING）",
    r2 === null ? "第二次点击没有在 400ms 内返回（说明它真的去打了后端）" : JSON.stringify(r2));
  release();
  const r1 = await p1;
  check(r1.phase === "done", "第一次请求正常完成");
}

// 8f 立即反馈：runAnalyze 必须在**等后端之前**就把「分析中」渲染出来。
// 这条用「永不 resolve 的 fetch」确定性钉住，不靠计时运气。
calls.length = 0;
{
  const state = makeState();
  let renderCalls = 0;
  let phaseAtRender = null;
  const fetchStub = async (url, init) => { calls.push({ url, init }); return new Promise(() => {}); };
  const run = bindFlow({
    state, fetchStub,
    renderBooks: () => { renderCalls += 1; phaseAtRender = state.analyze && state.analyze.phase; },
  });
  void run("b1");                       // 故意不 await：后端永远不返回
  check(renderCalls >= 1, "runAnalyze 在等后端之前就先渲染了一次（用户有立即反馈）");
  check(phaseAtRender === "running", `那次渲染时 phase=running（实际 ${phaseAtRender}）`);
  check(state.analyze.phase === "running", "state.analyze.phase=running");
  const h = V.renderAnalyzeReport(state.analyze);
  check(/data-phase="running"/.test(h) && /分析中/.test(h), "「分析中」真的渲染得出来（不是只有状态没界面）");
  check(!h.includes("完成<"), "「分析中」不会显示成「完成」");
  check(state.analyze.response_ok === null, "还没有响应时 response_ok=null（不预设成功）");
}

// --------------------------------------------------------------------------- //
section("[9] 行为：3b 打开书自动跑「切片与理解」，但只在**确实没有**当前理解时才跑");

// 9a 后端说「盘上没有这条笔记」⇒ 自动跑第一次（两个请求：先问状态，再分析）
calls.length = 0;
{
  const state = makeState();
  const A = bindAuto({
    state,
    fetchStub: queueFetch([
      resp({ ok: true, checked: true, auto_trigger_allowed: true, has_current_understanding: false,
        run_id: "rr_a", note_rel: "推荐反馈/rr_a.md", message: "盘上没有这本书的理解笔记 ⇒ 可以自动跑第一次" }),
      resp({ ok: true, run_id: "rr_a", note_rel: "推荐反馈/rr_a.md", honest_report: baseReport() }),
    ]),
  });
  const r = await A.autoUnderstanding("b1");
  check(calls.length === 2, "确实没有理解时：先问状态、再真跑分析（2 个请求）", `calls=${calls.length}`);
  check(calls[0]?.url === "/apple-read/api/reading/understanding-status?path=" + encodeURIComponent("/lib/第一哲学沉思集.epub"),
    "第一个请求把**引擎给的 path 原样**送给后端（不在前端算身份）", calls[0]?.url);
  check(calls[1]?.url === "/apple-read/api/reading/analyze-and-persist", "第二个请求才是真分析", calls[1]?.url);
  check(r.code === "AUTO_RAN" && state.auto.b1.phase === "ran", "自动跑完记为 ran");
}

// 9b 后端说「已有当前理解」⇒ **不自动重跑**（只 1 个请求）
calls.length = 0;
{
  const state = makeState();
  const A = bindAuto({
    state,
    fetchStub: queueFetch([
      resp({ ok: true, checked: true, auto_trigger_allowed: false, has_current_understanding: true,
        state: "ready", revision: 3, run_id: "rr_b", note_rel: "推荐反馈/rr_b.md",
        message: "已有当前理解（revision 3）⇒ 打开这本书时**不自动重跑**；要重算请手动点「切片与理解」" }),
    ]),
  });
  const r = await A.autoUnderstanding("b1");
  check(calls.length === 1, "已有理解时不自动重跑（只问了状态，没有发起分析）", `calls=${calls.length}`);
  check(r.code === "SKIPPED" && state.auto.b1.phase === "skipped", "记为 skipped");
  check(state.auto.b1.has_current_understanding === true && state.auto.b1.revision === 3, "把「已有理解 + revision」如实记下");
  check(state.analyze === null, "没有触碰 state.analyze（没有假装跑过）");
  const html = A.renderAutoNote(state.books[0]);
  check(/已有理解（revision 3）/.test(html) && /未自动重跑/.test(html), "面板如实说「已有理解 · 未自动重跑」", html);
}

// 9c 后端**没能确认**（读不到知识库）⇒ 不自动跑，且明说「不猜成没有」
calls.length = 0;
{
  const state = makeState();
  const A = bindAuto({
    state,
    fetchStub: queueFetch([
      resp({ ok: false, checked: false, code: "PATH_OUT_OF_SCOPE",
        message: "读不到知识库 ⇒ 无法确认是否已有理解；**不猜成「没有」**" }),
    ]),
  });
  const r = await A.autoUnderstanding("b1");
  check(calls.length === 1, "无法确认时没有自动跑（猜「没有」会覆盖已有理解）", `calls=${calls.length}`);
  check(r.code === "UNCHECKED" && state.auto.b1.checked === false, "记为 UNCHECKED 且 checked=false");
  check(/不猜成/.test(state.auto.b1.message), "把后端「不猜成没有」的原因原样保留", state.auto.b1.message);
  check(state.analyze === null, "没有发起分析");
}

// 9d 去重：同一本书判定过就不再重复请求（来回切书不会反复触发）
calls.length = 0;
{
  const state = makeState();
  const A = bindAuto({
    state,
    fetchStub: queueFetch([
      resp({ ok: true, checked: true, auto_trigger_allowed: false, has_current_understanding: true,
        state: "ready", revision: 1, message: "已有当前理解" }),
    ]),
  });
  await A.autoUnderstanding("b1");
  const n1 = calls.length;
  const r2 = await A.autoUnderstanding("b1");
  await A.autoUnderstanding("b1");
  check(n1 === 1 && calls.length === 1, "同一本书只判定一次（第二次直接短路，不再打后端）", `calls=${calls.length}`);
  check(r2.code === "ALREADY_CHECKED", "第二次返回 ALREADY_CHECKED");
}

// 9e 引擎没给 path ⇒ 不猜、不自动跑、一个请求都不发
calls.length = 0;
{
  const state = makeState([{ id: "b1", title: "无路径的书" }]);
  const A = bindAuto({ state, fetchStub: queueFetch([]) });
  const r = await A.autoUnderstanding("b1");
  check(calls.length === 0, "没有 path 时一个请求都不发（算不出身份就不猜）", `calls=${calls.length}`);
  check(r.code === "NO_PATH" && state.auto.b1.phase === "skipped", "记为 skipped（NO_PATH）");
  check(/没有自动运行/.test(state.auto.b1.message), "如实说明「没有自动运行」", state.auto.b1.message);
}

// 9f 手动点击**永远**会执行（不受自动判定结果影响）
calls.length = 0;
{
  const state = makeState();
  const A = bindAuto({
    state,
    fetchStub: queueFetch([
      resp({ ok: true, checked: true, auto_trigger_allowed: false, has_current_understanding: true,
        state: "ready", revision: 2, message: "已有当前理解" }),
      resp({ ok: true, run_id: "rr_1", note_rel: "推荐反馈/rr_1.md",
        honest_report: baseReport({ is_recompute: true, revision: 3, previous_revision: 2 }) }),
    ]),
  });
  await A.autoUnderstanding("b1");          // 自动：跳过
  const before = calls.length;
  const r = await A.runAnalyze("b1");        // 手动：必须执行
  check(calls.length === before + 1, "自动跳过之后，手动点按钮仍然发起了分析", `calls=${calls.length}`);
  check(r.ok === true && r.phase === "done", "手动点击执行成功（手动＝明确要求重算）");
}

// 9g 静态：面板不自己算身份（不出现 sha1/sha256），只把引擎给的 path 送回去
check(!/sha1|sha256|createHash/i.test(flowSrc), "面板源码里没有第二套身份实现（sha1/sha256 一律不出现）");
check(/understanding-status\?path=/.test(flowSrc), "面板调的是 understanding-status 且带 path 参数");
check(/encodeURIComponent\(b\.path\)/.test(flowSrc), "path 经 encodeURIComponent 原样送后端");
check(/auto_trigger_allowed === true/.test(flowSrc), "只有后端明确 auto_trigger_allowed=true 才自动跑");
check(!/读懂/.test(flowSrc), "自动流程的文案里不出现「读懂」（不许暗示已读懂）");
// 接线：选书真的会触发自动判定（否则 3b 只是个没人调的函数）
check(/void autoUnderstanding\(b\.id\);/.test(js), "selectBook 里真的调用了 autoUnderstanding（打开书就判定）");
check(/function selectBook\(id, userPicked\)/.test(js), "selectBook 仍在（接线的宿主函数没被改名）");

// 9h 跨层：面板调的路由在后端真的注册了，且字段名对得上
check(/pathname === "\/api\/reading\/understanding-status"/.test(hostSrc),
  "lib/index.js 注册了 /api/reading/understanding-status 路由");
check(/reading\.understandingStatus\(\{ book_path: q\.get\("path"\) \}\)/.test(hostSrc),
  "路由把 path 参数交给 reading.understandingStatus（字段名对得上）");

reportAndExit();
