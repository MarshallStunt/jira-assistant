// Lambda parts catalog (Google Sheet: Lambda P/N ↔ legacy SKU ↔ manufacturer P/N ↔ description).
// Read as CSV through the sheet's share link and cached on this computer for a day. Matching and search run
// locally; only the rows that fit a chat question are sent to the AI (see catalogRowsFor).
// Also renders the catalog part of the Parts card.

const CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CATALOG_FORMAT = 3; // bump when the cached shape changes, so old copies are re-read

function sheetIds(sheetUrl) {
  const id = String(sheetUrl || "").match(/\/spreadsheets\/d\/([\w-]+)/)?.[1];
  if (!id) throw new Error("The parts catalog address isn't a Google Sheets link.");
  return { id, gid: String(sheetUrl).match(/[#&?]gid=(\d+)/)?.[1] || "" }; // no gid: the first tab
}

// Sheet link (…/spreadsheets/d/<id>/edit#gid=<gid>) → CSV link. The query endpoint also works for an
// Excel file opened in Google Sheets (the /export link doesn't); headers=1 keeps row 1 as the only header.
function catalogCsvUrl(sheetUrl) {
  const { id, gid } = sheetIds(sheetUrl);
  return `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&headers=1${gid ? `&gid=${gid}` : ""}`;
}

// Link that opens the catalog sheet, on a given row when there is one.
function catalogSheetUrl(sheetUrl, row) {
  const { id, gid } = sheetIds(sheetUrl);
  const hash = [gid && `gid=${gid}`, row && `range=A${row}`].filter(Boolean).join("&");
  return `https://docs.google.com/spreadsheets/d/${id}/edit${hash ? `#${hash}` : ""}`;
}

// Small CSV parser (quoted fields, "" escapes, newlines inside quotes).
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Lambda P/N, else the legacy SKU, else the manufacturer P/N.
const partId = (p) => p.lambda || p.legacy || p.mpn;
const normPn = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();

// Columns are found by their header names, so reordering the sheet doesn't break anything.
function catalogFromCsv(text) {
  const [header, ...rows] = parseCsv(text);
  if (!header?.length) throw new Error("The parts catalog is empty.");
  const col = (re) => header.findIndex((h) => re.test(h.trim()));
  const lambdaCol = col(/^(x|lambda\b.*)$/i);
  if (lambdaCol >= 0 && col(/legacy/i) < 0 && col(/^mpn$|manufacturer/i) < 0) {
    return catalogFromList(rows, { lambda: lambdaCol, desc: col(/desc/i), other: col(/vendor|mpn|sku/i) });
  }
  const c = {
    lambda: col(/^(x|lambda\s*(p\/?n|part|sku)?)$/i), legacy: col(/legacy/i), mpn: col(/^mpn$|manufacturer/i),
    vendorPn: col(/vendor_?pn/i), name: col(/display\s*name|^name$/i), desc: col(/desc/i), used: col(/where\s*used/i)
  };
  if (c.mpn < 0 && c.lambda < 0 && c.legacy < 0) throw new Error("The parts catalog has no Lambda P/N, SKU or MPN column.");
  const get = (r, i) => (i >= 0 ? clean(r[i]) : "");
  const parts = rows.map((r, i) => {
    const name = get(r, c.name);
    return {
      row: i + 2, // sheet row number (row 1 is the header), for "Open in catalog"
      lambda: get(r, c.lambda), legacy: get(r, c.legacy), mpn: get(r, c.mpn), vendorPn: get(r, c.vendorPn),
      vendor: name.includes("|") ? clean(name.split("|")[0]) : "",
      name: name.includes("|") ? clean(name.split("|").slice(1).join(" · ")) : name,
      desc: get(r, c.desc), used: get(r, c.used)
    };
  }).filter((p) => p.lambda || p.legacy || p.mpn);
  // Parts are tracked by Lambda P/N. A row without one may share its MPN with a row that has one: point to it.
  const lambdaByMpn = new Map(parts.filter((p) => p.lambda && normPn(p.mpn).length >= 6).map((p) => [normPn(p.mpn), p]));
  for (const p of parts) {
    const other = !p.lambda && lambdaByMpn.get(normPn(p.mpn));
    if (other) Object.assign(p, { sameMpnLambda: other.lambda, sameMpnRow: other.row });
  }
  return parts;
}

// Lambda P/N list: "Lambda part number", "Part description" ("Vendor | MPN | details") and a third column that holds
// the manufacturer P/N or, for older parts, the legacy SKU (GPU0059, CSN0051). One part per P/N: "(CAPEX)" copies,
// test items and licences/services (4xx-) are skipped; "EOL, USE 455-000526 INSTEAD : …" marks a part inactive.
const PN_RE = /^(\d{3}-\d{6})\b/;
const SKU_RE = /^[A-Z]{2,5}\d{3,5}(_\w+)?$/; // GPU0059, CSN0051_2022 (not MCX75310AASNEAT)
// A manufacturer part number: one word with letters and digits, not a size or speed ("4800MHz", "3m").
const looksLikeMpn = (s) => /^[A-Z0-9][A-Z0-9._\/+#-]{3,}$/i.test(s) && /\d/.test(s) && /[A-Z]/i.test(s) &&
  !/^\d+(\.\d+)?\s*(mhz|ghz|gb|tb|w|kw|m|ft|mm|g|gbps|a|v|u|in)$/i.test(s);

function catalogFromList(rows, c) {
  const get = (r, i) => (i >= 0 ? clean(r[i]) : "");
  const byPn = new Map();
  rows.forEach((r, i) => {
    const id = get(r, c.lambda), lambda = id.match(PN_RE)?.[1];
    let desc = get(r, c.desc);
    if (!lambda || /^4\d\d-/.test(lambda) || /^te+st\b/i.test(desc)) return;
    if (byPn.has(lambda) && /\(capex\)/i.test(id)) return; // keep the plain row over its CAPEX copy
    const eol = desc.match(/^(EOL\b[,\s]*)?(USE\s+(\d{3}-\d{6})\s+INSTEAD\b)?\s*:?\s*/i);
    const inactive = !!eol[0].trim();
    desc = desc.slice(eol[0].length);
    const segs = desc.split("|").map(clean).filter(Boolean);
    const vendor = segs.length > 1 ? segs[0] : "";
    const other = get(r, c.other), legacy = SKU_RE.test(other) ? other : "";
    const descMpn = segs.slice(vendor ? 1 : 0).find(looksLikeMpn) || "";
    const mpn = (!legacy && other) || descMpn;
    byPn.set(lambda, {
      row: i + 2, lambda, legacy, mpn, vendorPn: normPn(descMpn) !== normPn(mpn) ? descMpn : "", vendor,
      name: (vendor ? segs.slice(1) : segs).join(" · "), desc: "", used: "", inactive, replacedBy: eol[3] || ""
    });
  });
  return [...byPn.values()].sort((x, y) => x.row - y.row);
}

// { at, url, parts } from local storage, refreshed once a day (or when forced / the address changed).
async function loadCatalog(sheetUrl, force = false) {
  const cached = (await chrome.storage.local.get("catalog")).catalog;
  const fresh = cached?.url === sheetUrl && cached.format === CATALOG_FORMAT && Date.now() - cached.at < CATALOG_MAX_AGE_MS;
  if (!force && fresh) return cached;
  let text;
  try {
    const res = await fetch(catalogCsvUrl(sheetUrl), { credentials: "include" });
    text = await res.text();
    if (!res.ok || /^\s*<!doctype html|<html/i.test(text)) throw new Error(res.ok ? "the sheet isn't shared with you" : `HTTP ${res.status}`);
  } catch (e) {
    if (cached?.parts) return { ...cached, stale: true, error: e.message }; // keep using yesterday's copy
    throw new Error(`Couldn't read the parts catalog (${e.message}).`);
  }
  const catalog = { at: Date.now(), url: sheetUrl, format: CATALOG_FORMAT, parts: catalogFromCsv(text) };
  await chrome.storage.local.set({ catalog });
  return catalog;
}

// A whole server / chassis, not a field-replaceable part (the ticket often quotes these).
// Lambda P/N families decide: 201-/203- are whole systems, every other 2xx- family is a part (a "switch board for
// 4U 8 SXM5 GPU system" is a part). Legacy SKUs CSN (servers/appliances), DGX and TNB (laptops) are whole systems.
// Words ("server", "system") only decide for rows without a Lambda P/N family.
function isWholeSystem(p) {
  if (/^20[13]-/.test(p.lambda) || /^(CSN|DGX|TNB)/.test(p.legacy) || /^(SYS|AS|ARS)\s*-/i.test(p.mpn)) return true;
  if (/^2\d\d-/.test(p.lambda)) return false;
  const text = `${p.name} ${p.desc}`;
  return /\b(server|chassis|system)\b/i.test(text) && !/\b(fan|psu|power supply|rail|bracket|kit|cable|backplane|midplane|riser|tray|module|card|board)\b/i.test(text);
}

// Catalog parts whose Lambda P/N, legacy SKU, MPN or vendor P/N appear in the given texts.
// A manufacturer number that is a prefix of the catalog's (e.g. M321R8GA0BB0 vs M321R8GA0BB0-CQK) also matches.
function findCatalogParts(catalog, texts) {
  const tokens = new Set();
  for (const t of texts) {
    for (const m of String(t || "").toUpperCase().matchAll(/[A-Z0-9][A-Z0-9._\/-]{4,40}/g)) {
      const n = normPn(m[0]);
      if (n.length >= 6 && /\d/.test(n)) tokens.add(n); // part numbers always contain a digit
    }
  }
  const found = new Map();
  for (const p of catalog.parts) {
    const keys = [p.lambda, p.legacy, p.mpn, p.vendorPn].map(normPn).filter((k) => k.length >= 6);
    const hit = keys.find((k) => tokens.has(k)) ||
      [...tokens].find((t) => t.length >= 8 && keys.some((k) => k.startsWith(t) && k.length - t.length <= 6));
    if (hit) found.set(partId(p), { ...p, matchedOn: hit, system: isWholeSystem(p) });
  }
  // Replaceable parts first, whole systems last; parts with a Lambda P/N before those without; inactive items last.
  return [...found.values()].sort((a, b) => a.system - b.system || !a.lambda - !b.lambda || !!a.inactive - !!b.inactive).slice(0, 12);
}

// Free-text search for the search box: every word must appear somewhere in the part.
function searchCatalog(catalog, query, limit = 8) {
  const words = clean(query).toLowerCase().split(" ").filter(Boolean);
  if (!words.length) return [];
  return catalog.parts.filter((p) => {
    const hay = `${p.lambda} ${p.legacy} ${p.mpn} ${p.vendorPn} ${p.vendor} ${p.name} ${p.desc}`.toLowerCase();
    return words.every((w) => hay.includes(w) || normPn(hay).includes(normPn(w)) && normPn(w).length >= 4);
  }).map((p) => ({ ...p, system: isWholeSystem(p) }))
    // Parts before whole servers, parts with a Lambda P/N first, inactive items last.
    .sort((a, b) => a.system - b.system || !a.lambda - !b.lambda || !!a.inactive - !!b.inactive).slice(0, limit);
}

// ---------- Parts card (catalog part of it) ----------

// One catalog part. The Lambda P/N leads (that's what parts are tracked by); legacy SKU and manufacturer P/N
// follow. "Open in catalog" jumps to the part's row in the sheet, and "Used" adds it to the Jira comment.
function partRow(p, state, actions) {
  const id = partId(p);
  const used = h("input", { type: "checkbox", title: "Add to the Jira comment as a part used" });
  used.checked = state.used.has(id);
  used.addEventListener("change", () => actions.onUsed(p, used.checked));
  const other = (label) => (v) => v && h("span", { class: "part-other", title: label }, h("span", { class: "part-k" }, label), copyChip(v));
  const stockBox = h("div", { class: "part-stock" });
  return h("div", { class: `part${p.system ? " system" : ""}${p.failed ? " failed" : ""}` },
    h("div", { class: "part-ids" },
      p.lambda
        ? h("span", { class: "part-lambda" }, h("span", { class: "part-k" }, "Lambda P/N"), copyChip(p.lambda))
        : h("span", { class: "part-nolambda", title: "Parts are tracked by Lambda P/N: confirm it in the catalog" }, "No Lambda P/N"),
      p.inactive && h("span", { class: "part-inactive", title: "Marked end of life in the catalog: check there's a newer part" }, "EOL"),
      !p.system && h("label", { class: "part-used" }, used, "Used")),
    h("div", { class: "part-name", title: p.desc }, [p.vendor, p.name || p.desc].filter(Boolean).join(" · ")),
    p.desc && p.desc !== p.name && h("div", { class: "part-desc muted" }, p.desc),
    h("div", { class: "part-meta" },
      other("SKU")(p.legacy), p.mpn !== p.lambda && other("MPN")(p.mpn),
      actions.onStock && h("button", { class: "link", title: "Look for this part in NetBox storage", onclick: () => actions.onStock(p, stockBox) }, "📦 Check stock"),
      h("button", { class: "link part-open", onclick: () => actions.openRow(p.row) }, "Open in catalog ", icon("external", 10))),
    stockBox,
    p.sameMpnLambda && h("div", { class: "part-flag" }, "ℹ️ Same MPN is listed with Lambda P/N ",
      h("b", {}, p.sameMpnLambda), " ", h("button", { class: "link", onclick: () => actions.openRow(p.sameMpnRow) }, "(check row)")),
    p.replacedBy && h("div", { class: "part-flag" }, "ℹ️ End of life: use ", copyChip(p.replacedBy), " instead"),
    p.failed && h("div", { class: "part-flag bad" }, "⚠️ The BMC reports this part as failed"),
    p.system && h("div", { class: "part-flag" }, "🖥️ Whole server/chassis, not the part to replace. Search for the actual part below."));
}

// ---------- The server's own parts, matched to the catalog ----------
// A scanned MPN ("Micron_7450_MTFDKBG3T8TFR", "AOC-STGS-i2T") → catalog parts with that MPN (exact, or the catalog's
// longer ordering code "MTFDKBG3T8TFR-1BC15ABYYR", "AOC-STGS-I2T-O"). Best first: exact, has a Lambda P/N, not EOL.
function catalogByMpn(catalog, mpn) {
  const n = normPn(String(mpn || "").replace(/^(samsung|micron|intel|kioxia|solidigm|wdc|seagate)[\s_]+(\d{4}[\s_]+)?/i, ""));
  if (!catalog || n.length < 6) return [];
  const hits = [];
  for (const p of catalog.parts) {
    const keys = [p.mpn, p.vendorPn, p.legacy, p.lambda].map(normPn).filter((k) => k.length >= 6);
    const exact = keys.includes(n);
    const near = !exact && keys.some((k) => (k.startsWith(n) && k.length - n.length <= 12) || (k.includes(n) && n.length >= 10));
    if (exact || near) hits.push({ p, rank: (exact ? 0 : 2) + (p.lambda ? 0 : 1) + (p.inactive ? 3 : 0) });
  }
  return hits.sort((a, b) => a.rank - b.rank).map((x) => x.p);
}

// GPU model → catalog GPU (206-…). Newer GPUs are listed as FRUs (204-…: "B200 Single GPU FRU Unit", "Wickie B300 FRU -
// GPU only") made for one chassis maker, so the server's maker counts; failing that, the HGX baseboard, flagged.
const MAKER_ALIASES = { smc: "supermicro", "super micro": "supermicro" };
function catalogGpu(catalog, model, maker = "") {
  const want = descTokens(model);
  const fam = [...want].find((t) => /^(gb|[abhl])\d{2,3}s?$/.test(t));
  if (!catalog || !fam) return { part: null, baseboard: null };
  const has = (p, t) => descTokens(`${p.vendor} ${p.name} ${p.desc}`).has(t);
  const gpus = catalog.parts.filter((p) => /^206-/.test(p.lambda) && has(p, fam) && !specConflict(want, descTokens(`${p.name} ${p.desc}`)));
  if (gpus.length) return { part: gpus.find((p) => !p.inactive) || gpus[0], baseboard: null };
  const m = String(maker).toLowerCase().split(/\s+/)[0], mk = MAKER_ALIASES[m] || m;
  const sameMaker = (p) => !!mk && String(p.vendor).toLowerCase().replace(/\s+/g, "").includes(mk);
  const boards = catalog.parts.filter((p) => /^204-/.test(p.lambda) && has(p, fam) && !p.inactive)
    .map((p) => ({ p, single: /single gpu|gpu only/i.test(`${p.name} ${p.desc}`), score: (sameMaker(p) ? 4 : 0) + (/single gpu|gpu only/i.test(`${p.name} ${p.desc}`) ? 2 : 0) }))
    .filter((x) => !mk || sameMaker(x.p)) // FRUs and baseboards are made for one maker's chassis (no Wistron sled in a Dell)
    .sort((a, b) => b.score - a.score);
  const best = boards[0];
  return best?.single ? { part: best.p, baseboard: null } : { part: null, baseboard: best?.p || null };
}

// [{ kind: "GPU" | "NIC" | "Disk", model, count, missing, serials, part, alts, note }] for one NetBox device.
function serverParts(catalog, dev) {
  const inv = dev?.inventory;
  if (!catalog || !inv) return [];
  const out = [];
  for (const g of inv.gpus) {
    const { part, baseboard } = catalogGpu(catalog, g.model, dev.model);
    out.push({ kind: "GPU", ...g, part: part || baseboard, alts: [],
      note: !part && baseboard ? `No single ${g.model} GPU in the catalog, only the GPU baseboard` : part ? "" : `No ${g.model} GPU for this server in the catalog` });
  }
  for (const [kind, list] of [["NIC", inv.nics], ["Disk", inv.disks]]) {
    for (const x of list) {
      const hits = catalogByMpn(catalog, x.model);
      if (hits.length) { out.push({ kind, ...x, part: hits[0], alts: hits.slice(1, 3), note: "" }); continue; }
      // Newer scans name some cards, not their MPN ("ConnectX-8 800GE 2P NIC"): the catalog's closest descriptions, to check.
      const like = catalogByDescription(catalog, x.model, 4).filter((m) => m.coverage >= 0.75 && !isWholeSystem(m.part)).map((m) => m.part);
      out.push({ kind, ...x, part: like.length === 1 ? like[0] : null, alts: like.length === 1 ? [] : like.slice(0, 3), guess: like.length > 0,
        note: like.length ? `No MPN in the scan: matched by description${like.length > 1 ? `, ${like.length} catalog parts fit` : ""}. Check the label.` : "Not in the catalog" });
    }
  }
  return out;
}

// The server's own catalog entry: NetBox device type part number (SYS-821GE-TNHR-200-LL014) or Lambda SKU (legacy_LPN).
function serverCatalogEntries(catalog, devices) {
  if (!catalog) return [];
  const want = new Set(devices.flatMap((d) => [d.typePartNumber, d.legacyLpn]).map(normPn).filter((k) => k.length >= 6));
  return catalog.parts.filter((p) => !/\(capex\)/i.test(p.lambda) && [p.mpn, p.legacy].map(normPn).some((k) => want.has(k)))
    .filter((p, i, all) => all.findIndex((q) => q.lambda === p.lambda) === i).slice(0, 2);
}

// state: { loading, error, catalog, matches, used: Map(id → part) }
function renderCatalog(box, state, actions) {
  if (!box) return;
  box.innerHTML = "";
  if (state.loading) return box.appendChild(h("div", { class: "muted" }, "Checking the Lambda parts catalog…"));
  if (state.error) return box.appendChild(h("div", { class: "ping-msg bad" }, state.error));

  box.appendChild(h("div", { class: "label part-head" }, "Lambda catalog",
    h("button", { class: "mini", title: "Ask the AI which catalog part to swap, based on the ticket and the BMC", onclick: actions.onAsk }, "✨ Ask AI which part"),
    h("button", { class: "mini part-open-cat", title: "Open the Lambda parts catalog to look up other part numbers", onclick: () => actions.openRow(null) }, "📒 Open catalog ", icon("external", 10))));
  // The server itself, from NetBox's Lambda SKU (legacy_LPN): tells which GPU generation etc. it has.
  for (const s of state.servers || []) {
    box.appendChild(h("div", { class: "part-server" },
      h("span", { class: "part-k" }, "🖥️ This server"),
      s.lambda && copyChip(s.lambda), s.legacy && h("span", { class: "part-other" }, h("span", { class: "part-k" }, "SKU"), copyChip(s.legacy)),
      h("span", { class: "part-server-name" }, [s.vendor, s.name, s.desc && s.desc !== s.name && s.desc].filter(Boolean).join(" · ")),
      h("button", { class: "link part-open", onclick: () => actions.openRow(s.row) }, "Open in catalog ", icon("external", 10))));
  }
  // The server's own parts (NetBox: FastTrack's last scan), each with its catalog P/N: the source of truth for what's inside.
  if (state.bom?.length) {
    box.appendChild(h("div", { class: "part-sub" }, "🔩 In this server ", h("span", { class: "muted" }, `NetBox · FastTrack scan${state.bomAt ? ` ${timeAgo(state.bomAt)}` : ""}`)));
    box.appendChild(h("div", { class: "bom" }, state.bom.map((b) => {
      const stockBox = h("div", { class: "part-stock" });
      return h("div", { class: `bom-row${b.missing ? " missing" : ""}` },
        h("div", { class: "bom-line" },
          h("span", { class: "bom-kind" }, b.kind), h("span", { class: "bom-model" }, `${b.count}× ${b.model}`),
          b.missing ? h("span", { class: "rma-tag bad" }, `${b.missing} missing in last scan`) : null),
        b.part ? h("div", { class: "bom-part" }, copyChip(partId(b.part)), h("span", { class: "muted" }, ` ${[b.part.vendor, b.part.name].filter(Boolean).join(" ")}`.slice(0, 80)),
          actions.onStock && h("button", { class: "link", onclick: () => actions.onStock(b.part, stockBox) }, "📦 Stock"),
          h("button", { class: "link part-open", onclick: () => actions.openRow(b.part.row) }, "Catalog ", icon("external", 10))) : null,
        b.alts?.length ? h("div", { class: "muted bom-alt" }, `${b.part ? "Also listed" : "Could be"}: `, b.alts.map((p) => partId(p)).join(", ")) : null,
        b.note && h("div", { class: `bom-note${b.part ? "" : " warn"}` }, b.note),
        stockBox);
    })));
  }
  // Numbers found in the ticket are shown for reference: the ticket's part number is usually the chassis.
  box.appendChild(h("div", { class: "part-hint" }, "The part number on a ticket is usually the server/chassis, not the part to swap. Use ",
    h("b", {}, "✨ Ask AI which part"), " or search below to find it."));
  if (state.matches.length) {
    box.appendChild(h("div", { class: "part-sub" }, "Part numbers mentioned in the ticket"));
    box.appendChild(h("div", { class: "parts" }, state.matches.map((p) => partRow(p, state, actions))));
  }

  // Search: results go in their own box so typing doesn't redraw (and blur) the input.
  const results = h("div", { class: "parts" });
  const input = h("input", { type: "search", class: "bmc-in part-search", placeholder: "🔎 Find a part: e.g. DIMM DDR5 64GB, M321R8GA0BB0, 211-000028", spellcheck: "false" });
  let timer;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const found = searchCatalog(state.catalog, input.value);
      results.replaceChildren(...(input.value.trim() && !found.length ? [h("div", { class: "muted" }, "Nothing found.")] : found.map((p) => partRow(p, state, actions))));
    }, 150);
  });
  box.append(input, results);
  const c = state.catalog;
  box.appendChild(h("div", { class: "nb-foot muted" },
    `Catalog: ${c.parts.length.toLocaleString()} parts · updated ${timeAgo(new Date(c.at).toISOString())}${c.stale ? " (couldn't refresh)" : ""} `,
    h("button", { class: "mini icon-btn", title: "Reload the catalog", "aria-label": "Reload the catalog", onclick: actions.onReload }, icon("refresh", 11))));
}

// Where a part is stored (NetBox), the ticket's site first.
function renderStock(box, stock, siteCode) {
  if (stock === "loading") return box.replaceChildren(h("div", { class: "muted" }, h("span", { class: "spinner" }), "Looking in NetBox storage…"));
  if (!stock.ok) return box.replaceChildren(h("div", { class: "ping-msg bad" }, stock.error));
  if (!stock.rows.length) return box.replaceChildren(h("div", { class: "muted" }, "📦 None found in NetBox storage."));
  box.replaceChildren(...[
    stock.sameType && h("div", { class: "part-flag" }, "ℹ️ Not stocked under this number. Same type in storage: ", h("b", {}, stock.sameType.join(", "))),
    h("div", { class: "stock-sum" }, "📦 ", stockSummary(stock, siteCode)),
    // Every location, the ticket's site first (highlighted).
    h("ul", { class: "stock-list" }, stock.rows.map((r) => h("li", { class: r.site === siteCode ? "here" : "" },
      h("b", {}, r.location), ` — ${r.onsite}${r.kind === "serialized" ? " serialized" : " on site"}${r.receiving ? `, ${r.receiving} arriving` : ""}`)))
  ].filter(Boolean)); // skip lines that don't apply
}

// Jira comment lines for the parts ticked as used.
function partsCommentLines(used) {
  const parts = [...(used?.values() || [])];
  if (!parts.length) return [];
  // Led by the Lambda P/N, since that's what parts are tracked by.
  return ["*Parts used:*", ...parts.map((p) => {
    const ids = [p.legacy && `SKU ${p.legacy}`, p.mpn && p.mpn !== p.lambda && `MPN ${p.mpn}`].filter(Boolean).join(", ");
    return `* ${p.lambda ? `Lambda P/N *${p.lambda}*` : "(no Lambda P/N)"}${ids ? ` (${ids})` : ""} — ${[p.vendor, p.name || p.desc].filter(Boolean).join(" ")}`;
  })];
}

// ---------- Catalog rows for the AI chat ----------
// The chat gets the catalog rows that best fit the question and the ticket, so it can name real part numbers.

// Words that mean the same kind of part, so "memory" finds DIMMs and "power supply" finds PSUs, and the
// legacy SKU prefixes the catalog uses for that kind of part (note: DDR = drives, RAM = memory).
const PART_TYPES = [
  { words: ["dimm", "memory", "ram", "rdimm", "lrdimm", "ddr4", "ddr5"], sku: ["RAM"], pn: ["207"] },
  { words: ["psu", "power supply", "pws"], sku: ["PSU"], pn: ["214"] },
  { words: ["ssd", "nvme", "drive", "disk", "u.2", "m.2", "e1.s"], sku: ["DDR"], pn: ["208", "209"] },
  { words: ["nic", "network adapter", "connectx", "infiniband", "hca"], sku: ["NIC"], pn: ["211"] },
  { words: ["gpu", "h100", "h200", "a100", "b200", "baseboard", "hgx"], sku: ["GPU", "MBD"], pn: ["206", "204"] },
  { words: ["fan"], sku: ["FAN"], pn: [] },
  { words: ["cable", "dac", "aoc", "transceiver", "optic", "qsfp", "osfp"], sku: ["CBN", "CBI", "CBP"], pn: ["216", "236", "237", "238"] },
  { words: ["motherboard", "mainboard", "mbd"], sku: ["MBD"], pn: ["204", "213"] },
  { words: ["cpu", "processor", "xeon", "epyc"], sku: ["CPU"], pn: ["205"] },
  { words: ["riser"], sku: [], pn: ["217"] },
  { words: ["backplane", "midplane"], sku: [], pn: [] },
  { words: ["heatsink", "heat sink"], sku: ["HTS"], pn: ["228"] },
  { words: ["rail"], sku: [], pn: ["241"] }
];
const CATALOG_STOPWORDS = new Set(("the and for with what which part parts number numbers need do does to of is in on this that it " +
  "swap replace replacement new we my me can you should about server node ticket please find give get use one").split(" "));

function catalogRowsFor(catalog, texts, limit = 30) {
  const text = texts.filter(Boolean).join(" ").toLowerCase();
  const words = new Set((text.match(/[a-z0-9][a-z0-9.+-]{1,30}/g) || []).filter((w) => !CATALOG_STOPWORDS.has(w)));
  // The kind of part asked about (fan, PSU, DIMM…) counts most, by its words and its legacy SKU prefix.
  const types = PART_TYPES.filter((t) => t.words.some((w) => text.includes(w)));
  const typeWords = new Set(types.flatMap((t) => t.words));
  const typeSku = new Set(types.flatMap((t) => t.sku));
  const typePn = new Set(types.flatMap((t) => t.pn));
  typeWords.forEach((w) => words.add(w));
  const aboutServers = /\b(server|chassis|system)\b/.test(text);
  const aboutSwitches = /\bswitch/.test(text);
  const exact = new Set(findCatalogParts(catalog, texts).filter((p) => aboutServers || !p.system).map(partId));
  return catalog.parts.map((p) => {
    const hay = `${p.vendor} ${p.name} ${p.desc} ${p.mpn}`.toLowerCase();
    let score = exact.has(partId(p)) ? 20 : 0;
    for (const w of words) if (hay.includes(w)) score += typeWords.has(w) ? 5 : w.length >= 4 ? 2 : 1;
    if (typeSku.has(p.legacy.slice(0, 3)) || typePn.has(p.lambda.slice(0, 3))) score += 8;
    if (p.inactive) score -= 3;
    // Whole servers and switch gear only when the question is about them.
    if (!aboutServers && isWholeSystem(p)) score -= 12;
    if (!aboutSwitches && /\bswitch/.test(hay)) score -= 6;
    return { p, score: score + (p.lambda ? 1 : 0) };
  }).filter((x) => x.score >= 4).sort((a, b) => b.score - a.score).slice(0, limit).map((x) => x.p);
}

function catalogRowsText(parts) {
  return parts.map((p) => [
    `Lambda P/N: ${p.lambda || "none"}`, p.legacy && `SKU: ${p.legacy}`, p.mpn && `MPN: ${p.mpn}`,
    [p.vendor, p.name].filter(Boolean).join(" "), p.desc && p.desc !== p.name && p.desc,
    isWholeSystem(p) && "(whole server/chassis)", p.inactive && (p.replacedBy ? `(EOL, use ${p.replacedBy} instead)` : "(inactive item)"), `catalog row ${p.row}`
  ].filter(Boolean).join(" | ")).join("\n");
}
