// Neon highlight of the flat face a shape is about to land on: its outline plus a light fill.
import * as THREE from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';

const NEON = 0x39ff14;
const adjacency = new WeakMap(); // geometry -> { keys, tris, normals, edges }

function buildAdjacency(geo) {
  const pos = geo.attributes.position, idx = geo.index;
  const triCount = (idx ? idx.count : pos.count) / 3;
  geo.computeBoundingBox();
  const size = geo.boundingBox.getSize(new THREE.Vector3()).length() || 1;
  const q = 1e5 / size; // weld vertices that differ only by rounding
  const keyOf = new Map(), keys = new Int32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const k = Math.round(pos.getX(i) * q) + ',' + Math.round(pos.getY(i) * q) + ',' + Math.round(pos.getZ(i) * q);
    let id = keyOf.get(k);
    if (id === undefined) { id = keyOf.size; keyOf.set(k, id); }
    keys[i] = id;
  }
  const tris = new Int32Array(triCount * 3), normals = new Float32Array(triCount * 4);
  const edges = new Map();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  for (let t = 0; t < triCount; t++) {
    for (let k = 0; k < 3; k++) tris[t * 3 + k] = idx ? idx.getX(t * 3 + k) : t * 3 + k;
    a.fromBufferAttribute(pos, tris[t * 3]); b.fromBufferAttribute(pos, tris[t * 3 + 1]); c.fromBufferAttribute(pos, tris[t * 3 + 2]);
    n.subVectors(c, b).cross(b.clone().sub(a)).normalize().negate();
    normals[t * 4] = n.x; normals[t * 4 + 1] = n.y; normals[t * 4 + 2] = n.z; normals[t * 4 + 3] = n.dot(a);
    for (let k = 0; k < 3; k++) {
      const u = keys[tris[t * 3 + k]], v = keys[tris[t * 3 + (k + 1) % 3]];
      const e = u < v ? u + '_' + v : v + '_' + u;
      const list = edges.get(e);
      if (list) list.push(t); else edges.set(e, [t]);
    }
  }
  return { keys, tris, normals, edges, tol: size * 1e-4 };
}

/** Triangles of the flat region around `faceIndex`, and the edges on its boundary (local coordinates). */
export function flatRegion(geo, faceIndex) {
  let adj = adjacency.get(geo);
  if (!adj) { adj = buildAdjacency(geo); adjacency.set(geo, adj); }
  const { keys, tris, normals, edges, tol } = adj;
  const nx = normals[faceIndex * 4], ny = normals[faceIndex * 4 + 1], nz = normals[faceIndex * 4 + 2], d = normals[faceIndex * 4 + 3];
  const inRegion = new Set([faceIndex]), stack = [faceIndex];
  const same = (t) => normals[t * 4] * nx + normals[t * 4 + 1] * ny + normals[t * 4 + 2] * nz > 0.9999 && Math.abs(normals[t * 4 + 3] - d) < tol;
  const edgeKey = (t, k) => { const u = keys[tris[t * 3 + k]], v = keys[tris[t * 3 + (k + 1) % 3]]; return u < v ? u + '_' + v : v + '_' + u; };
  while (stack.length) {
    const t = stack.pop();
    for (let k = 0; k < 3; k++) for (const o of edges.get(edgeKey(t, k))) {
      if (!inRegion.has(o) && same(o)) { inRegion.add(o); stack.push(o); }
    }
  }
  const pos = geo.attributes.position;
  const fill = [], outline = [];
  for (const t of inRegion) {
    for (let k = 0; k < 3; k++) {
      const i = tris[t * 3 + k];
      fill.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      const shared = edges.get(edgeKey(t, k)).filter((o) => inRegion.has(o)).length;
      if (shared === 1) {
        const j = tris[t * 3 + (k + 1) % 3];
        outline.push(pos.getX(i), pos.getY(i), pos.getZ(i), pos.getX(j), pos.getY(j), pos.getZ(j));
      }
    }
  }
  return { fill, outline, tris: inRegion };
}

export class FaceHighlight {
  constructor(viewport) {
    this.viewport = viewport;
    this.group = new THREE.Group();
    this.group.matrixAutoUpdate = false;
    this.group.visible = false;
    this.fillMat = new THREE.MeshBasicMaterial({ color: NEON, transparent: true, opacity: 0.28, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    this.lineMat = new LineMaterial({ color: NEON, linewidth: 3, depthTest: false, transparent: true });
    this.fill = new THREE.Mesh(new THREE.BufferGeometry(), this.fillMat);
    this.line = new LineSegments2(new LineSegmentsGeometry(), this.lineMat);
    for (const o of [this.fill, this.line]) { o.raycast = () => {}; o.frustumCulled = false; }
    this.fill.renderOrder = 11; this.line.renderOrder = 12;
    this.group.add(this.fill, this.line);
    viewport.helpers.add(this.group);
  }

  /** Highlight the flat face of `mesh` around `faceIndex`; nothing (null mesh) hides it. */
  show(mesh, faceIndex) {
    if (!mesh || faceIndex == null) return this.hide();
    // moving across the same flat face keeps the region already drawn
    if (!(this.region && this.regionMesh === mesh && this.regionGeo === mesh.geometry && this.region.tris.has(faceIndex))) {
      const r = flatRegion(mesh.geometry, faceIndex);
      this.region = r; this.regionMesh = mesh; this.regionGeo = mesh.geometry;
      this.fill.geometry.dispose();
      this.fill.geometry = new THREE.BufferGeometry();
      this.fill.geometry.setAttribute('position', new THREE.Float32BufferAttribute(r.fill, 3));
      this.line.geometry.dispose();
      this.line.geometry = new LineSegmentsGeometry().setPositions(r.outline);
    }
    this.group.matrix.copy(mesh.matrixWorld);
    this.group.updateMatrixWorld(true);
    this.lineMat.resolution.set(this.viewport.width || 1, this.viewport.height || 1);
    this.group.visible = true;
    this.viewport.requestRender();
  }

  hide() {
    this.region = null; this.regionMesh = null; this.regionGeo = null;
    if (!this.group.visible) return;
    this.group.visible = false;
    this.viewport.requestRender();
  }
}
