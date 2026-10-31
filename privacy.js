// Privacy mode: before anything is sent to the AI, sensitive values are swapped for placeholders like
// [IP-1] or [PERSON-2]. The AI works with the placeholders; the real values are put back into its answer
// here, on this computer. Passwords / tokens found in tickets are removed and never put back.

const PRIVACY_KINDS = {
  people:  "People's names",
  contact: "Emails & phone numbers",
  network: "IP & MAC addresses",
  serials: "Serial numbers"
};

const SECRET_RES = [
  // "password: hunter2", "token = abc", "api key is xyz"
  /\b(pass(?:word|wd|phrase)?|pwd|secret|token|api[ _-]?key|credentials?)\b(\s*[:=]\s*|\s+is\s+)("[^"]+"|'[^']+'|\S+)/gi,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}=*/g,
  /\b(?:sk-[A-Za-z0-9_-]{16,}|sk-ant-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|xox[abposr]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,})\b/g
];
const EMAIL_RE = /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g;
const PHONE_RE = /(?<![\w.-])(?:\+\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?![\w.-])/g;
const MAC_RE = /\b[0-9a-f]{2}([:-])(?:[0-9a-f]{2}\1){4}[0-9a-f]{2}\b/gi;
const IPV4_RE = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\/\d{1,2})?\b/g;
const IPV6_RE = /\b(?:[0-9a-f]{1,4}:){1,7}(?::[0-9a-f]{1,4}){1,7}\b|\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b/gi; // "::" form first
const PLACEHOLDER_RE = /\[?\b(PERSON|EMAIL|PHONE|IP|MAC|SERIAL|HIDDEN)-(\d+)\b\]?/g;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Names of everyone on the ticket (reporter, assignee, commenters, work logs, history).
function issuePeople(data) {
  const f = data?.fields || {};
  const names = [f.reporter, f.assignee, f.creator,
    ...(f.comment?.comments || []).flatMap((c) => [c.author, c.updateAuthor]),
    ...(f.worklog?.worklogs || []).map((w) => w.author),
    ...(data?.changelog?.histories || []).map((hh) => hh.author)
  ].map((u) => u?.displayName).filter(Boolean);
  return [...new Set(names)];
}

// settings: privacyMode, privacyHide {people, contact, network, serials}, privacyWords (one per line)
function makeRedactor(settings, people = []) {
  const on = !!settings.privacyMode;
  const hide = { people: true, contact: true, network: true, serials: true, ...(settings.privacyHide || {}) };
  const toReal = new Map();
  const toPlaceholder = new Map();
  const counts = {};
  let secrets = 0;

  const placeholder = (kind, real) => {
    const key = `${kind}:${real.toLowerCase()}`;
    if (!toPlaceholder.has(key)) {
      counts[kind] = (counts[kind] || 0) + 1;
      const p = `[${kind}-${counts[kind]}]`;
      toPlaceholder.set(key, p);
      toReal.set(p, real);
    }
    return toPlaceholder.get(key);
  };
  const swap = (text, re, kind) => text.replace(re, (m) => placeholder(kind, m));
  const words = String(settings.privacyWords || "").split(/\n/).map((w) => w.trim()).filter((w) => w.length > 1);

  function redact(text) {
    let t = String(text ?? "");
    if (!on || !t) return t;
    for (const re of SECRET_RES) {
      t = t.replace(re, (m, label, sep) => { secrets++; return label && sep ? `${label}${sep}[REMOVED]` : "[REMOVED]"; });
    }
    for (const w of words) t = t.replace(new RegExp(`\\b${escapeRe(w)}\\b`, "gi"), (m) => placeholder("HIDDEN", m));
    if (hide.people) {
      t = t.replace(/\[~accountid:[^\]]+\]/g, "@someone");
      for (const name of [...people].sort((a, b) => b.length - a.length)) {
        t = t.replace(new RegExp(`\\b${escapeRe(name)}\\b`, "gi"), () => placeholder("PERSON", name));
        // First names on their own ("thanks John"), if they're not ordinary short words.
        const first = name.split(/\s+/)[0];
        if (first !== name && first.length >= 3 && /^[A-Z]/.test(first)) {
          t = t.replace(new RegExp(`\\b${escapeRe(first)}\\b`, "g"), () => placeholder("PERSON", name));
        }
      }
    }
    if (hide.contact) t = swap(swap(t, EMAIL_RE, "EMAIL"), PHONE_RE, "PHONE");
    if (hide.network) t = swap(swap(swap(t, MAC_RE, "MAC"), IPV4_RE, "IP"), IPV6_RE, "IP");
    if (hide.serials && typeof findSerialsInText === "function") {
      for (const sn of findSerialsInText(t).filter((s) => !/^\[|^[A-Z]+-\d+$/.test(s))) {
        t = t.replace(new RegExp(`\\b${escapeRe(sn)}\\b`, "gi"), (m) => placeholder("SERIAL", m));
      }
    }
    return t;
  }

  // Put real values back into the AI's answer (strings anywhere inside objects/arrays).
  function restore(v) {
    if (typeof v === "string") return v.replace(PLACEHOLDER_RE, (m, kind, n) => toReal.get(`[${kind}-${n}]`) ?? m);
    if (Array.isArray(v)) return v.map(restore);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, restore(x)]));
    return v;
  }

  return {
    on,
    redact,
    restore,
    get hidden() { return toReal.size + secrets; }
  };
}
