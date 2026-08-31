/* ═══════════════════════════════════════════════════════════════════════════
   VFS — the workspace the agent writes into.

   A flat path → text map, mirrored into localStorage. There is no server, so
   this *is* the filesystem: every fs tool in js/tools.js goes through here, and
   js/sandbox.js turns these entries into real ES modules to execute.
   ═══════════════════════════════════════════════════════════════════════════ */
window.VFS = (function () {
  const KEY = "buttercup.vfs.v1";
  let files = load();
  const watchers = [];

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  function persist() {
    try {
      localStorage.setItem(KEY, JSON.stringify(files));
    } catch (err) {
      // Quota is the only realistic failure; the in-memory copy still works.
      console.warn("[vfs] could not persist:", err);
    }
    watchers.forEach((fn) => fn());
  }

  /** Collapse `.`/`..`, drop leading slashes: every path is workspace-relative. */
  function norm(path) {
    if (typeof path !== "string" || !path.trim()) throw new Error("path is required");
    const out = [];
    for (const seg of path.replace(/\\/g, "/").split("/")) {
      if (!seg || seg === ".") continue;
      if (seg === "..") out.pop();
      else out.push(seg);
    }
    if (!out.length) throw new Error(`not a file path: ${path}`);
    return out.join("/");
  }

  /** A glob character that has no special meaning, escaped for a RegExp. */
  const lit = (s) => s.replace(/[.+^${}()|[\]\\]/g, "\\$&");

  /** glob → RegExp. Supports `*`, `?`, `**`, and `{a,b}` alternation. */
  function globRe(pattern) {
    let re = "";
    for (let i = 0; i < pattern.length; i++) {
      const c = pattern[i];
      if (c === "*") {
        if (pattern[i + 1] === "*") {
          // `**/` may match zero directories, so make the slash optional.
          i++;
          if (pattern[i + 1] === "/") { i++; re += "(?:.*/)?"; }
          else re += ".*";
        } else re += "[^/]*";
      } else if (c === "?") re += "[^/]";
      else if (c === "{") {
        const close = pattern.indexOf("}", i);
        if (close < 0) { re += "\\{"; continue; }
        const alts = pattern.slice(i + 1, close).split(",");
        re += "(?:" + alts.map(lit).join("|") + ")";
        i = close;
      } else re += lit(c);
    }
    return new RegExp("^" + re + "$");
  }

  const api = {
    norm,

    paths() { return Object.keys(files).sort(); },
    count() { return Object.keys(files).length; },
    exists(p) { return Object.prototype.hasOwnProperty.call(files, norm(p)); },

    read(p) {
      const path = norm(p);
      if (!api.exists(path)) throw new Error(`no such file: ${path}`);
      return files[path];
    },

    write(p, content) {
      const path = norm(p);
      const existed = api.exists(path);
      files[path] = String(content == null ? "" : content);
      persist();
      return { path, existed, bytes: files[path].length };
    },

    remove(p) {
      const path = norm(p);
      if (!api.exists(path)) throw new Error(`no such file: ${path}`);
      delete files[path];
      persist();
      return path;
    },

    move(from, to) {
      const a = norm(from), b = norm(to);
      const content = api.read(a);
      delete files[a];
      files[b] = content;
      persist();
      return { from: a, to: b };
    },

    glob(pattern) {
      const re = globRe(pattern.replace(/^\.?\//, ""));
      return api.paths().filter((p) => re.test(p));
    },

    grep(pattern, { glob, flags = "" } = {}) {
      const re = new RegExp(pattern, flags.includes("i") ? "i" : "");
      const scope = glob ? api.glob(glob) : api.paths();
      const hits = [];
      for (const path of scope) {
        files[path].split("\n").forEach((line, i) => {
          if (re.test(line)) hits.push({ path, line: i + 1, text: line });
        });
      }
      return hits;
    },

    bytes() { return api.paths().reduce((n, p) => n + files[p].length, 0); },

    snapshot() { return { ...files }; },

    /**
     * Replace the whole workspace with a previous `snapshot()`. Used by the
     * checkpoint stack: undo has to put deleted files back, not just rewind the
     * ones that still exist.
     */
    restore(snapshot) {
      if (!snapshot || typeof snapshot !== "object") throw new Error("restore needs a snapshot");
      files = { ...snapshot };
      persist();
      return api.count();
    },

    wipe() { files = {}; persist(); },

    onChange(fn) { watchers.push(fn); },
  };

  return api;
})();
