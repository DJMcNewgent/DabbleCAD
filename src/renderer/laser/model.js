// Laser workspace document model. Units are millimetres; internal Y grows downwards from the
// top-left of the bed. Shapes carry a 2D affine matrix [a, b, c, d, e, f] (local -> bed).
import { textContours } from '../core/fonts.js';

let counter = 1;
export const lid = () => 'L' + Date.now().toString(36) + (counter++).toString(36) + Math.random().toString(36).slice(2, 5);

export const LAYER_COLORS = [
  '#f2f4f8', '#ff6b6b', '#ffa94d', '#ffd43b', '#a9e34b', '#51cf66', '#20c997', '#22b8cf', '#4dabf7', '#748ffc', '#9775fa', '#da77f2', '#f783ac', '#c92a2a', '#d9480f', '#e67700', '#5c940d', '#2b8a3e', '#087f5b', '#0b7285', '#1864ab', '#364fc7', '#5f3dc4', '#862e9c', '#a61e4d', '#868e96', '#b08968', '#7f5539', '#588157', '#3d5a80', '#adb5bd', '#e9ecef',
];
export const LAYER_NAMES = LAYER_COLORS.map((_, i) => (i < 30 ? String(i + 1).padStart(2, '0') : i === 30 ? 'GA' : 'GB'));
export const isToolLayer = (i) => i >= 30;

export function defaultLayer(i) {
  return {
    index: i, mode: 'line', speed: i === 0 ? 10 : 100, powerMax: i === 0 ? 80 : 30, powerMin: 0, passes: 1,
    interval: 0.1, angle: 0, crosshatch: false, bidirectional: true, overscan: 2.5,
    kerf: 0, tabs: 0, tabSize: 0.5, air: false, output: !isToolLayer(i), show: true,
    image: { mode: 'floyd', negative: false, brightness: 0, contrast: 0, gamma: 1, passThrough: false },
  };
}

export function newLaserDoc() {
  return { version: 1, shapes: [], layers: {}, currentLayer: 0, startFrom: 'absolute', jobOrigin: 6, optimize: { byLayer: true, innerFirst: true, reduceTravel: true }, userOrigin: null };
}

export function layerOf(doc, i) {
  const base = defaultLayer(i);
  // Fill in missing settings in place: UI editors hold on to the returned object.
  const L = doc.layers[i] || (doc.layers[i] = base);
  for (const k in base) if (L[k] == null) L[k] = base[k];
  for (const k in base.image) if (L.image[k] == null) L.image[k] = base.image[k];
  return L;
}

// ---------------------------------------------------------------- matrices
export const IDENT = [1, 0, 0, 1, 0, 0];
/** a * b (b is applied first). */
export const mul = (a, b) => [
  a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
];
export const apply = (m, p) => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
export const invert = (m) => {
  const det = m[0] * m[3] - m[1] * m[2] || 1e-12;
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
};
export const translate = (x, y) => [1, 0, 0, 1, x, y];
export const scaling = (sx, sy) => [sx, 0, 0, sy, 0, 0];
export const rotation = (rad) => { const c = Math.cos(rad), s = Math.sin(rad); return [c, s, -s, c, 0, 0]; };
export const about = (cx, cy, m) => mul(translate(cx, cy), mul(m, translate(-cx, -cy)));

// ---------------------------------------------------------------- shapes
const base = (type, layer, extra) => ({ id: lid(), type, layer, m: [...IDENT], locked: false, powerScale: 100, ...extra });
export const makeRect = (layer, x, y, w, h, r = 0) => ({ ...base('rect', layer, { w, h, r }), m: translate(x, y) });
export const makeEllipse = (layer, x, y, w, h) => ({ ...base('ellipse', layer, { w, h }), m: translate(x, y) });
export const makePolygon = (layer, x, y, w, h, sides = 6) => ({ ...base('polygon', layer, { w, h, sides }), m: translate(x, y) });
export const makeText = (layer, x, y, text, font = 'Sans Bold', size = 10) => ({ ...base('text', layer, { text, font, size, align: 'left', spacing: 0 }), m: translate(x, y) });
export const makeImage = (layer, x, y, w, h, src, pw, ph) => ({ ...base('image', layer, { w, h, src, pw, ph }), m: translate(x, y) });
export const makeGroup = (children) => base('group', children[0] ? children[0].layer : 0, { children });
/** subs: [{ closed, nodes: [{ x, y, ix?, iy?, ox?, oy? }] }] in local coordinates. */
export const makePath = (layer, subs) => base('path', layer, { subs });
export const pathFromPolys = (layer, polys) => makePath(layer, polys.filter((p) => p.pts.length > 1).map((p) => ({ closed: !!p.closed, nodes: p.pts.map(([x, y]) => ({ x, y })) })));

/** Structural copy that shares strings (image data URLs can be megabytes). */
export function deep(o) {
  if (Array.isArray(o)) return o.map(deep);
  if (o && typeof o === 'object') { const out = {}; for (const k in o) out[k] = deep(o[k]); return out; }
  return o;
}

export function cloneShape(s, fresh = true) {
  const c = deep(s);
  if (fresh) { const re = (n) => { n.id = lid(); if (n.children) n.children.forEach(re); }; re(c); }
  return c;
}

export function walkShapes(shapes, fn) {
  for (const s of shapes) { fn(s); if (s.children) walkShapes(s.children, fn); }
}

const TAU = Math.PI * 2;
function arcPts(cx, cy, rx, ry, a0, a1, n) {
  const out = [];
  for (let i = 0; i <= n; i++) { const a = a0 + ((a1 - a0) * i) / n; out.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]); }
  return out;
}

function bezier(p0, c0, c1, p1, out, steps = 18) {
  for (let i = 1; i <= steps; i++) {
    const t = i / steps, u = 1 - t;
    out.push([
      u * u * u * p0[0] + 3 * u * u * t * c0[0] + 3 * u * t * t * c1[0] + t * t * t * p1[0],
      u * u * u * p0[1] + 3 * u * u * t * c0[1] + 3 * u * t * t * c1[1] + t * t * t * p1[1]]);
  }
}

export function flattenSub(sub) {
  const n = sub.nodes;
  if (!n.length) return [];
  const pts = [[n[0].x, n[0].y]];
  const count = sub.closed ? n.length : n.length - 1;
  for (let i = 0; i < count; i++) {
    const a = n[i], b = n[(i + 1) % n.length];
    if (a.ox != null || b.ix != null) bezier([a.x, a.y], [a.ox ?? a.x, a.oy ?? a.y], [b.ix ?? b.x, b.iy ?? b.y], [b.x, b.y], pts);
    else pts.push([b.x, b.y]);
  }
  if (sub.closed && pts.length > 1) pts.pop();
  return pts;
}

const textCache = new Map();
/** Local-space outlines of a (non-group) shape: [{ pts, closed }]. */
export function localPolys(s) {
  switch (s.type) {
    case 'rect': {
      const r = Math.max(0, Math.min(s.r || 0, s.w / 2, s.h / 2));
      if (r < 1e-6) return [{ pts: [[0, 0], [s.w, 0], [s.w, s.h], [0, s.h]], closed: true }];
      return [{ closed: true, pts: [
        ...arcPts(s.w - r, r, r, r, -Math.PI / 2, 0, 8), ...arcPts(s.w - r, s.h - r, r, r, 0, Math.PI / 2, 8),
        ...arcPts(r, s.h - r, r, r, Math.PI / 2, Math.PI, 8), ...arcPts(r, r, r, r, Math.PI, Math.PI * 1.5, 8)] }];
    }
    case 'ellipse': return [{ pts: arcPts(s.w / 2, s.h / 2, s.w / 2, s.h / 2, 0, TAU, 96).slice(0, -1), closed: true }];
    case 'polygon': {
      const pts = [];
      for (let i = 0; i < s.sides; i++) { const a = -Math.PI / 2 + (i / s.sides) * TAU; pts.push([s.w / 2 + (s.w / 2) * Math.cos(a), s.h / 2 + (s.h / 2) * Math.sin(a)]); }
      return [{ pts, closed: true }];
    }
    case 'path': return s.subs.map((sub) => ({ pts: flattenSub(sub), closed: !!sub.closed })).filter((p) => p.pts.length > 1);
    case 'text': {
      const key = [s.text, s.font, s.size, s.align, s.spacing].join('\u0001');
      let polys = textCache.get(key);
      if (!polys) { polys = textContours(s.text, s.font, s.size, s.align, s.spacing || 0); textCache.set(key, polys); if (textCache.size > 300) textCache.delete(textCache.keys().next().value); }
      return polys;
    }
    case 'image': return [{ pts: [[0, 0], [s.w, 0], [s.w, s.h], [0, s.h]], closed: true }];
    default: return [];
  }
}

/** World-space outlines: [{ pts, closed, shape, layer }]. Groups are expanded. */
export function flatten(s, parent = IDENT, out = []) {
  const m = mul(parent, s.m);
  if (s.type === 'group') { for (const c of s.children) flatten(c, m, out); return out; }
  for (const p of localPolys(s)) out.push({ pts: p.pts.map((q) => apply(m, q)), closed: p.closed, shape: s, layer: s.layer, m });
  return out;
}

export function boundsOf(shapes) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of shapes) for (const p of flatten(s)) for (const [x, y] of p.pts) {
    if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;
  }
  return x0 === Infinity ? null : { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
}

export function pointInPoly(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a[1] > pt[1]) !== (b[1] > pt[1]) && pt[0] < ((b[0] - a[0]) * (pt[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

export function distToSeg(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = dx * dx + dy * dy;
  let t = len ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/** Is a bed point on (or, for filled things, inside) a shape? */
export function hitShape(s, pt, tol, filled) {
  const polys = flatten(s);
  let inside = false;
  for (const p of polys) {
    const n = p.pts.length;
    for (let i = 0; i < (p.closed ? n : n - 1); i++) if (distToSeg(pt, p.pts[i], p.pts[(i + 1) % n]) <= tol) return true;
    const solid = p.shape.type === 'image' || p.shape.type === 'text' || filled(p.shape.layer);
    if (p.closed && solid && pointInPoly(pt, p.pts)) inside = !inside;
  }
  return inside;
}

/** Convert any vector shape into an editable path (keeps its transform). */
export function toPath(s) {
  if (s.type === 'path' || s.type === 'image' || s.type === 'group') return s;
  let subs;
  if (s.type === 'ellipse') {
    const k = 0.5522847498, rx = s.w / 2, ry = s.h / 2, cx = rx, cy = ry;
    subs = [{ closed: true, nodes: [
      { x: cx + rx, y: cy, ix: cx + rx, iy: cy - ry * k, ox: cx + rx, oy: cy + ry * k },
      { x: cx, y: cy + ry, ix: cx + rx * k, iy: cy + ry, ox: cx - rx * k, oy: cy + ry },
      { x: cx - rx, y: cy, ix: cx - rx, iy: cy + ry * k, ox: cx - rx, oy: cy - ry * k },
      { x: cx, y: cy - ry, ix: cx - rx * k, iy: cy - ry, ox: cx + rx * k, oy: cy - ry }] }];
  } else {
    subs = localPolys(s).map((p) => ({ closed: p.closed, nodes: p.pts.map(([x, y]) => ({ x, y })) }));
  }
  return { id: s.id, type: 'path', layer: s.layer, m: [...s.m], locked: s.locked, powerScale: s.powerScale, subs };
}

export const typeLabel = (s) => ({ rect: 'Rectangle', ellipse: 'Ellipse', polygon: 'Polygon', path: 'Path', text: 'Text', image: 'Image', group: 'Group' }[s.type] || 'Shape');
