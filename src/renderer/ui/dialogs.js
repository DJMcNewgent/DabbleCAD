// Dialogs: settings, grid, export, shortcuts, statistics, pattern, notes.
import { h, modal, button, toast, clear } from './dom.js';
import { platform, isDesktop } from '../platform.js';
import { EXPORT_FORMATS } from '../core/io.js';
import { formatLength } from '../view/gizmo.js';
import { countShapes } from '../core/doc.js';

const toggle = (checked, onChange) => {
  const input = h('input', { type: 'checkbox', checked });
  input.addEventListener('change', () => onChange(input.checked));
  return h('label', { class: 'switch' }, input, h('i'));
};
const row = (title, hint, control) => h('div', { class: 'set-row' }, h('div', { class: 'set-text' }, title, hint ? h('small', {}, hint) : null), control);

export async function settingsDialog(app) {
  const s = app.settings;
  const m = modal({ title: 'Settings', width: 620 });
  const gpu = await platform.gpuInfo();
  const renderer = app.viewport.gpuName();
  const software = /swiftshader|llvmpipe|software|basic render/i.test(renderer || '');
  const gpuOn = s.gpu !== 'off';
  let pendingRestart = false;
  const restartNote = h('div', { class: 'insp-note', style: { display: 'none' } }, 'Restart DabbleCAD to apply this change. ',
    button({ label: 'Restart now', cls: 'btn-primary', onClick: async () => { if (await app.confirmLeave()) platform.relaunch(); } }));
  const needRestart = () => { pendingRestart = true; restartNote.style.display = ''; };

  const themeSeg = h('div', { class: 'segmented' });
  const themeBtn = (id, label) => {
    const b = button({ label, cls: s.theme === id ? 'active' : '', onClick: () => { app.setTheme(id); [...themeSeg.children].forEach((c) => c.classList.toggle('active', c === b)); } });
    return b;
  };
  themeSeg.append(themeBtn('dark', 'Dark'), themeBtn('light', 'Light'));

  const gpuSel = h('select', { class: 'select' },
    h('option', { value: 'auto' }, 'Use GPU when available (recommended)'),
    h('option', { value: 'off' }, 'Software rendering (CPU only)'));
  gpuSel.value = gpuOn ? 'auto' : 'off';
  gpuSel.addEventListener('change', () => { app.patchSettings({ gpu: gpuSel.value }); needRestart(); });

  const status = !gpu.hardwareAcceleration
    ? h('span', { class: 'gpu-warn' }, 'Software rendering is active (GPU acceleration is turned off).')
    : software
      ? h('span', { class: 'gpu-warn' }, 'No usable GPU was detected, so DabbleCAD is rendering on the CPU.')
      : h('span', { class: 'gpu-ok' }, 'GPU acceleration is active.');
  const range = (key, min, max, step) => {
    const input = h('input', { type: 'range', min, max, step, value: s[key] });
    input.addEventListener('input', () => app.patchSettings({ [key]: parseFloat(input.value) }));
    return input;
  };

  m.body.append(
    h('div', { class: 'set-group' }, h('h4', {}, 'Appearance'),
      row('Theme', 'DabbleCAD starts in dark mode; switch to light any time.', themeSeg),
      row('Shadows', 'Soft shadows on the workplane.', toggle(s.shadows !== false, (v) => app.patchSettings({ shadows: v }))),
      row('Show edges', 'Draw outline edges on every shape.', toggle(!!s.edges, (v) => app.patchSettings({ edges: v }))),
      row('Dimension labels', 'Show editable sizes next to the selection.', toggle(s.showDims !== false, (v) => app.patchSettings({ showDims: v })))),
    h('div', { class: 'set-group' }, h('h4', {}, 'Graphics'),
      row('Rendering', 'Changing this needs a restart.', gpuSel),
      h('div', { class: 'gpu-box' }, status, h('br'), 'Renderer: ' + (renderer || 'unknown'),
        s.gpuAutoDisabled ? [h('br'), 'GPU acceleration was switched off automatically after the graphics driver crashed.'] : null),
      row('Anti-aliasing', 'Smoother edges; turn off on slow machines. Needs a restart.', toggle(s.antialias !== false, (v) => { app.patchSettings({ antialias: v }); needRestart(); })),
      restartNote),
    h('div', { class: 'set-group' }, h('h4', {}, 'Navigation'),
      row('Orbit speed', 'Right-drag (or Ctrl + left-drag) to orbit.', range('orbitSpeed', 0.3, 2.5, 0.1)),
      row('Zoom speed', 'Scroll to zoom toward the cursor.', range('zoomSpeed', 0.3, 2.5, 0.1)),
      row('Invert zoom direction', null, toggle(!!s.zoomInvert, (v) => app.patchSettings({ zoomInvert: v })))),
    h('div', { class: 'set-group' }, h('h4', {}, 'Files'),
      row('Auto-save', 'Designs are saved to your library as you work.', toggle(s.autosave !== false, (v) => app.patchSettings({ autosave: v }))),
      isDesktop ? row('Design library', 'Where DabbleCAD keeps your designs.', button({ label: 'Open folder', icon: 'folder', cls: 'btn-outline', onClick: () => platform.openDesignsFolder() })) : null),
    h('div', { class: 'set-group' }, h('h4', {}, 'About'),
      row(`DabbleCAD ${s.version || ''}`, 'Created by DJMcNewgent · open source under the MIT License.', button({ label: 'About', icon: 'info', cls: 'btn-outline', onClick: () => aboutDialog(app) }))));
  void pendingRestart;
}

const BED_PRESETS = [
  ['Default', 200, 200], ['Bambu Lab A1 mini', 180, 180], ['Bambu Lab X1 / P1 / A1', 256, 256], ['Prusa MK4 / MK3S+', 250, 210],
  ['Prusa MINI+', 180, 180], ['Prusa XL', 360, 360], ['Creality Ender 3', 220, 220], ['Creality K1', 220, 220], ['Creality Ender 5 Plus', 350, 350],
  ['Anycubic Kobra 2', 220, 220], ['Elegoo Neptune 4', 225, 225], ['Ultimaker S5', 330, 240], ['MakerBot Replicator+', 295, 195],
  ['Glowforge (laser bed)', 495, 279], ['Large', 500, 500], ['Extra large', 1000, 1000],
];

export function gridDialog(app) {
  const ed = app.editor;
  const wp = ed.doc.workplane;
  const m = modal({ title: 'Edit Grid', width: 440 });
  const units = h('select', { class: 'select' }, h('option', { value: 'mm' }, 'Millimeters'), h('option', { value: 'in' }, 'Inches'), h('option', { value: 'brick' }, 'Bricks'));
  units.value = wp.units;
  const preset = h('select', { class: 'select' }, h('option', { value: '' }, 'Custom'), BED_PRESETS.map(([name, w, l], i) => h('option', { value: i }, `${name} (${w} × ${l} mm)`)));
  const hit = BED_PRESETS.findIndex(([, w, l]) => w === wp.width && l === wp.length);
  preset.value = hit >= 0 ? String(hit) : '';
  const width = h('input', { class: 'input', type: 'number', min: 10, max: 2000, step: 1, value: wp.width });
  const length = h('input', { class: 'input', type: 'number', min: 10, max: 2000, step: 1, value: wp.length });
  preset.addEventListener('change', () => { const p = BED_PRESETS[+preset.value]; if (preset.value !== '' && p) { width.value = p[1]; length.value = p[2]; } });
  for (const i of [width, length]) i.addEventListener('input', () => { preset.value = ''; });
  m.body.append(
    h('label', { class: 'field' }, h('span', {}, 'Units'), units),
    h('label', { class: 'field' }, h('span', {}, 'Presets'), preset),
    h('div', { class: 'row' }, h('label', { class: 'field' }, h('span', {}, 'Width (mm)'), width), h('label', { class: 'field' }, h('span', {}, 'Length (mm)'), length)),
    h('div', { class: 'modal-actions' },
      button({ label: 'Cancel', cls: 'btn-outline', onClick: () => m.close() }),
      button({ label: 'Update Grid', cls: 'btn-primary', onClick: () => {
        const w = Math.min(2000, Math.max(10, parseFloat(width.value) || 200)), l = Math.min(2000, Math.max(10, parseFloat(length.value) || 200));
        ed.setWorkplane({ units: units.value, width: w, length: l });
        app.refreshGridBar();
        app.viewport.home();
        m.close();
      } })));
}

export function exportDialog(app) {
  const ed = app.editor;
  const m = modal({ title: 'Download', width: 520 });
  let selectedOnly = false;
  const seg = h('div', { class: 'segmented' });
  const all = button({ label: 'Everything in the design', cls: 'active', onClick: () => set(false) });
  const sel = button({ label: 'The selected shapes', cls: ed.selection.size ? '' : 'disabled', onClick: () => set(true) });
  const set = (v) => { selectedOnly = v; all.classList.toggle('active', !v); sel.classList.toggle('active', v); };
  seg.append(all, sel);
  const grid = h('div', { class: 'format-grid' });
  for (const f of EXPORT_FORMATS) {
    const b = h('button', { class: 'format-btn', type: 'button' }, h('b', {}, '.' + f.id.toUpperCase()), h('small', {}, f.hint));
    b.addEventListener('click', async () => { m.close(); await app.exportAs(f.id, selectedOnly); });
    grid.append(b);
  }
  const shot = h('button', { class: 'format-btn', type: 'button' }, h('b', {}, '.PNG'), h('small', {}, 'Picture of the current view'));
  shot.addEventListener('click', async () => { m.close(); await app.exportScreenshot(); });
  const file = h('button', { class: 'format-btn', type: 'button' }, h('b', {}, '.DABBLE'), h('small', {}, 'Editable DabbleCAD design file'));
  file.addEventListener('click', async () => { m.close(); await app.saveCopy(); });
  grid.append(shot, file);
  m.body.append(h('div', { class: 'field' }, h('span', {}, 'Include'), seg), h('div', { class: 'field' }, h('span', {}, 'Format'), grid),
    h('div', { class: 'insp-note' }, 'Holes are never exported on their own. Hidden shapes are skipped. Sizes are in millimetres.'));
}

const SHORTCUTS = [
  ['Viewing', [['Orbit', 'Right-drag  ·  Ctrl + drag'], ['Pan', 'Middle-drag  ·  Shift + right-drag'], ['Zoom', 'Scroll  ·  + / −'], ['Fit view to selection', 'F'], ['Home view', 'Home'], ['Perspective / orthographic', 'O']]],
  ['Moving shapes', [['Move along X / Y', 'Arrow keys'], ['Move along Z', 'Ctrl + ↑ / ↓'], ['Move ×10', 'Shift + arrows'], ['Constrain to one axis', 'Shift + drag'], ['Drag a copy', 'Alt + drag'], ['Drop to workplane', 'D'], ['Cruise (snap onto shapes)', 'C']]],
  ['Resizing and rotating', [['Uniform scale', 'Shift + handle'], ['Scale from centre', 'Alt + handle'], ['Rotate in 45° steps', 'Shift + rotate'], ['Type a size', 'Click a dimension']]],
  ['Shape properties', [['Solid', 'S'], ['Hole', 'H'], ['Transparent', 'T'], ['Lock / unlock', 'Ctrl + L'], ['Hide', 'Ctrl + H'], ['Show all', 'Ctrl + Shift + H']]],
  ['Tools', [['Workplane', 'W'], ['Workplane on selection', 'Shift + W'], ['Ruler', 'R'], ['Notes', 'N'], ['Align', 'L'], ['Mirror', 'M'], ['Cancel tool', 'Esc']]],
  ['Commands', [['Copy / Cut / Paste', 'Ctrl + C / X / V'], ['Paste in place', 'Ctrl + Shift + V'], ['Duplicate and repeat', 'Ctrl + D'], ['Delete', 'Del'], ['Undo / Redo', 'Ctrl + Z / Ctrl + Y'], ['Select all', 'Ctrl + A'],
    ['Group (union)', 'Ctrl + G'], ['Intersect group', 'Ctrl + I'], ['Bundle', 'Ctrl + B'], ['Ungroup', 'Ctrl + Shift + G'], ['Add to / remove from selection', 'Shift + click'], ['Box select', 'Drag on empty space']]],
];

export function shortcutsDialog() {
  const m = modal({ title: 'Keyboard and mouse shortcuts', width: 760 });
  m.body.append(h('div', { class: 'shortcut-cols' }, SHORTCUTS.map(([title, rows]) =>
    h('div', { class: 'shortcut-group' }, h('h4', {}, title), rows.map(([a, b]) => h('div', { class: 'shortcut-row' }, h('span', {}, a), h('span', { class: 'kbd' }, b)))))));
}

export function statsDialog(app) {
  const ed = app.editor;
  const sel = ed.selectedNodes();
  const nodes = (sel.length ? sel : ed.doc.nodes).filter((n) => !n.hidden);
  const m = modal({ title: sel.length ? 'Selection details' : 'Design details', width: 420 });
  const u = ed.units;
  const b = ed.bounds(nodes);
  const info = ed.measureNodes(nodes);
  const cm3 = info.volume / 1000;
  const size = b.isEmpty() ? '—' : `${formatLength(b.max.x - b.min.x, u)} × ${formatLength(b.max.y - b.min.y, u)} × ${formatLength(b.max.z - b.min.z, u)} ${u === 'brick' ? 'bricks' : u}`;
  const rows = [
    ['Objects', nodes.length], ['Primitive shapes', countShapes(nodes)], ['Triangles', info.triangles.toLocaleString()],
    ['Bounding size (W × L × H)', size], ['Volume', cm3.toFixed(2) + ' cm³'], ['Surface area', (info.area / 100).toFixed(2) + ' cm²'],
    ['Weight in PLA (solid)', (cm3 * 1.24).toFixed(1) + ' g'], ['Weight in PETG (solid)', (cm3 * 1.27).toFixed(1) + ' g'], ['Weight in ABS (solid)', (cm3 * 1.04).toFixed(1) + ' g'],
  ];
  m.body.append(h('div', { class: 'stat-grid' }, rows.flatMap(([k, v]) => [h('span', {}, k), h('span', {}, String(v))])),
    h('p', { class: 'insp-note', style: { marginTop: '14px' } }, 'Holes are ignored. Overlapping ungrouped shapes are counted separately; group them for an exact volume. Weights assume 100% infill.'));
}

export function patternDialog(app) {
  const ed = app.editor;
  if (!ed.selection.size) { toast('Select a shape to repeat'); return; }
  const m = modal({ title: 'Pattern', width: 440 });
  const type = h('select', { class: 'select' }, h('option', { value: 'linear' }, 'Linear (rows)'), h('option', { value: 'circular' }, 'Circular (around the workplane origin)'));
  const num = (value, step = 1) => h('input', { class: 'input', type: 'number', value, step });
  const count = num(4), dx = num(25), dy = num(0), dz = num(0), angle = num(360);
  const linear = h('div', { class: 'row' }, h('label', { class: 'field' }, h('span', {}, 'Step X (mm)'), dx), h('label', { class: 'field' }, h('span', {}, 'Step Y (mm)'), dy), h('label', { class: 'field' }, h('span', {}, 'Step Z (mm)'), dz));
  const circular = h('label', { class: 'field', style: { display: 'none' } }, h('span', {}, 'Total angle (degrees)'), angle);
  type.addEventListener('change', () => { linear.style.display = type.value === 'linear' ? '' : 'none'; circular.style.display = type.value === 'circular' ? '' : 'none'; });
  m.body.addEventListener('keydown', (e) => e.stopPropagation());
  m.body.append(h('label', { class: 'field' }, h('span', {}, 'Type'), type), h('label', { class: 'field' }, h('span', {}, 'Total copies (including the original)'), count), linear, circular,
    h('div', { class: 'modal-actions' }, button({ label: 'Cancel', cls: 'btn-outline', onClick: () => m.close() }),
      button({ label: 'Create pattern', cls: 'btn-primary', onClick: () => {
        const n = Math.min(200, Math.max(2, Math.round(parseFloat(count.value) || 2)));
        ed.pattern({ type: type.value, count: n, dx: parseFloat(dx.value) || 0, dy: parseFloat(dy.value) || 0, dz: parseFloat(dz.value) || 0, angle: parseFloat(angle.value) || 360 });
        m.close();
      } })));
}

/** Create or edit a note. Resolves to text, '' (delete) or null (cancel). */
export function noteDialog(text = '', isNew = true) {
  return new Promise((resolve) => {
    let result = null;
    const m = modal({ title: isNew ? 'New note' : 'Edit note', width: 420, onClose: () => resolve(result) });
    const ta = h('textarea', { class: 'input', style: { width: '100%', height: '96px', padding: '8px', resize: 'vertical' }, placeholder: 'Write a note…' });
    ta.value = text;
    ta.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { result = ta.value.trim(); m.close(); } if (e.key === 'Escape') m.close(); });
    m.body.append(ta, h('div', { class: 'modal-actions' },
      !isNew ? button({ label: 'Delete note', cls: 'btn-danger', onClick: () => { result = ''; m.close(); } }) : null,
      h('span', { style: { flex: 1 } }),
      button({ label: 'Cancel', cls: 'btn-outline', onClick: () => m.close() }),
      button({ label: 'Save', cls: 'btn-primary', onClick: () => { result = ta.value.trim(); m.close(); } })));
    setTimeout(() => ta.focus(), 30);
  });
}

/** Ask what to do with unsaved changes (auto-save off). Resolves to 'save', 'discard' or null (cancel). */
export function saveChangesDialog(name) {
  return new Promise((resolve) => {
    let result = null;
    const m = modal({ title: 'Save changes?', width: 440, onClose: () => resolve(result) });
    const pick = (r) => { result = r; m.close(); };
    const save = button({ label: 'Save', cls: 'btn-primary', onClick: () => pick('save') });
    m.body.append(
      h('p', { class: 'modal-text' }, `“${name || 'Untitled'}” has changes that have not been saved.`),
      h('div', { class: 'modal-actions' },
        button({ label: 'Don’t save', cls: 'btn-outline', onClick: () => pick('discard') }),
        h('span', { style: { flex: 1 } }),
        button({ label: 'Cancel', cls: 'btn-outline', onClick: () => m.close() }),
        save));
    setTimeout(() => save.focus(), 30);
  });
}

const THIRD_PARTY = [
  ['Electron', 'MIT'], ['three.js', 'MIT'], ['three-mesh-bvh', 'MIT'], ['three-bvh-csg', 'MIT'], ['opentype.js', 'MIT'],
  ['qrcode-generator', 'MIT'], ['Clipper (clipper-lib)', 'Boost Software License 1.0'], ['Roboto font (Fontsource)', 'SIL Open Font License 1.1'],
];

export function aboutDialog(app) {
  const m = modal({ title: 'About DabbleCAD', width: 480 });
  const link = h('a', { href: 'https://github.com/DJMcNewgent', target: '_blank', rel: 'noreferrer', class: 'about-link' }, 'github.com/DJMcNewgent');
  m.body.append(
    h('div', { class: 'about-head' }, app.logoMark(), h('div', {}, h('div', { class: 'about-name' }, 'DabbleCAD'), h('div', { class: 'insp-note' }, `Version ${app.settings.version || '1.0.0'}`))),
    h('p', { class: 'modal-text' }, 'A desktop app for 3D design and laser work: build with shapes, holes and groups, then export for printing or send jobs to a laser.'),
    h('div', { class: 'stat-grid' },
      h('span', {}, 'Created by'), h('span', {}, 'DJMcNewgent'),
      h('span', {}, 'GitHub'), h('span', {}, link),
      h('span', {}, 'License'), h('span', {}, 'MIT License (open source)')),
    h('p', { class: 'modal-text', style: { marginTop: '14px' } },
      'Copyright © 2026 DJMcNewgent. DabbleCAD is free and open-source software released under the MIT License: you may use, copy, modify and share it, provided the copyright and license notice are kept. It comes with no warranty.'),
    h('details', { class: 'about-third' }, h('summary', {}, 'Open-source components'),
      h('div', { class: 'stat-grid' }, THIRD_PARTY.flatMap(([n, l]) => [h('span', {}, n), h('span', {}, l)]))),
    h('div', { class: 'modal-actions' }, button({ label: 'Close', cls: 'btn-primary', onClick: () => m.close() })));
}

export { clear };
