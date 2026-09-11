/* ═══════════════════════════════════════════════════════════════════════════
   LiveCodes — a compiler and a share link, borrowed from livecodes.io.

   The sandbox in js/sandbox.js runs plain ES modules, so a `.jsx`, `.vue`,
   `.svelte`, `.scss` or `.py` file in the workspace is text the agent cannot
   execute. LiveCodes compiles all of those, client-side, in a headless
   playground: this module hands it three editors' worth of source, takes back
   `code.result` — one self-contained HTML page — and writes that into the
   workspace. The page then mounts in *our* own iframe, so `screenshot` and
   `navigate` keep working. An embedded LiveCodes preview would not: its iframe
   is cross-origin, and the agent cannot inject its eyes and hands into a
   document it cannot reach.

   The second half is the share link, and it is not the same kind of thing at
   all: a URL with the project compressed into its *fragment*, which browsers
   never send to a server. Opening it loads the app, and the app reads the code
   out of the fragment in the reader's own tab. The SDK exports a function for
   this, but it is a compressor and a `new URL` — so it is written out below
   instead of imported, and `playground_url` costs nothing, asks nobody, and
   touches no network. It is on like any other tool.

   The compiler is the part that reaches the network: the SDK comes from a CDN
   and the headless playground from livecodes.io. The SDK is the sharp end of
   that, because it runs on *this* origin, where the keys are — so it is pinned
   to a version and to a SHA-256 of that version's file, fetched, checked, and
   only then executed, from the verified bytes themselves. `load()` explains what
   that does and does not cover.

   With the file pinned, the compiler is on by default. The checkbox in the KEYS
   panel switches it off for a session that must make no network request at all;
   while it is off, `compile` is withheld from the model rather than failing
   after it calls it.
   ═══════════════════════════════════════════════════════════════════════════ */
window.LiveCodes = (function () {

  /* Pinned, not floating on latest: a playground that compiles differently
     tomorrow than it did today is a bug report nobody can reproduce. */
  const VERSION = "0.14.1";
  const SDK = `https://cdn.jsdelivr.net/npm/livecodes@${VERSION}/livecodes.js`;

  /* SHA-256 of livecodes@0.14.1/livecodes.js as published to npm — the file
     inside the tarball whose own integrity the registry publishes, not merely
     what a CDN served one afternoon. `load()` below refuses to execute anything
     else, which is what makes this a decision about one file rather than a
     standing trust in a CDN. To move the pin, bump VERSION and put the new
     digest here:

       curl -sL https://cdn.jsdelivr.net/npm/livecodes@<v>/livecodes.js | shasum -a 256

     Cross-check it against `npm view livecodes@<v> dist.integrity` before you
     believe it. */
  const SDK_HASH = "f3e0ea6119cf0b3280a32e5666d1e0eca3802d909433d3fce4650429a1a71674";

  /* ── the switch, which covers the compiler only ──────────────────────────── */

  let allowed = true;                      // set from settings by js/main.js

  const OFF_REASON =
    "the LiveCodes compiler has been switched off. It compiles in the browser, " +
    "but it fetches the SDK from a CDN and the playground from livecodes.io, and " +
    "this session is set to make no such request. Tick 'use LiveCodes compiler' " +
    "in the KEYS panel, or type /livecodes on, to allow it. `playground_url` is " +
    "unaffected: it builds its link here, offline.";

  /* ── which editor a file belongs in ───────────────────────────────────────
     A playground is three editors — markup, style, script — so a file's
     extension has to answer both "which slot" and "which language". The
     LiveCodes language ids are the extensions themselves for everything below,
     which is why this is a membership list rather than a mapping. The full set
     is 90+ languages; these are the ones with an extension a person would
     actually write. `language` overrides the guess when a file is named
     something else.
     ─────────────────────────────────────────────────────────────────────────── */
  const SLOTS = {
    markup: `html htm md markdown mdx astro pug haml adoc asciidoc mustache hbs
             handlebars ejs njk nunjucks liquid twig mjml xml`,
    style: `css scss sass less styl stylus postcss`,
    script: `js mjs jsx ts mts tsx vue svelte coffee civet imba as py r rb go php
             cpp c h hpp java cs pl lua jl scm clj cljs gleam swift res ml tcl
             wat sql sqlite pgsql json`,
  };

  const EXT = {};                          // extension → slot
  for (const [slot, list] of Object.entries(SLOTS)) {
    for (const ext of list.split(/\s+/).filter(Boolean)) EXT[ext] = slot;
  }

  const extOf = (path) => path.split("/").pop().split(".").pop().toLowerCase();

  /** Every extension this module recognises, for an error worth reading. */
  function known(slot) {
    return Object.keys(EXT).filter((e) => !slot || EXT[e] === slot).sort().join(" ");
  }

  /* ── config assembly ────────────────────────────────────────────────────── */

  /**
   * Workspace paths → a LiveCodes config. Each slot is optional; the language
   * comes from the extension unless `languages[slot]` says otherwise, because
   * this cannot know that a file called `main.txt` holds Python.
   *
   * @param {{markup?:string, style?:string, script?:string, title?:string,
   *          languages?:Record<string,string>}} spec
   */
  function configFor(spec = {}) {
    const languages = spec.languages || {};
    const config = { title: spec.title || Workspaces.active().name };
    let filled = 0;

    for (const slot of ["markup", "style", "script"]) {
      const ref = spec[slot];
      if (!ref) continue;
      const path = VFS.norm(ref);
      const content = VFS.read(path);       // throws for a missing file
      const ext = extOf(path);
      // Every extension in SLOTS is also its LiveCodes language id, so a known
      // extension *is* the language — the table only has to say which slot.
      const language = languages[slot] || (EXT[ext] ? ext : "");
      if (!language) {
        throw new Error(
          `cannot tell what language ${path} is. Pass ${slot}_language, or rename it ` +
          `to one of: ${known(slot)}`
        );
      }
      // A file in the wrong slot compiles to nothing and reports no error, so
      // say so here instead of handing back a blank page.
      if (EXT[ext] && EXT[ext] !== slot && !languages[slot]) {
        throw new Error(`${path} is a ${EXT[ext]} file, not ${slot} — pass it as ${EXT[ext]} instead`);
      }
      config[slot] = { language, content };
      filled++;
    }

    if (!filled) throw new Error("give at least one of markup, style or script");
    return config;
  }

  /* ── the SDK ────────────────────────────────────────────────────────────── */

  let loading = null;                       // memoized load promise

  async function sdk() {
    if (!allowed) throw new Error(OFF_REASON);
    if (!loading) {
      // A failed load is not cached: the next call should retry rather than
      // repeat a network error the user has since fixed.
      loading = load().catch((err) => { loading = null; throw err; });
    }
    return loading;
  }

  const hex = (buffer) =>
    [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");

  /**
   * Fetch the SDK, check it against `SDK_HASH`, and only then run it.
   *
   * `import(SDK)` would have been one line, but it is one line that says "any
   * code this CDN serves may run on the origin holding the user's API keys".
   * Fetching first turns that into "this exact file may run": the bytes are
   * hashed, and the *same* bytes are what execute — hence the blob, since a
   * second request to the network could answer differently.
   *
   * What this does not cover, and cannot: the playground the SDK then loads
   * from livecodes.io. That runs in an iframe on its own origin, where it can
   * neither read this page nor reach `localStorage` — the browser is the
   * boundary there, so a checksum is not the tool for it.
   */
  async function load() {
    if (!(window.crypto && crypto.subtle)) {
      throw new Error(
        "the SDK can only be verified with crypto.subtle, which browsers offer " +
        "on a secure context only — serve the harness from http://localhost or " +
        "https instead of file://, or leave the compiler switched off"
      );
    }

    let bytes;
    try {
      // `force-cache`: the URL is immutable, so a second session should not
      // re-fetch it — and the digest is checked either way.
      const res = await fetch(SDK, { credentials: "omit", cache: "force-cache" });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      bytes = await res.arrayBuffer();
    } catch (err) {
      throw new Error(`could not fetch the LiveCodes SDK from ${SDK} — ${err.message || err}`);
    }

    const digest = hex(await crypto.subtle.digest("SHA-256", bytes));
    if (digest !== SDK_HASH) {
      throw new Error(
        `refusing to run the LiveCodes SDK: ${SDK} does not match the checksum ` +
        `pinned in js/livecodes.js.\n  expected sha256 ${SDK_HASH}\n  received sha256 ${digest}\n` +
        `A pinned version's bytes do not change, so this is a proxy rewriting the ` +
        `response, a corrupted download, or something worse. Nothing was executed.`
      );
    }

    const url = URL.createObjectURL(new Blob([bytes], { type: "text/javascript" }));
    try {
      return await import(url);
    } catch (err) {
      throw new Error(`the LiveCodes SDK failed to load — ${err.message || err}`);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /** Reject rather than hang: a compiler that never answers is still a failure. */
  function within(promise, ms, what) {
    let timer;
    return Promise.race([
      promise.finally(() => clearTimeout(timer)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
      }),
    ]);
  }

  /* ── compile ────────────────────────────────────────────────────────────── */

  /**
   * Compile one project headlessly and return LiveCodes' `Code` object:
   * `{ markup, style, script, result }`, where each editor carries
   * `{ language, content, compiled }` and `result` is the whole result page.
   *
   * `autoupdate: false` keeps the headless playground from *running* the page it
   * built — we only want the HTML, and running it there would execute the
   * project twice, once in a frame nobody is looking at.
   */
  async function compile(spec, { timeout = 30000 } = {}) {
    const { createPlayground } = await sdk();
    const config = { ...configFor(spec), autoupdate: false };

    /* The playground lives in an iframe on this page, so it needs a host
       element. Passing our own rather than letting the SDK mint one is what
       makes the cleanup below complete: `destroy()` releases the playground,
       and this takes the hole it sat in with it.

       Hidden with `visibility`, and inside the viewport. The way the rest of
       this harness parks an invisible iframe — `left:-9999px` — never finishes
       loading here: an offscreen lazily-loaded iframe is one the browser is
       entitled to never fetch, and the playground would sit there compiling
       nothing until the timeout. */
    const host = document.createElement("div");
    host.setAttribute("aria-hidden", "true");
    host.dataset.defaultStyles = "false";       // the app styles its own container
    host.style.cssText =
      "position:absolute;top:0;left:0;width:1024px;height:768px;" +
      "visibility:hidden;opacity:0;pointer-events:none";
    document.body.appendChild(host);

    let playground = null;
    try {
      playground = await within(
        createPlayground(host, { headless: true, config }), timeout, "loading the headless playground"
      );
      const code = await within(playground.getCode(), timeout, "compiling");
      if (!code || !code.result) throw new Error("LiveCodes returned no result page");
      return { code, config };
    } finally {
      // One app instance per compile, none of them left behind: a session that
      // compiles twenty times must not be hosting twenty playgrounds.
      if (playground) { try { await playground.destroy(); } catch (_) { /* already gone */ } }
      host.remove();
    }
  }

  /* ── share link ───────────────────────────────────────────────────────────
     Everything below is what the SDK's `getPlaygroundUrl` does, written out so
     that a link needs no network and no permission. Two pieces: lz-string's
     `compressToEncodedURIComponent`, and a `new URL`.

     The compressor is LZW over the string, codes written least-significant bit
     first into 6-bit characters of the URL-safe alphabet. Rewritten around a
     single bit-writer from the original — lz-string, MIT, © 2013 pieroxy,
     github.com/pieroxy/lz-string — and checked byte-for-byte against the SDK's
     own output, since the whole point is that the app on the other end can read
     it back. Chars are UTF-16 code units, not code points: a surrogate pair
     compresses as its two halves, which is what the decompressor expects.
     ─────────────────────────────────────────────────────────────────────────── */

  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+-$";
  const BITS = 6;                            // bits carried by one output char

  function compress(input) {
    if (input == null) return "";
    const out = [];
    let acc = 0, used = 0;

    /** The `n` low bits of `value`, least significant first. */
    const write = (value, n) => {
      for (let i = 0; i < n; i++) {
        acc = (acc << 1) | (value & 1);
        value >>= 1;
        if (used === BITS - 1) { out.push(ALPHABET[acc]); acc = 0; used = 0; }
        else used++;
      }
    };

    const dict = new Map();                  // string seen before → its code
    const fresh = new Set();                 // in the dictionary, not yet on the wire
    let size = 3;                            // 0, 1 and 2 are the three markers
    let bits = 2;                            // width of a code right now
    let room = 2;                            // codes left before that width grows
    let w = "";

    const grow = () => { if (--room === 0) { room = 2 ** bits; bits++; } };

    /** Put `w` on the wire: its code, or the character itself the first time. */
    const emit = (w) => {
      if (fresh.has(w)) {
        // Marker 0 then eight bits for a byte, marker 1 then sixteen for the
        // rest — the decompressor learns the character here.
        const code = w.charCodeAt(0);
        if (code < 256) { write(0, bits); write(code, 8); }
        else { write(1, bits); write(code, 16); }
        grow();
        fresh.delete(w);
      } else {
        write(dict.get(w), bits);
      }
      grow();
    };

    for (let i = 0; i < input.length; i++) {
      const c = input.charAt(i);
      if (!dict.has(c)) { dict.set(c, size++); fresh.add(c); }
      const wc = w + c;
      if (dict.has(wc)) { w = wc; continue; }
      emit(w);
      dict.set(wc, size++);                  // the new pair, for next time
      w = c;
    }

    if (w !== "") emit(w);
    write(2, bits);                          // marker 2: end of stream

    // Pad the part-filled last character with zeros; anything shorter than a
    // whole character would decode as a truncated code.
    for (;;) {
      acc = acc << 1;
      if (used === BITS - 1) { out.push(ALPHABET[acc]); break; }
      used++;
    }
    return out.join("");
  }

  const APP = "https://livecodes.io";

  /**
   * A playground URL carrying the project in its fragment. Synchronous, local,
   * and available whether or not the compiler is switched on.
   */
  function url(spec, { appUrl } = {}) {
    const config = configFor(spec);
    let target;
    try { target = new URL(appUrl || APP); }
    catch (_) { throw new Error(`app_url '${appUrl}' is not a valid URL`); }

    // Query carries what the app can use before it has unpacked anything — the
    // title, for the tab. The fragment carries the project, and a fragment is
    // the one part of a URL a browser keeps to itself.
    // ("Untitled Project" is the app's own default, and the SDK leaves it out —
    // matched here so a link from this file is the link the SDK would build.)
    if (config.title && config.title !== "Untitled Project") {
      target.searchParams.set("title", config.title);
    }
    const fragment = new URLSearchParams();
    fragment.set("config", "code/" + compress(JSON.stringify(config)));
    target.hash = fragment.toString();

    return { url: target.href, config };
  }

  return {
    version: VERSION,

    enabled: () => allowed,
    /** "" when `compile` may be used, else why it may not — see js/tools.js.
        Only the compiler is gated; `url` below is local and always allowed. */
    compileBlocked: () => (allowed ? "" : OFF_REASON),
    setEnabled(on) { allowed = !!on; },

    compile,
    url,
  };
})();
