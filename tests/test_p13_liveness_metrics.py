#!/usr/bin/env python3
"""P13 offline fixtures - NO production access. The wall's /metrics endpoint must never turn an
absent or malformed fact into a healthy-looking series.

WHY. /healthz answers a static "ok" even while the refresher thread is dead and the page shows a
frozen snapshot, and no host exporter runs on Ares or the Pi, so Prometheus had nothing that could
tell a live wall from a frozen one. /metrics exports the snapshot timestamp, the global mode and
when /api/state was last polled, split loopback / remote (on the Pi the kiosk browser is the only
loopback client).

What this pins:
  * the exposition parses (promtool check metrics when available, a strict local parser always);
  * mode is one-hot over the closed vocabulary and an unexpected mode reads as UNKNOWN, never LIVE;
  * a missing or non-numeric ts is OMITTED (absence is UNKNOWN downstream), never exported as 0;
  * a peer that never polled is OMITTED, never exported as epoch 0;
  * the real handler records loopback polls and serves them on /metrics, over a real socket.
Physical panel visibility is not provable by anything here, and nothing here claims it."""
import http.client, importlib.util, os, re, shutil, subprocess, sys, tempfile, threading

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("serve", os.path.join(HERE, "..", "serve.py"))
S = importlib.util.module_from_spec(spec); spec.loader.exec_module(S)

fails = []
def chk(n, c, detail=""):
    print(("PASS  " if c else "FAIL  ") + n + (("  [" + str(detail)[:300] + "]") if (detail and not c) else ""))
    if not c: fails.append(n)

PROMTOOL = shutil.which("promtool") or os.path.expanduser("~/.local/bin/promtool")
HAVE_PROMTOOL = os.path.isfile(PROMTOOL) and os.access(PROMTOOL, os.X_OK)
LINE = re.compile(r'^([a-z_][a-z0-9_]*)(\{([a-z_]+="[^"]*"(,[a-z_]+="[^"]*")*)?\})? ([-+]?[0-9]+(\.[0-9]+)?)$')

def series(text):
    out = {}
    for ln in text.splitlines():
        if not ln or ln.startswith("#"):
            continue
        m = LINE.match(ln)
        if not m:
            raise ValueError("bad exposition line: %r" % ln)
        out[m.group(1) + (m.group(2) or "")] = float(m.group(5))
    return out

def promtool_ok(text):
    if not HAVE_PROMTOOL:
        return True, "promtool absent: strict parser only"
    r = subprocess.run([PROMTOOL, "check", "metrics"], input=text, capture_output=True, text=True, timeout=60)
    # check metrics exits 0 on clean input; lint warnings would also be non-zero, which we want.
    return r.returncode == 0, r.stdout + r.stderr

# ---- 1. well-formed state ---------------------------------------------------------------------
t = S.metrics_text({"ts": 1760000000.25, "mode": "LIVE"}, {"loopback": 1760000001.5})
ok, why = promtool_ok(t)
chk("1: exposition passes promtool check metrics", ok, why)
s = series(t)
chk("1: snapshot timestamp exported as served", s.get("netframe_wall_snapshot_timestamp_seconds") == 1760000000.25)
chk("1: mode LIVE is one-hot", s.get('netframe_wall_mode{mode="LIVE"}') == 1
    and sum(v for k, v in s.items() if k.startswith("netframe_wall_mode")) == 1)
chk("1: every mode of the vocabulary plus UNKNOWN is present (0 or 1)",
    all('netframe_wall_mode{mode="%s"}' % m in s for m in S.WALL_MODES + ("UNKNOWN",)))
chk("1: the loopback poll time is exported",
    s.get('netframe_wall_api_state_last_request_timestamp_seconds{peer="loopback"}') == 1760000001.5)
chk("1: a peer that never polled is omitted, not 0",
    'netframe_wall_api_state_last_request_timestamp_seconds{peer="remote"}' not in s)

# ---- 2. absent or malformed facts never become healthy series --------------------------------
for label, st in (("mode missing", {"ts": 5.0}), ("mode outside the vocabulary", {"ts": 5.0, "mode": "GREEN"}),
                  ("mode lower-case", {"ts": 5.0, "mode": "live"})):
    s = series(S.metrics_text(st, {}))
    chk("2: %s reads as UNKNOWN, never LIVE" % label,
        s['netframe_wall_mode{mode="UNKNOWN"}'] == 1 and s['netframe_wall_mode{mode="LIVE"}'] == 0)
for label, ts in (("missing", None), ("a string", "1760000000"), ("NaN", float("nan")),
                  ("infinite", float("inf")), ("a bool", True)):
    st = {"mode": "LIVE"} if ts is None else {"ts": ts, "mode": "LIVE"}
    t = S.metrics_text(st, {})
    s = series(t)
    chk("2: ts %s is omitted (UNKNOWN downstream), never exported" % label,
        "netframe_wall_snapshot_timestamp_seconds" not in s)
    chk("2: ts %s still yields valid exposition" % label, promtool_ok(t)[0], promtool_ok(t)[1])
chk("2: the boot MOCK state (ts 0) is exported truthfully, so it reads as stale, not fresh",
    series(S.metrics_text({"ts": 0, "mode": "MOCK"}, {}))["netframe_wall_snapshot_timestamp_seconds"] == 0)
for m in S.WALL_MODES:
    s = series(S.metrics_text({"ts": 1.0, "mode": m}, {}))
    chk("2: mode %s is one-hot" % m, s['netframe_wall_mode{mode="%s"}' % m] == 1
        and sum(v for k, v in s.items() if k.startswith("netframe_wall_mode")) == 1)

# ---- 3. peer classification -------------------------------------------------------------------
for a, want in (("127.0.0.1", "loopback"), ("127.0.1.1", "loopback"), ("::1", "loopback"),
                ("::ffff:127.0.0.1", "loopback"), ("192.168.10.61", "remote"), ("192.168.10.133", "remote"),
                ("", "remote"), (None, "remote")):
    chk("3: %r is %s" % (a, want), S._peer(a) == want)

# ---- 4. the real handler, over a real socket ----------------------------------------------------
S.STATE = {"ts": 1234.5, "mode": "DEGRADED", "sources": {}, "panels": {}}
S.API_STATE_SEEN.clear()
srv = S.ThreadingHTTPServer(("127.0.0.1", 0), S.H)
port = srv.server_address[1]
th = threading.Thread(target=srv.serve_forever, daemon=True); th.start()
try:
    def get(path):
        c = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
        c.request("GET", path); r = c.getresponse(); b = r.read().decode(); c.close()
        return r.status, r.getheader("Content-Type"), b
    st, ct, body = get("/metrics")
    s = series(body)
    chk("4: /metrics answers 200 text/plain", st == 200 and ct.startswith("text/plain"), (st, ct))
    chk("4: before any poll, no poll timestamp is exported",
        not any(k.startswith("netframe_wall_api_state_last_request") for k in s), body)
    chk("4: /metrics does not itself count as an /api/state poll", not S.API_STATE_SEEN)
    st, _, _ = get("/api/state")
    st2, _, body = get("/metrics")
    s = series(body)
    chk("4: a loopback /api/state poll is recorded and exported",
        st == 200 and 'netframe_wall_api_state_last_request_timestamp_seconds{peer="loopback"}' in s, body)
    chk("4: served mode and ts match STATE", s['netframe_wall_mode{mode="DEGRADED"}'] == 1
        and s["netframe_wall_snapshot_timestamp_seconds"] == 1234.5)
    chk("4: /healthz is unchanged", get("/healthz")[0] == 200)
    chk("4: served exposition passes promtool", promtool_ok(body)[0], promtool_ok(body)[1])
finally:
    srv.shutdown(); srv.server_close()

print("p13: %d failed" % len(fails))
sys.exit(1 if fails else 0)
