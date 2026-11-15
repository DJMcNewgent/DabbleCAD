// Scribble: freehand drawing that becomes an extruded shape.
import { h, modal, button, toast } from './dom.js';
import { traceMask } from '../core/trace.js';
import { polysBounds } from '../core/trace.js';

const W = 720, H = 460, MM_PER_PX = 0.22;

/** Opens the scribble editor. Resolves to { polys, image } or null. */
export function scribbleDialog(existingImage) {
  return new Promise((resolve) => {
    let result = null;
    const m = modal({ title: 'Scribble', width: W + 38, onClose: () => resolve(result) });
    const canvas = h('canvas', { class: 'scribble-canvas', width: W, height: H });
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    let mode = 'draw', size = 14, drawing = false, last = null;
    const undo = [];
    const snapshot = () => { undo.push(ctx.getImageData(0, 0, W, H)); if (undo.length > 30) undo.shift(); };

    if (existingImage) {
      const img = new Image();
      img.onload = () => ctx.drawImage(img, 0, 0, W, H);
      img.src = existingImage;
    }

    const pos = (e) => { const r = canvas.getBoundingClientRect(); return [(e.clientX - r.left) * (W / r.width), (e.clientY - r.top) * (H / r.height)]; };
    const stroke = (a, b) => {
      ctx.globalCompositeOperation = mode === 'erase' ? 'destination-out' : 'source-over';
      ctx.strokeStyle = '#1b6fd8'; ctx.fillStyle = '#1b6fd8';
      ctx.lineWidth = size; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    };
    canvas.addEventListener('pointerdown', (e) => {
      try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
      snapshot();
      drawing = true;
      last = pos(e);
      stroke(last, [last[0] + 0.01, last[1] + 0.01]);
    });
    canvas.addEventListener('pointermove', (e) => { if (!drawing) return; const p = pos(e); stroke(last, p); last = p; });
    const end = () => { drawing = false; };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);

    const drawBtn = button({ label: 'Draw', icon: 'pencil', cls: 'btn-outline active', onClick: () => setMode('draw') });
    const eraseBtn = button({ label: 'Erase', icon: 'trash', cls: 'btn-outline', onClick: () => setMode('erase') });
    const setMode = (v) => { mode = v; drawBtn.classList.toggle('active', v === 'draw'); eraseBtn.classList.toggle('active', v === 'erase'); };
    const sizeInput = h('input', { type: 'range', min: 3, max: 60, step: 1, value: size, title: 'Brush size' });
    sizeInput.addEventListener('input', () => { size = +sizeInput.value; });
    const fillBtn = button({ label: 'Fill inside', cls: 'btn-outline', title: 'Fill enclosed areas so closed outlines become solid', onClick: () => { snapshot(); fillEnclosed(); } });

    function fillEnclosed() {
      const img = ctx.getImageData(0, 0, W, H);
      const d = img.data;
      const outside = new Uint8Array(W * H);
      const stack = [];
      const push = (x, y) => { if (x < 0 || y < 0 || x >= W || y >= H) return; const i = y * W + x; if (outside[i] || d[i * 4 + 3] > 100) return; outside[i] = 1; stack.push(i); };
      for (let x = 0; x < W; x++) { push(x, 0); push(x, H - 1); }
      for (let y = 0; y < H; y++) { push(0, y); push(W - 1, y); }
      while (stack.length) { const i = stack.pop(); const x = i % W, y = (i / W) | 0; push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1); }
      for (let i = 0; i < W * H; i++) if (!outside[i]) { d[i * 4] = 27; d[i * 4 + 1] = 111; d[i * 4 + 2] = 216; d[i * 4 + 3] = 255; }
      ctx.putImageData(img, 0, 0);
    }

    const done = () => {
      const img = ctx.getImageData(0, 0, W, H);
      const mask = new Uint8Array(W * H);
      let any = false;
      for (let i = 0; i < W * H; i++) if (img.data[i * 4 + 3] > 100) { mask[i] = 1; any = true; }
      if (!any) { toast('Draw something first'); return; }
      let polys = traceMask(mask, W, H, { scale: MM_PER_PX, smooth: 2, epsilon: 1.1 });
      if (!polys.length) { toast('Draw something a little bigger'); return; }
      const b = polysBounds(polys);
      const cx = b.minX + b.width / 2, cy = b.minY + b.height / 2;
      const shift = (p) => [p[0] - cx, p[1] - cy];
      polys = polys.map((poly) => ({ outer: poly.outer.map(shift), holes: poly.holes.map((hh) => hh.map(shift)) }));
      result = { polys, image: canvas.toDataURL('image/png') };
      m.close();
    };

    m.body.append(
      h('div', { class: 'scribble-bar' }, drawBtn, eraseBtn, h('span', { class: 'sep' }), h('span', {}, 'Brush'), sizeInput, fillBtn,
        h('span', { class: 'spacer', style: { flex: 1 } }),
        button({ label: 'Undo', icon: 'undo', cls: 'btn-outline', onClick: () => { const s = undo.pop(); if (s) ctx.putImageData(s, 0, 0); } }),
        button({ label: 'Clear', cls: 'btn-outline', onClick: () => { snapshot(); ctx.clearRect(0, 0, W, H); } })),
      canvas,
      h('div', { class: 'modal-actions' },
        button({ label: 'Cancel', cls: 'btn-outline', onClick: () => m.close() }),
        button({ label: 'Done', cls: 'btn-primary', onClick: done })));
  });
}
