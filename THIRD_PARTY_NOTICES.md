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

安装包第一方代码为 MIT，**整个安装包并非单一 MIT 许可**。实际携带的第三方组件按各自许可分发。源码依赖清单、归档声明与某个 Release 的实际二进制内容应分别核对。

- `@img/sharp-libvips-darwin-arm64` 1.3.4：LGPL-3.0-or-later 及其各项上游依赖许可。提供精确原生库来源、构建脚本、补丁、依赖源码和 librsvg Cargo 锁文件对应的 crate 源码。
- `sherpa-onnx` 1.13.8：`preview.1` 携带的 macOS 原生组件包含 GPLv3 eSpeak NG 静态代码；其精确源码、构建材料及独立 ONNX Runtime 声明已归档。`preview.2` 的裁剪规则省略语音平台 `.node`／`.dylib`，保留 SDK 的 JavaScript 入口、包元数据及许可材料；不得由归档中的 eSpeak 声明推断新包仍携带该二进制。实际结果以本轮发布清单和审计为准。
- Python standalone、29 项 Python 依赖和本地嵌入模型：补充声明位于 `apps/desktop/packaging/licenses/third-party/`。完整 Electron／Chromium、Node 和 Python 声明保留在应用资源中。

精确版本、上游地址、原始许可及 SHA-256 见该目录中的来源清单。对应源码资产为 `AI-Deep-Reading-0.1.0-third-party-sources.tar.gz`；`preview.2` 复用并原样附上 `preview.1` 的同一资产，其 SHA-256 为 `4eb951ef3fe49a378335067fb8552e742d978f9bcb72c694a16d2db1c0c62a58`。它提供保留的原生 libvips／sharp 对应来源，也保留已经省略的 sherpa／eSpeak 等来源超集。无需运行应用即可取得这些材料。第一方 MIT 声明不替代或收窄第三方许可证授予的权利。

`preview.2` 保留原有许可目录及来源归档，不为缩包删除 LICENSE、NOTICE、版权声明或 LibreOffice 的 `licenses/`／`sources/`。办公平台的 `bin/`／`program/` 与语音平台原生负载被省略，归档中的旧组件说明不代表这些负载仍随新安装包发布。该包没有新增或升级第三方依赖；这一判断须随候选构建的版本及清单核对，不能用于未来版本自动放行。

macOS 原生发布包排除了非目标平台的 `@img/sharp-wasm32` 可选回退组件，原生 sharp 保留并另做实际加载检查。

Foliate 的本地改动包含 EPUB 内容脚本隔离与翻页／跨章节呈现适配，说明与 patch 在 `packages/reader-ui/THIRD_PARTY.md` 和 `patches/`。未纳入 Apple Books、Obsidian 或其他专有应用的二进制和资源。

源码仓库不包含 Project Gutenberg 样书、个人 EPUB、封面或模型。测试可由脚本生成原创合成 EPUB，不需要取得真实书籍。
