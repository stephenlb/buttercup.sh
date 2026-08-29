# ButterCup — Design System

**buttercup.sh** — pure vintage charm; aggressively anti-dystopian.

The product is a terminal for building AI agents. The costume is a peanut butter
cup: dark chocolate shell, warm peanut-butter filling, a fluted paper wrapper,
and a face that is genuinely pleased to see you. Every decision below serves one
sentence:

> **Serious tool. Sweet wrapper.**

Nothing here requires a build step. Every token is a CSS custom property in
`css/buttercup.css`; every shape is a border, a gradient, or a `clip-path`.

---

## 1. Brand

### Name and mark

| Layer | Rule |
| --- | --- |
| Wordmark | `ButterCup` — one word, two capitals. Rounded, warm, slightly retro (Baloo 2 / Quicksand / system rounded fallback). |
| Domain lockup | `buttercup.sh` — always monospace, always lowercase. This is the *tool* voice. |
| Symbol | A fluted peanut butter cup, viewed head-on, with a peanut-butter face: two dot eyes, one closed-curve smile, optional blush. |
| Tagline | `pure vintage charm · aggressively anti-dystopian` — em-middot separated, letterspaced small caps. |
| Never | Do not stretch the cup, do not add a bite mark to the primary mark, do not put the face on the chocolate (it lives on the filling), do not render the wordmark in monospace. |

### The cup, in CSS

The mark is buildable without an asset. It is the canonical decorative motif —
avatars, favicons, bullets, the boot glyph, loading indicator.

```
      ╭───────────────╮        chocolate rim: repeating-conic-gradient flutes
     ╭│  ●        ●   │╮       filling: radial-gradient(--pb-light → --pb)
     ││       ‿       ││       shell:   linear-gradient(--cocoa-2 → --cocoa-3)
     ╰│               │╯       shadow:  0 2px 0 var(--cocoa-4)
      ╰───────────────╯
```

Flute the rim with `repeating-conic-gradient(from 0deg, var(--cocoa-3) 0 6deg,
var(--cocoa-2) 6deg 12deg)` and mask the center. Twenty-four flutes reads best
at 32px and above; below that, drop to a plain ring.

### Voice

Terse, mechanical, kind. The UI shouts short words in small caps — `RUN`,
`STOP`, `EXPORT .ZIP`, `WIPE` — while prose in panels stays lowercase and
explanatory. Errors state the fact and the fix; they never scold and never
apologize twice. No dark patterns, no urgency, no confetti.

---

## 2. Color

Two ramps and one accent set. Chocolate is structure, peanut butter is
attention, cream is text. That is the entire system.

### 2.1 Chocolate — surfaces and chrome

| Token | Hex | Use |
| --- | --- | --- |
| `--cocoa-5` | `#160E09` | Page void, behind everything. |
| `--cocoa-4` | `#20140D` | App background, sunken wells, inset shadows. |
| `--cocoa-3` | `#2E1D12` | Panel body — the default surface. |
| `--cocoa-2` | `#3E2718` | Raised surface: title bar, tab bar, buttons at rest. |
| `--cocoa-1` | `#54341F` | Hover surface, active tab, code block ground. |
| `--rim` | `#6B4326` | Borders, rules, the fluted edge. |
| `--rim-hi` | `#8A5A33` | Focus ring outer, top bevel highlight. |

### 2.2 Peanut butter — ink and emphasis

| Token | Hex | Use |
| --- | --- | --- |
| `--pb-hot` | `#FFE7B4` | Cursor, focused label, the single brightest thing on screen. |
| `--pb-light` | `#F5CE84` | Headings, agent text, primary ink. |
| `--pb` | `#E5A93F` | Brand fill, active states, links, the cup filling. |
| `--pb-mid` | `#C08636` | Secondary labels, panel chrome, icon strokes. |
| `--pb-dim` | `#8A6128` | Disabled text, hairlines, watermarks. |

### 2.3 Cream — paper and light mode

| Token | Hex | Use |
| --- | --- | --- |
| `--cream` | `#FBF3E2` | Light-mode text, on-chocolate labels in badges. |
| `--kraft` | `#E4CBA4` | Light-mode page — the wrapper card stock. |
| `--kraft-2` | `#D6B98D` | Light-mode panels. |
| `--kraft-3` | `#C4A377` | Light-mode raised surfaces and rules. |

### 2.4 Accents — meaning only, never decoration

| Token | Hex | Meaning |
| --- | --- | --- |
| `--pistachio` | `#93C97A` | Success, tool result OK, connected. |
| `--caramel` | `#F0A24A` | Warning, awaiting approval, streaming. |
| `--jam` | `#E4705C` | Error, denied, destructive (`WIPE`). |
| `--blueberry` | `#9BCFE8` | The human. User turns, user avatar, prompt sigil. |
| `--mallow` | `#C9A8E0` | Thinking / reasoning blocks. Reserved; nothing else. |

Rules:

1. **One accent per element.** A row is either warning or error, never striped.
2. **Never color-only.** Every accent pairs with a glyph or a word — `● OK`,
   `▲ APPROVE`, `✕ DENIED`. Status must survive grayscale and every common form
   of color blindness.
3. **`--mallow` is a promise.** Purple means "the model is thinking." Using it
   anywhere else breaks the only piece of visual vocabulary the user has to
   learn.

### 2.5 Contrast floor

All body text ≥ 7:1 against its surface (AAA). Chrome, hairlines, and disabled
text ≥ 3:1. Verified pairs:

| Foreground | Background | Ratio |
| --- | --- | --- |
| `--pb-light` on `--cocoa-3` | `#F5CE84` / `#2E1D12` | 9.8:1 |
| `--pb` on `--cocoa-3` | `#E5A93F` / `#2E1D12` | 7.6:1 |
| `--pb-mid` on `--cocoa-3` | `#C08636` / `#2E1D12` | 4.9:1 — labels only, ≥ 12px bold |
| `--cocoa-4` on `--kraft` | light mode body | 12.4:1 |

Never place `--pb-dim` on `--cocoa-1` or lighter; it is a `--cocoa-4`-and-below
token.

### 2.6 Light mode

`prefers-color-scheme: light` flips to kraft paper: `--kraft` page, `--cocoa-4`
ink, `--cocoa-2` headings, `--pb` reserved for fills and brand only (amber text
on cream fails contrast — it becomes `#7A4A12` instead). Scanlines drop to 20%
opacity. The mark is unchanged: chocolate on kraft is the wrapper as it really
looks.

### 2.7 Gradients

Three, all subtle, all optional:

```css
--grad-page:   radial-gradient(120% 90% at 50% 0%, #33210F 0%, var(--cocoa-4) 55%, var(--cocoa-5) 100%);
--grad-raised: linear-gradient(var(--cocoa-2), var(--cocoa-3));
--grad-filling:radial-gradient(circle at 38% 32%, var(--pb-hot) 0%, var(--pb) 55%, #B4791F 100%);
```

`--grad-filling` is the only glossy thing in the product, and it appears only on
the cup. Gloss is the logo's job, not the interface's.

---

## 3. Typography

| Role | Stack | Treatment |
| --- | --- | --- |
| Interface + transcript | `"Berkeley Mono", "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace` | 14px / 1.5. The tool is a terminal; monospace is not a style choice, it is the medium. |
| Wordmark + panel headings | `"Baloo 2", "Quicksand", ui-rounded, "Segoe UI", system-ui, sans-serif` | Rounded, 600 weight. Used sparingly — brand and `<h2>` only. |
| Micro-labels | monospace | 11px, `letter-spacing: .12em`, uppercase, `--pb-mid`. |

Scale (only these six):

```
11px  micro-label / status lamp
14px  body, transcript, code          ← default
16px  panel heading
20px  section title
28px  wordmark in the title bar
44px  wordmark on the splash / boot screen
```

Line length in the transcript caps at `72ch`. Code blocks do not wrap; they
scroll horizontally with a visible, styled scrollbar.

---

## 4. Form language

| Property | Value | Why |
| --- | --- | --- |
| Radius | `--r-sm: 3px`, `--r-md: 6px`, `--r-lg: 12px`, `--r-cup: 999px` | Softened, not pill-shaped. Terminals have corners. |
| Border | `1px solid var(--rim)`; `2px` on the machine shell and the title bar | Heavier outer chrome reads as a physical case. |
| Bevel | `inset 0 1px 0 rgb(255 231 180 / .07)` on raised surfaces | One-pixel top highlight. That is the whole skeuomorphism budget. |
| Shadow | `--sh-1: 0 1px 0 var(--cocoa-5)`, `--sh-2: 0 6px 18px -8px #000` | Chocolate casts hard, short shadows. No soft blooms. |
| Spacing | 4px base: `4 8 12 16 24 32 48` | `--pad: 12px` is the panel gutter. |
| Flute | `repeating-conic-gradient` at 12deg intervals | The signature texture. Rim of the cup; nothing else. |
| Scanlines | `repeating-linear-gradient(rgb(0 0 0/.22) 0 1px, transparent 1px 3px)` | Fixed overlay, `mix-blend-mode: multiply`, 55% dark / 20% light. |

---

## 5. Layout

```
┌────────────────────────────────────────────────────────────────────┐
│ ●●●  🥜 ButterCup  buttercup.sh rev.2        pure vintage charm ·  │  titlebar
│                                                    READY ●         │  (auto)
├──────────────────────────────────────┬─────────────────────────────┤
│                                      │ FILES TOOLS PREVIEW KEYS    │  tabbar
│  transcript                          ├─────────────────────────────┤
│  ┌ you ─────────────────────────┐    │                             │
│  │ scaffold a blocks.ai agent   │    │  panel                      │
│  └──────────────────────────────┘    │  (deck: 4 radios,           │
│  ┌ 🥜 buttercup ────────────────┐    │   :checked ~ sibling)       │
│  │ …streaming…                  │    │                             │
│  │ ▸ write  handler.js     ● OK │    │                             │
│  └──────────────────────────────┘    │                             │
│                                      │                             │
│ >  ask for what you want…   RUN STOP │                             │  prompt
│ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~  │                             │  scene
├──────────────────────────────────────┼─────────────────────────────┤
│                                      │ (\_/)  warm and idle        │  mascot
└──────────────────────────────────────┴─────────────────────────────┘  (auto)
   minmax(0,1fr)                          clamp(300px, 32%, 460px)
```

- Outer `.machine`: `max-width: 1500px`, centered, `grid-template-rows: auto minmax(0,1fr) auto`.
- Deck: `grid-template-columns: minmax(0,1fr) clamp(300px, 32%, 460px)`.
- Rack: `grid-template-rows: auto minmax(0,1fr) auto` — tab bar, active panel,
  mascot shelf. The shelf is the visual foot of the right column, matching the
  prompt bar's foot on the left.
- Console column: a flex column, not a grid. The scroller is `flex: 0 1 auto`
  (may shrink, never grows past its content) so the prompt bar sits directly
  under the last line of the transcript and only parks at the bottom edge once
  the transcript has grown that far. The scene below it is `flex: 1 1 0`: it
  takes the leftover room and collapses to nothing when there is none.
- Below `960px` the deck stacks; the rack collapses to a `<details>` drawer that
  overlays the transcript. The prompt bar stays pinned.
- Only the transcript scroll region and each panel body scroll. `body` never does.
- The panel deck is four `input[type=radio]` + sibling selectors — no JS, per
  the architecture contract. `style` attributes are never written from script.

---

## 6. Components

### Title bar

Three lamps (`--jam`, `--caramel`, `--pistachio`) as 8px discs with a 1px
`--cocoa-5` ring — decorative, `aria-hidden`. Wordmark in rounded 28px, `rev.2`
in 11px `--pb-dim`. Status lamp right-aligned: `<output aria-live="polite">`,
11px letterspaced, dot + word, colored by state. The lamp reports one thing
only — whether this tab can actually reach a model:

| State | Reads | Colour | When |
| --- | --- | --- | --- |
| `notready` | `NOT READY` | jam, filled | No key, or a key the vendor rejected. The default at boot. |
| `check` | `CHECKING KEY` | caramel outline | A validation request is in flight. |
| `ready` | `READY` | pistachio, filled | The vendor accepted the key against its model list. |
| `busy` | `WORKING · STEP n` | caramel, filled | A turn is running. |
| `error` | `ERROR` | jam, filled | The last turn failed. |

`READY` is never optimistic: it is set from a real response, not from the
presence of a string in the key field.

### Transcript entries

| Turn | Left border | Ink | Label |
| --- | --- | --- | --- |
| user | 3px `--blueberry` | `--pb-light` | `you` |
| agent | 3px `--pb` | `--pb-light` | 🥜 `buttercup` |
| thinking | 3px dashed `--mallow` | `--pb-mid`, italic | `thinking` — inside `<details>`, closed by default |
| tool call | 3px `--caramel` | mono | `▸ tool_name` + argument summary, one line, `<details>` for the full payload |
| tool result | 3px `--pistachio` / `--jam` | `--pb-mid` | `● OK` / `✕ ERROR` + duration |
| boot | 3px `--rim` | `--pb-mid` | no label |

Entries never nest more than one `<details>` deep. Streaming text gets a 1ch
block cursor in `--pb-hot` that blinks at 1.1s — removed under
`prefers-reduced-motion`.

### Prompt bar

`--grad-raised`, 2px `--rim` top border, `>` sigil in `--blueberry`.
`RUN` is the only filled button in the product: `--pb` background, `--cocoa-4`
text, 600 weight. `STOP` is ghost with a `--jam` border, disabled until a run
starts.

### Buttons

| Variant | Rest | Hover | Active | Disabled |
| --- | --- | --- | --- | --- |
| primary (`RUN`) | `--pb` on `--cocoa-4` | `--pb-light` | translate 1px down, `--sh-1` removed | `--pb-dim` on `--cocoa-2` |
| mini | `--cocoa-2`, `--pb-mid` text, 1px `--rim` | `--cocoa-1`, `--pb-light` | as above | 45% opacity |
| danger (`WIPE`) | `--cocoa-2`, `--jam` text + border | `--jam` bg, `--cocoa-5` text | as above | — |

Focus, universally: `outline: 2px solid var(--pb-hot); outline-offset: 2px`.
Never removed, never replaced with a shadow.

### Approval gate

The one place the UI raises its voice. Full-width card in the transcript,
`--caramel` 2px border, `--cocoa-2` fill, wrapper-flute strip along the top
edge. Shows tool name, the exact arguments in a `<pre>`, and three buttons:
`ALLOW` (primary), `ALLOW ALL` (mini), `DENY` (danger). Focus moves to `ALLOW`
on mount; `Esc` denies. Never auto-dismisses.

### File tree

Monospace rows, 22px tall. Directory rows use `▾`/`▸`; file rows use a 10px cup
glyph in `--pb-mid`. Selected row: `--cocoa-1` fill, 2px `--pb` left border.
Modified-this-turn rows briefly flash `--pb` at 12% opacity, 600ms, once.

### Tool cards

Each of the 18 tools is a `<li>`: name in `--pb-light` mono, one-line
description in `--pb-mid`, and a `●` in `--caramel` when the tool requires
approval. Arguments in a closed `<details>`.

### Preview frame

The sandboxed iframe sits in a "wrapper": 12px `--cocoa-2` padding with a
fluted inner edge, so agent output is visibly *inside* something and visibly not
part of the chrome. Empty state is a centered cup mark at 20% opacity with one
line of monospace explanation.

### The scenes

The empty room under a short transcript is a view out the window, not padding:
a low-resolution monochrome scene, 100% CSS, `aria-hidden`. There are seven of
them — `beach`, `city`, `woods`, `orbit`, `reef`, `rails`, `volcano` — and which
one you get is a coin toss per load. `js/scenes.js` writes the name to
`data-scene` on the container and stops there;
`.scenes[data-scene="city"] .city { display: block }` does the rest, which also
parks the other six scenes' animations. `?scene=woods` pins one for a screenshot.
Adding an eighth is a `<div class="scene …">`, a block of CSS, and a string in
the array — nothing else knows the list exists.

True pixel art sets two rules. **Every edge is horizontal or vertical** — no
diagonals, no circles, nothing the browser can anti-alias into a soft fringe —
and **no grid is drawn over the top**, so pixels sit flush against their
neighbours the way they do on a real low-res display and solid areas read as
solid. Shape comes from which pixels are lit, never from a gradient ramp.

| Scene | What is out the window |
| --- | --- |
| `beach` | Stippled sea, breaking surf, a nine-pixel sun, a palm, two gulls. |
| `city` | A two-rank skyline at night, lit windows, a beacon, a blimp crossing. |
| `woods` | Two treelines, a cabin with smoke, snow falling in six columns. |
| `orbit` | A ringed planet over banded mesas, a moonlet, a station passing. |
| `reef` | Coral in two ranks, kelp swaying, a fish crossing, bubbles rising through light shafts. |
| `rails` | Prairie hills, a telegraph line, a signal lamp, a train running the length of the box. |
| `volcano` | A cone with a lit crater and a lava runnel, banded ridges, ashfall, embers, glowing crust. |

The beach is the reference implementation — the one to read first:

| Element | Technique |
| --- | --- |
| sand | a flat band, then six one-pixel stipple rows, no two on the same rhythm |
| sea | a flat band, then eight ranks of dash "crests" thinning towards the horizon |
| surf | one rank of wider dashes on the shoreline row |
| horizon | a single darker pixel row where the sea meets the sky |
| sun | a nine-pixel disc, one solid bar per row, plus three pixels of glint on the water below it |
| clouds | two pixel rows each, offset |
| palm, gulls | `box-shadow` sprites; the palm is drawn from an ASCII map kept in the comment above it |

The other six lean on three more techniques, all of which fall out of the rules
above rather than around them:

| Technique | Where | How |
| --- | --- | --- |
| bands | city skyline, both treelines, the mesas in orbit, the coral, the prairie hills, the volcanic ridges | Each horizontal band of a silhouette is one `repeating-linear-gradient` whose bars are the shapes tall enough to reach it. Stack the bands and the towers (or firs, or mesas) appear, cut from a pattern that tiles across a box of any width. Two ranks run on coprime periods — 24 and 31 in the city, 9 and 13 in the woods, 19 and 29 on the volcano — so the joins never line up into wallpaper. A rank needs **four** bands to read as a hill or a peak: with three the taper is coarse enough that each shape reads as a plateau. |
| bars, not shadows | fir, cabin, blimp, station, planet, fish, train, cone | A sprite whose every row is a single run of pixels is cheaper and more legible as one solid `background` bar per row than as N `box-shadow` pixels. Scattered pixels — lit windows, stars, gulls, embers — stay `box-shadow`. |
| tiled columns | snow in the woods, bubbles in the reef, ashfall on the volcano | A `repeat-y` column whose tile holds one or two flecks, animated down (or up) by exactly its own period, so the loop is seamless. Six columns on coprime periods read as weather; a shallow period with two flecks reads as a dotted line, so short tiles carry one. |

One consequence worth writing down: the tones in the band scenes are **opaque**
mixes against `--paper`, not mixes with `transparent`. Bands of one rank overlap
each other by design, and a see-through ink stacks into a brightness ramp up the
towers — which is exactly the gradient ramp the rules forbid.

One ink, one pixel. `--px` is the size of a single pixel of the art and *every*
offset is `calc(var(--px) * n)` — including the palm, which draws at
`--pp: calc(var(--px) * 2)` for a chunkier read. Browser zoom scales the CSS
pixel, so the whole scene scales with it and stays on its own grid instead of
resampling. The art is bottom-anchored: a short box crops the sky rather than
squashing the water.

### Slash commands

Commands are typed into the same prompt as everything else and answered by the
tab — no model call, no tokens, no round trip. They echo as a `system` entry, in
`--pb-mid` at 82%, so a command is visibly not a turn. `/help` prints the table,
`/mode` switches the system prompt (and the `mode` select mirrors it, both
directions), `/clear` empties the conversation and the transcript, `/wipe` takes
the files too and asks first.

### Mascot shelf

The rack ends in a shelf: a dashed top rule, `--cocoa-2` ground, and the cup
mascot bottom-aligned at the left with one line of letterspaced caption beside
it. It is the third grid row of `.rack`
(`grid-template-rows: auto minmax(0,1fr) auto`), so it survives every tab and
never scrolls away with the panel.

Rules for the mascot:

| Layer | Rule |
| --- | --- |
| Drawing | Inline SVG, one 30×28 viewBox read as a **30×28 pixel grid**: dome head over a fluted wrapper, four ridges, two arm poses with 2×2 hands, seven sparkles. No asset, no image request. |
| Pixels | Every coordinate is a whole cell and every shape is a **fill** — a stroke would sit half in, half out of a cell. Outlines are an ink silhouette with a one-cell-inset `--paper` interior over it, and `shape-rendering: crispEdges` kills the smoothing. Same grid discipline as the pixel beach. |
| Sparkles | A 3×3 plus in `<defs>`, placed seven times with `<use>` on integer offsets around the head, each paired with a 1×1 dot. The twinkle cuts dot → plus → dot; nothing scales, because a fractional scale is a fractional pixel. |
| Ink | **Monochrome.** Every fill is `currentColor`; ridges and blush drop to 55% opacity; interiors are `--paper` (knockout) only — never a second hue. |
| Mood | The colour and face come from `body[data-agent]`: idle → `--ink-dim` + grin, sparkles dark; busy → `--warn` + open mouth + sparkles lit and twinkling; error → `--bad` + flat mouth, sparkles dark. |
| Twinkle | The sparkles are the *working* signal, so both the opacity and the twinkle animation live under `body[data-agent="busy"]`. At rest they are `opacity: 0` with no animation attached — nothing twinkles over an idle machine, and nothing keeps a compositor layer alive for it either. |
| Caption | Generated by CSS `content` per state — *warm and idle* / *on it — whisking* / *that went sideways*. Lowercase small caps, `--ink-faint`. |
| Wiring | JS sets exactly one word: `document.body.dataset.agent`. Every visual consequence is a stylesheet rule, matching the harness rule that JS never sets style. |
| Never | Do not tint it a second colour, do not give it a drop shadow, do not let it block or overlay content, do not animate it as a progress indicator — it reflects state, it does not report it. |

The shelf is decorative: the whole `<figure>` is `aria-hidden="true"`, because
`#status` already announces the same state to assistive tech.

### Keys panel

The security note renders as a `--caramel`-bordered aside with a `⚠` glyph:
*keys live in this browser's localStorage.* The key input is `type="password"`
with a `SHOW` mini-button. Vendor select, model combobox, and effort select are
plain rows: label in 11px letterspaced `--pb-mid` on the left, control right.

---

## 7. Motion

Budget: four interface animations, all under 200ms except the two ambient ones,
plus the mascot's idle loop.

| Thing | Duration | Curve |
| --- | --- | --- |
| Hover / focus / tab change | 120ms | `cubic-bezier(.2,.7,.3,1)` |
| Entry appears | 160ms fade + 4px rise | same |
| Cursor blink | 1.1s step | `steps(2, jump-none)` |
| CRT sweep | 9s linear loop, 5% opacity | linear |
| Mascot breath † | 3.6s loop, two frames, one cell of rise | `steps(1, end)` |
| Mascot blink † | 5.4s loop, open-eye frame swapped for a shut-eye frame for 4% of the cycle | `steps(1, end)` |
| Mascot wave † | 2.8s loop, two arm poses trading places | `steps(1, end)` |
| Mascot sparkles † | 1.3s loop, dot → plus → dot frame cuts, **busy only** | `steps(1, end)` |

† Exempt from `prefers-reduced-motion` — see below.

Every mascot loop is `steps(1, end)`: each keyframe holds its value until the
next one, so the sprite advances frame to frame and never tweens through a
half-lit pixel. Sub-cell motion and rotation are out of bounds for the same
reason — the wave is two drawn poses, not a rotate.

Sparkle delays are **negative** (−0.18s … −1.05s), so every star is already
mid-cycle on the first frame of a task: the twinkle looks underway the instant
work starts, and the group is never in phase — a synchronized pulse would read
as a spinner.

While `body[data-agent="busy"]`, the breath drops to 1.1s and the wave to 0.7s —
same keyframes, faster clock. The sparkle twinkle is the one animation the
mascot *gains* when working; the breath, blink, and wave only speed up.

Under `prefers-reduced-motion: reduce`: the CRT sweep and the cursor blink stop,
transitions drop to 0ms, the cursor becomes a static block.

**The mascot is the documented exception.** Its four loops sit outside the
`no-preference` guard and always run. The reasoning: it is a 6rem sprite that
hops one cell in place — no travel, no parallax, no scroll coupling, nothing
under it to obscure — and it is the one element whose entire purpose is
liveliness. Gated, it rendered as a still cup with seven stars parked at full
opacity, which read as a broken graphic rather than a calm one.

Two rules keep that exemption honest:

- Any animated mascot part gets a **resting pose equal to keyframe 0%**, so if
  the animation is ever suppressed — by the guard, a stalled compositor, an
  extension — the still frame is a deliberate one.
- The mascot is never the only channel for anything. State is carried by colour,
  face, and caption, all static properties, plus `#status` for assistive tech.

Nothing in the product depends on motion to convey state.

The cup may nod — a one-cell dip and back, two frames, once — when a run
completes successfully. Not a rotate: the grid does not do degrees.
That is the entire celebration.

---

## 8. Accessibility

- Semantic HTML first: `<main>`, `<header>`, `<section aria-label>`, `<nav>`,
  `<output>`, `<details>`. The tab deck uses real radios, so it is keyboard
  navigable with arrow keys for free.
- Transcript is `role="log" aria-live="polite"`; the status lamp is a separate
  `<output aria-live="polite">`. Streaming deltas are not announced per token —
  only completed blocks are.
- Every icon-only control has a `aria-label`. Every emoji is `aria-hidden` with
  a text sibling.
- Target size ≥ 24×24px; the prompt bar's buttons are 32px tall.
- Full keyboard path: `Tab` through chrome, `⌘/Ctrl+Enter` submits, `Esc` closes
  the viewer or denies an approval, `⌘/Ctrl+K` focuses the prompt.
- Text scales to 200% without clipping; the deck stacks rather than shrinking.

---

## 9. Token reference

Paste-ready, dark mode:

```css
:root {
  /* chocolate */
  --cocoa-5:#160E09; --cocoa-4:#20140D; --cocoa-3:#2E1D12;
  --cocoa-2:#3E2718; --cocoa-1:#54341F; --rim:#6B4326; --rim-hi:#8A5A33;
  /* peanut butter */
  --pb-hot:#FFE7B4; --pb-light:#F5CE84; --pb:#E5A93F;
  --pb-mid:#C08636; --pb-dim:#8A6128;
  /* cream / kraft */
  --cream:#FBF3E2; --kraft:#E4CBA4; --kraft-2:#D6B98D; --kraft-3:#C4A377;
  /* accents */
  --pistachio:#93C97A; --caramel:#F0A24A; --jam:#E4705C;
  --blueberry:#9BCFE8; --mallow:#C9A8E0;
  /* semantic aliases — components use these, not the ramps */
  --bg:var(--cocoa-4); --surface:var(--cocoa-3); --surface-raised:var(--cocoa-2);
  --surface-hover:var(--cocoa-1); --border:var(--rim);
  --text:var(--pb-light); --text-dim:var(--pb-mid); --text-faint:var(--pb-dim);
  --accent:var(--pb); --accent-hot:var(--pb-hot);
  /* form */
  --r-sm:3px; --r-md:6px; --r-lg:12px; --r-cup:999px;
  --pad:12px; --sh-1:0 1px 0 var(--cocoa-5); --sh-2:0 6px 18px -8px #000;
  --mono:"Berkeley Mono","IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
  --round:"Baloo 2","Quicksand",ui-rounded,system-ui,sans-serif;
  color-scheme: dark;
}
```

Components reference the **semantic aliases** only. Changing a ramp value must
never require touching a component rule — that is how the wrapper stays
swappable while the tool underneath stays the same.

---

## 10. Anti-goals

The tagline is a constraint, not a joke.

- No spinners that imply the machine is more certain than it is. Show tokens,
  show steps, show elapsed time.
- No dark UI patterns: no fake scarcity, no pre-checked uploads, no telemetry
  toggles buried in a submenu. There is no backend; there is nothing to phone
  home with, and the design should make that obvious.
- No blue-gray "AI product" chrome. No neon gradients, no glassmorphism, no
  glow for glow's sake.
- No hidden destructive actions. `WIPE` is always red-bordered, always
  confirmed.
- No motion that cannot be turned off.
- No cuteness where clarity is needed: the cup smiles in the title bar and the
  empty state. It does not smile inside an error message.
