/* Render probe (test harness only; appended by fixture_server.py when the page is opened with ?probe=1).
   Reads back what the page believes and what is ACTUALLY VISIBLE, and writes it into a hidden,
   out-of-flow <pre id="probe"> that headless --dump-dom can read. */
setTimeout(function(){
  var stage=document.getElementById('stage'), sr=stage.getBoundingClientRect();
  function inside(e, box){ var a=e.getBoundingClientRect(), b=box.getBoundingClientRect();
    return a.height>0 && a.width>0 && a.top>=b.top-1 && a.bottom<=b.bottom+1 && a.left>=b.left-1 && a.right<=b.right+1; }
  function visText(box){ /* text of every element fully inside box (clipped text does not count) */
    var out=[]; box.querySelectorAll('*').forEach(function(e){ if(!e.children.length && inside(e, box) && inside(e, stage)) out.push(e.textContent); });
    return out.join(' | '); }
  var v=currentView();
  var crit=v.conds.filter(function(c){return c.sev==='r';}).map(function(c){return c.sys;});
  var att=document.getElementById('attention');
  var attVis=att?visText(att):'';
  var svc=[].slice.call(document.querySelectorAll('.svcrows .row, #services .row'));
  var svcBox=svc.length?svc[0].closest('.panel'):null;
  var past=[].slice.call(document.querySelectorAll('#main .panel, #main > *, .panel, .node')).filter(function(e){
    var r=e.getBoundingClientRect(); return r.height>0 && r.bottom>sr.bottom+1; }).length;
  var clipped=[].slice.call(document.querySelectorAll('.panel')).filter(function(p){ return p.scrollHeight>p.clientHeight+2; })
    .map(function(p){ var t=p.querySelector('.t'); return t?t.textContent:'?'; });
  var lamps=[0,1,2,3].map(function(i){ var d=document.getElementById('lamp'+i); return d?(d.querySelector('.v').textContent+' :: '+d.querySelector('.w').textContent):''; });
  var o={state:v.ds.state, lamps:lamps,
    beam:(stage.className.match(/beam-\w+/)||[''])[0], overlay:(document.getElementById('overlay')||{}).className||'',
    overlayText:(document.getElementById('ovA')||{}).textContent||'',
    criticalSystems:crit,
    criticalVisibleInAttention: att ? crit.filter(function(n){ return attVis.indexOf(n)>=0; }).length+'/'+crit.length : 'n/a',
    attentionOverflowing: att ? (att.scrollHeight>att.clientHeight+1) : 'n/a',
    servicesVisible: svcBox ? svc.filter(function(r){return inside(r, svcBox);}).length+'/'+svc.length : 'n/a',
    elementsPastStageBottom: past, panelsClippingContent: clipped,
    incidentShown: (document.getElementById('incident')||{}).className==='on',
    proposalsShown: (document.getElementById('proposals')||{}).className==='on',
    randomInPage: /Math\.random/.test(document.documentElement.innerHTML)};
  var p=document.createElement('pre'); p.id='probe';
  p.style.cssText='position:fixed;left:0;top:0;width:1px;height:1px;overflow:hidden;opacity:0';
  p.textContent='PROBE '+JSON.stringify(o); document.body.appendChild(p);
}, 7000);
