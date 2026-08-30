/* ═══════════════════════════════════════════════════════════════════════════
   Commands — the `/slash` layer in front of the prompt.

   A line starting with `/` never reaches the model: it is handled here, in this
   tab, synchronously. Each entry declares its own help text so `/help` and the
   unknown-command error are generated from the same list.

   Contract for a command:
     name    what the user types after the slash
     usage   one-line signature shown by /help
     help    what it does, written for a human
     run(rest, all) -> string printed to the transcript (throw to report failure)

   A command may also return `{ text, prompt }`: `text` is printed as before and
   `prompt` is handed to the agent as if the user had typed it. That is how
   `/init` works — the command itself cannot read a codebase, but it knows
   exactly what to ask for.
   ═══════════════════════════════════════════════════════════════════════════ */
window.Commands = (function () {

  /** Assigned by main.js: mode lives in settings, which main.js owns. */
  const hooks = {
    mode: () => Agent.defaultMode,
    setMode: () => {},
    queue: () => [],
    clearQueue: () => 0,
  };

  const INIT_PROMPT = `Write the project rules file for this workspace.

Read what is actually here first — \`list\`, then \`read\` the entry points, the manifests and anything that looks like configuration. Do not guess and do not describe files that do not exist.

Then write \`AGENTS.md\` at the workspace root: the standing instructions a fresh agent session needs on its first turn and cannot get from a filename. Cover only what applies here — how to run and verify the thing, the shape of the codebase and where the seams are, the conventions this code already follows, and the gotchas that would otherwise be learned the hard way. Concise, imperative, no boilerplate headings with nothing under them.

If \`AGENTS.md\` already exists, read it and improve it in place: keep what is still true, correct what is not, add what is missing. Never blank it and start over.

The harness loads this file into your system prompt on every turn from now on, so every line costs context on every request. Earn each one.`;

  const DEFS = [
    {
      name: "help",
      usage: "/help",
      help: "list these commands",
      instant: true,
      run() {
        const rows = DEFS.map((d) => `  ${d.usage.padEnd(30)} ${d.help}`);
        return [
          "commands (handled in this tab; never sent to the model):",
          ...rows,
          "",
          "anything else you type is a request for the agent. Type while one is",
          "running and it queues behind it — see /queue.",
        ].join("\n");
      },
    },
    {
      name: "queue",
      usage: "/queue [clear]",
      help: "show what is waiting behind the current request, or drop all of it",
      instant: true,
      run(rest) {
        if (rest === "clear") {
          const n = hooks.clearQueue();
          return n ? `queue cleared — ${n} request(s) dropped` : "queue was already empty";
        }
        if (rest) throw new Error("usage: /queue [clear]");
        const items = hooks.queue();
        if (!items.length) {
          return "queue empty — type while a request is running and it waits here instead of being refused.";
        }
        return [
          `${items.length} request(s) waiting, in order:`,
          ...items.map((t, i) => `  ${i + 1}. ${t.split("\n")[0].slice(0, 72)}`),
          "",
          "The × beside each one drops it; STOP drops the whole queue with the running request.",
        ].join("\n");
      },
    },
    {
      name: "mode",
      usage: "/mode [" + Object.keys(Agent.modes).join("|") + "]",
      help: "show or switch what the agent is told it is for",
      run(rest) {
        const ids = Object.keys(Agent.modes);
        if (!rest) {
          return [
            `mode: ${hooks.mode()}`,
            ...ids.map((id) => `  ${id === hooks.mode() ? "*" : " "} ${id.padEnd(14)} ${Agent.modes[id].blurb}`),
          ].join("\n");
        }
        if (!Agent.modes[rest]) throw new Error(`unknown mode '${rest}'. Known: ${ids.join(", ")}`);
        hooks.setMode(rest);
        return `mode → ${rest} · ${Agent.modes[rest].blurb} (applies to the next turn; context kept)`;
      },
    },
    {
      name: "init",
      usage: "/init",
      help: "have the agent read the workspace and write AGENTS.md",
      run() {
        const existing = Agent.rulesFiles().find((f) => f.path === "AGENTS.md");
        return {
          text: existing
            ? `AGENTS.md exists (${existing.bytes}b) — asking the agent to improve it in place, not replace it.`
            : "asking the agent to read the workspace and write AGENTS.md.",
          prompt: INIT_PROMPT,
        };
      },
    },
    {
      name: "rules",
      usage: "/rules",
      help: `show the project rules currently in the system prompt (${Agent.rulesPaths[0]})`,
      run() {
        const files = Agent.rulesFiles();
        if (!files.length) {
          return [
            "no project rules loaded.",
            `Write any of these and every turn from then on carries it: ${Agent.rulesPaths.join(", ")}.`,
            "`/init` will have the agent draft one from what is already in the workspace.",
          ].join("\n");
        }
        return [
          `${files.length} rules file(s) appended to the system prompt on every turn:`,
          ...files.map((f) => `  ${f.path.padEnd(24)} ${f.bytes}b${f.clipped ? "  (truncated in-prompt)" : ""}`),
          "",
          "Edit the file and the next turn picks it up — no reload, no /clear.",
        ].join("\n");
      },
    },
    {
      name: "compact",
      usage: "/compact",
      help: "summarize the conversation into a handover note and continue from it",
      async run() {
        const info = await Agent.compact({ reason: "manual" });
        return `context ~${info.before} → ~${info.after} tok. Workspace untouched.`;
      },
    },
    {
      name: "undo",
      usage: "/undo",
      help: "rewind the conversation and the files to before the last request",
      run() {
        const r = Agent.undo();
        return describe("undone", r);
      },
    },
    {
      name: "redo",
      usage: "/redo",
      help: "replay what /undo rewound",
      run() {
        const r = Agent.redo();
        return describe("redone", r);
      },
    },
    {
      name: "clear",
      usage: "/clear",
      help: "forget the conversation and clear the transcript; workspace files stay",
      run() {
        const turns = Agent.turns;
        Agent.mark(`before /clear (${turns} messages)`);
        Agent.reset();
        UI.clearLog();
        return `context cleared — ${turns} message(s) dropped, ${VFS.count()} workspace file(s) kept. /undo brings the context back.`;
      },
    },
    {
      name: "wipe",
      usage: "/wipe",
      help: "delete every workspace file as well as the conversation",
      run() {
        const files = VFS.count();
        if (files && !confirm(`Delete all ${files} workspace files and this conversation?\n\n/undo can restore them until this tab is closed — a reload cannot.`)) {
          return "wipe cancelled — nothing was deleted";
        }
        Agent.mark(`before /wipe (${files} files)`);
        Agent.reset();
        VFS.wipe();
        UI.closeViewer();
        UI.clearLog();
        return `wiped — ${files} file(s) deleted, context gone. /undo restores both until this tab closes.`;
      },
    },
  ];

  /** One line for an /undo or /redo, in the terms the user cares about. */
  function describe(verb, r) {
    const files = r.changedFiles === 0
      ? `${r.files} file(s) unchanged`
      : `${r.files} file(s) (${r.changedFiles > 0 ? "+" : ""}${r.changedFiles})`;
    return [
      `${verb}: ${r.label}`,
      `  context ${r.turns} message(s)${r.droppedTurns ? ` (${r.droppedTurns > 0 ? "−" : "+"}${Math.abs(r.droppedTurns)})` : ""} · workspace ${files}`,
      `  ${r.depth} undo / ${r.redoDepth} redo left. The transcript above is scrollback and keeps the record.`,
    ].join("\n");
  }

  const byName = Object.fromEntries(DEFS.map((d) => [d.name, d]));

  return {
    hooks,
    defs: DEFS,

    /** True when a prompt line is a command rather than a request. */
    is: (text) => /^\/\S/.test(text.trim()),

    /**
     * True for a command that only reads state, so it is safe to answer while a
     * request is already running instead of queueing it behind that request.
     */
    isInstant(text) {
      const m = text.trim().match(/^\/(\S*)/);
      const def = m && byName[m[1].toLowerCase()];
      return !!(def && def.instant);
    },

    /**
     * Execute one command line. Throws on failure. Resolves to
     * `{ text, prompt }`: `text` goes to the transcript, `prompt` (when set)
     * goes to the agent as a request.
     */
    async run(text) {
      const [, name, rest = ""] = text.trim().match(/^\/(\S*)\s*([\s\S]*)$/);
      const def = byName[name.toLowerCase()];
      if (!def) {
        throw new Error(`unknown command '/${name}'. Try ${DEFS.map((d) => "/" + d.name).join(", ")}`);
      }
      const out = (await def.run(rest.trim(), text)) ?? "";
      if (out && typeof out === "object") return { text: String(out.text ?? ""), prompt: out.prompt || "" };
      return { text: String(out), prompt: "" };
    },
  };
})();
