// Font registry for 3D text. Two faces are bundled; on the desktop every installed
// TrueType / OpenType font can be loaded on demand.
import * as THREE from 'three';
import opentype from 'opentype.js';
import robotoRegular from '@fontsource/roboto/files/roboto-latin-400-normal.woff?inline';
import robotoBold from '@fontsource/roboto/files/roboto-latin-700-normal.woff?inline';
import { platform } from '../platform.js';

export const BUILTIN_FONTS = ['Sans', 'Sans Bold'];
const fonts = new Map();
let systemFonts = [];

function dataUrlToBuffer(url) {
  const bin = atob(url.slice(url.indexOf(',') + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

export async function initFonts() {
  fonts.set('Sans', opentype.parse(dataUrlToBuffer(robotoRegular)));
  fonts.set('Sans Bold', opentype.parse(dataUrlToBuffer(robotoBold)));
  try { systemFonts = await platform.listFonts(); } catch { systemFonts = []; }
}

export const listFontNames = () => [...BUILTIN_FONTS, ...systemFonts];
export const hasFont = (name) => fonts.has(name);

export async function ensureFont(name) {
  if (fonts.has(name)) return true;
  try {
    const buf = await platform.loadFont(name);
    if (!buf) return false;
    fonts.set(name, opentype.parse(buf));
    return true;
  } catch (err) {
    console.warn('Font failed to load:', name, err);
    return false;
  }
}

// Simple left-to-right layout with pair kerning. Glyphs are laid out one by one
// (rather than through font.getPath) so fonts with unsupported substitution tables still work.
function layoutLine(font, line, size) {
  const scale = size / font.unitsPerEm;
  const glyphs = [];
  let x = 0, prev = null;
  for (const ch of line) {
    const glyph = font.charToGlyph(ch);
    if (prev) { try { x += font.getKerningValue(prev, glyph) * scale; } catch { /* no kerning data */ } }
    glyphs.push({ glyph, x });
    x += (glyph.advanceWidth || font.unitsPerEm * 0.5) * scale;
    prev = glyph;
  }
  return { glyphs, width: x };
}

/** Build THREE.Shape[] for a (possibly multi-line) string. size = em height in mm. */
export function textShapes(text, fontName, size = 10, align = 'left') {
  const font = fonts.get(fontName) || fonts.get('Sans');
  const lines = String(text || ' ').split(/\r?\n/).map((l) => layoutLine(font, l, size));
  const lineHeight = size * 1.2;
  const maxW = Math.max(...lines.map((l) => l.width), 0);
  const shapePath = new THREE.ShapePath();
  lines.forEach((line, i) => {
    const ox = align === 'center' ? (maxW - line.width) / 2 : align === 'right' ? maxW - line.width : 0;
    for (const { glyph, x } of line.glyphs) {
      const path = glyph.getPath(ox + x, i * lineHeight, size);
      for (const c of path.commands) {
        if (c.type === 'M') shapePath.moveTo(c.x, -c.y);
        else if (c.type === 'L') shapePath.lineTo(c.x, -c.y);
        else if (c.type === 'Q') shapePath.quadraticCurveTo(c.x1, -c.y1, c.x, -c.y);
        else if (c.type === 'C') shapePath.bezierCurveTo(c.x1, -c.y1, c.x2, -c.y2, c.x, -c.y);
        else if (c.type === 'Z' && shapePath.currentPath) shapePath.currentPath.closePath();
      }
    }
  });
  if (!shapePath.subPaths.length) return [];
  return shapePath.toShapes();
}

/**
 * Flattened outlines of a string for 2D work (laser): [{ pts: [[x, y]...], closed: true }].
 * Y grows downwards and the result is shifted so its bounding box starts at (0, 0).
 */
export function textContours(text, fontName, size = 10, align = 'left', spacing = 0) {
  const font = fonts.get(fontName) || fonts.get('Sans');
  const lines = String(text || ' ').split(/\r?\n/).map((l) => layoutLine(font, l, size));
  const lineHeight = size * 1.2;
  const maxW = Math.max(...lines.map((l) => l.width + spacing * Math.max(0, l.glyphs.length - 1)), 0);
  const polys = [];
  let cur = null, last = [0, 0];
  const flush = () => { if (cur && cur.length > 2) polys.push({ pts: cur, closed: true }); cur = null; };
  lines.forEach((line, i) => {
    const w = line.width + spacing * Math.max(0, line.glyphs.length - 1);
    const ox = align === 'center' ? (maxW - w) / 2 : align === 'right' ? maxW - w : 0;
    line.glyphs.forEach(({ glyph, x }, gi) => {
      const path = glyph.getPath(ox + x + gi * spacing, i * lineHeight, size);
      for (const c of path.commands) {
        if (c.type === 'M') { flush(); cur = [[c.x, c.y]]; last = [c.x, c.y]; }
        else if (c.type === 'L') { cur.push([c.x, c.y]); last = [c.x, c.y]; }
        else if (c.type === 'Q') {
          for (let k = 1; k <= 8; k++) { const t = k / 8, u = 1 - t; cur.push([u * u * last[0] + 2 * u * t * c.x1 + t * t * c.x, u * u * last[1] + 2 * u * t * c.y1 + t * t * c.y]); }
          last = [c.x, c.y];
        } else if (c.type === 'C') {
          for (let k = 1; k <= 12; k++) {
            const t = k / 12, u = 1 - t;
            cur.push([u * u * u * last[0] + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t * t * t * c.x, u * u * u * last[1] + 3 * u * u * t * c.y1 + 3 * u * t * t * c.y2 + t * t * t * c.y]);
          }
          last = [c.x, c.y];
        } else if (c.type === 'Z') flush();
      }
      flush();
    });
  });
  let minX = Infinity, minY = Infinity;
  for (const p of polys) for (const q of p.pts) { if (q[0] < minX) minX = q[0]; if (q[1] < minY) minY = q[1]; }
  if (minX === Infinity) return [];
  for (const p of polys) {
    for (const q of p.pts) { q[0] -= minX; q[1] -= minY; }
    const f = p.pts[0], l = p.pts[p.pts.length - 1];
    if (Math.abs(f[0] - l[0]) < 1e-9 && Math.abs(f[1] - l[1]) < 1e-9) p.pts.pop();
  }
  return polys;
}
