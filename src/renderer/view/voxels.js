// Blocks / Bricks views: re-renders the design as voxels (cubes) or studded bricks.
import * as THREE from 'three';
import { bakedWorldGeometry, getGeometry } from '../core/geometry.js';

const BRICK = { x: 8, y: 8, z: 9.6 };

export function buildVoxels(editor, { mode = 'blocks', detail = 24 } = {}) {
  const nodes = editor.doc.nodes.filter((n) => !n.hidden && !n.hole && getGeometry(n).attributes.position.count > 0);
  const group = new THREE.Group();
  if (!nodes.length) return { group, count: 0, cell: null };
  const geos = nodes.map((n) => {
    const g = bakedWorldGeometry(n, true);
    g.computeBoundingBox();
    try { g.computeBoundsTree(); } catch { /* brute force */ }
    return g;
  });
  const box = new THREE.Box3();
  for (const g of geos) box.union(g.boundingBox);
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z, 1e-3);
  let cell;
  if (mode === 'bricks') {
    const f = Math.max(maxDim / (detail * BRICK.x), 0.02);
    cell = new THREE.Vector3(BRICK.x * f, BRICK.y * f, BRICK.z * f);
  } else {
    const s = maxDim / detail;
    cell = new THREE.Vector3(s, s, s);
  }
  const nx = Math.max(1, Math.ceil(size.x / cell.x)), ny = Math.max(1, Math.ceil(size.y / cell.y)), nz = Math.max(1, Math.ceil(size.z / cell.z));
  const origin = new THREE.Vector3(
    (box.min.x + box.max.x) / 2 - (nx * cell.x) / 2,
    (box.min.y + box.max.y) / 2 - (ny * cell.y) / 2,
    box.min.z);
  const filled = new Uint8Array(nx * ny * nz);
  const colors = new Float32Array(nx * ny * nz * 3);
  const at = (i, j, k) => (k * ny + j) * nx + i;
  const raycaster = new THREE.Raycaster();
  const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  const up = new THREE.Vector3(0, 0, 1);
  const col = new THREE.Color();

  geos.forEach((g, gi) => {
    const mesh = new THREE.Mesh(g, material);
    mesh.updateMatrixWorld(true);
    const bb = g.boundingBox;
    const i0 = Math.max(0, Math.floor((bb.min.x - origin.x) / cell.x)), i1 = Math.min(nx - 1, Math.floor((bb.max.x - origin.x) / cell.x));
    const j0 = Math.max(0, Math.floor((bb.min.y - origin.y) / cell.y)), j1 = Math.min(ny - 1, Math.floor((bb.max.y - origin.y) / cell.y));
    const cAttr = g.attributes.color;
    col.set(nodes[gi].color);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        // tiny offset keeps rays off shared edges and vertices
        const x = origin.x + (i + 0.5031) * cell.x, y = origin.y + (j + 0.4973) * cell.y;
        raycaster.set(new THREE.Vector3(x, y, bb.min.z - 1), up);
        const hits = raycaster.intersectObject(mesh, false);
        if (hits.length < 2) continue;
        let depth = 0, enter = 0, enterColor = null;
        for (const hit of hits) {
          const entering = hit.face.normal.z < 0;
          if (entering) {
            if (depth === 0) { enter = hit.point.z; enterColor = cAttr ? [cAttr.getX(hit.face.a), cAttr.getY(hit.face.a), cAttr.getZ(hit.face.a)] : [col.r, col.g, col.b]; }
            depth += 1;
          } else if (depth > 0) {
            depth -= 1;
            if (depth === 0) {
              // fill every cell whose centre lies inside the solid span
              const k0 = Math.max(0, Math.ceil((enter - origin.z) / cell.z - 0.5));
              const k1 = Math.min(nz - 1, Math.floor((hit.point.z - origin.z) / cell.z - 0.5));
              for (let k = k0; k <= k1; k++) {
                const idx = at(i, j, k);
                filled[idx] = 1;
                colors[idx * 3] = enterColor[0]; colors[idx * 3 + 1] = enterColor[1]; colors[idx * 3 + 2] = enterColor[2];
              }
            }
          }
        }
      }
    }
    g.disposeBoundsTree && g.disposeBoundsTree();
    g.dispose();
  });

  const isFilled = (i, j, k) => i >= 0 && j >= 0 && k >= 0 && i < nx && j < ny && k < nz && filled[at(i, j, k)] === 1;
  const cells = [];
  const studs = [];
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    if (!filled[at(i, j, k)]) continue;
    const surface = !(isFilled(i - 1, j, k) && isFilled(i + 1, j, k) && isFilled(i, j - 1, k) && isFilled(i, j + 1, k) && isFilled(i, j, k - 1) && isFilled(i, j, k + 1));
    if (surface) cells.push([i, j, k]);
    if (mode === 'bricks' && !isFilled(i, j, k + 1)) studs.push([i, j, k]);
  }
  const gap = mode === 'bricks' ? 0.985 : 0.97;
  const boxGeo = new THREE.BoxGeometry(cell.x * gap, cell.y * gap, cell.z * (mode === 'bricks' ? 0.995 : gap));
  const mat = new THREE.MeshStandardMaterial({ roughness: mode === 'bricks' ? 0.35 : 0.8, metalness: 0.02 });
  const inst = new THREE.InstancedMesh(boxGeo, mat, Math.max(1, cells.length));
  inst.count = cells.length;
  const m = new THREE.Matrix4();
  cells.forEach(([i, j, k], n) => {
    m.makeTranslation(origin.x + (i + 0.5) * cell.x, origin.y + (j + 0.5) * cell.y, origin.z + (k + 0.5) * cell.z);
    inst.setMatrixAt(n, m);
    const idx = at(i, j, k) * 3;
    inst.setColorAt(n, col.setRGB(colors[idx], colors[idx + 1], colors[idx + 2]));
  });
  inst.castShadow = true;
  inst.receiveShadow = true;
  inst.instanceMatrix.needsUpdate = true;
  if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
  group.add(inst);
  if (studs.length) {
    const studGeo = new THREE.CylinderGeometry(cell.x * 0.3, cell.x * 0.3, cell.z * 0.18, 16);
    studGeo.rotateX(Math.PI / 2);
    const sInst = new THREE.InstancedMesh(studGeo, mat, studs.length);
    studs.forEach(([i, j, k], n) => {
      m.makeTranslation(origin.x + (i + 0.5) * cell.x, origin.y + (j + 0.5) * cell.y, origin.z + (k + 1) * cell.z + cell.z * 0.09);
      sInst.setMatrixAt(n, m);
      const idx = at(i, j, k) * 3;
      sInst.setColorAt(n, col.setRGB(colors[idx], colors[idx + 1], colors[idx + 2]));
    });
    sInst.castShadow = true;
    group.add(sInst);
  }
  let total = 0;
  for (let i = 0; i < filled.length; i++) total += filled[i];
  return { group, count: total, cell, dims: [nx, ny, nz] };
}

export function disposeVoxels(group) {
  group.traverse((o) => {
    if (o.isInstancedMesh) o.dispose(); // instance matrix / colour buffers
    if (o.geometry) o.geometry.dispose();
    if (o.material) o.material.dispose();
  });
}
