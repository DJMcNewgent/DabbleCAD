// Print check: looks at what would be exported and reports the problems a slicer would
// otherwise surprise you with (open meshes, parts in mid-air, thin walls, overhangs, size).
import * as THREE from 'three';
import { bakedWorldGeometry, getGeometry } from './geometry.js';
import { toSolid, fromSolid, kernel } from './solid.js';

export const DEFAULT_BED = { x: 220, y: 220, z: 250 };
const PLA_DENSITY = 1.24; // g/cm3

export function printNodes(editor, selectedOnly = false) {
  const pool = selectedOnly ? editor.selectedNodes() : editor.doc.nodes;
  return pool.filter((n) => !n.hidden && !n.hole && getGeometry(n).attributes.position.count > 0);
}

/** One closed solid from every node, or null when some node is not a closed solid. */
export function fuseNodes(nodes) {
  const api = kernel();
  if (!api || !nodes.length) return null;
  const solids = [];
  try {
    for (const n of nodes) {
      const s = toSolid(bakedWorldGeometry(n, true));
      if (!s) return null;
      solids.push(s);
    }
    const all = solids.length === 1 ? solids[0] : api.Manifold.union(solids);
    if (all !== solids[0]) solids.push(all);
    if (all.status() !== 'NoError' || all.isEmpty()) return null;
    const parts = all.decompose();
    const info = { geometry: fromSolid(all), volume: all.volume(), area: all.surfaceArea(), parts: parts.map((p) => { const b = p.boundingBox(); return { minZ: b.min[2], volume: p.volume() }; }) };
    for (const p of parts) p.delete();
    return info;
  } catch (err) {
    console.warn('Could not fuse the design', err);
    return null;
  } finally {
    for (const s of solids) { try { s.delete(); } catch { /* freed */ } }
  }
}

/** Wall thickness and overhang survey of a closed mesh (non-indexed, world space). */
function surveyMesh(geo, minWall) {
  const pos = geo.attributes.position;
  const tris = pos.count / 3;
  geo.computeBoundsTree();
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  mesh.updateMatrixWorld(true);
  const ray = new THREE.Raycaster();
  ray.firstHitOnly = true;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3(), mid = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
  const stride = Math.max(1, Math.floor(tris / 4000));
  let thinnest = Infinity, thinArea = 0, sampledArea = 0, overhangArea = 0, thinAt = null;
  for (let t = 0; t < tris; t++) {
    a.fromBufferAttribute(pos, t * 3); b.fromBufferAttribute(pos, t * 3 + 1); c.fromBufferAttribute(pos, t * 3 + 2);
    n.crossVectors(e1.subVectors(b, a), e2.subVectors(c, a));
    const area = n.length() / 2;
    if (area < 1e-9) continue;
    n.normalize();
    mid.copy(a).add(b).add(c).multiplyScalar(1 / 3);
    // faces pointing down more steeply than 45 degrees need support unless they sit on the plate
    if (n.z < -0.7072 && mid.z > 0.15) overhangArea += area;
    if (t % stride) continue;
    sampledArea += area;
    ray.set(mid.clone().addScaledVector(n, -1e-3), n.clone().negate());
    const hit = ray.intersectObject(mesh, false)[0];
    if (!hit) continue;
    const d = hit.distance + 1e-3;
    if (d < thinnest) { thinnest = d; thinAt = mid.clone(); }
    if (d < minWall) thinArea += area;
  }
  geo.disposeBoundsTree();
  return { thinnest: isFinite(thinnest) ? thinnest : null, thinShare: sampledArea ? thinArea / sampledArea : 0, overhangArea, thinAt };
}

/**
 * Returns { items: [{ level: 'ok'|'warn'|'error', title, detail, fix? }], summary, fused }.
 * `fix` is one of 'drop' (rest the design on the plate).
 */
export function analyzePrint(editor, { selectedOnly = false, bed = DEFAULT_BED, minWall = 0.8 } = {}) {
  const nodes = printNodes(editor, selectedOnly);
  const items = [];
  if (!nodes.length) return { items: [{ level: 'error', title: 'Nothing to print', detail: selectedOnly ? 'Select at least one solid shape.' : 'Add a solid shape to the design first.' }], summary: null, fused: null };

  const box = new THREE.Box3();
  const open = [];
  let triangles = 0;
  nodes.forEach((n, i) => {
    const g = bakedWorldGeometry(n, false);
    g.computeBoundingBox();
    box.union(g.boundingBox);
    triangles += g.attributes.position.count / 3;
    const s = toSolid(g);
    if (s) s.delete(); else open.push(n.name || (n.type === 'group' ? 'Group' : n.kind) + ' ' + (i + 1));
  });
  const size = box.getSize(new THREE.Vector3());
  const fused = open.length ? null : fuseNodes(nodes);

  if (!kernel()) items.push({ level: 'warn', title: 'Solid checks are unavailable', detail: 'The solid kernel did not load, so only size and position were checked.' });
  else if (open.length) items.push({ level: 'error', title: `${open.length} shape${open.length > 1 ? 's are' : ' is'} not a closed solid`, detail: `${open.slice(0, 4).join(', ')}${open.length > 4 ? '…' : ''}. This usually comes from an imported mesh with gaps. A slicer may leave holes or skip layers; repair the model or rebuild that part from shapes.` });
  else items.push({ level: 'ok', title: 'Every shape is a closed solid', detail: 'The mesh is watertight, so a slicer can tell inside from outside.' });

  if (box.min.z > 0.05) items.push({ level: 'error', title: `The design floats ${box.min.z.toFixed(2)} mm above the plate`, detail: 'Nothing would touch the bed for the first layers.', fix: 'drop' });
  else if (box.min.z < -0.05) items.push({ level: 'warn', title: `The design reaches ${(-box.min.z).toFixed(2)} mm below the plate`, detail: 'A slicer will either cut that part off or lift the whole model.', fix: 'drop' });
  else items.push({ level: 'ok', title: 'The design rests on the plate', detail: '' });

  if (fused) {
    const floating = fused.parts.filter((p) => p.minZ > 0.05 && fused.parts.length > 1);
    if (floating.length && box.min.z <= 0.05) items.push({ level: 'error', title: `${floating.length} separate part${floating.length > 1 ? 's do' : ' does'} not touch the plate`, detail: 'These pieces are not connected to anything below them and would print in mid-air. Move them down, or connect them to the rest.' });
    else if (fused.parts.length > 1) items.push({ level: 'ok', title: `${fused.parts.length} separate parts, all on the plate`, detail: 'They will print as loose pieces.' });
    const survey = surveyMesh(fused.geometry, minWall);
    if (survey.thinnest !== null && survey.thinnest < minWall) items.push({ level: 'warn', title: `Thin walls: as little as ${survey.thinnest.toFixed(2)} mm`, detail: `About ${Math.max(1, Math.round(survey.thinShare * 100))}% of the surface is thinner than ${minWall} mm (two passes of a 0.4 mm nozzle). Thin areas may not print or may be fragile.` });
    else if (survey.thinnest !== null) items.push({ level: 'ok', title: `Walls are at least ${Math.min(survey.thinnest, 99).toFixed(1)} mm thick`, detail: '' });
    const share = fused.area ? survey.overhangArea / fused.area : 0;
    if (survey.overhangArea > 20 && share > 0.02) items.push({ level: 'warn', title: `Overhangs: about ${(survey.overhangArea / 100).toFixed(1)} cm² needs support`, detail: 'Faces that point downward more steeply than 45° print poorly without supports. Turn supports on in your slicer, or rotate the design so flat faces sit on the plate.' });
    else items.push({ level: 'ok', title: 'No significant overhangs', detail: '' });
  }

  const fits = size.x <= bed.x + 0.01 && size.y <= bed.y + 0.01 && size.z <= bed.z + 0.01;
  const fitsTurned = size.y <= bed.x + 0.01 && size.x <= bed.y + 0.01 && size.z <= bed.z + 0.01;
  const dims = `${size.x.toFixed(1)} × ${size.y.toFixed(1)} × ${size.z.toFixed(1)} mm`;
  if (fits) items.push({ level: 'ok', title: `Fits the printer (${dims})`, detail: '' });
  else if (fitsTurned) items.push({ level: 'warn', title: `Fits only when turned 90° (${dims})`, detail: `The bed is ${bed.x} × ${bed.y} × ${bed.z} mm.` });
  else items.push({ level: 'error', title: `Too big for the printer (${dims})`, detail: `The bed is ${bed.x} × ${bed.y} × ${bed.z} mm. Scale the design down or split it.` });

  const volume = fused ? fused.volume : null;
  const summary = { size: [size.x, size.y, size.z], triangles, volumeCm3: volume !== null ? volume / 1000 : null, grams: volume !== null ? (volume / 1000) * PLA_DENSITY : null, minZ: box.min.z };
  if (fused) fused.geometry.dispose();
  return { items, summary, fused: !!fused };
}

/** Geometry list for export: one fused closed solid when possible, else null. */
export function fusedExportGeometry(nodes) {
  const f = fuseNodes(nodes);
  return f && f.parts.length ? f.geometry : null;
}
