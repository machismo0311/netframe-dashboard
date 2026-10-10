#!/usr/bin/env python3
"""P12 offline fixtures - NO production access. SSH channel fan-out per host must stay below sshd's
MaxSessions, without costing freshness.

Defect this pins (measured 2026-10-08 on both walls, read-only, client side): build_state started 13
nfm-prom calls plus switch()'s chain to pve4 at once, 14 channels on ONE ControlMaster connection.
sshd allows MaxSessions=10 per connection, so 4 sessions per refresh were refused ("error: no more
sessions" on pve4) and each refused ssh silently fell back to a fresh root login (4 extra TCP
connections to pve4:22 seen per refresh on Ares and on the Pi).

Since 2026-10-09 build_state runs ONE more nfm-prom call (the sentinel-guarded application-probe query,
serve.SVC_QUERY), so the uncapped reproduction below now peaks at 15 channels and 5 refusals; the
measured 14/4 above is the history it was built from.

The fake transport below replaces only serve._run, the one place a process is spawned. It models a
multiplexed connection per host that refuses a channel beyond MAX_SESSIONS, with a fixed latency per
call, and records the peak number of channels each host saw."""
import importlib.util, json, os, sys, threading, time
HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("serve", os.path.join(HERE, "..", "serve.py"))
S = importlib.util.module_from_spec(spec); spec.loader.exec_module(S)

fails = []
def chk(n, c): print(("PASS  " if c else "FAIL  ") + n); (fails.append(n) if not c else None)

MAX_SESSIONS = 10          # Debian OpenSSH default, what pve4 runs
SHIPPED_CAP = S.SSH_CHANNEL_CAP


class FakeSSH:
    """One ControlMaster connection per host, as the walls run it. Every invocation is counted as
    in flight (what `ps` shows). It asks the master for a session; past MAX_SESSIONS the session is
    refused (sshd logs "no more sessions") and the client falls back to a DIRECT login, which is
    what the 4 extra TCP connections to pve4:22 per refresh were. Both paths cost `latency`."""
    def __init__(self, latency, hang=()):
        self.latency, self.hang = latency, set(hang)
        self.lock = threading.Lock()
        self.inflight, self.peak, self.calls = {}, {}, {}
        self.sessions, self.refused, self.direct = {}, {}, {}

    def __call__(self, cmd, timeout, input):
        host = S._ssh_target(cmd)
        if host is None:
            return ""
        with self.lock:
            self.inflight[host] = self.inflight.get(host, 0) + 1
            self.peak[host] = max(self.peak.get(host, 0), self.inflight[host])
            self.calls[host] = self.calls.get(host, 0) + 1
            mux = self.sessions.get(host, 0) < MAX_SESSIONS
            if mux:
                self.sessions[host] = self.sessions.get(host, 0) + 1
            else:
                self.refused[host] = self.refused.get(host, 0) + 1
                self.direct[host] = self.direct.get(host, 0) + 1
        try:
            if host in self.hang:
                time.sleep(timeout)          # a hung host: the call runs into its own timeout
                return ""
            time.sleep(self.latency.get(host, 0.0))
            return reply(cmd[len(S.SSH) + 1:], input)
        finally:
            with self.lock:
                self.inflight[host] -= 1
                if mux:
                    self.sessions[host] -= 1


def reply(remote, query):
    """Plausible output for each remote command serve.py runs."""
    if remote == ["nfm-prom"]:
        lab = {"instance": "pve4", "ups": "tripplite", "pihole": "primary"}
        res = [{"metric": lab, "value": [0, "1"]}]
        if query and "svc-" in query:          # the application-probe query answers with its sentinel
            res.append({"metric": {}, "value": [0, "1"]})
        return json.dumps({"data": {"result": res}})
    if remote and remote[0].startswith("cat /opt/netframe-monitor"):
        return json.dumps({"finished": time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime()),
                           "nodes": {"jarvis": {"journal_errors": {"verdict": "OK", "metrics": {}}}}})
    if remote == ["nfm-slurm"]:
        return "===SINFO===\nresearch|up\n===SQUEUE===\n"
    return "ok"


def run(fake, cap):
    S._run = fake
    S.SSH_CHANNEL_CAP = cap
    S._SSH_SLOTS.clear()
    for k, v in dict(k8s=lambda: {"nodes": 3, "ready": 3}, pihole_stats=lambda: {"q": 1},
                     opnsense_stats=lambda: {"wan1": {}}).items():
        setattr(S, k, v)
    t = time.monotonic()
    st = S.build_state({})
    return st, time.monotonic() - t


L = 0.2      # latency of one nfm-prom call (scaled down; the live walls see ~0.3-1.5 s per call)
PVE4_PANELS = ("prometheus", "ups", "pihole", "gpu", "switch", "svc_probes")

# ---- 1. the defect, reproduced on the old behaviour (no effective cap) -------------------------
old = FakeSSH({"pve4": L, "jarvis": L, "quarkylab": L})
st_old, took_old = run(old, cap=10_000)
chk("1: uncapped, 15 ssh calls to pve4 are in flight at once (14 measured with ps on both walls, plus the "
    "service-probe query; got %d)" % old.peak["pve4"], old.peak["pve4"] == 15)
chk("1: uncapped, that exceeds MaxSessions=10", old.peak["pve4"] > MAX_SESSIONS)
chk("1: uncapped, 5 sessions per refresh are refused, each a 'no more sessions' on pve4 (got %d)"
    % old.refused.get("pve4", 0), old.refused.get("pve4", 0) == 5)
chk("1: uncapped, each refusal becomes an extra direct root login (4 per refresh as ss showed, 5 now)",
    old.direct.get("pve4", 0) == 5)
chk("1: uncapped, the fallback hides it: the wall still looks LIVE", st_old["mode"] == "LIVE")

# ---- 2. capped: channels per host never exceed the cap -----------------------------------------
new = FakeSSH({"pve4": L, "jarvis": L, "quarkylab": L})
st, took = run(new, cap=SHIPPED_CAP)
chk("2: the shipped cap is well below MaxSessions (<= 6)", 1 <= SHIPPED_CAP <= 6)
chk("2: pve4 never sees more than the cap (peak %d)" % new.peak["pve4"], new.peak["pve4"] <= SHIPPED_CAP)
chk("2: the cap is actually reached, so the pool is not serialised", new.peak["pve4"] == SHIPPED_CAP)
chk("2: no session is refused, so pve4 logs no 'no more sessions'", sum(new.refused.values()) == 0)
chk("2: no direct fallback login is made", sum(new.direct.values()) == 0)
chk("2: every pve4 query still runs (1 warm-up + 14 parallel + 5 switch = 20)", new.calls["pve4"] == 20)
for h in ("jarvis", "quarkylab"):
    chk("2: %s stays within the cap" % h, new.peak[h] <= SHIPPED_CAP)

# ---- 3. freshness: no panel goes stale because of the cap, and the refresh stays short ---------
for p in PVE4_PANELS + ("monitor", "slurm"):
    chk("3: panel %s is FRESH with the cap" % p, st["panels"][p]["state"] == "FRESH")
chk("3: the snapshot is LIVE", st["mode"] == "LIVE")
chk("3: pve4 values are all present (cpu, ram, disk, up on the pve4 card)",
    set(st["nodes"].get("pve4", {})) >= {"cpu", "ramU", "disk", "st"})
# The uncapped baseline is the warm-ups (3 L) plus switch()'s chain of 5 (5 L) = 8 L. Capped, the 14
# parallel calls take 3 waves and the chain's later calls queue behind them: about 2 L more.
chk("3: uncapped baseline refresh %.2fs (about 8 latencies)" % took_old, took_old < 9 * L)
chk("3: refresh with the cap takes %.2fs, under 11 latencies (%.2fs)" % (took, 11 * L), took < 11 * L)
chk("3: the cap adds at most ~2 latencies over the uncapped refresh (%.2fs vs %.2fs)" % (took, took_old),
    took - took_old < 2.5 * L)

# ---- 4. other hosts are unaffected by pve4's queue ---------------------------------------------
slow = FakeSSH({"pve4": 1.0, "jarvis": 0.05, "quarkylab": 0.05})
S._run = slow; S.SSH_CHANNEL_CAP = SHIPPED_CAP; S._SSH_SLOTS.clear()
done = {}
def call(name, host, remote, inp=None):
    t = time.monotonic(); S.sh(S.SSH + [host, remote], input=inp); done[name] = time.monotonic() - t
ths = [threading.Thread(target=call, args=("p%d" % i, "pve4", "nfm-prom", "up")) for i in range(14)]
ths += [threading.Thread(target=call, args=("jarvis", "jarvis", "cat /opt/netframe-monitor/last_run.json")),
        threading.Thread(target=call, args=("quarkylab", "quarkylab", "nfm-slurm"))]
for t in ths: t.start()
for t in ths: t.join()
chk("4: with pve4 saturated, jarvis still answers at its own latency (%.2fs)" % done["jarvis"], done["jarvis"] < 0.5)
chk("4: with pve4 saturated, quarkylab still answers at its own latency (%.2fs)" % done["quarkylab"], done["quarkylab"] < 0.5)
chk("4: pve4 peak held at the cap under saturation", slow.peak["pve4"] <= 6)
chk("4: queued pve4 calls complete in waves, none refused", sum(slow.refused.values()) == 0)

# non-SSH commands never take a slot
S._run = lambda cmd, timeout, input: "local"
chk("4: a non-SSH command bypasses the slots", S.sh(["echo", "x"]) == "local" and S._ssh_target(["echo", "x"]) is None)
chk("4: an argv that merely starts with 'ssh' is not mistaken for an SSH-prefixed call",
    S._ssh_target(["ssh", "pve4", "true"]) is None)

# ---- 5. a hung host costs no more time than before the cap -------------------------------------
hung = FakeSSH({}, hang=("pve4",))
S._run = hung; S.SSH_CHANNEL_CAP = SHIPPED_CAP; S._SSH_SLOTS.clear()
T = 0.5
times = []
def hcall():
    t = time.monotonic(); r = S.sh(S.SSH + ["pve4", "nfm-prom"], timeout=T, input="up"); times.append((time.monotonic() - t, r))
ths = [threading.Thread(target=hcall) for _ in range(14)]
for t in ths: t.start()
for t in ths: t.join()
chk("5: every call to a hung host returns within its own timeout (max %.2fs, limit %.2fs)"
    % (max(x for x, _ in times), T), max(x for x, _ in times) < T + 0.25)
chk("5: a hung host yields the same empty result as before (no exception, no fabricated value)",
    all(r == "" for _, r in times))
chk("5: the hung host's waiting calls never exceed the cap either", hung.peak["pve4"] <= 6)
chk("5: slots are all released after the hang", all(S._ssh_slot("pve4").acquire(blocking=False) for _ in range(6)))

print("\n%d FAILED" % len(fails) if fails else "\nALL PASS")
sys.exit(1 if fails else 0)
