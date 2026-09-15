# ButterCup Web Agent Harness

**[buttercup.sh](https://buttercup.sh)**. Em dashes welcome.

<img width="2034" height="1316" alt="preview" src="https://github.com/user-attachments/assets/25dc7e3f-f6b1-474a-9872-7e6b665d4304" />

## Why this exists

ButterCup is a coding agent built in the browser. Its small, dependency-free
codebase makes the machinery behind Claude Code, Codex, Cursor and Antigravity
easy to inspect.

The project is open source. The course, published on YouTube and
[buttercup.sh](https://buttercup.sh), explains the agent loop, its tools and how
to add the same capabilities to your own software.

A coding harness is a loop. It sends a conversation and a list of tools to a
model, runs the requested tools, then adds the results to the conversation. The
file tree, diff view, approval gate, undo stack and compaction support that loop.
ButterCup implements that machinery in static HTML, CSS and JavaScript using
classic `<script>` tags. There is no server, framework, bundler or dependency
installation.

```
git clone git@github.com:stephenlb/buttercup.sh.git && open buttercup.sh/index.html
```

Read `js/agent.js` for the loop, `js/tools.js` for the tools and `js/llm.js` for
the wire protocols.

## Open source, standalone, and quiet

The code runs from a file on your disk. The tab talks directly to the model
endpoint you select, with no backend to deploy or proxy.

With Ollama or vLLM, the harness sends no data to third parties unless you enable
a networked tool. It has no telemetry, analytics or update checks. Your keys,
conversation and files stay in this browser's `localStorage`; model requests go
only to the provider you select.

Some *tools* use the network when the agent calls them. `http_get`, `npm_info`,
`npm_file` and `compile` fetch data; `framework_docs` and `scaffold` can write
code that imports from a CDN. Each call appears by name in the transcript and
can be disabled in the TOOLS panel. To keep the session offline, untick **use
LiveCodes compiler** and disable the networked tools.

Code the agent writes runs in a `sandbox="allow-scripts"` iframe on an opaque
origin, so it cannot reach this page, this DOM, or your keys.
`allow-same-origin` is never granted.

---

## Install it as an app

[buttercup.sh](https://buttercup.sh/) is an installable PWA, so it can live on a
dock, a Start menu or a phone's home screen and open in its own window with no
browser chrome around it.

- Chrome, Edge and Brave: use the **INSTALL** link in the title bar or the
  install icon in the address bar.
- iOS and iPadOS Safari: choose Share, then *Add to Home Screen*.
- Android Chrome: open the browser menu and choose *Install app*.
- Safari on macOS: choose File, then *Add to Dock*.

`sw.js` caches the shell so the app starts without a network connection and
previously opened lessons remain available offline. The cache
accepts **same-origin GETs only** and does not cache **POSTs**. Cross-origin
requests, including model calls, WebLLM weights and npm lookups, pass through
without being cached. The cache contains the page, manifest, icons and lesson
pages you open.

The worker includes a hash of its precached files in the cache name. Each
deployment retires the old cache once, so stale JavaScript does not outlive its
build. Append `?nosw=1` to unregister the worker and use plain requests while
debugging. An installed app paired with a local model can run without a network
connection.

The PWA code lives in `manifest.webmanifest`, `sw.js` and `js/pwa.js`.
`build.mjs` draws the icons from a pixel grid with a few dozen lines of zlib and
CRC32 code. This keeps the repository text-only and the artwork in step with the
palette.

---

## Key configuration

Open `index.html`. The app starts on the **KEYS** panel and stays there until a
key validates. Pick a vendor, paste a key and press **SAVE**. ButterCup checks the
key against the vendor's model list without spending tokens. The title-bar lamp
turns from red **NOT READY** to green **READY** when the check succeeds.

| Vendor | Default model | Key | Notes |
| --- | --- | --- | --- |
| Ollama | `qwen3-coder:30b` | none | Local: `http://localhost:11434/v1` |
| vLLM | *(you type one)* | none | Local: `http://localhost:8000/v1` |
| WebLLM | `Qwen3.5-4B-q4f16_1-MLC` | none | Runs in this tab on WebGPU; tools via the text bridge |
| Anthropic | `claude-opus-5` | `sk-ant-…` | Adaptive thinking, effort control |
| OpenAI | `gpt-5.6` | `sk-…` | Chat Completions + `reasoning_effort` |
| xAI | `grok-4.1` | `xai-…` | `api.x.ai/v1` |
| Google | `gemini-3.1-pro-preview` | `AIza…` | `streamGenerateContent?alt=sse` |
| OpenRouter | `anthropic/claude-opus-4.5` | `sk-or-v1-…` | Any model the account can reach |
| FreeBuff | *(you type one)* | gateway key | Any OpenAI-compatible gateway |

The eight network vendors use three wire formats: Anthropic Messages, Google
`generateContent` and OpenAI-style `/chat/completions` (shared by six). A
**base url** field appears for chat-completions vendors, so any compatible
gateway works without a code change. WebLLM uses the OpenAI-shaped payload
inside the tab and makes no inference requests over the network.

### Running fully local

All three local providers drop the **api key** row and the `Authorization`
header entirely. The two server-backed ones need CORS permission to accept a
call from the tab:

```
OLLAMA_ORIGINS='https://buttercup.sh' ollama serve
vllm serve <model> --allowed-origins '["https://buttercup.sh"]'
```

WebLLM has no server; the model runs in the tab on WebGPU. When you select the
provider, the browser loads the inference runtime from a CDN and downloads the
model weights (a few GB) from Hugging Face into its cache. A thin bar tracks the
first download across the top of the page; later sessions work offline. Start with
`Qwen3.5-4B-q4f16_1-MLC` (~2.3 GB).

Tools use a text bridge. Their schemas go into the system prompt, and the harness
parses the model's `<tool_call>` blocks into calls. WebLLM's native `tools` path
is Hermes-only and would discard the harness's system prompt.

WebLLM needs a WebGPU browser (Chrome, Edge, Safari 26+, or Firefox with WebGPU)
and enough free memory. The engine uses an 8k-token window, sends a small core
toolset and reduces old tool results to stubs while keeping the newest ~6k
characters. Read and grep output is capped at 12k characters, with compaction
around 5k tokens. These limits target machines with 16 GB of memory.

Use your own origin instead if you are serving the harness yourself. Chrome and
Firefox exempt `http://localhost` from mixed-content blocking on an https page;
Safari does not, so on Safari serve the harness over local http
(`python3 -m http.server`).

Running from `file://` works, but browsers assign those pages a null origin.
Some vendors reject preflight requests from null origins, so a local HTTP server
is more reliable.

### Settings worth knowing

- `auto-approve tool calls` is on by default. Turn it off to review each write
  and execution with ALLOW, ALLOW ALL or DENY.
- `mode` selects the agent's system prompt (see `/mode` below). The agent can
  switch modes with `set_mode` when another mode fits the request.
- `max steps` limits tool round trips for one request.
- `auto-compact` and `compact at` summarize the session when the latest reply
  crosses the token threshold, 120,000 by default.
- `show reasoning` streams thinking blocks into the transcript.
- `use LiveCodes compiler` enables the `compile` tool. Turn it off to prevent
  third-party code from loading on this origin.
- `AUTO / DAY / NIGHT` controls the theme. `?theme=light` selects one for a
  single load.

> Keys live in this browser's `localStorage`. Anything that can run script on
> this origin can read them. Use a scoped, revocable key.

---

## Slash commands

The tab handles slash commands without calling a model. `/init` sends the agent
a request, and `/compact` uses one completion.

| Command | What it does |
| --- | --- |
| `/help` | Lists the commands. |
| `/mode` | Shows the current mode. |
| `/mode general` | Default; builds anything static in a browser. |
| `/mode agent-builder` | Builds AI agents, blocks.ai first. |
| `/mode slides` | Builds a deck: one self-contained page, arrow keys, print-to-PDF. |
| `/mode game-dev` | Builds a game: pixi.js for 2D, three.js for 3D. |
| `/mode data-viz` | Builds charts and dashboards from a file you dropped in. |
| `/init` | Asks the agent to read the workspace and write `AGENTS.md`. |
| `/rules` | Shows which rules files are in the system prompt right now. |
| `/queue` | Shows what is waiting behind the running request; `/queue clear` drops it. |
| `/livecodes` | Shows what the LiveCodes tools do; `on` / `off` switches the compiler. |
| `/undo` | Rewinds the conversation *and* the files to before the last request. |
| `/redo` | Puts back what `/undo` rewound. |
| `/compact` | Summarizes the session into a handover note and continues from it. |
| `/clear` | Drops the conversation and transcript; keeps every file. |
| `/wipe` | Deletes the files *and* the conversation, after a confirm. |
| `/workspace` | Lists the workspaces; `new`, `switch`, `rename`, `delete` manage them. |

Each workspace keeps its own files and conversation. Switch both from the picker
in the FILES panel or with `/workspace switch <name>`. Settings and API keys are
shared across workspaces, while undo history stays with the workspace where it
was recorded.

Project rules go in the workspace's `AGENTS.md`. ButterCup also reads
`.buttercup/AGENTS.md` and `CLAUDE.md`. It reloads these files for every request,
so edits apply on the next turn.

---

## What's in the box

Up to 23 tools can be handed to the model: `read`, `list`, `glob`, `grep`,
`todo`, `set_mode`, `export_zip`, `playground_url`, `write`, `edit`, `delete`,
`move`, `scaffold`, `compile`, `run_js`, `run_agent`, `preview`, `screenshot`,
`navigate`, `http_get`, `npm_info`, `npm_file`, `framework_docs`. The TOOLS
panel can withhold any of them, disabling LiveCodes removes `compile`, and
small-context WebLLM models receive only the core subset.

`set_mode` gives the model access to `/mode`. A request for an agent loop, model
tools, MCP integration or anything on blocks.ai switches general mode to
`agent-builder` before work starts. Decks, games and charts trigger their
matching modes. The harness rebuilds the system prompt on every step, so the new
mode takes effect on the next step of the same turn without losing the
conversation or workspace. The header and status bar show the active mode.

`screenshot` and `navigate` let the model inspect and operate visual work. It can
mount a page, capture it, click or type, then inspect the result. Because the
preview has an opaque origin, the parent page cannot reach into it. Scripts
inside the frame perform the capture and interactions, then post results back
(`js/capture.js`, `js/drive.js`).

Nothing here transpiles: the sandbox runs plain ES modules, so `.jsx`, `.vue`,
`.svelte`, `.scss` and `.py` are text it cannot execute. Two tools from
[LiveCodes](https://livecodes.io/) (MIT, client-side) cover that gap, and they
are gated differently because they are not the same kind of thing.

`compile` runs a headless playground and saves the generated page to the
workspace as one self-contained HTML file. `preview`, `screenshot` and `navigate`
can then handle a Svelte component like hand-written HTML. An embedded LiveCodes
preview would be cross-origin, which would prevent ButterCup from injecting its
capture and interaction scripts.

This tool fetches the SDK from a CDN and opens the playground on livecodes.io.
Because the SDK runs on the same origin as your keys, ButterCup pins both its
version and the SHA-256 hash of the published file. It fetches the SDK, verifies
the hash and imports the verified bytes. A mismatch stops execution. Turn off
**use LiveCodes compiler** to remove the tool from the model. The checksum does
not cover the playground itself; the browser isolates that cross-origin iframe
from the ButterCup page.

`playground_url` exports the project as a livecodes.io link compressed into the
URL's `#fragment`, which the browser does not send to a server. Creating the link
does not contact LiveCodes: the SDK's `getPlaygroundUrl` compresses the project
and constructs a URL, and `js/livecodes.js` imports nothing. The OPEN / COPY row
appears under the tool call instead of entering the conversation, where its tens
of thousands of characters would be resent on later turns. The model receives
only a note that the link is ready. See `js/livecodes.js`.

The surrounding UI gives each workspace a `localStorage` filesystem,
conversation and 25-entry undo stack. It also supports drag-and-drop imports,
pasted screenshots scaled for model requests, a request queue, ZIP export and a
sandboxed preview with a hand-written ES-module linker.

An optional script prepares the project for GitHub Pages:

```
node build.mjs        # writes docs/index.html + docs/lessons/ + docs/.nojekyll
                      #   + docs/manifest.webmanifest + docs/sw.js + app icons
```

The optional build has no dependencies and checks syntax before writing. The
source runs as-is.

## Lessons

`lessons/` contains the course as plain documents served alongside the harness.
The build inlines every `<script src>` in each page before writing
`docs/lessons/`, so the published lessons load no separate JavaScript files.
Both the harness and the lessons read the single source at `js/announce.js`.

Edit `lessons/`, not `docs/lessons/`; each build overwrites the generated copy.
Add a lesson by placing an HTML file beside the others and linking it from
`lessons/index.html`, newest first. You can open the sources from disk with
`open lessons/index.html`. The build inlines their existing paths.

The shared stylesheet remains a linked file. The build minifies
`lessons/lessons.css` into `docs/lessons/lessons.css`, allowing every lesson to
share one cached 58 kB file. The build copies other files in `lessons/`, such as
images, without changing them.

The build generates `docs/sitemap.xml` from links in `lessons/index.html`. To
publish a lesson, write it, add the link and push. Keep an unpublished lesson's
`<li>` inside an HTML comment. The build strips comments before collecting
links, so the lesson stays out of the sitemap until you uncomment it.
`docs/robots.txt` is hand-written and points crawlers to the sitemap.
