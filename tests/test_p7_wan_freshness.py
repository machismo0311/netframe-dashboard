#!/usr/bin/env python3
"""P7 offline fixtures - NO production access, no socket, no clock dependency.

Proves the staleness rule on the failover posture: a producer that STOPS must not leave the wall
showing DUAL-WAN READY forever.

Why this is the dangerous direction. The wall's green state asserts "a WAN1 failure is survivable".
Between 2026-08-15 and 2026-09-09 it asserted that for 25 days while the FirstNet standby was dead,
because one fact was absent and absence rendered as health. Staleness is the same failure wearing a
different coat: a fact that WAS true, still being displayed long after anyone last checked it.

So the rule under test is that only a posture with an explicit, recent observation time counts as
observed. No timestamp is not "probably fine", and a future timestamp is a broken clock, not proof."""
import importlib.util, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("serve", os.path.join(HERE, "..", "serve.py"))
S = importlib.util.module_from_spec(spec); spec.loader.exec_module(S)

fails = []
def chk(n, c):
    print(("PASS  " if c else "FAIL  ") + n)
    if not c:
        fails.append(n)

NOW = 1_757_000_000.0
MAX = S.WAN_POLICY_MAX_AGE

def posture(age, **over):
    d = {"armed": True, "group": "Failover", "tiers": 2,
         "active": "wan1", "active_netif": "vtnet0", "observed_at": NOW - age}
    d.update(over)
    return d

# ---- the threshold itself ---------------------------------------------------------
chk("threshold is 2 missed 15-min producer cycles + 5m grace", MAX == 35 * 60)
chk("threshold is not an open-ended allowance (< 1h)", MAX < 3600)

# ---- fresh / stale boundary -------------------------------------------------------
chk("just-observed posture is fresh", S.wan_posture_fresh(posture(0), now=NOW))
chk("one missed producer cycle is still fresh", S.wan_posture_fresh(posture(15 * 60), now=NOW))
chk("inside the window is fresh", S.wan_posture_fresh(posture(MAX - 1), now=NOW))
chk("exactly at the window is still fresh", S.wan_posture_fresh(posture(MAX), now=NOW))
chk("one second past the window is STALE", not S.wan_posture_fresh(posture(MAX + 1), now=NOW))
chk("two missed cycles plus grace is STALE", not S.wan_posture_fresh(posture(40 * 60), now=NOW))
chk("a producer dead for a day is STALE", not S.wan_posture_fresh(posture(86400), now=NOW))

# ---- M7: a frozen producer cannot hold the wall green -----------------------------
chk("M7: stale posture is rejected outright, not passed through",
    not S.wan_posture_fresh(posture(86400), now=NOW))

# ---- an envelope that cannot say when it looked ------------------------------------
d = posture(0); del d["observed_at"]
chk("no observed_at is REJECTED, never assumed current", not S.wan_posture_fresh(d, now=NOW))
chk("non-numeric observed_at is rejected",
    not S.wan_posture_fresh(posture(0, observed_at="2026-09-10"), now=NOW))
chk("None observed_at is rejected", not S.wan_posture_fresh(posture(0, observed_at=None), now=NOW))
chk("bool is not a timestamp (True would pass a naive isinstance check)",
    not S.wan_posture_fresh(posture(0, observed_at=True), now=NOW))

# ---- clock skew -------------------------------------------------------------------
chk("small negative skew tolerated", S.wan_posture_fresh(posture(-30), now=NOW))
chk("a posture from the far future is rejected, not treated as very fresh",
    not S.wan_posture_fresh(posture(-3600), now=NOW))

# ---- envelope shape ---------------------------------------------------------------
chk("not a dict -> not fresh", not S.wan_posture_fresh(None, now=NOW))
chk("empty dict -> not fresh", not S.wan_posture_fresh({}, now=NOW))
chk("missing armed -> not fresh",
    not S.wan_posture_fresh({"observed_at": NOW, "group": "Failover"}, now=NOW))
chk("armed must be a real bool, not a truthy string",
    not S.wan_posture_fresh(posture(0, armed="true"), now=NOW))
chk("armed=false is a VALID observation and stays fresh",
    S.wan_posture_fresh(posture(0, armed=False), now=NOW))

# ---- the producing side stamps it -------------------------------------------------
src = open(os.path.join(HERE, "..", "serve.py")).read()
chk("the local probe stamps observed_at at observation time",
    '"observed_at": time.time()' in src)
chk("the republished endpoint re-checks freshness at serve time",
    src.count("wan_posture_fresh(fo)") == 1)

print("----")
print("WAN FRESHNESS: " + ("FAIL " + str(fails) if fails else "PASS"))
sys.exit(1 if fails else 0)
