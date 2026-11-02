// RMA card: opens the RMA ticket for the open DC ticket, the way techs do it in Jira.
// 1. Asks for the failed part (Lambda P/N, MPN), the old S/N, the new S/N and a description, and shows everything for review.
// 2. Creates the RMA ticket in the RMA project (request type "Advance Replacement" by default), copies the server
//    details from the DC ticket (every field both have: hostname, chassis SN, device type, site, location, links…),
//    fills in the part and serials, and links it to the DC ticket ("relates to"). Runs in the Jira tab with the user's login.
// If the ticket already has an RMA ticket (linked to it or to one of its sub-tasks), no new one is created: the details
// are added to that RMA ticket as an internal comment instead.
// Fields are found by name, so nothing depends on this Jira's field IDs.

const RMA_FIELD_NAMES = {
  mpn: "Manufacturer Part Number", oldSn: "Faulty Part SN", newSn: "Replacement SN", faultyPn: "Faulty Part Number",
  component: "Component Issue", rmaType: "RMA Type"
};
const RMA_PROJECT = "RMA";                      // the RMA Request project
const RMA_DEFAULT_KIND = "Advance Replacement"; // request type used unless the tech picks another

// Runs inside the Jira tab (chrome.scripting), so it must be self-contained.
async function rmaJiraInPage(op, a) {
  const ctx = document.querySelector('meta[name="ajs-context-path"]')?.content || "";
  const call = async (method, path, body) => {
    const res = await fetch(ctx + path, { method, credentials: "include", body: body && JSON.stringify(body),
      headers: { Accept: "application/json", "Content-Type": "application/json", "X-Atlassian-Token": "no-check" } });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!res.ok) {
      const errs = data ? [...(data.errorMessages || []), ...Object.entries(data.errors || {}).map(([k, v]) => `${k}: ${v}`)] : [];
      throw new Error(`Jira ${res.status}${errs.length ? `: ${errs.join("; ")}` : ""}`);
    }
    return data;
  };
  // A work item type's create fields (Jira returns at most 200 per request).
  const fieldsOf = async (project, typeId) => {
    const out = [];
    for (let start = 0; start < 2000; start += 200) {
      const meta = await call("GET", `/rest/api/3/issue/createmeta/${encodeURIComponent(project)}/issuetypes/${typeId}?maxResults=200&startAt=${start}`);
      const page = meta.fields || meta.values || [];
      out.push(...page);
      if (page.length < 200 || meta.isLast) break;
    }
    return out;
  };
  try {
    // The RMA project's kinds (its service desk request types) and the fields of the default kind.
    if (op === "meta") {
      const types = await call("GET", `/rest/api/3/issue/createmeta/${encodeURIComponent(a.project)}/issuetypes?maxResults=100`);
      const typeList = types.issueTypes || types.values || [];
      let kinds = [];
      try {
        const desk = (await call("GET", "/rest/servicedeskapi/servicedesk?limit=100")).values?.find((d) => d.projectKey === a.project);
        if (desk) {
          kinds = ((await call("GET", `/rest/servicedeskapi/servicedesk/${desk.id}/requesttype?limit=100`)).values || [])
            .map((r) => ({ name: r.name.trim(), requestTypeId: r.id, typeId: r.issueTypeId }))
            .filter((k) => typeList.some((t) => t.id === k.typeId));
        }
      } catch { /* no service desk access: fall back to the work item types */ }
      if (!kinds.length) kinds = typeList.filter((t) => !t.subtask && t.name !== "Task").map((t) => ({ name: t.name, typeId: t.id }));
      if (!kinds.length) return { ok: false, error: `Can't create tickets in the ${a.project} project.` };
      const def = kinds.find((k) => k.name === a.defaultKind) || kinds[0];
      const fields = {};
      for (const f of await fieldsOf(a.project, def.typeId)) fields[f.name] = { id: f.fieldId, options: (f.allowedValues || []).map((v) => v.value || v.name).filter(Boolean) };
      return { ok: true, kinds, defaultKind: def.name, fields };
    }
    // Create the RMA ticket: the DC ticket's server details (every field both have) plus the RMA fields.
    if (op === "createRma") {
      const rmaFields = await fieldsOf(a.project, a.kind.typeId);
      const dc = (await call("GET", `/rest/api/3/issue/${encodeURIComponent(a.dcKey)}?fields=*all`)).fields || {};
      const fields = { project: { key: a.project }, issuetype: { id: a.kind.typeId }, summary: a.summary, description: a.description, ...a.fields };
      const skip = new Set(["summary", "description", "issuetype", "project", "reporter", "assignee", "labels", "priority", "parent",
        "components", "duedate", "issuelinks", "attachment", "customfield_10010", ...Object.keys(a.fields)]);
      const copied = [];
      for (const f of rmaFields) {
        const v = dc[f.fieldId];
        if (skip.has(f.fieldId) || v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length)) continue;
        const allowed = (f.allowedValues || []).map((x) => x.value || x.name);
        const ok = (val) => !allowed.length || allowed.includes(val);
        const t = f.schema?.type;
        let out = null;
        if (t === "option" && v.value && ok(v.value)) out = { value: v.value };
        else if (t === "array" && f.schema.items === "option") out = v.filter((x) => ok(x.value)).map((x) => ({ value: x.value }));
        else if (t === "string" && typeof v === "string") out = v;
        else if (t === "number" && typeof v === "number") out = v;
        else if ((t === "date" || t === "datetime") && typeof v === "string") out = v;
        if (out !== null && !(Array.isArray(out) && !out.length)) { fields[f.fieldId] = out; copied.push(f.name); }
      }
      // The service desk request type puts it in the right queue; if Jira won't take it here, create without it.
      let created;
      try {
        created = await call("POST", "/rest/api/3/issue", { fields: a.kind.requestTypeId ? { ...fields, customfield_10010: String(a.kind.requestTypeId) } : fields });
      } catch (e) {
        if (!a.kind.requestTypeId || !/customfield_10010|request type/i.test(e.message)) throw e;
        created = await call("POST", "/rest/api/3/issue", { fields });
      }
      return { ok: true, key: created.key, copied };
    }
    // What techs used before: past RMA tickets for the same server model (the DC ticket's "Device Type") and component.
    if (op === "history") {
      const i = await call("GET", `/rest/api/3/issue/${encodeURIComponent(a.dcKey)}?fields=*all&expand=names`);
      const idOf = (name) => Object.keys(i.names || {}).find((k) => i.names[k] === name);
      const device = String(i.fields[idOf("Device Type")] || "");
      const model = (device.match(/\b(?:SYS|AS|ARS)-[A-Z0-9-]+?(?=-\d{2}-LL\d+|-LL\d+|\s|$)/i) || [])[0] || device.replace(/^\S+\s+|\s+[\d.]+$/g, "").trim();
      if (!model || !a.component) return { ok: true, model, counts: {} };
      const read = ["Manufacturer Part Number", "Faulty Part Number"].map(idOf).filter(Boolean);
      const jql = `project = ${a.project} AND "Device Type" ~ "${model.replace(/"/g, "")}" AND "Component Issue" = "${a.component.replace(/"/g, "")}" ORDER BY created DESC`;
      const r = await call("GET", `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=100&fields=${read.join(",")}`);
      const counts = {};
      for (const x of r.issues || []) {
        const ids = new Set(read.flatMap((k) => String(x.fields[k] || "").toUpperCase().match(/\b(?:\d{3}-\d{6}|[A-Z]{2,5}-[A-Z0-9-]{3,}|[A-Z]{3}\d{4})\b/g) || []));
        for (const t of ids) counts[t] = (counts[t] || 0) + 1;
      }
      return { ok: true, model, counts, tickets: (r.issues || []).length };
    }
    // "relates to" link between the RMA ticket and the DC ticket.
    if (op === "link") {
      await call("POST", "/rest/api/3/issueLink", { type: { name: "Relates" }, inwardIssue: { key: a.from }, outwardIssue: { key: a.to } });
      return { ok: true };
    }
    // RMA tickets already linked to the DC ticket or to its sub-tasks (where Automation links them).
    if (op === "existing") {
      const i = await call("GET", `/rest/api/3/issue/${encodeURIComponent(a.key)}?fields=issuelinks,subtasks`);
      const linked = (x) => (x.fields?.issuelinks || []).map((l) => (l.outwardIssue || l.inwardIssue)?.key).filter(Boolean);
      const keys = new Set(linked(i));
      for (const sub of (i.fields.subtasks || []).slice(0, 20)) {
        linked(await call("GET", `/rest/api/3/issue/${encodeURIComponent(sub.key)}?fields=issuelinks`)).forEach((k) => keys.add(k));
      }
      const rmas = [...keys].filter((k) => k.toUpperCase().startsWith(`${a.rmaProject.toUpperCase()}-`));
      const out = [];
      const snFields = (a.snFields || []).filter(Boolean);
      const strings = (v, acc = []) => {
        if (typeof v === "string") acc.push(v);
        else if (v && typeof v === "object") Object.values(v).forEach((x) => strings(x, acc));
        return acc;
      };
      for (const k of rmas.slice(0, 5)) {
        const r = await call("GET", `/rest/api/3/issue/${encodeURIComponent(k)}?fields=${["summary", "status", "description", "comment", ...snFields].join(",")}`);
        // Every serial-like word on it (to skip serials it already has) and the ones in its S/N fields or "S/N: X" lines (to show).
        // One block per comment, one for the summary and description, one for the S/N fields: a swap is on the RMA
        // when its old and new S/N are in the same block.
        const blockOf = (v) => [...new Set((strings(v).join("\n").toUpperCase().match(/[A-Z0-9][A-Z0-9-]{4,}/g) || [])
          .map((t) => t.replace(/[^A-Z0-9]/g, "")).filter((t) => t.length >= 6 && /\d/.test(t)))];
        const blocks = [blockOf([r.fields.summary, r.fields.description]), blockOf(snFields.map((f) => r.fields[f])),
          ...(r.fields.comment?.comments || []).map((c) => blockOf(c.body))].filter((b) => b.length);
        const text = strings([r.fields.summary, r.fields.description, r.fields.comment?.comments?.map((c) => c.body), snFields.map((f) => r.fields[f])]).join("\n");
        const shown = new Set(snFields.flatMap((f) => strings(r.fields[f])).flatMap((v) => v.split(/[\s,;\/]+/)).map((v) => v.trim().toUpperCase()).filter((v) => v.length >= 6));
        for (const m of text.matchAll(/\b(?:s\/?n|serial)\b[^:\n]{0,15}[:#]\s*([A-Z0-9][A-Z0-9-]{5,40})/gi)) shown.add(m[1].toUpperCase());
        out.push({ key: r.key, summary: r.fields.summary, status: r.fields.status?.name || "", blocks, serials: [...shown] });
      }
      return { ok: true, rmas: out };
    }
    // Internal comment (agents only) on a Jira Service Management ticket.
    if (op === "comment") {
      await call("POST", `/rest/api/3/issue/${encodeURIComponent(a.key)}/comment`, { body: a.body, properties: [{ key: "sd.public.comment", value: { internal: true } }] });
      return { ok: true };
    }
    return { ok: false, error: `Unknown operation ${op}` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function rmaJira(tabId, op, args) {
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: rmaJiraInPage, args: [op, args] });
    return res?.result || { ok: false, error: "The Jira tab didn't answer. Keep the ticket open and try again." };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Best guess for "Component Issue" from the part and the ticket ("GPU fell off the bus" → "GPU - FALLEN OF BUS").
function guessComponent(options, part, ticketText) {
  const text = (`${part?.name || ""} ${part?.desc || ""} ${part?.lambda || ""} ${part?.legacy || ""}`.trim() || String(ticketText || "").slice(0, 3000)).toLowerCase();
  const pick = (re) => options.find((o) => re.test(o));
  const pn = String(part?.lambda || "").slice(0, 3);
  if (/switch ?board|plx|pcie switch/.test(text)) return pick(/PCIE Switch/i); // "switch board for … SXM5 GPU system" isn't a GPU
  if (/^204/.test(pn) || /baseboard|hgx/.test(text)) return pick(/^GPU Baseboard$/i);
  if (/^206/.test(pn) || /\b(gpu|h100|h200|b200|b300|a100)\b/.test(text)) {
    if (/fall(en)? off the bus|xid\s*79/i.test(ticketText)) return pick(/FALLEN/i) || pick(/^GPU$/i);
    if (/not detected|missing gpu/i.test(ticketText)) return pick(/NOT DETECTED/i) || pick(/^GPU$/i);
    if (/overheat|thermal/i.test(ticketText)) return pick(/OVERHEATING/i) || pick(/^GPU$/i);
    if (/sram|uncorrectable/i.test(ticketText)) return pick(/SRAM/i) || pick(/^GPU$/i);
    if (/missing memory|row remap/i.test(ticketText)) return pick(/MISSING MEMORY/i) || pick(/^GPU$/i);
    return pick(/^GPU$/i);
  }
  const map = [[/switch ?board|plx|pcie switch/, /PCIE Switch/i], [/^217|riser/, /Riser/i], [/backplane/, /BackPlane/i], [/\bm\.2\b/, /^M\.2$/i],
    [/^207|dimm|memory|rdimm/, /^DIMM$/i], [/^20[89]|ssd|nvme|drive/, /SSD|NVME/i], [/^214|psu|power supply/, /^PSU$/i],
    [/^211|connectx|nic|hca|bluefield|bf3/, /NIC|HCA/i], [/^205|cpu|xeon|epyc/, /^CPU$/i], [/^213|motherboard|mainboard/, /Motherboard/i],
    [/fan/, /^Fan$/i], [/^23[68]|optic|transceiver|osfp|qsfp/, /Optic/i], [/cable/, /Cable/i]];
  for (const [re, opt] of map) if (re.test(`${pn} ${text}`)) return pick(opt);
  return "";
}

const cleanSn = (s) => String(s || "").trim().replace(/\s+/g, "").toUpperCase();

// Like the RMA tickets techs open: "ord01-cl01-hgx-0084 - replace NVIDIA H100 80 GB SXM5 SN 1653623034699".
function rmaSummary(f) {
  const what = f.partName || [f.lambda, f.mpn].filter(Boolean).join(" ") || "part";
  return `${f.hostname ? `${f.hostname} - ` : ""}replace ${what} SN ${f.oldSn}`.slice(0, 250);
}

// Jira's rich-text format for the description: one paragraph per line.
function rmaDescription(f, key) {
  const lines = [
    ...String(f.description || "").split(/\n+/).map((l) => l.trim()).filter(Boolean),
    `Failed part: ${[f.lambda && `Lambda P/N ${f.lambda}`, f.mpn && `MPN ${f.mpn}`, f.partName].filter(Boolean).join(" · ")}`,
    `Faulty part S/N (old): ${f.oldSn}`,
    `Replacement S/N (new): ${f.newSn}`,
    `From ${key}, created with Lambda Rackside.`
  ];
  return { type: "doc", version: 1, content: lines.map((t) => ({ type: "paragraph", content: [{ type: "text", text: t }] })) };
}

// The comment added to an existing RMA ticket.
function rmaComment(f, key) {
  const lines = [
    `Another part for this RMA, from ${key}:`,
    `Failed part: ${[f.lambda && `Lambda P/N ${f.lambda}`, f.mpn && `MPN ${f.mpn}`, f.partName].filter(Boolean).join(" · ")}`,
    `Faulty part S/N (old): ${f.oldSn}`,
    `Replacement S/N (new): ${f.newSn}`,
    [f.component && `Component: ${f.component}`, f.rmaType && `RMA type: ${f.rmaType}`].filter(Boolean).join(" · "),
    ...String(f.description || "").split(/\n+/).map((l) => l.trim()).filter(Boolean),
    "Added with Lambda Rackside."
  ].filter(Boolean);
  return { type: "doc", version: 1, content: lines.map((t) => ({ type: "paragraph", content: [{ type: "text", text: t }] })) };
}

function rmaProblems(f) {
  const out = [];
  if (!f.lambda && !f.mpn) out.push("Enter the part's Lambda P/N or MPN.");
  if (!f.oldSn) out.push("Enter the old (faulty) S/N.");
  if (!f.newSn) out.push("Enter the new (replacement) S/N.");
  if (f.oldSn && f.newSn && f.oldSn === f.newSn) out.push("The old and new S/N are the same.");
  for (const [k, label] of [["oldSn", "old S/N"], ["newSn", "new S/N"]]) {
    if (f[k] && (f[k].length < 4 || !/^[A-Z0-9._\/-]+$/.test(f[k]))) out.push(`The ${label} doesn't look like a serial number.`);
  }
  if (!f.kind) out.push("Choose the kind of RMA.");
  if (String(f.description || "").trim().length < 10) out.push("Describe the failure in a few words.");
  return out;
}

// state: { step: "idle" | "loading" | "form" | "review" | "running" | "done", meta, form, problems, progress, result, error }
function renderRma(box, state, actions) {
  if (!box) return;
  box.innerHTML = "";
  const canReset = ["form", "review", "done"].includes(state.step) || (state.step === "idle" && state.error);
  box.appendChild(h("div", { class: "label rma-head" }, "🔁 RMA",
    state.step === "idle" || state.step === "done" ? h("button", { class: "mini", onclick: actions.onStart }, state.step === "done" ? "Start another…" : "Create RMA ticket…") : null,
    canReset ? h("button", { class: "mini", title: "Clear this card and start over (nothing in Jira changes)", onclick: actions.onReset }, "↺ Reset") : null));

  if (state.error) box.appendChild(h("div", { class: "ping-msg bad" }, state.error));
  if (state.step === "idle" && !state.result) {
    box.appendChild(h("div", { class: "muted rma-intro" }, "After swapping a failed part: opens the RMA ticket with the part and both serial numbers, copies the server details from this ticket and links the two. If this ticket already has an RMA, adds to it instead."));
  }
  if (state.step === "loading") box.appendChild(h("div", { class: "muted" }, h("span", { class: "spinner" }), "Reading the RMA fields from Jira…"));
  if (state.step === "form") box.appendChild(rmaForm(state, actions));
  if (state.step === "review") box.appendChild(rmaReview(state, actions));
  if (state.step === "running" || state.step === "done") {
    box.appendChild(h("ol", { class: "rma-progress" }, state.progress.map((p) => h("li", { class: p.state },
      h("span", { class: "rma-mark" }, p.state === "ok" ? "✓" : p.state === "err" ? "✕" : p.state === "warn" ? "!" : "…"), " ", p.text))));
  }
  if (state.result?.links?.length) {
    box.appendChild(h("div", { class: "rma-result" }, state.result.links.map((l) =>
      h("button", { class: "mini", onclick: () => actions.openIssue(l) }, `${l} `, icon("external", 11)))));
  }
}

// Part description box and the catalog parts that match it (best first). Click one to use it.
function rmaCatalogPicker(state, actions) {
  if (!state.catalog) return null;
  const f = state.form;
  const list = h("div", { class: "rma-cands" });
  const head = h("div", { class: "rma-cands-head" });
  const show = () => {
    // Parts confirmed by NetBox (serial) or used before on this server model come first, then description matches.
    const pinned = [];
    for (const x of state.pinned || []) {
      const same = pinned.find((p) => partId(p.part) === partId(x.part));
      if (same) same.tags.push(...x.tags.filter((t) => !same.tags.includes(t)));
      else pinned.push({ part: x.part, exact: false, sameAs: [], tags: [...x.tags] });
    }
    let byDesc = catalogByDescription(state.catalog, f.partDesc), fallback = false;
    // Nothing from the description (none found, only generic words, or no match): list the component's catalog parts.
    if (!byDesc.length && f.component) {
      byDesc = catalogByComponent(state.catalog, f.component, state.serverText, state.historyCount);
      fallback = byDesc.length > 0;
    }
    const matches = [...pinned, ...byDesc.filter((m) => !pinned.some((x) => partId(x.part) === partId(m.part))).map((m) => ({ ...m, tags: [] }))];
    for (const m of matches) {
      const n = state.historyCount?.[partId(m.part)];
      if (n && !m.tags.some((t) => /^used/.test(t))) m.tags.push(`used ${n}× on ${state.historyModel}`);
      m.misfit = serverMismatch(state.serverText, m.part);
    }
    matches.sort((a, b) => !!a.misfit - !!b.misfit); // parts that don't fit this server last
    list.replaceChildren(...(matches.length ? matches.map((m) => {
      const p = m.part, chosen = f.lambda && p.lambda === f.lambda;
      return h("button", { type: "button", class: `rma-cand${chosen ? " chosen" : ""}`, onclick: () => actions.onPickPart(p, "picked from the list") },
        h("b", {}, partId(p)), " ", [p.vendor, p.name].filter(Boolean).join(" "),
        p.legacy && p.legacy !== partId(p) && h("span", { class: "muted" }, ` · ${p.legacy}`),
        p.mpn && h("span", { class: "muted" }, ` · ${p.mpn}`),
        m.tags.map((t) => h("span", { class: `rma-tag ${/NetBox/.test(t) ? "ok" : "info"}` }, t)),
        m.exact && h("span", { class: "rma-tag ok" }, "exact"),
        m.misfit && h("span", { class: "rma-tag bad" }, `doesn't fit this server: ${m.misfit}`),
        m.sameAs.length > 0 && h("span", { class: "rma-tag warn" }, `same description as ${m.sameAs.slice(0, 3).join(", ")}`),
        p.inactive && h("span", { class: "rma-tag warn" }, p.replacedBy ? `EOL → ${p.replacedBy}` : "EOL"));
    }) : [h("div", { class: "rma-nomatch" }, f.partDesc
      ? "No catalog part matches this description. Try other words (e.g. “H100 SXM5”, “PCIe switch board”), its MPN or Lambda P/N, or pick the Component below."
      : "Type the failed part's description, MPN or Lambda P/N above (e.g. “H100 SXM5”, “AOM-SXM5-IO-P”), or pick the Component below to list its parts.")]));
    head.textContent = fallback ? `No exact description match: ${f.component} parts in the catalog that fit this server:`
      : f.lambda ? "Matching parts in the catalog (the source of truth), best first:" : "👉 Choose the part you swapped from the catalog matches below (or refine the description):";
    head.className = `rma-cands-head${f.lambda ? " muted" : " rma-choose"}`;
  };
  const box = h("input", { class: "bmc-in", type: "text", spellcheck: "false", value: f.partDesc || "", "data-key": "partDesc", placeholder: "e.g. NVIDIA H100 80GB SXM5" });
  const badge = rmaSource(state, "partDesc");
  let t;
  box.addEventListener("input", () => {
    f.partDesc = box.value;
    state.touched.add("partDesc");
    badge?.remove();
    clearTimeout(t);
    t = setTimeout(show, 200);
  });
  show();
  return h("div", { class: "rma-catalog" },
    h("label", { class: "rma-row" }, h("span", { class: "rma-k" }, "Part description"), box, badge),
    head,
    list);
}

// Where a pre-filled value came from, shown next to the field until the user edits it.
function rmaSource(state, key) {
  const src = !state.touched.has(key) && state.sources[key];
  return src ? h("span", { class: `rma-src${/AI/.test(src) ? " ai" : ""}` }, src) : null;
}

function rmaForm(state, actions) {
  const f = state.form, opts = (name) => state.meta.fields[RMA_FIELD_NAMES[name]]?.options || [];
  const edited = (key, el, badge) => {
    f[key] = el.value;
    state.touched.add(key); // the user's own value: never replaced by a suggestion
    badge?.remove();
    if (key === "oldSn" || key === "newSn") actions.onSerial?.();
    if (key === "component") actions.onComponent?.();
  };
  const row = (label, key, control) => {
    const badge = rmaSource(state, key);
    control.addEventListener(control.tagName === "SELECT" ? "change" : "input", () => edited(key, control, badge));
    return h("label", { class: "rma-row" }, h("span", { class: "rma-k" }, label), control, badge);
  };
  const input = (key, attrs) => h("input", { class: "bmc-in", type: "text", spellcheck: "false", autocomplete: "off", value: f[key] || "", "data-key": key, ...attrs });
  const select = (key, name, blank) => h("select", { class: "bmc-in", "data-key": key }, h("option", { value: "" }, blank),
    opts(name).map((o) => h("option", { value: o, selected: f[key] === o ? "" : null }, o)));
  const desc = h("textarea", { class: "bmc-in rma-desc", rows: "4", "data-key": "description", placeholder: "What failed and what you saw (errors, tests, what you swapped)" });
  desc.value = f.description || "";
  const descBadge = rmaSource(state, "description");
  desc.addEventListener("input", () => edited("description", desc, descBadge));
  const pickers = state.choices.length > 1 && h("div", { class: "rma-choices" }, "Parts: ", state.choices.map((p) =>
    h("button", { class: "link", type: "button", onclick: () => actions.onPickPart(p) }, partId(p))));
  const form = h("form", { class: "rma-form" },
    state.existing?.length ? h("div", { class: "rma-existing" },
      h("b", {}, `This ticket already has ${state.existing.length === 1 ? "an RMA ticket" : "RMA tickets"}: `),
      state.existing.map((r) => h("label", { class: "rma-target" },
        state.existing.length > 1 && (() => {
          const radio = h("input", { type: "radio", name: "rmaTarget", checked: state.target === r.key ? "" : null });
          radio.addEventListener("change", () => (state.target = r.key));
          return radio;
        })(),
        h("b", {}, r.key), ` · ${r.status} · ${r.summary}`,
        r.serials?.length ? h("div", { class: "muted mono" }, `Already on it: ${r.serials.join(", ")}`) : null)),
      h("div", {}, "No new RMA will be created: these details are added to it as an internal comment.")) : null,
    h("div", { class: "rma-note" }, `Pre-filled from the ticket, the BMC, the catalog and the AI. Check every value: you confirm them before anything is ${state.existing?.length ? "added" : "created"}.`),
    state.aiBusy && h("div", { class: "muted" }, h("span", { class: "spinner" }), "✨ Reading the ticket and BMC to fill in the rest…"),
    state.aiNote && h("div", { class: "muted rma-ainote" }, state.aiNote),
    state.rmaSnNote && h("div", { class: "rma-serialnote" }, state.rmaSnNote),
    state.serialNote && h("div", { class: "rma-serialnote" }, state.serialNote),
    h("div", { class: "rma-sub" }, "Failed part"),
    pickers,
    rmaCatalogPicker(state, actions),
    row("Lambda P/N", "lambda", input("lambda", { placeholder: "e.g. 206-000503" })),
    row("MPN", "mpn", input("mpn", { placeholder: "Manufacturer part number" })),
    f.partName && h("div", { class: "muted rma-partname" }, f.partName),
    h("div", { class: "rma-sub" }, "Serial numbers"),
    row("Old S/N", "oldSn", input("oldSn", { placeholder: "Faulty part, the one you removed", class: "bmc-in mono" })),
    row("New S/N", "newSn", input("newSn", { placeholder: "Replacement, the one you installed", class: "bmc-in mono" })),
    h("div", { class: "rma-sub" }, "Description ", descBadge),
    desc,
    h("div", { class: "rma-sub" }, "RMA details"),
    opts("component").length ? row("Component", "component", select("component", "component", "Choose…")) : null,
    !state.existing?.length && state.meta.kinds?.length ? row("RMA kind", "kind", h("select", { class: "bmc-in", "data-key": "kind" },
      state.meta.kinds.map((k) => h("option", { value: k.name, selected: f.kind === k.name ? "" : null }, k.name)))) : null,
    opts("rmaType").length ? row("RMA type", "rmaType", select("rmaType", "rmaType", "(optional)")) : null,
    state.warnings?.length ? h("ul", { class: "rma-warnings" }, state.warnings.map((w) => h("li", {}, "⚠️ ", w))) : null,
    state.problems?.length ? h("ul", { class: "rma-problems" }, state.problems.map((p) => h("li", {}, p))) : null,
    h("div", { class: "rma-buttons" },
      h("button", { class: "primary", type: "submit" }, "Review →"),
      h("button", { class: "mini", type: "button", onclick: actions.onCancel }, "Cancel")));
  form.addEventListener("submit", (e) => { e.preventDefault(); actions.onReview(); });
  return form;
}

function rmaReview(state, actions) {
  const f = state.form;
  const adding = !!state.existing?.length;
  const rows = [
    adding ? ["Adds", `An internal comment to ${state.target} (no new RMA ticket)`] : ["Creates", `${f.kind} RMA ticket in ${RMA_PROJECT}`],
    !adding && ["Summary", rmaSummary(f)],
    ["Failed part", [f.lambda && `Lambda P/N ${f.lambda}`, f.mpn && `MPN ${f.mpn}`].filter(Boolean).join(" · "), "lambda"],
    ["Old S/N", f.oldSn, "oldSn"], ["New S/N", f.newSn, "newSn"],
    ["Description", f.description, "description"],
    ["Component", f.component, "component"], ["RMA type", f.rmaType, "rmaType"],
    !adding && ["Also", `Copies the server details from ${state.key} (hostname, chassis SN, device type, site, location…) and links the RMA ticket to it (“relates to”)`]
  ].filter((r) => r && r[1]);
  const create = h("button", { class: "primary", disabled: "", onclick: actions.onCreate }, adding ? `✅ Add to ${state.target}` : "✅ Create RMA ticket");
  const tick = h("input", { type: "checkbox" });
  tick.addEventListener("change", () => (create.disabled = !tick.checked));
  return h("div", { class: "rma-review" },
    h("div", { class: "rma-sub" }, "Check before creating"),
    h("div", { class: "nb-grid" }, rows.map(([k, v, key]) => [h("div", { class: "nb-k" }, k),
      h("div", { class: `nb-v${/S\/N/.test(k) ? " mono" : ""}${k === "Description" ? " rma-desc-v" : ""}` }, v, key && rmaSource(state, key))])),
    state.warnings?.length ? h("ul", { class: "rma-warnings" }, state.warnings.map((w) => h("li", {}, "⚠️ ", w))) : null,
    h("label", { class: "rma-confirm" }, tick, " I checked the part number and both serial numbers against the parts."),
    h("div", { class: "rma-buttons" }, create, h("button", { class: "mini", onclick: actions.onEdit }, "← Edit")));
}

// ---------- Matching the failed part to the catalog by its description ----------
// The catalog is the source of truth. Every word of the failed part's description ("NVIDIA H100 80GB SXM5") must be in
// the catalog entry (extra catalog words are fine), and specs must not conflict: 80GB vs 141GB, H100 vs H200, DDR4 vs
// DDR5, 4800 vs 5600, SXM vs PCIe rule a part out. The same description can be listed under several P/Ns: shown together.

// Words that say what kind of thing it is but that catalog entries often leave out ("ConnectX-7 400Gb" has no "NIC").
const DESC_GENERIC = new Set(("gpu card module system part parts unit units replacement new spare failed faulty bad the a an and for with of x pcs pc qty " +
  "nic adapter hca memory drive disk").split(" "));
function descTokens(s) {
  const out = new Set();
  const text = String(s || "").toLowerCase()
    .replace(/(\d+)\s*(?:g|gbe|gbps|gb\/s)\b/g, "$1gb")                // 400G, 400GbE, 400Gb/s → 400gb
    .replace(/(\d+(?:\.\d+)?)\s*(gb|tb|mb|w|kw|mhz|ghz|mt\/s|mm|ft)\b/g, "$1$2")
    .replace(/\b([a-z]+)[\s-](\d)\b/g, "$1$2"); // ConnectX-7, ConnectX 7, BlueField-3 → connectx7, bluefield3
  for (let t of text.split(/[^a-z0-9.+\/]+/)) {
    t = t.replace(/^[./]+|[./]+$/g, "");
    if (t.length < 2 || DESC_GENERIC.has(t)) continue;
    out.add(t);
    const bare = t.match(/^(\d+(?:\.\d+)?)(mhz|ghz|mt\/s)$/); // 4800mhz also matches a plain 4800
    if (bare) out.add(bare[1]);
  }
  return out;
}
// Spec families: a part with a different value in the same family conflicts with the description.
const SPEC_FAMILIES = [/^\d+(?:\.\d+)?(gb|tb)$/, /^\d+k?w$/, /^\d{4}(mhz|mt\/s)?$/, /^[abhlv]\d{2,3}[a-z]?$/, /^(sxm\d?|pcie|nvl\d*|oam)$/, /^ddr\d$/, /^gen\d$/, /^connectx\d$/, /^bluefield\d$/];
function specConflict(q, pt) {
  for (const fam of SPEC_FAMILIES) {
    const a = [...q].filter((t) => fam.test(t)), b = [...pt].filter((t) => fam.test(t));
    if (a.length && b.length && !a.some((t) => b.includes(t))) return true;
  }
  return false;
}
// The catalog parts for a "Component Issue": Lambda P/N family and/or words in the catalog entry.
const COMPONENT_FAMILIES = [
  [/GPU Baseboard/i, ["204"], /baseboard|hgx/i], [/^GPU/i, ["206"], /\b(h100|h200|b200|b300|a100|gpu)\b/i, /switch ?board|plx|baseboard|riser|cable|bracket/i], [/DIMM/i, ["207"], /dimm|ddr\d/i],
  [/SSD|NVME/i, ["208", "209"], /ssd|nvme/i], [/^M\.2$/i, ["208", "209"], /m\.2/i], [/^PSU$/i, ["214"], /\bpsu\b|power supply/i],
  [/NIC|HCA/i, ["211"], /connectx|\bnic\b|hca|bluefield/i, /switch ?board|plx|retimer/i], [/PCIE Switch/i, [], /switch ?board|plx|pcie switch/i],
  [/Riser/i, ["217"], /riser/i], [/Motherboard/i, ["213"], /motherboard|mainboard|\bmbd\b/i], [/^CPU$/i, ["205"], /\b(cpu|xeon|epyc)\b/i],
  [/^Fan$/i, [], /\bfan\b/i], [/Optic/i, ["238"], /transceiver|optic|osfp|qsfp/i], [/BackPlane/i, [], /backplane/i]
];
function catalogByComponent(catalog, component, serverText, historyCount = {}, limit = 8) {
  const fam = COMPONENT_FAMILIES.find(([re]) => re.test(component || ""));
  if (!catalog || !fam) return [];
  const [, prefixes, words, not] = fam;
  return catalog.parts
    .filter((p) => !isWholeSystem(p) && (prefixes.includes(String(p.lambda).slice(0, 3)) || words.test(`${p.name} ${p.desc} ${p.mpn}`)) &&
      !not?.test(`${p.name} ${p.desc}`) && !serverMismatch(serverText, p))
    .sort((a, b) => (historyCount[partId(b)] || 0) - (historyCount[partId(a)] || 0) || !!a.inactive - !!b.inactive)
    .slice(0, limit).map((p) => ({ part: p, score: 0, exact: false, sameAs: [] }));
}

// Does the part fit the server? A part made for another GPU (A100 parts in an H100 server) or another GPU socket
// (SXM4 vs the H100's SXM5) doesn't. Returns why not, or "".
const GPU_SOCKET = { a100: "sxm4", a800: "sxm4", h100: "sxm5", h200: "sxm5", h800: "sxm5", h20: "sxm5" };
function serverMismatch(serverText, part) {
  const server = descTokens(serverText), pt = descTokens(`${part.vendor} ${part.name} ${part.desc}`);
  const gpus = [...server].filter((t) => t in GPU_SOCKET);
  if (!gpus.length) return "";
  const partGpus = [...pt].filter((t) => /^[abhl]\d{2,3}$/.test(t));
  if (partGpus.length && !partGpus.some((t) => gpus.includes(t))) return `made for ${partGpus.join("/").toUpperCase()}, this server has ${gpus.join("/").toUpperCase()}`;
  const sockets = new Set(gpus.map((g) => GPU_SOCKET[g])), partSockets = [...pt].filter((t) => /^sxm\d$/.test(t));
  if (partSockets.length && !partSockets.some((t) => sockets.has(t))) return `${partSockets.join("/").toUpperCase()}, this server is ${[...sockets].join("/").toUpperCase()}`;
  return "";
}
const descKey = (p) => [...descTokens(`${p.vendor} ${p.name} ${p.desc}`)].sort().join(" ");

// Catalog parts whose description best matches `text`, best first: [{ part, score, exact, sameAs: [other P/Ns with that description] }].
// Only words some catalog entry uses count ("Switch board is replaced" → switch, board), so a tech's sentence matches too.
const catalogWords = new WeakMap();
function partTokens(catalog) {
  if (!catalogWords.has(catalog)) {
    const tokens = new Map(catalog.parts.map((p) => [p, descTokens(`${p.vendor} ${p.name} ${p.desc} ${p.mpn} ${p.lambda} ${p.legacy}`)]));
    catalogWords.set(catalog, { tokens, vocab: new Set([...tokens.values()].flatMap((t) => [...t])) });
  }
  return catalogWords.get(catalog);
}
function catalogByDescription(catalog, text, limit = 6) {
  if (!catalog) return [];
  const { tokens, vocab } = partTokens(catalog);
  const q = new Set([...descTokens(text)].filter((t) => vocab.has(t)));
  if (!q.size) return [];
  const found = [];
  for (const p of catalog.parts) {
    if (isWholeSystem(p)) continue;
    const pt = tokens.get(p);
    const common = [...q].filter((t) => pt.has(t)).length;
    if (!common || specConflict(q, pt)) continue;
    const coverage = common / q.size;                 // how much of the description the part has
    const tight = common / pt.size;                   // prefer entries without much else
    const score = coverage + 0.15 * tight - (p.inactive ? 0.05 : 0) + (p.lambda ? 0.02 : 0);
    if (coverage >= 0.5) found.push({ part: p, score, coverage, common, exact: coverage === 1 });
  }
  found.sort((a, b) => b.score - a.score);
  const top = found.slice(0, limit);
  for (const m of top) {
    const k = descKey(m.part);
    m.sameAs = found.filter((o) => o !== m && descKey(o.part) === k).map((o) => partId(o.part));
  }
  return top;
}

// ---------- Pre-filling ----------

// Serial numbers written in the ticket or its comments: "old SN: X", "replace GPU SN X", "new serial X", "installed SN X".
function serialsInText(text) {
  const { olds, news } = allSerialsInText(text);
  return { oldSn: olds[0] || "", newSn: news[0] || "" };
}
// Every old and new serial the ticket names, in order ("GPU1 OLD: A New: B … GPU3 OLD: C New: D" → olds [A, C], news [B, D]).
function allSerialsInText(text) {
  const t = String(text || "");
  // A serial, stopping before a following "New"/"Old" when the two run together ("OA242S018019New: …").
  const SN = "([A-Z0-9][A-Z0-9-]{5,40}?)(?=(?:new|old)\\b|[^A-Z0-9-]|$)";
  const grab = (words) => {
    const withSn = [...t.matchAll(new RegExp(`\\b(?:${words})\\b[^\\n]{0,30}?\\b(?:s\\/?n|serial(?: number)?)\\b[\\s:#=-]*${SN}`, "gi"))];
    const withColon = [...t.matchAll(new RegExp(`(?<![a-z])(?:${words})\\b\\s*(?:part\\s*)?[:=#]\\s*${SN}`, "gi"))]; // "OLD: X", "…New: X"
    const found = [...withSn, ...withColon].sort((a, b) => a.index - b.index).map((m) => cleanSn(m[1]));
    return [...new Set(found)];
  };
  // "replace GPU SN X" (how DC tickets name the failed part) is the old one; "replacement SN X" the new one.
  const olds = grab("old|faulty|failed|bad|defective|removed|original|replace|replacing|swap|swapping");
  const news = grab("new|replacement(?! of)|installed|good|spare").filter((n) => !olds.includes(n)); // "requesting replacement of X (SN …)" is the failed part
  return { olds: olds.filter((o) => !news.includes(o)), news };
}

// The ticket in blocks: its fields and description, then one block per comment or work log ("- [date] Name: …").
function ticketBlocks(text) {
  return String(text || "").split(/\n(?=- \[\d{4}-\d\d-\d\d[\d :]*\] )/).map((b) => {
    const m = b.match(/^- \[([\d :-]+)\] ([^:(\n]+?)\s*(?:\([^)]*\))?:\s/);
    return { who: m ? m[2].trim() : "", when: m ? m[1] : "", text: b };
  }).filter((b) => b.text.trim());
}

// The swaps the ticket names: the old and the new S/N come from the same comment (the tech who swapped writes both),
// paired in order there ("GPU1 OLD: A New: B, GPU3 OLD: C New: D"). Oldest comment first.
function ticketSwaps(text) {
  const out = [];
  for (const b of ticketBlocks(text)) {
    const { olds, news } = allSerialsInText(b.text);
    const n = Math.max(olds.length, news.length);
    for (let i = 0; i < n; i++) out.push({ oldSn: olds[i] || "", newSn: news[i] || "", who: b.who, when: b.when, text: b.text });
  }
  // A comment by the tech who swapped ("Old s/n: X / New s/n: Y") beats the description (which only names the failed part);
  // complete pairs first.
  const rank = (x) => (x.oldSn && x.newSn ? 0 : 2) + (x.who ? 0 : 1);
  return out.filter((x) => x.oldSn !== x.newSn).sort((a, b) => rank(a) - rank(b));
}

// Catalog parts the whole ticket names, by number (Lambda P/N, SKU, MPN) or by description, for the RMA's part list.
// Parts named in the comment with the serials (the swap) count most. Returns [{part, tags, score, byNumber}], best first.
function ticketCatalogParts(catalog, text, swapText = "") {
  if (!catalog) return [];
  const found = new Map();
  const add = (p, score, tag, byNumber) => {
    if (!p || isWholeSystem(p)) return;
    const id = partId(p), x = found.get(id) || { part: catalog.parts.find((q) => partId(q) === id) || p, tags: [], score: 0, byNumber: false };
    x.score += score;
    x.byNumber ||= byNumber;
    if (!x.tags.includes(tag)) x.tags.push(tag);
    found.set(id, x);
  };
  for (const [t, w, where] of [[swapText, 3, "in the swap comment"], [text, 1, "in the ticket"]]) {
    if (!t) continue;
    for (const p of findCatalogParts(catalog, [t])) add(p, 2 * w, `P/N named ${where}`, true);
    // Short lines are where techs name the part; one shared word ("System powered off" vs "… GPU system") isn't enough. ("Replaced PCIe switch board"); long ones match everything.
    for (const line of t.split(/\n|(?<=[.;])\s+/).map((l) => l.trim()).filter((l) => l.length >= 6 && l.length <= 160).slice(0, 400)) {
      for (const m of catalogByDescription(catalog, line, 4)) if (m.coverage >= 0.66 && m.common >= 2) add(m.part, w * m.coverage, `described ${where}`, false);
    }
  }
  return [...found.values()].sort((a, b) => b.byNumber - a.byNumber || b.score - a.score).slice(0, 8);
}

// A serial the AI suggests is only kept if it appears in the ticket or BMC data (no invented serials).
const serialIn = (sn, text) => !!sn && String(text || "").toUpperCase().replace(/[^A-Z0-9]/g, "").includes(String(sn).toUpperCase().replace(/[^A-Z0-9]/g, ""));

const RMA_PREFILL_SCHEMA = {
  type: "object",
  properties: {
    part_description: { type: "string", description: "The failed part described like a catalog entry: vendor, model, capacity, form factor (e.g. 'NVIDIA H100 80GB SXM5', 'Samsung 64GB DDR5 4800 RDIMM'). Only what the ticket, BMC or catalog candidates support. Empty if unsure." },
    mpn: { type: "string", description: "Manufacturer part number of the failed part. Empty if unsure." },
    old_sn: { type: "string", description: "Serial number of the failed part that was removed, copied exactly from the ticket or BMC data. Empty if not written anywhere." },
    new_sn: { type: "string", description: "Serial number of the replacement part that was installed, copied exactly from the ticket. Empty if not written anywhere." },
    component: { type: "string", description: "Exactly one of the allowed Component Issue values, or empty." },
    rma_type: { type: "string", description: "Exactly one of the allowed RMA Type values if the ticket says (e.g. the OEM replaces it onsite), else empty." },
    description: { type: "string", description: "2 to 4 short factual lines for the RMA: what failed, the errors or symptoms, what was swapped. No serial numbers." }
  },
  required: ["part_description", "mpn", "old_sn", "new_sn", "component", "rma_type", "description"]
};

// Asks the AI to fill in the RMA from the ticket, the BMC and the catalog candidates. Returns {} on failure.
async function rmaAiPrefill(settings, privacy, ctx) {
  const user = [
    `Ticket ${ctx.key}:\n${String(ctx.issueText || "").slice(0, 15000)}`,
    ctx.bmc && `Failed components reported by the BMC: ${ctx.bmc}`,
    ctx.parts && `Catalog candidates for the failed part:\n${ctx.parts}`,
    `Allowed Component Issue values: ${ctx.components.join(" | ")}`,
    ctx.rmaTypes.length && `Allowed RMA Type values: ${ctx.rmaTypes.join(" | ")}`
  ].filter(Boolean).join("\n\n");
  const { result } = await generateStructured(settings, {
    system: "You prepare an RMA (return of a failed hardware part) for a datacenter technician. Fill in only what the ticket, its comments, the BMC data or the catalog candidates support. Never invent serial or part numbers: leave a field empty when it isn't written. The ticket's own part number is usually the whole server, not the failed part.",
    user: privacy.redact(user), schema: RMA_PREFILL_SCHEMA, schemaName: "rma_prefill"
  });
  return privacy.restore(result || {});
}

// Jira comment lines for RMA tickets created from the panel.
function rmaCommentLines(result) {
  if (!result?.links?.length) return [];
  return ["*RMA:*", `* ${result.added ? `Added to ${result.links[0]}` : result.links.join(" → ")}: ${result.part}, old S/N ${result.oldSn} → new S/N ${result.newSn}`];
}
