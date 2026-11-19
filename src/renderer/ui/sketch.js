// Sketch: draw a precise 2D outline (rectangles, circles, polygons, with typed dimensions)
// and pull it up into a 3D shape. Items can add material or cut it away.
import { h, modal, button, toast, clear } from './dom.js';
import { regionPolys } from '../core/solid.js';

const W = 760, H = 460;
const SHEETS = [60, 120, 240, 480];
let nextId = 1;

function outline(item) {
  if (item.type === 'rect') {
    const { x, y, w, h: hh } = item;
    return [[x, y], [x + w, y], [x + w, y + hh], [x, y + hh]];
  }
  if (item.type === 'circle') {
    const n = Math.max(24, Math.min(96, Math.round(item.r * 6)));
    return Array.from({ length: n }, (_, i) => [item.cx + item.r * Math.cos((i / n) * Math.PI * 2), item.cy + item.r * Math.sin((i / n) * Math.PI * 2)]);
  }
  return item.pts.map((p) => [p[0], p[1]]);
}

const inside = (pt, poly) => {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a[1] > pt[1]) !== (b[1] > pt[1]) && pt[0] < ((b[0] - a[0]) * (pt[1] - a[1])) / (b[1] - a[1]) + a[0]) hit = !hit;
  }
  return hit;
};

/** Convert sketch items into extrusion polygons (centred on their bounding box). */
export function sketchPolys(items) {
  const adds = items.filter((i) => !i.cut).map(outline).filter((p) => p.length >= 3);
  const cuts = items.filter((i) => i.cut).map(outline).filter((p) => p.length >= 3);
  if (!adds.length) return null;
  let polys = regionPolys(adds, cuts);
  if (!polys) polys = adds.map((outer) => ({ outer, holes: [] })); // kernel unavailable: cuts are ignored
  if (!polys.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of polys) for (const [x, y] of p.outer) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const shift = (pt) => [pt[0] - cx, pt[1] - cy];
  return polys.map((p) => ({ outer: p.outer.map(shift), holes: p.holes.map((hh) => hh.map(shift)) }));
}

/** Opens the sketch editor. Resolves to { polys, sketch, depth } or null. */
export function sketchDialog(existing) {
  return new Promise((resolve) => {
    let result = null;
    const m = modal({ title: 'Sketch', width: W + 300, onClose: () => { document.removeEventListener('keydown', onKey, true); resolve(result); } });
    const canvas = h('canvas', { class: 'sketch-canvas', width: W, height: H, tabindex: 0, 'aria-label': 'Sketch drawing area' });
    const ctx = canvas.getContext('2d');
    let items = existing && existing.items ? existing.items.map((i) => ({ ...i, pts: i.pts ? i.pts.map((p) => [...p]) : undefined, id: nextId++ })) : [];
    let depth = existing && existing.depth ? existing.depth : 10;
    let sheet = existing && existing.sheet ? existing.sheet : 120;
    let tool = 'rect', snap = 1, selected = null, draft = null, drag = null, cursor = null;
    const undo = [];
    const remember = () => { undo.push(JSON.stringify(items)); if (undo.length > 50) undo.shift(); };

    const scale = () => W / sheet; // px per mm
    const toPx = (p) => [W / 2 + p[0] * scale(), H / 2 - p[1] * scale()];
    const toMm = (e) => {
      const r = canvas.getBoundingClientRect();
      const x = ((e.clientX - r.left) * (W / r.width) - W / 2) / scale(), y = -((e.clientY - r.top) * (H / r.height) - H / 2) / scale();
      const s = e.altKey || !snap ? 0.01 : snap;
      return [Math.round(x / s) * s, Math.round(y / s) * s];
    };
    const css = (name, fallback) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

    function draw() {
      const k = scale();
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = css('--bg-2', '#1c1f27'); ctx.fillRect(0, 0, W, H);
      const step = sheet <= 60 ? 1 : sheet <= 120 ? 5 : 10;
      ctx.lineWidth = 1;
      for (let v = -Math.ceil(sheet / step) * step; v <= sheet; v += step) {
        const major = Math.round(v / step) % 2 === 0;
        ctx.strokeStyle = v === 0 ? 'rgba(120,160,255,0.55)' : major ? 'rgba(128,140,160,0.22)' : 'rgba(128,140,160,0.1)';
        const x = Math.round(W / 2 + v * k) + 0.5, y = Math.round(H / 2 - v * k) + 0.5;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
      }
      const path = (pts, close = true) => { ctx.beginPath(); pts.forEach((p, i) => { const q = toPx(p); if (i) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]); }); if (close) ctx.closePath(); };
      for (const pass of [false, true]) {
        for (const it of items) {
          if (!!it.cut !== pass) continue;
          path(outline(it));
          ctx.fillStyle = it.cut ? 'rgba(214,69,69,0.30)' : 'rgba(63,167,163,0.38)';
          ctx.fill();
          ctx.strokeStyle = it.id === selected ? '#ffb347' : it.cut ? '#e06a6a' : '#58c9c4';
          ctx.lineWidth = it.id === selected ? 2.5 : 1.5;
          ctx.setLineDash(it.cut ? [6, 4] : []);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
      if (draft) {
        ctx.strokeStyle = '#ffb347'; ctx.lineWidth = 1.5;
        if (draft.type === 'poly') {
          path([...draft.pts, ...(cursor ? [cursor] : [])], false); ctx.stroke();
          for (const p of draft.pts) { const q = toPx(p); ctx.fillStyle = '#ffb347'; ctx.fillRect(q[0] - 3, q[1] - 3, 6, 6); }
        } else { path(outline(draft)); ctx.stroke(); }
      }
      ctx.fillStyle = css('--text', '#e6e9ef'); ctx.font = '12px sans-serif';
      if (cursor) ctx.fillText(`${cursor[0].toFixed(1)}, ${cursor[1].toFixed(1)} mm`, 10, H - 10);
      ctx.fillText(`${sheet} mm wide`, W - 86, H - 10);
    }

    const hit = (pt) => { for (let i = items.length - 1; i >= 0; i--) if (inside(pt, outline(items[i]))) return items[i]; return null; };
    const moveItem = (it, dx, dy) => {
      if (it.type === 'rect') { it.x += dx; it.y += dy; }
      else if (it.type === 'circle') { it.cx += dx; it.cy += dy; }
      else it.pts = it.pts.map((p) => [p[0] + dx, p[1] + dy]);
    };
    const finishPoly = () => {
      if (draft && draft.type === 'poly' && draft.pts.length >= 3) { remember(); const it = { ...draft, id: nextId++ }; items.push(it); selected = it.id; }
      draft = null; panel(); draw();
    };

    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      canvas.focus();
      try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
      const p = toMm(e);
      if (tool === 'select') {
        const it = hit(p);
        selected = it ? it.id : null;
        if (it) { remember(); drag = { last: p }; }
        panel(); draw();
      } else if (tool === 'poly') {
        if (!draft) draft = { type: 'poly', pts: [p], cut: false };
        else {
          const first = draft.pts[0];
          if (draft.pts.length >= 3 && Math.hypot(first[0] - p[0], first[1] - p[1]) * scale() < 9) { finishPoly(); return; }
          draft.pts.push(p);
        }
        draw();
      } else {
        draft = tool === 'rect' ? { type: 'rect', x: p[0], y: p[1], w: 0, h: 0, cut: false, anchor: p } : { type: 'circle', cx: p[0], cy: p[1], r: 0, cut: false };
      }
    });
    canvas.addEventListener('pointermove', (e) => {
      const p = toMm(e);
      cursor = p;
      if (drag && selected) {
        const it = items.find((i) => i.id === selected);
        if (it) { moveItem(it, p[0] - drag.last[0], p[1] - drag.last[1]); drag.last = p; panel(); }
      } else if (draft && draft.type === 'rect') {
        draft.x = Math.min(draft.anchor[0], p[0]); draft.y = Math.min(draft.anchor[1], p[1]);
        draft.w = Math.abs(p[0] - draft.anchor[0]); draft.h = Math.abs(p[1] - draft.anchor[1]);
      } else if (draft && draft.type === 'circle') {
        draft.r = Math.hypot(p[0] - draft.cx, p[1] - draft.cy);
      }
      draw();
    });
    canvas.addEventListener('pointerup', () => {
      if (drag) { drag = null; return; }
      if (!draft || draft.type === 'poly') return;
      const ok = draft.type === 'rect' ? draft.w > 0.2 && draft.h > 0.2 : draft.r > 0.2;
      if (ok) { remember(); const { anchor, ...it } = draft; void anchor; it.id = nextId++; items.push(it); selected = it.id; }
      draft = null; panel(); draw();
    });
    canvas.addEventListener('dblclick', () => { if (tool === 'poly') finishPoly(); });

    const onKey = (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (!document.body.contains(canvas)) return;
      if (e.key === 'Enter' && draft && draft.type === 'poly') { e.preventDefault(); e.stopPropagation(); finishPoly(); }
      else if (e.key === 'Escape' && draft) { e.preventDefault(); e.stopPropagation(); draft = null; draw(); }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && selected) { e.preventDefault(); e.stopPropagation(); remember(); items = items.filter((i) => i.id !== selected); selected = null; panel(); draw(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.stopPropagation(); const s = undo.pop(); if (s) { items = JSON.parse(s); selected = null; panel(); draw(); } }
    };
    document.addEventListener('keydown', onKey, true);

    // ---- side panel: typed dimensions for the selected item
    const side = h('div', { class: 'sketch-side' });
    const num = (label, value, onChange, { min = -1000, step = 0.1 } = {}) => {
      const input = h('input', { class: 'input', type: 'number', step, min, value: +(+value).toFixed(3) });
      input.addEventListener('change', () => { const v = parseFloat(input.value); if (isFinite(v) && v >= min) { remember(); onChange(v); draw(); } else input.value = value; });
      input.addEventListener('keydown', (e) => e.stopPropagation());
      return h('label', { class: 'sketch-field' }, h('span', {}, label), input);
    };
    function panel() {
      clear(side);
      const it = items.find((i) => i.id === selected);
      const depthField = num('Height (mm)', depth, (v) => { depth = v; }, { min: 0.2 });
      side.append(h('h4', {}, 'Pull up'), depthField);
      if (!it) {
        side.append(h('h4', {}, 'Selected shape'), h('div', { class: 'insp-note' }, items.length ? 'Pick the arrow tool and click a shape to type its exact size.' : 'Draw a rectangle, circle or polygon. Sizes snap to the grid; hold Alt for free placement.'));
        return;
      }
      side.append(h('h4', {}, it.type === 'rect' ? 'Rectangle' : it.type === 'circle' ? 'Circle' : `Polygon (${it.pts.length} points)`));
      if (it.type === 'rect') side.append(num('Width', it.w, (v) => { it.w = v; }, { min: 0.1 }), num('Height', it.h, (v) => { it.h = v; }, { min: 0.1 }), num('Left', it.x, (v) => { it.x = v; }), num('Bottom', it.y, (v) => { it.y = v; }));
      else if (it.type === 'circle') side.append(num('Diameter', it.r * 2, (v) => { it.r = v / 2; }, { min: 0.1 }), num('Centre X', it.cx, (v) => { it.cx = v; }), num('Centre Y', it.cy, (v) => { it.cy = v; }));
      else {
        const list = h('div', { class: 'sketch-points' });
        it.pts.forEach((p, i) => list.append(h('div', { class: 'sketch-point' }, h('span', {}, String(i + 1)), num('X', p[0], (v) => { it.pts[i] = [v, it.pts[i][1]]; }), num('Y', p[1], (v) => { it.pts[i] = [it.pts[i][0], v]; }))));
        side.append(list);
      }
      const cut = h('input', { type: 'checkbox', checked: !!it.cut });
      cut.addEventListener('change', () => { remember(); it.cut = cut.checked; draw(); });
      side.append(h('label', { class: 'check' }, cut, 'Cut out (removes material)'),
        button({ label: 'Delete shape', icon: 'trash', cls: 'btn-outline', onClick: () => { remember(); items = items.filter((i) => i.id !== it.id); selected = null; panel(); draw(); } }));
    }

    // ---- toolbar
    const tools = [['select', 'Select / move'], ['rect', 'Rectangle'], ['circle', 'Circle'], ['poly', 'Polygon']];
    const toolBtns = tools.map(([id, label]) => button({ label, cls: 'btn-outline' + (id === tool ? ' active' : ''), onClick: () => setTool(id) }));
    const setTool = (id) => { tool = id; draft = null; toolBtns.forEach((b, i) => b.classList.toggle('active', tools[i][0] === id)); draw(); };
    const sheetSel = h('select', { class: 'input', title: 'How much area the drawing sheet shows' }, ...SHEETS.map((s) => h('option', { value: s }, `${s} mm sheet`)));
    sheetSel.value = String(sheet);
    sheetSel.addEventListener('change', () => { sheet = +sheetSel.value; draw(); });
    const snapSel = h('select', { class: 'input', title: 'Grid snap' }, ...[[0, 'Snap off'], [0.5, 'Snap 0.5 mm'], [1, 'Snap 1 mm'], [5, 'Snap 5 mm']].map(([v, l]) => h('option', { value: v }, l)));
    snapSel.value = String(snap);
    snapSel.addEventListener('change', () => { snap = +snapSel.value; });

    const done = () => {
      if (draft && draft.type === 'poly') finishPoly();
      const polys = sketchPolys(items);
      if (!polys) { toast(items.length ? 'The cut-outs remove everything' : 'Draw something first'); return; }
      result = { polys, depth, sketch: { items: items.map(({ id, ...rest }) => { void id; return rest; }), depth, sheet } };
      m.close();
    };

    m.body.append(
      h('div', { class: 'scribble-bar' }, ...toolBtns, h('span', { class: 'sep' }), snapSel, sheetSel, h('span', { style: { flex: 1 } }),
        button({ label: 'Undo', icon: 'undo', cls: 'btn-outline', onClick: () => { const s = undo.pop(); if (s) { items = JSON.parse(s); selected = null; panel(); draw(); } } })),
      h('div', { class: 'sketch-main' }, canvas, side),
      h('div', { class: 'insp-note' }, 'Polygon: click each corner, then click the first point again (or press Enter) to close it. Mark a shape as a cut-out to make a hole or a notch.'),
      h('div', { class: 'modal-actions' },
        button({ label: 'Cancel', cls: 'btn-outline', onClick: () => m.close() }),
        button({ label: 'Make 3D shape', cls: 'btn-primary', onClick: done })));
    panel(); draw();
    // exposed for automated checks
    m.el.__sketch = { add: (it) => { items.push({ ...it, id: nextId++ }); panel(); draw(); }, done, items: () => items };
  });
}
