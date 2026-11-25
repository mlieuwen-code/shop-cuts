/*__LAYOUT__*/
(function(){
'use strict';
// Shop Cuts: reads the finished (Excel-calculated) cut sheets from the Ready to Fab folder and lets the shop tick off cuts.
var API_URL = '__WEBAPP__';
var PIN_KEY = 'ridgeway-crew-pin', PROG = 'shop-prog:', SUM = 'shop-sum:';
// One source, two apps: Shop Cuts (saw + assembly tablets) and Shop Welds (the welder's tablet, built with WELD = true).
// Welding is the last stage: Welding complete, signed off in Shop Welds, is what completes a job.
var WELD = /*__WELD__*/false;
// the welder signs off once per job; set this to true to bring back a Weld box on every rail tag
var WELD_BOXES = false;
// Weld progress is its own small record on the backend, 'prog:<file id>.w' (same format as the shop's; its 'fin' is the Welding complete
// sign-off and its 'tl' the weld tick times). Only Shop Welds writes it, and Shop Welds never writes the shop's record.
var WPROG = 'weld-prog:', WSUM = 'weld-sum:', UI = WELD ? 'weld-' : 'shop-';
// a tablet still on an old Shop Cuts completes a job at Assembly; from this day on Shop Welds still lists such a job until it's welded
var WELD_START = Date.UTC(2026, 10, 12, 8);
function isPreview(){ return false; }
function wId(id){ return id + '.w'; }
var el = function(id){ return document.getElementById(id); };
function esc(s){ return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
// a short notice at the bottom of the screen
var VERSION = '__BUILD__', toastT = null;
function toast(t){ var b = el('toast'); b.textContent = t; b.hidden = false; b.classList.remove('out'); clearTimeout(toastT); toastT = setTimeout(function(){ b.classList.add('out'); setTimeout(function(){ b.hidden = true; }, 400); }, 3200); }
function msg(t, ok){ var m = el('msg'); m.hidden = !t; m.className = 'msg ' + (ok ? 'ok' : 'err'); m.textContent = t || ''; }
function lsGet(k){ try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
function lsSet(k, v){ try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

// ---------- tablet storage for job files (so jobs open with no signal) ----------
var dbp = null;
function db(){
  if (!dbp) dbp = new Promise(function(ok, bad){
    var r = indexedDB.open('ridgeway-shop', 1);
    r.onupgradeneeded = function(){ r.result.createObjectStore('files', { keyPath: 'id' }); r.result.createObjectStore('kv'); };
    r.onsuccess = function(){ ok(r.result); }; r.onerror = function(){ bad(r.error); };
  });
  return dbp;
}
function store(name, mode, fn){ return db().then(function(d){ return new Promise(function(ok, bad){ var tx = d.transaction(name, mode), q = fn(tx.objectStore(name)); tx.oncomplete = function(){ ok(q && q.result); }; tx.onerror = function(){ bad(tx.error); }; }); }); }
function fileGet(id){ return store('files', 'readonly', function(s){ return s.get(id); }).catch(function(){ return null; }); }
function filePut(f){ return store('files', 'readwrite', function(s){ return s.put(f); }).catch(function(){}); }
function fileDel(id){ return store('files', 'readwrite', function(s){ return s.delete(id); }).catch(function(){}); }
function fileKeys(){ return store('files', 'readonly', function(s){ return s.getAllKeys(); }).catch(function(){ return []; }); }
function kvGet(k){ return store('kv', 'readonly', function(s){ return s.get(k); }).catch(function(){ return null; }); }
function kvSet(k, v){ return store('kv', 'readwrite', function(s){ return s.put(v, k); }).catch(function(){}); }

// ---------- talking to the Google script ----------
function getPin(){ try { return localStorage.getItem(PIN_KEY) || ''; } catch (e) { return ''; } }
function setPin(p){ try { if (p) localStorage.setItem(PIN_KEY, p); else localStorage.removeItem(PIN_KEY); } catch (e) {} }
function askPin(why, then){
  var m = el('modal'), inp = el('modalInput');
  el('modalText').textContent = why || 'Enter the crew PIN once on this tablet.';
  inp.hidden = false; inp.value = ''; m.hidden = false; setTimeout(function(){ inp.focus(); }, 150);
  el('modalNo').onclick = function(){ m.hidden = true; inp.hidden = true; };
  el('modalYes').onclick = function(){ var v = inp.value.trim(); if (!v) return inp.focus(); setPin(v); m.hidden = true; inp.hidden = true; if (then) then(); };
  inp.onkeydown = function(e){ if (e.key === 'Enter') el('modalYes').click(); };
}
function api(action, extra){
  var pin = getPin();
  if (!pin) return Promise.reject({ code: 'pin' });
  var body = { action: action, pin: pin }; for (var k in extra) body[k] = extra[k];
  return fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) })
    .then(function(r){ return r.json(); }, function(){ throw { code: 'offline', message: 'no signal' }; })
    .then(function(res){
      if (res && res.ok) return res;
      if (res && res.error === 'bad pin'){ setPin(''); throw { code: 'pin', message: 'wrong PIN' }; }
      throw { code: 'script', message: res && res.error ? res.error : 'no reply' };
    });
}

// ---------- job list ----------
var jobs = [], doneJobs = null, DONE_DAYS = 50, holdJobs = lsGet('shop-hold') || [];
// priority order set from the manager screen (file ids, most urgent first); other jobs follow, newest first
var prio = lsGet('shop-prio') || [];
// the office's own order for the other jobs (manager screen); used inside In progress and Not started, ahead of the automatic order
var jorder = lsGet('shop-order') || [];
// remakes sent from the manager screen: one or more rails of a job, shown on their own with their own ticks
// { id, file, name, tags: ['404.1', …], note, at }. Ticks are saved under 'rm' + id, so the original job's ticks are never touched.
var remakes = lsGet('shop-remakes') || [];
function remakeJob(rm){
  var src = jobs.concat(doneJobs || []).filter(function(f){ return f.id === rm.file; })[0];
  return { id: 'rm' + rm.id, src: rm.file, name: rm.name, updated: src ? src.updated : 0, remake: rm };
}
function orderRank(id){ var i = jorder.indexOf(id); return i < 0 ? Infinity : i; }
function byOrder(fallback){ return function(a, b){ var ra = orderRank(jobs[a].id), rb = orderRank(jobs[b].id); return ra !== rb ? (ra < rb ? -1 : 1) : fallback(a, b); }; }
function jobPct(k){ var s = lsGet(SUM + jobs[k].id), p = s && s.total ? s.done / s.total : 0; return s && (s.done > 0 || s.fin) ? p : -1; }
// the job list's groups, same on the tablet and in the manager screen
function listGroups(){
  var ks = jobs.map(function(f, k){ return k; }), pct = ks.map(jobPct);
  var atw = ks.filter(function(k){ var s = lsGet(SUM + jobs[k].id); return !!(s && s.asm); });
  var pri = ks.filter(function(k){ return atw.indexOf(k) < 0 && prioRank(jobs[k].id) < Infinity; });
  var prog = ks.filter(function(k){ return atw.indexOf(k) < 0 && pri.indexOf(k) < 0 && pct[k] >= 0; }).sort(byOrder(function(a, b){ return pct[b] - pct[a] || a - b; }));
  var rest = ks.filter(function(k){ return atw.indexOf(k) < 0 && pri.indexOf(k) < 0 && prog.indexOf(k) < 0; }).sort(byOrder(function(a, b){ return a - b; }));
  return { pri: pri, prog: prog, rest: rest, atw: atw };
}
function prioRank(id){ var i = prio.indexOf(id); return i < 0 ? Infinity : i; }
function applyPrio(){ jobs.sort(function(a, b){ var ra = prioRank(a.id), rb = prioRank(b.id); return ra !== rb ? (ra < rb ? -1 : 1) : b.updated - a.updated; }); }
// newer backend actions first; if Apps Script hasn't been redeployed yet, fall back to the old ones
function apiNew(a2, a1, extra){ return api(a2, extra).catch(function(e){ if (e && /unknown request|not available/i.test(e.message || '')) return api(a1, extra); throw e; }); }
function ring(p){
  var r = 26, c = 2 * Math.PI * r, d = Math.max(0, Math.min(1, p)) * c;
  return '<svg class="ring" viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="' + r + '" fill="none" stroke="#E4EBF2" stroke-width="8"/>' +
    '<circle cx="32" cy="32" r="' + r + '" fill="none" stroke="' + (p >= 1 ? '#2E6B2A' : 'var(--accent)') + '" stroke-width="8" stroke-linecap="round" stroke-dasharray="' + d + ' ' + c + '" transform="rotate(-90 32 32)"/>' +
    '<text x="32" y="37" text-anchor="middle">' + Math.round(p * 100) + '%</text></svg>';
}
// completed in the last 50 days: from the backend's Completed folder, plus any this tablet signed off (in case the backend is older or offline)
function completedList(){
  var cut = Date.now() - DONE_DAYS * 864e5, out = [], ids = {};
  jobs.forEach(function(f){ ids[f.id] = 1; });
  var late = {}; lateCand().forEach(function(d){ late[d.id] = 1; });
  (doneJobs || []).forEach(function(d){ if (d.doneAt >= cut && !ids[d.id] && !late[d.id]){ ids[d.id] = 1; out.push(d); } });
  try { for (var i = 0; i < localStorage.length; i++){ var k = localStorage.key(i); if (k.indexOf(WPROG) !== 0) continue; var id = k.slice(WPROG.length);
    if (ids[id] || late[id]) continue; var pp = lsGet(k); if (pp && pp.name && pp.fin && pp.fin.at >= cut){ ids[id] = 1; out.push({ id: id, name: pp.name, updated: 0, doneAt: pp.fin.at, by: pp.fin.by }); } } } catch (e) {}
  return out.sort(function(a, b){ return b.doneAt - a.doneAt; });
}
// Shop Welds only: jobs an old Shop Cuts tablet moved to Completed at Assembly, before they were welded.
// lateCand = might be one (not known as welded on this tablet); lateJobs = checked against the backend this session, so they're listed.
var wChecked = {};
function lateCand(){ if (!WELD) return []; return (doneJobs || []).filter(function(d){ return (isPreview() || d.doneAt >= WELD_START) && !wLoad(d.id).fin; }).map(function(d){ return { id: d.id, name: d.name, updated: d.updated, late: 1, by: d.by, doneAt: d.doneAt }; }); }
function lateJobs(){ return lateCand().filter(function(d){ return wChecked[d.id]; }); }
var shownDone = [], doneQuery = '';
// search inside Completed: hides rows that don't match, without redrawing (so the keyboard stays up)
function filterDone(){
  var q = doneQuery.trim().toLowerCase(), words = q ? q.split(/\s+/) : [], n = 0, rows = document.querySelectorAll('#jobs .job[data-d]');
  Array.prototype.forEach.call(rows, function(r){ var nm = r.getAttribute('data-name') || '', hit = words.every(function(w){ return nm.indexOf(w) >= 0; }); r.hidden = !hit; if (hit) n++; });
  var c = el('doneN'), none = el('doneNone'); if (c) c.textContent = q ? n + ' of ' + rows.length : ''; if (none) none.hidden = !(q && !n);
}
document.addEventListener('input', function(e){ if (e.target && e.target.id === 'doneQ'){ doneQuery = e.target.value; filterDone(); } });
// the status line under a job on the list
function jobStatus(s){
  var day = function(t){ return esc(new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' })); };
  if (s && s.asm){
    var ws = lsGet(WSUM + s.id) || {};
    if (ws.fin) return '<span class="fin-tag">✓ Welded · ' + esc(ws.fin.by) + ' · ' + day(ws.fin.at) + '</span>';
    return '<span class="fin-tag">✓ Assembled · ' + esc(s.asm.by) + ' · ' + day(s.asm.at) + '</span> · <span class="atweld">' + (ws.d ? ws.d + ' of ' + ws.n + ' welded' : 'waiting on welding') + '</span>';
  }
  if (s && s.total && s.done >= s.total) return '<span class="signoff">All ticked · sign off Assembly complete</span>' + (s.fin ? ' · <span class="fin-tag">✓ Cut · ' + esc(s.fin.by) + '</span>' : '');
  if (s && s.fin) return '<span class="fin-tag">✓ Cut · ' + esc(s.fin.by) + ' · ' + day(s.fin.at) + '</span>';
  return s && s.total ? s.done + ' of ' + s.total + ' ticked' : 'Not started';
}
// On hold: jobs the office has ready (Ready To Fab / On Hold) but doesn't want started yet. They open to look at, with no ticking.
function holdCard(have){
  if (WELD || !holdJobs.length) return '';
  return '<div class="prcard holdcard"><div class="prhead"><span class="prflame" aria-hidden="true">' + LOCK + '</span>On hold<span>· ready, but don’t start these yet</span></div>' +
    holdJobs.map(function(f, k){
      var on = have.indexOf(f.id) >= 0, info = lsGet('shop-info:' + f.id), tag = info && info.u === f.updated ? info.label : '';
      return '<button type="button" class="job holdjob" data-h="' + k + '"><span class="ring holdring" aria-hidden="true">' + LOCK + '</span><span class="t"><b>' + esc(f.name.replace(/\.xls[xm]$/i, '')) + '</b>' +
        '<span class="s"><span class="holdtag">On hold · look only</span> · saved ' + esc(new Date(f.updated).toLocaleDateString([], { month: 'short', day: 'numeric' })) + (on ? ' · <span class="offline">✓ on tablet</span>' : '') + '</span></span>' +
        (tag && /^\d/.test(tag) ? '<span class="cnt"><b>' + tag.replace(/ .*/, '') + '</b>' + esc(tag.replace(/^\d+ /, '')) + '</span>' : '') + '</button>';
    }).join('') + '</div>';
}
var LOCK = '<svg width="24" height="24" viewBox="0 0 24 24" style="vertical-align:-4px"><rect x="4.5" y="10.5" width="15" height="11" rx="2.5" fill="currentColor"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" stroke-width="2.6"/></svg>';
function renderList(cached){
  var box = el('jobs');
  fileKeys().then(function(have){
    shownDone = completedList();
    // collapsed by default; each tablet remembers if it was left open
    var open = lsGet(UI + 'done-open') === 1;
    var done = !shownDone.length ? '<div class="donehead donenone"><span class="chev">✓</span>Completed (0) <span>· jobs show here for ' + DONE_DAYS + ' days once Welding complete is signed off</span></div>' : '<button type="button" class="donehead" data-act="donetoggle" aria-expanded="' + open + '"><span class="chev">' + (open ? '▾' : '▸') + '</span>Completed (' + shownDone.length + ') <span>· last ' + DONE_DAYS + ' days</span></button>' + (!open ? '' : '<div class="donesearch"><input type="search" id="doneQ" placeholder="Search completed jobs" autocomplete="off" aria-label="Search completed jobs" value="' + esc(doneQuery) + '"><span id="doneN"></span></div>' + shownDone.map(function(f, k){
      var on = have.indexOf(f.id) >= 0;
      return '<button type="button" class="job done fin-job" data-d="' + k + '" data-name="' + esc(f.name.toLowerCase()) + '"><span class="ring donering" aria-hidden="true">✓</span><span class="t"><b>' + esc(f.name.replace(/\.xls[xm]$/i, '')) + '</b>' +
        '<span class="s"><span class="fin-tag">✓ Completed · ' + (f.by ? esc(f.by) + ' · ' : '') + esc(new Date(f.doneAt).toLocaleDateString([], { month: 'short', day: 'numeric' })) + '</span>' + (on ? ' · <span class="offline">✓ on tablet</span>' : '') + '</span></span></button>';
    }).join('') + '<div class="empty" id="doneNone" hidden>No completed jobs match.</div>');
    if (WELD){ renderWeldList(box, have, done); setTimeout(filterDone, 0); return; }
    if (!jobs.length){ box.innerHTML = '<div class="empty">No jobs in Ready to Fab yet. When a job is ready, it’s saved there from the office and shows up here.</div>' + holdCard(have) + done; return; }
    setTimeout(filterDone, 0);
    var pct = [], cards = jobs.map(function(f, k){
      var s = lsGet(SUM + f.id), p = s && s.total ? s.done / s.total : 0, on = have.indexOf(f.id) >= 0; if (s) s.id = f.id;
      pct[k] = s && (s.done > 0 || s.fin) ? p : -1;   // -1 = not started
      var info = lsGet('shop-info:' + f.id), tag = info && info.u === f.updated ? info.label : '';
      var pr = prioRank(f.id);
      return '<button type="button" class="job' + (p >= 1 || (s && s.fin) ? ' done' : '') + '" data-k="' + k + '">' + ring(p) + '<span class="t"><b>' + (pr < Infinity ? '<span class="pri">#' + (pr + 1) + '</span>' : '') + esc(f.name.replace(/\.xls[xm]$/i, '')) + '</b>' +
        '<span class="s">' + jobStatus(s) + ' · saved ' + esc(new Date(f.updated).toLocaleDateString([], { month: 'short', day: 'numeric' })) +
        (on ? ' · <span class="offline">✓ on tablet</span>' : '') + '</span></span>' + (tag ? '<span class="cnt' + (/^\d/.test(tag) ? '' : ' warn') + '">' + (/^(\d+) (.+)$/.test(tag) ? '<b>' + tag.replace(/ .*/, '') + '</b>' + esc(tag.replace(/^\d+ /, '')) : esc(tag)) + '</span>' : '') + '</button>';
    });
    // Priority card (office's rush order), then In progress (most done first), then the rest, newest first
    // signed off Assembly: the shop is finished with it, so it drops to its own card at the bottom until the welder completes it
    var G = listGroups(), atw = G.atw, pri = G.pri, prog = G.prog, rest = G.rest, ordered = jorder.length > 0;
    var pick = function(arr){ return arr.map(function(k){ return cards[k]; }).join(''); };
    var rmCard = function(rm, i){
      var f = remakeJob(rm), s = lsGet(SUM + f.id), p = s && s.total ? s.done / s.total : 0, pr = prioRank(f.id);
      return '<button type="button" class="job rmjob" data-rm="' + i + '">' + ring(p) + '<span class="t"><b>' + (pr < Infinity ? '<span class="pri">#' + (pr + 1) + '</span>' : '') + '<span class="rmtag">' + esc(rm.tags.join(', ')) + '</span>' + esc(rm.name.replace(/\.xls[xm]$/i, '')) + '</b>' +
        '<span class="s">' + (s && s.total ? s.done + ' of ' + s.total + ' ticked' : 'Not started') + (rm.note ? ' · <span class="rmnote">' + esc(rm.note) + '</span>' : '') + '</span></span></button>';
    };
    var rmc = remakes.map(function(rm, i){ return prioRank('rm' + rm.id) < Infinity ? '' : rmCard(rm, i); }).join('');
    // the Priority card in the office's order: jobs and remakes mixed
    var priHtml = prio.map(function(id){
      for (var i = 0; i < remakes.length; i++) if ('rm' + remakes[i].id === id) return rmCard(remakes[i], i);
      for (var j = 0; j < pri.length; j++) if (jobs[pri[j]].id === id) return cards[pri[j]];
      return '';
    }).join('');
    box.innerHTML = (rmc ? '<div class="prcard rmcard"><div class="prhead"><span class="prflame" aria-hidden="true">↻</span>Remakes<span>· just these rails, cut and assemble</span></div>' + rmc + '</div>' : '') + (priHtml ? '<div class="prcard"><div class="prhead"><span class="prflame" aria-hidden="true">⚡</span>Priority<span>· rush these first, in this order</span></div>' + priHtml + '</div>' : '') +
      (prog.length ? '<div class="prcard ipcard"><div class="prhead"><span class="prflame" aria-hidden="true"><svg width="24" height="24" viewBox="0 0 24 24" style="vertical-align:-4px"><circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" stroke-width="3"/><path d="M12 5.5A6.5 6.5 0 0 1 18.5 12H12z" fill="currentColor"/></svg></span>In progress' + (ordered ? '' : '<span>· most done first</span>') + '</div>' + pick(prog) + '</div>' : '') +
      (rest.length && (pri.length || prog.length) ? '<div class="prrest">Not started</div>' : '') + pick(rest) + holdCard(have) +
      (atw.length ? '<div class="prcard wcard"><div class="prhead"><span class="prflame" aria-hidden="true">' + SPARK + '</span>At welding<span>· cut and assembled, waiting on the welder</span></div>' + pick(atw) + '</div>' : '') + done;
  });
  el('listNote').hidden = !cached;
  if (cached) el('listNote').textContent = 'No signal, so this is the list from last time. Jobs marked “on tablet” still open.';
}
// ---------- Shop Welds job list: Ready to weld (assembled) first, then what's still in the shop ----------
var WELD_ICON = '<rect width="512" height="512" fill="#E8590C"/><circle cx="256" cy="256" r="178" fill="#1F1B17"/><path d="M256 92l40 124 124 40-124 40-40 124-40-124-124-40 124-40z" fill="#FFFDF9"/><path d="M366 118l12 34 34 12-34 12-12 34-12-34-34-12 34-12z" fill="#FFFDF9"/><circle cx="256" cy="256" r="30" fill="#E8590C"/>';
var SPARK = '<svg width="24" height="24" viewBox="0 0 24 24" style="vertical-align:-4px"><path d="M12 1l2.6 8.4L23 12l-8.4 2.6L12 23l-2.6-8.4L1 12l8.4-2.6z" fill="currentColor"/></svg>';
var shownW = [];
function renderWeldList(box, have, done){
  var day = function(t){ return esc(new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' })); };
  var all = jobs.concat(lateJobs());
  if (!all.length){ box.innerHTML = '<div class="empty">No jobs in the shop yet. A job shows here once it’s in Ready to Fab, and moves up to Ready to weld when Assembly complete is signed off.</div>' + done; return; }
  var info = all.map(function(f){
    var s = lsGet(SUM + f.id) || {}, ws = lsGet(WSUM + f.id) || {};
    return { f: f, s: s, ws: ws, asm: s.asm || (f.late ? { by: f.by, at: f.doneAt } : null), p: ws.n ? Math.min(1, (ws.d || 0) / ws.n) : 0 };
  });
  var ready = info.filter(function(x){ return x.asm || x.ws.fin; }).sort(function(a, b){ var ra = prioRank(a.f.id), rb = prioRank(b.f.id); return ra !== rb ? (ra < rb ? -1 : 1) : (a.asm ? a.asm.at : 0) - (b.asm ? b.asm.at : 0); });
  var shop = info.filter(function(x){ return !(x.asm || x.ws.fin); });
  shownW = ready.concat(shop).map(function(x){ return x.f; });
  var card = function(x, i, isReady){
    var f = x.f, on = have.indexOf(f.id) >= 0, pr = prioRank(f.id), st, inf = lsGet('shop-info:' + f.id), tag = inf && inf.label ? inf.label : '';
    if (x.ws.fin) st = '<span class="fin-tag">✓ Welded · ' + esc(x.ws.fin.by) + ' · ' + day(x.ws.fin.at) + '</span>';
    else if (isReady) st = (x.ws.d ? '<span class="signoff">' + x.ws.d + ' of ' + x.ws.n + ' welded</span>' : WELD_BOXES ? 'Not started' : '<span class="signoff">Ready to weld</span>') + ' · assembled' + (x.asm.by ? ' by ' + esc(x.asm.by) : '') + ' ' + day(x.asm.at);
    else st = 'Still in the shop · ' + jobStatus(x.s.total ? x.s : null) + (x.ws.d ? ' · ' + x.ws.d + ' welded' : '');
    return '<button type="button" class="job' + (x.ws.fin ? ' done' : '') + (isReady ? '' : ' wait') + '" data-w="' + i + '">' + (x.ws.fin ? '<span class="ring donering" aria-hidden="true">✓</span>' : WELD_BOXES && (isReady || x.ws.d) ? ring(x.p) : isReady ? '<span class="ring wring" aria-hidden="true">' + SPARK + '</span>' : '<span class="ring waitring" aria-hidden="true">…</span>') +
      '<span class="t"><b>' + (pr < Infinity ? '<span class="pri">#' + (pr + 1) + '</span>' : '') + esc(f.name.replace(/\.xls[xm]$/i, '')) + '</b><span class="s">' + st + (on ? ' · <span class="offline">✓ on tablet</span>' : '') + '</span></span>' +
      (tag ? '<span class="cnt' + (/^\d/.test(tag) ? '' : ' warn') + '">' + (/^(\d+) (.+)$/.test(tag) ? '<b>' + tag.replace(/ .*/, '') + '</b>' + esc(tag.replace(/^\d+ /, '')) : esc(tag)) + '</span>' : '') + '</button>';
  };
  box.innerHTML = (ready.length ? '<div class="prcard wcard"><div class="prhead"><span class="prflame" aria-hidden="true">' + SPARK + '</span>Ready to weld<span>· priority jobs first, then longest waiting</span></div>' + ready.map(function(x, i){ return card(x, i, true); }).join('') + '</div>'
      : '<div class="empty">Nothing is waiting on welding right now.</div>') +
    (shop.length ? '<div class="prrest">Still in the shop · cutting and assembly</div>' + shop.map(function(x, i){ return card(x, ready.length + i, false); }).join('') : '') + done;
}
// how many rails (or screens) a job has, for the job list
function railLabel(book){
  if (book.raw) return 'not saved in Excel yet';
  var cut = book.sheets.filter(function(s){ return s.name === 'CUT SHEET'; })[0];
  if (cut) return parseSheet(book, cut).then(function(sd){
    var n = null;
    // fence cut sheets: one row per opening under the Unit heading (the job info and heading rows above aren't rails)
    if (/fence/i.test(String(cellVal(sd, 1, 1) || ''))){ var H = null; for (var r0 = 1; r0 <= 40 && H == null; r0++) if (/^unit$/i.test(String(cellVal(sd, r0, 1) || '').trim())) H = r0; if (H != null){ var m0 = 0; for (var r1 = H + 1; r1 <= sd.maxR; r1++){ var u0 = cellVal(sd, r1, 1); if (u0 != null && u0 !== '' && !isNaN(+u0)) m0++; } return m0 + (m0 === 1 ? ' Rail' : ' Rails'); } }
    Object.keys(sd.cells).forEach(function(k){ var v = sd.cells[k].v, m = typeof v === 'string' && /^\s*total\s*=\s*(\d+)/i.exec(v); if (m && +k.split(':')[1] === 1) n = +m[1]; });
    if (n == null){ n = 0; for (var r = 9; r <= sd.maxR; r++){ var t = cellVal(sd, r, 1); if (t != null && t !== '' && !/total/i.test(String(t))) n++; } }
    return n + (n === 1 ? ' Rail' : ' Rails');
  });
  var scr = book.sheets.filter(function(s){ return s.name === 'Rail to Wall' || s.name === 'Wall to Wall'; });
  if (scr.length) return Promise.all(scr.map(function(sh){ return parseSheet(book, sh).then(function(sd){ var n = 0; for (var r = 7; r <= sd.maxR; r++){ var v = cellVal(sd, r, 1); if (v != null && v !== '' && !isNaN(+v)) n++; } return n; }); })).then(function(a){ var n = a.reduce(function(x, y){ return x + y; }, 0); return n + (n === 1 ? ' Screen' : ' Screens'); });
  return '';
}
function rememberInfo(f, book, count){
  return Promise.resolve(railLabel(book)).then(function(label){
    lsSet('shop-info:' + f.id, { u: f.updated, label: label, lv: 2 });
    if (!count || book.raw) return;
    // the job list's ring needs the job's total box count, even on a tablet that hasn't opened the job yet
    return shopSheets(book).then(function(items){
      var keys = []; items.forEach(function(it){ it.L = layout(book, it); itemKeys(it).forEach(function(k){ keys.push(it.sh.name + '|' + k); }); });
      var p = decodeProg(lsGet(progKey(f.id))), dn = keys.filter(function(k){ return p.done[k]; }).length;
      writeSum(f.id, { dn: dn, fin: p.fin, asm: p.asm }, keys.length);
      writeWSum(f.id, wLoad(f.id), weldRows(items.filter(function(it){ return it.sh.name === 'CUT SHEET'; })[0]).length);
    }).catch(function(){});
  });
}
// fetch new or changed jobs in the background: the list learns their rail counts, and they're on the tablet for when there's no signal
var prefetching = false;
function prefetch(){
  if (prefetching) return; prefetching = true;
  var todo = jobs.concat(lateJobs());
  (function next(){
    var f = todo.shift(); if (!f){ prefetching = false; return; }
    var info = lsGet('shop-info:' + f.id);
    fileGet(f.id).then(function(local){
      if (local && local.updated >= f.updated && info && info.u === f.updated && info.lv === 2 && (lsGet(SUM + f.id) || {}).total && lsGet(WSUM + f.id)) return next();
      var got = local && local.updated >= f.updated ? Promise.resolve(local.b64) : apiNew('fabopen2', 'fabopen', { id: f.id }).then(function(r){ filePut({ id: f.id, name: f.name, updated: f.updated, b64: r.b64 }); return r.b64; });
      return got.then(function(b64){ return parseBook(b64); }).then(function(book){ return rememberInfo(f, book, true); }).then(function(){ if (!cur) renderList(false); next(); }, function(){ next(); });
    });
  })();
}
el('ver').textContent = (WELD ? 'Shop Welds' : 'Shop Cuts') + ' · version ' + VERSION;
var refreshAsked = false, updAsked = false;
var listFresh = false;   // once the backend has answered, the copy saved on the tablet never overwrites it
function loadList(){
  kvGet('list').then(function(l){ kvGet('donelist').then(function(d){ if (listFresh) return; if (d && !doneJobs) doneJobs = d; if (l && !jobs.length){ jobs = l; renderList(true); } }); });
  apiNew('fablist2', 'fablist', {}).then(function(r){
    listFresh = true; jobs = r.files || []; doneJobs = r.done || null; if (Array.isArray(r.hold)){ holdJobs = r.hold; lsSet('shop-hold', holdJobs); } if (Array.isArray(r.prio)){ prio = r.prio; lsSet('shop-prio', prio); } if (Array.isArray(r.order)){ jorder = r.order; lsSet('shop-order', jorder); } if (Array.isArray(r.remakes)){ remakes = r.remakes; lsSet('shop-remakes', remakes); } applyPrio(); kvSet('list', jobs); if (doneJobs) kvSet('donelist', doneJobs);
    renderList(false); if (!el('mgr').hidden) renderMgr(); msg(''); prefetch(); pullAll(); flushPending();
    if (refreshAsked){ refreshAsked = false; toast('✓ Up to date · version ' + VERSION); }
    // forget files that are neither in Ready to Fab nor completed in the last 50 days
    fileKeys().then(function(ks){ var keep = {}; jobs.concat(completedList(), lateCand(), holdJobs).forEach(function(f){ keep[f.id] = 1; }); ks.forEach(function(id){ if (!keep[id]) fileDel(id); }); });
  }, function(e){
    if (refreshAsked){ refreshAsked = false; toast('No signal, so this is the list from last time.'); }
    if (e.code === 'pin') return askPin(e.message === 'wrong PIN' ? 'That PIN didn’t work. Try again.' : 'Enter the crew PIN once on this tablet.', loadList);
    if (!jobs.length) el('jobs').innerHTML = '<div class="empty">Couldn’t reach Drive (' + esc(e.message || 'no signal') + '). Jobs opened before are still on this tablet once the list has loaded once.</div>';
    else renderList(true);
  });
}
el('jobs').addEventListener('click', function(e){ if (e.target.closest('[data-act="donetoggle"]')){ lsSet(UI + 'done-open', lsGet(UI + 'done-open') === 1 ? 0 : 1); return renderList(false); } var rb = e.target.closest('[data-rm]'); if (rb) return openJob(remakeJob(remakes[+rb.getAttribute('data-rm')])); var b = e.target.closest('[data-k]'); if (b) return openJob(jobs[+b.getAttribute('data-k')]); var wj = e.target.closest('[data-w]'); if (wj) return openJob(shownW[+wj.getAttribute('data-w')]); var h = e.target.closest('[data-h]'); if (h) return openJob(Object.assign({}, holdJobs[+h.getAttribute('data-h')], { hold: 1 })); var d = e.target.closest('[data-d]'); if (d) openJob(shownDone[+d.getAttribute('data-d')]); });
// Refresh list: also checks for a newer version of the app (if one arrives, the app reloads and says so)
el('reload').onclick = function(){
  refreshAsked = true; updAsked = true; loadList();
  if (navigator.serviceWorker && navigator.serviceWorker.getRegistration) navigator.serviceWorker.getRegistration().then(function(reg){ if (reg) reg.update().catch(function(){}); });
};

// ---------- reading the workbook (values Excel already calculated) ----------
var P = new DOMParser();
function xml(s){ return P.parseFromString(s, 'application/xml'); }
function kids(n, tag){ return Array.prototype.slice.call(n.getElementsByTagName(tag)); }
function colNum(s){ var n = 0; for (var i = 0; i < s.length; i++) n = n * 26 + s.charCodeAt(i) - 64; return n; }
function colName(n){ var s = ''; while (n > 0){ var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
function splitRef(r){ var m = /^\$?([A-Z]+)\$?(\d+)$/.exec(r); return m ? { c: colNum(m[1]), r: +m[2] } : null; }
function parseBook(b64){
  return JSZip.loadAsync(b64, { base64: true }).then(function(z){
    var f = function(p){ return z.file(p) ? z.file(p).async('string') : Promise.resolve(''); };
    return Promise.all([f('xl/workbook.xml'), f('xl/_rels/workbook.xml.rels'), f('xl/sharedStrings.xml'), f('xl/styles.xml')]).then(function(a){
      var wb = xml(a[0]), rels = {}, ss = [], st = { fmts: {}, xfs: [], fonts: [], fills: [] };
      kids(xml(a[1]), 'Relationship').forEach(function(r){ rels[r.getAttribute('Id')] = r.getAttribute('Target'); });
      if (a[2]) kids(xml(a[2]), 'si').forEach(function(si){ ss.push(kids(si, 't').map(function(t){ return t.textContent; }).join('')); });
      if (a[3]){
        var sd = xml(a[3]);
        kids(sd, 'numFmt').forEach(function(n){ st.fmts[n.getAttribute('numFmtId')] = n.getAttribute('formatCode'); });
        var fonts = sd.getElementsByTagName('fonts')[0], fills = sd.getElementsByTagName('fills')[0], xfs = sd.getElementsByTagName('cellXfs')[0];
        if (fonts) kids(fonts, 'font').forEach(function(fn){ var col = fn.getElementsByTagName('color')[0]; st.fonts.push({ b: fn.getElementsByTagName('b').length > 0, rgb: col && col.getAttribute('rgb') }); });
        if (fills) kids(fills, 'fill').forEach(function(fl){ var fg = fl.getElementsByTagName('fgColor')[0], pt = fl.getElementsByTagName('patternFill')[0]; st.fills.push(pt && pt.getAttribute('patternType') === 'solid' && fg ? (fg.getAttribute('rgb') || (fg.getAttribute('theme') != null ? 'theme' + fg.getAttribute('theme') + ':' + (fg.getAttribute('tint') || 0) : null)) : null); });
        if (xfs) kids(xfs, 'xf').forEach(function(x){ var al = x.getElementsByTagName('alignment')[0]; st.xfs.push({ fmt: x.getAttribute('numFmtId') || '0', font: +(x.getAttribute('fontId') || 0), fill: +(x.getAttribute('fillId') || 0), h: al && al.getAttribute('horizontal'), wrap: al && al.getAttribute('wrapText') === '1' }); });
      }
      var sheets = kids(wb, 'sheet').map(function(s, k){
        var t = rels[s.getAttribute('r:id')] || '';
        return { name: s.getAttribute('name'), state: s.getAttribute('state') || 'visible', path: t.charAt(0) === '/' ? t.slice(1) : 'xl/' + t.replace(/^\.\//, ''), idx: k };
      });
      kids(wb, 'definedName').forEach(function(d){ if (d.getAttribute('name') === '_xlnm.Print_Area' && d.getAttribute('localSheetId') != null){ var sh = sheets[+d.getAttribute('localSheetId')]; if (sh) sh.pa = d.textContent; } });
      // the field app marks its saves "recalculate on open"; Excel clears that when it saves, so a sheet still carrying it was never crunched
      var calc = wb.getElementsByTagName('calcPr')[0], raw = !!(calc && calc.getAttribute('fullCalcOnLoad') === '1');
      return { z: z, sheets: sheets, ss: ss, st: st, cache: {}, raw: raw };
    });
  });
}
function parseSheet(book, sh){
  if (book.cache[sh.name]) return Promise.resolve(book.cache[sh.name]);
  return book.z.file(sh.path).async('string').then(function(s){
    var d = xml(s), out = { cells: {}, hr: {}, hc: {}, w: {}, merges: [], maxR: 0, maxC: 0 };
    kids(d, 'col').forEach(function(c){ for (var i = +c.getAttribute('min'); i <= +c.getAttribute('max'); i++){ if (c.getAttribute('hidden') === '1') out.hc[i] = 1; if (c.getAttribute('width')) out.w[i] = +c.getAttribute('width'); } });
    kids(d, 'row').forEach(function(r){
      var rn = +r.getAttribute('r'); if (r.getAttribute('hidden') === '1') out.hr[rn] = 1;
      kids(r, 'c').forEach(function(c){
        var ref = splitRef(c.getAttribute('r')); if (!ref) return;
        var t = c.getAttribute('t'), vEl = c.getElementsByTagName('v')[0], v = vEl ? vEl.textContent : null, val;
        if (t === 's') val = book.ss[+v]; else if (t === 'inlineStr'){ val = kids(c, 't').map(function(x){ return x.textContent; }).join(''); }
        else if (t === 'str' || t === 'e') val = v; else if (t === 'b') val = v === '1' ? 'TRUE' : 'FALSE'; else val = v == null || v === '' ? null : +v;
        out.cells[ref.r + ':' + ref.c] = { v: val, s: +(c.getAttribute('s') || 0) };
        if (val != null && val !== ''){ out.maxR = Math.max(out.maxR, ref.r); out.maxC = Math.max(out.maxC, ref.c); }
      });
    });
    kids(d, 'mergeCell').forEach(function(m){ var p = m.getAttribute('ref').split(':'), a = splitRef(p[0]), b = splitRef(p[1] || p[0]); if (a && b) out.merges.push({ r1: a.r, c1: a.c, r2: b.r, c2: b.c }); });
    book.cache[sh.name] = out; return out;
  });
}
function cellVal(sd, r, c){ var x = sd.cells[r + ':' + c]; return x ? x.v : null; }
// the print area: a plain range, or OFFSET(A1,0,0,<rows in a cell>,<cols>) like the Post and Cut sheets
function printArea(sh, sd){
  var pa = sh.pa || '', m = /OFFSET\([^!]+!\$?([A-Z]+)\$?(\d+),\s*0,\s*0,\s*[^!]+!\$?([A-Z]+)\$?(\d+),\s*(\d+)\)/i.exec(pa);
  if (m){ var rows = +cellVal(sd, +m[4], colNum(m[3])) || sd.maxR; return { r1: +m[2], c1: colNum(m[1]), r2: +m[2] + rows - 1, c2: colNum(m[1]) + +m[5] - 1 }; }
  m = /!\$?([A-Z]+)\$?(\d+):\$?([A-Z]+)\$?(\d+)/.exec(pa);
  if (m) return { r1: +m[2], c1: colNum(m[1]), r2: +m[4], c2: colNum(m[3]) };
  return { r1: 1, c1: 1, r2: sd.maxR, c2: sd.maxC };
}

// ---------- number formats (fractions in 16ths like the printed sheet) ----------
var BUILTIN = { 0: 'General', 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00', 9: '0%', 10: '0.00%', 12: '# ?/?', 13: '# ??/??', 14: 'm/d/yyyy', 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy', 22: 'm/d/yyyy h:mm' };
function fmtCode(book, s){ var x = book.st.xfs[s]; if (!x) return 'General'; return book.st.fmts[x.fmt] || BUILTIN[x.fmt] || 'General'; }
function show(book, cell){
  if (!cell || cell.v == null) return '';
  var v = cell.v; if (typeof v !== 'number') return String(v);
  var code = fmtCode(book, cell.s).split(';')[0];
  if (/\?\/|#\s*\?+\/|\/\d+/.test(code) && /\//.test(code) && !/[dmy]{2}/i.test(code)){
    var dm = /\/(\d+)/.exec(code), den = dm ? +dm[1] : 16, neg = v < 0, a = Math.abs(v), n = Math.round(a * den), w = Math.floor(n / den), r = n % den;
    if (!dm && r){ var g = function(x, y){ return y ? g(y, x % y) : x; }, k = g(r, den); r /= k; den /= k; }
    return (neg ? '-' : '') + (r ? (w ? w + ' ' : '') + r + '/' + den : String(w));
  }
  if (/[dmy]{1,4}/i.test(code) && !/0/.test(code) && v > 20000){ var dt = new Date(Math.round((v - 25569) * 864e5)); return dt.toLocaleDateString([], { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' }); }
  if (/%/.test(code)) return (v * 100).toFixed((/\.(0+)/.exec(code) || ['', ''])[1].length) + '%';
  var dec = /\.(0+)/.exec(code);
  if (dec) return v.toFixed(dec[1].length);
  if (code === '0' || code === '#,##0') return String(Math.round(v));
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 10000) / 10000);
}
var THEME = ['FFFFFF', '000000', 'E7E6E6', '44546A', '4472C4', 'ED7D31', 'A5A5A5', 'FFC000', '5B9BD5', '70AD47'];
function fillCss(book, s){
  var x = book.st.xfs[s], f = x && book.st.fills[x.fill]; if (!f) return '';
  var hex;
  if (f.indexOf('theme') === 0){ var p = f.slice(5).split(':'), base = THEME[+p[0]] || 'FFFFFF', tint = +p[1] || 0; hex = base.match(/../g).map(function(h){ var c = parseInt(h, 16); c = tint > 0 ? c + (255 - c) * tint : c * (1 + tint); return ('0' + Math.round(c).toString(16)).slice(-2); }).join(''); }
  else hex = f.length === 8 ? f.slice(2) : f;
  if (/^f{6}$/i.test(hex)) return '';
  return 'background:#' + hex + ';';
}

// ---------- which sheets the shop sees ----------
var SHOP = [
  { n: 'COVER', label: 'Cover', always: 1, view: 1 },
  { n: 'POST SHEET', label: 'Posts', always: 1 },
  { n: 'CUT SHEET', label: 'Cuts', always: 1 },
  { n: 'CUSTOM POST CUT', label: 'Custom posts', has: function(sd){ return cellVal(sd, 8, 1) != null && cellVal(sd, 8, 1) !== ''; } },
  { n: 'SLEEVES', label: 'Angles', has: function(sd){ var a = String(cellVal(sd, 4, 1) || ''); return a !== '' && !/^no angled/i.test(a); } },
  { n: 'Rail to Wall', label: 'Screens · Rail to Wall', has: screenUnits },
  { n: 'Wall to Wall', label: 'Screens · Wall to Wall', has: screenUnits }
];
// privacy screens: a tab only when column A lists at least one unit number (row 7 down)
function screenUnits(sd){ for (var r = 7; r <= (sd.maxR || 60); r++){ var v = cellVal(sd, r, 1); if (v !== null && v !== '' && !isNaN(+v) && +v > 0) return true; } return false; }
var SCREEN_RE = /^(Rail|Wall) to Wall$/;
// how many units of a screen sheet are short (wide Post B, no channels) and how many are regular
function screenShort(sd){
  var pa = 0, out = { short: 0, reg: 0, size: '' }; for (var c = 1; c <= (sd.maxC || 30); c++) if (/^post a$/i.test(String(cellVal(sd, 6, c) || '').trim())) pa = c;
  for (var r = 7; r <= (sd.maxR || 60); r++){
    var u = cellVal(sd, r, 1); if (u === null || u === '' || isNaN(+u) || !(+u > 0)) continue;
    var m = pa ? String(cellVal(sd, r, pa) || '').match(/(\d+)\s*x\s*(\d+)/) : null;
    if (m){ out.short++; if (!out.size) out.size = m[1] + 'x' + m[2]; } else out.reg++;
  }
  return out;
}
// short screens: only a Post B is cut, in a wider size (the sheet shows "4x2 Post" in the Post A column)
function screenWide(sd){
  var pa = 0, seen = {}; for (var c = 1; c <= (sd.maxC || 30); c++) if (/^post a$/i.test(String(cellVal(sd, 6, c) || '').trim())) pa = c;
  if (!pa) return '';
  for (var r = 7; r <= (sd.maxR || 60); r++){ var m = String(cellVal(sd, r, pa) || '').match(/(\d+)\s*x\s*(\d+)/); if (m) seen[m[1] + 'x' + m[2]] = 1; }
  var k = Object.keys(seen); return k.length ? '<span><i>Post B</i>' + esc(k.join(' / ')) + ' wide · no Post A</span>' : '';
}
// the screen sheet's top block (job, colour, top rail, small parts) as one tidy line instead of the spreadsheet grid
function screenHead(item){
  var sd = item.sd, v = function(r, c){ var x = cellVal(sd, r, c); return x == null ? '' : String(x).trim(); };
  var parts = [[3, 4, 5], [3, 6, 7], [3, 8, 9]].map(function(a){ var n = v(a[0], a[2]); return v(a[0], a[1]) ? '<span class="sp"><b>' + esc(n === '' ? '0' : n) + '</b>' + esc(v(a[0], a[1])) + '</span>' : ''; }).join('');
  return '<div class="scrhead"><div class="scrinfo">' + (v(3, 2) ? '<span><i>Colour</i>' + esc(v(3, 2)) + '</span>' : '') + (v(4, 2) ? '<span><i>Top rail</i>' + esc(v(4, 2)) + '</span>' : '') +
    '<span><i>Type</i>' + (item.sh.name === 'Rail to Wall' ? 'Rail to wall' : 'Wall to wall') + '</span>' + screenWide(sd) + '</div>' +
    (parts ? '<div class="scrparts"><i>Small parts for the job</i>' + parts + '</div>' : '') + '</div>';
}
var SKIP = /^(INPUT|Inputs|GLASS ORDER.*|GLASS CALC|COST .*|CUSTOM POSTS|SPEC_.*|ENGINE.*|STICK CALC|LISTS|Lists|PAINT|PRICES|Paint .*|W-W Glass|R-W Glass|Sheet\d+)$/;
function shopSheets(book){
  var list = [];
  return Promise.all(SHOP.map(function(d){
    var sh = book.sheets.filter(function(s){ return s.name === d.n; })[0]; if (!sh) return null;
    return parseSheet(book, sh).then(function(sd){ if (d.always || (d.has && d.has(sd)) || (sh.state === 'visible' && !(d.has === screenUnits))) return { sh: sh, sd: sd, label: d.label, view: d.view }; return null; });
  })).then(function(a){
    list = a.filter(Boolean).map(function(it){ var fp = it.sh.name === 'POST SHEET' ? fencePosts(book, it) : null; return fp ? Object.assign({}, it, { sd: fp, sh: Object.assign({}, it.sh, { pa: '' }), fence: 1 }) : it; });
    var sp = screenPosts(list); if (sp) list.push(sp);
    // any other tab that's been un-hidden for this job and has a print area
    var extra = book.sheets.filter(function(s){ return s.state === 'visible' && s.pa && !SKIP.test(s.name) && !SHOP.some(function(d){ return d.n === s.name; }); });
    return Promise.all(extra.map(function(sh){ return parseSheet(book, sh).then(function(sd){ return { sh: sh, sd: sd, label: sh.name.charAt(0) + sh.name.slice(1).toLowerCase() }; }); })).then(function(b){ return list.concat(b); });
  });
}

// Screens on a railing cut sheet (top, inside or fascia mount): the info says "Secondary channels: 1 @ Double", meaning every glass
// channel also gets a double channel the same length. The sheet has one Channels column, so add a Double channels column with its
// own tick box right after it (it counts toward Cutting complete like the channel box).
function dblify(L, sd){
  var k = 0;
  for (var r = 1; r < L.hdr; r++) for (var c = 1; c <= 8; c++){
    if (!/^secondary channels?$/i.test(String(cellVal(sd, r, c) == null ? '' : cellVal(sd, r, c)).trim())) continue;
    for (var c2 = c + 1; c2 <= c + 6; c2++){ var m = String(cellVal(sd, r, c2) == null ? '' : cellVal(sd, r, c2)).match(/(\d+)\s*@\s*double/i); if (m){ k = +m[1]; break; } }
  }
  if (!k) return;
  var chC = L.cols.filter(function(c){ return /^channels?\b/i.test(L.txt(L.hdr, c)); })[0]; if (chC == null) return;
  var tick = L.cols[L.cols.indexOf(chC) + 1], hasTick = tick != null && L.chk && Object.keys(L.chk).some(function(key){ return +key.split(':')[1] === tick; });
  var after = hasTick ? tick : chC, dv = after + 0.3, db = after + 0.6, hc = sd.cells[L.hdr + ':' + chC] || {};
  sd.cells[L.hdr + ':' + chC] = Object.assign({}, hc, { v: String(hc.v == null ? L.txt(L.hdr, chC) : hc.v).replace(/^channels?/i, 'Glass channels') });
  sd.cells[L.hdr + ':' + dv] = Object.assign({}, hc, { v: 'Double channels' });
  L.cols.splice(L.cols.indexOf(after) + 1, 0, dv, db); L.vchk = L.vchk || {}; L.vchk[db] = 1; L.div = L.div || {}; L.div[dv] = 1;
  L.rows.forEach(function(r){
    if (r <= L.hdr) return;
    var t = L.txt(r, chC), m = t.match(/^\s*(\d+)\s*@\s*(.+)$/); if (!t || !m) return;
    var src = sd.cells[r + ':' + chC] || {};
    sd.cells[r + ':' + dv] = Object.assign({}, src, { v: (+m[1] * k) + '@ ' + m[2].trim(), t: 's', w: undefined, f: undefined });
    L.chk[r + ':' + db] = { left: dv, head: 'Double channels' };
  });
}
// ---------- fence jobs (CUT SHEET — OPEN TOP FENCE) ----------
// The fence Post Sheet lists every opening's left and right post, so a post shared by two openings looks like it's cut twice.
// The tablet rebuilds it like the railing Post Sheet from the sheet's hidden one-row-per-post list (is post / type / cut / top blk / bot blk):
// the job info with post height and block marks standing out, then 1 · Post cutting and 2 · Blocking, totals by post type.
var FENCE_TYPES = { end: 'Ends', mid: 'Mids', cor: 'Corners', corner: 'Corners', incor: 'InCors' };
function fenceType(t){ var k = String(t).trim().toLowerCase(); return FENCE_TYPES[k] || (k ? String(t).trim() : 'Posts'); }
function fenceRank(t){ var k = String(t).trim().toLowerCase(), i = ['end', 'mid', 'cor', 'incor'].indexOf(k); return i >= 0 ? Math.min(i, 2) : /^tran/.test(k) ? 3 : /^float/.test(k) ? 4 : 9; }
function fenceLabel(sd, re){
  for (var r = 1; r <= 12; r++) for (var c = 1; c <= 12; c++){
    if (!re.test(String(cellVal(sd, r, c) == null ? '' : cellVal(sd, r, c)).trim())) continue;
    for (var c2 = c + 1; c2 <= c + 6; c2++){ var x = cellVal(sd, r, c2); if (x != null && String(x).trim() !== '') return x; }
    return '';
  }
  return '';
}
function fencePosts(book, item){
  var sd = item.sd, v = function(r, c){ var x = c == null ? null : cellVal(sd, r, c); return x == null ? '' : x; }, H = null, col = {}, mc = Math.max(sd.maxC || 0, 34);
  for (var r = 1; r <= 20 && H == null; r++) for (var c = 1; c <= mc; c++) if (/^is post$/i.test(String(v(r, c)).trim())){ H = r; break; }
  if (H == null) return null;
  for (var c = 1; c <= mc; c++){ var hh = String(v(H, c)).trim().toLowerCase(); if (hh && col[hh] == null) col[hh] = c; }
  if (col.type == null || col.cut == null) return null;
  var posts = [];
  for (var r = H + 1; r <= (sd.maxR || 0); r++){
    if (+v(r, col['is post']) !== 1) continue;
    // a step post (Tran): standard blocks on the high side, the step added on the low side (helper columns low side / low top / low bot)
    // two sheet layouts: 'low side / low top / low bot', or 'other top / other bot' (the next opening's side of the post, i.e. the right)
    var ls = String(v(r, col['low side'])).trim(), lt = ls ? v(r, col['low top']) : '', lb = ls ? v(r, col['low bot']) : '';
    if (!ls && col['other top'] != null && (String(v(r, col['other top'])).trim() !== '' || String(v(r, col['other bot'])).trim() !== '')){ ls = 'Right'; lt = v(r, col['other top']); lb = v(r, col['other bot']); }
    posts.push({ type: String(v(r, col.type)).trim(), cut: +v(r, col.cut) || 0, top: v(r, col['top blk']), bot: v(r, col['bot blk']), other: ls ? '' : String(v(r, col['other side'])).trim(),
      ls: ls, lt: lt, lb: lb });
  }
  if (!posts.length) return null;
  var len = function(x){ return x === '' || x == null ? '' : typeof x === 'number' ? fmt16(x) : String(x); };
  var group = function(keyf){ var out = []; posts.forEach(function(p){ var k = keyf(p), g = out.filter(function(x){ return x.k === k; })[0]; if (!g){ g = { k: k, p: p, n: 0 }; out.push(g); } g.n++; });
    return out.sort(function(a, b){ return fenceRank(a.p.type) - fenceRank(b.p.type) || (b.p.cut - a.p.cut); }); };
  var cuts = group(function(p){ return p.type + '|' + p.cut; }), blks = group(function(p){ return p.type + '|' + p.top + '|' + p.bot + '|' + p.other + '|' + p.ls + '|' + p.lt + '|' + p.lb; });
  var hasOther = posts.some(function(p){ return p.other !== '' && p.other !== '0'; }), hasLow = posts.some(function(p){ return p.ls; });
  var N = 5 + (hasLow ? 3 : 0) + (hasOther ? 1 : 0);
  var fake = { cells: {}, hr: {}, hc: {}, w: {}, merges: [], maxR: 0, maxC: N }, R = 0, YEL = 'background:#FFF2CC;';
  var put = function(c, val, o){ fake.cells[R + ':' + c] = Object.assign({ v: val }, o || {}); };
  var same = function(f){ var a = posts.map(f).map(String); return a.every(function(x){ return x === a[0]; }) ? a[0] : null; };
  var info = function(lab, val, cls){ R++; var z = R % 2 ? '' : YEL; put(1, lab, { c: 1, css: z, cls: cls }); put(2, String(val), { c: 1, b: 1, css: z, cls: cls ? cls.replace('hilab', 'hival') : '' }); fake.merges.push({ r1: R, r2: R, c1: 2, c2: N }); };
  R++; put(1, 'POST SHEET', { b: 1 });
  [['Job', /^job:?$/i], ['Colour', /^colou?r:?$/i], ['Mount', /^mount:?$/i], ['Post', /^post( wall)?:?$/i]].forEach(function(a){ var x = fenceLabel(sd, a[1]); if (String(x).trim() !== '') info(a[0], x); });
  var ph = same(function(p){ return p.cut; });
  var stdH = fenceLabel(sd, /^std post ht:?$/i);
  info('Post height', ph != null ? len(+ph) : stdH !== '' ? len(+stdH) + ' · see Post cutting' : 'see Post cutting');
  var tb = same(function(p){ return p.top; }), bb = same(function(p){ return p.bot; });
  info('Top channel block', tb != null ? len(posts[0].top) : 'see Blocking', 'hilab');
  info('Bottom channel block', bb != null ? len(posts[0].bot) : 'see Blocking', 'hilab');
  info('Posts', posts.length, 'hilab');   // the post count is in the highlighted block too, under the channel blocks
  R++;
  R++; put(1, '1 · Post cutting');
  R++; ['Category', 'Qty', '✓', 'Cut length'].forEach(function(t, i){ put(i + 1, t, { c: 1 }); });
  cuts.forEach(function(g, i){ R++; var z = i % 2 ? YEL : ''; put(1, fenceType(g.p.type), { c: 1, b: 1, css: z }); put(2, String(g.n), { c: 1, b: 1, css: z }); put(3, '', { css: z }); put(4, len(g.p.cut), { c: 1, b: 1, css: z }); });
  R++;
  R++; put(1, '2 · Blocking');
  R++; ['Category', 'Qty', '✓', 'Top channel', 'Bottom channel'].concat(hasLow ? ['Step side', 'Step top channel', 'Step bottom channel'] : []).concat(hasOther ? ['Other side'] : []).forEach(function(t, i){ put(i + 1, t, { c: 1 }); });
  blks.forEach(function(g, i){ R++; var z = i % 2 ? YEL : '', c = 6, lo = g.p.ls ? ' hival' : '';
    put(1, fenceType(g.p.type), { c: 1, b: 1, css: z }); put(2, String(g.n), { c: 1, b: 1, css: z }); put(3, '', { css: z }); put(4, len(g.p.top), { c: 1, b: 1, css: z }); put(5, len(g.p.bot), { c: 1, b: 1, css: z });
    if (hasLow){ put(c++, g.p.ls || '', { c: 1, b: 1, css: z }); put(c++, len(g.p.lt), { c: 1, b: 1, css: z, cls: lo.trim() }); put(c++, len(g.p.lb), { c: 1, b: 1, css: z, cls: lo.trim() }); }
    if (hasOther) put(c, len(g.p.other), { c: 1, b: 1, css: z }); });
  fake.maxR = R;
  return fake;
}
// fence Cut Sheet: tick boxes like the railing (✓ per unit for assembly, and after each channel for cutting),
// the job info as a clean block above, blank rows and the post block columns (they're on the Posts tab) left out
function isFenceCut(sh, sd){ return sh.name === 'CUT SHEET' && /fence/i.test(String(cellVal(sd, 1, 1) || '')); }
function fenceify(L, sd){
  var hdr = L.rows.filter(function(r){ return /^unit$/i.test(L.txt(r, L.cols[0])); })[0]; if (hdr == null) return;
  L.hdr = hdr; L.fence = 1; L.rowTap = {}; L.chk = {}; L.div = {}; L.vchk = {}; L.vhead = {};
  L.rows = L.rows.filter(function(r){ return r <= hdr || L.cols.some(function(c){ return L.txt(r, c) !== ''; }); });
  L.cols = L.cols.filter(function(c, i){ return !i || (!/^post top to/i.test(L.txt(hdr, c)) && L.rows.some(function(r){ return r > hdr && !/^total/i.test(L.txt(r, L.cols[0])) && L.txt(r, c) !== ''; })); });
  var units = L.rows.filter(function(r){ var x = L.txt(r, L.cols[0]); return r > hdr && x !== '' && !isNaN(+x); });
  // post heights: only worth a column when some post isn't the standard height (they're all on the Posts tab)
  var std = String(fenceLabel(sd, /^std post ht:?$/i)).trim();
  L.cols = L.cols.filter(function(c){ return !/^[lr] post ht$/i.test(L.txt(hdr, c)) || units.some(function(r){ var x = L.txt(r, c); return x !== '' && x !== std; }); });
  var colOf = function(re){ return L.cols.filter(function(c){ return re.test(L.txt(hdr, c)); })[0]; };
  var box = function(valC, head){ if (valC == null) return; var v = valC + 0.5; L.cols.splice(L.cols.indexOf(valC) + 1, 0, v); L.vchk[v] = 1; units.forEach(function(r){ if (L.txt(r, valC) !== '') L.chk[r + ':' + v] = { left: valC, head: head }; }); };
  var lp = colOf(/^left post$/i);
  box(L.cols[0], 'Rail tag'); box(colOf(/^top (channel|rail)$/i), 'Top channel'); box(colOf(/^bottom channel$/i), 'Bottom channel');
  var chc = colOf(/^channels$/i); L.pnar = {}; if (chc != null) L.pnar[chc] = 1;
  // black lines before Left post, Right post and R post ht
  [lp, colOf(/^right post$/i), colOf(/^r post ht$/i)].forEach(function(c){ if (c != null) L.div[c] = 1; });
}
function fenceHead(book, item){
  var sd = item.sd, L = item.L, got = [];
  for (var r = 1; r < L.hdr; r++){
    var lab = null, lc = 0;
    for (var c = 1; c <= 14; c++){
      if (sd.hc[c]) continue;
      var t = show(book, sd.cells[r + ':' + c]).trim(); if (!t) continue;
      if (/:$/.test(t)){ lab = t.replace(/:$/, '').trim(); lc = c; continue; }
      if (lab){ got.push({ c: lc, r: r, lab: /^post top to rails?$/i.test(lab) ? 'Channel Block Heights' : /^rails$/i.test(lab) ? 'Channels' : /^post wall$/i.test(lab) ? 'Post' : /^picket (cut|length)$/i.test(lab) ? 'Picket Length' : lab, val: t }); lab = null; }
    }
  }
  got.sort(function(a, b){ return a.c - b.c || a.r - b.r; });
  // total pickets for the job (sum of the Pickets column), shown with the channel type so it's easy to find
  var pc = null; for (var ci = 1; ci <= (sd.maxC || 20) && pc == null; ci++) if (/^pickets?$/i.test(show(book, sd.cells[L.hdr + ':' + ci]).trim())) pc = ci;
  if (pc != null){
    var tot = 0, any = false;
    for (var rr = L.hdr + 1; rr <= (sd.maxR || 0); rr++){ var u = String(cellVal(sd, rr, 1) == null ? '' : cellVal(sd, rr, 1)).trim(), n = +cellVal(sd, rr, pc); if (u !== '' && !isNaN(+u) && n > 0){ tot += n; any = true; } }
    if (any) got.push({ lab: 'Number of Pickets', val: String(tot) });
  }
  // the yellow block together, two to a row, after the first row (Job / Colour)
  var HI = ['channel', 'post', 'picket length', 'number of pickets'], his = [];
  HI.forEach(function(n){ got.forEach(function(g){ if (g.lab.toLowerCase() === n) his.push(g); }); });
  got = got.filter(function(g){ return his.indexOf(g) < 0; }); got.splice.apply(got, [Math.min(2, got.length), 0].concat(his));
  var h = '<table class="sheet finfo"><tr><td colspan="4" class="b">' + esc(show(book, sd.cells['1:1']).trim() || 'CUT SHEET') + '</td></tr>';
  for (var i = 0; i < got.length; i += 2){
    var z = (i / 2) % 2 ? '' : ' style="background:#FFF2CC"', p = got[i], q = got[i + 1];
    // the channel type (3/4 Punch …) stands out like post height on the railing sheets
    var pair = function(x){ var hi = /^(channel|number of pickets|picket length|post)$/i.test(x.lab); return '<td class="c' + (hi ? ' hilab' : '') + '">' + esc(x.lab) + '</td><td class="c b' + (hi ? ' hival' : '') + '">' + esc(x.val) + '</td>'; };
    h += '<tr class="info"' + z + '>' + pair(p) + (q ? pair(q) : '<td></td><td></td>') + '</tr>';
  }
  return h + '</table>';
}

// ---------- render a sheet like the printout, with tick boxes ----------
function layout(book, item){
  var sh = item.sh, sd = item.sd, a = printArea(sh, sd);
  var rows = [], cols = [];
  for (var c = a.c1; c <= a.c2; c++) if (!sd.hc[c]) cols.push(c);
  for (var r = a.r1; r <= a.r2; r++) if (!sd.hr[r]) rows.push(r);
  var txt = function(r, c){ return show(book, sd.cells[r + ':' + c]).trim(); };
  while (rows.length && !cols.some(function(c){ return txt(rows[rows.length - 1], c) !== ''; })) rows.pop();
  // drop columns that only hold a heading (e.g. Slope on a job with no sloped rails), so the sheet fits the tablet
  var inMerge = function(r, c){ return sd.merges.some(function(m){ return r >= m.r1 && r <= m.r2 && c >= m.c1 && c <= m.c2 && (m.c2 > m.c1); }); };
  cols = cols.filter(function(c){ var n = rows.filter(function(r){ return txt(r, c) !== '' && !inMerge(r, c); }).length; return n > 1 || rows.some(function(r){ return txt(r, c) === '✓'; }) || rows.some(function(r){ return inMerge(r, c); }) && n > 0; });
  // and under the column-heading row (the one with ✓s): a named column with nothing below it is hidden, so Slope only shows on jobs that have slopes
  var hr0 = rows.filter(function(r){ return cols.some(function(c){ return txt(r, c) === '✓'; }); })[0];
  if (hr0 != null) cols = cols.filter(function(c){ var h = txt(hr0, c); return h === '' || h === '✓' || rows.some(function(r){ return r > hr0 && txt(r, c) !== '' && !inMerge(r, c); }); });
  // tick columns: a header cell that says ✓ makes its column below tickable, down to the next blank row
  var chk = {}, any = false;
  rows.forEach(function(r, ri){
    cols.forEach(function(c){
      if (txt(r, c) !== '✓') return;
      var ci = cols.indexOf(c), left = cols[ci - 1], head = left ? txt(r, left) : '';
      for (var k = ri + 1; k < rows.length; k++){
        var rr = rows[k]; if (!cols.some(function(cc){ return txt(rr, cc) !== ''; })) break;
        // stop at the next section: another ✓ heading row or a numbered heading (2 · Blocking…)
        if (cols.some(function(cc){ return txt(rr, cc) === '✓'; }) || /^\d+\s*[·.\-]\s*[A-Za-z]/.test(txt(rr, cols[0]))) break;
        // the ✓ ticks the cell to its left (Top rail, Channels, Qty…); skip total lines
        if (/^total/i.test(txt(rr, cols[0]))) continue;
        if (left && txt(rr, left) !== ''){ chk[rr + ':' + c] = { left: left, head: head }; any = true; }
      }
    });
  });
  var bold = function(r, c){ var x = sd.cells[r + ':' + c], xf = x && book.st.xfs[x.s], f = xf && book.st.fonts[xf.font]; return !!(f && f.b); };
  // sheets without ✓ columns: a data row (2+ values, not a bold heading) can be tapped as a whole
  var rowTap = {};
  if (!any && !item.view) rows.forEach(function(r){ var n = cols.filter(function(c){ return txt(r, c) !== ''; }).length; if (n >= 2 && !bold(r, cols[0]) && !cols.some(function(c){ return /^(unit|tag|post #|corner)/i.test(txt(r, c)) && bold(r, c); })) rowTap[r] = 1; });
  // the column-heading row (Rail tag / ✓ / Top rail …): everything above it is the job info block
  var hdr = null;
  rows.some(function(r){ if (cols.some(function(c){ return txt(r, c) === '✓'; })) { hdr = r; return true; } return false; });
  if (hdr == null){ var firstTap = rows.filter(function(r){ return rowTap[r]; })[0]; if (firstTap != null){ var i = rows.indexOf(firstTap); for (var q = i - 1; q >= 0; q--) if (cols.filter(function(c){ return txt(rows[q], c) !== ''; }).length >= 2){ hdr = rows[q]; break; } } }
  var L = { a: a, rows: rows, cols: cols, chk: chk, rowTap: rowTap, txt: txt, hdr: hdr };
  if (SCREEN_RE.test(sh.name) && hdr != null) screenify(L, sd);
  if (isFenceCut(sh, sd)) fenceify(L, sd);
  if (sh.name === 'CUT SHEET' && !L.fence && hdr != null) dblify(L, sd);
  return L;
}
// privacy screen sheets: posts are cut from the Posts tab, so they're left off here. Each screen needs a bottom channel
// and a double channel (between the two glass panes), the same length and count as the sheet's Channels; each gets its own ✓ box.
function screenify(L, sd){
  L.rowTap = {}; L.div = {}; L.vchk = {};
  var units = L.rows.filter(function(r){ var v = L.txt(r, L.cols[0]); return r > L.hdr && v !== '' && !isNaN(+v); });
  var cols = L.cols.slice(), next = function(c){ return cols[cols.indexOf(c) + 1]; }, isAmt = function(c){ return c != null && /^(amt|qty)$/i.test(L.txt(L.hdr, c)); };
  var put = function(key, cell){ if (cell) sd.cells[key] = cell; };
  cols.forEach(function(c){
    var h = L.txt(L.hdr, c); if (!/^(top rail|post [a-z]|channels?|bottom channel)$/i.test(h)) return;   // (Bottom channel: already split on an earlier pass)
    var amt = isAmt(next(c)) ? next(c) : c;
    if (/^post/i.test(h)){ L.cols = L.cols.filter(function(x){ return x !== c && x !== amt; }); return; }
    L.div[c] = 1;
    var box = function(v, valC, amtC, head){ L.cols.splice(L.cols.indexOf(amtC) + 1, 0, v); L.vchk[v] = 1; units.forEach(function(r){ if (L.txt(r, valC) !== '') L.chk[r + ':' + v] = { left: amtC, left2: valC, head: head }; }); };
    if (/^(channel|bottom channel)/i.test(h)){
      if (!units.some(function(r){ return L.txt(r, c) !== ''; })){ L.cols = L.cols.filter(function(x){ return x !== c && x !== amt; }); delete L.div[c]; return; }
      var hc = sd.cells[L.hdr + ':' + c];
      put(L.hdr + ':' + c, Object.assign({}, hc, { v: 'Bottom channel' }));
      var dv = amt + 0.6, da = amt + 0.7;
      put(L.hdr + ':' + dv, Object.assign({}, hc, { v: 'Double channel' })); put(L.hdr + ':' + da, sd.cells[L.hdr + ':' + amt]);
      units.forEach(function(r){ put(r + ':' + dv, sd.cells[r + ':' + c]); put(r + ':' + da, sd.cells[r + ':' + amt]); });
      box(amt + 0.5, c, amt, 'Bottom channel');
      L.cols.splice(L.cols.indexOf(amt + 0.5) + 1, 0, dv, da); L.div[dv] = 1;
      box(amt + 0.8, dv, da, 'Double channel');
      return;
    }
    box(amt + 0.5, c, amt, h);
  });
  // assembly: one "Assembled" box per screen at the end of the row (Assembly complete is tied to these)
  var va = Math.max.apply(null, cols) + 0.9; L.cols.push(va); L.vchk[va] = 1; L.vhead = L.vhead || {}; L.vhead[va] = 'Assembled'; L.div[va] = 1;
  units.forEach(function(r){ L.chk[r + ':' + va] = { left: cols[0], head: 'Assembled' }; });
}
// privacy screen drawing for the Posts tab: which piece is Post A, B and C
// A = upright at the deck edge against the railing · C = the horizontal post along the bottom (the bottom channel fastens to it) · B = upright standing on C at the wall
// units with an extra Post B in the middle: the Post B amount is more than the usual (1 rail to wall, 2 wall to wall)
function screenMid(sd, base){
  var pb = 0, out = { mid: 0, reg: 0 };
  for (var c = 1; c <= (sd.maxC || 30); c++) if (/^post b$/i.test(String(cellVal(sd, 6, c) || '').trim()) && /^amt$/i.test(String(cellVal(sd, 6, c + 1) || '').trim())) pb = c + 1;
  if (!pb) return out;
  for (var r = 7; r <= (sd.maxR || 60); r++){
    var u = cellVal(sd, r, 1); if (u === null || u === '' || isNaN(+u) || !(+u > 0)) continue;
    if (+cellVal(sd, r, pb) > base) out.mid++; else out.reg++;
  }
  return out;
}
function screenDiagram(kinds){
  var one = function(rw, midB){
    var W = 360, dk = 226, top = 34, ink = '#1F1B17', ch = '#E8590C', o = '';
    // with a middle Post B the rail to wall drawing gets wider so both glass panels have room
    var xA = rw ? (midB ? 84 : 140) : null, wallR = 318, wallL = rw ? null : 26;   // rail to wall: drawn narrower, closer to a real screen's shape
    // the top rail and Post C run right to the wall (their clips screw to it); Post B stands about 2 1/2" off the wall
    var G = 16, wfR = wallR, wfL = rw ? null : wallL + 14, xr = wfR - 5, xl = rw ? null : wfL + 5;
    var xB = wfR - G - 12, xBL = rw ? null : wfL + G, x0 = rw ? xA + 12 : xl;
    var lbl = function(x, y, t){ return '<circle cx="' + x + '" cy="' + y + '" r="13" fill="' + ink + '"/><text x="' + x + '" y="' + (y + 5) + '" text-anchor="middle" font-size="15" font-weight="900" fill="#fff">' + t + '</text>'; };
    var note = function(x, y, t, a){ return '<text x="' + x + '" y="' + y + '" font-size="11" font-weight="700" fill="#6B6157"' + (a ? ' text-anchor="' + a + '"' : '') + '>' + t + '</text>'; };
    // the deck stops at its edge, where the railing stands (rail to wall); wall to wall it runs between the walls
    var dx0 = rw ? xA - 22 : wallL - 12, dx1 = wallR + 26;
    o += '<rect x="' + dx0 + '" y="' + dk + '" width="' + (dx1 - dx0) + '" height="10" fill="#D9D0C3"/>' + note(dx0 + 4, dk + 22, 'DECK');
    o += '<rect x="' + wallR + '" y="10" width="26" height="' + (dk - 10) + '" fill="url(#hatch)" stroke="#9A9087"/>' + note(wallR + 13, 8, 'WALL', 'middle');
    if (!rw) o += '<rect x="' + (wallL - 12) + '" y="10" width="26" height="' + (dk - 10) + '" fill="url(#hatch)" stroke="#9A9087"/>' + note(wallL + 1, 8, 'WALL', 'middle');
    // the railing runs at right angles to the screen, so here it's seen end-on: its top rail and a post, tight to Post A
    if (rw) o += '<rect x="' + (xA - 20) + '" y="110" width="20" height="10" rx="2" fill="#B9AFA4" stroke="#8C8279"/><rect x="' + (xA - 14) + '" y="120" width="8" height="' + (dk - 120) + '" fill="#CFC6BB" stroke="#9A9087"/>' +
      note(xA - 64, 90, 'RAILING') + note(xA - 64, 102, '(end view)');   // about 42" on the 72" screen
    // top rail over the uprights, Post C up off the deck (clearance underneath), Post B standing on C, Post A down to the deck
    var tr = 9, yC = dk - 28, xL = rw ? xA : xl;
    o += '<rect x="' + xL + '" y="' + top + '" width="' + (xr - xL) + '" height="' + tr + '" rx="2" fill="#8C8279"/>';
    o += '<rect x="' + x0 + '" y="' + yC + '" width="' + (xr - x0) + '" height="12" fill="' + ink + '"/>';
    o += '<rect x="' + xB + '" y="' + (top + tr) + '" width="12" height="' + (yC - top - tr) + '" fill="' + ink + '"/>';
    if (rw) o += '<rect x="' + xA + '" y="' + (top + tr) + '" width="12" height="' + (dk - top - tr) + '" fill="' + ink + '"/>';
    else o += '<rect x="' + xBL + '" y="' + (top + tr) + '" width="12" height="' + (yC - top - tr) + '" fill="' + ink + '"/>';
    // clearance mark near the start of Post C, clear of the C and F markers
    var mx = rw ? xA + 22 : xBL + 56;
    o += '<g stroke="#6B6157" stroke-width="1.2"><line x1="' + mx + '" y1="' + (yC + 14) + '" x2="' + mx + '" y2="' + (dk - 1) + '"/><line x1="' + (mx - 5) + '" y1="' + (yC + 14) + '" x2="' + (mx + 5) + '" y2="' + (yC + 14) + '"/><line x1="' + (mx - 5) + '" y1="' + (dk - 1) + '" x2="' + (mx + 5) + '" y2="' + (dk - 1) + '"/></g><text x="' + (mx + 8) + '" y="' + (dk - 4) + '" font-size="10" font-weight="700" fill="#6B6157">CLEARANCE</text>';
    // clips: a tongue inside the end of the rail or Post C, and a plate screwed to the wall face.
    // top rail sleeve clip: plate goes DOWN (no screws above the rail) · screen foot: plate goes UP (no screws below)
    // each clip: a short plate (about 2") with one screw through it into the wall, seen from the side here
    var clip = function(y, h, py, ph, sy, wf, dir){ var fc = '#2F5D50', end = wf - dir * 5, a = dir > 0 ? end - 14 : end, sx = dir > 0 ? wf - 7 : wf + 7;
      return '<rect x="' + a + '" y="' + y + '" width="14" height="' + h + '" fill="#2F5D50" fill-opacity=".55" stroke="' + fc + '" stroke-width="1.2"/>' +
        '<rect x="' + (dir > 0 ? wf - 5 : wf) + '" y="' + py + '" width="5" height="' + ph + '" fill="' + fc + '"/>' +
        '<line x1="' + sx + '" y1="' + sy + '" x2="' + (wf + dir * 9) + '" y2="' + sy + '" stroke="' + ink + '" stroke-width="1.6"/><rect x="' + (sx - 1.5) + '" y="' + (sy - 3) + '" width="3" height="6" fill="' + ink + '"/>'; };
    // top rail sleeve clip: plate runs 2" DOWN from the rail · screen foot: plate runs 2" UP from Post C
    var clips = function(wf, dir){ return clip(top + 2, 5, top, tr + 6, top + tr + 3, wf, dir) + clip(yC + 3, 6, yC - 6, 18, yC - 3, wf, dir); };
    // the 2 1/2" from Post B to the wall
    var gap = function(a, b){ var y = 162; return '<g stroke="#6B6157" stroke-width="1.2"><line x1="' + a + '" y1="' + y + '" x2="' + b + '" y2="' + y + '"/><line x1="' + a + '" y1="' + (y - 4) + '" x2="' + a + '" y2="' + (y + 4) + '"/><line x1="' + b + '" y1="' + (y - 4) + '" x2="' + b + '" y2="' + (y + 4) + '"/></g><text x="' + ((a + b) / 2) + '" y="' + (y - 6) + '" text-anchor="middle" font-size="10" font-weight="800" fill="#6B6157">2½"</text>'; };
    o += clips(wfR, 1) + gap(xB + 12, wfR); if (!rw) o += clips(wfL, -1) + gap(wfL, xBL);
    var fl = function(x, y, t){ return '<circle cx="' + x + '" cy="' + y + '" r="9" fill="#2F5D50"/><text x="' + x + '" y="' + (y + 4) + '" text-anchor="middle" font-size="11" font-weight="900" fill="#fff">' + t + '</text>'; };
    var gx0 = rw ? xA + 12 : xBL + 12, gx1 = xB, mid = 120, xM = midB ? Math.round((gx0 + gx1) / 2 - 6) : null;
    var panel = function(a, b){
      return '<rect x="' + a + '" y="' + (top + tr + 2) + '" width="' + (b - a) + '" height="' + (mid - top - tr - 4) + '" fill="#CFE3EE" stroke="#9DBBCB"/>' +
        '<rect x="' + a + '" y="' + mid + '" width="' + (b - a) + '" height="9" fill="' + ch + '"/>' +                                       // double channel
        '<rect x="' + a + '" y="' + (mid + 11) + '" width="' + (b - a) + '" height="' + (yC - mid - 20) + '" fill="#CFE3EE" stroke="#9DBBCB"/>' +
        '<rect x="' + a + '" y="' + (yC - 8) + '" width="' + (b - a) + '" height="8" fill="' + ch + '"/>'; };                               // bottom channel
    if (midB) o += panel(gx0, xM) + panel(xM + 12, gx1) + '<rect x="' + xM + '" y="' + (top + tr) + '" width="12" height="' + (yC - top - tr) + '" fill="' + ink + '"/>';
    else o += panel(gx0, gx1);
    o += fl(xB - 12, top + 22, 'T') + fl(xB - 2, yC + 22, 'F'); if (!rw) o += fl(xBL + 24, top + 22, 'T') + fl(xBL + 14, yC + 22, 'F');
    var cx = midB ? (gx0 + xM) / 2 : (gx0 + gx1) / 2;
    o += '<text x="' + cx + '" y="' + (top - 5) + '" text-anchor="middle" font-size="11" font-weight="800" fill="#6B6157">TOP RAIL</text>';
    var cfs = midB ? 9 : 11;   // narrower panels either side of a middle Post B
    o += '<text x="' + cx + '" y="' + (mid - 4) + '" text-anchor="middle" font-size="' + cfs + '" font-weight="800" fill="' + ch + '">DOUBLE CHANNEL</text>';
    o += '<text x="' + cx + '" y="' + (yC - 12) + '" text-anchor="middle" font-size="' + cfs + '" font-weight="800" fill="' + ch + '">BOTTOM CHANNEL</text>';
    if (rw) o += lbl(xA + 6, 72, 'A');
    o += lbl(xB + 6, 72, 'B') + lbl(midB ? (xM + 12 + gx1) / 2 : cx + 46, yC + 6, 'C');   // C label sits on the post
    if (!rw) o += lbl(xBL + 6, 72, 'B');
    if (midB) o += lbl(xM + 6, 72, 'B');
    return '<figure class="scrfig"><svg viewBox="0 0 360 250" role="img" aria-label="' + (rw ? 'Rail to wall' : 'Wall to wall') + ' privacy screen' + (midB ? ' with a middle Post B' : '') + ': which piece is Post A, B and C"><defs><pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="#EFE9E1"/><line x1="0" y1="0" x2="0" y2="6" stroke="#B9AFA4" stroke-width="2"/></pattern></defs>' + o + '</svg>' +
      '<figcaption><b>' + (rw ? 'Rail to wall' : 'Wall to wall') + (midB ? ' · middle Post B' : '') + '</b>' + (rw ? '<span><i>A</i> upright at the deck edge, against the railing</span>' : '') + '<span><i>B</i> upright standing on Post C' + (rw ? ' at the wall' : ', one at each wall') + (midB ? ', plus one in the middle with a glass panel and channels on each side' : '') + '</span><span><i>C</i> along the bottom, up off the deck; the bottom channel fastens to it</span><span><i>&#8593;</i>top rail runs over the uprights; top rail and Post C run right to the wall, Post B stands 2½" off it</span><span><i style="background:#2F5D50">T</i>top rail sleeve clip</span><span><i style="background:#2F5D50">F</i>screen foot</span></figcaption></figure>';
  };
  // short rail to wall: too short for glass channel, so no Post A, no Post C and no channels. One wide Post B (6x2, 4x2 … from the sheet)
  // between two top rails, one along the top and one along the bottom; both run to the wall on clips like the others
  var short = function(size){
    var dk = 226, top = 34, tr = 9, ink = '#1F1B17', o = '', wallR = 262, xr = wallR - 5, yC = dk - 28, BW = /^[46]x/.test(size || '6x2') ? 24 : 12, xB = wallR - 16 - BW, xA = xB;   // same 2 1/2" gap to the wall as the other drawings
    var lbl = function(x, y, t){ return '<circle cx="' + x + '" cy="' + y + '" r="13" fill="' + ink + '"/><text x="' + x + '" y="' + (y + 5) + '" text-anchor="middle" font-size="15" font-weight="900" fill="#fff">' + t + '</text>'; };
    var note = function(x, y, t, a, col){ return '<text x="' + x + '" y="' + y + '" font-size="11" font-weight="800" fill="' + (col || '#6B6157') + '"' + (a ? ' text-anchor="' + a + '"' : '') + '>' + t + '</text>'; };
    var fl = function(x, y, t){ return '<circle cx="' + x + '" cy="' + y + '" r="9" fill="#2F5D50"/><text x="' + x + '" y="' + (y + 4) + '" text-anchor="middle" font-size="11" font-weight="900" fill="#fff">' + t + '</text>'; };
    o += '<rect x="' + (xB - 20) + '" y="' + dk + '" width="' + (wallR + 26 - xB + 20) + '" height="10" fill="#D9D0C3"/>' + note(xB - 20, dk + 22, 'DECK');
    o += '<rect x="' + wallR + '" y="10" width="26" height="' + (dk - 10) + '" fill="url(#hatch)" stroke="#9A9087"/>' + note(wallR + 13, 8, 'WALL', 'middle');
    o += '<rect x="' + (xB - 20) + '" y="110" width="20" height="10" rx="2" fill="#B9AFA4" stroke="#8C8279"/><rect x="' + (xB - 14) + '" y="120" width="8" height="' + (dk - 120) + '" fill="#CFC6BB" stroke="#9A9087"/>' +
      note(xB - 32, 112, 'RAILING', 'end') + note(xB - 32, 124, '(end view)', 'end');
    // the two top rails: one on top, one along the bottom up off the deck (clearance underneath)
    o += '<rect x="' + xB + '" y="' + top + '" width="' + (xr - xB) + '" height="' + tr + '" rx="2" fill="#8C8279"/>';
    o += '<rect x="' + xB + '" y="' + yC + '" width="' + (xr - xB) + '" height="' + tr + '" rx="2" fill="#8C8279"/>';
    // the wide Post B between them, 2 1/2" off the wall
    o += '<rect x="' + xB + '" y="' + (top + tr) + '" width="' + BW + '" height="' + (yC - top - tr) + '" fill="' + ink + '"/>';
    var mx = xB + BW / 2;
    o += '<g stroke="#6B6157" stroke-width="1.2"><line x1="' + mx + '" y1="' + (yC + tr + 2) + '" x2="' + mx + '" y2="' + (dk - 1) + '"/><line x1="' + (mx - 5) + '" y1="' + (yC + tr + 2) + '" x2="' + (mx + 5) + '" y2="' + (yC + tr + 2) + '"/><line x1="' + (mx - 5) + '" y1="' + (dk - 1) + '" x2="' + (mx + 5) + '" y2="' + (dk - 1) + '"/></g>' + note(xB - 22, dk - 4, 'CLEARANCE', 'end');
    // clips at the wall: top rail sleeve clip plate down, the bottom rail's clip plate up
    var clip = function(y, h, py, ph, sy){ var fc = '#2F5D50', wf = wallR, end = wf - 5, a = end - 14, sx = wf - 7;
      return '<rect x="' + a + '" y="' + y + '" width="14" height="' + h + '" fill="#2F5D50" fill-opacity=".55" stroke="' + fc + '" stroke-width="1.2"/><rect x="' + (wf - 5) + '" y="' + py + '" width="5" height="' + ph + '" fill="' + fc + '"/>' +
        '<line x1="' + sx + '" y1="' + sy + '" x2="' + (wf + 9) + '" y2="' + sy + '" stroke="' + ink + '" stroke-width="1.6"/><rect x="' + (sx - 1.5) + '" y="' + (sy - 3) + '" width="3" height="6" fill="' + ink + '"/>'; };
    o += clip(top + 2, 5, top, tr + 6, top + tr + 3) + clip(yC + 2, 5, yC - 6, tr + 6, yC - 3);
    var gy = 162, ga = xB + BW, gb = wallR;
    o += '<g stroke="#6B6157" stroke-width="1.2"><line x1="' + ga + '" y1="' + gy + '" x2="' + gb + '" y2="' + gy + '"/><line x1="' + ga + '" y1="' + (gy - 4) + '" x2="' + ga + '" y2="' + (gy + 4) + '"/><line x1="' + gb + '" y1="' + (gy - 4) + '" x2="' + gb + '" y2="' + (gy + 4) + '"/></g><text x="' + (xB - 8) + '" y="' + (gy + 4) + '" text-anchor="end" font-size="10" font-weight="800" fill="#6B6157">2½" to wall</text>';
    o += fl(xB - 14, top + 24, 'T') + fl(xB - 14, yC - 14, 'T');
    o += note(wallR - 2, top - 5, 'TOP RAIL', 'end') + note(xB - 30, yC - 5, 'TOP RAIL', 'end') + note(xB - 30, yC + 7, '(BOTTOM)', 'end');
    o += '<text x="' + (xB - 8) + '" y="' + 96 + '" text-anchor="end" font-size="22" font-weight="900" fill="' + ink + '">B</text>';
    return '<figure class="scrfig"><svg viewBox="0 0 360 250" role="img" aria-label="Short rail to wall privacy screen: one wide Post B between two top rails"><defs><pattern id="hatch2" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="#EFE9E1"/><line x1="0" y1="0" x2="0" y2="6" stroke="#B9AFA4" stroke-width="2"/></pattern></defs>' + o.replace(/url\(#hatch\)/g, 'url(#hatch2)') + '</svg>' +
      '<figcaption><b>Short rail to wall</b><span><i>B</i>one post (' + esc(size || '6x2') + ' on this job), up against the railing, between the two top rails</span><span><i>&#8593;</i>two top rails from Post B to the wall: one along the top, one along the bottom up off the deck, both on clips at the wall</span><span><i>&#8212;</i>for a very small gap between the railing and the wall: no Post A, no Post C, no channels</span><span><i style="background:#2F5D50">T</i>top rail sleeve clip</span></figcaption></figure>';
  };
  var regRW = kinds.indexOf('Rail to Wall') >= 0 && !(kinds.short && !kinds.short.reg);
  var mRW = kinds.midRW || { mid: 0, reg: 1 }, mWW = kinds.midWW || { mid: 0, reg: 1 }, hasWW = kinds.indexOf('Wall to Wall') >= 0;
  return '<div class="scrfigs">' + (regRW && (mRW.reg - (kinds.short ? kinds.short.short : 0) > 0 || !mRW.mid) ? one(true) : '') + (regRW && mRW.mid ? one(true, true) : '') +
    (kinds.short && kinds.short.short ? short(kinds.short.size) : '') + (hasWW && (mWW.reg || !mWW.mid) ? one(false) : '') + (hasWW && mWW.mid ? one(false, true) : '') + '</div>';
}
// privacy screens: one Posts tab for the whole job, every post length with how many and which units, like the Post Sheet
function screenPosts(list){
  var rows = [], fake = { cells: {}, hr: {}, hc: {}, w: {}, merges: [], maxR: 0, maxC: 5 }, put = function(r, c, v){ fake.cells[r + ':' + c] = { v: v }; };
  list.forEach(function(it){
    if (!SCREEN_RE.test(it.sh.name)) return;
    var sd = it.sd, H = 6, typ = it.sh.name === 'Rail to Wall' ? 'R–W' : 'W–W';
    for (var c = 1; c <= (sd.maxC || 30); c++){
      var h = String(cellVal(sd, H, c) || '').trim(); if (!/^post [a-z]$/i.test(h)) continue;
      for (var r = H + 1; r <= (sd.maxR || 60); r++){
        var u = cellVal(sd, r, 1), len = cellVal(sd, r, c), n = +cellVal(sd, r, c + 1) || 1, label = h.replace(/^post/i, 'Post');
        if (u == null || u === '' || isNaN(+u) || len == null || len === '') continue;
        // short rail-to-wall screens (no channels, 2 top rails): the sheet puts a post size ("4x2 Post") in Post A. No Post A is cut;
        // the one post cut is Post B, in that wider size
        if (/^post a$/i.test(h) && /\d+\s*x\s*\d+/.test(String(len))) continue;
        if (/^post b$/i.test(h)){
          for (var c2 = 1; c2 <= (sd.maxC || 30); c2++) if (/^post a$/i.test(String(cellVal(sd, H, c2) || '').trim())){
            var wide = String(cellVal(sd, r, c2) || '').match(/(\d+)\s*x\s*(\d+)/); if (wide) label = 'Post B · ' + wide[1] + 'x' + wide[2] + ' wide';
          }
        }
        if (!(+len > 0)) continue;
        var key = label + '|' + (+len), row = rows.filter(function(x){ return x.key === key; })[0];
        if (!row){ row = { key: key, post: label, len: +len, qty: 0, units: [] }; rows.push(row); }
        var ul = String(u) + (list.filter(function(x){ return SCREEN_RE.test(x.sh.name); }).length > 1 ? ' ' + typ : '');
        row.qty += n; if (row.units.indexOf(ul) < 0) row.units.push(ul);
      }
    }
  });
  if (!rows.length) return null;
  var many = list.filter(function(x){ return SCREEN_RE.test(x.sh.name); }).length > 1, all = {};
  list.forEach(function(it){ if (!SCREEN_RE.test(it.sh.name)) return; var t = it.sh.name === 'Rail to Wall' ? 'R–W' : 'W–W', a = [];
    for (var r = 7; r <= (it.sd.maxR || 60); r++){ var u = cellVal(it.sd, r, 1); if (u !== null && u !== '' && !isNaN(+u) && +u > 0) a.push(String(u) + (many ? ' ' + t : '')); } all[t] = a; });
  rows.forEach(function(x){
    var parts = []; Object.keys(all).forEach(function(t){ var a = all[t], mine = x.units.filter(function(u){ return a.indexOf(u) >= 0; });
      if (!mine.length) return; parts.push(mine.length === a.length && a.length > 1 ? 'All ' + (many ? t + ' ' : '') + 'units (' + a.length + ')' : mine.join(', ')); });
    x.unitText = parts.join(' · ');
  });
  rows.sort(function(a, b){ return a.post < b.post ? -1 : a.post > b.post ? 1 : b.len - a.len; });
  ['Post', 'Qty', 'Length', '✓', 'For units'].forEach(function(t, i){ put(1, i + 1, t); });
  var map = {}; rows.forEach(function(x, i){ map[x.key] = i + 2; });
  rows.forEach(function(x, i){ put(i + 2, 1, x.post); put(i + 2, 2, String(x.qty)); put(i + 2, 3, fmt16(x.len)); put(i + 2, 5, x.unitText || x.units.join(', ')); });
  fake.maxR = rows.length + 1;
  var kinds = list.filter(function(x){ return SCREEN_RE.test(x.sh.name); }).map(function(x){ return x.sh.name; });
  return { kinds: kinds, sh: { name: 'SCREEN POSTS', pa: "'SCREEN POSTS'!$A$1:$E$" + fake.maxR, state: 'visible' }, sd: fake, label: 'Posts', virt: 1, map: map };
}
function itemKeys(item){ var L = item.L; return Object.keys(L.chk).filter(function(k){ return !L.chk[k].opt; }).map(function(k){ return 'c' + k; }).concat(Object.keys(L.rowTap).map(function(r){ return 'r' + r; })); }
// measurements: big whole numbers with a small stacked fraction, like reading a tape
function measure(t){
  return esc(t).replace(/(\d+)\s*\/\s*(\d+)/g, '<span class="fr"><sup>$1</sup><span class="sl">/</span><sub>$2</sub></span>').replace(/@\s*/g, '<span class="at">@</span>');
}
// units as entered in the field (INPUT tab), for the layout drawings
// a remake: only the rows (and boxes) of the chosen rail tags are kept
function remakeTrim(L, tags){
  if (L.hdr == null) return;
  var keep = function(r){ return r <= L.hdr || tags.indexOf(L.txt(r, L.cols[0]).trim()) >= 0; };
  L.rows = L.rows.filter(keep);
  Object.keys(L.chk).forEach(function(k){ if (!keep(+k.split(':')[0])) delete L.chk[k]; });
  Object.keys(L.rowTap || {}).forEach(function(r){ if (!keep(+r)) delete L.rowTap[r]; });
}
function remakeDone(rm){
  var next = remakes.filter(function(x){ return x.id !== rm.id; }); if (next.length === remakes.length) return;
  remakes = next; lsSet('shop-remakes', remakes);
  toast('✓ Remake ' + rm.tags.join(', ') + ' done');
  api('remakeset', { remakes: next }).catch(function(){});
  if (prio.indexOf('rm' + rm.id) >= 0){ prio = prio.filter(function(id){ return id !== 'rm' + rm.id; }); lsSet('shop-prio', prio); api('prioset', { prio: prio }).catch(function(){}); }
}
function unitOf(tag){ return String(tag == null ? '' : tag).trim().replace(/\.\d+$/, ''); }
function readUnits(sd){
  var mount = String(cellVal(sd, 7, 2) || 'Fascia'), out = {};
  for (var r = 20; r <= 119; r++){
    var tag = cellVal(sd, r, 1); if (tag == null || tag === '') continue;
    var g = function(c){ var v = cellVal(sd, r, c); return v == null ? '' : v; };
    var u = unitOf(tag); if (!out[u]) out[u] = { unit: u, mount: mount, secs: [] };
    out[u].secs.push({ tag: String(tag), l: String(g(2)), r: String(g(3)), fl: g(4), fr: g(5), len: g(6), mids: g(9), al: g(17), ar: g(18), ns: String(g(19)) });
  }
  return out;
}
// block height from INPUT: B13 is the block height (38 5/16 standard), D13 an override, D14 the list when units differ
var STD_BLOCK = 38.3125;
function fmt16(v){ var n = Math.round(v * 16), w = Math.floor(n / 16), f = n % 16, g = 16; while (f && f % 2 === 0){ f /= 2; g /= 2; } return w + (f ? ' ' + f + '/' + g : ''); }
// base plate codes in plain words: Cen = centred on the plate, Off = offset (post not centred), Rev = reverse offset.
// Plates: 4x4 for 2x2 posts. (3x2 posts are left out for now.)
function bpDesc(code){
  var c = String(code || '').trim(), size = '4x4';
  // base plate codes only (E-Off-L, Mid-Cen, EC-Cen…); fascia bracket codes (SFL, ECR, FCL…) and 3x2 posts are left alone
  if (!/^(E|EC|IC|Mid|Joint|T|W|6EP)-/i.test(c)) return '';
  var how = /-Rev-/i.test(c) ? 'reverse offset' : /-Off-/i.test(c) ? 'offset' : /-Cen\b/i.test(c) ? 'centred' : '';
  return size + ' plate' + (how ? ' · ' + how : '');
}
// a small top-down picture of the plate, the post on it, and which way the rail leaves (drawn to the shop drawings:
// 4" plate, 2" post, bolt holes 3/8" in; offset = post 1/4" from the outer edge, plate reaching in under the rail; Rev = flipped)
// corners: EC turns right with the run, IC turns left; joints run straight through. side = which end of the rail the code is on (L / R), when known
function bpIcon(code, side){
  var c = String(code || '').trim(), m = /^E-(Cen|Off|Rev)-(L|R)$/i.exec(c), mid = /^(Mid|Joint)-Cen$/i.test(c), cen = /-Cen$/i.test(c), cor = /^(EC|IC)-Cen$/i.exec(c);
  if (!m && !mid && !cen) return '';
  var X0 = 18, W = 64, P = 32, px = X0 + (W - P) / 2, rails = [];
  if (m){
    var k = m[1].toLowerCase(), left = m[2].toUpperCase() === 'L';   // L: rail runs off to the right of the post
    if (k === 'off') px = left ? X0 + 4 : X0 + W - 4 - P;
    if (k === 'rev') px = left ? X0 + W - 4 - P : X0 + 4;
    rails.push(left ? [px + P, 100] : [0, px]);
  } else if (mid) rails.push([0, px], [px + P, 100]);
  else if (cor){
    var right = cor[1].toUpperCase() === 'EC';
    // the run reads left to right: on a rail's R end the run arrives from the left and turns; on its L end it arrived from below (EC) or above (IC) and leaves to the right
    if (side === 'L') rails.push([px + P, 100], right ? ['v', 16 + P, 80] : ['v', -16, 16]);
    else rails.push([0, px], right ? ['v', 16 + P, 80] : ['v', -16, 16]);
  }
  var h = '<svg class="bpi' + (cor ? ' tall' : '') + '" viewBox="' + (cor ? '0 -16 100 96' : '0 0 100 64') + '" aria-hidden="true"><rect x="' + X0 + '" y="0.5" width="' + W + '" height="63" rx="3" fill="#E9E5DC" stroke="#5F5E5A" stroke-width="1.5"/>';
  [[X0 + 6, 6], [X0 + W - 6, 6], [X0 + 6, 58], [X0 + W - 6, 58]].forEach(function(o){ h += '<circle cx="' + o[0] + '" cy="' + o[1] + '" r="3" fill="none" stroke="#5F5E5A" stroke-width="1.3"/>'; });
  rails.forEach(function(r){ h += r[0] === 'v' ? '<line x1="50" y1="' + r[1] + '" x2="50" y2="' + r[2] + '" stroke="#2F5D50" stroke-width="8"/>' : '<line x1="' + r[0] + '" y1="32" x2="' + r[1] + '" y2="32" stroke="#2F5D50" stroke-width="8"/>'; });
  return h + '<rect x="' + px + '" y="16" width="' + P + '" height="' + P + '" fill="#1F1B17"/></svg>';
}
function topWords(t){ return isTop() ? String(t).replace(/bracketing/gi, function(w){ return w === w.toUpperCase() ? 'BASE PLATES' : 'Base plates'; }).replace(/^bracket code$/i, 'Base plate') : t; }
function isTop(){ return !!(cur && /^top/i.test(String(cur.mount || '').trim())); }
function readBlock(sd){
  var b13 = cellVal(sd, 13, 2), d13 = cellVal(sd, 13, 4), d14 = cellVal(sd, 14, 4);
  var num = function(v){ return typeof v === 'number' ? v : (v != null && String(v).trim() !== '' && !isNaN(+v) ? +v : null); };
  var list = d14 != null ? String(d14).trim() : '';
  if (list && !/^38\s+5\/16$/.test(list)) return { custom: true, text: list };
  var o = num(d13); if (o != null && Math.abs(o - STD_BLOCK) > 0.001) return { custom: true, text: fmt16(o) + '"' };
  var b = num(b13); if (b != null && Math.abs(b - STD_BLOCK) > 0.001) return { custom: true, text: fmt16(b) + '"' };
  return { custom: false };
}
function topRailsDone(){
  var it = cutItem(); if (!it) return false;
  var ks = Object.keys(it.L.chk).filter(function(k){ return /top rail/i.test(it.L.chk[k].head); }).map(function(k){ return it.sh.name + '|c' + k; });
  return ks.length > 0 && ks.every(function(k){ return cur.done[k]; });
}
// which kind of work a tick is: rail tags, blocking and bracketing are assembly; everything else is cutting
function tickKind(key){
  var sn = key.split('|')[0], rest = key.slice(sn.length + 1), it = cur.items.filter(function(x){ return x.sh.name === sn; })[0];
  if (!it || rest.charAt(0) !== 'c') return 'cut';
  var k = rest.slice(1), ck = it.L.chk[k];
  if (sn === 'CUT SHEET') return ck && /rail tag/i.test(ck.head) ? 'asm' : 'cut';
  if (SCREEN_RE.test(sn)) return ck && ck.head === 'Assembled' ? 'asm' : 'cut';
  if (sn === 'POST SHEET'){ var sc = sheetSections(it).filter(function(s){ return s.keys.indexOf(key) >= 0; })[0]; return sc && /^(block|bracket)/i.test(sc.label) ? 'asm' : 'cut'; }
  return 'cut';
}
function stamp(kind){ var a = kind === 'asm' ? (cur.tla = cur.tla || []) : (cur.tl = cur.tl || []); a.push(Date.now()); }
// Cut Sheet keys by column: Top rail + Channel boxes (cutting) and Rail tag boxes (assembly)
function screenItems(){ return cur ? cur.items.filter(function(x){ return SCREEN_RE.test(x.sh.name) || x.virt; }) : []; }
function cutKeys(kind){
  var it = cutItem();
  if (!it){
    var out = []; screenItems().forEach(function(si){ Object.keys(si.L.chk).forEach(function(k){ var asm = si.L.chk[k].head === 'Assembled'; if (asm === (kind === 'asm')) out.push(si.sh.name + '|c' + k); }); });
    return out;
  }
  return Object.keys(it.L.chk).filter(function(k){ var h = it.L.chk[k].head; return kind === 'asm' ? /rail tag/i.test(h) : /top rail|channel/i.test(h); }).map(function(k){ return it.sh.name + '|c' + k; });
}
// welding: one box per rail tag on the Cut Sheet, kept by tag ('W|201.1') in the weld record
function weldRows(it){
  if (!it || !WELD_BOXES) return [];
  var L = it.L, seen = {}, out = [];
  Object.keys(L.chk).forEach(function(k){
    var ck = L.chk[k]; if (!/rail tag/i.test(ck.head)) return;
    var r = +k.split(':')[0], tag = L.txt(r, ck.left); if (!tag || seen[tag]) return;
    seen[tag] = 1; out.push({ row: r, tag: tag, key: 'W|' + tag });
  });
  return out.sort(function(a, b){ return a.row - b.row; });
}
function weldKeys(){ return weldRows(cutItem()).map(function(x){ return x.key; }); }
function weldAll(){ if (!WELD_BOXES) return true; var ks = weldKeys(); return ks.length > 0 && ks.every(function(k){ return cur.w.done[k]; }); }
function allDone(keys){ return keys.length > 0 && keys.every(function(k){ return cur.done[k]; }); }
function postsCutDone(){
  var it = cur && cur.items.filter(function(x){ return x.sh.name === 'POST SHEET'; })[0], sc = it && sheetSections(it).filter(function(s){ return s.label === 'Posts cut'; })[0];
  return !!(sc && sc.keys.every(function(k){ return cur.done[k]; }));
}
function blockCheck(was){
  if (!was && postsCutDone() && cur.block && cur.block.custom)
    alertBox('<b class="big">Custom block height</b>This job’s blocks are <b>' + esc(cur.block.text) + '</b>. Mount the blocks at this height.');
}
function alertBox(html){
  var m = el('modal'), no = el('modalNo'), yes = el('modalYes'), t = el('modalText');
  t.innerHTML = html; el('modalInput').hidden = true; no.hidden = true; var yt = yes.textContent; yes.textContent = 'Got it'; m.classList.add('alert'); m.hidden = false;
  yes.onclick = function(){ m.hidden = true; no.hidden = false; yes.textContent = yt; m.classList.remove('alert'); };
}
// the sort bar sits in the Cut Sheet itself, just above the Rail tag / ✓ / Top rail heading row
function sortBarHtml(){
  var sbtn = function(o){ return '<button type="button" class="sbtn' + ((cur.sort || '') === o[0] ? ' on' : '') + '" data-sort="' + o[0] + '" aria-pressed="' + ((cur.sort || '') === o[0]) + '">' + o[1] + '</button>'; };
  // one compact line: Unit Order · Top rail [Longest|Shortest] · Channel [Longest|Shortest] · Optimal Cut
  var seg = function(lab, a, b){ return '<span class="sseg"><span class="sgl">' + lab + '</span>' + sbtn(a) + sbtn(b) + '</span>'; };
  var ci = cutItem(), noTR = isFenceJob() && !(ci && ci.L.cols.some(function(c){ return /^top rail$/i.test(ci.L.txt(ci.L.hdr, c)); }));
  return '<div class="sortbar' + (isFenceJob() ? ' fsort' : '') + '"><span class="slab">Sort</span>' + sbtn(['', 'Unit Order']) + (noTR ? '' : seg('Top rail', ['long', 'Longest'], ['short', 'Shortest'])) +
    seg('Channel', ['clong', 'Longest'], ['cshort', 'Shortest']) + sbtn(['opt', 'Optimal Cut']) + pkHtml() + '</div>';
}
// fence jobs: one job-wide "Pickets Cut" YES / NO beside the sort buttons, so Ian can see if the pickets are done.
// It's synced like a tick but isn't needed for Cutting / Assembly complete (Ian sometimes cuts them as he welds).
var PK_KEY = 'FENCE|pickets';
function isFenceJob(){ var it = cur && cutItem(); return !!(it && it.L && it.L.fence); }
function pkHtml(){
  if (!isFenceJob()) return '';
  var on = !!cur.done[PK_KEY], b = function(v, t){ var sel = (v === '1') === on; return '<button type="button" class="sbtn' + (sel ? ' on' + (v === '1' ? '' : ' pkno') : '') + '" data-pk="' + v + '" aria-pressed="' + sel + '">' + t + '</button>'; };
  return '<span class="sseg pkseg"><span class="sgl">Pickets Cut</span>' + b('1', 'YES') + b('0', 'NO') + '</span>';
}
// Optimal Cut: packs top rails onto 25' (300") sticks with a 1/8" kerf per cut, filling each stick as full as it can
// (exact best fill per stick, in 1/16ths), most-full sticks first. Returns [{ rows, used, off }] plus any piece too long for a stick.
var STICK = 300, KERF = 0.125;
function packSticks(items){
  // same rule as the cost sheet's STICK CALC: every piece takes its length + 1/8" kerf, out of a 300" stick
  var U = 16, cap = STICK * U, left = items.filter(function(it){ return it.len > 0 && it.len <= STICK; }), out = [];
  var tooLong = items.filter(function(it){ return it.len > STICK; });
  while (left.length){
    var w = left.map(function(it){ return Math.ceil((it.len + KERF) * U - 1e-6); });
    // reach[t] = the piece that first made total t (pieces taken once each); prev[t] = the total before it
    var reach = new Int16Array(cap + 1).fill(-1), prev = new Int32Array(cap + 1).fill(-1); reach[0] = 9999;
    for (var i = 0; i < left.length; i++) for (var t = cap; t >= w[i]; t--) if (reach[t] < 0 && reach[t - w[i]] >= 0 && reach[t - w[i]] !== i){ reach[t] = i; prev[t] = t - w[i]; }
    var tot = cap; while (tot > 0 && reach[tot] < 0) tot--;
    var pick = []; for (var x = tot; x > 0; x = prev[x]) pick.push(reach[x]);
    if (!pick.length) pick = [0];
    var picked = pick.map(function(i){ return left[i]; }).sort(function(a, b){ return b.len - a.len || a.row - b.row; });
    out.push(stickOf(picked));
    left = left.filter(function(it, i){ return pick.indexOf(i) < 0; });
  }
  // never more sticks than the cost sheet's first-fit count: if first-fit somehow does better, use its layout
  var ffd = [], fit = items.filter(function(it){ return it.len > 0 && it.len <= STICK; }).slice().sort(function(a, b){ return b.len - a.len || a.row - b.row; });
  fit.forEach(function(it){ var need = it.len + KERF, bin = ffd.filter(function(b){ return b.room >= need - 1e-9; })[0]; if (!bin){ bin = { room: STICK, items: [] }; ffd.push(bin); } bin.room -= need; bin.items.push(it); });
  if (ffd.length < out.length) out = ffd.map(function(b){ return stickOf(b.items); });
  return { sticks: out, tooLong: tooLong };
}
function stickOf(items){
  var used = items.reduce(function(a, it){ return a + it.len; }, 0) + KERF * Math.max(0, items.length - 1);
  return { items: items, used: used, off: Math.max(0, STICK - used - (STICK - used > 0 ? KERF : 0)) };
}
function fmtIn(x){
  var w = Math.floor(x + 1e-9), n = Math.round((x - w) * 16); if (n === 16){ w++; n = 0; }
  if (!n) return w + '"'; var d = 16; while (n % 2 === 0){ n /= 2; d /= 2; } return (w ? w + ' ' : '') + n + '/' + d + '"';
}
// unit layouts start closed, except on the weld tablet for top mount jobs (where the base plate orientation matters)
function layOpen(unit){ return cur.open[unit] == null ? (WELD && isTop()) : !!cur.open[unit]; }
function layoutRow(unit, ncols){
  var u = cur && cur.units[unit]; if (!u) return '';
  var on = layOpen(unit);
  var h = '<tr class="unitbar"><td colspan="' + ncols + '"><button type="button" class="laybtn" data-unit="' + esc(unit) + '" aria-expanded="' + on + '"><span class="lb' + (on ? ' on' : '') + '">' + (on ? '✓' : '') + '</span>Unit ' + esc(unit) + ' layout</button></td></tr>';
  if (on){ var svg = ''; try { svg = LAY.svg(u); } catch (e) { svg = '<div class="legend">Couldn’t draw this unit.</div>'; } h += '<tr class="layrow"><td colspan="' + ncols + '"><div class="layout">' + svg + '</div></td></tr>'; }
  return h;
}
// numbered sections on a sheet (1 · Post cutting, 2 · Blocking, 3 · Bracketing): each heading gets one box that ticks that section only.
// A section stops at the first blank row or the next numbered heading; Post cutting also stops at anything about blocking or bracketing.
var SEC_RE = /^\d+\s*[·.\-]\s*[A-Za-z]/;
function sheetSections(item){
  if (!item) return [];
  var L = item.L, out = [], curS = null;
  var rowTxt = function(r){ return L.cols.map(function(c){ return L.txt(r, c); }).join(' ').trim(); };
  L.rows.forEach(function(r){
    var t0 = L.txt(r, L.cols[0]), t = rowTxt(r);
    if (SEC_RE.test(t0)){ var name = t0.replace(/^\d+\s*[·.\-]\s*/, '').trim(); curS = { row: r, name: name, post: /post cutting/i.test(name), end: Infinity }; out.push(curS); return; }
    if (!curS || curS.end !== Infinity) return;
    var hdr = L.cols.some(function(c){ return L.txt(r, c) === '✓'; });
    if (!t || (curS.post && !hdr && /block|bracket/i.test(t))) curS.end = r;
  });
  return out.map(function(sc){
    var keys = Object.keys(L.chk).filter(function(k){ var r = +k.split(':')[0]; return r > sc.row && r < sc.end; }).map(function(k){ return item.sh.name + '|c' + k; });
    var nm = sc.name.toLowerCase(), label = sc.post ? 'Posts cut' : (nm.charAt(0).toUpperCase() + nm.slice(1) + ' done');
    return { row: sc.row, keys: keys, label: label };
  }).filter(function(sc){ return sc.keys.length; });
}
function renderSheet(book, item, done){
  var L = item.L, sd = item.sd, sh = item.sh, pre = sh.name + '|';
  var vis = {}; L.rows.forEach(function(r, i){ vis['r' + r] = i; }); L.cols.forEach(function(c, i){ vis['c' + c] = i; });
  var skip = {}, span = {};
  sd.merges.forEach(function(m){
    if (vis['r' + m.r1] == null || vis['c' + m.c1] == null) return;
    var rs = L.rows.filter(function(r){ return r >= m.r1 && r <= m.r2; }).length, cs = L.cols.filter(function(c){ return c >= m.c1 && c <= m.c2; }).length;
    span[m.r1 + ':' + m.c1] = { rs: rs, cs: cs };
    L.rows.forEach(function(r){ L.cols.forEach(function(c){ if (r >= m.r1 && r <= m.r2 && c >= m.c1 && c <= m.c2 && !(r === m.r1 && c === m.c1)) skip[r + ':' + c] = 1; }); });
  });
  var scr = SCREEN_RE.test(sh.name) && L.hdr != null;
  var rmk = cur && cur.f.remake && sh.name === 'CUT SHEET' ? cur.f.remake : null;
  var h = (rmk ? '<div class="rmbanner"><b>↻ Remake · ' + esc(rmk.tags.join(', ')) + '</b>' + (rmk.note ? '<span>' + esc(rmk.note) + '</span>' : '') + '</div>' : '') + (scr ? screenHead(item) : '') + (L.fence ? fenceHead(book, item) : '') + (WELD && isTop() && /^(CUT SHEET|POST SHEET)$/.test(sh.name) ? '<div class="bpnote"><b>Top mount · weld-on base plates</b><span class="bpkey"><i>Cen</i> centred on the plate · <i>Off</i> offset: post at the outer end, plate reaches in under the rail · <i>Rev</i> reverse offset: plate sticks out past the end · <i>L / R</i> left / right end of the rail · <i>EC</i> corner turns right with the run, <i>IC</i> turns left · 4x4 plates for 2x2 posts</span>' + (sh.name === 'POST SHEET' ? 'Post lengths are in section 1. The plates to weld, and how many of each, are under Base plates. The Cuts tab shows which plate goes on each rail end.' : 'The L Post and R Post columns show which base plate goes on each end of the rail. The Posts tab has the post lengths and the plate totals.') + '</div>' : '') + '<table class="sheet' + (L.fence ? ' fence' : '') + (sh.name === 'CUT SHEET' && !L.fence ? ' railcut' : '') + '">';
  var isCut = sh.name === 'CUT SHEET' && cur && Object.keys(cur.units || {}).length, lastUnit = null;
  var hiSheet = /^(COVER|POST SHEET)$/.test(sh.name);
  // Cut Sheet: a black line between the float lengths (Left / Right) and the posts (L Post …), so the two groups read apart
  var divC = sh.name === 'CUT SHEET' && L.hdr != null ? L.cols.filter(function(c){ return /^l\s*post$/i.test(L.txt(L.hdr, c).trim()); })[0] : null;
  var secs = {}; sheetSections(item).forEach(function(sc){ secs[sc.row] = sc; });
  // floating rails (Non-Sub = Yes on INPUT): rail tag in bold red, same as the Excel cut sheet
  var floatTag = {}; if (sh.name === 'CUT SHEET' && cur) Object.keys(cur.units || {}).forEach(function(u){ cur.units[u].secs.forEach(function(s){ if (/^yes$/i.test(String(s.ns).trim())) floatTag[String(s.tag).trim()] = 1; }); });
  // Shop Welds: a Weld box in front of every rail tag; the shop's own boxes are shown small and can't be changed here
  var wmap = {}, wcol = false; if (WELD && sh.name === 'CUT SHEET' && cur) weldRows(item).forEach(function(x){ wmap[x.row] = x.key; wcol = true; });
  var NC = L.cols.length + (wcol ? 1 : 0);
  // Shop Welds, top mount jobs: the base plate codes stand out (L Post / R Post on the Cut Sheet, the plate list on the Post Sheet)
  var bpC = {}, bpFrom = Infinity, bpTo = Infinity;
  if (WELD && isTop()){
    if (sh.name === 'CUT SHEET' && L.hdr != null) L.cols.forEach(function(c){ if (/^[lr]\s*post$/i.test(L.txt(L.hdr, c).trim())) bpC[c] = L.txt(L.hdr, c).trim().charAt(0).toUpperCase(); });
    if (sh.name === 'POST SHEET') L.rows.forEach(function(r){ var t0 = L.txt(r, L.cols[0]); if (SEC_RE.test(t0)){ bpFrom = /bracket|plate/i.test(t0) ? r : Infinity; bpTo = Infinity; } else if (r > bpFrom && bpTo === Infinity && !t0) bpTo = r; });
  }
  // sorted by top rail: rail rows reordered, every unit layout moved to the bottom in unit order
  var order = L.rows, sorted = false, unitsInOrder = [], stickHead = {};
  if (isCut && L.hdr != null){
    L.rows.forEach(function(r){ var tg = L.txt(r, L.cols[0]); if (r > L.hdr && /^\S+\.\d+$/.test(tg)){ var un = unitOf(tg); if (unitsInOrder.indexOf(un) < 0) unitsInOrder.push(un); } });
    var byCh = /^c/.test(cur.sort || ''), shortFirst = /short$/.test(cur.sort || '');
    var sortC = L.cols.filter(function(c){ return (byCh ? /channel/i : /top rail/i).test(L.txt(L.hdr, c)); })[0];
    if (cur.sort && sortC != null){
      var isRail = function(r){ return r > L.hdr && /^\S+\.\d+$/.test(L.txt(r, L.cols[0])); };
      // top rail: the one length; channels ("2@ 45 3/16" or "1@ 4, 3@ 39 5/16, …"): the longest piece on the line
      var len = function(r){
        var x = sd.cells[r + ':' + sortC], v = x ? x.v : null;
        if (!byCh){ if (typeof v === 'number') return v; var m = /(\d+(?:\.\d+)?)(?:\s+(\d+)\s*\/\s*(\d+))?/.exec(String(v == null ? '' : v)); return m ? +m[1] + (m[2] ? m[2] / m[3] : 0) : -1; }
        var t = String(v == null ? '' : v), re = /\d+\s*@\s*(\d+(?:\.\d+)?)(?:\s+(\d+)\s*\/\s*(\d+))?/g, mm, best = -1;
        while ((mm = re.exec(t))) best = Math.max(best, +mm[1] + (mm[2] ? mm[2] / mm[3] : 0));
        if (best < 0 && typeof v === 'number') best = v;
        return best;
      };
      var rails;
      if (cur.sort === 'opt'){
        var pk = packSticks(L.rows.filter(isRail).map(function(r){ return { row: r, len: len(r) }; }));
        rails = []; var nS = pk.sticks.length;
        pk.sticks.forEach(function(st, i){
          stickHead[st.items[0].row] = '<span class="sk">Stick ' + (i + 1) + ' of ' + nS + '</span>' + st.items.length + ' cut' + (st.items.length === 1 ? '' : 's') + ' · ' + (st.off < 1 / 16 ? 'no offcut' : 'offcut ' + fmtIn(Math.floor(st.off * 16) / 16));
          st.items.forEach(function(it){ rails.push(it.row); });
        });
        if (pk.tooLong.length){ stickHead[pk.tooLong[0].row] = '<span class="sk warn">Longer than 25\'</span>' + pk.tooLong.length + ' piece' + (pk.tooLong.length === 1 ? '' : 's') + ' · check with the office'; pk.tooLong.forEach(function(it){ rails.push(it.row); }); }
        L.rows.filter(isRail).forEach(function(r){ if (rails.indexOf(r) < 0) rails.push(r); });   // no top rail length: at the end
      } else rails = L.rows.filter(isRail).sort(function(a, b){ var la = len(a), lb = len(b); if (la < 0 || lb < 0) return (lb - la) || a - b; return shortFirst ? la - lb || a - b : lb - la || a - b; });
      order = L.rows.filter(function(r){ return r <= L.hdr; }).concat(rails, L.rows.filter(function(r){ return r > L.hdr && !isRail(r); }));
      sorted = true;
    }
  }
  order.forEach(function(r){
    if ((scr || L.fence) && r < L.hdr) return;   // privacy screens: the top block is shown as the summary above the table
    if (isCut && !sorted && L.hdr != null && r > L.hdr){
      var tg = L.txt(r, L.cols[0]), un = /^\S+\.\d+$/.test(tg) ? unitOf(tg) : null;
      if (un && un !== lastUnit){ h += layoutRow(un, NC); lastUnit = un; }
    }
    var rc = L.cols.filter(function(c){ return L.chk[r + ':' + c] && !L.chk[r + ':' + c].opt; });
    var main = L.vchk ? [] : rc.filter(function(c){ return /top rail|channel/i.test(L.chk[r + ':' + c].head); });
    var need = (main.length ? main : rc).map(function(c){ return pre + 'c' + r + ':' + c; });
    var rowDone = (need.length && need.every(function(k){ return done[k]; })) || (L.rowTap[r] && done[pre + 'r' + r]);
    if (WELD && sh.name === 'CUT SHEET') rowDone = !!(wmap[r] && cur.w.done[wmap[r]]);
    var tick = {}; rc.forEach(function(c){ var ck = L.chk[r + ':' + c]; if (done[pre + 'c' + r + ':' + c]){ tick[ck.left] = 1; if (ck.left2 != null) tick[ck.left2] = 1; } });
    var trc = [rowDone ? 'rowdone' : '', L.rowTap[r] ? 'tap' : '', need.length || L.rowTap[r] ? 'data' : '', r === L.hdr ? 'hdr' : (L.cols.some(function(c){ return L.txt(r, c) === '✓'; }) ? 'subhdr' : ''), /^\d+\s*[·.\-]\s*[A-Za-z]/.test(L.txt(r, L.cols[0])) ? 'sechead' : (L.hdr != null && r < L.hdr ? 'info' : '')].filter(Boolean).join(' ');
    var big = !!(need.length || L.rowTap[r]);
    if (stickHead[r]) h += '<tr class="stickrow"><td colspan="' + NC + '">' + stickHead[r] + '</td></tr>';
    if (isCut && r === L.hdr && !WELD) h += '<tr class="sortrow"><td colspan="' + NC + '">' + sortBarHtml() + '</td></tr>';
    if (isCut && r === L.hdr && WELD && L.fence) h += '<tr class="sortrow"><td colspan="' + NC + '"><div class="sortbar"><span class="sgl">Pickets Cut</span><b class="pkro' + (cur.done[PK_KEY] ? ' on' : '') + '">' + (cur.done[PK_KEY] ? 'YES' : 'NO') + '</b></div></td></tr>';
    h += '<tr' + (trc ? ' class="' + trc + '"' : '') + (L.rowTap[r] ? ' data-row="' + pre + 'r' + r + '"' : '') + '>';
    if (wcol) h += r === L.hdr ? '<td class="wh">Weld</td>' : wmap[r] ? '<td class="chk wchk' + (cur.w.done[wmap[r]] ? ' on' : '') + '" data-wkey="' + esc(wmap[r]) + '"><span class="box" role="checkbox" aria-checked="' + !!cur.w.done[wmap[r]] + '" aria-label="Welded">✓</span></td>' : '<td class="wpad"></td>';
    var hiNext = null;
    L.cols.forEach(function(c){
      var k = r + ':' + c; if (skip[k]) return;
      if (secs[r] && c === L.cols[L.cols.length - 1]){ var sc = secs[r], sa = sc.keys.every(function(kk){ return done[kk]; }); var sp0 = span[k], at0 = sp0 ? (sp0.rs > 1 ? ' rowspan="' + sp0.rs + '"' : '') + (sp0.cs > 1 ? ' colspan="' + sp0.cs + '"' : '') : ''; h += '<td class="postsall"' + at0 + '><button type="button" class="pcut' + (sa ? ' on' : '') + '" data-act="secall" data-sec="' + r + '" aria-pressed="' + sa + '"><span class="box">✓</span>' + esc(topWords(sc.label)) + '</button></td>'; return; }
      var cell = sd.cells[k], t = sh.name === 'POST SHEET' ? topWords(show(book, cell)) : show(book, cell), sp = span[k], xf = cell && book.st.xfs[cell.s], f = xf && book.st.fonts[xf.font];
      // top mount: a centred plate's method reads WELD-ON Centered (the cut sheet says just "WELD-ON plate" for Mid-Cen)
      if (sh.name === 'POST SHEET' && /^cj$/i.test(t.trim())) t = 'Joints';
      if (L.fence && r === L.hdr) t = t.replace(/^1st space \(cut end to hole edge\)$/i, '1st space (to hole edge)').replace(/^picket cut$/i, 'Picket Length');
      if (L.fence && r > L.hdr && /^step$/i.test(L.txt(L.hdr, c))) t = t.replace(/\bLow\b/, 'Down').replace(/\bHigh\b/, 'Up');   // fence steps read Up / Down   // the template's bracket code CJ reads as Joints on the tablet
      if (sh.name === 'POST SHEET' && /^MIDS$/.test(t.trim())) t = 'Mids';     // and MIDS (in capitals in the template) reads as Mids
      if (sh.name === 'POST SHEET' && isTop() && /^weld-on plate$/i.test(t.trim()) && /^(Mid|EC|IC|Joint|E)-Cen(-[LR])?$/i.test(L.txt(r, L.cols[0]).trim())) t = 'WELD-ON Centered';
      var attr = sp ? (sp.rs > 1 ? ' rowspan="' + sp.rs + '"' : '') + (sp.cs > 1 ? ' colspan="' + sp.cs + '"' : '') : '';
      if (L.vchk && L.vchk[c] && !L.chk[k]){ h += r === L.hdr ? '<td class="c b vhd' + (L.div && L.div[c] ? ' divl' : '') + '">' + esc((L.vhead && L.vhead[c]) || '✓') + '</td>' : '<td></td>'; return; }
      if (L.chk[k]){ var key = pre + 'c' + k; h += '<td class="chk' + (done[key] ? ' on' : '') + (WELD ? ' ro' : '') + '" data-key="' + esc(key) + '"' + attr + '><span class="box" role="checkbox" aria-checked="' + !!done[key] + '" aria-label="Done">✓</span></td>'; return; }
      var cls = [], blkParts = null;
      // Cover and Post Sheet: post height and block height stand out (label + the value beside it)
      if (hiSheet && (L.hdr == null || r < L.hdr)){
        if (hiNext){
          cls.push('hival');
          if (hiNext === 'block' && !t.trim()) t = cur && cur.block && cur.block.custom ? cur.block.text : '38 5/16 (standard)';
          // red only when the block height shown isn't the standard 38 5/16
          if (hiNext === 'block' && !/^38\s+(5\/16|10\/32)\b/.test(t.trim())) cls.push('hicustom');
          // two block heights (a secondary channel, e.g. "3, 38 5/16"): each in its own box so they don't read as one number
          if (hiNext === 'block' && /,/.test(t)) blkParts = t.split(/\s*,\s*/).filter(Boolean);
          hiNext = null;
        } else if (/^\s*(post|block|bracket)\s*(height|ht)\.?\s*$/i.test(t)){ cls.push('hilab'); hiNext = /block/i.test(t) ? 'block' : 'post'; }   // bracket height joins the yellow block too
      }
      if (tick[c]) cls.push('cut');
      if (divC != null && c === divC && r >= L.hdr) cls.push('divl');
      if (L.div && L.div[c] && r >= L.hdr) cls.push('divl');
      if (L.pnar && L.pnar[c]) cls.push('pnar');
      if (sh.name === 'CUT SHEET' && r > L.hdr && t.length >= 8 && !/\d/.test(t)) cls.push('longtxt');   // e.g. SEE CUSTOM: smaller and wraps
      if (item.virt && r === L.hdr) cls.push('b', 'c');
      if (c === L.cols[0] && L.hdr != null && r > L.hdr && floatTag[t.trim()]) cls.push('floatrail');
      if (((bpC[c] && r > L.hdr) || (r > bpFrom && r < bpTo && c === L.cols[0] && !L.cols.some(function(cc){ return L.txt(r, cc) === '✓'; }))) && bpDesc(t)) cls.push('bp');
      if (f && f.b) cls.push('b');
      if (cell && cell.b) cls.push('b'); if (cell && cell.c) cls.push('c'); if (cell && cell.cls) cls.push(cell.cls);
      if (cell && typeof cell.v === 'number') cls.push('num');
      if (xf && xf.h === 'center') cls.push('c');
      if ((xf && xf.wrap) || t.length > 22) cls.push('wrapcell');
      var style = (cell ? (cell.css || '') + ((L.fence || scr) && r > L.hdr ? '' : fillCss(book, cell.s)) : '') + (f && f.rgb && /^FF[0-9A-F]{6}$/i.test(f.rgb) && f.rgb.slice(2).toUpperCase() !== '000000' ? 'color:#' + f.rgb.slice(2) + ';' : '');
      if (blkParts){ h += '<td class="' + cls.join(' ') + ' blksplit"' + attr + '><span class="blkw">' + blkParts.map(function(x){ return '<span class="blkp">' + measure(x) + '</span>'; }).join('') + '</span></td>'; return; }
      var bd = cls.indexOf('bp') >= 0 ? bpDesc(t) : '';
      h += '<td' + (cls.length ? ' class="' + cls.join(' ') + '"' : '') + (style ? ' style="' + style + '"' : '') + attr + '>' + (bd ? '<span class="bpw">' + bpIcon(t, bpC[c] || '') + '<span>' + (big ? measure(t) : esc(t)) + '<small class="bpd">' + esc(bd) + '</small></span></span>' : (big ? measure(t) : esc(t))) + '</td>';
    });
    h += '</tr>';
  });
  if (sorted && unitsInOrder.length){
    // collapsed under one tick box while sorted
    var on = !!cur.showLays;
    h += '<tr class="unitbar laysec"><td colspan="' + NC + '"><button type="button" class="laybtn" data-act="laysall" aria-expanded="' + on + '"><span class="lb' + (on ? ' on' : '') + '">' + (on ? '✓' : '') + '</span>Show unit layouts (' + unitsInOrder.length + ')</button></td></tr>';
    if (on) unitsInOrder.forEach(function(un){ h += layoutRow(un, NC); });
  }
  // privacy screens: the Post A / B / C drawing sits under the cut list (and under the post list)
  var kinds = scr || item.virt ? cur && cur.items.filter(function(x){ return SCREEN_RE.test(x.sh.name); }).map(function(x){ return x.sh.name; }) : null;
  if (kinds && kinds.length){
    kinds = scr ? [sh.name] : kinds;
    var rw = cur.items.filter(function(x){ return x.sh.name === 'Rail to Wall' && kinds.indexOf('Rail to Wall') >= 0; })[0];
    if (rw) kinds.short = screenShort(rw.sd);
    if (rw) kinds.midRW = screenMid(rw.sd, 1);
    var ww = cur.items.filter(function(x){ return x.sh.name === 'Wall to Wall' && kinds.indexOf('Wall to Wall') >= 0; })[0];
    if (ww) kinds.midWW = screenMid(ww.sd, 2);
  }
  // custom rails: drawn under the Custom posts table, and under the Cuts table too
  var cpIt = sh.name === 'CUT SHEET' && cur ? cur.items.filter(function(x){ return x.sh.name === 'CUSTOM POST CUT'; })[0] : null;
  var cps = sh.name === 'CUSTOM POST CUT' ? customRails(sd) : cpIt ? customRails(cpIt.sd) : [];
  return h + '</table>' + (kinds && kinds.length ? '<div class="scrbelow">' + screenDiagram(kinds) + '</div>' : '') + (cps.length ? '<div class="cpbelow">' + cps.map(customDiagram).join('') + '</div>' : '');
}

// ---------- custom posts: a side view of each custom rail, drawn from CUSTOM POST CUT + the rail's CUT SHEET line ----------
function cpNum(v){ return typeof v === 'number' ? v : (v != null && String(v).trim() !== '' && !isNaN(+v) ? +v : null); }
function customRails(sd){
  var hdr = null, col = {}, rails = [], r, c, t = function(r, c){ var x = cellVal(sd, r, c); return x == null ? '' : String(x).trim(); };
  for (r = 1; r <= (sd.maxR || 80) && hdr == null; r++) if (/^post\s*#$/i.test(t(r, 1))) hdr = r;
  if (hdr == null) return rails;
  for (c = 1; c <= 12; c++){ var h = t(hdr, c).toLowerCase(); if (h) col[h] = c; }
  var get = function(r, k){ return col[k] ? cellVal(sd, r, col[k]) : null; };
  for (r = hdr + 1; r <= (sd.maxR || 80); r++){
    var a = t(r, 1), m = /^(\S+)\s*·\s*([^·]*)·/.exec(a);
    if (m){ rails.push({ tag: m[1], posts: [] }); continue; }
    if (/^post\s*\d+/i.test(a) && rails.length) rails[rails.length - 1].posts.push({
      n: a, pos: String(get(r, 'position') || ''), type: String(get(r, 'type') || '').trim(), mount: String(get(r, 'mount') || '').trim(),
      cut: cpNum(get(r, 'post cut')), bl: cpNum(get(r, 'block l')), br: cpNum(get(r, 'block r'))
    });
  }
  return rails.filter(function(x){ return x.posts.length; });
}
// the rail's line on the CUT SHEET: channel pieces (L→R), top rail and the end labels
function cutLine(tag){
  var it = cur && cur.items.filter(function(x){ return x.sh.name === 'CUT SHEET'; })[0]; if (!it) return null;
  var sd = it.sd, t = function(r, c){ var x = cellVal(sd, r, c); return x == null ? '' : String(x).trim(); }, hdr = null, col = {}, r, c;
  for (r = 1; r <= (sd.maxR || 200) && hdr == null; r++) if (/^rail\s*tag$/i.test(t(r, 1))) hdr = r;
  if (hdr == null) return null;
  for (c = 1; c <= (sd.maxC || 30); c++){ var h = t(hdr, c).toLowerCase(); if (h && !col[h]) col[h] = c; }
  for (r = hdr + 1; r <= (sd.maxR || 200); r++) if (t(r, 1) === String(tag)){
    var chK = Object.keys(col).filter(function(k){ return /^channels?/.test(k); })[0], pcs = [], re = /(\d+)\s*@\s*(\d+(?:\.\d+)?)(?:\s+(\d+)\s*\/\s*(\d+))?/g, mm, txt = chK ? t(r, col[chK]) : '';
    while ((mm = re.exec(txt))) for (var i = 0; i < +mm[1]; i++) pcs.push(+mm[2] + (mm[3] ? mm[3] / mm[4] : 0));
    return { ch: pcs, top: cpNum(cellVal(sd, r, col['top rail'])), left: col.left ? t(r, col.left) : '', right: col.right ? t(r, col.right) : '' };
  }
  return null;
}
function customDiagram(rail){
  var P = rail.posts, ln = cutLine(rail.tag) || { ch: [], left: '', right: '' }, ink = '#0F1E29', mut = '#5B6B78', s = 8, pw = 2 * s;
  var isFl = function(p){ return /^fl\b|float/i.test(p.type); };
  var cuts = P.filter(function(p){ return !isFl(p) && p.cut; }).map(function(p){ return p.cut; }).sort();
  var ref = cuts.length ? cuts[Math.floor(cuts.length / 2)] : 40.5;
  var gaps = P.slice(1).map(function(p, i){ return ln.ch.length === P.length - 1 ? ln.ch[i] : null; });
  // channel gaps drawn in proportion to each other: the shortest gets just enough room for its label, capped so long rails still fit
  var known = gaps.filter(function(g){ return g; }), gmin = known.length ? Math.min.apply(null, known) : 12, gsum = known.reduce(function(a, b){ return a + b; }, 0) || 12;
  // one scale both ways, so posts, pickets and the top rail keep their true shapes; long rails shrink to fit
  s = Math.min(10, 820 / (gsum + 2 * P.length)); var hs = s;
  var gpx = gaps.map(function(g){ return known.length === gaps.length ? Math.max(12, g * hs) : 12 * hs; });
  pw = 2 * s;
  var x0 = 96, xs = [x0]; gpx.forEach(function(g, i){ xs.push(xs[i] + pw + g); });
  var th = 2.5 * s, W = xs[xs.length - 1] + pw + 96, up = xs.map(function(x, i){ return i > 0 && x - xs[i - 1] < 76; }), yT = 50 + th + 8 + (up.some(Boolean) ? 30 : 0), deck = yT + ref * s, ov = '';
  up.forEach(function(u, i){ if (u && up[i - 1]) up[i] = false; });   // only every other crowded post moves up
  var maxB = Math.max.apply(null, P.map(function(p){ return yT + (p.cut || ref) * s; }).concat(deck + 12));
  var H = maxB + 44, o = '', tx = function(x, y, t, a, sz, w, f){ return '<text x="' + x + '" y="' + y + '" text-anchor="' + (a || 'middle') + '" font-size="' + (sz || 12) + '" font-weight="' + (w || 700) + '" fill="' + (f || mut) + '">' + esc(t) + '</text>'; };
  // the deck: stops short of a float post (it hangs past the edge), with the edge face shown
  var dL = x0 - 40, dR = W - 30;
  if (isFl(P[0]) && P.length > 1) dL = xs[0] + pw + Math.min(gpx[0] * .25, 36);
  if (isFl(P[P.length - 1]) && P.length > 1) dR = xs[P.length - 1] - Math.min(gpx[gpx.length - 1] * .25, 36);
  o += '<rect x="' + dL + '" y="' + deck + '" width="' + (dR - dL) + '" height="12" fill="#C9D3DC"/>';
  if (isFl(P[0])) o += '<rect x="' + (dL - 6) + '" y="' + deck + '" width="6" height="40" fill="url(#cphatch)" stroke="#9AA8B4"/>';
  o += tx(dR - 6, deck + 26, 'DECK', 'end', 11);
  if (isFl(P[P.length - 1])) o += '<rect x="' + dR + '" y="' + deck + '" width="6" height="40" fill="url(#cphatch)" stroke="#9AA8B4"/>';
  // pickets / infill between the posts, the bottom channel sitting on the blocks
  P.slice(1).forEach(function(p, i){
    var a = xs[i] + pw, b = xs[i + 1], bl = P[i].br || P[i].bl || p.bl || p.br || 0, by = yT + bl * s, ym = (yT + by) / 2;
    // pickets to scale: 3/4" wide, as few as keep every gap under 4" (a 3" section gets none)
    var G = gaps[i] != null ? gaps[i] : (b - a) / hs, np = Math.max(0, Math.ceil((G - 4) / 4.75)), pk = .75 * (b - a) / G, sp = (b - a - np * pk) / (np + 1);
    for (var k = 0; k < np; k++){ var px0 = a + sp * (k + 1) + pk * k; o += '<rect x="' + px0 + '" y="' + yT + '" width="' + pk + '" height="' + (by - 7 - yT) + '" fill="#9AA8B4"/>'; }
    o += '<rect x="' + a + '" y="' + (by - 7) + '" width="' + (b - a) + '" height="7" fill="#E8590C"/>';
    if (b - a < 130){ var bv = [P[i].br, p.bl].filter(function(v){ return v; }).map(fmtIn).filter(function(v, k, arr){ return arr.indexOf(v) === k; });
      if (bv.length) ov += tx((a + b) / 2, by - 14, bv.join(' / '), 'middle', 12, 800, '#16445F').replace('<text ', '<text paint-order="stroke" stroke="#fff" stroke-width="4" '); }
    if (gaps[i] != null) ov += '<rect x="' + ((a + b) / 2 - 24) + '" y="' + (ym - 14) + '" width="48" height="24" rx="12" fill="#fff" stroke="#E8590C" stroke-width="2"/>' + tx((a + b) / 2, ym + 3, fmtIn(gaps[i]), 'middle', 14, 900, ink);
  });
  // top rail across the posts, end labels outside
  var xr0 = xs[0] - 4, xr1 = xs[xs.length - 1] + pw + 4;
  o += '<rect x="' + xr0 + '" y="' + (yT - th) + '" width="' + (xr1 - xr0) + '" height="' + th + '" rx="2" fill="#7D8C99"/>';
  if (ln.top) o += tx((xr0 + xr1) / 2, yT - th - 8, 'Top rail ' + fmtIn(ln.top), 'middle', 13, 800, ink);
  if (ln.left) o += tx(xr0 - 6, yT - th / 2 + 4, ln.left, 'end', 12, 800, ink);
  if (ln.right) o += tx(xr1 + 6, yT - th / 2 + 4, ln.right, 'start', 12, 800, ink);
  // posts: cut length to scale from the top, blocks drawn on the side the sheet gives them
  P.forEach(function(p, i){
    var x = xs[i], cut = p.cut || ref, yb = yT + cut * s, fl = isFl(p);
    o += '<rect x="' + x + '" y="' + yT + '" width="' + pw + '" height="' + (cut * s) + '" fill="' + ink + '"/>';
    if (!fl){ // end offset plates always run in under the channel; a reverse offset (Rev) runs out the other way.
      // mid plates (Centered / Offset L / Offset R → M, M-Off-L, M-Off-R): the letter is the side the POST sits on, so Offset L's plate runs right
      var inward = i === 0 ? 1 : i === P.length - 1 ? -1 : 0, isEnd = inward !== 0,
          off = isEnd ? (/rev/i.test(p.type) ? -inward : /off/i.test(p.type) ? inward : 0) : (/off-?l\b/i.test(p.type) ? 1 : /off-?r\b/i.test(p.type) ? -1 : 0), pl = 2 * pw, px = x + pw / 2 - pl / 2 + off * (pl / 2 - pw / 2);
      o += '<rect x="' + px + '" y="' + (yb - 4) + '" width="' + pl + '" height="4" fill="#3B5566"/>'; }
    var blk = function(v, side){ if (!v) return ''; var by = yT + v * s, bx = side < 0 ? x - 5 : x + pw, g = side < 0 ? gpx[i - 1] : gpx[i];
      if (g != null && g < 130) return '<rect x="' + bx + '" y="' + by + '" width="5" height="9" fill="#2289BB"/>';
      return '<rect x="' + bx + '" y="' + by + '" width="5" height="9" fill="#2289BB"/>' + tx(side < 0 ? x - 7 : x + pw + 7, by - (side < 0 ? 32 : 14), fmtIn(v), side < 0 ? 'end' : 'start', 12, 800, '#16445F').replace('<text ', '<text paint-order="stroke" stroke="#fff" stroke-width="4" '); };
    o += blk(p.bl, -1) + blk(p.br, 1);
    var lu = up[i] ? 30 : 0;
    o += tx(x + pw / 2, yT - th - 42 - lu, p.n.replace(/^post\s*/i, 'Post '), 'middle', 13, 900, ink) + tx(x + pw / 2, yT - th - 28 - lu, p.type, 'middle', 12, 800, '#2289BB');
    var ly = Math.max(yb, deck + 12) + 18;
    o += tx(x + pw / 2, ly, fmtIn(cut), 'middle', 14, 900, ink);
    if (fl) o += tx(x + pw / 2, ly + 15, cut > ref + 1 / 32 ? 'float · ' + fmtIn(cut - ref) + ' below deck' : 'float · not fastened', 'middle', 11, 700);
  });
  o += ov;   // channel bubbles and shared block labels sit over the posts in narrow sections
  var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg" font-family="Lexend,sans-serif"><defs><pattern id="cphatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" stroke="#9AA8B4" stroke-width="2"/></pattern></defs>' + o + '</svg>';
  var caps = '<b>Rail ' + esc(rail.tag) + ' · side view</b><span>Seen from the deck side, left end on the left. Drawn to scale.</span>' +
    '<span><i class="k pst"></i>Post, cut length under it</span><span><i class="k blk"></i>Block, height from the post top</span><span><i class="k chn"></i>Bottom channel, length in the bubble</span><span><i class="k pkt"></i>Pickets, 3/4&quot; wide, gaps under 4&quot;</span>';
  return '<figure class="cpfig">' + svg + '<figcaption>' + caps + '</figcaption></figure>';
}
// ---------- a job ----------
var cur = null;   // { f, book, items, tab, done, t }
function progKey(id){ return PROG + id; }
function loadProg(id){ return lsGet(progKey(id)) || { t: 0, done: {} }; }
// tick times are packed small (the backend keeps under 8.5k per job): whole minutes, same-minute ticks merged, each stored as the gap from the one before
function packTl(tl){ var m = (tl || []).map(function(t){ return Math.floor(t / 60000); }).sort(function(a, b){ return a - b; }).filter(function(v, i, a){ return !i || v !== a[i - 1]; });
  return m.map(function(v, i){ return (i ? v - m[i - 1] : v).toString(36); }).join('.'); }
function unpackTl(s){ if (!s) return []; var a = String(s).split('.'), v = 0; return a.map(function(x, i){ v = i ? v + parseInt(x, 36) : parseInt(x, 36); return v * 60000; }); }
function progTl(p){ return p ? (p.tlp != null ? unpackTl(p.tlp) : (p.tl || [])) : []; }
var syncTimer = null;
// ---------- progress shared between tablets ----------
// Every tick and untick remembers the second it happened. When two copies meet they merge box by box and the latest change wins,
// so one tablet never wipes out another's ticks. Stored compactly (the backend keeps under 8.5k per job): seconds relative to a base, in base 36 (format 2).
function nowSec(){ return Math.floor(Date.now() / 1000); }
// short box names in storage: 'CUT SHEET|c9:2' is saved as 'C9:2', 'POST SHEET|c13:3' as 'P13:3'
var KEYS_SHORT = [['CUT SHEET|c', 'C'], ['POST SHEET|c', 'P']];
function kShort(k){ for (var i = 0; i < KEYS_SHORT.length; i++) if (k.indexOf(KEYS_SHORT[i][0]) === 0) return KEYS_SHORT[i][1] + k.slice(KEYS_SHORT[i][0].length); return k; }
function kLong(k){ if (k.indexOf('|') >= 0) return k; for (var i = 0; i < KEYS_SHORT.length; i++) if (k.charAt(0) === KEYS_SHORT[i][1] && /^\d/.test(k.charAt(1))) return KEYS_SHORT[i][0] + k.slice(1); return k; }
function decodeProg(p){
  p = p || {}; var b = p.db, d = {}, u = {}, sc = p.v === 2 ? 1 : 60;
  Object.keys(p.done || {}).forEach(function(k0){ var k = kLong(k0); d[k] = b == null ? 1 : Math.max(1, (b + parseInt(p.done[k0], 36)) * sc); });   // older saves stored 1: no time (counts as oldest), any later change wins
  Object.keys(p.un || {}).forEach(function(k0){ var k = kLong(k0); u[k] = b == null ? 1 : Math.max(1, (b + parseInt(p.un[k0], 36)) * sc); });
  return { t: p.t || 0, tot: p.tot || 0, name: p.name, done: d, un: u, tl: progTl(p), tla: unpackTl(p.tlap), fin: p.fin || null, asm: p.asm || null, finX: p.finX || 0, asmX: p.asmX || 0 };
}
function encodeProg(s){
  var ts = []; [s.done, s.un].forEach(function(o){ Object.keys(o).forEach(function(k){ ts.push(o[k]); }); });
  var b = ts.length ? Math.min.apply(null, ts) : 0, rel = function(o){ var r = {}; Object.keys(o).forEach(function(k){ r[kShort(k)] = (o[k] - b).toString(36); }); return r; };
  return { v: 2, t: s.t, tot: s.tot || 0, name: s.name, db: b, done: rel(s.done), un: rel(s.un), tlp: packTl(s.tl), tlap: packTl(s.tla), fin: s.fin || null, asm: s.asm || null, finX: s.finX || 0, asmX: s.asmX || 0 };
}
function mergeProg(a, b){
  var m = { t: Math.max(a.t || 0, b.t || 0), tot: Math.max(a.tot || 0, b.tot || 0), name: a.name || b.name, done: {}, un: {} }, keys = {};
  [a.done, a.un, b.done, b.un].forEach(function(o){ Object.keys(o).forEach(function(k){ keys[k] = 1; }); });
  Object.keys(keys).forEach(function(k){
    var tick = Math.max(a.done[k] != null ? a.done[k] : -1, b.done[k] != null ? b.done[k] : -1), un = Math.max(a.un[k] != null ? a.un[k] : -1, b.un[k] != null ? b.un[k] : -1);
    if (tick >= 0 && tick >= un) m.done[k] = tick; else if (un >= 0) m.un[k] = un;
  });
  var uniq = function(x, y){ var seen = {}; return x.concat(y).filter(function(t){ var q = Math.floor(t / 60000); if (seen[q]) return false; seen[q] = 1; return true; }); };
  m.tl = uniq(a.tl, b.tl); m.tla = uniq(a.tla, b.tla);
  // sign-offs: the latest of a sign-off or an undo wins
  ['fin', 'asm'].forEach(function(s){
    var x = s + 'X', best = null, bestT = -1;
    [a, b].forEach(function(o){ if (o[s] && o[s].at > bestT){ best = o[s]; bestT = o[s].at; } });
    var undo = Math.max(a[x] || 0, b[x] || 0);
    m[s] = undo > bestT ? null : best; m[x] = undo;
  });
  return m;
}
function curState(){ return { t: cur.t || 0, tot: cur.tot || 0, name: cur.f.name, done: cur.done, un: cur.un || {}, tl: cur.tl || [], tla: cur.tla || [], fin: cur.fin || null, asm: cur.asm || null, finX: cur.finX || 0, asmX: cur.asmX || 0 }; }
function applyState(s){ cur.t = s.t; cur.done = s.done; cur.un = s.un; cur.tl = s.tl; cur.tla = s.tla; cur.fin = s.fin; cur.asm = s.asm; cur.finX = s.finX; cur.asmX = s.asmX; }
function setTick(key, on){ var m = nowSec(); cur.un = cur.un || {}; if (on){ cur.done[key] = m; delete cur.un[key]; } else { delete cur.done[key]; cur.un[key] = m; } }
function wLoad(id){ return decodeProg(lsGet(WPROG + id)); }
function wSave(id, w){ lsSet(WPROG + id, encodeProg(w)); }
function writeWSum(id, w, n){ var old = lsGet(WSUM + id) || {}, nn = n != null ? n : (old.n || w.tot || 0), d = Object.keys(w.done).length; lsSet(WSUM + id, { d: nn ? Math.min(d, nn) : d, n: nn, fin: w.fin || null }); }
function setWTick(key, on){ var m = nowSec(), w = cur.w; if (on){ w.done[key] = m; delete w.un[key]; w.tl.push(Date.now()); } else { delete w.done[key]; w.un[key] = m; } }
function saveW(){
  if (!cur) return;
  cur.w.t = Date.now(); cur.w.name = cur.f.name; cur.w.tot = weldKeys().length;
  wSave(cur.f.id, cur.w); writeWSum(cur.f.id, cur.w, cur.w.tot);
  clearTimeout(syncTimer); syncTimer = setTimeout(syncNow, 800);
}
function writeSum(id, s, total){ var old = lsGet(SUM + id) || {}; lsSet(SUM + id, { done: s.dn != null ? s.dn : old.done, total: total != null ? total : old.total, fin: s.fin || null, asm: s.asm || null }); }
function saveLocal(){
  if (!cur) return;
  var tot = 0, dn = 0; cur.items.forEach(function(it){ var ks = itemKeys(it); tot += ks.length; ks.forEach(function(k){ if (cur.done[it.sh.name + '|' + k]) dn++; }); });
  cur.tot = tot; lsSet(progKey(cur.f.id), encodeProg(curState()));
  writeSum(cur.f.id, { dn: dn, fin: cur.fin, asm: cur.asm }, tot);
}
function saveProg(){
  if (!cur) return;
  cur.t = Date.now(); saveLocal();
  if (cur.f.remake && cur.tot && cutKeys('cut').concat(cutKeys('asm')).every(function(k){ return cur.done[k]; })) remakeDone(cur.f.remake);
  clearTimeout(syncTimer); syncTimer = setTimeout(syncNow, 800);
}
// pull the backend copy, merge, show any changes from the other tablet, push back what the backend is missing
var syncing = false, syncAgain = false;
function syncNow(){
  if (!cur) return;
  if (syncing){ syncAgain = true; return; }
  syncing = true; var id = cur.f.id, changed = false;
  var live = function(){ return cur && cur.f.id === id; }, enc = function(x){ return JSON.stringify(encodeProg(x)); };
  // the shop's record (cutting + assembly): Shop Cuts merges both ways; Shop Welds only reads it
  var main = api('progget', { id: id }).then(function(r){
    if (!live()) return;
    var remote = decodeProg(r.prog ? JSON.parse(r.prog) : null), mine = curState(), m = mergeProg(mine, remote), mJ = enc(m);
    if (mJ !== enc(mine)){ applyState(m); saveLocal(); changed = true; }
    if (!WELD && mJ !== enc(remote)) return api('progset', { id: id, prog: mJ });
  }).catch(function(){});
  // the weld record: Shop Welds merges both ways; Shop Cuts only reads it, once the job is assembled
  var wanted = WELD || cur.asm || cur.w.fin || Object.keys(cur.w.done).length;
  var weld = !wanted ? Promise.resolve() : api('progget', { id: wId(id) }).then(function(r){
    if (!live()) return;
    var remote = decodeProg(r.prog ? JSON.parse(r.prog) : null), mine = cur.w, m = mergeProg(mine, remote), mJ = enc(m);
    if (mJ !== enc(mine)){ cur.w = m; wSave(id, m); writeWSum(id, m); changed = true; }
    if (WELD && mJ !== enc(remote)) return api('progset', { id: wId(id), prog: mJ });
  }).catch(function(){});
  Promise.all([main, weld]).then(function(){
    if (changed && live()){ var y = window.scrollY; renderCur(); window.scrollTo(0, y); }
    syncing = false; if (syncAgain){ syncAgain = false; syncNow(); }
  });
}
// live: an open job checks for the other tablet's ticks every 30 seconds, and straight away when the app comes back to the front
setInterval(function(){ if (cur && !document.hidden && !el('job').hidden) syncNow(); }, 30000);
document.addEventListener('visibilitychange', function(){ if (!document.hidden){ if (cur && !el('job').hidden) syncNow(); else if (!el('list').hidden) loadList(); } });
// the job list re-checks Drive every minute while it's on screen (new jobs, priority changes from the office)
setInterval(function(){ if (!document.hidden && !el('list').hidden && el('modal').hidden) loadList(); }, 60000);
// the job list: pull every job's progress so the counts and sign-offs match the other tablet
function pullW(id){
  return api('progget', { id: wId(id) }).then(function(r){
    wChecked[id] = 1; if (!r.prog) return;
    var m = mergeProg(wLoad(id), decodeProg(JSON.parse(r.prog)));
    wSave(id, m); writeWSum(id, m);
  });
}
function mgrDone(){ return (doneJobs || []).filter(function(d){ return d.doneAt >= WELD_START && !wLoad(d.id).fin; }); }
function pullAll(then){
  var mgrOn = !el('mgr').hidden;
  return Promise.all(jobs.concat(WELD ? [] : remakes.map(remakeJob)).map(function(f){
    return api('progget', { id: f.id }).then(function(r){
      var m = decodeProg(lsGet(progKey(f.id)));
      if (r.prog){
        m = mergeProg(m, decodeProg(JSON.parse(r.prog)));
        lsSet(progKey(f.id), encodeProg(m));
        var old = lsGet(SUM + f.id) || {}, dn = Object.keys(m.done).length, tot = m.tot || old.total;
        writeSum(f.id, { dn: tot ? Math.min(dn, tot) : dn, fin: m.fin, asm: m.asm }, tot || undefined);
      }
      // weld progress: always on the weld tablet and the manager screen; on the shop tablets only once a job is assembled
      if (WELD || mgrOn || m.asm) return pullW(f.id);
    }).catch(function(){});
  }).concat(lateCand().map(function(f){ return pullW(f.id).catch(function(){}); }), !mgrOn ? [] : mgrDone().map(function(d){
    // manager screen: jobs completed since welding started that this device hasn't got the records for yet (asked for once each)
    return pullW(d.id).then(function(){ if (lsGet(progKey(d.id))) return; return api('progget', { id: d.id }).then(function(r){ if (r.prog) lsSet(progKey(d.id), encodeProg(decodeProg(JSON.parse(r.prog)))); }); }).catch(function(){});
  }))).then(function(){ if (!el('list').hidden) renderList(false); else if (!el('mgr').hidden) renderMgr(); catchUpCompleted(); prefetch(); if (then) then(); });
}
function counts(it){
  if (WELD){ if (it.sh.name !== 'CUT SHEET') return { d: 0, n: 0 }; var wk = weldRows(it); return { d: wk.filter(function(x){ return cur.w.done[x.key]; }).length, n: wk.length }; }
  var ks = itemKeys(it), d = ks.filter(function(k){ return cur.done[it.sh.name + '|' + k]; }).length; return { d: d, n: ks.length }; }
function renderTabs(){
  el('tabs').innerHTML = cur.items.map(function(it, k){
    var c = counts(it);
    return '<button type="button" class="tab' + (k === cur.tab ? ' on' : '') + (c.n && c.d === c.n ? ' full' : '') + '" data-tab="' + k + '" role="tab" aria-selected="' + (k === cur.tab) + '">' + esc(WELD && WELD_BOXES && it.sh.name === 'CUT SHEET' ? 'Welds' : it.label) + (c.n ? '<small>' + c.d + '/' + c.n + '</small>' : '') + '</button>';
  }).join('');
  var tot = 0, dn = 0; cur.items.forEach(function(it){ var c = counts(it); tot += c.n; dn += c.d; });
  el('jobBar').style.width = (WELD && !WELD_BOXES ? (cur.w.fin ? 100 : 0) : tot ? Math.round(dn / tot * 100) : 0) + '%';
  el('jobSub').textContent = WELD && !WELD_BOXES ? (cur.w.fin ? 'Welded · ' + cur.w.fin.by : asmOK() ? 'Ready to weld' : 'Still in the shop') : WELD ? (tot ? dn + ' of ' + tot + ' welded' : 'Nothing to weld on this job') : (tot ? dn + ' of ' + tot + ' ticked' : 'Ready to fab');
}
function renderCur(){
  var it = cur.items[cur.tab];
  el('sheet').innerHTML = renderSheet(cur.book, it, cur.done);
  fitSheet();
  var c = counts(it);
  renderFin(); if (cur.f.hold) el('fin').hidden = true;
  if (cur.f.hold) el('legend').innerHTML = '<span class="holdnote">' + LOCK + ' On hold: the office has this ready, but don’t start it yet. Look only, nothing ticks.</span>';
  else if (WELD && !WELD_BOXES) el('legend').innerHTML = '<span>This tablet is for looking: the small boxes show what the shop has cut and assembled. When the whole job is welded, sign off Welding complete.</span>';
  else if (WELD) el('legend').innerHTML = c.n ? '<span>Tap a rail’s Weld box when it’s welded. Tap again to undo. The small boxes show what the shop has cut and assembled.</span>' : '<span>Here to look at. Welds are ticked on the Welds tab.</span>';
  else el('legend').innerHTML = it.view ? '<span>Totals for the job. Nothing to tick here.</span>' : (c.n ? '<span>Tap a box when it’s cut. Tap again to undo.</span>' : '');
  renderTabs();
}
// shrink a wide sheet to fit the screen (down to 75%), then scroll sideways if it still doesn't fit
function fitSheet(){
  var t = el('sheet').querySelector('table.sheet'), w = el('sheet').parentNode; if (!t) return;
  t.style.zoom = 1; var z = Math.min(1, (w.clientWidth - 4) / t.scrollWidth);
  t.style.zoom = Math.max(0.75, z);
  // sticky offsets inside a zoomed table get zoomed too, so the headings' offset is divided back out
  t.style.setProperty('--z', Math.max(0.75, z));
  // when it fits, let the column headings stick to the top while scrolling down
  w.style.overflowX = t.scrollWidth * Math.max(0.75, z) <= w.clientWidth + 2 ? 'visible' : 'auto';
}
window.addEventListener('resize', function(){ if (cur) fitSheet(); });
// the job header + tabs tuck away while scrolling down the sheet and come straight back on the way up
(function(){
  var lastY = window.scrollY, ticking = false, top = el('jobtop');
  function setH(){ document.documentElement.style.setProperty('--toph', top.offsetHeight + 'px'); }
  function tuck(on){ if (document.body.classList.contains('tuck') !== on) document.body.classList.toggle('tuck', on); }
  function onScroll(){
    ticking = false;
    var y = window.scrollY, d = y - lastY;
    if (el('job').hidden || y < top.offsetHeight){ tuck(false); lastY = y; return; }
    if (d > 8){ tuck(true); lastY = y; }        // going down: hide
    else if (d < -4){ tuck(false); lastY = y; } // any move back up: show
  }
  window.addEventListener('scroll', function(){ if (!ticking){ ticking = true; requestAnimationFrame(onScroll); } }, { passive: true });
  window.addEventListener('resize', setH);
  if (window.ResizeObserver) new ResizeObserver(setH).observe(top);
  setH();
})();
el('tabs').addEventListener('click', function(e){ var b = e.target.closest('[data-tab]'); if (!b) return; cur.tab = +b.getAttribute('data-tab'); lsSet(UI + 'tab:' + cur.f.id, cur.tab); renderCur(); window.scrollTo(0, 0); });
el('sheet').addEventListener('click', function(e){
  if (!cur) return;
  if (cur.f.hold && !e.target.closest('.laybtn,[data-sort],[data-act="laysall"]')){ if (e.target.closest('td.chk,td.wchk,tr[data-row],[data-pk],[data-act="secall"]')) msg('This job is on hold. Look only, don’t start it yet.', true); return; }
  var wt = e.target.closest('td.wchk');
  if (wt){ var wk = wt.getAttribute('data-wkey'); setWTick(wk, !cur.w.done[wk]); saveW(); var yw = window.scrollY; renderCur(); window.scrollTo(0, yw); return; }
  if (WELD && !e.target.closest('.laybtn')) return;   // the welder's tablet only ticks welds (and opens layouts)
  var pkb = e.target.closest('[data-pk]');
  if (pkb && cur){ setTick(PK_KEY, pkb.getAttribute('data-pk') === '1'); saveProg(); var y2 = window.scrollY; renderCur(); window.scrollTo(0, y2); return; }
  var sbb = e.target.closest('[data-sort]');
  if (sbb){ cur.sort = sbb.getAttribute('data-sort'); lsSet('shop-sort:' + cur.f.id, cur.sort); msg(''); var y1 = window.scrollY; renderCur(); window.scrollTo(0, y1); return; }
  var pa = e.target.closest('[data-act="secall"]');
  if (pa){
    var sr = +pa.getAttribute('data-sec'), ps = sheetSections(cur.items[cur.tab]).filter(function(sc){ return sc.row === sr; })[0]; if (!ps) return;
    var all = ps.keys.every(function(k){ return cur.done[k]; }), was = postsCutDone();
    var go = function(){ var y = window.scrollY; if (all) ps.keys.forEach(function(k){ setTick(k, false); }); else { ps.keys.forEach(function(k){ if (!cur.done[k]) setTick(k, true); }); stamp(/^(block|bracket)/i.test(ps.label) ? 'asm' : 'cut'); } saveProg(); renderCur(); window.scrollTo(0, y); blockCheck(was); };
    if (all) confirmBox('Untick everything under “' + topWords(ps.label).replace(/ (cut|done)$/, '') + '”?', go); else go();
    return;
  }
  if (e.target.closest('[data-act="laysall"]')){ cur.showLays = !cur.showLays; var y2 = window.scrollY; renderCur(); window.scrollTo(0, y2); return; }
  var lb = e.target.closest('.laybtn');
  if (lb){ var un = lb.getAttribute('data-unit'); cur.open[un] = !layOpen(un); var y0 = window.scrollY; renderCur(); window.scrollTo(0, y0); return; }
  var td = e.target.closest('td.chk'), tr = e.target.closest('tr[data-row]'), key = td ? td.getAttribute('data-key') : tr ? tr.getAttribute('data-row') : null;
  if (!key) return;
  var was = postsCutDone(), topWas = topRailsDone();
  if (cur.done[key]) setTick(key, false); else { setTick(key, true); stamp(tickKind(key)); }
  if (!topWas && topRailsDone() && (cur.sort === 'long' || cur.sort === 'short' || cur.sort === 'opt')){
    // every top rail is cut: he moves on to channels, so the list does too
    cur.sort = cur.sort === 'short' ? 'cshort' : 'clong'; lsSet('shop-sort:' + cur.f.id, cur.sort);
    saveProg(); renderCur(); window.scrollTo(0, 0);
    msg('All top rails are cut. Now sorted by ' + (cur.sort === 'clong' ? 'Longest' : 'Shortest') + ' Channel.', true);
    return;
  }
  saveProg(); var y = window.scrollY; renderCur(); window.scrollTo(0, y); blockCheck(was);
});
function openJob(f){
  msg('');
  var show = function(b64, note){
    return parseBook(b64).then(function(book){
      rememberInfo(f, book);
      if (book.raw){
        cur = null; el('list').hidden = false; el('job').hidden = true;
        msg('“' + f.name.replace(/\.xlsx$/i, '') + '” hasn’t been opened and saved in Excel yet, so its numbers aren’t worked out. Ask the office to open it in Excel, save it, then refresh.');
        return;
      }
      return shopSheets(book).then(function(items){
        items.forEach(function(it){ it.L = layout(book, it); });
        if (f.remake){ items = items.filter(function(it){ return it.sh.name === 'CUT SHEET'; }); items.forEach(function(it){ remakeTrim(it.L, f.remake.tags); }); }
        var p = loadProg(f.id), tab0 = lsGet(UI + 'tab:' + f.id);
        var cutsTab = items.map(function(it){ return it.sh.name; }).indexOf('CUT SHEET');
        var ds = decodeProg(p); cur = { f: f, book: book, items: items, t: ds.t, done: ds.done, un: ds.un, tl: ds.tl, tla: ds.tla, fin: ds.fin, asm: ds.asm, finX: ds.finX, asmX: ds.asmX, w: wLoad(f.id), sort: WELD ? '' : (lsGet('shop-sort:' + f.id) || ''), tab: tab0 != null && tab0 < items.length && !WELD ? tab0 : (cutsTab >= 0 ? cutsTab : 0), units: {}, open: {} };
        var inSh = book.sheets.filter(function(s){ return s.name === 'INPUT'; })[0];
        if (inSh) return parseSheet(book, inSh).then(function(sd){
          cur.units = readUnits(sd); cur.block = readBlock(sd); cur.mount = cellVal(sd, 7, 2); cur.post = cellVal(sd, 10, 2);
          // top mount: the welder starts on the Post Sheet (post numbers and base plates)
          if (WELD && isTop()){ var pi = items.map(function(it){ return it.sh.name; }).indexOf('POST SHEET'); if (pi >= 0) cur.tab = pi; }
          return items;
        });
        return items;
      }).then(function(items){
        el('jobName').textContent = f.name.replace(/\.xlsx$/i, '');
        el('list').hidden = true; el('job').hidden = false; window.scrollTo(0, 0);
        renderCur(); saveLocal();
        try { localStorage.setItem(UI + 'open', f.id); } catch (e) {}
        msg(note || '', true);
        // pick up ticks made on the other tablet (merged, never overwritten)
        syncNow();
      });
    }).catch(function(e){ msg('Couldn’t read that cut sheet: ' + (e && e.message ? e.message : e)); });
  };
  var fid = f.src || f.id;   // a remake opens its job's file
  fileGet(fid).then(function(local){
    if (local && local.updated >= f.updated) return show(local.b64);
    msg('Opening ' + f.name.replace(/\.xlsx$/i, '') + '…', true);
    return apiNew('fabopen2', 'fabopen', { id: fid }).then(function(r){
      filePut({ id: fid, name: f.name, updated: f.updated, b64: r.b64 });
      return show(r.b64, local ? 'A newer version came in from the office.' : '');
    }, function(e){
      if (local) return show(local.b64, 'No signal, so this is the copy saved on the tablet.');
      if (e.code === 'pin') return askPin('Enter the crew PIN once on this tablet.', function(){ openJob(f); });
      msg('Couldn’t open it (' + (e.message || 'no signal') + '). Open it once with signal and it stays on the tablet.');
    });
  });
}
// ---------- Job complete: appears on the Cut Sheet once every box there is ticked ----------
var SHOP_CREW = ['Dave', 'Jim'], WELD_CREW = ['Ian'], CREW = WELD ? WELD_CREW : SHOP_CREW;
var FIELD_CREW = [];   // field employees who sometimes help in the shop; names typed on the tablet are remembered too
function otherNames(){ var a = (WELD ? SHOP_CREW : WELD_CREW).concat(FIELD_CREW, lsGet('shop-others') || []), seen = {}; return a.filter(function(n){ var k = n.toLowerCase(); if (seen[k] || CREW.some(function(s){ return s.toLowerCase() === k; })) return false; seen[k] = 1; return true; }).sort(); }
function cutItem(){ return cur && cur.items.filter(function(it){ return it.sh.name === 'CUT SHEET'; })[0]; }
// two sign-offs on the Cut Sheet: Cutting complete once every Top rail and Channel box is ticked,
// Assembly complete once every Rail tag box is ticked
var STAGES = [
  { k: 'fin', kind: 'cut', title: 'Cutting complete', ask: 'Every top rail and channel is ticked. Who finished cutting?', un: 'Some top rail or channel boxes were unticked after cutting was signed off.' },
  { k: 'asm', kind: 'asm', title: 'Assembly complete', ask: 'Every rail tag is ticked. Who finished assembly?', un: 'Some rail tags were unticked after assembly was signed off.' }
];
var WSTAGE = { k: 'wld', title: 'Welding complete', ask: WELD_BOXES ? 'Every rail is ticked. Who finished welding?' : 'Tap your name when this whole job is welded.', un: 'Some rails were unticked after welding was signed off.' };
function asmOK(){ return !!(cur.asm || cur.f.late || isPreview()); }
function stageCard(st, all, rec){
  var k = st.k;
  if (rec){
    var at = new Date(rec.at);
    return '<div class="fin complete"><div class="fh"><span class="fbox on">✓</span><div><b>' + st.title + '</b><span>' + esc(rec.by) + ' · ' + esc(at.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })) + ', ' + esc(at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })) + '</span></div></div>' +
      (!all ? '<p class="fnote">' + st.un + '</p>' : '') +
      '<div class="frow"><button type="button" class="btn" data-fin="undo" data-st="' + k + '">Undo ' + st.title.toLowerCase() + '</button></div></div>';
  }
  return '<div class="fin"><div class="fh"><span class="fbox"></span><div><b>' + st.title + '</b><span>' + st.ask + '</span></div></div>' +
    '<div class="frow">' + CREW.map(function(n){ return '<button type="button" class="btn pri big" data-fin="name" data-st="' + k + '" data-n="' + esc(n) + '">' + esc(n) + '</button>'; }).join('') +
    '<button type="button" class="btn big" data-fin="other" data-st="' + k + '">Other…</button></div>' +
    '<div class="frow fother" id="other_' + k + '" hidden><select id="sel_' + k + '" aria-label="Who finished ' + st.title.toLowerCase() + '">' +
    otherNames().map(function(n){ return '<option>' + esc(n) + '</option>'; }).join('') + '<option value="__new">Someone else (type a name)</option></select>' +
    '<input id="new_' + k + '" type="text" placeholder="Name" autocomplete="off" aria-label="Name" hidden><button type="button" class="btn pri big" data-fin="otherok" data-st="' + k + '">Done</button></div></div>';
}
function renderFin(){
  var box = el('fin'), ci = cutItem(), it = cur.items[cur.tab];
  var onIt = ci ? it === ci : !!(it && (SCREEN_RE.test(it.sh.name) || it.virt));   // screen jobs: under the Screens and Posts tabs
  if ((!WELD && !onIt) || cur.f.remake){ box.hidden = true; return; }   // remakes clear themselves when every box is ticked   // the weld tablet shows its sign-off under every tab
  var h = '', when = function(rec){ var at = new Date(rec.at); return esc(rec.by) + ' · ' + esc(at.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })) + ', ' + esc(at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })); };
  if (WELD){
    var allW = weldAll();
    if (cur.w.fin || (allW && asmOK())) h = stageCard(WSTAGE, allW, cur.w.fin);
    else if (allW) h = '<div class="fin"><div class="fh"><span class="fbox"></span><div><b>Still in the shop</b><span>Welding complete can be signed off here once Assembly complete is signed off in Shop Cuts.</span></div></div></div>';
  } else {
    var SCR_ASK = { fin: ['Every top rail, channel and post is ticked. Who finished cutting?', 'Some cut boxes were unticked after cutting was signed off.'], asm: ['Every screen is ticked as assembled. Who finished assembly?', 'Some screens were unticked after assembly was signed off.'] };
    STAGES.forEach(function(st){ if (!ci) st = Object.assign({}, st, { ask: SCR_ASK[st.k][0], un: SCR_ASK[st.k][1] }); var all = allDone(cutKeys(st.kind)); if (all || cur[st.k]) h += stageCard(st, all, cur[st.k]); });
    // welding is the last stage and is signed off on the weld tablet; here it only shows where the job is at
    if (cur.w.fin) h += '<div class="fin complete"><div class="fh"><span class="fbox on">✓</span><div><b>Welding complete</b><span>' + when(cur.w.fin) + '</span></div></div></div>';
    else if (cur.asm){ var wn = weldKeys().length, wd = Math.min(wn, Object.keys(cur.w.done).length); h += '<div class="fin"><div class="fh"><span class="fbox"></span><div><b>At welding</b><span>' + (wd ? wd + ' of ' + wn + ' rails welded. ' : '') + 'The job is on the weld tablet now. It moves to Completed when Welding complete is signed off there.</span></div></div></div>'; }
  }
  box.hidden = !h; box.innerHTML = h;
  (WELD ? [WSTAGE] : STAGES).forEach(function(st){
    var sel = el('sel_' + st.k), nw = el('new_' + st.k); if (!sel) return;
    var sync = function(){ nw.hidden = sel.value !== '__new'; if (!nw.hidden) setTimeout(function(){ nw.focus(); }, 50); };
    sel.onchange = sync; sync();
  });
}
function signOff(k, name){
  name = String(name || '').trim(); if (!name) return;
  if (!SHOP_CREW.concat(WELD_CREW, FIELD_CREW).some(function(n){ return n.toLowerCase() === name.toLowerCase(); })){
    var o = lsGet('shop-others') || []; if (!o.some(function(n){ return n.toLowerCase() === name.toLowerCase(); })){ o.push(name); lsSet('shop-others', o); }
  }
  var y = window.scrollY;
  // Welding complete is the last sign-off: it sends the hard copy and moves the job to Completed
  if (k === 'wld'){ cur.w.fin = { by: name, at: Date.now() }; saveW(); renderCur(); window.scrollTo(0, y); sendComplete(); return; }
  cur[k] = { by: name, at: Date.now() }; saveProg(); renderCur(); window.scrollTo(0, y);
}
el('fin').addEventListener('click', function(e){
  var b = e.target.closest('[data-fin]'); if (!b || !cur) return;
  var a = b.getAttribute('data-fin'), k = b.getAttribute('data-st'), st = (WELD ? [WSTAGE] : STAGES).filter(function(s){ return s.k === k; })[0]; if (!st) return;
  if (a === 'name') signOff(k, b.getAttribute('data-n'));
  else if (a === 'other'){ var o = el('other_' + k); o.hidden = !o.hidden; }
  else if (a === 'otherok'){ var sel = el('sel_' + k); if (sel.value === '__new'){ var v = el('new_' + k).value.trim(); if (!v) return el('new_' + k).focus(); signOff(k, v); } else signOff(k, sel.value); }
  else if (a === 'undo') confirmBox('Undo ' + st.title.toLowerCase() + ' for ' + cur.f.name.replace(/\.xls[xm]$/i, '') + '?', function(){ if (k === 'wld'){ cur.w.fin = null; cur.w.finX = Date.now(); saveW(); renderCur(); unComplete(cur.f.id); } else { cur[k] = null; cur[k + 'X'] = Date.now(); saveProg(); renderCur(); } });
});
// ---------- completed jobs: PDF hard copy to Drive, file moved to Completed ----------
// queued on the tablet when there's no signal (or Apps Script isn't updated yet) and sent next time the list loads
function pending(){ return lsGet('shop-pending') || []; }
function sendComplete(){
  if (!cur || !cur.w.fin) return;
  var job = { id: cur.f.id, name: cur.f.name, by: cur.w.fin.by, at: cur.w.fin.at, html: printHtml() };
  lsSet('shop-pending', pending().filter(function(p){ return p.id !== job.id; }).concat([job]));
  flushPending(true);
}
function unComplete(id){
  lsSet('shop-pending', pending().filter(function(p){ return p.id !== id; }));
  api('uncomplete', { id: id }).catch(function(){});
}
// catch-up (Shop Welds only): a job whose Welding complete was signed off on another weld tablet
// but is still in Ready To Fab gets its hard copy made here and is moved to Completed
var catching = {};
function catchUpCompleted(){
  if (!WELD) return;
  jobs.forEach(function(f){
    if (!wLoad(f.id).fin || catching[f.id] || pending().some(function(x){ return x.id === f.id; })) return;
    catching[f.id] = 1;
    fileGet(f.id).then(function(local){
      return local && local.b64 ? local.b64 : apiNew('fabopen2', 'fabopen', { id: f.id }).then(function(r){ filePut({ id: f.id, name: f.name, updated: f.updated, b64: r.b64 }); return r.b64; });
    }).then(function(b64){ return parseBook(b64); }).then(function(book){
      if (book.raw) return;
      return shopSheets(book).then(function(items){
        items.forEach(function(it){ it.L = layout(book, it); });
        var q = decodeProg(lsGet(progKey(f.id))), w = wLoad(f.id); if (!w.fin) return;
        lsSet('shop-pending', pending().filter(function(x){ return x.id !== f.id; }).concat([{ id: f.id, name: f.name, by: w.fin.by, at: w.fin.at, html: printHtml({ name: f.name, items: items, done: q.done, fin: q.fin, asm: q.asm, w: w }) }]));
        flushPending(false);
      });
    }).catch(function(){}).then(function(){ setTimeout(function(){ delete catching[f.id]; }, 60000); });
  });
}
var flushing = false;
function flushPending(say){
  var list = pending(); if (!list.length || flushing) return; flushing = true;
  var job = list[0];
  api('complete', { id: job.id, by: job.by, at: job.at, html: job.html }).then(function(r){
    lsSet('shop-pending', pending().filter(function(p){ return p.id !== job.id; }));
    if (say && !r.preview) msg('Job complete. The PDF is saved in “Shop Cuts Completed” on Drive, and the job moved to Completed.', true);
    flushing = false; if (pending().length) flushPending(false); else if (!el('list').hidden) loadList();
  }, function(e){
    flushing = false;
    if (say) msg('Job complete. The Drive copy will be saved next time there’s signal' + (e && /unknown request/i.test(e.message || '') ? ' (the office needs to update the Apps Script)' : '') + '.', true);
  });
}
// the hard copy: every tab as the shop saw it, with ticks and who signed off; layouts and fab times are left out
function printHtml(o){
  o = o || { name: cur.f.name, items: cur.items, done: cur.done, fin: cur.fin, asm: cur.asm, w: cur.w };
  var c = function(x){ return esc(x); }, when = function(r){ return r ? c(r.by) + ', ' + c(new Date(r.at).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })) : '—'; };
  var h = '<html><head><meta charset="utf-8"></head><body style="font-family:Arial,sans-serif;font-size:10pt;color:#222">' +
    '<h1 style="font-size:18pt;margin:0 0 4pt">' + c(o.name.replace(/\.xls[xm]$/i, '')) + '</h1>' +
    '<p style="margin:0 0 2pt"><b>Cutting complete:</b> ' + when(o.fin) + '</p><p style="margin:0 0 2pt"><b>Assembly complete:</b> ' + when(o.asm) + '</p><p style="margin:0 0 10pt"><b>Welding complete:</b> ' + when(o.w && o.w.fin) + '</p>';
  o.items.forEach(function(it){
    var L = it.L, pre = it.sh.name + '|', wr = {}, wc = false;
    if (it.sh.name === 'CUT SHEET' && o.w) weldRows(it).forEach(function(x){ wr[x.row] = x.key; wc = true; });
    h += '<h2 style="font-size:13pt;margin:14pt 0 4pt">' + c(it.label) + '</h2><table style="border-collapse:collapse;width:100%;font-size:9pt">';
    L.rows.forEach(function(r){
      var rc = L.cols.filter(function(cc){ return L.chk[r + ':' + cc]; }), allOn = rc.length && rc.every(function(cc){ return o.done[pre + 'c' + r + ':' + cc]; });
      h += '<tr' + (allOn ? ' style="background:#DCEFD8"' : '') + '>';
      if (wc) h += '<td style="border:1px solid #ccc;padding:2pt 4pt;' + (r === L.hdr ? 'background:#E7DFCF;font-weight:bold;' : '') + '">' + (r === L.hdr ? 'Weld' : wr[r] ? (o.w.done[wr[r]] ? '<b style="color:#2E6B2A">&#10003;</b>' : '<span style="color:#999">&#9633;</span>') : '') + '</td>';
      L.cols.forEach(function(cc){
        var k = r + ':' + cc, t;
        if (L.chk[k]) t = o.done[pre + 'c' + k] ? '<b style="color:#2E6B2A">&#10003;</b>' : '<span style="color:#999">&#9633;</span>';
        else t = c(L.txt(r, cc));
        h += '<td style="border:1px solid #ccc;padding:2pt 4pt;' + (r === L.hdr ? 'background:#E7DFCF;font-weight:bold;' : '') + '">' + t + '</td>';
      });
      h += '</tr>';
    });
    h += '</table>';
  });
  return h + '<p style="color:#888;font-size:8pt;margin-top:12pt">Saved by ' + (WELD ? 'Shop Welds' : 'Shop Cuts') + ' ' + c(new Date().toLocaleString()) + '</p></body></html>';
}
function confirmBox(text, then){
  var m = el('modal'); el('modalText').textContent = text; el('modalInput').hidden = true; m.hidden = false;
  el('modalNo').onclick = function(){ m.hidden = true; };
  el('modalYes').onclick = function(){ m.hidden = true; then(); };
}

// ---------- fab time: worked out from when boxes were ticked; only shown in the manager view ----------
// The manager PIN is checked by the Crew Job Board backend (kept in its Script Properties), so it isn't in this public code.
var MGR_API = 'https://script.google.com/macros/s/AKfycbydlE5l182hcs9PaOOMDPzRwoBIiyzwkDopbVJihlxNc3EHLLZeaEkeKofZ7PnaWnXH/exec';
function checkMgrPin(pin){
  return fetch(MGR_API, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action: 'checkPin', pin: pin }) })
    .then(function(r){ return r.json(); }).then(function(r){ return !!(r && r.ok); });
}
var GAP = 25 * 60000;   // a gap longer than this between ticks is a break, overnight or weekend, and isn't counted
function fabTime(p, kind){
  var asm = kind === 'asm', tl = asm ? unpackTl(p.tlap) : progTl(p), ts = tl.slice(), so = asm ? p.asm : p.fin; if (so) ts.push(so.at);
  ts.sort(function(a, b){ return a - b; });
  var act = 0, i; for (i = 1; i < ts.length; i++){ var g = ts[i] - ts[i - 1]; if (g <= GAP) act += g; }
  return { active: act, first: ts[0] || 0, last: ts[ts.length - 1] || 0, ticks: tl.length };
}
function hm(ms){ var m = Math.round(ms / 60000), h = Math.floor(m / 60); return h ? h + 'h ' + (m % 60 < 10 ? '0' : '') + (m % 60) + 'm' : m + 'm'; }
function day(t){ return new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' }); }
function renderMgr(){
  renderPrio();
  // jobs in Ready to Fab, plus any job this tablet has ticked that has since left the folder
  var list = jobs.map(function(f){ return { id: f.id, name: f.name }; }), ids = {};
  list.forEach(function(j){ ids[j.id] = 1; });
  try { for (var i = 0; i < localStorage.length; i++){ var k = localStorage.key(i); if (k.indexOf(PROG) !== 0) continue; var id = k.slice(PROG.length), pp = lsGet(k); if (!ids[id] && pp && pp.name && (pp.tlp || pp.tlap || (pp.tl || []).length || pp.fin || pp.asm)){ ids[id] = 1; list.push({ id: id, name: pp.name }); } } } catch (e) {}
  (doneJobs || []).forEach(function(d){ if (!ids[d.id] && (lsGet(WPROG + d.id) || lsGet(progKey(d.id)))){ ids[d.id] = 1; list.push({ id: d.id, name: d.name }); } });
  var rows = list.map(function(f){
    var p = loadProg(f.id), w = lsGet(WPROG + f.id) || {}, ft = fabTime(p, 'cut'), fa = fabTime(p, 'asm'), fw = fabTime(w, 'cut'), nm = esc(f.name.replace(/\.xls[xm]$/i, ''));
    var first = Math.min(ft.first || Infinity, fa.first || Infinity, fw.first || Infinity), last = Math.max(ft.last, fa.last, fw.last);
    if (!ft.ticks && !fa.ticks && !fw.ticks && !p.fin && !p.asm && !w.fin) return { k: 0, h: '<tr><td>' + nm + '</td><td class="mut">Not started</td><td></td><td></td><td></td><td></td><td></td></tr>' };
    var who = function(rec, t){ return rec ? '✓ ' + esc(rec.by) : (t.ticks ? '<span class="mut">In progress</span>' : ''); }, tm = function(rec, t){ return '<td class="num"><b>' + (t.ticks || rec ? hm(t.active) : '') + '</b></td>'; };
    return { k: w.fin ? 4 : p.asm ? 3 : p.fin ? 2 : 1, t: last, h: '<tr><td>' + nm + '</td><td>' + who(p.fin, ft) + '</td>' + tm(p.fin, ft) + '<td>' + who(p.asm, fa) + '</td>' + tm(p.asm, fa) + '<td>' + who(w.fin, fw) + '</td><td class="mut">' +
      (first < Infinity ? day(first) + (day(first) !== day(last) ? ' – ' + day(last) : '') : '') + '</td></tr>' };
  }).sort(function(a, b){ return b.k - a.k || (b.t || 0) - (a.t || 0); });
  el('mgrBody').innerHTML = rows.length ? rows.map(function(r){ return r.h; }).join('') : '<tr><td colspan="7" class="mut">No jobs in the list.</td></tr>';
}
// ---------- job priority (manager screen, works on a computer too) ----------
function renderPrio(){
  if (el('ordProg')) setTimeout(renderOrder, 0);
  if (el('rmList')) setTimeout(renderRemakes, 0);
  var ids = {}; jobs.forEach(function(f){ ids[f.id] = f; });
  var rms = remakes.map(function(rm){ var f = { id: 'rm' + rm.id, name: rm.name, updated: rm.at || 0, rm: rm }; ids[f.id] = f; return f; });
  var on = prio.filter(function(id){ return ids[id]; }), rest = rms.concat(jobs.slice().sort(function(a, b){ return b.updated - a.updated; })).filter(function(f){ return on.indexOf(f.id) < 0; });
  var nm = function(f){ var n = esc(f.name.replace(/\.xls[xm]$/i, '')); return f.rm ? '<span class="rmtag">↻ ' + esc(f.rm.tags.join(', ')) + '</span>' + n : n; };
  el('prioOn').innerHTML = on.length ? on.map(function(id, i){
    return '<div class="prow"><span class="pnum">' + (i + 1) + '</span><span class="pname">' + nm(ids[id]) + '</span>' +
      '<button type="button" class="pbtn" data-pa="up" data-pi="' + i + '"' + (i ? '' : ' disabled') + ' aria-label="Move up">▲</button>' +
      '<button type="button" class="pbtn" data-pa="down" data-pi="' + i + '"' + (i < on.length - 1 ? '' : ' disabled') + ' aria-label="Move down">▼</button>' +
      '<button type="button" class="pbtn px" data-pa="off" data-pi="' + i + '" aria-label="Take off the priority list">✕</button></div>';
  }).join('') : '<div class="pempty">No priorities set, so the tablets show the newest job first. Add jobs below.</div>';
  el('prioRest').innerHTML = rest.length ? rest.map(function(f){
    return '<div class="prow rest"><span class="pname">' + nm(f) + '</span><span class="pday">' + (f.rm ? 'remake' : 'saved ' + esc(new Date(f.updated).toLocaleDateString([], { month: 'short', day: 'numeric' }))) + '</span>' +
      '<button type="button" class="pbtn padd" data-pa="add" data-id="' + esc(f.id) + '">+ Add</button></div>';
  }).join('') : '<div class="pempty">Every job and remake is on the list.</div>';
  el('prioClear').hidden = !on.length;
  return on;
}
function renderOrder(){
  var G = listGroups(), nm = function(f){ return esc(f.name.replace(/\.xls[xm]$/i, '')); };
  var block = function(arr, g){ return arr.length ? arr.map(function(k, i){ var f = jobs[k], p = jobPct(k);
    return '<div class="prow"><span class="pnum on2">' + (i + 1) + '</span><span class="pname">' + nm(f) + '</span><span class="pday">' + (p >= 0 ? Math.round(p * 100) + '%' : 'saved ' + esc(new Date(f.updated).toLocaleDateString([], { month: 'short', day: 'numeric' }))) + '</span>' +
      '<button type="button" class="pbtn" data-oa="top" data-og="' + g + '" data-oi="' + i + '"' + (i ? '' : ' disabled') + ' aria-label="Move to the top">⤒</button>' +
      '<button type="button" class="pbtn" data-oa="up" data-og="' + g + '" data-oi="' + i + '"' + (i ? '' : ' disabled') + ' aria-label="Move up">▲</button>' +
      '<button type="button" class="pbtn" data-oa="down" data-og="' + g + '" data-oi="' + i + '"' + (i < arr.length - 1 ? '' : ' disabled') + ' aria-label="Move down">▼</button></div>'; }).join('') : '<div class="pempty">None right now.</div>'; };
  el('ordProg').innerHTML = block(G.prog, 'prog'); el('ordRest').innerHTML = block(G.rest, 'rest');
  el('ordClear').hidden = !jorder.length;
  el('ordNote').textContent = jorder.length ? 'Your order is in use. New jobs go to the bottom of their group.' : 'Automatic right now: In progress by most done, Not started by newest. Move any job to set your own order.';
  return G;
}
var orderSaving = 0;
function saveOrder(next){
  var before = jorder; jorder = next; lsSet('shop-order', jorder); renderOrder();
  var n = ++orderSaving;
  api('orderset', { order: next }).then(function(){ if (n === orderSaving) toast(next.length ? '✓ Job order saved · the tablets show it within a minute' : '✓ Back to automatic order'); }, function(e){
    if (n !== orderSaving) return;
    jorder = before; lsSet('shop-order', jorder); renderOrder();
    toast(e && /unknown request/i.test(e.message || '') ? 'Not saved: Apps Script needs the new version deployed first.' : 'Not saved: no signal. Try again.');
  });
}
el('mgr').addEventListener('click', function(e){
  if (e.target.closest('#ordClear')) return saveOrder([]);
  var b = e.target.closest('[data-oa]'); if (!b) return;
  var G = renderOrder(), g = b.getAttribute('data-og'), arr = G[g].slice(), i = +b.getAttribute('data-oi'), a = b.getAttribute('data-oa');
  var j = a === 'top' ? 0 : a === 'up' ? i - 1 : i + 1; if (j < 0 || j >= arr.length || j === i) return;
  var x = arr.splice(i, 1)[0]; arr.splice(j, 0, x); G[g] = arr;
  saveOrder(G.prog.concat(G.rest).map(function(k){ return jobs[k].id; }));
});
// ---------- remakes (manager screen): pick a job, tick the rail tags, add a note, send ----------
var rmTagsFor = null;
function renderRemakes(){
  var box = el('rmList'); if (!box) return;
  box.innerHTML = remakes.length ? remakes.map(function(rm, i){
    var s = lsGet(SUM + 'rm' + rm.id);
    return '<div class="prow"><span class="pnum rmn">↻</span><span class="pname">' + esc(rm.name.replace(/\.xls[xm]$/i, '')) + ' · <b>' + esc(rm.tags.join(', ')) + '</b>' + (rm.note ? '<span class="rmnote2">' + esc(rm.note) + '</span>' : '') + '</span>' +
      '<span class="pday">' + (s && s.total ? s.done + '/' + s.total : 'not started') + '</span><button type="button" class="pbtn px" data-rmx="' + i + '" aria-label="Take this remake off the tablets">✕</button></div>';
  }).join('') : '<div class="pempty">No remakes on the tablets.</div>';
  var sel = el('rmJob'), was = sel.value;
  var all = jobs.map(function(f){ return [f.id, f.name, '']; }).concat((doneJobs || []).map(function(f){ return [f.id, f.name, ' (completed)']; }));
  sel.innerHTML = '<option value="">Pick a job…</option>' + all.map(function(a){ return '<option value="' + esc(a[0]) + '">' + esc(a[1].replace(/\.xls[xm]$/i, '') + a[2]) + '</option>'; }).join('');
  sel.value = was;
}
function saveRemakes(next, ok){
  var before = remakes; remakes = next; lsSet('shop-remakes', remakes); renderPrio();
  return api('remakeset', { remakes: next }).then(function(){ toast(ok); }, function(e){
    remakes = before; lsSet('shop-remakes', remakes); renderRemakes();
    toast(e && /unknown request/i.test(e.message || '') ? 'Not saved: Apps Script needs the new version deployed first.' : 'Not saved: no signal. Try again.');
  });
}
function rmLoadTags(){
  var id = el('rmJob').value, box = el('rmTags'); rmTagsFor = null; el('rmSend').disabled = true;
  if (!id){ box.innerHTML = ''; return; }
  var f = jobs.concat(doneJobs || []).filter(function(x){ return x.id === id; })[0];
  box.innerHTML = '<div class="pempty">Opening ' + esc(f.name.replace(/\.xls[xm]$/i, '')) + '…</div>';
  fileGet(id).then(function(local){
    if (local && local.updated >= f.updated) return local.b64;
    return apiNew('fabopen2', 'fabopen', { id: id }).then(function(r){ filePut({ id: id, name: f.name, updated: f.updated, b64: r.b64 }); return r.b64; });
  }).then(parseBook).then(function(book){
    return shopSheets(book).then(function(items){
      var it = items.filter(function(x){ return x.sh.name === 'CUT SHEET'; })[0]; if (!it) throw new Error('This job has no Cut Sheet.');
      var L = layout(book, it), tags = [];
      L.rows.forEach(function(r){ var t = L.txt(r, L.cols[0]).trim(); if (r > L.hdr && /^\S+\.\d+$/.test(t) && tags.indexOf(t) < 0) tags.push(t); });
      if (el('rmJob').value !== id) return;
      rmTagsFor = { id: id, name: f.name };
      box.innerHTML = tags.length ? tags.map(function(t){ return '<label class="rmchk"><input type="checkbox" value="' + esc(t) + '"><span>' + esc(t) + '</span></label>'; }).join('') : '<div class="pempty">No rail tags found on the Cut Sheet.</div>';
    });
  }).catch(function(e){ box.innerHTML = '<div class="pempty">Couldn’t open it: ' + esc(e && e.message ? e.message : String(e)) + '</div>'; });
}
el('mgr').addEventListener('change', function(e){
  if (e.target.id === 'rmJob') return rmLoadTags();
  if (e.target.closest('#rmTags')) el('rmSend').disabled = !el('rmTags').querySelector('input:checked');
});
el('mgr').addEventListener('click', function(e){
  var x = e.target.closest('[data-rmx]');
  if (x){ var rm = remakes[+x.getAttribute('data-rmx')]; return confirmBox('Take remake ' + rm.tags.join(', ') + ' off the tablets?', function(){ saveRemakes(remakes.filter(function(r){ return r.id !== rm.id; }), '✓ Remake taken off'); if (prio.indexOf('rm' + rm.id) >= 0) savePrio(prio.filter(function(id){ return id !== 'rm' + rm.id; })); }); }
  if (e.target.closest('#rmSend') && rmTagsFor){
    var tags = [].map.call(el('rmTags').querySelectorAll('input:checked'), function(i){ return i.value; }); if (!tags.length) return;
    var rm = { id: Date.now().toString(36), file: rmTagsFor.id, name: rmTagsFor.name, tags: tags, note: el('rmNote').value.trim().slice(0, 200), at: Date.now() };
    saveRemakes(remakes.concat([rm]), '✓ Remake sent · the tablets show it within a minute');
    el('rmJob').value = ''; el('rmTags').innerHTML = ''; el('rmNote').value = ''; el('rmSend').disabled = true; rmTagsFor = null;
  }
});
var prioSaving = 0;
function savePrio(next){
  var before = prio; prio = next; lsSet('shop-prio', prio); applyPrio(); renderPrio();
  var n = ++prioSaving;
  api('prioset', { prio: next }).then(function(r){ if (n === prioSaving) toast('✓ Priority saved · the tablets show it within a minute'); }, function(e){
    if (n !== prioSaving) return;
    prio = before; lsSet('shop-prio', prio); applyPrio(); renderPrio();
    toast(e && /unknown request/i.test(e.message || '') ? 'Not saved: Apps Script needs the new version deployed first.' : 'Not saved: no signal. Try again.');
  });
}
el('mgr').addEventListener('click', function(e){
  if (e.target.closest('#prioClear')) return savePrio([]);
  var b = e.target.closest('[data-pa]'); if (!b) return;
  var on = renderPrio().slice(), i = +b.getAttribute('data-pi'), a = b.getAttribute('data-pa');
  if (a === 'add') on.push(b.getAttribute('data-id'));
  else if (a === 'off') on.splice(i, 1);
  else { var j = a === 'up' ? i - 1 : i + 1; if (j < 0 || j >= on.length) return; var t = on[i]; on[i] = on[j]; on[j] = t; }
  savePrio(on);
});
function openMgr(){
  // ticks made on other tablets come in through the backend first
  pullAll(renderMgr);
  renderMgr(); renderPrio(); el('list').hidden = true; el('mgr').hidden = false; window.scrollTo(0, 0); loadList();
}
// hidden way in: press and hold the Shop Cuts logo for 2 seconds, or tap it 5 times quickly, then the manager PIN.
// Touch screens: the browser's own long-press (select / menu) cancels pointer events, so the hold uses touch events and ignores cancels.
(function(){
  var t = null, lg = el('logo'), taps = [];
  function askMgr(){
    clearTimeout(t); t = null; taps = [];
    var m = el('modal'), inp = el('modalInput');
    el('modalText').textContent = 'Manager PIN'; inp.hidden = false; inp.value = ''; m.hidden = false; setTimeout(function(){ inp.focus(); }, 150);
    el('modalNo').onclick = function(){ m.hidden = true; inp.hidden = true; };
    el('modalYes').onclick = function(){ var pv = inp.value.trim(); m.hidden = true; inp.hidden = true; if (!pv) return; msg('Checking PIN…', true); checkMgrPin(pv).then(function(ok){ if (ok){ msg('', true); openMgr(); } else msg('Wrong PIN.'); }).catch(function(){ msg('Couldn’t check the PIN — no signal?'); }); };
    inp.onkeydown = function(e){ if (e.key === 'Enter') el('modalYes').click(); };
  }
  function down(){ clearTimeout(t); t = setTimeout(askMgr, 2000); }
  function up(){
    if (t){ clearTimeout(t); t = null;
      var now = Date.now(); taps = taps.filter(function(x){ return now - x < 3000; }); taps.push(now);
      if (taps.length >= 5) askMgr();
    }
  }
  var touched = false;
  lg.addEventListener('touchstart', function(e){ touched = true; e.preventDefault(); down(); }, { passive: false });
  lg.addEventListener('touchend', function(e){ e.preventDefault(); up(); }, { passive: false });
  lg.addEventListener('mousedown', function(){ if (!touched) down(); });
  lg.addEventListener('mouseup', function(){ if (!touched) up(); });
  lg.addEventListener('mouseleave', function(){ if (!touched){ clearTimeout(t); t = null; } });
  lg.addEventListener('contextmenu', function(e){ e.preventDefault(); });
})();
el('mgrBack').onclick = function(){ el('mgr').hidden = true; el('list').hidden = false; renderList(false); window.scrollTo(0, 0); };
el('back').onclick = function(){ cur = null; try { localStorage.removeItem(UI + 'open'); } catch (e) {} el('job').hidden = true; el('list').hidden = false; msg(''); renderList(false); window.scrollTo(0, 0); loadList(); };

// ---------- start ----------
if (WELD){
  document.body.classList.add('weld');
  document.querySelector('#list .brand b').textContent = 'Shop Welds';
  document.querySelector('.hello h1').textContent = 'Ready to weld';
  document.querySelector('.hello p').textContent = 'Pick a job. Tick each rail when it’s welded.';
  el('logo').innerHTML = '<svg width="52" height="52" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">' + WELD_ICON + '</svg>';
}
(function(){
  if (!getPin()) askPin('Enter the crew PIN once on this tablet.', loadList); else loadList();
  // came back after a refresh: reopen the job that was open
  var open = null; try { open = localStorage.getItem(UI + 'open'); } catch (e) {}
  if (open) kvGet('list').then(function(l){ var f = (l || []).filter(function(x){ return x.id === open; })[0]; if (f) return openJob(f); var h = holdJobs.filter(function(x){ return x.id === open; })[0]; if (h) openJob(Object.assign({}, h, { hold: 1 })); });
})();
try { if (sessionStorage.getItem('shop-updated')){ sessionStorage.removeItem('shop-updated'); setTimeout(function(){ toast('✓ Updated to version ' + VERSION); }, 600); } } catch (e) {}
if ('serviceWorker' in navigator) window.addEventListener('load', function(){
  // updates: checked when the app comes back to the front and every few minutes while it's open (a tablet that never leaves
  // the app still hears about it). A new version doesn't interrupt the work: an "Update ready" bar shows, and a tap loads it.
  // Tapping Refresh list loads it straight away.
  var had = !!navigator.serviceWorker.controller, reloaded = false;
  var go = function(){ if (reloaded) return; reloaded = true; try { sessionStorage.setItem('shop-updated', '1'); } catch (e) {} location.reload(); };
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(function(reg){
    document.addEventListener('visibilitychange', function(){ if (!document.hidden) reg.update().catch(function(){}); });
    setInterval(function(){ if (!document.hidden && navigator.onLine !== false) reg.update().catch(function(){}); }, 3 * 60000);
  }).catch(function(){});
  navigator.serviceWorker.addEventListener('controllerchange', function(){
    if (!had || reloaded) return;
    if (updAsked) return go();
    var b = el('updbar'); if (!b) return go();
    b.hidden = false; b.onclick = go;
  });
});
window.__shop = { parseBook: parseBook, shopSheets: shopSheets, layout: layout, renderSheet: renderSheet, show: show, printArea: printArea };
})();
