const $ = (id) => document.getElementById(id);
let models = {}; // per-provider chosen model, edited in this form before saving

function showMsg(text, isError = false) {
  $("msg").textContent = text;
  $("msg").style.color = isError ? "var(--err)" : "";
}

function ensureModelOption(id, label) {
  if (!id || [...$("model").options].some((o) => o.value === id)) return;
  const opt = document.createElement("option");
  opt.value = id;
  opt.textContent = label || id;
  $("model").appendChild(opt);
}

function resetModelSelect(selected) {
  $("model").innerHTML = '<option value="">Auto</option>';
  ensureModelOption(selected);
  $("model").value = selected || "";
}

function showProvider(p) {
  document.querySelectorAll(".provider-box").forEach((el) => {
    el.classList.toggle("hidden", el.dataset.provider !== p);
  });
  resetModelSelect(models[p]);
}

// Read the form into a settings object (without saving).
function formSettings() {
  return {
    provider: $("provider").value,
    anthropicKey: $("anthropicKey").value.trim(),
    openaiKey: $("openaiKey").value.trim(),
    geminiKey: $("geminiKey").value.trim(),
    localBaseUrl: $("localBaseUrl").value.trim(),
    localApiKey: $("localApiKey").value.trim(),
    models: { ...models, [$("provider").value]: $("model").value }
  };
}

// Local servers on non-localhost addresses need an extra Chrome permission.
async function ensureLocalPermission(baseUrl) {
  let origin;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    throw new Error("Local server URL is not a valid URL.");
  }
  const host = new URL(baseUrl).hostname;
  if (host === "localhost" || host === "127.0.0.1") return;
  const ok = await chrome.permissions.request({ origins: [`${origin}/*`] });
  if (!ok) throw new Error(`Chrome permission for ${origin} was denied.`);
}

async function load() {
  const s = await getSettings();
  models = { ...s.models };
  for (const [id, p] of Object.entries(PROVIDERS)) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = p.label;
    $("provider").appendChild(opt);
  }
  $("provider").value = s.provider;
  $("anthropicKey").value = s.anthropicKey;
  $("openaiKey").value = s.openaiKey;
  $("geminiKey").value = s.geminiKey;
  $("localBaseUrl").value = s.localBaseUrl;
  $("localApiKey").value = s.localApiKey;
  $("autoRun").checked = s.autoRun;
  $("jiraHosts").value = s.jiraHosts.join(", ");
  $("serverField").value = s.serverField;
  $("locationField").value = s.locationField;
  $("teamContext").value = s.teamContext;
  $("customInstructions").value = s.customInstructions;
  $("bmcUrl").value = s.bmcUrl;
  $("netboxEnabled").checked = s.netboxEnabled;
  $("netboxUrl").value = s.netboxUrl;
  $("netboxToken").value = s.netboxToken;
  $("podcrawlerUrl").value = s.podcrawlerUrl;
  $("podcrawlerStep").checked = s.podcrawlerStep;
  $("pingAuto").checked = s.pingAuto;
  $("installCmd").value = `bash ~/Desktop/jira-assistant/ping-helper/install.sh ${chrome.runtime.id}`;
  showProvider(s.provider);
}

$("provider").addEventListener("change", (e) => {
  showMsg("");
  showProvider(e.target.value);
});

$("model").addEventListener("change", () => {
  models[$("provider").value] = $("model").value;
});

document.querySelectorAll("[data-preset]").forEach((btn) => {
  btn.addEventListener("click", () => {
    $("localBaseUrl").value = LOCAL_PRESETS[btn.dataset.preset];
  });
});

$("loadModels").addEventListener("click", async () => {
  const s = formSettings();
  const problem = missingConfig(s);
  if (problem) return showMsg(problem.replace(" in Settings (⚙)", ""), true);
  showMsg("Connecting…");
  try {
    if (s.provider === "local") await ensureLocalPermission(s.localBaseUrl);
    const list = await listModels(s);
    const keep = $("model").value;
    resetModelSelect("");
    list.forEach((m) => ensureModelOption(m.id, m.name === m.id ? m.id : `${m.name} (${m.id})`));
    $("model").value = list.some((m) => m.id === keep) ? keep : "";
    showMsg(list.length ? `Connected — ${list.length} models available.` : "Connected, but no models were found.");
  } catch (e) {
    showMsg(String(e.message || e), true);
  }
});

$("save").addEventListener("click", async () => {
  const s = formSettings();
  const hosts = $("jiraHosts").value.split(/[\s,]+/).map((h) => h.trim()
    .replace(/^https?:\/\//, "").replace(/\/.*$/, "")).filter(Boolean);

  try {
    // One permission prompt for everything (it must happen directly inside the click handler).
    const origins = hosts.flatMap((h) => [`https://${h}/*`, `http://${h}/*`]);
    if (s.provider === "local" && s.localBaseUrl) {
      let u;
      try { u = new URL(s.localBaseUrl); } catch { throw new Error("Local server URL is not a valid URL."); }
      if (!["localhost", "127.0.0.1"].includes(u.hostname)) origins.push(`${u.origin}/*`);
    }
    const nbOrigin = netboxOrigin();
    if (nbOrigin && nbOrigin !== new URL(DEFAULTS.netboxUrl).origin) origins.push(`${nbOrigin}/*`);
    if (origins.length && !(await chrome.permissions.request({ origins }))) {
      throw new Error("Chrome permission for the Jira host(s) / local server was denied.");
    }
  } catch (e) {
    return showMsg(String(e.message || e), true);
  }

  models = s.models;
  await chrome.storage.local.set({
    ...s,
    autoRun: $("autoRun").checked,
    jiraHosts: hosts,
    serverField: $("serverField").value.trim(),
    locationField: $("locationField").value.trim(),
    teamContext: $("teamContext").value,
    customInstructions: $("customInstructions").value,
    bmcUrl: $("bmcUrl").value.includes("{ip}") ? $("bmcUrl").value.trim() : "https://{ip}",
    netboxEnabled: $("netboxEnabled").checked,
    netboxUrl: ($("netboxUrl").value.trim() || DEFAULTS.netboxUrl).replace(/\/+$/, ""),
    netboxToken: $("netboxToken").value.trim(),
    podcrawlerUrl: $("podcrawlerUrl").value.trim() || DEFAULTS.podcrawlerUrl,
    podcrawlerStep: $("podcrawlerStep").checked,
    pingAuto: $("pingAuto").checked
  });
  await chrome.storage.local.remove(["apiKey", "model"]); // v1 settings, now migrated
  await chrome.storage.session.clear(); // drop cached analyses so new settings apply
  showMsg("Saved ✓");
});

$("copyInstall").addEventListener("click", async () => {
  await navigator.clipboard.writeText($("installCmd").value);
  $("copyInstall").textContent = "Copied ✓";
  setTimeout(() => ($("copyInstall").textContent = "Copy"), 1500);
});

$("testHelper").addEventListener("click", async () => {
  const el = $("helperMsg");
  el.style.color = "";
  el.textContent = "Testing…";
  const r = await pingHelperHello();
  if (r.ok) {
    el.textContent = `✓ Ping helper v${r.version} is working (${r.platform}, Python ${r.python}).`;
  } else {
    el.textContent = r.error;
    el.style.color = "var(--err)";
  }
});

function netboxOrigin() {
  try { return new URL($("netboxUrl").value.trim() || DEFAULTS.netboxUrl).origin; } catch { throw new Error("NetBox address is not a valid URL."); }
}

$("testNetbox").addEventListener("click", async () => {
  const el = $("netboxMsg");
  el.style.color = "";
  el.textContent = "Testing…";
  try {
    const origin = netboxOrigin();
    if (origin !== new URL(DEFAULTS.netboxUrl).origin && !(await chrome.permissions.request({ origins: [`${origin}/*`] }))) {
      throw new Error("Chrome permission for this NetBox address was denied.");
    }
    const s = { netboxUrl: $("netboxUrl").value.trim() || DEFAULTS.netboxUrl, netboxToken: $("netboxToken").value.trim() };
    const r = await nbGet(s, "/api/dcim/devices/?limit=1");
    el.textContent = `✓ Connected (${s.netboxToken ? "API token" : "browser login"}) — ${Number(r.count || 0).toLocaleString()} devices visible.`;
  } catch (e) {
    el.textContent = String(e.message || e);
    el.style.color = "var(--err)";
  }
});

load();
