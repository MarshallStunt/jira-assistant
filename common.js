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
  autoRun: true,       // analyze automatically when a Jira issue opens
  serverField: "",     // optional Jira field name/id holding the server name
  locationField: "",   // optional Jira field name/id holding the location
  teamContext: "",     // runbooks / team notes appended to the prompt
  customInstructions: "", // extra free-form instructions added to every prompt
  pingAuto: true,      // ping the server's IP addresses automatically when a brief is shown
  bmcUrl: "https://{ip}", // how to open a BMC web UI; {ip} is replaced
  netboxEnabled: true,
  netboxUrl: "https://netbox.prod.lambdalabs.cloud",
  netboxToken: "",     // optional; by default your NetBox browser login is used
  podcrawlerUrl: "https://podcrawler.aws.lambdalabs.cloud/#/racking",
  podcrawlerStep: true // add a "rescan in Podcrawler" step to replacement tickets
};

async function getSettings() {
  const stored = await chrome.storage.local.get([...Object.keys(DEFAULTS), "apiKey", "model"]);
  const s = { ...DEFAULTS, ...stored, models: { ...(stored.models || {}) } };
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
    case "anthropic": return s.anthropicKey ? "" : "Add your Anthropic API key in Settings (⚙).";
    case "openai":    return s.openaiKey ? "" : "Add your OpenAI API key in Settings (⚙).";
    case "gemini":    return s.geminiKey ? "" : "Add your Gemini API key in Settings (⚙).";
    case "local":     return s.localBaseUrl ? "" : "Set your local server URL in Settings (⚙).";
    default:          return "Choose an AI provider in Settings (⚙).";
  }
}

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
  const prefer = { anthropic: /sonnet/i, openai: /^gpt/i, gemini: /flash(?!.*lite)/i, local: /./ }[s.provider];
  const pick = models.find((m) => prefer.test(m.id)) || models[0];
  const stored = (await chrome.storage.local.get("models")).models || {};
  await chrome.storage.local.set({ models: { ...stored, [s.provider]: pick.id } });
  return pick.id;
}

// ---------- Structured generation ----------
// schema: JSON Schema (object). Returns { result, model }.

async function generateStructured(s, { system, user, schema, schemaName }) {
  const model = await resolveModel(s);
  let result;
  switch (s.provider) {
    case "anthropic": result = await callAnthropic(s, model, system, user, schema, schemaName); break;
    case "openai":    result = await callOpenAICompatible("https://api.openai.com/v1", s.openaiKey, model, system, user, schema, schemaName, false); break;
    case "gemini":    result = await callGemini(s, model, system, user, schema); break;
    case "local":     result = await callOpenAICompatible(trimSlash(s.localBaseUrl), s.localApiKey, model, system, user, schema, schemaName, true); break;
    default: throw new Error(`Unknown provider: ${s.provider}`);
  }
  return { result, model };
}

async function callAnthropic(s, model, system, user, schema, name) {
  const j = await httpJson("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: anthropicHeaders(s.anthropicKey),
    body: JSON.stringify({
      model,
      max_tokens: 4000,
      system,
      tools: [{ name, description: "Report the structured analysis.", input_schema: schema }],
      tool_choice: { type: "tool", name },
      messages: [{ role: "user", content: user }]
    })
  });
  const block = (j.content || []).find((b) => b.type === "tool_use");
  if (!block) throw new Error("Claude did not return a structured result.");
  return block.input;
}

async function callOpenAICompatible(base, key, model, system, user, schema, name, isLocal) {
  const messages = [
    { role: "system", content: `${system}\n\nRespond ONLY with a JSON object matching this schema:\n${JSON.stringify(schema)}` },
    { role: "user", content: user }
  ];
  const body = { model, messages };
  if (isLocal) body.max_tokens = 4000;
  else body.max_completion_tokens = 16000; // reasoning models spend tokens on thinking

  const formats = [
    { type: "json_schema", json_schema: { name, strict: true, schema: strictify(schema) } },
    { type: "json_object" },
    null // last resort for local servers without structured-output support
  ];

  let lastErr;
  for (const fmt of isLocal ? formats : formats.slice(0, 1)) {
    const payload = { ...body };
    if (fmt) payload.response_format = fmt;
    try {
      const j = await httpJson(`${base}/chat/completions`, {
        method: "POST",
        headers: openaiHeaders(key),
        body: JSON.stringify(payload)
      });
      const msg = j.choices?.[0]?.message;
      if (msg?.refusal) throw new Error(`Model refused: ${msg.refusal}`);
      return parseJsonLoose(msg?.content);
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
  const j = await httpJson(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": s.geminiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: toGeminiSchema(schema),
        maxOutputTokens: 16000
      }
    })
  });
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
      const j = await httpJson("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: anthropicHeaders(s.anthropicKey),
        body: JSON.stringify({ model, max_tokens: maxTokens, system, messages })
      });
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
      const j = await httpJson(`${base}/chat/completions`, {
        method: "POST",
        headers: openaiHeaders(isLocal ? s.localApiKey : s.openaiKey),
        body: JSON.stringify(body)
      });
      text = j.choices?.[0]?.message?.content || "";
      break;
    }
    case "gemini": {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
      const j = await httpJson(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": s.geminiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
          generationConfig: { maxOutputTokens: maxTokens * 4 }
        })
      });
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
