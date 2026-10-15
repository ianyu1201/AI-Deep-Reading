# EPUB 与 Markdown 阅读器

`src/` 提供 EPUB 阅读、Markdown 编辑、来源映射及状态管理。`vendor/foliate-js/` 是固定提交的本地适配快照；来源与许可见 [THIRD_PARTY.md](THIRD_PARTY.md)。

在仓库根目录执行 `npm run build`，本包输出到 `dist/`，并同步工作台共享主题、动效和图标。默认 catalog 为空；开发者自行导入有权使用的 EPUB。`node scripts/make-security-fixtures.mjs` 可生成原创隔离测试 EPUB。

先构建后运行 `npm test`；完整应用入口见[仓库 README](../../README.md)。
