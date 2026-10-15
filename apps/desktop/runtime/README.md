# 受管运行时

`RuntimeManager` 用显式 Node 路径启动独立 carrier。carrier 通过锁定的 Harness SDK 建立私有运行时，注册会话和阅读业务桥接；`CodexAdapter` 把模型推理交给固定版本 Codex CLI。Harness 保留权威会话、工具执行和压缩记录，Codex 推理线程为临时线程。

业务入口通过动作、书籍 scope、来源和会话身份校验。内部回环 HTTP 使用随机 token，拒绝浏览器 Origin；渲染层只接收受控 IPC 与公开 DTO。退出等待保存／停止／清理，只回收本实例拥有的进程组。

客户端为 Harness、书库、知识文件和 Codex 登录注入独立目录，不复制宿主凭据。`AI_READING_DISABLE_AI=1` 或 `AI_READING_USE_HOST_MODEL=0` 显式关闭模型连接；无模型仍可阅读、编辑和管理本地内容。

`*.test.mjs` 覆盖会话 scope、业务竞态、原子写、笔记／标注／书签、检索授权与 Codex 传输边界。`session-boundary.test.mjs` 另外启动真实无模型 SDK，验证创建、恢复与重启。运行前请在仓库根目录安装依赖并构建，然后使用根目录 `npm test`，由测试入口统一禁用模型。

客户端入口与数据位置见[仓库 README](../../../README.md)。
