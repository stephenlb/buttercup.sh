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
   ═══════════════════════════════════════════════════════════════════════════ */
window.Commands = (function () {

  /** Assigned by main.js: mode lives in settings, which main.js owns. */
  const hooks = {
    mode: () => Agent.defaultMode,
    setMode: () => {},
  };

  const DEFS = [
    {
      name: "help",
      usage: "/help",
      help: "list these commands",
      run() {
        const rows = DEFS.map((d) => `  ${d.usage.padEnd(30)} ${d.help}`);
        return [
          "commands (handled in this tab; never sent to the model):",
          ...rows,
          "",
          "anything else you type is a request for the agent.",
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
      name: "clear",
      usage: "/clear",
      help: "forget the conversation and clear the transcript; workspace files stay",
      run() {
        const turns = Agent.turns;
        Agent.reset();
        UI.clearLog();
        return `context cleared — ${turns} message(s) dropped, ${VFS.count()} workspace file(s) kept`;
      },
    },
    {
      name: "wipe",
      usage: "/wipe",
      help: "delete every workspace file as well as the conversation — no undo",
      run() {
        const files = VFS.count();
        if (files && !confirm(`Delete all ${files} workspace files and this conversation? This cannot be undone.`)) {
          return "wipe cancelled — nothing was deleted";
        }
        Agent.reset();
        VFS.wipe();
        UI.closeViewer();
        UI.clearLog();
        return `wiped — ${files} file(s) deleted, context gone`;
      },
    },
  ];

  const byName = Object.fromEntries(DEFS.map((d) => [d.name, d]));

  return {
    hooks,
    defs: DEFS,

    /** True when a prompt line is a command rather than a request. */
    is: (text) => /^\/\S/.test(text.trim()),

    /** Execute one command line. Returns the text to print; throws on failure. */
    async run(text) {
      const [, name, rest = ""] = text.trim().match(/^\/(\S*)\s*([\s\S]*)$/);
      const def = byName[name.toLowerCase()];
      if (!def) {
        throw new Error(`unknown command '/${name}'. Try ${DEFS.map((d) => "/" + d.name).join(", ")}`);
      }
      return String((await def.run(rest.trim(), text)) ?? "");
    },
  };
})();
