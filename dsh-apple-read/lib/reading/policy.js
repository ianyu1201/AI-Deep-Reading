/**
 * lib/reading/policy.js · M5 两层推荐策略（RecommendationPolicy）
 *
 * 职责（执行计划-v0.6 §1 表 #6）：`RecommendationPolicy.rank(request, capabilities)
 * -> RecommendationResult`（PRD §11.4 :924-937）—— 先过**质量门**（来源/剧透/版本/时间/
 * 用户明确排除），再做**两层**推荐：
 *   · 第一层 `book_guide`：**不依赖个人背景**，按书本价值 B 选，含**有来源**的浓缩；
 *   · 第二层 `personalized_items`：只在**真实授权材料存在**时生成，按 S 选。
 *
 * 依赖 `schema.js`（M1）与 `compiler.js`（M4，复用 `NON_EVIDENCE_SOURCE_KINDS`）。
 *
 * ---------------------------------------------------------------------------
 * ## 这个模块最容易写错的八处（PRD 逐条点名）
 *
 * 1. **C 的分母**（PRD :271 / 规范 :84）
 *    · `W = Σwᵢ`（已知个人维度集合 K ⊆ {R,G,T}）；`C = W / Σ(启用维度权重)`。
 *    · 默认三者全启用 ⇒ Σ=0.70 ⇒ 与 :271 字面**逐位一致**。
 *    · **禁用维度不计入分母**：否则 C 永远到不了 1、`available` 永远不可达（与 :280 矛盾）。
 *    · 权重被替换（例如总和 1.5）时 **C ≤ 1 由构造保证** ⇒ `λ = cap×C×q ≤ 0.40` 不被突破。
 *
 * 2. **W=0 时不做 null 乘法**（PRD :271）
 *    · `W=0 ⇒ λ=0、U=null、S=B`（**不是** `(1-λ)B + λ·null`）。
 *
 * 3. **缺依据必须是 `null`，不得填 0/中立**（PRD :269/:271）
 *    · 无依据的维度保留 `null` 并显示 unknown；`0` 只表示「已有依据明确显示不适用/不相关」。
 *
 * 4. **`B` 不得用检索相似度冒充**（PRD :267/:271）
 *    · `B` 必须带**书内依据 + 理由**；检索命中**永不**产生/抬高 `B`。
 *    · 书内依据不足 ⇒ **不评分、不推荐**（不是给低分、不是给 0）。
 *
 * 5. **`G` 不得从「知识库为空」推断；`T` 必须有真实已表达判断 + 书内冲突/边界**（PRD :269）
 *    · 维度分值必须附**维度依据与理由**，不能仅给数字。
 *    · `G` 还必须有**具体表现**（`observed_performance`）证据 + 书内前提：**偏好（explicit_preference）
 *      与 AI 假设（ai_hypothesis）都不算具体表现** ⇒ `G_WITHOUT_OBSERVED_PERFORMANCE`。
 *    · `T` 的判断依据必须来自**真实用户来源**（`origin === "user"`）⇒ `T_WITHOUT_EXPRESSED_JUDGMENT`。
 *
 * 5b. **证据门：不合格的证据一律丢弃，绝不降级使用**（PRD :483/:981 / 规范 :86）
 *    · 未授权（不在允许表）、`retracted`、非 `active`、来源不可核验、已过期、
 *      压缩摘要（`NON_EVIDENCE_SOURCE_KINDS`，含 `compact-checkpoint`）⇒ **丢弃该维度**，
 *      记入 `constraints_report.dropped_dimensions`，**不进 `W`**（因此也不会因归一化拿到叠加）。
 *    · `stable` 层额外要求 `origin=user` + `confirmed` + 在 `note_ids_and_hashes` 里 +
 *      服务侧 `readKnowledge` 精确读取一致（不能只信允许表自报）。
 *    · 丢弃是**数据判定**（不抛错）；只有「策略无法继续」才抛 `PolicyError`。
 *
 * 6. **未知维度不得因归一化拿到完整 0.40 叠加**（PRD :280）
 *    · 只有参与计算的维度进 `W`；未知维度既不进 U，也不抬高 C。
 *
 * 7. **仅排除反馈 ⇒ status=none，但界面必须明示「已应用本次排除」**（PRD :280）
 *    · `constraints_report.applied_feedback_exclusions.note === "已应用本次排除"`。
 *
 * 8. **不能只因空背景整体弃权**（PRD :965/:971）
 *    · 空背景（无个人材料）仍必须输出第一层书本导读，`personalization_status=none`。
 *    · 只有**缺少可信书内材料**才可能 `insufficient_evidence`。
 *
 * ---------------------------------------------------------------------------
 * ## 空白区解释（PRD 未定义结构，本文件按最小可执行形状定义；已记入 PROGRESS.md）
 *
 *   · `policy_config` 缺失/非法 ⇒ 默认三者全启用、Σ=0.70、λ 上限 0.40（冻结裁定②）；
 *     显式请求 λ 上限 > 0.40 ⇒ 夹到 0.40 并在 `constraints_report` 记 `lambda_cap_clamped`
 *     （硬不变式 λ≤0.40 优先，且**不静默**）。
 *   · 候选/维度/证据/反馈/边界/预算的形状（PRD 只给字段名）；
 *   · `q` 的判定 = 「**参与计算的已知**启用维度里，任一依赖未确认观察或 AI 评估」；
 *   · 第一层浓缩**只用通过剧透/版本门的候选**（否则会泄露越界内容）；
 *     若一个安全浓缩材料都没有（且 coverage 也没给 book_summary）⇒ 整体
 *     `insufficient_evidence`——这符合 :965「只有缺少可信书内材料才可能整体弃权」。
 *   · 结果顶层**恰好 7 键**（冻结裁定①）；`selected_items` **不进 result**，
 *     由 `computeSelectedItems()` 显式导出（:971 形状 / :469 归 RecommendationRun）。
 *   · 文件路径 `lib/reading/policy.js`（执行计划 §1 #6）偏离 PRD :861 的
 *     `lib/reading/recommendation/default-policy.js`（冻结裁定③，非契约，已备案）。
 *
 * ## 纯函数与注入
 *   模块不读网络、不写文件、不读宿主；四项能力（`readSourceSpan` / `readKnowledge` /
 *   `retrieve` / `generateStructured`）一律经 `capabilities` 注入。
 *   时钟经 `request`/构造器注入（`new RecommendationPolicy({now})`），测试完全确定化。
 */

import {
  SCHEMA_VERSION,
  VALUE_DOMAINS,
  sha256Hex,
  validateNote,
} from "./schema.js";

// M4：压缩摘要类来源**不能成为证据**（PRD :981 / 已知约束「compact-checkpoint 只作导航」）。
import { NON_EVIDENCE_SOURCE_KINDS } from "./compiler.js";

// M10 收口 A：书域配置的唯一来源（域注入，本模块不再内证书域知识）。
import { BOOK_DOMAIN } from "./book-domain.js";

// --------------------------------------------------------------------------- //
// 基础判定（与 M1/M3/M4 同名同义，避免跨文件语义漂移）
// --------------------------------------------------------------------------- //
const isMap = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isArr = Array.isArray;
const isStr = (v) => typeof v === "string";
const isNonEmptyStr = (v) => typeof v === "string" && v.trim() !== "";
const isInt = (v) => Number.isInteger(v);
const isHash64 = (v) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// --------------------------------------------------------------------------- //
// 版本与闭合词表
// --------------------------------------------------------------------------- //
/** 策略身份（写进 `RecommendationRun.policy` / `policy_and_model_metadata.policy`）。 */
export const POLICY_ID = "evidence_balanced";
export const POLICY_VERSION = "1.0.0";
export const POLICY_NAME = "dsh-apple-read.reading-policy";

/** PRD :932/:970：`RecommendationResult.outcome` **恰好两个值**。 */
export const RECOMMENDATION_OUTCOMES = Object.freeze(["items", "insufficient_evidence"]);

/** PRD §11.4 :925-928：`request` 的 **12 键**（闭合；多字段一律拒绝，防走私）。 */
export const REQUEST_KEYS = Object.freeze([
  "schema_version",
  "run_id",
  "book_version_id",
  "coverage_snapshot",
  "goal",
  "allowed_profile_refs_and_short_evidence",
  "note_ids_and_hashes",
  "candidates",
  "reading_boundary",
  "recent_feedback",
  "policy_config",
  "budget",
]);

/** PRD §11.4 :929-930：`capabilities` 的 **4 项**，恰好等集。 */
export const CAPABILITY_KEYS = Object.freeze([
  "readSourceSpan",
  "readKnowledge",
  "retrieve",
  "generateStructured",
]);

/**
 * 冻结裁定①：`RecommendationResult` 顶层 = PRD :936 正式接口块的 **7 键**。
 * （:470 的 6 键版是摘要，漏了 `policy_and_model_metadata`，不采用。）
 */
export const RESULT_KEYS = Object.freeze([
  "outcome",
  "book_guide",
  "personalized_items",
  "personalization_status",
  "exclusions",
  "constraints_report",
  "policy_and_model_metadata",
]);

/** PRD :280：`personalization_status` 值域。 */
export const PERSONALIZATION_STATUSES = Object.freeze(["none", "limited", "available"]);

/** PRD :269：四维中的**个人参考**三维（B 是书本基线，独立保留）。 */
export const PERSONAL_DIMENSIONS = Object.freeze(["R", "G", "T"]);

/** PRD :269：默认个人参考权重 R/G/T = 0.30/0.20/0.20（总额 0.70）。 */
export const DEFAULT_DIMENSION_WEIGHTS = Object.freeze({ R: "0.30", G: "0.20", T: "0.20" });

/** 默认启用维度：三者全启用 ⇒ Σ=0.70（与 PRD :271 字面逐位一致）。 */
export const DEFAULT_ENABLED_DIMENSIONS = Object.freeze(["R", "G", "T"]);

/** PRD :271：叠加系数上限 λ = 0.40 × C × q，0.40 为**上限**。 */
export const DEFAULT_LAMBDA_CAP = "0.40";

/** 硬不变式：λ ≤ 0.40（已知约束；替换策略也不能突破）。 */
export const LAMBDA_HARD_MAX = "0.40";

/** PRD :271：各已知分值 0—3。 */
export const DIMENSION_SCORE_MIN = 0;
export const DIMENSION_SCORE_MAX = 3;

/** PRD :271：B 的默认序位锚点（0—3），**逐字**落地为常量。 */
export const B_SCORE_ANCHORS = Object.freeze({
  0: "有来源但缺阅读价值",
  1: "局部补充",
  2: "代表性论点/必要前提",
  3: "核心论证或关键边界",
});
export const B_SCORE_MIN = 0;
export const B_SCORE_MAX = 3;

/** PRD :471：`feedback_type` **闭合集合（7）**（与 M1 schema 同源，测试交叉核对）。 */
export const FEEDBACK_TYPES = Object.freeze([
  "known",
  "interested",
  "not_interested",
  "disagree",
  "defer",
  "irrelevant",
  "correction",
]);

/** 规范 §3：ReadingEvidence.kind 闭合集合（G「知识库为空」不在其中）。 */
export const EVIDENCE_KINDS = Object.freeze([
  "self_report",
  "observed_performance",
  "explicit_preference",
  "ai_hypothesis",
]);

/**
 * 规范 §3 `:66-78`：MVP **五类证据展示标签**的闭合值域。
 *
 * 这里只声明**值域**（用于校验「写进去的标签必须是这五个之一」，1b/3c）；
 * **派生逻辑只有一份**，在 `assets/panel/app.js` 的 `evidenceLabel()` 里（规范 `:78` 的顺序）。
 * 服务端**不重新实现**派生 —— 避免第二套实现与面板漂移。
 */
export const EVIDENCE_LABELS = Object.freeze([
  "未知",
  "自报熟悉",
  "有一次解释证据",
  "有迁移证据",
  "待复核",
]);

/** 证据分层（规范 :86：`use=reference` / `use=stable`）。 */
export const EVIDENCE_TIERS = Object.freeze(["reference", "stable"]);

/** `personalized_items` 每项的键，**恰好 6 个**（PRD :934-935 原样）。 */
export const PERSONALIZED_ITEM_KEYS = Object.freeze([
  "candidate_id",
  "reasons",
  "dimension_evidence",
  "scores",
  "uncertainty",
  "source_refs",
]);

/** PRD :935：`scores` 的 **10 键**（B/R/G/T/W/C/q/lambda/U/S）。 */
export const SCORE_KEYS = Object.freeze([
  "B", "R", "G", "T", "W", "C", "q", "lambda", "U", "S",
]);

/** PRD :933：`book_guide` 的键（`no_eligible_reason` 仅在 items 为空时出现）。 */
export const BOOK_GUIDE_KEYS = Object.freeze([
  "overview_paragraphs", "coverage_scope", "source_refs", "items",
]);

/** `policy_and_model_metadata` 的键（PRD 未定义结构；这里是可执行形状）。 */
export const POLICY_AND_MODEL_METADATA_KEYS = Object.freeze([
  "policy",
  "model",
  "prompt_template_version",
  "candidate_set_version",
  "input_fingerprint",
  "input_manifest_refs",
  "lambda_cap",
  "enabled_dimensions",
  "weights",
  "b_anchors",
  "retrieval_used_as_baseline",
  "budget",
]);

/**
 * PRD :469 + M1 `schema.js` 的 `recommendation_run.required`：**18 个必填字段**。
 * 测试会把它与 `schema.js` 的 required 列表**交叉核对**（不是硬编码信任）。
 */
export const RECOMMENDATION_RUN_REQUIRED_KEYS = Object.freeze([
  "run_id",
  "job_id",
  "state",
  "book_version_id",
  "input_manifest_refs",
  "input_fingerprint",
  "candidate_set_version",
  "policy",
  "model",
  "prompt_template_version",
  "result_outcome",
  "book_guide",
  "personalized_items",
  "personalization_status",
  "selected_items",
  "exclusions",
  "constraints_report",
  "budget_usage",
]);

/** `policy_config` 允许的键（PRD 未定义结构；未知键 ⇒ 回落到默认，不猜）。 */
export const POLICY_CONFIG_KEYS = Object.freeze([
  "policy_id",
  "policy_version",
  "model",
  "prompt_template_version",
  "weights",
  "enabled_dimensions",
  "lambda_cap",
]);

/** 两层默认最多 3 项（PRD :282）。 */
export const DEFAULT_BUDGET = Object.freeze({
  max_items_per_layer: 3,
  max_minutes: null,
  max_overview_paragraphs: 3,
});

/** 质量门执行顺序（PRD :263 原样：读取授权→剧透→引用有效性→版本→用户排除→时间）。 */
export const GATE_ORDER = Object.freeze([
  "authorization",
  "reading_boundary",
  "citation_validity",
  "book_version",
  "user_exclusion",
  "time_budget",
]);

/** 排除原因码（闭合；每条都对应一个硬约束）。 */
export const EXCLUSION_REASON_CODES = Object.freeze([
  "version_mismatch",
  "outside_reading_boundary",
  "reading_boundary_unverifiable",
  "source_unavailable",
  "source_hash_mismatch",
  "insufficient_book_evidence",
  "no_book_value_score",
  "user_excluded",
  "outside_time_budget",
]);

/** 「可信书内材料缺失」类排除（决定是 `items=[]` 还是整体弃权）。 */
export const MATERIAL_EXCLUSION_REASONS = Object.freeze([
  "source_unavailable",
  "source_hash_mismatch",
  "insufficient_book_evidence",
  "no_book_value_score",
]);

/** 「用户/环境约束」类排除（全部候选都属此类 ⇒ `items=[]` + `no_eligible_reason`）。 */
export const CONSTRAINT_EXCLUSION_REASONS = Object.freeze([
  "version_mismatch",
  "outside_reading_boundary",
  "reading_boundary_unverifiable",
  "user_excluded",
  "outside_time_budget",
]);

/** `constraints_report` 的键（闭合；PRD :323 给了其中两个）。 */
export const CONSTRAINT_REPORT_KEYS = Object.freeze([
  "gate_order",
  "consent_passed",
  "reading_boundary_passed",
  "version_passed",
  "citation_passed",
  "source_verified_count",
  "excluded_counts",
  "material_exclusions",
  "constraint_exclusions",
  "applied_feedback_exclusions",
  "soft_signals",
  "dropped_dimensions",
  "unknown_dimensions",
  "policy_config_fallback",
  "lambda_cap_clamped",
  "retrieval_hits_ignored_for_baseline",
  "selection_tradeoffs",
  "insufficient_evidence_reason",
]);

/** PRD :280：仅排除反馈时**必须**明示的文案（不是可选装饰）。 */
export const APPLIED_EXCLUSION_NOTE = "已应用本次排除";

/** 无依据维度的显示标签（PRD :271「保留 null 并显示 unknown」）。 */
export const UNKNOWN_DIMENSION_LABEL = "unknown";

/** PRD :925：schema_version。 */
export const REQUIRED_SCHEMA_VERSION = SCHEMA_VERSION;

// --------------------------------------------------------------------------- //
// 精确有理数（避免浮点误差；三组算例要逐位对齐 76/35、73/35）
// --------------------------------------------------------------------------- //
const ZERO = Object.freeze({ n: 0n, d: 1n });
const ONE = Object.freeze({ n: 1n, d: 1n });
const HALF = Object.freeze({ n: 1n, d: 2n });

function gcdBig(a, b) {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

function rMake(n, d) {
  if (d === 0n) return null;
  let num = n;
  let den = d;
  if (den < 0n) {
    num = -num;
    den = -den;
  }
  const g = gcdBig(num, den) || 1n;
  return { n: num / g, d: den / g };
}

/**
 * 解析为精确有理数。
 *   · `bigint` ⇒ n/1
 *   · `number` ⇒ 取**最短往返十进制表示**（`String(v)`）再精确解析，例如 0.30 ⇒ 3/10
 *   · `string` ⇒ 支持 `"3/7"` 与十进制 `"0.30"`
 * 解析失败返回 `null`（**不猜**）。
 */
export function exactParse(v) {
  if (typeof v === "bigint") return rMake(v, 1n);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return null;
    if (Number.isInteger(v)) return rMake(BigInt(v), 1n);
    return exactParse(String(v));
  }
  if (typeof v !== "string") return null;
  const s = v.trim();
  let m = /^([+-]?\d+)\s*\/\s*(\d+)$/.exec(s);
  if (m) return rMake(BigInt(m[1]), BigInt(m[2]));
  m = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) return null;
  const sign = m[1] === "-" ? -1n : 1n;
  const intPart = BigInt(m[2]);
  const frac = m[3] ?? "";
  const den = 10n ** BigInt(frac.length);
  return rMake(sign * (intPart * den + BigInt(frac === "" ? "0" : frac)), den);
}

export const exactAdd = (a, b) => rMake(a.n * b.d + b.n * a.d, a.d * b.d);
export const exactSub = (a, b) => rMake(a.n * b.d - b.n * a.d, a.d * b.d);
export const exactMul = (a, b) => rMake(a.n * b.n, a.d * b.d);
export const exactDiv = (a, b) => (b.n === 0n ? null : rMake(a.n * b.d, a.d * b.n));
export const exactIsZero = (a) => a.n === 0n;
export const exactGt = (a, b) => a.n * b.d > b.n * a.d;
export const exactEq = (a, b) => a.n === b.n && a.d === b.d;
export const exactToNumber = (a) => Number(a.n) / Number(a.d);
/** 分数串：整数给 `"3"`，分数给 `"76/35"`（不约成小数）。 */
export const exactToString = (a) => (a.d === 1n ? `${a.n}` : `${a.n}/${a.d}`);

/** 供测试/调用方使用的有理数工具（不额外暴露内部状态）。 */
export const Rational = Object.freeze({
  parse: exactParse,
  add: exactAdd,
  sub: exactSub,
  mul: exactMul,
  div: exactDiv,
  isZero: exactIsZero,
  gt: exactGt,
  eq: exactEq,
  toNumber: exactToNumber,
  toString: exactToString,
});

// --------------------------------------------------------------------------- //
// 错误类型
// --------------------------------------------------------------------------- //
/**
 * 推荐策略错误。
 *
 * `work_job_state` 把 PRD :971 的「来源/模型/存储错误走 WorkJob.blocked|failed」变成可执行分类：
 *   · `blocked` —— 条件改变后可恢复（模型超时、来源暂时不可读）
 *   · `failed`  —— 重试无意义（请求形状错、缺能力、结构错误、契约违反）
 *
 * **它永远不是 `insufficient_evidence`**：弃权是结果枚举，不是错误。
 */
export class PolicyError extends Error {
  constructor(code, message, detail = null, { workJobState = "failed" } = {}) {
    super(message);
    this.name = "PolicyError";
    this.code = code;
    this.detail = detail;
    this.work_job_state = workJobState === "blocked" ? "blocked" : "failed";
  }
}

const blocked = (code, message, detail) =>
  new PolicyError(code, message, detail, { workJobState: "blocked" });
const failed = (code, message, detail) =>
  new PolicyError(code, message, detail, { workJobState: "failed" });

// --------------------------------------------------------------------------- //
// 1. request / capabilities / policy_config 形状
// --------------------------------------------------------------------------- //
/** 校验 request：键集合**闭合**，且必填键/类型正确。多字段一律拒绝（防走私）。 */
export function validateRankRequest(request) {
  if (!isMap(request)) {
    throw failed("INVALID_REQUEST", "rank(request) 的 request 必须是映射");
  }
  const unknown = Object.keys(request).filter((k) => !REQUEST_KEYS.includes(k));
  if (unknown.length > 0) {
    throw failed("INVALID_REQUEST", `request 出现未定义字段（键集合闭合）：${unknown.join(", ")}`, {
      unknown_keys: unknown,
    });
  }
  const required = REQUEST_KEYS.filter(
    (k) => k !== "goal" && k !== "allowed_profile_refs_and_short_evidence",
  );
  for (const k of required) {
    if (!hasOwn(request, k)) {
      throw failed("MISSING_REQUIRED", `request 缺少必填字段 ${k}`);
    }
  }
  if (request.schema_version !== REQUIRED_SCHEMA_VERSION) {
    throw failed(
      "INVALID_VALUE",
      `request.schema_version 必须是 "${REQUIRED_SCHEMA_VERSION}"，得到 ${JSON.stringify(request.schema_version)}`,
    );
  }
  for (const k of ["run_id", "book_version_id"]) {
    if (!isNonEmptyStr(request[k])) {
      throw failed("MISSING_REQUIRED", `request.${k} 必须是非空字符串`);
    }
  }
  if (!isMap(request.coverage_snapshot)) {
    throw failed("INVALID_STRUCTURE", "request.coverage_snapshot 必须是映射");
  }
  if (!isArr(request.candidates)) {
    throw failed("INVALID_STRUCTURE", "request.candidates 必须是数组");
  }
  if (!isArr(request.recent_feedback)) {
    throw failed("INVALID_STRUCTURE", "request.recent_feedback 必须是数组");
  }
  if (!isArr(request.note_ids_and_hashes)) {
    throw failed("INVALID_STRUCTURE", "request.note_ids_and_hashes 必须是数组");
  }
  if (hasOwn(request, "allowed_profile_refs_and_short_evidence") &&
      !isArr(request.allowed_profile_refs_and_short_evidence)) {
    throw failed(
      "INVALID_STRUCTURE",
      "request.allowed_profile_refs_and_short_evidence 必须是数组",
    );
  }
  if (!isMap(request.reading_boundary)) {
    throw failed("INVALID_STRUCTURE", "request.reading_boundary 必须是映射");
  }
  if (request.policy_config !== null && request.policy_config !== undefined &&
      !isMap(request.policy_config)) {
    throw failed("INVALID_STRUCTURE", "request.policy_config 必须是映射或 null");
  }
  if (request.budget !== null && request.budget !== undefined && !isMap(request.budget)) {
    throw failed("INVALID_STRUCTURE", "request.budget 必须是映射或 null");
  }
  if (hasOwn(request, "goal") && request.goal !== null && request.goal !== undefined &&
      !isStr(request.goal) && !isMap(request.goal)) {
    throw failed("INVALID_STRUCTURE", "request.goal 必须是字符串、{ref,text} 或 null");
  }
  return { ok: true };
}

/** 四项能力**恰好等集**；缺任一项 ⇒ `HOST_UNSUPPORTED`（不降级成弃权）。 */
export function checkCapabilities(capabilities) {
  if (!isMap(capabilities)) {
    throw failed("HOST_UNSUPPORTED", "capabilities 必须是映射（四项能力，恰好等集）");
  }
  const missing = CAPABILITY_KEYS.filter((k) => typeof capabilities[k] !== "function");
  if (missing.length > 0) {
    throw failed("HOST_UNSUPPORTED", `宿主缺少能力：${missing.join(", ")}`, {
      missing_capabilities: missing,
    });
  }
  return { ok: true, keys: [...CAPABILITY_KEYS] };
}

/**
 * 解析 `policy_config`（PRD 未定义结构）。
 *
 * 冻结裁定②：**缺失/非法 ⇒ 默认三者全启用、Σ=0.70、λ 上限 0.40**。
 * 唯一的例外是**显式请求 λ 上限 > 0.40**：夹到 0.40 并记录 `lambda_cap_clamped`
 * （硬不变式优先，且不静默——见 `constraints_report`）。
 */
export function resolvePolicyConfig(policy_config) {
  const defaults = {
    policy_id: POLICY_ID,
    policy_version: POLICY_VERSION,
    model: null,
    prompt_template_version: null,
    weights: { ...DEFAULT_DIMENSION_WEIGHTS },
    enabled_dimensions: [...DEFAULT_ENABLED_DIMENSIONS],
    lambda_cap: DEFAULT_LAMBDA_CAP,
  };
  const fallback = (reason, detail = null) => ({
    config: defaults,
    fallback: { used: true, reason, detail },
    clamped: null,
  });

  if (policy_config === null || policy_config === undefined) {
    return fallback("missing");
  }
  if (!isMap(policy_config)) return fallback("not_a_map");
  const unknown = Object.keys(policy_config).filter((k) => !POLICY_CONFIG_KEYS.includes(k));
  if (unknown.length > 0) return fallback("unknown_keys", unknown);

  const config = { ...defaults, weights: { ...DEFAULT_DIMENSION_WEIGHTS } };

  if (hasOwn(policy_config, "policy_id")) {
    if (!isNonEmptyStr(policy_config.policy_id)) return fallback("invalid_policy_id");
    config.policy_id = policy_config.policy_id;
  }
  if (hasOwn(policy_config, "policy_version")) {
    if (!isNonEmptyStr(policy_config.policy_version)) return fallback("invalid_policy_version");
    config.policy_version = policy_config.policy_version;
  }
  if (hasOwn(policy_config, "model")) {
    if (policy_config.model !== null && !isNonEmptyStr(policy_config.model) &&
        !isMap(policy_config.model)) {
      return fallback("invalid_model");
    }
    config.model = policy_config.model ?? null;
  }
  if (hasOwn(policy_config, "prompt_template_version")) {
    if (!isNonEmptyStr(policy_config.prompt_template_version)) {
      return fallback("invalid_prompt_template_version");
    }
    config.prompt_template_version = policy_config.prompt_template_version;
  }
  if (hasOwn(policy_config, "enabled_dimensions")) {
    const enabled = policy_config.enabled_dimensions;
    if (!isArr(enabled)) return fallback("invalid_enabled_dimensions");
    if (new Set(enabled).size !== enabled.length) return fallback("duplicate_enabled_dimensions");
    if (enabled.some((d) => !PERSONAL_DIMENSIONS.includes(d))) {
      return fallback("unknown_dimension_in_enabled_dimensions");
    }
    config.enabled_dimensions = [...enabled];
  }
  if (hasOwn(policy_config, "weights")) {
    const w = policy_config.weights;
    if (!isMap(w)) return fallback("invalid_weights");
    const unknownW = Object.keys(w).filter((k) => !PERSONAL_DIMENSIONS.includes(k));
    if (unknownW.length > 0) return fallback("unknown_weight_keys", unknownW);
    for (const [k, v] of Object.entries(w)) {
      const r = exactParse(v);
      if (r === null) return fallback("unparsable_weight", k);
      config.weights[k] = isStr(v) ? v : String(v);
    }
  }
  // 启用维度必须有正权重（否则 Σ 可能为 0，C 无意义）。
  for (const d of config.enabled_dimensions) {
    const r = exactParse(config.weights[d]);
    if (r === null || r.n <= 0n) return fallback("non_positive_weight_for_enabled_dimension", d);
  }

  let clamped = null;
  if (hasOwn(policy_config, "lambda_cap")) {
    const cap = exactParse(policy_config.lambda_cap);
    if (cap === null || cap.n < 0n) return fallback("invalid_lambda_cap");
    const hard = exactParse(LAMBDA_HARD_MAX);
    if (exactGt(cap, hard)) {
      // 硬不变式 λ≤0.40 优先；不静默——记录被夹。
      clamped = { requested: isStr(policy_config.lambda_cap) ? policy_config.lambda_cap : String(policy_config.lambda_cap), applied: LAMBDA_HARD_MAX };
      config.lambda_cap = LAMBDA_HARD_MAX;
    } else {
      config.lambda_cap = isStr(policy_config.lambda_cap)
        ? policy_config.lambda_cap
        : String(policy_config.lambda_cap);
    }
  }
  return { config, fallback: { used: false, reason: null, detail: null }, clamped };
}

/** 解析 `budget`（PRD 只给字段名；非法 ⇒ 默认，且记录）。 */
export function resolveBudget(budget) {
  const defaults = { ...DEFAULT_BUDGET };
  if (budget === null || budget === undefined) {
    return { budget: defaults, fallback: { used: true, reason: "missing", detail: null } };
  }
  if (!isMap(budget)) {
    return { budget: defaults, fallback: { used: true, reason: "not_a_map", detail: null } };
  }
  const out = { ...defaults };
  if (hasOwn(budget, "max_items_per_layer")) {
    if (!isInt(budget.max_items_per_layer) || budget.max_items_per_layer < 0) {
      return { budget: defaults, fallback: { used: true, reason: "invalid_max_items_per_layer", detail: null } };
    }
    out.max_items_per_layer = budget.max_items_per_layer;
  }
  if (hasOwn(budget, "max_minutes")) {
    if (budget.max_minutes !== null &&
        (typeof budget.max_minutes !== "number" || !(budget.max_minutes >= 0))) {
      return { budget: defaults, fallback: { used: true, reason: "invalid_max_minutes", detail: null } };
    }
    out.max_minutes = budget.max_minutes ?? null;
  }
  if (hasOwn(budget, "max_overview_paragraphs")) {
    if (!isInt(budget.max_overview_paragraphs) || budget.max_overview_paragraphs < 1) {
      return { budget: defaults, fallback: { used: true, reason: "invalid_max_overview_paragraphs", detail: null } };
    }
    out.max_overview_paragraphs = budget.max_overview_paragraphs;
  }
  return { budget: out, fallback: { used: false, reason: null, detail: null } };
}

// --------------------------------------------------------------------------- //
// 2. 精确评分（PRD :271，逐字实现）
// --------------------------------------------------------------------------- //
/**
 * 纯函数：给定 B、个人维度分值、权重/启用维度/λ 上限，算出
 * `{scores, exact, known, soft}`。
 *
 *   W = Σwᵢ（i ∈ K，K = 启用且有分值的维度）
 *   C = W / Σ(启用维度权重)          ← 分母是**启用维度**权重之和（冻结裁定②）
 *   U = Σ(wᵢsᵢ)/W（W>0）；W=0 ⇒ null
 *   q = 0.5（任一参与计算的已知维度依赖未确认观察/AI 评估）否则 1
 *   λ = λcap × C × q
 *   S = (1−λ)B + λU（W>0）；W=0 ⇒ S=B、λ=0，**不做 null 乘法**
 *
 * `soft_dimensions` 由证据门（`resolveDimensionEvidence`）判定，**不由模型自报**。
 */
export function scoreCandidate({
  b,
  dimensions = {},
  weights = DEFAULT_DIMENSION_WEIGHTS,
  enabled_dimensions = DEFAULT_ENABLED_DIMENSIONS,
  lambda_cap = DEFAULT_LAMBDA_CAP,
  soft_dimensions = [],
} = {}) {
  const cap = exactParse(lambda_cap);
  if (cap === null) throw failed("INVALID_ARGUMENT", `lambda_cap 不可解析：${JSON.stringify(lambda_cap)}`);
  const bExact = exactParse(b);
  if (bExact === null) throw failed("INVALID_ARGUMENT", `B 不可解析：${JSON.stringify(b)}`);

  const enabled = PERSONAL_DIMENSIONS.filter((d) => enabled_dimensions.includes(d));
  const soft = new Set(soft_dimensions);

  let W = ZERO;
  let denom = ZERO;
  let Uacc = ZERO;
  const known = [];
  for (const d of enabled) {
    const w = exactParse(weights[d]);
    if (w === null) throw failed("INVALID_ARGUMENT", `权重不可解析：${d}=${JSON.stringify(weights[d])}`);
    denom = exactAdd(denom, w);
    const s = dimensions[d];
    if (s === null || s === undefined) continue;
    const sExact = exactParse(s);
    if (sExact === null) throw failed("INVALID_ARGUMENT", `${d} 分值不可解析：${JSON.stringify(s)}`);
    known.push(d);
    W = exactAdd(W, w);
    Uacc = exactAdd(Uacc, exactMul(w, sExact));
  }

  const wIsZero = exactIsZero(W);
  const C = exactIsZero(denom) ? ZERO : exactDiv(W, denom);
  const q = known.some((d) => soft.has(d)) ? HALF : ONE;
  const lambda = wIsZero ? ZERO : exactMul(exactMul(cap, C), q);
  const U = wIsZero ? null : exactDiv(Uacc, W);
  const S = wIsZero
    ? bExact
    : exactAdd(exactMul(exactSub(ONE, lambda), bExact), exactMul(lambda, U));

  const num = (r) => exactToNumber(r);
  const scores = {
    B: num(bExact),
    R: dimensions.R === null || dimensions.R === undefined ? null : num(exactParse(dimensions.R)),
    G: dimensions.G === null || dimensions.G === undefined ? null : num(exactParse(dimensions.G)),
    T: dimensions.T === null || dimensions.T === undefined ? null : num(exactParse(dimensions.T)),
    W: num(W),
    C: num(C),
    q: num(q),
    lambda: num(lambda),
    U: U === null ? null : num(U),
    S: num(S),
  };
  const exact = {
    B: exactToString(bExact),
    W: exactToString(W),
    C: exactToString(C),
    q: exactToString(q),
    lambda: exactToString(lambda),
    U: U === null ? null : exactToString(U),
    S: exactToString(S),
  };
  return { scores, exact, known, soft: known.filter((d) => soft.has(d)) };
}

// --------------------------------------------------------------------------- //
// 3. 证据门（参考过滤：use=reference / use=stable；规范 :86）
// --------------------------------------------------------------------------- //
function normalizeEvidenceEntry(entry, index) {
  if (!isMap(entry)) {
    throw failed("INVALID_STRUCTURE", `allowed_profile_refs_and_short_evidence[${index}] 必须是映射`);
  }
  if (!isNonEmptyStr(entry.ref)) {
    throw failed("MISSING_REQUIRED", `allowed_profile_refs_and_short_evidence[${index}].ref 必填`);
  }
  if (!EVIDENCE_TIERS.includes(entry.tier)) {
    throw failed("INVALID_ENUM", `allowed_profile_refs_and_short_evidence[${index}].tier 只能是 reference/stable`);
  }
  if (entry.kind !== null && entry.kind !== undefined && !EVIDENCE_KINDS.includes(entry.kind)) {
    throw failed(
      "INVALID_ENUM",
      `allowed_profile_refs_and_short_evidence[${index}].kind 只能是 ${EVIDENCE_KINDS.join("/")}`,
    );
  }
  return {
    ref: entry.ref,
    tier: entry.tier,
    kind: entry.kind ?? null,
    origin: entry.origin ?? null,
    confirmation: entry.confirmation ?? null,
    knowledge_status: entry.knowledge_status ?? null,
    valid_until: entry.valid_until ?? null,
    source_verifiable: entry.source_verifiable === true,
    source_kind: entry.source_kind ?? null,
    content_hash: entry.content_hash ?? null,
    derived_from_feedback: entry.derived_from_feedback ?? null,
    short_evidence: entry.short_evidence ?? null,
  };
}

function normalizeGoalEvidence(goal) {
  if (goal === null || goal === undefined) return null;
  const ref = isMap(goal) ? goal.ref : "goal:current";
  const text = isMap(goal) ? goal.text : goal;
  if (!isNonEmptyStr(ref)) throw failed("MISSING_REQUIRED", "request.goal.ref 必填");
  return {
    ref,
    tier: "reference",
    kind: "explicit_preference",
    origin: "user",
    confirmation: "confirmed",
    knowledge_status: "active",
    valid_until: null,
    source_verifiable: true,
    source_kind: "user_action",
    content_hash: null,
    derived_from_feedback: null,
    short_evidence: text ?? null,
  };
}

function normalizeInterestedFeedbackEvidence(feedback) {
  if (feedback.feedback_type !== "interested") return null;
  if (!isNonEmptyStr(feedback.feedback_id)) return null;
  return {
    ref: feedback.feedback_id,
    tier: "reference",
    kind: "explicit_preference",
    origin: "user",
    confirmation: "confirmed",
    knowledge_status: "active",
    valid_until: feedback.valid_until ?? null,
    source_verifiable: true,
    source_kind: "user_action",
    content_hash: null,
    derived_from_feedback: "interested",
    short_evidence: feedback.short_evidence ?? null,
  };
}

/** 构造证据索引：显式允许表 + goal 隐式项 + interested 反馈隐式项。 */
export function buildEvidenceIndex(request) {
  const byRef = new Map();
  const list = request.allowed_profile_refs_and_short_evidence ?? [];
  for (let i = 0; i < list.length; i++) {
    const e = normalizeEvidenceEntry(list[i], i);
    if (byRef.has(e.ref)) throw failed("INVALID_COMBINATION", `证据 ref 重复：${e.ref}`);
    byRef.set(e.ref, e);
  }
  const goalEv = normalizeGoalEvidence(request.goal ?? null);
  if (goalEv && !byRef.has(goalEv.ref)) byRef.set(goalEv.ref, goalEv);

  // PRD :280「明确兴趣反馈可作 R 的范围依据」：可信用户动作的 interested 反馈
  // 作为**显式偏好**证据进入允许表（不是能力证据，也永不当成掌握）。
  for (const f of request.recent_feedback ?? []) {
    if (!isMap(f)) continue;
    if (!isNonEmptyStr(f.user_action_id)) continue;
    const ev = normalizeInterestedFeedbackEvidence(f);
    if (ev && !byRef.has(ev.ref)) byRef.set(ev.ref, ev);
  }

  const noteById = new Map();
  for (let i = 0; i < request.note_ids_and_hashes.length; i++) {
    const n = request.note_ids_and_hashes[i];
    if (!isMap(n) || !isNonEmptyStr(n.object_id)) {
      throw failed("INVALID_STRUCTURE", `note_ids_and_hashes[${i}] 必须有 object_id`);
    }
    if (!isNonEmptyStr(n.content_hash)) {
      throw failed("MISSING_REQUIRED", `note_ids_and_hashes[${i}].content_hash 必填`);
    }
    noteById.set(n.object_id, n);
  }
  return { byRef, noteById, goalEv };
}

function isExpired(validUntil, nowIso) {
  if (validUntil === null || validUntil === undefined) return false;
  if (!isNonEmptyStr(validUntil)) return true;
  const t = Date.parse(validUntil);
  if (Number.isNaN(t)) return true;
  const n = Date.parse(nowIso);
  if (Number.isNaN(n)) return true;
  return t <= n;
}

/**
 * 解析一个个人维度的可用性（**服务侧**判据，模型不能自报）。
 *
 * 返回 `{usable, soft, drop_reason, evidence_refs, reasons}`：
 *   · `usable=false, drop_reason="unknown"` ⇒ 该维度保持 `null`（**不填 0/中立**）
 *   · 其它 `drop_reason` ⇒ 有依据但**不可用**（未授权/过期/撤回/摘要/未确认稳定层），
 *     记录进 `constraints_report.dropped_dimensions`，并且**不进 W**（不因归一化拿叠加）。
 */
export async function resolveDimensionEvidence({
  candidate_id,
  dimension,
  dim,
  evidenceIndex,
  capabilities,
  now,
}) {
  if (dim === null || dim === undefined) {
    return { usable: false, soft: false, drop_reason: "unknown", evidence_refs: [], reasons: [] };
  }
  if (!isMap(dim)) {
    throw failed("INVALID_STRUCTURE", `候选 ${candidate_id} 的 ${dimension} 依据必须是映射或 null`);
  }
  // 模型不得自报归属/确认（PRD :483「模型不能生成有效确认动作」）。
  for (const forbidden of ["origin", "confirmation", "confirmation_evidence", "basis"]) {
    if (hasOwn(dim, forbidden)) {
      throw failed(
        "MODEL_MUST_NOT_SELF_REPORT_CONFIRMATION",
        `候选 ${candidate_id} 的 ${dimension} 不得自报 ${forbidden}（归属/确认由服务侧证据表决定）`,
      );
    }
  }
  const score = dim.score ?? null;
  if (score === null) {
    return { usable: false, soft: false, drop_reason: "unknown", evidence_refs: [], reasons: [] };
  }
  if (!isInt(score) || score < DIMENSION_SCORE_MIN || score > DIMENSION_SCORE_MAX) {
    throw failed(
      "INVALID_VALUE",
      `候选 ${candidate_id} 的 ${dimension} 分值必须是 ${DIMENSION_SCORE_MIN}—${DIMENSION_SCORE_MAX} 的整数或 null，得到 ${JSON.stringify(score)}`,
    );
  }
  // 「R/G/T 的 0—3 必须附该维度依据与理由，不能仅给数字」（PRD :271）。
  if (!isNonEmptyStr(dim.reason)) {
    throw failed("DIMENSION_SCORE_WITHOUT_REASON", `候选 ${candidate_id} 的 ${dimension} 有分值但没有理由`);
  }
  if (!isArr(dim.evidence_refs) || dim.evidence_refs.length === 0) {
    throw failed("DIMENSION_SCORE_WITHOUT_REASON", `候选 ${candidate_id} 的 ${dimension} 有分值但没有 evidence_refs`);
  }

  const evidence_refs = [];
  const reasons = [];
  let soft = false;

  for (const ref of dim.evidence_refs) {
    if (!isNonEmptyStr(ref)) {
      throw failed("INVALID_STRUCTURE", `候选 ${candidate_id} 的 ${dimension}.evidence_refs 必须是非空字符串数组`);
    }
    const entry = evidenceIndex.byRef.get(ref);
    if (!entry) {
      reasons.push({ code: "evidence_not_authorized", ref });
      continue;
    }
    if (entry.confirmation === "retracted") {
      // 撤回的记录不进入新的推荐依据（PRD :483 / 规范 :86「confirmation 不为 retracted」）。
      reasons.push({ code: "evidence_retracted", ref });
      continue;
    }
    if (entry.knowledge_status !== "active") {
      reasons.push({ code: "evidence_not_active", ref });
      continue;
    }
    if (!entry.source_verifiable) {
      reasons.push({ code: "evidence_source_unverifiable", ref });
      continue;
    }
    if (entry.source_kind !== null && NON_EVIDENCE_SOURCE_KINDS.includes(entry.source_kind)) {
      // 压缩摘要只作导航，不能独立作个人证据（PRD :981 / 已知约束）。
      reasons.push({ code: "summary_not_evidence", ref });
      continue;
    }
    if (isExpired(entry.valid_until, now)) {
      reasons.push({ code: "evidence_expired", ref });
      continue;
    }
    if (entry.tier === "stable") {
      if (entry.origin !== "user" || entry.confirmation !== "confirmed") {
        reasons.push({ code: "stable_evidence_not_confirmed", ref });
        continue;
      }
      if (!evidenceIndex.noteById.has(ref)) {
        reasons.push({ code: "stable_evidence_not_in_note_ids", ref });
        continue;
      }
      // 服务侧精确读取：不能只信允许表自报（规范 :86「use=stable」）。
      let read = null;
      try {
        read = await capabilities.readKnowledge(ref);
      } catch (err) {
        throw blocked("KNOWLEDGE_READ_FAILED", `readKnowledge(${ref}) 失败：${err?.message ?? err}`, {
          ref,
          candidate_id,
          dimension,
        });
      }
      if (!isMap(read) || read.ok !== true) {
        reasons.push({ code: "stable_evidence_read_failed", ref });
        continue;
      }
      if (read.origin !== "user" || read.confirmation !== "confirmed" ||
          read.knowledge_status !== "active") {
        reasons.push({ code: "stable_evidence_mismatch", ref });
        continue;
      }
    } else {
      if (entry.origin === null || entry.confirmation === null) {
        reasons.push({ code: "reference_evidence_missing_attribution", ref });
        continue;
      }
    }
    const explicitPreference =
      entry.kind === "explicit_preference" || entry.derived_from_feedback === "interested";
    // AI 评估即便被接受仍保留 ai_inference 归属 ⇒ 永远 soft（PRD :280/:977）。
    if (entry.origin === "ai_inference") soft = true;
    else if (entry.confirmation === "unconfirmed" && !explicitPreference) soft = true;
    evidence_refs.push(ref);
  }

  if (evidence_refs.length === 0) {
    return {
      usable: false,
      soft: false,
      drop_reason: reasons[0]?.code ?? "no_usable_evidence",
      evidence_refs: [],
      reasons,
    };
  }
  return { usable: true, soft, drop_reason: null, evidence_refs, reasons };
}

// --------------------------------------------------------------------------- //
// 4. 候选形状与质量门（PRD :263/:267）
// --------------------------------------------------------------------------- //
function normalizeBookEvidenceRefs(refs, candidate_id) {
  if (!isArr(refs)) {
    throw failed("INVALID_STRUCTURE", `候选 ${candidate_id}.book_evidence_refs 必须是数组`);
  }
  return refs.map((r, i) => {
    if (isNonEmptyStr(r)) return { span_id: r, text_hash: null };
    if (isMap(r) && isNonEmptyStr(r.span_id)) {
      if (r.text_hash !== null && r.text_hash !== undefined && !isHash64(r.text_hash)) {
        throw failed("INVALID_VALUE", `候选 ${candidate_id}.book_evidence_refs[${i}].text_hash 必须是 64 位小写 hex`);
      }
      return { span_id: r.span_id, text_hash: r.text_hash ?? null };
    }
    throw failed("INVALID_STRUCTURE", `候选 ${candidate_id}.book_evidence_refs[${i}] 必须是 span_id 或 {span_id,text_hash}`);
  });
}

function normalizeCandidate(raw, index) {
  if (!isMap(raw)) throw failed("INVALID_STRUCTURE", `candidates[${index}] 必须是映射`);
  if (!isNonEmptyStr(raw.candidate_id)) {
    throw failed("MISSING_REQUIRED", `candidates[${index}].candidate_id 必填`);
  }
  const b = raw.b ?? null;
  if (b !== null && !isMap(b)) {
    throw failed("INVALID_STRUCTURE", `候选 ${raw.candidate_id}.b 必须是映射或 null`);
  }
  return {
    candidate_id: raw.candidate_id,
    book_version_id: raw.book_version_id ?? null,
    section_id: raw.section_id ?? null,
    section_order: raw.section_order ?? null,
    concept_refs: isArr(raw.concept_refs) ? raw.concept_refs : [],
    query: isNonEmptyStr(raw.query) ? raw.query : null,
    book_evidence_refs: normalizeBookEvidenceRefs(raw.book_evidence_refs ?? [], raw.candidate_id),
    b,
    personal: isMap(raw.personal) ? raw.personal : {},
    overview_paragraph: raw.overview_paragraph ?? null,
    estimated_minutes: raw.estimated_minutes ?? null,
    uncertainty: isNonEmptyStr(raw.uncertainty) ? raw.uncertainty : null,
    reason_code: isNonEmptyStr(raw.reason_code) ? raw.reason_code : null,
    dimensions: isArr(raw.dimensions) ? [...raw.dimensions] : [],
  };
}

/**
 * `B` 的校验（PRD :267/:271）：
 *   · 必须带书内依据 + 理由；
 *   · **检索相似度不得直接当 B**（`basis.kind === "retrieval_similarity"` ⇒ 硬拒）；
 *   · 0—3 整数。
 */
function validateBookValue(candidate) {
  const b = candidate.b;
  if (b === null) return { score: null, reason: null, basis: null };
  if (hasOwn(b, "score") && (b.score === null || b.score === undefined)) {
    return { score: null, reason: b.reason ?? null, basis: b.basis ?? null };
  }
  const score = b.score;
  if (!isInt(score) || score < B_SCORE_MIN || score > B_SCORE_MAX) {
    throw failed(
      "INVALID_VALUE",
      `候选 ${candidate.candidate_id} 的 B 必须是 ${B_SCORE_MIN}—${B_SCORE_MAX} 的整数或 null，得到 ${JSON.stringify(score)}`,
    );
  }
  if (!isNonEmptyStr(b.reason)) {
    throw failed("B_WITHOUT_REASON", `候选 ${candidate.candidate_id} 有 B=${score} 但没有理由`);
  }
  const basisKind = isMap(b.basis) ? b.basis.kind ?? null : null;
  if (basisKind === "retrieval_similarity") {
    throw failed(
      "B_FROM_RETRIEVAL_SIMILARITY",
      `候选 ${candidate.candidate_id} 用检索相似度直接充当 B（PRD :267 明令禁止）`,
    );
  }
  if (basisKind !== null && basisKind !== "book_analysis") {
    throw failed("INVALID_ENUM", `候选 ${candidate.candidate_id}.b.basis.kind 只能是 book_analysis`);
  }
  return { score, reason: b.reason, basis: basisKind ?? "book_analysis" };
}

/** 剧透边界（PRD :216/:263）。**不能从阅读百分比擅自推定**。 */
export function resolveReadingBoundary(boundary) {
  // 百分比字段**先查**：即使 mode 写成 whole_book，也不能拿百分比当章节坐标（PRD :218）。
  if (hasOwn(boundary, "read_percent") || hasOwn(boundary, "percent")) {
    throw failed(
      "READING_BOUNDARY_PERCENT_NOT_ALLOWED",
      "不得用阅读百分比推定剧透边界（PRD :218「Apple 阅读百分比只是辅助，不直接当稳定章节坐标」）",
    );
  }
  const mode = boundary.mode;
  if (mode === "whole_book") {
    return { mode, through_section_id: null, through_section_order: null };
  }
  if (mode === "through_section") {
    if (!isNonEmptyStr(boundary.through_section_id) &&
        !isInt(boundary.through_section_order)) {
      throw failed(
        "MISSING_REQUIRED",
        "reading_boundary.mode=through_section 时必须给 through_section_id 或 through_section_order",
      );
    }
    return {
      mode,
      through_section_id: boundary.through_section_id ?? null,
      through_section_order: isInt(boundary.through_section_order)
        ? boundary.through_section_order
        : null,
    };
  }
  if (mode === "percent") {
    throw failed(
      "READING_BOUNDARY_PERCENT_NOT_ALLOWED",
      "不得用阅读百分比推定剧透边界（PRD :218「Apple 阅读百分比只是辅助，不直接当稳定章节坐标」）",
    );
  }
  throw failed("INVALID_ENUM", "reading_boundary.mode 只能是 whole_book / through_section");
}

/** 反馈形状（闭合 7 值；缺可信用户动作 ⇒ 不生效，只记录）。 */
export function normalizeFeedback(recent_feedback, now) {
  const applied = [];
  const ignored = [];
  for (let i = 0; i < recent_feedback.length; i++) {
    const f = recent_feedback[i];
    if (!isMap(f)) throw failed("INVALID_STRUCTURE", `recent_feedback[${i}] 必须是映射`);
    if (!FEEDBACK_TYPES.includes(f.feedback_type)) {
      throw failed(
        "INVALID_ENUM",
        `recent_feedback[${i}].feedback_type 只能是 ${FEEDBACK_TYPES.join(" / ")}`,
      );
    }
    if (!isNonEmptyStr(f.user_action_id)) {
      // PRD :919「record_reading_feedback 需要可信用户动作，否则只能作为未确认提案」。
      ignored.push({ index: i, feedback_type: f.feedback_type, reason: "no_trusted_user_action" });
      continue;
    }
    if (isExpired(f.valid_until ?? null, now)) {
      ignored.push({ index: i, feedback_type: f.feedback_type, reason: "expired" });
      continue;
    }
    applied.push({
      index: i,
      feedback_id: f.feedback_id ?? null,
      feedback_type: f.feedback_type,
      feedback_scope: f.feedback_scope ?? null,
      item_id: f.item_id ?? null,
      section_id: f.section_id ?? null,
      concept_refs: isArr(f.concept_refs) ? f.concept_refs : [],
      user_action_id: f.user_action_id,
      valid_until: f.valid_until ?? null,
    });
  }
  return { applied, ignored };
}

/** 该反馈是否**明确排除**这个候选（PRD :278「两层候选均尊重本次明确排除」）。 */
function feedbackExcludes(feedback, candidate) {
  if (!["not_interested", "irrelevant", "defer"].includes(feedback.feedback_type)) return false;
  const scope = feedback.feedback_scope;
  if (scope === "item") return feedback.item_id === candidate.candidate_id;
  if (scope === "batch") return true;
  if (scope === "section") return feedback.section_id !== null && feedback.section_id === candidate.section_id;
  if (scope === "concept") {
    return feedback.concept_refs.some((c) => candidate.concept_refs.includes(c));
  }
  return false;
}

// --------------------------------------------------------------------------- //
// 5. 质量门 + 候选评估
// --------------------------------------------------------------------------- //
async function readSpan(capabilities, spanId, candidateId) {
  let span = null;
  try {
    span = await capabilities.readSourceSpan(spanId);
  } catch (err) {
    throw blocked("SOURCE_READ_FAILED", `readSourceSpan(${spanId}) 失败：${err?.message ?? err}`, {
      span_id: spanId,
      candidate_id: candidateId,
    });
  }
  return span;
}

/**
 * 核验「这个候选本来有没有**可信书内材料**」（来源可读 + B 有依据）。
 *
 * 为什么单独抽出来：被**用户明确排除**的候选也要知道它本来是否有可信材料，否则
 * PRD :971「全部候选被明确约束排除 ⇒ items=[] 且必须给 no_eligible_reason」永远不可达
 * ——会错判成整体弃权（`insufficient_evidence`），而 :965 只允许「缺少可信书内材料」弃权。
 */
async function verifySourceAndBookValue(c, capabilities, request) {
  if (c.book_evidence_refs.length === 0) {
    // 「检索相似度不得直接当 B」：检索命中只记录，**永不**变成 B。
    let retrieval_hits = 0;
    if (c.query !== null) {
      let hits = null;
      try {
        hits = await capabilities.retrieve(c.query, { book_version_id: request.book_version_id });
      } catch {
        hits = null;
      }
      retrieval_hits = isArr(hits) ? hits.length : isMap(hits) && isArr(hits.hits) ? hits.hits.length : 0;
    }
    return {
      source_verified: false,
      book_value: null,
      material_eligible: false,
      fail_reason: "insufficient_book_evidence",
      fail_detail: { retrieval_used_as_baseline: false, retrieval_hits },
    };
  }
  for (const ref of c.book_evidence_refs) {
    const span = await readSpan(capabilities, ref.span_id, c.candidate_id);
    if (!isMap(span) || span.ok !== true) {
      return { source_verified: false, book_value: null, material_eligible: false, fail_reason: "source_unavailable", fail_detail: { span_id: ref.span_id } };
    }
    if (span.span_id !== undefined && span.span_id !== ref.span_id) {
      return { source_verified: false, book_value: null, material_eligible: false, fail_reason: "source_unavailable", fail_detail: { span_id: ref.span_id, returned: span.span_id } };
    }
    if (isNonEmptyStr(span.book_version_id) && span.book_version_id !== request.book_version_id) {
      return { source_verified: false, book_value: null, material_eligible: false, fail_reason: "version_mismatch", fail_detail: { span_id: ref.span_id, span_version: span.book_version_id } };
    }
    if (ref.text_hash !== null && span.text_hash !== ref.text_hash) {
      return { source_verified: false, book_value: null, material_eligible: false, fail_reason: "source_hash_mismatch", fail_detail: { span_id: ref.span_id, expected: ref.text_hash, actual: span.text_hash ?? null } };
    }
  }
  const bv = validateBookValue(c);
  if (bv.score === null) {
    return {
      source_verified: true,
      book_value: null,
      material_eligible: false,
      fail_reason: "no_book_value_score",
      fail_detail: { note: "书内依据不足，不评分/不推荐（PRD :267）" },
    };
  }
  return { source_verified: true, book_value: bv, material_eligible: true, fail_reason: null, fail_detail: null };
}

/**
 * 逐候选过质量门（顺序 = PRD :263）并算出两层所需的一切。
 *
 * 返回 `{candidates, excluded, constraints}`；不抛错的分支一律**记录原因**，不静默丢。
 */
export async function runQualityGate({
  request,
  capabilities,
  boundary,
  feedback,
  evidenceIndex,
  policyConfig,
  budget,
  now,
}) {
  const excluded = [];
  const evaluated = [];
  const seen = new Set();
  const dropped_dimensions = [];
  const unknown_dimensions = [];
  const retrieval_hits_ignored_for_baseline = [];

  for (let i = 0; i < request.candidates.length; i++) {
    const c = normalizeCandidate(request.candidates[i], i);
    if (seen.has(c.candidate_id)) {
      throw failed("INVALID_COMBINATION", `candidate_id 重复：${c.candidate_id}`);
    }
    seen.add(c.candidate_id);

    const rec = {
      candidate: c,
      excluded_reason: null,
      excluded_detail: null,
      material_eligible: false,
      condensation_safe: false,
      source_verified: false,
      book_value: null,
      scores: null,
      exact: null,
      known: [],
      soft: [],
      dimension_evidence: {},
      evidence_refs: [],
      overview_paragraph: null,
    };

    // ① 引用有效性 / ② 书版本 —— 先判版本（剧透与版本都是"能不能引用"的前置）。
    if (!isNonEmptyStr(c.book_version_id) || c.book_version_id !== request.book_version_id) {
      rec.excluded_reason = "version_mismatch";
      rec.excluded_detail = { candidate_version: c.book_version_id, request_version: request.book_version_id };
      excluded.push({ candidate_id: c.candidate_id, reason_code: rec.excluded_reason, detail: rec.excluded_detail });
      evaluated.push(rec);
      continue;
    }

    // ③ 剧透边界（硬约束；不可核验 ⇒ 不推荐，也不猜）。
    if (boundary.mode === "through_section") {
      const byOrder = boundary.through_section_order !== null && c.section_order !== null;
      const byId = boundary.through_section_id !== null && c.section_id !== null;
      if (!byOrder && !byId) {
        rec.excluded_reason = "reading_boundary_unverifiable";
        rec.excluded_detail = { section_id: c.section_id, section_order: c.section_order };
        excluded.push({ candidate_id: c.candidate_id, reason_code: rec.excluded_reason, detail: rec.excluded_detail });
        evaluated.push(rec);
        continue;
      }
      const outside = byOrder
        ? c.section_order > boundary.through_section_order
        : c.section_id !== boundary.through_section_id;
      if (outside) {
        rec.excluded_reason = "outside_reading_boundary";
        rec.excluded_detail = { section_id: c.section_id, section_order: c.section_order };
        excluded.push({ candidate_id: c.candidate_id, reason_code: rec.excluded_reason, detail: rec.excluded_detail });
        evaluated.push(rec);
        continue;
      }
    }

    // ④ 用户明确排除（两层共用硬约束）。
    //    仍要探测「本来是否有可信书内材料」：否则「全部候选被明确约束排除 ⇒ items=[]
    //    且给 no_eligible_reason」（PRD :971）会被错判成整体弃权。
    const hit = feedback.applied.find((f) => feedbackExcludes(f, c));
    if (hit) {
      const probe = await verifySourceAndBookValue(c, capabilities, request);
      rec.excluded_reason = "user_excluded";
      rec.excluded_detail = { feedback_id: hit.feedback_id, feedback_type: hit.feedback_type, feedback_scope: hit.feedback_scope };
      rec.condensation_safe = probe.source_verified; // 内容本身不越界，只是本次不推荐
      rec.source_verified = probe.source_verified;
      rec.book_value = probe.book_value;
      rec.material_eligible = probe.material_eligible;
      if (probe.fail_reason === "insufficient_book_evidence" && probe.fail_detail.retrieval_hits > 0) {
        retrieval_hits_ignored_for_baseline.push({ candidate_id: c.candidate_id, hits: probe.fail_detail.retrieval_hits });
      }
      excluded.push({ candidate_id: c.candidate_id, reason_code: rec.excluded_reason, detail: rec.excluded_detail });
      evaluated.push(rec);
      continue;
    }

    // ⑤ 来源核验 + ⑥ B（书本价值）：书内依据不足 ⇒ 不评分/不推荐（不是给 0）。
    const probe = await verifySourceAndBookValue(c, capabilities, request);
    rec.source_verified = probe.source_verified;
    if (probe.fail_reason !== null) {
      rec.excluded_reason = probe.fail_reason;
      rec.excluded_detail = probe.fail_detail;
      if (probe.fail_reason === "insufficient_book_evidence" && probe.fail_detail.retrieval_hits > 0) {
        retrieval_hits_ignored_for_baseline.push({ candidate_id: c.candidate_id, hits: probe.fail_detail.retrieval_hits });
      }
      excluded.push({ candidate_id: c.candidate_id, reason_code: rec.excluded_reason, detail: rec.excluded_detail });
      evaluated.push(rec);
      continue;
    }
    rec.condensation_safe = true;
    rec.book_value = probe.book_value;
    rec.material_eligible = true;

    // ⑦ 时间上限（硬约束）。
    if (budget.max_minutes !== null && typeof c.estimated_minutes === "number" &&
        c.estimated_minutes > budget.max_minutes) {
      rec.excluded_reason = "outside_time_budget";
      rec.excluded_detail = { estimated_minutes: c.estimated_minutes, max_minutes: budget.max_minutes };
      excluded.push({ candidate_id: c.candidate_id, reason_code: rec.excluded_reason, detail: rec.excluded_detail });
      evaluated.push(rec);
      continue;
    }

    // ⑧ 个人维度（G/T 的额外硬要求 + 证据门）。
    const dims = { R: null, G: null, T: null };
    const softDims = [];
    for (const d of PERSONAL_DIMENSIONS) {
      const raw = c.personal[d] ?? null;
      if (d === "G" && raw !== null && (raw.score ?? null) !== null) {
        if (!isArr(raw.book_premise_refs) || raw.book_premise_refs.length === 0) {
          throw failed("G_WITHOUT_BOOK_PREMISE", `候选 ${c.candidate_id} 的 G 有分值但没有书内前提（PRD :269）`);
        }
        const refs = raw.evidence_refs ?? [];
        const inferredFromEmpty =
          raw.inferred_from === "empty_knowledge_base" ||
          (isArr(refs) && refs.length === 0);
        if (inferredFromEmpty) {
          throw failed(
            "G_FROM_EMPTY_KNOWLEDGE_BASE",
            `候选 ${c.candidate_id} 的 G 从「知识库为空」推断（PRD :269 明令禁止）`,
          );
        }
        for (const ref of refs) {
          const entry = evidenceIndex.byRef.get(ref);
          if (entry && entry.inferred_from === "empty_knowledge_base") {
            throw failed(
              "G_FROM_EMPTY_KNOWLEDGE_BASE",
              `候选 ${c.candidate_id} 的 G 依据 ${ref} 来自「知识库为空」`,
            );
          }
        }
      }
      if (d === "T" && raw !== null && (raw.score ?? null) !== null) {
        if (!isNonEmptyStr(raw.user_judgment_ref)) {
          throw failed("T_WITHOUT_EXPRESSED_JUDGMENT", `候选 ${c.candidate_id} 的 T 有分值但没有用户已表达判断`);
        }
        const jEntry = evidenceIndex.byRef.get(raw.user_judgment_ref);
        if (!jEntry || jEntry.origin !== "user") {
          throw failed(
            "T_WITHOUT_EXPRESSED_JUDGMENT",
            `候选 ${c.candidate_id} 的 T 判断依据 ${raw.user_judgment_ref} 不是真实用户来源`,
          );
        }
        if (!isArr(raw.book_conflict_refs) || raw.book_conflict_refs.length === 0) {
          throw failed("T_WITHOUT_BOOK_CONFLICT", `候选 ${c.candidate_id} 的 T 有分值但没有书内冲突/边界`);
        }
      }
      const res = await resolveDimensionEvidence({
        candidate_id: c.candidate_id,
        dimension: d,
        dim: raw,
        evidenceIndex,
        capabilities,
        now,
      });
      if (res.usable) {
        // PRD :269「G 须有**具体表现**和书内前提」：只有 explicit_preference / ai_hypothesis
        // 支撑的 G 不算具体表现（偏好不是缺口证据，AI 假设更不是）。
        if (d === "G") {
          const hasObserved = res.evidence_refs.some((ref) => {
            const entry = evidenceIndex.byRef.get(ref);
            return entry && entry.kind === "observed_performance";
          });
          if (!hasObserved) {
            throw failed(
              "G_WITHOUT_OBSERVED_PERFORMANCE",
              `候选 ${c.candidate_id} 的 G 有分值，但没有任何「具体表现」证据（PRD :269）`,
              { evidence_refs: res.evidence_refs },
            );
          }
        }
        dims[d] = raw.score;
        rec.dimension_evidence[d] = {
          score: raw.score,
          reason: raw.reason,
          evidence_refs: res.evidence_refs,
        };
        rec.evidence_refs.push(...res.evidence_refs);
        if (res.soft) softDims.push(d);
      } else if (res.drop_reason !== "unknown") {
        dropped_dimensions.push({
          candidate_id: c.candidate_id,
          dimension: d,
          reason: res.drop_reason,
          reasons: res.reasons,
        });
      } else {
        unknown_dimensions.push({ candidate_id: c.candidate_id, dimension: d });
      }
    }

    const scored = scoreCandidate({
      b: rec.book_value.score,
      dimensions: dims,
      weights: policyConfig.weights,
      enabled_dimensions: policyConfig.enabled_dimensions,
      lambda_cap: policyConfig.lambda_cap,
      soft_dimensions: softDims,
    });
    rec.scores = scored.scores;
    rec.exact = scored.exact;
    rec.known = scored.known;
    rec.soft = scored.soft;
    rec.evidence_refs = [...new Set(rec.evidence_refs)];
    evaluated.push(rec);
  }

  return {
    evaluated,
    excluded,
    dropped_dimensions,
    unknown_dimensions,
    retrieval_hits_ignored_for_baseline,
  };
}

// --------------------------------------------------------------------------- //
// 6. 两层排序与预算内选择（PRD :282）
// --------------------------------------------------------------------------- //
function cmpStrings(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function sectionOrderOf(rec) {
  const o = rec.candidate.section_order;
  return isInt(o) ? o : Number.MAX_SAFE_INTEGER;
}

/** 第一层：按 B 降序 → 章节阅读顺序 → 稳定 candidate_id（PRD :282）。 */
export function sortBookLayer(recs) {
  return [...recs].sort((x, y) => {
    if (x.book_value.score !== y.book_value.score) return y.book_value.score - x.book_value.score;
    const ox = sectionOrderOf(x);
    const oy = sectionOrderOf(y);
    if (ox !== oy) return ox - oy;
    return cmpStrings(x.candidate.candidate_id, y.candidate.candidate_id);
  });
}

/** 第二层：按 S 降序（同分差 ≤1e−9 先比 B）→ 章节顺序 → candidate_id。 */
export function sortPersonalizedLayer(recs) {
  return [...recs].sort((x, y) => {
    const sx = x.scores.S;
    const sy = y.scores.S;
    const tied = sx === sy || Math.abs(sx - sy) <= 1e-9;
    if (!tied) return sy - sx;
    if (x.scores.B !== y.scores.B) return y.scores.B - x.scores.B;
    const ox = sectionOrderOf(x);
    const oy = sectionOrderOf(y);
    if (ox !== oy) return ox - oy;
    return cmpStrings(x.candidate.candidate_id, y.candidate.candidate_id);
  });
}

/**
 * 预算内选择：先保章节多样性（每章先取 1 个），再按序补齐（每章最多 2 个）；
 * 时间预算在**排序后**执行（PRD :282），实际取舍逐条记录。
 */
export function selectWithBudget(sorted, { limit, maxMinutes }) {
  const selected = [];
  const tradeoffs = { diversity_deferred: [], limit_excluded: [], time_excluded: [] };
  const perSection = new Map();
  let minutes = 0;
  const used = new Set();

  const canTake = (rec) => {
    if (selected.length >= limit) return false;
    const m = typeof rec.candidate.estimated_minutes === "number" ? rec.candidate.estimated_minutes : 0;
    if (maxMinutes !== null && minutes + m > maxMinutes) return false;
    return true;
  };

  for (const pass of [1, 2]) {
    for (const rec of sorted) {
      if (used.has(rec.candidate.candidate_id)) continue;
      const sid = rec.candidate.section_id ?? null;
      const count = sid === null ? 0 : perSection.get(sid) ?? 0;
      if (pass === 1 && count >= 1) {
        tradeoffs.diversity_deferred.push(rec.candidate.candidate_id);
        continue;
      }
      if (pass === 2 && count >= 2) {
        tradeoffs.diversity_deferred.push(rec.candidate.candidate_id);
        continue;
      }
      if (selected.length >= limit) {
        tradeoffs.limit_excluded.push(rec.candidate.candidate_id);
        continue;
      }
      const m = typeof rec.candidate.estimated_minutes === "number" ? rec.candidate.estimated_minutes : 0;
      if (maxMinutes !== null && minutes + m > maxMinutes) {
        tradeoffs.time_excluded.push(rec.candidate.candidate_id);
        continue;
      }
      selected.push(rec);
      used.add(rec.candidate.candidate_id);
      minutes += m;
      if (sid !== null) perSection.set(sid, count + 1);
    }
    if (selected.length >= limit) break;
  }
  return { selected, tradeoffs, minutes_used: minutes };
}

// --------------------------------------------------------------------------- //
// 7. 第一层浓缩（有来源；跨章主张列分开出处）
// --------------------------------------------------------------------------- //
function normalizeParagraph(raw, where) {
  if (!isMap(raw)) throw failed("INVALID_STRUCTURE", `${where} 必须是 {text, source_refs} 映射`);
  if (!isNonEmptyStr(raw.text)) {
    throw failed("CONDENSATION_WITHOUT_SOURCE", `${where}.text 必须是非空字符串`);
  }
  if (!isArr(raw.source_refs) || raw.source_refs.length === 0) {
    throw failed("CONDENSATION_WITHOUT_SOURCE", `${where} 没有来源（PRD :971「浓缩无来源」是结构错误）`);
  }
  const refs = raw.source_refs.map((r) => {
    if (isNonEmptyStr(r)) return r;
    if (isMap(r) && isNonEmptyStr(r.span_id)) return r.span_id;
    throw failed("INVALID_STRUCTURE", `${where}.source_refs 必须是 span_id 字符串或 {span_id}`);
  });
  return { text: raw.text, source_refs: [...new Set(refs)], cross_section: raw.cross_section === true };
}

/**
 * 组装 `overview_paragraphs`：
 *   ① 候选自带 `overview_paragraph`（逐章分析产物，确定性路径）；
 *   ② 否则由 `generateStructured` 依**通过剧透/版本门**的候选合成（PRD :930 能力之一）；
 *   ③ 两者都没有 ⇒ 由 `coverage_snapshot.book_summary` 兜底；
 *   ④ 仍没有 ⇒ 返回 `null`（调用方决定整体弃权，不伪造）。
 *
 * 每一段都必须有**可核验**来源；跨章段落必须列**分开**的出处（PRD :267）。
 */
export async function buildOverviewParagraphs({
  condensationCandidates,
  request,
  capabilities,
  budget,
  maxParagraphs,
}) {
  const collected = [];
  for (const rec of condensationCandidates) {
    const raw = rec.candidate.overview_paragraph;
    if (raw === null || raw === undefined) continue;
    collected.push({ paragraph: normalizeParagraph(raw, `候选 ${rec.candidate.candidate_id}.overview_paragraph`), candidate_id: rec.candidate.candidate_id });
  }

  if (collected.length === 0 && condensationCandidates.length > 0) {
    // 走结构化生成：只喂**通过剧透/版本门**的材料，避免越界内容进入上下文。
    const payload = condensationCandidates.map((rec) => ({
      candidate_id: rec.candidate.candidate_id,
      section_id: rec.candidate.section_id,
      section_order: rec.candidate.section_order,
      B: rec.book_value === null ? null : rec.book_value.score,
      reason: rec.book_value === null ? null : rec.book_value.reason,
      source_refs: rec.candidate.book_evidence_refs.map((r) => r.span_id),
    }));
    let generated = null;
    try {
      generated = await capabilities.generateStructured(
        {
          task: "recommendation_overview",
          schema: { overview_paragraphs: "[{text, source_refs, cross_section?}]" },
          items: payload,
        },
        { run_id: request.run_id },
      );
    } catch (err) {
      throw blocked("MODEL_FAILED", `generateStructured 失败：${err?.message ?? err}`);
    }
    const paras = isMap(generated) ? generated.overview_paragraphs : null;
    if (!isArr(paras) || paras.length === 0) {
      throw failed(
        "CONDENSATION_WITHOUT_SOURCE",
        "generateStructured 未给出任何有来源的浓缩段落（PRD :971 结构错误：book_guide 为空 / 浓缩无来源）",
      );
    }
    for (let i = 0; i < paras.length; i++) {
      collected.push({ paragraph: normalizeParagraph(paras[i], `generateStructured.overview_paragraphs[${i}]`), candidate_id: null });
    }
  }

  if (collected.length === 0) {
    const bs = request.coverage_snapshot.book_summary;
    if (isMap(bs) && isArr(bs.paragraphs) && bs.paragraphs.length > 0) {
      for (let i = 0; i < bs.paragraphs.length; i++) {
        collected.push({ paragraph: normalizeParagraph(bs.paragraphs[i], `coverage_snapshot.book_summary.paragraphs[${i}]`), candidate_id: null });
      }
    }
  }

  if (collected.length === 0) return null;

  const limited = collected.slice(0, maxParagraphs);
  const out = [];
  const allRefs = [];
  for (const { paragraph } of limited) {
    // 每一段逐 ref 核验（可读 + 版本一致）；跨章必须列**分开**的出处。
    const sections = new Set();
    for (const spanId of paragraph.source_refs) {
      const span = await readSpan(capabilities, spanId, paragraph.text.slice(0, 24));
      if (!isMap(span) || span.ok !== true) {
        throw failed("CONDENSATION_WITHOUT_SOURCE", `浓缩段落引用的 span 不可读：${spanId}`);
      }
      if (isNonEmptyStr(span.book_version_id) && span.book_version_id !== request.book_version_id) {
        throw failed("CONDENSATION_WITHOUT_SOURCE", `浓缩段落引用的 span 属于别的书版本：${spanId}`);
      }
      if (isNonEmptyStr(span.section_id)) sections.add(span.section_id);
    }
    if (paragraph.cross_section && sections.size < 2) {
      throw failed(
        "CROSS_SECTION_PARAGRAPH_SOURCES_MIXED",
        "跨章主张必须列出**分开**的出处（PRD :267），该段落只解析出 1 个章节",
        { text: paragraph.text, sections: [...sections] },
      );
    }
    out.push(paragraph.text);
    allRefs.push(...paragraph.source_refs);
  }
  return { paragraphs: out, source_refs: [...new Set(allRefs)] };
}

// --------------------------------------------------------------------------- //
// 8. 结果组装与结构自检
// --------------------------------------------------------------------------- //
/**
 * `selected_items` = 两层 items 的**去重并集**，每项标 `book` / `personalized` / `both`
 * （PRD :971）。**它不是第三层权威结果**，因此**不进 `RecommendationResult`**（冻结裁定①），
 * 由本函数显式导出，归 `RecommendationRun.selected_items`（:469）。
 */
export function computeSelectedItems(bookGuide, personalizedItems) {
  const bookItems = isMap(bookGuide) && isArr(bookGuide.items) ? bookGuide.items : [];
  const personalItems = isArr(personalizedItems) ? personalizedItems : [];
  const personalIds = new Set(personalItems.map((i) => i.candidate_id));
  const out = [];
  const seen = new Set();
  for (const it of bookItems) {
    if (!isMap(it) || !isNonEmptyStr(it.candidate_id)) continue;
    if (seen.has(it.candidate_id)) continue;
    seen.add(it.candidate_id);
    out.push({ candidate_id: it.candidate_id, layer: personalIds.has(it.candidate_id) ? "both" : "book" });
  }
  for (const it of personalItems) {
    if (!isMap(it) || !isNonEmptyStr(it.candidate_id)) continue;
    if (seen.has(it.candidate_id)) continue;
    seen.add(it.candidate_id);
    out.push({ candidate_id: it.candidate_id, layer: "personalized" });
  }
  return out;
}

/**
 * 结构自检（PRD :971）：
 *   · 顶层**恰好 7 键**；
 *   · `insufficient_evidence` ⇒ book_guide=null、personalized_items=[]、status=none；
 *   · `items` ⇒ book_guide 是有来源的浓缩（`overview_paragraphs` 非空、`source_refs` 非空）；
 *   · `items=[]` 却没有真实 `no_eligible_reason` ⇒ **结构错误**。
 */
export function assertResultShape(result) {
  if (!isMap(result)) throw failed("INVALID_STRUCTURE", "RecommendationResult 必须是映射");
  const keys = Object.keys(result).sort();
  const want = [...RESULT_KEYS].sort();
  if (keys.length !== want.length || keys.some((k, i) => k !== want[i])) {
    throw failed("RESULT_KEY_MISMATCH", `RecommendationResult 顶层键必须恰好是 7 键，得到 ${keys.join(",")}`, { keys });
  }
  if (!RECOMMENDATION_OUTCOMES.includes(result.outcome)) {
    throw failed("INVALID_ENUM", `outcome 只能是 ${RECOMMENDATION_OUTCOMES.join(" / ")}`);
  }
  if (!PERSONALIZATION_STATUSES.includes(result.personalization_status)) {
    throw failed("INVALID_ENUM", "personalization_status 只能是 none / limited / available");
  }
  if (!isArr(result.exclusions)) throw failed("INVALID_STRUCTURE", "exclusions 必须是数组");
  if (!isMap(result.constraints_report)) throw failed("INVALID_STRUCTURE", "constraints_report 必须是映射");
  if (!isMap(result.policy_and_model_metadata)) {
    throw failed("INVALID_STRUCTURE", "policy_and_model_metadata 必须是映射");
  }
  if (result.outcome === "insufficient_evidence") {
    if (result.book_guide !== null) throw failed("INVALID_COMBINATION", "insufficient_evidence 时 book_guide 必须为 null");
    if (!isArr(result.personalized_items) || result.personalized_items.length !== 0) {
      throw failed("INVALID_COMBINATION", "insufficient_evidence 时 personalized_items 必须为空");
    }
    if (result.personalization_status !== "none") {
      throw failed("INVALID_COMBINATION", "insufficient_evidence 时 personalization_status 必须是 none");
    }
    return { ok: true };
  }
  const guide = result.book_guide;
  if (!isMap(guide)) {
    throw failed("EMPTY_BOOK_GUIDE", "outcome=items 必须有含来源的 book_guide（空背景不是弃权理由）");
  }
  if (!isArr(guide.overview_paragraphs) || guide.overview_paragraphs.length === 0 ||
      guide.overview_paragraphs.some((p) => !isNonEmptyStr(p))) {
    throw failed("EMPTY_BOOK_GUIDE", "book_guide.overview_paragraphs 必须是 1 至数段非空浓缩");
  }
  if (!isArr(guide.source_refs) || guide.source_refs.length === 0) {
    throw failed("CONDENSATION_WITHOUT_SOURCE", "book_guide.source_refs 不得为空（浓缩必须有来源）");
  }
  if (!isArr(guide.items)) throw failed("INVALID_STRUCTURE", "book_guide.items 必须是数组");
  if (guide.items.length === 0 && !isNonEmptyStr(guide.no_eligible_reason)) {
    throw failed(
      "ITEMS_WITHOUT_NO_ELIGIBLE_REASON",
      "items 为空却没有真实 no_eligible_reason ⇒ 结构错误，不能映射成 recommended（PRD :971）",
    );
  }
  if (!isArr(result.personalized_items)) throw failed("INVALID_STRUCTURE", "personalized_items 必须是数组");
  if (result.personalized_items.length === 0 && result.personalization_status !== "none") {
    throw failed("INVALID_COMBINATION", "personalized_items 为空时 status 必须是 none");
  }
  for (const it of result.personalized_items) {
    const ik = Object.keys(it).sort();
    const iw = [...PERSONALIZED_ITEM_KEYS].sort();
    if (ik.length !== iw.length || ik.some((k, i) => k !== iw[i])) {
      throw failed("INVALID_STRUCTURE", `personalized_items 每项必须恰好 6 键，得到 ${ik.join(",")}`);
    }
    const sk = Object.keys(it.scores).sort();
    const sw = [...SCORE_KEYS].sort();
    if (sk.length !== sw.length || sk.some((k, i) => k !== sw[i])) {
      throw failed("INVALID_STRUCTURE", `scores 必须恰好 10 键（B/R/G/T/W/C/q/lambda/U/S），得到 ${sk.join(",")}`);
    }
  }
  return { ok: true };
}

/** `personalization_status`（PRD :280）：空 ⇒ none；任一选中项 C<1 或 q=0.5 ⇒ limited；否则 available。 */
export function derivePersonalizationStatus(personalizedItems) {
  if (!isArr(personalizedItems) || personalizedItems.length === 0) return "none";
  for (const it of personalizedItems) {
    const C = it.scores.C;
    const q = it.scores.q;
    if (typeof C !== "number" || typeof q !== "number") return "limited";
    if (C < 1 || q === 0.5) return "limited";
  }
  return "available";
}

/** 输入指纹：**不可变**；复算创建新 run_id（PRD :469 / 规范 :100）。run_id 不参与指纹。 */
export function recommendationInputFingerprint(request) {
  const canonical = {
    schema_version: request.schema_version,
    book_version_id: request.book_version_id,
    coverage_snapshot: request.coverage_snapshot,
    goal: request.goal ?? null,
    allowed_profile_refs_and_short_evidence: request.allowed_profile_refs_and_short_evidence ?? [],
    note_ids_and_hashes: request.note_ids_and_hashes,
    candidates: request.candidates,
    reading_boundary: request.reading_boundary,
    recent_feedback: request.recent_feedback,
    policy_config: request.policy_config ?? null,
    budget: request.budget ?? null,
  };
  return sha256Hex(stableStringify(canonical));
}

function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (isArr(v)) return `[${v.map(stableStringify).join(",")}]`;
  const keys = Object.keys(v).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(",")}}`;
}

/** 输入清单 refs（:286「输入清单只记录引用与 hash」）。 */
export function buildInputManifestRefs(request) {
  const refs = [`book_version:${request.book_version_id}`, `run_request:${request.run_id}`];
  if (isMap(request.coverage_snapshot) && isNonEmptyStr(request.coverage_snapshot.ref)) {
    refs.push(`coverage:${request.coverage_snapshot.ref}`);
  }
  for (const n of request.note_ids_and_hashes) {
    if (isMap(n) && isNonEmptyStr(n.object_id)) refs.push(`note:${n.object_id}`);
  }
  for (const e of request.allowed_profile_refs_and_short_evidence ?? []) {
    if (isMap(e) && isNonEmptyStr(e.ref)) refs.push(`evidence:${e.ref}`);
  }
  return [...new Set(refs)];
}

// --------------------------------------------------------------------------- //
// 9. RecommendationRun 映射（PRD :469 / :964）
//    M10 阶段 2「一本书一个理解」：**同一本书一个 run，复算覆盖，revision 递增**。
// --------------------------------------------------------------------------- //
/**
 * 运行身份：**按书固定**（M10 阶段 2）。
 *
 * 为什么不再按输入指纹算（旧 `newRunId`/`beginRecompute` 的做法）：
 *   · `recommendation_feedback.run_id` 是**必填非空**（PRD :471 / 规范 §2）—— 反馈按 run_id 指向
 *     「我这条反馈是针对哪次理解」。若每次复算都换 run_id，**历史反馈整体断链**；
 *   · 同一本书会堆出多条 run 笔记（M9 之前就是这样，真实库里留了 13 条），
 *     而「当前是哪一次」只能靠 updated_at 排序去猜。
 *
 * 现在：同一本书 ⇒ 同一个 `run_id` ⇒ **同一条笔记**；复算**覆盖**它，`revision` 递增。
 * 代价（已向用户披露并确认）：一本书**不再保留历史理解**，只有最新一份。
 *
 * M13：喂进来的必须是**内容身份** `book_version_id`（`bv_` + 各章正文 sha256 前 16 位），
 * 由**引擎**算好给出来（`/analyze-chapter` 的返回值，或 `/book-identity?path=`）。
 * **插件不再自己算任何身份哈希**：原先这里收的是 `path_hash8 = sha1(书路径)[:8]`，
 * 书一挪位置/改名身份就变 ⇒ 「同一本书」会多出一条理解笔记（PRD/规范里那条已知债）。
 * 换成内容身份后，书挪位置/改名 ⇒ 身份不变 ⇒ run_id 不变 ⇒ 还是那一条笔记。
 */
export function bookRunId({ book_version_id } = {}) {
  if (!isNonEmptyStr(book_version_id)) {
    throw failed("MISSING_REQUIRED",
      "bookRunId 需要 book_version_id（一本书一个理解：运行身份按书的内容固定，路径不参与）");
  }
  return `rr_${sha256Hex(`book|${book_version_id}`).slice(0, 24)}`;
}

/**
 * 书籍信息笔记的 vault 相对路径：`书籍/<书名>｜<作者>/书籍信息.md`（模板使用说明 §2 的表）。
 *
 * 标题/作者来自**书里的元数据**，可能含 `/`、`\`、`..` 等；直接拼进路径会写到别处。
 * 这里把路径分隔符与 `..` 一律换成 `_`（**不改写书名本身**，只改目录名里的危险字符），
 * 并把整体长度压到 80 字符以内（超长目录名在 macOS 上会失败）。
 */
export function bookInfoRel({ title, author } = {}) {
  if (!isNonEmptyStr(title)) throw failed("MISSING_REQUIRED", "bookInfoRel 需要书名");
  if (!isNonEmptyStr(author)) throw failed("MISSING_REQUIRED", "bookInfoRel 需要作者");
  const safe = (x) => String(x).replace(/[/\\]/g, "_").replace(/\.\./g, "_").replace(/\u0000/g, "_").trim();
  const dir = `${safe(title)}｜${safe(author)}`.slice(0, 80);
  return `书籍/${dir}/书籍信息.md`;
}

/**
 * 4a：书籍信息笔记（`object_type: book`）。
 *
 * 诚实边界（这几条是刻意的，不是没做完）：
 *   · `external_master.status` **恒为 `unverified` / `outcome: not_checked`**：本次分析
 *     只读了书本身，**没有**去外部主库核对过。除非真的核过，不得写 verified/linked
 *     （PRD §8.5 的 7 种合法组合由 M1 schema 兜底）。
 *   · `content_hash` 写 **null**：引擎没有给出「整书原 bytes 的 sha256」，
 *     schema 明确说「未知来源不得编造，可 null」。**不拿 book_version_id 冒充它**
 *     （那是章节内容寻址的短 id，语义不同）。
 *   · `parser_version` / `normalization_version` 同理写 null（引擎没报这两个版本）。
 *   · `book_version_id` 用引擎给的真值 —— 这正是「同一版本不重复写」的判据。
 *   · M13 起 `book_id` 也用**引擎给的内容身份**（`content_id`，= `book_version_id` 去掉 `bv_`
 *     前缀的那 16 位）：**插件不再自己按目录名算 book_id**。原先 `book_id = sha1(目录名)[:16]`，
 *     两本同名不同内容的书会撞成同一个 `id`，而 `id` 又是笔记的主键（规范 §2 交叉规则：
 *     `id` 必须等于 `book_id`）⇒ 后写的一本会顶掉前一本。
 */
export function buildBookInfoNote({ book_id, title, author, book_version_id, source_path, content_id } = {}, ctx = {}) {
  if (!isNonEmptyStr(book_id)) throw failed("MISSING_REQUIRED", "书籍信息需要 book_id（= 引擎给的内容身份 content_id）");
  if (!isNonEmptyStr(title)) throw failed("MISSING_REQUIRED", "书籍信息需要书名（引擎没给出就不写，不编造）");
  if (!isNonEmptyStr(author)) {
    throw failed("MISSING_REQUIRED",
      "书籍信息需要作者：book.author 是必填且不得为空，引擎没给出作者时**不编造**、不写这条笔记");
  }
  if (!isNonEmptyStr(book_version_id)) throw failed("MISSING_REQUIRED", "书籍信息需要 book_version_id");
  if (!isNonEmptyStr(source_path)) throw failed("MISSING_REQUIRED", "书籍信息需要来源路径（original_epub 的 locator）");
  if (!isNonEmptyStr(content_id)) throw failed("MISSING_REQUIRED", "书籍信息需要 content_id（dedup_check_ref）");
  const created = ctx.now ?? new Date().toISOString();
  const data = {
    schema_version: SCHEMA_VERSION,
    object_type: "book",
    id: book_id,
    revision: ctx.revision ?? 1,
    title,
    tags: ["reading"],
    scope: "reading",
    knowledge_status: "active",
    created_at: ctx.created_at ?? created,
    updated_at: created,
    origin: "ai_inference",
    confirmation: "unconfirmed",
    confirmation_evidence: null,
    book_evidence: [],
    session_evidence: [],
    external_master: {
      status: "unverified",
      outcome: "not_checked",
      check_id: null,
      scope_refs: [],
      checked_at: null,
      authorization_revision: null,
      candidate_refs: [],
      ref: null,
    },
    dedup_check_ref: `dedup_${content_id}`,
    book_id,
    author,
    book_version_id,
    content_hash: null,
    parser_version: null,
    normalization_version: null,
    source_assets: [{
      source_id: `epub:${book_id}`,
      source_kind: "original_epub",
      locator: { source_handle: source_path },
      content_hash: null,
      availability: "available",
      export_policy: "reference_only",
    }],
    source_page_ref: null,
  };
  const check = validateNote(data, { mode: "formal", objectType: "book", domain: BOOK_DOMAIN });
  if (!check.ok) {
    throw failed("BOOK_SELF_CHECK_FAILED",
      `书籍信息笔记未通过 M1 validateNote(formal)：${check.errors[0]?.message ?? ""}`,
      { errors: check.errors });
  }
  return { ok: true, data, errors: [] };
}

// --------------------------------------------------------------------------- //
// M14 · 采集：一次真实互动 → reading_evidence / understanding_observation
// --------------------------------------------------------------------------- //

/** 主题（文件名里的人类可读部分）最长多少字符。 */
export const EVIDENCE_TOPIC_MAX = 40;

/**
 * 主题只做**人类可读**，不承担身份。把路径分隔符、`..`、`｜`（文件名分隔符）换成 `_`，
 * 免得主题里的字符把文件名结构弄坏（同 `bookInfoRel` 的处理）。
 */
export function safeEvidenceTopic(x) {
  const s = String(x ?? "")
    .replace(/[/\\]/g, "_")
    .replace(/\.\./g, "_")
    .replace(/\u0000/g, "_")
    .replace(/｜/g, "_")
    .replace(/[\r\n\t]/g, " ")
    .trim();
  return s.slice(0, EVIDENCE_TOPIC_MAX);
}

/**
 * **互动的身份键**（M14 幂等的地基）。
 *
 * 只用「这次互动是什么」派生 —— 书的内容身份 + span + 这条观察的 kind/dimension + 用户原话 + 概念：
 *   · **不含时间**：同一互动换个时刻重放，仍是同一个键 ⇒ 幂等命中、不重复写；
 *   · **不含路径**：书改名/挪位置 ⇒ 键不变（M13 内容寻址，3f）；
 *   · 同一次互动派生 reading_evidence 与 understanding_observation 两个 id，前缀不同、互不顶替。
 */
export function evidenceInteractionKey(fields = {}) {
  const canon = JSON.stringify({
    book_version_id: fields.book_version_id ?? null,
    span_id: fields.span_id ?? null,
    kind: fields.kind ?? null,
    dimension: fields.dimension ?? null,
    statement: fields.statement ?? null,
    concept_refs: isArr(fields.concept_refs) ? fields.concept_refs : [],
  });
  return sha256Hex(canon);
}

export const readingEvidenceId = (key) => `re_${String(key).slice(0, 16)}`;
export const understandingObservationId = (key) => `uo_${String(key).slice(0, 16)}`;

/**
 * `45-书籍/阅读背景/学习证据/<主题>｜<content_id>.md`（模板使用说明 §2 的目录 + M14 的消歧后缀）。
 *
 * 为什么带 `｜<content_id>`：`阅读背景/学习证据/` 是**平铺**目录，不同书同主题会撞名；
 * PRD `:449` 允许「同名优先按书和主题消歧，最后才加短 ID」。`content_id` 是**内容寻址**
 * 摘要（M13），不是路径派生 id。
 */
export function readingEvidenceRel({ topic, content_id } = {}) {
  const t = safeEvidenceTopic(topic);
  if (t === "") throw failed("MISSING_REQUIRED", "readingEvidenceRel 需要主题（人类可读标题）");
  if (!isNonEmptyStr(content_id)) throw failed("MISSING_REQUIRED", "readingEvidenceRel 需要 content_id（内容身份）");
  return `阅读背景/学习证据/${t}｜${content_id}.md`;
}

/** `45-书籍/理解变化/<YYYY-MM-DD> <主题>｜<content_id>.md`（模板使用说明 §2）。 */
export function understandingObservationRel({ occurred_at, topic, content_id } = {}) {
  const t = safeEvidenceTopic(topic);
  if (t === "") throw failed("MISSING_REQUIRED", "understandingObservationRel 需要主题（人类可读标题）");
  if (!isNonEmptyStr(content_id)) throw failed("MISSING_REQUIRED", "understandingObservationRel 需要 content_id（内容身份）");
  const iso = isNonEmptyStr(occurred_at) ? String(occurred_at) : new Date().toISOString();
  const day = iso.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw failed("INVALID_VALUE", `understandingObservationRel 的 occurred_at 取不出 YYYY-MM-DD：${iso}`);
  }
  return `理解变化/${day} ${t}｜${content_id}.md`;
}

/**
 * 三种归属的正文块（M14 1c / 3b）：**书中观点 / 用户判断 / AI 推演**各自独立成块，
 * 不混成一句。任一块没有真实内容时**如实写「没有」**，不留空、不用别的内容顶替。
 */
function evidenceAttributionBody({
  heading = "# 学习证据",
  lead_lines = [],
  quote, locator_lines, statement, ai_note,
  label_title = "五类证据标签（由字段派生，不是 1–5 分）",
  label_line,
  label_footer = [
    "> 标签是按《索引与模板规范》§3 从 kind / dimension / source_refs / assessment_basis /",
    "> 归属与确认状态**派生**的展示值，不另存权威评分字段；strength / confidence 与这五类正交。",
  ],
} = {}) {
  const lines = [];
  lines.push(heading, "");
  for (const l of lead_lines) lines.push(l);
  if (lead_lines.length > 0) lines.push("");
  lines.push("## 书中观点（逐字原文，不是用户的话、不是 AI 推演）", "");
  if (isNonEmptyStr(quote)) {
    lines.push(`> ${String(quote).replace(/\n/g, "\n> ")}`, "");
  } else {
    lines.push("> 【本次没有取到逐字原文】", "");
  }

  lines.push("");
  lines.push("## 用户判断（用户自己的话）", "");
  lines.push(isNonEmptyStr(statement) ? `> ${String(statement).replace(/\n/g, "\n> ")}` : "> 【本次没有用户判断】", "");
  lines.push("## AI 推演（未确认，**不是用户事实**）", "");
  lines.push(isNonEmptyStr(ai_note)
    ? String(ai_note)
    : "【本次没有 AI 推演：这条来自用户自己的判断】", "");
  lines.push("", "## 来源校验详情", "");
  for (const l of locator_lines ?? []) lines.push(`- ${l}`);
  lines.push("", `### ${label_title}`, "");
  lines.push(`- ${label_line}`, "");
  for (const l of label_footer) lines.push(l);
  return lines.join("\n") + "\n";
}

function evidenceBaseData({ object_type, id, title, content_id }, ctx = {}) {
  const now = ctx.now ?? new Date().toISOString();
  return {
    schema_version: SCHEMA_VERSION,
    object_type,
    id,
    revision: Number.isInteger(ctx.revision) && ctx.revision > 0 ? ctx.revision : 1,
    title,
    tags: ["reading", "evidence"],
    scope: "reading",
    knowledge_status: "active",
    created_at: ctx.created_at ?? now,
    updated_at: now,
    origin: null,
    confirmation: "unconfirmed",
    confirmation_evidence: null,
    book_evidence: [],
    session_evidence: [],
    external_master: {
      status: "unverified",
      outcome: "not_checked",
      check_id: null,
      scope_refs: [],
      checked_at: null,
      authorization_revision: null,
      candidate_refs: [],
      ref: null,
    },
    dedup_check_ref: `dedup_${content_id}`,
    generated_by: { compiler: POLICY_NAME, version: POLICY_VERSION },
    relations: [],
  };
}

/**
 * 书内定位（SpanRef 数组）的**唯一一份**入参校验（M15 0b）。
 *
 * 只接受**结构合法**的 SpanRef：缺一个必填字段就拒，**不"尽力修补"** ——
 * 修补出来的定位没人能回原文核对，比没有定位更坏（会让人以为能核）。
 * `reading_evidence` 与 `understanding_observation` 共用它，避免两处各写一套判据。
 */
function normalizeBookEvidenceInput(bookEvidence) {
  const list = bookEvidence ?? [];
  if (!isArr(list)) throw failed("INVALID_STRUCTURE", "book_evidence 必须是 SpanRef 数组");
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (!isMap(e)) throw failed("INVALID_STRUCTURE", `book_evidence[${i}] 必须是 SpanRef 映射`);
    for (const k of ["book_id", "book_version_id", "section_id", "block_id", "span_id", "href"]) {
      if (!isNonEmptyStr(e[k])) {
        throw failed("MISSING_REQUIRED", `book_evidence[${i}].${k} 必须是非空字符串（不许编造定位）`);
      }
    }
    if (!isInt(e.start_codepoint) || !isInt(e.end_codepoint) || !(e.end_codepoint > e.start_codepoint)) {
      throw failed("INVALID_VALUE", `book_evidence[${i}] 的区间必须是 start<end 的整数`);
    }
    if (!isHash64(e.text_hash)) {
      throw failed("INVALID_VALUE", `book_evidence[${i}].text_hash 必须是 64 位小写十六进制`);
    }
    if (!VALUE_DOMAINS.locator_quality.includes(e.locator_quality)) {
      throw failed("INVALID_ENUM", `book_evidence[${i}].locator_quality 非法`);
    }
    if (!VALUE_DOMAINS.quote_type.includes(e.quote_type)) {
      throw failed("INVALID_ENUM", `book_evidence[${i}].quote_type 非法`);
    }
  }
  return list;
}

/**
 * 4.1：`reading_evidence` 笔记（M14 1a–1d；M15 0b 起 `book_evidence` 不再恒空）。
 *
 * 诚实边界（刻意的，不是没做完）：
 *   · `confirmation` **恒为 `unconfirmed`**：没有用户确认，不许当成已确认（1d）；
 *   · `strength=null` + `confidence.level=unknown`：**不评级**、不补 medium、不造能力分（1b）；
 *   · `book_evidence`：**有就写真的**（M15 0b 起引擎给 `href` + `block_id`）——
 *     每个 SpanRef 的必填字段都必须来自引擎；缺字段时调用方传空数组并如实写明缺什么，
 *     这里**不替它编一个**（假定位比没有定位更坏：会让人以为能回原文核对）。
 *   · `source_refs` 非空且只含真实来源：`user_action`（用户这次记录动作）+ 可选 `knowledge_note`。
 */
export function buildReadingEvidenceNote(input = {}, ctx = {}) {
  const {
    id, title, content_id, book_version_id, kind, dimension, concept_refs,
    statement, assessment_basis, source_refs, origin, label_line, quote, locator_lines, ai_note,
    book_evidence,
  } = input;
  if (!isNonEmptyStr(id)) throw failed("MISSING_REQUIRED", "reading_evidence 需要 id");
  if (!isNonEmptyStr(title)) throw failed("MISSING_REQUIRED", "reading_evidence 需要 title");
  if (!isNonEmptyStr(content_id)) throw failed("MISSING_REQUIRED", "reading_evidence 需要 content_id");
  if (!isNonEmptyStr(book_version_id)) throw failed("MISSING_REQUIRED", "reading_evidence 需要 book_version_id");
  if (!EVIDENCE_KINDS.includes(kind)) {
    throw failed("INVALID_ENUM", `reading_evidence.kind 只能是 ${EVIDENCE_KINDS.join(" / ")}，得到 ${JSON.stringify(kind)}`);
  }
  if (!isArr(source_refs) || source_refs.length === 0) {
    throw failed("MISSING_REQUIRED", "reading_evidence 的 source_refs 必须非空（只用真实来源）");
  }
  if (!isNonEmptyStr(assessment_basis)) throw failed("MISSING_REQUIRED", "reading_evidence 需要 assessment_basis");
  if (origin !== "user" && origin !== "ai_inference") {
    throw failed("INVALID_ENUM", "reading_evidence.origin 只能是 user / ai_inference（书中观点用引文块表达，不改本笔记归属）");
  }
  // 书内定位：只接受**结构合法的 SpanRef 数组**。给一个形状不对的进来就直接拒 ——
  // 不"尽力修补"，因为修补出来的定位没人能回原文核对。
  const bookEvidence = normalizeBookEvidenceInput(book_evidence);
  const now = ctx.now ?? new Date().toISOString();
  const data = {
    ...evidenceBaseData({ object_type: "reading_evidence", id, title, content_id }, ctx),
    updated_at: now,
    origin,
    concept_refs: isArr(concept_refs) ? concept_refs : [],
    kind,
    dimension: dimension ?? null,
    strength: null,
    confidence: {
      level: "unknown",
      reason: "本轮不评级：只有一次互动，给不出可校准的强度；未评级保留 unknown，不补 medium",
    },
    assessment_basis,
    valid_until: null,
    source_refs,
    book_evidence: bookEvidence,
    relations: [{ from_id: id, to_id: content_id, type: "references" }],
  };
  const body = evidenceAttributionBody({ quote, locator_lines, statement, ai_note, label_line });
  const check = validateNote(data, { mode: "formal", objectType: "reading_evidence", domain: BOOK_DOMAIN });
  if (!check.ok) {
    throw failed("EVIDENCE_SELF_CHECK_FAILED",
      `学习证据未通过 M1 validateNote(formal)：${check.errors[0]?.message ?? ""}`, { errors: check.errors });
  }
  return { ok: true, data, body, errors: [] };
}

/**
 * 4.2：`understanding_observation` 笔记（M14 1a/1c/1d）。
 *
 * `before` **恒为 null、前引用恒为空**：用户初次形成理解时**不伪造「过去的想法」**，
 * `assessment_basis` 里注明 before 未知（PRD `:495`）。
 */
export function buildUnderstandingObservationNote(input = {}, ctx = {}) {
  const {
    id, title, content_id, dimension, concept_refs, after, after_source_refs,
    assessment_basis, origin, label_line, statement, quote, locator_lines, ai_note,
    book_evidence,
  } = input;
  if (!isNonEmptyStr(id)) throw failed("MISSING_REQUIRED", "understanding_observation 需要 id");
  if (!isNonEmptyStr(title)) throw failed("MISSING_REQUIRED", "understanding_observation 需要 title");
  if (!isNonEmptyStr(content_id)) throw failed("MISSING_REQUIRED", "understanding_observation 需要 content_id");
  if (!isNonEmptyStr(after)) throw failed("MISSING_REQUIRED", "understanding_observation 的 after 必须是非空短述");
  if (!isArr(after_source_refs) || after_source_refs.length === 0) {
    throw failed("MISSING_REQUIRED", "understanding_observation 的 after_source_refs 必须非空");
  }
  if (!isArr(concept_refs) || concept_refs.length === 0) {
    throw failed("MISSING_REQUIRED", "understanding_observation 的 concept_refs 必须非空");
  }
  if (dimension === null || dimension === undefined) {
    throw failed("MISSING_REQUIRED", "understanding_observation 必填 dimension");
  }
  if (origin !== "user" && origin !== "ai_inference") {
    throw failed("INVALID_ENUM", "understanding_observation.origin 只能是 user / ai_inference");
  }
  const now = ctx.now ?? new Date().toISOString();
  const data = {
    ...evidenceBaseData({ object_type: "understanding_observation", id, title, content_id }, ctx),
    updated_at: now,
    origin,
    concept_refs,
    dimension,
    change_kind: "supplemented",
    before: null,
    after,
    before_source_refs: [],
    after_source_refs,
    assessment_basis,
    valid_until: null,
    derived_from: [],
    // M15 0b：理解变化也记**书内定位**（这段变化是就着哪一段原文发生的）。
    // 它只是**来源索引**，不替代 before/after 的角色绑定（PRD `:495`）。
    book_evidence: normalizeBookEvidenceInput(book_evidence),
    relations: [{ from_id: id, to_id: content_id, type: "references" }],
  };
  const body = evidenceAttributionBody({
    heading: "# 理解变化",
    lead_lines: ["【原来的判断：**未知** ⇒ 不补造历史判断（`before=null`、`before_source_refs=[]`）】"],
    quote, locator_lines, statement, ai_note,
    // 规范 §3 `:78`：理解变化**不直接**派生五类标签，要的话通过相关 reading_evidence 引用派生。
    label_title: "五类证据标签（本条不直接派生）",
    label_line,
    label_footer: [
      "> 本条是理解变化：`before`/`after` 保留原述。规范 §3 `:78` 规定它**不直接**派生五类能力标签，",
      "> 若需要该标签，通过相关 `reading_evidence` 引用派生 —— 不凭变化短述补造评分。",
    ],
  });
  const check = validateNote(data, { mode: "formal", objectType: "understanding_observation", domain: BOOK_DOMAIN });
  if (!check.ok) {
    throw failed("EVIDENCE_SELF_CHECK_FAILED",
      `理解变化未通过 M1 validateNote(formal)：${check.errors[0]?.message ?? ""}`, { errors: check.errors });
  }
  return { ok: true, data, body, errors: [] };
}

/** 复算时递增 `revision`（同一份笔记的第几次理解）。首次 = 1。 */
export function nextRevision(previousRun) {
  const prev = isMap(previousRun) && Number.isInteger(previousRun.revision) && previousRun.revision >= 0
    ? previousRun.revision
    : 0;
  return prev + 1;
}

/**
 * `RecommendationResult` → `RecommendationRun`（**恰好 18 个必填字段**）。
 * 只做映射与自检，不写盘（写盘是 M6 的 file-service）。
 */
export function mapRecommendationResultToRun(result, ctx = {}) {
  assertResultShape(result);
  const md = result.policy_and_model_metadata;
  const run_id = ctx.run_id ?? md.run_id ?? null;
  if (!isNonEmptyStr(run_id)) throw failed("MISSING_REQUIRED", "RecommendationRun.run_id 必填");
  if (!isNonEmptyStr(ctx.job_id)) throw failed("MISSING_REQUIRED", "RecommendationRun.job_id 必填");
  if (!isNonEmptyStr(ctx.book_version_id)) throw failed("MISSING_REQUIRED", "RecommendationRun.book_version_id 必填");
  if (!isNonEmptyStr(ctx.input_fingerprint)) {
    throw failed("MISSING_REQUIRED", "RecommendationRun.input_fingerprint 必填（本次理解的输入指纹）");
  }
  if (!isArr(ctx.input_manifest_refs)) throw failed("MISSING_REQUIRED", "RecommendationRun.input_manifest_refs 必填");
  if (!isNonEmptyStr(ctx.candidate_set_version)) throw failed("MISSING_REQUIRED", "RecommendationRun.candidate_set_version 必填");
  if (!isNonEmptyStr(ctx.prompt_template_version)) {
    throw failed("MISSING_REQUIRED", "RecommendationRun.prompt_template_version 必填");
  }
  const policy = ctx.policy ?? md.policy;
  if (!isMap(policy) || !isNonEmptyStr(policy.id) || !isNonEmptyStr(policy.version)) {
    throw failed("MISSING_REQUIRED", "RecommendationRun.policy 必须是 {id,version}");
  }
  const model = ctx.model ?? md.model;
  if (!isNonEmptyStr(model) && !isMap(model)) {
    throw failed("MISSING_REQUIRED", "RecommendationRun.model 必须是字符串或映射");
  }
  // M10 阶段 2 移除了这里原来的 `IMMUTABLE_INPUT_FINGERPRINT` 守卫。
  // 旧模型：同指纹复用同一 run_id 是**错的**（复算必须换身份）。
  // 新模型：同书同 run_id 正是**要求**（一本书一个理解），复算只是把这条笔记覆盖掉、revision +1。
  const selected = computeSelectedItems(result.book_guide, result.personalized_items);
  const budgetUsage = ctx.budget_usage ?? deriveBudgetUsage(result, md);
  const run = {
    run_id,
    job_id: ctx.job_id,
    state: ctx.state ?? "ready",
    book_version_id: ctx.book_version_id,
    input_manifest_refs: [...ctx.input_manifest_refs],
    input_fingerprint: ctx.input_fingerprint,
    candidate_set_version: ctx.candidate_set_version,
    policy: { id: policy.id, version: policy.version },
    model,
    prompt_template_version: ctx.prompt_template_version,
    result_outcome: result.outcome,
    book_guide: result.book_guide,
    personalized_items: result.personalized_items,
    personalization_status: result.personalization_status,
    selected_items: selected,
    exclusions: result.exclusions,
    constraints_report: result.constraints_report,
    budget_usage: budgetUsage,
  };
  validateRunRecord(run);
  return run;
}

function deriveBudgetUsage(result, md) {
  const tradeoffs = result.constraints_report?.selection_tradeoffs ?? null;
  return {
    max_items_per_layer: md?.budget?.max_items_per_layer ?? DEFAULT_BUDGET.max_items_per_layer,
    book_items: isMap(result.book_guide) && isArr(result.book_guide.items) ? result.book_guide.items.length : 0,
    personalized_items: isArr(result.personalized_items) ? result.personalized_items.length : 0,
    overview_paragraphs: isMap(result.book_guide) && isArr(result.book_guide.overview_paragraphs)
      ? result.book_guide.overview_paragraphs.length
      : 0,
    time_budget_minutes: md?.budget?.max_minutes ?? null,
    estimated_minutes_used: tradeoffs?.estimated_minutes_used ?? null,
    tradeoffs: tradeoffs ?? null,
  };
}

/**
 * 自检 `RecommendationRun`：
 *   · 键集合**恰好** 18 个（与 `schema.js` 的 `recommendation_run.required` 交叉核对由测试负责）；
 *   · 借 M1 `validateNote`（draft 模式）跑**字段级**校验（18 个字段全部在场 ⇒ 检查全跑）。
 *
 * 这里刻意用 draft：`recommendation_run` 在 M1 schema 里是 `semantic:true`，正式落页所需的
 * frontmatter / dedup_check_ref 由 M6 的提交器补齐；M5 只保证**18 个运行字段**本身合法，
 * 不去**补造**那些不属于本层的字段（PRD :472/:981 的同一纪律）。
 */
export function validateRunRecord(run) {
  if (!isMap(run)) throw failed("INVALID_STRUCTURE", "RecommendationRun 必须是映射");
  const keys = Object.keys(run).sort();
  const want = [...RECOMMENDATION_RUN_REQUIRED_KEYS].sort();
  if (keys.length !== want.length || keys.some((k, i) => k !== want[i])) {
    throw failed(
      "RUN_KEY_MISMATCH",
      `RecommendationRun 必须恰好 18 个必填字段，得到 ${keys.length} 个：${keys.join(",")}`,
      { keys },
    );
  }
  if (!VALUE_DOMAINS.recommendation_run_state.includes(run.state)) {
    throw failed("INVALID_ENUM", "RecommendationRun.state 只能是 ready / stale");
  }
  if (!VALUE_DOMAINS.result_outcome.includes(run.result_outcome)) {
    throw failed("INVALID_ENUM", "RecommendationRun.result_outcome 只能是 items / insufficient_evidence");
  }
  if (!VALUE_DOMAINS.personalization_status.includes(run.personalization_status)) {
    throw failed("INVALID_ENUM", "RecommendationRun.personalization_status 非法");
  }
  // 借 M1 `validateNote` 跑字段级校验：18 个字段全部在场，因此检查全跑；
  // 仅补一个 `object_type` 让校验器知道该用哪张对象表（不改变 18 键断言）。
  const check = validateNote({ ...run, object_type: "recommendation_run" }, { mode: "draft", domain: BOOK_DOMAIN });
  if (!check.ok) {
    throw failed("RUN_SELF_CHECK_FAILED", `RecommendationRun 未通过 M1 字段级自检：${check.errors[0]?.message ?? ""}`, {
      errors: check.errors,
    });
  }
  return { ok: true, errors: [] };
}

/**
 * 组装可正式落页的 `recommendation_run` 笔记并过 M1 `validateNote`（formal）。
 *
 * · `dedup_check_ref` 由编排器提供（**不补造**；缺了就直接报错）。
 * · `book_evidence` 也由编排器提供**完整已核验 SpanRef**（M5 只持有 span_id/text_hash，
 *   补不出 `href`/`codepoint`/`locator_quality`/`quote_type`；**不补造**，缺省为 `[]`）。
 */
export function buildRecommendationRunNote(run, ctx = {}) {
  validateRunRecord(run);
  if (!isNonEmptyStr(ctx.dedup_check_ref)) {
    throw failed("MISSING_REQUIRED", "正式 recommendation_run 笔记需要编排器提供的 dedup_check_ref（不补造）");
  }
  const created = ctx.now ?? new Date().toISOString();
  const data = {
    schema_version: SCHEMA_VERSION,
    object_type: "recommendation_run",
    id: run.run_id,
    revision: ctx.revision ?? 1,
    title: ctx.title ?? "两层阅读推荐运行",
    tags: ctx.tags ?? ["reading", "recommendation"],
    scope: ctx.scope ?? "reading",
    knowledge_status: ctx.knowledge_status ?? "active",
    created_at: created,
    updated_at: created,
    origin: "ai_inference",
    confirmation: "unconfirmed",
    confirmation_evidence: null,
    // 已核验 SpanRef 只能由编排器给（PRD :463 的 11 个字段 M5 拿不到）。
    book_evidence: isArr(ctx.book_evidence) ? ctx.book_evidence : [],
    session_evidence: [],
    external_master: ctx.external_master ?? {
      status: "unverified",
      outcome: "not_checked",
      scope_refs: [],
      candidate_refs: [],
      authorization_revision: null,
      checked_at: null,
    },
    dedup_check_ref: ctx.dedup_check_ref,
    ...run,
  };
  const check = validateNote(data, { mode: "formal", objectType: "recommendation_run", domain: BOOK_DOMAIN });
  if (!check.ok) {
    throw failed("RUN_SELF_CHECK_FAILED", `run 笔记未通过 M1 validateNote(formal)：${check.errors[0]?.message ?? ""}`, {
      errors: check.errors,
    });
  }
  return { ok: true, data, errors: [] };
}

// --------------------------------------------------------------------------- //
// 10. 结果组装
// --------------------------------------------------------------------------- //
function buildConstraintsReport({
  gate,
  feedback,
  policyConfig,
  policyFallback,
  lambdaClamped,
  budget,
  boundary,
  selection,
  insufficientEvidenceReason,
}) {
  const excludedCounts = {};
  for (const e of gate.excluded) {
    excludedCounts[e.reason_code] = (excludedCounts[e.reason_code] ?? 0) + 1;
  }
  const materialExclusions = gate.excluded.filter((e) => MATERIAL_EXCLUSION_REASONS.includes(e.reason_code));
  const constraintExclusions = gate.excluded.filter((e) => CONSTRAINT_EXCLUSION_REASONS.includes(e.reason_code));
  const appliedExclusions = feedback.applied.filter((f) =>
    ["not_interested", "irrelevant", "defer"].includes(f.feedback_type));
  const report = {
    gate_order: [...GATE_ORDER],
    consent_passed: true,
    reading_boundary_passed: constraintExclusions.every((e) => e.reason_code !== "outside_reading_boundary"),
    version_passed: constraintExclusions.every((e) => e.reason_code !== "version_mismatch"),
    citation_passed: materialExclusions.every((e) => e.reason_code !== "source_hash_mismatch"),
    source_verified_count: gate.evaluated.filter((r) => r.source_verified).length,
    excluded_counts: excludedCounts,
    material_exclusions: materialExclusions.map((e) => ({ candidate_id: e.candidate_id, reason_code: e.reason_code })),
    constraint_exclusions: constraintExclusions.map((e) => ({ candidate_id: e.candidate_id, reason_code: e.reason_code })),
    // PRD :280：仅排除反馈时 status=none，但**必须明示**「已应用本次排除」。
    applied_feedback_exclusions: {
      applied: appliedExclusions.length > 0,
      feedback_refs: appliedExclusions.map((f) => f.feedback_id ?? `recent_feedback[${f.index}]`),
      note: appliedExclusions.length > 0 ? APPLIED_EXCLUSION_NOTE : null,
    },
    soft_signals: {
      known: feedback.applied.filter((f) => f.feedback_type === "known").map((f) => f.feedback_id ?? `recent_feedback[${f.index}]`),
      disagree: feedback.applied.filter((f) => f.feedback_type === "disagree").map((f) => f.feedback_id ?? `recent_feedback[${f.index}]`),
      interested: feedback.applied.filter((f) => f.feedback_type === "interested").map((f) => f.feedback_id ?? `recent_feedback[${f.index}]`),
      correction: feedback.applied.filter((f) => f.feedback_type === "correction").map((f) => f.feedback_id ?? `recent_feedback[${f.index}]`),
    },
    dropped_dimensions: gate.dropped_dimensions,
    unknown_dimensions: gate.unknown_dimensions,
    policy_config_fallback: policyFallback,
    lambda_cap_clamped: lambdaClamped,
    retrieval_hits_ignored_for_baseline: gate.retrieval_hits_ignored_for_baseline,
    selection_tradeoffs: {
      book: selection.book.tradeoffs,
      personalized: selection.personalized.tradeoffs,
      estimated_minutes_used: selection.personalized.minutes_used,
      max_minutes: budget.max_minutes,
      max_items_per_layer: budget.max_items_per_layer,
      reading_boundary_mode: boundary.mode,
    },
    insufficient_evidence_reason: insufficientEvidenceReason,
  };
  return report;
}

function buildPolicyMetadata({ policyConfig, request, inputFingerprint, inputManifestRefs, budget }) {
  return {
    policy: { id: policyConfig.policy_id, version: policyConfig.policy_version },
    model: policyConfig.model,
    prompt_template_version: policyConfig.prompt_template_version,
    candidate_set_version: request.coverage_snapshot.candidate_set_version ?? null,
    input_fingerprint: inputFingerprint,
    input_manifest_refs: inputManifestRefs,
    lambda_cap: policyConfig.lambda_cap,
    enabled_dimensions: [...policyConfig.enabled_dimensions],
    weights: { ...policyConfig.weights },
    b_anchors: { ...B_SCORE_ANCHORS },
    retrieval_used_as_baseline: false,
    budget: { ...budget },
  };
}

// --------------------------------------------------------------------------- //
// 11. 主入口
// --------------------------------------------------------------------------- //
/**
 * 两层推荐策略（PRD §11.4 :924）。
 *
 * @returns {Promise<object>} `RecommendationResult`（**恰好 7 键**，冻结裁定①）
 */
export class RecommendationPolicy {
  constructor({ now = null } = {}) {
    this.now = now;
  }

  async rank(request, capabilities) {
    return rank(request, capabilities, { now: this.now });
  }
}

export async function rank(request, capabilities, { now = null } = {}) {
  validateRankRequest(request);
  checkCapabilities(capabilities);

  const nowIso = now === null ? new Date().toISOString() : now;
  const { config: policyConfig, fallback: policyFallback, clamped: lambdaClamped } =
    resolvePolicyConfig(request.policy_config ?? null);
  const { budget, fallback: budgetFallback } = resolveBudget(request.budget ?? null);
  const boundary = resolveReadingBoundary(request.reading_boundary);
  const feedback = normalizeFeedback(request.recent_feedback, nowIso);
  const evidenceIndex = buildEvidenceIndex(request);
  const inputFingerprint = recommendationInputFingerprint(request);
  const inputManifestRefs = buildInputManifestRefs(request);

  const gate = await runQualityGate({
    request,
    capabilities,
    boundary,
    feedback,
    evidenceIndex,
    policyConfig,
    budget,
    now: nowIso,
  });

  const eligible = gate.evaluated.filter((r) => r.excluded_reason === null);
  const materialEligible = gate.evaluated.filter((r) => r.material_eligible);
  const condensationCandidates = gate.evaluated.filter((r) => r.condensation_safe);

  const policyMeta = buildPolicyMetadata({
    policyConfig,
    request,
    inputFingerprint,
    inputManifestRefs,
    budget: { ...budget, ...(budgetFallback.used ? { fallback: budgetFallback } : {}) },
  });

  const baseReport = (extra) => buildConstraintsReport({
    gate,
    feedback,
    policyConfig,
    policyFallback,
    lambdaClamped,
    budget,
    boundary,
    selection: extra.selection ?? { book: { tradeoffs: {} }, personalized: { tradeoffs: {}, minutes_used: 0 } },
    insufficientEvidenceReason: extra.insufficientEvidenceReason ?? null,
  });

  // ── 整体弃权：**只有缺少可信书内材料**才可能（PRD :965）────────────────────
  if (materialEligible.length === 0) {
    const reason = request.candidates.length === 0
      ? "NO_CANDIDATES"
      : (gate.excluded.every((e) => MATERIAL_EXCLUSION_REASONS.includes(e.reason_code))
        ? "NO_CREDIBLE_BOOK_MATERIAL"
        : "NO_MATERIAL_ELIGIBLE_CANDIDATE");
    const result = {
      outcome: "insufficient_evidence",
      book_guide: null,
      personalized_items: [],
      personalization_status: "none",
      exclusions: gate.excluded,
      constraints_report: baseReport({ insufficientEvidenceReason: reason }),
      policy_and_model_metadata: policyMeta,
    };
    assertResultShape(result);
    return result;
  }

  // ── 第一层：按 B 选（不依赖个人背景）──────────────────────────────────────
  const bookSorted = sortBookLayer(eligible.filter((r) => r.book_value !== null));
  const bookSelection = selectWithBudget(bookSorted, {
    limit: budget.max_items_per_layer,
    maxMinutes: budget.max_minutes,
  });
  const bookItems = bookSelection.selected.map((r) => ({
    candidate_id: r.candidate.candidate_id,
    section_id: r.candidate.section_id,
    B: r.book_value.score,
    reason: r.book_value.reason,
    source_refs: r.candidate.book_evidence_refs.map((x) => x.span_id),
  }));

  // 第一层浓缩：只用**通过剧透/版本门**的候选（否则会泄露越界内容）。
  const overview = await buildOverviewParagraphs({
    condensationCandidates,
    request,
    capabilities,
    budget,
    maxParagraphs: budget.max_overview_paragraphs,
  });

  // 有可信书内材料但一个安全浓缩都拿不到 ⇒ 结构上无法产出合法 book_guide：
  // 此时「缺少可信书内材料」成立（不能伪造浓缩），走整体弃权。
  if (overview === null) {
    const result = {
      outcome: "insufficient_evidence",
      book_guide: null,
      personalized_items: [],
      personalization_status: "none",
      exclusions: gate.excluded,
      constraints_report: baseReport({ insufficientEvidenceReason: "NO_BOUNDARY_SAFE_CONDENSATION" }),
      policy_and_model_metadata: policyMeta,
    };
    assertResultShape(result);
    return result;
  }

  const coverageScope = {
    scope: request.coverage_snapshot.scope ?? "parsed_body",
    book_version_id: request.book_version_id,
    section_ids: isArr(request.coverage_snapshot.section_ids) ? [...request.coverage_snapshot.section_ids] : [],
  };
  const bookGuide = {
    overview_paragraphs: overview.paragraphs,
    coverage_scope: coverageScope,
    source_refs: overview.source_refs,
    items: bookItems,
  };
  if (bookItems.length === 0) {
    // PRD :971：全部候选被明确约束排除 ⇒ items=[] 且**必须**给真实 no_eligible_reason。
    bookGuide.no_eligible_reason = buildNoEligibleReason(gate);
  }

  // ── 第二层：只在真实授权材料存在时生成；只收 W>0 ───────────────────────────
  const personalPool = eligible.filter((r) => r.scores !== null && r.scores.W > 0);
  const personalSorted = sortPersonalizedLayer(personalPool);
  const personalSelection = selectWithBudget(personalSorted, {
    limit: budget.max_items_per_layer,
    maxMinutes: budget.max_minutes,
  });
  const personalizedItems = personalSelection.selected.map((r) => ({
    candidate_id: r.candidate.candidate_id,
    reasons: {
      book: r.book_value.reason,
      personal: PERSONAL_DIMENSIONS
        .filter((d) => r.dimension_evidence[d] !== undefined)
        .map((d) => `${d}: ${r.dimension_evidence[d].reason}`),
      reason_code: r.candidate.reason_code,
    },
    dimension_evidence: r.dimension_evidence,
    scores: r.scores,
    uncertainty: r.candidate.uncertainty ?? buildUncertainty(r),
    source_refs: [
      ...new Set([
        ...r.candidate.book_evidence_refs.map((x) => x.span_id),
        ...r.evidence_refs,
      ]),
    ],
  }));
  const status = derivePersonalizationStatus(personalizedItems);

  const selection = { book: bookSelection, personalized: personalSelection };
  const result = {
    outcome: "items",
    book_guide: bookGuide,
    personalized_items: personalizedItems,
    personalization_status: status,
    exclusions: gate.excluded,
    constraints_report: baseReport({ selection }),
    policy_and_model_metadata: policyMeta,
  };
  assertResultShape(result);
  return result;
}

function buildUncertainty(rec) {
  const unknown = PERSONAL_DIMENSIONS.filter((d) => rec.scores[d] === null);
  if (unknown.length === 0) return "个人维度均有依据；仍不代表已校准的高置信。";
  return `未观察到以下维度的依据，保持未知（不填 0/中立）：${unknown.join("/")}。`;
}

/** 真实（非空话）`no_eligible_reason`：由**实际**排除原因拼出，并带计数。 */
export function buildNoEligibleReason(gate) {
  const counts = {};
  for (const e of gate.excluded) counts[e.reason_code] = (counts[e.reason_code] ?? 0) + 1;
  const parts = Object.entries(counts)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}(${v})`);
  if (parts.length === 0) return "全部候选未通过质量门（无可用书内材料）";
  return `全部候选被硬约束排除：${parts.join("、")}`;
}

// --------------------------------------------------------------------------- //
// 12. 依赖闭包守卫（供测试断言：不引入 fs/宿主依赖）
// --------------------------------------------------------------------------- //
/** 本模块**只允许**这两个相对依赖（执行计划 §1 #6：依赖 compiler）。 */
export const ALLOWED_IMPORT_SPECIFIERS = Object.freeze(["./schema.js", "./compiler.js", "./book-domain.js"]);

export default { rank, RecommendationPolicy };
