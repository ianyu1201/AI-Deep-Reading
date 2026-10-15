/**
 * tests/reading-multiple-ready-diagnosis.test.mjs · 「同一本书多条 ready 理解」只读诊断
 *
 * ## 这份测试在防什么
 * 这个诊断工具本身最容易出的错不是崩溃，而是**假报**与**漏报**：
 *   · 漏报：同一本书（同 book_version_id）两条 ready 却没被列出来 —— 工具等于没用
 *   · 假报：不同书的两条 ready 被算成一组 —— 用户会去删不该删的东西
 *   · 把读不到的笔记**当成 0**（读不到 ≠ 没有）
 *   · 身份提取不到时**硬塞进某个组**充数（宁可单列 unidentified，也不猜）
 *   · 工具偷偷写盘（诊断工具写盘 = 越权）
 *
 * ## 每条检查「在什么情况下会失败」
 *   [0] 检测能力      — 同 bv 两条 ready 不被列为冲突 ⇒ 失败
 *   [1] 负控（区分度）— 没有重复的库里也报冲突 ⇒ 失败（证明不是恒报）
 *   [2] 不误伤        — 不同 bv 的 ready 被合并 ⇒ 失败
 *   [3] 身份边界      — 内容摘要（16 位）/ 遗留 path_hash8（8 位）提取不出来 ⇒ 失败
 *   [4] 身份未知      — 无 bv 无摘要的笔记没进 unidentified（被硬塞进组）⇒ 失败
 *   [5] 读不到 ≠ 0    — frontmatter 坏掉的笔记没单列 unreadable ⇒ 失败
 *   [6] 非 run 笔记   — object_type 不是 recommendation_run 的被算成 run ⇒ 失败
 *   [7] 只读          — 跑完沙箱全树哈希变化 ⇒ 失败
 *   [8] 边界如实      — 空库/无目录时不报错、也不报冲突 ⇒ 失败
 *   [9] 内容摘要分组  — M13 格式（cov_/dedup_ 嵌 16 位内容摘要）的两条 ready 不被列出 ⇒ 失败
 *
 * 跑法：node tests/reading-multiple-ready-diagnosis.test.mjs
 */
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL = join(HERE, "..", "tools", "diagnose-multiple-ready.mjs");
const { diagnoseMultipleReady, bookIdentityOf } = await import(pathToFileURL(TOOL).href);

let pass = 0, fail = 0, skipped = 0;
const ok = (m) => { pass++; console.log("  ✓ " + m); };
const bad = (m, d) => { fail++; console.log("  ✗ " + m + (d ? "\n      " + d : "")); };
const is = (label, got, want) =>
  got === want ? ok(label) : bad(label, `得到 ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}`);

/** 建一个沙箱 vault：只建 推荐反馈/，写入给定的 .md。 */
async function makeVault(files) {
  const root = await mkdtemp(join(tmpdir(), "m11-diag-"));
  await mkdir(join(root, "推荐反馈"), { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    await writeFile(join(root, "推荐反馈", name), text, "utf8");
  }
  return root;
}

async function treeSnap(root) {
  const acc = {};
  async function walk(d) {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const abs = join(d, e.name);
      if (e.isDirectory()) await walk(abs);
      else if (e.isFile()) acc[relative(root, abs)] = createHash("sha256").update(await readFile(abs)).digest("hex");
    }
  }
  await walk(root);
  return createHash("sha256").update(Object.keys(acc).sort().map((k) => `${k}:${acc[k]}`).join("\n")).digest("hex");
}

const runNote = ({ id, state, bv, ph8, extra = "" }) => `---
schema_version: '1.1'
object_type: recommendation_run
id: ${id}
revision: 1
title: 两层阅读推荐运行
state: ${state}
run_id: ${id}
${bv ? `book_version_id: ${bv}` : ""}
input_manifest_refs:${ph8 ? `\n  - 'coverage:cov_${ph8}'` : " []"}
dedup_check_ref:${ph8 ? ` dedup_${ph8}` : " "}
${extra}---

正文
`;

/* ── [0][2][3][4][5][6] 主场景 ───────────────────────────────────────────── */
console.log("\n[0] 主场景：同书两条 ready 必须被列出，别的都不许被牵连");
const ROOT = await makeVault({
  "rr_a1.md": runNote({ id: "rr_a1", state: "ready", bv: "bv_aaa", ph8: "aaaaaaaa" }),
  "rr_a2.md": runNote({ id: "rr_a2", state: "ready", bv: "bv_aaa", ph8: "aaaaaaaa" }),
  "rr_a3.md": runNote({ id: "rr_a3", state: "stale", bv: "bv_aaa", ph8: "aaaaaaaa" }),
  "rr_b1.md": runNote({ id: "rr_b1", state: "ready", bv: "bv_bbb", ph8: "bbbbbbbb" }),
  "rr_c1.md": runNote({ id: "rr_c1", state: "ready", bv: null, ph8: "cccccccc" }),
  "rr_f1.md": runNote({ id: "rr_f1", state: "ready", bv: null, ph8: null }),
  "rr_e1.md": `---\nschema_version: '1.1'\nobject_type: book\nid: bk_1\nrevision: 1\n---\n\n正文\n`,
  "rr_d1.md": `---\nobject_type: [未闭合\n---\n\n正文\n`,
});

const before = await treeSnap(ROOT);
const r = await diagnoseMultipleReady({ root: ROOT });
const after = await treeSnap(ROOT);

is("run 笔记恰好 6 条（A1 A2 A3 B1 C1 F1）", r.run_notes, 6);
is("ready 合计 5 条", r.ready_total, 5);
is("冲突恰好 1 组", r.conflict_count, 1);
is("冲突身份键是 book_version_id", r.conflicts[0]?.identity_key, "bv:bv_aaa");
is("冲突组 ready 条数 2", r.conflicts[0]?.ready_count, 2);
is("冲突组 run_id 排序后为 [rr_a1, rr_a2]", JSON.stringify(r.conflicts[0]?.run_ids), JSON.stringify(["rr_a1", "rr_a2"]));
is("同书的 stale 被列进 other_states（不算 ready）", r.conflicts[0]?.other_states?.map((x) => x.run_id).join(","), "rr_a3");
is("不同书（bv_bbb）没被算进任何冲突", r.conflicts.some((c) => c.identity_key === "bv:bv_bbb"), false);
is("只有遗留 path_hash8 证据的笔记被识别成遗留身份（ph8:cccccccc），不算冲突", r.conflicts.some((c) => c.identity_key === "ph8:cccccccc"), false);
is("该笔记确实进入了分组（不是被丢掉）", r.group_count >= 3, true);
is("身份未知的笔记单列 unidentified（不硬塞进组）", r.unidentified.map((u) => u.run_id).join(","), "rr_f1");
is("坏 frontmatter 单列 unreadable", r.unreadable.length, 1);
is("unreadable 指向 rr_d1.md", r.unreadable[0]?.rel, "推荐反馈/rr_d1.md");
is("非 run 笔记单列 not_run_notes", r.not_run_notes.map((x) => x.rel).join(","), "推荐反馈/rr_e1.md");
is("工具自报只读", r.read_only, true);
is("只读：跑完沙箱全树哈希未变", before === after, true);
is("口径说明非空且提到不自动改", /不删、不改、不自动合并/.test(r.note), true);

/* ── [1] 负控：没有重复的库不许报冲突 ─────────────────────────────────────── */
console.log("\n[1] 负控：无重复的库必须报 0 冲突（证明不是恒报）");
const CLEAN = await makeVault({
  "rr_x1.md": runNote({ id: "rr_x1", state: "ready", bv: "bv_xxx", ph8: "11111111" }),
  "rr_y1.md": runNote({ id: "rr_y1", state: "ready", bv: "bv_yyy", ph8: "22222222" }),
  "rr_x2.md": runNote({ id: "rr_x2", state: "stale", bv: "bv_xxx", ph8: "11111111" }),
});
const rc = await diagnoseMultipleReady({ root: CLEAN });
is("无重复 ⇒ 0 冲突", rc.conflict_count, 0);
is("无重复 ⇒ 但 ready 仍如实计数（2 条）", rc.ready_total, 2);

/* ── [2] 负控升级：把两条 ready 的 bv 改成不同 ⇒ 冲突必须消失 ─────────────── */
console.log("\n[2] 负控升级：同一对笔记，只把 bv 改成不同 ⇒ 冲突必须消失");
const SPLIT = await makeVault({
  "rr_p1.md": runNote({ id: "rr_p1", state: "ready", bv: "bv_p1", ph8: "33333333" }),
  "rr_p2.md": runNote({ id: "rr_p2", state: "ready", bv: "bv_p2", ph8: "33333333" }),
});
const rs = await diagnoseMultipleReady({ root: SPLIT });
is("两条 ready 分属不同 bv ⇒ 0 冲突", rs.conflict_count, 0);
is("但两条都进了各自的分组", rs.group_count, 2);

/* ── [3] 身份提取的单元边界（元检查：不猜、不补默认值） ─────────────────── */
console.log("\n[3] bookIdentityOf：缺证据时必须是 null，不许猜");
is("无 bv 无摘要 ⇒ key 为 null", bookIdentityOf({}).key, null);
is("无 bv 无摘要 ⇒ key_source 为 null", bookIdentityOf({}).key_source, null);
is("只有 bv ⇒ 用 bv", bookIdentityOf({ book_version_id: "bv_z" }).key, "bv:bv_z");
// M13：笔记里的派生 id 嵌的是**内容摘要**（16 位）
is("16 位内容摘要 ⇒ key 用 cid:",
  bookIdentityOf({ input_manifest_refs: ["coverage:cov_0123456789abcdef"] }).key, "cid:0123456789abcdef");
is("16 位内容摘要 ⇒ key_source 是 content_id",
  bookIdentityOf({ input_manifest_refs: ["coverage:cov_0123456789abcdef"] }).key_source, "content_id");
is("dedup_<16位> 也能提取",
  bookIdentityOf({ dedup_check_ref: "dedup_fedcba9876543210" }).key, "cid:fedcba9876543210");
is("sec_<16位>_<n> 也能提取",
  bookIdentityOf({ book_guide: { coverage_scope: { section_ids: ["sec_0123456789abcdef_0", "sec_0123456789abcdef_1"] } } }).key,
  "cid:0123456789abcdef");
is("16 位摘要有两个不同值 ⇒ 不敢认，key 为 null",
  bookIdentityOf({ input_manifest_refs: ["coverage:cov_0123456789abcdef", "coverage:cov_fedcba9876543210"] }).key, null);
is("两个不同值时候选如实列出",
  JSON.stringify(bookIdentityOf({ input_manifest_refs: ["coverage:cov_0123456789abcdef", "coverage:cov_fedcba9876543210"] }).content_id_candidates),
  JSON.stringify(["0123456789abcdef", "fedcba9876543210"]));
// 8 位是 M13 **之前**的遗留格式：仍然认，但必须标明是遗留身份，不许冒充当前身份
is("8 位 ⇒ key 用 ph8:（遗留路径身份）",
  bookIdentityOf({ input_manifest_refs: ["coverage:cov_aaaaaaaa"] }).key, "ph8:aaaaaaaa");
is("8 位 ⇒ key_source 明说是 legacy_path_hash8",
  bookIdentityOf({ input_manifest_refs: ["coverage:cov_aaaaaaaa"] }).key_source, "legacy_path_hash8");
is("8 位 ⇒ content_id 必须是 null（不把遗留身份冒充成内容身份）",
  bookIdentityOf({ input_manifest_refs: ["coverage:cov_aaaaaaaa"] }).content_id, null);
is("8 位有两个不同值 ⇒ 不敢认，key 为 null",
  bookIdentityOf({ input_manifest_refs: ["coverage:cov_aaaaaaaa", "coverage:cov_bbbbbbbb"] }).key, null);
is("8 位两个不同值时候选如实列出",
  JSON.stringify(bookIdentityOf({ input_manifest_refs: ["coverage:cov_aaaaaaaa", "coverage:cov_bbbbbbbb"] }).legacy_path_hash8_candidates),
  JSON.stringify(["aaaaaaaa", "bbbbbbbb"]));
// 16 位与 8 位混在一起：以 16 位为准，且**不许**把两者混成一个候选集
{
  const mixed = bookIdentityOf({ input_manifest_refs: ["coverage:cov_0123456789abcdef", "coverage:cov_aaaaaaaa"] });
  is("16 位与 8 位混用 ⇒ 以内容摘要为准", mixed.key, "cid:0123456789abcdef");
  is("16 位与 8 位混用 ⇒ 遗留候选不被混进内容候选",
    JSON.stringify(mixed.content_id_candidates), JSON.stringify(["0123456789abcdef"]));
}

/* ── [9] M13 格式：内容摘要分组（当前笔记真实长相） ─────────────────────── */
console.log("\n[9] M13：cov_/dedup_ 嵌 16 位内容摘要时也必须能抓出同书多条 ready");
{
  const CID_A = "0123456789abcdef";
  const MROOT = await makeVault({
    // 同一本书（同内容摘要）的两条 ready，**没有** book_version_id ⇒ 只能靠内容摘要分组
    "rr_n1.md": runNote({ id: "rr_n1", state: "ready", bv: null, ph8: CID_A }),
    "rr_n2.md": runNote({ id: "rr_n2", state: "ready", bv: null, ph8: CID_A }),
    // 另一本书：摘要不同 ⇒ 不许被合并进来
    "rr_n3.md": runNote({ id: "rr_n3", state: "ready", bv: null, ph8: "fedcba9876543210" }),
  });
  const rn = await diagnoseMultipleReady({ root: MROOT });
  is("M13 格式 ⇒ 冲突恰好 1 组", rn.conflict_count, 1);
  is("M13 格式 ⇒ 身份键是内容摘要",
    rn.conflicts[0]?.identity_key, `cid:${CID_A}`);
  is("M13 格式 ⇒ 该组 ready 条数 2", rn.conflicts[0]?.ready_count, 2);
  is("M13 格式 ⇒ 另一本书没被牵连",
    rn.conflicts.some((c) => c.identity_key === "cid:fedcba9876543210"), false);
  is("M13 格式 ⇒ 没有身份未知的笔记", rn.unidentified.length, 0);
}

/* ── [4] 边界：空库 / 目录不存在 ─────────────────────────────────────────── */
console.log("\n[4] 边界：空库与不存在的目录");
const EMPTY = await mkdtemp(join(tmpdir(), "m11-diag-empty-"));
const re = await diagnoseMultipleReady({ root: EMPTY });
is("没有 推荐反馈/ ⇒ 不报错", re.ok, true);
is("没有 推荐反馈/ ⇒ 0 冲突", re.conflict_count, 0);
is("没有 推荐反馈/ ⇒ dir_error 为 null（ENOENT 是正常态）", re.dir_error, null);

console.log(`\n通过 ${pass} / 失败 ${fail} / 跳过 ${skipped}`);
process.exit(fail === 0 ? 0 : 1);
