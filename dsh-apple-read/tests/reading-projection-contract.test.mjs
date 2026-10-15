/**
 * tests/reading-projection-contract.test.mjs · M8 ① **跨层契约测试**
 *
 * ## 这个套件在防什么（M7 留下的真缺口）
 *
 * M7 的面板按 `recommendations.result` 预留了挂载点，但那条**字段契约没有被测试钉住**：
 * 现有检查只钉了 URL `/reading/recommendations`，没钉响应里必须有 `result` 及其形状。
 * 于是「路由给 `result`、面板读 `result`」这两件事写在**两个文件**里，
 * 谁改一边都不会红 —— 面板会**静默**退回诚实空态，没人发现。
 *
 * 本套件把两件事**接在一起测**：
 *
 * ```
 *   runtime.recommendations()            ← 路由的**真实**响应
 *     → pickReadingResult(...)           ← 面板**原样截取**的读取路径（app.js 的 READING-VIEW 区）
 *       → renderGuideHtml(...)           ← 面板**原样截取**的渲染器
 *         → 断言两层**真的有内容**        ← 不是「能跑」，是「渲染出来了」
 * ```
 *
 * ## 每条检查「在什么情况下会失败」
 *   [0] 模块形状      — runtime 不导出纯函数 / 面板区没有 pickReadingResult 立刻失败
 *   [1] 夹具忠实性    — 夹具本身是空的两层（那后面的断言全是假绿）立刻失败
 *   [2] 投影形状      — result 不是恰好 7 键、metadata 不是 12 键、result_run_id 对不上 runs 立刻失败
 *   [3] 读取路径一致  — 路由字段名与面板读法不一致（改名/改读法）立刻失败
 *   [4] 两层真渲染    — 路由给了 result 却渲染不出两层（缺 items/缺第二层）立刻失败
 *   [5] 负控（反向）  — result 为 null 时**必须**是空态；否则 [4] 的断言没有区分度
 *   [6] 多 run 身份   — 拿旧 run 冒充当前（显示的候选不是最新那次）立刻失败
 *   [7] stale 不冒充  — 最新 run 是 stale 时把它当 ready 显示立刻失败
 *   [8] 全 stale      — 一个 ready 都没有时给 result（拿旧 run 顶数）立刻失败
 *   [9] 坏 run        — schema 认、result 形状不认的 run 被渲染成半成品立刻失败
 *   [10] 元数据诚实   — 未持久化字段被填成「默认值」而不是 null 立刻失败
 *   [11] status 三态  — none/limited/available 任一渲染错立刻失败
 *   [12] 只读         — 投影写盘（全树 sha256 变了）立刻失败
 *
 * 跑法：`node tests/reading-projection-contract.test.mjs`
 * 变异套件用 `READING_RUNTIME` / `APPLE_READ_UI_ROOT` 指向改坏的副本。
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.APPLE_READ_UI_ROOT ?? join(HERE, "..");
const RUNTIME_PATH = process.env.READING_RUNTIME ?? join(HERE, "..", "lib", "reading", "runtime.js");
const PANEL_APP = join(ROOT, "assets", "panel", "app.js");

let pass = 0, fail = 0, skipped = 0;
const ok = (m) => { pass++; console.log("  ✓ " + m); };
const bad = (m, d) => { fail++; console.log("  ✗ " + m + (d ? "\n      " + d : "")); };
const skip = (m, why) => { skipped++; console.log("  ⊘ 跳过 " + m + " —— " + why); };
const check = (cond, m, d) => (cond ? ok(m) : bad(m, d));
const isMap = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * 段落级兜底网（沿用 M3/M5 的教训）：
 * 变异若让某个断言**抛异常**，套件会崩成「零条 ✗」——分不清「抓到」还是「没抓到」。
 * 所以把异常收成**一条可定位的 ✗**，并且退出码仍然是失败。
 */
let currentSection = "（未进入段落）";
function reportAndExit() {
  console.log(`\n结果：${pass} 通过 / ${fail} 失败${skipped ? ` / ${skipped} 跳过` : ""}`);
  if (skipped) console.log("注：跳过项在本环境无法验证，不得算作通过。");
  process.exit(fail === 0 ? 0 : 1);
}
process.on("uncaughtException", (e) => {
  bad(`[${currentSection}] 套件被异常打断（兜底网，这条也算失败）`, String(e?.stack || e).split("\n").slice(0, 3).join("\n      "));
  reportAndExit();
});
process.on("unhandledRejection", (e) => {
  bad(`[${currentSection}] 套件被未处理的 Promise 拒绝打断（兜底网）`, String(e?.stack || e).split("\n").slice(0, 3).join("\n      "));
  reportAndExit();
});
const section = (name) => { currentSection = name; console.log(`\n${name}`); };

// --------------------------------------------------------------------------- //
// 取面板的**真实**读取路径与渲染器（原样截取 READING-VIEW 纯函数区）
// --------------------------------------------------------------------------- //
const panelSrc = readFileSync(PANEL_APP, "utf8");
const BEGIN = "/* ==== READING-VIEW BEGIN ==== */";
const END = "/* ==== READING-VIEW END ==== */";
const i0 = panelSrc.indexOf(BEGIN);
const i1 = panelSrc.indexOf(END);
if (i0 < 0 || i1 <= i0) {
  bad("app.js 里找不到 READING-VIEW 标记区（跨层契约无法求值）");
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(1);
}
const viewSrc = panelSrc.slice(i0 + BEGIN.length, i1);
let V;
try {
  V = new Function(viewSrc
    + "\n;return { pickReadingResult, renderGuideHtml, renderRunIdentitySection, fmtUnknown, esc };")();
} catch (e) {
  bad("READING-VIEW 区求值失败", String(e?.message || e));
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(1);
}

const rt = await import(RUNTIME_PATH);
const { createReadingRuntime, selectCurrentRun, projectRecommendationResultFromRun } = rt;
const F = await import("./fakes/reading-fixtures.mjs");
const policy = await import(join(dirname(RUNTIME_PATH), "policy.js"));
const { composeNote, validateNote } = await import(join(dirname(RUNTIME_PATH), "schema.js"));
const { BOOK_DOMAIN } = await import(join(dirname(RUNTIME_PATH), "book-domain.js"));

// --------------------------------------------------------------------------- //
// 小工具
// --------------------------------------------------------------------------- //
function treeHash(dir) {
  const h = createHash("sha256");
  const walk = (d, base) => {
    for (const name of readdirSync(d).sort()) {
      const abs = join(d, name);
      const rel = base ? `${base}/${name}` : name;
      const st = statSync(abs);
      if (st.isDirectory()) walk(abs, rel);
      else h.update(rel + "\0").update(readFileSync(abs)).update("\0");
    }
  };
  walk(dir, "");
  return h.digest("hex");
}

async function recFor(dir) {
  const rto = createReadingRuntime({ getSettings: () => ({ bookKbDir: dir }) });
  return rto.recommendations();
}

/** 面板渲染出来的两层 HTML（走**真实**读取路径）。 */
function renderFrom(rec) {
  const result = V.pickReadingResult(rec);
  const html = V.renderGuideHtml({ recommendations: rec, result, coverage: null, library: null, evidence: null });
  return { result, html };
}

/** 第一层「真的渲染出内容」的判据（不是空态、不是结构错误）。 */
function layer1Real(html) {
  return html.includes('id="gd-l1"')
    && !html.includes('id="gd-l1-empty"')
    && !html.includes('id="gd-l1-abstain"')
    && !html.includes('id="gd-l1-broken"')
    && !html.includes('id="gd-l1-norefs"')
    && /data-cid="ca_[^"]+"/.test(html);
}
/** 第二层「真的渲染出内容」的判据。 */
function layer2Real(html) {
  return html.includes('id="gd-l2"')
    && !html.includes('id="gd-l2-empty"')
    && !html.includes('id="gd-l2-none"')
    && /class="gdscore"/.test(html)
    && /gdreason-personal/.test(html);
}

// =========================================================================== //
section("[0] 模块形状：跨层契约的两端都得在");

check(typeof V.pickReadingResult === "function", "面板区导出了 pickReadingResult（唯一读取路径）");
check(typeof V.renderGuideHtml === "function", "面板区导出了 renderGuideHtml");
check(typeof V.renderRunIdentitySection === "function", "面板区导出了 renderRunIdentitySection（说清显示哪次运行）");
check(typeof selectCurrentRun === "function", "runtime 导出 selectCurrentRun（选 run 规则可被直接测）");
check(typeof projectRecommendationResultFromRun === "function", "runtime 导出 projectRecommendationResultFromRun");
check(Array.isArray(rt.NOT_PERSISTED_METADATA_FIELDS) && rt.NOT_PERSISTED_METADATA_FIELDS.length === 4,
  "runtime 显式列出未持久化的元数据字段（4 个）", JSON.stringify(rt.NOT_PERSISTED_METADATA_FIELDS));
check(Array.isArray(rt.DERIVED_METADATA_FIELDS) && rt.DERIVED_METADATA_FIELDS.join(",") === "b_anchors",
  "runtime 显式列出由常量推导的元数据字段（b_anchors）");
// 读取路径必须**只有一处**：面板里不得再有第二套 `recommendations.result` 取法
check(!/recommendations\s*&&\s*recommendations\.result/.test(panelSrc),
  "面板里没有第二套 `recommendations && recommendations.result` 取法（读取路径唯一）");
check(/pickReadingResult\(recommendations\)/.test(panelSrc),
  "loadReading() 真的走了 pickReadingResult（不是绕过它）");

// =========================================================================== //
section("[1] 夹具忠实性元检查（防「空夹具上的假绿」）");

{
  const problems = F.assertFixtureFaithful();
  check(problems.length === 0, "夹具真的产出了两层内容 + 10 键分值 + limited 态", problems.join("；"));
  const none = F.makeRecommendationResult({ layer2: false, marker: "z" });
  check(none.personalized_items.length === 0 && none.personalization_status === "none",
    "夹具能造出 none 态（第二层为空）");
  const avail = F.makeRecommendationResult({ dimensions: { R: 3, G: 2, T: 1 }, marker: "z" });
  const s = avail.personalized_items[0].scores;
  check(s.C === 1 && s.q === 1 && avail.personalization_status === "available",
    "夹具能造出 available 态（C=1 且 q=1）", `C=${s.C} q=${s.q} status=${avail.personalization_status}`);
}

// =========================================================================== //
section("[2] 只读投影形状：result 必须是**真**的 RecommendationResult");

const dir2 = F.makeVault([
  { runId: "rr_old", createdAt: "2026-02-01T00:00:00.000Z", updatedAt: "2026-02-01T00:00:00.000Z", marker: "o" },
  { runId: "rr_new", createdAt: "2026-03-01T00:00:00.000Z", updatedAt: "2026-03-01T00:00:00.000Z", marker: "n" },
]);
{
  const rec = await recFor(dir2);
  check(rec.ok === true, "recommendations() 正常返回");
  check(Array.isArray(rec.runs) && rec.runs.length === 2, "runs 元数据列表保持现状（2 条）");
  const runKeys = Object.keys(rec.runs[0]).sort().join(",");
  check(runKeys === "content_hash,created_at,rel,run_id,state,title,updated_at",
    "runs 每项仍是原来的 7 个元数据键（没有偷偷加字段）", runKeys);
  check(rec.count === 2 && rec.invalid_count === 0, "count/invalid_count 保持现状");

  check(isMap(rec.result), "result 是映射（不是 null、也不是 undefined）", typeof rec.result);
  const rk = Object.keys(isMap(rec.result) ? rec.result : {}).sort();
  const want = [...policy.RESULT_KEYS].sort();
  check(rk.length === want.length && rk.every((k, i) => k === want[i]),
    "result 顶层恰好 7 键 == policy.RESULT_KEYS（与 policy 同一把尺子）", rk.join(","));
  const mk = Object.keys(rec.result?.policy_and_model_metadata ?? {});
  const mw = [...policy.POLICY_AND_MODEL_METADATA_KEYS];
  check(mk.length === mw.length && mw.every((k) => mk.includes(k)),
    "policy_and_model_metadata 恰好 12 键 == policy 的常量表", mk.join(","));

  check(typeof rec.result_run_id === "string" && rec.runs.some((r) => r.run_id === rec.result_run_id),
    "result_run_id 能对上 runs 里的某个 run_id", `result_run_id=${rec.result_run_id}`);
  // M10 阶段 2：`newest_run_id` / `result_is_latest` / `result_superseded_by` 已删除，
  // 改为「这本书盘上有几条 ready 理解」。字段一旦被加回来，这里立刻红。
  check(!("newest_run_id" in rec) && !("result_is_latest" in rec) && !("result_superseded_by" in rec),
    "多 run 时代的三个字段确实已从只读路由删掉",
    `newest=${"newest_run_id" in rec} is_latest=${"result_is_latest" in rec} sup=${"result_superseded_by" in rec}`);
  check(rec.result_run_id === "rr_new", "result_run_id 指向那条 ready 理解", String(rec.result_run_id));
  // dir2 的两条 run 都是 ready（夹具没给 state）⇒ 这本来就是「异常：一本书多条 ready」，
  // 如实报 2 条 + 有歧义。正常一本书一条的情形由 runtime 测试的端到端用例覆盖。
  check(rec.ready_run_count === 2 && rec.result_ambiguous === true,
    "如实报 2 条 ready + 有歧义（不静默挑一条装作正常）", `${rec.ready_run_count}/${rec.result_ambiguous}`);
  check(rec.read_only === true, "路由自报只读（read_only:true）");
  // 投影结果必须过 policy 的 assertResultShape（在这里再独立跑一次，不信任路由自报）
  let shapeOk = true; let shapeMsg = "";
  try { policy.assertResultShape(rec.result); } catch (e) { shapeOk = false; shapeMsg = String(e?.message || e); }
  check(shapeOk, "投影出的 result 独立通过 policy.assertResultShape", shapeMsg);
}

// =========================================================================== //
section("[3] 跨层：路由给的 result == 面板读取的路径");

{
  const rec = await recFor(dir2);
  const viaPanel = V.pickReadingResult(rec);
  check(viaPanel !== null, "面板的读取路径拿得到 result（字段名一致）");
  check(viaPanel === rec.result, "面板读到的**就是**路由给的那个 result（同一对象，不是另造一份）");
  check(V.pickReadingResult(null) === null, "响应为 null ⇒ 读取路径给 null（不编造）");
  check(V.pickReadingResult({}) === null, "响应没有 result 字段 ⇒ 读取路径给 null");
  check(V.pickReadingResult({ result: [] }) === null, "result 是数组 ⇒ 不当结果（形状守卫）");
  check(V.pickReadingResult({ result: "x" }) === null, "result 是字符串 ⇒ 不当结果");
}

// =========================================================================== //
section("[4] 反向断言：路由给了 result ⇒ 面板**必须**渲染出两层（渲染不出就红）");

{
  const rec = await recFor(dir2);
  const { result, html } = renderFrom(rec);
  check(result !== null, "有 result 可渲染");
  check(layer1Real(html), "第一层渲染出真实内容（不是 gd-l1-empty / 结构错误）");
  check(layer2Real(html), "第二层渲染出真实内容（不是 gd-l2-empty / 无项）");
  // 具体内容：分值 / 理由 / 来源 / candidate_id
  check(/data-cid="ca_n_1"/.test(html), "第一层 item 的 candidate_id 出现在 DOM 里");
  check(/B=3/.test(html), "第一层的 B 分值出现");
  check(/核心论证/.test(html), "第一层的理由出现");
  check(/source_refs：sp_n_1/.test(html), "第一层的书内来源出现（导读改版阶段 1 起收在技术细节折叠区里）");
  check(/gdreason-personal/.test(html) && /个人理由（第二层）/.test(html), "第二层的个人理由出现");
  check(/<i>B<\/i>3/.test(html) && /<i>S<\/i>/.test(html), "第二层的 10 键分值逐个出现");
  check(/sp_n_1、pe_n_1/.test(html), "第二层的来源出现（导读改版阶段 1 起收在技术细节折叠区里）");
  check(/G 依据：unknown/.test(html) && /T 依据：unknown/.test(html), "无依据维度显示 unknown（不填 0/中立）");
  check(!/置信度[:：]?\s*\d/.test(html), "渲染结果里不得出现「置信度 X%」（C/q 不是统计置信度）");
  check(!/全书\s*100%/.test(html), "渲染结果里不得出现「全书 100%」");
}

// =========================================================================== //
section("[5] 负控（反向）：没有 result 时必须走诚实空态 —— 证明 [4] 有区分度");

{
  const rec = await recFor(dir2);
  const noResult = { ...rec, result: null, result_run_id: null, feedback_refs: null };
  const { result, html } = renderFrom(noResult);
  check(result === null, "负控：读取路径确实拿到 null");
  check(html.includes('id="gd-l1-empty"'), "负控：第一层显示诚实空态 gd-l1-empty");
  check(html.includes('id="gd-l2-empty"'), "负控：第二层显示诚实空态 gd-l2-empty");
  check(!layer1Real(html) && !layer2Real(html), "负控：两层都不满足「真实内容」判据（判据有区分度）");
  check(!/data-cid="ca_/.test(html), "负控：没有任何候选被渲染出来（空态不编造内容）");
}

// =========================================================================== //
section("[6] 多条 ready：如实报出歧义（不静默挑一条装作没有歧义）");

const dir6 = F.makeVault([
  { runId: "rr_a", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", marker: "a" },
  { runId: "rr_b", createdAt: "2026-02-01T00:00:00.000Z", updatedAt: "2026-02-01T00:00:00.000Z", marker: "b" },
  { runId: "rr_c", createdAt: "2026-03-01T00:00:00.000Z", updatedAt: "2026-03-01T00:00:00.000Z", marker: "c" },
]);
{
  const rec = await recFor(dir6);
  check(rec.count === 3, "三条 run 都在", String(rec.count));
  check(rec.result_run_id === "rr_c", "result_run_id = 最新的 ready run（rr_c）", String(rec.result_run_id));
  const { html } = renderFrom(rec);
  check(/data-cid="ca_c_1"/.test(html), "渲染的是 rr_c 的候选（ca_c_1），不是旧 run 的");
  check(!/data-cid="ca_a_1"/.test(html) && !/data-cid="ca_b_1"/.test(html),
    "旧 run 的候选**没有**被渲染出来（没冒充当前）");
  check(/【夹具 c】/.test(html), "浓缩段落来自 rr_c");
  check(html.includes('id="gd-run-id"') && /rr_c/.test(html), "面板明说显示的是哪一次运行（rr_c）");
  // 新语义：3 条 ready 是**异常**（M10 之后一本书只该有一条），必须如实报出而不是装作正常
  check(rec.ready_run_count === 3, "ready_run_count 如实报 3", String(rec.ready_run_count));
  check(rec.result_ambiguous === true, "result_ambiguous=true（明确告诉调用方有歧义）");
  check(html.includes('id="gd-run-ambiguous"') && /没有替你删任何一条/.test(html),
    "面板明说有 3 条 ready、显示的是最新一条、且**没有替你删任何一条**");
  check(/3 条 ready 理解/.test(String(rec.result_note)), "result_note 如实报条数", String(rec.result_note));

  // selectCurrentRun 的纯函数行为（不经过读盘）
  const pick = selectCurrentRun(rec.runs);
  check(pick.result_run_id === "rr_c" && pick.ready_run_count === 3 && pick.ambiguous === true,
    "selectCurrentRun 纯函数：取最新 ready，并标记歧义",
    `${pick.result_run_id}/${pick.ready_run_count}/${pick.ambiguous}`);
  check(pick.ready_run_ids.join(",") === "rr_c,rr_b,rr_a", "ready_run_ids 是全序且确定（新在前）", pick.ready_run_ids.join(","));
  // 同时间戳时用 run_id 兜底，保证顺序确定（不是「看目录遍历顺序」）
  const tie = selectCurrentRun([
    { run_id: "rr_x", state: "ready", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" },
    { run_id: "rr_y", state: "ready", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" },
  ]);
  check(tie.result_run_id === "rr_y", "同时间戳按 run_id 兜底排序（确定，不靠遍历顺序）", String(tie.result_run_id));
}

// =========================================================================== //
section("[7] 盘上还有一条 stale 的历史 run：不得把它当成当前，也不再谈「取代」");

const dir7 = F.makeVault([
  { runId: "rr_ready", createdAt: "2026-02-01T00:00:00.000Z", updatedAt: "2026-02-01T00:00:00.000Z", marker: "r" },
  { runId: "rr_stale", createdAt: "2026-03-01T00:00:00.000Z", updatedAt: "2026-03-01T00:00:00.000Z", marker: "s", state: "stale" },
]);
{
  const rec = await recFor(dir7);
  check(rec.count === 2, "两条 run（一条 ready 一条 stale）");
  check(rec.result_run_id === "rr_ready", "显示的是 ready 那条（不拿 stale 冒充）", String(rec.result_run_id));
  check(rec.ready_run_count === 1, "ready 的只有 1 条 ⇒ 无歧义", String(rec.ready_run_count));
  check(rec.result_ambiguous === false, "result_ambiguous=false");
  check(!/取代|superseded/.test(String(rec.result_note)),
    "result_note 不再谈「取代」（新模型里没有第二个 run 去取代它）", String(rec.result_note));
  const { html } = renderFrom(rec);
  check(/data-cid="ca_r_1"/.test(html), "渲染的是 ready run 的候选");
  check(!/data-cid="ca_s_1"/.test(html), "stale run 的候选没有被渲染");
  check(!html.includes('id="gd-run-superseded"') && !html.includes('id="gd-run-superseded-by"'),
    "面板不再有「被取代」区块（字段已删，不许残留）");
  check(html.includes('id="gd-run-ready-count"'), "面板如实报「这本书有 1 条 ready 理解」");
}

// =========================================================================== //
section("[8] 全部 stale：宁可不给，也不拿旧 run 顶数");

const dir8 = F.makeVault([
  { runId: "rr_s1", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", marker: "1", state: "stale" },
  { runId: "rr_s2", createdAt: "2026-02-01T00:00:00.000Z", updatedAt: "2026-02-01T00:00:00.000Z", marker: "2", state: "stale" },
]);
{
  const rec = await recFor(dir8);
  check(rec.count === 2, "两条 run 都还在 runs 里（不是被删掉）");
  check(rec.result === null, "没有 ready run ⇒ result 为 null");
  check(rec.result_run_id === null, "result_run_id 为 null（不指向任何 run）");
  check(rec.result_error?.code === "NO_READY_RUN", "给出明确原因 NO_READY_RUN", JSON.stringify(rec.result_error));
  const { html } = renderFrom(rec);
  check(html.includes('id="gd-l1-empty"') && html.includes('id="gd-l2-empty"'), "面板走诚实空态");
  check(html.includes('id="gd-run-none"'), "身份区明说「没有可显示的运行」");
  check(!/data-cid="ca_/.test(html), "没有任何旧 run 的候选被渲染出来");
}

// =========================================================================== //
section("[9] 坏 run：schema 认、result 形状不认 ⇒ 不给半成品");

const goodText = F.makeRunNoteText({
  result: F.makeRecommendationResult({ runId: "rr_broken", marker: "k" }),
  runId: "rr_broken",
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
  marker: "k",
});
// 把 personalized_items 里的 `scores` 整块删掉：M1 schema 只校验 personalized_items 是数组
// （不校验每项的键集合），所以这份笔记仍能过 formal；但过不了 policy 的 assertResultShape
// （每项必须恰好 6 键、scores 必须恰好 10 键）。这正是「盘上的记录合法、投影出来却是半成品」。
const brokenText = goodText.replace(/\n    scores:\n(?:      .*\n)*/, "\n");
{
  check(brokenText !== goodText && !/\n    scores:/.test(brokenText),
    "（夹具元检查）personalized_items 里的 scores 块确实被删掉了");
  const parsed = (await import(join(dirname(RUNTIME_PATH), "schema.js"))).parseNote(brokenText);
  const v = validateNote(parsed.data, { mode: "formal", objectType: "recommendation_run", domain: BOOK_DOMAIN });
  check(v.ok === true, "（夹具元检查）这份坏 run 仍能过 M1 formal 校验（所以它会出现在 runs 里）",
    JSON.stringify(v.errors?.slice(0, 2)));
  check(Array.isArray(parsed.data.personalized_items) && parsed.data.personalized_items.length > 0
    && parsed.data.personalized_items[0].scores === undefined,
    "（夹具元检查）personalized_items 非空但首项没有 scores");
  const direct = projectRecommendationResultFromRun(parsed.data);
  check(direct.ok === false && direct.code === "RUN_INVALID_SHAPE",
    "（夹具元检查）投影函数直接拒绝它（且**不抛错**，返回明确错误码）", JSON.stringify(direct).slice(0, 200));

  const dir9 = F.makeVault([{ runId: "rr_broken", raw: brokenText }]);
  const rec = await recFor(dir9);
  check(rec.count === 1, "坏 run 仍在 runs 里（不静默丢掉）");
  check(rec.result === null, "投影拒绝产出半成品：result 为 null");
  check(rec.result_run_id === null, "result_run_id 为 null（没有假装拿到了结果）");
  check(rec.result_error?.code === "RUN_INVALID_SHAPE", "给出明确原因 RUN_INVALID_SHAPE", JSON.stringify(rec.result_error));
  const { html } = renderFrom(rec);
  check(html.includes('id="gd-l1-empty"') && !layer1Real(html), "面板走诚实空态，不渲染半成品");
  check(html.includes('id="gd-run-error"') && /RUN_INVALID_SHAPE/.test(html), "身份区如实报投影失败原因");
}

// =========================================================================== //
section("[10] 元数据诚实：未持久化的字段必须是 null，不得填「默认值」");

{
  const rec = await recFor(dir2);
  const md = isMap(rec.result?.policy_and_model_metadata) ? rec.result.policy_and_model_metadata : {};
  for (const f of rt.NOT_PERSISTED_METADATA_FIELDS) {
    check(md[f] === null, `未持久化字段 ${f} 为 null（不填默认值）`, JSON.stringify(md[f]));
  }
  check(md.b_anchors?.[3] === policy.B_SCORE_ANCHORS[3],
    "b_anchors 取自 policy.js 冻结常量（不是编造）", JSON.stringify(md.b_anchors));
  check(md.policy?.id === "evidence_balanced" && md.policy?.version === "0.1.0",
    "已持久化的 policy 原样透出");
  check(md.input_fingerprint === F.FIXTURE.input_fingerprint, "input_fingerprint 原样透出");
  check(md.budget !== null, "budget 来自 run 的 budget_usage");
  const proj = rec.result_projection;
  check(proj?.reconstructed === true, "result_projection.reconstructed = true（明说这是投影）");
  check(proj?.from_run_id === rec.result_run_id, "result_projection.from_run_id 与 result_run_id 一致");
  check(JSON.stringify(proj?.not_persisted_metadata_fields) === JSON.stringify([...rt.NOT_PERSISTED_METADATA_FIELDS]),
    "投影如实列出「哪些元数据字段没被 run 持久化」");
  check(typeof proj?.note === "string" && proj.note.includes("null"), "投影带一句人话说明（不是静默）");
  // 独立复算：把 run 笔记原样再投影一次，结果必须一致（确定性、可复算）
  const parsed = (await import(join(dirname(RUNTIME_PATH), "schema.js"))).parseNote(
    F.makeRunNoteText({
      result: F.makeRecommendationResult({ runId: "rr_new", marker: "n" }),
      runId: "rr_new",
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
      marker: "n",
    }));
  const p2 = projectRecommendationResultFromRun(parsed.data);
  check(p2.ok === true && JSON.stringify(p2.result) === JSON.stringify(rec.result),
    "同一份 run 笔记重复投影 ⇒ 结果逐字节一致（确定、可复算）");
  check(projectRecommendationResultFromRun(null).code === "RUN_INVALID_SHAPE", "非映射输入 ⇒ RUN_INVALID_SHAPE（不崩）");
  check(projectRecommendationResultFromRun({}).code === "RUN_INVALID_SHAPE", "空对象 ⇒ RUN_INVALID_SHAPE（不产出半成品）");
}

// =========================================================================== //
section("[11] status 三态：none / limited / available 各自渲染正确");

{
  const mk = async (spec, marker) => {
    const d = F.makeVault([{ runId: spec.runId, raw: F.makeRunNoteText({
      result: F.makeRecommendationResult({ ...spec.resultOpts, runId: spec.runId, marker }),
      runId: spec.runId,
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-05-01T00:00:00.000Z",
      marker,
    }) }]);
    return recFor(d);
  };
  const none = await mk({ runId: "rr_none", resultOpts: { layer2: false } }, "none");
  const lim = await mk({ runId: "rr_lim", resultOpts: {} }, "lim");
  const avail = await mk({ runId: "rr_avail", resultOpts: { dimensions: { R: 3, G: 2, T: 1 } } }, "avail");
  check(none.result?.personalization_status === "none", "none 态：投影 status=none");
  check(lim.result?.personalization_status === "limited", "limited 态：投影 status=limited");
  check(avail.result?.personalization_status === "available", "available 态：投影 status=available");

  const hn = renderFrom(none).html;
  const hl = renderFrom(lim).html;
  const ha = renderFrom(avail).html;
  check(/id="gd-status" data-status="none"/.test(hn) && /尚未个性化/.test(hn), "none ⇒ 「尚未个性化」");
  check(/id="gd-status" data-status="limited"/.test(hl) && /有限个性化/.test(hl), "limited ⇒ 「有限个性化」");
  check(/id="gd-status" data-status="available"/.test(ha) && /已个性化/.test(ha), "available ⇒ 「已个性化」");
  check(/C=[\d.]+ &lt; 1/.test(hl), "limited 态给出 C<1 的原因（不是含糊话）");
  check(/C\/q 不是统计置信度/.test(hl), "limited 态明说 C/q 不是统计置信度");
  check(/仍不代表已校准的高置信/.test(ha), "available 态仍不宣称高置信");
  check(hn.includes('id="gd-l2-none"'), "none 态第二层显示「尚未个性化」（不假装有第二层）");
  // 第一层在三种态下都必须照常输出（PRD :965 空背景不弃权）
  check(layer1Real(hn) && layer1Real(hl) && layer1Real(ha), "三种 status 下第一层都照常输出（个性化不覆盖书本基线）");
}

// =========================================================================== //
section("[12] 只读：投影不得写盘");

{
  const d = F.makeVault([
    { runId: "rr_ro", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", marker: "ro" },
  ]);
  const before = treeHash(d);
  const rec = await recFor(d);
  const { html } = renderFrom(rec);
  const after = treeHash(d);
  check(before === after, "调用 recommendations() + 渲染后，知识库全树 sha256 未变（零写盘）", `${before} → ${after}`);
  check(isMap(rec.result) && html.length > 0, "（对照）这一轮确实读到了东西（不是空跑）");
}

// =========================================================================== //
reportAndExit();
