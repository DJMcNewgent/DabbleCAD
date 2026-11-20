// Geometry operations for the laser workspace: booleans, offsets, image dithering.
import ClipperLib from 'clipper-lib';

const S = 1000; // clipper works on integers: 1 unit = 1 micron
const toC = (pts) => pts.map((p) => ({ X: Math.round(p[0] * S), Y: Math.round(p[1] * S) }));
const fromC = (path) => path.map((p) => [p.X / S, p.Y / S]);

/** Resolve one shape's outlines (even-odd, e.g. letters with counters) into clean polygons. */
function normalize(polys) {
  const paths = polys.filter((p) => p.closed && p.pts.length > 2).map((p) => toC(p.pts));
  if (!paths.length) return [];
  return ClipperLib.Clipper.SimplifyPolygons(paths, ClipperLib.PolyFillType.pftEvenOdd);
}

/**
 * groups: one entry per shape, each a list of { pts, closed }.
 * op: 'union' | 'subtract' (first minus the rest) | 'intersect' | 'xor'
 */
export function booleanOp(groups, op) {
  const all = groups.map(normalize);
  // subtract keeps its meaning only if the first operand survives
  if (op === 'subtract' && !(all[0] && all[0].length)) return [];
  const sets = all.filter((s) => s.length);
  if (!sets.length) return [];
  const nz = ClipperLib.PolyFillType.pftNonZero;
  const run = (subject, clip, type) => {
    const c = new ClipperLib.Clipper();
    c.AddPaths(subject, ClipperLib.PolyType.ptSubject, true);
    if (clip.length) c.AddPaths(clip, ClipperLib.PolyType.ptClip, true);
    const sol = new ClipperLib.Paths();
    c.Execute(type, sol, nz, nz);
    return sol;
  };
  let result;
  if (op === 'union') {
    result = run(sets.flat(), [], ClipperLib.ClipType.ctUnion);
  } else if (op === 'subtract') {
    result = run(sets[0], sets.slice(1).flat(), ClipperLib.ClipType.ctDifference);
  } else {
    const type = op === 'intersect' ? ClipperLib.ClipType.ctIntersection : ClipperLib.ClipType.ctXor;
    result = sets[0];
    for (let i = 1; i < sets.length; i++) result = run(result, sets[i], type);
  }
  return result.filter((p) => p.length > 2).map((p) => ({ pts: fromC(p), closed: true }));
}

/** Offset outlines by delta mm (negative = inwards). style: 'round' | 'miter' | 'bevel'. */
export function offsetPolys(polys, delta, style = 'round') {
  const co = new ClipperLib.ClipperOffset(4, 0.02 * S);
  const join = style === 'miter' ? ClipperLib.JoinType.jtMiter : style === 'bevel' ? ClipperLib.JoinType.jtSquare : ClipperLib.JoinType.jtRound;
  const closed = normalize(polys);
  if (closed.length) co.AddPaths(closed, join, ClipperLib.EndType.etClosedPolygon);
  for (const p of polys) if (!p.closed && p.pts.length > 1 && delta > 0) co.AddPath(toC(p.pts), join, ClipperLib.EndType.etOpenRound);
  const sol = new ClipperLib.Paths();
  co.Execute(sol, delta * S);
  return sol.filter((p) => p.length > 2).map((p) => ({ pts: fromC(p), closed: true }));
}

// ---------------------------------------------------------------- images
export const IMAGE_MODES = [
  ['threshold', 'Threshold'], ['ordered', 'Ordered dither'], ['floyd', 'Floyd-Steinberg'], ['jarvis', 'Jarvis'],
  ['stucki', 'Stucki'], ['atkinson', 'Atkinson'], ['halftone', 'Halftone (dots)'], ['newsprint', 'Newsprint (coarse dots)'], ['grayscale', 'Grayscale'],
];

const KERNELS = {
  floyd: { div: 16, k: [[1, 0, 7], [-1, 1, 3], [0, 1, 5], [1, 1, 1]] },
  jarvis: { div: 48, k: [[1, 0, 7], [2, 0, 5], [-2, 1, 3], [-1, 1, 5], [0, 1, 7], [1, 1, 5], [2, 1, 3], [-2, 2, 1], [-1, 2, 3], [0, 2, 5], [1, 2, 3], [2, 2, 1]] },
  stucki: { div: 42, k: [[1, 0, 8], [2, 0, 4], [-2, 1, 2], [-1, 1, 4], [0, 1, 8], [1, 1, 4], [2, 1, 2], [-2, 2, 1], [-1, 2, 2], [0, 2, 4], [1, 2, 2], [2, 2, 1]] },
  atkinson: { div: 8, k: [[1, 0, 1], [2, 0, 1], [-1, 1, 1], [0, 1, 1], [1, 1, 1], [0, 2, 1]] },
};
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/**
 * RGBA pixels -> burn amount per pixel (0 = no burn, 255 = full power).
 * Transparent pixels never burn.
 */
export function processImage(imageData, opts = {}) {
  const { mode = 'floyd', negative = false, brightness = 0, contrast = 0, gamma = 1, pxPerMM = 10 } = opts;
  const { data, width: w, height: h } = imageData;
  const lum = new Float32Array(w * h);
  const alpha = new Uint8Array(w * h);
  const cf = (259 * (contrast * 2.55 + 255)) / (255 * (259 - contrast * 2.55));
  for (let i = 0, p = 0; p < w * h; i += 4, p++) {
    const a = data[i + 3] / 255;
    let v = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    v = v * a + 255 * (1 - a);
    v = cf * (v - 128) + 128 + brightness * 2.55;
    v = 255 * Math.pow(Math.max(0, Math.min(255, v)) / 255, 1 / (gamma || 1));
    if (negative) v = 255 - v;
    lum[p] = v;
    alpha[p] = data[i + 3] > 8 ? 1 : 0;
  }
  const out = new Uint8Array(w * h);
  if (mode === 'grayscale') {
    for (let p = 0; p < w * h; p++) out[p] = alpha[p] ? Math.round(255 - lum[p]) : 0;
  } else if (mode === 'halftone' || mode === 'newsprint') {
    // round dots on a grid turned 45 degrees; a darker pixel gets a bigger dot
    const cell = Math.max(3, (mode === 'newsprint' ? 2 : 1) * pxPerMM), k = Math.SQRT1_2;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (!alpha[p]) { out[p] = 0; continue; }
      const u = ((x + y) * k) / cell, v = ((y - x) * k) / cell;
      const fu = u - Math.floor(u) - 0.5, fv = v - Math.floor(v) - 0.5;
      const dark = 1 - lum[p] / 255;
      // a smooth "spot function": the dot covers the same share of its cell as the pixel is dark
      out[p] = dark >= 1 || (Math.cos(2 * Math.PI * fu) + Math.cos(2 * Math.PI * fv)) / 4 + 0.5 > 1 - dark ? 255 : 0;
    }
  } else if (mode === 'threshold') {
    for (let p = 0; p < w * h; p++) out[p] = alpha[p] && lum[p] < 128 ? 255 : 0;
  } else if (mode === 'ordered') {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = y * w + x;
      out[p] = alpha[p] && lum[p] < (BAYER[(y & 3) * 4 + (x & 3)] + 0.5) * 16 ? 255 : 0;
    }
  } else {
    const kern = KERNELS[mode] || KERNELS.floyd;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const old = lum[p], val = old < 128 ? 0 : 255, err = old - val;
      out[p] = alpha[p] && val === 0 ? 255 : 0;
      for (const [dx, dy, wgt] of kern.k) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && nx < w && ny < h) lum[ny * w + nx] += (err * wgt) / kern.div;
      }
    }
  }
  return out;
}

/** Trace helper: burn map -> boolean mask at a threshold. */
export function maskFromImage(imageData, threshold = 128, negative = false) {
  const burn = processImage(imageData, { mode: 'grayscale', negative });
  const mask = new Uint8Array(burn.length);
  for (let i = 0; i < burn.length; i++) mask[i] = burn[i] > 255 - threshold ? 1 : 0;
  return mask;
}
