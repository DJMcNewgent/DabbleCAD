// Bitmap -> polygon tracing (used by Scribble and image import).
// Returns [{ outer: [[x,y]...], holes: [[[x,y]...], ...] }] in y-up coordinates.

function signedArea(pts) {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

function pointInPoly(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a[1] > pt[1]) !== (b[1] > pt[1]) && pt[0] < ((b[0] - a[0]) * (pt[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

function simplifyDP(pts, eps) {
  if (pts.length < 4) return pts;
  // Closed ring: split at the two extreme points so the ring cannot collapse.
  let far = 0, best = -1;
  for (let i = 1; i < pts.length; i++) {
    const d = (pts[i][0] - pts[0][0]) ** 2 + (pts[i][1] - pts[0][1]) ** 2;
    if (d > best) { best = d; far = i; }
  }
  const run = (list) => {
    const keep = new Uint8Array(list.length);
    keep[0] = keep[list.length - 1] = 1;
    const stack = [[0, list.length - 1]];
    while (stack.length) {
      const [s, e] = stack.pop();
      const ax = list[s][0], ay = list[s][1], bx = list[e][0], by = list[e][1];
      const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
      let maxD = 0, idx = -1;
      for (let i = s + 1; i < e; i++) {
        const d = Math.abs(dy * (list[i][0] - ax) - dx * (list[i][1] - ay)) / len;
        if (d > maxD) { maxD = d; idx = i; }
      }
      if (idx >= 0 && maxD > eps) { keep[idx] = 1; stack.push([s, idx], [idx, e]); }
    }
    return list.filter((_, i) => keep[i]);
  };
  const a = run(pts.slice(0, far + 1));
  const b = run(pts.slice(far).concat([pts[0]]));
  return a.slice(0, -1).concat(b.slice(0, -1));
}

function chaikin(pts, rounds) {
  let cur = pts;
  for (let r = 0; r < rounds; r++) {
    const next = [];
    for (let i = 0; i < cur.length; i++) {
      const p = cur[i], q = cur[(i + 1) % cur.length];
      next.push([p[0] * 0.75 + q[0] * 0.25, p[1] * 0.75 + q[1] * 0.25], [p[0] * 0.25 + q[0] * 0.75, p[1] * 0.25 + q[1] * 0.75]);
    }
    cur = next;
  }
  return cur;
}

/**
 * @param {Uint8Array} mask  w*h, non-zero = filled
 * @param {object} opts { scale, smooth, epsilon }
 */
export function traceMask(mask, w, h, opts = {}) {
  const { scale = 1, smooth = 1, epsilon = 0.9 } = opts;
  const filled = (x, y) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] !== 0;
  const W = w + 1;
  const vkey = (x, y) => y * W + x;
  // Directed boundary edges, grouped by start vertex.
  const starts = new Map();
  const edges = [];
  const add = (x0, y0, x1, y1) => {
    const e = { x0, y0, x1, y1, used: false };
    edges.push(e);
    const k = vkey(x0, y0);
    const list = starts.get(k);
    if (list) list.push(e); else starts.set(k, [e]);
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      if (!filled(x, y - 1)) add(x, y, x + 1, y);
      if (!filled(x + 1, y)) add(x + 1, y, x + 1, y + 1);
      if (!filled(x, y + 1)) add(x + 1, y + 1, x, y + 1);
      if (!filled(x - 1, y)) add(x, y + 1, x, y);
    }
  }
  const rings = [];
  for (const first of edges) {
    if (first.used) continue;
    const ring = [];
    let e = first;
    while (e && !e.used) {
      e.used = true;
      ring.push([e.x0, e.y0]);
      const cands = (starts.get(vkey(e.x1, e.y1)) || []).filter((c) => !c.used);
      if (!cands.length) break;
      if (cands.length === 1) { e = cands[0]; continue; }
      const dx = e.x1 - e.x0, dy = e.y1 - e.y0;
      // Prefer the tightest turn so diagonal-touching regions stay separate rings.
      let pick = cands[0], bestCross = -Infinity;
      for (const c of cands) {
        const cross = dx * (c.y1 - c.y0) - dy * (c.x1 - c.x0);
        if (cross > bestCross) { bestCross = cross; pick = c; }
      }
      e = pick;
    }
    if (ring.length >= 4) rings.push(ring);
  }

  const outers = [];
  const holes = [];
  for (const ring of rings) {
    // drop collinear points, flip to y-up
    let pts = [];
    for (let i = 0; i < ring.length; i++) {
      const p = ring[(i + ring.length - 1) % ring.length], c = ring[i], n = ring[(i + 1) % ring.length];
      if ((c[0] - p[0]) * (n[1] - c[1]) - (c[1] - p[1]) * (n[0] - c[0]) !== 0) pts.push([c[0], h - c[1]]);
    }
    if (pts.length < 3) continue;
    pts = simplifyDP(pts, epsilon);
    if (pts.length < 3) continue;
    if (smooth > 0) pts = simplifyDP(chaikin(pts, smooth), epsilon * 0.25);
    if (pts.length < 3) continue;
    pts = pts.map((p) => [p[0] * scale, p[1] * scale]);
    const area = signedArea(pts);
    if (Math.abs(area) < scale * scale * 2) continue;
    // In y-up coordinates the tracer yields clockwise outers.
    if (area < 0) outers.push({ outer: pts.reverse(), holes: [], area: -area });
    else holes.push(pts.reverse());
  }
  outers.sort((a, b) => a.area - b.area);
  for (const hole of holes) {
    const host = outers.find((o) => pointInPoly(hole[0], o.outer));
    if (host) host.holes.push(hole);
  }
  return outers.map((o) => ({ outer: o.outer, holes: o.holes }));
}

// Convert an RGBA image to a mask. Dark or opaque-on-transparent pixels count as filled.
export function imageToMask(imageData, { threshold = 128, invert = false } = {}) {
  const { data, width, height } = imageData;
  const mask = new Uint8Array(width * height);
  let hasAlpha = false;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 250) { hasAlpha = true; break; }
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    let on;
    if (hasAlpha) on = data[i + 3] >= 128;
    else on = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2] < threshold;
    mask[p] = on !== invert ? 1 : 0;
  }
  return mask;
}

export function polysBounds(polys) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of polys) for (const [x, y] of p.outer) {
    if (x < minX) minX = x; if (y < minY) minY = y;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}
