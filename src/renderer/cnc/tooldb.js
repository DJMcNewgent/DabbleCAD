// Bit library and starting feeds and speeds. All sizes in millimetres.

export const TOOL_TYPES = [['end', 'End mill (flat)'], ['ball', 'Ball nose'], ['vbit', 'V-bit'], ['drill', 'Drill']];

let seq = 1;
const T = (name, type, dia, extra = {}) => ({ id: 'bit' + seq++, name, type, dia, flutes: 2, ...extra });
export const DEFAULT_TOOLS = [
  T('1/4" end mill', 'end', 6.35), T('1/8" end mill', 'end', 3.175), T('1/16" end mill', 'end', 1.5875), T('1/2" end mill', 'end', 12.7),
  T('6 mm end mill', 'end', 6), T('3 mm end mill', 'end', 3), T('2 mm end mill', 'end', 2), T('1 mm end mill', 'end', 1),
  T('60° V-bit, 1/2"', 'vbit', 12.7, { angle: 60 }), T('90° V-bit, 1/2"', 'vbit', 12.7, { angle: 90 }), T('30° engraving bit, 1/8"', 'vbit', 3.175, { angle: 30, tip: 0.2 }),
  T('1/4" ball nose', 'ball', 6.35), T('1/8" ball nose', 'ball', 3.175), T('1/16" ball nose', 'ball', 1.5875),
  T('1/8" drill', 'drill', 3.175), T('3 mm drill', 'drill', 3), T('5 mm drill', 'drill', 5),
  T('1" surfacing bit', 'end', 25.4, { flutes: 3 }),
];

// feed: mm/min for a 6 mm two-flute bit on an ordinary hobby machine; doc: depth per pass as a share of the bit's width
export const MATERIALS = {
  softwood: { name: 'Softwood (pine, cedar)', feed: 1800, doc: 0.5, rpm: 16000, plunge: 0.3 },
  hardwood: { name: 'Hardwood (oak, maple, walnut)', feed: 1300, doc: 0.4, rpm: 16000, plunge: 0.3 },
  plywood: { name: 'Plywood', feed: 1500, doc: 0.5, rpm: 16000, plunge: 0.3 },
  mdf: { name: 'MDF', feed: 2000, doc: 0.5, rpm: 16000, plunge: 0.35 },
  acrylic: { name: 'Acrylic', feed: 1200, doc: 0.35, rpm: 14000, plunge: 0.25 },
  hdpe: { name: 'HDPE and soft plastics', feed: 1500, doc: 0.5, rpm: 12000, plunge: 0.3 },
  foam: { name: 'Foam', feed: 3000, doc: 1.5, rpm: 12000, plunge: 0.5 },
  aluminium: { name: 'Aluminium', feed: 500, doc: 0.1, rpm: 14000, plunge: 0.2 },
  brass: { name: 'Brass', feed: 300, doc: 0.08, rpm: 12000, plunge: 0.2 },
  pcb: { name: 'Circuit board (FR4)', feed: 400, doc: 0.15, rpm: 20000, plunge: 0.25 },
};

/**
 * Sensible starting values for a bit in a material. `strength` scales everything for the machine:
 * 0.6 for a light desktop machine, 1 for a typical belt or screw driven router, 1.4 for a rigid one.
 */
export function recommend(tool, materialKey = 'softwood', { strength = 1, maxFeed = 5000, maxRpm = 24000, minRpm = 0 } = {}) {
  const m = MATERIALS[materialKey] || MATERIALS.softwood;
  const d = Math.max(0.2, tool.dia);
  // small bits break easily, big bits take a lot of power: both run slower than a 6 mm bit
  const size = d <= 6 ? Math.max(0.25, d / 6) : Math.max(0.6, 1 - (d - 6) / 40);
  let feed = m.feed * size * strength;
  let passDepth = d * m.doc * Math.min(1.2, strength);
  let rpm = m.rpm;
  let stepover = d * 0.4;
  if (tool.type === 'vbit') { feed *= 0.8; passDepth = Math.min(d * 0.25, 3 * m.doc * 2); stepover = 0.3; }
  if (tool.type === 'ball') { stepover = d * 0.1; }
  if (tool.type === 'drill') { feed *= 0.5; passDepth = d; rpm = Math.min(rpm, 10000); }
  if (d >= 20) { rpm = Math.min(rpm, 14000); passDepth = Math.min(passDepth, 1); stepover = d * 0.6; }
  feed = Math.min(maxFeed, Math.max(60, feed));
  rpm = Math.max(minRpm, Math.min(maxRpm, rpm));
  const round = (v, to) => Math.max(to, Math.round(v / to) * to);
  return {
    feed: round(feed, 10), plunge: round(feed * (tool.type === 'drill' ? 1 : m.plunge), 10), rpm: round(rpm, 500),
    passDepth: +Math.max(0.1, passDepth).toFixed(2), stepover: +Math.max(0.05, stepover).toFixed(2),
  };
}

export const describeTool = (t) => (t ? `${t.name || t.type}` : 'No bit');
