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

   It also writes docs/sitemap.xml, read off the links in lessons/index.html —
   see the sitemap section at the foot of this file.

   The lesson documents get the same treatment, one level down: lessons/ is the
   source, docs/lessons/ the artefact, and every <script src> in a post is
   inlined into it — so no page on the site loads a separate .js file, and
   announce.js exists once, in js/, for the harness and the lessons alike. Their
   shared stylesheet stays a linked file: six copies of one 58 kB sheet is worse
   for a reader working through the course than one cached request.

   docs/index.html, docs/lessons/, docs/sitemap.xml and docs/.nojekyll are
   written. The rest of docs/ — robots.txt, CNAME, updates/ and whatever comes
   later — is hand-written and left alone.
   ═══════════════════════════════════════════════════════════════════════════ */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, rmSync } from "node:fs";
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

// Blank runs left behind by the stripped comments, closed up — except inside a
// <pre>, where a blank line is content: a lesson's code samples space themselves
// with them, and collapsing those would reflow published listings.
const squeezeBlankLines = (html) =>
  html.split(/(<pre[\s\S]*?<\/pre>)/i)
    .map((part, i) => (i % 2 ? part : part.replace(/\n{3,}/g, "\n\n")))
    .join("");

/* ── assemble ────────────────────────────────────────────────────────────── */

const inlineSafe = (code, tag) =>
  code.replace(new RegExp(`</(?=${tag})`, "gi"), "<\\/");

// Replacements go through a function: the bundle contains `$&` (a regex escape
// in js/vfs.js), and String.replace would expand that into the matched tag.
const swap = (haystack, needle, text) => haystack.replace(needle, () => text);

const die = (msg) => { console.error(`build: ${msg}`); process.exit(1); };

/* Fold one page's assets into it.

   `src` is repo-relative; the paths inside it are page-relative, exactly as the
   browser reads them, so the same file works opened from disk and inlined here.
   Scripts always come in — that is the point of the bundle. Stylesheets only
   when `inlineCss` is set: the harness has one page and inlines its CSS, while
   the lessons share one 58 kB sheet across every post and are better served by
   one cached file than by six copies of it.

   Returns { html, refs } — refs for the size report at the foot of the build. */
function bundle(src, { inlineCss = false } = {}) {
  const base = dirname(src);                     // "" for a page at the root
  const resolve = (ref) => (base === "." ? ref : join(base, ref));

  // Comments go before anything is inlined: `<!--` inside an inlined string
  // would otherwise be read as the start of an HTML comment.
  let html = stripHtmlComments(read(src));

  const cssRefs = [...html.matchAll(/<link\b[^>]*href="([^"]+\.css)"[^>]*>/gi)];
  const jsRefs = [...html.matchAll(/<script\b[^>]*src="([^"]+\.js)"[^>]*><\/script>\s*/gi)];
  if (!jsRefs.length || (inlineCss && !cssRefs.length))
    die(`${src} no longer references css/js the way this script expects`);

  const scripts = jsRefs.map((m) => {
    const path = resolve(m[1]);
    const code = stripJs(read(path));
    try {
      new vm.Script(code, { filename: path });   // fail the build, not the page
    } catch (err) {
      die(`minified ${path} does not parse — ${err.message}`);
    }
    return `/* ${path} */\n${code}`;
  }).join("\n;\n");

  // The first <script src> becomes the whole bundle; later ones vanish.
  html = swap(html, jsRefs[0][0], `<script>\n${inlineSafe(scripts, "script")}\n</script>\n`);
  for (const ref of jsRefs.slice(1)) html = swap(html, ref[0], "");

  if (inlineCss) {
    const css = cssRefs.map((m) => stripCss(read(resolve(m[1])))).join("");
    html = swap(html, cssRefs[0][0], `<style>${inlineSafe(css, "style")}</style>`);
    for (const ref of cssRefs.slice(1)) html = swap(html, ref[0], "");
  }

  const refs = [...jsRefs, ...(inlineCss ? cssRefs : [])].map((m) => resolve(m[1]));
  return { html: squeezeBlankLines(html), refs };
}

mkdirSync(OUT_DIR, { recursive: true });

const harness = bundle("index.html", { inlineCss: true });
writeFileSync(join(OUT_DIR, "index.html"), harness.html);
writeFileSync(join(OUT_DIR, ".nojekyll"), "");   // Pages: serve the file as-is

/* ── lessons ─────────────────────────────────────────────────────────────────
   lessons/ is the source; docs/lessons/ is the artefact. Each document gets its
   scripts inlined the same way the harness does, so a lesson page is one
   request and there is no second copy of announce.js to keep in step — the
   pages point at js/announce.js, the same file the harness loads.

   Everything in the directory is accounted for: .html is bundled, .js is
   already inside those bundles, .css is minified across, and anything else
   (an image, say) is copied through untouched.
   ------------------------------------------------------------------------- */

const LESSONS_SRC = join(ROOT, "lessons");
const LESSONS_OUT = join(OUT_DIR, "lessons");
mkdirSync(LESSONS_OUT, { recursive: true });

const lessonEntries = readdirSync(LESSONS_SRC, { withFileTypes: true });
// A subdirectory would be silently left out of the artefact, so say so instead.
for (const entry of lessonEntries)
  if (!entry.isFile()) die(`lessons/${entry.name} is not a file — teach this script how to publish it`);

const lessonFiles = lessonEntries.map((e) => e.name);
const lessonPages = [];
const lessonScripts = new Set();

for (const file of lessonFiles) {
  const out = join(LESSONS_OUT, file);
  if (file.endsWith(".html")) {
    const { html, refs } = bundle(`lessons/${file}`);
    writeFileSync(out, html);
    lessonPages.push(file);
    for (const ref of refs) lessonScripts.add(ref);
  } else if (file.endsWith(".js")) {
    continue;                                    // inlined into the pages above
  } else if (file.endsWith(".css")) {
    writeFileSync(out, stripCss(read(`lessons/${file}`)));
  } else {
    copyFileSync(join(LESSONS_SRC, file), out);
  }
}

// A lesson script that was inlined this build may still be sitting in docs/ from
// a build that copied it; serving a stale second copy is worse than not serving
// one, so anything docs/lessons/ has that lessons/ does not is removed.
for (const file of readdirSync(LESSONS_OUT)) {
  if (!lessonFiles.includes(file) || file.endsWith(".js")) rmSync(join(LESSONS_OUT, file), { recursive: true });
}

/* ── sitemap ─────────────────────────────────────────────────────────────────
   The archive index is the source of truth for what is published: a post that
   is written but not launched yet sits in lessons/ with its <li> HTML-
   commented out, so stripping comments first and then reading the links out
   gives exactly the live set. Write a post, link it, and it appears here — no
   second list to remember.

   Absolute apex URLs only. www and http both 301 to buttercup.sh, and a
   redirecting URL in a sitemap is reported as a crawl error rather than
   followed. lastmod comes from the filename's date prefix, which is stable
   across rebuilds — mtimes are not, and a sitemap whose lastmod moves on every
   build teaches Google to ignore the field.
   ------------------------------------------------------------------------- */

const SITE = "https://buttercup.sh";
const POST_HREF = /href="((\d{4})-(\d{2})-(\d{2})-[^"/]+\.html)"/g;
const xml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const archive = stripHtmlComments(read("lessons/index.html"));
const posts = [...archive.matchAll(POST_HREF)]
  .map((m) => ({ file: m[1], date: `${m[2]}-${m[3]}-${m[4]}` }))
  // The same post is linked from the list and sometimes from the prose above it.
  .filter((p, i, all) => all.findIndex((q) => q.file === p.file) === i)
  .sort((a, b) => b.date.localeCompare(a.date));

if (!posts.length) {
  console.error("build: found no published posts in lessons/index.html — has the link markup changed?");
  process.exit(1);
}
for (const { file } of posts) {
  try {
    read(`lessons/${file}`);
  } catch {
    console.error(`build: lessons/index.html links ${file}, which does not exist`);
    process.exit(1);
  }
}

// No <changefreq> or <priority>: Google ignores both, and an ignored field that
// has to be kept in step with reality is a liability.
const entries = [
  { loc: `${SITE}/` },
  { loc: `${SITE}/lessons/`, lastmod: posts[0].date },
  ...posts.map(({ file, date }) => ({ loc: `${SITE}/lessons/${file}`, lastmod: date })),
];

const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<!-- Generated by build.mjs from the links in lessons/index.html. Do not edit. -->
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.map(({ loc, lastmod }) => [
  "  <url>",
  `    <loc>${xml(loc)}</loc>`,
  ...(lastmod ? [`    <lastmod>${lastmod}</lastmod>`] : []),
  "  </url>",
].join("\n")).join("\n")}
</urlset>
`;
writeFileSync(join(OUT_DIR, "sitemap.xml"), sitemap);

const sourceBytes = harness.refs.reduce((n, ref) => n + read(ref).length, read("index.html").length);
const kb = (n) => (n / 1024).toFixed(1) + " kB";
console.log(`docs/index.html  ${kb(harness.html.length)}  (${kb(gzipSync(harness.html).length)} gzipped)`);
console.log(`sources            ${kb(sourceBytes)} across ${harness.refs.length + 1} files`);
console.log(`inlined            ${harness.refs.join(", ")}`);
console.log(`docs/lessons/      ${lessonPages.length} pages, scripts inlined (${[...lessonScripts].join(", ")})`);
console.log(`docs/sitemap.xml   ${entries.length} URLs (${posts.length} published posts)`);
