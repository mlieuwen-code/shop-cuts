(function(){
'use strict';
var MAX_RUNS = 100, FIRST_ROW = 20, DRAFT_PREFIX = 'ridgeway-cutsheet:';
function el(id){ return document.getElementById(id); }
/*__HELPERS_A__*/
/*__HELPERS_B__*/
/*__TEMPLATE__*/
/*__SCREEN_TEMPLATE__*/

// ---------- what the app writes to the INPUT tab ----------
var WRITE = [
  {cell:'B4', label:'Job name'}, {cell:'B6', label:'Colour'}, {cell:'B7', label:'Mount'}, {cell:'B8', label:'Rail type'},
  {cell:'B9', label:'Bracket height', type:'num'}, {cell:'B10', label:'Post wall'}, {cell:'B11', label:'Standoff', type:'num'},
  {cell:'B12', label:'Post height', type:'num'}, {cell:'B13', label:'Block height', type:'num'},
  {cell:'B14', label:'Glass'}, {cell:'B15', label:'Glass bottom'}, {cell:'B16', label:'Distance down', type:'num'}, {cell:'B17', label:'Substrate'},
  {cell:'D7', label:'Extra channel 1'}, {cell:'E7', label:'Extra channel 1 block ht', type:'num'},
  {cell:'D8', label:'Extra channel 2'}, {cell:'E8', label:'Extra channel 2 block ht', type:'num'},
  {cell:'D9', label:'Extra channel 3'}, {cell:'E9', label:'Extra channel 3 block ht', type:'num'}
];
var READ_ONLY = [];
var POST_WALLS = ['2x2 - .095', '2x2 - .125'];
var RUN_MAIN = [
  {col:'A', key:'tag', label:'Run', type:'text'},
  {col:'B', key:'l', label:'Left end', type:'select', list:'ends'},
  {col:'C', key:'r', label:'Right end', type:'select', list:'ends'},
  {col:'D', key:'fl', label:'Float L', type:'num'}, {col:'E', key:'fr', label:'Float R', type:'num'},
  {col:'F', key:'len', label:'Measurement (in)', type:'num'}
];
var RUN_MORE = [
  {col:'M', key:'ol', label:'Override L', type:'select', opts:['SF']}, {col:'N', key:'or', label:'Override R', type:'select', opts:['SF']},
  {col:'O', key:'pl', label:'Plate L', type:'select', opts:['Centered','Rev Offset']}, {col:'P', key:'pr', label:'Plate R', type:'select', opts:['Centered','Rev Offset']},
  {col:'Q', key:'al', label:'Angle L (°)', type:'num', nofrac:true}, {col:'R', key:'ar', label:'Angle R (°)', type:'num', nofrac:true},
  {col:'S', key:'ns', label:'Non-Sub', type:'select', opts:['Yes','No']}, {col:'T', key:'mid', label:'Mid ± (whole number)', type:'num', nofrac:true},
  {col:'U', key:'slope', label:'Slope °', type:'num', nofrac:true}, {col:'V', key:'hi', label:'High end', type:'select', opts:['L','R']},
  {col:'W', key:'cust', label:'Custom', type:'select', opts:['Yes']}
];
var RUN_COLS = RUN_MAIN.concat(RUN_MORE);
// end that the next section starts with, given the end this one finished on
var CARRY = { CJ:'CJO', CJO:'CJ', EC:'ECO', IC:'ICO', ICO:'IC', FC:'FCO', FCO:'FC', 'CJO-1':'CJO-1' };
var MOUNTS = ['Fascia','Inside','Top'], MOUNT_COLOR = { Fascia:'#2F5D50', Inside:'#8A3A34', Top:'#2D5577' };

var floors = null, curFloor = 0, OPEN_KEY = 'ridgeway-open';
var srcData = null, srcOpts = {}, fileName = '', inputPath = '', sheetXml = '', lists = {}, endDesc = {}, units = [], header = {}, tab = 'job';

// ---------- messages ----------
function msg(text, ok){ var m = el('msg'); m.hidden = false; m.className = 'msg ' + (ok ? 'ok' : 'err'); m.textContent = text; window.scrollTo(0, 0); }
function clearMsg(){ el('msg').hidden = true; }
function msgLinks(text, links, ok){ msg(text + ' ', ok); var m = el('msg'); links.forEach(function(l){ var a = document.createElement('a'); a.href = l[1]; a.textContent = l[0]; a.target = '_blank'; a.rel = 'noopener'; m.appendChild(a); }); }
function ask(text, yesLabel, cb){
  el('modalText').textContent = text; el('modalYes').textContent = yesLabel; el('modal').hidden = false;
  el('modalYes').onclick = function(){ el('modal').hidden = true; cb(); };
  el('modalNo').onclick = function(){ el('modal').hidden = true; };
  el('modalNo').focus();
}

// ---------- start screen ----------
(function(){ var h = new Date().getHours(); el('greet').textContent = h < 12 ? 'Good morning.' : h < 17 ? 'Good afternoon.' : 'Good evening.'; })();
function readDraft(name){ try { return JSON.parse(localStorage.getItem(DRAFT_PREFIX + name) || 'null'); } catch (e) { return null; } }
(function(){
  var d = readDraft('new-job'); if (!d || !d.units) return;
  var secs = 0; d.units.forEach(function(u){ secs += (u.secs || []).length; });
  el('resumeName').textContent = (d.header && String(d.header.B4 || '').trim()) || 'Untitled job';
  el('resumeInfo').textContent = (d.floors && d.floors.length > 1 ? d.floors.length + ' floors · ' : '') + 'Draft · ' + d.units.length + ' unit' + (d.units.length === 1 ? '' : 's') + ', ' + secs + ' section' + (secs === 1 ? '' : 's') + ' · ' + new Date(d.t).toLocaleString([], { weekday:'short', hour:'numeric', minute:'2-digit' });
  el('resume').hidden = false;
  el('resumeBtn').onclick = function(){ startNew(d); };
})();

// ---------- load ----------
function startNew(restore){ loadData(TEMPLATE_B64, 'new-job', true, { base64: true }, restore); }
function loadData(data, name, isNew, opts, restore){
  clearMsg();
  fileName = name; srcData = data; srcOpts = opts || {};
  JSZip.loadAsync(data, Object.assign({ createFolders: false }, srcOpts)).then(function(z){
    return Promise.all([z, z.file('xl/workbook.xml').async('string'), z.file('xl/_rels/workbook.xml.rels').async('string'),
      z.file('xl/sharedStrings.xml') ? z.file('xl/sharedStrings.xml').async('string') : Promise.resolve('')]);
  }).then(function(a){
    var z = a[0]; shared = parseShared(a[3]);
    var paths = sheetPaths(a[1], a[2]);
    if (!paths.INPUT) throw new Error('This file has no INPUT tab. Is it the Ridgeway cut sheet?');
    inputPath = paths.INPUT;
    var need = ['LISTS','SPEC_RailTypes','SPEC_EndTypes'].map(function(n){ return paths[n] && z.file(paths[n]) ? z.file(paths[n]).async('string') : Promise.resolve(''); });
    return Promise.all([z.file(inputPath).async('string')].concat(need));
  }).then(function(x){
    sheetXml = x[0];
    var L = x[1], RT = x[2], ET = x[3];
    lists.colours = colRange(L, 'A', 2, 40).filter(function(s){ return s.length < 40; });
    lists.glass = colRange(L, 'C', 2, 12);
    lists.channels = colRange(L, 'R', 3, 11);
    lists.railTypes = colRange(RT, 'A', 4, 21);
    var dv = sheetXml.match(/<dataValidation\b[^>]*sqref="B20:C119"[^>]*>\s*<formula1>"([^"<]*)"<\/formula1>/);
    lists.ends = dv ? dv[1].split(',') : ['E','F','FA','I6','I6A','6EP','6EPA','W','EC','ECO','IC','ICO','FC','FCO','CJ','CJO','CJO-1','3x2E','3x2FE','3x2IE','3x2TE','T','TO'];
    endDesc = {};
    for (var r = 4; r <= 94; r++){ var mt = readCell(ET,'B'+r), cd = readCell(ET,'C'+r), ds = readCell(ET,'D'+r); if (cd !== '' && ds !== ''){ endDesc[mt + '|' + cd] = String(ds).trim(); if (!endDesc['*|' + cd]) endDesc['*|' + cd] = String(ds).trim(); } }
    header = {};
    WRITE.forEach(function(f){ header[f.cell] = readCell(sheetXml, f.cell); });
    READ_ONLY.forEach(function(c){ header[c] = readCell(sheetXml, c); });
    var runs = [];
    for (var i = 0; i < MAX_RUNS; i++){
      var row = FIRST_ROW + i, run = {}, any = false;
      RUN_COLS.forEach(function(c){ var v = readCell(sheetXml, c.col + row); run[c.key] = v; if (v !== '') any = true; });
      if (any) runs.push(run);
    }
    if (isNew){ header.B4 = ''; runs = []; }
    if (String(header.B10 || '') === '') header.B10 = POST_WALLS[0];
    units = groupUnits(runs);
    if (!units.length) units.push(blankUnit(''));
    if (restore){ header = Object.assign(header, restore.header); units = restore.units || units; }
    // new jobs from the template are a "building": one tab per floor along the bottom
    if (name === 'new-job'){
      if (restore && restore.floors && restore.floors.length){ floors = restore.floors; curFloor = Math.min(restore.cur || 0, floors.length - 1); floors[curFloor].header = header; floors[curFloor].units = units; header = floors[curFloor].header; units = floors[curFloor].units; }
      else floors = [{ header: header, units: units }], curFloor = 0;
    } else floors = null;
    if (!isNew){ (srcOpts.base64 ? Promise.resolve(data) : blobToB64(data)).then(function(b64){ kvSet('open-src', { name: name, b64: b64 }); }, function(){}); }
    el('start').hidden = true; el('app').hidden = false; el('bar').hidden = false;
    renderHeader(); renderRuns(); showTab(restore && restore.tab || 'job'); applyMount(); renderFloors();
    if (restore && restore.nextFloor){
      changed();
      msg('Next floor: same setup as ' + (header._prev || 'the last floor') + '. Check the job name, and change anything that’s different on this floor.', true);
      setTimeout(function(){ var j = el('h_B4'); if (j){ j.focus(); j.select(); } }, 300);
    }
    else if (restore && restore.quiet){}
    else if (restore) msg('Picked up your draft' + (header.B4 ? ' for ' + header.B4 : '') + '.', true);
    else if (!isNew){ msg('Opened ' + fileName + (header.B4 ? ' (job ' + header.B4 + ')' : '') + '.', true); offerDraft(); }
  }).catch(function(e){ msg('Could not open that file: ' + (e && e.message ? e.message : e)); });
}

// ---------- small builders ----------
function numVal(v){ if (typeof v !== 'number') return v == null ? '' : v; var t = v * 16; if (Math.abs(t - Math.round(t)) > 1e-6 || Number.isInteger(v)) return String(v); return fmtFrac(v).replace(/"$/, ''); }
function hintFor(v){ if (v === '' || v == null) return ''; var p = parseLen(String(v)); return isNaN(p) || p === null ? '' : fmtFrac(p); }
function optList(list, cur, labelFn){
  var h = '<option value=""></option>', seen = false;
  list.forEach(function(o){ var sel = String(o) === String(cur); if (sel) seen = true; h += '<option value="' + esc(o) + '"' + (sel ? ' selected' : '') + '>' + esc(labelFn ? labelFn(o) : o) + '</option>'; });
  if (cur !== '' && cur != null && !seen) h += '<option value="' + esc(cur) + '" selected>' + esc(cur) + '</option>';
  return h;
}
function numField(id, label, cur, o){
  o = o || {};
  return '<div class="fld' + (o.need ? ' need' : '') + (o.cls ? ' ' + o.cls : '') + '"><label for="' + id + '">' + label + (o.need ? ' <em>· needed</em>' : '') + '</label>' +
    '<input id="' + id + '" inputmode="decimal" enterkeyhint="done" autocomplete="off"' + (o.nofrac ? '' : ' data-frac="1"') + (o.attrs || '') +
    ' placeholder="' + esc(o.ph || ' ') + '" value="' + esc(numVal(cur)) + '"><div class="hint">' + esc(o.nofrac ? '' : hintFor(cur)) + '</div></div>';
}
function selField(id, label, list, cur, attrs, labelFn){
  return '<div class="fld"><label for="' + id + '">' + label + '</label><select id="' + id + '"' + (attrs || '') + '>' + optList(list, cur, labelFn) + '</select></div>';
}
function chips(cell, label, options, labels, dots){
  var cur = String(header[cell] == null ? '' : header[cell]);
  return '<div class="fld"><div class="lbl" id="lbl_' + cell + '">' + label + '</div><div class="chips" role="group" aria-labelledby="lbl_' + cell + '" style="--n:' + options.length + '">' +
    options.map(function(o, i){ return '<button type="button" class="chip" data-chip="' + cell + '" data-val="' + esc(o) + '" aria-pressed="' + (cur === String(o)) + '">' +
      (dots ? '<span class="mdot" style="background:' + dots[o] + '"></span>' : '') + esc(labels ? labels[i] : o) + '</button>'; }).join('') + '</div></div>';
}

// ---------- job info ----------
function renderHeader(){
  parkFrac();
  var col = String(header.B6 == null ? '' : header.B6), isOther = col !== '' && lists.colours.indexOf(col) < 0;
  var colourOpts = '<option value=""></option>' + lists.colours.map(function(o){ return '<option value="' + esc(o) + '"' + (o === col ? ' selected' : '') + '>' + esc(o) + '</option>'; }).join('') +
    '<option value="__other"' + (isOther ? ' selected' : '') + '>Other…</option>';
  var chan = '';
  [7,8,9].forEach(function(r, i){
    chan += '<div class="g2" data-fracslot>' + selField('h_D' + r, 'Channel ' + (i + 1), lists.channels, header['D' + r], ' data-cell="D' + r + '"') +
      numField('h_E' + r, 'Block height (in)', header['E' + r], { attrs: ' data-cell="E' + r + '"' }) + '</div>';
  });
  var nChan = [7,8,9].filter(function(r){ return String(header['D' + r] || '') !== ''; }).length;
  el('tab-job').innerHTML =
    '<div class="card"><div class="fld job"><label for="h_B4">Job name <em>· becomes the file name</em></label><input id="h_B4" data-cell="B4" type="text" autocomplete="off" placeholder="e.g. Maple Ridge Townhomes" value="' + esc(header.B4) + '"></div></div>' +
    '<div class="card"><h3>Rail setup</h3>' +
      '<div class="g2"><div class="fld"><label for="h_B6">Colour</label><select id="h_B6">' + colourOpts + '</select>' +
        '<input id="h_B6o" type="text" autocomplete="off" aria-label="Other colour" placeholder="Type the colour" value="' + esc(isOther ? col : '') + '"' + (isOther ? '' : ' hidden') + ' style="margin-top:4px;border-color:var(--need);background:var(--needbg)"></div>' +
        selField('h_B8', 'Rail type', lists.railTypes, header.B8, ' data-cell="B8"') + '</div>' +
      chips('B7', 'Mount', MOUNTS, null, MOUNT_COLOR) +
      '<div class="g2" data-fracslot>' + chips('B9', 'Bracket height', ['4','4.5','5'], ['4','4½','5']) +
        numField('h_B11', 'Standoff (in)', header.B11, { need: true, ph: 'Std Fascia 1 1/2 · Top 0', attrs: ' data-cell="B11"' }) + '</div>' +
      '<div class="g2" data-fracslot>' + numField('h_B12', 'Post height (in)', header.B12, { need: true, ph: 'Std Fascia 49 1/2 · Top 40 1/2', attrs: ' data-cell="B12"' }) +
        numField('h_B13', 'Block height (in)', header.B13, { need: true, ph: 'Std 38 5/16', attrs: ' data-cell="B13"' }) + '</div>' +
    '</div>' +
    '<div class="card"><h3>Glass &amp; substrate</h3><div class="g3" data-fracslot>' +
      selField('h_B14', 'Glass', lists.glass, header.B14, ' data-cell="B14"') + selField('h_B15', 'Glass bottom', lists.glass, header.B15, ' data-cell="B15"') +
      numField('h_B16', 'Distance down (in)', header.B16, { attrs: ' data-cell="B16"' }) + '</div>' +
      chips('B17', 'Substrate', ['Wood','Concrete']) + '</div>' +
    '<details class="fold"><summary>Post wall <em id="pwSum" style="font-style:normal;color:var(--muted);font-weight:700;margin-left:auto">' + esc(String(header.B10 || POST_WALLS[0]).replace('2x2 - ', '')) + '</em></summary><div class="in">' +
      chips('B10', 'Post wall', POST_WALLS, ['2x2 · .095', '2x2 · .125']) + '</div></details>' +
    '<details class="fold"' + (nChan ? ' open' : '') + '><summary>Extra channels <span>' + (nChan ? nChan + ' added' : 'None') + ' ›</span></summary><div class="in">' + chan + '</div></details>' +
    '<details class="fold"' + (units.some(function(u){ return u.screen; }) ? ' open' : '') + '><summary>Privacy screens <span>' + (isNum(header.scrH) ? 'Height ' + esc(numVal(header.scrH)) + '"' : 'Only if the job has screens') + ' ›</span></summary><div class="in">' +
      '<div class="g2" data-fracslot>' + numField('h_scrH', 'Screen height (in)', header.scrH, { need: true, ph: 'e.g. 78', attrs: ' data-cell="scrH"' }) +
        numField('h_scrD', 'DBL channel down (in)', header.scrD, { ph: 'e.g. 34', attrs: ' data-cell="scrD"' }) + '</div>' +
      chips('scrT', 'Top rail', ['Glass', 'Flat Glass']) + '</div></details>' +
    '<button type="button" class="btn big pri" id="toUnits">Next: measure units ›</button>' +
    '<button type="button" class="btn big" id="nextFloorJob" style="background:var(--chip2)">Start next floor · same setup ›</button>';
  el('toUnits').onclick = function(){ showTab('units'); };
  el('nextFloorJob').onclick = nextFloorFromHere;
  if (floors && floors.length > 1){
    var rm = document.createElement('button'); rm.type = 'button'; rm.className = 'btn danger'; rm.id = 'rmFloor'; rm.textContent = 'Remove this floor tab'; rm.style.alignSelf = 'center';
    el('tab-job').appendChild(rm); rm.onclick = removeFloor;
  }
}
el('tab-job').addEventListener('input', function(e){
  var t = e.target;
  if (t.id === 'h_B6o'){ header.B6 = t.value; return changed(); }
  var c = t.getAttribute('data-cell'); if (!c) return;
  header[c] = t.value;
  if (t.hasAttribute('data-frac')) showHint(t);
  changed();
});
el('tab-job').addEventListener('change', function(e){
  var t = e.target;
  if (t.id === 'h_B6'){
    var o = el('h_B6o');
    if (t.value === '__other'){ o.hidden = false; header.B6 = o.value; o.focus(); }
    else { o.hidden = true; header.B6 = t.value; }
    return changed();
  }
  var c = t.getAttribute('data-cell'); if (c && t.tagName === 'SELECT'){ header[c] = t.value; changed(); }
});
el('tab-job').addEventListener('click', function(e){
  var b = e.target.closest('[data-chip]'); if (!b) return;
  var c = b.getAttribute('data-chip'), v = b.getAttribute('data-val');
  header[c] = String(header[c]) === v ? '' : v;
  Array.prototype.forEach.call(b.parentNode.children, function(x){ x.setAttribute('aria-pressed', String(header[c]) === x.getAttribute('data-val') ? 'true' : 'false'); });
  if (c === 'B7'){ applyMount(); renderRuns(); }
  if (c === 'B10' && el('pwSum')) el('pwSum').textContent = String(header.B10 || POST_WALLS[0]).replace('2x2 - ', '');
  changed();
});
function applyMount(){
  var m = String(header.B7 || '');
  if (MOUNTS.indexOf(m) >= 0) document.body.setAttribute('data-mount', m); else document.body.removeAttribute('data-mount');
  el('mbadge').textContent = m ? m + ' mount' : ''; el('mbadge').hidden = !m || tab !== 'units';
}
function showHint(inp){
  var h = inp.parentNode.querySelector('.hint'); if (!h) return;
  var v = parseLen(inp.value);
  if (inp.value.trim() === '') { h.textContent = ''; h.classList.remove('bad'); }
  else if (isNaN(v)) { h.textContent = 'Use 96, 96.375 or 96 3/8'; h.classList.add('bad'); }
  else { h.textContent = fmtFrac(v); h.classList.remove('bad'); }
}

// ---------- units ----------
function blankRun(){ var r = {}; RUN_COLS.forEach(function(c){ r[c.key] = ''; }); return r; }
function blankUnit(num){ return { unit: num, custom: false, post: '', block: '', secs: [blankRun()] }; }
function groupUnits(flat){
  var out = [], map = {};
  flat.forEach(function(r){
    var t = String(r.tag == null ? '' : r.tag).trim(), m = t.match(/^(.+)\.(\d+)$/), u = m ? m[1] : t;
    if (!(u in map)){ map[u] = out.length; out.push({ unit: u, custom: false, post: '', block: '', secs: [] }); }
    if (String(r.len).trim() !== '') r.lenOk = true;
    out[map[u]].secs.push(r);
  });
  return out;
}
function fmtFtIn(v){
  if (v === null || isNaN(v)) return '';
  var neg = v < 0; v = Math.abs(v);
  var ft = Math.floor((v + 1/32) / 12), inch = v - ft * 12; if (inch < 0) inch = 0;
  return (neg ? '-' : '') + ft + "' " + fmtFrac(inch).replace(/^≈ /, '');
}
function lenWarn(raw, v){
  var w = [], m = String(raw).trim().match(/^(\d{2,})(\d)\s*\/\s*(\d+)$/);
  if (m) w.push('No space before the fraction. Did you mean ' + m[1] + ' ' + m[2] + '/' + m[3] + '"?');
  if (v < 6) w.push('Very short. Is that right?'); else if (v > 240) w.push('Over 20 ft. Is that right?');
  return w;
}
var CHECK = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
function confHtml(run){
  var raw = String(run.len == null ? '' : run.len).trim(); if (!raw || run.lenOk) return '';
  var v = parseLen(raw); if (v === null || isNaN(v)) return '';
  return '<div class="confbox"><div class="t"><div class="q">Read it back. Does this match the tape?</div><div style="display:flex;align-items:baseline;gap:14px;flex-wrap:wrap"><span class="big">' + esc(fmtFrac(v)) + '</span></div>' +
    lenWarn(raw, v).map(function(x){ return '<div class="warn">' + esc(x) + '</div>'; }).join('') + '</div><button type="button" class="btn pri" data-act="ok">' + CHECK + 'Confirm</button></div>';
}
function needsConf(run){ var raw = String(run.len == null ? '' : run.len).trim(); return raw !== '' && !run.lenOk; }
function totalSecs(){ return units.reduce(function(n, u){ return n + u.secs.length; }, 0); }
function secLabel(u, j){ return (String(u.unit).trim() || '?') + '.' + (j + 1); }
function unitSum(u){
  var len = 0, n = 0;
  u.secs.forEach(function(s){ var v = parseLen(s.len); if (v !== null && !isNaN(v)){ len += v; n++; } });
  return u.secs.length + ' section' + (u.secs.length === 1 ? '' : 's') + (n ? ' · ' + fmtFrac(len) + ' total' : '');
}
function nextUnitNum(){ var n = null; units.forEach(function(u){ var v = parseInt(u.unit, 10); if (!isNaN(v) && (n === null || v > n)) n = v; }); return n === null ? '' : String(n + 1); }
function jobFile(){ return String(header.B4 || '').trim().replace(/[\\\/:*?"<>|]+/g, '-') || '[Job name]'; }
function endLabel(o, m){ var d = endDesc[(m == null ? (header.B7 || '') : m) + '|' + o] || endDesc['*|' + o]; return d ? o + ' – ' + d : o; }
// ---------- per-unit setup: mount, post/block height, standoff; units with the same setup share a cut sheet ----------
function unitSetup(u){
  var m = (u.mountDiff && MOUNTS.indexOf(u.mount) >= 0) ? u.mount : String(header.B7 || '');
  var so = m === 'Top' ? '' : ((u.mountDiff && String(u.standoff == null ? '' : u.standoff).trim() !== '') ? u.standoff : header.B11);
  return { mount: m, post: u.custom ? u.post : header.B12, block: u.custom ? u.block : header.B13, standoff: so };
}
function nkey(v){ var p = parseLen(String(v == null ? '' : v)); return (p === null || isNaN(p)) ? '?' : String(Math.round(p * 1e4) / 1e4); }
function setupKey(s){ return s.mount + '|' + nkey(s.post) + '|' + nkey(s.block) + '|' + (s.mount === 'Top' ? '0' : nkey(s.standoff)); }
function inches(v){ var p = parseLen(String(v == null ? '' : v)); return (p === null || isNaN(p)) ? '?' : fmtFrac(p).replace(/^≈ /, '').replace(/"$/, ''); }
function sheetName(s){
  var m = unitSetup({}), parts = [];
  if (s.mount && s.mount !== m.mount) parts.push(s.mount);
  if (nkey(s.post) !== nkey(m.post)) parts.push(inches(s.post) + ' in posts');
  else if (nkey(s.block) !== nkey(m.block)) parts.push(inches(s.block) + ' in blocks');
  if (!parts.length && setupKey(s) !== setupKey(m)) parts.push(inches(s.standoff) + ' in standoff');
  return jobFile() + (parts.length ? ' - ' + parts.join(' - ') : '') + '.xlsx';
}
function noteText(u){
  if (u.mountDiff && MOUNTS.indexOf(u.mount) < 0) return 'Pick the mount for this unit.';
  var s = unitSetup(u);
  return setupKey(s) === setupKey(unitSetup({})) ? 'Same as the job settings, so it saves on the main sheet.' : 'Saves with any matching units on: ' + sheetName(s);
}
function updNote(i){ var nt = el('u' + i + '_note'); if (nt) nt.textContent = noteText(units[i]); }
// ECO on one end and E or EC on the other: the rail can float (Non-Sub)
function isFloatCombo(run){ var a = run.l, b = run.r; return (a === 'ECO' && (b === 'E' || b === 'EC')) || (b === 'ECO' && (a === 'E' || a === 'EC')); }
function secHtml(u, i, run, j){
  var id = 'u' + i + 's' + j + '_', um = unitSetup(u).mount, endLabelU = function(o){ return endLabel(o, um); };
  if (run.lenOk && !run._open && String(run.len).trim() !== ''){
    var v = parseLen(run.len);
    return '<button type="button" class="secrow" data-s="' + j + '" data-act="open" aria-label="Edit section ' + esc(secLabel(u, j)) + '"><span class="ck" style="color:var(--onaccent)">' + CHECK + '</span>' +
      '<span class="lab" data-lab>' + esc(secLabel(u, j)) + '</span><span class="ends">' + esc((run.l || '–') + ' → ' + (run.r || '–')) + '</span>' +
      '<span class="len">' + esc(fmtFrac(v)) + '</span></button>';
  }
  // open "More options" only for values set there, not for Non-Sub set by "Rail is floating"
  var more = RUN_MORE.some(function(c){ if (c.key === 'ns' && isFloatCombo(run)) return false; return run[c.key] !== '' && run[c.key] != null; });
  var showFloats = !!run._floats || String(run.fl == null ? '' : run.fl).trim() !== '' || String(run.fr == null ? '' : run.fr).trim() !== '';
  var carried = j > 0 && run.l && run._carried ? ' <span style="font-size:14px;color:var(--muted);font-weight:700">from ' + esc(secLabel(u, j - 1)) + '</span>' : '';
  return '<div class="sec' + (needsConf(run) ? ' unconf' : '') + '" data-s="' + j + '">' +
    '<div class="top"><b>Section <span data-lab>' + esc(secLabel(u, j)) + '</span></b><span>' +
      (run.lenOk ? '<button type="button" class="btn ghost" data-act="close">Done</button> ' : '') +
      '<button type="button" class="btn" data-act="dup">Copy</button> <button type="button" class="btn danger" data-act="del">Delete</button></span></div>' +
    '<div class="g2"><div class="fld"><label for="' + id + 'l">Left end' + carried + '</label><select id="' + id + 'l" data-key="l">' + optList(lists.ends, run.l, endLabelU) + '</select></div>' +
      '<div class="fld"><label for="' + id + 'r">Right end</label><select id="' + id + 'r" data-key="r">' + optList(lists.ends, run.r, endLabelU) + '</select></div></div>' +
    (isFloatCombo(run) ? '<label class="chk floatrail" for="' + id + 'floatrail"><input type="checkbox" id="' + id + 'floatrail" data-sfield="floatrail"' + (run.ns === 'Yes' ? ' checked' : '') + '>Rail is floating <span style="font-weight:700;color:var(--muted)">(marks Non-Sub = Yes)</span></label>' : '') +
    '<div data-fracslot>' + numField(id + 'len', 'Measurement (in)', run.len, { cls: 'meas', ph: '96 then tap 3/8', attrs: ' data-key="len"' }) + '</div>' +
    '<div class="conf">' + confHtml(run) + '</div>' +
    '<label class="chk" for="' + id + 'floats"><input type="checkbox" id="' + id + 'floats" data-sfield="floats"' + (showFloats ? ' checked' : '') + '>Floats</label>' +
    (showFloats ? '<div class="g2" data-fracslot>' + numField(id + 'fl', 'Float L', run.fl, { attrs: ' data-key="fl"' }) + numField(id + 'fr', 'Float R', run.fr, { attrs: ' data-key="fr"' }) + '</div>' +
      '<div class="floatrow"><button type="button" class="btn pri" data-act="floatok"' + (run._floatsOk ? ' hidden' : '') + '>Confirm floats</button><span class="floathint"' + (run._floatsOk ? '' : ' hidden') + '>✓ Floats set</span></div>' : '') +
    '<details class="more"' + (more ? ' open' : '') + '><summary>More options: overrides, plates, angles, slope ›</summary><div class="g" data-fracslot>' +
      RUN_MORE.map(function(c){ return c.type === 'select' ? selField(id + c.key, c.label, c.opts, run[c.key], ' data-key="' + c.key + '"') : numField(id + c.key, c.label, run[c.key], { nofrac: c.nofrac, attrs: ' data-key="' + c.key + '"' }); }).join('') +
    '</div></details></div>';
}
function unitHtml(u, i){
  var jm = String(header.B7 || ''), others = MOUNTS.filter(function(m){ return m !== jm; }), um = u.mountDiff && MOUNTS.indexOf(u.mount) >= 0 ? u.mount : '';
  var mountBox = u.mountDiff ? '<div class="custbox"><div class="fld"><div class="lbl" id="u' + i + '_mlbl">Mount for this unit</div><div class="chips" role="group" aria-labelledby="u' + i + '_mlbl" style="--n:' + others.length + '">' +
      others.map(function(m){ return '<button type="button" class="chip" data-umount="' + m + '" aria-pressed="' + (um === m) + '"><span class="mdot" style="background:' + MOUNT_COLOR[m] + '"></span>' + m + '</button>'; }).join('') + '</div></div>' +
      (um && um !== 'Top' ? '<div class="g2" data-fracslot>' + numField('u' + i + '_so', 'Standoff (in)', u.standoff, { ph: isNum(header.B11) ? 'Blank = job’s ' + inches(header.B11) : (um === 'Fascia' ? 'Std 1 1/2' : 'Inside varies'), attrs: ' data-ufield="standoff"' }) + '<div></div></div>' : '') + '</div>' : '';
  var note = (u.custom || u.mountDiff) ? '<div class="custnote"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg><span id="u' + i + '_note">' + esc(noteText(u)) + '</span></div>' : '';
  return '<div class="unit" data-u="' + i + '"' + (um ? ' data-mount="' + um + '"' : '') + '><div class="uhead"><div class="ucol">' +
      '<input class="unum" id="u' + i + '_num" data-ufield="unit" type="text" autocomplete="off" aria-label="Unit number" placeholder="Unit #" value="' + esc(u.unit) + '">' +
      '<label class="chk" for="u' + i + '_cust"><input type="checkbox" id="u' + i + '_cust" data-ufield="custom"' + (u.custom ? ' checked' : '') + '>Custom post height</label>' +
      '</div>' +
    '<div class="uinfo"><div class="eyebrow">Unit</div><div class="usum" id="u' + i + '_sum">' + esc(unitSum(u)) + '</div></div>' +
    '<div class="uacts"><button type="button" class="btn" data-act="draw" aria-pressed="' + (!!u._dr) + '">Draw</button><button type="button" class="btn" data-act="layout" aria-pressed="' + (!!u._layout) + '">' + (u._layout ? 'Hide layout' : 'Layout') + '</button><button type="button" class="btn" data-act="ucopy">Copy unit</button><button type="button" class="btn" data-act="ucodes">Copy post codes</button><button type="button" class="btn danger" data-act="udel">Delete</button></div></div>' +
    '<div class="uchecks"><label class="chk" for="u' + i + '_md"><input type="checkbox" id="u' + i + '_md" data-ufield="mountdiff"' + (u.mountDiff ? ' checked' : '') + '>Different mount</label>' +
      '<label class="chk" for="u' + i + '_scr"><input type="checkbox" id="u' + i + '_scr" data-ufield="screen"' + (u.screen ? ' checked' : '') + '>Privacy screen</label>' +
      '<label class="chk" for="u' + i + '_nt"><input type="checkbox" id="u' + i + '_nt" data-ufield="hasnotes"' + (u.hasNotes ? ' checked' : '') + '>Notes</label></div>' +
    (u.hasNotes ? '<div class="custbox"><div class="fld"><label for="u' + i + '_notes">Notes <em style="font-style:normal;color:var(--muted)">· saved to the job’s notes file for review before fabrication</em></label>' +
      '<textarea id="u' + i + '_notes" class="notes" data-ufield="notetext" rows="3" placeholder="Anything to check before fabrication">' + esc(u.notes || '') + '</textarea></div></div>' : '') +
    (u.custom ? '<div class="custbox"><div class="g2" data-fracslot>' +
      numField('u' + i + '_post', 'Post height (in)', u.post, { need: true, ph: 'This unit only', attrs: ' data-ufield="post"' }) +
      numField('u' + i + '_block', 'Block height (in)', u.block, { need: true, ph: 'This unit only', attrs: ' data-ufield="block"' }) + '</div></div>' : '') +
    mountBox + note + (u.screen ? screenBox(u, i) : '') +
    (u._dr ? drawHtml(u, i) : '') +
    (u._layout ? '<div class="layout' + (u._full ? ' full' : '') + '" id="u' + i + '_lay">' + layoutSvg(u) + '</div>' : '') +
    u.secs.map(function(run, j){ return secHtml(u, i, run, j); }).join('') +
    addButtons(u) + '</div>';
}
function addButtons(u){
  return '<div class="addrow"><button type="button" class="addsec" data-act="addsec">+ Add section ' + esc(secLabel(u, u.secs.length)) + '</button>' +
'</div>';
}
function renderRuns(){
  parkFrac();
  el('units').innerHTML = units.map(unitHtml).join('');
  units.forEach(function(u, i){ if (u._dr) initDraw(u, i); if (u._full && !u._layout) u._full = false; });
  units.forEach(function(u){ if (!u._dr) u._drFull = false; });
  document.body.classList.toggle('layfull', units.some(function(u){ return (u._full && u._layout) || (u._dr && u._drFull); }));
  el('unitCount').textContent = units.length;
  updBadge();
}

// ---------- bird's-eye layout: sections drawn to scale, joints straight, EC/FC turn out, IC turns in ----------
var JOINT_CODES = { CJ:1, CJO:1, 'CJO-1':1, T:1, TO:1 };
// bird's-eye turn direction for each corner code, by mount (+1 right, -1 left)
var DOUBLE_CORNER_POSTS = { F:1, FA:1, I6:1, I6A:1, '6EP':1, '6EPA':1 };
var CORNER_DIR = {
  Fascia: { EC: 1, ECO: 1, FC: 1, FCO: 1, IC: -1, ICO: -1 },
  Top:    { EC: 1, ECO: 1, FC: 1, FCO: 1, IC: -1, ICO: -1 },
  Inside: { EC: -1, ECO: -1, FC: -1, FCO: -1, IC: 1, ICO: 1 }
};
function cornerDir(code, mount){
  var t = CORNER_DIR[mount] || CORNER_DIR.Fascia;
  if (code in t) return t[code];
  if (DOUBLE_CORNER_POSTS[code]) return 1;
  return JOINT_CODES[code] ? 0 : null;
}
function turnFor(run, isLast, mount){
  var r = String(run.r || ''), a = parseLen(String(run.ar == null ? '' : run.ar));
  var deg = (a === null || isNaN(a) || a <= 0 || a >= 180) ? (run._deg || 90) : (a <= 90 ? a : 180 - a);
  if (!isLast && run._turn){ if (run._turn === 'R') return deg; if (run._turn === 'L') return -deg; if (run._turn === 'S') return 0; }
  var d = cornerDir(r, mount);
  if (d === null) return null;
  if (isLast && DOUBLE_CORNER_POSTS[r]) return null;
  return d * deg;
}
function autoTurnName(run, mount){ var t = turnFor({ r: run.r, ar: run.ar }, false, mount); return t === null ? 'Gap' : (t === 0 ? 'Straight' : (t > 0 ? 'Right' : 'Left')); }
// a corner forced the opposite way from its mount's rule
function wrongTurn(run, mount){ var d = cornerDir(String(run.r || ''), mount); return !!(d && run._turn && run._turn !== 'S' && (run._turn === 'R' ? 1 : -1) !== d); }
function layoutSvg(u){
  var mnt = unitSetup(u).mount, last = u.secs.length - 1;
  var totalTurn = 0, x = 0, y = 0, h = 270 + (u._rot || 0), segs = [], pts = [], xs = [0], ys = [0];
  u.secs.forEach(function(run, j){
    var L = parseLen(run.len), known = !(L === null || isNaN(L) || L <= 0); if (!known) L = 36;
    var x2 = x + L * Math.cos(h * Math.PI / 180), y2 = y + L * Math.sin(h * Math.PI / 180);
    var flv = parseLen(String(run.fl == null ? '' : run.fl)), frv = parseLen(String(run.fr == null ? '' : run.fr));
    segs.push({ x1: x, y1: y, x2: x2, y2: y2, h: h, L: L, tag: secLabel(u, j), len: known ? fmtFrac(L) : '?', known: known, ns: run.ns === 'Yes',
      fl: flv > 0 && flv < L ? flv : 0, fr: frv > 0 && frv < L ? frv : 0 });
    var nX = -Math.sin(h * Math.PI / 180), nY = Math.cos(h * Math.PI / 180);
    if (j === 0 || !pts.length || pts[pts.length - 1].x !== x || pts[pts.length - 1].y !== y) pts.push({ x: x, y: y, code: run.l || '?', nx: nX, ny: nY, kind: 'end', j: j, side: 'l' });
    var t = turnFor(run, j === last, mnt);
    var cnx = nX, cny = nY;
    if (t){ var hi = h * Math.PI / 180, ho = (h + t) * Math.PI / 180, ox = Math.cos(hi) - Math.cos(ho), oy = Math.sin(hi) - Math.sin(ho), ol = Math.sqrt(ox * ox + oy * oy) || 1; cnx = ox / ol; cny = oy / ol; }
    pts.push({ x: x2, y: y2, code: run.r || '?', kind: t === null ? 'end' : (t === 0 ? 'joint' : 'corner'), nx: cnx, ny: cny, bad: j < last && wrongTurn(run, mnt), j: j, side: 'r', pair: t !== null && j < last });
    x = x2; y = y2; xs.push(x); ys.push(y);
    if (t === null){ var gap = Math.max(12, L * 0.15); x += gap * Math.cos(h * Math.PI / 180); y += gap * Math.sin(h * Math.PI / 180); if (run._gapTurn && j < last) h += run._gapTurn; }
    else { h += t; totalTurn += t; }
  });
  var minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs), minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);
  var span = Math.max(maxX - minX, maxY - minY, 48), pad = span * 0.2, fs = span * 0.034, sw = span * 0.011;
  // ---- label placement: nothing is drawn on top of anything else ----
  var boxes = [];
  function boxOf(x, y, text, size, anchor){ var w = String(text).length * size * 0.6, hh = size * 0.62, x0 = anchor === 'start' ? x : anchor === 'end' ? x - w : x - w / 2; return { x0: x0 - size * 0.15, x1: x0 + w + size * 0.15, y0: y - hh, y1: y + hh }; }
  function hits(b){ return boxes.some(function(o){ return b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0; }); }
  function crossesRail(b){ return segs.some(function(sg){
    // does a rail line pass through the box? (clip the segment to the box)
    var t0 = 0, t1 = 1, dx = sg.x2 - sg.x1, dy = sg.y2 - sg.y1, P = [-dx, dx, -dy, dy], Q = [sg.x1 - b.x0, b.x1 - sg.x1, sg.y1 - b.y0, b.y1 - sg.y1];
    for (var q = 0; q < 4; q++){ if (P[q] === 0){ if (Q[q] < 0) return false; } else { var r = Q[q] / P[q]; if (P[q] < 0){ if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; } } }
    return true; }); }
  function anchorFor(nx){ return Math.abs(nx) > 0.6 ? (nx > 0 ? 'start' : 'end') : 'middle'; }
  function place(cands, text, size){
    var best = null;
    for (var c = 0; c < cands.length; c++){
      var a = cands[c].a || anchorFor(cands[c].nx || 0), b = boxOf(cands[c].x, cands[c].y, text, size, a), bad = (hits(b) ? 2 : 0) + (crossesRail(b) ? 1 : 0);
      if (!best || bad < best.bad){ best = { x: cands[c].x, y: cands[c].y, a: a, b: b, bad: bad }; if (!bad) break; }
    }
    boxes.push(best.b); return best;
  }
  // posts are obstacles too
  pts.forEach(function(pt){ var r = sw * 2.2; boxes.push({ x0: pt.x - r, x1: pt.x + r, y0: pt.y - r, y1: pt.y + r }); });
  var out = '', floatPosts = '', anyFloat = false;
  segs.forEach(function(sg){
    var dash = sg.known ? '' : ' stroke-dasharray="' + sw * 2 + ' ' + sw * 2 + '" opacity=".55"';
    var line = function(ax, ay, bx, by, col){ return '<line x1="' + ax + '" y1="' + ay + '" x2="' + bx + '" y2="' + by + '" stroke="' + col + '" stroke-width="' + sw + '" stroke-linecap="round"' + dash + '/>'; };
    // a floating rail (Non-Sub) is drawn in the lighter "float" green
    out += line(sg.x1, sg.y1, sg.x2, sg.y2, sg.ns ? 'var(--float)' : 'var(--accent)');
    if (sg.ns) anyFloat = true;
    // floats: a post that far in from the end, and the short piece out to the end in float green
    [['fl', 0], ['fr', 1]].forEach(function(f){
      var dist = sg[f[0]]; if (!dist) return; anyFloat = true;
      var t = f[1] ? (sg.L - dist) / sg.L : dist / sg.L, px = sg.x1 + (sg.x2 - sg.x1) * t, py = sg.y1 + (sg.y2 - sg.y1) * t;
      out += f[1] ? line(px, py, sg.x2, sg.y2, 'var(--float)') : line(sg.x1, sg.y1, px, py, 'var(--float)');
      var r = sw * 1.25; floatPosts += '<rect x="' + (px - r) + '" y="' + (py - r) + '" width="' + r * 2 + '" height="' + r * 2 + '" fill="var(--card)" stroke="var(--ink)" stroke-width="' + sw * 0.5 + '"/>';
      boxes.push({ x0: px - sw * 2.2, x1: px + sw * 2.2, y0: py - sw * 2.2, y1: py + sw * 2.2 });
    });
  });
  out += floatPosts;
  // footprints first (middle of the deck), then post codes, then section labels
  var feet = '';
  if (segs.length){
    var deckSide = totalTurn < 0 ? -1 : 1, big = segs.reduce(function(a, b){ return b.L > a.L ? b : a; });
    var hr = big.h * Math.PI / 180, dnx = -Math.sin(hr) * deckSide, dny = Math.cos(hr) * deckSide;
    var depth = span * 0.3;
    if (segs.length > 1){ var far = 0; xs.forEach(function(px, k){ var dd = (px - big.x1) * dnx + (ys[k] - big.y1) * dny; if (dd > far) far = dd; }); if (far > 0) depth = Math.min(depth, far * 0.5); }
    var fx = (big.x1 + big.x2) / 2 + dnx * Math.max(depth, span * 0.2), fy = (big.y1 + big.y2) / 2 + dny * Math.max(depth, span * 0.2);
    var ang = ((u._feet || 0) + (u._rot || 0)) % 360, f = span * 0.034;   // default: facing up (north); turned with its own button
    boxes.push({ x0: fx - f * 2.8, x1: fx + f * 2.8, y0: fy - f * 2.8, y1: fy + f * 2.8 });
    var cap = 'Standing on the deck, looking out', cp = place([{ x: fx, y: fy + f * 3.8, a: 'middle' }, { x: fx, y: fy - f * 3.8, a: 'middle' }, { x: fx + f * 3.2, y: fy, a: 'start' }, { x: fx - f * 3.2, y: fy, a: 'end' }, { x: fx, y: fy + f * 5.2, a: 'middle' }], cap, fs * 0.8);
    feet = '<g transform="translate(' + fx + ' ' + fy + ') rotate(' + ang + ')" fill="var(--muted)" aria-hidden="true">' +
      '<ellipse cx="' + (-f * 0.9) + '" cy="' + (-f * 0.5) + '" rx="' + f * 0.55 + '" ry="' + f * 1.05 + '"/><ellipse cx="' + (-f * 0.9) + '" cy="' + f * 1.05 + '" rx="' + f * 0.42 + '" ry="' + f * 0.45 + '"/>' +
      '<ellipse cx="' + (f * 0.9) + '" cy="' + (-f * 0.5) + '" rx="' + f * 0.55 + '" ry="' + f * 1.05 + '"/><ellipse cx="' + (f * 0.9) + '" cy="' + f * 1.05 + '" rx="' + f * 0.42 + '" ry="' + f * 0.45 + '"/>' +
      '<path d="M0 ' + (-f * 2.6) + ' l' + (-f * 0.7) + ' ' + f * 0.9 + ' h' + f * 1.4 + 'z"/></g>' +
      '<text x="' + cp.x + '" y="' + cp.y + '" dominant-baseline="middle" font-size="' + fs * 0.8 + '" text-anchor="' + cp.a + '" fill="var(--muted)" font-weight="700">' + cap + '</text>';
  }
  var posts = '';
  pts.forEach(function(pt, k){
    var r = sw * 1.6, cs = (pt.kind === 'corner') ? 1 : (totalTurn < 0 ? -1 : 1), d1 = fs * 1.5, d2 = fs * 2.6, cands = [];
    [[pt.nx * cs, pt.ny * cs], [-pt.nx * cs, -pt.ny * cs], [0, -1], [0, 1], [1, 0], [-1, 0], [0.7, -0.7], [-0.7, -0.7], [0.7, 0.7], [-0.7, 0.7]].forEach(function(v){ cands.push({ x: pt.x + v[0] * d1, y: pt.y + v[1] * d1, nx: v[0] }); });
    [[pt.nx * cs, pt.ny * cs], [0, -1], [0, 1], [1, 0], [-1, 0]].forEach(function(v){ cands.push({ x: pt.x + v[0] * d2, y: pt.y + v[1] * d2, nx: v[0] }); });
    var lp = place(cands, pt.code, fs * 0.85);
    var hitA = ' data-act="laypost" data-j="' + pt.j + '" data-side="' + pt.side + '" data-pair="' + (pt.pair ? 1 : 0) + '" style="cursor:pointer"';
    if (pt.kind === 'end' || k === 0) posts += '<rect x="' + (pt.x - r) + '" y="' + (pt.y - r) + '" width="' + r * 2 + '" height="' + r * 2 + '" fill="var(--ink)"/>';
    else if (pt.kind === 'corner') posts += '<circle cx="' + pt.x + '" cy="' + pt.y + '" r="' + r * (pt.bad ? 1.6 : 1.1) + '" fill="' + (pt.bad ? 'var(--badbg)' : 'var(--card)') + '" stroke="' + (pt.bad ? 'var(--bad)' : 'var(--ink)') + '" stroke-width="' + sw * (pt.bad ? 0.9 : 0.6) + '"/>';
    else posts += '<circle cx="' + pt.x + '" cy="' + pt.y + '" r="' + r * 0.8 + '" fill="var(--ink)"/>';
    posts += '<text x="' + lp.x + '" y="' + lp.y + '" font-size="' + fs * 0.85 + '" text-anchor="' + lp.a + '" dominant-baseline="middle" fill="var(--deep, var(--ink))" font-weight="800" text-decoration="underline"' + hitA + '>' + esc(pt.code) + '</text>';
    // a generous invisible tap target over the post and its code
    posts += '<circle cx="' + pt.x + '" cy="' + pt.y + '" r="' + Math.max(fs * 1.3, sw * 4) + '" fill="transparent"' + hitA + '/>';
  });
  var labels = '';
  segs.forEach(function(sg){
    var mx = (sg.x1 + sg.x2) / 2, my = (sg.y1 + sg.y2) / 2, dx = sg.x2 - sg.x1, dy = sg.y2 - sg.y1, d = Math.sqrt(dx * dx + dy * dy) || 1, side = totalTurn < 0 ? -1 : 1, nx = side * dy / d, ny = -side * dx / d, off = fs * 1.2;
    var lt = sg.tag + ' · ' + sg.len + (sg.ns ? ' · floating' : ''), cands = [];
    [1, 2, 3].forEach(function(m){ cands.push({ x: mx + nx * off * m, y: my + ny * off * m, nx: nx }); });
    [0.25, -0.25, 0.4, -0.4].forEach(function(t){ [1, 2].forEach(function(m){ cands.push({ x: mx + dx * t + nx * off * m, y: my + dy * t + ny * off * m, nx: nx }); }); });
    [1, 2, 3].forEach(function(m){ cands.push({ x: mx - nx * off * m, y: my - ny * off * m, nx: -nx }); });
    [4, 5, 6].forEach(function(m){ cands.push({ x: mx + nx * off * m, y: my + ny * off * m, nx: nx }); cands.push({ x: mx - nx * off * m, y: my - ny * off * m, nx: -nx }); });
    var lp = place(cands, lt, fs);
    labels += '<text x="' + lp.x + '" y="' + lp.y + '" font-size="' + fs + '" text-anchor="' + lp.a + '" dominant-baseline="middle" fill="var(--ink)" font-weight="800">' + esc(lt) + '</text>';
  });
  out += feet + labels + posts;
  // grow the drawing area to fit every label, so long runs shrink to fit instead of cutting text off
  var bx0 = minX - pad * 0.5, by0 = minY - pad * 0.5, bx1 = maxX + pad * 0.5, by1 = maxY + pad * 0.5;
  boxes.forEach(function(b){ bx0 = Math.min(bx0, b.x0); bx1 = Math.max(bx1, b.x1); by0 = Math.min(by0, b.y0); by1 = Math.max(by1, b.y1); });
  var m = (bx1 - bx0 + by1 - by0) * 0.03;
  out = '<svg class="laysvg" viewBox="' + [bx0 - m, by0 - m, bx1 - bx0 + m * 2, by1 - by0 + m * 2].map(function(n){ return n.toFixed(2); }).join(' ') + '" role="img" aria-label="Bird’s-eye layout of unit ' + esc(u.unit || '') + '">' + out + '</svg>';
  var turns = u.secs.slice(0, -1).map(function(run, j){
    var eff = run._turn || '', auto = autoTurnName(run, mnt);
    var opts = [['L', 'Left'], ['S', 'Straight'], ['R', 'Right']].map(function(o){
      var on = eff ? eff === o[0] : auto === o[1];
      return '<button type="button" class="tchip" data-act="turn" data-j="' + j + '" data-t="' + o[0] + '" aria-pressed="' + on + '">' + (o[0] === 'S' ? 'Straight' : 'Turns ' + o[1].toLowerCase()) + '</button>';
    }).join('');
    var wrong = wrongTurn(run, mnt);
    return '<div class="trow' + (wrong ? ' bad' : '') + '"><span class="tlab">' + esc(secLabel(u, j)) + ' → ' + esc(secLabel(u, j + 1)) + (eff ? '' : ' <em>auto</em>') + '</span><span class="tchips">' + opts + '</span>' +
      (wrong ? '<div class="twarn" role="alert">On a ' + esc(mnt || 'Fascia') + ' mount, ' + esc(run.r) + ' turns ' + (cornerDir(String(run.r), mnt) > 0 ? 'right' : 'left') + '. Check the end type or the turn.</div>' : '') + '</div>';
  }).join('');
  var head = '<div class="layhd"><div><b>' + (u._full ? 'Unit ' + esc(String(u.unit || '').trim() || '?') + ' layout' : 'Layout') + '</b><span>Tap a post code to change it</span></div>' +
    (u._full ? '<button type="button" class="layx" data-act="layfull" aria-label="Close full screen">×</button>' : '<button type="button" class="btn" data-act="layfull" aria-label="Full screen">⤢ Full screen</button>') + '</div>';
  var nWrong = u.secs.slice(0, -1).filter(function(run){ return wrongTurn(run, mnt); }).length;
  var turnBtn = u.secs.length > 1 ? '<button type="button" class="turntog" data-act="turnsshow" aria-expanded="' + !!u._showTurns + '">' + (u._showTurns ? 'Hide turns ▴' : 'Show turns ▾') + (nWrong && !u._showTurns ? ' <b>· ' + nWrong + ' to check</b>' : '') + '</button>' : '';
  return head + out + '<div class="laybar"><span class="lbl">' + turnBtn + '</span>' + (u._drawn ? '<button type="button" class="btn" data-act="drawedit">Edit drawing</button>' : '') + '<button type="button" class="btn" data-act="rot">Rotate drawing</button><button type="button" class="btn" data-act="feet">Turn feet · facing ' + ['N', 'E', 'S', 'W'][Math.round(((u._feet || 0) + (u._rot || 0)) % 360 / 90) % 4] + '</button>' + (u.secs.some(function(r){ return r._turn; }) ? '<button type="button" class="btn ghost" data-act="turnreset">Reset turns</button>' : '') + '</div>' + (u._showTurns ? turns : '') +
    '<div class="laykey"><span><i class="k-end"></i>End post</span><span><i class="k-cor"></i>Corner</span><span><i class="k-jt"></i>Joint</span>' + (anyFloat ? '<span><i class="k-fl"></i>Floating / float</span><span><i class="k-fp"></i>Float post</span>' : '') + '<span>Dashed = no measurement yet</span></div>';
}
// tap a post code on the layout: pick a new code (a corner changes both sides together)
function openLayPicker(u, i, b){
  var lay = el('u' + i + '_lay'); if (!lay) return;
  var old = lay.querySelector('.drawpick'); if (old) old.remove();
  var j = +b.getAttribute('data-j'), side = b.getAttribute('data-side'), pair = b.getAttribute('data-pair') === '1', run = u.secs[j];
  var title, opts;
  if (pair){
    var nx = u.secs[j + 1];
    title = 'Corner ' + secLabel(u, j) + ' / ' + secLabel(u, j + 1);
    opts = CORNER_PICKS.map(function(c){ return '<button type="button" class="tchip" data-act="laypick" data-j="' + j + '" data-side="pair" data-v="' + c.join('|') + '" aria-pressed="' + (c[0] === run.r && c[1] === nx.l) + '">' + esc(c[0] === c[1] ? c[0] : c[0] + ' → ' + c[1]) + '</button>'; });
  } else {
    var cur = side === 'l' ? run.l : run.r;
    title = (side === 'l' ? 'Start of ' : 'End of ') + secLabel(u, j);
    opts = END_PICKS.map(function(c){ return '<button type="button" class="tchip" data-act="laypick" data-j="' + j + '" data-side="' + side + '" data-v="' + c + '" aria-pressed="' + (c === cur) + '">' + esc(c) + '</button>'; });
  }
  var box = document.createElement('div'); box.className = 'drawpick';
  box.innerHTML = '<div class="dph"><b>' + esc(title) + '</b><button type="button" class="btn ghost" data-act="laypickx">Close</button></div><div class="dpo">' + opts.join('') + '</div>';
  lay.appendChild(box);
  var lr = lay.getBoundingClientRect(), br = b.getBoundingClientRect(), bw = Math.min(lr.width - 16, 380);
  box.style.width = bw + 'px';
  box.style.left = Math.max(8, Math.min(lr.width - bw - 8, br.left - lr.left + br.width / 2 - bw / 2)) + 'px';
  box.style.top = (br.bottom - lr.top + lay.scrollTop + 8) + 'px';
}
function layPick(u, b){
  var j = +b.getAttribute('data-j'), side = b.getAttribute('data-side'), v = b.getAttribute('data-v'), run = u.secs[j], mnt = unitSetup(u).mount;
  if (side === 'pair'){
    var t = turnFor(run, false, mnt);   // keep the shape as drawn: hold the turn it has now
    var c = v.split('|'); run.r = c[0]; u.secs[j + 1].l = c[1];
    if (!run._turn && t !== null) run._turn = t > 0 ? 'R' : t < 0 ? 'L' : 'S';
  } else if (side === 'l') run.l = v; else run.r = v;
}
// ---------- draw the railing with a finger; the app works out the sections and end codes ----------
function rdp(pts, eps){
  if (pts.length < 3) return pts.slice();
  var a = pts[0], b = pts[pts.length - 1], dx = b.x - a.x, dy = b.y - a.y, L = Math.sqrt(dx * dx + dy * dy) || 1, far = 0, k = 0;
  for (var i = 1; i < pts.length - 1; i++){ var d = Math.abs(dy * pts[i].x - dx * pts[i].y + b.x * a.y - b.y * a.x) / L; if (d > far){ far = d; k = i; } }
  if (far <= eps) return [a, b];
  return rdp(pts.slice(0, k + 1), eps).slice(0, -1).concat(rdp(pts.slice(k), eps));
}
function hdg(a, b){ return Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI; }
function ndeg(d){ while (d > 180) d -= 360; while (d <= -180) d += 360; return d; }
function seglen(a, b){ return Math.sqrt((b.x - a.x) * (b.x - a.x) + (b.y - a.y) * (b.y - a.y)); }
function recognize(pts){
  if (!pts || pts.length < 2) return null;
  var xs = pts.map(function(p){ return p.x; }), ys = pts.map(function(p){ return p.y; });
  var D = Math.sqrt(Math.pow(Math.max.apply(null, xs) - Math.min.apply(null, xs), 2) + Math.pow(Math.max.apply(null, ys) - Math.min.apply(null, ys), 2));
  if (D < 30) return null;
  var v = rdp(pts, Math.max(10, D * 0.045)), changedAny = true;
  while (changedAny && v.length > 2){
    changedAny = false;
    for (var k = 1; k < v.length - 1; k++){   // nearly straight: drop the bend
      if (Math.abs(ndeg(hdg(v[k], v[k + 1]) - hdg(v[k - 1], v[k]))) < 22){ v.splice(k, 1); changedAny = true; break; }
    }
    if (changedAny) continue;
    for (var j = 0; j < v.length - 1; j++){   // a tiny wiggle: fold it into its neighbours
      if (seglen(v[j], v[j + 1]) < D * 0.06){
        if (j === 0) v.splice(1, 1); else if (j === v.length - 2) v.splice(j, 1);
        else v.splice(j, 2, { x: (v[j].x + v[j + 1].x) / 2, y: (v[j].y + v[j + 1].y) / 2 });
        changedAny = true; break;
      }
    }
  }
  if (v.length < 2) return null;
  var turns = [], net = 0;
  for (var t = 1; t < v.length - 1; t++){ var tt = ndeg(hdg(v[t], v[t + 1]) - hdg(v[t - 1], v[t])); turns.push(tt); net += tt; }
  var flipped = false;
  if (net < 0){ v = v.slice().reverse(); turns = turns.slice().reverse().map(function(x){ return -x; }); flipped = true; }
  var lens = []; for (var q = 0; q < v.length - 1; q++) lens.push(seglen(v[q], v[q + 1]));
  var tl = turns.map(function(x){ var a = Math.abs(x); return { dir: x > 0 ? 1 : -1, deg: a >= 67.5 ? 90 : 45 }; });
  var h0 = Math.round(hdg(v[0], v[1]) / 45) * 45, hEnd = h0; tl.forEach(function(x){ hEnd += x.dir * x.deg; });
  return { lens: lens, h0: h0, hEnd: hEnd, start: v[0], turns: tl, flipped: flipped };
}
// convex corners (same way as the shape wraps) get the double-corner post; inside corners follow the mount's corner rules
function drawCodes(mount, turn){
  var ang = turn.deg !== 90;
  if (turn.dir > 0){
    if (mount === 'Inside') return ang ? ['I6A', 'I6A'] : ['I6', 'I6'];
    if (mount === 'Top') return ['EC', 'ECO'];
    return ang ? ['FA', 'FA'] : ['F', 'F'];
  }
  return mount === 'Inside' ? ['EC', 'ECO'] : ['IC', 'ICO'];
}
function drawStrokes(u){ var d = u._dr; if (!d.ov) d.ov = {}; return (d.done || []).concat(d.pts.length ? [d] : []); }
function shapePts(pt){
  var h = pt.r.h0, x = pt.r.start.x, y = pt.r.start.y, Q = [{ x: x, y: y }];
  pt.r.lens.forEach(function(L, j){ x += L * Math.cos(h * Math.PI / 180); y += L * Math.sin(h * Math.PI / 180); Q.push({ x: x, y: y }); if (j < pt.r.turns.length) h += pt.r.turns[j].dir * pt.r.turns[j].deg; });
  return Q;
}
var CORNER_PICKS = [['F','F'],['FA','FA'],['EC','ECO'],['ECO','EC'],['IC','ICO'],['FC','FCO'],['I6','I6'],['I6A','I6A'],['CJ','CJO'],['T','TO']];
var END_PICKS = ['E','W','3x2E','3x2FE','3x2IE','3x2TE'];
// tap a post on the drawing: pick its code
function drawHit(u, x, y){
  var d = drawRuns(u); if (!d) return null;
  var best = null;
  d.parts.forEach(function(pt, pi){ shapePts(pt).forEach(function(q, k){ var dd = Math.abs(q.x - x) + Math.abs(q.y - y); if (dd < 34 && (!best || dd < best.dd)) best = { dd: dd, pi: pi, k: k, last: k === pt.n, q: q }; }); });
  return best;
}
function openPicker(u, i, hit){
  var old = el('u' + i + '_pick'); if (old) old.remove();
  var d = drawRuns(u), pt = d.parts[hit.pi], corner = hit.k > 0 && hit.k < pt.n;
  var cur = hit.k === 0 ? d.runs[pt.first].l : d.runs[pt.first + hit.k - 1].r, curL = corner ? d.runs[pt.first + hit.k].l : '';
  var title = corner ? 'Corner ' + secLabel(u, pt.first + hit.k - 1) + ' / ' + secLabel(u, pt.first + hit.k) : (hit.k === 0 ? 'Start of ' : 'End of ') + secLabel(u, pt.first + (hit.k === 0 ? 0 : pt.n - 1));
  var opts = corner ? CORNER_PICKS.map(function(c){ return '<button type="button" class="tchip" data-act="drawpick" data-pi="' + hit.pi + '" data-k="' + hit.k + '" data-v="' + c.join('|') + '" aria-pressed="' + (c[0] === cur && c[1] === curL) + '">' + esc(c[0] === c[1] ? c[0] : c[0] + ' → ' + c[1]) + '</button>'; })
    : END_PICKS.map(function(c){ return '<button type="button" class="tchip" data-act="drawpick" data-pi="' + hit.pi + '" data-k="' + hit.k + '" data-v="' + c + '" aria-pressed="' + (c === cur) + '">' + esc(c) + '</button>'; });
  var box = document.createElement('div'); box.className = 'drawpick'; box.id = 'u' + i + '_pick';
  box.innerHTML = '<div class="dph"><b>' + esc(title) + '</b><button type="button" class="btn ghost" data-act="drawpickx">Close</button></div><div class="dpo">' + opts.join('') + '</div>';
  var pad = el('u' + i + '_pad'); pad.parentNode.insertBefore(box, pad.nextSibling);
  var W = pad.clientWidth, bw = Math.min(W - 16, 380);
  box.style.left = Math.max(8, Math.min(W - bw - 8, hit.q.x - bw / 2)) + pad.offsetLeft + 'px';
  box.style.top = (pad.offsetTop + Math.min(pad.clientHeight - 20, hit.q.y + 22)) + 'px'; box.style.width = bw + 'px';
}
function pickCode(u, i, b){
  var strokes = drawStrokes(u), d = drawRuns(u), pt = d.parts[+b.getAttribute('data-pi')], st = pt.st, k = +b.getAttribute('data-k'), v = b.getAttribute('data-v');
  if (k === 0) st.s = v; else if (k === pt.n) st.e = v; else { if (!st.ov) st.ov = {}; st.ov[k] = v.split('|'); }
  var pk = el('u' + i + '_pick'); if (pk) pk.remove();
  drawResult(u, i);
}
// every rail drawn for this unit (finished ones plus the one on the pad), in order, as sections
function drawRuns(u){
  var mnt = unitSetup(u).mount || 'Fascia', strokes = drawStrokes(u);
  var parts = [], runs = [];
  strokes.forEach(function(st){
    var r = recognize(st.pts); if (!r) return;
    var n = r.lens.length, first = runs.length;
    for (var j = 0; j < n; j++){
      var run = blankRun();
      var ov = st.ov || {};
      run.l = j === 0 ? st.s : (ov[j] ? ov[j][1] : drawCodes(mnt, r.turns[j - 1])[1]);
      run.r = j === n - 1 ? st.e : (ov[j + 1] ? ov[j + 1][0] : drawCodes(mnt, r.turns[j])[0]);
      if (j < n - 1){ if (r.turns[j].deg !== 90) run._deg = r.turns[j].deg; if (ov[j + 1]) run._turn = r.turns[j].dir > 0 ? 'R' : 'L'; }
      run._open = true; runs.push(run);
    }
    if (parts.length){ var prev = parts[parts.length - 1]; runs[first - 1]._gapTurn = Math.round(ndeg(r.h0 - prev.r.hEnd) / 45) * 45; }
    parts.push({ r: r, first: first, n: n, cur: st === u._dr, st: st });
  });
  return runs.length ? { parts: parts, runs: runs } : null;
}
function drawHtml(u, i){
  return '<div class="drawbox' + (u._drFull ? ' full' : '') + '" id="u' + i + '_draw"><div class="drawhd"><div class="dht"><b>Draw the railing' + (u._drFull ? ' · unit ' + esc(String(u.unit || '').trim() || '?') : '') + '</b>' +
    (u._drFull ? '<button type="button" class="layx" data-act="drawfull" aria-label="Close full screen">×</button>' : '<button type="button" class="btn" data-act="drawfull">⤢ Full screen</button>') + '</div><span>Trace one rail with your finger, start to finish, then lift. If the deck has more than one rail (say it’s broken by a column), tap <b style="display:inline;font-size:inherit">+ Another rail</b> and draw the next one. Corners become ' +
    ({ Inside: 'I6', Top: 'EC/IC' }[unitSetup(u).mount] || 'F') + ' posts, and you can change any code after.</span></div>' +
    '<canvas class="drawpad" id="u' + i + '_pad" aria-label="Drawing area"></canvas><div class="drawres" id="u' + i + '_res"></div></div>';
}
function drawResult(u, i){
  var box = el('u' + i + '_res'); if (!box) return;
  var d = drawRuns(u), pad = el('u' + i + '_pad'), cur = d && d.parts.filter(function(x){ return x.cur; })[0];
  paintPad(u, pad, d);
  var nDone = u._dr.done.length;
  if (!d){ box.innerHTML = '<div class="drawbtns"><span style="flex:1"></span><button type="button" class="btn" data-act="draw">Cancel</button></div>'; return; }
  var endChip = function(side, lab){ return '<button type="button" class="tchip" data-act="drawend" data-side="' + side + '" aria-pressed="' + (u._dr[side] === 'W') + '">' + lab + ': ' + ({ W: 'W · wall', E: 'E · end post' }[u._dr[side]] || u._dr[side]) + '</button>'; };
  var list = d.parts.map(function(pt, k){
    return '<div class="drawlist"><span class="rail">Rail ' + (k + 1) + (pt.cur ? '' : ' ✓') + '</span>' + d.runs.slice(pt.first, pt.first + pt.n).map(function(run, j){ return '<span class="dsec"><b>' + esc(secLabel(u, pt.first + j)) + '</b> ' + esc(run.l + ' → ' + run.r) + '</span>'; }).join('') + '</div>';
  }).join('');
  box.innerHTML = list + '<div class="hint" style="margin:0">Tap any code on the drawing to change it (say F to EC).</div>' +
    (cur && cur.r.flipped ? '<div class="hint" style="margin:0">Rail ' + d.parts.length + ' is numbered from the other end, the same way the layout view numbers it.</div>' : '') +
    (cur ? '<div class="drawbtns"><span class="lbl">Rail ' + d.parts.length + ' ends</span>' + endChip('s', 'Start') + endChip('e', 'End') + '</div>' : '<div class="hint" style="margin:0">Draw rail ' + (nDone + 1) + ' on the pad, or tap Use if that’s everything.</div>') +
    '<div class="drawbtns">' + (cur ? '<button type="button" class="btn ghost" data-act="drawredo">Redraw rail ' + d.parts.length + '</button>' : '') +
      (nDone ? '<button type="button" class="btn ghost" data-act="drawclear">Start over</button>' : '') +
      '<span style="flex:1"></span><button type="button" class="btn" data-act="draw">Cancel</button>' +
      (cur ? '<button type="button" class="btn" data-act="drawmore">+ Another rail</button>' : '') +
      '<button type="button" class="btn pri" data-act="drawuse">Use ' + d.runs.length + ' section' + (d.runs.length === 1 ? '' : 's') + '</button></div>';
}
function paintPad(u, pad, d){
  if (!pad) return;
  var ctx = pad.getContext('2d'), W = pad.clientWidth, H = pad.clientHeight, css = getComputedStyle(document.body);
  ctx.clearRect(0, 0, W, H);
  var pts = u._dr.pts;
  if (pts.length > 1){
    ctx.strokeStyle = 'rgba(120,110,100,' + (d && d.parts.some(function(x){ return x.cur; }) ? 0.25 : 0.7) + ')'; ctx.lineWidth = 4; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y); pts.forEach(function(p){ ctx.lineTo(p.x, p.y); }); ctx.stroke();
  }
  if (!d && !pts.length){ ctx.fillStyle = 'rgba(120,110,100,.8)'; ctx.font = '700 18px Nunito, sans-serif'; ctx.textAlign = 'center'; ctx.fillText('Draw here with one finger', W / 2, H / 2); return; }
  if (!d) return;
  var acc = css.getPropertyValue('--accent').trim() || '#2F5D50', ink = css.getPropertyValue('--ink').trim() || '#2A2622';
  // each rail's cleaned-up shape, where it was drawn: straight sections, square or 45° corners
  d.parts.forEach(function(pt){
    var Q = shapePts(pt);
    ctx.strokeStyle = acc; ctx.globalAlpha = pt.cur ? 1 : 0.6; ctx.lineWidth = 6; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(Q[0].x, Q[0].y); Q.forEach(function(p){ ctx.lineTo(p.x, p.y); }); ctx.stroke(); ctx.globalAlpha = 1;
    ctx.font = '800 15px Nunito, sans-serif'; ctx.fillStyle = ink; ctx.textBaseline = 'middle';
    for (var j = 0; j < pt.n; j++){
      var a = Q[j], b = Q[j + 1], mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, dx = b.x - a.x, dy = b.y - a.y, L = Math.sqrt(dx * dx + dy * dy) || 1;
      var nx = dy / L, ny = -dx / L;   // label on the outside (the deck is on the right of travel)
      ctx.textAlign = Math.abs(nx) > 0.6 ? (nx > 0 ? 'left' : 'right') : 'center';
      ctx.fillText(secLabel(u, pt.first + j), Math.min(W - 4, Math.max(4, mx + nx * 16)), Math.min(H - 8, Math.max(8, my + ny * 16)));
    }
    ctx.font = '700 13px Nunito, sans-serif';
    Q.forEach(function(p, k){
      var code = k === 0 ? d.runs[pt.first].l : d.runs[pt.first + k - 1].r;
      ctx.beginPath(); ctx.arc(p.x, p.y, k === 0 || k === Q.length - 1 ? 7 : 6, 0, Math.PI * 2); ctx.fillStyle = ink; ctx.fill();
      // the code sits in a small tappable tag
      var tx = Math.min(W - 24, Math.max(24, p.x)), ty = Math.min(H - 12, Math.max(12, p.y + (p.y > H / 2 ? 22 : -22))), tw = ctx.measureText(code).width + 14;
      ctx.fillStyle = '#FFFDF9'; ctx.strokeStyle = 'rgba(90,80,70,.55)'; ctx.lineWidth = 1.5; ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(tx - tw / 2, ty - 11, tw, 22, 8); else ctx.rect(tx - tw / 2, ty - 11, tw, 22);
      ctx.fill(); ctx.stroke(); ctx.fillStyle = ink; ctx.textAlign = 'center'; ctx.fillText(code, tx, ty + 1);
    });
  });
}
function initDraw(u, i){
  var pad = el('u' + i + '_pad'); if (!pad) return;
  if (!u._dr.done) u._dr.done = [];
  var dpr = window.devicePixelRatio || 1, W = pad.clientWidth, H = pad.clientHeight;
  if (u._dr.W && u._dr.H && (u._dr.W !== W || u._dr.H !== H)){
    var sc = Math.min(W / u._dr.W, H / u._dr.H), ox = (W - u._dr.W * sc) / 2, oy = (H - u._dr.H * sc) / 2;
    var mv = function(arr){ return (arr || []).map(function(q){ return { x: Math.round(q.x * sc + ox), y: Math.round(q.y * sc + oy) }; }); };
    u._dr.pts = mv(u._dr.pts); (u._dr.done || []).forEach(function(st){ st.pts = mv(st.pts); });
  }
  u._dr.W = W; u._dr.H = H;
  pad.width = Math.round(W * dpr); pad.height = Math.round(H * dpr); pad.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
  var drawing = false, pt = function(e){ var r = pad.getBoundingClientRect(); return { x: Math.round(e.clientX - r.left), y: Math.round(e.clientY - r.top) }; };
  var down = null;
  pad.addEventListener('pointerdown', function(e){ e.preventDefault(); down = pt(e); drawing = false; try { pad.setPointerCapture(e.pointerId); } catch (x) {} });
  pad.addEventListener('pointermove', function(e){
    if (!down) return; e.preventDefault(); var p = pt(e);
    if (!drawing){
      if (Math.abs(p.x - down.x) + Math.abs(p.y - down.y) < 10) return;
      drawing = true; var pk = el('u' + i + '_pick'); if (pk) pk.remove();
      u._dr.pts = [down]; u._dr.s = 'E'; u._dr.e = 'E'; u._dr.ov = {};
    }
    var l = u._dr.pts[u._dr.pts.length - 1];
    if (Math.abs(p.x - l.x) + Math.abs(p.y - l.y) > 2){ u._dr.pts.push(p); paintPad(u, pad, null); paintDone(u, pad); }
  });
  var end = function(){
    if (!down) return; var tap = !drawing, at0 = down; down = null;
    if (tap){ var hit = drawHit(u, at0.x, at0.y); if (hit) openPicker(u, i, hit); return; }
    drawing = false; drawResult(u, i);
  };
  pad.addEventListener('pointerup', end); pad.addEventListener('pointercancel', end);
  drawResult(u, i);
}
// while a new rail is being drawn, keep the finished ones on screen
function paintDone(u, pad){
  if (!u._dr.done.length) return;
  var keep = u._dr.pts; u._dr.pts = [];
  var d = drawRuns(u); u._dr.pts = keep;
  if (!d) return;
  var ctx = pad.getContext('2d');
  d.parts.forEach(function(pt){
    var h = pt.r.h0, x = pt.r.start.x, y = pt.r.start.y;
    ctx.strokeStyle = 'rgba(47,93,80,.6)'; ctx.lineWidth = 6; ctx.beginPath(); ctx.moveTo(x, y);
    pt.r.lens.forEach(function(L, j){ x += L * Math.cos(h * Math.PI / 180); y += L * Math.sin(h * Math.PI / 180); ctx.lineTo(x, y); if (j < pt.r.turns.length) h += pt.r.turns[j].dir * pt.r.turns[j].deg; });
    ctx.stroke();
  });
}
// reopen a finished drawing; codes changed since (in the sections or on the layout) carry back into it
function editDrawing(u){
  if (!u._drawn) return;
  u._dr = { done: JSON.parse(JSON.stringify(u._drawn.done)), pts: [], s: 'E', e: 'E', ov: {}, W: u._drawn.W, H: u._drawn.H }; u._editing = true; u._full = false;
  var d = drawRuns(u);
  if (d && d.runs.length === u.secs.length){
    d.parts.forEach(function(pt){
      var st = pt.st; st.s = u.secs[pt.first].l || st.s; st.e = u.secs[pt.first + pt.n - 1].r || st.e; st.ov = st.ov || {};
      for (var k = 1; k < pt.n; k++) st.ov[k] = [u.secs[pt.first + k - 1].r, u.secs[pt.first + k].l];
    });
  }
}
function applyDrawing(u, i){
  var d = drawRuns(u); if (!d) return;
  var go = function(){
    if (totalSecs() - u.secs.length + d.runs.length > MAX_RUNS) return msg('The cut sheet holds ' + MAX_RUNS + ' sections in total.');
    var rot = ((d.parts[0].r.h0 - 270) % 360 + 360) % 360, old = u.secs;
    if (u._editing){ d.runs.forEach(function(run, k){ var o = old[k]; if (!o) return; ['len', 'fl', 'fr', '_floats'].concat(RUN_MORE.map(function(c){ return c.key; })).forEach(function(key){ if (o[key] !== undefined && o[key] !== '') run[key] = o[key]; }); if (o.lenOk && String(o.len || '').trim()){ run.lenOk = true; run._open = false; } }); }
    u._drawn = { W: u._dr.W, H: u._dr.H, done: drawStrokes(u).map(function(st){ return { pts: st.pts, s: st.s, e: st.e, ov: JSON.parse(JSON.stringify(st.ov || {})) }; }) };
    u.secs = d.runs; u._rot = rot; u._feet = (360 - rot) % 360; u._layout = true; u._full = !!u._drFull; u._dr = null; u._drFull = false; u._editing = false;
    renderRuns(); changed();
    var f = el('u' + i + 's0_len'); if (f){ f.scrollIntoView({ block: 'center' }); setTimeout(function(){ f.focus(); }, 250); }
  };
  if (u._editing){
    if (d.runs.length === u.secs.length) return go();
    return ask('You drew ' + d.runs.length + ' sections (it was ' + u.secs.length + '). Measurements stay with the sections in order' + (d.runs.length < u.secs.length ? ', and the last ' + (u.secs.length - d.runs.length) + ' will be dropped' : '') + '.', 'Update', go);
  }
  var filled = u.secs.some(function(r){ return String(r.len || '').trim() !== '' || r.l || r.r; });
  if (filled) return ask('Replace the ' + u.secs.length + ' section' + (u.secs.length === 1 ? '' : 's') + ' in this unit with the ' + d.runs.length + ' you drew?', 'Replace', go);
  go();
}
function updLayout(i){ var b = el('u' + i + '_lay'); if (b && units[i]) b.innerHTML = layoutSvg(units[i]); }
// ---------- privacy screens: R (railing) / W (wall) ends, all saved on one screen cut sheet ----------
function screenType(sc){ var a = sc.l, b = sc.r; if (a === 'W' && b === 'W') return 'WW'; if ((a === 'R' && b === 'W') || (a === 'W' && b === 'R')) return 'RW'; if (a === 'R' && b === 'R') return 'RR'; return ''; }
function screenBox(u, i){
  var list = u.screens || [];
  return '<div class="custbox scrbox"><div class="lbl">Privacy screen' + (list.length > 1 ? 's' : '') + ' <em style="font-style:normal;color:var(--muted)">· saved on the job’s screen cut sheet</em></div>' +
    list.map(function(sc, k){
      var id = 'u' + i + 'k' + k + '_', t = screenType(sc), sv = parseLen(sc.size), okSize = !(sv === null || isNaN(sv) || sv <= 0);
      var nm = 'Screen ' + (String(u.unit).trim() || '?') + (list.length > 1 ? ' #' + (k + 1) : '');
      if (sc._done && okSize && t && t !== 'RR') return '<button type="button" class="secrow" data-act="scropen" data-k="' + k + '" aria-label="Edit ' + esc(nm) + '"><span class="ck" style="color:var(--onaccent)">' + CHECK + '</span>' +
        '<span class="lab">' + esc(nm) + '</span><span class="ends">' + esc(sc.l + ' → ' + sc.r) + (String(sc.so || '').trim() ? ' · S.O ' + esc(sc.so) : '') + '</span><span class="len">' + esc(fmtFrac(sv)) + '</span></button>';
      var ends = function(side, lab){ return '<div class="fld"><div class="lbl">' + lab + '</div><div class="chips" style="--n:2">' +
        [['R', 'R · Railing'], ['W', 'W · Wall']].map(function(o){ return '<button type="button" class="chip" data-scrend="' + k + '|' + side + '" data-val="' + o[0] + '" aria-pressed="' + (sc[side] === o[0]) + '">' + o[1] + '</button>'; }).join('') + '</div></div>'; };
      return '<div class="scr" data-k="' + k + '"><div class="top"><b>' + esc(nm) + (t ? ' <span class="pill" style="margin-left:6px">' + (t === 'WW' ? 'Wall to wall' : t === 'RW' ? 'Rail to wall' : 'R–R') + '</span>' : '') + '</b>' +
        '<span>' + (t && t !== 'RR' ? '<button type="button" class="btn ghost" data-act="scrdone" data-k="' + k + '">Done</button> ' : '') + (list.length > 1 ? '<button type="button" class="btn danger" data-act="scrdel" data-k="' + k + '">Delete</button>' : '') + '</span></div>' +
        '<div class="g2">' + ends('l', 'Left end') + ends('r', 'Right end') + '</div>' +
        '<div class="g2" data-fracslot>' + numField(id + 'size', 'Size (in)', sc.size, { need: true, cls: 'meas', ph: 'e.g. 45 1/2', attrs: ' data-scr="' + k + '" data-sf="size"' }) +
          numField(id + 'so', 'S.O (in)', sc.so, { ph: 'Optional', attrs: ' data-scr="' + k + '" data-sf="so"' }) + '</div>' +
        (t === 'RR' ? '<div class="twarn">R–R isn’t on the screen cut sheet. A screen needs at least one wall end.</div>' : '') + '</div>';
    }).join('') +
    '<button type="button" class="addsec" data-act="scradd">+ Add another screen for this unit</button></div>';
}
function updBadge(){
  var n = 0; units.forEach(function(u){ u.secs.forEach(function(s){ if (needsConf(s)) n++; }); });
  var b = el('checkBadge'); b.hidden = !n; b.textContent = n + ' to check';
}
function at(t){ var ub = t.closest('.unit'); if (!ub) return null; var i = +ub.getAttribute('data-u'), sb = t.closest('[data-s]'); return { i: i, u: units[i], j: sb ? +sb.getAttribute('data-s') : -1, box: ub, sec: sb }; }
el('units').addEventListener('input', function(e){
  var t = e.target, p = at(t); if (!p) return;
  var uf = t.getAttribute('data-ufield'), key = t.getAttribute('data-key');
  if (uf === 'unit'){
    p.u.unit = t.value.trim();
    Array.prototype.forEach.call(p.box.querySelectorAll('[data-lab]'), function(l){ var s = l.closest('[data-s]'); l.textContent = secLabel(p.u, +s.getAttribute('data-s')); });
    p.box.querySelector('[data-act="addsec"]').textContent = '+ Add section ' + secLabel(p.u, p.u.secs.length);
  } else if (t.hasAttribute('data-scr')){ p.u.screens[+t.getAttribute('data-scr')][t.getAttribute('data-sf')] = t.value; showHint(t); }
  else if (uf === 'notetext'){ p.u.notes = t.value; }
  else if (uf === 'post' || uf === 'block' || uf === 'standoff'){ p.u[uf] = t.value; showHint(t); updNote(p.i); }
  else if (key && p.j >= 0 && t.tagName === 'INPUT'){
    var run = p.u.secs[p.j]; run[key] = t.value; if (t.hasAttribute('data-frac')) showHint(t);
    if (key === 'len'){ run.lenOk = false; el('u' + p.i + '_sum').textContent = unitSum(p.u); updConf(p); updLayout(p.i); }
    if (key === 'ar' || key === 'al') updLayout(p.i);
    if (key === 'fl' || key === 'fr'){
      run._floatsOk = false; updLayout(p.i);
      var fb = p.sec && p.sec.querySelector('[data-act="floatok"]'), fh = p.sec && p.sec.querySelector('.floathint'); if (fb) fb.hidden = false; if (fh) fh.hidden = true;
    }
  }
  changed();
});
// keep units in number order (201, 202, 203…); blank or text unit numbers stay at the bottom in the order entered
function unitKey(u){ var m = String(u.unit == null ? '' : u.unit).trim().match(/^(\d+)(.*)$/); return m ? [0, +m[1], m[2].toLowerCase()] : [1, 0, '']; }
function sortUnits(){
  var before = units.slice();
  units = units.map(function(u, k){ return { u: u, k: k, key: unitKey(u) }; }).sort(function(a, b){
    return a.key[0] - b.key[0] || a.key[1] - b.key[1] || (a.key[2] < b.key[2] ? -1 : a.key[2] > b.key[2] ? 1 : 0) || a.k - b.k;
  }).map(function(x){ return x.u; });
  if (floors && floors[curFloor]) floors[curFloor].units = units;
  return units.some(function(u, k){ return u !== before[k]; });
}
el('units').addEventListener('change', function(e){
  var t = e.target, p = at(t); if (!p) return;
  if (t.getAttribute('data-ufield') === 'unit'){
    var moved = p.u; if (!sortUnits()) return;
    renderRuns(); changed();
    var box = document.querySelector('.unit[data-u="' + units.indexOf(moved) + '"]'); if (box) box.scrollIntoView({ block: 'start' });
    return;
  }
  if (t.getAttribute('data-ufield') === 'custom'){
    p.u.custom = t.checked; renderRuns(); changed();
    if (t.checked){ var f = el('u' + p.i + '_post'); if (f) f.focus(); }
    return;
  }
  if (t.getAttribute('data-ufield') === 'screen'){
    p.u.screen = t.checked;
    if (t.checked && !(p.u.screens && p.u.screens.length)) p.u.screens = [{ l: 'R', r: 'W', size: '', so: '' }];
    renderRuns(); changed();
    if (t.checked){ var sf = el('u' + p.i + 'k0_size'); if (sf) sf.focus(); }
    return;
  }
  if (t.getAttribute('data-ufield') === 'hasnotes'){
    p.u.hasNotes = t.checked; renderRuns(); changed();
    if (t.checked){ var nt = el('u' + p.i + '_notes'); if (nt) nt.focus(); }
    return;
  }
  if (t.getAttribute('data-ufield') === 'mountdiff'){
    p.u.mountDiff = t.checked; if (!t.checked){ p.u.mount = ''; p.u.standoff = ''; }
    renderRuns(); changed(); return;
  }
  if (t.getAttribute('data-sfield') === 'floats' && p.j >= 0){
    var sr = p.u.secs[p.j]; sr._floats = t.checked;
    if (!t.checked){ sr.fl = ''; sr.fr = ''; }
    renderRuns(); changed();
    if (t.checked){ var ff = el('u' + p.i + 's' + p.j + '_fl'); if (ff) ff.focus(); }
    return;
  }
  var key = t.getAttribute('data-key');
  if (t.getAttribute('data-sfield') === 'floatrail' && p.j >= 0){
    var fr = p.u.secs[p.j]; fr._floatRail = t.checked; fr.ns = t.checked ? 'Yes' : '';
    renderRuns(); changed(); return;
  }
  if (key && t.tagName === 'SELECT' && p.j >= 0){
    var rs = p.u.secs[p.j], before = isFloatCombo(rs);
    rs[key] = t.value; if (key === 'l') rs._carried = false; updLayout(p.i);
    if (before !== isFloatCombo(rs)){
      if (!isFloatCombo(rs) && rs._floatRail){ rs._floatRail = false; rs.ns = ''; }
      renderRuns(); changed();
      var again = el('u' + p.i + 's' + p.j + '_' + key); if (again) again.focus();
      return;
    }
    changed();
  }
});
function updConf(p){
  var run = p.u.secs[p.j], box = p.sec.querySelector('.conf');
  if (box) box.innerHTML = confHtml(run);
  p.sec.classList.toggle('unconf', needsConf(run)); updBadge();
}
var pendingDel = '', pendingTimer = null;
function confirmDel(b, key){
  if (pendingDel === key){ pendingDel = ''; return true; }
  pendingDel = key; clearTimeout(pendingTimer); pendingTimer = setTimeout(function(){ pendingDel = ''; b.textContent = 'Delete'; }, 3000);
  b.textContent = 'Tap again to delete'; return false;
}
el('units').addEventListener('click', function(e){
  var se = e.target.closest('[data-scrend]');
  if (se){ var ps = at(se); if (!ps) return; var kk = se.getAttribute('data-scrend').split('|'); ps.u.screens[+kk[0]][kk[1]] = se.getAttribute('data-val'); renderRuns(); changed(); return; }
  var mb = e.target.closest('[data-umount]');
  if (mb){ var pm = at(mb); if (!pm) return; var v = mb.getAttribute('data-umount'); pm.u.mount = pm.u.mount === v ? '' : v; renderRuns(); changed(); return; }
  var b = e.target.closest('[data-act]'); if (!b) return;
  var p = at(b); if (!p) return;
  var act = b.getAttribute('data-act'), u = p.u, j = p.j, focus = null, scrollTo = null;
  if (act === 'ok'){ u.secs[j].lenOk = true; u.secs[j]._open = false; }
  else if (act === 'open'){ u.secs[j]._open = true; focus = 'u' + p.i + 's' + j + '_len'; }
  else if (act === 'close'){ u.secs[j]._open = false; }
  else if (act === 'layout'){ u._layout = !u._layout; }
  else if (act === 'draw'){ u._editing = false; if (u._dr) u._dr = null; else if (u._drawn) editDrawing(u); else u._dr = { done: [], pts: [], s: 'E', e: 'E' }; if (u._dr) scrollTo = 'u' + p.i + '_pad'; }
  else if (act === 'drawclear'){ u._dr = { done: [], pts: [], s: 'E', e: 'E' }; }
  else if (act === 'drawredo'){ u._dr.pts = []; u._dr.s = 'E'; u._dr.e = 'E'; u._dr.ov = {}; drawResult(u, p.i); return; }
  else if (act === 'drawpick'){ pickCode(u, p.i, b); return; }
  else if (act === 'laypost'){ openLayPicker(u, p.i, b); return; }
  else if (act === 'laypickx'){ var lpx = b.closest('.drawpick'); if (lpx) lpx.remove(); return; }
  else if (act === 'laypick'){ layPick(u, b); }
  else if (act === 'layfull'){ u._full = !u._full; }
  else if (act === 'turnsshow'){ u._showTurns = !u._showTurns; updLayout(p.i); return; }
  else if (act === 'drawfull'){ u._drFull = !u._drFull; }
  else if (act === 'floatok'){
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    if (j >= 0) u.secs[j]._floatsOk = true;
    b.hidden = true; var hn = p.sec && p.sec.querySelector('.floathint'); if (hn) hn.hidden = false;
    updLayout(p.i); changed(); return;
  }
  else if (act === 'drawedit'){ editDrawing(u); scrollTo = 'u' + p.i + '_pad'; }
  else if (act === 'drawpickx'){ var pk = el('u' + p.i + '_pick'); if (pk) pk.remove(); return; }
  else if (act === 'drawmore'){ var dr = u._dr; if (!recognize(dr.pts)) return; dr.done.push({ pts: dr.pts, s: dr.s, e: dr.e, ov: dr.ov || {} }); dr.pts = []; dr.s = 'E'; dr.e = 'E'; dr.ov = {}; drawResult(u, p.i); return; }
  else if (act === 'drawend'){ var sd = b.getAttribute('data-side'); u._dr[sd] = u._dr[sd] === 'E' ? 'W' : 'E'; drawResult(u, p.i); return; }
  else if (act === 'drawuse'){ return applyDrawing(u, p.i); }
  else if (act === 'scradd'){ (u.screens = u.screens || []).forEach(function(sc){ sc._done = true; }); u.screens.push({ l: 'R', r: 'W', size: '', so: '' }); focus = 'u' + p.i + 'k' + (u.screens.length - 1) + '_size'; }
  else if (act === 'scrdone'){ var dk = +b.getAttribute('data-k'), dv = parseLen(u.screens[dk].size); if (dv === null || isNaN(dv) || dv <= 0){ var sf2 = el('u' + p.i + 'k' + dk + '_size'); if (sf2) sf2.focus(); return msg('Enter the screen size first.'); } u.screens[dk]._done = true; }
  else if (act === 'scropen'){ var ok = +b.getAttribute('data-k'); u.screens[ok]._done = false; focus = 'u' + p.i + 'k' + ok + '_size'; }
  else if (act === 'scrdel'){ if (!confirmDel(b, 'scr' + p.i + '.' + b.getAttribute('data-k'))) return; u.screens.splice(+b.getAttribute('data-k'), 1); if (!u.screens.length){ u.screen = false; } }
  else if (act === 'turn'){ var tj = +b.getAttribute('data-j'), tv = b.getAttribute('data-t'), sec = u.secs[tj]; sec._turn = autoTurnName(sec, unitSetup(u).mount) === { L:'Left', S:'Straight', R:'Right' }[tv] ? '' : tv; updLayout(p.i); changed(); return; }
  else if (act === 'rot'){ u._rot = ((u._rot || 0) + 90) % 360; updLayout(p.i); changed(); return; }
  else if (act === 'feet'){ u._feet = ((u._feet || 0) + 90) % 360; updLayout(p.i); changed(); return; }
  else if (act === 'turnreset'){ u.secs.forEach(function(r){ r._turn = ''; }); updLayout(p.i); changed(); return; }
  else if (act === 'del'){ if (!confirmDel(b, 'del' + p.i + '.' + j)) return; u.secs.splice(j, 1); if (!u.secs.length) u.secs.push(blankRun()); }
  else if (act === 'udel'){ if (!confirmDel(b, 'udel' + p.i)) return; units.splice(p.i, 1); if (!units.length) units.push(blankUnit('')); }
  else if (totalSecs() >= MAX_RUNS){ return msg('The cut sheet holds ' + MAX_RUNS + ' sections in total.'); }
  else if (act === 'dup'){ var c = JSON.parse(JSON.stringify(u.secs[j])); c.len = ''; c.lenOk = false; c._open = true; u.secs.splice(j + 1, 0, c); focus = 'u' + p.i + 's' + (j + 1) + '_len'; }
  else if (act === 'addsec'){
    var last = u.secs[u.secs.length - 1], r = blankRun();
    if (last){ last._open = false; if (CARRY[last.r]){ r.l = CARRY[last.r]; r._carried = true; } }
    u.secs.push(r); focus = 'u' + p.i + 's' + (u.secs.length - 1) + '_' + (r.l ? 'r' : 'l');
  } else if (act === 'ucopy'){
    if (totalSecs() + u.secs.length > MAX_RUNS) return msg('Copying this unit would go over ' + MAX_RUNS + ' sections.');
    // next unit: an exact copy (measurements and all) with the next unit number
    var fu = JSON.parse(JSON.stringify(u)); fu.unit = nextUnitNum(); fu._full = false; fu._dr = null;
    fu.secs.forEach(function(r){ r._open = false; });
    units.push(fu); sortUnits(); focus = 'u' + units.indexOf(fu) + '_num';
  } else if (act === 'ucodes'){
    if (totalSecs() + u.secs.length > MAX_RUNS) return msg('Copying this unit would go over ' + MAX_RUNS + ' sections.');
    // next unit: same post codes (and unit setup), every measurement left blank
    var cu = JSON.parse(JSON.stringify(u)); cu.unit = nextUnitNum(); cu._full = false; cu._dr = null;
    cu.secs = u.secs.map(function(r){ var n = blankRun(); n.l = r.l; n.r = r.r; if (r._turn) n._turn = r._turn; if (r._carried) n._carried = true; n._open = true; return n; });
    cu.screens = (u.screens || []).map(function(sc){ return { l: sc.l, r: sc.r, size: '', so: '' }; });
    cu.hasNotes = false; cu.notes = '';
    units.forEach(function(x){ x.secs.forEach(function(r){ r._open = false; }); (x.screens || []).forEach(function(sc){ if (String(sc.size || '').trim()) sc._done = true; }); });
    units.push(cu); sortUnits(); focus = 'u' + units.indexOf(cu) + 's0_len';
  } else return;
  renderRuns(); changed();
  if (scrollTo && el(scrollTo)) el(scrollTo).scrollIntoView({ block: 'center' });
  if (focus && el(focus)){ var f = el(focus); f.scrollIntoView({ block: 'center' }); setTimeout(function(){ f.focus(); if (f.select) f.select(); }, 250); }
});
el('addUnit').onclick = function(){
  if (totalSecs() >= MAX_RUNS) return msg('The cut sheet holds ' + MAX_RUNS + ' sections in total.');
  units.forEach(function(u){ u.secs.forEach(function(s){ s._open = false; }); (u.screens || []).forEach(function(sc){ sc._done = true; }); });
  var nu = blankUnit(nextUnitNum()); units.push(nu); sortUnits(); renderRuns(); changed();
  var f = el('u' + units.indexOf(nu) + '_num'); if (f){ f.scrollIntoView({ block: 'center' }); setTimeout(function(){ f.focus(); f.select(); }, 250); }
};

// ---------- tabs ----------
function showTab(t){
  tab = t; rememberOpen();
  if (t === 'units' && units.length) renderRuns();
  el('tab-job').hidden = t !== 'job'; el('tab-units').hidden = t !== 'units';
  Array.prototype.forEach.call(document.querySelectorAll('.navtab'), function(x){ x.classList.toggle('on', x.getAttribute('data-t') === t); });
  el('eyebrow').textContent = t === 'job' ? 'Step 1 of 2' : (String(header.B4 || '').trim() || 'New job') + ' · Step 2 of 2';
  el('screenTitle').textContent = t === 'job' ? 'Job info' : 'Units';
  applyMount(); window.scrollTo(0, 0);
}
Array.prototype.forEach.call(document.querySelectorAll('.navtab'), function(x){ x.onclick = function(){ showTab(x.getAttribute('data-t')); }; });
el('back').onclick = function(){ ask('Leave this job? Your entries stay on this tablet as a draft.', 'Leave', function(){ try { localStorage.removeItem(OPEN_KEY); } catch (e) {} location.reload(); }); };
el('file').onchange = function(){ var f = this.files[0]; if (f) loadData(f, f.name, false, {}); this.value = ''; };
// ---------- next floor: same rail setup, new sheet ----------
var LAST_KEY = 'ridgeway-last-setup';
function readLast(){ try { return JSON.parse(localStorage.getItem(LAST_KEY) || 'null'); } catch (e) { return null; } }
function saveLast(){ try { var h = JSON.parse(JSON.stringify(header)); delete h._prev; localStorage.setItem(LAST_KEY, JSON.stringify({ header: h, t: Date.now() })); } catch (e) {} }
function ordinal(n){ var v = n % 100; return n + ((v > 10 && v < 14) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th')); }
function bumpFloor(name){
  name = String(name || '');
  var a = name.replace(/\b(\d+)(st|nd|rd|th)(\s*(floor|flr|fl|level|lvl))/i, function(m, n, sx, rest){ return ordinal(+n + 1) + rest; });
  if (a !== name) return a;
  a = name.replace(/\b(floor|flr|level|lvl|L)\s*(\d+)\b/i, function(m, w, n){ return m.replace(n, String(+n + 1)); });
  return a;
}
// from an open job, saved or not: carry this job's setup to a fresh sheet
function nextFloorFromHere(){
  if (!String(header.B4 || '').trim()) return msg('Enter the job name first, so the next floor knows what to follow.');
  if (floors) return addFloor();
  var unsaved = el('draftPill') && !el('draftPill').hidden && units.some(function(u){ return u.secs.some(function(r){ return String(r.len || '').trim() !== ''; }); });
  var go = function(){ saveLast(); try { localStorage.removeItem(DRAFT_PREFIX + 'new-job'); } catch (e) {} startNextFloor(); };
  if (unsaved) return ask('This floor hasn’t been saved yet. Start the next floor anyway? The measurements on this floor will be cleared.', 'Next floor', go);
  go();
}
function startNextFloor(){
  var last = readLast(); if (!last || !last.header) return;
  var go = function(){
    try { localStorage.removeItem(DRAFT_PREFIX + 'new-job'); } catch (e) {}
    var h = JSON.parse(JSON.stringify(last.header)); h._prev = String(h.B4 || '').trim(); h.B4 = bumpFloor(h._prev);
    startNew({ header: h, units: [blankUnit('')], nextFloor: true });
  };
  if (readDraft('new-job')) return ask('Start the next floor? This replaces the unsaved draft on this tablet.', 'Next floor', go);
  go();
}
(function(){
  var l = readLast(); if (!l || !l.header) return;
  var h = l.header, bits = [h.B7 ? h.B7 + ' mount' : '', h.B6 || '', isNum(h.B12) ? 'posts ' + fmtFrac(parseLen(String(h.B12))) : ''].filter(Boolean);
  el('nextName').textContent = 'Same setup as ' + (String(h.B4 || '').trim() || 'the last job');
  el('nextInfo').textContent = bits.join(' · ');
  el('nextFloor').hidden = false;
  el('nextBtn').onclick = startNextFloor;
})();
el('newJob').onclick = function(){
  if (readDraft('new-job')) return ask('Start fresh? This replaces the unsaved draft on this tablet.', 'Start new', function(){ try { localStorage.removeItem(DRAFT_PREFIX + 'new-job'); } catch (e) {} startNew(); });
  startNew();
};

// ---------- save ----------
function valueFor(f, raw){
  raw = raw === undefined || raw === null ? '' : raw;
  if (typeof raw === 'number') return raw;
  raw = String(raw).trim(); if (raw === '') return '';
  if (f.key === 'tag') return raw;
  if (f.type === 'num'){ var v = parseLen(raw); if (isNaN(v) || v === null) throw new Error(f.label + ': "' + raw + '" is not a number'); return Math.round(v * 1e6) / 1e6; }
  return raw;
}
function isNum(v){ var p = parseLen(String(v == null ? '' : v)); return p !== null && !isNaN(p); }
function buildXml(hdr, rows, errs){
  var xml = sheetXml;
  WRITE.forEach(function(f){ try { xml = writeCell(xml, f.cell, valueFor(f, hdr[f.cell])); } catch (e) { errs.push(e.message); } });
  if (String(hdr.B10 == null ? '' : hdr.B10).trim() === '') xml = writeCell(xml, 'B10', POST_WALLS[0]);
  for (var i = 0; i < MAX_RUNS; i++){
    var row = FIRST_ROW + i, run = rows[i];
    RUN_COLS.forEach(function(c){
      try { xml = writeCell(xml, c.col + row, run ? valueFor({ label: run.tag + ' ' + c.label, type: c.type, key: c.key }, run[c.key]) : ''); }
      catch (e) { errs.push(e.message); }
    });
  }
  return xml;
}
var SCR_FIRST = 7, SCR_MAX = 50;
function buildScreenBlob(rw, ww){
  return JSZip.loadAsync(SCREEN_TEMPLATE_B64, { base64: true, createFolders: false }).then(function(z){
    return Promise.all([z, z.file('xl/workbook.xml').async('string'), z.file('xl/_rels/workbook.xml.rels').async('string')]);
  }).then(function(a){
    var z = a[0], wb = a[1], path = sheetPaths(a[1], a[2]).Inputs;
    return z.file(path).async('string').then(function(xml){
      var top = header.scrT || (/flat/i.test(String(header.B8 || '')) ? 'Flat Glass' : 'Glass');
      var cells = { B2: String(header.B4 || '').trim(), E2: String(header.B6 || ''), B3: valueFor({ type: 'num', label: 'Screen height' }, header.scrH), E3: valueFor({ type: 'num', label: 'DBL channel down' }, header.scrD), E4: top };
      Object.keys(cells).forEach(function(c){ xml = writeCell(xml, c, cells[c]); });
      for (var i = 0; i < SCR_MAX; i++){
        var row = SCR_FIRST + i, r = rw[i], w = ww[i];
        xml = writeCell(xml, 'A' + row, r ? r.unit : ''); xml = writeCell(xml, 'B' + row, r ? r.size : ''); xml = writeCell(xml, 'C' + row, r ? r.so : '');
        xml = writeCell(xml, 'H' + row, w ? w.unit : ''); xml = writeCell(xml, 'I' + row, w ? w.size : ''); xml = writeCell(xml, 'J' + row, w ? w.so : '');
      }
      z.file(path, xml, { createFolders: false });
      if (/<calcPr\b[^>]*fullCalcOnLoad=/.test(wb)) wb = wb.replace(/fullCalcOnLoad="[^"]*"/, 'fullCalcOnLoad="1"');
      else if (/<calcPr\b/.test(wb)) wb = wb.replace(/<calcPr\b/, '<calcPr fullCalcOnLoad="1"');
      else wb = wb.replace('</workbook>', '<calcPr fullCalcOnLoad="1"/></workbook>');
      z.file('xl/workbook.xml', wb, { createFolders: false });
      return z.generateAsync({ type: 'blob', compression: 'DEFLATE', mimeType: XLSX_TYPE });
    });
  });
}
// a small, plain workbook: one row per unit with notes, for review before fabrication
function buildNotesBlob(list){
  var z = new JSZip(), xe = function(t){ return xmlEsc(String(t)).replace(/"/g, '&quot;'); };
  var cell = function(ref, v, st){ var s = st ? ' s="' + st + '"' : ''; if (typeof v === 'number') return '<c r="' + ref + '"' + s + '><v>' + v + '</v></c>'; return '<c r="' + ref + '"' + s + ' t="inlineStr"><is><t xml:space="preserve">' + xe(v) + '</t></is></c>'; };
  var rows = [
    '<row r="1">' + cell('A1', 'Job', 1) + cell('B1', String(header.B4 || '').trim(), 1) + '</row>',
    '<row r="2">' + cell('A2', 'Notes for review before fabrication · ' + new Date().toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' })) + '</row>',
    '<row r="4">' + cell('A4', 'Unit', 1) + cell('B4', 'Mount', 1) + cell('C4', 'Notes', 1) + '</row>'
  ];
  list.forEach(function(n, k){ var r = 5 + k, un = /^\d+$/.test(n.unit) ? +n.unit : n.unit; rows.push('<row r="' + r + '">' + cell('A' + r, un, 2) + cell('B' + r, n.mount || '', 2) + cell('C' + r, n.text, 2) + '</row>'); });
  z.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>');
  z.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  z.file('xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Notes" sheetId="1" r:id="rId1"/></sheets></workbook>');
  z.file('xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>');
  z.file('xl/styles.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="12"/><name val="Calibri"/></font><font><b/><sz val="12"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" horizontal="left" wrapText="1"/></xf></cellXfs></styleSheet>');
  z.file('xl/worksheets/sheet1.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols><col min="1" max="1" width="12" customWidth="1"/><col min="2" max="2" width="12" customWidth="1"/><col min="3" max="3" width="90" customWidth="1"/></cols><sheetData>' + rows.join('') + '</sheetData><pageSetup orientation="landscape"/></worksheet>');
  return z.generateAsync({ type: 'blob', compression: 'DEFLATE', mimeType: XLSX_TYPE });
}
function makeBlob(xml){
  return JSZip.loadAsync(srcData, Object.assign({ createFolders: false }, srcOpts)).then(function(z){
    z.file(inputPath, xml, { createFolders: false });
    return z.file('xl/workbook.xml').async('string').then(function(wb){
      if (/<calcPr\b[^>]*fullCalcOnLoad=/.test(wb)) wb = wb.replace(/fullCalcOnLoad="[^"]*"/, 'fullCalcOnLoad="1"');
      else if (/<calcPr\b/.test(wb)) wb = wb.replace(/<calcPr\b/, '<calcPr fullCalcOnLoad="1"');
      else wb = wb.replace('</workbook>', '<calcPr fullCalcOnLoad="1"/></workbook>');
      z.file('xl/workbook.xml', wb, { createFolders: false });
      return z.generateAsync({ type: 'blob', compression: 'DEFLATE', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    });
  });
}
// Saves go through the viewer's Google Drive connector into the Cut Sheets folder;
// if Drive can't take it, the tablet is offered the file to save instead.
var CUT_FOLDER_ID = '118Pr7F1Rf_vvnNu8QkKMWAqdiJMfvYmT', CUT_FOLDER_URL = 'https://drive.google.com/drive/folders/' + CUT_FOLDER_ID;
var XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
function cap(name){ return window.claude && window.claude.use ? window.claude.use(name).catch(function(){ return null; }) : Promise.resolve(null); }
function driveError(e){
  var c = e && e.code;
  if (c === 'needs_reauth') return 'Google Drive needs reconnecting (claude.ai Settings → Connectors)';
  if (c === 'server_not_connected' || c === 'selection_required') return 'Google Drive isn’t connected for this account (claude.ai Settings → Connectors)';
  if (c === 'not_in_manifest' || c === 'approval_required' || c === 'consent_required') return 'Google Drive wasn’t allowed for this page. Tap Save again and choose Allow';
  if (c === 'no_mcp') return 'Drive saving only works when you’re signed in to claude.ai';
  if (c === 'tool_error') return 'Drive refused the file' + (e.message ? ' (' + String(e.message).slice(0, 120) + ')' : '');
  return 'Couldn’t reach Google Drive' + (c ? ' (' + c + ')' : '');
}
function upload(blob, name){
  return cap('mcp').then(function(mcp){
    if (!mcp) throw { code: 'no_mcp' };
    return mcp.listTools().then(function(l){ return !!(l && l.fileArgs); }, function(){ return false; }).then(function(fileArgs){
      var content = fileArgs ? Promise.resolve({ $file: { data: blob, name: 'cut-sheet.xlsx', type: XLSX_TYPE } }) : blobToB64(blob);
      return content.then(function(b64){
        if (typeof b64 === 'string' && b64.length > 1000000) throw { code: 'too_big', message: 'file too large to send without file upload support' };
        return mcp.callTool('Google Drive', 'create_file', { title: name, parentId: CUT_FOLDER_ID, contentMimeType: XLSX_TYPE, disableConversionToGoogleType: true, base64Content: b64 });
      });
    });
  }).then(function(r){ var p = r && r.payload; return { folder: CUT_FOLDER_URL, url: p && (p.viewUrl || p.webViewLink) }; });
}
function saveToTablet(blob, name){
  return cap('downloads').then(function(d){
    if (!d) return false;
    return d.save({ filename: name, data: blob }).then(function(){ return true; }, function(){ return false; });
  });
}
el('save').onclick = function(){
  clearMsg();
  var errs = [], seenU = {}, groups = {}, mainKey = setupKey(unitSetup({}));
  if (!String(header.B4 || '').trim()) errs.push('Enter the job name (it becomes the file name)');
  else if (floors && floors.some(function(f, k){ return k !== curFloor && String(f.header.B4 || '').trim().toLowerCase() === String(header.B4).trim().toLowerCase(); })) errs.push('Another floor tab already has the name “' + String(header.B4).trim() + '”. Give this floor its own name so it doesn’t replace that one in Drive');
  else if (header._prev && String(header.B4).trim().toLowerCase() === String(header._prev).trim().toLowerCase()) errs.push('Change the job name for this floor. “' + header._prev + '” was the last floor, and the same name would replace it in Drive');
  units.forEach(function(u, ui){
    var filled = u.secs.filter(function(r){ return RUN_COLS.some(function(c){ return c.key !== 'tag' && String(r[c.key] == null ? '' : r[c.key]).trim() !== ''; }); });
    if (!filled.length) return;
    var un = String(u.unit).trim();
    if (!un) errs.push('Unit ' + (ui + 1) + ' on the list needs a unit number');
    else if (seenU[un]) errs.push('Unit ' + un + ' is entered twice');
    seenU[un] = true;
    var rows = [];
    u.secs.forEach(function(r, j){ if (filled.indexOf(r) >= 0){ var c = JSON.parse(JSON.stringify(r)); c.tag = secLabel(u, j); rows.push(c); if (needsConf(r)) errs.push('Confirm ' + c.tag); } });
    var s = unitSetup(u), who = 'Unit ' + (un || '?');
    if (u.mountDiff && MOUNTS.indexOf(u.mount) < 0) errs.push(who + ': pick its mount');
    if (u.custom){ if (!isNum(u.post) || !isNum(u.block)) errs.push(who + ' needs its own post and block height'); }
    else { if (!isNum(header.B12)) errs.push('Enter the post height (Job info)'); if (!isNum(header.B13)) errs.push('Enter the block height (Job info)'); }
    if (s.mount !== 'Top' && !isNum(s.standoff)) errs.push(u.mountDiff && s.mount !== String(header.B7 || '') && !isNum(header.B11) ? who + ' needs a standoff' : 'Enter the standoff (Job info)');
    var k = setupKey(s);
    if (!groups[k]) groups[k] = { setup: s, rows: [], units: 0 };
    groups[k].rows = groups[k].rows.concat(rows); groups[k].units++;
  });
  // main sheet first, then the others grouped by post height (lowest first)
  var sheets = Object.keys(groups).sort(function(a, b){
    if (a === mainKey) return -1; if (b === mainKey) return 1;
    var pa = parseFloat(nkey(groups[a].setup.post)) || 0, pb = parseFloat(nkey(groups[b].setup.post)) || 0;
    return pa - pb || (a < b ? -1 : 1);
  }).map(function(k){
    var g = groups[k], s = g.setup;
    return { name: k === mainKey ? jobFile() + '.xlsx' : sheetName(s), hdr: Object.assign({}, header, { B7: s.mount, B11: s.mount === 'Top' ? header.B11 : s.standoff, B12: s.post, B13: s.block }), rows: g.rows, units: g.units };
  });
  var rw = [], ww = [];
  units.forEach(function(u, ui){
    if (!u.screen) return;
    var un = String(u.unit).trim(), who = 'Unit ' + (un || (ui + 1));
    (u.screens || []).forEach(function(sc, k){
      if (String(sc.size == null ? '' : sc.size).trim() === '') return;
      var t = screenType(sc), tag = who + ' screen' + ((u.screens.length > 1) ? ' #' + (k + 1) : '');
      if (!un) errs.push('Unit ' + (ui + 1) + ' on the list needs a unit number');
      if (!isNum(sc.size)) errs.push(tag + ': size is not a number');
      if (String(sc.so || '').trim() !== '' && !isNum(sc.so)) errs.push(tag + ': S.O is not a number');
      if (t === 'RR') errs.push(tag + ' is R–R; a screen needs at least one wall end');
      if (!t) errs.push(tag + ': pick both ends');
      var row = { unit: isNaN(+un) ? un : +un, size: isNum(sc.size) ? Math.round(parseLen(String(sc.size)) * 1e6) / 1e6 : '', so: isNum(sc.so) ? Math.round(parseLen(String(sc.so)) * 1e6) / 1e6 : '' };
      if (t === 'WW') ww.push(row); else if (t === 'RW') rw.push(row);
    });
  });
  if (rw.length || ww.length){
    if (!isNum(header.scrH)) errs.push('Enter the screen height (Job info → Privacy screens)');
    if (rw.length > SCR_MAX || ww.length > SCR_MAX) errs.push('The screen cut sheet holds ' + SCR_MAX + ' rail-to-wall and ' + SCR_MAX + ' wall-to-wall screens');
    sheets.push({ name: jobFile() + ' - Privacy Screens.xlsx', rows: [], units: rw.length + ww.length, info: jobFile() + ' - Privacy Screens.xlsx (' + rw.length + ' rail-to-wall, ' + ww.length + ' wall-to-wall)', make: function(){ return buildScreenBlob(rw, ww); } });
  }
  var notes = units.filter(function(u){ return u.hasNotes && String(u.notes || '').trim(); }).map(function(u){ return { unit: String(u.unit).trim(), mount: unitSetup(u).mount, text: String(u.notes).trim() }; });
  if (!sheets.length) errs.push('Add at least one measurement');
  if (notes.length) sheets.push({ name: jobFile() + ' - Notes.xlsx', rows: [], units: notes.length, info: jobFile() + ' - Notes.xlsx (' + notes.length + ' unit' + (notes.length === 1 ? '' : 's') + ')', make: function(){ return buildNotesBlob(notes); } });
  sheets.forEach(function(s){ if (s.rows.length > MAX_RUNS) errs.push(s.name + ' has ' + s.rows.length + ' sections; a cut sheet holds ' + MAX_RUNS); });
  sheets.forEach(function(s){ if (!s.make) s.xml = buildXml(s.hdr, s.rows, errs); });
  if (errs.length){ var uniq = errs.filter(function(x, k){ return errs.indexOf(x) === k; }); return msg('Before saving: ' + uniq.slice(0, 5).join(' · ') + (uniq.length > 5 ? ' · and ' + (uniq.length - 5) + ' more' : '')); }
  var btn = el('save'); btn.disabled = true; btn.firstChild.textContent = 'Saving…';
  var done = [], local = [], failed = [], queued = [], why = '';
  sheets.reduce(function(chain, s){
    return chain.then(function(){ return s.make ? s.make() : makeBlob(s.xml); }).then(function(blob){
      var info = s.info || (s.name + ' (' + s.units + ' unit' + (s.units === 1 ? '' : 's') + ', ' + s.rows.length + ' section' + (s.rows.length === 1 ? '' : 's') + ')');
      return upload(blob, s.name).then(function(){ done.push(info); }, function(e){
        why = driveError(e);
        var fallback = function(){ return saveToTablet(blob, s.name).then(function(ok){ (ok ? local : failed).push(info); }); };
        return shouldQueue(e) ? outboxAdd(blob, s.name, info).then(function(){ queued.push(info); }, fallback) : fallback();
      });
    });
  }, Promise.resolve()).then(function(){
    btn.disabled = false; btn.firstChild.textContent = 'Save';
    updOutbox();
    if (!failed.length && !local.length){
      if (floors){ floors[curFloor].saved = true; persist(); renderFloors(); }
      else { try { localStorage.removeItem(DRAFT_PREFIX + fileName); } catch (e) {} }
      el('draftPill').hidden = true;
      saveLast();
      if (!queued.length) msgLinks('Saved to the Cut Sheets folder in Drive: ' + done.join(' · ') + '.', [['Open folder', CUT_FOLDER_URL]], true);
      else msg((done.length ? 'Saved to Drive: ' + done.join(' · ') + '. ' : '') + 'No signal right now, so ' + queued.join(' · ') + (queued.length === 1 ? ' is' : ' are') + ' saved on this tablet and will go to Drive by itself once you’re on a hotspot or Wi-Fi. Keep the app open, or open it again when you have signal.', true);
      var nf = document.createElement('div'); nf.style.marginTop = '10px';
      nf.innerHTML = '<button type="button" class="btn pri" id="nextFloorGo">Start next floor · same setup ›</button>';
      el('msg').appendChild(nf); el('nextFloorGo').onclick = function(){ if (floors) addFloor(); else startNextFloor(); };
    } else {
      var t = (done.length ? 'Saved to Drive: ' + done.join(' · ') + '. ' : '') + why + '. ';
      if (local.length) t += 'Saved to this tablet instead: ' + local.join(' · ') + '. ';
      if (failed.length) t += 'Not saved yet: ' + failed.join(' · ') + '. ';
      msg(t + 'Your entries are still on this tablet, so you can tap Save again.', !failed.length);
    }
  }).catch(function(e){ btn.disabled = false; btn.firstChild.textContent = 'Save'; msg('Save failed: ' + (e && e.message ? e.message : e)); });
};

// ---------- outbox: finished sheets waiting for signal, sent to Drive automatically ----------
function idb(){
  return new Promise(function(ok, bad){
    if (!window.indexedDB) return bad(new Error('no storage'));
    var r = indexedDB.open('ridgeway-cutsheets', 1);
    r.onupgradeneeded = function(){ var d = r.result; if (!d.objectStoreNames.contains('outbox')) d.createObjectStore('outbox', { keyPath: 'id' }); if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv'); };
    r.onsuccess = function(){ ok(r.result); }; r.onerror = function(){ bad(r.error); };
  });
}
function store(name, mode, fn){
  return idb().then(function(d){ return new Promise(function(ok, bad){
    var t = d.transaction(name, mode), req = fn(t.objectStore(name));
    t.oncomplete = function(){ ok(req ? req.result : undefined); }; t.onerror = function(){ bad(t.error); }; t.onabort = function(){ bad(t.error); };
  }); });
}
function outboxAdd(blob, name, info){
  // a newer save of the same file replaces any older one still waiting
  return outboxList().then(function(items){
    return Promise.all(items.filter(function(x){ return x.name === name; }).map(function(x){ return store('outbox', 'readwrite', function(s){ return s.delete(x.id); }); }));
  }).then(function(){ return store('outbox', 'readwrite', function(s){ return s.put({ id: Date.now() + '|' + name, name: name, info: info, blob: blob, t: Date.now() }); }); });
}
function outboxList(){ return store('outbox', 'readonly', function(s){ return s.getAll(); }).then(function(a){ return (a || []).sort(function(x, y){ return x.t - y.t; }); }, function(){ return []; }); }
function kvGet(k){ return store('kv', 'readonly', function(s){ return s.get(k); }).catch(function(){ return null; }); }
function kvSet(k, v){ return store('kv', 'readwrite', function(s){ return s.put(v, k); }).catch(function(){}); }
function shouldQueue(e){
  var c = e && e.code, m = String(e && e.message || e || '');
  if (c === 'no_mcp' || c === 'needs_reauth' || c === 'server_not_connected' || c === 'not_in_manifest' || c === 'approval_required' || c === 'tool_error') return false;
  if (/bad file name/i.test(m)) return false;
  return true;
}
var flushing = false;
function flushOutbox(){
  if (flushing) return; flushing = true;
  var sent = [];
  outboxList().then(function(items){
    return items.reduce(function(chain, it){
      return chain.then(function(stop){
        if (stop) return true;
        return upload(it.blob, it.name).then(function(){ sent.push(it.info || it.name); return store('outbox', 'readwrite', function(s){ return s.delete(it.id); }).then(function(){ return false; }); }, function(){ return true; });
      });
    }, Promise.resolve(false));
  }).then(function(){
    flushing = false; updOutbox();
    if (sent.length) msgLinks('Back online. Sent to the Cut Sheets folder in Drive: ' + sent.join(' · ') + '.', [['Open folder', CUT_FOLDER_URL]], true);
  }, function(){ flushing = false; updOutbox(); });
}
var outboxTimer = null;
function updOutbox(){
  outboxList().then(function(items){
    var b = el('outbox'); if (!b) return;
    b.hidden = !items.length;
    if (items.length) el('outboxText').textContent = items.length + ' cut sheet' + (items.length === 1 ? '' : 's') + ' waiting for signal: ' + items.map(function(x){ return x.name; }).join(', ') + '. ' + (items.length === 1 ? 'It sends' : 'They send') + ' to Drive by itself once you’re online.';
    clearInterval(outboxTimer);
    if (items.length) outboxTimer = setInterval(function(){ if (navigator.onLine !== false) flushOutbox(); }, 45000);
  });
}
window.addEventListener('online', function(){ setTimeout(flushOutbox, 1500); });
document.addEventListener('visibilitychange', function(){ if (!document.hidden) flushOutbox(); });
el('outboxSend').onclick = function(){ flushOutbox(); };
updOutbox(); setTimeout(flushOutbox, 3000);

// ---------- fractions: docked right under the box being typed in ----------
var FRACS = ['1/16','1/8','3/16','1/4','5/16','3/8','7/16','1/2','9/16','5/8','11/16','3/4','13/16','7/8','15/16'];
var fracBar = document.createElement('div'); fracBar.className = 'fracbar'; fracBar.hidden = true;
fracBar.innerHTML = '<div class="cap">TAP A FRACTION</div><div class="keys">' + FRACS.map(function(f){ return '<button type="button" tabindex="-1" data-f="' + f + '">' + f + '</button>'; }).join('') + '<button type="button" tabindex="-1" class="alt" data-f="">None</button></div>';
document.body.appendChild(fracBar);
var fracTarget = null, fracHide = null;
function parkFrac(){ fracBar.hidden = true; if (fracBar.parentNode !== document.body) document.body.appendChild(fracBar); fracTarget = null; }
function keepVisible(){
  if (fracBar.hidden) return;
  var vv = window.visualViewport, bottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
  var r = fracBar.getBoundingClientRect();
  if (r.bottom > bottom - 8) window.scrollBy(0, r.bottom - bottom + 16);
}
if (window.visualViewport) window.visualViewport.addEventListener('resize', function(){ setTimeout(keepVisible, 60); });
document.addEventListener('focusin', function(e){
  var t = e.target;
  if (t && t.matches && t.matches('input,select')) document.body.classList.add('typing');
  if (t && t.matches && t.matches('input[data-frac]')){
    clearTimeout(fracHide); fracTarget = t;
    var slot = t.closest('[data-fracslot]') || t.parentNode;
    if (slot.nextSibling !== fracBar) slot.parentNode.insertBefore(fracBar, slot.nextSibling);
    fracBar.hidden = false;
    setTimeout(keepVisible, 350);
  }
});
document.addEventListener('focusout', function(){
  clearTimeout(fracHide);
  fracHide = setTimeout(function(){
    var a = document.activeElement;
    if (!(a && a.matches && a.matches('input,select'))) document.body.classList.remove('typing');
    if (!(a && a.matches && a.matches('input[data-frac]'))){ fracBar.hidden = true; fracTarget = null; }
  }, 150);
});
fracBar.addEventListener('pointerdown', function(e){ e.preventDefault(); });
fracBar.addEventListener('mousedown', function(e){ e.preventDefault(); });
fracBar.addEventListener('click', function(e){
  var b = e.target.closest('button'); if (!b || !fracTarget) return;
  var v = fracTarget.value.trim().replace(/[\s-]*\d+\s*\/\s*\d+\s*$/, '').trim(), f = b.getAttribute('data-f');
  fracTarget.value = f ? (v ? v + ' ' + f : f) : v;
  fracTarget.dispatchEvent(new Event('input', { bubbles: true }));
  var done = fracTarget; fracBar.hidden = true; fracTarget = null; done.blur();   // fraction picked: the number is finished, so close the keyboard
});

// ---------- draft (per tablet, best effort) ----------
var pillTimer = null;
function syncFloor(){ if (floors && floors[curFloor]){ floors[curFloor].header = header; floors[curFloor].units = units; } }
function persist(){
  syncFloor();
  try { localStorage.setItem(DRAFT_PREFIX + fileName, JSON.stringify({ header: header, units: units, t: Date.now(), floors: floors, cur: curFloor })); el('draftPill').hidden = false; } catch (e) {}
}
function changed(){
  if (floors && floors[curFloor]) floors[curFloor].saved = false;
  persist(); updBadge(); if (floors) renderFloors();
}
// ---------- floors: one tab per floor of the building along the bottom ----------
function floorLabel(f, k){
  var n = String(f.header.B4 || '').trim();
  var m = n.match(/\b\d+(st|nd|rd|th)\s*(floor|flr|fl|level|lvl)\b|\b(floor|flr|level|lvl|L)\s*\d+\b|\b(ground|main|roof|penthouse|ph)\b/i);
  return m ? m[0] : (n ? (n.length > 16 ? n.slice(0, 15) + '…' : n) : 'Floor ' + (k + 1));
}
function renderFloors(){
  var fb = el('floorbar'); if (!fb) return;
  document.body.classList.toggle('hasfloors', !!floors);
  if (!floors){ fb.hidden = true; return; }
  fb.hidden = false;
  fb.innerHTML = floors.map(function(f, k){ return '<button type="button" class="ftab' + (k === curFloor ? ' on' : '') + '" data-floor="' + k + '" aria-pressed="' + (k === curFloor) + '">' + (f.saved ? '✓ ' : '') + esc(floorLabel(f, k)) + '</button>'; }).join('') +
    '<button type="button" class="ftab add" data-floor="add">+ Next floor</button>';
  var on = fb.querySelector('.ftab.on'); if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
function switchFloor(k){
  if (!floors || !floors[k]) return;
  syncFloor(); curFloor = k; header = floors[k].header; units = floors[k].units;
  clearMsg(); renderHeader(); renderRuns(); applyMount(); showTab(tab); persist(); renderFloors();
}
function addFloor(){
  syncFloor();
  var h = JSON.parse(JSON.stringify(header)); h._prev = String(header.B4 || '').trim(); h.B4 = bumpFloor(h._prev);
  floors.push({ header: h, units: [blankUnit('')] });
  tab = 'job'; switchFloor(floors.length - 1);
  msg('Next floor: same setup as ' + (h._prev || 'the last floor') + '. Check the job name, and change anything that’s different on this floor.', true);
  setTimeout(function(){ var j = el('h_B4'); if (j){ j.focus(); j.select(); } }, 300);
}
function removeFloor(){
  if (!floors || floors.length < 2) return;
  var f = floors[curFloor], has = f.units.some(function(u){ return u.secs.some(function(r){ return String(r.len || '').trim() !== ''; }); });
  ask('Remove the “' + floorLabel(f, curFloor) + '” tab' + (has && !f.saved ? '? Its measurements haven’t been saved and will be lost.' : '? Anything already saved to Drive stays there.'), 'Remove', function(){
    floors.splice(curFloor, 1); curFloor = Math.max(0, curFloor - 1);
    header = floors[curFloor].header; units = floors[curFloor].units;
    clearMsg(); renderHeader(); renderRuns(); applyMount(); showTab(tab); persist(); renderFloors();
  });
}
el('floorbar').addEventListener('click', function(e){
  var b = e.target.closest('[data-floor]'); if (!b) return;
  var v = b.getAttribute('data-floor');
  if (v === 'add'){ if (!String(header.B4 || '').trim()) return msg('Enter this floor’s job name first, so the next floor knows what to follow.'); return addFloor(); }
  if (+v !== curFloor) switchFloor(+v);
});
// ---------- a refresh (on purpose or by accident) comes back to the same job, floor and tab ----------
function rememberOpen(){ try { if (fileName) localStorage.setItem(OPEN_KEY, JSON.stringify({ name: fileName, tab: tab })); } catch (e) {} }
setTimeout(function(){
  var o = null; try { o = JSON.parse(localStorage.getItem(OPEN_KEY) || 'null'); } catch (e) {}
  if (!o || !o.name || !el('app').hidden) return;
  if (o.name === 'new-job'){
    var d = readDraft('new-job'); if (!d) return;
    d.tab = o.tab; d.quiet = true; startNew(d);
  } else {
    kvGet('open-src').then(function(src){
      if (!src || src.name !== o.name || !el('app').hidden) return;
      var d = readDraft(o.name); if (d){ d.tab = o.tab; d.quiet = true; }
      loadData(src.b64, src.name, false, { base64: true }, d || { tab: o.tab, quiet: true });
    });
  }
}, 0);
function offerDraft(){
  var d = readDraft(fileName); if (!d || !(d.units || d.runs)) return;
  var m = el('msg'); m.hidden = false; m.className = 'msg ok';
  m.innerHTML = 'You have unsaved entries for this file from ' + esc(new Date(d.t).toLocaleString()) + '. <button class="btn" type="button" id="restore">Restore them</button>';
  el('restore').onclick = function(){ header = Object.assign(header, d.header); units = d.units || groupUnits(d.runs); units.forEach(function(u){ if (u.custom == null){ u.custom = false; u.post = ''; u.block = ''; } }); renderHeader(); renderRuns(); applyMount(); msg('Restored your unsaved entries.', true); };
}
window.__test = { parseLen: parseLen, fmtFrac: fmtFrac, writeCell: writeCell, readCell: readCell, CARRY: CARRY };
})();
