# Apply block: make NetFRAME query Prometheus directly (kill the `pct exec` storm)

**Goal:** dashboard clients query Prometheus over the LAN at `http://<REDACTED-IP>:9090`
instead of `ssh <cluster-node-4> -> pct exec 103 -> curl localhost:9090`. Deletes the per-metric
`lxc-attach` overhead that pushed <cluster-node-4> to load ~20.

**Order matters:** do Part A (expose Prometheus) and verify it BEFORE Part B
(repoint serve.py). If serve.py is repointed first, the dashboard goes blank until
the port is open.

Rollback for each part is at the bottom.

---

## Part A — Expose Prometheus on the LAN (operator, on <cluster-node-4>)

Additive change: keeps the existing `127.0.0.1:9090` binding (so `nfm-prom` still
works during transition) and adds a `<REDACTED-IP>:9090` binding. Done in the
override file so the base compose stays untouched.

### A0. Read-only pre-check
```bash
ssh root@<REDACTED-IP> 'pct exec 103 -- ss -tlnp | grep 9090'
# expect: LISTEN 127.0.0.1:9090  (only)
```

### A1. Add the prometheus override
```bash
ssh root@<REDACTED-IP> 'pct exec 103 -- bash -lc "
cp /opt/grafana/docker-compose.override.yml /opt/grafana/docker-compose.override.yml.bak
cat >> /opt/grafana/docker-compose.override.yml <<\"YAML\"
  prometheus:
    ports:
      - 127.0.0.1:9090:9090
      - <REDACTED-IP>:9090:9090
YAML
echo --- new override ---; cat /opt/grafana/docker-compose.override.yml
"'
```
> Note the two-space indent under `services:` — the override already opens with
> `services:`, so `prometheus:` sits at the same level as the existing
> `snmp-exporter:`. Verify the printed file looks right before A2.

### A2. Recreate just prometheus
```bash
ssh root@<REDACTED-IP> 'pct exec 103 -- bash -lc "cd /opt/grafana && docker compose up -d prometheus"'
```

### A3. Verify (host + from Ares over the LAN)
```bash
ssh root@<REDACTED-IP> 'pct exec 103 -- ss -tlnp | grep 9090'
# expect: BOTH 127.0.0.1:9090 and <REDACTED-IP>:9090

# from Ares, straight over the network (no ssh/pct):
curl -s 'http://<REDACTED-IP>:9090/api/v1/query?query=up' | head -c 200; echo
# expect: {"status":"success",...}
```
If A3 succeeds, Part A is done and safe to leave even if you stop here — nothing
that used the old path breaks.

---

## Part B — Repoint serve.py (Ares + Pi .133), after A3 passes

Only `prom()` changes. All of `prom_by/prom_series/prom_scalar` call it and keep the
same return contract, so nothing else is touched. SSH is still used elsewhere
(netframe-monitor `last_run.json`, host reachability) — leave that alone.

### B1. Replace prom() in ~/netframe-dashboard/serve.py

Old:
```python
def prom(query):
    """Run one instant PromQL query via the <cluster-node-4> nfm-prom wrapper (query on stdin)."""
    out = sh(SSH + ["<cluster-node-4>", "nfm-prom"], input=query)
    try:
        return json.loads(out)["data"]["result"]
    except Exception:
        return []
```

New:
```python
PROM_URL = "http://<REDACTED-IP>:9090"   # Prometheus in grafana CT103, LAN-exposed

def prom(query):
    """Instant PromQL query straight to Prometheus over the LAN (no ssh/pct exec)."""
    try:
        body = urllib.parse.urlencode({"query": query}).encode()
        req  = urllib.request.Request(PROM_URL + "/api/v1/query", data=body)  # POST: long queries ok
        with urllib.request.urlopen(req, timeout=8) as r:
            return json.loads(r.read())["data"]["result"]
    except Exception:
        return []
```
(`urllib.parse`, `urllib.request`, `json` are already imported at the top.)

### B2. Deploy to both hosts
```bash
# Ares (this machine): edit already made -> restart
systemctl --user restart netframe-dashboard.service

# Pi .133: copy the same serve.py and restart the system service
scp ~/netframe-dashboard/serve.py machismo@<REDACTED-IP>:/home/machismo/netframe-dashboard/serve.py
ssh machismo@<REDACTED-IP> 'sudo systemctl restart netframe-dashboard.service'
```

### B3. Verify
```bash
curl -s http://localhost:8088/state | head -c 200; echo          # Ares dashboard populated
ssh root@<REDACTED-IP> 'ps -eo comm | grep -c "^pct$"'          # expect 0 (steady state)
ssh root@<REDACTED-IP> uptime                                   # load should fall toward ~1-2
```

### B4. (optional) restore fast refresh
Direct HTTP is cheap, so REFRESH can go back to 5s if you want a snappier wall
display — edit `REFRESH` in serve.py on both hosts and restart. (Left at 30 for now.)

---

## Rollback
- **Part B:** restore the old `prom()` and restart the two services. (git: `git -C ~/netframe-dashboard checkout serve.py` if tracked.)
- **Part A:** `pct exec 103 -- bash -lc "mv /opt/grafana/docker-compose.override.yml.bak /opt/grafana/docker-compose.override.yml && cd /opt/grafana && docker compose up -d prometheus"`

## Security note
`<REDACTED-IP>:9090` is Prometheus with **no auth**, reachable by anything on the
Servers/LAN. Fine for a trusted homelab. To tighten, restrict TCP/9090 on
<REDACTED-IP> to just Ares (.152) and the Pi (.133) via the host/OPNsense firewall.

## Follow-ups (not required)
- Once B is stable, the `nfm-prom` wrapper on <cluster-node-4> and the `127.0.0.1:9090` line in
  the override can be retired.
- The Pi .133 runs a *duplicate* dashboard. If Ares:8088 is your only real display,
  consider `sudo systemctl disable --now netframe-dashboard` on the Pi instead of
  keeping two pollers.
