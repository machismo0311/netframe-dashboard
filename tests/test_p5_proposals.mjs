/* P5 offline proposal-awareness fixtures - NO production access, no DOM, no network.
   Extracts the pure functions from the shipped HTML and asserts the invariants that keep an
   AWARENESS surface from becoming an authority or a liar.

   The failure this guards is the one the estate keeps re-learning at each new seam: a count that
   looks authoritative when nothing could actually see. Zero proposals from a dead intake source
   is not zero. */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(HERE, '..', 'netframe-dashboard.html'), 'utf8');
const serve = readFileSync(join(HERE, '..', 'serve.py'), 'utf8');
const pb = html.match(/\/\* NFM-PROPOSAL-PANEL-BEGIN[\s\S]*?\/\* NFM-PROPOSAL-PANEL-END \*\//);
const ib = html.match(/\/\* NFM-INCIDENT-PANEL-BEGIN[\s\S]*?\/\* NFM-INCIDENT-PANEL-END \*\//);
if (!pb) { console.error('FAIL  cannot extract NFM-PROPOSAL-PANEL block'); process.exit(1); }
const ageFn = html.match(/function nfmAgeText\(sec\)\{[\s\S]*?\n\}/);
const F = new Function(ageFn[0] + ib[0] + pb[0] +
  '\n return {nfmProposalState, nfmProposalPanel, nfmIncidentPanel, nfmEsc};')();
const { nfmProposalState, nfmProposalPanel, nfmIncidentPanel, nfmEsc } = F;

let fails = [];
const chk = (n, c, d) => { console.log((c ? 'PASS  ' : 'FAIL  ') + n + (!c && d ? '  [' + d + ']' : '')); if (!c) fails.push(n); };

/* ---------------------------------------------------------------- pinned contract fixture */
const raw = readFileSync(join(HERE, 'fixtures', 'netframe-proposal-dashboard-feed-v1.json'));
const contract = readFileSync(join(HERE, 'fixtures', 'PROPOSAL-CONTRACT.md'), 'utf8');
const sha = createHash('sha256').update(raw).digest('hex');
chk('the pinned proposal contract fixture matches the producer repository digest',
    contract.includes(sha), sha);
const FIX = JSON.parse(raw.toString());
const NOW = Date.parse(FIX.generated_at) / 1000;
const feed = (o) => Object.assign(JSON.parse(JSON.stringify(FIX)), o || {});

/* ---------------------------------------------------------------- a real awaiting proposal */
{
  const d = nfmProposalState(feed(), NOW);
  const h = nfmProposalPanel(feed(), NOW);
  chk('a feed with proposals awaiting review is shown', d.show === true);
  chk('...with the awaiting count', d.awaiting === 2 && h.includes('2 AWAITING REVIEW'));
  chk('...split into still-firing and cleared', d.firing === 1 && d.cleared === 1);
  chk('...the proposal id is rendered', h.includes(FIX.proposals[0].proposal_id));
  chk('...and the alert name', h.includes(FIX.proposals[0].alertname));
  chk('...with the source named', h.includes('prometheus'));
  chk('...and the suggested event', h.includes('SUGGESTS DETECTED'));
  chk('OWNER REVIEW REQUIRED is stated', h.includes('OWNER REVIEW REQUIRED'));
  chk('...with MAX_AUTO_CLASS 0', h.includes('MAX_AUTO_CLASS 0'));
  chk('...and the CLI named as the review surface',
      h.includes('netframe incident proposals'));
  chk('a proposal is explicitly not an incident', h.includes('a proposal is not an incident'));
  for (const word of ['INCIDENT DETECTED', 'INCIDENT ACTIVE', 'OUTAGE', 'ALL CLEAR', 'HEALTHY'])
    chk(`the panel never says ${word}`, !h.toUpperCase().includes(word));
}

/* ---------------------------------------------------------------- firing vs cleared */
{
  const h = nfmProposalPanel(feed(), NOW);
  chk('a still-firing source is labelled SOURCE STILL FIRING', h.includes('SOURCE STILL FIRING'));
  chk('a cleared source is labelled SOURCE ALERT CLEARED', h.includes('SOURCE ALERT CLEARED'));
  chk('...and the two are different strings in the same panel',
      h.indexOf('SOURCE STILL FIRING') !== h.indexOf('SOURCE ALERT CLEARED'));
  chk('a cleared source still awaits an owner decision',
      h.includes('still awaits an owner decision'));
  chk('...and explicitly resolves no incident', h.includes('no incident was resolved'));
  chk('a cleared proposal is NOT rendered as resolved',
      !/PROPOSAL RESOLVED|INCIDENT RESOLVED/.test(h.toUpperCase()));
  chk('the cleared proposal is still counted as awaiting',
      nfmProposalState(feed(), NOW).awaiting === 2);
}

/* ---------------------------------------------------------------- no source, no claim */
{
  const dead = feed({ collector: Object.assign({}, FIX.collector, { status: 'UNAVAILABLE',
                        reason: 'prometheus unreachable' }),
                      summary: { awaiting_owner_review: null, pending_firing: null,
                                 pending_cleared: null, counts_are_authoritative: false },
                      proposals: [] });
  const d = nfmProposalState(dead, NOW);
  const h = nfmProposalPanel(dead, NOW);
  chk('an unavailable intake source is shown, not hidden', d.show === true);
  chk('...as INTAKE SOURCE UNAVAILABLE', d.status === 'INTAKE_UNAVAILABLE'
      && h.includes('INTAKE SOURCE UNAVAILABLE'));
  chk('...and NEVER as a count of zero', !/\b0 AWAITING REVIEW\b/.test(h), h.slice(0, 200));
  chk('...with the reason surfaced', h.includes('prometheus unreachable'));

  const stale = feed({ collector: Object.assign({}, FIX.collector, { status: 'STALE',
                         reason: 'the last intake observation is 400s old' }),
                       summary: Object.assign({}, FIX.summary,
                                              { counts_are_authoritative: false }) });
  chk('a stale collector is PROPOSAL INTAKE STALE',
      nfmProposalState(stale, NOW).status === 'INTAKE_STALE');
  chk('...and is not a count either', !/\bAWAITING REVIEW\b/.test(nfmProposalPanel(stale, NOW)));

  const lying = feed({ summary: Object.assign({}, FIX.summary,
                                              { counts_are_authoritative: false }) });
  chk('a count the producer did not mark authoritative is refused',
      nfmProposalState(lying, NOW).status === 'INTAKE_UNAVAILABLE');
}

/* ---------------------------------------------------------------- freshness precedence */
{
  const d = nfmProposalState(feed(), NOW + 200);
  chk('a projection older than the bound is STALE', d.status === 'STALE');
  chk('...with an explicit banner', d.banner === 'PROPOSAL FEED STALE');
  chk('...and no count is presented', d.awaiting === null);
  chk('exactly at the bound is still current',
      nfmProposalState(feed(), NOW + 120).status === 'OK');
  chk('one second past it is not', nfmProposalState(feed(), NOW + 121).status === 'STALE');
  chk('a fresh envelope with a stale collector still fails closed',
      nfmProposalState(feed({ collector: Object.assign({}, FIX.collector,
                                                       { status: 'STALE' }) }), NOW).status
      === 'INTAKE_STALE');
  chk('a feed with no timestamp is not current',
      nfmProposalState(feed({ generated_at: null }), NOW).status === 'STALE');
}

/* ---------------------------------------------------------------- transport failure */
{
  const d = nfmProposalState(null, NOW);
  chk('an absent feed is PROPOSAL FEED UNAVAILABLE', d.status === 'FEED_UNAVAILABLE');
  chk('...shown rather than silently hidden', d.show === true);
  chk('...and never rendered as zero',
      !/\b0 AWAITING REVIEW\b/.test(nfmProposalPanel(null, NOW)));
  chk('an unknown schema fails visibly',
      nfmProposalState(feed({ schema: 'netframe-proposal-dashboard-feed/v2' }), NOW).status
      === 'UNSUPPORTED');
  chk('a FEED_UNAVAILABLE envelope from the backend is honoured',
      nfmProposalState({ schema: 'netframe-proposal-dashboard-feed/v1',
                         status: 'FEED_UNAVAILABLE', error: 'HTTPError: 503' }, NOW).status
      === 'FEED_UNAVAILABLE');
  chk('...and transport failure is distinct from intake failure',
      nfmProposalState(null, NOW).status !== 'INTAKE_UNAVAILABLE');
}

/* ---------------------------------------------------------------- steady state is quiet */
{
  const zero = feed({ summary: { awaiting_owner_review: 0, pending_firing: 0, pending_cleared: 0,
                                 counts_are_authoritative: true }, proposals: [] });
  const d = nfmProposalState(zero, NOW);
  chk('zero awaiting with a fresh collector renders nothing at all', d.show === false);
  chk('...producing empty markup, so the operations layout is untouched',
      nfmProposalPanel(zero, NOW) === '');
  chk('...and it is an authoritative zero, not an unknown', d.awaiting === 0 && d.status === 'OK');
  chk('...but the wall never says ALL CLEAR or HEALTHY',
      !/ALL CLEAR|HEALTHY|NO ALERTS|NO INCIDENTS/.test(nfmProposalPanel(zero, NOW).toUpperCase()));
}

/* ---------------------------------------------------------------- decided proposals */
{
  const decided = feed({ summary: { awaiting_owner_review: 0, pending_firing: 0,
                                    pending_cleared: 0, counts_are_authoritative: true },
                         proposals: [] });
  chk('an accepted or dismissed proposal leaves the awaiting count',
      nfmProposalState(decided, NOW).awaiting === 0);
  chk('...without the wall implying anything was published',
      !/PUBLISHED|CAPTURE CREATED/.test(nfmProposalPanel(decided, NOW).toUpperCase()));
}

/* ---------------------------------------------------------------- advisory, bounded, passive */
{
  const adv = feed({ proposals: [Object.assign({}, FIX.proposals[0],
                                 { possible_existing_incident_count: 2 })] });
  const h = nfmProposalPanel(adv, NOW);
  chk('possible existing incidents are a count', h.includes('2 POSSIBLE EXISTING INCIDENTS'));
  chk('...never a link or a match', !/MATCHED|LINKED TO|INC-/.test(h));
  const capped = feed({ more_not_shown: 4 });
  chk('a hidden remainder is stated', nfmProposalPanel(capped, NOW).includes('4 MORE NOT SHOWN'));
  chk('...and counted in the state', nfmProposalState(capped, NOW).more === 4);
  const h2 = nfmProposalPanel(feed(), NOW);
  for (const ctrl of ['<button', 'onclick', 'onchange', 'href=', '<form', '<input'])
    chk(`the panel renders no ${ctrl}`, !h2.toLowerCase().includes(ctrl));
  const src = pb[0];
  for (const verb of ['accept', 'dismiss', 'publish', 'remediat', 'silence'])
    chk(`the renderer has no ${verb} path`, !new RegExp('function\\\\s+\\\\w*' + verb, 'i').test(src));
  chk('the renderer never selects an incident for display',
      !/display-selection|incident display|selectIncident/i.test(src));
}

/* ---------------------------------------------------------------- coexistence */
{
  const ifeed = JSON.parse(readFileSync(join(HERE, 'fixtures',
                             'netframe-live-dashboard-feed-v1.json')).toString());
  const inow = Date.parse(ifeed.generated_at) / 1000;
  const noSel = { schema: 'netframe-live-dashboard-feed/v1', status: 'NO_SELECTION',
                  generated_at: ifeed.generated_at, selection: null, state: null,
                  state_generated_at: null };
  chk('with NO_SELECTION the incident panel renders nothing',
      nfmIncidentPanel(noSel, inow) === '');
  chk('...while the proposal panel still shows what awaits review',
      nfmProposalPanel(feed(), NOW) !== '');
  chk('this is the point of the feature: awareness without selection',
      nfmProposalState(feed(), NOW).awaiting === 2);
  chk('with an incident selected BOTH surfaces render',
      nfmIncidentPanel(ifeed, inow) !== '' && nfmProposalPanel(feed(), NOW) !== '');
  chk('a proposal never becomes the displayed incident',
      !nfmIncidentPanel(ifeed, inow).includes(FIX.proposals[0].proposal_id));
  chk('a displayed incident does not hide pending proposals',
      nfmProposalPanel(feed(), NOW).includes(FIX.proposals[0].proposal_id));
}

/* ---------------------------------------------------------------- escaping */
{
  const nasty = '<script>alert(1)</script>';
  const bad = feed({ proposals: [Object.assign({}, FIX.proposals[0], {
    proposal_id: nasty + '-id', alertname: nasty + '-alert', source: nasty + '-src',
    proposal_state: nasty + '-state', suggested_event: nasty + '-ev',
    suggested_affected_systems: [nasty + '-sys'] })] });
  const h = nfmProposalPanel(bad, NOW);
  chk('no raw <script> survives', !h.includes('<script>'));
  chk('...it is escaped as text', h.includes('&lt;script&gt;'));
  for (const f of ['-id', '-alert', '-src', '-state', '-ev', '-sys'])
    chk(`${f} is escaped`, h.includes('&lt;script&gt;alert(1)&lt;/script&gt;' + f));
  chk('no javascript: or handler can be injected', !/javascript:|onerror=|onload=/i.test(h));
  chk('raw annotations are not in the contract at all',
      !('annotations' in FIX.proposals[0]) && !JSON.stringify(FIX).includes('annotation'));
  chk('raw labels are not in the contract at all',
      !('labels' in FIX.proposals[0]) && !JSON.stringify(FIX).includes('severity'));
}

/* ---------------------------------------------------------------- backend independence */
{
  const fnBody = (name) => {
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
  chk('/api/proposals is a separate endpoint', serve.includes('"/api/proposals"'));
  chk('...with its own lock', serve.includes('PLOCK') && serve.includes('with PLOCK:'));
  chk('...and its own refresher thread', serve.includes('target=proposal_refresher'));
  for (const fn of ['build_state', 'refresher'])
    chk(`the operations ${fn}() never acquires the proposal feed`,
        !fnBody(fn).includes('fetch_proposal_feed') && !/\bPROPOSALS\b/.test(fnBody(fn)), fn);
  chk('the incident refresher never touches the proposal feed',
      !fnBody('incident_refresher').includes('PROPOSAL'));
  chk('the proposal refresher never touches the operations snapshot or the incident feed',
      !/\bSTATE\b/.test(fnBody('proposal_refresher'))
      && !/\bINCIDENT\b/.test(fnBody('proposal_refresher')));
  chk('a proposal feed failure yields an envelope, not an exception',
      serve.includes('_proposals_unavailable'));
  chk('the page polls proposals separately',
      html.includes('async function pullProposals()') && html.includes("fetch('/api/proposals'"));
  chk('...catching its failure without touching the other pulls',
      /pullProposals\(\)\{[\s\S]*?catch\(e\)\{ feed = null; \}/.test(html));
  chk('no proposal-related estate query exists in the backend',
      !/prom\w*\([^)]*proposal|proposal[^\n]*prom\(/i.test(serve));
  chk('the panel is hidden unless the renderer produced markup',
      html.includes("host.className = html ? 'on' : '';") && html.includes('#proposals{display:none}'));
}

console.log('----');
console.log('P5 PROPOSAL AWARENESS: ' + (fails.length ? 'FAIL ' + JSON.stringify(fails) : 'PASS'));
process.exit(fails.length ? 1 : 0);
