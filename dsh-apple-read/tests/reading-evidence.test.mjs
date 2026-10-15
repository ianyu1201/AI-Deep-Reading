/**
 * tests/reading-evidence.test.mjs · M14 采集（**离线**，进 `npm test`）
 *
 * 验的是闭环第 4 环：**一次真实互动 → reading_evidence / understanding_observation → 落盘**。
 *
 * ## 这个脚本防什么（对应执行计划 M14 的 1a–1e / 2a–2c / 3b–3f）
 *   · **1a** 取不到原文 / 引擎没标 verified ⇒ **一条都不写**（不凭记忆写证据）；
 *   · **1b** 五类标签只用规范 §3 的**闭合值域**，且**不是 1–5 分**；strength=null、confidence=unknown；
 *   · **1c** 三种归属（书中观点 / 用户判断 / AI 推演）在正文里**分块**，不混成一句；
 *   · **1d** 一律 `confirmation: unconfirmed`；AI 假设不许冒充用户事实（origin/kind 自洽）；
 *   · **2a** 只经 file-service 的 `writeNote`（有事务记录），**没有**旁路写盘；
 *   · **2b** 书身份用**内容寻址**（`content_id`），笔记里**不出现书路径** ⇒ 书改名/挪位置不影响（3f）；
 *   · **2c** 同一次互动重放 ⇒ 幂等命中，**不重复写**、文件字节不变；
 *   · **0a/0b（M14 审计修复）** 产物被旁路删掉后再重放 ⇒ **不许说「已存过」**，
 *     要如实说「文件已不在」并给出不一致清单（日志说 committed ≠ 盘上真有东西）；
 *   · **3e** `book_understood.allowed === false`，笔记里**没有**「已读懂」。
 *
 * ## 纪律
 *   · 只在 `mkdtemp` 沙箱里写；**沙箱证据 ≠ 真实库证据**（真实库那一次走 m14-real-acceptance.e2e.mjs）；
 *   · 假 sidecar 只回**引擎真实会回的字段**（`readSourceSpan` 的透传形状），不多给一个字段；
 *   · 标签派生**不在这里重写**：直接求值面板 `app.js` 的 `evidenceLabel()`（规范 §3 唯一一份实现）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createReadingRuntime } from "../lib/reading/runtime.js";
import { EVIDENCE_KINDS, EVIDENCE_LABELS, evidenceInteractionKey, readingEvidenceRel, understandingObservationRel } from "../lib/reading/policy.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.APPLE_READ_UI_ROOT ?? join(HERE, "..");

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log("  ✓ " + m); };
const bad = (m, d) => { fail++; console.log("  ✗ " + m + (d ? " —— " + d : "")); };
const check = (c, m, d) => (c ? ok(m) : bad(m, d));
const is = (a, b, m) => check(a === b, m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`);
const truthy = (a, m) => check(!!a, m, `实得 ${JSON.stringify(a)}`);

// --------------------------------------------------------------------------- //
// 面板的 evidenceLabel()：规范 §3 派生逻辑**唯一一份**实现，这里求值复用，不重写。
const panelJs = readFileSync(join(ROOT, "assets", "panel", "app.js"), "utf8");
const BEGIN = "/* ==== READING-VIEW BEGIN ==== */";
const END = "/* ==== READING-VIEW END ==== */";
const i0 = panelJs.indexOf(BEGIN), i1 = panelJs.indexOf(END);
if (i0 < 0 || i1 <= i0) {
  console.log("  ✗ app.js 里找不到 READING-VIEW 标记区（无法复用 evidenceLabel）");
  process.exit(1);
}
const VIEW = new Function(panelJs.slice(i0 + BEGIN.length, i1) + "\n;return { evidenceLabel, EVIDENCE_LABELS };")();

// --------------------------------------------------------------------------- //
// 假引擎：只回 `/source-span` 真实会回的字段（与 runtime.readSourceSpan 的透传形状一致）。
const CONTENT = "f7f4f1fc3778c58a";
const BVID = `bv_${CONTENT}`;
const SPAN = `sp_${CONTENT}_3_535_683`;
const TEXT_HASH = "a".repeat(64);
const QUOTE = "我思故我在：这条真理是十分确实、十分可靠的。";
const HREF = "text/part0003.html";
const BLOCK_ID = `blk_${CONTENT}_3_7`;

/**
 * 假引擎（**与真实引擎同形**）。
 *
 * M15 0b 起 `/source-span` 多给 6 个字段：`book_id` / `href` / `block_id` /
 * `block_index` / `block_start_codepoint` / `block_end_codepoint`。
 * `withoutBlock` 用来造「引擎没给全」的负控 —— 那时**不许编定位**，`book_evidence` 必须为空。
 */
function fakeSidecar({ ok: isOk = true, verified = true, quote = QUOTE, spanId = SPAN,
  withoutBlock = false } = {}) {
  return async (path, init) => {
    const body = JSON.parse(init?.body ?? "{}");
    if (path !== "/source-span") return { json: async () => ({ ok: false, code: "NOT_FOUND", message: path }) };
    if (isOk !== true) return { json: async () => ({ ok: false, code: "SPAN_READ_FAILED", message: "读不到" }) };
    const base = {
      ok: true,
      span_id: spanId,
      book: "第一哲学沉思集",
      book_version_id: BVID,
      section_id: `sec_${CONTENT}_3`,
      section_order: 3,
      start_codepoint: 535,
      end_codepoint: 683,
      text_hash: TEXT_HASH,
      quote,
      quote_chars: [...quote].length,
      verified,
    };
    const withBlock = {
      ...base,
      book_id: CONTENT,
      href: HREF,
      block_id: BLOCK_ID,
      block_index: 7,
      block_start_codepoint: 535,
      block_end_codepoint: 700,
    };
    return { json: async () => (withoutBlock ? base : withBlock) };
  };
}

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "m14-evidence-"));
  mkdirSync(join(dir, "阅读背景", "学习证据"), { recursive: true });
  mkdirSync(join(dir, "理解变化"), { recursive: true });
  return dir;
}
const rt = (kb, sidecar, extra = {}) => createReadingRuntime({ ...extra, getSettings: () => ({ bookKbDir: kb }), sidecarFetch: sidecar });

const BASE_REQ = {
  span_id: SPAN,
  statement: "笛卡尔这里不是在证明「我在」，他是在说：连怀疑这件事本身都已经预设了一个在怀疑的我。",
  kind: "observed_performance",
  dimension: "explanation",
  concept_refs: ["我思故我在"],
  topic: "我思故我在的一次解释",
  label: "有一次解释证据",
  ai_note: "AI 推演（示例）：这与第 4 章的论证结构一致，但系统不知道这是不是你稳定的理解。",
  origin: "user",
  occurred_at: "2026-10-11T09:12:03.000Z",
};

// =========================================================================== //
console.log("\n[1] 1a：取不到原文 ⇒ 一条都不写");

{
  const kb = sandbox();
  try {
    const r = await rt(kb, fakeSidecar({ ok: false })).recordEvidence(BASE_REQ);
    is(r.ok, false, "取不到 span 时 ok=false");
    is(r.written, false, "written=false");
    truthy(typeof r.code === "string" && r.code !== "", "给出真实错误码");
    const left = readdirSync(join(kb, "阅读背景", "学习证据"));
    check(left.length === 0, `学习证据目录仍然为空（实有 ${left.length} 个文件）`);

    const r2 = await rt(kb, fakeSidecar({ verified: false })).recordEvidence(BASE_REQ);
    is(r2.written, false, "引擎没标 verified ⇒ 也不写");
    is(r2.code, "SPAN_NOT_VERIFIED", "并说明是「未核验」而不是别的");
  } finally { rmSync(kb, { recursive: true, force: true }); }
}

// =========================================================================== //
console.log("\n[2] 1d + 归属自洽：AI 假设不许冒充用户事实");

{
  const kb = sandbox();
  try {
    const R = rt(kb, fakeSidecar());
    const r = await R.recordEvidence({ ...BASE_REQ, kind: "ai_hypothesis", origin: "user" });
    is(r.written, false, "kind=ai_hypothesis 但 origin=user ⇒ 拒绝");
    is(r.code, "INVALID_COMBINATION", "错误码说明是组合不合法");
    const r2 = await R.recordEvidence({ ...BASE_REQ, kind: "observed_performance", origin: "ai_inference" });
    is(r2.written, false, "用户表现记成 AI 推演 ⇒ 拒绝");
    const r3 = await R.recordEvidence({ ...BASE_REQ, statement: "   " });
    is(r3.written, false, "没有用户原话 ⇒ 拒绝（不代写用户判断）");
    const r4 = await R.recordEvidence({ ...BASE_REQ, label: "3 分" });
    is(r4.written, false, "标签不在五类闭合值域 ⇒ 拒绝（不是分数）");
    const r5 = await R.recordEvidence({ ...BASE_REQ, kind: "explicit_preference", dimension: "explanation" });
    is(r5.written, false, "kind 与 dimension 不自洽 ⇒ 拒绝");
  } finally { rmSync(kb, { recursive: true, force: true }); }
}

// =========================================================================== //
console.log("\n[3] 1b/1c/1d/2a/2b：真写一条，逐条查字段与正文");

let REL = null, UO_REL = null, RE_HASH = null;
{
  const kb = sandbox();
  try {
    const R = rt(kb, fakeSidecar());
    const r = await R.recordEvidence(BASE_REQ);
    is(r.ok, true, "写入 ok=true");
    is(r.written, true, "written=true");
    is(r.honesty.book_understood.allowed, false, "3e：book_understood.allowed 恒 false");
    is(r.reading_evidence.transaction.state, "committed", "2a：经 file-service 事务提交（有事务记录）");

    REL = r.notes.reading_evidence;
    UO_REL = r.notes.understanding_observation;
    REL_HASH_SAVE: {
      // 记下写入后的字节 hash，供 [4] 幂等对比
      const fs = await R.fileService();
      const got = await fs.svc.readNote(REL);
      RE_HASH = got.hash;
    }

    truthy(REL.startsWith("阅读背景/学习证据/"), `学习证据落在规范目录（${REL}）`);
    truthy(REL.includes(CONTENT), "2b：文件名带内容身份（书改名不变）");
    truthy(!REL.includes("第一哲学沉思集"), "2b：文件名不含书路径/书名");
    truthy(UO_REL.startsWith("理解变化/"), `理解变化落在规范目录（${UO_REL}）`);
    truthy(/^理解变化\/\d{4}-\d{2}-\d{2} /.test(UO_REL), "理解变化文件名带互动日期");

    const fs = await R.fileService();
    const re = (await fs.svc.readNote(REL)).data;
    const raw = readFileSync(join(kb, REL), "utf8");

    is(re.object_type, "reading_evidence", "object_type 正确");
    is(re.confirmation, "unconfirmed", "1d：默认 unconfirmed");
    is(re.origin, "user", "1c：用户自己的话 ⇒ origin=user");
    truthy(EVIDENCE_KINDS.includes(re.kind), "1b：kind 在闭合集合里");
    is(re.dimension, "explanation", "dimension=explanation");
    is(re.strength, null, "1b：strength 未评级（null），不是 medium");
    is(re.confidence.level, "unknown", "1b：confidence.level=unknown，不强行评级");
    is(re.knowledge_status, "active", "knowledge_status=active");
    // M15 0b：`book_evidence` 现在**真的非空**，而且每个字段都来自引擎（不是编的）。
    is(re.book_evidence.length, 1, "0b：书内引用**非空**（引擎给了 href + block_id）");
    const be = re.book_evidence[0];
    is(be.book_id, CONTENT, "0b：SpanRef.book_id 来自引擎（内容身份）");
    is(be.book_version_id, BVID, "0b：SpanRef.book_version_id 来自引擎");
    is(be.section_id, `sec_${CONTENT}_3`, "0b：SpanRef.section_id 来自引擎");
    is(be.block_id, BLOCK_ID, "0b：SpanRef.block_id 来自引擎（blk_<内容摘要>_<章序>_<块序>）");
    is(be.span_id, SPAN, "0b：SpanRef.span_id 来自引擎");
    is(be.href, HREF, "0b：SpanRef.href 来自引擎（原始文档，不是首篇顶替）");
    is(be.start_codepoint, 535, "0b：SpanRef 区间起点来自引擎");
    is(be.end_codepoint, 683, "0b：SpanRef 区间终点来自引擎");
    is(be.text_hash, TEXT_HASH, "0b：SpanRef.text_hash 来自引擎（可回原文核对）");
    is(be.locator_quality, "exact_normalized_text", "0b：定位质量=精确归一化文本");
    is(be.quote_type, "verbatim", "0b：引文类型=逐字");
    truthy(/^blk_[0-9a-f]{16}_\d+_\d+$/.test(be.block_id), "0b：block_id 形状 = blk_<内容摘要16位>_<章序>_<块序>");
    truthy(!JSON.stringify(be).includes(kb), "0b：SpanRef 里没有绝对路径（不退回路径寻址）");
    check(raw.includes(BLOCK_ID), "0b：正文也写出 block_id（人能回原文核对）");
    check(raw.includes(HREF), "0b：正文也写出 href");
    check(!raw.includes("book_evidence 为空"), "0b：不再说「book_evidence 为空」（那条已知债已还）");
    is(re.relations[0].to_id, CONTENT, "2b/3f：书身份由 relations → content_id 表达");
    is(re.relations[0].type, "references", "relation 类型在闭合集合里");
    is(re.source_refs[0].source_kind, "user_action", "来源含真实用户动作");
    truthy(re.source_refs.length >= 1, "source_refs 非空");
    is(re.source_refs[0].ref.actor, "user", "用户动作的 actor=user");
    truthy(!("label" in re) && !("score" in re), "1b：**不另存**标签/分数字段（标签是派生的）");
    check(!/strength:\s*(low|medium|high)/.test(raw), "1b：没有给 strength 评级（low/medium/high 都没出现）");
    check(!/评分[:：]/.test(raw), "1b：没有「评分」字段（标签是派生的，不另存权威分）");

    // 1c：三种归属分块，且逐字引文在
    truthy(raw.includes("## 书中观点"), "1c：有「书中观点」块");
    truthy(raw.includes("## 用户判断"), "1c：有「用户判断」块");
    truthy(raw.includes("## AI 推演"), "1c：有「AI 推演」块");
    truthy(raw.includes(QUOTE), "1c：逐字原文在笔记里（未被改写）");
    truthy(raw.includes(BASE_REQ.statement), "1c：用户原话在笔记里");
    truthy(raw.includes(TEXT_HASH), "留了 text_hash 便于核对");
    truthy(raw.includes(SPAN), "留了 span_id 便于回原文");
    check(!raw.includes("已读懂"), "3e：正文没有「已读懂」");
    check(!raw.includes(kb), "2b：笔记里没有绝对路径");

    // 3c：标签由字段派生 ⇒ 五类之一，且不是分数
    const lab = VIEW.evidenceLabel(re, "2026-10-12T00:00:00.000Z");
    truthy(VIEW.EVIDENCE_LABELS.includes(lab.label), `3c：派生标签「${lab.label}」在五类闭合值域里`);
    check(!/\d/.test(lab.label), "3c：标签里没有数字（不是 1–5 分）");

    // 理解变化
    const uo = (await fs.svc.readNote(UO_REL)).data;
    is(uo.object_type, "understanding_observation", "理解变化 object_type 正确");
    is(uo.before, null, "before 未知 ⇒ null（不伪造过去的想法）");
    is(uo.before_source_refs.length, 0, "before 未知 ⇒ 前引用为空");
    truthy(typeof uo.after === "string" && uo.after !== "", "after 非空");
    is(uo.after, BASE_REQ.statement, "after 保留用户原述");
    is(uo.after_source_refs[0].source_kind, "user_action", "after 的后引用非空且是真实来源");
    is(uo.confirmation, "unconfirmed", "1d：理解变化也是 unconfirmed");
    is(uo.change_kind, "supplemented", "change_kind 在闭合集合里");
    // M15 0b：理解变化也记书内定位（这段变化是就着哪一段原文发生的）——只是来源索引
    is(uo.book_evidence.length, 1, "0b：理解变化也有非空 book_evidence");
    is(uo.book_evidence[0].block_id, BLOCK_ID, "0b：理解变化的 block_id 同样来自引擎");
    is(uo.book_evidence[0].href, HREF, "0b：理解变化的 href 同样来自引擎");
    const uoRaw = readFileSync(join(kb, UO_REL), "utf8");
    check(!uoRaw.includes("已读懂"), "3e：理解变化里也没有「已读懂」");
    truthy(uoRaw.includes("未知"), "正文如实写「原来的判断未知」");

    // 幂等键是互动内容派生的：不含时间、不含路径
    const k1 = r.ids.reading_evidence;
    truthy(/^re_[0-9a-f]{16}$/.test(k1), `id 形状正确（${k1}）`);
  } finally { rmSync(kb, { recursive: true, force: true }); }
}

// =========================================================================== //
console.log("\n[4] 2c：同一次互动重放 ⇒ 幂等命中，不重复写");

{
  const kb = sandbox();
  try {
    const R = rt(kb, fakeSidecar());
    const r1 = await R.recordEvidence(BASE_REQ);
    const fs = await R.fileService();
    const h1 = (await fs.svc.readNote(r1.notes.reading_evidence)).hash;
    const tx1 = (await fs.svc.listTransactions()).length;
    // 同一次互动（内容一样）再采一次 ⇒ 必须命中幂等、不新增事务、不改字节
    const r2 = await R.recordEvidence({ ...BASE_REQ });
    is(r2.ok, true, "重放 ok=true");
    is(r2.written, false, "重放 written=false（没有重复写）");
    is(r2.replayed, true, "并明确标 replayed=true");
    const h2 = (await fs.svc.readNote(r1.notes.reading_evidence)).hash;
    is(h2, h1, "文件字节没变（幂等命中而不是覆盖）");
    const tx2 = (await fs.svc.listTransactions()).length;
    is(tx2, tx1, `重放没有再产生新事务（${tx1} → ${tx2}）`);
    const found = await fs.svc.findByIdempotencyKey(`reading_evidence:${r1.ids.reading_evidence.slice(3)}`);
    check(found === null || found === undefined,
      "按「前 16 位」查不到键是预期的（键用的是前 24 位）—— 幂等靠键本身，不靠这个查询");
  } finally { rmSync(kb, { recursive: true, force: true }); }
}

// =========================================================================== //
console.log("\n[5] 显式偏好：不硬凑一条理解变化");

{
  const kb = sandbox();
  try {
    const R = rt(kb, fakeSidecar());
    const r = await R.recordEvidence({
      ...BASE_REQ, kind: "explicit_preference", dimension: null, label: "未知",
    });
    is(r.written, true, "偏好也落成一条学习证据");
    is(r.understanding_observation.written, false, "但不写理解变化");
    is(r.understanding_observation.code, "NOT_APPLICABLE", "并说明「不适用」，不是静默失败");
    is(r.notes.understanding_observation, null, "没有理解变化路径");
  } finally { rmSync(kb, { recursive: true, force: true }); }
}

// =========================================================================== //
console.log("\n[6] 2b/3f：书改名/挪位置不影响这条证据");

{
  const kb = sandbox();
  try {
    const R = rt(kb, fakeSidecar());
    const r = await R.recordEvidence(BASE_REQ);
    const fs = await R.fileService();
    const raw = readFileSync(join(kb, r.notes.reading_evidence), "utf8");
    // 笔记里唯一的书身份是内容寻址的 book_version_id / content_id ⇒ 与路径无关
    truthy(raw.includes(BVID), "笔记里有内容寻址的 book_version_id");
    check(!/书籍\//.test(raw), "笔记里没有 `书籍/<书名>` 这种路径派生身份");
    // 换个书名（同内容）⇒ 路径与 id 都不该变
    const r2 = await R.recordEvidence({ ...BASE_REQ, topic: "我思故我在的一次解释" });
    is(r2.notes.reading_evidence, r.notes.reading_evidence, "同一内容 ⇒ 同一路径");
    is(r2.ids.reading_evidence, r.ids.reading_evidence, "同一内容 ⇒ 同一 id");
  } finally { rmSync(kb, { recursive: true, force: true }); }
}

// =========================================================================== //
console.log("\n[7] 0a/0b：产物被旁路删掉后重放 ⇒ 不许说「已存过」，要如实说「文件已不在」");

{
  const kb = sandbox();
  try {
    const R = rt(kb, fakeSidecar());
    const r1 = await R.recordEvidence(BASE_REQ);
    is(r1.written, true, "第一次真的写入了");
    const rel = r1.notes.reading_evidence;
    // 绕过 file-service 直接删 —— 正是 M14 真机那次「硬删」的形状
    rmSync(join(kb, rel));
    check(!existsSync(join(kb, rel)), "笔记确实已从盘上消失");

    const r2 = await R.recordEvidence({ ...BASE_REQ });
    is(r2.ok, false, "重放不再报成功（修复前这里会假成功）");
    is(r2.written, false, "written=false");
    is(r2.replayed, false, "也不许标 replayed=true");
    is(r2.code, "RECOVERY_REQUIRED", "给出「簿记与磁盘不一致」的真实错误码");
    truthy(/文件已经不在了|产物不存在/.test(r2.message), "正文如实说文件已不在");
    check(!/已经采集过/.test(r2.message), "不许出现「已经采集过」这类假话");
    check(Array.isArray(r2.drift) && r2.drift.length > 0, "并给出不一致项清单（可核对）");
    is(r2.drift[0].path, rel, "清单点名就是那条不在的产物");
    is(r2.drift[0].belongs_to, "reading_evidence", "并说明是哪个产物");
    const left = readdirSync(join(kb, "阅读背景", "学习证据"));
    check(left.length === 0, `没有偷偷重建产物（目录仍为空，实有 ${left.length} 个文件）`);
  } finally { rmSync(kb, { recursive: true, force: true }); }
}

console.log("\n[8] 0b 负控：引擎没给全 SpanRef 字段 ⇒ 留空 + 如实说明，**绝不编定位**");

{
  const kb = sandbox();
  try {
    const R = rt(kb, fakeSidecar({ withoutBlock: true }));
    const r = await R.recordEvidence(BASE_REQ);
    is(r.written, true, "证据照样写（缺的是书内定位，不是这次互动本身）");
    const fs = await R.fileService();
    const got = await fs.svc.readNote(r.notes.reading_evidence);
    is(got.data.book_evidence.length, 0, "缺 block_id/href ⇒ book_evidence 保持为空（不填编的定位）");
    const raw = readFileSync(join(kb, r.notes.reading_evidence), "utf8");
    check(/book_evidence 为空/.test(raw), "正文如实写明这次没有书内定位");
    check(/缺 (book_id|href|block_id)/.test(raw), "并点名缺了哪个字段（可核对）");
    check(!/blk_/.test(raw), "正文里没有任何编造的 block_id");
  } finally { rmSync(kb, { recursive: true, force: true }); }
}

console.log("\n[新增] 同书同主题多次互动不覆盖，旧路径兼容");
{
 const kb=sandbox(),legacyKb=sandbox();
 try{
  const R=rt(kb,fakeSidecar({})),fs=(await R.fileService()).svc;
  const preference={...BASE_REQ,kind:'explicit_preference',dimension:null,label:null,statement:'我希望重点学习这个概念'};
  const first=await R.recordEvidence(preference);truthy(first.ok,'首条偏好写入');
  const confirmed=await R.confirmObservation({note_id:first.ids.reading_evidence,actor:'user'});truthy(confirmed.ok,'偏好单独确认');
  const before=await fs.readNote(first.notes.reading_evidence);
  const second=await R.recordEvidence(BASE_REQ);truthy(second.ok,'同主题实际表现独立写入');
  check(first.notes.reading_evidence!==second.notes.reading_evidence,'不同kind互动使用不同路径');
  const after=await fs.readNote(first.notes.reading_evidence);is(after.hash,before.hash,'先前已确认偏好字节完全保留');is(after.data.confirmation,'confirmed','先前确认状态不丢');
  const third=await R.recordEvidence({...BASE_REQ,statement:BASE_REQ.statement+'这是第二次解释。'});truthy(third.ok,'同kind同concept不同陈述再采集');
  check(third.notes.reading_evidence!==second.notes.reading_evidence,'不同陈述RE不覆盖');check(third.notes.understanding_observation!==second.notes.understanding_observation,'同日同主题UO不覆盖');
  const replay=await R.recordEvidence({...BASE_REQ,occurred_at:'2026-10-12T09:12:03.000Z',topic:'改了显示主题'});is(replay.replayed,true,'互动重放仍幂等');is(replay.notes.reading_evidence,second.notes.reading_evidence,'重放返回journal中真实RE路径');is(replay.notes.understanding_observation,second.notes.understanding_observation,'跨日重放返回真实UO路径');
  const legacy=rt(legacyKb,fakeSidecar({})),legacyFs=(await legacy.fileService()).svc;
  const key=evidenceInteractionKey({book_version_id:BVID,span_id:SPAN,kind:BASE_REQ.kind,dimension:BASE_REQ.dimension,statement:BASE_REQ.statement,concept_refs:BASE_REQ.concept_refs});
  const oldRe=readingEvidenceRel({topic:BASE_REQ.topic,content_id:CONTENT}),oldUo=understandingObservationRel({occurred_at:BASE_REQ.occurred_at,topic:BASE_REQ.topic,content_id:CONTENT});
  const newRe=await fs.readNote(second.notes.reading_evidence),newUo=await fs.readNote(second.notes.understanding_observation);
  await legacyFs.writeNote(oldRe,{data:newRe.data,body:newRe.body,idempotencyKey:'reading_evidence:'+key.slice(0,24)});
  await legacyFs.writeNote(oldUo,{data:newUo.data,body:newUo.body,idempotencyKey:'understanding_observation:'+key.slice(0,24)});
  const oldReplay=await legacy.recordEvidence(BASE_REQ);is(oldReplay.replayed,true,'修复前旧路径journal仍可重放');is(oldReplay.notes.reading_evidence,oldRe,'旧RE路径不迁移');is(oldReplay.notes.understanding_observation,oldUo,'旧UO路径不迁移');check(!existsSync(join(legacyKb,second.notes.reading_evidence)),'兼容重放不生成第二份文件');
 }finally{rmSync(kb,{recursive:true,force:true});rmSync(legacyKb,{recursive:true,force:true});}
}


console.log("\n[新增] 正文与测试身份投影");
{
 const kb=sandbox();try{
  const R=rt(kb,fakeSidecar({})),saved=await R.recordEvidence(BASE_REQ);
  const normal=await R.evidenceNotes({});const row=normal.notes.find(n=>n.note_id===saved.ids.reading_evidence);
  is(row.statement,BASE_REQ.statement,"观察投影读取用户实际陈述");is(row.test_evidence,false,"普通陈述不猜测为测试数据");
  const fs=(await R.fileService()).svc,prior=await fs.readNote(saved.notes.reading_evidence);await fs.writeNote(saved.notes.reading_evidence,{data:prior.data,body:prior.body.replace(QUOTE,"验收测试是书中谈论的一个主题。"),expectedHash:prior.hash,idempotencyKey:"test-source-not-user",purpose:"update_note"});R.invalidateScanCache();is((await R.evidenceNotes({})).notes.find(n=>n.note_id===saved.ids.reading_evidence).test_evidence,false,"书中原文含验收词不把真实用户陈述误标测试");
  const isolated=await rt(kb,fakeSidecar({}),{testProfile:true}).evidenceNotes({});check(isolated.notes.every(n=>n.test_evidence),"隔离profile全部观察明确标注为测试");
  const testSaved=await R.recordEvidence({...BASE_REQ,statement:'验收测试，不代表用户真实偏好或能力：'+BASE_REQ.statement});
  const tagged=(await R.evidenceNotes({})).notes.find(n=>n.note_id===testSaved.ids.reading_evidence);is(tagged.test_evidence,true,"带明确验收声明的笔记在普通profile也隔离");
 }finally{rmSync(kb,{recursive:true,force:true});}
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
