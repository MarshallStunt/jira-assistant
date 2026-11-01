#!/usr/bin/env python3
"""
DC Ops ping helper — Chrome native messaging host for the DC Ops Jira Assistant extension.

Chrome extensions cannot send ICMP pings, so the extension asks this helper to:
  - resolve each address (DNS),
  - ping it,
  - report which local network interface the traffic is routed through.
It also talks to the server's BMC with the login the user pasted in the panel:
  - reads the server's health from the BMC's Redfish API (GETs),
  - shuts down / powers on the server through Redfish, only when the user confirmed it in the panel.

Protocol: Chrome native messaging (4-byte native-endian length + UTF-8 JSON) on stdin/stdout.
Requests:
  {"action": "hello"}
  {"action": "ping", "targets": [{"address": "host-01", "role": "host"}, ...], "count": 3}
  {"action": "bmc_health", "ip": "10.1.2.3", "login": {"user": "ADMIN", "password": "..."}, "port": 443}
  {"action": "bmc_power", "ip": "10.1.2.3", "login": {...}, "reset_type": "GracefulShutdown" | "ForceOff" | "On", "confirm": "10.1.2.3"}
Only hostnames / IP addresses are accepted, BMC requests only go to private IPs, and commands are run
without a shell. Logins are used for the one request and never stored.
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

VERSION = "1.4.0"
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
    # Chrome starts the helper with a minimal PATH, so also look in the usual system folders.
    if IS_WIN:
        dirs = (os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32"),
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


# ---------- BMC login ----------

class HelperError(Exception):
    pass


def bmc_ip(value):
    try:
        ip = ipaddress.ip_address(str(value or "").strip())
    except ValueError:
        raise HelperError("BMC address must be an IP address.")
    if not (ip.is_private or ip.is_link_local) or ip.is_unspecified or ip.is_multicast:
        raise HelperError(f"{ip} is not a private address — BMC logins are only sent to private networks.")
    return str(ip)


# ---------- Redfish (BMC health and power) ----------

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
                # The manufacturer part number first: the extension looks it up in the parts catalog.
                p = _problem(label, m, (m.get("PartNumber") or m.get("Model") or "").strip())
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
    """Redfish client for msg["ip"], logged in with the login pasted in the panel (used for this request only)."""
    login = msg.get("login")
    if not isinstance(login, dict) or not login.get("password"):
        raise HelperError("Paste the BMC password in the panel first.")
    ip = bmc_ip(msg.get("ip"))
    user, password = str(login.get("user") or "")[:64], str(login["password"])[:256]
    port = int(msg.get("port") or 443)
    if not 0 < port < 65536:
        raise HelperError("Invalid Redfish port.")
    return ip, Redfish(ip, user, password, port)


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
    ip, rf = bmc_session(msg)
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
    ip, rf = bmc_session(msg)
    root, system = first_system(rf)
    result = {"ok": True, "ip": ip, "warnings": []}
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
    handlers = {"bmc_health": bmc_health, "bmc_power": bmc_power}
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
