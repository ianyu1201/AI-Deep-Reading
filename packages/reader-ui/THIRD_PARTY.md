# 第三方代码与本地适配

- foliate-js：MIT，提交 `78914aef4466eb960965702401634c2cb348e9b1`；`vendor/foliate-js/LICENSE`。
- foliate 内带 zip.js 2.8.22、fflate 0.8.2、pdfjs-dist 5.5.207 构建文件；随带许可证在 `vendor/licenses/`。只使用 EPUB 路径，PDF 不是产品能力。
- CodeMirror 6 各模块：MIT；精确版本在本包 package.json 与 package-lock.json。
- markdown-it 15.0.2：MIT；JSZip 3.10.2：MIT / GPL-3.0 双许可，按 MIT 使用。
- Lucide 1.55.0：ISC；图标上游归属以依赖 LICENSE 为准。
- esbuild 0.28.2：MIT，仅构建工具。

构建保留 esbuild 生成的 `*.LEGAL.txt`，复制供应代码许可证，并按实际 bundle 输入汇总 npm 包的 LICENSE/NOTICE 到 `dist/licenses/npm/`，精确版本与许可信息记录于 `dist/licenses/npm-packages.json`。应用发布时应整体保留。

本公开源码快照不包含样书和封面，`fixtures/books-assets/catalog.json` 为空。`scripts/make-security-fixtures.mjs` 可生成原创合成 EPUB，仅用于本机验证；生成的 EPUB 和清单不提交到仓库。

REA、Ghidra、EPUB.js、Obsidian 和 Apple Books 二进制/专有资源均未纳入。

本地动效适配（2026-10-12）：paginator 的原有 animate 保留；普通翻页时长读取宿主 `--motion-page`，减少动态或页面隐藏时直接完成当前位置。未改分页算法；章节跳转和 CFI 重排不启用 animated。

本地跨章节适配（2026-10-12，后续轮次）：`paginator.js` 在横排 LTR 的双页分页模式内，用独立相邻 View 填补上一 section 末尾的空右页，并按半个 spread 接续下一次翻页。保留两份独立文档、原 section 索引、CFI 和 overlayer；没有将原文拼成新 DOM。显式左右页／中心页约束及原文 CSS 分页继续保留。竖排、RTL、固定版式和单页仍走既有路径。相邻内容使用原资源加载器，最终随同一本 book.destroy 释放；未引入 Readest 或 Apple Books 代码。
# 本地依赖治理补记（2026-10-13）

Foliate 快照的 `package.json`／`package-lock.json` 移除了没有随快照迁入 lint 配置或调用入口的 `@eslint/js` 与 `globals` 开发依赖。其余锁定版本、许可证、导出和上游构建声明保留；该次依赖清理未修改 Foliate JavaScript 源码。本仓库保留当前快照及上述本地阅读适配，不包含原工作区的私人路径溯源表和历史验收报告。
