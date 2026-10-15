/**
 * tools/diagnose-multiple-ready.mjs · 「同一本书多条 ready 理解」只读诊断
 *
 * ## 为什么有这个脚本
 *
 * M10 阶段 2 把数据模型收敛为「**一本书恰好一条理解**」：`run_id = bookRunId(book_version_id)`，
 * 复算覆盖同一条笔记、revision 递增。
 *
 * M13 起这套身份是**内容寻址**的：`book_version_id = "bv_" + sha256(章节正文)[:16]`，
 * **不含路径**。书被**移动或改名**而内容没变 ⇒ 身份不变 ⇒ 还是同一条理解（这是 M13 要的）。
 * 因此「书一挪位置就多出一条理解」这个根因**已经消除**。
 *
 * 那这个脚本还留着干什么：它仍然是**只读体检工具**，用来抓
 *   · 盘上**已经**存在的多条 ready（历史遗留，或用户手工复制的笔记）；
 *   · 「既被挪走、内容又被改过」这种两个身份都变了的情形 —— 本脚本抓不到，
 *     两条笔记看起来属于两本书，工具**不猜**（如实单列/分组，不做启发式合并）。
 *
 * ## 这个脚本干什么 / 不干什么
 *
 * - **只读**：不写任何文件、不删任何笔记、不改任何状态。**不自动改**。
 * - 扫描指定目录（默认 `推荐反馈/`）里的 `recommendation_run` 笔记，
 *   按「同一本书」分组，列出**组内 `state === "ready"` 条数 ≥ 2** 的冲突。
 * - **读不到的笔记单列**（`unreadable`），**绝不当成 0**；
 *   身份信息（book_version_id / 内容摘要）一个都提取不到的笔记单列 `unidentified`，
 *   **不硬塞进某个组**充数。
 *
 * ## 分组键怎么选（诚实边界）
 *
 * 优先用 `book_version_id`：它是**内容寻址**的（只由章节正文决定、不含路径）。
 * 书被挪走但内容没变 ⇒ 同一个 `book_version_id`、不同的 `run_id` ⇒ 正是要抓的场景。
 * `book_version_id` 缺失时退到从笔记里提取的**内容摘要**（`coverage:cov_<16位>` /
 * `dedup_<16位>` / `sec_<16位>_<n>`）；再退到 M13 之前的遗留 `path_hash8`（8 位），
 * 并在输出里**标明**那是遗留身份（`key_source: "legacy_path_hash8"`），不冒充当前身份。
 *
 * ## 跑法
 *
 *   node tools/diagnose-multiple-ready.mjs                     # 诊断真实库
 *   node tools/diagnose-multiple-ready.mjs --root /tmp/vault   # 指定根
 *   node tools/diagnose-multiple-ready.mjs --json              # 机器可读
 *
 * 退出码：**0 = 没发现冲突**；**3 = 发现冲突**（可进 CI）；**1 = 脚本自身出错**。
 * 3 与 1 分开，是为了不把「发现冲突」误读成「脚本崩了」。
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { DEFAULT_KNOWLEDGE_ROOT } from "../lib/reading/book-domain.js";
const DEFAULT_ROOT = DEFAULT_KNOWLEDGE_ROOT;
const FILE_SERVICE = new URL("../lib/reading/file-service.js", import.meta.url);

/** 从一条 run 笔记里提取「这本书是谁」的证据（不猜、不补默认值）。 */
export function bookIdentityOf(data) {
  const bv = typeof data?.book_version_id === "string" && data.book_version_id ? data.book_version_id : null;
  // M13 起笔记里的派生 id 都嵌**内容摘要**（16 位 hex）：`cov_<摘要>` / `dedup_<摘要>` /
  // `sec_<摘要>_<n>`。M13 之前嵌的是 `path_hash8`（8 位 hex）。
  // 两种都收，但**分开记**：16 位是内容身份，8 位是遗留的路径身份，不能混成一个集合
  // （混起来会把「两个不同值」误报成冲突）。
  const cid16 = new Set();
  const ph8 = new Set();
  const add = (raw) => {
    if (typeof raw !== "string") return;
    if (/^[0-9a-f]{16}$/.test(raw)) cid16.add(raw);
    else if (/^[0-9a-f]{8}$/.test(raw)) ph8.add(raw);
  };
  const refs = Array.isArray(data?.input_manifest_refs) ? data.input_manifest_refs : [];
  for (const r of refs) {
    if (typeof r !== "string") continue;
    const m1 = /^coverage:cov_([0-9a-f]+)$/.exec(r);
    if (m1) add(m1[1]);
  }
  const dedup = typeof data?.dedup_check_ref === "string" ? /^dedup_([0-9a-f]+)$/.exec(data.dedup_check_ref) : null;
  if (dedup) add(dedup[1]);
  const sids = data?.book_guide?.coverage_scope?.section_ids;
  if (Array.isArray(sids)) {
    for (const s of sids) {
      if (typeof s !== "string") continue;
      const m = /^sec_([0-9a-f]+)_/.exec(s);
      if (m) add(m[1]);
    }
  }
  const cidList = [...cid16].sort();
  const ph8List = [...ph8].sort();
  // 分组键优先级：book_version_id（最权威）→ 内容摘要 → 遗留 path_hash8。
  const key = bv ? `bv:${bv}`
    : (cidList.length === 1 ? `cid:${cidList[0]}`
      : (ph8List.length === 1 ? `ph8:${ph8List[0]}` : null));
  const keySource = bv ? "book_version_id"
    : (cidList.length === 1 ? "content_id" : (ph8List.length === 1 ? "legacy_path_hash8" : null));
  return {
    book_version_id: bv,
    content_id: cidList.length === 1 ? cidList[0] : null,
    content_id_candidates: cidList,
    // 只在**没有** 16 位内容摘要时才是「遗留路径身份」，避免把它当成当前身份。
    legacy_path_hash8: cidList.length === 0 && ph8List.length === 1 ? ph8List[0] : null,
    legacy_path_hash8_candidates: cidList.length === 0 ? ph8List : [],
    key,
    key_source: keySource,
  };
}

/**
 * 只读诊断。**不写任何文件。**
 * @returns {Promise<object>} 见文件头「跑法」与 README 的字段说明
 */
export async function diagnoseMultipleReady({ root = DEFAULT_ROOT, dir = "推荐反馈" } = {}) {
  // 用 href 而不是 pathname：仓库路径含空格/中文，pathname 会带百分号编码、再编码就错了。
  const { createFileService } = await import(FILE_SERVICE.href);
  const svc = await createFileService({ root });

  let names = [];
  let dirError = null;
  try {
    names = (await readdir(join(root, dir))).filter((n) => n.endsWith(".md")).sort();
  } catch (e) {
    // 目录不存在 = 还没有任何理解（正常）；其他错误如实报出，不当成「没有」
    if (e?.code !== "ENOENT") dirError = { code: e?.code ?? "READDIR_FAILED", message: String(e?.message || e) };
  }

  const runNotes = [];
  const unreadable = [];
  const unidentified = [];
  const notRunNotes = [];

  for (const n of names) {
    const rel = `${dir}/${n}`;
    let note = null;
    try {
      note = await svc.readNote(rel);
    } catch (e) {
      unreadable.push({ rel, code: e?.code ?? "READ_FAILED", message: String(e?.message || e) });
      continue;
    }
    if (!note.exists) { unreadable.push({ rel, code: "SOURCE_UNAVAILABLE", message: "读不到" }); continue; }
    if (note.errors?.length) {
      unreadable.push({ rel, code: "FRONTMATTER_PARSE_FAILED", message: note.errors.map((x) => x.message ?? String(x)).join("; ") });
      continue;
    }
    const data = note.data;
    if (data?.object_type !== "recommendation_run") { notRunNotes.push({ rel, object_type: data?.object_type ?? null }); continue; }

    const id = bookIdentityOf(data);
    const rec = {
      rel,
      run_id: typeof data.run_id === "string" ? data.run_id : (typeof data.id === "string" ? data.id : null),
      state: typeof data.state === "string" ? data.state : null,
      revision: Number.isInteger(data.revision) ? data.revision : null,
      book_version_id: id.book_version_id,
      content_id: id.content_id,
      legacy_path_hash8: id.legacy_path_hash8,
      identity_key: id.key,
      identity_key_source: id.key_source,
    };
    runNotes.push(rec);
    if (id.key === null) unidentified.push({ rel, run_id: rec.run_id, state: rec.state, reason: "既没有 book_version_id，也提取不到唯一的内容摘要 ⇒ 身份未知，不并入任何组" });
  }

  const groups = new Map();
  for (const r of runNotes) {
    if (r.identity_key === null) continue;
    if (!groups.has(r.identity_key)) groups.set(r.identity_key, []);
    groups.get(r.identity_key).push(r);
  }

  const conflicts = [];
  for (const [key, list] of groups) {
    const ready = list.filter((x) => x.state === "ready");
    if (ready.length >= 2) {
      conflicts.push({
        identity_key: key,
        identity_key_source: list[0].identity_key_source,
        ready_count: ready.length,
        run_ids: ready.map((x) => x.run_id).sort(),
        notes: ready.map((x) => ({ rel: x.rel, run_id: x.run_id, revision: x.revision })).sort((a, b) => a.rel.localeCompare(b.rel)),
        other_states: list.filter((x) => x.state !== "ready").map((x) => ({ rel: x.rel, run_id: x.run_id, state: x.state })),
      });
    }
  }
  conflicts.sort((a, b) => b.ready_count - a.ready_count || a.identity_key.localeCompare(b.identity_key));

  return {
    ok: dirError === null,
    read_only: true,
    root,
    dir,
    dir_error: dirError,
    scanned: names.length,
    run_notes: runNotes.length,
    not_run_notes: notRunNotes,
    ready_total: runNotes.filter((x) => x.state === "ready").length,
    group_count: groups.size,
    conflicts,
    conflict_count: conflicts.length,
    unidentified,
    unreadable,
    note: "只读诊断：不删、不改、不自动合并。发现冲突时**由人决定**怎么处理（本工具绝不代劳）。"
      + "M13 起书的身份是**内容寻址**（book_version_id 由章节正文决定，不含路径），"
      + "所以「书一挪位置就多出一条理解」这个根因已经消除；"
      + "本工具现在抓的是**盘上已经存在**的多条 ready（历史遗留/手工复制），"
      + "以及「既挪了位置、内容又被改过」这种两个身份都变了、工具**不猜**的情形。",
  };
}

/* ── CLI ─────────────────────────────────────────────────────────────────── */
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const argv = process.argv.slice(2);
  const rootArg = argv.indexOf("--root");
  const root = rootArg >= 0 ? argv[rootArg + 1] : DEFAULT_ROOT;
  const asJson = argv.includes("--json");

  const r = await diagnoseMultipleReady({ root });
  if (asJson) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    console.log("== 「同一本书多条 ready 理解」只读诊断 ==");
    console.log(`根：${r.root}`);
    console.log(`扫描 ${r.dir}/ 下 ${r.scanned} 个 .md；其中 recommendation_run ${r.run_notes} 条、非 run ${r.not_run_notes.length} 条`);
    console.log(`ready 合计 ${r.ready_total} 条；可分组身份 ${r.group_count} 个`);
    if (r.dir_error) console.log(`⚠️ 目录读取失败（不当成 0）：${r.dir_error.code} ${r.dir_error.message}`);
    if (r.unreadable.length) {
      console.log(`⚠️ 读不到的笔记 ${r.unreadable.length} 条（单列，不当成 0）：`);
      for (const u of r.unreadable) console.log(`   - ${u.rel} [${u.code}] ${u.message}`);
    }
    if (r.unidentified.length) {
      console.log(`⚠️ 身份未知的 run 笔记 ${r.unidentified.length} 条（不并入任何组）：`);
      for (const u of r.unidentified) console.log(`   - ${u.rel} run_id=${u.run_id} state=${u.state}`);
    }
    if (r.conflict_count === 0) {
      console.log("✅ 未发现「同一本书多条 ready」。");
    } else {
      console.log(`❌ 发现 ${r.conflict_count} 组冲突（同一本书多条 ready）：`);
      for (const c of r.conflicts) {
        console.log(`   · 身份 ${c.identity_key}（来自 ${c.identity_key_source}）ready ${c.ready_count} 条：`);
        for (const n of c.notes) console.log(`       - ${n.rel}  run_id=${n.run_id}  revision=${n.revision}`);
      }
      console.log("   → 本工具**不会**自动处理；请人工决定保留哪一条。");
    }
    console.log(`\n${r.note}`);
  }
  process.exit(r.ok === false ? 1 : (r.conflict_count > 0 ? 3 : 0));
}
