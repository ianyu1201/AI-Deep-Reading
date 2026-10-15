/**
 * lib/reading/schema.js · M1 持久化地基（第 1 件）
 *
 * 职责（执行计划-v0.6 §1 第 1 行）：**frontmatter 读写 + 必填/值域校验**，对齐
 * 《书籍知识库索引与模板规范》§2/§3 与 PRD v0.6 §8.5。
 *
 * 三条硬约束来自 PRD，本文件是它们的可执行形式：
 *   1. 正式知识以 Markdown + YAML frontmatter 为唯一事实源 → 解析/序列化必须无损、可往返；
 *   2. `origin`/`confirmation`/`external_master` 等值域是闭合集合，不认识的组合必须报错，
 *      不能"宽松放过"——放过一次就是让 AI 推演冒充用户事实（PRD §8.5）；
 *   3. 水位不变式 `processed ≤ durable ≤ observed`（PRD §11.5）。
 *
 * ## 为什么自己写 YAML 子集解析器
 * 插件只声明了 peerDependency（cordis / dsh-skill，均为 optional），没有 yaml 依赖；
 * 宿主 node_modules 里的传递依赖随时可能变。所以这里实现一个**显式受限**的 YAML 子集：
 * 支持模板与真实 vault 用到的全部形状，遇到不支持的构造**明确报错**而不是猜。
 * 「解析成功」≠「业务校验成功」——两者是分开的两步（模板使用说明 §v0.6 使用约束）。
 *
 * 支持的 YAML 子集：
 *   - 映射（block mapping）、序列（block sequence）、序列内联映射（`- key: v`）
 *   - 流式 `[]` / `[a, b]` / `{}` / `{a: b, c: [1, 2]}`（可嵌套）
 *   - 标量：null/~/空、true/false、整数/浮点、单引号、双引号、裸字符串
 *   - 注释（整行 `#`、以及空白后的行内 `#`）
 * 明确拒绝：block scalar（`|`/`>`）、锚点/别名（`&`/`*`）、标签（`!`）、
 *   文档标记（`---`/`...`）、指令（`%`）、Tab 缩进、重复键。
 *
 * 运行期不读网络、不读宿主服务；纯函数，便于离线复刻真实语义做测试。
 */
import { createHash } from "node:crypto";

export const SCHEMA_VERSION = "1.1";

// M10 收口 A：`OBJECT_TYPES` / `SEMANTIC_OBJECT_TYPES` 已移到域层
// `lib/reading/book-domain.js`（书域配置的唯一来源）。本模块是**通用校验器**，
// 对象类型集合一律从注入的 `domain` 取，不再内证任何具体域。

/** 规范 §3：内容字段与值域。这里是唯一一份可执行的闭合词表。 */
export const VALUE_DOMAINS = Object.freeze({
  origin: ["user", "book_author", "ai_inference"],
  confirmation: ["confirmed", "unconfirmed", "retracted"],
  knowledge_status: ["active", "disputed", "superseded", "withdrawn"],
  external_master_status: ["unverified", "verified", "linked"],
  external_master_outcome: [
    "not_checked",
    "not_authorized",
    "matched",
    "no_match",
    "partial",
    "read_error",
    "stale",
  ],
  quote_type: ["verbatim", "paraphrase"],
  locator_quality: ["exact_normalized_text", "approximate", "unmapped"],
  source_availability: ["available", "partial", "unavailable", "unauthorized", "unchecked"],
  source_asset_kind: ["vault_attachment", "original_epub", "source_page"],
  export_policy: ["reference_only", "include_if_authorized"],
  reading_evidence_kind: [
    "self_report",
    "observed_performance",
    "explicit_preference",
    "ai_hypothesis",
  ],
  dimension: ["familiarity", "explanation", "application", "retention"],
  strength: ["low", "medium", "high"],
  confidence_level: ["unknown", "low", "medium", "high"],
  change_kind: ["supplemented", "corrected", "uncertain", "unchanged"],
  feedback_type: [
    "known",
    "interested",
    "not_interested",
    "disagree",
    "defer",
    "irrelevant",
    "correction",
  ],
  relation_type: [
    "references",
    "supports",
    "challenges",
    "conditions",
    "applies_to",
    "derived_from",
  ],
  maintenance_action_type: [
    "register_maintenance",
    "place_attachment",
    "cross_area_integration",
  ],
  index_generation_mode: ["manual_seed", "managed"],
  // PRD §11.5 生命周期（唯一权威；这里只取本文件需要交叉校验的部分）
  change_proposal_state: [
    "draft",
    "pending_review",
    "applying",
    "accepted",
    "rejected",
    "cancelled",
    "superseded",
    "conflict",
  ],
  maintenance_proposal_state: ["pending", "acknowledged", "cancelled"],
  recommendation_run_state: ["ready", "stale"],
  result_outcome: ["items", "insufficient_evidence"],
  personalization_status: ["none", "limited", "available"],
  operation_type: ["create", "update", "link"],
  application_mode: ["manual", "authorized_auto"],
  dedup_local_result: ["matched", "no_match", "partial", "read_error"],
  locator_kind: ["event_seq", "turn_id"],
  source_ref_kind: ["book_span", "host_turn", "knowledge_note", "user_action"],
  // PRD §11.5：SourceGate.state 的允许状态与初始值 unknown
  source_gate_state: [
    "unknown",
    "checking",
    "ready",
    "pending_durable",
    "partial",
    "unavailable",
    "unsupported",
  ],
});

/** 本文件抛出的统一错误类型（错误码对齐 PRD §11.1）。 */
export class SchemaError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = "SchemaError";
    this.code = code;
    this.detail = detail ?? null;
  }
}

// --------------------------------------------------------------------------- //
// 基础判定
// --------------------------------------------------------------------------- //
const isMap = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isArr = (v) => Array.isArray(v);
const isStr = (v) => typeof v === "string";
const isNonEmptyStr = (v) => typeof v === "string" && v.trim() !== "";
const isInt = (v) => Number.isInteger(v);
const isBool = (v) => typeof v === "boolean";
const isHash64 = (v) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
const isIsoTime = (v) =>
  typeof v === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(v);

/**
 * 文件原 bytes 的 SHA-256（PRD §8.5：所有 hash 用文件原 bytes，规范化文本 hash 仅书内定位）。
 *
 * M13 删掉了这里的 `sha1Hex`：它当时唯一用途是**在 JS 侧复现引擎的路径句柄**
 * （`path_hash8 = sha1(书路径)[:8]`）—— 一份跨语言的重复实现，两边一旦不一致就会静默错位。
 * 书身份现在由**引擎**按内容算（`book_version_id` / `content_id`），插件只消费、不再自己算哈希。
 */
export function sha256Hex(input) {
  return createHash("sha256").update(input).digest("hex");
}

/** 规范化文本 hash 的语义与 bytes hash 不同，函数名分开以免混用。 */
export function normalizedTextHash(text) {
  return sha256Hex(Buffer.from(text, "utf8"));
}

// --------------------------------------------------------------------------- //
// YAML 子集：解析
// --------------------------------------------------------------------------- //
const UNSUPPORTED_LEAD = ["&", "*", "!", "%", "@", "`", "|", ">"];

function stripInlineComment(s) {
  // 只有在引号外、且 `#` 前是空白（或行首）时才是注释（YAML 规范）。
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === "\\" && quote === '"') { i++; continue; }
      if (ch === quote) {
        if (quote === "'" && s[i + 1] === "'") { i++; continue; }
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === "#" && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i);
  }
  return s;
}

function parseScalar(raw, ctx) {
  const s = stripInlineComment(raw).trim();
  if (s === "" || s === "~" || s === "null" || s === "Null" || s === "NULL") return null;
  if (s === "true" || s === "True" || s === "TRUE") return true;
  if (s === "false" || s === "False" || s === "FALSE") return false;
  if (/^[-+]?\d+$/.test(s)) return Number(s);
  if (/^[-+]?(\d+\.\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return Number(s);
  if (s[0] === "'") {
    if (s.length < 2 || s[s.length - 1] !== "'") {
      throw new SchemaError("UNSUPPORTED_YAML", `第 ${ctx.lineNo} 行单引号字符串未闭合`);
    }
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (s[0] === '"') {
    if (s.length < 2 || s[s.length - 1] !== '"') {
      throw new SchemaError("UNSUPPORTED_YAML", `第 ${ctx.lineNo} 行双引号字符串未闭合`);
    }
    const body = s.slice(1, -1);
    let out = "";
    for (let i = 0; i < body.length; i++) {
      if (body[i] !== "\\") { out += body[i]; continue; }
      const n = body[++i];
      const map = { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\", "/": "/", "0": "\0" };
      if (n in map) out += map[n];
      else if (n === "u") { out += String.fromCharCode(parseInt(body.slice(i + 1, i + 5), 16)); i += 4; }
      else throw new SchemaError("UNSUPPORTED_YAML", `第 ${ctx.lineNo} 行不支持的转义 \\${n}`);
    }
    return out;
  }
  if (UNSUPPORTED_LEAD.includes(s[0])) {
    throw new SchemaError(
      "UNSUPPORTED_YAML",
      `第 ${ctx.lineNo} 行不支持的 YAML 构造（以 ${s[0]} 开头）：本子集不支持 block scalar/锚点/别名/标签`,
    );
  }
  return s;
}

function parseFlow(str, pos, ctx) {
  const skipWs = () => { while (pos < str.length && /\s/.test(str[pos])) pos++; };
  skipWs();
  if (str[pos] === "[") {
    pos++;
    const arr = [];
    skipWs();
    if (str[pos] === "]") return { value: arr, pos: pos + 1 };
    for (;;) {
      const r = parseFlow(str, pos, ctx);
      arr.push(r.value);
      pos = r.pos;
      skipWs();
      if (str[pos] === ",") { pos++; continue; }
      if (str[pos] === "]") return { value: arr, pos: pos + 1 };
      throw new SchemaError("UNSUPPORTED_YAML", `第 ${ctx.lineNo} 行流式序列缺少 , 或 ]`);
    }
  }
  if (str[pos] === "{") {
    pos++;
    const obj = {};
    skipWs();
    if (str[pos] === "}") return { value: obj, pos: pos + 1 };
    for (;;) {
      skipWs();
      const keyStart = pos;
      while (pos < str.length && str[pos] !== ":" && str[pos] !== "}" && str[pos] !== ",") pos++;
      const key = str.slice(keyStart, pos).trim();
      if (str[pos] !== ":") throw new SchemaError("UNSUPPORTED_YAML", `第 ${ctx.lineNo} 行流式映射缺少 :`);
      pos++;
      const r = parseFlow(str, pos, ctx);
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        throw new SchemaError("DUPLICATE_KEY", `第 ${ctx.lineNo} 行流式映射重复键 ${key}`);
      }
      obj[key] = r.value;
      pos = r.pos;
      skipWs();
      if (str[pos] === ",") { pos++; continue; }
      if (str[pos] === "}") return { value: obj, pos: pos + 1 };
      throw new SchemaError("UNSUPPORTED_YAML", `第 ${ctx.lineNo} 行流式映射缺少 , 或 }`);
    }
  }
  // 标量：读到 , ] } 之一
  const start = pos;
  let quote = null;
  while (pos < str.length) {
    const ch = str[pos];
    if (quote) {
      if (ch === "\\" && quote === '"') { pos += 2; continue; }
      if (ch === quote) quote = null;
      pos++;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; pos++; continue; }
    if (ch === "," || ch === "]" || ch === "}") break;
    pos++;
  }
  return { value: parseScalar(str.slice(start, pos), ctx), pos };
}

function parseInlineValue(raw, ctx) {
  const s = stripInlineComment(raw).trim();
  if (s.startsWith("[") || s.startsWith("{")) {
    const r = parseFlow(s, 0, ctx);
    if (r.pos !== s.length) {
      throw new SchemaError("UNSUPPORTED_YAML", `第 ${ctx.lineNo} 行流式值后有多余内容`);
    }
    return r.value;
  }
  return parseScalar(s, ctx);
}

const isSeqLine = (content) => content === "-" || /^-\s/.test(content);

function splitKey(content, ctx) {
  let quote = null;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (quote) {
      if (ch === "\\" && quote === '"') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === ":" && (i + 1 === content.length || /\s/.test(content[i + 1]))) {
      let key = content.slice(0, i).trim();
      if (key[0] === "'" || key[0] === '"') key = parseScalar(key, ctx);
      if (typeof key !== "string" || key === "") {
        throw new SchemaError("UNSUPPORTED_YAML", `第 ${ctx.lineNo} 行键为空`);
      }
      return { key, rest: content.slice(i + 1) };
    }
  }
  return null;
}

function tokenize(text) {
  const out = [];
  const rawLines = String(text).replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (/^\s*$/.test(line)) continue;
    if (/^\s*#/.test(line)) continue;
    const m = /^([ \t]*)(.*)$/.exec(line);
    const indentRaw = m[1];
    if (indentRaw.includes("\t")) {
      throw new SchemaError("UNSUPPORTED_YAML", `第 ${i + 1} 行缩进含 Tab；本子集只接受空格缩进`);
    }
    const content = m[2].replace(/\s+$/, "");
    if (content === "---" || content === "...") {
      throw new SchemaError("UNSUPPORTED_YAML", `第 ${i + 1} 行不允许多文档标记 ${content}`);
    }
    out.push({ indent: indentRaw.length, content, lineNo: i + 1 });
  }
  return out;
}

/** 从错误消息里取「第 N 行」；取不到就是 null（未知 ≠ 0）。 */
function lineOf(message) {
  const m = /第\s*(\d+)\s*行/.exec(String(message ?? ""));
  return m ? Number(m[1]) : null;
}

/**
 * 解析 YAML 子集。返回 `{ value, errors }`；不抛异常（除内部编程错误）。
 * 有错误时 `value` 为已解析到一半的部分，调用方**不得**把有错误的解析结果当权威。
 */
export function parseYamlSubset(text) {
  const errors = [];
  let lines;
  try {
    lines = tokenize(text);
  } catch (e) {
    return { value: null, errors: [{ code: e.code || "UNSUPPORTED_YAML", message: e.message, line: lineOf(e.message) }] };
  }
  if (lines.length === 0) return { value: null, errors: [] };

  const state = { i: 0 };

  function parseBlock(indent) {
    const first = lines[state.i];
    if (!first || first.indent < indent) return null;
    if (first.indent > indent) {
      throw new SchemaError("UNSUPPORTED_YAML", `第 ${first.lineNo} 行缩进意外增加`);
    }
    return isSeqLine(first.content) ? parseSequence(indent) : parseMapping(indent);
  }

  function parseMapping(indent) {
    const obj = {};
    while (state.i < lines.length) {
      const line = lines[state.i];
      if (line.indent < indent) break;
      if (line.indent > indent) {
        throw new SchemaError("UNSUPPORTED_YAML", `第 ${line.lineNo} 行缩进意外增加`);
      }
      if (isSeqLine(line.content)) {
        throw new SchemaError("UNSUPPORTED_YAML", `第 ${line.lineNo} 行在映射中混入序列项`);
      }
      const kv = splitKey(line.content, line);
      if (!kv) throw new SchemaError("UNSUPPORTED_YAML", `第 ${line.lineNo} 行不是 key: value`);
      if (Object.prototype.hasOwnProperty.call(obj, kv.key)) {
        throw new SchemaError("DUPLICATE_KEY", `第 ${line.lineNo} 行重复键 ${kv.key}`);
      }
      state.i++;
      if (kv.rest.trim() === "" && !stripInlineComment(kv.rest).trim()) {
        const next = lines[state.i];
        if (next && next.indent > indent) {
          obj[kv.key] = parseBlock(next.indent);
        } else if (next && next.indent === indent && isSeqLine(next.content)) {
          // YAML 允许块序列与其父键同缩进（15 份模板的 `tags:` 就是这个形状）。
          obj[kv.key] = parseSequence(indent);
        } else {
          obj[kv.key] = null;
        }
      } else {
        obj[kv.key] = parseInlineValue(kv.rest, line);
      }
    }
    return obj;
  }

  function parseSequence(indent) {
    const arr = [];
    while (state.i < lines.length) {
      const line = lines[state.i];
      if (line.indent !== indent || !isSeqLine(line.content)) break;
      const m = /^-(\s*)([\s\S]*)$/.exec(line.content);
      const gap = m[1].length;
      const rest = m[2].replace(/\s+$/, "");
      state.i++;
      if (rest === "") {
        const next = lines[state.i];
        if (next && next.indent > indent) arr.push(parseBlock(next.indent));
        else arr.push(null);
        continue;
      }
      const innerIndent = indent + 1 + gap;
      if (splitKey(rest, line)) {
        // `- key: value`：把 rest 当成 innerIndent 处的一行，继续吃更深的续行。
        const virtualIndex = state.i - 1;
        const saved = lines[virtualIndex];
        lines[virtualIndex] = { indent: innerIndent, content: rest, lineNo: line.lineNo };
        state.i = virtualIndex;
        arr.push(parseMapping(innerIndent));
        lines[virtualIndex] = saved;
        continue;
      }
      arr.push(parseInlineValue(rest, line));
      const next = lines[state.i];
      if (next && next.indent > indent) {
        throw new SchemaError("UNSUPPORTED_YAML", `第 ${next.lineNo} 行缩进意外增加`);
      }
    }
    return arr;
  }

  let value;
  try {
    value = parseBlock(lines[0].indent);
  } catch (e) {
    if (e instanceof SchemaError) {
      return { value: null, errors: [{ code: e.code, message: e.message, line: lineOf(e.message) }] };
    }
    throw e;
  }
  if (state.i < lines.length) {
    errors.push({
      code: "UNSUPPORTED_YAML",
      message: `第 ${lines[state.i].lineNo} 行未能归入任何块（缩进 ${lines[state.i].indent}）`,
      line: lines[state.i].lineNo,
    });
  }
  return { value, errors };
}

// --------------------------------------------------------------------------- //
// YAML 子集：序列化（稳定、可往返、人读友好）
// --------------------------------------------------------------------------- //
const NEEDS_QUOTE_RE = /^(?:[-+]?(?:\d+|\d*\.\d+)(?:[eE][-+]?\d+)?|0[xXoObB][0-9a-fA-F]+|true|false|null|yes|no|on|off|~)$/i;

/**
 * 必须走双引号转义的字符：换行 / 回车 / 制表 / 其它控制字符。
 *
 * 为什么不能只靠 `needsQuote` 里的「含 `:`/`#`」判据：真实事故（推荐反馈/rr_cd53db…）
 * 就是一段**含换行、又不含 `:`/`#`、首尾也无空白**的正文被裸着写出去，续行顶格（列 0），
 * 整个 frontmatter 变成解析不了的 YAML —— 写出器产出了自己读不回来的文件。
 */
const NEEDS_ESCAPE_RE = /[\u0000-\u001f\u007f]/;

function needsQuote(s) {
  if (s === "") return true;
  if (/^\s|\s$/.test(s)) return true;
  if (NEEDS_QUOTE_RE.test(s)) return true;
  if (s.includes(":") || s.includes("#")) return true;
  if ("-?:,[]{}&*!|>'\"%@`".includes(s[0])) return true;
  // 含换行/回车/制表等控制字符：裸标量会顶格续行 ⇒ frontmatter 非法。
  // 必须落进 quoteScalar 的双引号分支（解析器已支持 \n \t \r \0 \uXXXX）。
  if (NEEDS_ESCAPE_RE.test(s)) return true;
  return false;
}

/** 双引号标量：控制字符一律转义，保证「写出去的文件」里没有裸 CR/LF。 */
function doubleQuoteScalar(s) {
  let out = '"';
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return out + '"';
}

function quoteScalar(s) {
  // 含控制字符时单引号承载不了（本子集不解析 block scalar）：改用双引号 + 转义，
  // 这样「序列化 → 解析」能逐字还原，而不是把多行原文裸铺出去。
  if (NEEDS_ESCAPE_RE.test(s)) return doubleQuoteScalar(s);
  return "'" + s.replace(/'/g, "''") + "'";
}

function scalarText(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new SchemaError("UNSUPPORTED_YAML", `不支持的数字 ${v}`);
    return String(v);
  }
  if (typeof v === "string") return needsQuote(v) ? quoteScalar(v) : v;
  throw new SchemaError("UNSUPPORTED_YAML", `不支持的标量类型 ${typeof v}`);
}

function isFlowable(v) {
  if (isArr(v)) return v.length === 0;
  if (isMap(v)) return Object.keys(v).length === 0;
  return true;
}

function flowText(v) {
  if (isArr(v)) return "[]";
  if (isMap(v)) return "{}";
  return scalarText(v);
}

/** 序列化 YAML 子集；对象键顺序保持插入顺序（往返与 diff 都依赖它）。 */
export function serializeYamlSubset(value, indent = 0) {
  const pad = " ".repeat(indent);
  if (!isMap(value)) {
    if (isArr(value)) {
      if (value.length === 0) return `${pad}[]\n`;
      let out = "";
      for (const item of value) {
        if (isMap(item) && Object.keys(item).length > 0) {
          out += `${pad}-\n${serializeYamlSubset(item, indent + 2)}`;
        } else if (isArr(item) && item.length > 0) {
          out += `${pad}-\n${serializeYamlSubset(item, indent + 2)}`;
        } else {
          out += `${pad}- ${flowText(item)}\n`;
        }
      }
      return out;
    }
    return `${pad}${scalarText(value)}\n`;
  }
  let out = "";
  for (const [k, v] of Object.entries(value)) {
    const key = needsQuote(k) ? quoteScalar(k) : k;
    if (v === null || v === undefined) out += `${pad}${key}:\n`;
    else if (isFlowable(v)) out += `${pad}${key}: ${flowText(v)}\n`;
    else out += `${pad}${key}:\n${serializeYamlSubset(v, indent + 2)}`;
  }
  return out;
}

// --------------------------------------------------------------------------- //
// frontmatter 读写
// --------------------------------------------------------------------------- //
const FM_OPEN = /^---[ \t]*\n/;

/**
 * 解析一个 Markdown 文件的 frontmatter。
 * @returns {{data: object|null, body: string, errors: Array, hasFrontmatter: boolean, yamlText: string}}
 */
export function parseFrontmatter(text) {
  const src = String(text ?? "");
  if (!FM_OPEN.test(src)) {
    return {
      data: null,
      body: src,
      yamlText: "",
      hasFrontmatter: false,
      errors: [{ code: "INVALID_FRONTMATTER", message: "文件不以 --- 开头的 YAML frontmatter 开始" }],
    };
  }
  const afterOpen = src.replace(FM_OPEN, "");
  const closeMatch = /^---[ \t]*(?:\n|$)/m.exec(afterOpen);
  if (!closeMatch) {
    return {
      data: null,
      body: afterOpen,
      yamlText: "",
      hasFrontmatter: false,
      errors: [{ code: "INVALID_FRONTMATTER", message: "frontmatter 缺少结束的 --- 行" }],
    };
  }
  const yamlText = afterOpen.slice(0, closeMatch.index);
  const body = afterOpen.slice(closeMatch.index + closeMatch[0].length);
  const { value, errors } = parseYamlSubset(yamlText);
  if (errors.length) return { data: null, body, yamlText, hasFrontmatter: true, errors };
  if (value !== null && !isMap(value)) {
    return {
      data: null,
      body,
      yamlText,
      hasFrontmatter: true,
      errors: [{ code: "INVALID_FRONTMATTER", message: "frontmatter 顶层必须是映射" }],
    };
  }
  return { data: value ?? {}, body, yamlText, hasFrontmatter: true, errors: [] };
}

/** 组装一个 Markdown 文件（frontmatter + 正文）。 */
export function composeNote(data, body = "") {
  const yaml = serializeYamlSubset(data);
  const text = String(body ?? "");
  return `---\n${yaml}---\n${text.startsWith("\n") ? text.slice(1) : text}`;
}

/** 解析整个 Markdown 文件（frontmatter + 正文 + 原 bytes hash）。 */
export function parseNote(text) {
  const parsed = parseFrontmatter(text);
  return { ...parsed, hash: sha256Hex(Buffer.from(String(text ?? ""), "utf8")) };
}

// --------------------------------------------------------------------------- //
// 字段校验器
// --------------------------------------------------------------------------- //
function fail(c, code, field, message) {
  c.errors.push({ code, field, message });
}

function enumOf(domain, field) {
  return (v, f, c) => {
    if (v === null) return;
    if (!VALUE_DOMAINS[domain].includes(v)) {
      fail(c, "INVALID_ENUM", f || field, `${f || field} 只能是 ${VALUE_DOMAINS[domain].join(" / ")}，得到 ${JSON.stringify(v)}`);
    }
  };
}

function checkString(field, { nullable = false, nonEmpty = true, check = null } = {}) {
  return (v, f, c) => {
    if (v === null) {
      if (!nullable) fail(c, "MISSING_REQUIRED", f, `${f} 不得为 null`);
      return;
    }
    if (!isStr(v)) return fail(c, "INVALID_VALUE", f, `${f} 必须是字符串，得到 ${typeof v}`);
    if (nonEmpty && v.trim() === "") fail(c, "INVALID_VALUE", f, `${f} 不得为空字符串`);
    if (check && !check(v)) fail(c, "INVALID_VALUE", f, `${f} 格式不合法：${JSON.stringify(v)}`);
  };
}

function checkArrayOfStrings(field, { nullable = false, nonEmpty = false } = {}) {
  return (v, f, c) => {
    if (v === null) {
      if (!nullable) fail(c, "MISSING_REQUIRED", f, `${f} 不得为 null`);
      return;
    }
    if (!isArr(v)) return fail(c, "INVALID_STRUCTURE", f, `${f} 必须是数组`);
    if (nonEmpty && v.length === 0 && !c.draft) fail(c, "INVALID_VALUE", f, `${f} 不得为空数组`);
    v.forEach((item, i) => {
      if (!isNonEmptyStr(item)) {
        fail(c, "INVALID_VALUE", `${f}[${i}]`, `${f}[${i}] 必须是非空字符串`);
      }
    });
  };
}

function checkSpanRef(v, f, c) {
  if (!isMap(v)) return fail(c, "INVALID_STRUCTURE", f, `${f} 必须是 SpanRef 映射`);
  const reqStr = ["book_id", "book_version_id", "section_id", "block_id", "span_id", "href"];
  for (const k of reqStr) {
    if (!isNonEmptyStr(v[k])) fail(c, "MISSING_REQUIRED", `${f}.${k}`, `SpanRef.${k} 必须是非空字符串`);
  }
  if (!isInt(v.start_codepoint) || v.start_codepoint < 0) {
    fail(c, "INVALID_VALUE", `${f}.start_codepoint`, "start_codepoint 必须是非负整数（Unicode code point）");
  }
  if (!isInt(v.end_codepoint) || v.end_codepoint < 0) {
    fail(c, "INVALID_VALUE", `${f}.end_codepoint`, "end_codepoint 必须是非负整数（Unicode code point）");
  }
  if (isInt(v.start_codepoint) && isInt(v.end_codepoint) && !(v.end_codepoint > v.start_codepoint)) {
    fail(c, "INVALID_VALUE", `${f}.end_codepoint`, "必须满足 start_codepoint < end_codepoint（左闭右开）");
  }
  if (!isHash64(v.text_hash)) {
    fail(c, "INVALID_VALUE", `${f}.text_hash`, "text_hash 必须是 64 位小写十六进制（规范化文本 hash）");
  }
  enumOf("locator_quality")(v.locator_quality, `${f}.locator_quality`, c);
  enumOf("quote_type")(v.quote_type, `${f}.quote_type`, c);
  for (const k of ["locator_quality", "quote_type"]) {
    if (v[k] === null || v[k] === undefined) fail(c, "MISSING_REQUIRED", `${f}.${k}`, `SpanRef.${k} 必填`);
  }
}

function checkSessionEvidence(v, f, c) {
  if (!isMap(v)) return fail(c, "INVALID_STRUCTURE", f, `${f} 必须是 SessionEvidence 映射`);
  for (const k of ["host", "session_id", "locator_kind", "branch_id", "source_revision"]) {
    if (!isNonEmptyStr(v[k])) fail(c, "MISSING_REQUIRED", `${f}.${k}`, `SessionEvidence.${k} 必须是非空字符串`);
  }
  if (v.locator_kind !== null && v.locator_kind !== undefined && !VALUE_DOMAINS.locator_kind.includes(v.locator_kind)) {
    fail(c, "INVALID_ENUM", `${f}.locator_kind`, `locator_kind 只能是 ${VALUE_DOMAINS.locator_kind.join(" / ")}`);
  }
  if (v.locator_kind === "event_seq" && !(isInt(v.event_seq) && v.event_seq >= 0)) {
    fail(c, "INVALID_VALUE", `${f}.event_seq`, "locator_kind=event_seq 时 event_seq 必须是非负整数");
  }
  if (v.locator_kind === "turn_id" && !isNonEmptyStr(v.turn_id)) {
    fail(c, "INVALID_VALUE", `${f}.turn_id`, "locator_kind=turn_id 时 turn_id 必须是非空字符串");
  }
  if (v.turn !== null && v.turn !== undefined && !(isInt(v.turn) && v.turn >= 0)) {
    fail(c, "INVALID_VALUE", `${f}.turn`, "turn 必须是可解析时的非负整数，否则 null");
  }
  if (v.availability !== null && v.availability !== undefined) {
    enumOf("source_availability")(v.availability, `${f}.availability`, c);
  } else {
    fail(c, "MISSING_REQUIRED", `${f}.availability`, "SessionEvidence.availability 必填");
  }
  if (v.durability_evidence !== null && v.durability_evidence !== undefined) {
    if (!isMap(v.durability_evidence) || !isNonEmptyStr(v.durability_evidence.kind)) {
      fail(c, "INVALID_STRUCTURE", `${f}.durability_evidence`, "durability_evidence 必须是 {kind, revision} 映射");
    }
  }
}

function checkSourceRef(v, f, c) {
  if (!isMap(v)) return fail(c, "INVALID_STRUCTURE", f, `${f} 必须是 SourceRef 映射`);
  if (!VALUE_DOMAINS.source_ref_kind.includes(v.source_kind)) {
    return fail(
      c,
      "INVALID_ENUM",
      `${f}.source_kind`,
      `source_kind 只能是 ${VALUE_DOMAINS.source_ref_kind.join(" / ")}`,
    );
  }
  const ref = v.ref;
  if (v.source_kind === "book_span") checkSpanRef(ref, `${f}.ref`, c);
  else if (v.source_kind === "host_turn") checkSessionEvidence(ref, `${f}.ref`, c);
  else if (v.source_kind === "knowledge_note") {
    if (!isMap(ref)) fail(c, "INVALID_STRUCTURE", `${f}.ref`, "knowledge_note 的 ref 必须是 {relative_path, content_hash}");
    else {
      if (!isNonEmptyStr(ref.relative_path)) fail(c, "MISSING_REQUIRED", `${f}.ref.relative_path`, "relative_path 必填");
      if (!isHash64(ref.content_hash)) fail(c, "INVALID_VALUE", `${f}.ref.content_hash`, "content_hash 必须是 64 位十六进制");
    }
  } else if (v.source_kind === "user_action") {
    if (!isMap(ref)) fail(c, "INVALID_STRUCTURE", `${f}.ref`, "user_action 的 ref 必须是 {actor, action_id, at, scope, short_statement}");
    else {
      for (const k of ["actor", "action_id", "at", "scope", "short_statement"]) {
        if (!isNonEmptyStr(ref[k])) fail(c, "MISSING_REQUIRED", `${f}.ref.${k}`, `user_action.${k} 必填`);
      }
    }
  }
}

function checkSourceAssetRef(v, f, c) {
  if (!isMap(v)) return fail(c, "INVALID_STRUCTURE", f, "source_assets 每项必须是 SourceAssetRef 映射");
  if (!isNonEmptyStr(v.source_id)) fail(c, "MISSING_REQUIRED", `${f}.source_id`, "source_id 必填");
  enumOf("source_asset_kind")(v.source_kind, `${f}.source_kind`, c);
  if (!isMap(v.locator)) {
    fail(c, "INVALID_STRUCTURE", `${f}.locator`, "locator 必须是受控来源句柄或授权 vault 相对路径的映射");
  } else if (!isNonEmptyStr(v.locator.source_handle) && !isNonEmptyStr(v.locator.relative_path)) {
    fail(c, "MISSING_REQUIRED", `${f}.locator`, "locator 需含 source_handle 或 relative_path");
  }
  if (v.content_hash !== null && v.content_hash !== undefined && !isHash64(v.content_hash)) {
    fail(c, "INVALID_VALUE", `${f}.content_hash`, "content_hash 能读取时必须是 64 位十六进制，否则 null");
  }
  if (v.availability === null || v.availability === undefined) {
    fail(c, "MISSING_REQUIRED", `${f}.availability`, "availability 必填");
  } else enumOf("source_availability")(v.availability, `${f}.availability`, c);
  if (v.export_policy === null || v.export_policy === undefined) {
    fail(c, "MISSING_REQUIRED", `${f}.export_policy`, "export_policy 必填（该字段不是授权本身）");
  } else enumOf("export_policy")(v.export_policy, `${f}.export_policy`, c);
}

/**
 * PRD §8.5 的 external_master 组合约束。
 * 表格只承认 7 种组合；其余一律非法——"未查却报 no_match"是明确失败项（AC-23）。
 */
const LEGAL_EXTERNAL_MASTER = new Set([
  "unverified|not_checked",
  "unverified|not_authorized",
  "unverified|partial",
  "unverified|read_error",
  "unverified|stale",
  "verified|matched",
  "verified|no_match",
  "linked|matched",
]);

export function checkExternalMaster(v, f, c) {
  if (!isMap(v)) return fail(c, "INVALID_STRUCTURE", f, `${f} 必须是 external_master 映射`);
  const status = v.status;
  const outcome = v.outcome;
  if (!VALUE_DOMAINS.external_master_status.includes(status)) {
    fail(c, "INVALID_ENUM", `${f}.status`, `status 只能是 ${VALUE_DOMAINS.external_master_status.join(" / ")}`);
  }
  if (!VALUE_DOMAINS.external_master_outcome.includes(outcome)) {
    fail(c, "INVALID_ENUM", `${f}.outcome`, `outcome 只能是 ${VALUE_DOMAINS.external_master_outcome.join(" / ")}`);
  }
  if (!LEGAL_EXTERNAL_MASTER.has(`${status}|${outcome}`)) {
    fail(
      c,
      "INVALID_COMBINATION",
      f,
      `external_master 组合 ${status}+${outcome} 不在 PRD §8.5 允许的 7 种之内`,
    );
  }
  if (!isArr(v.scope_refs)) fail(c, "INVALID_STRUCTURE", `${f}.scope_refs`, "scope_refs 必须是数组");
  if (!isArr(v.candidate_refs)) fail(c, "INVALID_STRUCTURE", `${f}.candidate_refs`, "candidate_refs 必须是数组");
  if (v.authorization_revision === undefined) {
    fail(c, "MISSING_REQUIRED", `${f}.authorization_revision`, "authorization_revision 必填（无授权时可为 null）");
  }
  const noCheck = outcome === "not_checked" || outcome === "not_authorized";
  if (noCheck) {
    if (v.checked_at !== null && v.checked_at !== undefined) {
      fail(c, "INVALID_COMBINATION", `${f}.checked_at`, "未执行/未获授权时 checked_at 必须为 null");
    }
    if (v.ref !== null && v.ref !== undefined) {
      fail(c, "INVALID_COMBINATION", `${f}.ref`, "未执行/未获授权时 ref 必须为 null");
    }
  }
  if (outcome === "matched" || outcome === "no_match") {
    if (!isIsoTime(v.checked_at)) {
      fail(c, "INVALID_VALUE", `${f}.checked_at`, "已完成检查时 checked_at 必须是 ISO 时间");
    }
    if (v.ref !== null && v.ref !== undefined && status !== "linked") {
      fail(c, "INVALID_COMBINATION", `${f}.ref`, "status 非 linked 时 ref 必须为 null");
    }
  }
  if (outcome === "no_match" && (!isArr(v.scope_refs) || v.scope_refs.length === 0) && !c.draft) {
    fail(c, "INVALID_COMBINATION", `${f}.scope_refs`, "no_match 必须列明实际检查的 scope_refs，否则不得声称无匹配");
  }
  if (status === "linked") {
    if (!isMap(v.ref)) {
      fail(c, "MISSING_REQUIRED", `${f}.ref`, "linked 时 ref 必填");
    } else {
      if (!isNonEmptyStr(v.ref.relative_path)) fail(c, "MISSING_REQUIRED", `${f}.ref.relative_path`, "ref.relative_path 必填");
      if (!isHash64(v.ref.content_hash)) fail(c, "INVALID_VALUE", `${f}.ref.content_hash`, "linked 时 ref.content_hash 必填且为 64 位十六进制");
      const hit = isArr(v.candidate_refs) && v.candidate_refs.some((r) => isMap(r) && r.relative_path === v.ref.relative_path);
      if (!hit) fail(c, "INVALID_COMBINATION", `${f}.candidate_refs`, "linked 时 candidate_refs 必须包含该页");
    }
  }
  if (v.check_id !== null && v.check_id !== undefined && !isNonEmptyStr(v.check_id)) {
    fail(c, "INVALID_VALUE", `${f}.check_id`, "check_id 必须是非空字符串或 null");
  }
  if (!noCheck && !isNonEmptyStr(v.check_id)) {
    fail(c, "MISSING_REQUIRED", `${f}.check_id`, "执行过核对时 check_id 必填");
  }
}

function checkConfirmation(data, c) {
  const conf = data.confirmation;
  const ev = data.confirmation_evidence;
  if (conf === "confirmed" || conf === "retracted") {
    if (!isMap(ev)) {
      return fail(c, "CONFIRMATION_EVIDENCE_REQUIRED", "confirmation_evidence",
        `${conf} 必须带真实 actor/action_id/at/scope 的 confirmation_evidence（模型不能生成有效动作）`);
    }
    for (const k of ["actor", "action_id", "at", "scope"]) {
      if (!isNonEmptyStr(ev[k])) {
        fail(c, "CONFIRMATION_EVIDENCE_REQUIRED", `confirmation_evidence.${k}`, `${conf} 时 confirmation_evidence.${k} 必填`);
      }
    }
  } else if (conf === "unconfirmed") {
    if (ev !== null && ev !== undefined) {
      fail(c, "CONFIRMATION_EVIDENCE_UNEXPECTED", "confirmation_evidence",
        "unconfirmed 不得携带 confirmation_evidence（保存许可不等于内容确认）");
    }
  }
}

function checkGeneratedBy(v, f, c) {
  if (!isMap(v)) {
    return fail(c, "INVALID_STRUCTURE", f, "generated_by 必须是 {compiler, version} 映射，不接受标量");
  }
  const keys = Object.keys(v).sort();
  if (keys.length !== 2 || keys[0] !== "compiler" || keys[1] !== "version") {
    return fail(c, "INVALID_STRUCTURE", f, "generated_by 只允许 compiler 与 version 两个子字段");
  }
  if (!isNonEmptyStr(v.compiler) || !isNonEmptyStr(v.version)) {
    if (!c.draft) {
      fail(c, "INVALID_VALUE", f, "工具生成且提供 generated_by 时，compiler/version 必须是真实非空字符串（不接受半填或空串）");
    }
  }
}

function checkCompilerTopLevel(v, f, c) {
  if (!isMap(v)) {
    return fail(c, "INVALID_STRUCTURE", f, "顶层 compiler 必须是 {name, version} 映射，不接受标量或省略");
  }
  const keys = Object.keys(v).sort();
  if (keys.length !== 2 || keys[0] !== "name" || keys[1] !== "version") {
    return fail(c, "INVALID_STRUCTURE", f, "顶层 compiler 只允许 name 与 version 两个子字段（键名与 generated_by 不同）");
  }
  if (!isNonEmptyStr(v.name) || !isNonEmptyStr(v.version)) {
    if (!c.draft) {
      fail(c, "INVALID_VALUE", f, "正式提案顶层 compiler 的 name/version 必须是真实非空字符串，未知时阻止生成可接受提案");
    }
  }
}

function checkDedupCheck(v, f, c) {
  if (!isMap(v)) return fail(c, "INVALID_STRUCTURE", f, "dedup_check 必须是映射");
  for (const k of ["check_id", "input_fingerprint"]) {
    if (!isNonEmptyStr(v[k]) && !c.draft) fail(c, "MISSING_REQUIRED", `${f}.${k}`, `dedup_check.${k} 必填`);
  }
  if (v.authorization_revision === undefined) {
    fail(c, "MISSING_REQUIRED", `${f}.authorization_revision`, "dedup_check.authorization_revision 必填（无授权时 null）");
  }
  if (v.local_result === null || v.local_result === undefined) {
    if (!c.draft) fail(c, "MISSING_REQUIRED", `${f}.local_result`, "dedup_check.local_result 必填（本区检查必须执行）");
  } else enumOf("dedup_local_result")(v.local_result, `${f}.local_result`, c);
  if (!isArr(v.candidate_refs)) fail(c, "INVALID_STRUCTURE", `${f}.candidate_refs`, "dedup_check.candidate_refs 必须是数组");
  checkExternalMaster(v.external_master, `${f}.external_master`, c);
}

function checkOperation(v, f, c, ctx) {
  if (!isMap(v)) return fail(c, "INVALID_STRUCTURE", f, "operation 必须是映射");
  if (!isNonEmptyStr(v.operation_id) && !c.draft) fail(c, "MISSING_REQUIRED", `${f}.operation_id`, "operation_id 必填");
  enumOf("operation_type")(v.type, `${f}.type`, c);
  if ((v.type === null || v.type === undefined) && !c.draft) fail(c, "MISSING_REQUIRED", `${f}.type`, "operation.type 必填");
  if (v.object_type !== null && v.object_type !== undefined && !c.domain.objectTypes.includes(v.object_type)) {
    fail(c, "INVALID_ENUM", `${f}.object_type`, `operation.object_type 必须是 ${c.domain.objectTypes.length} 个正式对象之一`);
  }
  if (v.type === "create") {
    if (!isNonEmptyStr(v.target_object_id) && !c.draft) {
      fail(c, "MISSING_REQUIRED", `${f}.target_object_id`, "create 必须给出目标对象 ID");
    }
    if (v.base_hash !== null && v.base_hash !== undefined) {
      fail(c, "INVALID_COMBINATION", `${f}.base_hash`, "新建 base_hash 必须为 null，并要求目标不存在");
    }
  }
  if (v.type === "update" && !isHash64(v.base_hash) && !c.draft) {
    fail(c, "MISSING_REQUIRED", `${f}.base_hash`, "更新必须带实读的 base_hash（64 位十六进制）");
  }
  if (!isNonEmptyStr(v.short_content) && !c.draft) {
    fail(c, "MISSING_REQUIRED", `${f}.short_content`, "operation 必须带短内容（不搬完整会话）");
  }
  if (v.base_hash !== null && v.base_hash !== undefined && !isHash64(v.base_hash)) {
    fail(c, "INVALID_VALUE", `${f}.base_hash`, "base_hash 必须是 64 位十六进制或 null");
  }
  if (v.type === "create" && ctx && ctx.localResult === "matched" && !isNonEmptyStr(v.new_note_reason)) {
    fail(c, "INVALID_COMBINATION", `${f}.new_note_reason`,
      "本区已有匹配对象却新建，必须说明 new_note_reason（不得为绕过确认重复建同义页）");
  }
  if (v.matched_object_ids !== undefined && !isArr(v.matched_object_ids)) {
    fail(c, "INVALID_STRUCTURE", `${f}.matched_object_ids`, "matched_object_ids 必须是数组");
  }
  if (c.domain.semanticObjectTypes.includes(v.object_type)) {
    enumOf("origin")(v.origin, `${f}.origin`, c);
    enumOf("confirmation")(v.confirmation, `${f}.confirmation`, c);
    if ((v.origin === null || v.origin === undefined) && !c.draft) fail(c, "MISSING_REQUIRED", `${f}.origin`, "语义 operation 必填 origin");
    if ((v.confirmation === null || v.confirmation === undefined) && !c.draft) {
      fail(c, "MISSING_REQUIRED", `${f}.confirmation`, "语义 operation 必填 confirmation");
    }
  }
  if (v.source_refs !== undefined) {
    if (!isArr(v.source_refs)) fail(c, "INVALID_STRUCTURE", `${f}.source_refs`, "source_refs 必须是数组");
    else v.source_refs.forEach((r, i) => checkSourceRef(r, `${f}.source_refs[${i}]`, c));
  }
  for (const role of ["before_source_refs", "after_source_refs"]) {
    if (v[role] === undefined) continue;
    if (!isArr(v[role])) { fail(c, "INVALID_STRUCTURE", `${f}.${role}`, `${role} 必须是数组`); continue; }
    v[role].forEach((r, i) => checkSourceRef(r, `${f}.${role}[${i}]`, c));
  }
  if (v.object_type === "understanding_observation") {
    if ((!isArr(v.concept_refs) || v.concept_refs.length === 0) && !c.draft) {
      fail(c, "MISSING_REQUIRED", `${f}.concept_refs`, "理解变化 operation 必须带非空 concept_refs");
    }
    if ((v.dimension === null || v.dimension === undefined) && !c.draft) {
      fail(c, "MISSING_REQUIRED", `${f}.dimension`, "理解变化 operation 必填 dimension");
    } else if (v.dimension !== null && v.dimension !== undefined) {
      enumOf("dimension")(v.dimension, `${f}.dimension`, c);
    }
    if ((v.change_kind === null || v.change_kind === undefined) && !c.draft) {
      fail(c, "MISSING_REQUIRED", `${f}.change_kind`, "理解变化 operation 必填 change_kind");
    } else if (v.change_kind !== null && v.change_kind !== undefined) {
      enumOf("change_kind")(v.change_kind, `${f}.change_kind`, c);
    }
    if (!isNonEmptyStr(v.after) && !c.draft) fail(c, "MISSING_REQUIRED", `${f}.after`, "理解变化 operation 的 after 必须是非空短述");
    if ((!isArr(v.after_source_refs) || v.after_source_refs.length === 0) && !c.draft) {
      fail(c, "MISSING_REQUIRED", `${f}.after_source_refs`, "after_source_refs 必须非空");
    }
  }
  checkExternalMaster(v.external_master, `${f}.external_master`, c);
}

// --------------------------------------------------------------------------- //
// 对象校验表
// --------------------------------------------------------------------------- //
const COMMON_REQUIRED = [
  "schema_version",
  "object_type",
  "id",
  "revision",
  "title",
  "tags",
  "scope",
  "knowledge_status",
  "created_at",
  "updated_at",
];

const SEMANTIC_REQUIRED = [
  "origin",
  "confirmation",
  "confirmation_evidence",
  "book_evidence",
  "session_evidence",
  "external_master",
  "dedup_check_ref",
];

const COMMON_FIELDS = {
  schema_version: {
    nullable: false,
    check: (v, f, c) => {
      if (v !== SCHEMA_VERSION) {
        fail(c, "UNSUPPORTED_SCHEMA_VERSION", f,
          `本写入器只支持 schema_version "${SCHEMA_VERSION}"（注意：1.1 必须加引号，否则 YAML 会解析成数字）；得到 ${JSON.stringify(v)}`);
      }
    },
  },
  object_type: { nullable: false, check: (v, f, c) => {
    if (!c.domain.objectTypes.includes(v)) fail(c, "INVALID_ENUM", f, `object_type 必须是 ${c.domain.objectTypes.length} 个正式对象之一，得到 ${JSON.stringify(v)}`);
  } },
  id: { nullable: false, check: checkString("id") },
  revision: { nullable: false, check: (v, f, c) => {
    if (!isInt(v) || v < 1) fail(c, "INVALID_VALUE", f, "revision 必须是 ≥1 的整数");
  } },
  title: { nullable: false, check: checkString("title") },
  tags: { nullable: false, check: checkArrayOfStrings("tags", { nonEmpty: true }) },
  scope: { nullable: false, check: checkString("scope") },
  knowledge_status: { nullable: false, check: enumOf("knowledge_status", "knowledge_status") },
  created_at: { nullable: false, check: checkString("created_at", { check: isIsoTime }) },
  updated_at: { nullable: false, check: checkString("updated_at", { check: isIsoTime }) },
  origin: { nullable: false, check: enumOf("origin", "origin") },
  confirmation: { nullable: false, check: enumOf("confirmation", "confirmation") },
  confirmation_evidence: { nullable: true, check: (v, f, c) => {
    if (!isMap(v)) fail(c, "INVALID_STRUCTURE", f, "confirmation_evidence 必须是映射或 null");
  } },
  book_evidence: { nullable: false, check: (v, f, c) => {
    if (!isArr(v)) return fail(c, "INVALID_STRUCTURE", f, "book_evidence 必须是数组");
    v.forEach((r, i) => checkSpanRef(r, `${f}[${i}]`, c));
  } },
  session_evidence: { nullable: false, check: (v, f, c) => {
    if (!isArr(v)) return fail(c, "INVALID_STRUCTURE", f, "session_evidence 必须是数组");
    v.forEach((r, i) => checkSessionEvidence(r, `${f}[${i}]`, c));
  } },
  external_master: { nullable: false, check: checkExternalMaster },
  dedup_check_ref: { nullable: true, check: checkString("dedup_check_ref") },
  generated_by: { nullable: true, check: checkGeneratedBy },
  relations: { nullable: true, check: (v, f, c) => {
    if (!isArr(v)) return fail(c, "INVALID_STRUCTURE", f, "relations 必须是数组");
    v.forEach((r, i) => {
      if (!isMap(r)) return fail(c, "INVALID_STRUCTURE", `${f}[${i}]`, "relation 必须是映射");
      if (!isNonEmptyStr(r.from_id)) fail(c, "MISSING_REQUIRED", `${f}[${i}].from_id`, "relation.from_id 必填");
      if (!isNonEmptyStr(r.to_id)) fail(c, "MISSING_REQUIRED", `${f}[${i}].to_id`, "relation.to_id 必填");
      if (r.type === null || r.type === undefined) fail(c, "MISSING_REQUIRED", `${f}[${i}].type`, "relation.type 必填");
      else enumOf("relation_type")(r.type, `${f}[${i}].type`, c);
    });
  } },
  valid_until: { nullable: true, check: checkString("valid_until", { check: isIsoTime }) },
  source_refs: { nullable: false, check: (v, f, c) => {
    if (!isArr(v)) return fail(c, "INVALID_STRUCTURE", f, "source_refs 必须是数组");
    if (v.length === 0 && !c.draft) fail(c, "MISSING_REQUIRED", f, "source_refs 必须非空（仅用真实来源）");
    v.forEach((r, i) => checkSourceRef(r, `${f}[${i}]`, c));
  } },
  concept_refs: { nullable: true, check: checkArrayOfStrings("concept_refs") },
  before_source_refs: { nullable: false, check: (v, f, c) => {
    if (!isArr(v)) return fail(c, "INVALID_STRUCTURE", f, "before_source_refs 必须是数组");
    v.forEach((r, i) => checkSourceRef(r, `${f}[${i}]`, c));
  } },
  after_source_refs: { nullable: false, check: (v, f, c) => {
    if (!isArr(v)) return fail(c, "INVALID_STRUCTURE", f, "after_source_refs 必须是数组");
    if (v.length === 0 && !c.draft) fail(c, "MISSING_REQUIRED", f, "after_source_refs 必须非空");
    v.forEach((r, i) => checkSourceRef(r, `${f}[${i}]`, c));
  } },
  confidence: { nullable: false, check: (v, f, c) => {
    if (!isMap(v)) return fail(c, "INVALID_STRUCTURE", f, "confidence 必须是 {level, reason} 映射");
    if (!VALUE_DOMAINS.confidence_level.includes(v.level)) {
      fail(c, "INVALID_ENUM", `${f}.level`, `confidence.level 只能是 ${VALUE_DOMAINS.confidence_level.join(" / ")}`);
    }
    if (!isNonEmptyStr(v.reason) && !c.draft) fail(c, "MISSING_REQUIRED", `${f}.reason`, "confidence.reason 必须保留简短依据");
  } },
  strength: { nullable: true, check: enumOf("strength", "strength") },
  dimension: { nullable: true, check: enumOf("dimension", "dimension") },
  kind: { nullable: false, check: enumOf("reading_evidence_kind", "kind") },
  before: { nullable: true, check: (v, f, c) => {
    if (v !== null && !isNonEmptyStr(v)) fail(c, "INVALID_VALUE", f, "before 已知时必须是非空短述，未知时 null");
  } },
};

const OBJECT_SCHEMAS = {
  index: {
    // PRD §8.5 对 index_generation 的措辞是"可增"，且 §8.7 的正式示例未含该字段；
    // 规范 §2 只要求"存在时说明手工/管理生成方式"。故按可选处理（存在则校验形状）。
    required: [],
    fields: {
      index_generation: { nullable: false, check: (v, f, c) => {
        if (!isMap(v)) return fail(c, "INVALID_STRUCTURE", f, "index_generation 必须是映射");
        enumOf("index_generation_mode")(v.mode, `${f}.mode`, c);
        if (v.mode === null || v.mode === undefined) fail(c, "MISSING_REQUIRED", `${f}.mode`, "index_generation.mode 必填");
        if (v.generated_at !== null && v.generated_at !== undefined && !isIsoTime(v.generated_at)) {
          fail(c, "INVALID_VALUE", `${f}.generated_at`, "generated_at 必须是 ISO 时间或 null");
        }
        if (v.source_digest !== null && v.source_digest !== undefined && !isNonEmptyStr(v.source_digest)) {
          fail(c, "INVALID_VALUE", `${f}.source_digest`, "source_digest 必须是非空字符串或 null（null 表示未执行自动生成）");
        }
      } },
    },
    structural: true,
  },
  book: {
    required: [
      "book_id", "author", "book_version_id", "content_hash", "parser_version",
      "normalization_version", "source_assets", "source_page_ref", "external_master", "dedup_check_ref",
    ],
    fields: {
      book_id: { nullable: false, check: checkString("book_id") },
      author: { nullable: false, check: checkString("author") },
      book_version_id: { nullable: false, check: checkString("book_version_id") },
      content_hash: { nullable: true, check: (v, f, c) => {
        if (v !== null && !isHash64(v)) fail(c, "INVALID_VALUE", f, "content_hash 必须是 64 位十六进制；未知来源不得编造，可 null");
      } },
      parser_version: { nullable: true, check: checkString("parser_version") },
      normalization_version: { nullable: true, check: checkString("normalization_version") },
      source_assets: { nullable: false, check: (v, f, c) => {
        if (!isArr(v)) return fail(c, "INVALID_STRUCTURE", f, "source_assets 必须是数组");
        v.forEach((a, i) => checkSourceAssetRef(a, `${f}[${i}]`, c));
      } },
      source_page_ref: { nullable: true, check: checkString("source_page_ref") },
    },
  },
  book_summary: {
    required: ["purpose", "coverage_scope", "covered_span_refs", "missing_sections", "source_page_ref"],
    fields: {
      purpose: { nullable: false, check: checkString("purpose") },
      coverage_scope: { nullable: false, check: checkCoverageScope },
      covered_span_refs: { nullable: false, check: checkArrayOfStrings("covered_span_refs") },
      missing_sections: { nullable: false, check: checkArrayOfStrings("missing_sections") },
      source_page_ref: { nullable: true, check: checkString("source_page_ref") },
    },
    semantic: true,
    requireBookEvidence: true,
  },
  chapter_summary: {
    required: ["purpose", "coverage_scope", "covered_span_refs", "missing_sections", "source_page_ref"],
    fields: {
      purpose: { nullable: false, check: checkString("purpose") },
      coverage_scope: { nullable: false, check: checkCoverageScope },
      covered_span_refs: { nullable: false, check: checkArrayOfStrings("covered_span_refs") },
      missing_sections: { nullable: false, check: checkArrayOfStrings("missing_sections") },
      source_page_ref: { nullable: true, check: checkString("source_page_ref") },
    },
    semantic: true,
    requireBookEvidence: true,
  },
  claim: {
    required: ["conditions"],
    fields: {
      conditions: { nullable: false, check: checkArrayOfStrings("conditions") },
      counterexample_refs: { nullable: true, check: checkArrayOfStrings("counterexample_refs") },
    },
    semantic: true,
    requireBookEvidence: true,
    originFixed: "book_author",
  },
  insight: {
    required: [],
    fields: {
      conditions: { nullable: true, check: checkArrayOfStrings("conditions") },
      derived_from: { nullable: true, check: checkArrayOfStrings("derived_from") },
    },
    semantic: true,
  },
  concept: {
    required: ["concept_name", "comparison_refs"],
    fields: {
      concept_name: { nullable: false, check: checkString("concept_name") },
      comparison_refs: { nullable: false, check: checkArrayOfStrings("comparison_refs") },
    },
    semantic: true,
  },
  understanding_observation: {
    required: [
      "concept_refs", "dimension", "change_kind", "before", "after",
      "before_source_refs", "after_source_refs", "assessment_basis",
    ],
    fields: {
      after: { nullable: false, check: checkString("after") },
      assessment_basis: { nullable: false, check: checkString("assessment_basis") },
      change_kind: { nullable: false, check: enumOf("change_kind", "change_kind") },
      derived_from: { nullable: true, check: checkArrayOfStrings("derived_from") },
    },
    semantic: true,
    post: (data, c) => {
      if ((!isArr(data.concept_refs) || data.concept_refs.length === 0) && !c.draft) {
        fail(c, "MISSING_REQUIRED", "concept_refs", "理解变化必须带非空 concept_refs");
      }
      if ((data.dimension === null || data.dimension === undefined) && !c.draft) {
        fail(c, "MISSING_REQUIRED", "dimension", "理解变化必填 dimension");
      }
      const beforeKnown = data.before !== null && data.before !== undefined;
      const beforeRefs = data.before_source_refs;
      if (beforeKnown) {
        if (!isNonEmptyStr(data.before)) fail(c, "INVALID_VALUE", "before", "before 已知时必须是非空短述");
        if ((!isArr(beforeRefs) || beforeRefs.length === 0) && !c.draft) {
          fail(c, "INVALID_COMBINATION", "before_source_refs", "before 已知时前引用必须非空");
        }
      } else if (isArr(beforeRefs) && beforeRefs.length > 0) {
        fail(c, "INVALID_COMBINATION", "before_source_refs", "before 未知时必须为空数组（不得补造历史判断）");
      }
    },
  },
  question: {
    required: ["concept_refs", "related_object_ids", "resolution_ref"],
    fields: {
      related_object_ids: { nullable: false, check: checkArrayOfStrings("related_object_ids") },
      resolution_ref: { nullable: true, check: checkString("resolution_ref") },
    },
    semantic: true,
  },
  recommendation_feedback: {
    required: ["run_id", "item_id", "feedback_type", "feedback_scope", "user_action_id"],
    fields: {
      run_id: { nullable: false, check: checkString("run_id") },
      item_id: { nullable: true, check: checkString("item_id") },
      feedback_type: { nullable: false, check: enumOf("feedback_type", "feedback_type") },
      feedback_scope: { nullable: false, check: checkString("feedback_scope") },
      user_action_id: { nullable: false, check: checkString("user_action_id") },
    },
    semantic: true,
    originFixed: "user",
    post: (data, c) => {
      if (data.feedback_type && data.feedback_scope === "batch" && data.item_id) {
        fail(c, "INVALID_COMBINATION", "item_id", "批次反馈应 item_id=null");
      }
    },
  },
  change_proposal: {
    required: [
      "proposal_id", "job_id", "state", "application_mode", "authorization_ref",
      "input_fingerprint", "source_range", "dedup_check", "operations", "compiler",
    ],
    fields: {
      proposal_id: { nullable: false, check: checkString("proposal_id") },
      job_id: { nullable: false, check: checkString("job_id") },
      state: { nullable: false, check: enumOf("change_proposal_state", "state") },
      application_mode: { nullable: false, check: enumOf("application_mode", "application_mode") },
      authorization_ref: { nullable: true, check: (v, f, c) => {
        if (!isMap(v)) return fail(c, "INVALID_STRUCTURE", f, "authorization_ref 必须是 {actor, action_id, scope, revision} 或 null");
        for (const k of ["actor", "action_id", "scope", "revision"]) {
          if (!isNonEmptyStr(v[k])) fail(c, "MISSING_REQUIRED", `${f}.${k}`, `authorization_ref.${k} 必填`);
        }
      } },
      input_fingerprint: { nullable: false, check: checkString("input_fingerprint") },
      source_range: { nullable: false, check: (v, f, c) => {
        if (!isStr(v) && !isMap(v)) fail(c, "INVALID_STRUCTURE", f, "source_range 必须是字符串或映射");
        if (isStr(v) && v.trim() === "") fail(c, "INVALID_VALUE", f, "source_range 不得为空");
      } },
      dedup_check: { nullable: false, check: checkDedupCheck },
      operations: { nullable: false, check: (v, f, c) => {
        if (!isArr(v)) return fail(c, "INVALID_STRUCTURE", f, "operations 必须是数组");
        if (v.length === 0 && !c.draft) fail(c, "MISSING_REQUIRED", f, "正式提案的 operations 不得为空");
      } },
      compiler: { nullable: false, check: checkCompilerTopLevel },
      uncertainties: { nullable: true, check: checkArrayOfStrings("uncertainties") },
    },
    post: (data, c) => {
      const localResult = isMap(data.dedup_check) ? data.dedup_check.local_result : null;
      if (isArr(data.operations)) {
        data.operations.forEach((op, i) => checkOperation(op, `operations[${i}]`, c, { localResult }));
      }
      if (data.application_mode === "authorized_auto" && !isMap(data.authorization_ref) && !c.draft) {
        fail(c, "MISSING_REQUIRED", "authorization_ref",
          "authorized_auto 必须引用真实启用动作 authorization_ref（模型不得自选自动模式）");
      }
      if (data.application_mode === "manual" && data.authorization_ref !== null && data.authorization_ref !== undefined) {
        fail(c, "INVALID_COMBINATION", "authorization_ref", "manual 模式的 authorization_ref 必须为 null");
      }
    },
  },
  maintenance_proposal: {
    required: ["proposal_id", "state", "action_type", "target_ref", "affected_object_ids", "source_refs", "acknowledgement"],
    fields: {
      proposal_id: { nullable: false, check: checkString("proposal_id") },
      state: { nullable: false, check: enumOf("maintenance_proposal_state", "state") },
      action_type: { nullable: false, check: enumOf("maintenance_action_type", "action_type") },
      target_ref: { nullable: false, check: (v, f, c) => {
        if (!isStr(v) && !isMap(v)) fail(c, "INVALID_STRUCTURE", f, "target_ref 必须是字符串或映射");
      } },
      affected_object_ids: { nullable: false, check: checkArrayOfStrings("affected_object_ids") },
      source_refs: { nullable: false, check: (v, f, c) => {
        if (!isArr(v)) return fail(c, "INVALID_STRUCTURE", f, "source_refs 必须是数组");
        v.forEach((r, i) => checkSourceRef(r, `${f}[${i}]`, c));
      } },
      acknowledgement: { nullable: true, check: (v, f, c) => {
        if (!isMap(v)) return fail(c, "INVALID_STRUCTURE", f, "acknowledgement 必须是映射或 null");
        for (const k of ["actor", "action_id", "at"]) {
          if (!isNonEmptyStr(v[k])) fail(c, "MISSING_REQUIRED", `${f}.${k}`, `acknowledgement.${k} 必填`);
        }
      } },
    },
    post: (data, c) => {
      if (data.state === "acknowledged" && !isMap(data.acknowledgement) && !c.draft) {
        fail(c, "MISSING_REQUIRED", "acknowledgement",
          "acknowledged 必须带真实回执（导出、复制文字或模型声称完成都不算）");
      }
      if (data.state === "pending" && data.acknowledgement !== null && data.acknowledgement !== undefined) {
        fail(c, "INVALID_COMBINATION", "acknowledgement", "pending 不得携带回执");
      }
    },
  },
  reading_background: {
    required: ["goals", "allowed_background_refs", "consent_refs", "reading_boundary"],
    fields: {
      goals: { nullable: false, check: checkArrayOfStrings("goals", { nonEmpty: true }) },
      allowed_background_refs: { nullable: false, check: checkArrayOfStrings("allowed_background_refs") },
      consent_refs: { nullable: false, check: checkArrayOfStrings("consent_refs") },
      reading_boundary: { nullable: false, check: (v, f, c) => {
        if (!isStr(v) && !isMap(v)) fail(c, "INVALID_STRUCTURE", f, "reading_boundary 必须是字符串或映射");
        if (isStr(v) && v.trim() === "") fail(c, "INVALID_VALUE", f, "reading_boundary 不得为空");
      } },
    },
    semantic: true,
    originFixed: "user",
  },
  reading_evidence: {
    required: [
      "kind", "dimension", "concept_refs", "strength", "confidence",
      "assessment_basis", "source_refs", "valid_until",
    ],
    fields: {
      assessment_basis: { nullable: false, check: checkString("assessment_basis") },
    },
    semantic: true,
    post: (data, c) => {
      if (data.kind === "explicit_preference") {
        if (data.dimension !== null && data.dimension !== undefined) {
          enumOf("dimension")(data.dimension, "dimension", c);
        }
      } else if (data.kind !== null && data.kind !== undefined && !c.draft) {
        if (data.dimension === null || data.dimension === undefined) {
          fail(c, "MISSING_REQUIRED", "dimension",
            "只有 explicit_preference（非能力偏好）允许 dimension=null");
        }
      }
      const hasStrength = data.strength !== null && data.strength !== undefined;
      const level = isMap(data.confidence) ? data.confidence.level : null;
      if (!hasStrength && level !== null && level !== "unknown") {
        fail(c, "INVALID_COMBINATION", "confidence.level", "未评级（strength=null）时 confidence.level 必须是 unknown");
      }
      if (hasStrength && level === "unknown") {
        fail(c, "INVALID_COMBINATION", "confidence.level", "已给 strength 评级时 confidence.level 不得为 unknown");
      }
    },
  },
  recommendation_run: {
    required: [
      "run_id", "job_id", "state", "book_version_id", "input_manifest_refs", "input_fingerprint",
      "candidate_set_version", "policy", "model", "prompt_template_version", "result_outcome",
      "book_guide", "personalized_items", "personalization_status", "selected_items",
      "exclusions", "constraints_report", "budget_usage",
    ],
    fields: {
      run_id: { nullable: false, check: checkString("run_id") },
      job_id: { nullable: false, check: checkString("job_id") },
      state: { nullable: false, check: enumOf("recommendation_run_state", "state") },
      book_version_id: { nullable: false, check: checkString("book_version_id") },
      input_manifest_refs: { nullable: false, check: checkArrayOfStrings("input_manifest_refs") },
      input_fingerprint: { nullable: false, check: checkString("input_fingerprint") },
      candidate_set_version: { nullable: false, check: checkString("candidate_set_version") },
      policy: { nullable: false, check: (v, f, c) => {
        if (!isMap(v) || !isNonEmptyStr(v.id) || !isNonEmptyStr(v.version)) {
          fail(c, "INVALID_STRUCTURE", f, "policy 必须是 {id, version}");
        }
      } },
      model: { nullable: false, check: (v, f, c) => {
        if (!isStr(v) && !isMap(v)) fail(c, "INVALID_STRUCTURE", f, "model 必须是字符串或映射");
      } },
      prompt_template_version: { nullable: false, check: checkString("prompt_template_version") },
      result_outcome: { nullable: false, check: enumOf("result_outcome", "result_outcome") },
      book_guide: { nullable: true, check: checkBookGuide },
      personalized_items: { nullable: false, check: (v, f, c) => {
        if (!isArr(v)) fail(c, "INVALID_STRUCTURE", f, "personalized_items 必须是数组");
      } },
      personalization_status: { nullable: false, check: enumOf("personalization_status", "personalization_status") },
      selected_items: { nullable: false, check: (v, f, c) => {
        if (!isArr(v)) fail(c, "INVALID_STRUCTURE", f, "selected_items 必须是数组");
      } },
      exclusions: { nullable: false, check: (v, f, c) => {
        if (!isArr(v)) fail(c, "INVALID_STRUCTURE", f, "exclusions 必须是数组");
      } },
      constraints_report: { nullable: true, check: (v, f, c) => {
        if (!isMap(v)) fail(c, "INVALID_STRUCTURE", f, "constraints_report 必须是映射或 null");
      } },
      budget_usage: { nullable: true, check: (v, f, c) => {
        if (!isMap(v)) fail(c, "INVALID_STRUCTURE", f, "budget_usage 必须是映射或 null");
      } },
    },
    semantic: true,
    post: (data, c) => {
      const outcome = data.result_outcome;
      const guide = data.book_guide;
      if (outcome === "insufficient_evidence") {
        if (guide !== null && guide !== undefined) {
          fail(c, "INVALID_COMBINATION", "book_guide", "insufficient_evidence 时 book_guide 必须为 null");
        }
        if (isArr(data.personalized_items) && data.personalized_items.length > 0) {
          fail(c, "INVALID_COMBINATION", "personalized_items", "insufficient_evidence 时 personalized_items 必须为空");
        }
        if (isArr(data.selected_items) && data.selected_items.length > 0) {
          fail(c, "INVALID_COMBINATION", "selected_items", "insufficient_evidence 时 selected_items 必须为空");
        }
        if (data.personalization_status !== null && data.personalization_status !== undefined &&
            data.personalization_status !== "none") {
          fail(c, "INVALID_COMBINATION", "personalization_status", "insufficient_evidence 时必须是 none");
        }
      }
      if (outcome === "items") {
        if (!isMap(guide)) {
          fail(c, "MISSING_REQUIRED", "book_guide", "items 结果必须有含来源的 book_guide（空背景不是弃权理由）");
        } else {
          if (isArr(guide.items) && guide.items.length === 0 && !isNonEmptyStr(guide.no_eligible_reason) && !c.draft) {
            fail(c, "INVALID_COMBINATION", "book_guide.no_eligible_reason",
              "items 为空时必须给真实 no_eligible_reason，否则是结构错误");
          }
        }
        if (isArr(data.personalized_items) && data.personalized_items.length === 0 &&
            data.personalization_status !== "none" && data.personalization_status !== null) {
          fail(c, "INVALID_COMBINATION", "personalization_status",
            "personalized_items 为空时 status 必须是 none");
        }
      }
    },
  },
};

function checkCoverageScope(v, f, c) {
  if (!isMap(v)) return fail(c, "INVALID_STRUCTURE", f, "coverage_scope 必须是映射");
  if (!isNonEmptyStr(v.book_version_id) && !c.draft) {
    fail(c, "MISSING_REQUIRED", `${f}.book_version_id`, "coverage_scope.book_version_id 必填");
  }
  if (!isArr(v.section_ids)) fail(c, "INVALID_STRUCTURE", `${f}.section_ids`, "coverage_scope.section_ids 必须是数组");
}

function checkBookGuide(v, f, c) {
  if (!isMap(v)) return fail(c, "INVALID_STRUCTURE", f, "book_guide 必须是映射或 null");
  const paras = v.overview_paragraphs;
  if (!isArr(paras)) {
    fail(c, "MISSING_REQUIRED", `${f}.overview_paragraphs`, "book_guide 必须有 1 至数段有来源浓缩");
  } else if (paras.length === 0 && !c.draft) {
    fail(c, "MISSING_REQUIRED", `${f}.overview_paragraphs`, "book_guide 必须有 1 至数段有来源浓缩");
  } else if (paras.some((p) => !isNonEmptyStr(p))) {
    fail(c, "INVALID_VALUE", `${f}.overview_paragraphs`, "overview_paragraphs 每项必须是非空字符串");
  }
  if ((v.coverage_scope === null || v.coverage_scope === undefined) && !c.draft) {
    fail(c, "MISSING_REQUIRED", `${f}.coverage_scope`, "book_guide.coverage_scope 必填");
  }
  if (!isArr(v.source_refs) || (v.source_refs.length === 0 && !c.draft)) {
    fail(c, "MISSING_REQUIRED", `${f}.source_refs`, "book_guide.source_refs 必须非空（浓缩无来源是结构错误）");
  }
  if (!isArr(v.items)) fail(c, "INVALID_STRUCTURE", `${f}.items`, "book_guide.items 必须是数组");
}

// --------------------------------------------------------------------------- //
// 入口：对象校验
// --------------------------------------------------------------------------- //
/**
 * 域配置**必填**（M10 收口 A）。
 *
 * 为什么没有默认值：`schema.js` 是通用校验器，书域配置（15 个对象类型、交叉字段规则）
 * 属于域层 `lib/reading/book-domain.js`。给一个默认域 = 把书域知识又偷偷焊回通用层，
 * 那样边界测试就失去意义。缺域 ⇒ 显式失败，让调用方立刻知道要注入。
 */
function requireDomain(domain) {
  if (domain === null || domain === undefined || typeof domain !== "object" || Array.isArray(domain)) {
    throw new SchemaError("DOMAIN_REQUIRED",
      "validateNote 必须注入 domain（书域配置来自 lib/reading/book-domain.js 的 BOOK_DOMAIN）：本模块不再内证书域规则");
  }
  // 对象类型集合也来自域层：缺了它 object_type 校验必然全错，所以在这里**显式**挡下，
  // 而不是让 `[].includes()` 悄悄把所有对象判成非法（那会把配置错误伪装成数据错误）。
  if (!Array.isArray(domain.objectTypes) || !Array.isArray(domain.semanticObjectTypes)) {
    throw new SchemaError("DOMAIN_REQUIRED",
      "domain 必须提供 objectTypes 与 semanticObjectTypes 数组（书域配置的唯一来源：lib/reading/book-domain.js）");
  }
  return domain;
}

/**
 * 校验一个正式对象（或模板/draft）。
 *
 * mode:
 *   - "formal"（默认）：所有必填字段必须存在且非 null，值域严格。
 *   - "draft"：模板或未完成 draft 允许必填占位（null），但**非空值仍按值域校验**。
 *
 * domain（**必填**，M10 收口 A）：
 *   域配置由**调用方注入**（书域配置来自 `lib/reading/book-domain.js` 的 `BOOK_DOMAIN`）。
 *   本模块**不认识任何具体域**，因此**没有默认域**：缺域直接抛 `DOMAIN_REQUIRED`，
 *   而不是悄悄回落到一套写死的书域规则（那正是收口 A 要修掉的耦合）。
 * @returns {{ok: boolean, errors: Array<{code,field,message}>, warnings: Array, objectType: string|null}}
 */
export function validateNote(data, { mode = "formal", objectType = null, domain = null } = {}) {
  const draft = mode === "draft";
  const dom = requireDomain(domain);
  const c = { errors: [], draft, domain: dom };
  const warnings = [];
  if (!isMap(data)) {
    return { ok: false, objectType, errors: [{ code: "INVALID_FRONTMATTER", field: "", message: "frontmatter 顶层必须是映射" }], warnings };
  }
  if (!draft && data.template === true) {
    fail(c, "TEMPLATE_NOT_FORMAL", "template",
      "template: true 的设计模板不能作为正式记录；落正式页前必须移除 template 标记并补真实值");
  }
  const ot = objectType ?? data.object_type;
  if (!dom.objectTypes.includes(ot)) {
    return {
      ok: false,
      objectType: null,
      errors: [{ code: "INVALID_ENUM", field: "object_type", message: `object_type 必须是 ${dom.objectTypes.length} 个正式对象之一，得到 ${JSON.stringify(data.object_type)}` }],
      warnings,
    };
  }
  if (objectType && data.object_type !== objectType) {
    fail(c, "INVALID_VALUE", "object_type", `期望 object_type=${objectType}，得到 ${JSON.stringify(data.object_type)}`);
  }
  const spec = OBJECT_SCHEMAS[ot];
  const required = [...COMMON_REQUIRED, ...(spec.semantic ? SEMANTIC_REQUIRED : []), ...(spec.required ?? [])];
  for (const field of required) {
    const fieldSpec = spec.fields?.[field] ?? COMMON_FIELDS[field] ?? { nullable: false };
    const present = Object.prototype.hasOwnProperty.call(data, field);
    if (!present) {
      if (!draft) fail(c, "MISSING_REQUIRED", field, `${ot} 缺少必填字段 ${field}`);
      continue;
    }
    const v = data[field];
    if (v === null || v === undefined) {
      if (!fieldSpec.nullable && !draft) {
        fail(c, "MISSING_REQUIRED", field, `${ot}.${field} 在正式记录中不得为 null`);
      }
      continue;
    }
    if (fieldSpec.check) fieldSpec.check(v, field, c);
  }
  // 可选字段：只要出现且非 null 就必须合法
  for (const [field, fieldSpec] of Object.entries(spec.fields ?? {})) {
    if (required.includes(field)) continue;
    if (!Object.prototype.hasOwnProperty.call(data, field)) continue;
    const v = data[field];
    if (v === null || v === undefined) continue;
    if (fieldSpec.check) fieldSpec.check(v, field, c);
  }
  if (Object.prototype.hasOwnProperty.call(data, "generated_by") && data.generated_by !== null &&
      data.generated_by !== undefined && !required.includes("generated_by")) {
    checkGeneratedBy(data.generated_by, "generated_by", c);
  }
  // 域规则（M10 收口 A）：本模块**不认识具体域**，只按 `domain.rules[object_type]` 通用执行。
  // 原来这里是写死的 `if (ot === "index") {...}` 与 `if (ot === "book") {...}`；
  // 搬去 `book-domain.js` 的 `DOMAIN_RULES`，错误码/字段/消息**逐字不变**。
  const domainRule = dom.rules?.[ot];
  if (domainRule && typeof domainRule === "object") {
    if (isArr(domainRule.requiredTags) && isArr(data.tags)) {
      for (const t of domainRule.requiredTags) {
        if (!data.tags.includes(t)) {
          fail(c, "MISSING_REQUIRED", "tags", domainRule.requiredTagsMessage ?? `tags 必含 ${t}`);
        }
      }
    }
    if (typeof domainRule.idEquals === "string" &&
        isNonEmptyStr(data.id) && isNonEmptyStr(data[domainRule.idEquals]) &&
        data.id !== data[domainRule.idEquals]) {
      fail(c, "INVALID_COMBINATION", domainRule.idEquals,
        domainRule.idEqualsMessage ?? `id 必须等于 ${domainRule.idEquals}`);
    }
  }
  if (spec.originFixed && data.origin !== null && data.origin !== undefined && data.origin !== spec.originFixed) {
    fail(c, "INVALID_COMBINATION", "origin", `${ot} 的 origin 必须固定为 ${spec.originFixed}`);
  }
  if ((ot === "change_proposal" || ot === "maintenance_proposal") &&
      isNonEmptyStr(data.id) && isNonEmptyStr(data.proposal_id) && data.id !== data.proposal_id) {
    fail(c, "INVALID_COMBINATION", "proposal_id", "规范 §2：提案的 id 必须等于 proposal_id");
  }
  if (ot === "recommendation_run" && isNonEmptyStr(data.id) && isNonEmptyStr(data.run_id) && data.id !== data.run_id) {
    fail(c, "INVALID_COMBINATION", "run_id", "规范 §2：recommendation_run 的 id 必须等于 run_id");
  }
  if (spec.semantic) {
    if (isArr(data.book_evidence) && spec.requireBookEvidence && data.book_evidence.length === 0 && !draft) {
      fail(c, "MISSING_REQUIRED", "book_evidence", `${ot} 的书证据不得为空（书内事实必须绑定版本/span）`);
    }
    if (!draft && !isNonEmptyStr(data.dedup_check_ref)) {
      fail(c, "MISSING_REQUIRED", "dedup_check_ref",
        "正式语义对象必须保留查重核对引用（创建/更新核心知识必须执行 PRD §8.9）");
    }
    checkConfirmation(data, c);
  }
  if (typeof spec.post === "function") spec.post(data, c);
  return { ok: c.errors.length === 0, errors: c.errors, warnings, objectType: ot };
}

// --------------------------------------------------------------------------- //
// 水位不变式（PRD §11.5）
// --------------------------------------------------------------------------- //
/**
 * `processed_through_seq ≤ durable_through_seq ≤ observed_through_seq`
 *
 * - 三者为 null 表示尚未建立（SourceGate.unknown 阶段）；只要有一个非 null，
 *   就必须三者齐备且有序——"缺口前止步，不能因后面一条已保存跳过中间"。
 * - gate.state==='ready' 时 `requested_through_seq ≤ durable_through_seq`
 *   （ready 只证明对应 requested_range）。
 */
export function validateWatermarks(w, { field = "cursor" } = {}) {
  const c = { errors: [] };
  if (!isMap(w)) {
    return { ok: false, errors: [{ code: "INVALID_STRUCTURE", field, message: "水位记录必须是映射" }] };
  }
  const keys = ["observed_through_seq", "durable_through_seq", "processed_through_seq"];
  const vals = {};
  let anyNull = false;
  let allNull = true;
  for (const k of keys) {
    const v = w[k];
    if (v === null || v === undefined) { vals[k] = null; anyNull = true; continue; }
    allNull = false;
    if (!isInt(v) || v < 0) {
      fail(c, "INVALID_VALUE", `${field}.${k}`, `${k} 必须是非负整数或 null`);
      vals[k] = null;
      continue;
    }
    vals[k] = v;
  }
  if (anyNull && !allNull) {
    fail(c, "WATERMARK_INVARIANT_VIOLATION", field,
      "observed/durable/processed 必须同时建立或同时为 null，不得只填一部分");
  }
  if (!allNull) {
    const { observed_through_seq: o, durable_through_seq: d, processed_through_seq: p } = vals;
    if (p !== null && d !== null && p > d) {
      fail(c, "WATERMARK_INVARIANT_VIOLATION", field,
        `processed_through_seq(${p}) 不得超过 durable_through_seq(${d})：未耐久不得报已处理`);
    }
    if (d !== null && o !== null && d > o) {
      fail(c, "WATERMARK_INVARIANT_VIOLATION", field,
        `durable_through_seq(${d}) 不得超过 observed_through_seq(${o})`);
    }
  }
  const gate = w.source_gate;
  if (gate !== null && gate !== undefined) {
    if (!isMap(gate)) {
      fail(c, "INVALID_STRUCTURE", `${field}.source_gate`, "source_gate 必须是映射");
    } else {
      if (gate.state === "ready") {
        const req = gate.requested_through_seq;
        const d = vals.durable_through_seq;
        if (!isInt(req) || req < 0) {
          fail(c, "INVALID_VALUE", `${field}.source_gate.requested_through_seq`, "ready 时必须给出非负整数 requested_through_seq");
        } else if (d !== null && req > d) {
          fail(c, "WATERMARK_INVARIANT_VIOLATION", `${field}.source_gate`,
            `ready 只证明 requested_range：requested(${req}) 不得超过 durable(${d})`);
        }
      }
    }
  }
  return { ok: c.errors.length === 0, errors: c.errors };
}

// --------------------------------------------------------------------------- //
// 辅助 JSON 的白名单守卫（PRD §8.1 / §8.5）
// --------------------------------------------------------------------------- //
const CONTENT_BEARING_KEYS = new Set([
  "content", "body", "text", "message", "messages", "prompt", "prompts",
  "transcript", "chat", "conversation", "payload", "raw", "excerpt", "full_text",
]);

const STATE_KINDS = {
  cursors: {
    allowedTop: ["schema_version", "cursors", "updated_at"],
    entryRequired: ["session_id", "branch_id", "source_revision"],
  },
  deletions: {
    allowedTop: ["schema_version", "barriers", "updated_at"],
    entryRequired: ["scope_id", "at"],
  },
  // PRD §8.5：journal 只含路径、前后 hash、步骤、恢复状态；无聊天或外区主笔记全文。
  // PRD §8.7（result 映射表）：no_change 要求"耐久最小处理回执，含 check 及来源范围"，
  // 而 §8.2 的 .state/ 清单里**没有回执文件**，§11.5 又把 record_no_change 列为
  // FileTransaction 的 purpose 之一 ⇒ 回执就存在 journal 里，不新开第二份存储。
  journal: {
    allowedTop: [
      "schema_version", "id", "purpose", "state", "recovery_revision",
      "idempotency_key", "input_fingerprint", "created_at", "updated_at",
      "steps", "last_error", "receipt",
    ],
    entryRequired: ["id", "purpose", "state", "steps"],
  },
};

/**
 * no_change 回执的最小字段（PRD §8.7：「耐久最小处理回执，含 check 及来源范围」）。
 * 没有这两个字段的回执无法证明"哪个范围被处理过"，也就无法防重提同范围。
 */
export const NO_CHANGE_RECEIPT_REQUIRED = Object.freeze(["check_id", "source_range"]);

/** 回执的键集合是闭合的：多出来的字段必须报错，不能被静默丢弃。 */
export const NO_CHANGE_RECEIPT_ALLOWED_KEYS = Object.freeze(["check_id", "source_range", "outcome"]);

/**
 * 校验一个 `record_no_change` 事务的耐久回执。
 * 回执只允许最小标识：check、来源范围、outcome；正文类字段由 validateStatePayload 再拦一道。
 */
export function validateNoChangeReceipt(receipt, { key = "receipt" } = {}) {
  const errors = [];
  if (!isMap(receipt)) {
    return { ok: false, errors: [{ code: "INVALID_STRUCTURE", field: key, message: "no_change 回执必须是映射" }] };
  }
  for (const k of Object.keys(receipt)) {
    if (!NO_CHANGE_RECEIPT_ALLOWED_KEYS.includes(k)) {
      errors.push({
        code: "AUX_STATE_FORBIDDEN_KEY",
        field: `${key}.${k}`,
        message: `no_change 回执不允许字段 ${k}（只允许 ${NO_CHANGE_RECEIPT_ALLOWED_KEYS.join(" / ")}）`,
      });
    }
  }
  for (const f of NO_CHANGE_RECEIPT_REQUIRED) {
    if (!isStr(receipt[f]) || receipt[f].trim() === "") {
      errors.push({
        code: "MISSING_REQUIRED",
        field: `${key}.${f}`,
        message: `no_change 回执必须包含非空 ${f}（PRD §8.7：耐久最小处理回执，含 check 及来源范围）`,
      });
    }
  }
  if (receipt.outcome !== undefined && receipt.outcome !== null && receipt.outcome !== "no_change") {
    errors.push({ code: "INVALID_VALUE", field: `${key}.outcome`, message: "回执 outcome 只能是 no_change" });
  }
  return { ok: errors.length === 0, errors };
}

/**
 * 辅助 JSON 只存任务/进度/幂等/删除屏障/恢复元数据（PRD §8.1）。
 * 这里用白名单 + 内容字段黑名单把这句话变成可执行守卫：
 * 任何 `content/prompt/messages/...` 键、或超长字符串（疑似复录会话）都拒绝落盘。
 */
export function validateStatePayload(kind, payload, { maxStringLength = 4096 } = {}) {
  const c = { errors: [] };
  const spec = STATE_KINDS[kind];
  if (!spec) {
    return { ok: false, errors: [{ code: "INVALID_VALUE", field: "kind", message: `未知的辅助状态类型 ${kind}` }] };
  }
  if (!isMap(payload)) {
    return { ok: false, errors: [{ code: "INVALID_STRUCTURE", field: kind, message: "辅助状态必须是映射" }] };
  }
  for (const key of Object.keys(payload)) {
    if (!spec.allowedTop.includes(key)) {
      fail(c, "AUX_STATE_FORBIDDEN_KEY", key, `辅助 JSON(${kind}) 不允许顶层字段 ${key}`);
    }
  }
  const walk = (node, path) => {
    if (node === null || node === undefined) return;
    if (isStr(node)) {
      if (node.length > maxStringLength) {
        fail(c, "AUX_STATE_TOO_LARGE", path,
          `辅助状态字符串长度 ${node.length} 超过 ${maxStringLength}；疑似复录会话正文，拒绝落盘`);
      }
      return;
    }
    if (isArr(node)) { node.forEach((v, i) => walk(v, `${path}[${i}]`)); return; }
    if (isMap(node)) {
      for (const [k, v] of Object.entries(node)) {
        if (CONTENT_BEARING_KEYS.has(k.toLowerCase())) {
          fail(c, "AUX_STATE_FORBIDDEN_KEY", `${path}.${k}`,
            `辅助 JSON 不得保存知识/会话正文（字段名 ${k}）`);
          continue;
        }
        walk(v, `${path}.${k}`);
      }
    }
  };
  walk(payload, kind);
  return { ok: c.errors.length === 0, errors: c.errors };
}

/**
 * 一条 cursor 记录的完整校验：身份 + 水位不变式 + SourceGate.state 值域。
 * PRD §11.5 的 SourceGate 初始状态是 unknown；不是任务成功状态。
 *
 * 键集合是闭合的：cursor 是"辅助 JSON"，只存进度/水位/耐久证据，
 * 多出来的字段一律拒绝——这是"不写第二份聊天存储"的可执行守卫。
 */
export const CURSOR_ALLOWED_KEYS = Object.freeze([
  "session_id",
  "branch_id",
  "source_revision",
  "observed_through_seq",
  "durable_through_seq",
  "processed_through_seq",
  "durability_evidence",
  "source_gate",
]);

export function validateCursorEntry(entry, { key = "cursor" } = {}) {
  const errors = [];
  if (!isMap(entry)) {
    return { ok: false, errors: [{ code: "INVALID_STRUCTURE", field: key, message: "cursor 记录必须是映射" }] };
  }
  for (const k of Object.keys(entry)) {
    if (!CURSOR_ALLOWED_KEYS.includes(k)) {
      errors.push({
        code: "AUX_STATE_FORBIDDEN_KEY",
        field: `${key}.${k}`,
        message: `cursor 不允许字段 ${k}（辅助 JSON 只存进度/水位/耐久证据，不存知识或会话正文）`,
      });
    }
  }
  for (const k of ["session_id", "branch_id", "source_revision"]) {
    if (!isNonEmptyStr(entry[k])) {
      errors.push({ code: "MISSING_REQUIRED", field: `${key}.${k}`, message: `${k} 必须是非空字符串` });
    }
  }
  const wm = validateWatermarks(entry, { field: key });
  errors.push(...wm.errors);
  const gate = entry.source_gate;
  if (gate === null || gate === undefined) {
    errors.push({ code: "MISSING_REQUIRED", field: `${key}.source_gate`, message: "source_gate 必填（初始 state=unknown）" });
  } else if (isMap(gate)) {
    if (!VALUE_DOMAINS.source_gate_state.includes(gate.state)) {
      errors.push({
        code: "INVALID_ENUM",
        field: `${key}.source_gate.state`,
        message: `source_gate.state 只能是 ${VALUE_DOMAINS.source_gate_state.join(" / ")}`,
      });
    }
  }
  return { ok: errors.length === 0, errors };
}

/** 便捷：校验并抛错（写入路径用）。 */
export function assertValid(result, context = "schema") {
  if (result.ok) return result;
  const first = result.errors[0];
  throw new SchemaError(first.code, `${context}: ${first.message}`, { errors: result.errors });
}
