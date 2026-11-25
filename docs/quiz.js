import {normalizeId, request} from './api.js';
import {connectProgress, emptyProgress} from './student-sync.js';

let QS = [], SEC = [], QMAP = new Map(), BY_SEC = [];
let DB = emptyProgress();
let previous = structuredClone(DB);
let attempts = [];
let sync;

function changedMembers(before, after) {
  const old = new Set(before);
  const current = new Set(after);
  const changes = {};
  for (const id of old) if (!current.has(id)) changes[id] = false;
  for (const id of current) if (!old.has(id)) changes[id] = true;
  return changes;
}

function saveDB() {
  if (!sync) return;
  const patch = {};
  for (const list of ['fav', 'wrong']) {
    const changes = changedMembers(previous[list], DB[list]);
    if (Object.keys(changes).length) patch[list] = changes;
  }
  for (const key of ['autonext','theme','exam']) {
    if (JSON.stringify(previous[key]) !== JSON.stringify(DB[key])) patch[key] = structuredClone(DB[key]);
  }
  const positions = {};
  for (const [key, value] of Object.entries(DB.pos)) {
    if (JSON.stringify(previous.pos[key]) !== JSON.stringify(value)) positions[key] = structuredClone(value);
  }
  if (Object.keys(positions).length) patch.pos = positions;
  sync.enqueue(attempts, patch);
  attempts = [];
  previous = structuredClone(DB);
}

/* ---------------- helpers ---------------- */
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function chem(t){
  return String(t)
    .replace(/HCO3-/g,'HCO₃⁻')
    .replace(/Ca2\+/g,'Ca²⁺').replace(/Mg2\+/g,'Mg²⁺')
    .replace(/Na\+/g,'Na⁺').replace(/K\+/g,'K⁺').replace(/H\+/g,'H⁺')
    .replace(/Cl-/g,'Cl⁻');
}
const todayStr = () => { const d = new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); };
const LETTERS = ['A','B','C','D','E','F'];
function shuffle(a){ a = a.slice(); for(let i=a.length-1;i>0;i--){ const j = (Math.random()*(i+1))|0; [a[i],a[j]]=[a[j],a[i]]; } return a; }
function sameSet(a,b){ if(a.length!==b.length) return false; const s=new Set(b); return a.every(x=>s.has(x)); }
function pct(a,b){ return b>0 ? Math.round(a*100/b) : 0; }
function fmtTime(s){ const m=Math.floor(s/60), ss=s%60; return m+':'+String(ss).padStart(2,'0'); }

const ICON = {
  home:'<svg viewBox="0 0 24 24"><path d="M3 10.5 12 3l9 7.5"/><path d="M5.5 9.5V20h13V9.5"/></svg>',
  wrong:'<svg viewBox="0 0 24 24"><path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z"/><path d="m9.5 8.5 5 5m0-5-5 5"/></svg>',
  star:'<svg viewBox="0 0 24 24"><path d="m12 3.6 2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 17l-5.2 2.8 1-5.9L3.5 9.8l5.9-.8z"/></svg>',
  chart:'<svg viewBox="0 0 24 24"><path d="M4 20V10m6 10V4m6 16v-7m4 7H2"/></svg>',
  search:'<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>',
  moon:'<svg viewBox="0 0 24 24"><path d="M20 13.5A8 8 0 0 1 10.5 4 8 8 0 1 0 20 13.5z"/></svg>',
  sun:'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/></svg>',
  left:'<svg viewBox="0 0 24 24"><path d="m14 6-6 6 6 6"/></svg>',
  right:'<svg viewBox="0 0 24 24"><path d="m10 6 6 6-6 6"/></svg>',
  grid:'<svg viewBox="0 0 24 24"><rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/></svg>',
  check:'<svg viewBox="0 0 24 24"><path d="m4 12.5 5 5L20 6"/></svg>',
  cross:'<svg viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"/></svg>',
  close:'<svg viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"/></svg>',
  shuffle:'<svg viewBox="0 0 24 24"><path d="M16 3h5v5"/><path d="M4 20 21 3"/><path d="M21 16v5h-5"/><path d="m15 15 6 6M4 4l5 5"/></svg>'
};

/* ---------------- computed ---------------- */
function sectionStat(i){
  const list = BY_SEC[i]; let done=0, ok=0, tries=0;
  for(const q of list){ const r = DB.rec[q.id]; if(r){ tries += r.a||0; } }
  for(const q of list){ const r = DB.rec[q.id]; if(r && r.a>0){ done++; if((r.c||0)>0) ok++; } }
  return {done, ok, acc: pct(ok, done), n: list.length};
}
function overall(){
  let done=0, ok=0;
  for(const q of QS){ const r = DB.rec[q.id]; if(r && r.a>0){ done++; if((r.c||0)>0) ok++; } }
  return {done, ok, n: QS.length, acc: pct(ok, done)};
}
function todayCount(){ const h = DB.hist[todayStr()]; return h ? h.n : 0; }
function streak(){
  let s = 0; const d = new Date();
  for(let k=0;k<400;k++){
    const ds = d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
    const h = DB.hist[ds];
    if(h && h.n>0){ s++; d.setDate(d.getDate()-1); }
    else { if(k===0){ d.setDate(d.getDate()-1); continue; } break; }
  }
  return s;
}

/* ---------------- state ---------------- */
let VIEW = 'home';
let SESS = null;
let SHOW_SHEET = false;

/* ---------------- nav ---------------- */
const NAV = [
  {k:'home', label:'练习首页', icon:'home'},
  {k:'wrong', label:'错题本', icon:'wrong', badge:()=>DB.wrong.length},
  {k:'fav', label:'收藏', icon:'star', badge:()=>DB.fav.length},
  {k:'stats', label:'数据统计', icon:'chart'},
  {k:'search', label:'搜题', icon:'search'}
];
function navHTML(mobile){
  return NAV.map(n=>{
    const cnt = n.badge ? n.badge() : 0;
    const on = (VIEW===n.k) ? 'on' : '';
    if(mobile) return `<button class="${on}" data-go="${n.k}">${ICON[n.icon]}<span>${n.label.replace('练习首页','首页').replace('数据统计','统计')}</span></button>`;
    return `<button class="${on}" data-go="${n.k}">${ICON[n.icon]}<span>${n.label}</span>${cnt?`<span class="cnt">${cnt}</span>`:''}</button>`;
  }).join('');
}
function paintNav(){
  $('#nav').innerHTML = navHTML(false);
  $('#mnav').innerHTML = navHTML(true);
  $('#themeBtn').innerHTML = (document.documentElement.dataset.theme==='dark'?ICON.sun:ICON.moon) +
    `<span>${document.documentElement.dataset.theme==='dark'?'浅色模式':'深色模式'}</span>`;
}
$('#aboutLink').onclick = ()=> $('#about').classList.add('on');
$('#about').addEventListener('click', async e=>{
  if(e.target.id==='about') $('#about').classList.remove('on');
  if(e.target.id==='aboutClose') $('#about').classList.remove('on');
  if(e.target.id==='resetBtn'){
    if (!sync || !confirm('清空这个 ID 的云端答题记录、错题与收藏？其他设备的进度也会清空。')) return;
    const button = e.target;
    button.disabled = true;
    try {
      await sync.clear();
      $('#about').classList.remove('on');
    } catch (error) {
      if (sync) alert(error.message);
    } finally {
      button.disabled = false;
    }
  }
});
$('#themeBtn').onclick = ()=>{
  const t = document.documentElement.dataset.theme==='dark'?'light':'dark';
  document.documentElement.dataset.theme = t; DB.theme = t; saveDB(); paintNav();
};
document.addEventListener('click', e=>{
  const g = e.target.closest('[data-go]');
  if(g){ go(g.dataset.go); }
});

/* ---------------- router ---------------- */
function go(v){
  if (!sync) return;
  VIEW = v;
  if(v!=='practice') toggleSheet(false);
  if(v==='practice'){ renderPractice(); }
  else if(v==='home'){ renderHome(); }
  else if(v==='wrong'){ renderList('wrong'); }
  else if(v==='fav'){ renderList('fav'); }
  else if(v==='stats'){ renderStats(); }
  else if(v==='search'){ renderSearch(); }
  else if(v==='result'){ renderResult(); }
  paintNav();
  window.scrollTo({top:0});
}

/* ---------------- home ---------------- */
function renderHome(){
  const o = overall(), st = streak(), td = todayCount();
  const last = DB.pos.__last;
  const contBtn = last
    ? `<button class="qbtn primary" data-act="resume"><b>继续练习</b><span>${esc(last.title)} · 第 ${last.i+1} 题</span></button>`
    : `<button class="qbtn primary" data-act="resumeEmpty"><b>开始练习</b><span>从第一部分顺序刷起</span></button>`;

  $('#main').innerHTML = `
  <div class="page-head">
    <div class="eyebrow">Pharmacology · 题库精解</div>
    <h1>药理学刷题</h1>
    <p>1709 题 · 人卫第 10 版 · 每题逐项解析与教材页码</p>
  </div>
  <section class="hero">
    <div class="ring" style="--p:${o.acc}">
      <div class="disc"><div class="mid"><b>${o.acc}%</b><span>总正确率</span></div></div>
    </div>
    <div class="kpis">
      <div class="kpi"><b>${o.done}<small>/ ${o.n}</small></b><span>已练题数</span></div>
      <div class="kpi"><b>${td}</b><span>今日已答</span></div>
      <div class="kpi"><b>${st}<small>天</small></b><span>连续打卡</span></div>
      <div class="kpi"><b>${DB.wrong.length}</b><span>待攻克错题</span></div>
    </div>
  </section>
  <div class="quick">
    ${contBtn}
    <button class="qbtn" data-act="random"><b>随机 20 题</b><span>混合抽题，查漏补缺</span></button>
    <button class="qbtn" data-act="wrong"><b>错题重练</b><span>${DB.wrong.length} 题待复习</span></button>
    <button class="qbtn" data-act="exam"><b>${DB.exam ? '继续模拟考' : '模拟考'}</b><span>50 题 · 60 分钟 · 交卷评分</span></button>
  </div>
  <div class="sec-title"><h2>按部分练习</h2><em>9 个部分，共 ${QS.length} 题</em></div>
  <div class="chapters">
    ${SEC.map((s,i)=>{
      const st2 = sectionStat(i);
      return `<button class="chap" data-sec="${i}">
        <div class="row1"><span class="no">${String(i+1).padStart(2,'0')}</span><span>${s.n} 题</span></div>
        <h3>${esc(s.name)}</h3>
        <div class="track"><i style="width:${pct(st2.done, st2.n)}%"></i></div>
        <div class="meta"><span>已练 ${st2.done}</span><span>${st2.done?st2.acc+'%':'—'}</span></div>
      </button>`;
    }).join('')}
  </div>`;
}

document.addEventListener('click', e=>{
  const a = e.target.closest('[data-act]'); if(!a) return;
  const act = a.dataset.act;
  if(act==='resume'){
    const last = DB.pos.__last;
    startSession({title:last.title, ids:last.ids, i:Math.min(last.i, last.ids.length-1), mode:last.mode||'seq', key:last.key});
  }
  else if(act==='resumeEmpty') startSection(0, 0);
  else if(act==='random') startSession({title:'随机 20 题', ids:shuffle(QS.map(q=>q.id)).slice(0,20), mode:'random'});
  else if(act==='wrong'){ if(!DB.wrong.length){ go('wrong'); return; } startSession({title:'错题重练', ids:DB.wrong.slice(), mode:'wrong'}); }
  else if (act==='exam') {
    if (DB.exam) startSession({...DB.exam, title:'模拟考', mode:'exam', immediate:false, minutes:60});
    else startSession({title:'模拟考', ids:shuffle(QS.map(q=>q.id)).slice(0,50), mode:'exam', immediate:false, minutes:60});
  }
  else if(act==='next') nextQ();
  else if(act==='prev') prevQ();
  else if(act==='fav') toggleFav();
  else if(act==='submit') submitMulti();
  else if(act==='sheet') toggleSheet(true);
  else if(act==='closesheet') toggleSheet(false);
  else if(act==='exit') exitSession();
  else if(act==='handin') handIn();
  else if(act==='retry') startSession({title:SESS.title, ids:SESS.ids, mode:SESS.mode, immediate:SESS.immediate, minutes:SESS.minutes, key:SESS.key});
  else if(act==='restart') go('home');
  else if(act==='autonext'){ DB.autonext = !DB.autonext; saveDB(); renderPractice(); }
});
document.addEventListener('click', e=>{
  const c = e.target.closest('[data-sec]'); if(c){ startSection(+c.dataset.sec); }
});

/* ---------------- session ---------------- */
function startSection(i, idx){
  const ids = BY_SEC[i].map(q=>q.id);
  const saved = DB.pos['s'+i] || 0;
  startSession({title:SEC[i].name, ids, i: idx!=null?idx:saved, mode:'seq', key:'s'+i});
}
function startSession(o){
  const ids = o.ids.filter(id => QMAP.has(id));
  if (!ids.length) return;
  SESS = {
    title:o.title, ids, i:Math.min(o.i||0, ids.length-1), mode:o.mode, key:o.key||null,
    immediate:o.immediate!==false, minutes:o.minutes||0,
    pick:structuredClone(o.pick||{}), ans:{}, t0:o.t0||Date.now(), submitted:false, reviewing:false
  };
  savePosition();
  SHOW_SHEET = false;
  toggleSheet(false);
  go('practice');
}

function savePosition(){
  if (!SESS || SESS.submitted || SESS.reviewing) return;
  const {ids, i, mode, key, title, pick, t0} = SESS;
  if (mode === 'exam') DB.exam = {ids, i, pick:structuredClone(pick), t0};
  else {
    if (key) DB.pos[key] = i;
    DB.pos.__last = {title, ids, i, mode, key};
  }
  saveDB();
}
function cur(){ return QMAP.get(SESS.ids[SESS.i]); }

function renderPractice(){
  if(!SESS){ go('home'); return; }
  if(SESS.submitted){ renderResult(); return; }
  const q = cur();
  if(!q){ handIn(); return; }
  const total = SESS.ids.length;
  const picked = SESS.pick[q.id] || [];
  const graded = SESS.ans[q.id];
  const answered = !!graded;
  const isFav = DB.fav.includes(q.id);
  const secName = SEC[q.sec].name;

  const timer = SESS.minutes ? `<span id="timer" style="font-variant-numeric:tabular-nums">--:--</span>` : '';

  $('#main').innerHTML = `
  <div class="ptop">
    <button class="round" data-act="exit" title="退出">${ICON.left}</button>
    <div class="mid">
      <div class="lbl"><b>${esc(SESS.title)}</b><span>${SESS.i+1} / ${total} ${timer}</span></div>
      <div class="bar"><i style="width:${pct(SESS.i+ (answered||picked.length?1:0), total)}%"></i></div>
    </div>
    <button class="round" data-act="sheet" title="答题卡">${ICON.grid}</button>
  </div>

  <article class="qcard">
    <div class="qmeta">
      <span class="qno">${SESS.mode==='seq'?`第 ${q.num} 题`:`题库第 ${q.num} 题`}</span>
      <span class="pill">${esc(secName)}</span>
      ${q.m?'<span class="pill multi">多选</span>':''}
      ${q.flag?'<span class="pill warn">答案已校正</span>':''}
    </div>
    <h2 class="stem">${fmtStem(q.stem)}</h2>
    <div class="opts" id="opts">
      ${q.opts.map(o=>optHTML(q,o,picked,graded)).join('')}
    </div>
    ${answered ? verdictHTML(q, graded) : ''}
    <div class="pfoot fix">
      <button class="btn ghost favbtn ${isFav?'on':''}" data-act="fav">${ICON.star}${isFav?'已收藏':'收藏'}</button>
      <div class="sp"></div>
      <button class="btn" data-act="prev" ${SESS.i===0?'disabled':''}>${ICON.left}上一题</button>
      ${(!answered && q.m) ? `<button class="btn primary" data-act="submit" ${picked.length?'':'disabled'}>提交答案${picked.length?` (${picked.length})`:''}</button>`
        : `<button class="btn primary" data-act="next">${SESS.i===total-1?(SESS.immediate?'完成':'交卷'):'下一题'}${ICON.right}</button>`}
    </div>
  </article>`;

  if(SESS.minutes) tickTimer();
}

function fmtStem(s){
  return esc(chem(s)).replace(/（\s*）/g,'（　）').replace(/\(\s*\)/g,'（　）');
}
function optHTML(q,o,picked,graded){
  const isPicked = picked.includes(o.k);
  const isKey = q.a.includes(o.k);
  let cls = 'opt';
  if(graded){
    cls += ' done filled';
    if(isKey) cls += ' right';
    else if(isPicked) cls += ' bad';
    else cls += ' dim';
  } else if(isPicked) cls += ' picked';
  const mk = graded ? `<span class="mk">${isKey?ICON.check:(isPicked?ICON.cross:'')}</span>` : '<span class="mk"></span>';
  return `<button class="${cls}" data-k="${o.k}">
    <span class="k">${o.k}</span>
    <span class="body">${esc(chem(o.t))}${o.e?`<span class="ex">${esc(chem(o.e))}</span>`:''}</span>
    ${mk}
  </button>`;
}
function verdictHTML(q, g){
  const my = g.sel.join('');
  const key = q.a.join('');
  const head = g.ok
    ? `<span class="tag ok">${ICON.check}回答正确</span>`
    : `<span class="tag bad">${ICON.cross}回答错误</span>`;
  const mine = g.ok ? '' : `<span class="key">你的选择 <b class="mine">${my||'—'}</b></span><span class="dot">●</span>`;
  const keyline = `${mine}<span class="key">正确答案 <b>${key}</b>${q.m?'（多选）':''}</span>`;
  return `<div class="verdict">${head}${keyline}</div>
    ${q.flag?`<div class="warnbox">⚠ ${esc(chem(q.note || '原卷答案字段与解析不一致，已按解析结论校正。'))}</div>`:''}
    ${q.book?`<div class="bookline"><span class="bk">教材</span><span>${esc(chem(q.book))}</span></div>`:''}`;
}

/* select option */
document.addEventListener('click', e=>{
  const o = e.target.closest('#opts .opt'); if(!o || !SESS || VIEW!=='practice') return;
  const q = cur(); if(!q) return;
  if(SESS.ans[q.id] || SESS.reviewing) return;
  const k = o.dataset.k;
  const pick = SESS.pick[q.id] || [];
  if(q.m){
    const i = pick.indexOf(k);
    if(i>=0) pick.splice(i,1); else pick.push(k);
    pick.sort();
    SESS.pick[q.id] = pick;
    if (!SESS.immediate) savePosition();
    // light re-render of options only
    const graded = null;
    document.getElementById('opts').innerHTML = q.opts.map(oo=>optHTML(q,oo,pick,graded)).join('');
    const btn = document.querySelector('[data-act="submit"]');
    if(btn){ btn.disabled = !pick.length; btn.textContent = pick.length?`提交答案 (${pick.length})`:'提交答案'; }
  } else {
    SESS.pick[q.id] = [k];
    if(SESS.immediate){ grade(); }
    else {
      savePosition();
      document.getElementById('opts').innerHTML = q.opts.map(oo=>optHTML(q,oo,[k],null)).join('');
    }
  }
});

function submitMulti(){
  const q = cur(); if(!q) return;
  if(!(SESS.pick[q.id]||[]).length) return;
  grade();
}

function grade(){
  const q = cur();
  const sel = (SESS.pick[q.id]||[]).slice().sort();
  const ok = sameSet(sel, q.a);
  SESS.ans[q.id] = {sel, ok};
  if(SESS.immediate){
    record(q, ok, sel);
    // wrong book maintenance
    if(!ok){ if(!DB.wrong.includes(q.id)) DB.wrong.push(q.id); }
    else if(SESS.mode==='wrong'){ const wi = DB.wrong.indexOf(q.id); if(wi>=0) DB.wrong.splice(wi,1); }
    savePosition();
  }
  renderPractice(); paintNav();
  const currentSession = SESS;
  if(DB.autonext && ok){ setTimeout(()=>{ if(VIEW==='practice' && SESS===currentSession && cur()?.id===q.id) nextQ(); }, 620); }
}

function record(q, ok, selection){
  const time = Date.now();
  const day = todayStr();
  attempts.push({question:q.id, day, time, selection});
  const r = DB.rec[q.id] || {a:0,c:0,w:0};
  r.a++; if(ok) r.c++; r.w = ok?0:1; r.t = time; r.sel = selection;
  DB.rec[q.id] = r;
  const d = todayStr();
  const h = DB.hist[d] || {n:0, ok:0};
  h.n++; if(ok) h.ok++;
  DB.hist[d] = h;
}

function nextQ(){
  if(!SESS) return;
  if(SESS.i >= SESS.ids.length-1){
    if (SESS.reviewing) { SESS.submitted = true; go('result'); return; }
    if(SESS.immediate) finishSession(); else handIn();
    return;
  }
  SESS.i++;
  renderPractice();
  savePosition();
  window.scrollTo({top:0,behavior:'smooth'});
}
function prevQ(){
  if(!SESS || SESS.i===0) return;
  SESS.i--; savePosition(); renderPractice(); window.scrollTo({top:0,behavior:'smooth'});
}
function toggleFav(){
  const q = cur(); if(!q) return;
  const i = DB.fav.indexOf(q.id);
  if(i>=0) DB.fav.splice(i,1); else DB.fav.push(q.id);
  saveDB(); renderPractice(); paintNav();
}
function exitSession(){
  savePosition();
  SESS = null; go('home');
}

/* timer */
let timerId = null;
function tickTimer(){
  if(!SESS || SESS.submitted || SESS.reviewing || VIEW!=='practice') return;
  const el = document.getElementById('timer'); if(!el) return;
  const left = SESS.minutes*60 - Math.floor((Date.now()-SESS.t0)/1000);
  if(left<=0){ handIn(); return; }
  el.textContent = fmtTime(left);
  if(left<300) el.style.color = 'var(--bad)';
  clearTimeout(timerId);
  timerId = setTimeout(tickTimer, 500);
}

/* answer sheet */
function toggleSheet(on){
  SHOW_SHEET = on;
  const sh = $('#sheet');
  if(!on){ sh.classList.remove('on'); return; }
  const total = SESS.ids.length;
  const cells = SESS.ids.map((id,i)=>{
    const q = QMAP.get(id);
    const g = SESS.ans[id];
    const p = SESS.pick[id];
    let c = 'cell';
    if(g) c += g.ok?' right':' bad';
    else if(p && p.length) c += ' pick';
    if(i===SESS.i) c += ' cur';
    return `<button class="${c}" data-jump="${i}">${q.num}</button>`;
  }).join('');
  const answered = Object.keys(SESS.ans).length;
  const pickedN = Object.keys(SESS.pick).filter(k=>SESS.pick[k].length).length;
  $('#sheetPanel').innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start">
      <div><h3>答题卡</h3><div class="sub">${esc(SESS.title)} · 共 ${total} 题</div></div>
      <button class="round" data-act="closesheet">${ICON.close}</button>
    </div>
    <div class="legend">
      ${SESS.immediate ? `
        <span><i style="background:var(--ok-soft)"></i>答对 ${answered-Object.values(SESS.ans).filter(a=>!a.ok).length}</span>
        <span><i style="background:var(--bad-soft)"></i>答错 ${Object.values(SESS.ans).filter(a=>!a.ok).length}</span>
        <span><i style="background:var(--line2);border:1px solid var(--line)"></i>未答 ${total-answered}</span>`
      : `<span><i style="background:var(--accent-soft)"></i>已答 ${pickedN}</span>
         <span><i style="background:var(--line2);border:1px solid var(--line)"></i>未答 ${total-pickedN}</span>`}
    </div>
    <div class="grid">${cells}</div>
    <div style="display:flex;flex-direction:column;gap:8px;margin-top:22px">
      <button class="btn ghost" data-act="autonext" style="justify-content:flex-start">
        ${DB.autonext?'✓':'○'}&nbsp;答对后自动下一题</button>
      ${!SESS.immediate?`<button class="btn primary" data-act="handin">交卷</button>`:''}
      <button class="btn ghost" data-act="exit" style="justify-content:flex-start">退出本次练习</button>
      <div class="tiny" style="padding:8px 2px 0;line-height:1.9">
        <span class="kbd">A</span>–<span class="kbd">E</span> 选择 ·
        <span class="kbd">←</span><span class="kbd">→</span> 切题 ·
        <span class="kbd">Enter</span> 下一题 ·
        <span class="kbd">F</span> 收藏
      </div>
    </div>`;
  sh.classList.add('on');
}
document.addEventListener('click', e=>{
  const j = e.target.closest('[data-jump]');
  if(j){ SESS.i = +j.dataset.jump; savePosition(); toggleSheet(false); renderPractice(); window.scrollTo({top:0}); }
});
$('#sheet').addEventListener('click', e=>{ if(e.target.id==='sheet') toggleSheet(false); });

/* finish (immediate mode) */
function finishSession(){
  const ids = SESS.ids;
  let ok=0, done=0;
  ids.forEach(id=>{ const a=SESS.ans[id]; if(a){ done++; if(a.ok) ok++; } });
  const wrongIds = ids.filter(id=>SESS.ans[id] && !SESS.ans[id].ok);
  $('#main').innerHTML = `
  <div class="page-head"><div class="eyebrow">Completed</div><h1>本轮完成</h1>
  <p>${esc(SESS.title)} · 共 ${ids.length} 题</p></div>
  <div class="result">
    <div class="score">${pct(ok,done||ids.length)}<small>%</small></div>
    <div class="sub">本轮正确率</div>
    <div class="seg">
      <i style="width:${pct(ok, ids.length)}%;background:var(--ok)"></i>
      <i style="width:${pct(wrongIds.length, ids.length)}%;background:var(--bad)"></i>
    </div>
    <div class="segcap"><s><u style="background:var(--ok)"></u>答对 ${ok}</s><s><u style="background:var(--bad)"></u>答错 ${wrongIds.length}</s><s><u style="background:var(--line)"></u>未答 ${ids.length-done}</s></div>
    <div class="row">
      <div><b>${done}</b>已作答</div>
      <div><b>${ok}</b>答对</div>
      <div><b>${wrongIds.length}</b>答错</div>
      <div><b>${fmtTime(Math.floor((Date.now()-SESS.t0)/1000))}</b>用时</div>
    </div>
  </div>
  <div class="pfoot" style="justify-content:center">
    <button class="btn" data-act="restart">回到首页</button>
    ${wrongIds.length?`<button class="btn primary" data-act="retryWrong">重做错题 ${wrongIds.length} 道</button>`:''}
  </div>`;
  paintNav();
}
document.addEventListener('click', e=>{
  const a = e.target.closest('[data-act="retryWrong"]'); if(!a) return;
  const wrongIds = SESS.ids.filter(id=>SESS.ans[id] && !SESS.ans[id].ok);
  startSession({title:'错题重做', ids:wrongIds, mode:'wrong'});
});

/* exam hand-in */
function handIn(){
  if(!SESS || SESS.submitted || SESS.reviewing) return;
  SESS.ids.forEach(id=>{
    const q = QMAP.get(id);
    const pick = (SESS.pick[id]||[]).slice().sort();
    const ok = pick.length ? sameSet(pick, q.a) : false;
    SESS.ans[id] = {sel:pick, ok, blank: !pick.length};
    if(!pick.length) return;
    record(q, ok, pick);
    if(!ok && !DB.wrong.includes(id)) DB.wrong.push(id);
  });
  SESS.submitted = true;
  toggleSheet(false);
  DB.exam = null;
  saveDB();
  go('result');
}
function renderResult(){
  const ids = SESS.ids;
  let ok=0, done=0; const wrongList = [];
  ids.forEach(id=>{
    const a = SESS.ans[id];
    if(a && a.sel && a.sel.length){ done++; if(a.ok) ok++; else wrongList.push(id); }
  });
  const used = Math.floor((Date.now()-SESS.t0)/1000);
  const score = Math.round(ok/ids.length*100);
  $('#main').innerHTML = `
  <div class="page-head"><div class="eyebrow">Exam result</div><h1>模拟考成绩</h1>
  <p>共 ${ids.length} 题 · 用时 ${fmtTime(used)}</p></div>
  <div class="result">
    <div class="score">${score}<small>分</small></div>
    <div class="sub">正确 ${ok} 题 · 答错 ${wrongList.length} 题 · 未答 ${ids.length-done} 题</div>
    <div style="max-width:520px;margin:0 auto">
      <div class="seg">
        <i style="width:${pct(ok, ids.length)}%;background:var(--ok)"></i>
        <i style="width:${pct(wrongList.length, ids.length)}%;background:var(--bad)"></i>
      </div>
      <div class="segcap"><s><u style="background:var(--ok)"></u>答对 ${ok}</s><s><u style="background:var(--bad)"></u>答错 ${wrongList.length}</s><s><u style="background:var(--line)"></u>未答 ${ids.length-done}</s></div>
    </div>
  </div>
  <div class="sec-title" style="margin-top:30px"><h2>错题回顾</h2><em>${wrongList.length} 题</em></div>
  ${wrongList.length?`<div class="list">${wrongList.map(id=>{
      const q = QMAP.get(id), a = SESS.ans[id];
      return `<button class="item" data-review="${id}">
        <div class="txt"><div>${esc(q.stem).slice(0,90)}</div>
          <div class="meta"><span>你的答案 ${a?a.sel.join(''):'未答'}</span><span>正确答案 ${q.a.join('')}</span></div>
        </div><span class="badge">第 ${q.num} 题</span></button>`;
    }).join('')}</div>`:`<div class="empty"><b>全部答对</b><p>这套题没有需要回顾的错题。</p></div>`}
  <div class="pfoot" style="justify-content:center;margin-top:26px">
    <button class="btn" data-act="restart">回到首页</button>
    ${wrongList.length?`<button class="btn primary" data-act="reviewWrong">逐题看解析</button>`:''}
  </div>`;
  paintNav();
}
document.addEventListener('click', e=>{
  const a = e.target.closest('[data-act="reviewWrong"]');
  if(a){
    const wrongIds = SESS.ids.filter(id=>SESS.ans[id] && !SESS.ans[id].ok);
    const sess = SESS;
    startSession({title:'错题回顾', ids:wrongIds, mode:'wrong'});
    return;
  }
  const r = e.target.closest('[data-review]');
  if(r && SESS){ const id = r.dataset.review; SESS.i = Math.max(0, SESS.ids.indexOf(id)); SESS.submitted=false; SESS.reviewing=true; go('practice'); }
});

/* ---------------- lists ---------------- */
function renderList(kind){
  const ids = kind==='wrong' ? DB.wrong.slice().reverse() : DB.fav.slice().reverse();
  const title = kind==='wrong' ? '错题本' : '收藏夹';
  const sub = kind==='wrong' ? '答错自动收录；在错题重练中答对即移出' : '按收藏时间倒序';
  $('#main').innerHTML = `
  <div class="page-head"><div class="eyebrow">${kind==='wrong'?'Review':'Saved'}</div><h1>${title}</h1><p>${sub} · 共 ${ids.length} 题</p></div>
  ${ids.length?`
    <div class="pfoot" style="margin:0 0 18px">
      <button class="btn primary" data-start="${kind}">${kind==='wrong'?'开始重练':'开始练习'}</button>
      <button class="btn ghost" data-clear="${kind}">清空</button>
    </div>
    <div class="list">
      ${ids.map(id=>{
        const q = QMAP.get(id); if(!q) return '';
        const r = DB.rec[id];
        return `<button class="item" data-open="${id}">
          <div class="txt"><div>${esc(q.stem)}</div>
            <div class="meta"><span>${esc(SEC[q.sec].name)} · 第 ${q.num} 题</span>
            ${r?`<span>作答 ${r.a} 次 · 对 ${r.c} 次</span>`:''}</div>
          </div>
          <span class="chev">›</span>
        </button>`;
      }).join('')}
    </div>`
  : `<div class="empty"><b>${kind==='wrong'?'还没有错题':'还没有收藏'}</b>
      <p>${kind==='wrong'?'练习中答错的题目会出现在这里。':'在练习页点「收藏」把易错题存下来。'}</p></div>`}`;
  paintNav();
}
document.addEventListener('click', e=>{
  const s = e.target.closest('[data-start]');
  if(s){
    const kind = s.dataset.start;
    const ids = (kind==='wrong'?DB.wrong:DB.fav).slice();
    if(!ids.length) return;
    startSession({title:kind==='wrong'?'错题重练':'收藏练习', ids, mode:kind==='wrong'?'wrong':'fav'});
    return;
  }
  const c = e.target.closest('[data-clear]');
  if(c){
    const kind = c.dataset.clear;
    if(kind==='wrong') DB.wrong = []; else DB.fav = [];
    saveDB(); go(kind); return;
  }
  const o = e.target.closest('[data-open]');
  if(o){
    const id = o.dataset.open;
    const ids = (VIEW==='wrong'?DB.wrong:DB.fav).slice().reverse();
    startSession({title:VIEW==='wrong'?'错题本':'收藏夹', ids, i:Math.max(0,ids.indexOf(id)), mode:VIEW});
  }
});

/* ---------------- stats ---------------- */
function renderStats(){
  const o = overall();
  const days = [];
  for(let k=6;k>=0;k--){
    const d = new Date(); d.setDate(d.getDate()-k);
    const ds = d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
    const h = DB.hist[ds];
    days.push({ds, label:(d.getMonth()+1)+'/'+d.getDate(), n:h?h.n:0, ok:h?h.ok:0, today:k===0});
  }
  const maxN = Math.max(1, ...days.map(d=>d.n));
  const totalTries = Object.values(DB.rec).reduce((s,r)=>s+(r.a||0),0);
  const totalOk = Object.values(DB.rec).reduce((s,r)=>s+(r.c||0),0);

  $('#main').innerHTML = `
  <div class="page-head"><div class="eyebrow">Progress</div><h1>数据统计</h1>
  <p>累计作答 ${totalTries} 次 · 整体正确率 ${pct(totalOk,totalTries)}%</p></div>
  <div class="cards2">
    <div class="stat"><b>${o.done}<small style="font-size:13px;color:var(--ink3)">/${o.n}</small></b><span>累计练过题数</span></div>
    <div class="stat"><b>${o.acc}%</b><span>掌握正确率</span></div>
    <div class="stat"><b>${streak()}</b><span>连续练习天数</span></div>
    <div class="stat"><b>${DB.wrong.length}</b><span>错题待复习</span></div>
  </div>
  <div class="sec-title"><h2>最近 7 天</h2><em>每日答题量</em></div>
  <div class="chart">
    <div class="row bars">
      ${days.map(d=>`<div class="c ${d.today?'today':''}">
        <span class="v">${d.n||''}</span>
        <i style="height:${d.n?Math.max(4, Math.round(d.n/maxN*96)):2}px"></i></div>`).join('')}
    </div>
    <div class="row labs">
      ${days.map(d=>`<div class="c ${d.today?'today':''}"><em>${d.label}</em></div>`).join('')}
    </div>
  </div>
  <div class="sec-title"><h2>各部分正确率</h2><em>按首次作答统计</em></div>
  <div class="sbars">
    ${SEC.map((s,i)=>{
      const st = sectionStat(i);
      const col = !st.done ? 'var(--line2)' : st.acc>=80 ? 'var(--ok)' : st.acc>=60 ? 'var(--accent)' : st.acc>=40 ? 'var(--amber)' : 'var(--bad)';
      return `<div class="sbar">
        <span class="nm" title="${esc(s.name)}">${esc(s.name)}</span>
        <span class="track"><i style="width:${st.done?Math.max(2,st.acc):0}%;background:${col}"></i></span>
        <span class="val"><b>${st.done?st.acc+'%':'—'}</b><span>${st.done}/${st.n}</span></span>
      </div>`;
    }).join('')}
  </div>
  <div style="margin-top:26px;font-size:12px;color:var(--ink3)">
    <a href="#" id="aboutLink2" style="color:var(--accent)">关于题库与数据说明</a>
  </div>`;
  const al = document.getElementById('aboutLink2');
  if(al) al.onclick = e=>{ e.preventDefault(); $('#about').classList.add('on'); };
  paintNav();
}

/* ---------------- search ---------------- */
function renderSearch(){
  $('#main').innerHTML = `
  <div class="page-head"><div class="eyebrow">Search</div><h1>搜题</h1><p>按题干、选项或解析中的关键词检索</p></div>
  <div class="searchbox">${ICON.search}<input id="q" placeholder="如：阿托品、β受体、首关消除…" autocomplete="off"></div>
  <div id="res" class="list"></div>`;
  const inp = $('#q');
  inp.focus();
  let t = null;
  inp.oninput = ()=>{ clearTimeout(t); t = setTimeout(()=>doSearch(inp.value), 180); };
  paintNav();
}
function hlText(txt, kw){
  const safe = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return esc(chem(txt)).replace(new RegExp('('+safe+')','ig'), '<mark>$1</mark>');
}
function snippet(q, kw){
  const k = kw.toLowerCase();
  const parts = [];
  q.opts.forEach(o=>{ parts.push(o.k+'．'+o.t); if(o.e) parts.push(o.e); });
  if(q.note) parts.push(q.note);
  for(const p of parts){
    const i = p.toLowerCase().indexOf(k);
    if(i >= 0){
      const start = Math.max(0, i-18), end = Math.min(p.length, i+kw.length+42);
      return (start>0?'…':'') + p.slice(start,end) + (end<p.length?'…':'');
    }
  }
  return '';
}
function doSearch(kw){
  kw = kw.trim();
  const box = $('#res'); if(!box) return;
  if(!kw){ box.innerHTML = `<div class="empty"><b>输入关键词开始搜索</b><p>可搜题干、选项文字、解析要点</p></div>`; return; }
  const k = kw.toLowerCase();
  let total = 0; const hits = [];
  for(const q of QS){
    const hay = q.stem + ' ' + q.opts.map(o=>o.t+' '+o.e).join(' ') + ' ' + q.note;
    if(hay.toLowerCase().includes(k)){ total++; if(hits.length<60) hits.push(q); }
  }
  if(!hits.length){ box.innerHTML = `<div class="empty"><b>没有找到相关题目</b><p>换个更短的关键词试试</p></div>`; return; }
  box.innerHTML = `<div style="font-size:12px;color:var(--ink3);margin-bottom:2px">共 ${total} 条${total>60?'，显示前 60 条':''}</div>` +
    hits.map(q=>{
      const sn = snippet(q, kw);
      return `<button class="item" data-open="${q.id}">
        <div class="txt"><div>${hlText(q.stem, kw)}</div>
        ${sn?`<div class="snip">${hlText(sn, kw)}</div>`:''}
        <div class="meta"><span>${esc(SEC[q.sec].name)} · 第 ${q.num} 题</span><span>${q.a.join('')}</span></div></div>
      </button>`;
    }).join('');
}

/* ---------------- keyboard ---------------- */
document.addEventListener('keydown', e=>{
  if(e.target.tagName==='INPUT' || e.target.tagName==='TEXTAREA') return;
  if(VIEW!=='practice' || !SESS) return;
  const q = cur(); if(!q) return;
  const key = e.key.toUpperCase();
  if(/^[A-E]$/.test(key)){
    const has = q.opts.some(o=>o.k===key);
    if(!has) return;
    e.preventDefault();
    document.querySelector(`#opts .opt[data-k="${key}"]`)?.click();
    return;
  }
  if(e.key==='Enter'){
    e.preventDefault();
    if(!SESS.ans[q.id] && q.m) submitMulti(); else nextQ();
    return;
  }
  if(e.key==='ArrowRight'){ e.preventDefault(); nextQ(); }
  if(e.key==='ArrowLeft'){ e.preventDefault(); prevQ(); }
  if(key==='F'){ e.preventDefault(); toggleFav(); }
});

function updateProgress(data, reset) {
  DB = data;
  previous = structuredClone(DB);
  document.documentElement.dataset.theme = DB.theme;
  if (reset) { SESS = null; go('home'); return; }
  if (VIEW === 'home') renderHome();
  if (VIEW === 'wrong' || VIEW === 'fav') renderList(VIEW);
  if (VIEW === 'stats') renderStats();
  paintNav();
}

function returnToLogin(message = '') {
  sync?.stop();
  sync = null;
  QS = []; SEC = []; BY_SEC = []; QMAP.clear();
  DB = emptyProgress(); previous = structuredClone(DB); attempts = [];
  SESS = null; VIEW = 'home';
  clearTimeout(timerId);
  for (const selector of ['#main','#nav','#mnav','#sheetPanel','#account-label']) $(selector).replaceChildren();
  $('#about').classList.remove('on');
  $('#sheet').classList.remove('on');
  $('#quiz').hidden = true;
  $('#mnav').hidden = true;
  $('#login').hidden = false;
  document.documentElement.dataset.theme = 'light';
  $('#login-error').textContent = message;
  $('#student-id').focus();
}

$('#student-form').addEventListener('submit', async event => {
  event.preventDefault();
  const input = $('#student-id');
  const submit = event.currentTarget.querySelector('button[type="submit"]');
  const credential = normalizeId(input.value);
  $('#login-error').textContent = '';
  if (!/^PQ-[0-9A-F]{32}$/.test(credential)) {
    $('#login-error').textContent = '请输入管理端发给你的完整刷题 ID。';
    return;
  }
  submit.disabled = true;
  submit.textContent = '正在登录…';
  try {
    const result = await request('student', credential, 'login');
    if (!Array.isArray(result.bank?.qs) || !Array.isArray(result.bank?.sections)) throw new Error('题库暂不可用，请稍后重试。');
    QS = result.bank.qs;
    SEC = result.bank.sections;
    QMAP = new Map(QS.map(q => [q.id, q]));
    BY_SEC = SEC.map(section => QS.filter(q => q.sec === section.i));
    sync = await connectProgress(credential, result, {
      status(text, error) {
        const status = $('#sync-status');
        status.textContent = text;
        status.dataset.state = error ? 'error' : 'ok';
      },
      isCorrect(id, selection) { return sameSet(selection, QMAP.get(id)?.a || []); },
      update: updateProgress,
      denied: returnToLogin
    });
    $('#account-label').textContent = result.label;
    $('#sync-status').textContent = '已同步';
    $('#sync-status').dataset.state = 'ok';
    input.value = '';
    $('#login').hidden = true;
    $('#quiz').hidden = false;
    $('#mnav').hidden = false;
    updateProgress(sync.snapshot(), false);
    go('home');
    sync.start();
  } catch (error) {
    $('#login-error').textContent = error.message;
  } finally {
    submit.disabled = false;
    submit.textContent = '登录刷题';
  }
});

$('#sign-out').addEventListener('click', () => returnToLogin());
$('#sync-status').addEventListener('click', () => { void sync?.flush(); });
window.addEventListener('online', () => { void sync?.flush(); });
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void sync?.flush();
});
