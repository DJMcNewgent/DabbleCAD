// Laser extras: variable text, text on a path, image masks, print-and-cut and the camera overlay.
import { h, modal, button, toast, clear } from '../ui/dom.js';
import { platform } from '../platform.js';
import { flatten, localPolys, pathFromPolys, apply, invert, boundsOf, setTextVariables, resolveText, IDENT_M } from './model.js';
import { registrationMap, toMachine } from './gcode.js';

const quiet = (m) => m.body.addEventListener('keydown', (e) => { if (e.key !== 'Escape') e.stopPropagation(); });
const field = (label, control) => h('label', { class: 'field' }, h('span', {}, label), control);
const numInput = (value, step = 1) => h('input', { class: 'input', type: 'number', value, step });
const val = (input, def = 0) => { const v = parseFloat(input.value); return isFinite(v) ? v : def; };

// ---------------------------------------------------------------- variable text
export const defaultVariables = () => ({ serial: 1, step: 1, autoAdvance: true, csv: null, row: 0 });

export function parseCsv(text) {
  return String(text || '').split(/\r?\n/).filter((l) => l.trim().length).map((line) => {
    const out = [];
    let cur = '', quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quoted) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') quoted = false; else cur += ch; }
      else if (ch === '"') quoted = true;
      else if (ch === ',' || ch === ';' || ch === '\t') { out.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    out.push(cur.trim());
    return out;
  });
}

/** Move the serial number and CSV row on by one job. */
export function advanceVariables(ws) {
  const v = ws.doc.variables;
  if (!v || v.autoAdvance === false) return false;
  let used = false;
  for (const e of ws.doc.shapes.flatMap((s) => flatten(s))) if (e.shape.type === 'text' && /\{(serial|csv)/i.test(e.shape.text || '')) used = true;
  if (!used) return false;
  v.serial = (Number(v.serial) || 0) + (Number(v.step) || 1);
  if (Array.isArray(v.csv) && v.csv.length) v.row = Math.min(v.csv.length - 1, (v.row || 0) + 1);
  setTextVariables(v);
  ws.commit();
  return true;
}

export function variableTextDialog(ws) {
  const v = ws.doc.variables || (ws.doc.variables = defaultVariables());
  const m = modal({ title: 'Variable text', width: 520 });
  quiet(m);
  const serial = numInput(v.serial, 1), step = numInput(v.step, 1), row = numInput((v.row || 0) + 1, 1);
  const auto = h('input', { type: 'checkbox', checked: v.autoAdvance !== false });
  const csvInfo = h('div', { class: 'insp-note' });
  const sample = h('div', { class: 'insp-note' });
  const apply2 = () => {
    v.serial = Math.round(val(serial, 1)); v.step = Math.round(val(step, 1)) || 1; v.autoAdvance = auto.checked;
    v.row = Math.max(0, Math.min((v.csv ? v.csv.length : 1) - 1, Math.round(val(row, 1)) - 1));
    setTextVariables(v);
    ws.commit();
    csvInfo.textContent = v.csv && v.csv.length ? `${v.csv.length} rows loaded · row ${v.row + 1}: ${v.csv[v.row].join(' | ')}` : 'No list loaded.';
    sample.textContent = `Right now: {serial:4} → ${resolveText('{serial:4}')} · {date} → ${resolveText('{date}')} · {time} → ${resolveText('{time}')}${v.csv ? ' · {csv:1} → ' + resolveText('{csv:1}') : ''}`;
  };
  for (const el of [serial, step, row, auto]) el.addEventListener('change', apply2);
  const insert = (token) => button({ label: token, cls: 'btn-outline', title: 'Add this to the selected text', onClick: () => {
    const t = ws.selected().find((s) => s.type === 'text');
    if (!t) { toast('Select a text object first'); return; }
    t.text = (t.text || '') + token;
    ws.commit();
    toast('Added ' + token);
  } });
  m.body.append(
    h('div', { class: 'insp-note' }, 'Put these codes in any text object. They are replaced when the text is drawn and when the job is made.'),
    h('div', { class: 'var-tokens' }, insert('{serial}'), insert('{serial:4}'), insert('{date}'), insert('{time}'), insert('{csv:1}'), insert('{csv:2}')),
    h('div', { class: 'row' }, field('Serial number', serial), field('Step', step)),
    h('label', { class: 'check' }, auto, 'Move to the next number / row after each job is started or saved'),
    h('div', { class: 'row' }, field('List row', row),
      field('Names or values list', button({ label: 'Load CSV…', cls: 'btn-outline', onClick: async () => {
        const files = await platform.openDialog({ title: 'Open a list', filters: [{ name: 'CSV or text', extensions: ['csv', 'txt', 'tsv'] }] });
        if (!files || !files.length) return;
        const rows = parseCsv(new TextDecoder().decode(files[0].data));
        if (!rows.length) { toast('That file has no rows', 'warn'); return; }
        v.csv = rows; v.row = 0; row.value = 1; apply2();
      } }))),
    csvInfo, sample,
    h('div', { class: 'modal-actions' },
      v.csv ? button({ label: 'Clear list', cls: 'btn-ghost', onClick: () => { v.csv = null; v.row = 0; apply2(); } }) : null,
      button({ label: 'Previous', cls: 'btn-outline', onClick: () => { serial.value = val(serial, 1) - (val(step, 1) || 1); row.value = Math.max(1, val(row, 1) - 1); apply2(); } }),
      button({ label: 'Next', cls: 'btn-outline', onClick: () => { serial.value = val(serial, 1) + (val(step, 1) || 1); row.value = val(row, 1) + 1; apply2(); } }),
      button({ label: 'Close', cls: 'btn-primary', onClick: () => m.close() })));
  apply2();
  return m;
}

// ---------------------------------------------------------------- text on a path
/** Bend outlines so their left-to-right direction follows `line` (bed points). Returns polys. */
export function bendAlong(polys, line, { offset = 0, flip = false } = {}) {
  let x0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of polys) for (const [x, y] of p.pts) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y > y1) y1 = y; }
  const seg = [];
  let total = 0;
  for (let i = 1; i < line.length; i++) { const d = Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]); if (d > 1e-9) { seg.push({ a: line[i - 1], b: line[i], s: total, d }); total += d; } }
  if (!seg.length) return polys;
  const at = (s) => {
    let g = seg[0];
    if (s >= total) g = seg[seg.length - 1]; else if (s > 0) g = seg.find((q) => s <= q.s + q.d) || seg[seg.length - 1];
    const t = (s - g.s) / g.d, tx = (g.b[0] - g.a[0]) / g.d, ty = (g.b[1] - g.a[1]) / g.d;
    return { x: g.a[0] + (g.b[0] - g.a[0]) * t, y: g.a[1] + (g.b[1] - g.a[1]) * t, tx, ty };
  };
  const map = ([x, y]) => {
    const p = at(offset + (x - x0)), up = (y1 - y) * (flip ? -1 : 1);
    // "up" from a left-to-right line is toward -y on the bed (y grows downward)
    return [p.x + p.ty * up, p.y - p.tx * up];
  };
  return polys.map((p) => {
    const pts = [];
    const n = p.pts.length, count = p.closed ? n : n - 1;
    for (let i = 0; i < count; i++) {
      const a = p.pts[i], b = p.pts[(i + 1) % n];
      // long straight strokes must bend too, so cut them into short pieces
      const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.6));
      for (let k = 0; k < steps; k++) pts.push(map([a[0] + ((b[0] - a[0]) * k) / steps, a[1] + ((b[1] - a[1]) * k) / steps]));
    }
    if (!p.closed) pts.push(map(p.pts[n - 1]));
    return { pts, closed: p.closed };
  });
}

export function textOnPath(ws) {
  const sel = ws.movable();
  const text = sel.find((s) => s.type === 'text');
  const guide = sel.find((s) => s !== text && s.type !== 'image' && s.type !== 'group');
  if (!text || !guide || sel.length !== 2) return toast('Select one text object and one line or shape to follow');
  const line = flatten(guide)[0];
  if (!line || line.pts.length < 2) return toast('That shape has no outline to follow');
  const pts = line.closed ? [...line.pts, line.pts[0]] : line.pts;
  const k = Math.hypot(text.m[0], text.m[1]) || 1;
  const src = localPolys(text).map((p) => ({ closed: p.closed, pts: p.pts.map(([x, y]) => [x * k, y * k]) }));
  let width = 0, length = 0;
  for (const p of src) for (const [x] of p.pts) width = Math.max(width, x);
  for (let i = 1; i < pts.length; i++) length += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  const out = pathFromPolys(text.layer, bendAlong(src, pts, { offset: Math.max(0, (length - width) / 2) }));
  out.name = 'Text on path';
  ws.doc.shapes.splice(ws.doc.shapes.indexOf(text), 1, out);
  ws.sel = [out.id];
  ws.commit();
  toast(width > length ? 'The text is longer than the path, so it runs past the end' : 'Text bent along the path. It is now a shape; undo to edit the words.');
  return out;
}

// ---------------------------------------------------------------- image masks
export function maskImage(ws) {
  const sel = ws.movable();
  const img = sel.find((s) => s.type === 'image');
  const shapes = sel.filter((s) => s !== img && s.type !== 'image');
  if (!img || !shapes.length) return toast('Select an image and the closed shape to show it through');
  const inv = invert(img.m);
  const polys = shapes.flatMap((s) => flatten(s)).filter((e) => e.closed && e.pts.length > 2).map((e) => e.pts.map((p) => apply(inv, p)));
  if (!polys.length) return toast('The mask shape must be closed');
  img.mask = polys;
  const ids = new Set(shapes.map((s) => s.id));
  ws.doc.shapes = ws.doc.shapes.filter((s) => !ids.has(s.id));
  ws.sel = [img.id];
  ws.commit();
  toast('Only the part of the image inside the shape will be engraved');
}

export function unmaskImage(ws) {
  const imgs = ws.selected().filter((s) => s.type === 'image' && s.mask);
  if (!imgs.length) return toast('Select a masked image');
  for (const s of imgs) delete s.mask;
  ws.commit();
}

// ---------------------------------------------------------------- print and cut
export function printCutDialog(ws) {
  const r = ws.doc.registration || (ws.doc.registration = { enabled: false, scale: true, d1: null, d2: null, m1: null, m2: null });
  const m = modal({ title: 'Print and cut', width: 540 });
  quiet(m);
  const info = h('div', { class: 'insp-note' });
  const body = h('div', {});
  const fmt = (p) => (p ? `${p[0].toFixed(2)}, ${p[1].toFixed(2)}` : 'not set');
  const laserPos = () => { const st = ws.device.status; const p = st && (st.wpos || st.mpos); return p ? [p[0], p[1]] : null; };
  const target = (n) => {
    const dk = 'd' + n, mk = 'm' + n;
    const mx = numInput(r[mk] ? r[mk][0] : '', 0.1), my = numInput(r[mk] ? r[mk][1] : '', 0.1);
    const setM = () => { const a = parseFloat(mx.value), b = parseFloat(my.value); r[mk] = isFinite(a) && isFinite(b) ? [a, b] : null; render(); };
    mx.addEventListener('change', setM); my.addEventListener('change', setM);
    return h('div', { class: 'pc-item' }, h('div', { class: 'pc-text' },
      h('b', {}, `Target ${n}`),
      h('small', {}, `In the design: ${fmt(r[dk])} (bed mm)`),
      h('div', { class: 'row' },
        button({ label: 'Use selected mark', cls: 'btn-outline', title: 'Use the centre of the selected shape as this target', onClick: () => {
          const b = boundsOf(ws.selected());
          if (!b) { toast('Select the registration mark first'); return; }
          r[dk] = [b.cx, b.cy]; render();
        } }),
        button({ label: 'Laser is on it', cls: 'btn-outline', title: 'Read where the laser head is now', onClick: () => {
          const p = laserPos();
          if (!p) { toast('Connect the laser, jog it over the printed mark, then try again (or type the position)', 'warn', 5000); return; }
          r[mk] = p; render();
        } })),
      h('div', { class: 'row' }, field('Laser X at the mark', mx), field('Laser Y at the mark', my))));
  };
  const scale = h('input', { type: 'checkbox', checked: r.scale !== false });
  scale.addEventListener('change', () => { r.scale = scale.checked; render(); });
  function render() {
    clear(body);
    body.append(target(1), target(2));
    const ready = r.d1 && r.d2 && r.m1 && r.m2;
    const map = ready ? registrationMap({ registration: { ...r, enabled: true } }, ws.machine) : null;
    info.textContent = !ready ? 'Set both targets to line the job up with a printed sheet.'
      : !map ? 'The two targets are in the same place. Pick marks that are far apart.'
        : `The job will be turned ${map.angle.toFixed(2)}° and ${r.scale === false ? 'not scaled' : 'scaled ' + (map.scale * 100).toFixed(2) + '%'} to match the sheet. ${Math.abs(map.scale - 1) > 0.03 ? 'That is a large size difference: check the targets.' : ''}`;
    on.disabled = !map;
    on.querySelector('.btn-label').textContent = r.enabled ? 'Turn alignment off' : 'Align the job';
    ws.commit();
  }
  const on = button({ label: 'Align the job', cls: 'btn-primary', onClick: () => { r.enabled = !r.enabled; render(); toast(r.enabled ? 'Jobs are now aligned to the printed sheet' : 'Alignment is off'); } });
  m.body.append(
    h('div', { class: 'insp-note' }, 'Line a cut up with something already printed. Pick two marks in the design, then jog the laser over each printed mark and record where it is. The job is moved and turned to fit. "Start from" settings are ignored while this is on.'),
    body, h('label', { class: 'check' }, scale, 'Also correct the size (printers rarely print at exactly 100%)'), info,
    h('div', { class: 'modal-actions' },
      button({ label: 'Clear', cls: 'btn-ghost', onClick: () => { Object.assign(r, { enabled: false, d1: null, d2: null, m1: null, m2: null }); render(); } }),
      button({ label: 'Close', cls: 'btn-outline', onClick: () => m.close() }), on));
  render();
  return m;
}

// ---------------------------------------------------------------- camera overlay
/** 3x3 homography (row-major, h[8] = 1) taking each src point to its dst point. Four pairs. */
export function homography(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r2 = c + 1; r2 < 8; r2++) if (Math.abs(A[r2][c]) > Math.abs(A[p][c])) p = r2;
    if (Math.abs(A[p][c]) < 1e-12) return null;
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    for (let r2 = 0; r2 < 8; r2++) {
      if (r2 === c) continue;
      const f = A[r2][c] / A[c][c];
      for (let k = c; k < 8; k++) A[r2][k] -= f * A[c][k];
      b[r2] -= f * b[c];
    }
  }
  return [...b.map((v, i) => v / A[i][i]), 1];
}

export const project = (H, x, y) => { const w = H[6] * x + H[7] * y + H[8]; return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w]; };

/**
 * Flatten a photo of the bed into a top-down picture. `corners` are the four photo pixels
 * showing the bed's rear-left, rear-right, front-right and front-left corners.
 */
export function warpToBed(imageData, corners, bedW, bedH, pxPerMM = 2) {
  const W = Math.max(1, Math.round(bedW * pxPerMM)), Hh = Math.max(1, Math.round(bedH * pxPerMM));
  const Hm = homography([[0, 0], [W, 0], [W, Hh], [0, Hh]], corners);
  if (!Hm) return null;
  const out = new ImageData(W, Hh), src = imageData.data, sw = imageData.width, sh = imageData.height;
  for (let y = 0; y < Hh; y++) {
    for (let x = 0; x < W; x++) {
      const [u, v] = project(Hm, x + 0.5, y + 0.5);
      const ix = Math.floor(u), iy = Math.floor(v), o = (y * W + x) * 4;
      if (ix < 0 || iy < 0 || ix >= sw || iy >= sh) { out.data[o + 3] = 0; continue; }
      const i = (iy * sw + ix) * 4;
      out.data[o] = src[i]; out.data[o + 1] = src[i + 1]; out.data[o + 2] = src[i + 2]; out.data[o + 3] = 255;
    }
  }
  return out;
}

export function cameraDialog(ws) {
  const m = modal({ title: 'Camera overlay', width: 760, onClose: () => stop() });
  quiet(m);
  const view = h('canvas', { class: 'camera-canvas', width: 720, height: 480, 'aria-label': 'Camera picture' });
  const ctx = view.getContext('2d');
  const note = h('div', { class: 'insp-note' });
  const NAMES = ['rear-left', 'rear-right', 'front-right', 'front-left'];
  let frame = null, stream = null, video = null, corners = [];
  const saved = ws.app.settings.laserCamera && Array.isArray(ws.app.settings.laserCamera.corners) ? ws.app.settings.laserCamera.corners : null;
  const stop = () => { if (stream) { for (const t of stream.getTracks()) t.stop(); stream = null; } video = null; };
  const scale = () => (frame ? Math.min(view.width / frame.width, view.height / frame.height) : 1);
  function draw() {
    ctx.clearRect(0, 0, view.width, view.height);
    if (!frame) { note.textContent = 'Take a picture of the empty bed with the camera, or load a photo of it.'; return; }
    const k = scale();
    ctx.drawImage(frame, 0, 0, frame.width * k, frame.height * k);
    ctx.strokeStyle = '#ffb347'; ctx.fillStyle = '#ffb347'; ctx.lineWidth = 2; ctx.font = '12px sans-serif';
    ctx.beginPath();
    corners.forEach((c, i) => { const x = c[0] * k, y = c[1] * k; if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
    if (corners.length === 4) ctx.closePath();
    ctx.stroke();
    corners.forEach((c, i) => { ctx.beginPath(); ctx.arc(c[0] * k, c[1] * k, 5, 0, Math.PI * 2); ctx.fill(); ctx.fillText(NAMES[i], c[0] * k + 8, c[1] * k - 8); });
    note.textContent = corners.length < 4 ? `Click the ${NAMES[corners.length]} corner of the work area in the picture (${corners.length + 1} of 4).` : 'All four corners are marked. Press "Show on bed".';
  }
  const setFrame = (source, w, hh) => {
    const c = document.createElement('canvas'); c.width = w; c.height = hh;
    c.getContext('2d').drawImage(source, 0, 0, w, hh);
    frame = c;
    // reuse the last calibration when the picture is the same size (camera not moved)
    corners = saved && ws.app.settings.laserCamera.width === w && ws.app.settings.laserCamera.height === hh ? saved.map((p) => [...p]) : [];
    draw();
  };
  view.addEventListener('pointerdown', (e) => {
    if (!frame || corners.length >= 4) return;
    const r = view.getBoundingClientRect(), k = scale();
    corners.push([((e.clientX - r.left) * (view.width / r.width)) / k, ((e.clientY - r.top) * (view.height / r.height)) / k]);
    draw();
  });
  const opacity = h('input', { type: 'range', min: 10, max: 100, step: 5, value: Math.round((ws.overlay ? ws.overlay.opacity : 0.6) * 100), title: 'How strongly the picture shows' });
  opacity.addEventListener('input', () => { if (ws.overlay) { ws.overlay.opacity = opacity.value / 100; ws.refresh(); } });
  const apply2 = () => {
    if (!frame || corners.length < 4) { toast('Mark the four corners first'); return; }
    const data = frame.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, frame.width, frame.height);
    const flat = warpToBed(data, corners, ws.machine.bedW, ws.machine.bedH, Math.min(3, 1600 / Math.max(ws.machine.bedW, ws.machine.bedH)));
    if (!flat) { toast('Those corners do not form a usable shape', 'warn'); return; }
    const c = document.createElement('canvas'); c.width = flat.width; c.height = flat.height;
    c.getContext('2d').putImageData(flat, 0, 0);
    ws.overlay = { canvas: c, opacity: opacity.value / 100 };
    ws.app.patchSettings({ laserCamera: { corners, width: frame.width, height: frame.height } });
    ws.refresh();
    toast('The picture is on the bed. Place your design over the material.');
  };
  m.body.append(
    h('div', { class: 'scribble-bar' },
      button({ label: 'Use camera', cls: 'btn-outline', onClick: async () => {
        try {
          stop();
          stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1920 }, height: { ideal: 1080 } } });
          video = document.createElement('video'); video.srcObject = stream; video.muted = true;
          await video.play();
          await new Promise((res) => setTimeout(res, 500));
          setFrame(video, video.videoWidth, video.videoHeight);
        } catch (err) { toast('No camera is available: ' + (err && err.message ? err.message : err), 'warn', 5000); }
      } }),
      button({ label: 'Take a new picture', cls: 'btn-outline', onClick: () => { if (!video) { toast('Start the camera first'); return; } setFrame(video, video.videoWidth, video.videoHeight); } }),
      button({ label: 'Load photo…', cls: 'btn-outline', onClick: async () => {
        const files = await platform.openDialog({ title: 'Open a photo of the bed', filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }] });
        if (!files || !files.length) return;
        const img = new Image();
        const url = URL.createObjectURL(new Blob([files[0].data]));
        img.onload = () => { URL.revokeObjectURL(url); setFrame(img, img.naturalWidth, img.naturalHeight); };
        img.onerror = () => { URL.revokeObjectURL(url); toast('Could not read that picture', 'warn'); };
        img.src = url;
      } }),
      button({ label: 'Mark corners again', cls: 'btn-outline', onClick: () => { corners = []; draw(); } }),
      h('span', { style: { flex: 1 } }), h('span', {}, 'Strength'), opacity),
    view, note,
    h('div', { class: 'insp-note' }, 'The camera must look at the whole work area and must not move afterwards. Accuracy depends on how carefully the corners are marked and on lens distortion, which is not corrected: check with a test mark before trusting it for precise placement.'),
    h('div', { class: 'modal-actions' },
      ws.overlay ? button({ label: 'Remove picture', cls: 'btn-ghost', onClick: () => { ws.overlay = null; ws.refresh(); m.close(); } }) : null,
      button({ label: 'Close', cls: 'btn-outline', onClick: () => m.close() }),
      button({ label: 'Show on bed', cls: 'btn-primary', onClick: apply2 })));
  draw();
  // exposed for automated checks
  m.el.__camera = { setFrame, setCorners: (c) => { corners = c; draw(); }, apply: apply2 };
  void toMachine; void IDENT_M;
  return m;
}
