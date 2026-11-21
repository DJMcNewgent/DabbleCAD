// Mesh analysis: inspection and repair, thickness, overhangs and supports, stability,
// print orientation, clearance and deviation between two meshes.
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import {
  edgeTable, boundaryLoops, shellIds, signedVolume, surfaceArea, meshBounds, indexedGeo, closeCracks, removeBadTriangles,
  orientConsistent, fillHoles, subMesh, vertexNormals, vertexNeighbors, solidToMesh,
} from './meshops.js';
import { kernel } from './solid.js';

const triNormal = (M, i, out) => {
  const v = M.v, a = M.t[i * 3] * 3, b = M.t[i * 3 + 1] * 3, c = M.t[i * 3 + 2] * 3;
  const ux = v[b] - v[a], uy = v[b + 1] - v[a + 1], uz = v[b + 2] - v[a + 2], wx = v[c] - v[a], wy = v[c + 1] - v[a + 1], wz = v[c + 2] - v[a + 2];
  out[0] = uy * wz - uz * wy; out[1] = uz * wx - ux * wz; out[2] = ux * wy - uy * wx;
  return out;
};

/** What is wrong (and right) with a mesh: holes, bad edges, loose pieces, and its measurements. */
export function inspectMesh(M) {
  const table = edgeTable(M), nv = M.v.length / 3, nt = M.t.length / 3;
  let boundaryEdges = 0, nonManifoldEdges = 0, degenerate = 0;
  for (let e = 0; e < table.count; e++) { if (table.cnt[e] === 1) boundaryEdges += 1; else if (table.cnt[e] > 2) nonManifoldEdges += 1; }
  const n = [0, 0, 0];
  for (let i = 0; i < nt; i++) if (Math.hypot(...triNormal(M, i, n)) < 1e-12) degenerate += 1;
  const holes = boundaryLoops(M, table).map((loop) => {
    const c = [0, 0, 0];
    for (const p of loop) for (let k = 0; k < 3; k++) c[k] += M.v[p * 3 + k] / loop.length;
    let r = 0;
    for (const p of loop) r = Math.max(r, Math.hypot(M.v[p * 3] - c[0], M.v[p * 3 + 1] - c[1], M.v[p * 3 + 2] - c[2]));
    return { center: c, radius: r, edges: loop.length };
  });
  const sh = shellIds(M, table);
  const shellTris = new Uint32Array(sh.count);
  for (let i = 0; i < nt; i++) shellTris[sh.id[i]] += 1;
  let smallShells = 0;
  for (let s = 0; s < sh.count; s++) if (sh.count > 1 && shellTris[s] < Math.max(4, nt * 0.005)) smallShells += 1;
  const closed = nt > 0 && boundaryEdges === 0 && nonManifoldEdges === 0;
  const vol = signedVolume(M);
  // V - E + F = 2 (shells - handles) for closed surfaces
  const genus = closed ? Math.round(sh.count - (nv - table.count + nt) / 2) : null;
  const bb = meshBounds(M);
  return {
    vertices: nv, triangles: nt, edges: table.count, boundaryEdges, nonManifoldEdges, degenerate, holes, shells: sh.count, smallShells,
    closed, insideOut: closed && vol < 0, volume: Math.abs(vol), area: surfaceArea(M), genus, size: bb.size,
    problems: holes.length + nonManifoldEdges + degenerate + smallShells + (closed && vol < 0 ? 1 : 0),
  };
}

/** Fix everything inspectMesh() reports, in a safe order. Returns { mesh, log }. */
export function autoRepair(M, { fill = true, dropSmall = true } = {}) {
  const log = [];
  const bb = meshBounds(M), diag = Math.hypot(...bb.size) || 1;
  let cur = M;
  const cracks = closeCracks(cur, diag * 2e-5);
  if (cracks.merged) { cur = cracks.mesh; log.push(`welded ${cracks.merged} split vertices`); }
  const bad = removeBadTriangles(cur);
  if (bad.removed) { cur = bad.mesh; log.push(`removed ${bad.removed} bad triangles`); }
  if (dropSmall) {
    const sh = shellIds(cur);
    if (sh.count > 1) {
      const nt = cur.t.length / 3, size = new Uint32Array(sh.count);
      for (let i = 0; i < nt; i++) size[sh.id[i]] += 1;
      const keep = new Uint8Array(nt);
      let dropped = 0;
      for (let i = 0; i < nt; i++) keep[i] = size[sh.id[i]] >= Math.max(4, nt * 0.005) ? 1 : 0;
      for (let s = 0; s < sh.count; s++) if (size[s] < Math.max(4, nt * 0.005)) dropped += 1;
      if (dropped && dropped < sh.count) { cur = subMesh(cur, keep); log.push(`removed ${dropped} tiny loose piece${dropped > 1 ? 's' : ''}`); }
    }
  }
  // faces must agree on which side is out before holes are patched: a patch follows its rim
  const o = orientConsistent(cur);
  if (o.flipped) { cur = o.mesh; log.push(`turned ${o.flipped} triangles the right way out`); }
  if (fill) {
    const res = fillHoles(cur);
    if (res.filled) { cur = orientConsistent(res.mesh).mesh; log.push(`filled ${res.filled} hole${res.filled > 1 ? 's' : ''}`); }
  }
  return { mesh: cur, log };
}

function bvhOf(M) {
  const geo = indexedGeo(M);
  return { geo, bvh: new MeshBVH(geo) };
}

/** Wall thickness at every vertex: how far a ray travels inward before leaving the material. */
export function thicknessField(M, limit = Infinity) {
  const { bvh } = bvhOf(M);
  const nrm = vertexNormals(M), nv = M.v.length / 3, out = new Float32Array(nv);
  const ray = new THREE.Ray();
  let min = Infinity, minAt = -1;
  for (let i = 0; i < nv; i++) {
    const nx = nrm[i * 3], ny = nrm[i * 3 + 1], nz = nrm[i * 3 + 2];
    ray.origin.set(M.v[i * 3] - nx * 1e-3, M.v[i * 3 + 1] - ny * 1e-3, M.v[i * 3 + 2] - nz * 1e-3);
    ray.direction.set(-nx, -ny, -nz);
    const hit = bvh.raycastFirst(ray, THREE.DoubleSide);
    const d = hit ? hit.distance + 1e-3 : Infinity;
    out[i] = Math.min(d, limit);
    if (d < min) { min = d; minAt = i; }
  }
  return { values: out, min: isFinite(min) ? min : null, minAt };
}

/** Triangles that face down more steeply than a printer can bridge. angle = steepest printable overhang (degrees from vertical). */
export function overhangFaces(M, angle = 45) {
  const nt = M.t.length / 3, mask = new Uint8Array(nt), n = [0, 0, 0];
  const bb = meshBounds(M), limit = -Math.sin((angle * Math.PI) / 180);
  let area = 0;
  for (let i = 0; i < nt; i++) {
    triNormal(M, i, n);
    const len = Math.hypot(n[0], n[1], n[2]);
    if (len < 1e-12 || n[2] / len >= limit) continue;
    const z = (M.v[M.t[i * 3] * 3 + 2] + M.v[M.t[i * 3 + 1] * 3 + 2] + M.v[M.t[i * 3 + 2] * 3 + 2]) / 3;
    if (z < bb.min[2] + 0.15) continue; // resting on the plate
    mask[i] = 1; area += len / 2;
  }
  return { mask, area };
}

/**
 * Support posts under every overhang: a thin tip touching the model, a post, and a foot on
 * the plate (or on the model below). Returns a mesh, or null when nothing needs support.
 */
export function buildSupports(M, { angle = 45, spacing = 5, tip = 0.6, post = 1.6, base = 5 } = {}) {
  const api = kernel();
  if (!api) throw new Error('The solid kernel did not load, so supports cannot be built');
  const { mask } = overhangFaces(M, angle);
  const { bvh } = bvhOf(M);
  const bb = meshBounds(M), plate = bb.min[2], v = M.v, t = M.t;
  const points = [], seen = new Set();
  const add = (x, y, z) => {
    if (z < plate + 0.4) return;
    const key = Math.round(x / (spacing * 0.5)) + ',' + Math.round(y / (spacing * 0.5)) + ',' + Math.round(z / 1.5);
    if (seen.has(key)) return;
    seen.add(key); points.push([x, y, z]);
  };
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const a = t[i * 3] * 3, b = t[i * 3 + 1] * 3, c = t[i * 3 + 2] * 3;
    const x0 = Math.min(v[a], v[b], v[c]), x1 = Math.max(v[a], v[b], v[c]), y0 = Math.min(v[a + 1], v[b + 1], v[c + 1]), y1 = Math.max(v[a + 1], v[b + 1], v[c + 1]);
    const den = (v[b + 1] - v[c + 1]) * (v[a] - v[c]) + (v[c] - v[b]) * (v[a + 1] - v[c + 1]);
    if (Math.abs(den) < 1e-12) continue;
    for (let gx = Math.ceil(x0 / spacing) * spacing; gx <= x1; gx += spacing) {
      for (let gy = Math.ceil(y0 / spacing) * spacing; gy <= y1; gy += spacing) {
        const w0 = ((v[b + 1] - v[c + 1]) * (gx - v[c]) + (v[c] - v[b]) * (gy - v[c + 1])) / den;
        const w1 = ((v[c + 1] - v[a + 1]) * (gx - v[c]) + (v[a] - v[c]) * (gy - v[c + 1])) / den;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        add(gx, gy, w0 * v[a + 2] + w1 * v[b + 2] + w2 * v[c + 2]);
      }
    }
  }
  // the lowest point of every downward bump also needs holding up, however small it is
  const nb = vertexNeighbors(M), nrm = vertexNormals(M);
  for (let i = 0; i < v.length / 3; i++) {
    if (nrm[i * 3 + 2] > -0.5 || nb.start[i + 1] === nb.start[i]) continue;
    let lowest = true;
    for (let k = nb.start[i]; k < nb.start[i + 1]; k++) if (v[nb.list[k] * 3 + 2] < v[i * 3 + 2] - 1e-6) { lowest = false; break; }
    if (lowest) add(v[i * 3], v[i * 3 + 1], v[i * 3 + 2]);
  }
  if (!points.length) return null;
  if (points.length > 1500) throw new Error('That would need more than 1500 supports. Use a larger spacing.');
  const ray = new THREE.Ray(), made = [], parts = [];
  ray.direction.set(0, 0, -1);
  const rTip = tip / 2, rPost = post / 2;
  try {
    for (const [x, y, z] of points) {
      ray.origin.set(x, y, z - 0.05);
      const hit = bvh.raycastFirst(ray, THREE.DoubleSide);
      const floor = hit ? hit.point.z : plate;
      const h = z - floor;
      if (h < 0.6) continue;
      const tipLen = Math.min(2.5, h * 0.4);
      const cone = api.Manifold.cylinder(tipLen + 0.15, rPost, rTip, 10);
      const coneAt = cone.translate(x, y, z - tipLen);
      const shaft = api.Manifold.cylinder(h - tipLen + 0.01, rPost, rPost, 10);
      const shaftAt = shaft.translate(x, y, floor);
      made.push(cone, coneAt, shaft, shaftAt);
      parts.push(coneAt, shaftAt);
      if (!hit && base > post) {
        const foot = api.Manifold.cylinder(0.5, base / 2, rPost, 16);
        const footAt = foot.translate(x, y, floor);
        made.push(foot, footAt);
        parts.push(footAt);
      }
    }
    if (!parts.length) return null;
    const all = api.Manifold.union(parts);
    made.push(all);
    return { mesh: solidToMesh(all), count: points.length };
  } finally { for (const s of new Set(made)) { try { s.delete(); } catch { /* freed */ } } }
}

function hull2d(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

/** Will it stand up? Centre of mass against the outline of what touches the plate. */
export function stability(M) {
  const v = M.v, t = M.t;
  let vol = 0, cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i] * 3, b = t[i + 1] * 3, c = t[i + 2] * 3;
    const d = (v[a] * (v[b + 1] * v[c + 2] - v[b + 2] * v[c + 1]) - v[a + 1] * (v[b] * v[c + 2] - v[b + 2] * v[c]) + v[a + 2] * (v[b] * v[c + 1] - v[b + 1] * v[c])) / 6;
    vol += d;
    cx += d * (v[a] + v[b] + v[c]) / 4; cy += d * (v[a + 1] + v[b + 1] + v[c + 1]) / 4; cz += d * (v[a + 2] + v[b + 2] + v[c + 2]) / 4;
  }
  const bb = meshBounds(M);
  const com = Math.abs(vol) > 1e-9 ? [cx / vol, cy / vol, cz / vol] : bb.center.slice();
  const foot = [];
  for (let i = 0; i < v.length; i += 3) if (v[i + 2] < bb.min[2] + 0.2) foot.push([v[i], v[i + 1]]);
  const hull = hull2d(foot);
  // signed distance from the centre of mass to the nearest edge of the footprint (positive = inside)
  let margin = Infinity;
  if (hull.length >= 3) {
    for (let i = 0; i < hull.length; i++) {
      const p = hull[i], q = hull[(i + 1) % hull.length];
      const ex = q[0] - p[0], ey = q[1] - p[1], len = Math.hypot(ex, ey) || 1;
      margin = Math.min(margin, (ex * (com[1] - p[1]) - ey * (com[0] - p[0])) / len);
    }
  } else margin = -Math.hypot(com[0] - (foot[0] ? foot[0][0] : bb.center[0]), com[1] - (foot[0] ? foot[0][1] : bb.center[1]));
  let contact = 0;
  for (let i = 0; i < hull.length; i++) { const p = hull[i], q = hull[(i + 1) % hull.length]; contact += (p[0] * q[1] - q[0] * p[1]) / 2; }
  const height = com[2] - bb.min[2];
  return { volume: Math.abs(vol), area: surfaceArea(M), com, hull, margin, stable: margin > 0, contactArea: Math.abs(contact), tipAngle: margin > 0 ? (Math.atan2(margin, Math.max(height, 1e-6)) * 180) / Math.PI : 0, plate: bb.min[2] };
}

/**
 * Find the way up that prints best: least overhang, most contact with the plate, lowest height.
 * Returns { down: [x, y, z], overhang, contact, height, current } for the best direction.
 */
export function bestOrientation(M, { angle = 45 } = {}) {
  const nt = M.t.length / 3, v = M.v, t = M.t;
  const nrm = new Float32Array(nt * 3), area = new Float32Array(nt), n = [0, 0, 0];
  let total = 0;
  const bins = new Map();
  for (let i = 0; i < nt; i++) {
    triNormal(M, i, n);
    const len = Math.hypot(n[0], n[1], n[2]);
    if (len < 1e-12) continue;
    nrm[i * 3] = n[0] / len; nrm[i * 3 + 1] = n[1] / len; nrm[i * 3 + 2] = n[2] / len;
    area[i] = len / 2; total += area[i];
    const key = Math.round(nrm[i * 3] * 12) + ',' + Math.round(nrm[i * 3 + 1] * 12) + ',' + Math.round(nrm[i * 3 + 2] * 12);
    const bin = bins.get(key) || { a: 0, x: 0, y: 0, z: 0 };
    bin.a += area[i]; bin.x += nrm[i * 3] * area[i]; bin.y += nrm[i * 3 + 1] * area[i]; bin.z += nrm[i * 3 + 2] * area[i];
    bins.set(key, bin);
  }
  // candidates: the directions most of the surface faces, plus the six axes
  const cands = [[0, 0, -1], [0, 0, 1], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]];
  for (const b of [...bins.values()].sort((p, q) => q.a - p.a).slice(0, 24)) { const l = Math.hypot(b.x, b.y, b.z); if (l > 1e-9) cands.push([b.x / l, b.y / l, b.z / l]); }
  const limit = Math.sin((angle * Math.PI) / 180);
  const score = (d) => {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < v.length; i += 3) { const h = -(v[i] * d[0] + v[i + 1] * d[1] + v[i + 2] * d[2]); if (h < lo) lo = h; if (h > hi) hi = h; }
    let overhang = 0, contact = 0;
    for (let i = 0; i < nt; i++) {
      if (!area[i]) continue;
      const facing = nrm[i * 3] * d[0] + nrm[i * 3 + 1] * d[1] + nrm[i * 3 + 2] * d[2];
      if (facing <= limit) continue;
      const a = t[i * 3] * 3;
      const h = -(v[a] * d[0] + v[a + 1] * d[1] + v[a + 2] * d[2]);
      if (facing > 0.999 && h < lo + 0.15) contact += area[i]; else overhang += area[i];
    }
    const height = hi - lo;
    return { down: d, overhang, contact, height, cost: overhang - 0.5 * contact + 0.02 * height * Math.sqrt(total) };
  };
  const current = score([0, 0, -1]);
  let best = current;
  for (const d of cands) { const s = score(d); if (s.cost < best.cost - 1e-6) best = s; }
  return { ...best, current };
}

function sampleVerts(M, max) {
  const nv = M.v.length / 3, step = Math.max(1, Math.floor(nv / max)), out = [];
  for (let i = 0; i < nv; i += step) out.push(i);
  return out;
}

/** Smallest gap between two meshes (sampled at their vertices). */
export function clearance(A, B) {
  let best = { distance: Infinity, a: null, b: null };
  const p = new THREE.Vector3(), target = {};
  for (const [src, other, flip] of [[A, B, false], [B, A, true]]) {
    const { bvh } = bvhOf(other);
    for (const i of sampleVerts(src, 30000)) {
      p.set(src.v[i * 3], src.v[i * 3 + 1], src.v[i * 3 + 2]);
      const hit = bvh.closestPointToPoint(p, target, 0, best.distance);
      if (!hit || hit.distance >= best.distance) continue;
      const here = [p.x, p.y, p.z], there = [hit.point.x, hit.point.y, hit.point.z];
      best = { distance: hit.distance, a: flip ? there : here, b: flip ? here : there };
    }
  }
  return best;
}

/** How far apart two versions of a surface are: the largest and the average distance. */
export function deviation(A, B) {
  let max = 0, sum = 0, count = 0, at = null;
  const p = new THREE.Vector3(), target = {};
  for (const [src, other] of [[A, B], [B, A]]) {
    const { bvh } = bvhOf(other);
    for (const i of sampleVerts(src, 30000)) {
      p.set(src.v[i * 3], src.v[i * 3 + 1], src.v[i * 3 + 2]);
      const hit = bvh.closestPointToPoint(p, target);
      if (!hit) continue;
      sum += hit.distance; count += 1;
      if (hit.distance > max) { max = hit.distance; at = [p.x, p.y, p.z]; }
    }
  }
  return { max, mean: count ? sum / count : 0, at };
}

/** Blue (thin / near) through green to red (thick / far) for a 0..1 value. */
export function heatColor(f, out, o) {
  const x = Math.min(1, Math.max(0, f));
  const r = x < 0.5 ? 1 : 1 - (x - 0.5) * 2, g = x < 0.5 ? x * 2 : 1, b = x < 0.5 ? 0 : (x - 0.5) * 0.6;
  // stored linear, shown as red (low) -> yellow -> green (high)
  out[o] = r * r; out[o + 1] = g * g * 0.85; out[o + 2] = b * b;
}

/**
 * Arrange rectangles (footprints) in rows on a bed. items: [{ w, d }]. Returns positions of
 * the lower-left corners, or null when they do not all fit.
 */
export function packRows(items, bedW, bedD, gap = 3) {
  const order = items.map((it, i) => i).sort((a, b) => items[b].d - items[a].d);
  const pos = new Array(items.length);
  let x = 0, y = 0, row = 0, usedW = 0;
  for (const i of order) {
    const it = items[i];
    if (x > 0 && x + it.w > bedW + 1e-6) { x = 0; y += row + gap; row = 0; }
    pos[i] = [x, y];
    x += it.w + gap; row = Math.max(row, it.d); usedW = Math.max(usedW, x - gap);
  }
  const usedD = y + row;
  return { pos, width: usedW, depth: usedD, fits: usedW <= bedW + 1e-6 && usedD <= bedD + 1e-6 };
}
