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
     run(in)       -> string shown to the model. Throw to report failure.
   ═══════════════════════════════════════════════════════════════════════════ */
window.Tools = (function () {

  /** Overridden by ui.js so tools can drive panels without importing the UI. */
  const hooks = {
    preview: async () => { throw new Error("preview pane unavailable"); },
    log: () => {},
  };

  const clip = (text, max) =>
    text.length <= max ? text : text.slice(0, max) + `\n… truncated at ${max} chars (${text.length} total)`;

  const numbered = (text, from = 1) =>
    text.split("\n").map((line, i) => `${String(from + i).padStart(5)}\t${line}`).join("\n");

  const DEFS = [

    /* ── workspace: read ──────────────────────────────────────────────────── */
    {
      name: "read",
      kind: "read",
      description:
        "Read a workspace file. Returns line-numbered text. Use offset/limit for " +
        "large files; prefer reading a whole file when it is small.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative path, e.g. demo/agent.js" },
          offset: { type: "integer", description: "First line to return (1-based)." },
          limit: { type: "integer", description: "How many lines to return." },
        },
        required: ["path"],
      },
      summary: (i) => i.path,
      run({ path, offset = 1, limit = 2000 }) {
        const lines = VFS.read(path).split("\n");
        const start = Math.max(1, offset);
        const slice = lines.slice(start - 1, start - 1 + limit);
        if (!slice.length) return `(${path} has ${lines.length} lines; offset ${start} is past the end)`;
        const tail = start - 1 + slice.length < lines.length
          ? `\n… ${lines.length - (start - 1 + slice.length)} more lines` : "";
        return clip(numbered(slice.join("\n"), start), 40000) + tail;
      },
    },
    {
      name: "list",
      kind: "read",
      description: "List every file in the workspace with its size. Cheap; call it before guessing at paths.",
      input_schema: {
        type: "object",
        properties: { prefix: { type: "string", description: "Only paths starting with this, e.g. demo/" } },
        required: [],
      },
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
      input_schema: {
        type: "object",
        properties: { pattern: { type: "string", description: "Glob pattern." } },
        required: ["pattern"],
      },
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
      input_schema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "JS regex source, e.g. export function \\w+" },
          glob: { type: "string", description: "Restrict to files matching this glob." },
          ignore_case: { type: "boolean", description: "Case-insensitive match." },
        },
        required: ["pattern"],
      },
      summary: (i) => i.pattern + (i.glob ? `  in ${i.glob}` : ""),
      run({ pattern, glob, ignore_case }) {
        const hits = VFS.grep(pattern, { glob, flags: ignore_case ? "i" : "" });
        if (!hits.length) return `no match for /${pattern}/`;
        const shown = hits.slice(0, 200)
          .map((h) => `${h.path}:${h.line}: ${h.text.trim().slice(0, 200)}`).join("\n");
        return shown + (hits.length > 200 ? `\n… ${hits.length - 200} more matches` : "");
      },
    },

    /* ── workspace: write ─────────────────────────────────────────────────── */
    {
      name: "write",
      kind: "write",
      description:
        "Create or overwrite a workspace file with exact content. Overwrites without " +
        "warning, so `read` first if the file might already hold work worth keeping.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative path." },
          content: { type: "string", description: "Full file content." },
        },
        required: ["path", "content"],
      },
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
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative path." },
          old_string: { type: "string", description: "Exact text to find, including indentation." },
          new_string: { type: "string", description: "Replacement text." },
          replace_all: { type: "boolean", description: "Replace every occurrence." },
        },
        required: ["path", "old_string", "new_string"],
      },
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
      input_schema: {
        type: "object",
        properties: { path: { type: "string", description: "Workspace-relative path." } },
        required: ["path"],
      },
      summary: (i) => i.path,
      run({ path }) { return `deleted ${VFS.remove(path)}`; },
    },
    {
      name: "move",
      kind: "write",
      description: "Rename or move a workspace file. Overwrites the destination if it exists.",
      input_schema: {
        type: "object",
        properties: {
          from: { type: "string", description: "Existing path." },
          to: { type: "string", description: "New path." },
        },
        required: ["from", "to"],
      },
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
      input_schema: {
        type: "object",
        properties: {
          items: {
            type: "array",
            description: "The full task list, in order.",
            items: {
              type: "object",
              properties: {
                text: { type: "string", description: "What the step accomplishes." },
                status: { type: "string", enum: ["pending", "active", "done"], description: "Step state." },
              },
              required: ["text", "status"],
            },
          },
        },
        required: ["items"],
      },
      summary: (i) => {
        const items = i.items || [];
        return `${items.filter((t) => t.status === "done").length}/${items.length} done`;
      },
      run({ items }) {
        const mark = { pending: "[ ]", active: "[~]", done: "[x]" };
        return items.map((t) => `${mark[t.status] || "[ ]"} ${t.text}`).join("\n");
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
      input_schema: {
        type: "object",
        properties: {
          code: { type: "string", description: "Statements to run. `return` a value to see it." },
          timeout_ms: { type: "integer", description: "Give up after this long (default 15000)." },
        },
        required: ["code"],
      },
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
      input_schema: {
        type: "object",
        properties: {
          entry: { type: "string", description: "Workspace path of the module to run." },
          timeout_ms: { type: "integer", description: "Give up after this long (default 20000)." },
        },
        required: ["entry"],
      },
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
      input_schema: {
        type: "object",
        properties: { path: { type: "string", description: "Workspace path to an .html file." } },
        required: ["path"],
      },
      summary: (i) => i.path,
      async run({ path }) {
        await hooks.preview(path);
        return `mounted ${VFS.norm(path)} in the PREVIEW pane — tell the user to look at it`;
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
      input_schema: {
        type: "object",
        properties: {
          url: { type: "string", description: "Absolute http(s) URL." },
          max_chars: { type: "integer", description: "Truncate the body (default 20000)." },
        },
        required: ["url"],
      },
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
      input_schema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Package name, e.g. blocks.ai" },
          version: { type: "string", description: "Specific version (default: latest)." },
        },
        required: ["name"],
      },
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
      input_schema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Package name." },
          path: { type: "string", description: "File inside the package, e.g. dist/index.d.ts" },
          version: { type: "string", description: "Version or tag (default latest)." },
          max_chars: { type: "integer", description: "Truncate (default 20000)." },
        },
        required: ["name"],
      },
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
      input_schema: {
        type: "object",
        properties: {
          framework: { type: "string", description: "Framework id, or 'harness' for the sandbox notes." },
        },
        required: [],
      },
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
      input_schema: {
        type: "object",
        properties: {
          framework: { type: "string", description: "Framework id from framework_docs." },
          directory: { type: "string", description: "Workspace directory to write into, e.g. demo" },
        },
        required: ["framework", "directory"],
      },
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
      input_schema: {
        type: "object",
        properties: { filename: { type: "string", description: "Archive name (default agent-workspace.zip)." } },
        required: [],
      },
      summary: (i) => i.filename || "agent-workspace.zip",
      run({ filename = "agent-workspace.zip" } = {}) {
        if (!VFS.count()) throw new Error("workspace is empty; nothing to export");
        const name = filename.endsWith(".zip") ? filename : filename + ".zip";
        Zip.download(name, Zip.build(VFS.snapshot()));
        return `downloading ${name} — ${VFS.count()} file(s), ${VFS.bytes()} bytes`;
      },
    },
  ];

  /** Format a Sandbox result for the model: logs first, then value or error. */
  function report(r) {
    const logs = r.logs.length
      ? r.logs.map((l) => (l.level === "log" ? "" : `[${l.level}] `) + l.text).join("\n")
      : "(no console output)";
    if (!r.ok) return `FAILED\n${logs}\n\nerror: ${r.error}`;
    return `OK\n${logs}\n\nreturned: ${r.value === undefined ? "undefined" : r.value}`;
  }

  const byName = Object.fromEntries(DEFS.map((d) => [d.name, d]));

  return {
    hooks,
    defs: DEFS,

    /** Tool declarations in the shape every provider adapter starts from. */
    schemas() {
      return DEFS.map((d) => ({
        name: d.name,
        description: d.description,
        input_schema: d.input_schema,
      }));
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

    async run(name, input) {
      const def = byName[name];
      if (!def) throw new Error(`unknown tool '${name}'. Available: ${DEFS.map((d) => d.name).join(", ")}`);
      const out = await def.run(input || {});
      return String(out ?? "(no output)");
    },
  };
})();
