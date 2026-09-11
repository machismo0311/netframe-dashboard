/* P7 cross-instance parity - NO production access of its own.

   The estate runs the WAN posture renderer on TWO hosts: Ares (the git working tree, which IS the
   deployment) and the wall Pi (a deployed artifact copy). Two copies of a decision function is two
   chances to disagree, and the disagreement would be invisible: each wall would look internally
   consistent while showing a different answer about whether the internet is protected.

   So this asserts they are the SAME implementation, over the whole state matrix rather than by
   eyeballing a digest. Point NFM_PARITY_HTML at the HTML actually served by the other instance
   (fetched from its HTTP endpoint, not read from its disk - what it serves is what the wall shows).

   Without that variable the test SKIPS LOUDLY and exits non-zero. A parity test that silently
   passes when it has nothing to compare is worse than no parity test: it reports proof it does
   not have. Pass NFM_PARITY_OPTIONAL=1 to downgrade the skip to a warning for local CI runs. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BLOCK = /\/\* NFM-WAN-POSTURE-BEGIN[\s\S]*?\/\* NFM-WAN-POSTURE-END \*\//;

function extract(html, label) {
  const m = html.match(BLOCK);
  if (!m) { console.error(`FAIL  no NFM-WAN-POSTURE block in ${label}`); process.exit(1); }
  return { src: m[0], fn: new Function(m[0] + '\n return nfmWanPosture;')() };
}

const local = extract(readFileSync(join(HERE, '..', 'netframe-dashboard.html'), 'utf8'),
                      'the repository HTML');

const other = process.env.NFM_PARITY_HTML;
if (!other) {
  const msg = 'SKIP  no NFM_PARITY_HTML - nothing to compare, so parity is NOT PROVEN';
  console.log(msg);
  if (process.env.NFM_PARITY_OPTIONAL === '1') { console.log('WARN  parity unproven (optional mode)'); process.exit(0); }
  console.log('PARITY: NOT PROVEN');
  process.exit(2);
}
const remote = extract(readFileSync(other, 'utf8'), other);

let fails = [];
const chk = (n, c) => { console.log((c ? 'PASS  ' : 'FAIL  ') + n); if (!c) fails.push(n); };

const base = () => ({
  wan1: { state: 'UP', gw: 'Online', ip: '173.91.172.132', lat: 26.4, loss: 0.0,
          monitor: '8.8.8.8', gw_addr: '173.91.160.1' },
  wan2: { state: 'UP', gw: 'Online', ip: '192.168.1.199', lat: 52.6, loss: 0.0,
          monitor: '1.1.1.1', gw_addr: '192.168.1.1' },
  failover: { armed: true, group: 'Failover', tiers: 2, active: 'wan1', active_netif: 'vtnet0',
              observed_at: 1757000000 },
});

/* Every state the renderer can reach, named so a failure says WHICH state drifted. */
const MATRIX = [
  ['DUAL-WAN READY',              s => s],
  ['PRIMARY UP NO FAILOVER',      s => { s.wan2.gw = 'Offline'; return s; }],
  ['FAILOVER NOT ARMED (policy)', s => { s.failover.armed = false; return s; }],
  ['FAILOVER NOT ARMED (monitor)',s => { s.wan1.monitor = s.wan1.gw_addr; return s; }],
  ['FAILED OVER',                 s => { s.wan1.gw = 'Offline'; s.failover.active = 'wan2'; return s; }],
  ['FAILED OVER while wan1 up',   s => { s.failover.active = 'wan2'; return s; }],
  ['NO INTERNET',                 s => { s.wan1.gw = 'Offline'; s.wan2.gw = 'Offline'; return s; }],
  ['UNKNOWN no posture',          s => { delete s.failover; return s; }],
  ['UNKNOWN armed absent',        s => { delete s.failover.armed; return s; }],
  ['UNKNOWN wan2 absent',         s => { delete s.wan2.gw; return s; }],
  ['UNKNOWN active absent',       s => { delete s.failover.active; return s; }],
  ['PRIMARY DOWN path unknown',   s => { s.wan1.gw = 'Offline'; delete s.failover.active; return s; }],
  ['UNKNOWN wan1 absent',         s => { delete s.wan1.gw; return s; }],
  ['null snapshot',               () => null],
];

for (const [name, mut] of MATRIX) {
  const a = local.fn(mut(base()));
  const b = remote.fn(mut(base()));
  chk(`parity: ${name}`, JSON.stringify(a) === JSON.stringify(b));
}

/* Identical behaviour over a finite matrix is strong, but the matrix is finite. Byte identity of
   the block closes the rest: it rules out a divergence this matrix happens not to reach. */
chk('the two instances carry a byte-identical posture block', local.src === remote.src);

/* And there is exactly one implementation per instance - a second copy could shadow the first. */
const count = h => (h.match(/NFM-WAN-POSTURE-BEGIN/g) || []).length;
chk('exactly one posture block in the repository HTML',
    count(readFileSync(join(HERE, '..', 'netframe-dashboard.html'), 'utf8')) === 1);
chk('exactly one posture block in the other instance', count(readFileSync(other, 'utf8')) === 1);

console.log('----');
console.log('CROSS-INSTANCE PARITY: ' + (fails.length ? 'FAIL ' + JSON.stringify(fails) : 'PASS'));
process.exit(fails.length ? 1 : 0);
