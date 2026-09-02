#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
   build — fold the harness into one file: docs/index.html.

     node build.mjs

   The source stays a set of readable text files; this produces the artefact
   GitHub Pages serves. No dependencies, because adding a bundler to a project
   whose whole point is "no build step" would be a strange trade.

   What it does: reads index.html, follows its own <link>/<script src> order,
   minifies each asset (comments out, indentation out — never renames anything,
   so a stack trace still means something), inlines them, and syntax-checks
   every minified script before emitting. A corrupted bundle fails the build
   instead of shipping.

   Only index.html and .nojekyll are written. Everything else already in docs/
   — the plain documents (updates/, CNAME, and whatever comes later) that are
   served alongside the harness but are not part of it — is left alone; those
   files are edited in place, not generated.
   ═══════════════════════════════════════════════════════════════════════════ */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import vm from "node:vm";

const ROOT = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(ROOT, "docs");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

/* ── JavaScript: a string/regex/template-aware comment stripper ──────────────
   Everything hard about minifying JS with regexes is telling code from data.
   So this walks the source once, copying string, template and regex literals
   through untouched, and only drops what is provably a comment.
   ------------------------------------------------------------------------- */

const REGEX_OK_BEFORE = new Set([..."(,=:[!&|?{};+-*%~^<>", ""]);
const REGEX_OK_KEYWORD = /\b(?:return|typeof|instanceof|case|in|of|new|delete|void|do|else|yield|await)$/;

function endOfString(src, i, quote) {
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === "\\") { j++; continue; }
    if (src[j] === quote || src[j] === "\n") return j + 1;
  }
  return src.length;
}

/** Index just past a template literal, including any `${ … }` substitutions. */
function endOfTemplate(src, i) {
  let j = i + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === "\\") { j += 2; continue; }
    if (c === "`") return j + 1;
    if (c === "$" && src[j + 1] === "{") { j = endOfBraces(src, j + 2); continue; }
    j++;
  }
  return j;
}

/** Index just past the `}` matching an already-consumed `{`. */
function endOfBraces(src, j) {
  let depth = 1;
  while (j < src.length && depth > 0) {
    const c = src[j], d = src[j + 1];
    if (c === "'" || c === '"') { j = endOfString(src, j, c); continue; }
    if (c === "`") { j = endOfTemplate(src, j); continue; }
    if (c === "/" && d === "/") { while (j < src.length && src[j] !== "\n") j++; continue; }
    if (c === "/" && d === "*") { j += 2; while (j < src.length && !(src[j] === "*" && src[j + 1] === "/")) j++; j += 2; continue; }
    if (c === "{") depth++;
    else if (c === "}") depth--;
    j++;
  }
  return j;
}

function endOfRegex(src, i) {
  let inClass = false;
  for (let j = i + 1; j < src.length; j++) {
    const c = src[j];
    if (c === "\\") { j++; continue; }
    if (c === "\n") return -1;                 // not a regex after all
    if (inClass) { if (c === "]") inClass = false; continue; }
    if (c === "[") inClass = true;
    else if (c === "/") {
      let k = j + 1;
      while (k < src.length && /[a-z]/i.test(src[k])) k++;
      return k;
    }
  }
  return -1;
}

function stripJs(src) {
  // Code and literals are collected separately: whitespace in code is just a
  // separator, but whitespace inside a template literal is content — the
  // scaffolds in js/frameworks.js are template literals, and squeezing those
  // would ship the agent's generated files with their indentation removed.
  const pieces = [];                            // { code: boolean, text }
  let code = "";
  let prev = "";                                // last non-whitespace char kept
  const flush = () => { if (code) { pieces.push({ code: true, text: code }); code = ""; } };

  for (let i = 0; i < src.length;) {
    const c = src[i], d = src[i + 1];
    if (c === "/" && d === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && d === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      code += " ";
      continue;
    }
    let end = -1;
    if (c === "'" || c === '"') end = endOfString(src, i, c);
    else if (c === "`") end = endOfTemplate(src, i);
    else if (c === "/" && (REGEX_OK_BEFORE.has(prev) || REGEX_OK_KEYWORD.test(code))) end = endOfRegex(src, i);
    if (end > i) {
      flush();
      pieces.push({ code: false, text: src.slice(i, end) });
      prev = src[end - 1];
      i = end;
      continue;
    }
    code += c;
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  flush();

  // Lines, not one long line: automatic semicolon insertion makes joining
  // lines a correctness question, and gzip already collapses the newlines.
  return pieces.map(({ code: isCode, text }) => isCode
    ? text.replace(/[ \t]+/g, " ").replace(/[ \t]*\n[ \t]*/g, "\n").replace(/\n{2,}/g, "\n")
    : text).join("");
}

/* ── CSS: comments out, whitespace collapsed ─────────────────────────────── */

function stripCss(src) {
  let out = "";
  for (let i = 0; i < src.length;) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") { const end = endOfString(src, i, c); out += src.slice(i, end); i = end; continue; }
    out += c;
    i++;
  }
  return out
    .replace(/\s+/g, " ")
    .replace(/\s*([{};,>])\s*/g, "$1")
    .replace(/([:])\s+/g, "$1")
    .replace(/;}/g, "}")
    .trim();
}

/* ── HTML: drop the comments, keep every byte of <pre> ───────────────────── */

const stripHtmlComments = (html) => html.replace(/<!--[\s\S]*?-->/g, "");

/* ── assemble ────────────────────────────────────────────────────────────── */

const inlineSafe = (code, tag) =>
  code.replace(new RegExp(`</(?=${tag})`, "gi"), "<\\/");

// Comments go before anything is inlined: `<!--` inside an inlined string
// would otherwise be read as the start of an HTML comment.
let html = stripHtmlComments(read("index.html"));

const cssRefs = [...html.matchAll(/<link\b[^>]*href="([^"]+\.css)"[^>]*>/gi)];
const jsRefs = [...html.matchAll(/<script\b[^>]*src="([^"]+\.js)"[^>]*><\/script>\s*/gi)];
if (!cssRefs.length || !jsRefs.length) {
  console.error("build: index.html no longer references css/js the way this script expects");
  process.exit(1);
}

const css = cssRefs.map((m) => stripCss(read(m[1]))).join("");
const scripts = jsRefs.map((m) => {
  const code = stripJs(read(m[1]));
  try {
    new vm.Script(code, { filename: m[1] });     // fail the build, not the page
  } catch (err) {
    console.error(`build: minified ${m[1]} does not parse — ${err.message}`);
    process.exit(1);
  }
  return `/* ${m[1]} */\n${code}`;
}).join("\n;\n");

// Replacements go through a function: the bundle contains `$&` (a regex escape
// in js/vfs.js), and String.replace would expand that into the matched tag.
const swap = (haystack, needle, text) => haystack.replace(needle, () => text);

// The first stylesheet ref becomes the inline <style>; later ones vanish.
html = swap(html, cssRefs[0][0], `<style>${inlineSafe(css, "style")}</style>`);
for (const ref of cssRefs.slice(1)) html = swap(html, ref[0], "");
// Likewise the first <script src> becomes the whole bundle.
html = swap(html, jsRefs[0][0], `<script>\n${inlineSafe(scripts, "script")}\n</script>\n`);
for (const ref of jsRefs.slice(1)) html = swap(html, ref[0], "");

html = html.replace(/\n{3,}/g, "\n\n");

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, "index.html"), html);
writeFileSync(join(OUT_DIR, ".nojekyll"), "");   // Pages: serve the file as-is

const sourceBytes = [...cssRefs, ...jsRefs].reduce((n, m) => n + read(m[1]).length, read("index.html").length);
const kb = (n) => (n / 1024).toFixed(1) + " kB";
console.log(`docs/index.html  ${kb(html.length)}  (${kb(gzipSync(html).length)} gzipped)`);
console.log(`sources            ${kb(sourceBytes)} across ${cssRefs.length + jsRefs.length + 1} files`);
console.log(`inlined            ${jsRefs.map((m) => m[1]).join(", ")}`);
