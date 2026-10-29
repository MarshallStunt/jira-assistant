#!/usr/bin/env python3
"""
DC Ops ping helper — Chrome native messaging host for the DC Ops Jira Assistant extension.

Chrome extensions cannot send ICMP pings, so the extension asks this helper to:
  - resolve each address (DNS),
  - ping it,
  - report which local network interface the traffic is routed through.

Protocol: Chrome native messaging (4-byte native-endian length + UTF-8 JSON) on stdin/stdout.
Requests:
  {"action": "hello"}
  {"action": "ping", "targets": [{"address": "host-01", "role": "host"}, ...], "count": 3}
Only hostnames / IP addresses are accepted, and commands are run without a shell.
"""

import concurrent.futures
import ipaddress
import json
import os
import platform
import re
import shutil
import socket
import struct
import subprocess
import sys
import time

VERSION = "1.0.0"
MAX_TARGETS = 12
IS_MAC = sys.platform == "darwin"
HOST_RE = re.compile(r"^(?=.{1,253}$)[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,62})(?:\.[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,62}))*\.?$")
VPN_PREFIXES = ("utun", "ipsec", "ppp", "tun", "tap", "wg", "gpd", "zt", "tailscale", "cscotun", "vpn")


# ---------- native messaging framing ----------

def read_message():
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
    for d in ("/sbin", "/usr/sbin", "/bin", "/usr/bin"):
        p = os.path.join(d, name)
        if os.path.exists(p):
            return p
    return None


def run(cmd, timeout):
    try:
        p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                           stdin=subprocess.DEVNULL, timeout=timeout)
        return p.returncode, p.stdout.decode("utf-8", "replace")
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


def handle(msg):
    action = (msg or {}).get("action")
    if action == "hello":
        return {"ok": True, "version": VERSION, "platform": platform.system(), "python": platform.python_version()}
    if action == "ping":
        targets = msg.get("targets") or []
        if not isinstance(targets, list):
            return {"ok": False, "error": "targets must be a list"}
        targets = [t for t in targets if isinstance(t, dict)][:MAX_TARGETS]
        count = max(1, min(int(msg.get("count", 3) or 3), 5))
        with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, len(targets))) as pool:
            results = list(pool.map(lambda t: check_target(t, count), targets))
        return {"ok": True, "version": VERSION, "results": results, "at": int(time.time() * 1000)}
    return {"ok": False, "error": f"Unknown action: {action}"}


def main():
    try:
        msg = read_message()
        send_message(handle(msg))
    except Exception as e:  # never die silently — the extension shows this
        send_message({"ok": False, "error": f"{type(e).__name__}: {e}"})


if __name__ == "__main__":
    main()
