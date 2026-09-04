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
  const BUSY_KITS = ["phone", "keys", "bowl", "board", "oven", "brew", "books", "button"];
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

  /* ── the markdown the model actually emits ────────────────────────────────
     A block renderer, not a line of regexes: the model writes tables, nested
     lists and fences, and a per-line pass flattens all three into one wall of
     prose. Scope is what a coding agent emits — headings, lists (task lists
     included), tables, fences, quotes, rules, and the usual inline spans. No
     reference links, no HTML passthrough, no setext headings.

     Every element comes out as a bare tag under `.body`; the stylesheet dresses
     it. Nothing here sets a style, same rule as the rest of this file.
     ─────────────────────────────────────────────────────────────────────────── */

  const escape = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

  /* Sentinel for a lifted-out code span. A NUL cannot appear in model text. */
  const MARK = "\u0000";

  const FENCE = /^ {0,3}(?:```|~~~)/;
  const RULE = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
  const HEAD = /^ {0,3}(#{1,6})\s+(.*)$/;
  const QUOTE = /^ {0,3}>\s?(.*)$/;
  const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
  const indentOf = (line) => line.match(/^\s*/)[0].length;

  /**
   * Inline spans. Code is lifted out first and put back last, so nothing
   * formats inside a code span — the one place `*` and `_` are literal.
   */
  function inline(text) {
    const code = [];
    let s = escape(text).replace(/`([^`]+)`/g, (_, c) => MARK + (code.push(c) - 1) + MARK);
    s = s
      .replace(/!?\[([^\]\n]*)\]\((https?:\/\/[^)\s]+)\)/g,
        (_, label, href) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${label || href}</a>`)
      .replace(/\*\*([^\n]+?)\*\*/g, "<strong>$1</strong>")
      .replace(/~~([^\n]+?)~~/g, "<del>$1</del>")
      .replace(/(^|[\s(])\*([^*\n]+?)\*(?=[\s.,;:!?)]|$)/g, "$1<em>$2</em>")
      .replace(/(^|[\s(])_([^_\n]+?)_(?=[\s.,;:!?)]|$)/g, "$1<em>$2</em>");
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${code[i]}</code>`);
  }

  /** One list item's own text: a `- [ ]` box becomes a glyph, not a literal. */
  function itemBody(text) {
    const box = text.match(/^\[([ xX])\]\s*(.*)$/);
    if (!box) return inline(text);
    return `<span class="box">${box[1] === " " ? "☐" : "☑"}</span>${inline(box[2])}`;
  }

  const cells = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
  const isDelim = (line) => !!line && line.includes("|") && cells(line).every((c) => /^:?-+:?$/.test(c));

  /** A table is a row of cells with a `|---|:--:|` rule under it, and nothing else. */
  const isTable = (lines, i) => !!lines[i] && lines[i].includes("|") && isDelim(lines[i + 1]);

  function table(lines, start) {
    const head = cells(lines[start]);
    const align = cells(lines[start + 1]).map((c) => (/^:-+:$/.test(c) ? "c" : /-+:$/.test(c) ? "r" : ""));
    const rows = [];
    let i = start + 2;
    while (i < lines.length && lines[i].includes("|")) rows.push(cells(lines[i++]));
    const cell = (tag, text, j) =>
      `<${tag}${align[j] ? ` class="${align[j]}"` : ""}>${inline(text || "")}</${tag}>`;
    const body = rows.length
      ? `<tbody>${rows.map((r) => `<tr>${head.map((_, j) => cell("td", r[j], j)).join("")}</tr>`).join("")}</tbody>`
      : "";
    return {
      html: `<table class="md"><thead><tr>${head.map((c, j) => cell("th", c, j)).join("")}</tr></thead>${body}</table>`,
      next: i,
    };
  }

  /**
   * One list, however deep. Items open a nested list when their indent grows
   * and close back when it shrinks; a list of the other kind at the same level
   * ends this one, so `format` starts a fresh list beside it. A continuation
   * line — indented, no marker — folds into the item above rather than becoming
   * a block, which is the deliberate limit here.
   */
  function list(lines, start) {
    const frames = [];
    let i = start;

    const render = (f) =>
      `<${f.tag} class="md"${f.tag === "ol" && f.first !== 1 ? ` start="${f.first}"` : ""}>` +
      f.items.map((h) => `<li>${h}</li>`).join("") + `</${f.tag}>`;

    /** Close the innermost list into its parent item, or return it when done. */
    const fold = () => {
      const done = render(frames.pop());
      if (!frames.length) return done;
      const up = frames[frames.length - 1];
      up.items[up.items.length - 1] += done;
      return null;
    };

    while (i < lines.length) {
      const line = lines[i];

      // A gap keeps a loose list together, but only for more of the same list.
      if (!line.trim()) {
        const next = lines[i + 1] || "";
        const nm = next.match(ITEM);
        if (!nm) break;
        const base = frames[0];
        if (indentOf(next) <= base.indent + 1 && (/^\d/.test(nm[2]) ? "ol" : "ul") !== base.tag) break;
        i++;
        continue;
      }

      const m = line.match(ITEM);
      const indent = indentOf(line);
      if (!m) {
        if (indent < 2) break;   // back to prose
        const top = frames[frames.length - 1];
        top.items[top.items.length - 1] += "<br>" + inline(line.trim());
        i++;
        continue;
      }

      const tag = /^\d/.test(m[2]) ? "ol" : "ul";
      while (frames.length > 1 && indent < frames[frames.length - 1].indent) fold();
      const top = frames[frames.length - 1];
      if (!top || indent > top.indent + 1) {
        // `3.` opening a list means it starts at three, not at one.
        frames.push({ indent, tag, first: Number((m[2].match(/\d+/) || [1])[0]), items: [] });
      } else if (tag !== top.tag) {
        break;
      }
      frames[frames.length - 1].items.push(itemBody(m[3]));
      i++;
    }

    let html = "";
    while (frames.length) {
      const done = fold();
      if (done != null) html = done;
    }
    return { html, next: i };
  }

  /** True for a line that opens a block, i.e. one a paragraph cannot swallow. */
  const opensBlock = (line) =>
    FENCE.test(line) || RULE.test(line) || HEAD.test(line) || QUOTE.test(line) || ITEM.test(line);

  function format(text) {
    const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
    const out = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }

      if (FENCE.test(line)) {
        const body = [];
        i++;
        while (i < lines.length && !FENCE.test(lines[i])) body.push(lines[i++]);
        i++;   // the closing fence, or the end of a reply that never closed it
        out.push(`<pre class="fence">${escape(body.join("\n"))}</pre>`);
        continue;
      }

      if (RULE.test(line)) { out.push("<hr>"); i++; continue; }

      const head = line.match(HEAD);
      if (head) {
        out.push(`<p class="mdh h${head[1].length}">${inline(head[2])}</p>`);
        i++;
        continue;
      }

      if (QUOTE.test(line)) {
        const body = [];
        while (i < lines.length && QUOTE.test(lines[i])) body.push(lines[i++].match(QUOTE)[1]);
        out.push(`<blockquote>${format(body.join("\n"))}</blockquote>`);
        continue;
      }

      if (isTable(lines, i)) {
        const t = table(lines, i);
        out.push(t.html);
        i = t.next;
        continue;
      }

      if (ITEM.test(line)) {
        const l = list(lines, i);
        out.push(l.html);
        i = l.next > i ? l.next : i + 1;   // never stall on a line we cannot use
        continue;
      }

      // A paragraph runs to the next blank line or block opener. Its own line
      // breaks are kept: in a terminal transcript they are usually meant.
      const para = [];
      while (i < lines.length && lines[i].trim() && !opensBlock(lines[i]) && !isTable(lines, i)) {
        para.push(inline(lines[i++].trim()));
      }
      out.push(`<p>${para.join("<br>")}</p>`);
    }

    return out.join("");
  }

  /* ── transcript writers ─────────────────────────────────────────────────── */

  /** Thumbnails of the pictures on a turn, as one row under the text. */
  function shotRow(shots, cls) {
    const row = el("div", cls);
    for (const s of shots) {
      const img = document.createElement("img");
      img.src = Images.url(s);
      img.alt = s.name;
      img.title = `${s.name} — ${Images.label(s)}`;
      // Intrinsic size, so the row does not reflow as the thumbnails decode.
      img.width = s.width;
      img.height = s.height;
      row.appendChild(img);
    }
    return row;
  }

  /* Which workspace file the preview frame is showing — a screenshot of it is
     worth more to the model with the path attached to it. */
  let mounted = null;

  const api = {
    user(text, shots = []) {
      const node = entry("user", "you");
      if (text) node.appendChild(el("pre", null, text));
      if (shots.length) node.appendChild(shotRow(shots, "shots"));
    },

    system(text) {
      entry("system").appendChild(el("pre", null, text));
    },

    error(text) {
      entry("error", "harness").appendChild(el("pre", null, text));
    },

    /** Report something that threw: its message, or the thing itself. */
    fail(err) { api.error(String(err && err.message ? err.message : err)); },

    /** Drop every transcript entry, including the boot banner. */
    clearLog() { log.replaceChildren(); },

    closeViewer() { $("viewer").hidden = true; },

    /** The workspace file the viewer is showing, or "" when it is closed. */
    viewedPath() { return $("viewer").hidden ? "" : $("viewer-path").textContent; },

    /** Open a live assistant entry; returns a handle for streaming into. */
    assistant() {
      const node = entry("model live", "buttercup");
      const body = el("span", "body");
      node.appendChild(body);
      return { node, body, raw: "", think: null, frame: 0 };
    },

    /**
     * Markdown is rendered while the reply streams, so a half-arrived answer
     * reads like the finished one instead of like raw `**bold**` and `-` bullets.
     * Deltas land per token and the parse is linear in the reply so far, so
     * paints are coalesced to one per frame: the screen cannot show more.
     */
    text(view, delta) {
      view.raw += delta;
      if (view.frame) return;
      view.frame = requestAnimationFrame(() => {
        view.frame = 0;
        view.body.innerHTML = format(view.raw);
        autoscroll();
      });
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
      if (view.frame) { cancelAnimationFrame(view.frame); view.frame = 0; }
      // The last frame may never have run, and the closing tokens — a fence's
      // back-ticks, a table's final row — are the ones that change the shape.
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

    toolEnd(handle, { ok, output, shots }) {
      handle.box.classList.add(ok ? "ok" : "err");
      handle.flag.textContent = ok ? "ok" : "failed";
      handle.pre.textContent += "\n\nout: " + (output || "").slice(0, 20000);
      // A screenshot went to the model; the user sees the same picture, open,
      // since a tool result that is a picture is unreadable collapsed.
      if (shots && shots.length) {
        handle.box.appendChild(shotRow(shots, "shots"));
        handle.box.open = true;
      }
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

    /* A hairline bar across the very top of the page, for long loads with a
       real fraction to report (WebLLM fetching its weights). `null` hides it. */
    progress(frac) {
      const bar = $("load-bar");
      if (frac == null) { bar.hidden = true; return; }
      bar.hidden = false;
      bar.firstElementChild.style.width = `${Math.max(0, Math.min(1, frac)) * 100}%`;
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

    /**
     * Paint the strip of images the composer is holding. `drop(id)` removes one.
     * Hidden when there are none, same rule as the queue below it.
     */
    attachments(shots, { drop } = {}) {
      const box = $("attach");
      box.hidden = !shots.length;
      $("attach-head").textContent = shots.length > 1 ? `${shots.length} images` : "image";
      const list = $("attach-list");
      list.replaceChildren();
      for (const s of shots) {
        const li = el("li");
        const img = document.createElement("img");
        img.src = Images.url(s);
        img.alt = s.name;
        img.width = s.width;
        img.height = s.height;
        li.appendChild(img);
        li.appendChild(el("span", "aname", s.name));
        li.appendChild(el("span", "asize", Images.label(s)));
        const x = el("button", "mini", "×");
        x.type = "button";
        x.title = "remove this image";
        x.addEventListener("click", () => drop && drop(s.id));
        li.appendChild(x);
        list.appendChild(li);
      }
    },

    /**
     * Paint the waiting-requests strip. Each item is `{ text, shots }`.
     * `drop(i)` removes one, `clear()` drops
     * them all; both are handed in fresh on every paint so this stays stateless.
     * `paused` means the recall cursor is out of the composer and nothing here
     * is going to start; `editing` is the index it is standing on, or -1.
     */
    queue(items, { drop, clear, paused, editing = -1 } = {}) {
      const box = $("queue");
      box.hidden = !items.length;
      box.dataset.paused = paused ? "1" : "";
      // "on deck" and "held" rather than "queued" and "paused": this is a
      // counter with an order rail, not a job scheduler.
      $("queue-head").textContent = paused
        ? "held"
        : items.length > 1 ? `on deck ${items.length}` : "on deck";
      $("queue-clear").onclick = clear || null;
      const list = $("queue-list");
      list.replaceChildren();
      items.forEach((item, i) => {
        const li = el("li");
        // The line in the composer is marked where it sits, so the strip and
        // the box read as one thing rather than two copies of the request.
        if (i === editing) li.dataset.editing = "1";
        li.appendChild(el("span", "qn", i === editing ? "›" : `${i + 1}.`));
        const shots = item.shots || [];
        li.appendChild(el("span", "qtext",
          (shots.length ? `[${shots.length} image${shots.length > 1 ? "s" : ""}] ` : "") +
          (item.text || "").split("\n")[0]));
        const x = el("button", "mini", "×");
        x.type = "button";
        x.title = "remove from the queue";
        x.addEventListener("click", () => drop && drop(i));
        li.appendChild(x);
        list.appendChild(li);
      });
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

    /**
     * The workspace picker. Each row says how much is in that workspace, so
     * switching is a choice between projects rather than between names.
     */
    renderWorkspaces() {
      const pick = $("workspace-pick");
      const active = Workspaces.active();
      pick.replaceChildren();
      Workspaces.list().forEach((ws, i) => {
        const info = Workspaces.info(ws.id);
        const opt = document.createElement("option");
        opt.value = ws.id;
        opt.selected = ws.id === active.id;
        opt.textContent = `${i + 1}. ${ws.name} — ${info.files} file${info.files === 1 ? "" : "s"}` +
          (info.turns ? `, ${info.turns} msg` : "");
        pick.appendChild(opt);
      });
      // DELETE is about another workspace, and the last one cannot go at all.
      $("workspace-delete").disabled = Workspaces.count() < 2;
    },

    /** Let go of the preview frame — its file belongs to a workspace we left. */
    unmountPreview() {
      const frame = $("preview");
      Drive.release(frame);
      frame.hidden = true;
      frame.removeAttribute("srcdoc");
      frame.src = "about:blank";
      $("preview-empty").hidden = false;
      $("preview-shot").disabled = true;
      mounted = null;
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
      // Whatever the last page needed, this one is measured from the pane's own
      // height up. js/drive.js grows the frame again once the page reports in.
      Drive.release(frame);
      frame.hidden = false;
      $("preview-empty").hidden = true;
      $("tab-preview").checked = true;
      const result = await Sandbox.preview(path, frame);
      // Only a mounted frame has anything to photograph, so SEND TO MODEL waits
      // for one — and stays out of reach if the mount failed.
      $("preview-shot").disabled = !result.ok;
      if (!result.ok) throw new Error(result.error);
      mounted = path;
      return result;
    },

    /** The workspace file currently in the preview frame, if any. */
    mountedPreview() { return mounted; },

    /**
     * The mounted frame, on screen and laid out. A hidden panel is
     * `display:none`, which leaves the iframe with a zero-size viewport — so
     * `elementFromPoint` finds nothing and a screenshot comes back 1×1. Both
     * the driver and the camera therefore bring the pane forward first, which
     * is also what the user wants to be looking at while the model clicks.
     */
    async liveFrame() {
      const frame = $("preview");
      if (frame.hidden || !mounted) {
        throw new Error("nothing is mounted in the PREVIEW pane — call `preview` with an .html path first");
      }
      $("tab-preview").checked = true;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return frame;
    },

    /** Click, type or look around inside the preview — the `navigate` tool. */
    async drivePreview(job) {
      return Drive.act(await api.liveFrame(), job);
    },

    /**
     * Photograph the preview for the model. Pinned to 1× so image pixels are
     * the frame's CSS pixels: a coordinate the model reads off the picture is
     * one `navigate` can click without any arithmetic in between.
     */
    async shootPreview() {
      const frame = await api.liveFrame();
      const name = `preview-${String(mounted || "frame").replace(/[^\w.-]+/g, "-")}.png`;
      const { file, skipped, width, height } = await Capture.frame(frame, name, { scale: 1 });
      // Through js/images.js like any other picture, so the size and format the
      // vendors accept are decided in exactly one place.
      const { shots, errors } = await Images.load([file]);
      if (!shots.length) throw new Error(errors[0] || "the screenshot could not be prepared for the model");
      return { shot: shots[0], skipped, viewport: { w: width, h: height } };
    },
  };

  return api;
})();
