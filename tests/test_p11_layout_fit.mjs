// P11 layout fit - NO production access. Renders the REAL netframe-dashboard.html in headless
// Chromium against tests/render/fixture_server.py and asserts it fits the physical wall.
//
// Defect this pins (2026-10-07, after the Packet C deployment): the stage grid had no column
// definition, so its single implicit `auto` column grew to the widest row's min-content. The Packet C
// Integrity chip value ("CRITICAL · AUTH MAJORITY STALE · AUTH 1/9 FRESH · AGENTS 9/9 · DROPS 0",
// nowrap) widened the head, lamps and integrity rows to 2281 px, and the 1920 px stage clipped the
// clock, the fourth lamp and the right-hand chips - including the Wazuh chip itself - off the Pi's
// 1920x1080 screen. Fonts matter: the Pi has neither Rajdhani nor Share Tech Mono, so the tests use
// tests/render/pi-fonts.conf (sans -> DejaVu Sans, mono -> DejaVu Sans Mono), as the Pi renders.
//
// Needs Playwright with its Chromium. Set NFM_PLAYWRIGHT to the module directory if it is not
// resolvable. Without it this suite cannot measure anything and exits 2 (NOT PROVEN), like p7 parity.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
let chromium;
for (const m of [process.env.NFM_PLAYWRIGHT, 'playwright'].filter(Boolean)) {
  try { ({ chromium } = require(m)); break; } catch { /* try the next */ }
}
if (!chromium) { console.log('SKIP  playwright not available (set NFM_PLAYWRIGHT) - layout fit NOT PROVEN'); process.exit(2); }

const fails = [];
const chk = (name, ok, detail = '') => { console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || !detail ? '' : '  [' + detail + ']')); if (!ok) fails.push(name); };
const VIEWPORTS = [[1920, 1080, 'the wall Pi (HDMI 1920x1080, DPR 1)'], [1366, 768, ''], [1280, 720, '']];
const SCENARIOS = ['packetc', 'packetc-long', 'packetc-unknown', 'normal', 'overflow'];

async function serve(scen, port) {
  const p = spawn('python3', [path.join(HERE, 'render', 'fixture_server.py'), scen, String(port)], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((ok) => p.stdout.once('data', ok));
  return p;
}

const browser = await chromium.launch({ env: { ...process.env, FONTCONFIG_FILE: path.join(HERE, 'render', 'pi-fonts.conf') } });
let port = 8971;
for (const scen of SCENARIOS) {
  const srv = await serve(scen, ++port);
  try {
    for (const [w, h, note] of VIEWPORTS) {
      const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
      await page.goto(`http://127.0.0.1:${port}/`);
      await page.waitForTimeout(3500);
      const g = await page.evaluate(() => {
        const st = document.getElementById('stage'), sr = st.getBoundingClientRect();
        const box = (e) => { const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; };
        const past = [...st.querySelectorAll('*')].filter((e) => {
          if (e.id === 'beam' || e.closest('#beam')) return false;          // the decorative sweep travels by design
          const r = e.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && (r.right > sr.right + 1 || r.bottom > sr.bottom + 1 || r.left < sr.left - 1 || r.top < sr.top - 1);
        }).map((e) => e.id || e.className || e.tagName);
        const clipped = [...document.querySelectorAll('.panel')].filter((p) => p.scrollHeight > p.clientHeight + 2 || p.scrollWidth > p.clientWidth + 2)
          .map((p) => (p.querySelector('.t') || p).textContent.trim().slice(0, 30));
        const chip = [...document.querySelectorAll('.ichip')].find((c) => /Wazuh SIEM/i.test(c.textContent));
        const val = chip && chip.querySelector('.iv > span:last-child');
        const row = [...document.querySelectorAll('.row')].find((r) => /Wazuh SIEM/.test(r.textContent));
        // The Integrity condition (the one carrying the AUTH count); a Services condition may also exist.
        const att = [...document.querySelectorAll('#attention .att')].find((a) => /Wazuh SIEM/.test(a.textContent) && /AUTH /.test(a.textContent));
        const tx = att && att.querySelector('.tx');
        return {
          vp: [innerWidth, innerHeight], stage: box(st), doc: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
          past, clipped, coreOk: /CORE OK/.test(document.body.innerText),
          chip: chip && box(chip), chipColor: val && getComputedStyle(val).color, chipText: val && val.textContent,
          valBounded: val ? val.getBoundingClientRect().right <= chip.getBoundingClientRect().right + 1 : false,
          row: row && box(row), rowDot: row && (row.querySelector('.dot') || {}).className,
          att: att && box(att), attText: tx && tx.textContent, attFits: tx ? tx.scrollHeight <= tx.clientHeight + 1 && (tx.scrollWidth <= tx.clientWidth + 1 || att.classList.contains('w2')) : null,
          attClamped: tx ? tx.scrollHeight > tx.clientHeight + 1 : null,
        };
      });
      const tag = `${scen} @${w}x${h}${note ? ' (' + note + ')' : ''}`;
      const inside = (b) => b && b.l >= -1 && b.t >= -1 && b.r <= w + 1 && b.b <= h + 1 && b.w > 0 && b.h > 0;
      chk(`${tag}: the stage is fully inside the viewport`, inside(g.stage), JSON.stringify(g.stage));
      chk(`${tag}: no horizontal or vertical document overflow`, g.doc[0] <= w && g.doc[1] <= h, String(g.doc));
      chk(`${tag}: nothing extends past the stage`, g.past.length === 0, g.past.slice(0, 5).join(','));
      chk(`${tag}: no panel clips its content`, g.clipped.length === 0, g.clipped.join(','));
      chk(`${tag}: the Wazuh Integrity chip is on screen`, inside(g.chip), JSON.stringify(g.chip));
      chk(`${tag}: its value is bounded inside the chip`, g.valBounded);
      chk(`${tag}: the Wazuh Services row is on screen`, inside(g.row), JSON.stringify(g.row));
      chk(`${tag}: CORE OK is absent`, !g.coreOk);
      if (scen.startsWith('packetc') && scen !== 'packetc-unknown') {
        chk(`${tag}: the CRITICAL chip is red`, /255, 46|255, 0|rgb\(255/.test(g.chipColor || '') && /^CRITICAL/.test(g.chipText || ''), g.chipColor);
        chk(`${tag}: the attention list carries the Wazuh reason on screen`, inside(g.att) && /AUTH \d\/9 FRESH/.test(g.attText || ''), g.attText);
      }
      if (scen === 'packetc') {
        chk(`${tag}: the full reason is visible, not clipped (AUTH 1/9 FRESH · AGENTS 9/9 · DROPS 0)`,
          g.attFits === true && g.attClamped === false && /AUTH 1\/9 FRESH · AGENTS 9\/9 · DROPS 0$/.test(g.attText || ''), `${g.attText} fits=${g.attFits} clamped=${g.attClamped}`);
      }
      if (scen === 'packetc-unknown') {
        chk(`${tag}: UNKNOWN is fail-visible, never green`, /^UNKNOWN/.test(g.chipText || '') && !/\bg\b/.test(g.rowDot || ''), `${g.chipText} ${g.rowDot}`);
      }
      await page.close();
    }
  } finally { srv.kill(); }
}
await browser.close();
console.log(`P11: ${fails.length} failed`);
process.exit(fails.length ? 1 : 0);
