# D4 派生 DOM 映射接口

`window.aiReadingSource` 仅在 EPUB 顶层页面存在，不暴露文件系统权限。

- `current()` 返回打开书籍的业务 `book_id/book_version_id` 和当前 EPUB 包内 href（含 OPF 目录）。
- `locate(mapping)`：mapping 使用 `BookLibrary.getSourceMapping(spanId)` 原样结果。核验当前书籍身份、span 的 verified/ok、单 segment 包含、href、Unicode codepoint 边界、quote、SHA-256，以及整 segment 文本与真实 DOM 归一化文本严格相同。然后一次 foliate renderer.goTo(index, anchor) 跳转并用 CSS Highlight API 临时着色。返回 `{ok, verified, span_id, cfi}` 或 `{ok:false,verified:false,message}`。
- `selection(mapping)`：同一章节映射，取当前 DOM Selection；返回 chapter/文件/区间/quote/hash 候选，`verified:false,verificationRequired:true`。主进程必须按 `sp_<book_id>_<section_order>_<start>_<end>` 调用现有 source-span 并复核 quote/hash 后，才可附加到会话或写入来源。不自动发送。
- `clear()`：取消迟到定位并清除临时高亮。切书上下文事件自动清理。

业务书库 catalog 条目必须保留 `bookId` 和 `bookVersionId`；EPUB ZIP 指纹不是业务身份。CFI 仅用于阅读位置，不能作为已核验来源。

DOM 文本算法对齐 books_rag.py 的 html_to_text：script/style 去除、同组 block 分行、空白与空行压缩，按 Unicode codepoint 记录 DOM UTF-16 边界。解析器修复异常 XHTML、注释异常或引擎/DOM 文本差异会明确失败，不模糊搜索或选第一个同句。跨 href 引用明确拒绝，需要引擎拆分引用；不会把某一文件当作全章。

测试：4 个 Node 坐标/校验测试；独立 Chromium 的真实 DOM Range 与反向选文测试见 reports/source-mapping-dom.json。引擎到应用的完整业务集成、真实 EPUB 临时高亮视觉尚由主任务验证，本模块测试不冒充整条路径完成。

## 用户选文入口

正式书库模式下，只有单一 EPUB document 的非空选文才显示「向 AI 提问」。按钮调用受控 source-chapter 映射，再产生候选发往 reading:selection；请求过程中选文或书籍发生变化则取消。按钮不会发送模型请求；主进程负责核验候选、附加到当前会话，并将沉浸模式恢复伴读。

BookLibrary.getSourceChapter(entryId, packageHref) 以注册书籍 ID 与含 OPF 目录的包路径唯一匹配章节，复核 bookVersionId，不按书名或首次重复文字猜测。未注册书籍、不唯一 href、内容版本变化均拒绝。
