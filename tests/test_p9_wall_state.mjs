/* P9 offline wall-state fixtures - NO production access, no DOM, no network.
   Extracts the shipped pure blocks and proves the wall's truth rules:
     A  no production value is ever simulated or defaulted to healthy
     B  lamp precedence: green needs current evidence; faults always show; feeds stay independent
     C  conditions are independent - nothing merged, no inferred cause
     D  the WAN posture reaches the renderer from the real snapshot shape (was dropped by applyLive)
     E  request ordering: an older response never overwrites newer state; restart / clock recovery
     F  link state: awaiting, lost, stale-over-HTTP-200, ages keep advancing
     G  decoration is not proof of health (heartbeat, beam)
     H  future timestamps are invalid in every feed, never "very fresh" */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(HERE, '..', 'netframe-dashboard.html'), 'utf8');
const blk = (n) => { const m = html.match(new RegExp('/\\* ' + n + '-BEGIN[\\s\\S]*?/\\* ' + n + '-END \\*/'));
  if (!m) { console.error('FAIL  cannot extract ' + n); process.exit(1); } return m[0]; };
const ageFn = html.match(/function nfmAgeText\(sec\)\{[\s\S]*?\n\}/)[0];
const F = new Function(ageFn + blk('NFM-DISPLAY-STATE') + blk('NFM-INCIDENT-PANEL') + blk('NFM-PROPOSAL-PANEL')
  + blk('NFM-INVENTORY') + blk('NFM-MODEL') + blk('NFM-CONDITIONS') + blk('NFM-LAMPS') + blk('NFM-LINK')
  + '\n return {nfmAgeText,nfmDisplayState,nfmWanPosture,nfmIncidentState,nfmProposalState,NFM_INV,nfmModel,nfmPanelAge,nfmProposalPanel,'
  + 'nfmUpsState,nfmConditions,nfmNotMeasured,nfmLamps,nfmSampleTracker,nfmLatestGate,nfmLinkState,nfmHeartbeat,nfmBeamMode};')();

let fails = [];
const chk = (n, c, d) => { console.log((c ? 'PASS  ' : 'FAIL  ') + n + (!c && d !== undefined ? '  [' + JSON.stringify(d) + ']' : '')); if (!c) fails.push(n); };
const NOW = 1790821100;
const iso = (t) => new Date(t * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
const SAMPLE = JSON.parse(readFileSync(join(HERE, 'fixtures', 'api-state-sample.json'), 'utf8'));
const snap = (mut) => { const s = JSON.parse(JSON.stringify(SAMPLE)); s.ts = NOW - 5;
  for (const p of Object.values(s.panels)) { p.fresh_at = NOW - 5; p.observed_at = NOW - 5; } if (mut) mut(s); return s; };
const INC_FIX = JSON.parse(readFileSync(join(HERE, 'fixtures', 'netframe-live-dashboard-feed-v1.json'), 'utf8'));
const PROP_FIX = JSON.parse(readFileSync(join(HERE, 'fixtures', 'netframe-proposal-dashboard-feed-v2.json'), 'utf8'));
const noSel = { schema: 'netframe-live-dashboard-feed/v1', status: 'NO_SELECTION', generated_at: iso(NOW - 3),
                selection: null, state: null, state_generated_at: null, error: null };
const props = (mut) => { const p = JSON.parse(JSON.stringify(PROP_FIX)); p.generated_at = iso(NOW - 3); if (mut) mut(p); return p; };
const view = (s, inc, prop, link) => {
  const L = link || { snap: s, okAt: NOW - 1, fails: 0 };
  const ds = F.nfmLinkState(L, NOW), m = F.nfmModel(L.snap), wan = F.nfmWanPosture(m.opn), conds = F.nfmConditions(m, wan, NOW);
  return { ds, m, wan, conds, lamps: F.nfmLamps(ds, m, conds, inc === undefined ? noSel : inc, prop === undefined ? props() : prop, NOW) };
};
const lamp = (v, k) => v.lamps.find(l => l.key === k);

/* ---------------------------------------------------------------- A: nothing is simulated */
{
  chk('A: the shipped page contains no random-number generator at all', !/Math\.random/.test(html));
  chk('A: the mock tick and the mock DATA object are gone', !/mockTick|const DATA\s*=/.test(html));
  for (const lit of ['MGMT CARD FAILED', 'cluster quorate', '1144 W', "w:752", 'used:4300', "180d → 90%", "k:'Capacity'"]) {
    chk('A: no fabricated literal "' + lit + '" remains', !html.includes(lit));
  }
  const m = F.nfmModel(null);
  chk('A: an empty model has no node measurements', Object.values(m.nodes).every(n => n.cpu === null && n.ramU === null && n.disk === null && n.st === null));
  chk('A: an empty model has no UPS measurements', Object.values(m.ups).every(u => u.load === null && u.batt === null && u.runtime === null));
  chk('A: an empty model reports no services and no integrity (not "all green")', m.services === null && m.integrity === null);
  const part = F.nfmModel(snap(s => { delete s.ups; delete s.nodes.pve3; delete s.nodes.pve1.cpu; }));
  chk('A: a missing UPS block is null, never a default runtime', part.ups.tripplite.runtime === null && part.ups.midatlantic.load === null);
  chk('A: a missing host is null, never a default status', part.nodes.pve3.st === null && part.nodes.pve3.cpu === null);
  chk('A: a missing field inside a present host is null; siblings survive', part.nodes.pve1.cpu === null && part.nodes.pve1.ramU === 14.8);
  const nan = F.nfmModel(snap(s => { s.nodes.pve2.cpu = 'NaN'; s.nodes.pve2.disk = null; s.ups.tripplite.runtime = 0; }));
  chk('A: a non-numeric value is null, not 0', nan.nodes.pve2.cpu === null && nan.nodes.pve2.disk === null);
  chk('A: a real zero stays zero (zero, null and unknown remain distinct)', nan.ups.tripplite.runtime === 0);
  const svc = F.nfmModel(snap(s => { s.services[0].s = 'bogus'; }));
  chk('A: an unrecognised service state is unknown, never green', svc.services[0].s === 'u');
  const aw = view(null, undefined, undefined, { snap: null, okAt: null, fails: 0 });
  chk('A: before the first sample nothing is green', aw.lamps.every(l => l.sev !== 'g'), aw.lamps.map(l => l.sev));
  chk('A: before the first sample confidence says AWAITING', lamp(aw, 'conf').value === 'AWAITING');
}

/* ---------------------------------------------------------------- B: precedence */
{
  const ok = view(snap());
  chk('B: all fresh, no faults -> INFRASTRUCTURE NO FAULTS (green)', lamp(ok, 'infra').sev === 'g' && lamp(ok, 'infra').value === 'NO FAULTS');
  chk('B: ...and TELEMETRY CONFIDENCE CURRENT', lamp(ok, 'conf').sev === 'g' && lamp(ok, 'conf').value === 'CURRENT');
  chk('B: the retired phrase "ALL SYSTEMS NOMINAL" is nowhere on the page', !html.includes('ALL SYSTEMS NOMINAL'));
  const blind = view(snap(s => { s.panels.ups.state = 'STALE'; s.panels.ups.age = 400; s.panels.ups.fresh_at = s.ts - 400; s.mode = 'DEGRADED'; }));
  chk('B: one blind source and no faults -> NOT green ("NO FAULTS SEEN")',
      lamp(blind, 'infra').sev === 'u' && lamp(blind, 'infra').value === 'NO FAULTS SEEN', lamp(blind, 'infra'));
  chk('B: ...confidence PARTIAL names the blind source with its age', lamp(blind, 'conf').value === 'PARTIAL' && /ups 7m/.test(lamp(blind, 'conf').why), lamp(blind, 'conf').why);
  const faultBlind = view(snap(s => { s.nodes.pve3.st = 'r'; s.panels.ups.state = 'STALE'; s.panels.ups.age = 400; s.panels.ups.fresh_at = s.ts - 400; s.mode = 'DEGRADED'; }));
  chk('B: a measured fault shows even while another source is blind', lamp(faultBlind, 'infra').value === 'CRITICAL');
  const stale = view(snap(s => { s.ts = NOW - 600; s.nodes.pve3.st = 'r'; }));
  chk('B: a stale snapshot (HTTP fine) makes INFRASTRUCTURE UNKNOWN, not CRITICAL or green', lamp(stale, 'infra').sev === 'u');
  chk('B: ...but still says what was last known', /last known: 1 critical · pve3/.test(lamp(stale, 'infra').why), lamp(stale, 'infra').why);
  chk('B: ...and confidence is STALE (red)', lamp(stale, 'conf').value === 'STALE' && lamp(stale, 'conf').sev === 'r');
  const off = view(snap(), undefined, undefined, { snap: snap(), okAt: NOW - 30, fails: 3 });
  chk('B: backend unreachable -> confidence NO DATA', lamp(off, 'conf').value === 'NO DATA');
  chk('B: NO_SELECTION is dim, never green (contract rule 2)', lamp(ok, 'inc').sev === 'd' && lamp(ok, 'inc').value === 'NONE SELECTED');
  const incDown = view(snap(), null);
  chk('B: an unreachable incident feed is FEED DOWN, not "no incident"', lamp(incDown, 'inc').value === 'FEED DOWN' && lamp(incDown, 'inc').sev === 'y');
  const propDown = view(snap(), undefined, null);
  chk('B: unavailable proposal intake is UNKNOWN, never 0', lamp(propDown, 'own').value === 'UNKNOWN' && lamp(propDown, 'own').value !== '0');
  const stalecoll = view(snap(), undefined, props(p => { p.collector.status = 'STALE'; }));
  chk('B: a stale intake collector is UNKNOWN, never a count', lamp(stalecoll, 'own').value === 'UNKNOWN');
  /* OWNER REVIEW severity is the existing nfmProposalState tone - unchanged, not reclassified */
  const sec = props(p => { p.summary.security_pending = 4868; p.summary.owner_action_required = 4868; });
  const ps = F.nfmProposalState(sec, NOW);
  const sv = view(snap(), undefined, sec);
  chk('B: a security backlog keeps the existing red tone on OWNER REVIEW', ps.tone === 'crit' && lamp(sv, 'own').sev === 'r');
  chk('B: ...the count shown is owner_action_required, unchanged', lamp(sv, 'own').value === '4868');
  chk('B: ...and it does not add to the infrastructure count', lamp(sv, 'infra').value === 'NO FAULTS');
  /* independence: losing /api/state must not erase or re-judge another feed */
  const live = view(snap(), undefined, sec);
  const lost = view(snap(), undefined, sec, { snap: snap(), okAt: NOW - 60, fails: 5 });
  chk('B: losing /api/state leaves the INCIDENT lamp exactly as its own feed says',
      JSON.stringify(lamp(live, 'inc')) === JSON.stringify(lamp(lost, 'inc')));
  chk('B: losing /api/state leaves OWNER REVIEW exactly as its own feed says',
      JSON.stringify(lamp(live, 'own')) === JSON.stringify(lamp(lost, 'own')));
}

/* ---------------------------------------------------------------- C: independent conditions */
{
  const v = view(snap(s => { s.nodes.pve3.st = 'r'; s.services.find(x => x.n === 'Vaultwarden').s = 'r'; s.k8s.ready = 3; }));
  const crit = v.conds.filter(c => c.sev === 'r');
  chk('C: three independent faults stay three entries (nothing merged)', crit.length === 3, crit.map(c => c.sys));
  chk('C: each names its own system', ['pve3', 'Vaultwarden', 'RKE2'].every(n => crit.some(c => c.sys === n)));
  chk('C: no entry infers a cause', v.conds.every(c => !/affect|caused by|because|root cause|due to/i.test(c.text)), v.conds.map(c => c.text));
  chk('C: faults without an authoritative cause say "cause not determined"', crit.every(c => /cause not determined/.test(c.text)));
  chk('C: a placement fact is labelled INVENTORY, not presented as a dependency', /INVENTORY CT102·pve3/.test(crit.find(c => c.sys === 'Vaultwarden').text));
  chk('C: the lamp names every critical system', ['pve3', 'Vaultwarden', 'RKE2'].every(n => lamp(v, 'infra').why.includes(n)), lamp(v, 'infra').why);
  chk('C: worst first', v.conds.map(c => c.sev).join('') === v.conds.map(c => c.sev).sort((a, b) => 'ryu'.indexOf(a) - 'ryu'.indexOf(b)).join(''));
  const ups = (st, rt, batt) => F.nfmUpsState(F.nfmModel(snap(s => { s.ups_status.units.tripplite.status = st;
    if (rt !== undefined) s.ups.tripplite.runtime = rt; if (batt !== undefined) s.ups.tripplite.batt = batt; })), 'tripplite');
  chk('C: UPS on line with 9 min runtime is NOT a fault (above the existing 5-min alert)', ups('OL', 9).sev === 'g');
  chk('C: UPS on battery is a warning', ups('OB DISCHRG', 9).sev === 'y' && ups('OB DISCHRG', 9).label === 'ON BATTERY');
  chk('C: UPS low battery is critical', ups('OB LB', 3).sev === 'r');
  chk('C: runtime below the EXISTING 5-min alert is critical even on line', ups('OL', 4).sev === 'r' && ups('OL', 4).below);
  chk('C: charge below the EXISTING 50 % alert is critical', ups('OL', 20, 45).sev === 'r');
  chk('C: no status reported is unknown, never "on line"', ups(null, 9).sev === 'u' && ups(null, 9).label === 'STATUS UNKNOWN');
  const rep = view(snap(s => { s.ups_status.reporting = 1; }));
  chk('C: only 1 of 2 UPS reporting is an unknown, named', rep.conds.some(c => c.sev === 'u' && /only 1 of 2/.test(c.text)));
  const st = view(snap(s => { s.panels.switch.state = 'STALE'; s.panels.switch.age = 900; s.panels.switch.fresh_at = s.ts - 900; s.mode = 'DEGRADED'; }));
  chk('C: a stale source is listed as unknown TELEMETRY, not as a warning', st.conds.some(c => c.dom === 'TELEMETRY' && c.sev === 'u') && !st.conds.some(c => c.sev === 'y'));
  const lk = view(snap(s => { s.nodes.pve2.st = 'r'; s.panels.prometheus.state = 'STALE'; s.panels.prometheus.age = 300; s.panels.prometheus.fresh_at = s.ts - 300; s.mode = 'DEGRADED'; }));
  chk('C: a fault from carried data says LAST KNOWN with its age', /LAST KNOWN 5m/.test(lk.conds.find(c => c.sys === 'pve2').text));
  chk('C: services with no reporting check are listed as NOT MEASURED (no check reported), not as healthy', F.nfmNotMeasured(F.nfmModel(snap())).some(x => x === 'OPNsense (no check reported)'));
}

/* ---------------------------------------------------------------- D: WAN propagation */
{
  const v = view(snap());
  chk('D: the real snapshot shape reaches the posture (failover/monitor/gw_addr kept) -> READY', v.wan.state === 'READY', v.wan);
  chk('D: no WAN condition when READY', !v.conds.some(c => c.dom === 'WAN'));
  const nf = view(snap(s => { s.opnsense.wan2.gw = 'Offline'; }));
  chk('D: WAN2 offline -> NO_FAILOVER warning', nf.wan.state === 'NO_FAILOVER' && nf.conds.some(c => c.dom === 'WAN' && c.sev === 'y'));
  const pd = view(snap(s => { s.opnsense.wan1.gw = 'Offline'; delete s.opnsense.failover; }));
  chk('D: primary down, standby readiness unknown -> critical, path not claimed', pd.wan.state === 'PRIMARY_DOWN_PATH_UNKNOWN' && pd.conds.some(c => c.dom === 'WAN' && c.sev === 'r'));
  const nm = view(snap(s => { delete s.opnsense.wan1.monitor; }));
  chk('D: a missing monitor field is UNKNOWN, never READY', nm.wan.state !== 'READY');
}

/* ---------------------------------------------------------------- E: request ordering */
{
  const T = F.nfmSampleTracker();
  chk('E: first snapshot is NEW', T.accept(1, 1000) === 'NEW');
  /* overlapping requests 2 and 3 are in flight; 3 answers first */
  chk('E: overlapping requests - the newer answer is applied', T.accept(3, 1040) === 'NEW');
  chk('E: ...the older request answering late is DROPPED', T.accept(2, 1020) === 'DROP');
  chk('E: ...and does not move the tracked ts backwards', T.lastTs === 1040);
  chk('E: an out-of-order response with an equal seq is dropped', T.accept(3, 1080) === 'DROP');
  chk('E: a repeated ts from a newer request is SAME (no new sample)', T.accept(4, 1040) === 'SAME');
  chk('E: forward again is NEW', T.accept(5, 1080) === 'NEW');
  /* backend clock corrected backwards (or restarted with a corrected clock) */
  chk('E: a ts that moved backwards on a NEWER request is applied as REGRESSED', T.accept(6, 900) === 'REGRESSED');
  chk('E: ...the tracker re-bases on it', T.lastTs === 900);
  chk('E: ...and the next forward step is NEW again (heartbeat recovers)', T.accept(7, 940) === 'NEW');
  chk('E: a snapshot with no ts is not a NEW sample', T.accept(8, undefined) === 'NO_TS');
  const G = F.nfmLatestGate();
  chk('E: feed gate takes a newer response', G.take(2) === true);
  chk('E: feed gate drops an older response that arrives later', G.take(1) === false);
  chk('E: feed gate takes the next newer response', G.take(3) === true);
}

/* ---------------------------------------------------------------- F: link state */
{
  chk('F: no sample, no failures -> AWAITING', F.nfmLinkState({ snap: null, okAt: null, fails: 0 }, NOW).state === 'AWAITING');
  chk('F: no sample and 2 failures -> OFFLINE', F.nfmLinkState({ snap: null, okAt: null, fails: 2 }, NOW).state === 'OFFLINE');
  const s = snap();
  chk('F: good answer just now -> judged by the snapshot (LIVE)', F.nfmLinkState({ snap: s, okAt: NOW - 1, fails: 0 }, NOW).state === 'LIVE');
  chk('F: one transient failure does not flip the wall', F.nfmLinkState({ snap: s, okAt: NOW - 3, fails: 1 }, NOW).state === 'LIVE');
  chk('F: two consecutive failures -> OFFLINE', F.nfmLinkState({ snap: s, okAt: NOW - 6, fails: 2 }, NOW).state === 'OFFLINE');
  chk('F: no good answer for >10 s (hung request) -> OFFLINE', F.nfmLinkState({ snap: s, okAt: NOW - 11, fails: 0 }, NOW).state === 'OFFLINE');
  const L = { snap: s, okAt: NOW - 60, fails: 4 };
  const a1 = F.nfmLinkState(L, NOW).age, a2 = F.nfmLinkState(L, NOW + 60).age;
  chk('F: while the backend is gone the data age keeps advancing', a2 - a1 === 60, [a1, a2]);
  const old = snap(x => { x.ts = NOW - 400; });
  chk('F: an OLD snapshot over a working HTTP link is STALE, not LIVE', F.nfmLinkState({ snap: old, okAt: NOW - 1, fails: 0 }, NOW).state === 'STALE');
  chk('F: recovery after restart: a fresh snapshot after failures is LIVE again',
      F.nfmLinkState({ snap: snap(), okAt: NOW, fails: 0 }, NOW).state === 'LIVE');
}

/* ---------------------------------------------------------------- G: decoration is not proof */
{
  chk('G: heartbeat blips green only for a NEW, LIVE snapshot', F.nfmHeartbeat('NEW', 'LIVE') === 'g');
  chk('G: heartbeat blips amber for a NEW, partial snapshot', F.nfmHeartbeat('NEW', 'DEGRADED') === 'y');
  chk('G: a repeated snapshot over HTTP 200 never blips', F.nfmHeartbeat('SAME', 'LIVE') === null);
  chk('G: a NEW but stale snapshot never blips', F.nfmHeartbeat('NEW', 'STALE') === null);
  chk('G: a regressed (clock-corrected) snapshot does not blip', F.nfmHeartbeat('REGRESSED', 'LIVE') === null);
  chk('G: beam sweeps while LIVE', F.nfmBeamMode('LIVE') === 'live');
  chk('G: beam is faint while partial', F.nfmBeamMode('DEGRADED') === 'partial');
  chk('G: beam stops for STALE, OFFLINE, UNKNOWN and AWAITING', ['STALE', 'OFFLINE', 'UNKNOWN', 'AWAITING'].every(x => F.nfmBeamMode(x) === 'off'));
}

/* ---------------------------------------------------------------- H: future timestamps */
{
  const fut = snap(s => { s.ts = NOW + 3600; });
  const d = F.nfmDisplayState(fut, NOW);
  chk('H: a snapshot an hour in the future is UNKNOWN, not LIVE', d.state === 'UNKNOWN', d);
  chk('H: small skew (+30 s) is tolerated', F.nfmDisplayState(snap(s => { s.ts = NOW + 30; }), NOW).state === 'LIVE');
  chk('H: nfmAgeText never prints a negative age', F.nfmAgeText(-5) === '?');
  const incF = (o) => Object.assign({ schema: 'netframe-live-dashboard-feed/v1', generated_at: INC_FIX.generated_at,
      status: 'OK', selection: INC_FIX.selection, state: INC_FIX.state, state_generated_at: INC_FIX.state_generated_at, error: null }, o);
  const INOW = Date.parse(INC_FIX.generated_at) / 1000;
  chk('H: (control) the pinned incident fixture is FRESH at its own time', F.nfmIncidentState(incF(), INOW).freshness === 'FRESH');
  const fg = F.nfmIncidentState(incF({ generated_at: iso(INOW + 600) }), INOW);
  chk('H: incident envelope from the future is not FRESH', fg.freshness !== 'FRESH' && fg.banner === 'INCIDENT FEED CLOCK INVALID', fg);
  chk('H: ...and keeps a non-green, non-clear tone', fg.tone === 'warn');
  const fp = F.nfmIncidentState(incF({ state_generated_at: iso(INOW + 600) }), INOW);
  chk('H: a future projection time cannot fall back to cycle.at and read FRESH', fp.freshness !== 'FRESH', fp);
  chk('H: incident -30 s skew is tolerated', F.nfmIncidentState(incF({ generated_at: iso(INOW + 30) }), INOW).freshness === 'FRESH');
  const pf = F.nfmProposalState(props(p => { p.generated_at = iso(NOW + 600); }), NOW);
  chk('H: proposal feed from the future shows a banner and no current count', pf.show && pf.status !== 'OK' && pf.action === undefined && pf.banner === 'PROPOSAL FEED CLOCK INVALID', pf);
  chk('H: proposal +30 s skew is tolerated', F.nfmProposalState(props(p => { p.generated_at = iso(NOW + 30); }), NOW).status === 'OK');
}

/* ---------------------------------------------------------------- L: mixed versions */
{
  /* exactly what the CURRENT production backend (58bb84d) sends: no collector, no ups_status */
  const oldBackend = view(snap(s => { delete s.collector; delete s.ups_status; }));
  chk('L: new page on an old backend is NOT "CURRENT"', lamp(oldBackend, 'conf').sev === 'y' && lamp(oldBackend, 'conf').value === 'PARTIAL', lamp(oldBackend, 'conf'));
  chk('L: ...it names what the backend does not report', /collector run time/.test(lamp(oldBackend, 'conf').why) && /UPS utility status/.test(lamp(oldBackend, 'conf').why));
  chk('L: ...and INFRASTRUCTURE cannot read green "NO FAULTS"', lamp(oldBackend, 'infra').sev !== 'g', lamp(oldBackend, 'infra'));
  const noUps = view(snap(s => { delete s.ups_status; }));
  chk('L: a missing UPS status alone also blocks green', lamp(noUps, 'infra').sev !== 'g' && /UPS utility status/.test(lamp(noUps, 'conf').why));
  const full = view(snap());
  chk('L: the new backend shape still reads CURRENT / NO FAULTS', lamp(full, 'conf').value === 'CURRENT' && lamp(full, 'infra').value === 'NO FAULTS');
}

/* ---------------------------------------------------------------- K: intel detail rows */
{
  const K = new Function(blk('NFM-INTEL-FIT') + '\n return {nfmIntelHideable};')();
  const fp = (sum, list) => ({ summary: Object.assign({ counts_are_authoritative: true }, sum), proposals: list });
  const det = { source_condition: 'DETECTION_RECORDED', action_class: 'SECURITY' };
  const fir = { source_condition: 'FIRING', action_class: 'ACTIVE' };
  const clr = { source_condition: 'CLEARED', action_class: 'HISTORY' };
  const odd = { source_condition: 'SOMETHING_NEW' };
  chk('K: a detection row may be hidden only when security_pending discloses it',
      K.nfmIntelHideable(fp({ security_pending: 4868 }, [det]))[0] === true);
  chk('K: a detection row is KEPT when the head does not disclose any security pending',
      K.nfmIntelHideable(fp({ security_pending: 0, pending_detections: 0 }, [det]))[0] === false);
  chk('K: a firing row may be hidden only when pending_firing discloses it',
      K.nfmIntelHideable(fp({ pending_firing: 2 }, [fir]))[0] === true && K.nfmIntelHideable(fp({ pending_firing: 0 }, [fir]))[0] === false);
  chk('K: a cleared/history row may be hidden (not a live condition)', K.nfmIntelHideable(fp({}, [clr]))[0] === true);
  chk('K: an unknown condition is never hidden', K.nfmIntelHideable(fp({ security_pending: 9, pending_firing: 9 }, [odd]))[0] === false);
  chk('K: nothing is hidden when counts are not authoritative',
      K.nfmIntelHideable({ summary: { counts_are_authoritative: false, security_pending: 9 }, proposals: [det, fir, clr] }).every(x => x === false));
  chk('K: one decision per listed proposal, in render order (non-objects skipped like the renderer)',
      K.nfmIntelHideable(fp({ security_pending: 1 }, [det, null, clr])).length === 2);
  /* the wording the cramped panel must keep is produced by the contract renderer, not by fitIntel */
  chk('K: the contract renderer emits the not-proof-of-compromise note for a detection',
      /not proof of breach or compromise/.test(F.nfmProposalPanel(props(p => { p.summary.security_pending = 1; p.proposals = [Object.assign({}, p.proposals[0], { source_kind: 'wazuh', source_condition: 'DETECTION_RECORDED', action_class: 'SECURITY' })]; }), NOW)));
}

/* ---------------------------------------------------------------- J: ages keep advancing */
{
  /* the backend built this snapshot 400 s ago; UPS was already 300 s stale then */
  const old = snap(s => { s.ts = NOW - 400; s.mode = 'DEGRADED';
    s.panels.ups.state = 'STALE'; s.panels.ups.age = 300; s.panels.ups.fresh_at = NOW - 700;
    s.panels.monitor.age = 240; s.panels.monitor.fresh_at = NOW - 640; });
  const m = F.nfmModel(old);
  chk('J: a carried panel ages from its ORIGINAL observation (300 s at build + 400 s since = 700 s)', F.nfmPanelAge(m, 'ups', NOW) === 700, F.nfmPanelAge(m, 'ups', NOW));
  chk('J: a FRESH-at-build panel also keeps ageing (240 + 400 = 640 s)', F.nfmPanelAge(m, 'monitor', NOW) === 640);
  chk('J: ...and keeps advancing with the clock', F.nfmPanelAge(m, 'ups', NOW + 60) === 760);
  const noFa = F.nfmModel(snap(s => { s.ts = NOW - 400; s.panels.ups.state = 'STALE'; s.panels.ups.age = 300; delete s.panels.ups.fresh_at; }));
  chk('J: without fresh_at: backend age + time since the snapshot was built', F.nfmPanelAge(noFa, 'ups', NOW) === 700);
  const fut = F.nfmModel(snap(s => { s.panels.ups.age = 50; s.panels.ups.fresh_at = NOW + 3600; }));
  chk('J: a future fresh_at is not trusted (falls back to age + elapsed)', F.nfmPanelAge(fut, 'ups', NOW) === 55);
  const unk = F.nfmModel(snap(s => { s.panels.ups.age = null; delete s.panels.ups.fresh_at; }));
  chk('J: no age and no fresh_at stays UNKNOWN (null), never 0', F.nfmPanelAge(unk, 'ups', NOW) === null);
  const deg = snap(s => { s.mode = 'DEGRADED'; s.panels.ups.state = 'STALE'; s.panels.ups.age = 300; s.panels.ups.fresh_at = NOW - 360; s.ts = NOW - 60; });
  const v = view(deg);
  chk('J: the confidence lamp shows the advancing age (6m), not the build-time age (5m)', /ups 6m/.test(lamp(v, 'conf').why), lamp(v, 'conf').why);
  chk('J: the telemetry condition shows the advancing age', v.conds.some(c => c.sys === 'ups' && /6m old/.test(c.text)));
}

/* ---------------------------------------------------------------- I: attention overflow */
if (html.includes('NFM-ATTENTION-BEGIN')) {
  const A = new Function(blk('NFM-ATTENTION') + '\n return {nfmAttentionPlan, nfmAttentionSummaryText};')();
  const mk = (sev, dom, sys) => ({ sev, dom, sys, text: sys + ' text' });
  const items = [];
  ['pve2', 'pve3', 'pve4', 'pve5', 'Randy'].forEach(h => items.push(mk('r', 'NODE', h)));
  ['Vaultwarden', 'Grafana', 'Headscale', 'Home Assistant', 'Proxmox Backup', 'Open WebUI', 'Wazuh SIEM'].forEach(s => items.push(mk('r', 'SERVICE', s)));
  ['Backup Verify', 'Hardening Drift', 'Net Dead-man', 'Wazuh SIEM chip'].forEach(s => items.push(mk('r', 'INTEGRITY', s)));
  items.push(mk('r', 'WAN', 'WAN'), mk('r', 'RKE2', 'RKE2 node'), mk('r', 'UPS', 'Tripp Lite'));
  ['Journal Errors', 'Middle Atlantic'].forEach(s => items.push(mk('y', 'MISC', s)));
  ['switch', 'slurm'].forEach(s => items.push(mk('u', 'TELEMETRY', s)));
  const critNames = items.filter(i => i.sev === 'r').map(i => i.sys);
  chk('I: (fixture) an overloaded list - ' + critNames.length + ' critical, 2 warning, 2 unknown', critNames.length === 19);
  let allNamed = true, bounded = true, worstFirst = true;
  for (let full = 0; full <= 8; full++) {
    const p = A.nfmAttentionPlan(items, full), lines = A.nfmAttentionSummaryText(p.summary);
    const text = p.rows.map(r => r.sys).join('|') + '|' + lines.map(l => l.text).join('|');
    if (!critNames.every(n => text.includes(n))) allNamed = false;
    if (lines.length > 3) bounded = false;
    if (p.rows.some(r => r.sev !== 'r')) worstFirst = false;
  }
  chk('I: at every row budget, EVERY critical system is named (full line or summary)', allNamed);
  chk('I: the summary is bounded (at most 3 lines: critical, warning, unknown)', bounded);
  chk('I: full lines go to the worst conditions first', worstFirst);
  const p3 = A.nfmAttentionPlan(items, 3), l3 = A.nfmAttentionSummaryText(p3.summary);
  chk('I: the summary counts the remaining critical conditions', /\+16 MORE CRITICAL/.test(l3[0].text), l3[0].text);
  chk('I: ...grouped by domain', /NODE: pve5, Randy/.test(l3[0].text) && /SERVICE: Vaultwarden/.test(l3[0].text), l3[0].text);
  chk('I: remaining warnings are named, unknowns counted', /Journal Errors/.test(l3[1].text) && /\+2 NOT CURRENT/.test(l3[2].text));
  const fit = A.nfmAttentionPlan(items.slice(0, 4), 5);
  chk('I: a list that fits has no summary at all', fit.summary === null && fit.rows.length === 4);
}

console.log('----');
console.log(fails.length ? 'P9 WALL STATE: FAIL ' + JSON.stringify(fails) : 'P9 WALL STATE: PASS');
process.exit(fails.length ? 1 : 0);
