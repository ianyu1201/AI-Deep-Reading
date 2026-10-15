/**
 * tests/reading-compiler.test.mjs · M4 知识编译器 / compiler.js
 *
 * ## 这份测试在防什么
 * 编译器最容易出的不是崩溃，而是**看起来很对却违反归属与来源的提案**：
 *   · 顶层 `compiler` 未知时用占位符蒙过去（PRD :472「未知时阻止生成可接受提案」）
 *   · `generated_by` 与顶层 `compiler` **键名混用**（`:481`）
 *   · `compiler_metadata` 里混进 `generated_by`
 *   · **模型自选 `authorized_auto`**（`:472` 明令由提交器决定）
 *   · AI 猜测被写成 `origin=user`，或用户确认 AI 假设后 origin 被改
 *   · 模型自报 `confirmed` / 自带 `confirmation_evidence`
 *   · 来源不可用 / 核对失败 / 格式错误被**伪装成 `no_change`**（`:966` 明令禁止）
 *   · 无会话材料却**虚构宿主轮次**、或推进 session cursor（`:981`）
 *   · 压缩摘要（compact-checkpoint）被当成证据
 *   · 快照 hash 被当成内容核对（「hash 不替代内容核对」）
 *   · M3 coverage 的 `blocked_reason` 被绕过，对不可推进单元生成提案
 *
 * ## 每条检查「在什么情况下会失败」
 *   [0]  模块形状/闭合词表  — request/result/capabilities 键集合偏离 PRD 就失败
 *   [1]  三键分离           — 顶层 compiler 与 generated_by 键名/形状/省略规则被破坏就失败
 *   [2]  幂等键             — 幂等键不再取 compiler.version 就失败
 *   [3]  request 形状       — 出现 application_mode 等走私字段不被拒就失败
 *   [4]  capabilities       — 缺能力时不报 HOST_UNSUPPORTED（或伪造成 no_change）就失败
 *   [5]  会话门槛           — 无会话却带轮次/耐久范围，或有会话却用 null 绕过就失败
 *   [6]  有效轮次           — 未核验片段/非 current 无身份用途/摘要当证据不被挡就失败
 *   [7]  覆盖门槛（M3）      — 不可推进单元仍能生成提案、或缺 coverage 快照不报错就失败
 *   [8]  查重门槛           — read_error/partial 不挡、matched 不精确读取、hash 冲突不记就失败
 *   [9]  归属三分离         — 模型声明 confirmed、AI 变 user、无真人来源称 user 不被拒就失败
 *   [10] operation 规则     — create 带 base_hash/目标已存在、update 无实读 hash、link 出 45 不被拒就失败
 *   [11] outcome/job 映射   — 错误被映射成 no_change、或自动路径未 accepted 就报已保存就失败
 *   [12] 提案组装与自检     — 未过 M1 validateNote、或给索引补造 generated_by 就失败
 *   [13] no_change 回执     — 回执缺 check/来源范围、或带正文就失败
 *   [14] authorized_auto    — 提交器校验放行假授权/非新建/scope 越权就失败
 *   [15] cursor 守卫        — 编译器产出 cursor 推进就失败
 *   [16] 替身忠实性元检查    — 替身一旦退化（自报快照、发明 hash、直接放行草稿）必须被识破
 *   [17] 只读与依赖闭包     — 模块引入 fs/宿主依赖、或新增导入就失败
 *   [18] 无法离线验证       — 显式跳过（三分处理），不算通过
 *
 * 跑法：node tests/reading-compiler.test.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * 被测模块路径可用环境变量覆盖：变异测试把「改坏的副本」写到临时目录，
 * 连同 schema.js / coverage.js 一起放进去（保持相对 import 可解析），
 * **绝不改动仓库里的真文件**。
 */
const COMPILER_PATH = process.env.READING_COMPILER ?? join(HERE, "..", "lib", "reading", "compiler.js");

const C = await import(pathToFileURL(COMPILER_PATH).href);
const {
  COMPILER_NAME,
  COMPILER_VERSION,
  COMPILE_OUTCOMES,
  REQUEST_KEYS,
  CAPABILITY_KEYS,
  COMPILER_METADATA_KEYS,
  GENERATED_BY_KEYS,
  COMPILE_RESULT_KEYS,
  SURFACE_CLASSES,
  NON_EVIDENCE_SOURCE_KINDS,
  SNAPSHOT_PRODUCER,
  DEFAULT_SUMMARY_BUDGET,
  COMPILER_APPLICATION_MODE,
  READING_ROOT,
  CURSOR_EFFECT,
  CompilerError,
  validateCompilerMetadata,
  compilerMetadataToTopLevel,
  resolveGeneratedBy,
  compilerIdempotencyKey,
  validateCompileRequest,
  checkCapabilities,
  checkDurabilityRange,
  checkSessionGate,
  checkEffectiveTurn,
  analyzableRanges,
  runDedupGate,
  validateAttribution,
  compileOperation,
  canonicalSourceRange,
  buildChangeProposal,
  buildNoChangeReceipt,
  validateAuthorizedAuto,
  mapCompileResultToJob,
  mapErrorToJob,
  compileCursorEffect,
  KnowledgeCompiler,
  propose,
} = C;

/** 测试自己的 schema 引用（不参与变异）：用于独立复验提案是否真的过了 M1 校验。 */
const { validateNote, validateNoChangeReceipt } = await import(
  pathToFileURL(join(HERE, "..", "lib", "reading", "schema.js")).href
);
const { BOOK_DOMAIN, OBJECT_TYPES, SEMANTIC_OBJECT_TYPES } = await import(
  pathToFileURL(join(HERE, "..", "lib", "reading", "book-domain.js")).href
);

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

/** 「必须抛指定错误码（且 work_job_state 正确）」的显式断言。 */
async function expectCode(label, fn, code, { state = null } = {}) {
  try {
    await fn();
    bad(label, `本应抛 ${code}，却成功了`);
  } catch (e) {
    if (e instanceof CompilerError && e.code === code) {
      if (state !== null && e.work_job_state !== state) {
        bad(label, `work_job_state=${e.work_job_state}，期望 ${state}`);
      } else {
        ok(`${label} → ${code}${state ? ` (${state})` : ""}`);
      }
    } else {
      bad(label, `抛的是 ${e?.code ?? e?.name}（${e?.message}），期望 ${code}`);
    }
  }
}

// =========================================================================== //
// 夹具
// =========================================================================== //
const H = (ch) => ch.repeat(64);

function mkSpan(over = {}) {
  return {
    book_id: "book_1",
    book_version_id: "bv_1",
    section_id: "sec_1",
    block_id: "blk_1",
    span_id: "sp_1",
    href: "text/ch1.xhtml",
    start_codepoint: 0,
    end_codepoint: 100,
    text_hash: H("a"),
    locator_quality: "exact_normalized_text",
    quote_type: "verbatim",
    ...over,
  };
}

function mkCoverage({ units = null, source = null, watermark = null, requested_through_seq = null } = {}) {
  return {
    units: units ?? [{ unit_id: "u_1", state: "processed", section_id: "sec_1", start_codepoint: 0, end_codepoint: 100 }],
    source: source ?? { source_gate: { state: "ready", requested_through_seq: 0 }, source_revision: "bv_1" },
    watermark,
    requested_through_seq,
  };
}

function mkExternalMaster(over = {}) {
  return {
    status: "unverified",
    outcome: "not_checked",
    check_id: null,
    scope_refs: [],
    checked_at: null,
    authorization_revision: null,
    candidate_refs: [],
    ref: null,
    ...over,
  };
}

function mkDedup(over = {}) {
  return {
    check_id: "chk_1",
    input_fingerprint: H("c"),
    authorization_revision: null,
    local_result: "no_match",
    candidate_refs: [],
    external_master: mkExternalMaster(),
    ...over,
  };
}

function mkRequest(over = {}) {
  const base = {
    schema_version: "1.1",
    job_id: "job_1",
    host_source_refs: [],
    verified_durability_range: null,
    effective_turns_in_memory: [],
    relevant_book_spans: [mkSpan()],
    dedup_check: mkDedup(),
    current_note_snapshots_and_hashes: [],
    consent_scope: { scope_id: "scope_1", can_write: true, allowed_object_types: null },
    summary_budget: { max_operations: 5, max_short_content_chars: 200 },
    compiler_config: { coverage: mkCoverage() },
  };
  const merged = { ...base, ...over };
  if (over.compiler_config) merged.compiler_config = over.compiler_config;
  return merged;
}

function mkTurn(over = {}) {
  return {
    verified: true,
    host: "dsh",
    session_id: "session_1",
    branch_id: "session_1",
    source_revision: "jsonl:dev=1,ino=2,size=3,mtime=4",
    event_seq: 7,
    turn: 3,
    message_source_kind: "user",
    surface_class: "current",
    availability: "available",
    ...over,
  };
}

function mkRange(over = {}) {
  return {
    verified: true,
    session_id: "session_1",
    branch_id: "session_1",
    source_revision: "jsonl:dev=1,ino=2,size=3,mtime=4",
    from_seq: 0,
    through_seq: 9,
    ...over,
  };
}

function mkSnapshot(over = {}) {
  return {
    object_id: "note_1",
    relative_path: "45-书籍/概念/示例.md",
    content_hash: H("b"),
    check_id: "chk_1",
    produced_by: SNAPSHOT_PRODUCER,
    ...over,
  };
}

function mkOp(over = {}) {
  return {
    type: "create",
    object_type: "insight",
    target_object_id: "ins_1",
    base_hash: null,
    short_content: "笛卡尔把普遍怀疑当作确立不可怀疑出发点的步骤。",
    origin: "book_author",
    confirmation: "unconfirmed",
    book_evidence: [{ source_kind: "book_span", ref: mkSpan() }],
    session_evidence: [],
    source_refs: [{ source_kind: "book_span", ref: mkSpan() }],
    external_master: mkExternalMaster(),
    matched_object_ids: [],
    ...over,
  };
}

/**
 * 忠实的能力替身。
 *
 * 语义按 PRD/宿主真实行为复刻，**自带元检查所需的可观测性**（调用记录 + `mode:"unfaithful"`）。
 * 关键点：`generateStructured` 原样返回调用方给的草稿 —— 这样「编译器拒了草稿」一定是
 * 编译器的校验在起作用，而不是替身提前改了数据。
 */
function makeHost({
  mode = "faithful",
  spans = null,
  notes = null,
  turns = { ok: true, turns: [] },
  draft = { outcome: "no_change", reason: "无新证据" },
  omit = [],
  throwOn = {},
} = {}) {
  const spanMap = spans ?? { sp_1: { ok: true, span_id: "sp_1", text_hash: H("a") } };
  const noteMap = notes ?? {};
  const calls = { readSourceSpan: [], readCheckedNote: [], requestAdditionalCandidates: [], readHostTurns: [], generateStructured: [] };

  const host = {
    async readSourceSpan(id) {
      calls.readSourceSpan.push(id);
      if (throwOn.readSourceSpan) throw new Error("boom");
      // 忠实：未知 span 一律 unavailable，**不发明** hash。
      return spanMap[id] ?? { ok: false, availability: "unavailable", span_id: id };
    },
    async readCheckedNote(checkId, candidateId) {
      calls.readCheckedNote.push([checkId, candidateId]);
      if (throwOn.readCheckedNote) throw new Error("boom");
      const n = noteMap[candidateId];
      if (!n) return { ok: false, code: "READ_ERROR" };
      if (mode === "unfaithful") {
        // ⛔ 不忠实替身：返回与声明**不同**的 hash（真实服务会返回实读 hash）。
        return { ok: true, object_id: n.object_id, relative_path: n.relative_path, content_hash: H("f") };
      }
      return { ok: true, object_id: n.object_id, relative_path: n.relative_path, content_hash: n.content_hash };
    },
    async requestAdditionalCandidates(checkId, query) {
      calls.requestAdditionalCandidates.push([checkId, query]);
      return { ok: true, check_id: checkId };
    },
    async readHostTurns(refs) {
      calls.readHostTurns.push(refs);
      if (throwOn.readHostTurns) throw new Error("boom");
      return turns;
    },
    async generateStructured(spec) {
      calls.generateStructured.push(spec);
      if (throwOn.generateStructured) throw new Error("boom");
      return draft;
    },
  };
  for (const k of omit) delete host[k];
  host.__calls = calls;
  return host;
}

const compiler = () => new KnowledgeCompiler({ now: "2026-10-10T12:00:00Z" });

// =========================================================================== //
console.log("\n[0] 模块形状与闭合词表");

is("COMPILER_NAME 是真实非空字符串", typeof COMPILER_NAME === "string" && COMPILER_NAME.trim() !== "", true);
is("COMPILER_VERSION 是真实非空字符串", typeof COMPILER_VERSION === "string" && COMPILER_VERSION.trim() !== "", true);
deep("outcome 值域恰好 no_change|proposal（PRD :950）", [...COMPILE_OUTCOMES], ["no_change", "proposal"]);
deep("request 键集合恰好 PRD :939 的 11 个", [...REQUEST_KEYS], [
  "schema_version", "job_id", "host_source_refs", "verified_durability_range",
  "effective_turns_in_memory", "relevant_book_spans", "dedup_check",
  "current_note_snapshots_and_hashes", "consent_scope", "summary_budget", "compiler_config",
]);
deep("capabilities 恰好 PRD :945 的 5 项", [...CAPABILITY_KEYS], [
  "readSourceSpan", "readCheckedNote", "requestAdditionalCandidates", "readHostTurns", "generateStructured",
]);
deep("CompileResult 顶层键恰好 PRD :950 的 6 个", [...COMPILE_RESULT_KEYS], [
  "outcome", "operations", "dedup_check_ref", "conflicts", "uncertainties", "compiler_metadata",
]);
deep("顶层 compiler 子字段是 {name,version}（不是 generated_by 的键）", [...COMPILER_METADATA_KEYS], ["name", "version"]);
deep("generated_by 子字段是 {compiler,version}（与顶层 compiler 键名不同）", [...GENERATED_BY_KEYS], ["compiler", "version"]);
deep("surface_class 值域", [...SURFACE_CLASSES], ["current", "shadowed", "log-only"]);
deep("摘要类来源只含 compact-checkpoint", [...NON_EVIDENCE_SOURCE_KINDS], ["compact-checkpoint"]);
is("编译器默认应用模式恒为 manual", COMPILER_APPLICATION_MODE, "manual");
is("45 区前缀", READING_ROOT, "45-书籍/");
is("cursor 效果：永不推进", CURSOR_EFFECT.advanced, false);
is("默认预算有界", DEFAULT_SUMMARY_BUDGET.max_operations > 0 && DEFAULT_SUMMARY_BUDGET.max_short_content_chars > 0, true);

// =========================================================================== //
console.log("\n[1] 三键分离：compiler_metadata / 顶层 compiler / generated_by");

{
  const good = validateCompilerMetadata({ name: "c", version: "1" });
  truthy("合法 compiler_metadata 通过", good.ok);
  deep("校验后**只**保留 {name,version}", good.value, { name: "c", version: "1" });

  const tpl = validateCompilerMetadata({ name: null, version: null });
  falsy("模板占位 {name:null,version:null} **不通过**（未知时阻止生成可接受提案）", tpl.ok);
  is("未知身份的失败码是 COMPILER_IDENTITY_UNKNOWN", tpl.errors[0].code, "COMPILER_IDENTITY_UNKNOWN");

  const half = validateCompilerMetadata({ name: "c", version: null });
  falsy("半填 {name:'c',version:null} 不通过", half.ok);

  const empty = validateCompilerMetadata({ name: "  ", version: "1" });
  falsy("空串 name 不通过", empty.ok);

  const scalar = validateCompilerMetadata("c@1");
  falsy("标量不接受", scalar.ok);

  const mixed = validateCompilerMetadata({ compiler: "c", version: "1" });
  falsy("键名混用（generated_by 的键）不通过", mixed.ok);
  is("键名混用的失败码仍是身份未知", mixed.errors[0].code, "INVALID_STRUCTURE");

  const extra = validateCompilerMetadata({ name: "c", version: "1", generated_by: { compiler: "x", version: "y" } });
  falsy("compiler_metadata 里混入 generated_by 不通过", extra.ok);

  // 映射：只取 {name,version}
  deep("compilerMetadataToTopLevel 只产出 {name,version}", compilerMetadataToTopLevel({ name: "c", version: "1" }), { name: "c", version: "1" });
  const top = compilerMetadataToTopLevel({ name: "c", version: "1" });
  deep("顶层 compiler 的键集合**恰好**两个", Object.keys(top).sort(), ["name", "version"]);
  await expectCode("未知身份映射到顶层 compiler 必须抛错（不是填占位符）",
    () => compilerMetadataToTopLevel({ name: null, version: null }), "COMPILER_IDENTITY_UNKNOWN", { state: "failed" });

  // generated_by
  is("索引没有 generated_by ⇒ 返回 undefined（不补造）", resolveGeneratedBy({}), undefined);
  is("索引里 generated_by=null ⇒ 省略整个字段", resolveGeneratedBy({ generated_by: null }), undefined);
  deep("工具生成且真实提供 ⇒ {compiler,version}", resolveGeneratedBy({ generated_by: { compiler: "obsidian", version: "1.5" } }),
    { compiler: "obsidian", version: "1.5" });
  const gbKeys = Object.keys(resolveGeneratedBy({ generated_by: { compiler: "x", version: "y" } })).sort();
  deep("generated_by 的键是 {compiler,version}，**不是** {name,version}", gbKeys, ["compiler", "version"]);
  isNot("generated_by 的键名不等于顶层 compiler 的键名",
    JSON.stringify(gbKeys), JSON.stringify([...COMPILER_METADATA_KEYS].sort()));
  await expectCode("generated_by 写成 {name,version}（键名混用）必须抛错",
    () => resolveGeneratedBy({ generated_by: { name: "x", version: "y" } }), "INVALID_GENERATED_BY", { state: "failed" });
  await expectCode("generated_by 半填必须抛错",
    () => resolveGeneratedBy({ generated_by: { compiler: "x", version: null } }), "INVALID_GENERATED_BY");
  await expectCode("generated_by 是标量必须抛错",
    () => resolveGeneratedBy({ generated_by: "x@1" }), "INVALID_GENERATED_BY");
  await expectCode("generated_by 是空串必须抛错",
    () => resolveGeneratedBy({ generated_by: { compiler: "", version: "1" } }), "INVALID_GENERATED_BY");
}

// =========================================================================== //
console.log("\n[2] 幂等键取其 version（PRD :472）");

{
  const meta = { name: "c", version: "1.0.0" };
  const fp = H("c");
  const k1 = compilerIdempotencyKey(meta, fp);
  const k2 = compilerIdempotencyKey(meta, fp);
  is("同版本同输入 ⇒ 同幂等键（可安全重放）", k1, k2);
  is("幂等键是 64 位十六进制", /^[0-9a-f]{64}$/.test(k1), true);
  const k3 = compilerIdempotencyKey({ name: "c", version: "1.0.1" }, fp);
  isNot("编译器版本变化 ⇒ 幂等键变化（不是同一个提案的重放）", k3, k1);
  const k4 = compilerIdempotencyKey(meta, H("d"));
  isNot("输入指纹变化 ⇒ 幂等键变化", k4, k1);
  await expectCode("身份未知时无法取幂等键",
    () => compilerIdempotencyKey({ name: null, version: null }, fp), "COMPILER_IDENTITY_UNKNOWN");
}

// =========================================================================== //
console.log("\n[3] request 形状：键集合闭合，模型不得走私 application_mode");

{
  const r = validateCompileRequest(mkRequest());
  truthy("合法 request 通过", r.ok);
  for (const k of REQUEST_KEYS) {
    const req = mkRequest();
    delete req[k];
    falsy(`缺少 ${k} 被拒`, validateCompileRequest(req).ok);
  }
  const smuggle = mkRequest({ application_mode: "authorized_auto" });
  const sr = validateCompileRequest(smuggle);
  falsy("request 里出现 application_mode 被拒", sr.ok);
  is("走私字段的失败码是 UNEXPECTED_FIELD", sr.errors.find((e) => e.field === "application_mode")?.code, "UNEXPECTED_FIELD");
  falsy("request 里出现 authorization_ref 被拒", validateCompileRequest(mkRequest({ authorization_ref: { actor: "x" } })).ok);
  falsy("schema_version 不匹配被拒", validateCompileRequest(mkRequest({ schema_version: "1.0" })).ok);
  falsy("job_id 空被拒", validateCompileRequest(mkRequest({ job_id: "" })).ok);
  falsy("host_source_refs 非数组被拒", validateCompileRequest(mkRequest({ host_source_refs: {} })).ok);

  await expectCode("propose 遇到走私字段抛 INVALID_REQUEST（failed，不是 no_change）",
    () => compiler().propose(mkRequest({ application_mode: "authorized_auto" }), makeHost()),
    "INVALID_REQUEST", { state: "failed" });
}

// =========================================================================== //
console.log("\n[4] capabilities：5 项齐备，缺一项即失败（不伪装 no_change）");

{
  truthy("完整替身通过", checkCapabilities(makeHost()).ok);
  for (const k of CAPABILITY_KEYS) {
    const r = checkCapabilities(makeHost({ omit: [k] }));
    falsy(`缺 ${k} 被拒`, r.ok);
    is(`缺 ${k} 的失败码是 HOST_UNSUPPORTED`, r.errors[0].code, "HOST_UNSUPPORTED");
  }
  falsy("capabilities 不是映射被拒", checkCapabilities(null).ok);
  await expectCode("缺能力时 propose 抛 HOST_UNSUPPORTED（failed）",
    () => compiler().propose(mkRequest(), makeHost({ omit: ["generateStructured"] })),
    "HOST_UNSUPPORTED", { state: "failed" });
  // 反证：缺能力**不得**静默变成 no_change
  try {
    await compiler().propose(mkRequest(), makeHost({ omit: ["readSourceSpan"] }));
    bad("缺 readSourceSpan 时不得成功", "却成功了");
  } catch (e) {
    isNot("缺能力时的结果不是 no_change", e.code, "NO_CHANGE");
    is("缺能力时 work_job_state=failed", e.work_job_state, "failed");
  }
}

// =========================================================================== //
console.log("\n[5] 会话门槛（PRD :981）：无会话不虚构，有会话必须验证耐久");

{
  const noSession = checkSessionGate(mkRequest());
  is("无会话 ⇒ session_input=false", noSession.session_input, false);
  is("无会话 ⇒ durability_range=null", noSession.durability_range, null);

  await expectCode("无会话却带耐久范围 ⇒ 拒绝",
    () => checkSessionGate(mkRequest({ verified_durability_range: mkRange() })),
    "DURABILITY_RANGE_WITHOUT_SESSION", { state: "failed" });
  await expectCode("无会话却带有效轮次 ⇒ 拒绝（不得虚构宿主轮次）",
    () => checkSessionGate(mkRequest({ effective_turns_in_memory: [mkTurn()] })),
    "FABRICATED_TURNS", { state: "failed" });

  const withSession = checkSessionGate(mkRequest({
    host_source_refs: [{ session_id: "session_1", branch_id: "session_1", source_revision: mkRange().source_revision, through_seq: 9 }],
    verified_durability_range: mkRange(),
  }));
  is("有会话且耐久已验证 ⇒ session_input=true", withSession.session_input, true);

  await expectCode("有会话但耐久范围=null ⇒ blocked（不得用 null 绕过）",
    () => checkSessionGate(mkRequest({
      host_source_refs: [{ session_id: "session_1", branch_id: "session_1", source_revision: "r" }],
      verified_durability_range: null,
    })), "DURABILITY_UNVERIFIED", { state: "blocked" });

  await expectCode("耐久范围自称 verified=false ⇒ blocked",
    () => checkSessionGate(mkRequest({
      host_source_refs: [{ session_id: "session_1", branch_id: "session_1", source_revision: "r" }],
      verified_durability_range: mkRange({ verified: false }),
    })), "DURABILITY_UNVERIFIED", { state: "blocked" });

  await expectCode("ref 的 source_revision 与耐久范围不一致 ⇒ 拒绝",
    () => checkSessionGate(mkRequest({
      host_source_refs: [{ session_id: "session_1", branch_id: "session_1", source_revision: "other" }],
      verified_durability_range: mkRange(),
    })), "SOURCE_REVISION_MISMATCH", { state: "failed" });

  await expectCode("ref 的 through_seq 超出耐久范围 ⇒ 拒绝（ready 只证明 requested_range）",
    () => checkSessionGate(mkRequest({
      host_source_refs: [{ session_id: "session_1", branch_id: "session_1", source_revision: mkRange().source_revision, through_seq: 99 }],
      verified_durability_range: mkRange(),
    })), "DURABILITY_RANGE_EXCEEDED", { state: "failed" });

  truthy("合法耐久范围通过", checkDurabilityRange(mkRange()).ok);
  falsy("from_seq > through_seq 被拒", checkDurabilityRange(mkRange({ from_seq: 10, through_seq: 9 })).ok);
  falsy("through_seq 缺失被拒", checkDurabilityRange({ verified: true, session_id: "s", branch_id: "s", source_revision: "r" }).ok);

  // propose 端到端：无会话时绝不产生 session_evidence
  const res = await compiler().propose(mkRequest(), makeHost());
  is("无会话 no_change 成功", res.outcome, "no_change");
  deep("无会话结果的键集合恰好 6 个", Object.keys(res), [...COMPILE_RESULT_KEYS]);
}

// =========================================================================== //
console.log("\n[6] effective_turns_in_memory：核验/分源/摘要不是证据");

{
  const t = checkEffectiveTurn(mkTurn(), { index: 0 });
  truthy("已核验的 current 轮次可用", t.usable);
  is("SessionEvidence.host", t.evidence.host, "dsh");
  is("locator_kind=event_seq（只读到 seq 时不称永久 turn ID）", t.evidence.locator_kind, "event_seq");
  is("branch_id 有真实来源", t.evidence.branch_id, "session_1");
  truthy("durability_evidence 带 revision", t.evidence.durability_evidence.revision.length > 0);

  await expectCode("未核验片段被拒（只含经 §9.1 核验的片段）",
    () => checkEffectiveTurn(mkTurn({ verified: false }), { index: 0 }), "TURN_NOT_VERIFIED", { state: "failed" });

  const summary = checkEffectiveTurn(mkTurn({ message_source_kind: "compact-checkpoint" }), { index: 0 });
  is("摘要（compact-checkpoint）**不可用**作证据", summary.usable, false);
  is("摘要的剔除原因是 SUMMARY_IS_NOT_EVIDENCE", summary.not_evidence_reason, "SUMMARY_IS_NOT_EVIDENCE");
  is("摘要不产生 SessionEvidence", summary.evidence, null);

  const shadowed = checkEffectiveTurn(
    mkTurn({ surface_class: "shadowed", purpose: "缺口回溯", original_event_identity: "evt_5", event_seq: 5 }),
    { index: 0 },
  );
  truthy("非 current 轮次带身份+用途 ⇒ 可用（授权历史/缺口回溯）", shadowed.usable);

  await expectCode("非 current 轮次缺 purpose 被拒",
    () => checkEffectiveTurn(mkTurn({ surface_class: "shadowed", original_event_identity: "e" }), { index: 0 }),
    "HISTORY_TURN_REQUIRES_PURPOSE", { state: "failed" });
  await expectCode("非 current 轮次缺原事件身份被拒",
    () => checkEffectiveTurn(mkTurn({ surface_class: "log-only", purpose: "回溯", event_seq: null }), { index: 0 }),
    "HISTORY_TURN_REQUIRES_IDENTITY", { state: "failed" });
  await expectCode("surface_class 值域外被拒",
    () => checkEffectiveTurn(mkTurn({ surface_class: "ghost" }), { index: 0 }), "INVALID_ENUM");

  // 端到端：摘要轮次被剔除并记入 uncertainties，且**不能**成为证据
  const req = mkRequest({
    host_source_refs: [{ session_id: "session_1", branch_id: "session_1", source_revision: mkRange().source_revision, through_seq: 9 }],
    verified_durability_range: mkRange(),
    effective_turns_in_memory: [mkTurn({ message_source_kind: "compact-checkpoint" })],
  });
  const res = await compiler().propose(req, makeHost());
  is("只有摘要时仍按无会话证据处理（outcome=no_change）", res.outcome, "no_change");
  truthy("摘要被明确记入 uncertainties（不是静默丢弃）",
    res.uncertainties.some((u) => u.includes("SUMMARY_IS_NOT_EVIDENCE") || u.includes("压缩摘要")));
}

// =========================================================================== //
console.log("\n[7] 覆盖门槛：M3 coverage 的 blocked_reason 阻止提案（不绕过）");

{
  const processed = analyzableRanges({ relevant_book_spans: [mkSpan()], coverage: mkCoverage() });
  truthy("processed 单元 ⇒ 范围可分析", processed.ok);
  is("可分析范围数 = 1", processed.analyzable.length, 1);
  is("可分析范围带出单元 id", processed.analyzable[0].unit_ids[0], "u_1");

  const pending = analyzableRanges({
    relevant_book_spans: [mkSpan()],
    coverage: mkCoverage({ units: [{ unit_id: "u_1", state: "pending", section_id: "sec_1", start_codepoint: 0, end_codepoint: 100 }] }),
  });
  falsy("pending 单元 ⇒ 整个编译停下（fatal）", pending.ok);
  truthy("pending 带出 blocked_reason", typeof pending.blocked[0].blocked_reason === "string");
  is("pending 不可分析时 analyzable 为空", pending.analyzable.length, 0);

  const excluded = analyzableRanges({
    relevant_book_spans: [mkSpan()],
    coverage: mkCoverage({ units: [{ unit_id: "u_1", state: "excluded", section_id: "sec_1", start_codepoint: 0, end_codepoint: 100, exclusion: { reason: "图片页无法解析" } }] }),
  });
  truthy("excluded 单元 ⇒ 非致命（该范围跳过，不生成提案）", excluded.ok);
  is("excluded 范围不计入可分析", excluded.analyzable.length, 0);
  is("excluded 的 blocked_reason 被带出", excluded.blocked[0].blocked_reason, "EXCLUDED_NOT_COUNTED_AS_UNDERSTOOD");

  const failedUnit = analyzableRanges({
    relevant_book_spans: [mkSpan()],
    coverage: mkCoverage({ units: [{ unit_id: "u_1", state: "failed", section_id: "sec_1", start_codepoint: 0, end_codepoint: 100, failure: { code: "X" } }] }),
  });
  truthy("failed 单元 ⇒ 非致命（任务仍可报告部分成果）", failedUnit.ok);
  is("failed 的 blocked_reason 被带出", failedUnit.blocked[0].blocked_reason, "FAILED_AWAITING_EXPLICIT_SCHEDULE");

  const windowed = analyzableRanges({
    relevant_book_spans: [mkSpan()],
    coverage: mkCoverage({ units: [{ unit_id: "u_1", state: "processed", section_id: "sec_1", start_codepoint: 0, end_codepoint: 100, window: { index: 0 }, window_consumed: false }] }),
  });
  falsy("窗口未真正消费 ⇒ 不可分析（fatal）", windowed.ok);
  is("窗口未消费的原因码", windowed.blocked[0].blocked_reason, "WINDOW_NOT_CONSUMED");

  const uncovered = analyzableRanges({
    relevant_book_spans: [mkSpan({ span_id: "sp_9", start_codepoint: 500, end_codepoint: 600 })],
    coverage: mkCoverage(),
  });
  falsy("完全没有覆盖单元 ⇒ fatal（不得对未分析范围生成提案）", uncovered.ok);
  is("未覆盖原因码", uncovered.blocked[0].blocked_reason, "RANGE_NOT_COVERED");

  const noCov = analyzableRanges({ relevant_book_spans: [mkSpan()], coverage: null });
  falsy("缺 coverage 快照 ⇒ 不可分析", noCov.ok);
  is("缺 coverage 的失败码", noCov.code, "COVERAGE_UNAVAILABLE");

  const noSource = analyzableRanges({ relevant_book_spans: [mkSpan()], coverage: { units: [{ unit_id: "u_1", state: "processed", start_codepoint: 0, end_codepoint: 100 }] } });
  falsy("coverage 无来源门槛 ⇒ 不假设 ready", noSource.ok);
  is("无来源门槛的失败码", noSource.code, "COVERAGE_SOURCE_UNKNOWN");

  truthy("无书内范围时无需 coverage", analyzableRanges({ relevant_book_spans: [], coverage: null }).ok);

  // 端到端：不可推进时 propose 必须 blocked，且**不得**返回 no_change
  await expectCode("pending 范围时 propose ⇒ blocked（不是 no_change）",
    () => compiler().propose(
      mkRequest({ compiler_config: { coverage: mkCoverage({ units: [{ unit_id: "u_1", state: "pending", section_id: "sec_1", start_codepoint: 0, end_codepoint: 100 }] }) } }),
      makeHost(),
    ), "WATERMARK_NOT_ADVANCEABLE", { state: "blocked" });

  await expectCode("缺 coverage 快照时 propose ⇒ blocked",
    () => compiler().propose(mkRequest({ compiler_config: {} }), makeHost()),
    "COVERAGE_UNAVAILABLE", { state: "blocked" });

  // 反例：excluded 范围不得产出任何以该书 span 为依据的 operation
  const excludedRes = await compiler().propose(
    mkRequest({
      compiler_config: { coverage: mkCoverage({ units: [{ unit_id: "u_1", state: "excluded", section_id: "sec_1", start_codepoint: 0, end_codepoint: 100, exclusion: { reason: "图片页" } }] }) },
    }),
    makeHost({ draft: { outcome: "proposal", operations: [mkOp()] } }),
  ).then((r) => r, (e) => e);
  truthy("excluded 范围 + 仍想用该书 span 建提案 ⇒ 被拒（不是成功）",
    excludedRes instanceof CompilerError);
  is("被拒原因是书证据未核验", excludedRes?.code, "NO_VALID_OPERATION");
  truthy("被拒明细里含 UNVERIFIED_BOOK_SPAN",
    JSON.stringify(excludedRes?.detail ?? null).includes("UNVERIFIED_BOOK_SPAN"));
}

// =========================================================================== //
console.log("\n[8] 查重门槛：核对失败不伪装 no_change，hash 不替代内容核对");

{
  await expectCode("local_result=read_error ⇒ blocked",
    () => runDedupGate(mkRequest({ dedup_check: mkDedup({ local_result: "read_error" }) }), makeHost()),
    "DEDUP_READ_ERROR", { state: "blocked" });

  const host = makeHost();
  await expectCode("local_result=partial ⇒ 请求追加召回后 blocked",
    () => runDedupGate(mkRequest({ dedup_check: mkDedup({ local_result: "partial" }) }), host),
    "ADDITIONAL_RECALL_REQUIRED", { state: "blocked" });
  is("确实调用了 requestAdditionalCandidates（追加召回只在既有 scope 内）", host.__calls.requestAdditionalCandidates.length, 1);
  is("追加召回带的是同一次 check_id", host.__calls.requestAdditionalCandidates[0][0], "chk_1");

  await expectCode("local_result=matched 却无候选 ⇒ 拒绝",
    () => runDedupGate(mkRequest({ dedup_check: mkDedup({ local_result: "matched", candidate_refs: [] }) }), makeHost()),
    "INVALID_COMBINATION", { state: "failed" });

  const matchedDedup = mkDedup({
    local_result: "matched",
    candidate_refs: [{ candidate_id: "note_1", object_id: "note_1", relative_path: "45-书籍/概念/示例.md", content_hash: H("b") }],
  });
  const host2 = makeHost({ notes: { note_1: { object_id: "note_1", relative_path: "45-书籍/概念/示例.md", content_hash: H("b") } } });
  const good = await runDedupGate(mkRequest({ dedup_check: matchedDedup }), host2);
  is("matched 时必须精确读取（hash 不替代内容核对）", host2.__calls.readCheckedNote.length, 1);
  is("实读 hash 一致 ⇒ 无冲突", good.conflicts.length, 0);
  is("实读候选进入 verified_candidates", good.verified_candidates.length, 1);

  await expectCode("候选无法精确读取 ⇒ blocked（不得凭未读结果新建）",
    () => runDedupGate(mkRequest({ dedup_check: matchedDedup }), makeHost({ notes: {} })),
    "DEDUP_READ_ERROR", { state: "blocked" });

  const staleHost = makeHost({ notes: { note_1: { object_id: "note_1", relative_path: "45-书籍/概念/示例.md", content_hash: H("e") } } });
  const stale = await runDedupGate(mkRequest({ dedup_check: matchedDedup }), staleHost);
  is("声明 hash 与实读不一致 ⇒ 记 conflict（降 stale）", stale.conflicts[0].reason, "SNAPSHOT_HASH_MISMATCH");
  is("冲突候选 disposition=stale", stale.conflicts[0].disposition, "stale");
  truthy("stale 候选在 verified_candidates 里被标记", stale.verified_candidates[0].stale);

  // 冲突未解决时**不得**报 no_change
  const staleReq = mkRequest({
    dedup_check: matchedDedup,
    current_note_snapshots_and_hashes: [mkSnapshot()],
  });
  await expectCode("hash 冲突未解决时模型说 no_change ⇒ blocked（不伪装成无变更）",
    () => compiler().propose(staleReq, staleHost),
    "NOTE_HASH_CONFLICT", { state: "blocked" });

  // 外区核对结论不得被升级
  const notChecked = await runDedupGate(mkRequest(), makeHost());
  truthy("未执行外区核对 ⇒ 记入 uncertainties（不声称无主笔记）",
    notChecked.uncertainties.some((u) => u.includes("not_checked")));
  await expectCode("no_match 却没列 scope_refs ⇒ 拒绝",
    () => runDedupGate(mkRequest({
      dedup_check: mkDedup({ local_result: "no_match", external_master: mkExternalMaster({ status: "verified", outcome: "no_match", check_id: "chk_1", checked_at: "2026-10-10T00:00:00Z", scope_refs: [] }) }),
    }), makeHost()),
    "INVALID_COMBINATION", { state: "failed" });
  const staleEm = await runDedupGate(mkRequest({
    dedup_check: mkDedup({ external_master: mkExternalMaster({ status: "unverified", outcome: "stale" }) }),
  }), makeHost());
  truthy("外区 stale ⇒ 记 conflict（不得沿用「已核对」）", staleEm.conflicts.some((c) => c.reason === "EXTERNAL_MASTER_INCOMPLETE"));

  // snapshots 必须由服务产出
  await expectCode("快照缺 produced_by ⇒ 拒绝（模型不能自报）",
    () => compiler().propose(mkRequest({ current_note_snapshots_and_hashes: [{ object_id: "n", relative_path: "45-书籍/a.md", content_hash: H("b"), check_id: "chk_1" }] }), makeHost()),
    "SNAPSHOT_NOT_SERVICE_PRODUCED", { state: "failed" });
  await expectCode("快照 check_id 与本次核对不一致 ⇒ 拒绝",
    () => compiler().propose(mkRequest({ current_note_snapshots_and_hashes: [mkSnapshot({ check_id: "other" })] }), makeHost()),
    "SNAPSHOT_CHECK_MISMATCH", { state: "failed" });
}

// =========================================================================== //
console.log("\n[9] 归属三分离（PRD :483）");

{
  const ctx = { book_spans: [{ span_id: "sp_1", verified: true }], verified_candidates: [], session_evidence: [], human_turns: [], known_user_actions: [] };

  truthy("book_author + unconfirmed 通过", validateAttribution({ object_type: "insight", origin: "book_author", confirmation: "unconfirmed", book_evidence: [{ source_kind: "book_span", ref: mkSpan() }] }, ctx).ok);

  const conf = validateAttribution({ object_type: "insight", origin: "book_author", confirmation: "confirmed" }, ctx);
  falsy("模型声明 confirmed 被拒", conf.ok);
  is("拒绝码 MODEL_CANNOT_CONFIRM", conf.errors[0].code, "MODEL_CANNOT_CONFIRM");

  const retr = validateAttribution({ object_type: "insight", origin: "user", confirmation: "retracted" }, ctx);
  falsy("模型声明 retracted 被拒", retr.ok);

  const ev = validateAttribution({ object_type: "insight", origin: "book_author", confirmation: "unconfirmed", confirmation_evidence: { actor: "a", action_id: "x", at: "t", scope: "s" } }, ctx);
  falsy("模型自带 confirmation_evidence 被拒", ev.ok);
  is("拒绝码 MODEL_CANNOT_SUPPLY_CONFIRMATION_EVIDENCE", ev.errors[0].code, "MODEL_CANNOT_SUPPLY_CONFIRMATION_EVIDENCE");

  const aiToUser = validateAttribution({ object_type: "insight", origin: "user", confirmation: "unconfirmed", kind: "ai_hypothesis", user_confirmed_ai: true }, ctx);
  falsy("AI 假设写成 user 被拒", aiToUser.ok);
  truthy("拒绝明细含「确认 AI 不产生用户事实」",
    aiToUser.errors.some((e) => e.code === "CONFIRMING_AI_DOES_NOT_MAKE_USER_FACT"));
  truthy("拒绝明细含 AI_CANNOT_BECOME_USER_FACT",
    aiToUser.errors.some((e) => e.code === "AI_CANNOT_BECOME_USER_FACT"));

  const fakeUser = validateAttribution({ object_type: "insight", origin: "user", confirmation: "unconfirmed", source_refs: [] }, ctx);
  falsy("无真人来源却称 origin=user 被拒", fakeUser.ok);
  is("拒绝码 USER_ORIGIN_REQUIRES_HUMAN_SOURCE", fakeUser.errors[0].code, "USER_ORIGIN_REQUIRES_HUMAN_SOURCE");

  const modelAction = validateAttribution({
    object_type: "insight", origin: "user", confirmation: "unconfirmed",
    source_refs: [{ source_kind: "user_action", ref: { actor: "me", action_id: "act_1", at: "2026-10-10T00:00:00Z", scope: "s", short_statement: "我确认" } }],
  }, ctx);
  falsy("模型自报 user_action 被拒（须服务回执）", modelAction.ok);
  truthy("拒绝明细含 MODEL_CANNOT_SUPPLY_USER_ACTION",
    modelAction.errors.some((e) => e.code === "MODEL_CANNOT_SUPPLY_USER_ACTION"));

  const realAction = validateAttribution({
    object_type: "insight", origin: "user", confirmation: "unconfirmed",
    source_refs: [{ source_kind: "user_action", ref: { actor: "me", action_id: "act_1", at: "2026-10-10T00:00:00Z", scope: "s", short_statement: "我确认" } }],
  }, { ...ctx, known_user_actions: [{ actor: "me", action_id: "act_1" }] });
  truthy("服务给出真实 user_action ⇒ origin=user 可成立（仍 unconfirmed）", realAction.ok);

  const human = validateAttribution({ object_type: "insight", origin: "user", confirmation: "unconfirmed", source_refs: [] },
    { ...ctx, human_turns: [{ session_id: "s" }] });
  truthy("有已核验真人轮次 ⇒ origin=user 可成立", human.ok);

  const bookNoEvidence = validateAttribution({ object_type: "insight", origin: "book_author", confirmation: "unconfirmed", book_evidence: [] }, ctx);
  falsy("book_author 无书证据被拒", bookNoEvidence.ok);

  const summaryEvidence = validateAttribution({
    object_type: "insight", origin: "book_author", confirmation: "unconfirmed",
    book_evidence: [{ source_kind: "book_span", ref: mkSpan() }],
    source_refs: [{ source_kind: "host_turn", ref: { message_source_kind: "compact-checkpoint" } }],
  }, ctx);
  falsy("引用压缩摘要当证据被拒", summaryEvidence.ok);
  is("拒绝码 SUMMARY_IS_NOT_EVIDENCE", summaryEvidence.errors[0].code, "SUMMARY_IS_NOT_EVIDENCE");

  const noOrigin = validateAttribution({ object_type: "insight", confirmation: "unconfirmed" }, ctx);
  falsy("语义对象缺 origin 被拒", noOrigin.ok);
  const noConf = validateAttribution({ object_type: "insight", origin: "ai_inference" }, ctx);
  falsy("语义对象缺 confirmation 被拒", noConf.ok);

  const ai = validateAttribution({ object_type: "reading_evidence", origin: "ai_inference", confirmation: "unconfirmed" }, ctx);
  truthy("AI 猜测 origin=ai_inference + unconfirmed 通过", ai.ok);
  is("规范化后 confirmation 仍是 unconfirmed", ai.normalized.confirmation, "unconfirmed");
}

// =========================================================================== //
console.log("\n[10] operation 规则：create/update/link 与预算");

{
  const base = {
    summary_budget: DEFAULT_SUMMARY_BUDGET,
    consent_scope: { scope_id: "s", can_write: true, allowed_object_types: null },
    dedup: { local_result: "no_match" },
    snapshots: [],
    verified_candidates: [],
    book_spans: [{ span_id: "sp_1", verified: true }],
    session_evidence: [],
    human_turns: [],
    known_user_actions: [],
  };

  const created = compileOperation(mkOp(), base);
  truthy("合法 create 通过", created.ok);
  is("create 的 base_hash 强制为 null", created.operation.base_hash, null);
  is("语义 operation 的 confirmation 被规范化为 unconfirmed", created.operation.confirmation, "unconfirmed");

  const withHash = compileOperation(mkOp({ base_hash: H("a") }), base);
  falsy("create 带 base_hash 被拒", withHash.ok);
  truthy("拒绝码含 INVALID_COMBINATION", withHash.errors.some((e) => e.code === "INVALID_COMBINATION"));

  const exists = compileOperation(mkOp(), { ...base, snapshots: [mkSnapshot({ object_id: "ins_1" })] });
  falsy("create 目标已存在被拒", exists.ok);
  truthy("拒绝码 CREATE_TARGET_EXISTS", exists.errors.some((e) => e.code === "CREATE_TARGET_EXISTS"));

  const matchedCreate = compileOperation(mkOp(), { ...base, dedup: { local_result: "matched" }, verified_candidates: [{ candidate_id: "c1", object_id: "note_1", content_hash: H("b"), stale: false }] });
  falsy("本区已有匹配却新建、无 new_note_reason ⇒ 拒绝", matchedCreate.ok);
  truthy("拒绝码 new_note_reason", matchedCreate.errors.some((e) => e.code === "INVALID_COMBINATION" && e.field === "new_note_reason"));
  const matchedCreateOk = compileOperation(mkOp({ new_note_reason: "同主题但独立书域差异" }), { ...base, dedup: { local_result: "matched" }, verified_candidates: [{ candidate_id: "c1", object_id: "note_1", content_hash: H("b"), stale: false }] });
  truthy("给了真实 new_note_reason ⇒ 允许新建", matchedCreateOk.ok);

  const noBase = compileOperation(mkOp({ type: "update", base_hash: null }), { ...base, snapshots: [mkSnapshot()] });
  falsy("update 缺 base_hash 被拒", noBase.ok);
  truthy("拒绝码 MISSING_REQUIRED base_hash", noBase.errors.some((e) => e.code === "MISSING_REQUIRED" && e.field === "base_hash"));

  const wrongBase = compileOperation(mkOp({ type: "update", target_object_id: "note_1", base_hash: H("d") }), {
    ...base,
    snapshots: [mkSnapshot()],
    verified_candidates: [{ candidate_id: "c1", object_id: "note_1", content_hash: H("b"), stale: false }],
  });
  falsy("update 的 base_hash 与实读不一致被拒", wrongBase.ok);
  truthy("拒绝码 BASE_HASH_MISMATCH", wrongBase.errors.some((e) => e.code === "BASE_HASH_MISMATCH"));

  const nonHexBase = compileOperation(mkOp({ type: "update", target_object_id: "note_1", base_hash: "z".repeat(64) }), {
    ...base,
    snapshots: [mkSnapshot()],
    verified_candidates: [{ candidate_id: "c1", object_id: "note_1", content_hash: H("b"), stale: false }],
  });
  falsy("base_hash 非 64 位十六进制被拒", nonHexBase.ok);
  truthy("非十六进制 base_hash 的拒绝码是 MISSING_REQUIRED",
    nonHexBase.errors.some((e) => e.code === "MISSING_REQUIRED" && e.field === "base_hash"));

  const goodUpdate = compileOperation(mkOp({ type: "update", target_object_id: "note_1", base_hash: H("b") }), {
    ...base,
    snapshots: [mkSnapshot()],
    verified_candidates: [{ candidate_id: "c1", object_id: "note_1", content_hash: H("b"), stale: false }],
  });
  truthy("update 带实读 base_hash ⇒ 通过", goodUpdate.ok);

  const staleUpdate = compileOperation(mkOp({ type: "update", target_object_id: "note_1", base_hash: H("b") }), {
    ...base,
    snapshots: [mkSnapshot()],
    verified_candidates: [{ candidate_id: "c1", object_id: "note_1", content_hash: H("b"), stale: true }],
  });
  falsy("update 目标快照 stale 被拒", staleUpdate.ok);
  truthy("拒绝码 STALE_SNAPSHOT", staleUpdate.errors.some((e) => e.code === "STALE_SNAPSHOT"));

  const link = compileOperation(mkOp({
    type: "link", target_object_id: "note_1",
    source_refs: [{ source_kind: "knowledge_note", ref: { object_id: "note_1", relative_path: "45-书籍/概念/示例.md", content_hash: H("b") } }],
  }), { ...base, snapshots: [mkSnapshot()], verified_candidates: [{ candidate_id: "c1", object_id: "note_1", relative_path: "45-书籍/概念/示例.md", content_hash: H("b"), stale: false }] });
  truthy("link 指向 45 内已核对对象 ⇒ 通过", link.ok);

  const outsideLink = compileOperation(mkOp({
    type: "link", target_object_id: "note_1",
    source_refs: [{ source_kind: "knowledge_note", ref: { object_id: "note_1", relative_path: "40-来源/外区.md", content_hash: H("b") } }],
  }), { ...base, snapshots: [mkSnapshot()], verified_candidates: [{ candidate_id: "c1", object_id: "note_1", relative_path: "45-书籍/概念/示例.md", content_hash: H("b"), stale: false }] });
  falsy("link 指向 45 外被拒（不写外区）", outsideLink.ok);
  truthy("拒绝码 OUT_OF_SCOPE", outsideLink.errors.some((e) => e.code === "OUT_OF_SCOPE"));

  const longContent = compileOperation(mkOp({ short_content: "x".repeat(500) }), { ...base, summary_budget: { max_operations: 5, max_short_content_chars: 100 } });
  falsy("短内容超预算被拒", longContent.ok);
  truthy("拒绝码 BUDGET_EXCEEDED", longContent.errors.some((e) => e.code === "BUDGET_EXCEEDED"));

  const noWrite = compileOperation(mkOp(), { ...base, consent_scope: { scope_id: "s", can_write: false } });
  falsy("无写权限被拒", noWrite.ok);

  const typeScope = compileOperation(mkOp({ object_type: "concept" }), { ...base, consent_scope: { scope_id: "s", can_write: true, allowed_object_types: ["insight"] } });
  falsy("object_type 超出 consent_scope 被拒", typeScope.ok);

  const badType = compileOperation(mkOp({ type: "delete" }), base);
  falsy("operation.type 值域外被拒", badType.ok);

  const unverifiedSpan = compileOperation(mkOp({ book_evidence: [{ source_kind: "book_span", ref: mkSpan({ span_id: "sp_9" }) }], source_refs: [] }), base);
  falsy("书证据未核验被拒", unverifiedSpan.ok);
  truthy("拒绝码 UNVERIFIED_BOOK_SPAN", unverifiedSpan.errors.some((e) => e.code === "UNVERIFIED_BOOK_SPAN"));

  const fakeTurn = compileOperation(mkOp({ session_evidence: [{ source_kind: "host_turn", ref: { host: "dsh", session_id: "s", locator_kind: "event_seq", branch_id: "s", source_revision: "r", availability: "available", event_seq: 1 } }] }), base);
  falsy("会话证据不在已核验片段内被拒（不虚构宿主轮次）", fakeTurn.ok);
  truthy("拒绝码 UNVERIFIED_SESSION_EVIDENCE", fakeTurn.errors.some((e) => e.code === "UNVERIFIED_SESSION_EVIDENCE"));

  const uo = compileOperation(mkOp({
    object_type: "understanding_observation", concept_refs: ["concept_1"], dimension: "explanation",
    change_kind: "supplemented", before: null, after: "能解释怀疑方法的限度。",
    before_source_refs: [], after_source_refs: [{ source_kind: "book_span", ref: mkSpan() }],
  }), base);
  truthy("理解变化带齐必填字段 ⇒ 通过", uo.ok);

  const uoNoConcept = compileOperation(mkOp({ object_type: "understanding_observation", concept_refs: [], dimension: "explanation", change_kind: "supplemented", after: "x", after_source_refs: [{ source_kind: "book_span", ref: mkSpan() }] }), base);
  falsy("理解变化缺 concept_refs 被拒", uoNoConcept.ok);

  const uoBefore = compileOperation(mkOp({
    object_type: "understanding_observation", concept_refs: ["c"], dimension: "explanation",
    change_kind: "supplemented", before: null, after: "x",
    before_source_refs: [{ source_kind: "book_span", ref: mkSpan() }],
    after_source_refs: [{ source_kind: "book_span", ref: mkSpan() }],
  }), base);
  falsy("before=null 却带前引用被拒（不得伪造「过去想法」）", uoBefore.ok);

  const uoNoAfter = compileOperation(mkOp({ object_type: "understanding_observation", concept_refs: ["c"], dimension: "explanation", change_kind: "supplemented", after: "", after_source_refs: [] }), base);
  falsy("理解变化缺 after 被拒", uoNoAfter.ok);

  const noEm = compileOperation(mkOp({ external_master: null }), base);
  falsy("缺 external_master 被拒", noEm.ok);

  // external_master 的**组合**约束复用 M1（7 种合法组合）
  const badCombo = compileOperation(mkOp({ external_master: mkExternalMaster({ status: "linked", outcome: "not_checked" }) }), base);
  falsy("external_master 非法组合（linked+not_checked）被拒", badCombo.ok);
  truthy("非法组合的拒绝码是 INVALID_COMBINATION", badCombo.errors.some((e) => e.code === "INVALID_COMBINATION"));
  const noMatchNoScope = compileOperation(mkOp({
    external_master: mkExternalMaster({ status: "verified", outcome: "no_match", check_id: "chk_1", checked_at: "2026-10-10T00:00:00Z", scope_refs: [] }),
  }), base);
  falsy("no_match 却没列 scope_refs 被拒（不得声称查全库）", noMatchNoScope.ok);

  // 预算：operations 数量超上限
  await expectCode("operations 数量超 summary_budget 被拒",
    () => compiler().propose(
      mkRequest({ summary_budget: { max_operations: 1, max_short_content_chars: 200 } }),
      makeHost({ draft: { outcome: "proposal", operations: [mkOp(), mkOp({ target_object_id: "ins_2" })] } }),
    ), "BUDGET_EXCEEDED", { state: "failed" });
}

// =========================================================================== //
console.log("\n[11] outcome 与 job 映射（PRD :966-967）：错误永不伪装 no_change");

{
  const proposal = { outcome: "proposal", operations: [{}], dedup_check_ref: "chk_1", conflicts: [], uncertainties: [], compiler_metadata: { name: "c", version: "1" } };
  const noChange = { outcome: "no_change", operations: [], dedup_check_ref: "chk_1", conflicts: [], uncertainties: [], compiler_metadata: { name: "c", version: "1" } };

  const j1 = mapCompileResultToJob(noChange);
  is("no_change ⇒ result_outcome=no_change", j1.result_outcome, "no_change");
  is("no_change ⇒ kind=extract_knowledge", j1.kind, "extract_knowledge");
  is("no_change ⇒ 需要耐久回执", j1.receipt_required, true);
  is("no_change ⇒ 未保存观察", j1.observation_saved, false);

  const j2 = mapCompileResultToJob(proposal, { application_mode: "manual" });
  is("manual 提案 ⇒ result_outcome=proposal", j2.result_outcome, "proposal");
  is("manual 提案 ⇒ pending_review", j2.proposal_state, "pending_review");
  is("manual 提案 ⇒ 未保存观察（须 accept 事务）", j2.observation_saved, false);

  const j3 = mapCompileResultToJob(proposal, { application_mode: "authorized_auto", accept_transaction_state: "prepared" });
  is("自动路径未 accepted ⇒ proposal_state=applying", j3.proposal_state, "applying");
  is("自动路径未 accepted ⇒ **不**报告观察已保存", j3.observation_saved, false);
  const j4 = mapCompileResultToJob(proposal, { application_mode: "authorized_auto", accept_transaction_state: "committed" });
  is("自动路径 accept 事务完成 ⇒ accepted", j4.proposal_state, "accepted");
  is("自动路径 accept 完成才报告观察已保存", j4.observation_saved, true);
  for (const j of [j1, j2, j3, j4]) {
    is("任何路径都**不自动确认语义**", j.semantics_confirmed, false);
  }

  for (const [label, err] of [
    ["blocked 错误", new CompilerError("SOURCE_NOT_DURABLE", "x", null, { workJobState: "blocked" })],
    ["failed 错误", new CompilerError("INVALID_REQUEST", "y")],
  ]) {
    const m = mapErrorToJob(err);
    isNot(`${label} 不得伪装成 no_change`, m.result_outcome, "no_change");
    is(`${label} 的 result_outcome 为 null`, m.result_outcome, null);
    is(`${label} 不标记 disguised_as_no_change`, m.disguised_as_no_change, false);
  }
  is("blocked 错误映射到 blocked", mapErrorToJob(new CompilerError("A", "m", null, { workJobState: "blocked" })).state, "blocked");
  is("failed 错误映射到 failed", mapErrorToJob(new CompilerError("A", "m")).state, "failed");
  is("错误码被保留", mapErrorToJob(new CompilerError("SOURCE_NOT_DURABLE", "m", null, { workJobState: "blocked" })).reason_code, "SOURCE_NOT_DURABLE");

  // 端到端：来源不可用 ⇒ blocked 且不是 no_change
  const err = await compiler().propose(mkRequest(), makeHost({ spans: { sp_1: { ok: false, availability: "unavailable" } } }))
    .then((r) => r, (e) => e);
  truthy("来源不可用 ⇒ 抛错（不是成功结果）", err instanceof CompilerError);
  is("来源不可用的码是 SOURCE_UNAVAILABLE", err.code, "SOURCE_UNAVAILABLE");
  is("来源不可用映射到 blocked", mapErrorToJob(err).state, "blocked");
  isNot("来源不可用绝不是 no_change", mapErrorToJob(err).result_outcome, "no_change");

  // 端到端：来源 hash 变化 ⇒ blocked（须重新核验）
  await expectCode("span text_hash 与已核验值不一致 ⇒ blocked",
    () => compiler().propose(mkRequest(), makeHost({ spans: { sp_1: { ok: true, span_id: "sp_1", text_hash: H("f") } } })),
    "SOURCE_SPAN_HASH_MISMATCH", { state: "blocked" });

  // 端到端：模型崩溃 / 草稿形状非法 ⇒ failed（不是 no_change）
  await expectCode("模型抛错 ⇒ MODEL_ERROR（failed）",
    () => compiler().propose(mkRequest(), makeHost({ throwOn: { generateStructured: true } })),
    "MODEL_ERROR", { state: "failed" });
  await expectCode("草稿 outcome 非法 ⇒ MODEL_ERROR",
    () => compiler().propose(mkRequest(), makeHost({ draft: { outcome: "maybe" } })),
    "MODEL_ERROR", { state: "failed" });
  await expectCode("outcome=proposal 但 operations 为空 ⇒ EMPTY_PROPOSAL（不静默降级）",
    () => compiler().propose(mkRequest(), makeHost({ draft: { outcome: "proposal", operations: [] } })),
    "EMPTY_PROPOSAL", { state: "failed" });
  await expectCode("no_change 无理由 ⇒ MODEL_ERROR",
    () => compiler().propose(mkRequest(), makeHost({ draft: { outcome: "no_change" } })),
    "MODEL_ERROR", { state: "failed" });
  await expectCode("全部草稿被归属校验拒绝 ⇒ NO_VALID_OPERATION（不降级 no_change）",
    () => compiler().propose(mkRequest(), makeHost({ draft: { outcome: "proposal", operations: [mkOp({ origin: "user", confirmation: "confirmed" })] } })),
    "NO_VALID_OPERATION", { state: "failed" });
}

// =========================================================================== //
console.log("\n[12] 提案组装 + M1 自检 + generated_by 省略");

{
  const req = mkRequest();
  const res = await compiler().propose(req, makeHost({ draft: { outcome: "proposal", operations: [mkOp()] } }));
  is("合法草稿 ⇒ outcome=proposal", res.outcome, "proposal");
  is("proposal 结果键集合恰好 6 个", Object.keys(res).length, 6);
  is("compiler_metadata 是 {name,version}", JSON.stringify(res.compiler_metadata), JSON.stringify({ name: COMPILER_NAME, version: COMPILER_VERSION }));
  is("dedup_check_ref 取自 check_id", res.dedup_check_ref, "chk_1");
  is("operation 的 confirmation 是 unconfirmed", res.operations[0].confirmation, "unconfirmed");

  const prop = buildChangeProposal(res, {
    job_id: "job_1",
    proposal_id: "cp_1",
    input_fingerprint: H("c"),
    dedup_check: req.dedup_check,
    source_range: canonicalSourceRange(req),
    now: "2026-10-10T12:00:00Z",
  });
  truthy("提案组装成功", prop.ok);
  deep("顶层 compiler 键集合恰好 {name,version}", Object.keys(prop.data.compiler).sort(), ["name", "version"]);
  is("顶层 compiler 是真实编译器名", prop.data.compiler.name, COMPILER_NAME);
  is("顶层 compiler 是真实版本", prop.data.compiler.version, COMPILER_VERSION);
  falsy("索引没有 generated_by ⇒ 提案里**没有**该键（不补造）", Object.prototype.hasOwnProperty.call(prop.data, "generated_by"));
  is("提案默认 application_mode=manual（模型不自选）", prop.data.application_mode, "manual");
  is("manual 模式 authorization_ref 必须为 null", prop.data.authorization_ref, null);
  is("提案默认 state=draft（不可直接接受）", prop.data.state, "draft");
  is("提案 id 等于 proposal_id", prop.data.id, prop.data.proposal_id);

  // 用**测试自己的** schema 独立复验一次（不是信任编译器内部结论）
  const recheck = validateNote(prop.data, { mode: "formal", objectType: "change_proposal", domain: BOOK_DOMAIN });
  truthy("提案独立复验通过 M1 validateNote（formal）", recheck.ok);
  if (!recheck.ok) console.log("      " + JSON.stringify(recheck.errors.slice(0, 3)));

  // 工具生成且真实提供 ⇒ 带上；形状必须是 {compiler,version}
  const withGb = buildChangeProposal(res, {
    job_id: "job_1", proposal_id: "cp_1", input_fingerprint: H("c"), dedup_check: req.dedup_check,
    generated_by: { compiler: "obsidian", version: "1.5" }, now: "2026-10-10T12:00:00Z",
  });
  deep("提供 generated_by 时键名是 {compiler,version}", Object.keys(withGb.data.generated_by).sort(), ["compiler", "version"]);
  truthy("同时存在顶层 compiler 与 generated_by 时，两者键名不同",
    JSON.stringify(Object.keys(withGb.data.compiler).sort()) !== JSON.stringify(Object.keys(withGb.data.generated_by).sort()));
  truthy("带 generated_by 的提案仍通过 validateNote", validateNote(withGb.data, { mode: "formal", objectType: "change_proposal", domain: BOOK_DOMAIN }).ok);

  await expectCode("generated_by 写成 {name,version} ⇒ 提案组装失败",
    () => buildChangeProposal(res, {
      job_id: "job_1", proposal_id: "cp_1", input_fingerprint: H("c"), dedup_check: req.dedup_check,
      generated_by: { name: "x", version: "y" }, now: "2026-10-10T12:00:00Z",
    }), "INVALID_GENERATED_BY", { state: "failed" });

  await expectCode("no_change 结果没有提案文档",
    () => buildChangeProposal({ outcome: "no_change", operations: [], compiler_metadata: { name: "c", version: "1" } }, { job_id: "j", proposal_id: "p", input_fingerprint: H("c"), dedup_check: req.dedup_check }),
    "INVALID_ARGUMENT", { state: "failed" });

  await expectCode("dedup_check 与 dedup_check_ref 不一致 ⇒ 拒绝",
    () => buildChangeProposal(res, { job_id: "j", proposal_id: "p", input_fingerprint: H("c"), dedup_check: mkDedup({ check_id: "other" }), now: "2026-10-10T12:00:00Z" }),
    "INVALID_COMBINATION", { state: "failed" });

  // 自检强制：propose 内部已经跑过 validateNote；把未知身份塞进 compiler_metadata 必须被挡
  await expectCode("compiler_metadata 未知 ⇒ propose 直接阻止（不是填占位符）",
    () => compiler().propose(mkRequest({ compiler_config: { coverage: mkCoverage(), compiler_metadata: { name: null, version: null } } }), makeHost({ draft: { outcome: "proposal", operations: [mkOp()] } })),
    "COMPILER_IDENTITY_UNKNOWN", { state: "failed" });
  await expectCode("compiler_metadata 键名混用（{compiler,version}）⇒ 阻止",
    () => compiler().propose(mkRequest({ compiler_config: { coverage: mkCoverage(), compiler_metadata: { compiler: "x", version: "1" } } }), makeHost()),
    "COMPILER_IDENTITY_UNKNOWN", { state: "failed" });

  // 自检必须真的在跑：手工构造一份「operation 的 external_master 组合非法」的结果，
  // 直接喂给 buildChangeProposal ⇒ 必须被 M1 validateNote 拦下。
  const badResult = {
    outcome: "proposal",
    operations: [{ ...mkOp({ operation_id: "op_1" }), external_master: mkExternalMaster({ status: "linked", outcome: "not_checked" }) }],
    dedup_check_ref: "chk_1",
    conflicts: [],
    uncertainties: [],
    compiler_metadata: { name: "c", version: "1" },
  };
  await expectCode("提案自检：非法 external_master 组合被 M1 validateNote 拦下",
    () => buildChangeProposal(badResult, {
      job_id: "j", proposal_id: "p", input_fingerprint: H("c"), dedup_check: mkRequest().dedup_check,
      now: "2026-10-10T12:00:00Z",
    }), "PROPOSAL_SELF_CHECK_FAILED", { state: "failed" });
  // 对照：把组合改合法 ⇒ 同一份结果就能通过（证明上一条不是恒定失败）
  const goodResult = { ...badResult, operations: [mkOp({ operation_id: "op_1" })] };
  truthy("对照：合法组合的同一形状提案通过自检",
    buildChangeProposal(goodResult, {
      job_id: "j", proposal_id: "p", input_fingerprint: H("c"), dedup_check: mkRequest().dedup_check,
      now: "2026-10-10T12:00:00Z",
    }).ok);
}

// =========================================================================== //
console.log("\n[13] no_change 耐久最小回执（PRD §8.7）");

{
  const res = await compiler().propose(mkRequest(), makeHost({ draft: { outcome: "no_change", reason: "本批材料无新增命题" } }));
  const receipt = buildNoChangeReceipt(res, { source_range: canonicalSourceRange(mkRequest()) });
  is("回执 outcome=no_change", receipt.outcome, "no_change");
  is("回执 check_id 取自结果", receipt.check_id, "chk_1");
  truthy("回执含来源范围", typeof receipt.source_range === "string" && receipt.source_range.length > 0);
  truthy("回执通过 M1 validateNoChangeReceipt", validateNoChangeReceipt(receipt).ok);
  truthy("回执不含正文类字段", !("content" in receipt) && !("text" in receipt) && !("operations" in receipt));

  await expectCode("缺来源范围的回执不合法",
    () => buildNoChangeReceipt(res, { source_range: "" }), "NO_CHANGE_RECEIPT_INVALID", { state: "failed" });
  await expectCode("proposal 结果不能造 no_change 回执",
    () => buildNoChangeReceipt({ outcome: "proposal", dedup_check_ref: "chk_1" }, { source_range: "x" }),
    "INVALID_ARGUMENT", { state: "failed" });

  const range = canonicalSourceRange(mkRequest());
  truthy("来源范围字符串可核对（含 span 坐标）", range.includes("sp_1") && range.includes("[0,100)"));
  const rangeNoBook = canonicalSourceRange(mkRequest({ relevant_book_spans: [] }));
  is("无范围时用显式 empty_scope（不是空串）", rangeNoBook, "empty_scope");
}

// =========================================================================== //
console.log("\n[14] authorized_auto：提交器校验，模型不得自选");

{
  const enabled = [{ action_id: "act_1", enabled: true, scope: ["object", "create", "45"] }];
  const good = validateAuthorizedAuto({
    authorization_ref: { actor: "me", action_id: "act_1", scope: ["object", "create", "45"], revision: "rev_1" },
    enabled_actions: enabled,
    operations: [{ type: "create" }],
  });
  truthy("真实启用动作 + 合法 scope + 全新建 ⇒ 通过", good.ok);

  falsy("动作未启用 ⇒ 拒绝", validateAuthorizedAuto({
    authorization_ref: { actor: "me", action_id: "act_9", scope: ["object"], revision: "rev_1" },
    enabled_actions: enabled, operations: [{ type: "create" }],
  }).ok);
  falsy("动作存在但 enabled=false ⇒ 拒绝", validateAuthorizedAuto({
    authorization_ref: { actor: "me", action_id: "act_1", scope: ["object"], revision: "rev_1" },
    enabled_actions: [{ action_id: "act_1", enabled: false }], operations: [{ type: "create" }],
  }).ok);
  falsy("scope 超出对象/新建/45 ⇒ 拒绝", validateAuthorizedAuto({
    authorization_ref: { actor: "me", action_id: "act_1", scope: ["whole_vault"], revision: "rev_1" },
    enabled_actions: enabled, operations: [{ type: "create" }],
  }).ok);
  falsy("自动路径含 update ⇒ 拒绝（只准低风险新建）", validateAuthorizedAuto({
    authorization_ref: { actor: "me", action_id: "act_1", scope: ["object"], revision: "rev_1" },
    enabled_actions: enabled, operations: [{ type: "create" }, { type: "update" }],
  }).ok);
  falsy("authorization_ref 缺字段 ⇒ 拒绝", validateAuthorizedAuto({
    authorization_ref: { actor: "me" }, enabled_actions: enabled, operations: [{ type: "create" }],
  }).ok);
  falsy("authorization_ref 缺失 ⇒ 拒绝", validateAuthorizedAuto({ enabled_actions: enabled }).ok);
  falsy("把授权当 confirmation_evidence ⇒ 拒绝", validateAuthorizedAuto({
    authorization_ref: { actor: "me", action_id: "act_1", scope: ["object"], revision: "rev_1", is_confirmation_evidence: true },
    enabled_actions: enabled, operations: [{ type: "create" }],
  }).ok);
  falsy("无写权限 ⇒ 拒绝", validateAuthorizedAuto({
    authorization_ref: { actor: "me", action_id: "act_1", scope: ["object"], revision: "rev_1" },
    enabled_actions: enabled, operations: [{ type: "create" }], consent_scope: { can_write: false },
  }).ok);

  // 编译器自己**绝不**产出 authorized_auto
  const res = await compiler().propose(mkRequest(), makeHost({ draft: { outcome: "proposal", operations: [mkOp()] } }));
  await expectCode("编译器自己走 authorized_auto ⇒ 拒绝（须提交器 submitter_verified）",
    () => buildChangeProposal(res, {
      job_id: "j", proposal_id: "p", input_fingerprint: H("c"), dedup_check: mkRequest().dedup_check,
      application_mode: "authorized_auto",
      authorization_ref: { actor: "me", action_id: "act_1", scope: ["object"], revision: "rev_1" },
      now: "2026-10-10T12:00:00Z",
    }), "MODEL_MUST_NOT_CHOOSE_APPLICATION_MODE", { state: "failed" });
  await expectCode("manual 模式带 authorization_ref ⇒ 拒绝",
    () => buildChangeProposal(res, {
      job_id: "j", proposal_id: "p", input_fingerprint: H("c"), dedup_check: mkRequest().dedup_check,
      application_mode: "manual", authorization_ref: { actor: "me", action_id: "act_1", scope: ["object"], revision: "rev_1" },
      now: "2026-10-10T12:00:00Z",
    }), "INVALID_COMBINATION", { state: "failed" });

  // 提交器校验通过后，才允许写入 authorized_auto，且它不是 confirmation_evidence
  const auto = buildChangeProposal(res, {
    job_id: "j", proposal_id: "p", input_fingerprint: H("c"), dedup_check: mkRequest().dedup_check,
    application_mode: "authorized_auto",
    authorization_ref: { actor: "me", action_id: "act_1", scope: ["object", "create", "45"], revision: "rev_1" },
    submitter_verified: true,
    enabled_actions: enabled,
    now: "2026-10-10T12:00:00Z",
  });
  is("提交器校验后可写 authorized_auto", auto.data.application_mode, "authorized_auto");
  is("authorization_ref 被记录", auto.data.authorization_ref.action_id, "act_1");
  is("scope 规范化为字符串（M1 schema 要求非空字符串）", auto.data.authorization_ref.scope, "object+create+45");
  falsy("授权引用**不是** confirmation_evidence", Object.prototype.hasOwnProperty.call(auto.data, "confirmation_evidence"));
  truthy("自动模式提案仍通过 validateNote", validateNote(auto.data, { mode: "formal", objectType: "change_proposal", domain: BOOK_DOMAIN }).ok);

  // 提交器即便自称已核验，也必须过同一套授权校验
  await expectCode("提交器自称已核验但授权是假动作 ⇒ 仍被拒",
    () => buildChangeProposal(res, {
      job_id: "j", proposal_id: "p", input_fingerprint: H("c"), dedup_check: mkRequest().dedup_check,
      application_mode: "authorized_auto",
      authorization_ref: { actor: "me", action_id: "act_fake", scope: "object", revision: "rev_1" },
      submitter_verified: true, enabled_actions: enabled, now: "2026-10-10T12:00:00Z",
    }), "AUTHORIZATION_INVALID", { state: "failed" });
  await expectCode("提交器自称已核验但含 update ⇒ 仍被拒（只准低风险新建）",
    () => buildChangeProposal({ ...res, operations: [{ ...res.operations[0] }, { ...res.operations[0], type: "update" }] }, {
      job_id: "j", proposal_id: "p", input_fingerprint: H("c"), dedup_check: mkRequest().dedup_check,
      application_mode: "authorized_auto",
      authorization_ref: { actor: "me", action_id: "act_1", scope: "object", revision: "rev_1" },
      submitter_verified: true, enabled_actions: enabled, now: "2026-10-10T12:00:00Z",
    }), "AUTHORIZATION_INVALID", { state: "failed" });

  deep("scope 规范化：数组 → + 连接字符串", C.normalizeAuthorizationScope(["object", "create", "45"]), "object+create+45");
  deep("scope 规范化：字符串去空白", C.normalizeAuthorizationScope("  object "), "object");
  is("scope 规范化：非法类型 → null", C.normalizeAuthorizationScope(42), null);
}

// =========================================================================== //
console.log("\n[15] cursor 守卫：编译器永不推进 session cursor（PRD :981）");

{
  const eff = compileCursorEffect();
  is("cursor 效果 advanced=false", eff.advanced, false);
  is("cursor 效果带明确原因", eff.reason, "COMPILER_NEVER_ADVANCES_SESSION_CURSOR");
  deep("cursor 效果键集合闭合", Object.keys(eff).sort(), ["advanced", "reason"]);

  const res = await compiler().propose(mkRequest(), makeHost());
  const deepKeys = (o, acc = []) => {
    if (o === null || typeof o !== "object") return acc;
    if (Array.isArray(o)) { o.forEach((v) => deepKeys(v, acc)); return acc; }
    for (const [k, v] of Object.entries(o)) { acc.push(k); deepKeys(v, acc); }
    return acc;
  };
  const keys = deepKeys(res);
  for (const banned of ["cursor", "processed_through_seq", "durable_through_seq", "observed_through_seq"]) {
    falsy(`结果里没有 ${banned} 字段（不推进 cursor）`, keys.includes(banned));
  }
  deep("结果顶层键恰好 6 个（结构上不可能夹带 cursor）", Object.keys(res), [...COMPILE_RESULT_KEYS]);
}

// =========================================================================== //
console.log("\n[16] 替身忠实性元检查（替身退化必须被识破）");

{
  // --- 元检查 1：readSourceSpan 不发明 hash ---
  const host = makeHost();
  const unknown = await host.readSourceSpan("sp_nope");
  is("忠实替身对未知 span 返回 ok:false", unknown.ok, false);
  is("忠实替身对未知 span 标 unavailable", unknown.availability, "unavailable");
  falsy("忠实替身不发明 text_hash", "text_hash" in unknown);

  // --- 元检查 2：generateStructured 原样返回草稿（不预先修正） ---
  const rawDraft = { outcome: "proposal", operations: [mkOp({ origin: "user", confirmation: "confirmed" })] };
  const host2 = makeHost({ draft: rawDraft });
  const returned = await host2.generateStructured({});
  is("替身原样返回草稿（不替编译器做校验）", returned.operations[0].confirmation, "confirmed");

  // --- 元检查 3：readCheckedNote 忠实返回声明 hash ---
  const host3 = makeHost({ notes: { note_1: { object_id: "note_1", relative_path: "45-书籍/a.md", content_hash: H("b") } } });
  const read = await host3.readCheckedNote("chk_1", "note_1");
  is("忠实替身返回真实 hash", read.content_hash, H("b"));
  is("忠实替身记录调用（可观测）", host3.__calls.readCheckedNote.length, 1);

  // --- 元检查 4：不忠实替身**确实**产生了坏数据（否则反向验证是装饰） ---
  const unfaithful = makeHost({
    mode: "unfaithful",
    notes: { note_1: { object_id: "note_1", relative_path: "45-书籍/a.md", content_hash: H("b") } },
  });
  const badRead = await unfaithful.readCheckedNote("chk_1", "note_1");
  isNot("不忠实替身返回的 hash **不等于**声明 hash（变异真实存在）", badRead.content_hash, H("b"));
  is("不忠实替身返回的 hash 是它自己编的", badRead.content_hash, H("f"));

  // --- 反向验证：编译器必须识破不忠实替身 ---
  const matchedDedup = mkDedup({
    local_result: "matched",
    candidate_refs: [{ candidate_id: "note_1", object_id: "note_1", relative_path: "45-书籍/a.md", content_hash: H("b") }],
  });
  const gate = await runDedupGate(mkRequest({ dedup_check: matchedDedup }), unfaithful);
  is("编译器识破不忠实替身：记 SNAPSHOT_HASH_MISMATCH", gate.conflicts[0]?.reason, "SNAPSHOT_HASH_MISMATCH");
  truthy("编译器把该候选降为 stale", gate.verified_candidates[0].stale);

  const err = await compiler().propose(
    mkRequest({ dedup_check: matchedDedup, current_note_snapshots_and_hashes: [mkSnapshot({ object_id: "note_1", relative_path: "45-书籍/a.md" })] }),
    unfaithful,
  ).then((r) => r, (e) => e);
  is("不忠实替身下 no_change 被挡住（NOTE_HASH_CONFLICT）", err.code, "NOTE_HASH_CONFLICT");

  // --- 反向验证：不忠实草稿（自称 confirmed / user）必须被拒 ---
  const err2 = await compiler().propose(
    mkRequest(),
    makeHost({ draft: { outcome: "proposal", operations: [mkOp({ origin: "user", confirmation: "confirmed", user_confirmed_ai: true })] } }),
  ).then((r) => r, (e) => e);
  is("不忠实草稿被拒为 NO_VALID_OPERATION", err2?.code, "NO_VALID_OPERATION");
  truthy("拒绝明细含 MODEL_CANNOT_CONFIRM", JSON.stringify(err2?.detail ?? null).includes("MODEL_CANNOT_CONFIRM"));

  // --- 元检查 5：readHostTurns 忠实返回 ok:false 时编译器必须挡 ---
  const hostTurnsBad = makeHost({ turns: { ok: false, code: "HOST_UNSUPPORTED" } });
  const reqWithSession = mkRequest({
    host_source_refs: [{ session_id: "session_1", branch_id: "session_1", source_revision: mkRange().source_revision, through_seq: 9 }],
    verified_durability_range: mkRange(),
    effective_turns_in_memory: [mkTurn()],
  });
  await expectCode("宿主轮次不可读 ⇒ blocked（不凭不可读来源生成提案）",
    () => compiler().propose(reqWithSession, hostTurnsBad), "SOURCE_UNAVAILABLE", { state: "blocked" });
  is("确实调用了 readHostTurns", hostTurnsBad.__calls.readHostTurns.length, 1);
}

// =========================================================================== //
console.log("\n[17] 只读与依赖闭包");

{
  const src = readFileSync(COMPILER_PATH, "utf8");
  falsy("不引入 node:fs", /from\s+["']node:fs["']/.test(src));
  falsy("不引入 node:child_process", /from\s+["']node:child_process["']/.test(src));
  falsy("不引入 cordis / dsh-skill", /from\s+["']@deepseek-ai\//.test(src));
  falsy("不写文件（无 writeFile / rename / unlink）", /writeFileSync|writeFile\(|renameSync|unlinkSync/.test(src));
  truthy("依赖闭包只含 ./schema.js、./coverage.js 与 ./book-domain.js", (() => {
    const imports = [...src.matchAll(/from\s+["'](\.[^"']+)["']/g)].map((m) => m[1]).sort();
    return JSON.stringify(imports) === JSON.stringify(["./book-domain.js", "./coverage.js", "./schema.js"]);
  })());
  truthy("导出了 PRD 要求的 KnowledgeCompiler.propose", typeof KnowledgeCompiler === "function" && typeof KnowledgeCompiler.prototype.propose === "function");
  truthy("propose 是异步的（宿主能力可能异步）", KnowledgeCompiler.prototype.propose.constructor.name === "AsyncFunction");
  truthy("便捷入口 propose 存在", typeof propose === "function");
}

// =========================================================================== //
console.log("\n[18] 无法离线验证（显式跳过，三分处理，不算通过）");

skip("真实 LLM 是否遵守编译规则", "需要真实模型调用；离线只能验证「不合规草稿必被拒」，不能验证「模型一定产出合规草稿」");
skip("提案经 M1 file-service 事务真实落盘并幂等重放", "M4 范围不含接线与写盘；需 M5/接线后在真实 vault 上验证");
skip("真实宿主 capabilities 的实现语义", "需重启宿主并接线（执行计划 §1 表 #7），本轮明确未做");

// =========================================================================== //
console.log(`\n结果：${pass} 通过 / ${fail} 失败 / ${skipped} 跳过`);
process.exit(fail === 0 ? 0 : 1);
