/* =====================================================================
   Opening Trainer  --  offline, single-file app logic
   Data comes from window.REPERTOIRE (generated, DB-verified book moves).
   No chess engine needed at runtime: every position is precomputed, and a
   user move is "correct" iff it matches the one book move for that position.
   ===================================================================== */
'use strict';

const STARTFEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const GLYPHS = {k:'♚',q:'♛',r:'♜',b:'♝',n:'♞',p:'♟'};
const MATURE = 21;            // interval (days) at which a line counts "mastered"
const $  = (s,r=document)=>r.querySelector(s);
const $$ = (s,r=document)=>[...r.querySelectorAll(s)];
const COURSES = window.REPERTOIRE;

/* ---------------- board themes (traditional, chess.com / Lichess style) ------ */
const THEMES = [
  {id:'green',  name:'Tournament Green', light:'#eeeed2', dark:'#769656'},
  {id:'walnut', name:'Walnut Parlor',    light:'#f0d9b5', dark:'#b58863'},
  {id:'blue',   name:'Tournament Hall',  light:'#dee3e6', dark:'#8ca2ad'},
];
function applyTheme(id){
  if(!THEMES.some(t=>t.id===id)) id='green';
  document.body.classList.remove(...THEMES.map(t=>'theme-'+t.id));
  document.body.classList.add('theme-'+id);
}

/* ---------------- date helpers (local day index) ---------------- */
function today(){ const d=new Date(); d.setHours(0,0,0,0); return Math.round(d.getTime()/864e5); }

/* ---------------- persistent state ---------------- */
const SKEY = 'openingTrainer.v1';
const DEFAULTS = () => ({
  v:1,
  profile:{xp:0, streak:0, bestStreak:0, lastDay:null, totalMoves:0,
           sessionsDone:0, perfectSessions:0,
           puzzleRating:null, puzzlesDone:0, puzzlesSolved:0},
  cards:{},                 // cardId -> {seen,ease,interval,due,reps,lapses,lastGrade,clean}
  moves:{},                 // moveKey -> per-move memory, see recordMove()
  history:[],               // one row per study day: {d, moves, first, miss}
  lessons:{},               // lessonId -> {rung,clean,tries,interval,due,mastered}
  badges:{},
  settings:{muted:false, newPerDay:4, maxSession:14, theme:'green', tacticsPerDay:6,
            focusPerDay:4},
  lastSummary:null,
});
let state = load();
// Saved state (or a backup) from any earlier version -> the current shape.
// Fields added later are simply filled with their defaults, so nothing that
// was saved is ever dropped.
function normalize(s){
  const d=DEFAULTS();
  return {...d,...s, profile:{...d.profile,...s.profile},
          settings:{...d.settings,...s.settings}, cards:s.cards||{},
          moves:s.moves||{}, history:s.history||[],
          lessons:s.lessons||{}, badges:s.badges||{}};
}
function load(){
  try{ const s=JSON.parse(localStorage.getItem(SKEY)); if(s&&s.v===1) return normalize(s);
  }catch(e){}
  return DEFAULTS();
}
function save(){ try{ localStorage.setItem(SKEY, JSON.stringify(state)); }catch(e){ /* storage blocked: keep running in-memory */ } }

// Progress lives only in this browser's localStorage, scoped to this origin — so a
// new machine, a different browser, or a cleared cache starts from zero. These two
// let you take it with you.
function exportProgress(){
  const blob=new Blob([JSON.stringify(state,null,2)],{type:'application/json'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download=`opening-trainer-progress-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('Progress exported.','');
}
function importProgress(){
  const inp=document.createElement('input');
  inp.type='file'; inp.accept='application/json,.json';
  inp.onchange=async ()=>{
    const f=inp.files&&inp.files[0]; if(!f) return;
    let s; try{ s=JSON.parse(await f.text()); }
    catch(e){ toast('That file is not valid JSON.',''); return; }
    if(!s||s.v!==1){ toast('Not an Opening Trainer backup.',''); return; }
    const inc=s.profile&&s.profile.xp||0, cur=state.profile.xp||0;
    if(cur>inc && !confirm(`This backup has ${inc} XP but you currently have ${cur}. Overwrite anyway?`)) return;
    // Route through the same normalisation load() uses, so older backups still work.
    state=normalize(s);
    save(); applyTheme(state.settings.theme); refreshTopbar(); go('home');
    toast(`Restored ${state.profile.xp} XP, ${Object.keys(state.cards).length} cards.`,'');
  };
  inp.click();
}

/* ---------------- card model (enumerate every variation) ---------------- */
let CARDS=[];                 // flat list
const CARD_BY_ID={};
const CARDS_BY_COURSE={};
// A line is what you review; a MOVE is what you actually forget. Every one of
// your moves gets a key -- your colour plus the moves that led to it -- so its
// memory is tracked on its own, shared by every line (and course) passing
// through that position. MOVE_INDEX finds the lines that contain a move.
const MOVE_INDEX={};          // moveKey -> [{card, step}]
(function enumerate(){
  for(const c of COURSES){
    CARDS_BY_COURSE[c.id]=[];
    let li=0;
    (function dfs(node,path){
      const ch=node.children;
      if(!ch.length){
        const card={id:`${c.id}#${li++}`, courseId:c.id, color:c.color,
          courseName:c.name, name:node.name||c.name, edges:path,
          myMoves:path.filter(e=>e.mine).length};
        CARDS.push(card); CARD_BY_ID[card.id]=card; CARDS_BY_COURSE[c.id].push(card);
        path.forEach((e,step)=>{ if(e.mine) (MOVE_INDEX[e.key]=MOVE_INDEX[e.key]||[]).push({card,step}); });
        return;
      }
      for(const e of ch){
        e.key=`${c.color}|${path.map(x=>x.san).join(' ')}`;
        dfs(e.node, path.concat(e));
      }
    })(c.tree, []);
  }
})();
const courseById = id => COURSES.find(c=>c.id===id);

/* ---------------- spaced repetition (SM-2 lite) ---------------- */
function srs(id){ return state.cards[id]; }

/* A tactic can retire; an opening line never does.
   Positions taken from your own games carry meta.maxReps from the build. Once
   you have solved one that many times cleanly it stops coming back: at that
   point you remember the board rather than the pattern, and the pattern is
   what the lessons drill. The card stays browsable in its pack -- it just
   leaves the review rotation. */
function cardCap(id){
  const c = (typeof PUZZLE_BY_ID!=='undefined' && PUZZLE_BY_ID[id])
         || (typeof LESSON_CARD_BY_ID!=='undefined' && LESSON_CARD_BY_ID[id]);
  return (c && c.meta && c.meta.maxReps) || 0;
}
function cardState(id){
  const s=srs(id);
  if(!s||!s.seen) return 'new';
  const cap=cardCap(id);
  if(cap && (s.clean||0)>=cap) return 'retired';
  if(s.due<=today()) return 'due';
  return s.interval>=MATURE ? 'mature' : 'learning';
}
// A clean line answered with hesitation is known, not yet automatic -- in a
// blitz game a move you have to dig for is a move you may not find. So it
// earns 'good' (a normal interval) rather than 'easy' (a stretched one).
function gradeFromMistakes(m, slow=0){
  return m===0 ? (slow?'good':'easy') : m===1?'good': m<=3?'hard':'again'; }
function schedule(id, grade){
  const t=today();
  let s=srs(id) || {seen:false, ease:2.5, interval:0, due:t, reps:0, lapses:0};
  switch(grade){
    case 'again': s.lapses++; s.reps=0; s.ease=Math.max(1.3,s.ease-0.2); s.interval=0; break;
    case 'hard':  s.reps++;   s.ease=Math.max(1.3,s.ease-0.15);
                  s.interval = s.interval? Math.max(1,Math.round(s.interval*1.2)) : 1; break;
    case 'good':  s.reps++;   s.interval = s.reps===1?1 : s.reps===2?3 : Math.round((s.interval||1)*s.ease); break;
    case 'easy':  s.reps++;   s.ease+=0.05;
                  s.interval = s.reps===1?2 : Math.round((s.interval||1)*s.ease*1.3); break;
  }
  s.interval=Math.min(s.interval,365);
  // clean = consecutive solves with no slip; drives retirement (see cardState)
  if(grade==='good'||grade==='easy') s.clean=(s.clean||0)+1; else s.clean=0;
  s.seen=true; s.due=t+s.interval; s.lastGrade=grade;
  state.cards[id]=s; return s;
}

/* ---------------- aggregate stats ---------------- */
// Graduated mastery for a single card: 0 when never seen, ~0.38 once introduced,
// climbing to 1.0 as the review interval reaches MATURE. This makes progress
// visible immediately instead of only after a line survives ~3 weeks of reviews.
function cardStrength(id){
  const s=srs(id);
  if(!s||!s.seen) return 0;
  return Math.min(1, 0.35 + 0.65*(s.interval/MATURE));
}
function courseProgress(courseId){
  const list=CARDS_BY_COURSE[courseId];
  let mature=0, due=0, seen=0, strength=0;
  for(const c of list){ const st=cardState(c.id);
    if(st==='mature') mature++; if(st==='due') due++; if(st!=='new') seen++;
    strength+=cardStrength(c.id); }
  return {total:list.length, mature, due, seen,
          pct:Math.round(strength/list.length*100)};
}
function overallMastery(){
  let strength=0; for(const c of CARDS) strength+=cardStrength(c.id);
  return Math.round(strength/CARDS.length*100);
}
function dueCount(){ let d=0; for(const c of CARDS) if(cardState(c.id)==='due') d++; return d; }
function newAvailable(){ let n=0; for(const c of CARDS) if(cardState(c.id)==='new') n++; return n; }
function stars(pct){ return pct>=90?3 : pct>=60?2 : pct>=25?1 : 0; }

/* ---------------- per-move memory ----------------
   The line scheduler above decides WHEN you see a line. This layer remembers
   each of your moves separately, because that is the unit you actually
   forget: in a 10-move line you rarely forget the line, you forget move 7.

   A move you miss becomes a TROUBLE SPOT, and it stays one until you have
   played it right first time, without hesitating, on two DIFFERENT days
   after the day you missed it. Getting it right minutes after being shown
   it proves short-term memory, not learning. Trouble spots are drilled on their
   own (focus drills), dropped straight into the position, every day until
   they clear. A move missed three times or more is "stubborn" and goes to the
   front of that queue. Slips in your real games (app/mygames.js) count as
   misses too -- the board is the test that matters. */
const SLOW_MS=10000;          // a correct move slower than this is not yet automatic
const IDLE_MS=90000;          // ...unless you clearly walked away from the screen
const STUBBORN=3;
function newMoveStat(){ return {n:0, ok:0, miss:0, streak:0, okDays:0, hist:''}; }
function recordMove(edge, clean, ms){
  if(!edge.key) return null;          // puzzles have no move key
  const t=today();
  const s=state.moves[edge.key]=state.moves[edge.key]||newMoveStat();
  const slow = clean && ms>SLOW_MS && ms<IDLE_MS;
  s.n++; s.lastSeen=t;
  if(clean){
    s.ok++; s.streak++;
    if(slow) s.slow=(s.slow||0)+1;
    // a day only counts if it is not the day you missed it: right a minute
    // after being corrected is short-term memory, not learning
    else if(s.lastOkDay!==t && s.lastMiss!==t){ s.okDays++; s.lastOkDay=t; }
  } else {
    s.miss++; s.streak=0; s.okDays=0; s.lastMiss=t; s.lastOkDay=null;
  }
  s.hist=(s.hist+(clean?(slow?'s':'1'):'0')).slice(-12);
  // one row per study day, for the accuracy trend
  let h=state.history[state.history.length-1];
  if(!h||h.d!==t){ h={d:t, moves:0, first:0, miss:0}; state.history.push(h);
    if(state.history.length>400) state.history.shift(); }
  h.moves++; if(clean) h.first++; else h.miss++;
  return s;
}
function markTaught(edge){
  const s=state.moves[edge.key]=state.moves[edge.key]||newMoveStat();
  s.taught=today(); session.known.add(edge.key);
}
// unseen | solid | shaky (right but slow last time) | trouble | fixed
function moveStatus(key){
  const s=state.moves[key];
  if(!s) return 'unseen';
  if(s.miss) return s.okDays>=2 ? 'fixed' : 'trouble';
  if(!s.n) return 'unseen';
  return s.hist.slice(-1)==='s' ? 'shaky' : 'solid';
}
// Moves you have met before, so a new line does not re-teach a shared prefix.
// Lines you reviewed before per-move tracking existed count as known.
function knownMoves(){
  const k=new Set();
  for(const key in state.moves){ const s=state.moves[key]; if(s.n||s.taught) k.add(key); }
  for(const c of CARDS){ const s=srs(c.id);
    if(s&&s.seen) for(const e of c.edges) if(e.mine) k.add(e.key); }
  return k;
}
function troubleSpots(){
  const out=[];
  for(const key in state.moves){
    const st=moveStatus(key);
    if((st!=='trouble' && st!=='shaky') || !MOVE_INDEX[key]) continue;
    const at=MOVE_INDEX[key][0], s=state.moves[key];
    out.push({key, s, card:at.card, step:at.step, edge:at.card.edges[at.step],
              status:st, stubborn:st==='trouble' && s.miss>=STUBBORN});
  }
  const rank=x=> x.stubborn?0 : x.status==='trouble'?1 : 2;
  return out.sort((a,b)=>rank(a)-rank(b) || (b.s.lastMiss||0)-(a.s.lastMiss||0) || b.s.miss-a.s.miss);
}
function fixedCount(){ let n=0; for(const k in state.moves) if(moveStatus(k)==='fixed') n++; return n; }
// Today's focus drills: trouble spots you have not already answered today --
// once you have, the next test needs a night's sleep in between to mean
// anything. (A miss in today's session is re-drilled within that session.)
function focusQueue(n){
  const t=today();
  return troubleSpots().filter(x=>x.s.lastSeen!==t).slice(0,n).map(x=>focusCard(x.key));
}
// A focus drill: the line that contains the move, started at that move, and
// running on through two more of your moves -- the continuation re-anchors the
// forgotten move inside the line it belongs to.
function focusCard(key){
  const {card,step}=MOVE_INDEX[key][0];
  let end=card.edges.length, mine=0;
  for(let i=step+1;i<card.edges.length;i++){
    if(card.edges[i].mine && ++mine===2){ end=i+1; break; }
  }
  return {...card, id:'focus:'+key, isFocus:true, focusKey:key, startStep:step, endStep:end};
}
function focusSubtitle(card){
  const s=state.moves[card.focusKey]||{};
  const bits=[];
  if(s.gameMiss) bits.push('you left the book here in a real game');
  if(s.miss) bits.push(`missed ${s.miss}×`);
  if(moveStatus(card.focusKey)==='shaky') bits.push('right, but slow');
  return 'Trouble spot' + (bits.length?' — '+bits.join(' · '):'');
}
function dayOf(unixSec){ const d=new Date(unixSec*1000); d.setHours(0,0,0,0); return Math.round(d.getTime()/864e5); }
// Real-game slips become misses, once each, if they are recent. Older ones are
// left alone: what you have done in training since is the better evidence.
const GAME_SLIP_DAYS=45;
function importGameSlips(){
  if(typeof MYGAMES==='undefined' || !MYGAMES.moves) return;
  const t=today();
  for(const key in MYGAMES.moves){
    const g=MYGAMES.moves[key];
    if(!g.lastMiss || !MOVE_INDEX[key]) continue;
    const day=dayOf(g.lastMiss.t);
    if(t-day>GAME_SLIP_DAYS) continue;
    const s=state.moves[key]=state.moves[key]||newMoveStat();
    if((s.gameMiss||0)>=day) continue;         // already counted
    s.gameMiss=day; s.miss++; s.streak=0; s.okDays=0; s.lastOkDay=null;
    s.lastMiss=Math.max(s.lastMiss||0, day);
  }
  save();
}
// First-try accuracy (%) over the `days` study days before day `before`, or null.
function accuracyBefore(before, days){
  const rows=state.history.filter(h=>h.d<before).slice(-days);
  const m=rows.reduce((a,h)=>a+h.moves,0), f=rows.reduce((a,h)=>a+h.first,0);
  return m ? Math.round(f/m*100) : null;
}

/* ---------------- backlog catch-up (load balancing) ----------------
   After a break, overdue reviews pile up. Rather than dumping them all as
   "due today", we cap the daily review load and spread the excess across the
   following days — the same load-balancing modern SRS (Anki/FSRS) uses.
   Ordering is most-fragile-first (shortest interval, then most overdue), so
   the lines you're likeliest to have forgotten come back first; well-learned
   overdue lines are pushed furthest out (a small extra delay is harmless for
   a memory that already survived the gap). No review is dropped — only when
   it appears is redistributed, and the schedule self-corrects once you catch up. */
// Openings and puzzles share one review schedule, so the daily load is
// balanced across both -- otherwise a pile-up of puzzles would quietly blow
// past the "10 minutes a day" the whole app is built around.
function allCards(){
  let out=CARDS;
  if(typeof PUZZLES!=='undefined') out=out.concat(PUZZLES);
  if(typeof LESSON_CARDS!=='undefined') out=out.concat(LESSON_CARDS);
  return out;
}

function rebalanceBacklog(){
  const t=today();
  const cap=Math.max(1, (state.settings.maxSession||14)+(state.settings.tacticsPerDay||0));
  const overdue=[];
  const load={};            // absolute day index -> count of on-time/future reviews
  for(const c of allCards()){ const s=srs(c.id); if(!s||!s.seen) continue;
    if(cardState(c.id)==='retired') continue;
    if(s.due<t) overdue.push(c.id);
    else load[s.due]=(load[s.due]||0)+1;
  }
  // If today's load is already comfortable, leave the schedule untouched.
  if(overdue.length + (load[t]||0) <= cap) return;
  overdue.sort((a,b)=>{ const sa=srs(a), sb=srs(b);
    return (sa.interval-sb.interval) || (sa.due-sb.due); });
  let day=t;
  for(const id of overdue){
    while((load[day]||0)>=cap) day++;      // find the earliest day with spare capacity
    srs(id).due=day; load[day]=(load[day]||0)+1;
  }
  save();
}

/* ---------------- level / xp ---------------- */
function levelInfo(xp){ let lvl=1, need=100, rem=xp;
  while(rem>=need){ rem-=need; lvl++; need=100+(lvl-1)*50; } return {lvl,into:rem,need}; }
function refreshTopbar(){
  const li=levelInfo(state.profile.xp);
  $('#levelVal').textContent=li.lvl;
  $('#streakVal').textContent=state.profile.streak;
  $('#xpfill').style.width=(li.into/li.need*100)+'%';
  $('#xpText').textContent=`${li.into}/${li.need} XP`;
  $('#muteBtn').textContent=state.settings.muted?'🔇':'🔊';
}

/* ===================================================================
   AUDIO  (tiny WebAudio blips, fully offline)
   =================================================================== */
let actx=null;
function tone(freq,dur,type='sine',vol=.15,when=0){
  if(state.settings.muted) return;
  try{ actx=actx||new (window.AudioContext||window.webkitAudioContext)();
    const o=actx.createOscillator(), g=actx.createGain();
    o.type=type; o.frequency.value=freq; o.connect(g); g.connect(actx.destination);
    const t=actx.currentTime+when; g.gain.setValueAtTime(vol,t);
    g.gain.exponentialRampToValueAtTime(.0001,t+dur);
    o.start(t); o.stop(t+dur);
  }catch(e){}
}
const SND={
  move:()=>tone(320,.07,'triangle',.12),
  good:()=>{tone(660,.08,'sine',.16);tone(990,.1,'sine',.14,.07);},
  bad: ()=>tone(150,.18,'sawtooth',.14),
  win: ()=>{[523,659,784,1046].forEach((f,i)=>tone(f,.15,'triangle',.16,i*.09));},
  level:()=>{[392,523,659,784,1046].forEach((f,i)=>tone(f,.18,'sine',.16,i*.08));},
};

/* ===================================================================
   ROUTING / VIEWS
   =================================================================== */
const app=$('#app');
function tpl(id){ return document.importNode($('#'+id).content,true); }
function clearView(){ app.innerHTML=''; }
function go(view, arg){
  clearView();
  if(view==='home') renderHome();
  else if(view==='course') renderCourse(arg);
  // Coach views live in coach.js, which is optional — fall back home rather
  // than throwing if someone reaches these without a build.
  else if(view==='pack')  { if(typeof renderPack==='function')  renderPack(arg); else return go('home'); }
  else if(view==='coach') { if(typeof renderCoach==='function') renderCoach();   else return go('home'); }
  else if(view==='progress'){ renderProgress(); }
  else if(view==='lesson'){ if(typeof renderLesson==='function') renderLesson(arg); else return go('home'); }
  document.body.dataset.view=view;
}
document.addEventListener('click', e=>{
  const nav=e.target.closest('[data-nav]'); if(nav){ go(nav.dataset.nav); }
});
$('#muteBtn').addEventListener('click',()=>{
  state.settings.muted=!state.settings.muted; save(); refreshTopbar();
  if(!state.settings.muted) SND.good();
});

/* ---------------- HOME ---------------- */
function renderHome(){
  app.appendChild(tpl('tpl-home'));
  const p=state.profile;
  const hr=new Date().getHours();
  $('#greeting').textContent =
    (hr<12?'Good morning':hr<18?'Good afternoon':'Good evening')+' — ready to train?';
  const mastery=overallMastery();
  $('#subgreeting').textContent =
    `Level ${levelInfo(p.xp).lvl} · ${p.streak}-day streak · ${mastery}% of your repertoire mastered`;

  // mastery ring
  const C=2*Math.PI*52;
  $('#ringFg').style.strokeDashoffset = C*(1-mastery/100);
  $('#ringPct').textContent = mastery+'%';
  $('.ring-label small').textContent='mastered';

  // due summary
  const due=dueCount(), nw=Math.min(newAvailable(), state.settings.newPerDay);
  const nextNew=CARDS.find(c=>cardState(c.id)==='new');
  const tac=(typeof buildTacticsQueue==='function')
    ? buildTacticsQueue(state.settings.tacticsPerDay||0).length : 0;
  const foc=focusQueue(state.settings.focusPerDay||0).length;
  const ds=$('#dueSummary');
  const total=due+nw+tac+foc;
  const parts=[];
  if(due+nw>0) parts.push(`<b>${due+nw}</b> opening line${due+nw===1?'':'s'}`);
  if(foc>0) parts.push(`<b>${foc}</b> trouble spot${foc===1?'':'s'}`);
  if(tac>0) parts.push(`<b>${tac}</b> tactics`);
  if(total>0) ds.innerHTML = parts.join(' · ') +
      ` — about ${estMinutes(due+nw, tac, foc)} min` +
      (nw&&nextNew? `<br><span style="font-size:.92em">next up: <b>${courseById(nextNew.courseId).name}</b></span>` : '');
  else if(newAvailable()>0) ds.innerHTML=`No reviews due. Tap to learn <b>${Math.min(newAvailable(),state.settings.newPerDay)}</b> new line(s).`;
  else ds.innerHTML='🎉 All caught up! Nothing due today — come back tomorrow, or drill anything below.';

  $('#startBtn').addEventListener('click', startDaily);
  if(typeof renderProgressCard==='function') renderProgressCard($('#progressCard'));

  /* Course cards. COURSES arrives from the build already sorted by weight --
     how much of your practice each opening has earned, computed from how
     often you actually reach it and how you score there (build/priority.py).
     So "next up" and the order on screen both follow the data rather than a
     fixed curriculum. Within that, we group by ROLE: the openings you chose
     to play, then the antidotes for what opponents do to you. */
  const host=$('#courseGrid');
  host.classList.remove('course-grid');           // becomes a plain container
  const buildCard=c=>{
    const pr=courseProgress(c.id);
    const card=document.createElement('div'); card.className='course-card';
    const why = c.why && c.why!=='no analysis yet' ? c.why : '';
    card.innerHTML=`
      <div class="cc-top">
        <span class="tag ${c.color}">${c.color==='white'?'▲ White':'▼ Black'}</span>
        ${pr.due?`<span class="due-pill">${pr.due} due</span>`:`<span class="due-pill none">${pr.seen<pr.total?'learn':'✓'}</span>`}
      </div>
      <h3>${c.name}</h3>
      <div class="cc-bar"><div style="width:${pr.pct}%"></div></div>
      <div class="cc-meta"><span class="stars">${'★'.repeat(stars(pr.pct))}${'☆'.repeat(3-stars(pr.pct))}</span>
        <span>${pr.mature}/${pr.total} mastered</span></div>
      ${why?`<div class="cc-why">${why}</div>`:''}`;
    card.addEventListener('click',()=>go('course',c.id));
    return card;
  };
  const ROLES=[
    {id:'core',     label:'Your openings',
     note:'Ordered by how much of your practice each one has earned.'},
    {id:'antidote', label:'What your opponents actually do',
     note:'Built from your own games: the lines you keep meeting that your '+
          'repertoire had no answer for.'},
  ];
  for(const r of ROLES){
    const list=COURSES.filter(c=>(c.role||'core')===r.id);
    if(!list.length) continue;
    const group=document.createElement('div'); group.className='tier-group';
    group.innerHTML=`<div class="tier-head">
      <span class="tier-chip t${r.id==='core'?1:2}">${r.label}</span>
      <small class="tier-note">${r.note}</small></div>`;
    const grid=document.createElement('div'); grid.className='course-grid';
    for(const c of list) grid.appendChild(buildCard(c));
    group.appendChild(grid); host.appendChild(group);
  }
  // lessons first (the diagnosis), then the raw packs they came from
  if(typeof renderTacticsSection==='function'){
    renderTacticsSection(app.querySelector('.home'));
  }
  if(typeof renderLessonsSection==='function'){
    renderLessonsSection(app.querySelector('.home'));
  }

  renderBadges($('#badgeRow'));

  // board theme picker
  const cur=state.settings.theme||'green';
  const themeWrap=document.createElement('div');
  themeWrap.style.cssText='margin:24px 0 4px;text-align:center';
  themeWrap.innerHTML='<div style="color:var(--muted);font-size:.8rem;margin-bottom:9px;'+
    'text-transform:uppercase;letter-spacing:.08em">Board theme</div>';
  const sw=document.createElement('div'); sw.className='theme-swatches';
  for(const t of THEMES){
    const b=document.createElement('button');
    b.className='swatch'+(cur===t.id?' active':''); b.title=t.name;
    b.innerHTML=`<span class="sw-board">`+
      `<i style="background:${t.light}"></i><i style="background:${t.dark}"></i>`+
      `<i style="background:${t.dark}"></i><i style="background:${t.light}"></i></span>${t.name}`;
    b.addEventListener('click',()=>{
      state.settings.theme=t.id; save(); applyTheme(t.id);
      $$('.swatch',sw).forEach(x=>x.classList.remove('active')); b.classList.add('active');
    });
    sw.appendChild(b);
  }
  themeWrap.appendChild(sw);
  app.querySelector('.home').appendChild(themeWrap);

  // small footer: daily new-line setting + reset
  const foot=document.createElement('div');
  foot.style.cssText='margin-top:26px;text-align:center;color:var(--muted);font-size:.8rem';
  const selCss='background:var(--card);color:var(--ink);border:1px solid var(--line);border-radius:7px;padding:3px 6px';
  const rpdOpts=[...new Set([8,10,14,18,25,state.settings.maxSession])].sort((a,b)=>a-b);
  foot.innerHTML=`New lines per day:
    <select id="npd" style="${selCss}">
      ${[2,3,4,5,8].map(n=>`<option ${state.settings.newPerDay===n?'selected':''}>${n}</option>`).join('')}
    </select>
    &nbsp;·&nbsp; Trouble spots per day:
    <select id="fpd" style="${selCss}" title="How many of the moves you keep missing are drilled on their own each day">
      ${[0,2,4,6,10].map(n=>`<option ${state.settings.focusPerDay===n?'selected':''}>${n}</option>`).join('')}
    </select>
    &nbsp;·&nbsp; Reviews per day:
    <select id="rpd" style="${selCss}" title="Caps how many reviews pile up per day — extras spread to later days">
      ${rpdOpts.map(n=>`<option ${state.settings.maxSession===n?'selected':''}>${n}</option>`).join('')}
    </select>
    ${typeof hasCoach==='function'&&hasCoach() ? `&nbsp;·&nbsp; Tactics per day:
    <select id="tpd" style="${selCss}" title="How many puzzles ride along in the daily session">
      ${[0,3,4,6,8,12].map(n=>`<option ${state.settings.tacticsPerDay===n?'selected':''}>${n}</option>`).join('')}
    </select>` : ''}
    &nbsp;·&nbsp; <a id="resetLink" href="#" style="color:var(--muted)">Reset all progress</a>
    <br><span style="opacity:.75">Progress is stored only in this browser.
    <a id="exportLink" href="#" style="color:var(--muted)">Back up to a file</a>
    &nbsp;·&nbsp; <a id="importLink" href="#" style="color:var(--muted)">Restore from a file</a></span>`;
  app.querySelector('.home').appendChild(foot);
  $('#exportLink').addEventListener('click',e=>{ e.preventDefault(); exportProgress(); });
  $('#importLink').addEventListener('click',e=>{ e.preventDefault(); importProgress(); });
  $('#npd').addEventListener('change',e=>{ state.settings.newPerDay=+e.target.value; save(); go('home'); });
  $('#fpd').addEventListener('change',e=>{ state.settings.focusPerDay=+e.target.value; save(); go('home'); });
  $('#rpd').addEventListener('change',e=>{ state.settings.maxSession=+e.target.value; save(); rebalanceBacklog(); go('home'); });
  const tpd=$('#tpd');
  if(tpd) tpd.addEventListener('change',e=>{ state.settings.tacticsPerDay=+e.target.value; save(); go('home'); });
  $('#resetLink').addEventListener('click',e=>{ e.preventDefault();
    if(confirm('Reset all progress, XP, streak and review schedule? This cannot be undone.')){
      state=DEFAULTS(); save(); applyTheme(state.settings.theme); refreshTopbar(); go('home'); toast('Progress reset.',''); }
  });
}
// A memorised opening line is quick; a puzzle you have to actually work out is
// not. Weighting them the same made the daily estimate read low once tactics
// joined the session, which matters when the whole promise is "10 minutes".
function estMinutes(lines, puzzles=0, focus=0){
  return Math.max(1, Math.round(lines*0.6 + puzzles*1.0 + focus*0.4));
}

/* ---------------- COURSE DETAIL ---------------- */
function renderCourse(courseId){
  app.appendChild(tpl('tpl-course'));
  const c=courseById(courseId);
  $('#cdName').textContent=c.name;
  $('#cdSummary').textContent=c.summary;
  $('#cdDrill').addEventListener('click',()=>startCourse(courseId,false));
  $('#cdLearn').addEventListener('click',()=>startCourse(courseId,true));
  const wrap=$('#cdLines');
  CARDS_BY_COURSE[courseId].forEach((card,i)=>{
    const st=cardState(card.id);
    const lbl={new:'New',due:'Review due',learning:'Learning',mature:'Mastered'}[st];
    const sans=card.edges.map(e=>e.san).join(' ');
    const row=document.createElement('div'); row.className='cd-line';
    row.innerHTML=`<div class="cl-top"><span class="cl-name">${i===0?'★ ':''}${shortName(card.name,c.name)}</span>
        <span class="cl-state ${st}">${lbl}</span></div>
      <div class="cl-moves">${numberedStatus(card.edges)}</div>`;
    row.addEventListener('click',()=>startLine(card,false));
    wrap.appendChild(row);
  });
}
function shortName(name,courseName){
  if(name.startsWith(courseName)) { const r=name.slice(courseName.length).replace(/^[:,\s]+/,''); return r||'Main line'; }
  return name;
}
// The same, with each of your moves coloured by how well you know it, so a
// line's weak point is visible before you drill it.
function numberedStatus(edges){
  return edges.map((e,i)=>{
    const st=e.mine ? moveStatus(e.key) : '';
    const txt=(i%2===0?`${i/2+1}.`:'')+e.san;
    return st==='trouble'||st==='shaky'||st==='fixed'
      ? `<span class="ms-${st}" title="${{trouble:'keeps slipping',shaky:'right but slow',fixed:'fixed'}[st]}">${txt}</span>`
      : txt;
  }).join(' ');
}

/* ---------------- badges ---------------- */
const BADGES=[
  {id:'first',  ico:'🎯', name:'First Steps',   test:p=>p.sessionsDone>=1},
  {id:'streak7',ico:'🔥', name:'Week Warrior',  test:p=>p.bestStreak>=7},
  {id:'streak30',ico:'⚡',name:'Unstoppable',   test:p=>p.bestStreak>=30},
  {id:'century',ico:'💯', name:'Centurion',     test:p=>p.totalMoves>=100},
  {id:'perfect',ico:'✨', name:'Flawless',      test:p=>p.perfectSessions>=1},
  {id:'scholar',ico:'🎓', name:'Opening Expert',test:()=>COURSES.some(c=>courseProgress(c.id).pct===100)},
  {id:'polyglot',ico:'🌍',name:'All-Rounder',   test:()=>COURSES.every(c=>courseProgress(c.id).mature>=1)},
  {id:'grinder',ico:'🏆', name:'Dedicated',     test:p=>p.sessionsDone>=30},
  {id:'fixer',  ico:'🛠️', name:'Fixer',         test:()=>fixedCount()>=10},
];
function checkBadges(){
  for(const b of BADGES){ if(!state.badges[b.id] && b.test(state.profile)){
    state.badges[b.id]=true; toast(`${b.ico} Badge unlocked: ${b.name}`,'gold'); confetti(); SND.win();
  }}
  save();
}
function renderBadges(host){
  host.innerHTML='';
  for(const b of BADGES){ const got=state.badges[b.id];
    const el=document.createElement('div'); el.className='badge'+(got?'':' locked');
    el.innerHTML=`<span class="b-ico">${b.ico}</span>${b.name}`;
    host.appendChild(el);
  }
}

/* ===================================================================
   TRAINER ENGINE
   =================================================================== */
let board, boardWrap, overlay, session=null, play=null, engineBusy=false, selected=null, whiteBottom=true;

function buildDailyQueue(){
  const reviews=CARDS.filter(c=>cardState(c.id)==='due')
                     .sort((a,b)=>srs(a.id).due-srs(b.id).due)
                     .slice(0,state.settings.maxSession);
  let budget=Math.max(0, state.settings.maxSession-reviews.length);
  budget=Math.min(budget, state.settings.newPerDay);
  const news=CARDS.filter(c=>cardState(c.id)==='new').slice(0,budget);

  // Reviews first (familiar ground, a warm-up), then the moves you keep
  // missing, then new material while you are still fresh. Tactics ride along
  // at the end -- they are harder, and they put useful distance between
  // learning a new line and being re-tested on it.
  const focus=focusQueue(state.settings.focusPerDay||0);
  const tactics = (typeof buildTacticsQueue==='function')
    ? buildTacticsQueue(state.settings.tacticsPerDay||0) : [];
  return reviews.concat(focus, news, tactics);
}
function startDaily(){
  const q=buildDailyQueue();
  if(!q.length){ toast('All caught up! Try drilling an opening 👇','good'); return; }
  beginSession(q,'daily',false);
}
function startCourse(courseId, learn){
  const q=CARDS_BY_COURSE[courseId].slice();
  beginSession(q, learn?'learn':'course', learn);
}
function startLine(card, learn){ beginSession([card], learn?'learn':'line', learn); }
function startFocus(keys){
  const q=keys.filter(k=>MOVE_INDEX[k]).map(focusCard);
  if(!q.length){ toast('Nothing to fix right now 🎉','good'); return; }
  beginSession(q,'focus',false);
}

// Sessions where a move you have never seen is TAUGHT before it is tested.
// A single-line drill is you asking to be tested, so it is left out. Focus
// drills are included: a slip from a real game can land on a move the trainer
// has not shown you yet.
const TEACH_MODES=new Set(['daily','course','focus']);

function beginSession(queue, mode, learn){
  session={queue, idx:0, mode, learn, results:[], xpGained:0,
           movesPlayed:0, firstTry:0, requeues:0,
           known:knownMoves(), missed:new Map(), taught:0};
  clearView(); app.appendChild(tpl('tpl-train'));
  board=$('#board'); boardWrap=$('.board-wrap'); overlay=$('#boardOverlay');
  $('#hintBtn').addEventListener('click', onHint);
  $('#revealBtn').addEventListener('click', onReveal);
  board.addEventListener('click', onBoardClick);
  document.body.dataset.view='train';
  startCard(session.queue[0]);
}

function startCard(card){
  // Opening lines always begin from the initial position; puzzles carry their
  // own start position. Everything downstream is identical.
  const first=card.startStep||0;
  const start = first ? card.edges[first-1].node.fen : (card.startFen || STARTFEN);
  play={card, color:card.color, edges:card.edges, fen:start, step:first,
        end:card.endStep||card.edges.length,
        wrong:0, hintMoves:0, wrongThisMove:0, hintThisMove:false, hintLevel:0,
        requeued:!!card._requeued, blind: !!card.blind, shownFen:start, slow:0, taught:0,
        isNewLine: !card.isPuzzle && !card.isFocus && cardState(card.id)==='new'};
  whiteBottom = card.color==='white';
  renderBoard(start, whiteBottom);
  $('#lineName').textContent = card.isPuzzle
    ? `${card.courseName} — ${card.name}`
    : `${card.isFocus?'🎯 ':''}${card.courseName} — ${shortName(card.name,card.courseName)}`;
  $('#moveList').innerHTML='';
  const ex=$('#explain'); if(ex) ex.innerHTML='';
  const sub=$('#lineSub');
  if(sub) sub.textContent = card.isPuzzle ? puzzleSubtitle(card)
    : card.isFocus ? focusSubtitle(card) : '';
  // A focus drill drops you straight into the position you keep getting
  // wrong, with the moves that led there on show: the context is part of
  // what you are remembering.
  if(first){
    for(let i=0;i<first;i++) addMoveChip(card.edges[i], true);
    const prev=card.edges[first-1];
    highlightLast(prev.from, prev.to);
    if(!prev.mine) showExplain(prev, first-1);
  }
  updateSessBar();
  $('#hintBtn').disabled=$('#revealBtn').disabled=false;
  document.body.classList.toggle('blind-mode', !!play.blind);
  selected=null;
  setTimeout(processStep, session.learn?500:350);
}
function updateSessBar(){
  $('#sessBarFill').style.width=(session.idx/session.queue.length*100)+'%';
  $('#sessCount').textContent=`${session.idx+1}/${session.queue.length}`;
}

function processStep(){
  if(!viewAlive()) return;
  if(play.step>=play.end){ return finishCard(); }
  const edge=play.edges[play.step];
  if(edge.mine){
    play.awaiting=true; selected=null; play.moveStart=Date.now();
    // Teach, then test. A move you have never been shown is not something
    // you can retrieve -- asking for it only produces a guess, and a wrong
    // guess is what you then remember. So the first time, you are shown the
    // move and why, and you play it yourself (doing beats watching).
    play.teaching = !play.card.isPuzzle && (session.learn ||
      ((play.isNewLine || play.card.isFocus) && TEACH_MODES.has(session.mode)
       && !session.known.has(edge.key)));
    $('#hintBtn').disabled=$('#revealBtn').disabled=play.teaching;
    if(play.teaching){
      highlightHint(edge.from, edge.to);
      setPrompt(`${session.learn?'Book move':'New move'}: ${edge.san} — play it on the board.`,'good');
      showExplain(edge, play.step, true);
      return;
    }
    const first = !play.edges.slice(0,play.step).some(e=>e.mine);
    if(play.card.isPuzzle){
      setPrompt(first ? puzzlePrompt(play.card)
                      : (play.blind ? 'Keep going — from the position in your head.'
                                    : 'Good. And now?'), '');
    } else {
      setPrompt(`Your move as ${play.color}. What's the book move?`, '');
    }
  } else {
    play.awaiting=false;
    setPrompt('', '');
    engineBusy=true;
    const step=play.step;
    setTimeout(()=>playEdge(edge, ()=>{
      if(!play.card.isPuzzle) showExplain(edge, step);
      play.step++; processStep();
    }), session.learn?750:430);
  }
}

function onBoardClick(e){
  if(!play || !play.awaiting || engineBusy) return;
  const sq=e.target.closest('.sq'); if(!sq) return;
  const square=sq.dataset.square;
  const map=parseFEN(play.fen);
  const myUpper = play.color==='white';
  const here=map[square];
  const isMine = here && (here===here.toUpperCase())===myUpper;

  if(selected===null){
    if(isMine){ selected=square; markSel(square); }
    return;
  }
  if(square===selected){ selected=null; clearSel(); return; }
  if(isMine){ selected=square; markSel(square); return; }   // reselect own piece
  // attempt move selected -> square
  const edge=play.edges[play.step];
  clearSel();
  const from=selected; selected=null;
  if(from===edge.from && square===edge.to){
    play.awaiting=false;
    const ms=Date.now()-(play.moveStart||Date.now());
    const step=play.step;
    goodFeedback(edge);
    engineBusy=true;
    playEdge(edge, ()=>{
      if(play.teaching){
        markTaught(edge); play.taught++; session.taught++;
        addXp(2, edge.to);
      } else {
        // tally this move
        session.movesPlayed++; state.profile.totalMoves++;
        const clean = play.wrongThisMove===0 && !play.hintThisMove;
        if(clean) session.firstTry++;
        if(!play.card.isPuzzle){
          const s=recordMove(edge, clean, ms);
          if(s && clean && s.hist.slice(-1)==='s') play.slow++;
          if(!clean) session.missed.set(edge.key, {edge, step});
        }
        addXp(play.hintThisMove?4:10, edge.to);
      }
      if(!play.card.isPuzzle) showExplain(edge, step);
      play.wrongThisMove=0; play.hintThisMove=false; play.hintLevel=0;
      play.step++; processStep();
    });
  } else if(play.teaching){
    badFeedback(from, square);
    setPrompt(`Follow the arrow: ${edge.san}.`, 'bad');
    highlightHint(edge.from, edge.to);
  } else {
    play.wrong++; play.wrongThisMove++;
    badFeedback(from, square);
    if(play.card.isPuzzle){
      setPrompt(play.blind ? 'Not it — recheck your line from the position in your head.'
                           : 'Not the strongest move here — look again.', 'bad');
    } else {
      // The first miss gets the IDEA, not the answer: retrieving the move
      // from its reason is what makes it stick. If this is also the move you
      // keep playing in real games, say so -- that is the habit to break.
      const habit=realGameHabit(edge, from, square);
      const cue = play.wrongThisMove===1 && edge.cue ? ` 💭 ${edge.cue}` : '';
      setPrompt('Not the book move here.' + cue +
        (habit ? ` (You played that in ${habit} of your real games here.)` : ''), 'bad');
    }
    if(play.wrongThisMove>=2) highlightHint(edge.from, null);   // nudge after 2 misses
  }
}

// Hints climb a ladder: first the idea (a cue that does not name the move),
// then the piece, and only "I forgot" gives the whole answer. Each rung asks
// you to do a bit more of the remembering yourself.
function onHint(){
  if(!play||!play.awaiting||play.teaching) return;
  const edge=play.edges[play.step];
  play.hintThisMove=true;
  if(play.hintLevel===0 && edge.cue && !play.card.isPuzzle){
    play.hintLevel=1;
    setPrompt(`💭 ${edge.cue}`, '');
    return;
  }
  play.hintLevel=2;
  highlightHint(edge.from, null);
  setPrompt('Hint: move the highlighted piece.', '');
}
function onReveal(){
  if(!play||!play.awaiting||engineBusy||play.teaching) return;
  const edge=play.edges[play.step], step=play.step;
  play.hintThisMove=true; play.hintMoves++;
  highlightHint(edge.from, edge.to);
  setPrompt(`The book move is ${edge.san}.`, '');
  play.awaiting=false; selected=null; clearSel();
  engineBusy=true;
  setTimeout(()=>playEdge(edge, ()=>{
    session.movesPlayed++; state.profile.totalMoves++;
    if(!play.card.isPuzzle){
      recordMove(edge, false, 0);
      session.missed.set(edge.key, {edge, step});
      showExplain(edge, step);
    }
    play.wrongThisMove=0; play.hintThisMove=false; play.hintLevel=0;
    play.step++; processStep();
  }), 900);
}

function finishCard(){
  // In calculation mode the board has been frozen the whole time -- play the
  // solution back so you can see what you were visualising before moving on.
  if(play.blind && !play.replayed){
    play.replayed=true;
    setPrompt('Here is the line you calculated.','good');
    return replayLine(()=>finishCard());
  }
  const mistakes = play.wrong + play.hintMoves;
  // A line that taught you a new move has not tested you yet. It is not
  // graded: it comes back at the end of the session, after other material,
  // as a real test -- learn, then retrieve after a gap.
  const taughtOnly = !session.learn && play.taught>0;
  const grade = (session.learn || taughtOnly) ? null : gradeFromMistakes(mistakes, play.slow);
  if(session.learn){
    // Learn mode doesn't grade, but completing a lesson should register the
    // line as introduced (so it shows progress and gets scheduled for review).
    const s=srs(play.card.id);
    if(!s||!s.seen) schedule(play.card.id, 'good');
  }
  if(taughtOnly && !play.requeued){
    session.queue.push({...play.card, _requeued:true});
    toast('New moves learned — you will be tested on this line again before you finish.','');
    creditStudyDay(); refreshTopbar();
  }
  if(grade){
    // A focus drill tests one move, not the line: its result lives in the
    // per-move memory (already recorded), so the line's schedule is untouched.
    if(!play.card.isFocus) schedule(play.card.id, grade);
    session.results.push({id:play.card.id, grade, mistakes, focus:!!play.card.isFocus});
    // Puzzles rate you as much as you rate them: a clean solve nudges your
    // puzzle rating up, so the app keeps serving material at the right level
    // without waiting for the next rebuild.
    if(play.card.isPuzzle && typeof updatePuzzleRating==='function'){
      const clean = mistakes===0;
      updatePuzzleRating(play.card, clean);
      if(clean) state.profile.puzzlesSolved=(state.profile.puzzlesSolved||0)+1;
      // A lesson card also scores the LESSON, which is what decides whether
      // you move up a rung and when the pattern comes back.
      if(play.card.isLesson && typeof creditLesson==='function'){
        creditLesson(play.card, clean);
      }
      const url=play.card.meta && play.card.meta.gameUrl;
      if(url && play.card.meta.kind!=='theme'){
        const ml=$('#moveList');
        if(ml){ const a=document.createElement('a');
          a.href=url; a.target='_blank'; a.rel='noopener';
          a.className='game-link'; a.textContent='view the game ↗';
          ml.appendChild(a); }
      }
    }
    if(grade==='easy'){ addXp(25); toast(play.card.isFocus?'Fixed it! +25 XP':'Perfect line! +25 XP','good'); miniConfetti(); }
    else if(grade==='good'){ addXp(10); }
    // re-queue misses once for immediate relearn (not for a single-line drill)
    if(mistakes>0 && (grade==='again' || play.card.isFocus) && session.mode!=='line'
       && session.requeues<6 && !play.requeued){
      session.queue.push({...play.card, _requeued:true}); session.requeues++;
    }
    // Every reviewed line counts on its own — credit the day and check badges
    // now, so quitting mid-session never loses your streak or an earned badge.
    creditStudyDay(); refreshTopbar(); checkBadges();
  }
  save();
  session.idx++;
  if(session.idx>=session.queue.length) return finishSession();
  // Give yourself a moment to read why the last move was played.
  setTimeout(()=>startCard(session.queue[session.idx]), play.card.isPuzzle?500:1100);
  updateSessBar();
}

// Advance the daily streak the moment you review your first line today — you
// don't need to finish the whole session for the day to count. Idempotent: it
// runs per reviewed line but only credits the day once.
function creditStudyDay(){
  const t=today(), p=state.profile;
  if(p.lastDay===t) return;
  p.streak = (p.lastDay===t-1)? p.streak+1 : 1;
  p.lastDay=t; p.bestStreak=Math.max(p.bestStreak||0, p.streak);
}
function finishSession(){
  $('#sessBarFill').style.width='100%';
  const p=state.profile;
  const completed = session.results.length;
  if(!session.learn && completed>0){
    p.sessionsDone++;
    creditStudyDay();
    const allPerfect = session.results.every(r=>r.grade==='easy');
    if(allPerfect) p.perfectSessions++;
  }
  state.lastSummary={
    when:today(), lines:completed,
    acc: session.movesPlayed? Math.round(session.firstTry/session.movesPlayed*100):100,
    xp: session.xpGained, streak:p.streak,
  };
  save(); refreshTopbar(); checkBadges();
  showSummary();
}

function showSummary(){
  app.appendChild(tpl('tpl-summary'));
  const s=state.lastSummary;
  if(session.learn){ $('#sumTitle').textContent='Lesson complete 📖'; }
  $('#sumLines').textContent=s.lines;
  $('#sumAcc').textContent=s.acc+'%';
  $('#sumXp').textContent='+'+s.xp;
  $('#sumStreak').textContent=s.streak;
  const due=dueCount();
  $('#sumNext').textContent = due? `${due} more line(s) still due — keep going!`
      : `Next reviews unlock as your lines come due. See you tomorrow! 🔥`;
  // How today compares with your own recent average -- the number that tells
  // you whether the mistakes are actually going down.
  const trend=$('#sumTrend'), base=accuracyBefore(today(), 7);
  if(trend && session.movesPlayed && base!==null){
    const d=s.acc-base;
    trend.innerHTML = `First-try accuracy <b>${s.acc}%</b> vs <b>${base}%</b> over your previous study days `+
      `<span class="${d>=0?'up':'down'}">${d>=0?'▲':'▼'} ${Math.abs(d)}</span>`;
  }
  // Immediate feedback on exactly what went wrong, with the reason, while it
  // is fresh -- and a one-tap way to practise just those moves again.
  const host=$('#sumMissed');
  if(host && session.missed.size){
    const rows=[...session.missed.values()].map(({edge,step})=>
      `<li><b>${moveLabel(edge,step)}</b> ${edge.note?esc(edge.note):esc((edge.facts||[]).join(' · '))}</li>`).join('');
    host.innerHTML=`<h3>Moves to remember</h3><ul class="missed-list">${rows}</ul>
      <button class="ghost-btn" id="sumFocus">🎯 Drill these ${session.missed.size} again now</button>`;
    const keys=[...session.missed.keys()];
    $('#sumFocus').addEventListener('click',()=>startFocus(keys));
  }
  if(s.acc>=90 && s.lines>0){ confetti(); SND.win(); }
}

/* ---------------- explanations ----------------
   Every move arrives with its reason (note), what it does on the board
   (facts) and what it threatens (threat) -- see build/explain.py. Your move
   and the reply it got stay on screen together, so you read the exchange,
   not just a move. */
function esc(t){ return String(t).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function moveLabel(edge, step){ return `${Math.floor(step/2)+1}${step%2?'…':'.'}${edge.san}`; }
function explainHTML(edge, step, teaching){
  const who = teaching ? 'New move' : edge.mine ? 'Your move' : 'Their move';
  const facts=(edge.facts||[]).join(' · ');
  // the threat is a move by the same side again, so number it like one
  const threat = edge.threat ? `<div class="ex-threat">${edge.mine?'Threatens':'⚠ Watch out — they threaten'} `+
    `${step%2?'…':''}${esc(edge.threat)}</div>` : '';
  return `<div class="ex-row ${edge.mine?'mine':'opp'}">
    <div class="ex-head">${who} <b>${esc(moveLabel(edge,step))}</b></div>
    ${edge.note?`<div class="ex-note">${esc(edge.note)}</div>`:''}
    ${facts?`<div class="ex-facts">${esc(facts)}</div>`:''}${threat}</div>`;
}
function showExplain(edge, step, teaching){
  const host=$('#explain'); if(!host) return;
  const row=explainHTML(edge, step, teaching);
  const last=host.lastElementChild;
  // your move starts a fresh pair; their reply joins it
  if(edge.mine || !last || !last.classList.contains('mine')) host.innerHTML=row;
  else host.insertAdjacentHTML('beforeend', row);
}
// Is the wrong move you just tried the one you keep playing in real games?
// Returns how many games, or 0. Matched on piece + destination square, which
// is all a click tells us -- enough to recognise a habit.
function realGameHabit(edge, from, to){
  if(typeof MYGAMES==='undefined' || !MYGAMES.moves) return 0;
  const g=MYGAMES.moves[edge.key]; if(!g) return 0;
  const p=parseFEN(play.fen)[from]; if(!p) return 0;
  const letter=p.toUpperCase()==='P' ? '' : p.toUpperCase();
  let n=0;
  for(const san in g.played){
    if(g.book.includes(san)) continue;
    let pl, dest;
    if(san.startsWith('O-O')){ pl='K'; dest=(san.startsWith('O-O-O')?'c':'g')+(play.color==='white'?'1':'8'); }
    else { const m=san.match(/([a-h][1-8])(=[QRBN])?[+#]?$/); if(!m) continue;
      dest=m[1]; pl=/^[KQRBN]/.test(san)?san[0]:''; }
    if(pl===letter && dest===to) n+=g.played[san];
  }
  return n;
}

/* ---------------- feedback helpers ---------------- */
function setPrompt(text, cls){
  const el=$('#turnPrompt'); el.textContent=text; el.className='turn-prompt '+(cls||'');
}
function goodFeedback(edge){ flashSquare(edge.to,'good-flash'); flashOverlay('✓','good'); SND.good(); setPrompt('Correct!','good'); }
function badFeedback(from,to){ flashSquare(to||from,'bad-flash'); flashOverlay('✗','bad'); SND.bad(); }
function flashOverlay(txt,cls){ overlay.textContent=txt; overlay.className='board-overlay show '+cls;
  setTimeout(()=>overlay.className='board-overlay', 550); }

/* ===================================================================
   BOARD RENDERING + ANIMATION
   =================================================================== */
function parseFEN(fen){
  const rows=fen.split(' ')[0].split('/'); const map={};
  for(let r=0;r<8;r++){ let f=0;
    for(const ch of rows[r]){
      if(/\d/.test(ch)) f+=+ch;
      else { map['abcdefgh'[f]+(8-r)]=ch; f++; }
    }
  } return map;
}
function pieceHTML(ch){
  const color = (ch===ch.toUpperCase())?'white':'black';
  return `<span class="piece ${color}">${GLYPHS[ch.toLowerCase()]}</span>`;
}
function renderBoard(fen, whiteBot){
  const map=parseFEN(fen);
  const files = whiteBot? ['a','b','c','d','e','f','g','h'] : ['h','g','f','e','d','c','b','a'];
  const ranks = whiteBot? [8,7,6,5,4,3,2,1] : [1,2,3,4,5,6,7,8];
  let html='';
  ranks.forEach((rank,ri)=>{
    files.forEach((file,fi)=>{
      const fileIdx='abcdefgh'.indexOf(file);
      const dark=(fileIdx+(rank-1))%2===0;
      const sqn=file+rank;
      const pc=map[sqn]?pieceHTML(map[sqn]):'';
      const fileLbl = (ri===7)?`<span class="coord file">${file}</span>`:'';
      const rankLbl = (fi===0)?`<span class="coord rank">${rank}</span>`:'';
      html+=`<div class="sq ${dark?'dk':'lt'}" data-square="${sqn}">${rankLbl}${fileLbl}${pc}</div>`;
    });
  });
  board.innerHTML=html;
}
function sqEl(square){ return board.querySelector(`[data-square="${square}"]`); }
function markSel(square){ clearSel(); sqEl(square)?.classList.add('sel'); }
function clearSel(){ $$('.sq.sel',board).forEach(s=>s.classList.remove('sel')); }
function clearHints(){ $$('.hintfrom,.hintto',board).forEach(s=>s.classList.remove('hintfrom','hintto')); }
function highlightHint(from,to){ clearHints(); sqEl(from)?.classList.add('hintfrom'); if(to) sqEl(to)?.classList.add('hintto'); }
function flashSquare(square,cls){ const el=sqEl(square); if(!el)return; el.classList.add(cls); setTimeout(()=>el.classList.remove(cls),520); }
function highlightLast(from,to){ $$('.lastfrom,.lastto',board).forEach(s=>s.classList.remove('lastfrom','lastto'));
  sqEl(from)?.classList.add('lastfrom'); sqEl(to)?.classList.add('lastto'); }

function sqCenter(square){
  const el=sqEl(square), br=boardWrap.getBoundingClientRect(), r=el.getBoundingClientRect();
  return {x:r.left-br.left+r.width/2, y:r.top-br.top+r.height/2};
}
function flyPiece(from,to,ch,dur,cb){
  const a=sqCenter(from), b=sqCenter(to);
  const color=(ch===ch.toUpperCase())?'white':'black';
  const fly=document.createElement('div');
  fly.className='flyer piece '+color; fly.textContent=GLYPHS[ch.toLowerCase()];
  fly.style.left=a.x+'px'; fly.style.top=a.y+'px'; fly.style.transform='translate(-50%,-50%)';
  boardWrap.appendChild(fly);
  requestAnimationFrame(()=>{ fly.style.transform=`translate(calc(-50% + ${b.x-a.x}px), calc(-50% + ${b.y-a.y}px))`; });
  setTimeout(()=>{ fly.remove(); cb&&cb(); }, dur+30);
}
// Move animations run on timers. If you press Back (or the session ends) while
// one is in flight, the view it was drawing into is already gone -- so every
// deferred step checks the board is still on screen before touching the DOM.
function viewAlive(){ return !!board && document.body.contains(board); }

function playEdge(edge, cb){
  if(!viewAlive()) return;
  // Calculation mode: advance the real position but leave the board alone, so
  // every move after the first has to be found in your head. Click handling
  // still validates against play.fen -- the true position -- which is exactly
  // the skill being trained: if you mis-visualised, your click misses.
  if(play.blind){
    play.fen=edge.node.fen;
    addMoveChip(edge);
    engineBusy=false;
    cb&&cb();
    return;
  }
  const map=parseFEN(play.fen);
  const ch=map[edge.from];
  // hide moving source piece during the flight
  const srcPiece=sqEl(edge.from)?.querySelector('.piece'); if(srcPiece) srcPiece.remove();
  clearHints();
  // animate rook too on castling
  if(edge.castle){ const rch=map[edge.castle.from];
    const rkPiece=sqEl(edge.castle.from)?.querySelector('.piece'); if(rkPiece) rkPiece.remove();
    if(rch) flyPiece(edge.castle.from, edge.castle.to, rch, 220, null);
  }
  const finish=()=>{
    if(!viewAlive()) return;
    play.fen=edge.node.fen;
    renderBoard(play.fen, whiteBottom);
    highlightLast(edge.from, edge.to);
    addMoveChip(edge);
    if(!edge.mine) SND.move();
    engineBusy=false; cb&&cb();
  };
  if(ch) flyPiece(edge.from, edge.to, ch, 220, finish); else finish();
}
// Animate a whole solved line from its start position. Used to show a
// calculation puzzle's answer once the board comes back.
function replayLine(cb){
  const start = play.card.startFen || STARTFEN;
  play.blind=false;
  play.fen=start;
  renderBoard(start, whiteBottom);
  let i=0;
  (function next(){
    if(!viewAlive()) return;
    if(i>=play.edges.length){ setTimeout(cb,600); return; }
    const edge=play.edges[i++];
    playEdge(edge, ()=>setTimeout(next,120));
  })();
}

function addMoveChip(edge, context){
  const ml=$('#moveList');
  if(!ml) return;                       // view was left mid-animation
  const chip=document.createElement('span');
  chip.className='mv'+(edge.mine?' me':'')+(context?' ctx':'');
  chip.textContent=edge.san;
  ml.appendChild(chip);
}

/* ===================================================================
   XP popups, toasts, confetti
   =================================================================== */
function addXp(n, atSquare){
  state.profile.xp+=n; session.xpGained+=n;
  const before=levelInfo(state.profile.xp - n).lvl;
  const after=levelInfo(state.profile.xp).lvl;
  refreshTopbar();
  if(atSquare && board){ const c=sqCenter(atSquare);
    const pop=document.createElement('div'); pop.className='xp-pop';
    pop.textContent='+'+n; pop.style.left=c.x+'px'; pop.style.top=c.y+'px';
    pop.style.transform='translate(-50%,-50%)'; boardWrap.appendChild(pop);
    setTimeout(()=>pop.remove(),1000);
  }
  if(after>before){ toast(`⬆️ Level ${after}!`,'gold'); SND.level(); confetti(); }
}
let toastTimer;
function toast(msg, cls){
  const host=$('#toastHost');
  const t=document.createElement('div'); t.className='toast '+(cls||''); t.textContent=msg;
  host.appendChild(t);
  setTimeout(()=>{ t.style.opacity='0'; t.style.transition='opacity .4s'; setTimeout(()=>t.remove(),400); }, 2200);
}

/* confetti */
const cvs=$('#confetti'); const cx=cvs && cvs.getContext && cvs.getContext('2d');
function confetti(){ burst(140); } function miniConfetti(){ burst(60); }
function burst(n){
  if(!cx) return;                       // no 2d canvas (e.g. headless) -> skip gracefully
  cvs.style.display='block'; resizeCvs();
  const cs=getComputedStyle(document.body);
  const colors=['--accent','--accent2','--good','--gold','--bad']
    .map(v=>cs.getPropertyValue(v).trim()||'#888');
  const parts=[];
  for(let i=0;i<n;i++) parts.push({x:cvs.width/2+(Math.random()-.5)*200, y:cvs.height*0.25,
    vx:(Math.random()-.5)*9, vy:Math.random()*-8-2, g:0.28,
    s:6+Math.random()*7, c:colors[i%colors.length], r:Math.random()*6, vr:(Math.random()-.5)*.4});
  let frames=0;
  (function anim(){ cx.clearRect(0,0,cvs.width,cvs.height); frames++;
    parts.forEach(p=>{ p.vy+=p.g; p.x+=p.vx; p.y+=p.vy; p.r+=p.vr;
      cx.save(); cx.translate(p.x,p.y); cx.rotate(p.r); cx.fillStyle=p.c;
      cx.fillRect(-p.s/2,-p.s/2,p.s,p.s*0.6); cx.restore(); });
    if(frames<110) requestAnimationFrame(anim);
    else { cx.clearRect(0,0,cvs.width,cvs.height); cvs.style.display='none'; }
  })();
}
function resizeCvs(){ cvs.width=innerWidth; cvs.height=innerHeight; }
addEventListener('resize',()=>{ if(cvs.style.display==='block') resizeCvs(); });

/* ===================================================================
   INIT
   =================================================================== */
function rolloverStreakCheck(){
  // if user missed a day, streak is recomputed on next completed session.
  // here we just display the stored streak (don't reset until a session).
}
applyTheme(state.settings.theme);
refreshTopbar();
rolloverStreakCheck();
importGameSlips();
rebalanceBacklog();
go('home');
