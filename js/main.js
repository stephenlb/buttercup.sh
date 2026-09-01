/* ═══════════════════════════════════════════════════════════════════════════
   main — wiring. Settings, event handlers, and the hook-ups between the
   agent loop, the tools, the slash commands, and the UI.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  const $ = (id) => document.getElementById(id);
  const SETTINGS_KEY = "buttercup.settings.v1";

  /* One row per setting, and the only place any of them is listed. Each row is
     the id of its control in the KEYS panel plus:
       def    what it is before the user has said otherwise
       flag   a checkbox rather than a value field
       read   how to turn the typed text into the setting (default: verbatim),
              given the settings being assembled so far
     paintSettings and readSettings are both driven from here, so a new setting
     is one row rather than three edits that have to agree. */
  const FIELDS = {
    provider:     { def: "anthropic" },
    model:        { def: LLM.defaultModel("anthropic"), read: (v, s) => v.trim() || LLM.defaultModel(s.provider) },
    baseUrl:      { def: LLM.defaultUrl("anthropic"), read: (v, s) => v.trim() || LLM.defaultUrl(s.provider) },
    key:          { def: "" },
    effort:       { def: "medium" },
    mode:         { def: Agent.defaultMode },
    yolo:         { def: true, flag: true },
    showThinking: { def: true, flag: true },
    maxSteps:     { def: 40, read: (v) => Number(v) || FIELDS.maxSteps.def },
    autoCompact:  { def: true, flag: true },
    compactAt:    { def: 120000, read: (v) => Number(v) || FIELDS.compactAt.def },
  };

  const DEFAULTS = Object.fromEntries(Object.entries(FIELDS).map(([id, f]) => [id, f.def]));

  let settings = loadSettings();
  /* Whether the vendor has confirmed the current key. The header lamp reports
     this, so it is only ever set from a real answer to a real request. */
  let keyOk = false;
  let checkSeq = 0;

  function loadSettings() {
    try {
      return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}) };
    } catch (_) { return { ...DEFAULTS }; }
  }

  function saveSettings() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    Agent.setSettings(settings);
    paintStats();
  }

  function paintStats(step = 0) {
    const u = Agent.usage;
    UI.stats({
      provider: settings.provider,
      model: settings.model || "(no model)",
      mode: settings.mode,
      tokens: u.input + u.output,
      context: Agent.context,
      limit: settings.autoCompact ? Agent.contextLimit() : 0,
      steps: step,
    });
  }

  /* ── the READY lamp ───────────────────────────────────────────────────────
     Three honest states: no key, key the vendor rejected (or has not been asked
     about yet), and key the vendor accepted. Busy overrides all of them.
     ─────────────────────────────────────────────────────────────────────────── */

  function paintReady() {
    if (Agent.busy) return;
    if (keyOk) UI.status("ready", "READY");
    else UI.status("notready", "NOT READY");
  }

  /**
   * Ask the vendor whether the saved key works. `quiet` suppresses the
   * transcript chatter so a page load does not narrate itself.
   */
  async function checkKey({ quiet = false } = {}) {
    const seq = ++checkSeq;
    if (!settings.key) {
      keyOk = false;
      paintReady();
      if (!quiet) UI.error("no API key — paste one in the KEYS panel, then press SAVE");
      return false;
    }
    if (!Agent.busy) UI.status("check", "CHECKING KEY");
    const verdict = await LLM.validate({
      provider: settings.provider, apiKey: settings.key, baseUrl: settings.baseUrl,
    });
    if (seq !== checkSeq) return keyOk;         // a newer check already answered
    keyOk = verdict.ok;
    paintReady();
    if (verdict.ok) { if (!quiet) UI.system(`key accepted by ${settings.provider}`); }
    else UI.error(verdict.error);
    return keyOk;
  }

  /* ── settings form ──────────────────────────────────────────────────────── */

  function fillModelList() {
    const spec = LLM.providers[settings.provider];
    const list = $("model-list");
    list.replaceChildren();
    for (const name of spec.models) {
      const opt = document.createElement("option");
      opt.value = name;
      list.appendChild(opt);
    }
    $("key").placeholder = `${spec.keyHint} — stays in this browser`;
    // Only the OpenAI-compatible vendors have a base URL worth changing.
    $("row-base").hidden = spec.api !== "chat";
  }

  function paintSettings() {
    for (const [id, f] of Object.entries(FIELDS)) {
      if (f.flag) $(id).checked = settings[id];
      else $(id).value = settings[id];
    }
    fillModelList();
  }

  function readSettings() {
    // A key pasted from formatted text can carry characters an HTTP header
    // cannot hold; catch it here rather than mid-turn on the first request.
    const { key, bad } = LLM.cleanKey($("key").value);
    if (bad.length) {
      UI.error(
        `that key contains ${bad.length} character(s) that do not belong in an API key ` +
        `— it looks copied from formatted text. Re-copy it as plain text or retype it.`
      );
    }
    // Put the cleaned key back in the box first, so it is read like any other
    // field below rather than threaded through as a special case.
    $("key").value = key;
    // `provider` comes first in FIELDS, so the rows that fall back to a
    // provider default (model, baseUrl) already see the new one.
    const next = {};
    for (const [id, f] of Object.entries(FIELDS)) {
      next[id] = f.flag ? $(id).checked : f.read ? f.read($(id).value, next) : $(id).value;
    }
    settings = next;
    saveSettings();
  }

  $("provider").addEventListener("change", () => {
    // Switching vendors invalidates the model name, the endpoint and the key.
    settings.provider = $("provider").value;
    settings.model = LLM.defaultModel(settings.provider);
    settings.baseUrl = LLM.defaultUrl(settings.provider);
    settings.key = "";
    keyOk = false;
    paintSettings();
    saveSettings();
    paintReady();
    UI.system(`provider → ${settings.provider}. Paste a ${settings.provider} key.`);
  });

  $("settings-form").addEventListener("submit", (e) => {
    e.preventDefault();
    readSettings();
    UI.system(`saved · ${settings.provider} · ${settings.model} · ${settings.mode} · effort ${settings.effort}`);
    checkKey();
  });

  $("forget").addEventListener("click", () => {
    settings.key = "";
    $("key").value = "";
    keyOk = false;
    saveSettings();
    paintReady();
    UI.system("key cleared from this browser");
  });

  $("reset-session").addEventListener("click", () => runCommand("/clear"));

  /* ── workspace panel ────────────────────────────────────────────────────── */

  $("download-zip").addEventListener("click", () => {
    if (!VFS.count()) return UI.error("workspace is empty; nothing to export");
    Zip.download("agent-workspace.zip", Zip.build(VFS.snapshot()));
    UI.system(`exported ${VFS.count()} file(s)`);
  });

  $("wipe").addEventListener("click", () => runCommand("/wipe"));

  $("viewer-close").addEventListener("click", () => UI.closeViewer());

  /* ── workspace import ─────────────────────────────────────────────────────
     Files dragged into the tab — or picked with IMPORT — are written into the
     workspace exactly as a tool write would be, so the agent can read them on
     the next turn. A checkpoint goes down first: an import that landed on top
     of work in progress has to be as undoable as anything the agent does.
     ───────────────────────────────────────────────────────────────────────── */

  const size = (n) => (n < 1024 ? `${n}b` : `${(n / 1024).toFixed(1)}k`);

  /**
   * Write a read batch from js/drop.js into the workspace and say what happened.
   * `attached` is how many pictures the same drop sent to the composer, which is
   * the difference between "nothing usable here" and "the pictures went, and
   * there was nothing else".
   */
  function absorb(batch, attached = 0) {
    const { files, skips, full } = batch;
    for (const s of skips) UI.error(`${s.path} — ${s.why}`);
    if (full) {
      UI.system(`stopped at ${Drop.limits.files} files / ${Math.round(Drop.limits.total / 1024)}k — ` +
                `the rest of that drop was left where it was`);
    }
    if (!files.length) {
      if (!skips.length && !attached) UI.error("nothing in that drop the workspace can hold — it holds text files");
      return;
    }

    Agent.mark(`before importing ${files.length} file(s)`);
    const written = files.map((f) => VFS.write(f.path, f.text));
    const shown = written.slice(0, 8).map((w) => `${w.path} (${size(w.bytes)})`).join(", ");
    const more = written.length - 8;
    const again = written.filter((w) => w.existed).length;
    UI.system(`imported ${written.length} file(s): ${shown}${more > 0 ? `, and ${more} more` : ""}` +
              `${again ? ` — ${again} replaced a file already there` : ""}. /undo puts the workspace back.`);
  }

  $("import-btn").addEventListener("click", () => $("import-input").click());
  $("import-input").addEventListener("change", async (e) => {
    const files = [...e.target.files];
    e.target.value = "";   // so picking the same file twice still fires
    if (!files.length) return;
    absorb(await Drop.read({ files }));
  });

  /* ── prompt ─────────────────────────────────────────────────────────────── */

  const input = $("prompt-input");

  function grow() {
    input.rows = Math.min(6, input.value.split("\n").length);
  }

  /* ── attachments ──────────────────────────────────────────────────────────
     Images waiting to go out with the next request: pasted, dropped, or picked
     with IMG. They belong to the composer rather than to the session, so they
     travel with the line they were attached to — through the queue, and through
     recall — and are gone the moment that line is sent.
     ─────────────────────────────────────────────────────────────────────────── */

  let shots = [];

  function paintShots() {
    UI.attachments(shots, {
      drop: (id) => {
        shots = shots.filter((s) => s.id !== id);
        paintShots();
      },
    });
  }

  /** Decode a batch of files into the strip, reporting whatever would not go. */
  async function attach(files) {
    if (!files.length) return;
    const room = Images.max - shots.length;
    if (room <= 0) {
      return UI.error(`already holding ${Images.max} images — send them, or remove one first`);
    }
    if (files.length > room) {
      UI.system(`taking ${room} of those ${files.length} images — ${Images.max} is the limit per request`);
    }
    const { shots: added, errors } = await Images.load(files.slice(0, room));
    shots = shots.concat(added);
    paintShots();
    for (const err of errors) UI.error(err);
    if (added.length) {
      UI.system(`attached ${added.map((s) => `${s.name} (${Images.label(s)})`).join(", ")} ` +
                `— goes out with the next request, as part of the prompt.`);
      input.focus();
    }
  }

  /* Paste anywhere in the tab, as long as the caret is not in another field:
     copying a screenshot and hitting ⌘V is the whole interaction, and demanding
     that the composer be focused first would be one step too many. */
  document.addEventListener("paste", (e) => {
    const target = e.target;
    if (target !== input && target && target.closest && target.closest("input, textarea, [contenteditable]")) return;
    const files = Images.filesIn(e.clipboardData);
    if (!files.length) return;   // ordinary text paste: leave it to the browser
    e.preventDefault();
    attach(files);
  });

  /* Drag and drop. `dragover` has to be cancelled or the browser navigates to
     the file instead, and the flag on the body is how the composer says so. */
  const dragging = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
  document.addEventListener("dragover", (e) => {
    if (!dragging(e)) return;
    e.preventDefault();
    document.body.dataset.drag = "1";
  });
  document.addEventListener("dragleave", (e) => {
    if (!e.relatedTarget) document.body.dataset.drag = "";
  });
  document.addEventListener("drop", (e) => {
    if (!dragging(e)) return;
    e.preventDefault();
    document.body.dataset.drag = "";
    /* Both readers have to claim the payload before this handler yields, so they
       are called here and awaited afterwards. What a file is decides where it
       goes: pictures are part of the prompt, everything else is the agent's
       workspace, whatever corner of the tab it landed on. */
    const pics = Images.filesIn(e.dataTransfer);
    const reading = Drop.read(e.dataTransfer);
    if (pics.length) attach(pics);
    reading.then((batch) => absorb(batch, pics.length));
  });

  /* SEND TO MODEL: the preview frame, photographed and dropped in the strip, so
     the next turn can see what it built instead of being told about it. The
     screenshot is a picture like any other from here on. */
  const shotBtn = $("preview-shot");
  shotBtn.addEventListener("click", async (e) => {
    const frame = $("preview");
    if (frame.hidden) return UI.error("nothing mounted in the preview to photograph");
    const path = UI.mountedPreview();
    const name = `preview-${(path || "frame").replace(/[^\w.-]+/g, "-")}.png`;
    const label = shotBtn.textContent;
    shotBtn.disabled = true;
    shotBtn.textContent = "CAPTURING…";
    try {
      // Ordinarily the frame draws itself: no permission prompt, and nothing
      // outside the preview is ever readable. Shift asks for the pixel-exact
      // route instead, for the rare page that cannot redraw — a WebGL canvas, a
      // nested frame — and that one has to borrow the tab, prompt and all.
      if (e.shiftKey) {
        UI.system("exact capture — the browser will ask to share this tab, and only the frame is kept.");
        await attach([await Capture.element(frame, name)]);
      } else {
        const { file, skipped } = await Capture.frame(frame, name);
        await attach([file]);
        if (skipped) {
          UI.system(`${skipped} font${skipped > 1 ? "s" : ""} or picture${skipped > 1 ? "s" : ""} ` +
                    `did not load in time, so the shot may differ from the frame — ` +
                    `shift\u2011click SEND TO MODEL for a pixel\u2011exact capture.`);
        }
      }
    } catch (err) {
      UI.error(String((err && err.message) || err));
    } finally {
      shotBtn.textContent = label;
      shotBtn.disabled = frame.hidden;
    }
  });

  $("attach-btn").addEventListener("click", () => $("attach-input").click());
  $("attach-input").addEventListener("change", (e) => {
    attach([...e.target.files]);
    e.target.value = "";   // so picking the same file twice still fires
  });

  input.addEventListener("input", grow);
  input.addEventListener("keydown", (e) => {
    // Enter sends; Shift+Enter is a newline. Terminal muscle memory.
    if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      $("prompt-form").requestSubmit();
    }
    if (e.shiftKey || e.altKey) return;
    // Up and Down walk back through the strip and then through history, which
    // is the same key that recalls in a shell. Inside a multi-line draft they
    // stay cursor keys: recall only starts from the edge the caret is at.
    const caret = input.selectionStart === input.selectionEnd ? input.selectionStart : -1;
    if (e.key === "ArrowUp" && caret === 0 && recall(1)) e.preventDefault();
    if (e.key === "ArrowDown" && caret === input.value.length && recall(-1)) e.preventDefault();
  });

  /**
   * Run a slash command and report it in the transcript. A command that hands
   * back a prompt (`/init`) then runs as a normal request.
   *
   * `instant` is a read-only command (`/help`, `/queue`) answered mid-turn
   * instead of waiting behind the work it is asking about: it must leave the
   * run state and the stats of the turn already in flight alone.
   */
  async function runCommand(text, { instant = false } = {}) {
    UI.user(text);
    let out;
    // `/compact` spends a model call, so STOP has to work while it runs.
    if (!instant) setRunning(true);
    try {
      out = await Commands.run(text);
      if (out.text) UI.system(out.text);
    } catch (err) {
      UI.fail(err);
    } finally {
      if (!instant) setRunning(false);
    }
    if (instant) return true;
    paintStats();
    if (out && out.prompt) return runPrompt(out.prompt);
    return true;
  }

  /**
   * Send one request to the model, once we know the key is good for it.
   * `pics` are the images that were attached to this line, if any.
   * Resolves false when the request never reached the model at all.
   */
  async function runPrompt(text, pics = []) {
    if (!settings.key) {
      $("tab-keys").checked = true;
      UI.error("no API key. Open the KEYS panel, pick a provider, paste a key, press SAVE.");
      return false;
    }
    // The lamp says READY only once the vendor has agreed; make that true
    // before spending a turn on a key that will be rejected anyway.
    if (!keyOk && !(await checkKey())) {
      $("tab-keys").checked = true;
      return false;
    }

    setRunning(true);
    try {
      await Agent.send(text, pics);
    } finally {
      setRunning(false);
      input.focus();
    }
    return true;
  }

  /* ── the queue ────────────────────────────────────────────────────────────
     Typing while a turn runs used to be refused; now it lands here and runs in
     order as each turn finishes. One driver loop owns the draining, so however
     many requests arrive there is never a second turn in flight — which is the
     whole constraint, since the agent's conversation is a single thread.
     ─────────────────────────────────────────────────────────────────────────── */

  const queue = [];
  let draining = false;

  /* ── recall ───────────────────────────────────────────────────────────────
     One cursor walks up out of the composer, through the strip newest-first,
     and on into what has already been sent. `browse` is where it stands: 0 is
     the draft the user was typing, 1 is the last line on deck, and past the end
     of the strip it is history. While it stands anywhere but 0 the queue is
     held — running the next line would move the ground under the cursor, and an
     edit meant for the third request would land after the second had gone.
     ───────────────────────────────────────────────────────────────────────── */

  /* A line, anywhere in this machinery, is `{ text, shots }`: the words and the
     pictures attached to them travel together, because on deck and in recall
     they are one request. */
  const line = (text, pics = []) => ({ text, shots: pics });

  const history = [];   // requests already sent, oldest first
  let browse = 0;
  let draft = line(""); // the composer's own line, kept while the cursor is out
  let paused = false;

  const recallEnd = () => queue.length + history.length;

  /** Where position `k` points. Queue first, newest first, then history. */
  const recallAt = (k) =>
    k <= queue.length
      ? { kind: "queue", i: queue.length - k }
      : { kind: "history", i: history.length - (k - queue.length) };

  const recallLine = (at) => (at.kind === "queue" ? queue[at.i] : history[at.i]) || line("");

  /**
   * Move the cursor by `step` and load what it lands on — the words back into
   * the composer, the images back into the strip. Edits to a line on deck are
   * kept as the cursor passes over it, so walking the strip to check something
   * does not undo a fix made on the way. False when there is nowhere to go,
   * which leaves the arrow key to the caret.
   */
  function recall(step) {
    const next = browse + step;
    if (next < 0 || next > recallEnd()) return false;

    // Leaving a line on deck: what is in the box is now that line. Emptying it
    // is not a delete — `×` is — so an empty box leaves the line alone.
    if (!browse) draft = line(input.value, shots);
    else {
      const at = recallAt(browse);
      if (at.kind === "queue" && (input.value.trim() || shots.length)) {
        queue[at.i] = line(input.value, shots);
      }
    }

    browse = next;
    const landed = browse ? recallLine(recallAt(browse)) : draft;
    input.value = landed.text;
    // A recalled request is sent again as it was, pictures included.
    shots = landed.shots.slice();
    paintShots();
    grow();
    input.setSelectionRange(input.value.length, input.value.length);
    paintQueue();
    if (!browse) drain();   // back in the composer: the queue runs again
    return true;
  }

  /** Remember a request the way a shell does: no run of identical lines. */
  function remember(entry) {
    const last = history[history.length - 1];
    if (!last || last.text !== entry.text || last.shots.length !== entry.shots.length) history.push(entry);
    if (history.length > 200) history.shift();
  }

  function paintQueue() {
    UI.queue(queue, {
      paused,
      // Which line is in the composer right now, so the strip says where the
      // cursor is instead of leaving the box's text looking like a stray draft.
      editing: paused && browse <= queue.length ? queue.length - browse : -1,
      // `×` while the cursor is out would leave it pointing at a line that no
      // longer exists, so it comes home; the recalled text stays as a draft.
      drop: (i) => {
        queue.splice(i, 1);
        browse = 0;
        paused = false;
        paintQueue();
        drain();
      },
      clear: () => dropQueue((n) => UI.system(`queue cleared — ${n} request(s) dropped`)),
    });
  }

  /** Empty the queue, reporting through `say` only if there was anything in it. */
  function dropQueue(say) {
    const n = queue.length;
    queue.length = 0;
    // The cursor was pointing into what just went away; whatever is in the box
    // stays there as an ordinary draft.
    browse = 0;
    paused = false;
    paintQueue();
    if (n && say) say(n);
    return n;
  }

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (queue.length && !paused) {
        const entry = queue.shift();
        remember(entry);
        paintQueue();
        let ok = true;
        try {
          ok = Commands.is(entry.text)
            ? await runCommand(entry.text)
            : await runPrompt(entry.text, entry.shots);
        } catch (err) {
          UI.fail(err);
          ok = false;
        }
        // Whatever stopped that request — no key, a rejected key — would stop
        // everything behind it too. Drop the rest rather than repeat the error.
        if (!ok) dropQueue((n) => UI.error(`queue cleared — ${n} request(s) dropped after that failure`));
      }
    } finally {
      draining = false;
      input.focus();
    }
  }

  $("prompt-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value.trim();
    const at = browse ? recallAt(browse) : null;
    // A slash command is answered by this tab, not by the model, so it has no
    // use for a picture: the attachments stay in the strip for the next request
    // rather than being silently thrown away.
    const command = Commands.is(text);
    const pics = command ? [] : shots;

    // Whatever this was, the composer is clear and the cursor is home again,
    // so the hold is over and the queue runs from the front.
    input.value = "";
    draft = line("");
    browse = 0;
    paused = false;
    if (!command) {
      shots = [];
      paintShots();
    }
    grow();

    // A line from the strip goes back where it was rather than to the end:
    // its place in the order is part of what the user asked for. Sent empty,
    // it leaves the strip — that is the one way ENTER drops a line.
    if (at && at.kind === "queue") {
      if (text || pics.length) queue[at.i] = line(text, pics);
      else queue.splice(at.i, 1);
      paintQueue();
      return void drain();
    }

    // A picture on its own is a request; an empty box with nothing attached is not.
    if (!text && !pics.length) return void drain();

    // Mid-turn `/help` and `/queue` skip the queue: they only read state.
    if (draining && Commands.isInstant(text)) {
      remember(line(text));
      return runCommand(text, { instant: true });
    }

    queue.push(line(text, pics));
    paintQueue();
    drain();
  });

  $("stop").addEventListener("click", () => {
    Agent.stop();
    dropQueue((n) => UI.system(`stopped — ${n} queued request(s) dropped`));
  });

  function setRunning(on) {
    // RUN stays live while a turn runs: pressing it queues rather than refuses.
    $("send").textContent = on ? "QUEUE" : "RUN";
    $("stop").disabled = !on;
  }

  /* ── hook-ups ───────────────────────────────────────────────────────────── */

  Object.assign(Agent.hooks, {
    onUser: (text, pics) => UI.user(text, pics),
    onAssistantStart: () => UI.assistant(),
    onText: (view, d) => UI.text(view, d),
    onThinking: (view, d) => UI.thinking(view, d),
    onAssistantEnd: (view) => UI.assistantEnd(view),
    onToolStart: (name, input) => UI.toolStart(name, input),
    onToolEnd: (handle, result) => UI.toolEnd(handle, result),
    onError: (msg) => UI.error(msg),
    onNote: (msg) => UI.system(msg),
    approve: (name, input) => UI.approve(name, input),
    onStatus: (state, extra) => {
      const step = (extra && extra.step) || 0;
      const note = extra && extra.note;
      if (state === "busy") UI.status("busy", note ? note.toUpperCase() : `WORKING · STEP ${step || 1}`);
      else paintReady();
      paintStats(step);
    },
    onDone: ({ steps }) => paintStats(steps),
  });

  Object.assign(Commands.hooks, {
    mode: () => settings.mode,
    setMode: (mode) => {
      settings.mode = mode;
      $("mode").value = mode;
      saveSettings();
    },
    queue: () => queue.slice(),
    clearQueue: () => dropQueue(),
  });

  Object.assign(Tools.hooks, {
    preview: (path) => UI.mountPreview(path),
    log: (msg) => UI.sandboxLog(msg),
  });

  VFS.onChange(() => {
    UI.renderTree();
    paintStats();
  });

  /* ── boot ───────────────────────────────────────────────────────────────── */

  Agent.setSettings(settings);
  paintSettings();
  UI.renderTools();
  UI.renderTree();
  paintStats();
  paintReady();
  paintQueue();
  paintShots();
  setRunning(false);

  if (Agent.turns) {
    UI.system(`restored a session with ${Agent.turns} message(s) of context. ` +
              `The transcript above is fresh, but the model still remembers. ` +
              `Use /clear to start clean.`);
  }
  if (VFS.count()) UI.system(`workspace restored: ${VFS.count()} file(s)`);
  const rules = Agent.rulesFiles();
  if (rules.length) {
    UI.system(`project rules loaded: ${rules.map((f) => `${f.path} (${f.bytes}b)`).join(", ")} ` +
              `— appended to the system prompt on every turn. /rules to review.`);
  } else if (VFS.count()) {
    UI.system("no AGENTS.md in this workspace — /init writes one, and every turn " +
              "after that carries it.");
  }
  if (location.protocol === "file:") {
    UI.system("running from file:// — the harness works, but agents you build " +
              "need a real origin for ES modules. Use `preview` / `run_agent` here, " +
              "and `python3 -m http.server` after exporting.");
  }

  // No key is the one state where the panel matters more than the prompt.
  if (settings.key) checkKey({ quiet: true });
  else $("tab-keys").checked = true;

  input.focus();
})();
