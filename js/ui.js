/* ═══════════════════════════════════════════════════════════════════════════
   UI — transcript, panels, and the approval gate.

   Deliberately thin: layout, tabs, and disclosure all live in CSS. This file
   only creates nodes and sets text. It never sets an inline style.
   ═══════════════════════════════════════════════════════════════════════════ */
window.UI = (function () {
  const $ = (id) => document.getElementById(id);
  const log = $("log");

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  /** Stick to the bottom only when the user is already there. */
  function autoscroll() {
    const slack = log.scrollHeight - log.scrollTop - log.clientHeight;
    if (slack < 120) log.scrollTop = log.scrollHeight;
  }

  /* ── what the mascot is caught doing while a task runs ────────────────────
     One word into body[data-busy] and the stylesheet swaps in a whole kit:
     props, arms, caption. Rolled once per run rather than per step, so a
     six-step task is one continuous scene instead of a slideshow.
     `?busy=phone` pins one, which is what screenshots and CSS work want. */
  const BUSY_KITS = ["phone", "keys", "bowl", "board"];
  const pinnedKit = new URLSearchParams(location.search).get("busy");

  function rollBusyKit() {
    document.body.dataset.busy = BUSY_KITS.includes(pinnedKit)
      ? pinnedKit
      : BUSY_KITS[Math.floor(Math.random() * BUSY_KITS.length)];
  }

  function entry(cls, who) {
    const node = el("article", "entry " + cls);
    if (who) node.appendChild(el("span", "who", who));
    log.appendChild(node);
    autoscroll();
    return node;
  }

  /* ── the light markdown the model actually emits ────────────────────────── */

  const escape = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

  function format(text) {
    return text.split(/```/).map((chunk, i) => {
      if (i % 2) return `<span class="fence">${escape(chunk.replace(/^[\w.-]*\n/, ""))}</span>`;
      return escape(chunk)
        .replace(/`([^`\n]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
        .replace(/^#{1,6}\s+(.+)$/gm, "<strong>$1</strong>")
        .replace(/^\s*[-*]\s+(.+)$/gm, '<span class="bullet">• $1</span>');
    }).join("");
  }

  /* ── transcript writers ─────────────────────────────────────────────────── */

  const api = {
    user(text) {
      entry("user", "you").appendChild(el("pre", null, text));
    },

    system(text) {
      entry("system").appendChild(el("pre", null, text));
    },

    error(text) {
      entry("error", "harness").appendChild(el("pre", null, text));
    },

    /** Drop every transcript entry, including the boot banner. */
    clearLog() { log.replaceChildren(); },

    closeViewer() { $("viewer").hidden = true; },

    /** Open a live assistant entry; returns a handle for streaming into. */
    assistant() {
      const node = entry("model live", "buttercup");
      const body = el("span", "body");
      node.appendChild(body);
      return { node, body, raw: "", think: null };
    },

    text(view, delta) {
      view.raw += delta;
      view.body.appendChild(document.createTextNode(delta));
      autoscroll();
    },

    thinking(view, delta) {
      if (!view.think) {
        const box = el("details", "think");
        box.appendChild(el("summary", null, "reasoning"));
        box.appendChild(el("pre"));
        view.node.insertBefore(box, view.body);
        view.think = box.querySelector("pre");
      }
      view.think.appendChild(document.createTextNode(delta));
      autoscroll();
    },

    assistantEnd(view) {
      view.node.classList.remove("live");
      // Re-render once at the end so fences and emphasis land without
      // re-parsing markdown on every token.
      if (view.raw) view.body.innerHTML = format(view.raw);
      else if (!view.think) view.node.remove();
      autoscroll();
    },

    /** Collapsible tool-call record. Returns a handle for the result. */
    toolStart(name, input) {
      const box = el("details", "call");
      const head = el("summary");
      head.appendChild(el("span", "tname", name));
      head.appendChild(el("span", "tsum", Tools.summarize(name, input)));
      const flag = el("span", "tflag", "running");
      head.appendChild(flag);
      box.appendChild(head);

      const pre = el("pre");
      pre.textContent = "in: " + JSON.stringify(input ?? {}, null, 2);
      box.appendChild(pre);

      log.appendChild(box);
      autoscroll();
      return { box, flag, pre };
    },

    toolEnd(handle, { ok, output }) {
      handle.box.classList.add(ok ? "ok" : "err");
      handle.flag.textContent = ok ? "ok" : "failed";
      handle.pre.textContent += "\n\nout: " + (output || "").slice(0, 20000);
      if (!ok) handle.box.open = true;
      autoscroll();
    },

    /** Live console output from the sandbox, so long runs are not silent. */
    sandboxLog(msg) {
      api.system(`  ${msg.level === "log" ? "·" : "!"} ${msg.text}`);
    },

    /** Blocking approval strip. Resolves "allow" | "always" | "deny". */
    approve(name, input) {
      return new Promise((resolve) => {
        const box = el("div", "approve");
        box.appendChild(el("p", null, `${name} wants to run: ${Tools.summarize(name, input) || "(no arguments)"}`));
        const btns = el("div", "btns");
        const choose = (label, verdict, cls) => {
          const b = el("button", cls, label);
          b.type = "button";
          b.addEventListener("click", () => {
            box.replaceChildren(el("p", null, `${name}: ${verdict}`));
            resolve(verdict);
          });
          btns.appendChild(b);
        };
        choose("ALLOW", "allow");
        choose("ALLOW ALL", "always");
        choose("DENY", "deny", "danger");
        box.appendChild(btns);
        log.appendChild(box);
        log.scrollTop = log.scrollHeight;
      });
    },

    /* ── panels ───────────────────────────────────────────────────────────── */

    status(state, label) {
      const node = $("status");
      node.dataset.state = state;
      node.textContent = label || state.toUpperCase();
      /* the mascot reads its mood off the body; the CSS does the rest. */
      const was = document.body.dataset.agent;
      document.body.dataset.agent = state;
      if (state === "busy" && was !== "busy") rollBusyKit();
    },

    stats({ provider, model, mode, tokens, context, limit, steps }) {
      $("stat-provider").textContent = `${provider} · ${model}`;
      $("stat-mode").textContent = mode;
      $("stat-tokens").textContent = `${tokens} tok`;
      // Context is what the next request will carry; the total above is what the
      // session has cost. They are different numbers and both matter.
      const ctx = $("stat-context");
      ctx.textContent = limit ? `ctx ~${context}/${limit}` : `ctx ~${context}`;
      ctx.dataset.state = limit && context >= limit * 0.8 ? "high" : "";
      $("stat-steps").textContent = `step ${steps}`;
      $("stat-files").textContent = `${VFS.count()} files`;
    },

    renderTools() {
      const list = $("tools");
      list.replaceChildren();
      for (const def of Tools.defs) {
        const li = el("li");
        const box = el("details");
        const head = el("summary");
        head.appendChild(el("span", "tname", def.name));
        head.appendChild(el("span", "tag " + def.kind, def.kind));
        box.appendChild(head);
        box.appendChild(el("p", "desc", def.description));

        const props = def.input_schema.properties || {};
        const required = def.input_schema.required || [];
        if (Object.keys(props).length) {
          const dl = el("dl");
          for (const [key, spec] of Object.entries(props)) {
            const dt = el("dt", null, `${key}: ${spec.type || "any"}`);
            if (required.includes(key)) dt.appendChild(el("span", "req", " *"));
            dl.appendChild(dt);
            dl.appendChild(el("dd", null, spec.description || ""));
          }
          box.appendChild(dl);
        } else {
          box.appendChild(el("p", "desc dim", "no arguments"));
        }
        li.appendChild(box);
        list.appendChild(li);
      }
      $("tool-count").textContent = `${Tools.defs.length} tools`;
    },

    renderTree() {
      const tree = $("tree");
      tree.replaceChildren();
      const paths = VFS.paths();
      if (!paths.length) {
        tree.appendChild(el("li", "dim", "empty workspace"));
        return;
      }
      for (const path of paths) {
        const li = el("li");
        li.appendChild(el("span", "glyph", path.includes("/") ? "└" : "·"));
        const open = el("button", null, path);
        open.type = "button";
        open.addEventListener("click", () => api.view(path));
        li.appendChild(open);
        li.appendChild(el("span", "size", `${VFS.read(path).length}b`));
        tree.appendChild(li);
      }
    },

    view(path) {
      $("viewer").hidden = false;
      $("viewer-path").textContent = path;
      $("viewer-body").textContent = VFS.read(path);
    },

    async mountPreview(path) {
      const frame = $("preview");
      frame.hidden = false;
      $("preview-empty").hidden = true;
      $("tab-preview").checked = true;
      const result = await Sandbox.preview(path, frame);
      if (!result.ok) throw new Error(result.error);
      return result;
    },
  };

  return api;
})();
