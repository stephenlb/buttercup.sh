/* ═══════════════════════════════════════════════════════════════════════════
   Workspaces — which localStorage the rest of the harness is looking at.

   A workspace is a project: its files (js/vfs.js) and the conversation about
   them (js/agent.js). Both live in localStorage, so switching workspaces is
   nothing more than changing the keys those two modules read and write — every
   owned key is suffixed with the workspace id, and this module is the only
   place that knows the suffix.

   Loaded before vfs.js and agent.js, because both of them read their key on
   the way up. It never touches the DOM: main.js orchestrates a switch, since
   the transcript, the undo stack and the preview frame all belong to the
   workspace being left.
   ═══════════════════════════════════════════════════════════════════════════ */
window.Workspaces = (function () {
  const KEY = "buttercup.workspaces.v1";

  /* Every localStorage key a workspace owns a private copy of. Anything not
     listed here — settings, API keys, the theme — is the tab's, not a
     project's, and is deliberately shared across all of them. */
  const OWNED = ["buttercup.vfs.v1", "buttercup.session.v1", "buttercup.context.v1"];

  const FIRST = "w1";
  const NAME_CAP = 40;

  const watchers = [];
  let state = load();

  function save(s = state) {
    try { localStorage.setItem(KEY, JSON.stringify(s)); }
    catch (err) { console.warn("[workspaces] could not persist:", err); }
  }

  function load() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(KEY)); } catch (_) {}
    const rows = saved && Array.isArray(saved.list)
      ? saved.list
          .filter((r) => r && typeof r.id === "string" && r.id)
          .map((r) => ({ id: r.id, name: String(r.name || r.id) }))
      : [];
    if (!rows.length) return adopt();
    return { active: rows.some((r) => r.id === saved.active) ? saved.active : rows[0].id, list: rows };
  }

  /**
   * First run. A tab that has been used before already has one workspace — it
   * just had no name and no suffix — so its keys are moved under `w1` rather
   * than being left behind where nothing will read them again.
   */
  function adopt() {
    for (const base of OWNED) {
      const legacy = localStorage.getItem(base);
      if (legacy == null) continue;
      try {
        localStorage.setItem(`${base}.${FIRST}`, legacy);
        localStorage.removeItem(base);
      } catch (err) {
        console.warn("[workspaces] could not adopt", base, err);
      }
    }
    const fresh = { active: FIRST, list: [{ id: FIRST, name: "workspace" }] };
    save(fresh);
    return fresh;
  }

  const clone = (r) => ({ id: r.id, name: r.name });
  const record = (id) => state.list.find((r) => r.id === id) || null;

  function nextId() {
    const taken = new Set(state.list.map((r) => r.id));
    let n = 1;
    while (taken.has(`w${n}`)) n++;
    return `w${n}`;
  }

  /** A name nothing else is already called, so `/workspace switch` is unambiguous. */
  function uniqueName(want, exceptId) {
    const base = String(want == null ? "" : want).replace(/\s+/g, " ").trim().slice(0, NAME_CAP) || "workspace";
    const taken = new Set(state.list.filter((r) => r.id !== exceptId).map((r) => r.name.toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    for (let n = 2; ; n++) {
      const tried = `${base} ${n}`;
      if (!taken.has(tried.toLowerCase())) return tried;
    }
  }

  /** Drop every key a workspace owns. Used by remove, and by create for hygiene. */
  function clearStorage(id) {
    for (const base of OWNED) {
      try { localStorage.removeItem(`${base}.${id}`); } catch (_) {}
    }
  }

  const announce = () => watchers.forEach((fn) => fn());

  const api = {
    /** The active workspace's copy of a shared key. The one place the suffix lives. */
    key(base) { return `${base}.${state.active}`; },

    list() { return state.list.map(clone); },
    active() { return clone(record(state.active) || state.list[0]); },
    count() { return state.list.length; },

    get(id) { const r = record(id); return r ? clone(r) : null; },

    /**
     * Resolve what a user typed: an id, a name (case-insensitive), or the
     * 1-based position the picker and `/workspace` both show.
     */
    find(ref) {
      const text = String(ref == null ? "" : ref).trim();
      if (!text) return null;
      const byId = record(text);
      if (byId) return clone(byId);
      const lower = text.toLowerCase();
      const byName = state.list.find((r) => r.name.toLowerCase() === lower);
      if (byName) return clone(byName);
      if (/^\d+$/.test(text)) {
        const at = state.list[Number(text) - 1];
        if (at) return clone(at);
      }
      return null;
    },

    /**
     * What is stored under a workspace, without loading it: the picker says how
     * big each project is, and reading one must not disturb the live VFS.
     */
    info(id) {
      let files = {};
      try {
        const raw = localStorage.getItem(`buttercup.vfs.v1.${id}`);
        const parsed = raw ? JSON.parse(raw) : null;
        if (parsed && typeof parsed === "object") files = parsed;
      } catch (_) {}
      const paths = Object.keys(files);
      let turns = 0;
      try {
        const raw = localStorage.getItem(`buttercup.session.v1.${id}`);
        const parsed = raw ? JSON.parse(raw) : null;
        if (Array.isArray(parsed)) turns = parsed.length;
      } catch (_) {}
      return {
        files: paths.length,
        bytes: paths.reduce((n, p) => n + String(files[p]).length, 0),
        turns,
      };
    },

    /** A new, empty workspace. Does not switch to it — main.js decides that. */
    create(name) {
      const row = { id: nextId(), name: uniqueName(name) };
      clearStorage(row.id);   // an id can be reused; its old storage must not be
      state.list.push(row);
      save();
      announce();
      return clone(row);
    },

    /** Point the owned keys at another workspace. Callers must reload from them. */
    switchTo(id) {
      const row = record(id);
      if (!row) throw new Error(`no such workspace: ${id}`);
      state.active = row.id;
      save();
      announce();
      return clone(row);
    },

    rename(id, name) {
      const row = record(id);
      if (!row) throw new Error(`no such workspace: ${id}`);
      row.name = uniqueName(name, row.id);
      save();
      announce();
      return clone(row);
    },

    /**
     * Delete a workspace and everything in it. The last one cannot go — there
     * would be nowhere for the harness to be — and the active one cannot go
     * until something else is active, which is main.js's job to arrange.
     */
    remove(id) {
      const row = record(id);
      if (!row) throw new Error(`no such workspace: ${id}`);
      if (state.list.length < 2) throw new Error("this is the only workspace — /wipe empties it instead");
      if (row.id === state.active) throw new Error("switch away from a workspace before deleting it");
      state.list = state.list.filter((r) => r.id !== row.id);
      clearStorage(row.id);
      save();
      announce();
      return clone(row);
    },

    onChange(fn) { watchers.push(fn); },
  };

  return api;
})();
