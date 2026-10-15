# 第三方来源与许可

第一方代码沿用仓库根目录的 MIT 许可；MIT 不替代下列组件各自的许可和归属。依赖安装与构建应保留其上游 LICENSE / NOTICE。

| 组件 | 来源／固定版本 | 许可与位置 |
| --- | --- | --- |
| 阅读业务与 Python 引擎 | [DSH-apple-Read](https://github.com/ianyu1201/DSH-apple-Read)，2026 ianyu1201 | MIT，根目录 `LICENSE` |
| Foliate JS | [johnfactotum/foliate-js](https://github.com/johnfactotum/foliate-js)，提交 `78914aef4466eb960965702401634c2cb348e9b1` | MIT，`packages/reader-ui/vendor/foliate-js/LICENSE` |
| zip.js / fflate / PDF.js 构建文件 | 2.8.22 / 0.8.2 / 5.5.207 | 原始许可在 `packages/reader-ui/vendor/licenses/` |
| Lucide 图标 | npm `lucide` 1.55.0 | ISC，`apps/desktop/shell/icons/LICENSE`，构建时保留 npm LICENSE |
| CodeMirror、markdown-it、JSZip 等 | `packages/reader-ui/package-lock.json` | 详见依赖 LICENSE 与 `packages/reader-ui/THIRD_PARTY.md`；JSZip 按 MIT 选项使用 |
| DeepSeek Harness 及 SDK | `@deepseek-ai/dsh`、`dsh-sdk-client`、`dsh-host-webserver`、`dsh-session-turn-outline` 0.2.0-rc.2 | npm 依赖，四个直接包均附 MIT LICENSE；完整传递图以应用锁文件为准 |
| Electron | 44.7.0 | 依赖安装时取得 Electron / Chromium LICENSE 与 notices |
| Codex CLI | [openai/codex](https://github.com/openai/codex)，`rust-v0.144.6` | Apache-2.0，已保留 `apps/desktop/packaging/licenses/codex/LICENSE` 和 `NOTICE`；二进制不入库 |
| Node、Python、语义模型及 Python 依赖 | 构建者自行准备 | 不在源码仓库内；再分发时分别保留许可并核对完整原生依赖／模型声明 |

## macOS 预览包的补充材料

安装包第一方代码为 MIT，**整个安装包并非单一 MIT 许可**。随包第三方组件按各自许可分发，包括：

- `@img/sharp-libvips-darwin-arm64` 1.3.4：LGPL-3.0-or-later 及其各项上游依赖许可。提供精确原生库来源、构建脚本、补丁、依赖源码和 librsvg Cargo 锁文件对应的 crate 源码。
- `sherpa-onnx` 1.13.8：其 macOS 原生组件中包含 eSpeak NG 静态代码；eSpeak NG 使用 GPLv3。对应 sherpa／eSpeak 源码、构建材料及独立 ONNX Runtime 声明随 Release 提供。
- Python standalone、29 项 Python 依赖和本地嵌入模型：补充声明位于 `apps/desktop/packaging/licenses/third-party/`。完整 Electron／Chromium、Node 和 Python 声明保留在应用资源中。

精确版本、上游地址、原始许可及 SHA-256 见该目录中的来源清单。对应源码资产为同一 Release 的 `AI-Deep-Reading-0.1.0-third-party-sources.tar.gz`，保留构建材料与修改／替换组件所需信息。第一方 MIT 声明不替代或收窄第三方许可证授予的权利。

macOS 原生发布包排除了非目标平台的 `@img/sharp-wasm32` 可选回退组件，原生 sharp 保留并另做实际加载检查。

Foliate 的本地改动包含 EPUB 内容脚本隔离与翻页／跨章节呈现适配，说明与 patch 在 `packages/reader-ui/THIRD_PARTY.md` 和 `patches/`。未纳入 Apple Books、Obsidian 或其他专有应用的二进制和资源。

源码仓库不包含 Project Gutenberg 样书、个人 EPUB、封面或模型。测试可由脚本生成原创合成 EPUB，不需要取得真实书籍。
