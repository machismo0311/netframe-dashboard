#!/usr/bin/env python3
"""P2 offline fixtures - NO production access. Proves TD-147: a carried panel must keep the age of
its LAST FRESH observation, so staleness grows without bound instead of resetting every cycle.

Historical defect: carry() aged against prev["ts"], but the refresher republishes prev with a new ts
every cycle, so data stale for 12d13.7h still reported ~30s (operations/wall-monitor-dependency)."""
import importlib.util, sys, os
HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("serve", os.path.join(HERE, "..", "serve.py"))
S = importlib.util.module_from_spec(spec); spec.loader.exec_module(S)

fails = []
def chk(n, c): print(("PASS  " if c else "FAIL  ") + n); (fails.append(n) if not c else None)

S.sh = lambda *a, **k: ""
GOOD_MON = {"nodes": {"jarvis": {"journal_errors": {"metrics": {"error_lines": 1, "auth_failures": 0}, "verdict": "OK"},
                                 "net_syslog_flow": {"metrics": {"count": 5}, "verdict": "OK"}}}}
NODES_UP = {"jarvis": 1.0, "pve3": 1.0}

def patch(**fns):
    for k, v in fns.items(): setattr(S, k, v)

def all_dead():
    patch(monitor=lambda: GOOD_MON, prom_by=lambda *a, **k: {}, prom_series=lambda *a: [],
          slurm=lambda: None, k8s=lambda: None, pihole_stats=lambda: None,
          opnsense_stats=lambda: None, switch=lambda: None)

def prom_alive():
    patch(monitor=lambda: GOOD_MON, prom_by=lambda *a, **k: NODES_UP, prom_series=lambda *a: [],
          slurm=lambda: None, k8s=lambda: None, pihole_stats=lambda: None,
          opnsense_stats=lambda: None, switch=lambda: None)

# ---- Fixture 1: a FRESH panel records when it was fresh -------------------------------------
prom_alive()
t0 = 1_000_000.0
S.time.time = lambda: t0
s = S.build_state({})
chk("1: a FRESH panel reports age 0", s["panels"]["prometheus"]["state"] == "FRESH" and s["panels"]["prometheus"]["age"] == 0)
chk("1: a FRESH panel records its observation time", s["panels"]["prometheus"]["fresh_at"] == t0)

# ---- Fixture 2: the source dies; age must grow with WALL CLOCK, not reset --------------------
all_dead()
prev, ages, states = s, [], []
for cycle in range(1, 8):
    now = t0 + cycle * 38.0                      # one real refresh interval per cycle
    S.time.time = lambda n=now: n
    prev = S.build_state(prev)
    ages.append(prev["panels"]["prometheus"]["age"])
    states.append(prev["panels"]["prometheus"]["state"])

chk("2: the dead source is carried as STALE every cycle", all(x == "STALE" for x in states))
chk("2: carried age increases monotonically", all(ages[i] > ages[i-1] for i in range(1, len(ages))))
chk("2: carried age tracks true elapsed time (7 cycles ~ 266s)", ages[-1] == 266)
chk("2: carried age is NOT one refresh interval (the exact TD-147 defect)", ages[-1] > 38 * 2)
chk("2: fresh_at is preserved across every carry", prev["panels"]["prometheus"]["fresh_at"] == t0)
chk("2: ts still advances while the panel is stale", prev["ts"] > s["ts"])
chk("2: mode is DEGRADED, not LIVE", prev["mode"] == "DEGRADED")

# ---- Fixture 3: 12 days of carrying still reports 12 days -----------------------------------
twelve_days = t0 + 12 * 86400 + 13 * 3600
S.time.time = lambda: twelve_days
long_stale = S.build_state(prev)
chk("3: after 12d13h the carried panel reports its TRUE age",
    long_stale["panels"]["prometheus"]["age"] == round(twelve_days - t0))
chk("3: 12-day-old data can no longer masquerade as ~30s old",
    long_stale["panels"]["prometheus"]["age"] > 1_000_000)

# ---- Fixture 4: no original observation time -> age UNKNOWN, never young ---------------------
S.time.time = lambda: t0 + 500.0
orphan = S.build_state({"ts": t0 + 470.0, "nodes": {"Jarvis": {"cpu": 1}}})   # prev has no panels block
chk("4: carried data with no recorded fresh_at reports age None (UNKNOWN)",
    orphan["panels"]["prometheus"]["age"] is None)
chk("4: it is still marked STALE, not FRESH", orphan["panels"]["prometheus"]["state"] == "STALE")

# ---- Fixture 5: recovery re-bases the age ---------------------------------------------------
prom_alive()
t_rec = twelve_days + 38.0
S.time.time = lambda: t_rec
rec = S.build_state(long_stale)
chk("5: on recovery the panel is FRESH again", rec["panels"]["prometheus"]["state"] == "FRESH")
chk("5: on recovery age returns to 0", rec["panels"]["prometheus"]["age"] == 0)
chk("5: on recovery fresh_at is re-based to now", rec["panels"]["prometheus"]["fresh_at"] == t_rec)

# ---- Fixture 6: the legacy sources[] boolean is still NOT a freshness signal -----------------
chk("6: sources[] stays true on carried data (why the renderer must not trust it)",
    long_stale["sources"]["prometheus"] is True and long_stale["panels"]["prometheus"]["state"] == "STALE")

print("\n" + ("FAILED %d" % len(fails) if fails else "ALL AGE FIXTURES PASS"))
sys.exit(1 if fails else 0)
