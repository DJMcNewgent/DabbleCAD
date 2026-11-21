// CAM engine: turns outlines into 3D cutter paths.
// Everything here is in job coordinates: millimetres, X to the right, Y away from the operator,
// Z up, with Z = 0 at the top of the material (cuts are negative).
import ClipperLib from 'clipper-lib';

const S = 1000; // clipper works on integers: 1 unit = 1 micron
const NZ = ClipperLib.PolyFillType.pftNonZero;
const toC = (pts) => pts.map((p) => ({ X: Math.round(p[0] * S), Y: Math.round(p[1] * S) }));
const fromC = (path) => path.map((p) => [p.X / S, p.Y / S]);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const DEG = Math.PI / 180;

export const TOOLPATH_TYPES = [
  ['profile', 'Cut out', 'Cut along the outline: outside to free a part, inside to make a hole, or on the line'],
  ['pocket', 'Pocket', 'Clear out everything inside the shape to a depth'],
  ['vcarve', 'V-carve', 'Carve with a V-bit: narrow areas stay shallow, wide areas go deep, corners come out sharp'],
  ['engrave', 'Engrave', 'Follow the lines themselves at a shallow depth (also works on open lines)'],
  ['drill', 'Drill', 'Drill a hole at the centre of each shape'],
  ['chamfer', 'Chamfer', 'Run a V-bit along the edge to bevel it'],
  ['inlay', 'Inlay', 'A pocket and a matching plug that fit together'],
  ['texture', 'Texture', 'Fill the shape with a hand-carved looking pattern of scoops'],
  ['relief', '3D relief', 'Carve a height map picture: bright is high, dark is deep'],
];

// ---------------------------------------------------------------- regions (clipper)
/** groups: one list of { pts, closed } per shape. Returns clipper paths: outers counter-clockwise, holes clockwise. */
export function regionFrom(groups) {
  const all = [];
  for (const g of groups) {
    const paths = g.filter((p) => p.closed && p.pts.length > 2).map((p) => toC(p.pts));
    if (paths.length) all.push(...ClipperLib.Clipper.SimplifyPolygons(paths, ClipperLib.PolyFillType.pftEvenOdd));
  }
  return unionC(all);
}

function clip(subject, clipPaths, type) {
  if (!subject.length) return [];
  const c = new ClipperLib.Clipper();
  c.AddPaths(subject, ClipperLib.PolyType.ptSubject, true);
  if (clipPaths && clipPaths.length) c.AddPaths(clipPaths, ClipperLib.PolyType.ptClip, true);
  const sol = new ClipperLib.Paths();
  c.Execute(type, sol, NZ, NZ);
  return sol.filter((p) => p.length > 2);
}
const unionC = (paths) => clip(paths, [], ClipperLib.ClipType.ctUnion);
const differenceC = (a, b) => clip(a, b, ClipperLib.ClipType.ctDifference);

/** Grow (positive) or shrink (negative) a region by delta mm with rounded corners. */
export function offsetC(paths, delta) {
  if (!paths.length || Math.abs(delta) < 1e-7) return paths;
  const co = new ClipperLib.ClipperOffset(3, 0.008 * S);
  co.AddPaths(paths, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  const sol = new ClipperLib.Paths();
  co.Execute(sol, delta * S);
  // drop needless corners (within 3 microns) so paths and G-code stay small
  return ClipperLib.Clipper.CleanPolygons(sol, 3).filter((p) => p.length > 2);
}

const signedArea = (pts) => { let a = 0; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1]); return a / 2; };
/** Clipper paths -> [{ pts, hole }] with the region always on the left of travel (outer CCW, hole CW). */
function ringsOf(paths) {
  return paths.map((p) => { const pts = fromC(p); return { pts, hole: signedArea(pts) < 0 }; }).filter((r) => r.pts.length > 2);
}

function pointInRegion(pt, rings) {
  let inside = false;
  for (const r of rings) {
    const poly = r.pts;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a[1] > pt[1]) !== (b[1] > pt[1]) && pt[0] < ((b[0] - a[0]) * (pt[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
    }
  }
  return inside;
}

// ---------------------------------------------------------------- ring helpers
function ringLength(pts, closed = true) {
  let len = 0;
  for (let i = 0; i < pts.length - 1; i++) len += dist(pts[i], pts[i + 1]);
  if (closed && pts.length > 1) len += dist(pts[pts.length - 1], pts[0]);
  return len;
}

/** Nearest point on a closed ring to p: { d, i (edge start index), pt }. */
function nearestOnRing(pts, p) {
  let best = { d: Infinity, i: 0, pt: pts[0] };
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const dx = b[0] - a[0], dy = b[1] - a[1], len = dx * dx + dy * dy;
    let t = len ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len : 0;
    t = Math.max(0, Math.min(1, t));
    const q = [a[0] + t * dx, a[1] + t * dy], d = dist(p, q);
    if (d < best.d) best = { d, i, pt: q, t };
  }
  return best;
}

/** The same closed ring, re-started at the point nearest to p (a new corner is added there if needed). */
function startNear(pts, p) {
  if (!p) return pts;
  const n = nearestOnRing(pts, p);
  const out = [];
  if (n.t > 1e-6 && n.t < 1 - 1e-6) out.push(n.pt);
  const first = n.t >= 1 - 1e-6 ? (n.i + 1) % pts.length : n.t <= 1e-6 ? n.i : (n.i + 1) % pts.length;
  for (let k = 0; k < pts.length; k++) out.push(pts[(first + k) % pts.length]);
  return out;
}

/** Nearest-neighbour order, starting from `from`. Closed rings are re-started at their nearest point. */
function orderRings(rings, from) {
  const left = [...rings], out = [];
  let cur = from;
  while (left.length) {
    let bi = 0, bd = Infinity;
    for (let i = 0; i < left.length; i++) { const d = cur ? nearestOnRing(left[i].pts, cur).d : 0; if (d < bd) { bd = d; bi = i; } }
    const r = left.splice(bi, 1)[0];
    const pts = startNear(r.pts, cur);
    out.push({ ...r, pts, gap: cur ? bd : Infinity });
    cur = pts[0];
  }
  return out;
}

export function depthLevels(start, depth, step) {
  const total = depth - start;
  if (!(total > 1e-6)) return [];
  const n = Math.max(1, Math.ceil(total / Math.max(step || total, 0.01) - 1e-6));
  return Array.from({ length: n }, (_, k) => -(start + (total * (k + 1)) / n));
}

/**
 * Cut a closed ring at every depth level in one continuous move.
 * ramp: the cutter slides down along the ring over this length instead of plunging straight down.
 * tabs: { count, width, height, dia }: bridges left at the bottom of the cut so the part stays put.
 */
function contourPasses(ring, levels, { zTop = 0, ramp = 0, tabs = null } = {}) {
  const n = ring.length;
  const cum = [0];
  for (let i = 0; i < n; i++) cum.push(cum[i] + dist(ring[i], ring[(i + 1) % n]));
  const P = cum[n];
  if (P < 1e-6 || !levels.length) return [];
  const L = ramp > 0 ? Math.min(ramp, P) : 0;
  const at = (d) => {
    let i = 0;
    while (i < n - 1 && cum[i + 1] < d) i++;
    const seg = cum[i + 1] - cum[i], t = seg > 1e-12 ? (d - cum[i]) / seg : 0, a = ring[i], b = ring[(i + 1) % n];
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  };
  // where the tabs sit, as [from, to] distances along the ring
  let gaps = [], tabTop = -Infinity;
  if (tabs && tabs.count > 0 && tabs.height > 0) {
    const w = tabs.width + tabs.dia;
    let count = Math.round(tabs.count);
    while (count > 0 && P < count * w * 1.25) count--;
    tabTop = levels[levels.length - 1] + tabs.height;
    for (let k = 0; k < count; k++) { const c = ((k + 0.5) / count) * P; gaps.push([c - w / 2, c + w / 2]); }
  }
  const inTab = (d) => gaps.some((g) => d > g[0] + 1e-9 && d < g[1] - 1e-9);
  const marks = new Set(cum.slice(0, n).map((d) => +d.toFixed(6)));
  marks.add(+P.toFixed(6));
  if (L > 0) marks.add(+L.toFixed(6));
  for (const g of gaps) for (const d of g) if (d > 0 && d < P) marks.add(+d.toFixed(6));
  const stops = [...marks].sort((a, b) => a - b).map((d) => ({ d, p: at(d) }));
  const out = [];
  const push = (p, z) => { const q = out[out.length - 1]; if (!q || Math.abs(q[0] - p[0]) > 1e-9 || Math.abs(q[1] - p[1]) > 1e-9 || Math.abs(q[2] - z) > 1e-9) out.push([p[0], p[1], z]); };
  const loops = levels.length + (L > 0 ? 1 : 0);
  for (let k = 0; k < loops; k++) {
    const cleanup = k >= levels.length;
    const zCur = levels[Math.min(k, levels.length - 1)], zPrev = cleanup ? zCur : k ? levels[k - 1] : zTop;
    for (let si = 0; si < stops.length; si++) {
      const { d, p } = stops[si];
      if (cleanup && d > L + 1e-9) break;
      const base = L > 0 && d < L ? zPrev + ((zCur - zPrev) * d) / L : zCur;
      const before = si > 0 ? (stops[si - 1].d + d) / 2 : -1, after = si < stops.length - 1 ? (d + stops[si + 1].d) / 2 : -1;
      push(p, before >= 0 && inTab(before) ? Math.max(base, tabTop) : base);
      push(p, after >= 0 && inTab(after) ? Math.max(base, tabTop) : base);
    }
  }
  return out;
}

/** Open line: back and forth, one level per trip. flute > 0 ramps the ends up to the surface. */
function openPasses(pts, levels, flute = 0) {
  const out = [];
  const len = ringLength(pts, false);
  levels.forEach((z, k) => {
    const line = k % 2 ? [...pts].reverse() : pts;
    let d = 0;
    line.forEach((p, i) => {
      if (i) d += dist(line[i - 1], p);
      let zz = z;
      if (flute > 0 && len > 1e-6) { const edge = Math.min(d, len - d), f = Math.min(flute, len / 2); if (edge < f) zz = z * (edge / f); }
      out.push([p[0], p[1], zz]);
    });
  });
  return out;
}

/** Split long segments so a depth profile along a line (flutes, textures) has points to work with. */
function densify(pts, step) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], n = Math.max(1, Math.ceil(dist(a, b) / step));
    for (let k = 1; k <= n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  return out;
}

/** Drop points that sit on a straight line between their neighbours (3D, within tol). */
export function simplify3(pts, tol = 0.01) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    const A = pts[a], B = pts[b];
    const dx = B[0] - A[0], dy = B[1] - A[1], dz = B[2] - A[2], len2 = dx * dx + dy * dy + dz * dz;
    let worst = -1, wi = -1;
    for (let i = a + 1; i < b; i++) {
      const p = pts[i];
      let t = len2 ? ((p[0] - A[0]) * dx + (p[1] - A[1]) * dy + (p[2] - A[2]) * dz) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(p[0] - A[0] - t * dx, p[1] - A[1] - t * dy, p[2] - A[2] - t * dz);
      if (d > worst) { worst = d; wi = i; }
    }
    if (worst > tol) { keep[wi] = 1; stack.push([a, wi], [wi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

/**
 * Work down to a 3D path in layers: each layer only re-traces the stretches that still have
 * material above them, held up at that layer's depth.
 */
function clampPasses(pts, levels, zTop = 0) {
  const out = [];
  let prev = zTop, minZ = Infinity;
  for (const p of pts) if (p[2] < minZ) minZ = p[2];
  for (const L of levels) {
    let run = null;
    const hold = (p) => [p[0], p[1], Math.max(p[2], L)];
    for (let i = 0; i < pts.length; i++) {
      if (pts[i][2] < prev - 1e-6) {
        if (!run) { run = []; if (i > 0) run.push(hold(pts[i - 1])); }
        run.push(hold(pts[i]));
      } else if (run) { run.push(hold(pts[i])); out.push({ pts: run }); run = null; }
    }
    if (run) out.push({ pts: run });
    prev = L;
    if (minZ >= L - 1e-6) break;
  }
  return out;
}

// ---------------------------------------------------------------- hatching
/** Parallel lines across a region. Returns rows of [a, b] point pairs, in sweep order. */
function hatch(rings, spacing, angleDeg) {
  const c = Math.cos(-angleDeg * DEG), s = Math.sin(-angleDeg * DEG);
  const rot = (p) => [p[0] * c - p[1] * s, p[0] * s + p[1] * c], back = (p) => [p[0] * c + p[1] * s, -p[0] * s + p[1] * c];
  const R = rings.map((r) => r.pts.map(rot));
  let y0 = Infinity, y1 = -Infinity;
  for (const r of R) for (const p of r) { if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
  const rows = [];
  if (!isFinite(y0)) return rows;
  const count = Math.max(1, Math.floor((y1 - y0) / spacing));
  const first = y0 + ((y1 - y0) - count * spacing) / 2;
  for (let k = 0; k <= count; k++) {
    // nudged off the exact value so a row never runs along a horizontal edge
    const y = first + k * spacing + 1.37e-4;
    const xs = [];
    for (const r of R) for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const a = r[j], b = r[i];
      if ((a[1] > y) !== (b[1] > y)) xs.push(a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
    }
    xs.sort((p, q) => p - q);
    const spans = [];
    for (let i = 0; i + 1 < xs.length; i += 2) if (xs[i + 1] - xs[i] > 1e-4) spans.push([back([xs[i], y]), back([xs[i + 1], y])]);
    if (spans.length) rows.push(spans);
  }
  return rows;
}

/** Rows -> zig-zag segments with `link` set where the cutter can stay down between them. */
function zigzag(rows, maxLink, rings) {
  const out = [];
  let cur = null, flip = false;
  for (const spans of rows) {
    const list = flip ? [...spans].reverse().map(([a, b]) => [b, a]) : spans;
    for (const [a, b] of list) {
      let link = false;
      if (cur) {
        const d = dist(cur, a);
        link = d <= maxLink && pointInRegion([(cur[0] + a[0]) / 2, (cur[1] + a[1]) / 2], rings);
      }
      out.push({ a, b, link });
      cur = b;
    }
    flip = !flip;
  }
  return out;
}

// ---------------------------------------------------------------- dog-bones
/**
 * Inside corners a round cutter cannot reach. For every such corner the cutter path gets a
 * short hop into the corner and back. `inward` picks corners of the region itself (pockets, holes);
 * otherwise corners of the space around it (the inside corners of a part's outline).
 */
function addDogbones(cutRings, sourceRings, r, inward) {
  const hops = [];
  for (const ring of sourceRings) {
    const p = ring.pts, n = p.length;
    for (let i = 0; i < n; i++) {
      const a = p[(i - 1 + n) % n], b = p[i], c = p[(i + 1) % n];
      const l1 = dist(a, b), l2 = dist(b, c);
      if (l1 < r * 0.5 || l2 < r * 0.5) continue;
      const d1 = [(b[0] - a[0]) / l1, (b[1] - a[1]) / l1], d2 = [(c[0] - b[0]) / l2, (c[1] - b[1]) / l2];
      const cross = d1[0] * d2[1] - d1[1] * d2[0], dot = d1[0] * d2[0] + d1[1] * d2[1];
      const turn = Math.atan2(cross, dot); // > 0: left turn = a corner of the region
      if ((inward ? turn : -turn) < 30 * DEG) continue;
      const sgn = inward ? 1 : -1;
      let bx = sgn * (-d1[1] - d2[1]), by = sgn * (d1[0] + d2[0]);
      const bl = Math.hypot(bx, by);
      if (bl < 1e-6) continue;
      bx /= bl; by /= bl;
      const reach = r / Math.cos(Math.abs(turn) / 2);
      hops.push({ at: [b[0] + bx * reach, b[1] + by * reach], to: [b[0] + bx * r, b[1] + by * r] });
    }
  }
  if (!hops.length) return cutRings;
  return cutRings.map((ring) => {
    const pts = [];
    for (const q of ring.pts) {
      pts.push(q);
      const hop = hops.find((hp) => dist(hp.at, q) < 0.03);
      if (hop) pts.push(hop.to, q);
    }
    return { ...ring, pts };
  });
}

/** Point the ring the right way round for climb or conventional milling. keepInside: the finished part is inside the ring. */
function orient(ring, keepInside, climb) {
  const ccw = signedArea(ring.pts) > 0;
  const wantCcw = keepInside ? !climb : climb;
  return ccw === wantCcw ? ring : { ...ring, pts: [...ring.pts].reverse() };
}

// ---------------------------------------------------------------- operations
function profileOp(region, opens, tp, tool, warn) {
  const r = tool.dia / 2, climb = tp.direction !== 'conventional';
  const levels = depthLevels(tp.startDepth || 0, tp.depth, tp.passDepth);
  const zTop = -(tp.startDepth || 0);
  const paths = [];
  const side = tp.side || 'outside';
  const tabs = tp.tabs && tp.tabs.count > 0 ? { ...tp.tabs, dia: tool.dia } : null;
  if (side === 'on') {
    for (const ring of orderRings(ringsOf(region), null)) paths.push({ pts: contourPasses(orient(ring, !ring.hole, climb).pts, levels, { zTop, ramp: tp.ramp || 0, tabs }) });
    for (const o of opens) paths.push({ pts: openPasses(tp.flute > 0 ? densify(o.pts, 1) : o.pts, levels, tp.flute || 0) });
    return paths;
  }
  const sgn = side === 'outside' ? 1 : -1;
  const offset = tp.offset != null ? tp.offset : r;
  const source = ringsOf(region);
  const make = (extra) => {
    let rings = ringsOf(offsetC(region, sgn * (offset + extra)));
    if (tp.dogbone && tp.offset == null) rings = addDogbones(rings, source, r + extra, side === 'inside');
    // an outer ring of an outside cut (and an island of an inside cut) has the part inside it
    return rings.map((ring) => orient(ring, side === 'outside' ? !ring.hole : ring.hole, climb));
  };
  const allow = Math.max(0, tp.finishAllowance || 0);
  const rough = make(allow);
  if (!rough.length) { warn(side === 'inside' ? 'The bit is too wide to fit inside this shape.' : 'Nothing to cut.'); return paths; }
  // inner features first, so a part is not cut loose before its holes are done
  const inner = (ring) => (side === 'outside' ? ring.hole : !ring.hole);
  const ordered = [...orderRings(rough.filter(inner), null), ...orderRings(rough.filter((x) => !inner(x)), null)];
  for (const ring of ordered) paths.push({ pts: contourPasses(ring.pts, levels, { zTop, ramp: tp.ramp || 0, tabs }) });
  if (allow > 0) for (const ring of orderRings(make(0), null)) paths.push({ pts: contourPasses(ring.pts, [levels[levels.length - 1]], { zTop, ramp: tp.ramp || 0, tabs }) });
  return paths;
}

/** Clear a region. Returns paths; rings are cut from the middle outwards. */
function clearRegion(region, tool, tp, levels, zTop, { wallOffset = tool.dia / 2, dogbone = false, fixedStep = 0 } = {}) {
  const climb = tp.direction !== 'conventional';
  const step = fixedStep || Math.max(0.05, Math.min(tool.dia * 0.95, tp.stepover || tool.dia * 0.4));
  const allow = Math.max(0, tp.finishAllowance || 0);
  const paths = [];
  const first = offsetC(region, -(wallOffset + allow));
  if (!first.length) return null;
  const firstRings = ringsOf(first);
  const face = (list) => list.map((ring) => orient(ring, ring.hole, climb));
  if (tp.strategy === 'raster') {
    const rows = hatch(firstRings, step, tp.angle || 0);
    const segs = zigzag(rows, step * 2.5, firstRings);
    let wall = face(firstRings);
    if (dogbone) wall = addDogbones(wall, ringsOf(region), wallOffset + allow, true);
    levels.forEach((z, k) => {
      const prev = k ? levels[k - 1] : zTop;
      segs.forEach((sg, i) => {
        if (sg.link && i) paths[paths.length - 1].pts.push([sg.a[0], sg.a[1], z], [sg.b[0], sg.b[1], z]);
        else paths.push({ pts: [[sg.a[0], sg.a[1], z], [sg.b[0], sg.b[1], z]] });
      });
      for (const ring of orderRings(wall, null)) paths.push({ pts: contourPasses(ring.pts, [z], { zTop: prev, ramp: tp.ramp || 0 }) });
    });
  } else {
    const shells = [];
    let cur = first;
    for (let guard = 0; cur.length && guard < 4000; guard++) { shells.push(ringsOf(cur)); cur = offsetC(cur, -step); }
    if (dogbone) shells[0] = addDogbones(shells[0], ringsOf(region), wallOffset + allow, true);
    levels.forEach((z, k) => {
      const prev = k ? levels[k - 1] : zTop;
      let at = null;
      for (let s = shells.length - 1; s >= 0; s--) {
        for (const ring of orderRings(face(shells[s]), at)) {
          const mid = at ? [(at[0] + ring.pts[0][0]) / 2, (at[1] + ring.pts[0][1]) / 2] : null;
          const link = !!at && ring.gap <= step * 1.35 + 0.02 && pointInRegion(mid, firstRings);
          if (link) paths.push({ link: true, pts: [...ring.pts, ring.pts[0]].map((p) => [p[0], p[1], z]) });
          else paths.push({ pts: contourPasses(ring.pts, [z], { zTop: prev, ramp: tp.ramp || 0 }) });
          const done = paths[paths.length - 1].pts;
          at = done.length ? done[done.length - 1] : ring.pts[0];
        }
      }
    });
  }
  if (allow > 0) {
    let wall = face(ringsOf(offsetC(region, -wallOffset)));
    if (dogbone) wall = addDogbones(wall, ringsOf(region), wallOffset, true);
    for (const ring of orderRings(wall, null)) paths.push({ pts: contourPasses(ring.pts, [levels[levels.length - 1]], { zTop, ramp: tp.ramp || 0 }) });
  }
  return paths;
}

function pocketOp(region, tp, tool, warn) {
  const levels = depthLevels(tp.startDepth || 0, tp.depth, tp.passDepth);
  const paths = clearRegion(region, tool, tp, levels, -(tp.startDepth || 0), { dogbone: !!tp.dogbone });
  if (!paths) { warn('The bit is too wide to fit inside this shape.'); return []; }
  return paths;
}

function drillOp(groups, tp) {
  const paths = [];
  const top = -(tp.startDepth || 0), peck = tp.peck > 0 ? tp.peck : tp.depth;
  const levels = depthLevels(tp.startDepth || 0, tp.depth, peck);
  const pts = [];
  for (const g of groups) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of g) for (const [x, y] of p.pts) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
    if (isFinite(x0)) pts.push([(x0 + x1) / 2, (y0 + y1) / 2]);
  }
  // nearest-neighbour hole order
  let cur = [0, 0];
  while (pts.length) {
    let bi = 0;
    for (let i = 1; i < pts.length; i++) if (dist(pts[i], cur) < dist(pts[bi], cur)) bi = i;
    cur = pts.splice(bi, 1)[0];
    const path = [];
    levels.forEach((z, k) => {
      if (k) path.push([cur[0], cur[1], top + 1, 1], [cur[0], cur[1], levels[k - 1] + 0.5, 1]); // clear the chips, then back down
      path.push([cur[0], cur[1], z]);
    });
    paths.push({ pts: path, dwell: tp.dwell > 0 ? tp.dwell : 0 });
  }
  return paths;
}

/**
 * V-carving: for each point of the outline find the largest circle that touches the outline there
 * and still fits inside the shape. The bit runs at the circle's centre, just deep enough for its
 * flanks to reach the outline.
 */
function vcarveRings(rings, rmax, tanA, spacing) {
  // Curves arrive as many short straight pieces. A turn smaller than HARD is treated as part of a
  // smooth curve: its neighbours along the curve do not count as "the other side".
  const HARD = 20 * DEG, SPAN = 45 * DEG, JUMP = 100;
  const qx = [], qy = [], qring = [], qth = [], qe1 = [], qe2 = [];
  const perRing = [], total = [];
  let edgeId = 0;
  rings.forEach((ring, ri) => {
    const p = ring.pts.filter((pt, i, arr) => dist(pt, arr[(i + 1) % arr.length]) > 1e-7);
    const n = p.length, list = [];
    perRing.push(list);
    total.push(0);
    if (n < 3) return;
    const dir = [], nor = [], len = [];
    for (let i = 0; i < n; i++) { const A = p[i], B = p[(i + 1) % n], l = dist(A, B); len.push(l); dir.push([(B[0] - A[0]) / l, (B[1] - A[1]) / l]); nor.push([-(B[1] - A[1]) / l, (B[0] - A[0]) / l]); }
    const turn = [], hard = [], vn = [], brk = [];
    for (let i = 0; i < n; i++) {
      const a = dir[(i - 1 + n) % n], b = dir[i];
      const t = Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1]);
      turn.push(t); hard.push(Math.abs(t) > HARD);
      const la = len[(i - 1 + n) % n], lb = len[i];
      brk.push(Math.abs(t) > HARD || (Math.abs(t) > 1 * DEG && Math.max(la, lb) > 4 * Math.min(la, lb)));
      const na = nor[(i - 1 + n) % n], nb = nor[i], l = Math.hypot(na[0] + nb[0], na[1] + nb[1]) || 1;
      vn.push([(na[0] + nb[0]) / l, (na[1] + nb[1]) / l]);
    }
    const base = edgeId;
    edgeId += n;
    let th = 0;
    for (let i = 0; i < n; i++) {
      const A = p[i], B = p[(i + 1) % n], t = turn[i], jump = brk[i] ? JUMP : Math.abs(t);
      const ePrev = base + ((i - 1 + n) % n), e = base + i;
      qx.push(A[0]); qy.push(A[1]); qring.push(ri); qth.push(th + jump / 2); qe1.push(ePrev); qe2.push(e);
      if (hard[i] && t > 0) list.push({ x: A[0], y: A[1], fixed: 0 }); // sharp corner: the bit lifts right to the surface
      else if (hard[i]) {
        // corner pointing into the shape: the bit swings around it
        const n1 = nor[(i - 1 + n) % n], steps = Math.max(1, Math.ceil(-t / (12 * DEG)));
        for (let k = 0; k <= steps; k++) { const a = (t * k) / steps, c = Math.cos(a), sn = Math.sin(a); list.push({ x: A[0], y: A[1], nx: n1[0] * c - n1[1] * sn, ny: n1[0] * sn + n1[1] * c, ring: ri, th: th + jump / 2, e: -1 }); }
      }
      th += jump;
      const nA = hard[i] ? nor[i] : vn[i], nB = hard[(i + 1) % n] ? nor[i] : vn[(i + 1) % n];
      const m = Math.max(1, Math.round(len[i] / spacing));
      for (let k = 0; k < m; k++) {
        const u = (k + 0.5) / m, x = A[0] + (B[0] - A[0]) * u, y = A[1] + (B[1] - A[1]) * u;
        let nx = nA[0] + (nB[0] - nA[0]) * u, ny = nA[1] + (nB[1] - nA[1]) * u;
        const l = Math.hypot(nx, ny) || 1;
        nx /= l; ny /= l;
        list.push({ x, y, nx, ny, ring: ri, th, e });
        qx.push(x); qy.push(y); qring.push(ri); qth.push(th); qe1.push(e); qe2.push(e);
      }
    }
    total[ri] = th;
  });
  // bucket the outline points so each test only looks nearby
  const cell = Math.max(rmax, 0.5), reach = 2 * rmax;
  let gx0 = Infinity, gy0 = Infinity;
  for (let i = 0; i < qx.length; i++) { if (qx[i] < gx0) gx0 = qx[i]; if (qy[i] < gy0) gy0 = qy[i]; }
  const grid = new Map();
  for (let i = 0; i < qx.length; i++) {
    const key = Math.floor((qx[i] - gx0) / cell) * 100003 + Math.floor((qy[i] - gy0) / cell);
    let b = grid.get(key);
    if (!b) grid.set(key, (b = []));
    b.push(i);
  }
  const out = [];
  for (const list of perRing) {
    const pts = [];
    for (const sm of list) {
      if (sm.fixed != null) { pts.push([sm.x, sm.y, 0]); continue; }
      let r = rmax;
      const W = total[sm.ring];
      const cx0 = Math.floor((sm.x - reach - gx0) / cell), cx1 = Math.floor((sm.x + reach - gx0) / cell);
      const cy0 = Math.floor((sm.y - reach - gy0) / cell), cy1 = Math.floor((sm.y + reach - gy0) / cell);
      for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
        const b = grid.get(cx * 100003 + cy);
        if (!b) continue;
        for (let k = 0; k < b.length; k++) {
          const j = b[k];
          const dx = qx[j] - sm.x, dy = qy[j] - sm.y, dot = dx * sm.nx + dy * sm.ny;
          if (dot <= 1e-7) continue;
          const d2 = dx * dx + dy * dy;
          if (d2 >= 2 * r * dot) continue;
          if (qring[j] === sm.ring) {
            if (qe1[j] === sm.e || qe2[j] === sm.e) continue;
            let d = Math.abs(qth[j] - sm.th);
            if (d > W / 2) d = W - d;
            if (d <= SPAN) continue;
          }
          r = d2 / (2 * dot);
        }
      }
      pts.push([sm.x + sm.nx * r, sm.y + sm.ny * r, -r / tanA]);
    }
    if (pts.length > 2) { pts.push([...pts[0]]); out.push(pts); }
  }
  return out;
}

function vcarveOp(region, tp, tool, clearTool, warn) {
  const tanA = Math.tan(((tool.angle || 60) / 2) * DEG), rTool = tool.dia / 2;
  const flat = tp.flatDepth > 0 ? tp.flatDepth : 0;
  const limit = flat || (tp.depth > 0 ? tp.depth : Infinity);
  const rmax = Math.min(rTool, limit * tanA);
  const rings = ringsOf(region);
  let total = 0;
  for (const r of rings) total += ringLength(r.pts);
  const spacing = Math.max(0.15, Math.min(0.6, total / 60000));
  const carved = vcarveRings(rings, rmax, tanA, spacing);
  let deepest = 0;
  for (const pts of carved) for (const p of pts) if (p[2] < deepest) deepest = p[2];
  const levels = depthLevels(0, -deepest, tp.passDepth);
  const sections = [];
  const vPaths = [];
  for (const pts of carved) vPaths.push(...clampPasses(simplify3(pts, 0.008), levels));
  if (flat) {
    // the floor of the wide areas
    const floor = offsetC(region, -rmax);
    if (floor.length) {
      const floorLevels = depthLevels(0, flat, tp.passDepth);
      const tipStep = Math.max(0.1, tp.flatStepover || Math.max(0.3, (tool.tip || 0) * 0.8));
      if (clearTool && clearTool.type !== 'vbit') {
        const cl = clearRegion(floor, clearTool, { stepover: clearTool.dia * 0.4, direction: tp.direction, ramp: tp.ramp }, depthLevels(0, flat, clearTool.passDepth || tp.passDepth), 0, { wallOffset: clearTool.dia / 2 });
        if (cl) sections.push({ tool: clearTool, role: 'clear', paths: cl });
        else warn('The clearing bit does not fit in the flat areas, so the V-bit clears them itself.');
        // what the flat bit could not reach is left to the tip of the V-bit
        const R = clearTool.dia / 2;
        const reached = cl ? offsetC(offsetC(floor, -R), R + 0.02) : [];
        const rest = differenceC(floor, reached);
        const tip = clearRegion(rest, tool, { direction: tp.direction }, floorLevels, 0, { wallOffset: tipStep, fixedStep: tipStep });
        if (tip) vPaths.push(...tip);
      } else {
        const tip = clearRegion(floor, tool, { direction: tp.direction }, floorLevels, 0, { wallOffset: tipStep, fixedStep: tipStep });
        if (tip) vPaths.push(...tip);
      }
    }
  } else if (rmax >= rTool - 1e-9 && rTool < limit * tanA) {
    // was the bit wide enough to reach the middle of everything?
    if (offsetC(region, -(rTool + 0.05)).length) warn('This V-bit is too narrow to reach the middle of the widest areas. Use a wider bit, or set a flat depth so the middle is cleared flat.');
  }
  sections.push({ tool, paths: vPaths });
  return sections;
}

function chamferOp(region, tp, tool, warn) {
  const tanA = Math.tan(((tool.angle || 90) / 2) * DEG);
  const width = Math.max(0.05, tp.width || 1), tip = Math.max(0, tp.tipOffset != null ? tp.tipOffset : 0.5);
  let off = tip, depth = (width + tip) / tanA;
  if (depth * tanA > tool.dia / 2 + 1e-9) { warn('This chamfer is too wide for the bit; it has been limited to what the bit can cut.'); depth = tool.dia / 2 / tanA; off = Math.max(0, depth * tanA - width); }
  return profileOp(region, [], { ...tp, depth, startDepth: 0, passDepth: tp.passDepth || depth, offset: off, tabs: null, ramp: 0, dogbone: false, finishAllowance: 0 }, tool, warn);
}

function inlayOp(region, tp, tool, warn) {
  const r = tool.dia / 2;
  if (tp.part === 'plug') {
    // the plug gets the same rounded corners the bit leaves in the pocket, less a little clearance
    const rounded = offsetC(offsetC(region, -r), r);
    const plug = offsetC(rounded, -Math.max(0, tp.gap || 0));
    if (!plug.length) { warn('The bit is too wide to fit inside this shape.'); return []; }
    return profileOp(plug, [], { ...tp, side: 'outside', dogbone: false }, tool, warn);
  }
  return pocketOp(region, { ...tp, dogbone: false }, tool, warn);
}

function mulberry(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function textureOp(region, tp, tool) {
  const r = tool.dia / 2;
  const inside = offsetC(region, -Math.min(r * 0.5, 1));
  const rings = ringsOf(inside.length ? inside : region);
  const spacing = Math.max(0.3, tp.stepover || tool.dia * 0.8);
  const rows = hatch(rings, spacing, tp.angle || 0);
  const rnd = mulberry(tp.seed || 7);
  const depth = Math.max(0.05, tp.depth), base = Math.max(2, tp.scoop || 20), vary = Math.max(0, Math.min(1, (tp.variation ?? 40) / 100));
  const paths = [];
  let flip = false;
  for (const spans of rows) {
    // each row is a chain of scoops whose lengths wander around the chosen size
    let phase = rnd() * base;
    for (const [a0, b0] of flip ? [...spans].reverse().map(([a, b]) => [b, a]) : spans) {
      const len = dist(a0, b0);
      if (len < 0.5) continue;
      const pts = [];
      let d = 0, scoop = base * (1 - vary / 2 + rnd() * vary), start = -phase;
      const n = Math.max(2, Math.ceil(len / 0.75));
      for (let k = 0; k <= n; k++) {
        d = (len * k) / n;
        while (d - start > scoop) { start += scoop; scoop = base * (1 - vary / 2 + rnd() * vary); }
        const t = (d - start) / scoop;
        const z = -depth * Math.sin(Math.PI * Math.max(0, Math.min(1, t))) * (0.75 + 0.25 * Math.sin(start));
        pts.push([a0[0] + ((b0[0] - a0[0]) * k) / n, a0[1] + ((b0[1] - a0[1]) * k) / n, Math.min(0, z)]);
      }
      phase = (phase + len) % base;
      paths.push({ pts: simplify3(pts, 0.01) });
    }
    flip = !flip;
  }
  return paths;
}

/** The lowest the tip of a tool can sit at each offset from its centre line, measured up from the tip. */
export function toolProfile(tool, d) {
  const r = tool.dia / 2;
  if (d > r + 1e-9) return Infinity;
  if (tool.type === 'ball') return r - Math.sqrt(Math.max(0, r * r - d * d));
  if (tool.type === 'vbit') { const flatR = (tool.tip || 0) / 2; return d <= flatR ? 0 : (d - flatR) / Math.tan(((tool.angle || 60) / 2) * DEG); }
  if (tool.type === 'drill') return d / Math.tan(59 * DEG);
  return 0;
}

/**
 * 3D relief from a height map.
 * hm: { data (Float32Array, 0..1, 1 = top surface), w, h, x0, y0, cell }: row 0 is at y0 and rows go towards +Y.
 */
function reliefOp(hm, tp, tool) {
  const depth = Math.max(0.05, tp.depth), allow = tp.mode === 'rough' ? Math.max(0, tp.allowance ?? 0.5) : 0;
  const step = Math.max(hm.cell, tp.stepover || tool.dia * (tp.mode === 'rough' ? 0.4 : 0.1));
  const kr = Math.ceil(tool.dia / 2 / hm.cell);
  const kernel = [];
  for (let j = -kr; j <= kr; j++) for (let i = -kr; i <= kr; i++) {
    const f = toolProfile(tool, Math.hypot(i, j) * hm.cell);
    if (f < depth) kernel.push(i, j, f);
  }
  const { w, h, data } = hm;
  const drop = (ci, cj) => {
    let z = -depth;
    for (let k = 0; k < kernel.length; k += 3) {
      const i = ci + kernel[k], j = cj + kernel[k + 1];
      const v = i < 0 || j < 0 || i >= w || j >= h ? 0 : data[j * w + i];
      const t = -depth * (1 - v) - kernel[k + 2];
      if (t > z) z = t;
    }
    return Math.min(0, z + allow);
  };
  const alongX = (tp.angle || 0) % 180 === 0;
  const lines = [];
  const nRows = alongX ? h : w, nCols = alongX ? w : h;
  const every = Math.max(1, Math.round(step / hm.cell));
  let flip = false;
  for (let rI = 0; rI < nRows; rI += every) {
    const pts = [];
    for (let c = 0; c < nCols; c++) {
      const ci = alongX ? c : rI, cj = alongX ? rI : c;
      pts.push([hm.x0 + ci * hm.cell, hm.y0 + cj * hm.cell, drop(ci, cj)]);
    }
    // the hop to the next row happens at this row's far end: find the height that clears the rows it skips over
    const endC = flip ? 0 : nCols - 1;
    let hop = -depth;
    for (let r = rI; r <= Math.min(nRows - 1, rI + every); r++) hop = Math.max(hop, alongX ? drop(endC, r) : drop(r, endC));
    if (flip) pts.reverse();
    flip = !flip;
    const line = simplify3(pts, tp.mode === 'rough' ? 0.05 : 0.01);
    line.hop = hop;
    lines.push(line);
  }
  const paths = [];
  if (tp.mode === 'rough') {
    const levels = depthLevels(0, depth, tp.passDepth);
    for (const L of levels) for (const pts of lines) paths.push(...clampPasses(pts, [L], L === levels[0] ? 0 : levels[levels.indexOf(L) - 1]));
  } else {
    // one continuous back-and-forth pass; the short hop to the next row is made clear of the surface
    let run = null, prevLine = null;
    for (const pts of lines) {
      if (!run) run = [...pts];
      else {
        const a = run[run.length - 1], b = pts[0], z = Math.max(prevLine.hop, a[2], b[2]);
        run.push([a[0], a[1], z], [b[0], b[1], z], ...pts);
      }
      prevLine = pts;
    }
    if (run) paths.push({ pts: run });
  }
  return paths;
}

// ---------------------------------------------------------------- entry point
/**
 * tp: the toolpath settings. geom: { groups: [[{ pts, closed }]] (one list per shape), heightmap? }.
 * Returns { sections: [{ tool, paths: [{ pts: [[x, y, z, rapid?]], link? }] }], warnings }.
 */
export function computeToolpath(tp, geom) {
  const warnings = [];
  const warn = (m) => { if (!warnings.includes(m)) warnings.push(m); };
  const tool = tp.tool;
  const out = { sections: [], warnings };
  if (!tool || !(tool.dia > 0)) { warn('Choose a bit for this toolpath.'); return out; }
  const groups = geom.groups || [];
  const region = tp.type === 'drill' || tp.type === 'relief' ? [] : regionFrom(groups);
  const opens = [];
  for (const g of groups) for (const p of g) if (!p.closed && p.pts.length > 1) opens.push(p);
  const needsClosed = ['pocket', 'vcarve', 'chamfer', 'inlay', 'texture'].includes(tp.type) || (tp.type === 'profile' && tp.side !== 'on');
  if (needsClosed && !region.length) { warn(opens.length ? 'These lines are open. Close them (Modify → Close path or Auto-join) or use Engrave.' : 'Pick one or more shapes for this toolpath.'); return out; }
  if (['profile', 'engrave', 'pocket', 'drill', 'inlay'].includes(tp.type) && !(tp.depth > (tp.startDepth || 0))) { warn('The depth has to be more than the start depth.'); return out; }
  let paths = [];
  switch (tp.type) {
    case 'profile': paths = profileOp(region, opens, tp, tool, warn); break;
    case 'engrave': paths = profileOp(region, opens, { ...tp, side: 'on', tabs: null }, tool, warn); break;
    case 'pocket': paths = pocketOp(region, tp, tool, warn); break;
    case 'drill': paths = drillOp(groups, tp); break;
    case 'chamfer': paths = chamferOp(region, tp, tool, warn); break;
    case 'inlay': paths = inlayOp(region, tp, tool, warn); break;
    case 'texture': paths = textureOp(region, tp, tool); break;
    case 'relief':
      if (!geom.heightmap) { warn('Pick a picture (height map) for this toolpath. Create → Depth map makes one from a 3D model.'); return out; }
      paths = reliefOp(geom.heightmap, tp, tool);
      break;
    case 'vcarve':
      if (tool.type !== 'vbit') { warn('V-carving needs a V-bit.'); return out; }
      out.sections = vcarveOp(region, tp, tool, tp.clearTool || null, warn).filter((s) => s.paths.length);
      return out;
    default: warn('Unknown toolpath type.');
  }
  paths = paths.filter((p) => p.pts && p.pts.length);
  if (paths.length) out.sections.push({ tool, paths });
  return out;
}

export const _test = { ringsOf, contourPasses, hatch, signedArea, vcarveRings, clampPasses, addDogbones, startNear };
