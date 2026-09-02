/* ═══════════════════════════════════════════════════════════════════════════
   Capture — a picture of the preview frame, as a File ready to attach.

   The preview runs in an opaque-origin sandbox, so this page cannot read a
   pixel of it: no `contentDocument`, no drawing the iframe to a canvas. So the
   frame photographs itself. `Capture.source()` is a self-contained script that
   js/sandbox.js injects into every mounted preview; on request it clones its own
   document into an `<svg><foreignObject>`, inlines the parts an SVG image is not
   allowed to go and fetch (stylesheets, pictures, fonts), and rasterises the
   result with the browser's own layout engine. Nothing leaves the sandbox but
   base64 PNG bytes, and the user is never asked for a permission.

   The fetching that inlining needs is on a leash — a font host that hangs may
   cost a screenshot a moment, not ten seconds — and anything that misses the
   deadline draws as a fallback font or an empty box, counted in `skipped`.

   A self-portrait has limits all the same: a WebGL canvas, a nested cross-origin
   frame. `Capture.element()` is the honest, pixel-exact route for those — capture
   this tab and cut the frame out of it. It costs a share prompt, so it is never
   taken on its own; the composer asks for it only on a shift-click.
   ═══════════════════════════════════════════════════════════════════════════ */
window.Capture = (function () {

  /* ── the self-portrait, as it runs inside the preview ─────────────────────
     Shipped as source text and re-parsed in the frame's realm, so it must not
     close over anything out here. Kept as a function rather than a string so
     it stays readable, and syntax-checked at load like the rest of the file.
     ───────────────────────────────────────────────────────────────────────── */
  function PORTRAIT() {
    const post = (msg) => parent.postMessage(Object.assign({ bc: 1 }, msg), "*");

    const XHTML = "http://www.w3.org/1999/xhtml";
    const URL_REF = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;

    /* Budgets, because the fetches below reach the network. A font host that is
       slow, throttled or blocked must cost a screenshot a moment, never ten
       seconds: past the deadline nothing more is fetched and whatever did not
       arrive draws in a fallback font. `BYTES` is the same idea for size —
       every inlined file lands in the SVG twice over as base64. */
    const BUDGET = 2500;    // ms of fetching, all resources together
    const PER_FETCH = 1200; // ms any single request may take
    const BYTES = 4e6;      // decoded bytes of inlined resources

    const fetched = new Map();
    let deadline = 0;
    let spent = 0;
    let skipped = 0;

    const left = () => Math.min(PER_FETCH, deadline - Date.now());

    /** GET with a leash: aborts on its own slice of the budget. */
    async function grab(url) {
      const ms = left();
      if (ms <= 0) throw new Error("out of time");
      const stop = new AbortController();
      const timer = setTimeout(() => stop.abort(), ms);
      try {
        const res = await fetch(url, { credentials: "omit", signal: stop.signal });
        if (!res.ok) throw new Error(String(res.status));
        return await res.blob();
      } finally { clearTimeout(timer); }
    }

    /** Any URL the frame can read → a data: URL; null when it cannot. */
    function dataUrl(url) {
      if (!url || url.startsWith("data:")) return Promise.resolve(url || null);
      if (fetched.has(url)) return fetched.get(url);
      const job = (async () => {
        const blob = await grab(url);
        if (spent + blob.size > BYTES) throw new Error("over budget");
        spent += blob.size;
        return await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(new Error("unreadable"));
          reader.readAsDataURL(blob);
        });
      })().catch(() => { skipped++; return null; });   // a missing font is not
      fetched.set(url, job);                           // worth failing a shot
      return job;
    }

    /** A stylesheet's own text, or nothing if it will not come. */
    async function grabText(url) {
      try { return await (await grab(url)).text(); }
      catch (_) { skipped++; return ""; }
    }

    /** Rewrite every url() in a stylesheet to bytes the SVG may use. */
    async function inlineCss(text, base) {
      const refs = new Set();
      for (const m of text.matchAll(URL_REF)) {
        if (m[2] && !m[2].startsWith("data:") && !m[2].startsWith("#")) refs.add(m[2]);
      }
      const map = new Map();
      await Promise.all([...refs].map(async (ref) => {
        try {
          const data = await dataUrl(new URL(ref, base || location.href).href);
          if (data) map.set(ref, data);
        } catch (_) { /* not a URL we can resolve; leave it alone */ }
      }));
      return text.replace(URL_REF, (match, quote, ref) =>
        map.has(ref) ? 'url("' + map.get(ref) + '")' : match);
    }

    /**
     * One sheet as text. `cssRules` covers same-origin sheets and inline
     * <style>; a cross-origin sheet (fonts from a CDN) throws on that and is
     * fetched instead. An `@import` is followed rather than kept, since the SVG
     * would not be allowed to go and get it.
     */
    async function textOf(sheet, seen) {
      if (!sheet || seen.has(sheet)) return "";
      seen.add(sheet);
      let rules = null;
      try { rules = [...sheet.cssRules]; } catch (_) { /* opaque: fetch it */ }

      if (rules) {
        const parts = [];
        for (const rule of rules) {
          if (rule.type !== 3 /* CSSImportRule */) { parts.push(rule.cssText); continue; }
          // A cross-origin import may not even expose its sheet object.
          parts.push(await textOf(rule.styleSheet, seen) ||
                     (rule.href ? await grabText(rule.href) : ""));
        }
        return parts.join("\n");
      }
      return sheet.href ? await grabText(sheet.href) : "";
    }

    /** Every rule in force, as one blob of CSS with its resources inlined. */
    async function allCss() {
      const seen = new Set();
      const parts = [];
      for (const sheet of document.styleSheets) {
        const text = await textOf(sheet, seen);
        if (text) parts.push(await inlineCss(text, sheet.href));
      }
      return parts.join("\n");
    }

    /** `<img src>` has to be bytes: the SVG is not allowed to fetch anything. */
    async function inlineImages(root) {
      await Promise.all([...root.querySelectorAll("img")].map(async (img) => {
        const src = img.getAttribute("src");
        img.removeAttribute("srcset");   // its candidates would not load either
        if (!src || src.startsWith("data:")) return;
        try {
          const data = await dataUrl(new URL(src, location.href).href);
          if (data) img.setAttribute("src", data);
        } catch (_) { /* leave the broken reference; it draws as nothing */ }
      }));
    }

    /**
     * An SVG image renders in static mode: no script, and no animation. So an
     * element that arrived by way of one — the deck idiom, `opacity:0` rising
     * into place with `animation-fill-mode:forwards` — paints at its *first*
     * keyframe, which is exactly the frame where it is not there yet. That is
     * how a slide comes back as a bare gradient.
     *
     * The cure is to stop asking for the animation and state the result: for
     * everything the page is animating, the properties that animation touches
     * are pinned to their computed values right now, and animations and
     * transitions are turned off so nothing restarts from zero.
     */
    /**
     * An animation that rose an element into place ends at `translateY(0)`,
     * which computes to an identity matrix rather than to `none` — and any
     * transform, identity or not, promotes the element. Static SVG rendering
     * then refuses to paint a `background-clip:text` ancestor's gradient
     * through it, which is how a headline animated in word by word comes back
     * blank. An identity matrix moves nothing, so it is written as `none`.
     */
    function settled(value) {
      const kind = /^matrix3d\(/.test(value) ? 16 : /^matrix\(/.test(value) ? 6 : 0;
      if (!kind) return value;
      const nums = (value.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || []).map(Number);
      if (nums.length !== kind) return value;
      const identity = kind === 6
        ? [1, 0, 0, 1, 0, 0]
        : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
      return nums.every((n, i) => Math.abs(n - identity[i]) < 1e-6) ? "none" : value;
    }

    function freeze(root, index) {
      let running = [];
      try { running = document.getAnimations ? document.getAnimations() : []; }
      catch (_) { return; }

      for (const animation of running) {
        const effect = animation.effect;
        // A ::before animates on its own box, and its values do not belong on
        // the element that hosts it. Left alone rather than pinned wrongly.
        if (!effect || effect.pseudoElement) continue;
        const target = effect.target;
        const copy = target && index.get(target);
        if (!copy || !copy.setAttribute) continue;

        // Which properties this animation is responsible for. WAAPI reports
        // them per keyframe in camelCase, alongside its own bookkeeping keys.
        const props = new Set();
        try {
          for (const frame of effect.getKeyframes()) {
            for (const key of Object.keys(frame)) {
              if (!/^(offset|computedOffset|easing|composite)$/.test(key)) props.add(key);
            }
          }
        } catch (_) { /* an animation that will not describe itself */ }

        const now = getComputedStyle(target);
        let css = ";animation:none;transition:none";
        for (const key of props) {
          const prop = key.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
          const value = now.getPropertyValue(prop);
          if (value) css += ";" + prop + ":" + (prop === "transform" ? settled(value) : value);
        }
        copy.setAttribute("style", (copy.getAttribute("style") || "") + css);
      }
    }

    /**
     * A clone carries attributes, not state: what someone typed, what is
     * checked, and what a canvas has painted all live off the DOM. Live and
     * cloned trees are still the same shape, so they pair up by index.
     */
    function copyState(root) {
      const pairs = (selector) => {
        const live = [...document.querySelectorAll(selector)];
        const copies = root.querySelectorAll(selector);
        return live.map((node, i) => [node, copies[i]]).filter((pair) => pair[1]);
      };

      for (const [live, copy] of pairs("input, textarea, select")) {
        const tag = live.tagName.toLowerCase();
        if (tag === "textarea") copy.textContent = live.value;
        else if (tag === "select") {
          [...copy.options].forEach((option, i) => {
            if (live.options[i] && live.options[i].selected) option.setAttribute("selected", "");
            else option.removeAttribute("selected");
          });
        } else {
          copy.setAttribute("value", live.value);
          if (live.type === "checkbox" || live.type === "radio") {
            if (live.checked) copy.setAttribute("checked", "");
            else copy.removeAttribute("checked");
          }
        }
      }

      /* A <canvas> has no pixels once cloned, and inside an SVG image it does
         not even keep its box — it lays out as nothing. So it becomes a picture
         of itself, wearing the box and the frame the canvas had, since the rules
         that drew those select `canvas` and will not match an `img`. A tainted
         canvas cannot be read at all, and is left as the blank it cloned into. */
      const BOX = ["border-width", "border-style", "border-color", "border-radius",
                   "box-shadow", "margin", "display", "vertical-align", "opacity",
                   "filter", "transform", "outline"];
      for (const [live, copy] of pairs("canvas")) {
        let data = null;
        try { data = live.toDataURL("image/png"); } catch (_) { continue; }
        const img = document.createElementNS(XHTML, "img");
        for (const attr of copy.attributes) {
          if (!/^(width|height|style)$/i.test(attr.name)) img.setAttribute(attr.name, attr.value);
        }
        const style = getComputedStyle(live);
        img.setAttribute("src", data);
        img.setAttribute("style",
          BOX.map((prop) => prop + ":" + style.getPropertyValue(prop)).join(";") +
          ";padding:0;box-sizing:border-box" +
          ";width:" + live.offsetWidth + "px;height:" + live.offsetHeight + "px");
        copy.replaceWith(img);
      }
    }

    /** What shows through where the page paints nothing. */
    function backdrop() {
      for (const node of [document.body, document.documentElement]) {
        if (!node) continue;
        const colour = getComputedStyle(node).backgroundColor;
        if (colour && colour !== "transparent" && !/^rgba\(.*,\s*0\)$/.test(colour)) return colour;
      }
      return "#ffffff";
    }

    const loadImage = (url) => new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("the page could not be redrawn as an image"));
      img.src = url;
    });

    /** Bytes → a data: URL, without a megabyte-long synchronous encode. */
    const asDataUrl = (blob) => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("the redrawn page could not be encoded"));
      reader.readAsDataURL(blob);
    });

    /** The viewport of this frame, as PNG bytes. */
    async function portrait(scale) {
      deadline = Date.now() + BUDGET;
      spent = 0;
      skipped = 0;
      const view = document.documentElement;
      const w = Math.max(1, Math.round(view.clientWidth || innerWidth));
      const h = Math.max(1, Math.round(view.clientHeight || innerHeight));

      const root = view.cloneNode(true);
      // Live node → its copy, while the two trees are still the same shape:
      // freeze() needs it, and the removals below would put them out of step.
      const index = new Map();
      const copies = [root, ...root.querySelectorAll("*")];
      [view, ...view.querySelectorAll("*")].forEach((node, i) => {
        if (copies[i]) index.set(node, copies[i]);
      });
      freeze(root, index);
      copyState(root);
      for (const dead of root.querySelectorAll("script, noscript, style, link")) dead.remove();
      await inlineImages(root);

      const style = document.createElementNS(XHTML, "style");
      style.textContent = await allCss();
      (root.querySelector("head") || root).appendChild(style);

      // foreignObject draws from the origin, so a scrolled page has to be
      // shifted up into the frame the viewer is actually looking at.
      if (scrollX || scrollY) {
        root.setAttribute("style", (root.getAttribute("style") || "") +
          ";transform:translate(" + -scrollX + "px," + -scrollY + "px)");
      }
      root.setAttribute("xmlns", XHTML);

      const xml = new XMLSerializer().serializeToString(root);
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h +
        '" viewBox="0 0 ' + w + " " + h + '"><foreignObject x="0" y="0" width="' + w +
        '" height="' + h + '">' + xml + "</foreignObject></svg>";

      // A data: URL and not a blob: one. This document has an opaque origin, so
      // a blob URL of its own making still counts as cross-origin and would
      // taint the canvas past exporting; data: URLs never do. Encoded through a
      // FileReader rather than encodeURIComponent, which on a page carrying a
      // few inlined fonts is megabytes of string work on the main thread.
      const img = await loadImage(await asDataUrl(new Blob([svg], { type: "image/svg+xml" })));

      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(w * scale));
      canvas.height = Math.max(1, Math.round(h * scale));
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = backdrop();
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      const png = canvas.toDataURL("image/png");
      return {
        mediaType: "image/png",
        data: png.slice(png.indexOf(",") + 1),
        width: canvas.width,
        height: canvas.height,
        // How many fonts or pictures the budget left out, so the composer can
        // say the shot is a near miss rather than pretend it is exact.
        skipped,
      };
    }

    addEventListener("message", async (event) => {
      const job = event.data;
      if (!job || job.bc !== 1 || job.kind !== "shot") return;
      try { post({ id: job.id, type: "shot", ok: true, shot: await portrait(job.scale || 1) }); }
      catch (err) { post({ id: job.id, type: "shot", ok: false, error: String((err && err.message) || err) }); }
    });
  }

  const SOURCE = "(" + PORTRAIT.toString() + ")();";

  let seq = 0;

  /* ── parent side ─────────────────────────────────────────────────────────── */

  /** `{ data, mediaType, … }` from the frame → a File the composer can attach. */
  function fileOf(shot, name) {
    const bytes = atob(shot.data);
    const buffer = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) buffer[i] = bytes.charCodeAt(i);
    return new File([buffer], name, { type: shot.mediaType });
  }

  const media = () => navigator.mediaDevices;

  /** Resolve once a capture stream has painted a frame worth drawing. */
  function firstFrame(stream) {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    return new Promise((resolve, reject) => {
      const fail = () => reject(new Error("the capture stream produced no frame"));
      video.onerror = fail;
      video.onloadeddata = async () => {
        try { await video.play(); } catch (_) { /* muted autoplay; a still frame is enough */ }
        // One frame of slack: `loadeddata` can land before the first composite,
        // which draws as a blank rectangle.
        const go = () => (video.videoWidth ? resolve(video) : fail());
        if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(() => go());
        else requestAnimationFrame(() => requestAnimationFrame(go));
      };
      setTimeout(fail, 5000);
    });
  }

  /** PNG File of a source region, or of the whole frame when `rect` is null. */
  function cut(video, rect, name) {
    const w = Math.max(1, Math.round(rect ? rect.w : video.videoWidth));
    const h = Math.max(1, Math.round(rect ? rect.h : video.videoHeight));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d").drawImage(
      video, rect ? Math.round(rect.x) : 0, rect ? Math.round(rect.y) : 0, w, h, 0, 0, w, h);
    return new Promise((resolve, reject) => canvas.toBlob(
      (blob) => blob ? resolve(new File([blob], name, { type: "image/png" }))
                     : reject(new Error("could not encode the screenshot")),
      "image/png"));
  }

  /** The element's box in stream pixels — the viewport maps onto the frame. */
  function boxIn(video, node) {
    const box = node.getBoundingClientRect();
    const sx = video.videoWidth / window.innerWidth;
    const sy = video.videoHeight / window.innerHeight;
    return { x: box.left * sx, y: box.top * sy, w: box.width * sx, h: box.height * sy };
  }

  return {
    /** The script js/sandbox.js injects into a mounted preview. */
    source() { return SOURCE; },

    /**
     * Ask a mounted preview frame to draw itself. Resolves
     * `{ file, skipped }` — a PNG and how many resources the budget dropped —
     * and rejects if the frame has no portrait script or cannot finish one.
     */
    async frame(node, name = "preview.png", { timeout = 6000, scale: want = 0 } = {}) {
      const win = node && node.contentWindow;
      if (!win) throw new Error("there is no preview frame to photograph");
      const id = `shot_${++seq}`;
      // Retina where the screen is retina, capped: past 2× this is only bytes.
      // A caller may pin the scale instead — the `screenshot` tool asks for 1×,
      // so a coordinate read off the picture is a coordinate the page can be
      // clicked at without any arithmetic in between.
      const scale = want > 0 ? want : Math.min(2, window.devicePixelRatio || 1);

      const shot = await new Promise((resolve, reject) => {
        const done = () => {
          clearTimeout(timer);
          removeEventListener("message", onMessage);
        };
        function onMessage(event) {
          const msg = event.data;
          if (!msg || msg.bc !== 1 || msg.type !== "shot" || msg.id !== id) return;
          if (event.source !== win) return;
          done();
          if (msg.ok) resolve(msg.shot);
          else reject(new Error(msg.error || "the preview could not draw itself"));
        }
        const timer = setTimeout(() => {
          done();
          reject(new Error("the preview did not answer in time"));
        }, timeout);
        addEventListener("message", onMessage);
        win.postMessage({ bc: 1, kind: "shot", id, scale }, "*");
      });

      // The frame's own numbers: at 1× they are its CSS viewport, which is what
      // a caller handing coordinates back to the page needs to know.
      return {
        file: fileOf(shot, name),
        skipped: shot.skipped || 0,
        width: shot.width,
        height: shot.height,
      };
    },

    tabCapture() { return !!(media() && media().getDisplayMedia && window.isSecureContext); },

    /**
     * Fallback: screenshot one element of this page off a capture of the tab.
     * Pixel-exact, and the browser will ask the user to confirm the share.
     */
    async element(node, name = "screenshot.png") {
      if (!this.tabCapture()) {
        throw new Error("this browser cannot capture the tab — screen capture needs https and a recent Chrome, Edge or Safari");
      }
      // Off-screen pixels are not in the frame at all, so bring it into view
      // and let the scroll settle before the picker opens.
      node.scrollIntoView({ block: "nearest", inline: "nearest" });
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

      let stream;
      try {
        stream = await media().getDisplayMedia({
          audio: false,
          video: { displaySurface: "browser", frameRate: 5 },
          // Hints, all ignored where unknown: offer this tab first, allow it to
          // be shared at all, and keep the switch-surface chrome out of the way.
          preferCurrentTab: true,
          selfBrowserSurface: "include",
          surfaceSwitching: "exclude",
          monitorTypeSurfaces: "exclude",
        });
      } catch (err) {
        const why = err && err.name === "NotAllowedError"
          ? "screenshot cancelled — pick this tab in the share prompt to send the preview"
          : `could not capture the tab: ${(err && err.message) || err}`;
        throw new Error(why);
      }

      const track = stream.getVideoTracks()[0];
      try {
        // Region Capture: the stream itself becomes the element, so no crop —
        // and no dependence on what the user picked in the prompt.
        let cropped = false;
        if (track && track.cropTo && window.CropTarget && CropTarget.fromElement) {
          try {
            await track.cropTo(await CropTarget.fromElement(node));
            cropped = true;
          } catch (_) { /* fall through to the manual crop */ }
        }

        const video = await firstFrame(stream);
        // A window or a screen was picked instead of this tab: viewport
        // coordinates mean nothing there, so send the frame whole rather than
        // an arbitrary corner of it.
        const surface = track && track.getSettings ? track.getSettings().displaySurface : "browser";
        const rect = cropped || (surface && surface !== "browser") ? null : boxIn(video, node);
        const file = await cut(video, rect, name);
        video.srcObject = null;
        return file;
      } finally {
        for (const t of stream.getTracks()) t.stop();
      }
    },
  };
})();
