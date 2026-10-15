# 独立 EPUB 书库

主进程通过 `BookLibrary({root, pythonPath})` 导入、复制、受控解包 EPUB，验证 OPF/spine 并建立正文身份、书源映射与封面缓存。库根由客户端注入独立数据目录。

`scanAppleBooks()` 是显式只读扫描；`AppleBooksConnection` 处理选择、批量复制、去重和逐项失败，不改 Apple 原书、不自动同步。受保护书籍不会绕过 DRM。

导入限制为 ZIP 256 MiB、解包 512 MiB、单文件 64 MiB、20000 项；拒绝路径越界、符号链接、重复路径和受保护正文。语义检索另需准备 Python 依赖和本地模型；缺失时明确报错。

测试使用临时合成 EPUB：`python3 -m unittest discover -s packages/book-library -p test_library.py -v`，以及根目录 `npm test`。能力和验证边界见[仓库 README](../../README.md)。
