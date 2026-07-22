# NetFRAME Dashboard

Cyberpunk wall-mounted operations dashboard for the **km-cluster** homelab —
a single self-contained page + a zero-dependency Python aggregator, displayed
full-screen on a Raspberry Pi 4 kiosk (Dell P2722H, 1920×1080).

## Files
- **`netframe-dashboard.html`** — the whole UI. Pixel-locked 1920×1080, auto-scaled
  to the display (`SAFE` factor leaves a border against monitor overscan). Each panel
  reads from a single object; polls `/api/state` and falls back to animated mock if the
  proxy is unreachable.
- **`serve.py`** — serves the page and exposes **`/api/state`**, a live snapshot refreshed
  every ~5s by a background thread (serves last-good on any source hiccup). Python 3 stdlib
  only. Runs on both Ares (dev) and the Pi (production).

## Live sources (8)
Prometheus (node CPU/RAM/disk, UPS via PeaNUT, Pi-hole up/down, GPU via nvidia_gpu_exporter,
EX3400 via snmp_exporter) · netframe-monitor `last_run.json` (integrity strip, services, SMART) ·
SLURM (QuarkyLab) · RKE2 (node/pod counts) · Pi-hole v6 API · OPNsense API (dual-WAN + states).

## Run
    python3 serve.py 8088        # -> http://localhost:8088

Credentials (Pi-hole/OPNsense/k8s token) live in `~/.config/netframe-dashboard.env` (mode 600) —
**never committed**.

## Production (the wall Pi)
Self-contained + least-privilege: reaches its data sources over SSH **forced-command wrappers**
(read-only queries only) and a **read-only Kubernetes token** — no admin credentials on the Pi.
`netframe-dashboard.service` (systemd) serves it; a `getty@tty1` autologin launches
`cage` + Chromium `--kiosk` (`--ozone-platform=wayland`, pinned to the connected DRM card).
See the project memory / `WALL-MOUNT.md` on the Pi for the full deploy.
