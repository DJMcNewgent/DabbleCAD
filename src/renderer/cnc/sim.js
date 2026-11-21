// Material removal simulation. The top of the stock is a grid of heights; every cutting move
// presses the shape of the bit into it.
import { toolProfile } from './cam.js';

export class Simulator {
  /** stock: { x0, y0, w, h, t } in job coordinates (x0, y0 = lower-left corner). */
  constructor(stock, maxCells = 420) {
    this.stock = stock;
    this.cell = Math.max(stock.w, stock.h) / maxCells;
    this.nx = Math.max(2, Math.round(stock.w / this.cell) + 1);
    this.ny = Math.max(2, Math.round(stock.h / this.cell) + 1);
    this.H = new Float32Array(this.nx * this.ny);
    this.kernels = new Map();
    this.reset();
  }

  reset() { this.H.fill(0); this.pos = null; this.done = 0; this.dirty = true; }

  _kernel(tool) {
    const key = [tool.type, tool.dia, tool.angle || 0, tool.tip || 0].join('|');
    let k = this.kernels.get(key);
    if (k) return k;
    const r = tool.dia / 2, n = Math.ceil(r / this.cell);
    const list = [];
    for (let j = -n; j <= n; j++) for (let i = -n; i <= n; i++) {
      // a cell is cut when its centre is under the bit (half a cell of slack so thin bits still show)
      const d = Math.max(0, Math.hypot(i, j) * this.cell - this.cell * 0.5);
      const f = toolProfile(tool, d);
      if (isFinite(f) && f < this.stock.t + 1) list.push(i, j, f);
    }
    k = new Float32Array(list);
    k.reach = n + 1; // how many cells the bit reaches from its centre
    this.kernels.set(key, k);
    return k;
  }

  _stamp(k, x, y, z) {
    const { nx, ny, H, cell, stock } = this;
    const ci = Math.round((x - stock.x0) / cell), cj = Math.round((y - stock.y0) / cell);
    if (ci < -k.reach || cj < -k.reach || ci > nx + k.reach || cj > ny + k.reach) return;
    const floor = -stock.t;
    for (let q = 0; q < k.length; q += 3) {
      const i = ci + k[q], j = cj + k[q + 1];
      if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
      const v = Math.max(floor, z + k[q + 2]), idx = j * nx + i;
      if (v < H[idx]) H[idx] = v;
    }
  }

  /** Carry out events[from..to). `sections` gives the bit for each section. */
  run(events, sections, to = events.length) {
    const { cell } = this;
    for (; this.done < to && this.done < events.length; this.done++) {
      const e = events[this.done];
      if (e.t !== 'move') continue;
      const p = [e.x ?? (this.pos ? this.pos[0] : NaN), e.y ?? (this.pos ? this.pos[1] : NaN), e.z];
      if (!e.rapid && this.pos && isFinite(this.pos[0]) && (p[2] < 0 || this.pos[2] < 0)) {
        const k = this._kernel(sections[e.s].tool);
        const a = this.pos, len = Math.hypot(p[0] - a[0], p[1] - a[1]);
        const steps = Math.max(1, Math.ceil(len / (cell * 0.7)));
        for (let s = len < 1e-9 ? steps : 0; s <= steps; s++) {
          const t = s / steps;
          const z = a[2] + (p[2] - a[2]) * t;
          if (z < 0) this._stamp(k, a[0] + (p[0] - a[0]) * t, a[1] + (p[1] - a[1]) * t, z);
        }
        this.dirty = true;
      }
      this.pos = p;
    }
    return this.done;
  }
}
