// Laser workspace file exchange: SVG and DXF import / export.
import { SVGLoader } from 'three/examples/jsm/loaders/SVGLoader.js';
import { LAYER_COLORS, makePath, flatten, layerOf, mul, translate, scaling, boundsOf } from './model.js';

function nearestLayer(color) {
  if (!color) return 0;
  const hex = color.getHex ? color.getHex() : 0;
  const r = (hex >> 16) & 255, g = (hex >> 8) & 255, b = hex & 255;
  let best = 0, bestD = Infinity;
  for (let i = 0; i < 30; i++) {
    const c = parseInt(LAYER_COLORS[i].slice(1), 16);
    const d = (r - ((c >> 16) & 255)) ** 2 + (g - ((c >> 8) & 255)) ** 2 + (b - (c & 255)) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

function unitScale(svgText) {
  // physical width + viewBox give an exact scale; otherwise assume 96 px per inch
  const tag = (svgText.match(/<svg[^>]*>/i) || [''])[0];
  const w = tag.match(/\bwidth\s*=\s*["']\s*([\d.]+)\s*(mm|cm|in|pt|px)?\s*["']/i);
  const vb = tag.match(/viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
  const per = { mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, px: 25.4 / 96 };
  if (w && vb && parseFloat(vb[1]) > 0) return (parseFloat(w[1]) * (per[(w[2] || 'px').toLowerCase()] || per.px)) / parseFloat(vb[1]);
  return 25.4 / 96;
}

/** SVG text -> path shapes (one per SVG path, layer chosen from its colour). */
export function importSVG(svgText) {
  const data = new SVGLoader().parse(svgText);
  const k = unitScale(svgText);
  const shapes = [];
  for (const path of data.paths) {
    const style = path.userData && path.userData.style ? path.userData.style : {};
    const hasStroke = style.stroke && style.stroke !== 'none';
    const hasFill = style.fill && style.fill !== 'none';
    if (!hasStroke && !hasFill) continue;
    const subs = [];
    for (const sp of path.subPaths) {
      const pts = sp.getPoints(10).map((p) => [p.x * k, p.y * k]);
      if (pts.length < 2) continue;
      const f = pts[0], l = pts[pts.length - 1];
      let closed = !!sp.autoClose || hasFill;
      if (Math.hypot(f[0] - l[0], f[1] - l[1]) < 1e-4) { pts.pop(); closed = true; }
      if (pts.length < 2) continue;
      subs.push({ closed: closed && pts.length > 2, nodes: pts.map(([x, y]) => ({ x, y })) });
    }
    if (!subs.length) continue;
    let color = path.color;
    if (hasStroke) { try { color = path.color.clone().setStyle(style.stroke); } catch { /* keep fill colour */ } }
    shapes.push(makePath(nearestLayer(color), subs));
  }
  return shapes;
}

// ---------------------------------------------------------------- DXF
function bulgeArc(a, b, bulge, out) {
  const chord = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (Math.abs(bulge) < 1e-9 || chord < 1e-9) { out.push(b); return; }
  const theta = 4 * Math.atan(bulge), r = chord / (2 * Math.sin(theta / 2));
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
  const d = r * Math.cos(theta / 2), ux = -(b[1] - a[1]) / chord, uy = (b[0] - a[0]) / chord;
  const cx = mx + ux * d, cy = my + uy * d;
  const a0 = Math.atan2(a[1] - cy, a[0] - cx);
  const steps = Math.max(2, Math.ceil(Math.abs(theta) / (Math.PI / 24)));
  for (let i = 1; i <= steps; i++) { const t = a0 + (theta * i) / steps; out.push([cx + Math.abs(r) * Math.cos(t), cy + Math.abs(r) * Math.sin(t)]); }
}

/** Evaluate a (rational) B-spline from its control points and knot vector (de Boor). */
function evalSpline(ctrl, knots, degree, weights) {
  const n = ctrl.length, p = degree;
  if (p < 1 || n <= p || knots.length !== n + p + 1) return ctrl;
  const w = weights.length === n ? weights : ctrl.map(() => 1);
  const lo = knots[p], hi = knots[n];
  if (!(hi > lo)) return ctrl;
  const steps = Math.min(4000, Math.max(24, n * 16));
  const out = [];
  for (let s = 0; s <= steps; s++) {
    const t = lo + ((hi - lo) * s) / steps;
    let k = p;
    while (k < n - 1 && t >= knots[k + 1]) k++;
    const d = [];
    for (let j = 0; j <= p; j++) { const i = k - p + j; d.push([ctrl[i][0] * w[i], ctrl[i][1] * w[i], w[i]]); }
    for (let r = 1; r <= p; r++) {
      for (let j = p; j >= r; j--) {
        const i = k - p + j, den = knots[i + p - r + 1] - knots[i];
        const a = den > 0 ? (t - knots[i]) / den : 0;
        d[j] = [(1 - a) * d[j - 1][0] + a * d[j][0], (1 - a) * d[j - 1][1] + a * d[j][1], (1 - a) * d[j - 1][2] + a * d[j][2]];
      }
    }
    const [x, y, ww] = d[p];
    out.push(ww ? [x / ww, y / ww] : [x, y]);
  }
  return out;
}

function joinChains(polys, tol = 0.02) {
  const open = polys.filter((p) => !p.closed), done = polys.filter((p) => p.closed);
  const key = (p) => Math.round(p[0] / tol) + ',' + Math.round(p[1] / tol);
  while (open.length) {
    let cur = open.pop().pts.slice();
    let grew = true;
    while (grew) {
      grew = false;
      for (let i = 0; i < open.length; i++) {
        const q = open[i].pts, end = key(cur[cur.length - 1]), start = key(cur[0]);
        if (key(q[0]) === end) cur = cur.concat(q.slice(1));
        else if (key(q[q.length - 1]) === end) cur = cur.concat([...q].reverse().slice(1));
        else if (key(q[q.length - 1]) === start) cur = q.slice(0, -1).concat(cur);
        else if (key(q[0]) === start) cur = [...q].reverse().slice(0, -1).concat(cur);
        else continue;
        open.splice(i, 1);
        grew = true;
        break;
      }
    }
    const closed = cur.length > 3 && key(cur[0]) === key(cur[cur.length - 1]);
    if (closed) cur.pop();
    done.push({ pts: cur, closed });
  }
  return done;
}

/** DXF text -> path shapes (one per DXF layer). */
export function importDXF(text) {
  const lines = text.split(/\r?\n/);
  const pairs = [];
  for (let i = 0; i + 1 < lines.length; i += 2) pairs.push([parseInt(lines[i].trim(), 10), lines[i + 1].trim()]);
  let unit = 1;
  const INSUNITS = { 1: 25.4, 2: 304.8, 3: 1609344, 4: 1, 5: 10, 6: 1000, 7: 1e6, 8: 2.54e-5, 9: 0.0254, 10: 914.4, 11: 1e-7, 12: 1e-6, 13: 0.001, 14: 100, 15: 10000, 16: 100000 };
  for (let i = 0; i < pairs.length - 1; i++) if (pairs[i][0] === 9 && pairs[i][1] === '$INSUNITS') unit = INSUNITS[parseInt(pairs[i + 1][1], 10)] ?? 1;
  let i = pairs.findIndex((p, k) => p[0] === 2 && p[1] === 'ENTITIES' && k > 0 && pairs[k - 1][1] === 'SECTION');
  if (i < 0) i = 0;
  const ents = [];
  let cur = null;
  for (i += 1; i < pairs.length; i++) {
    const [code, val] = pairs[i];
    if (code === 0) {
      if (val === 'ENDSEC') break;
      cur = { type: val, g: [] };
      ents.push(cur);
    } else if (cur) cur.g.push([code, val]);
  }
  const byLayer = new Map();
  const add = (layer, pts, closed) => { if (pts.length > 1) (byLayer.get(layer) || byLayer.set(layer, []).get(layer)).push({ pts, closed }); };
  const num = (e, code, def = 0) => { const h = e.g.find((x) => x[0] === code); return h ? parseFloat(h[1]) : def; };
  const str = (e, code, def = '0') => { const h = e.g.find((x) => x[0] === code); return h ? h[1] : def; };
  let poly = null;
  // ARC / CIRCLE / (LW)POLYLINE are in object coordinates: an extrusion of (0,0,-1) mirrors X
  const ocs = (e, pts) => (num(e, 230, 1) < 0 ? pts.map(([x, y]) => [-x, y]) : pts);
  const bulgePts = (verts, closed) => {
    const pts = [[verts[0].x, verts[0].y]];
    const count = closed ? verts.length : verts.length - 1;
    for (let k = 0; k < count; k++) { const a = verts[k], b = verts[(k + 1) % verts.length]; bulgeArc([a.x, a.y], [b.x, b.y], a.b, pts); }
    if (closed) pts.pop();
    return pts;
  };
  for (const e of ents) {
    const layer = str(e, 8);
    if (e.type === 'LINE') add(layer, [[num(e, 10), num(e, 20)], [num(e, 11), num(e, 21)]], false);
    else if (e.type === 'CIRCLE' || e.type === 'ARC') {
      const cx = num(e, 10), cy = num(e, 20), r = num(e, 40);
      let a0 = e.type === 'ARC' ? (num(e, 50) * Math.PI) / 180 : 0, a1 = e.type === 'ARC' ? (num(e, 51) * Math.PI) / 180 : Math.PI * 2;
      if (a1 <= a0) a1 += Math.PI * 2;
      const steps = Math.max(8, Math.ceil(((a1 - a0) / (Math.PI * 2)) * 96));
      const pts = [];
      for (let k = 0; k <= steps; k++) { const a = a0 + ((a1 - a0) * k) / steps; pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
      if (e.type === 'CIRCLE') pts.pop();
      add(layer, ocs(e, pts), e.type === 'CIRCLE');
    } else if (e.type === 'ELLIPSE') {
      const cx = num(e, 10), cy = num(e, 20), mx = num(e, 11), my = num(e, 21), ratio = num(e, 40, 1);
      const a0 = num(e, 41, 0);
      let a1 = num(e, 42, Math.PI * 2);
      if (a1 <= a0) a1 += Math.PI * 2;
      const full = Math.abs(a1 - a0 - Math.PI * 2) < 1e-6;
      const pts = [];
      for (let k = 0; k <= 96; k++) { const t = a0 + ((a1 - a0) * k) / 96; pts.push([cx + mx * Math.cos(t) - my * ratio * Math.sin(t), cy + my * Math.cos(t) + mx * ratio * Math.sin(t)]); }
      if (full) pts.pop();
      add(layer, pts, full);
    } else if (e.type === 'LWPOLYLINE') {
      const verts = [];
      for (const [code, val] of e.g) {
        if (code === 10) verts.push({ x: parseFloat(val), y: 0, b: 0 });
        else if (code === 20 && verts.length) verts[verts.length - 1].y = parseFloat(val);
        else if (code === 42 && verts.length) verts[verts.length - 1].b = parseFloat(val);
      }
      const closed = (num(e, 70) & 1) === 1;
      if (!verts.length) continue;
      add(layer, ocs(e, bulgePts(verts, closed)), closed);
    } else if (e.type === 'POLYLINE') { poly = { layer, closed: (num(e, 70) & 1) === 1, verts: [], e }; }
    else if (e.type === 'VERTEX' && poly) poly.verts.push({ x: num(e, 10), y: num(e, 20), b: num(e, 42) });
    else if (e.type === 'SEQEND' && poly) { if (poly.verts.length) add(poly.layer, ocs(poly.e, bulgePts(poly.verts, poly.closed)), poly.closed); poly = null; }
    else if (e.type === 'SPLINE') {
      const fit = [], ctrl = [], knots = [], weights = [];
      let last = null;
      for (const [code, val] of e.g) {
        if (code === 11) { last = [parseFloat(val), 0]; fit.push(last); } else if (code === 21 && last) last[1] = parseFloat(val);
        else if (code === 10) { last = [parseFloat(val), 0]; ctrl.push(last); } else if (code === 20 && last) last[1] = parseFloat(val);
        else if (code === 40) knots.push(parseFloat(val));
        else if (code === 41) weights.push(parseFloat(val));
      }
      const closed = (num(e, 70) & 1) === 1;
      const pts = ctrl.length > 1 ? evalSpline(ctrl, knots, Math.round(num(e, 71, 3)), weights) : fit;
      if (closed && pts.length > 2 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 1e-6) pts.pop();
      add(layer, pts, closed);
    }
  }
  const shapes = [];
  let li = 0;
  for (const [, polys] of byLayer) {
    const joined = joinChains(polys.map((p) => ({ closed: p.closed, pts: p.pts.map(([x, y]) => [x * unit, -y * unit]) })));
    shapes.push(makePath(li % 30, joined.map((p) => ({ closed: p.closed, nodes: p.pts.map(([x, y]) => ({ x, y })) }))));
    li += 1;
  }
  // move into positive space
  const b = boundsOf(shapes);
  if (b) for (const s of shapes) s.m = mul(translate(-b.x0, -b.y0), s.m);
  return shapes;
}

export function exportSVG(doc, machine) {
  const f = (v) => +v.toFixed(3);
  const out = [`<?xml version="1.0" encoding="UTF-8"?>`, `<svg xmlns="http://www.w3.org/2000/svg" width="${machine.bedW}mm" height="${machine.bedH}mm" viewBox="0 0 ${machine.bedW} ${machine.bedH}">`];
  for (const s of doc.shapes) {
    const polys = flatten(s).filter((p) => p.shape.type !== 'image');
    const byLayer = new Map();
    for (const p of polys) (byLayer.get(p.layer) || byLayer.set(p.layer, []).get(p.layer)).push(p);
    for (const [li, list] of byLayer) {
      const d = list.map((p) => 'M' + p.pts.map(([x, y]) => `${f(x)} ${f(y)}`).join('L') + (p.closed ? 'Z' : '')).join(' ');
      const fill = layerOf(doc, li).mode === 'fill' ? LAYER_COLORS[li] : 'none';
      out.push(`  <path d="${d}" fill="${fill}" fill-rule="evenodd" stroke="${LAYER_COLORS[li]}" stroke-width="0.1"/>`);
    }
  }
  out.push('</svg>', '');
  return out.join('\n');
}

export function exportDXF(doc, machine) {
  const out = ['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES'];
  for (const s of doc.shapes) for (const p of flatten(s)) {
    if (p.shape.type === 'image') continue;
    out.push('0', 'LWPOLYLINE', '8', 'C' + String(p.layer).padStart(2, '0'), '90', String(p.pts.length), '70', p.closed ? '1' : '0');
    for (const [x, y] of p.pts) out.push('10', (+x.toFixed(4)).toString(), '20', (+(machine.bedH - y).toFixed(4)).toString());
  }
  out.push('0', 'ENDSEC', '0', 'EOF', '');
  return out.join('\n');
}

export { scaling };

// ---------------------------------------------------------------- LightBurn projects (.lbrn / .lbrn2)
const NUM = '-?\\d*\\.?\\d+(?:[eE][-+]?\\d+)?';

/** "V1 2c0x3c0y4c1x5c1y6V..." -> [{ x, y, c0: [x, y] | null, c1: [x, y] | null }] */
function lbrnVerts(text) {
  const out = [];
  const re = new RegExp(`V(${NUM}) (${NUM})((?:c[01][xy]${NUM})*)`, 'g');
  let m;
  while ((m = re.exec(text))) {
    const v = { x: +m[1], y: +m[2], c0: null, c1: null }, parts = {};
    const cre = new RegExp(`c([01])([xy])(${NUM})`, 'g');
    let c;
    while ((c = cre.exec(m[3]))) parts[c[1] + c[2]] = +c[3];
    if ('0x' in parts && '0y' in parts) v.c0 = [parts['0x'], parts['0y']];
    if ('1x' in parts && '1y' in parts) v.c1 = [parts['1x'], parts['1y']];
    out.push(v);
  }
  return out;
}

/** Chain line / curve primitives into sub-paths in our node format. */
function lbrnSubs(verts, prims) {
  const subs = [];
  const node = (i) => ({ x: verts[i].x, y: verts[i].y });
  let cur = null;
  const finish = () => { if (cur && cur.nodes.length > 1) subs.push({ closed: cur.closed, nodes: cur.nodes }); cur = null; };
  for (const [type, a, b] of prims) {
    if (!verts[a] || !verts[b]) continue;
    if (!cur || cur.last !== a) { finish(); cur = { nodes: [node(a)], start: a, last: a, closed: false }; }
    const from = cur.nodes[cur.nodes.length - 1];
    const closing = b === cur.start;
    const to = closing ? cur.nodes[0] : node(b);
    if (type === 'B') {
      // c0 leaves a vertex, c1 arrives at it
      if (verts[a].c0) { from.ox = verts[a].c0[0]; from.oy = verts[a].c0[1]; }
      if (verts[b].c1) { to.ix = verts[b].c1[0]; to.iy = verts[b].c1[1]; }
    }
    if (closing) { cur.closed = true; finish(); } else { cur.nodes.push(to); cur.last = b; }
  }
  finish();
  return subs;
}

/**
 * Read a LightBurn project. Returns { shapes, layers: { index: settings }, notes: [] }.
 * LightBurn's Y axis points up; shapes are flipped onto our bed (Y down) and kept at
 * their positions when they fit the work area.
 */
export function importLBRN(xmlText, machine) {
  const dom = new DOMParser().parseFromString(xmlText, 'application/xml');
  const root = dom.documentElement;
  if (!root || root.nodeName !== 'LightBurnProject') throw new Error('this is not a LightBurn project');
  const notes = new Set();
  const kids = (el, name) => [...el.children].filter((c) => c.nodeName === name);
  const xform = (el) => { const x = kids(el, 'XForm')[0]; const n = x ? x.textContent.trim().split(/\s+/).map(Number) : []; return n.length === 6 && n.every(isFinite) ? n : [1, 0, 0, 1, 0, 0]; };
  const num = (el, a, d = 0) => { const v = parseFloat(el.getAttribute(a)); return isFinite(v) ? v : d; };

  // layer settings
  const layers = {};
  for (const cs of kids(root, 'CutSetting').concat(kids(root, 'CutSetting_Img'))) {
    const get = (name, d) => { const e = kids(cs, name)[0]; const v = e ? parseFloat(e.getAttribute('Value')) : NaN; return isFinite(v) ? v : d; };
    const index = get('index', -1);
    if (index < 0 || index > 31) continue;
    const type = (cs.getAttribute('type') || 'Cut').toLowerCase();
    const set = { mode: type === 'scan' ? 'fill' : type === 'offset' ? 'offset' : 'line' };
    const put = (key, name, f = (v) => v) => { const v = get(name, NaN); if (isFinite(v)) set[key] = f(v); };
    put('speed', 'speed'); put('powerMax', 'maxPower'); put('powerMin', 'minPower'); put('passes', 'numPasses', (v) => Math.max(1, Math.round(v)));
    put('interval', 'interval'); put('angle', 'angle'); put('kerf', 'kerf'); put('overscan', 'overscanPercent'); put('zOffset', 'zOffset'); put('zStep', 'zPerPass');
    put('crosshatch', 'crossHatch', (v) => !!v); put('bidirectional', 'bidir', (v) => !!v); put('air', 'runBlower', (v) => !!v); put('output', 'doOutput', (v) => !!v); put('show', 'hide', (v) => !v);
    put('pierce', 'startDelay', (v) => Math.round(v));
    // keep names the user typed; LightBurn's own are just the colour code (C00, T1)
    const nameEl = kids(cs, 'name')[0], label = nameEl ? (nameEl.getAttribute('Value') || '').trim() : '';
    if (label && !/^[CT]\d{1,2}$/.test(label)) set.name = label.slice(0, 40);
    layers[index] = set;
  }

  const vertLists = new Map(), primLists = new Map();
  const mulM = (a, b) => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
  let counter = 0;
  const base = (type, layer, extra) => ({ id: 'LB' + Date.now().toString(36) + (counter++).toString(36), type, layer, m: [1, 0, 0, 1, 0, 0], ...extra });

  function read(el) {
    const type = el.getAttribute('Type');
    const layer = Math.max(0, Math.min(31, Math.round(num(el, 'CutIndex', 0))));
    const m = xform(el);
    if (type === 'Group') {
      const holder = kids(el, 'Children')[0];
      const children = (holder ? kids(holder, 'Shape') : []).map(read).filter(Boolean);
      return children.length ? base('group', children[0].layer, { children, m }) : null;
    }
    if (type === 'Rect') {
      const w = num(el, 'W'), hh = num(el, 'H');
      return w > 0 && hh > 0 ? base('rect', layer, { w, h: hh, r: num(el, 'Cr'), m: mulM(m, [1, 0, 0, 1, -w / 2, -hh / 2]) }) : null;
    }
    if (type === 'Ellipse') {
      const rx = num(el, 'Rx'), ry = num(el, 'Ry');
      return rx > 0 && ry > 0 ? base('ellipse', layer, { w: rx * 2, h: ry * 2, m: mulM(m, [1, 0, 0, 1, -rx, -ry]) }) : null;
    }
    if (type === 'Path') {
      let verts, prims;
      const vl = kids(el, 'VertList')[0], pl = kids(el, 'PrimList')[0];
      const vid = el.getAttribute('VertID'), pid = el.getAttribute('PrimID');
      if (vl) verts = lbrnVerts(vl.textContent);
      else if (kids(el, 'V').length) verts = kids(el, 'V').map((v) => ({ x: num(v, 'vx'), y: num(v, 'vy'), c0: [num(v, 'c0x'), num(v, 'c0y')], c1: [num(v, 'c1x'), num(v, 'c1y')] }));
      else verts = vertLists.get(vid); // later copies of a shape share the first one's points
      if (pl) {
        const t = pl.textContent.trim();
        prims = t === 'LineClosed' ? 'closed' : [...t.matchAll(/([A-Z])(\d+) (\d+)/g)].map((q) => [q[1], +q[2], +q[3]]);
      } else if (kids(el, 'P').length) prims = kids(el, 'P').map((p) => [p.getAttribute('T') || 'L', Math.round(num(p, 'p0')), Math.round(num(p, 'p1'))]);
      else prims = primLists.get(pid);
      if (vid != null && verts) vertLists.set(vid, verts);
      if (pid != null && prims) primLists.set(pid, prims);
      if (!verts || !verts.length || !prims) return null;
      const subs = prims === 'closed' ? [{ closed: true, nodes: verts.map((v) => ({ x: v.x, y: v.y })) }] : lbrnSubs(verts, prims);
      return subs.length ? base('path', layer, { subs, m }) : null;
    }
    if (type === 'Text') {
      const backup = kids(el, 'BackupPath')[0];
      const inner = backup ? kids(backup, 'Shape')[0] : null;
      if (inner) { const s = read(inner); if (s) { s.m = m; s.layer = layer; return s; } }
      const str = el.getAttribute('Str') || '';
      if (!str.trim()) return null;
      notes.add('Text was rebuilt with a DabbleCAD font, so its size and position are approximate');
      const size = Math.max(1, num(el, 'H', 10) / 0.72);
      // our glyphs are drawn with Y down; the text is centred on its LightBurn anchor
      const w = str.split('\n').reduce((a, l) => Math.max(a, l.length), 1) * size * 0.6;
      return base('text', layer, { text: str, font: 'Sans Bold', size, align: 'left', spacing: 0, m: mulM(m, [1, 0, 0, -1, -w / 2, size * 0.36]) });
    }
    if (type === 'Bitmap') {
      const data = el.getAttribute('Data'), w = num(el, 'W'), hh = num(el, 'H');
      if (!data || !(w > 0) || !(hh > 0)) { notes.add('A linked picture was skipped (only pictures stored inside the project can be read)'); return null; }
      return base('image', layer, { w, h: hh, src: 'data:image/png;base64,' + data.replace(/\s+/g, ''), pw: 0, ph: 0, m: mulM(m, [1, 0, 0, -1, -w / 2, hh / 2]) });
    }
    notes.add(`"${type}" objects are not supported and were skipped`);
    return null;
  }

  const shapes = kids(root, 'Shape').map(read).filter(Boolean);
  if (!shapes.length) return { shapes, layers, notes: [...notes] };
  // flip onto the bed, then nudge inside the work area if the design would hang off it
  const bedW = machine ? machine.bedW : 400, bedH = machine ? machine.bedH : 400;
  for (const s of shapes) s.m = mulM([1, 0, 0, -1, 0, bedH], s.m);
  const b = boundsOf(shapes);
  if (b && (b.x0 < 0 || b.y0 < 0 || b.x1 > bedW || b.y1 > bedH)) {
    const fit = (lo, hi, size, max) => (size > max ? -lo : lo < 0 ? -lo : hi > max ? max - hi : 0);
    const dx = fit(b.x0, b.x1, b.w, bedW), dy = fit(b.y0, b.y1, b.h, bedH);
    for (const s of shapes) s.m = mulM([1, 0, 0, 1, dx, dy], s.m);
    notes.add(b.w > bedW || b.h > bedH ? 'The design is larger than your work area' : 'The design was moved to fit inside your work area');
  }
  return { shapes, layers, notes: [...notes] };
}
