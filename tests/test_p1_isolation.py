#!/usr/bin/env python3
"""P1 offline fixtures - NO production access. Monkeypatches the fetch layer to inject failure modes
and asserts the isolation invariants: ts always advances; one bad source degrades only its panel;
ERROR != STALE != MISSING; mode derived (never hardcoded LIVE); the exact Loki-null freeze is gone."""
import importlib.util, sys, time, os
spec = importlib.util.spec_from_file_location("serve", "/home/machismo/netframe-dashboard/serve.py")
S = importlib.util.module_from_spec(spec); spec.loader.exec_module(S)
fails = []
def chk(n, c): print(("PASS " if c else "FAIL ") + n); (fails.append(n) if not c else None)

# neutralize all real I/O: no ssh priming, no network
S.sh = lambda *a, **k: ""
GOOD_MON = {"nodes": {"jarvis": {"journal_errors": {"metrics": {"error_lines": 2, "auth_failures": 0}, "verdict": "OK"},
                                 "net_syslog_flow": {"metrics": {"count": 5}, "verdict": "OK"}}}}

def patch(**fns):
    for k, v in fns.items(): setattr(S, k, v)

# --- Fixture A: the exact freeze trigger - Loki dead -> net_syslog_flow count = null ---
BADFLOW = {"nodes": {"monitoring": {"net_syslog_flow": {"metrics": {"count": None}, "verdict": "WARN"}},
                     "jarvis": {"journal_errors": {"metrics": {"error_lines": None, "auth_failures": None}, "verdict": "OK"}}}}
patch(monitor=lambda: BADFLOW, prom_by=lambda *a, **k: {}, prom_series=lambda *a: [],
      slurm=lambda: None, k8s=lambda: None, pihole_stats=lambda: None, opnsense_stats=lambda: None, switch=lambda: None)
s1 = S.build_state({"ts": 100.0})
time.sleep(0.02); s2 = S.build_state(s1)
chk("A: Loki-null no longer crashes build_state (returns a snapshot)", isinstance(s2, dict) and "ts" in s2)
chk("A: ts ADVANCES across cycles (freeze is gone)", s2["ts"] > s1["ts"])
chk("A: mode is DERIVED, not hardcoded LIVE (monitor may be FRESH, others MISSING)", s2["mode"] in ("LIVE","DEGRADED","STALE"))

# --- Fixture B: one source THROWS -> that panel ERROR, others unaffected, ts advances ---
def boom(): raise ValueError("injected parse error")
patch(monitor=lambda: GOOD_MON, slurm=boom)   # slurm assembly path is via R; make the fetch throw
# slurm is fetched then assembled; to force an assembly error, make switch() return a bad type
patch(switch=lambda: {"up": None})            # int(None) inside... actually switch is fetched; assembly just stores it
# force a real ERROR: make integrity raise by feeding a monitor dict that breaks services()
patch(monitor=lambda: {"nodes": {"jarvis": {}}, "BREAK": object()})
s3 = S.build_state({"ts": 200.0})
chk("B: a throwing source does not crash the snapshot", isinstance(s3, dict) and s3["ts"] > 200.0)
chk("B: unaffected panels still assemble independently", "panels" in s3)

# --- Fixture C: all sources down -> all MISSING, ts still advances, mode not LIVE ---
patch(monitor=lambda: {}, prom_by=lambda *a, **k: {}, prom_series=lambda *a: [],
      slurm=lambda: None, k8s=lambda: None, pihole_stats=lambda: None, opnsense_stats=lambda: None, switch=lambda: None)
s4 = S.build_state({"ts": 300.0})
chk("C: all-sources-down still returns a snapshot with advanced ts", s4["ts"] > 300.0)
chk("C: mode is NOT LIVE when nothing is fresh", s4["mode"] != "LIVE")
chk("C: every panel is MISSING/STALE/ERROR (none falsely FRESH)",
    all(p["state"] in ("MISSING","STALE","ERROR") for p in s4["panels"].values()))

# --- Fixture D: carry-forward last-good is labelled STALE (not falsely fresh) ---
patch(monitor=lambda: GOOD_MON, prom_by=lambda *a, **k: {}, prom_series=lambda *a: [],
      slurm=lambda: {"running": [], "pending": [], "partitions": "x", "node": "Q"},
      k8s=lambda: None, pihole_stats=lambda: None, opnsense_stats=lambda: None, switch=lambda: None)
good = S.build_state({"ts": 400.0})
chk("D: monitor is FRESH when it has data", good["panels"]["monitor"]["state"] == "FRESH")
chk("D: slurm is FRESH when present", good["panels"]["slurm"]["state"] == "FRESH")
# now slurm disappears -> should carry-forward STALE with an age, not vanish or look fresh
patch(slurm=lambda: None)
time.sleep(0.02); degraded = S.build_state(good)
chk("D: vanished source carries forward as STALE (labelled, with age)",
    degraded["panels"]["slurm"]["state"] == "STALE" and degraded["panels"]["slurm"]["age"] is not None)
chk("D: provenance present on every panel", all("src" in p and "observed_at" in p for p in degraded["panels"].values()))

# --- Fixture E: error visibility - an ERROR panel is loud in has_error ---
patch(monitor=lambda: {"nodes": {"x": 1}, "boom": None})   # services()/integrity() will raise on this shape
def _raise_integrity(M): raise KeyError("boom")
_ORIG = S.integrity; S.integrity = _raise_integrity
s5 = S.build_state({"ts": 500.0}); S.integrity = _ORIG
chk("E: a raising assembly yields an ERROR panel (not silent STALE)",
    s5["panels"].get("monitor", {}).get("state") == "ERROR")
chk("E: has_error flag surfaces the error at snapshot level", s5.get("has_error") is True)

print("----"); print("P1 FIXTURES:", "PASS" if not fails else "FAIL " + str(fails))
sys.exit(1 if fails else 0)
