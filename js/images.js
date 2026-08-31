/* ═══════════════════════════════════════════════════════════════════════════
   Images — clipboard and dropped pictures, ready for a multimodal request.

   A pasted screenshot is a `File` on the clipboard, and every vendor wants the
   same thing from it: base64 bytes plus a media type. What differs is the size
   they will accept, so everything is normalised here once — decoded, scaled to
   a sane long edge, re-encoded if it is still heavy — and the adapters in
   js/llm.js only have to wrap the result in their own envelope.

     Shot = { id, name, mediaType, data, width, height, bytes }

   `data` is bare base64, no `data:` prefix: that is what the wire formats want.
   `Images.url(shot)` puts the prefix back for an `<img>`.
   ═══════════════════════════════════════════════════════════════════════════ */
window.Images = (function () {

  /* The intersection of what Anthropic, OpenAI and Google all accept. A vendor
     may take more (Gemini reads HEIC); sending only these four means one
     attachment works on whichever provider the KEYS panel is pointed at. */
  const OK = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

  /* 1568px is the long edge above which Anthropic scales images down anyway, so
     anything larger is bytes spent on nothing. */
  const MAX_EDGE = 1568;
  /* Per-image ceiling on the decoded bytes. Base64 inflates by a third, and the
     session lives in localStorage, so this is a budget as much as a limit. */
  const CAP = 1_100_000;
  const MAX_COUNT = 6;

  let seq = 0;

  const OK_LIST = "png, jpeg, gif or webp";

  /** Read a File as a data URL — the one browser path that gives us base64. */
  const dataUrlOf = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(`could not read ${file.name || "that image"}`));
    reader.readAsDataURL(file);
  });

  const decode = (url) => new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("that file is not an image the browser can decode"));
    img.src = url;
  });

  const payload = (url) => url.slice(url.indexOf(",") + 1);
  /** Decoded size of a base64 payload, near enough for a budget. */
  const sizeOf = (data) => Math.floor(data.length * 0.75);

  function shot(name, mediaType, data, width, height) {
    return { id: `img_${Date.now()}_${seq++}`, name: name || "pasted image", mediaType, data, width, height, bytes: sizeOf(data) };
  }

  /**
   * Redraw at `w`×`h` and encode. PNG first for a screenshot — text and UI
   * chrome are exactly what JPEG smears — then JPEG once PNG proves too heavy,
   * then a smaller canvas. The first candidate under the cap wins.
   */
  async function shrink(img, name, keepPng, w, h) {
    for (let pass = 0; pass < 5; pass++) {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(w));
      canvas.height = Math.max(1, Math.round(h));
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      const tries = keepPng && pass === 0
        ? [["image/png", undefined], ["image/jpeg", 0.85]]
        : [["image/jpeg", 0.85], ["image/jpeg", 0.6]];
      for (const [mediaType, quality] of tries) {
        const data = payload(canvas.toDataURL(mediaType, quality));
        if (sizeOf(data) <= CAP) return shot(name, mediaType, data, canvas.width, canvas.height);
      }
      w *= 0.75;
      h *= 0.75;
    }
    throw new Error(`${name || "that image"} is too large to send even scaled down`);
  }

  /** One file → one shot. Throws with a reason the composer can print. */
  async function one(file) {
    const type = String(file.type || "").toLowerCase();
    const name = file.name || "pasted image";
    if (!type.startsWith("image/")) throw new Error(`${name} is not an image (${type || "unknown type"})`);

    const url = await dataUrlOf(file);
    const img = await decode(url);
    const data = payload(url);
    const edge = Math.max(img.width, img.height);

    // Already small enough, and in a format every vendor reads: send the bytes
    // the user actually copied rather than a re-encoding of them.
    if (edge <= MAX_EDGE && sizeOf(data) <= CAP && OK.has(type)) {
      return shot(name, type, data, img.width, img.height);
    }
    const scale = Math.min(1, MAX_EDGE / edge);
    // An animated GIF becomes its first frame; the vendors only read one anyway.
    return shrink(img, name, type !== "image/jpeg", img.width * scale, img.height * scale);
  }

  return {
    max: MAX_COUNT,
    formats: OK_LIST,

    /** `data:` URL for an `<img>` — the reverse of what the wire format wants. */
    url(s) { return `data:${s.mediaType};base64,${s.data}`; },

    /** Every image file on a clipboard or drag payload, in order. */
    filesIn(transfer) {
      if (!transfer) return [];
      const files = [...(transfer.files || [])];
      // Chrome puts a pasted screenshot in `items` and not always in `files`.
      if (!files.length) {
        for (const item of transfer.items || []) {
          if (item.kind !== "file") continue;
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }
      return files.filter((f) => String(f.type || "").toLowerCase().startsWith("image/"));
    },

    /**
     * Decode a batch. Each file is reported on its own — one unreadable paste
     * should not throw away the three that decoded — so this resolves
     * `{ shots, errors }` rather than rejecting.
     */
    async load(files) {
      const shots = [];
      const errors = [];
      for (const file of files) {
        try { shots.push(await one(file)); }
        catch (err) { errors.push(String(err && err.message ? err.message : err)); }
      }
      return { shots, errors };
    },

    /** A short human size, for the attachment strip. */
    label(s) {
      const kb = s.bytes / 1024;
      return `${s.width}×${s.height} · ${kb < 1024 ? `${Math.max(1, Math.round(kb))}k` : `${(kb / 1024).toFixed(1)}M`}`;
    },
  };
})();
