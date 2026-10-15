/**
 * tests/m15-evidence-to-dimensions.test.mjs · M15 阶段 1：证据 → R/G/T 依据
 *
 * 这一层要证的是**第 5 环真的接上了**：M14 写下的证据笔记，能变成第二层的维度依据，
 * 而且每一分都追得到具体那条笔记（id + 文件 hash），追不到就**留 null**。
 *
 * 全离线（假引擎忠实替身 + 沙箱书库），但走的是**真代码路径**：
 *   `recordEvidence()`（真写盘）→ `analyzeAndPersist()`（真 rank + 真落盘）→ 读回 run 笔记断言。
 *
 * 覆盖：
 *   [1] 1b：一条证据都没有 ⇒ status=none、第二层为空、维度全 null（不是 0）
 *   [2] 1a/1b：有真证据 ⇒ status=limited、第二层有内容、每维带理由、依据追得到 id + hash
 *   [3] 1a：别的书的证据**不能**被这本书用
 *   [4] 1c：未确认观察参与 ⇒ q=0.5（不是 1）
 *   [5] 1g：偏好只作 R 的**范围**依据，不作能力依据；也不把「不同意」翻成负分
 *   [6] 2a：没有个人维度的候选留在第一层，不进第二层（W=0 不进）
 *   [14] 真机缺陷修复：候选覆盖本节**全部**切片（真引擎的形状）时，T 照样给得出来
 *        —— 修复前「证据 span ∉ 候选切片」恒为假 ⇒ T 恒空 ⇒ C 恒 0.714 ⇒ available 不可达
 *
 * 跑法：`node tests/m15-evidence-to-dimensions.test.mjs`
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createReadingRuntime } from "../lib/reading/runtime.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const sha256Hex = (s) => createHash("sha256").update(s, "utf8").digest("hex");

let pass = 0, fail = 0, skipped = 0;
const ok = (m) => { pass++; console.log("  ✓ " + m); };
const bad = (m, d) => { fail++; console.log("  ✗ " + m + (d ? " —— " + d : "")); };
const is = (got, want, m) => (Object.is(got, want) ? ok(m) : bad(m, `期望 ${JSON.stringify(want)}，实得 ${JSON.stringify(got)}`));
const truthy = (v, m, d) => (v ? ok(m) : bad(m, d));
const check = (c, m, d) => (c ? ok(m) : bad(m, d));

// --------------------------------------------------------------------------- //
// 夹具：两本书（A 有证据、B 只用来验「别的书不能用」）
// --------------------------------------------------------------------------- //

/** 按「节 → 若干切片」造一份**与真引擎同形**的分析结果。每节第一条切片就是候选的切片。 */
function buildFixture({ cid, book, sections, candidate_covers_all_slices = false }) {
  const BVM = `bv_${cid}`;
  const slices = [];
  const chapters = [];
  const windows = [];
  const candidates = [];
  for (const sec of sections) {
    const order = sec.order;
    const sectionId = `sec_${cid}_${order}`;
    const winId = `${sectionId}#w0000`;
    const mine = [];
    for (const s of sec.slices) {
      const sl = {
        slice_id: `sp_${cid}_${order}_${s.start}_${s.start + s.text.length}`,
        section_id: sectionId, window_id: winId,
        start_codepoint: s.start, end_codepoint: s.start + s.text.length,
        text: s.text, text_hash: sha256Hex(s.text), quote_type: "sentence", truncated: false,
      };
      mine.push(sl);
      slices.push(sl);
    }
    const allText = mine.map((s) => s.text).join("");
    chapters.push({
      section_id: sectionId, section_order: order, title: sec.title, chars: allText.length,
      window_count: 1, plan_verified: true, consumed_windows: 1, failed_windows: 0,
      window_ids: ["w0000"], status: "analyzed", summary: mine[0].text,
      slice_ids: mine.map((s) => s.slice_id),
    });
    windows.push({
      window_id: winId, section_id: sectionId, index: 0, start_codepoint: 0,
      end_codepoint: allText.length, chars: allText.length, text_hash: sha256Hex(allText),
      status: "processed", consumed: true, summary: mine[0].text, summary_hash: sha256Hex(mine[0].text),
      evidence: { verified: true }, failure_reason: null, queued: false, attempts: 1,
    });
    candidates.push({
      candidate_id: `ca_${cid}_${order}`, section_id: sectionId, section_order: order,
      title: sec.title, summary: mine[0].text,
      slice_ids: candidate_covers_all_slices ? mine.map((s) => s.slice_id) : [mine[0].slice_id],
      window_ids: [winId],
      book_version_id: BVM,
      source_refs: candidate_covers_all_slices ? mine.map((s) => s.slice_id) : [mine[0].slice_id],
      proposed_b: { score: sec.b ?? 2, reason: "代表性论点/必要前提", basis: { kind: "book_analysis" } },
      b_is_proposed: true,
    });
  }
  const totalChars = slices.reduce((a, s) => a + s.text.length, 0);
  return {
    cid, BVM, slices,
    analysis: {
      ok: true, analysis_version: "1.0.0", book, author: "替身作者",
      book_path: `/tmp/替身书库/${book}.epub`, book_version_id: BVM, content_id: cid,
      identity_basis: "content",
      chapters, windows, slices, candidates,
      queue: { pending_window_ids: [], failed_window_ids: [], retry_requires_explicit_schedule: true },
      coverage: {
        scope: "parsed_body", total_units: sections.length, analyzed_units: sections.length,
        failed_units: 0, excluded_units: 0, excluded_reasons: [],
        covered_codepoints: totalChars, total_codepoints: totalChars,
        unknown: { kinds: ["image_pages"], counts_known: false, ratio_known: false, note: "不可知" },
        whole_book_claim_allowed: false, whole_book_percent: null,
      },
      honesty: {
        book_understood: { allowed: false, reason: "恒不可宣称" }, whole_book_claim_allowed: false,
        layers: { extraction: { units: sections.length }, analysis: { units: sections.length }, reading: { known: false } },
      },
      engine: { name: "books_rag.py", lexical_weight: 0.25, rerank_pool: 20, rerank_min_conf: 0.5 },
    },
  };
}

// 书 A：第 0 节有 3 条切片（候选用第一条，另两条用来挂证据），第 1 节只有 1 条。
// 候选那条切片**故意含**「但是 / 前提」这类限制表述 —— T 要用到（且理由里会写明命中了什么）。
const TEXT_A0 = "上帝存在的证明是本书的核心论证，但是这一步依赖一个未证明的前提。";
const TEXT_A0B = "不过这个论证的边界条件还需要另行说明，不能直接当作结论使用。";
const TEXT_A0C = "我对这套论证结构本身很感兴趣，想继续看下去。";
const TEXT_A1 = "灵魂与肉体之间的实在区别需要另行说明。";
const TEXT_A1B = "这一节讨论灵魂与肉体的分别，以及各自的属性。";
const FIX_A = buildFixture({
  cid: "aaaaaaaaaaaaaaaa", book: "A 书",
  sections: [
    { order: 0, title: "第一章", b: 3, slices: [{ start: 0, text: TEXT_A0 }, { start: 40, text: TEXT_A0B }, { start: 80, text: TEXT_A0C }] },
    { order: 1, title: "第二章", b: 1, slices: [{ start: 0, text: TEXT_A1 }, { start: 30, text: TEXT_A1B }] },
  ],
});
const FIX_B = buildFixture({
  cid: "bbbbbbbbbbbbbbbb", book: "B 书",
  sections: [{ order: 0, title: "唯一一章", b: 2, slices: [{ start: 0, text: TEXT_A0 }] }],
});
// 书 C：**与真引擎同形** —— 候选的 `slice_ids` 就是它那一节的**全部切片**。
// 2026-10-11 真机实测：16/16 个候选的「空余切片」都是 0，于是
// 「证据 span ∉ 候选切片」恒为假。夹具必须复现这个形状，否则测不出真机上 T 恒空、
// `available` 不可达的缺陷（`[14]` 就是钉这个的）。
const FIX_C = buildFixture({
  cid: "cccccccccccccccc", book: "C 书", candidate_covers_all_slices: true,
  sections: [{ order: 0, title: "唯一一章", b: 2, slices: [{ start: 0, text: TEXT_A0 }, { start: 40, text: TEXT_A0B }] }],
});

/** 忠实替身：/source-span 按 span_id 查表（形状与真引擎一致，含 0b 的定位字段）。 */
function fakeSidecar() {
  const bySlice = new Map();
  for (const f of [FIX_A, FIX_B, FIX_C]) {
    for (const s of f.slices) {
      const order = Number(s.section_id.slice(-1));
      bySlice.set(s.slice_id, {
        ok: true, span_id: s.slice_id, book: f.analysis.book, book_version_id: f.BVM,
        book_id: f.cid, href: `text/part000${order}.html`,
        block_id: `blk_${f.cid}_${order}_0`, block_index: 0,
        block_start_codepoint: s.start_codepoint, block_end_codepoint: s.end_codepoint,
        section_id: s.section_id, section_order: order,
        start_codepoint: s.start_codepoint, end_codepoint: s.end_codepoint,
        text_hash: s.text_hash, quote: s.text, quote_chars: [...s.text].length, verified: true,
      });
    }
  }
  return async (path, init = {}) => {
    // M15 阶段 3：只读证据清单要按书过滤 ⇒ 先得把路径换成内容身份（与真引擎同形）。
    if (path.startsWith("/book-identity")) {
      const p = new URL("http://x" + path).searchParams.get("path") ?? "";
      const f = [FIX_A, FIX_B, FIX_C].find((x) => x.analysis.book_path === p);
      if (!f) return { ok: false, status: 200, json: async () => ({ ok: false, code: "BOOK_NOT_FOUND" }) };
      return {
        ok: true, status: 200,
        json: async () => ({ ok: true, book_version_id: f.BVM, book_id: f.cid, book: f.analysis.book }),
      };
    }
    if (path === "/source-span") {
      const { span_id: sid } = JSON.parse(init.body ?? "{}");
      const hit = bySlice.get(sid);
      if (!hit) return { ok: false, status: 200, json: async () => ({ ok: false, code: "SPAN_BOOK_NOT_FOUND" }) };
      return { ok: true, status: 200, json: async () => hit };
    }
    if (path === "/analyze-chapter") {
      const { book } = JSON.parse(init.body ?? "{}");
      const f = book === FIX_A.analysis.book ? FIX_A
        : book === FIX_B.analysis.book ? FIX_B
          : book === FIX_C.analysis.book ? FIX_C : null;
      if (f === null) return { ok: false, status: 404, json: async () => ({ ok: false, code: "NOT_FOUND" }) };
      return { ok: true, status: 200, json: async () => f.analysis };
    }
    return { ok: false, status: 404, json: async () => ({ ok: false, code: "NOT_FOUND" }) };
  };
}

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "m15-dim-"));
  mkdirSync(join(dir, "阅读背景", "学习证据"), { recursive: true });
  mkdirSync(join(dir, "理解变化"), { recursive: true });
  mkdirSync(join(dir, "推荐反馈"), { recursive: true });
  return dir;
}
const rt = (kb, extra={}) => createReadingRuntime({ ...extra, getSettings: () => ({ bookKbDir: kb }), sidecarFetch: fakeSidecar() });

/** 记一条证据（走真 `recordEvidence`，真写盘）。`label` 只能取五类规范标签之一。 */
async function record(R, { span_id, kind, dimension, statement, topic, label, origin = "user" }) {
  return R.recordEvidence({
    span_id, kind, dimension, statement, topic,
    concept_refs: ["论证"], label,
    ai_note: "AI 推演（示例）：仅供对照，不冒充用户事实。",
    origin, occurred_at: "2026-10-11T09:12:03.000Z",
  });
}

/** 读回这本书**唯一**的那条理解笔记。 */
async function readRunNote(R, kb) {
  const fs = await R.fileService();
  const files = readdirSync(join(kb, "推荐反馈")).filter((f) => f.endsWith(".md"));
  if (files.length !== 1) throw new Error(`期望恰好一条理解笔记，实得 ${files.length}：${files.join(",")}`);
  const rel = `推荐反馈/${files[0]}`;
  const got = await fs.svc.readNote(rel);
  return { rel, data: got.data, hash: got.hash, raw: readFileSync(join(kb, rel), "utf8") };
}

const sliceOf = (f, order, i) => f.slices.filter((s) => s.section_id.endsWith(`_${order}`))[i];

// =========================================================================== //
console.log("\n[1] 1b：一条证据都没有 ⇒ status=none、第二层为空、维度全 null（不填 0）");

{
  const kb = sandbox();
  try {
    const R = rt(kb);
    const persisted = await R.analyzeAndPersist({ book: FIX_A.analysis.book });
    is(persisted.ok, true, `整理成功（${persisted.code ?? ""} ${persisted.message ?? ""}）`);
    const run = await readRunNote(R, kb);
    is(run.data.personalization_status, "none", "没有个人可用维度 ⇒ status=none");
    is(run.data.personalized_items.length, 0, "第二层为空（不硬凑候选）");
    truthy(run.data.book_guide.items.length > 0, "第一层照常有内容（基线不受影响）");
    check(!/已读懂/.test(run.raw), "正文没有「已读懂」");
  } finally { rmSync(kb, { recursive: true, force: true }); }
}

// =========================================================================== //
console.log("\n[2] 1a/1b：有真证据 ⇒ status=limited、第二层有内容、每维带理由、依据追得到 id + hash");

let EVID = null;
{
  const kb = sandbox();
  try {
    const R = rt(kb);
    // 三条证据都挂在**第 0 节**上（同书同节 ⇒ 才能当这一节的依据）
    const rExp = await record(R, {
      span_id: sliceOf(FIX_A, 0, 1).slice_id, kind: "observed_performance", dimension: "explanation",
      statement: "我的理解是：他先立一个不可怀疑的点，再从那里往外推。", topic: "一次解释", label: "有一次解释证据",
    });
    const rApp = await record(R, {
      span_id: sliceOf(FIX_A, 0, 2).slice_id, kind: "observed_performance", dimension: "application",
      statement: "我在别的地方也用过这个推法。", topic: "一次迁移", label: "有迁移证据",
    });
    const rPref = await record(R, {
      span_id: sliceOf(FIX_A, 0, 0).slice_id, kind: "explicit_preference", dimension: null,
      statement: "我对这类论证结构有兴趣。", topic: "偏好", label: "未知",
    });
    for (const [name, r] of [["解释", rExp], ["迁移", rApp], ["偏好", rPref]]) {
      is(r.written, true, `${name}证据真的写下来了`);
    }
    EVID = {
      exp: rExp.ids.reading_evidence, app: rApp.ids.reading_evidence, pref: rPref.ids.reading_evidence,
    };

    const persisted = await R.analyzeAndPersist({ book: FIX_A.analysis.book });
    is(persisted.ok, true, `整理成功（${persisted.code ?? ""} ${persisted.message ?? ""}）`);
    const run = await readRunNote(R, kb);

    is(run.data.personalization_status, "limited", "有未确认观察参与 ⇒ limited（不是 available）");
    truthy(run.data.personalized_items.length >= 1, `第二层有内容（${run.data.personalized_items.length} 条）`);
    const item = run.data.personalized_items.find((x) => x.candidate_id === `ca_${FIX_A.cid}_0`);
    truthy(item !== undefined, "第 0 节那条候选进了第二层");

    // 每维都要有理由 + 依据（PRD :271：不能仅给数字）
    for (const d of ["R", "G", "T"]) {
      const de = item.dimension_evidence[d];
      truthy(de !== undefined, `${d} 有依据块（不是裸数字）`);
      if (!de) continue;
      truthy(typeof de.reason === "string" && de.reason.length > 0, `${d} 带理由`);
      truthy(Array.isArray(de.evidence_refs) && de.evidence_refs.length > 0, `${d} 带 evidence_refs`);
      truthy(Number.isInteger(item.scores[d]) && item.scores[d] >= 0 && item.scores[d] <= 3,
        `${d} 分值在 0—3（实得 ${item.scores[d]}）`);
    }
    truthy(item.dimension_evidence.G.reason.includes(EVID.exp) && item.dimension_evidence.G.reason.includes(EVID.app),
      "G 的理由点名了那两条「具体表现」笔记 id");
    truthy(/前提待补/.test(item.dimension_evidence.G.reason), "G 的理由把缺口限定在「前提待补」");
    check(!/已掌握/.test(item.dimension_evidence.G.reason), "G 的理由没有说「已掌握」");
    truthy(item.dimension_evidence.T.reason.includes(EVID.exp), "T 的理由点名了那条「解释」笔记 id");
    truthy(item.dimension_evidence.R.evidence_refs.includes(EVID.pref), "R 的依据里有那条偏好笔记 id");
    truthy(/启发式/.test(item.dimension_evidence.T.reason), "T 的理由如实写明是启发式匹配（不冒充语义判定）");
    truthy(/同源/.test(item.dimension_evidence.T.reason), "T 如实写明与 G 依据同源（不假装是两个独立证据）");

    // 1a：依据必须追得到 id + **文件 hash**（hash 由测试自己从盘上重算，不信任何自报）
    const fs = await R.fileService();
    const evDir = join(kb, "阅读背景", "学习证据");
    const byId = new Map();
    for (const f of readdirSync(evDir)) {
      const rel = `阅读背景/学习证据/${f}`;
      const got = await fs.svc.readNote(rel);
      if (got?.data?.id) byId.set(got.data.id, { rel, got });
    }
    const allRefs = [...new Set(["R", "G", "T"].flatMap((d) => item.dimension_evidence[d]?.evidence_refs ?? []))];
    truthy(allRefs.length >= 3, `三个维度合计 ${allRefs.length} 条依据引用`);
    for (const ref of allRefs) {
      truthy(run.data.input_manifest_refs.includes(`note:${ref}`), `依据 ${ref} 出现在 input_manifest_refs 里`);
      const hit = byId.get(ref);
      truthy(hit !== undefined, `依据 ${ref} 在盘上有对应的证据笔记文件`);
      if (!hit) continue;
      const diskHash = createHash("sha256").update(readFileSync(join(kb, hit.rel))).digest("hex");
      is(diskHash, hit.got.hash, `依据 ${ref} 的 id 与文件 hash 对得上（${diskHash.slice(0, 12)}…）`);
      truthy(/reading_evidence|understanding_observation/.test(String(hit.got.data.object_type)),
        `依据 ${ref} 确实是证据笔记（${hit.got.data.object_type}）`);
    }
    // 笔记正文里也要有「为什么用了这条」，不是只留个 id
    truthy(run.raw.includes(EVID.exp) || run.raw.includes(EVID.pref) || run.raw.includes(EVID.app),
      "理解笔记正文里留下了被用到的证据 id");

    // 2a/2c：第 1 节没有任何证据 ⇒ 那条候选不进第二层（W=0 留在第一层）
    check(!run.data.personalized_items.some((x) => x.candidate_id === `ca_${FIX_A.cid}_1`),
      "没有依据的候选不进第二层（W=0 只留在第一层）");
    truthy(run.data.book_guide.items.some((x) => x.candidate_id === `ca_${FIX_A.cid}_1`),
      "它仍在第一层（没有因为没依据就被丢掉）");
  } finally { rmSync(kb, { recursive: true, force: true }); }
}

// =========================================================================== //
console.log("\n[3] 1a：别的书的证据**不能**被这本书用");

{
  const kb = sandbox();
  try {
    const R = rt(kb);
    // 证据挂在 B 书的 span 上 ⇒ 写出来的笔记属于 B 书
    const rB = await record(R, {
      span_id: sliceOf(FIX_B, 0, 0).slice_id, kind: "self_report", dimension: "familiarity",
      statement: "B 书这边我只是听说过。", topic: "B 书自报熟悉", label: "自报熟悉",
    });
    is(rB.written, true, "B 书的证据写下来了");
    const persisted = await R.analyzeAndPersist({ book: FIX_A.analysis.book });
    is(persisted.ok, true, `整理 A 书成功（${persisted.code ?? ""} ${persisted.message ?? ""}）`);
    const run = await readRunNote(R, kb);
    is(run.data.personalization_status, "none", "A 书拿不到 B 书的证据 ⇒ 仍是 none");
    is(run.data.personalized_items.length, 0, "第二层为空（没有跨书借用）");
    check(!run.raw.includes(rB.ids.reading_evidence), "A 书的笔记里**没有**出现 B 书那条证据的 id");
  } finally { rmSync(kb, { recursive: true, force: true }); }
}

// =========================================================================== //
console.log("\n[4] 1c：未确认观察参与 ⇒ q=0.5（不是 1）");

{
  const kb = sandbox();
  try {
    const R = rt(kb);
    const r = await record(R, {
      span_id: sliceOf(FIX_A, 0, 1).slice_id, kind: "observed_performance", dimension: "explanation",
      statement: "我的理解是这样。", topic: "一次解释", label: "有一次解释证据",
    });
    is(r.written, true, "证据已写下");
    const persisted = await R.analyzeAndPersist({ book: FIX_A.analysis.book });
    is(persisted.ok, true, `整理成功（${persisted.code ?? ""} ${persisted.message ?? ""}）`);
    const run = await readRunNote(R, kb);
    truthy(run.data.personalized_items.length >= 1, "第二层有内容");
    const item = run.data.personalized_items[0];
    is(item.scores.q, 0.5, "依据来自 unconfirmed 观察 ⇒ q=0.5");
    check(item.scores.C < 1, `只覆盖一个维度 ⇒ C<1（实得 ${item.scores.C}）`);
    is(run.data.personalization_status, "limited", "C<1 且 q=0.5 ⇒ limited");
    check(!/高置信|已掌握/.test(run.raw), "正文没有「高置信 / 已掌握」这类话");
  } finally { rmSync(kb, { recursive: true, force: true }); }
}

// =========================================================================== //
console.log("\n[5] 1g：偏好只作 R 的**范围**依据，不作能力依据；「不同意」不翻成负分");

{
  const kb = sandbox();
  try {
    const R = rt(kb);
    const r = await record(R, {
      span_id: sliceOf(FIX_A, 0, 0).slice_id, kind: "explicit_preference", dimension: null,
      statement: "我对这个主题有兴趣。", topic: "偏好", label: "未知",
    });
    is(r.written, true, "偏好证据已写下");
    const persisted = await R.analyzeAndPersist({ book: FIX_A.analysis.book });
    is(persisted.ok, true, `整理成功（${persisted.code ?? ""} ${persisted.message ?? ""}）`);
    const run = await readRunNote(R, kb);
    const item = run.data.personalized_items[0];
    truthy(item.dimension_evidence.R !== undefined, "偏好给出的是 R（范围）依据");
    is(item.dimension_evidence.G, undefined, "偏好**不给** G（不作能力依据）");
    is(item.dimension_evidence.T, undefined, "偏好**不给** T");
    truthy(/兴趣范围|偏好/.test(item.dimension_evidence.R.reason), "R 的理由如实说这是兴趣范围");
    truthy(/只界定\*\*兴趣范围\*\*|不当能力依据/.test(item.dimension_evidence.R.reason),
      "R 的理由明说偏好只界定兴趣范围、不当能力依据");
    check(!/你的能力|能力较强|已掌握/.test(item.dimension_evidence.R.reason), "R 的理由没有把它说成能力结论");
    // 三态域：只有 R ⇒ C=3/7 ⇒ limited（不是 available，也不是 none）
    is(run.data.personalization_status, "limited", "只有范围依据 ⇒ limited");
  } finally { rmSync(kb, { recursive: true, force: true }); }
}

// =========================================================================== //
console.log("\n[6] 目标（本次明确目标）也能给 R，且与证据给的 R 合并而不是各算一份");

{
  const kb = sandbox();
  try {
    const R = rt(kb);
    const r = await record(R, {
      span_id: sliceOf(FIX_A, 0, 0).slice_id, kind: "explicit_preference", dimension: null,
      statement: "我对这个主题有兴趣。", topic: "偏好", label: "未知",
    });
    is(r.written, true, "偏好证据已写下");
    const persisted = await R.analyzeAndPersist({
      book: FIX_A.analysis.book, goal: { ref: "goal:current", text: "我想搞清楚这个论证的前提是什么" },
    });
    is(persisted.ok, true, `带目标整理成功（${persisted.code ?? ""} ${persisted.message ?? ""}）`);
    const run = await readRunNote(R, kb);
    const item = run.data.personalized_items.find((x) => x.candidate_id === `ca_${FIX_A.cid}_0`);
    truthy(item !== undefined, "第 0 节候选进了第二层");
    const refs = item.dimension_evidence.R.evidence_refs;
    truthy(refs.includes("goal:current"), "R 依据里有本次目标");
    truthy(refs.includes(r.ids.reading_evidence), "R 依据里也有那条偏好笔记（合并成一份 R，不是两份）");
    truthy(item.scores.R >= 2, `R 分值来自真实重合（实得 ${item.scores.R}）`);
    check(!run.raw.includes("已读懂"), "正文没有「已读懂」");
  } finally { rmSync(kb, { recursive: true, force: true }); }
}

// =========================================================================== //
console.log("\n[7] 负控：只有「自报熟悉」时，G **不能**有分值（自报不算具体表现）");

{
  const kb = sandbox();
  try {
    const R = rt(kb);
    const r = await record(R, {
      span_id: sliceOf(FIX_A, 0, 1).slice_id, kind: "self_report", dimension: "familiarity",
      statement: "我只是熟悉这个名字。", topic: "自报熟悉", label: "自报熟悉",
    });
    is(r.written, true, "自报熟悉证据写下来了");
    const persisted = await R.analyzeAndPersist({ book: FIX_A.analysis.book });
    is(persisted.ok, true, `整理成功（${persisted.code ?? ""} ${persisted.message ?? ""}）`);
    const run = await readRunNote(R, kb);
    is(run.data.personalization_status, "none", "自报熟悉撑不起任何维度 ⇒ status=none");
    is(run.data.personalized_items.length, 0, "第二层为空（不硬凑）");
    check(!/G_WITHOUT_OBSERVED_PERFORMANCE/.test(persisted.message ?? ""),
      "不是靠「报错后放弃」绕过去的，而是压根没给 G");
    is(readdirSync(join(kb, "阅读背景", "学习证据")).length, 1,
      "那条证据仍然留在库里（只是不参与评分，没被删）");
  } finally { rmSync(kb, { recursive: true, force: true }); }
}

// =========================================================================== //
console.log("\n[8] 负控：本节没有「冲突/限制」字面时，T **不能**有分值（G 照给）");

{
  const kb = sandbox();
  try {
    const R = rt(kb);
    // 挂第 1 节的证据上；第 1 节**没有**限制/转折字面 ⇒ T 缺的只有「书中限制」这一件
    const r = await record(R, {
      span_id: sliceOf(FIX_A, 1, 1).slice_id, kind: "observed_performance", dimension: "explanation",
      statement: "我的理解是这样。", topic: "第二章一次解释", label: "有一次解释证据",
    });
    is(r.written, true, "第 1 节的解释证据写下来了");
    const persisted = await R.analyzeAndPersist({ book: FIX_A.analysis.book });
    is(persisted.ok, true, `整理成功（${persisted.code ?? ""} ${persisted.message ?? ""}）`);
    const run = await readRunNote(R, kb);
    const item = run.data.personalized_items.find((x) => x.candidate_id === `ca_${FIX_A.cid}_1`);
    truthy(item !== undefined, "第 1 节候选进了第二层（G 有具体表现依据）");
    truthy(item.dimension_evidence.G !== undefined, "G 有依据");
    is(item.dimension_evidence.T, undefined, "本节没有限制/转折字面 ⇒ T 保持 null，不硬给分");
    is(item.dimension_evidence.R, undefined, "本次没给目标 ⇒ R 也保持 null");
  } finally { rmSync(kb, { recursive: true, force: true }); }
}

// =========================================================================== //
console.log("\n[9] 2a：确认之后 `available` **真的可达**（C=1 且 q=1）");

{
  const kb = sandbox();
  try {
    const R = rt(kb);
    const r = await record(R, {
      span_id: sliceOf(FIX_A, 0, 1).slice_id, kind: "observed_performance", dimension: "explanation",
      statement: "我的理解是：他先立一个不可怀疑的点，再从那里往外推。", topic: "一次解释", label: "有一次解释证据",
    });
    is(r.written, true, "具体表现证据写下来了");

    // 确认之前：未确认观察参与 ⇒ q=0.5 ⇒ 只能到 limited
    const before = await R.analyzeAndPersist({
      book: FIX_A.analysis.book, goal: { ref: "goal:current", text: "我想搞清楚这个论证的前提和证明步骤" },
    });
    is(before.ok, true, `确认前整理成功（${before.code ?? ""} ${before.message ?? ""}）`);
    const runBefore = await readRunNote(R, kb);
    is(runBefore.data.personalization_status, "limited", "确认前：q=0.5 ⇒ limited");
    is(runBefore.data.personalized_items[0].scores.q, 0.5, "确认前 q=0.5");

    // 确认这条观察
    const c = await R.confirmObservation({ note_id: r.ids.reading_evidence, at: "2026-10-12T10:00:00.000Z" });
    is(c.ok, true, `确认成功（${c.code ?? ""} ${c.message ?? ""}）`);
    is(c.changed, true, "确实写盘了（changed=true）");
    is(c.confirmation, "confirmed", "confirmation=confirmed");
    truthy(c.confirmation_evidence?.action_id && c.confirmation_evidence?.at && c.confirmation_evidence?.scope,
      "带真实 action_id / at / scope（模型不能代填）");
    truthy(/不等于高置信|不代表高置信|≠ 高置信/.test(c.honesty?.does_not_mean ?? ""), "回执里如实写明「确认 ≠ 高置信」");

    // 确认之后：C=1 且 q=1 ⇒ available
    const after = await R.analyzeAndPersist({
      book: FIX_A.analysis.book, goal: { ref: "goal:current", text: "我想搞清楚这个论证的前提和证明步骤" },
    });
    is(after.ok, true, `确认后整理成功（${after.code ?? ""} ${after.message ?? ""}）`);
    const runAfter = await readRunNote(R, kb);
    const item = runAfter.data.personalized_items.find((x) => x.candidate_id === `ca_${FIX_A.cid}_0`);
    truthy(item !== undefined, "第 0 节候选进了第二层");
    is(item.scores.q, 1, "确认后 q=1");
    is(item.scores.C, 1, `确认后 C=1（实得 ${item.scores.C}）`);
    is(runAfter.data.personalization_status, "available", "⇒ personalization_status=available（三态真的可达）");
    is(runAfter.data.revision, runBefore.data.revision + 1, "复算仍覆盖同一条笔记、revision 递增");
    // 2b：available 必须在**正文里**明说不等于校准过的高置信
    truthy(/仍不代表已校准的高置信/.test(runAfter.raw), "正文写明「仍不代表已校准的高置信」（available ≠ 高置信）");
    // 2e：任何情况下都不得宣称「已读懂」
    check(!/已读懂/.test(runAfter.raw), "正文没有「已读懂」");
    check(!/已掌握/.test(runAfter.raw), "正文没有「已掌握」");
  } finally { rmSync(kb, { recursive: true, force: true }); }
}

// =========================================================================== //
console.log("\n[10] 1f：确认**不改 origin**（AI 假设确认后仍是 AI 假设）");

{
  const kb = sandbox();
  try {
    const R = rt(kb);
    const r = await record(R, {
      span_id: sliceOf(FIX_A, 0, 1).slice_id, kind: "ai_hypothesis", dimension: "explanation",
      statement: "AI 推演：这一步可能预设了上帝存在的证明。", topic: "AI 假设", label: "待复核",
      origin: "ai_inference",
    });
    is(r.written, true, `AI 假设写下来了（${r.code ?? ""} ${r.message ?? ""}）`);
    const noteId = r.ids.reading_evidence;
    const c = await R.confirmObservation({ note_id: noteId, at: "2026-10-12T10:05:00.000Z" });
    is(c.ok, true, "确认动作本身成功");
    is(c.origin, "ai_inference", "origin **没有**被改成 user（AI 假设不会变成用户事实）");
    const fs = await R.fileService();
    const scan = await R.scanVault();
    const rel = scan.notes.find((n) => n.id === noteId).rel;
    const got = await fs.svc.readNote(rel);
    is(got.data.origin, "ai_inference", "盘上 origin 仍是 ai_inference");
    is(got.data.confirmation, "confirmed", "但 confirmation 确实是 confirmed");
  } finally { rmSync(kb, { recursive: true, force: true }); }
}

// =========================================================================== //
console.log("\n[11] 幂等：重复确认不重复写（revision 不再涨、文件 hash 不变）");

{
  const kb = sandbox();
  try {
    const R = rt(kb);
    const r = await record(R, {
      span_id: sliceOf(FIX_A, 0, 1).slice_id, kind: "observed_performance", dimension: "explanation",
      statement: "我的理解是这样。", topic: "一次解释", label: "有一次解释证据",
    });
    const noteId = r.ids.reading_evidence;
    const c1 = await R.confirmObservation({ note_id: noteId, at: "2026-10-12T10:10:00.000Z" });
    is(c1.changed, true, "第一次确认写了盘");
    const fs = await R.fileService();
    const scan1 = await R.scanVault();
    const rel = scan1.notes.find((n) => n.id === noteId).rel;
    const after1 = await fs.svc.readNote(rel);
    const c2 = await R.confirmObservation({ note_id: noteId, at: "2026-10-12T10:20:00.000Z" });
    is(c2.ok, true, "第二次确认也返回 ok");
    is(c2.changed, false, "但 changed=false（没有重复写）");
    truthy(/已经确认过/.test(c2.message ?? ""), "并如实说明「已经确认过了」");
    const after2 = await fs.svc.readNote(rel);
    is(after2.hash, after1.hash, "文件 hash 没变（没写第二次）");
    is(after2.data.revision, after1.data.revision, "revision 也没涨");
  } finally { rmSync(kb, { recursive: true, force: true }); }
}

// =========================================================================== //
console.log("\n[12] 确认只认证据笔记：别的对象类型 / 不存在的 id 一律拒绝");

{
  const kb = sandbox();
  try {
    const R = rt(kb);
    const bad = await R.confirmObservation({ note_id: "re_不存在" });
    is(bad.ok, false, "不存在的 id ⇒ 拒绝");
    is(bad.code, "NOTE_NOT_FOUND", "并给出 NOTE_NOT_FOUND");
    is(bad.changed, false, "没有写盘");
    const missing = await R.confirmObservation({});
    is(missing.ok, false, "不给 note_id ⇒ 拒绝");
    is(missing.code, "MISSING_REQUIRED", "并给出 MISSING_REQUIRED");
  } finally { rmSync(kb, { recursive: true, force: true }); }
}

// =========================================================================== //
console.log("\n[13] 阶段 3：只读证据清单 evidenceNotes（面板「确认这条观察」的前置）");

{
  const kb = sandbox();
  try {
    const R = rt(kb);
    const rA = await record(R, {
      span_id: sliceOf(FIX_A, 0, 1).slice_id, kind: "observed_performance", dimension: "explanation",
      statement: "我的理解是：他先立一个不可怀疑的点，再从那里往外推。", topic: "一次解释", label: "有一次解释证据",
    });
    const rB = await record(R, {
      span_id: sliceOf(FIX_B, 0, 0).slice_id, kind: "self_report", dimension: "familiarity",
      statement: "B 书这边我只是听说过。", topic: "B 书自报熟悉", label: "自报熟悉",
    });
    is(rA.written, true, "A 书证据写下来了");
    is(rB.written, true, "B 书证据写下来了");

    // 全库口径（不给 path）：如实标「未按书过滤」
    const all = await R.evidenceNotes();
    is(all.ok, true, "全库口径读取成功");
    is(all.read_only, true, "明确标 read_only");
    is(all.book_scoped, false, "不给 path ⇒ book_scoped=false（如实标未按书过滤）");
    check(all.count >= 4, `全库至少 4 条证据（A/B 各 1 条学习证据 + 1 条理解变化；实得 ${all.count}）`);
    check(typeof all.now === "string" && !Number.isNaN(Date.parse(all.now)), "带 now（面板据此判过期，不读系统时钟）");
    truthy(/已掌握/.test(all.honesty?.does_not_mean ?? ""), "回执里如实写明「有证据 ≠ 已掌握」");

    // 按书口径：只列 A 书
    const scoped = await R.evidenceNotes({ book_path: FIX_A.analysis.book_path });
    is(scoped.ok, true, "按 A 书读取成功");
    is(scoped.book_scoped, true, "book_scoped=true");
    is(scoped.book_version_id, FIX_A.BVM, "书身份是内容寻址的 book_version_id");
    check(scoped.count >= 2, `只列 A 书的证据（实得 ${scoped.count}）`);
    check(scoped.notes.every((n) => n.book_version_id === FIX_A.BVM), "A 书清单里每一条都属于 A 书");
    check(!scoped.notes.some((n) => n.note_id === rB.ids.reading_evidence), "B 书的证据 id **不在** A 书清单里");

    const nA = scoped.notes.find((n) => n.note_id === rA.ids.reading_evidence);
    truthy(nA !== undefined, "A 书那条学习证据在清单里（面板拿它渲染确认按钮）");
    is(nA.kind, "observed_performance", "kind 原样给出（面板派生五类标签要用）");
    is(nA.dimension, "explanation", "dimension 原样给出");
    is(nA.origin, "user", "origin 原样给出");
    is(nA.confirmation, "unconfirmed", "confirmation 原样给出（面板据此显示当前状态）");
    is(nA.knowledge_status, "active", "knowledge_status 原样给出");
    check(typeof nA.assessment_basis === "string" && nA.assessment_basis.length > 0, "assessment_basis 给出（否则派生不出标签）");
    check(Array.isArray(nA.source_refs) && nA.source_refs.length > 0, "source_refs 给出（否则派生不出标签）");
    check(typeof nA.content_hash === "string" && nA.content_hash.length === 64, "带文件 hash（可回盘核对）");
    is(nA.valid_until, null, "valid_until 原样给出（面板据此判过期）");

    // 理解变化也算证据（uo → self_report 是**唯一一份**映射，面板与引擎共用）
    const uoA = scoped.notes.find((n) => n.object_type === "understanding_observation");
    truthy(uoA !== undefined, "A 书的理解变化也在清单里");
    is(uoA.kind, "self_report", "理解变化按唯一映射归 self_report（没有 kind 字段）");
    check(Array.isArray(uoA.source_refs) && uoA.source_refs.length > 0, "理解变化的来源引用取自 after_source_refs（可核验）");

    // 只读：读一遍不产生/改写任何文件
    const evDir = join(kb, "阅读背景", "学习证据");
    const before = readdirSync(evDir).length;
    await R.evidenceNotes({ book_path: FIX_A.analysis.book_path });
    is(readdirSync(evDir).length, before, "evidenceNotes 是只读的（没新增任何证据文件）");
    check(/^我的理解是/.test(nA.statement), "确认前投影显示实际陈述（2026-10-12新展示合同）");

    // 确认后：再读清单，confirmation 跟着变（同一份只读投影，面板据此刷新）
    const c = await R.confirmObservation({ note_id: rA.ids.reading_evidence, at: "2026-10-12T10:00:00.000Z" });
    is(c.changed, true, "确认写盘");
    const scoped2 = await R.evidenceNotes({ book_path: FIX_A.analysis.book_path });
    is(scoped2.notes.find((n) => n.note_id === rA.ids.reading_evidence).confirmation, "confirmed",
      "再读清单：confirmation 已变 confirmed");
  } finally { rmSync(kb, { recursive: true, force: true }); }
}

// 身份定不出来 ⇒ **不回退**成列全部（拿别的书的证据顶替就是撒谎）
{
  const kb = sandbox();
  try {
    const R = createReadingRuntime({ getSettings: () => ({ bookKbDir: kb }), sidecarFetch: null });
    const r = await R.evidenceNotes({ book_path: "/x/不存在.epub" });
    is(r.ok, false, "引擎不在 ⇒ 定不出身份，ok:false");
    is(r.code, "SIDECAR_UNAVAILABLE", "如实报 SIDECAR_UNAVAILABLE");
    is(r.book_scoped, true, "仍是按书口径");
    is(r.notes.length, 0, "**不回退**成列全部（宁可不列，也不拿别的书的证据顶替）");
  } finally { rmSync(kb, { recursive: true, force: true }); }
}

// =========================================================================== //
console.log("\n[14] 真机缺陷修复：候选覆盖本节**全部**切片时，T 照样给得出来（否则 available 永不可达）");

{
  const kb = sandbox();
  try {
    const R = rt(kb);
    // 与真机同形：候选的 slice_ids = 本节全部切片 ⇒ 「证据 span 不是候选切片」恒为假
    const candC = FIX_C.analysis.candidates[0];
    is(candC.slice_ids.length, FIX_C.slices.length, "夹具与真引擎同形：候选覆盖本节全部切片");
    // 证据**故意挂在候选自己的切片上** —— 真机上只能这么挂，修复前 T 因此恒空
    const rExp = await record(R, {
      span_id: candC.slice_ids[0], kind: "observed_performance", dimension: "explanation",
      statement: "我的理解是：他先立一个不可怀疑的点，再从那里往外推。", topic: "真机同形一次解释", label: "有一次解释证据",
    });
    const rPref = await record(R, {
      span_id: candC.slice_ids[0], kind: "explicit_preference", dimension: null,
      statement: "我对这类论证结构有兴趣。", topic: "真机同形偏好", label: "未知",
    });
    is(rExp.written, true, "解释证据写下来了");
    is(rPref.written, true, "偏好证据写下来了");

    const before = await R.analyzeAndPersist({ book: FIX_C.analysis.book });
    is(before.ok, true, `整理成功（${before.code ?? ""} ${before.message ?? ""}）`);
    const runBefore = await readRunNote(R, kb);
    const itemBefore = runBefore.data.personalized_items.find((x) => x.candidate_id === candC.candidate_id);
    truthy(itemBefore !== undefined, "候选进了第二层");
    truthy(itemBefore.dimension_evidence.T !== undefined,
      "T 给得出来（不再要求「证据 span 不是候选自己的切片」）");
    is(itemBefore.scores.T, 2, "T 有分值 2（修复前这里是 null）");
    is(itemBefore.scores.C, 1, `W=0.70/0.70 ⇒ C=1（修复前只有 0.714，实得 ${itemBefore.scores.C}）`);
    is(runBefore.data.personalization_status, "limited", "未确认 ⇒ q=0.5 ⇒ 仍是 limited（不越过确认这一步）");

    for (const id of [rExp.ids.reading_evidence, rPref.ids.reading_evidence]) {
      const c = await R.confirmObservation({ note_id: id, at: "2026-10-12T11:00:00.000Z" });
      is(c.changed, true, `确认 ${id} 写了盘`);
    }
    const after = await R.analyzeAndPersist({ book: FIX_C.analysis.book });
    is(after.ok, true, "确认后整理成功");
    const runAfter = await readRunNote(R, kb);
    const itemAfter = runAfter.data.personalized_items.find((x) => x.candidate_id === candC.candidate_id);
    is(itemAfter.scores.q, 1, "确认后 q=1");
    is(itemAfter.scores.C, 1, "确认后 C=1");
    is(runAfter.data.personalization_status, "available",
      "⇒ 真机同形下 available **可达**（修复前这里恒为 limited，这正是真机验收逮到的缺陷）");
    truthy(/仍不代表已校准的高置信/.test(runAfter.raw), "正文仍写明「仍不代表已校准的高置信」");
    check(!/已读懂/.test(runAfter.raw), "正文仍没有「已读懂」");
  } finally { rmSync(kb, { recursive: true, force: true }); }
}

// =========================================================================== //
console.log("\n[15] 写盘必须作废只读投影缓存（否则刚写下的证据最长 2 秒内**整条看不见**）");

{
  const kb = sandbox();
  try {
    const R = rt(kb);
    // 预热：`evidenceNotes()` 内部走 `scanVault()` ⇒ 把「空清单」缓存住。
    const warm = await R.evidenceNotes();
    is(warm.ok, true, "预热：只读清单读得到");
    is(warm.count, 0, "预热：此时一条证据都没有");
    truthy(R._cache.scan !== null, "预热：scan 缓存确实填上了（前提不成立这条测试就没意义）");

    // 写一条**新**证据。注意断言用的是「缓存对象有没有被丢掉」，不是「隔了多久再读」——
    // 后者会随引擎/机器快慢变，前者是这条不变量本身。
    const w = await record(R, {
      span_id: sliceOf(FIX_A, 0, 0).slice_id, kind: "explicit_preference", dimension: null,
      statement: "我对这类论证结构本身有兴趣，想继续看下去。", topic: "缓存不变量", label: "未知",
    });
    is(w.ok, true, `写入成功（${w.code ?? ""} ${w.message ?? ""}）`);
    is(R._cache.scan, null, "写完一条新证据 ⇒ scan 缓存被作废（与引擎快慢无关）");

    // 紧接着读：新证据必须**立刻**在清单里（`collectEvidenceContext` 也是「清单走缓存」，
    // 所以缓存不作废就等于这条证据没参与计算）。
    const after = await R.evidenceNotes();
    is(after.count, 1, "紧接着读：刚写下的证据立刻出现（不是 2 秒后）");
    // 注意字段名是 `note_id`（面板就是拿它去 POST 确认的），不是 `id`。
    truthy((after.notes ?? []).some((n) => n.note_id === w.ids.reading_evidence),
      `清单里就是刚写的那条（note_id 对得上）：写入 id=${w.ids.reading_evidence}`
      + `，清单 note_ids=${JSON.stringify((after.notes ?? []).map((n) => n.note_id))}`);

    // 确认走的是同一条不变量：确认也是写盘。
    await R.evidenceNotes();                                  // 再预热
    truthy(R._cache.scan !== null, "预热：确认前缓存已填充");
    const c = await R.confirmObservation({ note_id: w.ids.reading_evidence, at: "2026-10-11T09:20:00.000Z" });
    is(c.ok, true, `确认成功（${c.code ?? ""} ${c.message ?? ""}）`);
    is(R._cache.scan, null, "确认一条观察 ⇒ scan 缓存同样被作废");
  } finally { rmSync(kb, { recursive: true, force: true }); }
}


console.log("\n[新增] 测试profile与显式测试观察不回灌正式个性化");
for(const testProfile of [false,true]){
 const kb=sandbox();try{
  const R=rt(kb,{testProfile});
  const saved=await record(R,{span_id:sliceOf(FIX_A,0,1).slice_id,kind:'explicit_preference',dimension:null,statement:(testProfile?'':'验收测试，不代表用户真实偏好或能力：')+'我关注这段论证的前提',topic:'隔离检查',label:null});
  truthy(saved.written,'测试观察按正式事务写入');await R.confirmObservation({note_id:saved.ids.reading_evidence,actor:'user'});
  const result=await R.analyzeAndPersist({book:FIX_A.analysis.book});truthy(result.ok,'测试观察存在时仍可分析');
  const run=await readRunNote(R,kb);is(run.data.personalization_status,'none','测试观察即使确认也不推正式个性化');
  check((await R.evidenceNotes({book_path:FIX_A.analysis.book_path})).notes.every(n=>n.test_evidence),'UI投影能识别测试身份');
 }finally{rmSync(kb,{recursive:true,force:true});}
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败${skipped ? ` / ${skipped} 跳过` : ""}`);
if (fail > 0) process.exit(1);
