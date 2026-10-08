#!/usr/bin/env python3
"""Render harness - serves the REAL netframe-dashboard.html with scenario API responses.

NO production access: nothing here reaches the estate. The page runs its own fetch path against
fixtures derived from tests/fixtures/api-state-sample.json (sanitized), the pinned incident contract
fixture and a proposal envelope shaped like the live feed. Timestamps are rewritten at request time.

    python3 tests/render/fixture_server.py <scenario> <port>
    then open http://localhost:<port>/            (add ?probe=1 to append tests/render/probe.js)

Scenarios: normal degraded critical overflow crowded startup stale disconnected future recovered
           packetc packetc-long packetc-unknown (Packet C Wazuh strings; see test_p11_layout_fit.mjs)
"""
import copy, json, os, sys, time, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..", "..")
FIX = os.path.join(HERE, "..", "fixtures")
SCEN = sys.argv[1] if len(sys.argv) > 1 else "normal"
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8900
START = time.time()
CALLS = {"state": 0}

load = lambda n: json.load(open(os.path.join(FIX, n), encoding="utf-8"))
SAMPLE = load("api-state-sample.json")
INCIDENT = load("netframe-live-dashboard-feed-v1.json")
iso = lambda t: datetime.datetime.fromtimestamp(t, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def snapshot(gen):
    """Every timestamp is relative to `gen`, the moment the backend GENERATED this snapshot, exactly as
    serve.py stamps them: ts = gen, FRESH panels observed at gen, the collector finished 240 s before
    gen (its own clock), the failover posture observed at that same collector run. A stale snapshot is
    therefore internally consistent: everything in it is old by the same amount."""
    s = copy.deepcopy(SAMPLE)
    s.pop("_comment", None)
    s["ts"] = gen
    for p in s["panels"].values():
        p["observed_at"] = round(gen); p["fresh_at"] = gen; p["age"] = 0
    s["panels"]["monitor"].update(fresh_at=gen - 240, age=240)
    s["collector"].update(finished_at=gen - 240, started_at=gen - 312)
    s["opnsense"]["failover"]["observed_at"] = gen - 240
    return s


def stale_panel(s, name, age):
    """Carried panel: its fresh_at is its ORIGINAL observation, `age` seconds before the snapshot."""
    s["panels"][name].update(state="STALE", age=age, fresh_at=s["ts"] - age)
    s["mode"] = "DEGRADED"


def proposals(now, security=4868):
    items = [{"proposal_id": "WZP-SAMPLE-%04d" % i, "source_kind": "wazuh",
              "title": "Executable file dropped in folder commonly used by malware",
              "detail": "rule 92213 level 15 on endpoint-1", "proposal_state": "PENDING",
              "source_condition": "DETECTION_RECORDED", "age_seconds": 1823505 - i * 60,
              "suggested_event": "DETECTED", "suggested_affected_systems": [],
              "possible_existing_incident_count": 0, "action_class": "SECURITY"} for i in range(3)]
    return {"schema": "netframe-proposal-dashboard-feed/v2", "generated_at": iso(now - 3),
            "collector": {"status": "AVAILABLE", "observed_at": iso(now - 70), "age_seconds": 70.0,
                          "reason": "the intake collector observed its source recently"},
            "summary": {"counts_are_authoritative": True, "awaiting_owner_review": security + 56,
                        "owner_action_required": security, "resolved_history": 56,
                        "security_pending": security, "pending_firing": 0, "pending_cleared": 56,
                        "pending_detections": security},
            "proposals": items, "more_not_shown": security + 53,
            "authority": {"max_auto_class": 0}}


def incident(now):
    if SCEN != "crowded":
        return {"schema": "netframe-live-dashboard-feed/v1", "generated_at": iso(now - 3), "status": "NO_SELECTION",
                "selection": None, "state": None, "state_generated_at": None, "error": None}
    f = copy.deepcopy(INCIDENT)
    f["generated_at"] = iso(now - 3); f["state_generated_at"] = iso(now - 3)
    if isinstance(f.get("state"), dict) and isinstance(f["state"].get("cycle"), dict):
        f["state"]["cycle"]["at"] = iso(now - 3)
    return f


def replayed(now):
    """scenario `replay`: a REAL captured /api/state (sanitized), shifted in time so that it was
    generated 4 s ago. Every timestamp moves by the same delta, so relative ages are preserved."""
    s = json.load(open(os.environ["NFM_REPLAY_STATE"], encoding="utf-8"))
    d = (now - 4) - s["ts"]
    s["ts"] += d
    for p in (s.get("panels") or {}).values():
        for k in ("fresh_at", "observed_at"):
            if isinstance(p.get(k), (int, float)): p[k] += d
    fo = (s.get("opnsense") or {}).get("failover") or {}
    if isinstance(fo.get("observed_at"), (int, float)): fo["observed_at"] += d
    for k in ("finished_at", "started_at"):
        if isinstance((s.get("collector") or {}).get(k), (int, float)): s["collector"][k] += d
    return s


def state(now):
    if SCEN == "replay":
        return replayed(now)
    CALLS["state"] += 1
    # stale: the backend keeps answering, but the last snapshot it built is 400 s old (and has a
    # carried UPS panel that was already 300 s stale when it was built: 700 s old at request time)
    s = snapshot(now - 400 if SCEN == "stale" else now - 4)
    if SCEN == "stale":
        stale_panel(s, "ups", 300)
    if SCEN == "degraded":
        s["opnsense"]["wan2"].update(gw="Offline", lat=None, loss=100.0, down_bps=0)
        stale_panel(s, "ups", 400)
        s["integrity"][3].update(v="412", s="y")
    elif SCEN in ("critical", "crowded"):
        s["nodes"]["pve3"] = {"st": "r"}
        next(x for x in s["services"] if x["n"] == "Vaultwarden")["s"] = "r"
        s["k8s"]["ready"] = 3; s["k8s"]["pods"] = 44
        s["ups_status"]["units"]["tripplite"]["status"] = "OB DISCHRG"
        s["ups_status"]["verdict"] = "WARN"
    elif SCEN == "overflow":
        for h in ("pve2", "pve3", "pve4", "pve5", "Randy"):
            s["nodes"][h] = {"st": "r"}
        for n in ("Vaultwarden", "Grafana", "Headscale", "Home Assistant", "Proxmox Backup", "Open WebUI", "Wazuh SIEM"):
            next(x for x in s["services"] if x["n"] == n)["s"] = "r"
        for i, v in ((0, "FAIL"), (1, "DRIFT"), (7, "FLOW 0"), (9, "CHECK")):
            s["integrity"][i].update(v=v, s="r")
        s["integrity"][3].update(v="912", s="y")
        s["k8s"]["ready"] = 2
        s["opnsense"]["wan1"].update(gw="Offline"); s["opnsense"]["wan2"].update(gw="Offline")
        s["ups_status"]["units"]["tripplite"]["status"] = "OB LB"; s["ups"]["tripplite"].update(batt=31.0, runtime=3)
        stale_panel(s, "switch", 1200); stale_panel(s, "slurm", 600)
    elif SCEN == "future":
        s["ts"] = now + 3600
    elif SCEN in ("packetc", "packetc-long", "packetc-unknown"):
        # Packet C as deployed 2026-10-07: the Integrity chip carries the full measured reason. These
        # strings are what widened the stage past 1920 px before test_p11_layout_fit existed.
        wz_i = next(x for x in s["integrity"] if x["k"] == "Wazuh SIEM")
        wz_s = next(x for x in s["services"] if x["n"] == "Wazuh SIEM")
        if SCEN == "packetc":                      # the live estate: services fine, auth blind
            wz_i.update(v="CRITICAL · AUTH MAJORITY STALE · AUTH 1/9 FRESH · AGENTS 9/9 · DROPS 0", s="r")
        elif SCEN == "packetc-long":               # worst case: serve.py caps labels at 72 characters
            wz_i.update(v=("CRITICAL · AUTH MAJORITY STALE · INDEXER FAILED · FILEBEAT NOT SHIPPING"
                           " · AUTH 0/9 FRESH · AGENTS 3/9 · DROPS 1234567"), s="r")
            wz_s.update(s="r", d="CRITICAL · INDEXER FAILED · INDEXER START TIMEOUT · FILEBEAT NOT SHIPP")
        else:                                      # fail-visible: nothing measured
            wz_i.update(v="UNKNOWN · LEGACY CHECK", s="u")
            wz_s.update(s="u", d="UNKNOWN · LEGACY CHECK")
    return s


class H(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype):
        self.send_response(code); self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body))); self.send_header("Cache-Control", "no-store")
        self.end_headers(); self.wfile.write(body)

    def do_GET(self):
        now = time.time()
        path, _, q = self.path.partition("?")
        if path in ("/", "/index.html"):
            CALLS["state"] = 0                     # each page load replays the scenario from its start
            body = open(os.path.join(ROOT, "netframe-dashboard.html"), "rb").read()
            if "probe=1" in q:
                body += b"\n<script>" + open(os.path.join(HERE, "probe.js"), "rb").read() + b"</script>"
            return self._send(200, b"<!doctype html><meta charset=utf-8>" + body, "text/html; charset=utf-8")
        if path == "/api/state":
            if SCEN == "startup":
                time.sleep(30); return self._send(503, b"{}", "application/json")      # never answers in time
            if SCEN == "disconnected" and CALLS["state"] >= 1:
                return self._send(503, b"{}", "application/json")                       # one good sample, then gone
            if SCEN == "recovered" and 1 <= CALLS["state"] < 3:
                CALLS["state"] += 1; return self._send(503, b"{}", "application/json")  # restart window
            return self._send(200, json.dumps(state(now)).encode(), "application/json")
        if path == "/api/incident":
            return self._send(200, json.dumps(incident(now)).encode(), "application/json")
        if path == "/api/proposals":
            return self._send(200, json.dumps(proposals(now)).encode(), "application/json")
        self._send(404, b"not found", "text/plain")

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    print("fixture server: scenario=%s port=%d" % (SCEN, PORT), flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
