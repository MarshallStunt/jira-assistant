// "Ask the AI" box: follow-up questions about the open ticket.
// The AI gets the ticket data + the brief as context, plus the parts-catalog rows that fit the question.
// When an answer names catalog parts, their spare stock in NetBox is looked up and shown under it.
// History is kept per ticket for the browser session.

const CHAT_SUGGESTIONS = [
  "Which part do I need to swap?",
  "What should I check first?",
  "Explain the error in simple terms",
  "Draft a reply to the requester"
];
const MAX_TURNS = 20; // keep the last N messages as context

const chat = { key: null, history: [], busy: false, getContext: null };

function chatSystemPrompt(settings, key, issueText, brief, netbox, bmc, catalogRows, serverParts, stock) {
  let p = `You are an assistant for Datacenter Operations technicians at Lambda, a GPU cloud company. The technician is working on Jira ticket ${key} and asks follow-up questions about it.

Keep answers short and rich: lead with the answer, then at most 4 short bullet lines with the key facts (part numbers, ports, IPs, values). No preamble, no repeating the question, no filler. Only write more when asked for detail or a draft. Talk like a senior DC technician. Plain text (no markdown tables or headings). If something isn't in the ticket, say so instead of guessing. Never say it is OK to power down a server unless the ticket explicitly allows it. If asked to draft a message or comment, write it ready to paste.`;
  if (settings.teamContext?.trim()) p += `\n\nTeam procedures and conventions:\n${settings.teamContext.trim()}`;
  if (settings.customInstructions?.trim()) p += `\n\nAdditional instructions from the user:\n${settings.customInstructions.trim()}`;
  p += `\n\n=== Ticket ${key} ===\n${String(issueText || "(ticket text unavailable)").slice(0, 60000)}`;
  if (brief) p += `\n\n=== Brief already shown to the technician ===\n${JSON.stringify(brief)}`;
  if (netbox?.ok) p += `\n\n=== NetBox record(s) for this server (source of truth for location, IPs, cabling) ===\n${JSON.stringify(netbox.devices).slice(0, 20000)}`;
  const health = Object.values(bmc || {}).filter((x) => x?.ok).map(({ ip, system, manager, problems, events, at }) => ({ ip, system, manager, problems, events, readAt: new Date(at).toISOString() }));
  if (health.length) p += `\n\n=== Live BMC health read over Redfish (actual power state, failed parts, event log) ===\n${JSON.stringify(health).slice(0, 15000)}`;
  if (stock) p += `\n\n=== Spare parts in NetBox storage (this ticket's site first) ===\n${stock}\nWhen it matters, say in one line where the part is in stock (this site first) and how many.`;
  else if (settings.netboxEnabled) p += `\n\nDon't guess spare stock: the panel looks up NetBox storage for the Lambda P/Ns you name and shows it under your answer.`;
  if (serverParts?.length) p += `\n\n=== This server in the parts catalog (from NetBox's Lambda SKU) ===\n${catalogRowsText(serverParts)}`;
  if (catalogRows?.length) {
    p += `\n\n=== Lambda parts catalog: rows that may fit this question (Lambda tracks parts by Lambda P/N) ===\n${catalogRowsText(catalogRows)}

When asked which part to use or for a part number: pick only from these rows and never invent part numbers. The part number on the ticket is almost always the server/chassis, not the part to swap: base the answer on the failing component (from the description, comments, errors and the BMC). Give the most likely part first, then alternatives if it's not certain (e.g. the same GPU in H100 vs H200 variants). Lead with the Lambda P/N, then the SKU and MPN, and say briefly why it fits (type, capacity, speed, server model, the failed part the BMC reports). If a part has no Lambda P/N, say so. If no row clearly fits, say that and suggest checking the catalog (📒 Open catalog on the Parts card). Ask the technician to confirm the part number in the catalog before ordering.`;
  }
  return p;
}

// ---------- Parts questions: find the likely part in the catalog first ----------

const PARTS_QUESTION_RE = /\b(parts?|p\/?n|pn|sku|mpn|swap|replace|replacement|spare|order|rma)\b|\b(gpu|h100|h200|b200|dimm|memory|ram|psu|power supply|fan|nic|connectx|drive|ssd|nvme|cable|optic|transceiver|motherboard|baseboard|riser|backplane)\b/i;

// "Do we have 207-000002 in stock?", "where are the spare H100s?"
const STOCK_QUESTION_RE = /\b(stock|storage|spares?|on hand|available|inventory|in stock|have any|how many)\b/i;
const partNumbersIn = (text) => [...new Set((String(text).match(/\b[A-Z0-9][A-Z0-9-]{4,30}\b/gi) || []).filter((t) => /\d/.test(t) && /[-]|[A-Z]/i.test(t) && !/^[A-Z]{3}\d{2}$/i.test(t)))].slice(0, 3); // not site codes like ORD01

// Spare stock (NetBox storage) for the given parts, as prompt text. Ticket's site first.
// parts: [{ label, part }] for catalog parts, or [{ label, ids }] for numbers typed in the question.
// Results for catalog parts are kept in `checked` so the stock shown under the answer isn't looked up twice.
async function stockText(settings, parts, site, checked) {
  const stocks = await Promise.all(parts.map((p) => (p.part ? netboxStockForPart(settings, p.part, site) : netboxStock(settings, p.ids, site))));
  parts.forEach((p, i) => p.part && checked.set(partId(p.part), stocks[i]));
  return parts.map((p, i) => {
    const s = stocks[i];
    const same = s.sameType ? ` [stocked as the same type: ${s.sameType.join(", ")}]` : "";
    const where = s.ok && s.rows.length ? ` — ${s.rows.slice(0, 4).map((r) => `${r.location}: ${r.onsite}${r.receiving ? ` (+${r.receiving} arriving)` : ""}`).join("; ")}` : "";
    return `${p.label}: ${stockSummary(s, site)}${same}${where}`;
  }).join("\n");
}

const PART_QUERY_SCHEMA = {
  type: "object",
  properties: {
    component: { type: "string", description: "The component that most likely has to be swapped, e.g. 'GPU (H100 SXM5 80GB)', 'DIMM (64GB DDR5 RDIMM)', 'PSU', 'NIC (ConnectX-7)', 'fan', 'NVMe drive'. Empty if it can't be told." },
    search_terms: { type: "array", items: { type: "string" }, description: "3-6 short catalog search phrases for that component: type, model, capacity, vendor, manufacturer part number if known. Never the ticket's chassis/server part number." },
    why: { type: "string", description: "One sentence: what in the ticket, comments or BMC points to this component." }
  },
  required: ["component", "search_terms", "why"]
};

// Step 1: from the ticket, comments and BMC, which component failed and what should be searched for.
// (The ticket's part number field is the chassis, so it is never taken as the part to swap.)
async function partSearchPlan(settings, privacy, question, ctx) {
  const failed = Object.values(ctx.bmc || {}).filter((x) => x?.ok).flatMap((x) => x.problems.map((p) => `${p.component} ${p.name} ${p.health} ${p.detail}`));
  const user = [
    `Technician's question: ${question}`,
    `Ticket (excerpt):\n${String(ctx.issueText || "").slice(0, 12000)}`,
    ctx.brief && `Brief: ${JSON.stringify({ task_type: ctx.brief.task_type, request: ctx.brief.request_summary, parts: ctx.brief.parts_tools, cause: ctx.brief.probable_cause })}`,
    ctx.netbox?.ok && `Server model (NetBox): ${ctx.netbox.devices.map((d) => d.model).join(", ")}`,
    ctx.serverParts?.length && `This server in the parts catalog: ${catalogRowsText(ctx.serverParts)}`,
    ctx.netbox?.ok && `Past work on this server (NetBox journal): ${ctx.netbox.devices.flatMap((d) => d.history || []).slice(0, 8).map((j) => `${String(j.at).slice(0, 10)} ${j.text}`).join(" | ")}`,
    failed.length && `Failed components reported by the BMC: ${failed.join("; ")}`
  ].filter(Boolean).join("\n\n");
  const { result } = await generateStructured(settings, {
    system: "You help datacenter technicians find the replacement part for a ticket. The part number on a ticket is almost always the whole server/chassis part number, not the part to swap: work out the failing component from the description, comments, errors and BMC findings (e.g. a GPU H100/H200/B200, GPU baseboard, DIMM, PSU, fan, NIC, drive, cable) and give search phrases for the parts catalog.",
    user: privacy.redact(user),
    schema: PART_QUERY_SCHEMA,
    schemaName: "part_search"
  });
  const plan = privacy.restore(result || {});
  return { component: String(plan.component || ""), terms: (plan.search_terms || []).map(String).filter(Boolean).slice(0, 6), why: String(plan.why || "") };
}

// NetBox stock for the parts an answer names (m.stock: "loading" or [{ label, result }]).
function answerStock(m) {
  if (m.stock === "loading") return h("div", { class: "msg-stock muted" }, h("span", { class: "spinner" }), "Checking NetBox storage…");
  return h("div", { class: "msg-stock" }, m.stock.map(({ label, result }) => {
    const box = h("div");
    renderStock(box, result, m.site);
    return h("div", { class: "msg-stock-part" }, h("div", { class: "msg-stock-head" }, label), box);
  }));
}

// After an answer: look up spare stock for the catalog parts it names (in the order it names them, up to 3).
async function checkAnswerStock(m, key, settings, catalog, site, checked) {
  const text = m.content.toUpperCase();
  const pos = (p) => Math.min(...[p.lambda, p.legacy, p.mpn].filter(Boolean).map((id) => text.indexOf(id.toUpperCase())).filter((i) => i >= 0));
  const parts = findCatalogParts(catalog, [m.content]).filter((p) => !p.system).sort((a, b) => pos(a) - pos(b)).slice(0, 3);
  if (!parts.length) return;
  m.stock = "loading";
  m.site = site;
  renderChat();
  const results = await Promise.all(parts.map((p) => checked.get(partId(p)) || netboxStockForPart(settings, p, site)));
  m.stock = parts.map((p, i) => ({ label: `${partId(p)} · ${[p.vendor, p.name].filter(Boolean).join(" ")}`.slice(0, 90), result: results[i] }));
  if (chat.key !== key) return; // ticket switched: the message was saved without stock
  await saveChat();
  renderChat();
  scrollChatIntoView();
}

// Light clean-up of markdown the model may still use.
function tidyAnswer(t) {
  return t.replace(/\*\*(.+?)\*\*/g, "$1").replace(/^#{1,6}\s+/gm, "").replace(/^\s*[*]\s+/gm, "• ").trim();
}

function renderChat() {
  const log = $("chatLog");
  log.innerHTML = "";
  for (const m of chat.history) {
    const bubble = h("div", { class: `msg ${m.role}${m.error ? " error" : ""}` },
      m.note && h("div", { class: "msg-note" }, m.note), // what the catalog was searched for
      h("div", { class: "msg-text" }, m.content),
      m.stock && answerStock(m));
    if (m.role === "assistant" && !m.error) {
      const copy = h("button", { class: "msg-copy", title: "Copy answer" }, "Copy");
      copy.addEventListener("click", async () => {
        await navigator.clipboard.writeText(m.content);
        copy.textContent = "Copied ✓";
        setTimeout(() => (copy.textContent = "Copy"), 1200);
      });
      bubble.appendChild(copy);
    }
    log.appendChild(bubble);
  }
  if (chat.busy) log.appendChild(h("div", { class: "msg assistant thinking" }, h("span", { class: "spinner" }), "Thinking…"));

  const sug = $("chatSuggest");
  sug.innerHTML = "";
  if (!chat.history.length && !chat.busy) {
    CHAT_SUGGESTIONS.forEach((q) => sug.appendChild(h("button", { class: "chip suggest", onclick: () => askAI(q) }, q)));
  }
  $("chatClear").classList.toggle("hidden", !chat.history.length || chat.busy);
  $("chatSend").disabled = chat.busy;
  $("chatInput").disabled = chat.busy;
}

async function saveChat() {
  await chrome.storage.session.set({ [`chat:${chat.key}`]: chat.history });
}

// Called whenever a brief is shown. getContext() → { issueText, brief }
async function openChat(key, getContext) {
  chat.key = key;
  chat.getContext = getContext;
  chat.busy = false;
  chat.history = (await chrome.storage.session.get(`chat:${key}`))[`chat:${key}`] || [];
  for (const m of chat.history) if (m.stock === "loading") delete m.stock; // lookup cut off when the panel closed
  $("chat").classList.remove("hidden");
  $("chatForm").classList.remove("hidden");
  renderChat();
}

function closeChat() {
  chat.key = null;
  $("chat").classList.add("hidden");
  $("chatForm").classList.add("hidden");
}

async function askAI(question) {
  question = (question || "").trim();
  if (!question || chat.busy || !chat.key) return;
  const key = chat.key;
  chat.history.push({ role: "user", content: question });
  chat.busy = true;
  $("chatInput").value = "";
  autoGrow();
  renderChat();
  scrollChatIntoView();

  let stockAfter = null;
  try {
    const settings = await getSettings();
    const problem = missingConfig(settings);
    if (problem) throw new Error(problem);
    const { issueText, brief, netbox, bmc, people } = await chat.getContext();
    const privacy = makeRedactor(settings, people); // same placeholders for the ticket and the questions
    // Catalog rows that fit the question and the ticket. For part questions, first work out which component
    // failed and search the catalog for it (the ticket's own part number is usually the chassis).
    let catalogRows = [];
    let serverParts = [];
    let searchNote = "";
    let stock = "";
    let catalog = null;
    const checked = new Map(); // part id → NetBox stock already looked up for this question
    const site = ticketSiteCode(brief, netbox);
    try {
      catalog = await loadCatalog(settings.catalogUrl);
      const lpns = netbox?.ok ? netbox.devices.map((d) => d.legacyLpn).filter(Boolean) : [];
      serverParts = catalog.parts.filter((p) => lpns.includes(p.legacy)); // e.g. "HGX H100 8-GPU Server"
      // Name and part number only: the BMC's component label ("CPU/GPU") would pull in both kinds of part.
      const failed = Object.values(bmc || {}).filter((x) => x?.ok).flatMap((x) => x.problems.map((p) => `${p.name} ${p.detail}`));
      let texts = [question, brief?.task_type, brief?.request_summary, ...(brief?.parts_tools || []),
        ...(netbox?.ok ? netbox.devices.map((d) => d.model) : []), ...failed];
      if (PARTS_QUESTION_RE.test(question)) {
        const plan = await partSearchPlan(settings, privacy, question, { issueText, brief, netbox, bmc, serverParts });
        if (plan.component || plan.terms.length) {
          texts = [question, plan.component, ...plan.terms, ...failed];
          searchNote = `🔎 Catalog searched for ${plan.component || "the part"}: ${plan.terms.join(", ")}`;
        }
      }
      catalogRows = catalogRowsFor(catalog, texts);
      if (searchNote) searchNote += ` (${catalogRows.length} candidate${catalogRows.length === 1 ? "" : "s"})`;
      // Stock questions ("do we have 207-000002?"): give the AI the stock of the parts asked about, or the top
      // candidates. Other answers get their parts' stock checked after they're written (checkAnswerStock).
      if (settings.netboxEnabled && STOCK_QUESTION_RE.test(question)) {
        const asked = partNumbersIn(question).map((n) => ({ label: n, ids: [n] }));
        const top = catalogRows.filter((p) => !isWholeSystem(p)).slice(0, 4)
          .map((p) => ({ label: `${p.lambda || p.legacy || p.mpn} (${p.name || p.desc})`.slice(0, 80), part: p }));
        const parts = (asked.length ? asked : top).slice(0, 4);
        if (parts.length) {
          stock = await stockText(settings, parts, site, checked);
          searchNote = [searchNote, `📦 Checked NetBox storage for ${parts.length} part${parts.length === 1 ? "" : "s"}${site ? ` (${site} first)` : ""}`].filter(Boolean).join(" · ");
        }
      }
    } catch (e) {
      console.warn("catalog for chat", e); // the chat still works without it
    }
    const messages = chat.history.filter((m) => !m.error).slice(-MAX_TURNS).map(({ role, content }) => ({ role, content: privacy.redact(content) }));
    const { text } = await generateText(settings, {
      system: privacy.redact(chatSystemPrompt(settings, key, issueText, brief, netbox, bmc, catalogRows, serverParts, stock)),
      messages
    });
    if (chat.key !== key) return; // user switched tickets meanwhile
    const answer = { role: "assistant", content: tidyAnswer(privacy.restore(text)), note: searchNote || undefined };
    chat.history.push(answer);
    if (settings.netboxEnabled && catalog) stockAfter = () => checkAnswerStock(answer, key, settings, catalog, site, checked);
  } catch (e) {
    if (chat.key !== key) return;
    chat.history.push({ role: "assistant", content: String(e.message || e), error: true });
  } finally {
    if (chat.key === key) {
      chat.busy = false;
      await saveChat();
      renderChat();
      scrollChatIntoView();
      $("chatInput").focus();
    }
  }
  if (stockAfter) await stockAfter().catch((e) => console.warn("answer stock", e));
}

function scrollChatIntoView() {
  window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
}

function autoGrow() {
  const el = $("chatInput");
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 120) + "px";
}

$("chatForm").addEventListener("submit", (e) => {
  e.preventDefault();
  askAI($("chatInput").value);
});
$("chatInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    askAI($("chatInput").value);
  }
});
$("chatInput").addEventListener("input", autoGrow);
$("chatClear").addEventListener("click", async () => {
  chat.history = [];
  await saveChat();
  renderChat();
});
