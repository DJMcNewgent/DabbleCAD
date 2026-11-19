// Watertight solid modelling kernel (Manifold, WebAssembly). Booleans done here always
// produce a closed, printable mesh. Everything degrades gracefully: if the kernel cannot
// load, or an input is not a closed solid, callers fall back to the triangle-soup path.
import * as THREE from 'three';
import Module from 'manifold-3d';
import wasmUrl from 'manifold-3d/manifold.wasm?url';

let api = null;
let failed = null;

export async function initSolid() {
  if (api || failed) return !!api;
  try {
    const wasmBinary = await (await fetch(wasmUrl)).arrayBuffer();
    const m = await Module({ wasmBinary, locateFile: () => wasmUrl });
    if (m.setup) m.setup();
    api = m;
  } catch (err) {
    failed = err;
    console.warn('Solid kernel unavailable, using the fallback boolean engine', err);
  }
  return !!api;
}

export const solidReady = () => !!api;

/**
 * Non-indexed BufferGeometry (position + optional colour) -> Manifold, or null when the
 * triangles do not form a closed solid.
 */
export function toSolid(geo) {
  if (!api) return null;
  if (geo.index) geo = geo.toNonIndexed();
  const pos = geo.attributes.position, col = geo.attributes.color;
  const n = pos.count;
  if (n < 12) return null;
  const props = new Float32Array(n * 6);
  for (let i = 0; i < n; i++) {
    props[i * 6] = pos.getX(i); props[i * 6 + 1] = pos.getY(i); props[i * 6 + 2] = pos.getZ(i);
    if (col) { props[i * 6 + 3] = col.getX(i); props[i * 6 + 4] = col.getY(i); props[i * 6 + 5] = col.getZ(i); }
    else { props[i * 6 + 3] = props[i * 6 + 4] = props[i * 6 + 5] = 0.7; }
  }
  // drop zero-area triangles: they are harmless on screen but break the solid test
  const tri = [];
  for (let i = 0; i < n; i += 3) {
    const a = i * 6, b = a + 6, c = a + 12;
    const same = (p, q) => props[p] === props[q] && props[p + 1] === props[q + 1] && props[p + 2] === props[q + 2];
    if (same(a, b) || same(b, c) || same(a, c)) continue;
    tri.push(i, i + 1, i + 2);
  }
  let mesh = null;
  try {
    mesh = new api.Mesh({ numProp: 6, vertProperties: props, triVerts: Uint32Array.from(tri) });
    mesh.merge();
    const solid = new api.Manifold(mesh);
    if (solid.isEmpty() || solid.status() !== 'NoError') { solid.delete(); return null; }
    return solid;
  } catch {
    return null;
  }
}

/** Manifold -> non-indexed BufferGeometry with position and colour (no normals). */
export function fromSolid(solid) {
  const mesh = solid.getMesh();
  const np = mesh.numProp, vp = mesh.vertProperties, tv = mesh.triVerts;
  const n = tv.length;
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const v = tv[i] * np;
    pos[i * 3] = vp[v]; pos[i * 3 + 1] = vp[v + 1]; pos[i * 3 + 2] = vp[v + 2];
    if (np >= 6) { col[i * 3] = vp[v + 3]; col[i * 3 + 1] = vp[v + 4]; col[i * 3 + 2] = vp[v + 5]; }
    else { col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = 0.7; }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

const free = (list) => { for (const s of list) { try { s.delete(); } catch { /* already freed */ } } };

/**
 * Boolean of baked operands. `mode` is 'union' or 'intersect'; holes are always removed.
 * Returns a geometry, or null if any operand is not a closed solid.
 */
export function solidBoolean(solids, holes, mode) {
  if (!api) return null;
  const made = [];
  try {
    const S = [], H = [];
    for (const g of solids) { const s = toSolid(g); if (!s) return null; made.push(s); S.push(s); }
    for (const g of holes) { const s = toSolid(g); if (!s) return null; made.push(s); H.push(s); }
    let result;
    if (!S.length) {
      result = H.length === 1 ? H[0] : api.Manifold.union(H);
    } else {
      result = S.length === 1 ? S[0] : (mode === 'intersect' ? api.Manifold.intersection(S) : api.Manifold.union(S));
      if (result !== S[0]) made.push(result);
      if (H.length) {
        const cut = H.length === 1 ? H[0] : api.Manifold.union(H);
        if (cut !== H[0]) made.push(cut);
        result = result.subtract(cut);
      }
    }
    if (!made.includes(result)) made.push(result);
    if (result.status() !== 'NoError') return null;
    return fromSolid(result);
  } catch (err) {
    console.warn('Solid boolean failed', err);
    return null;
  } finally {
    free(made);
  }
}

/** Topology report for a geometry: is it a closed solid, and how big is it? */
export function inspectSolid(geo) {
  const s = toSolid(geo);
  if (!s) return { closed: false };
  try {
    const parts = s.decompose();
    const info = { closed: true, volume: s.volume(), area: s.surfaceArea(), genus: s.genus(), parts: parts.length };
    free(parts);
    return info;
  } finally { s.delete(); }
}

/** Run `fn(api, solid)` on a geometry's solid; returns a geometry or null. */
export function withSolid(geo, fn) {
  const s = toSolid(geo);
  if (!s) return null;
  const extra = [];
  try {
    const r = fn(api, s, (x) => { extra.push(x); return x; });
    if (!r) return null;
    extra.push(r);
    return fromSolid(r);
  } catch (err) {
    console.warn('Solid operation failed', err);
    return null;
  } finally { s.delete(); free(extra); }
}

/** Kernel handle for modules that build solids directly (null until initSolid() succeeds). */
export const kernel = () => api;

/** Finish a solid built with the kernel: returns its geometry and frees it. */
export function finishSolid(solid, extra = []) {
  try { return solid.status() === 'NoError' && !solid.isEmpty() ? fromSolid(solid) : null; } finally { free([solid, ...extra]); }
}

/**
 * Extrude outlines with rounded-over top and bottom edges, as a guaranteed closed solid.
 * polys: [{ outer: [[x, y], ...], holes: [[[x, y], ...], ...] }]. Returns a geometry or null.
 */
export function bevelExtrude(polys, depth, bevel, segments = 2) {
  if (!api || !polys.length) return null;
  const made = [];
  const keep = (x) => { made.push(x); return x; };
  try {
    const { CrossSection, Manifold } = api;
    const base = keep(CrossSection.union(polys.map((p) => keep(new CrossSection([p.outer, ...(p.holes || [])], 'EvenOdd')))));
    const b = Math.min(bevel, depth / 2 - 0.01);
    const slabs = [];
    const EPS = 1e-3;
    if (b > 0.005) {
      const k = Math.max(2, Math.round(segments) + 2);
      const h = b / k;
      for (let i = 0; i < k; i++) {
        const t = (i + 0.5) / k;
        const inset = b * (1 - Math.sin((t * Math.PI) / 2));
        const cs = keep(base.offset(-inset, 'Miter', 2));
        if (cs.isEmpty()) continue;
        // each slab reaches a hair into its inner neighbour so the stack fuses into one solid
        slabs.push(keep(keep(Manifold.extrude(cs, h + EPS)).translate(0, 0, i * h)));
        slabs.push(keep(keep(Manifold.extrude(cs, h + EPS)).translate(0, 0, depth - (i + 1) * h - EPS)));
      }
      slabs.push(keep(keep(Manifold.extrude(base, depth - 2 * b)).translate(0, 0, b)));
    } else {
      slabs.push(keep(Manifold.extrude(base, depth)));
    }
    const out = keep(slabs.length === 1 ? slabs[0] : Manifold.union(slabs));
    return out.status() === 'NoError' && !out.isEmpty() ? fromSolid(out) : null;
  } catch (err) {
    console.warn('Solid bevel failed', err);
    return null;
  } finally { free([...new Set(made)]); }
}

const signedArea = (pts) => { let a = 0; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1]; return a / 2; };
const pointInPoly = (pt, poly) => {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a[1] > pt[1]) !== (b[1] > pt[1]) && pt[0] < ((b[0] - a[0]) * (pt[1] - a[1])) / (b[1] - a[1]) + a[0]) hit = !hit;
  }
  return hit;
};

/**
 * 2D boolean: the union of `adds` minus the union of `cuts` (each a list of [x, y] points).
 * Returns [{ outer, holes }] or null when the kernel is unavailable.
 */
export function regionPolys(adds, cuts = []) {
  if (!api) return null;
  const made = [];
  const keep = (x) => { made.push(x); return x; };
  try {
    const { CrossSection } = api;
    const one = (pts) => keep(new CrossSection([pts], 'NonZero'));
    const fix = (pts) => (signedArea(pts) < 0 ? [...pts].reverse() : pts);
    let region = keep(CrossSection.union(adds.map((p) => one(fix(p)))));
    if (cuts.length) region = keep(region.subtract(keep(CrossSection.union(cuts.map((p) => one(fix(p)))))));
    const loops = region.toPolygons().map((loop) => loop.map((p) => [p[0], p[1]]));
    const outers = loops.filter((l) => signedArea(l) > 0).map((outer) => ({ outer, holes: [] }));
    for (const hole of loops.filter((l) => signedArea(l) < 0)) {
      const owner = outers.find((o) => pointInPoly(hole[0], o.outer));
      if (owner) owner.holes.push(hole);
    }
    return outers;
  } catch (err) {
    console.warn('Region boolean failed', err);
    return null;
  } finally { free([...new Set(made)]); }
}
