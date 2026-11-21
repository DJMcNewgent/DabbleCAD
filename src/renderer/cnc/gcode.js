// From cutter paths to machine moves and G-code text, and reading G-code back in for the viewer.
// Internally everything is millimetres with Z = 0 at the top of the material.

export const POSTS = {
  grbl: { name: 'GRBL, grblHAL, FluidNC (OpenBuilds, Shapeoko, X-Carve, 3018 and most hobby machines)', ext: 'gcode', toolChange: 'pause', end: 'M30', dwell: 'P' },
  linuxcnc: { name: 'LinuxCNC', ext: 'ngc', toolChange: 'm6', end: 'M2', dwell: 'P', setup: 'G40 G49 G80 G54' },
  mach: { name: 'Mach3 / Mach4', ext: 'tap', toolChange: 'm6', end: 'M30', dwell: 'P', setup: 'G40 G49 G80 G54', lineNumbers: true },
  marlin: { name: 'Marlin', ext: 'gcode', toolChange: 'pause', end: '', dwell: 'S', semicolons: true },
  generic: { name: 'Generic ISO G-code', ext: 'nc', toolChange: 'm6', end: 'M30', dwell: 'P', setup: 'G40 G49 G80' },
};

export const DEFAULT_OUTPUT = { post: 'grbl', units: 'mm', safeZ: 5, clearZ: 1, rapidRate: 3000, spindle: 'auto', spinUp: 3, coolant: 'off', park: 'none', zOffset: 0 };

export const toolKey = (t) => [t.type, t.dia, t.angle || 0, t.tip || 0, t.name || ''].join('|');
export function toolLabel(t, units = 'mm') {
  if (!t) return 'No bit';
  if (t.name) return t.name;
  const d = units === 'in' ? `${+(t.dia / 25.4).toFixed(4)} in` : `${+t.dia.toFixed(3)} mm`;
  return { end: `${d} end mill`, ball: `${d} ball nose`, vbit: `${t.angle || 60}° V-bit (${d})`, drill: `${d} drill` }[t.type] || `${d} bit`;
}

/**
 * The exact sequence of machine moves for a program. The G-code writer, the time estimate and the
 * simulation all read this one list, so what is previewed is what is cut.
 * program: { sections: [{ tool, feed, plunge, rpm, name, paths: [{ pts, link, dwell }] }] }
 * Returns events: { t: 'section', index } | { t: 'move', x, y, z, rapid, feed, s } | { t: 'dwell', sec }
 */
export function expandMoves(program, opts = {}) {
  const o = { ...DEFAULT_OUTPUT, ...opts };
  const ev = [];
  let pos = null; // unknown until the first retract
  const move = (x, y, z, rapid, feed, s) => {
    if (pos && Math.abs(pos[0] - x) < 1e-6 && Math.abs(pos[1] - y) < 1e-6 && Math.abs(pos[2] - z) < 1e-6) return;
    ev.push({ t: 'move', x, y, z, rapid, feed, s });
    pos = [x, y, z];
  };
  program.sections.forEach((sec, s) => {
    ev.push({ t: 'section', index: s });
    const feed = Math.max(1, sec.feed || 600), plunge = Math.max(1, sec.plunge || feed / 3);
    const cutFeed = (a, b) => {
      const h = Math.hypot(b[0] - a[0], b[1] - a[1]), dz = b[2] - a[2];
      if (dz >= -1e-9) return feed;
      if (h < 1e-9) return plunge;
      return Math.min(feed, (plunge * Math.hypot(h, dz)) / -dz); // never descend faster than the plunge rate
    };
    for (const path of sec.paths) {
      const pts = path.pts;
      if (!pts || !pts.length) continue;
      const first = pts[0];
      if (path.link && pos && pos[2] < o.clearZ) move(first[0], first[1], first[2], false, cutFeed(pos, first), s);
      else {
        if (!pos) { ev.push({ t: 'move', x: null, y: null, z: o.safeZ, rapid: true, feed: 0, s }); pos = [NaN, NaN, o.safeZ]; }
        else if (pos[2] < o.safeZ) move(pos[0], pos[1], o.safeZ, true, 0, s);
        move(first[0], first[1], o.safeZ, true, 0, s);
        const stop = Math.min(o.safeZ, Math.max(first[2], 0) + o.clearZ);
        if (stop < o.safeZ - 1e-9) move(first[0], first[1], stop, true, 0, s);
        if (first[2] < stop - 1e-9) move(first[0], first[1], first[2], false, plunge, s);
      }
      for (let i = 1; i < pts.length; i++) {
        const p = pts[i];
        if (p[3]) move(p[0], p[1], p[2], true, 0, s);
        else move(p[0], p[1], p[2], false, cutFeed(pos, p), s);
      }
      if (path.dwell > 0) ev.push({ t: 'dwell', sec: path.dwell });
    }
    if (pos && pos[2] < o.safeZ) move(pos[0], pos[1], o.safeZ, true, 0, s);
  });
  return ev;
}

/** Time, distance and extents of a move list. */
export function measure(events, opts = {}) {
  const o = { ...DEFAULT_OUTPUT, ...opts };
  const st = { time: 0, cut: 0, rapid: 0, moves: 0, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], deepest: 0 };
  let pos = null;
  for (const e of events) {
    if (e.t === 'dwell') { st.time += e.sec; continue; }
    if (e.t !== 'move') continue;
    const to = [e.x ?? (pos ? pos[0] : 0), e.y ?? (pos ? pos[1] : 0), e.z];
    if (pos && isFinite(pos[0])) {
      const len = Math.hypot(to[0] - pos[0], to[1] - pos[1], to[2] - pos[2]);
      if (e.rapid) { st.rapid += len; st.time += (len / Math.max(1, o.rapidRate)) * 60; }
      else { st.cut += len; st.time += (len / Math.max(1, e.feed)) * 60; }
    }
    if (!e.rapid) for (let k = 0; k < 3; k++) { if (to[k] < st.min[k]) st.min[k] = to[k]; if (to[k] > st.max[k]) st.max[k] = to[k]; }
    if (to[2] < st.deepest) st.deepest = to[2];
    st.moves += 1;
    pos = to;
  }
  // machines speed up and slow down at every corner; allow for that
  st.time *= 1.12;
  return st;
}

/** Write a program as G-code. Returns { text, stats, events, tools }. */
export function buildGcode(program, opts = {}) {
  const o = { ...DEFAULT_OUTPUT, ...opts };
  const post = POSTS[o.post] || POSTS.grbl;
  const inch = o.units === 'in';
  const k = inch ? 1 / 25.4 : 1, dp = inch ? 4 : 3;
  const num = (v) => { const s = (v * k).toFixed(dp).replace(/\.?0+$/, ''); return s === '-0' ? '0' : s; };
  const fnum = (v) => (inch ? (v * k).toFixed(2).replace(/\.?0+$/, '') : String(Math.round(v)));
  const zOut = (z) => z + (o.zOffset || 0);
  const lines = [];
  let nLine = 10;
  const emit = (text) => { lines.push(post.lineNumbers && text && !/^[(;]/.test(text) ? `N${(nLine += 10) - 10} ${text}` : text); };
  const note = (text) => emit(post.semicolons ? `; ${text}` : `(${String(text).replace(/[()]/g, '')})`);

  const events = expandMoves(program, o);
  const stats = measure(events, o);
  // number the bits in the order they are first used
  const tools = [];
  for (const sec of program.sections) { const key = toolKey(sec.tool); if (!tools.some((t) => t.key === key)) tools.push({ key, tool: sec.tool, number: tools.length + 1 }); }
  const toolNo = (sec) => tools.find((t) => t.key === toolKey(sec.tool)).number;

  note(`${program.name || 'Job'} - made with DabbleCAD`);
  for (const h of program.notes || []) note(h);
  for (const t of tools) note(`T${t.number}: ${toolLabel(t.tool, o.units)}`);
  if (isFinite(stats.min[0])) note(`Cuts from X${num(stats.min[0])} Y${num(stats.min[1])} to X${num(stats.max[0])} Y${num(stats.max[1])}, deepest Z${num(zOut(stats.deepest))}`);
  // Marlin reads one command per line and has no G17 / G94
  if (post.semicolons) { emit(inch ? 'G20' : 'G21'); emit('G90'); } else emit(`${inch ? 'G20' : 'G21'} G90 G17 G94`);
  if (post.setup) emit(post.setup);

  let pos = [null, null, null], lastF = null, lastTool = null, spindleOn = false;
  const dwell = (sec) => { if (sec > 0) emit(`G4 ${post.dwell}${+sec.toFixed(2)}`); };
  for (const e of events) {
    if (e.t === 'section') {
      const sec = program.sections[e.index], key = toolKey(sec.tool);
      note(`${sec.name || 'Toolpath ' + (e.index + 1)}: ${toolLabel(sec.tool, o.units)}`);
      let changed = false;
      if (key !== lastTool) {
        if (lastTool !== null || post.toolChange === 'm6') {
          if (spindleOn && o.spindle === 'auto') { emit('M5'); spindleOn = false; }
          if (lastTool !== null) { emit(`G0 Z${num(zOut(o.safeZ))}`); changed = true; }
          if (post.toolChange === 'm6') emit(`T${toolNo(sec)} M6`);
          else if (lastTool !== null) { note(`Change bit to: ${toolLabel(sec.tool, o.units)}. Then set Z zero again and resume.`); emit(post.semicolons ? `M0 Change bit: ${toolLabel(sec.tool, o.units)}` : 'M0'); }
        }
        lastTool = key;
        lastF = null;
      }
      if (o.spindle === 'auto') {
        const rpm = Math.round(sec.rpm || 0);
        emit(rpm > 0 ? `M3 S${rpm}` : 'M3');
        if (!spindleOn) dwell(o.spinUp);
        spindleOn = true;
        if (o.coolant === 'mist') emit('M7'); else if (o.coolant === 'flood') emit('M8');
      }
      if (changed) {
        // the bit may have been jogged and Z re-zeroed during the change: lift first, then state X and Y in full
        emit(`G0 Z${num(zOut(o.safeZ))}`);
        pos = [null, null, zOut(o.safeZ)];
      }
      continue;
    }
    if (e.t === 'dwell') { dwell(e.sec); continue; }
    const words = [];
    const z = zOut(e.z);
    if (e.x != null && (pos[0] === null || Math.abs(e.x - pos[0]) > 1e-7)) { words.push('X' + num(e.x)); pos[0] = e.x; }
    if (e.y != null && (pos[1] === null || Math.abs(e.y - pos[1]) > 1e-7)) { words.push('Y' + num(e.y)); pos[1] = e.y; }
    if (pos[2] === null || Math.abs(z - pos[2]) > 1e-7) { words.push('Z' + num(z)); pos[2] = z; }
    if (!words.length) continue;
    if (e.rapid) emit(`G0 ${words.join(' ')}`);
    else {
      const f = fnum(e.feed);
      emit(`G1 ${words.join(' ')}${f !== lastF ? ' F' + f : ''}`);
      lastF = f;
    }
  }
  if (o.spindle === 'auto') { emit('M5'); if (o.coolant !== 'off') emit('M9'); }
  if (o.park === 'zero') emit('G0 X0 Y0');
  if (post.end) emit(post.end);
  return { text: lines.join('\n') + '\n', stats, events, tools, extension: post.ext };
}

// ---------------------------------------------------------------- reading G-code
/** Strip comments and blanks. Returns [{ text, n (1-based source line), comment }]. */
export function cleanLines(text) {
  const out = [];
  let lastComment = '';
  const src = String(text).split(/\r?\n/);
  for (let i = 0; i < src.length; i++) {
    let line = src[i];
    const notes = [];
    line = line.replace(/\(([^)]*)\)/g, (_m, c) => { notes.push(c.trim()); return ''; });
    const semi = line.indexOf(';');
    if (semi >= 0) { notes.push(line.slice(semi + 1).trim()); line = line.slice(0, semi); }
    line = line.replace(/\s+/g, '').toUpperCase();
    if (notes.length) lastComment = notes.filter(Boolean).join(' ') || lastComment;
    if (!line || line === '%') continue;
    // "$" commands are passed through untouched apart from the whitespace
    out.push({ text: line.replace(/^N\d+/, ''), n: i + 1, comment: lastComment });
  }
  return out.filter((l) => l.text);
}

const WORD = /([A-Z])([+-]?\d*\.?\d+)/g;

/**
 * Follow a G-code program and return the moves it makes (in mm).
 * Understands G0 G1 G2 G3 (XY arcs), G20 G21, G90 G91 and G53 is treated like any other move.
 */
export function parseGcode(text) {
  const moves = [];
  const pos = [0, 0, 0];
  let unit = 1, abs = true, motion = 0, feed = 0, seen = false;
  const stats = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], cut: 0, rapid: 0, time: 0, lines: 0 };
  const add = (x, y, z, rapid, n) => {
    const len = Math.hypot(x - pos[0], y - pos[1], z - pos[2]);
    if (len < 1e-9) return;
    moves.push({ x, y, z, rapid, feed, n });
    if (rapid) { stats.rapid += len; stats.time += (len / 3000) * 60; } else { stats.cut += len; stats.time += feed > 0 ? (len / feed) * 60 : 0; }
    pos[0] = x; pos[1] = y; pos[2] = z;
    if (!rapid) for (let k = 0; k < 3; k++) { if (pos[k] < stats.min[k]) stats.min[k] = pos[k]; if (pos[k] > stats.max[k]) stats.max[k] = pos[k]; }
  };
  const cleaned = cleanLines(text);
  stats.lines = cleaned.length;
  for (const { text: line, n } of cleaned) {
    if (line[0] === '$') continue;
    const w = {};
    let hasAxis = false, g = [];
    WORD.lastIndex = 0;
    for (let m; (m = WORD.exec(line));) {
      const v = parseFloat(m[2]);
      if (m[1] === 'G') g.push(v); else w[m[1]] = v;
      if ('XYZ'.includes(m[1])) hasAxis = true;
    }
    let skip = false;
    for (const code of g) {
      if (code === 0 || code === 1 || code === 2 || code === 3) motion = code;
      else if (code === 20) unit = 25.4; else if (code === 21) unit = 1;
      else if (code === 90) abs = true; else if (code === 91) abs = false;
      else if (code === 4 || code === 10 || code === 28 || code === 30 || code === 92 || (code >= 38 && code < 39)) skip = true;
    }
    if (w.F != null) feed = w.F * unit;
    // an arc may be a full circle with only its centre given
    if (skip || (!hasAxis && !((motion === 2 || motion === 3) && (w.I != null || w.J != null)))) continue;
    const tgt = [0, 1, 2].map((k) => { const v = w['XYZ'[k]]; return v == null ? pos[k] : abs ? v * unit : pos[k] + v * unit; });
    if (!seen) { seen = true; if (motion === 0 && pos[0] === 0 && pos[1] === 0 && pos[2] === 0 && w.X == null && w.Y == null) { pos[2] = tgt[2]; continue; } }
    if (motion === 2 || motion === 3) {
      let cx, cy;
      if (w.R != null) {
        const r = w.R * unit, dx = tgt[0] - pos[0], dy = tgt[1] - pos[1], d = Math.hypot(dx, dy);
        if (d < 1e-9) continue;
        const hgt = Math.sqrt(Math.max(0, r * r - (d * d) / 4)) * ((motion === 2) === (r > 0) ? -1 : 1);
        cx = pos[0] + dx / 2 - (dy / d) * hgt; cy = pos[1] + dy / 2 + (dx / d) * hgt;
      } else { cx = pos[0] + (w.I || 0) * unit; cy = pos[1] + (w.J || 0) * unit; }
      const r = Math.hypot(pos[0] - cx, pos[1] - cy);
      const a0 = Math.atan2(pos[1] - cy, pos[0] - cx);
      let a1 = Math.atan2(tgt[1] - cy, tgt[0] - cx);
      if (motion === 2) { if (a1 >= a0 - 1e-9) a1 -= Math.PI * 2; } else if (a1 <= a0 + 1e-9) a1 += Math.PI * 2;
      const steps = Math.max(2, Math.ceil(Math.abs(a1 - a0) / (2 * Math.acos(Math.max(0, 1 - 0.01 / Math.max(r, 0.02))) || 0.2)));
      const z0 = pos[2];
      for (let s = 1; s <= steps; s++) { const a = a0 + ((a1 - a0) * s) / steps; add(s === steps ? tgt[0] : cx + r * Math.cos(a), s === steps ? tgt[1] : cy + r * Math.sin(a), z0 + ((tgt[2] - z0) * s) / steps, false, n); }
    } else add(tgt[0], tgt[1], tgt[2], motion === 0, n);
  }
  stats.time *= 1.12;
  return { moves, stats };
}

/**
 * Lines to send so that a program can be picked up part-way through: set up the modes the skipped
 * part would have left behind, start the spindle, travel there high, then come down at feed rate.
 * `index` is an index into cleanLines(text).
 */
export function resumeLines(text, index, safeZ = 5) {
  const cleaned = cleanLines(text);
  const st = { unit: 'G21', dist: 'G90', wcs: '', spindle: '', speed: 0, coolant: '', feed: 0, motion: 'G0', pos: [null, null, null] };
  let at = null, top = -Infinity;
  for (let i = 0; i < cleaned.length; i++) {
    if (i === index) at = { ...st, pos: [...st.pos] };
    const line = cleaned[i].text;
    if (line[0] === '$') continue;
    WORD.lastIndex = 0;
    const w = {};
    let machine = false;
    for (let m; (m = WORD.exec(line));) {
      const v = parseFloat(m[2]);
      if (m[1] === 'G') {
        if (v === 20 || v === 21) st.unit = 'G' + v;
        else if (v === 90 || v === 91) st.dist = 'G' + v;
        else if (v >= 54 && v <= 59 && Number.isInteger(v)) st.wcs = 'G' + v;
        else if (v === 0 || v === 1 || v === 2 || v === 3) st.motion = 'G' + v;
        else if (v === 53) machine = true;
      } else if (m[1] === 'M') {
        if (v === 3 || v === 4) st.spindle = 'M' + v; else if (v === 5) st.spindle = '';
        else if (v === 7 || v === 8) st.coolant = 'M' + v; else if (v === 9) st.coolant = '';
      } else w[m[1]] = v;
    }
    if (w.S != null) st.speed = w.S;
    if (w.F != null) st.feed = w.F;
    // G53 moves are in machine coordinates: they say nothing about where the work position is
    if (machine) continue;
    for (let k = 0; k < 3; k++) { const v = w['XYZ'[k]]; if (v != null) st.pos[k] = st.dist === 'G90' || st.pos[k] === null ? v : st.pos[k] + v; }
    // the highest Z anywhere in the file is the height it travels at
    if (st.pos[2] !== null && st.pos[2] > top) top = st.pos[2];
  }
  if (!at) at = { ...st, pos: [...st.pos] };
  const { unit, dist, wcs, spindle, speed, coolant, feed, motion, pos } = at;
  const inch = unit === 'G20';
  const high = isFinite(top) ? top : inch ? safeZ / 25.4 : safeZ;
  const out = [unit, 'G90', wcs].filter(Boolean);
  if (spindle) out.push(`${spindle}${speed ? ' S' + speed : ''}`, 'G4 P3');
  if (coolant) out.push(coolant);
  out.push(`G0 Z${+high.toFixed(4)}`);
  if (pos[0] !== null || pos[1] !== null) out.push(`G0${pos[0] !== null ? ' X' + pos[0] : ''}${pos[1] !== null ? ' Y' + pos[1] : ''}`);
  if (pos[2] !== null && pos[2] < high) out.push(`G1 Z${pos[2]} F${feed > 0 ? Math.min(feed, inch ? 12 : 300) : inch ? 8 : 200}`);
  if (feed > 0) out.push(`G1 F${feed}`);
  if (dist === 'G91') out.push('G91');
  // the first line may rely on a motion mode set earlier (G0, or an arc): say it outright
  const rest = cleaned.slice(index).map((l) => ({ ...l }));
  if (rest.length && rest[0].text[0] !== '$' && !/G0*[0123](?![\d.])/.test(rest[0].text) && /[XYZIJ]/.test(rest[0].text)) rest[0].text = motion + rest[0].text;
  return { lines: out, rest };
}

export function formatTime(sec) {
  if (!isFinite(sec) || sec <= 0) return '0:00';
  const s = Math.round(sec), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}
