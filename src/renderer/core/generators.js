// Parametric generators: functional parts built directly with the solid kernel, so every
// result is a closed, printable mesh. Dimensions are real millimetres at scale 1.
import * as THREE from 'three';
import { kernel, fromSolid } from './solid.js';

const R = (key, label, min, max, step, def) => ({ key, label, type: 'range', min, max, step, def });
const S = (key, label, options, def) => ({ key, label, type: 'select', options, def });

/** Run a kernel build; every intermediate registered with `k()` is freed afterwards. */
function make(fn, fallback = [20, 20, 20]) {
  const api = kernel();
  if (!api) return new THREE.BoxGeometry(...fallback);
  const made = [];
  const k = (x) => { made.push(x); return x; };
  try {
    const out = k(fn(api, k));
    if (out.isEmpty() || out.status() !== 'NoError') return new THREE.BoxGeometry(...fallback);
    return fromSolid(out);
  } catch (err) {
    console.warn('Generator failed', err);
    return new THREE.BoxGeometry(...fallback);
  } finally {
    for (const m of new Set(made)) { try { m.delete(); } catch { /* freed */ } }
  }
}

const hexPoints = (acrossFlats) => {
  const r = acrossFlats / 2 / Math.cos(Math.PI / 6);
  return [0, 1, 2, 3, 4, 5].map((i) => [r * Math.cos((i * Math.PI) / 3), r * Math.sin((i * Math.PI) / 3)]);
};

/** Rounded printable thread: an off-centre circle swept along a helix. */
function threadSolid(api, k, diameter, pitch, length) {
  const depth = Math.min(0.6 * pitch, diameter * 0.2);
  const core = diameter / 2 - depth / 2;
  const profile = k(k(api.CrossSection.circle(core, 40)).translate(depth / 2, 0));
  const turns = length / pitch;
  // 24 steps a turn, eased to no fewer than 12 on very long fine threads
  const divisions = Math.max(8, Math.min(Math.ceil(turns * 24), Math.max(900, Math.ceil(turns * 12))));
  return k(api.Manifold.extrude(profile, length, divisions, 360 * turns));
}

/** Cylinder along +Y starting at y0, centred on (x, z). */
function cylY(api, k, radius, y0, len, x, z, segs = 40) {
  return k(k(k(api.Manifold.cylinder(len, radius, radius, segs)).rotate(-90, 0, 0)).translate(x, y0, z));
}

function roundedRect(api, k, w, d, r) {
  const rr = Math.max(0, Math.min(r, Math.min(w, d) / 2 - 0.01));
  if (rr < 0.01) return k(api.CrossSection.square([w, d], true));
  return k(k(api.CrossSection.square([w - 2 * rr, d - 2 * rr], true)).offset(rr, 'Round', 2, 32));
}

export const GENERATOR_KINDS = {
  bolt: {
    name: 'Bolt',
    params: [R('diameter', 'Diameter (mm)', 3, 30, 0.5, 8), R('pitch', 'Thread pitch (mm)', 0.8, 5, 0.05, 1.5), R('length', 'Thread length (mm)', 4, 120, 1, 20), S('head', 'Head', ['hex', 'round', 'none'], 'hex')],
    build: (p) => make((api, k) => {
      const d = p.diameter, len = p.length;
      const rod = threadSolid(api, k, d, p.pitch, len);
      if (p.head === 'none') return rod;
      const hh = Math.max(2, d * 0.65);
      const head = p.head === 'round' ? k(api.Manifold.cylinder(hh, d * 0.85, d * 0.85, 48)) : k(api.Manifold.extrude([hexPoints(d * 1.6)], hh));
      return k(head.add(k(rod.translate(0, 0, hh - 0.01))));
    }),
  },
  nut: {
    name: 'Nut',
    params: [R('diameter', 'Thread diameter (mm)', 3, 30, 0.5, 8), R('pitch', 'Thread pitch (mm)', 0.8, 5, 0.05, 1.5), R('height', 'Height (mm)', 2, 30, 0.5, 6.5), R('clearance', 'Clearance (mm)', 0, 0.8, 0.05, 0.3)],
    build: (p) => make((api, k) => {
      const body = k(api.Manifold.extrude([hexPoints(p.diameter * 1.7)], p.height));
      const cutter = k(threadSolid(api, k, p.diameter + 2 * p.clearance, p.pitch, p.height + 2).translate(0, 0, -1));
      return k(body.subtract(cutter));
    }),
  },
  standoff: {
    name: 'Standoff',
    params: [S('style', 'Style', ['hex', 'round'], 'hex'), R('outer', 'Outer size (mm)', 3, 40, 0.5, 8), R('hole', 'Hole diameter (mm)', 0, 30, 0.1, 3.2), R('height', 'Height (mm)', 1, 100, 0.5, 12)],
    build: (p) => make((api, k) => {
      const body = p.style === 'round' ? k(api.Manifold.cylinder(p.height, p.outer / 2, p.outer / 2, 64)) : k(api.Manifold.extrude([hexPoints(p.outer)], p.height));
      const hole = Math.min(p.hole, p.outer - 1);
      if (hole < 0.2) return body;
      return k(body.subtract(k(k(api.Manifold.cylinder(p.height + 2, hole / 2, hole / 2, 40)).translate(0, 0, -1))));
    }),
  },
  hinge: {
    name: 'Hinge',
    params: [R('width', 'Width (mm)', 10, 150, 1, 40), R('leaf', 'Leaf length (mm)', 6, 80, 1, 20), R('thickness', 'Thickness (mm)', 1.2, 8, 0.1, 2.4), R('knuckles', 'Knuckles', 3, 9, 2, 5), R('pin', 'Pin diameter (mm)', 1, 6, 0.05, 1.75), R('clearance', 'Clearance (mm)', 0.1, 0.8, 0.05, 0.3)],
    build: (p) => make((api, k) => {
      const W = p.width, L = p.leaf, t = p.thickness, c = p.clearance;
      const n = Math.max(3, Math.round(p.knuckles) | 1);
      const Rk = Math.max(t, p.pin / 2 + c + 1.4);
      const seg = W / n;
      const leaves = [];
      for (const side of [0, 1]) {
        const sign = side ? 1 : -1;
        let leaf = k(k(api.Manifold.cube([L, W, t])).translate(side ? Rk + c : -L - Rk - c, 0, 0));
        for (let i = 0; i < n; i++) {
          if (i % 2 !== side) continue;
          const y0 = i * seg + (i ? c / 2 : 0), y1 = (i + 1) * seg - (i < n - 1 ? c / 2 : 0);
          const barrel = cylY(api, k, Rk, y0, y1 - y0, 0, Rk);
          // a web ties the barrel to its leaf
          const web = k(k(api.Manifold.cube([Rk + c + 0.02, y1 - y0, Math.min(t, Rk)])).translate(side ? 0 : -(Rk + c + 0.02), y0, 0));
          leaf = k(k(leaf.add(barrel)).add(web));
        }
        leaves.push(leaf);
        void sign;
      }
      const both = k(api.Manifold.compose(leaves));
      const hole = cylY(api, k, p.pin / 2 + c / 2, -1, W + 2, 0, Rk, 32);
      return k(both.subtract(hole));
    }, [40, 40, 4]),
  },
  snapclip: {
    name: 'Snap Clip',
    params: [R('length', 'Arm length (mm)', 5, 80, 0.5, 18), R('width', 'Width (mm)', 2, 40, 0.5, 6), R('thickness', 'Arm thickness (mm)', 0.8, 6, 0.1, 1.6), R('hook', 'Hook height (mm)', 0.4, 6, 0.1, 1.4), R('base', 'Base length (mm)', 0, 30, 0.5, 6)],
    build: (p) => make((api, k) => {
      const L = p.length, t = p.thickness, hk = p.hook, b = p.base;
      const hl = Math.min(Math.max(hk * 2, 2.5), L); // the hook cannot be longer than the arm it sits on
      const baseH = t + hk + 1.5;
      const pts = [[-b, 0], [L, 0], [L, t + 0.2 * hk], [L - 0.6 * hl, t + hk], [L - hl, t + hk], [L - hl, t], [0, t]];
      if (b > 0) pts.push([0, baseH], [-b, baseH]);
      // drawn in X-Y as the side view, then stood up so the arm runs along X and flexes in Z
      return k(k(api.Manifold.extrude([pts], p.width)).rotate(90, 0, 0));
    }, [20, 6, 4]),
  },
  lidbox: {
    name: 'Box with Lid',
    params: [R('width', 'Width (mm)', 10, 250, 1, 60), R('depth', 'Depth (mm)', 10, 250, 1, 40), R('height', 'Height (mm)', 5, 200, 1, 30), R('wall', 'Wall (mm)', 0.8, 6, 0.1, 1.6), R('radius', 'Corner radius (mm)', 0, 30, 0.5, 4), R('lip', 'Lid lip (mm)', 1, 20, 0.5, 4), R('clearance', 'Lid clearance (mm)', 0, 1, 0.05, 0.2), S('part', 'Part', ['both', 'box', 'lid'], 'both')],
    build: (p) => make((api, k) => {
      const W = p.width, D = p.depth, H = p.height, w = Math.min(p.wall, Math.min(W, D) / 4, H - 0.4), r = p.radius, c = p.clearance;
      const outer = roundedRect(api, k, W, D, r);
      const inner = roundedRect(api, k, W - 2 * w, D - 2 * w, Math.max(0, r - w));
      const box = k(k(api.Manifold.extrude(outer, H)).subtract(k(k(api.Manifold.extrude(inner, H)).translate(0, 0, w))));
      const lipOuter = roundedRect(api, k, W - 2 * w - 2 * c, D - 2 * w - 2 * c, Math.max(0, r - w - c));
      // on a small box with thick walls there is no room for a hollow lip: it is left solid
      const iw = W - 4 * w - 2 * c, id = D - 4 * w - 2 * c;
      let ring = k(api.Manifold.extrude(lipOuter, p.lip));
      if (iw > 0.2 && id > 0.2) ring = k(ring.subtract(k(k(api.Manifold.extrude(roundedRect(api, k, iw, id, Math.max(0, r - 2 * w - c)), p.lip + 2)).translate(0, 0, -1))));
      ring = k(ring.translate(0, 0, w - 0.01));
      const lid = k(k(api.Manifold.extrude(outer, w)).add(ring));
      if (p.part === 'box') return box;
      if (p.part === 'lid') return lid;
      return k(api.Manifold.compose([box, k(lid.translate(W + 8, 0, 0))]));
    }, [60, 40, 30]),
  },
};

export const GENERATOR_CATALOG = [
  ['bolt', 'Bolt', '#90a4ae'], ['nut', 'Nut', '#90a4ae'], ['standoff', 'Standoff', '#b0bec5'],
  ['hinge', 'Hinge', '#546e7a'], ['snapclip', 'Snap Clip', '#e07a5f'], ['lidbox', 'Box with Lid', '#3fa7a3'],
];
