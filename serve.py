#!/usr/bin/env python3
"""NetFRAME dashboard — serve + live-data proxy (Phase 2).

Serves the static dashboard AND exposes ONE endpoint, /api/state, that the page
polls. A background thread refreshes an in-memory snapshot every REFRESH seconds
and serves the last-good copy if a source hiccups, so the wall never blanks.

Live sources wired in this phase (Phase-2 step 1 — the backbone):
  * Prometheus  (ssh pve4 -> pct exec 103 -> localhost:9090)
        node CPU / RAM / disk, per-node up, UPS load+charge+runtime, Pi-hole up/down
  * netframe-monitor last_run.json (ssh jarvis, world-readable, no sudo)
        integrity strip, service/guest liveness, GPU temps/util/VRAM, SMART summary

Still mock on the page (wired in later steps, each its own source):
  SLURM (squeue @ quarkylab) · RKE2 (kube API) · OPNsense dual-WAN (API)
  · Pi-hole blocked%/queries (v6 API session token) · storage capacity detail

Dependency-free: Python 3 stdlib only. Runs on Ares today; same file runs on the Pi.
  Run:  python3 serve.py [port]     (default 8088)   ->  http://localhost:8088
"""
import json, os, sys, time, threading, urllib.parse, urllib.request, urllib.error, ssl, base64, subprocess
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE   = os.path.dirname(os.path.abspath(__file__))
HTML   = os.path.join(HERE, "netframe-dashboard.html")
PORT   = int(sys.argv[1]) if len(sys.argv) > 1 else 8088
REFRESH = 30.0
SSH    = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8",
          # multiplex: all concurrent queries to a host reuse ONE connection
          # (otherwise 16 parallel ssh can exceed sshd MaxStartups and silently drop)
          "-o", "ControlMaster=auto", "-o", "ControlPath=/tmp/nfm-cm-%r@%h:%p", "-o", "ControlPersist=60s"]
KCFG    = os.path.expanduser("~/.kube/config-rke2")     # cluster-admin kubeconfig (read-only use)
KUBECTL = os.path.expanduser("~/.local/bin/kubectl")
# SLURM user -> dashboard accent (kyle=cyan, fernanda=violet; everyone else neutral)
USER_COLOR = {"kyle": "cyan", "masonkr": "cyan", "root": "cyan", "fernanda": "violet"}

# credentials for Pi-hole/OPNsense live in a 600-mode env file, read once at startup
def load_env(path="~/.config/netframe-dashboard.env"):
    env = {}
    try:
        for line in open(os.path.expanduser(path)):
            line = line.rstrip("\n")
            if not line.strip() or line.lstrip().startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1); k = k.strip(); v = v.strip()
            if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
                v = v[1:-1]
            env[k] = v
    except FileNotFoundError:
        pass
    return env
ENV = load_env()
_SSL = ssl.create_default_context(); _SSL.check_hostname = False; _SSL.verify_mode = ssl.CERT_NONE

# prometheus node-exporter instance label (lowercase host) -> dashboard card host
HOSTS = {"quarkylab": "QuarkyLab", "jarvis": "Jarvis", "randy": "Randy",
         "pve2": "pve2", "pve3": "pve3", "pve4": "pve4", "pve5": "pve5", "pve1": "pve1"}

# ---------------------------------------------------------------- shell helpers
def sh(cmd, timeout=25, input=None):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, input=input)
        return r.stdout if r.returncode == 0 else ""
    except Exception:
        return ""

def prom(query):
    """Run one instant PromQL query via the pve4 nfm-prom wrapper (query on stdin)."""
    out = sh(SSH + ["pve4", "nfm-prom"], input=query)
    try:
        return json.loads(out)["data"]["result"]
    except Exception:
        return []

def prom_by(query, label="instance"):
    """{label_value: float(value)} for an instant query."""
    out = {}
    for m in prom(query):
        try:
            out[m["metric"].get(label)] = float(m["value"][1])
        except Exception:
            pass
    return out

def prom_series(query):
    """[(labels_dict, float_value), ...] for an instant query (keeps every label)."""
    out = []
    for m in prom(query):
        try:
            out.append((m["metric"], float(m["value"][1])))
        except Exception:
            pass
    return out

def prom_scalar(query):
    """Single float from an instant query (first result), or None."""
    r = prom(query)
    try:
        return float(r[0]["value"][1])
    except Exception:
        return None

def switch():
    """EX3400 port/link/throughput from the snmp-exporter (via Prometheus)."""
    phys = 'ifOperStatus{job="snmp-ex3400",ifName=~"(ge|xe|et)-[0-9]+/[0-9]+/[0-9]+"}'
    up = prom_scalar('count(%s == 1)' % phys)
    if up is None:
        return None
    tot = prom_scalar('count(%s)' % phys)
    ten = prom_scalar('count(ifOperStatus{job="snmp-ex3400",ifName=~"xe-[0-9]+/[0-9]+/[0-9]+"} == 1)')
    inm = prom_scalar('sum(rate(ifHCInOctets{job="snmp-ex3400",ifName=~"(ge|xe|et)-[0-9]+/[0-9]+/[0-9]+"}[2m]))*8/1e6')
    outm = prom_scalar('sum(rate(ifHCOutOctets{job="snmp-ex3400",ifName=~"(ge|xe|et)-[0-9]+/[0-9]+/[0-9]+"}[2m]))*8/1e6')
    return {"up": int(up), "ports": int(tot or 0), "tenG": int(ten or 0),
            "in_mbps": round(inm, 1) if inm else 0, "out_mbps": round(outm, 1) if outm else 0}

def monitor():
    out = sh(SSH + ["jarvis", "cat /opt/netframe-monitor/last_run.json"])
    try:
        return json.loads(out)
    except Exception:
        return {}

# ---------------------------------------------------------------- monitor parse
def _chk(M, node, check):
    return (M.get("nodes", {}).get(node, {}) or {}).get(check, {}) or {}

def _v(M, node, check):
    return _chk(M, node, check).get("verdict", "UNKNOWN")

def _m(M, node, check):
    return _chk(M, node, check).get("metrics", {}) or {}

def _s(verdict):
    return "g" if verdict in ("OK", "SKIPPED") else ("y" if verdict == "WARN" else "r")

def integrity(M):
    if not M.get("nodes"):
        return None
    nodes = M["nodes"]
    # aggregate journal signals across every host that ran the check
    # INV-020: dict.get(key, default) does NOT protect against a null VALUE - guard every coercion
    err = sum((_m(M, n, "journal_errors").get("error_lines") or 0) for n in nodes if "journal_errors" in nodes[n])
    authf = sum((_m(M, n, "journal_errors").get("auth_failures") or 0) for n in nodes if "journal_errors" in nodes[n])
    jv = "WARN" if any(_v(M, n, "journal_errors") == "WARN" for n in nodes if "journal_errors" in nodes[n]) else "OK"
    # SMART: worst pending sectors + any failed
    pend = max([(_m(M, n, "smart").get("worst_pending_sectors") or 0) for n in nodes if "smart" in nodes[n]] or [0])
    failed = any(_m(M, n, "smart").get("failed") for n in nodes if "smart" in nodes[n])
    sv = "r" if failed else ("y" if pend else "g")
    bk = _chk(M, "randy", "backup_verify"); bm = bk.get("metrics", {})
    hd = _chk(M, "randy", "hardening_drift"); hm = hd.get("metrics", {})
    npm = _m(M, "pve3", "npm_dns")
    flow = _m(M, "monitoring", "net_syslog_flow").get("count") or 0   # INV-020: null count -> 0, never int(None)
    pa = _v(M, "monitoring", "page_auth"); ca = _v(M, "monitoring", "console_auth")
    exposure = "g" if pa == "OK" and ca == "OK" else "y"
    return [
        {"k": "Backup Verify",  "v": (bm.get("overall", "?").upper() or "?"), "s": _s(bk.get("verdict"))},
        {"k": "Hardening Drift","v": ("DRIFT" if hm.get("any_drift") else "NONE") + (" · STALE" if hm.get("stale") else ""), "s": _s(hd.get("verdict"))},
        {"k": "Exposure Guard", "v": "401 ENFORCED" if exposure == "g" else "CHECK", "s": exposure},
        {"k": "Journal Errors", "v": str(int(err)), "s": _s(jv)},
        {"k": "Auth Failures",  "v": str(int(authf)), "s": "g" if authf == 0 else "r"},
        {"k": "LLM Router",     "v": "CONFORMANT" if _v(M, "jarvis", "llm_router_conformance") == "OK" else "CHECK", "s": _s(_v(M, "jarvis", "llm_router_conformance"))},
        {"k": "NPM DNS",        "v": "%d MISSING" % npm.get("missing_count", 0), "s": "g" if npm.get("missing_count", 0) == 0 else "y"},
        {"k": "Net Dead-man",   "v": "FLOW %d" % int(flow), "s": _s(_v(M, "monitoring", "net_syslog_flow"))},
        {"k": "SMART Trend",    "v": ("STABLE" if not pend and not failed else ("%d PENDING" % pend if pend else "FAIL")), "s": sv},
        {"k": "Wazuh SIEM",     "v": "CORE OK" if _v(M, "wazuh", "wazuh") == "OK" else "CHECK", "s": _s(_v(M, "wazuh", "wazuh"))},
    ]

def all_guests(M):
    g = {}
    for n, checks in M.get("nodes", {}).items():
        gm = (checks.get("guests", {}) or {}).get("metrics", {}) or {}
        g.update(gm.get("guests", {}) or {})
    return g

def services(M):
    if not M.get("nodes"):
        return None
    g = all_guests(M)
    def gs(name):            # guest running -> g, present-not-running -> r, absent -> None
        return "g" if g.get(name) == "running" else ("r" if name in g else None)
    def probe(node, check):  # monitoring probe verdict -> status
        v = _v(M, node, check)
        return _s(v) if v != "UNKNOWN" else None
    spec = [
        ("Proxmox Backup", "Randy:8007",  probe("randy", "pbs")),
        ("OPNsense",       "VM100·pve2",  None),
        ("Pi-hole (pri)",  "pve1·.177",   probe("monitoring", "pihole")),
        ("Pi-hole (sec)",  "pve5·.178",   gs("netframe-pihole2")),
        ("Grafana",        "CT103·pve4",  probe("monitoring", "grafana")),
        ("Wazuh SIEM",     "VM104·.184",  probe("wazuh", "wazuh")),
        ("Headscale",      "pve5·.186",   gs("headscale")),
        ("Vaultwarden",    "CT102·pve3",  gs("vaultwarden")),
        ("Ollama · Qwen72B","Jarvis·GPU", probe("monitoring", "llm_router")),
        ("Open WebUI",     "CT107·.185",  probe("monitoring", "openwebui_reach") or gs("openwebui")),
        ("Jellyfin",       "Randy:8096",  None),
        ("Home Assistant", "VM110·pve5",  gs("homeassistant")),
    ]
    return [{"n": n, "h": h, "s": s or "g"} for (n, h, s) in spec]

def slurm():
    """running/pending jobs + partitions from QuarkyLab via the nfm-slurm wrapper."""
    out = sh(SSH + ["quarkylab", "nfm-slurm"])
    if "===SQUEUE===" not in out:      # controller unreachable -> keep prior (mock/last)
        return None
    info, q = out.split("===SQUEUE===", 1)
    info = info.replace("===SINFO===", "")
    running, pending = [], []
    for line in q.splitlines():
        p = line.split("|")
        if len(p) < 7:
            continue
        jid, usr, name, gres, tm, state, reason = p[:7]
        c = USER_COLOR.get(usr.lower(), "dim")
        if state == "RUNNING":
            gpu = gres.replace("gres:", "").replace("gpu:", "").strip() or "—"
            running.append({"id": jid, "u": usr, "c": c, "name": name, "gpu": gpu, "el": tm})
        else:
            pending.append({"id": jid, "u": usr, "name": name, "rs": reason})
    parts = [ln.split("|")[0] for ln in info.splitlines() if ln.split("|")[0]]
    return {"running": running, "pending": pending,
            "partitions": " · ".join(dict.fromkeys(parts)) or "student* · research",
            "node": "QuarkyLab"}

def k8s():
    """RKE2 node/pod counts. Prefers a read-only token API (K8S_API/K8S_TOKEN, e.g. on the
       Pi); falls back to the local admin kubeconfig via kubectl (Ares)."""
    api, tok = ENV.get("K8S_API"), ENV.get("K8S_TOKEN")
    if api and tok:
        hdr = {"Authorization": "Bearer " + tok}
        def g(path):
            try:
                return json.load(urllib.request.urlopen(
                    urllib.request.Request(api + path, headers=hdr), timeout=10, context=_SSL))
            except Exception:
                return None
        nd = g("/api/v1/nodes")
        if nd is None:
            return None
        nodes = nd.get("items", [])
        pd = g("/api/v1/pods")
        pods = pd.get("items", []) if pd else None
    else:
        env = dict(os.environ, KUBECONFIG=KCFG)
        def kget(*args):
            try:
                r = subprocess.run([KUBECTL, *args], capture_output=True, text=True, timeout=15, env=env)
                return json.loads(r.stdout) if r.returncode == 0 else None
            except Exception:
                return None
        nd = kget("get", "nodes", "-o", "json")
        if nd is None:
            return None
        nodes = nd.get("items", [])
        pd = kget("get", "pods", "-A", "-o", "json")
        pods = pd.get("items", []) if pd else None
    ready = sum(1 for n in nodes
                for c in n.get("status", {}).get("conditions", [])
                if c.get("type") == "Ready" and c.get("status") == "True")
    out = {"nodes": len(nodes), "ready": ready}
    gpus = sum(int(n.get("status", {}).get("allocatable", {}).get("nvidia.com/gpu", 0) or 0) for n in nodes)
    out["gpuop"] = ("ACTIVE · %d GPU" % gpus) if gpus else "DEFERRED"
    if pods is not None:
        out["pods"] = sum(1 for p in pods if p.get("status", {}).get("phase") == "Running")
        out["podsTotal"] = len(pods)
    return out

GPU_CARD = {"quarkylab": "Quadro RTX 8000", "jarvis": "2× Quadro RTX 6000"}
GPU_DISP = {"quarkylab": "QuarkyLab", "jarvis": "Jarvis"}

def assemble_gpus(temp, util, mu, mt, pw):
    """Build per-host GPU objects from the nvidia_gpu_exporter series (adds real watts)."""
    if not temp:
        return None
    from collections import defaultdict
    T, U = defaultdict(list), defaultdict(list)
    MU, MT, P = defaultdict(float), defaultdict(float), defaultdict(float)
    for lab, v in temp: T[lab.get("instance")].append(v)
    for lab, v in (util or []): U[lab.get("instance")].append(v)
    for lab, v in (mu or []): MU[lab.get("instance")] += v
    for lab, v in (mt or []): MT[lab.get("instance")] += v
    for lab, v in (pw or []): P[lab.get("instance")] += v
    out = []
    for inst in sorted(T):
        out.append({
            "host": GPU_DISP.get(inst, inst),
            "card": GPU_CARD.get(inst, "GPU"),
            "temps": [round(x) for x in T[inst]],
            "util": round(sum(U[inst]) / len(U[inst]) * 100) if U[inst] else 0,
            "vramU": round(MU[inst] / 1048576),
            "vram":  round(MT[inst] / 1048576),
            "watts": round(P[inst], 1),
        })
    return out

def gpus_from_monitor(M):
    out = []
    for host, card in (("quarkylab", "Quadro RTX 8000"), ("jarvis", "2× Quadro RTX 6000")):
        cards = _m(M, host, "gpu").get("gpus")
        if not cards:
            continue
        temps = [c.get("temp_c") for c in cards]
        vramU = sum(c.get("mem_used_mib", 0) for c in cards)
        vram  = sum(c.get("mem_total_mib", 0) for c in cards)
        util  = round(sum(c.get("util_pct", 0) for c in cards) / len(cards))
        out.append({"host": HOSTS.get(host, host), "card": card,
                    "temps": temps, "util": util, "vramU": vramU, "vram": vram})
    return out

# ---------------------------------------------------------------- build snapshot
# ---------------------------------------------------------------- Pi-hole (v6 API)
_PH = {"sid": None, "prev": None, "prevts": None}
def pihole_stats():
    host, pw = ENV.get("PIHOLE_HOST"), ENV.get("PIHOLE_PASSWORD")
    if not host or not pw:
        return None
    def summary(sid):
        return json.load(urllib.request.urlopen(
            urllib.request.Request(f"http://{host}/api/stats/summary", headers={"X-FTL-SID": sid}), timeout=8))
    s = None
    if _PH["sid"]:
        try: s = summary(_PH["sid"])           # reuse session
        except Exception: _PH["sid"] = None
    if s is None:                              # (re)authenticate
        try:
            d = json.load(urllib.request.urlopen(urllib.request.Request(
                f"http://{host}/api/auth", data=json.dumps({"password": pw}).encode(),
                headers={"Content-Type": "application/json"}, method="POST"), timeout=8))
        except Exception:
            return None
        if not d.get("session", {}).get("valid"):
            return None
        _PH["sid"] = d["session"]["sid"]
        try: s = summary(_PH["sid"])
        except Exception: return None
    q = s.get("queries", {})
    total = q.get("total", 0)
    qpm = None
    if _PH["prev"] is not None and _PH["prevts"]:
        dt = time.time() - _PH["prevts"]
        if dt > 0:
            qpm = round(max(0, total - _PH["prev"]) / dt * 60)
    _PH["prev"], _PH["prevts"] = total, time.time()
    out = {"blocked": round(q.get("percent_blocked", 0), 1), "total": total}
    if qpm is not None:
        out["qpm"] = qpm
    return out

# ---------------------------------------------------------------- OPNsense (API)
_OPN = {"prev": {}}   # wanKey -> (bytes_rx, bytes_tx, ts) for throughput rate
def opnsense_stats():
    host, key, sec = ENV.get("OPNSENSE_HOST"), ENV.get("OPNSENSE_KEY"), ENV.get("OPNSENSE_SECRET")
    if not (host and key and sec):
        return None
    auth = {"Authorization": "Basic " + base64.b64encode(f"{key}:{sec}".encode()).decode()}
    def G(ep):
        return json.load(urllib.request.urlopen(
            urllib.request.Request(f"https://{host}/api/{ep}", headers=auth), timeout=10, context=_SSL))
    try:
        ov = G("interfaces/overview/export")
    except Exception:
        return None
    now = time.time()
    idmap = {"wan": "wan1", "opt7": "wan2"}   # WAN1 = Spectrum (vtnet0), WAN2 = FirstNet 5G (vtnet2)
    out = {}
    for i in ov:
        wk = idmap.get(i.get("identifier"))
        if not wk:
            continue
        stt = i.get("statistics", {}) or {}
        rx = float(stt.get("bytes received", 0) or 0)
        tx = float(stt.get("bytes transmitted", 0) or 0)
        down = up = 0.0
        prev = _OPN["prev"].get(wk)
        if prev:
            dt = now - prev[2]
            if dt > 0:
                down = max(0, rx - prev[0]) * 8 / dt   # bits/sec
                up = max(0, tx - prev[1]) * 8 / dt
        _OPN["prev"][wk] = (rx, tx, now)
        out[wk] = {"state": "UP" if i.get("status") == "up" else "DOWN",
                   "down_bps": round(down), "up_bps": round(up),
                   "ip": (i.get("addr4") or "").split("/")[0]}
    try:
        out["states"] = int(G("diagnostics/firewall/pf_states").get("current", 0))
    except Exception:
        pass
    try:   # needs the "Status: Gateways" privilege; offline gateways return "~" fields
        def numish(s):
            try: return round(float(str(s).replace("ms", "").replace("%", "").strip()), 1)
            except Exception: return None
        for g in G("routes/gateway/status").get("items", []):
            wk = "wan2" if "2" in (g.get("name") or "") else "wan1"
            if wk not in out:
                continue
            out[wk]["gw"] = g.get("status_translated") or g.get("status")   # Online / Offline
            out[wk]["lat"] = numish(g.get("delay"))
            out[wk]["loss"] = numish(g.get("loss"))
    except Exception:
        pass
    return out or None

class _NoData(Exception):
    """Raised by a section that ran cleanly but has no data this cycle (MISSING/STALE, not ERROR)."""

def build_state(prev=None):
    """Assemble ONE snapshot. Read-only. P1 per-source isolation: the timestamp is stamped up front
    and the snapshot is ALWAYS returned, so the wall can NEVER freeze while claiming LIVE. Each source
    is assembled in its own boundary - one source failing degrades only its own panel. A programmer/
    parse error surfaces LOUDLY as ERROR (never silently shown as stale). Global mode is DERIVED from
    panel freshness, never hardcoded. Per-panel state/age/provenance lives in st['panels']; the legacy
    st['sources'] booleans are preserved for the existing HTML contract."""
    now = time.time()
    prev = prev or {}
    st = {"ts": now, "sources": {}, "panels": {}, "nodes": {}}

    prev_panels = prev.get("panels") or {}

    def mark(name, ok, state, age=None, error=None, fresh_at=None):
        st["sources"][name] = bool(ok)                       # backward-compatible boolean (HTML contract)
        st["panels"][name] = {"state": state, "age": age, "error": error, "src": name,
                              "observed_at": round(now), "fresh_at": fresh_at}

    def carry(name, keys, reason, error=False):
        got = False
        for k in keys:
            pv = prev.get(k)
            if pv not in (None, {}, []):
                st[k] = pv; got = True
        # TD-147: age carried data from when it was LAST FRESH, not from the previous snapshot.
        # prev is republished with a new ts every cycle, so aging against prev["ts"] re-aged
        # carried data to one refresh interval forever - 12-day-old data reported ~30s.
        fa = (prev_panels.get(name) or {}).get("fresh_at")
        fa = fa if isinstance(fa, (int, float)) else None
        # No original observation time -> age is UNKNOWN (None). Never report stale data as young.
        age = round(now - fa) if (got and fa is not None) else None
        mark(name, got, ("ERROR" if error else ("STALE" if got else "MISSING")), age, reason, fa)

    def section(name, keys, assemble, has_data):
        """Isolated assembly: FRESH on data; STALE (carry last-good) or MISSING when absent;
        ERROR (loud) when the assembly raises. Never fatal - the snapshot always completes."""
        try:
            assemble()
            if has_data():
                mark(name, True, "FRESH", 0, None, now)
            else:
                carry(name, keys, "no data this cycle")
        except _NoData:
            carry(name, keys, "no data this cycle")
        except Exception as e:
            print("[netframe] PANEL ERROR %s: %s" % (name, e), flush=True)
            carry(name, keys, str(e), error=True)

    # prime one SSH master per host so the parallel pool multiplexes over a single
    # socket each (cheap once warm; ControlPersist keeps them alive between refreshes)
    for host in ("pve4", "jarvis", "quarkylab"):
        try: sh(SSH + [host, "true"], timeout=10)
        except Exception: pass

    # fire every independent source concurrently — turns ~15s of serial SSH into ~5s
    tasks = {
        "cpu":  lambda: prom_by('100 - (avg by(instance)(rate(node_cpu_seconds_total{mode="idle"}[2m]))*100)'),
        "ramU": lambda: prom_by('(1 - node_memory_MemAvailable_bytes/node_memory_MemTotal_bytes)*100'),
        "disk": lambda: prom_by('(1 - node_filesystem_avail_bytes{mountpoint="/"}/node_filesystem_size_bytes{mountpoint="/"})*100'),
        "up":   lambda: prom_by('up{job="proxmox-nodes"}'),
        "load": lambda: prom_by('ups_ups_load', "ups"),
        "batt": lambda: prom_by('ups_battery_charge', "ups"),
        "rt":   lambda: prom_by('ups_battery_runtime', "ups"),
        "ph":   lambda: prom_by('up{job="pihole-dns"}', "pihole"),
        "M":    monitor,
        "slurm": slurm,
        "k8s":  k8s,
        "g_temp": lambda: prom_series('nvidia_smi_temperature_gpu'),
        "g_util": lambda: prom_series('nvidia_smi_utilization_gpu_ratio'),
        "g_mu":   lambda: prom_series('nvidia_smi_memory_used_bytes'),
        "g_mt":   lambda: prom_series('nvidia_smi_memory_total_bytes'),
        "g_pw":   lambda: prom_series('nvidia_smi_power_draw_watts'),
        "phs":  pihole_stats,
        "opn":  opnsense_stats,
        "sw":   switch,
    }
    R = {}
    with ThreadPoolExecutor(max_workers=len(tasks)) as ex:
        futs = {k: ex.submit(fn) for k, fn in tasks.items()}
        for k, f in futs.items():
            try:
                R[k] = f.result(timeout=30)
            except Exception:
                R[k] = None

    # ---- nodes (Prometheus) ----
    def _nodes():
        cpu, ramU, disk, up = R["cpu"] or {}, R["ramU"] or {}, R["disk"] or {}, R["up"] or {}
        if not up:
            raise _NoData()
        nodes = {}
        for inst, card in HOSTS.items():
            n = {}
            if inst in cpu:  n["cpu"] = round(cpu[inst], 1)
            if inst in ramU: n["ramU"] = round(ramU[inst], 1)
            if inst in disk: n["disk"] = round(disk[inst], 1)
            if inst in up:   n["st"] = "g" if up[inst] >= 1 else "r"
            if n:
                nodes[card] = n
        st["nodes"] = nodes
    section("prometheus", ["nodes"], _nodes, lambda: bool(st.get("nodes")))

    # ---- UPS (peanut-ups): load %, battery %, runtime sec -> min ----
    def _ups():
        load, batt, rt = R["load"] or {}, R["batt"] or {}, R["rt"] or {}
        ups = {}
        for key in ("midatlantic", "tripplite"):
            u = {}
            if key in load: u["load"] = round(load[key], 1)
            if key in batt: u["batt"] = round(batt[key], 1)
            if key in rt:   u["runtime"] = round(rt[key] / 60.0)
            if u:
                ups[key] = u
        if ups:
            st["ups"] = ups
    section("ups", ["ups"], _ups, lambda: bool(st.get("ups")))

    # ---- Pi-hole up/down (Prometheus) ----
    def _ph():
        ph = R["ph"] or {}
        if ph:
            st["pihole"] = {k: int(v) for k, v in ph.items()}
    section("pihole", ["pihole"], _ph, lambda: bool(st.get("pihole")))

    # ---- monitor last_run.json (integrity, services, GPU) ----
    def _monitor():
        M = R["M"] or {}
        if not M.get("nodes"):
            raise _NoData()
        ig, svv = integrity(M), services(M)
        gm = assemble_gpus(R.get("g_temp"), R.get("g_util"), R.get("g_mu"), R.get("g_mt"), R.get("g_pw"))
        st["_gpu_live"] = bool(gm)
        if not gm:
            gm = gpus_from_monitor(M)
        if ig: st["integrity"] = ig
        if svv: st["services"] = svv
        if gm:
            st["gpus"] = gm
            for g in gm:
                st["nodes"].setdefault(g["host"], {})["gpu"] = {
                    "temps": g["temps"], "util": g["util"],
                    "vramU": round(g["vramU"] / 1024, 1), "vram": round(g["vram"] / 1024)}
    section("monitor", ["integrity", "services", "gpus"], _monitor, lambda: bool(st.get("integrity")))
    # GPU panel provenance: FRESH only when the live exporter fed it
    _gl = st.pop("_gpu_live", False)
    _gfa = (prev_panels.get("gpu") or {}).get("fresh_at")
    _gfa = _gfa if isinstance(_gfa, (int, float)) else None
    mark("gpu", bool(_gl), "FRESH" if _gl else ("STALE" if st.get("gpus") else "MISSING"),
         0 if _gl else (round(now - _gfa) if (_gfa is not None and st.get("gpus")) else None),
         None if _gl else "monitor nvidia-smi fallback", now if _gl else _gfa)

    # ---- SLURM / RKE2 / Pi-hole API / OPNsense / switch ----
    section("slurm",      ["slurm"],        lambda: st.update({"slurm": R["slurm"]}) if R.get("slurm") else None,   lambda: bool(st.get("slurm")))
    section("k8s",        ["k8s"],          lambda: st.update({"k8s": R["k8s"]}) if R.get("k8s") else None,         lambda: bool(st.get("k8s")))
    section("pihole_api", ["pihole_stats"], lambda: st.update({"pihole_stats": R["phs"]}) if R.get("phs") else None, lambda: bool(st.get("pihole_stats")))
    section("opnsense",   ["opnsense"],     lambda: st.update({"opnsense": R["opn"]}) if R.get("opn") else None,    lambda: bool(st.get("opnsense")))
    section("switch",     ["network"],      lambda: st.update({"network": R["sw"]}) if R.get("sw") else None,       lambda: bool(st.get("network")))

    # ---- derived global state (INV-001/002: never hardcode LIVE; mode reflects real freshness) ----
    states = [p["state"] for p in st["panels"].values()]
    st["ok"] = bool(st["sources"].get("prometheus") or st["sources"].get("monitor"))
    if states and all(s == "FRESH" for s in states):
        st["mode"] = "LIVE"
    elif any(s == "FRESH" for s in states):
        st["mode"] = "DEGRADED"
    else:
        st["mode"] = "STALE"
    st["has_error"] = any(p["state"] == "ERROR" for p in st["panels"].values())
    return st

# ---------------------------------------------------------------- background refresh
STATE = {"ts": 0, "mode": "MOCK", "ok": False, "sources": {}, "panels": {}}
LOCK = threading.Lock()

def refresher():
    """P1: the snapshot is published UNCONDITIONALLY every cycle, so ts ALWAYS advances. Even a
    framework-level failure publishes an error snapshot with a fresh ts - the wall can never freeze
    while claiming LIVE."""
    global STATE
    while True:
        t = time.time()
        try:
            with LOCK:
                prev = STATE
            s = build_state(prev)
        except Exception as e:
            print("[netframe] BUILD ERROR: %s — publishing error snapshot (ts still advances)" % e, flush=True)
            s = {**STATE, "ts": time.time(), "mode": "ERROR", "err": str(e), "has_error": True}
        with LOCK:
            STATE = s
        on = [k for k, v in s.get("sources", {}).items() if v]
        print("[netframe] refreshed in %.1fs | mode=%s | up: %s" % (time.time() - t, s.get("mode"), ",".join(on)), flush=True)
        time.sleep(REFRESH)

# ---------------------------------------------------------------- http
class H(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path in ("/", "/index.html", "/netframe-dashboard.html"):
            try:
                with open(HTML, "rb") as f:
                    body = f.read()
                self._send(200, b"<!doctype html><meta charset=utf-8>" + body, "text/html; charset=utf-8")
            except Exception as e:
                self._send(500, str(e).encode(), "text/plain")
        elif path == "/api/state":
            with LOCK:
                body = json.dumps(STATE).encode()
            self._send(200, body, "application/json")
        elif path == "/healthz":
            self._send(200, b"ok", "text/plain")
        else:
            self._send(404, b"not found", "text/plain")

    def log_message(self, *a):   # quiet
        pass

if __name__ == "__main__":
    print("[netframe] priming first snapshot ...", flush=True)
    STATE = build_state()
    print("[netframe] sources:", STATE.get("sources"), "| nodes:", len(STATE.get("nodes", {})), flush=True)
    threading.Thread(target=refresher, daemon=True).start()
    print("[netframe] serving  http://0.0.0.0:%d   (Ctrl-C to stop)" % PORT, flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), H).serve_forever()
