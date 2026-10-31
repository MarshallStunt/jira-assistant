// Shared settings + AI provider adapters (used by side panel and options page).

const PROVIDERS = {
  anthropic: { label: "Anthropic (Claude)" },
  openai:    { label: "OpenAI" },
  gemini:    { label: "Google Gemini" },
  local:     { label: "Local (LM Studio / Ollama)" }
};

const LOCAL_PRESETS = {
  lmstudio: "http://localhost:1234/v1",
  ollama: "http://localhost:11434/v1"
};

const DEFAULTS = {
  provider: "anthropic",
  anthropicKey: "",
  openaiKey: "",
  geminiKey: "",
  localBaseUrl: LOCAL_PRESETS.lmstudio,
  localApiKey: "",
  models: {},          // { anthropic: "...", openai: "...", gemini: "...", local: "..." }
  jiraHosts: [],       // extra self-hosted Jira hostnames, e.g. ["jira.example.com"]
  speed: "fast",       // fast | balanced | thorough: how long the model may think before answering
  privacyMode: false,  // swap sensitive values for placeholders before sending anything to the AI
  privacyHide: { people: true, contact: true, network: true, serials: true },
  privacyWords: "",    // extra words to hide (customer names, project codes), one per line
  autoRun: true,       // analyze automatically when a Jira issue opens
  serverField: "",     // optional Jira field name/id holding the server name
  locationField: "",   // optional Jira field name/id holding the location
  teamContext: "",     // runbooks / team notes appended to the prompt
  customInstructions: "", // extra free-form instructions added to every prompt
  pingAuto: true,      // ping the server's IP addresses automatically when a brief is shown
  bmcUrl: "https://{ip}", // how to open a BMC web UI; {ip} is replaced
  opVault: "",         // 1Password vault holding BMC logins (blank = all vaults)
  opAccount: "",       // 1Password account, only needed if you're signed in to several
  opTag: "",           // only consider items with this tag, e.g. "bmc"
  opFallbackItem: "",  // item to use when no item matches the BMC IP / hostname / serial
  bmcLogin: "paste",   // BMC password for Check health: "paste" (user pastes it) or "1password" (CLI)
  bmcUser: "ADMIN",
  bmcHealthAuto: false, // read BMC health automatically (1Password CLI mode; may show a 1Password prompt)
  netboxEnabled: true,
  netboxUrl: "https://netbox.prod.lambdalabs.cloud",
  netboxToken: "",     // optional; by default your NetBox browser login is used
  podcrawlerUrl: "https://podcrawler.aws.lambdalabs.cloud/#/racking",
  podcrawlerStep: true // add a "rescan in Podcrawler" step to replacement tickets
};

async function getSettings() {
  const stored = await chrome.storage.local.get([...Object.keys(DEFAULTS), "apiKey", "model"]);
  const s = { ...DEFAULTS, ...stored, models: { ...(stored.models || {}) }, privacyHide: { ...DEFAULTS.privacyHide, ...(stored.privacyHide || {}) } };
  // Migrate settings from v1 (Anthropic only).
  if (!s.anthropicKey && stored.apiKey) s.anthropicKey = stored.apiKey;
  if (!s.models.anthropic && stored.model) s.models.anthropic = stored.model;
  return s;
}

function providerLabel(id) {
  return PROVIDERS[id]?.label || id;
}

// Returns a human-readable problem if the provider isn't configured, else "".
function missingConfig(s) {
  switch (s.provider) {
    case "anthropic": return s.anthropicKey ? "" : "Add your Anthropic API key in Settings (⚙). No key yet? Settings → Getting started shows how to get one from IT.";
    case "openai":    return s.openaiKey ? "" : "Add your OpenAI API key in Settings (⚙). No key yet? Settings → Getting started shows how to get one from IT.";
    case "gemini":    return s.geminiKey ? "" : "Add your Gemini API key in Settings (⚙). No key yet? Settings → Getting started shows how to get one from IT.";
    case "local":     return s.localBaseUrl ? "" : "Set your local server URL in Settings (⚙).";
    default:          return "Choose an AI provider in Settings (⚙).";
  }
}

// Keyboard shortcuts as shown in hints (Mac vs Windows/Linux).
const IS_MAC = /mac/i.test(navigator.userAgentData?.platform || navigator.platform || "");
const IS_WIN = /win/i.test(navigator.userAgentData?.platform || navigator.platform || "");
const KEYS = IS_MAC
  ? { paste: "⌘V", quickAccess: "⌘⇧Space", slackSearch: "⌘K" }
  : { paste: "Ctrl+V", quickAccess: "Ctrl+Shift+Space", slackSearch: "Ctrl+K" };

// ---------- HTTP helpers ----------

async function httpJson(url, opts) {
  let res;
  try {
    res = await fetch(url, opts);
  } catch (e) {
    throw new Error(`Could not reach ${new URL(url).origin} (${e.message}). Is the server running?`);
  }
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`${new URL(url).host} ${res.status}: ${text.slice(0, 600)}`);
    err.status = res.status;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Unexpected non-JSON response from ${new URL(url).host}.`);
  }
}

function anthropicHeaders(key) {
  return {
    "x-api-key": key,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
    "anthropic-dangerous-direct-browser-access": "true"
  };
}

function openaiHeaders(key) {
  const h = { "content-type": "application/json" };
  if (key) h.authorization = `Bearer ${key}`;
  return h;
}

function trimSlash(u) {
  return (u || "").trim().replace(/\/+$/, "");
}

// Try request bodies in order and return the first one the API accepts. Newer options (effort, structured
// outputs, thinking settings) are rejected with a 400 by older models, so each attempt drops some of them.
async function postFirstAccepted(url, headers, bodies) {
  let lastErr;
  for (const body of bodies) {
    try {
      return await httpJson(url, { method: "POST", headers, body: JSON.stringify(body) });
    } catch (e) {
      lastErr = e;
      if (e.status !== 400) break;
    }
  }
  throw lastErr;
}

// Streaming version: POST each body until one is accepted, then call onEvent(json) for every
// server-sent event. Lets the panel show the brief while the AI is still writing it.
async function streamFirstAccepted(url, headers, bodies, onEvent) {
  let lastErr;
  for (const body of bodies) {
    let res;
    try {
      res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    } catch (e) {
      throw new Error(`Could not reach ${new URL(url).origin} (${e.message}). Is the server running?`);
    }
    if (!res.ok) {
      lastErr = new Error(`${new URL(url).host} ${res.status}: ${(await res.text()).slice(0, 600)}`);
      lastErr.status = res.status;
      if (res.status !== 400) break;
      continue;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const line of lines) {
        const data = line.startsWith("data:") ? line.slice(5).trim() : "";
        if (!data || data === "[DONE]") continue;
        let ev;
        try { ev = JSON.parse(data); } catch { continue; }
        onEvent(ev);
      }
    }
    return;
  }
  throw lastErr;
}

// Best-effort parse of a JSON object that is still being streamed: closes open strings, arrays and
// objects, dropping a half-written key/value at the end. Returns null if nothing usable yet.
function parsePartialJson(text) {
  const t = String(text || "");
  let s = t.slice(Math.max(0, t.indexOf("{")));
  if (!s.startsWith("{")) return null;
  for (let tries = 0; tries < 8 && s; tries++) {
    const closers = [];
    let inStr = false, esc = false, cut = 1;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === "{" || c === "[") { closers.push(c === "{" ? "}" : "]"); cut = i + 1; }
      else if (c === "}" || c === "]") closers.pop();
      else if (c === ",") cut = i;
    }
    const body = (inStr && !esc ? s + '"' : s).replace(/[\s,:]+$/, "");
    try {
      return JSON.parse(body + closers.reverse().join(""));
    } catch {
      s = s.slice(0, cut); // drop the incomplete tail and try again
    }
  }
  return null;
}

// Calls onPartial at most every 150 ms with the latest partial object.
function partialFeeder(onPartial) {
  let acc = "", last = 0;
  return {
    add(text) {
      acc += text;
      const now = Date.now();
      if (onPartial && now - last > 150) {
        last = now;
        const obj = parsePartialJson(acc);
        if (obj) onPartial(obj);
      }
    },
    get text() { return acc; }
  };
}

// "speed" setting → each provider's thinking knob. Less thinking = much faster; the brief is mostly extraction.
const EFFORT = { fast: "low", balanced: "medium", thorough: "high" };
const effortOf = (s) => EFFORT[s.speed] || "low";

function geminiThinking(model, s) {
  if (/gemini-2\.5/i.test(model)) return { thinkingBudget: { fast: /pro/i.test(model) ? 128 : 0, balanced: 1024, thorough: -1 }[s.speed] ?? 0 };
  return { thinkingLevel: effortOf(s) === "high" ? "high" : "low" };
}

// Pull a JSON object out of model text (handles ```json fences and <think> blocks).
function parseJsonLoose(text) {
  let t = String(text || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1];
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("The model did not return JSON. Try a stronger model.");
  return JSON.parse(t.slice(start, end + 1));
}

// ---------- Model listing ----------

async function listModels(s, provider = s.provider) {
  switch (provider) {
    case "anthropic": {
      const j = await httpJson("https://api.anthropic.com/v1/models?limit=100", { headers: anthropicHeaders(s.anthropicKey) });
      return (j.data || []).map((m) => ({ id: m.id, name: m.display_name || m.id }));
    }
    case "openai": {
      const j = await httpJson("https://api.openai.com/v1/models", { headers: openaiHeaders(s.openaiKey) });
      const skip = /(audio|realtime|transcribe|tts|image|dall-e|whisper|embedding|moderation|search|instruct|davinci|babbage|codex)/i;
      return (j.data || [])
        .filter((m) => /^(gpt|o\d|chatgpt)/i.test(m.id) && !skip.test(m.id))
        .sort((a, b) => (b.created || 0) - (a.created || 0))
        .map((m) => ({ id: m.id, name: m.id }));
    }
    case "gemini": {
      const j = await httpJson("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", {
        headers: { "x-goog-api-key": s.geminiKey }
      });
      return (j.models || [])
        .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent") && /gemini/i.test(m.name))
        .map((m) => ({ id: m.name.replace(/^models\//, ""), name: m.displayName || m.name }));
    }
    case "local": {
      const j = await httpJson(`${trimSlash(s.localBaseUrl)}/models`, { headers: openaiHeaders(s.localApiKey) });
      return (j.data || []).filter((m) => !/embed/i.test(m.id)).map((m) => ({ id: m.id, name: m.id }));
    }
  }
  return [];
}

// Use the chosen model, or pick a sensible default and remember it.
async function resolveModel(s) {
  const chosen = s.models[s.provider];
  if (chosen) return chosen;
  const models = await listModels(s);
  if (!models.length) {
    throw new Error(s.provider === "local"
      ? "No models found on your local server. Load/pull a model first."
      : "No models available for this API key.");
  }
  // Fast and accurate enough for a brief: newest Sonnet, a GPT "mini", Gemini Flash.
  const prefer = { anthropic: [/sonnet/i], openai: [/^gpt-\d[\w.]*-mini$/i, /^gpt/i], gemini: [/flash(?!.*lite)/i], local: [/./] }[s.provider];
  const pick = prefer.map((re) => models.find((m) => re.test(m.id))).find(Boolean) || models[0];
  const stored = (await chrome.storage.local.get("models")).models || {};
  await chrome.storage.local.set({ models: { ...stored, [s.provider]: pick.id } });
  return pick.id;
}

// ---------- Structured generation ----------
// schema: JSON Schema (object). Returns { result, model }.

// onPartial(obj) is called with the partly written result while the answer streams in (Claude, OpenAI, local).
async function generateStructured(s, { system, user, schema, schemaName, onPartial }) {
  const model = await resolveModel(s);
  let result;
  switch (s.provider) {
    case "anthropic": result = await callAnthropic(s, model, system, user, schema, schemaName, onPartial); break;
    case "openai":    result = await callOpenAICompatible(s, "https://api.openai.com/v1", s.openaiKey, model, system, user, schema, schemaName, false, onPartial); break;
    case "gemini":    result = await callGemini(s, model, system, user, schema); break;
    case "local":     result = await callOpenAICompatible(s, trimSlash(s.localBaseUrl), s.localApiKey, model, system, user, schema, schemaName, true, onPartial); break;
    default: throw new Error(`Unknown provider: ${s.provider}`);
  }
  return { result, model };
}

// Thinking fully off, where the model allows it: the brief is extraction, so thinking mostly adds wait time.
// (Claude Opus 5.5 / Fable always think; for them effort "low" is the only lever.)
function claudeThinkingOff(model) {
  if (/sonnet-5-5/i.test(model)) return { type: "between_tools" };
  if (/haiku-5|sonnet-5(?!-5)|opus-5(?!-5)|opus-4-[678]|sonnet-4-6/i.test(model)) return { type: "disabled" };
  return null;
}

async function callAnthropic(s, model, system, user, schema, name, onPartial) {
  // The system prompt is the same on every ticket, so cache it.
  const base = { model, stream: true, system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content: user }] };
  const format = { type: "json_schema", schema: strictify(schema) };
  const off = s.speed === "fast" || !s.speed ? claudeThinkingOff(model) : null;
  const bodies = [
    // Current models: structured output + low effort (+ thinking off). Claude 5.5 models reject forced tool calls.
    off && { ...base, max_tokens: 16000, thinking: off, output_config: { format, effort: effortOf(s) } },
    { ...base, max_tokens: 16000, output_config: { format, effort: effortOf(s) } },
    { ...base, max_tokens: 16000, output_config: { format } },
    // Older models: force a tool call to get JSON.
    { ...base, max_tokens: 4000, tools: [{ name, description: "Report the structured analysis.", input_schema: schema }], tool_choice: { type: "tool", name } }
  ].filter(Boolean);
  const out = partialFeeder(onPartial);
  let stop = "";
  await streamFirstAccepted("https://api.anthropic.com/v1/messages", anthropicHeaders(s.anthropicKey), bodies, (ev) => {
    if (ev.type === "content_block_delta") {
      if (ev.delta?.type === "text_delta") out.add(ev.delta.text);
      else if (ev.delta?.type === "input_json_delta") out.add(ev.delta.partial_json);
    } else if (ev.type === "message_delta") {
      stop = ev.delta?.stop_reason || stop;
    } else if (ev.type === "error") {
      throw new Error(`Claude: ${ev.error?.message || "stream error"}`);
    }
  });
  if (stop === "refusal") throw new Error("Claude declined to analyze this ticket. Try Re-analyze or another model.");
  if (!out.text.trim()) throw new Error("Claude did not return a structured result.");
  return parseJsonLoose(out.text);
}

async function callOpenAICompatible(s, base, key, model, system, user, schema, name, isLocal, onPartial) {
  const messages = [
    { role: "system", content: `${system}\n\nRespond ONLY with a JSON object matching this schema:\n${JSON.stringify(schema)}` },
    { role: "user", content: user }
  ];
  const body = { model, messages };
  if (isLocal) body.max_tokens = 4000;
  else body.max_completion_tokens = 16000; // reasoning models spend tokens on thinking
  const effort = !isLocal && /^(o\d|gpt-5)/i.test(model) ? effortOf(s) : null; // reasoning models only

  const formats = [
    { type: "json_schema", json_schema: { name, strict: true, schema: strictify(schema) } },
    { type: "json_object" },
    null // last resort for local servers without structured-output support
  ];

  const attempts = (isLocal ? formats : formats.slice(0, 1)).flatMap((fmt) => (effort ? [[fmt, effort], [fmt, null]] : [[fmt, null]]));
  let lastErr;
  for (const [fmt, eff] of attempts) {
    const payload = { ...body, stream: true };
    if (fmt) payload.response_format = fmt;
    if (eff) payload.reasoning_effort = eff;
    try {
      const out = partialFeeder(onPartial);
      let refusal = "";
      await streamFirstAccepted(`${base}/chat/completions`, openaiHeaders(key), [payload], (ev) => {
        const d = ev.choices?.[0]?.delta;
        if (d?.content) out.add(d.content);
        if (d?.refusal) refusal += d.refusal;
        if (ev.error) throw new Error(ev.error.message || "stream error");
      });
      if (refusal) throw new Error(`Model refused: ${refusal}`);
      return parseJsonLoose(out.text);
    } catch (e) {
      lastErr = e;
      if (!(e.status >= 400 && e.status < 500) || e.status === 401 || e.status === 403) break;
    }
  }
  if (isLocal && lastErr?.status === 403) {
    lastErr.message += "\n\nOllama blocks browser extensions by default. Set OLLAMA_ORIGINS=chrome-extension://* and restart Ollama.";
  }
  throw lastErr;
}

// OpenAI strict mode requires additionalProperties:false on every object.
function strictify(schema) {
  if (Array.isArray(schema)) return schema.map(strictify);
  if (!schema || typeof schema !== "object") return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) out[k] = strictify(v);
  if (out.type === "object") out.additionalProperties = false;
  return out;
}

// Gemini uses an OpenAPI-style schema subset with upper-case types.
function toGeminiSchema(schema) {
  if (!schema || typeof schema !== "object") return schema;
  const out = {};
  if (schema.type) out.type = String(schema.type).toUpperCase();
  if (schema.description) out.description = schema.description;
  if (schema.enum) out.enum = schema.enum;
  if (schema.required) out.required = schema.required;
  if (schema.items) out.items = toGeminiSchema(schema.items);
  if (schema.properties) {
    out.properties = {};
    for (const [k, v] of Object.entries(schema.properties)) out.properties[k] = toGeminiSchema(v);
    out.propertyOrdering = Object.keys(schema.properties);
  }
  return out;
}

async function callGemini(s, model, system, user, schema) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig: { responseMimeType: "application/json", responseSchema: toGeminiSchema(schema), maxOutputTokens: 16000 }
  };
  const j = await postFirstAccepted(url, { "content-type": "application/json", "x-goog-api-key": s.geminiKey }, [
    { ...body, generationConfig: { ...body.generationConfig, thinkingConfig: geminiThinking(model, s) } },
    body
  ]);
  const cand = j.candidates?.[0];
  const text = (cand?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || "").join("");
  if (!text) throw new Error(`Gemini returned no content${cand?.finishReason ? ` (${cand.finishReason})` : ""}.`);
  return parseJsonLoose(text);
}

// ---------- Free-text chat ----------
// messages: [{ role: "user" | "assistant", content: "..." }]. Returns { text, model }.

async function generateText(s, { system, messages, maxTokens = 2000 }) {
  const model = await resolveModel(s);
  let text = "";
  switch (s.provider) {
    case "anthropic": {
      const base = { model, system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }], messages };
      const j = await postFirstAccepted("https://api.anthropic.com/v1/messages", anthropicHeaders(s.anthropicKey), [
        { ...base, max_tokens: maxTokens * 4, output_config: { effort: effortOf(s) } }, // room for thinking
        { ...base, max_tokens: maxTokens }
      ]);
      text = (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
      break;
    }
    case "openai":
    case "local": {
      const isLocal = s.provider === "local";
      const base = isLocal ? trimSlash(s.localBaseUrl) : "https://api.openai.com/v1";
      const body = { model, messages: [{ role: "system", content: system }, ...messages] };
      if (isLocal) body.max_tokens = maxTokens;
      else body.max_completion_tokens = maxTokens * 4; // reasoning models think first
      const reasoning = !isLocal && /^(o\d|gpt-5)/i.test(model);
      const j = await postFirstAccepted(`${base}/chat/completions`, openaiHeaders(isLocal ? s.localApiKey : s.openaiKey),
        reasoning ? [{ ...body, reasoning_effort: effortOf(s) }, body] : [body]);
      text = j.choices?.[0]?.message?.content || "";
      break;
    }
    case "gemini": {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
      const body = {
        systemInstruction: { parts: [{ text: system }] },
        contents: messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
        generationConfig: { maxOutputTokens: maxTokens * 4 }
      };
      const j = await postFirstAccepted(url, { "content-type": "application/json", "x-goog-api-key": s.geminiKey }, [
        { ...body, generationConfig: { ...body.generationConfig, thinkingConfig: geminiThinking(model, s) } },
        body
      ]);
      text = (j.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || "").join("");
      break;
    }
    default:
      throw new Error(`Unknown provider: ${s.provider}`);
  }
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  if (!text) throw new Error("The AI returned an empty answer.");
  return { text, model };
}
