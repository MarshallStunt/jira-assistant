// Reachability checks via the local "ping helper" (Chrome native messaging host).
// Browsers can't send ICMP, so the helper (ping-helper/ folder) does the actual ping on this computer.

const PING_HOST = "com.dcops.ping_helper";
const ROLE_LABEL = { host: "Host", bmc: "BMC", mgmt: "Mgmt", data: "Data", other: "Other" };

// Only IP addresses are pinged (hostnames and serials are skipped).
function isIPv4(a) {
  const m = a.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  return !!m && m.slice(1).every((o) => Number(o) <= 255);
}
function isIPv6(a) {
  return a.includes(":") && /^[0-9a-f:.]+$/i.test(a) && (a.match(/::/g) || []).length <= 1 && a.split(":").length >= 3;
}
const isIP = (a) => isIPv4(a) || isIPv6(a);

// Fallback when the AI didn't label any IPs: every IPv4 in the ticket text.
function findIPsInText(text) {
  const found = (String(text || "").match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) || []).filter(isIPv4);
  return [...new Set(found)].filter((ip) => !/^(0\.|127\.|255\.)/.test(ip)).slice(0, 8);
}

function buildPingTargets(brief, ticketIps = [], extraTargets = []) {
  const out = [];
  const seen = new Set();
  const add = (role, address) => {
    const a = cleanAddress(address);
    if (!a || !isIP(a) || seen.has(a.toLowerCase())) return;
    seen.add(a.toLowerCase());
    out.push({ role, address: a });
  };
  (brief.network_targets || []).forEach((t) => add(t.role, t.address));
  brief.server_names.forEach((n) => add("host", n));            // a "server name" that is an IP
  extraTargets.forEach((t) => add(t.role, t.address));            // from NetBox
  if (!out.length) ticketIps.forEach((ip) => add("other", ip));  // AI found none → scan ticket text
  return out.slice(0, 12);
}

function sendNative(message) {
  return new Promise((resolve) => {
    if (!chrome.runtime.sendNativeMessage) {
      return resolve({ ok: false, error: "Native messaging not available — reload the extension.", notInstalled: true });
    }
    chrome.runtime.sendNativeMessage(PING_HOST, message, (resp) => {
      const err = chrome.runtime.lastError?.message;
      if (err) {
        const notInstalled = /not found/i.test(err);
        const forbidden = /forbidden/i.test(err);
        return resolve({
          ok: false,
          notInstalled: notInstalled || forbidden,
          error: notInstalled
            ? "Ping helper is not installed on this computer."
            : forbidden
              ? "Ping helper is installed for a different extension ID. Re-run the install command from Settings."
              : `Ping helper error: ${err}`
        });
      }
      resolve(resp || { ok: false, error: "No response from ping helper." });
    });
  });
}

const pingHelperHello = () => sendNative({ action: "hello" });

async function runPing(targets) {
  if (!targets.length) return { ok: false, error: "No IP address found in the ticket.", noTargets: true };
  const resp = await sendNative({ action: "ping", targets, count: 3 });
  if (resp.ok) resp.at = resp.at || Date.now();
  return resp;
}

const fmtMs = (ms) => (ms === null || ms === undefined ? "?" : ms < 1 ? "<1" : String(ms));

function interfaceLabel(x) {
  if (!x.interface) return "";
  return x.interface_name ? `${x.interface} (${x.interface_name})` : x.interface;
}

// One-line text version, used for the Jira comment.
function pingSummary(x) {
  const who = `${ROLE_LABEL[x.role] || "Host"} ${x.address}${x.ip && x.ip !== x.address ? ` (${x.ip})` : ""}`;
  if (!x.ok) return `${who} — ${x.error}`;
  const via = interfaceLabel(x) ? ` via ${interfaceLabel(x)}` : "";
  return x.reachable
    ? `${who} — reachable, ${fmtMs(x.avg_ms)} ms, ${x.loss}% loss${via}`
    : `${who} — NO REPLY (${x.loss}% loss)${via}`;
}
