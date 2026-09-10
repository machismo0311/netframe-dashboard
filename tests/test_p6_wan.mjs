/* P6 offline WAN-posture fixtures - NO production access, no DOM, no network.
   Extracts the pure decision function from the shipped HTML (single source of truth) and asserts the
   resilience invariant: green means PROTECTED, not merely "Spectrum answered".

   Historical defect: the footer computed `w1on = wan1.gw==='Online'` and painted the card green on
   that alone. WAN2 was dead for 25 days (2026-08-15 to 2026-09-09) while the wall read
   "PRIMARY UP · WAN1 ACTIVE" in green throughout. Five independent facts were collapsed into one.

   The invariant under test: every unknown fails toward amber. An absent field is UNKNOWN - never
   false, never true - so a broken probe degrades the wall honestly instead of inventing readiness. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(HERE, '..', 'netframe-dashboard.html'), 'utf8');
const m = html.match(/\/\* NFM-WAN-POSTURE-BEGIN[\s\S]*?\/\* NFM-WAN-POSTURE-END \*\//);
if (!m) { console.error('FAIL  cannot extract NFM-WAN-POSTURE block from the shipped HTML'); process.exit(1); }
const nfmWanPosture = new Function(m[0] + '\n return nfmWanPosture;')();

let fails = [];
const chk = (n, c) => { console.log((c ? 'PASS  ' : 'FAIL  ') + n); if (!c) fails.push(n); };

/* The live healthy baseline, as measured 2026-09-10. Each test mutates one dimension. */
const base = () => ({
  wan1: { state: 'UP', gw: 'Online', ip: '173.91.172.132', lat: 26.4, loss: 0.0,
          monitor: '8.8.8.8', gw_addr: '173.91.160.1' },
  wan2: { state: 'UP', gw: 'Online', ip: '192.168.1.199', lat: 52.6, loss: 0.0,
          monitor: '1.1.1.1', gw_addr: '192.168.1.1' },
  failover: { armed: true, group: 'Failover', tiers: 2, active: 'wan1', active_netif: 'vtnet0' },
});
const notReady = d => d.state !== 'READY' && d.color !== 'var(--green)';

/* T1 - fully healthy: the only state allowed to be green */
{
  const d = nfmWanPosture(base());
  chk('T1: all five inputs healthy -> DUAL-WAN READY', d.state === 'READY');
  chk('T1: renders green', d.color === 'var(--green)');
  chk('T1: label names both providers', /DUAL-WAN READY/.test(d.label));
}

/* T2 - WAN2 lost. This is the exact 25-day condition the old footer showed as green. */
{
  const s = base(); s.wan2.gw = 'Offline';
  const d = nfmWanPosture(s);
  chk('T2: WAN2 offline -> PRIMARY UP · NO FAILOVER', d.state === 'NO_FAILOVER');
  chk('T2: MUST NOT be green (the 25-day regression)', notReady(d));
  chk('T2: amber, because production traffic is still fine', d.color === 'var(--yellow)');
  chk('T2: names the lost standby', /FirstNet offline/i.test(d.sub));
}

/* T3 - policy not armed: a gateway group nobody routes through is not failover */
{
  const s = base(); s.failover.armed = false;
  const d = nfmWanPosture(s);
  chk('T3: policy unarmed -> FAILOVER NOT ARMED', d.state === 'NOT_ARMED');
  chk('T3: MUST NOT be green', notReady(d));
}

/* T4 - primary monitors its own next-hop: link proven, internet not */
{
  const s = base(); s.wan1.monitor = s.wan1.gw_addr;      // 173.91.160.1, the pre-2026-09-10 state
  const d = nfmWanPosture(s);
  chk('T4: next-hop-monitored primary -> FAILOVER NOT ARMED', d.state === 'NOT_ARMED');
  chk('T4: MUST NOT be green', notReady(d));
  chk('T4: says why', /next-hop/i.test(d.sub));
}
{
  const s = base(); s.wan1.monitor = '9.9.9.9';           // any external target, not just 8.8.8.8
  chk('T4b: external-monitor test is generic, not hardcoded to one IP',
      nfmWanPosture(s).state === 'READY');
}

/* T5 - failed over: WAN2 is actually carrying traffic */
{
  const s = base(); s.wan1.gw = 'Offline'; s.failover.active = 'wan2';
  const d = nfmWanPosture(s);
  chk('T5: WAN1 down + pf on wan2 -> FAILED OVER · WAN2 ACTIVE', d.state === 'FAILED_OVER');
  chk('T5: MUST NOT be green just because the internet works', notReady(d));
}
{
  const s = base(); s.failover.active = 'wan2';            // wan1 still Online but pf moved
  chk('T5b: pf on wan2 while wan1 is up is still FAILED OVER',
      nfmWanPosture(s).state === 'FAILED_OVER');
}

/* T6 - both down */
{
  const s = base(); s.wan1.gw = 'Offline'; s.wan2.gw = 'Offline';
  const d = nfmWanPosture(s);
  chk('T6: both WANs down -> NO INTERNET', d.state === 'NO_INTERNET');
  chk('T6: renders red', d.color === 'var(--red)');
}

/* T7 - unknown policy: absent must not read as armed */
{
  const s = base(); delete s.failover;
  chk('T7: failover object absent -> not green-ready', notReady(nfmWanPosture(s)));
  const s2 = base(); delete s2.failover.armed;
  chk('T7b: armed field absent -> not green-ready', notReady(nfmWanPosture(s2)));
}

/* T8 - unknown WAN2 */
{
  const s = base(); delete s.wan2.gw;
  const d = nfmWanPosture(s);
  chk('T8: WAN2 gateway health absent -> not green-ready', notReady(d));
  chk('T8: says the standby is unreported', /not reported/i.test(d.sub));
}
{
  const s = base(); delete s.wan2.gw; s.wan2.state = 'UP';
  chk('T8b: interface state UP is NOT a health fallback (WAN2 sat state=UP gw=Offline for weeks)',
      notReady(nfmWanPosture(s)));
}

/* T9 - active path unknown must not be guessed from the two health bits */
{
  const s = base(); delete s.failover.active;
  chk('T9: active path absent -> not green-ready', notReady(nfmWanPosture(s)));
  const s2 = base(); s2.wan1.gw = 'Offline'; delete s2.failover.active;
  chk('T9b: wan1 down + wan2 up is NOT asserted as failed-over without pf proof',
      nfmWanPosture(s2).state !== 'FAILED_OVER');
}

/* structural: no snapshot, and the closed vocabulary */
{
  chk('null snapshot -> UNKNOWN, never green', notReady(nfmWanPosture(null)));
  const STATES = ['READY','NO_FAILOVER','NOT_ARMED','FAILED_OVER','NO_INTERNET','UNKNOWN',
                  'PRIMARY_DOWN_PATH_UNKNOWN'];
  const seen = new Set();
  for (const mut of [s=>s, s=>{s.wan2.gw='Offline';return s;}, s=>{s.failover.armed=false;return s;},
                     s=>{s.wan1.gw='Offline';s.failover.active='wan2';return s;},
                     s=>{s.wan1.gw='Offline';s.wan2.gw='Offline';return s;},
                     s=>{delete s.failover;return s;},
                     s=>{s.wan1.gw='Offline';delete s.failover.active;return s;}]) {
    seen.add(nfmWanPosture(mut(base())).state);
  }
  chk('every reachable state is in the closed vocabulary',
      [...seen].every(x => STATES.includes(x)));
  chk('exactly one state is green across the whole matrix',
      [...seen].filter(x => x === 'READY').length === 1);
}

console.log('----');
console.log('WAN POSTURE: ' + (fails.length ? 'FAIL ' + JSON.stringify(fails) : 'PASS'));
process.exit(fails.length ? 1 : 0);
