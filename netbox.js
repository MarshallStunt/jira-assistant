// NetBox: find the ticket's server (location, IPs, cabling, Lambda SKU, journal, modules) and compare it with
// the ticket, and look up spare parts in storage (inventory plugins).
// Auth: your NetBox browser login (session cookie) by default, or a personal API token from Settings.

class NetboxAuthError extends Error {}

function nbBase(settings) {
  return (settings.netboxUrl || "https://netbox.prod.lambdalabs.cloud").trim().replace(/\/+$/, "");
}

async function nbGet(settings, path) {
  const token = (settings.netboxToken || "").trim();
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = token.startsWith("nbt_") ? `Bearer ${token}` : `Token ${token}`;
  let res;
  try {
    res = await fetch(`${nbBase(settings)}${path}`, { headers, credentials: token ? "omit" : "include" });
  } catch (e) {
    throw new Error(`Can't reach NetBox (${e.message}). Are you on the VPN?`);
  }
  const type = res.headers.get("content-type") || "";
  if (res.status === 401 || res.status === 403 || /\/login/.test(res.url) || type.includes("text/html")) {
    throw new NetboxAuthError(token
      ? "NetBox rejected the API token in Settings."
      : "Not logged in to NetBox. Open NetBox, log in, then click ↻.");
  }
  if (!res.ok) throw new Error(`NetBox ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// Serial numbers mentioned in the ticket ("S/N: ABC123", "serial number ABC123", "SN 1Z2X3C").
function findSerialsInText(text) {
  const out = new Set();
  const re = /(?:\bS\/?N\b|\bserial(?:\s*(?:number|no\.?|#))?)\s*[:#=]?\s*([A-Z0-9][A-Z0-9-]{5,30})/gi;
  for (const m of String(text || "").matchAll(re)) out.add(m[1].toUpperCase());
  return [...out].slice(0, 5);
}

const nbNorm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const nbDigits = (s) => (String(s || "").match(/\d+/g) || []).join("");

function looseEq(a, b) {
  const x = nbNorm(a), y = nbNorm(b);
  if (!x || !y) return true;
  if (x === y) return true;
  if (x.length >= 2 && y.length >= 2 && (x.endsWith(y) || y.endsWith(x))) return true;
  const dx = nbDigits(a), dy = nbDigits(b);
  return !!dx && dx === dy;
}

// Search NetBox for each hostname (exact match), then serials. Verifies names client-side because
// NetBox silently ignores unknown filters and would otherwise return unrelated devices.
async function netboxFindDevices(settings, names, serials) {
  const found = new Map();
  for (const name of names.slice(0, 3)) {
    const want = name.toLowerCase();
    const r = await nbGet(settings, `/api/dcim/devices/?name=${encodeURIComponent(name)}&limit=5`);
    let hit = (r.results || []).find((d) => (d.name || "").toLowerCase() === want);
    if (!hit) {
      const q = await nbGet(settings, `/api/dcim/devices/?q=${encodeURIComponent(name)}&limit=10`);
      hit = (q.results || []).find((d) => (d.name || "").toLowerCase() === want);
    }
    if (hit) found.set(hit.id, hit);
  }
  if (!found.size) {
    for (const sn of serials.slice(0, 3)) {
      const r = await nbGet(settings, `/api/dcim/devices/?serial=${encodeURIComponent(sn)}&limit=5`);
      const hit = (r.results || []).find((d) => nbNorm(d.serial) === nbNorm(sn));
      if (hit) found.set(hit.id, hit);
    }
  }
  return [...found.values()];
}

const stripPrefix = (ip) => String(ip || "").split("/")[0];

function summarizeInterface(i) {
  const peer = (i.link_peers || [])[0];
  const peerText = peer
    ? `${peer.device?.name || peer.device?.display || peer.circuit?.cid || "?"} ${peer.name || peer.display || ""}`.trim()
    : i.connected_endpoints?.[0]
      ? `${i.connected_endpoints[0].device?.name || "?"} ${i.connected_endpoints[0].name || ""}`.trim()
      : "";
  return {
    name: i.name,
    mgmt: !!i.mgmt_only,
    mac: i.primary_mac_address?.mac_address || i.mac_address || "",
    peer: peerText,
    enabled: i.enabled !== false
  };
}

// Journal entries sometimes hold credentials (e.g. "PWD - …" after a motherboard swap): drop those lines
// everywhere they're shown or sent to the AI.
function stripSecrets(text) {
  return String(text || "").split(/\r?\n/)
    .filter((l) => !/\b(pwd|pw|passw(or)?d|passwd|credentials?|secret|token)\b/i.test(l))
    .join("\n");
}

function podcrawlerActivity(journal) {
  const e = (journal || []).find((j) => /podcrawler|podc\b|\bpc scan/i.test(`${j.comments || ""} ${j.created_by?.username || ""} ${j.display || ""}`));
  return e ? { at: e.created, kind: e.kind?.label || e.kind?.value || "", text: stripSecrets(e.comments).replace(/\s+/g, " ").slice(0, 140) } : null;
}

// The server's work history from its NetBox journal (part swaps, chassis swaps…), credentials removed.
function journalHistory(journal) {
  return (journal || []).map((j) => ({ at: j.created, by: j.created_by?.username || "", text: stripSecrets(j.comments).replace(/\s+/g, " ").trim().slice(0, 220) }))
    .filter((j) => j.text).slice(0, 12);
}

function netboxMismatches(dev, brief, ticketSerials) {
  const out = [];
  const loc = brief.location || {};
  const siteCode = splitSite(loc.site).code;
  const nbSite = dev.site?.name || dev.site?.display || "";
  const siteOk = looseEq(siteCode, nbSite) || nbNorm(nbSite).includes(nbNorm(siteCode)) ||
    (dev.site?.slug && nbNorm(dev.site.slug).includes(nbNorm(siteCode)));
  if (siteCode && nbSite && !siteOk) {
    out.push(`Ticket says site ${siteCode} — NetBox says ${nbSite}`);
  }
  const nbRack = dev.rack?.name || dev.rack?.display || "";
  if (loc.rack && nbRack && !looseEq(loc.rack, nbRack)) out.push(`Ticket says rack ${loc.rack} — NetBox says ${nbRack}`);
  const tUnit = (String(loc.unit || "").match(/\d+/) || [])[0];
  if (tUnit && dev.position != null && Number(tUnit) !== Math.floor(Number(dev.position))) {
    out.push(`Ticket says RU ${loc.unit} — NetBox says RU ${Math.floor(dev.position)}`);
  }
  if (ticketSerials.length && dev.serial && !ticketSerials.some((s) => nbNorm(s) === nbNorm(dev.serial))) {
    out.push(`Ticket mentions serial ${ticketSerials.join(", ")} — NetBox has ${dev.serial}`);
  }
  return out;
}

// Full lookup for one ticket → { ok, devices: [...], searched: {...} } or { ok:false, error, auth }
async function netboxLookup(settings, brief, issueText) {
  const names = brief.server_names.filter((n) => !isIP(n) && !/^s\/?n\b/i.test(n) && /[a-z]/i.test(n) && n.length <= 64);
  const serials = [...new Set([...findSerialsInText(issueText), ...brief.server_names.filter((n) => /^s\/?n\b/i.test(n)).map((n) => n.replace(/^s\/?n\s*[:#]?\s*/i, "").toUpperCase())])];
  if (!names.length && !serials.length) return { ok: false, error: "No hostname or serial in the ticket to look up.", empty: true };
  try {
    const devices = await netboxFindDevices(settings, names, serials);
    if (!devices.length) {
      return { ok: false, notFound: true, error: `Not found in NetBox: ${[...names, ...serials].join(", ")}` };
    }
    const detailed = await Promise.all(devices.map(async (d) => {
      const [ifs, journal, mods] = await Promise.all([
        nbGet(settings, `/api/dcim/interfaces/?device_id=${d.id}&limit=250`).catch(() => ({ results: [] })),
        nbGet(settings, `/api/extras/journal-entries/?assigned_object_type=dcim.device&assigned_object_id=${d.id}&ordering=-created&limit=25`).catch(() => ({ results: [] })),
        // Installed modules (mostly transceivers on switches; server parts aren't recorded in NetBox)
        nbGet(settings, `/api/dcim/modules/?device_id=${d.id}&limit=250`).catch(() => ({ results: [] }))
      ]);
      const interfaces = (ifs.results || []).map(summarizeInterface).filter((i) => i.peer || i.mgmt || i.mac);
      interfaces.sort((a, b) => Number(b.mgmt) - Number(a.mgmt) || a.name.localeCompare(b.name, undefined, { numeric: true }));
      return {
        id: d.id,
        name: d.name,
        url: `${nbBase(settings)}/dcim/devices/${d.id}/`,
        status: d.status?.value || "",
        statusLabel: d.status?.label || d.status?.value || "",
        model: [d.device_type?.manufacturer?.name, d.device_type?.model || d.device_type?.display].filter(Boolean).join(" "),
        role: d.role?.name || d.device_role?.name || "",
        site: d.site?.name || "",
        siteSlug: d.site?.slug || "",
        location: d.location?.name || "",
        rack: d.rack?.name || "",
        position: d.position != null ? Math.floor(Number(d.position)) : null,
        face: d.face?.label || "",
        serial: d.serial || "",
        assetTag: d.asset_tag || "",
        tenant: d.tenant?.name || "",
        cluster: d.cluster?.name || "",
        primaryIp: stripPrefix(d.primary_ip?.address || d.primary_ip4?.address),
        oobIp: stripPrefix(d.oob_ip?.address),
        interfaces,
        podcrawler: podcrawlerActivity(journal.results),
        legacyLpn: d.custom_fields?.legacy_LPN || "", // the server's own Lambda SKU in the parts catalog (e.g. CSN0051)
        history: journalHistory(journal.results),
        modules: (mods.results || []).map((m) => ({
          bay: m.module_bay?.name || "", model: m.module_type?.model || "", partNumber: m.module_type?.part_number || "",
          vendor: m.module_type?.manufacturer?.name || "", status: m.status?.value || ""
        })),
        mismatches: netboxMismatches(d, brief, serials)
      };
    }));
    return { ok: true, devices: detailed, at: Date.now() };
  } catch (e) {
    return { ok: false, error: e.message, auth: e instanceof NetboxAuthError };
  }
}

// Extra ping targets from NetBox (host primary IP + BMC/OOB IP).
function netboxPingTargets(nb) {
  if (!nb?.ok) return [];
  return nb.devices.flatMap((d) => [d.primaryIp && { role: "host", address: d.primaryIp }, d.oobIp && { role: "bmc", address: d.oobIp }].filter(Boolean));
}

function timeAgo(iso) {
  const t = new Date(iso).getTime();
  if (!t) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400 * 2) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

function netboxCommentLines(nb) {
  if (!nb?.ok) return [];
  return nb.devices.flatMap((d) => [
    `*NetBox:* [${d.name}|${d.url}] — ${d.statusLabel || "?"} · ${[d.site, d.rack && `Rack ${d.rack}`, d.position != null && `RU ${d.position}`].filter(Boolean).join(" · ")}${d.serial ? ` · S/N ${d.serial}` : ""}${d.oobIp ? ` · BMC ${d.oobIp}` : ""}`,
    ...d.mismatches.map((m) => `* ⚠ ${m}`)
  ]);
}

// ---------- Spare parts in storage (NetBox inventory plugins) ----------
// Consumables = counted stock per storage location (type named by Lambda P/N, e.g. 207-000002).
// Stored assets = serialized spares (named "<Lambda P/N or SKU>_<serial>"), counted here per location.

const siteCodeOf = (location) => (String(location || "").match(/^[A-Z]{3}\d{2}/i) || [""])[0].toUpperCase();

// terms: identifiers of one part (Lambda P/N, legacy SKU, MPN). Returns { ok, rows: [{ location, site, onsite, receiving, kind, what }] }.
async function netboxStock(settings, terms, siteCode = "") {
  const ids = [...new Set(terms.map((t) => String(t || "").trim()).filter((t) => t.length >= 4))].slice(0, 3);
  if (!ids.length) return { ok: true, rows: [] };
  try {
    const rows = new Map();
    const add = (key, row) => {
      const r = rows.get(key);
      if (r) { r.onsite += row.onsite; r.receiving += row.receiving; } else rows.set(key, row);
    };
    for (const id of ids) {
      const q = encodeURIComponent(id);
      const [cons, assets] = await Promise.all([
        nbGet(settings, `/api/plugins/inventory-consumables/consumables/?q=${q}&limit=100`).catch(() => ({ results: [] })),
        nbGet(settings, `/api/plugins/inventory/assets/?status=stored&q=${q}&limit=500`).catch(() => ({ results: [] }))
      ]);
      for (const c of cons.results || []) {
        const loc = c.storage_location?.name || "?";
        add(`c:${c.id}`, { kind: "stock", location: loc, site: siteCodeOf(loc), onsite: Number(c.onsite_quantity) || 0,
          receiving: Number(c.receiving_quantity) || 0, what: c.consumable_type?.description || c.consumable_type?.name || "" });
      }
      for (const a of assets.results || []) {
        const loc = a.storage_location?.name || "?";
        add(`a:${loc}`, { kind: "serialized", location: loc, site: siteCodeOf(loc), onsite: 1, receiving: 0,
          what: (a.module_type || a.device_type || a.inventoryitem_type)?.model || a.name.split("_")[0] });
      }
    }
    // The ticket's site first, then the most stock.
    const out = [...rows.values()].filter((r) => r.onsite + r.receiving > 0)
      .sort((a, b) => (b.site === siteCode) - (a.site === siteCode) || b.onsite - a.onsite);
    return { ok: true, rows: out, at: Date.now() };
  } catch (e) {
    return { ok: false, error: e.message, auth: e instanceof NetboxAuthError };
  }
}

function stockSummary(stock, siteCode) {
  if (!stock?.ok) return stock?.error || "";
  if (!stock.rows.length) return "none in storage";
  const here = stock.rows.filter((r) => r.site === siteCode).reduce((n, r) => n + r.onsite, 0);
  const total = stock.rows.reduce((n, r) => n + r.onsite, 0);
  return `${siteCode ? `${here} at ${siteCode}, ` : ""}${total} in storage overall`;
}

// NetBox stock types (consumable types), cached for a day: used to find the same kind of part stocked under
// another number (e.g. catalog Samsung 64 GB DDR5 RDIMM → NetBox 207-000002 "Hynix 64 GB ECC DDR5 RDIMM").
async function netboxStockTypes(settings) {
  const cached = (await chrome.storage.local.get("nbTypes")).nbTypes;
  if (cached?.base === nbBase(settings) && Date.now() - cached.at < 24 * 60 * 60 * 1000) return cached.types;
  let types = [], path = "/api/plugins/inventory-consumables/consumable-types/?limit=1000";
  while (path) {
    const r = await nbGet(settings, path);
    types = types.concat((r.results || []).map((t) => ({ name: t.name, pn: t.part_number || "", desc: t.description || "", comments: String(t.comments || "").slice(0, 200) })));
    path = r.next ? new URL(r.next).pathname + new URL(r.next).search : null;
  }
  await chrome.storage.local.set({ nbTypes: { base: nbBase(settings), at: Date.now(), types } });
  return types;
}

// Stock for a catalog part: by its own numbers, else the same kind of part by MPN or description.
async function netboxStockForPart(settings, part, siteCode) {
  const own = await netboxStock(settings, [part.lambda, part.legacy, part.mpn], siteCode);
  if (!own.ok || own.rows.length) return own;
  try {
    const mpn = normPn(part.mpn);
    const phrase = String(part.name || "").split("·")[0].toLowerCase().replace(/\s+/g, " ").trim();
    const same = (await netboxStockTypes(settings)).filter((t) =>
      (mpn.length >= 6 && normPn(`${t.pn} ${t.comments} ${t.name}`).includes(mpn)) ||
      (phrase.length >= 8 && `${t.desc} ${t.name}`.toLowerCase().replace(/\s+/g, " ").includes(phrase))).slice(0, 3);
    if (!same.length) return own;
    const alt = await netboxStock(settings, same.map((t) => t.name), siteCode);
    return { ...alt, sameType: same.map((t) => `${t.name}${t.desc ? ` (${t.desc})` : ""}`) };
  } catch {
    return own;
  }
}
