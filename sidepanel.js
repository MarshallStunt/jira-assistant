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
// Every section of the brief, in page order; each has its own colour (styles.css → section colours).
const JUMPS = [["📋 Request", "request"], ["🖥️ Server", "server"], ["🔧 BMC", "bmcBox"], ["✅ Steps", "steps"], ["🧰 Parts", "parts"],
  ["🔁 RMA", "rmaBox"], ["🕘 History", "history"], ["🗄️ NetBox", "netboxBox"]];

function updateJump() {
  const nav = $("jump");
  const visible = !$("result").classList.contains("hidden");
  const items = JUMPS.filter(([, id]) => visible && $(id) && !$(id).classList.contains("hidden") && $(id).childElementCount);
  nav.classList.toggle("hidden", items.length < 2);
  const shown = [...nav.children].map((b) => b.dataset.for).join();
  if (shown !== items.map(([, id]) => id).join()) {
    nav.replaceChildren(...items.map(([label, id]) => h("button", { class: "jump-link", "data-for": id, onclick: () => jumpTo(id) }, label)));
  }
  // Progress on the chips: steps ticked ("✅ Steps 2/5", "✓" when all are), RMA ticket created.
  for (const b of nav.children) {
    const [label] = JUMPS.find(([, id]) => id === b.dataset.for), box = $(b.dataset.for);
    let extra = "";
    if (b.dataset.for === "steps") {
      const [done, all] = (box.querySelector(".count")?.textContent || "").split("/").map(Number);
      extra = all ? (done === all ? " ✓" : ` ${done}/${all}`) : "";
      b.classList.toggle("done", !!all && done === all);
    }
    if (b.dataset.for === "rmaBox") {
      extra = box.querySelector(".rma-result") ? " ✓" : "";
      b.classList.toggle("done", !!extra);
    }
    if (b.textContent !== label + extra) b.textContent = label + extra;
  }
  markCurrent();
}
let jumpFrame;
// A short timer, not an animation frame: frames don't run while the panel is in the background.
new MutationObserver(() => { clearTimeout(jumpFrame); jumpFrame = setTimeout(() => { updateGlance(); updateJump(); }, 30); })
  .observe($("result"), { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });

// You are here: the section you're reading is lit up, in the jump bar and on the page.
function markCurrent() {
  const nav = $("jump"), bar = document.querySelector(".bar").getBoundingClientRect().bottom;
  const line = bar + (innerHeight - bar) * 0.35; // the section crossing a third of the way down is the one you're reading
  const ids = [...nav.children].map((b) => b.dataset.for);
  let current = ids[0];
  for (const id of ids) if ($(id).getBoundingClientRect().top <= line) current = id;
  for (const b of nav.children) {
    const on = b.dataset.for === current;
    if (on && !b.classList.contains("active")) b.scrollIntoView({ block: "nearest", inline: "nearest" });
    b.classList.toggle("active", on);
  }
  for (const [, id] of JUMPS) $(id)?.classList.toggle("current", id === current && ids.length > 1);
}
let spyFrame;
addEventListener("scroll", () => { cancelAnimationFrame(spyFrame); spyFrame = requestAnimationFrame(markCurrent); }, { passive: true });

// ---------- At a glance ----------
// One card at the top with what matters, from live systems first (NetBox, ping, BMC, catalog & stock) and the
// ticket only for the job itself. Each row opens its section. Rebuilt when anything on the page changes.
let glanceSig = "", glanceStock = { id: "", data: null };
let glanceBrief = null; // { key, brief }: the brief being shown, also while the AI is still writing it

function jumpTo(id) {
  const target = $(id);
  if (!target) return;
  if (target.tagName === "DETAILS") target.open = true;
  target.scrollIntoView({ behavior: "smooth", block: "start" });
}

function glanceRows(r) {
  const rows = [], live = lastResult?.key === current.key ? lastResult : {}; // lookups (NetBox, ping, BMC) once they're in
  const dev = live.netbox?.ok ? live.netbox.devices[0] : null;
  // The job (from the ticket)
  const job = String(r.request_summary || "").split(/(?<=[.!?])\s/)[0];
  if (r.task_type || job) rows.push({ icon: "🎯", key: r.task_type || "Job", text: job, jump: "request" });
  // Where: NetBox's record wins over what the ticket says
  const loc = r.location, site = splitSite(loc.site).code;
  const where = dev
    ? [dev.name, dev.site, dev.rack && `rack ${dev.rack}`, dev.position != null && `RU ${dev.position}`]
    : [r.server_names[0], site, loc.rack && `rack ${loc.rack}`, loc.unit && `RU ${loc.unit}`];
  const mism = dev?.mismatches?.length || 0;
  if (where.some(Boolean)) rows.push({ icon: "📍", key: "Where", text: where.filter(Boolean).join(" · "),
    note: dev ? (mism ? `⚠️ ${mism} mismatch${mism > 1 ? "es" : ""} with the ticket` : "NetBox ✓") : live.netbox ? "from the ticket" : "from the ticket · checking NetBox…", tone: mism ? "warn" : "", jump: "server" });
  // Live: ping, plus the BMC's power state and failed parts once health was read
  const ping = live.ping?.results || [];
  const bmcHealth = Object.values(live.bmc || {}).filter((x) => x?.ok);
  if (!ping.length && !bmcHealth.length && r.server_names.length) {
    rows.push({ icon: "📡", key: "Live", text: "checking…", pending: true }); // keeps its place until ping answers
  } else if (ping.length || bmcHealth.length) {
    const role = (x) => (x.role === "bmc" ? "BMC" : "Host");
    const bits = ping.filter((x) => x.ok).map((x) => `${role(x)} ${x.reachable ? "up" : "down"}`);
    const guess = serverPowerGuess(ping);
    const power = bmcHealth.map((x) => x.system?.power).find(Boolean);
    const failed = bmcHealth.flatMap((x) => x.problems || []);
    if (power) bits.push(`power ${power}`);
    if (failed.length) bits.push(`${failed.length} failed part${failed.length > 1 ? "s" : ""}`);
    const down = ping.some((x) => x.ok && !x.reachable);
    rows.push({ icon: "📡", key: "Live", text: [...new Set(bits)].join(" · ") || "checking…",
      note: guess === "bmc-up" && !power ? "chassis most likely powered off" : !bmcHealth.length && ping.some((x) => x.role === "bmc") ? "BMC health not read" : "",
      tone: failed.length ? "bad" : down ? "warn" : "ok", jump: $("bmcBox") && !$("bmcBox").classList.contains("hidden") ? "bmcBox" : "server" });
  }
  // The part: the BMC's failed part; else this server's own part (NetBox scan) that's missing or that the job is
  // about ("GPU 3 fell off the bus" → its H100); else the first replaceable catalog match. With its spare stock here.
  const ps = partsView?.key === current.key ? partsView.state : null;
  const missingLine = (ps?.bom || []).find((b) => b.missing && b.part);
  const own = missingLine ? { line: missingLine, part: missingLine.part } : bomFor(`${r.task_type} ${r.request_summary}`);
  const part = ps?.matches?.find((p) => p.failed) || own?.part || ps?.matches?.find((p) => !p.system);
  const ownNote = own?.part === part && own ? (own.line.missing ? `${own.line.missing} of ${own.line.count} missing in the last scan` : "in this server ✓") : "";
  if (!part) rows.push(!ps || ps.loading ? { icon: "🧰", key: "Part", text: "looking it up…", pending: true }
    : { icon: "🧰", key: "Part", text: "not identified yet", note: "open Parts to search the catalog", jump: "parts" });
  if (part) {
    const id = partId(part), st = glanceStock.id === id ? glanceStock.data : null;
    const site2 = ticketSiteCode(r, live.netbox);
    let note = "";
    if (st === "loading") note = "checking stock…";
    else if (st?.ok) {
      const here = st.rows.filter((x) => x.site === site2).reduce((n, x) => n + (x.onsite || 0), 0);
      const all = st.rows.reduce((n, x) => n + (x.onsite || 0), 0);
      note = here ? `${here} in stock at ${site2}` : all ? `none at ${site2 || "this site"}, ${all} elsewhere` : "no spares in NetBox";
    }
    rows.push({ icon: "🧰", key: part.failed ? "Failed part" : "Part", text: `${id} ${[part.vendor, part.name].filter(Boolean).join(" ")}`.slice(0, 90),
      note: [ownNote, own?.part === part && own?.line.note, note].filter(Boolean).join(" · "), tone: own?.line.missing || (st?.ok && !note.includes(" in stock at ")) ? "warn" : "", jump: "parts" });
  }
  // Cautions (from the ticket): all of them, they're short
  if (r.cautions.length) rows.push({ icon: "⚠️", key: r.cautions.length > 1 ? `${r.cautions.length} cautions` : "Caution", text: r.cautions.join(" · "), tone: "warn", jump: "cautions" });
  // Next step: the first one not ticked, with a button to tick it
  const checks = live.checks || new Set();
  const next = r.next_steps.findIndex((_, i) => !checks.has(i));
  if (r.next_steps.length) {
    const done = r.next_steps.filter((_, i) => checks.has(i)).length;
    rows.push({ icon: "👉", key: next < 0 ? "All steps done" : `Next (${done}/${r.next_steps.length})`, text: next < 0 ? "" : r.next_steps[next].replace(/^caution:\s*/i, "⚠️ "),
      tone: next < 0 ? "ok" : /^caution:/i.test(r.next_steps[next]) ? "warn" : "", jump: "steps",
      action: next >= 0 && h("button", { class: "mini", title: "Tick this step", onclick: () => $("steps")?.querySelectorAll(".checklist input")[next]?.click() }, "✓ Done") });
  }
  return { rows, part };
}

async function updateGlance() {
  const box = $("glance"), r = glanceBrief?.key === current.key ? glanceBrief.brief : null;
  if (!box || !r) return;
  const { rows, part } = glanceRows(r);
  const sig = JSON.stringify(rows.map(({ action, ...x }) => x));
  if (sig !== glanceSig || !box.querySelector(".glance-rows")) { glanceSig = sig; renderGlance(box, rows, jumpTo); }
  // Spare stock for the part, looked up once (automatic: no click needed)
  if (part && glanceStock.id !== partId(part)) {
    const settings = await getSettings();
    if (!settings.netboxEnabled) return;
    const key = current.key, id = partId(part);
    glanceStock = { id, data: "loading" };
    const data = await netboxStockForPart(settings, part, ticketSiteCode(r, lastResult?.netbox)).catch((e) => ({ ok: false, error: e.message }));
    if (glanceStock.id === id && current.key === key) { glanceStock.data = data; updateGlance(); }
  }
}

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
  lastResult.checks = checks;
  glanceBrief = { key, brief: entry.brief };
  renderBrief($("result"), entry.brief, {
    key,
    meta: entry.meta,
    checks,
    onCheck: () => chrome.storage.session.set({ [checksKey]: [...checks] }),
    openSlack
  });
  updateGlance(); // now, not on the next refresh: the card never shows empty
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

// What the server is, for "does this part fit": its scanned GPUs and its catalog entry. Empty if NetBox doesn't know.
function serverFitText() {
  const ps = partsView?.key === current.key ? partsView.state : null;
  const gpus = (ps?.bom || []).filter((b) => b.kind === "GPU").map((b) => b.model);
  const servers = (ps?.servers || []).map((p) => `${p.vendor} ${p.name} ${p.desc}`);
  return [...gpus, ...servers].join(" ");
}

// The server's own part for a component ("GPU", "NIC", "SSD"…), from its scan: { line, part } or null.
const BOM_KIND = [[/baseboard|hgx board/i, null], [/gpu|h100|h200|b200|b300|xid/i, "GPU"], [/\bnic\b|hca|connectx|bluefield|dpu|network card|infiniband/i, "NIC"],
  [/ssd|nvme|m\.2|\bdisk\b|drive/i, "Disk"]];
function bomFor(component) {
  const ps = partsView?.key === current.key ? partsView.state : null;
  const kind = BOM_KIND.find(([re]) => re.test(component || ""))?.[1];
  if (!kind || !ps?.bom?.length) return null;
  const lines = ps.bom.filter((b) => b.kind === kind && b.part);
  const missing = lines.filter((b) => b.missing);
  const line = missing.length === 1 ? missing[0] : lines.length === 1 ? lines[0] : null;
  return line ? { line, part: line.part } : null;
}

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
    // The server's own catalog entry (NetBox device type part number or Lambda SKU) and its own parts (FastTrack scan).
    state.servers = nb?.ok ? serverCatalogEntries(state.catalog, nb.devices) : [];
    const dev = nb?.ok ? nb.devices.find((d) => d.inventory) : null;
    state.bom = dev ? serverParts(state.catalog, dev) : [];
    state.bomAt = dev?.inventory?.at || "";
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
    if ((k === "oldSn" && cleanSn(value) === state.form.newSn) || (k === "newSn" && cleanSn(value) === state.form.oldSn)) return false; // one part can't be both
    if (state.form[k] && !replace && !/guess|default/.test(state.sources[k] || "")) return false; // keep the stronger source
    state.form[k] = value;
    state.sources[k] = source;
    return true;
  };
  // The existing RMA ticket (the one you add to) already has this swap: the old and the new S/N in the same comment
  // (or in its description, or its S/N fields). With only one of them known, that one anywhere on it.
  const onRma = (oldSn, newSn = "") => {
    const r = state.existing?.find((x) => x.key === state.target), want = [oldSn, newSn].map(normPn).filter(Boolean);
    return !!(r && want.length && (r.blocks || []).some((b) => want.every((n) => b.includes(n))));
  };
  const swapText = (o, n) => [o && `old ${o}`, n && `new ${n}`].filter(Boolean).join(" → ");
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
    const fresh = probs.filter((x) => !x.serial || !onRma(x.serial)); // a failed part already on the RMA is done
    for (const x of probs) if (x.serial && onRma(x.serial)) state.skippedSn?.add(swapText(cleanSn(x.serial), ""));
    const prob = fresh.find((x) => kind?.test(`${x.component} ${x.name}`) && x.serial) || (probs.length === 1 ? fresh[0] : null);
    if (prob?.serial) suggest("oldSn", cleanSn(prob.serial), `from BMC (${prob.name})`, { replace: /BMC/.test(state.sources.oldSn || "") });
    if (prob?.part_number) suggest("mpn", prob.part_number, `from BMC (${prob.name})`);
  };
  // The failed part's description: the BMC's model for it, or the brief's parts list, whichever matches the catalog best.
  // Lines of the comment with the swap's serials count a little more: that's where the tech names the part.
  const seedDescription = (swapText = "") => {
    const swapLines = swapText.split(/\n|(?<=[.;])\s+/).map((l) => l.replace(/^- \[[^\]]*\] [^:]+:\s*/, "").trim()).filter((l) => l.length >= 6 && l.length <= 160);
    const texts = [...swapLines.map((t) => [t, 0.1]), ...bmcProblems().map((x) => x.detail).filter((d) => /[a-z]{2,}.*\s/i.test(d || "")).map((t) => [t, 0]),
      ...entry.brief.parts_tools.map((t) => [t, 0])];
    let best = "", top = 0;
    for (const [t, bonus] of texts) {
      const m = catalogByDescription(catalog(), t, 1)[0];
      if (m && m.score + bonus > top) { best = t; top = m.score + bonus; }
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
  // The server's own parts (NetBox: FastTrack's last scan) for the chosen component are listed first; when there's
  // only one (or only one is missing from the scan), it's the part, unless a serial, a tick or you already decided.
  const applyBom = () => {
    const ps = partsView?.key === key ? partsView.state : null;
    state.pinned = (state.pinned || []).filter((x) => !x.bom);
    const kind = BOM_KIND.find(([re]) => re.test(state.form.component || state.form.partDesc || ""))?.[1];
    // A part taken from the scan for another component (GPU → now NIC) no longer applies.
    if (/^NetBox: in this server/.test(state.sources.lambda || "") && state.bomKind && state.bomKind !== kind) {
      for (const k of ["lambda", "mpn", "partName"]) { delete state.form[k]; delete state.sources[k]; }
    }
    state.bomKind = kind;
    if (!kind || !ps?.bom?.length) return;
    for (const b of ps.bom.filter((x) => x.kind === kind && x.part)) {
      state.pinned.push({ part: b.part, bom: true, tags: [b.missing ? `in this server: ${b.missing} of ${b.count} missing in last scan` : `in this server ✓ (${b.count}×)`] });
    }
    const own = bomFor(state.form.component || state.form.partDesc);
    if (own && !strongPart() && partId(own.part) !== state.form.lambda) {
      if (state.form.lambda) state.warnings.push(`This server's scan (NetBox) has ${own.line.model}, not ${state.form.lambda}. Switched to ${partId(own.part)}.`);
      usePartFirmly(own.part, `NetBox: in this server (${own.line.count}× ${own.line.model})`);
    }
    if (own?.line.note) state.warnings.push(own.line.note);
  };
  // A NIC's serial in the server's scan names the card exactly.
  const bomBySerial = (sn) => {
    const ps = partsView?.key === key ? partsView.state : null, n = normPn(sn);
    return n ? (ps?.bom || []).find((b) => b.part && b.serials?.some((x) => normPn(x) === n)) : null;
  };
  // 1st source of truth for which part it is: the serials. NetBox knows the spare you installed (inventory "<P/N>_<serial>")
  // or the part you removed (installed module); that P/N is then taken from the catalog.
  let serialRun = 0;
  const verifySerials = async () => {
    const settings = await getSettings();
    if (!settings.netboxEnabled || !catalog()) return;
    const run = ++serialRun, f = state.form, found = [];
    const card = bomBySerial(f.oldSn);
    for (const [which, sn] of [["new", f.newSn], ["old", f.oldSn]]) {
      if (!sn) continue;
      const r = await netboxPartBySerial(settings, sn);
      if (r) found.push({ which, sn, ...r, part: partById(r.id) });
    }
    if (run !== serialRun || state.step !== "form") return;
    state.warnings = state.warnings.filter((w) => !/^NetBox/.test(w));
    state.pinned = (state.pinned || []).filter((x) => !x.serial);
    if (card) {
      if (!state.touched.has("lambda") && partId(card.part) !== f.lambda) usePartFirmly(card.part, `NetBox: old S/N is this server's ${card.model}`);
      state.pinned.unshift({ part: card.part, serial: true, tags: ["NetBox ✓ old S/N is in this server"] });
    }
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
      const aiOld = serialIn(r.old_sn, sourceText) ? cleanSn(r.old_sn) : "", aiNew = serialIn(r.new_sn, sourceText) ? cleanSn(r.new_sn) : "";
      if ((aiOld || aiNew) && onRma(aiOld, aiNew)) state.skippedSn.add(swapText(aiOld, aiNew));
      else {
        filled += suggest("oldSn", aiOld, AI);
        filled += suggest("newSn", aiNew, AI);
      }
      if (opts("component").includes(r.component)) filled += suggest("component", r.component, AI);
      if (opts("rmaType").includes(r.rma_type)) filled += suggest("rmaType", r.rma_type, AI);
      if (String(r.description || "").trim().length > 15) filled += suggest("description", r.description.trim(), AI, { replace: !state.touched.has("description") });
      crossFill();
      rmaSerialNote();
      note = filled ? `✨ The AI filled in or improved ${filled} field${filled === 1 ? "" : "s"}. Check them.` : "✨ The AI found nothing more to fill in.";
    } catch (e) {
      if (run !== aiRun) return;
      note = `✨ The AI couldn't help (${e.message}). Fill in the rest yourself.`;
    }
    Object.assign(state, { aiBusy: false, aiNote: note });
    if (state.step === "form") draw();
  };

  // Serials skipped because the RMA already has them, and what's left to add.
  const rmaSerialNote = () => {
    const skipped = [...(state.skippedSn || [])];
    if (!state.existing?.length || !skipped.length) return (state.rmaSnNote = "");
    const proposed = state.form.oldSn || state.form.newSn;
    state.rmaSnNote = proposed
      ? `↪️ Skipped ${skipped.join("; ")}: already on ${state.target}. Proposing the next swap it doesn't have yet.`
      : `✅ Every swap this ticket mentions (${skipped.join("; ")}) is already on ${state.target}. Nothing new to add, unless you swapped another part: enter its serials.`;
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
      const snFields = [RMA_FIELD_NAMES.oldSn, RMA_FIELD_NAMES.newSn].map((n) => meta.fields[n]?.id);
      const existing = await jira("existing", { key, rmaProject: RMA_PROJECT, snFields });
      if (!existing.ok) return Object.assign(state, { step: state.result ? "done" : "idle", error: `Couldn't check for an existing RMA: ${existing.error}` }) && draw();
      Object.assign(state, { meta, existing: existing.rmas, target: existing.rmas[0]?.key, choices: choices(), form: {}, sources: {}, touched: new Set(), aiNote: "",
        pinned: [], historyCount: {}, historyModel: "", serialNote: "", rmaSnNote: "", skippedSn: new Set() });
      const first = state.choices[0];
      state.catalog = catalog();
      state.form.kind = meta.defaultKind;
      // What the server is (for "doesn't fit this server"): its NetBox record, its catalog entry ("8-H100 … Chassis") and the ticket.
      state.serverText = serverFitText() || [...(lastResult?.key === key && lastResult.netbox?.ok ? lastResult.netbox.devices.map((d) => `${d.model} ${d.legacyLpn || ""}`) : []),
        ...(partsView?.key === key ? (partsView.state.servers || []).map((p) => `${p.vendor} ${p.name} ${p.desc}`) : []),
        entry.brief.request_summary, String(entry.issueText || "").slice(0, 4000)].join(" ");
      // The server's hostname for the summary ("ord01-cl01-hgx-0084 - replace …"): a server name, not a serial.
      state.form.hostname = entry.brief.server_names.find((n) => /[a-z].*[-.].*\d|\d.*[-.].*[a-z]/i.test(n) && /-/.test(n)) || "";
      state.warnings = [];
      // The swaps the ticket names (old and new S/N from the same comment); with an RMA already open, the first one it doesn't have yet.
      const swaps = ticketSwaps(entry.issueText);
      const swap = swaps.find((x) => !onRma(x.oldSn, x.newSn)) || {};
      for (const x of swaps) if (onRma(x.oldSn, x.newSn)) state.skippedSn.add(swapText(x.oldSn, x.newSn));
      // Catalog parts the whole ticket names (by number or description), those in the swap's comment first: listed at the top.
      const named = ticketCatalogParts(catalog(), entry.issueText, swap.text).filter((m) => !serverMismatch(state.serverText, m.part));
      state.pinned.push(...named.map((m) => ({ part: m.part, tags: m.tags })));
      const byNumber = named.filter((m) => m.byNumber);
      if (first) usePart(first, first._src);
      else if (byNumber.length === 1 || (byNumber.length > 1 && byNumber[0].score > byNumber[1].score)) {
        usePart(byNumber[0].part, `catalog: ${byNumber[0].tags[0].replace(/^P\/N named/, "P/N")}`);
      } else {
        suggest("partDesc", seedDescription(swap.text || ""), "from ticket/BMC");
        autoFromDescription("catalog: exact description");
      }
      // These don't depend on the exact P/N: the BMC's failed part gives the old S/N, the description the component.
      const probs = bmcProblems().filter((x) => x.serial && !onRma(x.serial));
      if (probs.length === 1) suggest("oldSn", cleanSn(probs[0].serial), `from BMC (${probs[0].name})`);
      suggest("component", guessComponent(state.meta.fields[RMA_FIELD_NAMES.component]?.options || [], { name: state.form.partDesc || swap.text || "" }, entry.issueText || ""), "guessed");
      applyBom();
      crossFill();
      suggest("description", failure(), "from ticket & BMC");
      const inTicket = swap, from = swap.who ? `from ${swap.who}'s comment${swap.when ? ` (${swap.when.slice(0, 10)})` : ""}` : "from ticket";
      suggest("oldSn", inTicket.oldSn, from);
      suggest("newSn", inTicket.newSn, from);
      // The ticket and the BMC disagree about the old S/N: say so instead of silently picking one.
      if (inTicket.oldSn && state.form.oldSn && inTicket.oldSn !== state.form.oldSn) {
        state.warnings.push(`The ticket mentions old S/N ${inTicket.oldSn}, but the BMC reports ${state.form.oldSn}. Check the label on the part you removed.`);
      }
      rmaSerialNote();
      state.step = "form";
      draw();
      verifySerials();
      loadHistory();
      aiPrefill();
    },
    onSerial: () => { clearTimeout(state.serialTimer); state.serialTimer = setTimeout(verifySerials, 700); },
    onComponent: () => { applyBom(); crossFill(); draw(); loadHistory(); }, // this server's parts for it, then the catalog's
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
        existing: null, target: null, aiBusy: false, aiNote: "", result: null, pinned: [], historyCount: {}, historyModel: "", serialNote: "", rmaSnNote: "", skippedSn: new Set() });
      await chrome.storage.session.remove(store);
      if (lastResult?.key === key) lastResult.rma = null;
      draw();
    },
    onCancel: () => { aiRun++; Object.assign(state, { step: state.result ? "done" : "idle", problems: [], aiBusy: false }); draw(); },
    onReview: () => {
      const f = state.form;
      Object.assign(f, { lambda: String(f.lambda || "").trim(), mpn: String(f.mpn || "").trim(), oldSn: cleanSn(f.oldSn), newSn: cleanSn(f.newSn), description: String(f.description || "").trim() });
      state.problems = rmaProblems(f);
      if (f.oldSn && f.oldSn === f.newSn) state.problems.push("The old and the new S/N are the same. The new one is on the part you installed.");
      state.warnings = state.warnings.filter((w) => !/already on RMA|is on .* in another comment/.test(w));
      if (state.existing?.length && f.oldSn && f.newSn && onRma(f.oldSn, f.newSn)) state.problems.push(`This swap (${swapText(f.oldSn, f.newSn)}) is already on ${state.target}.`);
      else if (state.existing?.length) for (const [label, sn] of [["old", f.oldSn], ["new", f.newSn]]) {
        if (onRma(sn)) state.warnings.push(`The ${label} S/N ${sn} is on ${state.target} in another comment, without this ${label === "old" ? "new" : "old"} S/N. Check it's a different swap.`);
      }
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
      h("button", { class: "link", onclick: () => chrome.runtime.openOptionsPage() }, "open Settings"),
      h("div", { class: "muted" }, "No key yet? You can make a free Gemini key yourself in 2 minutes, no IT request: Settings → Getting started.")),
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
    // Redraw at most every 250 ms, and only when the brief actually changed: no flicker while it streams.
    let drawn = "", pending = null, timer = null, streamDone = false;
    const drawPartial = () => {
      timer = null;
      if (streamDone || current.key !== key || !pending) return;
      const [partial, raw] = pending, powerPending = !("request_summary" in raw);
      const sig = JSON.stringify(partial) + powerPending;
      if (sig === drawn) return;
      drawn = sig;
      glanceBrief = { key, brief: partial };
      renderBrief($("result"), partial, { key, meta: issueMeta(issue.data), partial: true, powerPending, openSlack });
      updateGlance();
      $("result").classList.remove("hidden");
    };
    const onPartial = (partial, raw) => {
      if (current.key !== key) return;
      pending = [partial, raw];
      if (!timer) timer = setTimeout(drawPartial, drawn ? 250 : 0);
    };
    try {
      ({ brief, model } = await analyzeIssue(settings, key, text, onPartial, privacy));
    } finally {
      clearInterval(tick);
      streamDone = true;
      clearTimeout(timer);
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
