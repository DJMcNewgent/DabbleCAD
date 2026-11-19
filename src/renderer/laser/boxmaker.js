// Box maker: finger-jointed panels for a laser-cut box, laid out flat on the bed.
import { h, modal, button, toast } from '../ui/dom.js';
import { booleanOp, offsetPolys } from './ops.js';
import { pathFromPolys, translate } from './model.js';

const rect = (x0, y0, x1, y1) => ({ closed: true, pts: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] });
const fingers = (len, target) => { let n = Math.max(3, Math.round(len / target)); if (n % 2 === 0) n += 1; return n; };

/**
 * One panel outline. `edges` gives, for bottom / right / top / left, either null (straight)
 * or 'out' / 'in': whether the fingers at the two ends of that edge stick out or are notched.
 */
function panel(w, hh, t, target, edges, kerf) {
  const slots = [];
  const cut = (len, mode, make) => {
    if (!mode) return;
    const n = fingers(len, target), f = len / n;
    for (let i = 0; i < n; i++) {
      const isIn = mode === 'in' ? i % 2 === 0 : i % 2 === 1;
      if (isIn) slots.push(make(i * f, (i + 1) * f));
    }
  };
  // slots overshoot the outline slightly so the subtraction leaves no slivers
  const e = 0.01;
  cut(w, edges.bottom, (a, b) => rect(a - (a === 0 ? e : 0), -e, b + (Math.abs(b - w) < 1e-9 ? e : 0), t));
  cut(w, edges.top, (a, b) => rect(a - (a === 0 ? e : 0), hh - t, b + (Math.abs(b - w) < 1e-9 ? e : 0), hh + e));
  cut(hh, edges.left, (a, b) => rect(-e, a - (a === 0 ? e : 0), t, b + (Math.abs(b - hh) < 1e-9 ? e : 0)));
  cut(hh, edges.right, (a, b) => rect(w - t, a - (a === 0 ? e : 0), w + e, b + (Math.abs(b - hh) < 1e-9 ? e : 0)));
  // corner notches overlap, so weld the slots into clean outlines before cutting them away
  let polys = slots.length ? booleanOp([[rect(0, 0, w, hh)], booleanOp(slots.map((r) => [r]), 'union')], 'subtract') : [rect(0, 0, w, hh)];
  // grow by half the kerf so the parts come out at their drawn size and the joints stay snug
  if (kerf > 0) polys = offsetPolys(polys, kerf / 2, 'miter');
  return polys;
}

/** Returns [{ name, w, h, polys }] for a box with the given OUTER dimensions. */
export function boxPanels({ width, depth, height, thickness, finger = 10, kerf = 0, lid = false }) {
  const t = thickness, target = Math.max(finger, t * 1.5);
  const cap = { bottom: 'out', right: 'out', top: 'out', left: 'out' };
  const wall = (ends) => ({ bottom: 'in', top: lid ? 'in' : null, left: ends, right: ends });
  const list = [
    { name: 'Bottom', w: width, h: depth, edges: cap },
    { name: 'Front', w: width, h: height, edges: wall('out') },
    { name: 'Back', w: width, h: height, edges: wall('out') },
    { name: 'Left', w: depth, h: height, edges: wall('in') },
    { name: 'Right', w: depth, h: height, edges: wall('in') },
  ];
  if (lid) list.push({ name: 'Top', w: width, h: depth, edges: cap });
  return list.map((p) => ({ name: p.name, w: p.w, h: p.h, polys: panel(p.w, p.h, t, target, p.edges, kerf) }));
}

/** Lay panels out in rows. Returns { placed: [{ panel, x, y }], width, height }. */
export function layoutPanels(panels, maxWidth, gap = 4) {
  const placed = [];
  let x = 0, y = 0, rowH = 0, width = 0;
  for (const p of panels) {
    if (x > 0 && x + p.w > maxWidth) { x = 0; y += rowH + gap; rowH = 0; }
    placed.push({ panel: p, x, y });
    x += p.w + gap; rowH = Math.max(rowH, p.h); width = Math.max(width, x - gap);
  }
  return { placed, width, height: y + rowH };
}

export function boxMakerDialog(ws) {
  const m = modal({ title: 'Box maker', width: 460 });
  m.body.addEventListener('keydown', (e) => { if (e.key !== 'Escape') e.stopPropagation(); });
  const num = (value, step = 1, min = 0) => h('input', { class: 'input', type: 'number', value, step, min });
  const field = (label, control) => h('label', { class: 'field' }, h('span', {}, label), control);
  const v = (input, def) => { const n = parseFloat(input.value); return isFinite(n) ? n : def; };
  const W = num(100), D = num(60), H = num(40), T = num(3, 0.1, 0.5), F = num(10, 1, 2), K = num(0.15, 0.01, 0);
  const dims = h('select', { class: 'select' }, h('option', { value: 'outside' }, 'Outside'), h('option', { value: 'inside' }, 'Inside'));
  const lid = h('select', { class: 'select' }, h('option', { value: 'open' }, 'Open top'), h('option', { value: 'closed' }, 'Closed (with top panel)'));
  const info = h('div', { class: 'insp-note' });

  const read = () => {
    const t = v(T, 3), inside = dims.value === 'inside', closed = lid.value === 'closed';
    const grow = inside ? 2 * t : 0;
    return { width: v(W, 100) + grow, depth: v(D, 60) + grow, height: v(H, 40) + (inside ? t * (closed ? 2 : 1) : 0), thickness: t, finger: v(F, 10), kerf: v(K, 0), lid: closed };
  };
  const check = (o) => {
    if (!(o.thickness >= 0.5)) return 'Enter the material thickness';
    if (Math.min(o.width, o.depth, o.height) < o.thickness * 4) return 'The box is too small for this material thickness';
    return null;
  };
  const refresh = () => {
    const o = read(), bad = check(o);
    if (bad) { info.textContent = bad; return; }
    const lay = layoutPanels(boxPanels(o), ws.machine.bedW - 20);
    const fits = lay.width <= ws.machine.bedW - 20 && lay.height <= ws.machine.bedH - 20;
    info.textContent = `${o.lid ? 6 : 5} panels · outside ${o.width.toFixed(1)} × ${o.depth.toFixed(1)} × ${o.height.toFixed(1)} mm · needs about ${Math.ceil(lay.width)} × ${Math.ceil(lay.height)} mm of sheet${fits ? '' : ' (larger than the bed: move or rotate panels after creating)'}`;
  };
  for (const el of [W, D, H, T, F, K, dims, lid]) el.addEventListener('input', refresh);

  m.body.append(
    h('div', { class: 'row' }, field('Width (mm)', W), field('Depth (mm)', D), field('Height (mm)', H)),
    h('div', { class: 'row' }, field('Sizes are', dims), field('Top', lid)),
    h('div', { class: 'row' }, field('Material thickness (mm)', T), field('Finger width (mm)', F), field('Kerf (mm)', K)),
    info,
    h('div', { class: 'insp-note' }, 'Kerf is the width of material your laser burns away. Cut a small test joint first: raise the kerf if the joint is loose, lower it if it will not go together.'),
    h('div', { class: 'modal-actions' }, button({ label: 'Cancel', cls: 'btn-outline', onClick: () => m.close() }), button({ label: 'Create panels', cls: 'btn-primary', onClick: () => {
      const o = read(), bad = check(o);
      if (bad) { toast(bad, 'warn'); return; }
      const lay = layoutPanels(boxPanels(o), ws.machine.bedW - 20);
      const L = ws.doc.currentLayer;
      const shapes = lay.placed.map(({ panel: p, x, y }) => { const s = pathFromPolys(L, p.polys); s.m = translate(10 + x, 10 + y); s.name = p.name; return s; });
      m.close();
      ws.add(shapes);
      toast(`Added ${shapes.length} panels on the current layer`);
    } })));
  refresh();
  return m;
}
