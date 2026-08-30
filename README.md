# ButterCup Web Agent Harness

**buttercup.sh** vintage charm, aggressively anti-dystopian.

Like Claude Code, Codex, Antigravity and Cursor, this is a code harness built
specifically for building AI agents. Unlike them, it is a terminal window that
lives in a browser tab: no backend, no build step, no install.

```
git clone … && open index.html
```

That's the whole setup. It also runs from `file://`, though a local origin is
better (`python3 -m http.server`) because the browser gives `file://` pages a
null origin and some vendors reject the CORS preflight from one.

There is one optional script — `node build.mjs` — which folds the whole harness
into a single `public/index.html` for GitHub Pages. It is a convenience, not a
requirement: the source runs as-is.

---

## Architecture

100% static HTML, CSS and JavaScript. Twelve classic `<script>` tags, no modules,
no bundler, no dependencies, nothing to compile.

| File | Lines | What it is |
| --- | --- | --- |
| `index.html` | 329 | The entire UI. Structure only — no styles, no logic. |
| `css/buttercup.css` | 2636 | Amber-phosphor CRT skin, layout, tab deck, and the seven scenes. |
| `js/vfs.js` | 147 | Virtual filesystem: path → text, persisted in `localStorage`. |
| `js/checkpoints.js` | 64 | The undo stack: conversation + workspace, frozen together. |
| `js/sandbox.js` | 243 | Sandboxed execution + a hand-written ES-module linker. |
| `js/tools.js` | 528 | The 18 tool definitions handed to the model. |
| `js/frameworks.js` | 698 | Bundled framework knowledge and code scaffolds. |
| `js/llm.js` | 490 | Six providers over three wire formats, streaming, no SDKs. |
| `js/agent.js` | 488 | The agent loop, the system prompts, rules, and compaction. |
| `js/commands.js` | 199 | Slash commands, answered in-tab without a round trip. |
| `js/scenes.js` | 23 | Rolls the die for which scene is out the window this load. |
| `js/ui.js` | 251 | Transcript rendering and the approval gate. |
| `js/zip.js` | 103 | A store-only ZIP writer, so you can export the workspace. |
| `js/main.js` | 349 | Settings, key validation, and wiring. |
| `build.mjs` | 211 | Optional: fold everything into `public/index.html`. |

The UI mechanics are CSS, not JavaScript. The right-hand panel deck is four
`input[type=radio]` elements and sibling selectors:

```css
#tab-files:checked ~ #panel-files,
#tab-tools:checked ~ #panel-tools { display: block; }
```

No `style` attribute is ever written from script. JavaScript exists for the
tool definitions, the agent loop, and the wire protocols — that's it.

### Completion backends

You paste a key; the tab talks to the vendor directly over `fetch` + SSE.
Nothing is proxied, because there is nothing to proxy through.

| Vendor | Default model | Notes |
| --- | --- | --- |
| Anthropic | `claude-opus-5` | Adaptive thinking (`{type:"adaptive", display:"summarized"}`), `output_config.effort`, server-side fallbacks, and `anthropic-dangerous-direct-browser-access`. |
| OpenAI | `gpt-5.6` | Chat Completions, `max_completion_tokens` + `reasoning_effort`. |
| xAI | `grok-4.1` | Chat Completions at `api.x.ai/v1`. |
| Google | `gemini-3-pro` | `streamGenerateContent?alt=sse`; JSON Schema is sanitized down to the keywords Gemini accepts. |
| OpenRouter | `anthropic/claude-opus-4.5` | Chat Completions at `openrouter.ai/api/v1`; any model the account can reach. |
| FreeBuff | *(you type one)* | An OpenAI-compatible gateway; edit `base url` to point at yours. |

Three wire formats cover all six: Anthropic Messages, Google `generateContent`,
and OpenAI-style `/chat/completions` — the last one shared by four vendors, which
is why the **base url** field appears whenever you pick one. Any gateway that
speaks `/chat/completions` works without a code change.

**SAVE validates the key** against the vendor's model list (`/v1/models`,
`/v1beta/models`, or OpenRouter's `/api/v1/key`) — no tokens spent. The lamp in
the title bar reads **NOT READY** in red until a vendor accepts the key, and
**READY** in green once one has. The first run validates too, so a bad key fails
in the KEYS panel instead of halfway through a turn.

Internally every turn is normalized to `{role, parts[]}` with part types
`text | thinking | tool_use | tool_result`, so switching vendors mid-session
works. Thinking blocks are only replayed to Anthropic, which is the only vendor
that accepts them back.

> **Keys live in this browser's `localStorage`.** Anything that can run script
> in this origin can read them. Use a scoped, revocable key. The harness never
> transmits a key anywhere except to the vendor you selected.

### Sandboxing

Code the agent writes runs in a `sandbox="allow-scripts"` iframe — an opaque
origin, so it cannot touch this page, this DOM, or those keys. `allow-same-origin`
is never granted.

The interesting part is imports. There is no server to serve `./tools.js`, so
the sandbox links modules itself: it walks the import graph depth-first,
rewrites relative specifiers to `blob:` URLs, and imports the entry point.
Blob URLs are origin-scoped, so they must be minted *inside* the frame — the
parent only ships a `path → source` map across `postMessage`. A shared URL cache
keeps a file imported twice as one module instance, and a stack catches circular
imports. Bare and CDN specifiers (`https://esm.sh/…`) are left alone, so real
packages load.

Consequence worth knowing: an opaque origin has no `localStorage`, so scaffolded
code degrades to in-memory storage when it runs in the preview. Export and serve
it on a real origin for the full behaviour.

---

## Slash commands

Typed into the prompt and handled by the tab itself. Free unless the table says
otherwise.

| Command | What it does |
| --- | --- |
| `/help` | Lists the commands. |
| `/queue` | Shows what is waiting behind the running request; `/queue clear` drops it. |
| `/mode` | Shows the current mode. |
| `/mode agent-builder` | Default. The system prompt that builds AI agents, blocks.ai first. |
| `/mode general` | The same tools and sandbox, pointed at anything static. |
| `/init` | Hands the agent one request: read the workspace, write `AGENTS.md`. |
| `/rules` | Shows which rules files are in the system prompt right now. |
| `/undo` | Rewinds the conversation *and* the files to before the last request. |
| `/redo` | Puts back what `/undo` rewound. |
| `/compact` | Summarizes the session into a handover note and continues from it. |
| `/clear` | Drops the conversation and the transcript; keeps every file. |
| `/wipe` | Deletes the files *and* the conversation, after a confirm. |

`/init` is the one command that does reach the model: a command may hand back a
prompt instead of an answer, and the harness runs it as if you had typed it.
`/compact` spends one completion of its own; everything else is free.

---

## The queue

Type while a request is running and it is kept rather than refused: `RUN` reads
`QUEUE`, and an `ON DECK` strip above the prompt lists what is waiting. Each
line runs in order as the one ahead of it finishes, one at a time — the agent has a
single conversation, so there is never a second turn in flight.

```
ON DECK 2   1. now write the tests           ×
            2. /compact                      ×      CLEAR
```

`↑` and `↓` walk back out of the prompt: first up the strip, newest line first,
then on into requests already sent. Whatever the cursor lands on is in the box
and editable, `›` marks it on the strip, and the head reads `HELD` — nothing
starts while the cursor is out, though a request already in flight finishes.
`ENTER` sends: a line off the strip goes back to its own place in the order
rather than to the end, and sending it empty is what drops it. Edits survive
walking past them, so `↑ ↑ ↓` leaves a fix in place. Inside a multi-line draft
the arrows are still cursor keys — recall only starts from the top or bottom
edge, and the draft comes back when the cursor does. `CLEAR`, `×` and `STOP`
all end the hold.

`×` drops one line, `CLEAR` and `/queue clear` drop all of them, and `STOP`
drops the queue along with the request it interrupts. Slash commands queue like
anything else, so `/compact` behind a build runs once the build is done —
except `/help` and `/queue`, which only read state and answer immediately. If a
queued request cannot start at all (no key, a key the vendor rejects) the rest
of the queue is dropped rather than failing the same way one line at a time.

---

## Project rules — `AGENTS.md`

Write `AGENTS.md` in the workspace and every turn from then on carries it,
appended to the mode's system prompt under a heading that tells the model it is
instruction rather than reference — where it disagrees with the built-in prompt,
the file wins. `.buttercup/AGENTS.md` and `CLAUDE.md` are read too, in that
order, so a repo you paste in with rules already in it just works.

The file is read fresh on every request. Edit it and the next turn has it: no
reload, no `/clear`, no session reset. `/rules` prints what is currently loaded
and how many bytes of every request it is costing; anything past 20 000
characters is truncated in the prompt (with a note saying so) rather than
silently eating the context window.

`/init` asks the agent to write it: read the workspace first, then record what a
fresh session needs on its first turn and cannot get from a filename — how to
run and verify the thing, where the seams are, the conventions this code already
follows. If `AGENTS.md` exists it is improved in place, never blanked.

---

## Undo — `/undo` and `/redo`

Every request checkpoints the harness first, and a checkpoint is both halves of
the state at once: the conversation as the model sees it *and* every workspace
file. `/undo` restores both. Rewinding one without the other would leave the
model remembering edits that are no longer on disk — which is the failure this
exists to prevent, not a detail of the implementation.

```
/undo     → context 4 message(s) (−6) · workspace 7 file(s) (−2)
```

So it puts deleted files back, reverts overwritten ones, and drops the turn that
did it. `/clear` and `/wipe` checkpoint too, which makes both of them
recoverable — the confirm dialog on `/wipe` says so.

The transcript is deliberately not rewound. It is scrollback: a terminal keeps
the record of what happened, and what happened includes the part you undid.

Twenty-five checkpoints deep, and **in memory only**. A workspace snapshot per
turn would evict the workspace itself from a 5 MB `localStorage` quota, so the
stack lasts as long as the page does. A reload keeps your files and your
context; it drops the ability to step back through them.

---

## Compaction — `/compact`

A long session eventually will not fit in the model's window. When the last
request's token count crosses **compact at** (120 000 by default), the harness
spends one completion with no tools attached: the model writes a handover note
to itself — goal, what is done file by file, what was actually verified, what was
decided and ruled out, the exact next step — and that note becomes the entire
conversation. A request already in flight is carried across verbatim, because
paraphrasing what you just asked for is the one thing a summary must not do.

The workspace is never touched, which is what makes this safe: the files are the
real state, and the note says so. `/undo` restores the full pre-compaction
context if the summary lost something you needed.

`ctx ~91300/120000` in the status bar is the estimate this runs on — the last
reply's own token count, since a browser tab cannot tokenize and every vendor
counts differently. It turns amber at 80% of the threshold. Turn
**auto-compact** off and `/compact` still works by hand.

---

## The 18 tools

Handed to the model verbatim on every turn. Each is a plain function in
`js/tools.js`. Tools marked ● need approval unless auto-approve is on.

**Workspace (read)** — `read`, `list`, `glob`, `grep`, `todo`, `export_zip`

**Workspace (write)** — ● `write`, ● `edit`, ● `delete`, ● `move`, ● `scaffold`

**Execution** — ● `run_js` (evaluate a snippet, with top-level `await`),
● `run_agent` (run a workspace module and report what it returned or threw),
● `preview` (mount a workspace HTML file in the preview frame)

**Network** — `http_get` (with an explicit explanation when CORS blocks it),
`npm_info` (the npm registry), `npm_file` (a package's actual files via jsDelivr)

**Knowledge** — `framework_docs`

That last group is the point of the harness. The system prompt forbids writing
code against a package's API from memory: confirm it with `npm_info`, read the
`.d.ts` with `npm_file`, then `run_js` a dynamic import to see the real export
names. The harness holds itself to the same rule — see below.

---

## Supported AI agent frameworks

`framework_docs` ships bundled notes and a working scaffold for each.

### Blocks.AI / Blocks Network — the default target

npm `@blocks-network/sdk`, CLI `@blocks-network/cli`.

Verified against the published package rather than assumed, and the finding
matters: **Blocks Network splits across two runtimes.**

- The **agent** is a Node process. `blocks run` reads an `agent-card.json`
  (`identity.agentName` must match `^[a-zA-Z0-9_]+$`) and calls your handler,
  `(task, ctx) => Promise<{artifacts}>`, with `BLOCKS_API_KEY` in the
  environment. This half cannot run in a browser tab.
- The **consumer client** is browser-safe. `TaskClient` + `textPart`/`filePart`
  import cleanly from `https://esm.sh/@blocks-network/sdk`, send a message to a
  deployed agent, stream progress, and download artifacts.

So the harness authors and exports the Node agent, and builds a browser page
that talks to it. The scaffold reflects that: `agent-card.json`, `handler.js`,
`.env.example`, and a `web/` consumer page. The consumer never embeds an API
key — it uses `tokenEndpoint` or `tokenProvider`, because `apiKey` auth is
server-side only.

### vanilla

Zero dependencies. An agent loop, a provider adapter, a tool registry and a
page, all hand-rolled and fully browser-native. Nothing to install, nothing to
deploy.

### esm-sdk

Same shape, but importing a real SDK straight from a CDN — for when you want a
vendor's client library without a package manager.

Each scaffold is a real, runnable multi-file agent: `agent.js` (the loop),
`provider.js`, `tools.js` (with `remember`/`recall`/`http_get`), `index.html`,
`README.md`.

---

## Using it

1. Open `index.html`. It starts on the **KEYS** panel until a key validates.
2. **KEYS** → pick a vendor, paste a key, **SAVE**. Wait for the green **READY**.
3. Ask for what you want: *"scaffold a blocks.ai research agent, then run it"*.
4. Watch **FILES** fill up, **PREVIEW** mount, and the transcript stream.
5. **EXPORT .ZIP** when you want it on disk.

Settings that matter: **auto-approve tool calls** (on by default; turn it off to
get an ALLOW / ALLOW ALL / DENY gate on every write and every execution),
**show reasoning**, **mode**, **max steps**, and **auto-compact** with its
**compact at** threshold. The workspace and the
conversation both survive a reload; **NEW SESSION** (`/clear`) clears the model's
memory and keeps the files, **WIPE** (`/wipe`) does the opposite.

The prompt bar sits directly under the last line of the transcript and only parks
at the bottom edge once the transcript has grown that far — flexbox, no JS. While
it is still high up, the room below it shows a low-resolution monochrome scene —
a **beach**, a **city** at night, snow in the **woods**, a ringed planet in
**orbit**, a **reef** with a fish crossing it, a night train on the **rails**, or
an erupting **volcano** — one of the seven at random on every load (`?scene=city`
pins one).

All seven are true pixel art, which means every edge is horizontal or vertical (no
diagonals, no circles, nothing the browser can anti-alias into a soft fringe), no
grid is drawn over the top, and shape comes from which pixels are lit rather than
from a gradient ramp. The sea is stippled crests and the sun a nine-pixel disc
built one solid row at a time; the skyline, both treelines, the coral, the prairie
hills and the volcanic ridges are cut from `repeating-linear-gradient` bands, so
they tile across a box of any width; the palm, the fir, the cabin, the blimp, the
station, the fish, the train and the cone are sprites drawn from ASCII maps kept
in the stylesheet beside them. Snow, bubbles and ashfall are `repeat-y` columns
travelling exactly one tile, so the loop is seamless. Every offset is a multiple
of one CSS pixel variable, so browser zoom scales the scene instead of resampling
it, and every animation is timed in `steps()` so nothing ever renders a half-lit
pixel.

---

## Building for GitHub Pages

```
node build.mjs        # → public/index.html + public/.nojekyll
```

Zero dependencies. It reads `index.html`, follows that file's own
`<link>`/`<script src>` order, strips comments and indentation (never renames
anything, so a stack trace still means something), inlines the result, and
syntax-checks every minified script with `node:vm` before writing — a corrupted
bundle fails the build instead of shipping. One file, ~208 kB, ~50 kB gzipped.
Point Pages at `public/` and that's the deploy.

---

## Verified

Not "should work" — run and checked in a real browser over CDP:

- module linking, including shared instances, circular-import detection,
  missing imports, thrown errors, timeouts, and a live `esm.sh` import of
  `@blocks-network/sdk`
- all three provider adapters against synthetic SSE: streamed text, thinking
  deltas, incrementally assembled tool-call JSON, usage accounting, refusal
  handling, and 401 messaging
- the full agent loop with a stubbed provider: the approval gate, parallel tool
  results arriving in one turn, error flagging, thinking replayed only to
  Anthropic, and session persistence
- ZIP output, npm registry and jsDelivr tools, preview mounting, transcript
  rendering
- rules, undo and compaction against a stubbed provider: `AGENTS.md` reaching
  the system prompt and picking up an edit on the next turn with no reset;
  `/undo` restoring deleted files, reverted contents and the dropped turns
  together, `/redo` replaying them, and both refusing past the ends of the
  stack; compaction leaving one message, attaching no tools, surviving a tool
  round trip in the tail, reporting its own before/after, and firing by itself
  when the context estimate crosses the threshold with the in-flight request
  carried across intact
