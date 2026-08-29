/* ═══════════════════════════════════════════════════════════════════════════
   main — wiring. Settings, event handlers, and the hook-ups between the
   agent loop, the tools, and the UI.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  const $ = (id) => document.getElementById(id);
  const SETTINGS_KEY = "buttercup.settings.v1";

  const DEFAULTS = {
    provider: "anthropic",
    model: LLM.defaultModel("anthropic"),
    key: "",
    effort: "xhigh",
    yolo: true,
    showThinking: true,
    maxSteps: 40,
  };

  let settings = loadSettings();

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

  function paintStats() {
    const u = Agent.usage;
    UI.stats({
      provider: settings.provider,
      model: settings.model || "(no model)",
      tokens: u.input + u.output,
      steps: 0,
    });
  }

  /* ── settings form ──────────────────────────────────────────────────────── */

  function fillModelList() {
    const list = $("model-list");
    list.replaceChildren();
    for (const name of LLM.providers[settings.provider].models) {
      const opt = document.createElement("option");
      opt.value = name;
      list.appendChild(opt);
    }
    $("key").placeholder = `${LLM.providers[settings.provider].keyHint} — stays in this browser`;
  }

  function paintSettings() {
    $("provider").value = settings.provider;
    $("model").value = settings.model;
    $("key").value = settings.key;
    $("effort").value = settings.effort;
    $("yolo").checked = settings.yolo;
    $("showThinking").checked = settings.showThinking;
    $("maxSteps").value = settings.maxSteps;
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
    settings = {
      provider: $("provider").value,
      model: $("model").value.trim() || LLM.defaultModel($("provider").value),
      key,
      effort: $("effort").value,
      yolo: $("yolo").checked,
      showThinking: $("showThinking").checked,
      maxSteps: Number($("maxSteps").value) || 40,
    };
    saveSettings();
  }

  $("provider").addEventListener("change", () => {
    // Switching vendors invalidates the model name and the key alike.
    settings.provider = $("provider").value;
    settings.model = LLM.defaultModel(settings.provider);
    settings.key = "";
    paintSettings();
    saveSettings();
    UI.system(`provider → ${settings.provider}. Paste a ${settings.provider} key.`);
  });

  $("settings-form").addEventListener("submit", (e) => {
    e.preventDefault();
    readSettings();
    UI.system(`saved · ${settings.provider} · ${settings.model} · effort ${settings.effort}`);
  });

  $("forget").addEventListener("click", () => {
    settings.key = "";
    $("key").value = "";
    saveSettings();
    UI.system("key cleared from this browser");
  });

  $("reset-session").addEventListener("click", () => {
    Agent.reset();
    UI.system("new session — the model's memory of this conversation is gone (workspace kept)");
    paintStats();
  });

  /* ── workspace panel ────────────────────────────────────────────────────── */

  $("download-zip").addEventListener("click", () => {
    if (!VFS.count()) return UI.error("workspace is empty; nothing to export");
    Zip.download("agent-workspace.zip", Zip.build(VFS.snapshot()));
    UI.system(`exported ${VFS.count()} file(s)`);
  });

  $("wipe").addEventListener("click", () => {
    if (!VFS.count()) return;
    if (!confirm(`Delete all ${VFS.count()} workspace files? This cannot be undone.`)) return;
    VFS.wipe();
    $("viewer").hidden = true;
    UI.system("workspace wiped");
  });

  $("viewer-close").addEventListener("click", () => { $("viewer").hidden = true; });

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

  $("prompt-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    if (Agent.busy) return UI.error("still working — press STOP first");
    if (!settings.key) {
      UI.error("no API key. Open the KEYS panel, pick a provider, paste a key, press SAVE.");
      $("tab-keys").checked = true;
      return;
    }
    input.value = "";
    grow();
    setRunning(true);
    try {
      await Agent.send(text);
    } finally {
      setRunning(false);
      input.focus();
    }
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
    approve: (name, input) => UI.approve(name, input),
    onStatus: (state, extra) => {
      UI.status(state === "busy" ? "busy" : "idle",
        state === "busy" ? `WORKING · STEP ${(extra && extra.step) || 1}` : "READY");
      const u = Agent.usage;
      UI.stats({
        provider: settings.provider, model: settings.model,
        tokens: u.input + u.output, steps: (extra && extra.step) || 0,
      });
    },
    onDone: () => paintStats(),
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
  UI.status("idle", "READY");
  setRunning(false);

  if (Agent.turns) {
    UI.system(`restored a session with ${Agent.turns} message(s) of context. ` +
              `The transcript above is fresh, but the model still remembers. ` +
              `Use NEW SESSION in KEYS to start clean.`);
  }
  if (VFS.count()) UI.system(`workspace restored: ${VFS.count()} file(s)`);
  if (location.protocol === "file:") {
    UI.system("running from file:// — the harness works, but agents you build " +
              "need a real origin for ES modules. Use `preview` / `run_agent` here, " +
              "and `python3 -m http.server` after exporting.");
  }

  input.focus();
})();
