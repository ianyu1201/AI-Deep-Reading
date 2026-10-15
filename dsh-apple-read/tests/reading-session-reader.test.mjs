/**
 * tests/reading-session-reader.test.mjs · M2 宿主会话只读适配器 / session-reader.js
 *
 * ## 为什么这份测试的重点是「替身忠实」
 *
 * M0 踩过两次同一个坑：离线自检里的替身**不忠实**于宿主语义 ——
 *   · `filterEvents` 替身返回**原始 events**（真实是语义事件文档：**丢 `data.source`**、
 *     不含 log-only 结构事件）；
 *   · `readSurface` 替身返回**全部非遮蔽事件**（真实是**模型当前表层**，远小于全日志）。
 * 结果就是「离线全绿、运行期失效」。
 *
 * 所以本文件的替身是**照宿主源码复刻**的（行号见各函数注释，来源
 * `@deepseek-ai/dsh-session-query/lib/index.js` 与 `@deepseek-ai/dsh-session/lib/types/surface.js`），
 * 并且**专门用 meta 检查**把这两条语义钉住；再用一个 `m0-unfaithful` 模式的替身
 * 反过来验证「适配器能不能识破不忠实的宿主」——识破不了就判失败。
 *
 * ## 每条检查「在什么情况下会失败」
 *   [1] 替身忠实性   — 替身一旦退回 M0 形状（丢 source / surface 全量），meta 检查立刻失败
 *   [2] 能力分项     — 静态方法存在不得直接判 verified；6 项必须分项、不得多出第 7 项
 *   [3] 元数据发现   — live/persisted 必须是布尔；不得被当成会话对象使用
 *   [4] surface 分类 — 必须来自宿主完整结果；**累加 compaction/prune.shadowedSeqs 就会被诱饵抓到**
 *   [5] 反 M0 交叉校验 — readSurface 含 shadowed/log-only 时必须被标记出来
 *   [6] shadowed≠删除 — 被遮蔽事件必须仍在 readSession 原日志里；来源仍 available
 *   [7] source.kind  — 只走 readSession；filterEvents 里取不到 source 是**反证**
 *   [8] 归属分类     — 真人候选/系统注入/代理/compact-checkpoint 各自独立，不得混同
 *   [9] turnOutline  — 未挂载/未注册必须优雅降级；空预览 ≠ 没有轮次
 *  [10] SessionEvidence — 字段来自真实证据；无 revision 时必须 ok:false，不得伪造
 *  [11] 水位与游标  — shadowed 的未处理真人轮次必须挡住推进；shadowed 不得当撤回
 *  [12] 白名单      — 空白名单不得被解释成「不过滤」
 *  [13] 只读        — 模块无 fs/写接口；可持久化引用必须剥掉一切内容承载键
 *  [14] 指纹        — 同输入同指纹；内容变化必须改变指纹
 *
 * 跑法：node tests/reading-session-reader.test.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateNote, validateWatermarks } from "../lib/reading/schema.js";
import { BOOK_DOMAIN } from "../lib/reading/book-domain.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * 被测模块路径可用环境变量覆盖：变异测试把「改坏的副本」写到临时目录，
 * 连同 schema.js 一起放进去（保持相对 import 可解析），**绝不改动仓库里的真文件**。
 */
const READER_PATH = process.env.READING_SESSION_READER ?? join(HERE, "..", "lib", "reading", "session-reader.js");
const {
  CAPABILITY_KEYS,
  createSessionReader,
  inputFingerprint,
  seqReport,
  toPersistableRef,
} = await import(pathToFileURL(READER_PATH).href);

let pass = 0, fail = 0, skipped = 0;
const ok = (m) => { pass++; console.log("  ✓ " + m); };
const bad = (m, d) => { fail++; console.log("  ✗ " + m + (d ? "\n      " + d : "")); };
const is = (label, got, want) =>
  got === want ? ok(label) : bad(label, `得到 ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}`);
const isNot = (label, got, notWant) =>
  got !== notWant ? ok(label) : bad(label, `不应等于 ${JSON.stringify(notWant)}`);
const skip = (m, why) => { skipped++; console.log("  ⊘ 跳过 " + m + " —— " + why); };
const truthy = (label, v) => (v ? ok(label) : bad(label, `得到 ${JSON.stringify(v)}，期望真值`));
const falsy = (label, v) => (!v ? ok(label) : bad(label, `得到 ${JSON.stringify(v)}，期望假值`));

async function expectCode(label, promise, code) {
  try {
    await promise;
    bad(label, `本应抛 ${code}，却成功了`);
  } catch (e) {
    if (e.code === code) ok(`${label} → ${code}`);
    else bad(label, `抛的是 ${e.code}（${e.message}），期望 ${code}`);
  }
}

/**
 * 「必须不抛错」的显式断言。
 *
 * 为什么需要：优雅降级如果写成裸 `await`，一旦被改坏就变成**未捕获异常把整个套件打崩**
 * （exit 1 但零条 ✗）——看起来像"抓到了"，其实分不清是哪条契约破了。
 * 变异测试 G 就是这么暴露出来的。
 */
async function doesNotThrow(label, fn) {
  try {
    const v = await fn();
    ok(label);
    return v;
  } catch (e) {
    bad(label, `抛了 ${e?.name || "Error"}: ${e?.message || String(e)}`);
    return null;
  }
}

// =========================================================================== //
// 忠实宿主替身（照源码复刻）
// =========================================================================== //

/** 复刻 host `dsh-session/lib/types/surface.js:15` SURFACE_EVENT_TYPES。 */
const SURFACE_EVENT_TYPES = new Set([
  "system/message",
  "developer/message",
  "user/message",
  "assistant/message",
  "tool/result",
]);

/**
 * 复刻 host `surface.js` 的 `foldSurface`（append / replace 两条路径）。
 * 返回 `{nodes, replacements}`：`nodes` 是当前表层 seq（有序），
 * `replacements[].shadowedSeqs` 是被替换掉的旧表层 seq。
 */
function foldSurfaceDouble(events) {
  const nodes = [];
  const replacements = [];
  for (const e of events) {
    if (!SURFACE_EVENT_TYPES.has(e.type)) continue; // 非表层类型：log-only，且不得带 surfaceOp
    const op = e.surfaceOp;
    if (op === "append") { nodes.push(e.seq); continue; }
    if (op && typeof op === "object" && op.op === "replace") {
      const startIdx = nodes.indexOf(op.startSeq);
      const endIdx = nodes.indexOf(op.endSeq);
      if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) {
        throw new Error(`surface replace 范围非法 seq=${e.seq}`);
      }
      const shadowedSeqs = nodes.slice(startIdx, endIdx + 1);
      nodes.splice(startIdx, endIdx - startIdx + 1, e.seq);
      replacements.push({ seq: e.seq, start: op.startSeq, end: op.endSeq, shadowedSeqs });
      continue;
    }
    throw new Error(`表层事件 seq=${e.seq} 缺 surfaceOp 标记`);
  }
  return { nodes, replacements };
}

/**
 * 复刻 host `dsh-session-query/lib/index.js:947` `analyzeEventLog` 的 surface 判定：
 *   current = foldSurface 节点；shadowed = 替换链的 shadowedSeqs；**其余一律 log-only**。
 *
 * ⚠️ 关键：**不**读 `compaction/prune.data.shadowedSeqs`。宿主也不读它。
 */
function classifySurfaceDouble(events) {
  const { nodes, replacements } = foldSurfaceDouble(events);
  const current = new Set(nodes);
  const replacedBy = new Map();
  for (const r of replacements) for (const s of r.shadowedSeqs) replacedBy.set(s, r.seq);
  const map = new Map();
  for (const e of events) {
    map.set(e.seq, current.has(e.seq) ? "current" : replacedBy.has(e.seq) ? "shadowed" : "log-only");
  }
  return { map, current, replacedBy, replacements };
}

/** 复刻 host `index.js:544` `extractSessionEventText`。 */
function extractTextDouble(event) {
  const join = (parts) => parts.map((p) => (p ?? "").trim()).filter(Boolean).join("\n");
  const contentText = (content) =>
    join((content ?? []).flatMap((b) => {
      if (b?.type === "text") return [b.text];
      if (b?.type === "reasoning") return [];
      if (b?.type === "tool-call") return [b.name, b.arguments];
      return [];
    }));
  switch (event.type) {
    case "user/message": return contentText(event.data.content);
    case "assistant/message": return contentText(event.data.message.content);
    case "tool/call": return join([event.data.name, event.data.arguments]);
    case "tool/result": return join([
      contentText(event.data.message.content),
      event.data.error?.name ?? "",
      event.data.error?.code ?? "",
    ]);
    case "todo/write": return join(event.data.todos.flatMap((t) => [t.status, t.content]));
    case "turn/end": {
      const kind = event.data?.reason?.kind;
      if (kind === "error") return join(["error", event.data.reason.error.message]);
      if (kind === "aborted") return "aborted";
      if (kind === "max-tokens" || kind === "interrupted") return kind;
      return "";
    }
    default: return "";
  }
}

/** 复刻 host `index.js:613` `buildSessionEventSearchDocuments`。 */
function semanticDocsDouble(sessionId, events, surfaceMap) {
  const docs = [];
  for (const e of events) {
    const text = extractTextDouble(e);
    if (text.length === 0) continue; // 结构事件整条省略
    docs.push({
      sessionId,
      seq: e.seq,
      type: e.type,
      time: e.time,
      surface: surfaceMap.get(e.seq) ?? "log-only",
      text,
      // 注意：**没有** data / source —— 这正是 filterEvents 的真实语义
    });
  }
  return docs;
}

/**
 * 造一个「忠实」或「M0 不忠实」的宿主替身。
 *
 * @param {object} opts
 * @param {Map<string,object>} opts.sessions id → {header, events, live, persisted, revision, turnOutline?}
 * @param {boolean} [opts.projections] 是否提供 sessionProjections 服务
 * @param {"faithful"|"m0-unfaithful"} [opts.mode]
 */
function createHostDouble({ sessions, projections = false, mode = "faithful" }) {
  const calls = [];
  const regs = new Map();
  if (projections) {
    regs.set("turnOutline", { def: { key: "turnOutline", stateVersion: 2 } });
  }
  const projectionsService = projections
    ? { registrations: regs, snapshot: () => undefined }
    : null;

  const get = (id) => {
    const s = sessions.get(id);
    if (!s) throw new Error(`session "${id}" not found`);
    return s;
  };

  const query = {
    async listSessions() {
      calls.push("listSessions");
      return [...sessions.values()]
        .map((s) => ({ header: { ...s.header }, live: s.live === true, persisted: s.persisted === true }))
        .sort((a, b) => b.header.createdAt - a.header.createdAt || a.header.id.localeCompare(b.header.id));
    },

    async readSession(id) {
      calls.push("readSession");
      const s = get(id);
      return {
        session: { ...s.header },
        inheritedEventCount: s.header.inheritedEventCount ?? 0,
        events: s.events.map((e) => structuredClone(e)),
      };
    },

    async listEvents(id) {
      calls.push("listEvents");
      const s = get(id);
      const { map } = classifySurfaceDouble(s.events);
      return s.events.map((e) => ({
        sessionId: id,
        seq: e.seq,
        type: e.type,
        time: e.time,
        surface: map.get(e.seq) ?? "log-only",
      }));
    },

    async readSurface(id) {
      calls.push("readSurface");
      const s = get(id);
      const { map } = classifySurfaceDouble(s.events);
      if (mode === "m0-unfaithful") {
        // ⛔ M0 的不忠实替身：返回「全部非遮蔽事件」（含 log-only）——真实宿主只返回 current。
        return {
          session: { ...s.header },
          inheritedEventCount: s.header.inheritedEventCount ?? 0,
          capturedThroughSeq: s.events.at(-1)?.seq ?? null,
          events: s.events.filter((e) => map.get(e.seq) !== "shadowed").map((e) => structuredClone(e)),
        };
      }
      return {
        session: { ...s.header },
        inheritedEventCount: s.header.inheritedEventCount ?? 0,
        capturedThroughSeq: s.events.at(-1)?.seq ?? null,
        events: s.events.filter((e) => map.get(e.seq) === "current").map((e) => structuredClone(e)),
      };
    },

    async filterEvents(id, filters = []) {
      calls.push("filterEvents");
      const s = get(id);
      if (mode === "m0-unfaithful") {
        // ⛔ M0 的不忠实替身：返回原始 events（含 data.source）。
        return s.events.map((e) => structuredClone(e));
      }
      const { map } = classifySurfaceDouble(s.events);
      let docs = semanticDocsDouble(id, s.events, map);
      for (const f of filters) {
        if (f.kind === "type") docs = docs.filter((d) => f.values.includes(d.type));
        else if (f.kind === "surface") docs = docs.filter((d) => f.values.includes(d.surface));
      }
      return docs;
    },

    async readEvent({ sessionId, seq, before = 0, after = 0 }) {
      calls.push("readEvent");
      const s = get(sessionId);
      const start = Math.max(0, seq - before);
      const end = Math.min(s.events.length - 1, seq + after);
      return {
        session: { ...s.header },
        inheritedEventCount: s.header.inheritedEventCount ?? 0,
        target: structuredClone(s.events[seq]),
        events: s.events.slice(start, end + 1).map((e) => structuredClone(e)),
        startSeq: start,
        endSeq: end,
      };
    },

    async traceEvent({ sessionId, seq }) {
      calls.push("traceEvent");
      const s = get(sessionId);
      const { replacedBy, replacements } = classifySurfaceDouble(s.events);
      const chain = [];
      let cur = replacedBy.get(seq);
      while (cur !== undefined) { chain.push(cur); cur = replacedBy.get(cur); }
      const replaced = replacements.find((r) => r.seq === replacedBy.get(seq))?.shadowedSeqs ?? [];
      return {
        session: { ...s.header },
        target: { sessionId, seq, type: s.events[seq]?.type, surface: undefined },
        ...(replacedBy.has(seq) ? { replacedBy: replacedBy.get(seq) } : {}),
        replacementChain: chain,
        replacedEventSeqs: replaced,
        sourceEventSeqs: [],
        derivedEventSeqs: [],
      };
    },

    async observeSession(id, options = {}) {
      calls.push("observeSession");
      const s = get(id);
      const { map } = classifySurfaceDouble(s.events);
      void map;
      const lastSeq = s.events.at(-1)?.seq ?? -1;
      const projectionsValue =
        projections && options.projectionMode !== "none"
          ? { asOfSeq: lastSeq, values: { turnOutline: s.turnOutline ?? { turns: [] } } }
          : undefined;
      const lease = {
        source: s.live ? "live" : "prepared",
        header: { ...s.header },
        inheritedEventCount: s.header.inheritedEventCount ?? 0,
        events: s.events.map((e) => structuredClone(e)),
        cursor: lastSeq,
        ...(s.live ? {} : { revision: s.revision ?? "jsonl:dev=1,ino=2,size=3,mtime=4" }),
        ...(projectionsValue ? { projections: projectionsValue } : {}),
        retain: () => lease,
        [Symbol.dispose]: () => {},
      };
      return lease;
    },
  };

  return { query, projectionsService, calls, mode };
}

// =========================================================================== //
// 合成会话 fixture
// =========================================================================== //

const T = (n) => 1_700_000_000_000 + n * 1000;
const userMsg = (seq, kind, text, extra = {}) => ({
  type: "user/message",
  seq,
  time: T(seq),
  surfaceOp: "append",
  data: { role: "user", source: { kind }, content: [{ type: "text", text }] },
  ...extra,
});
const assistantMsg = (seq, text) => ({
  type: "assistant/message",
  seq,
  time: T(seq),
  surfaceOp: "append",
  data: { role: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } },
});
const boundary = (seq, type, data = {}) => ({ type, seq, time: T(seq), data });

/**
 * 主 fixture：21 个事件，覆盖三种 surface 类 + 六种 source.kind + 一条替换链。
 *
 * ⚠️ seq 16 的 `compaction/prune` 故意把 **18** 也写进 `data.shadowedSeqs`（诱饵）：
 *    18 实际仍是 current。任何「累加 shadowedSeqs 判遮蔽」的实现都会把 18 误标 shadowed。
 */
function fixtureEvents() {
  return [
    boundary(0, "turn/start", { turn: 0 }),                                                   // log-only
    userMsg(1, "user", "我先自己理解一下：怀疑是为了排除不确定。"),                                // 真人候选 #1
    boundary(2, "step/start", {}),                                                            // log-only
    assistantMsg(3, "你的理解有一个前提需要检查。"),
    userMsg(4, "time-context", "[当前时间 2026-10-10 16:30]"),                                  // 系统注入
    userMsg(5, "skill-catalog", "[技能目录：apple-read …]"),                                    // 系统注入
    userMsg(6, "agent-message", "队友：我先去处理文件服务。"),                                    // 代理
    userMsg(7, "subagent-settled", "子代理已结束。"),                                            // 代理
    userMsg(8, "user-approval", 'The approval policy changed from "ask" to "never"'),           // 审批上下文
    userMsg(9, "compact-checkpoint", "【压缩摘要】此前讨论过怀疑与确定性。"),                        // 只导航
    userMsg(10, "user", "我觉得第二个沉思更关键。"),                                              // 真人候选 #2
    assistantMsg(11, "第二个沉思讨论的是身心区分。"),
    boundary(12, "turn/end", { reason: { kind: "completed" } }),                                // log-only
    boundary(13, "turn/start", { turn: 1 }),                                                    // log-only
    userMsg(14, "user", "这句话我不太同意。"),                                                    // 真人候选 #3（将被遮蔽）
    assistantMsg(15, "那我们看看原文怎么说。"),                                                    // 将被遮蔽
    {                                                                                          // log-only 维护记录（诱饵）
      type: "compaction/prune",
      seq: 16,
      time: T(16),
      data: { shadowedSeqs: [14, 15, 18], shadowedTokenCount: 55477 },
    },
    {                                                                                          // 替换事件：真正决定遮蔽的是它
      type: "user/message",
      seq: 17,
      time: T(17),
      surfaceOp: { op: "replace", startSeq: 14, endSeq: 15 },
      data: { role: "user", source: { kind: "compact-checkpoint" }, content: [{ type: "text", text: "【压缩摘要】用户对某句有异议。" }] },
    },
    userMsg(18, "user", "我想接着读第三章。"),                                                    // 真人候选 #4（诱饵要求它仍是 current）
    boundary(19, "turn/end", { reason: { kind: "completed" } }),                                // log-only
    boundary(20, "turn/start", { turn: 2 }),                                                    // log-only
  ];
}

const SESSION_A = "session-fixture-a";
const SESSION_B = "session-fixture-b";

function sessionsMap({ live = true } = {}) {
  const m = new Map();
  m.set(SESSION_A, {
    header: { version: 4, id: SESSION_A, createdAt: 1_700_000_000_000, cwd: "/tmp/ws", isSeeded: false },
    events: fixtureEvents(),
    live,
    persisted: true,
    revision: "jsonl:dev=11,ino=22,size=33,mtime=44",
    turnOutline: {
      turns: [
        { turn: 0, seq: 0, prompt: "我先自己理解一下：怀疑是为了排除不确定。", response: "你的理解有一个前提需要检查。" },
        { turn: 1, seq: 13, prompt: "", response: "" },
        { turn: 2, seq: 20, prompt: "我想接着读第三章。", response: "" },
      ],
    },
  });
  m.set(SESSION_B, {
    header: {
      version: 4, id: SESSION_B, createdAt: 1_700_000_100_000, cwd: "/tmp/ws",
      isSeeded: true, parentSession: SESSION_A, inheritedEventCount: 12,
    },
    events: [boundary(0, "session/end-seed", { inherited: true })],
    live: false,
    persisted: true,
    revision: "jsonl:dev=11,ino=99,size=7,mtime=88",
  });
  return m;
}

const readerFor = (opts = {}) => {
  const { live = true, projections = false, mode = "faithful", whitelist, extraSessions } = opts;
  const sessions = extraSessions ?? sessionsMap({ live });
  const host = createHostDouble({ sessions, projections, mode });
  const reader = createSessionReader({
    sessionQuery: host.query,
    sessionProjections: host.projectionsService,
    whitelist,
  });
  return { reader, host, sessions };
};

// 期望的 surface 分类（由 fixture 手工推演，独立于替身实现）
const EXPECT_CURRENT = [1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 17, 18];
const EXPECT_SHADOWED = [14, 15];
const EXPECT_LOG_ONLY = [0, 2, 12, 13, 16, 19, 20];

// =========================================================================== //
console.log("\n[1] 替身忠实性 meta 检查（M0 两处不忠实替身的回归守卫）");

{
  const sessions = sessionsMap({ live: true });
  const host = createHostDouble({ sessions, projections: true, mode: "faithful" });
  const s = sessions.get(SESSION_A);

  // filterEvents 必须丢 data.source，且必须省略无文本的结构事件
  const docs = await host.query.filterEvents(SESSION_A, []);
  truthy("filterEvents 有返回", Array.isArray(docs) && docs.length > 0);
  docs.every((d) => !Object.prototype.hasOwnProperty.call(d, "data"))
    ? ok("filterEvents 文档不含 data（真实语义：丢 data.source）")
    : bad("filterEvents 文档带了 data —— 这就是 M0 的不忠实替身");
  docs.every((d) => typeof d.text === "string" && d.text.trim() !== "")
    ? ok("filterEvents 文档 text 非空（结构事件被省略）")
    : bad("filterEvents 出现空 text 文档，与宿主 extractSessionEventText 语义不符");
  docs.length < s.events.length
    ? ok(`filterEvents 条数(${docs.length}) < 全日志(${s.events.length})：结构事件确实被省略`)
    : bad("filterEvents 条数等于全日志 —— 说明它没做语义投影");
  docs.some((d) => d.type === "user/message")
    ? ok("filterEvents 能匹配到 user/message（语义检索可用）")
    : bad("filterEvents 取不到 user/message");
  !docs.some((d) => d.type === "turn/start")
    ? ok("filterEvents 不含 turn/start（无文本结构事件被省略）")
    : bad("filterEvents 竟含 turn/start");

  // readSurface 必须只含 current
  const sf = await host.query.readSurface(SESSION_A);
  const { map } = classifySurfaceDouble(s.events);
  const surfaceSeqs = sf.events.map((e) => e.seq);
  surfaceSeqs.every((seq) => map.get(seq) === "current")
    ? ok("readSurface 只含 current 事件")
    : bad("readSurface 含非 current 事件 —— 与宿主 currentSurfaceEvents 不符");
  !surfaceSeqs.some((seq) => map.get(seq) === "shadowed")
    ? ok("readSurface 不含 shadowed")
    : bad("readSurface 含 shadowed");
  !surfaceSeqs.some((seq) => map.get(seq) === "log-only")
    ? ok("readSurface 不含 log-only")
    : bad("readSurface 含 log-only —— 这正是 M0 的「全部非遮蔽事件」错误");
  surfaceSeqs.length < s.events.length
    ? ok(`readSurface(${surfaceSeqs.length}) 远小于全日志(${s.events.length})：表层是压缩后的模型视图`)
    : bad("readSurface 等于全日志 —— 替身退回了 M0 形状");

  // listEvents 必须覆盖全部 seq（含 log-only）
  const recs = await host.query.listEvents(SESSION_A);
  is("listEvents 覆盖全部事件", recs.length, s.events.length);
  recs.every((r, i) => r.seq === i) ? ok("listEvents seq 连续覆盖 0..N") : bad("listEvents seq 不连续");
  is("替身推演的 current 数", recs.filter((r) => r.surface === "current").length, EXPECT_CURRENT.length);
  is("替身推演的 shadowed 数", recs.filter((r) => r.surface === "shadowed").length, EXPECT_SHADOWED.length);
  is("替身推演的 log-only 数", recs.filter((r) => r.surface === "log-only").length, EXPECT_LOG_ONLY.length);
}

// =========================================================================== //
console.log("\n[2] 能力分项（PRD §10.2：不得一个「支持历史」全绿）");

{
  const { reader } = readerFor({ projections: true });
  const caps = reader.staticCapabilities();
  const keys = Object.keys(caps);
  is("能力项恰好 6 个（与 PRD §10.2 等集）", keys.length, CAPABILITY_KEYS.length);
  CAPABILITY_KEYS.every((k) => keys.includes(k)) ? ok("6 项名称与 PRD 一致") : bad("能力项名称不符", keys.join());

  // 静态方法存在 ⇒ 只能是 unverified，不能 verified
  is("静态 exact_history_read 不得直接 verified", caps.exact_history_read.state, "unverified");
  is("静态 metadata_discovery 不得直接 verified", caps.metadata_discovery.state, "unverified");
  is("未提供 search ⇒ content_search=disabled", caps.content_search.state, "disabled");
  is("未注册监听 ⇒ event_scope 停在 unverified", caps.event_scope.state, "unverified");

  // 未注入投影服务 ⇒ unsupported
  const { reader: noProj } = readerFor({ projections: false });
  is("无 sessionProjections ⇒ turn_outline=unsupported", noProj.staticCapabilities().turn_outline.state, "unsupported");

  // 真探测后才可能 verified
  const v = await reader.verifyCapabilities({ sessionId: SESSION_A });
  is("实测后 metadata_discovery=verified", v.capabilities.metadata_discovery.state, "verified");
  is("实测后 exact_history_read=verified", v.capabilities.exact_history_read.state, "verified");
  is("实测后 turn_outline=verified", v.capabilities.turn_outline.state, "verified");
  is("实测后 content_search 仍是 disabled", v.capabilities.content_search.state, "disabled");
  is("实测后 event_scope 仍是 unverified（未探测）", v.capabilities.event_scope.state, "unverified");

  // live 会话没有 revision ⇒ 耐久性不得 verified
  const liveV = await readerFor({ live: true, projections: true }).reader.verifyCapabilities({ sessionId: SESSION_A });
  is("live 会话 durability_confirmation=unverified", liveV.capabilities.durability_confirmation.state, "unverified");
  // 已持久会话有 revision ⇒ verified
  const prepV = await readerFor({ live: false, projections: true }).reader.verifyCapabilities({ sessionId: SESSION_A });
  is("prepared 会话 durability_confirmation=verified", prepV.capabilities.durability_confirmation.state, "verified");

  // 未挂载投影时必须优雅降级为 unsupported，而不是抛错
  const noProjV = await doesNotThrow(
    "无投影时 verifyCapabilities 不抛错",
    () => noProj.verifyCapabilities({ sessionId: SESSION_A }),
  );
  if (noProjV) is("无投影时 turn_outline=unsupported（不抛错）", noProjV.capabilities.turn_outline.state, "unsupported");
  else bad("无投影时 verifyCapabilities 未返回结果");
}

// =========================================================================== //
console.log("\n[3] 元数据发现：live/persisted 是布尔，不是会话对象");

{
  const { reader } = readerFor({ projections: false });
  const list = await reader.listSessions();
  is("枚举到 2 个会话", list.sessions.length, 2);
  const a = list.sessions.find((s) => s.session_id === SESSION_A);
  is("live 是布尔 true", typeof a.live, "boolean");
  is("persisted 是布尔 true", typeof a.persisted, "boolean");
  is("cwd 原样透出", a.cwd, "/tmp/ws");
  const b = list.sessions.find((s) => s.session_id === SESSION_B);
  is("fork 的 parent_session 透出", b.parent_session, SESSION_A);
  is("fork 的 is_seeded=true", b.is_seeded, true);
  is("无白名单时显式标注授权依据", list.authorization_basis, "no_whitelist_configured");
  is("默认不排除任何会话", list.excluded_count, 0);

  // 排序：newest-first（与宿主一致）
  list.sessions[0].session_id === SESSION_B
    ? ok("listSessions 保持 newest-first")
    : bad("listSessions 顺序不符", list.sessions.map((s) => s.session_id).join());
}

// =========================================================================== //
console.log("\n[4] surface 分类：只认宿主完整结果（诱饵 seq 18 必须仍是 current）");

{
  const { reader } = readerFor();
  const cls = await reader.classifySurface(SESSION_A);
  is("分类来源标为 listEvents", cls.source, "listEvents(host analyzeEventLog)");
  is("current 计数", cls.counts.current, EXPECT_CURRENT.length);
  is("shadowed 计数", cls.counts.shadowed, EXPECT_SHADOWED.length);
  is("log-only 计数", cls.counts["log-only"], EXPECT_LOG_ONLY.length);
  is("unknown 计数为 0", cls.counts.unknown, 0);
  is("三段之和等于总数（分区不变式）", cls.counts.current + cls.counts.shadowed + cls.counts["log-only"], cls.counts.total);

  for (const s of EXPECT_CURRENT) {
    if (cls.by_seq[s] !== "current") bad(`seq ${s} 应为 current`, `得到 ${cls.by_seq[s]}`);
  }
  EXPECT_CURRENT.every((s) => cls.by_seq[s] === "current") ? ok("所有 current seq 判定正确") : null;
  EXPECT_SHADOWED.every((s) => cls.by_seq[s] === "shadowed") ? ok("所有 shadowed seq 判定正确") : bad("shadowed 判定错误");
  EXPECT_LOG_ONLY.every((s) => cls.by_seq[s] === "log-only") ? ok("所有 log-only seq 判定正确") : bad("log-only 判定错误");

  // ★ 核心诱饵：prune 的 shadowedSeqs 里含 18，但 18 实际仍是 current。
  //   任何「累加 compaction/prune.shadowedSeqs」的实现都会在这里翻车。
  is("诱饵 seq 18 仍是 current（证明没有累加 prune.shadowedSeqs）", cls.by_seq[18], "current");
  is("诱饵 seq 18 未被算进 shadowed", cls.counts.shadowed, 2);
  falsy("未使用 readSurface 反推（fallback_used=false）", cls.fallback_used);

  // readSurface 交叉校验
  const x = cls.read_surface_cross_check;
  truthy("readSurface 事件集是 current 的子集", x.surface_subset_of_current);
  falsy("readSurface 不含 shadowed", x.surface_contains_shadowed);
  falsy("readSurface 不含 log-only", x.surface_contains_log_only);
  is("readSurface 事件数 = current 数（自洽时）", x.surface_event_count, EXPECT_CURRENT.length);
  is("readSurface ≠ 全部非遮蔽事件（可证伪判据）", x.read_surface_equals_non_shadowed, false);

  // traceEvent 给出替换链与来源关联
  const t = await reader.traceEvent(SESSION_A, 14);
  is("seq 14 被 17 替换", t.replaced_by, 17);
  is("替换链 [17]", t.replacement_chain.join(), "17");
  truthy("replacedEventSeqs 含 15", t.replaced_event_seqs.includes(15));
}

// =========================================================================== //
console.log("\n[5] 识破不忠实的宿主（M0 形状替身必须被交叉校验抓到）");

{
  const { reader } = readerFor({ mode: "m0-unfaithful" });
  const cls = await reader.classifySurface(SESSION_A);
  is("分类仍来自 listEvents（不受 readSurface 影响）", cls.counts.current, EXPECT_CURRENT.length);
  is("shadowed 计数仍是 2（不被 readSurface 污染）", cls.counts.shadowed, 2);
  const x = cls.read_surface_cross_check;
  falsy("readSurface 含 log-only 时 subset 检查必须为假", x.surface_subset_of_current);
  truthy("readSurface 含 log-only 被标记出来", x.surface_contains_log_only);
  is("readSurface == 全部非遮蔽事件（M0 签名被识别）", x.read_surface_equals_non_shadowed, true);
  truthy("越界样本被列出", Array.isArray(x.outside_current_sample) && x.outside_current_sample.length > 0);
}

// =========================================================================== //
console.log("\n[6] shadowed ≠ 删除 ≠ 撤回（原文留存 + 来源仍 available）");

{
  const { reader } = readerFor({ live: false });
  const ret = await reader.shadowRetention(SESSION_A);
  is("shadowed 总数", ret.shadowed_count, 2);
  is("全部仍在 readSession 原日志里", ret.retained_in_raw_log, 2);
  truthy("all_shadowed_retained", ret.all_shadowed_retained);
  is("缺失列表为空", ret.missing_from_raw_log.length, 0);
  is("取证来源是 readSession.events", ret.evidence_source, "readSession.events");
  falsy("显式声明不是从 readSurface 推的", ret.derived_from_read_surface);
  is("语义：未删除", ret.semantics.deleted, false);
  is("语义：未撤回", ret.semantics.retracted, false);
  truthy("语义：闭合前需回核验", ret.semantics.requires_reverification_before_closing);

  // 被遮蔽事件的 SessionEvidence：来源仍 available（原日志可核验）
  const ev = await reader.buildSessionEvidence({ sessionId: SESSION_A, seq: 14 });
  truthy("被遮蔽事件仍能构造证据（原日志可读）", ev.ok);
  is("被遮蔽事件 availability 仍是 available", ev.evidence.availability, "available");
  is("被遮蔽事件 surface_class=shadowed", ev.metadata.surface_class, "shadowed");
  is("shadowed 语义：未删除", ev.shadowed_semantics.deleted, false);
  truthy("shadowed 语义：需回核验", ev.shadowed_semantics.requires_reverification);
}

// =========================================================================== //
console.log("\n[7] source.kind 只走 readSession（filterEvents 取不到是反证）");

{
  const { reader, host } = readerFor({ live: false });

  // 反证：filterEvents 里根本没有 source（M0 的替身才会「有」）
  const docs = await host.query.filterEvents(SESSION_A, []);
  const anySource = docs.some((d) => d?.data?.source);
  falsy("filterEvents 结果里取不到 source（宿主真实语义）", anySource);

  // 正确做法：readSession 的完整原始日志里，source.kind 齐全
  const eff = await reader.readEffectiveEvents(SESSION_A);
  is("表层事件数", eff.events.length, EXPECT_CURRENT.length);
  is("取证来源标为 listEvents", eff.surface_source, "listEvents(host analyzeEventLog)");
  truthy("surface_known", eff.surface_known);
  const kinds = eff.source_kind_counts;
  is("真人候选数（kind=user）", kinds.user, 3);
  is("系统注入 time-context", kinds["time-context"], 1);
  is("系统注入 skill-catalog", kinds["skill-catalog"], 1);
  is("审批上下文 user-approval", kinds["user-approval"], 1);
  is("代理 agent-message", kinds["agent-message"], 1);
  is("代理 subagent-settled", kinds["subagent-settled"], 1);
  is("compact-checkpoint", kinds["compact-checkpoint"], 2);
  // source_kind 必须「有值或显式 null」——绝不 undefined、绝不用空串假装已知
  truthy(
    "每条事件都显式带 message_source_kind（非空字符串或 null，不猜）",
    eff.events.every((e) => Object.prototype.hasOwnProperty.call(e, "message_source_kind") &&
      (e.message_source_kind === null || (typeof e.message_source_kind === "string" && e.message_source_kind !== ""))),
  );
  truthy(
    "无 source 的 assistant 消息必须为 null（不得伪造 source）",
    eff.events.filter((e) => e.event_type === "assistant/message").every((e) => e.message_source_kind === null),
  );
  truthy("每条事件都带 surface_class", eff.events.every((e) => e.surface_class === "current"));
  truthy("每条事件都带 event_type", eff.events.every((e) => typeof e.event_type === "string"));

  // 真人候选必须仍要求逐命题分类
  const humans = eff.events.filter((e) => e.human_input_candidate);
  is("真人候选数", humans.length, 3);
  truthy("真人候选全部 requires_proposition_classification", humans.every((e) => e.requires_proposition_classification));
  truthy("真人候选全部 produces_user_learning_fact", humans.every((e) => e.produces_user_learning_fact));

  // 单点正文只在显式调用时返回，并标 in_memory_only
  const one = await reader.readEventText(SESSION_A, 1);
  truthy("单点取到正文", one.text.includes("怀疑"));
  truthy("单点正文标 in_memory_only", one.in_memory_only);
  is("单点正文 surface_class", one.surface_class, "current");
}

// =========================================================================== //
console.log("\n[8] 归属分类：系统注入/代理/压缩摘要不得冒充用户");

{
  const { reader } = readerFor();
  const eff = await reader.readEffectiveEvents(SESSION_A);
  const bySeq = new Map(eff.events.map((e) => [e.seq, e]));

  const u = bySeq.get(1);
  is("seq1 是真人候选", u.human_input_candidate, true);
  is("seq1 origin_hint=user", u.origin_hint, "user");
  falsy("seq1 不是系统注入", u.system_injected);
  falsy("seq1 不是导航", u.navigation_only);

  const tc = bySeq.get(4);
  is("seq4(time-context) 不是真人候选", tc.human_input_candidate, false);
  truthy("seq4 标为系统注入", tc.system_injected);
  falsy("seq4 不产生用户学习事实", tc.produces_user_learning_fact);
  is("seq4 origin_hint=null（不猜）", tc.origin_hint, null);

  const ap = bySeq.get(8);
  truthy("seq8(user-approval) 标为系统注入", ap.system_injected);
  falsy("seq8 不产生用户学习事实", ap.produces_user_learning_fact);

  const ag = bySeq.get(6);
  truthy("seq6(agent-message) 标为代理来源", ag.agent_originated);
  falsy("seq6 不是真人候选", ag.human_input_candidate);

  const cp = bySeq.get(9);
  truthy("seq9(compact-checkpoint) 只作导航", cp.navigation_only);
  falsy("seq9 不是真人候选", cp.human_input_candidate);
  falsy("seq9 不产生用户学习事实", cp.produces_user_learning_fact);
  is("seq9 origin_hint=ai_inference", cp.origin_hint, "ai_inference");
  falsy("seq9 不是个人证据候选", cp.personal_evidence_candidate);

  const cp2 = bySeq.get(17);
  truthy("seq17(替换事件, compact-checkpoint) 也只作导航", cp2.navigation_only);

  // 被遮蔽的真人候选不得出现在 current 表层结果里
  falsy("被遮蔽的 seq14 不在 current 结果里", bySeq.has(14));
  truthy("excluded 里能看到 seq14", eff.excluded.some((e) => e.seq === 14));
  is("seq14 被排除的原因标注 shadowed", eff.excluded.find((e) => e.seq === 14).reason.includes("shadowed"), true);
}

// =========================================================================== //
console.log("\n[9] turnOutline 导航与优雅降级");

{
  // 已挂载 + 已注册
  const { reader } = readerFor({ projections: true, live: false });
  const o = await reader.readTurnOutline(SESSION_A);
  truthy("turnOutline 可用", o.available);
  is("state=verified", o.state, "verified");
  is("stateVersion=2", o.state_version, 2);
  is("轮次数", o.turns.length, 3);
  truthy("导航标记 navigation_only", o.navigation_only);
  falsy("不得作证据 evidence_eligible", o.evidence_eligible);
  is("prompt 上限 50", o.prompt_limit, 50);
  is("response 上限 120", o.response_limit, 120);
  is("seq 指向 turn/start", o.turns[0].seq, 0);
  is("空预览轮次被标 preview_empty（≠ 没有轮次）", o.turns[1].preview_empty, true);
  is("空预览轮次仍存在（turn 1）", o.turns[1].turn, 1);
  is("非空轮次 preview_empty=false", o.turns[0].preview_empty, false);

  // 未挂载投影服务 ⇒ 优雅降级（必须**不抛错**）
  const { reader: noProj } = readerFor({ projections: false });
  const o2 = await doesNotThrow(
    "未挂载投影时 readTurnOutline 不抛错（优雅降级）",
    () => noProj.readTurnOutline(SESSION_A),
  );
  if (!o2) { bad("优雅降级未返回结果，后续检查跳过"); }
  else {
    falsy("无投影时 available=false", o2.available);
    is("无投影时 state=unsupported", o2.state, "unsupported");
    truthy("无投影时给出原因", typeof o2.reason === "string" && o2.reason.length > 0);
    is("无投影时 turns 为空数组（不抛错）", o2.turns.length, 0);
  }

  // 投影服务在、但 turnOutline 未注册
  const sessions = sessionsMap();
  const host = createHostDouble({ sessions, projections: false });
  const projSvc = { registrations: new Map(), snapshot: () => undefined };
  const r3 = createSessionReader({ sessionQuery: host.query, sessionProjections: projSvc });
  const o3 = await doesNotThrow(
    "已注入但未注册时也不抛错",
    () => r3.readTurnOutline(SESSION_A),
  );
  if (o3) is("已注入但未注册 ⇒ unsupported", o3.state, "unsupported");
  else bad("已注入但未注册时未返回降级结果");

  // 投影值为空 turns：仍是 available（合法）
  const sessions2 = sessionsMap();
  sessions2.get(SESSION_A).turnOutline = { turns: [] };
  const host2 = createHostDouble({ sessions: sessions2, projections: true });
  const r4 = createSessionReader({ sessionQuery: host2.query, sessionProjections: host2.projectionsService });
  const o4 = await r4.readTurnOutline(SESSION_A);
  truthy("空 turns 仍是 available", o4.available);
  is("空 turns 长度为 0", o4.turns.length, 0);
}

// =========================================================================== //
console.log("\n[10] SessionEvidence：真实字段 + 缺 revision 时不伪造 + 过 M1 schema");

{
  // prepared 会话：字段齐全
  const { reader } = readerFor({ live: false });
  const ev = await reader.buildSessionEvidence({ sessionId: SESSION_A, seq: 1 });
  truthy("构造成功", ev.ok);
  const e = ev.evidence;
  is("host", e.host, "dsh");
  is("session_id", e.session_id, SESSION_A);
  is("locator_kind=event_seq（不称永久 turn ID）", e.locator_kind, "event_seq");
  is("event_seq", e.event_seq, 1);
  is("turn 未知时为 null", e.turn, null);
  is("branch_id 有值", e.branch_id, SESSION_A);
  truthy("source_revision 来自宿主 revision", e.source_revision.startsWith("jsonl:"));
  is("availability=available", e.availability, "available");
  truthy("durability_evidence.kind 非空", typeof e.durability_evidence.kind === "string" && e.durability_evidence.kind.length > 0);
  is("来源元数据 event_type", ev.metadata.event_type, "user/message");
  is("来源元数据 message_role", ev.metadata.message_role, "user");
  is("来源元数据 message_source_kind", ev.metadata.message_source_kind, "user");
  is("来源元数据 surface_class", ev.metadata.surface_class, "current");

  // 用 M1 的真 schema 校验 SessionEvidence（draft 模式足以触达 checkSessionEvidence）
  const note = {
    schema_version: "1.1",
    object_type: "reading_evidence",
    id: "re-fixture-1",
    revision: 1,
    title: "合成：SessionEvidence 契约校验",
    tags: ["reading", "evidence"],
    scope: "45-书籍/学习证据",
    knowledge_status: "active",
    created_at: "2026-10-10T00:00:00.000Z",
    updated_at: "2026-10-10T00:00:00.000Z",
    origin: "user",
    confirmation: "unconfirmed",
    confirmation_evidence: null,
    book_evidence: [],
    session_evidence: [e],
    external_master: {
      status: "unverified", outcome: "not_checked", check_id: null, scope_refs: [],
      checked_at: null, authorization_revision: null, candidate_refs: [], ref: null,
    },
    dedup_check_ref: null,
    kind: "self_report",
    dimension: "explanation",
    concept_refs: ["concept-fixture"],
    strength: null,
    confidence: { level: "unknown", reason: "合成 fixture，未评级" },
    assessment_basis: "合成：仅用于校验 SessionEvidence 结构",
    source_refs: [{ source_kind: "host_turn", ref: e }],
    valid_until: null,
  };
  const v = validateNote(note, { mode: "draft", domain: BOOK_DOMAIN });
  truthy("SessionEvidence 通过 M1 schema（draft）", v.ok);
  if (!v.ok) bad("schema 报错", JSON.stringify(v.errors.slice(0, 3)));

  // 负例对照：证明这个集成检查有区分度（改坏它必须被抓到）
  const broken = structuredClone(note);
  broken.session_evidence[0].availability = "definitely-not-a-valid-enum";
  falsy("负例：非法 availability 必须被 schema 拒", validateNote(broken, { mode: "draft", domain: BOOK_DOMAIN }).ok);
  const broken2 = structuredClone(note);
  delete broken2.session_evidence[0].source_revision;
  falsy("负例：缺 source_revision 必须被 schema 拒", validateNote(broken2, { mode: "draft", domain: BOOK_DOMAIN }).ok);
  const broken3 = structuredClone(note);
  broken3.session_evidence[0].event_seq = "1";
  falsy("负例：event_seq 非整数必须被 schema 拒", validateNote(broken3, { mode: "draft", domain: BOOK_DOMAIN }).ok);
  const broken4 = structuredClone(note);
  delete broken4.session_evidence[0].branch_id;
  falsy("负例：缺 branch_id 必须被 schema 拒", validateNote(broken4, { mode: "draft", domain: BOOK_DOMAIN }).ok);

  // live 会话：没有 revision ⇒ 必须 ok:false，绝不伪造
  const { reader: liveReader } = readerFor({ live: true });
  const noRev = await liveReader.buildSessionEvidence({ sessionId: SESSION_A, seq: 1 });
  falsy("live 会话不得伪造 source_revision", noRev.ok);
  is("live 会话给出 SOURCE_NOT_DURABLE", noRev.code, "SOURCE_NOT_DURABLE");
  truthy("并说明原因", typeof noRev.reason === "string" && noRev.reason.includes("revision"));

  // 不存在的 seq ⇒ 明确失败
  const missing = await liveReader.buildSessionEvidence({ sessionId: SESSION_A, seq: 9999 });
  falsy("不存在的 seq 必须失败", missing.ok);
  is("错误码 SOURCE_UNAVAILABLE", missing.code, "SOURCE_UNAVAILABLE");

  // fork 会话：inheritedEventCount 必须透出（继承前缀不属于本分支自身证据）
  const st = await liveReader.readSourceStatus(SESSION_B);
  is("fork 的 inherited_event_count", st.lineage.inherited_event_count, 12);
  is("fork 的 parent_session", st.lineage.parent_session, SESSION_A);
  is("fork 的 is_seeded", st.lineage.is_seeded, true);
}

// =========================================================================== //
console.log("\n[11] 水位与游标推进守卫（AC-21：被遮蔽的未处理轮次不得被跳过）");

{
  const { reader } = readerFor({ live: false });

  const st = await reader.readSourceStatus(SESSION_A);
  is("prepared 会话 gate=ready", st.source_gate.state, "ready");
  is("observed 上界", st.observed_through_seq, 20);
  is("durable 上界", st.durable_through_seq, 20);
  truthy("durable ≤ observed", st.durable_through_seq <= st.observed_through_seq);
  truthy("source_revision 有值", typeof st.source_revision === "string");
  is("availability=available", st.availability, "available");

  const liveSt = await readerFor({ live: true }).reader.readSourceStatus(SESSION_A);
  is("live 会话 gate=pending_durable", liveSt.source_gate.state, "pending_durable");
  is("live 会话 durable=null（live 可读≠已保存）", liveSt.durable_through_seq, null);
  falsy("live 会话不声称 ready", liveSt.source_gate.state === "ready");

  // 推进到 18：seq14 是被遮蔽且未处理的真人轮次 ⇒ 必须挡住
  const g1 = await reader.cursorAdvanceGuard({ sessionId: SESSION_A, processedThroughSeq: null, requestedThroughSeq: 18 });
  falsy("含被遮蔽未处理真人轮次时不得推进", g1.allowed);
  is("gate=checking", g1.gate, "checking");
  is("需要回核验的项数", g1.recheck_required.length, 1);
  is("回核验的 seq", g1.recheck_required[0].seq, 14);
  is("回核验项 surface_class=shadowed", g1.recheck_required[0].surface_class, "shadowed");
  truthy("原日志可用（可回溯核验）", g1.recheck_required[0].raw_log_available);
  truthy("非证据事件给出最小排除回执", g1.exclusion_candidates.length > 0);
  truthy("排除回执只含 ID/范围，无正文", g1.exclusion_candidates.every((x) => !("text" in x.minimal_receipt) && !("content" in x.minimal_receipt)));
  is("shadowed 语义：不自动推进", g1.shadowed_semantics.auto_advance, false);
  is("shadowed 语义：未删除", g1.shadowed_semantics.deleted, false);
  is("shadowed 语义：未撤回", g1.shadowed_semantics.retracted, false);

  // 推进到 13（遮蔽之前）：允许
  const g2 = await reader.cursorAdvanceGuard({ sessionId: SESSION_A, processedThroughSeq: null, requestedThroughSeq: 13 });
  truthy("遮蔽之前可以推进", g2.allowed);
  is("gate=ready", g2.gate, "ready");
  is("无回核验项", g2.recheck_required.length, 0);
  truthy("log-only 非证据事件仍给最小回执", g2.exclusion_candidates.length > 0);
  is("被遮蔽的 14/15 不在本范围内", g2.exclusion_candidates.filter((x) => x.seq === 14).length, 0);

  // 处理过 14 之后，推进到 18 应放行（缺口已闭合）
  const g3 = await reader.cursorAdvanceGuard({ sessionId: SESSION_A, processedThroughSeq: 14, requestedThroughSeq: 18 });
  truthy("缺口闭合后可推进", g3.allowed);
  is("范围起点", g3.range.from_seq, 15);
  is("无回核验项", g3.recheck_required.length, 0);

  // 水位：processed ≤ durable ≤ observed（用 M1 的真不变式校验器，而不是自己写一遍）
  const w = reader.computeWatermarks({ observed: 20, durable: 20, processed: 18, gate: { state: "ready", requested_through_seq: 18 } });
  is("水位三值齐备", [w.observed_through_seq, w.durable_through_seq, w.processed_through_seq].join(), "20,20,18");
  truthy("合法水位通过 M1 不变式", validateWatermarks(w).ok);
  const wBad = reader.computeWatermarks({ observed: 20, durable: 10, processed: 15, gate: { state: "ready", requested_through_seq: 15 } });
  falsy("processed>durable 必须被 M1 不变式拒", validateWatermarks(wBad).ok);
  truthy("并报 WATERMARK_INVARIANT_VIOLATION", validateWatermarks(wBad).errors.some((e) => e.code === "WATERMARK_INVARIANT_VIOLATION"));
  const wBad2 = reader.computeWatermarks({ observed: 10, durable: 20, processed: null, gate: { state: "pending_durable" } });
  falsy("durable>observed 必须被 M1 不变式拒", validateWatermarks(wBad2).ok);
  const wReady = reader.computeWatermarks({ observed: 20, durable: 20, processed: 20, gate: { state: "ready", requested_through_seq: 25 } });
  falsy("ready 时 requested>durable 必须被拒", validateWatermarks(wReady).ok);

  // 分类未知时不得推进
  const noSurfaceHost = createHostDouble({ sessions: sessionsMap(), projections: false });
  delete noSurfaceHost.query.listEvents;
  const r5 = createSessionReader({ sessionQuery: noSurfaceHost.query });
  const g4 = await r5.cursorAdvanceGuard({ sessionId: SESSION_A, processedThroughSeq: null, requestedThroughSeq: 5 });
  falsy("surface 分类不可用时不得推进", g4.allowed);
  is("并给出 unsupported", g4.gate, "unsupported");

  const cls5 = await r5.classifySurface(SESSION_A);
  falsy("surface 未知时 known=false", cls5.known);
  falsy("且明确声明没有退回 readSurface 反推", cls5.fallback_used);
  const eff5 = await r5.readEffectiveEvents(SESSION_A);
  falsy("surface 未知时 surface_known=false", eff5.surface_known);
  truthy("且给出原因", typeof eff5.reason === "string" && eff5.reason.length > 0);
}

// =========================================================================== //
console.log("\n[12] 作用域/session 白名单（作用域可见 ≠ 用户授权）");

{
  // 白名单只放 A
  const { reader } = readerFor({ whitelist: { session_ids: [SESSION_A] } });
  const list = await reader.listSessions();
  is("只返回白名单内的会话", list.sessions.length, 1);
  is("被排除的会话数", list.excluded_count, 1);
  truthy("授权依据标注", list.authorization_basis === "whitelist");
  await expectCode("读白名单外会话被拒", reader.readLog(SESSION_B), "SESSION_NOT_AUTHORIZED");

  // 空数组 ⇒ 谁都不授权（不得解释成「不过滤」）
  const { reader: emptyWl } = readerFor({ whitelist: { session_ids: [] } });
  const l2 = await emptyWl.listSessions();
  is("空白名单不授权任何会话", l2.sessions.length, 0);
  is("空白名单排除全部", l2.excluded_count, 2);

  // cwd 白名单
  const { reader: cwdWl } = readerFor({ whitelist: { cwd: "/tmp/ws" } });
  is("cwd 匹配时可读", (await cwdWl.listSessions()).sessions.length, 2);
  const { reader: badCwd } = readerFor({ whitelist: { cwd: "/elsewhere" } });
  is("cwd 不匹配时全排除", (await badCwd.listSessions()).sessions.length, 0);

  // 未注入 sessionQuery
  const noQuery = createSessionReader({});
  await expectCode("无 sessionQuery 时明确 HOST_UNSUPPORTED", noQuery.readLog(SESSION_A), "HOST_UNSUPPORTED");
}

// =========================================================================== //
console.log("\n[13] 只读纪律：不写第二份聊天存储");

{
  const src = readFileSync(READER_PATH, "utf8");
  falsy("模块不 import node:fs", /from\s+["']node:fs["']/.test(src));
  falsy("模块无 writeFile/appendFile 等写接口", /writeFile|appendFile|createWriteStream|mkdirSync|rename\(/.test(src));
  falsy("模块无 fetch/网络", /\bfetch\(/.test(src));

  // M6 起：lib/index.js **必须**接线 session-reader（此前 M2 的「不得接线」断言已到期）。
  // 接线必须是**单一注入点**：index.js 只 import runtime，由 runtime 去造 session-reader。
  // 断言源码前必须先剥注释：本轮就踩到过——index.js 的注释里写着
  // 「必须声明，而不是偷偷 `ctx.sessionQuery`」，朴素正则把**文档**当成了**代码**。
  // 这里只做够用的注释剥离（块注释 + 行注释），不做完整词法分析。
  const stripComments = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/(^|[^:"'`\\])\/\/.*$/, "$1"))
    .join("\n");

  const idx = readFileSync(join(HERE, "..", "lib", "index.js"), "utf8");
  const rtSrc = readFileSync(join(HERE, "..", "lib", "reading", "runtime.js"), "utf8");
  const idxCode = stripComments(idx);
  const rtCode = stripComments(rtSrc);
  truthy("lib/index.js 已接线阅读域（M6 单一注入点）", /reading\/runtime\.js/.test(idxCode));
  truthy("runtime 接线 session-reader", /session-reader\.js/.test(rtCode));
  truthy("lib/index.js 的 inject 声明了 sessionQuery（cordis 硬依赖）",
    /const inject = \[[^\]]*"sessionQuery"/.test(idxCode));
  falsy("lib/index.js 不直接 ctx.sessionQuery（必须走 ctx.get 兜底，缺服务不崩）",
    /ctx\.sessionQuery\b/.test(idxCode));
  truthy("runtime 经 ctx.get 兜底读服务（服务不在返回 undefined，不抛）",
    /const g = scope\.get/.test(rtCode));
  truthy("runtime 用 getService(\"sessionQuery\") 兜底读会话服务",
    /getService\(\s*["']sessionQuery["']\s*\)/.test(rtCode));
  falsy("lib/index.js 已无 M0 探针 import", /session-probe/.test(idxCode));

  // 只读纪律要延续到 runtime：它也不许自己写盘（写盘只能经 M1 file-service）
  falsy("runtime 无写盘接口", /writeFile|appendFile|createWriteStream|mkdirSync|rename\(/.test(rtCode));
  falsy("runtime 无网络调用", /\bfetch\(/.test(rtCode));

  // 可持久化引用必须剥掉一切内容承载键
  const { reader } = readerFor({ projections: true, live: false });
  const ev = await reader.buildSessionEvidence({ sessionId: SESSION_A, seq: 1 });
  const ref = toPersistableRef(ev);
  const s = JSON.stringify(ref);
  falsy("可持久化引用里没有正文片段", s.includes("怀疑") || s.includes("压缩摘要") || s.includes("同意"));
  falsy("可持久化引用里没有 text 键", /"text"\s*:/.test(s));
  falsy("可持久化引用里没有 events 键", /"events"\s*:/.test(s));
  truthy("但保留了 session_id", s.includes(SESSION_A));
  truthy("也保留了 event_seq", /"event_seq"\s*:\s*1/.test(s));

  // readLog 默认不回正文
  const log = await reader.readLog(SESSION_A);
  falsy("readLog 默认不含 events", Object.prototype.hasOwnProperty.call(log, "events"));
  falsy("readLog 默认 in_memory_only=false", log.in_memory_only);
  is("readLog 给出事件类型计数", typeof log.event_type_counts["user/message"], "number");
  is("readLog seq 上界", log.seq.max, 20);
  truthy("readLog 报告 surface 可用", log.surface_known);

  const logFull = await reader.readLog(SESSION_A, { includeEvents: true });
  truthy("显式要求时才含 events", Array.isArray(logFull.events) && logFull.events.length === 21);
  truthy("并标 in_memory_only", logFull.in_memory_only);
  truthy("并给出警示", typeof logFull.warning === "string");
}

// =========================================================================== //
console.log("\n[14] 输入指纹与 seq 报告");

{
  const { reader } = readerFor({ live: false });
  const log = await reader.readLog(SESSION_A, { includeEvents: true });
  const f1 = inputFingerprint({ sessionId: SESSION_A, branchId: SESSION_A, sourceRevision: "r1", events: log.events });
  const f2 = inputFingerprint({ sessionId: SESSION_A, branchId: SESSION_A, sourceRevision: "r1", events: log.events });
  is("同输入同指纹", f1, f2);
  is("指纹是 64 位 hex", /^[0-9a-f]{64}$/.test(f1), true);

  const mutated = structuredClone(log.events);
  mutated[1].data.content[0].text = "改了正文";
  const f3 = inputFingerprint({ sessionId: SESSION_A, branchId: SESSION_A, sourceRevision: "r1", events: mutated });
  isNot("正文变化必须改变指纹", f3, f1);
  const f4 = inputFingerprint({ sessionId: SESSION_A, branchId: SESSION_A, sourceRevision: "r2", events: log.events });
  isNot("来源修订变化必须改变指纹", f4, f1);
  const f5 = inputFingerprint({ sessionId: SESSION_B, branchId: SESSION_B, sourceRevision: "r1", events: log.events });
  isNot("会话变化必须改变指纹", f5, f1);

  // seq 报告
  const rep = seqReport(log.events);
  is("seq 连续", rep.contiguous, true);
  is("seq 计数", rep.count, 21);
  is("seq 下界", rep.min, 0);
  is("seq 上界", rep.max, 20);
  const gap = seqReport([{ seq: 0 }, { seq: 1 }, { seq: 3 }]);
  falsy("有洞时必须报不连续", gap.contiguous);
  is("并列出缺口样本", gap.missing_sample.join(), "2");
}

// =========================================================================== //
console.log("\n[15] 无法离线验证的项（显式跳过，三分处理）");

{
  skip(
    "真实 DSH 宿主上 ctx.sessionQuery 的运行期注入",
    "离线层已由 test-host.mjs [11] 用忠实替身覆盖（注入生效、缺它时 503 HOST_UNSUPPORTED、"
    + "装载门要求 inject 声明 sessionQuery）；**真宿主**运行期核验必须重启 DSH 才能做，"
    + "属 M6 运行期验证步骤，须先征得用户同意",
  );
  skip(
    "真实 DSH 会话上的 surface 分类与 readSurface 差异实测",
    "离线替身按源码复刻；真实数据核验须在 M6 重启宿主后进行（M0 已实测 211 vs 2555）",
  );
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败${skipped ? ` / ${skipped} 跳过（环境限制，非通过）` : ""}`);
if (skipped) console.log("注：跳过项在本环境无法验证，不得算作通过。");
process.exit(fail ? 1 : 0);
