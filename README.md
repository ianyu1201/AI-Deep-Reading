# AI 深度阅读 · AI Deep Reading

独立的 macOS 阅读工作台，把 EPUB 原文、Markdown 笔记与 AI 伴读放在同一个窗口。

本仓库是当前 mac 客户端的源码快照，基于 [DSH-apple-Read](https://github.com/ianyu1201/DSH-apple-Read) 演进。客户端内部管理 DeepSeek Harness，由 Codex CLI 提供模型推理。无需运行 DeepSeek Harness 桌面应用。

**当前为预览版本。** 可从 [GitHub Releases](https://github.com/ianyu1201/AI-Deep-Reading/releases/tag/v0.1.0-preview.2) 下载 Apple Silicon 安装包。此次预览包为 `0.1.0`（build 3），要求 **macOS 15+**，使用 ad-hoc 签名、尚未公证。开发 package 版本为 `0.1.0-dev.1`。源码快照和验证范围见 [记录](docs/OPEN_SOURCE.md)。

## 下载与安装

1. 从上述 Release 下载 `AI-Deep-Reading-0.1.0-preview.2-macOS-arm64.dmg`，对照 `SHA256SUMS.txt` 核验文件。
2. 打开 DMG，将「AI 深度阅读」拖入 Applications，然后从「应用程序」启动。
3. 首次启动为空书库。导入自己有权使用的 EPUB；AI 功能通过应用设置中的独立 ChatGPT 登录启用。

本轮安装包约 681 MB，比 preview.1 减少约 120 MB（15%）；安装后逻辑占用约 1.26 GB。仅裁剪未启用的办公、语音、通用预览负载和跨平台／调试资源，保留全部核心运行时与本地语义模型。第三方源码附件不需要安装。

安装包包含 Node、Python、Harness、Codex CLI 及本地检索模型，无需另外安装开发环境。该预览版未公证，首次打开可能受到 macOS 限制；需要时遵循 [Apple 官方打开流程](https://support.apple.com/102445)。Intel 不适用；本轮未在 macOS 15 实机或另一台电脑验证。项目的 macOS 13 目标保留，当前依赖的兼容性偏差是待修复项。

## 功能

- 独立书库：导入 EPUB；显式连接 Apple Books，选择书籍后复制到本应用书库。
- EPUB 阅读：普通模式连续滚动，沉浸模式分页；保留阅读位置、目录、书签与标注。
- 三栏工作台：左侧书库／工作台，中间原文或笔记，右侧 AI 对话、本书笔记、导读和标注。
- Markdown 笔记：阅读与编辑、多文件、大纲、链接、草稿、显式保存、导出和冲突处理。
- 按书管理会话，支持流式回答、停止及历史恢复。Harness 管理持久化和业务工具，Codex 执行模型请求。
- 导读采用分块、章节与跨章节综合，保留来源和处理范围。语义检索使用另行准备的本地模型。

这些是源码实现范围；当前公开快照的检查范围见验证记录。自动化中的合成导读不能证明真实模型的导读质量。

## 本地启动

开发环境：**macOS 13+、Node.js 22.22.3、npm、Python 3.11+**。本次验证使用 Apple Silicon；Intel 和另一台电脑尚未验证。

```sh
git clone https://github.com/ianyu1201/AI-Deep-Reading.git
cd AI-Deep-Reading
npm run setup
npm run build
npm start
```

首次启动为空书库，请导入自己有权使用的 EPUB。阅读和笔记可在模型不可用时继续使用。`npm run setup` 按两个子项目的锁文件安装依赖，不安装 Codex CLI、Python 环境或语义模型。

AI 功能需要单独安装 **Codex CLI 0.144.6**。如未安装，可执行 `npm install -g @openai/codex@0.144.6`。版本由当前适配代码固定校验；升级需同步验证协议。打开客户端后从设置登录 ChatGPT，使用应用自己的认证目录。已有 Codex 桌面应用或终端登录不会自动迁移认证。

可用 `AI_READING_CODEX=/absolute/path/to/codex npm start` 指定已有官方 CLI；解析器也能定位官方 npm launcher 的原生程序。缺失或版本不匹配时，模型会显示不可用状态。

```sh
# 使用临时独立数据目录并关闭 AI，不发起模型请求
AI_READING_DATA_DIR="$(mktemp -d)/reading" AI_READING_DISABLE_AI=1 npm start
```

## 开发与验证

```sh
npm run build          # 构建 EPUB / Markdown 阅读器和共享资源
npm test               # 自包含逻辑、真实无模型运行时和 Python 测试
npm run test:desktop   # 原生 Electron：空书库、合成 EPUB、阅读、工具与重启持久化
```

默认测试关闭 AI，使用合成／临时数据。真实书籍、真实模型质量、付费调用和历史私有验收脚本不在这组测试中。

本地 `.app` 构建与可选语义运行时准备见 [构建说明](docs/BUILD.md)。Release 附第三方声明、对应源码材料和校验值。Developer ID、公证与自动更新尚未完成；本轮验证与裁剪范围见 [preview.2 发布记录](docs/RELEASE-2026-10-15-preview.2.md)；首次发布与敏感信息检查见 [历史记录](docs/RELEASE-2026-10-15.md)。

## 代码位置

| 目录 | 内容 |
| --- | --- |
| `apps/desktop/electron/` | mac 主进程、窗口、WebContentsView 与 IPC |
| `apps/desktop/shell/` | 工作台与会话界面 |
| `apps/desktop/runtime/` | 受管 Harness、Codex 适配与阅读业务桥接 |
| `packages/reader-ui/` | EPUB 阅读器、Markdown 编辑器与 Foliate 快照 |
| `packages/book-library/` | 独立书库、导入、Apple Books 只读扫描与来源映射 |
| `packages/guide-generation/` | 分块与多阶段导读生成 |
| `packages/ui-theme/` | 共享主题、外观与动效 |
| `dsh-apple-read/` | 复用的阅读业务、知识文件合同和插件源代码 |
| `books_rag.py` | 文本提取、身份、索引与检索引擎 |
| `scripts/` | 测试、语义运行时准备和本机打包 |

## 数据与隐私

开发版默认数据在 `~/Library/Application Support/AI 深度阅读 Development/`，本机打包版使用 `~/Library/Application Support/AI 深度阅读/`。两者分别管理书库、知识文件、会话和 Codex 认证。可通过 `AI_READING_DATA_DIR` 覆盖应用数据目录。

书籍导入与索引在本地处理。**启用 AI 对话或导读时，会把相关问题、会话上下文、笔记或所处理范围的书籍原文发送给模型服务。** 全书导读可能分块处理大量原文。请按自己的使用权限和服务条款选择材料。

Apple Books 连接按用户选择复制书籍；不改原书、不绕过 DRM、不承诺双向同步。本仓库不包含个人书籍、封面、聊天、笔记、索引、模型权重或凭据。

## 许可与来源

第一方代码沿用 [MIT License](LICENSE)。第三方代码遵循各自许可；归属、固定版本和本地修改见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

问题和贡献请见 [CONTRIBUTING.md](CONTRIBUTING.md)。
