/**
 * lib/reading/file-service.js · M1 持久化地基（第 2 件）
 *
 * 职责（执行计划-v0.6 §1 第 3 行 / §2 末段）：
 *   **原子写 + journal + hash 保护 + 手改检测 + 恢复 + 幂等 + 删除屏障 + 水位**
 *
 * 这些不是"以后再补"的可靠性装饰：PRD §15.1 明确 AC-11/12/25 归 P2 只指"扩展故障矩阵"，
 * 基础耐久写入/幂等/防覆盖/删除屏障与已开始事务的基础恢复**必须与闭环同时长出来**。
 *
 * ## 协议（PRD §9.3 / §9.4 / §11.5，逐条对应）
 *   prepared → applying → committed
 *      ↘ aborted        ↘ recovering → conflict / aborted
 *
 *   1. `beginTransaction` 先校验：路径在 45 内、删除屏障、create 目标不存在、
 *      update 的 base_hash 与实际 bytes hash 一致；把新内容与恢复副本写进
 *      `.state/staging/<txid>/`，再**耐久写 journal**（tmp+fsync+rename+目录 fsync）。
 *      journal 落地之前，任何目标文件都不得被改动。
 *   2. `applyTransaction` 把 journal 标 applying（耐久）后才开始逐个 rename；
 *      每步 rename 后立即 fsync 目录、重算 after hash、**耐久记录该步**。
 *   3. 任一步失败 → `recovering`（绝不直接记 failed）；恢复按每目标 hash 判定：
 *      ==after 该步已完成、==before 可继续、都不是 → `conflict` 并保留人工内容。
 *   4. 全部目标验证通过且 journal 提交标记耐久 → `committed`。
 *
 * ## 关键取舍
 *   - 只用真实文件系统，不引入任何 fake-fs 替身：M0 的教训是"替身不忠实 → 离线全绿、
 *     运行期失效"。本文件的测试全部在真磁盘上做，崩溃用真 SIGKILL。
 *   - 原子性只承诺**单文件**：多个 Markdown 无法同时原子可见（PRD §9.3 末段），
 *     所以 UI 不得宣称"全目录原子事务"。
 *   - 辅助 JSON 只走白名单（schema.validateStatePayload），防止把知识正文或会话复录进 .state/。
 */
import { constants as FS_CONSTANTS } from "node:fs";
import { access, mkdir, open, readFile, readdir, rename, rm, stat, lstat, realpath, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve as pathResolve, sep } from "node:path";
import {
  SCHEMA_VERSION,
  SchemaError,
  assertValid,
  composeNote,
  parseNote,
  sha256Hex,
  validateCursorEntry,
  validateNoChangeReceipt,
  validateStatePayload,
  validateWatermarks,
} from "./schema.js";

/** PRD §11.5 FileTransaction.purpose 的闭合值域。 */
export const TRANSACTION_PURPOSES = Object.freeze([
  "save_proposal",
  "accept_proposal",
  "update_note",
  "update_proposal",
  "maintenance",
  "record_no_change",
  "export_manifest",
]);

/**
 * 唯一允许**零目标**的 purpose。
 * PRD §8.7 要求 no_change 有"耐久最小处理回执"，而 §8.2 的 `.state/` 清单里没有回执文件、
 * §11.5 又把 record_no_change 列进 FileTransaction 的 purpose —— 所以回执就是一条
 * 零目标事务的 journal：它同样耐久、同样可被幂等键查到，但不碰任何 Markdown。
 * 其他 purpose 零目标一律拒绝：那会退化成"什么都没做却记了成功"。
 */
export const RECEIPT_ONLY_PURPOSES = Object.freeze(["record_no_change"]);

const TERMINAL_STATES = new Set(["committed", "aborted"]);

/**
 * PRD §11.5 声明的状态机**逐字**（不多不少）：
 *   prepared→applying/aborted；applying→committed/recovering；
 *   recovering→applying/conflict/aborted；conflict→recovering/aborted
 *
 * 必须是 PRD 的**等集**而不是超集：AC-25 要求覆盖 §11.5 的每条允许边并拒绝非法转换。
 * 多出来的边（例如 prepared→recovering、recovering→committed）即便当前不可达，
 * 也会让"将来某段代码走了非法边"静默通过。测试里有"边集 === PRD §11.5"的断言守着。
 */
export const ALLOWED_TRANSITIONS = Object.freeze({
  prepared: ["applying", "aborted"],
  applying: ["committed", "recovering"],
  recovering: ["applying", "conflict", "aborted"],
  conflict: ["recovering", "aborted"],
  committed: [],
  aborted: [],
});

export class FileServiceError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = "FileServiceError";
    this.code = code;
    this.detail = detail ?? null;
  }
}

// --------------------------------------------------------------------------- //
// 小工具
// --------------------------------------------------------------------------- //
function isInside(root, candidate) {
  if (candidate === root) return true;
  return candidate.startsWith(root + sep);
}

function normalizeRel(rel) {
  if (typeof rel !== "string" || rel.trim() === "") {
    throw new FileServiceError("PATH_OUT_OF_SCOPE", `相对路径必须是非空字符串，得到 ${JSON.stringify(rel)}`);
  }
  if (isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) {
    throw new FileServiceError("PATH_OUT_OF_SCOPE", `不接受绝对路径：${rel}（对象 ID 由服务解析为路径）`);
  }
  const parts = rel.split("/");
  for (const p of parts) {
    if (p === "" || p === "." || p === "..") {
      throw new FileServiceError("PATH_OUT_OF_SCOPE", `路径含不允许的片段 ${JSON.stringify(p)}：${rel}`);
    }
  }
  if (parts.some((p) => p.includes("\0"))) {
    throw new FileServiceError("PATH_OUT_OF_SCOPE", `路径含 NUL：${rel}`);
  }
  return parts.join("/");
}

async function exists(p) {
  try { await access(p, FS_CONSTANTS.F_OK); return true; } catch { return false; }
}

/**
 * @param {object} opts
 * @param {string} opts.root 知识库根的绝对路径（**必填**，且必须已存在）。
 *   本模块**不再提供默认根**（M10 收口 A）：默认根属于书域配置，住在
 *   `lib/reading/book-domain.js`，由调用方显式传入（`runtime.js` 是唯一注入点），
 *   避免「写盘根」与「读盘根」各自漂移。
 * @param {() => Date} [opts.now]
 * @param {() => string} [opts.newId]
 * @param {(evt: object) => void|Promise<void>} [opts.onStep] 步骤钩子（崩溃注入/可观测性用）
 * @param {boolean} [opts.dirFsync] 是否对父目录做 fsync（默认 true；测试可关）
 */
export async function createFileService(opts = {}) {
  const rootInput = opts.root;
  const now = opts.now ?? (() => new Date());
  const newId = opts.newId ?? (() => `tx_${randomUUID()}`);
  const onStep = opts.onStep ?? null;
  const wantDirFsync = opts.dirFsync !== false;

  if (typeof rootInput !== "string" || rootInput.trim() === "") {
    throw new FileServiceError("FILE_SERVICE_ROOT_REQUIRED",
      "createFileService 必须显式传入 root（知识库根的绝对路径）：M10 收口 A 之后，默认根不再是本模块的知识，改由域层配置提供");
  }
  if (!(await exists(rootInput))) {
    throw new FileServiceError("PATH_OUT_OF_SCOPE", `知识库根不存在：${rootInput}`);
  }
  const root = await realpath(rootInput);

  const STATE_DIR = join(root, ".state");
  const JOURNAL_DIR = join(STATE_DIR, "journal");
  const STAGING_DIR = join(STATE_DIR, "staging");
  const CURSORS_FILE = join(STATE_DIR, "cursors.json");
  const DELETIONS_FILE = join(STATE_DIR, "deletions.json");

  const caps = { dirFsync: false, dirFsyncError: null };

  async function ensureDir(absDir) {
    // 逐级创建，并保证每一级都落在 root 内（防符号链接越界）
    const relParts = relative(root, absDir).split(sep).filter(Boolean);
    let cur = root;
    for (const part of relParts) {
      cur = join(cur, part);
      if (!(await exists(cur))) await mkdir(cur);
      const real = await realpath(cur);
      if (!isInside(root, real)) {
        throw new FileServiceError("PATH_OUT_OF_SCOPE", `目录解析后越出 45：${cur} → ${real}`);
      }
    }
  }

  /**
   * 把相对路径解析为 root 内的绝对路径。
   * 安全性：对**已存在的最深祖先**做 realpath 并验证仍在 root 内，
   * 因此任何一级符号链接跳出 45 都会被拒绝；不存在的那几级不可能是符号链接。
   */
  async function resolveRel(rel, { forWrite = false } = {}) {
    const norm = normalizeRel(rel);
    const abs = join(root, norm);
    let probe = abs;
    const tail = [];
    // 找到已存在的最深祖先
    for (;;) {
      if (await exists(probe)) break;
      const parent = dirname(probe);
      if (parent === probe) break;
      tail.unshift(probe.slice(parent.length + 1));
      probe = parent;
    }
    const realProbe = await realpath(probe);
    if (!isInside(root, realProbe)) {
      throw new FileServiceError("PATH_OUT_OF_SCOPE",
        `路径经 realpath 越出 45：${rel} → ${realProbe}（拒绝路径穿越与符号链接越界）`);
    }
    const resolvedAbs = tail.length ? join(realProbe, ...tail) : realProbe;
    if (!isInside(root, resolvedAbs)) {
      throw new FileServiceError("PATH_OUT_OF_SCOPE", `解析结果越出 45：${rel}`);
    }
    if (forWrite && (await exists(abs))) {
      const st = await lstat(abs);
      if (st.isSymbolicLink()) {
        throw new FileServiceError("PATH_OUT_OF_SCOPE", `拒绝写入符号链接目标：${rel}`);
      }
    }
    return { rel: norm, abs: resolvedAbs };
  }

  async function fsyncDir(absDir) {
    if (!wantDirFsync) return;
    let fh = null;
    try {
      fh = await open(absDir, "r");
      await fh.sync();
      caps.dirFsync = true;
    } catch (e) {
      if (["EINVAL", "ENOTSUP", "EPERM", "EACCES", "EBADF", "EISDIR"].includes(e.code)) {
        caps.dirFsyncError = e.code;
      } else {
        throw e;
      }
    } finally {
      if (fh) await fh.close().catch(() => {});
    }
  }

  /** 单文件原子写：同目录 tmp → fsync 文件 → rename → fsync 目录。 */
  async function writeBytesAtomic(absPath, bytes) {
    const dir = dirname(absPath);
    await ensureDir(dir);
    const tmp = join(dir, `.dsh-reading-tmp-${randomUUID()}`);
    let fh = null;
    try {
      fh = await open(tmp, "wx");
      await fh.writeFile(bytes);
      await fh.sync();
      await fh.close();
      fh = null;
      await rename(tmp, absPath);
      await fsyncDir(dir);
    } catch (e) {
      if (fh) await fh.close().catch(() => {});
      await rm(tmp, { force: true }).catch(() => {});
      throw e;
    }
  }

  async function readBytes(absPath) {
    try {
      return await readFile(absPath);
    } catch (e) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
  }

  async function hashOfRel(rel) {
    const { abs } = await resolveRel(rel);
    const buf = await readBytes(abs);
    return buf === null ? null : sha256Hex(buf);
  }

  // ------------------------------------------------------------------------- //
  // 辅助状态 JSON（白名单守卫 + 原子写）
  // ------------------------------------------------------------------------- //
  async function readStateJson(absPath, fallback) {
    const buf = await readBytes(absPath);
    if (buf === null) return fallback;
    try {
      return JSON.parse(buf.toString("utf8"));
    } catch (e) {
      throw new FileServiceError("INVALID_FRONTMATTER", `辅助状态 JSON 无法解析：${absPath}：${e.message}`);
    }
  }

  async function writeStateJson(absPath, payload, kind) {
    if (kind) assertValid(validateStatePayload(kind, payload), `辅助状态 ${kind}`);
    await writeBytesAtomic(absPath, Buffer.from(JSON.stringify(payload, null, 2) + "\n", "utf8"));
  }

  // ------------------------------------------------------------------------- //
  // journal
  // ------------------------------------------------------------------------- //
  const journalPath = (id) => join(JOURNAL_DIR, `${id}.json`);
  const stagingDir = (id) => join(STAGING_DIR, id);

  async function writeJournal(tx) {
    tx.updated_at = now().toISOString();
    await writeStateJson(journalPath(tx.id), tx, "journal");
  }

  async function readJournal(id) {
    if (typeof id !== "string" || !/^[A-Za-z0-9_.-]+$/.test(id)) {
      throw new FileServiceError("INVALID_VALUE", `非法 transaction id：${JSON.stringify(id)}`);
    }
    const buf = await readBytes(journalPath(id));
    if (buf === null) throw new FileServiceError("INVALID_VALUE", `找不到 transaction ${id}`);
    try {
      return JSON.parse(buf.toString("utf8"));
    } catch (e) {
      throw new FileServiceError("RECOVERY_REQUIRED", `journal 无法解析：${id}：${e.message}`);
    }
  }

  async function listJournals() {
    if (!(await exists(JOURNAL_DIR))) return [];
    const names = await readdir(JOURNAL_DIR);
    const out = [];
    for (const n of names) {
      if (!n.endsWith(".json")) continue;
      try {
        out.push(JSON.parse((await readFile(join(JOURNAL_DIR, n))).toString("utf8")));
      } catch {
        out.push({ id: n.replace(/\.json$/, ""), state: "unreadable" });
      }
    }
    return out.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }

  function assertTransition(tx, next) {
    const allowed = ALLOWED_TRANSITIONS[tx.state] ?? [];
    if (!allowed.includes(next)) {
      throw new FileServiceError("INVALID_TRANSITION",
        `FileTransaction 不允许 ${tx.state} → ${next}（PRD §11.5）`);
    }
    tx.state = next;
  }

  /** applying 不能直接 aborted；必须先经 recovering（PRD §11.5 允许边）。 */
  function transitionToAborted(tx) {
    if (tx.state === "applying") assertTransition(tx, "recovering");
    if (tx.state !== "aborted") assertTransition(tx, "aborted");
  }

  /** 走到 committed 的合法路径（conflict/prepared 都要先经过 applying）。 */
  function transitionToCommitted(tx) {
    if (tx.state === "committed") return;
    if (tx.state === "prepared") assertTransition(tx, "applying");
    if (tx.state === "conflict") assertTransition(tx, "recovering");
    if (tx.state === "recovering") assertTransition(tx, "applying");
    assertTransition(tx, "committed");
  }

  /** 走到 conflict 的合法路径：PRD §11.5 只允许 applying→recovering→conflict。 */
  function transitionToConflict(tx) {
    if (tx.state === "conflict") return;
    if (tx.state === "prepared") assertTransition(tx, "applying");
    if (tx.state === "applying") assertTransition(tx, "recovering");
    assertTransition(tx, "conflict");
  }

  // ------------------------------------------------------------------------- //
  // 删除屏障（PRD §13.4）
  // ------------------------------------------------------------------------- //
  const emptyDeletions = () => ({ schema_version: SCHEMA_VERSION, updated_at: null, barriers: [] });

  async function readDeletions() {
    const d = await readStateJson(DELETIONS_FILE, emptyDeletions());
    if (!Array.isArray(d.barriers)) d.barriers = [];
    return d;
  }

  async function addDeletionBarrier({ scopeId, pathPrefixes = [], objectIds = [], cancelledJobIds = [] }) {
    if (typeof scopeId !== "string" || scopeId.trim() === "") {
      throw new FileServiceError("INVALID_VALUE", "删除屏障必须有 scope_id");
    }
    if (pathPrefixes.length === 0 && objectIds.length === 0) {
      throw new FileServiceError("INVALID_VALUE", "删除屏障必须限定范围（path_prefixes 或 object_ids 至少一项）");
    }
    const prefixes = pathPrefixes.map((p) => normalizeRel(p));
    const d = await readDeletions();
    if (d.barriers.some((b) => b.scope_id === scopeId)) {
      throw new FileServiceError("INVALID_VALUE", `删除屏障 scope_id 重复：${scopeId}`);
    }
    const barrier = {
      scope_id: scopeId,
      at: now().toISOString(),
      version: (d.barriers.length + 1),
      cancelled_job_ids: [...cancelledJobIds],
      path_prefixes: prefixes,
      object_ids: [...objectIds],
    };
    d.barriers.push(barrier);
    d.updated_at = now().toISOString();
    await writeStateJson(DELETIONS_FILE, d, "deletions");
    return barrier;
  }

  async function removeDeletionBarrier(scopeId) {
    const d = await readDeletions();
    const before = d.barriers.length;
    d.barriers = d.barriers.filter((b) => b.scope_id !== scopeId);
    if (d.barriers.length === before) return false;
    d.updated_at = now().toISOString();
    await writeStateJson(DELETIONS_FILE, d, "deletions");
    return true;
  }

  function barrierMatches(barrier, rel) {
    const target = rel;
    return (barrier.path_prefixes ?? []).some((p) => target === p || target.startsWith(p.endsWith("/") ? p : p + "/"));
  }

  /** 提交前再次检查（PRD §9.3 第 2 步 / §13.4：迟到结果不得落笔）。 */
  async function assertNoBarrier(rel) {
    const d = await readDeletions();
    const hit = d.barriers.find((b) => barrierMatches(b, rel));
    if (hit) {
      throw new FileServiceError("DELETION_BARRIER",
        `${rel} 命中删除屏障 ${hit.scope_id}（${hit.at}）：迟到模型输出或旧提案不得落笔`);
    }
  }

  // ------------------------------------------------------------------------- //
  // 水位（PRD §11.5：processed ≤ durable ≤ observed）
  // ------------------------------------------------------------------------- //
  const cursorKey = (sessionId, branchId) => `${sessionId}|${branchId}`;
  const emptyCursors = () => ({ schema_version: SCHEMA_VERSION, updated_at: null, cursors: {} });

  async function readCursors() {
    const d = await readStateJson(CURSORS_FILE, emptyCursors());
    if (d.cursors === null || typeof d.cursors !== "object" || Array.isArray(d.cursors)) d.cursors = {};
    return d;
  }

  async function writeCursors(next) {
    next.schema_version = SCHEMA_VERSION;
    next.updated_at = now().toISOString();
    for (const [k, entry] of Object.entries(next.cursors ?? {})) {
      assertValid(validateCursorEntry(entry, { key: `cursors.${k}` }), `cursor ${k}`);
    }
    await writeStateJson(CURSORS_FILE, next, "cursors");
    return next;
  }

  /**
   * 建立/更新一个来源的水位。**不变式在写入前强制**：
   * 违反 processed ≤ durable ≤ observed 直接拒绝，不写盘。
   */
  async function setWatermarks({ sessionId, branchId, sourceRevision }, patch = {}) {
    if (!sessionId || !branchId) {
      throw new FileServiceError("INVALID_VALUE", "水位必须绑定 session_id 与 branch_id（不把 seq 当跨分支身份）");
    }
    const d = await readCursors();
    const key = cursorKey(sessionId, branchId);
    const prev = d.cursors[key] ?? {
      session_id: sessionId,
      branch_id: branchId,
      source_revision: sourceRevision ?? null,
      observed_through_seq: null,
      durable_through_seq: null,
      processed_through_seq: null,
      durability_evidence: null,
      source_gate: { state: "unknown", requested_through_seq: null },
    };
    const merged = { ...prev, ...patch };
    merged.session_id = sessionId;
    merged.branch_id = branchId;
    if (sourceRevision !== undefined) merged.source_revision = sourceRevision;
    if (!merged.source_gate) merged.source_gate = { state: "unknown", requested_through_seq: null };
    const check = validateCursorEntry(merged, { key });
    if (!check.ok) {
      const err = check.errors[0];
      throw new FileServiceError(err.code, `水位写入被拒（${key}）：${err.message}`, { errors: check.errors });
    }
    d.cursors[key] = merged;
    await writeCursors(d);
    return merged;
  }

  async function getCursor(sessionId, branchId) {
    const d = await readCursors();
    return d.cursors[cursorKey(sessionId, branchId)] ?? null;
  }

  // ------------------------------------------------------------------------- //
  // 事务
  // ------------------------------------------------------------------------- //
  function validateTargetSpec(t) {
    if (!t || typeof t !== "object") throw new FileServiceError("INVALID_STRUCTURE", "target 必须是对象");
    if (typeof t.path !== "string") throw new FileServiceError("INVALID_STRUCTURE", "target.path 必须是字符串");
    if (t.content === undefined) throw new FileServiceError("INVALID_STRUCTURE", "target.content 必填");
    if (!["create", "update"].includes(t.kind)) {
      throw new FileServiceError("INVALID_STRUCTURE", `target.kind 只能是 create/update，得到 ${t.kind}`);
    }
    if (t.kind === "update" && typeof t.expectedBeforeHash !== "string") {
      throw new FileServiceError("HASH_CONFLICT",
        `更新 ${t.path} 必须带 expectedBeforeHash（乐观冲突检测；不接受无前置条件的覆盖）`);
    }
  }

  /**
   * 核对「日志里记着 committed」的事务，盘上的产物是否**真的**对得上。
   *
   * 为什么必须核：`beginTransaction` 命中幂等键、且记录是 committed 时会直接返回
   * `replayed: true`。如果此时产物已被**绕过本服务**删除或改动，那就是**假成功** ——
   * 实测：旁路 `rm` 掉文件后同键同体重放，系统照样报 `committed / replayed: true`，
   * 而盘上什么都没有。这类"报告成功但产物不在"正是本项目最不能容忍的一种谎。
   *
   * 只读：不改任何东西，也不"顺手修好"。返回不一致项清单（空数组 = 一致）。
   */
  async function findCommittedDrift(tx) {
    const drift = [];
    for (const s of Array.isArray(tx.steps) ? tx.steps : []) {
      let cur = null;
      try {
        const { abs } = await resolveRel(s.path);
        const buf = await readBytes(abs);
        cur = buf === null ? null : sha256Hex(buf);
      } catch (e) {
        drift.push({ path: s.path, reason: "读不出来", detail: String(e?.message ?? e) });
        continue;
      }
      if (cur !== s.after_hash) {
        drift.push({
          path: s.path,
          reason: cur === null ? "产物不存在" : "内容与记录不符",
          expected: s.after_hash,
          actual: cur,
        });
      }
    }
    return drift;
  }

  /**
   * 创建并耐久记录一个 prepared 事务。此时**目标文件尚未被改动**。
   * @returns {Promise<{id:string, state:string, steps:Array, replayed?:boolean}>}
   */
  async function beginTransaction({ purpose, targets, receipt = null, idempotencyKey = null, inputFingerprint = null }) {
    if (!TRANSACTION_PURPOSES.includes(purpose)) {
      throw new FileServiceError("INVALID_VALUE",
        `purpose 必须是 ${TRANSACTION_PURPOSES.join(" / ")}，得到 ${JSON.stringify(purpose)}`);
    }
    const list = targets ?? [];
    if (!Array.isArray(list)) {
      throw new FileServiceError("INVALID_VALUE", "targets 必须是数组");
    }
    if (list.length === 0) {
      // 零目标只对"回执型" purpose 开放，且必须带合法回执——否则就是"什么都没做却记成功"
      if (!RECEIPT_ONLY_PURPOSES.includes(purpose)) {
        throw new FileServiceError("INVALID_VALUE",
          `purpose=${purpose} 至少要有一个 target（零目标只允许 ${RECEIPT_ONLY_PURPOSES.join(" / ")}）`);
      }
      const r = validateNoChangeReceipt(receipt);
      if (!r.ok) {
        throw new FileServiceError(r.errors[0].code,
          `record_no_change 需要耐久回执：${r.errors.map((e) => e.message).join("；")}`);
      }
    } else if (receipt !== null && receipt !== undefined) {
      throw new FileServiceError("INVALID_VALUE", "只有零目标的 record_no_change 事务可以带 receipt");
    }
    const targets2 = list;
    const seen = new Set();
    for (const t of targets2) {
      validateTargetSpec(t);
      const norm = normalizeRel(t.path);
      if (seen.has(norm)) throw new FileServiceError("INVALID_VALUE", `同一事务内路径重复：${norm}`);
      seen.add(norm);
    }

    // 幂等：同键同体返回既有结果；同键不同体报冲突（PRD §11.1）
    if (idempotencyKey !== null) {
      const found = await findByIdempotencyKey(idempotencyKey);
      if (found) {
        if (found.input_fingerprint !== inputFingerprint) {
          throw new FileServiceError("IDEMPOTENCY_CONFLICT",
            `幂等键 ${idempotencyKey} 已绑定不同请求体（既有指纹 ${found.input_fingerprint}）`);
        }
        if (found.state === "committed") {
          // 重放前**必须**核对盘上产物：不核对就返回 replayed:true 是假成功（见 findCommittedDrift）。
          const drift = await findCommittedDrift(found);
          if (drift.length > 0) {
            throw new FileServiceError("RECOVERY_REQUIRED",
              `事务 ${found.id} 在日志里是 committed，但盘上的产物对不上：`
              + drift.map((d) => `${d.path}（${d.reason}）`).join("；")
              + "。日志与磁盘不一致 —— 多半是有东西被绕过本服务删掉或改掉了。"
              + "这里**不当作已完成**，也**不自动重写**：请人工确认后再处理。");
          }
          return { id: found.id, state: found.state, steps: found.steps, replayed: true };
        }
        return { id: found.id, state: found.state, steps: found.steps, replayed: false };
      }
    }

    const id = newId();
    const steps = [];
    const stagedContent = [];
    for (let i = 0; i < targets2.length; i++) {
      const t = targets2[i];
      const { rel, abs } = await resolveRel(t.path, { forWrite: true });
      await assertNoBarrier(rel);
      const curBuf = await readBytes(abs);
      const curHash = curBuf === null ? null : sha256Hex(curBuf);
      if (t.kind === "create") {
        if (curBuf !== null) {
          throw new FileServiceError("TARGET_EXISTS", `新建要求目标不存在，但 ${rel} 已存在`);
        }
      } else {
        if (curBuf === null) {
          throw new FileServiceError("HASH_CONFLICT", `更新目标不存在：${rel}`);
        }
        if (curHash !== t.expectedBeforeHash) {
          throw new FileServiceError("HASH_CONFLICT",
            `${rel} 的当前 bytes hash 与 base_hash 不一致（可能已被人工修改）：期望 ${t.expectedBeforeHash}，实际 ${curHash}`);
        }
      }
      const contentBuf = Buffer.isBuffer(t.content) ? t.content : Buffer.from(String(t.content), "utf8");
      steps.push({
        index: i,
        path: rel,
        kind: t.kind,
        before_hash: curHash,
        after_hash: sha256Hex(contentBuf),
        state: "pending",
      });
      stagedContent.push(contentBuf);
    }

    // staging：先写新内容与恢复副本，再耐久写 journal
    // 零目标（no_change 回执）没有可暂存的东西，不留空目录。
    const sdir = stagingDir(id);
    if (steps.length > 0) await ensureDir(sdir);
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      await writeBytesAtomic(join(sdir, `${s.index}.new`), stagedContent[i]);
      if (s.before_hash !== null) {
        const { abs } = await resolveRel(s.path);
        const beforeBuf = await readBytes(abs);
        await writeBytesAtomic(join(sdir, `${s.index}.before`), beforeBuf);
      }
    }

    const tx = {
      schema_version: SCHEMA_VERSION,
      id,
      purpose,
      state: "prepared",
      recovery_revision: 0,
      idempotency_key: idempotencyKey,
      input_fingerprint: inputFingerprint,
      created_at: now().toISOString(),
      updated_at: now().toISOString(),
      steps,
      ...(receipt ? { receipt: { outcome: "no_change", ...receipt } } : {}),
    };
    await writeJournal(tx);
    if (onStep) await onStep({ txId: id, phase: "prepared", state: "prepared" });
    return { id, state: tx.state, steps: tx.steps };
  }

  /** 把 journal 标为 applying（耐久）后逐个替换目标；每步替换后耐久记录。 */
  async function applyTransaction(id) {
    const tx = await readJournal(id);
    if (TERMINAL_STATES.has(tx.state)) {
      return { id, state: tx.state, steps: tx.steps };
    }
    if (tx.state === "prepared") {
      assertTransition(tx, "applying");
      await writeJournal(tx);
    } else if (tx.state === "conflict") {
      return { id, state: tx.state, steps: tx.steps };
    } else if (tx.state !== "applying" && tx.state !== "recovering") {
      throw new FileServiceError("INVALID_TRANSITION", `apply 不接受状态 ${tx.state}`);
    }
    if (tx.state === "recovering") {
      assertTransition(tx, "applying");
      await writeJournal(tx);
    }

    const sdir = stagingDir(id);
    for (const s of tx.steps) {
      if (s.state === "done") continue;
      try {
        await assertNoBarrier(s.path);
        const { abs } = await resolveRel(s.path, { forWrite: true });
        const cur = await readBytes(abs);
        const curHash = cur === null ? null : sha256Hex(cur);
        if (curHash === s.after_hash) { s.state = "done"; await writeJournal(tx); continue; }
        if (curHash !== s.before_hash) {
          s.state = "conflict";
          transitionToConflict(tx);
          tx.recovery_revision += 1;
          await writeJournal(tx);
          return { id, state: tx.state, steps: tx.steps };
        }
        const staged = await readBytes(join(sdir, `${s.index}.new`));
        if (staged === null) {
          assertTransition(tx, "recovering");
          tx.recovery_revision += 1;
          await writeJournal(tx);
          return { id, state: tx.state, steps: tx.steps };
        }
        await ensureDir(dirname(abs));
        await writeBytesAtomic(abs, staged);
        const after = await readBytes(abs);
        if (after === null || sha256Hex(after) !== s.after_hash) {
          throw new FileServiceError("RECOVERY_REQUIRED", `${s.path} 替换后 hash 校验失败`);
        }
        s.state = "done";
        await writeJournal(tx);
        if (onStep) await onStep({ txId: id, index: s.index, path: s.path, phase: "step-done" });
      } catch (e) {
        if (e instanceof FileServiceError && e.code === "DELETION_BARRIER") {
          assertTransition(tx, "recovering");
          tx.recovery_revision += 1;
          await writeJournal(tx);
          throw e;
        }
        assertTransition(tx, "recovering");
        tx.recovery_revision += 1;
        tx.last_error = { code: e.code ?? "UNKNOWN", detail: String(e.message ?? e) };
        await writeJournal(tx);
        return { id, state: tx.state, steps: tx.steps };
      }
    }

    assertTransition(tx, "committed");
    await writeJournal(tx);
    // 已提交：.new 不再需要（内容已在目标里）；.before 作为恢复副本保留（保留期见 PRD §18，P2 细化）
    for (const s of tx.steps) {
      await rm(join(sdir, `${s.index}.new`), { force: true }).catch(() => {});
    }
    if (onStep) await onStep({ txId: id, phase: "committed", state: "committed" });
    return { id, state: tx.state, steps: tx.steps };
  }

  /**
   * 恢复一个未决事务（PRD §9.4）：逐目标核对 hash。
   *   等于 after → 该步已执行；等于 before → 可继续；两者都不同 → conflict。
   *
   * 关键语义：**prepared 且目标全未变 → aborted，绝不自动续做**。
   * prepared 表示"已校验范围、已耐久写 journal，但尚未开始替换"；
   * 此时崩溃说明提交动作本身可能没发生（begin 也用于把提案暂存待审），
   * 自动把它 apply 完就等于替用户按下了确认键。
   */
  async function recoverTransaction(id) {
    const tx = await readJournal(id);
    if (TERMINAL_STATES.has(tx.state)) return { id, state: tx.state, steps: tx.steps };

    let allAfter = tx.steps.length > 0;   // 空 steps 不能"真空为真"，否则 prepared 回执会被误判成已完成
    let anyExternal = false;
    const externalSteps = [];
    for (const s of tx.steps) {
      const { abs } = await resolveRel(s.path);
      const buf = await readBytes(abs);
      const cur = buf === null ? null : sha256Hex(buf);
      if (cur === s.after_hash) continue;
      allAfter = false;
      if (cur !== s.before_hash) { anyExternal = true; externalSteps.push(s); }
    }

    const sdir = stagingDir(id);

    if (allAfter) {
      transitionToCommitted(tx);
      tx.recovery_revision += 1;
      await writeJournal(tx);
      return { id, state: tx.state, steps: tx.steps };
    }

    if (anyExternal) {
      // 记清楚是哪一步被人工改动，冲突才能被人看懂、而不是只有一个总状态
      for (const s of externalSteps) s.state = "conflict";
      transitionToConflict(tx);
      tx.recovery_revision += 1;
      await writeJournal(tx);
      return { id, state: tx.state, steps: tx.steps };
    }

    // 到这里：每个目标都恰好等于 before —— 已证明"没有任何目标变更"
    if (tx.state === "prepared") {
      transitionToAborted(tx);
      tx.recovery_revision += 1;
      await writeJournal(tx);
      await rm(sdir, { recursive: true, force: true }).catch(() => {});
      return { id, state: tx.state, steps: tx.steps };
    }

    // applying/recovering/conflict：无外部改动，可从 staging 续做
    const pending = tx.steps.filter((s) => s.state !== "done");
    let staged = true;
    for (const s of pending) {
      if (!(await exists(join(sdir, `${s.index}.new`)))) { staged = false; break; }
    }
    if (staged) {
      if (tx.state === "conflict") assertTransition(tx, "recovering");
      if (tx.state === "recovering") assertTransition(tx, "applying");
      tx.recovery_revision += 1;
      await writeJournal(tx);
      return applyTransaction(id);
    }

    // 无 staging 且所有目标仍在 before：无变更可保 → aborted
    transitionToAborted(tx);
    tx.recovery_revision += 1;
    await writeJournal(tx);
    await rm(sdir, { recursive: true, force: true }).catch(() => {});
    return { id, state: tx.state, steps: tx.steps };
  }

  /** 恢复全部未决事务（重启入口）。 */
  async function recoverAll() {
    const journals = await listJournals();
    const out = [];
    for (const j of journals) {
      if (TERMINAL_STATES.has(j.state)) continue;
      out.push(await recoverTransaction(j.id));
    }
    return out;
  }

  /**
   * 安全回滚到 aborted：仅当每个目标都等于 after 或 before、且 after 有恢复副本时执行。
   * 任何外部改动 → conflict，不动文件。
   */
  async function rollbackTransaction(id) {
    const tx = await readJournal(id);
    if (tx.state === "committed") {
      throw new FileServiceError("INVALID_TRANSITION", "已 committed 的事务不能回滚为 aborted（PRD §11.5）");
    }
    if (tx.state === "aborted") return { id, state: tx.state, steps: tx.steps };
    const sdir = stagingDir(id);
    const plan = [];
    for (const s of tx.steps) {
      const { abs } = await resolveRel(s.path);
      const buf = await readBytes(abs);
      const cur = buf === null ? null : sha256Hex(buf);
      if (cur === s.before_hash) continue;              // 本来就是原样
      if (cur === s.after_hash) {
        if (s.before_hash === null) {
          plan.push({ s, abs, action: "unlink" });
        } else if (await exists(join(sdir, `${s.index}.before`))) {
          plan.push({ s, abs, action: "restore" });
        } else {
          tx.state = "conflict";
          tx.recovery_revision += 1;
          await writeJournal(tx);
          return { id, state: tx.state, steps: tx.steps };
        }
        continue;
      }
      tx.state = "conflict";
      tx.recovery_revision += 1;
      await writeJournal(tx);
      return { id, state: tx.state, steps: tx.steps };
    }
    for (const p of plan) {
      if (p.action === "unlink") {
        await rm(p.abs, { force: true });
        await fsyncDir(dirname(p.abs));
      } else {
        const beforeBuf = await readBytes(join(sdir, `${p.s.index}.before`));
        await writeBytesAtomic(p.abs, beforeBuf);
      }
    }
    for (const s of tx.steps) s.state = "rolled_back";
    transitionToAborted(tx);
    tx.recovery_revision += 1;
    await writeJournal(tx);
    await rm(sdir, { recursive: true, force: true }).catch(() => {});
    return { id, state: tx.state, steps: tx.steps };
  }

  /** begin + apply 一步到位。 */
  async function commit({ purpose, targets, receipt = null, idempotencyKey = null, inputFingerprint = null }) {
    const begun = await beginTransaction({ purpose, targets, receipt, idempotencyKey, inputFingerprint });
    if (begun.replayed) return { ...begun, replayed: true };
    const applied = await applyTransaction(begun.id);
    return { ...applied, replayed: false };
  }

  /**
   * 记录一条 no_change 的耐久回执（PRD §8.7）。
   * 不写任何 Markdown；回执就是 journal 本身，可被幂等键查到以防重提同范围。
   *
   * 只接受完整 `receipt` 对象：不接受 checkId/sourceRange 之类的散参数，
   * 否则调用方多传的字段会被静默丢掉——那正好是"把正文写进辅助 JSON"的温床。
   */
  async function recordNoChange({ receipt, idempotencyKey = null, inputFingerprint = null } = {}) {
    return commit({ purpose: "record_no_change", receipt, idempotencyKey, inputFingerprint });
  }

  async function findByIdempotencyKey(key) {
    const journals = await listJournals();
    return journals.find((j) => j.idempotency_key === key) ?? null;
  }

  async function listTransactions() {
    return listJournals();
  }

  // ------------------------------------------------------------------------- //
  // 读取
  // ------------------------------------------------------------------------- //
  /** 读取一个正式 Markdown：bytes hash 用原始字节算，解析用解码后的文本。 */
  async function readNote(rel) {
    const { rel: norm, abs } = await resolveRel(rel);
    const buf = await readBytes(abs);
    if (buf === null) {
      return {
        rel: norm, abs, exists: false, hash: null, data: null, body: "",
        errors: [{ code: "SOURCE_UNAVAILABLE", message: `文件不存在：${norm}` }],
      };
    }
    const parsed = parseNote(buf.toString("utf8"));
    return {
      rel: norm,
      abs,
      exists: true,
      bytes: buf.length,
      hash: sha256Hex(buf),
      data: parsed.data,
      body: parsed.body,
      yamlText: parsed.yamlText,
      hasFrontmatter: parsed.hasFrontmatter,
      errors: parsed.errors,
    };
  }

  /** 手改检测：与已知 hash 比对（PRD §8.4：手改以 bytes hash 识别）。 */
  async function checkManualEdit(rel, expectedHash) {
    const { rel: norm, abs } = await resolveRel(rel);
    const buf = await readBytes(abs);
    if (buf === null) return { rel: norm, exists: false, hash: null, changed: expectedHash !== null };
    const hash = sha256Hex(buf);
    return { rel: norm, exists: true, hash, changed: hash !== expectedHash };
  }

  /**
   * 幂等指纹：只由**调用方给出的请求体**决定（purpose + 目标路径 + 写入内容）。
   *
   * 刻意**不掺** isCreate/kind —— 它们是磁盘现状的派生量：同键重放时文件已存在，
   * isCreate 会从 true 翻成 false，掺进来会让**合法重放**被误判成「同键异体」冲突。
   * 也**不掺** expectedHash —— 它是并发前置条件、不是请求体，掺进来会让重试误报冲突。
   */
  function noteInputFingerprint(purpose, norm, text) {
    return sha256Hex(`${purpose}\u0000${norm}\u0000${text}`);
  }

  /** 写一个正式 Markdown（frontmatter 已由调用方校验）。始终走事务，不提供绕过口。 */
  async function writeNote(rel, { data, body = "", expectedHash = null, idempotencyKey = null, purpose = "update_note", create = null }) {
    const { rel: norm } = await resolveRel(rel, { forWrite: true });
    const isCreate = create === null ? !(await exists(join(root, norm))) : create;
    const text = composeNote(data, body);
    return commit({
      purpose,
      idempotencyKey,
      // 带幂等键时必须给出指纹：否则 beginTransaction 的「同键异体」守卫拿 null !== null 比，
      // 恒不触发，同键换内容会被**静默当成重放**、返回旧结果还报成功。
      inputFingerprint: idempotencyKey === null ? null : noteInputFingerprint(purpose, norm, text),
      targets: [{
        path: norm,
        kind: isCreate ? "create" : "update",
        content: text,
        expectedBeforeHash: isCreate ? undefined : expectedHash,
      }],
    });
  }

  function capabilities() {
    return { root, dirFsync: caps.dirFsync, dirFsyncError: caps.dirFsyncError, writesLimitedTo: root };
  }

  return {
    root,
    capabilities,
    resolveRel,
    hashOf: hashOfRel,
    readNote,
    writeNote,
    checkManualEdit,
    beginTransaction,
    applyTransaction,
    recoverTransaction,
    recoverAll,
    rollbackTransaction,
    commit,
    recordNoChange,
    listTransactions,
    findByIdempotencyKey,
    // 供**任何**「按幂等键报重放」的调用方复用：日志说 committed ≠ 产物还在。
    // 单独查 journal 再直接报「已存过」就是假成功（M14 审计发现），核对这一步只有这一份实现。
    findCommittedDrift,
    readCursors,
    writeCursors,
    setWatermarks,
    getCursor,
    readDeletions,
    addDeletionBarrier,
    removeDeletionBarrier,
    // 内部/测试可见
    _paths: { STATE_DIR, JOURNAL_DIR, STAGING_DIR, CURSORS_FILE, DELETIONS_FILE },
    _writeBytesAtomic: writeBytesAtomic,
    _readBytes: readBytes,
  };
}

export { SchemaError, validateWatermarks };
