/**
 * tools/lib/safe-delete.mjs · 「删真实库任何东西」的**唯一走法**（M14 收尾阶段 3）
 *
 * ## 规矩（3a/3b/3c）
 *   3a 删之前必须**逐字节备份** + 写 **sha256 清单** + **打印备份路径**；
 *   3b 备份放**库外**（默认 `/tmp/<任务名>-<时间戳>/`），**保留到用户确认**，脚本不自动清；
 *   3c 删之前仍要走 `addDeletionBarrier`（屏障本意：**别让旧事务自动复活**）。
 *
 * ## 顺序被钉死，任何一步失败都**不删**
 *   逐字节备份 → **核对备份确实一致** → 加删除屏障 → 才删 → 核对真的删掉了
 *
 * 为什么把「核对备份」也做成硬步骤：只写不核，等于「以为备份了」——
 * 真出事时才发现备份是坏的/空的。这里读回来比 sha256，不一致就**停手、什么都没删**。
 *
 * 为什么不提供「不备份直接删」的口：那正是本文件要防的事。要删真实库的东西，
 * 就只有一个入口，且它必然留下可回滚的备份。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const sha256Hex = (buf) => createHash("sha256").update(buf).digest("hex");
export const sha256File = (p) => sha256Hex(readFileSync(p));

/** `/tmp/<任务名>-<时间戳>/`（库外；时间戳里的 `:`/`.` 换成 `-`，免得路径难用）。 */
export function defaultBackupDir(taskName, at = new Date()) {
  return `/tmp/${String(taskName || "safe-delete")}-${at.toISOString().replace(/[:.]/g, "-")}`;
}

/** child 是否落在 parent 里面（含相等）。 */
function isInside(parent, child) {
  const p = resolve(parent), c = resolve(child);
  const rel = relative(p, c);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/**
 * 备份 → 核对 → 加屏障 → 删。
 *
 * @param {object} o
 * @param {string} o.vault     知识库根（绝对路径）
 * @param {string[]} o.rels    要删的**库内相对路径**
 * @param {object} o.svc       file-service 实例（必须能 `addDeletionBarrier`）
 * @param {string} o.scopeId   删除屏障的 scope_id
 * @param {string} [o.taskName] 备份目录名（默认 `safe-delete`）
 * @param {string} [o.backupDir] 自定义备份目录（必须在**库外**）
 * @param {string[]} [o.objectIds] 屏障里的对象 id（可空）
 * @param {(s:string)=>void} [o.log]
 * @returns {Promise<{backupDir:string, files:Array, missing:string[], barrier:object|null, deleted:string[]}>}
 */
export async function backupThenDelete({
  vault, rels, svc, scopeId, taskName = "safe-delete", backupDir = null, objectIds = [], log = console.log,
} = {}) {
  if (typeof vault !== "string" || vault.trim() === "") throw new Error("backupThenDelete：vault 必填");
  if (!Array.isArray(rels)) throw new Error("backupThenDelete：rels 必须是数组");
  if (typeof scopeId !== "string" || scopeId.trim() === "") {
    throw new Error("backupThenDelete：scopeId 必填（删除屏障必须有个名字）");
  }
  if (!svc || typeof svc.addDeletionBarrier !== "function") {
    throw new Error("backupThenDelete：需要 file-service 实例（没有 addDeletionBarrier ⇒ 没有屏障 ⇒ 不许删）");
  }
  const dir = backupDir ?? defaultBackupDir(taskName);
  if (isInside(vault, dir)) {
    throw new Error(`backupThenDelete：备份目录必须在**库外**（3b），但它落在库里了：${dir}`);
  }

  const present = [], missing = [];
  for (const rel of rels) {
    if (typeof rel !== "string" || rel === "" || isAbsolute(rel) || rel.split(/[/\\]/).includes("..")) {
      throw new Error(`backupThenDelete：rel 必须是库内相对路径（拿到 ${JSON.stringify(rel)}）`);
    }
    (existsSync(join(vault, rel)) ? present : missing).push(rel);
  }
  if (present.length === 0) {
    return { backupDir: dir, files: [], missing, barrier: null, deleted: [] };
  }

  // ---- 1) 逐字节备份 + **核对**（不核就等于没备份）-------------------------
  mkdirSync(dir, { recursive: true });
  const files = [];
  for (const rel of present) {
    const buf = readFileSync(join(vault, rel));
    const dest = join(dir, rel.replace(/[/\\]/g, "__"));
    writeFileSync(dest, buf);
    const back = readFileSync(dest);
    const sha = sha256Hex(buf), shaBack = sha256Hex(back);
    if (sha !== shaBack || back.length !== buf.length) {
      throw new Error(`backupThenDelete：备份核对失败（${rel}）⇒ 停手，**什么都没删**`);
    }
    files.push({ rel, bytes: buf.length, sha256: sha, backup: dest, verified: true });
  }
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({
    kind: "safe_delete_backup",
    at: new Date().toISOString(),
    vault,
    scope_id: scopeId,
    files,
    missing,
  }, null, 2));
  writeFileSync(join(dir, "manifest.sha256"), files.map((f) => `${f.sha256}  ${f.rel}`).join("\n") + "\n");
  log(`      备份（逐字节已核对 + sha256 清单，**保留到你确认**）：${dir}`);
  for (const f of files) log(`        · ${f.rel}  ${f.bytes} 字节  sha256=${f.sha256.slice(0, 16)}…`);
  if (missing.length > 0) log(`        （另有 ${missing.length} 个本来就不在，未计入：${missing.join(", ")}）`);

  // ---- 2) 先加屏障（写不进去就不删）--------------------------------------
  const barrier = await svc.addDeletionBarrier({
    scopeId, pathPrefixes: files.map((f) => f.rel), objectIds,
  });
  log(`      删除屏障已写入 .state/deletions.json（scope_id=${scopeId}）`);

  // ---- 3) 删，并核对真的删掉了 -------------------------------------------
  const deleted = [];
  for (const f of files) {
    rmSync(join(vault, f.rel));
    if (existsSync(join(vault, f.rel))) throw new Error(`backupThenDelete：删除失败（${f.rel}）`);
    deleted.push(f.rel);
  }
  return { backupDir: dir, files, missing, barrier, deleted };
}
