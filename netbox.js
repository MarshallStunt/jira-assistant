// NetBox lookup: find the ticket's server in NetBox and compare it with the ticket.
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

function podcrawlerActivity(journal) {
  const e = (journal || []).find((j) => /podcrawler|podc\b|\bpc scan/i.test(`${j.comments || ""} ${j.created_by?.username || ""} ${j.display || ""}`));
  return e ? { at: e.created, kind: e.kind?.label || e.kind?.value || "", text: String(e.comments || "").replace(/\s+/g, " ").slice(0, 140) } : null;
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
      const [ifs, journal] = await Promise.all([
        nbGet(settings, `/api/dcim/interfaces/?device_id=${d.id}&limit=250`).catch(() => ({ results: [] })),
        nbGet(settings, `/api/extras/journal-entries/?assigned_object_type=dcim.device&assigned_object_id=${d.id}&ordering=-created&limit=25`).catch(() => ({ results: [] }))
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
