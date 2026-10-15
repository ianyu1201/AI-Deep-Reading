/**
 * tests/reading-crash-child.mjs · 崩溃注入子进程（file-service 测试用）
 *
 * 为什么必须**真的杀进程**：M0 的教训是"替身不忠实 → 离线全绿、运行期失效"。
 * 模拟"崩溃"最容易被写成"try/catch 里手动把状态改成 recovering"——那测的是我自己的代码，
 * 不是文件系统的真实行为。所以这里在**真实的协议步骤上**调用 `process.kill(pid, 'SIGKILL')`：
 * 没有 finally、没有 flush、没有机会回滚，跟断电/强杀完全一致。
 *
 * 用法（由 tests/reading-file-service.test.mjs 拉起）：
 *   node tests/reading-crash-child.mjs <root> <mode> <txidOutFile>
 *
 * mode:
 *   begin-only          只做 beginTransaction（journal 已耐久、目标未动），然后正常退出
 *   kill-after-step0    beginTransaction + applyTransaction，在**第 1 步 rename 完成并耐久记录后** SIGKILL
 *   kill-mid-multi      多目标事务，第 1 步完成后 SIGKILL（用于测"手改第二个目标 → conflict"）
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// 与父进程一致：变异测试会把改坏的副本路径放进 READING_FILE_SERVICE
const HERE = dirname(fileURLToPath(import.meta.url));
const FS_PATH = process.env.READING_FILE_SERVICE ?? join(HERE, "..", "lib", "reading", "file-service.js");
const { createFileService } = await import(pathToFileURL(FS_PATH).href);

const [root, mode, txidOut] = process.argv.slice(2);

const service = await createFileService({
  root,
  onStep: async (evt) => {
    // 第 1 步 rename 已 fsync 且该步已耐久记入 journal 之后，立刻自杀。
    if (evt.phase === "step-done" && evt.index === 0) {
      writeFileSync(txidOut, evt.txId);
      process.kill(process.pid, "SIGKILL");
    }
  },
});

if (mode === "begin-only") {
  const r = await service.beginTransaction({
    purpose: "save_proposal",
    targets: [
      { path: "待确认/崩溃提案甲.md", kind: "create", content: "# 甲\n" },
      { path: "待确认/崩溃提案乙.md", kind: "create", content: "# 乙\n" },
    ],
  });
  writeFileSync(txidOut, r.id);
  process.exit(0);
}

if (mode === "kill-after-step0" || mode === "kill-mid-multi") {
  const r = await service.beginTransaction({
    purpose: "save_proposal",
    targets: [
      { path: "待确认/崩溃提案甲.md", kind: "create", content: "# 甲\n" },
      { path: "待确认/崩溃提案乙.md", kind: "create", content: "# 乙\n" },
    ],
  });
  writeFileSync(txidOut, r.id);
  await service.applyTransaction(r.id);
  // 正常情况下应该到这里就 committed；若没被 kill，说明钩子没生效
  process.exit(3);
}

console.error(`未知 mode: ${mode}`);
process.exit(2);
