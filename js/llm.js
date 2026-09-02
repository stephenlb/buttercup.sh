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
   dependency on someone else's uptime.
   ═══════════════════════════════════════════════════════════════════════════ */
window.LLM = (function () {

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

  async function chat({ provider, baseUrl, model, apiKey, system, messages, tools, effort, signal, on }) {
    const effortKnob = MODELS[provider]?.effortKnob;
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
          wire.push({ role: "tool", tool_call_id: r.id, content: r.error ? `error: ${r.output}` : r.output });
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

  const ADAPTERS = { anthropic, google, chat };

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
