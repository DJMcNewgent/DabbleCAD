// Document model: a tree of shape / group nodes, each carrying an affine matrix.
// Top level node matrices are world matrices; child matrices are relative to the group.
import * as THREE from 'three';

let counter = 1;
export const uid = (prefix = 'n') =>
  prefix + Date.now().toString(36) + (counter++).toString(36) + Math.random().toString(36).slice(2, 6);

export const IDENT = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

export const PALETTE = [
  '#e53935', '#f4511e', '#fb8c00', '#fdd835', '#c0ca33', '#7cb342', '#43a047', '#00897b',
  '#00acc1', '#039be5', '#1e88e5', '#3949ab', '#5e35b1', '#8e24aa', '#d81b60', '#f06292',
  '#6d4c41', '#a1887f', '#ffffff', '#cfd8dc', '#90a4ae', '#546e7a', '#37474f', '#212121',
];

export function makeShape(kind, params = {}, color = '#e53935', name = '') {
  return {
    id: uid(), type: 'shape', kind, name, params: { ...params }, color,
    hole: false, transparent: false, locked: false, hidden: false, matrix: [...IDENT],
  };
}

// mode: 'union' | 'intersect' | 'bundle'
export function makeGroup(children, mode = 'union') {
  const firstSolid = children.find((c) => !c.hole) || children[0];
  return {
    id: uid(), type: 'group', mode, name: '', children, color: firstSolid ? firstSolid.color : '#e53935',
    multicolor: mode === 'bundle', hole: children.every((c) => c.hole), transparent: false,
    locked: false, hidden: false, matrix: [...IDENT],
  };
}

// Params are treated as immutable values (always replaced, never mutated in place),
// so clones can safely share heavy payloads such as imported meshes.
export function cloneNode(node, freshIds = false) {
  const out = { ...node, matrix: [...node.matrix] };
  if (freshIds) out.id = uid();
  if (node.params) out.params = { ...node.params };
  if (node.children) out.children = node.children.map((c) => cloneNode(c, freshIds));
  return out;
}

export const mat4 = (arr) => new THREE.Matrix4().fromArray(arr);

/** Does the node carry its own per-vertex colours (a multicolour group, or a painted mesh)? */
export const ownColors = (node) => (node.type === 'group' ? !!node.multicolor : node.kind === 'mesh' && !!(node.params && node.params.mesh && node.params.mesh.colors));

const round5 = (v) => Math.round(v * 1e5) / 1e5;

function paramKey(params) {
  return JSON.stringify(params, (key, value) => {
    if (key === 'mesh') return value && value.id;
    if (key === 'polys' || key === 'image' || key === 'strokes' || key === 'sketch') return undefined;
    return value;
  });
}

// A string that fully determines the geometry of a node (not its own transform / colour).
const styleKey = (node) => (node.roundStyle === 'bevel' ? 'b' : 'r');
const roundKey = (node) => (node.round > 0 ? '~' + styleKey(node) + round5(node.round) + (node.roundEdges && node.roundEdges !== 'all' ? ':' + node.roundEdges : '') : '')
  + (node.fillet > 0 ? '~f' + styleKey(node) + round5(node.fillet) : '');

export function geomKey(node) {
  if (node.round > 0 || node.fillet > 0) return geomKey({ ...node, round: 0, fillet: 0 }) + roundKey(node);
  if (node.type === 'shape') return node.kind + paramKey(node.params);
  const parts = node.children.map((c) =>
    geomKey(c) + '@' + c.matrix.map(round5).join(',') + (c.hole ? 'h' : 's') +
    (c.type === 'group' && c.multicolor ? 'm' : c.color));
  return 'G' + node.mode + '[' + parts.join('|') + ']';
}

export function walk(nodes, fn) {
  for (const n of nodes) {
    fn(n);
    if (n.children) walk(n.children, fn);
  }
}

export function countShapes(nodes) {
  let n = 0;
  walk(nodes, (x) => { if (x.type === 'shape') n += 1; });
  return n;
}

// ------------------------------------------------------------------ serialization
function toBase64(typed) {
  const bytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(bin);
}

function fromBase64(b64, Type = Float32Array) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Type(bytes.buffer);
}

export function serializeDoc(doc) {
  const meshes = {}, meshColors = {}, meshGroups = {};
  const strip = (node) => {
    const out = { ...node };
    if (node.params) {
      out.params = { ...node.params };
      if (node.params.mesh) {
        const m = node.params.mesh;
        if (!meshes[m.id]) {
          meshes[m.id] = toBase64(m.positions);
          if (m.colors) meshColors[m.id] = toBase64(m.colors);
          if (m.groups) meshGroups[m.id] = toBase64(m.groups);
        }
        out.params.mesh = m.smooth ? { ref: m.id, smooth: true } : { ref: m.id };
      }
    }
    if (node.children) out.children = node.children.map(strip);
    return out;
  };
  return JSON.stringify({
    app: 'DabbleCAD', version: 1, name: doc.name, nodes: doc.nodes.map(strip), meshes, meshColors, meshGroups,
    workplane: doc.workplane, notes: doc.notes || [], laser: doc.laser || null, cnc: doc.cnc || null,
  });
}

export function deserializeDoc(text) {
  const raw = typeof text === 'string' ? JSON.parse(text) : text;
  if (!raw || raw.app !== 'DabbleCAD' || !Array.isArray(raw.nodes)) throw new Error('Not a DabbleCAD design file');
  const cache = {};
  const revive = (node) => {
    const out = { hole: false, transparent: false, locked: false, hidden: false, name: '', ...node };
    out.matrix = Array.isArray(node.matrix) && node.matrix.length === 16 ? node.matrix.map(Number) : [...IDENT];
    if (out.params && out.params.mesh && out.params.mesh.ref) {
      const id = out.params.mesh.ref;
      if (!cache[id]) {
        cache[id] = { id, positions: fromBase64(raw.meshes[id]) };
        if (raw.meshColors && raw.meshColors[id]) cache[id].colors = fromBase64(raw.meshColors[id]);
        if (raw.meshGroups && raw.meshGroups[id]) cache[id].groups = fromBase64(raw.meshGroups[id], Int32Array);
        if (out.params.mesh.smooth) cache[id].smooth = true;
      }
      out.params = { ...out.params, mesh: cache[id] };
    }
    if (node.children) out.children = node.children.map(revive);
    return out;
  };
  return {
    name: raw.name || 'Untitled design',
    nodes: raw.nodes.map(revive),
    workplane: { ...defaultWorkplane(), ...(raw.workplane || {}) },
    notes: Array.isArray(raw.notes) ? raw.notes : [],
    laser: raw.laser || null,
    cnc: raw.cnc || null,
  };
}

export const defaultWorkplane = () => ({ width: 200, length: 200, snap: 1, units: 'mm' });

export function newDoc(name) {
  return { name: name || randomName(), nodes: [], workplane: defaultWorkplane(), notes: [] };
}

const ADJ = ['Brilliant', 'Fantastic', 'Mighty', 'Tremendous', 'Shiny', 'Grand', 'Daring', 'Epic', 'Stunning', 'Swanky',
  'Glorious', 'Spectacular', 'Smashing', 'Neat', 'Cool', 'Bodacious', 'Funky', 'Super', 'Powerful', 'Incredible', 'Frantic', 'Copper', 'Magnificent'];
const NOUN = ['Widget', 'Gizmo', 'Doodad', 'Sprocket', 'Contraption', 'Thingamajig', 'Gadget', 'Whatsit', 'Bracket', 'Trinket',
  'Rocket', 'Gear', 'Robot', 'Castle', 'Lantern', 'Compass', 'Beacon', 'Pebble', 'Comet', 'Tinker', 'Prototype', 'Model'];
export function randomName() {
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  return `${pick(ADJ)} ${pick(NOUN)}`;
}

// ------------------------------------------------------------------ history
export class History {
  constructor(limit = 120) {
    this.limit = limit;
    this.stack = [];
    this.index = -1;
  }

  reset(state) {
    this.stack = [state];
    this.index = 0;
  }

  push(state) {
    this.stack.length = this.index + 1;
    this.stack.push(state);
    if (this.stack.length > this.limit) this.stack.shift();
    this.index = this.stack.length - 1;
  }

  get canUndo() { return this.index > 0; }
  get canRedo() { return this.index < this.stack.length - 1; }
  undo() { return this.canUndo ? this.stack[--this.index] : null; }
  redo() { return this.canRedo ? this.stack[++this.index] : null; }
}
