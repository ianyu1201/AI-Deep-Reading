/**
 * lib/reading/compiler.js · M4 知识编译器
 *
 * 职责（执行计划-v0.6 §1 表 #5）：`KnowledgeCompiler.propose(request, capabilities) -> CompileResult`
 * —— 把「已核验的书内材料 + 已核验的会话片段 + 服务给出的查重结果」编译成**候选变更**
 * （PRD §11.4 :939-981）。依赖 `schema.js`（M1）与 `coverage.js`（M3）。
 *
 * ## 这个模块最容易写错的四处（PRD 逐条点名）
 *
 * 1. **顶层 `compiler` 不是 `generated_by` 的子字段**（PRD :472 / :481 / :981）
 *    · 顶层 `compiler` 必填映射 `{name, version}`；正式提案两子字段须**真实非空字符串**；
 *      **未知时阻止生成可接受提案**（不是填占位符蒙过去）；模板用 `{name:null,version:null}` 占位；
 *      **幂等键取其 version**。
 *    · `generated_by` 是**另一个键名**，形状 `{compiler, version}`；工具信息未知时**省略整个字段**；
 *      **索引没有该字段时不补造**。
 *    · `compiler_metadata` 统一为 `{name,version}`，校验后**映射到顶层 compiler**，
 *      **不得混入** `generated_by`。
 *    本文件把三者做成三个**不同的**函数，并让键名混淆在结构上不可能通过校验。
 *
 * 2. **模型不得自选 `authorized_auto`**（PRD :472 段）
 *    · `application_mode` 由**提交器**决定并校验；编译器产出的提案**恒为 `manual`**。
 *    · 提交器要走自动路径，必须用 `validateAuthorizedAuto()` 校验「真实启用动作 + 本次有效授权 +
 *      scope 限定对象/新建操作/45 路径」，且该引用**不是** `confirmation_evidence`。
 *
 * 3. **归属三分离**（PRD :483）：`origin`（命题作者）/ `generated_by`（整理工具）/
 *    `confirmation`（用户是否明确接受）三者不得混写。
 *    · AI 猜测 ⇒ `origin=ai_inference` + `confirmation=unconfirmed`；
 *      用户确认 AI 假设后 **origin 仍不变**；用户另行表达自己判断 ⇒ 建**独立的 user 记录** +
 *      `derived_from` 关系。
 *    · 涉及用户判断的自动提案**最初一律 `unconfirmed`**；模型**不能**生成有效确认动作。
 *    · `source.kind=user` 只是**真人输入候选**，引用不变成用户自述。
 *
 * 4. **错误不得伪装成 `no_change`**（PRD :966-967）
 *    · 来源不可用 / 核对失败 / 格式错误 ⇒ 外层错误或 `WorkJob.blocked|failed`。
 *    · `no_change` 只是「处理过、确认无需变更」，且必须是**耐久最小回执**（含 check 与来源范围）。
 *    · 本模块的错误带 `work_job_state`（`blocked` / `failed`），且 `mapErrorToJob()` **永不**返回
 *      `result_outcome: "no_change"`。
 *
 * ## 与 M1/M3 的衔接
 *   · 输出是**候选内容**：ChangeProposal 经校验并耐久保存后才存在（M1 `file-service` 事务）。
 *   · 生成正式对象前用 M1 `schema.js` 的 `validateNote()` **自检**（`propose()` 内部强制执行）。
 *   · 「哪些范围可分析」由 M3 `coverage.js` 判定：`planAdvance()` 的 `blocked_reason` **能阻止**
 *     对不可推进单元生成提案（`analyzableRanges()` 是唯一入口，不绕过）。
 *
 * ## 纯函数与注入
 *   模块本身不读网络、不读宿主、不写文件；宿主能力（模型、来源读取）一律通过 `capabilities` 注入。
 *   时钟与提案 ID 通过构造器注入（`new KnowledgeCompiler({now})`），测试可完全确定化。
 */

import {
  SCHEMA_VERSION,
  VALUE_DOMAINS,
  SchemaError,
  sha256Hex,
  validateNote,
  validateNoChangeReceipt,
  checkExternalMaster,
} from "./schema.js";
import { BOOK_DOMAIN, OBJECT_TYPES, SEMANTIC_OBJECT_TYPES } from "./book-domain.js";

import {
  planAdvance,
  sourceBlockReason,
} from "./coverage.js";

// --------------------------------------------------------------------------- //
// 基础判定（与 M1/M3 同名同义，避免跨文件语义漂移）
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
export const COMPILER_VERSION = "1.0.0";

/** 编译器的**真实身份**：顶层 `compiler.name` 的取值来源（不是占位符）。 */
export const COMPILER_NAME = "dsh-apple-read.reading-compiler";

/** PRD §11.4 :950：`CompileResult.outcome` 恰好两个值。 */
export const COMPILE_OUTCOMES = Object.freeze(["no_change", "proposal"]);

/** PRD §11.4 :939：`request` 的字段集合（闭合；多字段一律拒绝，防走私）。 */
export const REQUEST_KEYS = Object.freeze([
  "schema_version",
  "job_id",
  "host_source_refs",
  "verified_durability_range",
  "effective_turns_in_memory",
  "relevant_book_spans",
  "dedup_check",
  "current_note_snapshots_and_hashes",
  "consent_scope",
  "summary_budget",
  "compiler_config",
]);

/** PRD §11.4 :945：`capabilities` 的 5 项，**恰好等集**。 */
export const CAPABILITY_KEYS = Object.freeze([
  "readSourceSpan",
  "readCheckedNote",
  "requestAdditionalCandidates",
  "readHostTurns",
  "generateStructured",
]);

/** PRD :472：顶层 `compiler` 的两个子字段（注意：与 `generated_by` **键名不同**）。 */
export const COMPILER_METADATA_KEYS = Object.freeze(["name", "version"]);

/** PRD :481：`generated_by` 的两个子字段（**不是** `{name, version}`）。 */
export const GENERATED_BY_KEYS = Object.freeze(["compiler", "version"]);

/** PRD §11.4 :950：`CompileResult` 的顶层键，**恰好 6 个**。 */
export const COMPILE_RESULT_KEYS = Object.freeze([
  "outcome",
  "operations",
  "dedup_check_ref",
  "conflicts",
  "uncertainties",
  "compiler_metadata",
]);

/** PRD §8.5：`SessionEvidence.surface_class` 的闭合值域（来自 M2 session-reader）。 */
export const SURFACE_CLASSES = Object.freeze(["current", "shadowed", "log-only"]);

/**
 * 摘要类来源：**不能成为证据**（PRD :981「摘要不能成为证据」；勘误「compact-checkpoint
 * 仅导航，不能独立支持画像、理解/掌握或推荐个性化」）。
 */
export const NON_EVIDENCE_SOURCE_KINDS = Object.freeze(["compact-checkpoint"]);

/**
 * `current_note_snapshots_and_hashes` 的**服务产出标记**。
 * PRD :981：由 knowledge-search 的 search→exact read 产生，**编排器注入，模型不能自报**。
 * 要求每项携带该标记，是这句话的可执行形式（缺标记即拒绝）。
 */
export const SNAPSHOT_PRODUCER = "knowledge-search.search_exact_read";

/** `summary_budget` 的默认上限（PRD :939 只给字段名，未给数值）。 */
export const DEFAULT_SUMMARY_BUDGET = Object.freeze({
  max_operations: 20,
  max_short_content_chars: 800,
});

/** 编译器产出的提案**恒为 manual**；自动模式只能由提交器校验后赋予。 */
export const COMPILER_APPLICATION_MODE = "manual";

/** 45 区前缀（PRD §1 / 执行计划：插件自动写只限 `45-书籍/`）。 */
export const READING_ROOT = "45-书籍/";

/** 编译器生成的 `session_cursor` 效果：**永不推进**。 */
export const CURSOR_EFFECT = Object.freeze({
  advanced: false,
  reason: "COMPILER_NEVER_ADVANCES_SESSION_CURSOR",
});

// --------------------------------------------------------------------------- //
// 错误类型
// --------------------------------------------------------------------------- //
/**
 * 编译错误。
 *
 * `work_job_state` 把 PRD :966 的「外层错误 / WorkJob.blocked|failed」变成可执行分类：
 *   · `blocked` —— 条件改变后可恢复（来源未耐久、核对不完整、需要追加召回、覆盖不可推进）
 *   · `failed`  —— 重试无意义（请求格式错误、宿主缺能力、编译器身份未知、归属违规、自检失败）
 *
 * **它永远不是 `no_change`**（见 `mapErrorToJob`）。
 */
export class CompilerError extends Error {
  constructor(code, message, detail = null, { workJobState = "failed" } = {}) {
    super(message);
    this.name = "CompilerError";
    this.code = code;
    this.detail = detail;
    this.work_job_state = workJobState === "blocked" ? "blocked" : "failed";
  }
}

const blocked = (code, message, detail) =>
  new CompilerError(code, message, detail, { workJobState: "blocked" });
const failed = (code, message, detail) =>
  new CompilerError(code, message, detail, { workJobState: "failed" });

// --------------------------------------------------------------------------- //
// 1. 三键分离：compiler_metadata / 顶层 compiler / generated_by
// --------------------------------------------------------------------------- //
/**
 * 校验 `compiler_metadata`：**恰好** `{name, version}`，两者均为**真实非空字符串**。
 *
 * 这里刻意把「未知」判为**不合法**（`ok:false`），而不是补默认值 —— PRD :472
 * 「未知时阻止生成可接受提案」。模板的 `{name:null,version:null}` 占位因此**无法**通过。
 *
 * 也刻意拒绝 `{compiler, version}`：那是 `generated_by` 的键名，混用即错。
 */
export function validateCompilerMetadata(v, { field = "compiler_metadata" } = {}) {
  const errors = [];
  const push = (code, f, message) => errors.push({ code, field: f, message });
  if (!isMap(v)) {
    push("INVALID_STRUCTURE", field, "compiler_metadata 必须是 {name, version} 映射，不接受标量或省略");
    return { ok: false, errors, value: null };
  }
  const keys = Object.keys(v).sort();
  if (keys.length !== COMPILER_METADATA_KEYS.length ||
      !COMPILER_METADATA_KEYS.every((k, i) => keys[i] === k)) {
    push(
      "INVALID_STRUCTURE",
      field,
      `compiler_metadata 只允许 name 与 version 两个子字段（键名与 generated_by 的 {compiler,version} 不同），得到 [${keys.join(", ")}]`,
    );
  }
  for (const k of COMPILER_METADATA_KEYS) {
    if (!isNonEmptyStr(v[k])) {
      push(
        "COMPILER_IDENTITY_UNKNOWN",
        `${field}.${k}`,
        `compiler_metadata.${k} 必须是真实非空字符串；未知时不得生成可接受提案（不接受标量/空串/半填/占位符）`,
      );
    }
  }
  return { ok: errors.length === 0, errors, value: errors.length === 0 ? { name: v.name, version: v.version } : null };
}

/**
 * `compiler_metadata` → 顶层 `compiler`。
 *
 * **只**取 `{name, version}`：任何 `generated_by`（其键是 `{compiler, version}`）都不得混入。
 * 校验不通过直接抛错 —— 未知身份**阻止**生成提案，而不是回落到占位符。
 */
export function compilerMetadataToTopLevel(metadata, { field = "compiler" } = {}) {
  const r = validateCompilerMetadata(metadata, { field: "compiler_metadata" });
  if (!r.ok) {
    throw failed(
      "COMPILER_IDENTITY_UNKNOWN",
      "编译器身份未知或形状非法：不得生成可接受提案（PRD :472）",
      { errors: r.errors, target_field: field },
    );
  }
  // 显式重建，杜绝把别的键（尤其 generated_by）顺带带进顶层 compiler。
  return { name: r.value.name, version: r.value.version };
}

/**
 * 解析 `generated_by`（PRD :481）。
 *
 * 三条规则，逐条可证伪：
 *   ① 来源对象**没有**该字段 ⇒ 返回 `undefined`（**不补造**生成元数据）；
 *   ② 值为 `null`/`undefined` ⇒ 返回 `undefined`（模板占位 ⇒ 省略整个字段）；
 *   ③ 出现且非空 ⇒ 必须**恰好** `{compiler, version}` 且两者真实非空，否则抛错。
 *
 * 它**永远不会**返回 `{name, version}` —— 那是顶层 `compiler` 的键名。
 */
export function resolveGeneratedBy(source = {}, { field = "generated_by" } = {}) {
  if (!isMap(source) || !hasOwn(source, field)) return undefined;
  const v = source[field];
  if (v === null || v === undefined) return undefined;
  if (!isMap(v)) {
    throw failed("INVALID_GENERATED_BY", `${field} 必须是 {compiler, version} 映射，不接受标量`, { value: v });
  }
  const keys = Object.keys(v).sort();
  if (keys.length !== GENERATED_BY_KEYS.length ||
      !GENERATED_BY_KEYS.every((k, i) => keys[i] === k)) {
    throw failed(
      "INVALID_GENERATED_BY",
      `${field} 只允许 compiler 与 version 两个子字段（不是 {name,version}，也不是顶层 compiler 的子字段）`,
      { keys },
    );
  }
  if (!isNonEmptyStr(v.compiler) || !isNonEmptyStr(v.version)) {
    throw failed(
      "INVALID_GENERATED_BY",
      "工具生成且提供 generated_by 时，compiler/version 必须是真实非空字符串（不接受空串或半填映射）",
      { value: v },
    );
  }
  return { compiler: v.compiler, version: v.version };
}

/**
 * 幂等键（PRD :472：「模板使用 {name:null,version:null} 占位，**幂等键取其 version**」）。
 *
 * 取 `compiler.version` + 输入指纹：同一编译器版本、同一输入 ⇒ 同一键（可安全重放）；
 * 编译器版本变化 ⇒ 新键（不是同一个提案的重放）。
 */
export function compilerIdempotencyKey(metadata, inputFingerprint) {
  const top = compilerMetadataToTopLevel(metadata);
  if (!isNonEmptyStr(inputFingerprint)) {
    throw failed("INVALID_ARGUMENT", "幂等键需要非空 input_fingerprint");
  }
  return sha256Hex(`${top.name}@${top.version}|${inputFingerprint}`);
}

// --------------------------------------------------------------------------- //
// 2. request 形状校验
// --------------------------------------------------------------------------- //
/**
 * PRD §11.4 :939 的 request 形状校验。
 *
 * 键集合**闭合**：未知字段一律拒绝 —— 这是「模型不得自选 application_mode」的
 * 第一道结构性守卫（`application_mode` / `authorization_ref` 不在 request 里）。
 */
export function validateCompileRequest(request) {
  const errors = [];
  const push = (code, field, message) => errors.push({ code, field, message });
  if (!isMap(request)) {
    push("INVALID_REQUEST", "", "request 必须是映射");
    return { ok: false, errors };
  }
  for (const k of REQUEST_KEYS) {
    if (!hasOwn(request, k)) push("MISSING_REQUIRED", k, `request 缺少字段 ${k}（PRD §11.4 :939）`);
  }
  for (const k of Object.keys(request)) {
    if (!REQUEST_KEYS.includes(k)) {
      push(
        "UNEXPECTED_FIELD",
        k,
        `request 不接受字段 ${k}；application_mode / authorization_ref 由提交器决定，不在编译器输入里`,
      );
    }
  }
  if (hasOwn(request, "schema_version") && request.schema_version !== SCHEMA_VERSION) {
    push("UNSUPPORTED_SCHEMA_VERSION", "schema_version", `只支持 schema_version "${SCHEMA_VERSION}"`);
  }
  if (hasOwn(request, "job_id") && !isNonEmptyStr(request.job_id)) {
    push("INVALID_VALUE", "job_id", "job_id 必须是非空字符串");
  }
  for (const k of ["host_source_refs", "effective_turns_in_memory", "relevant_book_spans", "current_note_snapshots_and_hashes"]) {
    if (hasOwn(request, k) && !isArr(request[k])) push("INVALID_STRUCTURE", k, `${k} 必须是数组`);
  }
  if (hasOwn(request, "verified_durability_range") &&
      request.verified_durability_range !== null &&
      !isMap(request.verified_durability_range)) {
    push("INVALID_STRUCTURE", "verified_durability_range", "verified_durability_range 必须是映射或 null");
  }
  for (const k of ["dedup_check", "consent_scope", "summary_budget", "compiler_config"]) {
    if (hasOwn(request, k) && !isMap(request[k])) push("INVALID_STRUCTURE", k, `${k} 必须是映射`);
  }
  return { ok: errors.length === 0, errors };
}

function assertRequest(request) {
  const r = validateCompileRequest(request);
  if (!r.ok) {
    throw failed("INVALID_REQUEST", `编译请求不合法：${r.errors[0]?.message ?? ""}`, { errors: r.errors });
  }
}

// --------------------------------------------------------------------------- //
// 3. 能力（capabilities）
// --------------------------------------------------------------------------- //
/** 检查 5 项宿主能力；缺失/非函数 ⇒ `HOST_UNSUPPORTED`（失败，不伪装 no_change）。 */
export function checkCapabilities(capabilities) {
  const errors = [];
  if (!isMap(capabilities)) {
    return { ok: false, errors: [{ code: "HOST_UNSUPPORTED", field: "capabilities", message: "capabilities 必须是映射" }] };
  }
  for (const k of CAPABILITY_KEYS) {
    if (typeof capabilities[k] !== "function") {
      errors.push({
        code: "HOST_UNSUPPORTED",
        field: k,
        message: `capabilities.${k} 未提供：缺少宿主能力时不得继续（也不得伪装成 no_change）`,
      });
    }
  }
  return { ok: errors.length === 0, errors };
}

function assertCapabilities(capabilities) {
  const r = checkCapabilities(capabilities);
  if (!r.ok) {
    throw failed("HOST_UNSUPPORTED", `宿主能力不完整：${r.errors[0]?.message ?? ""}`, { errors: r.errors });
  }
}

// --------------------------------------------------------------------------- //
// 4. 会话来源门槛（PRD :981 / §9.5）
// --------------------------------------------------------------------------- //
/**
 * 校验 `verified_durability_range`。
 *
 * 「存在会话输入时耐久范围必须验证，**不能用 null 绕过**」的可执行形式：
 * 必须是 `{verified:true, session_id, branch_id, source_revision, through_seq}`。
 */
export function checkDurabilityRange(range) {
  if (!isMap(range)) {
    return { ok: false, code: "DURABILITY_UNVERIFIED", message: "verified_durability_range 必须是已验证映射（不能用 null 绕过）" };
  }
  if (range.verified !== true) {
    return { ok: false, code: "DURABILITY_UNVERIFIED", message: "verified_durability_range.verified 必须为 true（自报范围不算验证）" };
  }
  for (const k of ["session_id", "branch_id", "source_revision"]) {
    if (!isNonEmptyStr(range[k])) {
      return { ok: false, code: "DURABILITY_UNVERIFIED", message: `verified_durability_range.${k} 必须是非空字符串` };
    }
  }
  if (!isInt(range.through_seq) || range.through_seq < 0) {
    return { ok: false, code: "DURABILITY_UNVERIFIED", message: "verified_durability_range.through_seq 必须是非负整数" };
  }
  if (range.from_seq !== null && range.from_seq !== undefined) {
    if (!isInt(range.from_seq) || range.from_seq < 0) {
      return { ok: false, code: "DURABILITY_UNVERIFIED", message: "verified_durability_range.from_seq 必须是非负整数或 null" };
    }
    if (range.from_seq > range.through_seq) {
      return { ok: false, code: "DURABILITY_UNVERIFIED", message: "from_seq 不得超过 through_seq" };
    }
  }
  return { ok: true };
}

/**
 * 会话门槛。返回 `{session_input:boolean, durability_range, refs}`。
 *
 * · **无会话材料** ⇒ 要求 `host_source_refs=[]` 且 `verified_durability_range=null`；
 *   不得虚构宿主轮次，不推进 session cursor。
 * · **有会话输入** ⇒ 耐久范围必须验证，且每个 ref 与范围自洽（revision 一致、through 不超范围）。
 */
export function checkSessionGate(request) {
  const refs = request.host_source_refs ?? [];
  const range = request.verified_durability_range ?? null;
  const turns = request.effective_turns_in_memory ?? [];
  const sessionInput = refs.length > 0;

  if (!sessionInput) {
    if (range !== null) {
      throw failed(
        "DURABILITY_RANGE_WITHOUT_SESSION",
        "host_source_refs=[] 却给了 verified_durability_range：无会话材料时该字段必须为 null（不得虚构宿主轮次）",
      );
    }
    if (turns.length > 0) {
      throw failed(
        "FABRICATED_TURNS",
        "host_source_refs=[] 却给了 effective_turns_in_memory：不得虚构宿主轮次",
      );
    }
    return { session_input: false, durability_range: null, refs: [], turns: [] };
  }

  const dr = checkDurabilityRange(range);
  if (!dr.ok) {
    throw blocked(dr.code, `存在会话输入但耐久范围未验证：${dr.message}（PRD :981 不得用 null 绕过）`);
  }
  for (let i = 0; i < refs.length; i++) {
    const ref = refs[i];
    if (!isMap(ref)) throw failed("INVALID_STRUCTURE", `host_source_refs[${i}] 必须是映射`);
    for (const k of ["session_id", "branch_id", "source_revision"]) {
      if (!isNonEmptyStr(ref[k])) {
        throw failed("INVALID_VALUE", `host_source_refs[${i}].${k}`, `host_source_refs[${i}].${k} 必须是非空字符串`);
      }
    }
    if (ref.source_revision !== range.source_revision) {
      throw failed(
        "SOURCE_REVISION_MISMATCH",
        `host_source_refs[${i}].source_revision 与耐久范围不一致：不得用未核验范围覆盖`,
      );
    }
    if (ref.through_seq !== null && ref.through_seq !== undefined) {
      if (!isInt(ref.through_seq) || ref.through_seq < 0 || ref.through_seq > range.through_seq) {
        throw failed(
          "DURABILITY_RANGE_EXCEEDED",
          `host_source_refs[${i}].through_seq 超出已验证耐久范围（ready 只证明 requested_range）`,
        );
      }
    }
  }
  return { session_input: true, durability_range: range, refs, turns };
}

/**
 * 校验一条 `effective_turns_in_memory` 片段。
 *
 * PRD :981：只含经 §9.1 核验的来源片段及分源归属；默认取 current；
 * 授权历史/缺口回溯须**显式携带**原事件身份、surface_class 和用途；**摘要不能成为证据**。
 */
export function checkEffectiveTurn(turn, { index = 0 } = {}) {
  const field = `effective_turns_in_memory[${index}]`;
  if (!isMap(turn)) throw failed("INVALID_STRUCTURE", `${field} 必须是映射`);
  if (turn.verified !== true) {
    throw failed(
      "TURN_NOT_VERIFIED",
      `${field} 未经 §9.1 核验：effective_turns_in_memory 只含已核验来源片段`,
    );
  }
  const sourceKind = turn.message_source_kind ?? turn.source_kind ?? null;
  const surfaceClass = turn.surface_class ?? "current"; // 「默认取 current」
  if (!SURFACE_CLASSES.includes(surfaceClass)) {
    throw failed("INVALID_ENUM", `${field}.surface_class`, `surface_class 只能是 ${SURFACE_CLASSES.join(" / ")}`);
  }
  const isSummary = turn.is_summary === true ||
    (isNonEmptyStr(sourceKind) && NON_EVIDENCE_SOURCE_KINDS.includes(sourceKind));

  if (isSummary) {
    // 摘要**不能成为证据**：保留可导航性，但从证据集合里剔除。
    return {
      ok: true,
      usable: false,
      not_evidence_reason: "SUMMARY_IS_NOT_EVIDENCE",
      evidence: null,
      turn,
    };
  }

  if (surfaceClass !== "current") {
    // 授权历史/缺口回溯：必须显式携带原事件身份、surface_class 和用途（PRD :981）。
    if (!isNonEmptyStr(turn.purpose)) {
      throw failed(
        "HISTORY_TURN_REQUIRES_PURPOSE",
        `${field} 的 surface_class=${surfaceClass}（非 current）：授权历史/缺口回溯必须显式携带 purpose`,
      );
    }
    if (!isNonEmptyStr(turn.original_event_identity) && !isInt(turn.event_seq)) {
      throw failed(
        "HISTORY_TURN_REQUIRES_IDENTITY",
        `${field} 的 surface_class=${surfaceClass}（非 current）：必须显式携带原事件身份（original_event_identity 或 event_seq）`,
      );
    }
  }

  const sessionId = turn.session_id;
  const revision = turn.source_revision;
  if (!isNonEmptyStr(sessionId) || !isNonEmptyStr(revision)) {
    throw failed(
      "TURN_NOT_VERIFIED",
      `${field} 缺少 session_id / source_revision：分源归属必须真实，不得用默认值伪造`,
    );
  }
  const evidence = {
    host: isNonEmptyStr(turn.host) ? turn.host : "dsh",
    session_id: sessionId,
    locator_kind: isNonEmptyStr(turn.turn_id) ? "turn_id" : "event_seq",
    branch_id: isNonEmptyStr(turn.branch_id) ? turn.branch_id : sessionId,
    source_revision: revision,
    availability: isNonEmptyStr(turn.availability) ? turn.availability : "available",
    turn: isInt(turn.turn) ? turn.turn : null,
    durability_evidence: { kind: "host_persistence_observation", revision },
  };
  if (evidence.locator_kind === "turn_id") evidence.turn_id = turn.turn_id;
  else {
    if (!isInt(turn.event_seq) || turn.event_seq < 0) {
      throw failed("INVALID_VALUE", `${field}.event_seq`, "locator_kind=event_seq 时 event_seq 必须是非负整数");
    }
    evidence.event_seq = turn.event_seq;
  }
  return {
    ok: true,
    usable: true,
    evidence,
    metadata: {
      surface_class: surfaceClass,
      message_source_kind: sourceKind,
      purpose: isNonEmptyStr(turn.purpose) ? turn.purpose : "current",
      event_seq: isInt(turn.event_seq) ? turn.event_seq : null,
    },
    turn,
  };
}

// --------------------------------------------------------------------------- //
// 5. 覆盖门槛（M3 coverage.js —— 唯一入口，不绕过）
// --------------------------------------------------------------------------- //
/**
 * 判定哪些请求范围**可分析**。
 *
 * 规则（M3 `planAdvance` 是唯一权威）：
 *   · 只有 `state==="processed"` 的单元可分析（切片完成 ≠ 分析完成，PRD §11.5 :1000）；
 *   · 与范围重叠的单元只要有任何一个不可推进 ⇒ 该范围**不可分析**，带出 `blocked_reason`；
 *   · 完全不被任何单元覆盖 ⇒ `RANGE_NOT_COVERED`；
 *   · 没有覆盖快照 / 覆盖快照没有来源门槛 ⇒ `COVERAGE_UNAVAILABLE`（不猜）。
 *
 * 返回 `{ok, analyzable:[...], blocked:[...], report}`；`ok:false` 表示**整个编译都不能继续**
 * （来源侧阻塞），调用方据此抛 `blocked` 错误。
 */
export function analyzableRanges({
  relevant_book_spans = [],
  coverage = null,
  requestedThroughSeq = null,
} = {}) {
  if (!isArr(relevant_book_spans) || relevant_book_spans.length === 0) {
    return { ok: true, analyzable: [], blocked: [], report: null, gate: null };
  }
  if (!isMap(coverage) || !isArr(coverage.units)) {
    return {
      ok: false,
      code: "COVERAGE_UNAVAILABLE",
      message: "缺少 coverage 快照（units）：无法判定哪些范围可分析，不得凭猜测生成提案",
      analyzable: [],
      blocked: [],
      report: null,
      gate: null,
    };
  }
  if (!isMap(coverage.source)) {
    return {
      ok: false,
      code: "COVERAGE_SOURCE_UNKNOWN",
      message: "coverage 快照未携带来源门槛（source）：不得假设来源已 ready",
      analyzable: [],
      blocked: [],
      report: null,
      gate: null,
    };
  }

  const gate = sourceBlockReason(coverage.source);
  const plan = planAdvance({
    units: coverage.units,
    source: coverage.source,
    watermark: coverage.watermark ?? null,
    requestedThroughSeq: requestedThroughSeq ?? coverage.requested_through_seq ?? null,
  });
  const byId = new Map();
  for (const d of plan.decisions ?? []) byId.set(d.unit_id, d);

  const analyzable = [];
  const blockedRanges = [];
  for (const span of relevant_book_spans) {
    const start = span?.start_codepoint;
    const end = span?.end_codepoint;
    if (!isInt(start) || !isInt(end) || !(end > start)) {
      return {
        ok: false,
        code: "INVALID_SPAN",
        message: `relevant_book_spans 含非法区间：${JSON.stringify({ start_codepoint: start, end_codepoint: end })}`,
        analyzable: [],
        blocked: [],
        report: null,
        gate,
      };
    }
    const overlapping = coverage.units.filter(
      (u) => isInt(u?.start_codepoint) && isInt(u?.end_codepoint) &&
        u.start_codepoint < end && start < u.end_codepoint,
    );
    if (overlapping.length === 0) {
      blockedRanges.push({
        span_id: span.span_id ?? null,
        section_id: span.section_id ?? null,
        code: "RANGE_NOT_COVERED",
        blocked_reason: "RANGE_NOT_COVERED",
        why_now: "该范围没有任何覆盖单元：不得对未分析范围生成提案",
        resume_condition: "先完成该范围的切片与分析，产生 processed 单元",
        fatal: true,
      });
      continue;
    }
    const bad = overlapping.find((u) => {
      if (u.state !== "processed") return true;
      if (isMap(u.window) && u.window_consumed !== true) return true;
      return false;
    });
    if (bad) {
      // 「窗口未真正消费」优先于 planAdvance 的 ALREADY_PROCESSED（后者只看 state）。
      const windowUnconsumed = isMap(bad.window) && bad.window_consumed !== true;
      const d = byId.get(bad.unit_id) ?? null;
      const code = windowUnconsumed
        ? "WINDOW_NOT_CONSUMED"
        : (d?.blocked_reason ?? d?.reason ?? `UNIT_${String(bad.state).toUpperCase()}`);
      blockedRanges.push({
        span_id: span.span_id ?? null,
        section_id: span.section_id ?? bad.section_id ?? null,
        unit_id: bad.unit_id ?? null,
        unit_state: bad.state ?? null,
        code,
        blocked_reason: code,
        why_now: windowUnconsumed
          ? "窗口尚未有「模型真正消费」的证据"
          : d?.why_now ?? `覆盖单元状态为 ${bad.state}，不计作分析完成`,
        resume_condition: windowUnconsumed
          ? "取得窗口消费回执后重试；失败窗口继续排队"
          : d?.resume_condition ?? "先让该单元推进到 processed",
        // 来源侧阻塞是**致命**的：整个编译停下，交回 WorkJob.blocked。
        fatal: windowUnconsumed ||
          code === "SOURCE_BLOCKED" || code === "WATERMARK_BLOCKS_ADVANCE" ||
          bad.state === "pending",
      });
      continue;
    }
    analyzable.push({
      span,
      span_id: span.span_id ?? null,
      section_id: span.section_id ?? null,
      unit_ids: overlapping.map((u) => u.unit_id ?? null),
    });
  }

  const fatalBlock = blockedRanges.find((b) => b.fatal === true);
  return {
    ok: fatalBlock ? false : true,
    code: fatalBlock?.code ?? null,
    message: fatalBlock
      ? `请求范围不可推进（${fatalBlock.blocked_reason}）：${fatalBlock.why_now}`
      : null,
    analyzable,
    blocked: blockedRanges,
    report: coverage.report ?? null,
    gate,
  };
}

// --------------------------------------------------------------------------- //
// 6. 查重门槛（dedup_check / snapshots / 追加召回）
// --------------------------------------------------------------------------- //
function assertSnapshots(request) {
  const checkId = request.dedup_check?.check_id;
  const list = request.current_note_snapshots_and_hashes ?? [];
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    const field = `current_note_snapshots_and_hashes[${i}]`;
    if (!isMap(s)) throw failed("INVALID_STRUCTURE", `${field} 必须是映射`);
    if (s.produced_by !== SNAPSHOT_PRODUCER) {
      throw failed(
        "SNAPSHOT_NOT_SERVICE_PRODUCED",
        `${field}.produced_by 必须是 "${SNAPSHOT_PRODUCER}"：snapshots 由 knowledge-search 的 search→exact read 产生、编排器注入，模型不能自报`,
      );
    }
    if (isNonEmptyStr(checkId) && s.check_id !== checkId) {
      throw failed(
        "SNAPSHOT_CHECK_MISMATCH",
        `${field}.check_id 与 dedup_check.check_id 不一致：快照必须来自同一次核对`,
      );
    }
    if (!isHash64(s.content_hash)) {
      throw failed("INVALID_VALUE", `${field}.content_hash`, "snapshot.content_hash 必须是 64 位十六进制");
    }
    if (!isNonEmptyStr(s.object_id) || !isNonEmptyStr(s.relative_path)) {
      throw failed("MISSING_REQUIRED", field, "snapshot 必须含 object_id 与 relative_path");
    }
  }
  return list;
}

/**
 * 查重门槛。返回 `{dedup, verified_candidates, conflicts, uncertainties}`。
 *
 * · `local_result=read_error` ⇒ **blocked**（核对失败，不是 no_change）；
 * · `local_result=partial`   ⇒ 调用 `requestAdditionalCandidates`（限既有 scope），随后
 *   **blocked**：追加召回由服务更新 check 与 snapshots 后**再**调用 compiler（PRD :981）；
 * · `local_result=matched`   ⇒ 必须用 `readCheckedNote(check_id, candidate_id)` **精确读取**，
 *   **hash 不替代内容核对**（PRD §8.5 DedupCheck）；读不到 ⇒ blocked/failed；
 *   声明 hash 与实读 hash 不一致 ⇒ 记 `conflict`（旧笔记被手改 ⇒ 先降 stale）。
 */
export async function runDedupGate(request, capabilities) {
  const dedup = request.dedup_check ?? {};
  const checkId = dedup.check_id;
  if (!isNonEmptyStr(checkId)) throw failed("MISSING_REQUIRED", "dedup_check.check_id", "check_id 必填");
  if (!isNonEmptyStr(dedup.input_fingerprint)) {
    throw failed("MISSING_REQUIRED", "dedup_check.input_fingerprint", "input_fingerprint 必填");
  }
  if (!hasOwn(dedup, "authorization_revision")) {
    throw failed("MISSING_REQUIRED", "dedup_check.authorization_revision", "authorization_revision 必填（无授权时 null）");
  }
  if (!VALUE_DOMAINS.dedup_local_result.includes(dedup.local_result)) {
    throw failed(
      "MISSING_REQUIRED",
      "dedup_check.local_result",
      `local_result 必须是 ${VALUE_DOMAINS.dedup_local_result.join(" / ")}（本区检查必须执行）`,
    );
  }
  if (!isMap(dedup.external_master)) {
    throw failed("MISSING_REQUIRED", "dedup_check.external_master", "external_master 必填");
  }

  const conflicts = [];
  const uncertainties = [];
  const verified = [];

  if (dedup.local_result === "read_error") {
    throw blocked("DEDUP_READ_ERROR", "本区查重读取失败：不得伪装成 no_change，也不得凭未读结果新建");
  }
  if (dedup.local_result === "partial") {
    // 追加召回只能在既有 scope 内执行；由服务更新 check 和 snapshots 后再调用 compiler。
    const candidates = dedup.candidate_refs ?? [];
    const query = {
      check_id: checkId,
      scope_id: request.consent_scope?.scope_id ?? null,
      query: request.consent_scope?.query ?? null,
      candidate_ids: candidates.map((c) => (isMap(c) ? c.candidate_id ?? c.object_id ?? null : null)).filter(Boolean),
    };
    await capabilities.requestAdditionalCandidates(checkId, query);
    throw blocked(
      "ADDITIONAL_RECALL_REQUIRED",
      "本区查重不完整：已请求追加召回，须由服务更新 check 与 snapshots 后再调用 compiler（PRD :981）",
      { query },
    );
  }

  if (dedup.local_result === "matched") {
    const candidates = dedup.candidate_refs ?? [];
    if (candidates.length === 0) {
      throw failed("INVALID_COMBINATION", "dedup_check.candidate_refs", "local_result=matched 却没有任何候选");
    }
    for (let i = 0; i < candidates.length; i++) {
      const cand = candidates[i];
      const field = `dedup_check.candidate_refs[${i}]`;
      if (!isMap(cand)) throw failed("INVALID_STRUCTURE", `${field} 必须是映射`);
      const candidateId = cand.candidate_id ?? cand.object_id;
      if (!isNonEmptyStr(candidateId)) throw failed("MISSING_REQUIRED", field, "候选必须含 candidate_id 或 object_id");
      let read;
      try {
        read = await capabilities.readCheckedNote(checkId, candidateId);
      } catch (e) {
        throw blocked("DEDUP_READ_ERROR", `精确读取候选失败：${e?.message ?? e}`, { candidate_id: candidateId });
      }
      if (!isMap(read) || read.ok !== true) {
        throw blocked(
          "DEDUP_READ_ERROR",
          `候选 ${candidateId} 无法精确读取：hash 不替代内容核对（PRD §8.5）`,
          { candidate_id: candidateId, read: read ?? null },
        );
      }
      if (!isHash64(read.content_hash)) {
        throw failed("INVALID_VALUE", `${field}.content_hash`, "精确读取必须返回 64 位 content_hash");
      }
      const declared = isHash64(cand.content_hash) ? cand.content_hash : null;
      if (declared !== null && declared !== read.content_hash) {
        // 旧笔记被手改 ⇒ 先降 unverified+stale，再按权限重读（PRD §8.5）。
        conflicts.push({
          candidate_id: candidateId,
          object_id: cand.object_id ?? read.object_id ?? null,
          reason: "SNAPSHOT_HASH_MISMATCH",
          declared_hash: declared,
          observed_hash: read.content_hash,
          disposition: "stale",
        });
        uncertainties.push(`候选 ${candidateId} 的 snapshot hash 与实读不一致：该快照降为 stale，不作为本次去重依据`);
        verified.push({ candidate_id: candidateId, object_id: cand.object_id ?? null, relative_path: cand.relative_path ?? null, content_hash: read.content_hash, stale: true, source: read });
      } else {
        verified.push({ candidate_id: candidateId, object_id: cand.object_id ?? read.object_id ?? null, relative_path: cand.relative_path ?? read.relative_path ?? null, content_hash: read.content_hash, stale: false, source: read });
      }
    }
  }

  const em = dedup.external_master;
  if (em.outcome === "not_checked" || em.outcome === "not_authorized") {
    uncertainties.push(`外区主笔记核对未执行（${em.outcome}）：不得据此声称无主笔记`);
  } else if (em.outcome === "stale" || em.outcome === "read_error" || em.outcome === "partial") {
    uncertainties.push(`外区主笔记核对不完整（${em.outcome}）：不得沿用「已核对」结论`);
    conflicts.push({ reason: "EXTERNAL_MASTER_INCOMPLETE", outcome: em.outcome });
  } else if (em.outcome === "no_match") {
    if (!isArr(em.scope_refs) || em.scope_refs.length === 0) {
      throw failed(
        "INVALID_COMBINATION",
        "dedup_check.external_master.scope_refs",
        "no_match 必须列明实际检查的 scope_refs，否则不得声称无匹配",
      );
    }
  }

  return { dedup, verified_candidates: verified, conflicts, uncertainties };
}

// --------------------------------------------------------------------------- //
// 7. 归属三分离：草稿 → operation
// --------------------------------------------------------------------------- //
/**
 * 归属校验（PRD :483）。**模型不能**做这些事：
 *   · 自己声明 `confirmed`/`retracted`（确认动作由提交器单独验证后填入）；
 *   · 自带 `confirmation_evidence`；
 *   · 把 AI 假设的命题作者改成 `user`；
 *   · 没有真人来源却声明 `origin=user`；
 *   · 声明 `book_author` 却没有书证据。
 *
 * 返回 `{ok, errors, normalized}`；`normalized` 是**规范化后**的归属字段。
 */
export function validateAttribution(draft, ctx = {}) {
  const errors = [];
  const push = (code, field, message) => errors.push({ code, field, message });
  const semantic = SEMANTIC_OBJECT_TYPES.includes(draft?.object_type);
  const origin = draft?.origin ?? null;
  const confirmation = draft?.confirmation ?? null;

  if (semantic) {
    if (origin === null || origin === undefined) push("MISSING_REQUIRED", "origin", "语义 operation 必填 origin（命题作者）");
    else if (!VALUE_DOMAINS.origin.includes(origin)) push("INVALID_ENUM", "origin", `origin 只能是 ${VALUE_DOMAINS.origin.join(" / ")}`);
    if (confirmation === null || confirmation === undefined) push("MISSING_REQUIRED", "confirmation", "语义 operation 必填 confirmation");
    else if (!VALUE_DOMAINS.confirmation.includes(confirmation)) {
      push("INVALID_ENUM", "confirmation", `confirmation 只能是 ${VALUE_DOMAINS.confirmation.join(" / ")}`);
    }
  }

  // ① 模型不能生成有效确认动作（PRD :483「模型不能生成有效动作」）。
  if (confirmation === "confirmed" || confirmation === "retracted") {
    push(
      "MODEL_CANNOT_CONFIRM",
      "confirmation",
      `编译器产出的候选最初必须是 unconfirmed；${confirmation} 需要提交器核验真实 actor/action_id/at/scope`,
    );
  }
  if (draft?.confirmation_evidence !== null && draft?.confirmation_evidence !== undefined) {
    push(
      "MODEL_CANNOT_SUPPLY_CONFIRMATION_EVIDENCE",
      "confirmation_evidence",
      "模型不能生成确认证据；保存许可不等于内容确认",
    );
  }

  // ② AI 命题不能因「被确认」变成用户事实（PRD :483）。
  const aiAuthored = origin === "ai_inference" ||
    draft?.kind === "ai_hypothesis" ||
    draft?.assessment_basis === "ai_hypothesis";
  if (draft?.user_confirmed_ai === true || draft?.confirmed_from_ai === true) {
    push(
      "CONFIRMING_AI_DOES_NOT_MAKE_USER_FACT",
      "origin",
      "用户确认 AI 假设后 origin 仍不变；用户另行表达自己判断须建独立的 user 记录 + derived_from 关系",
    );
  }
  if (aiAuthored && origin === "user") {
    push("AI_CANNOT_BECOME_USER_FACT", "origin", "AI 推演的命题作者是 ai_inference，不得写成 user");
  }

  // ③ origin=user 必须有真实真人来源；引用/转贴不变成用户自述。
  const userRefs = (draft?.source_refs ?? []).filter((r) => r?.source_kind === "user_action");
  if (origin === "user") {
    const humanTurns = ctx.human_turns ?? [];
    const knownActions = ctx.known_user_actions ?? [];
    const realAction = userRefs.some((r) =>
      knownActions.some((a) => a.action_id === r?.ref?.action_id && a.actor === r?.ref?.actor));
    if (!realAction && humanTurns.length === 0) {
      push(
        "USER_ORIGIN_REQUIRES_HUMAN_SOURCE",
        "origin",
        "origin=user 需要真实真人来源（source.kind=user 的已核验轮次，或服务给出的真实 user_action）；引用/转贴不变成用户自述",
      );
    }
    if (userRefs.length > 0 && !realAction) {
      push(
        "MODEL_CANNOT_SUPPLY_USER_ACTION",
        "source_refs",
        "user_action 引用必须来自服务回执；模型不能自报用户动作",
      );
    }
  }

  // ④ book_author 必须有书证据。
  if (origin === "book_author") {
    const be = draft?.book_evidence;
    if (!isArr(be) || be.length === 0) {
      push("MISSING_REQUIRED", "book_evidence", "origin=book_author 必须有非空 book_evidence（书内事实绑定版本/span）");
    }
  }

  // ⑤ 摘要不能成为证据：任何引用了摘要类来源的草稿都要挡。
  const summaryRefs = (draft?.source_refs ?? []).filter(
    (r) => isNonEmptyStr(r?.ref?.message_source_kind) && NON_EVIDENCE_SOURCE_KINDS.includes(r.ref.message_source_kind),
  );
  if (summaryRefs.length > 0 || draft?.from_summary === true) {
    push("SUMMARY_IS_NOT_EVIDENCE", "source_refs", "压缩摘要/compact-checkpoint 只能导航，不能成为证据");
  }

  return {
    ok: errors.length === 0,
    errors,
    normalized: {
      ...(semantic ? { origin, confirmation: confirmation === "unconfirmed" ? "unconfirmed" : confirmation } : {}),
    },
  };
}

// --------------------------------------------------------------------------- //
// 8. 草稿 → operation（类型/证据/hash/范围/预算）
// --------------------------------------------------------------------------- //
function verifyBookEvidence(refs, ctx) {
  const errors = [];
  for (let i = 0; i < refs.length; i++) {
    const r = refs[i];
    if (!isMap(r) || r.source_kind !== "book_span") {
      errors.push({ code: "INVALID_SOURCE_REF", field: `book_evidence[${i}]`, message: "book_evidence 只接受 source_kind=book_span 的引用" });
      continue;
    }
    const spanId = r.ref?.span_id;
    const known = ctx.book_spans.find((s) => s.span_id === spanId && s.verified === true);
    if (!known) {
      errors.push({
        code: "UNVERIFIED_BOOK_SPAN",
        field: `book_evidence[${i}]`,
        message: `书证据 ${spanId} 未经 readSourceSpan 核验，或不在本次 relevant_book_spans 内`,
      });
    }
  }
  return errors;
}

function verifySessionEvidence(refs, ctx) {
  const errors = [];
  for (let i = 0; i < refs.length; i++) {
    const r = refs[i];
    if (!isMap(r) || r.source_kind !== "host_turn") {
      errors.push({ code: "INVALID_SOURCE_REF", field: `session_evidence[${i}]`, message: "session_evidence 只接受 source_kind=host_turn 的引用" });
      continue;
    }
    const ev = r.ref ?? {};
    const match = ctx.session_evidence.find(
      (e) => e.session_id === ev.session_id && e.source_revision === ev.source_revision &&
        (e.event_seq === ev.event_seq || (e.turn_id && e.turn_id === ev.turn_id)),
    );
    if (!match) {
      errors.push({
        code: "UNVERIFIED_SESSION_EVIDENCE",
        field: `session_evidence[${i}]`,
        message: "会话证据不在本次 effective_turns_in_memory（已核验片段）内：不得虚构宿主轮次",
      });
    }
  }
  return errors;
}

/**
 * `source_refs` 的通用核验：四种 `source_kind` 都只认真实来源。
 *   · `book_span`      ⇒ 必须在本批已核验 span 内；
 *   · `host_turn`      ⇒ 必须在本批已核验会话片段内；
 *   · `knowledge_note` ⇒ 必须经 `readCheckedNote` 精确读取（**hash 不替代内容核对**）；
 *   · `user_action`    ⇒ 必须来自服务回执（模型不能自报）。
 */
function verifySourceRefs(refs, ctx) {
  const errors = [];
  for (let i = 0; i < refs.length; i++) {
    const r = refs[i];
    const field = `source_refs[${i}]`;
    if (!isMap(r) || !VALUE_DOMAINS.source_ref_kind.includes(r.source_kind)) {
      errors.push({ code: "INVALID_SOURCE_REF", field, message: "source_refs 每项必须是合法的 SourceRef（source_kind 值域非法）" });
      continue;
    }
    if (r.source_kind === "book_span") {
      const known = ctx.book_spans.find((s) => s.span_id === r.ref?.span_id);
      if (!known) errors.push({ code: "UNVERIFIED_BOOK_SPAN", field, message: `书内引用 ${r.ref?.span_id} 未经 readSourceSpan 核验` });
    } else if (r.source_kind === "host_turn") {
      const ev = r.ref ?? {};
      const match = ctx.session_evidence.find(
        (e) => e.session_id === ev.session_id && e.source_revision === ev.source_revision &&
          (e.event_seq === ev.event_seq || (e.turn_id && e.turn_id === ev.turn_id)),
      );
      if (!match) errors.push({ code: "UNVERIFIED_SESSION_EVIDENCE", field, message: "会话引用不在本次已核验片段内" });
    } else if (r.source_kind === "knowledge_note") {
      const known = ctx.verified_candidates.find(
        (c) => c.object_id === r.ref?.object_id || c.relative_path === r.ref?.relative_path,
      );
      if (!known) {
        errors.push({
          code: "UNVERIFIED_NOTE_REF",
          field,
          message: "笔记引用未经精确读取（readCheckedNote），hash 不替代内容核对",
        });
      } else if (known.stale) {
        errors.push({ code: "STALE_SNAPSHOT", field, message: "该笔记快照已因 hash 变化降为 stale，不得作为本次依据" });
      }
    } else if (r.source_kind === "user_action") {
      const okAction = (ctx.known_user_actions ?? []).some(
        (a) => a?.action_id === r.ref?.action_id && a?.actor === r.ref?.actor,
      );
      if (!okAction) errors.push({ code: "MODEL_CANNOT_SUPPLY_USER_ACTION", field, message: "user_action 引用必须来自服务回执" });
    }
  }
  return errors;
}

/**
 * 把模型草稿编译成一条 operation，或给出拒绝原因。
 *
 * 硬约束：
 *   · `create` ⇒ `base_hash=null` 且**目标不存在**；
 *   · `update` ⇒ `base_hash` 必须等于**实读** hash（不得自报）；
 *   · `link`  ⇒ 只更新 45 内引用，**不写外区**；
 *   · 短内容受 `summary_budget` 限制（不搬完整会话）。
 */
export function compileOperation(draft, ctx = {}) {
  const errors = [];
  const push = (code, field, message) => errors.push({ code, field, message });
  if (!isMap(draft)) return { ok: false, errors: [{ code: "INVALID_STRUCTURE", field: "operation", message: "草稿必须是映射" }] };

  if (!VALUE_DOMAINS.operation_type.includes(draft.type)) {
    push("INVALID_ENUM", "type", `operation.type 只能是 ${VALUE_DOMAINS.operation_type.join(" / ")}`);
  }
  if (!OBJECT_TYPES.includes(draft.object_type)) {
    push("INVALID_ENUM", "object_type", "object_type 必须是 15 个正式对象之一");
  }

  const attr = validateAttribution(draft, ctx);
  errors.push(...attr.errors);

  // ---- 短内容与预算 ----
  const budget = ctx.summary_budget ?? DEFAULT_SUMMARY_BUDGET;
  if (!isNonEmptyStr(draft.short_content)) {
    push("MISSING_REQUIRED", "short_content", "operation 必须带短内容（不搬完整会话）");
  } else if (isInt(budget.max_short_content_chars) && draft.short_content.length > budget.max_short_content_chars) {
    push(
      "BUDGET_EXCEEDED",
      "short_content",
      `短内容长度 ${draft.short_content.length} 超过 summary_budget.max_short_content_chars=${budget.max_short_content_chars}`,
    );
  }

  // ---- 权限范围 ----
  const consent = ctx.consent_scope ?? {};
  if (isArr(consent.allowed_object_types) && consent.allowed_object_types.length > 0 &&
      !consent.allowed_object_types.includes(draft.object_type)) {
    push("OUT_OF_SCOPE", "object_type", `object_type=${draft.object_type} 不在 consent_scope.allowed_object_types 内`);
  }
  if (consent.can_write === false) {
    push("OUT_OF_SCOPE", "consent_scope", "consent_scope.can_write=false：本次没有写权限");
  }

  const snapshots = ctx.snapshots ?? [];
  const candidateIds = new Set(ctx.verified_candidates.map((c) => c.object_id).filter(Boolean));
  const snapshotIds = new Set(snapshots.map((s) => s.object_id).filter(Boolean));
  const targetId = draft.target_object_id ?? null;

  if (draft.type === "create") {
    if (draft.base_hash !== null && draft.base_hash !== undefined) {
      push("INVALID_COMBINATION", "base_hash", "新建 base_hash 必须为 null，并要求目标不存在");
    }
    if (!isNonEmptyStr(targetId)) push("MISSING_REQUIRED", "target_object_id", "create 必须给出目标对象 ID");
    if (isNonEmptyStr(targetId) && (candidateIds.has(targetId) || snapshotIds.has(targetId))) {
      push("CREATE_TARGET_EXISTS", "target_object_id", `目标 ${targetId} 已存在：create 要求目标不存在`);
    }
    const localResult = ctx.dedup?.local_result ?? null;
    if (localResult === "matched" && !isNonEmptyStr(draft.new_note_reason)) {
      push(
        "INVALID_COMBINATION",
        "new_note_reason",
        "本区已有匹配对象却新建，必须说明 new_note_reason（不得为绕过确认重复建同义页）",
      );
    }
  } else if (draft.type === "update") {
    if (!isHash64(draft.base_hash)) {
      push("MISSING_REQUIRED", "base_hash", "更新必须带实读的 base_hash（64 位十六进制）");
    } else {
      const known = ctx.verified_candidates.find((c) => c.object_id === targetId) ??
        (snapshots.find((s) => s.object_id === targetId) ?? null);
      if (!known) {
        push("UPDATE_REQUIRES_READ_HASH", "target_object_id", "更新目标未经精确读取：不得凭空写 base_hash");
      } else if (known.content_hash !== draft.base_hash) {
        push(
          "BASE_HASH_MISMATCH",
          "base_hash",
          `base_hash 与实读 hash 不一致（实读 ${known.content_hash}）：hash 保护要求以实读为准`,
        );
      }
      const vc = ctx.verified_candidates.find((c) => c.object_id === targetId);
      if (vc && vc.stale) push("STALE_SNAPSHOT", "target_object_id", "目标快照已 stale（hash 变化），须重读后再更新");
    }
  } else if (draft.type === "link") {
    if (!isNonEmptyStr(targetId)) push("MISSING_REQUIRED", "target_object_id", "link 必须给出目标对象 ID");
    if (isNonEmptyStr(targetId) && !candidateIds.has(targetId) && !snapshotIds.has(targetId)) {
      push("LINK_TARGET_UNKNOWN", "target_object_id", `link 目标 ${targetId} 不在已核对对象内`);
    }
    for (const r of draft.source_refs ?? []) {
      if (r?.source_kind === "knowledge_note" && isNonEmptyStr(r?.ref?.relative_path) &&
          !String(r.ref.relative_path).startsWith(READING_ROOT)) {
        push("OUT_OF_SCOPE", "source_refs", `link 只更新 45 内引用，不写外区：${r.ref.relative_path}`);
      }
    }
  }

  // ---- 证据 ----
  const bookEvidence = draft.book_evidence ?? [];
  if (!isArr(bookEvidence)) push("INVALID_STRUCTURE", "book_evidence", "book_evidence 必须是数组");
  else errors.push(...verifyBookEvidence(bookEvidence, ctx));

  const sessionEvidence = draft.session_evidence ?? [];
  if (!isArr(sessionEvidence)) push("INVALID_STRUCTURE", "session_evidence", "session_evidence 必须是数组");
  else errors.push(...verifySessionEvidence(sessionEvidence, ctx));

  const sourceRefs = draft.source_refs ?? [];
  if (!isArr(sourceRefs)) push("INVALID_STRUCTURE", "source_refs", "source_refs 必须是数组");
  else errors.push(...verifySourceRefs(sourceRefs, ctx));

  // ---- understanding_observation 专有 ----
  if (draft.object_type === "understanding_observation") {
    if (!isArr(draft.concept_refs) || draft.concept_refs.length === 0) {
      push("MISSING_REQUIRED", "concept_refs", "理解变化 operation 必须带非空 concept_refs");
    }
    if (draft.dimension === null || draft.dimension === undefined) push("MISSING_REQUIRED", "dimension", "理解变化 operation 必填 dimension");
    else if (!VALUE_DOMAINS.dimension.includes(draft.dimension)) push("INVALID_ENUM", "dimension", "dimension 值域非法");
    if (draft.change_kind === null || draft.change_kind === undefined) push("MISSING_REQUIRED", "change_kind", "理解变化 operation 必填 change_kind");
    else if (!VALUE_DOMAINS.change_kind.includes(draft.change_kind)) push("INVALID_ENUM", "change_kind", "change_kind 值域非法");
    if (!isNonEmptyStr(draft.after)) push("MISSING_REQUIRED", "after", "理解变化 operation 的 after 必须是非空短述");
    if (!isArr(draft.after_source_refs) || draft.after_source_refs.length === 0) {
      push("MISSING_REQUIRED", "after_source_refs", "after_source_refs 必须非空");
    }
    if (draft.before === null || draft.before === undefined) {
      // before 未知时 null 及空前引用，说明未知（不伪造「过去想法」）。
      if (isArr(draft.before_source_refs) && draft.before_source_refs.length > 0) {
        push("INVALID_COMBINATION", "before_source_refs", "before=null 时前引用必须为空（不得伪造「过去想法」）");
      }
    }
  }

  // ---- external_master ----
  // 复用 M1 的**同一套**组合约束（7 种合法组合）；未执行核对不得声称 no_match。
  if (!isMap(draft.external_master)) {
    push("MISSING_REQUIRED", "external_master", "operation 必须带 external_master（PRD §8.5）");
  } else {
    const emCtx = { errors: [], draft: false };
    checkExternalMaster(draft.external_master, "external_master", emCtx);
    for (const e of emCtx.errors) push(e.code, e.field, e.message);
  }

  if (errors.length > 0) return { ok: false, errors };

  const operation = {
    operation_id: isNonEmptyStr(draft.operation_id) ? draft.operation_id : null,
    type: draft.type,
    object_type: draft.object_type,
    target_object_id: targetId,
    base_hash: draft.type === "create" ? null : (draft.base_hash ?? null),
    short_content: draft.short_content,
    book_evidence: bookEvidence,
    session_evidence: sessionEvidence,
    source_refs: sourceRefs,
    matched_object_ids: isArr(draft.matched_object_ids)
      ? draft.matched_object_ids
      : ctx.verified_candidates.map((c) => c.object_id).filter(Boolean),
    external_master: draft.external_master,
    ...(SEMANTIC_OBJECT_TYPES.includes(draft.object_type)
      ? { origin: draft.origin, confirmation: "unconfirmed" }
      : {}),
    ...(isNonEmptyStr(draft.new_note_reason) ? { new_note_reason: draft.new_note_reason } : {}),
    ...(draft.object_type === "understanding_observation"
      ? {
          concept_refs: draft.concept_refs,
          dimension: draft.dimension,
          change_kind: draft.change_kind,
          before: draft.before ?? null,
          after: draft.after,
          before_source_refs: draft.before_source_refs ?? [],
          after_source_refs: draft.after_source_refs,
          assessment_basis: draft.assessment_basis ?? null,
        }
      : {}),
    ...(isArr(draft.relations) ? { relations: draft.relations } : {}),
  };
  return { ok: true, errors: [], operation };
}

// --------------------------------------------------------------------------- //
// 9. 来源范围 / 提案文档 / 回执
// --------------------------------------------------------------------------- //
/** 规范化的来源范围字符串（回执要求**非空字符串**；提案也复用它，保持可核对）。 */
export function canonicalSourceRange(request) {
  const parts = [];
  for (const s of request.relevant_book_spans ?? []) {
    parts.push(`book:${s.book_version_id ?? "?"}:${s.section_id ?? "?"}:${s.span_id ?? "?"}[${s.start_codepoint},${s.end_codepoint})`);
  }
  for (const r of request.host_source_refs ?? []) {
    parts.push(`session:${r.session_id}@${r.source_revision}${isInt(r.through_seq) ? `#${r.through_seq}` : ""}`);
  }
  if (parts.length === 0) parts.push("empty_scope");
  return parts.join("|");
}

function isoNow(now) {
  const v = typeof now === "function" ? now() : now;
  const s = v instanceof Date ? v.toISOString() : String(v);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(s)) {
    throw failed("INVALID_CLOCK", `时钟返回值不是 ISO 时间：${s}`);
  }
  return s;
}

/**
 * 组装 ChangeProposal 的 frontmatter，并用 M1 `validateNote()` **自检**。
 *
 * `application_mode` **默认 manual**；要写 `authorized_auto`，必须由**提交器**先通过
 * `validateAuthorizedAuto()`，并以 `submitter_verified:true` 显式确认。编译器自己永远给 manual。
 */
export function buildChangeProposal(result, options = {}) {
  const {
    job_id,
    proposal_id,
    input_fingerprint,
    dedup_check,
    source_range = null,
    state = "draft",
    application_mode = COMPILER_APPLICATION_MODE,
    authorization_ref = null,
    submitter_verified = false,
    generated_by,
    now = null,
    title = "阅读知识变更提案",
    tags = ["reading", "proposal"],
    scope = "reading",
    knowledge_status = "active",
    revision = 1,
  } = options;

  if (!isMap(result) || !COMPILE_OUTCOMES.includes(result.outcome)) {
    throw failed("INVALID_ARGUMENT", "buildChangeProposal 需要合法的 CompileResult");
  }
  if (result.outcome !== "proposal") {
    throw failed("INVALID_ARGUMENT", "no_change 结果没有提案文档；请用 buildNoChangeReceipt()");
  }
  const top = compilerMetadataToTopLevel(result.compiler_metadata);
  if (!isNonEmptyStr(proposal_id)) throw failed("MISSING_REQUIRED", "proposal_id", "proposal_id 必填");
  if (!isNonEmptyStr(job_id)) throw failed("MISSING_REQUIRED", "job_id", "job_id 必填");
  if (!isNonEmptyStr(input_fingerprint)) throw failed("MISSING_REQUIRED", "input_fingerprint", "input_fingerprint 必填");
  if (!isMap(dedup_check)) throw failed("MISSING_REQUIRED", "dedup_check", "提案必须带完整 dedup_check");
  if (dedup_check.check_id !== result.dedup_check_ref) {
    throw failed("INVALID_COMBINATION", "dedup_check.check_id", "dedup_check 必须与 dedup_check_ref 同一次核对");
  }

  // 自动模式只能由提交器赋予；编译器自己绝不选它（PRD :472）。
  if (application_mode === "authorized_auto") {
    if (submitter_verified !== true) {
      throw failed(
        "MODEL_MUST_NOT_CHOOSE_APPLICATION_MODE",
        "application_mode=authorized_auto 必须由提交器校验授权后赋予（submitter_verified:true）；模型不得自选自动模式",
      );
    }
    if (!isMap(authorization_ref)) {
      throw failed("MISSING_REQUIRED", "authorization_ref", "authorized_auto 必须引用真实启用动作 authorization_ref");
    }
    // 提交器即便自称已核验，也要过**同一套**校验（真实启用动作 + scope + 只准新建）。
    const auth = validateAuthorizedAuto({
      authorization_ref,
      enabled_actions: options.enabled_actions ?? [],
      operations: result.operations,
      consent_scope: options.consent_scope ?? null,
    });
    if (!auth.ok) {
      throw failed("AUTHORIZATION_INVALID", `authorized_auto 的授权引用未通过校验：${auth.errors[0]?.message ?? ""}`, {
        errors: auth.errors,
      });
    }
  } else if (application_mode === "manual") {
    if (authorization_ref !== null && authorization_ref !== undefined) {
      throw failed("INVALID_COMBINATION", "authorization_ref", "manual 模式的 authorization_ref 必须为 null");
    }
  } else {
    throw failed("INVALID_ENUM", "application_mode", "application_mode 只能是 manual / authorized_auto");
  }

  const created = now === null ? isoNow(() => new Date().toISOString()) : isoNow(now);

  // `generated_by` 显式校验：键名必须是 {compiler,version}（不是 {name,version}），
  // 且未知/半填时**省略整个字段**（由 resolveGeneratedBy 统一裁决）。
  const gb = resolveGeneratedBy({ generated_by: generated_by ?? null });

  // M1 schema 要求 authorization_ref.scope 是**非空字符串**；这里把数组写法规范化。
  const normalizedAuthRef = application_mode === "authorized_auto"
    ? {
        actor: authorization_ref.actor,
        action_id: authorization_ref.action_id,
        scope: normalizeAuthorizationScope(authorization_ref.scope),
        revision: authorization_ref.revision,
      }
    : null;

  const data = {
    schema_version: SCHEMA_VERSION,
    object_type: "change_proposal",
    id: proposal_id,
    revision,
    title,
    tags,
    scope,
    knowledge_status,
    created_at: created,
    updated_at: created,
    proposal_id,
    job_id,
    state,
    application_mode,
    authorization_ref: normalizedAuthRef,
    input_fingerprint,
    source_range: source_range ?? "unspecified",
    dedup_check,
    operations: result.operations,
    uncertainties: result.uncertainties,
    // ★ 顶层 compiler：{name, version}，**不是** generated_by 的子字段。
    compiler: { name: top.name, version: top.version },
  };
  // ★ generated_by：不同键名 {compiler, version}；未提供时**整个字段省略**（不补造）。
  if (gb !== undefined) {
    data.generated_by = gb;
  }

  const check = validateNote(data, { mode: "formal", objectType: "change_proposal", domain: BOOK_DOMAIN });
  if (!check.ok) {
    throw failed("PROPOSAL_SELF_CHECK_FAILED", `提案未通过 M1 validateNote 自检：${check.errors[0]?.message ?? ""}`, {
      errors: check.errors,
    });
  }
  return { ok: true, data, errors: [] };
}

/**
 * `no_change` 的**耐久最小回执**（PRD §8.7）：含 check 与来源范围，不含正文。
 * 复用 M1 的 `validateNoChangeReceipt()`，键集合闭合。
 */
export function buildNoChangeReceipt(result, { source_range, check_id } = {}) {
  if (!isMap(result) || result.outcome !== "no_change") {
    throw failed("INVALID_ARGUMENT", "buildNoChangeReceipt 需要 outcome=no_change 的结果");
  }
  const receipt = {
    check_id: check_id ?? result.dedup_check_ref,
    source_range: source_range ?? null,
    outcome: "no_change",
  };
  const check = validateNoChangeReceipt(receipt);
  if (!check.ok) {
    throw failed("NO_CHANGE_RECEIPT_INVALID", `no_change 回执不合法：${check.errors[0]?.message ?? ""}`, { errors: check.errors });
  }
  return receipt;
}

// --------------------------------------------------------------------------- //
// 10. 提交器侧：authorized_auto 的授权校验（编译器不选，提交器校验）
// --------------------------------------------------------------------------- //
/** 授权 scope 的合法片段（PRD :472：scope 限定对象 / 新建操作 / 45 路径）。 */
export const AUTHORIZATION_SCOPE_TOKENS = Object.freeze(["object", "create", "45", "reading"]);

/**
 * 规范化授权 scope。
 *
 * M1 `schema.js` 要求 `authorization_ref.scope` 是**非空字符串**，而调用方常按数组表达
 * 「对象 + 新建 + 45 路径」。这里统一成 `+` 连接的字符串（唯一权威形状是字符串），
 * 数组只是书写便利。
 */
export function normalizeAuthorizationScope(scope) {
  if (isArr(scope)) return scope.map((s) => String(s).trim()).filter(Boolean).join("+");
  if (isStr(scope)) return scope.trim();
  return null;
}

/**
 * **提交器**用它校验自动路径（PRD :472）。模型不得自选自动模式；此函数只回答
 * 「这次授权是否真的能支撑 authorized_auto」，不改变任何归属。
 *
 * 必须同时满足：
 *   · `authorization_ref` 形状 `{actor, action_id, scope, revision}` 齐备；
 *   · 引用的动作在**真实启用动作**清单里（`enabled_actions`）；
 *   · scope 限定为「对象 / 新建操作 / 45 路径」；
 *   · 只准**低风险新建**（`operations` 全是 create）；
 *   · 该引用**不是** `confirmation_evidence`。
 */
export function validateAuthorizedAuto({
  authorization_ref,
  enabled_actions = [],
  operations = [],
  consent_scope = null,
} = {}) {
  const errors = [];
  const push = (code, field, message) => errors.push({ code, field, message });
  if (!isMap(authorization_ref)) {
    push("MISSING_REQUIRED", "authorization_ref", "authorized_auto 必须引用 {actor, action_id, scope, revision}");
    return { ok: false, errors };
  }
  for (const k of ["actor", "action_id", "revision"]) {
    if (!isNonEmptyStr(authorization_ref[k])) push("MISSING_REQUIRED", `authorization_ref.${k}`, `authorization_ref.${k} 必填`);
  }
  const scopeStr = normalizeAuthorizationScope(authorization_ref.scope);
  if (!isNonEmptyStr(scopeStr)) {
    push("MISSING_REQUIRED", "authorization_ref.scope", "authorization_ref.scope 必填（字符串或数组，非空）");
  } else {
    for (const s of scopeStr.split("+")) {
      if (!AUTHORIZATION_SCOPE_TOKENS.includes(s)) {
        push(
          "AUTHORIZATION_SCOPE_INVALID",
          "authorization_ref.scope",
          `scope 只能限定对象/新建操作/45 路径，得到 ${JSON.stringify(s)}`,
        );
      }
    }
  }
  const action = (enabled_actions ?? []).find(
    (a) => a?.action_id === authorization_ref.action_id && a?.enabled === true,
  );
  if (!action) {
    push("AUTHORIZATION_NOT_ENABLED", "authorization_ref.action_id", "引用的动作不是真实启用动作");
  } else if (isNonEmptyStr(scopeStr)) {
    const actionScope = normalizeAuthorizationScope(action.scope);
    if (isNonEmptyStr(actionScope)) {
      const allowedByAction = new Set(actionScope.split("+"));
      for (const s of scopeStr.split("+")) {
        if (!allowedByAction.has(s)) {
          push("AUTHORIZATION_SCOPE_ESCALATION", "authorization_ref.scope", `请求 scope「${s}」超出该启用动作的授权范围`);
        }
      }
    }
  }
  if (isArr(operations) && operations.some((op) => op?.type !== "create")) {
    push("AUTO_MODE_ONLY_LOW_RISK_CREATE", "operations", "自动路径只准低风险新建（全部 operation.type=create）");
  }
  if (consent_scope && consent_scope.can_write === false) {
    push("OUT_OF_SCOPE", "consent_scope", "consent_scope.can_write=false：没有写权限");
  }
  if (authorization_ref.is_confirmation_evidence === true) {
    push("AUTHORIZATION_IS_NOT_CONFIRMATION", "authorization_ref", "授权引用不是 confirmation_evidence，不能替代内容确认");
  }
  return { ok: errors.length === 0, errors };
}

// --------------------------------------------------------------------------- //
// 11. 结果 → 任务映射（PRD :966-967）
// --------------------------------------------------------------------------- //
/**
 * `CompileResult` → `WorkJob` 映射。
 *
 * PRD :966：`proposal` ⇒ `manual` 可 `pending_review`；`authorized_auto` 须 accept 事务完成为
 * `accepted` 后才报告观察已保存；**两者均不自动确认语义**。
 */
export function mapCompileResultToJob(result, { application_mode = COMPILER_APPLICATION_MODE, accept_transaction_state = null } = {}) {
  if (!isMap(result) || !COMPILE_OUTCOMES.includes(result.outcome)) {
    throw failed("INVALID_ARGUMENT", "mapCompileResultToJob 需要合法的 CompileResult");
  }
  if (result.outcome === "no_change") {
    return {
      kind: "extract_knowledge",
      result_outcome: "no_change",
      proposal_state: null,
      observation_saved: false,
      semantics_confirmed: false,
      receipt_required: true,
    };
  }
  if (application_mode === "authorized_auto") {
    const accepted = accept_transaction_state === "committed" || accept_transaction_state === "accepted";
    return {
      kind: "extract_knowledge",
      result_outcome: "proposal",
      proposal_state: accepted ? "accepted" : "applying",
      // 只有 accept 事务完成才报告「观察已保存」。
      observation_saved: accepted,
      semantics_confirmed: false,
    };
  }
  return {
    kind: "extract_knowledge",
    result_outcome: "proposal",
    proposal_state: "pending_review",
    observation_saved: false,
    semantics_confirmed: false,
  };
}

/** 错误 → 任务映射：**永不**返回 `no_change`（PRD :966 明令禁止伪装）。 */
export function mapErrorToJob(err) {
  const state = err instanceof CompilerError ? err.work_job_state : "failed";
  return {
    kind: "extract_knowledge",
    state,
    result_outcome: null,
    reason_code: err?.code ?? "UNKNOWN_ERROR",
    message: err?.message ?? String(err),
    disguised_as_no_change: false,
  };
}

/** 编译器的 cursor 效果：**永不推进**（PRD :981）。 */
export function compileCursorEffect() {
  return { ...CURSOR_EFFECT };
}

// --------------------------------------------------------------------------- //
// 12. KnowledgeCompiler
// --------------------------------------------------------------------------- //
export class KnowledgeCompiler {
  constructor({ now = null } = {}) {
    this._now = now;
  }

  /**
   * PRD §11.4 :939：`KnowledgeCompiler.propose(request, capabilities) -> CompileResult`
   *
   * 步骤（每一步失败都带 `work_job_state`，**不伪装 no_change**）：
   *   ① request 形状 → ② 编译器身份 → ③ 宿主能力 → ④ 会话门槛 → ⑤ 覆盖门槛
   *   → ⑥ 查重门槛 → ⑦ 模型草稿 → ⑧ 归属/类型/hash/范围校验 → ⑨ 提案自检 → ⑩ 结果
   */
  async propose(request, capabilities) {
    // ① 形状
    assertRequest(request);
    // ② 身份：未知 ⇒ 阻止生成可接受提案（不是填占位符）
    const metadata = this.resolveMetadata(request.compiler_config);
    // ③ 能力
    assertCapabilities(capabilities);
    // ④ 会话门槛
    const session = checkSessionGate(request);
    const turns = [];
    const uncertainties = [];
    const dropped = [];
    for (let i = 0; i < (session.turns ?? []).length; i++) {
      const t = checkEffectiveTurn(session.turns[i], { index: i });
      if (t.usable) turns.push(t);
      else {
        dropped.push({ index: i, reason: t.not_evidence_reason });
        uncertainties.push(`effective_turns_in_memory[${i}] 是压缩摘要（${t.not_evidence_reason}）：只作导航，不作为证据`);
      }
    }
    const sessionEvidence = turns.map((t) => t.evidence);
    const humanTurns = turns.filter((t) => t.metadata.message_source_kind === "user");

    // ⑤ 覆盖门槛（M3 是唯一入口）
    const coverage = request.compiler_config?.coverage ?? null;
    const ranges = analyzableRanges({
      relevant_book_spans: request.relevant_book_spans,
      coverage,
      requestedThroughSeq: session.durability_range?.through_seq ?? null,
    });
    if (!ranges.ok) {
      throw blocked(ranges.code, ranges.message, { blocked: ranges.blocked, gate: ranges.gate });
    }
    for (const b of ranges.blocked) {
      uncertainties.push(`范围 ${b.span_id ?? b.section_id} 不可分析（${b.blocked_reason}）：${b.why_now}`);
    }

    // 书内 span 逐个核验（readSourceSpan 是唯一入口）
    const bookSpans = [];
    for (const a of ranges.analyzable) {
      const span = a.span;
      let verified;
      try {
        verified = await capabilities.readSourceSpan(span.span_id);
      } catch (e) {
        throw blocked("SOURCE_UNAVAILABLE", `读取书内 span ${span.span_id} 失败：${e?.message ?? e}`);
      }
      if (!isMap(verified) || verified.ok !== true) {
        throw blocked(
          "SOURCE_UNAVAILABLE",
          `书内 span ${span.span_id} 不可读：来源不可用时不得生成提案（也不得伪装 no_change）`,
          { span_id: span.span_id, result: verified ?? null },
        );
      }
      if (verified.text_hash !== span.text_hash) {
        throw blocked(
          "SOURCE_SPAN_HASH_MISMATCH",
          `span ${span.span_id} 的 text_hash 与已核验值不一致：来源已变化，须重新核验`,
          { declared: span.text_hash, observed: verified.text_hash },
        );
      }
      bookSpans.push({ ...span, verified: true, source: verified });
    }

    // ⑥ 查重门槛
    const dedupResult = await runDedupGate(request, capabilities);
    uncertainties.push(...dedupResult.uncertainties);
    const conflicts = [...dedupResult.conflicts];
    const snapshots = assertSnapshots(request);

    // 会话轮次也要能真正读到（有会话输入时）
    if (session.session_input && sessionEvidence.length > 0) {
      let read;
      try {
        read = await capabilities.readHostTurns(sessionEvidence);
      } catch (e) {
        throw blocked("SOURCE_UNAVAILABLE", `读取宿主轮次失败：${e?.message ?? e}`);
      }
      if (!isMap(read) || read.ok !== true) {
        throw blocked("SOURCE_UNAVAILABLE", "宿主轮次不可读：不得凭不可读来源生成提案", { result: read ?? null });
      }
    }

    // ⑦ 模型草稿（模型边界：草稿一律视为不可信输入）
    const spec = {
      task: "compile_change_operations",
      schema_version: SCHEMA_VERSION,
      job_id: request.job_id,
      compiler: metadata,
      analyzable_ranges: ranges.analyzable.map((a) => ({
        span_id: a.span_id,
        section_id: a.section_id,
        start_codepoint: a.span.start_codepoint,
        end_codepoint: a.span.end_codepoint,
      })),
      evidence: {
        book_spans: bookSpans.map((s) => ({ span_id: s.span_id, section_id: s.section_id, text_hash: s.text_hash })),
        session_turns: sessionEvidence.map((e) => ({ session_id: e.session_id, event_seq: e.event_seq ?? null, turn_id: e.turn_id ?? null, source_revision: e.source_revision })),
        dedup: {
          check_id: dedupResult.dedup.check_id,
          local_result: dedupResult.dedup.local_result,
          candidate_ids: dedupResult.verified_candidates.map((c) => c.candidate_id),
        },
        note_snapshots: snapshots.map((s) => ({ object_id: s.object_id, relative_path: s.relative_path, content_hash: s.content_hash })),
      },
      summary_budget: request.summary_budget ?? DEFAULT_SUMMARY_BUDGET,
      consent_scope: request.consent_scope,
      rules: {
        application_mode: COMPILER_APPLICATION_MODE,
        confirmation: "unconfirmed",
        model_must_not_choose_auto: true,
        summary_is_not_evidence: true,
      },
    };
    let draft;
    try {
      draft = await capabilities.generateStructured(spec);
    } catch (e) {
      throw failed("MODEL_ERROR", `结构化生成失败：${e?.message ?? e}`);
    }
    if (!isMap(draft) || !COMPILE_OUTCOMES.includes(draft.outcome)) {
      throw failed("MODEL_ERROR", "模型草稿必须给出 outcome=no_change|proposal");
    }

    const dedupRef = dedupResult.dedup.check_id;

    // ⑧ 无变更：耐久最小回执（含 check 与来源范围）
    if (draft.outcome === "no_change") {
      if (!isNonEmptyStr(draft.reason)) {
        throw failed("MODEL_ERROR", "no_change 必须给出真实理由");
      }
      // 冲突未解决时**不得**报 no_change：那会把「核对不确定」伪装成「确认无需变更」。
      const blocking = conflicts.find((c) => c.reason === "SNAPSHOT_HASH_MISMATCH");
      if (blocking) {
        throw blocked(
          "NOTE_HASH_CONFLICT",
          `候选 ${blocking.candidate_id} 的实读 hash 与快照不一致：冲突未解决前不得报 no_change`,
          blocking,
        );
      }
      return {
        outcome: "no_change",
        operations: [],
        dedup_check_ref: dedupRef,
        conflicts,
        uncertainties: [...uncertainties, `无变更理由：${draft.reason}`],
        compiler_metadata: metadata,
      };
    }

    // ⑨ 逐条编译
    const ctx = {
      summary_budget: request.summary_budget ?? DEFAULT_SUMMARY_BUDGET,
      consent_scope: request.consent_scope ?? {},
      dedup: dedupResult.dedup,
      snapshots,
      verified_candidates: dedupResult.verified_candidates,
      book_spans: bookSpans,
      session_evidence: sessionEvidence,
      human_turns: humanTurns,
      known_user_actions: request.consent_scope?.user_actions ?? [],
    };
    const drafts = isArr(draft.operations) ? draft.operations : [];
    if (drafts.length === 0) {
      throw failed(
        "EMPTY_PROPOSAL",
        "outcome=proposal 却没有 operations：不得静默降级成 no_change",
      );
    }
    if (isInt(ctx.summary_budget.max_operations) && drafts.length > ctx.summary_budget.max_operations) {
      throw failed(
        "BUDGET_EXCEEDED",
        `operations 数量 ${drafts.length} 超过 summary_budget.max_operations=${ctx.summary_budget.max_operations}`,
      );
    }

    const operations = [];
    const rejected = [];
    for (let i = 0; i < drafts.length; i++) {
      const r = compileOperation(drafts[i], ctx);
      if (r.ok) {
        operations.push({ ...r.operation, operation_id: r.operation.operation_id ?? `${dedupRef}#op${operations.length + 1}` });
      } else {
        rejected.push({ index: i, errors: r.errors });
        for (const e of r.errors) uncertainties.push(`草稿[${i}] 被拒（${e.code}）：${e.message}`);
      }
    }
    if (operations.length === 0) {
      throw failed(
        "NO_VALID_OPERATION",
        `全部 ${drafts.length} 条草稿都未通过归属/证据/hash 校验：不得降级成 no_change`,
        { rejected },
      );
    }

    const result = {
      outcome: "proposal",
      operations,
      dedup_check_ref: dedupRef,
      conflicts,
      uncertainties,
      compiler_metadata: metadata,
    };

    // ⑩ 自检：用 M1 validateNote 校验将要落盘的正式提案（未知身份/非法组合在此再挡一次）
    buildChangeProposal(result, {
      job_id: request.job_id,
      proposal_id: `cp_${compilerIdempotencyKey(metadata, dedupResult.dedup.input_fingerprint).slice(0, 32)}`,
      input_fingerprint: dedupResult.dedup.input_fingerprint,
      dedup_check: dedupResult.dedup,
      source_range: canonicalSourceRange(request),
      now: this._now,
    });
    return result;
  }

  /** 身份解析：显式给 `compiler_metadata` 就严格校验（未知即阻止），否则用模块真实身份。 */
  resolveMetadata(compiler_config = {}) {
    const cfg = isMap(compiler_config) ? compiler_config : {};
    if (hasOwn(cfg, "compiler_metadata")) {
      const r = validateCompilerMetadata(cfg.compiler_metadata);
      if (!r.ok) {
        throw failed(
          "COMPILER_IDENTITY_UNKNOWN",
          "compiler_config.compiler_metadata 未知或形状非法：不得生成可接受提案（PRD :472）",
          { errors: r.errors },
        );
      }
      return r.value;
    }
    return { name: COMPILER_NAME, version: COMPILER_VERSION };
  }
}

/** 便捷入口（无状态）。 */
export function propose(request, capabilities) {
  return new KnowledgeCompiler().propose(request, capabilities);
}
