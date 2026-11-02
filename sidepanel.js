// Side panel: detects the open Jira issue, reads it (fields, comments, history), asks the selected AI provider
// for a DC Ops brief and renders it, then runs the lookups around it: NetBox, ping, BMC, parts catalog & stock.
// Sections: Jira · AI · progress line & jump links · status, toast, people · NetBox · parts · BMC · reachability ·
// RMA · update banner · start screen (no ticket) · analyze & tab events.

const $ = (id) => document.getElementById(id);
let current = { tabId: null, key: null, running: false };
let lastResult = null;

// ---------- Jira detection ----------

function parseIssueKey(url) {
  try {
    const u = new URL(url);
    const sel = u.searchParams.get("selectedIssue");
    if (sel && /^[A-Z][A-Z0-9_]+-\d+$/i.test(sel)) return sel.toUpperCase();
    // /browse/DC-1, /issues/DC-1, and service desk queue links (…/queues/custom/270/DC-32686): the key is a path part.
    const key = u.pathname.split("/").reverse().find((part) => /^[A-Z][A-Z0-9_]+-\d+$/i.test(part));
    return key ? key.toUpperCase() : null;
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
    assignee: simplify(f.assignee) || "Unassigned",
    reporter: simplify(f.reporter)
  };
}

// ---------- AI ----------

// onPartial(brief, raw) fires while the answer streams in, so the panel can fill in as the AI writes.
// privacy: makeRedactor() result — the ticket is sent with placeholders and real values are put back here.
async function analyzeIssue(settings, key, issueText, onPartial, privacy) {
  const { result, model } = await generateStructured(settings, {
    system: dcSystemPrompt(settings.teamContext, settings.customInstructions),
    user: `Today is ${new Date().toISOString().slice(0, 10)}.\n\nJira issue ${key}:\n\n${privacy.redact(issueText)}`,
    schema: DC_SCHEMA,
    schemaName: "dc_ops_brief",
    onPartial: onPartial && ((raw) => onPartial(normalizeDc(privacy.restore(raw)), raw))
  });
  let brief = normalizeDc(privacy.restore(result));
  if (settings.podcrawlerStep) brief = ensurePodcrawlerStep(brief);
  return { brief, model: `${providerLabel(settings.provider)} · ${model}` };
}

// ---------- Progress line ----------
// One line under the header for everything that runs when a ticket opens, instead of a spinner per card.
const STEP_LABELS = { ticket: "Ticket", ai: "AI brief", netbox: "NetBox", ping: "Ping" };
let steps = {};
let stepsHide;

function setStep(name, state, note = "") {
  steps[name] = { state, note };
  renderSteps();
}

function resetSteps() {
  steps = {};
  renderSteps();
}

function renderSteps() {
  const el = $("progress");
  const names = Object.keys(STEP_LABELS).filter((n) => steps[n]);
  el.replaceChildren(...names.map((n) => {
    const { state, note } = steps[n];
    return h("span", { class: `step ${state}` },
      state === "run" ? h("span", { class: "spinner" }) : icon(state === "ok" ? "check" : "x", 11),
      STEP_LABELS[n], note && h("span", { class: "step-note" }, note));
  }));
  const busy = names.some((n) => steps[n].state === "run");
  clearTimeout(stepsHide);
  el.classList.toggle("hidden", !names.length);
  // Fade out a moment after everything is done (failures stay visible).
  if (names.length && !busy && names.every((n) => steps[n].state === "ok")) stepsHide = setTimeout(() => el.classList.add("hidden"), 2500);
}

// ---------- Jump links ----------
const JUMPS = [["✅ Steps", () => $("steps")], ["🔧 BMC", () => $("bmcBox")], ["🕘 History", () => $("history")], ["🗄️ NetBox", () => $("netboxBox")]];

function updateJump() {
  const nav = $("jump");
  const visible = !$("result").classList.contains("hidden");
  const items = JUMPS.filter(([, el]) => visible && el() && !el().classList.contains("hidden"));
  nav.classList.toggle("hidden", items.length < 2);
  nav.replaceChildren(...items.map(([label, el]) => h("button", { class: "jump-link", onclick: () => {
    const target = el();
    if (target.tagName === "DETAILS") target.open = true;
    target.scrollIntoView({ behavior: "smooth", block: "start" });
  } }, label)));
}
let jumpFrame;
new MutationObserver(() => { cancelAnimationFrame(jumpFrame); jumpFrame = requestAnimationFrame(updateJump); })
  .observe($("result"), { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });

// ---------- Status, toast, people ----------

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

// Short message at the bottom of the panel.
let toastTimer;
function toast(msg, ms = 6000) {
  let el = document.getElementById("toast");
  if (!el) document.body.appendChild(el = h("div", { id: "toast", class: "toast", role: "status" }));
  el.replaceChildren(...[msg].flat());
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), ms);
}

// Clicking a person opens your Slack chat with them.
// Slack in Chrome (an open tab, or a new one if Settings says browser): the extension finds the person and opens the
// chat. The Slack desktop app can't be driven, so then the name is copied for ⌘K / Ctrl+K + paste.
async function openSlack(name) {
  await navigator.clipboard.writeText(name).catch(() => {}); // fallback, and while we still have the click
  const inBrowser = (await getSettings()).slackIn === "browser";
  const [tab] = await chrome.tabs.query({ url: "https://app.slack.com/*" });
  if (tab || inBrowser) {
    toast(["Opening Slack chat with ", h("b", {}, name), "…"], 8000);
    const r = await openSlackDm(name, { openIfMissing: inBrowser });
    if (r.ok) return toast(["💬 Chat with ", h("b", {}, name), " is open in Slack. Type your message there."]);
    return toast([`Couldn't open the chat (${r.why}). The name is copied: in Slack press `, h("kbd", {}, KEYS.slackSearch), " and paste."], 8000);
  }
  h("a", { href: "slack://open" }).click();
  toast(["Name copied. In Slack press ", h("kbd", {}, KEYS.slackSearch), " and paste to open the chat with ", h("b", {}, name), "."]);
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
  const mine = lastResult?.key === key;
  return { issueText: entry.issueText, brief: entry.brief, netbox: mine ? lastResult.netbox : null, bmc: mine ? lastResult.bmc : null, people: entry.people || [] };
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
    openSlack
  });
  startLookups(key, entry);
  $("meta").textContent = `${entry.model} · ${new Date(entry.analyzedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}${entry.tookS ? ` · ${entry.tookS} s` : ""}${entry.hidden != null ? ` · 🔒 ${entry.hidden} hidden from AI` : ""} · v${chrome.runtime.getManifest().version}`;
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
      setStep("netbox", "run");
      const { issueText } = await chatContext(key, entry);
      nb = await netboxLookup(settings, entry.brief, issueText);
      nb.at = nb.at || Date.now();
      if (nb.ok || nb.notFound) await chrome.storage.session.set({ [cacheKey]: nb });
      if (current.key === key) setStep("netbox", nb.ok ? "ok" : "err", nb.ok ? "" : nb.notFound || nb.empty ? "not found" : "failed");
    }
    if (run !== lookupRun || current.key !== key) return;
    if (lastResult?.key === key) lastResult.netbox = nb;
    renderNetbox(box(), { nb }, actions);
  }
  if (run !== lookupRun || current.key !== key) return;
  setupBmc(key, entry, nb);
  setupParts(key, entry, nb);
  setupRma(key, entry);
  setupPing(key, entry.brief, entry.ticketIps || [], netboxPingTargets(nb));
}

// ---------- Parts catalog & stock ----------

function ticketSiteCode(brief, nb) {
  const codes = [splitSite(brief?.location?.site).code, ...(nb?.ok ? nb.devices.map((d) => d.site) : [])];
  return (codes.map((c) => String(c || "").match(/^[A-Z]{3}\d{2}/i)?.[0]).find(Boolean) || "").toUpperCase();
}

let partsView = null;

async function setupParts(key, entry, nb) {
  const settings = await getSettings();
  const usedKey = `used:${key}`;
  // The ticket's site code (e.g. ORD01), so its storage is listed first.
  const site = ticketSiteCode(entry.brief, nb);
  const saved = (await chrome.storage.session.get(usedKey))[usedKey] || [];
  const state = { loading: true, matches: [], used: new Map(saved.map((p) => [partId(p), p])) };
  const box = () => (current.key === key ? document.getElementById("catalogBox") : null);
  const draw = () => renderCatalog(box(), state, actions);
  if (lastResult?.key === key) lastResult.partsUsed = state.used;

  // Ticket, brief and NetBox text; part numbers the BMC reports for failed components are flagged.
  const match = () => {
    if (!state.catalog) return;
    const b = entry.brief;
    const failedTexts = Object.values(lastResult?.key === key ? lastResult.bmc || {} : {})
      .filter((x) => x?.ok).flatMap((x) => x.problems.map((p) => `${p.name} ${p.detail}`));
    const failed = new Set(findCatalogParts(state.catalog, failedTexts).map(partId));
    state.matches = findCatalogParts(state.catalog, [entry.issueText, b.request_summary, ...b.parts_tools, ...b.next_steps,
      ...(nb?.ok ? nb.devices.map((d) => `${d.model} ${d.assetTag}`) : []), ...failedTexts])
      .map((p) => ({ ...p, failed: failed.has(partId(p)) }))
      .sort((a, b2) => b2.failed - a.failed);
    // The server's own catalog entry, from NetBox's Lambda SKU (legacy_LPN).
    const lpns = nb?.ok ? nb.devices.map((d) => d.legacyLpn).filter(Boolean) : [];
    state.servers = state.catalog.parts.filter((p) => lpns.includes(p.legacy));
  };
  const actions = {
    onUsed: (p, on) => {
      const id = partId(p);
      on ? state.used.set(id, p) : state.used.delete(id);
      chrome.storage.session.set({ [usedKey]: [...state.used.values()] });
    },
    openRow: (row) => openUrl(catalogSheetUrl(settings.catalogUrl, row)),
    onStock: settings.netboxEnabled ? async (p, box) => {
      renderStock(box, "loading", site);
      renderStock(box, await netboxStockForPart(settings, p, site), site);
    } : null,
    onAsk: () => askAI("Which part do I need to swap? Give me the Lambda P/N."),
    onReload: async () => {
      state.loading = true;
      draw();
      await load(true);
    }
  };
  const load = async (force) => {
    try {
      state.catalog = await loadCatalog(settings.catalogUrl, force);
      state.error = "";
      match();
    } catch (e) {
      state.error = e.message;
    }
    state.loading = false;
    if (current.key === key) draw();
  };
  partsView = { key, state, update: () => { match(); draw(); } };
  draw();
  await load(false);
}

// ---------- RMA (Component Replacement under the ticket → Jira Automation opens the RMA ticket) ----------

async function setupRma(key, entry) {
  const store = `rma:${key}`;
  const state = { step: "idle", key, progress: [], choices: [], form: {}, sources: {}, touched: new Set(), result: (await chrome.storage.session.get(store))[store] || null };
  if (state.result) state.step = "done";
  const box = () => (current.key === key ? document.getElementById("rmaBox") : null);
  // Redraws keep the cursor where it was (the AI's suggestions can arrive while you type).
  const draw = () => {
    const el = document.activeElement, key_ = el?.dataset?.key, pos = el?.selectionEnd;
    renderRma(box(), state, actions);
    const again = key_ && box()?.querySelector(`[data-key="${key_}"]`);
    if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch {} }
  };
  const jira = (op, args) => rmaJira(current.tabId, op, args);
  const step = (text, s = "run") => { state.progress.push({ text, state: s }); draw(); return state.progress.at(-1); };
  const fieldId = (name) => state.meta.fields[RMA_FIELD_NAMES[name]]?.id;

  // Parts to start from: the ones ticked "Used", else the catalog matches the BMC reports as failed, else the others.
  // Parts known for certain: ticked "Used", or the BMC's failed part whose MPN is in the catalog exactly.
  // Anything else is found by its description (rmaCatalogPicker), never guessed.
  const catalog = () => (partsView?.key === key ? partsView.state.catalog : null);
  const choices = () => {
    const ps = partsView?.key === key ? partsView.state : null, out = [];
    const add = (p, src) => { if (p && !isWholeSystem(p) && !out.some((o) => partId(o) === partId(p))) out.push({ ...p, _src: src }); };
    for (const p of ps?.used?.values() || []) add(p, "part marked Used");
    for (const x of bmcProblems()) add(inCatalog("mpn", x.part_number), `catalog: MPN from BMC (${x.name})`);
    return out.slice(0, 6);
  };
  const inCatalog = (k, v) => {
    const cat = catalog();
    if (!cat || !v) return null;
    return cat.parts.find((p) => normPn(k === "lambda" ? p.lambda : p.mpn) === normPn(v)) || null; // exact only
  };
  // A Lambda P/N gives the MPN and name, and an MPN gives the Lambda P/N, from the catalog.
  const crossFill = () => {
    const f = state.form;
    if (!f.lambda && f.mpn) { const p = inCatalog("mpn", f.mpn); if (p?.lambda) suggest("lambda", p.lambda, "catalog, from MPN"); }
    if (f.lambda && !f.mpn) { const p = inCatalog("lambda", f.lambda); if (p?.mpn) suggest("mpn", p.mpn, "catalog, from Lambda P/N"); }
    const named = inCatalog("lambda", f.lambda);
    if (named) f.partName = [named.vendor, named.name].filter(Boolean).join(" ");
  };
  // Pre-filled values and where they came from (shown next to each field until the user edits it).
  const suggest = (k, value, source, { replace = false } = {}) => {
    if (!value || state.touched.has(k)) return false;
    if (state.form[k] && !replace && !/guess|default/.test(state.sources[k] || "")) return false; // keep the stronger source
    state.form[k] = value;
    state.sources[k] = source;
    return true;
  };
  const bmcProblems = () => Object.values(lastResult?.key === key ? lastResult.bmc || {} : {}).filter((x) => x?.ok).flatMap((x) => x.problems);
  const usePart = (p, source) => {
    for (const k of ["lambda", "mpn", "component"]) if (!state.touched.has(k)) { delete state.form[k]; delete state.sources[k]; }
    state.form.partName = p ? [p.vendor, p.name].filter(Boolean).join(" ") : "";
    if (p && !state.touched.has("partDesc") && !state.form.partDesc) { state.form.partDesc = state.form.partName; state.sources.partDesc = source; }
    suggest("lambda", p?.lambda, source);
    suggest("mpn", p?.mpn || p?.vendorPn, source);
    suggest("component", guessComponent(state.meta.fields[RMA_FIELD_NAMES.component]?.options || [], p, entry.issueText || ""), "guessed");
    // The failed part the BMC reports: its own serial is the old S/N (helper 1.6.2+), its part number the MPN.
    const kind = /^206|^204/.test(p?.lambda || "") ? /gpu|processor/i : /^207/.test(p?.lambda || "") ? /memory|dimm/i : /^20[89]/.test(p?.lambda || "") ? /storage|drive/i : null;
    const probs = bmcProblems();
    const prob = probs.find((x) => kind?.test(`${x.component} ${x.name}`) && x.serial) || (probs.length === 1 ? probs[0] : null);
    if (prob?.serial) suggest("oldSn", cleanSn(prob.serial), `from BMC (${prob.name})`, { replace: /BMC/.test(state.sources.oldSn || "") });
    if (prob?.part_number) suggest("mpn", prob.part_number, `from BMC (${prob.name})`);
  };
  // The failed part's description: the BMC's model for it, or the brief's parts list, whichever matches the catalog best.
  const seedDescription = () => {
    const texts = [...bmcProblems().map((x) => x.detail).filter((d) => /[a-z]{2,}.*\s/i.test(d || "")), ...entry.brief.parts_tools];
    let best = "", top = 0;
    for (const t of texts) {
      const m = catalogByDescription(catalog(), t, 1)[0];
      if (m && m.score > top) { best = t; top = m.score; }
    }
    return best;
  };
  // A catalog part by any of its numbers (Lambda P/N, SKU, MPN; an MPN prefix like AOM-SXM5-IO also matches).
  const partById = (id) => {
    const cat = catalog(), n = normPn(id);
    if (!cat || !n) return null;
    return cat.parts.find((p) => [p.lambda, p.legacy, p.mpn].some((x) => x && normPn(x) === n)) || findCatalogParts(cat, [id]).find((p) => !p.system) || null;
  };
  const strongPart = () => /NetBox|Used|BMC|picked/.test(state.sources.lambda || "") || state.touched.has("lambda");
  const usePartFirmly = (p, source) => {
    for (const k of ["lambda", "mpn"]) { delete state.form[k]; delete state.sources[k]; }
    usePart(p, source);
  };
  // 1st source of truth for which part it is: the serials. NetBox knows the spare you installed (inventory "<P/N>_<serial>")
  // or the part you removed (installed module); that P/N is then taken from the catalog.
  let serialRun = 0;
  const verifySerials = async () => {
    const settings = await getSettings();
    if (!settings.netboxEnabled || !catalog()) return;
    const run = ++serialRun, f = state.form, found = [];
    for (const [which, sn] of [["new", f.newSn], ["old", f.oldSn]]) {
      if (!sn) continue;
      const r = await netboxPartBySerial(settings, sn);
      if (r) found.push({ which, sn, ...r, part: partById(r.id) });
    }
    if (run !== serialRun || state.step !== "form") return;
    state.warnings = state.warnings.filter((w) => !/^NetBox/.test(w));
    state.pinned = (state.pinned || []).filter((x) => !x.serial);
    state.serialNote = "";
    for (const x of found.filter((x) => !x.part)) state.warnings.push(`NetBox says the ${x.which} S/N ${x.sn} is ${x.id}, which isn't in the catalog. Check the part in the catalog.`);
    const known = found.filter((x) => x.part);
    if (known.length) {
      const best = known[0]; // the new (installed) part first
      if (new Set(known.map((x) => partId(x.part))).size > 1) state.warnings.push(`NetBox: the new S/N is ${partId(known[0].part)} but the old S/N is ${partId(known[1].part)}. Check both labels.`);
      state.pinned.unshift({ part: best.part, serial: true, tags: [`NetBox ✓ ${best.which} S/N`] });
      if (partId(best.part) === state.form.lambda && !state.touched.has("lambda")) {
        for (const k of ["lambda", "mpn"]) if (state.form[k]) state.sources[k] = `NetBox ✓ ${best.which} S/N`;
      } else if (partId(best.part) !== state.form.lambda) {
        if (state.touched.has("lambda") || /picked/.test(state.sources.lambda || "")) {
          state.warnings.push(`NetBox: the ${best.which} S/N ${best.sn} is ${partId(best.part)}, but you chose ${state.form.lambda}. Check which part you swapped.`);
        } else {
          if (state.form.lambda) state.warnings.push(`NetBox: the ${best.which} S/N ${best.sn} is ${partId(best.part)}, not ${state.form.lambda}. Switched to it.`);
          usePartFirmly(best.part, `NetBox: ${best.which} S/N is ${best.id}`);
        }
      }
      state.serialNote = `🔎 NetBox: the ${best.which} S/N ${best.sn} is ${best.id} (${best.where}).`;
    }
    draw();
  };
  // Next: what techs used before on this server model for this component (past RMA tickets), mapped to catalog parts.
  let historyRun = 0;
  const loadHistory = async () => {
    const component = state.form.component;
    if (!component || !catalog()) return;
    const run = ++historyRun;
    const r = await jira("history", { dcKey: key, project: RMA_PROJECT, component });
    if (run !== historyRun || !r.ok || state.step !== "form") return;
    const byPart = new Map();
    for (const [id, n] of Object.entries(r.counts || {})) {
      const p = partById(id);
      if (!p || isWholeSystem(p)) continue;
      byPart.set(partId(p), { part: p, n: (byPart.get(partId(p))?.n || 0) + n });
    }
    const list = [...byPart.values()].sort((a, b) => b.n - a.n);
    Object.assign(state, { historyModel: r.model, historyCount: Object.fromEntries(list.map((x) => [partId(x.part), x.n])) });
    state.pinned = [...(state.pinned || []).filter((x) => !x.history), ...list.slice(0, 3).map((x) => ({ part: x.part, history: true, tags: [`used ${x.n}× on ${r.model}`] }))];
    state.warnings = state.warnings.filter((w) => !/techs used/.test(w));
    const total = list.reduce((s_, x) => s_ + x.n, 0), top = list[0];
    if (top && top.n >= 3 && top.n / total >= 0.7) {
      if (!state.form.lambda && !state.touched.has("lambda")) usePartFirmly(top.part, `used ${top.n}× on ${r.model}: check`);
      else if (state.form.lambda && partId(top.part) !== state.form.lambda && !strongPart()) {
        state.warnings.push(`On ${r.model}, techs used ${partId(top.part)} (${top.n}×) for “${component}”, not ${state.form.lambda}. Check which one you swapped.`);
      }
    }
    draw();
  };
  // Fill the part in only when the description matches one catalog description exactly and nothing else comes close
  // (e.g. two 64GB DDR5-4800 DIMMs from different vendors): otherwise the user chooses from the list.
  const autoFromDescription = (source) => {
    if (strongPart()) return; // a serial, a ticked part or the BMC already decided
    const all = catalogByDescription(catalog(), state.form.partDesc, 20).filter((m) => !serverMismatch(state.serverText, m.part));
    const exact = all.filter((m) => m.exact);
    if (!exact.length) return;
    const same = exact.filter((m) => descKey(m.part) === descKey(exact[0].part));
    if (same.length < exact.length) return; // different parts fit: the user chooses
    if (all.some((m) => !same.includes(m) && m.coverage >= 0.75)) return; // another part is close: the user chooses
    const pick = same.find((m) => !m.part.inactive) || same[0];
    for (const k of ["lambda", "mpn"]) { delete state.form[k]; delete state.sources[k]; }
    usePart(pick.part, source);
    const others = [...new Set([...same.map((m) => partId(m.part)), ...pick.sameAs])].filter((id) => id !== partId(pick.part));
    if (others.length) state.warnings.push(`The same description is also listed under ${others.join(", ")}. Check which P/N is on the part you swapped.`);
  };
  const failure = () => {
    const b = entry.brief;
    const bmc = bmcProblems().map((p) => `BMC: ${p.name.includes(p.component) ? p.name : `${p.component} ${p.name}`} ${p.health}${p.detail ? `: ${p.detail}` : ""}`);
    return [b.request_summary, b.probable_cause && `Probable cause: ${b.probable_cause}`, ...bmc].filter(Boolean).join("\n");
  };
  // The AI reads the ticket, the BMC and the catalog candidates for what's still missing; serials it can't point to are dropped.
  let aiRun = 0;
  const aiPrefill = async () => {
    const settings = await getSettings();
    if (missingConfig(settings)) return;
    const run = ++aiRun;
    Object.assign(state, { aiBusy: true, aiNote: "" });
    draw();
    const opts = (n) => state.meta.fields[RMA_FIELD_NAMES[n]]?.options || [];
    const bmcText = bmcProblems().map((p) => `${p.component} ${p.name} ${p.health} ${p.detail} SN ${p.serial || "?"} PN ${p.part_number || "?"}`).join("; ");
    const sourceText = `${entry.issueText || ""} ${bmcText}`;
    let filled = 0, note = "";
    try {
      const r = await rmaAiPrefill(settings, makeRedactor(settings, entry.people), {
        key, issueText: entry.issueText, bmc: bmcText, components: opts("component"), rmaTypes: opts("rmaType"),
        parts: [...state.choices, ...(catalog() ? catalogRowsFor(catalog(), [entry.issueText, entry.brief.request_summary, ...entry.brief.parts_tools, bmcText]) : [])]
          .filter((p, i, all) => !isWholeSystem(p) && all.findIndex((q) => partId(q) === partId(p)) === i).slice(0, 20)
          .map((p) => `${p.lambda || "-"} | ${p.legacy || "-"} | ${p.mpn || "-"} | ${[p.vendor, p.name].filter(Boolean).join(" ")}`).join("\n")
      });
      if (run !== aiRun || state.step !== "form") return;
      const AI = "✨ AI: check";
      // The AI describes the part; the catalog decides the P/N (only on an exact description match).
      if (!state.form.lambda && suggest("partDesc", r.part_description, AI)) { filled++; autoFromDescription("catalog: exact description (AI)"); }
      filled += suggest("mpn", r.mpn, AI);
      if (serialIn(r.old_sn, sourceText)) filled += suggest("oldSn", cleanSn(r.old_sn), AI);
      if (serialIn(r.new_sn, sourceText)) filled += suggest("newSn", cleanSn(r.new_sn), AI);
      if (opts("component").includes(r.component)) filled += suggest("component", r.component, AI);
      if (opts("rmaType").includes(r.rma_type)) filled += suggest("rmaType", r.rma_type, AI);
      if (String(r.description || "").trim().length > 15) filled += suggest("description", r.description.trim(), AI, { replace: !state.touched.has("description") });
      crossFill();
      note = filled ? `✨ The AI filled in or improved ${filled} field${filled === 1 ? "" : "s"}. Check them.` : "✨ The AI found nothing more to fill in.";
    } catch (e) {
      if (run !== aiRun) return;
      note = `✨ The AI couldn't help (${e.message}). Fill in the rest yourself.`;
    }
    Object.assign(state, { aiBusy: false, aiNote: note });
    if (state.step === "form") draw();
  };

  // The ticket already has an RMA ticket: add the part and serials to it as an internal comment.
  const addToExisting = async (f) => {
    const target = state.target;
    Object.assign(state, { step: "running", error: "", progress: [] });
    const s = step(`Adding the part and serials to ${target}…`);
    const r = await jira("comment", { key: target, body: rmaComment(f, key) });
    if (!r.ok) {
      s.state = "err";
      Object.assign(state, { step: "review", error: `Couldn't add the comment: ${r.error}` });
      return draw();
    }
    Object.assign(s, { state: "ok", text: `Added to ${target} as an internal comment (no new RMA ticket)` });
    state.result = { links: [target], added: true, part: f.partName || f.lambda || f.mpn, oldSn: f.oldSn, newSn: f.newSn };
    await chrome.storage.session.set({ [store]: state.result });
    if (lastResult?.key === key) lastResult.rma = state.result;
    toast(`Added to ${target}.`, 4000);
    state.step = "done";
    draw();
  };

  const actions = {
    onStart: async () => {
      Object.assign(state, { step: "loading", error: "", progress: [], problems: [] });
      draw();
      const meta = await jira("meta", { project: RMA_PROJECT, defaultKind: RMA_DEFAULT_KIND });
      if (!meta.ok) return Object.assign(state, { step: state.result ? "done" : "idle", error: `Couldn't read the RMA project: ${meta.error}` }) && draw();
      // An RMA ticket already open for this ticket: add to it instead of creating another.
      const existing = await jira("existing", { key, rmaProject: RMA_PROJECT });
      if (!existing.ok) return Object.assign(state, { step: state.result ? "done" : "idle", error: `Couldn't check for an existing RMA: ${existing.error}` }) && draw();
      Object.assign(state, { meta, existing: existing.rmas, target: existing.rmas[0]?.key, choices: choices(), form: {}, sources: {}, touched: new Set(), aiNote: "",
        pinned: [], historyCount: {}, historyModel: "", serialNote: "" });
      const first = state.choices[0];
      state.catalog = catalog();
      state.form.kind = meta.defaultKind;
      // What the server is (for "doesn't fit this server"): its NetBox record, its catalog entry ("8-H100 … Chassis") and the ticket.
      state.serverText = [...(lastResult?.key === key && lastResult.netbox?.ok ? lastResult.netbox.devices.map((d) => `${d.model} ${d.legacyLpn || ""}`) : []),
        ...(partsView?.key === key ? (partsView.state.servers || []).map((p) => `${p.vendor} ${p.name} ${p.desc}`) : []),
        entry.brief.request_summary, String(entry.issueText || "").slice(0, 4000)].join(" ");
      // The server's hostname for the summary ("ord01-cl01-hgx-0084 - replace …"): a server name, not a serial.
      state.form.hostname = entry.brief.server_names.find((n) => /[a-z].*[-.].*\d|\d.*[-.].*[a-z]/i.test(n) && /-/.test(n)) || "";
      state.warnings = [];
      if (first) usePart(first, first._src);
      else {
        suggest("partDesc", seedDescription(), "from ticket/BMC");
        autoFromDescription("catalog: exact description");
      }
      // These don't depend on the exact P/N: the BMC's failed part gives the old S/N, the description the component.
      const probs = bmcProblems().filter((x) => x.serial);
      if (probs.length === 1) suggest("oldSn", cleanSn(probs[0].serial), `from BMC (${probs[0].name})`);
      suggest("component", guessComponent(state.meta.fields[RMA_FIELD_NAMES.component]?.options || [], { name: state.form.partDesc }, entry.issueText || ""), "guessed");
      crossFill();
      suggest("description", failure(), "from ticket & BMC");
      const inTicket = serialsInText(entry.issueText);
      suggest("oldSn", inTicket.oldSn, "from ticket");
      suggest("newSn", inTicket.newSn, "from ticket");
      // The ticket and the BMC disagree about the old S/N: say so instead of silently picking one.
      if (inTicket.oldSn && state.form.oldSn && inTicket.oldSn !== state.form.oldSn) {
        state.warnings.push(`The ticket mentions old S/N ${inTicket.oldSn}, but the BMC reports ${state.form.oldSn}. Check the label on the part you removed.`);
      }
      state.step = "form";
      draw();
      verifySerials();
      loadHistory();
      aiPrefill();
    },
    onSerial: () => { clearTimeout(state.serialTimer); state.serialTimer = setTimeout(verifySerials, 700); },
    onComponent: () => loadHistory(),
    onPickPart: (p, src) => {
      for (const k of ["lambda", "mpn"]) { state.touched.delete(k); delete state.form[k]; delete state.sources[k]; }
      state.warnings = state.warnings.filter((w) => !/same description/.test(w));
      usePart(p, src || "picked from catalog");
      crossFill();
      draw();
    },
    // Clear the card: form, suggestions, errors and the saved result. Nothing in Jira changes.
    onReset: async () => {
      aiRun++;
      Object.assign(state, { step: "idle", error: "", progress: [], problems: [], warnings: [], form: {}, sources: {}, touched: new Set(),
        existing: null, target: null, aiBusy: false, aiNote: "", result: null, pinned: [], historyCount: {}, historyModel: "", serialNote: "" });
      await chrome.storage.session.remove(store);
      if (lastResult?.key === key) lastResult.rma = null;
      draw();
    },
    onCancel: () => { aiRun++; Object.assign(state, { step: state.result ? "done" : "idle", problems: [], aiBusy: false }); draw(); },
    onReview: () => {
      const f = state.form;
      Object.assign(f, { lambda: String(f.lambda || "").trim(), mpn: String(f.mpn || "").trim(), oldSn: cleanSn(f.oldSn), newSn: cleanSn(f.newSn), description: String(f.description || "").trim() });
      state.problems = rmaProblems(f);
      if (!state.problems.length) aiRun++; // a late AI answer must not change values you're reviewing
      state.step = state.problems.length ? "form" : "review";
      state.aiBusy = false;
      draw();
    },
    onEdit: () => { state.step = "form"; draw(); },
    onCreate: async () => {
      const f = state.form;
      if (state.existing?.length) return addToExisting(f);
      Object.assign(state, { step: "running", error: "", progress: [] });
      const kind = state.meta.kinds.find((k) => k.name === f.kind) || state.meta.kinds[0];
      // The part and serials you confirmed. Only fields with a value.
      const fields = {};
      for (const [k, v] of [["mpn", f.mpn], ["oldSn", f.oldSn], ["newSn", f.newSn], ["faultyPn", f.lambda || f.mpn]]) if (v && fieldId(k)) fields[fieldId(k)] = v;
      for (const k of ["component", "rmaType"]) if (f[k] && fieldId(k)) fields[fieldId(k)] = { value: f[k] };
      let rma = null, s_;
      try {
        s_ = step(`Creating the ${kind.name} RMA ticket…`);
        const created = await jira("createRma", { project: RMA_PROJECT, dcKey: key, kind, summary: rmaSummary(f), description: rmaDescription(f, key), fields });
        if (!created.ok) throw new Error(created.error);
        rma = created.key;
        Object.assign(s_, { state: "ok", text: `Created ${rma}${created.copied.length ? ` with ${created.copied.length} server details from ${key}` : ""}` });
        s_ = step(`Linking ${rma} to ${key}…`);
        const linked = await jira("link", { from: rma, to: key });
        Object.assign(s_, linked.ok ? { state: "ok", text: `Linked to ${key} (relates to)` } : { state: "warn", text: `Couldn't link it to ${key} (${linked.error}): link it in Jira` });
        state.result = { links: [rma], part: f.partName || f.lambda || f.mpn, oldSn: f.oldSn, newSn: f.newSn };
        await chrome.storage.session.set({ [store]: state.result });
        if (lastResult?.key === key) lastResult.rma = state.result;
        toast(`${rma} created and linked to ${key}.`, 5000);
      } catch (e) {
        if (s_) s_.state = "err";
        state.error = e.message;
      }
      state.step = rma ? "done" : "review";
      draw();
    },
    openIssue: (k) => openUrl(`${current.origin}/browse/${k}`)
  };
  if (lastResult?.key === key && state.result) lastResult.rma = state.result;
  draw();
}

// ---------- BMC (pasted login: Redfish health, remote console, power) ----------

// The BMC card of the ticket on screen, so ping results can update it when they arrive.
let bmcView = null;

// Ping result per IP (from the Reachability check) → the BMC card warns when its BMC doesn't answer.
function pingByIp(ping) {
  return Object.fromEntries((ping?.results || []).map((x) => [x.address, x]));
}

async function setupBmc(key, entry, nb) {
  const settings = await getSettings();
  const who = bmcTargets(entry.brief, nb, findSerialsInText(entry.issueText || ""));
  const cacheKey = `bmc:${key}`;
  const state = {
    who, showLogin: {}, creds: {}, power: {}, console: {}, pending: {}, user: settings.bmcUser || "ADMIN",
    verdict: entry.brief.power_down, reach: pingByIp(lastResult?.key === key ? lastResult.ping : null),
    health: (await chrome.storage.session.get(cacheKey))[cacheKey] || {}
  };
  const box = () => (current.key === key ? document.getElementById("bmcBox") : null);
  const draw = () => renderBmc(box(), state, actions);
  const saveHealth = async () => {
    const ok = Object.fromEntries(Object.entries(state.health).filter(([, x]) => x?.ok));
    await chrome.storage.session.set({ [cacheKey]: ok });
    if (lastResult?.key === key) lastResult.bmc = ok;
  };
  const readHealth = async (ip) => {
    state.health[ip] = "loading";
    draw();
    const x = await readBmcHealth(ip, state.creds[ip]);
    state.health[ip] = x;
    if (x.ok) state.showLogin[ip] = false;
    else if (/rejected the login/i.test(x.error || "") && state.creds[ip]) { delete state.creds[ip]; state.showLogin[ip] = true; }
    await saveHealth();
    if (partsView?.key === key) partsView.update(); // failed parts from the BMC → catalog lookup
    draw();
  };
  // Remote console: the helper asks the BMC for a console link with a one-time login, opened in a new tab.
  const openConsole = async (ip) => {
    state.console[ip] = "loading";
    state.showLogin[ip] = false;
    draw();
    const resp = await bmcConsole(ip, state.creds[ip]);
    if (resp.ok) {
      chrome.tabs.create({ url: new URL(bmcUrl(settings.bmcUrl, ip)).origin + resp.uri });
    } else if (/rejected the login/i.test(resp.error || "")) {
      delete state.creds[ip];
      state.pending[ip] = "console";
      state.showLogin[ip] = true;
    }
    state.console[ip] = resp.ok ? { ok: true } : resp;
    draw();
  };
  // No password yet: ask for it (the clipboard is left alone, it may already hold the password), then do what was asked.
  const needLogin = (ip, then) => {
    if (state.creds[ip]) return false;
    state.pending[ip] = then;
    state.showLogin[ip] = true;
    draw();
    return true;
  };
  const actions = {
    openBmc,
    onSetup: () => chrome.runtime.openOptionsPage(),
    onLogin: (ip, login) => {
      state.creds[ip] = login; // memory only, for "↻ Health", the console and power actions
      const then = state.pending[ip];
      delete state.pending[ip];
      if (then === "console") openConsole(ip);
      else readHealth(ip);
    },
    onHealth: (ip) => needLogin(ip, "health") || readHealth(ip),
    onConsole: (ip) => needLogin(ip, "console") || openConsole(ip),
    onPowerOpen: (ip, open) => {
      state.power[ip] = { open };
      draw();
    },
    onPower: async (ip, resetType, confirm) => {
      if (!state.creds[ip]) {
        state.power[ip] = { result: { ok: false, error: "Paste the BMC password first (click ↻ Health)." } };
        state.showLogin[ip] = true;
        return draw();
      }
      state.power[ip] = { busy: true };
      draw();
      const label = { GracefulShutdown: "Shutdown", ForceOff: "Force off", On: "Power on" }[resetType];
      const resp = await bmcPower(ip, state.creds[ip], resetType, confirm);
      state.power[ip] = { result: { ...resp, label } };
      if (resp.ok && lastResult?.key === key) {
        lastResult.bmcPower = [...(lastResult.bmcPower || []), { ip, label, at: resp.at, before: resp.before }];
      }
      draw();
      // Read the power state again once the server had time to react.
      if (resp.ok) setTimeout(() => current.key === key && readHealth(ip), resetType === "GracefulShutdown" ? 20000 : 8000);
    }
  };
  bmcView = { key, state, draw };
  if (lastResult?.key === key) lastResult.bmc = state.health;
  draw();
}

// ---------- Reachability ----------

function updateBmcReach(key, ping) {
  if (!ping?.ok || bmcView?.key !== key) return;
  bmcView.state.reach = pingByIp(ping);
  bmcView.draw();
}

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
    setStep("ping", "run");
    const resp = await runPing(targets);
    if (current.key === key) {
      const up = (resp.results || []).filter((x) => x.reachable).length;
      setStep("ping", resp.ok ? (up === resp.results.length ? "ok" : "err") : "err", resp.ok ? `${up}/${resp.results.length} up` : "");
    }
    if (resp.ok) await chrome.storage.session.set({ [cacheKey]: resp });
    if (run === pingRun && lastResult?.key === key) lastResult.ping = resp.ok ? resp : null;
    if (run === pingRun) renderPing(box(), { targets, resp }, actions);
    updateBmcReach(key, resp);
  }

  if (lastResult?.key === key) lastResult.ping = cached || null;
  updateBmcReach(key, cached);
  const sameTargets = cached?.results && targets.map((t) => t.address).sort().join() === cached.results.map((x) => x.address).sort().join();
  const fresh = cached && sameTargets && Date.now() - cached.at < PING_MAX_AGE_MS;
  if (fresh || !settings.pingAuto) renderPing(box(), { targets, resp: cached }, actions);
  else doPing();
}

// ---------- Update banner ----------
// Shown when GitHub has a newer version: checked when the panel opens (at most every 2 hours) and on every
// Analyze / Re-analyze (always). "Later" hides it until the next version.

async function showUpdateBar(force = false) {
  const u = await checkForUpdate(force);
  showUpdateBadge(u);
  const { updateLater } = await chrome.storage.local.get("updateLater");
  if (!u.available || updateLater === u.latest) return $("updateBar").classList.add("hidden");
  const steps = updateSteps();
  steps.classList.add("hidden");
  $("updateBar").replaceChildren(
    h("div", { class: "update-head" },
      h("span", {}, h("b", {}, `🆕 Version ${u.latest} is available`), h("span", { class: "muted" }, ` (you have ${u.current})`)),
      h("button", { class: "mini primary", onclick: () => steps.classList.toggle("hidden") }, "⬇️ Update"),
      h("a", { href: UPDATE_LINKS.changes, target: "_blank", rel: "noopener" }, "What's new"),
      h("button", { class: "mini subtle", onclick: async () => {
        await chrome.storage.local.set({ updateLater: u.latest });
        $("updateBar").classList.add("hidden");
        showUpdateBadge(u);
      } }, "Later")),
    steps);
  $("updateBar").classList.remove("hidden");
}

// ---------- Start screen (no ticket in this tab) ----------
// Says what to do, and lists the Jira tickets already open in other tabs so one click goes there.

async function renderEmpty(tab, settings) {
  const onJira = !!tab?.url && isJiraUrl(tab.url, settings);
  const patterns = ["https://*.atlassian.net/*", ...settings.jiraHosts.flatMap((h) => [`https://${h}/*`, `http://${h}/*`])];
  const tickets = (await chrome.tabs.query({ url: patterns }).catch(() => []))
    .map((t) => ({ t, key: parseIssueKey(t.url) })).filter((x) => x.key && x.t.id !== tab?.id)
    .filter((x, i, all) => all.findIndex((y) => y.key === x.key) === i).slice(0, 6);
  const { lastJira } = await chrome.storage.local.get("lastJira");
  const goTo = async (t) => {
    await chrome.tabs.update(t.id, { active: true });
    await chrome.windows.update(t.windowId, { focused: true });
  };
  const noKey = missingConfig(settings);
  $("empty").replaceChildren(...[
    h("div", { class: "empty-icon" }, "🎫"),
    h("h2", {}, onJira ? "Open a ticket to start" : "Go to a Jira ticket tab to start"),
    h("p", { class: "muted" }, onJira
      ? "You're in Jira, but no ticket is open here. Click a ticket in your queue and its brief appears here."
      : `This panel works on the Jira ticket in the current tab. Switch to a ticket tab (or open one) and ${settings.autoRun ? "the brief appears here automatically" : "click Analyze"}.`),
    noKey && h("div", { class: "empty-setup" }, "⚙️ First, add your AI key: ",
      h("button", { class: "link", onclick: () => chrome.runtime.openOptionsPage() }, "open Settings")),
    tickets.length && h("div", { class: "empty-tabs" },
      h("div", { class: "label" }, "Tickets open in your tabs"),
      ...tickets.map(({ t, key }) => h("button", { class: "empty-tab", title: t.title, onclick: () => goTo(t) },
        h("b", {}, key), h("span", { class: "muted" }, String(t.title || "").replace(/^\[[^\]]+\]\s*/, "").replace(/\s+-\s+Jira.*$/i, "")), "→"))),
    !tickets.length && !onJira && lastJira && h("button", { class: "primary empty-open", onclick: () => openUrl(`${lastJira}/jira/your-work`) }, "Open Jira")
  ].filter(Boolean));
  $("empty").classList.remove("hidden");
}

// ---------- Analyze & tab events ----------

async function analyze(force = false) {
  if (!current.key || current.running) return;
  showUpdateBar(true).catch((e) => console.warn("update check", e)); // every analysis also checks for a new version
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
    setStatus("");
    resetSteps();
    setStep("ticket", "run");
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

    const people = issuePeople(issue.data);
    const privacy = makeRedactor(settings, people);
    const started = Date.now();
    setStep("ticket", "ok");
    setStep("ai", "run", providerLabel(settings.provider).replace(/ \(.*\)/, ""));
    const tick = setInterval(() => current.key === key && setStep("ai", "run", `${Math.round((Date.now() - started) / 1000)} s`), 1000);
    let brief, model;
    // Show the brief as it is written. The power verdict stays "checking" until the AI has moved past it.
    const onPartial = (partial, raw) => {
      if (current.key !== key) return;
      renderBrief($("result"), partial, { key, meta: issueMeta(issue.data), partial: true, powerPending: !("request_summary" in raw), openSlack });
      $("result").classList.remove("hidden");
    };
    try {
      ({ brief, model } = await analyzeIssue(settings, key, text, onPartial, privacy));
    } finally {
      clearInterval(tick);
    }
    setStep("ai", "ok", `${Math.round((Date.now() - started) / 1000)} s`);
    // Exact field mappings (if configured) win over the model's extraction.
    if (mapped.server) brief.server_names = mapped.server.split(/\s*,\s*/).filter(Boolean);
    if (mapped.location && !locationText(brief.location)) brief.location.site = mapped.location;

    const entry = { brief, model, meta: issueMeta(issue.data), ticketIps: findIPsInText(text), issueText: text, analyzedAt: Date.now(), tookS: Math.round((Date.now() - started) / 1000),
      people, hidden: privacy.on ? privacy.hidden : null };
    await chrome.storage.session.set({ [cacheKey]: entry });
    if (force) await chrome.storage.session.remove(`checks:${key}`);
    if (current.key === key) {
      setStatus("");
      await show(key, entry);
    }
  } catch (e) {
    if (current.key === key) hideResult(); // don't leave a half-written brief on screen
    for (const n of ["ticket", "ai"]) if (steps[n]?.state === "run") setStep(n, "err");
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

  if (key === current.key && tab?.id === current.tabId) {
    if (!key) renderEmpty(tab, settings); // other tabs may have changed
    return;
  }
  current.tabId = tab?.id ?? null;
  current.key = key;
  current.origin = tab?.url ? new URL(tab.url).origin : "";
  resetSteps();

  $("issueKey").textContent = key || "No ticket open";
  $("analyzeBtn").disabled = !key;
  $("analyzeBtn").textContent = "Analyze";
  hideResult();
  setStatus("");
  if (!key) return renderEmpty(tab, settings);
  $("empty").classList.add("hidden");
  chrome.storage.local.set({ lastJira: current.origin }); // for "Open Jira" on the start screen

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

$("settingsBtn").replaceChildren(icon("settings", 16));
$("chatSend").replaceChildren(icon("send", 15));

$("analyzeBtn").addEventListener("click", () => analyze(true));
$("settingsBtn").addEventListener("click", () => chrome.runtime.openOptionsPage());
// Copy as Jira comment (button at the end of the brief).
async function copyComment() {
  if (!lastResult) return;
  const comment = [asJiraComment(lastResult.key, lastResult.brief, lastResult.ping, lastResult.netbox, lastResult.bmc, lastResult.bmcPower),
    ...partsCommentLines(lastResult.partsUsed), ...rmaCommentLines(lastResult.rma)].join("\n");
  await navigator.clipboard.writeText(comment);
  $("copyBtn").textContent = "✅ Copied";
  toast("Copied. Paste it as a comment in the Jira ticket.", 3000);
  setTimeout(() => ($("copyBtn").textContent = "📋 Copy as Jira comment"), 1500);
}
$("copyBtn").addEventListener("click", copyComment);

fillDevContact();
showUpdateBar().catch((e) => console.warn("update check", e));
refresh();
