// Editor: owns the document, selection, tools and every modelling command.
import * as THREE from 'three';
import { History, cloneNode, makeGroup, mat4, uid, newDoc, ownColors } from './core/doc.js';
import { getGeometry, expandBox, getEdges, measure, stats as geoStats } from './core/geometry.js';
import { toast } from './ui/dom.js';

class Emitter {
  constructor() { this._l = {}; }
  on(evt, fn) { (this._l[evt] ||= []).push(fn); return this; }
  emit(evt, data) { for (const fn of this._l[evt] || []) fn(data); }
}

const SEL_COLOR = 0x29c5ff;
const selLineMat = new THREE.LineBasicMaterial({ color: SEL_COLOR });
const anchorLineMat = new THREE.LineBasicMaterial({ color: 0xff8f1f }); // the shape the others are aligned to
const edgeLineMat = new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.32 });

function makeHoleMaterial() {
  const m = new THREE.MeshStandardMaterial({ color: 0xc9d0d8, roughness: 0.85, transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide });
  m.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <color_fragment>',
      '#include <color_fragment>\n  vec2 dCell = fract(gl_FragCoord.xy / 9.0) - 0.5;\n  diffuseColor.rgb *= mix(0.62, 1.0, smoothstep(0.2, 0.3, length(dCell)));');
  };
  return m;
}
const holeMaterial = makeHoleMaterial();
const normalMaterial = new THREE.MeshNormalMaterial();

/** Surface looks that can be given to any shape (they change how it is drawn, not what is exported). */
export const SHADERS = [
  ['', 'Default'], ['clay', 'Matte clay'], ['glossy', 'Glossy'], ['flat', 'Faceted'], ['wire', 'Wireframe'], ['xray', 'X-ray'], ['normals', 'Normals'],
];
const SHADER_PROPS = { clay: { roughness: 1, metalness: 0 }, glossy: { roughness: 0.12, metalness: 0.2 }, flat: { flatShading: true }, wire: { wireframe: true }, xray: { xray: true }, normals: { normals: true } };

const T = (x, y, z) => new THREE.Matrix4().makeTranslation(x, y, z);
const S = (x, y, z) => new THREE.Matrix4().makeScale(x, y, z);
/** Transform about a pivot point. */
export const about = (pivot, m) => T(pivot.x, pivot.y, pivot.z).multiply(m).multiply(T(-pivot.x, -pivot.y, -pivot.z));

export class Editor extends Emitter {
  constructor(viewport, settings) {
    super();
    this.viewport = viewport;
    this.settings = settings;
    this.doc = newDoc();
    this.history = new History();
    this.selection = new Set();
    this.meshes = new Map();
    this.tool = 'select';
    this.cruise = false;
    this.frame = new THREE.Matrix4();
    this.frameInv = new THREE.Matrix4();
    this.hasFrame = false;
    this.ruler = null; // { x, y } in frame coordinates
    this.alignAnchor = null;
    this.clipboard = null;
    this.pasteCount = 0;
    this.dupState = null;
    this.placing = null;
    this.busy = false;
    this.history.reset(this._snapshot());

    viewport.handlers.leftDown = (e) => this._leftDown(e);
    viewport.handlers.hover = (e) => this._hover(e);
    viewport.handlers.contextMenu = (e) => this.emit('contextmenu', e);
    viewport.handlers.dblclick = (e) => this._dblclick(e);
  }

  // ---------------------------------------------------------------- document lifecycle
  load(doc) {
    this.editing = null;
    this.doc = doc;
    this.selection.clear();
    this.setFrame(null);
    this.ruler = null;
    this.alignAnchor = null;
    this.dupState = null;
    this.setTool('select');
    this.viewport.setWorkplaneSize(doc.workplane.width, doc.workplane.length);
    this.viewport.setGridStep(this.gridStep(), this.units === 'brick' ? 4 : 10);
    this.sync();
    this.history.reset(this._snapshot());
    this.emit('doc', { loaded: true });
    this.emit('selection');
    this.emit('history');
  }

  get snap() { return this.doc.workplane.snap; }
  get units() { return this.doc.workplane.units; }
  gridStep() { return this.units === 'in' ? 2.54 : this.units === 'brick' ? 8 : 1; }

  setWorkplane(patch) {
    Object.assign(this.doc.workplane, patch);
    this.viewport.setWorkplaneSize(this.doc.workplane.width, this.doc.workplane.length);
    this.viewport.setGridStep(this.gridStep(), this.units === 'brick' ? 4 : 10);
    this.emit('doc', { workplane: true });
    this.emit('selection');
  }

  _snapshot() {
    return {
      nodes: this.doc.nodes.map((n) => cloneNode(n)),
      notes: this.doc.notes.map((n) => ({ ...n, pos: [...n.pos] })),
      selection: [...this.selection],
    };
  }

  _restore(state) {
    this.doc.nodes = state.nodes.map((n) => cloneNode(n));
    this.doc.notes = state.notes.map((n) => ({ ...n, pos: [...n.pos] }));
    const ids = new Set(this.doc.nodes.map((n) => n.id));
    this.selection = new Set(state.selection.filter((id) => ids.has(id)));
    this.dupState = null;
    this.alignAnchor = null;
    this.sync();
    this.emit('doc', {});
    this.emit('selection');
    this.emit('history');
  }

  commit() {
    this.history.push(this._snapshot());
    this.emit('doc', {});
    this.emit('history');
  }

  undo() { const s = this.history.undo(); if (s) this._restore(s); }
  redo() { const s = this.history.redo(); if (s) this._restore(s); }

  // ---------------------------------------------------------------- scene sync
  sync() {
    const live = new Set();
    for (const node of this.doc.nodes) {
      live.add(node.id);
      this._syncMesh(node);
    }
    for (const [id, mesh] of this.meshes) {
      if (live.has(id)) continue;
      this.viewport.objects.remove(mesh);
      if (mesh.userData.solidMaterial) mesh.userData.solidMaterial.dispose();
      this.meshes.delete(id);
    }
    this._syncEditPreview();
    this.viewport.requestRender();
  }

  /**
   * While a group is open for editing, keep drawing what it will look like when it is
   * closed again (holes cut, parts joined). The parts themselves are shown as faint
   * ghosts so they can still be picked and moved.
   */
  _syncEditPreview() {
    const e = this.editing;
    const members = e ? this.doc.nodes.filter((n) => !e.outside.has(n.id) && !n.hidden) : [];
    if (!e || members.length < 2 || !members.some((n) => !n.hole)) {
      if (this.previewMesh) { this.viewport.objects.remove(this.previewMesh); this.previewMesh.material.dispose(); this.previewMesh = null; }
      return;
    }
    const node = makeGroup(members.map((n) => cloneNode(n)), e.mode);
    const geo = getGeometry(node);
    let mesh = this.previewMesh;
    if (!mesh) {
      mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0.03 }));
      mesh.matrixAutoUpdate = false;
      mesh.raycast = () => {}; // clicks go to the parts, not the preview
      mesh.castShadow = true;
      this.previewMesh = mesh;
      this.viewport.objects.add(mesh);
    }
    mesh.geometry = geo;
    const vc = !!e.multicolor && !!geo.attributes.color;
    if (mesh.material.vertexColors !== vc) { mesh.material.vertexColors = vc; mesh.material.needsUpdate = true; }
    mesh.material.color.set(vc ? '#ffffff' : e.color);
    mesh.updateMatrixWorld(true);
  }

  _syncMesh(node) {
    const geo = getGeometry(node);
    let mesh = this.meshes.get(node.id);
    if (!mesh) {
      mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0.03 }));
      mesh.matrixAutoUpdate = false;
      mesh.userData.id = node.id;
      mesh.userData.solidMaterial = mesh.material;
      this.meshes.set(node.id, mesh);
      this.viewport.objects.add(mesh);
    }
    if (mesh.geometry !== geo) {
      mesh.geometry = geo;
      if (mesh.userData.line) { mesh.remove(mesh.userData.line); mesh.userData.line = null; }
    }
    mesh.matrix.fromArray(node.matrix);
    mesh.visible = !node.hidden;
    const solid = mesh.userData.solidMaterial;
    if (node.hole) {
      mesh.material = holeMaterial;
      mesh.castShadow = false;
      mesh.renderOrder = 2;
    } else {
      const look = SHADER_PROPS[node.shader] || {};
      mesh.material = look.normals ? normalMaterial : solid;
      const vc = ownColors(node) && !!geo.attributes.color;
      if (solid.vertexColors !== vc) { solid.vertexColors = vc; solid.needsUpdate = true; }
      solid.color.set(vc ? '#ffffff' : node.color);
      // parts of a group that is open for editing are ghosts: the live result is drawn instead
      // (undo can bring the whole group back while it is still open: that one is drawn solid)
      const ghost = !!this.editing && !this.editing.outside.has(node.id) && node.id !== this.editing.id;
      const tr = !!node.transparent || ghost || !!look.xray;
      if (solid.transparent !== tr) { solid.transparent = tr; solid.needsUpdate = true; }
      solid.opacity = ghost ? 0.14 : look.xray ? 0.3 : tr ? 0.45 : 1;
      solid.roughness = look.roughness ?? 0.6;
      solid.metalness = look.metalness ?? 0.03;
      solid.wireframe = !!look.wireframe;
      if (solid.flatShading !== !!look.flatShading) { solid.flatShading = !!look.flatShading; solid.needsUpdate = true; }
      solid.depthWrite = !tr;
      solid.side = mesh.matrix.determinant() < 0 || tr ? THREE.DoubleSide : THREE.FrontSide;
      mesh.castShadow = !tr;
      mesh.renderOrder = tr ? 1 : 0;
    }
    this._syncOutline(mesh, this.selection.has(node.id), node.id === this.alignAnchor);
    mesh.updateMatrixWorld(true);
  }

  _syncOutline(mesh, selected, anchor = false) {
    const want = anchor ? anchorLineMat : selected ? selLineMat : this.settings.edges ? edgeLineMat : null;
    let line = mesh.userData.line;
    if (!want) {
      if (line) { mesh.remove(line); mesh.userData.line = null; }
      return;
    }
    const eg = getEdges(mesh.geometry);
    if (!eg) return;
    if (!line) {
      line = new THREE.LineSegments(eg, want);
      line.raycast = () => {};
      mesh.add(line);
      mesh.userData.line = line;
    }
    line.material = want;
  }

  refreshOutlines() {
    for (const [id, mesh] of this.meshes) { this._syncOutline(mesh, this.selection.has(id), id === this.alignAnchor); mesh.updateMatrixWorld(true); }
    this.viewport.requestRender();
  }

  /** Push node matrices to meshes without rebuilding anything (used while dragging). */
  touch(nodes) {
    for (const n of nodes) {
      const mesh = this.meshes.get(n.id);
      if (!mesh) continue;
      mesh.matrix.fromArray(n.matrix);
      mesh.updateMatrixWorld(true);
    }
    if (this.editing) this._syncEditPreview();
    this.viewport.requestRender();
    this.emit('transform');
  }

  // ---------------------------------------------------------------- selection
  node(id) { return this.doc.nodes.find((n) => n.id === id); }
  selectedNodes() { return this.doc.nodes.filter((n) => this.selection.has(n.id)); }
  movableNodes() { return this.selectedNodes().filter((n) => !n.locked); }

  select(ids, { add = false, toggle = false } = {}) {
    if (!add && !toggle) this.selection.clear();
    for (const id of ids) {
      if (toggle && this.selection.has(id)) this.selection.delete(id);
      else this.selection.add(id);
    }
    this.alignAnchor = this.selection.has(this.alignAnchor) ? this.alignAnchor : null;
    this.refreshOutlines();
    this.emit('selection');
  }

  selectAll() { this.select(this.doc.nodes.filter((n) => !n.hidden).map((n) => n.id)); }
  clearSelection() { if (this.selection.size) this.select([]); }

  /** Bounds of nodes in workplane-frame coordinates (or world when world = true). */
  bounds(nodes, world = false) {
    const box = new THREE.Box3();
    const m = new THREE.Matrix4();
    for (const n of nodes) {
      const g = getGeometry(n);
      if (!g.attributes.position.count) continue;
      m.fromArray(n.matrix);
      if (!world) m.premultiply(this.frameInv);
      expandBox(box, g, m);
    }
    return box;
  }

  snapValue(v) {
    const s = this.snap;
    return s > 0 ? Math.round(v / s) * s : v;
  }

  /** Apply a frame-local delta matrix to nodes, starting from saved matrices. */
  applyLocal(nodes, start, deltaLocal) {
    const world = this.frame.clone().multiply(deltaLocal).multiply(this.frameInv);
    this.applyWorld(nodes, start, world);
  }

  applyWorld(nodes, start, deltaWorld) {
    const m = new THREE.Matrix4();
    for (const n of nodes) {
      m.fromArray(start.get(n.id)).premultiply(deltaWorld);
      m.toArray(n.matrix);
    }
    this.touch(nodes);
  }

  startMatrices(nodes) {
    const map = new Map();
    for (const n of nodes) map.set(n.id, [...n.matrix]);
    return map;
  }

  /** One-shot local transform of the movable selection, with history. */
  transformSelection(deltaLocal, nodes = this.movableNodes()) {
    if (!nodes.length) return;
    this.applyLocal(nodes, this.startMatrices(nodes), deltaLocal);
    this.sync();
    this.commit();
    this.emit('selection');
  }

  // ---------------------------------------------------------------- workplane frame / tools
  setFrame(matrix) {
    if (matrix) {
      this.frame.copy(matrix);
      this.hasFrame = true;
    } else {
      this.frame.identity();
      this.hasFrame = false;
    }
    this.frameInv.copy(this.frame).invert();
    this.ruler = null;
    this.viewport.setFrame(this.hasFrame ? this.frame : null);
    this.emit('selection');
    this.emit('tool');
  }

  setTool(tool) {
    if (this.placing && tool !== 'place') this.cancelPlace();
    this.tool = this.tool === tool && tool !== 'select' && tool !== 'place' ? 'select' : tool;
    if (this.tool !== 'align' && this.alignAnchor) { this.alignAnchor = null; this.refreshOutlines(); }
    if (this.picking && this.tool !== 'pick') { const p = this.picking; this.picking = null; p.done(null); }
    this.viewport.canvas.style.cursor = ['workplane', 'ruler', 'note', 'pick'].includes(this.tool) ? 'crosshair' : '';
    this.emit('tool');
    this.emit('selection');
  }

  toggleCruise() {
    this.cruise = !this.cruise;
    this.emit('tool');
    toast(this.cruise ? 'Cruise on: drag a shape onto other shapes' : 'Cruise off');
  }

  localRay(e) { return this.viewport.rayFromClient(e.clientX, e.clientY).applyMatrix4(this.frameInv); }

  /** Intersection of the pointer with the workplane (frame z = height), in frame coordinates. */
  planePoint(e, height = 0) {
    const ray = this.localRay(e);
    if (Math.abs(ray.direction.z) < 1e-6) return null;
    const t = (height - ray.origin.z) / ray.direction.z;
    if (t < 0) return null;
    return ray.at(t, new THREE.Vector3());
  }

  pickNode(e, exclude = null) {
    const list = [];
    for (const [id, mesh] of this.meshes) if (mesh.visible && !(exclude && exclude.has(id))) list.push(mesh);
    const hits = this.viewport.pick(e.clientX, e.clientY, list);
    if (!hits.length) return null;
    const hit = hits[0];
    const normal = hit.face
      ? hit.face.normal.clone().applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld)).normalize()
      : new THREE.Vector3(0, 0, 1);
    return { node: this.node(hit.object.userData.id), point: hit.point.clone(), normal, mesh: hit.object };
  }

  // ---------------------------------------------------------------- pointer handling
  _hover(e) {
    if (this.disabled) return;
    if (this.tool === 'workplane' || this.tool === 'ruler' || this.tool === 'note' || this.tool === 'pick' || this.placing) return;
    const hit = this.pickNode(e);
    this.viewport.canvas.style.cursor = hit && !hit.node.locked ? 'move' : '';
  }

  _dblclick(e) {
    if (this.disabled) return;
    const hit = this.pickNode(e);
    if (hit) this.emit('dblclick', hit.node);
  }

  _leftDown(e) {
    if (this.disabled || this.placing) return; // handled by the placement listeners
    if (this.tool === 'workplane') return this._pickWorkplane(e);
    if (this.tool === 'pick') return this._pickPoint(e);
    if (this.tool === 'ruler') {
      const p = this.planePoint(e);
      if (p) this.ruler = { x: this.snapValue(p.x), y: this.snapValue(p.y) };
      this.setTool('select');
      return;
    }
    if (this.tool === 'note') {
      const hit = this.pickNode(e);
      let pos = hit ? hit.point : null;
      if (!pos) { const p = this.planePoint(e); if (p) pos = p.applyMatrix4(this.frame); }
      if (pos) this.emit('note-new', pos);
      this.setTool('select');
      return;
    }
    const hit = this.pickNode(e);
    if (!hit) return this._marquee(e);
    const node = hit.node;
    if (this.tool === 'align' && this.selection.has(node.id) && !e.shiftKey) {
      this.alignAnchor = this.alignAnchor === node.id ? null : node.id;
      this.refreshOutlines();
      this.emit('selection');
      return;
    }
    if (e.shiftKey) { this.select([node.id], { toggle: true }); return; }
    if (!this.selection.has(node.id)) this.select([node.id]);
    this._dragMove(e, hit);
  }

  _pickWorkplane(e) {
    const hit = this.pickNode(e);
    if (!hit) {
      this.setFrame(null);
    } else {
      const n = hit.normal.clone();
      if (e.shiftKey) n.negate();
      const up = new THREE.Vector3(0, 0, 1);
      let x = new THREE.Vector3().crossVectors(up, n);
      if (x.lengthSq() < 1e-6) x.set(1, 0, 0); else x.normalize();
      if (Math.abs(n.z) > 0.999) x.set(1, 0, 0);
      const y = new THREE.Vector3().crossVectors(n, x).normalize();
      this.setFrame(new THREE.Matrix4().makeBasis(x, y, n).setPosition(hit.point));
    }
    this.setTool('select');
  }

  /**
   * Ask for points on the model: resolves to [{ point, normal, node }] once `count` have been
   * clicked, or null when the tool is cancelled. `prompt` is shown in the banner.
   */
  pickPoints(count, prompt, onPoint = null) {
    if (this.picking) this.setTool('select');
    return new Promise((resolve) => {
      this.picking = { count, prompt, points: [], onPoint, done: resolve };
      this.tool = 'select';
      this.setTool('pick');
    });
  }

  _pickPoint(e) {
    const p = this.picking;
    if (!p) return this.setTool('select');
    const hit = this.pickNode(e);
    let entry = hit ? { point: hit.point, normal: hit.normal, node: hit.node } : null;
    if (!entry) { const q = this.planePoint(e); if (q) entry = { point: q.applyMatrix4(this.frame), normal: new THREE.Vector3(0, 0, 1).transformDirection(this.frame), node: null }; }
    if (!entry) return;
    p.points.push(entry);
    if (p.onPoint) p.onPoint(p.points);
    if (p.points.length < p.count) { this.emit('tool'); return; }
    this.picking = null;
    this.setTool('select');
    p.done(p.points);
  }

  /** Put the workplane on top of the current selection (Shift+W). */
  workplaneAtSelection() {
    const nodes = this.selectedNodes();
    if (!nodes.length) return;
    const b = this.bounds(nodes);
    const origin = new THREE.Vector3((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, b.max.z).applyMatrix4(this.frame);
    this.setFrame(this.frame.clone().setPosition(origin));
  }

  _track(e, onMove, onEnd) {
    const el = this.viewport.canvas;
    try { el.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    const move = (ev) => onMove(ev);
    const up = (ev) => {
      try { el.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      onEnd(ev);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  _dragMove(e, hit) {
    const sx = e.clientX, sy = e.clientY;
    let dragging = false, nodes, start, box0, hitLocal, moved = false, dup = false;
    const begin = (ev) => {
      if (ev.altKey) dup = this._duplicateInPlace().length > 0;
      nodes = this.movableNodes();
      if (!nodes.length) return false;
      start = this.startMatrices(nodes);
      box0 = this.bounds(nodes);
      hitLocal = hit.point.clone().applyMatrix4(this.frameInv);
      this.emit('drag', true);
      return true;
    };
    this._track(e, (ev) => {
      if (!dragging) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
        if (!begin(ev)) return;
        dragging = true;
      }
      if (this.cruise) {
        const target = this.pickNode(ev, this.selection);
        if (target) {
          const c0 = new THREE.Vector3((box0.min.x + box0.max.x) / 2, (box0.min.y + box0.max.y) / 2, box0.min.z).applyMatrix4(this.frame);
          const up = new THREE.Vector3(0, 0, 1).transformDirection(this.frame);
          const rot = new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion().setFromUnitVectors(up, target.normal));
          const world = T(target.point.x, target.point.y, target.point.z).multiply(rot).multiply(T(-c0.x, -c0.y, -c0.z));
          this.applyWorld(nodes, start, world);
          moved = true;
          return;
        }
      }
      const p = this.planePoint(ev, hitLocal.z);
      if (!p) return;
      let dx = p.x - hitLocal.x, dy = p.y - hitLocal.y;
      if (ev.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      dx = this.snapValue(box0.min.x + dx) - box0.min.x;
      dy = this.snapValue(box0.min.y + dy) - box0.min.y;
      if (ev.shiftKey) { if (Math.abs(p.x - hitLocal.x) > Math.abs(p.y - hitLocal.y)) dy = 0; else dx = 0; }
      this.applyLocal(nodes, start, T(dx, dy, 0));
      moved = true;
    }, () => {
      if (!dragging) return;
      this.emit('drag', false);
      if (moved || dup) { this.sync(); this.commit(); this.emit('selection'); }
    });
  }

  _marquee(e) {
    const sx = e.clientX, sy = e.clientY;
    const rect = this.viewport.canvas.getBoundingClientRect();
    let box = null;
    this._track(e, (ev) => {
      if (!box) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
        box = document.createElement('div');
        box.className = 'marquee';
        this.viewport.container.appendChild(box);
      }
      box.style.left = Math.min(sx, ev.clientX) - rect.left + 'px';
      box.style.top = Math.min(sy, ev.clientY) - rect.top + 'px';
      box.style.width = Math.abs(ev.clientX - sx) + 'px';
      box.style.height = Math.abs(ev.clientY - sy) + 'px';
    }, (ev) => {
      if (!box) {
        if (!e.shiftKey) this.clearSelection();
        return;
      }
      box.remove();
      const x0 = Math.min(sx, ev.clientX) - rect.left, x1 = Math.max(sx, ev.clientX) - rect.left;
      const y0 = Math.min(sy, ev.clientY) - rect.top, y1 = Math.max(sy, ev.clientY) - rect.top;
      // anything the box touches is selected; a shape does not have to be fully enclosed
      const ids = this.doc.nodes.filter((n) => !n.hidden && this.touchesScreenRect(n, x0, y0, x1, y1)).map((n) => n.id);
      this.select(ids, { add: e.shiftKey });
    });
  }

  /** Does any part of the node, as drawn on screen, fall inside or cross the rectangle (canvas pixels)? */
  touchesScreenRect(node, x0, y0, x1, y1) {
    const b = this.bounds([node], true);
    if (b.isEmpty()) return false;
    const v = new THREE.Vector3(), out = {};
    // quick reject: the projected bounding box misses the rectangle altogether
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity, visible = 0;
    for (let i = 0; i < 8; i++) {
      v.set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z);
      this.viewport.project(v, out);
      if (out.behind) continue;
      visible += 1;
      bx0 = Math.min(bx0, out.x); bx1 = Math.max(bx1, out.x); by0 = Math.min(by0, out.y); by1 = Math.max(by1, out.y);
    }
    if (!visible || bx1 < x0 || bx0 > x1 || by1 < y0 || by0 > y1) return false;
    const geo = getGeometry(node), pos = geo.attributes.position, idx = geo.index;
    const m = mat4(node.matrix);
    const n = pos.count;
    const sx = new Float32Array(n), sy = new Float32Array(n), ok = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m);
      this.viewport.project(v, out);
      sx[i] = out.x; sy[i] = out.y; ok[i] = out.behind ? 0 : 1;
      if (ok[i] && out.x >= x0 && out.x <= x1 && out.y >= y0 && out.y <= y1) return true; // a corner of the shape is in the box
    }
    // no vertex inside: an edge may still cross the box, or the box may sit wholly inside a face
    const crosses = (ax, ay, bx, by) => {
      let t0 = 0, t1 = 1;
      const dx = bx - ax, dy = by - ay;
      for (const [p, q] of [[-dx, ax - x0], [dx, x1 - ax], [-dy, ay - y0], [dy, y1 - ay]]) {
        if (p === 0) { if (q < 0) return false; continue; }
        const r = q / p;
        if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
      }
      return true;
    };
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const side = (ax, ay, bx, by) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const count = idx ? idx.count : n;
    for (let i = 0; i < count; i += 3) {
      const a = idx ? idx.getX(i) : i, bb = idx ? idx.getX(i + 1) : i + 1, c = idx ? idx.getX(i + 2) : i + 2;
      if (!ok[a] || !ok[bb] || !ok[c]) continue;
      if (crosses(sx[a], sy[a], sx[bb], sy[bb]) || crosses(sx[bb], sy[bb], sx[c], sy[c]) || crosses(sx[c], sy[c], sx[a], sy[a])) return true;
      const d1 = side(sx[a], sy[a], sx[bb], sy[bb]), d2 = side(sx[bb], sy[bb], sx[c], sy[c]), d3 = side(sx[c], sy[c], sx[a], sy[a]);
      if ((d1 >= 0 && d2 >= 0 && d3 >= 0) || (d1 <= 0 && d2 <= 0 && d3 <= 0)) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- adding shapes
  /** Position a new node so its footprint is centred on (x, y) of the workplane and it rests on it. */
  placeAt(node, x, y) {
    const base = node._base || (node._base = [...node.matrix]);
    const g = getGeometry(node);
    const box = expandBox(new THREE.Box3(), g, mat4(base));
    const cx = box.isEmpty() ? 0 : (box.min.x + box.max.x) / 2, cy = box.isEmpty() ? 0 : (box.min.y + box.max.y) / 2;
    const minz = box.isEmpty() ? 0 : box.min.z;
    const hw = box.isEmpty() ? 0 : (box.max.x - box.min.x) / 2, hl = box.isEmpty() ? 0 : (box.max.y - box.min.y) / 2;
    // snap the footprint corner so edges land on the grid
    const px = this.snapValue(x - hw) + hw, py = this.snapValue(y - hl) + hl;
    const m = this.frame.clone().multiply(T(px - cx, py - cy, -minz)).multiply(mat4(base));
    m.toArray(node.matrix);
  }

  addNode(node, { select = true, commit = true } = {}) {
    delete node._base;
    this.doc.nodes.push(node);
    if (select) this.selection = new Set([node.id]);
    this.sync();
    if (commit) this.commit();
    this.emit('selection');
  }

  /** Workplane point under the middle of the viewport (falls back to the origin). */
  viewCenterPoint() {
    const r = this.viewport.canvas.getBoundingClientRect();
    // the 3D view is hidden (e.g. laser workspace): there is no meaningful view centre
    if (!(r.width > 0 && r.height > 0)) return { x: 0, y: 0 };
    const p = this.planePoint({ clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 });
    if (!p || !isFinite(p.x) || !isFinite(p.y)) return { x: 0, y: 0 };
    const hw = this.doc.workplane.width / 2, hl = this.doc.workplane.length / 2;
    if (!this.hasFrame && (Math.abs(p.x) > hw * 1.5 || Math.abs(p.y) > hl * 1.5)) return { x: 0, y: 0 };
    return { x: p.x, y: p.y };
  }

  addAtViewCenter(node) {
    const c = this.viewCenterPoint();
    this.placeAt(node, c.x, c.y);
    this.addNode(node);
  }

  /** Interactive placement: the shape follows the pointer until it is dropped / clicked. */
  beginPlace(node, { drag = false } = {}) {
    this.cancelPlace();
    this.setTool('place');
    const ghost = new THREE.Mesh(getGeometry(node), new THREE.MeshStandardMaterial({
      color: node.hole ? '#c9d0d8' : node.color, transparent: true, opacity: 0.6, depthWrite: false,
      vertexColors: ownColors(node),
    }));
    if (ghost.material.vertexColors) ghost.material.color.set('#ffffff');
    ghost.matrixAutoUpdate = false;
    ghost.visible = false;
    this.viewport.helpers.add(ghost);
    const canvas = this.viewport.canvas;
    const overCanvas = (ev) => {
      const el = document.elementFromPoint(ev.clientX, ev.clientY);
      return el === canvas || (el && el.closest && el.closest('.gizmo-layer') && !el.closest('.gz-handle'));
    };
    const update = (ev) => {
      const p = overCanvas(ev) ? this.planePoint(ev) : null;
      ghost.visible = !!p;
      if (p) {
        this.placeAt(node, p.x, p.y);
        ghost.matrix.fromArray(node.matrix);
        ghost.updateMatrixWorld(true);
      }
      this.viewport.requestRender();
      return !!p;
    };
    const finish = (ev) => {
      const ok = update(ev);
      this.cancelPlace();
      if (ok) this.addNode(node);
    };
    const onMove = (ev) => update(ev);
    const onUp = (ev) => { if (drag) finish(ev); };
    const onDown = (ev) => {
      if (drag || ev.button !== 0) return;
      if (overCanvas(ev)) { ev.preventDefault(); ev.stopPropagation(); finish(ev); }
    };
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointerdown', onDown, true);
    this.placing = {
      node,
      dispose: () => {
        window.removeEventListener('pointermove', onMove, true);
        window.removeEventListener('pointerup', onUp, true);
        window.removeEventListener('pointerdown', onDown, true);
        this.viewport.helpers.remove(ghost);
        ghost.material.dispose();
        this.viewport.requestRender();
      },
    };
  }

  cancelPlace() {
    if (!this.placing) return;
    this.placing.dispose();
    this.placing = null;
    if (this.tool === 'place') { this.tool = 'select'; this.emit('tool'); }
  }

  // ---------------------------------------------------------------- commands
  deleteSelection() {
    const ids = new Set(this.movableNodes().map((n) => n.id));
    if (!ids.size) return;
    this.doc.nodes = this.doc.nodes.filter((n) => !ids.has(n.id));
    for (const id of ids) this.selection.delete(id);
    this.sync();
    this.commit();
    this.emit('selection');
  }

  copy(nodes = this.selectedNodes()) {
    if (!nodes.length) return;
    this.clipboard = nodes.map((n) => cloneNode(n));
    this.pasteCount = 0;
    toast(nodes.length === 1 ? 'Copied 1 shape' : `Copied ${nodes.length} shapes`);
  }

  cut() {
    // locked shapes are not deleted, so they are not cut either
    const nodes = this.movableNodes();
    if (!nodes.length) return;
    this.copy(nodes);
    this.pasteCount = -1;
    this.deleteSelection();
  }

  paste(inPlace = false) {
    if (!this.clipboard || !this.clipboard.length) return;
    this.pasteCount += 1;
    const step = inPlace ? 0 : Math.max(this.snap, 1) * 10 * this.pasteCount;
    const delta = this.frame.clone().multiply(T(step, 0, 0)).multiply(this.frameInv);
    const fresh = this.clipboard.map((n) => {
      const c = cloneNode(n, true);
      c.locked = false;
      mat4(c.matrix).premultiply(delta).toArray(c.matrix);
      return c;
    });
    this.doc.nodes.push(...fresh);
    this.selection = new Set(fresh.map((n) => n.id));
    this.sync();
    this.commit();
    this.emit('selection');
  }

  _duplicateInPlace() {
    const nodes = this.selectedNodes();
    if (!nodes.length) return [];
    const fresh = nodes.map((n) => { const c = cloneNode(n, true); c.locked = false; return c; });
    this.doc.nodes.push(...fresh);
    this.selection = new Set(fresh.map((n) => n.id));
    this.sync();
    this.emit('selection');
    return fresh;
  }

  /** Ctrl+D: duplicate in place; after transforming the copy, repeat that transform on each press. */
  duplicate() {
    const nodes = this.selectedNodes();
    if (!nodes.length) return;
    const ds = this.dupState;
    const repeat = ds && nodes.length === ds.start.size && nodes.every((n) => ds.start.has(n.id));
    const start = new Map();
    const fresh = nodes.map((n) => {
      const c = cloneNode(n, true);
      c.locked = false;
      if (repeat) {
        const cur = mat4(n.matrix);
        const delta = cur.clone().multiply(mat4(ds.start.get(n.id)).invert());
        delta.multiply(cur).toArray(c.matrix);
      }
      start.set(c.id, [...n.matrix]);
      return c;
    });
    this.doc.nodes.push(...fresh);
    this.selection = new Set(fresh.map((n) => n.id));
    this.dupState = { start };
    this.sync();
    this.commit();
    this.emit('selection');
  }

  async group(mode = 'union') {
    const nodes = this.movableNodes();
    if (nodes.length < 2) { toast('Select two or more shapes to group'); return; }
    const ids = new Set(nodes.map((n) => n.id));
    const index = this.doc.nodes.findIndex((n) => n.id === nodes[nodes.length - 1].id);
    const g = makeGroup(nodes.map((n) => cloneNode(n)), mode);
    await this._busy(() => getGeometry(g));
    const after = this.doc.nodes[index + 1];
    this.doc.nodes = this.doc.nodes.filter((n) => !ids.has(n.id));
    const at = after ? this.doc.nodes.indexOf(after) : this.doc.nodes.length;
    this.doc.nodes.splice(at, 0, g);
    this.selection = new Set([g.id]);
    this.sync();
    this.commit();
    this.emit('selection');
    if (!getGeometry(g).attributes.position.count) toast('The result is empty: the holes removed everything', 'warn', 4000);
    else if (geoStats.csgFailures && mode !== 'bundle') { /* a fallback merge was reported in the console */ }
  }

  ungroup() {
    const groups = this.movableNodes().filter((n) => n.type === 'group');
    if (!groups.length) return;
    const selected = [];
    for (const g of groups) {
      const gm = mat4(g.matrix);
      const kids = g.children.map((c) => {
        const k = cloneNode(c);
        gm.clone().multiply(mat4(c.matrix)).toArray(k.matrix);
        return k;
      });
      const at = this.doc.nodes.indexOf(g);
      this.doc.nodes.splice(at, 1, ...kids);
      this.selection.delete(g.id);
      selected.push(...kids.map((k) => k.id));
    }
    for (const id of selected) this.selection.add(id);
    this.sync();
    this.commit();
    this.emit('selection');
  }

  /** Swap some top-level nodes for others in one undo step (used by the mesh tools). */
  replaceNodes(ids, fresh, { select = true } = {}) {
    const gone = new Set(ids);
    let at = this.doc.nodes.findIndex((n) => gone.has(n.id));
    if (at < 0) at = this.doc.nodes.length;
    const before = this.doc.nodes.slice(0, at).filter((n) => !gone.has(n.id));
    const after = this.doc.nodes.slice(at).filter((n) => !gone.has(n.id));
    this.doc.nodes = [...before, ...fresh, ...after];
    for (const id of gone) this.selection.delete(id);
    if (select) this.selection = new Set(fresh.map((n) => n.id));
    this.sync();
    this.commit();
    this.emit('selection');
  }

  /** Open a group for editing: its parts become ordinary shapes until exitGroup(). */
  enterGroup(node) {
    if (this.editing || !node || node.type !== 'group' || node.locked) return false;
    const gm = mat4(node.matrix);
    const kids = node.children.map((c) => {
      const k = cloneNode(c);
      gm.clone().multiply(mat4(c.matrix)).toArray(k.matrix);
      return k;
    });
    const at = this.doc.nodes.indexOf(node);
    if (at < 0) return false;
    const outside = new Set(this.doc.nodes.filter((n) => n.id !== node.id).map((n) => n.id));
    this.doc.nodes.splice(at, 1, ...kids);
    this.editing = { id: node.id, mode: node.mode, name: node.name, color: node.color, hole: node.hole, multicolor: node.multicolor, transparent: node.transparent, outside,
      look: { round: node.round, roundEdges: node.roundEdges, roundStyle: node.roundStyle, fillet: node.fillet, shader: node.shader } };
    this.selection = new Set();
    this.sync();
    this.commit();
    this.emit('selection');
    this.emit('editing', true);
    return true;
  }

  /** Close the group opened with enterGroup(), re-combining its parts (and anything added meanwhile). */
  async exitGroup() {
    const e = this.editing;
    if (!e) return;
    this.editing = null;
    // undo may have brought the original group back; then there is nothing to rebuild
    if (!this.doc.nodes.some((n) => n.id === e.id)) {
      const members = this.doc.nodes.filter((n) => !e.outside.has(n.id));
      if (members.length >= 2) {
        for (const m of members) m.locked = false;
        this.selection = new Set(members.map((n) => n.id));
        await this.group(e.mode);
        const g = this.selectedNodes()[0];
        if (g && g.type === 'group') {
          Object.assign(g, { name: e.name, color: e.color, multicolor: e.multicolor, transparent: e.transparent, hole: e.hole });
          // edge rounding and surface finish belong to the group, not its parts
          for (const [k, v] of Object.entries(e.look || {})) if (v !== undefined) g[k] = v;
          this.sync();
          this.commit();
          this.emit('selection');
        }
      }
    }
    this.emit('editing', false);
  }

  /** Run a potentially slow job after letting the busy indicator paint. */
  async _busy(fn) {
    this.busy = true;
    this.emit('busy', true);
    await new Promise((r) => setTimeout(r, 30));
    try { return await fn(); } finally {
      this.busy = false;
      this.emit('busy', false);
    }
  }

  patchSelection(patch, { commit = true, includeLocked = false } = {}) {
    const nodes = includeLocked ? this.selectedNodes() : this.movableNodes();
    if (!nodes.length) return;
    for (const n of nodes) Object.assign(n, typeof patch === 'function' ? patch(n) : patch);
    this.sync();
    if (commit) this.commit();
    this.emit('selection');
  }

  setHole(hole) { this.patchSelection({ hole }); }
  setColor(color, commit = true) {
    // a plain colour replaces whatever was painted on a mesh
    const unpaint = (n) => { const m = n.params.mesh, mesh = { id: uid('m'), positions: m.positions }; if (m.groups) mesh.groups = m.groups; if (m.smooth) mesh.smooth = true; return { color, hole: false, params: { ...n.params, mesh } }; };
    this.patchSelection((n) => (n.type === 'group' ? { color, multicolor: false, hole: false } : ownColors(n) ? unpaint(n) : { color, hole: false }), { commit });
  }
  setMulticolor(on) { this.patchSelection((n) => (n.type === 'group' ? { multicolor: on } : {})); }
  toggleTransparent() {
    const nodes = this.movableNodes();
    const on = !nodes.every((n) => n.transparent);
    this.patchSelection({ transparent: on });
  }
  toggleLock() {
    const nodes = this.selectedNodes();
    if (!nodes.length) return;
    const lock = !nodes.every((n) => n.locked);
    this.patchSelection({ locked: lock }, { includeLocked: true });
  }
  hideSelection() {
    const nodes = this.selectedNodes();
    if (!nodes.length) return;
    for (const n of nodes) n.hidden = true;
    this.selection.clear();
    this.sync();
    this.commit();
    this.emit('selection');
  }
  showAll() {
    if (!this.doc.nodes.some((n) => n.hidden)) return;
    for (const n of this.doc.nodes) n.hidden = false;
    this.sync();
    this.commit();
    this.emit('selection');
  }

  setParam(key, value, commit = true, ids = null) {
    const pool = ids ? ids.map((id) => this.node(id)).filter((n) => n && !n.locked) : this.movableNodes();
    const nodes = pool.filter((n) => n.type === 'shape' && key in n.params);
    if (!nodes.length) return;
    for (const n of nodes) n.params = { ...n.params, [key]: value };
    this.sync();
    if (commit) this.commit();
    this.emit('transform');
  }

  rename(id, name) {
    const n = this.node(id);
    if (!n) return;
    n.name = name;
    this.commit();
  }

  nudge(dx, dy, dz) {
    const step = this.snap > 0 ? this.snap : 1;
    this.transformSelection(T(dx * step, dy * step, dz * step));
  }

  dropToWorkplane() {
    const nodes = this.movableNodes();
    if (!nodes.length) return;
    const start = this.startMatrices(nodes);
    for (const n of nodes) {
      const b = this.bounds([n]);
      if (!b.isEmpty()) this.applyLocal([n], start, T(0, 0, -b.min.z));
    }
    this.sync();
    this.commit();
    this.emit('selection');
  }

  /** axis: 'x'|'y'|'z', mode: 'min'|'center'|'max'. preview = don't commit (returns restore fn). */
  align(axis, mode, preview = false) {
    const nodes = this.movableNodes();
    if (!nodes.length) return () => {};
    const anchor = this.alignAnchor && this.node(this.alignAnchor);
    const ref = this.bounds(anchor ? [anchor] : this.selectedNodes());
    const pos = (b) => (mode === 'min' ? b.min[axis] : mode === 'max' ? b.max[axis] : (b.min[axis] + b.max[axis]) / 2);
    const start = this.startMatrices(nodes);
    for (const n of nodes) {
      if (anchor && n.id === anchor.id) continue;
      const b = this.bounds([n]);
      if (b.isEmpty()) continue;
      const d = pos(ref) - pos(b);
      this.applyLocal([n], start, T(axis === 'x' ? d : 0, axis === 'y' ? d : 0, axis === 'z' ? d : 0));
    }
    if (preview) {
      return () => { for (const n of nodes) n.matrix = [...start.get(n.id)]; this.touch(nodes); };
    }
    this.sync();
    this.commit();
    this.emit('selection');
    return () => {};
  }

  mirror(axis) {
    const nodes = this.movableNodes();
    if (!nodes.length) return;
    const c = this.bounds(nodes).getCenter(new THREE.Vector3());
    this.transformSelection(about(c, S(axis === 'x' ? -1 : 1, axis === 'y' ? -1 : 1, axis === 'z' ? -1 : 1)), nodes);
  }

  rotateSelection(axis, degrees) {
    const nodes = this.movableNodes();
    if (!nodes.length || !degrees) return;
    const c = this.bounds(nodes).getCenter(new THREE.Vector3());
    const a = (degrees * Math.PI) / 180;
    const r = axis === 'x' ? new THREE.Matrix4().makeRotationX(a) : axis === 'y' ? new THREE.Matrix4().makeRotationY(a) : new THREE.Matrix4().makeRotationZ(a);
    this.transformSelection(about(c, r), nodes);
  }

  /** Set an absolute size along an axis (frame coordinates), anchored at the minimum side. */
  setSize(axis, value, uniform = false) {
    const nodes = this.movableNodes();
    const b = this.bounds(nodes);
    if (b.isEmpty() || !(value > 0)) return;
    const size = b.max[axis] - b.min[axis];
    if (size < 1e-9) return;
    const f = value / size;
    const s = uniform ? S(f, f, f) : S(axis === 'x' ? f : 1, axis === 'y' ? f : 1, axis === 'z' ? f : 1);
    this.transformSelection(about(new THREE.Vector3(b.min.x, b.min.y, b.min.z), s), nodes);
  }

  setPosition(axis, value) {
    const nodes = this.movableNodes();
    const b = this.bounds(nodes);
    if (b.isEmpty() || !isFinite(value)) return;
    const d = value - b.min[axis];
    this.transformSelection(T(axis === 'x' ? d : 0, axis === 'y' ? d : 0, axis === 'z' ? d : 0), nodes);
  }

  /** Linear or circular pattern of the selection. */
  pattern({ type, count, dx = 0, dy = 0, dz = 0, angle = 360 }) {
    const nodes = this.selectedNodes();
    if (!nodes.length || count < 2) return;
    const all = [...nodes.map((n) => n.id)];
    const center = type === 'circular' ? new THREE.Vector3(0, 0, 0) : null;
    for (let i = 1; i < count; i++) {
      let local;
      if (type === 'circular') {
        const full = Math.abs(angle) >= 360;
        const a = ((angle * Math.PI) / 180) * (i / (full ? count : count - 1));
        local = about(center, new THREE.Matrix4().makeRotationZ(a));
      } else {
        local = T(dx * i, dy * i, dz * i);
      }
      const world = this.frame.clone().multiply(local).multiply(this.frameInv);
      for (const n of nodes) {
        const c = cloneNode(n, true);
        c.locked = false;
        mat4(c.matrix).premultiply(world).toArray(c.matrix);
        this.doc.nodes.push(c);
        all.push(c.id);
      }
    }
    this.selection = new Set(all);
    this.sync();
    this.commit();
    this.emit('selection');
  }

  // ---------------------------------------------------------------- notes
  addNote(pos, text) {
    this.doc.notes.push({ id: uid('note'), pos: [pos.x, pos.y, pos.z], text });
    this.commit();
  }
  updateNote(id, text) {
    const n = this.doc.notes.find((x) => x.id === id);
    if (!n) return;
    n.text = text;
    this.commit();
  }
  removeNote(id) {
    this.doc.notes = this.doc.notes.filter((x) => x.id !== id);
    this.commit();
  }

  // ---------------------------------------------------------------- info
  measureNodes(nodes) {
    let volume = 0, area = 0, triangles = 0;
    for (const n of nodes) {
      if (n.hole) continue;
      const m = measure(getGeometry(n), mat4(n.matrix));
      volume += m.volume; area += m.area; triangles += m.triangles;
    }
    return { volume, area, triangles };
  }

  worldBounds(nodes = this.doc.nodes.filter((n) => !n.hidden)) { return this.bounds(nodes, true); }

  fitView() {
    const sel = this.selectedNodes();
    const box = this.worldBounds(sel.length ? sel : undefined);
    if (box.isEmpty()) this.viewport.home(); else this.viewport.fit(box);
  }
}
