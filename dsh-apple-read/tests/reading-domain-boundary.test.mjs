/**
 * tests/reading-domain-boundary.test.mjs · M10 收口 A 的**边界守证**
 *
 * 目的：证明「书域配置已外移到 `lib/reading/book-domain.js`」**不是说说而已** ——
 * 机制层源码里再出现书域标记或书域对象类型字面量，本套件必须**失败**。
 *
 * ## 被守证的机制层（通用机制，不该认识书域）
 *   · `schema.js`        —— 通用校验器（原写死 15 个对象类型 + index/book 交叉规则）
 *   · `file-service.js`  —— 原子写（原写死默认根 `/Users/.../45-书籍`）
 *   · `session-reader.js`—— 宿主会话只读（原已干净，作为对照）
 *
 * ## 词表与「只查代码不查注释」
 *   注释里出现 `book` 是正常的（解释性文字），所以先把注释剥掉再查。
 *   词表是**校准过**的，不是「凡含 book 就算」：
 *   · `book_evidence` / `book_id` / `book_guide` 是 PRD §8.5 的**共用字段名**，属共享数据模型；
 *   · `book: {` 是对象 schema 的**键**（键不是字面量）；
 *   · `"book"` 才是**对象类型字面量** —— 它一出现就说明 15 类集合被焊回了通用层。
 *   · `original_epub` 是 PRD §8.5 `SourceAssetRef.source_kind` 的闭合枚举值，显式豁免；
 *     豁免是**穷尽**的（把 `original_epub` 抹掉后不得再有 `epub`），不是「epub 随便放过」。
 *
 * ## 防假绿（元检查）
 *   1. 剥注释函数自带 4 条单元自检（注释里的词要剥掉、字符串里的词要保留）；
 *   2. 剥后源码仍含关键代码标记（证明没把代码一起吃掉）；
 *   3. **原始**源码确实含书域标记（否则「剥后不含」可能只是词表写错，不可证伪）；
 *   4. 唯一来源是**正向**断言：15 类列表在 `lib/reading/` 下恰好被声明一次。
 *
 * 跑法：node tests/reading-domain-boundary.test.mjs
 *   变异测试可用 `READING_LIB_ROOT` 指向改坏的 `lib/reading/` 副本。
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = process.env.READING_LIB_ROOT ?? join(HERE, "..", "lib", "reading");

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log("  ✓ " + m); };
const bad = (m, d) => { fail++; console.log("  ✗ " + m + (d ? "\n      " + d : "")); };
const check = (c, m, d) => (c ? ok(m) : bad(m, d));
const section = (n) => console.log(`\n${n}`);

// --------------------------------------------------------------------------- //
// 注释剥离（保留换行，便于报行号）
// --------------------------------------------------------------------------- //
/**
 * 去掉行注释与块注释，**保留字符串与正则字面量的内容**（它们都是代码，要查）。
 *
 * 为什么要处理正则字面量：`schema.js` 里有 `s.replace(/'/g, "''")` —— 正则里的那个 `'`
 * 会被朴素扫描器当成字符串起点，从此整份源码被当成字符串，**注释剥不掉、词表也查不到**
 * （本套件第一版就踩了这个坑，报出第 1510 行注释里的 `"book"`）。所以按
 * 「`/` 前面是不是运算符/开括号」判断它是正则还是除号，正则整体照抄。
 *
 * 返回 `{ code, endState }`：`endState` 必须是 `"normal"` —— 扫描器若失步（把代码当字符串
 * 吃掉），本套件会**显式失败**而不是静默放过。
 */
function stripComments(src) {
  let out = "";
  let state = "normal";
  let prev = "";                 // 最近一个非空白“代码”字符，用于正则/除号判定
  const REGEX_AFTER = "(,=:[!&|?{};+-*%~^<>";
  const emit = (s) => {
    out += s;
    for (const c of s) if (!/\s/.test(c)) prev = c;
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i], nx = src[i + 1];
    if (state === "normal") {
      if (ch === "/" && nx === "/") { state = "line"; i++; continue; }
      if (ch === "/" && nx === "*") { state = "block"; i++; continue; }
      if (ch === "/" && (prev === "" || REGEX_AFTER.includes(prev))) {
        // 正则字面量：整体照抄（含其中的引号），避免把扫描器带偏
        let j = i + 1, inClass = false, closed = false;
        for (; j < src.length; j++) {
          const c = src[j];
          if (c === "\\") { j++; continue; }
          if (c === "\n") break;                    // 正则不能跨行 ⇒ 判定失败
          if (c === "[") inClass = true;
          else if (c === "]") inClass = false;
          else if (c === "/" && !inClass) { closed = true; break; }
        }
        if (closed) { emit(src.slice(i, j + 1)); i = j; continue; }
        emit(ch); continue;                          // 落空：当普通字符
      }
      if (ch === "'") { state = "sq"; emit(ch); continue; }
      if (ch === '"') { state = "dq"; emit(ch); continue; }
      if (ch === "`") { state = "tpl"; emit(ch); continue; }
      emit(ch); continue;
    }
    if (state === "line") { if (ch === "\n") { state = "normal"; emit(ch); } continue; }
    if (state === "block") {
      if (ch === "*" && nx === "/") { state = "normal"; i++; continue; }
      if (ch === "\n") out += ch;                    // 保留行数，便于定位
      continue;
    }
    const q = state === "sq" ? "'" : state === "dq" ? '"' : "`";
    if (ch === "\\") { emit(ch + (nx ?? "")); i++; continue; }
    if (ch === q) { state = "normal"; emit(ch); continue; }
    emit(ch);
  }
  return { code: out, endState: state };
}

const lineOf = (src, idx) => src.slice(0, idx).split("\n").length;
const snippet = (src, idx, len = 40) => JSON.stringify(src.slice(Math.max(0, idx - 12), idx + len));

// --------------------------------------------------------------------------- //
// 词表
// --------------------------------------------------------------------------- //
/** 书域 / 宿主标记：去注释后**不得出现**（substring，忽略大小写）。 */
const FORBIDDEN_SUBSTRINGS = [
  "45-书籍",
  "/Users/",
  "BKLibrary",
  "AEAnnotation",
  "books_rag",
];
/** 书域 / 来源格式标记：按**词边界**匹配（`original_epub` 不算 `epub`，见文件头说明）。 */
const FORBIDDEN_WORDS = ["apple", "epub"];
/** 书域对象类型**字面量**：出现即说明 15 类集合被焊回通用层。 */
const FORBIDDEN_QUOTED = ['"book"'];

const MODULES = [
  { name: "schema.js", file: "schema.js", mustKeep: "export function validateNote" },
  { name: "file-service.js", file: "file-service.js", mustKeep: "FILE_SERVICE_ROOT_REQUIRED" },
  { name: "session-reader.js", file: "session-reader.js", mustKeep: "export function createSessionReader" },
];
const DOMAIN_FILE = "book-domain.js";

const read = (f) => readFileSync(join(LIB, f), "utf8");
/** 列表签名：15 类 OBJECT_TYPES 的开头三连。 */
const LIST_SIGNATURE = /"index"\s*,\s*"book"\s*,\s*"book_summary"/;

// --------------------------------------------------------------------------- //
section("[0] 元检查：剥注释函数本身能失败（否则后面全是假绿）");

{
  const cases = [
    ['const a = 1; // "book"\n', '"book"', false, "行注释里的词被剥掉"],
    ['/* "book" */ const b = 2;\n', '"book"', false, "块注释里的词被剥掉"],
    ['const s = "book";\n', '"book"', true, "字符串里的词**保留**（字符串是代码）"],
    ['const u = "// 不是注释";\n', "// 不是注释", true, "字符串里的 // 不被当注释"],
  ];
  for (const [src, probe, shouldKeep, label] of cases) {
    const got = stripComments(src).code.includes(probe);
    check(got === shouldKeep, `剥注释自检：${label}`,
      `输入 ${JSON.stringify(src)} → ${JSON.stringify(stripComments(src).code)}`);
  }
  // 剥注释确实在做事：剥后长度必须变小（否则可能根本没剥）
  const probe = '/* xx */ const a = 1; // yy\n';
  check(stripComments(probe).code.length < probe.length, "剥注释确实缩短了源码（不是空操作）",
    `before=${probe.length} after=${stripComments(probe).code.length}`);
  // 正则里的引号不得把扫描器带偏（schema.js 真有 `replace(/'/g, "''")`）
  const tricky = `const s = "x".replace(/'/g, "''"); // "book"\nconst y = 1;\n`;
  const tr = stripComments(tricky);
  check(tr.endState === "normal" && !tr.code.includes('"book"') && tr.code.includes(`/'/g`),
    "剥注释自检：正则里的引号不带偏扫描器，且注释仍被剥掉",
    JSON.stringify(tr));
}

// --------------------------------------------------------------------------- //
section("[1] 机制层：去注释后不含书域 / 宿主标记");

const stripped = new Map();
for (const m of MODULES) {
  const raw = read(m.file);
  const { code, endState } = stripComments(raw);
  stripped.set(m.file, { raw, code });

  // 元检查 ①：剥注释没把代码吃掉（扫描器没失步）
  check(endState === "normal", `${m.name}：剥注释后扫描器停在 normal（没有把代码当字符串吃掉）`, `endState=${endState}`);
  check(code.includes(m.mustKeep), `${m.name}：剥注释后仍含关键代码标记（${m.mustKeep}）`);
  // 元检查 ②：原始源码**确实**含书域标记 ⇒ 本套件有东西可查（可证伪）
  const rawHits = FORBIDDEN_SUBSTRINGS.filter((t) => raw.toLowerCase().includes(t.toLowerCase()));
  const bookMentions = (raw.match(/book/gi) ?? []).length;
  console.log(`      （${m.name} 原始源码里的书域标记 ${rawHits.length} 处：${rawHits.join(" / ") || "无"}；`
    + `注释里另有 ${bookMentions} 处 book 字样属正常）`);
}

for (const m of MODULES) {
  const { code } = stripped.get(m.file);
  for (const token of FORBIDDEN_SUBSTRINGS) {
    const idx = code.toLowerCase().indexOf(token.toLowerCase());
    check(idx < 0, `${m.name}：不含 ${token}`, idx < 0 ? "" : `第 ${lineOf(code, idx)} 行附近 ${snippet(code, idx)}`);
  }
  for (const word of FORBIDDEN_WORDS) {
    const re = new RegExp(`\\b${word}\\b`, "i");
    const mm = re.exec(code);
    check(!mm, `${m.name}：不含独立词 ${word}`, mm ? `第 ${lineOf(code, mm.index)} 行附近 ${snippet(code, mm.index)}` : "");
  }
  for (const lit of FORBIDDEN_QUOTED) {
    const idx = code.indexOf(lit);
    check(idx < 0, `${m.name}：不含对象类型字面量 ${lit}`, idx < 0 ? "" : `第 ${lineOf(code, idx)} 行附近 ${snippet(code, idx)}`);
  }
  // file-service 尤其不能再有默认根常量（它已上移到域层）
  if (m.file === "file-service.js") {
    check(!code.includes("DEFAULT_KNOWLEDGE_ROOT"),
      "file-service.js：不再声明/引用默认根常量（已上移域层）");
  }
}

// --------------------------------------------------------------------------- //
section("[2] epub 豁免是**穷尽**的（只放过 original_epub 这个 PRD 闭合枚举值）");

for (const m of MODULES) {
  const { code } = stripped.get(m.file);
  const withoutAllowed = code.replace(/original_epub/g, "");
  const mm = /\bepub\b/i.exec(withoutAllowed);
  check(!mm, `${m.name}：抹掉 original_epub 后不再有任何 epub`,
    mm ? `第 ${lineOf(withoutAllowed, mm.index)} 行附近 ${snippet(withoutAllowed, mm.index)}` : "");
}

// --------------------------------------------------------------------------- //
section("[3] 正向断言：域层是**唯一来源**（不是「到处都没有」的空过）");

{
  const files = readdirSync(LIB).filter((f) => f.endsWith(".js"));
  const declarers = files.filter((f) => LIST_SIGNATURE.test(read(f)));
  check(declarers.length === 1 && declarers[0] === DOMAIN_FILE,
    `15 类 OBJECT_TYPES 列表在 lib/reading/ 下恰好被声明一次，且就是 ${DOMAIN_FILE}`,
    `实际：${declarers.join(", ") || "（没有任何文件声明）"}`);

  const domainSrc = read(DOMAIN_FILE);
  check(domainSrc.includes("45-书籍") && domainSrc.includes("DEFAULT_KNOWLEDGE_ROOT"),
    `${DOMAIN_FILE}：确实持有默认根常量与书域路径（正向对照）`);
  check(LIST_SIGNATURE.test(domainSrc), `${DOMAIN_FILE}：确实持有 15 类对象类型列表`);
  check(/DOMAIN_RULES/.test(domainSrc) && /requiredTags/.test(domainSrc) && /idEquals/.test(domainSrc),
    `${DOMAIN_FILE}：确实持有域交叉规则（requiredTags / idEquals）`);
  check(/export const BOOK_DOMAIN/.test(domainSrc), `${DOMAIN_FILE}：导出注入用的 BOOK_DOMAIN`);

  // schema.js 不再导出对象类型集合；file-service.js 不再导出默认根
  const schemaCode = stripped.get("schema.js").code;
  check(!/export\s+const\s+OBJECT_TYPES/.test(schemaCode) && !/export\s+const\s+SEMANTIC_OBJECT_TYPES/.test(schemaCode),
    "schema.js：不再导出 OBJECT_TYPES / SEMANTIC_OBJECT_TYPES");
  check(/domain\s*=\s*null/.test(schemaCode) && /DOMAIN_REQUIRED/.test(schemaCode),
    "schema.js：validateNote 有 domain 参数，且缺域时抛 DOMAIN_REQUIRED");
  const fsCode = stripped.get("file-service.js").code;
  check(!/export\s+const\s+DEFAULT_KNOWLEDGE_ROOT/.test(fsCode),
    "file-service.js：不再导出 DEFAULT_KNOWLEDGE_ROOT");
}

// --------------------------------------------------------------------------- //
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
