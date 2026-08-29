/* ═══════════════════════════════════════════════════════════════════════════
   Agent — the harness's own loop.

   Same shape as the loop it teaches the model to write: send the conversation
   plus every tool declaration, execute whatever comes back, append all results
   as one turn, repeat until the model stops asking for tools.
   ═══════════════════════════════════════════════════════════════════════════ */
window.Agent = (function () {
  const SESSION_KEY = "buttercup.session.v1";

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
  const DEFAULT_MODE = "agent-builder";

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
    approve: async () => "allow",
  };

  const state = {
    messages: load(),
    busy: false,
    controller: null,
    steps: 0,
    usage: { input: 0, output: 0 },
    settings: null,       // assigned by main.js
  };

  function load() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) { return []; }
  }

  function persist() {
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify(state.messages));
    } catch (_) {
      // Session too large for the quota: keep the tail, which is what matters.
      state.messages = state.messages.slice(-20);
      try { localStorage.setItem(SESSION_KEY, JSON.stringify(state.messages)); } catch (__) {}
    }
  }

  /** Run one user request to completion. Resolves when the loop stops. */
  async function send(text) {
    if (state.busy) throw new Error("already running");
    const settings = state.settings;
    state.busy = true;
    state.controller = new AbortController();
    state.steps = 0;
    let approveAll = !!settings.yolo;

    state.messages.push({ role: "user", parts: [{ type: "text", text }] });
    hooks.onUser(text);
    persist();
    hooks.onStatus("busy");

    try {
      const maxSteps = Math.max(1, Number(settings.maxSteps) || 40);

      for (let step = 0; step < maxSteps; step++) {
        state.steps = step + 1;
        hooks.onStatus("busy", { step: state.steps });

        const view = hooks.onAssistantStart();
        let reply;
        try {
          reply = await LLM.complete({
            provider: settings.provider,
            model: settings.model,
            apiKey: settings.key,
            baseUrl: settings.baseUrl,
            effort: settings.effort,
            system: (MODES[settings.mode] || MODES[DEFAULT_MODE]).system,
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

        state.usage.input += reply.usage.input;
        state.usage.output += reply.usage.output;
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
            const output = String(err && err.message ? err.message : err);
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
      else hooks.onError(String(err && err.message ? err.message : err));
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
    modes: MODES,
    defaultMode: DEFAULT_MODE,
    stop() { if (state.controller) state.controller.abort(); },
    get busy() { return state.busy; },
    get usage() { return state.usage; },
    get turns() { return state.messages.length; },
    setSettings(s) { state.settings = s; },
    reset() {
      state.messages = [];
      state.usage = { input: 0, output: 0 };
      localStorage.removeItem(SESSION_KEY);
    },
  };
})();
