// What we ask the AI for, and how we clean up what comes back.
// Tailored for Datacenter Operations tickets.

const DC_SCHEMA = {
  type: "object",
  properties: {
    task_type: {
      type: "string",
      description: "Short label for the job, 2-4 words, e.g. 'GPU replacement', 'DIMM swap', 'Rack & stack', 'Cable reseat', 'Decommission', 'Power cycle', 'Inspection'."
    },
    server_names: {
      type: "array", items: { type: "string" },
      description: "Affected server hostnames / node names / serial or asset tags exactly as written. Empty if none."
    },
    location: {
      type: "object",
      description: "Physical location. Use empty string for any part that is not stated. Never guess.",
      properties: {
        site: { type: "string", description: "Datacenter / site exactly as written, e.g. 'ORD01 - Elk Grove Village, IL (EdgeConnex CHI02)'." },
        row: { type: "string", description: "Room, cage, hall or row." },
        rack: { type: "string", description: "Rack / cabinet ID." },
        unit: { type: "string", description: "Rack unit number only, e.g. '22' or '22-23'. No 'U' prefix, no front/rear." }
      },
      required: ["site", "row", "rack", "unit"]
    },
    network_targets: {
      type: "array",
      description: "IP addresses (IPv4/IPv6 only — no hostnames, no serials) of the affected server(s) found in the ticket: host/OS IP, BMC/IPMI/iDRAC/iLO IP, management IP, data/storage IP. Exactly as written. Do not invent. Empty if none.",
      items: {
        type: "object",
        properties: {
          role: { type: "string", enum: ["host", "bmc", "mgmt", "data", "other"], description: "host = main hostname/IP, bmc = BMC/IPMI/iDRAC/iLO, mgmt = management network, data = data/storage/InfiniBand network." },
          address: { type: "string", description: "The IP address only, no URL, port or path." }
        },
        required: ["role", "address"]
      }
    },
    power_down: {
      type: "object",
      description: "Is it OK to power the server down for this work?",
      properties: {
        verdict: {
          type: "string",
          enum: ["approved", "do_not", "confirm_first", "not_needed"],
          description: "approved = ticket/comments explicitly allow power-down (maintenance approved, node drained/cordoned, customer approved, already down, or decommissioned). do_not = ticket says not to, server is in production / customer workload running / awaiting approval. confirm_first = work likely needs power-down but no explicit approval is found. not_needed = work can be done without powering down (e.g. hot-swap PSU/fan/drive, cabling on another device, visual inspection)."
        },
        reason: { type: "string", description: "One sentence explaining the verdict." },
        evidence: { type: "string", description: "Who said it and when, or a short quote from the ticket. Empty if there is no explicit statement." }
      },
      required: ["verdict", "reason", "evidence"]
    },
    request_summary: { type: "string", description: "What the technician is being asked to do, 1-2 short sentences." },
    current_status: { type: "string", description: "Where the work stands right now and what is still left, 1 sentence." },
    history: {
      type: "array",
      description: "Chronological summary of previous work, requests and findings from comments and history. Merge trivial entries. Max 8 items. Empty if no prior work.",
      items: {
        type: "object",
        properties: {
          when: { type: "string", description: "Date, e.g. '2026-10-21' or 'Oct 21'." },
          who: { type: "string", description: "Person or team." },
          what: { type: "string", description: "What was done, requested or found, in a few words." }
        },
        required: ["when", "who", "what"]
      }
    },
    next_steps: {
      type: "array", items: { type: "string" },
      description: "Ordered, concrete, hands-on steps for the DC technician. Short imperative sentences. Prefix risky steps with 'CAUTION:'."
    },
    parts_tools: {
      type: "array", items: { type: "string" },
      description: "Spare parts (with part numbers/serials if given), tools and access needed. Empty if none."
    },
    cautions: {
      type: "array", items: { type: "string" },
      description: "Safety, customer-impact or process warnings (ESD, live workload, RMA return, escalation). Empty if none."
    },
    probable_cause: { type: "string", description: "Most likely root cause in one or two sentences, or empty if not a fault." },
    missing_info: {
      type: "array", items: { type: "string" },
      description: "What is missing or should be confirmed before starting. Empty if nothing."
    },
    confidence: { type: "string", enum: ["low", "medium", "high"] }
  },
  required: ["task_type", "server_names", "location", "network_targets", "power_down", "request_summary", "current_status",
             "history", "next_steps", "parts_tools", "cautions", "probable_cause", "missing_info", "confidence"]
};

function dcSystemPrompt(teamContext, customInstructions) {
  let p = `You are an assistant for Datacenter Operations technicians at Lambda, a GPU cloud company. You read Jira tickets about physical server work (GPU/DIMM/drive/PSU/fan/NIC/cable replacement, rack & stack, reboots, inspections, RMAs, decommissions) and produce a clean, at-a-glance work brief.

Rules:
- Extract server names and location exactly as written. Never invent hostnames, racks or approvals. Leave unknown parts empty.
- List every IP address of the affected server(s) found in the ticket (host, BMC/IPMI, mgmt, data) in network_targets so they can be pinged. IPs only — never hostnames or serial numbers.
- Read ALL comments and history. Summarize previous work, requests and findings in the history list, and state where things stand now.
- Power-down safety is critical. Only answer "approved" if there is explicit evidence (approval, drained/cordoned, maintenance window, customer OK, already down, decommission). If the ticket says not to, or a customer workload may be running, answer "do_not". If unclear, answer "confirm_first". Hot-swappable work that doesn't need power-down is "not_needed". Later comments override earlier ones.
- After any hardware replacement or swap that changes a serial number or MAC address (node, motherboard, NIC, BMC, GPU tray, drive with serial tracking), include a step to rescan the server in Podcrawler so NetBox, Yard and FastTrack get the new serial and MACs.
- Next steps must be practical, hands-on and in order. Put verification (e.g. check BMC/IPMI, confirm serial, confirm node drained) before risky actions.
- Be brief: a technician should understand the ticket in 10 seconds.`;
  if (teamContext?.trim()) p += `\n\nTeam procedures and conventions (follow these):\n${teamContext.trim()}`;
  if (customInstructions?.trim()) {
    p += `\n\nAdditional instructions from the user (follow these; they take priority over the defaults above, except the power-down safety rule):\n${customInstructions.trim()}`;
  }
  return p;
}

const POWER = {
  approved:      { label: "OK to power down",              cls: "ok" },
  not_needed:    { label: "No power-down needed",          cls: "info" },
  confirm_first: { label: "Confirm before powering down",  cls: "warn" },
  do_not:        { label: "Do NOT power down",             cls: "danger" }
};

const str = (v) => {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map(str).filter(Boolean).join(", ");
  if (typeof v === "object") return Object.values(v).map(str).filter(Boolean).join(" — ");
  return String(v).trim();
};
const list = (v) => (Array.isArray(v) ? v : v ? [v] : []).map((x) => (typeof x === "string" ? x.trim() : x)).filter(Boolean);
// Strip URL scheme/port/path so "https://10.1.2.3:443/ui" becomes "10.1.2.3". Returns "" if not a hostname/IP.
function cleanAddress(v) {
  let a = str(v).replace(/^[a-z]+:\/\//i, "").replace(/[/?#].*$/, "");
  if (/^\[.*\](:\d+)?$/.test(a)) a = a.replace(/^\[|\](:\d+)?$/g, "");   // [ipv6]:port
  else if ((a.match(/:/g) || []).length === 1) a = a.replace(/:\d+$/, "");   // host:port
  return /^[A-Za-z0-9_.:-]{1,253}$/.test(a) && !a.startsWith("-") ? a : "";
}

// "U22 (front)" / "22 - rear" / "RU 22-23" → "22" / "22-23"
function cleanUnit(v) {
  let u = str(v)
    .replace(/\(([^)]*)\)/g, " ")                                      // drop anything in parentheses
    .replace(/\b(front|rear|back|side|facing|position|pos|slot)\b/gi, " ")
    .replace(/\b(r?u)\s*(?=\d)/gi, "")                                // U22, RU22 → 22
    .replace(/(\d)\s*r?u\b/gi, "$1")                                 // 12U → 12
    .replace(/(\d)\s*-\s*u?\s*(\d)/gi, "$1-$2")                     // 22 - U23 → 22-23
    .replace(/[\s,;:–—-]+$/g, "").replace(/^[\s,;:–—-]+/g, "").replace(/\s+/g, " ").trim();
  return u;
}

const isNone = (v) => /^(n\/?a|none|not found|unknown|not stated|-)$/i.test(str(v));

// Smaller/local models sometimes return slightly off shapes — normalize everything.
function normalizeDc(r) {
  r = r || {};
  const loc = typeof r.location === "object" && r.location ? r.location : { site: str(r.location) };
  const pd = typeof r.power_down === "object" && r.power_down ? r.power_down : { verdict: r.power_down };
  let verdict = str(pd.verdict).toLowerCase().replace(/[\s-]+/g, "_");
  if (!POWER[verdict]) verdict = "confirm_first"; // safest default
  const clean = (v) => (isNone(v) ? "" : str(v));
  let reason = str(pd.reason);
  // Safety: never show "OK to power down" without evidence from the ticket.
  if (verdict === "approved" && !clean(pd.evidence)) {
    verdict = "confirm_first";
    reason = `AI suggested power-down is OK but found no explicit approval in the ticket.${reason ? ` (${reason})` : ""}`;
  }
  const conf = str(r.confidence).toLowerCase();
  return {
    task_type: str(r.task_type),
    server_names: list(r.server_names).map(str).filter((s) => !isNone(s)),
    network_targets: list(r.network_targets).map((t) => typeof t === "string" ? { role: "other", address: t } : t)
      .map((t) => ({ role: ["host", "bmc", "mgmt", "data", "other"].includes(str(t.role).toLowerCase()) ? str(t.role).toLowerCase() : "other", address: cleanAddress(t.address) }))
      .filter((t) => t.address),
    location: { site: clean(loc.site), row: clean(loc.row), rack: clean(loc.rack), unit: cleanUnit(clean(loc.unit)) },
    power_down: { verdict, reason, evidence: clean(pd.evidence) },
    request_summary: str(r.request_summary || r.summary),
    current_status: str(r.current_status),
    history: list(r.history).map((h) => typeof h === "string"
      ? { when: "", who: "", what: h }
      : { when: str(h.when), who: str(h.who), what: str(h.what) }).filter((h) => h.what),
    next_steps: list(r.next_steps || r.proposed_solution).map(str),
    parts_tools: list(r.parts_tools).map(str),
    cautions: list(r.cautions).map(str),
    probable_cause: clean(r.probable_cause),
    missing_info: list(r.missing_info).map(str),
    confidence: ["low", "medium", "high"].includes(conf) ? conf : "medium"
  };
}

function locationText(loc) {
  const parts = [
    loc.site,
    loc.row && `Row ${loc.row.replace(/^row\s*/i, "")}`,
    loc.rack && `Rack ${loc.rack.replace(/^rack\s*/i, "")}`,
    loc.unit && `RU ${loc.unit}`
  ].filter(Boolean);
  return parts.join(" · ");
}

function asJiraComment(key, r, ping, netbox, bmc, bmcPower) {
  const L = [
    `*Lambda DC Ops brief — ${key}*${r.task_type ? ` (${r.task_type})` : ""}`,
    `*Power-down:* ${POWER[r.power_down.verdict].label} — ${r.power_down.reason}`,
    `*Server:* ${r.server_names.join(", ") || "Not found"}`,
    `*Location:* ${locationText(r.location) || "Not found"}`,
    ...(typeof netboxCommentLines === "function" ? netboxCommentLines(netbox) : []),
    ...(typeof bmcCommentLines === "function" ? bmcCommentLines(bmc, bmcPower) : []),
    ...pingCommentLines(ping),
    "",
    `*Request:* ${r.request_summary}`,
    `*Status:* ${r.current_status}`
  ];
  if (r.history.length) {
    L.push("", "*History:*", ...r.history.map((h) => `* ${[h.when, h.who].filter(Boolean).join(" · ")}${h.when || h.who ? " — " : ""}${h.what}`));
  }
  if (r.next_steps.length) L.push("", "*Next steps:*", ...r.next_steps.map((s) => `# ${s}`));
  if (r.parts_tools.length) L.push("", `*Parts/tools:* ${r.parts_tools.join(", ")}`);
  if (r.cautions.length) L.push("", "*Cautions:*", ...r.cautions.map((s) => `* ${s}`));
  if (r.missing_info.length) L.push("", "*To confirm:*", ...r.missing_info.map((s) => `* ${s}`));
  return L.join("\n");
}

function pingCommentLines(ping) {
  if (!ping?.results?.length) return [];
  const when = new Date(ping.at || Date.now()).toLocaleString();
  return [`*Reachability (from ${ping.source || "my workstation"}, ${when}):*`, ...ping.results.map((x) => `* ${pingSummary(x)}`)];
}

// Replacement work changes serials/MACs → make sure the Podcrawler rescan step is there.
const REPLACEMENT_RE = /\b(replac\w*|swap\w*|rma|new (node|server|unit)|install\w*|rack\s*(&|and)\s*stack|motherboard|mainboard|nic|bmc|gpu tray|re-?image)\b/i;
const PODCRAWLER_STEP = "Rescan the server in Podcrawler so NetBox, Yard and FastTrack get the new serial and MAC addresses";

function ensurePodcrawlerStep(r) {
  const text = `${r.task_type} ${r.request_summary} ${r.next_steps.join(" ")}`;
  if (!REPLACEMENT_RE.test(text)) return r;
  if (r.next_steps.some((s) => /podcrawler|re-?scan/i.test(s))) return r;
  const steps = [...r.next_steps];
  // put it before a final "update/close the ticket" step if there is one
  const last = steps[steps.length - 1] || "";
  const at = /\b(ticket|jira|comment|close|hand ?(back|off)|update)\b/i.test(last) ? steps.length - 1 : steps.length;
  steps.splice(at, 0, PODCRAWLER_STEP);
  return { ...r, next_steps: steps };
}
