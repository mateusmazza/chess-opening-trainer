/* Per-move learning layer, driven through the real UI in jsdom:
     - every move shows its explanation; a miss gets the idea (cue) first
     - a missed move becomes a trouble spot, and only clears after clean,
       unhesitating answers on two DIFFERENT days
     - a focus drill starts at the trouble spot, with the moves before it shown
     - a never-seen move in a new line is taught before it is tested, and the
       line comes back in the same session as the real test
     - real-game slips (mygames.js) become trouble spots
     - old saved progress loads unchanged
   Run: node build/test_moves.js                                             */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const APP = path.join(__dirname, '..', 'app');
let failed = 0, passed = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); c ? passed++ : failed++; };
const delay = ms => new Promise(r => setTimeout(r, ms));

function boot() {
  // without the personal files, so the run is the same on every machine
  let html = fs.readFileSync(path.join(APP, 'index.html'), 'utf8')
    .replace(/<script src="(exercises|mygames)\.js"><\/script>/g, '');
  const url = 'file://' + path.join(APP, 'index.html').replace(/\\/g, '/');
  return new JSDOM(html, { url, runScripts: 'dangerously', resources: 'usable',
                           pretendToBeVisual: true }).window;
}

(async () => {
  const w = boot();
  await new Promise(res => w.addEventListener('load', res));
  await delay(100);
  const ev = s => w.eval(s);
  const click = sq => w.document.querySelector(`[data-square="${sq}"]`)
    .dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  const peek = () => JSON.parse(ev(`JSON.stringify({
    awaiting: !!(play&&play.awaiting), teaching: !!(play&&play.teaching),
    step: play?play.step:-1, end: play?play.end:-1, wrong: play?play.wrong:0,
    edge: (play&&play.edges[play.step])?{from:play.edges[play.step].from,
      to:play.edges[play.step].to, mine:play.edges[play.step].mine,
      key:play.edges[play.step].key}:null,
    card: play?play.card.id:null,
    summary: !!document.getElementById('summaryModal')})`));
  // wait until the trainer is asking for one of your moves (or the session ended)
  async function waitTurn() {
    for (let i = 0; i < 200; i++) {
      const s = peek();
      if (s.summary || (s.awaiting && s.edge && s.edge.mine)) return s;
      // a "Got it" pause after a missed move: read it, move on
      const g = w.document.getElementById('gotIt');
      if (g) g.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
      await delay(40);
    }
    return peek();
  }
  async function playRight() { const s = await waitTurn(); click(s.edge.from); click(s.edge.to); await delay(60); return s; }
  async function playWrong() {
    const s = await waitTurn();
    const to = ev(`(function(){var m=parseFEN(play.fen);for(var f of ['a3','h3','a6','h6','b3','g3','b6','g6']){` +
      `if(!m[f]&&f!==play.edges[play.step].to)return f;}return 'a3';})()`);
    click(s.edge.from); click(to); await delay(40); return s;
  }
  async function finish() { while (!(await waitTurn()).summary) await playRight(); }
  const closeSummary = async () => {
    const b = w.document.querySelector('#summaryModal [data-nav="home"]');
    if (b) b.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); await delay(50);
  };

  console.log('\n— explanations —');
  ok(ev(`CARDS.every(c=>c.edges.every(e=>e.note))`), 'every move in the repertoire has a note');
  ok(ev(`CARDS.every(c=>c.edges.every(e=>!e.mine||e.cue))`), 'every one of your moves has a cue');
  ok(ev(`CARDS.every(c=>c.edges.every(e=>!e.mine||!e.cue.includes(e.san.replace(/[+#]/g,''))))`),
     'no cue gives its move away');

  console.log('\n— a miss becomes a trouble spot —');
  ev(`startLine(CARD_BY_ID['italian#0'], false)`);
  const first = await playWrong();
  ok(/💭/.test(w.document.getElementById('turnPrompt').textContent), 'first miss shows the idea (cue), not the move');
  ok(peek().wrong === 1 && peek().step === first.step, 'wrong move rejected');
  await playRight();
  await delay(200);
  ok(!!w.document.querySelector('#explain .ex-note'), 'the move\'s explanation is shown after playing it');
  ok(!!w.document.getElementById('gotIt') && !peek().awaiting, '...and the line waits until you say "Got it"');
  await finish();
  const key = first.edge.key;
  ok(ev(`moveStatus(${JSON.stringify(key)})`) === 'trouble', 'the missed move is now a trouble spot');
  ok(ev(`troubleSpots().some(x=>x.key===${JSON.stringify(key)})`), 'it is listed among trouble spots');
  ok(ev(`state.history.length===1 && state.history[0].miss===1`), 'today\'s accuracy recorded (1 miss)');
  ok(!!w.document.querySelector('#sumMissed .missed-list li'), 'summary lists the missed move with its reason');
  await closeSummary();
  ok(!!w.document.querySelector('.progress-card #pgFocus'), 'home offers to fix trouble spots');

  console.log('\n— focus drill and the two-day rule —');
  ev(`startFocus([${JSON.stringify(key)}])`);
  await delay(150);
  let s = await waitTurn();
  ok(s.edge && s.edge.key === key, 'focus drill starts at the trouble spot');
  ok(w.document.querySelectorAll('#moveList .mv.ctx').length === s.step, 'moves leading to it are shown as context');
  ok(s.end <= ev(`CARD_BY_ID['italian#0'].edges.length`), 'drill ends a couple of moves later');
  await finish(); await closeSummary();
  ok(ev(`moveStatus(${JSON.stringify(key)})`) === 'trouble', 'right the same day it was missed: still a trouble spot');
  ok(ev(`state.moves[${JSON.stringify(key)}].okDays`) === 0, '...and that day does not count toward fixing it');
  ok(ev(`focusQueue(9).every(c=>c.focusKey!==${JSON.stringify(key)})`), 'not re-drilled again the same day');
  const t0 = ev('today()');
  for (const d of [1, 2]) {
    ev(`today=()=>${t0 + d}`);
    ok(ev(`focusQueue(9).some(c=>c.focusKey===${JSON.stringify(key)})`), `back in the daily focus drills on day +${d}`);
    ev(`startFocus([${JSON.stringify(key)}])`);
    await delay(150); await finish(); await closeSummary();
    ok(ev(`moveStatus(${JSON.stringify(key)})`) === (d === 1 ? 'trouble' : 'fixed'),
       d === 1 ? 'right on one later day: not yet fixed' : 'right on a second later day: fixed');
  }
  ok(ev(`fixedCount()`) >= 1, 'fixed count goes up');

  console.log('\n— teach, then test —');
  ev(`state.cards={}; state.moves={}`);
  ev(`beginSession([CARD_BY_ID['scotch#0']],'daily',false)`);
  s = await waitTurn();
  ok(s.teaching, 'a never-seen move is taught first');
  await playWrong();
  ok(peek().wrong === 0, 'a slip while being taught is not counted');
  await finish();
  ok(ev(`session.queue.length`) === 2, 'the line came back in the same session as a test');
  ok(ev(`cardState('scotch#0')`) !== 'new', 'and the test pass scheduled it');
  ok(ev(`Object.values(state.moves).some(m=>m.n>0)`), 'test-pass moves were recorded');
  await closeSummary();

  console.log('\n— real games and saved progress —');
  ev(`state.moves={}; window.MYGAMES={moves:{${JSON.stringify(key)}:{book:['x'],played:{x:1,y:2},
      reached:3, lastMiss:{san:'y', url:'https://example.com/g', t:Math.floor(Date.now()/1000)}}}, monthly:[{month:'2026-10',games:4,clean:3}]}`);
  ev('importGameSlips()');
  ok(ev(`moveStatus(${JSON.stringify(key)})`) === 'trouble', 'a recent real-game slip becomes a trouble spot');
  ev('importGameSlips()');
  ok(ev(`state.moves[${JSON.stringify(key)}].miss`) === 1, 'and is counted only once');
  const old = ev(`JSON.stringify(normalize({v:1, profile:{xp:1234, streak:9}, cards:{'italian#0':{seen:true,interval:7,due:1}},
      settings:{newPerDay:3}}))`);
  const n = JSON.parse(old);
  ok(n.profile.xp === 1234 && n.profile.streak === 9 && n.cards['italian#0'].interval === 7 &&
     n.settings.newPerDay === 3, 'an old save keeps its XP, streak, cards and settings');
  ok(n.moves && Array.isArray(n.history) && n.settings.focusPerDay === 4, '...and gains the new fields');
  ev(`go('progress')`);
  ok(!!w.document.querySelector('.view.progress .pc-chart'), 'progress view renders its charts');
  ok(!!w.document.querySelector('.view.progress .spot'), 'progress view lists trouble spots');
  ev(`go('course','italian')`);
  ok(!!w.document.querySelector('.cl-moves .ms-trouble'), 'course view marks the move that keeps slipping');

  console.log(`\n${failed ? 'FAILED' : 'ALL MOVE CHECKS PASSED ✓'}  (${passed} passed, ${failed} failed)\n`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
