# 开发与本机构建

先在仓库根目录执行 `npm run setup` 和 `npm run build`。Node 开发版本固定为 22.22.3；Python 的基础书库操作使用标准库。

## 可选：本地语义检索

普通 EPUB 阅读与笔记不需要模型权重。语义索引需要独立的 Python 3.12 环境、`scripts/semantic-requirements.lock` 中的依赖，以及公开的 `BAAI/bge-small-zh-v1.5` ONNX 模型 snapshot。模型和用户索引都不随仓库发布。

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

Release 预览包按实际原生依赖声明为 macOS 15+，不把项目的 macOS 13 目标当作当前包的已通过结果：

```sh
python3 scripts/package-local.py --minimum-macos 15.0 --build-number 2 --output "dist/release-v0.1.0/AI 深度阅读.app"
python3 scripts/audit-release.py --app "dist/release-v0.1.0/AI 深度阅读.app" --output dist/release-v0.1.0/release-audit.json
node apps/desktop/packaging/release-smoke.mjs "dist/release-v0.1.0/AI 深度阅读.app"
```

发布构建额外排除测试会话、Python 缓存及非目标平台的 `@img/sharp-wasm32` 可选回退包，保留并实际检查 macOS 原生 sharp。Python 构建路径被脱敏，`libpython` 的本机 install ID 被改为相对运行时名称。审计检查包内路径、认证／会话／书籍残留、模型 SHA、主要许可、所有 Mach-O 最低系统及签名。

第三方许可补充和来源清单位于 `apps/desktop/packaging/licenses/third-party/`；libvips 原生库的对应源码／构建材料另随 Release 提供。公开前必须保持这些声明及来源资产齐全。

尚未完成 Developer ID、公证、Gatekeeper 下载实机场景、Intel、macOS 13／15 真机和自动更新。本说明不把本机可运行视为所有系统兼容性通过。

## 复用插件客户端源码

桌面客户端直接使用已包含的阅读业务与客户端文件。若修改旧插件客户端 JSX，在 `dsh-apple-read/` 中用兼容锁文件的 pnpm 安装开发依赖并执行 `pnpm run build`；其 React 和 Harness 依赖由宿主提供。它不是当前 mac 客户端的独立启动入口。
