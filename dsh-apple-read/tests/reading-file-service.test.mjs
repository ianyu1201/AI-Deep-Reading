/**
 * tests/reading-file-service.test.mjs · M1 持久化地基 / file-service.js
 *
 * ## 纪律
 * 全部在**真磁盘**上跑（临时目录），不引入 fake-fs：M0 的教训是替身不忠实 →
 * 离线全绿、运行期失效。崩溃用**真 SIGKILL**（子进程自杀），不是 try/catch 模拟。
 *
 * ## 每项检查"在什么情况下会失败"
 *   [1] 路径白名单   — 用真符号链接跳出 45；若放行就失败
 *   [2] 单文件原子性 — 事务目录里不得残留 tmp；文件内容必须整体新旧二选一
 *   [3] journal 先于写入 — begin 后目标必须尚未改变；journal 已耐久
 *   [4] hash 保护    — base_hash 不符必须拒绝且**文件保持原样**
 *   [5] 手改检测     — 外部改一字节即 changed
 *   [6] 崩溃恢复     — SIGKILL 后 recoverAll 必须续做完成；文件内容完整
 *   [7] 手改冲突     — 崩溃后外部改另一目标 → conflict 且**保留人工内容**
 *   [8] 安全回滚     — 无外部改动才 aborted，且内容恢复原样
 *   [9] 删除屏障     — 屏障命中必须拒绝提交
 *  [10] 幂等         — 同键同体重放不重写；同键异体报冲突（commit 层 + writeNote 层各自验）
 *                       跑法可用 READING_FILE_SERVICE 指向变异副本（供 mutations.mjs 用）
 *  [11] 水位         — 不变式违反必须拒绝写盘
 *  [12] 辅助 JSON    — 知识/会话正文字段必须拒绝
 *
 * 跑法：node tests/reading-file-service.test.mjs
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHILD = join(HERE, "reading-crash-child.mjs");

// 允许变异测试把「改坏的副本」喂进来（默认仍是仓库里的真文件）
const FS_PATH = process.env.READING_FILE_SERVICE ?? join(HERE, "..", "lib", "reading", "file-service.js");
const { ALLOWED_TRANSITIONS, createFileService } = await import(pathToFileURL(FS_PATH).href);

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log("  ✓ " + m); };
const bad = (m, d) => { fail++; console.log("  ✗ " + m + (d ? "\n      " + d : "")); };
const is = (label, got, want) =>
  got === want ? ok(label) : bad(label, `得到 ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}`);

/** 固定 14 个子目录（规范 §1），与真实 vault 一致。 */
const FIXED_DIRS = [
  "阅读背景", "阅读背景/学习证据", "书籍", "概念", "理解变化", "推荐反馈",
  "待确认", "待确认/维护登记", ".state", ".state/journal", ".state/staging",
  ".cache", ".cache/lexical", ".cache/vectors",
];

async function makeRoot() {
  const base = await mkdtemp(join(tmpdir(), "dsh-reading-fs-"));
  const root = join(base, "45-书籍");
  for (const d of FIXED_DIRS) await mkdir(join(root, d), { recursive: true });
  await writeFile(join(root, "索引.md"), "---\nschema_version: '1.1'\nobject_type: index\n---\n\n# 索引\n");
  return { base, root };
}

async function expectCode(label, promise, code) {
  try {
    await promise;
    bad(label, `本应抛 ${code}，却成功了`);
  } catch (e) {
    if (e.code === code) ok(`${label} → ${code}`);
    else bad(label, `抛的是 ${e.code}（${e.message}），期望 ${code}`);
  }
}

const svc = (root, extra = {}) => createFileService({ root, ...extra });

// --------------------------------------------------------------------------- //
console.log("\n[0] root 必填（M10 收口 A：默认根已上移到域层 book-domain.js）");

{
  // 不带 root / root 为空 / root 非字符串 ⇒ 必须抛 FILE_SERVICE_ROOT_REQUIRED，
  // 而不是偷偷用一个写死的绝对路径 —— 那个写死路径正是收口 A 要修掉的泄漏
  // （`tests/reading-domain-boundary.test.mjs` 另有源码级守证）。
  await expectCode("createFileService({}) 不带 root", createFileService({}), "FILE_SERVICE_ROOT_REQUIRED");
  await expectCode("createFileService() 连 opts 都不给", createFileService(), "FILE_SERVICE_ROOT_REQUIRED");
  await expectCode("root 为空串", createFileService({ root: "" }), "FILE_SERVICE_ROOT_REQUIRED");
  await expectCode("root 为空白串", createFileService({ root: "   " }), "FILE_SERVICE_ROOT_REQUIRED");
  await expectCode("root 为 null", createFileService({ root: null }), "FILE_SERVICE_ROOT_REQUIRED");
  await expectCode("root 为数字", createFileService({ root: 123 }), "FILE_SERVICE_ROOT_REQUIRED");
}

// --------------------------------------------------------------------------- //
console.log("\n[1] 写权限只到 45-书籍/（含真实符号链接越界）");

{
  const { base, root } = await makeRoot();
  const s = await svc(root);

  for (const p of ["../外面.md", "/etc/passwd", "a/../../b.md", "./x.md", "待确认/../书籍/x.md", "", ".."]) {
    await expectCode(`拒绝 ${JSON.stringify(p)}`, s.resolveRel(p), "PATH_OUT_OF_SCOPE");
  }

  // 真符号链接：目录级跳出
  const outside = join(base, "外面");
  await mkdir(outside);
  await writeFile(join(outside, "秘密.md"), "secret");
  await symlink(outside, join(root, "概念", "链接"));
  await expectCode("拒绝符号链接目录越界", s.resolveRel("概念/链接/秘密.md", { forWrite: true }), "PATH_OUT_OF_SCOPE");

  // 真符号链接：文件级跳出
  await symlink(join(outside, "秘密.md"), join(root, "概念", "链接文件.md"));
  await expectCode("拒绝符号链接文件目标", s.resolveRel("概念/链接文件.md", { forWrite: true }), "PATH_OUT_OF_SCOPE");

  // 45 内的正常路径必须能过（否则上面的"拒绝"可能只是因为全都不让写）
  const good = await s.resolveRel("书籍/第一哲学沉思集｜笛卡尔/书籍信息.md", { forWrite: true }).catch((e) => e.code);
  good === "PATH_OUT_OF_SCOPE" ? bad("45 内路径应被允许") : ok("45 内路径被允许");

  await rm(base, { recursive: true, force: true });
}

// --------------------------------------------------------------------------- //
console.log("\n[2] 单文件原子写：无残留 tmp、内容整体一致");

{
  const { base, root } = await makeRoot();
  const s = await svc(root);
  const big = "行\n".repeat(20000) + "结束\n";
  const r = await s.commit({ purpose: "update_note", targets: [{ path: "概念/原子.md", kind: "create", content: big }] });
  is("大文件事务 committed", r.state, "committed");
  is("内容完整（不是半截）", readFileSync(join(root, "概念/原子.md"), "utf8"), big);

  const leftovers = (await readdir(join(root, "概念"))).filter((f) => f.startsWith(".dsh-reading-tmp-"));
  is("目标目录无 tmp 残留", leftovers.length, 0);
  const staging = await readdir(join(root, ".state/staging", r.id));
  staging.includes("0.new") ? bad("committed 后 .new 应清理") : ok("committed 后 .new 已清理");
  staging.includes("0.before") ? bad("create 不应有 before 副本") : ok("create 无 before 副本");

  is("capabilities 报告目录 fsync 可用", s.capabilities().dirFsync, true);
  is("写入范围即 root", s.capabilities().writesLimitedTo, s.root);

  await rm(base, { recursive: true, force: true });
}

// --------------------------------------------------------------------------- //
console.log("\n[3] journal 先耐久，目标后改动");

{
  const { base, root } = await makeRoot();
  const s = await svc(root);
  const begun = await s.beginTransaction({
    purpose: "save_proposal",
    targets: [
      { path: "待确认/甲.md", kind: "create", content: "# 甲\n" },
      { path: "待确认/乙.md", kind: "create", content: "# 乙\n" },
    ],
  });
  is("begin 后状态是 prepared", begun.state, "prepared");
  existsSync(join(root, "待确认/甲.md")) ? bad("begin 后目标不应存在") : ok("begin 后目标文件尚未创建（journal 先落盘）");
  const j = JSON.parse(readFileSync(join(root, ".state/journal", `${begun.id}.json`), "utf8"));
  is("journal 已耐久且 state=prepared", j.state, "prepared");
  is("journal 记录两步", j.steps.length, 2);
  j.steps.every((x) => x.state === "pending") ? ok("两步都是 pending") : bad("步骤状态", JSON.stringify(j.steps));
  // journal 不得含知识正文
  const jtxt = JSON.stringify(j);
  /"content"|完整会话/.test(jtxt) ? bad("journal 不应含正文") : ok("journal 不含正文（只有路径与 hash）");

  // 未 apply 就恢复 → 证明"没有目标变更"，应安全 aborted
  const rec = await s.recoverAll();
  is("恢复未 apply 的事务 → aborted", rec[0].state, "aborted");
  existsSync(join(root, "待确认/甲.md")) ? bad("aborted 后目标不应存在") : ok("aborted 后目标不存在");

  await rm(base, { recursive: true, force: true });
}

// --------------------------------------------------------------------------- //
console.log("\n[4] hash 保护：base_hash 不符必须拒绝且不动文件");

{
  const { base, root } = await makeRoot();
  const s = await svc(root);
  await s.commit({ purpose: "update_note", targets: [{ path: "概念/h.md", kind: "create", content: "原始内容\n" }] });
  const h = await s.hashOf("概念/h.md");

  // 外部手改
  writeFileSync(join(root, "概念/h.md"), "人工改过的内容\n");
  await expectCode("陈旧 base_hash 的更新被拒",
    s.commit({ purpose: "update_note", targets: [{ path: "概念/h.md", kind: "update", content: "覆盖\n", expectedBeforeHash: h }] }),
    "HASH_CONFLICT");
  is("被拒后人工内容保持原样", readFileSync(join(root, "概念/h.md"), "utf8"), "人工改过的内容\n");

  await expectCode("更新却不给 base_hash",
    s.commit({ purpose: "update_note", targets: [{ path: "概念/h.md", kind: "update", content: "x" }] }),
    "HASH_CONFLICT");

  await expectCode("create 目标已存在",
    s.commit({ purpose: "update_note", targets: [{ path: "概念/h.md", kind: "create", content: "x" }] }),
    "TARGET_EXISTS");

  const newHash = await s.hashOf("概念/h.md");
  const r = await s.commit({ purpose: "update_note", targets: [{ path: "概念/h.md", kind: "update", content: "正确覆盖\n", expectedBeforeHash: newHash }] });
  is("正确 base_hash 的更新通过", r.state, "committed");
  is("覆盖后内容正确", readFileSync(join(root, "概念/h.md"), "utf8"), "正确覆盖\n");

  // 手改检测
  const cur = await s.hashOf("概念/h.md");
  is("未改动时 changed=false", (await s.checkManualEdit("概念/h.md", cur)).changed, false);
  writeFileSync(join(root, "概念/h.md"), "又改了\n");
  is("改动后 changed=true", (await s.checkManualEdit("概念/h.md", cur)).changed, true);
  is("不存在的文件 changed=true", (await s.checkManualEdit("概念/没有.md", "x")).changed, true);

  await rm(base, { recursive: true, force: true });
}

// --------------------------------------------------------------------------- //
console.log("\n[5] 真 SIGKILL 崩溃：恢复必须续做完成");

{
  const { base, root } = await makeRoot();
  const txFile = join(base, "txid.txt");
  let killed = false;
  try {
    execFileSync(process.execPath, [CHILD, root, "kill-after-step0", txFile], { stdio: "pipe" });
  } catch (e) {
    killed = e.signal === "SIGKILL";
  }
  killed ? ok("子进程确实被 SIGKILL 杀死（不是正常退出）") : bad("子进程应被 SIGKILL 杀死");

  const txid = readFileSync(txFile, "utf8");
  const j = JSON.parse(readFileSync(join(root, ".state/journal", `${txid}.json`), "utf8"));
  is("崩溃时 journal 停在 applying", j.state, "applying");
  is("第 1 步已耐久记录为 done", j.steps[0].state, "done");
  is("第 2 步仍为 pending", j.steps[1].state, "pending");
  existsSync(join(root, "待确认/崩溃提案甲.md")) ? ok("第 1 步的落盘已生效") : bad("第 1 步文件应已存在");
  existsSync(join(root, "待确认/崩溃提案乙.md")) ? bad("第 2 步文件不应存在") : ok("第 2 步尚未落盘");

  // 新进程恢复（模拟重启）
  const s2 = await svc(root);
  const rec = await s2.recoverAll();
  is("恢复后事务 committed", rec[0].state, "committed");
  is("甲内容正确", readFileSync(join(root, "待确认/崩溃提案甲.md"), "utf8"), "# 甲\n");
  is("乙内容正确（续做完成）", readFileSync(join(root, "待确认/崩溃提案乙.md"), "utf8"), "# 乙\n");
  const j2 = JSON.parse(readFileSync(join(root, ".state/journal", `${txid}.json`), "utf8"));
  is("journal 终态 committed", j2.state, "committed");
  is("恢复修订号 +1", j2.recovery_revision >= 1, true);
  const again = await s2.recoverAll();
  is("再次恢复幂等（无未决事务）", again.length, 0);

  await rm(base, { recursive: true, force: true });
}

// --------------------------------------------------------------------------- //
console.log("\n[6] 崩溃后人工改动另一目标 → conflict，且保留人工内容");

{
  const { base, root } = await makeRoot();
  const txFile = join(base, "txid.txt");
  try { execFileSync(process.execPath, [CHILD, root, "kill-mid-multi", txFile], { stdio: "pipe" }); } catch { /* 预期被杀 */ }
  const txid = readFileSync(txFile, "utf8");

  // 第 2 步目标在崩溃后被人（Obsidian）创建/改动
  writeFileSync(join(root, "待确认/崩溃提案乙.md"), "# 人工写的乙\n");

  const s2 = await svc(root);
  const rec = await s2.recoverAll();
  is("检测到外部改动 → conflict", rec[0].state, "conflict");
  is("人工内容被保留（不被覆盖）", readFileSync(join(root, "待确认/崩溃提案乙.md"), "utf8"), "# 人工写的乙\n");
  is("第 1 步成果仍在", readFileSync(join(root, "待确认/崩溃提案甲.md"), "utf8"), "# 甲\n");
  const j = JSON.parse(readFileSync(join(root, ".state/journal", `${txid}.json`), "utf8"));
  j.steps.some((x) => x.state === "conflict") ? ok("journal 记录该步 conflict") : bad("journal 未记录 conflict", JSON.stringify(j.steps));

  // 人工清掉冲突目标后，才允许从 conflict 回到 recovering 续做
  await rm(join(root, "待确认/崩溃提案乙.md"), { force: true });
  const rec2 = await s2.recoverAll();
  is("外部改动清除后可续做 → committed", rec2[0].state, "committed");
  is("乙内容变为事务内容", readFileSync(join(root, "待确认/崩溃提案乙.md"), "utf8"), "# 乙\n");

  await rm(base, { recursive: true, force: true });
}

// --------------------------------------------------------------------------- //
console.log("\n[7] 安全回滚：只有无外部改动才 aborted");

{
  const { base, root } = await makeRoot();
  const s = await svc(root);
  // 先建一个已存在的文件，做 update 事务
  await s.commit({ purpose: "update_note", targets: [{ path: "概念/r.md", kind: "create", content: "原始\n" }] });
  const h = await s.hashOf("概念/r.md");
  const begun = await s.beginTransaction({
    purpose: "update_note",
    targets: [{ path: "概念/r.md", kind: "update", content: "新内容\n", expectedBeforeHash: h }],
  });
  const rb = await s.rollbackTransaction(begun.id);
  is("未写入就回滚 → aborted", rb.state, "aborted");
  is("内容保持原样", readFileSync(join(root, "概念/r.md"), "utf8"), "原始\n");

  // 已 apply 完（committed）就不能再回滚
  const begun2 = await s.beginTransaction({
    purpose: "save_proposal",
    targets: [
      { path: "待确认/r1.md", kind: "create", content: "# r1\n" },
      { path: "待确认/r2.md", kind: "create", content: "# r2\n" },
    ],
  });
  await s.applyTransaction(begun2.id);
  await expectCode("committed 不能回滚为 aborted", s.rollbackTransaction(begun2.id), "INVALID_TRANSITION");
  is("已 committed 的内容未被回滚", readFileSync(join(root, "待确认/r1.md"), "utf8"), "# r1\n");

  // 外部改动 → 回滚必须变 conflict 而不是覆盖
  const begun3 = await s.beginTransaction({
    purpose: "save_proposal",
    targets: [{ path: "待确认/r3.md", kind: "create", content: "# r3\n" }],
  });
  writeFileSync(join(root, "待确认/r3.md"), "# 人工抢先\n");
  const rb3 = await s.rollbackTransaction(begun3.id);
  is("有外部改动 → conflict", rb3.state, "conflict");
  is("人工内容未被回滚覆盖", readFileSync(join(root, "待确认/r3.md"), "utf8"), "# 人工抢先\n");

  await rm(base, { recursive: true, force: true });
}

// --------------------------------------------------------------------------- //
console.log("\n[8] 删除屏障（提交前再次检查）");

{
  const { base, root } = await makeRoot();
  const s = await svc(root);
  await s.addDeletionBarrier({ scopeId: "del_2026", pathPrefixes: ["待确认"], cancelledJobIds: ["job_9"] });

  await expectCode("屏障命中的提交被拒",
    s.commit({ purpose: "save_proposal", targets: [{ path: "待确认/迟到提案.md", kind: "create", content: "x" }] }),
    "DELETION_BARRIER");
  existsSync(join(root, "待确认/迟到提案.md")) ? bad("屏障命中不应落盘") : ok("屏障命中未落盘");

  // 屏障只覆盖 待确认，其他目录不受影响
  const r = await s.commit({ purpose: "update_note", targets: [{ path: "概念/不受影响.md", kind: "create", content: "ok" }] });
  is("屏障范围外正常写入", r.state, "committed");

  // apply 阶段才出现的屏障也要拦住（模拟删除发生在事务进行中）
  const begun = await s.beginTransaction({ purpose: "save_proposal", targets: [{ path: "概念/中途屏障.md", kind: "create", content: "x" }] });
  await s.addDeletionBarrier({ scopeId: "del_mid", pathPrefixes: ["概念/中途屏障.md"] });
  await expectCode("apply 阶段命中屏障", s.applyTransaction(begun.id), "DELETION_BARRIER");
  const j = JSON.parse(readFileSync(join(root, ".state/journal", `${begun.id}.json`), "utf8"));
  is("apply 失败后状态是 recovering（不是 failed）", j.state, "recovering");
  existsSync(join(root, "概念/中途屏障.md")) ? bad("屏障命中不应落盘") : ok("apply 阶段屏障命中未落盘");

  const dels = await s.readDeletions();
  is("屏障记录耐久", dels.barriers.length, 2);
  is("移除屏障", await s.removeDeletionBarrier("del_2026"), true);
  is("移除后不再命中", await s.removeDeletionBarrier("del_2026"), false);

  await rm(base, { recursive: true, force: true });
}

// --------------------------------------------------------------------------- //
console.log("\n[9] 幂等：同键同体重放、同键异体冲突");

{
  const { base, root } = await makeRoot();
  const s = await svc(root);
  const key = "idem-abc";
  const fp = "fingerprint-1";
  const a = await s.commit({
    purpose: "save_proposal", idempotencyKey: key, inputFingerprint: fp,
    targets: [{ path: "待确认/幂等.md", kind: "create", content: "# v1\n" }],
  });
  is("首次提交 committed", a.state, "committed");
  is("首次 replayed=false", a.replayed, false);

  const b = await s.commit({
    purpose: "save_proposal", idempotencyKey: key, inputFingerprint: fp,
    targets: [{ path: "待确认/幂等.md", kind: "create", content: "# v1\n" }],
  });
  is("同键同体 → 重放", b.replayed, true);
  is("重放返回同一事务 id", b.id, a.id);
  is("重放不产生第二次写入", readFileSync(join(root, "待确认/幂等.md"), "utf8"), "# v1\n");

  await expectCode("同键异体 → 冲突",
    s.commit({ purpose: "save_proposal", idempotencyKey: key, inputFingerprint: "fingerprint-2", targets: [{ path: "待确认/别的.md", kind: "create", content: "x" }] }),
    "IDEMPOTENCY_CONFLICT");

  const js = await s.listTransactions();
  is("幂等键只对应一个事务", js.filter((j) => j.idempotency_key === key).length, 1);

  await rm(base, { recursive: true, force: true });
}

// writeNote 层的幂等：这一层**不接受** inputFingerprint，必须自己从请求体算。
// 反例（曾是真缺口）：不算指纹 ⇒ 存的和传的都是 null ⇒ 守卫 `null !== null` 恒假 ⇒
// 同键换内容被**静默当成重放**、返回旧结果还报成功（调用方以为写进去了）。
{
  const { base, root } = await makeRoot();
  const s = await svc(root);
  const note = {
    schema_version: "1.1", object_type: "concept", id: "c_idem", revision: 1, title: "幂等概念",
    tags: ["reading"], scope: "reading", knowledge_status: "active",
    created_at: "2026-10-10T09:00:00Z", updated_at: "2026-10-10T09:00:00Z",
  };
  const key = "idem-writenote";

  const w1 = await s.writeNote("概念/幂等.md", { data: note, body: "A 版\n", idempotencyKey: key, create: true });
  is("writeNote 首次 committed", w1.state, "committed");
  is("writeNote 首次 replayed=false", w1.replayed, false);

  const w2 = await s.writeNote("概念/幂等.md", { data: note, body: "A 版\n", idempotencyKey: key, create: true });
  is("writeNote 同键同体 → 重放", w2.replayed, true);
  is("writeNote 同键同体重放返回同一事务 id", w2.id, w1.id);
  is("writeNote 同键同体重放不重写",
    readFileSync(join(root, "概念/幂等.md"), "utf8").includes("A 版"), true);

  await expectCode("writeNote 同键异体 → 冲突（不是静默重放）",
    s.writeNote("概念/幂等.md", { data: note, body: "B 版（换了内容）\n", idempotencyKey: key, create: true }),
    "IDEMPOTENCY_CONFLICT");
  is("冲突后盘上仍是旧内容",
    readFileSync(join(root, "概念/幂等.md"), "utf8").includes("A 版"), true);

  // 指纹只由请求体决定：isCreate 从 true 翻成 false（文件已存在）时，合法重放不得误判为冲突。
  // 若指纹里掺了 isCreate/kind，这一条会红 —— 这是防「修反了」的钉子。
  // 注意 update 必须先满足 expectedBeforeHash 的形状校验（在幂等检查之前），所以要给 hash。
  // 这里**必须 catch**：若指纹修反了会抛冲突，抛出去会崩掉整个脚本，
  // 而变异运行器把「崩溃」判为「没抓到」——那就白测了。所以转成干净的 ✗。
  const w5 = await s.writeNote("概念/翻转.md", { data: note, body: "同一份\n", idempotencyKey: "idem-flip", create: true });
  let w6 = null, w6err = null;
  try {
    w6 = await s.writeNote("概念/翻转.md", {
      data: note, body: "同一份\n", idempotencyKey: "idem-flip", create: null,
      expectedHash: await s.hashOf("概念/翻转.md"),
    });
  } catch (e) { w6err = e.code ?? e.message; }
  is(`isCreate 自动翻转时同键同体仍算重放（指纹不掺磁盘现状）${w6err ? `（却抛了 ${w6err}）` : ""}`,
    w6err === null && w6?.replayed === true, true);
  is("且复用同一事务 id", w6?.id, w5.id);

  // 不带幂等键时指纹保持 null，行为与从前一致（不因这次修复而变）
  const w7 = await s.writeNote("概念/无键.md", { data: note, body: "无键\n", create: true });
  is("不带幂等键仍能正常写入", w7.state, "committed");

  const js2 = await s.listTransactions();
  is("writeNote 幂等键只对应一个事务", js2.filter((j) => j.idempotency_key === key).length, 1);

  await rm(base, { recursive: true, force: true });
}

// --------------------------------------------------------------------------- //
console.log("\n[10] 水位：不变式在写盘前强制");

{
  const { base, root } = await makeRoot();
  const s = await svc(root);
  const id = { sessionId: "session-1", branchId: "main", sourceRevision: "rev-1" };

  const c = await s.setWatermarks(id, {
    observed_through_seq: 45, durable_through_seq: 42, processed_through_seq: 42,
    durability_evidence: { kind: "persisted_read", revision: "rev-1" },
    source_gate: { state: "ready", requested_through_seq: 42 },
  });
  is("合法水位写入", c.processed_through_seq, 42);
  is("读回一致", (await s.getCursor("session-1", "main")).observed_through_seq, 45);

  await expectCode("processed > durable 被拒",
    s.setWatermarks(id, { processed_through_seq: 43 }), "WATERMARK_INVARIANT_VIOLATION");
  await expectCode("durable > observed 被拒",
    s.setWatermarks(id, { observed_through_seq: 41 }), "WATERMARK_INVARIANT_VIOLATION");
  await expectCode("ready 但 requested > durable 被拒",
    s.setWatermarks(id, { source_gate: { state: "ready", requested_through_seq: 99 } }), "WATERMARK_INVARIANT_VIOLATION");

  const after = await s.getCursor("session-1", "main");
  is("被拒的写入没有污染已存水位", after.observed_through_seq, 45);
  is("被拒的写入没有污染 gate", after.source_gate.requested_through_seq, 42);

  // 跨分支不共用 seq 身份
  await s.setWatermarks({ sessionId: "session-1", branchId: "feature-x", sourceRevision: "rev-1" }, {
    observed_through_seq: 3, durable_through_seq: 3, processed_through_seq: 0,
    source_gate: { state: "checking", requested_through_seq: null },
  });
  is("两个分支各自独立", Object.keys((await s.readCursors()).cursors).length, 2);

  await rm(base, { recursive: true, force: true });
}

// --------------------------------------------------------------------------- //
console.log("\n[11] 辅助 JSON 不得存知识/会话正文");

{
  const { base, root } = await makeRoot();
  const s = await svc(root);
  await expectCode("cursor 带正文被拒",
    s.setWatermarks({ sessionId: "s", branchId: "main", sourceRevision: "r" }, {
      observed_through_seq: 1, durable_through_seq: 1, processed_through_seq: 1, content: "完整聊天正文",
    }),
    "AUX_STATE_FORBIDDEN_KEY");
  await expectCode("cursor 带 prompt 被拒",
    s.setWatermarks({ sessionId: "s", branchId: "main", sourceRevision: "r" }, {
      observed_through_seq: 1, durable_through_seq: 1, processed_through_seq: 1, source_gate: { state: "unknown" }, prompt: "整段 prompt",
    }),
    "AUX_STATE_FORBIDDEN_KEY");

  // 没有产生任何 cursors.json（被拒 = 不落盘）
  existsSync(join(root, ".state/cursors.json")) ? bad("被拒的载荷不应落盘") : ok("被拒的载荷未落盘");

  await rm(base, { recursive: true, force: true });
}

// --------------------------------------------------------------------------- //
console.log("\n[12] 事务状态机与失败不静默");

{
  const { base, root } = await makeRoot();
  const s = await svc(root);
  await expectCode("非法 purpose",
    s.beginTransaction({ purpose: "whatever", targets: [{ path: "概念/x.md", kind: "create", content: "x" }] }),
    "INVALID_VALUE");
  await expectCode("空 targets",
    s.beginTransaction({ purpose: "update_note", targets: [] }), "INVALID_VALUE");
  await expectCode("同一事务内重复路径",
    s.beginTransaction({ purpose: "update_note", targets: [
      { path: "概念/x.md", kind: "create", content: "a" },
      { path: "概念/x.md", kind: "create", content: "b" },
    ] }),
    "INVALID_VALUE");
  await expectCode("非法 target.kind",
    s.beginTransaction({ purpose: "update_note", targets: [{ path: "概念/x.md", kind: "delete", content: "a" }] }),
    "INVALID_STRUCTURE");
  await expectCode("未知事务 id",
    s.applyTransaction("../../etc/passwd"), "INVALID_VALUE");

  // committed 是终态：再 apply 不会重复写
  const r = await s.commit({ purpose: "update_note", targets: [{ path: "概念/t.md", kind: "create", content: "终态\n" }] });
  const again = await s.applyTransaction(r.id);
  is("已 committed 再 apply 返回 committed", again.state, "committed");
  is("文件内容未被二次写入", readFileSync(join(root, "概念/t.md"), "utf8"), "终态\n");

  await rm(base, { recursive: true, force: true });
}

// --------------------------------------------------------------------------- //
console.log("\n[13] writeNote：正式 Markdown 走同一文件服务，无绕过口");

{
  const { base, root } = await makeRoot();
  const s = await svc(root);
  const data = {
    schema_version: "1.1", object_type: "index", id: "idx_1", revision: 1, title: "书籍阅读索引",
    tags: ["index", "reading"], scope: "reading", knowledge_status: "active",
    created_at: "2026-10-10T09:00:00Z", updated_at: "2026-10-10T09:00:00Z",
  };
  const r = await s.writeNote("索引.md", { data, body: "# 书籍阅读索引\n", create: false, expectedHash: await s.hashOf("索引.md") });
  is("writeNote 走事务", r.state, "committed");
  const back = await s.readNote("索引.md");
  is("回读 object_type", back.data.object_type, "index");
  is("回读正文", back.body, "# 书籍阅读索引\n");
  is("回读 hash 与文件一致", back.hash, await s.hashOf("索引.md"));
  is("bytes hash 是 64 位", /^[0-9a-f]{64}$/.test(back.hash), true);

  const missing = await s.readNote("书籍/没有/这个.md");
  is("读不存在的文件 → exists=false", missing.exists, false);
  missing.errors.some((e) => e.code === "SOURCE_UNAVAILABLE") ? ok("读不到时明确报 SOURCE_UNAVAILABLE（不伪装 no_change）") : bad("读不到时应报 SOURCE_UNAVAILABLE");

  await rm(base, { recursive: true, force: true });
}

// --------------------------------------------------------------------------- //
console.log("\n[14] no_change 耐久回执（PRD §8.7：含 check 及来源范围）");

{
  const { base, root } = await makeRoot();
  const s = await svc(root);

  const r = await s.recordNoChange({ receipt: { check_id: "dc_1", source_range: "session se_1 seq 1-9" }, idempotencyKey: "nc-1", inputFingerprint: "fp-1" });
  is("零目标回执事务 committed", r.state, "committed");
  is("没有产生任何步骤", r.steps.length, 0);

  const j = JSON.parse(readFileSync(join(root, ".state/journal", `${r.id}.json`), "utf8"));
  is("journal 就是回执", j.receipt.check_id, "dc_1");
  is("回执含来源范围", j.receipt.source_range, "session se_1 seq 1-9");
  is("回执 outcome", j.receipt.outcome, "no_change");
  is("零目标不留 staging 空目录", existsSync(join(root, ".state/staging", r.id)), false);

  // 幂等：同键重放不重复记录
  const again = await s.recordNoChange({ receipt: { check_id: "dc_1", source_range: "session se_1 seq 1-9" }, idempotencyKey: "nc-1", inputFingerprint: "fp-1" });
  is("同键重放", again.replayed, true);
  is("同键只有一个 journal", (await s.listTransactions()).filter((x) => x.idempotency_key === "nc-1").length, 1);
  // 可被查到 → 才能防重提同范围
  is("回执可按幂等键查回", (await s.findByIdempotencyKey("nc-1")).receipt.source_range, "session se_1 seq 1-9");

  // 回执不能空手：缺 check / 来源范围都必须拒绝
  await expectCode("回执缺 check_id 被拒",
    s.recordNoChange({ receipt: { check_id: "", source_range: "r" } }), "MISSING_REQUIRED");
  await expectCode("回执缺 source_range 被拒",
    s.recordNoChange({ receipt: { check_id: "dc_1", source_range: null } }), "MISSING_REQUIRED");

  // 零目标只对回执型 purpose 开放
  await expectCode("非回执 purpose 零目标被拒",
    s.commit({ purpose: "update_note", targets: [] }), "INVALID_VALUE");
  await expectCode("带 target 的事务不许带 receipt",
    s.commit({ purpose: "update_note", receipt: { check_id: "dc_1", source_range: "r" }, targets: [{ path: "概念/带回执.md", kind: "create", content: "x" }] }),
    "INVALID_VALUE");

  // 回执里的正文类字段必须被拦住（且不能被静默丢弃）
  await expectCode("回执夹带正文被拒",
    s.recordNoChange({ receipt: { check_id: "dc_1", source_range: "r", content: "整段聊天正文" } }), "AUX_STATE_FORBIDDEN_KEY");
  await expectCode("回执夹带任意额外字段被拒",
    s.recordNoChange({ receipt: { check_id: "dc_1", source_range: "r", note: "x" } }), "AUX_STATE_FORBIDDEN_KEY");
  await expectCode("回执 outcome 只能 no_change",
    s.recordNoChange({ receipt: { check_id: "dc_1", source_range: "r", outcome: "proposal" } }), "INVALID_VALUE");
  existsSync(join(root, ".state/journal")) && (await s.listTransactions()).every((x) => x.idempotency_key !== null)
    ? ok("被拒的回执没有留下 journal")
    : bad("被拒的回执不应落盘");

  // 崩溃在 prepared 的零目标事务：无目标变更可证 → aborted，不伪造"已处理"
  const begun = await s.beginTransaction({ purpose: "record_no_change", receipt: { check_id: "dc_2", source_range: "seq 10-20" } });
  is("零目标 begin 为 prepared", begun.state, "prepared");
  const rec = await s.recoverAll();
  is("prepared 的零目标回执 → aborted（未确认就不算处理过）", rec[0].state, "aborted");

  // 零目标事务在 applying 中崩溃 → 可续做
  const begun2 = await s.beginTransaction({ purpose: "record_no_change", receipt: { check_id: "dc_3", source_range: "seq 21-30" } });
  const jj = JSON.parse(readFileSync(join(root, ".state/journal", `${begun2.id}.json`), "utf8"));
  jj.state = "applying";
  writeFileSync(join(root, ".state/journal", `${begun2.id}.json`), JSON.stringify(jj, null, 2));
  const rec2 = await s.recoverAll();
  is("applying 的零目标回执 → committed", rec2[0].state, "committed");

  await rm(base, { recursive: true, force: true });
}

// --------------------------------------------------------------------------- //
console.log("\n[15] 状态机边集必须与 PRD §11.5 完全一致（不多不少）");

{
  // PRD §11.5 逐字抄录。这是契约，不是我的实现——两边不一致就是 bug。
  const PRD_11_5 = {
    prepared: ["applying", "aborted"],
    applying: ["committed", "recovering"],
    recovering: ["applying", "conflict", "aborted"],
    conflict: ["recovering", "aborted"],
    committed: [],
    aborted: [],
  };
  const sameSet = (a, b) => a.length === b.length && [...a].sort().join() === [...b].sort().join();
  const states = Object.keys(PRD_11_5);
  const gotStates = Object.keys(ALLOWED_TRANSITIONS).sort();
  const wantStates = [...states].sort();
  gotStates.join() === wantStates.join()
    ? ok("状态集合一致")
    : bad("状态集合不一致", `${gotStates.join()} vs ${wantStates.join()}`);
  const mismatch = [];
  for (const s of states) {
    const got = ALLOWED_TRANSITIONS[s] ?? null;
    if (!got || !sameSet(got, PRD_11_5[s])) mismatch.push(`${s}: 代码 ${JSON.stringify(got)} vs PRD ${JSON.stringify(PRD_11_5[s])}`);
  }
  mismatch.length === 0
    ? ok("每条边都与 PRD §11.5 一致（等集，不是超集）")
    : bad("边集与 PRD §11.5 不一致", mismatch.join("；"));

  // 显式点出这两条曾经的超集边——回归时能一眼看懂
  !ALLOWED_TRANSITIONS.prepared.includes("recovering")
    ? ok("prepared 不直接到 recovering（PRD 只允许 applying/aborted）")
    : bad("prepared→recovering 是 PRD 未允许的边");
  !ALLOWED_TRANSITIONS.recovering.includes("committed")
    ? ok("recovering 不直接到 committed（必须先回 applying）")
    : bad("recovering→committed 是 PRD 未允许的边");
  ALLOWED_TRANSITIONS.committed.length === 0 && ALLOWED_TRANSITIONS.aborted.length === 0
    ? ok("committed/aborted 是终结态（无出边）")
    : bad("终结态不应有出边");

  // 真状态机驱动：终结态不得被复活
  const { base: b2, root: r2 } = await makeRoot();
  const s3 = await svc(r2);
  const committed = await s3.commit({ purpose: "update_note", targets: [{ path: "概念/e.md", kind: "create", content: "x" }] });
  await expectCode("committed → aborted 被拒（终结态）", s3.rollbackTransaction(committed.id), "INVALID_TRANSITION");

  const ab = await s3.beginTransaction({ purpose: "save_proposal", targets: [{ path: "待确认/e2.md", kind: "create", content: "y" }] });
  await s3.rollbackTransaction(ab.id);
  const re = await s3.applyTransaction(ab.id);
  is("aborted 再 apply 仍是 aborted（不复活）", re.state, "aborted");
  existsSync(join(r2, "待确认/e2.md")) ? bad("aborted 不应产生文件") : ok("aborted 未产生文件");

  await rm(b2, { recursive: true, force: true });
}

// --------------------------------------------------------------------------- //
console.log("\n[重放诚实性] 日志说 committed ≠ 盘上真有产物（不许假成功）");

{
  // 背景：beginTransaction 命中幂等键、且记录是 committed 时会直接返回 replayed:true。
  // 若不核对盘上产物，产物被**绕过本服务**删掉/改掉时就会「报告成功但什么都没有」。
  // 实测过的原始 bug：旁路 rm 之后同键同体重放 ⇒ {state:"committed", replayed:true}，而文件不存在。
  const { base, root } = await makeRoot();
  const s = await svc(root);
  const rel = "推荐反馈/rr_drift.md";
  const data = { object_type: "recommendation_run", id: "rr_drift", state: "ready", revision: 1 };
  const key = "recommendation_run:rr_drift:rev1";
  const W = (create) => s.writeNote(rel, { data, body: "", idempotencyKey: key, purpose: "update_note", create });

  const t1 = await W(true);
  is("第一次写：committed", t1.state, "committed");

  // ① 盘上没动 ⇒ 正常重放，不许误报
  const t2 = await W(true);
  is("盘上没动 ⇒ 仍是 committed", t2.state, "committed");
  is("盘上没动 ⇒ replayed=true（正常重放没被误判）", t2.replayed, true);

  // ② 旁路删除 ⇒ 必须如实报，不许返回 replayed:true
  await rm(join(root, rel));
  await expectCode("旁路删除后重放（不许假成功）", W(true), "RECOVERY_REQUIRED");

  // ③ 旁路改内容 ⇒ 同样必须报
  await s.writeNote(rel, { data, body: "", idempotencyKey: null, purpose: "update_note", create: true });
  await writeFile(join(root, rel), "被旁路改过的内容\n");
  await expectCode("旁路改内容后重放（不许假成功）", W(true), "RECOVERY_REQUIRED");

  // ④ 报错后**不许**自动重写：盘上被改过的内容必须原样留着
  is("报错后没有自动重写盘上那份", readFileSync(join(root, rel), "utf8"), "被旁路改过的内容\n");

  // ⑤ 零目标事务（record_no_change 回执）没有产物，不该被这条检查误伤
  const receipt = { check_id: "dc_drift_probe", source_range: "session se_probe seq 0-0" };
  const r = await s.recordNoChange({ receipt, idempotencyKey: "nochange:drift-probe", inputFingerprint: "fp-drift-probe" });
  is("零目标 record_no_change 正常提交", r.state, "committed");
  const r2 = await s.recordNoChange({ receipt, idempotencyKey: "nochange:drift-probe", inputFingerprint: "fp-drift-probe" });
  is("零目标事务重放不受影响（没有产物可比对）", r2.replayed, true);

  await rm(base, { recursive: true, force: true });
}

console.log(`\n===== 通过 ${pass} · 失败 ${fail} =====`);
process.exit(fail ? 1 : 0);
