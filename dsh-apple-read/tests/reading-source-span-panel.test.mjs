/**
 * tests/reading-source-span-panel.test.mjs · M12「互动提问：推荐 → 原文 → DSH 讨论」的诚实性断言
 *
 * ## 这个套件在防什么
 *
 * M12 把**第 3 环**接通：用户在面板上看到一条推荐 → 点开它**自己引用**的原文 → 送进 DSH 讨论。
 * 这一环最容易出的不是崩溃，而是**说谎**：
 *   · 原文不是来自这条推荐的 `source_refs`，而是**重新检索**或**拿标注顶替**；
 *   · 取不到原文时**拿别的内容顶替**，或干脆假装成功（前端假成功）；
 *   · 显示原文却**不给可核对的定位**（哪一章、哪个区间），用户没法回原文核对；
 *   · 把**书中观点 / 用户判断 / AI 推演**混成一句（PRD 硬要求三者不许混）；
 *   · 说「已读懂」/「全书 100%」/「切片完成 = 理解完成」；
 *   · 顺手**保存观察**（那是第 4 环 = M13，本里程碑不许做）；
 *   · 新增代码又去依赖 Apple Books（v0.8 纪律 4：不许加深耦合）。
 *
 * ## 方法（沿用 M7/M8/M9）
 * 1. **静态断言**：按钮接线、POST 的 URL 与 `lib/index.js` 的路由**逐字符对得上**、CSS 存在、
 *    SOURCE-FLOW 里没有写盘路由、没有 Apple Books 假设。
 * 2. **纯函数断言**：把 `app.js` 的 `READING-VIEW` 区原样截取求值，用夹具调 `renderSourceRefs` /
 *    `renderSourceEvidence`，对**渲染出来的 HTML** 断言「必须有 / 必须没有」两个方向。
 * 3. **行为断言**：把 `SOURCE-FLOW` 区（`openSourceSpan` / `askAboutSourceSpan`）原样截取求值，
 *    用 `fetch` 替身 + `toParent` 替身驱动，断言「真打了后端」「失败不显示原文」
 *    「送进讨论的 passage 就是取回来的那段原文、且带归属标注」。
 * 4. **跨层契约**：`prepare-chat` 的 `readingContextText` 用**真实函数**（从 `lib/index.js`
 *    原样截取求值）跑一遍，确认它把这段标注成**书中原文**而不是用户的话。
 * 5. 每个检查都必须**可证伪**：`tests/reading-source-span-panel.mutations.mjs` 会把源码故意改坏，
 *    要求本套件变红。
 *
 * 跑法：`node tests/reading-source-span-panel.test.mjs`
 *      变异套件用 `APPLE_READ_UI_ROOT` 指向改坏的副本。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.APPLE_READ_UI_ROOT ?? join(HERE, "..");
const PANEL = join(ROOT, "assets", "panel");

let pass = 0, fail = 0, skipped = 0;
const ok = (m) => { pass++; console.log("  ✓ " + m); };
const bad = (m, d) => { fail++; console.log("  ✗ " + m + (d ? "\n      " + d : "")); };
const skip = (m, why) => { skipped++; console.log("  ⊘ 跳过 " + m + " —— " + why); };
const check = (c, m, d) => (c ? ok(m) : bad(m, d));

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
const watchdog = setTimeout(() => {
  bad("[看门狗] 套件超时未结束（挂起）—— 这条也算失败");
  reportAndExit();
}, 90000);
watchdog.unref?.();

// --------------------------------------------------------------------------- //
// 截取源码（原样求值，不复制逻辑）
// --------------------------------------------------------------------------- //
const js = readFileSync(join(PANEL, "app.js"), "utf8");
const css = readFileSync(join(PANEL, "style.css"), "utf8");
const html = readFileSync(join(PANEL, "index.html"), "utf8");
const hostSrc = readFileSync(join(HERE, "..", "lib", "index.js"), "utf8");
const bridgeSrc = readFileSync(join(ROOT, "src", "client", "index.jsx"), "utf8");
const bundleSrc = readFileSync(join(ROOT, "lib", "client.js"), "utf8");

const V0 = "/* ==== READING-VIEW BEGIN ==== */";
const V1 = "/* ==== READING-VIEW END ==== */";
const F0 = "/* ==== SOURCE-FLOW BEGIN ==== */";
const F1 = "/* ==== SOURCE-FLOW END ==== */";
const region = (src, a, b) => {
  const i = src.indexOf(a);
  const j = src.indexOf(b);
  return i < 0 || j <= i ? null : src.slice(i + a.length, j);
};
const viewSrc = region(js, V0, V1);
const flowSrc = region(js, F0, F1);

section("[0] 模块形状（截取不到就立刻失败）");
check(viewSrc !== null, "app.js 有 READING-VIEW 标记区");
check(flowSrc !== null, "app.js 有 SOURCE-FLOW 标记区（openSourceSpan / askAboutSourceSpan 所在）");
check(js.includes('id="gd-source"') || viewSrc !== null, "原文依据区的渲染来自 READING-VIEW 区");
if (viewSrc === null || flowSrc === null) reportAndExit();

let V = null, F = null;
try {
  V = new Function(viewSrc + "\n;return { renderGuideHtml, renderSourceRefs, renderSourceEvidence, "
    + "isSpanRef, sourceLocatorText, pickReadingResult, esc, fmtUnknown };")();
  ok("READING-VIEW 区求值成功");
} catch (e) {
  bad("READING-VIEW 区求值失败", String(e?.message));
}
try {
  F = new Function("fetch", "state", "API", "toParent", "embed", "renderGuide", "console",
    viewSrc + "\n" + flowSrc + "\n;return { openSourceSpan, askAboutSourceSpan };")();
  ok("SOURCE-FLOW 区求值成功（fetch/state/API/toParent/embed/renderGuide 可用替身注入）");
} catch (e) {
  bad("SOURCE-FLOW 区求值失败", String(e?.message));
}
if (V === null || F === null) reportAndExit();

// --------------------------------------------------------------------------- //
// 夹具
// --------------------------------------------------------------------------- //
const SPAN_A = "sp_f7f4f1fc3778c58a_3_535_683";
const SPAN_B = "sp_f7f4f1fc3778c58a_4_1186_1294";
const PERSONAL_REF = "pe_f7f4f1fc3778c58a_3_R";

/** 引擎 /source-span 的真实成功响应形状（books_rag.py read_source_span）。 */
const SPAN_OK = (over = {}) => ({
  ok: true,
  span_id: SPAN_A,
  book: "第一哲学沉思集",
  book_version_id: "bv_f7f4f1fc3778c58a",
  section_id: "sec_f7f4f1fc3778c58a_3",
  section_order: 3,
  start_codepoint: 535,
  end_codepoint: 683,
  text_hash: "a".repeat(64),
  quote: "因此，为了排除一切怀疑，我必须……（逐字原文）",
  quote_chars: 148,
  verified: true,
  ...over,
});

const RESULT = {
  outcome: "items",
  book_guide: {
    overview_paragraphs: ["第一段有来源的浓缩。"],
    coverage_scope: { scope: "parsed_body", book_version_id: "bv_f7f4f1fc3778c58a", section_ids: ["sec_f7f4f1fc3778c58a_3"] },
    source_refs: [SPAN_B],
    items: [
      { candidate_id: "ca_f7f4f1fc3778c58a_3", section_id: "sec_f7f4f1fc3778c58a_3", B: 3, reason: "核心论证", source_refs: [SPAN_A] },
    ],
  },
  personalized_items: [
    {
      candidate_id: "ca_f7f4f1fc3778c58a_3",
      reasons: { book: "核心论证", personal: ["R: 与本次目标相关"], reason_code: "goal_matched" },
      dimension_evidence: { R: { score: 3, reason: "目标引用", evidence_refs: [PERSONAL_REF] } },
      scores: { B: 3, R: 3, G: null, T: null, W: 0.3, C: 0.4286, q: 1, lambda: 0.1714, U: 3, S: 2.1714 },
      uncertainty: "未观察过你对该概念的解释。",
      source_refs: [SPAN_A, PERSONAL_REF],
    },
  ],
  personalization_status: "limited",
  exclusions: [],
  constraints_report: { applied_feedback_exclusions: { applied: false, feedback_refs: [], note: null }, unknown_dimensions: ["T"] },
  policy_and_model_metadata: { b_anchors: { 3: "核心论证或关键边界" } },
};
const PAYLOAD = { coverage: null, recommendations: null, library: null, result: RESULT, evidence: null, error: null };

const doneSource = (over = {}) => ({
  span_id: SPAN_A, from: "第一层 ca_f7f4f1fc3778c58a_3", phase: "done",
  data: {
    span_id: SPAN_A, book: "第一哲学沉思集", book_version_id: "bv_f7f4f1fc3778c58a",
    section_id: "sec_f7f4f1fc3778c58a_3", section_order: 3, start_codepoint: 535, end_codepoint: 683,
    text_hash: "a".repeat(64), quote: "因此，为了排除一切怀疑，我必须……（逐字原文）",
    quote_chars: 148, verified: true,
  },
  error: null, requested_url: "/apple-read/api/reading/source-span", ...over,
});

/** 「肯定句」检测：短语出现时必须被否定词前缀否定，否则算「宣称」。 */
const NEGATORS = ["不等于", "不代表", "不算", "不是", "不能宣称", "不可宣称", "不许", "并没有", "没有", "≠"];
function affirmativeClaims(text, phrase) {
  const hits = [];
  let i = text.indexOf(phrase);
  while (i >= 0) {
    const before = text.slice(Math.max(0, i - 12), i);
    if (!NEGATORS.some((n) => before.includes(n))) hits.push(text.slice(Math.max(0, i - 14), i + phrase.length + 6));
    i = text.indexOf(phrase, i + phrase.length);
  }
  return hits;
}

// --------------------------------------------------------------------------- //
section("[1] 静态接线：按钮 + 路由契约 + 样式");
check(/el\.innerHTML = renderGuideHtml\(state\.reading, state\.source\)/.test(js),
  "导读渲染把 state.source（原文依据状态）交给渲染器");
check(/\bsource: null\b/.test(js), "state 里有 source 字段");
check(/function wireSourceButtons\(/.test(js), "有按钮接线函数");
check(/querySelectorAll\("\[data-span\]"\)/.test(js), "「看原文」按钮（data-span）绑定了点击处理器");
check(/querySelector\("\[data-askspan\]"\)/.test(js), "「送进 DSH 讨论」按钮（data-askspan）绑定了点击处理器");
check(/ev\.stopPropagation\(\)/.test(js), "点按钮不会顺带触发别的点击");

// 跨文件路由契约：面板拼出来的 URL 必须与 lib/index.js 里的路由**逐字符一致**。
const apiMatch = js.match(/const API = "([^"]+)"/);
const baseMatch = hostSrc.match(/const BASE_PATH = "([^"]+)"/);
check(apiMatch !== null && baseMatch !== null && apiMatch[1] === baseMatch[1] + "/api",
  `面板 API 前缀 == 宿主 BASE_PATH + /api（${apiMatch?.[1]} vs ${baseMatch?.[1]}+/api）`);
check(flowSrc.includes('API + "/reading/source-span"'), "SOURCE-FLOW 打的是 /reading/source-span");
check(hostSrc.includes('pathname === "/api/reading/source-span"'), "宿主确实有这个路由（不新增路由，复用 M8 的）");
check(/\.gdsrcbtn\s*\{/.test(css), "CSS 有 .gdsrcbtn（按钮不是裸的）");
check(/\.gdquote\s*\{/.test(css), "CSS 有 .gdquote（原文有独立样式，便于逐字核对）");

// --------------------------------------------------------------------------- //
section("[2] 1a：原文来源必须是这条推荐自己的 source_refs");
check(V.isSpanRef(SPAN_A) === true, "合法 span_id 被判为书内引用", SPAN_A);
check(V.isSpanRef("pe_f7f4f1fc3778c58a_3_R") === false, "非 span 引用（个人证据 pe_*）不被当成书内原文");
check(V.isSpanRef("sp_1") === false, "形状不符的 sp_1 不算合法 span（与引擎正则一致）");
check(V.isSpanRef("") === false && V.isSpanRef(null) === false, "空值/null 不算 span");

const refsHtml = V.renderSourceRefs([SPAN_A, PERSONAL_REF], "第一层 ca_f7f4f1fc3778c58a_3");
check(refsHtml.includes('data-span="' + SPAN_A + '"'), "合法 span 渲染出「看原文」按钮");
check(!refsHtml.includes('data-span="' + PERSONAL_REF + '"'), "非 span 引用**不得**渲染成「看原文」按钮");
check(refsHtml.includes("非书内原文") && refsHtml.includes(PERSONAL_REF),
  "非 span 引用如实列出并说明「不是书内原文，取不到原文」");
const noSpanHtml = V.renderSourceRefs([PERSONAL_REF], "第二层 ca_x");
check(noSpanHtml.includes("取不到原文") && !noSpanHtml.includes("data-span="),
  "整条 source_refs 都不是 span 时：明说取不到原文，且不给按钮");
const emptyRefsHtml = V.renderSourceRefs([], "第一层 ca_y");
check(emptyRefsHtml.includes("没有 source_refs") && emptyRefsHtml.includes("不拿别的内容顶替"),
  "source_refs 为空 ⇒ 明说取不到原文依据（不静默、不顶替）");

const guideHtml = V.renderGuideHtml(PAYLOAD, null);
check(guideHtml.includes('data-span="' + SPAN_A + '"'),
  "推荐条目自己的 source_refs 变成了可点的「看原文」（来自 renderGuideHtml）");
check(guideHtml.includes('data-from="第一层 ca_f7f4f1fc3778c58a_3"'), "按钮带出来源标签（哪条推荐）");
// 「不重新检索」：SOURCE-FLOW 不得出现检索/标注取数，也不得读 state.hits。
check(!/\/search\b/.test(flowSrc), "SOURCE-FLOW 不调用 /search（不重新检索）");
check(!/annotationId|focusId|state\.hits/.test(flowSrc), "SOURCE-FLOW 不拿标注/检索结果顶替原文");
check(/JSON\.stringify\(\{ span_id: id \}\)/.test(flowSrc), "POST body 只有 span_id（只按这条推荐给的 id 取）");

// --------------------------------------------------------------------------- //
section("[3] 1b：原文在我们自己的面板里显示，且带可核对定位");
const evHtml = V.renderSourceEvidence(doneSource());
check(evHtml.includes("因此，为了排除一切怀疑，我必须……（逐字原文）"), "逐字显示取回的原文");
check(evHtml.includes("第 4 章"), "定位给出章序（人话：第 N 章）");
check(evHtml.includes("sec_f7f4f1fc3778c58a_3"), "定位给出 section_id（可回原文核对）");
check(evHtml.includes("[535, 683)"), "定位给出 Unicode codepoint 半开区间");
check(evHtml.includes("a".repeat(64)), "定位给出引文 text_hash（可核对是否同一段）");
check(evHtml.includes("bv_f7f4f1fc3778c58a"), "定位给出书版本");
check(evHtml.includes("不是页码"), "明说定位不是页码（重排版页码不作稳定坐标）");
check(evHtml.includes("第一哲学沉思集"), "显示这段原文所属的书名");
check(!/open_in_books_app|iCloud~com~apple~iBooks|Apple Books|图书」App/.test(evHtml),
  "原文显示**不依赖**打开 Apple Books（v0.8 纪律 4）");

const noOrder = V.renderSourceEvidence(doneSource({
  data: { ...doneSource().data, section_order: null, section_id: null, start_codepoint: null, end_codepoint: null },
}));
check(noOrder.includes("章序 unknown") && noOrder.includes("section_id unknown") && noOrder.includes("[unknown, unknown)"),
  "定位字段缺失 ⇒ 显示 unknown（不猜成「第 1 章」/不编造区间）");

const errHtml = V.renderSourceEvidence({
  span_id: SPAN_A, from: "第一层 ca_f7f4f1fc3778c58a_3", phase: "error",
  data: null, error: { code: "SPAN_BOOK_NOT_FOUND", message: "按 span_id 里的路径指纹找不到书（书被移走/改名？）" },
  requested_url: "/apple-read/api/reading/source-span",
});
check(errHtml.includes("找不到原文"), "取不到时如实说「找不到原文」");
check(errHtml.includes("SPAN_BOOK_NOT_FOUND"), "带出后端真实错误码（不改写、不吞掉）");
check(errHtml.includes("书被移走/改名"), "带出后端真实原因");
check(!errHtml.includes("因此，为了排除一切怀疑"), "取不到时**不显示任何替代正文**（不拿别的内容顶替）");
check(errHtml.includes("不显示任何替代内容"), "并明说「不显示任何替代内容」");

// --------------------------------------------------------------------------- //
section("[4] 1c：送进 DSH 讨论走 prepare-chat，passage 来自上面取回的 source_refs");

/** 行为断言用的替身环境。 */
function mkEnv(spanResp, { embedOn = true, current = "第一哲学沉思集" } = {}) {
  const calls = { fetch: [], toParent: [], renderGuide: 0 };
  const state = { source: null, current: current === null ? null : { title: current, id: "b1" } };
  const embed = { on: embedOn };
  const fakeFetch = async (url, opts) => {
    calls.fetch.push({ url, opts });
    const j = typeof spanResp === "function" ? spanResp(url, opts) : spanResp;
    return { status: j && j.__status ? j.__status : 200, text: async () => JSON.stringify(j) };
  };
  const toParent = (m) => { calls.toParent.push(m); };
  const renderGuide = () => { calls.renderGuide++; };
  const api = new Function("fetch", "state", "API", "toParent", "embed", "renderGuide", "console",
    viewSrc + "\n" + flowSrc + "\n;return { openSourceSpan, askAboutSourceSpan };")(
    fakeFetch, state, "/apple-read/api", toParent, embed, renderGuide, console);
  return { ...api, calls, state, embed };
}

// 元检查：夹具的 span_id 必须真的合法，否则按钮不渲染、后面的断言会空转。
check(V.isSpanRef(SPAN_A) === true, "元检查：夹具 span_id 形状合法（否则断言空转）");

const env = mkEnv(SPAN_OK());
const opened = await env.openSourceSpan(SPAN_A, "第一层 ca_f7f4f1fc3778c58a_3");
check(env.calls.fetch.length === 1, "元检查：真的打了后端（替身被调用恰好 1 次）", `实际=${env.calls.fetch.length}`);
// 下面的断言**必须容错**：前端假成功（一次都没打后端）时要变成可定位的 ✗，而不是让套件崩掉
// （崩掉会被变异套件判成「崩溃，不算抓到」——那就白测了）。
const firstCall = env.calls.fetch[0] ?? {};
check(firstCall.url === "/apple-read/api/reading/source-span", "打的是 /reading/source-span", String(firstCall.url));
check(firstCall.opts?.method === "POST", "用 POST", String(firstCall.opts?.method));
check(firstCall.opts ? JSON.parse(firstCall.opts.body).span_id === SPAN_A : false,
  "body 里的 span_id 就是按钮上的那个");
check(opened.ok === true && opened.phase === "done", "取到原文 ⇒ phase=done");
check(env.calls.renderGuide >= 2, "取原文前后都重绘（loading → done 对用户可见）");

const asked = await env.askAboutSourceSpan();
check(env.calls.toParent.length === 1, "元检查：确实把消息交给了父窗口（否则后面的断言空转）");
const msg = env.calls.toParent[0] || {};
check(msg.type === "apple-read:ask", "postMessage 类型是 apple-read:ask（父窗口的既有入口）");
check(msg.book === "第一哲学沉思集", "带上书（引擎按 span 给的那本）");
check(msg.passage && msg.passage.text === SPAN_OK().quote,
  "passage.text **就是**刚取回的那段原文（不是重新检索/不是标注）");
check(msg.passage.attribution === "book_quote_from_recommendation",
  "passage 带归属标注：这是**书中原文**，不是用户自己的话");
check(typeof msg.passage.locator === "string" && msg.passage.locator.includes("sec_f7f4f1fc3778c58a_3"),
  "passage 带可核对定位（章节 + 区间）");
check(msg.passage.source_ref === SPAN_A, "passage 带 span 引用（可回溯到这条推荐的 source_refs）");
check(typeof msg.question === "string" && msg.question.trim() !== "", "带上要问的问题");
check(asked.ok === true && asked.mode === "embedded", "嵌入模式 ⇒ 走 DSH 原生会话");

// 负控：后端说取不到 ⇒ 不许显示原文，也不许把别的内容送进讨论
const envErr = mkEnv({ ok: false, code: "SPAN_RANGE_INVALID", message: "区间越界" });
const openedErr = await envErr.openSourceSpan(SPAN_A, "第一层 ca_x");
check(openedErr.ok === false && openedErr.phase === "error", "后端 ok:false ⇒ 面板也是 error（不假装成功）");
// 容错：变异若把失败当成功，`error` 会是 null —— 要变成可定位的 ✗，不能把套件打崩
// （崩掉会被变异套件判成「崩溃，不算抓到」）。
check(envErr.state.source?.error?.code === "SPAN_RANGE_INVALID", "原样带出后端错误码",
  JSON.stringify(envErr.state.source?.error ?? null));
check(V.renderSourceEvidence(envErr.state.source).includes("找不到原文"), "并且渲染成「找不到原文」");
const askedErr = await envErr.askAboutSourceSpan();
check(askedErr.ok === false && envErr.calls.toParent.length === 0,
  "取不到原文时**不送**讨论（宁可不送，也不拿别的内容顶替）");

// 负控：形状不对的 ref 连后端都不打
const envShape = mkEnv(SPAN_OK());
const openedShape = await envShape.openSourceSpan("pe_not_a_span", "第二层 ca_x");
check(openedShape.code === "NOT_A_SPAN_REF" && envShape.calls.fetch.length === 0,
  "非 span 的 ref ⇒ 不打后端、如实报 NOT_A_SPAN_REF");

// 负控：原文为空 ⇒ 不送讨论
const envEmpty = mkEnv(SPAN_OK({ quote: "" }));
await envEmpty.openSourceSpan(SPAN_A, "第一层 ca_x");
const askedEmpty = await envEmpty.askAboutSourceSpan();
check(askedEmpty.code === "EMPTY_QUOTE" && envEmpty.calls.toParent.length === 0,
  "取到的原文为空 ⇒ 不送进讨论（不拿别的内容顶替）");

// 负控：没嵌在 DSH 面板里 ⇒ 如实说没有原生会话，不假装送了
const envNoEmbed = mkEnv(SPAN_OK(), { embedOn: false });
await envNoEmbed.openSourceSpan(SPAN_A, "第一层 ca_x");
const askedNoEmbed = await envNoEmbed.askAboutSourceSpan();
check(askedNoEmbed.code === "NOT_EMBEDDED" && envNoEmbed.calls.toParent.length === 0,
  "未嵌入 ⇒ 如实报 NOT_EMBEDDED（原文仍可在本页核对）");

// 负控：这段原文属于**另一本书** ⇒ 不冒充当前选中的书
const envOther = mkEnv(SPAN_OK({ book: "另一本书" }), { current: "第一哲学沉思集" });
await envOther.openSourceSpan(SPAN_A, "第一层 ca_x");
const askedOther = await envOther.askAboutSourceSpan();
check(askedOther.book === "另一本书" && askedOther.book_mismatch === true,
  "span 所属书与当前选中书不同 ⇒ 用 span 那本并标出 mismatch（不冒充）");

// ---- 跨层：桥接必须把归属一路带到宿主 ----
check(/attribution/.test(bridgeSrc), "客户端桥接把 passage.attribution 转给宿主（归属不能在中途丢）");
check(/attribution/.test(bundleSrc), "构建产物 lib/client.js 里也有（改 src 必须重新 build）");
check(hostSrc.includes('payload.passage.attribution === "book_quote_from_recommendation"'),
  "宿主 prepare-chat 用白名单接受这个归属取值（不认别的）");
check(/readingContextText\(\{ book, \.\.\.material, focusAnnotationId: payload\.annotationId, passage \}\)/.test(hostSrc),
  "prepare-chat 把 passage 交给 readingContextText");

// ---- 跨层：用**真实**的 readingContextText 跑一遍 ----
const ctxStart = hostSrc.indexOf("function readingContextText(");
const ctxEnd = hostSrc.indexOf('return parts.join("\\n\\n");', ctxStart);
let ctx = null;
if (ctxStart >= 0 && ctxEnd > ctxStart) {
  const fnSrc = hostSrc.slice(ctxStart, ctxEnd + 'return parts.join("\\n\\n");'.length + 3);
  try {
    ctx = new Function(fnSrc + "\n;return readingContextText;")();
    ok("能从 lib/index.js 原样截取 readingContextText 求值");
  } catch (e) {
    bad("readingContextText 求值失败", String(e?.message));
  }
} else {
  bad("在 lib/index.js 里找不到 readingContextText（跨层断言无法进行）");
}
if (ctx) {
  const text = ctx({
    book: "第一哲学沉思集", marks: "", markCount: 0, marksError: "", focusMark: null, focusError: "",
    context: "", focusAnnotationId: null,
    passage: { chapter: "第 4 章（sec_f7f4f1fc3778c58a_3）· 字符区间 [535, 683)", text: SPAN_OK().quote,
      attribution: "book_quote_from_recommendation", locator: "第 4 章（sec_f7f4f1fc3778c58a_3）· 字符区间 [535, 683)",
      source_ref: SPAN_A },
  });
  check(text.includes("书中原文"), "注入上下文把这段标成「书中原文」");
  check(text.includes("不是**用户自己说的话") || text.includes("不是用户自己说的话"),
    "并明确它不是用户自己的话（归属不许混）");
  check(text.includes("AI 的推演") || text.includes("AI 推演"), "并说明推荐理由属 AI 推演（未确认）");
  check(text.includes(SPAN_A), "带出 span 引用，可回溯到推荐的 source_refs");
  check(text.includes("535, 683"), "带出定位（章节 + 字符区间）");
  check(/不要因为取到了一段原文就说「已读懂这本书」/.test(text), "并提醒不要据此宣称「已读懂」");

  // 负控：不带 attribution 的普通 passage 不能被标成「书中原文」
  const plain = ctx({
    book: "书", marks: "", markCount: 0, marksError: "", focusMark: null, focusError: "",
    context: "", focusAnnotationId: null,
    passage: { chapter: "章节「x」", text: "普通一段" },
  });
  check(!plain.includes("书中原文"), "负控：不带 attribution 的 passage 不会被标成书中原文");
}

// --------------------------------------------------------------------------- //
section("[5] 1d：书中观点 / 用户判断 / AI 推演 三种东西分开，不许混");
check(evHtml.includes('id="gd-attrib-book"') && evHtml.includes("① 书中观点"), "① 书中观点单独一块");
check(evHtml.includes('id="gd-attrib-ai"') && evHtml.includes("② AI 推演"), "② AI 推演单独一块");
check(evHtml.includes('id="gd-attrib-user"') && evHtml.includes("③ 用户判断"), "③ 用户判断单独一块");
check(evHtml.includes("origin=ai_inference") && evHtml.includes("confirmation=unconfirmed"),
  "AI 推演标明 origin/confirmation（未确认，不当成书里的话）");
// M14 第 4 环起：面板**仍然不替用户写**，但给了一个「自己打字、自己确认」的入口。
check(evHtml.includes('id="gd-attrib-user"') && evHtml.includes("面板不替你写"),
  "用户判断仍如实说「面板不替你写」（第 4 环给的是入口，不是代写）");
check(evHtml.includes('id="gd-ev-statement"'), "并给出用户自己写话的输入框");
check(evHtml.includes("不等于") && evHtml.includes("未确认"),
  "入口上写明「采集 ≠ 读懂」「默认未确认」");

// --------------------------------------------------------------------------- //
section("[6] 1e：不许宣称「已读懂」/ 全书 100% / 「切片完成 = 理解完成」");
check(evHtml.includes("切片完成 ≠ 分析完成"), "写明「切片完成 ≠ 分析完成」");
const claimRead = affirmativeClaims(evHtml, "已读懂");
check(claimRead.length === 0, "渲染结果里没有**肯定式**的「已读懂」（否定式说明是允许的）", claimRead.join(" | "));
const claim100 = affirmativeClaims(evHtml, "100%");
check(claim100.length === 0, "渲染结果里没有**肯定式**的全书 100%", claim100.join(" | "));
check(!/理解完成|分析完成[。！]/.test(evHtml), "不把「切片完成」说成「理解完成 / 分析完成」");
check(evHtml.includes("不等于已读懂这本书"), "并且明说「能取到原文依据 ≠ 已读懂这本书」");
// 元检查：affirmativeClaims 必须真能区分肯定/否定（否则上面两条是空转）
check(affirmativeClaims("这本书已读懂。", "已读懂").length === 1, "元检查：肯定式能被抓到");
check(affirmativeClaims("这不等于已读懂这本书。", "已读懂").length === 0, "元检查：否定式不误报");

// --------------------------------------------------------------------------- //
section("[7] 第 4 环（M14）：采集**真打后端**，不许前端假成功");
// M14 起这一环确实会保存观察 —— 所以更要盯住：真 fetch 我们自己的路由、后端拒绝要如实说、
// 面板自己绝不写盘、也不出现只有前端能断言的「已写入/已保存」。
const WRITE_MARKERS = ["proposals/compile", "analyze-and-persist", "update_note", "record_reading_feedback",
  "recommendations/run", "maintenance", "method: \"PUT\"", "method: \"DELETE\"", "method: 'PUT'"];
for (const w of WRITE_MARKERS) {
  check(!flowSrc.includes(w), `SOURCE-FLOW 里没有写盘动作：${w}`);
  // 渲染区是**纯函数**（测试原样截取求值）：那里也不许出现写盘动作，
  // 否则「顺手保存」会藏在渲染里，而渲染是每次重绘都跑的。
  check(!viewSrc.includes(w), `渲染区（纯函数）里没有写盘动作：${w}`);
}
// 渲染区连 fetch 都不该有：渲染有副作用 = 重绘就发请求。
check(!/fetch\(/.test(viewSrc), "渲染区里没有 fetch（渲染必须无副作用）");
const posts = ((s) => (s.match(/fetch\(/g) || []).length)(flowSrc.replace(/\/\*[\s\S]*?\*\//g, ""));
check(posts === 2, "SOURCE-FLOW 里**恰好两处** fetch：取原文 + 记观察", `实际=${posts}`);
check(flowSrc.includes('"/reading/source-span"'), "第一处是取原文（书源无关）");
check(flowSrc.includes('"/reading/record-evidence"'), "第二处是记观察，走我们自己的路由");
check(/method: "POST"/.test(flowSrc) && !/method: "PATCH"/.test(flowSrc), "只有 POST，没有 PATCH/PUT/DELETE");
check(!/persisted|commit|writeNote|saveNote/.test(flowSrc), "面板不自己写盘（落盘全在后端事务里）");
check(/j\.ok !== true/.test(flowSrc), "后端 ok!==true 时走**拒绝分支**，原样带出 code/message");
check(/BAD_RESPONSE/.test(flowSrc), "响应不是 JSON 时明确报 BAD_RESPONSE（不假装保存成功）");
check(/幂等命中/.test(flowSrc), "重放时如实说「幂等命中、没有重复写」");
check(/NO_STATEMENT/.test(flowSrc), "用户没打字 ⇒ 本地就挡住（不代写用户判断）");

// --------------------------------------------------------------------------- //
section("[8] 纪律 4：新代码不许加深 Apple Books 耦合");
const newRegion = viewSrc.slice(viewSrc.indexOf("M12：推荐 → 原文")) + flowSrc;
const APPLE_MARKERS = ["iCloud~com~apple~iBooks", "open_in_books_app", "Mobile Documents", "图书」App",
  "Apple Books", "iBooks"];
for (const m of APPLE_MARKERS) {
  check(!newRegion.includes(m), `新增代码区不出现 Apple Books 假设：${m}`);
}
check(!/在 Apple Books 里打开/.test(newRegion), "界面文案不写死「在 Apple Books 里打开」");
check(flowSrc.includes('"/reading/source-span"'), "取原文走的是**我们自己的** /source-span（书源无关）");
check(/isSpanRef/.test(flowSrc) && /SPAN_ID_RE/.test(viewSrc),
  "书源形状（span_id）的判断**只有一处**（将来换书源只改这里）");

// --------------------------------------------------------------------------- //
section("[9] 诚实性总检查：渲染里没有「写盘成功」这类假象");
const loadingHtml = V.renderSourceEvidence({ span_id: SPAN_A, from: "x", phase: "loading", data: null, error: null, requested_url: "/u" });
check(loadingHtml.includes("正在按这条推荐的 source_refs 取原文"), "loading 态如实说「正在取原文」");
check(!loadingHtml.includes("已写入") && !loadingHtml.includes("已保存"), "loading 态不得出现「已写入/已保存」");
check(html.includes('id="guide"'), "index.html 里有导读容器（渲染有落点）");

reportAndExit();
