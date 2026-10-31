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
  $("pingAuto").checked = s.pingAuto;
  $("opVault").value = s.opVault;
  $("opTag").value = s.opTag;
  $("opFallbackItem").value = s.opFallbackItem;
  $("opAccount").value = s.opAccount;
  $("bmcHealthAuto").checked = s.bmcHealthAuto;
  $("bmcLogin").value = s.bmcLogin;
  $("bmcUser").value = s.bmcUser;
  showBmcLogin();
  // Windows: PowerShell + .ps1 scripts (the Desktop may be redirected to OneDrive, so ask Windows where it is).
  const id = chrome.runtime.id;
  const winDir = `$([Environment]::GetFolderPath('Desktop'))\\jira-assistant`;
  $("installCmd").value = IS_WIN
    ? `powershell -ExecutionPolicy Bypass -File "${winDir}\\ping-helper\\install.ps1" ${id}`
    : `bash ~/Desktop/jira-assistant/ping-helper/install.sh ${id}`;
  $("setupCmd").value = IS_WIN
    ? `powershell -ExecutionPolicy Bypass -File "${winDir}\\setup.ps1" ${id}`
    : `bash ~/Desktop/jira-assistant/setup.sh ${id}`;
  document.body.classList.add(IS_WIN ? "is-win" : "is-mac");
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
    pingAuto: $("pingAuto").checked,
    ...opForm(),
    bmcHealthAuto: $("bmcHealthAuto").checked,
    bmcLogin: $("bmcLogin").value,
    bmcUser: $("bmcUser").value.trim() || "ADMIN",
    privacyMode: $("privacyMode").checked,
    privacyHide: Object.fromEntries([...document.querySelectorAll("#privacyKinds input")].map((b) => [b.dataset.kind, b.checked])),
    privacyWords: $("privacyWords").value
  });
  await chrome.storage.local.remove(["apiKey", "model"]); // v1 settings, now migrated
  await chrome.storage.session.clear(); // drop cached analyses so new settings apply
  showMsg("Saved ✓");
});

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

// The 1Password CLI options only matter in "Automatic from 1Password CLI" mode.
function showBmcLogin() {
  $("opBox").classList.toggle("mode-off", $("bmcLogin").value !== "1password"); // not "hidden": tabs use that
}
$("bmcLogin").addEventListener("change", showBmcLogin);

function opForm() {
  return {
    opVault: $("opVault").value.trim(),
    opTag: $("opTag").value.trim(),
    opFallbackItem: $("opFallbackItem").value.trim(),
    opAccount: $("opAccount").value.trim()
  };
}

$("testOp").addEventListener("click", async () => {
  const el = $("opMsg");
  el.style.color = "";
  el.textContent = "Testing… approve the 1Password prompt if one appears.";
  const r = await sendNative({ action: "op_check", op: opConfig(opForm()) });
  if (r.ok) {
    el.textContent = `✓ 1Password works — ${r.items} item${r.items === 1 ? "" : "s"} to search${r.vault ? ` in ${r.vault}` : ` in ${r.vaults} vault${r.vaults === 1 ? "" : "s"}`}.`;
  } else {
    el.textContent = /unknown action/i.test(r.error || "") ? "The ping helper is out of date. Re-run the install command above." : r.error;
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
