/* ═══════════════════════════════════════════════════════════════════════════
   main — wiring. Settings, event handlers, and the hook-ups between the
   agent loop, the tools, the slash commands, and the UI.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  const $ = (id) => document.getElementById(id);
  const SETTINGS_KEY = "buttercup.settings.v1";

  const DEFAULTS = {
    provider: "anthropic",
    model: LLM.defaultModel("anthropic"),
    baseUrl: LLM.defaultUrl("anthropic"),
    key: "",
    effort: "xhigh",
    mode: Agent.defaultMode,
    yolo: true,
    showThinking: true,
    maxSteps: 40,
    autoCompact: true,
    compactAt: 120000,
  };

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
    $("provider").value = settings.provider;
    $("model").value = settings.model;
    $("baseUrl").value = settings.baseUrl;
    $("key").value = settings.key;
    $("effort").value = settings.effort;
    $("mode").value = settings.mode;
    $("yolo").checked = settings.yolo;
    $("showThinking").checked = settings.showThinking;
    $("maxSteps").value = settings.maxSteps;
    $("autoCompact").checked = settings.autoCompact;
    $("compactAt").value = settings.compactAt;
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
    $("key").value = key;
    const provider = $("provider").value;
    settings = {
      provider,
      model: $("model").value.trim() || LLM.defaultModel(provider),
      baseUrl: $("baseUrl").value.trim() || LLM.defaultUrl(provider),
      key,
      effort: $("effort").value,
      mode: $("mode").value,
      yolo: $("yolo").checked,
      showThinking: $("showThinking").checked,
      maxSteps: Number($("maxSteps").value) || 40,
      autoCompact: $("autoCompact").checked,
      compactAt: Number($("compactAt").value) || DEFAULTS.compactAt,
    };
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

  /* ── prompt ─────────────────────────────────────────────────────────────── */

  const input = $("prompt-input");

  function grow() {
    input.rows = Math.min(6, input.value.split("\n").length);
  }

  input.addEventListener("input", grow);
  input.addEventListener("keydown", (e) => {
    // Enter sends; Shift+Enter is a newline. Terminal muscle memory.
    if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      $("prompt-form").requestSubmit();
    }
  });

  /**
   * Run a slash command and report it in the transcript. A command that hands
   * back a prompt (`/init`) then runs as a normal request.
   */
  async function runCommand(text) {
    UI.user(text);
    let out;
    // `/compact` spends a model call, so STOP has to work while it runs.
    setRunning(true);
    try {
      out = await Commands.run(text);
      if (out.text) UI.system(out.text);
    } catch (err) {
      UI.error(String(err && err.message ? err.message : err));
    } finally {
      setRunning(false);
    }
    paintStats();
    if (out && out.prompt) await runPrompt(out.prompt);
  }

  /** Send one request to the model, once we know the key is good for it. */
  async function runPrompt(text) {
    if (!settings.key) {
      $("tab-keys").checked = true;
      UI.error("no API key. Open the KEYS panel, pick a provider, paste a key, press SAVE.");
      return;
    }
    // The lamp says READY only once the vendor has agreed; make that true
    // before spending a turn on a key that will be rejected anyway.
    if (!keyOk && !(await checkKey())) {
      $("tab-keys").checked = true;
      return;
    }

    setRunning(true);
    try {
      await Agent.send(text);
    } finally {
      setRunning(false);
      input.focus();
    }
  }

  $("prompt-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    if (Agent.busy) return UI.error("still working — press STOP first");

    input.value = "";
    grow();

    if (Commands.is(text)) return runCommand(text);
    await runPrompt(text);
  });

  $("stop").addEventListener("click", () => Agent.stop());

  function setRunning(on) {
    $("send").disabled = on;
    $("stop").disabled = !on;
  }

  /* ── hook-ups ───────────────────────────────────────────────────────────── */

  Object.assign(Agent.hooks, {
    onUser: (text) => UI.user(text),
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
