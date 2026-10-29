// Side panel: detects the open Jira issue, reads it (fields, comments, history),
// asks the selected AI provider for a DC Ops brief, and renders it.

const $ = (id) => document.getElementById(id);
let current = { tabId: null, key: null, running: false };
let lastResult = null;

// ---------- Jira detection ----------

function parseIssueKey(url) {
  try {
    const u = new URL(url);
    const sel = u.searchParams.get("selectedIssue");
    if (sel && /^[A-Z][A-Z0-9_]+-\d+$/i.test(sel)) return sel.toUpperCase();
    const m = u.pathname.match(/\/(?:browse|issues)\/([A-Z][A-Z0-9_]+-\d+)/i);
    return m ? m[1].toUpperCase() : null;
  } catch {
    return null;
  }
}

function isJiraUrl(url, settings) {
  try {
    const host = new URL(url).hostname;
    return host.endsWith(".atlassian.net") || settings.jiraHosts.includes(host);
  } catch {
    return false;
  }
}

// Runs inside the Jira page so the user's existing login session is used.
async function fetchIssueInPage(key) {
  const ctx = document.querySelector('meta[name="ajs-context-path"]')?.content || "";
  const url = `${ctx}/rest/api/2/issue/${encodeURIComponent(key)}?expand=names,changelog&fields=*all`;
  try {
    const res = await fetch(url, { credentials: "include", headers: { Accept: "application/json" } });
    if (res.ok) return { data: await res.json() };
    return { error: `Jira API returned ${res.status}`, pageText: document.body.innerText.slice(0, 40000) };
  } catch (e) {
    return { error: String(e), pageText: document.body.innerText.slice(0, 40000) };
  }
}

async function fetchIssue(tabId, key) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: fetchIssueInPage, args: [key] });
  return res?.result || { error: "Could not read the Jira page." };
}

// ---------- Turning Jira JSON into readable text ----------

const SKIP_FIELDS = new Set([
  "watches", "votes", "worklog", "timetracking", "aggregateprogress", "progress", "lastViewed",
  "workratio", "thumbnail", "avatarUrls", "statuscategorychangedate", "comment"
]);

function simplify(v, depth = 0) {
  if (v === null || v === undefined || v === "") return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map((x) => simplify(x, depth + 1)).filter(Boolean).join(", ");
  if (typeof v === "object") {
    for (const k of ["displayName", "value", "name", "key", "filename"]) {
      if (typeof v[k] === "string" && v[k]) {
        return v.child?.value ? `${v[k]} / ${v.child.value}` : v[k];
      }
    }
    if (depth > 2) return "";
    const s = JSON.stringify(v);
    return s.length > 500 ? s.slice(0, 500) + "…" : s;
  }
  return "";
}

function findFieldValue(data, wanted) {
  if (!wanted) return "";
  const w = wanted.trim().toLowerCase();
  const names = data.names || {};
  for (const [id, val] of Object.entries(data.fields || {})) {
    if (id.toLowerCase() === w || (names[id] || "").toLowerCase() === w) return simplify(val);
  }
  return "";
}

const clip = (s, n) => (s.length > n ? s.slice(0, n) + "…" : s);
const day = (iso) => (iso || "").slice(0, 16).replace("T", " ");

function issueToText(data) {
  const f = data.fields || {};
  const names = data.names || {};
  const lines = [];
  const first = ["summary", "status", "priority", "issuetype", "reporter", "assignee", "created", "updated",
                 "labels", "components", "environment", "description"];
  const order = [...first, ...Object.keys(f).filter((k) => !first.includes(k))];

  for (const id of order) {
    if (SKIP_FIELDS.has(id) || !(id in f)) continue;
    const val = simplify(f[id]);
    if (!val || val === "{}" || val === "[]") continue;
    lines.push(`${names[id] || id}: ${val}`);
  }

  // Status / assignee / resolution changes = a record of work progression.
  const hist = (data.changelog?.histories || [])
    .flatMap((hh) => (hh.items || [])
      .filter((it) => ["status", "assignee", "resolution", "priority"].includes(it.field))
      .map((it) => `- [${day(hh.created)}] ${hh.author?.displayName || "?"}: ${it.field} ${it.fromString || "—"} → ${it.toString || "—"}`))
    .sort();
  if (hist.length) lines.push("\nChange history (oldest → newest):", ...hist.slice(-30));

  const worklogs = f.worklog?.worklogs || [];
  const wl = worklogs.filter((w) => simplify(w.comment)).slice(-15);
  if (wl.length) {
    lines.push("\nWork logs:");
    for (const w of wl) lines.push(`- [${day(w.started)}] ${w.author?.displayName || "?"} (${w.timeSpent || ""}): ${clip(simplify(w.comment), 800)}`);
  }

  const comments = f.comment?.comments || [];
  if (comments.length) {
    const shown = comments.slice(-40);
    lines.push(`\nComments (oldest → newest${comments.length > shown.length ? `, last ${shown.length} of ${comments.length}` : ""}):`);
    for (const c of shown) {
      lines.push(`- [${day(c.created)}] ${c.author?.displayName || "Unknown"}: ${clip(simplify(c.body), 2000)}`);
    }
  } else {
    lines.push("\nComments: none");
  }
  const text = lines.join("\n");
  return text.length > 80000 ? text.slice(0, 80000) + "\n…(truncated)" : text;
}

function issueMeta(data) {
  const f = data?.fields || {};
  return {
    status: simplify(f.status),
    priority: simplify(f.priority),
    assignee: simplify(f.assignee) || "Unassigned"
  };
}

// ---------- AI ----------

async function analyzeIssue(settings, key, issueText) {
  const { result, model } = await generateStructured(settings, {
    system: dcSystemPrompt(settings.teamContext, settings.customInstructions),
    user: `Today is ${new Date().toISOString().slice(0, 10)}.\n\nJira issue ${key}:\n\n${issueText}`,
    schema: DC_SCHEMA,
    schemaName: "dc_ops_brief"
  });
  let brief = normalizeDc(result);
  if (settings.podcrawlerStep) brief = ensurePodcrawlerStep(brief);
  return { brief, model: `${providerLabel(settings.provider)} · ${model}` };
}

// ---------- UI ----------

function setStatus(msg, kind = "") {
  const el = $("status");
  if (!msg) return el.classList.add("hidden");
  el.className = `status ${kind}`;
  el.innerHTML = "";
  if (kind === "loading") el.appendChild(h("span", { class: "spinner" }));
  el.appendChild(document.createTextNode(msg));
}

function hideResult() {
  $("result").classList.add("hidden");
  $("footer").classList.add("hidden");
  if (typeof closeChat === "function") closeChat();
}

async function openBmc(ip) {
  const { bmcUrl: template } = await getSettings();
  chrome.tabs.create({ url: bmcUrl(template, ip) });
}

// Ticket text + brief for the chat. Older cached results may lack the text → read the ticket again.
async function chatContext(key, entry) {
  if (!entry.issueText && current.key === key && current.tabId) {
    const issue = await fetchIssue(current.tabId, key);
    entry.issueText = issue.data ? issueToText(issue.data) : issue.pageText || "";
  }
  return { issueText: entry.issueText, brief: entry.brief, netbox: lastResult?.key === key ? lastResult.netbox : null };
}

async function show(key, entry) {
  lastResult = { key, ...entry };
  const checksKey = `checks:${key}`;
  const saved = (await chrome.storage.session.get(checksKey))[checksKey] || [];
  const checks = new Set(saved);
  renderBrief($("result"), entry.brief, {
    key,
    meta: entry.meta,
    checks,
    onCheck: () => chrome.storage.session.set({ [checksKey]: [...checks] }),
    openBmc
  });
  startLookups(key, entry);
  $("meta").textContent = `${entry.model} · ${new Date(entry.analyzedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  $("result").classList.remove("hidden");
  $("footer").classList.remove("hidden");
  $("analyzeBtn").textContent = "Re-analyze";
  openChat(key, () => chatContext(key, entry));
}

// ---------- NetBox + Podcrawler ----------

const NETBOX_MAX_AGE_MS = 10 * 60 * 1000;
let lookupRun = 0;

function openUrl(url) {
  chrome.tabs.create({ url });
}

async function openPodcrawler(hostname) {
  if (hostname) navigator.clipboard.writeText(hostname).catch(() => {}); // copy while we still have the click gesture
  const { podcrawlerUrl } = await getSettings();
  openUrl(podcrawlerUrl || "https://podcrawler.aws.lambdalabs.cloud/");
}

// NetBox lookup first (it can add the BMC/host IP), then ping.
async function startLookups(key, entry, force = false) {
  const run = ++lookupRun;
  const settings = await getSettings();
  let nb = null;
  if (settings.netboxEnabled) {
    const box = () => (current.key === key ? document.getElementById("netboxBox") : null);
    const actions = {
      onRefresh: () => startLookups(key, entry, true),
      onOpenNetbox: () => openUrl(nbBase(settings) + "/"),
      onOpenPodcrawler: (name) => openPodcrawler(typeof name === "string" ? name : entry.brief.server_names[0]),
      openUrl,
      openBmc
    };
    const cacheKey = `nb:${key}`;
    nb = force ? null : (await chrome.storage.session.get(cacheKey))[cacheKey];
    if (nb && Date.now() - nb.at > NETBOX_MAX_AGE_MS) nb = null;
    if (!nb) {
      renderNetbox(box(), { loading: true }, actions);
      const { issueText } = await chatContext(key, entry);
      nb = await netboxLookup(settings, entry.brief, issueText);
      nb.at = nb.at || Date.now();
      if (nb.ok || nb.notFound) await chrome.storage.session.set({ [cacheKey]: nb });
    }
    if (run !== lookupRun || current.key !== key) return;
    if (lastResult?.key === key) lastResult.netbox = nb;
    renderNetbox(box(), { nb }, actions);
  }
  if (run !== lookupRun || current.key !== key) return;
  setupPing(key, entry.brief, entry.ticketIps || [], netboxPingTargets(nb));
}

// ---------- Reachability ----------

const PING_MAX_AGE_MS = 60 * 1000; // re-ping automatically if older than this
let pingRun = 0;

async function setupPing(key, brief, ticketIps, extraTargets = []) {
  const settings = await getSettings();
  const targets = buildPingTargets(brief, ticketIps, extraTargets);
  const cacheKey = `ping:${key}`;
  const cached = (await chrome.storage.session.get(cacheKey))[cacheKey];
  const box = () => (current.key === key ? document.getElementById("pingBox") : null);
  const actions = {
    onPing: () => doPing(),
    openBmc,
    onSetup: () => chrome.runtime.openOptionsPage()
  };

  async function doPing() {
    const run = ++pingRun;
    renderPing(box(), { loading: true, targets }, actions);
    const resp = await runPing(targets);
    if (resp.ok) await chrome.storage.session.set({ [cacheKey]: resp });
    if (run === pingRun && lastResult?.key === key) lastResult.ping = resp.ok ? resp : null;
    if (run === pingRun) renderPing(box(), { targets, resp }, actions);
  }

  if (lastResult?.key === key) lastResult.ping = cached || null;
  const sameTargets = cached?.results && targets.map((t) => t.address).sort().join() === cached.results.map((x) => x.address).sort().join();
  const fresh = cached && sameTargets && Date.now() - cached.at < PING_MAX_AGE_MS;
  if (fresh || !settings.pingAuto) renderPing(box(), { targets, resp: cached }, actions);
  else doPing();
}

async function analyze(force = false) {
  if (!current.key || current.running) return;
  const key = current.key;
  const settings = await getSettings();

  const problem = missingConfig(settings);
  if (problem) return setStatus(problem, "error");

  const cacheKey = `result:${key}`;
  if (!force) {
    const cached = (await chrome.storage.session.get(cacheKey))[cacheKey];
    if (cached?.brief) {
      setStatus("");
      return show(key, cached);
    }
  }

  current.running = true;
  $("analyzeBtn").disabled = true;
  hideResult();
  try {
    setStatus(`Reading ${key}, comments and history…`, "loading");
    const issue = await fetchIssue(current.tabId, key);
    let text;
    const mapped = {};
    if (issue.data) {
      text = issueToText(issue.data);
      mapped.server = findFieldValue(issue.data, settings.serverField);
      mapped.location = findFieldValue(issue.data, settings.locationField);
    } else if (issue.pageText) {
      text = `(Jira API unavailable: ${issue.error}. Raw page text follows.)\n\n${issue.pageText}`;
    } else {
      throw new Error(issue.error);
    }

    setStatus(`Asking ${providerLabel(settings.provider)} to brief ${key}…`, "loading");
    const { brief, model } = await analyzeIssue(settings, key, text);
    // Exact field mappings (if configured) win over the model's extraction.
    if (mapped.server) brief.server_names = mapped.server.split(/\s*,\s*/).filter(Boolean);
    if (mapped.location && !locationText(brief.location)) brief.location.site = mapped.location;

    const entry = { brief, model, meta: issueMeta(issue.data), ticketIps: findIPsInText(text), issueText: text, analyzedAt: Date.now() };
    await chrome.storage.session.set({ [cacheKey]: entry });
    if (force) await chrome.storage.session.remove(`checks:${key}`);
    if (current.key === key) {
      setStatus("");
      await show(key, entry);
    }
  } catch (e) {
    setStatus(String(e.message || e), "error");
  } finally {
    current.running = false;
    $("analyzeBtn").disabled = !current.key;
  }
}

async function refresh() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const settings = await getSettings();
  const key = tab?.url && isJiraUrl(tab.url, settings) ? parseIssueKey(tab.url) : null;

  if (key === current.key && tab?.id === current.tabId) return;
  current.tabId = tab?.id ?? null;
  current.key = key;

  $("issueKey").textContent = key || "Open a Jira issue";
  $("analyzeBtn").disabled = !key;
  $("analyzeBtn").textContent = "Analyze";
  hideResult();
  setStatus("");
  if (!key) return;

  const cacheKey = `result:${key}`;
  const cached = (await chrome.storage.session.get(cacheKey))[cacheKey];
  if (cached?.brief) show(key, cached);
  else if (settings.autoRun) analyze();
}

let refreshTimer;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 400);
}

chrome.tabs.onActivated.addListener(scheduleRefresh);
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url || info.status === "complete") scheduleRefresh();
});
chrome.windows.onFocusChanged.addListener(scheduleRefresh);

$("analyzeBtn").addEventListener("click", () => analyze(true));
$("settingsBtn").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("copyBtn").addEventListener("click", async () => {
  if (!lastResult) return;
  await navigator.clipboard.writeText(asJiraComment(lastResult.key, lastResult.brief, lastResult.ping, lastResult.netbox));
  $("copyBtn").textContent = "Copied ✓";
  setTimeout(() => ($("copyBtn").textContent = "Copy as Jira comment"), 1500);
});

refresh();
