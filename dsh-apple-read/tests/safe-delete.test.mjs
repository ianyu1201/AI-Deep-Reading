/**
 * tests/safe-delete.test.mjs · 「删真实库任何东西」的规矩**离线**验证（进 `npm test`）
 *
 * 对应 M14 收尾阶段 3（3a/3b/3c）。防的是这几件真会出人命的事：
 *
 *   · **没备份就删** —— 删完才发现没留底，用户的东西回不来；
 *   · **备份了但没核对** —— 只写不核 = 以为备份了（坏文件/空文件照样算「备份过」）；
 *   · **备份放在库里** —— 库一被清理/迁移，备份跟着一起没；
 *   · **先删后加屏障** —— 屏障的意义是「别让旧事务自动复活」，删完再加就晚了；
 *   · **屏障写不进去还继续删** —— 那就是明知没有护栏还动手。
 *
 * 纪律：只在 `mkdtemp` 沙箱里删；**不碰**真实知识库（真实库那一次走 m14-real-acceptance.e2e.mjs）。
 * 跑法：`node tests/safe-delete.test.mjs`
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { backupThenDelete, sha256Hex } from "../tools/lib/safe-delete.mjs";
import { createFileService } from "../lib/reading/file-service.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, "..");

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log("  ✓ " + m); };
const bad = (m, d) => { fail++; console.log("  ✗ " + m + (d ? " —— " + d : "")); };
const check = (c, m, d) => (c ? ok(m) : bad(m, d));
const is = (a, b, m) => check(a === b, m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`);

/** 造一个假知识库（`mkdtemp`，绝不是真实库）。 */
function sandbox(files = {}) {
  const root = mkdtempSync(join(tmpdir(), "safe-delete-"));
  mkdirSync(join(root, "阅读背景", "学习证据"), { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
  }
  return root;
}
const svcOf = (root) => createFileService({ root });

// =========================================================================== //
console.log("\n[1] 3a/3b/3c：备份（逐字节核对）→ 加屏障 → 才删；备份在库外");

{
  const kb = sandbox();
  const A = "阅读背景/学习证据/甲｜aaaaaaaaaaaaaaaa.md";
  const B = "阅读背景/学习证据/乙｜aaaaaaaaaaaaaaaa.md";
  writeFileSync(join(kb, A), "甲的内容\n");
  writeFileSync(join(kb, B), "乙的内容\n");
  const svc = await svcOf(kb);
  const backupDir = join(kb, "..", `safe-delete-out-${Date.now()}`); // 库外
  try {
    const r = await backupThenDelete({
      vault: kb, rels: [A, B], svc, scopeId: "del_test_1",
      taskName: "safe-delete-test", backupDir, log: () => {},
    });

    is(r.files.length, 2, "3a：两个文件都做了备份");
    check(!existsSync(join(kb, A)) && !existsSync(join(kb, B)), "3a：两个文件都真的删掉了");
    is(r.deleted.length, 2, "3a：返回里记了删掉的两个");

    // 备份**逐字节一致**（不是"文件存在"就算）
    const bA = join(backupDir, A.replace(/\//g, "__"));
    check(existsSync(bA), "3a：备份文件在");
    is(readFileSync(bA, "utf8"), "甲的内容\n", "3a：备份内容与原件**逐字节一致**");
    is(sha256Hex(readFileSync(bA)), r.files.find((f) => f.rel === A).sha256, "3a：备份 sha256 与清单一致");

    // 清单
    const manifest = JSON.parse(readFileSync(join(backupDir, "manifest.json"), "utf8"));
    is(manifest.files.length, 2, "3a：manifest.json 记了两个文件");
    check(manifest.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256)), "3a：每个都带 64 位 sha256");
    check(manifest.files.every((f) => f.verified === true), "3a：每个都标了「备份已核对」");
    const shaList = readFileSync(join(backupDir, "manifest.sha256"), "utf8");
    check(shaList.includes(manifest.files[0].sha256) && shaList.includes(A), "3a：另有 manifest.sha256 清单");

    // 3b：备份在库外
    check(!backupDir.startsWith(kb), "3b：备份目录**不在库里**");

    // 3c：删之前真的加了屏障，且屏障圈住了这两条路径
    // 读文件要**防崩**：屏障没写出来时 deletions.json 根本不存在，
    // 直接 readFileSync 会抛错 ⇒ 套件崩溃（零条 ✗）= 检查不可定位，等于没抓到。
    const delPath = join(kb, ".state", "deletions.json");
    const del = existsSync(delPath) ? JSON.parse(readFileSync(delPath, "utf8")) : { barriers: [] };
    const b = del.barriers.find((x) => x.scope_id === "del_test_1");
    check(!!b, "3c：删除屏障已写入 .state/deletions.json");
    is((b?.path_prefixes ?? []).sort().join("|"), [A, B].sort().join("|"), "3c：屏障圈的正是要删的那两条路径");
  } finally {
    rmSync(kb, { recursive: true, force: true });
    rmSync(backupDir, { recursive: true, force: true });
  }
}

// =========================================================================== //
console.log("\n[2] 3c：屏障写不进去 ⇒ **一个都不删**（顺序不能反）");

{
  const kb = sandbox();
  const A = "阅读背景/学习证据/丙｜aaaaaaaaaaaaaaaa.md";
  writeFileSync(join(kb, A), "丙的内容\n");
  const svc = await svcOf(kb);
  const backupDir = join(kb, "..", `safe-delete-out-${Date.now()}`);
  const brokenSvc = {
    addDeletionBarrier: async () => { throw new Error("写 deletions.json 失败（模拟）"); },
  };
  try {
    let threw = false;
    try {
      await backupThenDelete({
        vault: kb, rels: [A], svc: brokenSvc, scopeId: "del_test_2",
        taskName: "safe-delete-test", backupDir, log: () => {},
      });
    } catch { threw = true; }
    check(threw, "3c：加屏障失败 ⇒ 抛错（不静默继续）");
    check(existsSync(join(kb, A)), "3c：**文件还在**（屏障没加上就不许删）");
    const delPath2 = join(kb, ".state", "deletions.json");
    const barriers2 = existsSync(delPath2) ? JSON.parse(readFileSync(delPath2, "utf8")).barriers : [];
    is(barriers2.length, 0, "3c：库里也没有多出屏障（是失败，不是半成功）");
  } finally {
    rmSync(kb, { recursive: true, force: true });
    rmSync(backupDir, { recursive: true, force: true });
  }
}

// =========================================================================== //
console.log("\n[3] 3b：备份目录落在库里 ⇒ 拒绝，且什么都不删");

{
  const kb = sandbox();
  const A = "阅读背景/学习证据/丁｜aaaaaaaaaaaaaaaa.md";
  writeFileSync(join(kb, A), "丁的内容\n");
  const svc = await svcOf(kb);
  try {
    let threw = false, msg = "";
    try {
      await backupThenDelete({
        vault: kb, rels: [A], svc, scopeId: "del_test_3",
        backupDir: join(kb, "阅读背景", "学习证据", "_backup"), log: () => {},
      });
    } catch (e) { threw = true; msg = String(e?.message ?? e); }
    check(threw, "3b：备份目录在库里 ⇒ 拒绝执行");
    check(/库外/.test(msg), "3b：并把原因说清楚（要求库外）", msg);
    check(existsSync(join(kb, A)), "3b：文件还在（没删）");
  } finally { rmSync(kb, { recursive: true, force: true }); }
}

// =========================================================================== //
console.log("\n[4] 越界与缺失：不给绝对路径/`..`；本来就不在的不算删了");

{
  const kb = sandbox();
  const A = "阅读背景/学习证据/戊｜aaaaaaaaaaaaaaaa.md";
  writeFileSync(join(kb, A), "戊的内容\n");
  const svc = await svcOf(kb);
  const backupDir = join(kb, "..", `safe-delete-out-${Date.now()}`);
  try {
    let threw = false;
    try {
      await backupThenDelete({ vault: kb, rels: ["/etc/hosts"], svc, scopeId: "del_test_4a", backupDir, log: () => {} });
    } catch { threw = true; }
    check(threw, "绝对路径 ⇒ 拒绝（不许删到库外去）");

    threw = false;
    try {
      await backupThenDelete({ vault: kb, rels: ["../../etc/hosts"], svc, scopeId: "del_test_4b", backupDir, log: () => {} });
    } catch { threw = true; }
    check(threw, "带 `..` 的路径 ⇒ 拒绝");

    const r = await backupThenDelete({
      vault: kb, rels: [A, "阅读背景/学习证据/不存在.md"], svc,
      scopeId: "del_test_4c", backupDir, log: () => {},
    });
    is(r.files.length, 1, "只有真实存在的那一个被备份+删");
    is(r.missing.length, 1, "本来就不在的那个记进 missing（不当成「删掉了」）");
    check(!existsSync(join(kb, A)), "存在的那一个确实删了");
  } finally {
    rmSync(kb, { recursive: true, force: true });
    rmSync(backupDir, { recursive: true, force: true });
  }
}

// =========================================================================== //
console.log("\n[5] 没有 file-service（没有屏障口）⇒ 拒绝：不许出现「无护栏删除」");

{
  const kb = sandbox();
  const A = "阅读背景/学习证据/己｜aaaaaaaaaaaaaaaa.md";
  writeFileSync(join(kb, A), "己的内容\n");
  try {
    let threw = false, msg = "";
    try {
      await backupThenDelete({ vault: kb, rels: [A], svc: null, scopeId: "del_test_5", log: () => {} });
    } catch (e) { threw = true; msg = String(e?.message ?? e); }
    check(threw, "没有屏障口 ⇒ 拒绝执行");
    check(/屏障/.test(msg), "并把原因说清楚（没有屏障就不许删）", msg);
    check(existsSync(join(kb, A)), "文件还在（没删）");
  } finally { rmSync(kb, { recursive: true, force: true }); }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
