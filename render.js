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

function section(title, ...content) {
  return h("section", { class: "card" }, h("div", { class: "label" }, title), ...content);
}

function copyChip(text) {
  const chip = h("button", { class: "chip mono", title: "Click to copy" }, text);
  chip.addEventListener("click", async () => {
    await navigator.clipboard.writeText(text);
    chip.classList.add("copied");
    setTimeout(() => chip.classList.remove("copied"), 900);
  });
  return chip;
}

// opts: { key, meta: {status, priority, assignee, updated}, checks: Set<number>, onCheck(i, checked) }
function renderBrief(root, r, opts) {
  root.innerHTML = "";
  const { meta = {}, checks = new Set(), onCheck = () => {} } = opts;

  // 1. Ticket strip: task type + Jira status/priority/assignee
  root.appendChild(h("div", { class: "strip" },
    r.task_type && h("span", { class: "tag task" }, r.task_type),
    meta.status && h("span", { class: "tag" }, meta.status),
    meta.priority && h("span", { class: "tag" }, `${meta.priority} priority`),
    meta.assignee && h("span", { class: "tag subtle" }, `👤 ${meta.assignee}`)
  ));

  // 2. Power-down verdict banner
  const p = POWER[r.power_down.verdict];
  const icon = { ok: "✓", info: "i", warn: "!", danger: "✕" }[p.cls];
  root.appendChild(h("div", { class: `power ${p.cls}` },
    h("div", { class: "power-icon" }, icon),
    h("div", {},
      h("div", { class: "power-title" }, `⏻ ${p.label}`),
      r.power_down.reason && h("div", { class: "power-reason" }, r.power_down.reason),
      r.power_down.evidence && h("div", { class: "power-evidence" }, `“${r.power_down.evidence.replace(/^["“”']+|["“”']+$/g, "")}”`)
    )
  ));

  // 3. Server + location
  const loc = r.location;
  const site = splitSite(loc.site);
  const small = [["Row", loc.row], ["Rack", loc.rack], ["RU", loc.unit]].filter(([, v]) => v);
  const anyLoc = loc.site || small.length;
  root.appendChild(h("section", { class: "card where" },
    h("div", { class: "label" }, "Server"),
    h("div", { class: "chips" },
      r.server_names.length ? r.server_names.map((n) => copyChip(n)) : h("span", { class: "muted" }, "Not found in ticket")),
    bmcIPs(r).length ? h("div", { class: "bmc-row" }, bmcIPs(r).map((ip) =>
      h("button", { class: "bmc-btn", title: `Open the BMC web interface in a new tab`, onclick: () => opts.openBmc?.(ip) },
        "Open BMC ", h("span", { class: "mono" }, ip), " ↗"))) : null,
    h("div", { class: "label", style: "margin-top:10px" }, "Location"),
    anyLoc
      ? h("div", { class: "loc" },
          loc.site && h("div", { class: "loc-site" },
            h("div", { class: "loc-site-code" }, site.code),
            site.detail && h("div", { class: "loc-site-detail" }, site.detail)),
          small.length && h("div", { class: "loc-small" }, small.map(([k, v]) =>
            h("div", { class: "loc-cell" }, h("span", { class: "loc-k" }, k), h("span", { class: "loc-v" }, v)))))
      : h("span", { class: "muted" }, "Not found in ticket"),
    h("div", { id: "pingBox", class: "ping-box" })
  ));

  // 3b. NetBox card (filled in asynchronously)
  root.appendChild(h("section", { id: "netboxBox", class: "card nb hidden" }));

  // 4. Request + status
  root.appendChild(section("Request",
    h("p", { class: "lead" }, r.request_summary),
    r.current_status && h("p", { class: "status-line" }, h("b", {}, "Now: "), r.current_status)
  ));

  // 5. Cautions (only if any)
  if (r.cautions.length) {
    root.appendChild(h("section", { class: "card caution" },
      h("div", { class: "label" }, "⚠ Cautions"),
      h("ul", {}, r.cautions.map((c) => h("li", {}, c)))));
  }

  // 6. Next steps as a checklist
  if (r.next_steps.length) {
    const done = () => r.next_steps.filter((_, i) => checks.has(i)).length;
    const counter = h("span", { class: "count" }, `${done()}/${r.next_steps.length}`);
    root.appendChild(h("section", { class: "card" },
      h("div", { class: "label" }, "Next steps ", counter, h("span", { class: "pill" }, `${r.confidence} confidence`)),
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
      }))
    ));
  }

  // 7. Parts & tools
  if (r.parts_tools.length) {
    root.appendChild(section("Parts & tools",
      h("div", { class: "chips" }, r.parts_tools.map((t) => h("span", { class: "chip" }, t)))));
  }

  // 8. History of previous work
  root.appendChild(section(`History${r.history.length ? ` (${r.history.length})` : ""}`,
    r.history.length
      ? h("ol", { class: "timeline" }, r.history.map((e) => h("li", {},
          h("div", { class: "tl-meta" }, [e.when, e.who].filter(Boolean).join(" · ")),
          h("div", {}, e.what))))
      : h("span", { class: "muted" }, "No previous work on this ticket.")
  ));

  // 9. Details (collapsed)
  if (r.probable_cause || r.missing_info.length) {
    root.appendChild(h("details", { class: "card", open: r.missing_info.length ? "" : null },
      h("summary", { class: "label" }, r.missing_info.length ? `To confirm (${r.missing_info.length}) & cause` : "Probable cause"),
      r.missing_info.length ? h("ul", {}, r.missing_info.map((m) => h("li", {}, m))) : null,
      r.probable_cause && h("p", { class: "cause" }, h("b", {}, "Probable cause: "), r.probable_cause)
    ));
  }
}

// Reachability rows inside the Server card.
// state: { loading, targets, resp }  (resp = helper response or error object)
function renderPing(box, state, actions) {
  if (!box) return;
  box.innerHTML = "";
  const { loading, targets = [], resp } = state;
  const header = h("div", { class: "label ping-head" }, "Reachability",
    resp?.at && !loading && h("span", { class: "ping-age" }, ` · ${new Date(resp.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`),
    !loading && h("button", { class: "mini", onclick: actions.onPing }, resp ? "Ping again" : "Ping"));
  box.appendChild(header);

  if (loading) {
    box.appendChild(h("div", { class: "muted" }, h("span", { class: "spinner" }), `Pinging ${targets.length} address${targets.length === 1 ? "" : "es"}…`));
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
          x.role === "bmc" && actions.openBmc && h("button", { class: "mini open-bmc", onclick: () => actions.openBmc(x.address) }, "Open ↗")),
        h("div", { class: "ping-sub" },
          h("b", {}, statusText),
          via && ` · via ${via}`))
    ));
  }
  box.appendChild(rows);
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
  const head = h("div", { class: "label nb-head" }, "NetBox",
    !state.loading && h("button", { class: "mini", title: "Look up again", onclick: actions.onRefresh }, "↻"));
  box.appendChild(head);

  if (state.loading) {
    box.appendChild(h("div", { class: "muted" }, h("span", { class: "spinner" }), "Looking up in NetBox…"));
    return;
  }
  const nb = state.nb;
  if (!nb.ok) {
    box.appendChild(h("div", { class: `ping-msg${nb.empty ? "" : " bad"}` }, nb.error));
    const btns = h("div", { class: "nb-actions" });
    if (nb.auth) btns.appendChild(h("button", { class: "mini", onclick: actions.onOpenNetbox }, "Open NetBox to log in ↗"));
    btns.appendChild(h("button", { class: "mini", onclick: actions.onOpenPodcrawler }, "Open Podcrawler ↗"));
    box.appendChild(btns);
    return;
  }

  for (const d of nb.devices) {
    const statusCls = NB_STATUS_CLASS[d.status] || "info";
    const dev = h("div", { class: "nb-dev" });
    dev.appendChild(h("div", { class: "nb-title" },
      copyChip(d.name),
      d.statusLabel && h("span", { class: `nb-status ${statusCls}` }, d.statusLabel),
      h("button", { class: "mini nb-open", onclick: () => actions.openUrl(d.url) }, "Open in NetBox ↗")));
    if (d.model || d.role) dev.appendChild(h("div", { class: "nb-sub" }, [d.model, d.role].filter(Boolean).join(" · ")));

    if (d.mismatches.length) {
      dev.appendChild(h("div", { class: "nb-warn" },
        h("b", {}, "⚠ Ticket and NetBox disagree"),
        h("ul", {}, d.mismatches.map((m) => h("li", {}, m)))));
    }

    const rows = [
      ["Site", [d.site, d.location].filter(Boolean).join(" · ")],
      ["Rack / RU", [d.rack && `Rack ${d.rack}`, d.position != null && `RU ${d.position}`, d.face].filter(Boolean).join(" · ")],
      ["Serial", d.serial, true],
      ["Asset tag", d.assetTag, true],
      ["Tenant", [d.tenant, d.cluster].filter(Boolean).join(" · ")],
      ["Host IP", d.primaryIp, true],
      ["BMC IP", d.oobIp, true]
    ].filter(([, v]) => v);
    dev.appendChild(h("div", { class: "nb-grid" }, rows.map(([k, v, mono]) => [
      h("div", { class: "nb-k" }, k),
      h("div", { class: `nb-v${mono ? " mono" : ""}` }, v,
        k === "BMC IP" && h("button", { class: "mini open-bmc", onclick: () => actions.openBmc(d.oobIp) }, "Open BMC ↗"))
    ])));

    // Podcrawler
    dev.appendChild(h("div", { class: "nb-pc" },
      h("span", { class: "nb-k" }, "Podcrawler"),
      h("span", { class: "nb-pc-text" }, d.podcrawler
        ? `last activity ${timeAgo(d.podcrawler.at)}${d.podcrawler.text ? ` — ${d.podcrawler.text}` : ""}`
        : "no scan found in NetBox journal"),
      h("button", { class: "mini", title: "Opens Podcrawler and copies the hostname so you can paste it", onclick: () => actions.onOpenPodcrawler(d.name) }, "Open ↗")));

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
