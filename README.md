# ButterCup Web Agent Harness

**buttercup.sh** — emdashes welcome.

<img width="2034" height="1316" alt="preview" src="https://github.com/user-attachments/assets/25dc7e3f-f6b1-474a-9872-7e6b665d4304" />

## Why this exists

To show that anyone can build a coding harness — the thing Claude Code, Codex,
Cursor and Antigravity are — in a web browser, and read the whole of it in an
afternoon.

A coding harness is not much: a loop that sends a conversation to a model, hands
it a list of tools, runs the tools it asks for, and puts the results back in the
conversation. Everything else — the file tree, the diff view, the approval gate,
the undo stack, compaction — is scaffolding around that loop. None of it needs a
server, a build step, or a framework. This repository is the proof: static HTML,
CSS and JavaScript, classic `<script>` tags, no modules, no bundler, no
dependencies, nothing to compile.

```
git clone … && open index.html
```

That is the whole setup. Read `js/agent.js` for the loop, `js/tools.js` for the
tools, `js/llm.js` for the wire protocols. Fork it and the harness is yours.

## Open source, standalone, and quiet

The code is open source and runs from a file on your disk. There is no backend to
deploy and nothing to proxy through, because there is nothing in the middle: the
tab talks to whichever model endpoint you point it at, directly.

**Point it at a local model and nothing leaves your machine.** With Ollama or
vLLM the harness makes no network request to any third party — not for telemetry,
not for analytics, not for updates, not for the code it writes. Your keys, your
conversation and your files live in this browser's `localStorage` and are never
transmitted anywhere except to the vendor you explicitly selected.

Code the agent writes runs in a `sandbox="allow-scripts"` iframe on an opaque
origin, so it cannot reach this page, this DOM, or your keys.
`allow-same-origin` is never granted.

---

## Key configuration

Open `index.html`. It starts on the **KEYS** panel and stays there until a key
validates. Pick a vendor, paste a key, press **SAVE**, and wait for the lamp in
the title bar to turn from red **NOT READY** to green **READY** — **SAVE**
validates the key against the vendor's model list, so a bad key fails here
instead of halfway through a turn. No tokens are spent.

| Vendor | Default model | Key | Notes |
| --- | --- | --- | --- |
| Ollama | `qwen3-coder:30b` | none | Local: `http://localhost:11434/v1` |
| vLLM | *(you type one)* | none | Local: `http://localhost:8000/v1` |
| Anthropic | `claude-opus-5` | `sk-ant-…` | Adaptive thinking, effort control |
| OpenAI | `gpt-5.6` | `sk-…` | Chat Completions + `reasoning_effort` |
| xAI | `grok-4.1` | `xai-…` | `api.x.ai/v1` |
| Google | `gemini-3.1-pro-preview` | `AIza…` | `streamGenerateContent?alt=sse` |
| OpenRouter | `anthropic/claude-opus-4.5` | `sk-or-v1-…` | Any model the account can reach |
| FreeBuff | *(you type one)* | gateway key | Any OpenAI-compatible gateway |

Three wire formats cover all eight — Anthropic Messages, Google
`generateContent`, and OpenAI-style `/chat/completions` (shared by six). That is
why a **base url** field appears when you pick a chat-completions vendor: any
gateway speaking that shape works without a code change.

### Running fully local

The two local providers drop the **api key** row and the `Authorization` header
entirely. Both need CORS permission to accept a call from the tab:

```
OLLAMA_ORIGINS='https://buttercup.sh' ollama serve
vllm serve <model> --allowed-origins '["https://buttercup.sh"]'
```

Use your own origin instead if you are serving the harness yourself. Chrome and
Firefox exempt `http://localhost` from mixed-content blocking on an https page;
Safari does not, so on Safari serve the harness over local http
(`python3 -m http.server`).

Running from `file://` works, but a local origin is better — browsers give
`file://` pages a null origin and some vendors reject the preflight from one.

### Settings worth knowing

- **auto-approve tool calls** — on by default. Turn it off for an
  ALLOW / ALLOW ALL / DENY gate on every write and every execution.
- **mode** — which system prompt the agent runs under (see `/mode` below).
- **max steps** — how many tool round trips one request may take.
- **auto-compact** and **compact at** — summarize the session when the last
  reply's token count crosses the threshold (120 000 by default).
- **show reasoning** — stream thinking blocks into the transcript.
- **AUTO / DAY / NIGHT** — the tube. `?theme=light` pins one for a load.

> Keys live in this browser's `localStorage`. Anything that can run script on
> this origin can read them. Use a scoped, revocable key.

---

## Slash commands

Typed into the prompt and answered by the tab itself, with no round trip to a
model — except `/init`, which hands the agent a request, and `/compact`, which
spends one completion.

| Command | What it does |
| --- | --- |
| `/help` | Lists the commands. |
| `/mode` | Shows the current mode. |
| `/mode general` | Default — builds anything static in a browser. |
| `/mode agent-builder` | Builds AI agents, blocks.ai first. |
| `/mode slides` | Builds a deck: one self-contained page, arrow keys, print-to-PDF. |
| `/mode game-dev` | Builds a game: pixi.js for 2D, three.js for 3D. |
| `/mode data-viz` | Builds charts and dashboards from a file you dropped in. |
| `/init` | Asks the agent to read the workspace and write `AGENTS.md`. |
| `/rules` | Shows which rules files are in the system prompt right now. |
| `/queue` | Shows what is waiting behind the running request; `/queue clear` drops it. |
| `/undo` | Rewinds the conversation *and* the files to before the last request. |
| `/redo` | Puts back what `/undo` rewound. |
| `/compact` | Summarizes the session into a handover note and continues from it. |
| `/clear` | Drops the conversation and transcript; keeps every file. |
| `/wipe` | Deletes the files *and* the conversation, after a confirm. |

Project rules go in `AGENTS.md` in the workspace — also read from
`.buttercup/AGENTS.md` and `CLAUDE.md` — and are re-read fresh on every request,
so an edit lands on the next turn with no reload.

---

## What's in the box

20 tools handed to the model on every turn: `read`, `list`, `glob`, `grep`,
`todo`, `export_zip`, `write`, `edit`, `delete`, `move`, `scaffold`, `run_js`,
`run_agent`, `preview`, `screenshot`, `navigate`, `http_get`, `npm_info`,
`npm_file`, `framework_docs`.

`screenshot` and `navigate` close the loop on anything visual: the model mounts a
page, photographs it, clicks and types in it, and looks again. The preview is an
opaque-origin sandbox, so neither one reaches into it — the frame photographs and
operates itself and posts the result back out (`js/capture.js`, `js/drive.js`).

Around them: a virtual filesystem in `localStorage`, a 25-deep undo stack that
snapshots conversation and files together, drag-and-drop import of files and
folders, pasted screenshots scaled for the wire, a request queue, ZIP export,
and a sandboxed preview with a hand-written ES-module linker so the agent's
imports resolve without a server.

One optional script folds the whole thing into a single file for GitHub Pages:

```
node build.mjs        # → docs/index.html + docs/.nojekyll
```

Zero dependencies, syntax-checked before it writes. A convenience, not a
requirement — the source runs as-is.

## Updates

`docs/updates/` is the news page — a plain document served alongside the harness
but not part of it, and its own source of truth. The build writes only
`docs/index.html` and `docs/.nojekyll`, so nothing there is generated, minified
or inlined; edit it in place. `docs/updates/index.html` is served at
[buttercup.sh/updates/](https://buttercup.sh/updates/). Add an article by
dropping an HTML file in beside the others and linking it from
`docs/updates/index.html`, newest first. Opening it from disk works too —
`open docs/updates/index.html`.

The repository root has an `updates` symlink pointing at `docs/updates`, so the
relative `updates/` link in the header resolves the same way when you serve the
root in development as it does on Pages. It exists for that reason only; the
build never reads it.
