// Mesh editing mode: sculpt brushes and face selection on one object at a time.
// The object is turned into a welded triangle mesh while the mode is open and written back
// to the design as a mesh shape when it is closed with Done.
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import * as ops from '../core/meshops.js';
import { cloneNode } from '../core/doc.js';

export const BRUSHES = [
  ['draw', 'Draw', 'Raise the surface. Alt lowers it.'],
  ['draw2', 'Draw 2', 'Build up an even layer in one direction.'],
  ['inflate', 'Inflate', 'Swell the surface outward. Alt deflates.'],
  ['flatten', 'Flatten', 'Press the surface toward a flat plane.'],
  ['pinch', 'Pinch', 'Pull the surface toward the brush centre. Alt spreads it.'],
  ['move', 'Move', 'Grab a region and pull it.'],
  ['drag', 'Drag', 'Pull the surface along with the pointer.'],
  ['spike', 'Spike', 'Raise a sharp point.'],
  ['smooth', 'Robust smooth', 'Smooth without shrinking.'],
  ['shrink', 'Shrink smooth', 'Smooth strongly; thin parts get thinner.'],
  ['bubble', 'Bubble smooth', 'Smooth and puff out.'],
  ['attract', 'Attract', 'Pull the surface back toward its shape when editing started.'],
  ['paint', 'Paint vertex', 'Paint colour onto the surface.'],
];
export const FALLOFFS = [['smooth', 'Smooth'], ['linear', 'Linear'], ['sharp', 'Sharp'], ['flat', 'Flat']];

const GROUP_COLORS = ['#e53935', '#fb8c00', '#fdd835', '#7cb342', '#00897b', '#039be5', '#3949ab', '#8e24aa', '#d81b60', '#6d4c41', '#90a4ae', '#c0ca33'];
const UNDO_LIMIT = 40;

const falloff = (kind, x) => {
  if (x >= 1) return 0;
  if (kind === 'linear') return 1 - x;
  if (kind === 'sharp') return (1 - x) ** 3;
  if (kind === 'flat') return x < 0.85 ? 1 : (1 - x) / 0.15;
  return (1 - x * x) ** 2;
};

export class MeshMode {
  constructor(app) {
    this.app = app;
    this.vp = app.viewport;
    this.ed = app.editor;
    this.active = false;
    this.sub = 'sculpt'; // 'sculpt' | 'select'
    this.brush = { type: 'draw', size: 8, strength: 0.5, falloff: 'smooth', symmetry: false, color: '#e53935' };
    this.selectTool = 'brush'; // 'brush' | 'lasso'
    this.showWire = false;
    this.showGroups = false;
    this.listeners = [];
  }

  onChange(fn) { this.listeners.push(fn); }
  _notify() { for (const fn of this.listeners) fn(); }

  // ---------------------------------------------------------------- enter / exit
  enter(node, sub = 'sculpt') {
    if (this.active || !node) return false;
    let M = ops.nodeToMesh(node);
    if (M.t.length < 3) return false;
    this.colored = !!M.c;
    if (!M.c) {
      const col = new THREE.Color(node.color), c = new Float32Array(M.v.length);
      for (let i = 0; i < c.length; i += 3) { c[i] = col.r; c[i + 1] = col.g; c[i + 2] = col.b; }
      M = { ...M, c };
    }
    this.active = true;
    this.sub = sub;
    this.nodeId = node.id;
    this.base = cloneNode(node);
    this.dirty = false;
    this.sculpted = false;
    this.undoStack = [];
    this.redoStack = [];
    this.original = { v: Float32Array.from(M.v), t: Uint32Array.from(M.t) };
    this.originalBvh = null;
    const bb = ops.meshBounds(M);
    this.mirrorX = bb.center[0];
    this.scale = Math.max(...bb.size);
    this.brush.size = Math.max(0.2, Math.min(this.brush.size, this.scale));

    this.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0.03, side: THREE.DoubleSide });
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.mesh.matrixAutoUpdate = false;
    this.mesh.castShadow = true;
    this.wire = new THREE.Mesh(this.mesh.geometry, new THREE.MeshBasicMaterial({ color: 0x000000, wireframe: true, transparent: true, opacity: 0.22, depthWrite: false }));
    this.wire.raycast = () => {};
    this.wire.visible = this.showWire;
    this.selMesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color: 0xff8f1f, transparent: true, opacity: 0.6, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
    this.selMesh.raycast = () => {};
    this.groupMesh = new THREE.Mesh(new THREE.BufferGeometry(), GROUP_COLORS.map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.7, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -0.5, polygonOffsetUnits: -0.5 })));
    this.groupMesh.raycast = () => {};
    this.groupMesh.visible = false;
    const ringPts = [];
    for (let i = 0; i <= 64; i++) ringPts.push(new THREE.Vector3(Math.cos((i / 64) * Math.PI * 2), Math.sin((i / 64) * Math.PI * 2), 0));
    this.ring = new THREE.Line(new THREE.BufferGeometry().setFromPoints(ringPts), new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.9 }));
    this.ring.renderOrder = 50;
    this.ring.visible = false;
    this.ring.raycast = () => {};
    this.vp.objects.add(this.mesh);
    this.vp.helpers.add(this.wire, this.selMesh, this.groupMesh, this.ring);
    this.setMesh(M, null);

    this.savedSelection = [...this.ed.selection];
    this.ed.setTool('select');
    this.ed.select([]);
    this.ed.disabled = true;
    const own = this.ed.meshes.get(node.id);
    if (own) own.visible = false;
    this.savedHandlers = { ...this.vp.handlers };
    this.vp.handlers.leftDown = (e) => this._down(e);
    this.vp.handlers.hover = (e) => this._hover(e);
    this.vp.handlers.leave = () => { this.ring.visible = false; this.vp.requestRender(); };
    this.vp.handlers.dblclick = (e) => this._dblclick(e);
    this.vp.handlers.contextMenu = () => {};
    this.savedFirstHit = this.vp.raycaster.firstHitOnly;
    this.vp.raycaster.firstHitOnly = true;
    document.getElementById('app').classList.add('mesh-mode');
    this.vp.canvas.style.cursor = 'crosshair';
    this.vp.requestRender();
    this._notify();
    return true;
  }

  /** Leave the mode. accept = keep the changes (one undo step in the design). */
  exit(accept = true) {
    if (!this.active) return;
    this.active = false;
    Object.assign(this.vp.handlers, { leave: undefined }, this.savedHandlers);
    this.vp.raycaster.firstHitOnly = this.savedFirstHit;
    this.vp.objects.remove(this.mesh);
    this.vp.helpers.remove(this.wire, this.selMesh, this.groupMesh, this.ring);
    this.mesh.geometry.dispose(); this.material.dispose();
    this.selMesh.geometry.dispose(); this.selMesh.material.dispose(); this.wire.material.dispose();
    this.groupMesh.geometry.dispose(); for (const m of this.groupMesh.material) m.dispose();
    this.ring.geometry.dispose(); this.ring.material.dispose();
    if (this.lassoEl) { this.lassoEl.remove(); this.lassoEl = null; }
    document.getElementById('app').classList.remove('mesh-mode');
    this.vp.canvas.style.cursor = '';
    const ed = this.ed;
    ed.disabled = false;
    const still = ed.node(this.nodeId);
    if (accept && this.dirty && still) {
      const M = this.colored ? this.M : { ...this.M, c: null };
      const node = ops.meshNode(M, this.base, { smooth: this.sculpted, keepId: true });
      ed.replaceNodes([this.nodeId], [node]);
    } else {
      // cancelled: the faces go back into this shape, so the pieces separated from it must not stay behind as copies
      const pieces = accept ? [] : this.undoStack.filter((e) => e.piece && !e.has && ed.node(e.piece.id)).map((e) => e.piece.id);
      if (pieces.length) ed.replaceNodes(pieces, [], { select: false });
      ed.sync();
      ed.select(this.savedSelection.filter((id) => ed.node(id)));
    }
    this.M = null; this.original = null; this.originalBvh = null; this.undoStack = []; this.redoStack = [];
    this.vp.requestRender();
    this._notify();
  }

  setSub(sub) { if (!this.active) return; this.sub = sub; this.ring.visible = false; this._refreshOverlays(); this._notify(); }
  setBrush(patch) { Object.assign(this.brush, patch); this._notify(); }
  setWire(on) { this.showWire = on; if (this.wire) this.wire.visible = on; this.vp.requestRender(); this._notify(); }
  setShowGroups(on) { this.showGroups = on; this._refreshOverlays(); this._notify(); }

  // ---------------------------------------------------------------- working mesh
  setMesh(M, sel) {
    this.M = M;
    const nv = M.v.length / 3, nt = M.t.length / 3;
    const geo = new THREE.BufferGeometry();
    this.normals = ops.vertexNormals(M);
    geo.setAttribute('position', new THREE.BufferAttribute(M.v, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(this.normals, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(M.c, 3));
    geo.setIndex(new THREE.BufferAttribute(M.t, 1));
    geo.boundsTree = new MeshBVH(geo, { indirect: true });
    geo.computeBoundingSphere();
    const old = this.mesh.geometry;
    this.mesh.geometry = geo;
    this.wire.geometry = geo;
    if (old) { old.boundsTree = undefined; old.dispose(); }
    this.nb = ops.vertexNeighbors(M);
    this.vtri = ops.vertexTriangles(M);
    this.sel = sel && sel.length === nt ? sel : new Uint8Array(nt);
    this.stamp = new Uint32Array(nv); this.stampId = 0;
    this.strokeStamp = new Uint32Array(nv); this.strokeId = 0;
    this.dist = new Float32Array(nv);
    this._refreshOverlays();
  }

  _refreshOverlays() {
    if (!this.M) return;
    const M = this.M, nt = M.t.length / 3;
    const pos = this.mesh.geometry.attributes.position, nrm = this.mesh.geometry.attributes.normal;
    // selected faces
    let count = 0;
    for (let i = 0; i < nt; i++) if (this.sel[i]) count += 1;
    const idx = new Uint32Array(count * 3);
    let o = 0;
    for (let i = 0; i < nt; i++) if (this.sel[i]) { idx[o++] = M.t[i * 3]; idx[o++] = M.t[i * 3 + 1]; idx[o++] = M.t[i * 3 + 2]; }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', pos);
    sg.setIndex(new THREE.BufferAttribute(idx, 1));
    this.selMesh.geometry.dispose();
    this.selMesh.geometry = sg;
    this.selMesh.visible = this.sub === 'select' && count > 0;
    this.selCount = count;
    // face groups, drawn in place of the plain surface
    const showGroups = this.showGroups && !!M.g && this.sub === 'select';
    this.groupMesh.visible = showGroups;
    if (showGroups) {
      const order = Array.from({ length: nt }, (_, i) => i).sort((a, b) => M.g[a] - M.g[b]);
      const gi = new Uint32Array(nt * 3), gg = new THREE.BufferGeometry();
      gg.setAttribute('position', pos); gg.setAttribute('normal', nrm);
      let start = 0;
      order.forEach((ti, k) => {
        gi[k * 3] = M.t[ti * 3]; gi[k * 3 + 1] = M.t[ti * 3 + 1]; gi[k * 3 + 2] = M.t[ti * 3 + 2];
        const next = order[k + 1];
        if (next === undefined || M.g[next] !== M.g[ti]) { const g = M.g[ti]; gg.addGroup(start * 3, (k + 1 - start) * 3, g < 0 ? 10 : g % GROUP_COLORS.length); start = k + 1; }
      });
      gg.setIndex(new THREE.BufferAttribute(gi, 1));
      this.groupMesh.geometry.dispose();
      this.groupMesh.geometry = gg;
    }
    this.vp.requestRender();
  }

  _touchGeometry(normalsToo = true) {
    const g = this.mesh.geometry;
    g.attributes.position.needsUpdate = true;
    if (normalsToo) g.attributes.normal.needsUpdate = true;
    g.attributes.color.needsUpdate = true;
    this.vp.requestRender();
  }

  // ---------------------------------------------------------------- undo
  _pushUndo(entry) {
    this.undoStack.push(entry);
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.dirty = true;
    this._notify();
  }

  _snapshot() { return { kind: 'mesh', M: ops.cloneMesh(this.M), sel: Uint8Array.from(this.sel) }; }

  _swap(entry) {
    if (entry.kind === 'mesh') {
      const now = this._snapshot();
      this.setMesh(entry.M, entry.sel);
      // "Separate" also made a shape in the design: it comes and goes with its step
      if (entry.piece) { this._setPiece(entry.piece, entry.has); now.piece = entry.piece; now.has = !entry.has; }
      return now;
    }
    if (entry.kind === 'sel') {
      const now = { kind: 'sel', sel: Uint8Array.from(this.sel) };
      if (entry.sel.length === this.sel.length) this.sel = entry.sel;
      this._refreshOverlays();
      return now;
    }
    const { idx } = entry, v = this.M.v, c = this.M.c;
    const pos = new Float32Array(idx.length * 3), col = new Float32Array(idx.length * 3);
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k] * 3;
      for (let a = 0; a < 3; a++) { pos[k * 3 + a] = v[i + a]; col[k * 3 + a] = c[i + a]; v[i + a] = entry.pos[k * 3 + a]; c[i + a] = entry.col[k * 3 + a]; }
    }
    ops.vertexNormals(this.M, this.normals);
    this.mesh.geometry.boundsTree.refit();
    this._touchGeometry();
    return { kind: 'verts', idx, pos, col };
  }

  /** Put a separated piece into the design, or take it out again. */
  _setPiece(node, present) {
    const ed = this.ed, there = !!ed.node(node.id);
    if (present && !there) ed.addNode(cloneNode(node), { select: false });
    else if (!present && there) ed.replaceNodes([node.id], [], { select: false });
    const own = ed.meshes.get(this.nodeId);
    if (own) own.visible = false;
    this.vp.requestRender();
  }

  undo() { const e = this.undoStack.pop(); if (!e) return; this.redoStack.push(this._swap(e)); this._notify(); }
  redo() { const e = this.redoStack.pop(); if (!e) return; this.undoStack.push(this._swap(e)); this._notify(); }
  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  // ---------------------------------------------------------------- picking
  _hit(e) {
    const hits = this.vp.pick(e.clientX, e.clientY, [this.mesh]);
    if (!hits.length) return null;
    const h = hits[0], t = this.M.t, v = this.M.v, f = h.faceIndex;
    const a = t[f * 3] * 3, b = t[f * 3 + 1] * 3, c = t[f * 3 + 2] * 3;
    const n = new THREE.Vector3(v[b] - v[a], v[b + 1] - v[a + 1], v[b + 2] - v[a + 2]).cross(new THREE.Vector3(v[c] - v[a], v[c + 1] - v[a + 1], v[c + 2] - v[a + 2])).normalize();
    if (n.dot(this.vp.raycaster.ray.direction) > 0) n.negate(); // looking at the back of an open surface
    return { point: h.point.clone(), tri: f, normal: n };
  }

  /** Vertices connected to a triangle and within `radius` of `center`. Fills this.dist; returns the list. */
  _gather(center, radius, tri) {
    const id = ++this.stampId, stamp = this.stamp, v = this.M.v, nb = this.nb, list = [], stack = [];
    const r2 = radius * radius;
    for (let k = 0; k < 3; k++) { const s = this.M.t[tri * 3 + k]; stamp[s] = id; stack.push(s); }
    while (stack.length) {
      const i = stack.pop();
      const dx = v[i * 3] - center.x, dy = v[i * 3 + 1] - center.y, dz = v[i * 3 + 2] - center.z, d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > r2) continue;
      this.dist[i] = Math.sqrt(d2);
      list.push(i);
      for (let k = nb.start[i]; k < nb.start[i + 1]; k++) { const j = nb.list[k]; if (stamp[j] !== id) { stamp[j] = id; stack.push(j); } }
    }
    return list;
  }

  _record(i) {
    if (this.strokeStamp[i] === this.strokeId) return;
    this.strokeStamp[i] = this.strokeId;
    const v = this.M.v, c = this.M.c, s = this.stroke;
    s.idx.push(i); s.pos.push(v[i * 3], v[i * 3 + 1], v[i * 3 + 2]); s.col.push(c[i * 3], c[i * 3 + 1], c[i * 3 + 2]);
  }

  _renormal(list) {
    const id = ++this.stampId, stamp = this.stamp, nb = this.nb, vt = this.vtri, n = this.normals, v = this.M.v, t = this.M.t;
    const todo = [];
    for (const i of list) {
      if (stamp[i] !== id) { stamp[i] = id; todo.push(i); }
      for (let k = nb.start[i]; k < nb.start[i + 1]; k++) { const j = nb.list[k]; if (stamp[j] !== id) { stamp[j] = id; todo.push(j); } }
    }
    for (const i of todo) {
      let x = 0, y = 0, z = 0;
      for (let k = vt.start[i]; k < vt.start[i + 1]; k++) {
        const f = vt.list[k] * 3, a = t[f] * 3, b = t[f + 1] * 3, c = t[f + 2] * 3;
        const ux = v[b] - v[a], uy = v[b + 1] - v[a + 1], uz = v[b + 2] - v[a + 2], wx = v[c] - v[a], wy = v[c + 1] - v[a + 1], wz = v[c + 2] - v[a + 2];
        x += uy * wz - uz * wy; y += uz * wx - ux * wz; z += ux * wy - uy * wx;
      }
      const l = Math.hypot(x, y, z) || 1;
      n[i * 3] = x / l; n[i * 3 + 1] = y / l; n[i * 3 + 2] = z / l;
    }
  }

  // ---------------------------------------------------------------- brushes
  /** One brush stamp. `ctx` carries the stroke direction and pointer movement. */
  _dab(type, center, normal, tri, sign, ctx) {
    const b = this.brush, r = b.size, s = b.strength;
    const list = this._gather(center, r, tri);
    if (!list.length) return;
    const v = this.M.v, c = this.M.c, n = this.normals, dist = this.dist;
    const kind = type === 'spike' ? 'sharp' : b.falloff;
    const amt = r * 0.1 * s * sign;
    for (const i of list) this._record(i);
    if (type === 'draw' || type === 'spike' || type === 'draw2') {
      let nx = 0, ny = 0, nz = 0;
      if (type === 'draw2') { nx = ctx.dir.x; ny = ctx.dir.y; nz = ctx.dir.z; } else {
        for (const i of list) { const w = falloff(kind, dist[i] / r); nx += n[i * 3] * w; ny += n[i * 3 + 1] * w; nz += n[i * 3 + 2] * w; }
        const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
      }
      const k = type === 'spike' ? amt * 2 : amt;
      for (const i of list) {
        let w = falloff(kind, dist[i] / r);
        if (type === 'draw2') w = Math.min(1, w * 1.8);
        v[i * 3] += nx * k * w; v[i * 3 + 1] += ny * k * w; v[i * 3 + 2] += nz * k * w;
      }
    } else if (type === 'inflate') {
      for (const i of list) { const w = falloff(kind, dist[i] / r) * amt; v[i * 3] += n[i * 3] * w; v[i * 3 + 1] += n[i * 3 + 1] * w; v[i * 3 + 2] += n[i * 3 + 2] * w; }
    } else if (type === 'flatten') {
      let px = 0, py = 0, pz = 0, nx = 0, ny = 0, nz = 0, ws = 0;
      for (const i of list) { const w = falloff(kind, dist[i] / r); px += v[i * 3] * w; py += v[i * 3 + 1] * w; pz += v[i * 3 + 2] * w; nx += n[i * 3] * w; ny += n[i * 3 + 1] * w; nz += n[i * 3 + 2] * w; ws += w; }
      if (ws < 1e-9) return;
      px /= ws; py /= ws; pz /= ws;
      const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
      for (const i of list) {
        const w = falloff(kind, dist[i] / r) * Math.min(1, s * 1.2);
        const d = (v[i * 3] - px) * nx + (v[i * 3 + 1] - py) * ny + (v[i * 3 + 2] - pz) * nz;
        v[i * 3] -= nx * d * w; v[i * 3 + 1] -= ny * d * w; v[i * 3 + 2] -= nz * d * w;
      }
    } else if (type === 'pinch') {
      for (const i of list) {
        const w = falloff(kind, dist[i] / r) * s * 0.3 * sign;
        v[i * 3] += (center.x - v[i * 3]) * w; v[i * 3 + 1] += (center.y - v[i * 3 + 1]) * w; v[i * 3 + 2] += (center.z - v[i * 3 + 2]) * w;
      }
    } else if (type === 'drag') {
      for (const i of list) { const w = falloff(kind, dist[i] / r); v[i * 3] += ctx.delta.x * w; v[i * 3 + 1] += ctx.delta.y * w; v[i * 3 + 2] += ctx.delta.z * w; }
    } else if (type === 'smooth' || type === 'shrink' || type === 'bubble') {
      const nb = this.nb, tmp = new Float32Array(list.length * 3);
      const pass = (f) => {
        list.forEach((i, k) => {
          const a = nb.start[i], e = nb.start[i + 1];
          let x = 0, y = 0, z = 0;
          for (let q = a; q < e; q++) { const j = nb.list[q] * 3; x += v[j]; y += v[j + 1]; z += v[j + 2]; }
          const m = e - a || 1, w = falloff(kind, dist[i] / r) * f;
          tmp[k * 3] = v[i * 3] + (x / m - v[i * 3]) * w; tmp[k * 3 + 1] = v[i * 3 + 1] + (y / m - v[i * 3 + 1]) * w; tmp[k * 3 + 2] = v[i * 3 + 2] + (z / m - v[i * 3 + 2]) * w;
        });
        list.forEach((i, k) => { v[i * 3] = tmp[k * 3]; v[i * 3 + 1] = tmp[k * 3 + 1]; v[i * 3 + 2] = tmp[k * 3 + 2]; });
      };
      const f = Math.min(0.9, 0.25 + s * 0.6);
      pass(f);
      if (type === 'smooth') pass(-f * 0.5);
      if (type === 'bubble') for (const i of list) { const w = falloff(kind, dist[i] / r) * r * 0.03 * s; v[i * 3] += n[i * 3] * w; v[i * 3 + 1] += n[i * 3 + 1] * w; v[i * 3 + 2] += n[i * 3 + 2] * w; }
    } else if (type === 'attract') {
      if (!this.originalBvh) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(this.original.v, 3));
        g.setIndex(new THREE.BufferAttribute(this.original.t, 1));
        this.originalBvh = new MeshBVH(g);
      }
      const p = new THREE.Vector3(), target = {};
      for (const i of list) {
        p.set(v[i * 3], v[i * 3 + 1], v[i * 3 + 2]);
        const hit = this.originalBvh.closestPointToPoint(p, target);
        if (!hit) continue;
        const w = falloff(kind, dist[i] / r) * Math.min(1, s * 0.8);
        v[i * 3] += (hit.point.x - p.x) * w; v[i * 3 + 1] += (hit.point.y - p.y) * w; v[i * 3 + 2] += (hit.point.z - p.z) * w;
      }
    } else if (type === 'paint') {
      const col = new THREE.Color(b.color);
      for (const i of list) { const w = falloff(kind, dist[i] / r) * Math.min(1, s * 1.5); c[i * 3] += (col.r - c[i * 3]) * w; c[i * 3 + 1] += (col.g - c[i * 3 + 1]) * w; c[i * 3 + 2] += (col.b - c[i * 3 + 2]) * w; }
      this.colored = true;
      return;
    }
    this._renormal(list);
    this.sculpted = true;
  }

  _mirrorHit(point, normal) {
    const p = new THREE.Vector3(2 * this.mirrorX - point.x, point.y, point.z);
    if (Math.abs(p.x - point.x) < this.brush.size * 0.4) return null;
    const hit = this.mesh.geometry.boundsTree.closestPointToPoint(p, {});
    if (!hit || hit.distance > this.brush.size) return null;
    return { point: p, tri: hit.faceIndex, normal: new THREE.Vector3(-normal.x, normal.y, normal.z) };
  }

  _stamp(type, hit, sign, ctx) {
    this._dab(type, hit.point, hit.normal, hit.tri, sign, ctx);
    if (!this.brush.symmetry) return;
    const m = this._mirrorHit(hit.point, hit.normal);
    if (!m) return;
    const mctx = { dir: ctx.dir ? new THREE.Vector3(-ctx.dir.x, ctx.dir.y, ctx.dir.z) : null, delta: ctx.delta ? new THREE.Vector3(-ctx.delta.x, ctx.delta.y, ctx.delta.z) : null };
    this._dab(type, m.point, m.normal, m.tri, sign, mctx);
  }

  _beginStroke() {
    this.strokeId += 1;
    this.stroke = { idx: [], pos: [], col: [] };
  }

  _endStroke() {
    const s = this.stroke;
    this.stroke = null;
    if (!s || !s.idx.length) return;
    this.mesh.geometry.computeBoundingSphere();
    this._pushUndo({ kind: 'verts', idx: Uint32Array.from(s.idx), pos: Float32Array.from(s.pos), col: Float32Array.from(s.col) });
  }

  /** Programmatic stroke along world-space points on the surface (also used by the tests). */
  strokeAt(points, { type = this.brush.type, sign = 1 } = {}) {
    this._beginStroke();
    const ray = new THREE.Ray();
    let last = null;
    for (const p of points) {
      const pt = new THREE.Vector3(...p);
      const cp = this.mesh.geometry.boundsTree.closestPointToPoint(pt, {});
      if (!cp) continue;
      const f = cp.faceIndex, t = this.M.t, v = this.M.v, a = t[f * 3] * 3, b = t[f * 3 + 1] * 3, c = t[f * 3 + 2] * 3;
      const n = new THREE.Vector3(v[b] - v[a], v[b + 1] - v[a + 1], v[b + 2] - v[a + 2]).cross(new THREE.Vector3(v[c] - v[a], v[c + 1] - v[a + 1], v[c + 2] - v[a + 2])).normalize();
      const hit = { point: cp.point.clone(), tri: f, normal: n };
      const delta = last ? hit.point.clone().sub(last) : new THREE.Vector3();
      this._stamp(type, hit, sign, { dir: n, delta });
      last = hit.point;
      this.mesh.geometry.boundsTree.refit();
    }
    void ray;
    this._touchGeometry();
    this._endStroke();
  }

  _track(e, onMove, onEnd) {
    const el = this.vp.canvas;
    try { el.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    // the mode can be finished (Enter) while the button is still down: the stroke then has nothing to act on
    const move = (ev) => { if (this.active && this.M) onMove(ev); };
    const up = (ev) => {
      try { el.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      if (this.active && this.M) onEnd(ev);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  _down(e) {
    if (this.sub === 'select') return this.selectTool === 'lasso' ? this._lasso(e) : this._paintSelect(e);
    const hit = this._hit(e);
    if (!hit) return;
    const type = e.shiftKey ? 'smooth' : this.brush.type;
    const sign = e.altKey ? -1 : 1;
    this._beginStroke();
    const viewDir = this.vp.viewDirection();
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(viewDir, hit.point);
    const onPlane = (ev) => this.vp.rayFromClient(ev.clientX, ev.clientY).intersectPlane(plane, new THREE.Vector3());
    const dir = hit.normal.clone();
    if (type === 'move') {
      // the grabbed vertices are fixed for the whole stroke
      const grab = (h) => { const list = this._gather(h.point, this.brush.size, h.tri); for (const i of list) this._record(i); return { list, w: list.map((i) => falloff(this.brush.falloff, this.dist[i] / this.brush.size)), start: list.map((i) => [this.M.v[i * 3], this.M.v[i * 3 + 1], this.M.v[i * 3 + 2]]) }; };
      const sets = [{ ...grab(hit), flip: 1 }];
      const m = this.brush.symmetry ? this._mirrorHit(hit.point, hit.normal) : null;
      if (m) sets.push({ ...grab(m), flip: -1 });
      const p0 = hit.point.clone();
      this._track(e, (ev) => {
        const p = onPlane(ev);
        if (!p) return;
        const d = p.sub(p0), v = this.M.v;
        for (const set of sets) set.list.forEach((i, k) => { const w = set.w[k], s = set.start[k]; v[i * 3] = s[0] + d.x * w * set.flip; v[i * 3 + 1] = s[1] + d.y * w; v[i * 3 + 2] = s[2] + d.z * w; });
        for (const set of sets) this._renormal(set.list);
        this.sculpted = true;
        this.mesh.geometry.boundsTree.refit();
        this._touchGeometry();
      }, () => this._endStroke());
      return;
    }
    let last = hit.point.clone(), lastPlane = hit.point.clone(), cur = hit;
    this._stamp(type, hit, sign, { dir, delta: new THREE.Vector3() });
    this.mesh.geometry.boundsTree.refit();
    this._touchGeometry();
    this._track(e, (ev) => {
      if (type === 'drag') {
        const p = onPlane(ev);
        if (!p) return;
        const delta = p.clone().sub(lastPlane);
        lastPlane = p;
        this._stamp('drag', cur, 1, { dir, delta });
        cur = { ...cur, point: cur.point.clone().add(delta) };
        const h = this._hit(ev);
        if (h) cur = h;
      } else {
        const h = this._hit(ev);
        if (!h) return;
        this._placeRing(h);
        const step = Math.max(this.brush.size * 0.22, 1e-3), gap = h.point.distanceTo(last);
        if (gap < step) return;
        // fill in the dabs a fast pointer skipped over
        const count = Math.min(12, Math.floor(gap / step));
        for (let k = 1; k <= count; k++) {
          const p = last.clone().lerp(h.point, k / count);
          this._stamp(type, k === count ? h : { ...h, point: p }, sign, { dir, delta: new THREE.Vector3() });
        }
        last = h.point.clone();
      }
      this.mesh.geometry.boundsTree.refit();
      this._touchGeometry();
    }, () => this._endStroke());
  }

  _placeRing(hit) {
    const r = this.brush.size;
    this.ring.visible = true;
    this.ring.position.copy(hit.point).addScaledVector(hit.normal, r * 0.02);
    this.ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), hit.normal);
    this.ring.scale.setScalar(r);
    this.ring.updateMatrixWorld(true);
  }

  _hover(e) {
    if (!this.active) return;
    const hit = this.sub === 'select' && this.selectTool === 'lasso' ? null : this._hit(e);
    if (hit) this._placeRing(hit); else this.ring.visible = false;
    this.vp.requestRender();
  }

  _dblclick(e) {
    if (this.sub !== 'select') return;
    const hit = this._hit(e);
    if (!hit) return;
    this._selChange(() => { if (!e.shiftKey) this.sel.fill(0); this.sel[hit.tri] = 1; this._floodConnected(); });
  }

  // ---------------------------------------------------------------- face selection
  _selChange(fn) {
    const before = { kind: 'sel', sel: Uint8Array.from(this.sel) };
    fn();
    this.undoStack.push(before);
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this._refreshOverlays();
    this._notify();
  }

  _paintSelect(e) {
    const before = { kind: 'sel', sel: Uint8Array.from(this.sel) };
    const value = e.shiftKey || e.altKey ? 0 : 1; // Shift or Alt takes faces out again
    const paint = (ev) => {
      const hit = this._hit(ev);
      if (!hit) return;
      this._placeRing(hit);
      this.selectTriangles(hit.point, hit.tri, value);
    };
    paint(e);
    this._track(e, paint, () => {
      this.undoStack.push(before);
      if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
      this.redoStack = [];
      this._notify();
    });
  }

  /** Select (or deselect) the triangles around a point on the surface. */
  selectTriangles(point, tri, value = 1) {
    const list = this._gather(point, this.brush.size, tri), vt = this.vtri;
    this.sel[tri] = value;
    for (const i of list) for (let k = vt.start[i]; k < vt.start[i + 1]; k++) this.sel[vt.list[k]] = value;
    this._refreshOverlays();
  }

  _lasso(e) {
    const rect = this.vp.canvas.getBoundingClientRect();
    const pts = [[e.clientX - rect.left, e.clientY - rect.top]];
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'lasso');
    const line = document.createElementNS(ns, 'polyline');
    svg.append(line);
    this.vp.container.append(svg);
    this.lassoEl = svg;
    const remove = !!(e.shiftKey || e.altKey);
    this._track(e, (ev) => {
      pts.push([ev.clientX - rect.left, ev.clientY - rect.top]);
      line.setAttribute('points', pts.map((p) => p.join(',')).join(' '));
    }, () => {
      svg.remove(); this.lassoEl = null;
      if (pts.length < 3) return;
      this._selChange(() => this.selectInPolygon(pts, remove ? 0 : 1));
    });
  }

  /** Select the front-facing triangles whose centre falls inside a screen polygon (canvas pixels). */
  selectInPolygon(poly, value = 1) {
    const M = this.M, v = M.v, t = M.t, nt = t.length / 3, p = new THREE.Vector3(), out = {};
    const view = this.vp.viewDirection(), eye = this.vp.camera.position, ortho = this.vp.isOrtho;
    const inside = (x, y) => {
      let hit = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[i], b = poly[j];
        if ((a[1] > y) !== (b[1] > y) && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) hit = !hit;
      }
      return hit;
    };
    for (let i = 0; i < nt; i++) {
      const a = t[i * 3] * 3, b = t[i * 3 + 1] * 3, c = t[i * 3 + 2] * 3;
      const ux = v[b] - v[a], uy = v[b + 1] - v[a + 1], uz = v[b + 2] - v[a + 2], wx = v[c] - v[a], wy = v[c + 1] - v[a + 1], wz = v[c + 2] - v[a + 2];
      const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
      p.set((v[a] + v[b] + v[c]) / 3, (v[a + 1] + v[b + 1] + v[c + 1]) / 3, (v[a + 2] + v[b + 2] + v[c + 2]) / 3);
      const facing = ortho ? nx * view.x + ny * view.y + nz * view.z : nx * (p.x - eye.x) + ny * (p.y - eye.y) + nz * (p.z - eye.z);
      if (facing >= 0) continue;
      this.vp.project(p, out);
      if (!out.behind && inside(out.x, out.y)) this.sel[i] = value;
    }
  }

  _floodConnected() {
    const table = ops.edgeTable(this.M), stack = [];
    for (let i = 0; i < this.sel.length; i++) if (this.sel[i]) stack.push(i);
    while (stack.length) {
      const i = stack.pop();
      for (let k = 0; k < 3; k++) { const e = table.te[i * 3 + k]; for (const j of [table.ta[e], table.tb[e]]) if (j >= 0 && !this.sel[j]) { this.sel[j] = 1; stack.push(j); } }
    }
  }

  selectAll() { this._selChange(() => this.sel.fill(1)); }
  selectNone() { this._selChange(() => this.sel.fill(0)); }
  selectInvert() { this._selChange(() => { for (let i = 0; i < this.sel.length; i++) this.sel[i] = this.sel[i] ? 0 : 1; }); }
  selectConnected() { this._selChange(() => this._floodConnected()); }

  /** Grow (or shrink) the selection by one ring of triangles. */
  selectGrow(shrink = false) {
    this._selChange(() => {
      const t = this.M.t, nt = t.length / 3, flag = new Uint8Array(this.M.v.length / 3);
      for (let i = 0; i < nt; i++) if (!!this.sel[i] !== shrink) { flag[t[i * 3]] = 1; flag[t[i * 3 + 1]] = 1; flag[t[i * 3 + 2]] = 1; }
      for (let i = 0; i < nt; i++) if (flag[t[i * 3]] || flag[t[i * 3 + 1]] || flag[t[i * 3 + 2]]) this.sel[i] = shrink ? 0 : 1;
    });
  }

  /** Add every triangle that shares a face group with the selection. */
  selectGroups() {
    if (!this.M.g) return false;
    this._selChange(() => {
      const want = new Set();
      for (let i = 0; i < this.sel.length; i++) if (this.sel[i]) want.add(this.M.g[i]);
      for (let i = 0; i < this.sel.length; i++) if (want.has(this.M.g[i])) this.sel[i] = 1;
    });
    return true;
  }

  // ---------------------------------------------------------------- edits
  /** The selection, or every triangle when nothing is selected. */
  _mask(allIfEmpty = true) {
    if (this.selCount > 0) return this.sel;
    return allIfEmpty ? new Uint8Array(this.sel.length).fill(1) : null;
  }

  _vertexMask(mask) {
    const vm = new Uint8Array(this.M.v.length / 3), t = this.M.t;
    for (let i = 0; i < mask.length; i++) if (mask[i]) { vm[t[i * 3]] = 1; vm[t[i * 3 + 1]] = 1; vm[t[i * 3 + 2]] = 1; }
    return vm;
  }

  /** Run a change that rebuilds the mesh. fn returns { mesh, sel } or null for "nothing happened". */
  _edit(fn) {
    const before = this._snapshot();
    const res = fn();
    if (!res || !res.mesh || !res.mesh.t.length) return false;
    let M = res.mesh;
    if (!M.c) { const c = new Float32Array(M.v.length); const col = new THREE.Color(this.base.color); for (let i = 0; i < c.length; i += 3) { c[i] = col.r; c[i + 1] = col.g; c[i + 2] = col.b; } M = { ...M, c }; }
    this.setMesh(M, res.sel || null);
    this._pushUndo(before);
    return true;
  }

  discard() {
    if (!this.selCount || this.selCount === this.sel.length) return false;
    return this._edit(() => ({ mesh: ops.subMesh(this.M, Uint8Array.from(this.sel, (s) => (s ? 0 : 1))) }));
  }

  /** Delete the selected faces and close the gap with a fresh, smooth patch. */
  eraseAndFill() {
    if (!this.selCount || this.selCount === this.sel.length) return false;
    return this._edit(() => {
      const M = this.M, rim = this._vertexMask(this.sel);
      const keepT = [], keepG = M.g ? [] : null;
      for (let i = 0; i < this.sel.length; i++) if (!this.sel[i]) { keepT.push(M.t[i * 3], M.t[i * 3 + 1], M.t[i * 3 + 2]); if (keepG) keepG.push(M.g[i]); }
      const cut = { ...M, t: Uint32Array.from(keepT), g: keepG ? Int32Array.from(keepG) : null };
      const loops = ops.boundaryLoops(cut).filter((loop) => loop.some((p) => rim[p]));
      const nt0 = cut.t.length / 3;
      const filled = ops.fillHoles(cut, { loops }).mesh;
      const out = ops.compact(filled), sel = new Uint8Array(out.t.length / 3);
      sel.fill(1, nt0);
      return { mesh: out, sel };
    });
  }

  fillHoles() { return this._edit(() => { const r = ops.fillHoles(this.M); return r.filled ? { mesh: r.mesh } : null; }); }

  extrude(distance, perVertex = false) {
    if (!this.selCount) return false;
    return this._edit(() => { const r = ops.extrudeFaces(this.M, this.sel, distance, { perVertex }); return { mesh: r.mesh, sel: r.mask }; });
  }

  flip() { const mask = this._mask(); return this._edit(() => ({ mesh: ops.flipNormals(this.M, mask), sel: Uint8Array.from(this.sel) })); }

  smoothFaces(iterations = 5, strength = 0.5) {
    const mask = this._vertexMask(this._mask());
    this.sculpted = true;
    return this._edit(() => ({ mesh: ops.smooth(this.M, { iterations, strength, mask }), sel: Uint8Array.from(this.sel) }));
  }

  /** Split triangles into four for finer detail (the selection, or everything). */
  refine() {
    const mask = this._mask(), keepSel = this.selCount > 0;
    return this._edit(() => { const r = ops.subdivide(this.M, mask); return { mesh: r.mesh, sel: keepSel ? Uint8Array.from(r.origin, (o) => this.sel[o]) : null }; });
  }

  /** Remove triangles from the selection (or everything) down to `percent` of what is there. */
  reduce(percent = 50) {
    const f = Math.min(1, Math.max(0.01, percent / 100));
    if (!this.selCount || this.selCount === this.sel.length) return this._edit(() => ({ mesh: ops.decimate(this.M, Math.round((this.M.t.length / 3) * f)) }));
    return this._edit(() => {
      const part = ops.subMesh(this.M, this.sel), rest = ops.subMesh(this.M, Uint8Array.from(this.sel, (s) => (s ? 0 : 1)));
      const small = ops.decimate(part, Math.round((part.t.length / 3) * f), { lockBoundary: true });
      const soup = ops.meshToSoup(ops.mergeMeshes([rest, small]));
      let groups = null;
      if (this.M.g) { groups = new Int32Array(rest.t.length / 3 + small.t.length / 3).fill(-1); if (rest.g) groups.set(rest.g, 0); if (small.g) groups.set(small.g, rest.t.length / 3); }
      const out = ops.soupToMesh(soup.positions, soup.colors, groups);
      // the reduced faces follow the untouched ones (welding can drop a collapsed face, so count what is left of those)
      const kept = ops.soupToMesh(ops.meshToSoup(rest).positions).t.length / 3;
      const sel = new Uint8Array(out.t.length / 3);
      sel.fill(1, Math.min(sel.length, kept));
      return { mesh: out, sel };
    });
  }

  /** Move, scale or turn the selected faces. `soft` blends the change into the surrounding surface (mm). */
  transformFaces({ move = [0, 0, 0], scale = 1, rotate = [0, 0, 0], soft = 0 } = {}) {
    if (!this.selCount) return false;
    return this._edit(() => {
      const M = ops.cloneMesh(this.M), nv = M.v.length / 3, v = M.v;
      const inSel = this._vertexMask(this.sel), w = new Float32Array(nv);
      const c = [0, 0, 0];
      let n = 0;
      for (let i = 0; i < nv; i++) if (inSel[i]) { w[i] = 1; c[0] += v[i * 3]; c[1] += v[i * 3 + 1]; c[2] += v[i * 3 + 2]; n += 1; }
      c[0] /= n; c[1] /= n; c[2] /= n;
      if (soft > 0) {
        // distance along the surface from the selection, relaxed over the edges
        const d = new Float32Array(nv).fill(Infinity), nb = this.nb;
        let front = [];
        for (let i = 0; i < nv; i++) if (inSel[i]) { d[i] = 0; front.push(i); }
        while (front.length) {
          const next = [];
          for (const i of front) for (let k = nb.start[i]; k < nb.start[i + 1]; k++) {
            const j = nb.list[k], len = d[i] + Math.hypot(v[i * 3] - v[j * 3], v[i * 3 + 1] - v[j * 3 + 1], v[i * 3 + 2] - v[j * 3 + 2]);
            if (len < d[j] && len < soft) { d[j] = len; next.push(j); }
          }
          front = next;
        }
        for (let i = 0; i < nv; i++) if (!inSel[i] && d[i] < soft) w[i] = falloff('smooth', d[i] / soft);
      }
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler((rotate[0] * Math.PI) / 180, (rotate[1] * Math.PI) / 180, (rotate[2] * Math.PI) / 180));
      const p = new THREE.Vector3();
      for (let i = 0; i < nv; i++) {
        if (!w[i]) continue;
        p.set(v[i * 3] - c[0], v[i * 3 + 1] - c[1], v[i * 3 + 2] - c[2]).multiplyScalar(scale).applyQuaternion(q);
        const tx = p.x + c[0] + move[0], ty = p.y + c[1] + move[1], tz = p.z + c[2] + move[2];
        v[i * 3] += (tx - v[i * 3]) * w[i]; v[i * 3 + 1] += (ty - v[i * 3 + 1]) * w[i]; v[i * 3 + 2] += (tz - v[i * 3 + 2]) * w[i];
      }
      return { mesh: M, sel: Uint8Array.from(this.sel) };
    });
  }

  /** Copy the selected faces out as a new object (thickness > 0 gives it walls). */
  extract(thickness = 0, remove = false) {
    if (!this.selCount) return null;
    if (remove && this.selCount === this.sel.length) return null; // nothing would be left behind
    let part = ops.subMesh(this.M, this.sel);
    if (thickness > 0) part = ops.thicken(part, thickness);
    if (!this.colored) part = { ...part, c: null };
    const node = ops.meshNode(part, this.base, { name: (this.base.name || 'Mesh') + ' part' });
    this.ed.addNode(node, { select: false });
    const own = this.ed.meshes.get(this.nodeId);
    if (own) own.visible = false;
    if (remove && this.discard()) { const step = this.undoStack[this.undoStack.length - 1]; step.piece = cloneNode(node); step.has = false; }
    this.vp.requestRender();
    return node;
  }

  /** Face groups: number the selection as one group, clear it, or split the whole mesh by angle. */
  createGroup() {
    if (!this.selCount) return false;
    return this._edit(() => {
      const M = ops.cloneMesh(this.M), nt = M.t.length / 3;
      if (!M.g) M.g = new Int32Array(nt).fill(-1);
      let next = 0;
      for (let i = 0; i < nt; i++) next = Math.max(next, M.g[i] + 1);
      for (let i = 0; i < nt; i++) if (this.sel[i]) M.g[i] = next;
      return { mesh: M, sel: Uint8Array.from(this.sel) };
    }) && (this.setShowGroups(true), true);
  }

  clearGroups() {
    if (!this.M.g) return false;
    const mask = this.selCount ? this.sel : null;
    return this._edit(() => {
      const M = ops.cloneMesh(this.M);
      if (!mask) M.g = null; else for (let i = 0; i < mask.length; i++) if (mask[i]) M.g[i] = -1;
      return { mesh: M, sel: Uint8Array.from(this.sel) };
    });
  }

  generateGroups(angle = 30) {
    let count = 0;
    const ok = this._edit(() => { const r = ops.faceGroupsByAngle(this.M, angle); count = r.count; return { mesh: r.mesh, sel: Uint8Array.from(this.sel) }; });
    if (ok) this.setShowGroups(true);
    return ok ? count : 0;
  }

  stats() { return this.M ? { triangles: this.M.t.length / 3, vertices: this.M.v.length / 3, selected: this.selCount || 0, groups: !!this.M.g } : null; }
}
