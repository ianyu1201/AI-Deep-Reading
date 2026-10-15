/**
 * lib/reading/coverage.js · 覆盖账本（M3，执行计划 §1 表 #4，依赖 schema.js）
 *
 * ## 这个模块只做一件事
 * 把「这本书到底被处理了多少」算清楚，并且**拒绝把三层混成一层**：
 *
 *   抽取层 extraction —— 已发现的可解析正文里，抽出来了多少
 *   分析层 analysis   —— 已解析正文里，语义分析（CoverageUnit）**通过校验**了多少
 *   阅读层 reading    —— 已解析正文里，用户实际读过/讨论过多少
 *
 * 三层各自有分母与分子。**缺数据就是 null（未知），绝不回落到别层。**
 * 「抽取完成」不得冒充「分析完成」，「分析完成」不得冒充「已读懂」——
 * 这不是注释，是 `claims` 里的硬判定：`claims.book_understood.allowed` 恒为 false。
 *
 * ## 硬契约（逐条来自 PRD v0.6，SHA-256 a57b494a…）
 *  · §11.5 :1000 `CoverageUnit.state`：`pending→processed/failed/excluded`；`failed/excluded→pending`
 *      - `processed` 必须**该范围语义分析通过校验**才可置；**「切片完成」不算**
 *      - `failed` 只表示该单元失败，任务仍可报告部分成果
 *      - `excluded` 必须给明确原因，且**不计作理解完成**
 *      - 重试 / 改变排除范围需**显式调度**
 *      - 同版本同输入已 `processed` 不重做；解析 / 版本 / 输入变化 ⇒ **新单元身份**
 *  · :346 分母 = **已发现的可解析正文字符范围**，按 **span 区间并集**计数，重叠**不重复计算**；
 *      另列无法解析 / 缺失 / 图片页的数量及**占比是否可知**；**未知部分存在时不得宣称「全书 100%」**；
 *      被排除范围必须列原因，不计作已理解；**模型候选分析覆盖的分母是已解析正文**（不是全书）。
 *  · :247 长章按**连续窗口**处理，记录模型是否**真正消费**每段；**失败窗口继续排队**。
 *  · :311 输出形状 `coverage:{scope:"parsed_body", missing_sections, analyzed_units, total_units, excluded_units}`
 *  · §9.5 :764 宿主尚未保存 ⇒ `SourceGate.pending_durable` / `WorkJob.blocked` / 水位不前进，
 *      「条件改变后核验再 resume」⇒ `planAdvance` / `reverifyResume`（M2 交接事项 1）。
 *
 * ## 本模块刻意不做的事
 *  · 不读宿主会话（那是 `session-reader.js`）、不写盘（那是 `file-service.js`）、不调模型。
 *    来源状态由调用方以**普通对象**传入 ⇒ 可离线证伪，不需要宿主运行期。
 *  · 不新增 PRD 没有的契约字段：PRD 的输出形状原样放在 `coverage` 里（键集合恰好 5 个），
 *    其余信息一律放兄弟键。
 */
import { sha256Hex, validateWatermarks } from "./schema.js";

export const COVERAGE_VERSION = "1.0.0";

// --------------------------------------------------------------------------- //
// 常量与值域
// --------------------------------------------------------------------------- //

/** 三层账本。名字必须分开，因为它们的分母/证据来源不同。 */
export const COVERAGE_LAYERS = Object.freeze(["extraction", "analysis", "reading"]);

/**
 * CoverageUnit 只属于**分析层**（PRD §11.5：`原书版本内章节/片段分析记录`）。
 * 抽取层与阅读层是**范围账**，不是单元账 —— 这样三层在结构上就没法互相冒充。
 */
export const COVERAGE_UNIT_LAYER = "analysis";

export const COVERAGE_UNIT_STATES = Object.freeze(["pending", "processed", "failed", "excluded"]);

export const UNIT_INITIAL_STATE = "pending";

/**
 * PRD §11.5 :1000 的允许边，**等集**（不多不少）。
 * `processed` 在本单元身份内是终态：要重做必须换新身份（见 `shouldRedoUnit`）。
 */
export const ALLOWED_UNIT_TRANSITIONS = Object.freeze({
  pending: Object.freeze(["processed", "failed", "excluded"]),
  processed: Object.freeze([]),
  failed: Object.freeze(["pending"]),
  excluded: Object.freeze(["pending"]),
});

/** 本单元身份内的终态。 */
export const UNIT_TERMINAL_STATES = Object.freeze(["processed"]);

/** 未知部分的三类（PRD :346 要求分别列数量及「占比是否可知」）。 */
export const UNKNOWN_KINDS = Object.freeze(["unparseable", "missing", "image_page"]);

/**
 * 「空话原因」不算明确原因（PRD：excluded 须明确原因）。
 * 只挡明显不是原因的值，不挡任何具体说法。
 */
export const VACUOUS_REASONS = Object.freeze([
  "", "unknown", "n/a", "na", "none", "null", "undefined", "tbd", "todo", "other", "-", "?",
  "未知", "无", "待定", "不知道", "其他", "略",
]);

export class CoverageError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = "CoverageError";
    this.code = code;
    this.detail = detail;
  }
}

// --------------------------------------------------------------------------- //
// 小工具
// --------------------------------------------------------------------------- //
const isMap = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isArr = Array.isArray;
const isNonEmptyStr = (v) => typeof v === "string" && v.trim() !== "";
const isNonNegInt = (v) => Number.isInteger(v) && v >= 0;
const isPosInt = (v) => Number.isInteger(v) && v > 0;

/** 稳定序列化：键排序 ⇒ 同输入必得同 unit_id。 */
function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (isArr(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

function round4(x) {
  return Math.round(x * 10000) / 10000;
}

function fail(code, message, detail) {
  throw new CoverageError(code, message, detail);
}

function isVacuousReason(reason) {
  return VACUOUS_REASONS.includes(String(reason).trim().toLowerCase());
}

// --------------------------------------------------------------------------- //
// 1. 区间代数（分母的核心：并集计数，重叠不重复）
// --------------------------------------------------------------------------- //

/**
 * 坐标空间 = 书版本 + 归一化版本。
 * 不同归一化版本的 codepoint 偏移**不是同一把尺子**，混在一起求并集就是假账。
 */
function coordinateSpaceKey(cs) {
  if (!isMap(cs)) fail("INVALID_ARGUMENT", "coordinate_space 必须是 {book_version_id, normalization_version} 映射");
  const bv = cs.book_version_id;
  const nv = cs.normalization_version;
  if (!isNonEmptyStr(bv) || !isNonEmptyStr(nv)) {
    fail("INVALID_ARGUMENT", "coordinate_space 必须含非空 book_version_id 与 normalization_version");
  }
  return `${bv}::${nv}`;
}

/**
 * 规范化区间：左闭右开 `[start, end)`，非负整数，`start < end`。
 * 若区间自带 `coordinate_space`（或调用方统一给出），**混用不同坐标空间直接报错**。
 */
export function normalizeIntervals(intervals, { coordinateSpace = null } = {}) {
  if (!isArr(intervals)) fail("INVALID_ARGUMENT", "intervals 必须是数组");
  const spaces = new Set();
  const out = [];
  intervals.forEach((raw, i) => {
    if (!isMap(raw)) fail("INVALID_STRUCTURE", `intervals[${i}] 必须是 {start_codepoint, end_codepoint} 映射`);
    const s = raw.start_codepoint;
    const e = raw.end_codepoint;
    if (!isNonNegInt(s)) fail("INVALID_VALUE", `intervals[${i}].start_codepoint 必须是非负整数`);
    if (!isNonNegInt(e)) fail("INVALID_VALUE", `intervals[${i}].end_codepoint 必须是非负整数`);
    if (!(e > s)) {
      fail("INVALID_RANGE", `intervals[${i}] 必须满足 start_codepoint < end_codepoint（左闭右开）`, { start: s, end: e });
    }
    const cs = raw.coordinate_space ?? coordinateSpace;
    if (cs !== null && cs !== undefined) {
      spaces.add(coordinateSpaceKey(cs));
      if (spaces.size > 1) {
        fail("COORDINATE_SPACE_MISMATCH", "不得把不同书版本/归一化版本的坐标混进同一个并集（codepoint 偏移不可比）");
      }
    }
    out.push({ start_codepoint: s, end_codepoint: e });
  });
  return out;
}

/** 合并重叠/相邻区间，升序返回。 */
export function unionIntervals(intervals, opts = {}) {
  const norm = normalizeIntervals(intervals, opts);
  norm.sort((a, b) => a.start_codepoint - b.start_codepoint || a.end_codepoint - b.end_codepoint);
  const merged = [];
  for (const iv of norm) {
    const last = merged[merged.length - 1];
    if (last && iv.start_codepoint <= last.end_codepoint) {
      if (iv.end_codepoint > last.end_codepoint) last.end_codepoint = iv.end_codepoint;
    } else {
      merged.push({ start_codepoint: iv.start_codepoint, end_codepoint: iv.end_codepoint });
    }
  }
  return merged;
}

/**
 * 并集的**字符数**（PRD :346 的「重叠部分不重复计算」就在这里落地）。
 * 空数组 ⇒ 0（真值，不是未知）。
 */
export function unionCodepoints(intervals, opts = {}) {
  return unionIntervals(intervals, opts).reduce((n, iv) => n + (iv.end_codepoint - iv.start_codepoint), 0);
}

/** 交集（两侧都先并集化）。 */
export function intersectIntervals(a, b, opts = {}) {
  const A = unionIntervals(a, opts);
  const B = unionIntervals(b, opts);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < A.length && j < B.length) {
    const s = Math.max(A[i].start_codepoint, B[j].start_codepoint);
    const e = Math.min(A[i].end_codepoint, B[j].end_codepoint);
    if (e > s) out.push({ start_codepoint: s, end_codepoint: e });
    if (A[i].end_codepoint < B[j].end_codepoint) i++;
    else j++;
  }
  return out;
}

/** 差集 a \ b（用于「未覆盖缺口」）。 */
export function subtractIntervals(a, b, opts = {}) {
  const A = unionIntervals(a, opts);
  const B = unionIntervals(b, opts);
  const out = [];
  for (const iv of A) {
    let cur = iv.start_codepoint;
    for (const cut of B) {
      if (cut.end_codepoint <= cur) continue;
      if (cut.start_codepoint >= iv.end_codepoint) break;
      if (cut.start_codepoint > cur) out.push({ start_codepoint: cur, end_codepoint: cut.start_codepoint });
      cur = Math.max(cur, cut.end_codepoint);
      if (cur >= iv.end_codepoint) break;
    }
    if (cur < iv.end_codepoint) out.push({ start_codepoint: cur, end_codepoint: iv.end_codepoint });
  }
  return out;
}

// --------------------------------------------------------------------------- //
// 2. CoverageUnit 身份
// --------------------------------------------------------------------------- //

/**
 * 单元身份的输入字段。**任何一个变了就是另一个单元**（PRD：解析/版本变化创建新单元身份）。
 * `input_fingerprint` 进身份 ⇒「同版本同输入已 processed 不重做」自然成立。
 */
export const UNIT_IDENTITY_FIELDS = Object.freeze([
  "book_id",
  "book_version_id",
  "parser_version",
  "normalization_version",
  "section_id",
  "block_id",
  "window_index",
  "start_codepoint",
  "end_codepoint",
  "input_fingerprint",
]);

/**
 * 由「书版本 + 解析器/归一化版本 + 范围 + 输入指纹」导出稳定身份。
 * @returns {{unit_id: string, basis: object}}
 */
export function coverageUnitIdentity(input = {}) {
  if (!isMap(input)) fail("INVALID_ARGUMENT", "单元身份输入必须是映射");
  for (const k of ["book_id", "book_version_id", "parser_version", "normalization_version", "section_id"]) {
    if (!isNonEmptyStr(input[k])) fail("INVALID_ARGUMENT", `单元身份缺少非空 ${k}`);
  }
  if (!isNonEmptyStr(input.input_fingerprint)) {
    fail("INVALID_ARGUMENT", "单元身份缺少非空 input_fingerprint（没有输入指纹就无法判定「同版本同输入不重做」）");
  }
  for (const k of ["start_codepoint", "end_codepoint"]) {
    if (!isNonNegInt(input[k])) fail("INVALID_ARGUMENT", `单元身份 ${k} 必须是非负整数`);
  }
  if (!(input.end_codepoint > input.start_codepoint)) {
    fail("INVALID_RANGE", "单元范围必须满足 start_codepoint < end_codepoint（左闭右开）");
  }
  if (input.block_id !== null && input.block_id !== undefined && !isNonEmptyStr(input.block_id)) {
    fail("INVALID_ARGUMENT", "block_id 若给出必须是非空字符串");
  }
  if (input.window_index !== null && input.window_index !== undefined && !isNonNegInt(input.window_index)) {
    fail("INVALID_ARGUMENT", "window_index 若给出必须是非负整数");
  }
  const basis = {
    book_id: input.book_id,
    book_version_id: input.book_version_id,
    parser_version: input.parser_version,
    normalization_version: input.normalization_version,
    section_id: input.section_id,
    block_id: input.block_id ?? null,
    window_index: input.window_index ?? null,
    start_codepoint: input.start_codepoint,
    end_codepoint: input.end_codepoint,
    input_fingerprint: input.input_fingerprint,
  };
  return { unit_id: sha256Hex(canonicalJson(basis)), basis };
}

/**
 * 造一个单元（初始 `pending`）。
 *
 * `counts_as_understood` **恒为 false**：任何单元状态都不表示「用户读懂了」。
 * `counts_as_analyzed` 也恒为 false —— 只有真正走到 `processed` 才由转换置真。
 */
export function makeCoverageUnit(input = {}) {
  const { unit_id, basis } = coverageUnitIdentity(input);
  const window = isMap(input.window)
    ? { window_index: input.window.window_index ?? basis.window_index, start_codepoint: input.window.start_codepoint, end_codepoint: input.window.end_codepoint }
    : null;
  if (window) {
    if (!isNonNegInt(window.start_codepoint) || !isNonNegInt(window.end_codepoint) || !(window.end_codepoint > window.start_codepoint)) {
      fail("INVALID_RANGE", "window 必须是合法左闭右开区间");
    }
    if (window.start_codepoint !== basis.start_codepoint || window.end_codepoint !== basis.end_codepoint) {
      fail("INVALID_RANGE", "window 必须与单元自身的 start_codepoint/end_codepoint 一致");
    }
  }
  return {
    unit_id,
    layer: COVERAGE_UNIT_LAYER,
    ...basis,
    window,
    state: UNIT_INITIAL_STATE,
    counts_as_analyzed: false,
    counts_as_understood: false,
    semantic_analysis_receipt: null,
    failure: null,
    exclusion: null,
    schedule: null,
    history: [],
    created_at: input.now ?? new Date().toISOString(),
    updated_at: input.now ?? new Date().toISOString(),
  };
}

/** 单元的窗口范围（没有 window 就用自身范围）。 */
export function unitWindowRange(unit) {
  if (isMap(unit?.window)) return { start_codepoint: unit.window.start_codepoint, end_codepoint: unit.window.end_codepoint };
  return { start_codepoint: unit?.start_codepoint, end_codepoint: unit?.end_codepoint };
}

/**
 * 状态转换（PRD §11.5 :1000，允许边等集）。
 *
 * 每个守卫都对应一条 PRD 硬约束；返回 `{ok, unit, effects, errors}`，不抛错（便于聚合报告）。
 */
export function transitionUnit(unit, nextState, options = {}) {
  const errors = [];
  if (!isMap(unit)) return { ok: false, errors: [{ code: "INVALID_STRUCTURE", field: "unit", message: "unit 必须是映射" }] };
  const from = unit.state;
  if (!COVERAGE_UNIT_STATES.includes(from)) {
    errors.push({ code: "INVALID_STATE", field: "unit.state", message: `未知单元状态 ${JSON.stringify(from)}` });
  }
  if (!COVERAGE_UNIT_STATES.includes(nextState)) {
    errors.push({ code: "INVALID_STATE", field: "next", message: `未知目标状态 ${JSON.stringify(nextState)}` });
  }
  if (errors.length) return { ok: false, errors };

  const allowed = ALLOWED_UNIT_TRANSITIONS[from] ?? [];
  if (!allowed.includes(nextState)) {
    return {
      ok: false,
      errors: [{
        code: "INVALID_TRANSITION",
        field: "unit.state",
        message: `PRD §11.5 不允许 ${from} → ${nextState}（允许：${allowed.join(" / ") || "（终态，无出边）"}）`,
      }],
    };
  }

  const at = options.now ?? new Date().toISOString();
  const effects = {};
  const patch = { state: nextState, updated_at: at };

  if (nextState === "processed") {
    // 守卫 1：**切片完成不算分析完成**。
    if (options.extraction_receipt && !options.semantic_analysis) {
      return {
        ok: false,
        errors: [{
          code: "EXTRACTION_IS_NOT_ANALYSIS",
          field: "semantic_analysis",
          message: "只有抽取/切片回执时不得置 processed：processed 要求该范围语义分析通过校验",
        }],
      };
    }
    const sa = options.semantic_analysis;
    if (!isMap(sa) || sa.validated !== true || sa.layer !== COVERAGE_UNIT_LAYER) {
      return {
        ok: false,
        errors: [{
          code: "SEMANTIC_ANALYSIS_NOT_PASSED",
          field: "semantic_analysis",
          message: "processed 需要 {validated:true, layer:\"analysis\"} 的语义分析通过回执",
        }],
      };
    }
    if (!isNonEmptyStr(sa.check_id)) {
      return {
        ok: false,
        errors: [{
          code: "SEMANTIC_ANALYSIS_NOT_PASSED",
          field: "semantic_analysis.check_id",
          message: "语义分析回执必须带可核验 check_id，不接受无据通过",
        }],
      };
    }
    // 守卫 2：长章窗口必须**真正消费**每一段才可置 processed（PRD :247）。
    if (isMap(unit.window)) {
      const wr = unitWindowRange(unit);
      const consumed = isArr(sa.consumed_ranges) ? sa.consumed_ranges : null;
      if (!consumed) {
        return {
          ok: false,
          errors: [{
            code: "WINDOW_NOT_CONSUMED",
            field: "semantic_analysis.consumed_ranges",
            message: "窗口单元缺「模型真正消费」的证据范围，不得置 processed",
          }],
        };
      }
      const missing = subtractIntervals([wr], consumed);
      if (missing.length > 0) {
        return {
          ok: false,
          errors: [{
            code: "WINDOW_PARTIALLY_ANALYZED",
            field: "semantic_analysis.consumed_ranges",
            message: `窗口未被完整消费，缺口 ${unionCodepoints(missing)} 字符，不得置 processed`,
            missing,
          }],
        };
      }
    }
    patch.semantic_analysis_receipt = {
      validated: true,
      layer: COVERAGE_UNIT_LAYER,
      check_id: sa.check_id,
      analyzed_at: at,
    };
    patch.counts_as_analyzed = true;
    effects.counts_as_analyzed = true;
  }

  if (nextState === "failed") {
    const f = options.failure;
    if (!isMap(f) || !isNonEmptyStr(f.code)) {
      return {
        ok: false,
        errors: [{ code: "FAILURE_REASON_REQUIRED", field: "failure.code", message: "failed 必须带失败原因码" }],
      };
    }
    patch.failure = { code: f.code, message: isNonEmptyStr(f.message) ? f.message : null, retryable: f.retryable !== false };
    patch.counts_as_analyzed = false;
    // PRD :1000 —— failed 只表示该单元失败，任务仍可报告部分成果。
    effects.task_may_report_partial_results = true;
  }

  if (nextState === "excluded") {
    const ex = options.exclusion;
    const reason = isNonEmptyStr(ex?.reason) ? ex.reason.trim() : "";
    if (!reason) {
      return {
        ok: false,
        errors: [{ code: "EXCLUSION_REASON_REQUIRED", field: "exclusion.reason", message: "excluded 必须给明确原因" }],
      };
    }
    if (isVacuousReason(reason)) {
      return {
        ok: false,
        errors: [{
          code: "EXCLUSION_REASON_VACUOUS",
          field: "exclusion.reason",
          message: `「${reason}」不是明确原因，不得作为排除理由`,
        }],
      };
    }
    patch.exclusion = { reason, reason_code: isNonEmptyStr(ex.reason_code) ? ex.reason_code : null, decided_at: at };
    // 硬约束：排除**不计作理解完成**，也不计作已分析。
    patch.counts_as_analyzed = false;
    patch.counts_as_understood = false;
    effects.counts_as_understood = false;
  }

  if (nextState === "pending") {
    // failed/excluded → pending：**显式调度**才允许（PRD：重试或改变排除范围需明确调度）。
    const sch = options.schedule;
    if (!isMap(sch) || !isNonEmptyStr(sch.scheduled_by) || !isNonEmptyStr(sch.reason)) {
      return {
        ok: false,
        errors: [{
          code: "RETRY_REQUIRES_EXPLICIT_SCHEDULE",
          field: "schedule",
          message: `${from} → pending 必须显式调度（给出 scheduled_by 与 reason）`,
        }],
      };
    }
    patch.schedule = { scheduled_by: sch.scheduled_by, reason: sch.reason, at };
    patch.failure = null;
    patch.exclusion = null;
    patch.counts_as_analyzed = false;
    effects.requeued = true;
  }

  const entry = { from, to: nextState, at };
  if (patch.schedule) entry.schedule = { scheduled_by: patch.schedule.scheduled_by, reason: patch.schedule.reason };
  // 本次转换的原因：置 excluded/failed 时来自本次选项；
  // 从 excluded/failed 回到 pending 时来自**原状态** —— 否则「为什么被排除」会在重排时丢掉。
  const exclusionReason = patch.exclusion?.reason ?? unit.exclusion?.reason ?? null;
  const failureCode = patch.failure?.code ?? unit.failure?.code ?? null;
  if (exclusionReason) entry.exclusion_reason = exclusionReason;
  if (failureCode) entry.failure_code = failureCode;
  if (patch.semantic_analysis_receipt) entry.check_id = patch.semantic_analysis_receipt.check_id;

  const next = {
    ...unit,
    ...patch,
    history: [...(isArr(unit.history) ? unit.history : []), entry],
  };
  return { ok: true, unit: next, effects, errors: [] };
}

/**
 * 同版本同输入已 processed ⇒ **不重做**；身份变了（解析/版本/输入/范围）⇒ 新身份。
 * @returns {{redo:boolean, reason:string, new_identity:boolean, unit_id:string, requires_schedule?:boolean}}
 */
export function shouldRedoUnit(existing, incoming) {
  const { unit_id } = coverageUnitIdentity(incoming);
  const existingId = isMap(existing) ? existing.unit_id ?? null : null;
  if (existingId === null || existingId !== unit_id) {
    return {
      redo: true,
      reason: existingId === null ? "NO_EXISTING_UNIT" : "NEW_UNIT_IDENTITY",
      new_identity: existingId !== null,
      unit_id,
      existing_unit_id: existingId,
      note: "解析/版本/输入/范围变化 ⇒ 创建新单元身份，不覆盖旧身份记录",
    };
  }
  if (existing.state === "processed") {
    return { redo: false, reason: "ALREADY_PROCESSED_SAME_INPUT", new_identity: false, unit_id };
  }
  if (existing.state === "pending") {
    return { redo: true, reason: "PENDING_NOT_PROCESSED", new_identity: false, unit_id, requires_schedule: false };
  }
  return {
    redo: true,
    reason: "RETRY_REQUIRES_EXPLICIT_SCHEDULE",
    new_identity: false,
    unit_id,
    requires_schedule: true,
  };
}

// --------------------------------------------------------------------------- //
// 3. 长章连续窗口（PRD :247）
// --------------------------------------------------------------------------- //

/**
 * 把一章切成**连续窗口**：首尾相接、无洞、无叠，窗口长度 ≤ max。
 * 计划本身自校验；算不齐就抛 `WINDOW_PLAN_INCOMPLETE`，不返回一份有洞的计划。
 */
export function planChapterWindows({ section_id, start_codepoint, end_codepoint, max_window_codepoints } = {}) {
  if (!isNonEmptyStr(section_id)) fail("INVALID_ARGUMENT", "section_id 必须是非空字符串");
  if (!isNonNegInt(start_codepoint) || !isNonNegInt(end_codepoint)) fail("INVALID_ARGUMENT", "窗口起止必须是非负整数");
  if (!(end_codepoint > start_codepoint)) fail("INVALID_RANGE", "章节范围必须满足 start < end（左闭右开）");
  if (!isPosInt(max_window_codepoints)) fail("INVALID_ARGUMENT", "max_window_codepoints 必须是正整数");

  const windows = [];
  let cursor = start_codepoint;
  let index = 0;
  while (cursor < end_codepoint) {
    const end = Math.min(cursor + max_window_codepoints, end_codepoint);
    windows.push({ window_index: index, start_codepoint: cursor, end_codepoint: end });
    cursor = end;
    index++;
  }

  const contiguous = windows.every((w, i) =>
    i === 0 ? w.start_codepoint === start_codepoint : w.start_codepoint === windows[i - 1].end_codepoint);
  const total = windows.reduce((n, w) => n + (w.end_codepoint - w.start_codepoint), 0);
  if (!contiguous || total !== end_codepoint - start_codepoint) {
    fail("WINDOW_PLAN_INCOMPLETE", "窗口计划必须连续覆盖整章（无洞、无叠）", { contiguous, total, expected: end_codepoint - start_codepoint });
  }

  return {
    section_id,
    start_codepoint,
    end_codepoint,
    max_window_codepoints,
    total_codepoints: total,
    window_count: windows.length,
    contiguous: true,
    complete: true,
    windows,
  };
}

/**
 * 记录模型是否**真正消费**了某段（PRD :247）。
 * 没有回执 / 回执没有证据 / 只消费了一部分 ⇒ `consumed:false`，**绝不默认 true**。
 */
export function recordWindowConsumption(unit, receipt = {}) {
  const range = unitWindowRange(unit);
  const base = { unit_id: unit?.unit_id ?? null, window: range };
  if (!isMap(receipt) || receipt.truly_consumed !== true) {
    return { ...base, consumed: false, reason: "NO_CONSUMPTION_RECEIPT", covered_codepoints: 0, missing_codepoints: range.end_codepoint - range.start_codepoint, missing_ranges: [range] };
  }
  if (!isNonEmptyStr(receipt.check_id) || !isNonEmptyStr(receipt.evidence_ref)) {
    return { ...base, consumed: false, reason: "CONSUMPTION_UNVERIFIED", covered_codepoints: 0, missing_codepoints: range.end_codepoint - range.start_codepoint, missing_ranges: [range] };
  }
  const consumedRanges = isArr(receipt.consumed_ranges) ? receipt.consumed_ranges : [];
  const covered = intersectIntervals(consumedRanges, [range]);
  const missing = subtractIntervals([range], consumedRanges);
  const coveredCodepoints = unionCodepoints(covered);
  const missingCodepoints = unionCodepoints(missing);
  return {
    ...base,
    consumed: missingCodepoints === 0,
    reason: missingCodepoints === 0 ? "FULLY_CONSUMED" : "WINDOW_PARTIALLY_CONSUMED",
    check_id: receipt.check_id,
    evidence_ref: receipt.evidence_ref,
    covered_codepoints: coveredCodepoints,
    missing_codepoints: missingCodepoints,
    missing_ranges: missing,
  };
}

/**
 * 下一批要处理的窗口队列：**pending 与 failed 都继续排队**（PRD :247「失败窗口继续排队」）。
 * excluded 不入队（已明确排除，不计作完成）；processed 已完成。
 */
export function nextWindowQueue(units = []) {
  const queue = [];
  const done = [];
  const excluded = [];
  for (const u of units) {
    if (u?.state === "pending") queue.push({ unit_id: u.unit_id, reason: "PENDING", requires_schedule: false });
    else if (u?.state === "failed") queue.push({ unit_id: u.unit_id, reason: "FAILED_STILL_QUEUED", requires_schedule: true });
    else if (u?.state === "excluded") excluded.push({ unit_id: u.unit_id, reason: u.exclusion?.reason ?? null });
    else done.push({ unit_id: u.unit_id });
  }
  return {
    queue,
    done,
    excluded,
    failed_still_queued: queue.filter((q) => q.reason === "FAILED_STILL_QUEUED").length,
    total: units.length,
  };
}

// --------------------------------------------------------------------------- //
// 4. 三层账本（不互相冒充）
// --------------------------------------------------------------------------- //

/** 分母：已发现的可解析正文字符范围（并集，重叠只算一次）。 */
function denominatorOf(discoveredBody, coordinateSpace) {
  const opts = coordinateSpace ? { coordinateSpace } : {};
  return { intervals: unionIntervals(discoveredBody, opts), codepoints: unionCodepoints(discoveredBody, opts) };
}

/**
 * 单层账本。
 * **没有该层数据 ⇒ `known:false` + `percent:null`**（未知，不是 0，更不是从别层抄一个数）。
 */
function layerLedger({ layer, denominator, covered, extra = {}, coordinateSpace }) {
  const opts = coordinateSpace ? { coordinateSpace } : {};
  if (covered === null || covered === undefined) {
    return {
      layer,
      scope: "parsed_body",
      known: false,
      denominator_codepoints: denominator.codepoints,
      covered_codepoints: null,
      percent: null,
      reason: "NO_LAYER_INPUT",
      ...extra,
    };
  }
  const inside = intersectIntervals(covered, denominator.intervals, opts);
  const coveredCodepoints = unionCodepoints(inside, opts);
  const rawCovered = unionCodepoints(covered, opts);
  return {
    layer,
    scope: "parsed_body",
    known: true,
    denominator_codepoints: denominator.codepoints,
    covered_codepoints: coveredCodepoints,
    percent: denominator.codepoints === 0 ? null : round4((coveredCodepoints / denominator.codepoints) * 100),
    reason: denominator.codepoints === 0 ? "EMPTY_DENOMINATOR" : null,
    // 超出已解析正文的部分单独列出，不静默并进分子。
    out_of_scope_codepoints: rawCovered - coveredCodepoints,
    ...extra,
  };
}

/**
 * 三层账本。
 *
 * - 抽取层：调用方给 `extracted_body` 范围。
 * - 分析层：**只由 CoverageUnit 的状态推导** —— 只有 `processed` 单元的跨度算进分子。
 *   于是「excluded / failed / pending 不计入分析覆盖」是结构性保证，不靠自觉。
 * - 阅读层：调用方给 `read_body`（用户实际读过/讨论过的范围）。
 */
export function buildLayerLedgers({ coordinate_space = null, discovered_body = [], extracted_body = null, read_body = null, units = null } = {}) {
  const opts = coordinate_space ? { coordinateSpace: coordinate_space } : {};
  const denominator = denominatorOf(discovered_body, coordinate_space);

  const extraction = layerLedger({
    layer: "extraction",
    denominator,
    covered: extracted_body,
    coordinateSpace: coordinate_space,
  });

  let analysis;
  if (units === null || units === undefined) {
    analysis = layerLedger({ layer: "analysis", denominator, covered: null, coordinateSpace: coordinate_space });
  } else {
    if (!isArr(units)) fail("INVALID_ARGUMENT", "units 必须是数组");
    const processed = units.filter((u) => u?.state === "processed");
    const processedRanges = processed.map((u) => ({
      start_codepoint: u.start_codepoint,
      end_codepoint: u.end_codepoint,
    }));
    const covered = unionIntervals(processedRanges, opts);
    analysis = layerLedger({
      layer: "analysis",
      denominator,
      covered,
      coordinateSpace: coordinate_space,
      extra: {
        // 分析覆盖的分子来源写清楚：只来自 processed 单元。
        numerator_source: "processed_coverage_units_only",
        analyzed_units: processed.length,
      },
    });
  }

  const reading = layerLedger({
    layer: "reading",
    denominator,
    covered: read_body,
    coordinateSpace: coordinate_space,
  });

  return { coordinate_space, denominator, extraction, analysis, reading };
}

// --------------------------------------------------------------------------- //
// 5. 诚实判定与报告（PRD :346 / :311）
// --------------------------------------------------------------------------- //

/**
 * 未知部分（无法解析 / 缺失 / 图片页）：数量 + **占比是否可知**。
 * 调用方不给 ⇒ 一律 `known:false`，于是「全书 100%」永远不可宣称。
 */
function normalizeUnknown(unknown) {
  const src = isMap(unknown) ? unknown : null;
  const kinds = {};
  let totalCount = 0;
  let unknownCodepointsKnown = true;
  let unknownCodepoints = 0;
  const reasons = [];

  for (const kind of UNKNOWN_KINDS) {
    const raw = isMap(src?.[kind]) ? src[kind] : null;
    if (!raw) {
      kinds[kind] = { count: null, codepoints: null, known: false };
      unknownCodepointsKnown = false;
      continue;
    }
    const count = isNonNegInt(raw.count) ? raw.count : null;
    const codepoints = isNonNegInt(raw.codepoints) ? raw.codepoints : null;
    kinds[kind] = { count, codepoints, known: count !== null };
    if (count === null) {
      unknownCodepointsKnown = false;
    } else {
      totalCount += count;
    }
    if (codepoints === null) unknownCodepointsKnown = false;
    else unknownCodepoints += codepoints;
    if (isNonEmptyStr(raw.reason)) reasons.push({ kind, reason: raw.reason });
  }

  const ratioKnown = src?.ratio_known === true;
  const totalBookCodepoints = isNonNegInt(src?.total_book_codepoints) ? src.total_book_codepoints : null;

  return {
    kinds,
    total_count: src === null ? null : totalCount,
    codepoints: unknownCodepointsKnown && src !== null ? unknownCodepoints : null,
    codepoints_known: src !== null && unknownCodepointsKnown,
    counts_known: src !== null && UNKNOWN_KINDS.every((k) => kinds[k].known),
    ratio_known: src !== null && ratioKnown,
    total_book_codepoints: totalBookCodepoints,
    reasons,
    note: "「占比是否可知」本身要如实报告：不知道就说不知道，不拿已知部分当全书。",
  };
}

/**
 * 三层「能不能这么说」的硬判定。
 *
 * 三条铁律：
 *  1. 未知部分存在（或压根不知道有没有）⇒ 不得宣称「全书 100%」。
 *  2. 「抽取完成」不得冒充「分析完成」。
 *  3. 「分析完成」不得冒充「已读懂」—— `book_understood.allowed` **恒为 false**。
 */
function buildClaims({ layers, unknown }) {
  const noUnknown = unknown.counts_known && unknown.total_count === 0 && unknown.ratio_known;
  const unknownBlocker = unknown.counts_known
    ? (unknown.ratio_known ? `存在未知部分（${unknown.total_count} 项：${UNKNOWN_KINDS.filter((k) => (unknown.kinds[k].count ?? 0) > 0).join("/") || "—"}）` : "未知部分的占比不可知")
    : "未知部分数量未知";

  const extractionComplete = noUnknown && layers.extraction.known && layers.extraction.percent === 100;
  const analysisComplete = noUnknown && layers.analysis.known && layers.analysis.percent === 100;

  return {
    extraction_complete: {
      allowed: extractionComplete,
      basis: "extraction",
      reason: extractionComplete ? "已解析正文全部抽取，且无未知部分" : `不可宣称：${!layers.extraction.known ? "抽取层无数据" : !noUnknown ? unknownBlocker : `抽取覆盖 ${layers.extraction.percent}%`}`,
    },
    analysis_complete: {
      allowed: analysisComplete,
      basis: "analysis",
      reason: analysisComplete
        ? "已解析正文的语义分析全部通过校验，且无未知部分"
        : `不可宣称：${!layers.analysis.known ? "分析层无数据（不得用抽取层顶替）" : !noUnknown ? unknownBlocker : `分析覆盖 ${layers.analysis.percent}%`}`,
    },
    book_understood: {
      allowed: false,
      basis: "reading",
      reason: "「已读懂」不能由抽取/分析/处理进度推出：必须由用户真实阅读与讨论证据支持（PRD §6.2「全书被机器处理过」≠「用户读懂了」）",
    },
  };
}

/**
 * 构造覆盖报告。
 *
 * @returns {{coverage: object, layers: object, units: object, unknown: object, honesty: object, claims: object, partial: object}}
 *   `coverage` 的键集合**恰好**是 PRD :311 的五个（scope/missing_sections/analyzed_units/total_units/excluded_units）。
 */
export function buildCoverageReport(input = {}) {
  const { coordinate_space = null, discovered_body = [], extracted_body = null, read_body = null, units = null, sections = null, missing_section_reasons = null, unknown = null } = input;

  const layers = buildLayerLedgers({ coordinate_space, discovered_body, extracted_body, read_body, units });
  const unknownInfo = normalizeUnknown(unknown);

  // ---- 单元计数（分析层） ----
  const unitList = isArr(units) ? units : null;
  const counts = { total: 0, pending: 0, processed: 0, failed: 0, excluded: 0 };
  if (unitList) {
    for (const u of unitList) {
      counts.total++;
      if (COVERAGE_UNIT_STATES.includes(u?.state)) counts[u.state]++;
    }
  }
  const unitCounts = {
    ...counts,
    counts_as_analyzed: counts.processed,
    // 无论多少单元 processed，都不等于「读懂」。
    counts_as_understood: 0,
    // failed 不阻止任务报告部分成果（PRD :1000）。
    partial_results_reportable: true,
  };

  // ---- missing_sections ----
  // 只有**分析层有数据**时才敢说某章「缺」：分析层无数据时 `missing_sections` 未知，
  // 返回空数组并显式标 `missing_sections_known:false`，绝不把「不知道」当成「没有缺口」。
  const missingSections = [];
  const analysisKnown = layers.analysis.known === true;
  if (analysisKnown && isArr(sections)) {
    for (const sec of sections) {
      const sid = sec?.section_id;
      if (!isNonEmptyStr(sid)) continue;
      const ranges = isArr(sec.ranges) ? sec.ranges : [];
      const covered = unionCodepoints(intersectIntervals(ranges, processedRangesOf(unitList)));
      if (covered > 0) continue;
      const own = (unitList ?? []).filter((u) => u?.section_id === sid);
      const reason = isNonEmptyStr(missing_section_reasons?.[sid])
        ? missing_section_reasons[sid]
        : own.length === 0
          ? "NO_ANALYZED_UNIT"
          : own.every((u) => u.state === "failed")
            ? "ALL_UNITS_FAILED"
            : own.every((u) => u.state === "excluded")
              ? "ALL_UNITS_EXCLUDED"
              : "NO_PROCESSED_UNIT";
      missingSections.push({ section_id: sid, reason });
    }
  } else if (analysisKnown && isArr(missing_section_reasons)) {
    for (const m of missing_section_reasons) {
      if (isNonEmptyStr(m?.section_id) && isNonEmptyStr(m?.reason)) missingSections.push({ section_id: m.section_id, reason: m.reason });
    }
  }

  const claims = buildClaims({ layers, unknown: unknownInfo });

  const coverage = {
    scope: "parsed_body",
    missing_sections: missingSections,
    analyzed_units: counts.processed,
    total_units: counts.total,
    excluded_units: counts.excluded,
  };

  // 「全书百分比」只在我们**有资格宣称**时才给数：未知部分数量已知且为零。
  // 否则一律 null —— 不做「已知部分占已知+未知」的近似（图片页没有 codepoint，页数≠字符数），
  // 也不给出 99.99 之类的魔法上限：那还是变相宣称了全书。
  const wholeBookClaimAllowed = claims.extraction_complete.allowed;
  const wholeBookPercent = wholeBookClaimAllowed && layers.extraction.denominator_codepoints > 0
    ? round4((layers.extraction.covered_codepoints / layers.extraction.denominator_codepoints) * 100)
    : null;

  return {
    version: COVERAGE_VERSION,
    coordinate_space,
    coverage,
    layers: { extraction: layers.extraction, analysis: layers.analysis, reading: layers.reading },
    units: unitCounts,
    unknown: unknownInfo,
    honesty: {
      scope: "parsed_body",
      // 分母说清楚：这是「已发现的可解析正文」，不是全书。
      denominator_basis: "discovered_parseable_body_codepoints_union",
      denominator_codepoints: layers.extraction.denominator_codepoints,
      whole_book_claim_allowed: wholeBookClaimAllowed,
      whole_book_percent: wholeBookPercent,
      unknown_ratio_known: unknownInfo.ratio_known,
      unknown_counts_known: unknownInfo.counts_known,
      // 空数组 ≠ 没有缺口：分析层无数据时 missing_sections 是未知。
      missing_sections_known: analysisKnown,
      reasons: [
        analysisKnown ? null : "分析层无数据：missing_sections 未知（空数组不等于没有缺口）",
        unknownInfo.counts_known ? null : "未知部分（无法解析/缺失/图片页）数量未知：不得宣称全书 100%",
        unknownInfo.ratio_known ? null : "未知部分占比不可知：不得给出全书百分比",
        unknownInfo.counts_known && unknownInfo.total_count > 0
          ? `存在 ${unknownInfo.total_count} 项未知部分：即便已解析正文覆盖 100%，也不得宣称「全书 100%」`
          : null,
        counts.excluded > 0 ? `有 ${counts.excluded} 个单元被排除，已列原因，不计作理解完成` : null,
        counts.failed > 0 ? `有 ${counts.failed} 个单元失败，任务仍可报告部分成果` : null,
      ].filter(Boolean),
    },
    claims,
    partial: {
      has_failures: counts.failed > 0,
      has_exclusions: counts.excluded > 0,
      can_report_partial_results: true,
    },
  };
}

function processedRangesOf(unitList) {
  return (unitList ?? [])
    .filter((u) => u?.state === "processed")
    .map((u) => ({ start_codepoint: u.start_codepoint, end_codepoint: u.end_codepoint }));
}

// --------------------------------------------------------------------------- //
// 6. 耐久 resume 路径（M2 交接事项 1；PRD §9.5 :764）
// --------------------------------------------------------------------------- //

/**
 * 「这个单元为什么现在不能推进」——来源侧的阻塞原因。
 *
 * 关键诚实点：**只有 `ready` 且带 `source_revision` 才算可推进**。
 * 活会话的 `live` lease 没有 revision（M2 判断 3）⇒ 一律 `SOURCE_NOT_DURABLE`，
 * 水位不前进，等会话脱离内存后重新核验。
 */
export function sourceBlockReason(source = {}) {
  const gate = isMap(source?.source_gate) ? source.source_gate : null;
  const state = gate?.state ?? "unknown";
  const revision = isNonEmptyStr(source?.source_revision) ? source.source_revision : null;

  if (state === "ready" && revision !== null) return null;
  if (state === "ready" && revision === null) {
    return {
      code: "SOURCE_NOT_DURABLE",
      gate: "pending_durable",
      why_now: "来源自称 ready 但没有 source_revision：不得凭未耐久观察推进",
      resume_condition: "会话脱离内存后重新核验（observeSession 返回 prepared + revision）",
      recheck_via: "observeSession",
    };
  }
  switch (state) {
    case "pending_durable":
      return {
        code: "SOURCE_NOT_DURABLE",
        gate: state,
        why_now: "宿主尚未确认持久：会话仍在内存（live lease 无 revision），可读 ≠ 已保存",
        resume_condition: "会话脱离内存后重新核验来源（observeSession 返回 prepared + revision）",
        recheck_via: "observeSession",
      };
    case "partial":
      return {
        code: "SOURCE_NOT_DURABLE",
        gate: state,
        why_now: "只有部分范围耐久可读：缺口前止步",
        resume_condition: "等宿主补齐或缩小请求范围后重新核验",
        recheck_via: "observeSession",
      };
    case "unavailable":
      return {
        code: "SOURCE_UNAVAILABLE",
        gate: state,
        why_now: "来源缺失或无权限",
        resume_condition: "来源恢复或授权变化后重新核验",
        recheck_via: "listSessions/readSession",
      };
    case "unsupported":
      return {
        code: "HOST_UNSUPPORTED",
        gate: state,
        why_now: "adapter 能力缺失，无法核验来源",
        resume_condition: "能力探测通过后重新核验",
        recheck_via: "staticCapabilities",
      };
    case "checking":
      return {
        code: "SOURCE_CHECKING",
        gate: state,
        why_now: "来源正在核验中",
        resume_condition: "核验结束（ready / pending_durable / partial / unavailable）后重新核验",
        recheck_via: "observeSession",
      };
    default:
      return {
        code: "SOURCE_UNKNOWN",
        gate: "unknown",
        why_now: "来源尚未核验（SourceGate.unknown 不是任务成功状态）",
        resume_condition: "先做来源核验（checking → ready/pending_durable/partial/unavailable/unsupported）",
        recheck_via: "observeSession",
      };
  }
}

/**
 * 推进计划：逐单元回答「能不能推进、为什么不能、什么条件下能」。
 *
 * @param {object} opts
 * @param {object[]} opts.units CoverageUnit 列表
 * @param {object} opts.source 来源状态（可直接传 session-reader 的 `readSourceStatus` 结果）
 * @param {object|null} [opts.watermark] 显式水位；不给就从 `source` 取
 * @param {number|null} [opts.requestedThroughSeq] 本次请求推进到的 seq；不给就取 gate.requested_through_seq
 *
 * 纯函数：来源状态由调用方传入 ⇒ 不依赖宿主运行期，可离线证伪。
 */
export function planAdvance({ units = [], source = {}, watermark = null, requestedThroughSeq = null } = {}) {
  if (!isArr(units)) fail("INVALID_ARGUMENT", "units 必须是数组");

  const block = sourceBlockReason(source);
  const gateState = isMap(source?.source_gate) ? source.source_gate.state ?? "unknown" : "unknown";
  const revision = isNonEmptyStr(source?.source_revision) ? source.source_revision : null;
  const sourceReady = block === null;

  // ---- 水位 ----
  // 复用 M1 schema 守卫，但**不要求三水位必须已建立**：刚开始处理时 processed 天然是 null。
  // 真正决定「能不能推进 processed」的是两条：
  //   ① durable ≤ observed（来源侧的耐久上界自洽）
  //   ② requested ≤ durable（ready 只证明 requested_range）
  const pick = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
  const wm = isMap(watermark) ? watermark : source;
  const observed = pick(wm.observed_through_seq);
  const durable = pick(wm.durable_through_seq);
  const processed = pick(wm.processed_through_seq);
  const requested = pick(requestedThroughSeq) ?? pick(source?.source_gate?.requested_through_seq);
  const established = observed !== null && durable !== null && processed !== null;

  const wmErrors = [];
  const gateForInvariant = isMap(source?.source_gate) ? { ...source.source_gate } : null;
  if (
    gateForInvariant
    && gateForInvariant.state === "ready"
    && !Number.isInteger(gateForInvariant.requested_through_seq)
    && requested !== null
  ) {
    // 调用方显式声明了本次请求范围 ⇒ 用它核对「ready 只证明 requested_range」。
    gateForInvariant.requested_through_seq = requested;
  }
  if (established) {
    // 三水位齐备时，整条不变式交给 M1 的守卫判（不在这里重写一份）。
    const r = validateWatermarks(
      {
        observed_through_seq: observed,
        durable_through_seq: durable,
        processed_through_seq: processed,
        ...(gateForInvariant ? { source_gate: gateForInvariant } : {}),
      },
      { field: "watermark" },
    );
    if (!r.ok) wmErrors.push(...r.errors);
  } else {
    // 水位尚未建立（刚开始处理）：只做能做的两条排序检查。
    if (observed !== null && durable !== null && durable > observed) {
      wmErrors.push({
        code: "WATERMARK_INVARIANT_VIOLATION",
        field: "durable_through_seq",
        message: `durable(${durable}) 不得超过 observed(${observed})`,
      });
    }
    if (processed !== null && durable !== null && processed > durable) {
      wmErrors.push({
        code: "WATERMARK_INVARIANT_VIOLATION",
        field: "processed_through_seq",
        message: `processed(${processed}) 不得超过 durable(${durable})：未耐久不得报已处理`,
      });
    }
  }
  const requestedWithinDurable = requested === null ? null : durable === null ? false : requested <= durable;
  if (gateForInvariant?.state === "ready" && requested === null) {
    // ready 只证明 requested_range；连范围都没声明就无法核验，不得当成可推进。
    wmErrors.push({
      code: "REQUESTED_RANGE_UNSPECIFIED",
      field: "source_gate.requested_through_seq",
      message: "gate=ready 但未声明 requested_through_seq：ready 只证明 requested_range，缺范围无法核验",
    });
  }
  const watermarkAdvanceAllowed = sourceReady && wmErrors.length === 0 && requestedWithinDurable !== false;

  const decisions = units.map((u) => {
    const base = { unit_id: u?.unit_id ?? null, state: u?.state ?? null, layer: u?.layer ?? null };
    if (u?.state === "processed") {
      return { ...base, can_advance: false, reason: "ALREADY_PROCESSED", blocked_reason: null };
    }
    if (u?.state === "excluded") {
      return {
        ...base,
        can_advance: false,
        reason: "EXCLUDED_NOT_COUNTED_AS_UNDERSTOOD",
        blocked_reason: "EXCLUDED_NOT_COUNTED_AS_UNDERSTOOD",
        exclusion_reason: u?.exclusion?.reason ?? null,
        resume_condition: "改变排除范围需显式调度（excluded → pending）",
      };
    }
    if (u?.state === "failed") {
      return {
        ...base,
        can_advance: false,
        reason: "FAILED_AWAITING_EXPLICIT_SCHEDULE",
        blocked_reason: "FAILED_AWAITING_EXPLICIT_SCHEDULE",
        failure_code: u?.failure?.code ?? null,
        resume_condition: "显式调度（failed → pending）后重试",
      };
    }
    // pending：先看来源，再看水位，再看窗口消费。
    if (!sourceReady) {
      return {
        ...base,
        can_advance: false,
        reason: "SOURCE_BLOCKED",
        blocked_reason: block.code,
        why_now: block.why_now,
        resume_condition: block.resume_condition,
        recheck_via: block.recheck_via,
      };
    }
    if (!watermarkAdvanceAllowed) {
      return {
        ...base,
        can_advance: false,
        reason: "WATERMARK_BLOCKS_ADVANCE",
        blocked_reason: "WATERMARK_NOT_ADVANCEABLE",
        why_now: wmErrors.length > 0
          ? `水位不变式不成立：${wmErrors[0].message}`
          : `requested(${requested}) 超出 durable(${durable})：ready 只证明 requested_range`,
        resume_condition: "来源耐久上界覆盖请求范围后重新核验",
        recheck_via: "observeSession",
      };
    }
    if (isMap(u?.window) && u?.window_consumed !== true) {
      return {
        ...base,
        can_advance: false,
        reason: "WINDOW_NOT_CONSUMED",
        blocked_reason: "WINDOW_NOT_CONSUMED",
        why_now: "窗口尚未有「模型真正消费」的证据",
        resume_condition: "取得消费回执后重试；失败窗口继续排队",
        recheck_via: "recordWindowConsumption",
      };
    }
    return {
      ...base,
      can_advance: true,
      reason: "READY",
      blocked_reason: null,
      requires: isMap(u?.semantic_analysis_receipt) ? ["mark_processed"] : ["semantic_analysis_validated"],
    };
  });

  const advanceable = decisions.filter((d) => d.can_advance).map((d) => d.unit_id);
  const blocked = decisions.filter((d) => !d.can_advance);
  const blockedByReason = {};
  for (const d of blocked) {
    const k = d.blocked_reason ?? d.reason ?? "UNKNOWN";
    blockedByReason[k] = (blockedByReason[k] ?? 0) + 1;
  }

  return {
    version: COVERAGE_VERSION,
    gate: gateState,
    source_ready: sourceReady,
    source_revision: revision,
    source_block: block,
    watermark: {
      observed_through_seq: observed,
      durable_through_seq: durable,
      processed_through_seq: processed,
      requested_through_seq: requested,
      // 三水位是否已建立（未建立不是错误，只是还没处理过）。
      established,
      requested_within_durable: requestedWithinDurable,
      valid: wmErrors.length === 0,
      errors: wmErrors,
    },
    // 水位只有在来源就绪、不变式成立、且请求范围在耐久上界内时才允许前进（PRD §9.5：水位不前进）。
    watermark_advance_allowed: watermarkAdvanceAllowed,
    job_state_hint: watermarkAdvanceAllowed ? "running" : "blocked",
    decisions,
    advanceable,
    blocked,
    blocked_by_reason: blockedByReason,
    // 每个被挡住的单元都必须能回答「为什么现在不能推进」。
    blocked_reasons_complete: blocked.every((d) => isNonEmptyStr(d.blocked_reason) || isNonEmptyStr(d.reason)),
  };
}

/**
 * 会话脱离内存后**重新核验**并续做（PRD §9.5「条件改变后核验再 resume」）。
 *
 * 纯重算：**不缓存上一次结论**。上一轮 ready 这轮 live ⇒ 重新变回 blocked；
 * 上一轮 blocked 这轮 prepared+revision ⇒ 变回可推进。
 */
export function reverifyResume({ units = [], source = {}, watermark = null, requestedThroughSeq = null, previous = null } = {}) {
  const next = planAdvance({ units, source, watermark, requestedThroughSeq });
  const prevAdvanceable = new Set(isArr(previous?.advanceable) ? previous.advanceable : []);
  return {
    ...next,
    reverified: true,
    previous_gate: previous?.gate ?? null,
    previous_source_revision: previous?.source_revision ?? null,
    newly_advanceable: next.advanceable.filter((id) => !prevAdvanceable.has(id)),
    still_blocked: next.blocked.map((d) => d.unit_id),
    resumable: next.source_ready && next.watermark_advance_allowed,
  };
}
