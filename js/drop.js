/* ═══════════════════════════════════════════════════════════════════════════
   Drop — files and folders dragged into the tab, read for the workspace.

   The workspace is a path → text map (js/vfs.js), so this reads a drag payload
   into the same shape: relative path plus text, folders walked in full. What it
   will not read it says why about, one line per file, rather than failing the
   whole drop — dragging in a project means dragging in its junk too.

   Pictures are not handled here: they belong to the prompt, not the filesystem,
   and js/images.js has them. This module skips them with that as the reason.

   One hard constraint shapes the code: a `DataTransfer` is emptied the moment
   the drop handler yields, so every entry is claimed synchronously — before the
   first `await` — and only then read.
   ═══════════════════════════════════════════════════════════════════════════ */
window.Drop = (function () {

  /* Enough for a small project, and small enough that localStorage still holds
     the result next to the session. A dropped file over the per-file cap is
     reported rather than truncated: half a file is worse than none. */
  const LIMITS = { files: 300, bytes: 512_000, total: 4_000_000 };

  /* Paths nobody means to drop, matched a segment at a time. Dragging a project
     folder in otherwise means dragging its dependency tree in with it. */
  const SKIP = new Set([".git", "node_modules", ".DS_Store", ".venv", "venv",
    "__pycache__", ".next", ".cache", "Thumbs.db"]);

  const skipped = (path) => path.split("/").some((seg) => SKIP.has(seg));

  /** A file's text, or a reason it is not text at all. */
  async function textOf(file) {
    if (file.size > LIMITS.bytes) {
      return { why: `${Math.round(file.size / 1024)}k — over the ${Math.round(LIMITS.bytes / 1024)}k limit for one file` };
    }
    let text;
    try { text = await file.text(); }
    catch (_) { return { why: "could not be read" }; }
    // The workspace is text. A NUL byte is the cheap, reliable tell that this
    // is not, and U+FFFD in quantity means the UTF-8 decode was guesswork.
    if (text.includes("\0")) return { why: "binary — the workspace holds text only" };
    const bad = (text.match(/\uFFFD/g) || []).length;
    if (bad > 4 && bad > text.length / 500) return { why: "not UTF-8 text" };
    return { text };
  }

  /** Take one file into the result, or record why it was left out. */
  async function take(file, path, out) {
    if (String(file.type || "").toLowerCase().startsWith("image/")) {
      /* A picture dropped on its own is the composer's business — js/images.js
         reads the same payload and attaches it — so saying anything here would
         only repeat that. One found inside a dropped folder is worth a line,
         because nothing else will mention it. */
      if (path.includes("/")) {
        out.skips.push({ path, why: "an image — those attach to the prompt, not the workspace" });
      }
      return;
    }
    const read = await textOf(file);
    if (read.why) return void out.skips.push({ path, why: read.why });
    out.files.push({ path, text: read.text, bytes: read.text.length });
    out.bytes += read.text.length;
  }

  const entryFile = (entry) => new Promise((resolve, reject) => entry.file(resolve, reject));

  /** Every child of a directory: `readEntries` yields in batches until empty. */
  function entryChildren(reader) {
    return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
  }

  async function walk(entry, prefix, out) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (skipped(path)) {
      // Named once, not once per file inside it.
      if (!out.skips.some((s) => s.path === path)) out.skips.push({ path, why: "skipped by name" });
      return;
    }
    if (out.files.length >= LIMITS.files || out.bytes >= LIMITS.total) {
      out.full = true;
      return;
    }

    if (entry.isFile) {
      let file;
      try { file = await entryFile(entry); }
      catch (_) { return void out.skips.push({ path, why: "could not be read" }); }
      await take(file, path, out);
      return;
    }

    const reader = entry.createReader();
    for (;;) {
      let batch;
      try { batch = await entryChildren(reader); }
      catch (_) { return void out.skips.push({ path, why: "folder could not be read" }); }
      if (!batch.length) return;
      for (const child of batch) await walk(child, path, out);
      if (out.full) return;
    }
  }

  return {
    limits: LIMITS,

    /**
     * Read a drag payload into workspace records. Resolves
     * `{ files: [{path, text, bytes}], skips: [{path, why}], full }` — `full`
     * when a limit stopped the walk early, so the caller can say so.
     *
     * Takes a `DataTransfer` — and must be called synchronously from the `drop`
     * handler — or anything else with a `files` list, which is how the IMPORT
     * picker gets here.
     */
    read(transfer) {
      if (!transfer) return Promise.resolve({ files: [], skips: [], full: false });

      /* Claim everything now. `webkitGetAsEntry` is what makes a dropped folder
         readable at all — `transfer.files` flattens a directory to nothing —
         and both it and `getAsFile` stop working once this turn of the event
         loop is over. */
      const entries = [];
      const plain = [];
      for (const item of transfer.items || []) {
        if (item.kind !== "file") continue;
        const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
        if (entry) entries.push(entry);
        else {
          const file = item.getAsFile();
          if (file) plain.push(file);
        }
      }
      if (!entries.length && !plain.length) plain.push(...(transfer.files || []));

      const out = { files: [], skips: [], bytes: 0, full: false };

      return (async () => {
        for (const entry of entries) {
          await walk(entry, "", out);
          if (out.full) break;
        }
        for (const file of plain) {
          if (out.files.length >= LIMITS.files || out.bytes >= LIMITS.total) { out.full = true; break; }
          // A plain `File` knows its own name and, from a folder picker, the
          // path it came from.
          const path = file.webkitRelativePath || file.name;
          if (skipped(path)) { out.skips.push({ path, why: "skipped by name" }); continue; }
          await take(file, path, out);
        }
        return { files: out.files, skips: out.skips, full: out.full };
      })();
    },
  };
})();
