// CNC design helpers and set-up dialogs: ready-made shapes, corner rounding, nesting, bits and machine settings.
import { h, clear, button, toast, modal, promptDialog } from '../ui/dom.js';
import { pathFromPolys, flatten, boundsOf, translate, mul, deep } from '../laser/model.js';
import { offsetPolys } from '../laser/ops.js';
import { POSTS } from './gcode.js';
import { DEFAULT_TOOLS, TOOL_TYPES } from './tooldb.js';
import { numRow, selectRow, checkRow, quiet, unitsOf, trim } from './ui.js';

const TAU = Math.PI * 2;
const circle = (cx, cy, r, n = 72) => Array.from({ length: n }, (_, i) => [cx + r * Math.cos((i / n) * TAU), cy + r * Math.sin((i / n) * TAU)]);

// ---------------------------------------------------------------- ready-made shapes
export const SHAPES = [['star', 'Star'], ['heart', 'Heart'], ['arrow', 'Arrow'], ['gear', 'Gear'], ['slot', 'Slot'], ['cross', 'Cross'], ['ring', 'Ring'], ['tag', 'Tag with a hole']];

/** Outlines for a shape that fits a box `s` mm across. Y runs downwards, like the drawing. */
export function shapePolys(id, s) {
  const r = s / 2, c = r;
  switch (id) {
    case 'star': return [{ closed: true, pts: Array.from({ length: 10 }, (_, i) => { const a = -Math.PI / 2 + (i / 10) * TAU, k = i % 2 ? r * 0.42 : r; return [c + k * Math.cos(a), c + k * Math.sin(a)]; }) }];
    case 'heart': {
      const pts = [];
      for (let i = 0; i < 90; i++) { const t = (i / 90) * TAU; pts.push([c + (r / 17) * 16 * Math.sin(t) ** 3, c - (r / 17) * (13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)) - r * 0.08]); }
      return [{ closed: true, pts }];
    }
    case 'arrow': return [{ closed: true, pts: [[0, s * 0.35], [s * 0.55, s * 0.35], [s * 0.55, s * 0.12], [s, s * 0.5], [s * 0.55, s * 0.88], [s * 0.55, s * 0.65], [0, s * 0.65]] }];
    case 'gear': {
      const teeth = 12, root = r * 0.78, pts = [];
      for (let i = 0; i < teeth; i++) {
        const a = (i / teeth) * TAU, w = TAU / teeth;
        for (const [f, rad] of [[0.0, root], [0.18, r], [0.42, r], [0.6, root]]) pts.push([c + rad * Math.cos(a + f * w), c + rad * Math.sin(a + f * w)]);
      }
      return [{ closed: true, pts }, { closed: true, pts: circle(c, c, r * 0.22, 48) }];
    }
    case 'slot': {
      const hh = s * 0.3, rr = hh / 2, pts = [];
      for (let i = 0; i <= 24; i++) { const a = -Math.PI / 2 + (i / 24) * Math.PI; pts.push([s - rr + rr * Math.cos(a), rr + rr * Math.sin(a)]); }
      for (let i = 0; i <= 24; i++) { const a = Math.PI / 2 + (i / 24) * Math.PI; pts.push([rr + rr * Math.cos(a), rr + rr * Math.sin(a)]); }
      return [{ closed: true, pts }];
    }
    case 'cross': { const a = s / 3, b = (2 * s) / 3; return [{ closed: true, pts: [[a, 0], [b, 0], [b, a], [s, a], [s, b], [b, b], [b, s], [a, s], [a, b], [0, b], [0, a], [a, a]] }]; }
    case 'ring': return [{ closed: true, pts: circle(c, c, r) }, { closed: true, pts: circle(c, c, r * 0.6) }];
    case 'tag': {
      const hh = s * 0.55, k = hh * 0.35;
      return [{ closed: true, pts: [[k, 0], [s, 0], [s, hh], [k, hh], [0, hh - k], [0, k]] }, { closed: true, pts: circle(k * 1.1, hh / 2, hh * 0.1, 32) }];
    }
    default: return [];
  }
}

export function insertShape(ws, id) {
  const j = ws.job, s = Math.max(10, Math.round(Math.min(j.w, j.h) / 4));
  const shape = pathFromPolys(ws.doc.currentLayer, shapePolys(id, s));
  const b = boundsOf([shape]);
  shape.m = translate(j.w / 2 - b.cx, j.h / 2 - b.cy);
  ws.add([shape]);
  ws.setTool('select');
}

// ---------------------------------------------------------------- modify
/** Round the corners of the selected closed shapes. Toolpaths stay attached to them. */
export function roundCorners(ws, radius, which = 'both') {
  let n = 0;
  ws.doc.shapes = ws.doc.shapes.map((s) => {
    if (!ws.sel.includes(s.id) || s.type === 'image' || s.locked) return s;
    let polys = flatten(s).filter((p) => p.closed && p.shape.type !== 'image');
    if (!polys.length) return s;
    // shrinking then growing rounds the corners that point outwards; growing then shrinking rounds the ones that point in
    if (which !== 'inside') { const a = offsetPolys(polys, -radius, 'round'); if (a.length) polys = offsetPolys(a, radius, 'round'); }
    if (which !== 'outside') polys = offsetPolys(offsetPolys(polys, radius, 'round'), -radius, 'round');
    if (!polys.length) return s;
    n += 1;
    return { ...pathFromPolys(s.type === 'group' ? ws.doc.currentLayer : s.layer, polys), id: s.id };
  });
  if (n) ws.commit();
  return n;
}

export function roundCornersDialog(ws) {
  if (!ws.sel.length) return toast('Select the shapes to round first', 'warn');
  const u = unitsOf(ws.job.units);
  const st = { radius: 3, which: 'both' };
  const m = modal({ title: 'Round corners', width: 380 });
  quiet(m.body);
  m.body.append(
    numRow('Radius', st.radius, (v) => { st.radius = v; }, { unit: u.name, k: u.k, dp: u.dp, min: 0.05, max: 1000, step: u.inch ? 0.01 : 0.5 }),
    selectRow('Corners', st.which, [['both', 'All corners'], ['outside', 'Corners that point out'], ['inside', 'Corners that point in']], (v) => { st.which = v; }),
    h('div', { class: 'insp-note' }, 'Tip: a radius the size of your bit makes inside corners the machine can really cut.'),
    h('div', { class: 'modal-actions' }, button({ label: 'Cancel', cls: 'btn-outline', onClick: () => m.close() }),
      button({ label: 'Round', cls: 'btn-primary', onClick: () => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); const n = roundCorners(ws, st.radius, st.which); m.close(); toast(n ? `Rounded ${n} shape${n === 1 ? '' : 's'}` : 'Nothing closed is selected'); } })));
}

/** Pack the selected parts into rows on the material, starting at the front left. Returns how many did not fit. */
export function nest(ws, gap = 10, margin = 10) {
  const j = ws.job;
  const items = ws.movable().map((s) => ({ s, b: boundsOf([s]) })).filter((x) => x.b).sort((a, b) => b.b.h - a.b.h);
  let x = margin, yBottom = j.h - margin, rowH = 0, missed = 0;
  for (const it of items) {
    if (x > margin && x + it.b.w > j.w - margin) { x = margin; yBottom -= rowH + gap; rowH = 0; }
    if (it.b.w > j.w - 2 * margin || yBottom - it.b.h < margin) { missed += 1; continue; }
    it.s.m = mul(translate(x - it.b.x0, yBottom - it.b.h - it.b.y0), it.s.m);
    x += it.b.w + gap; rowH = Math.max(rowH, it.b.h);
  }
  if (items.length) ws.commit();
  return { placed: items.length - missed, missed };
}

export async function nestSelection(ws) {
  if (!ws.movable().length) return toast('Select the parts to arrange first', 'warn');
  const u = unitsOf(ws.job.units);
  const v = await promptDialog('Fit parts onto the material', `Gap to leave between parts (${u.name}). Allow at least the width of the bit, plus a little.`, u.show(10));
  if (v == null) return;
  const gap = Math.max(0, parseFloat(v) / u.k || 0);
  const r = nest(ws, gap, Math.max(5, gap));
  toast(r.missed ? `${r.placed} placed. ${r.missed} did not fit on the material.` : `Arranged ${r.placed} part${r.placed === 1 ? '' : 's'}`, r.missed ? 'warn' : 'info', 4000);
}

// ---------------------------------------------------------------- set-up
export function settingsDialog(ws, tab = 'machine') {
  const m = modal({ title: 'CNC setup', width: 640 });
  quiet(m.body);
  const u = unitsOf(ws.job.units);
  const tabs = h('div', { class: 'segmented' }), body = h('div', { class: 'cnc-setup-body' });
  const show = (id) => { for (const b of tabs.children) b.classList.toggle('active', b.dataset.tab === id); clear(body).append(id === 'bits' ? bitsTab() : machineTab()); };
  for (const [id, label] of [['machine', 'Machine and G-code'], ['bits', 'Bits']]) { const b = button({ label, onClick: () => show(id) }); b.dataset.tab = id; tabs.append(b); }

  const machineTab = () => {
    const c = ws.cfg, set = (k) => (v) => ws.saveCfg({ [k]: v });
    const len = { unit: u.name, k: u.k, dp: u.dp };
    return h('div', {},
      h('div', { class: 'le-sub' }, 'G-code'),
      selectRow('Controller', c.post, Object.entries(POSTS).map(([k, p]) => [k, p.name]), (v) => { set('post')(v); show('machine'); }, { title: 'Which kind of G-code to write' }),
      numRow('Safe height', c.safeZ, set('safeZ'), { ...len, min: 0.5, max: 200, step: u.inch ? 0.05 : 1, title: 'How high above the material the bit travels between cuts. Make it higher than your clamps.' }),
      selectRow('Spindle', c.spindle, [['auto', 'Switched by the G-code (M3 / M5)'], ['manual', 'I switch the router on myself']], set('spindle')),
      numRow('Spin-up wait', c.spinUp, set('spinUp'), { unit: 'seconds', min: 0, max: 60, step: 1, dp: 1 }),
      selectRow('Coolant output', c.coolant, [['off', 'Off'], ['flood', 'Flood / dust extraction (M8)'], ['mist', 'Mist (M7)']], set('coolant')),
      selectRow('When finished', c.park, [['none', 'Stay above the last cut'], ['zero', 'Go back to X0 Y0']], set('park')),
      checkRow('Save a separate file for each bit', c.splitByTool, set('splitByTool'), 'For controllers where you would rather start a fresh file after each bit change'),
      h('div', { class: 'insp-note' }, POSTS[c.post].toolChange === 'pause' ? 'With several bits in one file, the job pauses for each change. In the Machine tab you can jog and set Z zero again before carrying on.' : 'Bit changes are written as T and M6 commands.'),
      h('div', { class: 'le-sub' }, 'Your machine'),
      selectRow('Build', String(c.strength), [['0.6', 'Light (small desktop machines, 3018)'], ['1', 'Standard (belt or screw driven hobby routers)'], ['1.4', 'Rigid (heavy frame, strong spindle)']], (v) => set('strength')(parseFloat(v)), { title: 'Scales the automatic speeds and depths' }),
      numRow('Fastest feed', c.maxFeed, set('maxFeed'), { unit: u.feedName, k: u.k, dp: u.inch ? 1 : 0, min: 50, max: 100000, step: 100 }),
      numRow('Rapid speed', c.rapidRate, set('rapidRate'), { unit: u.feedName, k: u.k, dp: u.inch ? 1 : 0, min: 50, max: 100000, step: 100, title: 'Only used to estimate how long a job takes' }),
      numRow('Top spindle speed', c.maxRpm, set('maxRpm'), { unit: 'RPM', min: 1000, max: 100000, step: 1000, dp: 0 }),
      selectRow('Serial speed', String(c.baud), [['115200', '115200 (most GRBL boards)'], ['250000', '250000'], ['57600', '57600'], ['9600', '9600']], (v) => set('baud')(+v)),
      h('div', { class: 'le-sub' }, 'Drawing'),
      numRow('Snap to grid', c.gridSnap, set('gridSnap'), { ...len, min: 0, max: 100, step: u.inch ? 0.0625 : 0.5, title: '0 switches snapping off' }),
      checkRow('Show the grid', c.showGrid, set('showGrid')));
  };

  const bitsTab = () => {
    const list = () => deep(ws.bits());
    const save = (next) => { ws.saveCfg({ tools: next }); show('bits'); };
    const rows = h('div', { class: 'cnc-bits' });
    rows.append(h('div', { class: 'cnc-bit-row head' }, h('span', {}, 'Name'), h('span', {}, 'Kind'), h('span', {}, `Diameter (${u.name})`), h('span', {}, 'V angle °'), h('span', {})));
    list().forEach((b, i) => {
      const upd = (patch) => { const next = list(); next[i] = { ...next[i], ...patch }; save(next); };
      const name = h('input', { class: 'input', type: 'text', value: b.name });
      name.addEventListener('change', () => upd({ name: name.value.trim() || 'Bit' }));
      const kind = h('select', { class: 'select' }, TOOL_TYPES.map(([v, t]) => h('option', { value: v }, t)));
      kind.value = b.type;
      kind.addEventListener('change', () => upd({ type: kind.value, angle: kind.value === 'vbit' ? b.angle || 60 : undefined }));
      const dia = h('input', { class: 'input', type: 'number', min: 0.01, step: u.inch ? 0.001 : 0.1, value: trim(b.dia * u.k, u.dp) });
      dia.addEventListener('change', () => { const v = parseFloat(dia.value); if (v > 0) upd({ dia: +(v / u.k).toFixed(4) }); });
      const ang = h('input', { class: 'input', type: 'number', min: 5, max: 170, step: 5, value: b.type === 'vbit' ? b.angle || 60 : '', disabled: b.type !== 'vbit' });
      ang.addEventListener('change', () => { const v = parseFloat(ang.value); if (v >= 5 && v <= 170) upd({ angle: v }); });
      rows.append(h('div', { class: 'cnc-bit-row' }, name, kind, dia, ang, button({ icon: 'trash', cls: 'btn-ghost', title: 'Remove this bit', onClick: () => { const next = list(); next.splice(i, 1); if (!next.length) return toast('Keep at least one bit', 'warn'); save(next); } })));
    });
    return h('div', {}, h('div', { class: 'insp-note' }, 'The bits you own. Toolpaths keep their own copy of the bit they were set up with, so changing a bit here does not alter jobs you have already made.'), rows,
      h('div', { class: 'lz-row' },
        button({ label: 'Add a bit', icon: 'plus', cls: 'btn-outline', onClick: () => save([...list(), { id: 'bit' + Date.now().toString(36), name: 'New bit', type: 'end', dia: 6, flutes: 2 }]) }),
        button({ label: 'Restore the standard set', cls: 'btn-ghost', onClick: () => save(deep(DEFAULT_TOOLS)) })));
  };

  m.body.append(tabs, body, h('div', { class: 'modal-actions' }, button({ label: 'Done', cls: 'btn-primary', onClick: () => m.close() })));
  show(tab);
}
