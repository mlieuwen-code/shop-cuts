  // zoom bubbles: where post icons overlap on the drawing, draw a magnified inset beside it, like a map.
  // Runs BEFORE post codes and section labels are placed: the bubble claims its space first, the crowded codes/labels are drawn only inside
  // the bubble, and everything else on the drawing steers around it.
  var bub = '', zPts = [], zSegs = [];
  function zHide(pt){ return zPts.indexOf(pt) >= 0; }
  function zSeg(sg){ return zSegs.indexOf(sg) >= 0; }
  (function(){
    function dd(ax, ay, bx, by){ return Math.sqrt((ax - bx) * (ax - bx) + (ay - by) * (ay - by)); }
    // only where post icons actually overlap: each icon's drawn size (end square, corner circle, joint dot), plus its outline
    var r0 = sw * 1.6, icon = function(pt, k){ return (pt.kind === 'end' || k === 0) ? r0 : pt.kind === 'corner' ? r0 * (pt.bad ? 1.6 : 1.1) + sw * 0.3 : r0 * 0.8; };
    var grp = pts.map(function(_, i){ return i; }), find = function(i){ while (grp[i] !== i) i = grp[i] = grp[grp[i]]; return i; }, any = false;
    pts.forEach(function(a, i){ pts.forEach(function(b, j){ if (j <= i) return; if (dd(a.x, a.y, b.x, b.y) < icon(a, i) + icon(b, j)){ grp[find(j)] = find(i); a._ov = b._ov = true; any = true; } }); });
    if (!any) return;
    var byRoot = {};
    pts.forEach(function(pt, i){ if (!pt._ov) return; var k = find(i); (byRoot[k] = byRoot[k] || []).push(pt); });
    var at = function(list, x, y){ return list.some(function(p){ return Math.abs(p.x - x) < 1e-6 && Math.abs(p.y - y) < 1e-6; }); };
    var clusters = Object.keys(byRoot).map(function(k){
      var cp = byRoot[k], md = Infinity;
      cp.forEach(function(a, i){ cp.forEach(function(b, j){ if (j > i) md = Math.min(md, dd(a.x, a.y, b.x, b.y)); }); });
      // the sections that live inside the crowded spot (both ends there) hand their labels to the bubble
      return { pts: cp, minD: md, segs: segs.filter(function(sg){ return at(cp, sg.x1, sg.y1) && at(cp, sg.x2, sg.y2); }) };
    });
    function segDist(px, py, sg){ var dx = sg.x2 - sg.x1, dy = sg.y2 - sg.y1, l2 = dx * dx + dy * dy, t = l2 ? Math.max(0, Math.min(1, ((px - sg.x1) * dx + (py - sg.y1) * dy) / l2)) : 0; return dd(px, py, sg.x1 + dx * t, sg.y1 + dy * t); }
    var ASP = 900 / 440, cur = { x0: minX - pad * 0.5, x1: maxX + pad * 0.5, y0: minY - pad * 0.5, y1: maxY + pad * 0.5 };
    clusters.forEach(function(cl){
      var ps = cl.pts.map(function(p){ return [p.x, p.y]; });
      cl.x = ps.reduce(function(a, p){ return a + p[0]; }, 0) / ps.length; cl.y = ps.reduce(function(a, p){ return a + p[1]; }, 0) / ps.length;
      cl.rf = Math.max(fs * 1.2, Math.max.apply(null, ps.map(function(p){ return dd(p[0], p[1], cl.x, cl.y); })) + fs * 0.9);
      var minL = Math.max(cl.minD, 1e-6);
      cl.mag = Math.max(2.5, Math.min(8, fs * 5.5 / minL));
      // the bubble shows a margin past the crowded spot, so its codes and labels have room to sit clear of the rails
      var room = fs * 3;
      cl.R = cl.rf * cl.mag + room;
      if (cl.R > span * 0.36){ cl.R = span * 0.36; cl.mag = (cl.R - room) / cl.rf; }
      // the spot on the drawing is an obstacle for labels
      boxes.push({ x0: cl.x - cl.rf, x1: cl.x + cl.rf, y0: cl.y - cl.rf, y1: cl.y + cl.rf });
    });
    clusters.forEach(function(cl, ci){
      if (cl.mag < 1.5) return;
      // Placement: the layout box on the tablet is about 900 × 440 (ASP), and the drawing is scaled to fit it.
      // Any spot that stays inside the room the box already has (usually beside the drawing) costs nothing.
      // A spot that makes the whole drawing shrink pays for every percent; a slightly smaller bubble is tried before that.
      var best = null, baseS = Math.max((cur.x1 - cur.x0) / ASP, cur.y1 - cur.y0);
      [1, 0.9, 0.8].forEach(function(sf){
        var R = Math.max(cl.rf * 2 + fs * 3, cl.R * sf), mag = (R - fs * 3) / cl.rf;
        if (mag < 2.5) return;
        for (var a = 0; a < 360; a += 30) [0, 1, 2, 3.5, 5].forEach(function(k){
          var d = cl.rf + R + fs * (1.2 + k * 1.5), bx = cl.x + d * Math.cos(a * Math.PI / 180), by = cl.y + d * Math.sin(a * Math.PI / 180);
          var b = { x0: bx - R, x1: bx + R, y0: by - R, y1: by + R + fs * 1.6 };
          var rail = segs.some(function(sg){ return segDist(bx, by, sg) < R + fs * 0.6; }), nearRail = segs.some(function(sg){ return cl.segs.indexOf(sg) < 0 && segDist(bx, by, sg) < R + fs * 6.5; });
          var nb = { x0: Math.min(cur.x0, b.x0), x1: Math.max(cur.x1, b.x1), y0: Math.min(cur.y0, b.y0), y1: Math.max(cur.y1, b.y1) };
          var shrink = Math.max((nb.x1 - nb.x0) / ASP, nb.y1 - nb.y0) / baseS - 1;   // 0.1 = the rest of the drawing gets 10% smaller
          var bad = (hits(b) ? 6 : 0) + (rail ? 4 : 0) + (nearRail ? 3 : 0) + k * 0.15 + shrink * 12 + (1 - sf) * 6;
          if (!best || bad < best.bad) best = { x: bx, y: by, bad: bad, R: R, mag: mag };
        });
      });
      if (!best) return;
      var R = best.R, mag = best.mag;
      cur = { x0: Math.min(cur.x0, best.x - R), x1: Math.max(cur.x1, best.x + R), y0: Math.min(cur.y0, best.y - R), y1: Math.max(cur.y1, best.y + R + fs * 1.6) };
      boxes.push({ x0: best.x - R, x1: best.x + R, y0: best.y - R, y1: best.y + R + fs * 1.6 });
      var T = function(x, y){ return [best.x + (x - cl.x) * mag, best.y + (y - cl.y) * mag]; };
      var id = 'zb' + ci + '_' + Math.round(Math.random() * 1e6);
      // what this bubble takes over from the main drawing
      cl.segs.forEach(function(sg){ zSegs.push(sg); });
      var inPts = pts.filter(function(pt){ return dd(pt.x, pt.y, cl.x, cl.y) <= cl.rf - fs * 0.3; });
      inPts.forEach(function(pt){ zPts.push(pt); });
      // ---- inside the bubble: its own little label placer ----
      var tsegs = segs.map(function(sg){ var p = T(sg.x1, sg.y1), q = T(sg.x2, sg.y2); return { x1: p[0], y1: p[1], x2: q[0], y2: q[1], ns: sg.ns, src: sg }; });
      var ob = [];
      function obHit(b){ return ob.some(function(o){ return b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0; }); }
      function railHit(b){ return tsegs.some(function(sg){
        var t0 = 0, t1 = 1, dx = sg.x2 - sg.x1, dy = sg.y2 - sg.y1, P = [-dx, dx, -dy, dy], Q = [sg.x1 - b.x0, b.x1 - sg.x1, sg.y1 - b.y0, b.y1 - sg.y1];
        for (var q = 0; q < 4; q++){ if (P[q] === 0){ if (Q[q] < 0) return false; } else { var r = Q[q] / P[q]; if (P[q] < 0){ if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; } } }
        return true; }); }
      function outside(b){ return [[b.x0, b.y0], [b.x1, b.y0], [b.x0, b.y1], [b.x1, b.y1]].some(function(c){ return dd(c[0], c[1], best.x, best.y) > R - sw * 0.8; }); }
      function bplace(cands, text, size){
        var pick = null;
        cands.forEach(function(c){ if (pick && !pick.bad) return;
          var an = c.a || anchorFor(c.nx || 0), b0 = boxOf(c.x, c.y, text, size, an), pd = fs * 0.22, b = { x0: b0.x0 - pd, x1: b0.x1 + pd, y0: b0.y0 - pd, y1: b0.y1 + pd }, bad = (outside(b) ? 5 : 0) + (obHit(b) ? 3 : 0) + (railHit(b) ? 2 : 0);
          if (!pick || bad < pick.bad) pick = { x: c.x, y: c.y, a: an, b: b, bad: bad }; });
        ob.push(pick.b); return pick;
      }
      var r = sw * 2;
      pts.forEach(function(pt){ var q = T(pt.x, pt.y); if (dd(q[0], q[1], best.x, best.y) < R) ob.push({ x0: q[0] - r * 1.2, x1: q[0] + r * 1.2, y0: q[1] - r * 1.2, y1: q[1] + r * 1.2 }); });
      // field-of-view ring and leader on the main drawing
      var dx = best.x - cl.x, dy = best.y - cl.y, dl = Math.sqrt(dx * dx + dy * dy) || 1;
      var g = '<circle cx="' + cl.x + '" cy="' + cl.y + '" r="' + cl.rf + '" fill="none" stroke="var(--accent)" stroke-width="' + sw * 0.4 + '" stroke-dasharray="' + sw + ' ' + sw + '"/>' +
        '<line x1="' + (cl.x + dx / dl * cl.rf) + '" y1="' + (cl.y + dy / dl * cl.rf) + '" x2="' + (best.x - dx / dl * R) + '" y2="' + (best.y - dy / dl * R) + '" stroke="var(--accent)" stroke-width="' + sw * 0.4 + '" stroke-dasharray="' + sw + ' ' + sw + '"/>' +
        '<clipPath id="' + id + '"><circle cx="' + best.x + '" cy="' + best.y + '" r="' + R + '"/></clipPath>' +
        '<circle cx="' + best.x + '" cy="' + best.y + '" r="' + R + '" fill="#FFFDF9" stroke="var(--accent)" stroke-width="' + sw * 0.6 + '"/><g clip-path="url(#' + id + ')">';
      tsegs.forEach(function(sg){ g += '<line x1="' + sg.x1 + '" y1="' + sg.y1 + '" x2="' + sg.x2 + '" y2="' + sg.y2 + '" stroke="' + (sg.ns ? 'var(--float)' : 'var(--accent)') + '" stroke-width="' + sw * 1.3 + '" stroke-linecap="round"/>'; });
      zMids.forEach(function(m){ var q = T(m.x, m.y), rm = sw * 1.3; if (dd(q[0], q[1], best.x, best.y) > R + rm) return; ob.push({ x0: q[0] - rm * 1.4, x1: q[0] + rm * 1.4, y0: q[1] - rm * 1.4, y1: q[1] + rm * 1.4 });
        g += '<rect x="' + (q[0] - rm) + '" y="' + (q[1] - rm) + '" width="' + rm * 2 + '" height="' + rm * 2 + '" fill="var(--ink)" stroke="#FFFDF9" stroke-width="' + sw * 0.4 + '"/>'; });
      var txt = '';
      // section labels first (long, fussy), then the short post codes fit around them
      var labs = cl.segs.map(function(sg){
        var a = T(sg.x1, sg.y1), b = T(sg.x2, sg.y2), mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, ddx = b[0] - a[0], ddy = b[1] - a[1], d = Math.sqrt(ddx * ddx + ddy * ddy) || 1, side = totalTurn < 0 ? -1 : 1;
        var nx = side * ddy / d, ny = -side * ddx / d, lt = sg.tag + ' · ' + sg.len + (sg.ns ? ' · floating' : ''), cands = [];
        [1, -1].forEach(function(s){ [1.1, 2, 3].forEach(function(m){ [0, 0.3, -0.3].forEach(function(t){
          var c = { x: mx + ddx * t + s * nx * fs * m, y: my + ddy * t + s * ny * fs * m, nx: s * nx };
          cands.push(c); if (Math.abs(s * nx) <= 0.6) cands.push({ x: c.x, y: c.y, a: 'start' }, { x: c.x, y: c.y, a: 'end' });
        }); }); });
        var free = cands.filter(function(c){ var an = c.a || anchorFor(c.nx || 0), b0 = boxOf(c.x, c.y, lt, fs, an); return !outside(b0) && !obHit(b0) && !railHit(b0); }).length;
        return { lt: lt, cands: cands, free: free };
      });
      labs.sort(function(p, q){ return p.free - q.free; }).forEach(function(lb){
        var lp = bplace(lb.cands, lb.lt, fs);
        txt += '<text x="' + lp.x + '" y="' + lp.y + '" font-size="' + fs + '" text-anchor="' + lp.a + '" dominant-baseline="middle" fill="var(--ink)" font-weight="900">' + esc(lb.lt) + '</text>';
      });
      pts.forEach(function(pt, k){
        var q = T(pt.x, pt.y); if (dd(q[0], q[1], best.x, best.y) > R + r) return;
        if (pt.kind === 'end' || k === 0) g += '<rect x="' + (q[0] - r) + '" y="' + (q[1] - r) + '" width="' + r * 2 + '" height="' + r * 2 + '" fill="var(--ink)"/>';
        else if (pt.kind === 'corner') g += '<circle cx="' + q[0] + '" cy="' + q[1] + '" r="' + r * 1.1 + '" fill="' + (pt.bad ? 'var(--badbg)' : 'var(--card)') + '" stroke="' + (pt.bad ? 'var(--bad)' : 'var(--ink)') + '" stroke-width="' + sw * 0.7 + '"/>';
        else g += '<circle cx="' + q[0] + '" cy="' + q[1] + '" r="' + r * 0.8 + '" fill="var(--ink)"/>';
        if (inPts.indexOf(pt) < 0) return;
        var cs = pt.kind === 'corner' ? 1 : (totalTurn < 0 ? -1 : 1), cands = [];
        [fs * 1.4, fs * 2.2, fs * 3].forEach(function(d1){ [[pt.nx * cs, pt.ny * cs], [-pt.nx * cs, -pt.ny * cs], [0, -1], [0, 1], [1, 0], [-1, 0], [0.7, -0.7], [-0.7, -0.7], [0.7, 0.7], [-0.7, 0.7]].forEach(function(v){ cands.push({ x: q[0] + v[0] * d1, y: q[1] + v[1] * d1, nx: v[0] }); }); });
        var lp = bplace(cands, pt.code, fs * 0.95);
        txt += '<text x="' + lp.x + '" y="' + lp.y + '" font-size="' + fs * 0.95 + '" text-anchor="' + lp.a + '" dominant-baseline="middle" fill="var(--deep, var(--ink))" font-weight="900">' + esc(pt.code) + '</text>';
      });
      g += txt + '</g><text x="' + best.x + '" y="' + (best.y + R + fs * 1.1) + '" font-size="' + fs * 0.75 + '" text-anchor="middle" fill="var(--muted)" font-weight="800">zoomed ×' + Math.round(mag) + '</text>';
      bub += g;
    });
  })();
