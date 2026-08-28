/* P4 offline incident-panel fixtures - NO production access, no DOM, no network.
   Extracts the pure decision + render functions from the shipped HTML (single source of truth) and
   asserts the presentation invariants that keep a display surface from becoming an authority.

   The historical defect this guards, one layer further out than P2: the wall badge read LIVE for a
   12d13.7h outage because freshness was judged on "did the fetch work". An incident projection can
   now freeze the same way - a stale envelope full of metrics:FRESH is not fresh, and saying so is
   the whole reason the outer age wins. */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(HERE, '..', 'netframe-dashboard.html'), 'utf8');
const serve = readFileSync(join(HERE, '..', 'serve.py'), 'utf8');
const block = html.match(/\/\* NFM-INCIDENT-PANEL-BEGIN[\s\S]*?\/\* NFM-INCIDENT-PANEL-END \*\//);
if (!block) { console.error('FAIL  cannot extract NFM-INCIDENT-PANEL block'); process.exit(1); }
const ageFn = html.match(/function nfmAgeText\(sec\)\{[\s\S]*?\n\}/);
const F = new Function(ageFn[0] + block[0] +
  '\n return {nfmIncidentState, nfmIncidentPanel, nfmIncidentTone, nfmDomainState, nfmEsc};')();
const { nfmIncidentState, nfmIncidentPanel, nfmIncidentTone, nfmDomainState, nfmEsc } = F;

let fails = [];
const chk = (n, c, d) => { console.log((c ? 'PASS  ' : 'FAIL  ') + n + (!c && d ? '  [' + d + ']' : '')); if (!c) fails.push(n); };

/* ---------------------------------------------------------------- the pinned contract fixture */
const raw = readFileSync(join(HERE, 'fixtures', 'netframe-live-dashboard-feed-v1.json'));
const contract = readFileSync(join(HERE, 'fixtures', 'CONTRACT.md'), 'utf8');
const sha = createHash('sha256').update(raw).digest('hex');
chk('the pinned contract fixture matches the digest the producer repository recorded',
    contract.includes(sha), sha);
const FIX = JSON.parse(raw.toString());
/* generated_at 2026-08-27T13:00:30Z */
const NOW = Date.parse(FIX.generated_at) / 1000;

const feed = (o) => Object.assign({ schema: 'netframe-live-dashboard-feed/v1',
  generated_at: FIX.generated_at, status: 'OK', selection: FIX.selection,
  state: FIX.state, state_generated_at: FIX.state_generated_at, error: null }, o);

/* ---------------------------------------------------------------- NO_SELECTION is not health */
{
  const d = nfmIncidentState(feed({ status: 'NO_SELECTION', selection: null, state: null,
                                    state_generated_at: null }), NOW);
  chk('NO_SELECTION renders no panel at all', d.show === false);
  const h = nfmIncidentPanel(feed({ status: 'NO_SELECTION', selection: null, state: null,
                                    state_generated_at: null }), NOW);
  chk('...producing empty markup, so the operations layout is untouched', h === '');
  chk('...and never the words ALL CLEAR / NO INCIDENTS / HEALTHY',
      !/ALL CLEAR|NO INCIDENTS|HEALTHY|NOMINAL/i.test(h + JSON.stringify(d)));
}

/* ---------------------------------------------------------------- a valid selected feed */
{
  const d = nfmIncidentState(feed({}), NOW);
  const h = nfmIncidentPanel(feed({}), NOW);
  chk('a valid feed renders the incident identity', h.includes(FIX.state.subject.incident_id));
  chk('...the episode', d.episode === FIX.state.subject.episode);
  chk('...the recorded lifecycle status', d.lifecycleStatus === 'OPEN' && h.includes('LIFECYCLE'));
  chk('...the view status', d.viewStatus === FIX.state.view_status);
  chk('...and the cycle timestamp', h.includes(FIX.state.cycle.at));
  chk('a current projection is FRESH', d.freshness === 'FRESH', d.reason);
  chk('...and carries no stale banner', d.banner === null);
  chk('an unresolved record says NO RESOLUTION EVENT RECORDED',
      h.includes('NO RESOLUTION EVENT RECORDED'));
  chk('a null cycle duration is not rendered as a number',
      !/duration[^<]*0(?!\d)/i.test(h));
}

/* ---------------------------------------------------------------- freshness precedence */
{
  const stale = feed({});
  const d = nfmIncidentState(stale, NOW + 120);
  chk('a feed older than the bound is STALE', d.freshness === 'STALE', d.reason);
  chk('...with an explicit banner', d.banner === 'INCIDENT FEED STALE');
  const inner = FIX.state.evidence_coverage.metrics;
  chk('...even though the nested evidence claimed FRESH when it was made',
      inner && inner.status === 'FRESH', JSON.stringify(inner));
  chk('...so the domain is presented as STALE, not FRESH',
      nfmDomainState('FRESH', d.freshness) === 'STALE');
  const h = nfmIncidentPanel(stale, NOW + 120);
  chk('...and the panel says the values are not current',
      h.includes('INCIDENT FEED STALE') && h.includes('not now'));
  chk('...never printing METRICS FRESH over a stale projection', !h.includes('METRICS FRESH'));
  chk('a fresh projection does not degrade its domains',
      nfmDomainState('FRESH', 'FRESH') === 'FRESH');
  chk('exactly at the bound is still fresh', nfmIncidentState(stale, NOW + 90).freshness === 'FRESH');
  chk('one second past it is not', nfmIncidentState(stale, NOW + 91).freshness === 'STALE');
}

/* ---------------------------------------------------------------- producer failure */
{
  const f = feed({ status: 'PRODUCER_FAILED', error: 'prometheus unreachable',
                   generated_at: '2026-08-27T13:05:00Z' });
  const d = nfmIncidentState(f, Date.parse('2026-08-27T13:05:10Z') / 1000);
  chk('PRODUCER_FAILED is not rendered as "no incident"',
      d.show === true && d.incidentId === FIX.state.subject.incident_id);
  chk('...it is marked LAST KNOWN', d.lastKnown === true && /LAST KNOWN/.test(d.banner));
  /* 13:05:10 minus the projection's own 13:00:30 is 280s; minus the envelope's 13:05:00 is 10s.
     The two clocks are deliberately different and the projection's is the one that governs. */
  chk('...aged on the PROJECTION clock, not the envelope clock',
      Math.round(d.projAge) === 280 && Math.round(d.feedAge) === 10,
      'proj=' + Math.round(d.projAge) + ' feed=' + Math.round(d.feedAge));
  chk('...and is not called FRESH', d.freshness !== 'FRESH');
  const h = nfmIncidentPanel(f, Date.parse('2026-08-27T13:05:10Z') / 1000);
  chk('...with the producer error surfaced', h.includes('prometheus unreachable'));
}

/* ---------------------------------------------------------------- transport failures */
{
  const d = nfmIncidentState(null, NOW);
  chk('an absent feed is FEED UNAVAILABLE', d.status === 'FEED_UNAVAILABLE');
  chk('...and never NO_SELECTION', d.status !== 'NO_SELECTION');
  chk('...rendering a visible banner',
      nfmIncidentPanel(null, NOW).includes('INCIDENT FEED UNAVAILABLE'));
  const u = nfmIncidentState(feed({ schema: 'netframe-live-dashboard-feed/v2' }), NOW);
  chk('an unknown envelope version fails visibly', u.status === 'UNSUPPORTED');
  chk('...rather than being interpreted best-effort',
      nfmIncidentPanel(feed({ schema: 'netframe-live-dashboard-feed/v2' }), NOW)
        .includes('UNSUPPORTED INCIDENT FEED'));
  const n = nfmIncidentState(feed({ state: Object.assign({}, FIX.state,
                                     { schema: 'netframe-live-incident/v9' }) }), NOW);
  chk('an unknown nested model version also fails visibly', n.status === 'UNSUPPORTED');
  const noage = nfmIncidentState(feed({ generated_at: null }), NOW);
  chk('a feed with no usable timestamp is not fresh', noage.freshness === 'UNKNOWN');
}

/* ---------------------------------------------------------------- visual semantics */
{
  const view = (v) => nfmIncidentState(feed({ state: Object.assign({}, FIX.state,
                                              { view_status: v }) }), NOW);
  chk('OPEN_NO_CURRENT_SIGNAL is not green/ok', view('OPEN_NO_CURRENT_SIGNAL').tone !== 'ok');
  chk('...it is a warning tone', view('OPEN_NO_CURRENT_SIGNAL').tone === 'warn');
  chk('RECOVERY_SIGNALS is not green/ok', view('RECOVERY_SIGNALS').tone !== 'ok');
  chk('ACTIVE is critical', view('ACTIVE').tone === 'crit');
  chk('a CLOSED_RECORD is visibly different from an open one',
      view('CLOSED_RECORD').tone === 'dim' && view('CLOSED_RECORD').tone !== view('ACTIVE').tone);
  chk('no view status maps to ok',
      ['ACTIVE','DEGRADED_EVIDENCE','RECOVERY_SIGNALS','OPEN_NO_CURRENT_SIGNAL','UNKNOWN',
       'CLOSED_RECORD'].every(v => nfmIncidentTone(v) !== 'ok'));
  const resolved = Object.assign({}, FIX.state, { view_status: 'CLOSED_RECORD',
    lifecycle: Object.assign({}, FIX.state.lifecycle, { status: 'RESOLVED',
      resolution_recorded: true, events: [{event:'RESOLVED', at:'2026-08-27T13:10:00Z'}] }) });
  const h = nfmIncidentPanel(feed({ state: resolved }), NOW);
  chk('a resolved incident is NOT auto-cleared from the wall', h !== '');
  chk('...it says CLOSED RECORD', h.includes('CLOSED RECORD'));
  chk('...with the resolution time', h.includes('2026-08-27T13:10:00Z'));
  chk('...and states that the display selection is still active',
      h.includes('DISPLAY SELECTION STILL ACTIVE'));
}

/* ---------------------------------------------------------------- recovery vs resolution */
{
  const h = nfmIncidentPanel(feed({}), NOW);
  chk('the fixture carries recovery signals', FIX.state.recovery_signals.length >= 1);
  chk('recovery signals are rendered', h.includes('RECOVERY SIGNALS PRESENT'));
  chk('...alongside the incident status', h.includes('INCIDENT STATUS OPEN'));
  chk('...and the fact that the owner has not recorded a resolution',
      h.includes('OWNER HAS NOT RECORDED RESOLVED'));
  chk('recovery never renders the incident RESOLVED',
      !/(^|[^-])\bRESOLVED\b/.test(h.replace(/HAS NOT RECORDED RESOLVED/g, '')),
      h.match(/.{0,40}RESOLVED.{0,20}/g));
}

/* ---------------------------------------------------------------- impact vs current context */
{
  const st = Object.assign({}, FIX.state, { impact: {
    recorded_affected_systems: ['obs-core'],
    current_dependency_context: [{ of: 'obs-core', domain: 'switch:ex3400',
                                   label: 'CURRENT-CONTEXT' }] } });
  const h = nfmIncidentPanel(feed({ state: st }), NOW);
  chk('recorded impact is rendered', h.includes('IMPACT') && h.includes('obs-core'));
  chk('current dependency context is separately labelled', h.includes('CURRENT CONTEXT'));
  chk('...and says it does not rewrite recorded impact',
      h.includes('does not rewrite recorded impact'));
  chk('the two appear in different rows',
      h.indexOf('CURRENT CONTEXT') > h.indexOf('IMPACT'));
}

/* ---------------------------------------------------------------- transitions */
{
  const T = (arr) => nfmIncidentPanel(feed({ state: Object.assign({}, FIX.state,
    { changes_since_previous_cycle: arr, recovery_regressions: [] }) }), NOW);
  chk('a NEW transition is visible',
      T([{ kind: 'NEW', identity: 'alert:NodeSustainedIoWait', from: null, to: 'firing' }])
        .includes('NEW alert:NodeSustainedIoWait'));
  chk('a RECOVERED transition is visible',
      T([{ kind: 'RECOVERED', identity: 'alert:X', from: 'firing', to: null }])
        .includes('RECOVERED alert:X'));
  chk('a CHANGED transition shows both sides',
      T([{ kind: 'CHANGED', identity: 'metric:pve4:iowait', from: 'NORMAL', to: 'ELEVATED' }])
        .includes('NORMAL&#8594;ELEVATED')
      || T([{ kind: 'CHANGED', identity: 'metric:pve4:iowait', from: 'NORMAL', to: 'ELEVATED' }])
        .includes('NORMAL→ELEVATED'));
  chk('an empty transition list says nothing changed rather than inventing events',
      T([]).includes('nothing changed this cycle'));
  chk('UNCHANGED entries are omitted',
      !T([{ kind: 'UNCHANGED', identity: 'metric:x', from: 'NORMAL', to: 'NORMAL' }])
        .includes('metric:x'));
  const reg = nfmIncidentPanel(feed({ state: Object.assign({}, FIX.state,
    { recovery_regressions: [{ identity: 'metric:pve4:iowait',
        recovered_at: '2026-08-27T12:50:00Z', regressed_at: '2026-08-27T13:00:00Z' }] }) }), NOW);
  chk('a RECOVERY REGRESSION is visible', reg.includes('RECOVERY REGRESSION'));
}

/* ---------------------------------------------------------------- correlation + authority */
{
  const h = nfmIncidentPanel(feed({}), NOW);
  chk('the correlation assessment is rendered',
      h.includes('ASSESSMENT ' + FIX.state.correlation.assessment));
  chk('...the leading hypothesis', h.includes('HYPOTHESIS'));
  chk('...and the causation verdict', h.includes('CAUSATION ' + FIX.state.correlation.causation));
  const cc = Object.assign({}, FIX.state, { correlation: Object.assign({}, FIX.state.correlation,
    { contradicting_evidence: [{ statement: 'pve4 iowait remained normal' }] }) });
  chk('contradicting evidence is visible when supplied',
      nfmIncidentPanel(feed({ state: cc }), NOW).includes('CONTRADICTS pve4 iowait remained normal'));
  /* NOT_PROVEN contains the substring PROVEN and is the model's own vocabulary for the absence
     of proof - rendering it verbatim is correct. What must never appear is a CLAIM of proof that
     the source did not make. */
  chk('a claim of proof appears only when the model says PROVEN_BY_SOURCE',
      !/(?<!NOT_)PROVEN/.test(h) || FIX.state.correlation.causation === 'PROVEN_BY_SOURCE',
      (h.match(/.{0,12}PROVEN.{0,12}/g) || []).join(' | '));
  const proven = Object.assign({}, FIX.state, { correlation: Object.assign({},
    FIX.state.correlation, { causation: 'PROVEN_BY_SOURCE' }) });
  chk('...and it IS rendered when the source proved it',
      nfmIncidentPanel(feed({ state: proven }), NOW).includes('CAUSATION PROVEN_BY_SOURCE'));
  chk('the next investigation is marked NOT EXECUTED', h.includes('NOT EXECUTED'));
  chk('...and OWNER ACTION REQUIRED', h.includes('OWNER ACTION REQUIRED'));
  chk('MAX_AUTO_CLASS 0 is displayed', h.includes('MAX_AUTO_CLASS 0'));
  chk('...with an advisory label', h.includes('ADVISORY'));
  const ex = Object.assign({}, FIX.state, { next_investigation:
    { action: 'check smart', executed: true } });
  chk('an executed recommendation would be shown as executed, not silently normalised',
      nfmIncidentPanel(feed({ state: ex }), NOW).includes('EXECUTED')
      && !nfmIncidentPanel(feed({ state: ex }), NOW).includes('NOT EXECUTED'));
  chk('the wall renders no remediation verbs',
      !/RESTARTED|FIXED|REMEDIATED|ROLLED BACK|SILENCED/.test(h));
}

/* ---------------------------------------------------------------- pending capture */
{
  const pc = Object.assign({}, FIX.state, { pending_captures:
    [{ capture_id: 'abc123', event_type: 'MITIGATED', publication_age: '4m' }] });
  const h = nfmIncidentPanel(feed({ state: pc }), NOW);
  chk('a pending capture is visible', h.includes('PENDING CAPTURE'));
  chk('...and the wall states it never publishes', h.includes('the wall never does'));
  chk('...with no publish control rendered', !/<button|onclick=/i.test(h));
}

/* ---------------------------------------------------------------- no source, no claim */
{
  const bare = { schema: 'netframe-live-incident/v1',
                 subject: { incident_id: 'INC-BARE', episode: 0 },
                 cycle: { at: FIX.state.cycle.at, completeness: 'PARTIAL' },
                 view_status: 'DEGRADED_EVIDENCE', lifecycle: { status: 'OPEN' },
                 authority: { max_auto_class: 0 } };
  const h = nfmIncidentPanel(feed({ state: bare }), NOW);
  chk('missing correlation renders UNAVAILABLE', h.includes('CORRELATION') && h.includes('UNAVAILABLE'));
  chk('missing signals render NOT MEASURED', h.includes('NOT MEASURED'));
  chk('a missing next investigation renders UNKNOWN', h.includes('UNKNOWN'));
  chk('...and no placeholder that looks like a real value',
      !/0%|N\/A|--|ALL CLEAR/.test(h));
  chk('missing impact says none recorded rather than inventing systems',
      h.includes('none recorded'));
}

/* ---------------------------------------------------------------- operator text is escaped */
{
  const nasty = '<script>alert(1)</script>';
  const st = Object.assign({}, FIX.state, {
    subject: { incident_id: nasty + '-id', episode: 0 },
    impact: { recorded_affected_systems: [nasty + '-sys'], current_dependency_context:
      [{ of: nasty + '-of', domain: nasty + '-dom', label: 'CURRENT-CONTEXT' }] },
    changes_since_previous_cycle: [{ kind: 'NEW', identity: nasty + '-tr', from: null, to: 'x' }],
    correlation: Object.assign({}, FIX.state.correlation, { hypotheses: [nasty + '-hyp'],
      contradicting_evidence: [{ statement: nasty + '-ev' }] }),
    next_investigation: { action: nasty + '-next', executed: false } });
  const h = nfmIncidentPanel(feed({ state: st }), NOW);
  chk('no raw <script> survives anywhere in the panel', !h.includes('<script>'));
  chk('...it is escaped as text', h.includes('&lt;script&gt;'));
  chk('...for the incident id', h.includes('&lt;script&gt;alert(1)&lt;/script&gt;-id'));
  chk('...for affected systems', h.includes('&lt;script&gt;alert(1)&lt;/script&gt;-sys'));
  chk('...for current context', h.includes('-dom'));
  chk('...for transitions', h.includes('-tr'));
  chk('...for hypotheses', h.includes('-hyp'));
  chk('...for contradicting evidence', h.includes('-ev'));
  chk('...and for the next investigation', h.includes('-next'));
  chk('quotes and ampersands are escaped too',
      nfmEsc('a"b&c\'d<e>') === 'a&quot;b&amp;c&#39;d&lt;e&gt;', nfmEsc('a"b&c\'d<e>'));
  chk('no javascript: or on* handler can be injected',
      !/javascript:|onerror=|onload=/i.test(h));
}

/* ---------------------------------------------------------------- the wall does not reason */
{
  const src = block[0];
  for (const banned of ['threshold', 'baseline *', 'correlat', 'percentile', 'Math.max(...',
                        'ELEVATED :', 'assess(']) {
    if (banned === 'correlat')
      chk('the renderer contains no correlation logic', !/function\s+\w*[Cc]orrelat/.test(src));
    else if (banned === 'threshold')
      chk('the renderer computes no metric threshold', !/\bthreshold\s*[=<>]/.test(src));
  }
  chk('the renderer never compares a metric value to a number',
      !/\.(current|window_stat|value)\s*[<>]=?\s*[\d.]/.test(src));
  chk('...nor to a variable it defined for the purpose',
      !/\.(current|window_stat|value)\s*[<>]=?\s*\w/.test(src));
  chk('...and defines no metric threshold constant of its own',
      !/\b(threshold|limit|cutoff|BASELINE|WARN_AT)\s*=/.test(src));
  /* Comparing a supplied verdict to pick a COLOUR is presentation. ASSIGNING one is reasoning:
     the regex therefore excludes ==, === and != so a legitimate comparison does not trip it. */
  chk('it renders the verdict the model supplied, verbatim',
      /m\.verdict/.test(src) && !/[^=!<>]=\s*['"]ELEVATED['"]/.test(src));
  chk('...and derives no verdict of its own',
      !/\?\s*['"]ELEVATED['"]\s*:/.test(src));
  chk('no incident-related Prometheus query exists in the dashboard backend',
      !/prom\w*\([^)]*incident|incident[^\n]*prom\(/i.test(serve));
  chk('the incident transport performs no estate query',
      !/def fetch_incident_feed[\s\S]*?\n\ndef /.test(serve) ||
      !/prom\(|sh\(|kubectl/.test(serve.split('def fetch_incident_feed')[1].split('\ndef ')[0]));
  chk('/api/incident is a separate endpoint from /api/state',
      serve.includes('"/api/incident"') && serve.includes('"/api/state"'));
  chk('the incident feed has its own lock, so it cannot block the operations snapshot',
      serve.includes('ILOCK') && serve.includes('with ILOCK:'));
  /* The operations snapshot builder and its refresher must not KNOW about the incident feed.
     This is the half of "the wall survives" that lives in the backend: acquisition on the
     operations thread would make one unreachable feed an ERROR snapshot for the whole wall. */
  const fnBody = (name) => {
    /* By INDENTATION, not by "until the next def". Module-level constants sit between functions
       in this file, and a crude scan swallowed them - which made the assertion read another
       function's neighbours as its body. */
    const lines = serve.split('\n');
    const start = lines.findIndex(l => l.startsWith('def ' + name + '('));
    if (start < 0) return '';
    const out = [];
    for (let i = start + 1; i < lines.length; i++) {
      const l = lines[i];
      if (l.trim() === '' || /^\s/.test(l)) { out.push(l); continue; }
      break;
    }
    return out.join('\n');
  };
  for (const fn of ['build_state', 'refresher']) {
    const body = fnBody(fn);
    chk('the operations ' + fn + '() never acquires the incident feed',
        body.length > 0 && !body.includes('fetch_incident_feed') && !/\bINCIDENT\b/.test(body),
        fn);
  }
  chk('...and the incident refresher never touches the operations snapshot',
      !/\bSTATE\b/.test(fnBody('incident_refresher')));
  chk('...nor the operations lock', !fnBody('incident_refresher').includes('with LOCK:'));
  chk('...and its own refresher thread',
      serve.includes('target=incident_refresher'));
  chk('a feed failure yields an envelope, not an exception',
      serve.includes('_feed_unavailable'));
  chk('the page polls the incident feed separately from /api/state',
      html.includes('async function pullIncident()') &&
      html.includes("fetch('/api/incident'"));
  chk('...and catches its failure without touching the operations pull',
      /pullIncident\(\)\{[\s\S]*?catch\(e\)\{ feed = null; \}/.test(html));
  chk('the panel element is hidden unless the renderer produced markup',
      html.includes("host.className = html ? 'on' : '';") && html.includes('#incident{display:none}'));
}

console.log('----');
console.log('P4 INCIDENT PANEL: ' + (fails.length ? 'FAIL ' + JSON.stringify(fails) : 'PASS'));
process.exit(fails.length ? 1 : 0);
