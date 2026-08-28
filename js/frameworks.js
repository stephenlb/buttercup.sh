/* ═══════════════════════════════════════════════════════════════════════════
   Frameworks — the harness's built-in knowledge about building browser agents.

   Served by the `framework_docs` and `scaffold` tools. This is deliberately
   local data: the harness has no backend, so anything the model can rely on
   without network access has to ship in the page. Where a real package's API
   surface matters, the docs tell the model to confirm it at runtime with the
   `npm_info` / `npm_file` tools instead of guessing.
   ═══════════════════════════════════════════════════════════════════════════ */
window.Frameworks = (function () {

  /* ── shared scaffold pieces ─────────────────────────────────────────────── */

  const AGENT_LOOP = `// agent.js — the loop. Framework-neutral: swap \`complete\` for an SDK call.
import { TOOLS, runTool } from "./tools.js";
import { complete } from "./provider.js";

/**
 * Run one agent turn to completion: keep calling the model until it stops
 * asking for tools. \`onEvent\` gets {type} records so a UI can narrate.
 */
export async function runAgent({ goal, apiKey, model, system, maxSteps = 12, onEvent = () => {} }) {
  const messages = [{ role: "user", content: [{ type: "text", text: goal }] }];

  for (let step = 0; step < maxSteps; step++) {
    onEvent({ type: "step", step });

    const reply = await complete({ apiKey, model, system, messages, tools: TOOLS });
    messages.push({ role: "assistant", content: reply.content });

    const calls = reply.content.filter((b) => b.type === "tool_use");
    const text = reply.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    if (text) onEvent({ type: "text", text });

    if (!calls.length) return { text, messages, steps: step + 1 };

    const results = [];
    for (const call of calls) {
      onEvent({ type: "tool", name: call.name, input: call.input });
      try {
        const output = await runTool(call.name, call.input);
        results.push({ type: "tool_result", tool_use_id: call.id, content: String(output) });
      } catch (err) {
        results.push({
          type: "tool_result", tool_use_id: call.id,
          content: \`error: \${err.message}\`, is_error: true,
        });
      }
    }
    messages.push({ role: "user", content: results });
  }

  return { text: "", messages, steps: maxSteps, hitLimit: true };
}
`;

  const PROVIDER = `// provider.js — one model call. Runs in the browser, no server.
//
// Anthropic requires an explicit opt-in header for direct browser calls. Any
// key you ship to a browser is visible to whoever loads the page, so this is
// for local tools, internal dashboards and demos — not public products.

const ENDPOINT = "https://api.anthropic.com/v1/messages";

export async function complete({ apiKey, model = "claude-opus-5", system, messages, tools = [], signal }) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model,
      max_tokens: 16000,
      thinking: { type: "adaptive" },        // adaptive: no budget_tokens on 4.6+
      output_config: { effort: "high" },
      ...(system ? { system } : {}),
      ...(tools.length ? { tools } : {}),
      messages,
    }),
  });

  if (!res.ok) throw new Error(\`anthropic \${res.status}: \${await res.text()}\`);
  const json = await res.json();
  if (json.stop_reason === "refusal") {
    throw new Error(\`declined (\${json.stop_details?.category ?? "unknown"})\`);
  }
  return json;
}
`;

  const TOOLS_FILE = `// tools.js — what the agent can actually do.
//
// Each entry is an Anthropic-shaped tool definition plus a local handler.
// In a browser the useful primitives are DOM, storage, and CORS-enabled HTTP.

/** @type {Array<{name:string, description:string, input_schema:object}>} */
export const TOOLS = [
  {
    name: "remember",
    description: "Save a note under a key so later turns (and reloads) can read it.",
    input_schema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Short identifier." },
        value: { type: "string", description: "Text to store." },
      },
      required: ["key", "value"],
    },
  },
  {
    name: "recall",
    description: "Read back every saved note. Call this before asking the user to repeat themselves.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "http_get",
    description:
      "GET a URL and return the response body as text. Only works against " +
      "servers that send permissive CORS headers.",
    input_schema: {
      type: "object",
      properties: { url: { type: "string", description: "Absolute https URL." } },
      required: ["url"],
    },
  },
];

// localStorage throws in a sandboxed frame (no allow-same-origin), so fall back
// to memory rather than crashing the agent when it is running inside a preview.
const NS = "agent.memory.v1";
let fallback = {};
function memory() {
  try { return JSON.parse(localStorage.getItem(NS) || "{}"); } catch (_) { return fallback; }
}
function saveMemory(m) {
  fallback = m;
  try { localStorage.setItem(NS, JSON.stringify(m)); } catch (_) {}
}

const HANDLERS = {
  remember({ key, value }) {
    const m = memory();
    m[key] = value;
    saveMemory(m);
    return \`saved \${key}\`;
  },
  recall() {
    const m = memory();
    const keys = Object.keys(m);
    if (!keys.length) return "(nothing saved yet)";
    return keys.map((k) => \`\${k}: \${m[k]}\`).join("\\n");
  },
  async http_get({ url }) {
    const res = await fetch(url, { headers: { accept: "text/plain, application/json, */*" } });
    if (!res.ok) throw new Error(\`\${res.status} \${res.statusText}\`);
    return (await res.text()).slice(0, 20000);
  },
};

export async function runTool(name, input) {
  const handler = HANDLERS[name];
  if (!handler) throw new Error(\`unknown tool: \${name}\`);
  return await handler(input ?? {});
}
`;

  const INDEX_HTML = (title) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 2rem; background: #14100b; color: #f6c66a;
         font: 14px/1.55 ui-monospace, "SFMono-Regular", Menlo, monospace; }
  h1 { font-size: 1rem; letter-spacing: .18em; text-transform: uppercase; }
  form { display: grid; gap: .5rem; max-width: 46rem; }
  input, textarea, button { font: inherit; color: inherit; background: #1d170f;
    border: 1px solid #4a3a1e; padding: .45rem .5rem; }
  button { cursor: pointer; text-transform: uppercase; letter-spacing: .12em; }
  #out { max-width: 46rem; white-space: pre-wrap; border-left: 3px solid #4a3a1e;
    padding-left: .8rem; margin-top: 1.2rem; }
  .tool { color: #a8873f; }
  .err { color: #e5705c; }
</style>
</head>
<body>
  <h1>${title}</h1>
  <form id="f">
    <input id="key" type="password" placeholder="API key (stays in this browser)">
    <textarea id="goal" rows="3" placeholder="what should the agent do?"></textarea>
    <button type="submit">RUN AGENT</button>
  </form>
  <div id="out"></div>

  <script type="module">
    import { runAgent } from "./agent.js";

    const out = document.getElementById("out");
    const say = (text, cls) => {
      const line = document.createElement("div");
      if (cls) line.className = cls;
      line.textContent = text;
      out.appendChild(line);
    };

    // Storage is unavailable inside a sandboxed preview frame; degrade quietly.
    const stash = {
      get: (k) => { try { return localStorage.getItem(k) || ""; } catch (_) { return ""; } },
      set: (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} },
    };
    document.getElementById("key").value = stash.get("agent.key");

    document.getElementById("f").addEventListener("submit", async (event) => {
      event.preventDefault();
      out.textContent = "";
      const apiKey = document.getElementById("key").value.trim();
      stash.set("agent.key", apiKey);
      try {
        const result = await runAgent({
          goal: document.getElementById("goal").value,
          apiKey,
          system: "You are a concise browser-resident agent. Use your tools before guessing.",
          onEvent: (e) => {
            if (e.type === "step") say(\`— step \${e.step + 1} —\`, "tool");
            if (e.type === "tool") say(\`· \${e.name}(\${JSON.stringify(e.input)})\`, "tool");
            if (e.type === "text") say(e.text);
          },
        });
        if (result.hitLimit) say("(stopped: step limit reached)", "err");
      } catch (err) {
        say(String(err), "err");
      }
    });
  <\/script>
</body>
</html>
`;

  const README = (fw, title) => `# ${title}

Built in **buttercup.sh** — a static, no-backend agent harness.
Target framework: **${fw.name}** (${fw.npm ? "npm: `" + fw.npm + "`" : "no package"}).

## Run it

Every file is static, but ES modules need a real origin, so serve the folder:

    python3 -m http.server 8080
    # then open http://localhost:8080/index.html

Inside the harness you can skip that: \`preview index.html\` mounts it in the
PREVIEW pane, and \`run_agent\` executes a module and reports what it logged.

## Files

| file | role |
|---|---|
| \`index.html\` | the UI, and the only file a user opens |
| \`agent.js\` | the agent loop: model → tools → model, until done |
| \`tools.js\` | tool definitions + handlers, the part worth editing |
| \`provider.js\` | one HTTP call to the model vendor |

## Keys in a browser

A key shipped to a browser belongs to whoever loads the page. That's fine for a
local tool or an internal dashboard; for anything public, put a proxy in front
and drop \`provider.js\`.
`;

  /* ── catalogue ──────────────────────────────────────────────────────────── */

  const FRAMEWORKS = [
    {
      id: "blocks-ai",
      name: "Blocks.AI / Blocks Network",
      npm: "@blocks-network/sdk",
      homepage: "https://github.com/blocksnetwork/blocks-sdk",
      summary: "Agent network: a Node handler you publish, plus a browser consumer client. Default target.",
      docs: `# Blocks.AI — Blocks Network SDK

Packages (verify current versions with \`npm_info\` before pinning):
\`@blocks-network/sdk\` (runtime + consumer client), \`@blocks-network/cli\`
(the \`blocks\` command), \`@blocks-network/mcp-server\`.
Repo: github.com/blocksnetwork/blocks-sdk.

## The split that matters

Blocks has two sides, and only one of them is a browser:

- **Agent side — Node.** An agent is an \`agent-card.json\` plus a handler
  module, started by \`blocks run\` (which shells into the SDK's \`blocks-run\`).
  It holds a long-lived realtime subscription and reads \`BLOCKS_API_KEY\` from
  the environment. This **cannot run in a browser tab**, and you should say so
  rather than pretending otherwise. This harness still writes it: author the
  card and handler here, export the zip, then \`npm i && blocks run\`.
- **Consumer side — browser-safe.** \`TaskClient\` submits tasks to agents on the
  network and streams results back. \`textPart\` / \`filePart\` are explicitly
  browser-safe (\`filePart\` takes a \`File\` or \`Blob\`; only
  \`filePartFromPath\` touches \`node:fs\`). This is the part you can build, mount
  in the PREVIEW pane, and hand to a user as a page.

## Agent card

\`\`\`json
{
  "identity": {
    "agentName": "my_agent",
    "displayName": "My Agent",
    "description": "What it does",
    "version": "1.0.0",
    "provider": { "organization": "Your Org" }
  },
  "capabilities": { "taskKinds": ["request"] },
  "tags": [{ "id": "main", "name": "Main" }],
  "runtime": { "handler": "./handler.js", "handlerExport": "default", "concurrency": 1 }
}
\`\`\`

\`identity.agentName\` must match \`^[a-zA-Z0-9_]+$\` — underscores, never hyphens.

## Handler

\`\`\`js
export default async function handler(task, ctx) {
  const goal = (task.requestParts ?? []).map((p) => p.text).filter(Boolean).join("\\n");
  ctx.reportStatus("working…");                       // progress event to the consumer
  // ctx.taskId, ctx.cancelSignal, ctx.isCancelled, ctx.createStream(), ctx.taskClient
  // ctx.downloadInputArtifact(part), ctx.publishArtifact(data, { mimeType })
  return { artifacts: [{ data: "result text", mimeType: "text/plain" }] };
}
\`\`\`

Returned \`artifacts\` are published in order before the terminal event.

## Consumer client

\`\`\`js
import { TaskClient, textPart } from "https://esm.sh/@blocks-network/sdk";

const client = await TaskClient.create({
  billingMode: "free",            // 'free' → playground keyset, 'paid' → network.
  tokenEndpoint: "/api/blocks-token",  // your proxy mints the JWT; no key in the page
});

const session = await client.sendMessage({
  agentName: "my_agent",
  requestParts: [textPart("hello")],
  stream: true,                   // opt in; the server default is no streaming
});

session.onProgress((e) => console.log(e.message));
session.onError((err, where) => console.warn(where.callbackType, err.message));
const terminal = await session.waitForTerminal(60000);

for (const ref of session.listArtifacts()) {
  const { data, mimeType } = await session.downloadArtifact(ref);   // data: Uint8Array
  console.log(mimeType, new TextDecoder().decode(data));
}
session.close();
client.destroy();
\`\`\`

Auth has three modes: \`apiKey\` (**server-side only** — never in a page),
\`tokenEndpoint\` (a URL string, or a config object with \`credentials\`,
\`headers\`, \`body\`), and \`tokenProvider\` (an async function returning
\`{ token, expiresIn, userId }\`). For anything in a browser, use one of the
latter two. \`billingMode\` must match the agent's registered mode or the
backend rejects the call with \`BillingModeMismatch\`.

## Before you write more than the above

Everything here was read off the published package, but versions move. Confirm
with \`npm_info @blocks-network/sdk\`, then \`npm_file @blocks-network/sdk
dist/index.d.ts\` for the export list, and \`run_js\` with a dynamic import from
esm.sh to see the live surface. Never invent an export.`,
      scaffold(dir) {
        const files = baseScaffold(dir, this, "Blocks agent");
        delete files[`${dir}/README.md`];

        files[`${dir}/agent-card.json`] = JSON.stringify({
          identity: {
            agentName: "my_agent",
            displayName: "My Agent",
            description: "Answers a request using an LLM and a small set of tools.",
            version: "1.0.0",
            provider: { organization: "Your Org" },
          },
          capabilities: { taskKinds: ["request"] },
          tags: [{ id: "main", name: "Main" }],
          runtime: { handler: "./handler.js", handlerExport: "default", concurrency: 1 },
        }, null, 2) + "\n";

        files[`${dir}/handler.js`] = `// handler.js — the Blocks agent entry point. Runs under \`blocks run\` (Node).
//
// Signature: (task: StartTaskMessage, ctx?: TaskContext) => Promise<HandlerResult>
// The loop, tools and provider live in the sibling modules so the same logic
// also runs in the browser page (index.html) without a Blocks account.

import { runAgent } from "./agent.js";

export default async function handler(task, ctx) {
  const goal = (task.requestParts ?? [])
    .map((part) => part.text)
    .filter(Boolean)
    .join("\\n")
    .trim();

  if (!goal) return { artifacts: [{ data: "No request text provided.", mimeType: "text/plain" }] };

  ctx?.reportStatus(\`starting: \${goal.slice(0, 60)}\`);

  const result = await runAgent({
    goal,
    apiKey: process.env.ANTHROPIC_API_KEY,
    system: "You are a Blocks Network agent. Be concise and use your tools before guessing.",
    onEvent(event) {
      if (ctx?.isCancelled) return;
      if (event.type === "tool") ctx?.reportStatus(\`tool: \${event.name}\`);
      if (event.type === "step") ctx?.reportStatus(\`step \${event.step + 1}\`);
    },
  });

  return {
    artifacts: [{
      data: result.text || "(the model returned no text)",
      mimeType: "text/plain",
      fileName: "answer.txt",
    }],
  };
}
`;

        files[`${dir}/.env.example`] = `# Copy to .env — \`blocks run\` loads it from the working directory.
# \`blocks login --write-env\` fills in BLOCKS_API_KEY for you.
BLOCKS_API_KEY=
ANTHROPIC_API_KEY=
LOG_LEVEL=info
`;

        files[`${dir}/web/index.html`] = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Blocks consumer</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 2rem; background: #14100b; color: #f6c66a;
         font: 14px/1.55 ui-monospace, "SFMono-Regular", Menlo, monospace; }
  h1 { font-size: 1rem; letter-spacing: .18em; text-transform: uppercase; }
  form { display: grid; gap: .5rem; max-width: 46rem; }
  input, textarea, button { font: inherit; color: inherit; background: #1d170f;
    border: 1px solid #4a3a1e; padding: .45rem .5rem; }
  button { cursor: pointer; text-transform: uppercase; letter-spacing: .12em; }
  #out { max-width: 46rem; white-space: pre-wrap; border-left: 3px solid #4a3a1e;
    padding-left: .8rem; margin-top: 1.2rem; }
  .status { color: #a8873f; }
  .err { color: #e5705c; }
</style>
</head>
<body>
  <h1>Blocks consumer</h1>
  <p class="status">Submits a task to an agent on the Blocks network and streams
     the result back. No API key lives in this page — token minting happens at
     the endpoint configured in <code>consumer.js</code>.</p>
  <form id="f">
    <input id="agent" value="my_agent" spellcheck="false">
    <textarea id="goal" rows="3" placeholder="what should the agent do?"></textarea>
    <button type="submit">SEND TASK</button>
  </form>
  <div id="out"></div>
  <script type="module" src="./consumer.js"><\/script>
</body>
</html>
`;

        files[`${dir}/web/consumer.js`] = `// consumer.js — browser side. Submits tasks to a Blocks agent and streams results.
//
// Pin the version once you have confirmed it with \`npm_info @blocks-network/sdk\`.
import { TaskClient, textPart } from "https://esm.sh/@blocks-network/sdk";

// Your own endpoint: it authenticates the visitor however you like, calls
// POST /api/v1/auth/agent/consumer-token with the Blocks API key it holds, and
// returns { token, expiresIn, userId }. The key never reaches this file.
const TOKEN_ENDPOINT = "/api/blocks-token";

const out = document.getElementById("out");
const say = (text, cls) => {
  const line = document.createElement("div");
  if (cls) line.className = cls;
  line.textContent = text;
  out.appendChild(line);
};

document.getElementById("f").addEventListener("submit", async (event) => {
  event.preventDefault();
  out.textContent = "";

  let client, session;
  try {
    client = await TaskClient.create({
      billingMode: "free",          // must match how the agent was registered
      tokenEndpoint: TOKEN_ENDPOINT,
      onAuthError: (err) => say("auth: " + err.message, "err"),
    });

    session = await client.sendMessage({
      agentName: document.getElementById("agent").value.trim(),
      requestParts: [textPart(document.getElementById("goal").value)],
      stream: true,
    });

    session.onProgress((e) => say("· " + e.message, "status"));
    session.onError((err, where) => say(\`! \${where.callbackType}: \${err.message}\`, "err"));

    const terminal = await session.waitForTerminal(120000);
    say("— " + terminal.state + " —", "status");

    for (const ref of session.listArtifacts()) {
      const artifact = await session.downloadArtifact(ref);
      say(artifact.mimeType.startsWith("text/")
        ? new TextDecoder().decode(artifact.data)
        : \`[\${artifact.mimeType}] \${artifact.data.length} bytes\`);
    }
  } catch (err) {
    say(String(err && err.message ? err.message : err), "err");
  } finally {
    session?.close();
    client?.destroy();
  }
});
`;

        files[`${dir}/README.md`] = `# Blocks agent

Built in **buttercup.sh**. Two halves, because Blocks has two halves.

## 1. The agent — Node, not a browser

\`agent-card.json\` + \`handler.js\` are run by the Blocks CLI, which keeps a
realtime subscription open and needs \`BLOCKS_API_KEY\`. A browser tab cannot do
that, so this half runs on your machine or a server:

    npm init -y && npm pkg set type=module
    npm i @blocks-network/sdk @blocks-network/cli
    cp .env.example .env
    npx blocks login --write-env      # fills BLOCKS_API_KEY
    # add ANTHROPIC_API_KEY to .env
    npx blocks run

\`handler.js\` delegates to \`agent.js\` / \`tools.js\` / \`provider.js\`, so the
agent's actual behaviour is editable without touching Blocks plumbing. Edit
\`tools.js\` first — that is what makes the agent yours.

## 2. The consumer — browser

\`web/index.html\` + \`web/consumer.js\` submit tasks to the deployed agent with
\`TaskClient\` and stream progress and artifacts back. Serve them from any static
host:

    python3 -m http.server 8080     # then open /web/index.html

\`web/consumer.js\` expects a \`/api/blocks-token\` endpoint that mints a consumer
JWT from your server-held API key. Until that exists, the page will report an
auth failure — that is the correct behaviour, not a bug to work around by
putting the key in the page.

## 3. Run it with no Blocks account at all

\`index.html\` is a standalone browser harness for the same loop, calling the
model vendor directly. Good for iterating on \`tools.js\`; note that a key typed
into it is visible to anything running in that page.

| file | role |
|---|---|
| \`agent-card.json\` | identity, capabilities, runtime handler |
| \`handler.js\` | Blocks entry point — \`(task, ctx) => { artifacts }\` |
| \`agent.js\` | the loop: model → tools → model |
| \`tools.js\` | tool definitions + handlers |
| \`provider.js\` | one HTTP call to the model vendor |
| \`web/consumer.js\` | browser client that submits tasks |
| \`index.html\` | standalone browser runner (no Blocks) |
`;
        return files;
      },
    },
    {
      id: "vanilla",
      name: "Vanilla (no framework)",
      npm: null,
      homepage: null,
      summary: "Hand-rolled loop over the vendor's HTTP API. Zero dependencies, always works.",
      docs: `# Vanilla browser agent

An agent is a loop, not a library:

1. POST messages + tool definitions to the vendor.
2. If the reply contains tool calls, run them locally and append **every**
   result as one user message — splitting them teaches the model to stop
   calling tools in parallel.
3. Repeat until the reply has no tool calls, or you hit a step cap.

That's ~40 lines (see \`agent.js\` in the scaffold). Reach for a framework when
you want retries, tracing, or a hosted loop — not to get started.

## Browser-specific gotchas

- **CORS.** You can only fetch origins that opt in. \`registry.npmjs.org\`,
  \`cdn.jsdelivr.net\`, \`esm.sh\` and most public JSON APIs do; the average
  website does not. Don't build a tool whose value depends on scraping.
- **Anthropic** needs \`anthropic-dangerous-direct-browser-access: true\`.
- **No filesystem.** Persistence is \`localStorage\` / IndexedDB / OPFS.
- **Long turns.** Stream, or a slow reply looks like a hang.`,
      scaffold(dir) { return baseScaffold(dir, this, "Browser agent"); },
    },
    {
      id: "esm-sdk",
      name: "Vendor SDK via esm.sh",
      npm: "@anthropic-ai/sdk",
      homepage: "https://esm.sh",
      summary: "Import a published npm SDK straight from a CDN — no bundler, still static.",
      docs: `# Vendor SDK from a CDN

\`esm.sh\` and \`cdn.jsdelivr.net/npm/…/+esm\` serve npm packages as ES modules, so
a static page can use a real SDK:

    import Anthropic from "https://esm.sh/@anthropic-ai/sdk";
    const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });

Trade-offs worth stating out loud before choosing this: the CDN becomes a
runtime dependency and a supply-chain surface, the first load is slower than a
hand-written \`fetch\`, and it will not work offline. Pin a version
(\`https://esm.sh/@anthropic-ai/sdk@0.70.0\`) rather than floating on latest.

Inside this harness, \`run_js\` can import from a CDN, so you can check that a
package loads before committing an agent to it.`,
      scaffold(dir) { return baseScaffold(dir, this, "SDK-backed agent"); },
    },
  ];

  function baseScaffold(dir, fw, title) {
    return {
      [`${dir}/index.html`]: INDEX_HTML(title),
      [`${dir}/agent.js`]: AGENT_LOOP,
      [`${dir}/tools.js`]: TOOLS_FILE,
      [`${dir}/provider.js`]: PROVIDER,
      [`${dir}/README.md`]: README(fw, title),
    };
  }

  /* ── harness-level notes, always available to the model ─────────────────── */

  const HARNESS = `# Working inside buttercup.sh

You are running in a browser tab. There is no shell, no node, no server.

- **Workspace** — a virtual filesystem in \`localStorage\`. \`write\`, \`edit\`,
  \`read\`, \`list\`, \`glob\`, \`grep\` all operate on it. Paths are relative with
  no leading slash: \`demo/agent.js\`.
- **Executing code** — \`run_js\` evaluates a snippet as an ES module in a
  sandboxed iframe (top-level \`await\` and dynamic \`import\` from a CDN both
  work; \`return\` a value to see it). \`run_agent\` runs a workspace file as a
  module, resolving its relative imports against the other workspace files, and
  reports what it logged. Neither can touch this page.
- **Showing work** — \`preview\` mounts a workspace HTML file in the PREVIEW pane
  with its relative \`<script src>\`/\`<link>\`/\`import\` references wired up.
- **Network** — CORS applies. \`npm_info\`, \`npm_file\` and CDN imports work;
  arbitrary site fetches usually don't. \`http_get\` will tell you which it was.
- **Circular imports** are the one module pattern \`run_agent\` cannot resolve.
- **The sandbox has an opaque origin**, so code running in it has no
  \`localStorage\` (guard it) and some vendors will reject its API calls as
  cross-origin. Use the sandbox to prove the code loads, wires up and calls the
  right tools; tell the user to export and serve on \`localhost\` for a live
  end-to-end run with a real key.

## House style for what you build

Deliver something the user can open. That means an \`index.html\` entry point, a
loop separated from its tool definitions, and one thin provider adapter. Verify
with \`run_agent\` or \`run_js\` before you claim it works, and if a step failed,
say which one.
`;

  return {
    list: () => FRAMEWORKS.map((f) => ({
      id: f.id, name: f.name, npm: f.npm, homepage: f.homepage, summary: f.summary,
    })),
    get: (id) => FRAMEWORKS.find((f) => f.id === id),
    ids: () => FRAMEWORKS.map((f) => f.id),
    harnessNotes: HARNESS,
  };
})();
