// Mesh tools: clean-up, remeshing, cutting, solidifying and pattern operations on triangle meshes.
// Everything here works on a welded mesh M = { v, t, c, g }:
//   v  Float32Array  vertex positions (xyz)
//   t  Uint32Array   triangles (three vertex indices each)
//   c  Float32Array  optional vertex colours (linear rgb)
//   g  Int32Array    optional face group per triangle
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { bakedWorldGeometry } from './geometry.js';
import { toSolid, fromSolid, kernel } from './solid.js';
import { uid, ownColors } from './doc.js';

// ------------------------------------------------------------------ conversion
function welder(count, eps) {
  let size = 16;
  while (size < count * 2) size <<= 1;
  const table = new Int32Array(size).fill(-1), mask = size - 1, inv = 1 / eps;
  const qx = new Float64Array(count), qy = new Float64Array(count), qz = new Float64Array(count);
  let used = 0;
  return {
    add(x, y, z) {
      const a = Math.round(x * inv), b = Math.round(y * inv), c = Math.round(z * inv);
      let h = (Math.imul(a | 0, 73856093) ^ Math.imul(b | 0, 19349663) ^ Math.imul(c | 0, 83492791)) & mask;
      for (;;) {
        const j = table[h];
        if (j < 0) { table[h] = used; qx[used] = a; qy[used] = b; qz[used] = c; return used++; }
        if (qx[j] === a && qy[j] === b && qz[j] === c) return j;
        h = (h + 1) & mask;
      }
    },
  };
}

/** Triangle soup (9 numbers per triangle) -> welded mesh. Collapsed triangles are dropped. */
export function soupToMesh(positions, colors = null, groups = null, eps = 1e-5) {
  const n = Math.floor(positions.length / 9) * 3;
  const w = welder(n, eps);
  const remap = new Uint32Array(n);
  const first = [];
  for (let i = 0; i < n; i++) {
    const j = w.add(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
    if (j === first.length) first.push(i);
    remap[i] = j;
  }
  const nv = first.length;
  const v = new Float32Array(nv * 3), c = colors ? new Float32Array(nv * 3) : null;
  for (let j = 0; j < nv; j++) {
    const i = first[j] * 3;
    v[j * 3] = positions[i]; v[j * 3 + 1] = positions[i + 1]; v[j * 3 + 2] = positions[i + 2];
    if (c) { c[j * 3] = colors[i]; c[j * 3 + 1] = colors[i + 1]; c[j * 3 + 2] = colors[i + 2]; }
  }
  const useGroups = groups && groups.length === n / 3;
  const t = new Uint32Array(n), g = useGroups ? new Int32Array(n / 3) : null;
  let o = 0;
  for (let i = 0; i < n; i += 3) {
    const a = remap[i], b = remap[i + 1], d = remap[i + 2];
    if (a === b || b === d || a === d) continue;
    t[o * 3] = a; t[o * 3 + 1] = b; t[o * 3 + 2] = d;
    if (g) g[o] = groups[i / 3];
    o += 1;
  }
  return { v, t: t.slice(0, o * 3), c, g: g ? g.slice(0, o) : null };
}

/** Welded mesh -> soup arrays as stored in a mesh shape. */
export function meshToSoup(M) {
  const n = M.t.length;
  const positions = new Float32Array(n * 3), colors = M.c ? new Float32Array(n * 3) : null;
  for (let i = 0; i < n; i++) {
    const j = M.t[i] * 3;
    positions[i * 3] = M.v[j]; positions[i * 3 + 1] = M.v[j + 1]; positions[i * 3 + 2] = M.v[j + 2];
    if (colors) { colors[i * 3] = M.c[j]; colors[i * 3 + 1] = M.c[j + 1]; colors[i * 3 + 2] = M.c[j + 2]; }
  }
  return { positions, colors, groups: M.g ? Int32Array.from(M.g) : null };
}

/** World-space welded mesh of any node (shape, group or imported mesh). */
export function nodeToMesh(node, eps = 1e-5) {
  const geo = bakedWorldGeometry(node, false);
  const col = ownColors(node) && geo.attributes.color ? geo.attributes.color.array : null;
  const pos = geo.attributes.position.array;
  const groups = node.kind === 'mesh' && node.params.mesh.groups && node.params.mesh.groups.length === pos.length / 9 ? node.params.mesh.groups : null;
  return soupToMesh(pos, col, groups, eps);
}

export function meshBounds(M) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < M.v.length; i += 3) for (let k = 0; k < 3; k++) { const x = M.v[i + k]; if (x < min[k]) min[k] = x; if (x > max[k]) max[k] = x; }
  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]], center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2] };
}

/** A mesh shape node holding M, taking name, colour and flags from `base`. */
export function meshNode(M, base = {}, { smooth = false, name, keepId = false } = {}) {
  const { positions, colors, groups } = meshToSoup(M);
  const bb = meshBounds(M);
  const ok = isFinite(bb.min[0]);
  const mesh = { id: uid('m'), positions };
  if (colors) mesh.colors = colors;
  if (groups) mesh.groups = groups;
  if (smooth || (base.params && base.params.mesh && base.params.mesh.smooth)) mesh.smooth = true;
  const node = {
    id: keepId && base.id ? base.id : uid(), type: 'shape', kind: 'mesh', name: name || base.name || 'Mesh', params: { mesh },
    color: base.color || '#90a4ae', hole: !!base.hole, transparent: !!base.transparent, locked: false, hidden: false,
    matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, ok ? bb.center[0] : 0, ok ? bb.center[1] : 0, ok ? bb.min[2] : 0, 1],
  };
  if (base.shader) node.shader = base.shader;
  return node;
}

export function meshToGeo(M) {
  const { positions, colors } = meshToSoup(M);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  if (colors) g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}

/** Indexed geometry sharing M's arrays (the index is copied because a BVH reorders it). */
export function indexedGeo(M, copyIndex = true) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(M.v, 3));
  g.setIndex(new THREE.BufferAttribute(copyIndex ? Uint32Array.from(M.t) : M.t, 1));
  return g;
}

export const meshToSolid = (M) => toSolid(meshToGeo(M));

export function solidToMesh(solid, withColor = false) {
  const geo = fromSolid(solid);
  return soupToMesh(geo.attributes.position.array, withColor ? geo.attributes.color.array : null);
}

const free = (list) => { for (const s of list) { try { s.delete(); } catch { /* already freed */ } } };
function needKernel() {
  const api = kernel();
  if (!api) throw new Error('The solid kernel did not load, so this tool is unavailable');
  return api;
}

export const cloneMesh = (M) => ({ v: Float32Array.from(M.v), t: Uint32Array.from(M.t), c: M.c ? Float32Array.from(M.c) : null, g: M.g ? Int32Array.from(M.g) : null });

// ------------------------------------------------------------------ topology
/** Unique edges with the triangles on each side. `te` gives the edge of each triangle side. */
export function edgeTable(M) {
  const nv = M.v.length / 3, t = M.t, nt = t.length / 3;
  const map = new Map();
  const ea = [], eb = [], ta = [], tb = [], cnt = [];
  const te = new Int32Array(nt * 3);
  for (let i = 0; i < nt; i++) {
    for (let k = 0; k < 3; k++) {
      const a = t[i * 3 + k], b = t[i * 3 + (k + 1) % 3];
      const key = a < b ? a * nv + b : b * nv + a;
      let e = map.get(key);
      if (e === undefined) { e = ea.length; map.set(key, e); ea.push(Math.min(a, b)); eb.push(Math.max(a, b)); ta.push(i); tb.push(-1); cnt.push(1); }
      else { if (cnt[e] === 1) tb[e] = i; cnt[e] += 1; }
      te[i * 3 + k] = e;
    }
  }
  return { map, ea, eb, ta, tb, cnt, te, count: ea.length };
}

/** Vertex -> neighbouring vertices, as compressed rows. */
export function vertexNeighbors(M, table = edgeTable(M)) {
  const nv = M.v.length / 3;
  const start = new Uint32Array(nv + 1);
  for (let e = 0; e < table.count; e++) { start[table.ea[e] + 1] += 1; start[table.eb[e] + 1] += 1; }
  for (let i = 0; i < nv; i++) start[i + 1] += start[i];
  const fill = Uint32Array.from(start.subarray(0, nv)), list = new Uint32Array(table.count * 2);
  for (let e = 0; e < table.count; e++) { list[fill[table.ea[e]]++] = table.eb[e]; list[fill[table.eb[e]]++] = table.ea[e]; }
  return { start, list };
}

/** Vertex -> triangles, as compressed rows. */
export function vertexTriangles(M) {
  const nv = M.v.length / 3, t = M.t;
  const start = new Uint32Array(nv + 1);
  for (let i = 0; i < t.length; i++) start[t[i] + 1] += 1;
  for (let i = 0; i < nv; i++) start[i + 1] += start[i];
  const fill = Uint32Array.from(start.subarray(0, nv)), list = new Uint32Array(t.length);
  for (let i = 0; i < t.length; i++) list[fill[t[i]]++] = (i / 3) | 0;
  return { start, list };
}

export function boundaryVertexMask(M, table = edgeTable(M)) {
  const mask = new Uint8Array(M.v.length / 3);
  for (let e = 0; e < table.count; e++) if (table.cnt[e] === 1) { mask[table.ea[e]] = 1; mask[table.eb[e]] = 1; }
  return mask;
}

/** Open boundaries as loops of vertex indices, following the direction of the triangles beside them. */
export function boundaryLoops(M, table = edgeTable(M)) {
  const t = M.t, next = new Map();
  for (let i = 0; i < t.length / 3; i++) {
    for (let k = 0; k < 3; k++) {
      if (table.cnt[table.te[i * 3 + k]] !== 1) continue;
      const a = t[i * 3 + k], b = t[i * 3 + (k + 1) % 3];
      const list = next.get(a);
      if (list) list.push(b); else next.set(a, [b]);
    }
  }
  const loops = [];
  for (const [startV, outs] of next) {
    while (outs.length) {
      const loop = [startV];
      let cur = outs.pop(), guard = 0;
      while (cur !== startV && guard++ < 1e7) {
        loop.push(cur);
        const o = next.get(cur);
        if (!o || !o.length) { loop.length = 0; break; }
        cur = o.pop();
      }
      if (loop.length >= 3) loops.push(loop);
    }
  }
  return loops;
}

/** Shell (connected piece) of every triangle. Returns { id: Int32Array, count }. */
export function shellIds(M, table = edgeTable(M)) {
  const nt = M.t.length / 3, id = new Int32Array(nt).fill(-1);
  let count = 0;
  const stack = [];
  for (let s = 0; s < nt; s++) {
    if (id[s] >= 0) continue;
    id[s] = count; stack.push(s);
    while (stack.length) {
      const i = stack.pop();
      for (let k = 0; k < 3; k++) {
        const e = table.te[i * 3 + k];
        for (const j of [table.ta[e], table.tb[e]]) if (j >= 0 && id[j] < 0) { id[j] = count; stack.push(j); }
      }
    }
    count += 1;
  }
  return { id, count };
}

/** Keep the triangles where keep[i] is set; unused vertices are dropped. */
export function subMesh(M, keep) {
  const nv = M.v.length / 3, nt = M.t.length / 3;
  const remap = new Int32Array(nv).fill(-1);
  const t = [], g = M.g ? [] : null;
  let used = 0;
  for (let i = 0; i < nt; i++) {
    if (!keep[i]) continue;
    for (let k = 0; k < 3; k++) { const a = M.t[i * 3 + k]; if (remap[a] < 0) remap[a] = used++; t.push(remap[a]); }
    if (g) g.push(M.g[i]);
  }
  const v = new Float32Array(used * 3), c = M.c ? new Float32Array(used * 3) : null;
  for (let a = 0; a < nv; a++) {
    const j = remap[a];
    if (j < 0) continue;
    v[j * 3] = M.v[a * 3]; v[j * 3 + 1] = M.v[a * 3 + 1]; v[j * 3 + 2] = M.v[a * 3 + 2];
    if (c) { c[j * 3] = M.c[a * 3]; c[j * 3 + 1] = M.c[a * 3 + 1]; c[j * 3 + 2] = M.c[a * 3 + 2]; }
  }
  return { v, t: Uint32Array.from(t), c, g: g ? Int32Array.from(g) : null };
}

export const compact = (M) => subMesh(M, new Uint8Array(M.t.length / 3).fill(1));

export function separateShells(M) {
  const { id, count } = shellIds(M);
  if (count < 2) return [M];
  const out = [];
  for (let s = 0; s < count; s++) { const keep = new Uint8Array(id.length); for (let i = 0; i < id.length; i++) if (id[i] === s) keep[i] = 1; out.push(subMesh(M, keep)); }
  return out;
}

export function mergeMeshes(list) {
  let nv = 0, nt = 0;
  const colored = list.some((m) => m.c);
  for (const m of list) { nv += m.v.length / 3; nt += m.t.length / 3; }
  const v = new Float32Array(nv * 3), t = new Uint32Array(nt * 3), c = colored ? new Float32Array(nv * 3).fill(0.7) : null;
  let vo = 0, to = 0;
  for (const m of list) {
    v.set(m.v, vo * 3);
    if (c && m.c) c.set(m.c, vo * 3);
    for (let i = 0; i < m.t.length; i++) t[to + i] = m.t[i] + vo;
    vo += m.v.length / 3; to += m.t.length;
  }
  return { v, t, c, g: null };
}

export function flipNormals(M, mask = null) {
  const t = Uint32Array.from(M.t);
  for (let i = 0; i < t.length / 3; i++) if (!mask || mask[i]) { const x = t[i * 3 + 1]; t[i * 3 + 1] = t[i * 3 + 2]; t[i * 3 + 2] = x; }
  return { ...M, t };
}

export function signedVolume(M) {
  const v = M.v, t = M.t;
  let vol = 0;
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i] * 3, b = t[i + 1] * 3, c = t[i + 2] * 3;
    vol += v[a] * (v[b + 1] * v[c + 2] - v[b + 2] * v[c + 1]) - v[a + 1] * (v[b] * v[c + 2] - v[b + 2] * v[c]) + v[a + 2] * (v[b] * v[c + 1] - v[b + 1] * v[c]);
  }
  return vol / 6;
}

export function surfaceArea(M) {
  const v = M.v, t = M.t;
  let area = 0;
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i] * 3, b = t[i + 1] * 3, c = t[i + 2] * 3;
    const ux = v[b] - v[a], uy = v[b + 1] - v[a + 1], uz = v[b + 2] - v[a + 2], wx = v[c] - v[a], wy = v[c + 1] - v[a + 1], wz = v[c + 2] - v[a + 2];
    area += Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx) / 2;
  }
  return area;
}

/** Make neighbouring triangles agree on which side is out, then turn inside-out shells around. */
export function orientConsistent(M) {
  const table = edgeTable(M), t = Uint32Array.from(M.t), nt = t.length / 3;
  const seen = new Uint8Array(nt), shell = new Int32Array(nt);
  let shells = 0, flipped = 0;
  const has = (i, a, b) => { for (let k = 0; k < 3; k++) if (t[i * 3 + k] === a && t[i * 3 + (k + 1) % 3] === b) return true; return false; };
  const stack = [];
  for (let s = 0; s < nt; s++) {
    if (seen[s]) continue;
    seen[s] = 1; shell[s] = shells; stack.push(s);
    while (stack.length) {
      const i = stack.pop();
      for (let k = 0; k < 3; k++) {
        const e = table.te[i * 3 + k];
        if (table.cnt[e] !== 2) continue;
        const j = table.ta[e] === i ? table.tb[e] : table.ta[e];
        if (j < 0 || seen[j]) continue;
        // a well-oriented neighbour runs along the shared edge in the opposite direction
        // (the edge is looked up by its vertices: a flipped triangle's sides no longer match `te`)
        const a = table.ea[e], b = table.eb[e];
        if (has(i, a, b) === has(j, a, b)) { const x = t[j * 3 + 1]; t[j * 3 + 1] = t[j * 3 + 2]; t[j * 3 + 2] = x; flipped += 1; }
        seen[j] = 1; shell[j] = shells; stack.push(j);
      }
    }
    shells += 1;
  }
  const out = { ...M, t };
  const vol = new Float64Array(shells), v = M.v;
  for (let i = 0; i < nt; i++) {
    const a = t[i * 3] * 3, b = t[i * 3 + 1] * 3, c = t[i * 3 + 2] * 3;
    vol[shell[i]] += v[a] * (v[b + 1] * v[c + 2] - v[b + 2] * v[c + 1]) - v[a + 1] * (v[b] * v[c + 2] - v[b + 2] * v[c]) + v[a + 2] * (v[b] * v[c + 1] - v[b + 1] * v[c]);
  }
  for (let i = 0; i < nt; i++) if (vol[shell[i]] < 0) { const x = t[i * 3 + 1]; t[i * 3 + 1] = t[i * 3 + 2]; t[i * 3 + 2] = x; flipped += 1; }
  return { mesh: out, flipped };
}

export function vertexNormals(M, out = new Float32Array(M.v.length)) {
  const v = M.v, t = M.t;
  out.fill(0);
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i] * 3, b = t[i + 1] * 3, c = t[i + 2] * 3;
    const ux = v[b] - v[a], uy = v[b + 1] - v[a + 1], uz = v[b + 2] - v[a + 2], wx = v[c] - v[a], wy = v[c + 1] - v[a + 1], wz = v[c + 2] - v[a + 2];
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    out[a] += nx; out[a + 1] += ny; out[a + 2] += nz; out[b] += nx; out[b + 1] += ny; out[b + 2] += nz; out[c] += nx; out[c + 1] += ny; out[c + 2] += nz;
  }
  for (let i = 0; i < out.length; i += 3) { const l = Math.hypot(out[i], out[i + 1], out[i + 2]) || 1; out[i] /= l; out[i + 1] /= l; out[i + 2] /= l; }
  return out;
}

// ------------------------------------------------------------------ smoothing and subdivision
/**
 * Relax vertices toward the average of their neighbours. With `keepVolume` every other pass
 * pushes back out, so the shape does not shrink. `mask` limits it to some vertices.
 */
export function smooth(M, { iterations = 5, strength = 0.5, mask = null, keepVolume = true, lockBoundary = true } = {}) {
  const table = edgeTable(M), nb = vertexNeighbors(M, table);
  const nv = M.v.length / 3, v = Float32Array.from(M.v), tmp = new Float32Array(v.length);
  const fixed = lockBoundary ? boundaryVertexMask(M, table) : new Uint8Array(nv);
  const passes = keepVolume ? iterations * 2 : iterations;
  for (let it = 0; it < passes; it++) {
    const f = keepVolume && it % 2 ? -(strength + 0.03) : strength;
    for (let i = 0; i < nv; i++) {
      const s = nb.start[i], e = nb.start[i + 1];
      if (e === s || fixed[i] || (mask && !mask[i])) { tmp[i * 3] = v[i * 3]; tmp[i * 3 + 1] = v[i * 3 + 1]; tmp[i * 3 + 2] = v[i * 3 + 2]; continue; }
      let x = 0, y = 0, z = 0;
      for (let k = s; k < e; k++) { const j = nb.list[k] * 3; x += v[j]; y += v[j + 1]; z += v[j + 2]; }
      const n = e - s;
      tmp[i * 3] = v[i * 3] + (x / n - v[i * 3]) * f; tmp[i * 3 + 1] = v[i * 3 + 1] + (y / n - v[i * 3 + 1]) * f; tmp[i * 3 + 2] = v[i * 3 + 2] + (z / n - v[i * 3 + 2]) * f;
    }
    v.set(tmp);
  }
  return { ...M, v };
}

/** Split the flagged edges at their midpoints. Returns { mesh, origin } (origin = source triangle of each new one). */
function splitEdges(M, table, flag) {
  const v = Array.from(M.v), c = M.c ? Array.from(M.c) : null;
  const mid = new Int32Array(table.count).fill(-1);
  for (let e = 0; e < table.count; e++) {
    if (!flag[e]) continue;
    const a = table.ea[e] * 3, b = table.eb[e] * 3;
    mid[e] = v.length / 3;
    v.push((M.v[a] + M.v[b]) / 2, (M.v[a + 1] + M.v[b + 1]) / 2, (M.v[a + 2] + M.v[b + 2]) / 2);
    if (c) c.push((M.c[a] + M.c[b]) / 2, (M.c[a + 1] + M.c[b + 1]) / 2, (M.c[a + 2] + M.c[b + 2]) / 2);
  }
  const t = [], origin = [], src = M.t;
  const tri = (i, a, b, d) => { t.push(a, b, d); origin.push(i); };
  for (let i = 0; i < src.length / 3; i++) {
    const p = [src[i * 3], src[i * 3 + 1], src[i * 3 + 2]];
    const m = [mid[table.te[i * 3]], mid[table.te[i * 3 + 1]], mid[table.te[i * 3 + 2]]];
    const n = (m[0] >= 0) + (m[1] >= 0) + (m[2] >= 0);
    if (n === 0) tri(i, p[0], p[1], p[2]);
    else if (n === 3) { tri(i, p[0], m[0], m[2]); tri(i, m[0], p[1], m[1]); tri(i, m[2], m[1], p[2]); tri(i, m[0], m[1], m[2]); }
    else if (n === 1) {
      const k = m[0] >= 0 ? 0 : m[1] >= 0 ? 1 : 2;
      const a = p[k], b = p[(k + 1) % 3], d = p[(k + 2) % 3];
      tri(i, a, m[k], d); tri(i, m[k], b, d);
    } else {
      const k = m[0] < 0 ? 1 : m[1] < 0 ? 2 : 0; // side k and k + 1 are split, side k + 2 is whole
      const a = p[k], b = p[(k + 1) % 3], d = p[(k + 2) % 3], mab = m[k], mbd = m[(k + 1) % 3];
      tri(i, mab, b, mbd); tri(i, a, mab, mbd); tri(i, a, mbd, d);
    }
  }
  const g = M.g ? Int32Array.from(origin, (o) => M.g[o]) : null;
  return { mesh: { v: Float32Array.from(v), t: Uint32Array.from(t), c: c ? Float32Array.from(c) : null, g }, origin: Int32Array.from(origin) };
}

/** Split every chosen triangle into four (its neighbours are split to match). */
export function subdivide(M, mask = null) {
  const table = edgeTable(M), flag = new Uint8Array(table.count);
  for (let i = 0; i < M.t.length / 3; i++) if (!mask || mask[i]) for (let k = 0; k < 3; k++) flag[table.te[i * 3 + k]] = 1;
  return splitEdges(M, table, flag);
}

const edgeLength = (v, a, b) => Math.hypot(v[a * 3] - v[b * 3], v[a * 3 + 1] - v[b * 3 + 1], v[a * 3 + 2] - v[b * 3 + 2]);

/** Keep splitting edges longer than maxLen (inside `mask` when given). Returns { mesh, mask }. */
export function splitLongEdges(M, maxLen, mask = null, rounds = 6, limit = 1500000) {
  let cur = M, curMask = mask;
  for (let r = 0; r < rounds && cur.t.length / 3 < limit; r++) {
    const table = edgeTable(cur), flag = new Uint8Array(table.count);
    let any = false;
    for (let e = 0; e < table.count; e++) {
      if (edgeLength(cur.v, table.ea[e], table.eb[e]) <= maxLen) continue;
      if (curMask && !(curMask[table.ta[e]] || (table.tb[e] >= 0 && curMask[table.tb[e]]))) continue;
      flag[e] = 1; any = true;
    }
    if (!any) break;
    const res = splitEdges(cur, table, flag);
    if (curMask) { const old = curMask; curMask = Uint8Array.from(res.origin, (o) => old[o]); }
    cur = res.mesh;
  }
  return { mesh: cur, mask: curMask };
}

// ------------------------------------------------------------------ reduce (quadric edge collapse)
class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(x) {
    const a = this.a;
    let i = a.length;
    a.push(x);
    while (i > 0) { const p = (i - 1) >> 1; if (a[p].c <= x.c) break; a[i] = a[p]; i = p; }
    a[i] = x;
  }
  pop() {
    const a = this.a, top = a[0], x = a.pop();
    if (a.length) {
      let i = 0;
      for (;;) {
        let k = i * 2 + 1;
        if (k >= a.length) break;
        if (k + 1 < a.length && a[k + 1].c < a[k].c) k += 1;
        if (a[k].c >= x.c) break;
        a[i] = a[k]; i = k;
      }
      a[i] = x;
    }
    return top;
  }
}

/**
 * Remove triangles while keeping the shape, by collapsing the edges that change it least.
 * `shorterThan` only allows edges below that length (used by remeshing).
 */
export function decimate(M, targetTris, { shorterThan = 0, maxError = Infinity, lockBoundary = false } = {}) {
  const nv = M.v.length / 3, nt = M.t.length / 3;
  if (nt <= targetTris && !shorterThan) return M;
  const P = Float64Array.from(M.v), T = Uint32Array.from(M.t), C = M.c ? Float32Array.from(M.c) : null;
  const alive = new Uint8Array(nt).fill(1), gone = new Uint8Array(nv), ver = new Uint32Array(nv);
  let live = nt;
  const vt = new Array(nv);
  for (let i = 0; i < nv; i++) vt[i] = [];
  for (let i = 0; i < nt; i++) for (let k = 0; k < 3; k++) vt[T[i * 3 + k]].push(i);
  const Q = new Float64Array(nv * 10);
  const addPlane = (i, a, b, c, d, w) => {
    const q = i * 10;
    Q[q] += w * a * a; Q[q + 1] += w * a * b; Q[q + 2] += w * a * c; Q[q + 3] += w * a * d; Q[q + 4] += w * b * b;
    Q[q + 5] += w * b * c; Q[q + 6] += w * b * d; Q[q + 7] += w * c * c; Q[q + 8] += w * c * d; Q[q + 9] += w * d * d;
  };
  const normal = (i, out) => {
    const a = T[i * 3] * 3, b = T[i * 3 + 1] * 3, c = T[i * 3 + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], wx = P[c] - P[a], wy = P[c + 1] - P[a + 1], wz = P[c + 2] - P[a + 2];
    out[0] = uy * wz - uz * wy; out[1] = uz * wx - ux * wz; out[2] = ux * wy - uy * wx;
    return out;
  };
  const n = [0, 0, 0];
  const table = edgeTable(M);
  for (let i = 0; i < nt; i++) {
    normal(i, n);
    const len = Math.hypot(n[0], n[1], n[2]);
    if (len < 1e-20) continue;
    const a = T[i * 3] * 3, nx = n[0] / len, ny = n[1] / len, nz = n[2] / len, d = -(nx * P[a] + ny * P[a + 1] + nz * P[a + 2]);
    for (let k = 0; k < 3; k++) addPlane(T[i * 3 + k], nx, ny, nz, d, len / 2);
    // an open edge is held in place by a plane standing on it
    for (let k = 0; k < 3; k++) {
      if (table.cnt[table.te[i * 3 + k]] !== 1) continue;
      const p = T[i * 3 + k], q = T[i * 3 + (k + 1) % 3];
      const ex = P[q * 3] - P[p * 3], ey = P[q * 3 + 1] - P[p * 3 + 1], ez = P[q * 3 + 2] - P[p * 3 + 2];
      let mx = ey * nz - ez * ny, my = ez * nx - ex * nz, mz = ex * ny - ey * nx;
      const ml = Math.hypot(mx, my, mz);
      if (ml < 1e-20) continue;
      mx /= ml; my /= ml; mz /= ml;
      const w = 20 * (ex * ex + ey * ey + ez * ez), md = -(mx * P[p * 3] + my * P[p * 3 + 1] + mz * P[p * 3 + 2]);
      addPlane(p, mx, my, mz, md, w); addPlane(q, mx, my, mz, md, w);
    }
  }
  const errAt = (a, b, x, y, z) => {
    const p = a * 10, q = b * 10;
    const q0 = Q[p] + Q[q], q1 = Q[p + 1] + Q[q + 1], q2 = Q[p + 2] + Q[q + 2], q3 = Q[p + 3] + Q[q + 3], q4 = Q[p + 4] + Q[q + 4];
    const q5 = Q[p + 5] + Q[q + 5], q6 = Q[p + 6] + Q[q + 6], q7 = Q[p + 7] + Q[q + 7], q8 = Q[p + 8] + Q[q + 8], q9 = Q[p + 9] + Q[q + 9];
    return q0 * x * x + 2 * q1 * x * y + 2 * q2 * x * z + 2 * q3 * x + q4 * y * y + 2 * q5 * y * z + 2 * q6 * y + q7 * z * z + 2 * q8 * z + q9;
  };
  const heap = new Heap();
  // with lockBoundary the open rim stays exactly where it is, so a reduced patch still fits its surroundings
  const rim = lockBoundary ? boundaryVertexMask(M, table) : null;
  const pushEdge = (a, b) => {
    const len = edgeLength(P, a, b);
    if (shorterThan && len >= shorterThan) return;
    if (rim && rim[a] && rim[b]) return;
    const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2], bx = P[b * 3], by = P[b * 3 + 1], bz = P[b * 3 + 2];
    let best = errAt(a, b, (ax + bx) / 2, (ay + by) / 2, (az + bz) / 2), w = 0.5;
    const ca = errAt(a, b, ax, ay, az), cb = errAt(a, b, bx, by, bz);
    if (ca < best) { best = ca; w = 0; }
    if (cb < best) { best = cb; w = 1; }
    if (rim && rim[a]) { best = ca; w = 0; } else if (rim && rim[b]) { best = cb; w = 1; }
    heap.push({ c: Math.max(0, best) + len * 1e-9, a, b, w, sa: ver[a], sb: ver[b] });
  };
  for (let e = 0; e < table.count; e++) pushEdge(table.ea[e], table.eb[e]);
  const na = new Set(), nbs = new Set(), n2 = [0, 0, 0];
  const flips = (u, other, x, y, z) => {
    for (const i of vt[u]) {
      if (!alive[i]) continue;
      const i0 = T[i * 3], i1 = T[i * 3 + 1], i2 = T[i * 3 + 2];
      if (i0 === other || i1 === other || i2 === other) continue;
      normal(i, n);
      const sx = P[u * 3], sy = P[u * 3 + 1], sz = P[u * 3 + 2];
      P[u * 3] = x; P[u * 3 + 1] = y; P[u * 3 + 2] = z;
      normal(i, n2);
      P[u * 3] = sx; P[u * 3 + 1] = sy; P[u * 3 + 2] = sz;
      const l1 = Math.hypot(n[0], n[1], n[2]), l2 = Math.hypot(n2[0], n2[1], n2[2]);
      if (l2 < 1e-14 || n[0] * n2[0] + n[1] * n2[1] + n[2] * n2[2] < 0.2 * l1 * l2) return true;
    }
    return false;
  };
  while (heap.size && (shorterThan ? true : live > targetTris)) {
    const h = heap.pop();
    const { a, b } = h;
    if (gone[a] || gone[b] || ver[a] !== h.sa || ver[b] !== h.sb) continue;
    if (h.c > maxError) break;
    na.clear(); nbs.clear();
    let shared = 0;
    for (const i of vt[a]) { if (!alive[i]) continue; let hasB = false; for (let k = 0; k < 3; k++) { const x = T[i * 3 + k]; if (x === b) hasB = true; else if (x !== a) na.add(x); } if (hasB) shared += 1; }
    for (const i of vt[b]) { if (!alive[i]) continue; for (let k = 0; k < 3; k++) { const x = T[i * 3 + k]; if (x !== a && x !== b) nbs.add(x); } }
    let common = 0;
    for (const x of na) if (nbs.has(x)) common += 1;
    if (shared < 1 || shared > 2 || common !== shared) continue;
    const x = P[a * 3] + (P[b * 3] - P[a * 3]) * h.w, y = P[a * 3 + 1] + (P[b * 3 + 1] - P[a * 3 + 1]) * h.w, z = P[a * 3 + 2] + (P[b * 3 + 2] - P[a * 3 + 2]) * h.w;
    if (flips(a, b, x, y, z) || flips(b, a, x, y, z)) continue;
    // collapse b into a
    P[a * 3] = x; P[a * 3 + 1] = y; P[a * 3 + 2] = z;
    if (C) for (let k = 0; k < 3; k++) C[a * 3 + k] = C[a * 3 + k] + (C[b * 3 + k] - C[a * 3 + k]) * h.w;
    const keep = [];
    for (const i of vt[a]) if (alive[i]) { if (T[i * 3] === b || T[i * 3 + 1] === b || T[i * 3 + 2] === b) { alive[i] = 0; live -= 1; } else keep.push(i); }
    for (const i of vt[b]) { if (!alive[i]) continue; for (let k = 0; k < 3; k++) if (T[i * 3 + k] === b) T[i * 3 + k] = a; keep.push(i); }
    vt[a] = keep; vt[b] = [];
    for (let k = 0; k < 10; k++) Q[a * 10 + k] += Q[b * 10 + k];
    gone[b] = 1; ver[a] += 1;
    if (rim && rim[b]) rim[a] = 1;
    na.clear();
    for (const i of keep) for (let k = 0; k < 3; k++) { const o = T[i * 3 + k]; if (o !== a) na.add(o); }
    for (const o of na) pushEdge(a, o);
  }
  return subMesh({ v: Float32Array.from(P), t: T, c: C, g: M.g }, alive);
}

/** Even out triangle sizes around a target edge length. */
export function remesh(M, edgeLen, { smoothing = 2 } = {}) {
  let cur = splitLongEdges(M, edgeLen * 1.34).mesh;
  cur = decimate(cur, 0, { shorterThan: edgeLen * 0.7 });
  return smoothing > 0 ? smooth(cur, { iterations: smoothing, strength: 0.35 }) : cur;
}

// ------------------------------------------------------------------ repair
/** Close open boundaries. Small holes get a fan; larger ones are refined and relaxed into a smooth patch. */
export function fillHoles(M, { maxEdges = Infinity, loops = null, refine = true } = {}) {
  const table = edgeTable(M);
  const all = loops || boundaryLoops(M, table);
  const todo = all.filter((l) => l.length <= maxEdges);
  if (!todo.length) return { mesh: M, filled: 0 };
  const v = Array.from(M.v), c = M.c ? Array.from(M.c) : null, t = Array.from(M.t), g = M.g ? Array.from(M.g) : null;
  const nt0 = M.t.length / 3;
  let lenSum = 0, lenCount = 0;
  for (const loop of todo) {
    if (loop.length === 3) { t.push(loop[2], loop[1], loop[0]); if (g) g.push(-1); continue; }
    let x = 0, y = 0, z = 0, r = 0, gr = 0, b = 0;
    for (const i of loop) { x += M.v[i * 3]; y += M.v[i * 3 + 1]; z += M.v[i * 3 + 2]; if (c) { r += M.c[i * 3]; gr += M.c[i * 3 + 1]; b += M.c[i * 3 + 2]; } }
    const n = loop.length, ci = v.length / 3;
    v.push(x / n, y / n, z / n);
    if (c) c.push(r / n, gr / n, b / n);
    for (let i = 0; i < n; i++) { const p = loop[i], q = loop[(i + 1) % n]; t.push(q, p, ci); if (g) g.push(-1); lenSum += edgeLength(M.v, p, q); lenCount += 1; }
  }
  let mesh = { v: Float32Array.from(v), t: Uint32Array.from(t), c: c ? Float32Array.from(c) : null, g: g ? Int32Array.from(g) : null };
  if (refine && lenCount) {
    const mask = new Uint8Array(mesh.t.length / 3);
    mask.fill(1, nt0);
    const res = splitLongEdges(mesh, (lenSum / lenCount) * 1.5, mask, 5, mesh.t.length / 3 + 200000);
    mesh = res.mesh;
    const vm = new Uint8Array(mesh.v.length / 3);
    vm.fill(1, M.v.length / 3); // only the vertices created for the patches move
    mesh = smooth(mesh, { iterations: 12, strength: 0.6, mask: vm, keepVolume: false });
  }
  return { mesh, filled: todo.length };
}

/** Weld open edges that lie within `tolerance` of each other (cracks between patches). */
export function closeCracks(M, tolerance = 0.05) {
  const table = edgeTable(M), onEdge = boundaryVertexMask(M, table), nv = M.v.length / 3;
  const w = welder(nv, tolerance), remap = new Int32Array(nv), firstOf = new Map();
  let merged = 0;
  for (let i = 0; i < nv; i++) {
    remap[i] = i;
    if (!onEdge[i]) continue;
    const key = w.add(M.v[i * 3], M.v[i * 3 + 1], M.v[i * 3 + 2]);
    if (firstOf.has(key)) { remap[i] = firstOf.get(key); merged += 1; } else firstOf.set(key, i);
  }
  if (!merged) return { mesh: M, merged: 0 };
  const keep = new Uint8Array(M.t.length / 3), t = Uint32Array.from(M.t, (a) => remap[a]);
  for (let i = 0; i < keep.length; i++) keep[i] = t[i * 3] !== t[i * 3 + 1] && t[i * 3 + 1] !== t[i * 3 + 2] && t[i * 3] !== t[i * 3 + 2] ? 1 : 0;
  return { mesh: subMesh({ ...M, t }, keep), merged };
}

/** Drop triangles on edges shared by more than two faces, and zero-area triangles. */
export function removeBadTriangles(M) {
  const table = edgeTable(M), nt = M.t.length / 3, keep = new Uint8Array(nt).fill(1), v = M.v, t = M.t;
  let removed = 0;
  for (let i = 0; i < nt; i++) {
    const a = t[i * 3] * 3, b = t[i * 3 + 1] * 3, c = t[i * 3 + 2] * 3;
    const ux = v[b] - v[a], uy = v[b + 1] - v[a + 1], uz = v[b + 2] - v[a + 2], wx = v[c] - v[a], wy = v[c + 1] - v[a + 1], wz = v[c + 2] - v[a + 2];
    const area = Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx);
    if (area < 1e-12) { keep[i] = 0; removed += 1; }
  }
  // of the faces crowding one edge, the first two stay
  const seen = new Uint8Array(table.count);
  for (let i = 0; i < nt; i++) {
    if (!keep[i]) continue;
    for (let k = 0; k < 3; k++) {
      const e = table.te[i * 3 + k];
      if (table.cnt[e] <= 2) continue;
      if (seen[e] >= 2) { keep[i] = 0; removed += 1; break; }
    }
    if (keep[i]) for (let k = 0; k < 3; k++) { const e = table.te[i * 3 + k]; if (table.cnt[e] > 2) seen[e] += 1; }
  }
  return { mesh: removed ? subMesh(M, keep) : M, removed };
}

/** Give every flat-ish region its own face group, splitting where faces meet at more than `angle` degrees. */
export function faceGroupsByAngle(M, angle = 30) {
  const table = edgeTable(M), nt = M.t.length / 3, v = M.v, t = M.t;
  const nrm = new Float32Array(nt * 3);
  for (let i = 0; i < nt; i++) {
    const a = t[i * 3] * 3, b = t[i * 3 + 1] * 3, c = t[i * 3 + 2] * 3;
    const ux = v[b] - v[a], uy = v[b + 1] - v[a + 1], uz = v[b + 2] - v[a + 2], wx = v[c] - v[a], wy = v[c + 1] - v[a + 1], wz = v[c + 2] - v[a + 2];
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx, l = Math.hypot(nx, ny, nz) || 1;
    nrm[i * 3] = nx / l; nrm[i * 3 + 1] = ny / l; nrm[i * 3 + 2] = nz / l;
  }
  const limit = Math.cos((angle * Math.PI) / 180), g = new Int32Array(nt).fill(-1), stack = [];
  let count = 0;
  for (let s = 0; s < nt; s++) {
    if (g[s] >= 0) continue;
    g[s] = count; stack.push(s);
    while (stack.length) {
      const i = stack.pop();
      for (let k = 0; k < 3; k++) {
        const e = table.te[i * 3 + k];
        if (table.cnt[e] !== 2) continue;
        const j = table.ta[e] === i ? table.tb[e] : table.ta[e];
        if (g[j] >= 0) continue;
        if (nrm[i * 3] * nrm[j * 3] + nrm[i * 3 + 1] * nrm[j * 3 + 1] + nrm[i * 3 + 2] * nrm[j * 3 + 2] < limit) continue;
        g[j] = count; stack.push(j);
      }
    }
    count += 1;
  }
  return { mesh: { ...M, g }, count };
}

// ------------------------------------------------------------------ selection edits
/** Vertices on the rim of the chosen triangles (next to an unchosen triangle or an open edge). */
function regionRim(M, mask, table) {
  const rim = new Uint8Array(M.v.length / 3), edges = [];
  for (let i = 0; i < M.t.length / 3; i++) {
    if (!mask[i]) continue;
    for (let k = 0; k < 3; k++) {
      const e = table.te[i * 3 + k];
      const other = table.ta[e] === i ? table.tb[e] : table.ta[e];
      if (table.cnt[e] === 2 && other >= 0 && mask[other]) continue;
      const a = M.t[i * 3 + k], b = M.t[i * 3 + (k + 1) % 3];
      rim[a] = 1; rim[b] = 1; edges.push(a, b);
    }
  }
  return { rim, edges };
}

/**
 * Push the chosen triangles out by `distance` and build walls around them. `perVertex` moves
 * each vertex along its own normal (offset); otherwise the whole patch moves one way (extrude).
 */
export function extrudeFaces(M, mask, distance, { perVertex = false, direction = null } = {}) {
  const table = edgeTable(M), nv = M.v.length / 3, nt = M.t.length / 3;
  const { rim, edges } = regionRim(M, mask, table);
  const used = new Uint8Array(nv);
  const normals = new Float32Array(nv * 3);
  let ax = 0, ay = 0, az = 0;
  for (let i = 0; i < nt; i++) {
    if (!mask[i]) continue;
    const a = M.t[i * 3] * 3, b = M.t[i * 3 + 1] * 3, c = M.t[i * 3 + 2] * 3, v = M.v;
    const ux = v[b] - v[a], uy = v[b + 1] - v[a + 1], uz = v[b + 2] - v[a + 2], wx = v[c] - v[a], wy = v[c + 1] - v[a + 1], wz = v[c + 2] - v[a + 2];
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    ax += nx; ay += ny; az += nz;
    for (let k = 0; k < 3; k++) { const p = M.t[i * 3 + k]; used[p] = 1; normals[p * 3] += nx; normals[p * 3 + 1] += ny; normals[p * 3 + 2] += nz; }
  }
  const al = Math.hypot(ax, ay, az) || 1;
  const dir = direction || [ax / al, ay / al, az / al];
  const v = Array.from(M.v), c = M.c ? Array.from(M.c) : null, t = Array.from(M.t), g = M.g ? Array.from(M.g) : null;
  const twin = new Int32Array(nv).fill(-1);
  const move = (src, dst) => {
    let dx = dir[0], dy = dir[1], dz = dir[2];
    if (perVertex) { const l = Math.hypot(normals[src * 3], normals[src * 3 + 1], normals[src * 3 + 2]) || 1; dx = normals[src * 3] / l; dy = normals[src * 3 + 1] / l; dz = normals[src * 3 + 2] / l; }
    v[dst * 3] = M.v[src * 3] + dx * distance; v[dst * 3 + 1] = M.v[src * 3 + 1] + dy * distance; v[dst * 3 + 2] = M.v[src * 3 + 2] + dz * distance;
  };
  for (let i = 0; i < nv; i++) {
    if (!used[i]) continue;
    if (!rim[i]) { move(i, i); continue; }
    twin[i] = v.length / 3;
    v.push(0, 0, 0);
    if (c) c.push(M.c[i * 3], M.c[i * 3 + 1], M.c[i * 3 + 2]);
    move(i, twin[i]);
  }
  for (let i = 0; i < nt; i++) if (mask[i]) for (let k = 0; k < 3; k++) { const p = t[i * 3 + k]; if (twin[p] >= 0) t[i * 3 + k] = twin[p]; }
  for (let i = 0; i < edges.length; i += 2) {
    const a = edges[i], b = edges[i + 1];
    t.push(a, b, twin[b], a, twin[b], twin[a]);
    if (g) g.push(-1, -1);
  }
  const outMask = new Uint8Array(t.length / 3);
  outMask.set(mask);
  return { mesh: { v: Float32Array.from(v), t: Uint32Array.from(t), c: c ? Float32Array.from(c) : null, g: g ? Int32Array.from(g) : null }, mask: outMask };
}

/** Turn an open surface into a closed shell `thickness` thick (growing inward). */
export function thicken(M, thickness) {
  const table = edgeTable(M), nv = M.v.length / 3, nt = M.t.length / 3;
  const nrm = vertexNormals(M);
  const v = new Float32Array(nv * 6), c = M.c ? new Float32Array(nv * 6) : null, t = [];
  v.set(M.v);
  if (c) { c.set(M.c); c.set(M.c, nv * 3); }
  for (let i = 0; i < nv * 3; i++) v[nv * 3 + i] = M.v[i] - nrm[i] * thickness;
  for (let i = 0; i < nt; i++) { const a = M.t[i * 3], b = M.t[i * 3 + 1], d = M.t[i * 3 + 2]; t.push(a, b, d, a + nv, d + nv, b + nv); }
  for (let i = 0; i < nt; i++) {
    for (let k = 0; k < 3; k++) {
      if (table.cnt[table.te[i * 3 + k]] !== 1) continue;
      const a = M.t[i * 3 + k], b = M.t[i * 3 + (k + 1) % 3];
      t.push(b, a, a + nv, b, a + nv, b + nv);
    }
  }
  return { v, t: Uint32Array.from(t), c, g: null };
}

// ------------------------------------------------------------------ plane cut
function clipMesh(M, n, d) {
  const nv = M.v.length / 3, nt = M.t.length / 3;
  const s = new Float64Array(nv);
  for (let i = 0; i < nv; i++) { const x = n[0] * M.v[i * 3] + n[1] * M.v[i * 3 + 1] + n[2] * M.v[i * 3 + 2] - d; s[i] = Math.abs(x) < 1e-7 ? 0 : x; }
  const v = Array.from(M.v), c = M.c ? Array.from(M.c) : null;
  const cutVert = new Map();
  const cut = (a, b) => {
    const key = a < b ? a * nv + b : b * nv + a;
    let i = cutVert.get(key);
    if (i !== undefined) return i;
    const f = s[a] / (s[a] - s[b]);
    i = v.length / 3;
    for (let k = 0; k < 3; k++) v.push(M.v[a * 3 + k] + (M.v[b * 3 + k] - M.v[a * 3 + k]) * f);
    if (c) for (let k = 0; k < 3; k++) c.push(M.c[a * 3 + k] + (M.c[b * 3 + k] - M.c[a * 3 + k]) * f);
    cutVert.set(key, i);
    return i;
  };
  const sides = [{ t: [], g: [] }, { t: [], g: [] }];
  for (let i = 0; i < nt; i++) {
    const p = [M.t[i * 3], M.t[i * 3 + 1], M.t[i * 3 + 2]];
    const up = [s[p[0]] >= 0, s[p[1]] >= 0, s[p[2]] >= 0];
    const count = up[0] + up[1] + up[2];
    const gi = M.g ? M.g[i] : 0;
    const put = (side, a, b, e) => { if (a === b || b === e || a === e) return; sides[side].t.push(a, b, e); sides[side].g.push(gi); };
    if (count === 3) put(0, p[0], p[1], p[2]);
    else if (count === 0) put(1, p[0], p[1], p[2]);
    else {
      // rotate so that `a` is the vertex alone on its side
      const lone = count === 1 ? up.indexOf(true) : up.indexOf(false);
      const a = p[lone], b = p[(lone + 1) % 3], e = p[(lone + 2) % 3];
      const ab = s[b] === 0 ? b : cut(a, b), ae = s[e] === 0 ? e : cut(a, e);
      const sideA = count === 1 ? 0 : 1;
      put(sideA, a, ab, ae);
      put(1 - sideA, ab, b, e); put(1 - sideA, ab, e, ae);
    }
  }
  const base = { v: Float32Array.from(v), c: c ? Float32Array.from(c) : null };
  return sides.map((side) => compact({ ...base, t: Uint32Array.from(side.t), g: M.g ? Int32Array.from(side.g) : null }));
}

/**
 * Cut by the plane n·p = d. keep: 'above' (the side the normal points to), 'below' or 'both'.
 * Closed solids are capped exactly; open meshes get a simple fan cap when `cap` is set.
 */
export function planeCut(M, normal, d, { keep = 'above', cap = true } = {}) {
  const l = Math.hypot(normal[0], normal[1], normal[2]) || 1;
  const n = [normal[0] / l, normal[1] / l, normal[2] / l];
  const want = keep === 'both' ? [0, 1] : keep === 'below' ? [1] : [0];
  if (cap && kernel()) {
    const s = meshToSolid(M);
    if (s) {
      let parts = [];
      try {
        parts = s.splitByPlane(n, d);
        const out = want.map((i) => (parts[i].isEmpty() ? null : solidToMesh(parts[i], !!M.c))).filter(Boolean);
        return out;
      } catch (err) { console.warn('Plane cut fell back to the simple method', err); } finally { free([s, ...parts]); }
    }
  }
  const sides = clipMesh(M, n, d);
  return want.map((i) => {
    let m = sides[i];
    if (!m.t.length) return null;
    if (cap) {
      const loops = boundaryLoops(m).filter((loop) => loop.every((p) => Math.abs(n[0] * m.v[p * 3] + n[1] * m.v[p * 3 + 1] + n[2] * m.v[p * 3 + 2] - d) < 1e-4));
      if (loops.length) m = fillHoles(m, { loops, refine: false }).mesh;
    }
    return m;
  }).filter(Boolean);
}

/** Cut the mesh in half and mirror the kept half across the plane, giving a symmetric model. */
export function symmetrize(M, axis = 0, positive = true) {
  const bb = meshBounds(M), n = [0, 0, 0];
  n[axis] = positive ? 1 : -1;
  const d = bb.center[axis] * n[axis];
  const half = planeCut(M, n, d, { keep: 'above', cap: true })[0];
  if (!half) throw new Error('Nothing is left on that side');
  const mirror = cloneMesh(half);
  for (let i = axis; i < mirror.v.length; i += 3) mirror.v[i] = 2 * bb.center[axis] - mirror.v[i];
  const other = flipNormals(mirror);
  const api = kernel();
  if (api) {
    const a = meshToSolid(half), b = meshToSolid(other);
    if (a && b) {
      const u = a.add(b);
      try { if (u.status() === 'NoError' && !u.isEmpty()) return solidToMesh(u, !!M.c); } finally { free([a, b, u]); }
    } else free([a, b].filter(Boolean));
  }
  const soup = meshToSoup(mergeMeshes([half, other]));
  return soupToMesh(soup.positions, soup.colors, null, 1e-4);
}

// ------------------------------------------------------------------ make solid / hollow / offset
function distanceField(M, cell, bandCells) {
  const bb = meshBounds(M), pad = cell * (bandCells + 2);
  const org = [bb.min[0] - pad, bb.min[1] - pad, bb.min[2] - pad];
  const dims = [0, 1, 2].map((k) => Math.ceil((bb.size[k] + 2 * pad) / cell) + 1);
  const [nx, ny, nz] = dims, N = nx * ny * nz, stride = [1, nx, nx * ny];
  const geo = indexedGeo(M);
  const bvh = new MeshBVH(geo);
  const pos = geo.attributes.position.array, idx = geo.index.array;
  const votes = new Uint8Array(N);
  const ray = new THREE.Ray();
  // inside / outside from three sets of parallel rays; two out of three win, which tolerates small gaps
  for (let a = 0; a < 3; a++) {
    const u = (a + 1) % 3, w = (a + 2) % 3;
    ray.direction.set(a === 0 ? 1 : 0, a === 1 ? 1 : 0, a === 2 ? 1 : 0);
    for (let iu = 0; iu < dims[u]; iu++) {
      for (let iw = 0; iw < dims[w]; iw++) {
        const o = [0, 0, 0];
        o[u] = org[u] + iu * cell + cell * 1.37e-3; o[w] = org[w] + iw * cell + cell * 2.11e-3; o[a] = org[a] - cell;
        ray.origin.set(o[0], o[1], o[2]);
        const hits = bvh.raycast(ray, THREE.DoubleSide);
        if (!hits.length) continue;
        const list = hits.map((h) => {
          const f = h.faceIndex * 3, p = idx[f] * 3, q = idx[f + 1] * 3, r = idx[f + 2] * 3;
          const e1u = pos[q + u] - pos[p + u], e1w = pos[q + w] - pos[p + w], e2u = pos[r + u] - pos[p + u], e2w = pos[r + w] - pos[p + w];
          return { d: h.distance, s: e1u * e2w - e1w * e2u < 0 ? 1 : -1 }; // the normal's component along the ray
        }).sort((p, q) => p.d - q.d);
        let wind = 0, k = 0;
        const base = iu * stride[u] + iw * stride[w];
        for (let ia = 0; ia < dims[a]; ia++) {
          const dist = (ia + 1) * cell;
          while (k < list.length && list[k].d < dist) { wind += list[k].s; k += 1; }
          if (wind !== 0) votes[base + ia * stride[a]] += 1;
        }
      }
    }
  }
  const far = cell * (bandCells + 1);
  const d = new Float32Array(N);
  let mask = new Uint8Array(N);
  const inside = (i) => votes[i] >= 2;
  for (let z = 1; z < nz - 1; z++) for (let y = 1; y < ny - 1; y++) for (let x = 1; x < nx - 1; x++) {
    const i = x + y * nx + z * nx * ny, s = inside(i);
    if (inside(i - 1) !== s || inside(i + 1) !== s || inside(i - nx) !== s || inside(i + nx) !== s || inside(i - nx * ny) !== s || inside(i + nx * ny) !== s) mask[i] = 1;
  }
  for (let r = 1; r < bandCells; r++) {
    const next = Uint8Array.from(mask);
    for (let z = 1; z < nz - 1; z++) for (let y = 1; y < ny - 1; y++) for (let x = 1; x < nx - 1; x++) {
      const i = x + y * nx + z * nx * ny;
      if (!mask[i] && (mask[i - 1] || mask[i + 1] || mask[i - nx] || mask[i + nx] || mask[i - nx * ny] || mask[i + nx * ny])) next[i] = 1;
    }
    mask = next;
  }
  const p = new THREE.Vector3(), target = {};
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const i = x + y * nx + z * nx * ny;
    if (!mask[i]) { d[i] = inside(i) ? far : -far; continue; }
    p.set(org[0] + x * cell, org[1] + y * cell, org[2] + z * cell);
    const hit = bvh.closestPointToPoint(p, target, 0, far);
    const dist = hit ? Math.min(hit.distance, far) : far;
    d[i] = inside(i) ? dist : -dist;
  }
  return { d, dims, org, cell, far };
}

function fieldSolid(api, F, level) {
  const { d, dims, org, cell, far } = F, [nx, ny, nz] = dims, sxy = nx * ny;
  const sdf = (pt) => {
    const fx = (pt[0] - org[0]) / cell, fy = (pt[1] - org[1]) / cell, fz = (pt[2] - org[2]) / cell;
    if (!(fx >= 0 && fy >= 0 && fz >= 0 && fx <= nx - 1 && fy <= ny - 1 && fz <= nz - 1)) return -far;
    const x = Math.min(nx - 2, fx | 0), y = Math.min(ny - 2, fy | 0), z = Math.min(nz - 2, fz | 0);
    const tx = fx - x, ty = fy - y, tz = fz - z, i = x + y * nx + z * sxy;
    const c00 = d[i] + (d[i + 1] - d[i]) * tx, c10 = d[i + nx] + (d[i + nx + 1] - d[i + nx]) * tx;
    const c01 = d[i + sxy] + (d[i + sxy + 1] - d[i + sxy]) * tx, c11 = d[i + sxy + nx] + (d[i + sxy + nx + 1] - d[i + sxy + nx]) * tx;
    const c0 = c00 + (c10 - c00) * ty, c1 = c01 + (c11 - c01) * ty;
    return c0 + (c1 - c0) * tz;
  };
  const max = [org[0] + (nx - 1) * cell, org[1] + (ny - 1) * cell, org[2] + (nz - 1) * cell];
  return api.Manifold.levelSet(sdf, { min: org, max }, cell, level);
}

function cellFor(M, resolution, extra = 0) {
  const bb = meshBounds(M);
  const maxDim = Math.max(...bb.size, 1e-3);
  let cell = Math.max(maxDim / Math.max(8, resolution), 0.02);
  // keep the grid within a few million points
  for (;;) {
    const n = bb.size.reduce((acc, s) => acc * (Math.ceil((s + 2 * extra) / cell) + 9), 1);
    if (n <= 5e6) break;
    cell *= 1.15;
  }
  return cell;
}

/**
 * Rebuild the mesh as one closed, printable solid by sampling it on a grid. `offset` grows
 * (positive) or shrinks (negative) the result. Gaps, overlaps and inner faces disappear.
 */
export function makeSolid(M, { resolution = 96, offset = 0 } = {}) {
  const api = needKernel();
  const cell = cellFor(M, resolution, Math.max(0, offset));
  const F = distanceField(M, cell, Math.ceil(Math.abs(offset) / cell) + 2);
  const s = fieldSolid(api, F, -offset);
  try {
    if (s.status() !== 'NoError' || s.isEmpty()) throw new Error('Nothing was left: try a finer accuracy or a smaller offset');
    return solidToMesh(s);
  } finally { free([s]); }
}

/** Hollow a model, leaving a wall of the given thickness, with optional drain holes in the bottom. */
export function hollow(M, { wall = 2, resolution = 80, drains = 0, drainRadius = 2 } = {}) {
  const api = needKernel();
  const cell = Math.min(cellFor(M, resolution), Math.max(wall / 2, 0.05) * 1.01);
  const cellOk = cellFor(M, 1e9); // the finest grid that still fits in memory
  const use = Math.max(cell, cellOk);
  const F = distanceField(M, use, Math.ceil(wall / use) + 2);
  const made = [];
  try {
    let outer = meshToSolid(M);
    if (!outer) outer = fieldSolid(api, F, 0);
    made.push(outer);
    const inner = fieldSolid(api, F, wall);
    made.push(inner);
    if (inner.isEmpty()) throw new Error('The wall is thicker than the model, so nothing can be hollowed out');
    let result = outer.subtract(inner);
    made.push(result);
    if (drains > 0) {
      const ob = outer.boundingBox(), im = inner.getMesh(), np = im.numProp, vp = im.vertProperties;
      let low = 0;
      for (let i = 0; i < vp.length; i += np) if (vp[i + 2] < vp[low + 2]) low = i;
      const spots = [[vp[low], vp[low + 1]]];
      if (drains > 1) {
        let best = -1, bestD = (drainRadius * 4) ** 2;
        for (let i = 0; i < vp.length; i += np) {
          if (vp[i + 2] > vp[low + 2] + Math.max(1, wall)) continue;
          const dd = (vp[i] - vp[low]) ** 2 + (vp[i + 1] - vp[low + 1]) ** 2;
          if (dd > bestD) { bestD = dd; best = i; }
        }
        if (best >= 0) spots.push([vp[best], vp[best + 1]]);
      }
      for (const [x, y] of spots) {
        const cyl = api.Manifold.cylinder(vp[low + 2] - ob.min[2] + 2 + wall, drainRadius, drainRadius, 24);
        const placed = cyl.translate(x, y, ob.min[2] - 1);
        result = result.subtract(placed);
        made.push(cyl, placed, result);
      }
    }
    if (result.status() !== 'NoError' || result.isEmpty()) throw new Error('Hollowing failed on this model');
    return solidToMesh(result, !!M.c);
  } finally { free([...new Set(made)]); }
}

// ------------------------------------------------------------------ tubes, patterns, slices
function rodBetween(api, p, q, r0, r1, segments, made) {
  const a = new THREE.Vector3(...p), b = new THREE.Vector3(...q);
  const len = a.distanceTo(b);
  if (len < 1e-6) return null;
  const cyl = api.Manifold.cylinder(len, r0, r1, segments);
  const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), b.clone().sub(a).normalize());
  const m = new THREE.Matrix4().compose(a, quat, new THREE.Vector3(1, 1, 1));
  const placed = cyl.transform(m.elements);
  made.push(cyl, placed);
  return placed;
}

/** A tube between two points: 'cut' drills a channel through the model, 'add' joins a rod to it. */
export function addTube(M, p0, p1, r0, r1, mode = 'cut') {
  const api = needKernel();
  const made = [];
  try {
    const s = meshToSolid(M);
    if (!s) throw new Error('This needs a closed solid. Use Make solid first.');
    made.push(s);
    const dir = new THREE.Vector3(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]).normalize();
    // a channel pokes out a little at both ends so it opens cleanly
    const e = mode === 'cut' ? Math.max(r0, r1) * 0.5 + 0.2 : 0;
    const a = [p0[0] - dir.x * e, p0[1] - dir.y * e, p0[2] - dir.z * e], b = [p1[0] + dir.x * e, p1[1] + dir.y * e, p1[2] + dir.z * e];
    const rod = rodBetween(api, a, b, r0, r1, 32, made);
    if (!rod) throw new Error('The two points are in the same place');
    const out = mode === 'cut' ? s.subtract(rod) : s.add(rod);
    made.push(out);
    if (out.status() !== 'NoError' || out.isEmpty()) throw new Error('The tube could not be built');
    return solidToMesh(out, !!M.c);
  } finally { free([...new Set(made)]); }
}

export const PATTERNS = [
  ['edges', 'Mesh edges (wireframe)'], ['dual', 'Dual edges (honeycomb)'], ['lattice', 'Lattice (rods inside the shape)'], ['perforate', 'Perforate (round holes)'], ['spheres', 'Tiled spheres'],
];

/**
 * Replace a model with a pattern. `size` is the spacing (or element size) and `thickness`
 * the rod / hole diameter, both in mm.
 */
export function makePattern(M, type, { size = 8, thickness = 2 } = {}) {
  const api = needKernel();
  const made = [];
  const r = Math.max(0.1, thickness / 2);
  try {
    let out;
    if (type === 'edges' || type === 'dual') {
      const bb = meshBounds(M);
      // a coarse copy of the surface gives struts about `size` long
      let coarse = splitLongEdges(M, size * 1.5).mesh;
      const area = surfaceArea(coarse);
      const want = Math.max(40, Math.min(4000, Math.round(area / (0.433 * size * size))));
      coarse = decimate(coarse, want);
      const table = edgeTable(coarse), segs = [], nodes = [];
      if (type === 'edges') {
        if (table.count > 7000) throw new Error('That would make too many struts. Use a larger spacing.');
        for (let e = 0; e < table.count; e++) segs.push([table.ea[e], table.eb[e]]);
        for (let i = 0; i < coarse.v.length / 3; i++) nodes.push([coarse.v[i * 3], coarse.v[i * 3 + 1], coarse.v[i * 3 + 2]]);
      } else {
        const nt = coarse.t.length / 3;
        if (nt > 5000) throw new Error('That would make too many struts. Use a larger spacing.');
        for (let i = 0; i < nt; i++) {
          const a = coarse.t[i * 3] * 3, b = coarse.t[i * 3 + 1] * 3, c = coarse.t[i * 3 + 2] * 3, v = coarse.v;
          nodes.push([(v[a] + v[b] + v[c]) / 3, (v[a + 1] + v[b + 1] + v[c + 1]) / 3, (v[a + 2] + v[b + 2] + v[c + 2]) / 3]);
        }
        for (let e = 0; e < table.count; e++) if (table.cnt[e] === 2) segs.push([table.ta[e], table.tb[e]]);
      }
      const parts = [];
      for (const [a, b] of segs) { const rod = rodBetween(api, nodes[a], nodes[b], r, r, 6, made); if (rod) parts.push(rod); }
      for (const p of nodes) { const ball = api.Manifold.sphere(r, 8); const placed = ball.translate(p[0], p[1], p[2]); made.push(ball, placed); parts.push(placed); }
      if (!parts.length) throw new Error('The shape is too small for that spacing');
      out = api.Manifold.union(parts);
      made.push(out);
      void bb;
    } else {
      const s = meshToSolid(M);
      if (!s) throw new Error('This pattern needs a closed solid. Use Make solid first.');
      made.push(s);
      const bb = s.boundingBox(), tools = [];
      const range = (k) => { const list = []; const n = Math.max(1, Math.floor((bb.max[k] - bb.min[k]) / size)); const start = (bb.min[k] + bb.max[k]) / 2 - (n * size) / 2; for (let i = 0; i <= n; i++) list.push(start + i * size); return list; };
      const X = range(0), Y = range(1), Z = range(2);
      const count = type === 'lattice' ? X.length * Y.length + Y.length * Z.length + X.length * Z.length : type === 'spheres' ? X.length * Y.length * Z.length : X.length * Y.length;
      if (count > 6000) throw new Error('That would make too many elements. Use a larger spacing.');
      if (type === 'lattice') {
        for (const x of X) for (const y of Y) { const rod = rodBetween(api, [x, y, bb.min[2] - 1], [x, y, bb.max[2] + 1], r, r, 8, made); if (rod) tools.push(rod); }
        for (const y of Y) for (const z of Z) { const rod = rodBetween(api, [bb.min[0] - 1, y, z], [bb.max[0] + 1, y, z], r, r, 8, made); if (rod) tools.push(rod); }
        for (const x of X) for (const z of Z) { const rod = rodBetween(api, [x, bb.min[1] - 1, z], [x, bb.max[1] + 1, z], r, r, 8, made); if (rod) tools.push(rod); }
        const grid = api.Manifold.union(tools);
        out = s.intersect(grid);
        made.push(grid, out);
      } else if (type === 'spheres') {
        for (const x of X) for (const y of Y) for (const z of Z) { const ball = api.Manifold.sphere(r, 12); const placed = ball.translate(x, y, z); made.push(ball, placed); tools.push(placed); }
        const grid = api.Manifold.union(tools);
        out = s.intersect(grid);
        made.push(grid, out);
      } else {
        for (const x of X) for (const y of Y) { const rod = rodBetween(api, [x, y, bb.min[2] - 1], [x, y, bb.max[2] + 1], r, r, 16, made); if (rod) tools.push(rod); }
        const grid = api.Manifold.union(tools);
        out = s.subtract(grid);
        made.push(grid, out);
      }
    }
    if (out.status() !== 'NoError' || out.isEmpty()) throw new Error('The pattern came out empty. Try a different spacing or thickness.');
    return solidToMesh(out);
  } finally { free([...new Set(made)]); }
}

/** Cut a solid into flat slabs along an axis (for stacked cardboard / plywood builds). Returns one mesh per slab. */
export function makeSlices(M, { thickness = 3, axis = 2, gap = 0 } = {}) {
  const api = needKernel();
  const made = [];
  try {
    const src = meshToSolid(M);
    if (!src) throw new Error('Slicing needs a closed solid. Use Make solid first.');
    made.push(src);
    const turn = axis === 0 ? [0, -90, 0] : axis === 1 ? [90, 0, 0] : null, back = axis === 0 ? [0, 90, 0] : axis === 1 ? [-90, 0, 0] : null;
    const s = turn ? src.rotate(turn) : src;
    made.push(s);
    const bb = s.boundingBox(), out = [];
    const count = Math.ceil((bb.max[2] - bb.min[2]) / thickness - 1e-6);
    if (count > 400) throw new Error('That would make more than 400 slices. Use thicker slices.');
    for (let i = 0; i < count; i++) {
      const z = bb.min[2] + i * thickness;
      const cs = s.slice(z + thickness / 2);
      made.push(cs);
      if (cs.isEmpty()) continue;
      const slab = api.Manifold.extrude(cs, Math.max(0.05, thickness - gap));
      const placed = slab.translate(0, 0, z);
      const final = back ? placed.rotate(back) : placed;
      made.push(slab, placed, final);
      if (!final.isEmpty()) out.push(solidToMesh(final));
    }
    if (!out.length) throw new Error('No slices were produced');
    return out;
  } finally { free([...new Set(made)]); }
}

/** Area of the cross-section at evenly spaced heights; the smallest is where a part snaps first. */
export function crossSections(M, steps = 60) {
  const s = meshToSolid(M);
  if (!s) return null;
  const made = [s];
  try {
    const bb = s.boundingBox(), h = bb.max[2] - bb.min[2], list = [];
    for (let i = 0; i < steps; i++) {
      const z = bb.min[2] + ((i + 0.5) / steps) * h;
      const cs = s.slice(z);
      made.push(cs);
      list.push({ z, area: cs.area() });
    }
    return list;
  } finally { free(made); }
}
