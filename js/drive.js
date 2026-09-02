/* ═══════════════════════════════════════════════════════════════════════════
   Drive — hands and eyes inside the preview frame.

   The preview is a `sandbox="allow-scripts"` iframe with an opaque origin, so
   this page cannot reach its DOM: no `contentDocument`, no synthesising a click
   on a node out here. Same problem js/capture.js has, and the same answer — the
   frame drives itself. `Drive.source()` is a self-contained script that
   js/sandbox.js injects into every mounted preview alongside the screenshot one;
   on request it finds the element at a coordinate (or a selector), dispatches
   the event sequence a real pointer or keyboard would, and reports back what it
   hit and what the page did about it.

   Synthetic events are not trusted events. Activation behaviour still runs — a
   dispatched `click` toggles a checkbox, follows a link, submits a form — but a
   keydown of Enter does not submit anything on its own, and nothing here can
   grant a page a permission it would otherwise have to ask for. Where that
   matters the report says so rather than pretending the interaction was real.

   The frame also keeps its own console noise since the last action: a preview is
   mounted and then left alone, so the errors a click causes have nobody
   listening for them, and an agent testing a page needs them more than anyone.
   ═══════════════════════════════════════════════════════════════════════════ */
window.Drive = (function () {

  /* ── the driver, as it runs inside the preview ────────────────────────────
     Shipped as source text and re-parsed in the frame's realm, so it must not
     close over anything out here. Kept as a function rather than a string so it
     stays readable, and syntax-checked at load like the rest of the file.
     ───────────────────────────────────────────────────────────────────────── */
  function DRIVER() {
    const post = (msg) => parent.postMessage(Object.assign({ bc: 1 }, msg), "*");

    /* ── what the page said since the last action ─────────────────────────── */
    const noise = [];
    const NOISE_CAP = 40;

    function fmt(v) {
      if (typeof v === "string") return v;
      if (v instanceof Error) return v.stack || String(v);
      try { return JSON.stringify(v); } catch (_) { return String(v); }
    }

    function record(level, text) {
      if (noise.length >= NOISE_CAP) return;
      noise.push(`[${level}] ${String(text).slice(0, 600)}`);
    }

    // Wrapped, not replaced: js/sandbox.js already mirrors the console to the
    // harness transcript, and the page's own logging must keep working.
    for (const level of ["warn", "error"]) {
      const native = console[level] && console[level].bind(console);
      console[level] = (...args) => {
        record(level, args.map(fmt).join(" "));
        if (native) native(...args);
      };
    }
    addEventListener("error", (e) => record("error", "uncaught: " + (e.message || e)));
    addEventListener("unhandledrejection", (e) => record("error", "unhandled rejection: " + fmt(e.reason)));

    /** Drain the buffer — every report carries only what is new. */
    function drain() {
      const out = noise.slice();
      noise.length = 0;
      return out;
    }

    /* ── describing what we touched ──────────────────────────────────────── */

    const ATTRS = ["type", "name", "placeholder", "aria-label", "title", "href", "value"];

    /** A node as a line the model can recognise in the page's own source. */
    function label(node) {
      if (!node) return "nothing";
      if (node === document.documentElement) return "<html>";
      if (node === document.body) return "<body>";
      let head = (node.tagName || node.nodeName || "?").toLowerCase();
      if (node.id) head += "#" + node.id;
      const cls = String((node.getAttribute && node.getAttribute("class")) || "")
        .trim().split(/\s+/).filter(Boolean).slice(0, 2);
      if (cls.length) head += "." + cls.join(".");
      const attrs = [];
      for (const name of ATTRS) {
        const value = node.getAttribute && node.getAttribute(name);
        if (value) attrs.push(`${name}="${String(value).slice(0, 40)}"`);
      }
      const text = String(node.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60);
      return `<${head}${attrs.length ? " " + attrs.join(" ") : ""}>` + (text ? ` "${text}"` : "");
    }

    /** Where the frame is now: size, scroll, focus. */
    function state() {
      const view = document.documentElement;
      const bits = [
        `viewport ${Math.round(innerWidth)}x${Math.round(innerHeight)} css px`,
        `page ${Math.round(view.scrollWidth)}x${Math.round(view.scrollHeight)}`,
        `scroll ${Math.round(scrollX)},${Math.round(scrollY)}`,
      ];
      const focus = document.activeElement;
      if (focus && focus !== document.body) bits.push(`focus ${label(focus)}`);
      if (document.title) bits.push(`title "${String(document.title).slice(0, 60)}"`);
      return bits.join(" · ");
    }

    /* ── finding a target ─────────────────────────────────────────────────── */

    /** The topmost element at a viewport coordinate, or a reason there is none. */
    function at(x, y) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("x and y are required for this action");
      if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) {
        throw new Error(
          `${x},${y} is outside the preview viewport (${Math.round(innerWidth)}x${Math.round(innerHeight)} css px). ` +
          `Scroll, or take a screenshot and read the coordinate off that.`
        );
      }
      const node = document.elementFromPoint(x, y);
      if (!node) throw new Error(`nothing is painted at ${x},${y}`);
      return node;
    }

    /** A selector, a coordinate, or whatever has focus — in that order. */
    function target(job, { fallbackToFocus = false } = {}) {
      if (job.selector) {
        let node;
        try { node = document.querySelector(job.selector); }
        catch (_) { throw new Error(`'${job.selector}' is not a valid CSS selector`); }
        if (!node) throw new Error(`no element matches '${job.selector}' — try the inspect action`);
        return node;
      }
      if (Number.isFinite(job.x) && Number.isFinite(job.y)) return at(job.x, job.y);
      if (fallbackToFocus) {
        const focus = document.activeElement;
        if (focus && focus !== document.body) return focus;
        throw new Error("nothing is focused — pass a selector, or click the element first");
      }
      throw new Error("pass either x and y, or a selector");
    }

    /** The centre of an element in viewport coordinates, scrolled into view. */
    function centre(node) {
      let box = node.getBoundingClientRect();
      if (box.bottom < 0 || box.top > innerHeight || box.right < 0 || box.left > innerWidth) {
        node.scrollIntoView({ block: "center", inline: "center" });
        box = node.getBoundingClientRect();
      }
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    }

    /* ── event sequences ─────────────────────────────────────────────────── */

    const FOCUSABLE = "a[href], button, input, textarea, select, summary, [tabindex], [contenteditable]";

    function pointer(node, type, x, y, button, detail) {
      const init = {
        bubbles: true, cancelable: true, composed: true, view: window,
        clientX: x, clientY: y, screenX: x, screenY: y,
        button: button || 0,
        buttons: /down|move/.test(type) ? (button === 2 ? 2 : 1) : 0,
        detail: detail || 1,
        pointerId: 1, pointerType: "mouse", isPrimary: true,
      };
      const Ctor = type.startsWith("pointer") ? (window.PointerEvent || MouseEvent) : MouseEvent;
      node.dispatchEvent(new Ctor(type, init));
    }

    /**
     * One press of the mouse. `kind` picks the trailing event: a plain click, a
     * double click (which browsers deliver as click, click, dblclick) or the
     * context menu. Focus is moved first, the way a real press does, so a
     * handler reading `document.activeElement` sees what it would see.
     */
    function press(node, x, y, kind) {
      const button = kind === "right_click" ? 2 : 0;
      pointer(node, "pointermove", x, y, button);
      pointer(node, "mousemove", x, y, button);
      pointer(node, "pointerdown", x, y, button);
      pointer(node, "mousedown", x, y, button);
      if (node.focus && node.matches && node.matches(FOCUSABLE)) {
        try { node.focus(); } catch (_) { /* a disabled or detached node */ }
      }
      pointer(node, "pointerup", x, y, button);
      pointer(node, "mouseup", x, y, button);
      if (kind === "right_click") {
        pointer(node, "contextmenu", x, y, 2);
        return;
      }
      pointer(node, "click", x, y, 0, 1);
      if (kind === "double_click") {
        pointer(node, "click", x, y, 0, 2);
        pointer(node, "dblclick", x, y, 0, 2);
      }
    }

    const codeOf = (key) =>
      key.length === 1 && /[a-z]/i.test(key) ? "Key" + key.toUpperCase()
      : key.length === 1 && /[0-9]/.test(key) ? "Digit" + key
      : key === " " ? "Space" : key;

    function keyEvent(node, type, key) {
      const event = new KeyboardEvent(type, {
        key, code: codeOf(key), bubbles: true, cancelable: true, composed: true, view: window,
      });
      node.dispatchEvent(event);
      return event;
    }

    const isField = (node) => {
      const tag = (node.tagName || "").toLowerCase();
      return tag === "input" || tag === "textarea";
    };

    /** Text into the value, plus the `input` event every framework listens for. */
    function insert(node, text) {
      if (isField(node)) node.value += text;
      else node.textContent += text;
      node.dispatchEvent(new InputEvent("input", {
        bubbles: true, composed: true, data: text, inputType: "insertText",
      }));
    }

    function erase(node) {
      if (isField(node)) node.value = node.value.slice(0, -1);
      else node.textContent = String(node.textContent).slice(0, -1);
      node.dispatchEvent(new InputEvent("input", {
        bubbles: true, composed: true, inputType: "deleteContentBackward",
      }));
    }

    /**
     * Type into a field. Characters land one at a time with their key events
     * around them, since a page that filters or reformats as you type does that
     * work per keystroke. `<select>` is not typed into at all — the equivalent
     * is choosing an option, which is what happens instead.
     */
    function typeInto(node, text, clear) {
      const tag = (node.tagName || "").toLowerCase();

      if (tag === "select") {
        const wanted = String(text);
        const option = [...node.options].find((o) => o.value === wanted) ||
          [...node.options].find((o) => o.textContent.trim() === wanted) ||
          [...node.options].find((o) => o.textContent.trim().toLowerCase().includes(wanted.toLowerCase()));
        if (!option) {
          throw new Error(`no option matching '${wanted}' in ${label(node)} — options: ` +
            [...node.options].map((o) => o.value || o.textContent.trim()).join(", "));
        }
        node.value = option.value;
        node.dispatchEvent(new Event("input", { bubbles: true }));
        node.dispatchEvent(new Event("change", { bubbles: true }));
        return `selected "${option.textContent.trim()}" in ${label(node)}`;
      }

      if (!isField(node) && !node.isContentEditable) {
        throw new Error(`cannot type into ${label(node)} — it is not an input, textarea, select or contenteditable`);
      }
      if (node.disabled || node.readOnly) throw new Error(`${label(node)} is disabled or read-only`);

      try { node.focus(); } catch (_) { /* keep going; the events still fire */ }
      if (clear) {
        if (isField(node)) node.value = "";
        else node.textContent = "";
        node.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
      }

      for (const ch of Array.from(String(text))) {
        const down = keyEvent(node, "keydown", ch);
        if (!down.defaultPrevented) insert(node, ch);
        keyEvent(node, "keyup", ch);
      }
      // `change` fires on commit for a real user, which is a blur or an Enter;
      // a page that only listens for it would otherwise never see the text.
      node.dispatchEvent(new Event("change", { bubbles: true }));
      const value = isField(node) ? node.value : node.textContent;
      return `typed ${JSON.stringify(String(text))} into ${label(node)} — value is now ` +
             JSON.stringify(String(value).slice(0, 200));
    }

    const EDIT_KEYS = { Backspace: 1, Delete: 1 };

    /** A named key, `repeat` times, at whatever is focused or was pointed at. */
    function pressKey(node, key, repeat) {
      const times = Math.max(1, Math.min(50, Number(repeat) || 1));
      let edited = false;
      for (let i = 0; i < times; i++) {
        const down = keyEvent(node, "keydown", key);
        const editable = isField(node) || node.isContentEditable;
        if (!down.defaultPrevented && editable) {
          if (key.length === 1) { insert(node, key); edited = true; }
          else if (EDIT_KEYS[key]) { erase(node); edited = true; }
        }
        keyEvent(node, "keyup", key);
      }
      let note = `pressed ${key}${times > 1 ? ` x${times}` : ""} at ${label(node)}`;
      if (edited) note += " — value is now " + JSON.stringify(String(isField(node) ? node.value : node.textContent).slice(0, 200));
      if (key === "Enter") {
        const form = node.form || (node.closest && node.closest("form"));
        if (form) {
          note += ". Note: a synthetic Enter does not submit a form the way a real one does — " +
                  "if the page relies on native submission, click its submit button instead.";
        }
      }
      return note;
    }

    /* ── looking around ──────────────────────────────────────────────────── */

    const INTERACTIVE = [
      "a[href]", "button", "input", "select", "textarea", "summary", "label",
      "[role=button]", "[role=link]", "[role=tab]", "[role=checkbox]", "[role=menuitem]",
      "[onclick]", "[contenteditable]", "[tabindex]",
    ].join(", ");

    const visible = (box, node) => {
      if (box.width < 1 || box.height < 1) return false;
      if (box.bottom < 0 || box.top > innerHeight || box.right < 0 || box.left > innerWidth) return false;
      const style = getComputedStyle(node);
      return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) !== 0;
    };

    /** Every interactive element on screen, with the coordinate to click it. */
    function inspect(limit) {
      const rows = [];
      for (const node of document.querySelectorAll(INTERACTIVE)) {
        const box = node.getBoundingClientRect();
        if (!visible(box, node)) continue;
        rows.push(
          `${String(Math.round(box.left + box.width / 2)).padStart(5)},` +
          `${String(Math.round(box.top + box.height / 2)).padEnd(5)}  ` +
          `${Math.round(box.width)}x${Math.round(box.height)}  ` +
          (node.disabled ? "[disabled] " : "") + label(node)
        );
        if (rows.length >= limit) break;
      }
      if (!rows.length) return "no interactive elements are visible in the viewport";
      return `${rows.length} interactive element(s) on screen — "x,y  w×h  element":\n${rows.join("\n")}`;
    }

    /** The page as a reader sees it, which is often all the check needs. */
    function readText(max) {
      const text = String((document.body && document.body.innerText) || "").replace(/\n{3,}/g, "\n\n").trim();
      if (!text) return "the page renders no text";
      return text.length > max ? text.slice(0, max) + `\n… truncated at ${max} chars (${text.length} total)` : text;
    }

    /* ── the actions ─────────────────────────────────────────────────────── */

    /** Two frames and a beat: long enough for a handler and a re-render. */
    const settle = () => new Promise((done) =>
      requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 40))));

    async function perform(job) {
      const action = job.action;

      if (action === "inspect") return inspect(Math.max(1, Math.min(200, Number(job.limit) || 60)));
      if (action === "text") return readText(Math.max(200, Math.min(20000, Number(job.max_chars) || 6000)));

      if (action === "scroll") {
        const dx = Number(job.dx) || 0;
        const dy = Number(job.dy) || 0;
        const node = job.selector ? target(job) : null;
        if (node) {
          node.scrollIntoView({ block: "center", inline: "center" });
          await settle();
          return `scrolled ${label(node)} into view`;
        }
        if (!dx && !dy) throw new Error("scroll needs dx/dy, or a selector to bring into view");
        const before = { x: Math.round(scrollX), y: Math.round(scrollY) };
        scrollBy(dx, dy);
        await settle();
        const moved = Math.round(scrollX) - before.x || Math.round(scrollY) - before.y;
        return `scrolled by ${dx},${dy} — now at ${Math.round(scrollX)},${Math.round(scrollY)}` +
               (moved ? "" : " (nothing moved; the page may not scroll)");
      }

      if (action === "type") {
        const node = target(job, { fallbackToFocus: true });
        const text = job.text;
        if (typeof text !== "string" || !text.length) throw new Error("type needs `text`");
        const note = typeInto(node, text, !!job.clear);
        await settle();
        return note;
      }

      if (action === "key") {
        const key = job.key;
        if (!key) throw new Error("key needs `key`, e.g. Enter, Tab, Escape, ArrowDown");
        const node = target(job, { fallbackToFocus: true });
        const note = pressKey(node, String(key), job.repeat);
        await settle();
        return note;
      }

      if (action === "hover") {
        const node = target(job);
        const point = job.selector ? centre(node) : { x: job.x, y: job.y };
        pointer(node, "pointerover", point.x, point.y, 0);
        pointer(node, "mouseover", point.x, point.y, 0);
        pointer(node, "pointermove", point.x, point.y, 0);
        pointer(node, "mousemove", point.x, point.y, 0);
        await settle();
        return `hovered ${Math.round(point.x)},${Math.round(point.y)} → ${label(node)}`;
      }

      if (action === "click" || action === "double_click" || action === "right_click") {
        const node = target(job);
        const point = job.selector ? centre(node) : { x: job.x, y: job.y };
        const hit = label(node);
        const disabled = !!node.disabled;
        press(node, point.x, point.y, action);
        await settle();
        return `${action.replace("_", " ")} at ${Math.round(point.x)},${Math.round(point.y)} → ${hit}` +
               (disabled ? " (that element is disabled, so nothing was going to happen)" : "");
      }

      throw new Error(`unknown action '${action}'`);
    }

    addEventListener("message", async (event) => {
      const job = event.data;
      if (!job || job.bc !== 1 || job.kind !== "drive") return;
      try {
        const note = await perform(job);
        const logs = drain();
        post({
          id: job.id, type: "drive", ok: true,
          report: note + "\n\n" + state() +
            (logs.length ? `\n\nconsole since the last action:\n${logs.join("\n")}` : ""),
        });
      } catch (err) {
        const logs = drain();
        post({
          id: job.id, type: "drive", ok: false,
          error: String((err && err.message) || err) +
            (logs.length ? `\n\nconsole since the last action:\n${logs.join("\n")}` : ""),
        });
      }
    });
  }

  const SOURCE = "(" + DRIVER.toString() + ")();";

  let seq = 0;

  return {
    /** The script js/sandbox.js injects into a mounted preview. */
    source() { return SOURCE; },

    /**
     * Ask a mounted preview to act on itself. Resolves the frame's own report,
     * rejects with the reason it could not — including the case where there is
     * no driver in there, which means the frame was mounted some other way.
     */
    act(node, job, { timeout = 8000 } = {}) {
      const win = node && node.contentWindow;
      if (!win) throw new Error("there is no preview to drive — mount a page with `preview` first");
      const id = `drive_${++seq}`;
      return new Promise((resolve, reject) => {
        const done = () => {
          clearTimeout(timer);
          removeEventListener("message", onMessage);
        };
        function onMessage(event) {
          const msg = event.data;
          if (!msg || msg.bc !== 1 || msg.type !== "drive" || msg.id !== id) return;
          if (event.source !== win) return;
          done();
          if (msg.ok) resolve(msg.report);
          else reject(new Error(msg.error || "the preview refused the action"));
        }
        const timer = setTimeout(() => {
          done();
          reject(new Error(
            "the preview did not answer in time — it may be busy in a long-running script, " +
            "or it navigated away from the mounted page. Re-run `preview` to remount it."
          ));
        }, timeout);
        addEventListener("message", onMessage);
        win.postMessage({ bc: 1, kind: "drive", id, ...job }, "*");
      });
    },
  };
})();
