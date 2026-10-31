#!/usr/bin/env python3
"""
DC Ops ping helper — Chrome native messaging host for the DC Ops Jira Assistant extension.

Chrome extensions cannot send ICMP pings, so the extension asks this helper to:
  - resolve each address (DNS),
  - ping it,
  - report which local network interface the traffic is routed through.
It also handles BMC work that needs credentials (1Password logins never reach the extension):
  - finds the BMC's login in 1Password (via the `op` CLI) and copies the password to the clipboard,
  - reads the server's health from the BMC's Redfish API (GETs),
  - shuts down / powers on the server through Redfish, only when the user confirmed it in the panel.

Protocol: Chrome native messaging (4-byte native-endian length + UTF-8 JSON) on stdin/stdout.
Requests:
  {"action": "hello"}
  {"action": "ping", "targets": [{"address": "host-01", "role": "host"}, ...], "count": 3}
  {"action": "bmc_copy_password", "ip": "10.1.2.3", "names": ["host-01"], "serials": ["S123"], "op": {...}}
  {"action": "bmc_health", "ip": "10.1.2.3", "names": [...], "serials": [...], "op": {...}, "port": 443}
      optional "login": {"user": "ADMIN", "password": "..."} skips 1Password (typed in the panel)
  {"action": "bmc_power", "ip": "10.1.2.3", "reset_type": "GracefulShutdown" | "ForceOff" | "On", "confirm": "10.1.2.3", ...}
  {"action": "op_check", "op": {...}}
  "op" settings: {"vault": "", "account": "", "tag": "", "fallback": ""} (all optional).
Only hostnames / IP addresses are accepted, BMC requests only go to private IPs, and commands are run
without a shell. Passwords are never sent back to the extension.
"""

import base64
import concurrent.futures
import ipaddress
import json
import os
import platform
import re
import shutil
import socket
import ssl
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

VERSION = "1.3.0"
MAX_TARGETS = 12
IS_MAC = sys.platform == "darwin"
IS_WIN = sys.platform == "win32"
# Windows: don't flash a console window for every ping / route / curl the helper runs.
NO_WINDOW = {"creationflags": 0x08000000} if IS_WIN else {}  # CREATE_NO_WINDOW
HOST_RE = re.compile(r"^(?=.{1,253}$)[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,62})(?:\.[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,62}))*\.?$")
VPN_PREFIXES = ("utun", "ipsec", "ppp", "tun", "tap", "wg", "gpd", "zt", "tailscale", "cscotun", "vpn")
VPN_WORDS = ("vpn", "tap-", "wireguard", "tailscale", "globalprotect", "anyconnect", "zerotier", "openvpn", "fortinet", "pangp")


# ---------- native messaging framing ----------

def read_message():
    if IS_WIN:  # native messaging is binary; make sure Windows doesn't translate line endings
        import msvcrt
        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
    raw_len = sys.stdin.buffer.read(4)
    if len(raw_len) < 4:
        return None
    (length,) = struct.unpack("=I", raw_len)
    return json.loads(sys.stdin.buffer.read(length).decode("utf-8"))


def send_message(obj):
    data = json.dumps(obj).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("=I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


# ---------- helpers ----------

def find_cmd(name):
    path = shutil.which(name)
    if path:
        return path
    # Chrome starts the helper with a minimal PATH, so also look where Homebrew/winget/1Password install things.
    if IS_WIN:
        local = os.environ.get("LOCALAPPDATA", "")
        dirs = (os.path.join(local, "Microsoft", "WinGet", "Links"), os.path.join(os.environ.get("ProgramFiles", ""), "1Password CLI"),
                os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32"),
                os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "WindowsPowerShell", "v1.0"))
        names = (name + ".exe", name)
    else:
        dirs = ("/sbin", "/usr/sbin", "/bin", "/usr/bin", "/opt/homebrew/bin", "/usr/local/bin")
        names = (name,)
    for d in dirs:
        for n in names:
            p = os.path.join(d, n)
            if os.path.exists(p):
                return p
    return None


def run(cmd, timeout):
    try:
        p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                           stdin=subprocess.DEVNULL, timeout=timeout, **NO_WINDOW)
        return p.returncode, p.stdout.decode("utf-8" if not IS_WIN else "mbcs", "replace")
    except subprocess.TimeoutExpired as e:
        out = e.stdout.decode("utf-8", "replace") if e.stdout else ""
        return -1, out


def valid_address(addr):
    if not isinstance(addr, str) or not addr or addr.startswith("-"):
        return False
    try:
        ipaddress.ip_address(addr)
        return True
    except ValueError:
        return bool(HOST_RE.match(addr))


def resolve(addr):
    """Return (ip, family) preferring IPv4."""
    try:
        ip = ipaddress.ip_address(addr)
        return str(ip), (socket.AF_INET6 if ip.version == 6 else socket.AF_INET)
    except ValueError:
        pass
    infos = socket.getaddrinfo(addr, None, proto=socket.IPPROTO_TCP)
    infos.sort(key=lambda i: 0 if i[0] == socket.AF_INET else 1)
    return infos[0][4][0], infos[0][0]


def source_ip(ip, family):
    """Local IP the OS would use to reach `ip` (UDP connect sends no packets)."""
    try:
        s = socket.socket(family, socket.SOCK_DGRAM)
        s.settimeout(1)
        s.connect((ip, 9))
        src = s.getsockname()[0]
        s.close()
        return src
    except OSError:
        return ""


_PORT_NAMES = None


def hardware_port_names():
    """macOS: map en0 -> 'Wi-Fi', en5 -> 'USB 10/100/1000 LAN', etc."""
    global _PORT_NAMES
    if _PORT_NAMES is not None:
        return _PORT_NAMES
    _PORT_NAMES = {}
    cmd = find_cmd("networksetup")
    if IS_MAC and cmd:
        _, out = run([cmd, "-listallhardwareports"], 5)
        port = None
        for line in out.splitlines():
            if line.startswith("Hardware Port:"):
                port = line.split(":", 1)[1].strip()
            elif line.startswith("Device:") and port:
                _PORT_NAMES[line.split(":", 1)[1].strip()] = port
    return _PORT_NAMES


def friendly_interface(iface):
    if not iface:
        return ""
    low = iface.lower()
    if IS_WIN:
        return "VPN" if any(w in low for w in VPN_WORDS) else ""
    if low.startswith("lo"):
        return "Loopback"
    if low.startswith(VPN_PREFIXES):
        return "VPN"
    name = hardware_port_names().get(iface)
    if name:
        return name
    if low.startswith(("wl", "wlan")):
        return "Wi-Fi"
    if low.startswith(("eth", "en", "em", "eno", "ens", "enp")):
        return "Ethernet"
    return ""


def route_info(ip, family):
    """Which local interface/gateway the OS routes `ip` through."""
    info = {"interface": "", "gateway": ""}
    if IS_MAC:
        cmd = find_cmd("route")
        if not cmd:
            return info
        args = [cmd, "-n", "get"] + (["-inet6"] if family == socket.AF_INET6 else []) + [ip]
        _, out = run(args, 5)
        m = re.search(r"interface:\s*(\S+)", out)
        g = re.search(r"gateway:\s*(\S+)", out)
        info["interface"] = m.group(1) if m else ""
        info["gateway"] = g.group(1) if g else ""
    elif IS_WIN:
        ps = find_cmd("powershell")
        if not ps:
            return info
        # ip was validated by ipaddress, so it's safe inside the script.
        script = (f"$r = Find-NetRoute -RemoteIPAddress '{ip}' -ErrorAction SilentlyContinue; "
                  "($r | Where-Object InterfaceAlias | Select-Object -First 1).InterfaceAlias; "
                  "($r | Where-Object NextHop | Select-Object -First 1).NextHop")
        _, out = run([ps, "-NoProfile", "-NonInteractive", "-Command", script], 8)
        lines = [l.strip() for l in out.splitlines() if l.strip()]
        info["interface"] = lines[0] if lines else ""
        info["gateway"] = lines[1] if len(lines) > 1 and lines[1] not in ("0.0.0.0", "::") else ""
    else:
        cmd = find_cmd("ip")
        if not cmd:
            return info
        _, out = run([cmd, "-6" if family == socket.AF_INET6 else "-4", "route", "get", ip], 5)
        m = re.search(r"\bdev\s+(\S+)", out)
        g = re.search(r"\bvia\s+(\S+)", out)
        info["interface"] = m.group(1) if m else ""
        info["gateway"] = g.group(1) if g else ""
    return info


def ping(ip, family, count):
    if family == socket.AF_INET6:
        cmd = [find_cmd("ping6")] if IS_MAC and find_cmd("ping6") else [find_cmd("ping"), "-6"]
    else:
        cmd = [find_cmd("ping")]
    if not cmd[0]:
        return {"reachable": False, "error": "ping command not found"}
    if IS_WIN:
        return ping_windows(cmd + ["-n", str(count), "-w", "2000", ip], count)
    if IS_MAC:
        cmd += ["-c", str(count), "-n"]
        if family != socket.AF_INET6:
            cmd += ["-t", str(count + 2)]  # overall timeout (s)
    else:
        cmd += ["-c", str(count), "-n", "-W", "2", "-w", str(count + 2)]
    cmd.append(ip)

    start = time.time()
    code, out = run(cmd, count + 4)
    loss_m = re.search(r"([\d.]+)%\s+packet loss", out)
    rtt_m = re.search(r"=\s*[\d.]+/([\d.]+)/", out)
    recv_m = re.search(r"(\d+)\s+(?:packets\s+)?received", out)
    received = int(recv_m.group(1)) if recv_m else (0 if code != 0 else count)
    result = {
        "reachable": received > 0,
        "loss": float(loss_m.group(1)) if loss_m else (0.0 if received else 100.0),
        "avg_ms": round(float(rtt_m.group(1)), 1) if rtt_m else None,
        "sent": count,
        "received": received,
        "took_s": round(time.time() - start, 1),
    }
    if received == 0 and code == -1:
        result["note"] = "timed out"
    elif received == 0:
        last = [l for l in out.strip().splitlines() if l.strip()]
        if last and "packet loss" not in last[-1] and "statistics" not in last[-1]:
            result["note"] = last[-1][:160]
    return result


def ping_windows(cmd, count):
    """Windows ping. Counts replies by their 'TTL=' / 'time' lines: Windows also counts
    'Destination host unreachable' answers as received, which would look like the server is up."""
    start = time.time()
    code, out = run(cmd, count * 3 + 4)
    replies = [l for l in out.splitlines() if re.search(r"(TTL|ttl)=\d+", l) or re.search(r"\btime[=<]\s*\d", l)]
    times = [float(m.group(1)) for l in replies for m in [re.search(r"[=<]\s*(\d+(?:\.\d+)?)\s*ms", l)] if m]
    received = len(replies)
    result = {
        "reachable": received > 0,
        "loss": round(100.0 * (count - received) / count, 1),
        "avg_ms": round(sum(times) / len(times), 1) if times else None,
        "sent": count,
        "received": received,
        "took_s": round(time.time() - start, 1),
    }
    if not received:
        hint = next((l.strip() for l in out.splitlines() if re.search(r"unreachable|timed out|could not find|failure", l, re.I)), "")
        result["note"] = hint[:160] or ("timed out" if code == -1 else "")
    return result


def check_target(target, count):
    addr = str(target.get("address", "")).strip()
    res = {"address": addr, "role": str(target.get("role", ""))[:20]}
    if not valid_address(addr):
        res.update(ok=False, error="Invalid address")
        return res
    try:
        ip, family = resolve(addr)
    except (socket.gaierror, UnicodeError, IndexError):
        res.update(ok=False, error="DNS lookup failed (name not found)")
        return res
    res["ip"] = ip
    route = route_info(ip, family)
    res["interface"] = route["interface"]
    res["interface_name"] = friendly_interface(route["interface"])
    res["gateway"] = route["gateway"]
    res["source_ip"] = source_ip(ip, family)
    res.update(ping(ip, family, count))
    res["ok"] = True
    return res


# ---------- 1Password (BMC logins) ----------

OP_TIMEOUT = 90  # long enough for the user to approve the Touch ID / 1Password prompt
CLIPBOARD_CLEAR_S = 30


class HelperError(Exception):
    pass


def op_settings(raw):
    """Vault/account/tag/fallback names from the extension. They go into argv, so refuse anything flag-like."""
    out = {}
    for k in ("vault", "account", "tag", "fallback"):
        v = str((raw or {}).get(k) or "").strip()[:120]
        if v.startswith("-"):
            raise HelperError(f"Invalid 1Password {k}: {v}")
        out[k] = v
    return out


def op_error(text):
    # op prints the error first, then sometimes a list of sign-in options; the first line is the one that matters.
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    t = next((l for l in lines if l.startswith("[ERROR]")), lines[0] if lines else "unknown error")
    t = re.sub(r"^\[ERROR\]\s*[\d/: ]*", "", t)
    low = t.lower()
    if "not currently signed in" in low or "no accounts configured" in low or "account is not signed in" in low:
        return ("1Password CLI isn't connected to the 1Password app. In 1Password open Settings → Developer and "
                "tick “Integrate with 1Password CLI” (the macOS “op would like to access data” prompt is a "
                "different permission: allow it too), then try again.")
    if "dismissed" in low or "authorization" in low and "denied" in low:
        return "The 1Password prompt was dismissed."
    if "isn't a vault" in low or "vault" in low and "not found" in low:
        return f"1Password vault not found ({t}). Check the vault name in Settings."
    return f"1Password: {t}"


def op_json(args, cfg):
    cmd = find_cmd("op")
    if not cmd:
        raise HelperError("1Password CLI (op) is not installed. Install it with: "
                          + ("winget install AgileBits.1Password.CLI" if IS_WIN else "brew install 1password-cli"))
    full = [cmd] + args + ["--format", "json"]
    if cfg.get("account"):
        full += ["--account", cfg["account"]]
    try:
        p = subprocess.run(full, stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL, timeout=OP_TIMEOUT, **NO_WINDOW)
    except subprocess.TimeoutExpired:
        raise HelperError("1Password didn't answer (prompt not approved in time?).")
    if p.returncode != 0:
        raise HelperError(op_error(p.stderr.decode("utf-8", "replace")))
    return json.loads(p.stdout.decode("utf-8") or "null")


def _norm(v):
    return re.sub(r"[^a-z0-9]", "", str(v or "").lower())


def _url_host(href):
    href = str(href or "").strip()
    if not href:
        return ""
    if "://" not in href:
        href = "https://" + href
    try:
        return (urllib.parse.urlsplit(href).hostname or "").lower()
    except ValueError:
        return ""


def _words(title):
    return set(w.lower() for w in re.split(r"[\s,;|()\[\]/]+", str(title or "")) if w)


def find_bmc_item(cfg, ip, names, serials):
    """Best 1Password item for this BMC: URL = BMC IP, then title with the IP, hostname or serial,
    then the configured fallback item. Returns (item, how_matched, other_candidates)."""
    args = ["item", "list"]
    if cfg["vault"]:
        args += ["--vault", cfg["vault"]]
    if cfg["tag"]:
        args += ["--tags", cfg["tag"]]
    items = op_json(args, cfg) or []
    names = [n.lower() for n in names if n]
    serials = [_norm(s) for s in serials if s]

    tiers = [
        ("website is the BMC IP", lambda it: any(_url_host(u.get("href")) == ip for u in it.get("urls") or [])),
        ("title has the BMC IP", lambda it: ip in _words(it.get("title"))),
        ("title has the hostname", lambda it: any(n in _words(it.get("title")) or n.split(".")[0] in _words(it.get("title")) for n in names)),
        ("title has the serial", lambda it: any(s and s in _norm(it.get("title")) for s in serials)),
    ]
    if cfg["fallback"]:
        fb = cfg["fallback"].lower()
        tiers.append(("fallback item", lambda it: str(it.get("title", "")).lower() == fb or it.get("id") == cfg["fallback"]))
    for how, test in tiers:
        hits = [it for it in items if test(it)]
        if hits:
            return hits[0], how, len(hits) - 1
    where = f" in vault “{cfg['vault']}”" if cfg["vault"] else ""
    raise HelperError(f"No 1Password item found for BMC {ip}{where}. Looked for its IP as the website, "
                      f"or the IP / hostname / serial in the title.")


def item_login(cfg, item):
    full = op_json(["item", "get", item["id"]] + (["--vault", item["vault"]["id"]] if item.get("vault", {}).get("id") else []), cfg)
    fields = full.get("fields") or []

    def pick(purpose, labels, concealed=False):
        for f in fields:
            if f.get("purpose") == purpose and f.get("value"):
                return f["value"]
        for f in fields:
            label = str(f.get("label", "")).lower()
            if f.get("value") and any(l in label for l in labels) and (not concealed or f.get("type") == "CONCEALED"):
                return f["value"]
        return ""

    user = pick("USERNAME", ("username", "user", "login"))
    password = pick("PASSWORD", ("password",), concealed=True) or pick("PASSWORD", ("password",))
    if not password:
        raise HelperError(f"1Password item “{item.get('title')}” has no password field.")
    return user, password


def bmc_login(msg):
    ip = bmc_ip(msg.get("ip"))
    cfg = op_settings(msg.get("op"))
    names = [str(n).strip()[:80] for n in (msg.get("names") or [])[:8] if isinstance(n, str)]
    serials = [str(s).strip()[:60] for s in (msg.get("serials") or [])[:8] if isinstance(s, str)]
    item, how, others = find_bmc_item(cfg, ip, names, serials)
    user, password = item_login(cfg, item)
    info = {"title": item.get("title", ""), "vault": (item.get("vault") or {}).get("name", ""), "match": how, "others": others}
    return ip, user, password, info


def bmc_ip(value):
    try:
        ip = ipaddress.ip_address(str(value or "").strip())
    except ValueError:
        raise HelperError("BMC address must be an IP address.")
    if not (ip.is_private or ip.is_link_local) or ip.is_unspecified or ip.is_multicast:
        raise HelperError(f"{ip} is not a private address — BMC logins are only sent to private networks.")
    return str(ip)


# Runs detached after we exit: clears the clipboard after N seconds unless something else was copied.
# The secret arrives on stdin so it never shows up in the process list.
CLEAR_SCRIPT = (
    "import json,subprocess,sys,time\n"
    "s=sys.stdin.buffer.read();time.sleep(float(sys.argv[1]))\n"
    "c,p=json.loads(sys.argv[2]),json.loads(sys.argv[3]);f=json.loads(sys.argv[4])\n"
    "try:\n"
    " if subprocess.run(p,stdout=subprocess.PIPE,timeout=5,**f).stdout.strip()==s.strip():subprocess.run(c,input=b'',timeout=5,**f)\n"
    "except Exception:pass\n"
)


def clipboard_cmds():
    """(copy from stdin, read, clear) commands."""
    if IS_MAC:
        return [find_cmd("pbcopy")], [find_cmd("pbpaste")], [find_cmd("pbcopy")]
    if IS_WIN:
        ps = [find_cmd("powershell") or "powershell", "-NoProfile", "-NonInteractive", "-Command"]
        return (ps + ["$t = [Console]::In.ReadToEnd(); Set-Clipboard -Value $t"],
                ps + ["[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-Clipboard -Raw"],
                ps + ["Set-Clipboard -Value ' '"])
    if os.environ.get("WAYLAND_DISPLAY") and find_cmd("wl-copy"):
        return [find_cmd("wl-copy")], [find_cmd("wl-paste"), "-n"], [find_cmd("wl-copy")]
    if find_cmd("xclip"):
        xc = [find_cmd("xclip"), "-selection", "clipboard"]
        return xc, xc + ["-o"], xc
    raise HelperError("No clipboard tool found (install xclip or wl-clipboard).")


def copy_secret(secret):
    copy, paste, clear = clipboard_cmds()
    data = secret.encode("utf-8")
    subprocess.run(copy, input=data, timeout=10, check=True, **NO_WINDOW)
    detach = {"creationflags": 0x08000000 | 0x00000008} if IS_WIN else {"start_new_session": True}  # + DETACHED_PROCESS
    child = subprocess.Popen([sys.executable, "-c", CLEAR_SCRIPT, str(CLIPBOARD_CLEAR_S), json.dumps(clear), json.dumps(paste), json.dumps(NO_WINDOW)],
                             stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **detach)
    child.stdin.write(data)
    child.stdin.close()


def op_check(msg):
    """Settings page test: is `op` signed in, and how many items would be searched?"""
    cfg = op_settings(msg.get("op"))
    vaults = op_json(["vault", "list"], cfg) or []
    if cfg["vault"] and not any(cfg["vault"] in (v.get("name"), v.get("id")) for v in vaults):
        raise HelperError(f"Vault “{cfg['vault']}” not found. You can see: {', '.join(v.get('name', '?') for v in vaults) or 'no vaults'}.")
    args = ["item", "list"] + (["--vault", cfg["vault"]] if cfg["vault"] else []) + (["--tags", cfg["tag"]] if cfg["tag"] else [])
    return {"ok": True, "vaults": len(vaults), "vault": cfg["vault"], "items": len(op_json(args, cfg) or [])}


def bmc_copy_password(msg):
    ip, user, password, info = bmc_login(msg)
    copy_secret(password)
    return {"ok": True, "ip": ip, "username": user, "item": info, "clears_in": CLIPBOARD_CLEAR_S}


# ---------- Redfish (BMC health, read-only) ----------

REDFISH_TIMEOUT = 15
MAX_BODY = 8 * 1024 * 1024
BAD_HEALTH = ("Warning", "Critical")
SKIP_STATES = ("Absent", "Disabled", "UnavailableOffline", "StandbyOffline")


def _json_or_empty(text):
    text = (text or "").strip()
    if not text:
        return {}  # e.g. 204 No Content after a power action
    try:
        return json.loads(text[:MAX_BODY])
    except ValueError:
        return {}


def redfish_message(text):
    """': <message>' from a Redfish error body, or ''."""
    try:
        err = json.loads(text).get("error", {})
        msgs = [m.get("Message") for m in err.get("@Message.ExtendedInfo", []) if m.get("Message")] or [err.get("message")]
        return f": {msgs[0][:200]}" if msgs and msgs[0] else ""
    except (ValueError, AttributeError):
        return ""


class Redfish:
    def __init__(self, ip, user, password, port=443):
        self.base = "https://" + (f"[{ip}]" if ":" in ip else ip) + ("" if port == 443 else f":{port}")
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE  # BMCs almost always have self-signed certificates
        self.opener = urllib.request.build_opener(urllib.request.HTTPSHandler(context=ctx), urllib.request.ProxyHandler({}))
        token = base64.b64encode(f"{user}:{password}".encode("utf-8")).decode("ascii")
        self.headers = {"Authorization": f"Basic {token}", "Accept": "application/json", "OData-Version": "4.0"}
        self.login = (user, password)
        self.use_curl = False  # switched on after a TLS handshake failure

    def get(self, path):
        return self.request("GET", path)

    def post(self, path, body):
        return self.request("POST", path, body)

    def request(self, method, path, body=None):
        if not isinstance(path, str) or not path.startswith("/redfish/"):
            raise HelperError(f"Unexpected Redfish path: {path!r}")
        if self.use_curl:
            return self._curl(method, path, body)
        try:
            return self._urllib(method, path, body)
        except HelperError as e:
            # Old Python TLS libraries can't talk to some BMCs ("EOF occurred in violation of protocol",
            # handshake failures). curl uses a newer TLS stack, so retry with it.
            if getattr(e, "tls", False) and find_cmd("curl"):
                self.use_curl = True
                return self._curl(method, path, body)
            raise

    def _curl(self, method, path, body):
        def q(v):
            return '"' + v.replace("\\", "\\\\").replace('"', '\\"') + '"'
        # The login goes to curl on stdin (-K -), so it never appears in the process list.
        config = f"user = {q(self.login[0] + ':' + self.login[1])}\n"
        cmd = [find_cmd("curl"), "-sS", "-k", "--noproxy", "*", "--max-time", str(REDFISH_TIMEOUT),
               "-H", "Accept: application/json", "-H", "OData-Version: 4.0", "-X", method,
               "-w", "\n%{http_code}", "-K", "-", self.base + path]
        if body is not None:
            cmd[-1:-1] = ["-H", "Content-Type: application/json", "--data-raw", json.dumps(body)]
        try:
            p = subprocess.run(cmd, input=config.encode("utf-8"), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               timeout=REDFISH_TIMEOUT + 5, **NO_WINDOW)
        except subprocess.TimeoutExpired:
            raise HelperError("Can't reach the BMC's Redfish API (timed out).")
        out, _, code = p.stdout.decode("utf-8", "replace").rpartition("\n")
        if p.returncode != 0:
            err = p.stderr.decode("utf-8", "replace").strip().splitlines()
            raise HelperError(f"Can't reach the BMC's Redfish API ({err[-1] if err else f'curl exit {p.returncode}'}).")
        if code in ("401", "403"):
            raise HelperError(f"The BMC rejected the login (HTTP {code}).")
        if not code.startswith("2"):
            raise HelperError(f"BMC returned HTTP {code} for {path}{redfish_message(out)}")
        return _json_or_empty(out)

    def _urllib(self, method, path, body):
        data = None if body is None else json.dumps(body).encode("utf-8")
        headers = dict(self.headers, **({"Content-Type": "application/json"} if data else {}))
        req = urllib.request.Request(self.base + path, data=data, headers=headers, method=method)
        try:
            with self.opener.open(req, timeout=REDFISH_TIMEOUT) as r:
                return _json_or_empty(r.read(MAX_BODY).decode("utf-8", "replace"))
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                raise HelperError(f"The BMC rejected the login (HTTP {e.code}).")
            raise HelperError(f"BMC returned HTTP {e.code} for {path}{redfish_message(e.read(20000).decode('utf-8', 'replace'))}")
        except (urllib.error.URLError, socket.timeout, ssl.SSLError, ConnectionError) as e:
            reason = getattr(e, "reason", e)
            err = HelperError(f"Can't reach the BMC's Redfish API ({reason}).")
            err.tls = isinstance(reason, (ssl.SSLError, ConnectionResetError)) or "violation of protocol" in str(reason)
            raise err

    def members(self, coll, limit):
        ids = [m.get("@odata.id") for m in (coll.get("Members") or [])][:limit]
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            return [x for x in pool.map(self._try_get, ids) if x]

    def _try_get(self, path):
        try:
            return self.get(path)
        except HelperError:
            return None


def _link(obj, key):
    v = (obj or {}).get(key)
    return v.get("@odata.id") if isinstance(v, dict) else None


def _status(obj):
    st = (obj or {}).get("Status") or {}
    return st.get("Health"), st.get("HealthRollup"), st.get("State")


def _problem(component, obj, detail=""):
    health, rollup, state = _status(obj)
    if state in SKIP_STATES:
        return None
    worst = health if health in BAD_HEALTH else rollup if rollup in BAD_HEALTH else None
    if not worst:
        return None
    name = obj.get("Name") or obj.get("MemberId") or obj.get("Id") or component
    return {"component": component, "name": str(name)[:80], "health": worst, "state": state or "", "detail": str(detail)[:160]}


def system_problems(rf, system):
    out = []
    for summary, link, label in (("MemorySummary", "Memory", "Memory"), ("ProcessorSummary", "Processors", "CPU/GPU")):
        st = (system.get(summary) or {}).get("Status") or {}
        if (st.get("HealthRollup") or st.get("Health")) in BAD_HEALTH and _link(system, link):
            coll = rf._try_get(_link(system, link)) or {}
            for m in rf.members(coll, 64):
                p = _problem(label, m, m.get("Model") or m.get("PartNumber") or "")
                if p:
                    out.append(p)
    for link, label in (("Storage", "Storage"), ("SimpleStorage", "Storage")):
        if _link(system, link):
            for s in rf.members(rf._try_get(_link(system, link)) or {}, 8):
                p = _problem(label, s)
                if p:
                    out.append(p)
    return out


def chassis_problems(rf, root):
    out = []
    coll = rf._try_get(_link(root, "Chassis")) if _link(root, "Chassis") else None
    for ch in rf.members(coll or {}, 12):
        p = _problem("Chassis", ch)
        if p:
            out.append(p)
        thermal = rf._try_get(_link(ch, "Thermal")) if _link(ch, "Thermal") else None
        for fan in (thermal or {}).get("Fans") or []:
            p = _problem("Fan", fan, f"{fan.get('Reading')} {fan.get('ReadingUnits') or 'RPM'}" if fan.get("Reading") is not None else "")
            if p:
                out.append(p)
        for t in (thermal or {}).get("Temperatures") or []:
            p = _problem("Temperature", t, f"{t.get('ReadingCelsius')} °C" if t.get("ReadingCelsius") is not None else "")
            if p:
                out.append(p)
        power = rf._try_get(_link(ch, "Power")) if _link(ch, "Power") else None
        for psu in (power or {}).get("PowerSupplies") or []:
            p = _problem("PSU", psu, psu.get("Model") or "")
            if p:
                out.append(p)
    # Several chassis often report the same fan/PSU; keep one of each.
    seen, unique = set(), []
    for p in out:
        k = (p["component"], p["name"], p["health"])
        if k not in seen:
            seen.add(k)
            unique.append(p)
    return unique


LOG_SERVICE_RE = re.compile(r"sel|event|iml|log", re.I)
SKIP_LOG_RE = re.compile(r"lclog|faultlist|diag|audit|journal", re.I)


def recent_events(rf, owners, limit=10):
    """Latest Warning/Critical entries from the hardware event logs (SEL / IML / event log)."""
    entries = []
    for owner in owners:
        if not _link(owner, "LogServices"):
            continue
        services = rf._try_get(_link(owner, "LogServices")) or {}
        for svc in rf.members(services, 6):
            sid = f"{svc.get('Id', '')} {svc.get('Name', '')}"
            if not LOG_SERVICE_RE.search(sid) or SKIP_LOG_RE.search(sid) or not _link(svc, "Entries"):
                continue
            coll = rf._try_get(_link(svc, "Entries")) or {}
            members = coll.get("Members") or []
            # Collections are usually expanded; if they only hold links, fetch the last few.
            if members and set(members[0].keys()) <= {"@odata.id"}:
                members = rf.members({"Members": members[-40:]}, 40)
            for e in members:
                sev = e.get("Severity") or e.get("EntrySeverity") or ""
                if sev not in BAD_HEALTH:
                    continue
                entries.append({
                    "when": e.get("Created") or e.get("EventTimestamp") or "",
                    "severity": sev,
                    "message": str(e.get("Message") or e.get("Name") or "")[:240],
                    "log": str(svc.get("Id") or svc.get("Name") or "")[:30],
                })
    entries.sort(key=lambda x: x["when"], reverse=True)
    return entries[:limit]


def bmc_session(msg):
    """Redfish client for msg["ip"], logged in with the typed login or the 1Password item."""
    login = msg.get("login")
    if isinstance(login, dict) and login.get("password"):
        # Pasted into the panel when 1Password isn't used; used for this request only.
        ip, info = bmc_ip(msg.get("ip")), None
        user, password = str(login.get("user") or "")[:64], str(login["password"])[:256]
    else:
        ip, user, password, info = bmc_login(msg)
    port = int(msg.get("port") or 443)
    if not 0 < port < 65536:
        raise HelperError("Invalid Redfish port.")
    return ip, info, Redfish(ip, user, password, port)


def first_system(rf):
    root = rf.get("/redfish/v1")
    systems = rf.members(rf.get(_link(root, "Systems")), 4) if _link(root, "Systems") else []
    return root, (systems[0] if systems else {})


# The only power actions the extension may ask for.
POWER_ACTIONS = ("GracefulShutdown", "ForceOff", "On")


def bmc_power(msg):
    """Shut down / force off / power on through the BMC's own ComputerSystem.Reset action.
    The panel asks the user to type the BMC IP first; it is passed back as "confirm" and checked here too."""
    reset = msg.get("reset_type")
    if reset not in POWER_ACTIONS:
        raise HelperError(f"Unsupported power action: {reset!r}")
    if str(msg.get("confirm") or "").strip() != str(msg.get("ip") or "").strip():
        raise HelperError("Power action not confirmed.")
    ip, info, rf = bmc_session(msg)
    _, system = first_system(rf)
    action = (system.get("Actions") or {}).get("#ComputerSystem.Reset") or {}
    target = action.get("target")
    if not target:
        raise HelperError("This BMC doesn't offer a Redfish power action. Use the BMC web page instead.")
    allowed = action.get("ResetType@Redfish.AllowableValues")
    if not allowed and action.get("@Redfish.ActionInfo"):
        params = (rf._try_get(action["@Redfish.ActionInfo"]) or {}).get("Parameters") or []
        allowed = next((p.get("AllowableValues") for p in params if p.get("Name") == "ResetType"), None)
    if allowed and reset not in allowed:
        raise HelperError(f"This BMC doesn't support {reset}. It allows: {', '.join(allowed)}.")
    rf.post(target, {"ResetType": reset})
    return {"ok": True, "ip": ip, "reset_type": reset, "before": system.get("PowerState") or "",
            "at": int(time.time() * 1000)}


def bmc_health(msg):
    start = time.time()
    ip, info, rf = bmc_session(msg)
    root, system = first_system(rf)
    result = {"ok": True, "ip": ip, "item": info, "warnings": []}
    health, rollup, _ = _status(system)
    result["system"] = {
        "power": system.get("PowerState") or "",
        "health": health or "",
        "rollup": rollup or "",
        "manufacturer": system.get("Manufacturer") or "",
        "model": system.get("Model") or "",
        "serial": system.get("SerialNumber") or "",
        "bios": system.get("BiosVersion") or "",
        "hostname": system.get("HostName") or "",
        "can_power": bool(((system.get("Actions") or {}).get("#ComputerSystem.Reset") or {}).get("target")),
    }
    managers = rf.members(rf._try_get(_link(root, "Managers")) or {}, 2) if _link(root, "Managers") else []
    manager = managers[0] if managers else {}
    result["manager"] = {"firmware": manager.get("FirmwareVersion") or "", "model": manager.get("Model") or ""}

    problems = []
    for name, fn in (("system", lambda: system_problems(rf, system)), ("chassis", lambda: chassis_problems(rf, root))):
        try:
            problems += fn()
        except HelperError as e:
            result["warnings"].append(f"{name}: {e}")
    result["problems"] = problems[:30]
    try:
        result["events"] = recent_events(rf, [manager, system])
    except HelperError as e:
        result["events"] = []
        result["warnings"].append(f"event log: {e}")
    result["took_s"] = round(time.time() - start, 1)
    result["at"] = int(time.time() * 1000)
    return result


def handle(msg):
    action = (msg or {}).get("action")
    if action == "hello":
        return {"ok": True, "version": VERSION, "platform": platform.system(), "python": platform.python_version(), "tls": ssl.OPENSSL_VERSION}
    if action == "ping":
        targets = msg.get("targets") or []
        if not isinstance(targets, list):
            return {"ok": False, "error": "targets must be a list"}
        targets = [t for t in targets if isinstance(t, dict)][:MAX_TARGETS]
        count = max(1, min(int(msg.get("count", 3) or 3), 5))
        with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, len(targets))) as pool:
            results = list(pool.map(lambda t: check_target(t, count), targets))
        return {"ok": True, "version": VERSION, "results": results, "at": int(time.time() * 1000)}
    handlers = {"bmc_copy_password": bmc_copy_password, "bmc_health": bmc_health, "bmc_power": bmc_power, "op_check": op_check}
    if action in handlers:
        try:
            return handlers[action](msg)
        except HelperError as e:
            return {"ok": False, "error": str(e)}
    return {"ok": False, "error": f"Unknown action: {action}"}


def main():
    try:
        msg = read_message()
        send_message(handle(msg))
    except Exception as e:  # never die silently — the extension shows this
        send_message({"ok": False, "error": f"{type(e).__name__}: {e}"})


if __name__ == "__main__":
    main()
