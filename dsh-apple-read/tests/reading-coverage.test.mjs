/**
 * tests/reading-coverage.test.mjs · M3 覆盖账本 / coverage.js
 *
 * ## 这份测试在防什么
 * 覆盖账本最容易出的不是崩溃，而是**看起来很美的假账**：
 *   · 重叠区间被重复计算 ⇒ 分母虚高/分子虚高（PRD :346 点名的一条）
 *   · 「切片完成」被当成「分析完成」（PRD §11.5 :1000）
 *   · 被排除范围被算进「已理解」
 *   · 存在未知部分（无法解析/缺失/图片页）却宣称「全书 100%」
 *   · 抽取层的数据被拿去冒充分析层/阅读层
 *   · 活会话（live，无 revision）被当成耐久来源，水位悄悄前进（M2 判断 3 的后果）
 *   · 长章窗口有洞，或没被真正消费就算处理完
 *
 * ## 每条检查「在什么情况下会失败」
 *   [0]  模块形状      — 状态集合/允许边一旦超出 PRD §11.5 等集就失败
 *   [1]  区间并集      — 改成朴素求和、或合并时不取 max end、或混坐标空间，立刻失败
 *   [2]  单元身份      — 解析/版本/输入变化不换身份，或同输入换身份，立刻失败
 *   [3]  状态机        — 去掉任一守卫（切片冒充分析、无原因排除、无调度重试）立刻失败
 *   [4]  长章窗口      — 窗口出现洞/叠、或未消费就算完成、或失败窗口不入队，立刻失败
 *   [5]  三层账本      — 某层缺数据时回落别层（percent 不为 null）立刻失败
 *   [6]  诚实判定      — 未知部分存在/未知信息缺失时仍给「全书 100%」立刻失败
 *   [7]  输出形状      — coverage 键集合偏离 PRD :311、或 excluded 混进 analyzed，立刻失败
 *   [8]  耐久 resume   — live 被当 ready、requested 超 durable 不挡、reverify 缓存旧结论，立刻失败
 *   [9]  readEventWindow — M2 交接事项 2：补上断言（遮蔽事件不得被自动排除）
 *   [9a] 替身忠实性元检查 — 替身一旦退化（readSurface 含 log-only / readEvent 滤掉 shadowed）必须被识破
 *   [10] 只读与依赖    — 模块引入 fs/宿主依赖、或出现写接口，立刻失败
 *   [11] 无法离线验证  — 显式跳过（三分处理），不算通过
 *
 * 跑法：node tests/reading-coverage.test.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * 被测模块路径可用环境变量覆盖：变异测试把「改坏的副本」写到临时目录，
 * 连同 schema.js 一起放进去（保持相对 import 可解析），**绝不改动仓库里的真文件**。
 */
const COVERAGE_PATH = process.env.READING_COVERAGE ?? join(HERE, "..", "lib", "reading", "coverage.js");

const {
  COVERAGE_VERSION,
  COVERAGE_LAYERS,
  COVERAGE_UNIT_LAYER,
  COVERAGE_UNIT_STATES,
  ALLOWED_UNIT_TRANSITIONS,
  UNIT_TERMINAL_STATES,
  UNKNOWN_KINDS,
  CoverageError,
  normalizeIntervals,
  unionIntervals,
  unionCodepoints,
  intersectIntervals,
  subtractIntervals,
  coverageUnitIdentity,
  makeCoverageUnit,
  transitionUnit,
  shouldRedoUnit,
  unitWindowRange,
  planChapterWindows,
  recordWindowConsumption,
  nextWindowQueue,
  buildLayerLedgers,
  buildCoverageReport,
  planAdvance,
  reverifyResume,
  sourceBlockReason,
} = await import(pathToFileURL(COVERAGE_PATH).href);

const { createSessionReader } = await import(
  pathToFileURL(join(HERE, "..", "lib", "reading", "session-reader.js")).href
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
const skip = (m, why) => { skipped++; console.log("  ⊘ 跳过 " + m + " —— " + why); };
const deep = (label, got, want) =>
  JSON.stringify(got) === JSON.stringify(want)
    ? ok(label)
    : bad(label, `得到 ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}`);

/** 「必须抛指定错误码」的显式断言（抛别的码 = 失败，不是通过）。 */
function expectCode(label, fn, code) {
  try {
    fn();
    bad(label, `本应抛 ${code}，却成功了`);
  } catch (e) {
    if (e instanceof CoverageError && e.code === code) ok(`${label} → ${code}`);
    else bad(label, `抛的是 ${e?.code ?? e?.name}（${e?.message}），期望 ${code}`);
  }
}

// =========================================================================== //
// 夹具
// =========================================================================== //
const CS = { book_version_id: "bv_1", normalization_version: "norm_1" };
const FP = "a".repeat(64);
const FP2 = "b".repeat(64);

function mkUnit(over = {}) {
  return makeCoverageUnit({
    book_id: "book_1",
    book_version_id: "bv_1",
    parser_version: "parser_1",
    normalization_version: "norm_1",
    section_id: "sec_1",
    start_codepoint: 0,
    end_codepoint: 100,
    input_fingerprint: FP,
    ...over,
  });
}

function mkWindowUnit({ section_id = "sec_long", start, end, window_index, fingerprint = FP } = {}) {
  return makeCoverageUnit({
    book_id: "book_1",
    book_version_id: "bv_1",
    parser_version: "parser_1",
    normalization_version: "norm_1",
    section_id,
    window_index,
    start_codepoint: start,
    end_codepoint: end,
    input_fingerprint: fingerprint,
    window: { window_index, start_codepoint: start, end_codepoint: end },
  });
}

const ANALYSIS_OK = { validated: true, layer: "analysis", check_id: "chk_analysis_1" };
const toProcessed = (u, extra = {}) => transitionUnit(u, "processed", { semantic_analysis: { ...ANALYSIS_OK }, ...extra });
const toFailed = (u, code = "MODEL_TIMEOUT") => transitionUnit(u, "failed", { failure: { code } });
const toExcluded = (u, reason = "过渡性内容，无候选价值") => transitionUnit(u, "excluded", { exclusion: { reason } });
const okUnit = (r) => {
  if (!r.ok) throw new Error(`夹具转换失败：${JSON.stringify(r.errors)}`);
  return r.unit;
};

/** 每个「允许边」需要的最小合法选项；用来做 4×4 等集矩阵。 */
function validOptionsFor(from, to) {
  if (to === "processed") return { semantic_analysis: { ...ANALYSIS_OK } };
  if (to === "failed") return { failure: { code: "MODEL_TIMEOUT" } };
  if (to === "excluded") return { exclusion: { reason: "明确原因：与本次阅读目标无关" } };
  if (to === "pending") return { schedule: { scheduled_by: "user", reason: "用户要求重试" } };
  return {};
}

// =========================================================================== //
console.log("\n[0] 模块形状与 PRD §11.5 等集");

{
  is("模块版本存在", typeof COVERAGE_VERSION, "string");
  is("三层恰好三个", COVERAGE_LAYERS.join(","), "extraction,analysis,reading");
  is("CoverageUnit 只属于分析层", COVERAGE_UNIT_LAYER, "analysis");
  is("单元状态恰好四个", [...COVERAGE_UNIT_STATES].sort().join(","), "excluded,failed,pending,processed");
  is("初始状态 pending", mkUnit().state, "pending");
  is("本身份内终态只有 processed", UNIT_TERMINAL_STATES.join(","), "processed");
  is("未知部分三类与 PRD :346 对齐", UNKNOWN_KINDS.join(","), "unparseable,missing,image_page");

  // 允许边**等集**（不多不少）
  const PRD_EDGES = {
    pending: ["processed", "failed", "excluded"],
    processed: [],
    failed: ["pending"],
    excluded: ["pending"],
  };
  is("状态集合恰好四个", Object.keys(ALLOWED_UNIT_TRANSITIONS).sort().join(","), "excluded,failed,pending,processed");
  for (const [s, edges] of Object.entries(PRD_EDGES)) {
    is(`${s} 的出边与 PRD 等集`, [...ALLOWED_UNIT_TRANSITIONS[s]].sort().join(","), [...edges].sort().join(","));
  }
  truthy("ALLOWED_UNIT_TRANSITIONS 是冻结的（防运行期被改宽）", Object.isFrozen(ALLOWED_UNIT_TRANSITIONS));
  truthy("每条出边数组也是冻结的", Object.values(ALLOWED_UNIT_TRANSITIONS).every((e) => Object.isFrozen(e)));

  // 4×4 全矩阵：允许的能过、不允许的必拒
  for (const from of COVERAGE_UNIT_STATES) {
    for (const to of COVERAGE_UNIT_STATES) {
      const allowed = PRD_EDGES[from].includes(to);
      const res = transitionUnit({ ...mkUnit(), state: from }, to, validOptionsFor(from, to));
      is(`PRD 等集：${from} → ${to} ${allowed ? "允许" : "拒绝"}`, res.ok, allowed);
      if (!allowed) {
        is(`  ↳ ${from} → ${to} 错误码`, res.errors[0]?.code, "INVALID_TRANSITION");
      }
    }
  }
}

// =========================================================================== //
console.log("\n[1] 区间并集：重叠不重复计算（PRD :346）");

{
  const overlap = [{ start_codepoint: 0, end_codepoint: 10 }, { start_codepoint: 5, end_codepoint: 15 }];
  const naive = overlap.reduce((n, iv) => n + (iv.end_codepoint - iv.start_codepoint), 0);
  is("反例前提：朴素求和会重复计算", naive, 20);
  is("并集计数去重（重叠只算一次）", unionCodepoints(overlap), 15);
  isNot("并集计数不得等于朴素求和", unionCodepoints(overlap), naive);
  deep("并集把重叠合成一段", unionIntervals(overlap), [{ start_codepoint: 0, end_codepoint: 15 }]);

  is("完全相同的区间只算一次", unionCodepoints([overlap[0], { ...overlap[0] }]), 10);
  is("被包含的区间不增加计数", unionCodepoints([{ start_codepoint: 0, end_codepoint: 10 }, { start_codepoint: 2, end_codepoint: 4 }]), 10);
  deep("嵌套时合并必须取 max end", unionIntervals([{ start_codepoint: 0, end_codepoint: 10 }, { start_codepoint: 2, end_codepoint: 4 }]), [{ start_codepoint: 0, end_codepoint: 10 }]);
  is("相邻区间合并", unionCodepoints([{ start_codepoint: 0, end_codepoint: 10 }, { start_codepoint: 10, end_codepoint: 20 }]), 20);
  is("空数组是 0（真值，不是未知）", unionCodepoints([]), 0);
  is("三段互相重叠", unionCodepoints([
    { start_codepoint: 0, end_codepoint: 10 },
    { start_codepoint: 5, end_codepoint: 20 },
    { start_codepoint: 18, end_codepoint: 30 },
  ]), 30);

  // 非法输入必须抛错，不静默修正
  expectCode("start >= end 抛错", () => unionIntervals([{ start_codepoint: 5, end_codepoint: 5 }]), "INVALID_RANGE");
  expectCode("负数起点抛错", () => unionIntervals([{ start_codepoint: -1, end_codepoint: 5 }]), "INVALID_VALUE");
  expectCode("非整数抛错", () => unionIntervals([{ start_codepoint: 0.5, end_codepoint: 5 }]), "INVALID_VALUE");
  expectCode("非数组抛错", () => unionIntervals(null), "INVALID_ARGUMENT");
  expectCode("混坐标空间必须抛错", () => unionIntervals([
    { start_codepoint: 0, end_codepoint: 10, coordinate_space: { book_version_id: "bv_1", normalization_version: "n1" } },
    { start_codepoint: 5, end_codepoint: 15, coordinate_space: { book_version_id: "bv_1", normalization_version: "n2" } },
  ]), "COORDINATE_SPACE_MISMATCH");
  // 同一坐标空间不抛
  try {
    unionIntervals([
      { start_codepoint: 0, end_codepoint: 10, coordinate_space: { book_version_id: "bv_1", normalization_version: "n1" } },
      { start_codepoint: 5, end_codepoint: 15, coordinate_space: { book_version_id: "bv_1", normalization_version: "n1" } },
    ]);
    ok("同一坐标空间可求并集");
  } catch (e) {
    bad("同一坐标空间可求并集", `不该抛：${e.message}`);
  }

  // 交集/差集
  deep("交集", intersectIntervals([{ start_codepoint: 0, end_codepoint: 10 }], [{ start_codepoint: 5, end_codepoint: 20 }]), [{ start_codepoint: 5, end_codepoint: 10 }]);
  deep("差集（中间挖洞）", subtractIntervals([{ start_codepoint: 0, end_codepoint: 100 }], [{ start_codepoint: 20, end_codepoint: 30 }]), [
    { start_codepoint: 0, end_codepoint: 20 },
    { start_codepoint: 30, end_codepoint: 100 },
  ]);
  is("差集计数", unionCodepoints(subtractIntervals([{ start_codepoint: 0, end_codepoint: 100 }], [{ start_codepoint: 20, end_codepoint: 30 }])), 90);
  deep("不相交的交集为空", intersectIntervals([{ start_codepoint: 0, end_codepoint: 10 }], [{ start_codepoint: 20, end_codepoint: 30 }]), []);
}

// =========================================================================== //
console.log("\n[2] 单元身份：同版本同输入不重做，解析/版本变化换身份");

{
  const base = {
    book_id: "book_1", book_version_id: "bv_1", parser_version: "parser_1",
    normalization_version: "norm_1", section_id: "sec_1",
    start_codepoint: 0, end_codepoint: 100, input_fingerprint: FP,
  };
  const idOf = (over) => coverageUnitIdentity({ ...base, ...over }).unit_id;
  const id0 = idOf({});

  is("同输入同身份", idOf({}), id0);
  truthy("身份是 64 位 hex", /^[0-9a-f]{64}$/.test(id0));
  isNot("解析器版本变化 ⇒ 新身份", idOf({ parser_version: "parser_2" }), id0);
  isNot("归一化版本变化 ⇒ 新身份", idOf({ normalization_version: "norm_2" }), id0);
  isNot("书版本变化 ⇒ 新身份", idOf({ book_version_id: "bv_2" }), id0);
  isNot("输入指纹变化 ⇒ 新身份", idOf({ input_fingerprint: FP2 }), id0);
  isNot("范围变化 ⇒ 新身份", idOf({ end_codepoint: 101 }), id0);
  isNot("章节变化 ⇒ 新身份", idOf({ section_id: "sec_2" }), id0);
  isNot("窗口序号变化 ⇒ 新身份", idOf({ window_index: 0 }), idOf({ window_index: 1 }));

  expectCode("缺 input_fingerprint 抛错", () => coverageUnitIdentity({ ...base, input_fingerprint: "" }), "INVALID_ARGUMENT");
  expectCode("非法范围抛错", () => coverageUnitIdentity({ ...base, start_codepoint: 10, end_codepoint: 10 }), "INVALID_RANGE");

  // shouldRedoUnit
  const processed = okUnit(toProcessed(mkUnit()));
  const r1 = shouldRedoUnit(processed, base);
  is("同身份已 processed ⇒ 不重做", r1.redo, false);
  is("不重做的原因", r1.reason, "ALREADY_PROCESSED_SAME_INPUT");

  const pending = mkUnit();
  const r2 = shouldRedoUnit(pending, base);
  is("同身份仍 pending ⇒ 要处理", r2.redo, true);
  is("pending 不需要调度", r2.requires_schedule, false);

  const r3 = shouldRedoUnit(processed, { ...base, parser_version: "parser_2" });
  is("解析器变化 ⇒ 重做且是新身份", r3.redo, true);
  is("新身份标记", r3.new_identity, true);
  is("新身份原因", r3.reason, "NEW_UNIT_IDENTITY");
  isNot("新身份 id 与旧不同", r3.unit_id, processed.unit_id);

  const failed = okUnit(toFailed(mkUnit()));
  const r4 = shouldRedoUnit(failed, base);
  is("failed 同身份 ⇒ 重做", r4.redo, true);
  is("failed 重做必须显式调度", r4.requires_schedule, true);
  const excluded = okUnit(toExcluded(mkUnit()));
  const r5 = shouldRedoUnit(excluded, base);
  is("excluded 同身份 ⇒ 重做", r5.redo, true);
  is("excluded 重做必须显式调度", r5.requires_schedule, true);

  const r6 = shouldRedoUnit(null, base);
  is("没有既有单元 ⇒ 首次处理", r6.reason, "NO_EXISTING_UNIT");
  is("首次处理不是新身份", r6.new_identity, false);
}

// =========================================================================== //
console.log("\n[3] 状态机守卫（PRD §11.5 :1000）");

{
  // —— processed 必须语义分析通过校验 ——
  const u0 = mkUnit();
  const sliceOnly = transitionUnit(u0, "processed", { extraction_receipt: { ok: true, covered_codepoints: 100 } });
  is("只有切片回执 ⇒ 拒绝", sliceOnly.ok, false);
  is("切片冒充分析的错误码", sliceOnly.errors[0]?.code, "EXTRACTION_IS_NOT_ANALYSIS");

  const noReceipt = transitionUnit(u0, "processed", {});
  is("无回执 ⇒ 拒绝", noReceipt.ok, false);
  is("无回执错误码", noReceipt.errors[0]?.code, "SEMANTIC_ANALYSIS_NOT_PASSED");

  const notValidated = transitionUnit(u0, "processed", { semantic_analysis: { validated: false, layer: "analysis", check_id: "c" } });
  is("未通过校验 ⇒ 拒绝", notValidated.ok, false);
  const wrongLayer = transitionUnit(u0, "processed", { semantic_analysis: { validated: true, layer: "extraction", check_id: "c" } });
  is("拿抽取层回执冒充分析层 ⇒ 拒绝", wrongLayer.ok, false);
  const noCheckId = transitionUnit(u0, "processed", { semantic_analysis: { validated: true, layer: "analysis" } });
  is("无 check_id ⇒ 拒绝", noCheckId.ok, false);

  const good = toProcessed(u0);
  is("语义分析通过 ⇒ 允许", good.ok, true);
  is("processed 计入已分析", good.unit.counts_as_analyzed, true);
  is("processed **不**计入已理解", good.unit.counts_as_understood, false);
  is("processed 是终态：无出边", ALLOWED_UNIT_TRANSITIONS.processed.length, 0);
  is("processed 的语义分析回执被留存", good.unit.semantic_analysis_receipt.check_id, "chk_analysis_1");
  is("转换进历史", good.unit.history.length, 1);
  is("历史记录 from/to", `${good.unit.history[0].from}→${good.unit.history[0].to}`, "pending→processed");

  // —— failed ——
  const noReason = transitionUnit(mkUnit(), "failed", {});
  is("failed 无原因码 ⇒ 拒绝", noReason.ok, false);
  is("failed 错误码", noReason.errors[0]?.code, "FAILURE_REASON_REQUIRED");
  const failed = toFailed(mkUnit(), "MODEL_TIMEOUT");
  is("failed 允许", failed.ok, true);
  is("failed 仍可报告部分成果（PRD :1000）", failed.effects.task_may_report_partial_results, true);
  is("failed 不计入已分析", failed.unit.counts_as_analyzed, false);
  is("failed 不计入已理解", failed.unit.counts_as_understood, false);

  // —— excluded ——
  const noExReason = transitionUnit(mkUnit(), "excluded", { exclusion: {} });
  is("excluded 无原因 ⇒ 拒绝", noExReason.ok, false);
  is("excluded 无原因错误码", noExReason.errors[0]?.code, "EXCLUSION_REASON_REQUIRED");
  const vacuous = transitionUnit(mkUnit(), "excluded", { exclusion: { reason: "未知" } });
  is("空话原因 ⇒ 拒绝", vacuous.ok, false);
  is("空话原因错误码", vacuous.errors[0]?.code, "EXCLUSION_REASON_VACUOUS");
  const excluded = toExcluded(mkUnit(), "过渡性内容，无候选价值");
  is("excluded 允许", excluded.ok, true);
  is("excluded 必须带原因", excluded.unit.exclusion.reason, "过渡性内容，无候选价值");
  is("excluded 不计作理解完成", excluded.unit.counts_as_understood, false);
  is("excluded 不计入已分析", excluded.unit.counts_as_analyzed, false);
  is("excluded 的 effects 明确不计理解", excluded.effects.counts_as_understood, false);

  // —— 重试/改变排除范围必须显式调度 ——
  const noSchedule = transitionUnit(failed.unit, "pending", {});
  is("failed→pending 无调度 ⇒ 拒绝", noSchedule.ok, false);
  is("无调度错误码", noSchedule.errors[0]?.code, "RETRY_REQUIRES_EXPLICIT_SCHEDULE");
  const halfSchedule = transitionUnit(failed.unit, "pending", { schedule: { scheduled_by: "user" } });
  is("调度缺 reason ⇒ 拒绝", halfSchedule.ok, false);
  const requeued = transitionUnit(failed.unit, "pending", { schedule: { scheduled_by: "user", reason: "用户要求重试" } });
  is("显式调度 ⇒ 回到 pending", requeued.ok, true);
  is("回到 pending 后失败信息清空", requeued.unit.failure, null);
  is("requeue 标记", requeued.effects.requeued, true);
  is("重试历史被保留（含调度者）", requeued.unit.history.at(-1).schedule.scheduled_by, "user");

  const noSchedule2 = transitionUnit(excluded.unit, "pending", {});
  is("excluded→pending 无调度 ⇒ 拒绝", noSchedule2.ok, false);
  const requeued2 = transitionUnit(excluded.unit, "pending", { schedule: { scheduled_by: "user", reason: "改变排除范围" } });
  is("改变排除范围需显式调度 ⇒ 允许", requeued2.ok, true);
  is("原排除原因仍在历史里", requeued2.unit.history.at(-1).exclusion_reason, "过渡性内容，无候选价值");

  // —— 非法状态 ——
  const badState = transitionUnit({ ...mkUnit(), state: "done" }, "processed", { semantic_analysis: ANALYSIS_OK });
  is("未知当前状态 ⇒ 拒绝", badState.ok, false);
  is("未知状态错误码", badState.errors[0]?.code, "INVALID_STATE");
  const badNext = transitionUnit(mkUnit(), "done", {});
  is("未知目标状态 ⇒ 拒绝", badNext.ok, false);

  // 任何状态下 counts_as_understood 都不能为真
  for (const u of [mkUnit(), okUnit(toProcessed(mkUnit())), failed.unit, excluded.unit]) {
    is(`状态 ${u.state} 的 counts_as_understood 恒为 false`, u.counts_as_understood, false);
  }
}

// =========================================================================== //
console.log("\n[4] 长章连续窗口（PRD :247）");

{
  // 防御式调用：变异若让计划生成抛错，这里要产出**可定位的 ✗**，
  // 而不是把整个套件打崩成「exit 1 但零条 ✗」（M2 踩过的坑）。
  const safePlan = (args) => {
    try {
      return { ok: true, plan: planChapterWindows(args) };
    } catch (e) {
      return { ok: false, error: e };
    }
  };

  const got = safePlan({ section_id: "sec_long", start_codepoint: 0, end_codepoint: 250, max_window_codepoints: 100 });
  is("窗口计划可生成（不得抛错）", got.ok, true);
  const plan = got.ok ? got.plan : { windows: [], window_count: null, total_codepoints: null, contiguous: null };

  is("窗口数", plan.window_count, 3);
  is("总长等于章节长", plan.total_codepoints, 250);
  is("连续", plan.contiguous, true);
  deep("窗口切分", plan.windows, [
    { window_index: 0, start_codepoint: 0, end_codepoint: 100 },
    { window_index: 1, start_codepoint: 100, end_codepoint: 200 },
    { window_index: 2, start_codepoint: 200, end_codepoint: 250 },
  ]);
  truthy("每个窗口不超过上限", plan.windows.every((w) => w.end_codepoint - w.start_codepoint <= 100));
  is("窗口并集覆盖整章（无洞无叠）", unionCodepoints(plan.windows), 250);
  // 首尾相接
  truthy("窗口首尾相接", plan.windows.every((w, i) => i === 0 || w.start_codepoint === plan.windows[i - 1].end_codepoint));

  const singleGot = safePlan({ section_id: "s", start_codepoint: 0, end_codepoint: 50, max_window_codepoints: 100 });
  is("短章计划可生成", singleGot.ok, true);
  const single = singleGot.ok ? singleGot.plan : { window_count: null, windows: [] };
  is("短章一个窗口", single.window_count, 1);
  is("短章窗口覆盖全章", single.windows[0]?.end_codepoint, 50);

  const exactGot = safePlan({ section_id: "s", start_codepoint: 0, end_codepoint: 200, max_window_codepoints: 100 });
  is("整除计划可生成", exactGot.ok, true);
  is("整除时不多出空窗口", exactGot.ok ? exactGot.plan.window_count : null, 2);

  expectCode("窗口上限非正 ⇒ 抛错", () => planChapterWindows({ section_id: "s", start_codepoint: 0, end_codepoint: 10, max_window_codepoints: 0 }), "INVALID_ARGUMENT");
  expectCode("章节范围非法 ⇒ 抛错", () => planChapterWindows({ section_id: "s", start_codepoint: 10, end_codepoint: 10, max_window_codepoints: 5 }), "INVALID_RANGE");
  expectCode("缺 section_id ⇒ 抛错", () => planChapterWindows({ start_codepoint: 0, end_codepoint: 10, max_window_codepoints: 5 }), "INVALID_ARGUMENT");

  // —— 真正消费 ——
  const w = mkWindowUnit({ start: 100, end: 200, window_index: 1 });
  const noReceipt = recordWindowConsumption(w, {});
  is("无消费回执 ⇒ consumed=false", noReceipt.consumed, false);
  is("无回执原因", noReceipt.reason, "NO_CONSUMPTION_RECEIPT");
  is("无回执时缺口等于整个窗口", noReceipt.missing_codepoints, 100);

  const unverified = recordWindowConsumption(w, { truly_consumed: true });
  is("无证据 ⇒ consumed=false", unverified.consumed, false);
  is("无证据原因", unverified.reason, "CONSUMPTION_UNVERIFIED");

  const partial = recordWindowConsumption(w, { truly_consumed: true, check_id: "c1", evidence_ref: "resp_1", consumed_ranges: [{ start_codepoint: 100, end_codepoint: 150 }] });
  is("只消费一半 ⇒ consumed=false", partial.consumed, false);
  is("部分消费原因", partial.reason, "WINDOW_PARTIALLY_CONSUMED");
  is("部分消费缺口", partial.missing_codepoints, 50);
  deep("缺口范围", partial.missing_ranges, [{ start_codepoint: 150, end_codepoint: 200 }]);

  const full = recordWindowConsumption(w, { truly_consumed: true, check_id: "c1", evidence_ref: "resp_1", consumed_ranges: [{ start_codepoint: 100, end_codepoint: 200 }] });
  is("完整消费 ⇒ consumed=true", full.consumed, true);
  is("完整消费原因", full.reason, "FULLY_CONSUMED");
  is("完整消费缺口为 0", full.missing_codepoints, 0);

  // —— 窗口单元的 processed 守卫 ——
  const wu = mkWindowUnit({ start: 0, end: 100, window_index: 0 });
  const noConsumed = transitionUnit(wu, "processed", { semantic_analysis: { ...ANALYSIS_OK } });
  is("窗口无消费范围 ⇒ 拒绝 processed", noConsumed.ok, false);
  is("窗口未消费错误码", noConsumed.errors[0]?.code, "WINDOW_NOT_CONSUMED");
  const partialConsumed = transitionUnit(wu, "processed", { semantic_analysis: { ...ANALYSIS_OK, consumed_ranges: [{ start_codepoint: 0, end_codepoint: 60 }] } });
  is("窗口只消费一部分 ⇒ 拒绝 processed", partialConsumed.ok, false);
  is("窗口部分分析错误码", partialConsumed.errors[0]?.code, "WINDOW_PARTIALLY_ANALYZED");
  const fullConsumed = transitionUnit(wu, "processed", { semantic_analysis: { ...ANALYSIS_OK, consumed_ranges: [{ start_codepoint: 0, end_codepoint: 100 }] } });
  is("窗口完整消费 ⇒ 允许 processed", fullConsumed.ok, true);

  // —— 失败窗口继续排队 ——
  const units = [
    okUnit(fullConsumed),
    okUnit(toFailed(mkWindowUnit({ start: 100, end: 200, window_index: 1 }), "MODEL_TIMEOUT")),
    mkWindowUnit({ start: 200, end: 300, window_index: 2 }),
    okUnit(toExcluded(mkWindowUnit({ start: 300, end: 400, window_index: 3 }), "附录，非正文")),
  ];
  const q = nextWindowQueue(units);
  is("队列含 pending 窗口", q.queue.some((x) => x.reason === "PENDING"), true);
  is("失败窗口继续排队（PRD :247）", q.failed_still_queued, 1);
  is("失败窗口在队列里且要求调度", q.queue.find((x) => x.reason === "FAILED_STILL_QUEUED")?.requires_schedule, true);
  is("processed 不在队列", q.done.length, 1);
  is("excluded 不入队", q.excluded.length, 1);
  is("队列总数 = pending + failed", q.queue.length, 2);

  // unitWindowRange
  deep("窗口范围取自 window", unitWindowRange(w), { start_codepoint: 100, end_codepoint: 200 });
  deep("非窗口单元范围取自身", unitWindowRange(mkUnit()), { start_codepoint: 0, end_codepoint: 100 });
}

// =========================================================================== //
console.log("\n[5] 三层账本：不互相冒充");

{
  const discovered = [
    { start_codepoint: 0, end_codepoint: 400 },
    { start_codepoint: 100, end_codepoint: 200 }, // 重叠诱饵
  ];
  const extracted = [{ start_codepoint: 0, end_codepoint: 300 }];
  const read = [{ start_codepoint: 0, end_codepoint: 50 }];
  const units = [
    okUnit(toProcessed(mkUnit({ start_codepoint: 0, end_codepoint: 100 }))),
    okUnit(toExcluded(mkUnit({ start_codepoint: 100, end_codepoint: 200 }), "过渡性内容")),
    okUnit(toFailed(mkUnit({ start_codepoint: 200, end_codepoint: 300 }))),
    mkUnit({ start_codepoint: 300, end_codepoint: 400 }),
  ];

  const L = buildLayerLedgers({ coordinate_space: CS, discovered_body: discovered, extracted_body: extracted, read_body: read, units });
  is("分母是并集（重叠去重）", L.denominator.codepoints, 400);
  is("抽取层分子", L.extraction.covered_codepoints, 300);
  is("抽取层百分比", L.extraction.percent, 75);
  is("分析层分子只来自 processed 单元", L.analysis.covered_codepoints, 100);
  is("分析层分母是已解析正文（不是全书）", L.analysis.denominator_codepoints, 400);
  is("分析层百分比", L.analysis.percent, 25);
  is("excluded 单元不计入分析覆盖", L.analysis.covered_codepoints, 100);
  is("分析层分子来源写明", L.analysis.numerator_source, "processed_coverage_units_only");
  is("阅读层分子", L.reading.covered_codepoints, 50);
  is("阅读层百分比", L.reading.percent, 12.5);
  is("三层分母一致（同一已解析正文）", `${L.extraction.denominator_codepoints},${L.analysis.denominator_codepoints},${L.reading.denominator_codepoints}`, "400,400,400");

  // —— 缺数据 ⇒ null，不得回落到别层 ——
  const onlyExtraction = buildLayerLedgers({ coordinate_space: CS, discovered_body: discovered, extracted_body: extracted });
  is("只有抽取数据：抽取层 known", onlyExtraction.extraction.known, true);
  is("只有抽取数据：分析层 known=false", onlyExtraction.analysis.known, false);
  is("只有抽取数据：分析层 percent=null（不得回落）", onlyExtraction.analysis.percent, null);
  is("只有抽取数据：分析层原因", onlyExtraction.analysis.reason, "NO_LAYER_INPUT");
  is("只有抽取数据：阅读层 percent=null", onlyExtraction.reading.percent, null);

  const onlyRead = buildLayerLedgers({ coordinate_space: CS, discovered_body: discovered, read_body: read });
  is("只有阅读数据：抽取层 percent=null", onlyRead.extraction.percent, null);
  is("只有阅读数据：分析层 percent=null", onlyRead.analysis.percent, null);
  is("只有阅读数据：阅读层 known", onlyRead.reading.known, true);

  const onlyUnits = buildLayerLedgers({ coordinate_space: CS, discovered_body: discovered, units });
  is("只有单元数据：抽取层 percent=null", onlyUnits.extraction.percent, null);
  is("只有单元数据：分析层 known", onlyUnits.analysis.known, true);

  // —— 超出分母的部分被裁掉并单列，不静默并进分子 ——
  const overshoot = buildLayerLedgers({ coordinate_space: CS, discovered_body: [{ start_codepoint: 0, end_codepoint: 100 }], extracted_body: [{ start_codepoint: 0, end_codepoint: 300 }] });
  is("超出已解析正文的部分不计入分子", overshoot.extraction.covered_codepoints, 100);
  is("超出部分单列", overshoot.extraction.out_of_scope_codepoints, 200);
  is("分子不得超过分母", overshoot.extraction.percent, 100);

  // —— 分母为空 ⇒ percent 为 null（未知），不是 0 也不是 100 ——
  const empty = buildLayerLedgers({ coordinate_space: CS, discovered_body: [], extracted_body: [] });
  is("空分母 percent=null", empty.extraction.percent, null);
  is("空分母原因", empty.extraction.reason, "EMPTY_DENOMINATOR");
}

// =========================================================================== //
console.log("\n[6] 诚实判定：未知部分与「全书 100%」");

{
  const ZERO_UNKNOWN = {
    unparseable: { count: 0, codepoints: 0 },
    missing: { count: 0, codepoints: 0 },
    image_page: { count: 0, codepoints: 0 },
    ratio_known: true,
  };

  // 反例 1：已解析正文 100%，但存在图片页 ⇒ 不得宣称全书 100%
  const withImages = buildCoverageReport({
    coordinate_space: CS,
    discovered_body: [{ start_codepoint: 0, end_codepoint: 100 }],
    extracted_body: [{ start_codepoint: 0, end_codepoint: 100 }],
    units: [okUnit(toProcessed(mkUnit({ start_codepoint: 0, end_codepoint: 100 })))],
    unknown: { ...ZERO_UNKNOWN, image_page: { count: 2, codepoints: 0 } },
  });
  is("已解析正文抽取 100%", withImages.layers.extraction.percent, 100);
  is("已解析正文分析 100%", withImages.layers.analysis.percent, 100);
  is("存在图片页 ⇒ 不得宣称全书 100%", withImages.honesty.whole_book_claim_allowed, false);
  is("存在图片页 ⇒ 全书百分比必须为 null", withImages.honesty.whole_book_percent, null);
  is("存在图片页 ⇒ extraction_complete 也不许", withImages.claims.extraction_complete.allowed, false);
  is("存在图片页 ⇒ analysis_complete 也不许", withImages.claims.analysis_complete.allowed, false);
  truthy("诚实原因里写明未知部分", withImages.honesty.reasons.some((r) => r.includes("不得宣称")));

  // 对照：未知部分全为零且占比可知 ⇒ 允许
  const clean = buildCoverageReport({
    coordinate_space: CS,
    discovered_body: [{ start_codepoint: 0, end_codepoint: 100 }],
    extracted_body: [{ start_codepoint: 0, end_codepoint: 100 }],
    units: [okUnit(toProcessed(mkUnit({ start_codepoint: 0, end_codepoint: 100 })))],
    unknown: ZERO_UNKNOWN,
  });
  is("未知为零 ⇒ 可宣称全书（抽取层）", clean.honesty.whole_book_claim_allowed, true);
  is("未知为零 ⇒ 全书百分比 100", clean.honesty.whole_book_percent, 100);

  // 反例 2：压根没给未知信息 ⇒ 不得宣称
  const noUnknownInfo = buildCoverageReport({
    coordinate_space: CS,
    discovered_body: [{ start_codepoint: 0, end_codepoint: 100 }],
    extracted_body: [{ start_codepoint: 0, end_codepoint: 100 }],
  });
  is("未知信息缺失 ⇒ 数量未知", noUnknownInfo.unknown.counts_known, false);
  is("未知信息缺失 ⇒ 不得宣称全书 100%", noUnknownInfo.honesty.whole_book_claim_allowed, false);
  is("未知信息缺失 ⇒ 全书百分比 null", noUnknownInfo.honesty.whole_book_percent, null);
  truthy("并说明原因", noUnknownInfo.honesty.reasons.some((r) => r.includes("数量未知")));

  // 反例 3：数量已知但占比不可知 ⇒ 不得给百分比
  const ratioUnknown = buildCoverageReport({
    coordinate_space: CS,
    discovered_body: [{ start_codepoint: 0, end_codepoint: 100 }],
    extracted_body: [{ start_codepoint: 0, end_codepoint: 100 }],
    unknown: { unparseable: { count: 3 }, missing: { count: 0 }, image_page: { count: 0 }, ratio_known: false },
  });
  is("占比不可知 ⇒ ratio_known=false", ratioUnknown.unknown.ratio_known, false);
  is("占比不可知 ⇒ 不得宣称", ratioUnknown.honesty.whole_book_claim_allowed, false);
  is("占比不可知 ⇒ 百分比 null", ratioUnknown.honesty.whole_book_percent, null);
  is("无法解析的字符数未知 ⇒ codepoints=null", ratioUnknown.unknown.codepoints, null);

  // 三类未知分别列出
  const kinds = buildCoverageReport({
    coordinate_space: CS,
    discovered_body: [{ start_codepoint: 0, end_codepoint: 100 }],
    unknown: {
      unparseable: { count: 2, codepoints: 40, reason: "编码损坏" },
      missing: { count: 1, codepoints: 10, reason: "manifest 缺文件" },
      image_page: { count: 5, codepoints: 0, reason: "整页为图" },
      ratio_known: true,
      total_book_codepoints: 500,
    },
  });
  is("无法解析数量", kinds.unknown.kinds.unparseable.count, 2);
  is("缺失数量", kinds.unknown.kinds.missing.count, 1);
  is("图片页数量", kinds.unknown.kinds.image_page.count, 5);
  is("未知总项数", kinds.unknown.total_count, 8);
  is("未知总字符数", kinds.unknown.codepoints, 50);
  is("占比是否可知被如实报告", kinds.unknown.ratio_known, true);
  is("未知原因被保留", kinds.unknown.reasons.length, 3);
  is("总数已知 ⇒ counts_known", kinds.unknown.counts_known, true);

  // 铁律：book_understood 恒为 false（四种情形）
  const scenarios = [
    ["全零未知+全覆盖", clean],
    ["有未知", withImages],
    ["无未知信息", noUnknownInfo],
    ["无任何层数据", buildCoverageReport({ coordinate_space: CS, discovered_body: [{ start_codepoint: 0, end_codepoint: 10 }] })],
  ];
  for (const [name, rep] of scenarios) {
    is(`${name}：claims.book_understood.allowed 恒为 false`, rep.claims.book_understood.allowed, false);
    truthy(`${name}：并给出理由`, typeof rep.claims.book_understood.reason === "string" && rep.claims.book_understood.reason.length > 0);
  }
  // 三层不互冒充：只有抽取数据时不得说分析完成
  is("只有抽取数据 ⇒ analysis_complete=false", noUnknownInfo.claims.analysis_complete.allowed, false);
  truthy("并指出不得用抽取层顶替", noUnknownInfo.claims.analysis_complete.reason.includes("分析层无数据"));
}

// =========================================================================== //
console.log("\n[7] 输出形状与 missing_sections（PRD :311）");

{
  const units = [
    okUnit(toProcessed(mkUnit({ section_id: "sec_a", start_codepoint: 0, end_codepoint: 100 }))),
    okUnit(toFailed(mkUnit({ section_id: "sec_b", start_codepoint: 100, end_codepoint: 200 }))),
    okUnit(toExcluded(mkUnit({ section_id: "sec_c", start_codepoint: 200, end_codepoint: 300 }), "过渡")),
    mkUnit({ section_id: "sec_d", start_codepoint: 300, end_codepoint: 400 }),
  ];
  const rep = buildCoverageReport({
    coordinate_space: CS,
    discovered_body: [{ start_codepoint: 0, end_codepoint: 400 }],
    extracted_body: [{ start_codepoint: 0, end_codepoint: 400 }],
    read_body: [{ start_codepoint: 0, end_codepoint: 100 }],
    units,
    sections: [
      { section_id: "sec_a", ranges: [{ start_codepoint: 0, end_codepoint: 100 }] },
      { section_id: "sec_b", ranges: [{ start_codepoint: 100, end_codepoint: 200 }] },
      { section_id: "sec_c", ranges: [{ start_codepoint: 200, end_codepoint: 300 }] },
      { section_id: "sec_d", ranges: [{ start_codepoint: 300, end_codepoint: 400 }] },
      { section_id: "sec_e", ranges: [{ start_codepoint: 400, end_codepoint: 500 }] },
    ],
    unknown: { unparseable: { count: 0, codepoints: 0 }, missing: { count: 0, codepoints: 0 }, image_page: { count: 0, codepoints: 0 }, ratio_known: true },
  });

  // 键集合**恰好**是 PRD :311 的五个
  is("coverage 键集合恰好五个", Object.keys(rep.coverage).join(","), "scope,missing_sections,analyzed_units,total_units,excluded_units");
  is("scope 固定为 parsed_body", rep.coverage.scope, "parsed_body");
  is("analyzed_units = processed 数", rep.coverage.analyzed_units, 1);
  is("total_units = 全部单元数", rep.coverage.total_units, 4);
  is("excluded_units = excluded 数", rep.coverage.excluded_units, 1);
  is("excluded 不得混进 analyzed_units", rep.coverage.analyzed_units, 1);
  truthy("missing_sections 是数组", Array.isArray(rep.coverage.missing_sections));

  // missing_sections：只有 sec_a 有分析覆盖
  const ids = rep.coverage.missing_sections.map((m) => m.section_id).sort().join(",");
  is("缺的章节恰好是 b/c/d/e", ids, "sec_b,sec_c,sec_d,sec_e");
  is("失败章节的原因", rep.coverage.missing_sections.find((m) => m.section_id === "sec_b")?.reason, "ALL_UNITS_FAILED");
  is("排除章节的原因", rep.coverage.missing_sections.find((m) => m.section_id === "sec_c")?.reason, "ALL_UNITS_EXCLUDED");
  is("有单元但都没过的原因", rep.coverage.missing_sections.find((m) => m.section_id === "sec_d")?.reason, "NO_PROCESSED_UNIT");
  is("无单元章节的原因", rep.coverage.missing_sections.find((m) => m.section_id === "sec_e")?.reason, "NO_ANALYZED_UNIT");
  falsy("已覆盖章节不在缺口里", rep.coverage.missing_sections.some((m) => m.section_id === "sec_a"));

  // 单元计数
  is("单元计数：processed", rep.units.processed, 1);
  is("单元计数：failed", rep.units.failed, 1);
  is("单元计数：excluded", rep.units.excluded, 1);
  is("单元计数：pending", rep.units.pending, 1);
  is("counts_as_analyzed 等于 processed", rep.units.counts_as_analyzed, 1);
  is("counts_as_understood 恒为 0", rep.units.counts_as_understood, 0);
  is("部分成果仍可报告", rep.units.partial_results_reportable, true);
  is("partial.has_failures", rep.partial.has_failures, true);
  is("partial.has_exclusions", rep.partial.has_exclusions, true);

  // 分析层无数据时：missing_sections 未知（空数组 ≠ 没有缺口）
  const unknownAnalysis = buildCoverageReport({
    coordinate_space: CS,
    discovered_body: [{ start_codepoint: 0, end_codepoint: 400 }],
    extracted_body: [{ start_codepoint: 0, end_codepoint: 400 }],
    sections: [{ section_id: "sec_a", ranges: [{ start_codepoint: 0, end_codepoint: 100 }] }],
  });
  is("分析层无数据 ⇒ missing_sections 空", unknownAnalysis.coverage.missing_sections.length, 0);
  is("分析层无数据 ⇒ 显式标 missing_sections 未知", unknownAnalysis.honesty.missing_sections_known, false);
  truthy("并说明空数组不等于没有缺口", unknownAnalysis.honesty.reasons.some((r) => r.includes("不等于没有缺口")));
  is("分析层无数据 ⇒ analyzed_units=0", unknownAnalysis.coverage.analyzed_units, 0);
  is("分析层无数据 ⇒ total_units=0", unknownAnalysis.coverage.total_units, 0);
}

// =========================================================================== //
console.log("\n[8] 耐久 resume（M2 交接事项 1；PRD §9.5 :764）");

{
  const unit = mkUnit({ start_codepoint: 0, end_codepoint: 100 });

  // —— 活会话：live lease 无 revision ⇒ pending_durable，水位不前进 ——
  const live = {
    source_gate: { state: "pending_durable", reason: "只观察到 live 来源" },
    source_revision: null,
    observed_through_seq: 20,
    durable_through_seq: null,
    processed_through_seq: null,
  };
  const p1 = planAdvance({ units: [unit], source: live });
  is("live ⇒ source_ready=false", p1.source_ready, false);
  is("live ⇒ gate=pending_durable", p1.gate, "pending_durable");
  is("live ⇒ 水位不前进", p1.watermark_advance_allowed, false);
  is("live ⇒ job 提示 blocked", p1.job_state_hint, "blocked");
  is("live ⇒ 单元不能推进", p1.advanceable.length, 0);
  is("live ⇒ 每个单元都给出阻塞原因", p1.blocked[0].blocked_reason, "SOURCE_NOT_DURABLE");
  truthy("live ⇒ 说明「为什么现在不能推进」", p1.blocked[0].why_now.includes("宿主尚未确认持久"));
  truthy("live ⇒ 给出 resume 条件", p1.blocked[0].resume_condition.includes("脱离内存"));
  is("live ⇒ 指明重核验入口", p1.blocked[0].recheck_via, "observeSession");
  is("阻塞原因完整性守卫", p1.blocked_reasons_complete, true);
  is("阻塞原因汇总", p1.blocked_by_reason.SOURCE_NOT_DURABLE, 1);

  // —— 会话脱离内存后：prepared + revision ⇒ 可续做 ——
  const prepared = {
    source_gate: { state: "ready", requested_through_seq: 20 },
    source_revision: "rev_1",
    observed_through_seq: 20,
    durable_through_seq: 20,
    processed_through_seq: null,
  };
  const p2 = reverifyResume({ units: [unit], source: prepared, previous: p1 });
  is("重新核验后 source_ready", p2.source_ready, true);
  is("重新核验后 resumable", p2.resumable, true);
  is("重新核验后可推进", p2.advanceable.length, 1);
  is("新可推进项被列出", p2.newly_advanceable.length, 1);
  is("来源修订来自新观察", p2.source_revision, "rev_1");
  is("reverified 标记", p2.reverified, true);
  is("水位此时允许前进", p2.watermark_advance_allowed, true);
  is("水位尚未建立但不算错误", p2.watermark.established, false);
  is("requested ≤ durable 被核验", p2.watermark.requested_within_durable, true);

  // —— 再变回 live ⇒ 必须重新挡住（不得缓存上一次的 ready）——
  const p3 = reverifyResume({ units: [unit], source: live, previous: p2 });
  is("再次 live ⇒ 重新 blocked（不缓存旧结论）", p3.source_ready, false);
  is("再次 live ⇒ 不可推进", p3.advanceable.length, 0);
  is("再次 live ⇒ resumable=false", p3.resumable, false);
  is("再次 live ⇒ 上一轮的门是 ready", p3.previous_gate, "ready");

  // —— ready 但没有 revision ⇒ 不得推进 ——
  const readyNoRevision = { ...prepared, source_revision: null };
  const p4 = planAdvance({ units: [unit], source: readyNoRevision });
  is("ready 但无 revision ⇒ 不推进", p4.source_ready, false);
  is("并说明理由", p4.blocked[0].blocked_reason, "SOURCE_NOT_DURABLE");
  is("理由指出不得凭未耐久观察推进", p4.source_block.gate, "pending_durable");

  // —— requested 超出 durable ⇒ 不得推进（ready 只证明 requested_range）——
  const overRequest = { ...prepared, source_gate: { state: "ready", requested_through_seq: 30 } };
  const p5 = planAdvance({ units: [unit], source: overRequest });
  is("requested > durable ⇒ 不推进", p5.watermark_advance_allowed, false);
  is("requested > durable ⇒ 单元被挡", p5.blocked[0].blocked_reason, "WATERMARK_NOT_ADVANCEABLE");
  is("requested_within_durable=false", p5.watermark.requested_within_durable, false);

  // —— ready 但连请求范围都没声明 ⇒ 不得推进 ——
  const noRequested = { ...prepared, source_gate: { state: "ready" } };
  const p6 = planAdvance({ units: [unit], source: noRequested });
  is("ready 缺 requested ⇒ 不推进", p6.watermark_advance_allowed, false);
  is("并给出专门原因码", p6.watermark.errors[0].code, "REQUESTED_RANGE_UNSPECIFIED");
  const p6b = planAdvance({ units: [unit], source: noRequested, requestedThroughSeq: 20 });
  is("显式声明请求范围后可通过", p6b.watermark_advance_allowed, true);

  // —— processed > durable ⇒ 不变式违规 ——
  const badWatermark = { ...prepared, observed_through_seq: 20, durable_through_seq: 10, processed_through_seq: 20 };
  const p7 = planAdvance({ units: [unit], source: badWatermark });
  is("processed > durable ⇒ 不变式违规", p7.watermark.valid, false);
  truthy("错误码是水位不变式", p7.watermark.errors.some((e) => e.code === "WATERMARK_INVARIANT_VIOLATION"));
  is("并因此不推进", p7.watermark_advance_allowed, false);

  // —— durable > observed ⇒ 不变式违规 ——
  const badOrder = { ...prepared, observed_through_seq: 5, durable_through_seq: 20 };
  const p8 = planAdvance({ units: [unit], source: badOrder });
  falsy("durable > observed ⇒ 不通过", p8.watermark.valid);

  // —— 逐状态：excluded / failed / processed 的推进语义 ——
  const processedUnit = okUnit(toProcessed(mkUnit({ start_codepoint: 0, end_codepoint: 100 })));
  const failedUnit = okUnit(toFailed(mkUnit({ start_codepoint: 100, end_codepoint: 200 })));
  const excludedUnit = okUnit(toExcluded(mkUnit({ start_codepoint: 200, end_codepoint: 300 }), "过渡性内容"));
  const p9 = planAdvance({ units: [processedUnit, failedUnit, excludedUnit], source: prepared });
  const d = Object.fromEntries(p9.decisions.map((x) => [x.state, x]));
  is("processed 单元不再推进", d.processed.reason, "ALREADY_PROCESSED");
  is("failed 单元等显式调度", d.failed.blocked_reason, "FAILED_AWAITING_EXPLICIT_SCHEDULE");
  is("excluded 单元不计作理解完成", d.excluded.blocked_reason, "EXCLUDED_NOT_COUNTED_AS_UNDERSTOOD");
  truthy("excluded 带出排除原因", d.excluded.exclusion_reason.includes("过渡性内容"));

  // —— 窗口未消费 ⇒ 挡住 ——
  const wu = mkWindowUnit({ start: 0, end: 100, window_index: 0 });
  const p10 = planAdvance({ units: [wu], source: prepared });
  is("窗口未消费 ⇒ 挡住", p10.blocked[0].blocked_reason, "WINDOW_NOT_CONSUMED");
  const p11 = planAdvance({ units: [{ ...wu, window_consumed: true }], source: prepared });
  is("窗口已消费 ⇒ 可推进", p11.advanceable.length, 1);

  // —— sourceBlockReason 覆盖各状态 ——
  is("ready+revision ⇒ 无阻塞", sourceBlockReason(prepared), null);
  is("partial ⇒ SOURCE_NOT_DURABLE", sourceBlockReason({ source_gate: { state: "partial" } }).code, "SOURCE_NOT_DURABLE");
  is("unavailable ⇒ SOURCE_UNAVAILABLE", sourceBlockReason({ source_gate: { state: "unavailable" } }).code, "SOURCE_UNAVAILABLE");
  is("unsupported ⇒ HOST_UNSUPPORTED", sourceBlockReason({ source_gate: { state: "unsupported" } }).code, "HOST_UNSUPPORTED");
  is("unknown ⇒ SOURCE_UNKNOWN", sourceBlockReason({ source_gate: { state: "unknown" } }).code, "SOURCE_UNKNOWN");
  is("没给来源 ⇒ SOURCE_UNKNOWN", sourceBlockReason({}).code, "SOURCE_UNKNOWN");
  is("checking ⇒ SOURCE_CHECKING", sourceBlockReason({ source_gate: { state: "checking" } }).code, "SOURCE_CHECKING");

  // —— 与 session-reader 的真实输出对接（离线替身，忠实复刻宿主语义）——
  const reader = createSessionReader({ sessionQuery: makeReadEventHost({ live: true }) });
  const status = await reader.readSourceStatus("session-A");
  is("session-reader：活会话 gate=pending_durable", status.source_gate.state, "pending_durable");
  is("session-reader：活会话无 revision", status.source_revision, null);
  const pInt = planAdvance({ units: [unit], source: status });
  is("集成：活会话 ⇒ 不推进", pInt.source_ready, false);
  is("集成：活会话 ⇒ 阻塞原因来自真实来源状态", pInt.blocked[0].blocked_reason, "SOURCE_NOT_DURABLE");
  is("集成：活会话 ⇒ 水位不前进", pInt.watermark_advance_allowed, false);

  const reader2 = createSessionReader({ sessionQuery: makeReadEventHost({ live: false }) });
  const status2 = await reader2.readSourceStatus("session-A");
  is("session-reader：落盘会话 gate=ready", status2.source_gate.state, "ready");
  truthy("session-reader：落盘会话有 revision", typeof status2.source_revision === "string");
  const pInt2 = planAdvance({ units: [unit], source: status2 });
  is("集成：落盘会话 ⇒ 可推进", pInt2.source_ready, true);
  is("集成：落盘会话 ⇒ resumable", pInt2.watermark_advance_allowed, true);
}

// =========================================================================== //
console.log("\n[9] readEventWindow 断言（M2 交接事项 2：原 0 断言，本轮补上）");

{
  const reader = createSessionReader({ sessionQuery: makeReadEventHost({}) });

  // 窗口覆盖 + 遮蔽事件**不得被自动排除**
  const w = await reader.readEventWindow("session-A", 4, { before: 2, after: 2 });
  is("窗口起点", w.start_seq, 2);
  is("窗口终点", w.end_seq, 6);
  is("窗口事件数", w.events.length, 5);
  deep("窗口 seq 序列", w.events.map((e) => e.seq), [2, 3, 4, 5, 6]);
  is("遮蔽事件仍在窗口里（不自动排除）", w.events.find((e) => e.seq === 5)?.surface_class, "shadowed");
  is("log-only 事件仍在窗口里", w.events.find((e) => e.seq === 3)?.surface_class, "log-only");
  is("当前表层事件标记为 current", w.events.find((e) => e.seq === 4)?.surface_class, "current");
  is("正文只在内存使用", w.in_memory_only, true);
  is("真人候选被识别", w.events.find((e) => e.seq === 4)?.human_input_candidate, true);
  is("系统注入不被当真人候选", w.events.find((e) => e.seq === 2)?.human_input_candidate, false);
  is("事件类型透出", w.events.find((e) => e.seq === 4)?.event_type, "user/message");

  // 边界裁剪
  const clamped = await reader.readEventWindow("session-A", 0, { before: 5, after: 0 });
  is("起点被裁到 0", clamped.start_seq, 0);
  is("终点等于目标 seq", clamped.end_seq, 0);
  const clampedEnd = await reader.readEventWindow("session-A", 6, { before: 0, after: 5 });
  is("终点被裁到日志末尾", clampedEnd.end_seq, 6);

  // 单点取证：只取一个事件也算窗口
  const single = await reader.readEventWindow("session-A", 5, {});
  is("单点窗口只有一个事件", single.events.length, 1);
  is("单点窗口仍是遮蔽事件", single.events[0].surface_class, "shadowed");

  // 宿主不支持 readEvent ⇒ 明确报 HOST_UNSUPPORTED，不静默返回空窗口
  const noReadEvent = createSessionReader({ sessionQuery: makeReadEventHost({ withReadEvent: false }) });
  let threw = null;
  try {
    await noReadEvent.readEventWindow("session-A", 1, {});
  } catch (e) {
    threw = e;
  }
  is("缺 readEvent ⇒ 抛错", threw !== null, true);
  is("缺 readEvent ⇒ 错误码 HOST_UNSUPPORTED", threw?.code, "HOST_UNSUPPORTED");
}

// =========================================================================== //
console.log("\n[9a] 替身忠实性元检查（把 M0/M2 踩过的坑固化成可证伪断言）");

{
  const q = makeReadEventHost({});
  const events = (await q.readSession("session-A")).events;
  const records = await q.listEvents("session-A");
  const surface = await q.readSurface("session-A");

  is("元检查：readSession 与 listEvents 条数一致", records.length, events.length);
  is("元检查：listEvents 每条都带 surface", records.every((r) => typeof r.surface === "string"), true);
  is("元检查：readSurface 只含 current（复刻宿主 currentSurfaceEvents）", surface.events.map((e) => e.seq).join(","), "0,1,2,4,6");
  falsy("元检查：readSurface 不含 shadowed", surface.events.some((e) => e.seq === 5));
  falsy("元检查：readSurface 不含 log-only", surface.events.some((e) => e.seq === 3));
  truthy("元检查：readSurface 远小于全日志", surface.events.length < events.length);
  is("元检查：诱饵 seq6 仍是 current（不累加 shadowedSeqs）", records.find((r) => r.seq === 6)?.surface, "current");
  is("元检查：seq3 是 log-only", records.find((r) => r.seq === 3)?.surface, "log-only");
  is("元检查：seq5 是 shadowed", records.find((r) => r.seq === 5)?.surface, "shadowed");

  const w = await q.readEvent({ sessionId: "session-A", seq: 4, before: 2, after: 2 });
  is("元检查：readEvent 不自动排除 shadowed", w.events.some((e) => e.seq === 5), true);
  is("元检查：readEvent 不自动排除 log-only", w.events.some((e) => e.seq === 3), true);

  const reader = createSessionReader({ sessionQuery: q });
  const cls = await reader.classifySurface("session-A");
  is("元检查：session-reader 判定 surface 分类 known", cls.known, true);
  is("元检查：替身 readSurface 是 current 的子集", cls.read_surface_cross_check.surface_subset_of_current, true);
  is("元检查：替身 readSurface 不含 shadowed", cls.read_surface_cross_check.surface_contains_shadowed, false);
  is("元检查：替身 readSurface 不含 log-only", cls.read_surface_cross_check.surface_contains_log_only, false);
  is("元检查：替身不退回 readSurface 反推", cls.fallback_used, false);

  // 反向验证：不忠实替身**必须被识破** —— 否则 [9] 的断言可能建在沙子上。
  const bad = makeReadEventHost({ mode: "unfaithful" });
  const badReader = createSessionReader({ sessionQuery: bad });
  const badCls = await badReader.classifySurface("session-A");
  is("不忠实替身：readSurface 含 log-only 必须被标出", badCls.read_surface_cross_check.surface_contains_log_only, true);
  falsy("不忠实替身：subset 检查必须为假", badCls.read_surface_cross_check.surface_subset_of_current);
  const badW = await badReader.readEventWindow("session-A", 4, { before: 2, after: 2 });
  falsy("不忠实替身会藏掉 shadowed（正因如此元检查不可省）", badW.events.some((e) => e.seq === 5));
}

// =========================================================================== //
console.log("\n[10] 只读与依赖边界");

{
  const src = readFileSync(COVERAGE_PATH, "utf8");
  const imports = [...src.matchAll(/^import\s[^\n]*?from\s+"([^"]+)";/gm)].map((m) => m[1]);
  is("coverage.js 只依赖 schema.js", imports.join(","), "./schema.js");
  falsy("不引入 node:fs", /from\s+"node:fs"/.test(src));
  falsy("不 import session-reader（依赖图保持 schema 单一）", imports.some((p) => p.includes("session-reader")));
  falsy("不含写盘调用", /writeFileSync\(|appendFileSync\(|mkdirSync\(|unlinkSync\(|rmSync\(|renameSync\(/.test(src));
  falsy("不含网络调用", /\bfetch\(|https?:\/\//.test(src));

  // 输出对象里不得出现内容承载键（不写第二份聊天存储的精神）
  const rep = buildCoverageReport({
    coordinate_space: CS,
    discovered_body: [{ start_codepoint: 0, end_codepoint: 100 }],
    units: [okUnit(toProcessed(mkUnit({ start_codepoint: 0, end_codepoint: 100 })))],
  });
  const s = JSON.stringify(rep);
  falsy("报告里没有正文类键", /"(content|text|prompt|transcript|chat|conversation)"\s*:/.test(s));
  truthy("报告里没有用户会话正文（夹具里也没有）", !s.includes("用户说的话"));
}

// =========================================================================== //
console.log("\n[11] 无法离线验证的项（显式跳过，三分处理）");

{
  skip(
    "真实书源上的 EPUB span/章节覆盖实测（《第一哲学沉思集》458KB）",
    "本轮不接引擎、不读真实书源（执行计划 §4 的步骤 1 留到引擎接入轮次）；本轮只做离线可证伪验证",
  );
  skip(
    "宿主运行期注入（ctx.inject sessionQuery 真生效）",
    "DSH 无插件热加载，需重启宿主；本轮未重启（M3 范围不含 lib/index.js 接线）",
  );
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败${skipped ? ` / ${skipped} 跳过（环境限制，非通过）` : ""}`);
if (skipped) console.log("注：跳过项在本环境无法验证，不得算作通过。");
process.exit(fail ? 1 : 0);

// =========================================================================== //
// 忠实宿主替身（只覆盖本文件用到的 API）
// =========================================================================== //

/**
 * 复刻宿主 `sessionQuery` 的语义（来源：`@deepseek-ai/dsh-session-query/lib/index.js`）。
 *
 * fixture：7 个事件，seq 0..6 连续。
 *   seq3 = `compaction/prune`（log-only 结构事件）
 *   seq5 = 被 seq3 的 shadowedSeqs 遮蔽的真人轮次（**原文仍在日志里**）
 *   seq2 = `time-context` 系统注入
 *   seq6 = 替换 seq5 的当前表层事件
 *
 * 注意 `readSurface` **只返回 current**（复刻宿主 `currentSurfaceEvents`），
 * 而 `readEvent` **不自动排除 shadowed** —— 这正是 [9] 要钉住的语义。
 */
function makeReadEventHost({ live = false, withReadEvent = true, mode = "faithful" } = {}) {
  const T = (n) => 1_700_000_000_000 + n * 1000;
  const events = [
    { type: "user/message", seq: 0, time: T(0), surfaceOp: "append", data: { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "第一问" }] } },
    { type: "assistant/message", seq: 1, time: T(1), surfaceOp: "append", data: { role: "assistant", message: { role: "assistant", content: [{ type: "text", text: "第一答" }] } } },
    { type: "user/message", seq: 2, time: T(2), surfaceOp: "append", data: { role: "user", source: { kind: "time-context" }, content: [{ type: "text", text: "现在是 2026 年" }] } },
    { type: "compaction/prune", seq: 3, time: T(3), data: { shadowedSeqs: [5], compactionId: "cmp_1" } },
    { type: "user/message", seq: 4, time: T(4), surfaceOp: "append", data: { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "第二问" }] } },
    { type: "user/message", seq: 5, time: T(5), surfaceOp: "append", data: { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "被遮蔽的一问" }] } },
    { type: "user/message", seq: 6, time: T(6), surfaceOp: "replace", data: { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "替换后的一问" }] } },
  ];
  const surface = new Map([[0, "current"], [1, "current"], [2, "current"], [3, "log-only"], [4, "current"], [5, "shadowed"], [6, "current"]]);
  const header = { id: "session-A", createdAt: T(0), cwd: "/workspace", parentSession: null, isSeeded: false, version: 4 };
  const lastSeq = events.length - 1;

  const query = {
    async listSessions() {
      return [{ header: { ...header }, live, persisted: !live }];
    },
    async readSession() {
      return { session: { ...header }, inheritedEventCount: 0, events: events.map((e) => structuredClone(e)) };
    },
    async listEvents() {
      return events.map((e) => ({ sessionId: "session-A", seq: e.seq, type: e.type, time: e.time, surface: surface.get(e.seq) }));
    },
    async readSurface() {
      if (mode === "unfaithful") {
        // ⛔ M0 形状的不忠实替身：返回「全部非遮蔽事件」（含 log-only）——真实宿主只返回 current。
        return {
          session: { ...header },
          inheritedEventCount: 0,
          capturedThroughSeq: lastSeq,
          events: events.filter((e) => surface.get(e.seq) !== "shadowed").map((e) => structuredClone(e)),
        };
      }
      return {
        session: { ...header },
        inheritedEventCount: 0,
        capturedThroughSeq: lastSeq,
        events: events.filter((e) => surface.get(e.seq) === "current").map((e) => structuredClone(e)),
      };
    },
    async observeSession() {
      const lease = {
        source: live ? "live" : "prepared",
        header: { ...header },
        inheritedEventCount: 0,
        events: events.map((e) => structuredClone(e)),
        cursor: lastSeq,
        ...(live ? {} : { revision: "jsonl:dev=1,ino=2,size=3,mtime=4" }),
        retain: () => lease,
        [Symbol.dispose]: () => {},
      };
      return lease;
    },
  };
  if (withReadEvent) {
    query.readEvent = async ({ seq, before = 0, after = 0 }) => {
      const start = Math.max(0, seq - before);
      const end = Math.min(lastSeq, seq + after);
      const windowEvents = events.slice(start, end + 1);
      return {
        session: { ...header },
        inheritedEventCount: 0,
        target: structuredClone(events[seq]),
        // ⛔ 不忠实替身会「顺手」把 shadowed 过滤掉 —— 真实宿主的 readEvent 不会。
        events: (mode === "unfaithful" ? windowEvents.filter((e) => surface.get(e.seq) !== "shadowed") : windowEvents)
          .map((e) => structuredClone(e)),
        startSeq: start,
        endSeq: end,
      };
    };
  }
  return query;
}
