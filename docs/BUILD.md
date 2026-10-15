# 开发与本机构建

先在仓库根目录执行 `npm run setup` 和 `npm run build`。Node 开发版本固定为 22.22.3；Python 的基础书库操作使用标准库。

## 可选：本地语义检索

普通 EPUB 阅读与笔记不需要模型权重。语义索引需要独立的 Python 3.12 环境、`scripts/semantic-requirements.lock` 中的依赖，以及公开的 `BAAI/bge-small-zh-v1.5` ONNX 模型 snapshot。模型和用户索引都不随仓库发布。

这里描述源码构建准备。已发布的 macOS 安装包携带 Python 与语义模型，以及 Node、Electron、Codex 运行时；安装包使用者无需自行安装这些开发依赖。用户索引仍由应用在自己的数据目录生成。

在自己的 Python 3.12 虚拟环境中按锁安装依赖后，执行：

```sh
python3 scripts/prepare-semantic.py --python /absolute/path/to/semantic-env/bin/python --model-snapshot /absolute/path/to/bge-small-zh-v1.5/snapshot
```

脚本把运行时准备到 `.build/semantic-python/`，校验主要依赖版本与模型文件。模型完整性和 Python 可重定位性仍应在自己的构建环境验证。缺模型会明确返回不可用，不自动冒充语义搜索。

## 本机 `.app`

```sh
python3 scripts/package-local.py --node /absolute/path/to/node-distribution/bin/node
node apps/desktop/packaging/smoke.mjs
python3 scripts/audit-local-package.py
```

构建输入还包括：已安装的 Electron 44.7.0、Harness 0.2.0-rc.2 生产依赖、Codex CLI 0.144.6 原生程序，以及 macOS 的 `codesign`、`otool` 和 `install_name_tool`。Node 完整发行目录必须包含 `LICENSE`；`--node` 指向其中的可执行文件。

准备了语义运行时则随包使用它；否则脚本要求当前 Python 来自 python.org 的 macOS Framework 发行版。仅安装系统 Python 或随意指定虚拟环境不能保证打包成功。

输出为 `dist/AI 深度阅读.app`。脚本会重新创建这个构建目录中的 `.app`；不修改应用的用户数据。脚本保留 Electron、Node、Python、Codex、Harness 及阅读器的许可文件，使用 ad-hoc 本机签名。运行成品不依赖全局 Node、Python 或另开 Harness 桌面应用。

`v0.1.0-preview.2` 的目标是 `0.1.0` build `3`、Apple Silicon、macOS 15+。不把项目的 macOS 13 目标当作当前包的已通过结果：

```sh
python3 scripts/package-local.py --slim --minimum-macos 15.0 --build-number 3 --output "dist/release-v0.1.0-preview.2/AI 深度阅读.app"
python3 scripts/audit-release.py --app "dist/release-v0.1.0-preview.2/AI 深度阅读.app" --output dist/release-v0.1.0-preview.2/release-audit.json
node apps/desktop/packaging/release-smoke.mjs "dist/release-v0.1.0-preview.2/AI 深度阅读.app" dist/release-v0.1.0-preview.2/release-smoke.json
```

发布构建额外排除测试会话、Python 缓存及非目标平台的 `@img/sharp-wasm32` 可选回退包，保留并实际检查 macOS 原生 sharp。Python 构建路径被脱敏，`libpython` 的本机 install ID 被改为相对运行时名称。审计检查包内路径、认证／会话／书籍残留、模型 SHA、主要许可、所有 Mach-O 最低系统及签名。

第一轮瘦身由显式 `--slim` 开关启用；不带此开关仍可构建完整负载作对照。瘦身在最终签名前调用 `scripts/prune-package.py`，同级生成 `pruning-report.json` 记录实际省略路径、文件数与字节数。规则只省略未启用的 LibreOffice 平台 `bin/`／`program/`、sherpa 平台原生 `.node`／`.dylib`、约定的通用文档预览客户端 bundle、node-pty 非 `darwin-arm64` 预编译与 Windows ConPTY 资源，以及受保护目录之外的 `node_modules` 源映射 `.map`。保留 SDK 小型 JavaScript 包装与 Host 入口、包元数据、许可与来源文件；Python、模型、Codex、Node、Electron 不在本轮裁剪范围。精确路径与结果以生成的清单为准。

对已有候选只查看裁剪范围而不改文件，可执行：

```sh
python3 -B scripts/prune-package.py --app "dist/release-v0.1.0-preview.2/AI 深度阅读.app" --dry-run --output dist/release-v0.1.0-preview.2/prune-plan.json
```

直接裁剪已签名应用会使签名失效，因此正式打包通过构建流程在签名前完成裁剪，随后重新审计并验证阅读／笔记／会话、语义模型、原生 sharp 和 node-pty。源映射省略会降低依赖代码的调试定位能力。本文的构建步骤不是本轮测试通过的证明，最终状态见 [preview.2 发布记录](RELEASE-2026-10-15-preview.2.md)。

可选真实 AI 验收使用 `apps/desktop/packaging/ai-release-smoke.mjs`，只在用户明确授权后设置 `AI_READING_AI_SMOKE=1`，并显式指定已有应用登录的绝对 `AI_READING_CODEX_HOME`、候选 `.app` 和证据输出路径。它使用合成 EPUB 和临时业务数据，通过官方 CLI 正常读取已有登录并允许 CLI 更新自身运行状态；不复制、解析或输出凭据。默认源码测试不会触发该模型调用。实际导读内容质量不由这个短回复检查证明。

第三方许可补充和来源清单位于 `apps/desktop/packaging/licenses/third-party/`；保留的 libvips／sharp 原生库对应源码及构建材料另随 Release 提供。`preview.2` 原样重用并附上 `AI-Deep-Reading-0.1.0-third-party-sources.tar.gz`，SHA-256 为 `4eb951ef3fe49a378335067fb8552e742d978f9bcb72c694a16d2db1c0c62a58`。旧附件是本轮保留组件的来源超集，也含本轮已省略原生负载的办公／语音归档；保留声明不表示相应二进制仍在包中。公开前必须保持这些声明与来源资产齐全，并核对候选没有引入新依赖或不同版本。

尚未完成 Developer ID、公证、Gatekeeper 下载实机场景、Intel、macOS 13／15 真机和自动更新。本说明不把本机可运行视为所有系统兼容性通过。

## 复用插件客户端源码

桌面客户端直接使用已包含的阅读业务与客户端文件。若修改旧插件客户端 JSX，在 `dsh-apple-read/` 中用兼容锁文件的 pnpm 安装开发依赖并执行 `pnpm run build`；其 React 和 Harness 依赖由宿主提供。它不是当前 mac 客户端的独立启动入口。
