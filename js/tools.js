/* ═══════════════════════════════════════════════════════════════════════════
   Tools — the harness's capability surface.

   This file is the harness. Each entry is a JSON-schema declaration handed to
   the model verbatim plus a plain async function that does the work in this
   tab. Nothing here calls a server we control, because there isn't one.

   Contract for a tool:
     name          stable identifier the model calls
     kind          read | write | exec | net  (drives the approval gate + badge)
     description   written for the model: when to reach for it, and its limits
     input_schema  JSON Schema (object) — also rendered in the TOOLS panel
     summary(in)   one-line label for the transcript
     run(in)       -> string shown to the model, or `{ output, shots }` when the
                      result is a picture as well as words. Throw to fail.
   ═══════════════════════════════════════════════════════════════════════════ */
window.Tools = (function () {

  /** Overridden by ui.js so tools can drive panels without importing the UI. */
  const hooks = {
    preview: async () => { throw new Error("preview pane unavailable"); },
    navigate: async () => { throw new Error("preview pane unavailable"); },
    screenshot: async () => { throw new Error("preview pane unavailable"); },
    mounted: () => "",
    log: () => {},
    // The mode lives in settings, which main.js owns — the same pair `/mode`
    // goes through, so a switch by the model and a switch by the user are the
    // same operation and the select in the header stays honest either way.
    mode: () => Agent.defaultMode,
    setMode: () => {},
  };

  const clip = (text, max) =>
    text.length <= max ? text : text.slice(0, max) + `\n… truncated at ${max} chars (${text.length} total)`;

  /* How much of a file or a search a single result may carry. An in-tab engine
     works in an 8k window, where 40k chars is the whole conversation — but a
     cloud model has room for the file, and clipping it there only means the
     model reads the same file twice. So the cap follows the provider. */
  const readCap = () => (leanMode ? 12000 : 40000);

  const numbered = (text, from = 1) =>
    text.split("\n").map((line, i) => `${String(from + i).padStart(5)}\t${line}`).join("\n");

  /* JSON Schema shorthand. Every tool declares an object schema whose properties
     are typed and described, so the `type:`/`required:` scaffolding is written
     once here instead of eighteen times below. The output is ordinary JSON
     Schema — these are handed to the vendors verbatim. */
  const schema = (properties, required = []) => ({ type: "object", properties, required });
  const str = (description, extra) => ({ type: "string", description, ...extra });
  const int = (description) => ({ type: "integer", description });
  const bool = (description) => ({ type: "boolean", description });
  const arr = (description, items) => ({ type: "array", description, items });

  const DEFS = [

    /* ── workspace: read ──────────────────────────────────────────────────── */
    {
      name: "read",
      kind: "read",
      description:
        "Read a workspace file. Returns line-numbered text. Use offset/limit for " +
        "large files; prefer reading a whole file when it is small.",
      input_schema: schema({
        path: str("Workspace-relative path, e.g. demo/agent.js"),
        offset: int("First line to return (1-based)."),
        limit: int("How many lines to return."),
      }, ["path"]),
      summary: (i) => i.path,
      run({ path, offset = 1, limit = 2000 }) {
        const lines = VFS.read(path).split("\n");
        const start = Math.max(1, offset);
        const slice = lines.slice(start - 1, start - 1 + limit);
        if (!slice.length) return `(${path} has ${lines.length} lines; offset ${start} is past the end)`;
        const tail = start - 1 + slice.length < lines.length
          ? `\n… ${lines.length - (start - 1 + slice.length)} more lines` : "";
        return clip(numbered(slice.join("\n"), start), readCap()) + tail;
      },
    },
    {
      name: "list",
      kind: "read",
      description: "List every file in the workspace with its size. Cheap; call it before guessing at paths.",
      input_schema: schema({ prefix: str("Only paths starting with this, e.g. demo/") }),
      summary: (i) => i.prefix || "/",
      run({ prefix = "" } = {}) {
        const paths = VFS.paths().filter((p) => p.startsWith(prefix));
        if (!paths.length) return prefix ? `no files under ${prefix}` : "workspace is empty";
        const rows = paths.map((p) => `${String(VFS.read(p).length).padStart(7)}  ${p}`);
        return `${paths.length} file(s), ${VFS.bytes()} bytes total\n${rows.join("\n")}`;
      },
    },
    {
      name: "glob",
      kind: "read",
      description: "Find workspace files by glob. Supports *, ?, ** and {a,b}. Example: **/*.js",
      input_schema: schema({ pattern: str("Glob pattern.") }, ["pattern"]),
      summary: (i) => i.pattern,
      run({ pattern }) {
        const hits = VFS.glob(pattern);
        return hits.length ? hits.join("\n") : `no match for ${pattern}`;
      },
    },
    {
      name: "grep",
      kind: "read",
      description:
        "Search workspace file contents with a JavaScript regular expression. " +
        "Returns path:line:text. Narrow the scope with `glob` when the workspace is large.",
      input_schema: schema({
        pattern: str("JS regex source, e.g. export function \\w+"),
        glob: str("Restrict to files matching this glob."),
        ignore_case: bool("Case-insensitive match."),
      }, ["pattern"]),
      summary: (i) => i.pattern + (i.glob ? `  in ${i.glob}` : ""),
      run({ pattern, glob, ignore_case }) {
        const hits = VFS.grep(pattern, { glob, flags: ignore_case ? "i" : "" });
        if (!hits.length) return `no match for /${pattern}/`;
        const shown = hits.slice(0, 200)
          .map((h) => `${h.path}:${h.line}: ${h.text.trim().slice(0, 200)}`).join("\n");
        return clip(shown, readCap()) + (hits.length > 200 ? `\n… ${hits.length - 200} more matches` : "");
      },
    },

    /* ── workspace: write ─────────────────────────────────────────────────── */
    {
      name: "write",
      kind: "write",
      description:
        "Create or overwrite a workspace file with exact content. Overwrites without " +
        "warning, so `read` first if the file might already hold work worth keeping.",
      input_schema: schema({
        path: str("Workspace-relative path."),
        content: str("Full file content."),
      }, ["path", "content"]),
      summary: (i) => `${i.path}  (${(i.content || "").length}b)`,
      run({ path, content }) {
        const r = VFS.write(path, content);
        return `${r.existed ? "overwrote" : "created"} ${r.path} — ${r.bytes} bytes`;
      },
    },
    {
      name: "edit",
      kind: "write",
      description:
        "Replace an exact substring in a workspace file. `old_string` must appear " +
        "exactly once unless replace_all is set. Preferred over `write` for small changes.",
      // The uniqueness rule is the second sentence, which lean mode would drop —
      // and it is the one thing a small model gets wrong about this tool.
      lean:
        "Replace an exact substring in a workspace file; `old_string` must appear " +
        "exactly once unless replace_all is set. Preferred over `write` for small changes.",
      input_schema: schema({
        path: str("Workspace-relative path."),
        old_string: str("Exact text to find, including indentation."),
        new_string: str("Replacement text."),
        replace_all: bool("Replace every occurrence."),
      }, ["path", "old_string", "new_string"]),
      summary: (i) => i.path,
      run({ path, old_string, new_string, replace_all }) {
        const before = VFS.read(path);
        const count = before.split(old_string).length - 1;
        if (!count) throw new Error(`old_string not found in ${path}`);
        if (count > 1 && !replace_all) {
          throw new Error(`old_string appears ${count}x in ${path}; add more context or set replace_all`);
        }
        const after = replace_all
          ? before.split(old_string).join(new_string)
          : before.replace(old_string, new_string);
        VFS.write(path, after);
        return `edited ${path} — ${replace_all ? count : 1} replacement(s), now ${after.length} bytes`;
      },
    },
    {
      name: "delete",
      kind: "write",
      description: "Remove a workspace file. There is no undo.",
      input_schema: schema({ path: str("Workspace-relative path.") }, ["path"]),
      summary: (i) => i.path,
      run({ path }) { return `deleted ${VFS.remove(path)}`; },
    },
    {
      name: "move",
      kind: "write",
      description: "Rename or move a workspace file. Overwrites the destination if it exists.",
      input_schema: schema({
        from: str("Existing path."),
        to: str("New path."),
      }, ["from", "to"]),
      summary: (i) => `${i.from} → ${i.to}`,
      run({ from, to }) {
        const r = VFS.move(from, to);
        return `moved ${r.from} → ${r.to}`;
      },
    },

    /* ── planning ─────────────────────────────────────────────────────────── */
    {
      name: "todo",
      kind: "read",
      description:
        "Record the plan for a multi-step build and its current state. Rewrite the " +
        "whole list each time. Use it for work with 3+ steps so the user can see " +
        "where things stand; skip it for one-shot answers.",
      input_schema: schema({
        items: arr("The full task list, in order.", schema({
          text: str("What the step accomplishes."),
          status: str("Step state.", { enum: ["pending", "active", "done"] }),
        }, ["text", "status"])),
      }, ["items"]),
      summary: (i) => {
        const items = i.items || [];
        return `${items.filter((t) => t.status === "done").length}/${items.length} done`;
      },
      run({ items }) {
        const mark = { pending: "[ ]", active: "[~]", done: "[x]" };
        return items.map((t) => `${mark[t.status] || "[ ]"} ${t.text}`).join("\n");
      },
    },

    /* ── the harness itself ───────────────────────────────────────────────── */
    {
      name: "set_mode",
      kind: "read",
      description:
        "Switch which specialist prompt you are running under, for work that belongs to " +
        "another mode than the current one — most often an agent build (`agent-builder`, " +
        "the Blocks.AI mode). The system prompt is rebuilt on every step, so the switch " +
        "lands on your next step of this same turn: the conversation, the workspace and " +
        "the user's approvals all survive it. Call it before you start the work, not after. " +
        "Modes: " +
        Object.entries(Agent.modes).map(([id, m]) => `${id} — ${m.blurb}`).join("; ") + ".",
      // Lean mode keeps only a description's first sentence, and this tool's
      // is useless without the list of modes — so it carries its own short form.
      lean:
        "Switch which specialist prompt you are running under, before you start " +
        "work that belongs to another mode. Takes effect on your next step; the " +
        "conversation and workspace survive it. Modes: " +
        Object.entries(Agent.modes).map(([id, m]) => `${id} — ${m.blurb}`).join("; ") + ".",
      input_schema: schema({
        mode: str("Mode to switch to.", { enum: Object.keys(Agent.modes) }),
        why: str("One short line for the user on what made this the right mode."),
      }, ["mode"]),
      summary: (i) => i.mode || "",
      run({ mode, why }) {
        const ids = Object.keys(Agent.modes);
        if (!ids.includes(mode)) throw new Error(`unknown mode '${mode}'. Known: ${ids.join(", ")}`);
        const from = hooks.mode();
        if (mode === from) return `already in ${mode} — nothing changed; get on with the work`;
        hooks.setMode(mode);
        return `mode ${from} → ${mode} · ${Agent.modes[mode].blurb}\n` +
               `${why ? why + "\n" : ""}` +
               `Your next step is written under the ${mode} prompt. Do not switch again this turn.`;
      },
    },

    /* ── execution ────────────────────────────────────────────────────────── */
    {
      name: "run_js",
      kind: "exec",
      description:
        "Evaluate a JavaScript snippet in a sandboxed iframe and report console output " +
        "plus the returned value. Top-level `await` and dynamic `import('https://esm.sh/pkg')` " +
        "both work; static `import` statements do not (use dynamic import). Use this to " +
        "probe a package's real exports before writing code against it.",
      input_schema: schema({
        code: str("Statements to run. `return` a value to see it."),
        timeout_ms: int("Give up after this long (default 15000)."),
      }, ["code"]),
      summary: (i) => (i.code || "").trim().split("\n")[0].slice(0, 80),
      async run({ code, timeout_ms }) {
        const r = await Sandbox.runJs(code, { timeout: timeout_ms || 15000 });
        return report(r);
      },
    },
    {
      name: "run_agent",
      kind: "exec",
      description:
        "Run a workspace JavaScript module in the sandbox, resolving its relative imports " +
        "against the other workspace files. If it exports a default (or `main`) function, " +
        "that is called; otherwise its export names are reported. Circular imports fail. " +
        "This is how you verify an agent you built actually loads and runs.",
      input_schema: schema({
        entry: str("Workspace path of the module to run."),
        timeout_ms: int("Give up after this long (default 20000)."),
      }, ["entry"]),
      summary: (i) => i.entry,
      async run({ entry, timeout_ms }) {
        const r = await Sandbox.runModule(entry, {
          timeout: timeout_ms || 20000,
          onLog: (m) => hooks.log(m),
        });
        return report(r);
      },
    },
    {
      name: "preview",
      kind: "exec",
      description:
        "Mount a workspace HTML file in the harness PREVIEW pane so the user can see and " +
        "click it. Relative script/style/module references are wired to the workspace copies. " +
        "Finish a UI build with this.",
      input_schema: schema({ path: str("Workspace path to an .html file.") }, ["path"]),
      summary: (i) => i.path,
      async run({ path }) {
        await hooks.preview(path);
        return `mounted ${VFS.norm(path)} in the PREVIEW pane`;
      },
    },
    {
      name: "screenshot",
      kind: "read",
      description:
        "Photograph the mounted PREVIEW page and look at it. The picture comes back " +
        "attached to this tool's result, so you can compare what rendered against what " +
        "you intended instead of assuming. Image pixels are the frame's CSS pixels 1:1, " +
        "so a coordinate read off the shot is one `navigate` can click. Only the visible " +
        "viewport is captured — `navigate` scroll first to see further down. " +
        "The page redraws itself rather than being filmed, so a WebGL canvas or a " +
        "cross-origin frame inside it may come back blank; that is the shot, not the page.",
      input_schema: schema({}),
      summary: () => hooks.mounted() || "preview",
      async run() {
        const { shot, skipped, viewport } = await hooks.screenshot();
        const lines = [
          `screenshot of ${hooks.mounted() || "the preview"} — ${shot.width}x${shot.height} ${shot.mediaType}`,
          `the frame's viewport is ${viewport.w}x${viewport.h} css px` +
            (shot.width === viewport.w
              ? " — image pixels are css pixels, so click what you see at the coordinates you see"
              : `, so multiply a coordinate read off this image by ${(viewport.w / shot.width).toFixed(3)} before clicking it`),
        ];
        if (skipped) {
          lines.push(
            `${skipped} resource(s) (fonts or images) did not load in time, so the shot may ` +
            `differ from the frame in typeface or a missing picture — do not chase that as a bug.`
          );
        }
        return { output: lines.join("\n"), shots: [shot] };
      },
    },
    {
      name: "navigate",
      kind: "exec",
      description:
        "Operate the mounted PREVIEW page: click, type, press a key, scroll, or ask what " +
        "is on screen. Coordinates are CSS pixels of the frame's viewport, the same space " +
        "`screenshot` returns; a `selector` targets an element instead and is the more " +
        "reliable of the two. Actions:\n" +
        "  inspect      — every visible interactive element with the coordinate to click it. Start here.\n" +
        "  text         — the page's visible text; often the whole check, and cheaper than a picture.\n" +
        "  click / double_click / right_click / hover — at x,y or a selector.\n" +
        "  type         — into an input, textarea, contenteditable, or choose a <select> option. " +
        "Appends unless clear:true. Targets the selector, then x,y, then whatever has focus.\n" +
        "  key          — a named key at the focused element: Enter, Tab, Escape, ArrowDown, Backspace.\n" +
        "  scroll       — by dx,dy, or pass a selector to bring an element into view.\n" +
        "Each call reports what it hit, the frame's state after it, and any console errors " +
        "the page logged since the last action. Events are synthetic: a click activates " +
        "normally, but a synthetic Enter will not submit a form natively. Take a " +
        "`screenshot` after a click to see what it did.",
      input_schema: schema({
        action: str("What to do.", {
          enum: ["click", "double_click", "right_click", "hover", "type", "key", "scroll", "inspect", "text"],
        }),
        x: int("Horizontal CSS pixel in the frame's viewport."),
        y: int("Vertical CSS pixel in the frame's viewport."),
        selector: str("CSS selector to target instead of a coordinate, e.g. #save or .row button"),
        text: str("Text to type, or the option to choose in a <select>."),
        clear: bool("Empty the field before typing."),
        key: str("Key name for the key action, e.g. Enter, Tab, Escape, ArrowDown."),
        repeat: int("Press the key this many times (default 1, max 50)."),
        dx: int("Horizontal scroll in pixels."),
        dy: int("Vertical scroll in pixels (positive scrolls down)."),
        limit: int("inspect: how many elements to list (default 60)."),
        max_chars: int("text: truncate at this many characters (default 6000)."),
      }, ["action"]),
      summary: (i) => {
        const where = i.selector ? i.selector
          : Number.isFinite(i.x) && Number.isFinite(i.y) ? `${i.x},${i.y}` : "";
        const what = i.action === "type" ? JSON.stringify(String(i.text || "").slice(0, 30))
          : i.action === "key" ? i.key
          : i.action === "scroll" ? `${i.dx || 0},${i.dy || 0}`
          : "";
        return [i.action, what, where].filter(Boolean).join("  ");
      },
      async run(input) {
        return hooks.navigate(input);
      },
    },

    /* ── network (CORS applies) ───────────────────────────────────────────── */
    {
      name: "http_get",
      kind: "net",
      description:
        "GET a URL from this browser tab and return the body as text. Subject to CORS: " +
        "API endpoints and CDNs usually work, ordinary web pages usually do not. " +
        "A CORS failure is reported as such, not as a missing page.",
      input_schema: schema({
        url: str("Absolute http(s) URL."),
        max_chars: int("Truncate the body (default 20000)."),
      }, ["url"]),
      summary: (i) => i.url,
      async run({ url, max_chars = 20000 }) {
        if (!/^https?:\/\//i.test(url)) throw new Error("url must be absolute http(s)");
        let res;
        try {
          res = await fetch(url, { headers: { accept: "text/plain, application/json, text/*, */*" } });
        } catch (err) {
          throw new Error(
            `network/CORS failure for ${url} (${err.message}). The origin likely does not ` +
            `allow cross-origin reads from a browser; try a CDN or API endpoint instead.`
          );
        }
        const body = await res.text();
        return `HTTP ${res.status} ${res.statusText} · ${body.length} chars\n\n${clip(body, max_chars)}`;
      },
    },
    {
      name: "npm_info",
      kind: "net",
      description:
        "Look up a package on the public npm registry: latest version, description, " +
        "exports map, dependencies and README. Registry CORS is open, so this always " +
        "works when the tab is online. Use it before writing code against any package.",
      input_schema: schema({
        name: str("Package name, e.g. blocks.ai"),
        version: str("Specific version (default: latest)."),
      }, ["name"]),
      summary: (i) => i.name,
      async run({ name, version }) {
        const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`);
        if (res.status === 404) return `no such package on npm: ${name}`;
        if (!res.ok) throw new Error(`registry ${res.status} for ${name}`);
        const doc = await res.json();
        const tag = version || doc["dist-tags"]?.latest;
        const v = doc.versions?.[tag];
        if (!v) return `package ${name} exists but has no version ${tag}`;
        const lines = [
          `${name}@${tag}`,
          v.description ? `description: ${v.description}` : null,
          v.homepage ? `homepage: ${v.homepage}` : null,
          v.type ? `type: ${v.type}` : null,
          v.main ? `main: ${v.main}` : null,
          v.module ? `module: ${v.module}` : null,
          v.types || v.typings ? `types: ${v.types || v.typings}` : null,
          v.exports ? `exports: ${JSON.stringify(v.exports)}` : null,
          v.dependencies ? `dependencies: ${Object.keys(v.dependencies).join(", ") || "none"}` : null,
          `cdn: https://esm.sh/${name}@${tag}`,
        ].filter(Boolean);
        const readme = doc.readme || v.readme;
        return lines.join("\n") + (readme ? `\n\n--- README ---\n${clip(readme, 12000)}` : "");
      },
    },
    {
      name: "npm_file",
      kind: "net",
      description:
        "Fetch one file out of a published npm package via jsDelivr — type declarations " +
        "(index.d.ts), source, anything. Omit `path` to list the package's file tree. " +
        "This is the reliable way to learn a package's real API without guessing.",
      input_schema: schema({
        name: str("Package name."),
        path: str("File inside the package, e.g. dist/index.d.ts"),
        version: str("Version or tag (default latest)."),
        max_chars: int("Truncate (default 20000)."),
      }, ["name"]),
      summary: (i) => `${i.name}${i.path ? "/" + i.path : " (tree)"}`,
      async run({ name, path, version = "latest", max_chars = 20000 }) {
        const spec = `${name}@${version}`;
        if (!path) {
          const res = await fetch(`https://data.jsdelivr.com/v1/package/npm/${spec}/flat`);
          if (!res.ok) throw new Error(`jsdelivr ${res.status} listing ${spec}`);
          const { files = [] } = await res.json();
          const names = files.map((f) => f.name).sort();
          return `${names.length} file(s) in ${spec}\n${clip(names.join("\n"), 8000)}`;
        }
        const url = `https://cdn.jsdelivr.net/npm/${spec}/${path.replace(/^\//, "")}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`jsdelivr ${res.status} for ${url}`);
        return `${url}\n\n${clip(await res.text(), max_chars)}`;
      },
    },

    /* ── agent-building knowledge ─────────────────────────────────────────── */
    {
      name: "framework_docs",
      kind: "read",
      description:
        "Read the harness's built-in notes on building browser agents: how this " +
        "sandbox works, and per-framework guidance. Call with no argument to list " +
        "frameworks. Read this before scaffolding anything.",
      input_schema: schema({ framework: str("Framework id, or 'harness' for the sandbox notes.") }),
      summary: (i) => i.framework || "index",
      run({ framework } = {}) {
        if (!framework) {
          const rows = Frameworks.list()
            .map((f) => `${f.id.padEnd(12)} ${f.name} — ${f.summary}${f.npm ? ` (npm: ${f.npm})` : ""}`);
          return `frameworks:\n${rows.join("\n")}\n\nAlso: framework_docs {"framework":"harness"} for how this sandbox behaves.`;
        }
        if (framework === "harness") return Frameworks.harnessNotes;
        const fw = Frameworks.get(framework);
        if (!fw) return `unknown framework '${framework}'. Known: ${Frameworks.ids().join(", ")}, harness`;
        return fw.docs;
      },
    },
    {
      name: "scaffold",
      kind: "write",
      description:
        "Write a working starter agent into the workspace: index.html, an agent loop, " +
        "tool definitions and a provider adapter. Faster and less error-prone than " +
        "writing the skeleton by hand — scaffold, then edit toward what the user asked for.",
      input_schema: schema({
        framework: str("Framework id from framework_docs."),
        directory: str("Workspace directory to write into, e.g. demo"),
      }, ["framework", "directory"]),
      summary: (i) => `${i.framework} → ${i.directory}/`,
      run({ framework, directory }) {
        const fw = Frameworks.get(framework);
        if (!fw) throw new Error(`unknown framework '${framework}'. Known: ${Frameworks.ids().join(", ")}`);
        const dir = VFS.norm(directory + "/_").replace(/\/_$/, "");
        const files = fw.scaffold(dir);
        const written = Object.keys(files).sort();
        for (const path of written) VFS.write(path, files[path]);
        return `scaffolded ${fw.name} into ${dir}/\n${written.join("\n")}\n\n` +
               `Next: read ${dir}/tools.js and shape the tools to the user's actual goal, ` +
               `then run_agent ${dir}/agent.js or preview ${dir}/index.html.`;
      },
    },
    {
      name: "export_zip",
      kind: "read",
      description:
        "Package the whole workspace as a .zip and hand it to the user's browser as a " +
        "download. Offer this once a build works so the work can leave the tab.",
      input_schema: schema({ filename: str("Archive name (default agent-workspace.zip).") }),
      summary: (i) => i.filename || "agent-workspace.zip",
      run({ filename = "agent-workspace.zip" } = {}) {
        if (!VFS.count()) throw new Error("workspace is empty; nothing to export");
        const name = filename.endsWith(".zip") ? filename : filename + ".zip";
        Zip.download(name, Zip.build(VFS.snapshot()));
        return `downloading ${name} — ${VFS.count()} file(s), ${VFS.bytes()} bytes`;
      },
    },
  ];

  /* ── which tools the model is handed ──────────────────────────────────────
     A tool can be switched off in the TOOLS panel. Off means the declaration
     never reaches the model, so the model cannot call it at all — this is a
     smaller harness for that turn, not a refusal after the fact. The choice is
     the user's, so it outlives a reload; the list stored is the *off* set, so a
     tool added to DEFS later arrives switched on. */
  const OFF_KEY = "buttercup.tools.off.v1";

  function loadOff() {
    try {
      const saved = JSON.parse(localStorage.getItem(OFF_KEY));
      return new Set(Array.isArray(saved) ? saved.filter((n) => typeof n === "string") : []);
    } catch (_) { return new Set(); }
  }

  const off = loadOff();

  function saveOff() {
    try { localStorage.setItem(OFF_KEY, JSON.stringify([...off])); } catch (_) {}
  }

  /** Format a Sandbox result for the model: logs first, then value or error. */
  function report(r) {
    const logs = r.logs.length
      ? r.logs.map((l) => (l.level === "log" ? "" : `[${l.level}] `) + l.text).join("\n")
      : "(no console output)";
    if (!r.ok) return `FAILED\n${logs}\n\nerror: ${r.error}`;
    return `OK\n${logs}\n\nreturned: ${r.value === undefined ? "undefined" : r.value}`;
  }

  const byName = Object.fromEntries(DEFS.map((d) => [d.name, d]));

  // Lean mode: small-context engines see only the core set, and anything
  // outside it is refused at run() time too.
  let leanMode = false;
  const CORE = new Set([
    "read", "list", "glob", "grep", "write", "edit", "delete", "move",
    "todo", "set_mode", "run_js", "preview", "http_get",
  ]);

  return {
    hooks,
    defs: DEFS,

    /** True when this tool is switched on, i.e. offered to the model. */
    enabled(name) {
      return !off.has(name);
    },

    /** Switch one tool on or off and remember it. */
    setEnabled(name, on) {
      if (!byName[name]) return;
      if (on) off.delete(name); else off.add(name);
      saveOff();
    },

    /** Switch every tool on (or off) in one move — the panel's ALL / NONE. */
    setAllEnabled(on) {
      off.clear();
      if (!on) for (const d of DEFS) off.add(d.name);
      saveOff();
    },

    /** The tools the model actually gets, in declaration order. */
    enabledDefs() {
      return DEFS.filter((d) => !off.has(d.name));
    },

    /** Whether this session's provider gets the lean toolset — set by the
        agent from the provider spec, not inferred from the last `schemas`
        call, because `compact` completes with no tools at all. */
    setLean(on) {
      leanMode = !!on;
    },

    /** Tool declarations; `lean` further drops the non-core tools and
        compresses the rest to first-sentence descriptions with bare types. */
    schemas(lean = false) {
      const pool = DEFS.filter((d) => !off.has(d.name) && (!lean || CORE.has(d.name)));
      if (!lean) {
        return pool.map((d) => ({ name: d.name, description: d.description, input_schema: d.input_schema }));
      }
      const first = (s) => {
        const i = s.indexOf(". ");
        return i === -1 ? s : s.slice(0, i + 1);
      };
      return pool.map((d) => {
        // A required parameter keeps its description: the contract a small
        // model gets wrong (`old_string` must be unique, indentation included)
        // lives there, and a failed call costs a whole step to find out.
        const required = new Set(d.input_schema.required || []);
        return {
          name: d.name,
          // `lean` on the def is the hand-written short form, for the tools
          // whose first sentence leaves out something the model cannot work
          // without (set_mode's list of modes).
          description: d.lean || first(d.description),
          input_schema: {
            type: "object",
            properties: Object.fromEntries(Object.entries(d.input_schema.properties).map(([k, v]) => [
              k,
              {
                type: v.type,
                ...(required.has(k) && v.description ? { description: v.description } : {}),
                ...(v.enum ? { enum: v.enum } : {}),
                ...(v.items ? { items: v.items } : {}),
              },
            ])),
            required: d.input_schema.required,
          },
        };
      });
    },

    /** True when a call should pause for the user unless auto-approve is on. */
    needsApproval(name) {
      const def = byName[name];
      return !!def && (def.kind === "write" || def.kind === "exec");
    },

    summarize(name, input) {
      const def = byName[name];
      if (!def) return "";
      try { return String(def.summary(input || {}) ?? ""); } catch (_) { return ""; }
    },

    /**
     * Run one call. Always resolves `{ output, shots }`: a tool that returns a
     * bare string has no pictures, and `screenshot` is the one that does — so
     * the caller has a single result shape rather than two.
     */
    async run(name, input) {
      const def = byName[name];
      const available = () => DEFS.filter((d) => !off.has(d.name) && (!leanMode || CORE.has(d.name))).map((d) => d.name).join(", ");
      if (!def) throw new Error(`unknown tool '${name}'. Available: ${available()}`);
      // Reachable from an earlier turn: the model saw this tool before the
      // user switched it off, or it was never offered in lean mode.
      if (off.has(name)) {
        throw new Error(`tool '${name}' is switched off in the TOOLS panel. Available: ${available()}`);
      }
      if (leanMode && !CORE.has(name)) {
        throw new Error(`tool '${name}' is not offered in this mode. Available: ${available()}`);
      }
      const out = await def.run(input || {});
      if (out && typeof out === "object" && !Array.isArray(out)) {
        return { output: String(out.output ?? "(no output)"), shots: out.shots || [] };
      }
      return { output: String(out ?? "(no output)"), shots: [] };
    },
  };
})();
