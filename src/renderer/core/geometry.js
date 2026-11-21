// Geometry engine: builds (and caches) the mesh for any node, including boolean groups.
import * as THREE from 'three';
import { mergeVertices, toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ConvexHull } from 'three/examples/jsm/math/ConvexHull.js';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';
import { Brush, Evaluator, ADDITION, SUBTRACTION, INTERSECTION } from 'three-bvh-csg';
import { KINDS } from './shapes.js';
import { geomKey, mat4, ownColors } from './doc.js';
import { solidBoolean, withSolid } from './solid.js';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const CREASE = 0.58; // ~33 degrees
const cache = new Map();
const CACHE_LIMIT = 500;
export const stats = { csgRuns: 0, csgFailures: 0, lastCsgMs: 0, solidRuns: 0, fallbackRuns: 0 };

const evaluator = new Evaluator();
evaluator.attributes = ['position', 'normal', 'color'];
evaluator.useGroups = false;
evaluator.useCDTClipping = true;

const triCount = (g) => (g.index ? g.index.count : g.attributes.position.count) / 3;

function finalize(g) {
  g.computeBoundingBox();
  g.computeBoundingSphere();
  if (g.attributes.position.count > 0) {
    try { g.computeBoundsTree(); } catch { /* fall back to brute force raycasts */ }
  }
  return g;
}

function finishPrimitive(raw, kind, smooth = false) {
  let g = raw;
  // an edited mesh may carry painted vertex colours; everything else is rebuilt from positions
  for (const name of Object.keys(g.attributes)) if (name !== 'position' && !(kind === 'mesh' && name === 'color')) g.deleteAttribute(name);
  g.clearGroups();
  g.morphAttributes = {};
  const tris = triCount(g);
  if (tris < 350000) {
    if (!g.index) g = mergeVertices(g, 1e-4);
    else g = mergeVertices(g.toNonIndexed(), 1e-4);
    g = toCreasedNormals(g, kind === 'mesh' ? (smooth ? 1.15 : 0.45) : CREASE);
  } else {
    // copy: the caller's position array (e.g. an imported mesh's params) must not be translated in place
    g = g.index ? g.toNonIndexed() : g.clone();
    g.computeVertexNormals();
  }
  g.computeBoundingBox();
  const bb = g.boundingBox;
  if (isFinite(bb.min.x)) g.translate(-(bb.min.x + bb.max.x) / 2, -(bb.min.y + bb.max.y) / 2, -bb.min.z);
  return finalize(g);
}

function flipWinding(g) {
  for (const attr of Object.values(g.attributes)) {
    const a = attr.array, n = attr.itemSize;
    for (let i = 0; i < attr.count; i += 3) {
      for (let k = 0; k < n; k++) {
        const t = a[(i + 1) * n + k];
        a[(i + 1) * n + k] = a[(i + 2) * n + k];
        a[(i + 2) * n + k] = t;
      }
    }
  }
}

function paint(g, hex) {
  const c = new THREE.Color(hex);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
}

/** Geometry of a child, baked into its parent's space with a colour attribute. */
function bakedChild(child, parentMatrix) {
  let g = getGeometry(child).clone();
  if (g.index) g = g.toNonIndexed();
  g.boundsTree = undefined;
  const m = parentMatrix ? parentMatrix.clone().multiply(mat4(child.matrix)) : mat4(child.matrix);
  g.applyMatrix4(m);
  if (m.determinant() < 0) flipWinding(g);
  if (!(ownColors(child) && g.attributes.color)) paint(g, child.color);
  return g;
}

// Bundles are transparent to booleans: their members act as individual operands.
function collectOperands(children, parentMatrix, out) {
  for (const c of children) {
    if (c.type === 'group' && c.mode === 'bundle') {
      const m = parentMatrix ? parentMatrix.clone().multiply(mat4(c.matrix)) : mat4(c.matrix);
      collectOperands(c.children, m, out);
    } else {
      const g = bakedChild(c, parentMatrix);
      if (g.attributes.position.count >= 3) out.push({ g, hole: c.hole });
    }
  }
  return out;
}

function mergeRaw(geos) {
  let total = 0;
  for (const g of geos) total += g.attributes.position.count;
  const out = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'color']) {
    const arr = new Float32Array(total * 3);
    let o = 0;
    for (const g of geos) { arr.set(g.attributes[name].array.subarray(0, g.attributes[name].count * 3), o); o += g.attributes[name].count * 3; }
    out.setAttribute(name, new THREE.BufferAttribute(arr, 3));
  }
  return out;
}

function csg(a, b, op) {
  const A = a.isBrush ? a : new Brush(a);
  const B = new Brush(b);
  A.updateMatrixWorld();
  B.updateMatrixWorld();
  // the CSG library still passes an option its BVH dependency has renamed; keep the console readable
  const warn = console.warn;
  console.warn = (...args) => { if (!String(args[0]).includes('maxLeafSize')) warn.apply(console, args); };
  try { return evaluator.evaluate(A, B, op); } finally { console.warn = warn; }
}

function buildGroup(node) {
  if (node.mode === 'bundle') {
    const parts = node.children.map((c) => bakedChild(c, null)).filter((g) => g.attributes.position.count);
    return parts.length ? mergeRaw(parts) : emptyGeometry();
  }
  const ops = collectOperands(node.children, null, []);
  const solids = ops.filter((o) => !o.hole).map((o) => o.g);
  const holes = ops.filter((o) => o.hole).map((o) => o.g);
  if (!ops.length) return emptyGeometry();
  const t0 = performance.now();
  stats.csgRuns += 1;
  // Preferred path: the solid kernel, which always returns a closed, printable mesh.
  const solid = solidBoolean(solids, holes, node.mode);
  if (solid) {
    stats.solidRuns += 1;
    stats.lastCsgMs = performance.now() - t0;
    if (!solid.attributes.position.count) return emptyGeometry();
    return toCreasedNormals(solid, CREASE);
  }
  // Fallback for operands that are not closed solids (e.g. some imported meshes).
  stats.fallbackRuns += 1;
  try {
    let result;
    if (!solids.length) {
      result = holes[0];
      for (let i = 1; i < holes.length; i++) result = csg(result, holes[i], ADDITION);
    } else {
      result = solids[0];
      const joinOp = node.mode === 'intersect' ? INTERSECTION : ADDITION;
      for (let i = 1; i < solids.length; i++) result = csg(result, solids[i], joinOp);
      for (const h of holes) {
        if ((result.isBrush ? result.geometry : result).attributes.position.count < 3) break;
        result = csg(result, h, SUBTRACTION);
      }
    }
    let g = result.isBrush ? result.geometry : result;
    g.boundsTree = undefined;
    g.halfEdges = undefined;
    g.groupIndices = undefined;
    g.clearGroups();
    if (g.index) g = g.toNonIndexed();
    stats.lastCsgMs = performance.now() - t0;
    return g;
  } catch (err) {
    console.warn('Boolean operation failed, falling back to a simple merge', err);
    stats.csgFailures += 1;
    return mergeRaw(solids.length ? solids : holes);
  }
}

export const ROUND_LIMIT = 6000; // triangles; beyond this the operation takes too long to be usable
export const SLOW_ROUND_LIMIT = 1200; // the same, for the slower jobs: top-only, bottom-only and inside corners
export const EDGE_SETS = ['all', 'upper', 'top', 'bottom', 'sides'];
const edgeSet = (v) => (EDGE_SETS.includes(v) ? v : 'all');

/**
 * Round (or bevel) only the edges around the top, leaving upright edges sharp. Works down
 * through the top `r` mm in a few layers; in each one the solid is cut back from its own
 * outline by the distance a quarter circle (or a 45 degree slope) needs at that depth.
 */
function roundTop(api, s, k, r, bevel) {
  const { Manifold } = api;
  const bb = s.boundingBox(), top = bb.max[2], pad = r + 1;
  const layers = bevel ? 1 : 4, h = r / layers, eps = Math.min(0.02, h / 5);
  const inset = (depth) => (bevel ? r - depth : r - Math.sqrt(Math.max(0, r * r - (r - depth) * (r - depth))));
  const w = bb.max[0] - bb.min[0] + 2 * pad, d = bb.max[1] - bb.min[1] + 2 * pad;
  const cuts = [];
  for (let i = 0; i < layers; i++) {
    // everything outside the solid, in a thin sheet at the bottom of this layer
    const sheet = k(k(Manifold.cube([w, d, eps])).translate(bb.min[0] - pad, bb.min[1] - pad, top - (i + 1) * h));
    const outside = k(sheet.subtract(s));
    if (outside.isEmpty()) continue;
    const cone = k(Manifold.cylinder(h, Math.max(1e-3, inset((i + 1) * h)), Math.max(1e-3, inset(i * h)), bevel ? 8 : 12));
    cuts.push(k(outside.minkowskiSum(cone)));
  }
  if (!cuts.length) return s;
  return k(s.subtract(cuts.length === 1 ? cuts[0] : k(Manifold.union(cuts))));
}

/**
 * Round (or bevel) outside edges without changing the overall size. `edges` picks which:
 * 'all', 'upper' (everything but the bottom, so the part still sits flat), 'top',
 * 'bottom' or 'sides' (upright edges only). Up is the shape's own Z axis.
 * All but top and bottom shrink the solid and grow it back with a rounded tool, so holes
 * and gaps end up slightly tighter. Returns the input when it cannot run.
 */
function roundEdges(base, radius, style, edges) {
  edges = edgeSet(edges);
  const bevel = style === 'bevel';
  const slow = edges === 'top' || edges === 'bottom';
  const limit = slow ? SLOW_ROUND_LIMIT : ROUND_LIMIT;
  const tris = triCount(base);
  if (tris < 4 || tris > limit) { stats.roundSkipped = tris > limit ? 'detail' : 'empty'; return base.clone(); }
  const bb = base.boundingBox;
  const size = [bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z];
  const c = [(bb.max.x + bb.min.x) / 2, (bb.max.y + bb.min.y) / 2, (bb.max.z + bb.min.z) / 2];
  const room = edges === 'all' ? Math.min(...size) / 2 : edges === 'sides' ? Math.min(size[0], size[1]) / 2 : Math.min(size[0] / 2, size[1] / 2, size[2]);
  const r = Math.min(radius, room - 0.05);
  if (!(r > 0.01)) return base.clone();
  const flat = base.index ? base.toNonIndexed() : base;
  const out = withSolid(flat, (api, s, k) => {
    const { Manifold } = api;
    if (edges === 'top') return k(roundTop(api, s, k, r, bevel)).simplify(0.005);
    if (edges === 'bottom') return k(k(roundTop(api, k(s.mirror([0, 0, 1])), k, r, bevel)).mirror([0, 0, 1])).simplify(0.005);
    // the tool that is swept around the shrunken solid, and how much height it adds
    let tool, anchorZ = c[2], grow = 2 * r;
    if (edges === 'upper') { tool = k(k(Manifold.sphere(r, bevel ? 4 : 8)).trimByPlane([0, 0, 1], 0)); anchorZ = bb.min.z; grow = r; }
    else if (edges === 'sides') { grow = 0.02; tool = k(Manifold.cylinder(grow, r, r, bevel ? 4 : 16)); anchorZ = bb.min.z; }
    else tool = k(Manifold.sphere(r, bevel ? 4 : 8));
    const scale = [(size[0] - 2 * r) / size[0], (size[1] - 2 * r) / size[1], (size[2] - grow) / size[2]];
    const small = k(k(k(s.translate(-c[0], -c[1], -anchorZ)).scale(scale)).translate(c[0], c[1], anchorZ));
    return small.minkowskiSum(tool);
  });
  if (!out || !out.attributes.position.count) { stats.roundSkipped = 'open'; return base.clone(); }
  return toCreasedNormals(out, bevel ? 0.2 : CREASE);
}

/**
 * Fill every inside corner with a fillet (or a 45 degree slope): the solid is grown by a
 * ball and then cut back by the same ball, which leaves flat faces and outside edges where
 * they were. Slots and holes narrower than twice the radius close up.
 */
function filletCorners(base, radius, style) {
  const bevel = style === 'bevel';
  const tris = triCount(base);
  if (tris < 4 || tris > SLOW_ROUND_LIMIT) { stats.roundSkipped = tris > SLOW_ROUND_LIMIT ? 'detail' : 'empty'; return base.clone(); }
  const r = Math.min(radius, 5);
  if (!(r > 0.01)) return base.clone();
  const flat = base.index ? base.toNonIndexed() : base;
  const out = withSolid(flat, (api, s, k) => {
    const ball = k(api.Manifold.sphere(r, bevel ? 4 : 8));
    // tidying the grown solid first makes cutting it back several times faster
    return k(k(k(s.minkowskiSum(ball)).simplify(0.005)).minkowskiDifference(ball)).simplify(0.005);
  });
  if (!out || !out.attributes.position.count) { stats.roundSkipped = 'open'; return base.clone(); }
  return toCreasedNormals(out, bevel ? 0.2 : CREASE);
}

function emptyGeometry() {
  const g = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'color']) g.setAttribute(name, new THREE.BufferAttribute(new Float32Array(0), 3));
  return g;
}

export function getGeometry(node) {
  const key = geomKey(node);
  let g = cache.get(key);
  if (g) {
    cache.delete(key); // refresh LRU position
    cache.set(key, g);
    return g;
  }
  if (node.round > 0) {
    // outside edges go last, on top of any filled inside corners
    g = finalize(roundEdges(getGeometry({ ...node, round: 0 }), node.round, node.roundStyle, node.roundEdges));
  } else if (node.fillet > 0) {
    g = finalize(filletCorners(getGeometry({ ...node, fillet: 0 }), node.fillet, node.roundStyle));
  } else if (node.type === 'group') {
    g = finalize(buildGroup(node));
  } else {
    const def = KINDS[node.kind];
    let raw;
    try {
      raw = def.build(node.params);
    } catch (err) {
      console.warn('Shape build failed', node.kind, err);
      raw = new THREE.BoxGeometry(20, 20, 20);
    }
    g = finishPrimitive(raw, node.kind, !!(node.params && node.params.mesh && node.params.mesh.smooth));
  }
  cache.set(key, g);
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    const old = cache.get(oldest);
    cache.delete(oldest);
    disposeGeometry(old);
  }
  return g;
}

function disposeGeometry(g) {
  if (g.userData.edges) g.userData.edges.dispose();
  g.dispose();
}

/** Points whose transformed bounds equal the transformed geometry's bounds (convex hull vertices). */
export function hullPoints(g) {
  if (g.userData.hull) return g.userData.hull;
  const pos = g.attributes.position;
  let pts;
  if (pos.count <= 400) {
    pts = new Float32Array(pos.array.subarray(0, pos.count * 3));
  } else {
    try {
      const vecs = [];
      const stride = Math.max(1, Math.floor(pos.count / 60000));
      for (let i = 0; i < pos.count; i += stride) vecs.push(new THREE.Vector3().fromBufferAttribute(pos, i));
      const hull = new ConvexHull().setFromPoints(vecs);
      const seen = new Set();
      const out = [];
      for (const face of hull.faces) {
        let e = face.edge;
        do {
          const p = e.head().point;
          if (!seen.has(p)) { seen.add(p); out.push(p.x, p.y, p.z); }
          e = e.next;
        } while (e !== face.edge);
      }
      // sub-sampled inputs: add the true extreme vertices in 26 directions so bounds stay tight
      // (bounding-box corners would inflate the bounds of rotated shapes)
      if (stride > 1) {
        const dirs = [];
        for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) if (x || y || z) dirs.push([x, y, z]);
        const best = new Float64Array(dirs.length).fill(-Infinity), bi = new Int32Array(dirs.length);
        const a = pos.array, s = pos.isInterleavedBufferAttribute ? null : pos.itemSize;
        for (let i = 0; i < pos.count; i++) {
          const px = s ? a[i * s] : pos.getX(i), py = s ? a[i * s + 1] : pos.getY(i), pz = s ? a[i * s + 2] : pos.getZ(i);
          for (let d = 0; d < dirs.length; d++) {
            const v = dirs[d][0] * px + dirs[d][1] * py + dirs[d][2] * pz;
            if (v > best[d]) { best[d] = v; bi[d] = i; }
          }
        }
        for (const i of new Set(bi)) out.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      }
      pts = new Float32Array(out.length >= 12 ? out : pos.array.subarray(0, pos.count * 3));
    } catch {
      pts = new Float32Array(pos.array.subarray(0, pos.count * 3));
    }
  }
  g.userData.hull = pts;
  return pts;
}

const _v = new THREE.Vector3();
/** Expand `box` by geometry `g` transformed with `matrix`. */
export function expandBox(box, g, matrix) {
  const pts = hullPoints(g);
  for (let i = 0; i < pts.length; i += 3) {
    _v.set(pts[i], pts[i + 1], pts[i + 2]).applyMatrix4(matrix);
    box.expandByPoint(_v);
  }
  return box;
}

export function getEdges(g) {
  if (g.userData.edges !== undefined) return g.userData.edges;
  g.userData.edges = triCount(g) > 250000 ? null : new THREE.EdgesGeometry(g, 28);
  return g.userData.edges;
}

/** Signed volume (mm^3) and surface area (mm^2) of a geometry under a matrix. */
export function measure(g, matrix) {
  const pos = g.attributes.position;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), ab = new THREE.Vector3(), ac = new THREE.Vector3();
  let volume = 0, area = 0;
  const idx = g.index;
  const n = idx ? idx.count : pos.count;
  for (let i = 0; i < n; i += 3) {
    a.fromBufferAttribute(pos, idx ? idx.getX(i) : i).applyMatrix4(matrix);
    b.fromBufferAttribute(pos, idx ? idx.getX(i + 1) : i + 1).applyMatrix4(matrix);
    c.fromBufferAttribute(pos, idx ? idx.getX(i + 2) : i + 2).applyMatrix4(matrix);
    volume += a.dot(ab.crossVectors(b, c)) / 6;
    area += ab.subVectors(b, a).cross(ac.subVectors(c, a)).length() / 2;
  }
  return { volume: Math.abs(volume), area, triangles: n / 3 };
}

/** World-space, export-ready copy of a node's geometry (winding fixed for mirrored transforms). */
export function bakedWorldGeometry(node, colorize = true) {
  let g = getGeometry(node).clone();
  if (g.index) g = g.toNonIndexed();
  g.boundsTree = undefined;
  const m = mat4(node.matrix);
  g.applyMatrix4(m);
  if (m.determinant() < 0) flipWinding(g);
  if (colorize && !(ownColors(node) && g.attributes.color)) paint(g, node.color);
  return g;
}

export function clearGeometryCache() {
  for (const g of cache.values()) disposeGeometry(g);
  cache.clear();
}
