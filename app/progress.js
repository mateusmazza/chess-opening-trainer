/* =====================================================================
   Progress -- are the mistakes actually going down?

   Three measures, each answering a different question:
     1. first-try accuracy per study day      do I recall my moves in training?
     2. trouble spots, open and fixed          which moves keep slipping, and
                                               are they being cleared?
     3. staying on book in real games          does any of it reach the board?
                                               (app/mygames.js, optional)

   Loaded before app.js and only called at render time, so it may use any of
   app.js's globals (state, troubleSpots, startFocus, ...).
   ===================================================================== */
'use strict';

const MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function dayLabel(d){ const x=new Date(d*864e5); return `${MONTHS[x.getMonth()]} ${x.getDate()}`; }
function monthLabel(m){ const [y,mo]=m.split('-'); return `${MONTHS[+mo-1]} ${y.slice(2)}`; }

// One series of percentages as thin bars on a baseline. Each bar carries its
// own tooltip (title) and an accessible label; the same numbers are listed in
// the table below the chart, so nothing is colour- or hover-only.
function barChart(rows, {label, value, tip, max=100}){
  if(!rows.length) return '';
  const bars=rows.map(r=>{
    const v=value(r), h=Math.max(2, Math.round(v/max*100));
    return `<div class="pc-col" title="${esc(tip(r))}" aria-label="${esc(tip(r))}" tabindex="0">
      <div class="pc-bar" style="height:${h}%"></div>
      <span class="pc-x">${esc(label(r))}</span></div>`;
  }).join('');
  return `<div class="pc-chart" role="img">
      <div class="pc-grid"><span>100%</span><span>50%</span><span>0</span></div>
      <div class="pc-bars">${bars}</div></div>`;
}

function weekTrend(){
  const t=today();
  const cur=accuracyBefore(t+1, 7);
  const firstOfCur=state.history.filter(h=>h.d<=t).slice(-7)[0];
  const prev=firstOfCur ? accuracyBefore(firstOfCur.d, 7) : null;
  return {cur, prev, delta:(cur!==null && prev!==null) ? cur-prev : null};
}
function trendSpan(delta){
  if(delta===null) return '';
  return ` <span class="${delta>=0?'up':'down'}">${delta>=0?'▲':'▼'} ${Math.abs(delta)}</span>`;
}

/* ---------------- home card ---------------- */
function renderProgressCard(host){
  if(!host) return;
  const tr=weekTrend(), spots=troubleSpots(), fixed=fixedCount();
  const open=spots.filter(s=>s.status==='trouble').length;
  const mg=(typeof MYGAMES!=='undefined' && MYGAMES.monthly && MYGAMES.monthly.length)
    ? MYGAMES.monthly[MYGAMES.monthly.length-1] : null;
  const bits=[];
  if(tr.cur!==null) bits.push(`<span><b>${tr.cur}%</b> right first time (last 7 study days)${trendSpan(tr.delta)}</span>`);
  bits.push(`<span><b>${open}</b> trouble spot${open===1?'':'s'} · <b>${fixed}</b> fixed</span>`);
  if(mg) bits.push(`<span><b>${Math.round(mg.clean/mg.games*100)}%</b> on book in real games (${monthLabel(mg.month)})</span>`);
  host.className='progress-card';
  host.innerHTML=`<div class="pg-stats">${bits.join('')}</div>
    <div class="pg-actions">
      ${spots.length?`<button class="ghost-btn" id="pgFocus">🎯 Fix trouble spots (${spots.length})</button>`:''}
      <a href="#" id="pgMore">see your progress ›</a></div>`;
  const f=host.querySelector('#pgFocus');
  if(f) f.addEventListener('click',()=>startFocus(spots.map(s=>s.key)));
  host.querySelector('#pgMore').addEventListener('click',e=>{ e.preventDefault(); go('progress'); });
}

/* ---------------- full view ---------------- */
function lineContext(card, step){
  // the moves that lead to the position, numbered, then "?" for the answer
  let str='';
  for(let i=0;i<step;i++){ const e=card.edges[i]; str+=(i%2===0?`${i/2+1}.`:'')+e.san+' '; }
  return str + (step%2===0?`${step/2+1}.`:`${Math.floor(step/2)+1}…`) + '?';
}

function renderProgress(){
  app.appendChild(tpl('tpl-progress'));
  const body=$('#progressBody');
  let html='';

  // ---- 1. accuracy in training ----
  const rows=state.history.slice(-30);
  const tr=weekTrend();
  html+=`<h2 class="section-title">Right first time, in training</h2>`;
  if(!rows.length){
    html+=`<p class="muted">Nothing yet: this fills in from your next session. Every move you
      play is recorded on its own, so you will see the trend within a few days.</p>`;
  } else {
    const all=rows.reduce((a,h)=>a+h.moves,0), miss=rows.reduce((a,h)=>a+h.miss,0);
    html+=`<div class="pg-hero"><b>${tr.cur}%</b><span>last 7 study days${trendSpan(tr.delta)}
      ${tr.prev!==null?` · was ${tr.prev}%`:''} · ${(miss/all*10).toFixed(1)} misses per 10 moves overall</span></div>`;
    html+=barChart(rows, {label:r=>dayLabel(r.d).split(' ')[1], value:r=>Math.round(r.first/r.moves*100),
      tip:r=>`${dayLabel(r.d)}: ${Math.round(r.first/r.moves*100)}% (${r.first} of ${r.moves} moves right first time)`});
  }

  // ---- 2. trouble spots ----
  const spots=troubleSpots();
  html+=`<h2 class="section-title">Moves that keep slipping</h2>
    <p class="muted small">A missed move stays here until you play it right first time, without
    hesitating, on two different days after you missed it. Stubborn ones (missed ${STUBBORN}+ times) come first.
    <b>${fixedCount()}</b> fixed so far.</p>`;
  if(!spots.length){
    html+=`<p class="muted">None right now 🎉</p>`;
  } else {
    html+=`<button class="big-btn small" id="pgDrillAll">🎯 Drill all ${spots.length}</button><div class="spot-list">`;
    for(const x of spots.slice(0,25)){
      const tags=[];
      if(x.stubborn) tags.push('<span class="tag-chip bad">stubborn</span>');
      if(x.s.gameMiss) tags.push('<span class="tag-chip">real game</span>');
      if(x.status==='shaky') tags.push('<span class="tag-chip">slow</span>');
      if(x.s.miss) tags.push(`<span class="tag-chip">missed ${x.s.miss}×</span>`);
      html+=`<div class="spot" data-key="${esc(x.key)}">
        <div class="spot-top"><span class="spot-course">${esc(x.card.courseName)}</span>${tags.join('')}</div>
        <div class="spot-line">${esc(lineContext(x.card, x.step))}</div>
        <details><summary>show the move and why</summary>
          <b>${esc(moveLabel(x.edge, x.step))}</b> ${esc(x.edge.note||(x.edge.facts||[]).join(' · '))}
        </details></div>`;
    }
    html+=`</div>`;
  }

  // ---- 3. real games ----
  if(typeof MYGAMES!=='undefined' && MYGAMES.monthly){
    const m=MYGAMES.monthly.filter(r=>r.games>0);
    html+=`<h2 class="section-title">Your repertoire in real games</h2>
      <p class="muted small">Of your games that reached your repertoire, the share where you stayed
      on book for as long as your opponent did. Refreshed with your games
      (<code>build/refresh.sh</code>).</p>`;
    html+=barChart(m, {label:r=>monthLabel(r.month).split(' ')[0], value:r=>Math.round(r.clean/r.games*100),
      tip:r=>`${monthLabel(r.month)}: ${Math.round(r.clean/r.games*100)}% (${r.clean} of ${r.games} games)`});
    const leaks=Object.entries(MYGAMES.moves).map(([key,g])=>{
      const wrong=Object.entries(g.played).filter(([s])=>!g.book.includes(s));
      return {key, g, wrong, n:wrong.reduce((a,[,c])=>a+c,0)};
    }).filter(l=>l.n>0 && MOVE_INDEX[l.key]).sort((a,b)=>b.n-a.n).slice(0,8);
    if(leaks.length){
      html+=`<div class="leak-list">`;
      for(const l of leaks){
        const color=l.key.split('|')[0];
        const {card,step}=MOVE_INDEX[l.key][0];
        const st=moveStatus(l.key);
        const edge=card.edges[step];
        const where=st==='fixed'||st==='solid' ? '✓ solid in training now'
          : st==='trouble' ? 'being drilled' : 'not drilled yet';
        html+=`<div class="leak"><div><b>${esc(lineContext(card, step))}</b>
            <span class="muted">as ${color}</span></div>
          <div class="muted small">you played ${l.wrong.map(([s,c])=>`${esc(s)} ×${c}`).join(', ')}
            · ${where}${l.g.lastMiss&&l.g.lastMiss.url?` · <a href="${esc(l.g.lastMiss.url)}" target="_blank" rel="noopener">last game ↗</a>`:''}</div>
          <details><summary>show the book move and why</summary>
            <b>${esc(l.g.book.join(' / '))}</b> ${esc(edge.note||'')}</details></div>`;
      }
      html+=`</div><button class="ghost-btn" id="pgLeaks">🎯 Drill these ${leaks.length} positions</button>`;
      body.dataset.leaks=JSON.stringify(leaks.map(l=>l.key));
    }
  }
  body.innerHTML=html;
  const all=$('#pgDrillAll'); if(all) all.addEventListener('click',()=>startFocus(spots.map(s=>s.key)));
  const lk=$('#pgLeaks'); if(lk) lk.addEventListener('click',()=>startFocus(JSON.parse(body.dataset.leaks)));
}
