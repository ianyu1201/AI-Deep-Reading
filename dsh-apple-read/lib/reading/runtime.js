/**
 * lib/reading/runtime.js · M6 单一注入点（执行计划 §1 表 #7 的接线层）
 *
 * ## 这个文件是干什么的
 *
 * M1–M5 各自是**纯模块**（`schema` / `file-service` / `session-reader` / `coverage` /
 * `compiler` / `policy`），谁都不读宿主、不碰网络。M6 要把它们接进宿主半端
 * （`lib/index.js`）。接线必须只有**一处**：否则同一份 `45-书籍` 会被解析两遍、
 * 两份 session 适配器、两套路径守卫——「不要各自造第二份来源」。
 *
 * 所以这里就是那唯一一处：
 *
 * ```
 *   settings ─┐
 *             ├─► resolveBookKbDir() ──► createFileService(root)   ← M1：唯一写盘口
 *   ctx.get("sessionQuery") ─────────► createSessionReader()      ← M2：唯一读会话口
 *             ├─► 九项 capabilities（policy 4 + compiler 5）        ← M4/M5 的注入面
 *             └─► 只读投影：index / vault / coverage / proposals
 *                 / recommendations / maintenance / health
 * ```
 *
 * ## 三条不可越过的纪律
 *
 * 1. **写盘只有一个出口**：本文件不直接写任何文件；所有写都经 M1 `file-service`，
 *    而它的 `root` 恒等于 `bookKbDir`（`45-书籍/`）。`realpath + isInside` 越界守卫
 *    在 `file-service.js` 里，本文件只负责**把根设对**。
 * 2. **未知就说未知**：`45-书籍/` 里没有的记录（覆盖单元、推荐运行…）一律
 *    `known:false` / `null`，**绝不**把「没读到」显示成 0 或「无缺口」。
 *    解析失败**不是** 0（规范 §4）。
 * 3. **能力缺失不伪装**：九项 capability 每一项都如实报 `backing` 与 `status`；
 *    没有真实后端的（`readSourceSpan` 需要引擎的 span-by-id 入口，属 M8）
 *    返回 `{ok:false, code:"..."}`，**不返回 `{ok:true}` 假装读到了**。
 *
 * ## 与 M8 的边界（不要在这里假装关掉）
 *
 * `readSourceSpan` 需要 `books_rag.py` 的「按 span_id 取原文」入口，该入口属 M8
 * （执行计划 §1 表 #9）。本文件把它做成**诚实失败**：返回 `ok:false`，于是
 * `policy` 会把相关候选按 `source_unavailable` 排除——这是契约行为，不是降级。
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { recommendationNoteBody } from "./recommendation-note-body.js";
import { createFileService } from "./file-service.js";
import { BOOK_DOMAIN, DEFAULT_KNOWLEDGE_ROOT, OBJECT_TYPES } from "./book-domain.js";
import { createSessionReader } from "./session-reader.js";
import { SCHEMA_VERSION, sha256Hex, validateNote } from "./schema.js";
import { buildCoverageReport } from "./coverage.js";
import { KnowledgeCompiler } from "./compiler.js";
import {
  B_SCORE_ANCHORS,
  POLICY_AND_MODEL_METADATA_KEYS,
  RESULT_KEYS,
  RecommendationPolicy,
  assertResultShape,
  bookRunId,
  buildInputManifestRefs,
  buildRecommendationRunNote,
  bookInfoRel,
  buildBookInfoNote,
  buildReadingEvidenceNote,
  buildUnderstandingObservationNote,
  evidenceInteractionKey,
  readingEvidenceId,
  readingEvidenceRel,
  understandingObservationId,
  understandingObservationRel,
  EVIDENCE_KINDS,
  EVIDENCE_LABELS,
  mapRecommendationResultToRun,
  nextRevision,
  recommendationInputFingerprint,
} from "./policy.js";

export const RUNTIME_VERSION = "1.0.0";

/**
 * 并发锁（M10 阶段 2c）：**同一本书同一时刻只允许一次「分析 + 落盘」**。
 *
 * 为什么是进程内 Map：宿主是单进程；进程崩溃/重启即自然释放，**不会留下僵尸锁**
 * （把锁写进盘上文件反而会引入「锁文件残留 ⇒ 永远分析不了」的新故障）。
 * 第二个并发请求**立刻**返回 `ANALYSIS_IN_PROGRESS`（正在分析中）：不排队、不覆盖、不写盘。
 *
 * 键取调用方给的书名（面板只发书名）；解析出的内容身份要等分析完才有，来不及做锁。
 */
const ANALYSES_IN_FLIGHT = new Map();

/** 规范 §4 的六个生成区，顺序即「按表格顺序出现」的判定依据。 */
export const INDEX_ZONES = Object.freeze([
  "books",
  "evidence",
  "recommendations",
  "proposals",
  "maintenance",
  "health",
]);

/** 规范 §4 的字面串（start/end，不另造 begin 标记）。 */
export function indexMarkers(zone) {
  return { start: `<!-- reading-index:${zone}:start -->`, end: `<!-- reading-index:${zone}:end -->` };
}

/** 书籍知识库目录的环境变量覆盖（与 `APPLE_READ_READING_DIR` 同族，但不共用）。 */
export const BOOK_KB_DIR_ENV = "APPLE_READ_BOOK_KB_DIR";

/**
 * 提示词里那段摘要的硬上限（字符）。
 *
 * 「遵守上下文预算：少而准，不塞完整会话、不塞 prompt」。这个数字不是装饰：
 * `promptSummary()` 一定在预算内截断，并由自检断言。
 */
export const PROMPT_SUMMARY_MAX_CHARS = 1200;

/** 摘要缓存的刷新节流（毫秒）：避免每次 reading 路由命中都重扫目录。 */
export const PROMPT_SUMMARY_REFRESH_MS = 1000;

/** 扫描时跳过的目录（规范 §5：「排除模板/状态目录」）。 */
const SKIP_DIRS = new Set([".state", ".cache", ".git", "node_modules", "__pycache__"]);

/**
 * F4（4b/4c）：覆盖账本目录（**缓存，不是知识**）。
 *
 * `.cache/` 已在 `SKIP_DIRS` 里 ⇒ 账本永远不会被 `scanVault()` 当成笔记，
 * 也就不会进 `library()` 的书籍/知识计数。这是「缓存不是知识」的结构性保证，
 * 不是靠约定。
 */
const COVERAGE_LEDGER_DIR = ".cache/coverage";
const MAX_WALK_DEPTH = 6;
const MAX_SCAN_FILES = 5000;
const MAX_LISTED_NOTES = 500;

/** 普通映射判断（非 null、非数组的对象）。runtime 里多处要判「是不是映射」。 */
const isMap = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * 解析书籍知识库目录。优先级：环境变量 > 设置项 > 域层默认根。
 *
 * **不要**用 `DEFAULT_READING_DIR`（`~/Documents/deepseek-harness/读书会话`）：
 * 那是**伴读会话归拢目录**，跟「书籍知识库」是两件事（本里程碑的硬要求）。
 * 默认值直接复用域层 `book-domain.js` 的 `DEFAULT_KNOWLEDGE_ROOT`（M10 收口 A：
 * 常量从 `file-service.js` **上移到域层**，`file-service.js` 已不再有默认根、`root` 改必填），
 * 保证「写盘根」与「读盘根」仍是同一个常量、不会各自漂移 —— `runtime.js` 仍是唯一注入点。
 */
export function resolveBookKbDir(settings, env = process.env) {
  const fromEnv = String(env?.[BOOK_KB_DIR_ENV] ?? "").trim();
  const fromSettings = String(settings?.bookKbDir ?? "").trim();
  const raw = fromEnv || fromSettings;
  const source = fromEnv ? "env" : fromSettings ? "settings" : "default";
  if (!raw) return { path: DEFAULT_KNOWLEDGE_ROOT, source, raw: "" };
  return { path: raw, source, raw };
}

/**
 * 把文本截到提示词预算内（超长就截断并加省略号）。
 *
 * 单独导出是为了**可被直接测**：否则「摘要没超预算」只能靠一份恰好很长的语料去
 * 偶然触发，测不到就等于没测。
 */
export function trimToBudget(text, max = PROMPT_SUMMARY_MAX_CHARS) {
  const s = String(text ?? "");
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

// --------------------------------------------------------------------------- //
// 索引六区解析（规范 §4）
// --------------------------------------------------------------------------- //

/**
 * 解析索引里的六个生成区。
 *
 * 规范 §4 的硬规则，逐条落地：
 *   - 每个开始/结束串在索引中必须**唯一**、恰好**配成一对**；
 *   - 六个区**按表格顺序**出现；
 *   - 开始**先于**结束；
 *   - 区块**不嵌套**。
 * 任一不满足 ⇒ `writable:false`（「停止整份索引的自动写入，保留原文件并给出差异」）。
 *
 * 本函数**只读文本**，不写文件、不改文本；它回答的是「现在能不能安全地自动写这一页」。
 */
export function parseIndexZones(text) {
  const src = typeof text === "string" ? text : "";
  const problems = [];

  const zones = INDEX_ZONES.map((zone) => {
    const { start, end } = indexMarkers(zone);
    const starts = [];
    const ends = [];
    for (let i = src.indexOf(start); i >= 0; i = src.indexOf(start, i + 1)) starts.push(i);
    for (let i = src.indexOf(end); i >= 0; i = src.indexOf(end, i + 1)) ends.push(i);

    const startFound = starts.length > 0;
    const endFound = ends.length > 0;
    const unique = starts.length === 1 && ends.length === 1;
    const startBeforeEnd = unique && starts[0] < ends[0];
    const content = unique && startBeforeEnd
      ? src.slice(starts[0] + start.length, ends[0])
      : null;

    if (starts.length > 1) problems.push({ code: "MARKER_DUPLICATE", zone, marker: "start", count: starts.length });
    if (ends.length > 1) problems.push({ code: "MARKER_DUPLICATE", zone, marker: "end", count: ends.length });
    if (!startFound) problems.push({ code: "MARKER_MISSING", zone, marker: "start" });
    if (!endFound) problems.push({ code: "MARKER_MISSING", zone, marker: "end" });
    if (unique && !startBeforeEnd) problems.push({ code: "MARKER_OUT_OF_ORDER", zone });

    return {
      zone,
      start_found: startFound,
      end_found: endFound,
      start_count: starts.length,
      end_count: ends.length,
      unique,
      paired: unique && startBeforeEnd,
      start_index: starts.length === 1 ? starts[0] : null,
      end_index: ends.length === 1 ? ends[0] : null,
      content,
      content_chars: content === null ? null : content.length,
    };
  });

  // 顺序：六个区的 start 必须按 INDEX_ZONES 顺序出现（缺失的区不参与顺序判定）
  const present = zones.filter((z) => z.start_index !== null);
  let ordered = true;
  for (let i = 1; i < present.length; i++) {
    if (present[i].start_index < present[i - 1].start_index) { ordered = false; break; }
  }
  if (!ordered) problems.push({ code: "ZONE_OUT_OF_ORDER", zone: null });

  // 嵌套：任何一区的区间不得包含另一区的完整区间
  let nested = false;
  const spans = zones
    .filter((z) => z.paired)
    .map((z) => ({ zone: z.zone, start: z.start_index, end: z.end_index }))
    .sort((a, b) => a.start - b.start);
  for (let i = 0; i < spans.length; i++) {
    for (let j = i + 1; j < spans.length; j++) {
      if (spans[j].end < spans[i].end) {
        nested = true;
        problems.push({ code: "ZONE_NESTED", zone: spans[j].zone, outer: spans[i].zone });
      }
    }
  }

  const allPaired = zones.every((z) => z.paired);
  const ok = allPaired && ordered && !nested && problems.length === 0;

  return {
    ok,
    zones,
    problems,
    /** 规范 §4/§5：标记缺失、重复、错序、未配对或嵌套 ⇒ 停止整份索引的自动写入。 */
    writable: ok,
    reason: ok ? null : "索引标记不合法：停止自动写入，保留原文件并给出差异，等待修复后重新核对 hash",
  };
}

// --------------------------------------------------------------------------- //
// 只读投影
// --------------------------------------------------------------------------- //

function emptyByType() {
  const out = Object.create(null);
  for (const t of OBJECT_TYPES) out[t] = 0;
  return out;
}

/** 从已解析的 frontmatter 里取「最小可展示字段」——**不含正文**。 */
function noteSummary(rel, data, hash, formalValid = null) {
  return {
    rel,
    id: typeof data?.id === "string" ? data.id : null,
    object_type: typeof data?.object_type === "string" ? data.object_type : null,
    title: typeof data?.title === "string" ? data.title : null,
    revision: Number.isInteger(data?.revision) ? data.revision : null,
    knowledge_status: data?.knowledge_status ?? null,
    origin: data?.origin ?? null,
    confirmation: data?.confirmation ?? null,
    state: data?.state ?? null,
    created_at: data?.created_at ?? null,
    updated_at: data?.updated_at ?? null,
    content_hash: hash,
    /** 只有 formal 校验通过才算「正式记录」；不过的进 invalid_*，**不算 0 也不算数**。 */
    formal_valid: formalValid,
  };
}

// --------------------------------------------------------------------------- //
// 只读投影：`RecommendationRun` 笔记 → `RecommendationResult`（M8 补的跨层契约）
// --------------------------------------------------------------------------- //

/**
 * `policy_and_model_metadata` 里**没有**被 `recommendation_run` 持久化的字段。
 *
 * 为什么必须显式列出：PRD :469 的 run 只存「policy/model/template 版本 + 输入指纹 + 预算」，
 * 而 PRD :936 的 result 元数据还含生效权重、λ 上限、启用维度等。**没存就是不知道**，
 * 投影只能给 `null`；给「默认值」等于把「不知道」伪装成「这一跑就是默认配置」。
 */
export const NOT_PERSISTED_METADATA_FIELDS = Object.freeze([
  "lambda_cap",
  "enabled_dimensions",
  "weights",
  "retrieval_used_as_baseline",
]);

/**
 * 元数据里**可以从冻结常量推导**的字段。
 *
 * `b_anchors` 在 `policy.js` 里恒等于 `{...B_SCORE_ANCHORS}`（PRD :271 的 0—3 锚点表，
 * 逐次运行不变、也不随 `policy_config` 改变），所以投影它**不是编造**：它是契约常量。
 * 这里仍然单独标出来，让调用方能区分「来自常量」与「来自本次运行记录」。
 */
export const DERIVED_METADATA_FIELDS = Object.freeze(["b_anchors"]);

/** 投影失败的错误码（闭合值域，便于测试与面板分支）。 */
export const RESULT_PROJECTION_CODES = Object.freeze([
  "NO_READY_RUN",
  "RUN_NOT_READABLE",
  "RUN_INVALID_SHAPE",
]);

function runSortKey(n) {
  const at = String(n?.updated_at ?? n?.created_at ?? "");
  const ct = String(n?.created_at ?? "");
  return [at, ct, String(n?.run_id ?? n?.id ?? "")];
}

/** 按 (updated_at, created_at, run_id) 全序比较，**降序**（新在前）。纯字符串比较，不依赖 locale。 */
function compareRunsDesc(a, b) {
  const ka = runSortKey(a);
  const kb = runSortKey(b);
  for (let i = 0; i < 3; i += 1) {
    if (ka[i] === kb[i]) continue;
    return ka[i] < kb[i] ? 1 : -1;
  }
  return 0;
}

/**
 * 「当前该显示哪一次理解」——**纯函数**，可被直接测。
 *
 * M10 阶段 2「一本书一个理解」之后，正常运行下**一本书只有一条** `recommendation_run`。
 * 但盘上仍可能有**多条 ready**：M10 之前按输入指纹派生 run_id 留下的历史笔记，或者 M13 之前
 * 由**路径寻址**（`path_hash8`，已被 M13 换掉）留下的旧笔记。这时**不装作只剩一条**，如实报出条数。
 *
 * 规则（确定性、可复算）：
 *   1. `runs` 按 (updated_at, created_at, run_id) 降序排出一个**全序**（纯字符串比较，不依赖 locale）；
 *   2. 只有 `state === "ready"` 的运行是候选；一个都没有 ⇒ `result_run_id = null`
 *      + `reason = "NO_READY_RUN"`，**绝不**拿 stale 的 run 冒充当前（用户点名的反例）；
 *   3. 多条 ready ⇒ 取全序第一名（最新），并置 `ambiguous: true` + `ready_run_count`，
 *      由调用方在 `result_note` 里说清「显示的是哪一条、盘上共有几条」。
 *
 * @param {Array<object>} runs run 元数据（`{run_id, state, created_at, updated_at}`）
 */
export function selectCurrentRun(runs) {
  const list = (Array.isArray(runs) ? runs : [])
    .filter((n) => n && typeof (n.run_id ?? n.id) === "string" && String(n.run_id ?? n.id).trim() !== "")
    .map((n) => ({ ...n, run_id: String(n.run_id ?? n.id) }))
    .sort(compareRunsDesc);
  const ready = list.filter((n) => n.state === "ready");
  const picked = ready[0] ?? null;
  return {
    result_run_id: picked ? picked.run_id : null,
    reason: picked ? null : "NO_READY_RUN",
    ready_run_ids: ready.map((n) => n.run_id),
    ready_run_count: ready.length,
    ambiguous: ready.length > 1,
    not_ready_run_ids: list.filter((n) => n.state !== "ready").map((n) => n.run_id),
  };
}

/**
 * `recommendation_run` 的 frontmatter → `RecommendationResult`（**恰好 7 键**）。
 *
 * 纪律：
 *   · 只搬运**盘上真有的**字段；缺的字段进 `NOT_PERSISTED_METADATA_FIELDS` 给 `null`，
 *     不填默认值、不猜；
 *   · 产出的 result 必须过 `policy.js` 的 `assertResultShape`（与 policy 同一把尺子）；
 *     过不了就**不返回半成品**，而是 `{ok:false, code:"RUN_INVALID_SHAPE"}`——
 *     宁可让面板走诚实空态，也不让它渲染一个「一半是编的」两层。
 *   · **纯函数**：不读盘、不写盘、不看时间。
 */
export function projectRecommendationResultFromRun(runData) {
  if (!runData || typeof runData !== "object" || Array.isArray(runData)) {
    return { ok: false, code: "RUN_INVALID_SHAPE", message: "run 笔记的 frontmatter 不是映射" };
  }
  const persisted = {
    policy: runData.policy ?? null,
    model: runData.model ?? null,
    prompt_template_version: runData.prompt_template_version ?? null,
    candidate_set_version: runData.candidate_set_version ?? null,
    input_fingerprint: runData.input_fingerprint ?? null,
    input_manifest_refs: Array.isArray(runData.input_manifest_refs) ? [...runData.input_manifest_refs] : null,
    budget: runData.budget_usage ?? null,
  };
  const metadata = {
    policy: persisted.policy,
    model: persisted.model,
    prompt_template_version: persisted.prompt_template_version,
    candidate_set_version: persisted.candidate_set_version,
    input_fingerprint: persisted.input_fingerprint,
    input_manifest_refs: persisted.input_manifest_refs,
    // ↓ 未被 run 持久化：显式 null（不是「默认值」）
    lambda_cap: null,
    enabled_dimensions: null,
    weights: null,
    // ↓ 冻结常量（PRD :271 的锚点表），逐次运行不变
    b_anchors: { ...B_SCORE_ANCHORS },
    retrieval_used_as_baseline: null,
    budget: persisted.budget,
  };
  const mk = Object.keys(metadata);
  const want = [...POLICY_AND_MODEL_METADATA_KEYS];
  if (mk.length !== want.length || want.some((k) => !Object.hasOwn(metadata, k))) {
    return {
      ok: false,
      code: "RUN_INVALID_SHAPE",
      message: `投影出的 policy_and_model_metadata 键集合与 policy.js 不一致：${mk.join(",")}`,
    };
  }
  const result = {
    outcome: runData.result_outcome,
    book_guide: runData.book_guide ?? null,
    personalized_items: Array.isArray(runData.personalized_items) ? runData.personalized_items : [],
    personalization_status: runData.personalization_status,
    exclusions: Array.isArray(runData.exclusions) ? runData.exclusions : [],
    constraints_report: runData.constraints_report ?? null,
    policy_and_model_metadata: metadata,
  };
  const rk = Object.keys(result).sort();
  const rw = [...RESULT_KEYS].sort();
  if (rk.length !== rw.length || rk.some((k, i) => k !== rw[i])) {
    return {
      ok: false,
      code: "RUN_INVALID_SHAPE",
      message: `投影出的 RecommendationResult 顶层键不是 7 键：${rk.join(",")}`,
    };
  }
  try {
    assertResultShape(result);
  } catch (e) {
    return { ok: false, code: "RUN_INVALID_SHAPE", message: String(e?.message || e) };
  }
  return {
    ok: true,
    result,
    projection: {
      reconstructed: true,
      from: "recommendation_run",
      derived_metadata_fields: [...DERIVED_METADATA_FIELDS],
      not_persisted_metadata_fields: [...NOT_PERSISTED_METADATA_FIELDS],
      note: "result 由已保存的 recommendation_run 笔记只读投影而来：未被 run 持久化的元数据字段为 null"
        + "（不填默认值）；b_anchors 取自 policy.js 冻结常量。投影不等于 policy.rank 的原始内存返回。",
    },
  };
}

/**
 * 把引擎 `/source-span` 的返回翻成一个**结构合法的 `SpanRef`**（M15 0b）。
 *
 * 纪律（M13 的教训：不写第二套实现）：
 *   · 这里**一个定位都不自己算** —— 每个字段都原样取自引擎，缺一个就 `ok:false`；
 *   · 缺字段时**不兜底、不编造**：宁可 `book_evidence` 为空，也不填一个假的 `block_id`
 *     （假定位比没有定位更坏：它会让人以为能回原文核对）。
 *   · `locator_quality` / `quote_type` 是**对引擎事实的转述**：偏移是归一化正文里的精确区间
 *     ⇒ `exact_normalized_text`；引文是逐字原文 ⇒ `verbatim`。二者都不是"评分"。
 *
 * @returns {{ok:true, value:object, missing:string[]} | {ok:false, missing:string[]}}
 */
export function buildSpanRefFromSpan(span = {}) {
  const missing = [];
  const needStr = (v, name) => {
    if (typeof v !== "string" || v.trim() === "") { missing.push(name); return null; }
    return v;
  };
  const needInt = (v, name) => {
    if (!Number.isInteger(v) || v < 0) { missing.push(name); return null; }
    return v;
  };
  const ref = {
    book_id: needStr(span.book_id, "book_id"),
    book_version_id: needStr(span.book_version_id, "book_version_id"),
    section_id: needStr(span.section_id, "section_id"),
    block_id: needStr(span.block_id, "block_id"),
    span_id: needStr(span.span_id, "span_id"),
    href: needStr(span.href, "href"),
    start_codepoint: needInt(span.start_codepoint, "start_codepoint"),
    end_codepoint: needInt(span.end_codepoint, "end_codepoint"),
    text_hash: needStr(span.text_hash, "text_hash"),
    locator_quality: "exact_normalized_text",
    quote_type: "verbatim",
  };
  if (missing.length > 0) return { ok: false, missing };
  if (!(ref.end_codepoint > ref.start_codepoint)) {
    return { ok: false, missing: ["end_codepoint>start_codepoint"] };
  }
  if (!/^[0-9a-f]{64}$/.test(ref.text_hash)) return { ok: false, missing: ["text_hash(64hex)"] };
  return { ok: true, value: ref, missing: [] };
}

/**
 * 造一个「读盘 + 投影」的运行时。
 *
 * @param {object} opts
 * @param {object} opts.ctx 宿主 ctx（用于 `ctx.get` 兜底取服务）
 * @param {() => object} opts.getSettings 取当前设置
 * @param {(path: string, init?: object) => Promise<Response>} [opts.sidecarFetch] 引擎转发（retrieve 用）
 * @param {(payload: object, opts?: object) => Promise<object>} [opts.generateStructured] 非流式结构化生成（LLM）
 * @param {(msg: string, detail?: object) => void} [opts.logger]
 * @param {() => Date} [opts.now]
 */
export function createReadingRuntime(opts = {}) {
  const ctx = opts.ctx ?? null;
  const getSettings = typeof opts.getSettings === "function" ? opts.getSettings : () => ({});
  const sidecarFetch = typeof opts.sidecarFetch === "function" ? opts.sidecarFetch : null;
  const generateStructured = typeof opts.generateStructured === "function" ? opts.generateStructured : null;
  const log = typeof opts.logger === "function" ? opts.logger : () => {};
  const now = typeof opts.now === "function" ? opts.now : () => new Date();

  /** 缓存（按 root 失效）：同一个进程里目录被换掉时要重建。 */
  const cache = { root: null, svc: null, svcError: null, scan: null, scanAt: 0, promptSummary: null, promptSummaryAt: 0 };
  const SCAN_TTL_MS = 2000;

  function bookKbDir() {
    return resolveBookKbDir(getSettings());
  }

  /**
   * `ctx.get` 兜底读取。
   *
   * 为什么用 `get` 而不是 `ctx.sessionQuery`：cordis 的 `get` 是**不带 inject 要求**的读取
   * （`cordis/lib/index.js` 注释原文「Read a service from the store without the inject
   * requirement」），服务不在时返回 `undefined` 而**不抛**。插件顶层 `inject` 里已经声明了
   * `sessionQuery`（真宿主语义：插件确实依赖它），所以正常情况下它是有的；但服务在装载后
   * 被 dispose（热重载）时 `get` 会变回 `undefined`——那时 reading 路由如实报
   * `HOST_UNSUPPORTED`，**不让整个插件挂掉**，面板/检索/SSE 照旧。
   */
  function getService(name) {
    for (const scope of [ctx]) {
      if (!scope) continue;
      const g = scope.get;
      if (typeof g !== "function") continue;
      try {
        const v = g.call(scope, name);
        if (v !== undefined && v !== null) return v;
      } catch (e) {
        log(`apple-read: ctx.get(${name}) 抛错`, { message: String(e?.message || e) });
      }
    }
    return null;
  }

  // ----------------------------------------------------------------------- //
  // M1：文件服务（唯一写盘口）
  // ----------------------------------------------------------------------- //

  async function fileService() {
    const { path, source } = bookKbDir();
    if (cache.svc && cache.root === path) {
      return cache.svcError ? { ok: false, code: cache.svcError.code, message: cache.svcError.message, root: path, root_source: source } : { ok: true, svc: cache.svc, root: path, root_source: source };
    }
    cache.root = path;
    cache.svc = null;
    cache.svcError = null;
    cache.scan = null;
    try {
      const svc = await createFileService({ root: path });
      cache.svc = svc;
      return { ok: true, svc, root: path, root_source: source };
    } catch (e) {
      // 根不存在 / 不可 realpath：如实报，不假装有知识库
      cache.svcError = { code: e?.code ?? "FILE_SERVICE_UNAVAILABLE", message: String(e?.message || e) };
      return { ok: false, code: cache.svcError.code, message: cache.svcError.message, root: path, root_source: source };
    }
  }

  // ----------------------------------------------------------------------- //
  // M2：会话适配器（唯一读会话口）
  // ----------------------------------------------------------------------- //

  function sessionReader() {
    const sessionQuery = getService("sessionQuery");
    if (!sessionQuery) {
      return {
        ok: false,
        code: "HOST_UNSUPPORTED",
        message: "sessionQuery 未注入：无法读取宿主会话（reading 路由降级，插件其余功能不受影响）",
        injected: false,
      };
    }
    const sessionProjections = getService("sessionProjections");
    return {
      ok: true,
      injected: true,
      projections: !!sessionProjections,
      reader: createSessionReader({
        sessionQuery,
        sessionProjections,
        logger: (m, d) => log(m, d),
      }),
    };
  }

  // ----------------------------------------------------------------------- //
  // 九项 capabilities（M4/M5 的唯一注入面）
  // ----------------------------------------------------------------------- //

  /** id → rel 的反查表（由扫描建立；读知识条目用）。 */
  function idIndexFromScan(scan) {
    const map = new Map();
    for (const n of scan.notes ?? []) {
      if (n.id && !map.has(n.id)) map.set(n.id, n.rel);
    }
    return map;
  }

  /**
   * 九项能力的**唯一**构造处。
   *
   * 每一项都带 `backing` 与 `status`，供 `/api/reading/health` 如实报告：
   *   ready        —— 有真实后端
   *   unsupported  —— 后端不存在（返回 ok:false，绝不假装成功）
   *   degraded     —— 有后端但当前不可用（例如引擎没起来、没有 API key）
   */
  function capabilities() {
    const report = [];
    const note = (name, backing, status, detail = null) => { report.push({ name, backing, status, detail }); };

    const fileSvc = () => fileService();

    // ---- policy 的四项 ----
    /**
     * 按 `span_id` 取原文（PRD :917 `get_source_span`）。
     *
     * M8 起接上真实后端 `python-sidecar(/source-span)`：引擎按 span_id 里的路径指纹
     * 重新定位书、重算 `text_hash`。**重算**（而不是回放记录的 hash）是这里的关键 ——
     * 原文变了 hash 就变，policy 的 `source_hash_mismatch` 才抓得到。
     */
    const readSourceSpan = async (spanId) => {
      if (typeof spanId !== "string" || spanId.trim() === "") {
        // 输入本身不合法与后端无关，先判它（否则「没注入 sidecar」会掩盖坏输入）
        return { ok: false, code: "BAD_SPAN_ID", message: "span_id 必须是非空字符串", span_id: spanId ?? null };
      }
      if (!sidecarFetch) {
        return {
          ok: false,
          code: "SIDECAR_UNAVAILABLE",
          message: "sidecar 转发未注入 ⇒ 无法按 span_id 取原文（不假装成功）",
          span_id: spanId,
        };
      }
      try {
        const up = await sidecarFetch("/source-span", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ span_id: spanId }),
        });
        const data = await up.json();
        if (data === null || typeof data !== "object" || data.ok !== true) {
          return {
            ok: false,
            code: data?.code ?? "SPAN_READ_FAILED",
            message: data?.message ?? `读不到 span ${spanId}`,
            span_id: spanId,
          };
        }
        // M12：把引擎**已经返回、之前被我们丢掉**的定位字段原样带出去。
        // 面板要「带可核对定位的原文」（哪一章、哪一段、哪个区间），而这些字段就在引擎的
        // 返回里（`book` 书名 / `section_order` 章序 / `quote_chars` 字数 / `verified`）。
        // 丢掉它们 ⇒ 面板只能显示一个 `section_id`，用户没法回原文核对。
        // 只**透传**，不在这里重新计算任何定位（重算 = 第二套实现，会与引擎漂移）。
        // 缺字段一律 `null`/`false`，不编造（引擎没给就说没有）。
        return {
          ok: true,
          span_id: data.span_id,
          book: typeof data.book === "string" && data.book !== "" ? data.book : null,
          book_version_id: data.book_version_id,
          // M15（0b）：SpanRef 要的**书内定位** —— 引擎给了就原样透传，缺一律 null（不编）。
          book_id: typeof data.book_id === "string" && data.book_id !== "" ? data.book_id : null,
          href: typeof data.href === "string" && data.href !== "" ? data.href : null,
          block_id: typeof data.block_id === "string" && data.block_id !== "" ? data.block_id : null,
          block_index: Number.isInteger(data.block_index) ? data.block_index : null,
          block_start_codepoint: Number.isInteger(data.block_start_codepoint) ? data.block_start_codepoint : null,
          block_end_codepoint: Number.isInteger(data.block_end_codepoint) ? data.block_end_codepoint : null,
          section_id: data.section_id,
          section_order: Number.isInteger(data.section_order) ? data.section_order : null,
          start_codepoint: data.start_codepoint,
          end_codepoint: data.end_codepoint,
          text_hash: data.text_hash,
          quote: data.quote,
          // 字数只透传：**不**用 `data.quote.length` 兜底 —— JS 的 length 是 UTF-16 码元数，
          // 与引擎的 codepoint 数不是同一个单位，兜底就等于编了一个数。
          quote_chars: Number.isInteger(data.quote_chars) ? data.quote_chars : null,
          verified: data.verified === true,
        };
      } catch (e) {
        return { ok: false, code: "SPAN_READ_ERROR", message: String(e?.message || e), span_id: spanId };
      }
    };
    note("readSourceSpan", "python-sidecar(/source-span)",
      sidecarFetch ? "ready" : "degraded",
      sidecarFetch ? null : "sidecar 转发未注入 ⇒ 返回 ok:false，不假装成功");

    const readKnowledge = async (ref) => {
      const fs = await fileSvc();
      if (!fs.ok) return { ok: false, code: fs.code, message: fs.message };
      const scan = await scanVault();
      const rel = idIndexFromScan(scan).get(ref);
      if (!rel) return { ok: false, code: "NOT_FOUND", message: `知识库中找不到对象 ${ref}` };
      const got = await fs.svc.readNote(rel);
      if (!got.exists) return { ok: false, code: "SOURCE_UNAVAILABLE", message: `读不到 ${rel}` };
      return {
        ok: true,
        origin: got.data?.origin ?? null,
        confirmation: got.data?.confirmation ?? null,
        knowledge_status: got.data?.knowledge_status ?? null,
        content_hash: got.hash,
      };
    };
    note("readKnowledge", "file-service(45-书籍)", "ready", null);

    const retrieve = async (query, { book_version_id: bookVersionId } = {}) => {
      if (!sidecarFetch) return [];
      try {
        const up = await sidecarFetch("/search", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ book: bookVersionId ?? "", query: String(query ?? ""), k: 5 }),
        });
        const data = await up.json();
        return data?.hits ?? [];
      } catch (e) {
        log(`apple-read: retrieve 失败（只用于计数，不影响 B）`, { message: String(e?.message || e) });
        return [];
      }
    };
    note("retrieve", "python-sidecar(/search)", sidecarFetch ? "ready" : "degraded", sidecarFetch ? null : "sidecar 转发未注入");

    const generateStructuredCap = async (payload, capOpts = {}) => {
      if (!generateStructured) {
        const e = new Error("结构化生成不可用：未注入 LLM 客户端");
        e.code = "MODEL_UNAVAILABLE";
        throw e;
      }
      return generateStructured(payload, capOpts);
    };
    note("generateStructured", "plugin-llm(non-streaming)", generateStructured ? "ready" : "degraded", generateStructured ? null : "未注入 LLM 客户端");

    const policyCapabilities = { readSourceSpan, readKnowledge, retrieve, generateStructured: generateStructuredCap };

    // ---- compiler 的五项 ----
    const readCheckedNote = async (checkId, candidateId) => {
      const fs = await fileSvc();
      if (!fs.ok) return { ok: false, code: fs.code, message: fs.message };
      const scan = await scanVault();
      const rel = idIndexFromScan(scan).get(candidateId);
      if (!rel) return { ok: false, code: "NOT_FOUND", message: `查重候选 ${candidateId} 不在 45 内` };
      const got = await fs.svc.readNote(rel);
      if (!got.exists) return { ok: false, code: "SOURCE_UNAVAILABLE", message: `读不到 ${rel}` };
      return { ok: true, content_hash: got.hash, object_id: candidateId, relative_path: rel, check_id: checkId ?? null };
    };
    note("readCheckedNote", "file-service(45-书籍)", "ready", null);

    const additionalRecalls = [];
    const requestAdditionalCandidates = async (checkId, query) => {
      // 不写第二份聊天存储、不建索引副本：只**如实记录**这次召回请求，
      // 由调用方带更新后的 check 重跑（compiler 随后会抛 blocked ADDITIONAL_RECALL_REQUIRED）。
      additionalRecalls.push({ check_id: checkId ?? null, query: query ?? null, at: now().toISOString() });
      return { ok: false, code: "ADDITIONAL_RECALL_NOT_WIRED", recorded: true, check_id: checkId ?? null };
    };
    note("requestAdditionalCandidates", "runtime-record", "ready", null);

    const readHostTurns = async (sessionEvidence) => {
      const r = sessionReader();
      if (!r.ok) return { ok: false, code: r.code, message: r.message };
      const sessionId = sessionEvidence?.session_id ?? sessionEvidence?.sessionId ?? null;
      if (!sessionId) return { ok: false, code: "MISSING_REQUIRED", message: "session_evidence 缺 session_id" };
      try {
        // 只做**耐久核验**：compiler 只检查 `{ok:true}`；这里不返回正文（不建第二份聊天存储）。
        const status = await r.reader.readSourceStatus(sessionId);
        return {
          ok: true,
          session_id: sessionId,
          source_gate: status?.source_gate?.state ?? status?.gate?.state ?? null,
          durable_through_seq: status?.durable_through_seq ?? null,
        };
      } catch (e) {
        return { ok: false, code: e?.code ?? "SOURCE_UNAVAILABLE", message: String(e?.message || e) };
      }
    };
    const sessProbe = sessionReader();
    note("readHostTurns", "session-reader(sessionQuery)", sessProbe.ok ? "ready" : "degraded",
      sessProbe.ok ? null : sessProbe.message);

    const compilerCapabilities = {
      readSourceSpan,
      readCheckedNote,
      requestAdditionalCandidates,
      readHostTurns,
      generateStructured: generateStructuredCap,
    };

    return {
      policy: policyCapabilities,
      compiler: compilerCapabilities,
      report,
      additional_recalls: additionalRecalls,
    };
  }

  // ----------------------------------------------------------------------- //
  // 知识库扫描（只读）
  // ----------------------------------------------------------------------- //

  async function walk(dir, depth, out, errors) {
    if (depth > MAX_WALK_DEPTH || out.length >= MAX_SCAN_FILES) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (e) {
      errors.push({ rel: dir, code: e?.code ?? "READ_ERROR", message: String(e?.message || e) });
      return;
    }
    for (const ent of entries) {
      if (out.length >= MAX_SCAN_FILES) return;
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name) || ent.name.startsWith(".")) continue;
        await walk(full, depth + 1, out, errors);
      } else if (ent.isFile() && ent.name.toLowerCase().endsWith(".md")) {
        out.push(full);
      }
    }
  }

  /** 解析错误里取「第 N 行」：优先用解析器给的 `line`，取不到再从消息里抠（未知 ≠ 0）。 */
  function errorLine(e) {
    if (Number.isInteger(e?.line)) return e.line;
    const m = /第\s*(\d+)\s*行/.exec(String(e?.message ?? ""));
    return m ? Number(m[1]) : null;
  }

  /** 扫描 `45-书籍/` 的正式 Markdown。**不读正文进内存以外的任何地方**，只做投影。 */
  /**
   * 写盘后必须让只读投影**立刻**看到新数据。
   *
   * `scanVault` 有 2s 的 TTL 缓存（读多写少时的性能取舍，本身合理）。但**写路径必须作废它**，
   * 否则「刚经事务落盘成功，紧接着读回来还是旧状态」—— 那会让面板显示过期的运行身份，
   * 正好踩中「不得拿旧 run 冒充当前」。
   */
  function invalidateScanCache() {
    cache.scan = null;
    cache.scanAt = 0;
  }

  /**
   * **写盘 ⇒ 立刻作废缓存**，做成一个动作，避免以后新增写盘点时漏掉（M15 真机验收轮发现）。
   *
   * 为什么要有这层包装：上面 `invalidateScanCache` 的不变量是「写路径必须作废它」，但
   * 2026-10-11 审计发现 5 个写盘点里有 3 个（`confirmObservation`、`recordEvidence` 的两处）
   * 写完**没有**作废 ⇒ 最长 2 秒内再扫还是旧清单。而 `collectEvidenceContext` / `evidenceNotes`
   * 都是「**清单取自 `scanVault()`**、内容再逐条 `readNote`」：
   *   · 确认一条**已存在**的观察：清单里有它、内容是新读的 ⇒ 恰好不受影响；
   *   · 刚 `recordEvidence` 写下的**新**证据：清单里根本没有它 ⇒ **整条看不见**，
   *     会被误判成「没有证据」（`personalization_status` 停在 `none`/`limited`）。
   * 之前没暴露，只是因为紧跟着的 `analyzeChapter()`（真引擎，要好几秒）通常已经把 2s TTL 耗掉了
   * —— 也就是**正确性依赖了另一个调用的耗时**，这是不该有的。这里把它变成结构性的。
   */
  async function writeNoteFresh(svc, rel, opts) {
    const tx = await svc.writeNote(rel, opts);
    invalidateScanCache();
    return tx;
  }

  async function scanVault() {
    if (cache.scan && now().getTime() - cache.scanAt < SCAN_TTL_MS) return cache.scan;
    const fs = await fileService();
    if (!fs.ok) {
      const out = {
        ok: false,
        code: fs.code,
        message: fs.message,
        root: fs.root,
        counts_known: false,
        files_seen: 0,
        markdown_seen: 0,
        notes: [],
        by_object_type: emptyByType(),
        parse_failures: [],
        unparseable: [],
        validation_failures: [],
        errors: [],
        truncated: false,
        index: null,
        scanned_at: now().toISOString(),
      };
      cache.scan = out;
      cache.scanAt = now().getTime();
      return out;
    }

    const files = [];
    const walkErrors = [];
    await walk(fs.root, 0, files, walkErrors);

    const notes = [];
    const parseFailures = [];
    /** 「文件存在但 frontmatter 解析不了」单独一列（rel + 错误码 + 行号）。 */
    const unparseable = [];
    const validationFailures = [];
    const byType = emptyByType();
    const byTypeFormal = emptyByType();
    const unknownTypes = new Set();
    let index = null;
    let truncated = false;

    for (const abs of files) {
      const rel = relative(fs.root, abs).split(sep).join("/");
      let got;
      try {
        got = await fs.svc.readNote(rel);
      } catch (e) {
        parseFailures.push({ rel, code: e?.code ?? "READ_ERROR", message: String(e?.message || e) });
        continue;
      }
      if (!got.exists) { parseFailures.push({ rel, code: "SOURCE_UNAVAILABLE", message: "读不到" }); continue; }
      // frontmatter 解析失败 ⇒ 记异常，**不当作 0**
      if (got.errors?.length) {
        parseFailures.push({ rel, code: "PARSE_ERROR", message: got.errors.map((x) => x.message || x.code).join("; ") });
        // 为什么必须单独列：重算时若看不见这些坏文件，程序会以为「这本书还没写过理解」
        // ⇒ revision 从 1 重算 ⇒ 幂等键与上次撞车（IDEMPOTENCY_CONFLICT），甚至覆盖掉读不懂的旧内容。
        unparseable.push({
          rel,
          code: got.errors[0]?.code ?? "PARSE_ERROR",
          line: errorLine(got.errors[0]),
          message: got.errors.map((x) => x.message || x.code).join("; "),
        });
        continue;
      }
      // formal 校验：失败也如实记（不静默跳过），并标进摘要的 formal_valid
      const declaredType = typeof got.data?.object_type === "string" ? got.data.object_type : null;
      const v = validateNote(got.data, { mode: "formal", objectType: declaredType, domain: BOOK_DOMAIN });
      if (!v.ok) {
        validationFailures.push({ rel, object_type: declaredType, errors: v.errors.slice(0, 5) });
      }
      const summary = noteSummary(rel, got.data, got.hash, v.ok);
      const t = summary.object_type;
      if (t && Object.hasOwn(byType, t)) {
        byType[t] += 1;
        if (v.ok) byTypeFormal[t] += 1;
      } else if (t) unknownTypes.add(t);
      if (t === "index" && !index) {
        index = { ...summary, index_generation: got.data?.index_generation ?? null };
      }
      if (notes.length < MAX_LISTED_NOTES) notes.push(summary);
      else truncated = true;
    }

    const out = {
      ok: true,
      root: fs.root,
      root_source: fs.root_source,
      counts_known: true,
      files_seen: files.length,
      markdown_seen: files.length,
      notes,
      by_object_type: byType,
      /** 只算 formal 校验通过的（给提示词摘要用，避免把不合格条目报成知识）。 */
      by_object_type_formal: byTypeFormal,
      unknown_object_types: [...unknownTypes],
      parse_failures: parseFailures,
      unparseable,
      validation_failures: validationFailures,
      errors: walkErrors,
      truncated,
      index,
      scanned_at: now().toISOString(),
    };
    cache.scan = out;
    cache.scanAt = now().getTime();
    return out;
  }

  // ----------------------------------------------------------------------- //
  // 投影：索引六区 / 书库 / 覆盖 / 推荐 / 提案 / 维护 / 健康
  // ----------------------------------------------------------------------- //

  /** 六个索引标记区的**可读状态**（规范 §4）。 */
  async function indexZones() {
    const fs = await fileService();
    if (!fs.ok) {
      return { ok: false, code: fs.code, message: fs.message, root: fs.root, zones: null, writable: false };
    }
    const scan = await scanVault();
    const idx = scan.index;
    if (!idx) {
      return {
        ok: false,
        code: "INDEX_NOT_FOUND",
        message: "45-书籍/ 内没有 object_type=index 的正式条目（索引页缺失）",
        root: fs.root,
        zones: null,
        writable: false,
      };
    }
    let text = "";
    let rawHash = null;
    try {
      const raw = await readFile(join(fs.root, idx.rel));
      text = raw.toString("utf8");
      rawHash = sha256Hex(raw);
    } catch (e) {
      return { ok: false, code: "READ_ERROR", message: String(e?.message || e), root: fs.root, rel: idx.rel, zones: null, writable: false };
    }
    const parsed = parseIndexZones(text);
    return {
      ok: true,
      root: fs.root,
      rel: idx.rel,
      index_id: idx.id,
      generation_mode: idx.index_generation?.mode ?? null,
      generated_at: idx.index_generation?.generated_at ?? null,
      content_hash: rawHash,
      /** 扫描缓存最多 2s 旧：两次读到的 hash 不一致时如实标出，不假装一致。 */
      changed_since_scan: idx.content_hash !== rawHash,
      scan_content_hash: idx.content_hash,
      writable: parsed.writable,
      reason: parsed.reason,
      problems: parsed.problems,
      zones: parsed.zones.map((z) => ({
        zone: z.zone,
        paired: z.paired,
        start_found: z.start_found,
        end_found: z.end_found,
        content: z.content,
        content_chars: z.content_chars,
      })),
    };
  }

  /** 书库/书信息：book / book_summary / chapter_summary 的导航。 */
  async function library() {
    const scan = await scanVault();
    if (!scan.ok) return { ok: false, code: scan.code, message: scan.message, root: scan.root };
    // 只有 formal 校验通过的才算「正式记录」；不过的单列，不当成 0 也不混进来。
    const valid = scan.notes.filter((n) => n.formal_valid === true);
    const pick = (t) => valid.filter((n) => n.object_type === t);
    const invalid = scan.notes.filter((n) => n.formal_valid !== true);
    const books = pick("book");
    const summaries = pick("book_summary");
    const chapters = pick("chapter_summary");
    return {
      ok: true,
      root: scan.root,
      counts_known: scan.counts_known,
      counts: {
        book: books.length,
        book_summary: summaries.length,
        chapter_summary: chapters.length,
        formal_valid_total: valid.length,
        invalid_total: invalid.length,
        notes_total: scan.notes.length,
        notes_truncated: scan.truncated,
      },
      books: books.map((b) => ({
        ...b,
        book_summary_refs: summaries.filter((s) => s.title && b.title && s.title.includes(b.title)).map((s) => s.rel),
      })),
      /** formal 不过的条目：列出来（含前几条错误），不静默丢弃、也不计入上面的数字。 */
      invalid_notes: invalid.map((n) => ({
        rel: n.rel,
        object_type: n.object_type,
        errors: (scan.validation_failures.find((f) => f.rel === n.rel)?.errors ?? []).map((e) => e.code),
      })),
      // 空库要显示真实状态：不列示例书名、不虚构对象（规范 §4）
      empty_state: books.length === 0
        ? { books: 0, message: "尚无书籍记录", note: "固定空目录本身不算书籍/知识记录" }
        : null,
      parse_failures: scan.parse_failures,
      unparseable: scan.unparseable,
      validation_failures: scan.validation_failures,
    };
  }

  /**
   * 覆盖报告。
   *
   * 诚实点：`45-书籍/` 里**没有**覆盖单元记录（CoverageUnit 不是正式 Markdown 对象）
   * ⇒ 三层一律 `known:false`，并且**在路由层把单元计数改成 `null`**。
   *
   * 为什么要改：`buildCoverageReport({units:null})` 的 `coverage.analyzed_units` 是 `0`
   * ——那是「没有输入」的副产品，不是「没有单元」。上层若把它当数据读，就等于把
   * 「不知道」显示成 0，违反规范 §4「解析失败不是 0」。层结构与 `honesty` 块仍由
   * M3 模块给出（不在这里另算一份）。
   */
  async function coverage() {
    const scan = await scanVault();
    if (!scan.ok) return { ok: false, code: scan.code, message: scan.message, root: scan.root };

    // ── 4c：真读 `.cache/coverage/`（账本是缓存，不是笔记）────────────────────
    // 三态，**没有第四态**：
    //   · 找到可用账本 ⇒ units_known=true + 真实数字；
    //   · 没找到（目录不存在/空）⇒ units_known=false + 原因，数字一律 null（**绝不给 0**）；
    //   · 有文件但读不了/不是账本 ⇒ 单列 unreadable，**不当成 0**；若一份可用的都没有 ⇒ 仍是未知。
    const fs = await fileService();
    const ledgers = [];
    const unreadable = [];
    let dirPresent = false;
    if (fs.ok) {
      let names = null;
      try {
        names = await readdir(join(fs.svc.root, COVERAGE_LEDGER_DIR));
      } catch (e) {
        // ENOENT = 还没有账本（正常）；其他错误如实报出，不当成「没有」
        if (e?.code !== "ENOENT") {
          unreadable.push({ rel: COVERAGE_LEDGER_DIR, code: e?.code ?? "READDIR_FAILED",
            message: String(e?.message || e) });
        }
      }
      if (names !== null) {
        dirPresent = true;
        for (const n of names.filter((x) => x.endsWith(".json")).sort()) {
          const rel = `${COVERAGE_LEDGER_DIR}/${n}`;
          try {
            const { abs } = await fs.svc.resolveRel(rel);
            const buf = await fs.svc._readBytes(abs);
            if (buf === null) {
              unreadable.push({ rel, code: "SOURCE_UNAVAILABLE", message: "读不到" });
              continue;
            }
            const j = JSON.parse(buf.toString("utf8"));
            if (!isMap(j) || j.kind !== "coverage_ledger") {
              unreadable.push({ rel, code: "NOT_A_LEDGER", message: "不是覆盖账本（kind 不符）" });
              continue;
            }
            ledgers.push({
              rel,
              cov_id: typeof j.cov_id === "string" ? j.cov_id : null,
              run_id: typeof j.run_id === "string" ? j.run_id : null,
              book: typeof j.book === "string" ? j.book : null,
              book_version_id: typeof j.book_version_id === "string" ? j.book_version_id : null,
              total_units: Number.isInteger(j.total_units) ? j.total_units : null,
              analyzed_units: Number.isInteger(j.analyzed_units) ? j.analyzed_units : null,
              failed_units: Number.isInteger(j.failed_units) ? j.failed_units : null,
              excluded_units: Number.isInteger(j.excluded_units) ? j.excluded_units : null,
              covered_codepoints: Number.isInteger(j.covered_codepoints) ? j.covered_codepoints : null,
              total_codepoints: Number.isInteger(j.total_codepoints) ? j.total_codepoints : null,
              unknown: isMap(j.unknown) ? j.unknown : null,
              whole_book_claim_allowed: j.whole_book_claim_allowed === true,
              whole_book_percent: j.whole_book_percent ?? null,
              updated_at: typeof j.updated_at === "string" ? j.updated_at : null,
            });
          } catch (e) {
            unreadable.push({ rel, code: e?.code ?? "LEDGER_PARSE_FAILED", message: String(e?.message || e) });
          }
        }
      }
    }

    const report = buildCoverageReport({ coordinate_space: null, units: null });
    const sum = (k) => {
      const vals = ledgers.map((l) => l[k]).filter((x) => Number.isInteger(x));
      return vals.length === 0 ? null : vals.reduce((a, b) => a + b, 0);
    };

    if (ledgers.length === 0) {
      // 未知 ⇒ null（模块在没有 units 输入时给的是 0，那是「没有输入」的副产品）
      const why = fs.ok !== true
        ? `读不到知识库（${fs.code}）⇒ 覆盖情况未知，不按 0 处理`
        : (unreadable.length > 0
          ? `.cache/coverage/ 里有 ${unreadable.length} 个文件但一个都用不了（见 unreadable_ledgers）⇒ 覆盖情况未知，不按 0 处理`
          : "45-书籍/ 内没有覆盖单元（CoverageUnit）记录：覆盖情况未知，不按 0 处理");
      return {
        ok: true,
        root: scan.root,
        units_known: false,
        units_source: null,
        units_reason: why,
        report: {
          ...report,
          coverage: { ...report.coverage, analyzed_units: null, total_units: null, excluded_units: null },
          units: {
            ...report.units,
            total: null, pending: null, processed: null, failed: null, excluded: null,
            counts_as_analyzed: null, counts_as_understood: null,
          },
        },
        ledger_dir_present: dirPresent,
        ledgers: [],
        unreadable_ledgers: unreadable,
        /** 便于上层一眼看到「哪些数字现在是未知」。 */
        unknown_fields: ["coverage.analyzed_units", "coverage.total_units", "coverage.excluded_units", "units.*"],
      };
    }

    // 找到账本 ⇒ 给**真实数字**。但必须说清这个数字的边界：
    //   · 只有**有账本的那些书**被计入；没有账本的书**未计入**（不是 0）；
    //   · 账本是**聚合计数**，没有逐单元记录 ⇒ `layers.*` 仍然是未知（不假装算得出分层账）。
    const total = sum("total_units");
    const analyzed = sum("analyzed_units");
    const failed = sum("failed_units");
    const excluded = sum("excluded_units");
    const anyUnknownCounts = ledgers.some((l) => l.unknown?.counts_known === true);
    return {
      ok: true,
      root: scan.root,
      units_known: true,
      units_source: COVERAGE_LEDGER_DIR,
      units_reason: `来自 ${ledgers.length} 份覆盖账本（${COVERAGE_LEDGER_DIR}/）：分母 = 各账本「已解析正文的连续窗口区间并集」之和；`
        + `只统计**有账本的书**，没有账本的书未计入（不是 0）；账本是聚合计数，没有逐单元记录 ⇒ 分层账（layers.*）仍为未知`,
      report: {
        ...report,
        coverage: {
          ...report.coverage,
          analyzed_units: analyzed,
          total_units: total,
          excluded_units: excluded,
        },
        units: {
          ...report.units,
          total,
          processed: analyzed,
          failed,
          excluded,
          counts_as_analyzed: analyzed,
          counts_as_understood: null,   // 分析过 ≠ 读懂，恒不宣称
        },
      },
      ledger_dir_present: dirPresent,
      ledgers,
      unreadable_ledgers: unreadable,
      /** 有账本的书里，是否仍有「数量未知」的未知部分 —— 有就不得宣称全书。 */
      unknown_parts_declared: anyUnknownCounts,
      unknown_fields: [],
      honesty_note: "有账本 ≠ 读懂了：这些数字只说明窗口被消费过；未知部分（图片页/不可解析项）仍不计入，也不假装为 0",
    };
  }

  /**
   * 2d：反馈的诚实核对（M10 阶段 2「一本书一个理解」）。
   *
   * 反馈按 `run_id` + `item_id` 指向「我对哪一次理解里的哪一条」提过反馈（PRD :471 / 规范 §2）。
   * 复算是**覆盖**同一条理解笔记，所以：
   *   · `run_id` 仍然对得上 —— 这正是「一本书一个 run」换来的好处：**反馈不再整体断链**；
   *   · 但 `item_id` 指向的条目**可能已经不在当前理解里**（输入变了、候选重排了）。
   * 这时必须如实说「指向的条目已不在当前理解中」，**不装作还在**，也不悄悄把这条反馈丢掉。
   *
   * 判据是当前 run 的 `selected_items[].candidate_id`（= 这次理解真正选中的条目）。
   * 批次反馈的 `item_id` 是 null（PRD 允许），它本来就不指向具体条目，不算悬空。
   */
  async function collectFeedbackRefs(fs, scan, runData, runId) {
    const selected = new Set(
      (Array.isArray(runData?.selected_items) ? runData.selected_items : [])
        .map((x) => (x && typeof x.candidate_id === "string" ? x.candidate_id : null))
        .filter((x) => x !== null),
    );
    const notes = scan.notes.filter((n) => n.object_type === "recommendation_feedback" && n.formal_valid === true);
    const out = {
      vault_total: notes.length,
      bound_to_current_run: 0,
      batch: 0,
      dangling: [],
      unreadable: [],
      note: null,
    };
    for (const n of notes) {
      let d = null;
      try {
        const got = await fs.svc.readNote(n.rel);
        if (got.exists && (got.errors?.length ?? 0) === 0) d = got.data;
      } catch { d = null; }
      if (d === null) {
        out.unreadable.push({ note_rel: n.rel, reason: "读不到这条反馈笔记" });
        continue;
      }
      if ((typeof d.run_id === "string" ? d.run_id : null) !== runId) continue; // 不是这本书这次理解的反馈
      out.bound_to_current_run += 1;
      const iid = typeof d.item_id === "string" && d.item_id.trim() !== "" ? d.item_id : null;
      if (iid === null) { out.batch += 1; continue; }
      if (!selected.has(iid)) {
        out.dangling.push({ note_rel: n.rel, item_id: iid, feedback_type: d.feedback_type ?? null });
      }
    }
    const parts = [`当前理解 ${runId} 上有 ${out.bound_to_current_run} 条反馈`];
    parts.push(out.dangling.length === 0
      ? "指向的条目都还在当前理解中"
      : `其中 ${out.dangling.length} 条指向的条目**已不在当前理解中**（复算换掉了这些条目）—— 已如实列出，没有丢掉它们`);
    if (out.batch > 0) parts.push(`另有 ${out.batch} 条批次反馈（item_id=null，本来就不指向具体条目）`);
    if (out.unreadable.length > 0) parts.push(`⚠️ ${out.unreadable.length} 条反馈读不到（失败窗口，如实报出，不当成 0）`);
    out.note = parts.join("；");
    return out;
  }

  /**
   * 路径 → 这本书的**内容身份**与由此派生的 run 笔记位置。
   *
   * **只有这一份实现**：`understandingStatus`（3b）与 `recommendations({book_path})`（方案 B）
   * 都调它。插件一个身份哈希都不算 —— 路径只用来**定位**，身份一律问引擎
   * （`/book-identity?path=`），理由见下面 3b 的说明。
   *
   * 返回：
   *   · 成功 `{ok:true, book_version_id, content_id, run_id, note_rel}`；
   *   · 失败 `{ok:false, code, message, detail?}` —— **调用方不许猜、不许回退**。
   */
  async function resolveBookRunTarget(book_path) {
    if (typeof book_path !== "string" || book_path.trim() === "") {
      return { ok: false, code: "BAD_REQUEST", message: "需要一个书的绝对路径（引擎 /books 返回的那一份原串）" };
    }
    if (!sidecarFetch) {
      return {
        ok: false, code: "SIDECAR_UNAVAILABLE",
        message: "引擎转发未注入 ⇒ 定不出这本书的内容身份；**不猜成「没有理解」**"
          + "（猜错会让自动流程覆盖/写重已有理解）",
      };
    }
    let ident = null;
    try {
      const up = await sidecarFetch(`/book-identity?path=${encodeURIComponent(book_path)}`);
      ident = await up.json();
    } catch (e) {
      return {
        ok: false, code: "BOOK_IDENTITY_ERROR",
        message: "问引擎要这本书的身份时出错 ⇒ 无法确认这是哪一条理解；不猜",
        detail: String(e?.message || e),
      };
    }
    if (!ident || typeof ident !== "object" || ident.ok !== true
        || typeof ident.book_version_id !== "string" || ident.book_version_id.trim() === "") {
      return {
        ok: false, code: ident?.code ?? "BOOK_IDENTITY_FAILED",
        message: "引擎没能给出这本书的内容身份 ⇒ 不猜"
          + "（书被移走/改名或内容变了，先在面板刷新书库）",
        detail: ident?.message ?? null,
      };
    }
    const bv = ident.book_version_id;
    const runId = bookRunId({ book_version_id: bv });
    return {
      ok: true,
      book_version_id: bv,
      // 内容摘要（= book_version_id 去掉 `bv_` 前缀）：只是**如实回显**引擎给的身份，不在这里算。
      content_id: typeof ident.book_id === "string" ? ident.book_id : null,
      run_id: runId,
      note_rel: `${RUN_NOTE_DIR}/${runId}.md`,
    };
  }

  /**
   * 方案 B：**这本书**的只读投影（`GET /api/reading/recommendations?path=…`）。
   *
   * 与全库版的**唯一**关键差别：**不回退**。
   *   · 身份定不出来 ⇒ 明确报错（不拿别的书的理解冒充这本的）；
   *   · 这本书没有理解笔记 ⇒ 诚实的空态（`result:null` + 原因），仍**不**回退到全库最新一条；
   *   · 笔记在但不是 ready / 不是正式有效 ⇒ 如实报出，不投影半成品。
   *
   * 为什么要它：面板以前只能读「全库最新一条」，于是选中 A 书会看到 B 书的导读 ——
   * 用户点名的「切书之后导读没变化」根因就在这里。只读：不生成 run、不写盘。
   */
  async function recommendationsForBook(book_path) {
    const base = {
      ok: false, book_scoped: true, book_path, read_only: true,
      runs: [], count: 0, invalid_count: 0, empty_state: null,
      result: null, result_run_id: null, result_run_state: null,
      ready_run_count: 0, result_ambiguous: false,
      result_projection: null, feedback_refs: null,
    };
    const t = await resolveBookRunTarget(book_path);
    if (!t.ok) {
      return {
        ...base, code: t.code,
        result_error: { code: t.code, message: t.message, run_id: null },
        result_note: `定不出这本书的内容身份（${t.code}）⇒ 不拿别的书的理解冒充这本的`,
        ...(t.detail ? { detail: t.detail } : {}),
      };
    }
    base.book_version_id = t.book_version_id;
    base.content_id = t.content_id;

    const fs = await fileService();
    if (!fs.ok) {
      return {
        ...base, code: fs.code,
        result_error: { code: fs.code, message: `读不到知识库：${fs.code}`, run_id: t.run_id },
        result_note: "读不到知识库 ⇒ 不猜这本书有没有理解",
      };
    }

    let got = null;
    try {
      got = await fs.svc.readNote(t.note_rel);
    } catch (e) {
      return {
        ...base, code: "READ_FAILED",
        result_error: { code: "READ_FAILED", message: String(e?.message || e), run_id: t.run_id },
        result_note: "读这本书的理解笔记时出错 ⇒ 不猜",
      };
    }

    // 这本书还没有理解：诚实的空态。**不回退**到全库最新一条（那正是这轮要消灭的）。
    if (!got || got.exists !== true) {
      return {
        ...base, ok: true,
        empty_state: { runs: 0, message: `这本书盘上还没有理解笔记（${t.run_id}）—— 去书库点「切片与理解」` },
        result_note: "这本书还没有理解：不拿别的书的理解冒充这本的",
      };
    }

    // 笔记确实在。正式性用扫描确认（与只读投影同一套尺子，不另立标准）。
    const scan = await scanVault();
    if (!scan.ok) {
      return {
        ...base, code: scan.code,
        result_error: { code: scan.code, message: `笔记在，但知识库扫描失败：${scan.code}`, run_id: t.run_id },
        result_note: "笔记在，但扫描失败 ⇒ 无法确认它是不是这本书的正式理解；不返回半成品",
      };
    }
    if (scan.truncated === true) {
      return {
        ...base, code: "SCAN_TRUNCATED",
        result_error: { code: "SCAN_TRUNCATED", message: `本次扫描被截断（超过 ${MAX_LISTED_NOTES} 条）`, run_id: t.run_id },
        result_note: "笔记在，但扫描被截断 ⇒ 无法确认正式性；不返回半成品",
      };
    }
    const n = scan.notes.find((x) => x.rel === t.note_rel) ?? null;
    if (n === null) {
      return {
        ...base, code: "NOTE_UNSCANNED",
        result_error: { code: "NOTE_UNSCANNED", message: "笔记读得到、却没进扫描结果", run_id: t.run_id },
        result_note: "笔记读得到、却没进扫描结果 ⇒ 状态不自洽；请人工看一眼",
      };
    }

    /** run 元数据**恰好 7 键**，与全库版逐字一致（契约测试钉死了，不许偷偷加字段）。 */
    const runMeta = {
      rel: t.note_rel,
      run_id: t.run_id,
      state: n.state,
      title: n.title,
      created_at: n.created_at,
      updated_at: n.updated_at,
      content_hash: n.content_hash,
    };
    const scoped = { ...base, ok: true, runs: [runMeta], count: 1 };

    if (n.object_type !== "recommendation_run" || n.formal_valid !== true) {
      return {
        ...scoped,
        result_error: {
          code: "RUN_NOT_FORMAL",
          message: `这条路径上确实有笔记，但它不是**正式有效**的 recommendation_run`
            + `（object_type=${n.object_type ?? "null"}，formal_valid=${n.formal_valid === true}）`,
          run_id: t.run_id,
        },
        result_note: "笔记在，但不是正式有效的 recommendation_run ⇒ 不投影（需要人看一眼）",
      };
    }
    // 与全库版同一套语义：只有 state=ready 才算「当前理解」，别的状态不拿来冒充。
    if (n.state !== "ready") {
      return {
        ...scoped,
        result_error: {
          code: "NO_READY_RUN",
          message: `这本书的理解 state=${n.state ?? "null"}（不是 ready）⇒ 不拿它冒充当前理解`,
          run_id: t.run_id,
        },
        result_note: `这本书的理解不是 ready（state=${n.state ?? "null"}）⇒ 没有可显示的推荐结果`,
      };
    }

    const proj = projectRecommendationResultFromRun(got.data);
    if (!proj.ok) {
      return {
        ...scoped,
        result_error: { code: proj.code, message: proj.message, run_id: t.run_id },
        result_note: `这本书的理解投影不出来（${proj.code}）`,
      };
    }
    return {
      ...scoped,
      ready_run_count: 1,
      root: scan.root,
      counts_known: scan.counts_known,
      feedback_note: "反馈通过 run_id 引用运行；本路由只读，不生成新运行",
      result_run_id: t.run_id,
      result_run_state: runMeta.state ?? null,
      result: proj.result,
      result_error: null,
      result_projection: { ...proj.projection, from_run_id: t.run_id },
      result_note: `显示的是这本书的理解 ${t.run_id}（state=ready）`,
      // 2d：只有真的投影出了当前理解，谈「反馈指向的条目还在不在」才有意义。
      feedback_refs: await collectFeedbackRefs(fs, scan, got.data, t.run_id),
    };
  }

  /**
   * 推荐：列出已保存的 recommendation_run（compiler/policy 产物），
   * 并**只读投影**出「当前那一次理解」的完整 `RecommendationResult`。
   *
   * 为什么要有 `result`：M7 的面板已经按 `recommendations.result` 预留了挂载点，
   * 但 M6 只给了 run 的元数据投影 ⇒ 真实面板永远走诚实空态，两层渲染只有夹具证据。
   * M8 把两层内容补上（仍**只读**：不生成 run、不写盘）。
   *
   * M10 阶段 2「一本书一个理解」之后：
   *   · `result_run_id` = 这个 result **确实**来自哪一次理解（没有 result 时 null）；
   *   · `ready_run_count` / `result_ambiguous` = 这本书盘上有几条 ready 理解、是否有歧义。
   *     正常一本书一条；>1 说明有 M10 之前的历史遗留或书被移动（路径寻址已知债），**如实报出**。
   *   · 删掉了 `newest_run_id` / `result_is_latest` / `result_superseded_by`：那是「多个 run 互相取代」
   *     时代的字段，现在只会误导（用户点名的反例是「拿旧 run 冒充当前」，现在**根本没有第二个 run**）。
   *   · `feedback_refs` = 2d 的反馈诚实核对（见 `collectFeedbackRefs`）。
   *
   * 选理解的规则在 `selectCurrentRun()`（纯函数、可复算），本函数只做读盘与组装。
   *
   * 方案 B：带 `?path=` 时**按这本书**取（见 `recommendationsForBook`）；
   * 不带参数时行为与以前**一字不变**（全库扫描 + 挑最新 ready），向后兼容。
   */
  async function recommendations({ book_path } = {}) {
    if (typeof book_path === "string" && book_path.trim() !== "") {
      return await recommendationsForBook(book_path);
    }
    const scan = await scanVault();
    if (!scan.ok) return { ok: false, code: scan.code, message: scan.message, root: scan.root };
    const runNotes = scan.notes.filter((n) => n.object_type === "recommendation_run" && n.formal_valid === true);
    const runs = runNotes.map((n) => ({
      rel: n.rel,
      run_id: n.id,
      state: n.state,
      title: n.title,
      created_at: n.created_at,
      updated_at: n.updated_at,
      content_hash: n.content_hash,
    }));

    const pick = selectCurrentRun(runs);
    let result = null;
    let resultError = pick.reason
      ? { code: pick.reason, message: "没有 state=ready 的推荐运行：不拿 stale/旧 run 冒充当前", run_id: null }
      : null;
    let resultProjection = null;
    let feedbackRefs = null;

    if (pick.result_run_id) {
      const note = runNotes.find((n) => n.id === pick.result_run_id) ?? null;
      const fs = await fileService();
      let data = null;
      if (!note || !fs.ok) {
        resultError = {
          code: "RUN_NOT_READABLE",
          message: !note ? `runs 里找不到 run_id=${pick.result_run_id} 的笔记` : `读不到知识库：${fs.code}`,
          run_id: pick.result_run_id,
        };
      } else {
        try {
          const got = await fs.svc.readNote(note.rel);
          if (!got.exists || (got.errors?.length ?? 0) > 0) {
            resultError = {
              code: "RUN_NOT_READABLE",
              message: !got.exists ? "run 笔记不存在" : got.errors.map((x) => x.code || x.message).join("; "),
              run_id: pick.result_run_id,
            };
          } else {
            data = got.data;
          }
        } catch (e) {
          resultError = { code: "RUN_NOT_READABLE", message: String(e?.message || e), run_id: pick.result_run_id };
        }
      }
      if (data !== null) {
        const proj = projectRecommendationResultFromRun(data);
        if (proj.ok) {
          result = proj.result;
          resultProjection = { ...proj.projection, from_run_id: pick.result_run_id };
          // 2d：只有真的投影出了当前理解，谈「反馈指向的条目还在不在」才有意义。
          feedbackRefs = await collectFeedbackRefs(fs, scan, data, pick.result_run_id);
        } else {
          resultError = { code: proj.code, message: proj.message, run_id: pick.result_run_id };
        }
      }
    }

    const resultRunId = result === null ? null : pick.result_run_id;
    return {
      ok: true,
      root: scan.root,
      counts_known: scan.counts_known,
      runs,
      count: runs.length,
      /** 有该类型但 formal 不过的，单独计数（不是 0，也不混进 runs）。 */
      invalid_count: scan.notes.filter((n) => n.object_type === "recommendation_run" && n.formal_valid !== true).length,
      empty_state: runs.length === 0 ? { runs: 0, message: "尚无已保存的推荐运行" } : null,
      /** 反馈指 run_id（规范 §4）：这里只列引用，不虚构。 */
      feedback_note: "反馈通过 run_id 引用运行；本路由只读，不生成新运行",
      // ── M8 新增：只读投影（不生成 run、不写盘） ──────────────────────────────
      // M10 阶段 2 删掉了 `newest_run_id` / `result_is_latest` / `result_superseded_by`：
      // 那是「一本书多个 run、互相取代」时代的字段，现在一本书就一条理解，它们只会误导。
      result_run_id: resultRunId,
      result_run_state: resultRunId === null
        ? null
        : (runs.find((r) => r.run_id === resultRunId)?.state ?? null),
      /** 这本书盘上有几条 ready 理解（正常=1；>1 说明有历史遗留或书被移动，如实报出）。 */
      ready_run_count: pick.ready_run_count,
      /** >1 条 ready ⇒ true。**不静默挑一条装作没有歧义**。 */
      result_ambiguous: pick.ambiguous,
      result,
      result_error: resultError,
      result_projection: resultProjection,
      /** 一句人话：面板/日志可以直接显示「这是哪一次理解」，不必自己拼。 */
      result_note: resultRunId === null
        ? `没有可显示的推荐结果（${resultError?.code ?? "UNKNOWN"}）`
        : (pick.ambiguous
          ? `显示的是最新一条 ready 理解 ${resultRunId}；这本书盘上有 ${pick.ready_run_count} 条 ready 理解`
            + "（M10 之前的历史遗留，或书被移动/改名使身份变了）—— 没有替你删任何一条"
          : `显示的是这本书的理解 ${resultRunId}（state=ready）`),
      /** 2d：反馈的诚实核对结果（见 collectFeedbackRefs）。 */
      feedback_refs: feedbackRefs,
      read_only: true,
    };
  }

  /**
   * 3b：**这本书盘上有没有「当前理解」**？——真实信号，不是前端猜的。
   *
   * 为什么必须由后端算：理解笔记的身份是 `run_id = bookRunId({book_version_id})`，而
   * `book_version_id` 是**内容身份**（各章正文 sha256 前 16 位）——**只有引擎算得出来**
   * （要解包、要抽章）。面板手里的书单来自「图书」App（`/api/books`），每本带 `path`；
   * 把**引擎给的那份原串**送回 `/book-identity?path=` 换回身份，再派生 `run_id`。
   *
   * M13 之前这里是自己复现 `path_hash8 = sha1(路径)[:8]`（第二套身份实现）。
   * 现在**插件一个身份哈希都不算**：路径只用来定位，身份一律问引擎。
   *
   * 判据分两层，都用**已有的真东西**，不另立标准：
   *   1. `readNote(rel)` 定位**确切路径**（不依赖扫描，不受 MAX_LISTED_NOTES 截断影响）；
   *   2. `scanVault()` 里的 `formal_valid` / `object_type` / `state` —— 与只读投影同一套
   *      正式校验（`readNote` 的 `errors` 只是 **frontmatter 解析**错误，不等于 formal 通过，
   *      所以不能拿它当「正式有效」）。
   *
   * 诚实要点（每一条都在挡「自动重算把已有理解覆盖掉」）：
   *   · 读不到知识库 / 读取出错 / 扫描被截断 ⇒ `checked:false`，**不猜成「没有」**；
   *   · **身份定不出来**（引擎没起来 / 这本书不在书库里 / 引擎没给身份）⇒ `checked:false`
   *     且 `auto_trigger_allowed:false`：身份定不出来就没法知道「是哪一条理解」，
   *     这时自动跑第一次有可能把已有理解**写重**（换一个 run_id 再写一条），所以宁可不动；
   *   · 笔记存在但不是 `recommendation_run`、或没通过正式校验 ⇒ `auto_trigger_allowed:false`
   *     （需要人看一眼，**不拿自动流程去覆盖它**）；
   *   · 只有「确切路径上没有这条笔记」时才 `auto_trigger_allowed:true`。
   *
   * 这是**只读**的：只读盘（外加一次只读的引擎问询），不写盘。
   */
  async function understandingStatus({ book_path } = {}) {
    // 身份一律问引擎（路径只定位，不参与身份）。拿不到就**不猜**：猜错会多写一条理解。
    // 这段解析与 `recommendations({book_path})`（方案 B）**共用同一份实现**。
    const t = await resolveBookRunTarget(book_path);
    if (!t.ok) {
      const MSG = {
        BAD_REQUEST: "understandingStatus 需要书的绝对路径（引擎 /books 返回的那一份原串）",
        SIDECAR_UNAVAILABLE: "引擎转发未注入 ⇒ 定不出这本书的内容身份；**不猜成「没有理解」**"
          + "（猜错会让自动流程覆盖/写重已有理解）",
        BOOK_IDENTITY_ERROR: "问引擎要这本书的身份时出错 ⇒ 无法确认是否已有理解；不猜成「没有」",
      };
      return {
        ok: false, code: t.code, checked: false, auto_trigger_allowed: false,
        has_current_understanding: null, state: null, revision: null,
        message: MSG[t.code]
          ?? "引擎没能给出这本书的内容身份 ⇒ 无法确认是否已有理解；不猜成「没有」"
            + "（书被移走/改名或内容变了，先在面板刷新书库）",
        ...(t.detail ? { detail: t.detail } : {}),
      };
    }
    const bv = t.book_version_id;
    const runId = t.run_id;
    const rel = t.note_rel;
    const base = {
      book_version_id: bv,
      // 内容摘要（= book_version_id 去掉 `bv_` 前缀）：只是**如实回显**引擎给的身份，不在这里算。
      content_id: t.content_id,
      run_id: runId, note_rel: rel, read_only: true,
    };

    const fs = await fileService();
    if (!fs.ok) {
      return { ...base, ok: false, code: fs.code, checked: false, auto_trigger_allowed: false,
        has_current_understanding: null, state: null, revision: null,
        message: "读不到知识库 ⇒ 无法确认是否已有理解；**不猜成「没有」**（猜错会导致自动重算覆盖掉已有理解）" };
    }

    let got = null;
    try {
      got = await fs.svc.readNote(rel);
    } catch (e) {
      return { ...base, ok: false, code: "READ_FAILED", checked: false, auto_trigger_allowed: false,
        has_current_understanding: null, state: null, revision: null,
        message: "读这条笔记时出错 ⇒ 无法确认；不猜成「没有」", detail: String(e?.message || e) };
    }

    if (!got || got.exists !== true) {
      return { ...base, ok: true, checked: true, auto_trigger_allowed: true,
        has_current_understanding: false, state: null, revision: null,
        message: "盘上没有这本书的理解笔记 ⇒ 可以自动跑第一次「切片与理解」" };
    }

    // 笔记确实在。用扫描拿 formal_valid / object_type / state（与只读投影同一套正式校验）。
    const scan = await scanVault();
    if (!scan.ok) {
      return { ...base, ok: false, code: scan.code, checked: false, auto_trigger_allowed: false,
        has_current_understanding: null, state: null, revision: null,
        message: "笔记在，但知识库扫描失败 ⇒ 无法确认它是不是这本书的**正式**理解；不自动跑" };
    }
    if (scan.truncated === true) {
      return { ...base, ok: false, code: "SCAN_TRUNCATED", checked: false, auto_trigger_allowed: false,
        has_current_understanding: null, state: null, revision: null,
        message: `笔记在，但本次扫描被截断（超过 ${MAX_LISTED_NOTES} 条）⇒ 无法确认它的正式性；不自动跑` };
    }
    const n = scan.notes.find((x) => x.rel === rel) ?? null;
    if (n === null) {
      return { ...base, ok: false, code: "NOTE_UNSCANNED", checked: false, auto_trigger_allowed: false,
        has_current_understanding: null, state: null, revision: null,
        message: "笔记读得到、却没进扫描结果 ⇒ 状态不自洽；不自动跑（请人工看一眼）" };
    }

    const state = typeof n.state === "string" ? n.state : null;
    const revision = Number.isInteger(n.revision) ? n.revision : null;
    if (n.object_type !== "recommendation_run" || n.formal_valid !== true) {
      return { ...base, ok: true, checked: true, auto_trigger_allowed: false,
        has_current_understanding: false, state, revision,
        object_type: n.object_type ?? null, formal_valid: n.formal_valid === true,
        message: `这条路径上确实有笔记，但它不是**正式有效**的 recommendation_run`
          + `（object_type=${n.object_type ?? "null"}，formal_valid=${n.formal_valid === true}）`
          + " ⇒ 需要人看一眼，**不用自动流程覆盖它**" };
    }

    const has = state === "ready";
    return { ...base, ok: true, checked: true, auto_trigger_allowed: !has,
      has_current_understanding: has, state, revision,
      object_type: "recommendation_run", formal_valid: true,
      message: has
        ? `已有当前理解（revision ${revision}）⇒ 打开这本书时**不自动重跑**；要重算请手动点「切片与理解」`
        : `笔记存在但 state=${state}（不是 ready）⇒ 不算「已有当前理解」，且不自动覆盖` };
  }

  /**
   * F4（4a + 4b）：知识库完整性 —— **书籍信息笔记** + **覆盖账本**。
   *
   * 为什么要有这一步：run 笔记的 `input_manifest_refs` 里写着 `book_version:<id>` 与
   * `coverage:<cov_id>`，但如果盘上根本没有对应的 book 笔记与覆盖账本，这两个引用就是
   * **悬空引用** —— 看起来「有来源」，实际指向空气。本函数把这两件补齐。
   *
   * 三条纪律：
   *   1. **都是派生物，失败不回滚 run 笔记**：run 笔记已经 committed，它是本次分析的主产物。
   *      但失败**必须如实报出**（返回 `vault_integrity` 里的 written/code/message），
   *      不许静默吞掉 —— 否则「知识库完整」就成了假话。
   *   2. **不编造**：引擎没给作者 ⇒ **不写** book 笔记（`book.author` 必填且不得为空，
   *      用「未知作者」之类的占位值去凑就是虚构）；引擎没给整书 bytes hash ⇒
   *      `content_hash: null`（schema 明说「未知来源不得编造，可 null」），
   *      **不拿 `book_version_id` 冒充**。
   *   3. **`.cache/` 不是知识**：覆盖账本是缓存（`SKIP_DIRS` 已含 `.cache`），
   *      所以它走 `commit()` 写**原始 JSON**，而**不是** `writeNote()`（那会带上
   *      frontmatter，让它看起来像一条笔记）。
   *
   * 幂等：book 笔记按「同 `book_version_id` + 同 `content_hash` ⇒ 不重写」；
   * 账本**逐字比对**上次写进去的正文，内容没变就不写盘（不新增 journal 事务）。
   * 两者都是**比内容**而不是「有时间戳就算变」—— 后者会让每次分析都产生一条无意义的写入。
   */
  async function writeVaultIntegrity(fs, analysis, runId, iso) {
    const out = {
      book_note: { written: false, code: null, note_rel: null, message: null },
      coverage_ledger: { written: false, code: null, ref: null, message: null },
    };

    // ── 4a 书籍信息笔记 ──────────────────────────────────────────────────
    try {
      const title = typeof analysis.book === "string" ? analysis.book.trim() : "";
      const author = typeof analysis.author === "string" ? analysis.author.trim() : "";
      // M13：book 笔记的 id/book_id 用**引擎给的内容身份**（`content_id`，16 位），
      // 不再按目录名自己算 —— 同名不同内容的书原先会撞成同一个 id。
      const bookId = analysis.content_id;
      if (title === "" || author === "") {
        out.book_note = {
          written: false,
          code: author === "" ? "MISSING_AUTHOR" : "MISSING_TITLE",
          note_rel: null,
          message: author === ""
            ? "引擎没给出作者 ⇒ **不编造作者**，不写书籍信息笔记（book.author 是必填且不得为空）。"
              + "run 笔记不受影响，但它引用的 book_version 目前没有对应的 book 笔记"
            : "引擎没给出书名 ⇒ 不写书籍信息笔记（不编造）",
        };
      } else {
        const rel = bookInfoRel({ title, author });
        const existing = await fs.svc.readNote(rel);
        // M13：还要求**身份字段本身**与本次一致（`id`/`book_id`）。
        // 为什么：`book_version_id` 从 M13 起没变过（它本来就是内容寻址的），所以只比它的话，
        // 一条**由旧的路径寻址代码写下的**笔记会被判成「同一版本 ⇒ 不重写」，于是里面
        // `id`/`book_id`/`dedup_check_ref` 全是过期的旧值，一直留着 —— 那是静默的脏数据。
        // 把身份字段纳入比较 ⇒ 这种笔记会被就地改对（self-heal），不需要人工删。
        const sameVersion = existing.exists === true
          && existing.data?.book_version_id === analysis.book_version_id
          && existing.data?.id === bookId
          && (existing.data?.content_hash ?? null) === null;
        if (sameVersion) {
          out.book_note = {
            written: false, code: "NO_CHANGE", note_rel: rel,
            message: "同一本书同一版本（book_version_id / id / content_hash 都没变）⇒ 不重写，避免无谓写盘",
          };
        } else {
          const note = buildBookInfoNote({
            book_id: bookId,
            title,
            author,
            book_version_id: analysis.book_version_id,
            source_path: analysis.book_path,
            content_id: analysis.content_id,
          }, {
            now: iso,
            created_at: existing.exists === true ? (existing.data?.created_at ?? iso) : iso,
            revision: existing.exists === true ? nextRevision(existing.data) : 1,
          });
          const tx = await writeNoteFresh(fs.svc, rel, {
            data: note.data,
            body: "",
            expectedHash: existing.exists === true ? existing.hash : null,
            idempotencyKey: `book_info:${bookId}:${analysis.book_version_id}`,
            purpose: "update_note",
          });
          out.book_note = {
            written: true, code: null, note_rel: rel,
            transaction: { id: tx.id, state: tx.state, replayed: tx.replayed ?? false },
            message: "已写入书籍信息笔记（external_master.status=unverified：本次只读了书本身，没去外部主库核对）",
          };
        }
      }
    } catch (e) {
      out.book_note = { written: false, code: e?.code ?? "BOOK_NOTE_FAILED", note_rel: out.book_note.note_rel,
        message: `书籍信息笔记没写成：${e?.message ?? e}（run 笔记已落盘，不受影响）` };
    }

    // ── 4b 覆盖账本（`.cache/coverage/<cov_id>.json`，缓存不是笔记）──────────
    try {
      // M13：账本按**内容身份**落盘（`cov_<content_id>`）。原先按 `path_hash8` ⇒ 书一挪位置
      // 就会多出一份账本，而 `coverage()` 会**把所有账本相加**，于是同一本书被重复计一遍。
      const covId = `cov_${analysis.content_id ?? "unknown"}`;
      const rel = `.cache/coverage/${covId}.json`;
      const cov = analysis.coverage ?? {};
      const ledger = {
        kind: "coverage_ledger",
        cov_id: covId,
        run_id: runId,
        book: analysis.book ?? null,
        book_version_id: analysis.book_version_id ?? null,
        content_id: analysis.content_id ?? null,
        scope: cov.scope ?? null,
        denominator_kind: "span_interval_union",
        total_units: Number.isInteger(cov.total_units) ? cov.total_units : null,
        analyzed_units: Number.isInteger(cov.analyzed_units) ? cov.analyzed_units : null,
        failed_units: Number.isInteger(cov.failed_units) ? cov.failed_units : null,
        excluded_units: Number.isInteger(cov.excluded_units) ? cov.excluded_units : null,
        covered_codepoints: Number.isInteger(cov.covered_codepoints) ? cov.covered_codepoints : null,
        total_codepoints: Number.isInteger(cov.total_codepoints) ? cov.total_codepoints : null,
        unknown: {
          counts_known: cov.unknown?.counts_known === true,
          kinds: Array.isArray(cov.unknown?.kinds) ? cov.unknown.kinds : [],
          note: cov.unknown?.note ?? null,
        },
        whole_book_claim_allowed: cov.whole_book_claim_allowed === true,
        whole_book_percent: cov.whole_book_percent ?? null,
        failed_window_ids: Array.isArray(analysis.queue?.failed_window_ids) ? analysis.queue.failed_window_ids : [],
        updated_at: iso,
        note: "覆盖账本：分母 = 已解析正文的连续窗口区间并集；未知部分不计入分子也不假装为 0",
      };
      const content = JSON.stringify(ledger, null, 2) + "\n";
      const prev = await fs.svc.readNote(rel);
      if (prev.exists === true && typeof prev.body === "string" && prev.body === content) {
        out.coverage_ledger = { written: false, code: "NO_CHANGE", ref: covId,
          message: "覆盖账本内容未变 ⇒ 不重写" };
      } else {
        const tx = await fs.svc.commit({
          purpose: "maintenance",
          idempotencyKey: `coverage_ledger:${covId}:${sha256Hex(content).slice(0, 16)}`,
          inputFingerprint: sha256Hex(`maintenance\u0000${rel}\u0000${content}`),
          targets: [{
            path: rel,
            kind: prev.exists === true ? "update" : "create",
            content,
            expectedBeforeHash: prev.exists === true ? prev.hash : undefined,
          }],
        });
        out.coverage_ledger = { written: true, code: null, ref: covId,
          transaction: { id: tx.id, state: tx.state, replayed: tx.replayed ?? false },
          message: "已写入覆盖账本（.cache/ 是缓存，不计入书籍/知识统计）" };
      }
    } catch (e) {
      out.coverage_ledger = { written: false, code: e?.code ?? "LEDGER_FAILED",
        ref: out.coverage_ledger.ref,
        message: `覆盖账本没写成：${e?.message ?? e}（run 笔记已落盘，不受影响）` };
    }

    return out;
  }

  /** 提案列表/状态：change_proposal + 文件事务进度。 */
  // ----------------------------------------------------------------------- //
  // M14：采集 —— 一次真实互动 → reading_evidence / understanding_observation
  // ----------------------------------------------------------------------- //

  /**
   * 把**一次真实互动**落成证据笔记（闭环第 4 环）。**默认只写 `unconfirmed`。**
   *
   * 硬约束（都是刻意的，不是没做完）：
   *   · **1a** 必须绑在一段**真取得到、且引擎标了 verified** 的原文上：取不到就**一条都不写**；
   *   · **1b** 五类标签只用规范 §3 的闭合值域；`strength=null`、`confidence.level=unknown`，**不评级**；
   *   · **1c** 三种归属分块：书中观点=逐字引文、用户判断=用户原话、AI 推演=单独块且标未确认；
   *   · **1d** `confirmation` 恒 `unconfirmed`；`origin` 与 `kind` 必须自洽（AI 假设不许冒充用户事实）；
   *   · **2a** 只走 `fileService().svc.writeNote`（内部 `commit()` 事务），**不绕过**；
   *   · **2b** 书身份只用引擎给的 `book_version_id`（内容寻址），**不按路径算 id**；
   *   · **2c** 幂等键由**互动内容**派生（不含时间、不含路径）⇒ 同一次互动重放**不重复写**。
   *
   * M15 0b：`book_evidence` 现在**写真的**（引擎 `/source-span` 给出 `href` + `block_id` 等
   * SpanRef 必填字段）。字段由引擎给、这里只做形状校验；**缺字段就留空并如实写明缺什么**，
   * 绝不编一个定位（假定位会让人以为能回原文核对）。
   */
  /**
   * M15 阶段 2：把一条**用户自己的观察**确认为稳定事实（「我确认这条观察」）。
   *
   * 为什么必须有这一步：M14 一律写 `confirmation: "unconfirmed"`，而未确认观察参与计算
   * ⇒ `q=0.5` ⇒ `personalization_status` **永远到不了 `available`**（PRD :280 要求 `C=1` 且
   * `q=1`）。「确认」只能是**用户自己**的动作，且要带真实 `actor/action_id/at/scope`
   * （schema 的 `CONFIRMATION_EVIDENCE_REQUIRED` 就是拦「模型代填」的）。
   *
   * 诚实边界（每条都是硬约束，改坏会被变异测试抓）：
   *   · **只改 `confirmation` / `confirmation_evidence`**：`origin` 一个字都不动 ——
   *     用户确认一条 AI 假设，它仍然是 AI 假设（1f：AI 推演不能变成用户事实）；
   *   · 只有 `reading_evidence` / `understanding_observation` 能确认，别的对象类型一律拒绝；
   *   · 已经 confirmed 的再点 ⇒ **不重复写**，如实回「已经确认过了」；
   *   · 确认 ≠ 高置信：它只让 `q` 从 0.5 变成 1，**不代表**「已掌握 / 已读懂」；
   *   · 走 `fileService().svc.writeNote`（内部 `commit()` 事务），**不绕过**。
   */
  async function confirmObservation({ note_id = null, actor = "user", scope = null, at = null } = {}) {
    if (typeof note_id !== "string" || note_id === "") {
      return { ok: false, code: "MISSING_REQUIRED", message: "note_id 必填（要确认哪条观察）", changed: false };
    }
    const fs = await fileService();
    if (!fs.ok) return { ok: false, code: fs.code, message: fs.message, changed: false };

    const scan = await scanVault();
    const hit = (scan.notes ?? []).find((n) => n.id === note_id) ?? null;
    if (hit === null) {
      return { ok: false, code: "NOTE_NOT_FOUND", message: `库里找不到这条观察：${note_id}`, changed: false };
    }
    if (!EVIDENCE_NOTE_TYPES.includes(hit.object_type)) {
      return {
        ok: false, code: "NOT_AN_OBSERVATION", changed: false,
        message: `只有学习证据 / 理解变化能被确认，得到 ${hit.object_type}`,
      };
    }
    const prev = await fs.svc.readNote(hit.rel);
    if (prev.exists !== true) {
      return { ok: false, code: "SOURCE_UNAVAILABLE", message: `文件读不到：${hit.rel}`, changed: false };
    }
    if (prev.data?.confirmation === "confirmed") {
      // 幂等：已经是确认过的，就不写第二次（也不假装刚确认）。
      // 回执照样带 `honesty`：面板要把它**原样显示**（确认 ≠ 高置信 / ≠ 已掌握 / ≠ 读懂）。
      return {
        ok: true, changed: false, note_id, note_rel: hit.rel,
        confirmation: "confirmed", origin: prev.data?.origin ?? null,
        honesty: {
          means: "这条观察早已被确认为你自己的稳定陈述",
          does_not_mean: "确认 ≠ 高置信、≠ 已掌握、≠ 读懂这本书",
        },
        message: "这条观察已经确认过了，没有重复写入",
      };
    }
    if (prev.data?.confirmation !== "unconfirmed") {
      return {
        ok: false, code: "INVALID_STATE", changed: false,
        message: `这条观察当前是 ${JSON.stringify(prev.data?.confirmation ?? null)}，只能确认 unconfirmed 的观察`,
      };
    }

    const atIso = typeof at === "string" && at !== "" ? at : new Date().toISOString();
    const actionId = `act_confirm_${sha256Hex(`${note_id}\u0000${atIso}`).slice(0, 16)}`;
    // 只动这两处：origin / 其余字段**原样带过去**
    const nextData = {
      ...prev.data,
      confirmation: "confirmed",
      confirmation_evidence: {
        actor, action_id: actionId, at: atIso,
        scope: typeof scope === "string" && scope !== "" ? scope : `reading_evidence:confirm:${note_id}`,
      },
      updated_at: atIso,
      revision: nextRevision(prev.data),
    };
    try {
      const tx = await writeNoteFresh(fs.svc, hit.rel, {
        data: nextData, body: prev.body,
        expectedHash: prev.hash,
        idempotencyKey: `confirm:${note_id}:${prev.hash}`,
        purpose: "update_note",
      });
      return {
        ok: true, changed: true, note_id, note_rel: hit.rel,
        confirmation: "confirmed", origin: prev.data?.origin ?? null,
        confirmation_evidence: nextData.confirmation_evidence,
        transaction: { id: tx.id, state: tx.state, replayed: tx.replayed === true },
        honesty: {
          means: "这条观察已被你确认为你自己的稳定陈述",
          does_not_mean: "确认 ≠ 高置信、≠ 已掌握、≠ 读懂这本书",
        },
        message: "已确认这条观察（q 从 0.5 变 1；这不代表高置信）",
      };
    } catch (e) {
      return {
        ok: false, code: e?.code ?? "WRITE_FAILED", changed: false,
        message: `确认没写成：${String(e?.message || e)}`,
      };
    }
  }

  async function recordEvidence(request = {}) {
    const honesty = {
      book_understood: { allowed: false, reason: "采集到一条证据 ≠ 读懂这本书（PRD :240）" },
    };
    const refuse = (code, message, extra = {}) => ({ ok: false, code, message, written: false, honesty, ...extra });

    const spanId = typeof request.span_id === "string" ? request.span_id.trim() : "";
    const statement = typeof request.statement === "string" ? request.statement.trim() : "";
    const aiNote = typeof request.ai_note === "string" ? request.ai_note.trim() : "";
    const kind = typeof request.kind === "string" ? request.kind : null;
    const origin = typeof request.origin === "string" && request.origin !== "" ? request.origin : "user";
    const label = typeof request.label === "string" && request.label !== "" ? request.label : null;
    const runId = typeof request.run_id === "string" && request.run_id.trim() !== "" ? request.run_id.trim() : null;
    const occurredAt = typeof request.occurred_at === "string" && request.occurred_at.trim() !== ""
      ? request.occurred_at.trim() : new Date().toISOString();
    const conceptRefs = Array.isArray(request.concept_refs)
      ? request.concept_refs.filter((s) => typeof s === "string" && s.trim() !== "").map((s) => s.trim())
      : [];

    if (spanId === "") return refuse("MISSING_REQUIRED", "span_id 必填：证据必须绑在一段真实原文上（不凭印象写）");
    if (statement === "") return refuse("MISSING_REQUIRED", "statement 必填：没有用户自己的话就不写观察（不代写用户判断）");
    if (conceptRefs.length === 0) return refuse("MISSING_REQUIRED", "concept_refs 必填且非空");
    if (!EVIDENCE_KINDS.includes(kind)) {
      return refuse("INVALID_ENUM", `kind 只能是 ${EVIDENCE_KINDS.join(" / ")}，得到 ${JSON.stringify(kind)}`);
    }
    // 归属与 kind 必须自洽：AI 假设不能冒充用户判断，用户表现也不能记成 AI 推演
    if (kind === "ai_hypothesis" && origin !== "ai_inference") {
      return refuse("INVALID_COMBINATION", "kind=ai_hypothesis 时 origin 必须是 ai_inference（AI 假设不许冒充用户事实）");
    }
    if (kind !== "ai_hypothesis" && origin !== "user") {
      return refuse("INVALID_COMBINATION", `kind=${kind} 时 origin 必须是 user（用户自己的表现/自述/偏好）`);
    }
    if (label !== null && !EVIDENCE_LABELS.includes(label)) {
      return refuse("INVALID_ENUM", `证据标签只能是五类之一（${EVIDENCE_LABELS.join(" / ")}），得到 ${JSON.stringify(label)}`);
    }
    let dimension = typeof request.dimension === "string" && request.dimension !== "" ? request.dimension : null;
    if (kind === "explicit_preference") {
      // 显式偏好只影响兴趣、**不描述能力**（规范 §3 `:78`）⇒ 不接受能力维度。
      // 注意：这里**拒绝**而不是静默丢掉用户给的 dimension —— 悄悄改用户输入就是篡改。
      if (dimension !== null) {
        return refuse("INVALID_COMBINATION",
          "kind=explicit_preference 不描述能力 ⇒ dimension 必须为空（显式偏好只影响兴趣，不转成能力类别）");
      }
    } else if (!["familiarity", "explanation", "application", "retention"].includes(dimension)) {
      return refuse("INVALID_ENUM", `kind=${kind} 时 dimension 必填且只能是 familiarity / explanation / application / retention`);
    }
    if (kind === "self_report" && dimension !== "familiarity") {
      return refuse("INVALID_COMBINATION", "kind=self_report 时 dimension 必须是 familiarity（自报熟悉只支持自述）");
    }

    // ── 1) 先读原文：取不到就一条都不写（宁可不写，也不写错）──────────────
    // `readSourceSpan` 挂在 capabilities().policy 上（唯一读原文口），不另开旁路。
    const caps = capabilities();
    const readSpan = caps?.policy?.readSourceSpan;
    if (typeof readSpan !== "function") {
      return refuse("SIDECAR_UNAVAILABLE", "取原文的口没接上（readSourceSpan 不可用）⇒ 一条都不写");
    }
    const span = await readSpan(spanId);
    if (span.ok !== true) {
      return refuse(span.code ?? "SPAN_READ_FAILED",
        `取不到这段原文（${span.message ?? span.code}）⇒ 一条都不写：不凭记忆写证据`, { span });
    }
    if (span.verified !== true) {
      return refuse("SPAN_NOT_VERIFIED", "引擎没有把这段原文标成 verified ⇒ 不写（不拿未核验的引文当依据）", { span });
    }
    const bookVersionId = typeof span.book_version_id === "string" ? span.book_version_id : "";
    const contentId = bookVersionId.startsWith("bv_") ? bookVersionId.slice(3) : "";
    if (contentId === "") {
      return refuse("BOOK_IDENTITY_MISSING", "引擎没给出内容身份（book_version_id）⇒ 不落盘、不猜", { span });
    }
    // span_id 自描述：sp_<内容摘要16位>_<章序>_<起>_<止>。两处身份必须指向同一本书。
    const sm = /^sp_([0-9a-f]{16})_/.exec(spanId);
    if (!sm || sm[1] !== contentId) {
      return refuse("SPAN_IDENTITY_MISMATCH",
        `span_id 里的内容摘要（${sm ? sm[1] : "?"}）与引擎给的 book_version_id（${contentId}）不是同一本书 ⇒ 不写`,
        { span });
    }

    const fs = await fileService();
    if (fs.ok !== true) return refuse(fs.code, fs.message, { root: fs.root });

    // ── 2) 幂等：键由互动内容派生（不含时间、不含路径）────────────────────
    const key = evidenceInteractionKey({
      book_version_id: bookVersionId, span_id: spanId, kind, dimension, statement, concept_refs: conceptRefs,
    });
    const reId = readingEvidenceId(key);
    const uoId = understandingObservationId(key);
    const reKey = `reading_evidence:${key.slice(0, 24)}`;
    const uoKey = `understanding_observation:${key.slice(0, 24)}`;
    const topic = typeof request.topic === "string" && request.topic.trim() !== "" ? request.topic.trim() : conceptRefs[0];

    // Each interaction is an independent evidence object. A topic/book filename
    // alone lets a later kind/statement replace an earlier confirmed observation.
    // Keep the readable legacy stem, adding the stable interaction identity.
    const interactionRel = rel => rel.replace(/\.md$/, `｜${key.slice(0, 24)}.md`);
    let reRel = interactionRel(readingEvidenceRel({ topic, content_id: contentId }));
    // 显式偏好不构成理解变化 ⇒ 不写 understanding_observation（不硬凑一条）
    const writeUo = dimension !== null;
    let uoRel = writeUo ? interactionRel(understandingObservationRel({ occurred_at: occurredAt, topic, content_id: contentId })) : null;

    // 回放：**日志说 committed ≠ 盘上真有产物**。
    // 这里不能「查到 journal 就报已存过」——产物可能已被绕过本服务删掉或改掉
    // （M14 审计实测：硬删笔记后同一次互动再采，照样回 `REPLAYED` ⇒ 假成功，
    //  而且会让「删了又想要」永远拿不回数据：系统说存过，其实什么都没有）。
    // 核对盘上产物这一步**复用 file-service 的 findCommittedDrift**，不另写第二套。
    const already = await fs.svc.findByIdempotencyKey(reKey);
    const priorUo = writeUo ? await fs.svc.findByIdempotencyKey(uoKey) : null;
    // Existing journals remain authoritative, including pre-fix filenames.
    // No migration or rewrite of old notes; replay returns their actual paths.
    if (typeof already?.steps?.[0]?.path === 'string') reRel = already.steps[0].path;
    if (typeof priorUo?.steps?.[0]?.path === 'string') uoRel = priorUo.steps[0].path;
    if (already && already.state === "committed") {
      if (typeof fs.svc.findCommittedDrift !== "function") {
        return refuse("SERVICE_INCAPABLE",
          "事务服务没有提供产物核对口（findCommittedDrift 不可用）⇒ 无法确认这次互动是不是真的存过。"
          + "这里**不报「已存过」**：宁可不答，也不说没核对过的话");
      }
      const drift = [];
      for (const d of await fs.svc.findCommittedDrift(already)) {
        drift.push({ ...d, belongs_to: "reading_evidence", key: reKey });
      }
      if (writeUo) {
        const uoRec = priorUo;
        if (uoRec && uoRec.state === "committed") {
          for (const d of await fs.svc.findCommittedDrift(uoRec)) {
            drift.push({ ...d, belongs_to: "understanding_observation", key: uoKey });
          }
        } else {
          // 学习证据存过、理解变化却没有提交记录 ⇒ 当时那一步没写成。同样不许说「都存过了」。
          drift.push({
            path: uoRel, reason: "簿记里没有这条产物的提交记录（当时那一步没写成）",
            belongs_to: "understanding_observation", key: uoKey,
          });
        }
      }
      if (drift.length > 0) {
        return refuse("RECOVERY_REQUIRED",
          "事务簿记（journal）里记着这次互动已经写过，但盘上的产物对不上："
          + drift.map((d) => `${d.path}（${d.reason}）`).join("；")
          + "。**文件已经不在了**（或与记录不符）—— 这次互动实际上没有可用的产物。"
          + "这不是重放成功，也不会自动重建：要拿回数据，请先人工确认，再决定怎么处理。",
          {
            replayed: false,
            ids: { reading_evidence: reId, understanding_observation: writeUo ? uoId : null },
            notes: { reading_evidence: reRel, understanding_observation: uoRel },
            drift,
          });
      }
      return {
        ok: true, written: false, replayed: true, code: "REPLAYED",
        message: "同一次互动已经采集过 ⇒ 不重复写（幂等命中）",
        ids: { reading_evidence: reId, understanding_observation: writeUo ? uoId : null },
        notes: { reading_evidence: reRel, understanding_observation: uoRel },
        honesty,
      };
    }

    // ── 3) 来源：只用真实来源 ─────────────────────────────────────────────
    const actionId = `act_${key.slice(0, 24)}`;
    const userActionRef = {
      source_kind: "user_action",
      ref: {
        actor: "user",
        action_id: actionId,
        at: occurredAt,
        scope: "reading_evidence:create",
        short_statement: "用户就这段原文记下一条观察",
      },
    };
    const sourceRefs = [userActionRef];
    if (runId !== null) {
      const runRel = `${RUN_NOTE_DIR}/${runId}.md`;
      const got = await fs.svc.readNote(runRel);
      if (got.exists === true && typeof got.hash === "string" && got.hash !== "") {
        sourceRefs.push({ source_kind: "knowledge_note", ref: { relative_path: runRel, content_hash: got.hash } });
      }
    }

    const labelLine = label !== null
      ? `写入时派生标签：**${label}**（由面板按规范 §3 从 kind/dimension/source_refs/assessment_basis 派生；本笔记不另存权威评分字段）`
      : "写入时未提供派生标签（面板未派生）⇒ 请按规范 §3 自行派生";
    // ── 3b) 书内定位（M15 0b）：SpanRef 的**每一个必填字段**都必须来自引擎，缺一不写 ──
    // 缺字段就**不伪造**：宁可 book_evidence 为空并如实写明缺什么，也不填一个编的 block_id。
    const spanRef = buildSpanRefFromSpan(span);
    const locatorLines = [
      `定位：章节 \`${span.section_id}\`${Number.isInteger(span.section_order) ? `（第 ${span.section_order + 1} 节）` : ""} · 区间 \`[${span.start_codepoint}, ${span.end_codepoint})\`（Unicode codepoint 半开区间，**不是页码**）`,
      `\`span_id\`: \`${span.span_id}\` · \`text_hash\`: \`${span.text_hash}\``,
      `书身份：\`book_version_id = ${bookVersionId}\`（内容寻址：书改名/挪位置不变）`,
      spanRef.ok
        ? `书内块：\`href = ${spanRef.value.href}\` · \`block_id = ${spanRef.value.block_id}\``
          + `（块 = 原始 XHTML 的一个块级元素；区间 \`[${span.block_start_codepoint}, ${span.block_end_codepoint})\`）`
        : `**本次 book_evidence 为空**：引擎没给全 SpanRef 必填字段（缺 ${spanRef.missing.join(" / ")}）`
          + " ⇒ 不填编造的定位（书身份仍由 `relations → content_id` 表达）",
    ];
    const assessmentBasis = "用户就这段原文给出了一次自己的表达（原话见正文「用户判断」）；"
      + `书内引文为逐字原文（span_id=${span.span_id}，text_hash=${span.text_hash}，引擎已核验 verified）；`
      + "据此判为「有一次解释证据」候选；未评级（strength=null、confidence.level=unknown）";

    // ── 4) 落盘：只走 writeNote（内部 commit 事务）──────────────────────
    const out = {
      ok: true, written: false, replayed: false,
      ids: { reading_evidence: reId, understanding_observation: writeUo ? uoId : null },
      notes: { reading_evidence: reRel, understanding_observation: uoRel },
      reading_evidence: { written: false, note_rel: reRel, transaction: null, message: null },
      understanding_observation: writeUo
        ? { written: false, note_rel: uoRel, transaction: null, message: null }
        : {
            written: false, note_rel: null, code: "NOT_APPLICABLE",
            message: "这次互动是显式偏好、不描述能力 ⇒ 不写理解变化（不硬凑一条）",
          },
      honesty,
    };

    try {
      const prev = await fs.svc.readNote(reRel);
      const built = buildReadingEvidenceNote({
        id: reId, title: topic, content_id: contentId, book_version_id: bookVersionId,
        kind, dimension, concept_refs: conceptRefs, statement,
        assessment_basis: assessmentBasis, source_refs: sourceRefs, origin,
        label_line: labelLine, quote: span.quote, locator_lines: locatorLines, ai_note: aiNote,
        book_evidence: spanRef.ok ? [spanRef.value] : [],
      }, {
        now: occurredAt,
        revision: prev.exists === true ? nextRevision(prev.data) : 1,
        created_at: prev.exists === true ? prev.data?.created_at : occurredAt,
      });
      const tx = await writeNoteFresh(fs.svc, reRel, {
        data: built.data, body: built.body,
        expectedHash: prev.exists === true ? prev.hash : null,
        idempotencyKey: reKey, purpose: "update_note",
      });
      out.reading_evidence = {
        written: true, note_rel: reRel,
        transaction: { id: tx.id, state: tx.state, replayed: tx.replayed === true },
        message: "已写入学习证据（confirmation=unconfirmed）",
      };
      out.written = true;
    } catch (e) {
      out.ok = false;
      out.code = e?.code ?? "WRITE_FAILED";
      out.reading_evidence = { written: false, note_rel: reRel, code: out.code, message: String(e?.message || e) };
      out.message = `学习证据没写成：${out.reading_evidence.message}`;
      return out;
    }

    if (writeUo) {
      try {
        const prev = await fs.svc.readNote(uoRel);
        const built = buildUnderstandingObservationNote({
          id: uoId, title: `${topic}（理解补充）`, content_id: contentId,
          dimension, concept_refs: conceptRefs,
          after: statement, after_source_refs: [userActionRef],
          assessment_basis: "before 未知 ⇒ 不伪造「过去的想法」（before=null、前引用为空）；"
            + "after 来自用户本次原话、后引用非空；这是「这次理解有据可查」，不是「读懂了」",
          origin, label_line: labelLine, statement, quote: span.quote,
          locator_lines: locatorLines, ai_note: aiNote,
          book_evidence: spanRef.ok ? [spanRef.value] : [],
        }, {
          now: occurredAt,
          revision: prev.exists === true ? nextRevision(prev.data) : 1,
          created_at: prev.exists === true ? prev.data?.created_at : occurredAt,
        });
        const tx = await writeNoteFresh(fs.svc, uoRel, {
          data: built.data, body: built.body,
          expectedHash: prev.exists === true ? prev.hash : null,
          idempotencyKey: uoKey, purpose: "update_note",
        });
        out.understanding_observation = {
          written: true, note_rel: uoRel,
          transaction: { id: tx.id, state: tx.state, replayed: tx.replayed === true },
          message: "已写入理解变化（confirmation=unconfirmed、before=null）",
        };
      } catch (e) {
        out.ok = false;
        out.code = e?.code ?? "WRITE_FAILED";
        out.understanding_observation = { written: false, note_rel: uoRel, code: out.code, message: String(e?.message || e) };
        out.message = `理解变化没写成：${out.understanding_observation.message}（学习证据已写入，未回滚）`;
      }
    }
    return out;
  }

  async function proposals() {
    const scan = await scanVault();
    if (!scan.ok) return { ok: false, code: scan.code, message: scan.message, root: scan.root };
    const list = scan.notes.filter((n) => n.object_type === "change_proposal" && n.formal_valid === true);
    const fs = await fileService();
    let transactions = [];
    let txError = null;
    if (fs.ok) {
      try {
        const all = await fs.svc.listTransactions();
        transactions = all.map((j) => ({
          id: j?.id ?? null,
          purpose: j?.purpose ?? null,
          state: j?.state ?? null,
          idempotency_key: j?.idempotency_key ?? null,
          created_at: j?.created_at ?? null,
        }));
      } catch (e) {
        txError = String(e?.message || e);
      }
    }
    return {
      ok: true,
      root: scan.root,
      proposals: list.map((n) => ({
        rel: n.rel,
        proposal_id: n.id,
        state: n.state,
        title: n.title,
        knowledge_status: n.knowledge_status,
        created_at: n.created_at,
        updated_at: n.updated_at,
        content_hash: n.content_hash,
      })),
      count: list.length,
      invalid_count: scan.notes.filter((n) => n.object_type === "change_proposal" && n.formal_valid !== true).length,
      /** 文件事务状态**只补进度，不改审核权威**（规范 §4）。 */
      transactions,
      transactions_error: txError,
      empty_state: list.length === 0 ? { proposals: 0, message: "尚无待审核提案" } : null,
    };
  }

  /** 维护：maintenance_proposal 待办。 */
  async function maintenance() {
    const scan = await scanVault();
    if (!scan.ok) return { ok: false, code: scan.code, message: scan.message, root: scan.root };
    const list = scan.notes.filter((n) => n.object_type === "maintenance_proposal" && n.formal_valid === true);
    const pending = list.filter((n) => (n.state ?? "pending") === "pending");
    return {
      ok: true,
      root: scan.root,
      items: list.map((n) => ({ rel: n.rel, id: n.id, state: n.state, title: n.title })),
      pending: pending.map((n) => n.rel),
      pending_count: pending.length,
      invalid_count: scan.notes.filter((n) => n.object_type === "maintenance_proposal" && n.formal_valid !== true).length,
      empty_state: list.length === 0 ? { items: 0, message: "待登记维护提案：0" } : null,
    };
  }

  /** 健康：把上面几项合成一张「能不能用、哪里不能用」的清单。 */
  async function health() {
    const dir = bookKbDir();
    const fs = await fileService();
    const sess = sessionReader();
    const scan = fs.ok ? await scanVault() : null;
    const zones = fs.ok ? await indexZones() : null;
    const caps = capabilities();

    let dirExists = false;
    let dirWritableProbe = null;
    try {
      const st = await stat(dir.path);
      dirExists = st.isDirectory();
    } catch { dirExists = false; }
    if (fs.ok) dirWritableProbe = fs.svc.capabilities();

    return {
      ok: fs.ok,
      runtime_version: RUNTIME_VERSION,
      schema_version: SCHEMA_VERSION,
      checked_at: now().toISOString(),
      book_kb_dir: { path: dir.path, source: dir.source, exists: dirExists },
      file_service: fs.ok
        ? {
            ok: true,
            root: fs.root,
            writes_limited_to: dirWritableProbe?.writesLimitedTo ?? fs.root,
            /** 目录 fsync 是否**已实测**成功：没写过盘时是「未探测」，不是「不支持」。 */
            dir_fsync_observed: dirWritableProbe?.dirFsync === true,
            dir_fsync_probed: false,
            dir_fsync_error: dirWritableProbe?.dirFsyncError ?? null,
          }
        : { ok: false, code: fs.code, message: fs.message },
      session_query: { injected: sess.injected, projections: sess.projections ?? false, code: sess.ok ? null : sess.code, message: sess.ok ? null : sess.message },
      vault: scan ? {
        counts_known: scan.counts_known,
        markdown_seen: scan.markdown_seen,
        by_object_type: scan.by_object_type,
        by_object_type_formal: scan.by_object_type_formal,
        parse_failure_count: scan.parse_failures.length,
        validation_failure_count: scan.validation_failures.length,
        index_present: !!scan.index,
        truncated: scan.truncated,
      } : null,
      index_zones: zones ? {
        ok: zones.ok,
        writable: zones.writable,
        reason: zones.reason ?? null,
        problems: zones.problems ?? [],
        missing_zones: (zones.zones ?? []).filter((z) => !z.paired).map((z) => z.zone),
      } : null,
      capabilities: caps.report,
      /** 「0 项」与「无法计算」必须分开（规范 §4）。 */
      honesty: {
        zero_vs_unknown: {
          vault_counts_known: scan ? scan.counts_known : false,
          coverage_units_known: false,
          index_zones_known: !!(zones && zones.ok),
        },
        note: "解析失败不是 0；未读到不等于没有",
      },
    };
  }

  // ----------------------------------------------------------------------- //
  // M8 ② 逐章分析（books_rag.py 新入口）与「分析 → 候选 → rank → 落盘」
  // ----------------------------------------------------------------------- //

  /** 落盘目录：运行记录进 `推荐反馈/`（M1 已把它列为知识库的正式目录之一）。 */
  const RUN_NOTE_DIR = "推荐反馈";

  /**
   * 调引擎逐章分析。**只读**：不写任何文件，结果原样透出（含窗口消费证据与队列）。
   *
   * 引擎侧的三条纪律由引擎保证，这里再核一遍，免得「引擎改了、编排器不知道」：
   *   · 分母必须显式（`coverage.total_units` 是数字，未知部分显式列在 `unknown`）
   *   · `whole_book_claim_allowed` 必须是 false、`whole_book_percent` 必须是 null
   *   · `honesty.book_understood.allowed` 必须是 false
   */
  async function analyzeChapter({ book, window_chars = null, sections = null, signal = null } = {}) {
    if (!sidecarFetch) {
      return { ok: false, code: "SIDECAR_UNAVAILABLE", message: "sidecar 转发未注入 ⇒ 无法逐章分析" };
    }
    if (typeof book !== "string" || book.trim() === "") {
      return { ok: false, code: "BAD_REQUEST", message: "analyzeChapter 需要 book（书名，支持子串）" };
    }
    const payload = { book };
    if (Number.isInteger(window_chars) && window_chars > 0) payload.window_chars = window_chars;
    if (Array.isArray(sections) && sections.length > 0) payload.sections = sections;
    let data;
    try {
      const up = await sidecarFetch("/analyze-chapter", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload), signal,
      });
      data = await up.json();
    } catch (e) {
      return { ok: false, code: "ANALYZE_FAILED", message: String(e?.message || e) };
    }
    if (data === null || typeof data !== "object" || data.ok !== true) {
      return {
        ok: false,
        code: data?.code ?? "ANALYZE_FAILED",
        message: data?.message ?? data?.error ?? "逐章分析失败",
      };
    }
    const honesty = data.honesty ?? {};
    const coverage = data.coverage ?? {};
    const violations = [];
    if (coverage.whole_book_claim_allowed !== false) violations.push("coverage.whole_book_claim_allowed 必须是 false");
    if (coverage.whole_book_percent !== null) violations.push("coverage.whole_book_percent 必须是 null（不编百分比）");
    if (honesty.book_understood?.allowed !== false) violations.push("honesty.book_understood.allowed 必须是 false");
    if (!Number.isInteger(coverage.total_units)) violations.push("coverage.total_units 必须是整数（分母必显）");
    if (coverage.unknown?.counts_known !== false) violations.push("coverage.unknown.counts_known 必须是 false（未知部分必显）");
    if (violations.length > 0) {
      // 引擎越界 ⇒ 不把它当成可用输入（宁可不做，也不拿着不诚实的输出往下走）
      return { ok: false, code: "ANALYSIS_HONESTY_VIOLATION", message: violations.join("；"), violations };
    }
    return { ok: true, analysis: data, read_only: true };
  }

  /** 目标词（CJK 取 2 字滑窗 + 拉丁词）：用来判「候选与本次目标是否真有重合」。 */
  function goalTerms(text) {
    const s = String(text ?? "");
    const terms = new Set();
    for (const m of s.matchAll(/[A-Za-z][A-Za-z0-9_-]+/g)) terms.add(m[0].toLowerCase());
    for (const m of s.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
      const run = m[0];
      for (let i = 0; i + 2 <= run.length; i++) terms.add(run.slice(i, i + 2));
    }
    return [...terms];
  }

  /**
   * 由**显式目标**推出 R（与本次明确目标相关）的**真实依据**。
   *
   * 为什么要有这一步：没有个人维度时 policy 会如实给出 `personalization_status="none"`，
   * 第二层就是空的（正确行为）。要让第二层有内容，必须有**真实**的 R 依据。
   * 这里不做「所有候选都与目标相关」这种编造 —— 只有目标词与候选自己的切片**确有字面重合**
   * 的候选才拿到 R，并且把重合到的词与对应切片 id 一并记下（可复核）。
   */
  function goalRelevance(goal, sliceTexts) {
    const isGoalMap = goal !== null && typeof goal === "object" && !Array.isArray(goal);
    const text = isGoalMap ? goal.text : goal;
    const ref = isGoalMap ? goal.ref : "goal:current";
    if (typeof text !== "string" || text.trim() === "") return null;
    const terms = goalTerms(text);
    if (terms.length === 0) return null;
    const matched = [];
    for (const t of terms) {
      if (sliceTexts.some((s) => s.includes(t))) matched.push(t);
    }
    if (matched.length === 0) return null;   // 没有重合 ⇒ 不给 R（宁可第二层为空，也不编相关）
    return { ref: typeof ref === "string" && ref !== "" ? ref : "goal:current", matched };
  }

  // ── 阶段 1：证据 → 维度依据（第 5 环的入口）────────────────────────────── //

  /** 规范 §3：M14 采集产出的两种证据笔记（只有这两种能当个人维度依据）。 */
  const EVIDENCE_NOTE_TYPES = Object.freeze(["reading_evidence", "understanding_observation"]);

  /**
   * 证据笔记 → 五类标签用的 `kind`（**唯一一份映射**）。
   *
   * `understanding_observation` 没有 `kind` 字段：它就是**用户自己的陈述** ⇒ 归 `self_report`。
   * 这份映射同时供 `collectEvidenceContext`（回灌进 rank）与 `evidenceNotes`（面板只读清单）用，
   * 避免面板和引擎各写一份「理解变化算哪一类」。
   */
  function evidenceKindOf(objectType, data) {
    if (objectType === "understanding_observation") return "self_report";
    return typeof data?.kind === "string" ? data.kind : null;
  }

  /**
   * 证据笔记 → **可核验来源引用**。
   * `reading_evidence` 用 `source_refs`；`understanding_observation` 用 `after_source_refs`
   * （规范 §3 `:78`：理解变化不直接派生标签，但它自己的来源照样是可核验的）。
   */
  function evidenceSourceRefsOf(objectType, data) {
    const key = objectType === "understanding_observation" ? "after_source_refs" : "source_refs";
    return Array.isArray(data?.[key]) ? data[key] : [];
  }

  /**
   * 「限制 / 转折」字面标记。
   *
   * T（有据挑战）的定义要求「书中确有**冲突/限制**的段落」（PRD :260）。语义上的冲突
   * 判不出来，这里用**可复核的字面标记**近似，并把命中的标记写进理由里 —— 人能看到
   * 「凭什么说这段有限制表述」。这是近似，不是语义判定，理由里如实说明。
   */
  const LIMITATION_MARKERS = Object.freeze([
    "但是", "然而", "不过", "并非", "相反", "反之", "恰恰", "反而",
    "例外", "除非", "取决于", "限制", "边界", "前提",
  ]);

  /**
   * 取证据笔记里 `book_evidence`（0b 起非空）的定位字段 —— 结构化对上候选。
   *
   * 注意：证据笔记**没有顶层 `book_version_id`**（schema 里没这个字段），书的身份只能从
   * `book_evidence[0]` 拿。这就是 0b 必须先做的原因：没有它，证据根本认不出属于哪本书、
   * 哪一节，回灌就无从谈起。
   */
  function bookEvidenceOf(data) {
    const be = Array.isArray(data?.book_evidence) ? data.book_evidence : [];
    const first = be.find((e) => e && typeof e === "object") ?? null;
    const str = (v) => (typeof v === "string" && v !== "" ? v : null);
    return {
      book_version_id: str(first?.book_version_id) ?? str(data?.book_version_id),
      section_id: str(first?.section_id),
      span_id: str(first?.span_id),
      block_id: str(first?.block_id),
    };
  }

  /**
   * 读库里的**证据笔记**，做成 `policy.rank` 要的证据表（只读，一个字节都不写）。
   *
   * 为什么要有这一步：`buildRankRequestFromAnalysis` 原先把
   * `allowed_profile_refs_and_short_evidence` / `note_ids_and_hashes` 写死成空数组 ⇒
   * 第二层永远是空的、`personalization_status` 永远 `none`。第 5 环就是把这里接上。
   *
   * 诚实边界：
   *   · **只收这本书的证据**：别的书的证据既不进证据表、也不进输入清单，更不会出现在提示里
   *     （书的身份从 `book_evidence[0].book_version_id` 拿；认不出属于哪本书的一律跳过）；
   *   · `source_verifiable=true` 是**真的**（这条文件刚被读出来），不是笔记自报；
   *   · `short_evidence` 一律 null：**不复制用户原话**（原话在笔记正文里），
   *     要读就拿 `ref` + `content_hash` 去读那条笔记；
   *   · `tier` 只按「origin=user 且 confirmation=confirmed」判 stable，别的都是 reference
   *     —— 稳定层由 PRD :493 定义，不在这里另立标准。
   */
  async function collectEvidenceContext(fs, scan, { book_version_id = null } = {}) {
    const entries = [];
    const noteIdsAndHashes = [];
    const notes = [];
    const skipped = [];
    for (const n of scan.notes) {
      if (n.formal_valid !== true) continue;
      if (!EVIDENCE_NOTE_TYPES.includes(n.object_type)) continue;
      let got = null;
      try {
        got = await fs.svc.readNote(n.rel);
      } catch (e) {
        skipped.push({ note_rel: n.rel, reason: "read_failed", detail: String(e?.message || e) });
        continue;
      }
      if (!got?.exists) { skipped.push({ note_rel: n.rel, reason: "file_missing" }); continue; }
      const d = got.data ?? {};
      if (opts.testProfile === true || isTestEvidence(got.body)) { skipped.push({note_rel:n.rel, reason:opts.testProfile === true ? "test_profile" : "test_evidence"}); continue; }
      const id = typeof d.id === "string" && d.id !== "" ? d.id : null;
      const hash = typeof got.hash === "string" && got.hash !== "" ? got.hash : null;
      if (id === null || hash === null) { skipped.push({ note_rel: n.rel, reason: "no_id_or_hash" }); continue; }
      const be = bookEvidenceOf(d);
      // 只收**这本书**的证据。认不出属于哪本书的，也不猜 —— 直接跳过并记原因。
      if (be.book_version_id === null) { skipped.push({ note_rel: n.rel, reason: "unknown_book" }); continue; }
      if (book_version_id !== null && be.book_version_id !== book_version_id) {
        skipped.push({ note_rel: n.rel, reason: "other_book", book_version_id: be.book_version_id });
        continue;
      }
      // `understanding_observation` 没有 kind 字段：它就是**用户自己的陈述** ⇒ 归 self_report。
      // 这份映射只有一处（evidenceKindOf），面板的只读清单也用它。
      const kind = evidenceKindOf(n.object_type, d);
      const dimension = typeof d.dimension === "string" ? d.dimension : null;
      const origin = d.origin ?? null;
      const confirmation = d.confirmation ?? null;
      const knowledgeStatus = d.knowledge_status ?? null;
      const validUntil = d.valid_until ?? null;
      const stable = origin === "user" && confirmation === "confirmed";
      entries.push({
        ref: id,
        tier: stable ? "stable" : "reference",
        kind,
        origin,
        confirmation,
        knowledge_status: knowledgeStatus,
        valid_until: validUntil,
        source_verifiable: true,
        source_kind: "knowledge_note",
        content_hash: hash,
        derived_from_feedback: null,
        short_evidence: null,
      });
      noteIdsAndHashes.push({ object_id: id, content_hash: hash, relative_path: n.rel });
      notes.push({
        id, rel: n.rel, hash, object_type: n.object_type, kind, dimension,
        origin, confirmation, knowledge_status: knowledgeStatus, valid_until: validUntil,
        book_version_id: be.book_version_id,
        section_id: be.section_id,
        span_id: be.span_id,
        concept_refs: Array.isArray(d.concept_refs) ? d.concept_refs : [],
      });
    }
    return { entries, note_ids_and_hashes: noteIdsAndHashes, notes, skipped };
  }

  /**
   * M15 阶段 3：面板「我确认这条观察」需要先知道**有哪些证据笔记**（id / 当前 confirmation）。
   *
   * 为什么必须由后端给：面板手里只有书单（`/api/books`）与推荐投影，**看不到证据笔记的 id**；
   * 而确认动作按 `note_id` 定位。让面板自己去扫 `45-书籍/` 既越权、又会造出第二套读取实现。
   *
   * **只读**：只扫库 + 逐条 `readNote`，不写盘、不走事务、不生成任何笔记。
   *
   * 诚实边界：
   *   · 带 `?path=` ⇒ 只列**这本书**的证据（书的身份问引擎，内容寻址）；
   *     定不出身份 ⇒ `ok:false` 明确报错，**不回退**成「列全部」（拿别的书的证据顶替就是撒谎）；
   *   · 不带 `?path=` ⇒ 列全库证据，并如实标 `book_scoped:false`（面板据此说明「未按书过滤」）；
   *   · 认不出属于哪本书的证据、读不出来的笔记：进 `skipped` 如实报出，**不当成 0、不静默丢**；
   *   · 每条只带**展示/确认所需**的字段（含 `evidenceLabel()` 要的 kind/dimension/source_refs/
   *     assessment_basis/valid_until）；按最新确认合同附上独立的用户陈述与书中原文展示字段，
   *     不混入计算用 short_evidence，不因展示而修改确认、归属或知识状态。
   */
  function observationBlock(body, prefix) {
    const lines=String(body??'').split('\n'); const start=lines.findIndex(l=>l.startsWith('## '+prefix));
    if(start<0)return null; let end=start+1;while(end<lines.length&&!/^## /.test(lines[end]))end++;
    return lines.slice(start+1,end).map(l=>l.replace(/^> ?/,'')).join('\n').trim()||null;
  }
  function observationStatement(body){const text=observationBlock(body,'用户判断');return text&&!text.startsWith('【本次没有')?text:null;}
  function observationQuote(body){return observationBlock(body,'书中观点')?.split('\n\n')[0]??null;}
  function isTestEvidence(body){return /验收测试|不代表用户真实偏好或能力|隔离合成/.test(observationStatement(body)??'');}
  async function evidenceNotes({ book_path = null } = {}) {
    const scoped = typeof book_path === "string" && book_path.trim() !== "";
    const base = {
      ok: false, read_only: true, book_scoped: scoped,
      book_path: scoped ? book_path : null, book_version_id: null,
      now: now().toISOString(), notes: [], count: 0, skipped: [], empty_state: null,
      honesty: {
        means: "这些是你在面板上记下的学习证据（reading_evidence / understanding_observation）",
        does_not_mean: "有证据 ≠ 已掌握、≠ 已读懂；未确认的观察参与计算时 q=0.5",
      },
    };
    const fs = await fileService();
    if (!fs.ok) return { ...base, code: fs.code, message: fs.message };

    let bookVersionId = null;
    if (scoped) {
      const t = await resolveBookRunTarget(book_path);
      if (!t.ok) {
        return {
          ...base, code: t.code,
          message: `${t.message} ⇒ 列不出这本书的证据（**不拿别的书的证据顶替**）`,
          ...(t.detail ? { detail: t.detail } : {}),
        };
      }
      bookVersionId = t.book_version_id;
      base.book_version_id = bookVersionId;
    }

    const scan = await scanVault();
    if (!scan.ok) return { ...base, code: scan.code, message: scan.message };

    const notes = [];
    const skipped = [];
    for (const n of scan.notes) {
      if (n.formal_valid !== true) continue;
      if (!EVIDENCE_NOTE_TYPES.includes(n.object_type)) continue;
      let got = null;
      try {
        got = await fs.svc.readNote(n.rel);
      } catch (e) {
        skipped.push({ note_rel: n.rel, reason: "read_failed", detail: String(e?.message || e) });
        continue;
      }
      if (!got?.exists) { skipped.push({ note_rel: n.rel, reason: "file_missing" }); continue; }
      const d = got.data ?? {};
      const be = bookEvidenceOf(d);
      if (scoped && be.book_version_id !== bookVersionId) {
        skipped.push({
          note_rel: n.rel,
          reason: be.book_version_id === null ? "unknown_book" : "other_book",
          ...(be.book_version_id !== null ? { book_version_id: be.book_version_id } : {}),
        });
        continue;
      }
      notes.push({
        statement: observationStatement(got.body),
        source_quote: observationQuote(got.body),
        test_evidence: opts.testProfile === true || isTestEvidence(got.body),
        note_id: typeof d.id === "string" && d.id !== "" ? d.id : null,
        note_rel: n.rel,
        object_type: n.object_type,
        title: typeof d.title === "string" ? d.title : null,
        kind: evidenceKindOf(n.object_type, d),
        dimension: typeof d.dimension === "string" ? d.dimension : null,
        origin: d.origin ?? null,
        confirmation: d.confirmation ?? null,
        confirmation_evidence: d.confirmation_evidence ?? null,
        knowledge_status: d.knowledge_status ?? null,
        valid_until: d.valid_until ?? null,
        assessment_basis: typeof d.assessment_basis === "string" ? d.assessment_basis : null,
        source_refs: evidenceSourceRefsOf(n.object_type, d),
        concept_refs: Array.isArray(d.concept_refs) ? d.concept_refs : [],
        book_version_id: be.book_version_id,
        section_id: be.section_id,
        span_id: be.span_id,
        revision: Number.isInteger(d.revision) ? d.revision : null,
        updated_at: d.updated_at ?? null,
        content_hash: got.hash ?? null,
      });
    }

    return {
      ...base,
      ok: true,
      count: notes.length,
      notes,
      skipped,
      empty_state: notes.length === 0
        ? {
          code: scoped ? "NO_EVIDENCE_FOR_BOOK" : "NO_EVIDENCE",
          message: scoped ? "这本书还没有学习证据笔记" : "书库里还没有学习证据笔记",
        }
        : null,
      message: scoped
        ? `这本书有 ${notes.length} 条学习证据`
        : `书库共有 ${notes.length} 条学习证据（**未按书过滤**，因为没给 book_path）`,
    };
  }

  /**
   * 由**真实证据笔记**推出一个候选的 R/G/T 依据（阶段 1）。
   *
   * 三条硬规矩（都能证伪）：
   *   · **只认同书同节**：证据的 `book_evidence.section_id` 必须等于候选的 `section_id`，
   *     且 `book_version_id` 相同 —— 这是 0b 补 `block_id`/`href` 换来的**结构化对位**，
   *     不靠猜、不靠字面相似度；
   *   · **每维都带 reason + evidence_refs**（笔记 id）⇒ 追得到那条笔记和它的文件 hash；
   *   · **没依据就是 null**，不填 0、不给中立分（PRD :271）。
   *
   * 维度来源（每一类都按 PRD :257-259 的**最低证据**来，不硬凑）：
   *   · **R** ← 本次明确目标（字面重合）+ `explicit_preference` 偏好笔记（PRD :280 明确允许）；
   *   · **G** ← `observed_performance`（**可复核表现证据**；自报熟悉 / 偏好 / AI 假设都不算）；
   *   · **T** ← 用户判断原话（`observed_performance + explanation`）+ 书中确有冲突/限制的段落
   *     （字面启发式，可复核），且不是同一条 span（否则没提供新东西）。
   *
   * `self_report + familiarity`（「我只是熟悉/听说过」）**不推任何维度**：按规范它只支持自述，
   * 不推导解释或应用能力。它照样进证据表（reference），但不会变成分值。
   */
  function personalDimensionsFor({ sectionId, bookVersionId, refs, sliceTexts, evidenceNotes, goal }) {
    const personal = {};
    const onSection = (evidenceNotes ?? []).filter((n) =>
      n.book_version_id === bookVersionId && n.section_id !== null && n.section_id === sectionId);
    const refOf = (n) => n.id;

    // ---- R：目标相关 / 范围相关 ----
    const rRefs = [];
    let rScore = 0;
    const rBits = [];
    const rel = goalRelevance(goal, sliceTexts);
    if (rel) {
      rRefs.push(rel.ref);
      rScore = rel.matched.length >= 3 ? 3 : 2;
      rBits.push(`与本次明确目标相关（目标词与本节切片重合：${rel.matched.slice(0, 6).join("、")}）`);
    }
    const prefs = onSection.filter((n) => n.kind === "explicit_preference");
    if (prefs.length > 0) {
      for (const p of prefs) rRefs.push(refOf(p));
      rScore = Math.max(rScore, 2);
      rBits.push(`你在这本书这一节记过「${prefs.length} 条偏好」证据（${prefs.map((p) => p.id).join("、")}），`
        + "偏好只界定**兴趣范围**，不当能力依据");
    }
    if (rRefs.length > 0) {
      personal.R = {
        score: rScore,
        reason: `R: ${rBits.join("；")}`,
        evidence_refs: rRefs,
        book_premise_refs: refs.map((r) => r.span_id),
        relevance_basis: rel ? { kind: "goal_term_overlap", matched_terms: rel.matched }
          : { kind: "explicit_preference_scope" },
      };
    }

    // ---- G：可证实缺口 ----
    // PRD :258 判据「针对一个已观察的概念误解或缺少前提」，最低证据是**可复核表现证据**
    // （`observed_performance`）。所以这里**只认具体表现**：
    //   · 自报熟悉（`self_report`）不算 —— 那是自述，推不出解释/应用能力；
    //   · 偏好、AI 假设更不算（policy 有 `G_WITHOUT_OBSERVED_PERFORMANCE` 把关）。
    // 书内前提 = 候选自己的切片。结论只到「前提待补」，不说「你必然欠缺」。
    const perf = onSection.filter((n) => n.kind === "observed_performance");
    if (perf.length > 0) {
      personal.G = {
        score: 2,
        reason: `G: 你在这本书这一节留下过**可复核的具体表现**（${perf.map((n) => n.id).join("、")}，`
          + "一次解释 / 一次迁移，引擎已核验原文）。缺口只落在「前提待补」这一层："
          + "一次表现不足以说明稳定掌握，本节切片给出对应前提。"
          + "**不是**从「知识库为空」推的缺口，也不下「你必然欠缺」的结论",
        evidence_refs: perf.map(refOf),
        book_premise_refs: refs.map((r) => r.span_id),
      };
    }

    // ---- T：有据挑战（用户已表达判断 + 本节含限制/转折字面）----
    // **为什么不再要求「证据 span 必须不是候选自己的切片」**（2026-10-11 真机验收发现）：
    // 真引擎给每个候选的 `slice_ids` 就是**它那一节的全部切片**（16/16 个候选实测空余切片为 0），
    // 于是「证据 span ∉ 候选切片」**恒为假** ⇒ T 永远给不出来 ⇒ W 只有 0.5、C=0.714
    // ⇒ `personalization_status` 在真机上**永远到不了 `available`**（只有替身夹具能到）。
    // 而 PRD :260 给 T 的判据只有两件：「用户判断原话 + 书中确有冲突/限制的段落」——
    // **没有**「必须不同 span」这一条。那条是本实现自己加的，已删。
    const judged = onSection.filter((n) => n.kind === "observed_performance" && n.dimension === "explanation");
    const markers = LIMITATION_MARKERS.filter((m) => sliceTexts.some((s) => s.includes(m)));
    if (judged.length > 0 && markers.length > 0) {
      personal.T = {
        score: 2,
        reason: `T: 你已就这一节给出过自己的解释（${judged.map((n) => n.id).join("、")}）= **用户判断原话**，`
          + `本节片段含限制/转折表述「${markers.slice(0, 4).join("、")}」= **书中确有冲突/限制的段落**；`
          + "两件都齐了才给 T。"
          + (perf.length > 0 ? "（与 G 依据同源，但主张不同：G 说的是缺口，T 说的是挑战。）" : "")
          + "匹配方式为**字面启发式**，不是语义判定；分值只给 2",
        evidence_refs: judged.map(refOf),
        // T 的两件硬要求（policy 的 `T_WITHOUT_EXPRESSED_JUDGMENT` / `T_WITHOUT_BOOK_CONFLICT`）：
        user_judgment_ref: judged[0].id,                      // 用户判断原话 = 那条解释笔记
        book_conflict_refs: refs.map((r) => r.span_id),       // 书中确有冲突/限制的段落 = 候选切片
        book_premise_refs: refs.map((r) => r.span_id),
      };
    }

    return personal;
  }

  /**
   * 把引擎的「切片 + 概括」候选翻成 `policy.rank` 要的候选形状。
   *
   * 三条不许含糊：
   *   · 只用**真消费过**的窗口所产的切片当书内依据（引擎已经保证，这里再核一次）；
   *   · B 用引擎给出的**结构分析**建议，`basis.kind="book_analysis"`，并**原样保留**它的理由，
   *     绝不改成「检索相似度」（PRD :267）；
   *   · 没有可用切片的候选直接**不产出**（不造空壳候选去凑数）；
   *   · **个人维度只由真实证据给**（M15 阶段 1）：证据必须与候选**同书同节**，
   *     且每维都带 `reason` + `evidence_refs`；没依据的维度保持 `null`。
   */
  function candidatesFromAnalysis(analysis, { candidate_set_version = "cs_m8", goal = null, evidence = null } = {}) {
    const slicesById = new Map((analysis.slices ?? []).map((s) => [s.slice_id, s]));
    const consumedWindows = new Set(
      (analysis.windows ?? []).filter((w) => w.consumed === true).map((w) => w.window_id),
    );
    const out = [];
    const skipped = [];
    for (const c of analysis.candidates ?? []) {
      const refs = [];
      const sliceTexts = [];
      for (const sid of c.slice_ids ?? []) {
        const s = slicesById.get(sid);
        if (!s) continue;
        if (!consumedWindows.has(s.window_id)) continue;   // 未真消费的窗口 ⇒ 不当依据
        refs.push({ span_id: s.slice_id, text_hash: s.text_hash });
        sliceTexts.push(String(s.text ?? ""));
      }
      if (refs.length === 0) {
        skipped.push({ candidate_id: c.candidate_id, reason: "no_consumed_slice" });
        continue;
      }
      const pb = c.proposed_b ?? {};
      // M15 阶段 1：R/G/T 一律由**真实证据**推（同书同节的证据笔记 + 本次明确目标）。
      // 没有依据的维度保持 null —— 不填 0、不给中立分（PRD :271）。
      const personal = personalDimensionsFor({
        sectionId: c.section_id,
        bookVersionId: analysis.book_version_id,
        refs,
        sliceTexts,
        evidenceNotes: evidence?.notes ?? [],
        goal,
      });
      out.push({
        candidate_id: c.candidate_id,
        book_version_id: analysis.book_version_id,
        section_id: c.section_id,
        section_order: c.section_order,
        concept_refs: [],
        book_evidence_refs: refs,
        b: {
          score: Number.isInteger(pb.score) ? pb.score : null,
          reason: pb.reason ?? null,
          basis: { kind: "book_analysis" },
        },
        personal,
        overview_paragraph: { text: c.summary ?? "", source_refs: refs.map((r) => r.span_id) },
        estimated_minutes: null,
        uncertainty: null,
      });
    }
    return { candidates: out, skipped, candidate_set_version };
  }

  /** 由分析结果 + 阅读背景/目标 + **真实证据表**，组装一个合法的 rank request。 */
  function buildRankRequestFromAnalysis(analysis, {
    run_id,
    goal = null,
    reading_boundary = { mode: "whole_book" },
    candidates = null,
    recent_feedback = [],
    policy_config = null,
    budget = null,
    evidence = null,
  } = {}) {
    const built = candidates ?? candidatesFromAnalysis(analysis, { goal, evidence }).candidates;
    const sectionIds = (analysis.chapters ?? []).map((c) => c.section_id);
    const request = {
      schema_version: SCHEMA_VERSION,
      run_id,
      book_version_id: analysis.book_version_id,
      coverage_snapshot: {
        scope: "parsed_body",
        section_ids: sectionIds,
        candidate_set_version: "cs_m8",
        ref: `cov_${analysis.content_id ?? "unknown"}`,
      },
      goal,
      // M15 阶段 1：把真实证据笔记接进来（此前写死空数组 ⇒ 第二层永远是空的）
      allowed_profile_refs_and_short_evidence: evidence?.entries ?? [],
      note_ids_and_hashes: evidence?.note_ids_and_hashes ?? [],
      candidates: built,
      reading_boundary,
      recent_feedback,
      policy_config,
      budget,
    };
    return request;
  }

  /**
   * 自己核一遍「窗口区间无重叠」——**不靠引擎自报**。
   *
   * 覆盖分母的口径是「span 区间的并集」（PRD :346）。窗口若重叠，`Σ chars` 就会
   * 大于并集，分母被灌水。所以这里按 `(section_id, index)` 排序后逐段核验
   * `prev.end_codepoint === cur.start_codepoint`（首尾相接 ⇒ 无洞、无叠）。
   * 核不过就**如实报出来**（`ok:false` + 具体位置），不静默当无重叠。
   */
  function windowsContiguity(windows) {
    const bySection = new Map();
    for (const w of windows) {
      const sid = typeof w?.section_id === "string" ? w.section_id : "(no_section)";
      if (!bySection.has(sid)) bySection.set(sid, []);
      bySection.get(sid).push(w);
    }
    const violations = [];
    for (const [sid, list] of bySection) {
      const sorted = [...list].sort((a, b) => Number(a?.index ?? 0) - Number(b?.index ?? 0));
      for (let i = 1; i < sorted.length; i += 1) {
        const prev = sorted[i - 1];
        const cur = sorted[i];
        if (prev?.end_codepoint !== cur?.start_codepoint) {
          violations.push({
            section_id: sid,
            at_index: cur?.index ?? null,
            prev_end_codepoint: prev?.end_codepoint ?? null,
            start_codepoint: cur?.start_codepoint ?? null,
          });
        }
      }
    }
    return { ok: violations.length === 0, violations };
  }

  /**
   * 把一次逐章分析翻成面板**必须如实显示**的六项报告（纯函数、只读）。
   *
   * 为什么要有这一步：`analyze-and-persist` 原先只回 `analysis_summary`（窗口计数 + 候选数），
   * 而 M9 要求面板如实显示六项 —— 切片数 / 候选数 / 覆盖（分母＝区间并集）/
   * 失败窗口数**与原因** / `complete_for_parsed_body` / 本次 `run_id`。
   * 缺的字段面板拿不到 ⇒ 只能编或只能少说，两条都不行。所以在这里补齐：
   *
   *   · **只增不改**：新增 `honest_report` 字段，不动既有字段、不改任何写盘行为；
   *   · **切片完成 ≠ 分析完成**：`slices.count` 与 `complete_for_parsed_body` 分开给，
   *     面板据此分状态，不得由切片数推出「分析完成」；
   *   · **失败窗口必显**：逐窗列出 `failure_reason`（拿不到原因就写
   *     `UNKNOWN_FAILURE_REASON`，**不假装没有失败**）；
   *   · **不编百分比**：`whole_book_claim_allowed` / `whole_book_percent` 原样透出，
   *     未知部分永远存在（图片页/不可解析项未计数）⇒ 分母是「已解析正文」，不是全书。
   */
  function buildHonestReport(analysis, {
    candidates_built = null,
    candidates_skipped = [],
    run_id = null,
    persisted = false,
    is_recompute = false,
    revision = null,
    previous_revision = null,
    input_fingerprint_changed = null,
  } = {}) {
    const cov = analysis?.coverage !== null && typeof analysis?.coverage === "object" ? analysis.coverage : {};
    const windows = Array.isArray(analysis?.windows) ? analysis.windows : [];
    const slices = Array.isArray(analysis?.slices) ? analysis.slices : [];
    const engineCandidates = Array.isArray(analysis?.candidates) ? analysis.candidates : [];
    const failedRows = windows.filter((w) => w?.consumed !== true);
    const reasons = failedRows.map((w) => ({
      window_id: typeof w?.window_id === "string" ? w.window_id : null,
      section_id: typeof w?.section_id === "string" ? w.section_id : null,
      failure_reason: typeof w?.failure_reason === "string" && w.failure_reason !== ""
        ? w.failure_reason : "UNKNOWN_FAILURE_REASON",
      failure_detail: w?.failure_detail ?? null,
    }));
    const layers = analysis?.honesty?.layers !== null && typeof analysis?.honesty?.layers === "object"
      ? analysis.honesty.layers : {};
    const contiguity = windowsContiguity(windows);
    const int = (v) => (Number.isInteger(v) ? v : null);
    return {
      run_id,
      persisted,
      is_recompute,
      revision,
      previous_revision,
      input_fingerprint_changed,
      slices: { count: slices.length, note: "真消费过的窗口产出的代表切片条数（切片完成 ≠ 分析完成）" },
      candidates: {
        built: int(candidates_built),
        engine_candidates: engineCandidates.length,
        skipped: Array.isArray(candidates_skipped) ? candidates_skipped : [],
      },
      coverage: {
        scope: typeof cov.scope === "string" ? cov.scope : null,
        denominator_kind: "span_interval_union",
        denominator_note: "分母 = 已解析正文的连续窗口区间并集（重叠不重复计）；窗口由引擎自校验首尾相接",
        windows_non_overlapping: contiguity.ok,
        windows_contiguity_violations: contiguity.violations,
        total_units: int(cov.total_units),
        analyzed_units: int(cov.analyzed_units),
        failed_units: int(cov.failed_units),
        excluded_units: int(cov.excluded_units),
        covered_codepoints: int(cov.covered_codepoints),
        total_codepoints: int(cov.total_codepoints),
        unknown: cov.unknown !== null && typeof cov.unknown === "object" ? cov.unknown : null,
        whole_book_claim_allowed: cov.whole_book_claim_allowed === true,
        whole_book_percent: cov.whole_book_percent ?? null,
      },
      failed_windows: {
        count: reasons.length,
        queued: Array.isArray(analysis?.queue?.failed_window_ids) ? analysis.queue.failed_window_ids.length : null,
        reasons,
        retry_requires_explicit_schedule: analysis?.queue?.retry_requires_explicit_schedule === true,
      },
      complete_for_parsed_body: layers.analysis?.complete_for_parsed_body === true,
      layers: {
        extraction: layers.extraction ?? null,
        analysis: layers.analysis ?? null,
        reading: layers.reading ?? null,
      },
      honesty: {
        book_understood: { allowed: false, reason: "「已读懂」恒不可宣称（PRD :240）" },
        whole_book_claim_allowed: false,
        note: "本次只说明「分析产出的候选被排过序」；切片完成 ≠ 分析完成 ≠ 阅读完成，也都不等于「已读懂」。",
      },
    };
  }

  /**
   * 分析 → rank → **经 M1 file-service 事务**落盘一条 `recommendation_run` 笔记。
   *
   * 为什么必须走 `fileService().svc.writeNote`：`writeNote` 内部一律 `commit()` 一个事务，
   * 是 M1 提供的唯一写入口；直接 `fs.writeFile` 就是绕过事务（用户点名的反例）。
   * purpose 用 `update_note`（TRANSACTION_PURPOSES 里唯一贴合「写一条正式 Markdown」的通用项，
   * **不新增 purpose**，避免改动 M1 冻结的枚举）。
   */
  /**
   * 这本书的理解笔记**上一次由本服务写入**时的 bytes hash —— 从 M1 事务日志里取。
   *
   * 为什么不能只拿「本次调用开始时读到的 hash」当 `expectedHash`：
   * 那只挡得住「读 → 写」这一瞬间的并发改动。用户**在我们两次分析之间**手改了笔记，
   * 下次调用会读到新 hash 并**当作正常基线覆盖掉** —— 手改就白改了。
   * 要知道「盘上这份还是不是我们写的那份」，就得有「我们上次写进去的是什么 hash」的记录，
   * 而 M1 的 journal 里正好有（committed 事务的 `steps[].after_hash`，按 `updated_at` 取最新）。
   *
   * 查不到记录 ⇒ `known:false` ⇒ **不覆盖**（PRD :453：「无法判断身份时保留全部文件，
   * 阻止自动覆盖，提交人工处理」）。宁可挡住，也不拿用户的改动赌运气。
   */
  async function lastWrittenHashOf(svc, rel) {
    let txs = [];
    try {
      txs = await svc.listTransactions();
    } catch (e) {
      return { known: false, hash: null, why: `读事务日志失败：${e?.message ?? e}` };
    }
    let best = null;
    for (const t of Array.isArray(txs) ? txs : []) {
      if (!t || t.state !== "committed") continue;
      const at = String(t.updated_at ?? t.created_at ?? "");
      for (const st of Array.isArray(t.steps) ? t.steps : []) {
        if (!st || st.path !== rel || st.state !== "done" || typeof st.after_hash !== "string") continue;
        if (best === null || at > best.at) best = { at, hash: st.after_hash, tx: t.id };
      }
    }
    return best === null
      ? { known: false, hash: null, why: "事务日志里没有本服务写过这条笔记的记录" }
      : { known: true, hash: best.hash, tx: best.tx, at: best.at };
  }

  async function analyzeAndPersist(opts = {}) {
    const book = opts?.book;
    // 并发锁（阶段 2c）：见文件顶部 ANALYSES_IN_FLIGHT 的说明。
    const lockKey = typeof book === "string" && book.trim() !== "" ? book.trim() : null;
    if (lockKey !== null && ANALYSES_IN_FLIGHT.has(lockKey)) {
      return {
        ok: false,
        code: "ANALYSIS_IN_PROGRESS",
        message: "正在分析中：同一本书已有一次「切片与理解」在进行，请等它结束再试（本次不排队、不写盘）",
        in_flight_since: ANALYSES_IN_FLIGHT.get(lockKey),
        honest_report: null,
      };
    }
    if (lockKey !== null) ANALYSES_IN_FLIGHT.set(lockKey, new Date().toISOString());
    try {
      return await analyzeAndPersistInner(opts);
    } finally {
      if (lockKey !== null) ANALYSES_IN_FLIGHT.delete(lockKey);
    }
  }

  /**
   * 分析 → rank → **经 M1 file-service 事务**落盘**这一本书唯一的一条** `recommendation_run` 笔记。
   *
   * 为什么必须走 `fileService().svc.writeNote`：`writeNote` 内部一律 `commit()` 一个事务，
   * 是 M1 提供的唯一写入口；直接 `fs.writeFile` 就是绕过事务（用户点名的反例）。
   * purpose 用 `update_note`（TRANSACTION_PURPOSES 里唯一贴合「写一条正式 Markdown」的通用项，
   * **不新增 purpose**，避免改动 M1 冻结的枚举）。
   *
   * M10 阶段 2「一本书一个理解」的三条硬要求：
   *   · **2a** `run_id` 按书固定（`bookRunId`）⇒ 复算**覆盖同一条笔记**，`revision` 递增；
   *   · **2b** 覆盖必须带 `expectedHash` ⇒ 期间被外部改过就 `HASH_CONFLICT`，**绝不覆盖**，
   *     并如实告诉用户「这条笔记你改过，我没有覆盖」；
   *   · **2c** 不再有「同指纹 50 次」上限（身份不随指纹变，不需要找空位）；改为**并发锁**。
   */
  async function analyzeAndPersistInner({
    book,
    window_chars = null,
    sections = null,
    goal = null,
    reading_boundary = { mode: "whole_book" },
    job_id = null,
    prompt_template_version = "pt_m8",
    model = null,
    now: nowFn = null,
    analysis_transform = null,
    signal = null,
  } = {}) {
    const analyzed = await analyzeChapter({ book, window_chars, sections, signal });
    if (!analyzed.ok) return analyzed;
    const analysis = analysis_transform ? await analysis_transform(analyzed.analysis) : analyzed.analysis;
    signal?.throwIfAborted();

    const fs = await fileService();
    if (!fs.ok) return { ok: false, code: fs.code, message: fs.message };

    // M15 阶段 1：先把**真实证据**读出来（只读），R/G/T 只能由它推。
    // 读不到证据不是失败：第二层就是空的、`personalization_status=none`（如实）。
    const scan = await scanVault();
    const evidence = await collectEvidenceContext(fs, scan, { book_version_id: analysis.book_version_id });

    const candidateSet = candidatesFromAnalysis(analysis, { goal, evidence });
    const honestBase = buildHonestReport(analysis, {
      candidates_built: candidateSet.candidates.length,
      candidates_skipped: candidateSet.skipped,
    });
    if (candidateSet.candidates.length === 0) {
      return {
        ok: false,
        code: "NO_ELIGIBLE_CANDIDATES",
        message: "分析没有产出任何「有真消费切片」的候选 ⇒ 不落盘、不编造运行记录",
        skipped: candidateSet.skipped,
        queue: analysis.queue,
        honest_report: { ...honestBase, run_id: null, persisted: false, is_recompute: false },
      };
    }

    // 书的稳定身份：没有 `content_id`（内容摘要）就定不出「这本书的唯一理解」，**不猜、不落盘**。
    if (typeof analysis.content_id !== "string" || analysis.content_id.trim() === "") {
      return {
        ok: false,
        code: "BOOK_IDENTITY_MISSING",
        message: "引擎没有给出 content_id（内容身份）⇒ 定不出这本书唯一的理解身份（不落盘、不猜）",
        honest_report: { ...honestBase, run_id: null, persisted: false, is_recompute: false },
      };
    }

    const probeRequest = buildRankRequestFromAnalysis(analysis, { run_id: "rr_probe", goal, reading_boundary,
      candidates: candidateSet.candidates, evidence });
    const fingerprint = recommendationInputFingerprint(probeRequest);

    // 运行身份**按书的内容固定**（M10 阶段 2a + M13）：同一本书 ⇒ 同一个 run_id ⇒ 同一条笔记；
    // 书挪位置/改名 ⇒ 内容身份不变 ⇒ 还是同一条（这是 M13 换地基的落点）。
    const runId = bookRunId({ book_version_id: analysis.book_version_id });
    const rel = `${RUN_NOTE_DIR}/${runId}.md`;

    // 先读既有笔记：既决定「首次 / 复算」，也拿到覆盖时要用的 `expectedHash`（阶段 2b）。
    // 读失败时**不敢覆盖**（状态不明就写盘 = 拿用户的改动赌运气）。
    let previous = null;
    try {
      const got = await fs.svc.readNote(rel);
      // 「文件存在但解析不了」≠「文件不存在」。前者绝不能当成「这本书还没写过理解」：
      // 那会按新文件重算（revision 从 1 开始）⇒ 幂等键 recommendation_run:<id>:rev1 与上次撞车
      // （IDEMPOTENCY_CONFLICT），真写下去还会覆盖掉一份读不懂的旧内容。明确拒绝，并点名文件与错在哪。
      if (got.exists && got.errors?.length) {
        return {
          ok: false,
          code: "EXISTING_NOTE_UNPARSEABLE",
          message: `目标笔记 ${rel} 已存在但 frontmatter 解析不了（`
            + `${got.errors.map((x) => x.message || x.code).join("; ")}）：`
            + "状态不明时不按新文件覆盖，请先修好这条笔记的 YAML 再重算",
          note_rel: rel,
          errors: got.errors,
          run_id: runId,
          honest_report: { ...honestBase, run_id: runId, persisted: false, is_recompute: true,
            revision: null, previous_revision: null },
        };
      }
      if (got.exists) previous = { rel, data: got.data, hash: got.hash };
    } catch (e) {
      return {
        ok: false,
        code: e?.code ?? "RUN_NOTE_UNREADABLE",
        message: `读既有理解笔记失败（状态不明时不覆盖）：${e?.message ?? e}`,
        run_id: runId,
        honest_report: { ...honestBase, run_id: runId, persisted: false, is_recompute: false },
      };
    }
    const isRecompute = previous !== null;
    const previousRevision = Number.isInteger(previous?.data?.revision) ? previous.data.revision : null;
    const revision = nextRevision(previous?.data);
    const request = { ...probeRequest, run_id: runId };

    // 阶段 2b：**手改保护**。复算要覆盖的是「同一本书唯一的那条理解」，
    // 覆盖前必须确认盘上这份还是我们上次写的那份；不是 ⇒ 一律 HASH_CONFLICT，不覆盖。
    let manualEditCheck = null;
    if (isRecompute) {
      const last = await lastWrittenHashOf(fs.svc, rel);
      if (!last.known) {
        manualEditCheck = "no_record";
        return {
          ok: false,
          code: "HASH_CONFLICT",
          message: `这条笔记不是本服务写的（或事务记录已不可考：${last.why}），我没有覆盖：`
            + "无法判断它是不是你的手改内容，按「无法判断身份时阻止自动覆盖」处理",
          run_id: runId,
          revision: previousRevision,
          honest_report: { ...honestBase, run_id: runId, persisted: false, is_recompute: true,
            revision, previous_revision: previousRevision, manual_edit_check: manualEditCheck },
        };
      }
      if (last.hash !== previous.hash) {
        manualEditCheck = "mismatch";
        return {
          ok: false,
          code: "HASH_CONFLICT",
          message: "这条笔记你改过，我没有覆盖：盘上的内容与上次写进去的不一致，"
            + "请先确认你的手改（本阶段没有「强制覆盖」开关，要重算请先把手改内容并入或还原）",
          run_id: runId,
          revision: previousRevision,
          honest_report: { ...honestBase, run_id: runId, persisted: false, is_recompute: true,
            revision, previous_revision: previousRevision, manual_edit_check: manualEditCheck },
        };
      }
      manualEditCheck = "match";
    }

    const caps = capabilities();
    const policy = new RecommendationPolicy();
    let result;
    try {
      result = await policy.rank(request, caps.policy);
    } catch (e) {
      return {
        ok: false,
        code: e?.code ?? "RANK_FAILED",
        message: String(e?.message || e),
        work_job_state: e?.work_job_state ?? "failed",
        run_id: runId,
        honest_report: { ...honestBase, run_id: runId, persisted: false, is_recompute: isRecompute,
          revision, previous_revision: previousRevision },
      };
    }

    if(analysis.generated && result.book_guide){
      result.book_guide.overview_paragraphs=analysis.generated.overview_paragraphs.map(p=>p.text);
      result.book_guide.source_refs=[...new Set(analysis.generated.overview_paragraphs.flatMap(p=>p.source_refs))];
      result.book_guide.coverage_scope.section_ids=analysis.generated.coverage.body_sections;
    }
    signal?.throwIfAborted();
    const iso = nowFn ? nowFn() : now().toISOString();
    const run = mapRecommendationResultToRun(result, {
      run_id: runId,
      job_id: job_id ?? `job_${runId}`,
      book_version_id: analysis.book_version_id,
      input_fingerprint: fingerprint,
      input_manifest_refs: buildInputManifestRefs(request),
      candidate_set_version: candidateSet.candidate_set_version,
      prompt_template_version: analysis.generated ? analysis.generated.version+":"+analysis.generated.generation_id : prompt_template_version,
      model: analysis.generated?.model ?? model ?? "extractive-analysis",
      state: "ready",
    });
    const note = buildRecommendationRunNote(run, {
      dedup_check_ref: `dedup_${analysis.content_id}`,
      revision,
      now: iso,
    });
    if (!note.ok) {
      return {
        ok: false,
        code: "RUN_NOTE_INVALID",
        message: "run 笔记未过 M1 formal 校验",
        errors: note.errors,
        run_id: runId,
        honest_report: { ...honestBase, run_id: runId, persisted: false, is_recompute: isRecompute,
          revision, previous_revision: previousRevision },
      };
    }

    let tx;
    try {
      tx = await writeNoteFresh(fs.svc, rel, {
        data: note.data,
        body: recommendationNoteBody({result, generated: analysis.generated, bookTitle: analysis.book, revision}),
        // 2b：复算**必须**带上「我上次读到的 hash」⇒ 期间被外部改过就 HASH_CONFLICT，不覆盖。
        expectedHash: isRecompute ? previous.hash : null,
        // 幂等键按 revision 区分：同键同体才算重放；同键异体会被 M1 判 IDEMPOTENCY_CONFLICT。
        // 若沿用 `recommendation_run:${runId}`，第二次复算内容不同就会被判「同键异体」而写不进去。
        idempotencyKey: `recommendation_run:${runId}:rev${revision}`,
        purpose: "update_note",
      });
    } catch (e) {
      const code = e?.code ?? "PERSIST_FAILED";
      const manualEdit = code === "HASH_CONFLICT";
      return {
        ok: false,
        code,
        message: manualEdit
          ? (isRecompute
            ? "这条笔记你改过，我没有覆盖：盘上的内容与上次读到的 hash 不一致，请先确认你的手改，再决定是否重算"
            : "这条笔记在我们写入前被创建或改过，我没有覆盖：请先确认盘上内容")
          : `经 file-service 落盘失败：${e?.message ?? e}`,
        run_id: runId,
        revision,
        honest_report: { ...honestBase, run_id: runId, persisted: false, is_recompute: isRecompute,
          revision, previous_revision: previousRevision, manual_edit_detected: manualEdit },
      };
    }

    // 刚写完盘：立刻作废只读投影的扫描缓存，否则读回来还是旧状态（见 invalidateScanCache 注释）。
    invalidateScanCache();

    // F4（4a/4b）：补齐 run 笔记引用的 book_version / coverage —— 让 input_manifest_refs 不悬空。
    // 派生物失败不回滚 run 笔记，但必须如实报出（见 writeVaultIntegrity 注释）。
    const vaultIntegrity = await writeVaultIntegrity(fs, analysis, runId, iso);
    invalidateScanCache();   // 又写了盘（book 笔记/账本）⇒ 再作废一次

    const fingerprintChanged = isRecompute ? previous.data.input_fingerprint !== fingerprint : null;
    return {
      ok: true,
      run_id: runId,
      note_rel: rel,
      revision,
      previous_revision: previousRevision,
      is_recompute: isRecompute,
      transaction: { id: tx.id, state: tx.state, steps: tx.steps, replayed: tx.replayed ?? false },
      input_fingerprint: fingerprint,
      input_fingerprint_changed: fingerprintChanged,
      analysis_summary: {
        book: analysis.book,
        book_version_id: analysis.book_version_id,
        chapters: (analysis.chapters ?? []).length,
        windows_total: analysis.coverage?.total_units ?? null,
        windows_consumed: analysis.coverage?.analyzed_units ?? null,
        windows_failed: analysis.coverage?.failed_units ?? null,
        candidates_built: candidateSet.candidates.length,
        candidates_skipped: candidateSet.skipped,
        failed_windows_queued: analysis.queue?.failed_window_ids?.length ?? null,
      },
      result_outcome: result.outcome,
      /** F4：书籍信息笔记 + 覆盖账本的真实结果（失败也在这里如实列出，不吞掉）。 */
      vault_integrity: vaultIntegrity,
      honest_report: {
        ...honestBase,
        run_id: runId,
        persisted: true,
        is_recompute: isRecompute,
        revision,
        previous_revision: previousRevision,
        input_fingerprint_changed: fingerprintChanged,
        manual_edit_check: manualEditCheck,
      },
      honesty: {
        book_understood: { allowed: false, reason: "「已读懂」恒不可宣称" },
        whole_book_claim_allowed: false,
        note: "本次落盘只说明「分析产出的候选被排过序」，不代表读懂了全书",
      },
    };
  }

  // ----------------------------------------------------------------------- //
  // 调用面：rank / compile（真宿主 capabilities 注入）
  // ----------------------------------------------------------------------- //

  async function rank(request) {
    const caps = capabilities();
    const policy = new RecommendationPolicy();
    const result = await policy.rank(request, caps.policy);
    return { result, capabilities: caps.report };
  }

  async function compile(request) {
    const caps = capabilities();
    const compiler = new KnowledgeCompiler();
    const result = await compiler.propose(request, caps.compiler);
    return { result, capabilities: caps.report };
  }

  // ----------------------------------------------------------------------- //
  // 提示词摘要（预算内）
  // ----------------------------------------------------------------------- //

  /**
   * 给 systemPrompt 的「已保存知识/覆盖/推荐」短摘要。
   *
   * 纪律：**少而准**。不放完整会话、不放 prompt、不放正文；只放计数与状态，
   * 且一定截到 `PROMPT_SUMMARY_MAX_CHARS` 以内。读不到就如实说读不到。
   */
  async function promptSummary() {
    const dir = bookKbDir();
    const fs = await fileService();
    if (!fs.ok) {
      return trim(`【已保存的阅读知识】读不到书籍知识库（${fs.code}）：${fs.message}。不要凭印象说用户读过什么。`);
    }
    const scan = await scanVault();
    const zones = await indexZones();
    // 只报**正式有效**的计数：不合格条目单独说，绝不混进来当「已保存的知识」。
    const by = scan.by_object_type_formal ?? {};
    const parts = [];
    const formalTotal = Object.values(by).reduce((a, b) => a + b, 0);
    parts.push(`【已保存的阅读知识】知识库《${dir.path}》内正式有效条目 ${formalTotal} 个`
      + `（书籍 ${by.book ?? 0} · 全书概括 ${by.book_summary ?? 0} · 章节概括 ${by.chapter_summary ?? 0}`
      + ` · 理解变化 ${by.understanding_observation ?? 0} · 疑问 ${by.question ?? 0}`
      + ` · 推荐运行 ${by.recommendation_run ?? 0} · 提案 ${by.change_proposal ?? 0}）。`);
    const invalidCount = scan.notes.filter((n) => n.formal_valid !== true).length;
    if (invalidCount > 0 || (scan.parse_failures?.length ?? 0) > 0) {
      parts.push(`另有 ${scan.parse_failures.length} 个解析失败、${invalidCount} 个 formal 校验未过：`
        + "这些**不计入**上面的数字，也不要当成 0。");
    }
    parts.push("覆盖：45-书籍/ 内没有覆盖单元记录，因此**覆盖情况未知**，不要声称读懂了某本书或全书进度。");
    if ((by.recommendation_run ?? 0) === 0) parts.push("推荐：尚无已保存的推荐运行。");
    if ((by.book ?? 0) === 0) parts.push("书库为空：没有可推荐的章节，不要虚构书名或章节。");
    if (zones.ok && !zones.writable) parts.push(`索引六区标记异常（${(zones.problems ?? []).map((p) => p.code).join(",")}）：索引已停止自动写入，不要声称已更新索引。`);
    parts.push("以上只是**已保存的阅读知识计数**；用户当前读什么、划了什么，以下面的伴读上下文为准。");
    return trim(parts.join(""));
  }

  function trim(text) {
    return trimToBudget(text, PROMPT_SUMMARY_MAX_CHARS);
  }

  /**
   * 提示词摘要的**同步**读法。
   *
   * 为什么必须同步：宿主 `systemPrompt.context({text})` 只在渲染时**同步**调用
   * （`dsh-system-prompt/lib/index.js:350` `typeof entry.text === "function" ? entry.text(context) : entry.text`），
   * 传 async 函数会拿到一个 Promise 当正文。所以这里缓存最近一次算好的文本，
   * 由 `refreshPromptSummary()`（异步）在装载时与每次 reading 路由命中后刷新。
   */
  function promptSummaryCached() {
    return cache.promptSummary ?? "";
  }

  async function refreshPromptSummary({ force = false } = {}) {
    const t = now().getTime();
    if (!force && cache.promptSummary && t - (cache.promptSummaryAt ?? 0) < PROMPT_SUMMARY_REFRESH_MS) {
      return cache.promptSummary;
    }
    try {
      cache.promptSummary = await promptSummary();
    } catch (e) {
      cache.promptSummary = trim(`【已保存的阅读知识】读取失败（${String(e?.message || e).slice(0, 120)}）：不要凭印象说用户读过什么。`);
    }
    cache.promptSummaryAt = t;
    return cache.promptSummary;
  }

  return {
    runtime_version: RUNTIME_VERSION,
    bookKbDir,
    fileService,
    sessionReader,
    capabilities,
    scanVault,
    indexZones,
    library,
    coverage,
    recommendations,
    understandingStatus,
    proposals,
    maintenance,
    health,
    rank,
    compile,
    analyzeChapter,
    candidatesFromAnalysis,
    buildRankRequestFromAnalysis,
    buildHonestReport,
    windowsContiguity,
    analyzeAndPersist,
    recordEvidence,
    confirmObservation,
    evidenceNotes,
    promptSummary,
    promptSummaryCached,
    refreshPromptSummary,
    invalidateScanCache,
    _cache: cache,
  };
}
