#!/usr/bin/env python3
"""P13 offline fixtures - NO production access. Application rows (OPNsense, Headscale, Home Assistant,
Jellyfin) must say what the APPLICATION is doing, never what its host is doing.

Defect this pins (measured 2026-10-09, netframe-evidence/service-coverage-2026-10-09/P1-discovery.md):
OPNsense and Jellyfin were hard-coded None, and Headscale and Home Assistant were green whenever their
Proxmox guest was `running`, which would stay green while the application is dead.

Inputs are prom_series()-shaped rows for serve.SVC_QUERY. The label-less row is the `vector(1)`
SENTINEL: present means the query ran. Every prom()/ssh call is stubbed; nothing leaves this process."""
import importlib.util, itertools, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("serve", os.path.join(HERE, "..", "serve.py"))
S = importlib.util.module_from_spec(spec); spec.loader.exec_module(S)
S.sh = lambda *a, **k: ""          # no SSH, ever

fails = []
def chk(n, c): print(("PASS  " if c else "FAIL  ") + n); (fails.append(n) if not c else None)

NOW = 2_000_000_000.0
SENT = ({}, 1.0)

def probe(job, svc, up=1, ps=1, cert=None, **extra):
    """Rows for one blackbox target: up, and probe_success when the scrape produced one."""
    base = dict({"job": job, "service": svc, "instance": "%s-%s" % (job, svc)}, **extra)
    rows = [(dict(base, __name__="up"), float(up))]
    if ps is not None:
        rows.append((dict(base, __name__="probe_success"), float(ps)))
    if cert is not None:
        rows.append((dict(base, __name__="probe_ssl_earliest_cert_expiry"), float(cert)))
    return rows

def healthy(svc):
    rows = probe("svc-tcp", svc) + probe("svc-app", svc) + probe("svc-icmp", svc)
    if svc in ("homeassistant", "jellyfin"):
        rows += probe("svc-health", svc)
    if svc == "opnsense":
        rows = probe("svc-tcp", svc) + probe("svc-app", svc, cert=NOW + 86400 * 60) + probe("svc-icmp", svc)
    if svc == "homeassistant":
        rows += probe("svc-dns", svc, resolver="pihole1") + probe("svc-dns", svc, resolver="pihole2")
    return rows

ALL = ("opnsense", "headscale", "homeassistant", "jellyfin")
CANARY = probe("svc-icmp", "canary")

def H(rows, **kw):
    return S.service_health(rows, NOW, **kw)

# ---- 1. healthy application ---------------------------------------------------------------------
h = H([SENT] + CANARY + sum((healthy(s) for s in ALL), []))
for s in ALL:
    chk("1: healthy %s -> NOMINAL" % s, h[s]["s"] == "g")
chk("1: the query is the single sentinel-guarded selector",
    S.SVC_QUERY == '{__name__=~"up|probe_success|probe_ssl_earliest_cert_expiry",job=~"svc-.+"} or vector(1)')

# ---- 2. host reachable (icmp ok) but app down -> CRITICAL ---------------------------------------
h = H([SENT] + CANARY + probe("svc-icmp", "jellyfin") + probe("svc-tcp", "jellyfin")
      + probe("svc-app", "jellyfin", ps=0) + probe("svc-health", "jellyfin", ps=0))
chk("2: icmp ok + app probe failing -> CRITICAL", h["jellyfin"]["s"] == "r")
chk("2: ... and says the host still answers", "app probe failing" in h["jellyfin"]["d"] and "ICMP" in h["jellyfin"]["d"])
h = H([SENT] + probe("svc-tcp", "headscale", ps=0) + probe("svc-app", "headscale", ps=0))
chk("2: tcp refused -> CRITICAL", h["headscale"]["s"] == "r" and "tcp" in h["headscale"]["d"])

# ---- 3. app reachable but series stale/missing -> UNKNOWN ---------------------------------------
h = H([SENT] + probe("svc-tcp", "headscale"))          # app series gone (Prometheus staleness drops it)
chk("3: tcp ok, app series missing -> UNKNOWN", h["headscale"]["s"] == "u" and "app not measured" in h["headscale"]["d"])
h = H([SENT] + probe("svc-tcp", "jellyfin") + probe("svc-app", "jellyfin"))
chk("3: app up, required health missing -> UNKNOWN with the reason",
    h["jellyfin"]["s"] == "u" and h["jellyfin"]["d"] == "app up, health not measured")
h = H([SENT] + probe("svc-tcp", "jellyfin") + probe("svc-app", "jellyfin", ps=None) + probe("svc-health", "jellyfin"))
chk("3: up==1 but no probe_success -> UNKNOWN", h["jellyfin"]["s"] == "u" and "no probe result" in h["jellyfin"]["d"])

# ---- 4. probe collection failure (sentinel absent) -> UNKNOWN for all ---------------------------
for rows, what in (([], "empty result"), (sum((healthy(s) for s in ALL), []), "series without the sentinel")):
    h = H(rows)
    chk("4: %s -> every row UNKNOWN" % what, all(h[s]["s"] == "u" for s in ALL))
    chk("4: %s -> reason is collection failure" % what, all(h[s]["d"] == "probe collection failed" for s in ALL))
h = H([], api_fresh=True)
chk("4: collection failed but the OPNsense API is fresh -> OPNsense NOMINAL via API",
    h["opnsense"]["s"] == "g" and "API" in h["opnsense"]["d"] and h["opnsense"]["src"] == "opnsense")
chk("4: ... and only OPNsense", all(h[s]["s"] == "u" for s in ALL if s != "opnsense"))

# ---- 5. missing measurement -> UNKNOWN ----------------------------------------------------------
h = H([SENT])
chk("5: sentinel only (nothing deployed yet) -> every row UNKNOWN", all(h[s]["s"] == "u" for s in ALL))
chk("5: ... reason names the missing probes", "tcp not measured" in h["jellyfin"]["d"])

# ---- 6. probe timeout (up==1, probe_success==0) -> CRITICAL -------------------------------------
h = H([SENT] + probe("svc-tcp", "homeassistant") + probe("svc-app", "homeassistant", ps=0)
      + probe("svc-health", "homeassistant"))
chk("6: probe timeout on app -> CRITICAL", h["homeassistant"]["s"] == "r")

# ---- 7. scrape timeout (up==0) -> UNKNOWN -------------------------------------------------------
h = H([SENT] + probe("svc-tcp", "homeassistant") + probe("svc-app", "homeassistant", up=0, ps=None)
      + probe("svc-health", "homeassistant"))
chk("7: scrape timeout on app -> UNKNOWN, not CRITICAL",
    h["homeassistant"]["s"] == "u" and "app scrape failed" in h["homeassistant"]["d"])
h = H([SENT] + probe("svc-tcp", "jellyfin") + probe("svc-app", "jellyfin", up=0, ps=0) + probe("svc-health", "jellyfin"))
chk("7: up==0 with a leftover probe_success==0 is still not a measured failure", h["jellyfin"]["s"] == "u")

# ---- 8. auth-required-but-alive (HA /api/ 401 counts as probe success) -> NOMINAL ---------------
h = H([SENT] + healthy("homeassistant"))
chk("8: HA health = 401 accepted by the module (probe_success 1) -> NOMINAL", h["homeassistant"]["s"] == "g")

# ---- 9. DNS path failure -> DEGRADED, not CRITICAL ----------------------------------------------
rows = [r for r in healthy("homeassistant") if r[0].get("resolver") != "pihole2"]
h = H([SENT] + rows + probe("svc-dns", "homeassistant", ps=0, resolver="pihole2"))
chk("9: one resolver failing -> DEGRADED", h["homeassistant"]["s"] == "y")
chk("9: ... naming the resolver", h["homeassistant"]["d"] == "DNS via pihole2 failing")
h = H([SENT] + rows + probe("svc-dns", "homeassistant", up=0, ps=None, resolver="pihole2"))
chk("9: a resolver probe that could not be scraped is not a DNS failure", h["homeassistant"]["s"] == "g")

# ---- 10. OPNsense cert expired -> DEGRADED ------------------------------------------------------
expired = probe("svc-tcp", "opnsense") + probe("svc-app", "opnsense", cert=NOW - 86400 * 26)
h = H([SENT] + expired)
chk("10: expired GUI cert -> DEGRADED", h["opnsense"]["s"] == "y" and "TLS certificate expired" in h["opnsense"]["d"])
h = H([SENT] + expired, api_fresh=True)
chk("10: expired cert stays DEGRADED with the API fresh", h["opnsense"]["s"] == "y" and "API" in h["opnsense"]["d"])

# ---- 11/12. OPNsense API combination ------------------------------------------------------------
h = H([SENT], api_fresh=True)
chk("11: API fresh + Prometheus absent -> NOMINAL, reason names the API",
    h["opnsense"]["s"] == "g" and h["opnsense"]["d"].startswith("authenticated API answering"))
h = H([SENT], api_fresh=False)
chk("12: API stale + Prometheus absent -> UNKNOWN", h["opnsense"]["s"] == "u")
h = H([SENT] + probe("svc-tcp", "opnsense") + probe("svc-app", "opnsense", ps=0), api_fresh=True)
chk("12: probe says app down but the API answers -> DEGRADED conflict, not CRITICAL",
    h["opnsense"]["s"] == "y" and "conflict" in h["opnsense"]["d"])
h = H([SENT] + probe("svc-tcp", "opnsense") + probe("svc-app", "opnsense", ps=0), api_fresh=False)
chk("12: probe says app down, API not fresh -> CRITICAL", h["opnsense"]["s"] == "r")

# ---- 13/14. guest state ------------------------------------------------------------------------
for rows, what in ((None, "no probe data"), ([], "collection failed"), ([SENT], "nothing measured")):
    h = S.service_health(rows, NOW, guests={"headscale": "running", "homeassistant": "running"})
    chk("13: guest running alone (%s) -> never NOMINAL" % what,
        h["headscale"]["s"] == "u" and h["homeassistant"]["s"] == "u")
h = H([SENT], guests={"headscale": "stopped", "homeassistant": "paused"})
chk("14: guest stopped -> CRITICAL", h["headscale"]["s"] == "r" and h["headscale"]["d"] == "guest stopped")
chk("14: guest paused -> CRITICAL", h["homeassistant"]["s"] == "r")
h = H([], guests={"headscale": "stopped"})
chk("14: guest stopped is red even when probe collection failed", h["headscale"]["s"] == "r")
h = H([SENT] + healthy("headscale"), guests={"headscale": "stopped"})
chk("14: guest stopped but app probe passes -> DEGRADED conflict", h["headscale"]["s"] == "y" and "conflict" in h["headscale"]["d"])
svc = {r["n"]: r for r in S.services({"nodes": {"pve5": {"guests": {"metrics": {"guests": {
    "headscale": "running", "homeassistant": "stopped"}}}}}})}
chk("14: services(): Headscale guest running -> UNKNOWN (the old gs() green path is gone)", svc["Headscale"]["s"] == "u")
chk("14: services(): Home Assistant guest stopped -> CRITICAL", svc["Home Assistant"]["s"] == "r")

# ---- 15. ICMP is never required, and only degrades with a working canary -----------------------
base = [SENT] + probe("svc-tcp", "headscale") + probe("svc-app", "headscale")
chk("15: no ICMP series at all -> still NOMINAL", H(base)["headscale"]["s"] == "g")
chk("15: icmp 0 with canary 1 -> DEGRADED",
    H(base + CANARY + probe("svc-icmp", "headscale", ps=0))["headscale"]["s"] == "y")
chk("15: icmp 0 with canary 0 (prober broken) -> NOMINAL, not DEGRADED",
    H(base + probe("svc-icmp", "canary", ps=0) + probe("svc-icmp", "headscale", ps=0))["headscale"]["s"] == "g")
chk("15: icmp ok alone never grants NOMINAL",
    H([SENT] + CANARY + probe("svc-icmp", "headscale"))["headscale"]["s"] == "u")

# ---- 16. property sweep: UNKNOWN never collapses to NOMINAL ------------------------------------
# Every target state per probe job, for every service, with and without the sentinel, the API and a
# running guest. NOMINAL is allowed ONLY when every required probe was measured OK (or, for OPNsense,
# the API is fresh with no measured fault).
STATES = ("absent", "up0", "nodata", "ok", "fail")
def rows_for(job, svc, state):
    return {"absent": [], "up0": probe(job, svc, up=0, ps=None), "nodata": probe(job, svc, ps=None),
            "ok": probe(job, svc), "fail": probe(job, svc, ps=0)}[state]
bad, n = [], 0
for svc, (_, need, guest) in S.SVC_SPEC.items():
    for combo in itertools.product(STATES, repeat=3):
        st = dict(zip(("svc-tcp", "svc-app", "svc-health"), combo))
        body = sum((rows_for(j, svc, x) for j, x in st.items()), [])
        for sentinel, api, gst in itertools.product((True, False), (True, False), (None, "running")):
            n += 1
            rows = ([SENT] if sentinel else []) + body
            r = S.service_health(rows, NOW, guests={guest: gst} if (guest and gst) else None, api_fresh=api)[svc]
            measured_ok = sentinel and all(st[j] == "ok" for j in need)
            fault = sentinel and any(st[j] == "fail" for j in ("svc-tcp", "svc-app", "svc-health"))
            api_ok = svc == "opnsense" and api and not fault
            if r["s"] not in ("g", "y", "r", "u"):
                bad.append((svc, combo, sentinel, api, gst, r))
            if r["s"] == "g" and not (measured_ok or api_ok):
                bad.append((svc, combo, sentinel, api, gst, r))
            if not sentinel and r["s"] == "r":
                bad.append((svc, combo, sentinel, api, gst, r))     # a failed collection never fabricates a failure
chk("16: %d generated combinations: UNKNOWN never collapses to NOMINAL, no fabricated CRITICAL%s"
    % (n, "" if not bad else " (first: %r)" % (bad[0],)), not bad)

# ---- 17. build_state wiring (prom/ssh stubbed) --------------------------------------------------
import datetime
iso = lambda t: datetime.datetime.fromtimestamp(t, datetime.timezone.utc).isoformat()
MON = {"finished": iso(NOW - 60), "nodes": {"pve5": {"guests": {"metrics": {"guests": {
    "headscale": "running", "homeassistant": "running"}}}}}}
OPN = {"wan1": {"state": "UP", "gw": "Online"}, "wan2": {"state": "UP", "gw": "Online"}}
queries = []
def run(svc_rows, opn=OPN):
    S.time.time = lambda: NOW
    def ps(q):
        queries.append(q)
        return svc_rows if q == S.SVC_QUERY else []
    for k, v in dict(monitor=lambda: MON, prom_by=lambda *a, **k: {}, prom_series=ps, slurm=lambda: None,
                     k8s=lambda: None, pihole_stats=lambda: None, opnsense_stats=lambda: opn,
                     switch=lambda: None, wan_policy=lambda M: None).items():
        setattr(S, k, v)
    st = S.build_state({})
    return st, {r["n"]: r for r in st["services"]}

st, rows = run([SENT] + CANARY + sum((healthy(s) for s in ALL), []))
chk("17: exactly one SVC_QUERY per refresh", queries.count(S.SVC_QUERY) == 1)
chk("17: svc_probes is its own FRESH section", st["panels"]["svc_probes"]["state"] == "FRESH")
chk("17: healthy probes -> all four rows NOMINAL",
    all(rows[S.SVC_SPEC[s][0]]["s"] == "g" for s in ALL))
st, rows = run([])
chk("17: query failed (no sentinel) -> svc_probes not FRESH", st["panels"]["svc_probes"]["state"] != "FRESH")
chk("17: ... Headscale/HA/Jellyfin UNKNOWN despite running guests",
    all(rows[n]["s"] == "u" for n in ("Headscale", "Home Assistant", "Jellyfin")))
chk("17: ... OPNsense NOMINAL from the fresh authenticated API", rows["OPNsense"]["s"] == "g" and "API" in rows["OPNsense"]["d"])
prev = st
st, rows = run(sum((healthy(s) for s in ALL), []), opn={"wan1": {"state": "UP"}})
chk("17: carried probe data from a previous cycle is never re-used as a measurement",
    all(rows[S.SVC_SPEC[s][0]]["s"] == "u" for s in ALL))
chk("17: API fresh but no gateway data -> not an application signal", rows["OPNsense"]["s"] == "u")
st, rows = run([SENT], opn=None)
chk("17: API section missing + Prometheus unmeasured -> OPNsense UNKNOWN", rows["OPNsense"]["s"] == "u")
chk("17: other Services rows are untouched", rows["Vaultwarden"]["s"] == "u" and "src" not in rows["Vaultwarden"])

print("%s: %d failed" % ("P13", len(fails)))
raise SystemExit(1 if fails else 0)
