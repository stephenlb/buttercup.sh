/* ═══════════════════════════════════════════════════════════════════════════
   Sandbox — executes workspace code without letting it touch this page.

   Everything runs in a `sandbox="allow-scripts"` iframe, which has an opaque
   origin: no DOM access here, no localStorage here, no reading our API keys.
   The linking trick is that the *iframe* mints the blob: URLs for each module —
   blob URLs are origin-scoped, so ones created out here would be unreadable in
   there. The parent only ships a path → source map and waits for a verdict.
   ═══════════════════════════════════════════════════════════════════════════ */
window.Sandbox = (function () {

  /* ── code that lives inside the iframe ──────────────────────────────────── */
  // Kept as a string because it is a different realm. Must not contain the
  // literal script-close sequence, since it is injected via srcdoc.
  const RUNNER = `
const post = (msg) => parent.postMessage(Object.assign({ bc: 1 }, msg), "*");

/* Mirror console into the harness transcript. */
const LEVELS = ["log", "info", "warn", "error", "debug"];
for (const level of LEVELS) {
  const native = console[level].bind(console);
  console[level] = (...args) => {
    native(...args);
    post({ type: "log", level, text: args.map(fmt).join(" ") });
  };
}
function fmt(v) {
  if (typeof v === "string") return v;
  if (v instanceof Error) return v.stack || String(v);
  try { return JSON.stringify(v, null, 2); } catch (_) { return String(v); }
}

addEventListener("error", (e) => post({ type: "log", level: "error", text: "uncaught: " + (e.message || e) }));
addEventListener("unhandledrejection", (e) =>
  post({ type: "log", level: "error", text: "unhandled rejection: " + fmt(e.reason) }));

/* ── module linker ─────────────────────────────────────────────────────────
   Rewrites relative specifiers to blob URLs, deepest dependency first. Bare
   specifiers ("https://esm.sh/x", "react") are left alone so CDN imports work.
   ------------------------------------------------------------------------- */
const SPECIFIER = /(\\bfrom\\s*|\\bimport\\s*|\\bimport\\s*\\(\\s*)(['"\`])([^'"\`\\n]+)\\2/g;
const isRelative = (s) => s.startsWith("./") || s.startsWith("../") || s.startsWith("/");

function dirname(path) {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

function resolve(files, importer, spec) {
  const base = spec.startsWith("/") ? "" : dirname(importer);
  const parts = (base ? base.split("/") : []);
  for (const seg of spec.replace(/^\\//, "").split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  const path = parts.join("/");
  for (const candidate of [path, path + ".js", path + "/index.js", path + ".mjs"]) {
    if (candidate in files) return candidate;
  }
  throw new Error("cannot resolve '" + spec + "' from '" + importer + "'");
}

const MIME = { css: "text/css", html: "text/html", json: "application/json", svg: "image/svg+xml" };
const mimeOf = (path) => MIME[path.split(".").pop().toLowerCase()] || "text/javascript";

/**
 * Blob-URL a module and everything it imports, deepest first.
 * \`urls\` is shared across calls so a file imported twice stays one instance.
 */
function link(files, entry, urls = new Map(), stack = []) {
  if (urls.has(entry)) return urls.get(entry);
  if (stack.includes(entry)) {
    throw new Error("circular import: " + stack.concat(entry).join(" -> "));
  }
  const type = mimeOf(entry);
  let source = files[entry];
  if (type === "text/javascript") {
    stack.push(entry);
    source = source.replace(SPECIFIER, (match, lead, quote, spec) => {
      if (!isRelative(spec)) return match;
      return lead + quote + link(files, resolve(files, entry, spec), urls, stack) + quote;
    });
    stack.pop();
  }
  const url = URL.createObjectURL(new Blob([source], { type }));
  urls.set(entry, url);
  return url;
}

/* ── HTML preview ─────────────────────────────────────────────────────────── */
function mount(files, entry, inject) {
  const urls = new Map();   // one instance per workspace file, shared across refs
  const rel = (ref) => {
    try { return link(files, resolve(files, entry, ref.startsWith(".") ? ref : "./" + ref), urls); }
    catch (_) { return null; }
  };
  let html = files[entry];

  // Point <script src> / <link href> at blob URLs of the workspace copies.
  html = html.replace(/(<(?:script|link|img)\\b[^>]*?\\b(?:src|href)=)(["'])([^"']+)\\2/gi,
    (match, lead, quote, ref) => {
      if (/^(https?:|data:|blob:|#|\\/\\/)/i.test(ref)) return match;
      const url = rel(ref);
      return url ? lead + quote + url + quote : match;
    });

  // Inline module scripts import relatively too; give them blob URLs as well.
  html = html.replace(/(<script\\b[^>]*type=["']module["'][^>]*>)([\\s\\S]*?)(<\\/script)/gi,
    (match, open, body, close) => open + body.replace(SPECIFIER, (m, lead, quote, spec) => {
      if (!isRelative(spec)) return m;
      const url = rel(spec);
      return url ? lead + quote + url + quote : m;
    }) + close);

  document.open();
  document.write(html);
  document.close();

  // The written document is a new one, and the listeners of this module went
  // with the old one, so the harness scripts are appended to the page itself.
  // Added afterwards, and only ever listeners, so they cannot affect the mount.
  if (inject) {
    const script = document.createElement("script");
    script.textContent = inject;
    (document.body || document.documentElement).appendChild(script);
  }
}

/* ── job intake ────────────────────────────────────────────────────────────── */
addEventListener("message", async (event) => {
  const job = event.data;
  if (!job || job.bc !== 1) return;

  if (job.kind === "preview") {
    try { mount(job.files, job.entry, job.inject); post({ id: job.id, type: "done", ok: true }); }
    catch (err) { post({ id: job.id, type: "done", ok: false, error: String(err.message || err) }); }
    return;
  }

  try {
    let value;
    if (job.kind === "js") {
      // Wrapped so a snippet may 'return' a value and use top-level await.
      const src = "export default async function () {\\n" + job.code + "\\n}";
      const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
      const mod = await import(url);
      value = await mod.default();
    } else {
      const mod = await import(link(job.files, job.entry));
      // A default or named export called 'main' is treated as an entry point.
      const main = typeof mod.default === "function" ? mod.default
                 : typeof mod.main === "function" ? mod.main : null;
      value = main ? await main() : Object.keys(mod);
    }
    post({ id: job.id, type: "done", ok: true, value: fmt(value === undefined ? null : value) });
  } catch (err) {
    post({ id: job.id, type: "done", ok: false, error: String((err && err.stack) || err) });
  }
});

post({ type: "ready" });
`;

  const SRCDOC =
    '<!DOCTYPE html><meta charset="utf-8"><title>sandbox</title>' +
    '<script type="module">' + RUNNER + "<" + "/script>";

  let seq = 0;

  /** Spin up a throwaway iframe, run one job, tear it down. */
  function exec(job, { timeout = 15000, visible = null } = {}) {
    const id = ++seq;
    const logs = [];
    // Functions are not structured-cloneable, so the callback stays on this side.
    const { onLog, ...payload } = job;

    return new Promise((resolve) => {
      const frame = visible || document.createElement("iframe");
      let settled = false;
      let timer;

      function finish(result) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        removeEventListener("message", onMessage);
        if (!visible) frame.remove();
        resolve({ logs, ...result });
      }

      function onMessage(event) {
        const msg = event.data;
        if (!msg || msg.bc !== 1 || event.source !== frame.contentWindow) return;
        if (msg.type === "ready") {
          frame.contentWindow.postMessage({ bc: 1, id, ...payload }, "*");
          return;
        }
        // Console mirroring is set up before the job id is known, so log
        // events are unlabelled — one frame only ever runs one job.
        if (msg.type === "log") {
          logs.push({ level: msg.level, text: msg.text });
          if (onLog) onLog(msg);
          return;
        }
        if (msg.id !== id) return;
        if (msg.type === "done") finish({ ok: msg.ok, value: msg.value, error: msg.error });
      }

      addEventListener("message", onMessage);

      if (!visible) {
        frame.setAttribute("sandbox", "allow-scripts");
        frame.setAttribute("aria-hidden", "true");
        frame.setAttribute("title", "sandbox");
        frame.width = "0";
        frame.height = "0";
        frame.style.cssText = "position:absolute;left:-9999px;width:0;height:0;border:0";
        document.body.appendChild(frame);
      }
      frame.srcdoc = SRCDOC;

      timer = setTimeout(
        () => finish({ ok: false, error: `timed out after ${timeout}ms` }),
        timeout
      );
    });
  }

  /**
   * The workspace as the sandbox will see it, with the entry point resolved.
   * A missing entry is reported in the same shape a failed run uses, so the
   * caller has one result type to handle rather than a throw and a result.
   */
  function withWorkspace(entry, job, opts) {
    const files = VFS.snapshot();
    const path = VFS.norm(entry);
    if (!(path in files)) return Promise.resolve({ ok: false, error: `no such file: ${path}`, logs: [] });
    return exec({ ...job, files, entry: path }, opts);
  }

  return {
    /** Evaluate a snippet as a module body; `return` yields the reported value. */
    runJs(code, opts) {
      return exec({ kind: "js", code }, opts);
    },

    /** Run a workspace module, linking its relative imports to sibling files. */
    runModule(entry, opts) {
      return withWorkspace(entry, { kind: "module", onLog: opts && opts.onLog }, opts);
    },

    /**
     * Mount a workspace HTML file into an existing (visible) iframe element.
     * `Capture.source()` and `Drive.source()` ride along so the mounted page can
     * photograph and operate itself — the parent cannot reach into an opaque
     * origin to ask for either one later. Both are appended after the mount and
     * only ever add a message listener, so the page behaves as it would alone.
     */
    preview(entry, frame) {
      const inject = [
        window.Capture ? Capture.source() : null,
        window.Drive ? Drive.source() : null,
      ].filter(Boolean).join("\n;\n");
      return withWorkspace(entry, { kind: "preview", inject }, { visible: frame, timeout: 10000 });
    },
  };
})();
