import os, json, hashlib, subprocess
src=open('deps/field-artifact-snapshot.html',encoding='utf-8').read().split('\n')
jszip='\n'.join(src[111:124])
D='shop/'; O='out/shop-app/'; os.makedirs(O, exist_ok=True)
WEBAPP='https://script.google.com/macros/s/AKfycbzfJwNBkDvCyr3_mzOfKA5q_bELUvgF2WyBoN8fEH86KNsbvvuhpJL575SkwAcsx3zj0A/exec'
head=open(D+'head.html').read(); body=open(D+'body.html').read(); app=open(D+'app.js').read().replace('__WEBAPP__', WEBAPP)
# the bird's-eye layout drawing, shared with the field app (read-only here)
_fa=open('live/app.js').read()
_h=_fa[_fa.index('var JOINT_CODES'):_fa.index('function layoutSvg(u){')]
_l=_fa[_fa.index('function layoutSvg(u){'):_fa.index('// tap a post code on the layout')]
_l=_l[:_l.index('  var turns = u.secs.slice(0, -1).map')] + "  return out + '<div class=\"laykey\"><span><i class=\"k-end\"></i>End post</span><span><i class=\"k-cor\"></i>Corner</span><span><i class=\"k-jt\"></i>Joint</span>' + (anyFloat ? '<span><i class=\"k-fl\"></i>Floating / float</span><span><i class=\"k-fp\"></i>Float post</span>' : '') + '</div>';\n}\n"
_l=_l.replace("  var feet = '';\n  if (segs.length){", "  var feet = '';\n  if (false && segs.length){")
# E–E breaks: a gap of 12% of the whole unit, so separate rails read as separate (the field app's fixed 12" was lost next to the post icons)
_l=_l.replace("  var mnt = unitSetup(u).mount, last = u.secs.length - 1;\n", "  var mnt = unitSetup(u).mount, last = u.secs.length - 1;\n  var ZGAP = u.secs.reduce(function(a, r){ var v = parseLen(r.len); return a + (v > 0 ? v : 36); }, 0) * 0.12;\n", 1)
_l=_l.replace("var gap = Math.max(12, L * 0.15);", "var gap = Math.max(12, L * 0.15, ZGAP);")
# mid posts: the sheet's Mids count, evenly spaced between the end posts (or the float posts when there are floats)
_l=_l.replace("ns: run.ns === 'Yes',", "ns: run.ns === 'Yes', mids: Math.max(0, Math.min(40, Math.round(+run.mids || 0))),", 1)
_l=_l.replace("  out += floatPosts;\n", """  var zMids = [], midPosts = '';
  segs.forEach(function(sg){
    var a = sg.fld || 0, b = sg.L - (sg.frd || 0), r = sw * 1.05;
    for (var i = 1; i <= sg.mids; i++){
      var t = (a + (b - a) * i / (sg.mids + 1)) / sg.L, px = sg.x1 + (sg.x2 - sg.x1) * t, py = sg.y1 + (sg.y2 - sg.y1) * t;
      zMids.push({ x: px, y: py });
      midPosts += '<rect x="' + (px - r) + '" y="' + (py - r) + '" width="' + r * 2 + '" height="' + r * 2 + '" fill="var(--ink)" stroke="var(--card)" stroke-width="' + sw * 0.35 + '"/>';
      boxes.push({ x0: px - sw * 1.6, x1: px + sw * 1.6, y0: py - sw * 1.6, y1: py + sw * 1.6 });
    }
  });
  if (zMids.length) anyMid = true;
  out += floatPosts + midPosts;
""", 1)
_l=_l.replace("var out = '', floatPosts = '', anyFloat = false;", "var out = '', floatPosts = '', anyFloat = false, anyMid = false;", 1)
_l=_l.replace('<span><i class="k-jt"></i>Joint</span>\' + ', '<span><i class="k-jt"></i>Joint</span>\' + (anyMid ? \'<span><i class="k-mid"></i>Mid post</span>\' : \'\') + ', 1)
assert 'ZGAP);' in _l and 'mids: Math.max' in _l and 'midPosts' in _l and 'anyMid = false' in _l and 'k-mid' in _l
# float posts: drawn at least a few post-widths in from the end (a 6" float sat on top of its end post); mids space off the drawn spot
_l=_l.replace("var dist = sg[f[0]]; if (!dist) return; anyFloat = true;", "var dist = sg[f[0]]; if (!dist) return; anyFloat = true; dist = Math.min(Math.max(dist, sw * 5), sg.L / 3); sg[f[0] + 'd'] = dist;", 1)
assert "sg[f[0] + 'd'] = dist;" in _l
# zoom bubbles go in before the post codes and section labels are placed, so they claim their space first
_n=len(_l)
_l=_l.replace("  var posts = '';\n", open('bubble.js').read() + "  var posts = '';\n", 1)
_l=_l.replace("    var lp = place(cands, pt.code, fs * 0.85);", "    var lp = zHide(pt) ? null : place(cands, pt.code, fs * 0.85);")
_l=_l.replace("    posts += '<text x=\"' + lp.x", "    if (lp) posts += '<text x=\"' + lp.x")
_l=_l.replace("    var lp = place(cands, lt, fs);\n", "    if (zSeg(sg)) return;\n    var lp = place(cands, lt, fs);\n")
# bubbles under the main labels and posts; main labels get a light halo so a squeezed one still reads if it has to touch a bubble
_l=_l.replace("  out += feet + labels + posts;", "  out += feet + bub + labels + posts;")
_l=_l.replace("labels += '<text x=\"' + lp.x + '\" y=\"' + lp.y + '\" font-size=\"' + fs + '\"", "labels += '<text x=\"' + lp.x + '\" y=\"' + lp.y + '\" font-size=\"' + fs + '\" stroke=\"#FFFDF9\" stroke-width=\"' + fs * 0.28 + '\" stroke-linejoin=\"round\" paint-order=\"stroke\"")
assert '+ bub +' in _l and 'paint-order' in _l and 'false && segs' in _l and 'zHide(pt) ?' in _l and 'if (lp) posts' in _l and 'if (zSeg(sg)) return;' in _l and len(_l) > _n
_l=_l.replace(" data-act=\"laypost\"","").replace(" text-decoration=\"underline\"","").replace("data-j=\"","data-x=\"")
_esc=src[176]
helpB='\n'.join(src[186:277])
LAYMOD='var LAY = (function(){\n'+_esc+'\n'+helpB+'\nfunction unitSetup(u){ return { mount: u.mount }; }\nfunction secLabel(u, j){ return (u.secs[j] && u.secs[j].tag) || \'\'; }\n'+_h+_l+'return { svg: layoutSvg };\n})();\n'
app=app.replace('/*__LAYOUT__*/', LAYMOD)
meta=('<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n<meta name="theme-color" content="#2F5D50">\n'
 '<link rel="manifest" href="app.webmanifest">\n<link rel="icon" href="icon-192.png">\n<link rel="apple-touch-icon" href="icon-192.png">\n'
 '<meta name="robots" content="noindex,nofollow">\n<meta name="apple-mobile-web-app-title" content="Shop Cuts">\n')
import datetime as _dt
app=app.replace('__BUILD__', _dt.datetime.now(_dt.timezone(_dt.timedelta(hours=-8))).strftime('%-m.%-d.%-I%M'))
html='<!doctype html>\n<html lang="en"><head><meta charset="utf-8">\n'+meta+head+'</head><body>\n'+body+jszip+'\n<script>\n'+app+'\n</script>\n</body></html>\n'
open(O+'index.html','w',encoding='utf-8').write(html)
ver=hashlib.sha1(html.encode()).hexdigest()[:10]
open(O+'app.webmanifest','w').write(json.dumps({"id":"/shop-cuts/?app=shopcuts2","name":"Shop Cuts","short_name":"Shop Cuts","start_url":"./","scope":"./","display":"standalone","orientation":"any","background_color":"#F4EFE7","theme_color":"#E8590C",
 "icons":[{"src":"icon-192.png","sizes":"192x192","type":"image/png"},{"src":"icon-512.png","sizes":"512x512","type":"image/png"},{"src":"icon-512.png","sizes":"512x512","type":"image/png","purpose":"maskable"}]},indent=1))
sw=open('deps/sw-shop.js').read().replace('VERSION', ver)
open(O+'sw.js','w').write(sw)
import shutil
for _i in ('icon-192.png','icon-512.png'): shutil.copy('deps/'+_i, O+_i)
print('shop built', ver, len(html))

# ---------- Claude artifact preview: reads Ready To Fab through the viewer's Google Drive connector ----------
art_override = r'''
var FAB_FOLDER = '1VjSZ_HSrvG_Jae4s2dxy_z0dJt8CwE1g';
var mcpP = null;
function getMcp(){ if (!mcpP) mcpP = (window.claude && window.claude.use) ? window.claude.use('mcp').catch(function(){ return null; }) : Promise.resolve(null); return mcpP; }
function getPin(){ return 'preview'; }
function driveMsg(e){
  var c = e && e.code;
  if (c === 'needs_reauth') return 'Google Drive needs reconnecting in claude.ai Settings → Connectors';
  if (c === 'server_not_connected' || c === 'selection_required') return 'add Google Drive in claude.ai Settings → Connectors';
  if (c === 'not_in_manifest' || c === 'approval_required' || c === 'consent_required') return 'Google Drive wasn’t allowed for this page. Tap Refresh list and choose Allow';
  if (c === 'server_unavailable') return 'Google Drive didn’t answer. Try again in a moment';
  if (c === 'tool_error') return 'Drive refused: ' + String(e.message || '').slice(0, 140);
  return (e && e.message) || 'no connection';
}
function api(action, extra){
  if (action === 'progget') return Promise.resolve({ ok: true, prog: null });   // preview keeps ticks on this device only
  if (action === 'progset') return Promise.resolve({ ok: true });
  if (action === 'complete' || action === 'uncomplete') return Promise.resolve({ ok: true, preview: true });
  if (action === 'prioset') return Promise.resolve({ ok: true, prio: extra.prio });
  if (action === 'orderset') return Promise.resolve({ ok: true, order: extra.order });   // preview keeps the priority on this device only
  return getMcp().then(function(mcp){
    if (!mcp) throw { code: 'nomcp', message: 'Google Drive isn’t available in this view' };
    if (action === 'fablist') return mcp.callTool('Google Drive', 'search_files', { query: "parentId = '" + FAB_FOLDER + "' and trashed = false", excludeContentSnippets: true, pageSize: 100 }, { cache: false }).then(function(r){
      var fs = (r.payload && r.payload.files) || [];
      return { ok: true, files: fs.filter(function(f){ return /\.xls[xm]$/i.test(f.title || '') && !/^~\$/.test(f.title || ''); }).map(function(f){ return { id: f.id, name: f.title, updated: Date.parse(f.modifiedTime) || 0 }; }).sort(function(a, b){ return b.updated - a.updated; }) };
    });
    if (action === 'fabopen') return mcp.callTool('Google Drive', 'download_file_content', { fileId: extra.id }, { cache: false }).then(function(r){
      var p = r.payload || {}; if (!p.content) throw { code: 'script', message: 'Drive sent no file' }; return { ok: true, b64: p.content };
    });
    throw { code: 'script', message: 'not available in the preview' };
  }).catch(function(e){ throw { code: e && e.code === 'nomcp' ? 'offline' : 'script', message: driveMsg(e) }; });
}
// try a cut sheet from this computer
(function(){
  var b = document.createElement('label'); b.className = 'btn'; b.style.marginLeft = '8px'; b.textContent = 'Open a file…';
  var inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.xlsx,.xlsm'; inp.hidden = true; b.appendChild(inp);
  el('reload').parentNode.appendChild(b);
  inp.onchange = function(){
    var f = inp.files[0]; if (!f) return; var fr = new FileReader();
    fr.onload = function(){ var b64 = String(fr.result).split(',')[1], rec = { id: 'local:' + f.name, name: f.name, updated: f.lastModified || Date.now() };
      filePut({ id: rec.id, name: rec.name, updated: rec.updated, b64: b64 }).then(function(){ openJob(rec); }); };
    fr.readAsDataURL(f); inp.value = '';
  };
})();
'''
a2 = app.replace("if ('serviceWorker' in navigator) window.addEventListener('load', function(){ navigator.serviceWorker.register('sw.js').catch(function(){}); });", "")
i = a2.rstrip().rfind('})();'); a2 = a2[:i] + art_override + a2[i:]
open(D+'shop-artifact.html','w',encoding='utf-8').write(head+body+jszip+'\n<script>\n'+a2+'\n</script>\n')
print('artifact built')
