// Settings page: load/save settings, model list, connection tests (AI, ping helper, NetBox, catalog), and tabs.

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
    models: { ...models, [$("provider").value]: $("model").value },
    speed: $("speed").value
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

// script: "setup" or "ping-helper/install" (.sh on Mac, .ps1 on Windows), run from the jira-assistant folder.
function setupCommand(script) {
  return folderCommand(`bash "$d/${script}.sh" ${chrome.runtime.id}`,
    `powershell -ExecutionPolicy Bypass -File "$d\\${script.replace("/", "\\")}.ps1" $id`);
}

async function load() {
  const s = await getSettings();
  models = { ...s.models };
  $("provider").replaceChildren(); // load() runs again after loading a settings file
  for (const [id, p] of Object.entries(PROVIDERS)) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = p.label;
    $("provider").appendChild(opt);
  }
  $("provider").value = s.provider;
  $("speed").value = s.speed;
  $("privacyMode").checked = s.privacyMode;
  $("privacyWords").value = s.privacyWords;
  $("privacyKinds").replaceChildren(...Object.entries(PRIVACY_KINDS).map(([k, label]) => {
    const box = Object.assign(document.createElement("input"), { type: "checkbox", checked: s.privacyHide[k] !== false });
    box.dataset.kind = k;
    const l = document.createElement("label");
    l.append(box, ` ${label}`);
    return l;
  }));
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
  document.querySelectorAll(".k-quick").forEach((k) => (k.textContent = KEYS.quickAccess));
  document.querySelectorAll(".k-slack").forEach((k) => (k.textContent = KEYS.slackSearch));
  $("slackIn").value = s.slackIn;
  $("catalogUrl").value = s.catalogUrl;
  $("pingAuto").checked = s.pingAuto;
  $("bmcUser").value = s.bmcUser;
  $("installCmd").value = setupCommand("ping-helper/install");
  $("setupCmd").value = setupCommand("setup");
  document.body.classList.add(IS_WIN ? "is-win" : "is-mac");
  document.querySelectorAll(".ext-id").forEach((el) => (el.textContent = chrome.runtime.id));
  $("itRequest").value = IT_REQUEST;
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

// A real one-line request with the key and model on the page (saved or not): checks the key, the model and the speed.
$("testAi").addEventListener("click", async () => {
  const s = { ...(await getSettings()), ...formSettings() };
  const problem = missingConfig(s);
  if (problem) return showMsg(problem.replace(" in Settings (⚙)", ""), true);
  showMsg("Asking the AI…");
  $("testAi").disabled = true;
  const started = Date.now();
  try {
    if (s.provider === "local") await ensureLocalPermission(s.localBaseUrl);
    const { text, model } = await generateText(s, { system: "You are a connection test. Answer in at most five words.", messages: [{ role: "user", content: "Say that the connection works." }], maxTokens: 50 });
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    showMsg(`✓ ${PROVIDERS[s.provider].label} works: ${model} answered in ${secs} s ("${text.trim().slice(0, 60)}").${$("model").value ? "" : " Auto picked this model."} Click Save to keep these settings.`);
  } catch (e) {
    showMsg(`✕ ${String(e.message || e)}`, true);
  } finally {
    $("testAi").disabled = false;
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
    slackIn: $("slackIn").value,
    catalogUrl: $("catalogUrl").value.trim() || DEFAULTS.catalogUrl,
    pingAuto: $("pingAuto").checked,
    bmcUser: $("bmcUser").value.trim() || "ADMIN",
    privacyMode: $("privacyMode").checked,
    privacyHide: Object.fromEntries([...document.querySelectorAll("#privacyKinds input")].map((b) => [b.dataset.kind, b.checked])),
    privacyWords: $("privacyWords").value
  });
  await chrome.storage.local.remove(["apiKey", "model"]); // v1 settings, now migrated
  await chrome.storage.session.clear(); // drop cached analyses so new settings apply
  showMsg("Saved ✓");
});

// ---------- Backup & restore ----------
// Settings as a JSON file. API keys and tokens are left out unless ticked, so a file can be shared with the team.

const BACKUP_APP = "lambda-dc-ops-assistant";
const SECRET_SETTINGS = ["anthropicKey", "openaiKey", "geminiKey", "localApiKey", "netboxToken"];

function backupMsg(text, bad = false) {
  $("backupMsg").textContent = text;
  $("backupMsg").style.color = bad ? "var(--err)" : "";
}

$("exportSettings").addEventListener("click", async () => {
  const s = await getSettings();
  const withSecrets = $("exportSecrets").checked;
  const settings = Object.fromEntries(Object.keys(DEFAULTS).filter((k) => withSecrets || !SECRET_SETTINGS.includes(k)).map((k) => [k, s[k]]));
  const file = { app: BACKUP_APP, version: chrome.runtime.getManifest().version, savedAt: new Date().toISOString(), settings };
  const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: "application/json" }));
  const name = `dc-ops-assistant-settings-${new Date().toISOString().slice(0, 10)}.json`;
  Object.assign(document.createElement("a"), { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  backupMsg(withSecrets ? `Saved ${name} with your API keys: keep it private.` : `Saved ${name} (no API keys or tokens).`);
});

$("importSettings").addEventListener("click", () => $("importFile").click());
$("importFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = ""; // so the same file can be picked again
  if (!file) return;
  try {
    let data;
    try { data = JSON.parse(await file.text()); } catch { throw new Error("it isn't a settings file (not JSON)"); }
    if (data?.app !== BACKUP_APP || typeof data.settings !== "object") throw new Error("it isn't a DC Ops Assistant settings file");
    // Only known settings, each the same type as its default. Settings not in the file keep their current value.
    const sameType = (a, b) => (Array.isArray(a) ? Array.isArray(b) : typeof a === typeof b && !Array.isArray(b) && b !== null);
    const valid = Object.fromEntries(Object.entries(data.settings).filter(([k, v]) => k in DEFAULTS && sameType(DEFAULTS[k], v)));
    if (!Object.keys(valid).length) throw new Error("there are no settings in it");
    await chrome.storage.local.set(valid);
    await chrome.storage.session.clear(); // drop cached analyses so the new settings apply
    await load();
    const keys = SECRET_SETTINGS.some((k) => k in valid) ? "including API keys" : "your API keys were kept";
    backupMsg(`✓ Loaded ${Object.keys(valid).length} settings from ${file.name} (${keys}).`);
  } catch (err) {
    backupMsg(`Couldn't load ${file.name}: ${err.message}.`, true);
  }
});

// ---------- Updates ----------

let updateRun = 0;
async function showUpdate(force) {
  const run = ++updateRun;
  if (force) $("updateStatus").textContent = "Checking GitHub…";
  const u = await checkForUpdate(force);
  if (run !== updateRun) return; // a newer check is running: show only its result
  $("updateStatus").textContent = !u.ok ? `You have ${u.current}. Couldn't check: ${u.error}.`
    : u.available ? `🆕 Version ${u.latest} is available (you have ${u.current}).` : `✓ You have the latest version (${u.current}).`;
  $("updateStatus").style.color = u.ok ? "" : "var(--err)";
  $("updateHelp").replaceChildren(...(u.available ? [updateSteps()] : []));
}
$("checkUpdate").addEventListener("click", () => showUpdate(true));
showUpdate(false);

const IT_REQUEST = `Hi IT,

I'm in Datacenter Operations and use the Lambda DC Ops Assistant (Chrome extension) to summarize Jira tickets. Could you please create an API key for me on the company account?

Preferred: Anthropic Claude (console.anthropic.com). OpenAI or Google Gemini also work.
Use: reading Jira tickets I'm assigned, about 10–50 a day. Ticket text is sent to the provider.

Thanks!`;

function copyButton(btn, getText) {
  btn.addEventListener("click", async () => {
    await navigator.clipboard.writeText(getText());
    const label = btn.textContent;
    btn.textContent = "Copied ✓";
    setTimeout(() => (btn.textContent = label), 1500);
  });
}
copyButton($("copySetup"), () => $("setupCmd").value);
copyButton($("copyItRequest"), () => $("itRequest").value);

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

// ---------- Tabs ----------
// Each section heading says which tab it belongs to (data-tab); everything after it, up to the next
// heading, goes in the same tab. The Save bar stays visible on every tab.
const TABS = [["start", "Start"], ["servers", "Servers & BMC"], ["privacy", "Privacy"], ["jira", "Jira & AI"]];

function setupTabs() {
  let group = null;
  for (const el of document.querySelector(".form").children) {
    if (el.dataset.tab) group = el.dataset.tab;
    if (group && !el.matches("h1, #tabs, .save-bar")) el.dataset.group = group;
  }
  let saved = "start";
  try { saved = localStorage.getItem("settingsTab") || "start"; } catch {}
  const show = (tab) => {
    for (const el of document.querySelectorAll("[data-group]")) el.classList.toggle("hidden", el.dataset.group !== tab);
    // The first heading in a tab gets no divider line above it.
    document.querySelectorAll("h2[data-tab]").forEach((h2) => h2.classList.remove("first"));
    document.querySelector(`[data-group="${tab}"]:is(h2)`)?.classList.add("first");
    for (const b of $("tabs").children) b.setAttribute("aria-selected", String(b.dataset.tab === tab));
    try { localStorage.setItem("settingsTab", tab); } catch {}
  };
  $("tabs").replaceChildren(...TABS.map(([id, label]) => {
    const b = document.createElement("button");
    Object.assign(b, { type: "button", textContent: label });
    b.dataset.tab = id;
    b.setAttribute("role", "tab");
    b.addEventListener("click", () => show(id));
    return b;
  }));
  show(TABS.some(([id]) => id === saved) ? saved : "start");
}
setupTabs();
fillDevContact();

$("testCatalog").addEventListener("click", async () => {
  const el = $("catalogMsg");
  el.style.color = "";
  el.textContent = "Reading the catalog…";
  try {
    const c = await loadCatalog($("catalogUrl").value.trim() || DEFAULTS.catalogUrl, true);
    el.textContent = `✓ ${c.parts.length.toLocaleString()} parts loaded (${c.parts.filter((p) => p.lambda).length.toLocaleString()} with a Lambda P/N).`;
    el.style.color = "var(--ok)";
  } catch (e) {
    el.textContent = e.message;
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
