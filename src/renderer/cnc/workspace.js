// CNC workspace: the same 2D editor as the laser tab, plus toolpaths, a 3D preview and machine control.
import { h, clear, button, icon, toast, popupMenu } from '../ui/dom.js';
import { platform } from '../platform.js';
import { LaserWorkspace } from '../laser/workspace.js';
import { newLaserDoc, deep, flatten, boundsOf, invert, apply, translate, mul } from '../laser/model.js';
import * as tools from '../laser/tools.js';
import * as extras from '../laser/extras.js';
import { depthMapStudio } from '../laser/depthmap.js';
import { boxMakerDialog } from '../laser/boxmaker.js';
import { computeToolpath, TOOLPATH_TYPES } from './cam.js';
import { buildGcode, expandMoves, measure, toolLabel, toolKey, formatTime, POSTS } from './gcode.js';
import { DEFAULT_TOOLS, MATERIALS, recommend } from './tooldb.js';
import { CncDevice } from './device.js';
import { Simulator } from './sim.js';
import { PathView3D } from './view3d.js';
import { MachinePanel } from './control.js';
import { unitsOf, numRow, selectRow, checkRow, textRow, section } from './ui.js';
import * as dialogs from './dialogs.js';

export const DEFAULT_CNC = {
  post: 'grbl', safeZ: 5, spindle: 'auto', spinUp: 3, coolant: 'off', park: 'none', rapidRate: 3000, splitByTool: false,
  maxFeed: 5000, maxRpm: 24000, strength: 1, baud: 115200, gridSnap: 1, showGrid: true,
  jogFeed: 2000, jogStep: 10, tools: null, macros: null, network: '', probe: { plateZ: 15, plateXY: 10, feed: 100, distance: 25, bit: 6.35 },
};
export const newJob = () => ({ w: 300, h: 300, t: 18, units: 'mm', material: 'softwood', xyZero: 'bl', zZero: 'top' });
export const newCncDoc = () => ({ ...newLaserDoc(), job: newJob(), toolpaths: [] });

const TP_COLORS = ['#4dabf7', '#ff922b', '#51cf66', '#f06595', '#fcc419', '#22b8cf', '#9775fa', '#ff6b6b'];
const TYPE_ICON = { profile: 'cncProfile', pocket: 'cncPocket', vcarve: 'cncVcarve', engrave: 'pencil', drill: 'cncDrill', chamfer: 'cncChamfer', inlay: 'intersect', texture: 'cncTexture', relief: 'stats' };
const typeName = (t) => (TOOLPATH_TYPES.find((x) => x[0] === t) || [t, t])[1];
const ZERO_NAMES = { bl: 'Front left', br: 'Front right', tl: 'Back left', tr: 'Back right', c: 'Centre' };
let tpSeq = 1;

export class CncWorkspace extends LaserWorkspace {
  constructor(app, root) {
    super(app, root);
    this.showPowerScale = false;
  }

  // ---------------------------------------------------------------- set-up
  _initCnc() {
    this.cfg = { ...DEFAULT_CNC, ...(this.app.settings.cnc || {}) };
    this.cfg.probe = { ...DEFAULT_CNC.probe, ...(this.cfg.probe || {}) };
    this.doc = newCncDoc();
    this.device = new CncDevice();
    this.computed = new Map(); // toolpath id -> { key, sections, warnings, draw, stats }
    this.tpSel = null;
    this.mode = 'design';
    this._syncMachine();
  }

  /** The base editor reads its work area from `machine`: here that is the piece of material. */
  _syncMachine() {
    const j = this.doc.job;
    this.machine = { name: 'CNC', bedW: j.w, bedH: j.h, origin: 'bl', gridSnap: this.cfg.gridSnap, showGrid: this.cfg.showGrid, speedUnits: 'mm/min', baud: this.cfg.baud };
  }

  get job() { return this.doc.job; }
  get u() { return unitsOf(this.doc.job.units); }
  bits() { return Array.isArray(this.cfg.tools) && this.cfg.tools.length ? this.cfg.tools : DEFAULT_TOOLS; }
  saveCfg(patch = {}) { Object.assign(this.cfg, patch); this.app.patchSettings({ cnc: { ...this.cfg } }); this._syncMachine(); this._invalidate(); this.refresh(); }
  saveMachine() { this.saveCfg({ gridSnap: this.machine.gridSnap, showGrid: this.machine.showGrid }); }

  load(cncDoc) {
    const base = newCncDoc();
    this.doc = cncDoc ? { ...base, ...deep(cncDoc), job: { ...base.job, ...(cncDoc.job || {}) }, toolpaths: deep(cncDoc.toolpaths || []) } : base;
    this._syncMachine();
    this.sel = []; this.pen = null; this.nodeShape = null; this.tpSel = null;
    this.history = []; this.hIndex = -1;
    this._pushHistory();
    this.selectedLayer = 0;
    this.computed.clear();
    this._loadImages();
    if (this.preview && this.preview.open) this.closePreview();
    this._known = new Set(this._index().keys());
    // fit the view to the new material now, or the next time the tab is opened
    if (this.active) { this.zoomToBed(); this.refresh(); } else this._zoomed = false;
    this._scheduleCompute();
  }

  _snapshot() { return { ...super._snapshot(), toolpaths: deep(this.doc.toolpaths), job: deep(this.doc.job) }; }
  _restore(i) {
    const s = this.history[i];
    if (!s) return;
    this.doc.toolpaths = deep(s.toolpaths || []);
    this.doc.job = deep(s.job || newJob());
    this._syncMachine();
    super._restore(i);
    this._known = new Set(this._index().keys());
    this._scheduleCompute();
  }
  /** Every shape at any depth of grouping: id -> { shape, parent (matrix of the groups above it), top (id of its top-level shape) }. */
  _index() {
    const map = new Map();
    const visit = (list, parent, top) => { for (const s of list) { map.set(s.id, { shape: s, parent, top: top || s.id }); if (s.children) visit(s.children, mul(parent, s.m), top || s.id); } };
    visit(this.doc.shapes, [1, 0, 0, 1, 0, 0], null);
    return map;
  }

  commit() {
    const index = this._index(), before = this._known || new Set();
    const gone = [...before].some((id) => !index.has(id));
    const fresh = [...index.keys()].filter((id) => !before.has(id) && index.get(id).top === id);
    for (const tp of this.doc.toolpaths) {
      if (tp.shapes.every((id) => index.has(id))) continue;
      tp.shapes = tp.shapes.filter((id) => index.has(id));
      // an edit that replaces shapes (weld, break apart, join): carry on cutting what they became
      if (gone) for (const id of fresh) if (!tp.shapes.includes(id) && (tp.type === 'relief') === (index.get(id).shape.type === 'image')) tp.shapes.push(id);
    }
    this._known = new Set(index.keys());
    super.commit();
    this._scheduleCompute();
  }

  ungroup() {
    // a toolpath on a group carries on with the shapes that were inside it
    for (const g of this.movable().filter((x) => x.type === 'group')) for (const tp of this.doc.toolpaths) {
      const i = tp.shapes.indexOf(g.id);
      if (i >= 0) tp.shapes.splice(i, 1, ...g.children.map((c) => c.id).filter((id) => !tp.shapes.includes(id)));
    }
    super.ungroup();
  }

  /** The property bar shows lengths in the job's units. */
  get lenScale() { return this.doc && this.doc.job ? this.u.k : 1; }
  /** ...and X and Y from the job's XY zero, like the read-out under the pointer and the G-code. */
  toProp(x, y) { return this.toJob([x, y]); }
  fromProp(nx, ny) { return this.fromJob([nx, ny]); }

  /** Rulers count from XY zero in the job's units. */
  _drawRulers(ctx, C) {
    const R = 22, v = this.view, j = this.job, u = this.u, [ox, oy] = this.zeroPoint();
    ctx.fillStyle = C.ruler;
    ctx.fillRect(0, 0, this.w, R); ctx.fillRect(0, 0, R, this.h);
    ctx.strokeStyle = C.major; ctx.fillStyle = C.text; ctx.font = '10px "Segoe UI", system-ui, sans-serif'; ctx.lineWidth = 1;
    const per = v.scale / u.k; // pixels per shown unit
    const step = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500].find((s) => s * per >= 42) || 1000;
    const label = (n) => String(+(n * step).toFixed(3));
    ctx.beginPath();
    for (let n = Math.ceil((-ox * u.k) / step - 1e-9); n * step <= (j.w - ox) * u.k + 1e-9; n++) {
      const sx = Math.round(this.toScreen([ox + (n * step) / u.k, 0])[0]) + 0.5;
      if (sx < R || sx > this.w) continue;
      ctx.moveTo(sx, R - 7); ctx.lineTo(sx, R);
      ctx.fillText(label(n), sx + 2, 10);
    }
    for (let n = Math.ceil(((oy - j.h) * u.k) / step - 1e-9); n * step <= oy * u.k + 1e-9; n++) {
      const sy = Math.round(this.toScreen([0, oy - (n * step) / u.k])[1]) + 0.5;
      if (sy < R || sy > this.h) continue;
      ctx.moveTo(R - 7, sy); ctx.lineTo(R, sy);
      ctx.save(); ctx.translate(10, sy - 2); ctx.rotate(-Math.PI / 2); ctx.fillText(label(n), 0, 0); ctx.restore();
    }
    ctx.stroke();
    ctx.fillStyle = C.ruler; ctx.fillRect(0, 0, R, R);
  }
  _invalidate() { this.computed.clear(); this._scheduleCompute(); }

  // ---------------------------------------------------------------- layout
  _build() {
    this._initCnc();
    const tb = (ic, title, onClick, label) => button({ icon: ic, title, onClick, label });
    const menuBtn = (label, ic, items) => { const b = button({ icon: ic, label, title: label, onClick: () => popupMenu(items(), b) }); return b; };
    this.modeSeg = h('div', { class: 'segmented cnc-mode', title: 'Draw and set up cuts, or run the machine' });
    for (const [id, label, ic, tip] of [['design', 'Design', 'pencil', 'Draw, choose what to cut and how deep, and preview the result'], ['machine', 'Machine', 'cncMachine', 'Connect to the CNC machine, set zero and run the job']]) {
      const b = button({ label, icon: ic, title: tip, size: 16, onClick: () => this.setMode(id) });
      b.dataset.cncMode = id;
      this.modeSeg.append(b);
    }
    this.toolbar = h('div', { class: 'toolbar laser-toolbar cnc-toolbar', role: 'toolbar', 'aria-label': 'CNC tools' },
      this.modeSeg, h('span', { class: 'sep' }),
      tb('import', 'Import SVG, DXF or pictures (Ctrl+I)', () => this.importDialog(), 'Import'),
      menuBtn('Export', 'export', () => [
        { label: 'Save G-code…', icon: 'export', shortcut: 'Ctrl+Shift+S', onClick: () => this.saveGcode() },
        { label: 'Export drawing as SVG…', onClick: () => tools.exportVector(this, 'svg') },
        { label: 'Export drawing as DXF…', onClick: () => tools.exportVector(this, 'dxf') },
      ]),
      tb('cube', 'Bring the outline of the 3D design into the drawing', () => tools.from3D(this), 'From 3D'),
      h('span', { class: 'sep' }),
      tb('undo', 'Undo (Ctrl+Z)', () => this.undo()), tb('redo', 'Redo (Ctrl+Y)', () => this.redo()),
      h('span', { class: 'sep' }),
      tb('copy', 'Copy (Ctrl+C)', () => this.copy()), tb('paste', 'Paste (Ctrl+V)', () => this.paste()),
      tb('duplicate', 'Duplicate (Ctrl+D)', () => this.duplicate()), tb('trash', 'Delete (Del)', () => this.remove()),
      h('span', { class: 'sep' }),
      tb('group', 'Group (Ctrl+G)', () => this.group(), 'Group'), tb('ungroup', 'Ungroup (Ctrl+U)', () => this.ungroup(), 'Ungroup'),
      h('span', { class: 'sep' }),
      menuBtn('Shapes', 'star', () => dialogs.SHAPES.map(([id, label]) => ({ label, onClick: () => dialogs.insertShape(this, id) }))),
      menuBtn('Arrange', 'align', () => [
        { label: 'Align left', onClick: () => this.align('x', 0) }, { label: 'Align centres (vertical axis)', onClick: () => this.align('x', 0.5) }, { label: 'Align right', onClick: () => this.align('x', 1) },
        { label: 'Align top', onClick: () => this.align('y', 0) }, { label: 'Align centres (horizontal axis)', onClick: () => this.align('y', 0.5) }, { label: 'Align bottom', onClick: () => this.align('y', 1) },
        'sep',
        { label: 'Distribute horizontally', onClick: () => this.distribute('x') }, { label: 'Distribute vertically', onClick: () => this.distribute('y') },
        'sep',
        { label: 'Move to the centre of the material', shortcut: 'P', onClick: () => this.moveToBed(4) },
        { label: 'Move to the front left corner', onClick: () => this.moveToBed(6) },
        'sep',
        { label: 'Flip horizontal', shortcut: 'Ctrl+Shift+H', onClick: () => this.flip('x') }, { label: 'Flip vertical', shortcut: 'Ctrl+Shift+V', onClick: () => this.flip('y') },
        { label: 'Rotate 90° clockwise', shortcut: '.', onClick: () => this.rotate(90) }, { label: 'Rotate 90° counter-clockwise', shortcut: ',', onClick: () => this.rotate(-90) },
        'sep',
        { label: 'Bring to front', shortcut: 'PgUp', onClick: () => this.order(1) }, { label: 'Send to back', shortcut: 'PgDn', onClick: () => this.order(-1) },
        { label: 'Lock / unlock', onClick: () => this.toggleLock() },
      ]),
      menuBtn('Modify', 'intersect', () => [
        { label: 'Weld (union)', shortcut: 'Ctrl+W', onClick: () => tools.boolean(this, 'union') },
        { label: 'Subtract (first minus the rest)', onClick: () => tools.boolean(this, 'subtract') },
        { label: 'Intersect', onClick: () => tools.boolean(this, 'intersect') },
        { label: 'Exclude (XOR)', onClick: () => tools.boolean(this, 'xor') },
        'sep',
        { label: 'Offset shapes…', shortcut: 'Alt+O', onClick: () => tools.offsetDialog(this) },
        { label: 'Round corners…', onClick: () => dialogs.roundCornersDialog(this) },
        { label: 'Convert to path', onClick: () => this.convertToPath() },
        { label: 'Close path', onClick: () => this.closePaths() },
        { label: 'Break apart', onClick: () => this.breakApart() },
        { label: 'Auto-join open paths', onClick: () => this.autoJoin() },
        { label: 'Delete duplicates', onClick: () => this.deleteDuplicates() },
        'sep',
        { label: 'Text on path', onClick: () => extras.textOnPath(this) },
        { label: 'Grid array…', onClick: () => tools.gridArrayDialog(this) },
        { label: 'Circular array…', onClick: () => tools.circularArrayDialog(this) },
        { label: 'Fit parts onto the material (nest)', onClick: () => dialogs.nestSelection(this) },
        'sep',
        { label: 'Trace picture…', onClick: () => tools.traceDialog(this) },
      ]),
      menuBtn('Create', 'plus', () => [
        { label: 'Height map from an STL model or picture (for 3D relief)…', onClick: () => depthMapStudio(this) },
        { label: 'Box maker (finger joints)…', onClick: () => boxMakerDialog(this) },
        { label: 'QR code…', onClick: () => tools.qrDialog(this) },
      ]),
      h('span', { class: 'spacer' }),
      tb('settings', 'Bits, machine and G-code settings', () => dialogs.settingsDialog(this), 'Setup'));

    this.propBar = h('div', { class: 'laser-props' });
    this.toolBtns = {};
    const toolBtn = (id, ic, title) => { const b = button({ icon: ic, title, onClick: () => this.setTool(id) }); this.toolBtns[id] = b; return b; };
    this.toolCol = h('div', { class: 'laser-tools' },
      toolBtn('select', 'select', 'Select (Esc)'), toolBtn('node', 'lnode', 'Edit nodes (`)'),
      toolBtn('line', 'lline', 'Draw lines and curves (Ctrl+L). Click for corners, drag for curves, double-click to finish.'),
      toolBtn('rect', 'lrect', 'Rectangle (Ctrl+R). Shift for a square.'), toolBtn('ellipse', 'lellipse', 'Circle or ellipse (Ctrl+E). Shift for a circle.'),
      toolBtn('polygon', 'lpolygon', 'Polygon'), toolBtn('text', 'ltext', 'Text (Ctrl+T)'),
      toolBtn('measure', 'ruler', 'Measure (Alt+M)'));

    this.canvas = h('canvas', { class: 'laser-canvas', 'aria-label': 'Material drawing area' });
    this.ctx = this.canvas.getContext('2d');
    this.coords = h('div', { class: 'laser-coords' });
    this.previewEl = h('div', { class: 'cnc-preview' });
    this.wrap = h('div', { class: 'laser-canvas-wrap' }, this.canvas, this.coords, this.previewEl);

    this.jobPanel = h('div', {});
    this.tpPanel = h('div', {});
    this.outPanel = h('div', {});
    // not used by this workspace, but the shared editor expects them to exist
    this.layerList = h('div'); this.layerEditor = h('div'); this.palette = h('div');
    this.side = h('div', { class: 'laser-side cnc-side' },
      section('1 · Material', this.jobPanel),
      section('2 · Toolpaths', this.tpPanel),
      section('3 · Preview and cut', this.outPanel));
    this.side.addEventListener('keydown', (e) => { if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') e.stopPropagation(); });
    this.side.addEventListener('pointerdown', () => { this._sideDown = true; }, true);
    const sideUp = () => { if (this._sideDown) setTimeout(() => { this._sideDown = false; if (this._sidePending) { this._sidePending = false; this._renderLayers(); } }, 80); };
    window.addEventListener('pointerup', sideUp);
    window.addEventListener('pointercancel', sideUp);
    this.side.addEventListener('input', (e) => { if (e.target.dataset) e.target.dataset.dirty = '1'; });
    this.side.addEventListener('change', (e) => { if (e.target.dataset) delete e.target.dataset.dirty; }, true);
    this.statusBar = h('div', { class: 'laser-status' });
    this.designRoot = h('div', { class: 'cnc-design' }, this.propBar, h('div', { class: 'laser-main' }, this.toolCol, this.wrap, this.side));
    this.machineRoot = h('div', { class: 'cnc-machine' });
    this.root.append(this.toolbar, this.designRoot, this.machineRoot, h('div', { class: 'laser-bottom' }, this.statusBar));

    const cv = this.canvas;
    cv.addEventListener('pointerdown', (e) => this._down(e));
    cv.addEventListener('pointermove', (e) => this._move(e));
    cv.addEventListener('pointerup', (e) => this._up(e));
    cv.addEventListener('pointercancel', (e) => this._up(e));
    cv.addEventListener('dblclick', (e) => this._dblclick(e));
    cv.addEventListener('wheel', (e) => this._wheel(e), { passive: false });
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    this.machinePanel = new MachinePanel(this, this.machineRoot);
    this._syncMode();
  }

  _bindDevice() { /* the Machine panel listens to the controller itself */ }
  _renderPaletteState() {}

  setActive(on) {
    super.setActive(on);
    if (on) { this._scheduleCompute(); this.machinePanel.setActive(this.mode === 'machine'); } else this.machinePanel.setActive(false);
  }

  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    this._syncMode();
    if (mode === 'design') { this._resize(); this.refresh(); }
    this.machinePanel.setActive(mode === 'machine' && this.active);
  }
  _syncMode() {
    this.root.classList.toggle('cnc-in-machine', this.mode === 'machine');
    for (const b of this.modeSeg.children) b.classList.toggle('active', b.dataset.cncMode === this.mode);
  }

  // ---------------------------------------------------------------- coordinates
  /** Where XY zero sits, in drawing coordinates (which run from the back-left corner, Y towards the front). */
  zeroPoint() {
    const j = this.job, z = j.xyZero;
    return z === 'c' ? [j.w / 2, j.h / 2] : [z.endsWith('r') ? j.w : 0, z.startsWith('b') ? j.h : 0];
  }
  toJob(p) { const [ox, oy] = this.zeroPoint(); return [p[0] - ox, oy - p[1]]; }
  fromJob(p) { const [ox, oy] = this.zeroPoint(); return [p[0] + ox, oy - p[1]]; }
  stock() { const [ox, oy] = this.zeroPoint(), j = this.job; return { x0: -ox, y0: oy - j.h, w: j.w, h: j.h, t: j.t }; }

  _move(e) {
    super._move(e);
    const [x, y] = this.toJob(this.toBed(e)), u = this.u;
    this.coords.textContent = `X ${u.show(x)}   Y ${u.show(y)} ${u.name}`;
  }

  // ---------------------------------------------------------------- toolpaths: data
  newToolpath(type, shapes) {
    const j = this.job, bits = this.bits();
    const pick = (kind, near) => { const list = bits.filter((b) => b.type === kind); return deep(list.sort((a, b) => Math.abs(a.dia - near) - Math.abs(b.dia - near))[0] || bits[0]); };
    const base = { id: 'tp' + Date.now().toString(36) + tpSeq++, type, name: '', shapes: [...shapes], enabled: true, auto: true, startDepth: 0, direction: 'climb' };
    switch (type) {
      case 'profile': return { ...base, tool: pick('end', 6.35), side: 'outside', through: true, depth: j.t, tabs: { count: 4, width: 6, height: 2 }, ramp: 0, dogbone: false, finishAllowance: 0 };
      case 'pocket': return { ...base, tool: pick('end', 6.35), depth: +Math.min(5, j.t / 3).toFixed(2), strategy: 'offset', angle: 0, ramp: 0, dogbone: false, finishAllowance: 0 };
      case 'vcarve': return { ...base, tool: pick('vbit', 12.7), depth: 0, flatDepth: 0, clearTool: null };
      case 'engrave': return { ...base, tool: pick('vbit', 12.7), depth: 0.5, flute: 0 };
      case 'drill': return { ...base, tool: pick('drill', 3.175), through: true, depth: j.t, peck: 3, dwell: 0 };
      case 'chamfer': { const t = bits.find((b) => b.type === 'vbit' && b.angle === 90) || pick('vbit', 12.7); return { ...base, tool: deep(t), side: 'outside', width: 1.5, tipOffset: 0.5 }; }
      case 'inlay': return { ...base, tool: pick('end', 3.175), part: 'pocket', depth: 3, gap: 0.1, strategy: 'offset' };
      case 'texture': return { ...base, tool: pick('ball', 6.35), depth: 1.5, scoop: 20, angle: 0, variation: 40, seed: 7 };
      case 'relief': return { ...base, tool: pick('ball', 3.175), depth: 5, mode: 'finish', angle: 0, invert: false, allowance: 0.5 };
      default: return { ...base, tool: pick('end', 6.35), depth: 1 };
    }
  }

  addToolpath(type) {
    const ids = this.selected().filter((s) => (type === 'relief' ? s.type === 'image' : true)).map((s) => s.id);
    if (!ids.length) { toast(type === 'relief' ? 'Select a picture first. Create → Height map makes one from a 3D model.' : 'Select the shapes this toolpath should cut first.', 'warn', 4500); return null; }
    const tp = this.newToolpath(type, ids);
    this.doc.toolpaths.push(tp);
    this.tpSel = tp.id;
    this.commit();
    return tp;
  }

  removeToolpath(id) { this.doc.toolpaths = this.doc.toolpaths.filter((t) => t.id !== id); if (this.tpSel === id) this.tpSel = null; this.commit(); }
  moveToolpath(id, dir) {
    const list = this.doc.toolpaths, i = list.findIndex((t) => t.id === id), j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    this.commit();
  }

  /** The settings a toolpath is actually cut with: depths resolved, automatic feeds filled in. */
  resolve(tp) {
    const j = this.job, lim = { strength: this.cfg.strength, maxFeed: this.cfg.maxFeed, maxRpm: this.cfg.maxRpm };
    const rec = recommend(tp.tool, j.material, lim);
    const out = { ...tp };
    if (tp.through && (tp.type === 'profile' || tp.type === 'drill')) out.depth = j.t + 0.3;
    for (const k of ['feed', 'plunge', 'rpm', 'passDepth', 'stepover']) if (tp.auto || !(tp[k] > 0)) out[k] = rec[k];
    if (tp.type === 'relief' && tp.mode === 'rough' && (tp.auto || !(tp.stepover > 0))) out.stepover = +(tp.tool.dia * 0.4).toFixed(2);
    if (tp.type === 'texture' && (tp.auto || !(tp.stepover > 0))) out.stepover = +(tp.tool.dia * 0.8).toFixed(2);
    if (tp.clearTool) { const r2 = recommend(tp.clearTool, j.material, lim); out.clearTool = { ...tp.clearTool, passDepth: r2.passDepth }; out.clearFeeds = r2; }
    return out;
  }

  /** The outlines a toolpath works on, in job coordinates, one list per shape. */
  geomFor(tp, res) {
    const index = this._index();
    const groups = [];
    let heightmap = null;
    for (const id of tp.shapes) {
      const e = index.get(id);
      if (!e) continue;
      // a shape inside a group sits where its groups put it
      const s = e.top === id ? e.shape : { ...e.shape, m: mul(e.parent, e.shape.m) };
      if (tp.type === 'relief') { if (s.type === 'image' && !heightmap) heightmap = this._heightmap(s, res); continue; }
      const polys = flatten(s).filter((p) => p.shape.type !== 'image').map((p) => ({ closed: p.closed, pts: p.pts.map((q) => this.toJob(q)) }));
      if (polys.length) groups.push(polys);
    }
    return { groups, heightmap };
  }

  /** A picture as a grid of heights (bright = high) laid over where it sits on the material. */
  _heightmap(s, res) {
    const img = this.images.get(s.id);
    if (!img) return null;
    const b = boundsOf([s]);
    const a = this.toJob([b.x0, b.y1]), c = this.toJob([b.x1, b.y0]);
    const tp = res || {};
    const cell = Math.max(0.1, Math.max(b.w, b.h) / 700, (tp.stepover || 0.5) / 2);
    const w = Math.max(2, Math.round((c[0] - a[0]) / cell) + 1), hgt = Math.max(2, Math.round((c[1] - a[1]) / cell) + 1);
    const cv = document.createElement('canvas');
    cv.width = Math.min(1400, img.naturalWidth || img.width); cv.height = Math.min(1400, Math.round(cv.width * (img.naturalHeight || img.height) / (img.naturalWidth || img.width)));
    const cx = cv.getContext('2d', { willReadFrequently: true });
    cx.drawImage(img, 0, 0, cv.width, cv.height);
    const px = cx.getImageData(0, 0, cv.width, cv.height).data;
    const inv = invert(s.m), data = new Float32Array(w * hgt);
    for (let jj = 0; jj < hgt; jj++) for (let i = 0; i < w; i++) {
      const local = apply(inv, this.fromJob([a[0] + i * cell, a[1] + jj * cell]));
      const ix = Math.floor((local[0] / s.w) * cv.width), iy = Math.floor((local[1] / s.h) * cv.height);
      if (ix < 0 || iy < 0 || ix >= cv.width || iy >= cv.height) continue;
      const k = (iy * cv.width + ix) * 4;
      if (px[k + 3] < 8) continue;
      const v = (0.299 * px[k] + 0.587 * px[k + 1] + 0.114 * px[k + 2]) / 255;
      data[jj * w + i] = tp.invert ? 1 - v : v;
    }
    return { data, w, h: hgt, x0: a[0], y0: a[1], cell };
  }

  _keyFor(tp, res) {
    const index = this._index();
    const { id, name, enabled, ...rest } = res; void id; void name; void enabled;
    return JSON.stringify([rest, this.job.t, this.job.xyZero, this.job.w, this.job.h, tp.shapes.map((sid) => { const e = index.get(sid); return e ? [e.shape, e.parent] : null; })], (k, v) => (k === 'src' ? undefined : v))
      + (tp.type === 'relief' ? tp.shapes.map((sid) => (this.images.has(sid) ? 'i' : '-')).join('') : '');
  }

  _scheduleCompute() {
    clearTimeout(this._camTimer);
    this._camTimer = setTimeout(() => this._compute(), 140);
  }

  /** Work out every toolpath whose settings or shapes changed. */
  _compute() {
    clearTimeout(this._camTimer);
    const alive = new Set();
    let changed = false;
    for (const tp of this.doc.toolpaths) {
      alive.add(tp.id);
      const res = this.resolve(tp), key = this._keyFor(tp, res);
      const old = this.computed.get(tp.id);
      if (old && old.key === key) continue;
      let out;
      try { out = computeToolpath(res, this.geomFor(tp, res)); }
      catch (err) { console.error(err); out = { sections: [], warnings: ['This toolpath could not be worked out: ' + (err.message || err)] }; }
      const sections = out.sections.map((sec) => {
        const f = sec.role === 'clear' ? res.clearFeeds : res;
        return { name: (tp.name || typeName(tp.type)) + (sec.role === 'clear' ? ' (clear the flat areas)' : ''), tool: sec.tool, feed: f.feed, plunge: f.plunge, rpm: f.rpm, paths: sec.paths };
      });
      const warnings = [...out.warnings];
      if (res.depth > this.job.t + 0.31 && tp.type !== 'vcarve') warnings.push('This cuts deeper than the material is thick, into the bed below.');
      const draw = sections.map((sec) => {
        const p2 = new Path2D();
        for (const path of sec.paths) path.pts.forEach((q, i) => { if (i && !q[3]) p2.lineTo(q[0], q[1]); else p2.moveTo(q[0], q[1]); });
        return { p2, tool: sec.tool };
      });
      const stats = sections.length ? measure(expandMoves({ sections }, this.outOpts()), this.outOpts()) : null;
      this.computed.set(tp.id, { key, sections, warnings, draw, stats });
      changed = true;
    }
    for (const id of [...this.computed.keys()]) if (!alive.has(id)) { this.computed.delete(id); changed = true; }
    if (changed) { this._renderLayers(); this.redraw(); if (this.preview && this.preview.open) this._startPreview(); }
    return changed;
  }

  /** Everything that is switched on, in cutting order. */
  program() {
    this._compute();
    const sections = [], warnings = [];
    for (const tp of this.doc.toolpaths) {
      if (!tp.enabled) continue;
      const c = this.computed.get(tp.id);
      if (!c) continue;
      sections.push(...c.sections);
      for (const w of c.warnings) warnings.push(`${tp.name || typeName(tp.type)}: ${w}`);
    }
    const j = this.job, u = this.u;
    return {
      name: this.app.editor.doc.name || 'Job', sections, warnings,
      notes: [`Material ${u.show(j.w)} x ${u.show(j.h)} x ${u.show(j.t)} ${u.name}`, `XY zero: ${ZERO_NAMES[j.xyZero]}. Z zero: ${j.zZero === 'bed' ? 'machine bed' : 'top of the material'}`],
    };
  }

  outOpts() {
    const c = this.cfg, j = this.job;
    return { post: c.post, units: j.units, safeZ: c.safeZ, clearZ: Math.min(1, c.safeZ), rapidRate: c.rapidRate, spindle: c.spindle, spinUp: c.spinUp, coolant: c.coolant, park: c.park, zOffset: j.zZero === 'bed' ? j.t : 0 };
  }

  // ---------------------------------------------------------------- side panel
  /** Redrawn a moment later, so a field that has just been tabbed into keeps the keyboard focus. */
  _renderLayers() {
    if (this._sideTimer) return;
    this._sideTimer = setTimeout(() => {
      this._sideTimer = null;
      if (!this.active) return;
      // a button that is being pressed must still be there when the mouse comes up, or its click is lost
      if (this._sideDown) { this._sidePending = true; return; }
      const act = document.activeElement;
      const key = act && this.side.contains(act) && act.dataset ? act.dataset.key : null;
      const typed = key && act.dataset.dirty ? act.value : null;
      const scroll = this.side.scrollTop;
      this._renderJob(); this._renderToolpaths(); this._renderOutput();
      this.side.scrollTop = scroll;
      if (!key) return;
      const el = this.side.querySelector(`[data-key="${key}"]`);
      if (!el) return;
      el.focus();
      if (typed == null) { if (el.select) el.select(); return; }
      // text typed but not yet entered survives the redraw, and still counts when the field is left
      el.value = typed;
      el.dataset.dirty = '1';
      el.addEventListener('blur', () => { if (el.dataset.dirty) el.dispatchEvent(new Event('change')); }, { once: true });
    }, 0);
  }

  _renderJob() {
    const p = clear(this.jobPanel), j = this.job, u = this.u;
    const set = (k) => (v) => {
      if (k === 'h') {
        // keep the drawing where it is relative to the front edge
        const dy = v - j.h;
        for (const s of this.doc.shapes) s.m = mul(translate(0, dy), s.m);
      }
      j[k] = v; this._syncMachine(); this.commit(); if (k === 'w' || k === 'h') this.zoomToBed();
    };
    const len = { unit: u.name, k: u.k, dp: u.dp, step: u.step };
    const zero = h('div', { class: 'cnc-zero', title: 'Where X0 Y0 is on the material. Put the bit there on the machine and press Zero before cutting.' });
    for (const id of ['tl', '', 'tr', '', 'c', '', 'bl', '', 'br']) {
      if (!id) { zero.append(h('span')); continue; }
      const b = h('button', { type: 'button', class: j.xyZero === id ? 'on' : '', title: ZERO_NAMES[id], 'aria-label': 'XY zero: ' + ZERO_NAMES[id] });
      b.addEventListener('click', () => { j.xyZero = id; this.commit(); });
      zero.append(b);
    }
    p.append(
      numRow('Width (X)', j.w, set('w'), { ...len, min: 5, max: 5000, key: 'job-w' }),
      numRow('Height (Y)', j.h, set('h'), { ...len, min: 5, max: 5000, key: 'job-h' }),
      numRow('Thickness', j.t, set('t'), { ...len, min: 0.1, max: 500, key: 'job-t', step: u.inch ? 0.01 : 0.1 }),
      selectRow('Material', j.material, Object.entries(MATERIALS).map(([k, m]) => [k, m.name]), (v) => { j.material = v; this.commit(); }, { title: 'Used to suggest safe speeds and depths for each bit' }),
      h('div', { class: 'le-row cnc-zero-row' }, h('span', {}, 'XY zero'), zero, h('em', {}, ZERO_NAMES[j.xyZero])),
      selectRow('Z zero', j.zZero, [['top', 'Top of the material'], ['bed', 'Machine bed (under the material)']], (v) => { j.zZero = v; this.commit(); }, { title: 'Where you will touch the bit off before cutting' }),
      selectRow('Units', j.units, [['mm', 'Millimetres'], ['in', 'Inches']], (v) => { j.units = v; this.commit(); }));
  }

  _renderToolpaths() {
    const p = clear(this.tpPanel), u = this.u;
    const n = this.sel.length;
    const add = h('div', { class: 'cnc-add' });
    for (const [type, label, tip] of TOOLPATH_TYPES) {
      const b = h('button', { class: 'cnc-add-btn', type: 'button', title: tip }, icon(TYPE_ICON[type] || 'cube', 20), h('span', {}, label));
      b.dataset.tp = type;
      b.addEventListener('click', () => this.addToolpath(type));
      add.append(b);
    }
    p.append(h('div', { class: 'insp-note' }, n ? `Choose what to do with the ${n} selected shape${n === 1 ? '' : 's'}:` : 'Select one or more shapes in the drawing, then choose what to do with them:'), add);
    const list = h('div', { class: 'cnc-tp-list' });
    this.doc.toolpaths.forEach((tp, i) => {
      const c = this.computed.get(tp.id), res = this.resolve(tp);
      const on = h('input', { type: 'checkbox', checked: tp.enabled, title: 'Include this toolpath when cutting' });
      on.addEventListener('click', (e) => e.stopPropagation());
      on.addEventListener('change', () => { tp.enabled = on.checked; this.commit(); });
      const mini = (ic, title, fn) => { const b = h('button', { class: 'mini', type: 'button', title }, icon(ic, 13)); b.addEventListener('click', (e) => { e.stopPropagation(); fn(); }); return b; };
      const warn = c && c.warnings.length;
      const depth = tp.type === 'vcarve' ? (tp.flatDepth > 0 ? `flat at ${u.show(tp.flatDepth)}` : 'V depth') : tp.type === 'chamfer' ? `${u.show(tp.width)} wide` : `${u.show(res.depth)} deep`;
      const row = h('div', { class: 'cnc-tp-row' + (tp.id === this.tpSel ? ' on' : '') + (tp.enabled ? '' : ' off'), title: warn ? c.warnings.join('\n') : 'Click to edit. The shapes it cuts are highlighted in the drawing.' },
        on, h('span', { class: 'cnc-tp-dot', style: { background: TP_COLORS[i % TP_COLORS.length] } }),
        h('span', { class: 'cnc-tp-name' }, tp.name || typeName(tp.type), h('small', {}, `${toolLabel(tp.tool, this.job.units)} · ${depth}${tp.shapes.length ? '' : ' · no shapes'}`)),
        warn ? h('span', { class: 'cnc-warn', title: c.warnings.join('\n') }, '!') : null,
        mini('arrowUp', 'Cut earlier', () => this.moveToolpath(tp.id, -1)), mini('arrowDown', 'Cut later', () => this.moveToolpath(tp.id, 1)), mini('trash', 'Delete this toolpath', () => this.removeToolpath(tp.id)));
      row.addEventListener('click', () => { this.tpSel = this.tpSel === tp.id ? null : tp.id; if (this.tpSel) { const index = this._index(); this.sel = [...new Set(tp.shapes.map((id) => (index.get(id) || {}).top).filter(Boolean))]; } this.refresh(); });
      list.append(row);
    });
    if (this.doc.toolpaths.length) p.append(list);
    const tp = this.doc.toolpaths.find((t) => t.id === this.tpSel);
    if (tp) p.append(this._toolpathEditor(tp));
  }

  _toolpathEditor(tp) {
    const u = this.u, j = this.job, res = this.resolve(tp), c = this.computed.get(tp.id);
    const ed = h('div', { class: 'cnc-tp-editor' });
    const upd = (fn) => (v) => { fn(v); this.commit(); };
    const len = (label, key, o = {}) => numRow(label, o.value ?? tp[key] ?? 0, upd((v) => { tp[key] = v; }), { unit: u.name, k: u.k, dp: u.dp, step: u.inch ? 0.005 : 0.1, min: 0, max: 1000, key: tp.id + key, ...o });
    const bitSel = (label, cur, kinds, onPick, allowNone) => {
      const list = this.bits().filter((b) => !kinds || kinds.includes(b.type));
      const known = cur && list.some((b) => toolKey(b) === toolKey(cur));
      const sel = h('select', { class: 'select' }, allowNone ? h('option', { value: '' }, 'The V-bit itself (slow)') : null,
        cur && !known ? h('option', { value: 'cur' }, toolLabel(cur, j.units)) : null, list.map((b, i) => h('option', { value: i }, toolLabel(b, j.units))));
      sel.value = !cur ? '' : known ? String(list.findIndex((b) => toolKey(b) === toolKey(cur))) : 'cur';
      sel.dataset.key = tp.id + label;
      sel.addEventListener('change', () => { if (sel.value !== 'cur') { onPick(sel.value === '' ? null : deep(list[+sel.value])); this.commit(); } });
      return h('label', { class: 'le-row' }, h('span', {}, label), sel, button({ icon: 'settings', cls: 'btn-ghost', title: 'Add or change bits', onClick: () => dialogs.settingsDialog(this, 'bits') }));
    };
    const kinds = { vcarve: ['vbit'], chamfer: ['vbit'], drill: ['drill', 'end'], relief: ['ball', 'end', 'vbit'] }[tp.type] || null;
    ed.append(h('div', { class: 'le-title' }, icon(TYPE_ICON[tp.type] || 'cube', 18), typeName(tp.type) + ' settings'),
      textRow('Name', tp.name, upd((v) => { tp.name = v.trim().slice(0, 40); }), { placeholder: typeName(tp.type), key: tp.id + 'name' }),
      bitSel('Bit', tp.tool, kinds, (b) => { tp.tool = b; }));

    const sideRow = (opts) => selectRow('Cut', tp.side, opts, upd((v) => { tp.side = v; }));
    const depthRow = () => {
      if (!('through' in tp)) return len('Depth', 'depth', { min: 0.01 });
      const cb = h('input', { type: 'checkbox', checked: !!tp.through, title: 'Cut all the way through the material' });
      cb.addEventListener('change', () => { tp.through = cb.checked; if (!cb.checked) tp.depth = j.t; this.commit(); });
      return h('div', {}, tp.through ? h('div', { class: 'le-row' }, h('span', {}, 'Depth'), h('em', {}, `${u.show(res.depth)} ${u.name} (through)`)) : len('Depth', 'depth', { min: 0.01 }),
        h('label', { class: 'check' }, cb, 'Cut all the way through'));
    };
    switch (tp.type) {
      case 'profile':
        ed.append(sideRow([['outside', 'Outside the line (free a part)'], ['inside', 'Inside the line (make a hole)'], ['on', 'On the line']]), depthRow());
        {
          const t = tp.tabs || (tp.tabs = { count: 0, width: 6, height: 2 });
          ed.append(numRow('Tabs per shape', t.count, upd((v) => { t.count = Math.round(v); }), { min: 0, max: 40, step: 1, key: tp.id + 'tabs', title: 'Small bridges left at the bottom of the cut so the part cannot come loose. 0 for none.' }));
          if (t.count > 0) ed.append(numRow('Tab width', t.width, upd((v) => { t.width = v; }), { unit: u.name, k: u.k, dp: u.dp, min: 0.5, max: 100, key: tp.id + 'tabw' }),
            numRow('Tab height', t.height, upd((v) => { t.height = v; }), { unit: u.name, k: u.k, dp: u.dp, min: 0.1, max: 100, key: tp.id + 'tabh' }));
        }
        if (tp.side !== 'on') ed.append(checkRow('Dog-bone corners', tp.dogbone, upd((v) => { tp.dogbone = v; }), 'Lets the round bit reach into inside corners, so square parts fit into the holes'));
        break;
      case 'pocket':
        ed.append(depthRow(), selectRow('Pattern', tp.strategy, [['offset', 'Follow the shape (from the middle out)'], ['raster', 'Back and forth']], upd((v) => { tp.strategy = v; })));
        if (tp.strategy === 'raster') ed.append(numRow('Angle', tp.angle || 0, upd((v) => { tp.angle = v; }), { unit: '°', min: -180, max: 180, step: 15, key: tp.id + 'ang' }));
        ed.append(checkRow('Dog-bone corners', tp.dogbone, upd((v) => { tp.dogbone = v; }), 'Lets the round bit reach into the corners, so square parts fit into the pocket'));
        break;
      case 'vcarve': {
        ed.append(len('Flat depth', 'flatDepth', { title: 'Leave 0 for a classic V-carve. Set a depth to give wide areas a flat bottom instead of a deep groove.' }));
        if (tp.flatDepth > 0) ed.append(bitSel('Clear flat with', tp.clearTool, ['end'], (b) => { tp.clearTool = b; }, true));
        else ed.append(len('Depth limit', 'depth', { title: 'The deepest the bit may go. 0 for no limit.' }));
        break;
      }
      case 'engrave':
        ed.append(len('Depth', 'depth', { min: 0.01 }), len('Fade in and out', 'flute', { title: 'On open lines, rise to the surface over this distance at each end (a flute)' }));
        break;
      case 'drill':
        ed.append(depthRow(), len('Peck', 'peck', { title: 'Drill this deep, lift to clear the chips, then go on. 0 to drill in one go.' }));
        break;
      case 'chamfer':
        ed.append(sideRow([['outside', 'Outer edge of the shape'], ['inside', 'Edge of a hole']]), len('Chamfer width', 'width', { min: 0.05 }));
        break;
      case 'inlay':
        ed.append(selectRow('Part', tp.part, [['pocket', 'Pocket (the part it goes into)'], ['plug', 'Plug (the piece that goes in)']], upd((v) => { tp.part = v; })), len('Depth', 'depth', { min: 0.01 }));
        if (tp.part === 'plug') ed.append(len('Fit gap', 'gap', { step: u.inch ? 0.001 : 0.05, title: 'How much smaller the plug is all round, so it slides in' }));
        break;
      case 'texture':
        ed.append(len('Depth', 'depth', { min: 0.01 }), len('Scoop length', 'scoop', { min: 2 }), numRow('Variation', tp.variation, upd((v) => { tp.variation = v; }), { unit: '%', min: 0, max: 100, step: 5, key: tp.id + 'var' }),
          numRow('Angle', tp.angle || 0, upd((v) => { tp.angle = v; }), { unit: '°', min: -180, max: 180, step: 15, key: tp.id + 'ang' }));
        break;
      case 'relief':
        ed.append(selectRow('Pass', tp.mode, [['rough', 'Roughing (remove the bulk)'], ['finish', 'Finishing (fine detail)']], upd((v) => { tp.mode = v; })), len('Relief depth', 'depth', { min: 0.05 }),
          selectRow('Direction', String(tp.angle || 0), [['0', 'Along X'], ['90', 'Along Y']], upd((v) => { tp.angle = +v; })), checkRow('Dark is high', tp.invert, upd((v) => { tp.invert = v; })));
        if (tp.mode === 'rough') ed.append(len('Leave for finishing', 'allowance'));
        break;
      default: ed.append(len('Depth', 'depth'));
    }

    // feeds and speeds
    const auto = h('input', { type: 'checkbox', checked: !!tp.auto });
    auto.addEventListener('change', () => { tp.auto = auto.checked; if (!tp.auto) for (const k of ['feed', 'plunge', 'rpm', 'passDepth', 'stepover']) tp[k] = res[k]; this.commit(); });
    ed.append(h('div', { class: 'le-sub' }, 'Speeds and depth per pass'),
      h('label', { class: 'check', title: 'Suggested from the material and the bit. A sensible place to start; turn it off to set your own.' }, auto, `Automatic for ${(MATERIALS[j.material] || MATERIALS.softwood).name}`));
    const feed = (label, key) => numRow(label, res[key], upd((v) => { tp[key] = v; }), { unit: u.feedName, k: u.k, dp: u.inch ? 1 : 0, min: 1, max: 100000, step: u.inch ? 1 : 50, disabled: !!tp.auto, key: tp.id + key });
    ed.append(feed('Feed rate', 'feed'), feed('Plunge rate', 'plunge'),
      numRow('Spindle speed', res.rpm, upd((v) => { tp.rpm = v; }), { unit: 'RPM', min: 0, max: 100000, step: 500, dp: 0, disabled: !!tp.auto, key: tp.id + 'rpm' }));
    if (!['chamfer', 'drill'].includes(tp.type)) ed.append(numRow('Depth per pass', res.passDepth, upd((v) => { tp.passDepth = v; }), { unit: u.name, k: u.k, dp: u.dp, min: 0.02, max: 200, step: u.inch ? 0.005 : 0.1, disabled: !!tp.auto, key: tp.id + 'pd' }));
    if (['pocket', 'inlay', 'texture', 'relief'].includes(tp.type)) ed.append(numRow(tp.type === 'texture' ? 'Line spacing' : 'Stepover', res.stepover, upd((v) => { tp.stepover = v; }), { unit: u.name, k: u.k, dp: u.dp, min: 0.02, max: 200, step: u.inch ? 0.005 : 0.1, disabled: !!tp.auto, key: tp.id + 'so' }));

    // less common settings
    const more = h('div', {});
    if (['profile', 'pocket', 'inlay', 'chamfer'].includes(tp.type)) more.append(selectRow('Direction', tp.direction || 'climb', [['climb', 'Climb (cleaner on most machines)'], ['conventional', 'Conventional']], upd((v) => { tp.direction = v; })));
    if (['profile', 'pocket', 'inlay'].includes(tp.type)) more.append(len('Ramp in over', 'ramp', { title: 'Slide down into the cut over this distance instead of plunging straight down. Easier on the bit. 0 to plunge.' }),
      len('Finish pass', 'finishAllowance', { step: u.inch ? 0.001 : 0.05, title: 'Leave this much on the walls, then take it off in one clean final pass. 0 for none.' }));
    if (['profile', 'pocket', 'engrave', 'drill', 'inlay'].includes(tp.type)) more.append(len('Start depth', 'startDepth', { title: 'Start cutting from this far below the surface (for example the floor of an earlier pocket)' }));
    if (more.children.length) { const det = h('details', { class: 'cnc-more', open: !!this._moreOpen }, h('summary', {}, 'More options'), more); det.addEventListener('toggle', () => { this._moreOpen = det.open; }); ed.append(det); }

    ed.append(h('div', { class: 'lz-row' },
      button({ label: 'Use selected shapes', cls: 'btn-outline', title: 'Make this toolpath cut the shapes that are selected in the drawing now', onClick: () => { const ids = this.selected().map((s) => s.id); if (!ids.length) return toast('Select some shapes in the drawing first', 'warn'); tp.shapes = ids; this.commit(); } }),
      button({ label: 'Duplicate', cls: 'btn-outline', onClick: () => { const cp = { ...deep(tp), id: 'tp' + Date.now().toString(36) + tpSeq++, name: (tp.name || typeName(tp.type)) + ' copy' }; this.doc.toolpaths.push(cp); this.tpSel = cp.id; this.commit(); } })));
    if (c && c.warnings.length) for (const w of c.warnings) ed.append(h('div', { class: 'cnc-note-warn' }, w));
    if (c && c.stats) ed.append(h('div', { class: 'insp-note' }, `About ${formatTime(c.stats.time)} · ${u.inch ? (c.stats.cut / 25.4 / 12).toFixed(1) + ' ft' : (c.stats.cut / 1000).toFixed(2) + ' m'} of cutting`));
    return ed;
  }

  _renderOutput() {
    const p = clear(this.outPanel), u = this.u;
    let time = 0;
    const bits = [], warns = [];
    for (const tp of this.doc.toolpaths) {
      const c = this.computed.get(tp.id);
      if (!tp.enabled || !c) continue;
      if (c.stats) time += c.stats.time;
      for (const s of c.sections) { const lbl = toolLabel(s.tool, this.job.units); if (!bits.includes(lbl)) bits.push(lbl); }
      warns.push(...c.warnings);
    }
    const any = this.doc.toolpaths.some((t) => t.enabled && (this.computed.get(t.id) || {}).sections?.length);
    this.summary = h('div', { class: 'insp-note' }, any ? `About ${formatTime(time)} · ${bits.length} bit${bits.length === 1 ? '' : 's'}: ${bits.join(', ')}${warns.length ? ` · ${warns.length} thing${warns.length === 1 ? '' : 's'} to check` : ''}`
      : 'Add a toolpath above to see the result here.');
    p.append(this.summary,
      h('div', { class: 'lz-row' },
        button({ label: '3D preview', icon: 'cube', cls: 'btn-primary', title: 'See what the finished piece will look like (Alt+P)', onClick: () => this.openPreview() }),
        button({ label: 'Save G-code', icon: 'export', cls: 'btn-outline', title: `Save a file for ${POSTS[this.cfg.post].name}`, onClick: () => this.saveGcode() })),
      h('div', { class: 'lz-row' }, button({ label: 'Send to machine', icon: 'cncMachine', cls: 'btn-outline', title: 'Load this job in the Machine tab, ready to run', onClick: () => this.sendToMachine() })));
    void u;
  }

  _renderStatus() {
    const n = this.doc.shapes.length, j = this.job, u = this.u, t = this.doc.toolpaths.length;
    this.statusBar.textContent = `${n} object${n === 1 ? '' : 's'} · ${t} toolpath${t === 1 ? '' : 's'} · material ${u.show(j.w)} × ${u.show(j.h)} × ${u.show(j.t)} ${u.name} · snap ${this.machine.gridSnap ? u.show(this.machine.gridSnap) + ' ' + u.name : 'off'}`;
  }

  // ---------------------------------------------------------------- drawing
  _draw() {
    // a picture that has just finished loading may be the height map of a relief toolpath
    if (this.images.size !== this._imageCount) { this._imageCount = this.images.size; this._scheduleCompute(); }
    super._draw();
  }

  themeChanged() {
    if (this.preview) this.preview.view.setTheme();
    if (this.machinePanel.view) this.machinePanel.view.setTheme();
    this.redraw();
  }

  /** Files dropped on the window: G-code goes to the Machine tab, everything else into the drawing. */
  importData(files) {
    const isGcode = (f) => /\.(gcode|nc|gc|tap|ngc|cnc)$/i.test(f.name);
    const g = files.find(isGcode);
    if (g) { this.machinePanel.loadProgram({ name: g.name, text: new TextDecoder().decode(g.data) }); this.setMode('machine'); }
    const rest = files.filter((f) => !isGcode(f));
    return rest.length ? tools.importFiles(this, rest) : undefined;
  }

  _drawNodes(ctx, C) {
    this._drawToolpaths(ctx);
    super._drawNodes(ctx, C);
  }

  _drawToolpaths(ctx) {
    const v = this.view, [ox, oy] = this.zeroPoint(), d = this.dpr;
    ctx.save();
    ctx.setTransform(d * v.scale, 0, 0, -d * v.scale, d * (ox * v.scale + v.ox), d * (oy * v.scale + v.oy));
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    this.doc.toolpaths.forEach((tp, i) => {
      const c = this.computed.get(tp.id);
      if (!c || !tp.enabled) return;
      const color = TP_COLORS[i % TP_COLORS.length], on = tp.id === this.tpSel;
      for (const sec of c.draw) {
        // the swept width of the bit shows what will be removed
        if (sec.tool.type !== 'vbit') { ctx.globalAlpha = on ? 0.3 : 0.16; ctx.strokeStyle = color; ctx.lineWidth = sec.tool.dia; ctx.stroke(sec.p2); }
        ctx.globalAlpha = on ? 1 : 0.7; ctx.strokeStyle = color; ctx.lineWidth = (on ? 1.6 : 1) / v.scale; ctx.stroke(sec.p2);
      }
    });
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  _drawMachine(ctx) {
    // XY zero
    const z = this.toScreen(this.zeroPoint());
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#ef5350'; ctx.beginPath(); ctx.moveTo(z[0], z[1]); ctx.lineTo(z[0] + 26, z[1]); ctx.stroke();
    ctx.strokeStyle = '#66bb6a'; ctx.beginPath(); ctx.moveTo(z[0], z[1]); ctx.lineTo(z[0], z[1] - 26); ctx.stroke();
    ctx.fillStyle = '#ffffff'; ctx.strokeStyle = '#111'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(z[0], z[1], 4.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.font = '10px "Segoe UI", system-ui, sans-serif'; ctx.fillStyle = '#ef5350'; ctx.fillText('X', z[0] + 29, z[1] + 3); ctx.fillStyle = '#66bb6a'; ctx.fillText('Y', z[0] - 3, z[1] - 30);
    const st = this.device.status;
    if (this.device.connected && st.known) {
      const p = this.toScreen(this.fromJob(st.wpos));
      ctx.strokeStyle = '#ff9f43'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(p[0] - 11, p[1]); ctx.lineTo(p[0] + 11, p[1]); ctx.moveTo(p[0], p[1] - 11); ctx.lineTo(p[0], p[1] + 11); ctx.stroke();
      ctx.beginPath(); ctx.arc(p[0], p[1], 6, 0, Math.PI * 2); ctx.stroke();
    }
  }

  // ---------------------------------------------------------------- 3D preview
  openPreview() {
    const prog = this.program();
    if (!prog.sections.length) return toast('Add a toolpath first: select a shape, then pick Cut out, Pocket, V-carve…', 'warn', 4500);
    if (!this.preview) {
      const bar = h('div', { class: 'cnc-preview-bar' });
      const host = h('div', { class: 'cnc-preview-view' });
      this.previewEl.append(bar, host);
      this.previewEl.classList.add('open');
      const view = new PathView3D(host, { antialias: this.app.settings.antialias !== false });
      const slider = h('input', { type: 'range', min: 0, max: 1000, value: 1000, class: 'cnc-scrub', title: 'Drag to step through the job' });
      const info = h('span', { class: 'cnc-preview-info' });
      const paths = h('input', { type: 'checkbox', checked: true });
      paths.addEventListener('change', () => view.setPathVisible(paths.checked));
      slider.addEventListener('input', () => this._scrub(+slider.value / 1000));
      bar.append(button({ label: 'Back to drawing', icon: 'arrowLeft', cls: 'btn-outline', onClick: () => this.closePreview() }),
        button({ icon: 'play', title: 'Play the job from the start', onClick: () => this._play() }), slider, info,
        h('label', { class: 'check' }, paths, 'Show cutter path'),
        button({ label: 'Top', cls: 'btn-ghost', onClick: () => view.view('top') }), button({ label: '3D', cls: 'btn-ghost', onClick: () => view.view('iso') }));
      this.preview = { open: false, view, slider, info };
    }
    this.previewEl.classList.add('open');
    this.preview.open = true;
    this.preview.view.resize();
    this._startPreview(true);
  }

  closePreview() {
    if (!this.preview) return;
    this.preview.open = false;
    cancelAnimationFrame(this.preview.raf);
    this.previewEl.classList.remove('open');
    this.redraw();
  }

  _startPreview(resetView = false) {
    const pv = this.preview, prog = this.program(), opts = this.outOpts();
    cancelAnimationFrame(pv.raf);
    pv.sections = prog.sections;
    pv.events = expandMoves(prog, opts);
    pv.moves = pv.events.filter((e) => e.t === 'move');
    const stats = measure(pv.events, opts), u = this.u;
    pv.info.textContent = `About ${formatTime(stats.time)} · ${u.inch ? (stats.cut / 25.4 / 12).toFixed(1) + ' ft' : (stats.cut / 1000).toFixed(1) + ' m'} of cutting · deepest ${u.show(-stats.deepest)} ${u.name}`;
    const stock = this.stock();
    pv.view.setStock(stock, false);
    pv.view.setPath(pv.moves);
    pv.sim = new Simulator(stock, this.app.settings.smoke ? 160 : 420);
    if (resetView) pv.view.view('iso');
    pv.slider.value = 1000;
    this._animate(pv.events.length, 30);
  }

  /** Carve up to an event index, a slice per frame so the window stays responsive. */
  _animate(target, frames) {
    const pv = this.preview;
    cancelAnimationFrame(pv.raf);
    const per = Math.max(400, Math.ceil(pv.events.length / frames));
    const step = () => {
      pv.sim.run(pv.events, pv.sections, Math.min(target, pv.sim.done + per));
      pv.view.setSurface(pv.sim);
      let last = null;
      for (let i = pv.sim.done - 1; i >= 0 && !last; i--) { const e = pv.events[i]; if (e.t === 'move' && e.x != null) last = e; }
      const sec = last ? pv.sections[last.s] : null;
      pv.view.setTool(pv.sim.done < pv.events.length && last ? [last.x, last.y, last.z] : null, sec && sec.tool);
      if (pv.sim.done < target && pv.open) pv.raf = requestAnimationFrame(step);
    };
    step();
  }
  _play() { const pv = this.preview; pv.sim.reset(); pv.slider.value = 1000; this._animate(pv.events.length, 240); }
  _scrub(f) {
    const pv = this.preview, target = Math.round(pv.events.length * f);
    cancelAnimationFrame(pv.raf);
    if (target < pv.sim.done) pv.sim.reset();
    this._animate(target, 1);
  }

  // ---------------------------------------------------------------- output
  /** { text, stats, ... } for the whole job, or null (with a message) when there is nothing to cut. */
  gcode(silent = false) {
    const prog = this.program();
    if (!prog.sections.length) { if (!silent) toast('There is nothing to cut yet. Select a shape and add a toolpath.', 'warn', 4500); return null; }
    return { ...buildGcode(prog, this.outOpts()), program: prog };
  }

  async saveGcode() {
    const out = this.gcode();
    if (!out) return;
    for (const w of out.program.warnings.slice(0, 4)) toast(w, 'warn', 6000);
    const post = POSTS[this.cfg.post], base = this.app._fileBase();
    const filters = [{ name: 'G-code', extensions: [post.ext, 'gcode', 'nc', 'tap', 'ngc'].filter((v, i, a) => a.indexOf(v) === i) }];
    if (this.cfg.splitByTool && out.tools.length > 1) {
      // one file per bit, in cutting order, for machines where each bit change is a fresh start
      let n = 0;
      for (const t of out.tools) {
        const part = buildGcode({ ...out.program, sections: out.program.sections.filter((s) => toolKey(s.tool) === t.key) }, this.outOpts());
        n += 1;
        const path = await platform.saveDialog({ title: `Save G-code for ${toolLabel(t.tool, this.job.units)}`, defaultName: `${base} ${n} - ${toolLabel(t.tool, this.job.units).replace(/[\\/:*?"<>|]+/g, ' ')}.${post.ext}`, filters, data: part.text });
        if (!path) return;
      }
      return toast(`Saved ${n} G-code files, one for each bit`);
    }
    const path = await platform.saveDialog({ title: 'Save G-code', defaultName: `${base}.${post.ext}`, filters, data: out.text });
    if (path) toast('Saved G-code to ' + path);
  }

  sendToMachine() {
    const out = this.gcode();
    if (!out) return;
    for (const w of out.program.warnings.slice(0, 3)) toast(w, 'warn', 6000);
    this.machinePanel.loadProgram({ name: this.app.editor.doc.name || 'Job', text: out.text, stock: { ...this.stock(), zTop: this.job.zZero === 'bed' ? this.job.t : 0 }, fromDesign: true });
    this.setMode('machine');
  }

  // ---------------------------------------------------------------- menus and keys
  _contextMenu(e) {
    const raw = this.toBed(e), s = this.hit(raw);
    if (s && !this.sel.includes(s.id)) this.select([s.id]);
    const n = this.sel.length;
    popupMenu([
      ...TOOLPATH_TYPES.slice(0, 5).map(([type, label]) => ({ label: label + ' toolpath', icon: TYPE_ICON[type], disabled: !n, onClick: () => this.addToolpath(type) })), 'sep',
      { label: 'Copy', shortcut: 'Ctrl+C', disabled: !n, onClick: () => this.copy() }, { label: 'Cut', shortcut: 'Ctrl+X', disabled: !n, onClick: () => this.cut() },
      { label: 'Paste', shortcut: 'Ctrl+V', disabled: !this.clipboard, onClick: () => this.paste() }, { label: 'Duplicate', shortcut: 'Ctrl+D', disabled: !n, onClick: () => this.duplicate() },
      { label: 'Delete', shortcut: 'Del', disabled: !n, onClick: () => this.remove() }, 'sep',
      { label: 'Group', shortcut: 'Ctrl+G', disabled: n < 2, onClick: () => this.group() }, { label: 'Ungroup', shortcut: 'Ctrl+U', disabled: !this.selected().some((x) => x.type === 'group'), onClick: () => this.ungroup() },
      { label: 'Convert to path', disabled: !n, onClick: () => this.convertToPath() }, { label: 'Edit nodes', disabled: n !== 1, onClick: () => this.setTool('node') }, 'sep',
      { label: 'Lock / unlock', disabled: !n, onClick: () => this.toggleLock() },
      { label: 'Zoom to the material', onClick: () => this.zoomToBed() }, { label: 'Select all', shortcut: 'Ctrl+A', onClick: () => this.selectAll() },
    ], { x: e.clientX, y: e.clientY });
  }

  _key(e) {
    if (!this.active) return;
    const t = e.target;
    // Escape leaves the 3D preview even while its slider or checkbox has the keyboard
    if (e.key === 'Escape' && this.mode === 'design' && this.preview && this.preview.open && !document.querySelector('.modal-backdrop') && !document.querySelector('.menu')) { e.preventDefault(); this.closePreview(); return; }
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
    if (document.querySelector('.modal-backdrop') || this.app.dashboard.isOpen) return;
    if (this.mode === 'machine') return this.machinePanel.key(e);
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const done = () => { e.preventDefault(); e.stopPropagation(); };
    if (this.preview && this.preview.open) { if (k === 'Escape') { done(); this.closePreview(); } return; }
    if (e.altKey && k === 'p') { done(); this.openPreview(); return; }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && k === 's') { done(); this.saveGcode(); return; }
    super._key(e);
  }
}
