/* P3 offline fixtures - NO production access. Extracts the pure SMART-pill renderer from the
   shipped HTML and asserts the rule the wall now lives by: NO SOURCE, NO HEALTH CLAIM.

   The defect this locks out: the pills rendered from a seeded literal {pass:52,warn:2,fail:0}, so
   the glass showed a yellow "WARN 2" that no probe had ever produced. /api/state has no `smart`
   object at all, so the honest render is UNKNOWN - not PASS, not WARN, and not a fabricated zero. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(HERE, '..', 'netframe-dashboard.html'), 'utf8');
const m = html.match(/\/\* NFM-SMART-PILLS-BEGIN[\s\S]*?\/\* NFM-SMART-PILLS-END \*\//);
if (!m) { console.error('FAIL  cannot extract NFM-SMART-PILLS block'); process.exit(1); }
const nfmSmartPills = new Function(m[0] + '\n return nfmSmartPills;')();

let fails = [];
const chk = (n, c) => { console.log((c ? 'PASS  ' : 'FAIL  ') + n); if (!c) fails.push(n); };
const numbersIn = s => (s.match(/\b\d+\b/g) || []);

/* A - no SMART data at all: the live contract today */
{
  const out = nfmSmartPills(undefined);
  chk('A: absent smart renders NOT MEASURED', /NOT MEASURED/.test(out));
  chk('A: renders no PASS count', !/PASS \d/.test(out));
  chk('A: renders no WARN count', !/WARN \d/.test(out));
  chk('A: renders no FAIL count', !/FAIL \d/.test(out));
  chk('A: emits no digits at all, so no fabricated zero', numbersIn(out).length === 0);
  chk('A: null behaves the same as undefined', /NOT MEASURED/.test(nfmSmartPills(null)));
  chk('A: an empty object is still NOT MEASURED', /NOT MEASURED/.test(nfmSmartPills({})));
}

/* B - real measured healthy data renders exactly */
{
  const out = nfmSmartPills({ pass: 22, warn: 0, fail: 0 });
  chk('B: renders the measured pass count', /PASS 22/.test(out));
  chk('B: renders a measured zero warn, because zero was MEASURED here', /WARN 0/.test(out));
  chk('B: renders a measured zero fail', /FAIL 0/.test(out));
  chk('B: a measured zero warn is not styled as a warning', /WARN 0/.test(out) && !/yellow[^>]*>WARN 0/.test(out));
}

/* C - real measured warning must survive */
{
  const out = nfmSmartPills({ pass: 21, warn: 1, fail: 0 });
  chk('C: a REAL warn is rendered, not suppressed', /WARN 1/.test(out));
  chk('C: a real warn is styled yellow', /yellow[^>]*>WARN 1/.test(out));
  chk('C: pass count still exact', /PASS 21/.test(out));
  const f = nfmSmartPills({ pass: 20, warn: 1, fail: 1 });
  chk('C: a real fail is styled red', /red[^>]*>FAIL 1/.test(f));
}

/* D - malformed or partial input must never become fake zeros */
for (const [label, bad] of [
  ['missing fail', { pass: 5, warn: 0 }],
  ['missing pass', { warn: 0, fail: 0 }],
  ['string values', { pass: '5', warn: '0', fail: '0' }],
  ['null member', { pass: 5, warn: null, fail: 0 }],
  ['NaN member', { pass: 5, warn: NaN, fail: 0 }],
  ['negative', { pass: -1, warn: 0, fail: 0 }],
  ['array not object', [1, 2, 3]],
  ['a bare number', 7],
]) {
  const out = nfmSmartPills(bad);
  chk(`D: ${label} renders NOT MEASURED, not zeros`, /NOT MEASURED/.test(out) && numbersIn(out).length === 0);
}

/* E - the historical defect cannot be reproduced from any input but its own values */
{
  const live = nfmSmartPills(undefined);
  chk('E: with the CURRENT live contract (no smart object) the old display is impossible',
      !/PASS 52/.test(live) && !/WARN 2/.test(live) && !/FAIL 0/.test(live));
  const seeded = nfmSmartPills({ pass: 52, warn: 2, fail: 0 });
  chk('E: PASS 52 / WARN 2 only appears when those exact values are IN the input',
      /PASS 52/.test(seeded) && /WARN 2/.test(seeded));
  chk('E: the renderer source seeds no smart literal any more',
      !/smart\s*:\s*\{\s*pass\s*:/.test(html.replace(/\/\*[\s\S]*?\*\//g, '')));
  chk('E: no code path reads st.smart.<field> directly any more',
      !/st\.smart\./.test(html));
  chk('E: the drive count is labelled CONFIGURED, not presented as live health',
      /DS4246 DRIVES \(CONFIGURED\)/.test(html) && /jbodConfigured/.test(html));
}

console.log(fails.length ? `\nFAILED ${fails.length}` : '\nALL SMART-PILL FIXTURES PASS');
process.exit(fails.length ? 1 : 0);
