#!/usr/bin/env python3
"""P8 offline fixtures - NO production access. The backend must never turn ABSENT evidence into a
healthy-looking value, and must judge the netframe-monitor collection by its own clock.

Defects these pin (all confirmed against master 58bb84d):
  * services() rendered a service with no probe and no guest record as "g" (OPNsense, Jellyfin).
  * integrity() rendered absent checks as "0", "STABLE", "0 MISSING" or a green chip.
  * a successful READ of last_run.json marked the monitor panel FRESH even if the collector had
    stopped days ago; only the WAN posture looked at `finished`.
  * a future observation time aged as "very fresh"."""
import importlib.util, sys, os, datetime
HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("serve", os.path.join(HERE, "..", "serve.py"))
S = importlib.util.module_from_spec(spec); spec.loader.exec_module(S)

fails = []
def chk(n, c): print(("PASS  " if c else "FAIL  ") + n); (fails.append(n) if not c else None)

S.sh = lambda *a, **k: ""
T0 = 2_000_000.0
iso = lambda t: datetime.datetime.fromtimestamp(t, datetime.timezone.utc).isoformat()

def mon(finished=T0, started=None, extra=None):
    m = {"nodes": {"jarvis": {"journal_errors": {"metrics": {"error_lines": 3, "auth_failures": 0}, "verdict": "OK"}}}}
    if finished is not None: m["finished"] = iso(finished)
    if started is not None: m["started"] = iso(started)
    for host, checks in (extra or {}).items():
        m["nodes"].setdefault(host, {}).update(checks)
    return m

def run(M, now, prev=None):
    S.time.time = lambda: now
    for k, v in dict(monitor=lambda: M, prom_by=lambda *a, **k: {}, prom_series=lambda *a: [],
                     slurm=lambda: None, k8s=lambda: None, pihole_stats=lambda: None,
                     opnsense_stats=lambda: None, switch=lambda: None).items():
        setattr(S, k, v)
    return S.build_state(prev or {})

# ---- 1. absence is UNKNOWN, never healthy ----------------------------------------------------
bare = {"nodes": {"jarvis": {}}}
svc = {s["n"]: s["s"] for s in S.services(bare)}
chk("1: a service with no probe (OPNsense) is unknown, not green", svc["OPNsense"] == "u")
chk("1: a service with no probe (Jellyfin) is unknown, not green", svc["Jellyfin"] == "u")
chk("1: a guest absent from every guest list is unknown", svc["Vaultwarden"] == "u")
chk("1: no service is green without evidence", "g" not in svc.values())
ig = {c["k"]: c for c in S.integrity(bare)}
for k in ("Backup Verify", "Hardening Drift", "Exposure Guard", "Journal Errors", "Auth Failures",
          "LLM Router", "NPM DNS", "Net Dead-man", "SMART Trend", "Wazuh SIEM"):
    chk("1: absent %s -> UNKNOWN/u (not 0, STABLE or NONE)" % k, ig[k]["s"] == "u" and ig[k]["v"] == "UNKNOWN")

withg = {"nodes": {"pve3": {"guests": {"metrics": {"guests": {"vaultwarden": "running"}}}}}}
chk("1: a running guest is still green (no false alarm introduced)",
    {s["n"]: s["s"] for s in S.services(withg)}["Vaultwarden"] == "g")
crit = mon(extra={"randy": {"journal_errors": {"metrics": {"error_lines": 9}, "verdict": "CRIT"}}})
chk("1: a CRIT journal verdict is red (was reported OK because only WARN was checked)",
    {c["k"]: c for c in S.integrity(crit)}["Journal Errors"]["s"] == "r")
npm0 = {"nodes": {"pve3": {"npm_dns": {"metrics": {"missing_count": 0}, "verdict": "OK"}}}}
chk("1: a measured zero is still a real zero", {c["k"]: c for c in S.integrity(npm0)}["NPM DNS"]["v"] == "0 MISSING")

# ---- 2. the collector is judged by its own clock ---------------------------------------------
s = run(mon(finished=T0 - 240), T0)
chk("2: a 4-minute-old collection is FRESH", s["panels"]["monitor"]["state"] == "FRESH")
chk("2: a FRESH collection reports its true age (240s), not 0", s["panels"]["monitor"]["age"] == 240)
chk("2: fresh_at is the collector's own time, so carried data ages from it",
    s["panels"]["monitor"]["fresh_at"] == T0 - 240)
L = S.COLLECTOR_MAX_AGE
chk("2: the limit is the existing WAN_POLICY_MAX_AGE (one limit for one file)", L == S.WAN_POLICY_MAX_AGE == 2100)
chk("2: boundary - exactly at the limit is still FRESH", run(mon(finished=T0 - L), T0)["panels"]["monitor"]["state"] == "FRESH")
past = run(mon(finished=T0 - L - 1), T0)
chk("2: boundary - one second past the limit is STALE", past["panels"]["monitor"]["state"] == "STALE")
chk("2: a stale collection keeps its true age", past["panels"]["monitor"]["age"] == L + 1)
chk("2: a stale collection says why", "collector last finished" in (past["panels"]["monitor"]["error"] or ""))
chk("2: a stale collection makes the snapshot not LIVE", past["mode"] != "LIVE")
chk("2: stale collection values are still delivered (shown with their age, not blanked)", bool(past.get("integrity")))
days = run(mon(finished=T0 - 3 * 86400), T0)
chk("2: a collector stopped for 3 days reports 3 days", days["panels"]["monitor"]["age"] == 3 * 86400)
und = run(mon(finished=None), T0)
chk("2: an undated collection is STALE with age UNKNOWN (None)",
    und["panels"]["monitor"]["state"] == "STALE" and und["panels"]["monitor"]["age"] is None)

# ---- 3. future clocks are invalid, not "very fresh" ----------------------------------------
fut = run(mon(finished=T0 + 300), T0)
chk("3: a collection 5 min in the future is STALE", fut["panels"]["monitor"]["state"] == "STALE")
chk("3: ...with age UNKNOWN, never 0", fut["panels"]["monitor"]["age"] is None)
chk("3: ...and says the clock is in the future", "future" in (fut["panels"]["monitor"]["error"] or ""))
chk("3: small skew (+30s) is tolerated", run(mon(finished=T0 + 30), T0)["panels"]["monitor"]["state"] == "FRESH")
prev = {"ts": T0 - 30, "panels": {"slurm": {"state": "FRESH", "fresh_at": T0 + 3600}},
        "slurm": {"running": [], "pending": [], "partitions": "x", "node": "q"}}
car = run(mon(), T0, prev)
chk("3: carried data whose fresh_at is in the future has UNKNOWN age",
    car["panels"]["slurm"]["state"] == "STALE" and car["panels"]["slurm"]["age"] is None)
chk("3: ...and the reason names the broken clock", "future" in (car["panels"]["slurm"]["error"] or ""))

# ---- 4. carried collection ages from the collector's time, recovery re-bases ----------------
ok = run(mon(finished=T0 - 60), T0)
gone = run({}, T0 + 600, ok)
chk("4: when last_run.json cannot be read the monitor panel is carried STALE",
    gone["panels"]["monitor"]["state"] == "STALE")
chk("4: ...aged from the collector's finished time (660s), not from the last read",
    gone["panels"]["monitor"]["age"] == 660)
back = run(mon(finished=T0 + 900), T0 + 960, gone)
chk("4: a new collection recovers to FRESH", back["panels"]["monitor"]["state"] == "FRESH")
chk("4: recovery ages from the new run (60s)", back["panels"]["monitor"]["age"] == 60)

# ---- 5. collector run timing is published (the evidence the limit depends on) ---------------
t = run(mon(finished=T0 - 100, started=T0 - 250), T0)
chk("5: run duration is published from started/finished", t.get("collector", {}).get("duration_s") == 150.0)
chk("5: the display limit is published with it", t["collector"]["max_age_s"] == L)
chk("5: no `started` -> duration unknown, not 0", run(mon(finished=T0 - 10), T0)["collector"]["duration_s"] is None)

# ---- 6. UPS utility/battery state comes through from the existing collector check ------------
U = {"monitoring": {"ups": {"verdict": "WARN", "metrics": {"reporting": 2, "ups": {
        "tripplite": {"ups.status": "OB DISCHRG", "battery.charge": "100"},
        "midatlantic": {"ups.status": "OL"}}}}}}
us = run(mon(extra=U), T0).get("ups_status") or {}
chk("6: ups_status carries the raw NUT status per unit",
    us.get("units", {}).get("tripplite", {}).get("status") == "OB DISCHRG"
    and us["units"]["midatlantic"]["status"] == "OL")
chk("6: ...with the collector's own verdict and reporting count", us.get("verdict") == "WARN" and us.get("reporting") == 2)
chk("6: no ups check -> no ups_status key (absent, not 'online')", "ups_status" not in run(mon(), T0))
nul = {"monitoring": {"ups": {"verdict": "WARN", "metrics": {"reporting": 1, "ups": {"tripplite": {}}}}}}
chk("6: a unit with no status reports None, never a guessed OL",
    run(mon(extra=nul), T0)["ups_status"]["units"]["tripplite"]["status"] is None)

print("\n" + ("FAILED %d" % len(fails) if fails else "P8 BACKEND TRUTH: PASS"))
sys.exit(1 if fails else 0)
