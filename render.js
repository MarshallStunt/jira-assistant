// Builds the at-a-glance brief in the side panel. Uses textContent only (no HTML from the model).

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    // Skip empty values (incl. 0 from `list.length && ...`); turn anything that isn't a Node into text.
    if (c === null || c === undefined || c === false || c === "" || c === 0) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// Collapsible card. Remembers whether you left it open (per section, on this computer).
// title: "text" or ["text", "one-line gist shown in the header"].
function fold(id, title, openByDefault, ...content) {
  const [label, gist] = [title].flat();
  let saved = null;
  try { saved = localStorage.getItem(`fold:${id}`); } catch {}
  const allOpen = ["open", "classic"].includes(document.documentElement.dataset.layout); // Settings → Appearance → Layout
  const d = h("details", { class: "card fold", id, open: allOpen || (saved === null ? openByDefault : saved === "1") ? "" : null },
    h("summary", {}, icon("chevron", 12), h("span", { class: "label" }, label), gist && h("span", { class: "fold-gist" }, gist)), ...content);
  d.addEventListener("toggle", () => { try { localStorage.setItem(`fold:${id}`, d.open ? "1" : "0"); } catch {} });
  return d;
}

function section(title, ...content) {
  return h("section", { class: "card" }, h("div", { class: "label" }, title), ...content);
}

// Click to copy. With a label (e.g. "Copy IP"), the button shows "Copied ✓" for a moment.
function copyChip(text, label) {
  const chip = h("button", { class: `chip${label ? " labelled" : " mono"}`, title: `Copy ${text}` }, label || text);
  chip.addEventListener("click", async () => {
    await navigator.clipboard.writeText(text);
    chip.classList.add("copied");
    if (label) chip.textContent = "Copied ✓";
    setTimeout(() => { chip.classList.remove("copied"); if (label) chip.textContent = label; }, 1200);
  });
  return chip;
}

// A person's name that opens Slack (see openSlack in sidepanel.js).
function personChip(name, onSlack) {
  if (!name) return null;
  if (!onSlack) return h("span", { class: "person" }, name);
  return h("button", { class: "person", title: `Open Slack to message ${name}`, onclick: () => onSlack(name) }, name);
}

// opts: { key, meta: {status, priority, assignee, reporter}, checks: Set<number>, onCheck(i, checked),
//         openSlack(name), partial, powerPending }
// Order: what kind of job and is it safe → what to do → where → how → reference.
function renderBrief(root, r, opts) {
  // The "At a glance" card is kept across redraws of the same ticket (they happen many times while the AI writes),
  // so it doesn't blink empty and refill each time.
  const keptGlance = document.getElementById("glance");
  const currentId = root.querySelector(".card.current")?.id; // keep the "you are here" outline on the redrawn card
  root.innerHTML = "";
  const { meta = {}, checks = new Set(), onCheck = () => {} } = opts;
  const slack = opts.openSlack;

  // 1. Ticket strip: task type + Jira status/priority, then the people on the ticket
  root.appendChild(h("div", { class: "strip" },
    r.task_type && h("span", { class: "tag task" }, r.task_type),
    meta.status && h("span", { class: "tag" }, meta.status),
    meta.priority && h("span", { class: "tag" }, `${meta.priority} priority`)));
  if (meta.assignee || meta.reporter) {
    root.appendChild(h("div", { class: "people" },
      meta.assignee && h("span", {}, h("span", { class: "people-k" }, "👤 Assignee"), personChip(meta.assignee, meta.assignee !== "Unassigned" && slack)),
      meta.reporter && h("span", {}, h("span", { class: "people-k" }, "📝 Reporter"), personChip(meta.reporter, slack))));
  }

  // 2. Power-down verdict banner
  if (opts.powerPending) {
    root.appendChild(h("div", { class: "power pending" },
      h("div", { class: "power-icon" }, h("span", { class: "spinner" })),
      h("div", {}, h("div", { class: "power-title" }, "⏻ Checking power-down…"))));
  } else {
    const p = POWER[r.power_down.verdict];
    root.appendChild(h("div", { class: `power ${p.cls}`, role: "status" },
      h("div", { class: "power-icon" }, icon({ ok: "check", info: "info", warn: "alert", danger: "x" }[p.cls], 14)),
      h("div", {},
        h("div", { class: "power-title" }, `⏻ ${p.label}`),
        r.power_down.reason && h("div", { class: "power-reason" }, r.power_down.reason),
        r.power_down.evidence && h("div", { class: "power-evidence" }, `“${r.power_down.evidence.replace(/^["“”']+|["“”']+$/g, "")}”`))));
  }

  // At a glance: the job, where, live state, the part and the next step (filled in by sidepanel.js → updateGlance).
  const glance = keptGlance?.dataset.key === opts.key ? keptGlance : h("section", { class: "card glance", id: "glance" });
  glance.dataset.key = opts.key;
  root.appendChild(glance);

  // 3. What to do
  if (r.request_summary || r.current_status) {
    root.appendChild(fold("request", "📋 Request", false,
      r.request_summary && h("p", { class: "lead" }, r.request_summary),
      r.current_status && h("p", { class: "status-line" }, h("b", {}, "Now: "), r.current_status)));
  }
  if (r.cautions.length) {
    // All of them are also in "At a glance", so the card starts folded.
    const card = fold("cautions", ["⚠️ Cautions", `${r.cautions.length}`], false, h("ul", {}, r.cautions.map((c) => h("li", {}, c))));
    card.classList.add("caution");
    root.appendChild(card);
  }

  // 4. Where: server, location, reachability (+ NetBox disagreements, filled in later)
  const loc = r.location;
  const site = splitSite(loc.site);
  const small = [["Row", loc.row], ["Rack", loc.rack], ["RU", loc.unit]].filter(([, v]) => v);
  const where = [r.server_names[0], site.code, loc.rack && `rack ${loc.rack}`, loc.unit && `RU ${loc.unit}`].filter(Boolean).join(" · ");
  root.appendChild(fold("server", ["🖥️ Server & location", where], false,
    h("div", { class: "label" }, "🖥️ Server"),
    h("div", { class: "chips" },
      r.server_names.length ? r.server_names.map((n) => copyChip(n)) : h("span", { class: "muted" }, "Not found in ticket")),
    h("div", { class: "label", style: "margin-top:10px" }, "📍 Location"),
    loc.site || small.length
      ? h("div", { class: "loc" },
          loc.site && h("div", { class: "loc-site" },
            h("div", { class: "loc-site-code" }, site.code),
            site.detail && h("div", { class: "loc-site-detail" }, site.detail)),
          small.length && h("div", { class: "loc-small" }, small.map(([k, v]) =>
            h("div", { class: "loc-cell" }, h("span", { class: "loc-k" }, k), h("span", { class: "loc-v" }, v)))))
      : h("span", { class: "muted" }, "Not found in ticket"),
    h("div", { id: "nbWarn" }),
    h("div", { id: "pingBox", class: "ping-box" })));

  // 5. BMC: login + health + power (filled in once NetBox has added any BMC IP)
  root.appendChild(h("section", { id: "bmcBox", class: "card bmc hidden" }));

  // 6. How: next steps as a checklist, parts
  if (r.next_steps.length) {
    const done = () => r.next_steps.filter((_, i) => checks.has(i)).length;
    const counter = h("span", { class: "count" }, `${done()}/${r.next_steps.length}`);
    root.appendChild(h("section", { class: "card", id: "steps" },
      h("div", { class: "label" }, "✅ Next steps ", counter, h("span", { class: "pill" }, `${r.confidence} confidence`)),
      h("ol", { class: "checklist" }, r.next_steps.map((s, i) => {
        const caution = /^caution:/i.test(s);
        const box = h("input", { type: "checkbox" });
        box.checked = checks.has(i);
        const li = h("li", { class: `${caution ? "risky" : ""}${box.checked ? " done" : ""}` },
          h("label", {}, box, h("span", {}, s)));
        box.addEventListener("change", () => {
          box.checked ? checks.add(i) : checks.delete(i);
          li.classList.toggle("done", box.checked);
          counter.textContent = `${done()}/${r.next_steps.length}`;
          onCheck(i, box.checked);
        });
        return li;
      }))));
  }
  // Parts: what the AI read in the ticket, plus matches from the Lambda parts catalog (filled in later).
  root.appendChild(fold("parts", ["🧰 Parts & tools", r.parts_tools.slice(0, 2).join(", ")], false,
    r.parts_tools.length ? h("div", { class: "chips" }, r.parts_tools.map((t) => h("span", { class: "chip" }, t))) : null,
    h("div", { id: "catalogBox" })));
  root.appendChild(h("section", { class: "card", id: "rmaBox" }));

  // 7. Reference: history, NetBox record, open questions
  root.appendChild(fold("history", `🕘 History${r.history.length ? ` (${r.history.length})` : ""}`, false,
    r.history.length
      ? h("ol", { class: "timeline" }, r.history.map((e) => h("li", {},
          h("div", { class: "tl-meta" }, e.when, e.when && e.who && " · ", e.who && personChip(e.who, slack)),
          h("div", {}, e.what))))
      : h("span", { class: "muted" }, "No previous work on this ticket.")));

  root.appendChild(h("details", { id: "netboxBox", class: "card nb fold hidden" }));

  if (r.probable_cause || r.missing_info.length) {
    root.appendChild(fold("confirm", r.missing_info.length ? `❓ To confirm (${r.missing_info.length}) & cause` : "🔎 Probable cause", r.missing_info.length > 0,
      r.missing_info.length ? h("ul", {}, r.missing_info.map((m) => h("li", {}, m))) : null,
      r.probable_cause && h("p", { class: "cause" }, h("b", {}, "Probable cause: "), r.probable_cause)));
  }
  if (currentId) document.getElementById(currentId)?.classList.add("current");
}

// Reachability rows inside the Server card.
// state: { loading, targets, resp }  (resp = helper response or error object)
function renderPing(box, state, actions) {
  if (!box) return;
  box.innerHTML = "";
  const { loading, targets = [], resp } = state;
  const header = h("div", { class: "label ping-head" }, "📡 Reachability",
    resp?.at && !loading && h("span", { class: "ping-age" }, ` · ${new Date(resp.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`),
    !loading && h("button", { class: "mini", onclick: actions.onPing }, resp ? "Ping again" : "Ping"));
  box.appendChild(header);

  if (loading) {
    box.appendChild(h("div", { class: "muted" }, `Pinging ${targets.length} address${targets.length === 1 ? "" : "es"}…`));
    return;
  }
  if (!resp) {
    box.appendChild(h("div", { class: "muted" }, targets.length ? `${targets.length} address${targets.length === 1 ? "" : "es"} to check.` : "No IP address found in the ticket."));
    return;
  }
  if (!resp.ok) {
    box.appendChild(h("div", { class: `ping-msg${resp.noTargets ? "" : " bad"}` }, resp.error || "Ping failed."));
    if (resp.notInstalled) {
      box.appendChild(h("button", { class: "mini", onclick: actions.onSetup }, "How to install the ping helper"));
    }
    return;
  }

  const rows = h("div", { class: "ping-rows" });
  for (const x of resp.results) {
    const state = !x.ok ? "err" : x.reachable ? (x.loss > 0 ? "warn" : "up") : "down";
    const statusText = !x.ok ? x.error
      : x.reachable ? `${fmtMs(x.avg_ms)} ms${x.loss > 0 ? ` · ${x.loss}% loss` : ""}`
      : `No reply${x.note ? ` (${x.note})` : ""}`;
    const via = interfaceLabel(x);
    rows.appendChild(h("div", { class: `ping-row ${state}`, title: x.gateway ? `Gateway ${x.gateway} · source ${x.source_ip || "?"}` : "" },
      h("span", { class: "dot" }),
      h("div", { class: "ping-main" },
        h("div", {},
          h("span", { class: "role" }, ROLE_LABEL[x.role] || "Host"),
          h("span", { class: "mono addr" }, x.address),
          x.ip && x.ip !== x.address && h("span", { class: "mono muted" }, ` → ${x.ip}`),
),
        h("div", { class: "ping-sub" },
          h("b", {}, statusText),
          via && ` · via ${via}`))
    ));
  }
  box.appendChild(rows);
  const guess = serverPowerGuess(resp.results);
  if (guess) {
    const off = h("b", {}, "the chassis is most likely already powered down");
    const confirm = " Confirm the power state on the BMC (Check health) before you start.";
    box.appendChild(h("div", { class: "ping-power" }, h("b", {}, "⏻ "), ...{
      "bmc-up": ["The server isn't answering ping but its BMC is: ", off, ".", confirm],
      "no-bmc": ["The server isn't answering ping: ", off, " (or it's off the network).", confirm],
      "all-down": ["Neither the server nor its BMC answer ping: you may not be on the datacenter network or VPN. If you are, the server is most likely powered down."]
    }[guess]));
  }
}

// "ORD01 - Elk Grove Village, IL (EdgeConnex CHI02)" → { code: "ORD01", detail: "Elk Grove Village, IL (EdgeConnex CHI02)" }
function splitSite(site) {
  const m = String(site || "").match(/^\s*([A-Za-z0-9][\w.-]{1,15})\s*[-–—|:]\s+(.+)$/);
  return m ? { code: m[1], detail: m[2].trim() } : { code: String(site || ""), detail: "" };
}

// BMC IP addresses the AI found in the ticket.
function bmcIPs(r) {
  const seen = new Set();
  return (r.network_targets || [])
    .filter((t) => t.role === "bmc" && /^[0-9a-f.:]+$/i.test(t.address) && /[.:]/.test(t.address))
    .map((t) => t.address)
    .filter((a) => !seen.has(a) && seen.add(a))
    .slice(0, 4);
}

// "https://{ip}" + "10.1.2.3" → "https://10.1.2.3"  (IPv6 gets brackets)
function bmcUrl(template, ip) {
  const t = (template || "").includes("{ip}") ? template : "https://{ip}";
  return t.replace("{ip}", ip.includes(":") ? `[${ip}]` : ip);
}

const NB_STATUS_CLASS = { active: "ok", offline: "danger", failed: "danger", decommissioning: "danger", planned: "warn", staged: "warn", inventory: "warn" };

// state: { loading } | { nb } where nb = netboxLookup() result
function renderNetbox(box, state, actions) {
  if (!box) return;
  box.innerHTML = "";
  box.classList.remove("hidden");
  if (!box.dataset.foldBound) {
    let saved = null;
    try { saved = localStorage.getItem("fold:netbox"); } catch {}
    box.open = saved === "1";
    box.addEventListener("toggle", () => { try { localStorage.setItem("fold:netbox", box.open ? "1" : "0"); } catch {} });
    box.dataset.foldBound = "1";
  }
  const nb = state.nb;
  const first = nb?.ok && nb.devices[0];
  const gist = state.loading ? "looking up…"
    : !nb.ok ? (nb.notFound || nb.empty ? "not found" : "couldn't check")
    : [first.statusLabel, first.rack && `rack ${first.rack}`, first.position != null && `RU ${first.position}`].filter(Boolean).join(" · ");
  const refresh = !state.loading && h("button", { class: "mini icon-btn", title: "Look up again", "aria-label": "Look up in NetBox again",
    onclick: (e) => { e.preventDefault(); e.stopPropagation(); actions.onRefresh(); } }, icon("refresh", 12));
  box.appendChild(h("summary", {}, icon("chevron", 12), h("span", { class: "label" }, "🗄️ NetBox"),
    h("span", { class: `fold-gist${nb && !nb.ok && !state.loading ? " bad" : ""}` }, gist), refresh));

  if (state.loading) {
    box.appendChild(h("div", { class: "muted" }, "Looking up in NetBox…"));
    return;
  }
  if (!nb.ok) {
    box.appendChild(h("div", { class: `ping-msg${nb.empty ? "" : " bad"}` }, nb.error));
    const btns = h("div", { class: "nb-actions" });
    if (nb.auth) btns.appendChild(h("button", { class: "mini", onclick: actions.onOpenNetbox }, "Open NetBox to log in ", icon("external", 11)));
    btns.appendChild(h("button", { class: "mini", onclick: actions.onOpenPodcrawler }, "Open Podcrawler ", icon("external", 11)));
    box.appendChild(btns);
    return;
  }

  const warn = document.getElementById("nbWarn");
  const mismatches = nb.devices.flatMap((d) => d.mismatches);
  if (warn) warn.replaceChildren(...(mismatches.length ? [h("div", { class: "nb-warn" },
    h("b", {}, "⚠️ Ticket and NetBox disagree"), h("ul", {}, mismatches.map((m) => h("li", {}, m))))] : []));

  for (const d of nb.devices) {
    const statusCls = NB_STATUS_CLASS[d.status] || "info";
    const dev = h("div", { class: "nb-dev" });
    dev.appendChild(h("div", { class: "nb-title" },
      copyChip(d.name),
      d.statusLabel && h("span", { class: `nb-status ${statusCls}` }, d.statusLabel),
      h("button", { class: "mini nb-open", onclick: () => actions.openUrl(d.url) }, "Open in NetBox ", icon("external", 11))));
    if (d.model || d.role) dev.appendChild(h("div", { class: "nb-sub" }, [d.model, d.role].filter(Boolean).join(" · ")));

    const rows = [
      ["Site", [d.site, d.location].filter(Boolean).join(" · ")],
      ["Rack / RU", [d.rack && `Rack ${d.rack}`, d.position != null && `RU ${d.position}`, d.face].filter(Boolean).join(" · ")],
      ["Serial", d.serial, true],
      ["Lambda SKU", d.legacyLpn, true],
      ["Asset tag", d.assetTag, true],
      ["Tenant", [d.tenant, d.cluster].filter(Boolean).join(" · ")],
      ["Host IP", d.primaryIp, true],
      ["BMC IP", d.oobIp, true]
    ].filter(([, v]) => v);
    dev.appendChild(h("div", { class: "nb-grid" }, rows.map(([k, v, mono]) => [
      h("div", { class: "nb-k" }, k),
      h("div", { class: `nb-v${mono ? " mono" : ""}` }, v)
    ])));

    // Podcrawler
    dev.appendChild(h("div", { class: "nb-pc" },
      h("span", { class: "nb-k" }, "Podcrawler"),
      h("span", { class: "nb-pc-text" }, d.podcrawler
        ? `last activity ${timeAgo(d.podcrawler.at)}${d.podcrawler.text ? ` — ${d.podcrawler.text}` : ""}`
        : "no scan found in NetBox journal"),
      h("button", { class: "mini", title: "Opens Podcrawler and copies the hostname so you can paste it", onclick: () => actions.onOpenPodcrawler(d.name) }, "Open ", icon("external", 11))));

    // Work history from the NetBox journal (credentials already removed)
    if (d.history?.length) {
      dev.appendChild(h("details", { class: "nb-ifs" },
        h("summary", {}, `📝 Journal (${d.history.length})`),
        h("ul", { class: "nb-journal" }, d.history.map((j) => h("li", {},
          h("span", { class: "muted" }, `${new Date(j.at).toLocaleDateString()}${j.by ? ` · ${j.by}` : ""} · `), j.text)))));
    }
    // Installed modules (transceivers etc.)
    if (d.modules?.length) {
      dev.appendChild(h("details", { class: "nb-ifs" },
        h("summary", {}, `🧩 Modules (${d.modules.length})`),
        h("div", { class: "nb-if-list" }, d.modules.map((m) => h("div", { class: "nb-if" },
          h("span", { class: "mono nb-if-name" }, m.bay),
          h("span", { class: "nb-if-peer" }, [m.vendor, m.model, m.partNumber && m.partNumber !== m.model && `P/N ${m.partNumber}`].filter(Boolean).join(" · ")))))));
    }

    // Cabling (collapsed)
    const cabled = d.interfaces.filter((i) => i.peer);
    if (d.interfaces.length) {
      dev.appendChild(h("details", { class: "nb-ifs" },
        h("summary", {}, `Interfaces & cabling (${cabled.length} cabled)`),
        h("div", { class: "nb-if-list" }, d.interfaces.map((i) => h("div", { class: `nb-if${i.enabled ? "" : " off"}` },
          h("span", { class: "mono nb-if-name" }, i.name, i.mgmt && h("span", { class: "nb-mgmt" }, "mgmt")),
          h("span", { class: "nb-if-peer" }, i.peer ? `→ ${i.peer}` : "not cabled"),
          i.mac && h("span", { class: "mono nb-mac" }, i.mac))))));
    }
    box.appendChild(dev);
  }
  box.appendChild(h("div", { class: "nb-foot muted" }, `Checked ${timeAgo(nb.at)}`));
}

// The "At a glance" card. rows: [{ icon, key, text, note, tone: "ok" | "warn" | "bad" | "", jump: section id, action: button }]
// Rows are updated in place: a row whose text didn't change is left alone, so nothing blinks while data arrives.
function renderGlance(box, rows, onJump) {
  if (!box) return;
  let list = box.querySelector(".glance-rows");
  if (!list) box.replaceChildren(h("div", { class: "label" }, "⚡ At a glance"), (list = h("div", { class: "glance-rows" })));
  const old = new Map([...list.children].map((el) => [el.dataset.k, el]));
  const els = rows.map((r) => {
    const sig = JSON.stringify([r.key, r.text, r.note, r.tone, r.pending, !!r.action]);
    const el = old.get(r.icon);
    if (el?.dataset.sig === sig) return el;
    const row = h("div", { class: `glance-row ${r.tone || ""}${r.pending ? " pending" : ""}`, "data-k": r.icon, "data-sig": sig },
      h("span", { class: "glance-icon" }, r.icon),
      h("button", { class: "glance-main", type: "button", title: r.jump ? "Show the details" : null, onclick: () => r.jump && onJump(r.jump) },
        h("span", { class: "glance-k" }, r.key), h("span", { class: "glance-v" }, r.text),
        r.note && h("span", { class: "glance-note" }, r.note)),
      r.action || null);
    return row;
  });
  // Swap only what changed: unchanged rows stay in the page untouched.
  els.forEach((el, i) => {
    const at = list.children[i];
    if (at === el) return;
    if (at && !els.includes(at) && !el.isConnected) at.replaceWith(el);
    else list.insertBefore(el, at || null);
  });
  while (list.children.length > els.length) list.lastElementChild.remove();
}
