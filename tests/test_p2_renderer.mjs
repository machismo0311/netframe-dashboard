/* P2 offline renderer fixtures - NO production access, no DOM, no network.
   Extracts the pure decision function from the shipped HTML (single source of truth) and asserts
   the presentation invariant: the glass follows the BACKEND's declared state, and every unknown
   fails toward DEGRADED/STALE/UNKNOWN - never toward LIVE.
   Historical defect (operations/wall-monitor-dependency): the badge read LIVE for a 12d13.7h
   outage because it only asked "did the fetch work and is the whole-snapshot ts young". */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(HERE, '..', 'netframe-dashboard.html'), 'utf8');
const m = html.match(/\/\* NFM-DISPLAY-STATE-BEGIN[\s\S]*?\/\* NFM-DISPLAY-STATE-END \*\//);
if (!m) { console.error('FAIL  cannot extract NFM-DISPLAY-STATE block from the shipped HTML'); process.exit(1); }
const ageFn = html.match(/function nfmAgeText\(sec\)\{[\s\S]*?\n\}/);
const nfmDisplayState = new Function(m[0] + '\n return nfmDisplayState;')();
const nfmAgeText = new Function(ageFn[0] + '\n return nfmAgeText;')();

let fails = [];
const chk = (n, c) => { console.log((c ? 'PASS  ' : 'FAIL  ') + n); if (!c) fails.push(n); };
const NOW = 1787200000;
const panels = (spec) => Object.fromEntries(Object.entries(spec).map(([k, v]) =>
  [k, (typeof v === 'string') ? { state: v, age: v === 'FRESH' ? 0 : 600 } : v]));

/* A - fully live */
{
  const s = { ts: NOW - 5, mode: 'LIVE', sources: { prometheus: true, monitor: true },
              panels: panels({ prometheus: 'FRESH', monitor: 'FRESH', gpu: 'FRESH' }) };
  const d = nfmDisplayState(s, NOW);
  chk('A: fresh snapshot + mode LIVE + all panels FRESH -> LIVE', d.state === 'LIVE');
  chk('A: no panel is reported stale', d.stale.length === 0);
}
/* B - one source carried */
{
  const s = { ts: NOW - 5, mode: 'DEGRADED', sources: { prometheus: true, monitor: true },
              panels: panels({ prometheus: { state: 'STALE', age: 1084000 }, monitor: 'FRESH', gpu: 'FRESH' }) };
  const d = nfmDisplayState(s, NOW);
  chk('B: one carried panel -> DEGRADED (not LIVE)', d.state === 'DEGRADED');
  chk('B: the carried panel is named so the glass can identify it', d.stale.length === 1 && d.stale[0] === 'prometheus');
  chk('B: 12.5-day carried age renders as days, not seconds', nfmAgeText(1084000) === '13d');
}
/* C - whole snapshot stale overrides a stored LIVE */
{
  const s = { ts: NOW - 4000, mode: 'LIVE', sources: { prometheus: true },
              panels: panels({ prometheus: 'FRESH', monitor: 'FRESH' }) };
  const d = nfmDisplayState(s, NOW);
  chk('C: stale whole snapshot -> STALE even though stored mode says LIVE', d.state === 'STALE');
  chk('C: staleness is attributed to snapshot age', /snapshot age/.test(d.reason));
}
/* D - carried panel across many cycles: the renderer must show a GROWING age */
{
  const seen = [];
  for (let cycle = 0; cycle < 6; cycle++) {
    const carriedAge = 600 + cycle * 38;                       // serve.py ages from last FRESH
    const s = { ts: NOW + cycle * 38, mode: 'DEGRADED',
                panels: panels({ prometheus: { state: 'STALE', age: carriedAge }, monitor: 'FRESH' }) };
    const d = nfmDisplayState(s, NOW + cycle * 38);
    seen.push({ state: d.state, age: s.panels.prometheus.age });
  }
  chk('D: every cycle stays DEGRADED while the panel is carried', seen.every(x => x.state === 'DEGRADED'));
  chk('D: carried age increases monotonically across cycles', seen.every((x, i) => i === 0 || x.age > seen[i - 1].age));
  chk('D: carried age never resets to about one refresh interval', seen[seen.length - 1].age > 700);
}
/* E - backend says DEGRADED while HTTP is perfectly healthy */
{
  const s = { ts: NOW - 1, mode: 'DEGRADED', ok: true, sources: { prometheus: true, monitor: true },
              panels: panels({ prometheus: 'MISSING', monitor: 'FRESH' }) };
  const d = nfmDisplayState(s, NOW);
  chk('E: a healthy fetch cannot upgrade a DEGRADED backend to LIVE', d.state === 'DEGRADED');
  chk('E: sources[] being true does not make it LIVE', s.sources.prometheus === true && d.state !== 'LIVE');
}
/* F - source recovers */
{
  const before = nfmDisplayState({ ts: NOW - 2, mode: 'DEGRADED',
    panels: panels({ prometheus: { state: 'STALE', age: 900 }, monitor: 'FRESH' }) }, NOW);
  const after = nfmDisplayState({ ts: NOW - 2, mode: 'LIVE',
    panels: panels({ prometheus: 'FRESH', monitor: 'FRESH' }) }, NOW);
  chk('F: DEGRADED before recovery', before.state === 'DEGRADED');
  chk('F: returns to LIVE only when backend AND panels both justify it', after.state === 'LIVE');
}
/* G - missing / unknown freshness must never read optimistic */
{
  chk('G: no snapshot at all -> OFFLINE', nfmDisplayState(null, NOW).state === 'OFFLINE');
  chk('G: snapshot with no ts -> STALE', nfmDisplayState({ mode: 'LIVE', panels: {} }, NOW).state === 'STALE');
  chk('G: snapshot with no panels block -> UNKNOWN', nfmDisplayState({ ts: NOW, mode: 'LIVE' }, NOW).state === 'UNKNOWN');
  chk('G: empty panels block -> UNKNOWN', nfmDisplayState({ ts: NOW, mode: 'LIVE', panels: {} }, NOW).state === 'UNKNOWN');
  chk('G: unrecognised panel state -> UNKNOWN',
      nfmDisplayState({ ts: NOW, mode: 'LIVE', panels: { a: { state: 'WEIRD' } } }, NOW).state === 'UNKNOWN');
  chk('G: unrecognised backend mode -> UNKNOWN',
      nfmDisplayState({ ts: NOW, mode: 'SPLENDID', panels: panels({ a: 'FRESH' }) }, NOW).state === 'UNKNOWN');
  chk('G: null carried age renders as unknown, not young', nfmAgeText(null) === '?');
  chk('G: mode LIVE with a MISSING panel is still DEGRADED',
      nfmDisplayState({ ts: NOW, mode: 'LIVE', panels: panels({ a: 'FRESH', b: 'MISSING' }) }, NOW).state === 'DEGRADED');
}
/* the exact historical defect, asserted directly */
{
  const s = { ts: NOW - 3, mode: 'DEGRADED', ok: true,
              sources: { prometheus: true, monitor: true, gpu: false },
              panels: panels({ prometheus: { state: 'STALE', age: 1084000 }, monitor: 'FRESH',
                               gpu: 'MISSING', ups: 'MISSING' }) };
  const d = nfmDisplayState(s, NOW);
  chk('REGRESSION: the 12d CT103 outage shape can no longer render as LIVE', d.state !== 'LIVE');
  chk('REGRESSION: it renders DEGRADED and names every non-fresh panel',
      d.state === 'DEGRADED' && d.stale.join(',') === 'gpu,prometheus,ups');
}

console.log(fails.length ? `\nFAILED ${fails.length}` : '\nALL RENDERER FIXTURES PASS');
process.exit(fails.length ? 1 : 0);
