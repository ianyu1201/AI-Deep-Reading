"use strict";
/* DSH-apple-Read · 面板前端（同源 iframe，直接打 /apple-read/api/*） */

const API = "/apple-read/api";
const $ = (s) => document.querySelector(s);

const state = {
  books: [],
  annotations: [],
  current: null,
  providerId: null,
  history: [],
  sending: false,
  filter: "",
  withMarks: true,   // 聊天时是否把「我划的重点」一起喂给模型
  rerank: false,     // 是否用 cross-encoder 精排（boot 时按模型是否已下载决定）
  focusId: null,     // 点了「问 AI」的那条标注，会排到最前面
  hits: [],          // 「在书里找」的检索结果
  reading: null,     // 「导读」Tab：/apple-read/api/reading/* 的只读投影（纯展示）
  // M12 第 3 环：当前正在看的那段「推荐原文依据」。**只来自某条推荐的 source_refs**。
  //   {span_id, from, phase:"loading"|"done"|"error", data, error, requested_url, http_status, response_ok}
  source: null,
  analyze: null,     // M9「切片与理解」：{book_id,title,phase,report,error,note_rel,requested_url}
  // M10 阶段 3b：打开书时的**自动判定**结果（按 book_id）。**不猜**：判据全部来自后端。
  //   {phase:"checking"|"ran"|"skipped", checked, has_current_understanding, auto_trigger_allowed,
  //    state, revision, run_id, note_rel, message}
  auto: {},
};

// --------------------------------------------------------------------------- //
// 与父窗口（DSH 插件面板）通信
// --------------------------------------------------------------------------- //
// 面板被插件内嵌成左侧书库栏时，父窗口会发 `embed: true`：隐藏这里自带的聊天栏，
// 把「选书」和「问 AI」转交给父窗口 —— 对话交给右侧的 Harness 原生会话。
const embed = { on: false };

function toParent(message) {
  try {
    window.parent.postMessage(message, window.location.origin);
  } catch { /* 不在 iframe 里（直接打开 /apple-read/ 时） */ }
}

window.addEventListener("message", (ev) => {
  // 同源校验：父窗口就是提供这个页面的 Harness webServer
  if (ev.origin !== window.location.origin) return;
  const d = ev.data;
  if (d && typeof d === "object" && d.type === "apple-read:embed") {
    embed.on = d.value !== false;
    document.body.classList.toggle("embed", embed.on);
  }
});

// --------------------------------------------------------------------------- //
// 小工具
// --------------------------------------------------------------------------- //

async function api(path, opts) {
  const r = await fetch(API + path, opts);
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch { /* 非 JSON */ }
  if (!r.ok) {
    throw new Error((j && (j.error || j.detail)) || text.slice(0, 200) || ("HTTP " + r.status));
  }
  if (j === null) throw new Error("响应不是 JSON");
  return j;
}

/**
 * 把面板上的选择写回存档，并**读回确认**。
 *
 * 设置存在宿主侧 data.json（GET/POST /api/settings）。面板以前只改内存里的
 * state，刷新页面就被 config 默认值冲掉——provider 选择看起来「不保存」就是这个原因。
 * 保存失败只提示，不打断阅读。
 */
async function persistSettings(patch) {
  try {
    const r = await api("/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    const s = r && r.settings;
    if (s) {
      // 以服务端读回的值回填：万一被白名单校验挡掉，UI 不会显示一个其实没存上的值。
      if (typeof s.withMarks === "boolean") state.withMarks = s.withMarks;
      if (typeof s.rerank === "boolean") state.rerank = s.rerank;
      if (typeof s.providerId === "string") state.providerId = s.providerId;
    }
    return s || null;
  } catch (e) {
    toast("保存设置失败：" + e.message, true);
    return null;
  }
}

let toastTimer = null;
function toast(msg, isErr) {
  const el = $("#toast");
  el.textContent = msg;
  el.className = "toast show" + (isErr ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = "toast"; }, isErr ? 5200 : 2600);
}

/* ==== READING-VIEW BEGIN ==== */
/*
 * 两层推荐 UI 的**纯函数**区：不做任何 DOM 访问、不引用外部变量。
 *
 * 为什么单独圈出来：本轮要求「面板用 DOM 断言 + 变异测试，不要只靠肉眼看」。
 * `tests/reading-panel.test.mjs` 会**原样截取这一段源码**求值，再用夹具数据断言
 * 渲染结果；`tests/reading-panel.mutations.mjs` 则把这段代码故意改坏，要求测试变红。
 * 所以这里必须自包含、无副作用。
 */

/** HTML 转义（纯函数；app.js 其余部分也用它——函数声明会提升）。 */
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

const isMap = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v) => (typeof v === "string" && v.length ? v : null);

/**
 * 未知一律显示 `unknown`：**不显示 0，也不显示「中立」**。
 *
 * PRD :271「无依据保留 null 并显示 unknown，不填 0 或中立」。
 * 0 只有在「已有依据明确显示该维度不适用/不相关」时才是合法值（由 policy 侧保证），
 * 所以这里对 0 原样透出，只把 null/undefined/非有限数/空串判为 unknown。
 */
function fmtUnknown(v) {
  if (v === null || v === undefined) return "unknown";
  if (typeof v === "number" && !Number.isFinite(v)) return "unknown";
  if (typeof v === "string" && v.trim() === "") return "unknown";
  return String(v);
}

/* ---------- 「技术细节」折叠区（导读改版阶段 1） ---------- */

/**
 * 内部码（`sp_…` / `bv_…` / `sec_…` / `rr_…` / `ca_…`）与字段名
 * （`scope=` / `lambda_cap` / `NO_LAYER_INPUT` / `discovered_parseable_body_codepoints_union` …）
 * **只允许出现在这个折叠区里**。
 *
 * 为什么要有它：用户 2026-10-11 的原话是「展示的内容很多都是类似于代码或者富文本，
 * 好像没有正式的文章内容」。主视图应该只留人话结论，内部码收起来。
 *
 * **折叠 ≠ 删**（阶段 1b）：内容仍然完整地在 HTML 里，展开就能看到 ——
 * 诚实信息一个字都不许少。`tests/reading-panel.test.mjs` 会把 `gd-tech` 折叠区
 * **从主视图里剥掉**，断言主视图里没有任何内部码；同时断言折叠区里**仍然有**它们。
 */
function renderTech(inner, summary) {
  const label = str(summary) || "技术细节（内部码与字段名）";
  return '<details class="gd-tech"><summary>' + esc(label) + "</summary>"
    + '<div class="gd-tech-body">' + inner + "</div></details>";
}

/* ---------- 跨层读取路径（路由响应 → 两层渲染） ---------- */

/**
 * 面板**唯一**的「从 /reading/recommendations 响应里取 RecommendationResult」的地方。
 *
 * 为什么单独抽成函数：M7 的缺口正是「挂载点字段契约没有测试钉住」——
 * 路由给 `result`、面板读 `result`，这两件事分别写在两个文件里，谁改一边都不会红。
 * 抽出来之后 `tests/reading-projection-contract.test.mjs` 可以**原样截取**这段源码，
 * 拿**路由的真实响应**喂进**面板真实的读取路径**，再把结果交给**面板真实的渲染器**，
 * 于是「字段名不一致 / 形状不对 / 只有一层能渲染」都会变成可证伪的断言。
 *
 * 严格性：只接受**映射**（数组、字符串、null 一律当「没有结果」，走诚实空态）。
 */
function pickReadingResult(recommendations) {
  if (!isMap(recommendations)) return null;
  return isMap(recommendations.result) ? recommendations.result : null;
}

/**
 * 「这次显示的是哪一条理解」——只读投影。
 *
 * M10 阶段 2「一本书一个理解」之后，一本书只有**一条**理解笔记，所以不再有
 * 「是不是最新一次」「被谁取代」这类多 run 说法（`newest_run_id` / `result_is_latest` /
 * `result_superseded_by` 三个字段已从只读路由删掉）。改为如实报出**盘上有几条 ready 理解**：
 * 正常是 1 条；>1 说明有 M10 之前的历史遗留，或书被移动/改名使身份变了（路径寻址已知债）。
 * 缺字段时显示 unknown（不编造）。
 */
function renderRunIdentitySection(recommendations) {
  const out = ['<section class="gdsec" id="gd-run-sec">'];
  out.push('<div class="gdhd">这条导读来自哪一次理解</div>');
  if (!isMap(recommendations)) {
    out.push('<div class="gdempty" id="gd-run-unknown">没有读到推荐运行的投影，所以说不清这条导读来自哪一次理解。</div></section>');
    return out.join("");
  }
  const rid = str(recommendations.result_run_id);
  const readyCount = Number.isInteger(recommendations.ready_run_count) ? recommendations.ready_run_count : null;
  const ambiguous = recommendations.result_ambiguous === true;

  const tech = [];
  if (rid === null) {
    const err0 = isMap(recommendations.result_error) ? recommendations.result_error : {};
    out.push('<div class="gdempty" id="gd-run-none">没有可显示的理解（'
      + esc(fmtUnknown(err0.code)) + "）：" + esc(fmtUnknown(err0.message)) + "</div>");
  } else {
    out.push('<div class="gdrow" id="gd-run-ok">已读到一条可用的理解。</div>');
    tech.push('<div class="gdrow" id="gd-run-id">运行标识：<code>' + esc(rid) + "</code>"
      + " · state=" + esc(fmtUnknown(recommendations.result_run_state)) + "</div>");
    if (ambiguous) {
      out.push('<div class="gdwarn" id="gd-run-ambiguous">盘上有 '
        + esc(fmtUnknown(readyCount)) + " 条可用理解（正常一本书一条；多出来的是旧版本遗留，或书被移动/改名使身份变了）；"
        + "这里显示的是最新一条，<strong>没有替你删任何一条</strong>。</div>");
    } else if (readyCount !== null) {
      tech.push('<div class="gdrow gdsmall" id="gd-run-ready-count">盘上有 '
        + esc(String(readyCount)) + " 条可用理解（一本书一个理解）。</div>");
    }
  }
  const err = isMap(recommendations.result_error) ? recommendations.result_error : null;
  if (err) {
    // 错误码**故意留在主视图**：失败必须看得见，不能收进折叠区。
    out.push('<div class="gdwarn" id="gd-run-error">投影未完成：' + esc(fmtUnknown(err.code))
      + " —— " + esc(fmtUnknown(err.message)) + "</div>");
  }
  const proj = isMap(recommendations.result_projection) ? recommendations.result_projection : null;
  if (proj) {
    const np = Array.isArray(proj.not_persisted_metadata_fields) ? proj.not_persisted_metadata_fields : [];
    tech.push('<div class="gdrow gdsmall" id="gd-run-projection">这条结果是从已保存的理解笔记只读投影出来的；'
      + "笔记里没有持久化的元数据字段一律为 null（不填默认值）：" + esc(np.join("、") || "无") + "</div>");
  }
  // 2d：反馈的诚实核对（复算覆盖理解后，反馈指向的条目可能已经不在了）
  const fb = isMap(recommendations.feedback_refs) ? recommendations.feedback_refs : null;
  if (fb) {
    const bound = Number.isInteger(fb.bound_to_current_run) ? fb.bound_to_current_run : null;
    const batch = Number.isInteger(fb.batch) ? fb.batch : null;
    const dangling = Array.isArray(fb.dangling) ? fb.dangling : [];
    const unreadable = Array.isArray(fb.unreadable) ? fb.unreadable : [];
    // 主视图用**结构化计数**自己说人话；后端那句原文（里面带 run_id）收进折叠区。
    const fbParts = [];
    fbParts.push(bound === null ? "这条理解上的反馈条数后端没给" : "这条理解上有 " + bound + " 条反馈");
    fbParts.push(dangling.length === 0
      ? "指向的条目都还在当前理解中"
      : "其中 " + dangling.length + " 条指向的条目已不在当前理解中（下面已如实列出）");
    if (batch !== null && batch > 0) fbParts.push("另有 " + batch + " 条批次反馈（本来就不指向具体条目）");
    if (unreadable.length > 0) fbParts.push(unreadable.length + " 条反馈读不到（如实报出，不当成 0）");
    out.push('<div class="gdrow gdsmall" id="gd-feedback">' + esc(fbParts.join("；")) + "。</div>");
    if (dangling.length > 0) {
      // 悬空引用必须看得见（不装作还在）；但 item_id 是内部码，只进折叠区。
      out.push('<div class="gdwarn" id="gd-feedback-dangling">有反馈指向的条目<strong>已不在当前理解中</strong>：'
        + dangling.map((d) => esc(fmtUnknown(d.note_rel))).join("、") + "（复算换掉了这些条目）</div>");
      tech.push('<div class="gdrow gdsmall" id="gd-feedback-dangling-raw">悬空引用的 item_id：'
        + dangling.map((d) => esc(fmtUnknown(d.item_id))).join("、") + "</div>");
    }
    if (unreadable.length > 0) {
      out.push('<div class="gdwarn" id="gd-feedback-unreadable">⚠️ ' + esc(String(unreadable.length))
        + " 条反馈读不到（失败窗口，如实报出，不当成 0）</div>");
      tech.push('<div class="gdrow gdsmall" id="gd-feedback-unreadable-raw">读不到的反馈笔记：'
        + unreadable.map((d) => esc(fmtUnknown(d.note_rel)) + "（" + esc(fmtUnknown(d.reason)) + "）").join("、")
        + "</div>");
    }
    if (str(fb.note)) {
      tech.push('<div class="gdrow gdsmall" id="gd-feedback-raw">后端原文：' + esc(str(fb.note)) + "</div>");
    }
  }
  if (tech.length) out.push(renderTech(tech.join("")));
  out.push("</section>");
  return out.join("");
}

/* ---------- 五类证据标签（《索引与模板规范》§3 :66-78） ---------- */

/**
 * **闭合值域**。不是 1—5 分量表，也**不把「待复核」排成最高**。
 * strength / confidence 与这五类**正交**，不做数值化转换。
 */
const EVIDENCE_LABELS = Object.freeze(["未知", "自报熟悉", "有一次解释证据", "有迁移证据", "待复核"]);

/**
 * 由 ReadingEvidence 的 kind / dimension / source_refs / assessment_basis /
 * valid_until 及归属与确认状态派生展示标签（规范 :70-78）。
 *
 * 顺序照规范 :78：先查「已有观察是否需复核」→ 再查「本次证据是否足够」
 * → 最后按 kind/dimension 匹配三类正向观察；未匹配则未知并给出原因。
 * `nowIso` 显式传入（不读系统时钟），保证可重复、可证伪。
 *
 * 返回值除 `label` / `reason` 外还带 `stale`（需复核的**原因码**：expired / retracted /
 * source_unavailable / disputed / not_active；不需要复核时为 null）。
 * 为什么要把原因码也返回：面板要**如实标「过期」**，但过期判定只能有**这一份**实现 ——
 * 于是把这里已经算出来的结论透出去，而不是在渲染处再比一次 `valid_until`。
 */
function evidenceLabel(ev, nowIso) {
  const e = isMap(ev) ? ev : {};
  const kind = str(e.kind);
  const dim = str(e.dimension);
  const refs = Array.isArray(e.source_refs)
    ? e.source_refs.filter((r) => r !== null && r !== undefined && r !== "")
    : [];
  const basis = str(e.assessment_basis);
  const origin = str(e.origin);
  const confirmation = str(e.confirmation);
  const hasObservation = kind !== null || dim !== null;

  // ① 已有观察需复核：过期 / 撤回 / 来源失效 / 有来源的争议 / 依据状态不是 active ⇒ 优先显示待复核
  if (hasObservation) {
    let stale = null;
    let staleCode = null;
    if (e.source_unavailable === true) { stale = "来源已失效"; staleCode = "source_unavailable"; }
    else if (confirmation === "retracted") { stale = "观察已撤回"; staleCode = "retracted"; }
    else if (e.disputed === true) { stale = "出现有来源的争议"; staleCode = "disputed"; }
    else if (str(e.valid_until) !== null && str(nowIso) !== null && String(e.valid_until) < String(nowIso)) {
      stale = "观察已过期"; staleCode = "expired";
    } else if (str(e.knowledge_status) !== null && str(e.knowledge_status) !== "active") {
      // 证据笔记状态不是 active（withdrawn / superseded / disputed）⇒ 不能再当有效依据。
      // 只在**字段确实给了**时才判：缺字段保持「不判」（不把「没给」当成「失效」）。
      stale = "依据状态不是 active（" + str(e.knowledge_status) + "）"; staleCode = "not_active";
    }
    if (stale) return { label: "待复核", reason: stale + "；保留原维度与依据，不认定反向能力结论", stale: staleCode };
  }

  // ② 本次证据是否足够：缺字段保持 null/unknown，**不赋中立分、不补 medium**
  if (kind === null || dim === null) {
    return { label: "未知", reason: "缺少 kind 或 dimension：保持 null/unknown，不赋中立分、不补 medium", stale: null };
  }
  if (refs.length === 0) return { label: "未知", reason: "没有可核验的 source_refs", stale: null };
  if (basis === null) return { label: "未知", reason: "assessment_basis 为空：不凭数字评级", stale: null };

  // ③ 按 kind / dimension 匹配三类正向观察（规范 :73-75）
  if (kind === "self_report" && dim === "familiarity") {
    if (origin !== "user" || confirmation !== "confirmed") {
      return { label: "未知", reason: "自报熟悉须 origin=user 且 confirmation=confirmed", stale: null };
    }
    return { label: "自报熟悉", reason: "仅支持自述，不推导解释或应用能力", stale: null };
  }
  if (kind === "observed_performance" && dim === "explanation") {
    return { label: "有一次解释证据", reason: "一次表现，不升级为永久掌握", stale: null };
  }
  if (kind === "observed_performance" && dim === "application") {
    return { label: "有迁移证据", reason: "限该场景，不推广到其他场景", stale: null };
  }
  if (dim === "retention") {
    return { label: "未知", reason: "保留情况需对应可信观察，不凭熟悉或一次解释推导", stale: null };
  }
  return { label: "未知", reason: "kind=" + kind + " / dimension=" + dim + " 未匹配任何正向观察类别", stale: null };
}

/* ---------- 第 4 环（M14）：面板上能选的「这次互动是什么」 ---------- */

/**
 * 只映射到规范 §3 的 `kind` / `dimension`，**不新增类别、不给分**。
 * `explicit_preference` 不带 dimension —— 显式偏好只影响兴趣、不描述能力（规范 §3 `:78`）。
 */
const EVIDENCE_KIND_OPTIONS = Object.freeze([
  Object.freeze({ kind: "observed_performance", dimension: "explanation", label: "我解释了一遍（有一次解释证据）" }),
  Object.freeze({ kind: "observed_performance", dimension: "application", label: "我在别处用上了（有迁移证据）" }),
  Object.freeze({ kind: "self_report", dimension: "familiarity", label: "我只是熟悉 / 听说过（自报熟悉）" }),
  Object.freeze({ kind: "explicit_preference", dimension: null, label: "这是我的偏好（只影响兴趣，不算能力）" }),
]);

/**
 * 落盘**之前**先给用户看「按你现在选的会派生哪个标签」。
 *
 * 用**占位**来源与依据预演（真实来源要等写下去才有），所以界面上如实标「预演」，
 * 不把它说成最终结论；派生仍然走 `evidenceLabel()`（规范 §3 唯一一份实现，不重写）。
 */
function evidenceLabelPreview({ kind, dimension, origin } = {}) {
  const synthetic = {
    kind: kind ?? null,
    dimension: dimension ?? null,
    origin: origin ?? "user",
    confirmation: "unconfirmed",
    source_refs: [{ source_kind: "user_action", ref: { actor: "user", action_id: "preview" } }],
    assessment_basis: "预演：用户即将写下的原话",
    valid_until: null,
  };
  return evidenceLabel(synthetic, null);
}

/* ---------- 两层去重并集 ---------- */

/** `scores` 的键集合（PRD :935）。注意是 ASCII `lambda`，不是 `λ`。 */
const SCORE_KEYS = ["B", "R", "G", "T", "W", "C", "q", "lambda", "U", "S"];
const PERSONAL_DIMS = ["R", "G", "T"];
const LAYER_NAMES = { extraction: "抽取", analysis: "分析", reading: "阅读" };

/**
 * 两层 items 的**去重并集**，每项标 `book` / `personalized` / `both`。
 *
 * PRD :971：selected_items 是两层 items 的去重并集，**不是第三层权威结果**。
 * policy 的 `computeSelectedItems` 不进 RecommendationResult（:936 顶层恰好 7 键），
 * 所以面板按同一语义自己算；合并重复项时**保留两类理由**（PRD :282）。
 */
function buildSelectedItems(result) {
  const r = isMap(result) ? result : {};
  const guide = isMap(r.book_guide) ? r.book_guide : {};
  const bookItems = Array.isArray(guide.items) ? guide.items.filter(isMap) : [];
  const pItems = Array.isArray(r.personalized_items) ? r.personalized_items.filter(isMap) : [];

  const bookById = new Map();
  for (const it of bookItems) {
    const id = str(it.candidate_id);
    if (id && !bookById.has(id)) bookById.set(id, it);
  }
  const persById = new Map();
  for (const it of pItems) {
    const id = str(it.candidate_id);
    if (id && !persById.has(id)) persById.set(id, it);
  }
  const personalReasonsOf = (it) => {
    const rs = isMap(it.reasons) ? it.reasons : {};
    return Array.isArray(rs.personal) ? rs.personal.filter((x) => typeof x === "string") : [];
  };

  const out = [];
  for (const [id, it] of bookById) {
    const p = persById.get(id) || null;
    out.push({
      candidate_id: id,
      layer: p ? "both" : "book",
      book_reason: str(it.reason),
      personal_reasons: p ? personalReasonsOf(p) : [],
    });
  }
  for (const [id, it] of persById) {
    if (bookById.has(id)) continue;
    out.push({ candidate_id: id, layer: "personalized", book_reason: null, personal_reasons: personalReasonsOf(it) });
  }
  return out;
}

/* ---------- 各区块渲染 ---------- */

function renderLibraryLine(library) {
  const lib = isMap(library) ? library : null;
  if (!lib) return '<div class="gdrow gdsmall">知识库：尚未读取。</div>';
  if (lib.ok === false) {
    return '<div class="gdrow gdsmall">知识库：读取失败 ' + esc(fmtUnknown(lib.code)) + "</div>";
  }
  if (isMap(lib.empty_state)) {
    return '<div class="gdrow gdsmall" id="gd-lib">知识库：' + esc(fmtUnknown(lib.empty_state.message))
      + "（空目录本身不算书籍/知识记录）</div>";
  }
  const c = isMap(lib.counts) ? lib.counts : {};
  return '<div class="gdrow gdsmall" id="gd-lib">知识库：书 ' + esc(fmtUnknown(c.book))
    + " · 全书概括 " + esc(fmtUnknown(c.book_summary))
    + " · 逐章概括 " + esc(fmtUnknown(c.chapter_summary))
    + " · 正式有效 " + esc(fmtUnknown(c.formal_valid_total))
    + " · 校验不过 " + esc(fmtUnknown(c.invalid_total)) + "</div>";
}

/**
 * 逐章 / 逐片段的 CoverageUnit.state。
 * 宿主没给逐单元明细时**如实说未知**，不按 0 处理（runtime.js:710-720 的口径）。
 */
/**
 * 内部码 → 人话。**认得的码给人话，不认得的原样显示**（不藏信息、不编解释）。
 * 原始码始终会在同一块的「技术细节」折叠区里原样保留一份。
 */
const INTERNAL_CODE_HUMAN = Object.freeze({
  NO_LAYER_INPUT: "还没有可解析的正文输入，这一层算不出来",
  discovered_parseable_body_codepoints_union: "已发现的可解析正文，按 span 区间并集去重",
  parsed_body: "可解析的正文",
});

function humanCode(code, fallback) {
  const c = str(code);
  if (c === null) return str(fallback) || "未知";
  return INTERNAL_CODE_HUMAN[c] || c;
}

/**
 * 逐章 / 逐片段的 CoverageUnit.state。
 * 宿主没给逐单元明细时**如实说未知**，不按 0 处理（runtime.js:710-720 的口径）。
 *
 * 阶段 1：逐单元明细里带 `section_id`（内部码）⇒ 整份明细收进「技术细节」折叠区；
 * 主视图只留计数与状态说明。**折叠 ≠ 删**：每条原因都还在，展开就能看到。
 */
function renderUnitsBlock(rep, coverageBody) {
  const out = [];
  const units = rep.units;
  const list = Array.isArray(units) ? units
    : (isMap(units) && Array.isArray(units.list) ? units.list
      : (isMap(units) && Array.isArray(units.items) ? units.items : null));
  const counts = isMap(units) ? units : {};

  out.push('<div class="gdsub">逐章 / 逐片段：每一段分析到哪一步</div>');
  out.push('<div class="gdrow gdsmall" id="gd-unit-counts">pending ' + esc(fmtUnknown(counts.pending))
    + " · processed " + esc(fmtUnknown(counts.processed))
    + " · failed " + esc(fmtUnknown(counts.failed))
    + " · excluded " + esc(fmtUnknown(counts.excluded))
    + " · 计入理解完成 " + esc(fmtUnknown(counts.counts_as_understood))
    + "（excluded 不计入）</div>");

  if (!list) {
    const why = isMap(coverageBody) && coverageBody.units_known === false
      ? humanCode(coverageBody.units_reason)
      : "宿主未提供逐单元明细";
    out.push('<div class="gdempty" id="gd-units-unknown">逐章/逐片段明细：未知（' + esc(why) + "）。未知不按 0 处理。</div>");
  } else {
    const detail = [];
    for (const u of list) {
      const unit = isMap(u) ? u : {};
      const state = str(unit.state) || "未知";
      detail.push('<div class="gdunit" data-state="' + esc(state) + '">'
        + '<span class="gdname">' + esc(fmtUnknown(unit.section_id !== undefined ? unit.section_id : unit.unit_id)) + "</span>"
        + '<span class="gdstate s-' + esc(state) + '">' + esc(state) + "</span>");
      if (state === "excluded") {
        const reason = isMap(unit.exclusion) ? str(unit.exclusion.reason) : null;
        detail.push(reason
          ? '<span class="gdsmall">排除原因：' + esc(reason) + "；excluded 不计作理解完成</span>"
          : '<span class="gdsmall gdbad">缺少排除原因（契约要求 excluded 必须给明确原因）</span>');
      } else if (state === "processed") {
        detail.push('<span class="gdsmall">已通过语义分析校验；这不等于你已读懂</span>');
      } else if (state === "failed") {
        const f = isMap(unit.failure) ? unit.failure : {};
        detail.push('<span class="gdsmall">失败：' + esc(fmtUnknown(f.code)) + " " + esc(f.message || "") + "</span>");
      } else if (state === "pending") {
        detail.push('<span class="gdsmall">排队中，尚未分析</span>');
      }
      detail.push("</div>");
    }
    out.push('<div class="gdrow gdsmall" id="gd-units-count">逐单元明细共 ' + esc(String(list.length))
      + " 条（每条的状态与原因在技术细节里，一条不少）。</div>");
    out.push(renderTech(detail.join(""), "技术细节：逐单元明细（含 section_id）"));
  }
  out.push('<div class="gdwarn" id="gd-excluded-note">excluded 不计作理解完成；failed 只表示该单元失败，任务仍可报告部分成果。</div>');
  return out.join("");
}

/**
 * 覆盖展示（PRD :346 / :204）——本轮最容易说谎的地方，所以每条断言都落在具体元素上：
 *   · 必须显示**分母**，以及未知部分的数量/占比**是否可知**；
 *   · 未知部分存在（或占比不可知）时，`#gd-wholebook` 只能是「不宣称」；
 *   · 「已读懂」恒不可宣称（`claims.book_understood.allowed` 恒 false），
 *     且**不得由处理进度推出**——所以这里根本不读进度，写死不可宣称；
 *   · 抽取层与分析层分开显示，「切片完成」不得显示成「分析完成」。
 */
function renderCoverageSection(coverage, library) {
  const out = ['<section class="gdsec" id="gd-cov">'];
  out.push('<div class="gdhd">全库口径 · 覆盖范围（跨整个知识库，不按当前选中的书过滤）</div>');
  out.push('<div class="gdrow gdsmall" id="gd-scope-note">以下是 45-书籍/ 的全库只读投影'
    + "（跨整个知识库），不按当前选中的书过滤 —— 所以切书不会改变这一块。</div>");
  out.push(renderLibraryLine(library));

  const c = isMap(coverage) ? coverage : null;
  if (!c) {
    out.push('<div class="gdempty">覆盖数据尚未读取。</div></section>');
    return out.join("");
  }
  if (c.ok === false) {
    out.push('<div class="gdempty">覆盖数据读取失败：' + esc(fmtUnknown(c.code)) + " " + esc(c.message || "") + "</div></section>");
    return out.join("");
  }

  const rep = isMap(c.report) ? c.report : {};
  const hon = isMap(rep.honesty) ? rep.honesty : {};
  const unk = isMap(rep.unknown) ? rep.unknown : {};
  const claims = isMap(rep.claims) ? rep.claims : {};
  const layers = isMap(rep.layers) ? rep.layers : {};

  // 分母：只有「至少一层真的算出过覆盖」或「分母 > 0」时才显示数字。
  // 路由在没有输入时给的是 0（coverage.js 的副产品），直接透出等于把「不知道」
  // 显示成 0 —— 这正是 runtime.js:710-720 明确禁止的。
  const layersKnown = ["extraction", "analysis", "reading"].some((k) => isMap(layers[k]) && layers[k].known === true);
  const denomKnown = layersKnown || (typeof hon.denominator_codepoints === "number" && hon.denominator_codepoints > 0);
  // 折叠区的内容先攒着，最后一次性 renderTech 出去（声明放前面，免得后面的块引用不到）。
  const covTech = [];

  // 阶段 3「结论先行」：先给**能不能宣称**的结论，再给数字与明细。
  // 这些「不宣称 / 不可宣称」是这一块最要紧的话，**永远留在主视图**（不进折叠区）。
  const allowed = hon.whole_book_claim_allowed === true;
  const pct = allowed && typeof hon.whole_book_percent === "number" ? String(hon.whole_book_percent) + "%" : "不宣称";
  out.push('<div class="gdnever" id="gd-wholebook">整本覆盖率：<b>' + esc(pct) + "</b></div>");
  out.push('<div class="gdwarn" id="gd-wholebook-note">未知部分存在、或未知部分占比不可知时，界面不给出整本覆盖率。</div>');

  const bu = isMap(claims.book_understood) ? claims.book_understood : {};
  out.push('<div class="gdnever" id="gd-understood">是否已读懂：<b>不可宣称</b>'
    + '<span class="gdsmall">' + esc(bu.reason || "「已读懂」必须由用户真实阅读与讨论证据支持，不能由抽取/分析/处理进度推出") + "</span></div>");

  const ex = isMap(claims.extraction_complete) ? claims.extraction_complete : {};
  const an = isMap(claims.analysis_complete) ? claims.analysis_complete : {};
  out.push('<div class="gdrow gdsmall" id="gd-claims">抽取完成：' + (ex.allowed === true ? "可宣称" : "不可宣称")
    + " · 分析完成：" + (an.allowed === true ? "可宣称" : "不可宣称") + "</div>");
  out.push('<div class="gdwarn" id="gd-slice-not-analysis">「切片完成」不等于「分析完成」：抽取层与分析层分开计，不得用抽取覆盖冒充分析覆盖。</div>');

  // 下面是「结论背后的数字」：先分母，再三层覆盖，再未知部分。
  out.push('<div class="gdrow">分母（已发现的可解析正文，按 span 区间并集去重）：<b id="gd-denom">'
    + (denomKnown ? esc(fmtUnknown(hon.denominator_codepoints)) : "unknown") + "</b> 字符</div>");
  out.push('<div class="gdrow gdsmall">分母口径：' + esc(humanCode(hon.denominator_basis, "未知"))
    + (denomKnown ? "" : "；当前没有可解析正文的输入，分母未知，不按 0 处理") + "</div>");

  covTech.push('<div class="gdrow gdsmall">denominator_basis=' + esc(fmtUnknown(hon.denominator_basis))
    + " · scope=" + esc(fmtUnknown(hon.scope)) + "</div>");
  for (const key of ["extraction", "analysis", "reading"]) {
    const L = isMap(layers[key]) ? layers[key] : {};
    const known = L.known === true && typeof L.percent === "number";
    out.push('<div class="gdrow" id="gd-layer-' + key + '"><span class="gdname">' + LAYER_NAMES[key] + "覆盖</span>"
      + "<b>" + (known ? esc(String(L.percent) + "%") : "未知") + "</b>"
      + '<span class="gdsmall">' + esc(known ? "已计" : humanCode(L.reason, "后端没给原因")) + "</span></div>");
    covTech.push('<div class="gdrow gdsmall">layer=' + esc(key)
      + " · known=" + (L.known === true ? "true" : "false")
      + " · percent=" + esc(fmtUnknown(L.percent))
      + " · reason=" + esc(fmtUnknown(L.reason))
      + " · denominator_codepoints=" + esc(fmtUnknown(L.denominator_codepoints))
      + " · covered_codepoints=" + esc(fmtUnknown(L.covered_codepoints)) + "</div>");
  }

  const kinds = isMap(unk.kinds) ? unk.kinds : {};
  const parts = [["unparseable", "无法解析"], ["missing", "缺失"], ["image_page", "图片页"]].map(([k, label]) => {
    const v = isMap(kinds[k]) ? kinds[k] : {};
    return label + " " + (v.known === true ? fmtUnknown(v.count) : "未知");
  });
  out.push('<div class="gdrow" id="gd-unknown">未知部分：' + esc(parts.join(" / ")) + "</div>");
  out.push('<div class="gdrow gdsmall" id="gd-unknown-known">数量是否可知：<b>'
    + (unk.counts_known === true ? "可知" : "不可知") + "</b> · 占比是否可知：<b>"
    + (unk.ratio_known === true ? "可知" : "不可知") + "</b></div>");

  out.push(renderUnitsBlock(rep, c));
  if (covTech.length) out.push(renderTech(covTech.join(""), "技术细节：覆盖账本的原始字段"));
  out.push("</section>");
  return out.join("");
}

/**
 * 引擎给的「理由」是一整串：人话部分 + 末尾一个 Python dict 调试转储
 * （`books_rag.py` 里恒定拼上的 `；结构标记 {…}`）。
 *
 * 这个函数**只做展示切分**，不改写内容：人话部分留在主视图，dict 转储收进
 * 「技术细节」折叠区；原始整串**始终原样保留一份**在折叠区里（折叠 ≠ 删）。
 * 找不到那个标记 ⇒ 原样返回（不猜、不截断）—— 这样引擎改格式也不会显示错东西。
 */
const REASON_MARK = "；结构标记 ";
function splitEngineReason(reason) {
  const s = typeof reason === "string" ? reason : "";
  const i = s.indexOf(REASON_MARK);
  if (i < 0) return { human: s, marks: null };
  return { human: s.slice(0, i), marks: s.slice(i + 1) };
}

/**
 * 「这本书」区（导读改版阶段 2 · 第一屏第一件事：这本书是什么 / 分析到哪一步）。
 *
 * 数据来自 `GET /reading/understanding-status?path=<epub>`（按**这本书**查，不是全库）。
 * 拿不到就如实说拿不到 —— 不猜成「还没有理解」（那会误导用户去重跑）。
 */
function renderBookSection(book) {
  const out = ['<section class="gdsec" id="gd-book">'];
  out.push('<div class="gdhd">这本书</div>');
  if (!isMap(book)) {
    out.push('<div class="gdempty" id="gd-book-none">还没选中任何一本书。</div></section>');
    return out.join("");
  }
  out.push('<div class="gdrow" id="gd-book-title">《' + esc(fmtUnknown(book.title)) + "》"
    + (str(book.author) ? " — " + esc(str(book.author)) : "") + "</div>");

  const st = isMap(book.status) ? book.status : null;
  if (!st) {
    out.push('<div class="gdwarn" id="gd-book-unknown">没读到这本书的理解状态 ⇒ '
      + "不猜成「还没有理解」（那会让人白跑一次分析）。</div></section>");
    return out.join("");
  }
  if (st.checked !== true) {
    out.push('<div class="gdwarn" id="gd-book-unchecked">后端没能确认这本书的理解状态（'
      + esc(fmtUnknown(st.code)) + "）：" + esc(fmtUnknown(st.message)) + " ⇒ 不猜。</div>");
  } else if (st.has_current_understanding === true) {
    out.push('<div class="gdrow" id="gd-book-ready">这本书盘上<strong>已有一条可用理解</strong>'
      + "（第 " + esc(fmtUnknown(st.revision)) + " 版）。要重算，去书库点「切片与理解」。</div>");
  } else {
    out.push('<div class="gdrow" id="gd-book-nothing">这本书盘上<strong>还没有理解</strong>。'
      + "要生成，去书库这本书上点「切片与理解」（会真跑分析并写盘）。</div>");
  }
  const tech = [];
  tech.push('<div class="gdrow gdsmall" id="gd-book-ids">content_id=' + esc(fmtUnknown(st.content_id))
    + " · book_version_id=" + esc(fmtUnknown(st.book_version_id))
    + " · run_id=" + esc(fmtUnknown(st.run_id))
    + " · note_rel=" + esc(fmtUnknown(st.note_rel)) + "</div>");
  if (str(st.message)) tech.push('<div class="gdrow gdsmall" id="gd-book-msg">' + esc(str(st.message)) + "</div>");
  out.push(renderTech(tech.join(""), "技术细节：这本书的身份与理解笔记"));
  out.push("</section>");
  return out.join("");
}

/**
 * 「这段导读是不是当前这本书的？」（导读改版阶段 2；方案 B 起这是**正常路径**）
 *
 * 方案 B 之后 `loadReading()` 会带 `?path=` 取**这本书**的理解，所以正常情况下
 * 两边身份一致 ⇒ 说「就是这本」。这里保留三态判定，是因为**降级路径还在**：
 * 没拿到 `state.current.path`、或后端没定出这本书的身份时，会退回读全库最新一条，
 * 那时必须**明说**它不是这本的，不许默认「就是这本」。
 *
 * 判据只有一份：书版本身份 `bv_<content_id>` vs 这本书的 `content_id`。
 *   · 两边都能核对且一致 ⇒ 说「就是这本」；
 *   · 都能核对但不一致 ⇒ 明确警告「不是这本」（说明退回了全库最新一条）；
 *   · 有一边身份缺失 ⇒ 如实说「无法确认」，不猜成「就是这本」。
 */
function renderGuideScopeBanner(g, book) {
  const scope = isMap(g) && isMap(g.coverage_scope) ? g.coverage_scope : {};
  const guideBv = str(scope.book_version_id);
  const guideCid = guideBv && guideBv.indexOf("bv_") === 0 ? guideBv.slice(3) : null;
  const st = isMap(book) && isMap(book.status) ? book.status : null;
  const bookCid = st && st.checked === true ? str(st.content_id) : null;
  const title = isMap(book) && str(book.title) ? "《" + str(book.title) + "》" : "当前选中的书";

  if (guideCid === null || bookCid === null) {
    return '<div class="gdrow gdsmall" id="gd-l1-scope-unknown">无法确认这段导读属于哪一本书'
      + "（缺可核对的书版本身份）—— 不猜成「就是这本」。</div>";
  }
  if (guideCid === bookCid) {
    return '<div class="gdrow" id="gd-l1-scope-book">这段导读就是当前这本 ' + esc(title) + " 的。</div>";
  }
  const tech = '<div class="gdrow gdsmall">导读书版本=' + esc(fmtUnknown(guideBv))
    + " · 当前书 content_id=" + esc(fmtUnknown(st.content_id)) + "</div>";
  return '<div class="gdwarn" id="gd-l1-scope-other">⚠️ 这段导读<strong>不是</strong>当前这本 '
    + esc(title) + " 的：书版本与这本对不上。"
    + "这通常说明这次没带上这本书的路径（或后端没能定出这本书的身份），"
    + "于是退回了「全库最新一条」可用理解 —— <strong>别把它当成这本书的导读</strong>。"
    + renderTech(tech, "技术细节：两个书版本对一下") + "</div>";
}

/** 第一层：书本导读。按书本价值 B 选，**完全不依赖个人背景**。 */
function renderBookGuideSection(result, book) {
  const out = ['<section class="gdsec" id="gd-l1">'];
  out.push('<div class="gdhd">值得读的章节 / 片段（按书本价值排序；不依赖你的个人背景）</div>');

  if (!isMap(result)) {
    out.push('<div class="gdempty" id="gd-l1-empty">尚无推荐结果：本机还没有可用的推荐理解。'
      + "面板只做展示，不生成数据。</div></section>");
    return out.join("");
  }
  if (result.outcome === "insufficient_evidence") {
    const cr = isMap(result.constraints_report) ? result.constraints_report : {};
    out.push('<div class="gdempty" id="gd-l1-abstain">整体弃权（insufficient_evidence）：'
      + esc(fmtUnknown(cr.insufficient_evidence_reason))
      + "。只有缺可信书内材料才整体弃权，空背景不是弃权理由。</div></section>");
    return out.join("");
  }

  const g = isMap(result.book_guide) ? result.book_guide : null;
  if (!g) {
    out.push('<div class="gdbad" id="gd-l1-broken">结构错误：outcome=items 但 book_guide 为空，本层不成立。</div></section>');
    return out.join("");
  }

  const paras = Array.isArray(g.overview_paragraphs)
    ? g.overview_paragraphs.filter((x) => typeof x === "string" && x.trim() !== "") : [];
  const refs = Array.isArray(g.source_refs)
    ? g.source_refs.filter((x) => x !== null && x !== undefined && x !== "") : [];
  const items = Array.isArray(g.items) ? g.items.filter(isMap) : [];
  const anchors = (() => {
    const md = isMap(result.policy_and_model_metadata) ? result.policy_and_model_metadata : {};
    return isMap(md.b_anchors) ? md.b_anchors : {};
  })();

  // 阶段 2：先回答「这段导读是不是当前这本书的」，再给内容。
  out.push(renderGuideScopeBanner(g, book));

  if (refs.length === 0) {
    out.push('<div class="gdbad" id="gd-l1-norefs">source_refs 为空：本层要求「有来源的浓缩」，来源缺失时不当导读展示。</div>');
  }
  out.push('<div class="gdsub">导读浓缩（书里的原话与要点）</div>');
  if (paras.length === 0) out.push('<div class="gdempty">浓缩为空（overview_paragraphs 没有内容）。</div>');
  for (const p of paras) out.push('<p class="gdp">' + esc(p) + "</p>");

  const scope = isMap(g.coverage_scope) ? g.coverage_scope : {};
  const sectionCount = Array.isArray(scope.section_ids) ? scope.section_ids.length : null;
  const headTech = [];
  headTech.push('<div class="gdrow gdsmall" id="gd-l1-scope-raw">scope=' + esc(fmtUnknown(scope.scope))
    + " · book_version_id=" + esc(fmtUnknown(scope.book_version_id))
    + " · section_ids=" + (sectionCount === null ? "unknown" : sectionCount + " 个") + "</div>");
  out.push('<div class="gdrow gdsmall" id="gd-l1-scope">已解析 / 已分析范围：'
    + esc(humanCode(scope.scope, "未知")) + " · 章节数 "
    + (sectionCount === null ? "unknown" : esc(String(sectionCount))) + "</div>");
  out.push('<div class="gdrow gdsmall" id="gd-l1-refs">来源引用（source_refs，' + refs.length + " 条）"
    + (refs.length ? "，每条都能点「看原文」核对。" : "。") + "</div>");
  headTech.push('<div class="gdrow gdsmall" id="gd-l1-refs-raw">' + esc(refs.join("、") || "无") + "</div>");
  out.push(renderTech(headTech.join(""), "技术细节：范围与来源引用标识"));
  // M12：导读浓缩自己的 source_refs 同样可「看原文」（仍是这条推荐自己的引用）
  out.push(renderSourceRefs(refs, "第一层 导读浓缩"));

  out.push('<div class="gdsub">按书本价值选出的章节 / 片段（共 ' + items.length + " 条）</div>");
  if (items.length === 0) {
    const reason = str(g.no_eligible_reason);
    out.push(reason
      ? '<div class="gdempty" id="gd-l1-noeligible">本层无可用项，原因：' + esc(reason) + "</div>"
      : '<div class="gdbad" id="gd-l1-noeligible-missing">结构错误：items 为空却没有真实 no_eligible_reason。</div>');
  }
  for (const it of items) {
    const b = it.B;
    const anchor = anchors[String(b)];
    const split = splitEngineReason(it.reason);
    const ir = Array.isArray(it.source_refs) ? it.source_refs.filter((x) => x !== null && x !== undefined && x !== "") : [];
    out.push('<div class="gditem" data-cid="' + esc(String(it.candidate_id == null ? "" : it.candidate_id)) + '">');
    // 主视图：只给「这一段为什么值得读」的人话结论（类别 + 依据），内部码全部进折叠区。
    out.push('<div class="gdit-h">'
      + '<span class="gdbadge b">' + esc(anchor ? String(anchor) : "书本价值 " + fmtUnknown(b)) + "</span>"
      + '<span class="gdsmall">书内原文 ' + ir.length + " 处</span></div>");
    out.push('<div class="gdsmall">理由：' + esc(split.human || "（引擎没给理由）") + "</div>");
    const tech = [];
    tech.push('<div class="gdrow gdsmall" id="gd-l1-item-scope">section_id=' + esc(fmtUnknown(it.section_id))
      + " · B=" + esc(fmtUnknown(b)) + "</div>");
    // 这一行是变异 F 的锚点（第二层分值混进第一层）：保持独立语句。
    tech.push('<div class="gdsmall gdcid">candidate_id：' + esc(fmtUnknown(it.candidate_id)) + "</div>");
    tech.push('<div class="gdrow gdsmall" id="gd-l1-item-reason-raw">引擎理由原文：'
      + esc(fmtUnknown(it.reason)) + "</div>");
    if (split.marks) {
      tech.push('<div class="gdrow gdsmall" id="gd-l1-item-marks">结构标记：' + esc(split.marks) + "</div>");
    }
    tech.push('<div class="gdrow gdsmall" id="gd-l1-item-refs-raw">source_refs：' + esc(ir.join("、") || "无") + "</div>");
    out.push(renderTech(tech.join(""), "技术细节：这一条的标识与引擎原文"));
    // M12：这条推荐**自己**引用的原文 → 可直接「看原文」（不重新检索、不拿标注顶替）
    out.push(renderSourceRefs(ir, "第一层 " + fmtUnknown(it.candidate_id)));
    out.push("</div>");
  }
  out.push("</section>");
  return out.join("");
}

/** `limited` 的原因：0<C<1 或 q=0.5（PRD :280）。 */
function limitedWhy(items) {
  const parts = [];
  for (const it of items) {
    const s = isMap(it.scores) ? it.scores : {};
    const cid = fmtUnknown(it.candidate_id);
    if (typeof s.C === "number" && s.C < 1) parts.push(cid + " 证据覆盖 C=" + s.C + " < 1");
    if (s.q === 0.5) parts.push(cid + " 含未确认观察或 AI 评估，q=0.5");
  }
  if (!parts.length) return "原因：选中项证据覆盖不完整或含未确认观察（C<1 或 q=0.5）。C/q 不是统计置信度。";
  return "原因：" + parts.join("；") + "。C/q 不是统计置信度。";
}

/**
 * 第二层：个性化叠加。只在真实授权材料存在时出现；空时显示「尚未个性化」态。
 * 两层理由与分值**不混写**：本区只写第二层理由，第一层理由归 #gd-l1。
 *
 * `evidence` = `GET /reading/evidence` 的只读响应（或证据数组）。它只用于一件事：
 * **3d 过期核对** —— run 里记的 `evidence_refs` 是不是**当前**已过期/失效。
 * 判定复用 `evidenceLabel()`（不在这里另比 `valid_until`）；清单里没有的 ref 判不了，
 * 就不标（不猜成「有效」也不猜成「过期」）。
 */
function renderPersonalizedSection(result, evidence) {
  const out = ['<section class="gdsec" id="gd-l2">'];
  out.push('<div class="gdhd">第二层 · 个性化叠加（只在真实授权材料存在时出现）</div>');

  if (!isMap(result)) {
    out.push('<div class="gdempty" id="gd-l2-empty">尚无推荐结果，个性化状态未知。</div></section>');
    return out.join("");
  }

  const status = str(result.personalization_status) || "none";
  const items = Array.isArray(result.personalized_items) ? result.personalized_items.filter(isMap) : [];
  const cr = isMap(result.constraints_report) ? result.constraints_report : {};
  const afe = isMap(cr.applied_feedback_exclusions) ? cr.applied_feedback_exclusions : {};

  // 3d：把 run 里记的 evidence_refs 跟**当前**证据清单对一遍。
  const evNotes = Array.isArray(evidence)
    ? evidence.filter(isMap)
    : (isMap(evidence) && Array.isArray(evidence.notes) ? evidence.notes.filter(isMap) : []);
  const evNow = isMap(evidence) ? str(evidence.now) : null;
  const noteById = new Map();
  for (const n of evNotes) {
    const nid = str(n.note_id);
    if (nid !== null) noteById.set(nid, n);
  }
  /** 这些 ref 里，当前已过期/失效的有哪些（判不了的 ref 直接跳过，不猜）。 */
  const staleRefsOf = (refs) => {
    const stale = [];
    for (const ref of refs) {
      const n = noteById.get(ref);
      if (!n) continue;
      const r = evidenceLabel(n, n.now ?? evNow);
      if (r.stale === "expired") stale.push({ ref, code: "expired" });
      else if (r.stale === "not_active") stale.push({ ref, code: "not_active" });
    }
    return stale;
  };

  const label = { none: "尚未个性化", limited: "有限个性化", available: "已个性化" }[status] || "尚未个性化";
  out.push('<div class="gdstatus" id="gd-status" data-status="' + esc(status) + '">' + esc(label) + "</div>");

  if (status === "none") {
    const unknownDims = Array.isArray(cr.unknown_dimensions) ? cr.unknown_dimensions : [];
    const why = afe.applied === true
      ? "无个人可用维度：仅有排除反馈（本次排除已应用，但没有可排序的个人依据）"
      : (unknownDims.length ? "无个人可用维度：R/G/T 均无依据（unknown，不填 0、不填中立）" : "无个人可用维度");
    out.push('<div class="gdrow gdsmall" id="gd-status-why">' + esc(why) + "</div>");
  } else if (status === "limited") {
    out.push('<div class="gdrow gdsmall" id="gd-status-why">' + esc(limitedWhy(items)) + "</div>");
  } else {
    // 3c-4：available **不等于**高置信。必须写明它只表示「个人依据齐了」。
    out.push('<div class="gdrow gdsmall" id="gd-status-why">available 只表示个人依据齐了'
      + "（全部选中项 C=1 且 q=1）：仍不代表已校准的高置信，也不代表已掌握。</div>");
  }

  // 仅排除反馈时**必须**另明示；不能假称没有使用反馈（PRD :280 硬要求）
  if (afe.applied === true) {
    const note = str(afe.note);
    out.push('<div class="gdwarn" id="gd-applied-exclusion">已应用本次排除'
      + (note && note !== "已应用本次排除" ? "（" + esc(note) + "）" : "")
      + "；本次确实使用了反馈，不假称没有使用反馈。</div>");
  }

  out.push('<div class="gdsub">个性化项</div>');
  if (items.length === 0) {
    out.push('<div class="gdempty" id="gd-l2-none">'
      + (status === "none" ? "尚未个性化：personalized_items 为空。" : "本层没有选中项。") + "</div>");
  }
  for (const it of items) {
    const scores = isMap(it.scores) ? it.scores : {};
    const reasons = isMap(it.reasons) ? it.reasons : {};
    const dimEv = isMap(it.dimension_evidence) ? it.dimension_evidence : {};
    out.push('<div class="gditem gditem-p" data-cid="' + esc(String(it.candidate_id == null ? "" : it.candidate_id)) + '">');

    // 两类理由分开写（不混写）—— 这两行是主视图里最有用的信息，保持可见。
    const bookSplit = splitEngineReason(reasons.book);
    out.push('<div class="gdsmall gdreason-book">书内理由（第一层同源）：' + esc(bookSplit.human || "无") + "</div>");
    const pers = Array.isArray(reasons.personal) ? reasons.personal.filter((x) => typeof x === "string") : [];
    out.push('<div class="gdsmall gdreason-personal">个人理由（第二层）：' + esc(pers.join("；") || "无") + "</div>");

    const tech = [];
    if (bookSplit.marks) {
      tech.push('<div class="gdrow gdsmall" id="gd-l2-book-reason-raw">书内理由原文：'
        + esc(fmtUnknown(reasons.book)) + "</div>");
    }
    tech.push('<div class="gdrow gdsmall" id="gd-l2-item-cid">candidate_id：' + esc(fmtUnknown(it.candidate_id)) + "</div>");
    tech.push('<div class="gdsmall">reason_code：' + esc(fmtUnknown(reasons.reason_code)) + "</div>");

    // 3c-1/3c-2：逐维度给「为什么这条推荐被个性化了」（reason）+「用了哪条证据」（笔记 id）。
    // 理由留在主视图（不能只给一个数字）；证据 id 进折叠区（可展开核对，不挡正文）。
    for (const d of PERSONAL_DIMS) {
      const e = isMap(dimEv[d]) ? dimEv[d] : null;
      if (!e) {
        out.push('<div class="gdsmall gddim">' + d + " 依据：unknown（无依据，不填 0、不填中立）</div>");
        continue;
      }
      const er = Array.isArray(e.evidence_refs) ? e.evidence_refs.filter(Boolean) : [];
      out.push('<div class="gdsmall gddim">' + d + " 依据：score=" + esc(fmtUnknown(e.score))
        + " · reason=" + esc(fmtUnknown(e.reason)) + "</div>");
      tech.push('<div class="gdsmall">' + d + " 证据（笔记 id）=" + esc(er.join("、") || "无") + "</div>");
      // 3d：这条维度的依据里若有**当前**已过期/失效的笔记 ⇒ 如实标「过期」，不能继续当有效依据。
      const staleRefs = staleRefsOf(er);
      if (staleRefs.length > 0) {
        const cid = String(it.candidate_id == null ? "" : it.candidate_id);
        out.push('<div class="gdrow gdsmall gdstale" id="gd-l2-stale-' + esc(cid + "-" + d) + '">'
          + "过期：这条 " + esc(d) + " 依据里 " + esc(staleRefs.map((x) => x.ref).join("、"))
          + " 当前已" + (staleRefs.some((x) => x.code === "expired") ? "过期" : "失效")
          + "，不再当成有效依据（清单里没有的引用判不了，不猜）。</div>");
      }
    }

    // 3c-3：q=0.5 必须说明**为什么**，不能只把 0.5 这个数摆出来（数字在下面的分值表里）。
    if (scores.q === 0.5) {
      out.push('<div class="gdrow gdsmall" id="gd-l2-qhalf-'
        + esc(String(it.candidate_id == null ? "" : it.candidate_id)) + '">'
        + "q=0.5：依据里包含未确认观察或 AI 评估，所以 q=0.5，叠加系数被减半（这不是统计置信度）。</div>");
    }

    // 分值表整体进折叠区：它是给核对用的明细，不是给人读的结论。
    tech.push('<div class="gdscores">' + SCORE_KEYS.map((k) =>
      '<span class="gdscore"><i>' + k + "</i>" + esc(fmtUnknown(scores[k])) + "</span>").join("") + "</div>");
    out.push('<div class="gdsmall">不确定性：' + esc(fmtUnknown(it.uncertainty)) + "</div>");
    const sr = Array.isArray(it.source_refs) ? it.source_refs.filter(Boolean) : [];
    out.push('<div class="gdsmall">来源：' + sr.length + " 条引用。</div>");
    tech.push('<div class="gdsmall" id="gd-l2-item-refs-raw">' + esc(sr.join("、") || "无") + "</div>");
    out.push(renderTech(tech.join(""), "技术细节：这一条的分值与引用标识"));
    // M12：第二层的 source_refs 里会**混着**非书内原文的引用（如 pe_*）——
    // renderSourceRefs 只给真 span 显示「看原文」，其余的如实标成取不到原文。
    out.push(renderSourceRefs(sr, "第二层 " + fmtUnknown(it.candidate_id)));
    out.push("</div>");
  }
  out.push("</section>");
  return out.join("");
}

/**
 * 五类证据标签区：闭合值域 + 逐条派生标签 + 「我确认这条观察」（M15 阶段 3）。
 *
 * `evidence` 两种形状都收（向后兼容旧夹具）：
 *   · **数组** ⇒ 直接当证据列表（每条可自带 `now`）；
 *   · **映射**（`GET /reading/evidence` 的响应）⇒ 取 `notes` + 顶层 `now`；
 *     `ok:false` 时**如实报错**，不显示成「没有证据」。
 *
 * 过期判定**只有一处**：`evidenceLabel()` 的 stale 分支（这里不另比一次 `valid_until`）。
 * `confirm` 是最近一次确认的回执（成功 / 已经确认过 / 失败三种**分开**说）。
 */
function renderEvidenceSection(evidence, confirm) {
  const out = ['<section class="gdsec" id="gd-ev">'];
  out.push('<div class="gdhd">学习证据标签（五类，闭合值域）</div>');
  out.push('<div class="gdrow gdsmall" id="gd-ev-range">值域：' + esc(EVIDENCE_LABELS.join(" / "))
    + "。不是 1—5 分量表，也不把「待复核」排成最高。</div>");
  out.push('<div class="gdrow gdsmall" id="gd-ev-orthogonal">strength / confidence 与这五类正交：不做数值化转换，缺字段保持 unknown，不赋中立分、不补 medium。</div>');

  const isResponse = isMap(evidence);
  const list = Array.isArray(evidence)
    ? evidence.filter(isMap)
    : (isResponse && Array.isArray(evidence.notes) ? evidence.notes.filter(isMap) : []);
  const nowIso = isResponse ? str(evidence.now) : null;

  // 确认回执：三种结果**分开**说。`changed:false` 绝不许显示成「刚刚确认成功」。
  const cf = isMap(confirm) ? confirm : null;
  if (cf) {
    const honesty = isMap(cf.honesty) ? cf.honesty : null;
    const doesNotMean = honesty && str(honesty.does_not_mean) !== null
      ? str(honesty.does_not_mean)
      : "确认 ≠ 高置信、≠ 已掌握、≠ 读懂这本书";
    if (cf.ok === true && cf.changed === true) {
      out.push('<div class="gdrow gdsmall gdconfirmres" id="gd-confirm-result">'
        + "已确认这条观察（q 从 0.5 变 1；这不代表高置信）。" + esc(doesNotMean) + "</div>");
    } else if (cf.ok === true) {
      out.push('<div class="gdrow gdsmall gdconfirmres" id="gd-confirm-result">'
        + "这条观察已经确认过了（没有重复写入）。" + esc(doesNotMean) + "</div>");
    } else {
      out.push('<div class="gdrow gdsmall gdconfirmres gdbad" id="gd-confirm-result">'
        + "确认没有成功：" + esc(fmtUnknown(cf.code)) + " —— " + esc(str(cf.message) || "后端没给原因")
        + "（不假装确认成功）</div>");
    }
  }

  if (isResponse && evidence.ok === false) {
    out.push('<div class="gdbad" id="gd-ev-error">证据清单读取失败：' + esc(fmtUnknown(evidence.code))
      + " —— " + esc(str(evidence.message) || "后端没给原因") + "。不显示成「没有证据」。</div>");
  } else if (list.length === 0) {
    out.push('<div class="gdempty" id="gd-ev-empty">未知：尚无可用能力证据。</div>');
  } else {
    if (isResponse && evidence.book_scoped === false) {
      out.push('<div class="gdrow gdsmall" id="gd-ev-unscoped">这份清单是<strong>全库</strong>口径'
        + "（没给书路径，未按当前书过滤），不代表都属于这本书。</div>");
    }
    for (const ev of list) {
      const r = evidenceLabel(ev, ev.now ?? nowIso);
      const conf = isMap(ev.confidence) ? ev.confidence.level : ev.confidence;
      const id = str(ev.note_id);
      const idKey = id ?? "unknown";
      out.push('<div class="gdev" data-note-id="' + esc(idKey) + '">');
      out.push('<span class="gdtag">' + esc(r.label) + "</span>");
      // 3d：过期 / 失效必须看得见，且**不再当成有效依据**。判定来自 evidenceLabel 的 stale。
      if (r.stale === "expired") {
        out.push('<span class="gdstale" id="gd-ev-expired-' + esc(idKey)
          + '">过期：这条依据的有效期已过，不再当成有效依据（待复核）。</span>');
      } else if (r.stale === "not_active") {
        out.push('<span class="gdstale" id="gd-ev-stale-' + esc(idKey)
          + '">依据已失效：' + esc(r.reason) + "；不再当成有效依据。</span>");
      }
      out.push('<span class="gdsmall">' + esc(r.reason) + "</span>");
      out.push('<span class="gdsmall" id="gd-ev-conf-' + esc(idKey) + '">当前确认状态：'
        + esc(fmtUnknown(ev.confirmation)) + "</span>");
      if (id !== null) {
        // 「我确认这条观察」：真打后端（见 CONFIRM-FLOW）。这里只带 note_id，不预判结果。
        out.push('<button type="button" class="gdconfirmbtn" data-confirm="' + esc(id)
          + '">我确认这条观察</button>');
      } else {
        out.push('<span class="gdsmall gdbad">这条没有 note_id ⇒ 不能确认（不猜 id）。</span>');
      }
      out.push(renderTech('<div class="gdsmall">kind=' + esc(fmtUnknown(ev.kind))
        + " · dimension=" + esc(fmtUnknown(ev.dimension))
        + " · strength=" + esc(fmtUnknown(ev.strength))
        + " · confidence=" + esc(fmtUnknown(conf))
        + " · note_id=" + esc(fmtUnknown(ev.note_id))
        + " · knowledge_status=" + esc(fmtUnknown(ev.knowledge_status))
        + " · valid_until=" + esc(fmtUnknown(ev.valid_until)) + "</div>", "技术细节：这条证据的字段"));
      out.push("</div>");
    }
  }
  out.push("</section>");
  return out.join("");
}

/** 两层去重并集区：标 book / personalized / both，**不是第三层权威结果**。 */
function renderSelectedSection(result) {
  const out = ['<section class="gdsec" id="gd-sel">'];
  out.push('<div class="gdhd">两层合并去重后的清单</div>');
  out.push('<div class="gdrow gdsmall" id="gd-sel-note">这是第一层与第二层推荐项合并去重后的清单，每项标明它来自哪一层；'
    + "它不是第三层权威结果，也不另立权威区。</div>");

  const sel = buildSelectedItems(result);
  if (sel.length === 0) {
    out.push('<div class="gdempty" id="gd-sel-empty">去重并集为空（两层都没有可用项）。</div>');
  }
  for (const s of sel) {
    const bookSplit = splitEngineReason(s.book_reason);
    out.push('<div class="gdsel" data-cid="' + esc(s.candidate_id) + '" data-layer="' + esc(s.layer) + '">');
    out.push('<div class="gdit-h"><span class="gdbadge l">' + esc(s.layer) + "</span></div>");
    if (s.book_reason) out.push('<div class="gdsmall gdreason-book">书内理由：' + esc(bookSplit.human) + "</div>");
    if (s.personal_reasons.length) {
      out.push('<div class="gdsmall gdreason-personal">个人理由：' + esc(s.personal_reasons.join("；")) + "</div>");
    }
    const selTech = [];
    if (bookSplit.marks) {
      selTech.push('<div class="gdrow gdsmall" id="gd-sel-item-reason-raw">书内理由原文：'
        + esc(fmtUnknown(s.book_reason)) + "</div>");
    }
    selTech.push('<div class="gdrow gdsmall" id="gd-sel-item-cid">candidate_id：'
      + esc(s.candidate_id) + "</div>");
    out.push(renderTech(selTech.join(""), "技术细节：这一条的标识"));
    out.push("</div>");
  }
  out.push("</section>");
  return out.join("");
}

/* ---------- M9 通电：「切片与理解」的诚实渲染（纯函数） ---------- */

/**
 * 状态机：三种**分析结果**态 + 一种**失败**态。
 *
 * 「分析中 / 完成 / 部分完成」是结果态；`未完成（失败）` 单列，因为请求失败或
 * 根本没落盘时**既不是完成也不是部分完成**（后者意味着「真产出了一部分」）。
 * 把失败塞进「部分完成」才是粉饰。
 */
const ANALYZE_STATES = Object.freeze({
  running: "分析中",
  done: "完成",
  partial: "部分完成",
  error: "未完成（失败）",
});

function analyzeStateLabel(phase) {
  return Object.prototype.hasOwnProperty.call(ANALYZE_STATES, phase) ? ANALYZE_STATES[phase] : ANALYZE_STATES.error;
}

/**
 * 由后端 `honest_report` 推状态 —— **不**由点击事件推。
 * 保守：字段缺失/非法一律**不**宣称「完成」。
 */
function analyzePhase(report) {
  if (!isMap(report)) return "error";
  if (report.persisted !== true) return "error";                 // 没落盘 ⇒ 没有可报告的运行
  const failed = report.failed_windows;
  if (!isMap(failed) || !Number.isInteger(failed.count)) return "partial";  // 失败数未知 ⇒ 不宣称完成
  if (failed.count > 0) return "partial";
  if (report.complete_for_parsed_body !== true) return "partial";           // 切片完成 ≠ 分析完成
  return "done";
}

/** 为什么是这个状态（必须能解释，不能只给一个词）。 */
function analyzeStateWhy(phase, s) {
  const rep = isMap(s) && isMap(s.report) ? s.report : null;
  if (phase === "running") return "分析中：请求已发出、结果还没回来 —— 没有结果之前不显示「完成」。";
  if (phase === "done") return "完成：没有失败窗口，且 complete_for_parsed_body=true（只针对已解析正文）。";
  if (phase === "partial") {
    const f = rep && isMap(rep.failed_windows) ? rep.failed_windows : null;
    const n = f && Number.isInteger(f.count) ? f.count : null;
    if (n !== null && n > 0) return "部分完成：有 " + n + " 个窗口失败（已留在队列）⇒ 只报告部分成果，不显示「完成」。";
    return "部分完成：complete_for_parsed_body 不是 true（切片完成 ≠ 分析完成）⇒ 不显示「完成」。";
  }
  const code = isMap(s) && isMap(s.error) ? fmtUnknown(s.error.code) : "unknown";
  return "未完成（失败）：" + code + " —— 没有产出可报告的运行结果，不显示「完成」，也不显示「部分完成」。";
}

/**
 * 手改保护被触发时的**显眼**说明（M11 收尾）。
 *
 * 后端拒绝覆盖时会返回 `code: "HASH_CONFLICT"` + 一句人话解释。这句话原本只在结果块
 * **最底下**以通用失败行的形式出现，埋在六项内容后面像脚注 —— 而它恰恰是用户此刻
 * 最需要看到的一条。这里把它提到状态行正下方，并且**说清三件事**：
 *   ① 为什么停手（是内容对不上，还是查不到记录 —— 两者不一样，不合并）；
 *   ② 盘上那份**一动没动**（这是用户最怕的：我的修改是不是被盖了）；
 *   ③ 接下来怎么办，以及**本版没有「强制覆盖」开关**（不假装有）。
 *
 * 不是 `HASH_CONFLICT` 就返回空串（不渲染、不占位）。
 */
function renderAnalyzeConflict(st) {
  const s = isMap(st) ? st : null;
  const err = s && isMap(s.error) ? s.error : null;
  if (err === null || err.code !== "HASH_CONFLICT") return "";
  const rep = isMap(s.report) ? s.report : null;
  const chk = rep ? rep.manual_edit_check : null;
  const prev = rep ? rep.previous_revision : null;
  const show = (v) => (v === null || v === undefined ? "unknown" : String(v));
  const why = chk === "mismatch"
    ? "盘上的内容与系统上次写进去的<strong>不一致</strong> —— 有人（多半是你）改过这条笔记。"
    : chk === "no_record"
      ? "查不到这条笔记是谁写的（事务记录已不可考，比如 <code>.state/journal/</code> 被清过）。"
      : "后端没有给出具体原因（manual_edit_check=" + esc(fmtUnknown(chk)) + "），不猜。";
  return '<div class="arline arbad" id="ar-conflict">'
    + "<strong>这条笔记你改过，我没有覆盖它。</strong>"
    + "<br>· 为什么停手：" + why
    + "<br>· 盘上那份<strong>一动没动</strong>：你的内容还在（revision 仍是 " + esc(show(prev))
    + "），本次没有写入任何东西。"
    + "<br>· 怎么办：把你要的改动并进系统那份（或先还原成系统写的那份），再点一次「切片与理解」；"
    + "<strong>本版没有「强制覆盖」开关</strong> —— 宁可停下问你，也不悄悄盖掉你的手改。</div>";
}

/**
 * ④ 失败窗口数 + 原因。**必须可见**：数量 + 逐窗原因；拿不到原因也如实说，
 * 绝不显示成 0（用户点名的反例是「隐藏失败窗口（显示 0 个）」）。
 */
function renderAnalyzeFailures(report) {
  const f = isMap(report) && isMap(report.failed_windows) ? report.failed_windows : null;
  const count = f && Number.isInteger(f.count) ? f.count : null;
  if (count === null) {
    return '<div class="arline" id="ar-failed">失败窗口：unknown（后端没给失败窗口数）—— 不当作 0。</div>';
  }
  if (count === 0) {
    return '<div class="arline" id="ar-failed">失败窗口：0 个（本次没有窗口失败）。</div>';
  }
  const reasons = Array.isArray(f.reasons) ? f.reasons.filter(isMap) : [];
  const out = ['<div class="arline arb" id="ar-failed">失败窗口：' + esc(String(count))
    + " 个（留在队列，不静默丢弃；重试需显式调度："
    + (f.retry_requires_explicit_schedule === true ? "是" : "unknown") + "）</div>"];
  out.push('<ul class="arfail" id="ar-failed-list">');
  for (const r of reasons) {
    out.push("<li>" + esc(fmtUnknown(r.window_id)) + " @ " + esc(fmtUnknown(r.section_id))
      + "：<code>" + esc(fmtUnknown(r.failure_reason)) + "</code></li>");
  }
  if (reasons.length !== count) {
    out.push("<li>unknown：后端只给了 " + esc(String(reasons.length)) + " 条原因，少于失败窗口数 "
      + esc(String(count)) + "（不补齐、不编造）。</li>");
  }
  out.push("</ul>");
  return out.join("");
}

/**
 * ③ 覆盖：分母是 **span 区间的并集**（重叠不重复计）。
 * 未知部分永远存在（图片页 / 不可解析项未计数）⇒ **不宣称全书覆盖率**，
 * 也不输出任何百分比（任何「100%」都可能被读成「全书读完」）。
 */
function renderAnalyzeCoverage(report) {
  const c = isMap(report) && isMap(report.coverage) ? report.coverage : null;
  if (c === null) return '<div class="arline" id="ar-coverage">覆盖：unknown（后端没给覆盖账本）。</div>';
  const un = isMap(c.unknown) ? c.unknown : null;
  const viol = Array.isArray(c.windows_contiguity_violations) ? c.windows_contiguity_violations.length : null;
  const out = ['<div class="arline" id="ar-coverage">覆盖（分母口径：' + esc(fmtUnknown(c.denominator_kind))
    + " —— span 区间并集，重叠不重复计）："];
  out.push("<br>· 已解析正文窗口：已消费 " + esc(fmtUnknown(c.analyzed_units)) + " / 分母 "
    + esc(fmtUnknown(c.total_units)) + "（失败 " + esc(fmtUnknown(c.failed_units))
    + " · 排除 " + esc(fmtUnknown(c.excluded_units)) + "）");
  out.push("<br>· 窗口区间自校验：" + (c.windows_non_overlapping === true
    ? "通过（首尾相接、无重叠、无洞）"
    : "未通过（" + esc(viol === null ? "unknown" : String(viol)) + " 处不连续）—— 分母可能被灌水，如实报出"));
  out.push("<br>· 字符：已覆盖 " + esc(fmtUnknown(c.covered_codepoints)) + " / 已解析 "
    + esc(fmtUnknown(c.total_codepoints)));
  out.push("<br>· 未知部分：" + (un
    ? esc(Array.isArray(un.kinds) ? un.kinds.join(" / ") : "unknown")
      + "（数量可知：" + (un.counts_known === true ? "是" : "否")
      + " · 占比可知：" + (un.ratio_known === true ? "是" : "否") + "）"
    : "unknown"));
  out.push("<br>· 全书覆盖率：不宣称（whole_book_claim_allowed="
    + (c.whole_book_claim_allowed === true ? "true" : "false")
    + " · whole_book_percent=" + (c.whole_book_percent === null || c.whole_book_percent === undefined ? "null" : esc(String(c.whole_book_percent)))
    + "）—— 分母只是已解析正文，不是全书");
  out.push("</div>");
  return out.join("");
}

/**
 * 重算语义（M10 阶段 2「一本书一个理解」）：必须明说「重算」，
 * 并说清**覆盖的是同一条笔记**、`run_id` 不变、`revision` 递增 —— 不能让用户以为是「新增了一次」。
 */
function renderAnalyzeRecompute(report) {
  if (report.is_recompute === true) {
    const prev = report.previous_revision;
    const rev = report.revision;
    const fp = report.input_fingerprint_changed;
    const show = (v) => (v === null || v === undefined ? "unknown" : String(v));
    // 没落盘 ⇒ **什么都没覆盖**。此时还说「本次覆盖了它」就是撒谎（实测：手改被挡时
    // 后端返回 persisted=false + is_recompute=true，盘上那份其实一动没动）。
    if (report.persisted !== true) {
      return '<div class="arline arbad" id="ar-recompute">这本应是<strong>重算</strong>（同一本书只有'
        + "<strong>一条</strong>理解笔记，重算会覆盖它），但<strong>本次没有落盘</strong> ⇒ "
        + "<strong>没有覆盖任何东西</strong>。盘上那条笔记还是原来的样子：revision 仍是 "
        + esc(show(prev)) + "（本次想写的是 " + esc(show(rev)) + "，没写成）。</div>";
    }
    return '<div class="arline arb" id="ar-recompute">这是<strong>重算</strong>：同一本书只有<strong>一条</strong>理解笔记，'
      + "本次<strong>覆盖</strong>了它，revision 从 " + esc(show(prev)) + " 递增到 " + esc(show(rev))
      + "（<code>run_id</code> 不变）。不是「新增了一次」。"
      + (fp === true
        ? "<br>本次的输入与上一版<strong>不同</strong>（input_fingerprint 已变）：这份理解是按新输入重算的。"
        : fp === false ? "" : "<br>后端没有给出「输入是否变化」，不猜。")
      + "</div>";
  }
  return '<div class="arline" id="ar-recompute">这是首次整理：这本书此前没有理解笔记（is_recompute=false）。</div>';
}

/**
 * ⑦ 派生产物的真实结果（M11 阶段 4）。
 *
 * 后端把「书籍信息笔记」与「覆盖账本」的成败放在 `vault_integrity` 里
 * （`lib/reading/runtime.js` 的 `writeVaultIntegrity`）。这两样是**派生**产物：
 * 它们失败**不回滚**主产物（run 笔记已经落盘）—— 所以**必须看得见**，
 * 否则用户会以为"整件事都成了"。
 *
 * 三条纪律：
 *   · 两类产物**分开显示**，不许合并成一句"派生结果正常"；
 *   · 后端没给 `vault_integrity` ⇒ 说 **unknown**，**不当作成功**（缺字段 ≠ 成功）；
 *   · 失败（written=false 且不是 NO_CHANGE）用 `arbad` 高亮 + 原样带出 code 与原因，
 *     不许静默、不许降级成"部分成功"。
 *
 * `NO_CHANGE` 是**正常**结果（同一本书同一版本不重写），不是失败，但也要**如实说明**。
 */
function renderVaultIntegrity(vi, persisted) {
  if (!isMap(vi)) {
    // 主产物都没落盘 ⇒ 根本没走到写盘那一步，**没有**派生产物可报。
    // 这和"后端漏给了字段"是两回事，不能混成一句 unknown。
    if (persisted !== true) {
      return '<div class="arline" id="ar-vault">派生产物：本次没有落盘（persisted=false）'
        + " ⇒ 没走到写盘这一步，所以没有派生产物可报（既不是成功，也不是失败）。</div>";
    }
    return '<div class="arline arbad" id="ar-vault">派生产物：unknown（后端没有返回 vault_integrity）'
      + " —— 无法确认书籍信息笔记与覆盖账本是否写入，**不当作成功**。</div>";
  }
  const one = (key, label, id) => {
    const it = isMap(vi[key]) ? vi[key] : null;
    if (it === null) {
      return '<div class="arline arbad" id="' + id + '">' + esc(label)
        + "：unknown（后端没给这一项）—— 不当作成功。</div>";
    }
    const code = str(it.code);
    if (it.written === true) {
      const where = str(it.note_rel) ?? str(it.ref) ?? null;
      return '<div class="arline" id="' + id + '">' + esc(label) + "：<strong>已写入</strong>"
        + (where !== null ? "（<code>" + esc(where) + "</code>）" : "")
        + (str(it.message) ? "<br>" + esc(it.message) : "") + "</div>";
    }
    if (code === "NO_CHANGE") {
      return '<div class="arline" id="' + id + '">' + esc(label)
        + "：<strong>未改写（NO_CHANGE）</strong>"
        + (str(it.message) ? " —— " + esc(it.message) : "") + "</div>";
    }
    return '<div class="arline arbad" id="' + id + '">' + esc(label) + "：<strong>失败</strong>"
      + "（<code>" + esc(code ?? "unknown") + "</code>）"
      + (str(it.message) ? "<br>" + esc(it.message) : "<br>后端没给失败原因。")
      + "<br>主产物（run 笔记）不受影响，但这一项确实没成 —— 如实报出，不吞掉。</div>";
  };
  const book = isMap(vi.book_note) ? vi.book_note : null;
  const led = isMap(vi.coverage_ledger) ? vi.coverage_ledger : null;
  const anyFailed = (book !== null && book.written !== true && str(book.code) !== "NO_CHANGE")
    || (led !== null && led.written !== true && str(led.code) !== "NO_CHANGE");
  return '<div class="arline' + (anyFailed ? " arb" : "") + '" id="ar-vault">派生产物结果'
    + (anyFailed ? "（<strong>有失败项，见下</strong>）" : "") + "：</div>"
    + one("book_note", "书籍信息笔记", "ar-vault-book")
    + one("coverage_ledger", "覆盖账本", "ar-vault-ledger");
}

/**
 * 「切片与理解」的结果块（M9 六项 + 重算语义）。
 *
 * `st` 的形状 = `{book_id, title, phase, report, error, note_rel, requested_url}`；
 * `report` 就是后端 `honest_report`（`lib/reading/runtime.js` 的 `buildHonestReport`）。
 * 没有 `report` 时**不编**：直接说后端没给。
 */
function renderAnalyzeReport(st) {
  const s = isMap(st) ? st : null;
  if (s === null) return "";
  const phase = str(s.phase) ?? "error";
  const label = analyzeStateLabel(phase);
  const out = ['<section class="anreport" id="analyze-result" data-phase="' + esc(phase)
    + '" data-state="' + esc(label) + '">'];
  out.push('<div class="arhead" id="ar-title">整理《' + esc(str(s.title) ?? "unknown") + '》 · '
    + '<span class="arstate" id="ar-state" data-state="' + esc(label) + '">' + esc(label) + "</span></div>");
  out.push('<div class="arwhy" id="ar-state-why">' + esc(analyzeStateWhy(phase, s)) + "</div>");

  // 手改被挡：把它顶到最显眼的位置（原本埋在结果块最底下的通用失败行里）
  const conflict = renderAnalyzeConflict(s);
  if (conflict !== "") out.push(conflict);

  if (phase === "running") {
    out.push('<div class="arline" id="ar-running">已发起真实请求：POST <code>'
      + esc(str(s.requested_url) ?? "unknown") + "</code>（不是前端假动作）。"
      + "逐章分析在本地跑（通常几秒）；完成后这里会如实给出六项。</div>");
    out.push("</section>");
    return out.join("");
  }

  const rep = isMap(s.report) ? s.report : null;
  if (rep === null) {
    out.push('<div class="arline arbad" id="ar-error">后端没有返回 honest_report：'
      + esc(fmtUnknown(s.error && s.error.code)) + " —— " + esc(fmtUnknown(s.error && s.error.message))
      + "。没有结果就不显示「完成」。</div>");
    out.push("</section>");
    return out.join("");
  }

  // ① 切片数
  const slices = isMap(rep.slices) ? rep.slices : {};
  out.push('<div class="arline" id="ar-slices">切片：' + esc(fmtUnknown(slices.count)) + " 条"
    + (str(slices.note) ? "（" + esc(slices.note) + "）" : "") + "</div>");

  // ② 候选数
  const cand = isMap(rep.candidates) ? rep.candidates : {};
  const skipped = Array.isArray(cand.skipped) ? cand.skipped : [];
  out.push('<div class="arline" id="ar-candidates">候选：' + esc(fmtUnknown(cand.built)) + " 条可用于推荐"
    + "（引擎产出 " + esc(fmtUnknown(cand.engine_candidates)) + " 个候选；未采用 "
    + esc(String(skipped.length)) + " 个）"
    + (skipped.length ? "<br>未采用原因：" + esc(skipped.map((x) => fmtUnknown(x && x.reason)).join("、")) : "")
    + "</div>");

  // ③ 覆盖（分母＝区间并集，不宣称全书）
  out.push(renderAnalyzeCoverage(rep));

  // ④ 失败窗口数 + 原因（不静默）
  out.push(renderAnalyzeFailures(rep));

  // ⑤ complete_for_parsed_body（切片完成 ≠ 分析完成）
  out.push('<div class="arline" id="ar-complete">complete_for_parsed_body：'
    + (rep.complete_for_parsed_body === true ? "true" : rep.complete_for_parsed_body === false ? "false" : "unknown")
    + "（只指「已解析正文」这一层是否全部分析完；切片完成 ≠ 分析完成 ≠ 阅读完成）</div>");

  // ⑥ 本次 run_id（若落了盘）
  const rid = str(rep.run_id);
  if (rep.persisted === true && rid !== null) {
    out.push('<div class="arline" id="ar-run">本次 run_id：<code>' + esc(rid) + "</code>（已落盘："
      + esc(str(s.note_rel) ?? "45-书籍/推荐反馈/" + rid + ".md") + "）</div>");
  } else {
    out.push('<div class="arline arbad" id="ar-run">本次没有写入知识库（persisted='
      + (rep.persisted === true ? "true" : "false") + "）"
      + (rid !== null ? "；后端给过 run_id=" + esc(rid) + "，但**未落盘**，不当成已保存" : "；没有 run_id") + "</div>");
  }

  // 重算 vs 新增（不得混）
  out.push(renderAnalyzeRecompute(rep));

  // ⑦ 派生产物（书籍信息笔记 / 覆盖账本）的真实成败 —— 失败必须看得见
  out.push(renderVaultIntegrity(s.vault_integrity, rep.persisted === true));

  if (isMap(s.error)) {
    out.push('<div class="arline arbad" id="ar-error">失败：' + esc(fmtUnknown(s.error.code)) + " —— "
      + esc(fmtUnknown(s.error.message)) + "</div>");
  }

  out.push('<div class="arnote" id="ar-understood">理解程度：不可宣称（本报告只说明窗口被消费过；'
    + "不由处理进度推出「理解完成」，不宣称全书覆盖率，也不把已解析正文的比例当成全书比例）。</div>");
  out.push("</section>");
  return out.join("");
}

/* ---------- M12：推荐 → 原文（第 3 环的前半段） ---------- */

/**
 * span_id 的形状（与引擎 `books_rag.py` 的 `read_source_span` 正则**逐字符一致**）：
 *   `sp_<内容摘要：16 位小写 hex>_<章序>_<起>_<止>`
 *
 * M13：中段从「路径指纹 8 位」换成「**内容摘要 16 位**」（书挪位置/改名 ⇒ 这一段不变，
 * 同一个 span_id 仍然取得到原文）。形状必须与引擎一致，否则按钮会指向取不到的 ref。
 *
 * 只有这个形状的 ref 才是**书内原文引用**、才可能取到原文。为什么必须判形状：
 * 推荐条目的 `source_refs` 里混着**非书内原文**的引用（`personalized_items` 会混入
 * `pe_*` 之类的个人证据引用，见 `policy.js`）。对它们显示「看原文」按钮 = 假装能取到原文。
 */
const SPAN_ID_RE = /^sp_[0-9a-f]{16}_\d+_\d+_\d+$/;
function isSpanRef(x) {
  return typeof x === "string" && SPAN_ID_RE.test(x);
}

/**
 * 把一条推荐**自己的** `source_refs` 渲染成「看原文」按钮。
 *
 * 铁律（M12 要求 1a）：只用这条推荐自己的 source_refs —— 不重新检索、不拿标注顶替。
 * 非 span 形状的 ref 单独列出并如实说明「不是书内原文，取不到原文」，不假装。
 */
function renderSourceRefs(refs, from) {
  const label = str(from) || "unknown";
  const list = Array.isArray(refs) ? refs.filter((x) => x !== null && x !== undefined && x !== "") : [];
  if (list.length === 0) {
    return '<div class="gdsmall gdsrc-none">这条推荐没有 source_refs ⇒ 取不到原文依据（不拿别的内容顶替）。</div>';
  }
  const spans = list.filter(isSpanRef);
  const others = list.filter((x) => !isSpanRef(x));
  const out = ['<div class="gdsrc" data-from="' + esc(label) + '">'];
  out.push('<div class="gdsmall gdsrc-hd">这条推荐自己引用的原文（source_refs，' + list.length + " 条）：</div>");
  if (spans.length === 0) {
    out.push('<div class="gdbad gdsrc-nospan">source_refs 里没有书内原文引用'
      + "（只有非书内引用）⇒ 取不到原文，不拿别的内容顶替。</div>");
  }
  // 主视图只留按钮：原始 span_id 一律进「技术细节」（阶段 1a）。
  const tech = [];
  for (const s of spans) {
    out.push('<span class="gdsrcwrap"><button type="button" class="gdsrcbtn" data-span="' + esc(s)
      + '" data-from="' + esc(label) + '">看原文</button></span>');
    tech.push('<div class="gdsmall gdsrcid">' + esc(s) + "</div>");
  }
  if (others.length) {
    out.push('<div class="gdsmall gdsrc-other">另有 ' + others.length
      + " 条非书内原文的引用（取不到原文，也不拿它顶替）。</div>");
    tech.push('<div class="gdsmall" id="gdsrc-other-raw">非书内引用：' + esc(others.join("、")) + "</div>");
  }
  if (spans.length === 0) {
    tech.push('<div class="gdsmall" id="gdsrc-shape">书内原文引用的形状须为 '
      + esc("sp_<内容摘要>_<章序>_<起>_<止>") + "</div>");
  }
  if (tech.length) out.push(renderTech(tech.join(""), "技术细节：原文引用的标识"));
  out.push("</div>");
  return out.join("");
}

/**
 * 一段原文的**可核对定位**（人话版）：第 N 章 + section_id + Unicode codepoint 半开区间。
 * 缺字段显示 unknown，**不猜**（不把「没有章序」写成「第 1 章」）。
 */
function sourceLocatorText(d) {
  const chap = Number.isInteger(d.section_order) ? "第 " + (d.section_order + 1) + " 章" : "章序 unknown";
  const sec = str(d.section_id) || "section_id unknown";
  const a = Number.isInteger(d.start_codepoint) ? String(d.start_codepoint) : "unknown";
  const b = Number.isInteger(d.end_codepoint) ? String(d.end_codepoint) : "unknown";
  return chap + "（" + sec + "）· 字符区间 [" + a + ", " + b + ")";
}

/**
 * 人话定位：只留「第 N 章 · 字符区间」，去掉括号里的内部标识。
 *
 * 为什么不另写一套判断：直接复用 `sourceLocatorText`（**同一份实现**），
 * 只把括号里的 `section_id` 去掉 —— 免得两套定位逻辑以后漂移。
 * 缺字段时仍然如实显示 unknown（不猜成「第 1 章」）。
 */
function sourceLocatorHuman(d) {
  return sourceLocatorText(d).replace(/（[^）]*）/, "");
}

/**
 * 「原文依据」区（M12 第 3 环）：显示**已经取到**的那段原文 + 可核对定位 + 送进 DSH 讨论的入口。
 *
 * 诚实要点（逐条对应本轮要求）：
 *   · 原文逐字显示，来源 = 上面那条推荐自己的 source_refs（1a）；不重新检索、不拿标注顶替；
 *   · 定位给「书名 + 章序 + section_id + codepoint 区间 + 引文 hash + 书版本」，并明说这是
 *     **章节 + 字符区间**而不是页码（PRD §7.1：重排版页码不作稳定坐标）；
 *   · 取不到就**如实说找不到**并带出后端真实 code/message，**不拿别的内容顶替**（1b）；
 *   · 三种东西分开写：书中观点（原文）/ AI 推演（推荐理由，未确认）/ 用户判断（本轮没有）（1d）；
 *   · 不许出现「已读懂」、全书 100%、「切片完成 = 理解完成」（1e）；
 *   · **不保存任何东西**（1f：保存观察属第 4 环 = M13）。
 */
function renderSourceEvidence(source) {
  const out = ['<section class="gdsec" id="gd-source">'];
  out.push('<div class="gdhd">原文依据（第 3 环：推荐 → 原文 → DSH 讨论）</div>');

  if (!isMap(source)) {
    out.push('<div class="gdempty" id="gd-source-idle">点上面对应推荐条目里的「看原文」，'
      + "这里会显示那条推荐自己引用的原文（不重新检索、不拿标注顶替）。</div></section>");
    return out.join("");
  }

  out.push('<div class="gdrow gdsmall" id="gd-source-from-human">来源：你点的那条推荐自己引用的原文'
    + "（没有重新检索、没有拿标注顶替）。</div>");
  out.push(renderTech('<div class="gdrow gdsmall" id="gd-source-from">来源条目 '
    + esc(str(source.from) || "unknown") + " · span_id="
    + esc(fmtUnknown(source.span_id)) + "</div>", "技术细节：这次取的是哪一条引用"));

  if (source.phase === "loading") {
    out.push('<div class="gdrow gdsmall" id="gd-source-loading">正在按这条推荐的 source_refs 取原文…（'
      + esc(fmtUnknown(source.requested_url)) + "）</div></section>");
    return out.join("");
  }

  if (source.phase !== "done" || !isMap(source.data)) {
    const e = isMap(source.error) ? source.error : {};
    out.push('<div class="gdbad" id="gd-source-missing">找不到原文（不拿别的内容顶替）：code='
      + esc(fmtUnknown(e.code)) + " · " + esc(fmtUnknown(e.message)) + "</div>");
    out.push('<div class="gdrow gdsmall" id="gd-source-missing-note">这条推荐的 source_refs 取不到原文，'
      + "面板不显示任何替代内容，也不假装它存在。</div></section>");
    return out.join("");
  }

  const d = source.data;
  const quote = typeof d.quote === "string" ? d.quote : "";
  out.push('<div class="gdsub">书中观点（原文，逐字）</div>');
  out.push('<div class="gdquote" id="gd-source-quote">' + esc(quote) + "</div>");
  out.push('<div class="gdrow gdsmall" id="gd-source-locator-human">定位：书《' + esc(fmtUnknown(d.book))
    + "》· " + esc(sourceLocatorHuman(d)) + " —— 不是页码，可据此回原文核对。</div>");
  // 这个元素保持原样（m12 真机验收按 #gd-source-locator 的 textContent 核对定位），
  // 只是收进折叠区：`textContent` 对折叠区里的元素照样读得到。
  out.push(renderTech('<div class="gdrow gdsmall" id="gd-source-locator">定位：书《' + esc(fmtUnknown(d.book))
    + "》· " + esc(sourceLocatorText(d))
    + " · 引文 hash=" + esc(fmtUnknown(d.text_hash))
    + " · 书版本=" + esc(fmtUnknown(d.book_version_id))
    + " · 引擎核验=" + (d.verified === true ? "true" : "false（引擎没标 verified）") + "</div>",
    "技术细节：这段原文的核对标识"));
  out.push('<div class="gdrow gdsmall" id="gd-source-locator-note">定位是章节 + 字符区间'
    + "（Unicode codepoint，半开区间），不是页码 —— 重排版页码随字号/屏幕变化，不作稳定坐标。"
    + "可据此回原文核对。</div>");

  out.push('<div class="gdsub">三种东西分开看（不许混）</div>');
  out.push('<div class="gdsmall" id="gd-attrib-book">① 书中观点：上面那段逐字原文（逐字引用）。</div>');
  out.push('<div class="gdsmall" id="gd-attrib-ai">② AI 推演：推荐理由、书本价值分、个人理由'
    + "都是模型推演，默认<strong>未确认</strong> —— 既不是书里的话，也不是你的判断。"
    + renderTech('<div class="gdsmall">origin=ai_inference · confirmation=unconfirmed</div>',
      "技术细节：这条推演的字段") + "</div>");
  // M14 第 4 环起，面板**仍然不替你写**用户判断 —— 但给你一个「自己打字、自己确认」的入口。
  out.push('<div class="gdsmall" id="gd-attrib-user">③ 用户判断：面板不替你写 —— '
    + "下面那个框里的话，只有你自己打了字才会有。</div>");

  out.push('<div class="gdwarn" id="gd-source-honest">能取到这条推荐的原文依据，不等于已读懂这本书，'
    + "也不代表全书 100% 覆盖，更不等于分析完成（切片完成 ≠ 分析完成）。</div>");

  // —— M14 第 4 环：记下这条观察 ——
  // 诚实边界直接印在界面上：采集 ≠ 读懂；标签是派生的、不是分数；存下来默认「未确认」。
  const rec = isMap(source) && isMap(source.record) ? source.record : null;
  out.push('<div class="gdsub" id="gd-ev-title">记下这条观察（第 4 环：互动 → 证据 → 落盘）</div>');
  out.push('<div class="gdsmall" id="gd-ev-honest">采集到一条证据 <b>不等于</b>读懂这本书；'
    + "存下来默认是「未确认」；五类标签是从字段**派生**的展示值，不是 1–5 分。</div>");
  out.push('<div class="gdrow" id="gd-ev-kinds">' + EVIDENCE_KIND_OPTIONS.map((o) =>
    '<label class="gdevopt"><input type="radio" name="gdevkind" value="' + esc(o.kind) + '"'
    + (o.dimension ? ' data-dim="' + esc(o.dimension) + '"' : "")
    + "> " + esc(o.label) + "</label>").join("") + "</div>");
  out.push('<textarea id="gd-ev-statement" class="gdevtext" rows="3" '
    + 'placeholder="用你自己的话说：你现在怎么看这段？（面板不替你写）"></textarea>');
  out.push('<div class="gdrow">'
    + '<input id="gd-ev-concept" class="gdevinput" placeholder="概念（必填）" value="">'
    + '<input id="gd-ev-topic" class="gdevinput" placeholder="主题（人类可读标题，可留空）" value="">'
    + "</div>");
  out.push('<div class="gdrow" id="gd-ev-actions">'
    + '<button type="button" class="gdaskbtn" data-recevidence="1">记下这条观察</button>'
    + '<span class="gdsmall" id="gd-ev-preview">还没选「这次是什么」</span>'
    + "</div>");
  out.push('<div class="gdsmall" id="gd-ev-result">'
    + (rec === null ? "还没存过。" : esc(rec.message)) + "</div>");

  const canSend = quote.trim() !== "";
  out.push('<div class="gdrow" id="gd-source-actions">'
    + (canSend
      ? '<button type="button" class="gdaskbtn" data-askspan="1">送进 DSH 讨论</button>'
      : '<span class="gdbad" id="gd-source-empty">取到的原文是空的 ⇒ 不送进讨论（不拿别的内容顶替）。</span>')
    + "</div>");
  out.push('<div class="gdsmall" id="gd-source-asknote">点「送进 DSH 讨论」会把上面这段原文'
    + "（连同它的定位与归属标注）交给右侧原生会话；本轮只做「看原文 + 送讨论」，不保存任何观察。</div>");
  out.push("</section>");
  return out.join("");
}

/**
 * 导读区总渲染。
 * `payload` = `{coverage, recommendations, library, result, evidence, error}`：
 *   coverage/recommendations/library 是 M6 只读路由的响应；
 *   `result` = `pickReadingResult(recommendations)`（M8 起路由真会给两层内容；
 *   取不到就传 null，界面走诚实空态，绝不自己编一份）；
 *   `evidence` 是 `GET /reading/evidence` 的只读响应（或旧的证据数组），
 *   `confirm` 是最近一次「我确认这条观察」的回执（M15 阶段 3）。
 * `source` = M12 的原文依据状态（`state.source`）；不给 ⇒ 显示「还没点过看原文」的空态。
 */
function renderGuideHtml(p, source) {
  const d = isMap(p) ? p : {};
  const out = ['<div class="gd">'];
  if (str(d.error)) out.push('<div class="gdbad">读取阅读数据失败：' + esc(d.error) + "</div>");
  // 阶段 2 第一屏顺序：这本书是什么 → 已分析到哪 → 有哪些值得读的章节。
  out.push(renderBookSection(d.book));
  out.push(renderRunIdentitySection(d.recommendations));
  out.push(renderCoverageSection(d.coverage, d.library));
  out.push(renderBookGuideSection(d.result, d.book));
  out.push(renderPersonalizedSection(d.result, d.evidence));
  out.push(renderSourceEvidence(source));
  out.push(renderEvidenceSection(d.evidence, d.confirm));
  out.push(renderSelectedSection(d.result));
  out.push("</div>");
  return out.join("");
}
/* ==== READING-VIEW END ==== */

/* ==== ANALYZE-FLOW BEGIN ==== */
/*
 * M9「切片与理解」的**真实**触发流程。
 *
 * 只依赖 `fetch` / `state` / `API` / `renderBooks` / `loadReading`（测试会用替身驱动它），
 * 所以这里**不碰 DOM** —— 渲染一律走 `renderBooks()` → `renderAnalyzeReport()`。
 *
 * 三条不许含糊：
 *   · **真打后端**：必须 `await fetch(API + "/reading/analyze-and-persist", {method:"POST"})`；
 *     没有响应就**不许**显示「完成」（「前端假成功」是用户点名的反例）；
 *   · **防重复提交**：同一本书在「分析中」时再点，直接忽略，不再发第二个请求
 *     （真正的幂等由 M1 `file-service` 的 `idempotencyKey` 保证，这里只是不制造并发）；
 *   · **状态只由后端响应推**：`analyzePhase(response.honest_report)`，不由点击事件推。
 */
async function runAnalyze(bookId) {
  const books = Array.isArray(state.books) ? state.books : [];
  const b = books.find((x) => x && x.id === bookId);
  if (!b) return { ok: false, code: "BOOK_NOT_FOUND", message: "书库里找不到这本书：" + bookId };
  if (isMap(state.analyze) && state.analyze.phase === "running") {
    return { ok: false, code: "ALREADY_RUNNING", message: "上一次整理还在进行中，忽略这次点击（防重复提交）" };
  }

  const url = API + "/reading/analyze-and-persist";
  state.analyze = {
    book_id: b.id, title: b.title, phase: "running", report: null, error: null,
    note_rel: null, http_status: null, response_ok: null, requested_url: url,
    vault_integrity: null,
  };
  renderBooks();

  let j = null;
  let status = null;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ book: b.title }),
    });
    status = r.status;
    const text = await r.text();
    try { j = JSON.parse(text); } catch { j = null; }
  } catch (e) {
    state.analyze = { ...state.analyze, phase: "error", http_status: status, response_ok: false,
      error: { code: "NETWORK_ERROR", message: String(e && e.message ? e.message : e) } };
    renderBooks();
    return { ok: false, phase: "error", code: "NETWORK_ERROR" };
  }

  const report = j !== null && typeof j === "object" && isMap(j.honest_report) ? j.honest_report : null;
  if (j === null) {
    state.analyze = { ...state.analyze, phase: "error", http_status: status, response_ok: false, report: null,
      error: { code: "BAD_RESPONSE", message: "响应不是 JSON（HTTP " + status + "）" } };
  } else if (j.ok === true) {
    state.analyze = { ...state.analyze, phase: analyzePhase(report), report,
      vault_integrity: isMap(j.vault_integrity) ? j.vault_integrity : null,
      note_rel: typeof j.note_rel === "string" ? j.note_rel : null, http_status: status, response_ok: true, error: null };
  } else {
    state.analyze = { ...state.analyze, phase: "error", report,
      vault_integrity: isMap(j.vault_integrity) ? j.vault_integrity : null,
      note_rel: typeof j.note_rel === "string" ? j.note_rel : null, http_status: status, response_ok: false,
      error: { code: typeof j.code === "string" ? j.code : "ANALYZE_FAILED",
        message: typeof j.message === "string" ? j.message : "" } };
  }
  renderBooks();
  // 落盘成功才刷新「导读」Tab：否则会读到还没写的状态。
  if (state.analyze.response_ok === true) void loadReading();
  return { ok: state.analyze.response_ok === true, phase: state.analyze.phase,
    report: state.analyze.report, error: state.analyze.error };
}
/**
 * 3b：打开一本书时**自动**跑「切片与理解」——但只在**确实还没有当前理解**时才跑。
 *
 * 去重判据**来自后端**（`GET /reading/understanding-status?path=<引擎给的原串>`），
 * **不是前端猜的**：前端既不知道 `run_id` 怎么算，也不该知道 —— 那会造出第二套身份实现，
 * 两边一旦不一致就会静默错位。
 *
 * 三种情况一律**不自动跑**，并把后端给的原因原样显示（不粉饰、不吞掉）：
 *   · `checked !== true`（读不到知识库 / 读取出错）—— 猜成「没有」会导致重算覆盖已有理解；
 *   · `has_current_understanding === true` —— 已有理解；要重算得**手动**点按钮；
 *   · 同名笔记存在但不是 recommendation_run、或没通过正式校验 —— 需要人看一眼。
 * 只有 `auto_trigger_allowed === true`（盘上确实没有这条笔记）才自动跑第一次。
 *
 * 同一本书在一次会话里只判定一次（`state.auto[id]` 一旦有值就不再重复请求），
 * 来回切书不会反复触发。**手动点击完全不受这里影响**：点按钮永远是「明确要求重算」。
 */
async function autoUnderstanding(bookId) {
  const b = (Array.isArray(state.books) ? state.books : []).find((x) => x && x.id === bookId);
  if (!b) return { ok: false, code: "BOOK_NOT_FOUND" };
  if (isMap(state.auto[bookId])) return { ok: true, code: "ALREADY_CHECKED", ...state.auto[bookId] };

  // 引擎没给 path ⇒ 后端算不出身份 ⇒ **不猜**，如实说「无法确认」，也不自动跑。
  if (typeof b.path !== "string" || b.path.trim() === "") {
    state.auto[bookId] = { phase: "skipped", checked: false, auto_trigger_allowed: false,
      has_current_understanding: null, state: null, revision: null, run_id: null, note_rel: null,
      message: "引擎没给这本书的 path ⇒ 无法确认是否已有理解，没有自动运行（可手动点「切片与理解」）" };
    renderBooks();
    return { ok: false, code: "NO_PATH" };
  }

  state.auto[bookId] = { phase: "checking", checked: null, auto_trigger_allowed: false,
    has_current_understanding: null, state: null, revision: null, run_id: null, note_rel: null,
    message: "正在确认盘上是否已有这本书的理解…" };
  renderBooks();

  let j = null;
  try {
    const r = await fetch(API + "/reading/understanding-status?path=" + encodeURIComponent(b.path));
    const text = await r.text();
    try { j = JSON.parse(text); } catch { j = null; }
  } catch (e) {
    state.auto[bookId] = { phase: "skipped", checked: false, auto_trigger_allowed: false,
      has_current_understanding: null, state: null, revision: null, run_id: null, note_rel: null,
      message: "问后端「有没有已有理解」失败（网络/解析）：" + String(e && e.message ? e.message : e)
        + " ⇒ **不猜成「没有」**，没有自动运行" };
    renderBooks();
    return { ok: false, code: "NETWORK_ERROR" };
  }

  if (!isMap(j) || j.checked !== true) {
    state.auto[bookId] = { phase: "skipped", checked: false, auto_trigger_allowed: false,
      has_current_understanding: null, state: null, revision: null,
      run_id: typeof j?.run_id === "string" ? j.run_id : null,
      note_rel: typeof j?.note_rel === "string" ? j.note_rel : null,
      message: "后端没能确认（" + fmtUnknown(j?.code) + "）：" + fmtUnknown(j?.message)
        + " ⇒ **不猜成「没有」**，没有自动运行；要跑请手动点「切片与理解」" };
    renderBooks();
    return { ok: false, code: "UNCHECKED" };
  }

  const rec = {
    phase: j.auto_trigger_allowed === true ? "ran" : "skipped",
    checked: true,
    auto_trigger_allowed: j.auto_trigger_allowed === true,
    has_current_understanding: j.has_current_understanding === true,
    state: typeof j.state === "string" ? j.state : null,
    revision: Number.isInteger(j.revision) ? j.revision : null,
    run_id: typeof j.run_id === "string" ? j.run_id : null,
    note_rel: typeof j.note_rel === "string" ? j.note_rel : null,
    message: fmtUnknown(j.message),
  };
  state.auto[bookId] = rec;
  renderBooks();

  if (rec.auto_trigger_allowed !== true) return { ok: true, code: "SKIPPED", ...rec };

  // 确实没有这条笔记 ⇒ 自动跑第一次。失败也如实留在 state.analyze 里（runAnalyze 自己会报）。
  const out = await runAnalyze(bookId);
  state.auto[bookId] = { ...rec, phase: out && out.ok === true ? "ran" : "skipped",
    message: out && out.ok === true
      ? "盘上原本没有这本书的理解 ⇒ 已自动跑第一次「切片与理解」"
      : "自动跑第一次失败（原因见上方结果块）；没有假装成功" };
  renderBooks();
  return { ok: true, code: "AUTO_RAN", ...state.auto[bookId] };
}

/** 书库行里那行「自动判定」说明（没有判定过就不显示）。 */
function renderAutoNote(b) {
  const a = isMap(state.auto) ? state.auto[b.id] : null;
  if (!isMap(a)) return "";
  if (a.phase === "checking") return '<div class="gdrow gdsmall" data-auto="checking">自动判定中：正在问后端盘上有没有这本书的理解…</div>';
  if (a.phase === "ran") return '<div class="gdrow gdsmall" data-auto="ran">' + esc(a.message) + "</div>";
  const tag = a.has_current_understanding === true
    ? "已有理解（revision " + fmtUnknown(a.revision) + "）· 未自动重跑"
    : "未自动运行";
  return '<div class="gdrow gdsmall" data-auto="skipped">' + esc(tag) + "：" + esc(a.message) + "</div>";
}

/* ==== ANALYZE-FLOW END ==== */

/* ==== SOURCE-FLOW BEGIN ==== */
/*
 * M12 第 3 环的**真实**触发流程：推荐 → 原文 → DSH 讨论。
 *
 * 只依赖 `fetch` / `state` / `API` / `toParent` / `embed` / `renderGuide`（测试用替身驱动），
 * 所以这里**不碰 DOM** —— 渲染一律走 `renderGuide()` → `renderSourceEvidence()`。
 *
 * 四条不许含糊：
 *   · **原文只来自这条推荐的 source_refs**：`openSourceSpan` 只接受 `data-span`（span_id）
 *     传进来的 id，不自己检索、不拿标注顶替（1a）；
 *   · **真打后端**：必须 `await fetch(API + "/reading/source-span", {method:"POST"})`；
 *     没有响应就**不许**显示原文（「前端假成功」是点名反例）；
 *   · **失败如实说找不到**：后端 `ok:false` ⇒ 原样带出 code/message，**不拿别的内容顶替**（1b）；
 *   · **只送不存**：`askAboutSourceSpan` 只把这段原文交给原生会话（`prepare-chat`），
 *     **不写盘、不保存观察**（1f：保存属第 4 环 = M13）。
 */
async function openSourceSpan(spanId, from) {
  const id = typeof spanId === "string" ? spanId.trim() : "";
  const label = typeof from === "string" && from.trim() !== "" ? from.trim() : "unknown";
  const url = API + "/reading/source-span";

  // 形状不对 ⇒ 连后端都不打（不是书内 span，本来就没有原文可取）。**不拿别的内容顶替**。
  if (!isSpanRef(id)) {
    state.source = { span_id: id || null, from: label, phase: "error", data: null, error: {
      code: "NOT_A_SPAN_REF",
      message: "这个 ref 不是书内 span（形状须为 sp_<内容摘要>_<章序>_<起>_<止>）⇒ 取不到原文，不拿别的内容顶替",
    }, requested_url: url };
    renderGuide();
    return { ok: false, phase: "error", code: "NOT_A_SPAN_REF" };
  }

  state.source = { span_id: id, from: label, phase: "loading", data: null, error: null, requested_url: url };
  renderGuide();

  let j = null;
  let status = null;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ span_id: id }),
    });
    status = r.status;
    const text = await r.text();
    try { j = JSON.parse(text); } catch { j = null; }
  } catch (e) {
    state.source = { ...state.source, phase: "error", http_status: status, response_ok: false,
      error: { code: "NETWORK_ERROR", message: String(e && e.message ? e.message : e) } };
    renderGuide();
    return { ok: false, phase: "error", code: "NETWORK_ERROR" };
  }

  if (j === null || typeof j !== "object") {
    state.source = { ...state.source, phase: "error", http_status: status, response_ok: false,
      error: { code: "BAD_RESPONSE", message: "响应不是 JSON（HTTP " + status + "）" } };
  } else if (j.ok === true) {
    // 只收引擎**真的**给了的字段；缺字段一律 null，不在这里补默认值（不编造定位）。
    state.source = { ...state.source, phase: "done", http_status: status, response_ok: true, error: null, data: {
      span_id: typeof j.span_id === "string" ? j.span_id : id,
      book: typeof j.book === "string" && j.book !== "" ? j.book : null,
      book_version_id: j.book_version_id ?? null,
      section_id: j.section_id ?? null,
      section_order: Number.isInteger(j.section_order) ? j.section_order : null,
      start_codepoint: Number.isInteger(j.start_codepoint) ? j.start_codepoint : null,
      end_codepoint: Number.isInteger(j.end_codepoint) ? j.end_codepoint : null,
      text_hash: j.text_hash ?? null,
      quote: typeof j.quote === "string" ? j.quote : "",
      quote_chars: Number.isInteger(j.quote_chars) ? j.quote_chars : null,
      verified: j.verified === true,
    } };
  } else {
    // 后端说取不到 ⇒ 如实带出它的 code/message（不吞、不改写、不顶替）。
    state.source = { ...state.source, phase: "error", http_status: status, response_ok: true,
      error: { code: typeof j.code === "string" ? j.code : "SPAN_READ_FAILED",
        message: typeof j.message === "string" ? j.message : "" } };
  }
  renderGuide();
  return { ok: state.source.phase === "done", phase: state.source.phase,
    data: state.source.data, error: state.source.error, span_id: id };
}

/**
 * 把**已经取到的那段原文**送进 DSH 讨论（走父窗口的 `prepare-chat`）。
 *
 * 三条硬要求：
 *   · `passage.text` **就是** `openSourceSpan` 取到的那段原文（来源 = 该推荐的 source_refs）；
 *   · 带上 `attribution` / `locator` / `source_ref`，让注入上下文如实标注这是**书中原文**，
 *     不是用户自己的话、也不是 AI 推演（1d）；
 *   · 原文为空 / 没有取到 ⇒ **不送**（宁可不送，也不拿别的内容顶替）。
 */
async function askAboutSourceSpan() {
  const s = isMap(state.source) ? state.source : null;
  if (!isMap(s) || s.phase !== "done" || !isMap(s.data)) {
    return { ok: false, code: "NO_SOURCE", message: "还没有取到原文，先点「看原文」" };
  }
  const d = s.data;
  const quote = typeof d.quote === "string" ? d.quote : "";
  if (quote.trim() === "") {
    return { ok: false, code: "EMPTY_QUOTE", message: "取到的原文是空的 ⇒ 不送进讨论（不拿别的内容顶替）" };
  }
  if (!(isMap(embed) && embed.on === true)) {
    return { ok: false, code: "NOT_EMBEDDED",
      message: "当前不是嵌在 DSH 面板里，没有可送的原生会话（原文仍可在本页核对）" };
  }

  const locator = sourceLocatorText(d);
  // 书用**引擎按 span 给的那本**（它才是这段原文的归属）；只有引擎没给才退回当前选中的书。
  const spanBook = str(d.book);
  const currentBook = isMap(state.current) ? str(state.current.title) : null;
  const book = spanBook ?? currentBook ?? "";
  const bookMismatch = !!(spanBook && currentBook && spanBook !== currentBook);

  toParent({
    type: "apple-read:ask",
    book,
    // 这段原文**不是**用户自己的话：带上归属标注，宿主据此在上下文里标明它是书中原文。
    passage: {
      chapter: locator,
      text: quote,
      attribution: "book_quote_from_recommendation",
      locator,
      source_ref: typeof d.span_id === "string" ? d.span_id : null,
    },
    question: "这段原文在讲什么？它与这条推荐的理由对得上吗？",
  });
  return { ok: true, mode: "embedded", book, book_mismatch: bookMismatch,
    span_id: d.span_id ?? null, locator, chars: quote.length };
}

/**
 * M14 第 4 环：把**面板上这次真实互动**落成证据笔记。
 *
 * 只做四件事：
 *   · 从 DOM 读用户**自己打的字**（面板不生成、不补写用户判断）；
 *   · **真打后端** `POST /reading/record-evidence`（「前端假成功」是点名反例）；
 *   · 后端 `ok:false` ⇒ 原样带出 code/message，**不粉饰**；
 *   · 结果如实分三种说清：写了 / 幂等命中没重写 / 被拒绝（含原因）。
 *
 * 面板**不替后端判断标签**：`label` 只是把预演结果一并送过去，真实派生由后端按字段决定。
 */
async function recordEvidenceFromSource() {
  const src = isMap(state.source) ? state.source : null;
  const d = src && isMap(src.data) ? src.data : null;
  const spanId = d && typeof d.span_id === "string" ? d.span_id : "";
  const setRecord = (rec) => { state.source = { ...(state.source ?? {}), record: rec }; renderGuide(); };

  if (spanId === "") {
    setRecord({ ok: false, code: "NO_SPAN", message: "还没取到原文 ⇒ 先「看原文」，再记观察（不凭印象写证据）。" });
    return { ok: false, code: "NO_SPAN" };
  }
  const checked = document.querySelector('input[name="gdevkind"]:checked');
  const kind = checked ? checked.value : "";
  const dimension = checked && checked.dataset && checked.dataset.dim ? checked.dataset.dim : null;
  const statementEl = document.getElementById("gd-ev-statement");
  const statement = statementEl ? String(statementEl.value || "").trim() : "";
  const conceptEl = document.getElementById("gd-ev-concept");
  const conceptRaw = conceptEl ? String(conceptEl.value || "") : "";
  const conceptRefs = conceptRaw.split(/[,，]/).map((s) => s.trim()).filter((s) => s !== "");
  const topicEl = document.getElementById("gd-ev-topic");
  const topic = topicEl && String(topicEl.value || "").trim() !== "" ? String(topicEl.value).trim() : null;

  // 本地先挡一道（缺什么说清楚）；后端还会再校验一次 —— 两道都要有。
  if (kind === "") {
    setRecord({ ok: false, code: "NO_KIND", message: "先选「这次互动是什么」：没有这一项，就不知道要派生哪个标签。" });
    return { ok: false, code: "NO_KIND" };
  }
  if (statement === "") {
    setRecord({ ok: false, code: "NO_STATEMENT", message: "你自己那句话还没写 ⇒ 不保存（面板不替你写用户判断）。" });
    return { ok: false, code: "NO_STATEMENT" };
  }
  if (conceptRefs.length === 0) {
    setRecord({ ok: false, code: "NO_CONCEPT", message: "「概念」必填：没有概念，这条证据以后没法被检索和用上。" });
    return { ok: false, code: "NO_CONCEPT" };
  }

  const preview = evidenceLabelPreview({ kind, dimension, origin: "user" });

  let j = null;
  let status = null;
  try {
    const r = await fetch(API + "/reading/record-evidence", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        span_id: spanId,
        statement,
        kind,
        dimension,
        concept_refs: conceptRefs,
        topic,
        label: preview.label,
        occurred_at: new Date().toISOString(),
        origin: "user",
      }),
    });
    status = r.status;
    const text = await r.text();
    try { j = JSON.parse(text); } catch { j = null; }
  } catch (e) {
    setRecord({ ok: false, code: "NETWORK_ERROR", message: "没打通后端：" + String(e && e.message ? e.message : e) });
    return { ok: false, code: "NETWORK_ERROR" };
  }

  if (j === null || typeof j !== "object") {
    setRecord({ ok: false, code: "BAD_RESPONSE", message: "响应不是 JSON（HTTP " + status + "）⇒ 不假装保存成功。" });
    return { ok: false, code: "BAD_RESPONSE" };
  }
  if (j.ok !== true) {
    setRecord({
      ok: false,
      code: j.code ?? "REFUSED",
      message: (j.code ? "[" + j.code + "] " : "") + (j.message ?? "后端拒绝了，但没给原因"),
    });
    return j;
  }

  const re = isMap(j.reading_evidence) ? j.reading_evidence : {};
  const uo = isMap(j.understanding_observation) ? j.understanding_observation : {};
  const parts = [];
  parts.push(j.replayed === true
    ? "同一次互动之前已经存过 ⇒ 这次**没有重复写**（幂等命中）。"
    : "已写入学习证据。");
  if (re.note_rel) parts.push("证据：" + re.note_rel);
  if (uo.written === true && uo.note_rel) parts.push("理解变化：" + uo.note_rel);
  else if (uo.code === "NOT_APPLICABLE") parts.push("理解变化：不适用（" + (uo.message ?? "") + "）");
  parts.push("预演标签：" + preview.label + "（真实标签由落盘字段派生）");
  parts.push("默认未确认；采集到一条证据 ≠ 读懂这本书。");
  setRecord({ ok: true, code: j.code ?? "OK", message: parts.join(" "), response: j });
  return j;
}

/* ==== SOURCE-FLOW END ==== */

/* ==== CONFIRM-FLOW BEGIN ==== */
/*
 * M15 阶段 3（第 5 环）：面板上的「我确认这条观察」。
 *
 * 为什么要有这一步：M14 写下的观察一律 `unconfirmed`，而未确认观察参与计算 ⇒ `q=0.5`
 * ⇒ `personalization_status` 永远到不了 `available`。「确认」只能是**用户自己**的动作。
 *
 * 四条不许含糊：
 *   · **真打后端**：必须 `await fetch(API + "/reading/confirm-observation", {method:"POST"})`；
 *     没打通/响应不对就**不许**显示「已确认」（「前端假成功」是点名反例）；
 *   · **changed:false 如实说**：已经确认过的不许显示成「刚刚确认成功」；
 *   · **失败如实报**：后端 `ok:false` ⇒ 原样带出 code/message，不粉饰；
 *   · **诚实边界要显示**：回执里的 `honesty.does_not_mean`（确认 ≠ 高置信 / ≠ 已掌握 /
 *     ≠ 读懂这本书）原样交给渲染器显示。
 *
 * 只依赖 `fetch` / `state` / `API` / `renderGuide`（测试用替身驱动），所以**不碰 DOM**。
 */
async function confirmEvidenceNote(noteId) {
  const id = typeof noteId === "string" ? noteId.trim() : "";
  const url = API + "/reading/confirm-observation";
  const setConfirm = (rec) => {
    state.reading = { ...(isMap(state.reading) ? state.reading : {}), confirm: rec };
    renderGuide();
  };

  // 没有 note_id ⇒ 连后端都不打（不知道确认哪条，猜一个 id 就是编）。
  if (id === "") {
    setConfirm({
      ok: false, code: "NO_NOTE_ID", note_id: null, changed: false,
      message: "没有 note_id ⇒ 不知道要确认哪条观察（不打后端）",
    });
    return { ok: false, code: "NO_NOTE_ID", changed: false };
  }

  let j = null;
  let status = null;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note_id: id, actor: "user", at: new Date().toISOString() }),
    });
    status = r.status;
    const text = await r.text();
    try { j = JSON.parse(text); } catch { j = null; }
  } catch (e) {
    setConfirm({
      ok: false, code: "NETWORK_ERROR", note_id: id, changed: false,
      message: "没打通后端：" + String(e && e.message ? e.message : e),
    });
    return { ok: false, code: "NETWORK_ERROR", changed: false };
  }

  if (j === null || typeof j !== "object") {
    setConfirm({
      ok: false, code: "BAD_RESPONSE", note_id: id, changed: false,
      message: "响应不是 JSON（HTTP " + status + "）⇒ 不假装确认成功。",
    });
    return { ok: false, code: "BAD_RESPONSE", changed: false };
  }
  if (j.ok !== true) {
    setConfirm({
      ok: false, code: j.code ?? "REFUSED", note_id: id, changed: false,
      message: (j.code ? "[" + j.code + "] " : "") + (j.message ?? "后端拒绝了，但没给原因"),
    });
    return j;
  }

  const changed = j.changed === true;
  const confirmation = typeof j.confirmation === "string" ? j.confirmation : null;
  // 成功且确实写盘 ⇒ 按**后端回执**更新清单里那条的确认状态（不自己假设它变了）。
  if (changed && confirmation === "confirmed" && isMap(state.reading) && isMap(state.reading.evidence)
      && Array.isArray(state.reading.evidence.notes)) {
    const hit = state.reading.evidence.notes.find((n) => isMap(n) && n.note_id === (j.note_id ?? id));
    if (hit) hit.confirmation = "confirmed";
  }
  setConfirm({
    ok: true, code: j.code ?? "OK", note_id: j.note_id ?? id, note_rel: j.note_rel ?? null,
    changed, confirmation, origin: j.origin ?? null,
    confirmation_evidence: isMap(j.confirmation_evidence) ? j.confirmation_evidence : null,
    honesty: isMap(j.honesty) ? j.honesty : null,
    message: typeof j.message === "string" ? j.message : "",
  });
  return j;
}
/* ==== CONFIRM-FLOW END ==== */

/**
 * 极简 markdown：标题、无序/有序列表、引用、行内代码、**加粗**。
 * 模型回答基本是「**小标题** + 列表 + 引原文」这个结构，只处理加粗的话读起来是一坨。
 * 内容来自书，不做富文本猜测——没匹配上的一律当纯文本。
 */
function md(s) {
  const out = [];
  let list = null; // "ul" | "ol" | null
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of esc(s).split("\n")) {
    const line = raw
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");
    const h = line.match(/^(#{1,5})\s+(.+)$/);
    const ul = line.match(/^\s*[-*•]\s+(.+)$/);
    const ol = line.match(/^\s*\d+[.、)]\s+(.+)$/);
    const bq = line.match(/^&gt;\s?(.*)$/);
    if (h) {
      closeList();
      const lv = Math.min(h[1].length + 2, 5);
      out.push(`<h${lv}>${h[2]}</h${lv}>`);
    } else if (ul) {
      if (list !== "ul") { closeList(); out.push("<ul>"); list = "ul"; }
      out.push(`<li>${ul[1]}</li>`);
    } else if (ol) {
      if (list !== "ol") { closeList(); out.push("<ol>"); list = "ol"; }
      out.push(`<li>${ol[1]}</li>`);
    } else if (bq) {
      closeList();
      out.push(`<blockquote>${bq[1]}</blockquote>`);
    } else if (!line.trim()) {
      closeList();
    } else {
      closeList();
      out.push(`<p>${line}</p>`);
    }
  }
  closeList();
  return out.join("");
}

function setStatus(msg) { $("#libstatus").textContent = msg || ""; }

// --------------------------------------------------------------------------- //
// 启动
// --------------------------------------------------------------------------- //

async function boot() {
  try {
    const cfg = await api("/config");
    // 存档读不到不是致命错误：退回 config 默认值继续可用。
    const st = await api("/settings").catch(() => null);
    const saved = (st && st.settings) || null;

    // provider：优先用存过的，其次才是 config 的默认值。
    // （以前无条件用 defaultProviderId，用户选完一刷新就回到默认。）
    const ids = cfg.providers.map((p) => p.id);
    state.providerId = saved && ids.includes(saved.providerId) ? saved.providerId : cfg.defaultProviderId;
    $("#provider").innerHTML = cfg.providers.map((p) =>
      `<option value="${esc(p.id)}">${esc(p.displayName)}${p.hasKey ? "" : "（未配置 Key）"}</option>`).join("");
    $("#provider").value = state.providerId;

    // 「带上我划的重点」：存档优先
    if (saved && typeof saved.withMarks === "boolean") {
      state.withMarks = saved.withMarks;
      $("#withMarks").checked = saved.withMarks;
    }

    // 精排开关：模型没下载就灰掉并说明，避免「勾了却没效果」
    const rr = $("#withRerank");
    if (cfg.rerank) {
      // 存过就按存档，没存过就用控件当前默认勾选态
      state.rerank = saved && typeof saved.rerank === "boolean" ? saved.rerank : rr.checked;
      rr.checked = state.rerank;
      $("#rrwrap").title = `精排已启用（${cfg.rerankModel}）：检索到的段落会被 cross-encoder 重新打分，命中更准，慢约 1.8 秒`;
    } else {
      rr.checked = false;
      rr.disabled = true;
      state.rerank = false;
      $("#rrwrap").classList.add("off");
      $("#rrwrap").title = "精排模型还没下载（约 1GB，一次性）。"
        + "在终端跑：cd DSH-apple-Read && uv run books_rag.py rerank-setup";
    }
  } catch (e) {
    toast("读取配置失败：" + e.message, true);
  }

  $("#provider").addEventListener("change", (e) => {
    state.providerId = e.target.value;
    void persistSettings({ providerId: state.providerId });
  });

  await loadLibrary();
  // 导读区随面板启动就绪（只读投影，不依赖是否选过书）
  void loadReading();

  // 告诉父窗口「我准备好了」：它会回一条 embed 指令，把这里切成书库栏模式。
  toParent({ type: "apple-read:ready" });
}

async function loadLibrary() {
  $("#books").innerHTML = '<div class="empty">正在读取书库…</div>';
  try {
    const data = await api("/books");
    state.books = data.books || [];
    $("#engine").textContent = "引擎就绪";
    $("#engine").className = "engine ok";
  } catch (e) {
    $("#engine").textContent = "引擎启动失败";
    $("#engine").className = "engine bad";
    $("#books").innerHTML = `<div class="empty">读不到书库：${esc(e.message)}</div>`;
    setStatus("检查 uv 路径与 books_rag.py 依赖");
    return;
  }

  try {
    const a = await api("/annotations?limit=200");
    state.annotations = a.annotations || [];
  } catch {
    state.annotations = [];
  }

  const counts = {};
  for (const a of state.annotations) counts[a.book] = (counts[a.book] || 0) + 1;
  for (const b of state.books) b.ann_count = counts[b.title] || 0;

  const indexed = state.books.filter((b) => b.indexed).length;
  setStatus(`${state.books.length} 本 · 已索引 ${indexed} · 标注 ${state.annotations.length} 条`);
  renderBooks();

  // 打开面板直接落在「最近在读」那本上，省得每次都要去左栏翻。
  // last_opened 是 "YYYY-MM-DD HH:MM" 字符串，字典序即时间序。
  if (!state.current && state.books.length) {
    const recent = state.books
      .filter((b) => b.last_opened)
      .sort((a, b) => String(b.last_opened).localeCompare(String(a.last_opened)))[0];
    selectBook((recent || state.books[0]).id);
  }
}

// --------------------------------------------------------------------------- //
// 导读（两层推荐 UI · 纯展示）
// --------------------------------------------------------------------------- //
// 数据全部来自 M6 已经挂好的只读路由，面板**不生成**任何阅读数据、不写盘：
//   /api/reading/coverage        覆盖账本（分母、未知部分、逐单元状态、诚实判定）
//   /api/reading/recommendations 已保存的推荐运行列表
//   /api/reading/library         书籍/概括的正式条目计数
//
// ⚠️ 诚实说明：
//   · `/reading/recommendations` **会**返回某个 run 的两层内容（book_guide /
//     personalized_items / scores）—— M8 起由后端只读投影出来，不是面板编的；
//   · 方案 B 起这里带 `?path=`，拿的是**当前选中这本书**的理解（不是全库最新一条）；
//   · 带 `?path=` 但这本书没有理解时，后端给**诚实空态**（result=null），
//     面板不会拿别的书的内容顶替；第一层/第二层就走空态。
//     两层渲染由夹具驱动的 `tests/reading-panel.test.mjs` 证明（含变异测试）。

async function loadReading() {
  const el = $("#guide");
  if (!el) return;
  el.innerHTML = '<div class="empty">正在读取阅读数据…</div>';
  const get = (p) => api(p).catch((e) => ({ ok: false, code: "FETCH_FAILED", message: String(e.message || e) }));
  // 阶段 2：除了三份全库数据，再按**当前选中的这本书**查一次理解状态。
  // 有 path 才查；没 path 就 null（renderBookSection 会如实说「不猜」）。
  const cur = isMap(state.current) ? state.current : null;
  const bookReq = cur && str(cur.path)
    ? get("/reading/understanding-status?path=" + encodeURIComponent(cur.path))
    : Promise.resolve(null);
  // 方案 B：导读也按**这本书**取。有 path 才带；没 path 就不带 ——
  // 后端不带 `?path=` 时行为与以前一字不变（全库最新一条），所以降级是安全的。
  const recReq = cur && str(cur.path)
    ? get("/reading/recommendations?path=" + encodeURIComponent(cur.path))
    : get("/reading/recommendations");
  // M15 阶段 3：证据笔记清单（**只读**）—— 渲染「我确认这条观察」按钮要知道 note_id
  // 与当前 confirmation。按当前这本书取；没 path 就不带（后端如实标「未按书过滤」）。
  const evReq = cur && str(cur.path)
    ? get("/reading/evidence?path=" + encodeURIComponent(cur.path))
    : get("/reading/evidence");
  const [coverage, recommendations, library, bookStatus, evidence] = await Promise.all([
    get("/reading/coverage"),
    recReq,
    get("/reading/library"),
    bookReq,
    evReq,
  ]);
  // 宿主将来把 RecommendationResult 挂在这里时，两层区就会自动亮起来。
  // M8 起路由真的会返回它（只读投影自已保存的 recommendation_run）；
  // 取法**只有一处**：pickReadingResult（跨层契约测试原样截取它）。
  const result = pickReadingResult(recommendations);
  state.reading = {
    coverage, recommendations, library, result, evidence,
    book: cur ? { id: cur.id, title: cur.title, author: cur.author, path: cur.path, status: bookStatus } : null,
  };
  renderGuide();
}

function renderGuide() {
  const el = $("#guide");
  if (!el) return;
  el.innerHTML = renderGuideHtml(state.reading, state.source);
  wireSourceButtons(el);
  const sum = $("#guidesum");
  if (sum) sum.textContent = "书本导读";
}

/**
 * M12：给「看原文」按钮与「送进 DSH 讨论」按钮接线。
 *
 * 渲染是**纯函数**（READING-VIEW 区，测试原样截取求值），事件接线只能放在这里（碰 DOM）。
 * 每次 `renderGuide()` 重绘后都要重新接（innerHTML 会丢掉旧监听）。
 */
function wireSourceButtons(el) {
  el.querySelectorAll("[data-span]").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      // 只把**这个按钮上的 span_id** 送进去：不重新检索、不拿标注顶替。
      void openSourceSpan(btn.dataset.span, btn.dataset.from);
    });
  });
  const ask = el.querySelector("[data-askspan]");
  if (ask) {
    ask.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      const r = await askAboutSourceSpan();
      if (!r || r.ok !== true) {
        toast((r && r.message) || "送进讨论失败", true);
        return;
      }
      toast(r.book_mismatch
        ? "已送进 DSH 讨论（注意：这段原文属于《" + r.book + "》，与当前选中的不是同一本）"
        : "已把这段原文送进右侧 DSH 讨论");
    });
  }

  // —— M14 第 4 环：记下这条观察 ——
  // 先选「这次是什么」就把**派生的标签**显示出来，用户确认后才存（1b：先显示后保存）。
  el.querySelectorAll('input[name="gdevkind"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      const pv = document.getElementById("gd-ev-preview");
      if (!pv) return;
      const dim = radio.dataset && radio.dataset.dim ? radio.dataset.dim : null;
      pv.textContent = "预演标签：" + evidenceLabelPreview({ kind: radio.value, dimension: dim, origin: "user" }).label;
    });
  });
  const recBtn = el.querySelector("[data-recevidence]");
  if (recBtn) {
    recBtn.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      const r = await recordEvidenceFromSource();
      if (!r || r.ok !== true) {
        toast((r && r.message) || "记下观察失败", true);
        return;
      }
      toast(r.replayed === true
        ? "同一次互动已存过 ⇒ 没有重复写"
        : "已记下这条观察（默认未确认）");
    });
  }

  // —— M15 阶段 3：我确认这条观察 ——
  // 真打后端（confirmEvidenceNote）；changed:false 如实说「已经确认过了」，不当成刚确认成功。
  el.querySelectorAll("[data-confirm]").forEach((btn) => {
    btn.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      const r = await confirmEvidenceNote(btn.dataset.confirm);
      if (!r || r.ok !== true) {
        toast((r && r.message) || "确认失败", true);
        return;
      }
      toast(r.changed === true
        ? "已确认这条观察（确认 ≠ 高置信、≠ 已掌握、≠ 读懂这本书）"
        : "这条观察已经确认过了（没有重复写）");
    });
  });
}

// --------------------------------------------------------------------------- //
// 书库列表
// --------------------------------------------------------------------------- //

function renderBooks() {
  const q = state.filter.trim().toLowerCase();
  const list = state.books.filter((b) =>
    !q || b.title.toLowerCase().includes(q) || (b.author || "").toLowerCase().includes(q));
  const el = $("#books");
  $("#nBooks").textContent = list.length ? String(list.length) : "";
  // M9：结果块随书库列表一起重绘（放在列表最上方）。用 renderAnalyzeReport 的**唯一**渲染路径，
  // 不在别处再拼一份，避免两套取法漂移。
  const analyzeBlock = renderAnalyzeReport(state.analyze);
  if (!list.length) {
    el.innerHTML = analyzeBlock + '<div class="empty">没有匹配的书。</div>';
    return;
  }
  const running = isMap(state.analyze) && state.analyze.phase === "running";
  el.innerHTML = analyzeBlock + list.map((b) => `
    <div class="book${state.current && state.current.id === b.id ? " active" : ""}" data-id="${esc(b.id)}">
      <div class="t">${esc(b.title)}</div>
      <div class="m">
        ${b.author ? `<span>${esc(b.author)}</span>` : ""}
        ${b.indexed ? '<span class="badge idx">已索引</span>' : '<span class="badge">未索引</span>'}
        ${b.progress ? `<span>${b.progress}%</span>` : ""}
        ${b.ann_count ? `<span>${b.ann_count} 标注</span>` : ""}
      </div>
      <button class="ghost small bk-analyze" data-analyze="${esc(b.id)}"${running ? " disabled" : ""}
              title="逐章分析这本书，把切片/概括/候选经 M1 事务写入 45-书籍/。同一本书只有一条理解笔记：再点一次＝复算，覆盖同一条，revision 递增（手动点＝明确要求重算，一定会执行）"
        >${running && isMap(state.analyze) && state.analyze.book_id === b.id ? "分析中…" : "切片与理解"}</button>
      ${renderAutoNote(b)}
    </div>`).join("");
  el.querySelectorAll(".book").forEach((node) => {
    node.addEventListener("click", () => selectBook(node.dataset.id, true));
  });
  el.querySelectorAll("[data-analyze]").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();   // 「切片与理解」不是「选书」，别顺带把当前书切走
      void runAnalyze(btn.dataset.analyze);
    });
  });
}

function selectBook(id, userPicked) {
  const b = state.books.find((x) => x.id === id);
  if (!b) return;
  if (!state.current || state.current.id !== b.id) {
    state.history = [];
    state.focusId = null;
    $("#chat").innerHTML = '<div class="hint">已切到这本书，对话重新开始。</div>';
  }
  state.current = b;
  const t = $("#booktitle");
  t.textContent = b.title + (b.author ? ` — ${b.author}` : "");
  t.title = b.title;
  t.classList.remove("placeholder");
  $("#openBook").disabled = false;
  const ib = $("#indexBook");
  ib.disabled = false;
  ib.textContent = b.indexed ? "重建索引" : "建索引";
  renderBooks();
  renderAnnotations();
  resetHits();   // 换了书，旧的检索结果就不成立了
  // 告诉父窗口在读哪本：它会把这个登记成当前会话的阅读上下文，
  // 这样用户直接在右边原生输入框里打字提问，模型也知道在读什么。
  toParent({ type: "apple-read:book", book: b.title });

  // M10 阶段 3b：打开一本书 ⇒ 自动判定「盘上有没有当前理解」，**没有**才自动跑第一次。
  // 同一本书只判定一次（autoUnderstanding 自带短路），来回切书不会反复触发；
  // 判据来自后端（见 autoUnderstanding），前端不猜。
  void autoUnderstanding(b.id);

  // 导读改版阶段 2：切书必须重读导读 —— 否则「这本书」区还停在上一次选中的书上。
  // 读的是 state.current，所以要在 state.current 已经换成 b 之后再调。
  void loadReading();

  // 窄栏里手动选完书就跳到「重点」：选书的下一步几乎总是看这本书的标注。
  // 开机自动选中「最近在读」那本时不算手动（userPicked 为空），会停在书库 Tab。
  if (userPicked && narrow()) setTab("marks");
}

// --------------------------------------------------------------------------- //
// 高亮 / 笔记
// --------------------------------------------------------------------------- //

function renderAnnotations() {
  const el = $("#annlist");
  if (!state.current) {
    $("#annsum").textContent = "我划的重点";
    el.innerHTML = '<div class="empty">选中书籍后显示。</div>';
    return;
  }
  const mine = state.annotations.filter((a) => a.book === state.current.title);
  $("#annsum").textContent = `我划的重点（${mine.length}）`;
  $("#nMarks").textContent = mine.length ? String(mine.length) : "";
  $("#markhint").textContent = state.withMarks && mine.length ? `会带上这 ${mine.length} 条` : "";
  if (!mine.length) {
    el.innerHTML = state.annotations.length
      ? '<div class="empty">这本书还没有高亮或笔记。去「图书」App 里划一句，回来就能问。</div>'
      : '<div class="empty">读不到标注库。要给 DeepSeek Harness 授予「完全磁盘访问权限」并重启；全文问答不受影响。</div>';
    return;
  }
  el.innerHTML = mine.map((a) => `
    <div class="ann" data-id="${a.id}">
      <div class="q">${esc(a.text || a.note || "(无正文)")}</div>
      ${a.note && a.text ? `<div class="meta">笔记：${esc(a.note)}</div>` : ""}
      <div class="meta">
        <span>${esc(a.color)} · ${esc(a.modified || "")}</span>
        <button class="askbtn" data-ask="${a.id}">问 AI</button>
        <button class="linkbtn" data-ctx="${a.id}">看上下文</button>
      </div>
    </div>`).join("");
  el.querySelectorAll("[data-ask]").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const a = state.annotations.find((x) => x.id === Number(btn.dataset.ask));
      if (a) askAbout(a);
    });
  });
  el.querySelectorAll("[data-ctx]").forEach((btn) => {
    btn.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      const id = Number(btn.dataset.ctx);
      const holder = btn.closest(".ann");
      const old = holder.querySelector(".ctx");
      if (old) { old.remove(); return; }
      btn.textContent = "载入中…";
      try {
        const res = await api("/context", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ id, before: 400, after: 400 }),
        });
        if (res.error) throw new Error(res.error);
        const div = document.createElement("div");
        div.className = "ctx";
        div.textContent = `章节「${res.chapter || "?"}」${res.exact ? "" : "（近似定位）"}\n\n${res.context || ""}`;
        holder.appendChild(div);
        btn.textContent = "收起";
      } catch (e) {
        toast("取上下文失败：" + e.message, true);
        btn.textContent = "看上下文";
      }
    });
  });
}

// --------------------------------------------------------------------------- //
// 在书里找（向量语义检索 + 可选精排）
// --------------------------------------------------------------------------- //
// 宿主早就暴露了 /api/search，面板一直没接。它和「我划的重点」是同一类东西
// ——都关于当前这本书，所以放在同一个区域，点某段的「问 AI」走同一条原生会话通道。

async function doSearch() {
  const q = $("#q").value.trim();
  if (!q) return;
  if (!state.current) { toast("先在「书库」里选一本书", true); return; }

  const btn = $("#doSearch");
  btn.disabled = true;
  $("#hits").innerHTML = '<div class="empty">检索中…（首次问某本书会自动建索引，可能要几十秒）</div>';
  try {
    const res = await api("/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ book: state.current.title, query: q, k: 6, rerank: state.rerank }),
    });
    state.hits = res.hits || [];
    $("#searchsum").textContent = `在书里找（${state.hits.length}）`;
    renderHits(res.reranked);
  } catch (e) {
    state.hits = [];
    $("#searchsum").textContent = "在书里找";
    $("#hits").innerHTML = `<div class="empty">检索失败：${esc(e.message)}</div>`;
  } finally {
    btn.disabled = false;
  }
}

function renderHits(reranked) {
  const el = $("#hits");
  if (!state.hits.length) {
    el.innerHTML = '<div class="empty">没找到相关段落。换个说法再试——这是语义检索，不必和原文用词一致。</div>';
    return;
  }
  el.innerHTML = state.hits.map((h, i) => {
    const text = h.text || "";
    return `<div class="hit">
      <div class="meta">
        <span class="ch">${i + 1}. 章节「${esc(h.chapter || "?")}」</span>
        <span class="sc">${esc(String(h.score ?? ""))}</span>
        <button class="askbtn" data-askhit="${i}">问 AI</button>
      </div>
      <div class="q">${esc(text.slice(0, 400))}${text.length > 400 ? "…" : ""}</div>
    </div>`;
  }).join("") + (reranked ? '<div class="empty">已用 cross-encoder 精排</div>' : "");

  el.querySelectorAll("[data-askhit]").forEach((b) => {
    b.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const h = state.hits[Number(b.dataset.askhit)];
      if (h) askAboutPassage(h);
    });
  });
}

/** 就检索到的某一段开聊。 */
function askAboutPassage(h) {
  const question = "这段在讲什么？";
  // 嵌入模式：交给右侧原生会话。原文整段随 passage 一起走，
  // 宿主的阅读上下文会把它标成「用户正在问的这段」。
  if (embed.on) {
    toParent({
      type: "apple-read:ask",
      book: state.current ? state.current.title : "",
      passage: { chapter: h.chapter || "", text: h.text || "" },
      question,
    });
    return;
  }
  $("#input").value = `「${(h.text || "").slice(0, 80)}…」这段在讲什么？`;
  send();
}

function resetHits() {
  state.hits = [];
  $("#searchsum").textContent = "在书里找";
  $("#hits").innerHTML = '<div class="empty">输入一句话，在整本书里找相关段落。</div>';
}

// --------------------------------------------------------------------------- //
// 聊天
// --------------------------------------------------------------------------- //

function scrollChat() { const c = $("#chat"); c.scrollTop = c.scrollHeight; }

function addMsg(role, text) {
  const wrap = document.createElement("div");
  wrap.className = "msg " + role;
  wrap.innerHTML = `<div class="who">${role === "user" ? "我" : "AI"}</div><div class="body"></div>`;
  const body = wrap.querySelector(".body");
  body.textContent = text || "";
  $("#chat").appendChild(wrap);
  scrollChat();
  return wrap;
}

/** 就某条高亮一键开聊：把那条排到最前面，并问一个具体的开场问题。 */
function askAbout(a) {
  const snippet = (a.text || a.note || "").slice(0, 60);
  state.focusId = a.id;

  // 嵌入模式：这里没有自己的聊天栏，把这条交给右侧的 Harness 原生会话。
  // 问题只问「这句」，标注原文、章节、前后原文和全书检索依据由宿主组装后
  // 按 session 注入，不需要塞进这句话里。
  if (embed.on) {
    toParent({
      type: "apple-read:ask",
      book: state.current ? state.current.title : "",
      annotationId: a.id,
      question: "这句在讲什么？为什么值得划？",
    });
    return;
  }

  $("#input").value = `我划了这句：「${snippet}${(a.text || "").length > 60 ? "…" : ""}」这句在讲什么？为什么值得划？`;
  send();
}

async function send() {
  const input = $("#input");
  const q = input.value.trim();
  if (!q || state.sending) return;
  if (!state.current) { toast("先在「书库」里选一本书", true); return; }

  input.value = "";
  input.style.height = "auto";
  state.history.push({ role: "user", content: q });
  addMsg("user", q);

  state.sending = true;
  $("#send").disabled = true;
  const asst = addMsg("assistant", "");
  const bodyEl = asst.querySelector(".body");
  let thinkBox = null;
  let thinkBody = null;

  const focus = state.focusId;
  state.focusId = null;
  try {
    const resp = await fetch(API + "/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        book: state.current.title,
        providerId: state.providerId,
        messages: state.history,
        k: 6,
        includeAnnotations: state.withMarks,
        focusAnnotationId: focus,
        rerank: state.rerank,
      }),
    });
    if (!resp.ok) {
      const j = await resp.json().catch(() => ({}));
      throw new Error(j.error || ("HTTP " + resp.status));
    }

    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let answer = "";
    let failed = null;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const line = chunk.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        let obj;
        try { obj = JSON.parse(line.slice(5).trim()); } catch { continue; }
        if (obj.type === "text") {
          answer += obj.text;
          bodyEl.innerHTML = md(answer);
          scrollChat();
        } else if (obj.type === "thinking") {
          if (!thinkBox) {
            thinkBox = document.createElement("details");
            thinkBox.className = "think";
            thinkBox.innerHTML = "<summary>推理过程</summary>";
            thinkBody = document.createElement("div");
            thinkBox.appendChild(thinkBody);
            asst.parentNode.insertBefore(thinkBox, asst);
          }
          thinkBody.textContent += obj.text;
          scrollChat();
        } else if (obj.type === "context") {
          const bits = [];
          if (obj.marks) bits.push(`你划的 ${obj.marks} 条重点`);
          if (obj.hits) bits.push(obj.reranked ? "全书检索（已精排）" : "全书检索");
          if (bits.length) {
            const note = document.createElement("div");
            note.className = "ctxnote";
            note.textContent = "依据：" + bits.join(" + ");
            asst.parentNode.insertBefore(note, asst);
          }
          // 点了某条标注却取不到它的原文时，明确提示——否则用户以为问了，
          // 模型其实没拿到那一句，只能凭印象答。
          if (obj.focusError) toast("你点的那条标注没取到：" + obj.focusError, true);
        } else if (obj.type === "error") {
          failed = obj.message;
        }
      }
    }
    if (failed) throw new Error(failed);
    if (answer) state.history.push({ role: "assistant", content: answer });
  } catch (e) {
    asst.classList.add("err");
    bodyEl.textContent = "出错：" + e.message;
  } finally {
    state.sending = false;
    $("#send").disabled = false;
    input.focus();
  }
}

// --------------------------------------------------------------------------- //
// 动作
// --------------------------------------------------------------------------- //

async function openBook() {
  if (!state.current) return;
  try {
    const r = await api("/open", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ book: state.current.title }),
    });
    toast(r.message || "已打开");
  } catch (e) { toast("打开失败：" + e.message, true); }
}

async function indexBook(book, quiet) {
  // 已经索引过的书再点就是「重建」，必须显式 force，
  // 否则后端发现索引还在、书也没变，会直接跳过 —— 按钮就成了骗人的。
  const r = await api("/index", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ book: book.title, force: !!book.indexed }),
  });
  if (r.error) throw new Error(r.error);
  book.indexed = true;
  if (!quiet) toast(`《${book.title}》索引完成：${r.chunks} 段`);
  return r;
}

async function indexAll() {
  const todo = state.books.filter((b) => !b.indexed);
  if (!todo.length) { toast("所有书都已建索引"); return; }
  const btn = $("#indexAll");
  btn.disabled = true;
  let done = 0, failed = 0;
  for (const b of todo) {
    setStatus(`建索引 ${done + failed + 1}/${todo.length}：《${b.title}》`);
    try { await indexBook(b, true); done++; }
    catch { failed++; }
  }
  btn.disabled = false;
  setStatus(`${state.books.length} 本 · 已索引 ${state.books.filter((b) => b.indexed).length} · 标注 ${state.annotations.length} 条`);
  renderBooks();
  toast(`索引完成：成功 ${done}${failed ? `，失败 ${failed}` : ""}`);
}

// --------------------------------------------------------------------------- //
// 窄栏 Tab（书库 / 重点 / 在书里找）
// --------------------------------------------------------------------------- //
// 340px 宽的嵌入栏里，三个区上下堆叠会互相抢高度：书库被压到 42%，列表只露五六本。
// 改成一次只显示一个，每个区都拿到完整高度。宽屏下 Tab 栏被 CSS 隐藏，
// 这里的逻辑照跑但不会影响左右两栏布局。

const TABS = ["books", "guide", "marks", "search"];
const narrow = () => window.matchMedia("(max-width: 720px)").matches;

function setTab(name, opts) {
  if (!TABS.includes(name)) name = "books";
  document.body.dataset.tab = name;
  document.querySelectorAll(".tab").forEach((b) => {
    b.classList.toggle("on", b.dataset.tab === name);
  });
  // Tab 模式下折叠头被 CSS 藏了，details 必须显式展开，否则内容区是空的
  if (name === "guide") {
    $("#guidebox").open = true;
    // 导读是只读投影：切到这个 Tab 时刷新一次，看到的就是宿主当前的真实状态
    void loadReading();
  }
  if (name === "marks") $("#annbox").open = true;
  if (name === "search") {
    $("#searchbox").open = true;
    if (opts && opts.focus) setTimeout(() => $("#q").focus(), 0);
  }
  // 告诉父窗口当前 Tab：导读要显示分数、证据和覆盖表，340px 太窄，
  // 父窗口会把左栏放宽（见 src/client/index.jsx）。
  toParent({ type: "apple-read:tab", tab: name });
}

// --------------------------------------------------------------------------- //
// 事件绑定
// --------------------------------------------------------------------------- //

$("#send").addEventListener("click", send);
$("#input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
});
$("#input").addEventListener("input", (e) => {
  const t = e.target;
  t.style.height = "auto";
  t.style.height = Math.min(t.scrollHeight, 160) + "px";
});
$("#filter").addEventListener("input", (e) => { state.filter = e.target.value; renderBooks(); });
$("#doSearch").addEventListener("click", doSearch);
$("#q").addEventListener("keydown", (e) => {
  // isComposing：中文输入法选词时的回车不能当成提交
  if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); doSearch(); }
});
$("#withMarks").addEventListener("change", (e) => {
  state.withMarks = e.target.checked;
  renderAnnotations();
  void persistSettings({ withMarks: state.withMarks });
});
$("#withRerank").addEventListener("change", (e) => {
  state.rerank = e.target.checked;
  void persistSettings({ rerank: state.rerank });
});
$("#openBook").addEventListener("click", openBook);
$("#clearChat").addEventListener("click", () => {
  state.history = [];
  state.focusId = null;
  $("#chat").innerHTML = '<div class="hint">已清空。接着问吧。</div>';
  toast("对话已清空");
});
$("#indexBook").addEventListener("click", async () => {
  if (!state.current) return;
  const btn = $("#indexBook");
  btn.disabled = true;
  btn.textContent = "建索引中…";
  toast("正在建索引，可能要几十秒…");
  try {
    await indexBook(state.current, false);
    renderBooks();
    renderAnnotations();
  } catch (e) {
    toast("建索引失败：" + e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = state.current.indexed ? "重建索引" : "建索引";
  }
});
$("#indexAll").addEventListener("click", indexAll);

// Tab 切换（只在窄栏有意义；宽屏下 Tab 栏被 CSS 隐藏，点了也看不到）
$("#tabs").addEventListener("click", (ev) => {
  const btn = ev.target.closest(".tab");
  if (btn) setTab(btn.dataset.tab, { focus: btn.dataset.tab === "search" });
});
// 窗口在「窄 / 宽」之间变化时，若此刻正停在某个 Tab，重新对齐一次
window.addEventListener("resize", () => {
  if (narrow()) setTab(document.body.dataset.tab || "books");
});
setTab("books");

boot();
