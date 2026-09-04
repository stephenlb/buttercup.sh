/* ═══════════════════════════════════════════════════════════════════════════
   LLM — direct browser → vendor streaming, one adapter per provider.

   There is no proxy, so each adapter speaks the vendor's own wire format and
   normalises it into one internal message shape:

     { role: "user" | "assistant", parts: Part[] }

     Part = { type: "text",        text }
          | { type: "image",       mediaType, data }        // base64, user turns
          | { type: "thinking",    text, signature? }
          | { type: "tool_use",    id, name, input }
          | { type: "tool_result", id, name, output, error?, shots? }  // shots: images

   Raw fetch rather than an SDK: this page has no bundler, and shipping a CDN
   import for three vendors would trade a readable ~250 lines for a runtime
   dependency on someone else's uptime. The one exception is WebLLM, where the
   runtime is the point — its in-tab inference engine is imported lazily, and
   only when that provider is picked.
   ═══════════════════════════════════════════════════════════════════════════ */
window.LLM = (function () {

  const tstamp = () => {
    const d = new Date();
    return `${d.toTimeString().slice(0, 8)}.${String(d.getMilliseconds()).padStart(3, "0")}`;
  };

  /* WebLLM windows are a per-model GPU memory budget, not a capability claim:
     web-llm sizes the paged KV cache to this number, so raising it past what a
     build's own `vram_required_MB` assumed is how a mid-range GPU ends up with
     a lost device mid-load. Everything therefore runs at the shared default; a
     per-model entry belongs here only with a measured VRAM figure behind it. */
  const WEBLLM_CTX = 8192;
  const WEBLLM_WINDOWS = {};
  const webllmWindow = (model) => WEBLLM_WINDOWS[model] || WEBLLM_CTX;

  /* `api` selects the wire format; `url` is the base a chat-completions vendor
     hangs /chat/completions and /models off, and the user can override it in the
     KEYS panel — that is what makes an unfamiliar OpenAI-compatible gateway work
     without a code change. */
  const MODELS = {
    ollama: {
      // Runs on the machine, so there is no key to paste and the model names are
      // whatever `ollama pull` has fetched locally.
      label: "Ollama — local", api: "chat", keyHint: "no key needed", keyless: true,
      url: "http://localhost:11434/v1", effortKnob: false,
      models: ["qwen3-coder:30b", "gpt-oss:20b", "llama3.1:8b", "deepseek-r1:14b"],
    },
    vllm: {
      // `vllm serve <model>` on the default port; the served name is the model
      // repo id, so leave the field to whatever the server was started with.
      label: "vLLM — local server", api: "chat", keyHint: "no key needed", keyless: true,
      url: "http://localhost:8000/v1", effortKnob: false, models: [],
    },
    webllm: {
      // Weights download once into the browser cache; tools go through the
      // text bridge, not the native `tools` path (see the adapter).
      label: "WebLLM — in this tab", api: "webllm", keyHint: "no key needed", keyless: true,
      effortKnob: false, contextWindow: WEBLLM_CTX, windows: WEBLLM_WINDOWS, leanTools: true,
      // The 9B leads: the only size that ran the full tool loop cleanly.
      models: [
        "Qwen3.5-9B-q4f16_1-MLC", "Qwen3.5-4B-q4f16_1-MLC", "Qwen3.5-2B-q4f16_1-MLC",
        "Qwen3-8B-q4f16_1-MLC",
        "Hermes-3-Llama-3.1-8B-q4f16_1-MLC", "Hermes-3-Llama-3.1-8B-q4f32_1-MLC",
        "Hermes-2-Pro-Llama-3-8B-q4f16_1-MLC", "Hermes-2-Pro-Llama-3-8B-q4f32_1-MLC",
        "Hermes-2-Pro-Mistral-7B-q4f16_1-MLC",
      ],
    },
    anthropic: {
      label: "Anthropic — Claude", api: "anthropic", keyHint: "sk-ant-…",
      models: [
        "claude-opus-5", "claude-fable-5-1", "claude-fable-5", "claude-sonnet-5",
        "claude-opus-4-8", "claude-haiku-4-5",
      ],
    },
    openai: {
      label: "OpenAI — Codex / GPT", api: "chat", keyHint: "sk-…",
      url: "https://api.openai.com/v1", effortKnob: true,
      models: ["gpt-5.6", "gpt-5.6-codex", "gpt-5.1", "o4-mini"],
    },
    xai: {
      // Grok always reasons on the 4 series and rejects reasoning_effort there.
      label: "xAI — Grok", api: "chat", keyHint: "xai-…",
      url: "https://api.x.ai/v1",
      models: ["grok-4.1", "grok-4.1-fast", "grok-4", "grok-4-fast-reasoning", "grok-code-fast-1"],
    },
    google: {
      label: "Google — Gemini", api: "google", keyHint: "AIza…",
      models: [
        "gemini-3.1-pro-preview", "gemini-3.7-flash", "gemini-3.6-flash",
        "gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite",
        "gemini-3-pro", "gemini-2.5-pro", "gemini-2.5-flash",
      ],
    },
    openrouter: {
      label: "OpenRouter — any model", api: "chat", keyHint: "sk-or-v1-…",
      url: "https://openrouter.ai/api/v1", probe: "key", effortKnob: true,
      models: [
        "anthropic/claude-opus-4.5", "openai/gpt-5.1", "x-ai/grok-4.1-fast",
        "google/gemini-3-pro", "deepseek/deepseek-chat",
      ],
    },
    freebuff: {
      // An OpenAI-compatible gateway: base URL and model names are whatever the
      // account is issued, so both fields are yours to set in the KEYS panel.
      label: "FreeBuff — OpenAI-compatible", api: "chat", keyHint: "gateway key",
      url: "https://api.freebuff.ai/v1", effortKnob: false, models: [],
    },
  };

  const baseOf = (provider, override) =>
    String(override || MODELS[provider]?.url || "").trim().replace(/\/+$/, "");

  /* ── shared plumbing ────────────────────────────────────────────────────── */

  /** Yield each parsed `data:` payload of a Server-Sent Events response. */
  async function* sse(res) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Events are separated by a blank line; tolerate CRLF.
      let split;
      while ((split = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const chunk = buffer.slice(0, split);
        buffer = buffer.slice(split).replace(/^\r?\n\r?\n/, "");
        for (const line of chunk.split(/\r?\n/)) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          try { yield JSON.parse(data); } catch (_) { /* keep-alive or partial */ }
        }
      }
    }
  }

  async function fail(res, provider) {
    let detail = await res.text().catch(() => "");
    try {
      const json = JSON.parse(detail);
      detail = json.error?.message || json.error?.[0]?.message || json.message || detail;
    } catch (_) { /* plain text */ }
    const hint = res.status === 401 || res.status === 403 ? " — check the API key in the KEYS panel"
      : res.status === 404 ? " — check the model name and base url in the KEYS panel"
      : res.status === 429 ? " — rate limited; wait and retry"
      : res.status === 0 ? " — blocked before it left the browser (CORS?)" : "";
    throw new Error(`${provider} HTTP ${res.status}${hint}\n${detail.slice(0, 1200)}`);
  }

  /* Header values must be Latin-1. Keys pasted out of a doc, chat client or PDF
     often carry invisible passengers — non-breaking spaces, zero-width joiners,
     a BOM — and `fetch` answers with an opaque TypeError ("String contains non
     ISO-8859-1 code point") that names neither the header nor the character.
     So: strip the invisibles, then explain anything still left. */
  const INVISIBLE = /[\u00ad\u180e\u200b-\u200f\u2060\ufeff]/g;      // soft hyphen, zero-width, BOM
  const SPACES = /[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g;  // NBSP and its relatives

  /** Trim a pasted key and report leftover characters an API key cannot contain. */
  function cleanKey(raw) {
    const key = String(raw ?? "").replace(INVISIBLE, "").replace(SPACES, " ").trim();
    const bad = [...new Set(key.match(/[^\x20-\x7e]/gu) || [])];
    return { key, bad };
  }

  function checkedKey(provider, raw) {
    const { key, bad } = cleanKey(raw);
    if (!key) throw new Error(`no ${provider} API key — open the KEYS panel and paste one`);
    if (bad.length) {
      const points = bad
        .map((c) => `U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`)
        .join(", ");
      throw new Error(
        `${provider} API key contains ${bad.length} character(s) that do not belong in ` +
        `an API key (${points}) — it was probably copied from formatted text. ` +
        `Re-copy it as plain text, or retype it, then SAVE again.`
      );
    }
    return key;
  }

  /** Gemini rejects JSON Schema keywords it does not know; keep the subset. */
  function geminiSchema(schema) {
    if (!schema || typeof schema !== "object") return schema;
    const ALLOWED = ["type", "description", "enum", "items", "properties", "required", "format", "nullable"];
    const out = {};
    for (const key of ALLOWED) {
      if (!(key in schema)) continue;
      if (key === "properties") {
        out.properties = Object.fromEntries(
          Object.entries(schema.properties).map(([k, v]) => [k, geminiSchema(v)])
        );
      } else if (key === "items") out.items = geminiSchema(schema.items);
      else out[key] = schema[key];
    }
    return out;
  }

  /**
   * Provider spec, cleaned key and resolved base url — the same preflight both
   * `complete` and `validate` need before they can address the vendor at all.
   * Throws the reason when the settings cannot describe a reachable endpoint.
   */
  function resolve({ provider, apiKey, baseUrl }) {
    const spec = MODELS[provider];
    if (!spec) throw new Error(`unknown provider: ${provider}`);
    // A local server authenticates nobody, so an empty key is the normal case.
    const key = spec.keyless ? cleanKey(apiKey).key : checkedKey(provider, apiKey);
    const base = baseOf(provider, baseUrl);
    if (spec.api === "chat" && !base) throw new Error(`${provider}: no base url — set one in the KEYS panel`);
    return { spec, key, base };
  }

  /**
   * The tail the two flat-stream adapters share: one text part if anything was
   * said, then a `tool_use` per call, in the order the vendor emitted them.
   */
  function flatParts(text, calls) {
    const parts = text ? [{ type: "text", text }] : [];
    for (const c of calls) {
      parts.push({ type: "tool_use", id: c.id || `call_${parts.length}`, name: c.name, input: c.input });
    }
    return parts;
  }

  const ADAPTIVE = /^claude-(opus-(5|4-8|4-7|4-6)|sonnet-(5|4-6)|fable-5|mythos-5)/;
  const FALLBACK_CAPABLE = /^claude-(opus-5|fable-5|mythos-5)/;

  /* ── Anthropic ──────────────────────────────────────────────────────────── */

  async function anthropic({ model, apiKey, system, messages, tools, effort, signal, on }) {
    const body = {
      model,
      max_tokens: 32000,
      stream: true,
      output_config: { effort },
      messages: messages.map((m) => ({
        role: m.role,
        content: m.parts.map((p) => {
          if (p.type === "text") return { type: "text", text: p.text };
          if (p.type === "image") {
            return { type: "image", source: { type: "base64", media_type: p.mediaType, data: p.data } };
          }
          if (p.type === "thinking") return { type: "thinking", thinking: p.text, signature: p.signature };
          if (p.type === "tool_use") return { type: "tool_use", id: p.id, name: p.name, input: p.input };
          // A tool result may carry pictures (a preview screenshot); Anthropic
          // takes image blocks inside the result itself, so they stay attached
          // to the call that produced them.
          const content = p.shots && p.shots.length
            ? [{ type: "text", text: p.output }, ...p.shots.map((s) => ({
                type: "image", source: { type: "base64", media_type: s.mediaType, data: s.data },
              }))]
            : p.output;
          return {
            type: "tool_result", tool_use_id: p.id, content,
            ...(p.error ? { is_error: true } : {}),
          };
        }),
      })),
    };
    if (system) body.system = system;
    if (tools.length) {
      body.tools = tools.map((t) => ({
        name: t.name, description: t.description, input_schema: t.input_schema,
      }));
    }
    // Adaptive thinking replaces budget_tokens on 4.6+; older models would 400.
    if (ADAPTIVE.test(model)) body.thinking = { type: "adaptive", display: "summarized" };

    const headers = {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      // Without this the API refuses calls made straight from a page.
      "anthropic-dangerous-direct-browser-access": "true",
    };
    // Server-side fallbacks turn a policy decline into a completed turn.
    if (FALLBACK_CAPABLE.test(model)) {
      body.fallbacks = "default";
      headers["anthropic-beta"] = "server-side-fallback-2026-07-01";
    }

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", headers, signal, body: JSON.stringify(body),
    });
    if (!res.ok) await fail(res, "anthropic");

    const blocks = [];
    const usage = { input: 0, output: 0 };
    let stopReason = null, stopDetail = null;

    for await (const event of sse(res)) {
      switch (event.type) {
        case "message_start":
          usage.input = event.message?.usage?.input_tokens || 0;
          break;
        case "content_block_start": {
          const b = event.content_block || {};
          blocks[event.index] =
            b.type === "tool_use" ? { type: "tool_use", id: b.id, name: b.name, json: "" }
            : b.type === "thinking" ? { type: "thinking", text: "", signature: "" }
            : { type: "text", text: b.text || "" };
          if (b.type === "tool_use") on.toolStart?.(b.name);
          break;
        }
        case "content_block_delta": {
          const block = blocks[event.index];
          const d = event.delta || {};
          if (!block) break;
          if (d.type === "text_delta") { block.text += d.text; on.text?.(d.text); }
          else if (d.type === "thinking_delta") { block.text += d.thinking; on.thinking?.(d.thinking); }
          else if (d.type === "signature_delta") block.signature += d.signature;
          else if (d.type === "input_json_delta") block.json += d.partial_json;
          break;
        }
        case "message_delta":
          stopReason = event.delta?.stop_reason || stopReason;
          stopDetail = event.delta?.stop_details || stopDetail;
          usage.output = event.usage?.output_tokens || usage.output;
          break;
        case "error":
          throw new Error(`anthropic stream error: ${event.error?.message || "unknown"}`);
      }
    }

    const parts = blocks.filter(Boolean).map((b) => {
      if (b.type === "tool_use") return { type: "tool_use", id: b.id, name: b.name, input: safeJson(b.json) };
      if (b.type === "thinking") return { type: "thinking", text: b.text, signature: b.signature };
      return { type: "text", text: b.text };
    }).filter((p) => p.type !== "text" || p.text);

    if (stopReason === "refusal") {
      throw new Error(
        `the model declined this request (${stopDetail?.category || "unspecified"})` +
        (stopDetail?.explanation ? `: ${stopDetail.explanation}` : "")
      );
    }
    return { parts, stopReason, usage };
  }

  /* ── OpenAI-compatible: OpenAI, xAI/Grok, OpenRouter, any gateway ───────────
     They all speak chat-completions verbatim, so one adapter covers them; the
     only divergences are the base URL and whether `reasoning_effort` is
     accepted (some vendors 400 on it for models that always reason).
     ------------------------------------------------------------------------- */

  /**
   * The OpenAI chat-completions wire form of the internal message shape —
   * shared by the gateways and the in-tab WebLLM engine.
   * `useRaw` replays an assistant turn as the engine's own text instead of
   * re-rendering it from parts (WebLLM's KV reuse needs the bytes to match).
   * Only the bridge understands that shape: a gateway needs the `tool_calls`
   * array that raw text does not carry, or it rejects the tool results that
   * follow — which is what a mid-session provider switch would otherwise send.
   */
  function toWire(system, messages, useRaw = false) {
    const wire = [];
    if (system) wire.push({ role: "system", content: system });
    for (const m of messages) {
      if (m.role === "user") {
        // Tool results are their own role in this format, so split the turn.
        const results = m.parts.filter((p) => p.type === "tool_result");
        const text = m.parts.filter((p) => p.type === "text").map((p) => p.text).join("\n");
        const shots = m.parts.filter((p) => p.type === "image");
        // A tool result's own pictures (a preview screenshot) cannot travel in a
        // `tool` message — this format has no image content there, and gateways
        // reject it — so they follow as a user turn that says where they came from.
        const fromTools = [];
        for (const r of results) {
          wire.push({ role: "tool", tool_call_id: r.id, name: r.name, content: r.error ? `error: ${r.output}` : r.output });
          for (const s of r.shots || []) fromTools.push({ name: r.name, shot: s });
        }
        if (fromTools.length) {
          const content = fromTools.map(({ shot }) => ({
            type: "image_url", image_url: { url: `data:${shot.mediaType};base64,${shot.data}` },
          }));
          content.push({
            type: "text",
            text: `The image(s) above are the result of the ${fromTools.map((f) => f.name).join(", ")} tool call above.`,
          });
          wire.push({ role: "user", content });
        }
        // A turn with pictures in it takes the array form of `content`; a plain
        // one stays a string, which is what every gateway has always accepted.
        if (shots.length) {
          const content = shots.map((p) => ({
            type: "image_url", image_url: { url: `data:${p.mediaType};base64,${p.data}` },
          }));
          if (text) content.push({ type: "text", text });
          wire.push({ role: "user", content });
        } else if (text) {
          wire.push({ role: "user", content: text });
        }
      } else if (useRaw && typeof m.raw === "string" && m.raw) {
        // Byte-exact replay of the engine's own reply — web-llm's KV reuse
        // dies if this turn is re-rendered from parts.
        wire.push({ role: "assistant", content: m.raw });
      } else {
        const text = m.parts.filter((p) => p.type === "text").map((p) => p.text).join("");
        const calls = m.parts.filter((p) => p.type === "tool_use").map((p) => ({
          id: p.id, type: "function",
          function: { name: p.name, arguments: JSON.stringify(p.input ?? {}) },
        }));
        const msg = { role: "assistant", content: text || null };
        if (calls.length) msg.tool_calls = calls;
        wire.push(msg);
      }
    }
    return wire;
  }

  async function chat({ provider, baseUrl, model, apiKey, system, messages, tools, effort, signal, on }) {
    const effortKnob = MODELS[provider]?.effortKnob;
    const wire = toWire(system, messages);

    const body = {
      model,
      messages: wire,
      stream: true,
      stream_options: { include_usage: true },
      max_completion_tokens: 32000,
    };
    // Reasoning-model knob; harmless on OpenAI, a 400 on some Grok models.
    if (effortKnob) body.reasoning_effort = effort === "xhigh" || effort === "max" ? "high" : effort;
    if (tools.length) {
      body.tools = tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.input_schema },
      }));
    }

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // A local server has no key; sending `Bearer ` empty upsets some of them.
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      signal, body: JSON.stringify(body),
    });
    if (!res.ok) await fail(res, provider);

    let text = "";
    const calls = [];
    const usage = { input: 0, output: 0 };
    let stopReason = null;

    for await (const event of sse(res)) {
      if (event.usage) {
        usage.input = event.usage.prompt_tokens || usage.input;
        usage.output = event.usage.completion_tokens || usage.output;
      }
      const choice = event.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta || {};
      if (delta.content) { text += delta.content; on.text?.(delta.content); }
      if (delta.reasoning_content) on.thinking?.(delta.reasoning_content);
      for (const tc of delta.tool_calls || []) {
        const slot = tc.index ?? calls.length;
        calls[slot] = calls[slot] || { id: "", name: "", json: "" };
        if (tc.id) calls[slot].id = tc.id;
        if (tc.function?.name) {
          calls[slot].name += tc.function.name;
          on.toolStart?.(calls[slot].name);
        }
        if (tc.function?.arguments) calls[slot].json += tc.function.arguments;
      }
      if (choice.finish_reason) stopReason = choice.finish_reason;
    }

    const ready = calls.filter(Boolean).map((c) => ({ id: c.id, name: c.name, input: safeJson(c.json) }));
    return { parts: flatParts(text, ready), stopReason, usage };
  };

  /* ── WebLLM — the model runs in this tab on WebGPU ──────────────────────────
     Nothing in here touches the network: the one dynamic import below fetches
     the inference runtime (a couple of MB, pinned), and the weights arrive
     from Hugging Face straight into the browser's HTTP cache on first use.
     The engine consumes the same OpenAI chat-completions shape as the
     gateways, so the wire builder is shared.
     ------------------------------------------------------------------------- */

  // jsDelivr's prebuilt lib bundle, not esm.sh: the latter's CJS interop leaks
  // a Node `createRequire` import that dies in the browser.
  const WEBLLM_SRC = "https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.84/lib/index.js";
  const engines = new Map();   // model id -> loaded engine, kept for the tab's life
  /* A load is minutes of downloading, and STOP abandons the turn without
     cancelling it (the bytes are worth keeping). The in-flight promise is
     shared, so the next send joins that load instead of starting a second one. */
  const loading = new Map();   // model id -> in-flight load promise

  function webllmWorker() {
    const src =
      `import { WebWorkerMLCEngineHandler } from ${JSON.stringify(WEBLLM_SRC)};` +
      `const handler = new WebWorkerMLCEngineHandler();` +
      `self.onmessage = (msg) => handler.onmessage(msg);`;
    return new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })), { type: "module" });
  }

  function webllmEngine(model, on) {
    const inFlight = loading.get(model);
    if (inFlight) {
      console.log(`[${tstamp()} webllm] ${model} is already loading — joining that load`);
      return inFlight;
    }
    const load = loadEngine(model, on);
    loading.set(model, load);
    // Nobody may be listening if the turn was abandoned; keep the rejection
    // from surfacing as an unhandled one, the caller still gets it.
    load.catch(() => {}).then(() => loading.delete(model));
    return load;
  }

  async function loadEngine(model, on) {
    const loaded = engines.get(model);
    if (loaded) {
      console.log(`[${tstamp()} webllm] ${model} already in memory this session — no load, no download`);
      on.status?.("generating");
      return loaded;
    }
    // One engine resident at a time.
    for (const [id, engine] of engines) {
      engines.delete(id);
      console.log(`[${tstamp()} webllm] ${id} unloaded — one engine resident at a time`);
      try { await engine.unload(); } catch (_) { /* already gone */ }
    }
    const cachedShards = await webllmCacheReport(model);
    try { console.log(`[${tstamp()} webllm] storage.persist() → ${await navigator.storage.persist()}`); }
    catch (_) { console.log(`[${tstamp()} webllm] storage.persist() unavailable`); }

    on.status?.(cachedShards > 0 ? "loading weights from disk cache" : "fetching weights — a few GB, once per model");
    const loadT0 = performance.now();
    const webllm = await import(WEBLLM_SRC);
    const config = {
      initProgressCallback: (report) => on.status?.(report.text, report.progress),
    };
    // `prefill_chunk_size` is not a knob here: web-llm reads it from the
    // compiled model lib's metadata (every prebuilt lib below is `_cs1k-`).
    const opts = { context_window_size: webllmWindow(model) };

    /* Shard fetches over the HF CDN drop mid-download now and then
       ("Cache.add() encountered a network error"), and already-cached shards
       are kept — so a dropped fetch is worth retrying, on either path. Nothing
       else is: a missing model lib, a WebGPU OOM or a lost device fails the
       same way every time, and retrying it four times only means the user
       stares at a stale progress line before hearing the real reason. */
    const errText = (err) => String(err?.message ?? err ?? "unknown error");
    const TRANSIENT = /cache\.add|network error|networkerror|failed to fetch|load failed|err_(network|connection)|\b(429|500|502|503|504)\b/i;
    const paths = [
      {
        name: "web worker",
        async make() {
          const worker = webllmWorker();
          try { return await webllm.CreateWebWorkerMLCEngine(worker, model, config, opts); }
          catch (err) { worker.terminate(); throw err; }
        },
      },
      { name: "main thread", make: () => webllm.CreateMLCEngine(model, config, opts) },
    ];

    let engine = null;
    let lastErr = null;
    for (const { name, make } of paths) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try { engine = await make(); break; }
        catch (err) {
          lastErr = err;
          console.warn(`[${tstamp()} webllm] ${name} load failed (attempt ${attempt}/3) — ${errText(err)}`);
          if (!TRANSIENT.test(errText(err))) break;
          on.status?.(`weight fetch dropped — retry ${attempt} of 3`);
        }
      }
      if (engine) {
        console.log(`[${tstamp()} webllm] engine on the ${name}` +
          (name === "web worker" ? " — main thread stays free" : " — the tab freezes while it decodes"));
        break;
      }
      console.warn(`[${tstamp()} webllm] ${name} path gave up — ${errText(lastErr)}`);
    }
    // Only a cache refusal (often an extension) is worth another whole load:
    // the backend belongs to the engine's appConfig, since CreateMLCEngine
    // takes (model, engineConfig, chatOpts) and ignores anything after that.
    if (!engine && /cache/i.test(errText(lastErr))) {
      on.status?.("cache refused the weights — trying IndexedDB");
      console.warn(`[${tstamp()} webllm] Cache API keeps failing — falling back to IndexedDB cache`);
      const indexedConfig = {
        ...config,
        appConfig: { ...webllm.prebuiltAppConfig, cacheBackend: "indexeddb" },
      };
      try { engine = await webllm.CreateMLCEngine(model, indexedConfig, opts); }
      catch (err) { console.warn(`[${tstamp()} webllm] IndexedDB cache failed too — ${errText(err)}`); }
    }
    if (!engine) throw new Error(`WebLLM could not load ${model} — ${errText(lastErr)}`);
    console.log(`[${tstamp()} webllm] engine load: ${model}: ${(performance.now() - loadT0).toFixed(0)}ms`);
    engines.set(model, engine);
    return engine;
  }

  /** Console report on WebLLM's cache stores; returns how many of the model's
      weight shards are already cached (-1 if uninspectable). Never throws. */
  async function webllmCacheReport(model) {
    try {
      const est = (await navigator.storage?.estimate?.()) || {};
      const persisted = await navigator.storage?.persisted?.().catch(() => "?");
      console.log(
        `[${tstamp()} webllm] origin ${location.origin} · storage: ${((est.usage || 0) / 1e9).toFixed(2)} GB used ` +
        `of ${((est.quota || 0) / 1e9).toFixed(1)} GB quota · persisted: ${persisted}`,
      );
      const stores = (await caches.keys()).filter((s) => s.startsWith("webllm/"));
      console.log(`[${tstamp()} webllm] cache stores: ${stores.join(", ") || "(none yet)"}`);
      let shards = 0;
      for (const name of stores) {
        const entries = await (await caches.open(name)).keys();
        const mine = name === "webllm/model" ? entries.filter((r) => r.url.includes(model)) : [];
        shards += mine.length;
        console.log(`[${tstamp()} webllm] ${name}: ${entries.length} entr${entries.length === 1 ? "y" : "ies"}${mine.length ? ` (${mine.length} for ${model})` : ""}`);
      }
      console.log(shards
        ? `[${tstamp()} webllm] ${model}: ${shards} shard(s) cached — load should read from disk, not the network`
        : `[${tstamp()} webllm] ${model}: nothing cached on this origin — this load downloads`);
      return shards;
    } catch (err) {
      console.warn(`[${tstamp()} webllm] cache inspection failed: ${err.message}`);
      return -1;
    }
  }

  // MLC builds are text-only; images collapse to a note.
  function flattenImages(wire) {
    const NOTE = "[a picture was attached here; this local model cannot see images]";
    for (const m of wire) {
      if (!Array.isArray(m.content)) continue;
      const text = m.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
      const hadImage = m.content.some((c) => c.type === "image_url");
      m.content = hadImage ? (text ? `${text}\n${NOTE}` : NOTE) : text;
    }
    return wire;
  }

  const CALL_OPEN = "<tool_call>", CALL_CLOSE = "</tool_call>";
  const THINK_OPEN = "<think>", THINK_CLOSE = "</think>";

  function toolProtocol(tools) {
    return [
      "## Tools",
      "",
      "You run tools. Schemas:",
      "",
      "<tools>",
      JSON.stringify(tools.map((t) => ({
        name: t.name, description: t.description, parameters: t.input_schema,
      }))),
      "</tools>",
      "",
      "To run tools, reply with exactly this shape — one JSON object per block — and",
      "then end your turn. Never write a <tool_response> yourself; never guess a result:",
      "",
      "<tool_call>",
      '{"name": "tool_name", "arguments": {"param": "value"}}',
      "</tool_call>",
      "",
      "Every result arrives in the next user message, wrapped:",
      "",
      "<tool_response>",
      '{"id": "...", "name": "...", "output": "..."}',
      "</tool_response>",
      "",
      "No tool needed? Answer in plain prose with no blocks. Several independent calls",
      "belong in one turn, each in its own <tool_call> block. Reason briefly — long",
      "deliberation costs the user real time on a small in-tab model.",
    ].join("\n");
  }

  /** Re-expresses the shared wire form for the bridge: results as
      <tool_response> user turns, calls as <tool_call> blocks, strict
      role alternation. */
  function bridgeWire(wire) {
    const flat = [];
    for (const m of wire) {
      if (m.role === "tool") {
        flat.push({ role: "user", content: [
          "<tool_response>",
          JSON.stringify({ id: m.tool_call_id, name: m.name, output: m.content }),
          "</tool_response>",
        ].join("\n") });
      } else if (m.role === "assistant" && m.tool_calls?.length) {
        const blocks = m.tool_calls.map((c) =>
          `<tool_call>\n{"name": ${JSON.stringify(c.function.name)}, "arguments": ${c.function.arguments}}\n</tool_call>`
        ).join("\n");
        flat.push({ role: "assistant", content: [m.content, blocks].filter(Boolean).join("\n") });
      } else {
        flat.push(m);
      }
    }
    // Results and any follow-up text can land in adjacent user turns; the chat
    // template wants strict alternation, so fold them together.
    const out = [];
    for (const m of flat) {
      const last = out[out.length - 1];
      if (m.role === "user" && last && last.role === "user") last.content += `\n\n${m.content}`;
      else out.push(m);
    }
    return out;
  }

  /** Splits the raw stream live: <think> → on.thinking, <tool_call> blocks
      collected, prose → on.text; tag tails are held back until resolved. */
  function toolStreamFilter(on) {
    let mode = "text";             // text | think | call
    let buf = "";
    let callJson = "";
    let clean = "";
    const calls = [];
    const TAGS = [THINK_OPEN, THINK_CLOSE, CALL_OPEN, CALL_CLOSE];

    function spill(final) {
      while (buf) {
        let at = -1, tag = null;
        for (const t of TAGS) {
          const i = buf.indexOf(t);
          if (i !== -1 && (at === -1 || i < at)) { at = i; tag = t; }
        }
        if (at === -1) {
          let keep = 0;
          if (!final) {
            for (let len = Math.min(buf.length, CALL_CLOSE.length - 1); len > 0; len--) {
              if (TAGS.some((t) => t.startsWith(buf.slice(-len)))) { keep = len; break; }
            }
          }
          if (!final && keep >= buf.length) return;   // it may yet become a tag
          const out = final ? buf : buf.slice(0, buf.length - keep);
          buf = final ? "" : buf.slice(out.length);
          if (mode === "text") { clean += out; on.text?.(out); }
          else if (mode === "think") on.thinking?.(out);
          else { callJson += out; on.thinking?.(out); }   // visible while it builds
          return;
        }
        const before = buf.slice(0, at);
        if (mode === "text") { clean += before; on.text?.(before); }
        else if (mode === "think") on.thinking?.(before);
        else { callJson += before; on.thinking?.(before); }
        buf = buf.slice(at + tag.length);
        if (tag === CALL_OPEN) { mode = "call"; callJson = ""; on.status?.("receiving a tool call"); }
        else if (tag === CALL_CLOSE) { calls.push(callJson.trim()); mode = "text"; callJson = ""; }
        else if (tag === THINK_OPEN) mode = "think";
        else mode = "text";
      }
    }

    return {
      push(chunk) { buf += chunk; spill(false); },
      end() {
        spill(true);
        // Cut off mid-call: hand back the fragment anyway — the tool fails
        // loudly, and the error teaches the next turn.
        if (mode === "call" && callJson.trim()) calls.push(callJson.trim());
        return {
          clean,
          calls: calls.map((raw) => {
            const parsed = safeJson(raw);
            return { name: parsed.name || "", input: parsed.arguments ?? parsed.parameters ?? {} };
          }).filter((c) => c.name),
        };
      },
    };
  }

  /** `promise`, but STOP rejects the wait immediately. The work carries on —
      a weight download cannot be cancelled and its bytes are worth keeping —
      so the turn ends now and the next send joins the load in progress. */
  function abortable(promise, signal) {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(new DOMException("aborted", "AbortError"));
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(new DOMException("aborted", "AbortError"));
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
  }

  async function webllm({ model, system, messages, tools, signal, on }) {
    const engine = await abortable(webllmEngine(model, on), signal);
    on.status?.("generating");   // clears the load bar once the engine is up
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    const bridged = tools.length > 0;
    const protocol = bridged ? toolProtocol(tools) : "";
    const systemText = [system, protocol].filter(Boolean).join("\n\n");
    if (protocol) {
      console.log(`[${tstamp()} webllm] protocol ≈ ${(protocol.length / 1024).toFixed(1)} KB · ${tools.length} tool(s)`);
    }
    const wire = bridgeWire(flattenImages(toWire(systemText, messages, true)));
    const body = {
      messages: wire,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: Math.min(4096, Math.floor(webllmWindow(model) / 2)),
      extra_body: { enable_thinking: false },
    };

    console.log(`[${tstamp()} webllm] prompt ≈ ${(JSON.stringify(wire).length / 1024).toFixed(0)} KB over ${wire.length} message(s)`);
    on.status?.("prefilling the prompt — first token may take a moment");

    // interruptGenerate is the engine's stop button.
    const abort = () => engine.interruptGenerate();
    signal?.addEventListener("abort", abort, { once: true });

    let text = "";
    let rawContent = "";
    const usage = { input: 0, output: 0 };
    let lastUsage = null;
    let stopReason = null;
    const filter = bridged ? toolStreamFilter(on) : null;
    let firstToken = 0, chunkCount = 0, thinkTok = 0;
    const t0 = performance.now();
    // Heartbeat for silent stretches (prefill, stalls).
    const beat = setInterval(() => {
      console.log(`[${tstamp()} webllm] …alive: ${chunkCount} chunk(s), ${((performance.now() - t0) / 1000).toFixed(0)}s${firstToken ? "" : " — still prefilling"}`);
    }, 5000);
    try {
      const stream = await engine.chat.completions.create(body);
      for await (const chunk of stream) {
        chunkCount++;
        if (chunk.usage) {
          usage.input = chunk.usage.prompt_tokens || usage.input;
          usage.output = chunk.usage.completion_tokens || usage.output;
          lastUsage = chunk.usage;
        }
        const choice = chunk.choices?.[0];
        const delta = choice?.delta || {};
        if ((delta.content || delta.reasoning_content) && !firstToken) {
          firstToken = performance.now();
          console.log(`[${tstamp()} webllm] first token after ${((firstToken - t0) / 1000).toFixed(1)}s`);
        }
        if (delta.reasoning_content) {
          thinkTok++;
          if (thinkTok === 300) console.log(`[${tstamp()} webllm] thinking past 300 tok — the pace prompt is being ignored`);
          on.thinking?.(delta.reasoning_content);
        }
        if (delta.content) {
          rawContent += delta.content;
          if (filter) filter.push(delta.content);
          else { text += delta.content; on.text?.(delta.content); }
        }
        if (choice?.finish_reason) stopReason = choice.finish_reason;
      }
    } finally {
      clearInterval(beat);
      signal?.removeEventListener("abort", abort);
    }

    if (firstToken) {
      console.log(`[${tstamp()} webllm] stream done: ${chunkCount} chunk(s), ${((performance.now() - t0) / 1000).toFixed(1)}s total` +
        `, decode ≈ ${chunkCount / ((performance.now() - firstToken) / 1000 || 1)} chunk/s`);
    }

    // An abort mid-stream ends the iteration cleanly, so the truncated text
    // would otherwise look like a finished reply — and agent.js would commit
    // it and run its tool calls. Refuse it here instead.
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");

    // KV-reuse probe, second half: what we will store as `raw` is exactly what
    // the next request resends as the assistant turn, so it must byte-match
    // what the engine stored. A mismatch here is a full re-prefill next step.
    try {
      const stored = await engine.getMessage();
      if (rawContent === stored) {
        console.log(`[${tstamp()} webllm] PROBE ✓ raw byte-equals getMessage() (${rawContent.length} chars)`);
      } else {
        let i = 0;
        while (i < Math.min(rawContent.length, stored.length) && rawContent[i] === stored[i]) i++;
        console.log(`[${tstamp()} webllm] PROBE ✗ raw ≠ getMessage() — raw ${rawContent.length} ch, stored ${stored.length} ch, first diff at ${i}`);
        console.log(`[${tstamp()} webllm]   raw    = ${JSON.stringify(rawContent.slice(Math.max(0, i - 20), i + 40))}`);
        console.log(`[${tstamp()} webllm]   stored = ${JSON.stringify(stored.slice(Math.max(0, i - 20), i + 40))}`);
      }
    } catch (_) { /* getMessage unavailable — probe only */ }

    // Speed from the final chunk's usage block — `extra` carries the engine's
    // own measured rates. (runtimeStatsText() is deprecated; never call it.)
    const speed = lastUsage?.extra || {};
    const rate = (v) => (typeof v === "number" ? v.toFixed(1) : "?");
    console.log(
      `[${tstamp()} webllm] ${model} · prefill ${rate(speed.prefill_tokens_per_s)} tok/s · ` +
      `decode ${rate(speed.decode_tokens_per_s)} tok/s · ` +
      `${usage.input} tok in / ${usage.output} tok out` + (thinkTok ? ` · think ≈${thinkTok} tok` : ""),
    );

    let parts;
    if (filter) {
      const done = filter.end();
      parts = done.clean ? [{ type: "text", text: done.clean }] : [];
      // Call order is meaningful; ids only need to survive the round trip.
      done.calls.forEach((c, i) => {
        parts.push({ type: "tool_use", id: `call_${Date.now()}_${i}`, name: c.name, input: c.input });
      });
    } else {
      parts = text ? [{ type: "text", text }] : [];
    }

    usage.think = thinkTok;
    // What the engine generated, byte for byte: with thinking disabled the
    // stored conversation holds exactly this string, so sending it back
    // verbatim (see toWire) is what lets the KV cache be reused across steps.
    return { parts, stopReason, usage, raw: rawContent || undefined };
  }

  /* ── Google ─────────────────────────────────────────────────────────────── */

  async function google({ model, apiKey, system, messages, tools, effort, signal, on }) {
    const contents = messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      // flatMap, because a tool result carrying pictures becomes a
      // functionResponse plus one inlineData part per picture: Gemini's
      // functionResponse holds JSON only, so the bytes sit beside it in the
      // same turn rather than inside it.
      parts: m.parts.flatMap((p) => {
        if (p.type === "text") return [{ text: p.text }];
        if (p.type === "image") return [{ inlineData: { mimeType: p.mediaType, data: p.data } }];
        if (p.type === "thinking") return [{ text: p.text }];
        if (p.type === "tool_use") return [{ functionCall: { name: p.name, args: p.input ?? {} } }];
        const response = {
          functionResponse: {
            name: p.name,
            response: p.error ? { error: p.output } : { output: p.output },
          },
        };
        if (!(p.shots && p.shots.length)) return [response];
        return [
          response,
          ...p.shots.map((s) => ({ inlineData: { mimeType: s.mediaType, data: s.data } })),
          { text: `The image(s) above are the result of the ${p.name} call above.` },
        ];
      }),
    }));

    const body = { contents };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    if (tools.length) {
      body.tools = [{
        functionDeclarations: tools.map((t) => {
          const params = geminiSchema(t.input_schema);
          const decl = { name: t.name, description: t.description };
          // An empty properties object is rejected; omit parameters instead.
          if (params?.properties && Object.keys(params.properties).length) decl.parameters = params;
          return decl;
        }),
      }];
    }

    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}` +
      `:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url, {
      method: "POST", headers: { "content-type": "application/json" }, signal, body: JSON.stringify(body),
    });
    if (!res.ok) await fail(res, "google");

    let text = "";
    const calls = [];
    const usage = { input: 0, output: 0 };
    let stopReason = null;

    for await (const event of sse(res)) {
      const candidate = event.candidates?.[0];
      if (event.usageMetadata) {
        usage.input = event.usageMetadata.promptTokenCount || usage.input;
        usage.output = event.usageMetadata.candidatesTokenCount || usage.output;
      }
      if (candidate?.finishReason) stopReason = candidate.finishReason;
      for (const part of candidate?.content?.parts || []) {
        if (part.functionCall) {
          calls.push(part.functionCall);
          on.toolStart?.(part.functionCall.name);
        } else if (typeof part.text === "string") {
          if (part.thought) on.thinking?.(part.text);
          else { text += part.text; on.text?.(part.text); }
        }
      }
    }

    const ready = calls.map((c, i) => ({
      id: `${c.name}_${Date.now()}_${i}`, name: c.name, input: c.args || {},
    }));
    return { parts: flatParts(text, ready), stopReason, usage };
  }

  function safeJson(raw) {
    if (!raw || !raw.trim()) return {};
    try { return JSON.parse(raw); } catch (_) { return { __unparsed: raw }; }
  }

  const ADAPTERS = { anthropic, google, chat, webllm };

  /* ── key validation ─────────────────────────────────────────────────────────
     Each vendor has a model-listing endpoint that costs no tokens, so the KEYS
     panel can prove a key works before the first real turn instead of failing
     mid-build. A rejection here is the truth about the key; a network error is
     the truth about CORS or connectivity, and the two read differently.
     ------------------------------------------------------------------------- */

  const PROBES = {
    anthropic: (key) => ["https://api.anthropic.com/v1/models?limit=1", {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    }],
    google: (key) => [
      `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1&key=${encodeURIComponent(key)}`, {},
    ],
    // A gateway's /models is often public, so ask about the key itself where the
    // vendor offers that; otherwise listing models still proves authorisation.
    chat: (key, base, spec) => [
      `${base}/${spec.probe || "models"}`,
      key ? { authorization: `Bearer ${key}` } : {},
    ],
  };

  /** Resolve `{ok:true}` when the vendor accepts the key, `{ok:false, error}` otherwise. */
  async function validate({ provider, apiKey, baseUrl, signal }) {
    let spec, key, base;
    try { ({ spec, key, base } = resolve({ provider, apiKey, baseUrl })); }
    catch (err) { return { ok: false, error: err.message }; }
    // WebLLM's "server" is this tab — validate the GPU, not a network.
    if (spec.api === "webllm") {
      if (!navigator.gpu) {
        console.log(`[${tstamp()} webllm] validate: no navigator.gpu on this browser`);
        return {
          ok: false,
          error: "this browser has no WebGPU — WebLLM needs Chrome, Edge, Safari 26+, " +
                 "or Firefox with WebGPU, and a machine that can run the model",
        };
      }
      try {
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) {
          console.log(`[${tstamp()} webllm] validate: WebGPU present but requestAdapter() → null`);
          return {
            ok: false,
            error: "WebGPU is present but no GPU adapter is available — check chrome://gpu, " +
                   "the GPU may be blocklisted or the drivers too old",
          };
        }
        const info = adapter.info || {};
        console.log(`[${tstamp()} webllm] validate: WebGPU ok — GPU ${info.vendor || "?"} ${info.architecture || ""} ${info.device || ""} (maxBuffer ${adapter.limits?.maxBufferSize / 1e9 || "?"} GB)`);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: `WebGPU probe failed: ${err.message || err}` };
      }
    }
    const [url, headers] = PROBES[spec.api](key, base, spec);
    try {
      const res = await fetch(url, { headers, signal });
      if (res.ok) return { ok: true };
      await fail(res, provider);
    } catch (err) {
      if (err.name === "AbortError") throw err;
      if (err instanceof TypeError) {
        return {
          ok: false,
          error: spec.keyless
            ? `${provider} unreachable at ${base} (${err.message}) — start the server and allow this origin, ` +
              (provider === "ollama"
                ? `e.g. OLLAMA_ORIGINS='${location.origin}' ollama serve`
                : `e.g. vllm serve <model> --allowed-origins '["${location.origin}"]'`)
            : `${provider} unreachable from this tab (${err.message}) — offline, or the vendor refuses cross-origin browser calls`,
        };
      }
      return { ok: false, error: String(err.message || err) };
    }
  }

  return {
    providers: MODELS,
    defaultModel: (provider) => MODELS[provider]?.models[0] || "",
    /** Endpoint base for the providers that have one; "" for the rest. */
    defaultUrl: (provider) => MODELS[provider]?.url || "",
    /** Fixed engine window for in-tab models; 0 = bounded by the vendor. */
    contextWindow: (provider, model) => {
      const spec = MODELS[provider] || {};
      if (model && spec.windows && spec.windows[model]) return spec.windows[model];
      return spec.contextWindow || 0;
    },
    cleanKey,
    validate,

    /**
     * One assistant turn, streamed.
     * @returns {Promise<{parts: object[], stopReason: string|null, usage: {input:number,output:number}}>}
     */
    complete({ provider, model, apiKey, baseUrl, system, messages, tools = [], effort = "high", signal, on = {} }) {
      const { spec, key, base } = resolve({ provider, apiKey, baseUrl });
      if (!model) throw new Error(`${provider}: no model name — type one in the KEYS panel`);
      return ADAPTERS[spec.api]({
        provider, baseUrl: base, model, apiKey: key, system, messages, tools, effort, signal, on,
      });
    },
  };
})();
