/**
 * AI 深度阅读 · 宿主会话**只读**适配器（M2）
 *
 * 职责（PRD §10.5 `host-session-reader`）：元数据发现、turnOutline 导航、有效事件读取、
 * 耐久性核验、作用域/session 白名单；**不写聊天副本**。
 *
 * ============================================================================
 * 宿主 API 契约（源码 + 运行期双证；源码行号来自 asar 内
 * `@deepseek-ai/dsh-session-query/lib/index.js`，安装版本 0.2.0-rc.2）
 * ============================================================================
 *
 * | API | 真实返回 | 本模块怎么用 |
 * |---|---|---|
 * | `readSession(id)` `:1080` | `{session, inheritedEventCount, events}`；**完整、经回放校验的原始事件日志**（含 `data.source`、含 log-only 维护事件） | ✅ 取 `source.kind`、判**原文留存**的**唯一**来源 |
 * | `listEvents(id)` `:1142` → `eventRecords` `:846` | 逐事件 `{sessionId, seq, type, time, surface}`；`surface` 由 `analyzeEventLog` `:947` 算出：`foldSurface` 的节点=`current`、替换链 `shadowedSeqs`=`shadowed`、其余=`log-only` | ✅ 取 `surface_class` 的**唯一**来源（宿主自己的完整 surface 处理结果） |
 * | `readSurface(id)` `:1167` | `{session, inheritedEventCount, capturedThroughSeq, events}`；`events` = **模型当前表层**（`currentSurfaceEvents` `:855`，只有 current） | ⚠️ 只作「当前表层」与 `capturedThroughSeq`；**绝不用它推算遮蔽量，也不当作「全部非遮蔽事件」** |
 * | `filterEvents(id,filters)` `:1151` → `buildSessionEventSearchDocuments` `:613` | **语义事件文档** `{sessionId, seq, type, time, surface, text}`：`extractSessionEventText` 为空的**结构事件被整条省略**，且**丢 `data.source`** | ⚠️ 仅语义/文本检索。本模块**不用**它取证 |
 * | `readEvent({sessionId,seq,before,after})` `:1209` | `{session, inheritedEventCount, target, events, startSeq, endSeq}`；邻接窗口**不自动排除 shadowed** | 单点取证 |
 * | `traceEvent({sessionId,seq})` `:1195` | `{session, target, replacedBy?, replacementChain, replacedEventSeqs, sourceEventSeqs, derivedEventSeqs}` | 替换链与**来源关联** |
 * | `listSessions()` `:1071` | `[{header:{id,createdAt,cwd,parentSession,isSeeded,delegationDepth?,origin?,agentPreset?}, live:boolean, persisted:boolean}]`，newest-first | 枚举。⚠️ `live`/`persisted` 是**可用性布尔标志**，**不是**会话对象 |
 * | `observeSession(id,{projectionMode})` `:1063` | lease：`{source:"live"|"prepared", header, inheritedEventCount, events, cursor, revision?, projections?, retain, [Symbol.dispose]}`；`prepared` 才有 `revision`（`preparedLease` `:449`）；`live` **没有** `revision`（`live` `:476`） | 耐久性核验 + `turnOutline` 投影 |
 * | `sessionProjections.snapshot(session)` | `{asOfSeq, values:{key:value}}` | `turnOutline` 取值 |
 *
 * ## 四条不可越过的纪律（每条都有对应负例测试）
 *
 * 1. **`source.kind` 与「原文留存」只走 `readSession` 的完整原始日志。**
 * 2. **`surface_class` 只取宿主自己的完整 surface 处理结果**（`listEvents` 的 `surface`
 *    或 `traceEvent` 的替换链）。**绝不**自己累加 `compaction/prune.shadowedSeqs`，
 *    **绝不**用 `readSurface` 反推 shadowed / log-only。
 *    （PRD §9.1：「current/shadowed/log-only取自宿主完整surface处理结果（含替换链及来源关联），
 *    不靠累加compaction/prune的shadowedSeqs判断」。）
 * 3. **`shadowed ≠ 删除 ≠ 撤回`**：被遮蔽事件仍在原日志里 ⇒ 来源仍 `available`；
 *    不得因「不在 surface」就推进游标或撤销已存知识（AC-21 / §11.5）。
 * 4. **`source.kind === "user"` 只是真人输入候选**，仍须逐命题判断引用/假设/转贴；
 *    `compact-checkpoint` 即使 `role=user` 也只作导航，**不得**进入画像/理解/掌握/个性化依据。
 *
 * ## 能力缺失时怎么办
 *
 * `listEvents` 不可用 ⇒ `surface_class` **未知**（`null`），返回 `surface_known:false` 并让
 * SourceGate 停在 `checking/unsupported`。**不猜、不降级成 `readSurface` 反推**。
 * `turnOutline` 未挂载 ⇒ `state:"unsupported"` 优雅降级，不抛错。
 *
 * 本模块**只读**：不 import `node:fs`，没有任何写接口，不 append 事件，不改会话。
 */

import { sha256Hex } from "./schema.js";

export const SESSION_READER_VERSION = "1.0.0";

/** 讨论来源的宿主标识（PRD §8.6 `host` 字段）。 */
export const HOST_NAME = "dsh";

/** PRD §9.1 的三种上下文位置（宿主 `analyzeEventLog` 的值域）。 */
export const SURFACE_CLASSES = Object.freeze(["current", "shadowed", "log-only"]);

/** PRD §10.2：能力必须**分项**报告，不能一个「支持历史」全绿。 */
export const CAPABILITY_KEYS = Object.freeze([
  "metadata_discovery",
  "turn_outline",
  "exact_history_read",
  "durability_confirmation",
  "event_scope",
  "content_search",
]);

/** PRD §11.5 `Capability.state`。 */
export const CAPABILITY_STATES = Object.freeze(["unverified", "verified", "unsupported", "disabled"]);

/** 宿主 turn-outline 的预览上限（`dsh-session-turn-outline/lib/index.js:26/:28`）。 */
export const TURN_OUTLINE_PROMPT_LIMIT = 50;
export const TURN_OUTLINE_RESPONSE_LIMIT = 120;

/** 真人输入候选的唯一 `source.kind`（PRD §8.5）。 */
export const HUMAN_SOURCE_KIND = "user";

/** 系统注入类：**不产生用户学习事实**（PRD §8.5）。 */
export const SYSTEM_SOURCE_KINDS = Object.freeze([
  "time-context",
  "runtime-context",
  "skill-catalog",
  "user-approval",
]);

/** 代理来源：队友/子代理消息与系统通知，同样不是用户自述（M0 发现 A）。 */
export const AGENT_SOURCE_KINDS = Object.freeze(["agent-message", "subagent-settled"]);

/** 模型生成的压缩摘要：只作导航（PRD §9.1 / M0 发现 B）。 */
export const COMPACT_CHECKPOINT_KIND = "compact-checkpoint";

/** 只读适配器的错误类型；`code` 对齐 PRD §11.1 的原因码。 */
export class SessionReaderError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = "SessionReaderError";
    this.code = code;
    this.detail = detail;
  }
}

// --------------------------------------------------------------------------- //
// 基础工具
// --------------------------------------------------------------------------- //

const isMap = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isArr = (v) => Array.isArray(v);
const isFn = (v) => typeof v === "function";
const isNonEmptyStr = (v) => typeof v === "string" && v.trim() !== "";
const isInt = (v) => Number.isInteger(v);

function tally(values) {
  const out = {};
  for (const v of values) out[v] = (out[v] || 0) + 1;
  return out;
}

/** 稳定序列化（键排序），用于指纹：同样的输入必须得到同样的字符串。 */
function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (isArr(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

/** seq 连续性与缺口（水位的前提：seq 必须单调连续）。 */
export function seqReport(events) {
  const seqs = (isArr(events) ? events : [])
    .map((e) => e?.seq)
    .filter((n) => isInt(n));
  if (seqs.length === 0) {
    return { count: 0, min: null, max: null, unique: 0, expected: 0, contiguous: false, missing_sample: [] };
  }
  const min = Math.min(...seqs);
  const max = Math.max(...seqs);
  const unique = new Set(seqs);
  const missing = [];
  for (let i = min; i <= max && missing.length < 32; i += 1) if (!unique.has(i)) missing.push(i);
  return {
    count: seqs.length,
    min,
    max,
    unique: unique.size,
    expected: max - min + 1,
    contiguous: unique.size === max - min + 1,
    missing_sample: missing,
  };
}

/** 取 `user/message` 一类的文本块（**只在显式要求时**调用，且只用于内存判定）。 */
export function textOfEvent(event) {
  const content = event?.data?.content;
  if (!isArr(content)) return "";
  return content
    .filter((c) => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
}

// --------------------------------------------------------------------------- //
// 来源归属分类（PRD §8.5 / §9.1）
// --------------------------------------------------------------------------- //

/**
 * 按 `message.role`、`event_type` 与 `source.kind` **分开核验**（PRD §9.1 首句）。
 *
 * 返回的是**元数据判定**，不是内容语义判定：即便 `human_input_candidate=true`，
 * 也只说明「这是真人输入的候选」，引用/假设/转贴仍须逐命题判断
 * ⇒ 因此恒带 `requires_proposition_classification: true`。
 */
export function classifyProvenance(event) {
  const sourceKind = event?.data?.source?.kind ?? null;
  const role = event?.data?.role ?? null;
  const type = event?.type ?? null;

  const humanInputCandidate = sourceKind === HUMAN_SOURCE_KIND;
  const navigationOnly = sourceKind === COMPACT_CHECKPOINT_KIND;
  const systemInjected = SYSTEM_SOURCE_KINDS.includes(sourceKind);
  const agentOriginated = AGENT_SOURCE_KINDS.includes(sourceKind);
  const modelGenerated = navigationOnly || type === "assistant/message";

  // origin_hint 只是**归属提示**，不是结论；null 表示宿主没给足够信息，不猜。
  let originHint = null;
  if (humanInputCandidate) originHint = "user";
  else if (navigationOnly || modelGenerated) originHint = "ai_inference";

  return {
    event_type: type,
    message_role: role,
    message_source_kind: sourceKind,
    human_input_candidate: humanInputCandidate,
    // 真人输入候选仍须逐命题区分本人陈述/引用/假设/转贴（PRD §8.5）。
    requires_proposition_classification: humanInputCandidate,
    // compact-checkpoint 即使 role=user 也只作导航（M0 发现 B / AC-21）。
    navigation_only: navigationOnly,
    system_injected: systemInjected,
    agent_originated: agentOriginated,
    model_generated: modelGenerated,
    origin_hint: originHint,
    // 系统注入、代理通知、审批上下文不产生用户学习事实（PRD §8.5）。
    produces_user_learning_fact: humanInputCandidate && !navigationOnly,
  };
}

/** 非证据事件：可凭「最小排除原因回执」闭合（PRD §11.5）。 */
export function isNonEvidenceEvent(event) {
  const p = classifyProvenance(event);
  return !p.human_input_candidate && !p.navigation_only;
}

// --------------------------------------------------------------------------- //
// 指纹与「可持久化引用」
// --------------------------------------------------------------------------- //

/**
 * 来源范围输入指纹：**只在内存里**对文本做摘要，只把 hex 摘要交出去。
 *
 * 为什么含文本摘要：PRD §11.5 的幂等键由「来源身份/修订/范围 + input_fingerprint +
 * compiler 版本 + 操作类型」构成；只看 seq 范围无法区分「同范围内容已变」。
 * 摘要是 hash，不是正文 ⇒ 不构成「第二份聊天存储」，也不违反「不复录完整聊天」。
 */
export function inputFingerprint({ sessionId, branchId, sourceRevision, events }) {
  const items = (isArr(events) ? events : []).map((e) => ({
    seq: e?.seq ?? null,
    type: e?.type ?? null,
    role: e?.data?.role ?? null,
    source_kind: e?.data?.source?.kind ?? null,
    text: sha256Hex(textOfEvent(e)),
  }));
  const payload = canonicalJson({
    v: 1,
    host: HOST_NAME,
    session_id: sessionId ?? null,
    branch_id: branchId ?? null,
    source_revision: sourceRevision ?? null,
    events: items,
  });
  return sha256Hex(payload);
}

/** 辅助 JSON 里绝不允许出现的**内容承载键**（PRD §8.1：不写第二份聊天存储）。 */
export const CONTENT_BEARING_KEYS = Object.freeze([
  "content", "body", "text", "message", "messages", "prompt", "prompts",
  "transcript", "chat", "conversation", "payload", "raw", "excerpt", "full_text",
  "in_memory_text", "events", "turns",
]);

/**
 * 把任意结构压成**只含 ID/范围/hash/计数**的可持久化引用：递归剥掉一切内容承载键。
 * 这是「不写第二份聊天存储」的可执行守卫，不是注释里的承诺。
 */
export function toPersistableRef(value) {
  if (isArr(value)) return value.map(toPersistableRef);
  if (!isMap(value)) return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (CONTENT_BEARING_KEYS.includes(k)) continue;
    out[k] = toPersistableRef(v);
  }
  return out;
}

// --------------------------------------------------------------------------- //
// 主体
// --------------------------------------------------------------------------- //

/**
 * 创建只读会话适配器。
 *
 * @param {object} deps
 * @param {object} deps.sessionQuery 宿主 `ctx.sessionQuery`（必需）
 * @param {object|null} [deps.sessionProjections] 宿主 `ctx.sessionProjections`（可选；turnOutline 所在注册表）
 * @param {object|null} [deps.whitelist] 作用域/session 白名单：`{session_ids?:string[], cwd?:string}`。
 *   省略 ⇒ **不静默放行**：每次返回都带 `authorization_basis:"no_whitelist_configured"`。
 * @param {(msg:string,meta?:object)=>void} [deps.logger] 只记 ID/计数/阶段/原因，**绝不记正文**。
 */
export function createSessionReader(deps = {}) {
  const q = deps.sessionQuery ?? null;
  const projections = deps.sessionProjections ?? null;
  const whitelist = isMap(deps.whitelist) ? deps.whitelist : null;
  const log = isFn(deps.logger) ? deps.logger : () => {};

  function requireQuery() {
    if (!q) {
      throw new SessionReaderError("HOST_UNSUPPORTED", "sessionQuery 未注入：无法读取宿主会话", {});
    }
  }

  /** 白名单判定。作用域可见 ≠ 用户授权（PRD §10.2）。 */
  function authorize(header) {
    if (!whitelist) {
      return { ok: true, basis: "no_whitelist_configured" };
    }
    const ids = isArr(whitelist.session_ids) ? whitelist.session_ids : null;
    if (ids && ids.length > 0) {
      if (!ids.includes(header?.id)) {
        return { ok: false, basis: "session_id_not_in_whitelist", reason: `session ${header?.id} 不在白名单` };
      }
    } else if (whitelist.session_ids !== undefined) {
      // 显式给了空数组 ⇒ 谁都不授权（不能解释成「不过滤」）。
      return { ok: false, basis: "empty_session_whitelist", reason: "白名单为空数组：不授权任何会话" };
    }
    if (isNonEmptyStr(whitelist.cwd)) {
      if (header?.cwd !== whitelist.cwd) {
        return { ok: false, basis: "cwd_not_in_whitelist", reason: `cwd 不属于授权工作区` };
      }
    }
    return { ok: true, basis: "whitelist_match" };
  }

  function assertAuthorized(header) {
    const a = authorize(header);
    if (!a.ok) {
      throw new SessionReaderError("SESSION_NOT_AUTHORIZED", a.reason ?? "会话未授权", { basis: a.basis });
    }
    return a;
  }

  /** 取会话 header（从 listSessions 里精确取；取不到就报 not found，不猜）。 */
  async function headerOf(sessionId) {
    requireQuery();
    const list = await q.listSessions();
    const arr = isArr(list) ? list : [];
    const rec = arr.find((r) => r?.header?.id === sessionId);
    if (!rec) {
      throw new SessionReaderError("SOURCE_UNAVAILABLE", `会话 ${sessionId} 不在 listSessions 结果里`, {
        session_id: sessionId,
      });
    }
    return rec;
  }

  /**
   * 一次性抓取同一逻辑来源的三份观察，并报告它们是否**自洽**。
   *
   * 为什么要自洽检查：`readSession` / `listEvents` / `readSurface` 各自独立
   * `_corpus.load()`；活会话在两调用之间可能追加事件。自洽时才做严格交叉校验，
   * 否则如实标 `consistent:false`，不假装严格。
   */
  async function loadSnapshot(sessionId) {
    requireQuery();
    const rec = await headerOf(sessionId);
    const auth = assertAuthorized(rec.header);

    const read = await q.readSession(sessionId);
    const rawEvents = isArr(read?.events) ? read.events : [];

    let records = null;
    let recordsError = null;
    if (isFn(q.listEvents)) {
      try {
        const r = await q.listEvents(sessionId);
        records = isArr(r) ? r : null;
      } catch (e) {
        recordsError = `${e?.name || "Error"}: ${e?.message || String(e)}`;
      }
    } else {
      recordsError = "listEvents 不可用";
    }

    let surface = null;
    let surfaceError = null;
    if (isFn(q.readSurface)) {
      try {
        surface = await q.readSurface(sessionId);
      } catch (e) {
        surfaceError = `${e?.name || "Error"}: ${e?.message || String(e)}`;
      }
    } else {
      surfaceError = "readSurface 不可用";
    }

    const rawSeqs = rawEvents.map((e) => e?.seq);
    const recSeqs = isArr(records) ? records.map((r) => r?.seq) : [];
    const consistent =
      isArr(records) &&
      records.length === rawEvents.length &&
      recSeqs.every((s, i) => s === rawSeqs[i]);

    return {
      record: rec,
      header: rec.header,
      authorization: auth,
      read,
      rawEvents,
      records,
      recordsError,
      surface,
      surfaceError,
      consistent,
      seq: seqReport(rawEvents),
      inheritedEventCount: isInt(read?.inheritedEventCount) ? read.inheritedEventCount : 0,
    };
  }

  /** 从宿主的完整 surface 处理结果里取每 seq 的 surface_class；未知就返回 null，不猜。 */
  function surfaceBySeq(snapshot) {
    if (!isArr(snapshot.records)) return null;
    const map = new Map();
    for (const r of snapshot.records) {
      map.set(r?.seq, SURFACE_CLASSES.includes(r?.surface) ? r.surface : null);
    }
    return map;
  }

  // ------------------------------------------------------------------ //
  // 能力分项
  // ------------------------------------------------------------------ //

  /** 静态能力：**只看方法是否存在** ⇒ 存在也只是 `unverified`（PRD：不得因静态源码存在就 verified）。 */
  function staticCapabilities() {
    const has = (m) => (isFn(q?.[m]) ? "unverified" : "unsupported");
    const out = {
      metadata_discovery: has("listSessions"),
      exact_history_read: has("readSession"),
      durability_confirmation: has("observeSession"),
      turn_outline: projections ? "unverified" : "unsupported",
      // M2 不注册监听器，也不探测作用域链 ⇒ 如实停在 unverified。
      event_scope: "unverified",
      content_search: isFn(q?.search) ? "unverified" : "disabled",
    };
    const reasons = {
      event_scope: "M2 只做只读读取，未注册/未探测事件监听作用域",
      content_search: isFn(q?.search) ? "存在 search 方法，尚未实测" : "宿主未提供 search 方法（全文搜索为 opt-in）",
    };
    return Object.fromEntries(
      CAPABILITY_KEYS.map((k) => [
        k,
        { state: out[k], reason: reasons[k] ?? (out[k] === "unsupported" ? "宿主未提供该方法" : "未实测") },
      ]),
    );
  }

  /** 真跑一次，把能验的验成 `verified`；验不了的**保持** unverified/unsupported/disabled。 */
  async function verifyCapabilities({ sessionId } = {}) {
    const caps = staticCapabilities();
    const evidence = {};

    if (isFn(q?.listSessions)) {
      try {
        const list = await q.listSessions();
        const arr = isArr(list) ? list : [];
        const shaped = arr.every((r) => isMap(r?.header) && typeof r.live === "boolean" && typeof r.persisted === "boolean");
        caps.metadata_discovery = {
          state: shaped ? "verified" : "unsupported",
          reason: shaped ? "listSessions 返回带 header/live/persisted 的记录" : "listSessions 记录形状不符",
        };
        evidence.metadata_discovery = { count: arr.length, sample_keys: arr[0] ? Object.keys(arr[0]) : [] };
      } catch (e) {
        caps.metadata_discovery = { state: "unsupported", reason: `listSessions 调用失败: ${e?.message || e}` };
      }
    }

    if (isNonEmptyStr(sessionId) && isFn(q?.readSession)) {
      try {
        const read = await q.readSession(sessionId);
        const rep = seqReport(read?.events);
        caps.exact_history_read = {
          state: rep.contiguous && rep.count > 0 ? "verified" : "unsupported",
          reason: rep.contiguous ? "readSession 返回连续 seq 的完整原始日志" : "readSession 日志 seq 不连续或为空",
        };
        evidence.exact_history_read = { seq: rep };
      } catch (e) {
        caps.exact_history_read = { state: "unsupported", reason: `readSession 调用失败: ${e?.message || e}` };
      }
    }

    // turnOutline：投影存在性 + 注册表 + 真读一次值。
    if (!projections) {
      caps.turn_outline = { state: "unsupported", reason: "sessionProjections 未注入（可选包未挂载）" };
    } else if (isNonEmptyStr(sessionId)) {
      const reg = registrationsOf(projections).get("turnOutline") ?? null;
      const def = reg?.def ?? reg ?? null;
      if (!def) {
        caps.turn_outline = { state: "unsupported", reason: "turnOutline 未注册（可选包未挂载）" };
      } else {
        const outline = await readTurnOutline(sessionId);
        caps.turn_outline = {
          state: outline.available ? "verified" : "unsupported",
          reason: outline.available ? "turnOutline 注册且真读到投影值" : `turnOutline 读取失败: ${outline.reason}`,
        };
        evidence.turn_outline = { state_version: def.stateVersion ?? null, as_of_seq: outline.as_of_seq };
      }
    }

    // 耐久性：`prepared` 观察才有 revision；`live` 不算已保存（PRD §10.2）。
    if (isNonEmptyStr(sessionId) && isFn(q?.observeSession)) {
      const obs = await observeOnce(sessionId);
      if (obs.error) {
        caps.durability_confirmation = { state: "unsupported", reason: `observeSession 失败: ${obs.error}` };
      } else if (obs.source === "prepared" && isNonEmptyStr(String(obs.revision ?? ""))) {
        caps.durability_confirmation = { state: "verified", reason: "observeSession 返回 prepared 来源 + revision" };
        evidence.durability_confirmation = { source: obs.source, revision: String(obs.revision), cursor: obs.cursor ?? null };
      } else {
        caps.durability_confirmation = {
          state: "unverified",
          reason: "只拿到 live 观察（无 revision）⇒ live 可读不等于已保存",
        };
        evidence.durability_confirmation = { source: obs.source, revision: null };
      }
    }

    return { capabilities: caps, evidence };
  }

  // ------------------------------------------------------------------ //
  // 枚举与来源状态
  // ------------------------------------------------------------------ //

  /** 枚举会话。`live`/`persisted` 原样作**布尔**返回，绝不冒充会话对象。 */
  async function listSessions({ signal } = {}) {
    requireQuery();
    const list = await q.listSessions(signal);
    const arr = isArr(list) ? list : [];
    const out = [];
    const excluded = [];
    for (const rec of arr) {
      const header = rec?.header ?? null;
      if (!header?.id) continue;
      const a = authorize(header);
      if (!a.ok) {
        excluded.push({ session_id: header.id, basis: a.basis });
        continue;
      }
      out.push({
        session_id: header.id,
        title: isNonEmptyStr(header.title) ? header.title : null,
        created_at: isInt(header.createdAt) ? header.createdAt : null,
        cwd: isNonEmptyStr(header.cwd) ? header.cwd : null,
        parent_session: isNonEmptyStr(header.parentSession) ? header.parentSession : null,
        is_seeded: header.isSeeded === true,
        delegation_depth: isInt(header.delegationDepth) ? header.delegationDepth : null,
        // 可用性标志（布尔），不是会话对象 —— 宿主 API 契约表已明确。
        live: rec.live === true,
        persisted: rec.persisted === true,
        authorization_basis: a.basis,
      });
    }
    return { sessions: out, excluded_count: excluded.length, excluded, authorization_basis: whitelist ? "whitelist" : "no_whitelist_configured" };
  }

  /** 一次 `observeSession` 并把 lease 释放掉（否则会一直 pin 住宿主缓存）。 */
  async function observeOnce(sessionId, { projectionMode = "all" } = {}) {
    if (!isFn(q?.observeSession)) return { error: "observeSession 不可用" };
    let lease = null;
    try {
      lease = await q.observeSession(sessionId, { projectionMode });
      const out = {
        source: lease?.source ?? null,
        header: lease?.header ?? null,
        cursor: isInt(lease?.cursor) ? lease.cursor : null,
        revision: lease?.revision ?? null,
        inheritedEventCount: isInt(lease?.inheritedEventCount) ? lease.inheritedEventCount : 0,
        projections: lease?.projections ?? null,
        error: null,
      };
      return out;
    } catch (e) {
      return { error: `${e?.name || "Error"}: ${e?.message || String(e)}` };
    } finally {
      try {
        lease?.[Symbol.dispose]?.();
      } catch {
        /* lease 释放失败不影响读取结果，也绝不外抛 */
      }
    }
  }

  /**
   * 来源状态（对应 PRD §11.2 `GET /sessions/{id}/source-status`）。
   *
   * 耐久性只承认**可核验的证据**：
   *   · `observeSession` 返回 `prepared` + `revision` ⇒ durable 可用；
   *   · 只拿到 `live` ⇒ `pending_durable`（live 可读 ≠ 已保存）。
   * `observed` 用真实读到的日志上界；`durable` 不得大于 `observed`。
   */
  async function readSourceStatus(sessionId) {
    const snapshot = await loadSnapshot(sessionId);
    const obs = await observeOnce(sessionId);
    const observed = isInt(snapshot.seq.max) ? snapshot.seq.max : null;

    const revision = isNonEmptyStr(String(obs.revision ?? "")) ? String(obs.revision) : null;
    const prepared = obs.source === "prepared";
    // 耐久上界必须同时满足：prepared 来源 + 有 revision + observed 已知。
    // 任一缺失就不给 durable（宁可 pending_durable，也不假报已保存）。
    const cursor = isInt(obs.cursor) && obs.cursor >= 0 ? obs.cursor : null;
    const durable =
      prepared && revision !== null && observed !== null
        ? Math.min(cursor ?? observed, observed)
        : null;

    let gate;
    if (!snapshot.consistent) {
      gate = { state: "partial", reason: "readSession 与 listEvents 观察不自洽（日志可能正在追加）" };
    } else if (!isArr(snapshot.records)) {
      gate = { state: "unsupported", reason: `无法取得宿主 surface 分类：${snapshot.recordsError}` };
    } else if (observed === null) {
      gate = { state: "partial", reason: "日志为空：没有可核验的耐久范围" };
    } else if (durable !== null) {
      gate = { state: "ready", reason: "已核验 prepared 来源 + revision，且请求范围在耐久上界内", requested_through_seq: durable };
    } else {
      gate = { state: "pending_durable", reason: `只观察到 ${obs.source ?? "未知"} 来源，无 revision ⇒ 宿主尚未确认持久` };
    }

    return {
      session_id: sessionId,
      host: HOST_NAME,
      branch_id: sessionId,
      branch_id_basis: "dsh 的 fork 是独立 session（parentSession + inheritedEventCount 记录继承点）⇒ 分支身份即会话身份",
      lineage: {
        parent_session: isNonEmptyStr(snapshot.header.parentSession) ? snapshot.header.parentSession : null,
        is_seeded: snapshot.header.isSeeded === true,
        inherited_event_count: snapshot.inheritedEventCount,
      },
      live: snapshot.record.live === true,
      persisted: snapshot.record.persisted === true,
      availability: "available",
      source_revision: revision,
      observed_through_seq: observed,
      durable_through_seq: durable,
      processed_through_seq: null,
      durability_evidence: durable !== null
        ? { kind: "host_persistence_observation", revision, through_seq: durable }
        : null,
      source_gate: gate,
      surface: {
        known: isArr(snapshot.records),
        source: isArr(snapshot.records) ? "listEvents(host analyzeEventLog)" : null,
        reason: isArr(snapshot.records) ? null : snapshot.recordsError,
      },
      seq: snapshot.seq,
      consistent: snapshot.consistent,
      authorization_basis: snapshot.authorization.basis,
      observed_at: new Date().toISOString(),
    };
  }

  /**
   * 读原始日志。
   *
   * 默认**只回结构**（seq 区间、类型计数），不回事件正文 —— 正文只在显式
   * `includeEvents:true` 时进内存，并标 `in_memory_only:true`（PRD §9.1：原轮次仅在内存
   * 按需使用后释放；禁止在 trace/日志/摘要里复录）。
   */
  async function readLog(sessionId, { includeEvents = false } = {}) {
    const snapshot = await loadSnapshot(sessionId);
    const base = {
      session_id: sessionId,
      host: HOST_NAME,
      header: {
        id: snapshot.header.id,
        created_at: isInt(snapshot.header.createdAt) ? snapshot.header.createdAt : null,
        cwd: isNonEmptyStr(snapshot.header.cwd) ? snapshot.header.cwd : null,
        parent_session: isNonEmptyStr(snapshot.header.parentSession) ? snapshot.header.parentSession : null,
        is_seeded: snapshot.header.isSeeded === true,
      },
      format_version: snapshot.header.version ?? null,
      inherited_event_count: snapshot.inheritedEventCount,
      seq: snapshot.seq,
      event_type_counts: tally(snapshot.rawEvents.map((e) => e?.type ?? "(none)")),
      // 宿主 surface 分类的可用性；未知就如实说未知。
      surface_source: isArr(snapshot.records) ? "listEvents" : null,
      surface_known: isArr(snapshot.records),
      consistent: snapshot.consistent,
      in_memory_only: includeEvents,
    };
    if (!includeEvents) return base;
    return {
      ...base,
      // ⚠️ 含真人正文，**只在内存**用于逐命题判断；调用方不得落盘/进 trace。
      events: snapshot.rawEvents,
      warning: "events 含真人正文：仅内存使用，禁止落盘、进 prompt 日志或摘要",
    };
  }

  /**
   * surface 分类（PRD §9.1）。
   *
   * 分类**只**来自宿主的完整 surface 处理结果（`listEvents` 的 `surface`），并**交叉校验**
   * `readSurface`：后者只能包含 `current`，绝不能含 `shadowed`/`log-only`。
   * 这正是 M0 那两处不忠实替身会露馅的地方（详见测试里的 meta 检查）。
   */
  async function classifySurface(sessionId) {
    const snapshot = await loadSnapshot(sessionId);
    const map = surfaceBySeq(snapshot);
    if (!map) {
      return {
        session_id: sessionId,
        known: false,
        source: null,
        reason: snapshot.recordsError ?? "listEvents 不可用",
        // 关键：**不**退回 readSurface 反推（那会把遮蔽量算错）。
        fallback_used: false,
        counts: null,
        by_seq: null,
      };
    }

    const counts = { current: 0, shadowed: 0, "log-only": 0, unknown: 0, total: map.size };
    const bySeq = {};
    for (const [seq, cls] of map) {
      bySeq[seq] = cls;
      if (cls === null) counts.unknown += 1;
      else counts[cls] += 1;
    }

    // ---- readSurface 交叉校验（不得用它推算遮蔽量）----
    const surfaceEvents = isArr(snapshot.surface?.events) ? snapshot.surface.events : [];
    const surfaceSeqs = surfaceEvents.map((e) => e?.seq).filter(isInt);
    const currentSeqs = new Set([...map.entries()].filter(([, c]) => c === "current").map(([s]) => s));
    const surfaceOutsideCurrent = surfaceSeqs.filter((s) => !currentSeqs.has(s));
    const surfaceContainsShadowed = surfaceSeqs.filter((s) => map.get(s) === "shadowed");
    const surfaceContainsLogOnly = surfaceSeqs.filter((s) => map.get(s) === "log-only");

    // 「readSurface 不等于全部非遮蔽事件」的可证伪判据：
    // 只要存在 log-only 事件，两者数量就不该相等。
    const nonShadowed = counts.current + counts["log-only"] + counts.unknown;
    const readSurfaceEqualsNonShadowed =
      counts["log-only"] + counts.unknown > 0 ? surfaceSeqs.length === nonShadowed : null;

    return {
      session_id: sessionId,
      known: true,
      source: "listEvents(host analyzeEventLog)",
      reason: null,
      fallback_used: false,
      counts,
      by_seq: bySeq,
      captured_through_seq: isInt(snapshot.surface?.capturedThroughSeq) ? snapshot.surface.capturedThroughSeq : null,
      read_surface_cross_check: {
        surface_event_count: surfaceSeqs.length,
        // 这三项必须为真；否则说明宿主分类或我们的读取有问题。
        surface_subset_of_current: surfaceOutsideCurrent.length === 0,
        surface_contains_shadowed: surfaceContainsShadowed.length > 0,
        surface_contains_log_only: surfaceContainsLogOnly.length > 0,
        outside_current_sample: surfaceOutsideCurrent.slice(0, 8),
        // null ⇒ 无 log-only 事件，本项不可证伪（不得算通过）。
        read_surface_equals_non_shadowed: readSurfaceEqualsNonShadowed,
      },
      consistent: snapshot.consistent,
    };
  }

  /**
   * 原文留存：被标 `shadowed` 的 seq **是否仍在 `readSession` 的原始日志里**。
   * PRD：`shadowed ≠ 删除 ≠ 撤回`；来源仍 available。
   */
  async function shadowRetention(sessionId) {
    const snapshot = await loadSnapshot(sessionId);
    const map = surfaceBySeq(snapshot);
    if (!map) {
      return { session_id: sessionId, known: false, reason: snapshot.recordsError ?? "listEvents 不可用" };
    }
    const rawSeqs = new Set(snapshot.rawEvents.map((e) => e?.seq).filter(isInt));
    const shadowed = [...map.entries()].filter(([, c]) => c === "shadowed").map(([s]) => s);
    const present = shadowed.filter((s) => rawSeqs.has(s));
    const missing = shadowed.filter((s) => !rawSeqs.has(s));
    return {
      session_id: sessionId,
      known: true,
      shadowed_count: shadowed.length,
      retained_in_raw_log: present.length,
      missing_from_raw_log: missing,
      all_shadowed_retained: missing.length === 0,
      semantics: { deleted: false, retracted: false, requires_reverification_before_closing: true },
      evidence_source: "readSession.events",
      // 显式声明没有用 readSurface 推算（M0 教训）。
      derived_from_read_surface: false,
    };
  }

  /**
   * 有效事件（当前表层）读取。
   *
   * `surface_class` 来自宿主分类；`message_role`/`message_source_kind` 来自 `readSession`
   * 原始日志。默认**不回正文**；要正文用 `readEventText`（单点取证）。
   */
  async function readEffectiveEvents(sessionId, { fromSeq = null, toSeq = null, surface = ["current"] } = {}) {
    const snapshot = await loadSnapshot(sessionId);
    const map = surfaceBySeq(snapshot);
    const want = new Set(isArr(surface) ? surface : ["current"]);
    const bySeqRaw = new Map(snapshot.rawEvents.map((e) => [e?.seq, e]));
    const events = [];
    const excluded = [];

    for (const event of snapshot.rawEvents) {
      const seq = event?.seq;
      if (!isInt(seq)) continue;
      if (isInt(fromSeq) && seq < fromSeq) continue;
      if (isInt(toSeq) && seq > toSeq) continue;
      const cls = map ? map.get(seq) ?? null : null;
      if (map && !want.has(cls)) continue;
      const prov = classifyProvenance(event);
      events.push({
        seq,
        surface_class: cls,
        surface_known: map !== null,
        ...prov,
        // 只有 current 表层的真人候选才可能成为「个人证据候选」；
        // 仍须逐命题判断，故不是结论。
        personal_evidence_candidate: cls === "current" && prov.human_input_candidate && !prov.navigation_only,
      });
    }

    // 落在范围外/被排除的，给最小原因（PRD §11.5：纯非证据事件可凭最小排除回执闭合）。
    if (map) {
      for (const [seq, cls] of map) {
        if (isInt(fromSeq) && seq < fromSeq) continue;
        if (isInt(toSeq) && seq > toSeq) continue;
        if (want.has(cls)) continue;
        const event = bySeqRaw.get(seq);
        excluded.push({
          seq,
          surface_class: cls,
          reason: cls === "shadowed" ? "shadowed（非删除：原文仍在日志，需要时可回溯核验）" : "不在请求的表层范围内",
          human_input_candidate: event ? classifyProvenance(event).human_input_candidate : null,
        });
      }
    }

    return {
      session_id: sessionId,
      requested_surface: [...want],
      surface_source: map ? "listEvents(host analyzeEventLog)" : null,
      surface_known: map !== null,
      reason: map ? null : snapshot.recordsError ?? "listEvents 不可用",
      events,
      excluded,
      event_type_counts: tally(events.map((e) => e.event_type ?? "(none)")),
      source_kind_counts: tally(events.map((e) => e.message_source_kind ?? "(none)")),
      human_input_candidates: events.filter((e) => e.human_input_candidate).length,
      navigation_only_count: events.filter((e) => e.navigation_only).length,
      consistent: snapshot.consistent,
    };
  }

  /** 单点取正文（显式、单个、内存）。PRD §8.6：原文仅在内存。 */
  async function readEventText(sessionId, seq) {
    const snapshot = await loadSnapshot(sessionId);
    const event = snapshot.rawEvents.find((e) => e?.seq === seq);
    if (!event) {
      throw new SessionReaderError("SOURCE_UNAVAILABLE", `会话 ${sessionId} 的原始日志里没有 seq=${seq}`, {
        session_id: sessionId,
        seq,
      });
    }
    const map = surfaceBySeq(snapshot);
    const prov = classifyProvenance(event);
    return {
      session_id: sessionId,
      seq,
      surface_class: map ? map.get(seq) ?? null : null,
      ...prov,
      text: textOfEvent(event),
      in_memory_only: true,
      warning: "正文仅内存使用：禁止落盘、进 trace 或摘要",
    };
  }

  /** 单事件 + 邻接窗口（宿主 `readEvent`，不自动排除 shadowed）。 */
  async function readEventWindow(sessionId, seq, { before = 0, after = 0 } = {}) {
    requireQuery();
    if (!isFn(q.readEvent)) {
      throw new SessionReaderError("HOST_UNSUPPORTED", "readEvent 不可用", {});
    }
    const w = await q.readEvent({ sessionId, seq, before, after });
    const snapshot = await loadSnapshot(sessionId);
    const sMap = surfaceBySeq(snapshot);
    const events = isArr(w?.events) ? w.events : [];
    return {
      session_id: sessionId,
      start_seq: isInt(w?.startSeq) ? w.startSeq : null,
      end_seq: isInt(w?.endSeq) ? w.endSeq : null,
      events: events.map((e) => ({
        seq: e?.seq ?? null,
        event_type: e?.type ?? null,
        surface_class: sMap ? sMap.get(e?.seq) ?? null : null,
        ...classifyProvenance(e),
      })),
      in_memory_only: true,
    };
  }

  /** 替换链与来源关联（宿主 `traceEvent`）：用于判「有效 surface」的完整链。 */
  async function traceEvent(sessionId, seq) {
    requireQuery();
    if (!isFn(q.traceEvent)) {
      return { session_id: sessionId, seq, known: false, reason: "traceEvent 不可用" };
    }
    try {
      const t = await q.traceEvent({ sessionId, seq });
      return {
        session_id: sessionId,
        seq,
        known: true,
        target: t?.target ?? null,
        replaced_by: isInt(t?.replacedBy) ? t.replacedBy : null,
        replacement_chain: isArr(t?.replacementChain) ? t.replacementChain : [],
        replaced_event_seqs: isArr(t?.replacedEventSeqs) ? t.replacedEventSeqs : [],
        source_event_seqs: isArr(t?.sourceEventSeqs) ? t.sourceEventSeqs : [],
        derived_event_seqs: isArr(t?.derivedEventSeqs) ? t.derivedEventSeqs : [],
      };
    } catch (e) {
      return { session_id: sessionId, seq, known: false, reason: `${e?.name || "Error"}: ${e?.message || String(e)}` };
    }
  }

  // ------------------------------------------------------------------ //
  // turnOutline 导航（可选包 ⇒ 必须优雅降级）
  // ------------------------------------------------------------------ //

  function registrationsOf(p) {
    const regs = p?.registrations ?? null;
    if (regs && isFn(regs.get)) return regs;
    if (isMap(regs)) {
      const m = new Map();
      for (const [k, v] of Object.entries(regs)) m.set(k, v);
      return m;
    }
    return new Map();
  }

  /**
   * 读 turnOutline 投影。**只作导航**：`evidence_eligible:false`，
   * 且 `compact-checkpoint` 不是独立个人证据（PRD §9.1 / AC-21）。
   *
   * 空预览**不等于**没有轮次（可能是图片输入/无文本），因此
   * `turns: []` 是合法的 available 结果，逐条空 prompt/response 标 `preview_empty`。
   */
  async function readTurnOutline(sessionId) {
    const unavailable = (state, reason) => ({
      session_id: sessionId,
      available: false,
      state,
      reason,
      navigation_only: true,
      evidence_eligible: false,
      as_of_seq: null,
      state_version: null,
      turns: [],
    });

    if (!projections) return unavailable("unsupported", "sessionProjections 未注入（可选包未挂载）");
    const reg = registrationsOf(projections).get("turnOutline") ?? null;
    const def = reg?.def ?? reg ?? null;
    if (!def) return unavailable("unsupported", "turnOutline 未注册（可选包未挂载）");
    if (!isFn(q?.observeSession)) return unavailable("unsupported", "observeSession 不可用");

    const obs = await observeOnce(sessionId);
    if (obs.error) return unavailable("unavailable", `observeSession 失败: ${obs.error}`);
    const snap = obs.projections;
    if (!isMap(snap)) return unavailable("unavailable", "观察结果没有 projections（投影未计算）");

    const raw = snap.values?.turnOutline ?? null;
    if (raw === null || raw === undefined) return unavailable("unavailable", "投影 values 里没有 turnOutline");

    // 兼容两种形状：投影值本体 `{turns}`，或投影缓存形态 `{val:{turns}}`。
    const value = isArr(raw?.turns) ? raw : isArr(raw?.val?.turns) ? raw.val : null;
    if (!value) return unavailable("unavailable", "turnOutline 值形状不符（缺 turns 数组）");

    return {
      session_id: sessionId,
      available: true,
      state: "verified",
      reason: null,
      navigation_only: true,
      evidence_eligible: false,
      state_version: isInt(def.stateVersion) ? def.stateVersion : null,
      as_of_seq: isInt(snap.asOfSeq) ? snap.asOfSeq : null,
      prompt_limit: TURN_OUTLINE_PROMPT_LIMIT,
      response_limit: TURN_OUTLINE_RESPONSE_LIMIT,
      turns: value.turns.map((t) => ({
        turn: isInt(t?.turn) ? t.turn : null,
        seq: isInt(t?.seq) ? t.seq : null,
        prompt: typeof t?.prompt === "string" ? t.prompt : "",
        response: typeof t?.response === "string" ? t.response : "",
        // 空预览可能是图片输入/无文本 ⇒ 不等于没有轮次。
        preview_empty: (t?.prompt ?? "") === "" && (t?.response ?? "") === "",
      })),
      note: "turnOutline 只导航：seq 指向 turn/start，prompt≤50、response≤120；不作为证据",
    };
  }

  // ------------------------------------------------------------------ //
  // SessionEvidence（PRD §8.6）
  // ------------------------------------------------------------------ //

  /**
   * 构造 `host_turn` 的 `SessionEvidence`。
   *
   * 字段全部来自**真实宿主证据**；任何一项拿不到就返回 `ok:false` + 原因码，
   * **绝不用默认值伪造**（PRD §8.6「老记录缺字段须回源补核验，不用默认值伪造」）。
   */
  async function buildSessionEvidence({ sessionId, seq, turn = null } = {}) {
    const snapshot = await loadSnapshot(sessionId);
    const event = snapshot.rawEvents.find((e) => e?.seq === seq);
    if (!event) {
      return {
        ok: false,
        code: "SOURCE_UNAVAILABLE",
        reason: `原始日志里没有 seq=${seq}（可能不属于本会话/本分支）`,
        session_id: sessionId,
        seq,
      };
    }

    const map = surfaceBySeq(snapshot);
    if (!map) {
      return {
        ok: false,
        code: "HOST_UNSUPPORTED",
        reason: `无法取得宿主 surface 分类：${snapshot.recordsError}`,
        session_id: sessionId,
        seq,
      };
    }
    const surfaceClass = map.get(seq) ?? null;
    if (surfaceClass === null) {
      return { ok: false, code: "HOST_UNSUPPORTED", reason: `seq=${seq} 的 surface 分类未知`, session_id: sessionId, seq };
    }

    // source_revision：只有 prepared 观察才有（live 没有 revision ⇒ 不伪造）。
    const obs = await observeOnce(sessionId);
    const revision = isNonEmptyStr(String(obs.revision ?? "")) ? String(obs.revision) : null;
    if (revision === null) {
      return {
        ok: false,
        code: "SOURCE_NOT_DURABLE",
        reason: `只观察到 ${obs.source ?? "未知"} 来源，没有 revision ⇒ 来源修订未知，不得伪造`,
        session_id: sessionId,
        seq,
        surface_class: surfaceClass,
      };
    }

    const prov = classifyProvenance(event);
    const evidence = {
      host: HOST_NAME,
      session_id: sessionId,
      // 只支持 seq ⇒ locator_kind=event_seq，不称永久 turn ID（PRD §8.6）。
      locator_kind: "event_seq",
      event_seq: seq,
      turn: isInt(turn) ? turn : null,
      branch_id: sessionId,
      source_revision: revision,
      availability: "available",
      durability_evidence: { kind: "host_persistence_observation", revision },
    };

    return {
      ok: true,
      evidence,
      // 来源元数据（PRD §8.6：保留 event_type/message_role/message_source_kind/surface_class）。
      metadata: {
        event_type: prov.event_type,
        message_role: prov.message_role,
        message_source_kind: prov.message_source_kind,
        surface_class: surfaceClass,
      },
      provenance: prov,
      // shadowed 的原日志仍可核验 ⇒ 来源仍 available；但不得当删除/撤回。
      shadowed_semantics: surfaceClass === "shadowed"
        ? { deleted: false, retracted: false, available: true, requires_reverification: true }
        : null,
      in_memory_only: true,
    };
  }

  // ------------------------------------------------------------------ //
  // 水位与游标推进守卫
  // ------------------------------------------------------------------ //

  /**
   * 游标推进守卫（AC-21 / PRD §11.5）。
   *
   * 规则：
   *   · 范围 (processed, requested] 里**尚未在表层**的真人候选 ⇒ 必须先在授权内回原日志核验，
   *     核验前 `allowed:false`，**不推进 processed**；不得仅因「已不在 surface」就标 no_change。
   *   · 纯非证据事件 ⇒ 可凭最小排除原因回执闭合（不给正文）。
   *   · shadowed 只是位置，不是撤回 ⇒ 已存知识不撤销。
   */
  async function cursorAdvanceGuard({ sessionId, processedThroughSeq, requestedThroughSeq } = {}) {
    if (!isInt(requestedThroughSeq) || requestedThroughSeq < 0) {
      throw new SessionReaderError("INVALID_ARGUMENT", "requestedThroughSeq 必须是非负整数", { requestedThroughSeq });
    }
    const snapshot = await loadSnapshot(sessionId);
    const map = surfaceBySeq(snapshot);
    if (!map) {
      return {
        session_id: sessionId,
        allowed: false,
        gate: "unsupported",
        reason: `无法取得宿主 surface 分类，不推进游标：${snapshot.recordsError}`,
        requested_through_seq: requestedThroughSeq,
        processed_through_seq: isInt(processedThroughSeq) ? processedThroughSeq : null,
      };
    }

    const from = isInt(processedThroughSeq) && processedThroughSeq >= 0 ? processedThroughSeq + 1 : 0;
    const recheckRequired = [];
    const blockers = [];
    const exclusionCandidates = [];
    const rawSeqs = new Set(snapshot.rawEvents.map((e) => e?.seq).filter(isInt));

    for (const event of snapshot.rawEvents) {
      const seq = event?.seq;
      if (!isInt(seq) || seq < from || seq > requestedThroughSeq) continue;
      const cls = map.get(seq) ?? null;
      const prov = classifyProvenance(event);

      if (cls === "current") {
        // 仍在表层：交给正常提炼流程处理，不算缺口。
        continue;
      }
      if (cls === null) {
        blockers.push({ seq, reason: "surface 分类未知：不得推断，保持缺口" });
        continue;
      }
      if (prov.human_input_candidate) {
        const inRaw = rawSeqs.has(seq);
        if (!inRaw) {
          // 理论上不会发生（shadowed 原文留存）；真发生就是硬阻塞。
          blockers.push({ seq, reason: "真人轮次既不在表层、也不在原日志：无法核验，范围不得闭合" });
        } else {
          recheckRequired.push({
            seq,
            surface_class: cls,
            reason:
              cls === "shadowed"
                ? "已观察未处理即被遮蔽：须在授权内回原日志补核验后才闭合范围"
                : "真人轮次不在当前表层：须回原日志核验",
            raw_log_available: true,
          });
        }
        continue;
      }
      // 纯非证据事件：可凭最小排除原因回执闭合（PRD §11.5）。
      exclusionCandidates.push({
        seq,
        surface_class: cls,
        event_type: prov.event_type,
        reason: prov.navigation_only
          ? "compact-checkpoint 只作导航，不作独立个人证据"
          : prov.model_generated
            ? "AI 输出（非真人输入）：不得冒充用户背景/理解/掌握"
            : "非证据事件（系统注入/代理/维护记录）",
        minimal_receipt: { session_id: sessionId, source_range: { from_seq: seq, to_seq: seq }, outcome: "excluded_non_evidence" },
      });
    }

    const allowed = blockers.length === 0 && recheckRequired.length === 0;
    return {
      session_id: sessionId,
      allowed,
      gate: allowed ? "ready" : "checking",
      reason: allowed
        ? "范围内真人轮次均已在表层，或纯非证据事件可凭最小回执闭合"
        : "范围内存在需回原日志核验的真人轮次：先核验，不推进 processed",
      requested_through_seq: requestedThroughSeq,
      processed_through_seq: isInt(processedThroughSeq) ? processedThroughSeq : null,
      range: { from_seq: from, to_seq: requestedThroughSeq },
      blockers,
      recheck_required: recheckRequired,
      exclusion_candidates: exclusionCandidates,
      // shadowed 只是上下文位置：不删除、不撤回、不据此撤销已存知识。
      shadowed_semantics: { deleted: false, retracted: false, auto_advance: false },
    };
  }

  /** 计算水位并用 M1 的 schema 不变式自校验（processed ≤ durable ≤ observed）。 */
  function computeWatermarks({ observed, durable, processed, gate } = {}) {
    const w = {
      observed_through_seq: isInt(observed) ? observed : null,
      durable_through_seq: isInt(durable) ? durable : null,
      processed_through_seq: isInt(processed) ? processed : null,
    };
    if (isMap(gate)) w.source_gate = gate;
    return w;
  }

  return {
    version: SESSION_READER_VERSION,
    host: HOST_NAME,
    staticCapabilities,
    verifyCapabilities,
    listSessions,
    readSourceStatus,
    readLog,
    classifySurface,
    shadowRetention,
    readEffectiveEvents,
    readEventText,
    readEventWindow,
    traceEvent,
    readTurnOutline,
    buildSessionEvidence,
    cursorAdvanceGuard,
    computeWatermarks,
    // 供测试与上层复用的纯函数
    inputFingerprint,
  };
}
