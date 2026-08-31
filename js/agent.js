/* ═══════════════════════════════════════════════════════════════════════════
   Agent — the harness's own loop.

   Same shape as the loop it teaches the model to write: send the conversation
   plus every tool declaration, execute whatever comes back, append all results
   as one turn, repeat until the model stops asking for tools.
   ═══════════════════════════════════════════════════════════════════════════ */
window.Agent = (function () {
  const SESSION_KEY = "buttercup.session.v1";
  const CTX_KEY = "buttercup.context.v1";

  const PLACE = `# Where you are
No server, no shell, no node. Your workspace is a virtual filesystem in this browser's localStorage, and your tools are plain JavaScript functions in this page. What you build must therefore run in a browser too: static HTML/CSS/ES modules, \`fetch\` to CORS-friendly endpoints, localStorage or IndexedDB for state. Read \`framework_docs {"framework":"harness"}\` once per session for how the sandbox behaves.`;

  const VOICE = `# Talking to the user
You are writing into a terminal transcript. Be brief and concrete; lead with what changed and where. Reference files as \`path/to/file.js\`. No preamble, no restating the request, no summary of code you just showed. Mention API-key exposure once, when you first write a file that sends a key from a browser — it is a real constraint, not a disclaimer to repeat.`;

  const AGENT_BUILDER = `You are buttercup.sh — a coding agent that builds *other* AI agents, running entirely inside a browser tab.

${PLACE}

# What you are for
Turning a description into a working agent: an agent loop, a set of tool definitions, a provider adapter, and a page the user can open. The default target is Blocks.AI / Blocks Network (npm \`@blocks-network/sdk\`, CLI \`@blocks-network/cli\`), where the agent runtime is Node and the consumer client is browser-safe — read \`framework_docs {"framework":"blocks-ai"}\` for that split and be straight with the user about which half runs where. Support the other frameworks when asked.

# How to work
- Call \`framework_docs\` with no argument first on any build task, then read the notes for the framework you are going to use.
- Never write code against a package's API from memory. Confirm it: \`npm_info\`, then \`npm_file\` for the type declarations, then \`run_js\` with a dynamic import to see the real export names. If a package cannot be reached, say so and use the dependency-free path instead of inventing exports.
- \`scaffold\` first, then edit. Rewriting the skeleton by hand wastes turns.
- Use \`todo\` for anything with three or more steps, and keep it current.
- Verify before you claim: \`run_agent\` for modules, \`run_js\` for snippets, \`preview\` for pages. If something failed, report which step failed and what the error said — do not describe unverified code as working.
- Batch independent tool calls in one turn. Read a file before editing it.
- Finish the job. If part of it is blocked (offline, CORS, an unknown API), complete everything else and state plainly what you left and why.

${VOICE}`;

  const GENERAL = `You are buttercup.sh in general mode — a coding agent working inside a browser tab. Build whatever the user asks for; agents are just one thing you can make here.

${PLACE}

# How to work
- \`list\` / \`read\` before you edit. \`write\` overwrites without warning.
- Use \`todo\` for anything with three or more steps, and keep it current.
- Never write code against a package's API from memory. Confirm it: \`npm_info\`, then \`npm_file\` for the type declarations, then \`run_js\` with a dynamic import to see the real export names.
- Verify before you claim: \`run_js\` for snippets, \`run_agent\` for modules, \`preview\` for pages. If something failed, report which step failed and what the error said.
- Batch independent tool calls in one turn.
- \`scaffold\` and \`framework_docs\` are still here if the task turns out to be an agent build; ignore them otherwise.
- Finish the job. If part of it is blocked (offline, CORS, an unknown API), complete everything else and state plainly what you left and why.

${VOICE}`;

  const MODES = {
    "agent-builder": { system: AGENT_BUILDER, blurb: "builds AI agents (blocks.ai by default)" },
    general: { system: GENERAL, blurb: "builds anything static in a browser" },
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
    return (MODES[settings.mode] || MODES[DEFAULT_MODE]).system + rulesPrompt();
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
  };

  function load() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
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
    const n = Number(localStorage.getItem(CTX_KEY));
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  function persist() {
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify(state.messages));
      localStorage.setItem(CTX_KEY, String(state.context));
    } catch (_) {
      // Session too large for the quota: keep the tail, which is what matters.
      state.messages = state.messages.slice(-20);
      try { localStorage.setItem(SESSION_KEY, JSON.stringify(state.messages)); } catch (__) {}
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
    return Math.max(COMPACT_FLOOR, Number(settings && settings.compactAt) || 120000);
  }

  /**
   * Replace the conversation with a summary of it. One completion, no tools.
   * Marks a checkpoint first, so `/undo` gets the full context back.
   */
  async function compact({ reason = "manual", signal } = {}) {
    const settings = state.settings;
    if (!settings || !settings.key) throw new Error("no API key — compaction needs one model call");
    const source = resolved(state.messages);
    if (source.length < 2) throw new Error(`nothing worth compacting (${source.length} message(s) of context)`);

    const before = { turns: state.messages.length, context: state.context };
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
        messages: forProvider([...source, { role: "user", parts: [{ type: "text", text: COMPACT_ASK }] }], settings.provider),
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
    const last = state.messages[state.messages.length - 1];
    const pending = last && last.role === "user" && last.parts.length && last.parts.every((p) => p.type === "text")
      ? last.parts.map((p) => p.text).join("\n")
      : "";

    mark(`before compact (${before.turns} messages)`);
    const parts = [{
      type: "text",
      text: `# Earlier in this session (compacted)\nThe conversation up to here was replaced by the note below; it is all you remember of it. Every workspace file is untouched and is the source of truth — read one instead of guessing.\n\n${note}`,
    }];
    if (pending) parts.push({ type: "text", text: `# The request you are working on, verbatim\n\n${pending}` });
    state.messages = [{ role: "user", parts }];
    state.context = reply.usage.output;
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
    return info;
  }

  /** Run one user request to completion. Resolves when the loop stops. */
  async function send(text) {
    if (state.busy) throw new Error("already running");
    const settings = state.settings;
    state.busy = true;
    state.controller = new AbortController();
    state.steps = 0;
    let approveAll = !!settings.yolo;

    // Where `/undo` comes back to: the state before this request touched
    // anything, conversation and workspace together.
    mark(text);

    state.messages.push({ role: "user", parts: [{ type: "text", text }] });
    hooks.onUser(text);
    persist();
    hooks.onStatus("busy");

    try {
      const maxSteps = Math.max(1, Number(settings.maxSteps) || 40);

      for (let step = 0; step < maxSteps; step++) {
        state.steps = step + 1;
        hooks.onStatus("busy", { step: state.steps });

        // Compact *before* spending a request we know is too big, not after the
        // vendor rejects it. The estimate is the last reply's own token count.
        if (settings.autoCompact && state.context >= compactAt(settings)) {
          try {
            await compact({ reason: `auto at ${compactAt(settings)} tok` });
          } catch (err) {
            if (err && err.name === "AbortError") throw err;
            hooks.onError(`auto-compaction failed (${err.message}) — continuing with the full context`);
            state.context = 0;   // do not retry on every step of this turn
          }
        }

        const view = hooks.onAssistantStart();
        let reply;
        try {
          reply = await LLM.complete({
            ...creds(settings),
            effort: settings.effort,
            system: systemFor(settings),
            messages: forProvider(state.messages, settings.provider),
            tools: Tools.schemas(),
            signal: state.controller.signal,
            on: {
              text: (d) => hooks.onText(view, d),
              thinking: (d) => settings.showThinking && hooks.onThinking(view, d),
              toolStart: () => {},
            },
          });
        } finally {
          hooks.onAssistantEnd(view);
        }

        bill(reply.usage);
        // What this request cost is the best measure of the context the next one
        // will carry — the tab cannot tokenize, and every vendor counts its own.
        state.context = reply.usage.input + reply.usage.output;
        state.messages.push({ role: "assistant", parts: reply.parts });
        persist();

        const calls = reply.parts.filter((p) => p.type === "tool_use");
        if (!calls.length) return;   // `finally` reports the turn as done

        const results = [];
        for (const call of calls) {
          const handle = hooks.onToolStart(call.name, call.input);

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

          try {
            const output = await Tools.run(call.name, call.input);
            hooks.onToolEnd(handle, { ok: true, output });
            results.push({ type: "tool_result", id: call.id, name: call.name, output });
          } catch (err) {
            const output = errText(err);
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
      if (err && err.name === "AbortError") hooks.onError("stopped by user");
      else hooks.onError(errText(err));
    } finally {
      state.busy = false;
      state.controller = null;
      hooks.onStatus("idle");
      hooks.onDone({ steps: state.steps });
    }
  }

  /**
   * Thinking blocks are only replayable to the model that produced them, and
   * only Anthropic accepts them back at all. Everyone else gets them dropped.
   */
  function forProvider(messages, provider) {
    if (provider === "anthropic") return messages;
    return messages.map((m) => ({
      role: m.role,
      parts: m.parts.filter((p) => p.type !== "thinking"),
    })).filter((m) => m.parts.length);
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

    reset() {
      state.messages = [];
      state.usage = { input: 0, output: 0 };
      state.context = 0;
      localStorage.removeItem(SESSION_KEY);
      localStorage.removeItem(CTX_KEY);
    },
  };
})();
