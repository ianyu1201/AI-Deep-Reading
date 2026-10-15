/**
 * tests/fakes/reading-fixtures.mjs · 只读投影 / 跨层契约 / 闭环用的**忠实夹具**
 *
 * ## 为什么不是手写 YAML
 *
 * 夹具如果手写 frontmatter，很容易写出一个「schema 其实不认」的假记录：
 * 测试全绿，真盘上却是 invalid。所以这里**不手写字段**，而是：
 *
 * ```
 *   scoreCandidate(...)                    ← policy.js 的**真**评分函数（分值类型/取值都是真的）
 *     → RecommendationResult（真形状）
 *       → mapRecommendationResultToRun(...) ← policy.js 的**真**映射（18 键自检）
 *         → buildRecommendationRunNote(...)  ← policy.js 的**真**落页组装（过 M1 validateNote formal）
 *           → composeNote(...)               ← schema.js 的**真**序列化
 * ```
 *
 * 任何一环的形状变了，夹具**当场抛错**，而不是悄悄产出一个坏 fixture。
 * 这样「投影读不出来」就一定是**投影的**问题，不是夹具的问题。
 *
 * ## 元检查
 *
 * `assertFixtureFaithful()` 会自己断言「夹具真的产出了两层内容」，
 * 避免出现「夹具本身是空的、于是所有断言都在空态上通过」的假绿。
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { composeNote } from "../../lib/reading/schema.js";
import {
  buildRecommendationRunNote,
  mapRecommendationResultToRun,
  scoreCandidate,
} from "../../lib/reading/policy.js";

/** 规范 §4 的六个索引区（夹具索引页用）。 */
export const INDEX_ZONES = ["books", "evidence", "recommendations", "proposals", "maintenance", "health"];

export function indexText() {
  return INDEX_ZONES
    .map((z) => `<!-- reading-index:${z}:start -->\n${z}-内容\n<!-- reading-index:${z}:end -->`)
    .join("\n\n");
}

/** 夹具用的「书版本 / 运行」常量。 */
export const FIXTURE = Object.freeze({
  book_version_id: "bv_fixture_1",
  candidate_set_version: "cs_fixture_1",
  prompt_template_version: "pt_fixture_1",
  input_fingerprint: "f".repeat(64),
  job_id: "job_fixture_1",
});

/**
 * 造一个**真的过 `assertResultShape`** 的 `RecommendationResult`。
 *
 * 分值走 `policy.js` 的 `scoreCandidate`，所以分值的**类型与取值都是真的**：
 *   · `dimensions` 默认 `{R:3, G:null, T:null}` ⇒ W=0.30、C=3/7<1、q=1 ⇒ `limited`；
 *   · 传 `{R:3,G:2,T:1}` ⇒ W=0.70、C=1、q=1 ⇒ `available`；
 *   · `layer2:false` ⇒ `personalized_items=[]`、status `none`（PRD :280 第一种态）。
 *
 * @param {{runId?:string, layer2?:boolean, marker?:string, status?:string,
 *          dimensions?:object, soft_dimensions?:string[]}} [opts]
 *   `marker` 会写进 candidate_id / section_id，用来分辨「显示的是哪一次运行」。
 */
export function makeRecommendationResult(opts = {}) {
  const runId = opts.runId ?? "rr_fixture_1";
  const marker = opts.marker ?? "a";
  const layer2 = opts.layer2 !== false;
  const dimensions = opts.dimensions ?? { R: 3, G: null, T: null };
  const scored = scoreCandidate({
    b: 3,
    dimensions,
    soft_dimensions: opts.soft_dimensions ?? [],
  });
  const cid = `ca_${marker}_1`;
  const cid2 = `ca_${marker}_2`;
  const guide = {
    overview_paragraphs: [
      `【夹具 ${marker}】第一段浓缩：从普遍怀疑到「我思故我在」，论证依赖被显式标出。`,
      `【夹具 ${marker}】第二段浓缩：上帝存在的证明与清楚分明原则的循环风险。`,
    ],
    coverage_scope: {
      scope: "parsed_body",
      book_version_id: FIXTURE.book_version_id,
      section_ids: [`sec_${marker}_1`, `sec_${marker}_2`],
    },
    source_refs: [`sp_${marker}_1`, `sp_${marker}_2`],
    items: [
      { candidate_id: cid, section_id: `sec_${marker}_1`, B: 3, reason: `【夹具 ${marker}】核心论证`, source_refs: [`sp_${marker}_1`] },
      { candidate_id: cid2, section_id: `sec_${marker}_2`, B: 2, reason: `【夹具 ${marker}】必要前提`, source_refs: [`sp_${marker}_2`] },
    ],
  };
  const dimensionEvidence = {};
  for (const d of ["R", "G", "T"]) {
    if (dimensions[d] === null || dimensions[d] === undefined) continue;
    dimensionEvidence[d] = {
      score: dimensions[d],
      reason: `【夹具 ${marker}】${d} 有依据（score=${dimensions[d]}）`,
      evidence_refs: [`pe_${marker}_${d}`],
    };
  }
  const personalized = layer2
    ? [{
        candidate_id: cid,
        reasons: {
          book: `【夹具 ${marker}】核心论证`,
          personal: ["R: 与本次明确目标相关"],
          reason_code: "goal_matched",
        },
        dimension_evidence: dimensionEvidence,
        scores: scored.scores,
        uncertainty: "未观察到 G/T 的依据，保持未知（不填 0/中立）。",
        source_refs: [`sp_${marker}_1`, `pe_${marker}_1`],
      }]
    : [];
  const derivedStatus = personalized.length === 0
    ? "none"
    : ((scored.scores.C < 1 || scored.scores.q === 0.5) ? "limited" : "available");
  const status = opts.status ?? derivedStatus;
  return {
    outcome: "items",
    book_guide: guide,
    personalized_items: personalized,
    personalization_status: status,
    exclusions: [],
    constraints_report: {
      gate_order: ["consent", "boundary", "version", "time", "citation", "quality"],
      consent_passed: true,
      reading_boundary_passed: true,
      version_passed: true,
      citation_passed: true,
      source_verified_count: 2,
      excluded_counts: {},
      material_exclusions: [],
      constraint_exclusions: [],
      applied_feedback_exclusions: { applied: false, feedback_refs: [], note: null },
      soft_signals: { known: [], disagree: [], interested: [], correction: [] },
      dropped_dimensions: [],
      unknown_dimensions: ["G", "T"],
      policy_config_fallback: { used: false, reason: null },
      lambda_cap_clamped: false,
      retrieval_hits_ignored_for_baseline: [],
      selection_tradeoffs: {
        book: {}, personalized: {}, estimated_minutes_used: 0, max_minutes: 30,
        max_items_per_layer: 3, reading_boundary_mode: "whole_book",
      },
      insufficient_evidence_reason: null,
    },
    policy_and_model_metadata: {
      policy: { id: "evidence_balanced", version: "0.1.0" },
      model: "fixture-model",
      prompt_template_version: FIXTURE.prompt_template_version,
      candidate_set_version: FIXTURE.candidate_set_version,
      input_fingerprint: FIXTURE.input_fingerprint,
      input_manifest_refs: [`pi_${marker}`],
      lambda_cap: "0.40",
      enabled_dimensions: ["R", "G", "T"],
      weights: { R: "0.30", G: "0.20", T: "0.20" },
      b_anchors: { 0: "有来源但缺阅读价值", 1: "局部补充", 2: "代表性论点/必要前提", 3: "核心论证或关键边界" },
      retrieval_used_as_baseline: false,
      budget: { max_items_per_layer: 3, max_overview_paragraphs: 2, max_minutes: 30, fallback: null },
      run_id: runId,
    },
  };
}

/**
 * `RecommendationResult` → 一条**正式有效**的 `recommendation_run` 笔记文本。
 *
 * 全程走 policy.js 的真函数，所以它一定过 M1 `validateNote(formal)`；
 * 过不了会**在这里抛错**（不是产出坏夹具）。
 */
export function makeRunNoteText({ result, runId, createdAt, updatedAt, state = "ready", marker = "a" }) {
  const run = mapRecommendationResultToRun(result, {
    run_id: runId,
    job_id: `${FIXTURE.job_id}_${marker}`,
    book_version_id: FIXTURE.book_version_id,
    input_fingerprint: FIXTURE.input_fingerprint,
    input_manifest_refs: [`pi_${marker}`],
    candidate_set_version: FIXTURE.candidate_set_version,
    prompt_template_version: FIXTURE.prompt_template_version,
    state,
  });
  const built = buildRecommendationRunNote(run, { dedup_check_ref: `dedup_${marker}` });
  const data = {
    ...built.data,
    created_at: createdAt,
    updated_at: updatedAt,
  };
  return composeNote(data, `\n# ${data.title}\n\n夹具运行 ${runId}（正文不参与投影）。\n`);
}

/**
 * 在临时目录里造一个知识库，写入 0..n 条 run 笔记。
 *
 * @param {Array<{runId:string, createdAt:string, updatedAt:string, state?:string,
 *   marker?:string, layer2?:boolean, raw?:string, result?:object}>} runs
 */
export function makeVault(runs = []) {
  const dir = mkdtempSync(join(tmpdir(), "ab-m8-kb-"));
  for (const d of ["书籍", "待确认", "推荐反馈", "概念", "理解变化", "阅读背景"]) {
    mkdirSync(join(dir, d), { recursive: true });
  }
  mkdirSync(join(dir, ".state"), { recursive: true });
  writeFileSync(join(dir, "索引.md"), composeNote({
    schema_version: "1.1",
    object_type: "index",
    id: "idx_fixture_1",
    revision: 1,
    title: "索引",
    tags: ["index", "reading"],
    scope: "reading",
    knowledge_status: "active",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    index_generation: { mode: "manual_seed", generated_at: "2026-01-01T00:00:00.000Z", source_digest: null },
  }, `\n# 索引\n\n${indexText()}\n`));
  runs.forEach((spec, i) => {
    const marker = spec.marker ?? String.fromCharCode(97 + i);
    const text = spec.raw ?? makeRunNoteText({
      result: spec.result ?? makeRecommendationResult({ runId: spec.runId, marker, layer2: spec.layer2 }),
      runId: spec.runId,
      createdAt: spec.createdAt,
      updatedAt: spec.updatedAt,
      state: spec.state ?? "ready",
      marker,
    });
    writeFileSync(join(dir, "推荐反馈", `${spec.runId}.md`), text);
  });
  return dir;
}

/**
 * **夹具忠实性元检查**：证明夹具不是「空的两层」。
 *
 * 如果夹具本身没有两层内容，那么「面板渲染出了两层」的断言就是假绿
 * （空夹具也能让空态断言通过）。所以这里先证明夹具**有**东西。
 */
export function assertFixtureFaithful() {
  const r = makeRecommendationResult({ runId: "rr_meta", marker: "meta" });
  const problems = [];
  if (!Array.isArray(r.book_guide?.overview_paragraphs) || r.book_guide.overview_paragraphs.length === 0) {
    problems.push("第一层浓缩为空");
  }
  if (!Array.isArray(r.book_guide?.items) || r.book_guide.items.length === 0) problems.push("第一层 items 为空");
  if (!Array.isArray(r.book_guide?.source_refs) || r.book_guide.source_refs.length === 0) problems.push("第一层 source_refs 为空");
  if (!Array.isArray(r.personalized_items) || r.personalized_items.length === 0) problems.push("第二层 personalized_items 为空");
  const s = r.personalized_items[0]?.scores ?? {};
  for (const k of ["B", "R", "G", "T", "W", "C", "q", "lambda", "U", "S"]) {
    if (!Object.hasOwn(s, k)) problems.push(`scores 缺 ${k}`);
  }
  if (typeof s.C !== "number" || !(s.C < 1)) problems.push(`C 不是「小于 1 的数字」（limited 态需要）`);
  if (s.q !== 1) problems.push("q 不是 1");
  if (s.G !== null || s.T !== null) problems.push("G/T 应当为 null（unknown 反例夹具）");
  if (r.personalization_status !== "limited") problems.push("personalization_status 不是 limited");
  return problems;
}
