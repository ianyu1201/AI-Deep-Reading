/**
 * lib/reading/book-domain.js · **书域配置的唯一来源**（M10 收口 A）
 *
 * 为什么有这个文件（`.private/执行计划-收口边界.md` §2 / §3）：
 *   `schema.js` / `file-service.js` 是**通用机制**（校验器、原子写），
 *   但它们曾经各自焊了书域知识 —— 写死的绝对路径、写死的 15 个对象类型、
 *   写死的「index 必须 tags 含 index」。后果：这套代码离开本机就跑不了测试，
 *   换第二个域（第二个租户）就得把同一份配置抄第二遍。
 *
 * 本文件是这些书域配置的**唯一来源**；机制层通过**参数注入**拿到它（机制层不反向 import 本文件）：
 *   · `file-service.js` —— 不再有默认根：`root` 必填（缺失抛 `FILE_SERVICE_ROOT_REQUIRED`）；
 *   · `schema.js`       —— `validateNote(data, {mode, objectType, domain})` 由调用方注入域配置；
 *   · `runtime.js`      —— 仍是**唯一注入点**（M6）：读写两条路拿同一个常量，不会各自漂移。
 *
 * 边界纪律（由 `tests/reading-domain-boundary.test.mjs` 守证）：
 *   机制层源码（**去注释后**）不得再出现书域标记（绝对路径 / 45-书籍 / 宿主专有标识 /
 *   apple / epub）与 15 个对象类型字面量。
 */

import { homedir } from "node:os";
import { join } from "node:path";

/** 插件的可移植默认目录；桌面客户端仍显式注入其私有的 45-书籍 目录。 */
export const DEFAULT_KNOWLEDGE_ROOT = join(homedir(), "Documents", "AI-knowledge", "45-书籍");

/** 规范 §2：object_type 的闭合集合（15 个正式对象）。原样搬自 `schema.js`（逐字未改）。 */
export const OBJECT_TYPES = Object.freeze([
  "index",
  "book",
  "book_summary",
  "chapter_summary",
  "claim",
  "insight",
  "concept",
  "understanding_observation",
  "question",
  "recommendation_feedback",
  "change_proposal",
  "maintenance_proposal",
  "reading_background",
  "reading_evidence",
  "recommendation_run",
]);

/**
 * 语义对象：有"命题作者"，因此需要 origin/confirmation/book_evidence/session_evidence/
 * external_master/dedup_check_ref（PRD §8.5 共用字段 + 规范 §2 末段）。
 * 结构性（index/book）与流程性（两个提案）不为凑字段伪造命题作者。
 * 原样搬自 `schema.js`（逐字未改）。
 */
export const SEMANTIC_OBJECT_TYPES = Object.freeze([
  "book_summary",
  "chapter_summary",
  "claim",
  "insight",
  "concept",
  "understanding_observation",
  "question",
  "recommendation_feedback",
  "recommendation_run",
  "reading_background",
  "reading_evidence",
]);

/**
 * 书域**交叉字段规则**（规范 §2）。
 *
 * `schema.js` 不认识任何具体域：它只按 `domain.rules[object_type]` **通用地**执行
 * `requiredTags` / `idEquals` 两类规则。原来这两条是写死在通用校验器里的
 * （`if (ot === "index") {...}`、`if (ot === "book") {...}`），本步把它们搬到这里。
 *
 * 规则形状（保持最小、可扩展）：
 *   · `requiredTags: string[]`      —— `data.tags` 必须包含这些标签
 *   · `requiredTagsMessage: string` —— 命中时的**逐字**错误信息（与收口前完全一致）
 *   · `idEquals: string`            —— `data.id` 必须等于 `data[<该字段名>]`
 *   · `idEqualsMessage: string`     —— 命中时的**逐字**错误信息（与收口前完全一致）
 */
export const DOMAIN_RULES = Object.freeze({
  // 索引：tags 必含 index（规范 §2 / §4）
  index: Object.freeze({
    requiredTags: Object.freeze(["index"]),
    requiredTagsMessage: "45-书籍/索引.md 的 tags 必含 index",
  }),
  // 书身份一致性：id 必须等于 book_id（规范 §2）
  book: Object.freeze({
    idEquals: "book_id",
    idEqualsMessage: "规范 §2：book 的 id 必须等于 book_id",
  }),
});

/**
 * 注入给机制层的**域配置对象**（唯一入口）。
 *
 * `validateNote(data, {mode, objectType, domain: BOOK_DOMAIN})`。
 * `runtime.js` / `compiler.js` / `policy.js` 都从这里取，不再各自内证书域知识。
 */
export const BOOK_DOMAIN = Object.freeze({
  objectTypes: OBJECT_TYPES,
  semanticObjectTypes: SEMANTIC_OBJECT_TYPES,
  rules: DOMAIN_RULES,
});
