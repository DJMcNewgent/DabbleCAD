// Machine tab helpers: macros, probing, surfacing, axis calibration, controller settings, diagnostics.
import { h, button, toast, modal, confirmDialog } from '../ui/dom.js';
import { platform } from '../platform.js';
import { buildGcode } from './gcode.js';
import { SETTINGS, settingInfo } from './grblcodes.js';
import { numRow, selectRow, textRow, actions, quiet, trim } from './ui.js';

const fx = (v) => +(+v).toFixed(3);

// ---------------------------------------------------------------- macros
export const DEFAULT_MACROS = [
  { name: 'Raise Z 10 mm', gcode: 'G91 G0 Z10\nG90' },
  { name: 'Go to XY zero', gcode: 'G90 G0 X0 Y0' },
  { name: 'Park at the back', gcode: 'G53 G0 Z-5\nG53 G0 X-5 Y-5', note: 'Needs a homed machine' },
  { name: 'Spindle warm-up', gcode: 'M3 S8000\nG4 P60\nM3 S16000\nG4 P60\nM5' },
];

/** Macros are written in millimetres and run that way, whatever units the last job used. */
export async function runMacro(panel, text) {
  if (!panel.need()) return null;
  const lines = String(text).split(/\r?\n/).map((l) => l.replace(/;.*$/, '').trim()).filter(Boolean);
  return panel.inMm(async () => { try { return await panel.dev.sendAll(lines); } catch (err) { panel.log(err.message, 'error'); return null; } });
}

export function macrosPane(panel) {
  const list = () => (Array.isArray(panel.cfg.macros) ? panel.cfg.macros : DEFAULT_MACROS);
  const save = (next) => { panel.ws.saveCfg({ macros: next }); panel.showTab('macros'); };
  const edit = (i) => {
    const cur = i == null ? { name: '', gcode: '' } : list()[i];
    const m = modal({ title: i == null ? 'New macro' : 'Edit macro', width: 460 });
    quiet(m.body);
    const name = h('input', { class: 'input', type: 'text', value: cur.name, placeholder: 'For example: Go to the tool change spot' });
    const code = h('textarea', { class: 'input cm-macro-code', spellcheck: false, placeholder: 'One G-code command per line' }, cur.gcode);
    m.body.append(h('label', { class: 'field' }, h('span', {}, 'Name'), name), h('label', { class: 'field' }, h('span', {}, 'G-code'), code),
      actions(m, 'Save', () => {
        if (!name.value.trim() || !code.value.trim()) return toast('Give the macro a name and some G-code', 'warn');
        const next = [...list()];
        const item = { name: name.value.trim(), gcode: code.value.trim() };
        if (i == null) next.push(item); else next[i] = item;
        save(next); m.close();
      }, i == null ? [] : [button({ label: 'Delete', cls: 'btn-danger', onClick: () => { save(list().filter((_x, k) => k !== i)); m.close(); } })]));
  };
  const grid = h('div', { class: 'cm-macros' });
  list().forEach((mc, i) => {
    const b = button({ label: mc.name, cls: 'btn-outline', title: (mc.note ? mc.note + '\n' : '') + mc.gcode + '\n\nRight-click to edit', onClick: () => runMacro(panel, mc.gcode) });
    b.addEventListener('contextmenu', (e) => { e.preventDefault(); edit(i); });
    grid.append(b);
  });
  grid.append(button({ label: 'Add macro', icon: 'plus', cls: 'btn-ghost', onClick: () => edit(null) }));
  return h('div', { class: 'cm-pane' }, h('div', { class: 'insp-note' }, 'One-click commands. Right-click a macro to change or delete it.'), grid);
}

// ---------------------------------------------------------------- probing
/** Touch off on a plate under the bit and set Z. Returns the probe result, or null if it failed. */
export const probeZ = (panel) => panel.inMm(() => touchZ(panel));
async function touchZ(panel) {
  const d = panel.dev, c = panel.cfg.probe;
  let r = await d.probe(`G38.2 G91 Z-${fx(c.distance)} F${fx(c.feed)}`);
  if (!r || !r.ok) return null;
  // back off and touch again slowly for an accurate reading
  await d.send('G91 G0 Z2');
  r = await d.probe(`G38.2 G91 Z-4 F${fx(Math.max(10, c.feed / 4))}`);
  if (!r || !r.ok) return null;
  await d.sendAll([`G10 L20 P1 Z${fx(c.plateZ)}`, 'G91 G0 Z5', 'G90']);
  await d.idle(15000);
  return r;
}

/**
 * Find the front-left corner with a corner plate. Start with the bit over the plate, roughly
 * `inset` mm in from the corner both ways. Sets X, Y and Z zero at the corner of the material.
 */
export const probeCorner = (panel, inset = 15) => panel.inMm(() => touchCorner(panel, inset));
async function touchCorner(panel, inset) {
  const d = panel.dev, c = panel.cfg.probe;
  if (!(await touchZ(panel))) return null;
  const edge = c.plateXY + c.bit / 2, out = inset + edge + 6, up = fx(c.plateZ + 5), slow = fx(Math.max(10, c.feed / 2));
  for (const a of ['X', 'Y']) {
    await d.sendAll([`G91 G0 ${a}-${fx(out)}`, 'G90 G0 Z-5']);
    const r = await d.probe(`G38.2 G91 ${a}${fx(out)} F${slow}`);
    if (!r || !r.ok) return null;
    // the bit's edge is touching the outside of the plate
    await d.sendAll([`G10 L20 P1 ${a}-${fx(edge)}`, `G91 G0 ${a}-3`, `G90 G0 Z${up}`, `G90 G0 ${a}${fx(inset)}`]);
  }
  await d.sendAll(['G90 G0 X0 Y0']);
  await d.idle(20000);
  return true;
}

/** With the bit inside a hole (or a ring), find its middle. Optionally make that X0 Y0. */
export const probeCentre = (panel, setZero = true) => panel.inMm(() => touchCentre(panel, setZero));
async function touchCentre(panel, setZero) {
  const d = panel.dev, c = panel.cfg.probe;
  await d.idle(5000);
  const start = [...d.status.mpos];
  const reach = fx(Math.max(c.distance, 20)), f = fx(c.feed);
  const centre = [];
  for (const [i, a] of ['X', 'Y'].entries()) {
    const lo = await d.probe(`G38.2 G91 ${a}-${reach} F${f}`);
    if (!lo || !lo.ok) return null;
    await d.send(`G53 G0 ${a}${fx(start[i])}`);
    const hi = await d.probe(`G38.2 G91 ${a}${reach} F${f}`);
    if (!hi || !hi.ok) return null;
    centre[i] = (lo.mpos[i] + hi.mpos[i]) / 2;
    await d.send(`G53 G0 ${a}${fx(centre[i])}`);
  }
  await d.sendAll(setZero ? ['G10 L20 P1 X0 Y0', 'G90'] : ['G90']);
  await d.idle(15000);
  return centre;
}

export function probePane(panel) {
  const u = panel.u, c = panel.cfg.probe;
  const set = (k) => (v) => { panel.ws.saveCfg({ probe: { ...panel.cfg.probe, [k]: v } }); };
  const len = (label, k, title) => numRow(label, c[k], set(k), { unit: u.name, k: u.k, dp: u.dp, min: 0, max: 500, step: u.inch ? 0.01 : 0.5, title });
  const run = async (fn, okMsg) => {
    const r = await fn();
    if (r) toast(okMsg); else if (panel.dev.connected) toast('The probe did not finish. Check the clip and plate, press Unlock if the machine is locked, and try again.', 'warn', 6000);
  };
  const card = (title, text, label, fn) => h('div', { class: 'cm-card' }, h('b', {}, title), h('p', {}, text), button({ label, cls: 'btn-primary', onClick: fn }));
  return h('div', { class: 'cm-pane cm-probe' },
    h('div', { class: 'cm-probe-set' },
      len('Plate thickness', 'plateZ', 'How thick the touch plate is under the bit'),
      len('Plate edge', 'plateXY', 'For a corner plate: how far its outer faces stand off from the edges of the material'),
      len('Bit diameter', 'bit', 'The bit that is in the spindle now (used for the corner probe)'),
      len('Search distance', 'distance', 'How far to travel looking for the plate before giving up'),
      numRow('Probe speed', c.feed, set('feed'), { unit: u.feedName, k: u.k, dp: u.inch ? 1 : 0, min: 5, max: 2000, step: 10 })),
    h('div', { class: 'cm-cards' },
      card('Z touch plate', 'Put the plate on the material under the bit and clip the lead to the bit. Sets Z zero on top of the material.', 'Probe Z', () => run(() => probeZ(panel), 'Z zero is set on top of the material')),
      card('Corner (X, Y and Z)', 'Sit a corner plate on the front left corner and hold the bit over it, about 15 mm in from the corner. Sets X, Y and Z zero at the corner.', 'Probe corner', () => run(() => probeCorner(panel), 'X, Y and Z zero are set at the corner')),
      card('Centre of a hole', 'Lower the bit into a hole or ring that is wired as a probe. Finds the middle and makes it X0 Y0.', 'Find centre', () => run(() => probeCentre(panel), 'X0 Y0 is at the centre'))));
}

// ---------------------------------------------------------------- surfacing and calibration
/** G-code that planes an area flat, back and forth along X. */
export function surfacingProgram({ w, hgt, depth, passDepth, dia, stepover, feed, rpm }, opts) {
  const tool = { type: 'end', dia, name: `${trim(dia)} mm surfacing bit` };
  const step = Math.max(0.5, dia * Math.min(0.9, Math.max(0.1, stepover / 100)));
  const n = Math.max(1, Math.ceil(depth / Math.max(0.05, passDepth) - 1e-6));
  const rows = Math.max(1, Math.ceil(hgt / step));
  const paths = [];
  for (let k = 1; k <= n; k++) {
    const z = -(depth * k) / n, pts = [];
    for (let r = 0; r <= rows; r++) {
      const y = Math.min(hgt, r * step), a = r % 2 ? w : 0, b = r % 2 ? 0 : w;
      pts.push([a, y, z], [b, y, z]);
    }
    paths.push({ pts });
  }
  return buildGcode({ name: 'Surfacing', sections: [{ name: 'Flatten', tool, feed, plunge: feed / 4, rpm, paths }], notes: ['X0 Y0 at the front left corner of the area, Z0 on its highest point'] }, { ...opts, zOffset: 0 });
}

export function toolsPane(panel) {
  const u = panel.u, ws = panel.ws, j = ws.job;
  const big = [...ws.bits()].filter((b) => b.type === 'end').sort((a, b) => b.dia - a.dia)[0] || { dia: 25.4 };
  const s = panel._surf || (panel._surf = { w: j.w, hgt: j.h, depth: 0.5, passDepth: 0.5, dia: big.dia, stepover: 60, feed: 1500, rpm: 14000 });
  const len = (label, k, o = {}) => numRow(label, s[k], (v) => { s[k] = v; }, { unit: u.name, k: u.k, dp: u.dp, min: 0.05, max: 5000, step: u.inch ? 0.01 : 0.5, ...o });
  const surf = h('div', { class: 'cm-card cm-card-wide' }, h('b', {}, 'Flatten the bed or a board'),
    h('p', {}, 'Planes an area level with a wide bit. Set X0 Y0 at its front left corner and Z0 on its highest point, then load and run.'),
    h('div', { class: 'cm-form' }, len('Width (X)', 'w'), len('Height (Y)', 'hgt'), len('Bit diameter', 'dia'), len('Take off in total', 'depth'), len('Per pass', 'passDepth'),
      numRow('Overlap step', s.stepover, (v) => { s.stepover = v; }, { unit: '% of bit', min: 10, max: 90, step: 5, dp: 0 }),
      numRow('Feed rate', s.feed, (v) => { s.feed = v; }, { unit: u.feedName, k: u.k, dp: u.inch ? 1 : 0, min: 10, max: 20000, step: 50 }),
      numRow('Spindle speed', s.rpm, (v) => { s.rpm = v; }, { unit: 'RPM', min: 0, max: 60000, step: 500, dp: 0 })),
    button({ label: 'Load surfacing job', cls: 'btn-primary', onClick: () => {
      const out = surfacingProgram(s, ws.outOpts());
      panel.loadProgram({ name: 'Surfacing', text: out.text, stock: { x0: 0, y0: 0, w: s.w, h: s.hgt, t: Math.max(1, s.depth) } });
      toast('Surfacing job loaded. Check your zero, then press Start.');
    } }));

  // calibration: move a known distance, measure what really happened
  const cal = panel._cal || (panel._cal = { axis: 'X', dist: 100, measured: 100 });
  const idx = 'XYZ'.indexOf(cal.axis), cur = parseFloat(panel.dev.settings[100 + idx]);
  const next = cur > 0 && cal.measured > 0 ? (cur * cal.dist) / cal.measured : NaN;
  const calc = h('div', { class: 'insp-note' }, panel.dev.connected && cur > 0 ? `Steps per mm now: ${trim(cur, 4)}. With your measurement it becomes ${trim(next, 4)}.` : 'Connect to the machine to read its current steps per mm.');
  const calib = h('div', { class: 'cm-card cm-card-wide' }, h('b', {}, 'Calibrate an axis'),
    h('p', {}, 'If cuts come out a little too long or too short: mark where the axis is, move it, measure how far it really went, and save.'),
    h('div', { class: 'cm-form' },
      selectRow('Axis', cal.axis, [['X', 'X'], ['Y', 'Y'], ['Z', 'Z']], (v) => { cal.axis = v; panel.showTab('tools'); }),
      numRow('Move by', cal.dist, (v) => { cal.dist = v; cal.measured = v; panel.showTab('tools'); }, { unit: 'mm', min: 1, max: 2000, step: 10 }),
      numRow('It really moved', cal.measured, (v) => { cal.measured = v; panel.showTab('tools'); }, { unit: 'mm', min: 0.1, max: 4000, step: 0.1 })),
    calc,
    h('div', { class: 'lz-row' },
      button({ label: `Move ${cal.axis} by ${trim(cal.dist)} mm`, cls: 'btn-outline', onClick: () => { if (panel.need()) panel.dev.jog([0, 1, 2].map((k) => (k === idx ? cal.dist : 0)), Math.min(panel.cfg.jogFeed, idx === 2 ? 500 : 1500)).catch(() => {}); } }),
      button({ label: 'Save new steps per mm', cls: 'btn-primary', onClick: async () => {
        if (!panel.need() || !(next > 0)) return;
        if (!(await confirmDialog('Save calibration', `Change ${cal.axis} steps per mm from ${trim(cur, 4)} to ${trim(next, 4)}?`, 'Save'))) return;
        const r = await panel.cmd(`$${100 + idx}=${trim(next, 4)}`);
        if (r === 'ok') { toast('Saved. Move and measure again to check.'); panel.dev.send('$$', { echo: false }).catch(() => {}); } else toast('The controller did not accept the new value.', 'warn');
      } })));
  return h('div', { class: 'cm-pane cm-cards' }, surf, calib);
}

// ---------------------------------------------------------------- controller settings
export function firmwarePane(panel) {
  const d = panel.dev;
  if (!d.connected) return h('div', { class: 'cm-pane' }, h('div', { class: 'insp-note' }, 'Connect to the machine to see and change the settings stored in its controller.'));
  const keys = Object.keys(d.settings).map(Number).sort((a, b) => a - b);
  const inputs = new Map();
  const table = h('div', { class: 'cm-fw-table' });
  for (const k of keys) {
    const info = settingInfo(k);
    const input = h('input', { class: 'input', type: 'text', value: d.settings[k], spellcheck: false });
    input.addEventListener('keydown', (e) => e.stopPropagation());
    input.addEventListener('input', () => input.classList.toggle('changed', input.value.trim() !== String(d.settings[k])));
    inputs.set(k, input);
    table.append(h('div', { class: 'cm-fw-row', title: info.help }, h('code', {}, '$' + k), h('span', { class: 'cm-fw-name' }, info.name, info.help ? h('small', {}, info.help) : null), input, h('em', {}, info.unit === 'bool' ? '0 or 1' : info.unit)));
  }
  const refresh = () => d.send('$$', { echo: false }).catch(() => {});
  const save = async () => {
    if (!panel.need()) return;
    const changed = keys.filter((k) => inputs.get(k).value.trim() !== String(d.settings[k]));
    if (!changed.length) return toast('Nothing has been changed');
    let bad = 0;
    for (const k of changed) { const r = await panel.cmd(`$${k}=${inputs.get(k).value.trim()}`); if (r !== 'ok') bad += 1; }
    toast(bad ? `${bad} setting${bad === 1 ? ' was' : 's were'} not accepted. See the console.` : `Saved ${changed.length} setting${changed.length === 1 ? '' : 's'}`, bad ? 'warn' : 'info', 4000);
    refresh();
  };
  const backup = async () => {
    const text = keys.map((k) => `$${k}=${d.settings[k]}`).join('\n') + '\n';
    const path = await platform.saveDialog({ title: 'Save controller settings', defaultName: 'controller-settings.txt', filters: [{ name: 'Text', extensions: ['txt'] }], data: text });
    if (path) toast('Saved a copy of the settings to ' + path);
  };
  const restore = async () => {
    if (!panel.need()) return;
    const files = await platform.openDialog({ title: 'Restore controller settings', filters: [{ name: 'Text', extensions: ['txt', 'nc', 'gcode'] }] });
    if (!files.length) return;
    const lines = new TextDecoder().decode(files[0].data).split(/\r?\n/).map((l) => l.trim()).filter((l) => /^\$\d+=/.test(l));
    if (!lines.length) return toast('That file has no settings in it', 'warn');
    if (!(await confirmDialog('Restore settings', `Write ${lines.length} settings from ${files[0].name} to the controller?`, 'Restore'))) return;
    let bad = 0;
    for (const l of lines) { const r = await panel.cmd(l.replace(/\s.*$/, '')); if (r !== 'ok') bad += 1; }
    toast(bad ? `${bad} lines were not accepted` : 'Settings restored', bad ? 'warn' : 'info');
    refresh();
  };
  if (!keys.length) table.append(h('div', { class: 'insp-note' }, 'No settings have been read yet. Press Refresh.'));
  const known = SETTINGS.length;
  void known;
  return h('div', { class: 'cm-pane' },
    h('div', { class: 'lz-row cm-fw-actions' }, button({ label: 'Save changes', cls: 'btn-primary', onClick: save }), button({ label: 'Refresh', cls: 'btn-outline', onClick: refresh }),
      button({ label: 'Back up to a file', cls: 'btn-outline', onClick: backup }), button({ label: 'Restore from a file', cls: 'btn-outline', onClick: restore })),
    table);
}

export function pinsPane(panel) {
  const d = panel.dev, st = d.status;
  const lamp = (label, on, tip) => h('div', { class: 'cm-lamp' + (on ? ' on' : ''), title: tip }, h('i'), label);
  const pin = (c) => st.pins.includes(c);
  return h('div', { class: 'cm-pane' },
    h('div', { class: 'insp-note' }, d.connected ? 'Press a limit switch or touch the probe to the plate: its light should come on. If a light is on when nothing is touching, the pin needs inverting in the controller settings.' : 'Connect to the machine to see its switches and probe.'),
    h('div', { class: 'cm-lamps' },
      lamp('X limit', pin('X'), 'X limit switch'), lamp('Y limit', pin('Y'), 'Y limit switch'), lamp('Z limit', pin('Z'), 'Z limit switch'), lamp('Probe', pin('P'), 'Touch plate / probe'),
      lamp('Door', pin('D'), 'Safety door'), lamp('Hold', pin('H'), 'Feed hold button'), lamp('Reset', pin('R'), 'Reset button'), lamp('Start', pin('S'), 'Cycle start button')),
    h('div', { class: 'insp-note' }, d.connected ? `State: ${st.state}${st.sub ? ':' + st.sub : ''} · firmware ${d.info.version || 'unknown'}${d.info.options ? ' (' + d.info.options + ')' : ''} · receive buffer ${d.rxSize} bytes` : ''));
}
