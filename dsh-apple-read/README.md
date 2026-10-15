# 复用的阅读业务与插件源码

当前 macOS 客户端入口见[仓库 README](../README.md)。本目录保留来自 [DSH-apple-Read](https://github.com/ianyu1201/DSH-apple-Read) 的阅读业务、知识文件合同与插件 JSX／构建文件。

`lib/reading/` 是桌面复用的业务实现；独立 mac 客户端由 `apps/desktop/` 启动。插件 JSX 的开发构建见[构建说明](../docs/BUILD.md)。

公开默认测试只保留自包含部分；原来读取本机知识库、外层文档、真实书籍、凭据与模型的验收脚本没有迁入。第一方许可为根目录 MIT。
