/**
 * tests/reading-policy.test.mjs · M5 两层推荐策略 / policy.js
 *
 * ## 这份测试在防什么
 * 推荐策略最容易出的不是崩溃，而是**看起来很合理却违反证据与归一化的推荐**：
 *   · `C` 的分母写死 0.70 ⇒ 维度被禁用后 `C` 永远到不了 1、`available` 永远不可达
 *   · `W=0` 时做 `(1-λ)B + λ·null` ⇒ `S=NaN`
 *   · 缺依据的维度被填 `0` 或「中立值」（PRD :271 明令保留 `null`）
 *   · 检索相似度直接充当 `B`（PRD :267 明令禁止）
 *   · `G` 从「知识库为空」推断；`T` 没有真实已表达判断
 *   · 未知维度因归一化拿到**完整 0.40 叠加**
 *   · 仅排除反馈时 `status` 不是 `none`，或**不明示**「已应用本次排除」
 *   · 空背景就整体弃权（PRD :965 禁止）
 *   · `items=[]` 却不给真实 `no_eligible_reason`（PRD :971 结构错误）
 *   · `selected_items` 被当成第三层权威结果
 *   · 复算复用旧 `run_id`（PRD :469「复算创建新run_id」）
 *   · 权重被替换（总和 1.5）后 `C > 1` 或 `λ > 0.40`
 *
 * ## 每条检查「在什么情况下会失败」
 *   [0]  模块形状与闭合词表   — 键集合/词表偏离 PRD 或 schema 就失败
 *   [1]  三组算例（精确分数） — 76/35、73/35 不是逐位一致就失败
 *   [2]  C 的分母与 λ 上限    — 分母不是「启用维度权重之和」就失败
 *   [3]  request 形状         — 走私字段/缺键不被拒就失败
 *   [4]  capabilities         — 缺任一能力不报 HOST_UNSUPPORTED 就失败
 *   [5]  policy_config        — 缺失/非法不回落默认、λ>0.40 不被夹就失败
 *   [6]  质量门（6 类硬约束）  — 越界/换版本/来源不可读/超时仍推荐就失败
 *   [7]  B 锚点与反例         — 检索相似度当 B、B 无理由不被拒就失败
 *   [8]  R/G/T 维度依据       — 只给数字、G 从空库推断、T 无已表达判断不被拒就失败
 *   [9]  证据门（参考/稳定）   — 未授权/过期/撤回/摘要证据被采用就失败
 *   [10] 未知维度与叠加        — 未知维度抬高 C 或进 U 就失败
 *   [11] 两层分开与排序        — 第一层受个人背景影响、第二层收 W=0 就失败
 *   [12] personalization_status — none/limited/available 判据被破坏就失败
 *   [13] 结果形状与结构自检     — 空 book_guide / 无来源浓缩 / items 空无理由不被抓就失败
 *   [14] selected_items        — 不是去重并集或标错 book/personalized/both 就失败
 *   [15] 空背景与弃权          — 空背景弃权、或该弃权时不弃权就失败
 *   [16] run 映射与理解身份    — 18 字段不全、身份按书固定、复算覆盖同一条笔记
 *   [17] 替身忠实性元检查       — 替身自造 hash/自己加工草稿必须被识破
 *   [18] 无法离线验证          — 显式跳过（三分处理），不算通过
 *
 * 跑法：node tests/reading-policy.test.mjs
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** 被测模块路径可用环境变量覆盖（变异测试把改坏的副本写到临时目录）。 */
const POLICY_PATH = process.env.READING_POLICY ?? join(HERE, "..", "lib", "reading", "policy.js");

const P = await import(pathToFileURL(POLICY_PATH).href);
const {
  POLICY_ID,
  POLICY_VERSION,
  RECOMMENDATION_OUTCOMES,
  REQUEST_KEYS,
  CAPABILITY_KEYS,
  RESULT_KEYS,
  PERSONALIZATION_STATUSES,
  PERSONAL_DIMENSIONS,
  DEFAULT_DIMENSION_WEIGHTS,
  DEFAULT_ENABLED_DIMENSIONS,
  DEFAULT_LAMBDA_CAP,
  LAMBDA_HARD_MAX,
  DIMENSION_SCORE_MIN,
  DIMENSION_SCORE_MAX,
  B_SCORE_ANCHORS,
  B_SCORE_MIN,
  B_SCORE_MAX,
  FEEDBACK_TYPES,
  EVIDENCE_KINDS,
  EVIDENCE_TIERS,
  PERSONALIZED_ITEM_KEYS,
  SCORE_KEYS,
  POLICY_AND_MODEL_METADATA_KEYS,
  RECOMMENDATION_RUN_REQUIRED_KEYS,
  DEFAULT_BUDGET,
  EXCLUSION_REASON_CODES,
  CONSTRAINT_REPORT_KEYS,
  APPLIED_EXCLUSION_NOTE,
  UNKNOWN_DIMENSION_LABEL,
  PolicyError,
  Rational,
  exactParse,
  exactToString,
  scoreCandidate,
  validateRankRequest,
  checkCapabilities,
  resolvePolicyConfig,
  resolveBudget,
  resolveReadingBoundary,
  normalizeFeedback,
  buildEvidenceIndex,
  resolveDimensionEvidence,
  runQualityGate,
  sortBookLayer,
  sortPersonalizedLayer,
  selectWithBudget,
  buildOverviewParagraphs,
  computeSelectedItems,
  assertResultShape,
  derivePersonalizationStatus,
  recommendationInputFingerprint,
  buildInputManifestRefs,
  bookRunId,
  bookInfoRel,
  buildBookInfoNote,
  nextRevision,
  mapRecommendationResultToRun,
  validateRunRecord,
  buildRecommendationRunNote,
  buildNoEligibleReason,
  RecommendationPolicy,
  rank,
  ALLOWED_IMPORT_SPECIFIERS,
} = P;

/** 测试自己的 schema 引用（不参与变异）：交叉核对词表与 run 必填字段。 */
const SCHEMA = await import(pathToFileURL(join(HERE, "..", "lib", "reading", "schema.js")).href);
const { VALUE_DOMAINS, SCHEMA_VERSION, validateNote } = SCHEMA;
const { BOOK_DOMAIN } = await import(pathToFileURL(join(HERE, "..", "lib", "reading", "book-domain.js")).href);

// --------------------------------------------------------------------------- //
// 兜底网：任何逃逸异常都必须变成一条**可定位**的 ✗ 行（段落级别）。
// 变异测试里「exit≠0 但零条 ✗」等于检查不可定位＝没抓到，这张网防止那种情况。
// --------------------------------------------------------------------------- //
let CURRENT_SECTION = "(未开始)";
const __realLog = console.log;
console.log = (msg) => {
  if (typeof msg === "string" && /^\[/.test(msg.trim())) CURRENT_SECTION = msg.trim();
  __realLog(msg);
};
const onFatal = (e) => {
  bad(`段落 ${CURRENT_SECTION} 抛出未捕获异常`, `${e?.name}: ${e?.message}`);
  __realLog(`\n结果：${pass} 通过 / ${fail} 失败 / ${skipped} 跳过（中途异常终止）`);
  process.exit(1);
};
process.on("uncaughtException", onFatal);
process.on("unhandledRejection", onFatal);

let pass = 0, fail = 0, skipped = 0;
const ok = (m) => { pass++; console.log("  ✓ " + m); };
const bad = (m, d) => { fail++; console.log("  ✗ " + m + (d ? "\n      " + d : "")); };
const is = (label, got, want) =>
  got === want ? ok(label) : bad(label, `得到 ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}`);
const isNot = (label, got, notWant) =>
  got !== notWant ? ok(label) : bad(label, `不应等于 ${JSON.stringify(notWant)}`);
const truthy = (label, v) => (v ? ok(label) : bad(label, `得到 ${JSON.stringify(v)}，期望真值`));
const falsy = (label, v) => (!v ? ok(label) : bad(label, `得到 ${JSON.stringify(v)}，期望假值`));
const deep = (label, got, want) =>
  JSON.stringify(got) === JSON.stringify(want)
    ? ok(label)
    : bad(label, `得到 ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}`);
const skip = (m, why) => { skipped++; console.log("  ⊘ 跳过 " + m + " —— " + why); };

/** 「必须抛指定错误码」的显式断言。 */
async function expectCode(label, fn, code) {
  try {
    await fn();
    bad(label, `本应抛 ${code}，却成功了`);
  } catch (e) {
    if (e instanceof PolicyError && e.code === code) ok(label);
    else bad(label, `本应抛 ${code}，实际 ${e?.name}:${e?.code ?? ""} ${e?.message ?? e}`);
  }
}

const H = (s) => createHash("sha256").update(s).digest("hex");

// --------------------------------------------------------------------------- //
// 宿主替身（**忠实**：不发明 hash、不加工草稿、不合成检索命中）
// --------------------------------------------------------------------------- //
function makeHost({ spans = {}, knowledge = {}, hits = [], generate = null } = {}) {
  const calls = { readSourceSpan: [], readKnowledge: [], retrieve: [], generateStructured: [] };
  const host = {
    calls,
    async readSourceSpan(id) {
      calls.readSourceSpan.push(id);
      const s = spans[id];
      // 忠实：未知 id 就返回不可用，**不发明** hash / 不编造 span。
      if (!s) return { ok: false, error: "SPAN_NOT_FOUND" };
      return { ...s };
    },
    async readKnowledge(id) {
      calls.readKnowledge.push(id);
      const k = knowledge[id];
      if (!k) return { ok: false, error: "KNOWLEDGE_NOT_FOUND" };
      return { ...k };
    },
    async retrieve(query, scope) {
      calls.retrieve.push({ query, scope });
      return hits.map((h) => ({ ...h }));
    },
    async generateStructured(req, opts) {
      calls.generateStructured.push({ req, opts });
      // 忠实：**原样**返回测试指定的草稿（所以「策略拒了草稿」一定是策略在起作用）。
      return generate === null ? null : generate(req);
    },
  };
  return host;
}

/** 不忠实替身：`readSourceSpan` 自己编 hash（M0 教训的复刻）。 */
function makeUnfaithfulHost({ spans = {} } = {}) {
  const host = makeHost({ spans });
  return {
    ...host,
    async readSourceSpan(id) {
      host.calls.readSourceSpan.push(id);
      const s = spans[id];
      if (!s) return { ok: false, error: "SPAN_NOT_FOUND" };
      // ★ 坏行为：不管真实内容，返回一个自造的 hash。
      return { ...s, text_hash: H(`invented:${id}`) };
    },
  };
}

// --------------------------------------------------------------------------- //
// 夹具
// --------------------------------------------------------------------------- //
function spanFixture(id, section, text, { bookVersion = "bv1" } = {}) {
  return {
    ok: true,
    span_id: id,
    book_version_id: bookVersion,
    section_id: section,
    text_hash: H(text),
    quote: text,
  };
}

function evidenceEntry(ref, over = {}) {
  return {
    ref,
    tier: "reference",
    kind: "observed_performance",
    origin: "user",
    confirmation: "confirmed",
    knowledge_status: "active",
    valid_until: null,
    source_verifiable: true,
    source_kind: "user_action",
    ...over,
  };
}

function candidateFixture(over = {}) {
  return {
    candidate_id: "c1",
    book_version_id: "bv1",
    section_id: "s1",
    section_order: 1,
    concept_refs: [],
    book_evidence_refs: [{ span_id: "sp1", text_hash: H("q1") }],
    b: { score: 2, reason: "代表性论点/必要前提", basis: { kind: "book_analysis" } },
    personal: {},
    overview_paragraph: { text: "第一层导读（有来源）", source_refs: ["sp1"] },
    estimated_minutes: 10,
    uncertainty: null,
    ...over,
  };
}

function requestFixture(over = {}) {
  return {
    schema_version: SCHEMA_VERSION,
    run_id: "rr_test_0001",
    book_version_id: "bv1",
    coverage_snapshot: {
      scope: "parsed_body",
      section_ids: ["s1", "s2"],
      candidate_set_version: "cs_v1",
      ref: "cov_1",
    },
    goal: null,
    allowed_profile_refs_and_short_evidence: [],
    note_ids_and_hashes: [],
    candidates: [candidateFixture()],
    reading_boundary: { mode: "whole_book" },
    recent_feedback: [],
    policy_config: null,
    budget: null,
    ...over,
  };
}

const DEFAULT_SPANS = {
  sp1: spanFixture("sp1", "s1", "q1"),
  sp2: spanFixture("sp2", "s2", "q2"),
  sp3: spanFixture("sp3", "s3", "q3"),
};

const GEN_ONE = () => ({ overview_paragraphs: [{ text: "生成的导读（有来源）", source_refs: ["sp1"] }] });

function runCtx(req, over = {}) {
  return {
    run_id: req.run_id,
    job_id: "job_1",
    book_version_id: req.book_version_id,
    input_fingerprint: recommendationInputFingerprint(req),
    input_manifest_refs: buildInputManifestRefs(req),
    candidate_set_version: "cs_v1",
    prompt_template_version: "pt_v1",
    policy: { id: POLICY_ID, version: POLICY_VERSION },
    model: "model_x",
    ...over,
  };
}

// --------------------------------------------------------------------------- //
// 防御式取值（变异测试改坏 policy.js 后，缺失字段必须变成**失败的断言**，
// 而不是让套件抛异常崩掉 —— 崩溃＝检查不可定位＝等于没抓到，M2/M3 的教训）。
// --------------------------------------------------------------------------- //
const arr = (a) => (Array.isArray(a) ? a : []);
const first = (a) => (Array.isArray(a) && a.length > 0 ? a[0] : { scores: {} });
const guide = (r) => ({
  items: [], overview_paragraphs: [], source_refs: [], no_eligible_reason: null,
  coverage_scope: {},
  ...(r?.book_guide ?? {}),
});
const items = (r) => arr(guide(r).items);
const pItems = (r) => arr(r?.personalized_items);
const report = (r) => ({
  applied_feedback_exclusions: { applied: false, feedback_refs: [], note: null },
  dropped_dimensions: [], unknown_dimensions: [],
  selection_tradeoffs: {
    book: { diversity_deferred: [], limit_excluded: [], time_excluded: [] },
    personalized: { diversity_deferred: [], limit_excluded: [], time_excluded: [] },
  },
  soft_signals: { known: [], disagree: [] },
  policy_config_fallback: { used: false },
  lambda_cap_clamped: null,
  retrieval_hits_ignored_for_baseline: [],
  gate_order: [],
  ...(r?.constraints_report ?? {}),
});
const dropped = (r) => arr(report(r).dropped_dimensions);
const findP = (r, id) =>
  pItems(r).find((i) => i.candidate_id === id) ?? { scores: {} };
const findBook = (r, id) => items(r).find((i) => i.candidate_id === id) ?? {};
const trade = (r, layer) => ({
  diversity_deferred: [], limit_excluded: [], time_excluded: [],
  ...(report(r).selection_tradeoffs?.[layer] ?? {}),
});

/**
 * rank 的安全版：policy 抛错时返回一个「结构完整但内容为空」的结果，
 * 让后续断言逐条失败（可定位），而不是让整个套件崩在第 554 行。
 * 真正的「必须抛某错误码」用例仍然直接调用 rank() + expectCode。
 */
async function R(req, host) {
  try {
    return await rank(req, host);
  } catch (e) {
    return {
      __threw: `${e?.code ?? e?.name}: ${e?.message}`,
      book_guide: null,
      personalized_items: [],
      exclusions: [],
      constraints_report: {},
      policy_and_model_metadata: {},
    };
  }
}

/** 递归找出结果里所有键名，用于「不得出现 confidence 类字段」的检查。 */
function allKeys(v, acc = []) {
  if (Array.isArray(v)) { for (const x of v) allKeys(x, acc); return acc; }
  if (v !== null && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) { acc.push(k); allKeys(x, acc); }
  }
  return acc;
}

// =========================================================================== //
console.log("\n[0] 模块形状与闭合词表");
// =========================================================================== //
{
  deep("RecommendationResult 顶层恰好 7 键（冻结裁定①）", [...RESULT_KEYS], [
    "outcome", "book_guide", "personalized_items", "personalization_status",
    "exclusions", "constraints_report", "policy_and_model_metadata",
  ]);
  is("result 7 键里没有 selected_items（不进 result）", RESULT_KEYS.includes("selected_items"), false);
  is("request 恰好 12 键", REQUEST_KEYS.length, 12);
  deep("request 键与 PRD :925-928 逐字一致", [...REQUEST_KEYS], [
    "schema_version", "run_id", "book_version_id", "coverage_snapshot", "goal",
    "allowed_profile_refs_and_short_evidence", "note_ids_and_hashes", "candidates",
    "reading_boundary", "recent_feedback", "policy_config", "budget",
  ]);
  is("capabilities 恰好 4 项", CAPABILITY_KEYS.length, 4);
  deep("capabilities 与 PRD :929-930 逐字一致", [...CAPABILITY_KEYS],
    ["readSourceSpan", "readKnowledge", "retrieve", "generateStructured"]);
  deep("outcome 值域恰好两个", [...RECOMMENDATION_OUTCOMES], ["items", "insufficient_evidence"]);
  deep("status 值域 none/limited/available", [...PERSONALIZATION_STATUSES], ["none", "limited", "available"]);
  deep("个人维度恰好 R/G/T", [...PERSONAL_DIMENSIONS], ["R", "G", "T"]);
  is("B 锚点恰好 4 档", Object.keys(B_SCORE_ANCHORS).length, 4);
  is("B 锚点 0", B_SCORE_ANCHORS[0], "有来源但缺阅读价值");
  is("B 锚点 1", B_SCORE_ANCHORS[1], "局部补充");
  is("B 锚点 2", B_SCORE_ANCHORS[2], "代表性论点/必要前提");
  is("B 锚点 3", B_SCORE_ANCHORS[3], "核心论证或关键边界");
  is("B 范围 0—3", `${B_SCORE_MIN}-${B_SCORE_MAX}`, "0-3");
  is("维度分值范围 0—3", `${DIMENSION_SCORE_MIN}-${DIMENSION_SCORE_MAX}`, "0-3");
  deep("scores 恰好 10 键", [...SCORE_KEYS], ["B", "R", "G", "T", "W", "C", "q", "lambda", "U", "S"]);
  is("personalized_items 每项恰好 6 键", PERSONALIZED_ITEM_KEYS.length, 6);
  deep("personalized_items 键与 PRD :934-935 一致", [...PERSONALIZED_ITEM_KEYS],
    ["candidate_id", "reasons", "dimension_evidence", "scores", "uncertainty", "source_refs"]);

  // 与 M1 schema 交叉核对（不是硬编码信任）
  deep("feedback_type 闭合集合与 M1 schema 同源",
    [...FEEDBACK_TYPES].sort(), [...VALUE_DOMAINS.feedback_type].sort());
  is("feedback_type 恰好 7 个", FEEDBACK_TYPES.length, 7);
  deep("evidence kind 与 M1 schema 同源",
    [...EVIDENCE_KINDS].sort(), [...VALUE_DOMAINS.reading_evidence_kind].sort());
  is("「知识库为空」不是合法 evidence kind", EVIDENCE_KINDS.includes("empty_knowledge_base"), false);

  const schemaSrc = readFileSync(join(HERE, "..", "lib", "reading", "schema.js"), "utf8");
  const m = /recommendation_run:\s*\{[\s\S]*?required:\s*\[([\s\S]*?)\]/.exec(schemaSrc);
  truthy("能从 schema.js 提取 recommendation_run.required", m !== null);
  const requiredFromSchema = m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [];
  is("schema.js 里 run 必填字段 18 个", requiredFromSchema.length, 18);
  deep("run 必填字段集合与 schema.js 完全一致",
    [...RECOMMENDATION_RUN_REQUIRED_KEYS].sort(), [...requiredFromSchema].sort());

  is("默认权重 R", DEFAULT_DIMENSION_WEIGHTS.R, "0.30");
  is("默认权重 G", DEFAULT_DIMENSION_WEIGHTS.G, "0.20");
  is("默认权重 T", DEFAULT_DIMENSION_WEIGHTS.T, "0.20");
  deep("默认启用维度三者全启用", [...DEFAULT_ENABLED_DIMENSIONS], ["R", "G", "T"]);
  is("默认 Σ(启用维度权重) = 7/10",
    exactToString(Rational.add(Rational.add(exactParse("0.30"), exactParse("0.20")), exactParse("0.20"))), "7/10");
  is("默认 λ 上限 0.40", DEFAULT_LAMBDA_CAP, "0.40");
  is("硬上限 λ ≤ 0.40", LAMBDA_HARD_MAX, "0.40");
  is("仅排除反馈的文案", APPLIED_EXCLUSION_NOTE, "已应用本次排除");
  is("未知维度显示标签", UNKNOWN_DIMENSION_LABEL, "unknown");
  is("默认每层最多 3 项（PRD :282）", DEFAULT_BUDGET.max_items_per_layer, 3);
  truthy("排除原因码是闭合数组", Array.isArray(EXCLUSION_REASON_CODES) && EXCLUSION_REASON_CODES.length > 0);
  truthy("constraints_report 键是闭合数组", Array.isArray(CONSTRAINT_REPORT_KEYS));
  truthy("policy_and_model_metadata 键是闭合数组", Array.isArray(POLICY_AND_MODEL_METADATA_KEYS));

  // 依赖闭包：只准依赖 schema.js + compiler.js（执行计划 §1 #6），不引 fs/宿主。
  const src = readFileSync(POLICY_PATH, "utf8");
  const imports = [...src.matchAll(/^\s*import[\s\S]*?from\s+"([^"]+)"/gm)].map((x) => x[1]);
  deep("policy.js 的 import 恰好是 schema.js + compiler.js + book-domain.js", [...imports].sort(),
    [...ALLOWED_IMPORT_SPECIFIERS].sort());
  falsy("policy.js 不引入 node: 内置模块", imports.some((i) => i.startsWith("node:")));
  falsy("policy.js 不引入 cordis / 宿主模块", imports.some((i) => i.includes("cordis") || i.includes("dsh-")));
}

// =========================================================================== //
console.log("\n[1] 三组算例（PRD :275-277，精确分数）");
// =========================================================================== //
{
  const base = {
    weights: DEFAULT_DIMENSION_WEIGHTS,
    enabled_dimensions: DEFAULT_ENABLED_DIMENSIONS,
    lambda_cap: DEFAULT_LAMBDA_CAP,
  };
  const v1 = scoreCandidate({ b: 2, dimensions: {}, ...base });
  is("① W=0", v1.exact.W, "0");
  is("① C=0", v1.exact.C, "0");
  is("① q=1", v1.exact.q, "1");
  is("① U=null（W=0 不计算）", v1.exact.U, null);
  is("① λ=0", v1.exact.lambda, "0");
  is("① S=B=2", v1.exact.S, "2");
  is("① 数值 U 也是 null（不做 null 乘法）", v1.scores.U, null);
  is("① 数值 S=2", v1.scores.S, 2);
  is("① 未个性化 ⇒ 无已知维度", v1.known.length, 0);

  const v2 = scoreCandidate({ b: 2, dimensions: { R: 3 }, ...base });
  is("② W=3/10", v2.exact.W, "3/10");
  is("② C=3/7（分母 = 启用维度权重之和 0.70）", v2.exact.C, "3/7");
  is("② q=1", v2.exact.q, "1");
  is("② U=3", v2.exact.U, "3");
  is("② λ=6/35", v2.exact.lambda, "6/35");
  is("② S=76/35（精确分数，不是浮点近似）", v2.exact.S, "76/35");
  is("② 数值 S === 76/35", v2.scores.S, 76 / 35);
  is("② 数值 λ === 6/35", v2.scores.lambda, 6 / 35);
  is("② λ ≤ 0.40", v2.scores.lambda <= 0.4, true);

  const v3 = scoreCandidate({ b: 2, dimensions: { R: 3 }, soft_dimensions: ["R"], ...base });
  is("③ q=1/2（未确认观察）", v3.exact.q, "1/2");
  is("③ C 不变 =3/7", v3.exact.C, "3/7");
  is("③ U=3", v3.exact.U, "3");
  is("③ λ=3/35", v3.exact.lambda, "3/35");
  is("③ S=73/35（精确分数）", v3.exact.S, "73/35");
  is("③ 数值 S === 73/35", v3.scores.S, 73 / 35);
  truthy("③ S(③) < S(②)（未确认观察降权）", v3.scores.S < v2.scores.S);

  is("λ ≤ 0.40 恒成立（三组算例）",
    [v1, v2, v3].every((v) => v.scores.lambda <= 0.4), true);
  is("B 独立保留（三组算例 B 都是 2）", [v1, v2, v3].every((v) => v.scores.B === 2), true);

  // W=0 时绝不出现 NaN（null 乘法的典型症状）
  falsy("① S 不是 NaN（W=0 不做 null 乘法）", Number.isNaN(v1.scores.S));
  falsy("① λ 不是 NaN", Number.isNaN(v1.scores.lambda));

  // 精确有理数工具自身
  is("Rational 解析 0.30 ⇒ 3/10", exactToString(exactParse("0.30")), "3/10");
  is("Rational 解析 0.3（number）⇒ 3/10", exactToString(exactParse(0.3)), "3/10");
  is("Rational 解析 3/7", exactToString(exactParse("3/7")), "3/7");
  is("Rational 相加 3/10+2/5 = 7/10", exactToString(Rational.add(exactParse("0.30"), exactParse("0.40"))), "7/10");
  is("Rational 除法 (3/10)/(7/10) = 3/7", exactToString(Rational.div(exactParse("0.30"), exactParse("0.70"))), "3/7");
  is("Rational 整数显示不带分母", exactToString(exactParse(2)), "2");
  is("Rational 拒绝非法输入", exactParse("abc"), null);
}

// =========================================================================== //
console.log("\n[2] C 的分母 = 启用维度权重之和（冻结裁定②）");
// =========================================================================== //
{
  // 禁用 T：分母 = 0.30+0.20 = 0.50 ⇒ R、G 都有依据时 C=1（available 可达）
  const dis = {
    weights: DEFAULT_DIMENSION_WEIGHTS,
    enabled_dimensions: ["R", "G"],
    lambda_cap: DEFAULT_LAMBDA_CAP,
  };
  const s = scoreCandidate({ b: 2, dimensions: { R: 3, G: 2 }, ...dis });
  is("禁用 T 时 W=1/2", s.exact.W, "1/2");
  is("禁用 T 时 C=1（分母是启用维度之和，不是写死 0.70）", s.exact.C, "1");
  is("禁用 T 时 λ=2/5=0.40（上限内）", s.exact.lambda, "2/5");
  is("禁用 T 时 status 能到 available", derivePersonalizationStatus([
    { scores: { C: s.scores.C, q: s.scores.q } },
  ]), "available");

  // 反例：若分母写死 0.70，禁用 T 时 C 只能是 0.50/0.70 = 5/7 ≠ 1
  isNot("禁用 T 时 C 不是 5/7（证明分母不是写死 0.70）", s.exact.C, "5/7");

  // 权重被替换（总和 1.5）
  const w15 = {
    weights: { R: "0.60", G: "0.45", T: "0.45" },
    enabled_dimensions: DEFAULT_ENABLED_DIMENSIONS,
    lambda_cap: DEFAULT_LAMBDA_CAP,
  };
  const all3 = scoreCandidate({ b: 2, dimensions: { R: 3, G: 3, T: 3 }, ...w15 });
  is("权重总和 1.5 时 Σ=3/2", exactToString(Rational.add(Rational.add(exactParse("0.60"), exactParse("0.45")), exactParse("0.45"))), "3/2");
  is("权重总和 1.5、三维全知 ⇒ W=3/2", all3.exact.W, "3/2");
  is("权重总和 1.5 ⇒ C=1（≤1 由构造保证）", all3.exact.C, "1");
  is("权重总和 1.5 ⇒ λ=2/5 ≤ 0.40", all3.exact.lambda, "2/5");
  truthy("权重总和 1.5 时 λ ≤ 0.40", all3.scores.lambda <= 0.4);
  const one = scoreCandidate({ b: 2, dimensions: { R: 3 }, ...w15 });
  is("权重总和 1.5、仅 R 已知 ⇒ C=0.60/1.5=2/5", one.exact.C, "2/5");
  truthy("权重总和 1.5 时 C ≤ 1", one.scores.C <= 1);

  // 单维高分只获得有限叠加（λ ≤ 0.40）
  const onlyR = scoreCandidate({ b: 2, dimensions: { R: 3 }, ...{
    weights: DEFAULT_DIMENSION_WEIGHTS, enabled_dimensions: DEFAULT_ENABLED_DIMENSIONS, lambda_cap: DEFAULT_LAMBDA_CAP,
  } });
  truthy("单维高分只获得有限叠加（λ=6/35 < 0.40）", onlyR.scores.lambda < 0.4);
  truthy("单维高分不会让 S 超过 U 的上界", onlyR.scores.S <= 3);
}

// =========================================================================== //
console.log("\n[3] request 形状（键集合闭合）");
// =========================================================================== //
{
  const host = makeHost({ spans: DEFAULT_SPANS, generate: GEN_ONE });
  const good = requestFixture();
  is("合法 request 通过", validateRankRequest(good).ok, true);
  deep("request 键集合恰好 12", Object.keys(good).length, 12);
  await expectCode("多一个未定义字段被拒", () => rank({ ...good, extra: 1 }, host), "INVALID_REQUEST");
  await expectCode("走私 selected_items 被拒", () => rank({ ...good, selected_items: [] }, host), "INVALID_REQUEST");
  await expectCode("走私 application_mode 被拒", () => rank({ ...good, application_mode: "authorized_auto" }, host), "INVALID_REQUEST");
  await expectCode("走私 result 被拒", () => rank({ ...good, result: {} }, host), "INVALID_REQUEST");
  await expectCode("缺 run_id 被拒", () => rank({ ...good, run_id: undefined }, host), "MISSING_REQUIRED");
  await expectCode("run_id 空串被拒", () => rank({ ...good, run_id: "  " }, host), "MISSING_REQUIRED");
  await expectCode("schema_version 不对被拒", () => rank({ ...good, schema_version: "1.0" }, host), "INVALID_VALUE");
  await expectCode("candidates 不是数组被拒", () => rank({ ...good, candidates: {} }, host), "INVALID_STRUCTURE");
  await expectCode("coverage_snapshot 不是映射被拒", () => rank({ ...good, coverage_snapshot: [] }, host), "INVALID_STRUCTURE");
  await expectCode("reading_boundary 缺失被拒", () => { const r = { ...good }; delete r.reading_boundary; return rank(r, host); }, "MISSING_REQUIRED");
  await expectCode("recent_feedback 不是数组被拒", () => rank({ ...good, recent_feedback: "x" }, host), "INVALID_STRUCTURE");
  await expectCode("request 不是映射被拒", () => rank(null, host), "INVALID_REQUEST");
  await expectCode("candidate_id 重复被拒",
    () => rank({ ...good, candidates: [candidateFixture(), candidateFixture()] }, host), "INVALID_COMBINATION");
  await expectCode("goal 类型错误被拒", () => rank({ ...good, goal: 42 }, host), "INVALID_STRUCTURE");
  is("goal 可省略（可选键）", validateRankRequest((() => { const r = { ...good }; delete r.goal; return r; })()).ok, true);
  is("allowed_profile_refs 可省略（可选键）",
    validateRankRequest((() => { const r = { ...good }; delete r.allowed_profile_refs_and_short_evidence; return r; })()).ok, true);
}

// =========================================================================== //
console.log("\n[4] capabilities（恰好 4 项，缺一即 HOST_UNSUPPORTED）");
// =========================================================================== //
{
  const host = makeHost({ spans: DEFAULT_SPANS, generate: GEN_ONE });
  is("四项齐全通过", checkCapabilities(host).ok, true);
  for (const k of CAPABILITY_KEYS) {
    const partial = { ...host };
    delete partial[k];
    await expectCode(`缺 ${k} ⇒ HOST_UNSUPPORTED`, () => rank(requestFixture(), partial), "HOST_UNSUPPORTED");
  }
  await expectCode("capabilities 不是映射被拒", () => rank(requestFixture(), null), "HOST_UNSUPPORTED");
  await expectCode("能力不是函数被拒", () => rank(requestFixture(), { ...host, retrieve: 1 }), "HOST_UNSUPPORTED");
  const err = await (async () => { try { await rank(requestFixture(), { ...host, retrieve: 1 }); return null; } catch (e) { return e; } })();
  is("缺能力是 failed（重试无意义）", err.work_job_state, "failed");
  is("缺能力不伪装成弃权", err.code === "insufficient_evidence", false);
}

// =========================================================================== //
console.log("\n[5] policy_config（缺失/非法 ⇒ 默认 Σ=0.70；λ>0.40 被夹）");
// =========================================================================== //
{
  const host = makeHost({ spans: DEFAULT_SPANS, generate: GEN_ONE });
  const missing = resolvePolicyConfig(null);
  is("缺失 ⇒ 默认 R", missing.config.weights.R, "0.30");
  deep("缺失 ⇒ 三者全启用", missing.config.enabled_dimensions, ["R", "G", "T"]);
  is("缺失 ⇒ λ 上限 0.40", missing.config.lambda_cap, "0.40");
  truthy("缺失被记录为 fallback", missing.fallback.used);
  is("缺失 fallback 原因", missing.fallback.reason, "missing");

  is("非法（非映射）⇒ 默认", resolvePolicyConfig("x").config.weights.R, "0.30");
  is("非法（未知键）⇒ 默认", resolvePolicyConfig({ nope: 1 }).config.weights.R, "0.30");
  is("非法（权重不可解析）⇒ 默认", resolvePolicyConfig({ weights: { R: "abc" } }).config.weights.R, "0.30");
  is("非法（启用维度未知）⇒ 默认", resolvePolicyConfig({ enabled_dimensions: ["X"] }).config.weights.R, "0.30");
  is("非法（启用维度重复）⇒ 默认", resolvePolicyConfig({ enabled_dimensions: ["R", "R"] }).config.enabled_dimensions.length, 3);
  is("非法（启用维度权重为 0）⇒ 默认", resolvePolicyConfig({ weights: { R: "0" } }).config.weights.R, "0.30");

  const clamped = resolvePolicyConfig({ lambda_cap: "0.90" });
  is("λ 上限 0.90 ⇒ 夹到 0.40（硬不变式优先）", clamped.config.lambda_cap, "0.40");
  truthy("夹住被记录（不静默）", clamped.clamped !== null);
  is("记录请求值", clamped.clamped.requested, "0.90");
  const okCap = resolvePolicyConfig({ lambda_cap: "0.25" });
  is("合法替换 λ 上限 0.25 被尊重", okCap.config.lambda_cap, "0.25");
  is("合法替换不报 clamp", okCap.clamped, null);

  // 端到端：policy_config 缺失 ⇒ Σ=0.70 ⇒ C=3/7
  const r = await R(requestFixture({
    goal: { ref: "goal:current", text: "减少等待时间" },
    candidates: [candidateFixture({
      personal: { R: { score: 3, reason: "回应用户本次目标", evidence_refs: ["goal:current"] } },
    })],
  }), host);
  is("policy_config 缺失 ⇒ C=3/7（Σ=0.70）", first(pItems(r)).scores.C, 3 / 7);
  is("policy_config 缺失 ⇒ λ=6/35", first(pItems(r)).scores.lambda, 6 / 35);
  truthy("policy_config fallback 记进 constraints_report", report(r).policy_config_fallback.used);

  // 端到端：λ 上限 0.90 被夹后仍 ≤0.40
  const r2 = await R(requestFixture({
    policy_config: { lambda_cap: "0.90" },
    goal: { ref: "goal:current", text: "t" },
    candidates: [candidateFixture({
      personal: { R: { score: 3, reason: "r", evidence_refs: ["goal:current"] } },
    })],
  }), host);
  truthy("λ 上限被夹后 λ ≤ 0.40", first(pItems(r2)).scores.lambda <= 0.4);
  truthy("夹住记录进 constraints_report", report(r2).lambda_cap_clamped !== null);

  // budget 非法 ⇒ 默认
  is("budget 非法 ⇒ 默认 3", resolveBudget({ max_items_per_layer: -1 }).budget.max_items_per_layer, 3);
  is("budget 合法被尊重", resolveBudget({ max_items_per_layer: 1 }).budget.max_items_per_layer, 1);
}

// =========================================================================== //
console.log("\n[6] 质量门（来源/剧透/版本/时间/用户排除，先过门）");
// =========================================================================== //
{
  const host = makeHost({ spans: DEFAULT_SPANS, generate: GEN_ONE });

  // 版本不符
  let r = await R(requestFixture({
    candidates: [candidateFixture({ book_version_id: "bv_other" })],
  }), host);
  is("版本不符 ⇒ insufficient_evidence（无本版本可信材料）", r.outcome, "insufficient_evidence");
  is("版本不符被记入 exclusions", first(arr(r.exclusions)).reason_code, "version_mismatch");

  // span 版本不符
  const otherSpan = { spx: spanFixture("spx", "s1", "qx", { bookVersion: "bv_other" }) };
  r = await R(requestFixture({
    candidates: [candidateFixture({ book_evidence_refs: ["spx"] })],
  }), makeHost({ spans: otherSpan, generate: GEN_ONE }));
  is("span 版本不符 ⇒ version_mismatch", first(arr(r.exclusions)).reason_code, "version_mismatch");

  // 剧透边界：through_section
  const twoCands = [
    candidateFixture({ candidate_id: "c1", section_id: "s1", section_order: 1 }),
    candidateFixture({ candidate_id: "c2", section_id: "s2", section_order: 2, book_evidence_refs: ["sp2"] }),
  ];
  r = await R(requestFixture({
    reading_boundary: { mode: "through_section", through_section_order: 1 },
    candidates: twoCands,
  }), host);
  is("越界候选被排除", (arr((r.exclusions)).find((e) => e.candidate_id === "c2") ?? {}).reason_code, "outside_reading_boundary");
  deep("第一层只含边界内候选", items(r).map((i) => i.candidate_id), ["c1"]);
  falsy("越界候选不在 selected_items", computeSelectedItems(r.book_guide, pItems(r)).some((s) => s.candidate_id === "c2"));
  is("剧透门结果被记录", report(r).reading_boundary_passed, false);

  // 剧透边界：无法核验（候选没有章节顺序）
  r = await R(requestFixture({
    reading_boundary: { mode: "through_section", through_section_order: 2 },
    candidates: [candidateFixture({ section_order: null })],
  }), host);
  is("边界无法核验 ⇒ 不推荐", first(arr(r.exclusions)).reason_code, "reading_boundary_unverifiable");
  is("无法核验 ⇒ 整体弃权（没有安全的浓缩材料）", r.outcome, "insufficient_evidence");

  // 百分比边界被拒（PRD :218）
  await expectCode("用阅读百分比推定边界被拒",
    () => rank(requestFixture({ reading_boundary: { mode: "percent", percent: 30 } }), host),
    "READING_BOUNDARY_PERCENT_NOT_ALLOWED");
  await expectCode("reading_boundary 带 percent 字段被拒",
    () => rank(requestFixture({ reading_boundary: { mode: "whole_book", percent: 30 } }), host),
    "READING_BOUNDARY_PERCENT_NOT_ALLOWED");
  await expectCode("边界 mode 非法被拒",
    () => rank(requestFixture({ reading_boundary: { mode: "chapter" } }), host), "INVALID_ENUM");
  is("whole_book 边界全部通过", resolveReadingBoundary({ mode: "whole_book" }).mode, "whole_book");

  // 来源不可读
  r = await R(requestFixture({
    candidates: [candidateFixture({ book_evidence_refs: ["missing_span"] })],
  }), host);
  is("来源不可读 ⇒ source_unavailable", first(arr(r.exclusions)).reason_code, "source_unavailable");
  is("来源不可读 ⇒ 整体弃权（缺可信书内材料）", r.outcome, "insufficient_evidence");

  // span hash 不符
  r = await R(requestFixture({
    candidates: [candidateFixture({ book_evidence_refs: [{ span_id: "sp1", text_hash: H("tampered") }] })],
  }), host);
  is("span hash 不符 ⇒ source_hash_mismatch", first(arr(r.exclusions)).reason_code, "source_hash_mismatch");
  is("hash 不符 ⇒ citation_passed=false", report(r).citation_passed, false);

  // 无书内依据 ⇒ 不评分/不推荐（不是 B=0）
  r = await R(requestFixture({
    candidates: [candidateFixture({ book_evidence_refs: [], query: "等待时间" })],
  }), makeHost({ spans: DEFAULT_SPANS, generate: GEN_ONE, hits: [{ span_id: "h1" }, { span_id: "h2" }, { span_id: "h3" }] }));
  is("无书内依据 ⇒ insufficient_book_evidence", first(arr(r.exclusions)).reason_code, "insufficient_book_evidence");
  is("无书内依据 ⇒ 整体弃权（不是给 B=0）", r.outcome, "insufficient_evidence");
  is("检索命中被记录为「未用作 B」", report(r).retrieval_hits_ignored_for_baseline[0].hits, 3);
  is("元数据声明检索未被当作基线", r.policy_and_model_metadata.retrieval_used_as_baseline, false);

  // B=null ⇒ no_book_value_score（不是 0）
  r = await R(requestFixture({
    candidates: [candidateFixture({ b: { score: null, reason: "证据不足" } })],
  }), host);
  is("B=null ⇒ no_book_value_score", first(arr(r.exclusions)).reason_code, "no_book_value_score");
  is("B=null ⇒ 不推荐（不填 0）", r.outcome, "insufficient_evidence");

  // 时间上限
  r = await R(requestFixture({
    budget: { max_minutes: 5 },
    candidates: [candidateFixture({ estimated_minutes: 30 })],
  }), host);
  is("超时间上限 ⇒ outside_time_budget", first(arr(r.exclusions)).reason_code, "outside_time_budget");

  // 用户明确排除
  r = await R(requestFixture({
    recent_feedback: [{ feedback_id: "fb1", feedback_type: "not_interested", feedback_scope: "item", item_id: "c1", user_action_id: "ua1" }],
  }), host);
  is("用户明确排除 ⇒ user_excluded", first(arr(r.exclusions)).reason_code, "user_excluded");
  is("全部候选被约束排除 ⇒ 仍是 items（不是弃权）", r.outcome, "items");
  is("全部候选被约束排除 ⇒ items=[]", items(r).length, 0);
  truthy("items=[] 必须给 no_eligible_reason", typeof guide(r).no_eligible_reason === "string" && guide(r).no_eligible_reason.length > 0);

  // 反馈缺可信用户动作 ⇒ 不生效
  r = await R(requestFixture({
    recent_feedback: [{ feedback_id: "fb1", feedback_type: "not_interested", feedback_scope: "item", item_id: "c1" }],
  }), host);
  is("缺可信用户动作的反馈不生效", items(r).length, 1);
  falsy("未生效 ⇒ applied=false", report(r).applied_feedback_exclusions.applied);

  // 门顺序被记录
  deep("门顺序与 PRD :263 一致", report(r).gate_order,
    ["authorization", "reading_boundary", "citation_validity", "book_version", "user_exclusion", "time_budget"]);

  // 反馈类型闭合
  await expectCode("feedback_type 不在 7 值内被拒",
    () => rank(requestFixture({ recent_feedback: [{ feedback_type: "liked", user_action_id: "u" }] }), host),
    "INVALID_ENUM");
}

// =========================================================================== //
console.log("\n[7] B 锚点与反例");
// =========================================================================== //
{
  const host = makeHost({ spans: DEFAULT_SPANS, generate: GEN_ONE });
  for (const b of [0, 1, 2, 3]) {
    const r = await R(requestFixture({ candidates: [candidateFixture({ b: { score: b, reason: `锚点 ${b}`, basis: { kind: "book_analysis" } } })] }), host);
    is(`B=${b} 合法且被采用`, first(items(r)).B, b);
  }
  await expectCode("B=4 越界被拒",
    () => rank(requestFixture({ candidates: [candidateFixture({ b: { score: 4, reason: "r", basis: { kind: "book_analysis" } } })] }), host),
    "INVALID_VALUE");
  await expectCode("B=-1 越界被拒",
    () => rank(requestFixture({ candidates: [candidateFixture({ b: { score: -1, reason: "r", basis: { kind: "book_analysis" } } })] }), host),
    "INVALID_VALUE");
  await expectCode("B 无理由被拒",
    () => rank(requestFixture({ candidates: [candidateFixture({ b: { score: 2, basis: { kind: "book_analysis" } } })] }), host),
    "B_WITHOUT_REASON");
  await expectCode("检索相似度直接当 B 被拒",
    () => rank(requestFixture({ candidates: [candidateFixture({ b: { score: 2, reason: "相似度 0.91", basis: { kind: "retrieval_similarity" } } })] }), host),
    "B_FROM_RETRIEVAL_SIMILARITY");
  await expectCode("B 依据类型未知被拒",
    () => rank(requestFixture({ candidates: [candidateFixture({ b: { score: 2, reason: "r", basis: { kind: "vibes" } } })] }), host),
    "INVALID_ENUM");

  // B=0 可被采用（0 不等于 unknown）
  const r0 = await R(requestFixture({
    candidates: [candidateFixture({ b: { score: 0, reason: "有来源但缺阅读价值", basis: { kind: "book_analysis" } } })],
  }), host);
  is("B=0 是有说明的序位值（不是 unknown）", first(items(r0)).B, 0);
  is("B=0 与 unknown 不同：候选仍在第一层", r0.outcome, "items");
}

// =========================================================================== //
console.log("\n[8] R/G/T 维度依据（不能仅给数字）");
// =========================================================================== //
{
  const host = makeHost({ spans: DEFAULT_SPANS, generate: GEN_ONE });
  const ev = [evidenceEntry("pe1")];

  await expectCode("维度有分值但无理由被拒",
    () => rank(requestFixture({ allowed_profile_refs_and_short_evidence: ev, candidates: [candidateFixture({ personal: { R: { score: 3, evidence_refs: ["pe1"] } } })] }), host),
    "DIMENSION_SCORE_WITHOUT_REASON");
  await expectCode("维度有分值但无 evidence_refs 被拒",
    () => rank(requestFixture({ allowed_profile_refs_and_short_evidence: ev, candidates: [candidateFixture({ personal: { R: { score: 3, reason: "r", evidence_refs: [] } } })] }), host),
    "DIMENSION_SCORE_WITHOUT_REASON");
  await expectCode("维度分值越界被拒",
    () => rank(requestFixture({ allowed_profile_refs_and_short_evidence: ev, candidates: [candidateFixture({ personal: { R: { score: 5, reason: "r", evidence_refs: ["pe1"] } } })] }), host),
    "INVALID_VALUE");
  await expectCode("维度分值为 0 但无理由也被拒",
    () => rank(requestFixture({ allowed_profile_refs_and_short_evidence: ev, candidates: [candidateFixture({ personal: { R: { score: 0, evidence_refs: ["pe1"] } } })] }), host),
    "DIMENSION_SCORE_WITHOUT_REASON");

  // 模型不得自报归属/确认
  await expectCode("候选自报 confirmation 被拒",
    () => rank(requestFixture({ allowed_profile_refs_and_short_evidence: ev, candidates: [candidateFixture({ personal: { R: { score: 3, reason: "r", evidence_refs: ["pe1"], confirmation: "confirmed" } } })] }), host),
    "MODEL_MUST_NOT_SELF_REPORT_CONFIRMATION");
  await expectCode("候选自报 basis 被拒",
    () => rank(requestFixture({ allowed_profile_refs_and_short_evidence: ev, candidates: [candidateFixture({ personal: { R: { score: 3, reason: "r", evidence_refs: ["pe1"], basis: { origin: "user" } } } })] }), host),
    "MODEL_MUST_NOT_SELF_REPORT_CONFIRMATION");

  // G 的硬要求
  await expectCode("G 无书内前提被拒",
    () => rank(requestFixture({ allowed_profile_refs_and_short_evidence: ev, candidates: [candidateFixture({ personal: { G: { score: 2, reason: "r", evidence_refs: ["pe1"], book_premise_refs: [] } } })] }), host),
    "G_WITHOUT_BOOK_PREMISE");
  await expectCode("G 无任何证据（从空库推断）被拒",
    () => rank(requestFixture({ candidates: [candidateFixture({ personal: { G: { score: 2, reason: "知识库为空", evidence_refs: [], book_premise_refs: ["sp1"] } } })] }), host),
    "G_FROM_EMPTY_KNOWLEDGE_BASE");
  await expectCode("G 显式标 inferred_from=empty_knowledge_base 被拒",
    () => rank(requestFixture({ allowed_profile_refs_and_short_evidence: ev, candidates: [candidateFixture({ personal: { G: { score: 2, reason: "r", evidence_refs: ["pe1"], book_premise_refs: ["sp1"], inferred_from: "empty_knowledge_base" } } })] }), host),
    "G_FROM_EMPTY_KNOWLEDGE_BASE");
  await expectCode("G 只有偏好证据（无具体表现）被拒",
    () => rank(requestFixture({
      goal: { ref: "goal:current", text: "t" },
      candidates: [candidateFixture({ personal: { G: { score: 2, reason: "r", evidence_refs: ["goal:current"], book_premise_refs: ["sp1"] } } })],
    }), host),
    "G_WITHOUT_OBSERVED_PERFORMANCE");
  await expectCode("G 只有 AI 假设证据被拒",
    () => rank(requestFixture({
      allowed_profile_refs_and_short_evidence: [evidenceEntry("pe_ai", { kind: "ai_hypothesis", origin: "ai_inference" })],
      candidates: [candidateFixture({ personal: { G: { score: 2, reason: "r", evidence_refs: ["pe_ai"], book_premise_refs: ["sp1"] } } })],
    }), host),
    "G_WITHOUT_OBSERVED_PERFORMANCE");
  const gOk = await R(requestFixture({
    allowed_profile_refs_and_short_evidence: ev,
    candidates: [candidateFixture({ personal: { G: { score: 2, reason: "已观察到的具体表现 + 书内前提", evidence_refs: ["pe1"], book_premise_refs: ["sp1"] } } })],
  }), host);
  is("G 有具体表现 + 书内前提 ⇒ 采用", first(pItems(gOk)).scores.G, 2);

  // T 的硬要求
  await expectCode("T 无用户已表达判断被拒",
    () => rank(requestFixture({ allowed_profile_refs_and_short_evidence: ev, candidates: [candidateFixture({ personal: { T: { score: 2, reason: "r", evidence_refs: ["pe1"], book_conflict_refs: ["sp1"] } } })] }), host),
    "T_WITHOUT_EXPRESSED_JUDGMENT");
  await expectCode("T 的判断依据不是用户来源被拒",
    () => rank(requestFixture({
      allowed_profile_refs_and_short_evidence: [evidenceEntry("pe_ai", { kind: "ai_hypothesis", origin: "ai_inference" })],
      candidates: [candidateFixture({ personal: { T: { score: 2, reason: "r", evidence_refs: ["pe_ai"], user_judgment_ref: "pe_ai", book_conflict_refs: ["sp1"] } } })],
    }), host),
    "T_WITHOUT_EXPRESSED_JUDGMENT");
  await expectCode("T 无书内冲突/边界被拒",
    () => rank(requestFixture({ allowed_profile_refs_and_short_evidence: ev, candidates: [candidateFixture({ personal: { T: { score: 2, reason: "r", evidence_refs: ["pe1"], user_judgment_ref: "pe1", book_conflict_refs: [] } } })] }), host),
    "T_WITHOUT_BOOK_CONFLICT");
  const tOk = await R(requestFixture({
    allowed_profile_refs_and_short_evidence: ev,
    candidates: [candidateFixture({ personal: { T: { score: 3, reason: "用户原话 + 书内边界", evidence_refs: ["pe1"], user_judgment_ref: "pe1", book_conflict_refs: ["sp1"] } } })],
  }), host);
  is("T 有真实判断 + 书内冲突 ⇒ 采用", first(pItems(tOk)).scores.T, 3);

  // 不同意不机械翻负分
  const disagree = await R(requestFixture({
    recent_feedback: [{ feedback_id: "fb_d", feedback_type: "disagree", feedback_scope: "item", item_id: "c1", user_action_id: "ua1" }],
  }), host);
  is("disagree 不排除候选", arr(disagree.exclusions).length, 0);
  is("disagree 不改写 B", first(items(disagree)).B, 2);
  truthy("disagree 被记录为软信号", report(disagree).soft_signals.disagree.includes("fb_d"));
  is("disagree 不产生负分", first(items(disagree)).B >= 0, true);

  // known 不推导能力
  const known = await R(requestFixture({
    recent_feedback: [{ feedback_id: "fb_k", feedback_type: "known", feedback_scope: "item", item_id: "c1", user_action_id: "ua1" }],
  }), host);
  is("known 反馈不产生任何能力分值", pItems(known).length, 0);
  is("known 反馈不改变 status", known.personalization_status, "none");
  truthy("known 被记录为软信号", report(known).soft_signals.known.includes("fb_k"));
}

// =========================================================================== //
console.log("\n[9] 证据门（参考过滤 / 稳定层 / 摘要不作证据）");
// =========================================================================== //
{
  const host = makeHost({ spans: DEFAULT_SPANS, generate: GEN_ONE });
  const withR = (ev, ref = "pe1") => requestFixture({
    allowed_profile_refs_and_short_evidence: ev,
    candidates: [candidateFixture({ personal: { R: { score: 3, reason: "r", evidence_refs: [ref] } } })],
  });

  // 未授权（不在允许表里）⇒ 维度不可用，但**不报错**，且不因归一化拿叠加
  let r = await R(withR([], "nope"), host);
  is("未授权证据 ⇒ 维度丢弃（不报错）", pItems(r).length, 0);
  is("未授权证据 ⇒ status=none", r.personalization_status, "none");
  is("未授权证据被记录", first(dropped(r)).reason, "evidence_not_authorized");
  is("未授权证据 ⇒ 不进 W", report(r).dropped_dimensions.length, 1);

  r = await R(withR([evidenceEntry("pe1", { knowledge_status: "withdrawn" })]), host);
  is("非 active 证据 ⇒ 丢弃", first(dropped(r)).reason, "evidence_not_active");
  r = await R(withR([evidenceEntry("pe1", { knowledge_status: "disputed" })]), host);
  is("disputed 证据 ⇒ 丢弃", pItems(r).length, 0);

  r = await R(withR([evidenceEntry("pe1", { confirmation: "retracted" })]), host);
  is("撤回证据 ⇒ 丢弃（retracted 不进新推荐依据）", first(dropped(r)).reason, "evidence_retracted");
  is("撤回证据不进 U", pItems(r).length, 0);
  is("撤回证据 ⇒ status=none", r.personalization_status, "none");
  truthy("丢弃原因带证据 ref", (first(dropped(r)).reasons ?? [])[0]?.ref === "pe1");

  r = await R(withR([evidenceEntry("pe1", { source_verifiable: false })]), host);
  is("来源不可核验 ⇒ 丢弃", first(dropped(r)).reason, "evidence_source_unverifiable");

  r = await R(withR([evidenceEntry("pe1", { valid_until: "2020-01-01T00:00:00.000Z" })]), host);
  is("过期证据 ⇒ 丢弃", first(dropped(r)).reason, "evidence_expired");

  r = await R(withR([evidenceEntry("pe1", { source_kind: "compact-checkpoint" })]), host);
  is("压缩摘要不作个人证据 ⇒ 丢弃", first(dropped(r)).reason, "summary_not_evidence");
  is("摘要证据不参与归一化", r.personalization_status, "none");

  // stable 层：必须 origin=user + confirmed + 在 note_ids_and_hashes 里 + 服务精确读取一致
  const stableOk = evidenceEntry("pe1", { tier: "stable" });
  const stableHost = (knowledge) => makeHost({ spans: DEFAULT_SPANS, generate: GEN_ONE, knowledge });
  const stableReq = requestFixture({
    allowed_profile_refs_and_short_evidence: [stableOk],
    note_ids_and_hashes: [{ object_id: "pe1", content_hash: H("n1") }],
    candidates: [candidateFixture({ personal: { R: { score: 3, reason: "r", evidence_refs: ["pe1"] } } })],
  });
  const okHost = stableHost({ pe1: { ok: true, object_id: "pe1", origin: "user", confirmation: "confirmed", knowledge_status: "active" } });
  r = await R(stableReq, okHost);
  is("stable 层合规 ⇒ 采用", pItems(r).length, 1);
  truthy("stable 层走了服务精确读取", okHost.calls.readKnowledge.includes("pe1"));
  const rUnconfirmed = await R(requestFixture({
    allowed_profile_refs_and_short_evidence: [evidenceEntry("pe1", { tier: "stable", confirmation: "unconfirmed" })],
    note_ids_and_hashes: [{ object_id: "pe1", content_hash: H("n1") }],
    candidates: [candidateFixture({ personal: { R: { score: 3, reason: "r", evidence_refs: ["pe1"] } } })],
  }), host);
  is("stable 层未确认 ⇒ 丢弃", first(dropped(rUnconfirmed)).reason, "stable_evidence_not_confirmed");
  const rNotInNotes = await R(requestFixture({
    allowed_profile_refs_and_short_evidence: [stableOk],
    candidates: [candidateFixture({ personal: { R: { score: 3, reason: "r", evidence_refs: ["pe1"] } } })],
  }), host);
  is("stable 层不在 note_ids 里 ⇒ 丢弃", first(dropped(rNotInNotes)).reason, "stable_evidence_not_in_note_ids");
  const rMismatch = await R(stableReq, stableHost({ pe1: { ok: true, object_id: "pe1", origin: "user", confirmation: "unconfirmed", knowledge_status: "active" } }));
  is("stable 层服务读取不一致 ⇒ 丢弃", first(dropped(rMismatch)).reason, "stable_evidence_mismatch");
  const rUnreadable = await R(stableReq, stableHost({}));
  is("stable 层服务读不到 ⇒ 丢弃", first(dropped(rUnreadable)).reason, "stable_evidence_read_failed");

  // q 的来源：AI 评估即使被接受仍 q=0.5
  r = await R(requestFixture({
    allowed_profile_refs_and_short_evidence: [evidenceEntry("pe_ai", { kind: "ai_hypothesis", origin: "ai_inference", confirmation: "confirmed" })],
    candidates: [candidateFixture({ personal: { R: { score: 3, reason: "r", evidence_refs: ["pe_ai"] } } })],
  }), host);
  is("AI 评估（即便 confirmed）⇒ q=0.5", first(pItems(r)).scores.q, 0.5);
  is("AI 评估 ⇒ limited", r.personalization_status, "limited");

  // 明确兴趣反馈可作 R 范围依据 ⇒ q=1
  r = await R(requestFixture({
    recent_feedback: [{ feedback_id: "fb_i", feedback_type: "interested", feedback_scope: "concept", concept_refs: ["x"], user_action_id: "ua1" }],
    candidates: [candidateFixture({ personal: { R: { score: 3, reason: "回应用户明确兴趣", evidence_refs: ["fb_i"] } } })],
  }), host);
  is("明确兴趣反馈可作 R 依据", pItems(r).length, 1);
  is("明确兴趣反馈 ⇒ q=1（不是未确认观察）", first(pItems(r)).scores.q, 1);

  // 未知维度：dim 为 null / score 为 null 都保持 unknown
  r = await R(requestFixture({
    candidates: [candidateFixture({ personal: { R: null, G: { score: null, reason: "还没观察" }, T: { score: null, reason: "无" } } })],
  }), host);
  is("全 unknown ⇒ status=none", r.personalization_status, "none");
  is("全 unknown ⇒ 无 personalized_items", pItems(r).length, 0);
  is("unknown 被记录（不是静默）", report(r).unknown_dimensions.length, 3);
}

// =========================================================================== //
console.log("\n[10] 未知维度不参与 U、也不因归一化拿到完整叠加");
// =========================================================================== //
{
  const host = makeHost({ spans: DEFAULT_SPANS, generate: GEN_ONE });
  const r = await R(requestFixture({
    goal: { ref: "goal:current", text: "t" },
    candidates: [candidateFixture({
      personal: {
        R: { score: 3, reason: "本次目标", evidence_refs: ["goal:current"] },
        G: { score: null, reason: "未观察" },
        T: { score: null, reason: "未表达" },
      },
    })],
  }), host);
  const it = first(pItems(r));
  is("G 保持 null（不填 0）", it.scores.G, null);
  is("T 保持 null（不填 0）", it.scores.T, null);
  is("W 只含已知维度 = 3/10", it.scores.W, 0.3);
  is("C=3/7（未知维度不抬高 C）", it.scores.C, 3 / 7);
  is("λ=6/35（不是完整 0.40）", it.scores.lambda, 6 / 35);
  isNot("λ 不等于完整 0.40", it.scores.lambda, 0.4);
  is("U 只由 R 决定 = 3", it.scores.U, 3);
  truthy("G/T 未知时 uncertainty 明说保持未知", /未知/.test(it.uncertainty));
  is("dimension_evidence 只含已知维度", Object.keys(it.dimension_evidence ?? {}).join(","), "R");
}

// =========================================================================== //
console.log("\n[11] 两层分开：第一层不依赖个人背景、第二层只收 W>0");
// =========================================================================== //
{
  const host = makeHost({ spans: DEFAULT_SPANS, generate: GEN_ONE });
  const base = requestFixture({
    candidates: [
      candidateFixture({ candidate_id: "c_low", section_id: "s1", section_order: 1, b: { score: 1, reason: "局部补充", basis: { kind: "book_analysis" } } }),
      candidateFixture({ candidate_id: "c_high", section_id: "s2", section_order: 2, book_evidence_refs: ["sp2"], b: { score: 3, reason: "核心论证", basis: { kind: "book_analysis" } } }),
    ],
  });
  const noBg = await R(base, host);
  deep("第一层按 B 降序", items(noBg).map((i) => i.candidate_id), ["c_high", "c_low"]);
  is("空背景 ⇒ 第二层为空", pItems(noBg).length, 0);
  is("空背景 ⇒ status=none", noBg.personalization_status, "none");
  is("空背景 ⇒ 第一层照常输出（不弃权）", noBg.outcome, "items");

  const withBg = await R(requestFixture({
    goal: { ref: "goal:current", text: "t" },
    candidates: [
      candidateFixture({ candidate_id: "c_low", section_id: "s1", section_order: 1, b: { score: 1, reason: "局部补充", basis: { kind: "book_analysis" } }, personal: { R: { score: 3, reason: "目标", evidence_refs: ["goal:current"] } } }),
      candidateFixture({ candidate_id: "c_high", section_id: "s2", section_order: 2, book_evidence_refs: ["sp2"], b: { score: 3, reason: "核心论证", basis: { kind: "book_analysis" } } }),
    ],
  }), host);
  deep("第一层不因个人背景改变（仍按 B）", items(withBg).map((i) => i.candidate_id), ["c_high", "c_low"]);
  deep("第二层只收 W>0 的候选", pItems(withBg).map((i) => i.candidate_id), ["c_low"]);
  is("第二层按 S 排（c_low：C=3/7、λ=6/35 ⇒ S=47/35）", first(pItems(withBg)).scores.S, 47 / 35);
  is("W=0 的候选只在第一层", items(withBg).some((i) => i.candidate_id === "c_high"), true);
  falsy("W=0 的候选不在第二层", pItems(withBg).some((i) => i.candidate_id === "c_high"));

  // 各候选各自保留分值
  const two = await R(requestFixture({
    goal: { ref: "goal:current", text: "t" },
    allowed_profile_refs_and_short_evidence: [evidenceEntry("pe_g", { kind: "observed_performance" })],
    candidates: [
      candidateFixture({ candidate_id: "c1", section_id: "s1", section_order: 1, personal: { R: { score: 3, reason: "目标", evidence_refs: ["goal:current"] } } }),
      candidateFixture({ candidate_id: "c2", section_id: "s2", section_order: 2, book_evidence_refs: ["sp2"], personal: { G: { score: 2, reason: "缺口", evidence_refs: ["pe_g"], book_premise_refs: ["sp2"] } } }),
    ],
  }), host);
  is("两个候选各自保留 C（c1=3/7）", findP(two, "c1").scores.C, 3 / 7);
  is("两个候选各自保留 C（c2=2/7）", findP(two, "c2").scores.C, 2 / 7);
  truthy("每个候选都有 10 键 scores",
    pItems(two).every((i) => Object.keys(i.scores ?? {}).length === 10));

  // ★ 两层必须真的分开：构造一个「B 顺序 ≠ S 顺序」的夹具
  //   c_a: B=2，三维全知但都是 0 分 ⇒ C=1、U=0、λ=0.40、S=1.2（第一层更靠前，第二层更靠后）
  //   c_b: B=1，只有 R=3       ⇒ C=3/7、λ=6/35、S=47/35≈1.3429（第二层更靠前，第一层更靠后）
  const evAll = [
    evidenceEntry("pe_r"), evidenceEntry("pe_g"), evidenceEntry("pe_t"),
  ];
  const crossed = await R(requestFixture({
    allowed_profile_refs_and_short_evidence: evAll,
    candidates: [
      candidateFixture({
        candidate_id: "c_a", section_id: "s1", section_order: 1,
        b: { score: 2, reason: "代表性论点", basis: { kind: "book_analysis" } },
        personal: {
          R: { score: 0, reason: "依据明确显示不相关", evidence_refs: ["pe_r"] },
          G: { score: 0, reason: "无缺口", evidence_refs: ["pe_g"], book_premise_refs: ["sp1"] },
          T: { score: 0, reason: "无冲突", evidence_refs: ["pe_t"], user_judgment_ref: "pe_t", book_conflict_refs: ["sp1"] },
        },
      }),
      candidateFixture({
        candidate_id: "c_b", section_id: "s2", section_order: 2, book_evidence_refs: ["sp2"],
        b: { score: 1, reason: "局部补充", basis: { kind: "book_analysis" } },
        personal: { R: { score: 3, reason: "高度相关", evidence_refs: ["pe_r"] } },
      }),
    ],
  }), host);
  is("c_a 三维全知 ⇒ C=1", findP(crossed, "c_a").scores.C, 1);
  is("c_a ⇒ S=1.2（U=0）", findP(crossed, "c_a").scores.S, 1.2);
  is("c_b ⇒ S=47/35", findP(crossed, "c_b").scores.S, 47 / 35);
  deep("第一层按 B 排（不是按 S）", items(crossed).map((i) => i.candidate_id), ["c_a", "c_b"]);
  deep("第二层按 S 排（不是按 B）", pItems(crossed).map((i) => i.candidate_id), ["c_b", "c_a"]);
  truthy("两层顺序确实不同（证明两层没有合并）",
    first(items(crossed)).candidate_id !== first(pItems(crossed)).candidate_id);

  // 每层最多 3 项
  const many = await R(requestFixture({
    candidates: [1, 2, 3, 4, 5].map((n) => candidateFixture({
      candidate_id: `c${n}`,
      section_id: `s${n}`,
      section_order: n,
      book_evidence_refs: [{ span_id: "sp1", text_hash: H("q1") }],
      b: { score: 2, reason: `r${n}`, basis: { kind: "book_analysis" } },
      overview_paragraph: null,
    })),
  }), makeHost({ spans: DEFAULT_SPANS, generate: GEN_ONE }));
  is("第一层默认最多 3 项", items(many).length, 3);
  is("超出项被记录为 limit_excluded", trade(many, "book").limit_excluded.length, 2);

  // 时间预算在排序后执行并记录取舍
  const timed = await R(requestFixture({
    budget: { max_minutes: 15 },
    candidates: [
      candidateFixture({ candidate_id: "c1", section_id: "s1", section_order: 1, estimated_minutes: 10 }),
      candidateFixture({ candidate_id: "c2", section_id: "s2", section_order: 2, book_evidence_refs: ["sp2"], estimated_minutes: 10 }),
    ],
  }), host);
  is("时间预算在排序后裁剪", items(timed).length, 1);
  truthy("时间取舍被记录", trade(timed, "book").time_excluded.length >= 1);

  // 章节多样性
  const sameSection = await R(requestFixture({
    candidates: [
      candidateFixture({ candidate_id: "c1", section_id: "s1", section_order: 1, overview_paragraph: null }),
      candidateFixture({ candidate_id: "c2", section_id: "s2", section_order: 2, book_evidence_refs: ["sp2"], overview_paragraph: null }),
      candidateFixture({ candidate_id: "c3", section_id: "s1", section_order: 3, book_evidence_refs: ["sp3"], overview_paragraph: null }),
    ],
  }), makeHost({ spans: DEFAULT_SPANS, generate: GEN_ONE }));
  is("多样性优先不同章节", items(sameSection).map((i) => i.candidate_id).join(","), "c1,c2,c3");
  truthy("多样性取舍被记录", Array.isArray(trade(sameSection, "book").diversity_deferred));

  // 排序函数自身
  const recs = [
    { candidate: { candidate_id: "b", section_order: 2 }, book_value: { score: 2 }, scores: { S: 2.0, B: 2 } },
    { candidate: { candidate_id: "a", section_order: 1 }, book_value: { score: 2 }, scores: { S: 2.0, B: 2 } },
    { candidate: { candidate_id: "c", section_order: 3 }, book_value: { score: 3 }, scores: { S: 2.0, B: 3 } },
  ];
  deep("第一层同 B 时按章节顺序", sortBookLayer(recs).map((r) => r.candidate.candidate_id), ["c", "a", "b"]);
  deep("第二层同 S 时先比 B", sortPersonalizedLayer(recs).map((r) => r.candidate.candidate_id), ["c", "a", "b"]);
  const tie = [
    { candidate: { candidate_id: "z", section_order: 1 }, scores: { S: 2, B: 2 } },
    { candidate: { candidate_id: "y", section_order: 1 }, scores: { S: 2, B: 2 } },
  ];
  deep("完全同分时按稳定 candidate_id", sortPersonalizedLayer(tie).map((r) => r.candidate.candidate_id), ["y", "z"]);
  const near = [
    { candidate: { candidate_id: "p", section_order: 1 }, scores: { S: 2.0000000001, B: 1 } },
    { candidate: { candidate_id: "q", section_order: 1 }, scores: { S: 2, B: 3 } },
  ];
  deep("差 ≤1e−9 视为同分 ⇒ 先比 B", sortPersonalizedLayer(near).map((r) => r.candidate.candidate_id), ["q", "p"]);
}

// =========================================================================== //
console.log("\n[12] personalization_status 判据");
// =========================================================================== //
{
  const host = makeHost({ spans: DEFAULT_SPANS, generate: GEN_ONE });
  is("空 ⇒ none", derivePersonalizationStatus([]), "none");
  is("C<1 ⇒ limited", derivePersonalizationStatus([{ scores: { C: 3 / 7, q: 1 } }]), "limited");
  is("q=0.5 ⇒ limited", derivePersonalizationStatus([{ scores: { C: 1, q: 0.5 } }]), "limited");
  is("C=1 且 q=1 ⇒ available", derivePersonalizationStatus([{ scores: { C: 1, q: 1 } }]), "available");
  is("任一选中项 C<1 ⇒ run 级 limited", derivePersonalizationStatus([{ scores: { C: 1, q: 1 } }, { scores: { C: 0.5, q: 1 } }]), "limited");
  is("任一选中项 q=0.5 ⇒ run 级 limited", derivePersonalizationStatus([{ scores: { C: 1, q: 1 } }, { scores: { C: 1, q: 0.5 } }]), "limited");

  // 端到端 available：三维全知、全部 confirmed、非 AI
  const ev = [
    evidenceEntry("pe_r", { kind: "observed_performance" }),
    evidenceEntry("pe_g", { kind: "observed_performance" }),
    evidenceEntry("pe_t", { kind: "observed_performance" }),
  ];
  const r = await R(requestFixture({
    allowed_profile_refs_and_short_evidence: ev,
    candidates: [candidateFixture({
      personal: {
        R: { score: 3, reason: "r", evidence_refs: ["pe_r"] },
        G: { score: 2, reason: "g", evidence_refs: ["pe_g"], book_premise_refs: ["sp1"] },
        T: { score: 1, reason: "t", evidence_refs: ["pe_t"], user_judgment_ref: "pe_t", book_conflict_refs: ["sp1"] },
      },
    })],
  }), host);
  is("三维全知 ⇒ C=1", first(pItems(r)).scores.C, 1);
  is("三维全知 ⇒ q=1", first(pItems(r)).scores.q, 1);
  is("三维全知 ⇒ available", r.personalization_status, "available");
  is("available 时 λ=0.40（上限内）", first(pItems(r)).scores.lambda, 0.4);
  falsy("available 不引入 confidence 字段（不是统计置信度）",
    allKeys(r).some((k) => /confidence|calibrat/i.test(k)));
  truthy("available 仍保留不确定说明", typeof first(pItems(r)).uncertainty === "string");

  // 仅排除反馈 ⇒ none，但必须明示
  const only = await R(requestFixture({
    recent_feedback: [{ feedback_id: "fb1", feedback_type: "irrelevant", feedback_scope: "batch", user_action_id: "ua1" }],
  }), host);
  is("仅排除反馈 ⇒ status=none", only.personalization_status, "none");
  is("仅排除反馈 ⇒ 仍明示「已应用本次排除」", report(only).applied_feedback_exclusions.note, APPLIED_EXCLUSION_NOTE);
  is("仅排除反馈 ⇒ applied=true", report(only).applied_feedback_exclusions.applied, true);
  deep("仅排除反馈 ⇒ 列出反馈引用", report(only).applied_feedback_exclusions.feedback_refs, ["fb1"]);
  falsy("不能假称没有使用反馈", report(only).applied_feedback_exclusions.note === null);
}

// =========================================================================== //
console.log("\n[13] 结果形状与结构自检");
// =========================================================================== //
{
  const host = makeHost({ spans: DEFAULT_SPANS, generate: GEN_ONE });
  const r = await R(requestFixture(), host);
  deep("顶层恰好 7 键", Object.keys(r).sort(), [...RESULT_KEYS].sort());
  is("book_guide 有来源", arr(guide(r).source_refs).length > 0, true);
  truthy("book_guide.overview_paragraphs 非空", arr(guide(r).overview_paragraphs).length > 0);
  truthy("book_guide.coverage_scope 带 book_version_id", guide(r).coverage_scope.book_version_id === "bv1");
  is("items 项带 candidate_id/B/reason/source_refs",
    Object.keys(first(items(r))).sort().join(","), "B,candidate_id,reason,section_id,source_refs");
  truthy("exclusions 每项含 candidate_id + reason_code",
    arr((r.exclusions)).every((e) => typeof e.candidate_id === "string" && typeof e.reason_code === "string"));
  truthy("constraints_report 是映射", typeof report(r) === "object" && !Array.isArray(report(r)));
  truthy("policy_and_model_metadata 是映射", typeof r.policy_and_model_metadata === "object");

  // assertResultShape 的反例
  await expectCode("空 book_guide 被抓（结构错误）",
    () => assertResultShape({ ...r, book_guide: {} }), "EMPTY_BOOK_GUIDE");
  await expectCode("浓缩无来源被抓",
    () => assertResultShape({ ...r, book_guide: { ...r.book_guide, source_refs: [] } }), "CONDENSATION_WITHOUT_SOURCE");
  await expectCode("items=[] 无 no_eligible_reason 被抓",
    () => assertResultShape({ ...r, book_guide: { ...r.book_guide, items: [], no_eligible_reason: null } }), "ITEMS_WITHOUT_NO_ELIGIBLE_REASON");
  // items=[] 但**有**真实 no_eligible_reason ⇒ 合法（不抛）
  try {
    assertResultShape({ ...r, book_guide: { ...r.book_guide, items: [], no_eligible_reason: "全部候选被硬约束排除：user_excluded(1)" } });
    ok("items=[] 有真实 reason ⇒ 结构合法");
  } catch (e) {
    bad("items=[] 有真实 reason ⇒ 结构合法", `本应通过，实际 ${e?.code}: ${e?.message}`);
  }
  await expectCode("顶层 6 键被抓（漏 policy_and_model_metadata）",
    () => { const x = { ...r }; delete x.policy_and_model_metadata; assertResultShape(x); }, "RESULT_KEY_MISMATCH");
  await expectCode("顶层 8 键（多塞 selected_items）被抓",
    () => assertResultShape({ ...r, selected_items: [] }), "RESULT_KEY_MISMATCH");
  await expectCode("insufficient_evidence 带 book_guide 被抓",
    () => assertResultShape({ ...r, outcome: "insufficient_evidence" }), "INVALID_COMBINATION");
  await expectCode("outcome 非法被抓",
    () => assertResultShape({ ...r, outcome: "recommended" }), "INVALID_ENUM");
  await expectCode("personalized_items 空但 status 非 none 被抓",
    () => assertResultShape({ ...r, personalized_items: [], personalization_status: "available" }), "INVALID_COMBINATION");
  await expectCode("personalized_items 项键数不对被抓",
    () => assertResultShape({ ...r, personalized_items: [{ candidate_id: "x" }] }), "INVALID_STRUCTURE");

  // 结构自检不会把结构错误映射成 recommended
  is("不存在 recommended 这个 outcome", RECOMMENDATION_OUTCOMES.includes("recommended"), false);
  await expectCode("outcome=recommended 被拒（不得映射成 recommended）",
    () => assertResultShape({ ...r, outcome: "recommended" }), "INVALID_ENUM");
}

// =========================================================================== //
console.log("\n[14] selected_items：去重并集 + book/personalized/both，不是第三层");
// =========================================================================== //
{
  const host = makeHost({ spans: DEFAULT_SPANS, generate: GEN_ONE });
  const r = await R(requestFixture({
    goal: { ref: "goal:current", text: "t" },
    candidates: [
      candidateFixture({ candidate_id: "c1", section_id: "s1", section_order: 1, personal: { R: { score: 3, reason: "r", evidence_refs: ["goal:current"] } } }),
      candidateFixture({ candidate_id: "c2", section_id: "s2", section_order: 2, book_evidence_refs: ["sp2"], b: { score: 3, reason: "核心", basis: { kind: "book_analysis" } } }),
    ],
  }), host);
  const sel = computeSelectedItems(r.book_guide, pItems(r));
  is("selected_items 是去重并集", sel.length, new Set(sel.map((s) => s.candidate_id)).size);
  is("c1 同时在一二层 ⇒ both", (sel.find((s) => s.candidate_id === "c1") ?? {}).layer, "both");
  is("c2 只在第一层 ⇒ book", (sel.find((s) => s.candidate_id === "c2") ?? {}).layer, "book");
  truthy("layer 值域只有 book/personalized/both",
    sel.every((s) => ["book", "personalized", "both"].includes(s.layer)));
  truthy("selected_items 只引用两层里出现过的 id",
    sel.every((s) => items(r).some((i) => i.candidate_id === s.candidate_id) ||
      pItems(r).some((i) => i.candidate_id === s.candidate_id)));
  is("selected_items 不在 result 里", Object.prototype.hasOwnProperty.call(r, "selected_items"), false);
  is("selected_items 不引入新候选（不是第三层）",
    sel.filter((s) => s.layer === "personalized").length <= pItems(r).length, true);

  // 纯第二层项（第一层没有）
  const sel2 = computeSelectedItems({ items: [] }, [{ candidate_id: "p1" }]);
  is("只在第二层 ⇒ personalized", first(sel2).layer, "personalized");
  is("computeSelectedItems 对空输入返回空数组", computeSelectedItems(null, null).length, 0);
  deep("computeSelectedItems 去重（重复 id 只出现一次）",
    computeSelectedItems({ items: [{ candidate_id: "x" }, { candidate_id: "x" }] }, [{ candidate_id: "x" }]),
    [{ candidate_id: "x", layer: "both" }]);
}

// =========================================================================== //
console.log("\n[15] 空背景不弃权 / 弃权只由缺可信材料触发");
// =========================================================================== //
{
  const host = makeHost({ spans: DEFAULT_SPANS, generate: GEN_ONE });
  let r = await R(requestFixture(), host);
  is("空背景 ⇒ outcome=items（不整体弃权）", r.outcome, "items");
  is("空背景 ⇒ status=none", r.personalization_status, "none");
  is("空背景 ⇒ 第一层有项", items(r).length, 1);
  is("空背景 ⇒ 无 personalized_items", pItems(r).length, 0);
  is("空背景 ⇒ exclusions 为空", arr((r.exclusions)).length, 0);

  r = await R(requestFixture({ candidates: [] }), host);
  is("无候选 ⇒ insufficient_evidence（缺书内材料）", r.outcome, "insufficient_evidence");
  is("弃权 ⇒ book_guide=null", r.book_guide, null);
  deep("弃权 ⇒ personalized_items=[]", pItems(r), []);
  is("弃权 ⇒ status=none", r.personalization_status, "none");
  is("弃权 ⇒ 给出原因", report(r).insufficient_evidence_reason, "NO_CANDIDATES");

  r = await R(requestFixture({ candidates: [candidateFixture({ book_evidence_refs: ["nope"] })] }), host);
  is("全部来源不可用 ⇒ 弃权", r.outcome, "insufficient_evidence");
  is("弃权原因=缺可信书内材料", report(r).insufficient_evidence_reason, "NO_CREDIBLE_BOOK_MATERIAL");

  // 混合：一个材料缺失 + 一个用户排除 ⇒ 仍有可信材料 ⇒ items=[] + reason
  r = await R(requestFixture({
    recent_feedback: [{ feedback_id: "fb1", feedback_type: "not_interested", feedback_scope: "item", item_id: "c_ok", user_action_id: "ua1" }],
    candidates: [
      candidateFixture({ candidate_id: "c_ok" }),
      candidateFixture({ candidate_id: "c_bad", book_evidence_refs: ["nope"] }),
    ],
  }), host);
  is("有可信材料 ⇒ 不弃权", r.outcome, "items");
  is("全部合格候选被约束排除 ⇒ items=[]", items(r).length, 0);
  truthy("no_eligible_reason 是真实原因（非空话）", /user_excluded/.test(guide(r).no_eligible_reason));
  truthy("no_eligible_reason 带计数", /user_excluded\(1\)/.test(guide(r).no_eligible_reason));

  // 全部被用户排除 ⇒ items=[] + reason（PRD :278/:971）
  r = await R(requestFixture({
    recent_feedback: [{ feedback_id: "fb1", feedback_type: "defer", feedback_scope: "batch", user_action_id: "ua1" }],
  }), host);
  is("全部被用户排除 ⇒ outcome=items", r.outcome, "items");
  is("全部被用户排除 ⇒ items=[]", items(r).length, 0);
  truthy("全部被用户排除 ⇒ 给 no_eligible_reason", typeof guide(r).no_eligible_reason === "string");
  truthy("第一层浓缩仍来自安全候选", arr(guide(r).overview_paragraphs).length > 0);
  truthy("buildNoEligibleReason 是真实原因函数",
    /defer|user_excluded/.test(buildNoEligibleReason({ excluded: [{ reason_code: "user_excluded" }] })) ||
    buildNoEligibleReason({ excluded: [{ reason_code: "user_excluded" }] }).length > 0);
}

// =========================================================================== //
console.log("\n[16] RecommendationRun 映射与理解身份（M10 阶段 2：一本书一个理解）");
// =========================================================================== //
{
  const host = makeHost({ spans: DEFAULT_SPANS, generate: GEN_ONE });
  const req = requestFixture();
  const r = await R(req, host);
  const run = mapRecommendationResultToRun(r, runCtx(req));
  is("run 恰好 18 个必填字段", Object.keys(run).length, 18);
  deep("run 键集合 = schema 的 required", Object.keys(run).sort(), [...RECOMMENDATION_RUN_REQUIRED_KEYS].sort());
  is("run_id 透传", run.run_id, "rr_test_0001");
  is("state=ready", run.state, "ready");
  is("result_outcome=items", run.result_outcome, "items");
  is("policy={id,version}", `${run.policy.id}@${run.policy.version}`, `${POLICY_ID}@${POLICY_VERSION}`);
  is("input_fingerprint 是 64 位 hash", /^[0-9a-f]{64}$/.test(run.input_fingerprint), true);
  truthy("selected_items 进 run（不在 result）", Array.isArray(run.selected_items) && run.selected_items.length > 0);
  truthy("budget_usage 是映射", typeof run.budget_usage === "object");
  truthy("validateRunRecord 通过", validateRunRecord(run).ok);

  await expectCode("run 少一个字段被拒",
    () => { const x = { ...run }; delete x.exclusions; validateRunRecord(x); }, "RUN_KEY_MISMATCH");
  await expectCode("run 多一个字段被拒",
    () => validateRunRecord({ ...run, extra: 1 }), "RUN_KEY_MISMATCH");
  await expectCode("state 非法被拒",
    () => validateRunRecord({ ...run, state: "done" }), "INVALID_ENUM");
  await expectCode("result_outcome 非法被拒",
    () => validateRunRecord({ ...run, result_outcome: "recommended" }), "INVALID_ENUM");
  await expectCode("缺 job_id 映射被拒",
    () => mapRecommendationResultToRun(r, { ...runCtx(req), job_id: null }), "MISSING_REQUIRED");
  await expectCode("缺 input_fingerprint 映射被拒",
    () => mapRecommendationResultToRun(r, { ...runCtx(req), input_fingerprint: null }), "MISSING_REQUIRED");

  // 正式笔记：需要编排器给 dedup_check_ref（不补造）
  await expectCode("缺 dedup_check_ref 的正式笔记被拒（不补造）",
    () => buildRecommendationRunNote(run, { now: "2026-10-10T00:00:00.000Z" }), "MISSING_REQUIRED");
  const spanRef = {
    book_id: "b1", book_version_id: "bv1", section_id: "s1", block_id: "bl1", span_id: "sp1",
    href: "text/ch1.xhtml", start_codepoint: 0, end_codepoint: 10,
    text_hash: H("q1"), locator_quality: "exact_normalized_text", quote_type: "verbatim",
  };
  const note = buildRecommendationRunNote(run, {
    dedup_check_ref: "dc_1", now: "2026-10-10T00:00:00.000Z", book_evidence: [spanRef],
  });
  is("正式 run 笔记过 M1 validateNote(formal)", note.ok, true);
  is("笔记 id = run_id", note.data.id, run.run_id);
  is("笔记 origin=ai_inference（不冒充用户）", note.data.origin, "ai_inference");
  is("笔记 confirmation=unconfirmed", note.data.confirmation, "unconfirmed");
  const recheck = validateNote(note.data, { mode: "formal", objectType: "recommendation_run", domain: BOOK_DOMAIN });
  is("测试侧独立复验也通过", recheck.ok, true);

  // 输入指纹：不含 run_id；输入变则变
  const fp1 = recommendationInputFingerprint(req);
  const fp2 = recommendationInputFingerprint({ ...req, run_id: "rr_other" });
  is("输入指纹不含 run_id（同输入不同 run_id 指纹相同）", fp1, fp2);
  const fp3 = recommendationInputFingerprint({ ...req, candidates: [candidateFixture({ b: { score: 3, reason: "改", basis: { kind: "book_analysis" } } })] });
  isNot("候选变化 ⇒ 指纹变化", fp3, fp1);
  const fp4 = recommendationInputFingerprint({ ...req, policy_config: { weights: { R: "0.5" } } });
  isNot("权重变化 ⇒ 指纹变化", fp4, fp1);
  is("同一 request 指纹稳定", recommendationInputFingerprint(req), fp1);

  // ── M10 阶段 2「一本书一个理解」：运行身份**按书固定**，复算**覆盖同一条笔记**、revision 递增 ──
  const safe = (fn) => {
    try { return fn(); } catch (e) { return { __threw: `${e?.code ?? e?.name}: ${e?.message}` }; }
  };

  // M13：运行身份按**内容身份**固定（不再按路径）。
  const idA = safe(() => bookRunId({ book_version_id: "bv_f7f4f1fc3778c58a" }));
  const idA2 = safe(() => bookRunId({ book_version_id: "bv_f7f4f1fc3778c58a" }));
  const idB = safe(() => bookRunId({ book_version_id: "bv_eebaf9a3988b59f4" }));
  truthy("bookRunId 按书固定：同一本书两次调用得到同一个 run_id",
    typeof idA === "string" && /^rr_[0-9a-f]{24}$/.test(idA) && idA === idA2, JSON.stringify(idA));
  truthy("换一本书 ⇒ 换 run_id", idB !== idA, `${idA} vs ${idB}`);
  // 跨语言对拍：喂进去的是**引擎算出的真身份**（真实库里那本《第一哲学沉思集》的
  // book_version_id = bv_f7f4f1fc3778c58a），派生出下面这个 run_id。
  // 谁改了派生算法（或把身份又换回路径）这条立刻红。
  is("bookRunId(引擎真身份 bv_f7f4f1fc3778c58a) = 硬编码钉住的值",
    idA, "rr_a73b93ffd8a73cdb4bca0186");
  await expectCode("bookRunId 缺 book_version_id 被拒（定不出身份就不猜）",
    () => bookRunId({}), "MISSING_REQUIRED");
  await expectCode("bookRunId book_version_id 是空白串被拒",
    () => bookRunId({ book_version_id: "   " }), "MISSING_REQUIRED");
  await expectCode("bookRunId **不再**接受 path_hash8（路径不参与身份）",
    () => bookRunId({ path_hash8: "210c6f5d" }), "MISSING_REQUIRED");

  is("nextRevision：首次（没有既有笔记）= 1", nextRevision(null), 1);
  is("nextRevision：既有 revision=1 ⇒ 2", nextRevision({ revision: 1 }), 2);
  is("nextRevision：既有 revision=7 ⇒ 8", nextRevision({ revision: 7 }), 8);
  is("nextRevision：revision 非整数 ⇒ 退回 1（不猜）", nextRevision({ revision: "3" }), 1);

  // ── M13：插件里**不再有**任何「自己算书身份哈希」的实现 ──
  // 这是 M13 的核心纪律：**引擎算身份，插件只消费**。留着第二套实现（哪怕现在值一样）
  // 就会在两边漂移时静默错位 —— 去重判断错位正是从那里开始的。
  // 这三条是**反向断言**：谁把旧实现加回来，立刻红。
  is("policy 不再导出 pathHash8Of（旧的路径寻址句柄）", P.pathHash8Of, undefined);
  is("policy 不再导出 bookIdOf（按目录名复现的 book_id）", P.bookIdOf, undefined);
  is("schema 不再导出 sha1Hex（跨语言重复实现的载体）", SCHEMA.sha1Hex, undefined);
  truthy("schema 仍导出 sha256Hex（内容完整性/去重仍需要它）",
    typeof SCHEMA.sha256Hex === "function");

  // ── M10 阶段 4a：book_id / 书籍信息笔记路径 / book 笔记构造 ──
  // M13 起 book_id 由**引擎给**（`content_id` = book_version_id 去掉 `bv_` 前缀的 16 位），
  // 插件不再按目录名算 —— 所以这里只钉「插件不再自己算」+ 笔记构造的诚实边界。

  // 路径必须是 `书籍/<书名>｜<作者>/书籍信息.md`（模板使用说明 §2 的表）
  is("bookInfoRel 用「书名｜作者」当动态目录",
    bookInfoRel({ title: "第一哲学沉思集", author: "笛卡尔" }), "书籍/第一哲学沉思集｜笛卡尔/书籍信息.md");
  // 书名里的路径分隔符与 .. 不能把笔记写到别处去
  is("bookInfoRel 把书名里的 / 换成 _（防目录穿越）",
    bookInfoRel({ title: "a/b", author: "c" }), "书籍/a_b｜c/书籍信息.md");
  truthy("bookInfoRel 不残留 ..（防上跳）",
    !bookInfoRel({ title: "..", author: ".." }).includes(".."),
    bookInfoRel({ title: "..", author: ".." }));
  await expectCode("bookInfoRel 缺书名被拒", () => bookInfoRel({ author: "c" }), "MISSING_REQUIRED");
  await expectCode("bookInfoRel 缺作者被拒", () => bookInfoRel({ title: "t" }), "MISSING_REQUIRED");

  // book 笔记构造：诚实边界（external_master 恒 unverified、content_hash 恒 null）
  // M13：`book_id` 与 `content_id` 都是**引擎给的内容身份**，插件不自己算。
  const bookNoteArgs = {
    book_id: "f7f4f1fc3778c58a", title: "第一哲学沉思集", author: "笛卡尔",
    book_version_id: "bv_f7f4f1fc3778c58a", source_path: "/a/b/第一哲学沉思集.epub",
    content_id: "f7f4f1fc3778c58a",
  };
  const bn = buildBookInfoNote(bookNoteArgs, { now: "2026-01-01T00:00:00.000Z" });
  is("book 笔记 object_type=book", bn.data.object_type, "book");
  is("book 笔记 id === book_id", bn.data.id, bn.data.book_id);
  is("book 笔记 book_id 就是引擎给的内容身份", bn.data.book_id, "f7f4f1fc3778c58a");
  is("book 笔记 dedup_check_ref 按内容身份派生（不再是 dedup_<路径指纹>）",
    bn.data.dedup_check_ref, "dedup_f7f4f1fc3778c58a");
  is("book 笔记 external_master.status 恒 unverified（没核对过就不许说核过）",
    bn.data.external_master.status, "unverified");
  is("book 笔记 external_master.outcome 恒 not_checked", bn.data.external_master.outcome, "not_checked");
  is("book 笔记 content_hash 恒 null（未知来源不得编造，也不拿 book_version_id 冒充）",
    bn.data.content_hash, null);
  is("book 笔记 parser_version 恒 null", bn.data.parser_version, null);
  is("book 笔记记了 original_epub 来源", bn.data.source_assets[0].source_kind, "original_epub");
  truthy("book 笔记通过 M1 formal 校验（否则写进盘也不算正式记录）",
    validateNote(bn.data, { mode: "formal", objectType: "book", domain: BOOK_DOMAIN }).ok);
  truthy("book 笔记不许宣称「已读懂」", !/读懂/.test(JSON.stringify(bn.data)));
  await expectCode("book 笔记缺作者 ⇒ 拒绝构造（不编造作者）",
    () => buildBookInfoNote({ ...bookNoteArgs, author: "" }), "MISSING_REQUIRED");
  await expectCode("book 笔记缺书名 ⇒ 拒绝构造",
    () => buildBookInfoNote({ ...bookNoteArgs, title: "" }), "MISSING_REQUIRED");
  await expectCode("book 笔记缺 book_version_id ⇒ 拒绝构造",
    () => buildBookInfoNote({ ...bookNoteArgs, book_version_id: "" }), "MISSING_REQUIRED");
  await expectCode("book 笔记缺 content_id ⇒ 拒绝构造（dedup_check_ref 定不出来就不写）",
    () => buildBookInfoNote({ ...bookNoteArgs, content_id: "" }), "MISSING_REQUIRED");

  // 旧模型的两个导出必须**已经消失**，否则「复算换新 run_id + 标 stale」会从后门回来
  truthy("newRunId 已移除（不再按输入指纹算身份）", typeof newRunId === "undefined");
  truthy("beginRecompute 已移除（不再换新 run_id + 标 stale）", typeof beginRecompute === "undefined");

  // 同书同指纹复用同一 run_id 现在是**要求**（旧模型下这里必须抛 IMMUTABLE_INPUT_FINGERPRINT）
  const reuse = safe(() => mapRecommendationResultToRun(r, { ...runCtx(req), previous_run: run }));
  truthy("同指纹复用同一 run_id 现在被允许（一本书一个理解）",
    reuse?.__threw === undefined && reuse?.run_id === run.run_id, JSON.stringify(reuse).slice(0, 220));

  // 不存 prompt / 完整会话
  falsy("run 不含 prompt 字段", allKeys(run).some((k) => /prompt_text|messages|conversation|transcript/i.test(k)));
  truthy("run 只记 prompt_template_version", typeof run.prompt_template_version === "string");
  truthy("input_manifest_refs 只记引用", run.input_manifest_refs.every((x) => typeof x === "string"));

  // 弃权也能形成可追溯 run
  const reqEmpty = requestFixture({ candidates: [] });
  const rEmpty = await R(reqEmpty, host);
  const runEmpty = mapRecommendationResultToRun(rEmpty, runCtx(reqEmpty));
  is("弃权 run 的 result_outcome", runEmpty.result_outcome, "insufficient_evidence");
  is("弃权 run 的 book_guide=null", runEmpty.book_guide, null);
  deep("弃权 run 的 selected_items=[]", runEmpty.selected_items, []);
  is("弃权 run 的 status=none", runEmpty.personalization_status, "none");
}

// =========================================================================== //
console.log("\n[17] 替身忠实性元检查 + 不忠实替身反向验证");
// =========================================================================== //
{
  // 元检查 1：readSourceSpan 对未知 id **不发明** hash
  const host = makeHost({ spans: DEFAULT_SPANS, generate: GEN_ONE });
  const unknown = await host.readSourceSpan("does_not_exist");
  is("替身：未知 span ⇒ ok:false", unknown.ok, false);
  falsy("替身：未知 span 不发明 text_hash", Object.prototype.hasOwnProperty.call(unknown, "text_hash"));
  const known = await host.readSourceSpan("sp1");
  is("替身：已知 span 原样返回真实 hash", known.text_hash, H("q1"));
  is("替身：hash 与夹具一致（不是自造）", known.text_hash === H("q1"), true);
  isNot("替身：hash 不等于任何自造值", known.text_hash, H("invented:sp1"));
  deep("替身：调用被记录", host.calls.readSourceSpan, ["does_not_exist", "sp1"]);

  // 元检查 2：generateStructured **原样**返回草稿（不加工）
  const sentinel = { overview_paragraphs: [{ text: "哨兵文本", source_refs: ["sp1"] }] };
  const h2 = makeHost({ spans: DEFAULT_SPANS, generate: () => sentinel });
  const out = await h2.generateStructured({ task: "x" }, {});
  is("替身：generateStructured 原样返回（不加工）", out, sentinel);
  is("替身：记录到调用", h2.calls.generateStructured.length, 1);

  // 元检查 2b（端到端）：喂给 generateStructured 的候选**只含通过剧透/版本门的**，
  // 否则越界内容会进模型上下文（PRD :218 不得泄露未授权章节）。
  const hBoundary = makeHost({ spans: DEFAULT_SPANS, generate: GEN_ONE });
  await R(requestFixture({
    reading_boundary: { mode: "through_section", through_section_order: 1 },
    candidates: [
      candidateFixture({ candidate_id: "c_in", section_id: "s1", section_order: 1, overview_paragraph: null }),
      candidateFixture({ candidate_id: "c_out", section_id: "s2", section_order: 2, book_evidence_refs: ["sp2"], overview_paragraph: null }),
    ],
  }), hBoundary);
  is("替身：generateStructured 被调用", hBoundary.calls.generateStructured.length, 1);
  const fed = hBoundary.calls.generateStructured[0].req.items.map((i) => i.candidate_id);
  deep("策略只把边界内候选喂给模型（不泄露越界章节）", fed, ["c_in"]);

  // 元检查 3：retrieve 原样返回命中（不合成）
  const h3 = makeHost({ spans: DEFAULT_SPANS, hits: [{ span_id: "h1" }] });
  const hits = await h3.retrieve("q", {});
  deep("替身：retrieve 原样返回", hits, [{ span_id: "h1" }]);
  const h4 = makeHost({ spans: DEFAULT_SPANS });
  deep("替身：无命中就是空数组（不合成）", await h4.retrieve("q", {}), []);

  // 策略真的用了 generateStructured（不是自己编浓缩）
  const h5 = makeHost({ spans: DEFAULT_SPANS, generate: () => ({ overview_paragraphs: [{ text: "模型给的浓缩", source_refs: ["sp1"] }] }) });
  const rGen = await R(requestFixture({ candidates: [candidateFixture({ overview_paragraph: null })] }), h5);
  is("策略调用 generateStructured", h5.calls.generateStructured.length, 1);
  deep("策略采用模型给的浓缩原文", guide(rGen).overview_paragraphs, ["模型给的浓缩"]);

  // 不忠实替身反向验证：先断言它确实产出坏数据，再断言策略必须识破
  const unfaithful = makeUnfaithfulHost({ spans: DEFAULT_SPANS });
  const badSpan = await unfaithful.readSourceSpan("sp1");
  isNot("不忠实替身：确实自造了 hash（坏数据真实存在）", badSpan.text_hash, H("q1"));
  is("不忠实替身：自造 hash 可复现", badSpan.text_hash, H("invented:sp1"));
  const rBad = await R(requestFixture({
    candidates: [candidateFixture({ book_evidence_refs: [{ span_id: "sp1", text_hash: H("q1") }] })],
  }), unfaithful);
  is("策略必须识破不忠实替身（source_hash_mismatch）", first(arr(rBad.exclusions)).reason_code, "source_hash_mismatch");
  is("识破后不推荐（整体弃权）", rBad.outcome, "insufficient_evidence");

  // 结构化生成返回无来源 ⇒ 结构错误（不静默放过）
  const hNoSrc = makeHost({ spans: DEFAULT_SPANS, generate: () => ({ overview_paragraphs: [{ text: "无来源", source_refs: [] }] }) });
  await expectCode("模型浓缩无来源 ⇒ 结构错误",
    () => rank(requestFixture({ candidates: [candidateFixture({ overview_paragraph: null })] }), hNoSrc),
    "CONDENSATION_WITHOUT_SOURCE");
  const hEmpty = makeHost({ spans: DEFAULT_SPANS, generate: () => ({ overview_paragraphs: [] }) });
  await expectCode("模型浓缩为空 ⇒ 结构错误",
    () => rank(requestFixture({ candidates: [candidateFixture({ overview_paragraph: null })] }), hEmpty),
    "CONDENSATION_WITHOUT_SOURCE");
  const hBoom = makeHost({ spans: DEFAULT_SPANS, generate: () => { throw new Error("模型超时"); } });
  const errBoom = await (async () => { try { await rank(requestFixture({ candidates: [candidateFixture({ overview_paragraph: null })] }), hBoom); return null; } catch (e) { return e; } })();
  is("模型失败 ⇒ blocked（可恢复），不是弃权", errBoom.work_job_state, "blocked");
  is("模型失败错误码", errBoom.code, "MODEL_FAILED");

  // 浓缩引用的 span 不可读 ⇒ 结构错误
  await expectCode("浓缩引用不可读 span ⇒ 结构错误",
    () => rank(requestFixture({ candidates: [candidateFixture({ overview_paragraph: { text: "x", source_refs: ["missing"] } })] }), host),
    "CONDENSATION_WITHOUT_SOURCE");

  // 跨章主张必须列分开的出处
  await expectCode("跨章段落只解析出 1 章 ⇒ 被抓",
    () => rank(requestFixture({
      candidates: [candidateFixture({ overview_paragraph: { text: "跨章主张", source_refs: ["sp1"], cross_section: true } })],
    }), host),
    "CROSS_SECTION_PARAGRAPH_SOURCES_MIXED");
  const cross = await R(requestFixture({
    candidates: [candidateFixture({ overview_paragraph: { text: "跨章主张", source_refs: ["sp1", "sp2"], cross_section: true } })],
  }), host);
  truthy("跨章段落列分开出处 ⇒ 通过", guide(cross).source_refs.length === 2);
}

// =========================================================================== //
console.log("\n[18] 无法离线验证（显式跳过，不算通过）");
// =========================================================================== //
{
  skip("真实 LLM 是否遵守浓缩规则",
    "离线只有忠实替身；本套件只证明「不合规浓缩必被拒」，不证明真实模型会合规（需 M6 运行期）");
  skip("真实宿主 capabilities 注入",
    "四项能力在运行期由 lib/index.js 注入；M5 未接线、未重启宿主（需 M6）");
  skip("UI 是否真的显示「已应用本次排除」",
    "本层只保证 constraints_report.applied_feedback_exclusions.note 可读；渲染属 M7");
  skip("RecommendationRun 真实落盘幂等",
    "写盘走 M1 file-service 事务，属 M6 接线范围");
}

// =========================================================================== //
console.log(`\n结果：${pass} 通过 / ${fail} 失败 / ${skipped} 跳过`);
if (fail > 0) process.exitCode = 1;
