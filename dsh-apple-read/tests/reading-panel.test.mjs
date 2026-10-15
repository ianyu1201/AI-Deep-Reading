/**
 * tests/reading-panel.test.mjs · M7 两层 UI 的 DOM 断言
 *
 * ## 这个套件在防什么
 * M7 是**纯展示**里程碑，但它最容易出的不是崩溃，而是**说谎**：
 *   · 未知部分存在却显示「全书 100%」；
 *   · 用处理进度暗示「已读懂」；
 *   · 没有依据的维度显示成 0 或「中立」；
 *   · 仅排除反馈时不显示「已应用本次排除」，等于假称没使用反馈；
 *   · 把第一层与第二层的理由/分值混写；
 *   · 把 selected_items 当成第三层权威结果；
 *   · 把五类证据标签数值化成 1—5 分，或把「待复核」排成最高；
 *   · 把 excluded 算进「已理解」；
 *   · 把「切片完成」显示成「分析完成」。
 * 这些都是**文案与结构**层面的错，靠肉眼很容易漏，所以在测试里钉死。
 *
 * ## 方法
 * 1. **静态断言**：Tab 定义、容器 id、CSS 切换规则、数据来源 URL、客户端半端接线。
 * 2. **行为断言**：把 `assets/panel/app.js` 里 `READING-VIEW` 标记区（纯函数、无 DOM）
 *    **原样截取**后求值，再用夹具数据调用 `renderGuideHtml`，对**渲染出来的 HTML**
 *    断言——包括「某元素必须是 X」「某元素不得包含 Y」两个方向。
 * 3. 每个检查都必须**可证伪**：`tests/reading-panel.mutations.mjs` 会把这段代码
 *    故意改坏，要求本套件变红。
 *
 * 跑法：`node tests/reading-panel.test.mjs`
 *      变异套件用 `APPLE_READ_UI_ROOT` 指向改坏的副本。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.APPLE_READ_UI_ROOT ?? join(HERE, "..");
const PANEL = join(ROOT, "assets", "panel");

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log("  ✓ " + m); };
const bad = (m, d) => { fail++; console.log("  ✗ " + m + (d ? " — " + d : "")); };
const check = (cond, m, d) => (cond ? ok(m) : bad(m, d));

const html = readFileSync(join(PANEL, "index.html"), "utf8");
const css = readFileSync(join(PANEL, "style.css"), "utf8");
const js = readFileSync(join(PANEL, "app.js"), "utf8");
const client = readFileSync(join(ROOT, "src", "client", "index.jsx"), "utf8");
// M15 阶段 3：新增了 `GET /reading/evidence`（只读）与 `POST /reading/confirm-observation`
// 两个路由。跨层契约要能核对「面板拼的 URL == 宿主真有的路由」，所以这里也读宿主源码。
const hostSrc = readFileSync(join(ROOT, "lib", "index.js"), "utf8");

// ---------- 取出纯函数区 ----------
const BEGIN = "/* ==== READING-VIEW BEGIN ==== */";
const END = "/* ==== READING-VIEW END ==== */";
const i0 = js.indexOf(BEGIN);
const i1 = js.indexOf(END);
if (i0 < 0 || i1 <= i0) {
  bad("app.js 里找不到 READING-VIEW 标记区（测试无法求值渲染函数）");
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(1);
}
const viewSrc = js.slice(i0 + BEGIN.length, i1);
let V;
try {
  V = new Function(viewSrc + "\n;return { renderGuideHtml, evidenceLabel, buildSelectedItems, fmtUnknown, EVIDENCE_LABELS, SCORE_KEYS, esc };")();
} catch (e) {
  bad("READING-VIEW 区求值失败", String(e && e.message));
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(1);
}

// ---------- 取出「我确认这条观察」流程区（M15 阶段 3） ----------
// 确认按钮要**真打后端**，所以这一环不能只做静态断言：把流程区原样截取求值，
// 用 `fetch` 替身驱动它（沿用 M12 SOURCE-FLOW 的做法）。
const CF_BEGIN = "/* ==== CONFIRM-FLOW BEGIN ==== */";
const CF_END = "/* ==== CONFIRM-FLOW END ==== */";
const cfi = js.indexOf(CF_BEGIN);
const cfj = js.indexOf(CF_END);
const confirmFlowSrc = cfi >= 0 && cfj > cfi ? js.slice(cfi + CF_BEGIN.length, cfj) : null;

// ---------- 夹具 ----------
const clone = (o) => JSON.parse(JSON.stringify(o));
const between = (s, a, b) => {
  const i = s.indexOf(a);
  if (i < 0) return "";
  const j = s.indexOf(b, i + a.length);
  return j < 0 ? s.slice(i) : s.slice(i, j);
};
/** 取某个候选在渲染结果里的那一小段 HTML。 */
const itemBlock = (s, cid) => {
  const i = s.indexOf('data-cid="' + cid + '"');
  if (i < 0) return "";
  const j = s.indexOf('<div class="gditem', i + 1);
  const k = s.indexOf('<div class="gdsel', i + 1);
  const ends = [j, k].filter((x) => x > 0);
  const e = ends.length ? Math.min(...ends) : s.length;
  return s.slice(i, e);
};

const BASE_RESULT = {
  outcome: "items",
  book_guide: {
    overview_paragraphs: ["第一段有来源的浓缩。", "第二段也有来源。"],
    coverage_scope: { scope: "parsed_body", book_version_id: "bv_1", section_ids: ["s1", "s2"] },
    source_refs: ["sp_1", "sp_2"],
    items: [
      { candidate_id: "ca_book_1", section_id: "s1", B: 3, reason: "核心论证", source_refs: ["sp_1"] },
      { candidate_id: "ca_both_1", section_id: "s2", B: 2, reason: "必要前提", source_refs: ["sp_2"] },
    ],
  },
  personalized_items: [
    {
      candidate_id: "ca_both_1",
      reasons: { book: "必要前提", personal: ["R: 与本次目标相关"], reason_code: "goal_matched" },
      dimension_evidence: { R: { score: 3, reason: "目标引用", evidence_refs: ["pe_1"] } },
      scores: { B: 2, R: 3, G: null, T: null, W: 0.3, C: 0.4286, q: 1, lambda: 0.1714, U: 3, S: 2.1714 },
      uncertainty: "未观察过你对该概念的解释。",
      source_refs: ["sp_2", "pe_1"],
    },
    {
      candidate_id: "ca_pers_1",
      reasons: { book: "局部补充", personal: ["G: 有具体表现"], reason_code: "gap_observed" },
      dimension_evidence: { G: { score: 2, reason: "观察到一次解释缺口", evidence_refs: ["pe_2"] } },
      scores: { B: 1, R: null, G: 2, T: null, W: 0.2, C: 0.2857, q: 0.5, lambda: 0.0286, U: 2, S: 1.0286 },
      uncertainty: "含未确认观察。",
      source_refs: ["sp_3"],
    },
  ],
  personalization_status: "limited",
  exclusions: [],
  constraints_report: {
    applied_feedback_exclusions: { applied: false, feedback_refs: [], note: null },
    unknown_dimensions: ["T"],
    insufficient_evidence_reason: null,
  },
  policy_and_model_metadata: {
    b_anchors: { 0: "有来源但缺阅读价值", 1: "局部补充", 2: "代表性论点/必要前提", 3: "核心论证或关键边界" },
  },
};
const mkResult = (over) => Object.assign(clone(BASE_RESULT), over || {});

const unknownKinds = () => ({
  unparseable: { count: null, codepoints: null, known: false },
  missing: { count: null, codepoints: null, known: false },
  image_page: { count: null, codepoints: null, known: false },
});
/** 真实路由形状：45-书籍/ 里没有 CoverageUnit ⇒ 三层未知、计数被路由改成 null。 */
const BASE_COVERAGE = {
  ok: true,
  root: "/vault/45-书籍",
  units_known: false,
  units_source: null,
  units_reason: "45-书籍/ 内没有覆盖单元（CoverageUnit）记录：覆盖情况未知，不按 0 处理",
  report: {
    version: "1.0.0",
    coordinate_space: null,
    coverage: { scope: "parsed_body", missing_sections: [], analyzed_units: null, total_units: null, excluded_units: null },
    layers: {
      extraction: { layer: "extraction", scope: "parsed_body", known: false, denominator_codepoints: 0, covered_codepoints: null, percent: null, reason: "NO_LAYER_INPUT" },
      analysis: { layer: "analysis", scope: "parsed_body", known: false, denominator_codepoints: 0, covered_codepoints: null, percent: null, reason: "NO_LAYER_INPUT" },
      reading: { layer: "reading", scope: "parsed_body", known: false, denominator_codepoints: 0, covered_codepoints: null, percent: null, reason: "NO_LAYER_INPUT" },
    },
    units: { total: null, pending: null, processed: null, failed: null, excluded: null, counts_as_analyzed: null, counts_as_understood: null, partial_results_reportable: true },
    unknown: {
      kinds: unknownKinds(), total_count: null, codepoints: null, codepoints_known: false,
      counts_known: false, ratio_known: false, total_book_codepoints: null, reasons: [],
      note: "「占比是否可知」本身要如实报告：不知道就说不知道，不拿已知部分当全书。",
    },
    honesty: {
      scope: "parsed_body", denominator_basis: "discovered_parseable_body_codepoints_union",
      denominator_codepoints: 0, whole_book_claim_allowed: false, whole_book_percent: null,
      unknown_ratio_known: false, unknown_counts_known: false, missing_sections_known: false, reasons: [],
    },
    claims: {
      extraction_complete: { allowed: false, basis: "extraction", reason: "存在未知部分" },
      analysis_complete: { allowed: false, basis: "analysis", reason: "存在未知部分" },
      book_understood: { allowed: false, basis: "reading", reason: "「已读懂」不能由抽取/分析/处理进度推出" },
    },
    partial: { has_failures: false, has_exclusions: false, can_report_partial_results: true },
  },
  unknown_fields: ["coverage.analyzed_units", "coverage.total_units", "coverage.excluded_units", "units.*"],
};
const mkCoverage = (over) => Object.assign(clone(BASE_COVERAGE), over || {});

const render = (p) => V.renderGuideHtml(p);

// ===========================================================================
console.log("\n[1] 面板静态接线（Tab / 容器 / 数据来源）");
// ===========================================================================
const htmlTabs = [...html.matchAll(/class="tab[^"]*"\s+data-tab="([^"]+)"/g)].map((m) => m[1]);
const jsTabs = (js.match(/const TABS = \[([^\]]+)\]/) || [])[1];
const jsTabList = jsTabs ? [...jsTabs.matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
check(JSON.stringify(htmlTabs) === JSON.stringify(jsTabList), "HTML 的 data-tab 与 app.js 的 TABS 完全一致", `html=[${htmlTabs}] js=[${jsTabList}]`);
check(jsTabList.includes("guide"), "TABS 里有 guide 这个 Tab", jsTabList.join(","));
check(/\bid="guidebox"/.test(html), "index.html 有 #guidebox 容器");
check(/\bid="guide"/.test(html), "index.html 有 #guide 渲染容器");
check(/\bid="guidesum"/.test(html), "index.html 有 #guidesum 折叠头");
check(js.includes('$("#guide")'), "app.js 把渲染结果写进 #guide");
check(js.includes('$("#guidebox").open = true'), "切到导读 Tab 时会展开 #guidebox（否则内容区是空的）");
check(js.includes('"/reading/coverage"'), "导读读 /reading/coverage（覆盖账本）");
check(js.includes('"/reading/recommendations"'), "导读读 /reading/recommendations（已保存的推荐运行）");
check(js.includes('"/reading/library"'), "导读读 /reading/library（书籍/概括计数）");
// M12：渲染入口多了第 2 个参数（`state.source` = 第 3 环的「原文依据」状态）。
// 这条断言仍然钉住「唯一入口」这件事，只是把签名跟着更新。
check(/el\.innerHTML = renderGuideHtml\(state\.reading, state\.source\)/.test(js), "渲染入口是 renderGuideHtml（可被测试截取求值）");

console.log("\n[2] 窄栏 CSS：导读是第 4 个 Tab，一次只显示一个区");
check(/body\[data-tab="guide"\]\s*\.library\s*\{\s*display:\s*none/.test(css), "导读 Tab 下藏掉书库");
check(/body\[data-tab="books"\]\s*#guidebox/.test(css) && /body\[data-tab="search"\]\s*#guidebox/.test(css), "其他 Tab 下藏掉导读区");
check(/body\[data-tab="guide"\]\s*#annbox/.test(css) && /body\[data-tab="guide"\]\s*#searchbox/.test(css), "导读 Tab 下藏掉标注/检索区");
check(/body\[data-tab="guide"\]\s*#guidebox\s*>\s*summary\s*\{\s*display:\s*none/.test(css), "导读 Tab 下藏掉折叠头（Tab 已经负责切换）");
check(css.includes(".gdnever"), "「不可宣称」这一档有独立样式（不能被当普通正文略过）");
check(css.includes(".gdscore"), "分值有独立样式（unknown 要一眼看出来）");

console.log("\n[3] 客户端半端：导读 Tab 把左栏放宽");
check(/if \(data\.type === "apple-read:tab"\)/.test(client), "index.jsx 处理 apple-read:tab 消息（不是只在注释里提到）");
check(client.includes("LEFT_WIDE_STYLE"), "index.jsx 有加宽后的左栏样式");
check(/guideTab \? LEFT_WIDE_STYLE : LEFT_STYLE/.test(client), "左栏宽度按 guideTab 切换（不是写死）");

// ===========================================================================
console.log("\n[4] 第一层 · 书本导读（不依赖个人背景）");
// ===========================================================================
{
  const out = render({ coverage: mkCoverage(), result: mkResult() });
  const l1 = between(out, 'id="gd-l1"', 'id="gd-l2"');
  const l2 = between(out, 'id="gd-l2"', 'id="gd-ev"');
  check(l1.length > 0 && l2.length > 0, "第一层与第二层是**两个独立区块**");
  check(l1.includes("ca_book_1"), "第一层的候选出现在第一层区块");
  check(!l2.includes("ca_book_1"), "第一层独有的候选**没有**混进第二层");
  check(l2.includes("ca_pers_1"), "第二层的候选出现在第二层区块");
  check(!l1.includes("ca_pers_1"), "第二层独有的候选**没有**混进第一层");
  check(l1.includes("B=3") && l1.includes("核心论证"), "第一层项显示书本价值 B 与理由");
  check(l1.includes("核心论证或关键边界"), "第一层显示 B 锚点含义（b_anchors）");
  check(l1.includes("来源引用（source_refs，2 条）"), "第一层显示非空 source_refs");
  check(l1.includes("第一段有来源的浓缩。"), "第一层显示 overview_paragraphs");
  check(l1.includes("已解析 / 已分析范围"), "第一层显示 coverage_scope");
  check(!l1.includes("gdreason-personal"), "第一层不写第二层理由（两层不混写）");
  check(!l1.includes("gdscores"), "第一层不写第二层分值（两层不混写）");
  check(l2.includes("gdreason-personal") && l2.includes("gdscores"), "第二层才有个人理由与分值");

  // 无个人材料时第一层照常显示（PRD :203「无个人依据不让第一层弃权」）
  const noBg = mkResult({ personalized_items: [], personalization_status: "none" });
  const out2 = render({ coverage: mkCoverage(), result: noBg });
  check(between(out2, 'id="gd-l1"', 'id="gd-l2"').includes("ca_book_1"), "没有任何个人材料时第一层照常显示");

  // source_refs 为空 ⇒ 不许当成导读
  const noRefs = mkResult();
  noRefs.book_guide.source_refs = [];
  const out3 = render({ coverage: mkCoverage(), result: noRefs });
  check(between(out3, 'id="gd-l1"', 'id="gd-l2"').includes("source_refs 为空"), "source_refs 为空时明确说明本层不成立（不静默）");

  // 用户约束排除全部候选 ⇒ items 空 + no_eligible_reason
  const none = mkResult();
  none.book_guide.items = [];
  none.book_guide.no_eligible_reason = "全部候选被硬约束排除：user_excluded(3)";
  const out4 = render({ coverage: mkCoverage(), result: none });
  check(between(out4, 'id="gd-l1"', 'id="gd-l2"').includes("全部候选被硬约束排除：user_excluded(3)"), "items 为空时显示 no_eligible_reason");
  const noneBad = mkResult();
  noneBad.book_guide.items = [];
  const out5 = render({ coverage: mkCoverage(), result: noneBad });
  check(between(out5, 'id="gd-l1"', 'id="gd-l2"').includes("却没有真实 no_eligible_reason"), "items 为空却没有原因时报结构错误");

  // 整体弃权
  const abstain = mkResult({ outcome: "insufficient_evidence", book_guide: null, personalized_items: [], personalization_status: "none" });
  abstain.constraints_report.insufficient_evidence_reason = "NO_CREDIBLE_BOOK_MATERIAL";
  const out6 = render({ coverage: mkCoverage(), result: abstain });
  check(between(out6, 'id="gd-l1"', 'id="gd-l2"').includes("整体弃权") && out6.includes("NO_CREDIBLE_BOOK_MATERIAL"), "整体弃权时显示原因");

  // 没有结果 ⇒ 诚实空态
  const out7 = render({ coverage: mkCoverage(), result: null });
  check(between(out7, 'id="gd-l1"', 'id="gd-l2"').includes("尚无推荐结果"), "没有推荐结果时走诚实空态，不编造");
}

// ===========================================================================
console.log("\n[5] 第二层 · 个性化叠加与 personalization_status 三态");
// ===========================================================================
{
  const limited = render({ coverage: mkCoverage(), result: mkResult() });
  const l2 = between(limited, 'id="gd-l2"', 'id="gd-ev"');
  check(l2.includes("有限个性化"), "limited 显示「有限个性化」");
  check(l2.includes("C=") || l2.includes("q=0.5"), "limited 说明为什么（0<C<1 或 q=0.5）");
  check(!/置信度\s*[:：]?\s*\d/.test(limited) && !/\d+(\.\d+)?\s*%\s*的?(置信度|信心)/.test(limited), "界面不出现「置信度 78%」这类措辞");
  check(l2.includes("gd-applied-exclusion") === false, "没有排除反馈时不显示「已应用本次排除」");

  const none = mkResult({ personalized_items: [], personalization_status: "none" });
  const outNone = render({ coverage: mkCoverage(), result: none });
  check(between(outNone, 'id="gd-l2"', 'id="gd-ev"').includes("尚未个性化"), "none 显示「尚未个性化」态");
  check(between(outNone, 'id="gd-l2"', 'id="gd-ev"').includes("无个人可用维度"), "none 说明原因（无可用维度）");

  // 仅排除反馈：status=none 必须另明示「已应用本次排除」
  const onlyExcl = mkResult({ personalized_items: [], personalization_status: "none" });
  onlyExcl.constraints_report.applied_feedback_exclusions = { applied: true, feedback_refs: ["fb_1"], note: "已应用本次排除" };
  const outOnly = render({ coverage: mkCoverage(), result: onlyExcl });
  check(outOnly.includes("已应用本次排除"), "仅排除反馈时必须明示「已应用本次排除」");
  check(outOnly.includes("不假称没有使用反馈"), "仅排除反馈时同时说明确实用了反馈");
  check(between(outOnly, 'id="gd-l2"', 'id="gd-ev"').includes("仅有排除反馈"), "none 的原因里点明「仅有排除反馈」");

  const avail = render({ coverage: mkCoverage(), result: mkResult({ personalization_status: "available" }) });
  const l2a = between(avail, 'id="gd-l2"', 'id="gd-ev"');
  check(l2a.includes("已个性化"), "available 显示「已个性化」");
  check(l2a.includes("仍不代表已校准的高置信"), "available 仍不得声称高置信");

  const noRes = render({ coverage: mkCoverage(), result: null });
  check(between(noRes, 'id="gd-l2"', 'id="gd-ev"').includes("尚无推荐结果"), "没有结果时第二层也是诚实空态");
}

// ===========================================================================
console.log("\n[6] 第二层分值：无依据必须 unknown，不得 0 / 不得「中立」");
// ===========================================================================
{
  check(V.fmtUnknown(null) === "unknown" && V.fmtUnknown(undefined) === "unknown" && V.fmtUnknown("") === "unknown", "fmtUnknown：null/undefined/空串 → unknown");
  check(V.fmtUnknown(0) === "0", "fmtUnknown：0 是有依据的合法值，原样保留（不被吞成 unknown）");
  check(JSON.stringify(V.SCORE_KEYS) === JSON.stringify(["B", "R", "G", "T", "W", "C", "q", "lambda", "U", "S"]), "分值键恰好是 B/R/G/T/W/C/q/lambda/U/S（ASCII lambda）");

  const out = render({ coverage: mkCoverage(), result: mkResult() });
  const l2only = between(out, 'id="gd-l2"', 'id="gd-ev"');
  const blk = itemBlock(l2only, "ca_pers_1");
  check(blk.includes("<i>R</i>unknown"), "无依据的维度 R 显示 unknown");
  check(blk.includes("<i>T</i>unknown"), "无依据的维度 T 显示 unknown");
  check(!blk.includes("<i>R</i>0"), "无依据的维度**不得**显示成 0");
  // 「不得显示中立」说的是**分值本身**，不是禁止解释性文案里出现「中立」二字。
  const scoreVals = [...out.matchAll(/<span class="gdscore"><i>([A-Za-z]+)<\/i>([^<]*)<\/span>/g)].map((m) => m[2]);
  check(scoreVals.length > 0 && scoreVals.every((v) => v !== "中立" && v !== "medium"), "任何分值都**不得**显示成「中立」或 medium（是 unknown 就是 unknown）", scoreVals.join(","));
  check(blk.includes("R 依据：unknown（无依据，不填 0、不填中立）"), "缺失的 dimension_evidence 明确写 unknown 与原因");
  check(blk.includes("G 依据：score=2"), "有依据的维度显示 score 与 reason");

  const zero = mkResult();
  zero.personalized_items[1].scores.R = 0;
  zero.personalized_items[1].dimension_evidence.R = { score: 0, reason: "已有依据显示不相关", evidence_refs: ["pe_9"] };
  const outZ = render({ coverage: mkCoverage(), result: zero });
  check(itemBlock(between(outZ, 'id="gd-l2"', 'id="gd-ev"'), "ca_pers_1").includes("<i>R</i>0"), "有依据时 0 正常显示（不被当成 unknown）");

  const outB = render({ coverage: mkCoverage(), result: mkResult() });
  const b1 = itemBlock(between(outB, 'id="gd-l2"', 'id="gd-ev"'), "ca_both_1");
  check(b1.includes("书内理由（第一层同源）") && b1.includes("个人理由（第二层）"), "第二层把书内理由与个人理由分开写");
  check(b1.includes("与本次目标相关"), "第二层显示 personal 理由");
  check(b1.includes("不确定性："), "第二层显示 uncertainty");
  check(b1.includes("来源："), "第二层显示 source_refs");
}

// ===========================================================================
console.log("\n[7] 五类证据标签：闭合值域、不数值化、不反转");
// ===========================================================================
{
  const want = ["未知", "自报熟悉", "有一次解释证据", "有迁移证据", "待复核"];
  check(JSON.stringify(V.EVIDENCE_LABELS) === JSON.stringify(want), "五类标签是闭合值域，且不是 1—5 分制");
  check(V.EVIDENCE_LABELS.every((l) => !/\d/.test(l)), "标签里没有数字（不是分数）");

  const ev = (o) => Object.assign({ source_refs: ["pe_1"], assessment_basis: "引用原答", origin: "user", confirmation: "confirmed" }, o);
  check(V.evidenceLabel(ev({ kind: "self_report", dimension: "familiarity" })).label === "自报熟悉", "self_report/familiarity → 自报熟悉");
  check(V.evidenceLabel(ev({ kind: "observed_performance", dimension: "explanation" })).label === "有一次解释证据", "observed_performance/explanation → 有一次解释证据");
  check(V.evidenceLabel(ev({ kind: "observed_performance", dimension: "application" })).label === "有迁移证据", "observed_performance/application → 有迁移证据");
  check(V.evidenceLabel(ev({ kind: "observed_performance", dimension: "explanation", confirmation: "retracted" })).label === "待复核", "撤回 → 待复核");
  check(V.evidenceLabel(ev({ kind: "observed_performance", dimension: "explanation", source_unavailable: true })).label === "待复核", "来源失效 → 待复核");
  check(V.evidenceLabel(ev({ kind: "observed_performance", dimension: "explanation", disputed: true })).label === "待复核", "有来源的争议 → 待复核");
  check(V.evidenceLabel(ev({ kind: "observed_performance", dimension: "explanation", valid_until: "2026-01-01" }), "2026-06-01").label === "待复核", "过期 → 待复核");
  check(V.evidenceLabel(ev({ kind: "observed_performance", dimension: "explanation", valid_until: "2026-01-01" }), "2025-01-01").label === "有一次解释证据", "未过期时仍按正向标签（过期判定不是恒真）");
  check(V.evidenceLabel({}).label === "未知", "缺字段 → 未知（不赋中立分）");
  check(V.evidenceLabel(ev({ kind: "observed_performance" })).label === "未知", "缺 dimension → 未知（不补 medium）");
  check(V.evidenceLabel(ev({ kind: "observed_performance", dimension: "explanation", source_refs: [] })).label === "未知", "没有可核验 source_refs → 未知");
  check(V.evidenceLabel(ev({ kind: "ai_hypothesis", dimension: "explanation" })).label === "未知", "AI 假设 → 未知（不冒充用户事实）");
  check(V.evidenceLabel(ev({ kind: "explicit_preference", dimension: "familiarity" })).label === "未知", "显式偏好 → 未知（只影响兴趣，不转成能力）");
  check(V.evidenceLabel(ev({ dimension: "retention", strength: "high" })).label === "未知", "只有 retention 强度不推导保留观察");
  check(V.evidenceLabel(ev({ strength: "high", confidence: { level: "high", reason: "x" } })).label === "未知", "strength/confidence 与五类正交：不得数值化转换成标签");
  check(V.evidenceLabel(ev({ kind: "self_report", dimension: "familiarity", confirmation: "unconfirmed" })).label === "未知", "自报熟悉须 confirmed 才算");

  const out = render({ coverage: mkCoverage(), result: null, evidence: null });
  check(out.includes("不是 1—5 分量表"), "界面写明不是 1—5 分制");
  check(out.includes("不把「待复核」排成最高"), "界面写明不把「待复核」排成最高");
  check(out.includes("strength / confidence 与这五类正交"), "界面写明 strength/confidence 正交、不数值化");
  check(out.includes("尚无可用能力证据"), "没有证据数据时显示「未知」而不是空着");
  const out2 = render({ coverage: mkCoverage(), result: null, evidence: [ev({ kind: "self_report", dimension: "familiarity" })] });
  check(out2.includes('<span class="gdtag">自报熟悉</span>'), "有证据数据时渲染派生标签");
}

// ===========================================================================
console.log("\n[8] 覆盖展示：分母、未知、不可宣称（本轮最容易说谎的地方）");
// ===========================================================================
{
  const out = render({ coverage: mkCoverage(), result: null });
  const cov = between(out, 'id="gd-cov"', 'id="gd-l1"');
  check(cov.includes("分母（已发现的可解析正文，按 span 区间并集去重）"), "覆盖区显示分母");
  check(cov.includes('<b id="gd-denom">unknown</b>'), "没有输入时分母显示 unknown，**不显示 0**");
  check(cov.includes("分母未知，不按 0 处理"), "分母未知时说明不按 0 处理");
  check(cov.includes("未知部分：无法解析 未知 / 缺失 未知 / 图片页 未知"), "未知部分三类都如实显示");
  check(cov.includes("数量是否可知：<b>不可知</b>") && cov.includes("占比是否可知：<b>不可知</b>"), "未知部分的数量/占比是否可知分别显示");
  check(/id="gd-wholebook">整本覆盖率：<b>不宣称<\/b>/.test(out), "未知部分存在时整本覆盖率必须是「不宣称」");
  check(!out.includes("全书 100%"), "未知部分存在时界面**不得**出现「全书 100%」");
  check(!/\b100\s*%/.test(out), "未知部分存在时界面不出现任何 100% 覆盖宣称");
  check(/id="gd-understood">是否已读懂：<b>不可宣称<\/b>/.test(out), "「已读懂」恒不可宣称");
  check(cov.includes("「切片完成」不等于「分析完成」"), "明确写出「切片完成」不得显示成「分析完成」");
  check(cov.includes('id="gd-layer-extraction"') && cov.includes('id="gd-layer-analysis"') && cov.includes('id="gd-layer-reading"'), "抽取/分析/阅读三层分开显示");
  check(cov.includes("逐章/逐片段明细：未知"), "没有逐单元数据时如实说未知（不按 0）");
  check(cov.includes("excluded 不计作理解完成"), "写明 excluded 不计作理解完成");

  // 用处理进度暗示「已读懂」⇒ 必须被抓：这里把进度全部拉满，仍不可宣称
  const done = mkCoverage();
  done.report.layers.extraction = { layer: "extraction", scope: "parsed_body", known: true, denominator_codepoints: 1000, covered_codepoints: 1000, percent: 100, reason: null };
  done.report.layers.analysis = { layer: "analysis", scope: "parsed_body", known: true, denominator_codepoints: 1000, covered_codepoints: 1000, percent: 100, reason: null };
  done.report.layers.reading = { layer: "reading", scope: "parsed_body", known: true, denominator_codepoints: 1000, covered_codepoints: 1000, percent: 100, reason: null };
  done.report.claims.extraction_complete = { allowed: true, basis: "extraction", reason: "无未知部分" };
  done.report.claims.analysis_complete = { allowed: true, basis: "analysis", reason: "无未知部分" };
  done.report.honesty.whole_book_claim_allowed = true;
  done.report.honesty.whole_book_percent = 100;
  done.report.honesty.denominator_codepoints = 1000;
  done.report.unknown = Object.assign(clone(BASE_COVERAGE.report.unknown), {
    kinds: { unparseable: { count: 0, codepoints: 0, known: true }, missing: { count: 0, codepoints: 0, known: true }, image_page: { count: 0, codepoints: 0, known: true } },
    total_count: 0, counts_known: true, ratio_known: true,
  });
  const outDone = render({ coverage: done, result: null });
  check(/id="gd-understood">是否已读懂：<b>不可宣称<\/b>/.test(outDone), "处理进度 100% 时「已读懂」仍不可宣称（不得用进度暗示读懂）");
  check(!outDone.includes("已读懂</b>") && !outDone.includes("已经读懂"), "进度拉满也不出现「已读懂」的肯定式表述");
  check(outDone.includes('<b id="gd-denom">1000</b>'), "分母已知时正常显示数字（unknown 判定不是恒真）");

  // 逐单元：excluded 必须给原因，且不计作理解完成
  const units = mkCoverage();
  units.report.units = {
    total: 4, pending: 1, processed: 1, failed: 1, excluded: 1,
    counts_as_analyzed: 1, counts_as_understood: 0, partial_results_reportable: true,
    list: [
      { unit_id: "u1", section_id: "s1", state: "excluded", exclusion: { reason: "过渡性内容", reason_code: "TRANSITION", decided_at: "2026-10-01" } },
      { unit_id: "u2", section_id: "s2", state: "processed", counts_as_analyzed: true, counts_as_understood: false },
      { unit_id: "u3", section_id: "s3", state: "failed", failure: { code: "MODEL_ERROR", message: "超时", retryable: true } },
      { unit_id: "u4", section_id: "s4", state: "pending" },
    ],
  };
  const outU = render({ coverage: units, result: null });
  check(outU.includes("排除原因：过渡性内容"), "excluded 单元显示明确原因");
  check(outU.includes("计入理解完成 0") && outU.includes("excluded 不计入"), "excluded 不计作理解完成");
  check(outU.includes("失败：MODEL_ERROR"), "failed 单元显示错误");
  check(outU.includes("已通过语义分析校验；这不等于你已读懂"), "processed 单元不等于已读懂");
  check(outU.includes("排队中，尚未分析"), "pending 单元显示未分析");

  const unitsBad = clone(units);
  unitsBad.report.units.list = [{ unit_id: "u1", section_id: "s1", state: "excluded" }];
  const outUB = render({ coverage: unitsBad, result: null });
  check(outUB.includes("缺少排除原因"), "excluded 没有原因时报契约违反（不静默）");

  const covErr = render({ coverage: { ok: false, code: "READ_ERROR", message: "读不到" }, result: null });
  check(covErr.includes("覆盖数据读取失败：READ_ERROR"), "覆盖读取失败时如实报错，不显示 0");
}

// ===========================================================================
console.log("\n[9] selected_items：两层去重并集，不是第三层权威结果");
// ===========================================================================
{
  const out = render({ coverage: mkCoverage(), result: mkResult() });
  const selBlock = out.slice(out.indexOf('id="gd-sel"'));
  check(selBlock.includes('data-cid="ca_book_1" data-layer="book"'), "只在一层的项标 book");
  check(selBlock.includes('data-cid="ca_pers_1" data-layer="personalized"'), "只在一层的项标 personalized");
  check(selBlock.includes('data-cid="ca_both_1" data-layer="both"'), "两层都有的项标 both");
  check(selBlock.includes("不是第三层权威结果"), "明确写出它不是第三层权威结果");
  check(!selBlock.includes(">第三层权威结果<"), "没有另立「第三层权威结果」区块");
  check((selBlock.match(/data-cid="ca_both_1"/g) || []).length === 1, "重复项被去重（只出现一次）");

  const both = itemBlock(selBlock, "ca_both_1");
  check(both.includes("书内理由：必要前提") && both.includes("个人理由："), "合并重复项时保留两类理由");

  const selIds = V.buildSelectedItems(mkResult()).map((x) => x.candidate_id + ":" + x.layer);
  check(JSON.stringify(selIds) === JSON.stringify(["ca_book_1:book", "ca_both_1:both", "ca_pers_1:personalized"]), "并集顺序与标记正确");
  check(V.buildSelectedItems(null).length === 0, "没有结果时并集为空（不抛错）");
}

// ===========================================================================
console.log("\n[10] 诚实说明与不写盘");
// ===========================================================================
{
  check(js.includes("全库只读投影"), "面板写明覆盖/知识库是全库投影，不按当前书过滤");
  check(!/fetch\(\s*["'`]\/apple-read\/api\/reading\/recommendations\/run/.test(js), "面板不调用会算分的 POST /recommendations/run（本轮纯展示）");
  check(!/method:\s*"POST"/.test(js.slice(js.indexOf("READING-VIEW BEGIN"), js.indexOf("READING-VIEW END"))), "渲染区没有任何写操作");
  check(html.includes("诚实边界"), "index.html 里写清诚实边界（免得被当成数据已齐）");
}

// ===========================================================================
console.log("\n[11] 导读改版阶段 1：内部码只允许出现在「技术细节」折叠区里");
// ===========================================================================
{
  /** 主视图 = 把「技术细节」折叠区整块剥掉之后的 HTML。 */
  const mainView = (s) => s.replace(/<details class="gd-tech">[\s\S]*?<\/details>/g, "");
  /** 主视图的可见文本（去标签；属性里的东西不算「展示」）。 */
  const mainText = (s) => mainView(s).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

  const HEX = "c".repeat(16);
  const SPAN_A = "sp_" + "a".repeat(16) + "_0_10_20";
  const SPAN_B = "sp_" + "b".repeat(16) + "_1_0_5";
  // 一份「内部码齐全」的夹具：span / bv / sec / ca / scope= / NO_LAYER_INPUT / 分母口径码 / dict 转储
  const rich = {
    outcome: "items",
    book_guide: {
      overview_paragraphs: ["第一段有来源的浓缩。"],
      coverage_scope: { scope: "parsed_body", book_version_id: "bv_" + HEX, section_ids: ["sec_" + HEX + "_0", "sec_" + HEX + "_1"] },
      source_refs: [SPAN_A, SPAN_B],
      items: [{
        candidate_id: "ca_" + HEX + "_0", section_id: "sec_" + HEX + "_0", B: 3,
        reason: "含定义/命题式陈述 1 处；结构标记 {'argument': 4, 'condition': 2}", source_refs: [SPAN_A],
      }],
    },
    personalized_items: [],
    personalization_status: "none",
    exclusions: [],
    constraints_report: {
      applied_feedback_exclusions: { applied: false, feedback_refs: [], note: null },
      unknown_dimensions: [], insufficient_evidence_reason: null,
    },
    policy_and_model_metadata: { b_anchors: { 3: "核心论证或关键边界" } },
  };
  const out = render({ coverage: mkCoverage(), result: rich });
  const main = mainText(out);

  const INTERNAL = [
    ["span_id（sp_…）", /sp_[0-9a-f]{8,}_\d+_\d+_\d+/],
    ["book_version_id（bv_…）", /bv_[0-9a-f]+/],
    ["section_id（sec_…）", /sec_[0-9a-f_]+/],
    ["candidate_id（ca_…）", /ca_[0-9a-f]+_\d+/],
    ["NO_LAYER_INPUT", /NO_LAYER_INPUT/],
    ["discovered_parseable_body_codepoints_union", /discovered_parseable_body_codepoints_union/],
    ["parsed_body（口径原始值）", /parsed_body/],
    ["lambda_cap", /lambda_cap/],
    ["scope=", /\bscope=/],
    ["state=", /\bstate=/],
    ["candidate_id 字段名", /candidate_id/],
    ["引擎的 dict 转储（结构标记 {…}）", /结构标记 \{[^}]*\}/],
    ["裸露的 markdown 星号 **", /\*\*/],
  ];
  for (const [name, re] of INTERNAL) {
    const hit = main.match(re);
    check(!hit, "主视图（技术细节折叠区之外）不得出现内部码：" + name, hit ? String(hit[0]).slice(0, 60) : "");
  }

  // 折叠 ≠ 删（阶段 1b）：同一批内部码必须**仍然在 HTML 里**，展开就看得到。
  check(/sp_[0-9a-f]{8,}_\d+_\d+_\d+/.test(out), "折叠不等于删：span_id 仍在 HTML 里");
  check(/bv_[0-9a-f]+/.test(out) && /sec_[0-9a-f_]+/.test(out) && /ca_[0-9a-f]+_\d+/.test(out),
    "折叠不等于删：书版本 / section_id / candidate_id 仍在 HTML 里");
  check(/NO_LAYER_INPUT/.test(out), "折叠不等于删：覆盖层的原始 reason 码仍在 HTML 里");
  check(/discovered_parseable_body_codepoints_union/.test(out), "折叠不等于删：分母口径原始码仍在 HTML 里");
  check(/结构标记 \{/.test(out), "折叠不等于删：引擎的 dict 转储仍在 HTML 里（只是不摆在主视图）");
  check(/parsed_body/.test(out), "折叠不等于删：口径原始值仍在 HTML 里");
  check((out.match(/<details class="gd-tech">/g) || []).length >= 3,
    "「技术细节」是**多个**分块折叠区（不是把整页塞进一个）");
  check(css.includes(".gd-tech") && css.includes(".gd-tech-body"),
    "「技术细节」折叠区有独立样式（不然展开也读不了）");

  // 功能不能被折叠掉：「看原文」按钮仍在主视图里。
  check(mainView(out).includes('data-span="' + SPAN_A + '"'),
    "「看原文」按钮仍在主视图（data-span 是功能属性，不是给人看的内部码）");

  // 同一批检查也要覆盖 run 身份区（rr_ / lambda_cap 只该在折叠区里）。
  const rec = {
    result_run_id: "rr_" + "d".repeat(24), result_run_state: "ready", ready_run_count: 1,
    result_ambiguous: false, result_error: null,
    result_projection: { not_persisted_metadata_fields: ["lambda_cap", "enabled_dimensions"] },
    feedback_refs: {
      bound_to_current_run: 0, batch: 0, dangling: [], unreadable: [],
      note: "当前理解 rr_" + "d".repeat(24) + " 上有 0 条反馈；指向的条目都还在当前理解中",
    },
  };
  const out2 = render({ coverage: mkCoverage(), result: rich, recommendations: rec });
  const main2 = mainText(out2);
  check(!/rr_[0-9a-f]+/.test(main2), "主视图不得出现 run_id（rr_…）");
  check(!/\bstate=/.test(main2), "主视图不得出现 state= 字段名");
  check(!/lambda_cap/.test(main2), "主视图不得出现 lambda_cap（未持久化字段只进折叠区）");
  check(/rr_[0-9a-f]+/.test(out2) && /lambda_cap/.test(out2), "折叠不等于删：run_id / lambda_cap 仍在 HTML 里");
}

// ===========================================================================
console.log("\n[12] 导读改版阶段 2：这本书口径 vs 全库口径（切书要看得出来）");
// ===========================================================================
{
  const HEX = "c".repeat(16);
  const strip = (s) => s.replace(/<details class="gd-tech">[\s\S]*?<\/details>/g, "");
  const mkBook = (over) => Object.assign({
    id: "bid1", title: "第一哲学沉思集", author: "笛卡尔", path: "/x/book.epub",
    status: {
      ok: true, checked: true, has_current_understanding: true, state: "ready",
      revision: 3, content_id: HEX, book_version_id: "bv_" + HEX,
      run_id: "rr_" + "e".repeat(24), note_rel: "推荐反馈/rr_x.md", message: "已有当前理解",
    },
  }, over || {});
  const guideWithBv = (bv) => ({
    outcome: "items",
    book_guide: {
      overview_paragraphs: ["浓缩。"],
      coverage_scope: { scope: "parsed_body", book_version_id: bv, section_ids: [] },
      source_refs: ["sp_" + "a".repeat(16) + "_0_1_2"], items: [],
    },
    personalized_items: [], personalization_status: "none", exclusions: [],
    constraints_report: {
      applied_feedback_exclusions: { applied: false, feedback_refs: [], note: null },
      unknown_dimensions: [], insufficient_evidence_reason: null,
    },
    policy_and_model_metadata: { b_anchors: {} },
  });

  // (1) 第一屏第一块就是「这本书」
  const out = render({ coverage: mkCoverage(), result: guideWithBv("bv_" + HEX), book: mkBook() });
  check(out.indexOf('id="gd-book"') > -1 && out.indexOf('id="gd-book"') < out.indexOf('id="gd-run-sec"'),
    "「这本书」区排在第一位（第一屏第一件事）");
  const bookBlk = between(out, 'id="gd-book"', 'id="gd-run-sec"');
  check(bookBlk.includes("第一哲学沉思集") && bookBlk.includes("笛卡尔"), "「这本书」区显示书名与作者");
  check(bookBlk.includes("已有一条可用理解") && bookBlk.includes("第 3 版"), "「这本书」区说清分析到哪一步");
  check(!/bv_[0-9a-f]+/.test(strip(bookBlk)), "「这本书」区的主视图不出现内部码");

  // (2) 没有理解 / 后端没能确认 ⇒ 不猜
  const noUnd = render({ coverage: mkCoverage(), result: guideWithBv("bv_" + HEX),
    book: mkBook({ status: Object.assign({}, mkBook().status, { has_current_understanding: false, state: null, revision: null }) }) });
  check(between(noUnd, 'id="gd-book"', 'id="gd-run-sec"').includes("还没有理解"), "没有理解时如实说「还没有理解」");
  const unchecked = render({ coverage: mkCoverage(), result: guideWithBv("bv_" + HEX),
    book: mkBook({ status: { ok: false, checked: false, code: "BOOK_NOT_IN_LIBRARY", message: "不在书库" } }) });
  const ub = between(unchecked, 'id="gd-book"', 'id="gd-run-sec"');
  check(ub.includes("没能确认") && !ub.includes("还没有理解"), "后端没能确认时**不猜成**「还没有理解」");
  check(render({ coverage: mkCoverage(), result: guideWithBv("bv_" + HEX) }).includes("还没选中任何一本书"),
    "没选中书时如实说没选中");

  // (3) 口径对不上 ⇒ 明确警告「不是这本」
  const other = render({ coverage: mkCoverage(), result: guideWithBv("bv_" + "9".repeat(16)), book: mkBook() });
  const l1o = between(other, 'id="gd-l1"', 'id="gd-l2"');
  check(l1o.includes('id="gd-l1-scope-other"'), "书版本对不上时给「不是这本」警告");
  check(l1o.includes("不是") && l1o.includes("全库最新一条"),
    "警告说清它其实是退回了「全库最新一条」可用理解");
  check(!l1o.includes("就是当前这本"), "对不上时**不许**说「就是这本」");
  const same = render({ coverage: mkCoverage(), result: guideWithBv("bv_" + HEX), book: mkBook() });
  check(between(same, 'id="gd-l1"', 'id="gd-l2"').includes('id="gd-l1-scope-book"'), "书版本对得上时说「就是这本」");
  const unk = render({ coverage: mkCoverage(), result: guideWithBv("bv_" + HEX), book: mkBook({ status: { checked: false } }) });
  const l1u = between(unk, 'id="gd-l1"', 'id="gd-l2"');
  check(l1u.includes('id="gd-l1-scope-unknown"') && !l1u.includes("就是当前这本"),
    "缺书版本身份时如实说「无法确认」，不猜成「就是这本」");

  // (4) 覆盖范围明确标成全库口径
  const cov = between(out, 'id="gd-cov"', 'id="gd-l1"');
  check(cov.includes("全库口径"), "覆盖范围标题标明是全库口径");
  check(cov.includes("不按当前选中的书过滤"), "覆盖范围说清不按当前选中的书过滤");

  // (5) 切书真的会重读导读（源码级）
  const sb = js.slice(js.indexOf("function selectBook"), js.indexOf("function selectBook") + 2500);
  check(/void loadReading\(\)/.test(sb), "selectBook() 里切书会重读导读（void loadReading()）");
  check(js.includes("/reading/understanding-status?path="), "导读按 path 查这本书的理解状态");
  // 方案 B：导读本身也要按这本书取（否则「切书后导读没变化」会回来）
  check(js.includes("/reading/recommendations?path="), "导读按 path 取**这本书**的理解（方案 B）");
  check(/recReq[\s\S]{0,400}?get\("\/reading\/recommendations"\)/.test(js),
    "没拿到 path 时退回不带参数（后端行为不变，安全降级）");
}

// ===========================================================================
console.log("\n[13] 导读改版阶段 3：结论先行 + 诚实内容经得起折叠");
// ===========================================================================
{
  const strip = (s) => s.replace(/<details class="gd-tech">[\s\S]*?<\/details>/g, "");
  const plain = (s) => s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  /** 主视图里某个 id 元素的可见文字（折叠区已被剥掉）。 */
  const elText = (s, id) => {
    const i = s.indexOf('id="' + id + '"');
    if (i < 0) return "";
    const j = s.indexOf("</div>", i);
    return plain(s.slice(i, j < 0 ? undefined : j));
  };
  const out = render({ coverage: mkCoverage(), result: mkResult() });
  const cov = between(out, 'id="gd-cov"', 'id="gd-l1"');
  const mainCovHtml = strip(cov);
  const mainCov = plain(mainCovHtml);

  // 诚实结论必须在**主视图**里：折叠不许把它们藏掉
  check(elText(mainCovHtml, "gd-wholebook").includes("不宣称"), "主视图仍保留诚实结论：整本覆盖率不宣称");
  check(elText(mainCovHtml, "gd-understood").includes("不可宣称"), "主视图仍保留诚实结论：「已读懂」不可宣称");
  const MUST = [
    ["「切片完成」不等于「分析完成」", "切片≠分析"],
    ["分母未知，不按 0 处理", "分母未知不按 0"],
    ["数量是否可知", "数量是否可知"],
    ["excluded 不计作理解完成", "excluded 不计入"],
  ];
  for (const [needle, name] of MUST) {
    check(mainCov.includes(needle), "主视图（技术细节折叠区之外）仍保留诚实结论：" + name);
  }

  // 结论先行：结论行排在明细行之前
  check(cov.indexOf('id="gd-wholebook"') < cov.indexOf('id="gd-denom"'),
    "结论先行：「整本覆盖率」排在分母数字之前");
  check(cov.indexOf('id="gd-understood"') < cov.indexOf('id="gd-layer-extraction"'),
    "结论先行：「是否已读懂」排在三层覆盖明细之前");
  check(cov.indexOf('id="gd-slice-not-analysis"') < cov.indexOf('id="gd-layer-extraction"'),
    "结论先行：「切片≠分析」排在覆盖明细之前");

  // 排版：正文按文章排（字号/行距），不是一堆 11px 小字
  check(/\.gdp\s*\{[^}]*font-size:\s*13px/.test(css) && /\.gdp\s*\{[^}]*line-height:\s*1\.9/.test(css),
    "浓缩正文有独立的文章级排版（13px / 1.9 行距）");
  check(/\.gdhd\s*\{[^}]*border-bottom/.test(css), "分区标题有分隔线（一眼看出是标题）");
  check(css.includes("#gd-book"), "「这本书」区有独立样式");
}

// ===========================================================================
console.log("\n[14] M15 阶段 3：个人依据看得见 + 过期如实标 + 「我确认这条观察」真打后端");
// ===========================================================================
{
  // ---- 3c-1/3c-2：逐维度 reason + 用了哪条证据（笔记 id，可展开核对） ----
  const out = render({ coverage: mkCoverage(), result: mkResult() });
  const l2 = between(out, 'id="gd-l2"', 'id="gd-ev"');
  const blk = itemBlock(l2, "ca_both_1");
  check(blk.includes("reason=目标引用"), "3c-1：逐维度显示 dimension_evidence 的 reason（不是只给一个数字）",
    blk.slice(0, 200));
  check(blk.includes("R 依据：score=3"), "3c-1：同时给出该维度的分值");
  check(blk.includes("R 证据（笔记 id）=pe_1"), "3c-2：显示 dimension_evidence.R.evidence_refs（笔记 id）");
  check(/<details class="gd-tech">[\s\S]*R 证据（笔记 id）=pe_1[\s\S]*<\/details>/.test(blk),
    "3c-2：证据 id 在「技术细节」折叠区里（可展开核对，不挡正文）");

  // ---- 3c-3：q=0.5 必须说明**为什么** ----
  const half = itemBlock(l2, "ca_pers_1");
  check(half.includes("依据里包含未确认观察或 AI 评估，所以 q=0.5，叠加系数被减半"),
    "3c-3：q=0.5 时明确说明原因（不是只显示 0.5 这个数）");
  check(!blk.includes("所以 q=0.5，叠加系数被减半"), "3c-3：q=1 的条目**不得**出现 q=0.5 的原因说明（不是恒真）");
  // 元检查：夹具里的 q 值确实是 0.5 / 1，否则上面两条会空转。
  const qOf = (cid) => mkResult().personalized_items.find((x) => x.candidate_id === cid).scores.q;
  check(qOf("ca_pers_1") === 0.5, "元检查：夹具 ca_pers_1 的 q 确实是 0.5");
  check(qOf("ca_both_1") === 1, "元检查：夹具 ca_both_1 的 q 确实是 1");

  // ---- 3c-4：available ≠ 高置信 / ≠ 已掌握；none/limited 不得显示成「已个性化」 ----
  const availL2 = between(render({ coverage: mkCoverage(), result: mkResult({ personalization_status: "available" }) }),
    'id="gd-l2"', 'id="gd-ev"');
  check(availL2.includes("available 只表示个人依据齐了"), "3c-4：available 明说它只表示「个人依据齐了」");
  check(availL2.includes("不代表已校准的高置信"), "3c-4：available 明说**不代表**已校准的高置信");
  check(availL2.includes("不代表已掌握"), "3c-4：available 明说**不代表**已掌握");
  const availWhy = between(availL2, 'id="gd-status-why"', "</div>");
  check(!/已掌握/.test(availWhy.replace(/不代表已掌握/g, "")) && !/高置信/.test(availWhy.replace(/不代表已校准的高置信/g, "")),
    "3c-4：available 的说明里没有**肯定式**的「已掌握 / 高置信」", availWhy);
  const noneL2 = between(render({ coverage: mkCoverage(), result: mkResult({ personalized_items: [], personalization_status: "none" }) }),
    'id="gd-l2"', 'id="gd-ev"');
  check(noneL2.includes("尚未个性化") && !noneL2.includes("已个性化"), "3c-4：none 不显示成「已个性化」");
  const limL2 = between(render({ coverage: mkCoverage(), result: mkResult() }), 'id="gd-l2"', 'id="gd-ev"');
  check(limL2.includes("有限个性化") && !limL2.includes("已个性化"), "3c-4：limited 不显示成「已个性化」");

  // ---- 3d：过期 / 失效如实标（判定只有 evidenceLabel 一处，不在这里另比 valid_until） ----
  const evNote = (o) => Object.assign({
    note_id: "re_x", kind: "observed_performance", dimension: "explanation",
    source_refs: ["sp_1"], assessment_basis: "引用原答", origin: "user", confirmation: "unconfirmed",
  }, o);
  check(V.evidenceLabel(evNote({ valid_until: "2026-01-01" }), "2026-06-01").stale === "expired",
    "3d：过期判定的原因码是 expired（单一判定来源：evidenceLabel）");
  check(V.evidenceLabel(evNote({ valid_until: "2027-01-01" }), "2026-06-01").stale === null,
    "3d：未过期时 stale 为 null（过期判定不是恒真）");
  check(V.evidenceLabel(evNote({ knowledge_status: "withdrawn" }), "2026-06-01").stale === "not_active",
    "3d：knowledge_status 不是 active ⇒ not_active（复用同一条 stale 分支）");

  const evResp = {
    ok: true, read_only: true, book_scoped: true, now: "2026-06-01T00:00:00.000Z",
    notes: [
      evNote({ note_id: "re_old", valid_until: "2026-01-01" }),
      evNote({ note_id: "re_fresh", valid_until: "2027-01-01" }),
      evNote({ note_id: "re_dead", knowledge_status: "withdrawn" }),
    ],
  };
  const evOut = render({ coverage: mkCoverage(), result: null, evidence: evResp });
  const evSec = between(evOut, 'id="gd-ev"', 'id="gd-sel"');
  check(evSec.includes('id="gd-ev-expired-re_old"') && evSec.includes("过期"),
    "3d：valid_until 已过 ⇒ 明确标「过期」");
  check(evSec.includes("不再当成有效依据"), "3d：过期项写明「不再当成有效依据」");
  check(!evSec.includes('id="gd-ev-expired-re_fresh"'), "3d：未过期项不标过期（不是恒真）");
  check(evSec.includes('id="gd-ev-stale-re_dead"'), "3d：knowledge_status 不是 active ⇒ 标「依据已失效」");
  check(evSec.includes("待复核"), "3d：过期项的五类标签仍是「待复核」（保留原维度，不认定反向结论）");

  // 3d（第二层）：run 里记的依据若**当前**已过期 ⇒ 那一条维度如实标「过期」
  const staleEv = {
    ok: true, book_scoped: true, now: "2026-06-01T00:00:00.000Z",
    notes: [
      evNote({ note_id: "pe_1", valid_until: "2026-01-01" }),
      evNote({ note_id: "pe_2", valid_until: "2027-01-01" }),
    ],
  };
  const staleL2 = between(render({ coverage: mkCoverage(), result: mkResult(), evidence: staleEv }),
    'id="gd-l2"', 'id="gd-ev"');
  const staleBlk = itemBlock(staleL2, "ca_both_1");
  check(staleBlk.includes('id="gd-l2-stale-ca_both_1-R"') && staleBlk.includes("不再当成有效依据"),
    "3d：第二层里**已过期**的依据如实标「过期」（不能继续当成有效依据）");
  check(!itemBlock(staleL2, "ca_pers_1").includes('id="gd-l2-stale-ca_pers_1-G"'),
    "3d：第二层里未过期的依据不标过期（不是恒真）");
  check(!between(render({ coverage: mkCoverage(), result: mkResult() }), 'id="gd-l2"', 'id="gd-ev"')
    .includes("不再当成有效依据"), "3d：没有证据清单时判不了 ⇒ 不标过期（不猜）");
  // 确认按钮：只有带 note_id 的才渲染
  check(evSec.includes('data-confirm="re_old"') && evSec.includes("我确认这条观察"),
    "确认按钮：为证据笔记渲染「我确认这条观察」（带 note_id）");
  check(between(render({ coverage: mkCoverage(), result: null, evidence: [evNote({ note_id: null })] }), 'id="gd-ev"', 'id="gd-sel"')
    .includes("这条没有 note_id ⇒ 不能确认"), "确认按钮：没有 note_id 时不渲染按钮、如实说明（不猜 id）");

  // 清单读取失败如实报（不显示成「没有证据」）
  const evErr = render({ coverage: mkCoverage(), result: null, evidence: { ok: false, code: "BOOK_IDENTITY_ERROR", message: "定不出身份" } });
  const evErrSec = between(evErr, 'id="gd-ev"', 'id="gd-sel"');
  check(evErrSec.includes("证据清单读取失败：BOOK_IDENTITY_ERROR"), "只读端点：清单读取失败如实报错");
  check(!evErrSec.includes("尚无可用能力证据"), "只读端点：读取失败时不谎称「没有证据」");

  // ---- 跨层契约：面板拼的 URL 必须与宿主真有的路由对得上 ----
  check(js.includes('"/reading/evidence?path="'), "面板按当前书取证据清单（/reading/evidence?path=）");
  check(js.includes('API + "/reading/confirm-observation"'), "确认打的是我们自己的 /reading/confirm-observation");
  check(hostSrc.includes('pathname === "/api/reading/evidence"'), "宿主确实有 /api/reading/evidence 只读路由");
  check(hostSrc.includes('pathname === "/api/reading/confirm-observation"'), "宿主确实有 /api/reading/confirm-observation 路由");
  check(/querySelectorAll\("\[data-confirm\]"\)/.test(js), "确认按钮（data-confirm）绑定了点击处理器");
  check(css.includes(".gdconfirmbtn") && css.includes(".gdstale"), "确认按钮与过期标记有独立样式");

  // ---- 确认按钮：**真打后端**（成功 / changed:false / 失败 / 网络错误 / 非 JSON / 无 id） ----
  if (confirmFlowSrc === null) {
    bad("app.js 里找不到 CONFIRM-FLOW 标记区（确认流程无法被行为测试驱动）");
  } else {
    /** 替身环境：`fetch` / `state` / `API` / `renderGuide` 注入。 */
    const mkConfirmEnv = (resp, reading) => {
      const calls = { fetch: [], renderGuide: 0 };
      const state = { reading: reading ?? { evidence: { ok: true, now: null, notes: [] } } };
      const fakeFetch = async (url, opts) => {
        calls.fetch.push({ url, opts });
        const j = typeof resp === "function" ? resp(url, opts) : resp;
        if (j && j.__throw) throw new Error(j.__throw);
        return {
          status: j && j.__status ? j.__status : 200,
          text: async () => (j && j.__raw !== undefined ? j.__raw : JSON.stringify(j)),
        };
      };
      const renderGuide = () => { calls.renderGuide++; };
      const api = new Function("fetch", "state", "API", "renderGuide", "console",
        viewSrc + "\n" + confirmFlowSrc + "\n;return { confirmEvidenceNote };")(
        fakeFetch, state, "/apple-read/api", renderGuide, console);
      return { ...api, calls, state };
    };

    try {
      // 成功
      const env = mkConfirmEnv({
        ok: true, changed: true, note_id: "re_1", note_rel: "阅读背景/学习证据/x.md",
        confirmation: "confirmed", origin: "user",
        confirmation_evidence: { actor: "user", action_id: "act_1", at: "2026-10-12T10:00:00.000Z", scope: "s" },
        honesty: { means: "已被你确认为你自己的稳定陈述", does_not_mean: "确认 ≠ 高置信、≠ 已掌握、≠ 读懂这本书（回执原文）" },
        message: "已确认这条观察（q 从 0.5 变 1；这不代表高置信）",
      });
      const r1 = await env.confirmEvidenceNote("re_1");
      check(env.calls.fetch.length === 1, "确认：真的打了后端（替身恰好 1 次）", `实际=${env.calls.fetch.length}`);
      const firstCall = env.calls.fetch[0] ?? {};
      check(firstCall.url === "/apple-read/api/reading/confirm-observation", "确认：打的是 /reading/confirm-observation", String(firstCall.url));
      check(firstCall.opts?.method === "POST", "确认：用 POST", String(firstCall.opts?.method));
      check(firstCall.opts ? JSON.parse(firstCall.opts.body).note_id === "re_1" : false,
        "确认：body 里带的是按钮上的 note_id");
      check(r1.ok === true && r1.changed === true, "确认：成功 ⇒ ok/changed 如实透出");
      check(env.state.reading.confirm?.changed === true, "确认：回执记进 state（供渲染）");
      const html1 = render({ coverage: mkCoverage(), result: null, evidence: evResp, confirm: env.state.reading.confirm });
      check(html1.includes("确认 ≠ 高置信、≠ 已掌握、≠ 读懂这本书（回执原文）"),
        "确认：显示**回执里的** honesty.does_not_mean（不是前端自编一句）");

      // changed:false —— 已经确认过，不许显示成「刚刚确认成功」
      const env2 = mkConfirmEnv({
        ok: true, changed: false, note_id: "re_1", note_rel: "x.md", confirmation: "confirmed",
        honesty: { means: "这条观察早已被确认", does_not_mean: "确认 ≠ 高置信、≠ 已掌握、≠ 读懂这本书" },
        message: "这条观察已经确认过了，没有重复写入",
      });
      const r2 = await env2.confirmEvidenceNote("re_1");
      check(r2.ok === true && r2.changed === false, "确认：changed:false 如实透出");
      const html2 = render({ coverage: mkCoverage(), result: null, evidence: evResp, confirm: env2.state.reading.confirm });
      check(html2.includes("这条观察已经确认过了"), "确认：changed:false 显示「已经确认过了」");
      check(!html2.includes("已确认这条观察（q 从 0.5 变 1"), "确认：changed:false **不得**显示成「刚刚确认成功」");

      // 后端拒绝
      const env3 = mkConfirmEnv({ ok: false, code: "NOT_AN_OBSERVATION", changed: false, message: "只有学习证据 / 理解变化能被确认" });
      const r3 = await env3.confirmEvidenceNote("re_1");
      check(r3.ok === false && env3.state.reading.confirm?.ok === false, "确认：后端拒绝 ⇒ 面板也是失败（不假装成功）");
      const html3 = render({ coverage: mkCoverage(), result: null, evidence: evResp, confirm: env3.state.reading.confirm });
      check(html3.includes("NOT_AN_OBSERVATION") && html3.includes("只有学习证据"), "确认：原样带出后端 code/message");
      check(html3.includes("不假装确认成功"), "确认：失败时明说「不假装确认成功」");

      // 网络错误 / 非 JSON / 没有 note_id
      const env4 = mkConfirmEnv({ __throw: "boom" });
      const r4 = await env4.confirmEvidenceNote("re_1");
      check(r4.code === "NETWORK_ERROR" && env4.state.reading.confirm?.code === "NETWORK_ERROR",
        "确认：网络错误 ⇒ NETWORK_ERROR（不假装成功）");
      const env5 = mkConfirmEnv({ __raw: "<html>502</html>", __status: 502 });
      const r5 = await env5.confirmEvidenceNote("re_1");
      check(r5.code === "BAD_RESPONSE", "确认：响应不是 JSON ⇒ BAD_RESPONSE（不假装成功）");
      const env6 = mkConfirmEnv({ ok: true, changed: true });
      const r6 = await env6.confirmEvidenceNote("");
      check(r6.code === "NO_NOTE_ID" && env6.calls.fetch.length === 0, "确认：没有 note_id ⇒ 不打后端（不猜 id）");

      // 成功写盘后，清单里那条的确认状态按**回执**更新
      const env7 = mkConfirmEnv(
        { ok: true, changed: true, note_id: "re_1", confirmation: "confirmed" },
        { evidence: { ok: true, now: null, notes: [{ note_id: "re_1", confirmation: "unconfirmed" }] } });
      await env7.confirmEvidenceNote("re_1");
      check(env7.state.reading.evidence.notes[0].confirmation === "confirmed",
        "确认：成功后清单里那条按回执更新为 confirmed");
    } catch (e) {
      // 变异让流程抛异常时，收成一条可定位的 ✗（崩成零条会被变异套件判成「没抓到」）。
      bad("[14] 确认流程行为断言被异常打断（这条也算失败）", String(e && e.stack ? e.stack.split("\n")[0] : e));
    }
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
