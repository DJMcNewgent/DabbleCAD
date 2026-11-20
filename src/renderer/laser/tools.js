// Laser workspace dialogs and generators.
import qrcode from 'qrcode-generator';
import { h, modal, button, toast, confirmDialog } from '../ui/dom.js';
import { platform } from '../platform.js';
import { listFontNames, ensureFont } from '../core/fonts.js';
import { exportModel } from '../core/io.js';
import { traceMask } from '../core/trace.js';
import {
  LAYER_COLORS, flatten, boundsOf, mul, translate, rotation, about, cloneShape, layerOf, defaultLayer,
  makeRect, makeText, makeImage, makeGroup, pathFromPolys,
} from './model.js';
import { booleanOp, offsetPolys, maskFromImage, IMAGE_MODES } from './ops.js';
import { importSVG, importDXF, importLBRN, exportSVG, exportDXF } from './io.js';
import { toMachine, FLAVORS, formatTime, machineOf, rotaryScale } from './gcode.js';

export { IMAGE_MODES };

const numInput = (value, step = 1, min, max) => { const i = h('input', { class: 'input', type: 'number', value, step }); if (min != null) i.min = min; if (max != null) i.max = max; return i; };
const field = (label, control) => h('label', { class: 'field' }, h('span', {}, label), control);
const val = (input, def = 0) => { const v = parseFloat(input.value); return isFinite(v) ? v : def; };
const actions = (m, okLabel, onOk) => h('div', { class: 'modal-actions' }, button({ label: 'Cancel', cls: 'btn-outline', onClick: () => m.close() }), button({ label: okLabel, cls: 'btn-primary', onClick: onOk }));
const quiet = (m) => m.body.addEventListener('keydown', (e) => { if (e.key !== 'Escape') e.stopPropagation(); });

// ---------------------------------------------------------------- import / export
function loadImage(src) {
  return new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = () => reject(new Error('The image could not be read')); img.src = src; });
}

function bufferToDataUrl(buffer, mime) {
  const bytes = new Uint8Array(buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return `data:${mime};base64,${btoa(bin)}`;
}

function placeNew(ws, shapes) {
  const b = boundsOf(shapes);
  if (!b) return;
  const m = ws.machine;
  let k = 1;
  if (b.w > m.bedW || b.h > m.bedH) k = Math.min(m.bedW / b.w, m.bedH / b.h) * 0.9;
  const fit = mul(translate(m.bedW / 2 - b.cx * k, m.bedH / 2 - b.cy * k), [k, 0, 0, k, 0, 0]);
  for (const s of shapes) s.m = mul(fit, s.m);
  if (k !== 1) toast(`Scaled to ${Math.round(k * 100)}% to fit the work area`, 'warn', 4000);
}

export async function importFiles(ws, files) {
  const added = [];
  for (const f of files) {
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    try {
      if (ext === 'svg') { const shapes = importSVG(new TextDecoder().decode(f.data)); if (!shapes.length) throw new Error('no shapes found'); const g = shapes.length > 1 ? [makeGroup(shapes)] : shapes; placeNew(ws, g); added.push(...g); }
      else if (ext === 'dxf') { const shapes = importDXF(new TextDecoder().decode(f.data)); if (!shapes.length) throw new Error('no supported entities found'); const g = shapes.length > 1 ? [makeGroup(shapes)] : shapes; placeNew(ws, g); added.push(...g); }
      else if (ext === 'lbrn' || ext === 'lbrn2') {
        const res = importLBRN(new TextDecoder().decode(f.data), ws.machine);
        if (!res.shapes.length) throw new Error('no shapes found');
        // bring the project's layer settings along with its shapes
        for (const [index, set] of Object.entries(res.layers)) Object.assign(layerOf(ws.doc, +index), set);
        added.push(...res.shapes);
        for (const note of res.notes) toast(note, 'info', 6000);
      }
      else if (['png', 'jpg', 'jpeg', 'bmp', 'gif', 'webp'].includes(ext)) {
        const src = bufferToDataUrl(f.data, ext === 'jpg' ? 'image/jpeg' : 'image/' + ext);
        const img = await loadImage(src);
        const w = (img.naturalWidth * 25.4) / 96, hgt = (img.naturalHeight * 25.4) / 96;
        const s = makeImage(ws.doc.currentLayer, 0, 0, w, hgt, src, img.naturalWidth, img.naturalHeight);
        ws.images.set(s.id, img);
        placeNew(ws, [s]);
        added.push(s);
      } else throw new Error('unsupported file type');
    } catch (err) { toast(`Could not import ${f.name}: ${err.message || err}`, 'warn', 5000); }
  }
  if (added.length) { ws.add(added); ws.setTool('select'); }
}

export async function exportVector(ws, kind) {
  if (!ws.doc.shapes.length) return toast('There is nothing to export yet');
  const data = kind === 'svg' ? exportSVG(ws.doc, ws.machine) : exportDXF(ws.doc, ws.machine);
  const path = await platform.saveDialog({ title: 'Export ' + kind.toUpperCase(), defaultName: `${ws.app._fileBase()}.${kind}`, filters: [{ name: kind.toUpperCase(), extensions: [kind] }], data });
  if (path) toast('Exported to ' + path);
}

/** Bring the 3D design's workplane outline into the laser workspace. */
export async function from3D(ws) {
  try {
    const out = await exportModel(ws.app.editor, 'svg', {});
    const shapes = importSVG(out.data);
    if (!shapes.length) throw new Error('The 3D design has no outline on the workplane');
    for (const s of shapes) { s.layer = ws.doc.currentLayer; for (const sub of s.subs) if (sub.nodes.length > 2) sub.closed = true; }
    const g = shapes.length > 1 ? [makeGroup(shapes)] : shapes;
    placeNew(ws, g);
    ws.add(g);
    toast('Added the outline of the 3D design');
  } catch (err) { toast(err.message || String(err), 'warn', 5000); }
}

// ---------------------------------------------------------------- modify
function vectorPolys(s) { return flatten(s).filter((p) => p.shape.type !== 'image'); }

export function boolean(ws, op) {
  const shapes = ws.movable().filter((s) => s.type !== 'image' && vectorPolys(s).some((p) => p.closed && p.pts.length > 2));
  if (shapes.length < 2) return toast('Select two or more closed shapes');
  const result = booleanOp(shapes.map(vectorPolys), op);
  if (!result.length) return toast('The result is empty', 'warn');
  const ids = new Set(shapes.map((s) => s.id));
  const out = pathFromPolys(shapes[0].layer, result);
  const at = ws.doc.shapes.findIndex((s) => ids.has(s.id));
  ws.doc.shapes = ws.doc.shapes.filter((s) => !ids.has(s.id));
  ws.doc.shapes.splice(Math.min(at, ws.doc.shapes.length), 0, out);
  ws.sel = [out.id];
  ws.commit();
}

export function offsetDialog(ws) {
  const shapes = ws.selected().filter((s) => s.type !== 'image');
  if (!shapes.length) return toast('Select one or more shapes to offset');
  const m = modal({ title: 'Offset shapes', width: 400 });
  quiet(m);
  const dist = numInput(2, 0.1, 0.01), dir = h('select', { class: 'select' }, h('option', { value: 'out' }, 'Outward'), h('option', { value: 'in' }, 'Inward'), h('option', { value: 'both' }, 'Both'));
  const style = h('select', { class: 'select' }, h('option', { value: 'round' }, 'Round'), h('option', { value: 'miter' }, 'Corner'), h('option', { value: 'bevel' }, 'Bevel'));
  const del = h('input', { type: 'checkbox' });
  m.body.append(field('Offset distance (mm)', dist), field('Direction', dir), field('Corner style', style), h('label', { class: 'check' }, del, 'Delete original objects'),
    actions(m, 'Offset', () => {
      const d = Math.abs(val(dist, 1)), groups = shapes.map(vectorPolys), made = [];
      // merge overlapping shapes first so the result is their combined outline, not an even-odd XOR
      const closed = groups.length > 1 ? booleanOp(groups, 'union') : groups[0].filter((p) => p.closed);
      const polys = [...closed, ...groups.flat().filter((p) => !p.closed)];
      for (const sign of dir.value === 'both' ? [1, -1] : [dir.value === 'in' ? -1 : 1]) {
        const res = offsetPolys(polys, sign * d, style.value);
        if (res.length) made.push(pathFromPolys(ws.doc.currentLayer, res));
      }
      if (!made.length) { toast('The offset result is empty', 'warn'); return; }
      if (del.checked) { const ids = new Set(shapes.map((s) => s.id)); ws.doc.shapes = ws.doc.shapes.filter((s) => !ids.has(s.id)); }
      m.close();
      ws.add(made);
    }));
}

export function gridArrayDialog(ws) {
  const shapes = ws.selected();
  const b = ws.selBounds();
  if (!b) return toast('Select something to repeat');
  const m = modal({ title: 'Grid array', width: 420 });
  quiet(m);
  const cols = numInput(3, 1, 1, 200), rows = numInput(2, 1, 1, 200), sx = numInput(2, 0.5), sy = numInput(2, 0.5);
  m.body.append(h('div', { class: 'row' }, field('Columns', cols), field('Rows', rows)), h('div', { class: 'row' }, field('Column spacing (mm)', sx), field('Row spacing (mm)', sy)),
    h('div', { class: 'insp-note' }, 'Spacing is the gap between copies.'),
    actions(m, 'Create array', () => {
      const nc = Math.max(1, Math.round(val(cols, 1))), nr = Math.max(1, Math.round(val(rows, 1)));
      if (nc * nr > 2500) { toast('That is too many copies', 'warn'); return; }
      const made = [];
      for (let r = 0; r < nr; r++) for (let c = 0; c < nc; c++) {
        if (!r && !c) continue;
        for (const s of shapes) { const k = cloneShape(s); k.locked = false; k.m = mul(translate(c * (b.w + val(sx)), r * (b.h + val(sy))), k.m); made.push(k); }
      }
      m.close();
      ws.doc.shapes.push(...made);
      ws.sel = [...shapes.map((s) => s.id), ...made.map((s) => s.id)];
      ws.commit();
    }));
}

export function circularArrayDialog(ws) {
  const shapes = ws.selected();
  const b = ws.selBounds();
  if (!b) return toast('Select something to repeat');
  const m = modal({ title: 'Circular array', width: 420 });
  quiet(m);
  const mc = ws.machine;
  const [dx, dy] = toMachine(mc, mc.bedW / 2, mc.bedH / 2);
  const count = numInput(8, 1, 2, 720), cx = numInput(dx, 1), cy = numInput(dy, 1), total = numInput(360, 5);
  const rot = h('input', { type: 'checkbox', checked: true });
  m.body.append(field('Number of copies (including the original)', count), h('div', { class: 'row' }, field('Centre X (mm)', cx), field('Centre Y (mm)', cy)), field('Total angle (degrees)', total),
    h('label', { class: 'check' }, rot, 'Rotate the copies'),
    actions(m, 'Create array', () => {
      const n = Math.max(2, Math.round(val(count, 2)));
      const px = mc.origin.endsWith('r') ? mc.bedW - val(cx) : val(cx), py = mc.origin.startsWith('b') ? mc.bedH - val(cy) : val(cy);
      const span = val(total, 360), full = Math.abs(span) >= 360;
      const made = [];
      for (let i = 1; i < n; i++) {
        const a = ((span * Math.PI) / 180) * (i / (full ? n : n - 1));
        for (const s of shapes) {
          const k = cloneShape(s); k.locked = false;
          if (rot.checked) k.m = mul(about(px, py, rotation(a)), k.m);
          else { const c = Math.cos(a), sn = Math.sin(a), ox = b.cx - px, oy = b.cy - py; k.m = mul(translate(px + ox * c - oy * sn - b.cx, py + ox * sn + oy * c - b.cy), k.m); }
          made.push(k);
        }
      }
      m.close();
      ws.doc.shapes.push(...made);
      ws.sel = [...shapes.map((s) => s.id), ...made.map((s) => s.id)];
      ws.commit();
    }));
}

export function traceDialog(ws) {
  const s = ws.selected().find((x) => x.type === 'image');
  if (!s) return toast('Select an image to trace');
  const img = ws.images.get(s.id);
  if (!img) return toast('The image is still loading');
  const m = modal({ title: 'Trace image', width: 560 });
  quiet(m);
  const maxSide = 700, k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(2, Math.round(img.naturalWidth * k)), hgt = Math.max(2, Math.round(img.naturalHeight * k));
  const src = document.createElement('canvas');
  src.width = w; src.height = hgt;
  const sctx = src.getContext('2d', { willReadFrequently: true });
  sctx.drawImage(img, 0, 0, w, hgt);
  const data = sctx.getImageData(0, 0, w, hgt);
  const view = h('canvas', { width: w, height: hgt, style: { maxWidth: '100%', border: '1px solid var(--border)', borderRadius: '8px', background: '#fff' } });
  const vctx = view.getContext('2d');
  const thr = h('input', { type: 'range', min: 1, max: 254, value: 128 }), smooth = h('input', { type: 'range', min: 0, max: 3, value: 1 });
  const neg = h('input', { type: 'checkbox' }), del = h('input', { type: 'checkbox' });
  let polys = [];
  const run = () => {
    const mask = maskFromImage(data, +thr.value, neg.checked);
    polys = traceMask(mask, w, hgt, { scale: 1, smooth: +smooth.value, epsilon: 0.8 });
    vctx.clearRect(0, 0, w, hgt);
    vctx.globalAlpha = 0.35; vctx.drawImage(src, 0, 0); vctx.globalAlpha = 1;
    vctx.strokeStyle = '#d0006f'; vctx.lineWidth = 1.2;
    vctx.beginPath();
    for (const p of polys) for (const ring of [p.outer, ...p.holes]) { ring.forEach((q, i) => { const y = hgt - q[1]; if (i) vctx.lineTo(q[0], y); else vctx.moveTo(q[0], y); }); vctx.closePath(); }
    vctx.stroke();
  };
  for (const c of [thr, smooth, neg]) c.addEventListener('input', run);
  run();
  m.body.append(view, h('div', { class: 'row', style: { marginTop: '10px' } }, field('Threshold', thr), field('Smoothness', smooth)),
    h('label', { class: 'check' }, neg, 'Trace the light areas instead'), h('label', { class: 'check' }, del, 'Delete the image after tracing'),
    actions(m, 'Trace', () => {
      if (!polys.length) { toast('Nothing was found at this threshold', 'warn'); return; }
      // traced points are in image pixels (y-up); map them through the image's local space
      const sx = s.w / w, sy = s.h / hgt;
      const rings = polys.flatMap((p) => [p.outer, ...p.holes]).map((ring) => ({ closed: true, pts: ring.map(([x, y]) => [x * sx, (hgt - y) * sy]) }));
      const path = pathFromPolys(ws.doc.currentLayer, rings);
      path.m = [...s.m];
      if (del.checked) ws.doc.shapes = ws.doc.shapes.filter((x) => x !== s);
      m.close();
      ws.add([path]);
    }));
}

// ---------------------------------------------------------------- create
export function textDialog(ws, existing, at) {
  const m = modal({ title: existing ? 'Edit text' : 'Add text', width: 460 });
  quiet(m);
  const ta = h('textarea', { class: 'input', style: { width: '100%', height: '90px', padding: '8px', resize: 'vertical' }, placeholder: 'Type your text…' });
  ta.value = existing ? existing.text : '';
  const font = h('select', { class: 'select' }, listFontNames().map((f) => h('option', { value: f }, f)));
  font.value = existing ? existing.font : ws.lastFont || 'Sans Bold';
  const size = numInput(existing ? existing.size : ws.lastTextSize || 10, 1, 0.5), spacing = numInput(existing ? existing.spacing || 0 : 0, 0.1);
  const align = h('select', { class: 'select' }, ['left', 'center', 'right'].map((a) => h('option', { value: a }, a)));
  align.value = existing ? existing.align : 'left';
  m.body.append(ta, h('div', { class: 'row', style: { marginTop: '10px' } }, field('Font', font), field('Height (mm)', size)), h('div', { class: 'row' }, field('Alignment', align), field('Letter spacing (mm)', spacing)),
    actions(m, existing ? 'Update' : 'Add text', async () => {
      const text = ta.value;
      if (!text.trim()) { toast('Type some text first'); return; }
      if (!(await ensureFont(font.value))) { toast('That font could not be loaded', 'warn'); return; }
      ws.lastFont = font.value; ws.lastTextSize = val(size, 10);
      m.close();
      if (existing) { Object.assign(existing, { text, font: font.value, size: Math.max(0.5, val(size, 10)), align: align.value, spacing: val(spacing) }); ws.commit(); }
      else { const s = makeText(ws.doc.currentLayer, at[0], at[1], text, font.value, Math.max(0.5, val(size, 10))); s.align = align.value; s.spacing = val(spacing); ws.tool = 'select'; ws.canvas.style.cursor = ''; ws.add([s]); }
    }));
  setTimeout(() => ta.focus(), 30);
}

/** How the planner orders cuts. */
export function cutOrderDialog(ws) {
  const m = modal({ title: 'Cut order', width: 420 });
  quiet(m);
  const o = ws.doc.optimize || (ws.doc.optimize = { byLayer: true, innerFirst: true, reduceTravel: true });
  const row = (key, label, hint) => {
    const cb = h('input', { type: 'checkbox', checked: o[key] !== false });
    cb.addEventListener('change', () => { o[key] = cb.checked; ws.commit(); });
    return h('label', { class: 'check', style: { alignItems: 'flex-start' } }, cb, h('span', {}, label, h('br'), h('small', { style: { opacity: 0.7 } }, hint)));
  };
  m.body.append(
    row('innerFirst', 'Cut inner shapes first', 'Holes are cut before the outline around them, so a part cannot shift before its holes are done.'),
    row('reduceTravel', 'Reduce travel moves', 'Start each cut at the point nearest to where the last one ended.'),
    row('byLayer', 'Finish one layer before the next', 'Layers run in the order shown in the Layers list.'),
    h('div', { class: 'modal-actions' }, button({ label: 'Close', cls: 'btn-primary', onClick: () => m.close() })));
  return m;
}

export function qrDialog(ws) {
  const m = modal({ title: 'QR code', width: 420 });
  quiet(m);
  const text = h('input', { class: 'input', type: 'text', value: 'https://', style: { width: '100%' } }), size = numInput(30, 1, 5);
  const level = h('select', { class: 'select' }, [['L', 'Low'], ['M', 'Medium'], ['Q', 'Quartile'], ['H', 'High']].map(([v, n]) => h('option', { value: v }, n)));
  level.value = 'M';
  m.body.append(field('Text or link', text), h('div', { class: 'row' }, field('Size (mm)', size), field('Error correction', level)),
    actions(m, 'Create', () => {
      let qr;
      try { qr = qrcode(0, level.value); qr.addData(text.value); qr.make(); } catch (err) { toast('That text is too long for a QR code', 'warn'); return; }
      const n = qr.getModuleCount(), cell = val(size, 30) / n;
      // merge horizontal runs of dark modules into rectangles, then weld them into clean outlines
      const groups = [];
      for (let r = 0; r < n; r++) {
        let c = 0;
        while (c < n) {
          if (!qr.isDark(r, c)) { c++; continue; }
          let e = c;
          while (e < n && qr.isDark(r, e)) e++;
          groups.push([{ closed: true, pts: [[c * cell, r * cell], [e * cell, r * cell], [e * cell, (r + 1) * cell], [c * cell, (r + 1) * cell]] }]);
          c = e;
        }
      }
      const L = ws.doc.currentLayer;
      const path = pathFromPolys(L, booleanOp(groups, 'union'));
      const mc = ws.machine;
      path.m = translate(mc.bedW / 2 - val(size, 30) / 2, mc.bedH / 2 - val(size, 30) / 2);
      if (layerOf(ws.doc, L).mode === 'line') toast('Tip: set this layer to Fill to engrave the QR code solid', 'info', 5000);
      m.close();
      ws.add([path]);
    }));
}

function freeLayers(ws, count) {
  const used = new Set();
  const visit = (list) => { for (const s of list) { if (s.children) visit(s.children); else used.add(s.layer); } };
  visit(ws.doc.shapes);
  const free = [];
  for (let i = 1; i < 30 && free.length < count; i++) if (!used.has(i)) free.push(i);
  return free;
}

export function materialTestDialog(ws) {
  const m = modal({ title: 'Material test', width: 520 });
  quiet(m);
  const rows = numInput(5, 1, 1, 10), cols = numInput(5, 1, 1, 12);
  const s0 = numInput(50, 5, 0.1), s1 = numInput(200, 5, 0.1), p0 = numInput(10, 1, 0, 100), p1 = numInput(80, 1, 0, 100);
  const size = numInput(8, 1, 2), gap = numInput(2, 0.5, 0), interval = numInput(0.1, 0.01, 0.02);
  const mode = h('select', { class: 'select' }, h('option', { value: 'fill' }, 'Fill'), h('option', { value: 'line' }, 'Line'));
  m.body.append(
    h('div', { class: 'row' }, field('Rows (speed steps)', rows), field('Columns (power steps)', cols)),
    h('div', { class: 'row' }, field('Min speed (mm/s)', s0), field('Max speed (mm/s)', s1)),
    h('div', { class: 'row' }, field('Min power (%)', p0), field('Max power (%)', p1)),
    h('div', { class: 'row' }, field('Square size (mm)', size), field('Gap (mm)', gap)),
    h('div', { class: 'row' }, field('Mode', mode), field('Line interval (mm)', interval)),
    h('div', { class: 'insp-note' }, 'Each row is a layer with its own speed. Columns step the power using each square\'s power scale. Labels go on a separate low-power layer.'),
    actions(m, 'Generate', () => {
      const nr = Math.max(1, Math.round(val(rows, 5))), nc = Math.max(1, Math.round(val(cols, 5)));
      const layers = freeLayers(ws, nr + 1);
      if (layers.length < nr + 1) { toast('Not enough unused layers for this test', 'warn'); return; }
      const sz = val(size, 8), g = val(gap, 2), pMax = Math.max(val(p0), val(p1)), pMin = Math.min(val(p0), val(p1));
      const labelLayer = layers[nr];
      Object.assign(layerOf(ws.doc, labelLayer), { ...defaultLayer(labelLayer), mode: 'fill', speed: 150, powerMax: Math.max(15, pMax / 3), interval: 0.1 });
      const shapes = [];
      const left = 22, top = 16;
      for (let r = 0; r < nr; r++) {
        const speed = nr === 1 ? val(s0) : val(s0) + ((val(s1) - val(s0)) * r) / (nr - 1);
        Object.assign(layerOf(ws.doc, layers[r]), { ...defaultLayer(layers[r]), mode: mode.value, speed, powerMax: pMax, interval: val(interval, 0.1) });
        for (let c = 0; c < nc; c++) {
          const power = nc === 1 ? pMax : pMin + ((pMax - pMin) * c) / (nc - 1);
          const sq = makeRect(layers[r], left + c * (sz + g), top + r * (sz + g), sz, sz);
          sq.powerScale = pMax > 0 ? Math.round((power / pMax) * 1000) / 10 : 100;
          shapes.push(sq);
          if (r === 0) shapes.push(makeText(labelLayer, left + c * (sz + g), top - 6, `${Math.round(power)}%`, 'Sans', 3));
        }
        shapes.push(makeText(labelLayer, 2, top + r * (sz + g) + sz / 2 - 1.5, `${Math.round(speed)} mm/s`, 'Sans', 3));
      }
      shapes.push(makeText(labelLayer, left, top + nr * (sz + g) + 2, `Power → / Speed ↓  ·  ${mode.value}`, 'Sans', 3));
      const group = makeGroup(shapes);
      const b = boundsOf([group]);
      group.m = translate(ws.machine.bedW / 2 - b.cx, ws.machine.bedH / 2 - b.cy);
      m.close();
      ws.add([group]);
    }));
}

export function intervalTestDialog(ws) {
  const m = modal({ title: 'Interval test', width: 460 });
  quiet(m);
  const count = numInput(6, 1, 2, 12), i0 = numInput(0.05, 0.01, 0.02), i1 = numInput(0.3, 0.01, 0.02), speed = numInput(100, 5, 0.1), power = numInput(30, 1, 0, 100), size = numInput(10, 1, 2);
  m.body.append(h('div', { class: 'row' }, field('Steps', count), field('Square size (mm)', size)), h('div', { class: 'row' }, field('Min interval (mm)', i0), field('Max interval (mm)', i1)),
    h('div', { class: 'row' }, field('Speed (mm/s)', speed), field('Power (%)', power)),
    h('div', { class: 'insp-note' }, 'Engraves a row of filled squares, each with a different line interval, so you can find the spacing that suits your lens and material.'),
    actions(m, 'Generate', () => {
      const n = Math.max(2, Math.round(val(count, 6)));
      const layers = freeLayers(ws, n + 1);
      if (layers.length < n + 1) { toast('Not enough unused layers for this test', 'warn'); return; }
      const sz = val(size, 10), shapes = [];
      Object.assign(layerOf(ws.doc, layers[n]), { ...defaultLayer(layers[n]), mode: 'fill', speed: 150, powerMax: Math.max(15, val(power) / 2), interval: 0.1 });
      for (let i = 0; i < n; i++) {
        const iv = val(i0) + ((val(i1) - val(i0)) * i) / (n - 1);
        Object.assign(layerOf(ws.doc, layers[i]), { ...defaultLayer(layers[i]), mode: 'fill', speed: val(speed, 100), powerMax: val(power, 30), interval: Math.max(0.02, +iv.toFixed(3)) });
        shapes.push(makeRect(layers[i], i * (sz + 3), 6, sz, sz), makeText(layers[n], i * (sz + 3), 0, iv.toFixed(2), 'Sans', 3));
      }
      const group = makeGroup(shapes);
      const b = boundsOf([group]);
      group.m = translate(ws.machine.bedW / 2 - b.cx, ws.machine.bedH / 2 - b.cy);
      m.close();
      ws.add([group]);
    }));
}

// ---------------------------------------------------------------- preview
export function previewDialog(ws) {
  let plan;
  try { plan = ws.plan(); } catch (err) { return toast(err.message || String(err), 'error'); }
  if (!plan.bounds) return toast('There is nothing to output. Check that layers have Output switched on.', 'warn');
  const m = modal({ title: 'Preview', width: 880, onClose: () => { playing = false; } });
  quiet(m);
  const W = 840, H = 500;
  const cv = h('canvas', { width: W * 2, height: H * 2, style: { width: W + 'px', height: H + 'px', maxWidth: '100%', background: '#fff', borderRadius: '8px', border: '1px solid var(--border)' } });
  const ctx = cv.getContext('2d');
  const moves = plan.moves.filter((mv) => mv.x != null);
  // cumulative time per move
  const times = [0];
  for (let i = 1; i < moves.length; i++) { const d = Math.hypot(moves[i].x - moves[i - 1].x, moves[i].y - moves[i - 1].y); times.push(times[i - 1] + d / ((moves[i].rapid ? ws.machine.rapid : moves[i].f) / 60)); }
  const total = times[times.length - 1] || 1;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const mv of moves) { x0 = Math.min(x0, mv.x); y0 = Math.min(y0, mv.y); x1 = Math.max(x1, mv.x); y1 = Math.max(y1, mv.y); }
  const k = Math.min((W - 40) / Math.max(1, x1 - x0), (H - 40) / Math.max(1, y1 - y0));
  const px = (mv) => [20 + (mv.x - x0) * k + (W - 40 - (x1 - x0) * k) / 2, 20 + (mv.y - y0) * k + (H - 40 - (y1 - y0) * k) / 2];
  const slider = h('input', { type: 'range', min: 0, max: 1000, value: 1000, style: { flex: 1, accentColor: 'var(--accent)' } });
  const travel = h('input', { type: 'checkbox', checked: true }), shade = h('input', { type: 'checkbox', checked: true });
  const clock = h('span', { style: { minWidth: '110px', textAlign: 'right' } });
  let playing = false;
  const draw = () => {
    const t = (slider.value / 1000) * total;
    ctx.setTransform(2, 0, 0, 2, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.lineCap = 'round';
    let head = px(moves[0]);
    for (let i = 1; i < moves.length; i++) {
      if (times[i - 1] > t) break;
      const a = px(moves[i - 1]);
      let b = px(moves[i]);
      if (times[i] > t) { const f = (t - times[i - 1]) / (times[i] - times[i - 1] || 1); b = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]; }
      head = b;
      const mv = moves[i];
      if (mv.rapid || !(mv.s > 0)) { if (!travel.checked) continue; ctx.strokeStyle = 'rgba(230,60,60,.55)'; ctx.lineWidth = 0.6; }
      else if (mv.lead) { ctx.strokeStyle = '#2f7de1'; ctx.lineWidth = 1; }
      else { const g = shade.checked ? Math.round(200 - 200 * Math.min(1, mv.s)) : 0; ctx.strokeStyle = `rgb(${g},${g},${g})`; ctx.lineWidth = 1; }
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    }
    ctx.fillStyle = '#ff3b30'; ctx.beginPath(); ctx.arc(head[0], head[1], 3.5, 0, Math.PI * 2); ctx.fill();
    clock.textContent = `${formatTime(t)} / ${formatTime(total)}`;
  };
  const play = button({ label: 'Play', icon: 'play', cls: 'btn-outline', onClick: () => {
    if (playing) { playing = false; return; }
    playing = true;
    if (+slider.value >= 1000) slider.value = 0;
    const startV = +slider.value, t0 = performance.now(), dur = 6000 * (1 - startV / 1000);
    const step = () => {
      if (!playing) return;
      const f = Math.min(1, (performance.now() - t0) / Math.max(200, dur));
      slider.value = startV + (1000 - startV) * f;
      draw();
      if (f < 1) requestAnimationFrame(step); else playing = false;
    };
    requestAnimationFrame(step);
  } });
  for (const c of [slider, travel, shade]) c.addEventListener('input', () => { if (c === slider) playing = false; draw(); });
  const st = plan.stats;
  m.body.append(cv, h('div', { class: 'row', style: { marginTop: '10px' } }, play, slider, clock),
    h('div', { class: 'row', style: { marginTop: '6px', flexWrap: 'wrap' } }, h('label', { class: 'check' }, travel, 'Show traversal moves'), h('label', { class: 'check' }, shade, 'Shade by power'),
      h('span', { style: { flex: 1 } }),
      h('span', { class: 'insp-note' }, `Cut distance ${(st.cut / 1000).toFixed(2)} m · Rapid moves ${(st.rapid / 1000).toFixed(2)} m · Size ${plan.bounds.w.toFixed(1)} × ${plan.bounds.h.toFixed(1)} mm · Estimated time ${formatTime(st.time)}`)),
    ...(plan.warnings.length ? [h('div', { class: 'insp-note', style: { color: '#ffb74d' } }, plan.warnings.join(' · '))] : []),
    h('div', { class: 'modal-actions' }, button({ label: 'Save G-code', icon: 'export', cls: 'btn-outline', onClick: () => ws.saveGcode() }), button({ label: 'Close', cls: 'btn-primary', onClick: () => m.close() })));
  draw();
}

export function confirmStart(warnings) {
  return confirmDialog('Start the job?', warnings.join('. ') + '. Do you want to start anyway?', 'Start anyway', true);
}

// ---------------------------------------------------------------- device settings
export function deviceDialog(ws) {
  const mc = ws.machine;
  const m = modal({ title: 'Device settings', width: 520 });
  quiet(m);
  const name = h('input', { class: 'input', type: 'text', value: mc.name });
  const flavor = h('select', { class: 'select' }, FLAVORS.map(([v, n]) => h('option', { value: v }, n)));
  flavor.value = mc.flavor;
  const bw = numInput(mc.bedW, 1, 10), bh = numInput(mc.bedH, 1, 10), smax = numInput(mc.sMax, 1, 1), rapid = numInput(mc.rapid, 100, 100), baud = h('select', { class: 'select' }, [9600, 57600, 115200, 230400, 250000, 921600].map((b) => h('option', { value: b }, b)));
  baud.value = mc.baud;
  const origin = h('select', { class: 'select' }, [['bl', 'Front left'], ['tl', 'Rear left'], ['br', 'Front right'], ['tr', 'Rear right']].map(([v, n]) => h('option', { value: v }, n)));
  origin.value = mc.origin;
  const units = h('select', { class: 'select' }, h('option', { value: 'mm/s' }, 'mm / second'), h('option', { value: 'mm/min' }, 'mm / minute'));
  units.value = mc.speedUnits;
  const snap = numInput(mc.gridSnap, 0.5, 0), framePower = numInput(mc.framePower || 0, 0.5, 0, 10);
  const grid = h('input', { type: 'checkbox', checked: mc.showGrid !== false });
  const ret = h('select', { class: 'select' }, h('option', { value: 'origin' }, 'Return to origin'), h('option', { value: 'stay' }, 'Stay where the job ends'));
  ret.value = mc.returnTo;
  const full = machineOf(mc), pz = full.plasma, ro = full.rotary;
  const zOn = h('input', { type: 'checkbox', checked: !!mc.zEnabled });
  const touch = h('input', { type: 'checkbox', checked: !!pz.touchOff });
  const pierceH = numInput(pz.pierceHeight, 0.1, 0), cutH = numInput(pz.cutHeight, 0.1, 0), safeH = numInput(pz.safeHeight, 1, 0), plunge = numInput(pz.plungeFeed, 50, 10);
  const probeDist = numInput(pz.probeDist, 1, 1), probeFeed = numInput(pz.probeFeed, 10, 10), swOff = numInput(pz.switchOffset, 0.05, 0);
  const thcOn = h('input', { class: 'input', type: 'text', value: pz.thcOn, placeholder: 'for example M62 P0' }), thcOff = h('input', { class: 'input', type: 'text', value: pz.thcOff, placeholder: 'for example M63 P0' });
  const rotOn = h('input', { type: 'checkbox', checked: !!ro.enabled });
  const rotType = h('select', { class: 'select' }, h('option', { value: 'roller' }, 'Roller (object rests on wheels)'), h('option', { value: 'chuck' }, 'Chuck (object is gripped)'));
  rotType.value = ro.type;
  const rotAxis = h('select', { class: 'select' }, h('option', { value: 'Y' }, 'Y motor'), h('option', { value: 'A' }, 'A axis'));
  rotAxis.value = ro.axis;
  const mmRot = numInput(ro.mmPerRotation, 1, 0.1), rollD = numInput(ro.rollerDiameter, 0.1, 0.1), objD = numInput(ro.objectDiameter, 0.1, 0.1);
  const rotNote = h('div', { class: 'insp-note' });
  const readRotary = () => ({ enabled: rotOn.checked, type: rotType.value, axis: rotAxis.value, mmPerRotation: Math.max(0.1, val(mmRot, 360)), rollerDiameter: Math.max(0.1, val(rollD, 60)), objectDiameter: Math.max(0.1, val(objD, 80)) });
  const showRotary = () => { const r = readRotary(); rotNote.textContent = r.enabled ? `1 mm around the object = ${rotaryScale({ rotary: r }).toFixed(4)} units on the ${r.axis} axis. Vertical distances in the design wrap around the object.` : 'Off: the Y axis moves normally.'; };
  for (const el of [rotOn, rotType, rotAxis, mmRot, rollD, objD]) el.addEventListener('input', showRotary);
  showRotary();
  m.body.append(
    h('div', { class: 'row' }, field('Device name', name), field('Controller', flavor)),
    h('div', { class: 'row' }, field('Work area width (mm)', bw), field('Work area height (mm)', bh)),
    h('div', { class: 'row' }, field('Origin corner', origin), field('S-value max (GRBL $30)', smax)),
    h('div', { class: 'row' }, field('Rapid speed (mm/min)', rapid), field('Baud rate', baud)),
    h('div', { class: 'row' }, field('Speed units', units), field('When a job finishes', ret)),
    h('div', { class: 'row' }, field('Snap to grid (mm, 0 = off)', snap), field('Frame laser power (%)', framePower)),
    h('label', { class: 'check' }, grid, 'Show grid'),
    h('details', { class: 'dev-group' }, h('summary', {}, 'Z axis and plasma torch height'),
      h('label', { class: 'check' }, zOn, 'This machine has a Z axis that DabbleCAD may move'),
      h('div', { class: 'insp-note' }, 'Lasers: adds Z offset and Z step per pass to each layer. Plasma: the torch rises to pierce height, fires, waits, then drops to cut height. Heights are above the material.'),
      h('div', { class: 'row' }, field('Pierce height (mm)', pierceH), field('Cut height (mm)', cutH), field('Safe travel height (mm)', safeH)),
      h('div', { class: 'row' }, field('Plunge speed (mm/min)', plunge)),
      h('label', { class: 'check' }, touch, 'Touch off before every pierce (floating head or ohmic probe wired to the probe input)'),
      h('div', { class: 'row' }, field('Probe travel (mm)', probeDist), field('Probe speed (mm/min)', probeFeed), field('Switch offset (mm)', swOff)),
      h('div', { class: 'row' }, field('Torch height control ON command', thcOn), field('Torch height control OFF command', thcOff)),
      h('div', { class: 'insp-note' }, 'Automatic height control while cutting is done by your controller or THC unit, not by DabbleCAD. These two commands only switch it on after the pierce and off before the torch stops; leave them empty if your machine does this itself. Use | between several commands.')),
    h('details', { class: 'dev-group' }, h('summary', {}, 'Rotary attachment'),
      h('label', { class: 'check' }, rotOn, 'Use the rotary for the next jobs'),
      h('div', { class: 'row' }, field('Type', rotType), field('Driven by', rotAxis)),
      h('div', { class: 'row' }, field('Axis units per full turn', mmRot), field('Roller diameter (mm)', rollD), field('Object diameter (mm)', objD)),
      rotNote),
    h('div', { class: 'insp-note' }, 'These settings describe your machine and apply to every design. The S-value max must match your controller ($30 on GRBL, usually 1000).'),
    actions(m, 'Save', () => {
      Object.assign(mc, {
        name: name.value.trim() || 'Laser', flavor: flavor.value, bedW: Math.max(10, val(bw, 400)), bedH: Math.max(10, val(bh, 400)), origin: origin.value,
        sMax: Math.max(1, val(smax, 1000)), rapid: Math.max(100, val(rapid, 6000)), baud: parseInt(baud.value, 10), speedUnits: units.value, returnTo: ret.value,
        gridSnap: Math.max(0, val(snap, 1)), framePower: Math.max(0, Math.min(10, val(framePower, 0))), showGrid: grid.checked,
        zEnabled: zOn.checked,
        plasma: { touchOff: touch.checked, probeDist: Math.max(1, val(probeDist, 30)), probeFeed: Math.max(10, val(probeFeed, 300)), switchOffset: Math.max(0, val(swOff, 0)),
          pierceHeight: Math.max(0, val(pierceH, 3.8)), cutHeight: Math.max(0, val(cutH, 1.5)), safeHeight: Math.max(0, val(safeH, 15)), plungeFeed: Math.max(10, val(plunge, 600)), thcOn: thcOn.value.trim(), thcOff: thcOff.value.trim() },
        rotary: readRotary(),
      });
      m.close();
      ws.saveMachine();
      ws.zoomToBed();
    }));
}

export { LAYER_COLORS };
