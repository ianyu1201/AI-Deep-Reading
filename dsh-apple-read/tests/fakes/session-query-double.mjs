/**
 * 忠实的宿主 `sessionQuery` 服务替身（M6）。
 *
 * ## 为什么要有这个文件
 *
 * M6 把 `sessionQuery` 加进了 `lib/index.js` 的 `inject`。cordis 的语义是
 * 「**全部**依赖就绪才调用 apply」——已用真 cordis 4.0.4 实测：
 *
 * ```
 * ctx.plugin({ inject: ["sessionQuery"], apply() { applied = true } });
 * // 服务未注册 ⇒ applied === false（不是抛错，是根本不装载）
 * ```
 *
 * 所以插件级的假 ctx **必须**提供一个 `sessionQuery`，否则插件在测试里「静默不装载」，
 * 而测试会误以为功能坏了。这个替身按 M2 的替身纪律复刻宿主契约：
 * 只实现真宿主**确实有**的方法与返回形状，不做「看起来能用」的简化。
 *
 * 宿主契约来源：`@deepseek-ai/dsh-session-query/lib/index.js`（0.2.0-rc.2），
 * 逐条对应见 `lib/reading/session-reader.js` 顶部那张表。
 *
 * ## 它不做什么
 *
 * - 不做 surface 推断：`listEvents` 的 `surface` 由调用方给的 `surface` 字段决定，
 *   替身**不**自己算 `shadowedSeqs`（真宿主才算；替身自己算就是在替插件作弊）。
 * - 不返回 `data.source` 给 `filterEvents`（真宿主的语义事件文档里没有它）。
 * - 不提供 `search`：真宿主在 `openAt: never` 下也没有内容检索。
 */

/** 让测试能一眼认出「这是替身」并断言替身确实被用上了。 */
export const SESSION_QUERY_DOUBLE = Symbol.for("dsh-apple-read.sessionQuery.double");

/**
 * @param {object} [opts]
 * @param {Array<{header: object, events: object[], live?: boolean, persisted?: boolean, revision?: string, turnOutline?: object}>} [opts.sessions]
 * @param {"faithful"|"missing-methods"} [opts.mode] `missing-methods` 用来验证插件在
 *        宿主能力不全时**如实降级**（不是假装读到）。
 */
export function createSessionQueryDouble({ sessions = [], mode = "faithful" } = {}) {
  const byId = new Map(sessions.map((s) => [s.header.id, s]));
  const calls = [];

  const must = (id) => {
    const s = byId.get(id);
    if (!s) {
      // 真宿主：找不到会话就抛（`readColdSessionLog` / `_corpus.load` 路径）
      const e = new Error(`session "${id}" not found`);
      e.code = "SESSION_NOT_FOUND";
      throw e;
    }
    return s;
  };

  const query = {
    [SESSION_QUERY_DOUBLE]: true,
    __calls: calls,
    __mode: mode,

    async listSessions() {
      calls.push("listSessions");
      return [...byId.values()]
        .map((s) => ({
          header: { ...s.header },
          live: s.live === true,
          persisted: s.persisted === true,
        }))
        .sort((a, b) => String(b.header.createdAt).localeCompare(String(a.header.createdAt))
          || String(a.header.id).localeCompare(String(b.header.id)));
    },

    async readSession(id) {
      calls.push("readSession");
      const s = must(id);
      return {
        session: { ...s.header },
        inheritedEventCount: s.header.inheritedEventCount ?? 0,
        // 完整原始日志：**含** data.source、含 log-only 维护事件（真宿主契约）
        events: (s.events ?? []).map((e) => structuredClone(e)),
      };
    },

    async listEvents(id) {
      calls.push("listEvents");
      const s = must(id);
      return (s.events ?? []).map((e) => ({
        sessionId: id,
        seq: e.seq,
        type: e.type,
        time: e.time ?? null,
        // surface 由 fixture 显式给出；真宿主由 analyzeEventLog 算出
        surface: e.surface ?? "log-only",
      }));
    },

    async readSurface(id) {
      calls.push("readSurface");
      const s = must(id);
      const events = (s.events ?? []).filter((e) => (e.surface ?? "log-only") === "current");
      return {
        session: { ...s.header },
        inheritedEventCount: s.header.inheritedEventCount ?? 0,
        capturedThroughSeq: (s.events ?? []).at(-1)?.seq ?? null,
        events: events.map((e) => structuredClone(e)),
      };
    },

    async filterEvents(id, filters = []) {
      calls.push("filterEvents");
      const s = must(id);
      // 忠实：语义事件文档**丢 data.source**，无文本的结构事件整条省略
      let docs = (s.events ?? [])
        .map((e) => {
          const text = typeof e.text === "string" ? e.text : "";
          if (!text) return null;
          return { sessionId: id, seq: e.seq, type: e.type, time: e.time ?? null, surface: e.surface ?? "log-only", text };
        })
        .filter(Boolean);
      for (const f of filters) {
        if (f?.kind === "type") docs = docs.filter((d) => f.values.includes(d.type));
        else if (f?.kind === "surface") docs = docs.filter((d) => f.values.includes(d.surface));
      }
      return docs;
    },

    async readEvent({ sessionId, seq, before = 0, after = 0 } = {}) {
      calls.push("readEvent");
      const s = must(sessionId);
      const all = s.events ?? [];
      const startSeq = Math.max(0, seq - before);
      const endSeq = Math.min((all.at(-1)?.seq ?? 0), seq + after);
      // 忠实：邻接窗口**不自动排除** shadowed
      return {
        session: { ...s.header },
        inheritedEventCount: s.header.inheritedEventCount ?? 0,
        target: all.find((e) => e.seq === seq) ?? null,
        events: all.filter((e) => e.seq >= startSeq && e.seq <= endSeq).map((e) => structuredClone(e)),
        startSeq,
        endSeq,
      };
    },

    async traceEvent({ sessionId, seq } = {}) {
      calls.push("traceEvent");
      const s = must(sessionId);
      const target = (s.events ?? []).find((e) => e.seq === seq) ?? null;
      return {
        session: { ...s.header },
        target,
        replacedBy: target?.replacedBy ?? null,
        replacementChain: target?.replacementChain ?? [],
        replacedEventSeqs: target?.replacedEventSeqs ?? [],
        sourceEventSeqs: target?.sourceEventSeqs ?? [],
        derivedEventSeqs: target?.derivedEventSeqs ?? [],
      };
    },

    async observeSession(id, { projectionMode = "none" } = {}) {
      calls.push("observeSession");
      const s = must(id);
      const persisted = s.persisted === true;
      const base = {
        source: persisted ? "prepared" : "live",
        header: { ...s.header },
        inheritedEventCount: s.header.inheritedEventCount ?? 0,
        events: (s.events ?? []).map((e) => structuredClone(e)),
        cursor: { seq: (s.events ?? []).at(-1)?.seq ?? null },
        retain: () => {},
        [Symbol.dispose]: () => {},
      };
      // 真宿主：只有 prepared lease 才有 revision（session-reader.js 顶部表）
      if (persisted && s.revision !== undefined) base.revision = s.revision;
      if (projectionMode !== "none" && s.turnOutline !== undefined) {
        base.projections = { turnOutline: structuredClone(s.turnOutline) };
      }
      return base;
    },
  };

  if (mode === "missing-methods") {
    // 用来验证「能力不全时如实降级」：把关键方法摘掉，插件必须报 unknown 而不是猜
    delete query.listEvents;
    delete query.readSurface;
  }

  return query;
}

/**
 * 忠实的 `sessionProjections` 服务替身。
 * 真宿主形状：`{ registrations, snapshot(session) }`（`session-reader.js:22`）。
 */
export function createSessionProjectionsDouble({ registrations = ["turnOutline"] } = {}) {
  const regs = new Map(registrations.map((k) => [k, { def: { key: k, stateVersion: k === "turnOutline" ? 2 : 1 } }]));
  return {
    registrations: regs,
    snapshot: () => undefined,
  };
}

/**
 * 造一组最小的忠实会话 fixture：一轮真人输入 + 一条系统注入 + 一条被遮蔽事件。
 *
 * `surface` 由 fixture 显式给出（替身不自己算），这样「替身是否忠实」是**可断言**的。
 */
export function sampleSessions() {
  return [
    {
      header: { id: "session-double-1", createdAt: "2026-10-10T00:00:00.000Z", cwd: "/tmp/ws", parentSession: null, isSeeded: false },
      live: false,
      persisted: true,
      revision: "rev-1",
      turnOutline: { ver: 2, seq: 3, val: { turns: [{ turn: 1, seq: 3, prompt: "问题", response: "回答" }] } },
      events: [
        { seq: 0, type: "session/start", time: "2026-10-10T00:00:00.000Z", surface: "current" },
        { seq: 1, type: "user/message", time: "2026-10-10T00:00:01.000Z", surface: "current", text: "我在读什么？", data: { role: "user", source: { kind: "user" } } },
        { seq: 2, type: "user/message", time: "2026-10-10T00:00:02.000Z", surface: "log-only", text: "系统注入", data: { role: "user", source: { kind: "time-context" } } },
        { seq: 3, type: "assistant/message", time: "2026-10-10T00:00:03.000Z", surface: "current", text: "你在读《第一哲学沉思集》。", data: { role: "assistant" } },
      ],
    },
  ];
}
