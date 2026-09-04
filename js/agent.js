/* ═══════════════════════════════════════════════════════════════════════════
   Agent — the harness's own loop.

   Same shape as the loop it teaches the model to write: send the conversation
   plus every tool declaration, execute whatever comes back, append all results
   as one turn, repeat until the model stops asking for tools.
   ═══════════════════════════════════════════════════════════════════════════ */
window.Agent = (function () {
  /* The conversation belongs to the workspace it is about, so both keys are
     scoped the way the VFS's is — asked for per access, never captured. */
  const sessionKey = () => Workspaces.key("buttercup.session.v1");
  const ctxKey = () => Workspaces.key("buttercup.context.v1");

  const PLACE = `# Where you are
No server, no shell, no node. Your workspace is a virtual filesystem in this browser's localStorage, and your tools are plain JavaScript functions in this page. What you build must therefore run in a browser too: static HTML/CSS/ES modules, \`fetch\` to CORS-friendly endpoints, localStorage or IndexedDB for state. Read \`framework_docs {"framework":"harness"}\` once per session for how the sandbox behaves.`;

  const VOICE = `# Talking to the user
You are writing into a terminal transcript. Be brief and concrete; lead with what changed and where. Reference files as \`path/to/file.js\`. No preamble, no restating the request, no summary of code you just showed. Mention API-key exposure once, when you first write a file that sends a key from a browser — it is a real constraint, not a disclaimer to repeat.`;

  /* A mode is only a system prompt, and `systemFor` is called on every step —
     so `set_mode` mid-turn means the very next step is written by the
     specialist, with the conversation intact. Every mode carries this section,
     because the mode the user is in is rarely the mode the request needs. */
  const SWITCH = `# Modes
This harness has one mode per kind of work; the mode you are in is a system prompt and nothing more. \`set_mode\` swaps it, keeps the conversation, and takes effect on your next step — so switching costs one tool call, not a restart. Its own description lists the modes.

Switch as your *first* action, before reading or writing anything, when the request belongs to a mode other than this one. Say nothing about the switch beyond the one line the tool gives you; the user can see it. Do not switch on a passing mention of another domain, do not switch twice in one turn, and never switch to escape a hard part of the current job.`;

  const AGENT_BUILDER = `You are buttercup.sh — a coding agent that builds *other* AI agents, running entirely inside a browser tab.

${PLACE}

# What you are for
Turning a description into a working agent: an agent loop, a set of tool definitions, a provider adapter, and a page the user can open. The default target is Blocks.AI / Blocks Network (npm \`@blocks-network/sdk\`, CLI \`@blocks-network/cli\`), where the agent runtime is Node and the consumer client is browser-safe — read \`framework_docs {"framework":"blocks-ai"}\` for that split and be straight with the user about which half runs where. Support the other frameworks when asked.

# How to work
- Call \`framework_docs\` with no argument first on any build task, then read the notes for the framework you are going to use.
- Never write code against a package's API from memory. Confirm it: \`npm_info\`, then \`npm_file\` for the type declarations, then \`run_js\` with a dynamic import to see the real export names. If a package cannot be reached, say so and use the dependency-free path instead of inventing exports.
- \`scaffold\` first, then edit. Rewriting the skeleton by hand wastes turns.
- Use \`todo\` for anything with three or more steps, and keep it current.
- Verify before you claim: \`run_agent\` for modules, \`run_js\` for snippets, \`preview\` then \`screenshot\` for pages. If something failed, report which step failed and what the error said — do not describe unverified code as working.
- Batch independent tool calls in one turn. Read a file before editing it.
- Finish the job. If part of it is blocked (offline, CORS, an unknown API), complete everything else and state plainly what you left and why.

${SWITCH}

${VOICE}`;

  const GENERAL = `You are buttercup.sh in general mode — a coding agent working inside a browser tab. Build whatever the user asks for; agents are just one thing you can make here.

${PLACE}

# How to work
- \`list\` / \`read\` before you edit. \`write\` overwrites without warning.
- Use \`todo\` for anything with three or more steps, and keep it current.
- Never write code against a package's API from memory. Confirm it: \`npm_info\`, then \`npm_file\` for the type declarations, then \`run_js\` with a dynamic import to see the real export names.
- Verify before you claim: \`run_js\` for snippets, \`run_agent\` for modules, \`preview\` then \`screenshot\` for pages — and \`navigate\` to click and type through the flow you built. If something failed, report which step failed and what the error said.
- Batch independent tool calls in one turn.
- If the task turns out to be an agent build — an agent loop, tools for a model, MCP, Blocks.AI — \`set_mode {"mode":"agent-builder"}\` first and build it from that prompt. \`scaffold\` and \`framework_docs\` are here either way; ignore them when the task is not an agent.
- Finish the job. If part of it is blocked (offline, CORS, an unknown API), complete everything else and state plainly what you left and why.

${SWITCH}

${VOICE}`;

  /* A CDN import is the only way to reach a library from here — there is no
     install step — so every mode that leans on one says the same thing about
     pinning it. */
  const CDN = `# Dependencies
There is no \`npm install\` here. A library arrives as an ESM import from a CDN — \`https://esm.sh/<pkg>@<version>\` — and it must be pinned to an exact version, because an unpinned import silently changes what the page does. Confirm the version and the export names before you write against them: \`npm_info\`, then \`npm_file\` for the type declarations, then \`run_js\` with a dynamic import. If the CDN cannot be reached, say so and write the dependency-free version instead of guessing at an API.`;

  const SLIDES = `You are buttercup.sh in slides mode — a coding agent that builds presentations, running entirely inside a browser tab.

${PLACE}

# What you are for
Turning notes, an outline or a rough argument into a deck the user can present from and hand out: one self-contained \`index.html\` that opens with a double-click, no build and no server. Default to a hand-rolled deck — sections for slides, arrow keys and space to advance, \`?\`/\`Esc\` for an overview, a print stylesheet so ⌘P gives a PDF. Reach for reveal.js only when the user asks for it or wants something the hand-rolled deck cannot do; then pin it.

# How to work
- Write the outline before the HTML: titles and the one claim each slide makes. Show it to the user when the deck is more than a handful of slides, and use \`todo\` to track the build.
- One idea per slide, and text large enough to read from the back of a room — 28px is a floor for body copy, not a target. If a slide needs a paragraph, it is two slides or it is speaker notes.
- Speaker notes belong in the file (a hidden element per slide, revealed in a presenter view or on print), not in the transcript.
- Diagrams and charts: inline SVG or a \`<canvas>\` you draw yourself. Never a remote image the deck cannot load offline.
- Verify with \`preview\`, then step through every slide with \`navigate\` and \`screenshot\` — an off-by-one in the navigation is the failure mode here, and you can only see it by looking. Say which slides you actually looked at.
- Finish the deck. If a slide is blocked on content only the user has, leave a clearly marked placeholder and name it in your reply.

${CDN}

${SWITCH}

${VOICE}`;

  const GAME_DEV = `You are buttercup.sh in game-dev mode — a coding agent that builds games and interactive toys, running entirely inside a browser tab.

${PLACE}

# What you are for
Playable things: a page the user opens and immediately controls. Pick the renderer by dimension and say why in one line — pixi.js for 2D sprites and particles, three.js for 3D scenes, plain \`<canvas>\` 2D when the game is small enough that a dependency costs more than it saves, DOM when it is really a UI. Both libraries come in as pinned ESM imports; three.js also needs its addons pinned to the same version.

# How to work
- Get something moving on screen in the first build — a controllable thing on a background — then layer mechanics onto a page that already runs.
- Structure it: a fixed-timestep update separate from render, input as a held-keys map read by update (never gameplay in the keydown handler), state in one object you can serialize. \`requestAnimationFrame\` gives you \`dt\`; nothing may assume 60fps.
- Assets are generated, not fetched: draw sprites into a canvas, build geometry in code, synthesize sound with WebAudio. A remote asset is a broken game the first time it is opened offline.
- Clean up what you start — cancel the frame loop, remove listeners, dispose three.js geometries and materials — so a reload does not leak.
- Verify with \`preview\`, then \`navigate\` and \`screenshot\`: confirm the loop runs, the keys and clicks move what they should, and the console is clean — \`navigate\` reports the page's console errors with every action. State plainly what you could not test by looking (feel, difficulty, anything needing sustained play) and let the user judge it.
- Finish the loop before polishing. A game with win/lose and a restart beats a prettier fragment.

${CDN}

${SWITCH}

${VOICE}`;

  const DATA_VIZ = `You are buttercup.sh in data-viz mode — a coding agent that builds charts and dashboards, running entirely inside a browser tab.

${PLACE}

# What you are for
Turning data the user has into something readable: a static page with charts, tables and filters. The data usually arrives as a file dropped into the workspace (CSV, JSON, NDJSON) — read it before you plot it. Inline SVG covers most charts and has no dependency; use a pinned CDN import of d3 for scales and layout maths, or Chart.js when the user wants the stock interactive look. Prefer embedding the data in the page over fetching it, so the artefact keeps working on its own.

# How to work
- Read the real file first, with \`read\` and \`run_js\`: row count, columns, types, how missing values are spelled, the actual min and max. Never chart a shape you assumed.
- Say what the chart is answering, then pick the form for it — time series a line, comparison across categories bars, distribution a histogram, correlation a scatter. Refuse to make a pie chart of eight slices; say why and offer bars.
- Label everything: axis titles with units, a legend when there is more than one series, and axes that start at zero when the mark is a bar. Sort categories by value unless their own order means something.
- One accessible categorical palette across the whole page, distinguishable in greyscale, plus a direct value on hover or in a table beneath the chart — colour alone is never the only channel.
- Verify with \`preview\` and \`screenshot\`, and check the numbers on the page against what \`run_js\` computed from the file. A chart that renders beautifully off the wrong aggregate is the failure mode here.
- Report the caveats you found in the data — gaps, outliers, rows you dropped and why — rather than quietly smoothing them away.

${CDN}

${SWITCH}

${VOICE}`;

  const MODES = {
    "agent-builder": { system: AGENT_BUILDER, blurb: "builds AI agents (blocks.ai by default)" },
    general: { system: GENERAL, blurb: "builds anything static in a browser" },
    slides: { system: SLIDES, blurb: "builds presentation decks (one self-contained page)" },
    "game-dev": { system: GAME_DEV, blurb: "builds games (pixi.js 2D, three.js 3D, canvas)" },
    "data-viz": { system: DATA_VIZ, blurb: "builds charts and dashboards from your data" },
  };
  const DEFAULT_MODE = "general";

  /* ── project rules ────────────────────────────────────────────────────────
     `AGENTS.md` in the workspace is read fresh on every request and appended to
     the mode's system prompt, so editing it takes effect on the next turn with
     no reload and no session reset. The convention is the one Cursor, Codex and
     opencode already use, which means a repo's existing file just works.
     ─────────────────────────────────────────────────────────────────────────── */

  const RULES_PATHS = ["AGENTS.md", ".buttercup/AGENTS.md", "CLAUDE.md"];
  const RULES_CAP = 20000;

  /** Every rules file that exists, in precedence order, with its text. */
  function rulesFiles() {
    const out = [];
    for (const path of RULES_PATHS) {
      let text;
      try { text = VFS.exists(path) ? VFS.read(path).trim() : ""; } catch (_) { continue; }
      if (!text) continue;
      const clipped = text.length > RULES_CAP;
      out.push({ path, text: clipped ? text.slice(0, RULES_CAP) : text, bytes: text.length, clipped });
    }
    return out;
  }

  /** The rules section, or "" when the workspace has no rules file. */
  function rulesPrompt() {
    const files = rulesFiles();
    if (!files.length) return "";
    const blocks = files.map((f) =>
      `## ${f.path}\n\n${f.text}${f.clipped ? `\n\n[truncated at ${RULES_CAP} characters — read ${f.path} for the rest]` : ""}`
    );
    return [
      "",
      "",
      "# Project rules",
      "The user wrote the following into the workspace. It is instruction, not",
      "reference material: where it disagrees with your defaults above, it wins.",
      "Read it as already-established context and do not ask the user to repeat it.",
      "",
      ...blocks,
    ].join("\n");
  }

  function systemFor(settings) {
    const system = (MODES[settings.mode] || MODES[DEFAULT_MODE]).system + rulesPrompt();
    // Lean toolsets advertise a subset, and the mode prompts name tools that
    // are not among them. One honest line beats a model dialing phantom calls.
    if (!(LLM.providers[settings.provider] || {}).leanTools) return system;
    return system +
      `\n\n# Lean toolset` +
      `\nOnly the tools in the tool list above exist right now; this prompt may name` +
      `\nothers (npm_info, npm_file, run_agent, navigate, screenshot, scaffold,` +
      `\nframework_docs, export_zip) that are unavailable here. Work with the list` +
      `\nyou have, and say plainly when a task needs a tool you do not have.` +
      `\n\n# Pace` +
      `\nReason briefly: a few short sentences of deliberation at most before acting,` +
      `\nnone at all for trivial steps (reads, deletes, single edits). Every thinking` +
      `\ntoken costs the user a second of wall clock. Never guess at paths — list or` +
      `\nglob first, and prefer edit over write for files that already exist.`;
  }

  /* ── compaction ───────────────────────────────────────────────────────────
     A browser tab has no way to summarize cheaply on a server, so compaction is
     one extra completion with no tools attached: the model writes a handover
     note to itself, and the note becomes the entire conversation. The workspace
     is untouched, which is what makes this safe — the files are the real state,
     the transcript is only how the model got there.
     ─────────────────────────────────────────────────────────────────────────── */

  const COMPACT_SYSTEM = `You are compacting a coding session so it can continue inside a smaller context window. Write a handover note for the agent that picks this session up with no other memory of it. That agent can read every file in the workspace, so do not reproduce file contents — record what it needs to know that the files do not say.`;

  const COMPACT_ASK = `Write the handover note now, as these sections:

## Goal
What the user asked for, in their words, and every constraint they stated.

## Done
File by file: \`path\` → what it is and what state it is in.

## Verified
What was actually run and what it printed. Separately, what is still unverified.

## Decided
Choices made and why, including approaches tried and ruled out, so they are not retried.

## Next
The exact next step, and anything the next agent must not redo.

Facts only. Keep every path, package name and API name verbatim. No preamble, no closing summary.`;

  const COMPACT_FLOOR = 8000;

  /* Vendor phrasings for "this request will not fit" — matches WebLLM's
     "Prompt tokens exceed context window size" and the cloud vendors' own. */
  const OVERFLOW = /prompt tokens exceed|context window|context length|too many tokens|maximum context|context overflow/i;

  /* One wall clock for every trace line, shared with the `[webllm]` logs —
     optimization is timing, and timing needs a common reference. */
  const stamp = () => {
    const d = new Date();
    return `${d.toTimeString().slice(0, 8)}.${String(d.getMilliseconds()).padStart(3, "0")}`;
  };
  const log = (...args) => console.log(`[${stamp()} agent]`, ...args);

  /** What to report when something throws: its message, or the thing itself. */
  const errText = (err) => String(err && err.message ? err.message : err);

  /** Who to talk to — the credential half of every completion request. */
  const creds = (settings) => ({
    provider: settings.provider,
    model: settings.model,
    apiKey: settings.key,
    baseUrl: settings.baseUrl,
  });

  /** Add one reply's token cost to the session total. */
  const bill = (usage) => {
    state.usage.input += usage.input;
    state.usage.output += usage.output;
  };

  const hooks = {
    onUser: () => {},
    onAssistantStart: () => {},
    onText: () => {},
    onThinking: () => {},
    onAssistantEnd: () => {},
    onToolStart: () => {},
    onToolEnd: () => {},
    onError: () => {},
    onStatus: () => {},
    onDone: () => {},
    onNote: () => {},
    approve: async () => "allow",
  };

  const state = {
    messages: load(),
    busy: false,
    controller: null,
    steps: 0,
    usage: { input: 0, output: 0 },
    context: loadContext(),   // tokens the last request actually cost, in + out
    settings: null,           // assigned by main.js
    /* The lean-engine wire: the frozen prefix already sent, plus the verbatim
       char budget and duplicate set spent building it. Null trail = rebuild,
       which reinitialises the other two. */
    wireTrail: null,
    wireBudget: 0,
    wireSeen: null,
  };

  function load() {
    try {
      const raw = localStorage.getItem(sessionKey());
      const parsed = raw ? JSON.parse(raw) : null;
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) { return []; }
  }

  /**
   * The context estimate survives a reload with the session it describes;
   * without it a restored 150k-token conversation would look empty until the
   * first reply came back, which is exactly one request too late.
   */
  function loadContext() {
    const n = Number(localStorage.getItem(ctxKey()));
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  /**
   * The session with its pictures replaced by a note. Base64 images are by far
   * the largest thing a conversation can carry, so this is the first thing to
   * give up when the quota says no — and only in the saved copy: the model
   * keeps seeing the real images for the rest of this page load.
   */
  const textOnly = (messages) => messages.map((m) => ({
    role: m.role,
    parts: m.parts.map((p) => {
      if (p.type === "image") {
        return { type: "text", text: "[an image was here; it was dropped when this session was saved]" };
      }
      // A screenshot rides on its tool result; the words survive, the picture
      // does not, and the result says so where the model will read it.
      if (p.type === "tool_result" && p.shots && p.shots.length) {
        const { shots, ...rest } = p;
        return { ...rest, output: `${p.output}\n[the picture was dropped when this session was saved]` };
      }
      return p;
    }),
  }));

  let saidQuota = false;

  function persist() {
    try {
      // `raw` is wire-only — it exists so the next request can repeat the
      // engine's own words. Saving it would double every session's storage
      // for a benefit one full prefill after a reload provides anyway.
      localStorage.setItem(sessionKey(), JSON.stringify(state.messages, (k, v) => (k === "raw" ? undefined : v)));
      localStorage.setItem(ctxKey(), String(state.context));
    } catch (_) {
      if (!saidQuota) {
        saidQuota = true;
        hooks.onNote(
          "this session is larger than localStorage will hold, so the images in it are not being saved. " +
          "They stay in the conversation for this page load; after a reload the model sees a note where each one was."
        );
      }
      try {
        localStorage.setItem(sessionKey(), JSON.stringify(textOnly(state.messages)));
        localStorage.setItem(ctxKey(), String(state.context));
      } catch (__) {
        // Still too large: keep the tail, which is what matters. The wire trail
        // prefixes history by position, so dropping messages from the front
        // invalidates it — rebuild it on the next step.
        state.messages = state.messages.slice(-20);
        state.wireTrail = null;
        try { localStorage.setItem(sessionKey(), JSON.stringify(textOnly(state.messages))); } catch (___) {}
      }
    }
  }

  /* ── checkpoints ──────────────────────────────────────────────────────────
     `capture` is a shallow copy on purpose: a message is never mutated after it
     is pushed, so copying the array is enough to freeze the conversation, and
     the workspace snapshot is a fresh object either way.
     ─────────────────────────────────────────────────────────────────────────── */

  function capture() {
    return { messages: state.messages.slice(), files: VFS.snapshot(), context: state.context };
  }

  function apply(snap) {
    state.messages = snap.messages.slice();
    state.context = snap.context || 0;
    state.wireTrail = null;   // history changed under the trail; rebuild once
    VFS.restore(snap.files);
    persist();
  }

  /** Record where we are, so `/undo` can come back to it. */
  function mark(text) {
    Checkpoints.mark(capture(), text);
  }

  function step(direction) {
    if (state.busy) throw new Error("still working — press STOP first");
    const before = { files: VFS.count(), turns: state.messages.length };
    const target = direction === "redo" ? Checkpoints.redo(capture()) : Checkpoints.undo(capture());
    if (!target) {
      throw new Error(direction === "redo"
        ? "nothing to redo — /redo only works right after /undo, and only within this page load"
        : "nothing to undo — the stack starts empty on every page load");
    }
    apply(target);
    return {
      label: target.label,
      turns: state.messages.length,
      droppedTurns: before.turns - state.messages.length,
      files: VFS.count(),
      changedFiles: VFS.count() - before.files,
      depth: Checkpoints.depth,
      redoDepth: Checkpoints.redoDepth,
    };
  }

  /**
   * Trim a trailing assistant turn whose tool calls never got results — the
   * shape STOP leaves behind. Anthropic rejects a `tool_use` with no
   * `tool_result`, and compaction is the one place we re-send that tail.
   */
  function resolved(messages) {
    const out = messages.slice();
    while (out.length) {
      const last = out[out.length - 1];
      if (last.role === "assistant" && last.parts.some((p) => p.type === "tool_use")) { out.pop(); continue; }
      break;
    }
    return out;
  }

  function compactAt(settings) {
    const user = Math.max(COMPACT_FLOOR, Number(settings && settings.compactAt) || 120000);
    // In-tab engines allocate a fixed window; compaction must fire well before
    // it fills, or the request dies on the allocation instead of summarizing.
    const window = LLM.contextWindow(settings && settings.provider, settings && settings.model);
    return window ? Math.min(user, Math.floor(window * 0.6)) : user;
  }

  /**
   * Replace the conversation with a summary of it. One completion, no tools.
   * Marks a checkpoint first, so `/undo` gets the full context back.
   */
  async function compact({ reason = "manual", signal } = {}) {
    const settings = state.settings;
    if (!settings || (!settings.key && !LLM.providers[settings.provider]?.keyless)) {
      throw new Error("no API key — compaction needs one model call");
    }
    const source = resolved(state.messages);
    if (source.length < 2) throw new Error(`nothing worth compacting (${source.length} message(s) of context)`);

    const before = { turns: state.messages.length, context: state.context };
    log(`compacting (${reason}) — ${before.turns} message(s), context ~${before.context} tok`);
    // `/compact` runs outside a turn, so it has to claim the busy flag itself —
    // otherwise a request typed while the summary is streaming would race it.
    const standalone = !state.busy;
    if (standalone) {
      state.busy = true;
      state.controller = new AbortController();
    }
    hooks.onStatus("busy", { step: state.steps, note: "compacting" });

    let reply;
    try {
      reply = await LLM.complete({
        ...creds(settings),
        effort: "low",
        system: COMPACT_SYSTEM,
        messages: forProvider(
          forCompaction([...source, { role: "user", parts: [{ type: "text", text: COMPACT_ASK }] }], settings),
          settings.provider,
        ),
        tools: [],
        signal: signal || (state.controller && state.controller.signal),
      });
    } finally {
      if (standalone) {
        state.busy = false;
        state.controller = null;
        hooks.onStatus("idle");
      }
    }

    const note = reply.parts.filter((p) => p.type === "text").map((p) => p.text).join("").trim();
    bill(reply.usage);
    if (!note) throw new Error("the model returned an empty summary — context left exactly as it was");

    // A request in flight survives verbatim: compaction can land mid-turn, and
    // paraphrasing what the user just asked for is the one thing a summary of
    // the session must not do.
    // Images do not survive this: the note is text, and a picture cannot be
    // quoted into it. What the user said about the picture does.
    const last = state.messages[state.messages.length - 1];
    const pending = last && last.role === "user" && last.parts.length
      && last.parts.every((p) => p.type === "text" || p.type === "image")
      ? last.parts.filter((p) => p.type === "text").map((p) => p.text).join("\n")
      : "";

    mark(`before compact (${before.turns} messages)`);
    const parts = [{
      type: "text",
      text: `# Earlier in this session (compacted)\nThe conversation up to here was replaced by the note below; it is all you remember of it. Every workspace file is untouched and is the source of truth — read one instead of guessing.\n\n${note}`,
    }];
    if (pending) parts.push({ type: "text", text: `# The request you are working on, verbatim\n\n${pending}` });
    state.messages = [{ role: "user", parts }];
    state.context = reply.usage.output;
    state.wireTrail = null;   // the trail no longer prefixes history
    persist();

    const info = {
      reason,
      turns: before.turns,
      kept: 1,
      note: note.length,
      before: before.context,
      after: state.context,
      cost: reply.usage.input + reply.usage.output,
    };
    hooks.onNote(
      `compacted (${reason}) — ${info.turns} message(s) → 1 handover note of ${info.note} chars, ` +
      `context ~${info.before} → ~${info.after} tok, ${info.cost} tok spent summarizing. /undo restores the full context.`
    );
    log(`compaction done — note ${info.note} chars · ~${info.before} → ~${info.after} tok · cost ${info.cost} tok`);
    return info;
  }

  /**
   * Run one user request to completion. Resolves when the loop stops.
   * `shots` are attached images (see js/images.js); either half may be empty,
   * but not both — a picture on its own is a complete request.
   */
  async function send(text, shots = []) {
    if (state.busy) throw new Error("already running");
    if (!text && !shots.length) throw new Error("nothing to send");
    const settings = state.settings;
    state.busy = true;
    state.controller = new AbortController();
    state.steps = 0;
    let approveAll = !!settings.yolo;

    // Where `/undo` comes back to: the state before this request touched
    // anything, conversation and workspace together.
    mark(text || `${shots.length} image(s)`);

    // Images lead the turn: every vendor reads a caption after the picture it
    // is about, and a bare prompt with the picture last reads as a non-sequitur.
    const parts = shots.map((s) => ({ type: "image", mediaType: s.mediaType, data: s.data }));
    if (text) parts.push({ type: "text", text });
    state.messages.push({ role: "user", parts });
    hooks.onUser(text, shots);
    persist();
    hooks.onStatus("busy");

    try {
      const maxSteps = Math.max(1, Number(settings.maxSteps) || 40);
      // Lives across steps on purpose: the nudge is appended on the step after
      // the blank reply, so a counter scoped to one step would reset before it
      // was ever read.
      let nudges = 0;

      for (let step = 0; step < maxSteps; step++) {
        state.steps = step + 1;
        hooks.onStatus("busy", { step: state.steps });
        log(`step ${state.steps} — context ~${state.context} tok`);

        // Compact *before* spending a request we know is too big, not after the
        // vendor rejects it. The estimate is the last reply's own token count.
        if (settings.autoCompact && state.context >= compactAt(settings)) {
          try {
            await compact({ reason: `auto at ${compactAt(settings)} tok` });
          } catch (err) {
            if (err && err.name === "AbortError") throw err;
            log(`auto-compaction failed — ${String((err && err.message) || err).slice(0, 120)}`);
            hooks.onError(`auto-compaction failed (${err.message}) — continuing with the full context`);
            state.context = 0;   // do not retry on every step of this turn
          }
        }

        const view = hooks.onAssistantStart();
        let reply;
        const lean = !!(LLM.providers[settings.provider] || {}).leanTools;
        // Lean gating is a property of this turn's provider, not of whichever
        // call last asked for schemas — `compact` never asks for any.
        Tools.setLean(lean);
        const attempt = () => {
          // Append-only wire for lean engines: already-sent history is frozen
          // in state.wireTrail (KV reuse dies on any byte difference), each
          // step sends trail + elision of new messages only. The verbatim
          // budget and the duplicate set travel with the trail, so the whole
          // wire shares one budget — a per-batch budget would keep every
          // step's newest results whole and then freeze them, which is how an
          // 8k window fills. When the budget can no longer cover the newest
          // results, the trail is thrown away and re-elided newest-first: one
          // re-prefill, but the model still sees the output it just asked for.
          let base;
          if (lean) {
            let trail = (state.wireTrail && state.wireTrail.length <= state.messages.length)
              ? state.wireTrail
              : null;
            let fresh = trail ? state.messages.slice(trail.length) : null;
            // Only worth a re-prefill when the new results are big enough to be
            // stubbed; anything under the stub threshold travels whole anyway.
            if (trail && resultChars(fresh) > MIN_VERBATIM && state.wireBudget < MIN_VERBATIM) {
              log(`wire: verbatim budget spent — re-eliding the whole wire newest-first`);
              trail = null;
              fresh = null;
            }
            if (trail) {
              if (fresh.length) {
                const e = elideResults(fresh, state.wireBudget, state.wireSeen);
                state.wireBudget = e.budget;
                base = trail.concat(e.out);
                log(`wire: ${trail.length} held + ${fresh.length} new message(s) · budget ${e.budget}c left`);
              } else {
                base = trail;
              }
            } else {
              state.wireSeen = new Set();
              const e = elideResults(state.messages, ELIDE_BUDGET, state.wireSeen);
              state.wireBudget = e.budget;
              base = e.out;
              log(`wire: full rebuild — ${base.length} message(s), KV re-prefills`);
            }
            state.wireTrail = base;
          } else {
            base = state.messages;
          }
          // A blank stream is answered with a wire-only push to speak, not an
          // end-of-turn error: the nudge rides on the last user message, so
          // the model reads it as part of the turn it just went silent in.
          const messages = nudges
            ? base.map((m, i) => i === base.length - 1 && m.role === "user"
                ? { ...m, parts: [...m.parts, { type: "text", text: BLANK_NUDGE }] }
                : m)
            : base;
          return LLM.complete({
            ...creds(settings),
            effort: settings.effort,
            system: systemFor(settings),
            messages: forProvider(messages, settings.provider),
            tools: Tools.schemas(lean),
            signal: state.controller.signal,
            on: {
              text: (d) => hooks.onText(view, d),
              thinking: (d) => settings.showThinking && hooks.onThinking(view, d),
              toolStart: () => {},
              // Freeform progress from slow backends (WebLLM's weight fetch).
              status: (note, progress) => hooks.onStatus("busy", {
                step: state.steps, note: String(note).slice(0, 56), progress,
              }),
            },
          });
        };
        try {
          try {
            reply = await attempt();
            // One free retry — degenerate empty streams are transient.
            if (isBlankReply(reply)) {
              log("blank reply (no text, no calls) — retrying the step once");
              reply = await attempt();
            }
          } catch (err) {
            // Backstop for a request that slipped past the size estimate — a
            // big tool result can outrun the last reply's token count. One
            // compact-and-retry, then the error stands (opencode's rule).
            const msg = String((err && err.message) || err);
            if (!settings.autoCompact || !OVERFLOW.test(msg)) throw err;
            hooks.onNote(`context overflow (${msg.length > 80 ? msg.slice(0, 80) + "…" : msg}) — compacting and retrying this step once`);
            try {
              await compact({ reason: "overflow" });
            } catch (cerr) {
              if (cerr && cerr.name === "AbortError") throw cerr;
              throw err;
            }
            reply = await attempt();
          }
          // Every path above funnels here: a still-blank reply is answered
          // with a wire-only nudge (an append, not a rebuild) rather than an
          // end-of-turn error — including the reply that follows a
          // compact-and-retry.
          if (isBlankReply(reply)) {
            if (nudges >= 1) {
              throw new Error("the model returned empty replies after a nudge — ask again, or pick a different model");
            }
            nudges++;
            log("still blank — nudging the model to speak on the next step");
            hooks.onNote("the model went quiet — nudging it to continue");
            continue;
          }
          nudges = 0;
        } finally {
          hooks.onAssistantEnd(view);
        }

        bill(reply.usage);
        // What this request cost is the best measure of the context the next one
        // will carry — the tab cannot tokenize, and every vendor counts its own.
        state.context = reply.usage.input + reply.usage.output;
        const tally = {};
        for (const p of reply.parts) {
          const t = (tally[p.type] = tally[p.type] || { n: 0, chars: 0 });
          t.n++;
          t.chars += p.type === "tool_use" ? JSON.stringify(p.input || {}).length : (p.text || "").length;
        }
        log(`reply ${reply.usage.input} in / ${reply.usage.output} out tok · ` +
            Object.entries(tally).map(([k, v]) => `${k}×${v.n} (${v.chars}c)`).join(" · ") +
            (reply.usage.think ? ` · think ≈${reply.usage.think} tok` : ""));
        // `raw` rides along: web-llm's KV reuse needs the resent assistant
        // turn to byte-match what the engine stored.
        state.messages.push({
          role: "assistant",
          parts: reply.parts,
          ...(reply.raw ? { raw: reply.raw } : {}),
        });
        persist();

        const calls = reply.parts.filter((p) => p.type === "tool_use");
        if (!calls.length) return;   // `finally` reports the turn as done

        const results = [];
        for (const call of calls) {
          const handle = hooks.onToolStart(call.name, call.input);
          log(`→ ${call.name} ${JSON.stringify(call.input).slice(0, 100)}`);

          if (!approveAll && Tools.needsApproval(call.name)) {
            const verdict = await hooks.approve(call.name, call.input, handle);
            if (verdict === "always") approveAll = true;
            if (verdict === "deny") {
              const output = "The user denied this tool call. Do not retry it; ask what to do instead.";
              hooks.onToolEnd(handle, { ok: false, output });
              results.push({ type: "tool_result", id: call.id, name: call.name, output, error: true });
              continue;
            }
          }

          const t0 = performance.now();
          try {
            // A tool may hand back pictures as well as words — `screenshot`
            // does — and they ride on the result part into the next request.
            const { output, shots } = await Tools.run(call.name, call.input);
            log(`← ${call.name} ${output.length} chars ≈${Math.round(output.length / 4)} tok` +
                `${shots.length ? ` +${shots.length} img` : ""} in ${(performance.now() - t0).toFixed(0)}ms`);
            hooks.onToolEnd(handle, { ok: true, output, shots });
            results.push({ type: "tool_result", id: call.id, name: call.name, output, ...(shots.length ? { shots } : {}) });
          } catch (err) {
            const output = errText(err);
            log(`← ${call.name} FAILED in ${(performance.now() - t0).toFixed(0)}ms — ${output.slice(0, 120)}`);
            hooks.onToolEnd(handle, { ok: false, output });
            results.push({ type: "tool_result", id: call.id, name: call.name, output, error: true });
          }
        }

        // All results in one turn: splitting them teaches the model to stop
        // requesting parallel tool calls.
        state.messages.push({ role: "user", parts: results });
        persist();
      }

      hooks.onError(`stopped after ${maxSteps} steps (the max-steps setting). Ask it to continue if that was too soon.`);
    } catch (err) {
      if (err && err.name === "AbortError") {
        log("turn aborted — stopped by user");
        hooks.onError("stopped by user");
      } else {
        log(`turn failed — ${errText(err).slice(0, 120)}`);
        hooks.onError(errText(err));
      }
    } finally {
      state.busy = false;
      state.controller = null;
      hooks.onStatus("idle");
      hooks.onDone({ steps: state.steps });
      log(`turn done — ${state.steps} step(s)`);
    }
  }

  /** Wire-only push appended to the last user message after a blank stream —
      never stored, so /undo and compaction never see it. */
  const BLANK_NUDGE =
    "Your previous reply arrived empty. Continue the task now: say what you are doing or run a tool.";

  /** Degenerate stream: no text, no calls — the small MLC builds do this
      now and then, and ending the turn silently on it teaches the user. */
  function isBlankReply(r) {
    return !r.parts.some((p) => p.type === "tool_use") &&
           !r.parts.some((p) => p.type === "text" && (p.text || "").trim());
  }

  /** How many chars of tool output a lean session may carry verbatim
      (3000 chars ≈ 750 tokens), spent once across the whole wire. */
  const ELIDE_BUDGET = 3000;

  /**
   * The per-request view of history for lean engines: tool results stay
   * verbatim while the shared char budget lasts, the result that crosses it is
   * clipped, everything after it shrinks to a stub, exact duplicates collapse
   * to a stub, and big write/edit payloads become "re-read the file".
   * Canonical history is untouched; on the wire, elision runs once as a
   * message first enters the trail, so this only ever sees new messages —
   * which is why `budget` and `seen` are passed in and handed back.
   * @returns {{out: object[], budget: number}}
   */
  function elideResults(messages, budget = ELIDE_BUDGET, seen = new Set()) {
    let before = 0, after = 0, touched = 0, total = 0, stubs = 0;
    const out = [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      let parts = null;
      const swap = (j, output) => {
        if (!parts) parts = m.parts.slice();
        parts[j] = { ...m.parts[j], output };
      };
      for (let j = m.parts.length - 1; j >= 0; j--) {
        const p = m.parts[j];
        // A write/edit payload is dead weight once it is on the wire — the file
        // on disk is the source of truth and the model can re-read it.
        if (p.type === "tool_use" && (p.name === "write" || p.name === "edit")) {
          const payload = JSON.stringify(p.input || {});
          if (payload.length > 400) {
            const input = { path: (p.input && p.input.path) || "", applied: true, elided: `${payload.length} chars — re-read the file` };
            if (!parts) parts = m.parts.slice();
            parts[j] = { ...p, input };
            before += payload.length;
            after += JSON.stringify(input).length;
            stubs++;
          }
          continue;
        }
        if (p.type !== "tool_result" || typeof p.output !== "string" || (p.shots && p.shots.length)) continue;
        total++;
        before += p.output.length;
        const key = `${p.name}\u0000${p.output}`;
        if (seen.has(key)) {
          swap(j, `[${p.name} result elided — identical to an earlier result; re-run the tool if you need it again]`);
          after += parts[j].output.length;
          touched++;
          continue;
        }
        seen.add(key);
        if (budget > 0) {
          if (p.output.length <= budget) { budget -= p.output.length; after += p.output.length; continue; }
          swap(j, p.output.slice(0, budget) +
            `\n…[${p.name} result truncated here (${p.output.length} chars total) — re-run the tool for the rest]`);
          after += parts[j].output.length;
          touched++;
          budget = 0;
          continue;
        }
        if (p.output.length <= 400) { after += p.output.length; continue; }
        swap(j, `[${p.name} result elided (${p.output.length} chars) — re-run the tool if you need it]`);
        after += parts[j].output.length;
        touched++;
      }
      // `raw` is the engine's own text and takes precedence on the wire, so a
      // message whose parts were elided must give it up — otherwise the stub
      // is built and then ignored. Costs one re-prefill from this turn on;
      // the trail freezes the result, so it is paid once.
      out.unshift(parts ? { role: m.role, parts } : m);
    }
    if (touched || stubs) {
      log(`elision: ${touched}/${total} result(s) trimmed` +
          (stubs ? ` · ${stubs} write payload(s) stubbed` : "") +
          ` — ${before} → ${after} chars (≈${Math.round((before - after) / 4)} tok saved)`);
    }
    return { out, budget };
  }

  /** Chars of tool output a batch of messages carries — what elision spends. */
  function resultChars(messages) {
    let n = 0;
    for (const m of messages || []) {
      for (const p of m.parts) {
        if (p.type === "tool_result" && typeof p.output === "string") n += p.output.length;
      }
    }
    return n;
  }

  /** Below this the remaining budget cannot say anything useful about a new
      result, so re-eliding the whole wire beats stubbing it. */
  const MIN_VERBATIM = 400;

  /**
   * The compaction request for a lean engine. Compaction is triggered by an
   * estimate taken from the *elided* wire, so sending un-elided history here is
   * how compaction itself overflows the window — and then there is no way back.
   * `raw` goes too: this request carries a different system prompt, so there is
   * no KV prefix to match, and keeping it would hide the elision.
   */
  function forCompaction(messages, settings) {
    if (!(LLM.providers[settings.provider] || {}).leanTools) return messages;
    const window = LLM.contextWindow(settings.provider, settings.model) || 8192;
    const cap = Math.floor(window * 0.5) * 4;   // chars, at ≈4 chars/token
    const { out } = elideResults(messages.map((m) => ({ role: m.role, parts: m.parts })), 1200);
    // Newest first, because the oldest turns are the ones the note can afford
    // to lose — and the ask itself is last, so it is never the message dropped.
    const kept = [];
    let total = 0;
    for (let i = out.length - 1; i >= 0; i--) {
      const size = JSON.stringify(out[i]).length;
      if (kept.length && total + size > cap) {
        log(`compaction wire: dropped the oldest ${i + 1} message(s) to fit ${cap} chars`);
        break;
      }
      total += size;
      kept.unshift(out[i]);
    }
    return kept;
  }

  /**
   * Thinking blocks are only replayable to the model that produced them, and
   * only Anthropic accepts them back at all. Everyone else gets them dropped.
   */
  function forProvider(messages, provider) {
    if (provider !== "anthropic") {
      // `raw` must ride along — web-llm's KV reuse dies if the assistant turn
      // is re-rendered from parts instead of byte-matching what it stored.
      return messages.map((m) => ({
        role: m.role,
        parts: m.parts.filter((p) => p.type !== "thinking"),
        ...(m.raw ? { raw: m.raw } : {}),
      })).filter((m) => m.parts.length);
    }
    // Anthropic keeps thinking blocks only for the current tool cycle — the
    // turns since the last real user message; older ones are billed dead
    // weight. state.messages is untouched.
    let cut = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === "user" && m.parts.some((p) => p.type !== "tool_result")) { cut = i; break; }
    }
    return messages.map((m, i) => {
      if (i >= cut) return m;
      const parts = m.parts.filter((p) => p.type !== "thinking");
      return parts.length === m.parts.length ? m : { role: m.role, parts, ...(m.raw ? { raw: m.raw } : {}) };
    }).filter((m) => m.parts.length);
  }

  return {
    hooks,
    send,
    compact,
    modes: MODES,
    defaultMode: DEFAULT_MODE,
    rulesPaths: RULES_PATHS,
    rulesFiles,
    stop() { if (state.controller) state.controller.abort(); },
    get busy() { return state.busy; },
    get usage() { return state.usage; },
    get turns() { return state.messages.length; },
    get context() { return state.context; },
    contextLimit() { return compactAt(state.settings || {}); },
    setSettings(s) { state.settings = s; },

    /** Checkpoint the current state under `label`, then rewind or replay it. */
    mark,
    undo() { return step("undo"); },
    redo() { return step("redo"); },
    get undoDepth() { return Checkpoints.depth; },
    get redoDepth() { return Checkpoints.redoDepth; },

    /**
     * Pick the conversation up out of whichever workspace is active now. The
     * session total resets with it: what this project's turns have cost is not
     * the sum of every project opened in this tab.
     */
    reload() {
      state.messages = load();
      state.context = loadContext();
      state.usage = { input: 0, output: 0 };
      state.steps = 0;
      state.wireTrail = null;
      return state.messages.length;
    },

    reset() {
      state.messages = [];
      state.usage = { input: 0, output: 0 };
      state.context = 0;
      state.wireTrail = null;
      localStorage.removeItem(sessionKey());
      localStorage.removeItem(ctxKey());
    },
  };
})();
