// BMC card: health over Redfish and a guarded power off/on, with the BMC password the user pastes.
// Everything that talks to the BMC runs in the local helper (ping-helper/).

// BMC IPs from the ticket and NetBox, plus the serials used to spot the wrong BMC.
function bmcTargets(brief, nb, ticketSerials = []) {
  const ips = [...bmcIPs(brief)];
  const names = [...brief.server_names];
  const serials = [...ticketSerials];
  if (nb?.ok) {
    for (const d of nb.devices) {
      if (d.oobIp && !ips.includes(d.oobIp)) ips.push(d.oobIp);
      if (d.name) names.push(d.name);
      if (d.serial) serials.push(d.serial);
    }
  }
  return { ips: ips.slice(0, 4), names: [...new Set(names)].slice(0, 8), serials: [...new Set(serials)].slice(0, 8) };
}

async function bmcCall(message) {
  const resp = await sendNative(message);
  if (!resp.ok && /unknown action/i.test(resp.error || "")) {
    return { ok: false, outdated: true, error: "The ping helper is out of date. Re-run the install command from Settings." };
  }
  return resp;
}

// login = { user, password } pasted in the panel.
const readBmcHealth = (ip, login) => bmcCall({ action: "bmc_health", ip, login });

// resetType: "GracefulShutdown" | "ForceOff" | "On". confirm must equal the IP (typed by the user).
const bmcPower = (ip, login, resetType, confirm) => bmcCall({ action: "bmc_power", ip, login, reset_type: resetType, confirm });

// Password box for Check health: copy the IP (if you haven't got the password yet), find it in 1Password,
// copy the password and paste it here. Pasting starts the check. Kept in memory only, for re-checks.
function loginForm(ip, user, onSubmit) {
  const pass = h("input", { type: "password", placeholder: `Paste ${user} password`, autocomplete: "off", class: "bmc-in" });
  const submit = () => pass.value && onSubmit({ user, password: pass.value });
  const form = h("form", { class: "bmc-login" },
    h("ol", { class: "bmc-steps" },
      h("li", {}, "Need the password? ", copyChip(ip, "Copy IP"), " then open 1Password (", h("kbd", {}, KEYS.quickAccess), ") and paste it."),
      h("li", {}, "Copy the password and paste it here (", h("kbd", {}, KEYS.paste), "):")),
    h("div", { class: "bmc-login-row" }, pass, h("button", { class: "mini", type: "submit" }, "Check")),
    h("div", { class: "muted bmc-note" }, "Sent only to the BMC. Never saved or sent to the AI."));
  form.addEventListener("submit", (e) => { e.preventDefault(); submit(); });
  pass.addEventListener("paste", () => setTimeout(submit, 0)); // the value is set after the paste event
  setTimeout(() => pass.focus(), 0);
  return form;
}

const POWER_OFF_TYPES = [
  ["GracefulShutdown", "Shut down", "asks the OS to shut down cleanly (recommended)"],
  ["ForceOff", "Force off", "cuts power immediately, like holding the power button"]
];

// Power off / on. Deliberately slow to use: the panel has to be opened, the BMC IP typed (no paste),
// and the ticket's power-down verdict is shown right there.
function powerControls(ip, x, state, actions) {
  const p = state.power?.[ip] || {};
  const on = /^on$/i.test(x.system.power);
  const off = /^off$/i.test(x.system.power);
  if (!x.system.can_power || (!on && !off)) return null;
  const wrap = h("div", { class: "bmc-power" });

  if (p.busy) {
    wrap.appendChild(h("div", { class: "muted" }, h("span", { class: "spinner" }), "Sending to the BMC…"));
    return wrap;
  }
  if (p.result) {
    wrap.appendChild(p.result.ok
      ? h("div", { class: "bmc-done" }, icon("check", 12), ` ${p.result.label} sent at ${new Date(p.result.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}. Re-checking power shortly…`)
      : h("div", { class: "ping-msg bad" }, p.result.error));
  }
  if (!p.open) {
    wrap.appendChild(h("button", { class: `mini ${on ? "danger-outline" : ""}`, onclick: () => actions.onPowerOpen(ip, true) },
      on ? "⏻ Power off…" : "⏻ Power on…"));
    return wrap;
  }

  const verdict = state.verdict || {};
  const panel = h("div", { class: `power-panel ${on ? "off" : "on"}` });
  if (on) {
    panel.appendChild(verdict.verdict === "approved"
      ? h("div", { class: "pp-verdict ok" }, icon("check", 12), " Ticket: OK to power down", verdict.evidence && h("span", { class: "muted" }, ` · “${verdict.evidence}”`))
      : h("div", { class: "pp-verdict danger" }, h("b", {}, `⚠️ Ticket: ${POWER[verdict.verdict]?.label || "No power-down approval found"}.`),
          " Make sure you have approval before powering this server off."));
    const radios = POWER_OFF_TYPES.map(([value, label, hint], i) =>
      h("label", { class: "pp-radio" }, h("input", { type: "radio", name: `pp-${ip}`, value, checked: i === 0 ? "" : null }),
        h("span", {}, h("b", {}, label), ` — ${hint}`)));
    panel.appendChild(h("div", { class: "pp-radios" }, radios));
  }
  const typed = h("input", { type: "text", class: "bmc-in mono", placeholder: ip, autocomplete: "off", spellcheck: "false" });
  typed.addEventListener("paste", (e) => e.preventDefault()); // must be typed, not pasted
  const go = h("button", { class: on ? "danger" : "primary", disabled: "" }, on ? "⏻ Power off" : "⏻ Power on");
  typed.addEventListener("input", () => { go.disabled = typed.value.trim() !== ip; });
  go.addEventListener("click", () => {
    if (typed.value.trim() !== ip) return;
    const type = on ? panel.querySelector(`input[name="pp-${ip}"]:checked`)?.value || "GracefulShutdown" : "On";
    actions.onPower(ip, type, typed.value.trim());
  });
  panel.append(
    h("label", { class: "pp-type" }, `Type the BMC IP ${ip} to confirm`, typed),
    h("div", { class: "pp-actions" }, h("button", { class: "mini", onclick: () => actions.onPowerOpen(ip, false) }, "Cancel"), go));
  wrap.appendChild(panel);
  setTimeout(() => typed.focus(), 0);
  return wrap;
}

const HEALTH_CLASS = { OK: "ok", Warning: "warn", Critical: "danger" };

function fmtWhen(iso) {
  const t = new Date(iso);
  return isNaN(t) ? String(iso || "") : t.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function renderBmcHealth(x, who, ip, state, actions) {
  const box = h("div", { class: "bmc-health" });
  const s = x.system || {};
  const health = s.rollup || s.health;
  box.appendChild(h("div", { class: "bmc-badges" },
    s.power && h("span", { class: `nb-status ${/^on$/i.test(s.power) ? "info" : "warn"}` }, `Power ${s.power}`),
    health && h("span", { class: `nb-status ${HEALTH_CLASS[health] || "info"}` }, `Health ${health}`)));

  const serialOff = s.serial && who.serials.length && !who.serials.some((sn) => sn.toUpperCase() === s.serial.toUpperCase());
  if (serialOff) {
    box.appendChild(h("div", { class: "nb-warn" }, h("b", {}, "⚠️ Serial mismatch: "),
      `the BMC reports ${s.serial}, the ticket/NetBox have ${who.serials.join(", ")}. Is this the right BMC?`));
  }

  const rows = [
    ["Model", [s.manufacturer, s.model].filter(Boolean).join(" ")],
    ["Serial", s.serial, true],
    ["BIOS", s.bios, true],
    ["BMC FW", [x.manager?.firmware, x.manager?.model].filter(Boolean).join(" · "), true]
  ].filter(([, v]) => v);
  if (rows.length) {
    box.appendChild(h("div", { class: "nb-grid" }, rows.map(([k, v, mono]) =>
      [h("div", { class: "nb-k" }, k), h("div", { class: `nb-v${mono ? " mono" : ""}` }, v)])));
  }

  box.appendChild(h("div", { class: "label bmc-sub" }, `Failed components${x.problems.length ? ` (${x.problems.length})` : ""}`));
  box.appendChild(x.problems.length
    ? h("ul", { class: "bmc-list" }, x.problems.map((p) => h("li", { class: HEALTH_CLASS[p.health] },
        h("b", {}, `${p.component}: ${p.name}`), ` — ${p.health}`, p.detail && h("span", { class: "muted" }, ` · ${p.detail}`))))
    : h("div", { class: "muted" }, "None reported by the BMC."));

  if (x.events.length) {
    box.appendChild(h("details", { class: "bmc-events", open: x.events.some((e) => e.severity === "Critical") ? "" : null },
      h("summary", {}, `Recent warnings in the event log (${x.events.length})`),
      h("ul", { class: "bmc-list" }, x.events.map((e) => h("li", { class: HEALTH_CLASS[e.severity] },
        h("span", { class: "muted" }, `${fmtWhen(e.when)} · `), e.message)))));
  } else {
    box.appendChild(h("div", { class: "muted bmc-sub" }, "No warnings in the BMC event log."));
  }
  if (x.warnings?.length) box.appendChild(h("div", { class: "muted bmc-sub" }, `Partly read: ${x.warnings.join("; ")}`));
  box.appendChild(h("div", { class: "nb-foot muted" }, `Checked ${timeAgo(new Date(x.at).toISOString())} · took ${x.took_s}s`));
  const power = actions?.onPower && powerControls(ip, x, state, actions);
  if (power) box.appendChild(power);
  return box;
}

// state: { who: {ips, names, serials}, health: {ip: resp | "loading"},
//          showLogin: {ip: true}, creds: {ip: {user, password}}, user: "ADMIN",
//          reach: {ip: ping result}, power: {ip: {open, busy, result}}, verdict: brief.power_down }
function renderBmc(box, state, actions) {
  if (!box) return;
  box.innerHTML = "";
  const { who } = state;
  if (!who.ips.length) return box.classList.add("hidden");
  box.classList.remove("hidden");
  box.appendChild(h("div", { class: "label" }, "🔧 BMC"));

  for (const ip of who.ips) {
    try {
      box.appendChild(renderBmcOne(ip, state, actions));
    } catch (e) {
      // Never leave the card blank: unexpected BMC data shows as a message.
      box.appendChild(h("div", { class: "bmc-one" }, h("span", { class: "mono bmc-ip" }, ip),
        h("div", { class: "ping-msg bad" }, `Couldn't show this BMC's data (${e.message}).`)));
    }
  }
}

function renderBmcOne(ip, state, actions) {
  const { who, health = {}, showLogin = {}, user = "ADMIN", reach = {} } = state;
  const x = health[ip];
  const r = reach[ip];
  const down = r && r.ok && !r.reachable; // pinged, no reply
  const one = h("div", { class: "bmc-one" });
  one.appendChild(h("div", { class: "bmc-head" },
    h("span", { class: "bmc-ip" }, copyChip(ip),
      r && h("span", { class: `dot ${!r.ok ? "err" : r.reachable ? "up" : "down"}`, title: r.ok ? (r.reachable ? "Answers ping" : "No ping reply") : r.error },
        h("span", { class: "sr-only" }, r.ok ? (r.reachable ? "answers ping" : "no ping reply") : "ping failed"))),
    h("button", { class: "mini", title: "Open the BMC web interface in a new tab", onclick: () => actions.openBmc(ip) }, "Open ", icon("external", 11)),
    h("button", { class: `mini${down ? " subtle" : ""}`, disabled: x === "loading" ? "" : null, title: "Read power state, failed parts and event log from the BMC (Redfish, read-only)", onclick: () => actions.onHealth(ip) },
      down ? "Try anyway" : x && x !== "loading" ? [icon("refresh", 11), " Health"] : "Check health")));

  // No ping reply → logging in or reading health will just time out. Say so up front.
  if (down && !x?.ok) {
    one.appendChild(h("div", { class: "bmc-unreach" },
      h("b", {}, "🚫 BMC isn't answering from this computer"), r.interface_name || r.interface ? ` (traffic goes via ${interfaceLabel(r)})` : "",
      ". Login, health and power won't work until it does. Check that your VPN is connected or that you're on the datacenter network, then click ",
      h("i", {}, "Ping again"), " above."));
  }

  if (x === "loading") {
    one.appendChild(h("div", { class: "muted" }, h("span", { class: "spinner" }), "Reading health from the BMC…"));
  } else if (x?.ok) {
    one.appendChild(renderBmcHealth(x, who, ip, state, actions));
  } else if (x) {
    one.appendChild(h("div", { class: "ping-msg bad" }, x.error));
  }
  if ((x?.outdated || x?.notInstalled) && actions.onSetup) {
    one.appendChild(h("button", { class: "mini", onclick: actions.onSetup }, "Open helper setup"));
  }
  if (showLogin[ip] && x !== "loading" && !down) {
    one.appendChild(loginForm(ip, user, (login) => actions.onHealth(ip, login)));
  }
  return one;
}

// Jira comment lines: BMCs whose health was read, and power actions sent from the panel.
function bmcCommentLines(health, powerLog = []) {
  return [...Object.values(health || {}).filter((x) => x?.ok).flatMap((x) => [
    `*BMC ${x.ip}:* power ${x.system.power || "?"}, health ${x.system.rollup || x.system.health || "?"}${x.system.serial ? ` · S/N ${x.system.serial}` : ""} (read ${new Date(x.at).toLocaleString()})`,
    ...x.problems.map((p) => `* ${p.component} ${p.name} — ${p.health}${p.detail ? ` (${p.detail})` : ""}`),
    ...x.events.slice(0, 5).map((e) => `* Log ${fmtWhen(e.when)}: ${e.message}`)
  ]), ...powerLog.map((a) => `*Power:* ${a.label} sent to BMC ${a.ip} at ${new Date(a.at).toLocaleString()} (was ${a.before || "?"})`)];
}
