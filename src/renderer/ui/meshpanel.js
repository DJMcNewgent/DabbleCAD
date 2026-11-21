// Mesh tools panel: repair, remesh, cut, hollow and pattern commands, the sculpt and
// face-selection mode, print analysis, and surface looks.
import * as THREE from 'three';
import { h, clear, button, modal, toast } from './dom.js';
import * as ops from '../core/meshops.js';
import * as an from '../core/meshanalysis.js';
import { about, SHADERS } from '../editor.js';
import { BRUSHES, FALLOFFS } from '../view/sculpt.js';
import { PALETTE, makeGroup } from '../core/doc.js';

/**
 * Small form in a dialog. fields: [{ key, label, type: 'number' | 'select' | 'check', value, min, max, step, options }].
 * Resolves to { key: value } or null when cancelled.
 */
export function formDialog(title, fields, { ok = 'Apply', note = '' } = {}) {
  return new Promise((resolve) => {
    let result = null;
    const m = modal({ title, width: 440, onClose: () => resolve(result) });
    const inputs = {};
    const rows = fields.map((f) => {
      let input;
      if (f.type === 'select') {
        input = h('select', { class: 'select' }, f.options.map(([v, text]) => h('option', { value: v }, text)));
        input.value = f.value;
      } else if (f.type === 'check') {
        input = h('input', { type: 'checkbox', checked: !!f.value });
        inputs[f.key] = input;
        return h('label', { class: 'check' }, input, f.label);
      } else {
        input = h('input', { class: 'input', type: 'number', value: f.value, min: f.min, max: f.max, step: f.step ?? 'any' });
      }
      inputs[f.key] = input;
      return h('label', { class: 'field' }, h('span', {}, f.label), input);
    });
    const submit = () => {
      result = {};
      for (const f of fields) {
        const el = inputs[f.key];
        if (f.type === 'check') result[f.key] = el.checked;
        else if (f.type === 'select') result[f.key] = el.value;
        else {
          let v = parseFloat(el.value);
          if (!isFinite(v)) v = f.value;
          if (f.min != null) v = Math.max(f.min, v);
          if (f.max != null) v = Math.min(f.max, v);
          result[f.key] = v;
        }
      }
      m.close();
    };
    m.body.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') { e.preventDefault(); submit(); } });
    m.body.append(...rows, note ? h('div', { class: 'insp-note' }, note) : null,
      h('div', { class: 'modal-actions' }, button({ label: 'Cancel', cls: 'btn-outline', onClick: () => m.close() }), button({ label: ok, cls: 'btn-primary', onClick: submit })));
  });
}

const fmt = (v, d = 2) => (Math.round(v * 10 ** d) / 10 ** d).toLocaleString(undefined, { maximumFractionDigits: d });
const AXES = [['2', 'Z (up)'], ['0', 'X'], ['1', 'Y']];

export class MeshPanel {
  constructor(app, host) {
    this.app = app;
    this.ed = app.editor;
    this.vp = app.viewport;
    this.mode = app.meshMode;
    this.host = host;
    this.open = { sculpt: true, edit: true, analysis: false, look: false };
    this.overlay = null;
    this.result = null;
    this.body = h('div', { class: 'mesh-body' });
    host.append(this.body);
    // a slider being dragged (or a number being typed) must not be rebuilt under the hand; catch up as soon as it is let go
    this.body.addEventListener('pointerdown', () => { this._pressing = true; });
    const release = () => { this._pressing = false; if (this._stale) this.render(); };
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    this.body.addEventListener('focusout', () => setTimeout(() => { if (this._stale) this.render(); }, 0));
    host.addEventListener('keydown', (e) => { if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') e.stopPropagation(); });
    this.ed.on('selection', () => { this._dropStaleOverlay(); this.render(); });
    this.ed.on('doc', (info) => { if (info && info.workplane) return; this.clearOverlay(); this.result = null; });
    this.mode.onChange(() => this.render());
    this.render();
  }

  // ---------------------------------------------------------------- helpers
  _nodes(min = 1, what = 'a shape') {
    const nodes = this.ed.movableNodes();
    if (nodes.length < min) { toast(min > 1 ? `Select ${what} first` : `Select ${what} first`); return null; }
    return nodes;
  }

  /**
   * Run a mesh operation on every selected shape. fn(mesh, node) returns a mesh, a list of
   * meshes, or null to leave that shape alone. The shapes become mesh shapes in one undo step.
   */
  async run(fn, { done, smooth = false, names = null } = {}) {
    const nodes = this._nodes();
    if (!nodes) return false;
    const ed = this.ed;
    try {
      const fresh = [], ids = [];
      let changed = 0;
      await ed._busy(() => {
        for (const n of nodes) {
          const out = fn(ops.nodeToMesh(n), n);
          if (!out) continue;
          const list = Array.isArray(out) ? out.filter((m) => m && m.t.length) : [out];
          if (!list.length) continue;
          ids.push(n.id); changed += 1;
          list.forEach((m, i) => fresh.push(ops.meshNode(m, n, { smooth, keepId: i === 0, name: names ? names(n, i, list.length) : undefined })));
        }
      });
      if (!changed) { toast('Nothing needed changing'); return false; }
      ed.replaceNodes(ids, fresh);
      if (done) toast(typeof done === 'function' ? done(fresh) : done);
      return true;
    } catch (err) {
      console.warn(err);
      toast(err.message || String(err), 'warn', 6000);
      return false;
    }
  }

  // ---------------------------------------------------------------- overlays (analysis pictures)
  clearOverlay() {
    const o = this.overlay;
    if (!o) return;
    this.overlay = null;
    this.vp.helpers.remove(o.group);
    o.group.traverse((x) => { if (x.geometry) x.geometry.dispose(); if (x.material) x.material.dispose(); });
    for (const id of o.hidden) { const mesh = this.ed.meshes.get(id); const node = this.ed.node(id); if (mesh && node) mesh.visible = !node.hidden; }
    this.vp.requestRender();
  }

  _dropStaleOverlay() {
    const o = this.overlay;
    if (o && o.ids.length && !o.ids.every((id) => this.ed.selection.has(id))) { this.clearOverlay(); this.result = null; }
  }

  _overlay(ids = []) {
    this.clearOverlay();
    const group = new THREE.Group();
    this.vp.helpers.add(group);
    this.overlay = { group, ids, hidden: [] };
    return this.overlay;
  }

  /** Draw a mesh in place of a shape, coloured per vertex (Float32Array) or per triangle (fn(i) -> [r, g, b]). */
  _colorMesh(o, id, M, vertexColors, triColor) {
    const { positions } = ops.meshToSoup(M);
    const col = new Float32Array(positions.length);
    for (let i = 0; i < M.t.length; i++) {
      if (triColor) { const c = triColor((i / 3) | 0); col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2]; }
      else { const j = M.t[i] * 3; col[i * 3] = vertexColors[j]; col[i * 3 + 1] = vertexColors[j + 1]; col[i * 3 + 2] = vertexColors[j + 2]; }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, side: THREE.DoubleSide }));
    mesh.raycast = () => {};
    o.group.add(mesh);
    const own = this.ed.meshes.get(id);
    if (own) { own.visible = false; o.hidden.push(id); }
  }

  _marker(o, p, radius, color = 0xff3d3d) {
    const s = new THREE.Mesh(new THREE.SphereGeometry(radius, 16, 12), new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.85 }));
    s.position.set(p[0], p[1], p[2]);
    s.renderOrder = 40;
    s.raycast = () => {};
    o.group.add(s);
  }

  _line(o, a, b, color = 0xffd54f) {
    const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...a), new THREE.Vector3(...b)]);
    const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color, depthTest: false }));
    l.renderOrder = 41;
    l.raycast = () => {};
    o.group.add(l);
  }

  _show(title, lines, actions = []) {
    this.result = { title, lines, actions };
    this.open.analysis = true;
    this.render();
    this.vp.requestRender();
  }

  // ---------------------------------------------------------------- edit commands
  async planeCut() {
    const nodes = this._nodes();
    if (!nodes) return;
    const b = this.ed.bounds(nodes, true), c = b.getCenter(new THREE.Vector3());
    const v = await formDialog('Plane cut', [
      { key: 'axis', label: 'Cut across', type: 'select', value: '2', options: AXES },
      { key: 'at', label: 'Position along that axis (mm)', value: +c.z.toFixed(2) },
      { key: 'keep', label: 'Keep', type: 'select', value: 'both', options: [['both', 'Both halves, as two shapes'], ['above', 'The side toward +'], ['below', 'The side toward −']] },
      { key: 'cap', label: 'Fill the cut face', type: 'check', value: true },
    ], { ok: 'Cut', note: `The selection spans X ${fmt(b.min.x)} to ${fmt(b.max.x)}, Y ${fmt(b.min.y)} to ${fmt(b.max.y)}, Z ${fmt(b.min.z)} to ${fmt(b.max.z)}.` });
    if (!v) return;
    const n = [0, 0, 0];
    n[+v.axis] = 1;
    await this.run((M) => { const parts = ops.planeCut(M, n, v.at, { keep: v.keep, cap: v.cap }); return parts.length ? parts : null; }, { done: 'Cut', names: (node, i, count) => (count > 1 ? `${node.name || 'Mesh'} ${i ? 'B' : 'A'}` : undefined) });
  }

  async symmetrize() {
    const v = await formDialog('Mirror', [
      { key: 'axis', label: 'Mirror across', type: 'select', value: '0', options: [['0', 'X (left / right)'], ['1', 'Y (front / back)'], ['2', 'Z (top / bottom)']] },
      { key: 'side', label: 'Keep', type: 'select', value: '+', options: [['+', 'The + half'], ['-', 'The − half']] },
    ], { ok: 'Mirror', note: 'Cuts the shape through its middle and mirrors the kept half, making it perfectly symmetric. To flip a shape without cutting it, use Mirror in the toolbar.' });
    if (v) await this.run((M) => ops.symmetrize(M, +v.axis, v.side === '+'), { done: 'Mirrored' });
  }

  async makeSolid() {
    const v = await formDialog('Make solid', [
      { key: 'accuracy', label: 'Accuracy (grid cells along the longest side)', value: 96, min: 16, max: 220, step: 1 },
      { key: 'offset', label: 'Offset (mm): + grows, − shrinks', value: 0, step: 0.1 },
    ], { ok: 'Make solid', note: 'Rebuilds the shape as one closed, printable solid. Gaps, overlapping parts and inner faces disappear; very fine detail is rounded off. Higher accuracy takes longer.' });
    if (v) await this.run((M) => ops.makeSolid(M, { resolution: v.accuracy, offset: v.offset }), { done: 'Rebuilt as a closed solid', smooth: true });
  }

  async hollow() {
    const v = await formDialog('Hollow', [
      { key: 'wall', label: 'Wall thickness (mm)', value: 2, min: 0.2, step: 0.1 },
      { key: 'accuracy', label: 'Accuracy (grid cells along the longest side)', value: 80, min: 16, max: 200, step: 1 },
      { key: 'drains', label: 'Drain holes in the bottom', type: 'select', value: '0', options: [['0', 'None'], ['1', 'One'], ['2', 'Two']] },
      { key: 'radius', label: 'Drain hole radius (mm)', value: 2, min: 0.3, step: 0.1 },
    ], { ok: 'Hollow', note: 'Leaves a shell of the chosen thickness. Drain holes let resin or powder out.' });
    if (v) await this.run((M) => ops.hollow(M, { wall: v.wall, resolution: v.accuracy, drains: +v.drains, drainRadius: v.radius }), { done: 'Hollowed' });
  }

  async reduce() {
    const v = await formDialog('Reduce', [{ key: 'percent', label: 'Keep this share of the triangles (%)', value: 50, min: 1, max: 100, step: 1 }], { ok: 'Reduce', note: 'Removes triangles where they matter least, so the shape barely changes.' });
    if (v) await this.run((M) => ops.decimate(M, Math.max(4, Math.round((M.t.length / 3) * (v.percent / 100)))), { done: (f) => `Reduced to ${f.reduce((s, n) => s + n.params.mesh.positions.length / 9, 0).toLocaleString()} triangles` });
  }

  async remesh() {
    const nodes = this._nodes();
    if (!nodes) return;
    const b = this.ed.bounds(nodes, true), size = b.getSize(new THREE.Vector3());
    const v = await formDialog('Remesh', [
      { key: 'edge', label: 'Target edge length (mm)', value: +(Math.max(size.x, size.y, size.z) / 40).toFixed(2), min: 0.05, step: 0.05 },
      { key: 'smooth', label: 'Smoothing passes', value: 1, min: 0, max: 10, step: 1 },
    ], { ok: 'Remesh', note: 'Evens out the triangles so they are all about the same size, which sculpts and smooths better.' });
    if (v) await this.run((M) => ops.remesh(M, v.edge, { smoothing: v.smooth }), { done: 'Remeshed', smooth: v.smooth > 0 });
  }

  async smoothAll() {
    const v = await formDialog('Smooth', [
      { key: 'passes', label: 'Passes', value: 5, min: 1, max: 50, step: 1 },
      { key: 'strength', label: 'Strength (0 to 1)', value: 0.5, min: 0.05, max: 1, step: 0.05 },
      { key: 'keep', label: 'Keep the volume (no shrinking)', type: 'check', value: true },
    ], { ok: 'Smooth' });
    if (v) await this.run((M) => ops.smooth(M, { iterations: v.passes, strength: v.strength, keepVolume: v.keep }), { done: 'Smoothed', smooth: true });
  }

  async pattern() {
    const v = await formDialog('Make pattern', [
      { key: 'type', label: 'Pattern', type: 'select', value: 'dual', options: ops.PATTERNS },
      { key: 'size', label: 'Spacing (mm)', value: 8, min: 0.5, step: 0.5 },
      { key: 'thickness', label: 'Element thickness (mm)', value: 2, min: 0.2, step: 0.1 },
    ], { ok: 'Make pattern', note: 'Replaces the shape with struts along its surface, a lattice inside it, or a perforated copy. Edge patterns follow the surface only.' });
    if (v) await this.run((M) => ops.makePattern(M, v.type, { size: v.size, thickness: v.thickness }), { done: 'Pattern built' });
  }

  async slices() {
    const nodes = this._nodes();
    if (!nodes) return;
    const v = await formDialog('Make slices', [
      { key: 'thickness', label: 'Slice thickness (mm), for example your sheet material', value: 3, min: 0.2, step: 0.1 },
      { key: 'axis', label: 'Stack along', type: 'select', value: '2', options: AXES },
      { key: 'gap', label: 'Gap between slices (mm)', value: 0, min: 0, step: 0.1 },
    ], { ok: 'Slice', note: 'Turns the shape into a stack of flat slabs, ready to cut from sheet material and glue together. The slabs arrive as a bundle; ungroup it to lay them out.' });
    if (!v) return;
    const ed = this.ed;
    try {
      const fresh = [], ids = [];
      await ed._busy(() => {
        for (const n of nodes) {
          const slabs = ops.makeSlices(ops.nodeToMesh(n), { thickness: v.thickness, axis: +v.axis, gap: v.gap });
          const kids = slabs.map((m, i) => ops.meshNode(m, n, { name: `Slice ${i + 1}` }));
          const g = makeGroup(kids, 'bundle');
          g.name = (n.name || 'Shape') + ' slices'; g.multicolor = false; g.color = n.color;
          fresh.push(g); ids.push(n.id);
        }
      });
      ed.replaceNodes(ids, fresh);
      toast(`Made ${fresh.reduce((s, g) => s + g.children.length, 0)} slices`);
    } catch (err) { toast(err.message || String(err), 'warn', 6000); }
  }

  async separate() {
    await this.run((M) => { const parts = ops.separateShells(M); return parts.length > 1 ? parts : null; }, { done: (f) => `Separated into ${f.length} shapes`, names: (n, i) => `${n.name || 'Shell'} ${i + 1}` });
  }

  async combine() {
    const nodes = this._nodes(2, 'two or more shapes');
    if (!nodes) return;
    const ed = this.ed;
    await ed._busy(() => {
      const M = ops.mergeMeshes(nodes.map((n) => ops.nodeToMesh(n)));
      ed.replaceNodes(nodes.map((n) => n.id), [ops.meshNode(M, nodes[0], { name: 'Combined' })]);
    });
    toast('Combined into one mesh (the parts are not fused; use Group or Make solid for that)');
  }

  async tube() {
    const nodes = this._nodes();
    if (!nodes) return;
    const target = nodes[0];
    const pts = await this.ed.pickPoints(2, 'Add tube: click where the tube starts, then where it ends.');
    if (!pts) return;
    this.ed.select([target.id]);
    const v = await formDialog('Add tube', [
      { key: 'mode', label: 'Type', type: 'select', value: 'cut', options: [['cut', 'Channel: drill it through the shape'], ['add', 'Rod: join it to the shape']] },
      { key: 'r0', label: 'Radius at the start (mm)', value: 2, min: 0.1, step: 0.1 },
      { key: 'r1', label: 'Radius at the end (mm)', value: 2, min: 0.1, step: 0.1 },
    ], { ok: 'Add tube' });
    if (!v) return;
    const a = pts[0].point.toArray(), b = pts[1].point.toArray();
    await this.run((M) => ops.addTube(M, a, b, v.r0, v.r1, v.mode), { done: v.mode === 'cut' ? 'Channel drilled' : 'Rod added' });
  }

  async units() {
    const v = await formDialog('Units and scale', [
      { key: 'from', label: 'The shape was made in', type: 'select', value: '25.4', options: [['25.4', 'Inches (scale × 25.4)'], ['10', 'Centimetres (scale × 10)'], ['1000', 'Metres (scale × 1000)'], ['0.03937', 'It should be in inches (scale ÷ 25.4)'], ['custom', 'Use the factor below']] },
      { key: 'factor', label: 'Custom factor', value: 1, min: 0.0001, step: 0.01 },
    ], { ok: 'Rescale', note: 'DabbleCAD works in millimetres. Imported models from other units come in too small or too large; this fixes that. For one exact dimension, use Position & size in the shape panel.' });
    if (!v) return;
    const f = v.from === 'custom' ? v.factor : v.from === '0.03937' ? 1 / 25.4 : parseFloat(v.from);
    const nodes = this._nodes();
    if (!nodes || !(f > 0)) return;
    const b = this.ed.bounds(nodes);
    this.ed.transformSelection(about(new THREE.Vector3((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, b.min.z), new THREE.Matrix4().makeScale(f, f, f)), nodes);
  }

  async offset() {
    const v = await formDialog('Offset', [
      { key: 'offset', label: 'Distance (mm): + grows, − shrinks', value: 1, step: 0.1 },
      { key: 'accuracy', label: 'Accuracy (grid cells along the longest side)', value: 96, min: 16, max: 220, step: 1 },
    ], { ok: 'Offset', note: 'Moves the whole surface outward or inward by the same distance everywhere.' });
    if (v) await this.run((M) => ops.makeSolid(M, { resolution: v.accuracy, offset: v.offset }), { done: 'Offset', smooth: true });
  }

  async faceGroups() {
    const v = await formDialog('Generate face groups', [{ key: 'angle', label: 'Split where faces meet at more than (degrees)', value: 30, min: 1, max: 180, step: 1 }], { ok: 'Generate', note: 'Each flat or gently curved region becomes a face group. Open Select faces to see them and to select a whole group at once.' });
    if (!v) return;
    let count = 0;
    await this.run((M) => { const r = ops.faceGroupsByAngle(M, v.angle); count += r.count; return r.mesh; }, { done: () => `Made ${count} face groups` });
  }

  enter(sub) {
    const nodes = this.ed.movableNodes();
    if (nodes.length !== 1) { toast('Select one shape to edit its mesh'); return; }
    const tris = ops.nodeToMesh(nodes[0]).t.length / 3;
    if (!this.mode.enter(nodes[0], sub)) { toast('That shape has no surface to edit', 'warn'); return; }
    this.app.showSideTab('mesh');
    this.app._updateBanner();
    if (sub === 'sculpt' && tris < 2000) toast('This mesh is coarse. Press Refine a few times so the brushes have something to move.', 'info', 6000);
  }

  // ---------------------------------------------------------------- analysis
  async inspect() {
    const nodes = this._nodes();
    if (!nodes) return;
    const o = this._overlay(nodes.map((n) => n.id));
    const lines = [];
    let problems = 0;
    await this.ed._busy(() => {
      for (const n of nodes) {
        const M = ops.nodeToMesh(n), r = an.inspectMesh(M);
        problems += r.problems;
        const scale = Math.max(...r.size) || 1;
        for (const hole of r.holes) this._marker(o, hole.center, Math.max(scale * 0.012, Math.min(hole.radius * 0.5, scale * 0.05)), 0x2f7dff);
        if (nodes.length > 1) lines.push(['', n.name || 'Shape']);
        lines.push(['Triangles', r.triangles.toLocaleString()], ['Vertices', r.vertices.toLocaleString()], ['Edges', r.edges.toLocaleString()],
          ['Separate shells', r.shells + (r.smallShells ? ` (${r.smallShells} tiny)` : '')],
          ['Closed solid', r.closed ? (r.insideOut ? 'Yes, but inside out' : 'Yes') : 'No'],
          ['Holes', r.holes.length ? `${r.holes.length} (${r.boundaryEdges} open edges, blue dots)` : 'None'],
          ['Edges shared by 3+ faces', r.nonManifoldEdges || 'None'], ['Zero-area triangles', r.degenerate || 'None'],
          ['Handles (genus)', r.genus == null ? 'n/a' : r.genus],
          ['Size', r.size.map((s) => fmt(s)).join(' × ') + ' mm'], ['Surface area', fmt(r.area / 100) + ' cm²'], ['Volume', r.closed ? fmt(r.volume / 1000) + ' cm³' : 'n/a (not closed)']);
      }
    });
    this._show(problems ? `Inspector: ${problems} problem${problems > 1 ? 's' : ''} found` : 'Inspector: no problems found', lines,
      problems ? [button({ label: 'Auto repair all', cls: 'btn-primary', onClick: () => this.repair() })] : []);
  }

  async repair() {
    const logs = [];
    this.result = null;
    const ok = await this.run((M) => { const r = an.autoRepair(M); if (r.log.length) logs.push(...r.log); return r.log.length ? r.mesh : null; }, {});
    if (ok) toast('Repaired: ' + [...new Set(logs)].join(', '), 'info', 6000);
    this.render();
  }

  async measure() {
    const o = this._overlay([]);
    const pts = await this.ed.pickPoints(2, 'Measure: click two points.', (list) => { const p = list[list.length - 1].point; this._marker(o, p.toArray(), Math.max(0.4, this.vp.unitsPerPixel(p) * 5), 0xffd54f); this.vp.requestRender(); });
    if (!pts) { this.clearOverlay(); return; }
    const a = pts[0].point, b = pts[1].point;
    this._line(o, a.toArray(), b.toArray());
    const d = b.clone().sub(a);
    this._show('Measure', [['Distance', fmt(d.length(), 3) + ' mm'], ['Along X', fmt(Math.abs(d.x), 3) + ' mm'], ['Along Y', fmt(Math.abs(d.y), 3) + ' mm'], ['Along Z', fmt(Math.abs(d.z), 3) + ' mm'],
      ['Angle between the two surfaces', fmt((pts[0].normal.angleTo(pts[1].normal) * 180) / Math.PI, 1) + '°']],
    [button({ label: 'Measure again', cls: 'btn-outline', onClick: () => this.measure() })]);
  }

  async thickness() {
    const nodes = this._nodes();
    if (!nodes) return;
    const v = await formDialog('Thickness', [{ key: 'min', label: 'Thinnest wall you can print (mm)', value: 1, min: 0.05, step: 0.05 }], { ok: 'Analyse' });
    if (!v) return;
    const o = this._overlay(nodes.map((n) => n.id));
    let thinnest = Infinity, below = 0, total = 0, at = null;
    await this.ed._busy(() => {
      for (const n of nodes) {
        const M = ops.nodeToMesh(n), f = an.thicknessField(M, v.min * 4);
        const col = new Float32Array(M.v.length);
        for (let i = 0; i < f.values.length; i++) { an.heatColor(f.values[i] / (v.min * 2), col, i * 3); total += 1; if (f.values[i] < v.min) below += 1; }
        if (f.min !== null && f.min < thinnest) { thinnest = f.min; at = [M.v[f.minAt * 3], M.v[f.minAt * 3 + 1], M.v[f.minAt * 3 + 2]]; }
        this._colorMesh(o, n.id, M, col);
      }
    });
    if (at) this._marker(o, at, Math.max(0.5, this.vp.unitsPerPixel(new THREE.Vector3(...at)) * 6));
    this._show('Thickness', [['Thinnest wall', isFinite(thinnest) ? fmt(thinnest) + ' mm (red dot)' : 'n/a'], [`Thinner than ${v.min} mm`, total ? fmt((below / total) * 100, 1) + '% of the surface' : 'n/a'], ['Colours', `red = under ${v.min} mm, green = ${v.min * 2} mm or more`]]);
  }

  async overhangs(build = false) {
    const nodes = this._nodes();
    if (!nodes) return;
    const v = await formDialog(build ? 'Generate supports' : 'Overhangs', [
      { key: 'angle', label: 'Steepest overhang your printer manages (degrees from vertical)', value: this._angle || 45, min: 5, max: 85, step: 1 },
      ...(build ? [{ key: 'spacing', label: 'Distance between supports (mm)', value: 5, min: 1, step: 0.5 }, { key: 'post', label: 'Post diameter (mm)', value: 1.6, min: 0.4, step: 0.1 }, { key: 'tip', label: 'Tip diameter (mm)', value: 0.6, min: 0.2, step: 0.1 }, { key: 'base', label: 'Foot diameter (mm)', value: 5, min: 0, step: 0.5 }] : []),
    ], { ok: build ? 'Generate' : 'Analyse' });
    if (!v) return;
    this._angle = v.angle;
    if (build) {
      const ed = this.ed, fresh = [];
      try {
        await ed._busy(() => {
          for (const n of nodes) {
            const res = an.buildSupports(ops.nodeToMesh(n), v);
            if (res) fresh.push(ops.meshNode(res.mesh, { color: '#90a4ae' }, { name: 'Supports' }));
          }
        });
      } catch (err) { toast(err.message || String(err), 'warn', 6000); return; }
      if (!fresh.length) { toast('Nothing needs support at that angle'); return; }
      this.clearOverlay();
      ed.doc.nodes.push(...fresh);
      ed.sync(); ed.commit(); ed.emit('selection');
      toast('Supports added as their own shape, so they can be deleted or exported separately');
      return;
    }
    const o = this._overlay(nodes.map((n) => n.id));
    let area = 0;
    await this.ed._busy(() => {
      for (const n of nodes) {
        const M = ops.nodeToMesh(n), r = an.overhangFaces(M, v.angle);
        area += r.area;
        const base = new THREE.Color(n.color), red = [0.85, 0.03, 0.03], plain = [base.r, base.g, base.b];
        this._colorMesh(o, n.id, M, null, (i) => (r.mask[i] ? red : plain));
      }
    });
    this._show('Overhangs', [['Needs support', fmt(area / 100) + ' cm² (shown in red)'], ['Angle', v.angle + '° from vertical']],
      area > 0 ? [button({ label: 'Generate supports', cls: 'btn-primary', onClick: () => this.overhangs(true) })] : []);
  }

  async stability() {
    const nodes = this._nodes();
    if (!nodes) return;
    let r, M;
    await this.ed._busy(() => { M = ops.mergeMeshes(nodes.map((n) => ops.nodeToMesh(n))); if (M.t.length) r = an.stability(M); });
    if (!r) { toast('There is nothing to measure: the shape is empty'); return; }
    const o = this._overlay([]);
    const size = Math.max(1, this.ed.bounds(nodes, true).getSize(new THREE.Vector3()).length() * 0.02);
    this._marker(o, r.com, size, r.stable ? 0x2ecc71 : 0xff3d3d);
    this._line(o, r.com, [r.com[0], r.com[1], r.plate], r.stable ? 0x2ecc71 : 0xff3d3d);
    for (let i = 0; i < r.hull.length; i++) { const p = r.hull[i], q = r.hull[(i + 1) % r.hull.length]; this._line(o, [p[0], p[1], r.plate + 0.05], [q[0], q[1], r.plate + 0.05], 0x29c5ff); }
    this._show('Stability', [
      ['Result', r.stable ? 'Stands on its own' : 'Tips over: the centre of mass is outside the base'],
      ['Centre of mass', r.com.map((x) => fmt(x, 1)).join(', ') + ' mm'], ['Volume', fmt(r.volume / 1000) + ' cm³'], ['Surface area', fmt(r.area / 100) + ' cm²'],
      ['Base outline area', fmt(r.contactArea / 100) + ' cm² (blue outline)'], ['Margin to the edge of the base', fmt(r.margin) + ' mm'], ['Tilt before it tips', r.stable ? fmt(r.tipAngle, 1) + '°' : '0°'],
    ]);
  }

  async strength() {
    const nodes = this._nodes();
    if (!nodes) return;
    const o = this._overlay([]);
    const lines = [];
    await this.ed._busy(() => {
      for (const n of nodes) {
        const list = ops.crossSections(ops.nodeToMesh(n));
        if (!list) { lines.push([n.name || 'Shape', 'Not a closed solid: use Make solid first']); continue; }
        // ignore the very top and bottom, where every shape tapers to nothing
        const mid = list.slice(3, -3).filter((s) => s.area > 1e-6);
        if (!mid.length) { lines.push([n.name || 'Shape', 'Too small to analyse']); continue; }
        const weak = mid.reduce((a, b) => (b.area < a.area ? b : a)), strong = mid.reduce((a, b) => (b.area > a.area ? b : a));
        const b = this.ed.bounds([n], true), c = b.getCenter(new THREE.Vector3()), hw = (b.max.x - b.min.x) / 2 + 2, hl = (b.max.y - b.min.y) / 2 + 2;
        const corners = [[c.x - hw, c.y - hl], [c.x + hw, c.y - hl], [c.x + hw, c.y + hl], [c.x - hw, c.y + hl]];
        corners.forEach((p, i) => this._line(o, [p[0], p[1], weak.z], [corners[(i + 1) % 4][0], corners[(i + 1) % 4][1], weak.z], 0xff3d3d));
        if (nodes.length > 1) lines.push(['', n.name || 'Shape']);
        lines.push(['Weakest layer', `${fmt(weak.area)} mm² at Z ${fmt(weak.z, 1)} mm (red frame)`], ['Widest layer', `${fmt(strong.area)} mm² at Z ${fmt(strong.z, 1)} mm`], ['Ratio', fmt(weak.area / strong.area * 100, 1) + '% of the widest']);
      }
    });
    this._show('Strength', [...lines, ['How to read it', 'A printed part breaks first where a layer has the least material. Thicken that spot or turn the part so the layers run along it.']]);
  }

  async orientation() {
    const nodes = this._nodes();
    if (!nodes) return;
    const ed = this.ed;
    let moved = 0, saved = 0;
    await ed._busy(() => {
      const start = ed.startMatrices(nodes);
      for (const n of nodes) {
        if (ed.bounds([n], true).isEmpty()) continue; // a group that cancels itself out has nothing to turn
        const r = an.bestOrientation(ops.nodeToMesh(n), { angle: this._angle || 45 });
        const down = new THREE.Vector3(...r.down);
        if (down.z > -0.9999) {
          const q = new THREE.Quaternion().setFromUnitVectors(down, new THREE.Vector3(0, 0, -1));
          const c = ed.bounds([n], true).getCenter(new THREE.Vector3());
          ed.applyWorld([n], start, about(c, new THREE.Matrix4().makeRotationFromQuaternion(q)));
          moved += 1; saved += r.current.overhang - r.overhang;
        }
        const b = ed.bounds([n], true), now = ed.startMatrices([n]);
        if (Math.abs(b.min.z) > 1e-6) ed.applyWorld([n], now, new THREE.Matrix4().makeTranslation(0, 0, -b.min.z));
      }
    });
    ed.sync(); ed.commit(); ed.emit('selection');
    const plural = moved > 1 ? 's' : '';
    toast(!moved ? 'Already in the best orientation for printing' : saved > 1 ? `Turned ${moved} shape${plural} for printing: ${fmt(saved / 100)} cm² less overhang` : `Turned ${moved} shape${plural} to sit flat on the plate`);
  }

  async layout() {
    const ed = this.ed;
    // a group that cancels itself out has no size, and would be moved to nowhere
    const pool = (ed.movableNodes().length > 1 ? ed.movableNodes() : ed.doc.nodes.filter((n) => !n.hidden && !n.locked)).filter((n) => !ed.bounds([n], true).isEmpty());
    if (!pool.length) { toast('There is nothing to arrange'); return; }
    const v = await formDialog('Layout', [{ key: 'gap', label: 'Space between shapes (mm)', value: 4, min: 0, step: 0.5 }], { ok: 'Arrange', note: 'Packs the selected shapes (or everything) into rows on the workplane, resting on it.' });
    if (!v) return;
    const boxes = pool.map((n) => ed.bounds([n], true));
    const wp = ed.doc.workplane;
    const res = an.packRows(boxes.map((b) => ({ w: b.max.x - b.min.x, d: b.max.y - b.min.y })), wp.width, wp.length, v.gap);
    pool.forEach((n, i) => {
      const b = boxes[i];
      const m = new THREE.Matrix4().makeTranslation(res.pos[i][0] - res.width / 2 - b.min.x, res.pos[i][1] - res.depth / 2 - b.min.y, -b.min.z);
      ed.applyWorld([n], ed.startMatrices([n]), m);
    });
    ed.sync(); ed.commit(); ed.emit('selection');
    toast(res.fits ? `Arranged ${pool.length} shapes` : `Arranged ${pool.length} shapes, but they do not all fit on the ${wp.width} × ${wp.length} mm workplane`, res.fits ? 'info' : 'warn', 5000);
  }

  async between(kind) {
    const nodes = this.ed.selectedNodes();
    if (nodes.length !== 2) { toast('Select exactly two shapes'); return; }
    const o = this._overlay(nodes.map((n) => n.id));
    let r;
    await this.ed._busy(() => { const A = ops.nodeToMesh(nodes[0]), B = ops.nodeToMesh(nodes[1]); r = kind === 'clearance' ? an.clearance(A, B) : an.deviation(A, B); });
    const mark = Math.max(0.4, this.ed.bounds(nodes, true).getSize(new THREE.Vector3()).length() * 0.01);
    if (kind === 'clearance') {
      if (r.a) { this._marker(o, r.a, mark, 0xffd54f); this._marker(o, r.b, mark, 0xffd54f); this._line(o, r.a, r.b); }
      this._show('Clearance', [['Smallest gap', isFinite(r.distance) ? (r.distance < 1e-4 ? 'Touching or overlapping' : fmt(r.distance, 3) + ' mm (yellow line)') : 'n/a'], ['Note', 'Measured from the corners of each mesh, so treat it as close, not exact.']]);
    } else {
      if (r.at) this._marker(o, r.at, mark);
      this._show('Deviation', [['Largest distance', fmt(r.max, 3) + ' mm (red dot)'], ['Average distance', fmt(r.mean, 3) + ' mm'], ['Use', 'Compares two versions of a surface, for example before and after Reduce.']]);
    }
  }

  setSlice(on, height) {
    this.sliceOn = on;
    if (height != null) this.sliceHeight = height;
    const r = this.vp.renderer;
    r.clippingPlanes = on ? [new THREE.Plane(new THREE.Vector3(0, 0, -1), this.sliceHeight)] : [];
    this.vp.requestRender();
  }

  // ---------------------------------------------------------------- rendering
  _section(key, title, rows) {
    const d = h('details', { class: 'insp-section', open: this.open[key] }, h('summary', {}, title), ...rows);
    d.addEventListener('toggle', () => { this.open[key] = d.open; });
    return d;
  }

  _grid(items) {
    return h('div', { class: 'mesh-grid' }, items.filter(Boolean).map(([label, title, onClick, cls]) => button({ label, title, cls: 'btn-outline ' + (cls || ''), onClick })));
  }

  _slider(label, value, min, max, step, onInput, title) {
    const range = h('input', { type: 'range', min, max, step, value, 'aria-label': label });
    const num = h('input', { class: 'input', type: 'number', min, max, step, value, 'aria-label': label });
    range.addEventListener('input', () => { num.value = range.value; onInput(parseFloat(range.value)); });
    num.addEventListener('change', () => { const v = Math.min(max, Math.max(min, parseFloat(num.value))); if (!isFinite(v)) return; num.value = v; range.value = v; onInput(v); });
    num.addEventListener('keydown', (e) => e.stopPropagation());
    return h('div', { class: 'param', title }, h('label', {}, label), range, num);
  }

  render() {
    const active = document.activeElement, inside = !!active && this.body.contains(active);
    if (inside && ((active.type === 'range' && this._pressing) || active.type === 'number' || active.type === 'color')) { this._stale = true; return this._syncLive(); }
    this._stale = false;
    // a slider that merely still has the focus is rebuilt like everything else, and gets the focus back
    const slider = inside && active.type === 'range' ? active.getAttribute('aria-label') : null;
    const scroll = this.body.scrollTop;
    clear(this.body);
    if (this.mode.active) this._renderMode(); else this._renderTools();
    this.body.scrollTop = scroll;
    if (slider) { const again = [...this.body.querySelectorAll('input[type=range]')].find((i) => i.getAttribute('aria-label') === slider); if (again) again.focus({ preventScroll: true }); }
  }

  _syncLive() {
    if (this.statEl && this.mode.active) this.statEl.textContent = this._statText();
    if (this.undoBtn) { this.undoBtn.classList.toggle('disabled', !this.mode.canUndo); this.redoBtn.classList.toggle('disabled', !this.mode.canRedo); }
  }

  _statText() {
    const s = this.mode.stats();
    return s ? `${s.triangles.toLocaleString()} triangles` + (this.mode.sub === 'select' ? ` · ${s.selected.toLocaleString()} selected` : '') : '';
  }

  _renderTools() {
    const ed = this.ed, n = ed.movableNodes().length;
    const one = n === 1;
    this.statEl = null; this.undoBtn = null;
    this.body.append(h('div', { class: 'mesh-head' }, n ? (n === 1 ? (ed.movableNodes()[0].name || 'One shape selected') : `${n} shapes selected`) : 'Select a shape to use these tools'));
    if (this.result) {
      const r = this.result;
      this.body.append(h('div', { class: 'mesh-result' },
        h('div', { class: 'mesh-result-head' }, h('b', {}, r.title), button({ icon: 'close', cls: 'btn-ghost', title: 'Close and clear the markers', onClick: () => { this.result = null; this.clearOverlay(); this.render(); } })),
        h('div', { class: 'stat-grid' }, r.lines.flatMap(([k, v]) => [h('span', {}, k), h('span', {}, String(v))])),
        r.actions.length ? h('div', { class: 'insp-row-btns', style: { marginTop: '10px' } }, r.actions) : null));
    }
    const dis = (need) => (need ? '' : 'disabled');
    this.body.append(this._section('sculpt', 'Sculpt and select', [
      this._grid([
        ['Sculpt', 'Push, pull, smooth and paint the surface with brushes', () => this.enter('sculpt'), 'btn-primary ' + dis(one)],
        ['Select faces', 'Select triangles, then erase, extrude, extract or regroup them', () => this.enter('select'), dis(one)],
      ]),
      h('div', { class: 'insp-note' }, 'Both work on one shape at a time and turn it into a mesh. Press Done to keep the result.'),
    ]));
    this.body.append(this._section('edit', 'Edit', [
      this._grid([
        ['Mirror', 'Cut the shape in half and mirror one side to make it symmetric', () => this.symmetrize(), dis(n)],
        ['Duplicate', 'Copy the selection in place (Ctrl+D)', () => ed.duplicate(), dis(n)],
        ['Align', 'Line shapes up (L)', () => ed.setTool('align'), dis(n)],
        ['Plane cut', 'Slice the shape with a plane and keep one or both halves', () => this.planeCut(), dis(n)],
        ['Close cracks', 'Weld edges that almost touch', () => this.run((M) => { const r = ops.closeCracks(M, Math.hypot(...ops.meshBounds(M).size) * 5e-4); return r.merged ? r.mesh : null; }, { done: 'Cracks closed' }), dis(n)],
        ['Fill holes', 'Close every opening in the surface', () => this.run((M) => { const r = ops.fillHoles(M); return r.filled ? r.mesh : null; }, { done: 'Holes filled' }), dis(n)],
        ['Flip normals', 'Turn the surface inside out', () => this.run((M) => ops.flipNormals(M), { done: 'Flipped' }), dis(n)],
        ['Face groups', 'Split the surface into groups of faces by angle', () => this.faceGroups(), dis(n)],
        ['Make solid', 'Rebuild as one closed, printable solid', () => this.makeSolid(), dis(n)],
        ['Hollow', 'Leave a shell with a wall thickness you choose', () => this.hollow(), dis(n)],
        ['Offset', 'Grow or shrink the whole surface by a distance', () => this.offset(), dis(n)],
        ['Reduce', 'Use fewer triangles while keeping the shape', () => this.reduce(), dis(n)],
        ['Remesh', 'Make the triangles an even size', () => this.remesh(), dis(n)],
        ['Refine', 'Split every triangle into four', () => this.run((M) => ops.subdivide(M).mesh, { done: (f) => `Now ${f.reduce((s, x) => s + x.params.mesh.positions.length / 9, 0).toLocaleString()} triangles` }), dis(n)],
        ['Smooth', 'Relax the whole surface', () => this.smoothAll(), dis(n)],
        ['Make pattern', 'Turn the shape into struts, a lattice or a perforated copy', () => this.pattern(), dis(n)],
        ['Make slices', 'Cut into flat slabs for sheet material', () => this.slices(), dis(n)],
        ['Separate shells', 'Split disconnected pieces into their own shapes', () => this.separate(), dis(n)],
        ['Combine', 'Put several shapes into one mesh without fusing them', () => this.combine(), dis(n > 1)],
        ['Add tube', 'Drill a channel or add a rod between two points', () => this.tube(), dis(one)],
        ['Units / scale', 'Fix a model that came in at the wrong scale', () => this.units(), dis(n)],
        ['To mesh', 'Turn the shape into a plain triangle mesh', () => this.run((M) => M, { done: 'Converted to a mesh' }), dis(n)],
      ]),
    ]));
    const top = Math.max(10, Math.ceil(ed.worldBounds().max.z || 10));
    if (this.sliceHeight == null || this.sliceHeight > top) this.sliceHeight = top;
    const sliceCb = h('input', { type: 'checkbox', checked: !!this.sliceOn });
    sliceCb.addEventListener('change', () => this.setSlice(sliceCb.checked));
    this.body.append(this._section('analysis', 'Analysis', [
      this._grid([
        ['Inspector', 'Find holes, bad edges and loose pieces, and repair them', () => this.inspect(), dis(n)],
        ['Auto repair', 'Fix everything the Inspector finds', () => this.repair(), dis(n)],
        ['Measure', 'Distance between two points you click', () => this.measure()],
        ['Stability', 'Centre of mass, and whether the shape stands up', () => this.stability(), dis(n)],
        ['Strength', 'Find the layer with the least material', () => this.strength(), dis(n)],
        ['Thickness', 'Colour the surface by wall thickness', () => this.thickness(), dis(n)],
        ['Overhangs', 'Show the faces that need support', () => this.overhangs(false), dis(n)],
        ['Supports', 'Build support posts under the overhangs', () => this.overhangs(true), dis(n)],
        ['Orientation', 'Turn the shape the way it prints best', () => this.orientation(), dis(n)],
        ['Layout', 'Pack shapes into rows on the workplane', () => this.layout()],
        ['Deviation', 'How far apart two versions of a surface are', () => this.between('deviation'), dis(ed.selection.size === 2)],
        ['Clearance', 'The smallest gap between two shapes', () => this.between('clearance'), dis(ed.selection.size === 2)],
      ]),
      h('label', { class: 'check' }, sliceCb, 'Slicing: hide everything above a height'),
      this._slider('Slice height (mm)', this.sliceHeight, 0, top, 0.1, (v) => { sliceCb.checked = true; this.setSlice(true, v); }),
    ]));
    const first = ed.movableNodes()[0];
    const look = h('select', { class: 'select', 'aria-label': 'Shader' }, SHADERS.map(([v, text]) => h('option', { value: v }, text)));
    look.value = (first && first.shader) || '';
    look.disabled = !n;
    look.addEventListener('change', () => { ed.patchSelection({ shader: look.value || undefined }); look.blur(); });
    this.body.append(this._section('look', 'Shaders', [
      h('div', { class: 'param param-wide' }, h('label', {}, 'Surface look of the selection'), look),
      h('div', { class: 'insp-note' }, 'Changes how a shape is drawn on screen, which helps when checking a surface. Exports are not affected.'),
    ]));
  }

  _renderMode() {
    const mode = this.mode, b = mode.brush, sculpt = mode.sub === 'sculpt';
    const seg = h('div', { class: 'segmented mesh-seg' },
      button({ label: 'Sculpt', cls: sculpt ? 'active' : '', onClick: () => { mode.setSub('sculpt'); this.app._updateBanner(); } }),
      button({ label: 'Select faces', cls: sculpt ? '' : 'active', onClick: () => { mode.setSub('select'); this.app._updateBanner(); } }));
    this.statEl = h('div', { class: 'insp-note' }, this._statText());
    this.undoBtn = button({ icon: 'undo', title: 'Undo (Ctrl+Z)', cls: mode.canUndo ? '' : 'disabled', onClick: () => mode.undo() });
    this.redoBtn = button({ icon: 'redo', title: 'Redo (Ctrl+Y)', cls: mode.canRedo ? '' : 'disabled', onClick: () => mode.redo() });
    this.body.append(h('div', { class: 'mesh-head' }, mode.base.name || 'Editing a mesh'), h('div', { class: 'mesh-bar' }, seg, this.undoBtn, this.redoBtn), this.statEl);
    const scale = Math.max(2, mode.scale);
    const size = this._slider('Brush size (mm)', +b.size.toFixed(2), +(scale / 200).toFixed(3), +(scale / 1.5).toFixed(2), +(scale / 400).toFixed(3), (v) => mode.setBrush({ size: v }), '[ and ] also change the size');
    const wire = h('input', { type: 'checkbox', checked: mode.showWire });
    wire.addEventListener('change', () => mode.setWire(wire.checked));
    const ask = async (title, fields, fn, opts) => { const v = await formDialog(title, fields, opts); if (v && fn(v) === false) toast('Select some faces first'); };
    if (sculpt) {
      const grid = h('div', { class: 'brush-grid' }, BRUSHES.map(([id, name, tip]) => {
        const el = h('button', { class: 'brush' + (b.type === id ? ' active' : ''), type: 'button', title: tip }, name);
        el.addEventListener('click', () => mode.setBrush({ type: id }));
        return el;
      }));
      const fall = h('select', { class: 'select', 'aria-label': 'Falloff' }, FALLOFFS.map(([v, text]) => h('option', { value: v }, text)));
      fall.value = b.falloff;
      fall.addEventListener('change', () => { mode.setBrush({ falloff: fall.value }); fall.blur(); });
      const sym = h('input', { type: 'checkbox', checked: b.symmetry });
      sym.addEventListener('change', () => mode.setBrush({ symmetry: sym.checked }));
      const rows = [grid, size,
        this._slider('Strength', b.strength, 0.02, 1, 0.01, (v) => mode.setBrush({ strength: v })),
        h('div', { class: 'param param-wide' }, h('label', {}, 'Falloff'), fall),
        h('label', { class: 'check' }, sym, 'Symmetry (mirror left and right)'),
        h('label', { class: 'check' }, wire, 'Show triangles')];
      if (b.type === 'paint') {
        const cells = h('div', { class: 'color-grid' }, PALETTE.map((c) => { const cell = h('button', { class: 'color-cell' + (b.color === c ? ' picked' : ''), type: 'button', style: { background: c }, title: c }); cell.addEventListener('click', () => mode.setBrush({ color: c })); return cell; }));
        const custom = h('input', { type: 'color', value: b.color });
        custom.addEventListener('input', () => { b.color = custom.value; });
        rows.push(h('div', { class: 'param param-wide' }, h('label', {}, 'Paint colour'), cells, h('div', { class: 'color-custom' }, custom, h('span', {}, 'Custom colour'))));
      }
      this.body.append(this._section('sculpt', 'Brushes', rows));
      this.body.append(this._section('edit', 'Refinement', [
        this._grid([
          ['Refine', 'Split every triangle into four, for finer detail', () => mode.refine()],
          ['Reduce', 'Halve the number of triangles', () => mode.reduce(50)],
          ['Smooth all', 'Relax the whole surface a little', () => mode.smoothFaces(3, 0.5)],
        ]),
        h('div', { class: 'insp-note' }, 'Drag on the shape to sculpt. Shift smooths, Alt reverses the brush. Right-drag still orbits.'),
      ]));
    } else {
      const lasso = mode.selectTool === 'lasso';
      const tools = h('div', { class: 'segmented mesh-seg' },
        button({ label: 'Brush', cls: lasso ? '' : 'active', onClick: () => { mode.selectTool = 'brush'; this.render(); } }),
        button({ label: 'Lasso', cls: lasso ? 'active' : '', onClick: () => { mode.selectTool = 'lasso'; this.render(); } }));
      const groups = h('input', { type: 'checkbox', checked: mode.showGroups });
      groups.addEventListener('change', () => mode.setShowGroups(groups.checked));
      this.body.append(this._section('sculpt', 'Select', [tools, lasso ? null : size,
        this._grid([
          ['All', 'Select every face', () => mode.selectAll()], ['None', 'Clear the selection', () => mode.selectNone()], ['Invert', 'Swap selected and unselected', () => mode.selectInvert()],
          ['Grow', 'Add one ring of faces', () => mode.selectGrow(false)], ['Shrink', 'Remove one ring of faces', () => mode.selectGrow(true)], ['Connected', 'Add everything connected to the selection (or double-click a face)', () => mode.selectConnected()],
          ['To groups', 'Add the whole face group of every selected face', () => { if (!mode.selectGroups()) toast('This mesh has no face groups yet'); }],
        ]),
        h('label', { class: 'check' }, wire, 'Show triangles'),
        h('div', { class: 'insp-note' }, 'Drag to select faces. Shift or Alt removes them. Double-click selects a whole connected piece.'),
      ]));
      const need = (ok) => { if (ok === false) toast('Select some faces first (and not all of them, for erase and discard)'); };
      this.body.append(this._section('edit', 'Edit the selection', [
        this._grid([
          ['Erase & fill', 'Delete the faces and patch the gap smoothly', () => need(mode.eraseAndFill())],
          ['Discard', 'Delete the faces, leaving a hole', () => need(mode.discard())],
          ['Extrude', 'Push the faces out and build walls around them', () => ask('Extrude', [{ key: 'd', label: 'Distance (mm), negative goes inward', value: 2, step: 0.1 }], (v) => mode.extrude(v.d, false), { ok: 'Extrude' })],
          ['Offset', 'Move each face along its own direction', () => ask('Offset', [{ key: 'd', label: 'Distance (mm), negative goes inward', value: 1, step: 0.1 }], (v) => mode.extrude(v.d, true), { ok: 'Offset' })],
          ['Extract', 'Copy the faces out as a new shape', () => ask('Extract', [{ key: 't', label: 'Thickness of the new shape (mm), 0 for a bare surface', value: 1, min: 0, step: 0.1 }], (v) => { const node = mode.extract(v.t, false); if (node) toast('Extracted as a new shape'); return !!node; }, { ok: 'Extract' })],
          ['Separate', 'Move the faces into a new shape', () => { const node = mode.extract(0, true); if (node) toast('Separated into a new shape'); else need(false); }],
          ['Transform', 'Move, scale or turn the faces', () => ask('Transform', [
            { key: 'x', label: 'Move X (mm)', value: 0, step: 0.1 }, { key: 'y', label: 'Move Y (mm)', value: 0, step: 0.1 }, { key: 'z', label: 'Move Z (mm)', value: 0, step: 0.1 },
            { key: 's', label: 'Scale (1 = unchanged)', value: 1, min: 0.01, step: 0.05 }, { key: 'rz', label: 'Turn about Z (degrees)', value: 0, step: 1 },
            { key: 'soft', label: 'Soft: blend into the surface over (mm), 0 = off', value: 0, min: 0, step: 0.5 },
          ], (v) => mode.transformFaces({ move: [v.x, v.y, v.z], scale: v.s, rotate: [0, 0, v.rz], soft: v.soft }), { ok: 'Transform', note: 'Soft transform drags the surrounding surface along, fading out with distance.' })],
          ['Smooth', 'Relax the selected faces (or all of them)', () => mode.smoothFaces(6, 0.5)],
          ['Refine', 'Split the selected faces (or all) into four', () => mode.refine()],
          ['Reduce', 'Use fewer triangles in the selection (or everywhere)', () => ask('Reduce', [{ key: 'p', label: 'Keep this share of the triangles (%)', value: 50, min: 1, max: 100, step: 1 }], (v) => mode.reduce(v.p), { ok: 'Reduce' })],
          ['Flip normals', 'Turn the selected faces (or all) inside out', () => mode.flip()],
          ['Fill holes', 'Close every opening in the mesh', () => { if (!mode.fillHoles()) toast('There are no holes to fill'); }],
        ]),
      ]));
      this.body.append(this._section('look', 'Face groups', [
        this._grid([
          ['Create', 'Make the selection one face group', () => need(mode.createGroup())],
          ['Clear', 'Remove the groups of the selection (or all of them)', () => { if (!mode.clearGroups()) toast('This mesh has no face groups'); }],
          ['By angle', 'Split the whole mesh into groups where faces meet sharply', () => ask('Generate face groups', [{ key: 'a', label: 'Split where faces meet at more than (degrees)', value: 30, min: 1, max: 180, step: 1 }], (v) => { toast(`Made ${mode.generateGroups(v.a)} face groups`); }, { ok: 'Generate' })],
        ]),
        h('label', { class: 'check' }, groups, 'Show face groups in colour'),
      ]));
    }
    this.body.append(h('div', { class: 'mesh-done' },
      button({ label: 'Cancel', cls: 'btn-outline', title: 'Throw the changes away (Esc)', onClick: () => this.app.exitMeshMode(false) }),
      button({ label: 'Done', cls: 'btn-primary', title: 'Keep the changes (Enter)', onClick: () => this.app.exitMeshMode(true) })));
  }
}
