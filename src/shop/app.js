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
var jobs = [], doneJobs = null, DONE_DAYS = 50;
// priority order set from the manager screen (file ids, most urgent first); other jobs follow, newest first
var prio = lsGet('shop-prio') || [];
// the office's own order for the other jobs (manager screen); used inside In progress and Not started, ahead of the automatic order
var jorder = lsGet('shop-order') || [];
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
  return '<svg class="ring" viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="' + r + '" fill="none" stroke="#EAE3D8" stroke-width="8"/>' +
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
    if (!jobs.length){ box.innerHTML = '<div class="empty">No jobs in Ready to Fab yet. When a job is ready, it’s saved there from the office and shows up here.</div>' + done; return; }
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
    box.innerHTML = (pri.length ? '<div class="prcard"><div class="prhead"><span class="prflame" aria-hidden="true">⚡</span>Priority<span>· rush these first, in this order</span></div>' + pick(pri) + '</div>' : '') +
      (prog.length ? '<div class="prcard ipcard"><div class="prhead"><span class="prflame" aria-hidden="true"><svg width="24" height="24" viewBox="0 0 24 24" style="vertical-align:-4px"><circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" stroke-width="3"/><path d="M12 5.5A6.5 6.5 0 0 1 18.5 12H12z" fill="currentColor"/></svg></span>In progress<span>· ' + (ordered ? 'in the office\'s order' : 'most done first') + '</span></div>' + pick(prog) + '</div>' : '') +
      (rest.length && (pri.length || prog.length) ? '<div class="prrest">Not started</div>' : '') + pick(rest) +
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
    lsSet('shop-info:' + f.id, { u: f.updated, label: label });
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
      if (local && local.updated >= f.updated && info && info.u === f.updated && (lsGet(SUM + f.id) || {}).total && lsGet(WSUM + f.id)) return next();
      var got = local && local.updated >= f.updated ? Promise.resolve(local.b64) : apiNew('fabopen2', 'fabopen', { id: f.id }).then(function(r){ filePut({ id: f.id, name: f.name, updated: f.updated, b64: r.b64 }); return r.b64; });
      return got.then(function(b64){ return parseBook(b64); }).then(function(book){ return rememberInfo(f, book, true); }).then(function(){ if (!cur) renderList(false); next(); }, function(){ next(); });
    });
  })();
}
el('ver').textContent = (WELD ? 'Shop Welds' : 'Shop Cuts') + ' · version ' + VERSION;
var refreshAsked = false;
var listFresh = false;   // once the backend has answered, the copy saved on the tablet never overwrites it
function loadList(){
  kvGet('list').then(function(l){ kvGet('donelist').then(function(d){ if (listFresh) return; if (d && !doneJobs) doneJobs = d; if (l && !jobs.length){ jobs = l; renderList(true); } }); });
  apiNew('fablist2', 'fablist', {}).then(function(r){
    listFresh = true; jobs = r.files || []; doneJobs = r.done || null; if (Array.isArray(r.prio)){ prio = r.prio; lsSet('shop-prio', prio); } if (Array.isArray(r.order)){ jorder = r.order; lsSet('shop-order', jorder); } applyPrio(); kvSet('list', jobs); if (doneJobs) kvSet('donelist', doneJobs);
    renderList(false); if (!el('mgr').hidden) renderMgr(); msg(''); prefetch(); pullAll(); flushPending();
    if (refreshAsked){ refreshAsked = false; toast('✓ Up to date · version ' + VERSION); }
    // forget files that are neither in Ready to Fab nor completed in the last 50 days
    fileKeys().then(function(ks){ var keep = {}; jobs.concat(completedList(), lateCand()).forEach(function(f){ keep[f.id] = 1; }); ks.forEach(function(id){ if (!keep[id]) fileDel(id); }); });
  }, function(e){
    if (refreshAsked){ refreshAsked = false; toast('No signal, so this is the list from last time.'); }
    if (e.code === 'pin') return askPin(e.message === 'wrong PIN' ? 'That PIN didn’t work. Try again.' : 'Enter the crew PIN once on this tablet.', loadList);
    if (!jobs.length) el('jobs').innerHTML = '<div class="empty">Couldn’t reach Drive (' + esc(e.message || 'no signal') + '). Jobs opened before are still on this tablet once the list has loaded once.</div>';
    else renderList(true);
  });
}
el('jobs').addEventListener('click', function(e){ if (e.target.closest('[data-act="donetoggle"]')){ lsSet(UI + 'done-open', lsGet(UI + 'done-open') === 1 ? 0 : 1); return renderList(false); } var b = e.target.closest('[data-k]'); if (b) return openJob(jobs[+b.getAttribute('data-k')]); var wj = e.target.closest('[data-w]'); if (wj) return openJob(shownW[+wj.getAttribute('data-w')]); var d = e.target.closest('[data-d]'); if (d) openJob(shownDone[+d.getAttribute('data-d')]); });
// Refresh list: also checks for a newer version of the app (if one arrives, the app reloads and says so)
el('reload').onclick = function(){
  refreshAsked = true; loadList();
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
// the screen sheet's top block (job, colour, top rail, small parts) as one tidy line instead of the spreadsheet grid
function screenHead(item){
  var sd = item.sd, v = function(r, c){ var x = cellVal(sd, r, c); return x == null ? '' : String(x).trim(); };
  var parts = [[3, 4, 5], [3, 6, 7], [3, 8, 9]].map(function(a){ var n = v(a[0], a[2]); return v(a[0], a[1]) ? '<span class="sp"><b>' + esc(n === '' ? '0' : n) + '</b>' + esc(v(a[0], a[1])) + '</span>' : ''; }).join('');
  return '<div class="scrhead"><div class="scrinfo">' + (v(3, 2) ? '<span><i>Colour</i>' + esc(v(3, 2)) + '</span>' : '') + (v(4, 2) ? '<span><i>Top rail</i>' + esc(v(4, 2)) + '</span>' : '') +
    '<span><i>Type</i>' + (item.sh.name === 'Rail to Wall' ? 'Rail to wall' : 'Wall to wall') + '</span></div>' +
    (parts ? '<div class="scrparts"><i>Small parts for the job</i>' + parts + '</div>' : '') + '</div>';
}
var SKIP = /^(INPUT|Inputs|GLASS ORDER.*|GLASS CALC|COST .*|CUSTOM POSTS|SPEC_.*|ENGINE.*|STICK CALC|LISTS|Lists|PAINT|PRICES|Paint .*|W-W Glass|R-W Glass|Sheet\d+)$/;
function shopSheets(book){
  var list = [];
  return Promise.all(SHOP.map(function(d){
    var sh = book.sheets.filter(function(s){ return s.name === d.n; })[0]; if (!sh) return null;
    return parseSheet(book, sh).then(function(sd){ if (d.always || (d.has && d.has(sd)) || (sh.state === 'visible' && !(d.has === screenUnits))) return { sh: sh, sd: sd, label: d.label, view: d.view }; return null; });
  })).then(function(a){
    list = a.filter(Boolean);
    var sp = screenPosts(list); if (sp) list.push(sp);
    // any other tab that's been un-hidden for this job and has a print area
    var extra = book.sheets.filter(function(s){ return s.state === 'visible' && s.pa && !SKIP.test(s.name) && !SHOP.some(function(d){ return d.n === s.name; }); });
    return Promise.all(extra.map(function(sh){ return parseSheet(book, sh).then(function(sd){ return { sh: sh, sd: sd, label: sh.name.charAt(0) + sh.name.slice(1).toLowerCase() }; }); })).then(function(b){ return list.concat(b); });
  });
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
}
// privacy screen drawing for the Posts tab: which piece is Post A, B and C
// A = upright at the deck edge against the railing · C = the horizontal post along the bottom (the bottom channel fastens to it) · B = upright standing on C at the wall
function screenDiagram(kinds){
  var one = function(rw){
    var W = 360, dk = 226, top = 34, ink = '#1F1B17', ch = '#E8590C', o = '';
    var xA = rw ? 64 : null, wallR = 318, wallL = rw ? null : 26;
    var x0 = rw ? xA + 12 : wallL + 14, x1 = wallR;               // Post C runs from Post A (or the far wall) to the wall
    var lbl = function(x, y, t){ return '<circle cx="' + x + '" cy="' + y + '" r="13" fill="' + ink + '"/><text x="' + x + '" y="' + (y + 5) + '" text-anchor="middle" font-size="15" font-weight="900" fill="#fff">' + t + '</text>'; };
    var note = function(x, y, t, a){ return '<text x="' + x + '" y="' + y + '" font-size="11" font-weight="700" fill="#6B6157"' + (a ? ' text-anchor="' + a + '"' : '') + '>' + t + '</text>'; };
    o += '<rect x="0" y="' + dk + '" width="' + W + '" height="10" fill="#D9D0C3"/>' + note(8, dk + 22, 'DECK');
    o += '<rect x="' + wallR + '" y="10" width="26" height="' + (dk - 10) + '" fill="url(#hatch)" stroke="#9A9087"/>' + note(wallR + 13, 8, 'WALL', 'middle');
    if (!rw) o += '<rect x="' + (wallL - 12) + '" y="10" width="26" height="' + (dk - 10) + '" fill="url(#hatch)" stroke="#9A9087"/>' + note(wallL + 1, 8, 'WALL', 'middle');
    if (rw) o += '<g stroke="#9A9087" stroke-width="3"><line x1="10" y1="132" x2="' + xA + '" y2="132"/><line x1="16" y1="132" x2="16" y2="' + dk + '"/><line x1="40" y1="132" x2="40" y2="' + dk + '"/></g>' + note(10, 124, 'RAILING');
    // Post C along the bottom, Post B up the wall side, Post A at the railing
    var yC = dk - 12, xB = x1 - 12;
    o += '<rect x="' + x0 + '" y="' + yC + '" width="' + (x1 - x0) + '" height="12" fill="' + ink + '"/>';
    o += '<rect x="' + xB + '" y="' + (top + 6) + '" width="12" height="' + (yC - top - 6) + '" fill="' + ink + '"/>';
    if (rw) o += '<rect x="' + xA + '" y="' + top + '" width="12" height="' + (dk - top) + '" fill="' + ink + '"/>';
    else o += '<rect x="' + x0 + '" y="' + (top + 6) + '" width="12" height="' + (yC - top - 6) + '" fill="' + ink + '"/>';
    var gx0 = rw ? xA + 12 : x0 + 12, gx1 = xB, mid = 120;
    o += '<rect x="' + gx0 + '" y="' + top + '" width="' + (gx1 - gx0) + '" height="7" fill="#8C8279"/>';                               // top rail
    o += '<rect x="' + gx0 + '" y="' + (top + 9) + '" width="' + (gx1 - gx0) + '" height="' + (mid - top - 11) + '" fill="#CFE3EE" stroke="#9DBBCB"/>';
    o += '<rect x="' + gx0 + '" y="' + mid + '" width="' + (gx1 - gx0) + '" height="9" fill="' + ch + '"/>';                              // double channel
    o += '<rect x="' + gx0 + '" y="' + (mid + 11) + '" width="' + (gx1 - gx0) + '" height="' + (yC - mid - 20) + '" fill="#CFE3EE" stroke="#9DBBCB"/>';
    o += '<rect x="' + gx0 + '" y="' + (yC - 8) + '" width="' + (gx1 - gx0) + '" height="8" fill="' + ch + '"/>';                         // bottom channel
    var cx = (gx0 + gx1) / 2;
    o += '<text x="' + cx + '" y="' + (top - 5) + '" text-anchor="middle" font-size="11" font-weight="800" fill="#6B6157">TOP RAIL</text>';
    o += '<text x="' + cx + '" y="' + (mid - 4) + '" text-anchor="middle" font-size="11" font-weight="800" fill="' + ch + '">DOUBLE CHANNEL</text>';
    o += '<text x="' + cx + '" y="' + (yC - 12) + '" text-anchor="middle" font-size="11" font-weight="800" fill="' + ch + '">BOTTOM CHANNEL</text>';
    if (rw) o += lbl(xA + 6, 72, 'A');
    o += lbl(xB + 6, 72, 'B') + lbl(cx + 70, yC + 6, 'C');
    if (!rw) o += lbl(x0 + 6, 72, 'B');
    return '<figure class="scrfig"><svg viewBox="0 0 360 250" role="img" aria-label="' + (rw ? 'Rail to wall' : 'Wall to wall') + ' privacy screen: which piece is Post A, B and C"><defs><pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="#EFE9E1"/><line x1="0" y1="0" x2="0" y2="6" stroke="#B9AFA4" stroke-width="2"/></pattern></defs>' + o + '</svg>' +
      '<figcaption><b>' + (rw ? 'Rail to wall' : 'Wall to wall') + '</b>' + (rw ? '<span><i>A</i> upright at the deck edge, against the railing</span>' : '') + '<span><i>B</i> upright standing on Post C' + (rw ? ' at the wall' : ', one at each wall') + '</span><span><i>C</i> along the bottom; the bottom channel fastens to it</span></figcaption></figure>';
  };
  return '<div class="scrfigs">' + (kinds.indexOf('Rail to Wall') >= 0 ? one(true) : '') + (kinds.indexOf('Wall to Wall') >= 0 ? one(false) : '') + '</div>';
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
        var u = cellVal(sd, r, 1), len = cellVal(sd, r, c), n = +cellVal(sd, r, c + 1) || 1;
        if (u == null || u === '' || isNaN(+u) || len == null || len === '' || !(+len > 0)) continue;
        var key = h + '|' + (+len), row = rows.filter(function(x){ return x.key === key; })[0];
        if (!row){ row = { key: key, post: h.replace(/^post/i, 'Post'), len: +len, qty: 0, units: [] }; rows.push(row); }
        var ul = String(u) + (list.filter(function(x){ return SCREEN_RE.test(x.sh.name); }).length > 1 ? ' ' + typ : '');
        row.qty += n; if (row.units.indexOf(ul) < 0) row.units.push(ul);
      }
    }
  });
  if (!rows.length) return null;
  rows.sort(function(a, b){ return a.post < b.post ? -1 : a.post > b.post ? 1 : b.len - a.len; });
  ['Post', 'Qty', 'Length', '✓', 'For units'].forEach(function(t, i){ put(1, i + 1, t); });
  var map = {}; rows.forEach(function(x, i){ map[x.key] = i + 2; });
  rows.forEach(function(x, i){ put(i + 2, 1, x.post); put(i + 2, 2, String(x.qty)); put(i + 2, 3, fmt16(x.len)); put(i + 2, 5, x.units.join(', ')); });
  fake.maxR = rows.length + 1;
  var kinds = list.filter(function(x){ return SCREEN_RE.test(x.sh.name); }).map(function(x){ return x.sh.name; });
  return { kinds: kinds, sh: { name: 'SCREEN POSTS', pa: "'SCREEN POSTS'!$A$1:$E$" + fake.maxR, state: 'visible' }, sd: fake, label: 'Posts', virt: 1, map: map };
}
function itemKeys(item){ var L = item.L; return Object.keys(L.chk).map(function(k){ return 'c' + k; }).concat(Object.keys(L.rowTap).map(function(r){ return 'r' + r; })); }
// measurements: big whole numbers with a small stacked fraction, like reading a tape
function measure(t){
  return esc(t).replace(/(\d+)\s*\/\s*(\d+)/g, '<span class="fr"><sup>$1</sup><span class="sl">/</span><sub>$2</sub></span>').replace(/@\s*/g, '<span class="at">@</span>');
}
// units as entered in the field (INPUT tab), for the layout drawings
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
  if (sn === 'POST SHEET'){ var sc = sheetSections(it).filter(function(s){ return s.keys.indexOf(key) >= 0; })[0]; return sc && /^(block|bracket)/i.test(sc.label) ? 'asm' : 'cut'; }
  return 'cut';
}
function stamp(kind){ var a = kind === 'asm' ? (cur.tla = cur.tla || []) : (cur.tl = cur.tl || []); a.push(Date.now()); }
// Cut Sheet keys by column: Top rail + Channel boxes (cutting) and Rail tag boxes (assembly)
function cutKeys(kind){
  var it = cutItem(); if (!it) return [];
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
  return '<div class="sortbar"><span class="slab">Sort</span>' + sbtn(['', 'Unit Order']) + seg('Top rail', ['long', 'Longest'], ['short', 'Shortest']) +
    seg('Channel', ['clong', 'Longest'], ['cshort', 'Shortest']) + sbtn(['opt', 'Optimal Cut']) + '</div>';
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
  var h = (scr ? screenHead(item) : '') + (item.virt && item.kinds ? screenDiagram(item.kinds) : '') + (WELD && isTop() && /^(CUT SHEET|POST SHEET)$/.test(sh.name) ? '<div class="bpnote"><b>Top mount · weld-on base plates</b><span class="bpkey"><i>Cen</i> centred on the plate · <i>Off</i> offset: post at the outer end, plate reaches in under the rail · <i>Rev</i> reverse offset: plate sticks out past the end · <i>L / R</i> left / right end of the rail · <i>EC</i> corner turns right with the run, <i>IC</i> turns left · 4x4 plates for 2x2 posts</span>' + (sh.name === 'POST SHEET' ? 'Post lengths are in section 1. The plates to weld, and how many of each, are under Base plates. The Cuts tab shows which plate goes on each rail end.' : 'The L Post and R Post columns show which base plate goes on each end of the rail. The Posts tab has the post lengths and the plate totals.') + '</div>' : '') + '<table class="sheet">';
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
    if (scr && r < L.hdr) return;   // privacy screens: the top block is shown as the summary above the table
    if (isCut && !sorted && L.hdr != null && r > L.hdr){
      var tg = L.txt(r, L.cols[0]), un = /^\S+\.\d+$/.test(tg) ? unitOf(tg) : null;
      if (un && un !== lastUnit){ h += layoutRow(un, NC); lastUnit = un; }
    }
    var rc = L.cols.filter(function(c){ return L.chk[r + ':' + c]; });
    var main = L.vchk ? [] : rc.filter(function(c){ return /top rail|channel/i.test(L.chk[r + ':' + c].head); });
    var need = (main.length ? main : rc).map(function(c){ return pre + 'c' + r + ':' + c; });
    var rowDone = (need.length && need.every(function(k){ return done[k]; })) || (L.rowTap[r] && done[pre + 'r' + r]);
    if (WELD && sh.name === 'CUT SHEET') rowDone = !!(wmap[r] && cur.w.done[wmap[r]]);
    var tick = {}; rc.forEach(function(c){ var ck = L.chk[r + ':' + c]; if (done[pre + 'c' + r + ':' + c]){ tick[ck.left] = 1; if (ck.left2 != null) tick[ck.left2] = 1; } });
    var trc = [rowDone ? 'rowdone' : '', L.rowTap[r] ? 'tap' : '', need.length || L.rowTap[r] ? 'data' : '', r === L.hdr ? 'hdr' : (L.cols.some(function(c){ return L.txt(r, c) === '✓'; }) ? 'subhdr' : ''), /^\d+\s*[·.\-]\s*[A-Za-z]/.test(L.txt(r, L.cols[0])) ? 'sechead' : (L.hdr != null && r < L.hdr ? 'info' : '')].filter(Boolean).join(' ');
    var big = !!(need.length || L.rowTap[r]);
    if (stickHead[r]) h += '<tr class="stickrow"><td colspan="' + NC + '">' + stickHead[r] + '</td></tr>';
    if (isCut && r === L.hdr && !WELD) h += '<tr class="sortrow"><td colspan="' + NC + '">' + sortBarHtml() + '</td></tr>';
    h += '<tr' + (trc ? ' class="' + trc + '"' : '') + (L.rowTap[r] ? ' data-row="' + pre + 'r' + r + '"' : '') + '>';
    if (wcol) h += r === L.hdr ? '<td class="wh">Weld</td>' : wmap[r] ? '<td class="chk wchk' + (cur.w.done[wmap[r]] ? ' on' : '') + '" data-wkey="' + esc(wmap[r]) + '"><span class="box" role="checkbox" aria-checked="' + !!cur.w.done[wmap[r]] + '" aria-label="Welded">✓</span></td>' : '<td class="wpad"></td>';
    var hiNext = null;
    L.cols.forEach(function(c){
      var k = r + ':' + c; if (skip[k]) return;
      if (secs[r] && c === L.cols[L.cols.length - 1]){ var sc = secs[r], sa = sc.keys.every(function(kk){ return done[kk]; }); var sp0 = span[k], at0 = sp0 ? (sp0.rs > 1 ? ' rowspan="' + sp0.rs + '"' : '') + (sp0.cs > 1 ? ' colspan="' + sp0.cs + '"' : '') : ''; h += '<td class="postsall"' + at0 + '><button type="button" class="pcut' + (sa ? ' on' : '') + '" data-act="secall" data-sec="' + r + '" aria-pressed="' + sa + '"><span class="box">✓</span>' + esc(topWords(sc.label)) + '</button></td>'; return; }
      var cell = sd.cells[k], t = sh.name === 'POST SHEET' ? topWords(show(book, cell)) : show(book, cell), sp = span[k], xf = cell && book.st.xfs[cell.s], f = xf && book.st.fonts[xf.font];
      // top mount: a centred plate's method reads WELD-ON Centered (the cut sheet says just "WELD-ON plate" for Mid-Cen)
      if (sh.name === 'POST SHEET' && isTop() && /^weld-on plate$/i.test(t.trim()) && /^(Mid|EC|IC|Joint|E)-Cen(-[LR])?$/i.test(L.txt(r, L.cols[0]).trim())) t = 'WELD-ON Centered';
      var attr = sp ? (sp.rs > 1 ? ' rowspan="' + sp.rs + '"' : '') + (sp.cs > 1 ? ' colspan="' + sp.cs + '"' : '') : '';
      if (L.vchk && L.vchk[c] && !L.chk[k]){ h += r === L.hdr ? '<td class="c b vhd">✓</td>' : '<td></td>'; return; }
      if (L.chk[k]){ var key = pre + 'c' + k; h += '<td class="chk' + (done[key] ? ' on' : '') + (WELD ? ' ro' : '') + '" data-key="' + esc(key) + '"' + attr + '><span class="box" role="checkbox" aria-checked="' + !!done[key] + '" aria-label="Done">✓</span></td>'; return; }
      var cls = [];
      // Cover and Post Sheet: post height and block height stand out (label + the value beside it)
      if (hiSheet && (L.hdr == null || r < L.hdr)){
        if (hiNext){
          cls.push('hival');
          if (hiNext === 'block' && !t.trim()) t = cur && cur.block && cur.block.custom ? cur.block.text : '38 5/16 (standard)';
          // red only when the block height shown isn't the standard 38 5/16
          if (hiNext === 'block' && !/^38\s+(5\/16|10\/32)\b/.test(t.trim())) cls.push('hicustom');
          hiNext = null;
        } else if (/^\s*(post|block)\s*(height|ht)\.?\s*$/i.test(t)){ cls.push('hilab'); hiNext = /block/i.test(t) ? 'block' : 'post'; }
      }
      if (tick[c]) cls.push('cut');
      if (divC != null && c === divC && r >= L.hdr) cls.push('divl');
      if (L.div && L.div[c] && r >= L.hdr) cls.push('divl');
      if (item.virt && r === L.hdr) cls.push('b', 'c');
      if (c === L.cols[0] && L.hdr != null && r > L.hdr && floatTag[t.trim()]) cls.push('floatrail');
      if (((bpC[c] && r > L.hdr) || (r > bpFrom && r < bpTo && c === L.cols[0] && !L.cols.some(function(cc){ return L.txt(r, cc) === '✓'; }))) && bpDesc(t)) cls.push('bp');
      if (f && f.b) cls.push('b');
      if (cell && typeof cell.v === 'number') cls.push('num');
      if (xf && xf.h === 'center') cls.push('c');
      if ((xf && xf.wrap) || t.length > 22) cls.push('wrapcell');
      var style = (cell ? fillCss(book, cell.s) : '') + (f && f.rgb && /^FF[0-9A-F]{6}$/i.test(f.rgb) && f.rgb.slice(2).toUpperCase() !== '000000' ? 'color:#' + f.rgb.slice(2) + ';' : '');
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
  return h + '</table>';
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
  return Promise.all(jobs.map(function(f){
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
  renderFin();
  if (WELD && !WELD_BOXES) el('legend').innerHTML = '<span>This tablet is for looking: the small boxes show what the shop has cut and assembled. When the whole job is welded, sign off Welding complete.</span>';
  else if (WELD) el('legend').innerHTML = c.n ? '<span>Tap a rail’s Weld box when it’s welded. Tap again to undo. The small boxes show what the shop has cut and assembled.</span>' : '<span>Here to look at. Welds are ticked on the Welds tab.</span>';
  else el('legend').innerHTML = it.view ? '<span>Totals for the job. Nothing to tick here.</span>' : (c.n ? '<span>Tap a box (or a row) when it’s cut. Tap again to undo.</span>' : '');
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
  var wt = e.target.closest('td.wchk');
  if (wt){ var wk = wt.getAttribute('data-wkey'); setWTick(wk, !cur.w.done[wk]); saveW(); var yw = window.scrollY; renderCur(); window.scrollTo(0, yw); return; }
  if (WELD && !e.target.closest('.laybtn')) return;   // the welder's tablet only ticks welds (and opens layouts)
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
  fileGet(f.id).then(function(local){
    if (local && local.updated >= f.updated) return show(local.b64);
    msg('Opening ' + f.name.replace(/\.xlsx$/i, '') + '…', true);
    return apiNew('fabopen2', 'fabopen', { id: f.id }).then(function(r){
      filePut({ id: f.id, name: f.name, updated: f.updated, b64: r.b64 });
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
  if (!WELD && (!ci || it !== ci)){ box.hidden = true; return; }   // the weld tablet shows its sign-off under every tab
  var h = '', when = function(rec){ var at = new Date(rec.at); return esc(rec.by) + ' · ' + esc(at.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })) + ', ' + esc(at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })); };
  if (WELD){
    var allW = weldAll();
    if (cur.w.fin || (allW && asmOK())) h = stageCard(WSTAGE, allW, cur.w.fin);
    else if (allW) h = '<div class="fin"><div class="fh"><span class="fbox"></span><div><b>Still in the shop</b><span>Welding complete can be signed off here once Assembly complete is signed off in Shop Cuts.</span></div></div></div>';
  } else {
    STAGES.forEach(function(st){ var all = allDone(cutKeys(st.kind)); if (all || cur[st.k]) h += stageCard(st, all, cur[st.k]); });
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
var MGR_PIN = '5742';   // manager PIN for the fab-times view (change it here)
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
  var ids = {}; jobs.forEach(function(f){ ids[f.id] = f; });
  var on = prio.filter(function(id){ return ids[id]; }), rest = jobs.filter(function(f){ return on.indexOf(f.id) < 0; }).slice().sort(function(a, b){ return b.updated - a.updated; });
  var nm = function(f){ return esc(f.name.replace(/\.xls[xm]$/i, '')); };
  el('prioOn').innerHTML = on.length ? on.map(function(id, i){
    return '<div class="prow"><span class="pnum">' + (i + 1) + '</span><span class="pname">' + nm(ids[id]) + '</span>' +
      '<button type="button" class="pbtn" data-pa="up" data-pi="' + i + '"' + (i ? '' : ' disabled') + ' aria-label="Move up">▲</button>' +
      '<button type="button" class="pbtn" data-pa="down" data-pi="' + i + '"' + (i < on.length - 1 ? '' : ' disabled') + ' aria-label="Move down">▼</button>' +
      '<button type="button" class="pbtn px" data-pa="off" data-pi="' + i + '" aria-label="Take off the priority list">✕</button></div>';
  }).join('') : '<div class="pempty">No priorities set, so the tablets show the newest job first. Add jobs below.</div>';
  el('prioRest').innerHTML = rest.length ? rest.map(function(f){
    return '<div class="prow rest"><span class="pname">' + nm(f) + '</span><span class="pday">saved ' + esc(new Date(f.updated).toLocaleDateString([], { month: 'short', day: 'numeric' })) + '</span>' +
      '<button type="button" class="pbtn padd" data-pa="add" data-id="' + esc(f.id) + '">+ Add</button></div>';
  }).join('') : '<div class="pempty">Every job in Ready to Fab is on the list.</div>';
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
    el('modalYes').onclick = function(){ var ok = inp.value.trim() === MGR_PIN; m.hidden = true; inp.hidden = true; if (ok) openMgr(); else msg('Wrong PIN.'); };
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
  if (open) kvGet('list').then(function(l){ var f = (l || []).filter(function(x){ return x.id === open; })[0]; if (f) openJob(f); });
})();
try { if (sessionStorage.getItem('shop-updated')){ sessionStorage.removeItem('shop-updated'); setTimeout(function(){ toast('✓ Updated to version ' + VERSION); }, 600); } } catch (e) {}
if ('serviceWorker' in navigator) window.addEventListener('load', function(){
  // updates: check whenever the app comes back to the front; when a new version takes over, reload once to show it
  var had = !!navigator.serviceWorker.controller, reloaded = false;
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(function(reg){
    document.addEventListener('visibilitychange', function(){ if (!document.hidden) reg.update().catch(function(){}); });
  }).catch(function(){});
  navigator.serviceWorker.addEventListener('controllerchange', function(){ if (had && !reloaded){ reloaded = true; try { sessionStorage.setItem('shop-updated', '1'); } catch (e) {} location.reload(); } });
});
window.__shop = { parseBook: parseBook, shopSheets: shopSheets, layout: layout, renderSheet: renderSheet, show: show, printArea: printArea };
})();
