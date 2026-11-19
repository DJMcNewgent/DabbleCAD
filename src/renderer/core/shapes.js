// Shape library: parametric builders (Z-up, nominal 20 mm) and the shape-panel catalog.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { textShapes } from './fonts.js';
import { makeShape, makeGroup, uid, cloneNode } from './doc.js';

const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function fromTriangles(pos) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return g;
}

/**
 * Surface of revolution around Z. profile = [[r, z], ...] walked counter-clockwise
 * in the (r, z) half plane (solid on the left). loop closes the profile.
 */
export function revolve(profile, sides, loop = false, phase = 0) {
  const pos = [];
  const n = profile.length;
  const segs = loop ? n : n - 1;
  const eps = 1e-7;
  for (let s = 0; s < segs; s++) {
    const [r0, z0] = profile[s];
    const [r1, z1] = profile[(s + 1) % n];
    if (r0 < eps && r1 < eps) continue;
    for (let i = 0; i < sides; i++) {
      const a0 = phase + (i / sides) * TAU, a1 = phase + ((i + 1) / sides) * TAU;
      const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
      if (r0 > eps) pos.push(r0 * c0, r0 * s0, z0, r0 * c1, r0 * s1, z0, r1 * c1, r1 * s1, z1);
      if (r1 > eps) pos.push(r0 * c0, r0 * s0, z0, r1 * c1, r1 * s1, z1, r1 * c0, r1 * s0, z1);
    }
  }
  return fromTriangles(pos);
}

// quarter-round corner points from angle a0 to a1 around (cr, cz)
function arc(cr, cz, rad, a0, a1, steps) {
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const a = a0 + ((a1 - a0) * i) / steps;
    out.push([cr + rad * Math.cos(a), cz + rad * Math.sin(a)]);
  }
  return out;
}

function cylinderProfile(r, h, bevel, segs) {
  const b = clamp(bevel, 0, Math.min(r, h / 2) - 0.01);
  if (b <= 0.001) return [[0, 0], [r, 0], [r, h], [0, h]];
  return [[0, 0], ...arc(r - b, b, b, -Math.PI / 2, 0, segs), ...arc(r - b, h - b, b, 0, Math.PI / 2, segs), [0, h]];
}

function shapeFromPoints(points, holes = []) {
  const shape = new THREE.Shape(points.map((p) => new THREE.Vector2(p[0], p[1])));
  for (const h of holes) shape.holes.push(new THREE.Path(h.map((p) => new THREE.Vector2(p[0], p[1]))));
  return shape;
}

export function extrude(shapes, depth, { bevel = 0, bevelSegments = 2, curveSegments = 10 } = {}) {
  const b = clamp(bevel, 0, depth / 2 - 0.01);
  return new THREE.ExtrudeGeometry(shapes, {
    depth: b > 0 ? depth - 2 * b : depth, steps: 1, curveSegments,
    bevelEnabled: b > 0, bevelThickness: b, bevelSize: b, bevelOffset: -b, bevelSegments: Math.max(1, Math.round(bevelSegments)),
  });
}

function hasClosedTextMesh(geometry) {
  // Use the same position-only weld as the primitive mesh pipeline before export.
  const positionsOnly = new THREE.BufferGeometry();
  positionsOnly.setAttribute('position', geometry.attributes.position);
  const welded = mergeVertices(positionsOnly);
  const indices = welded.index.array, positions = welded.attributes.position;
  const triangle = new THREE.Triangle(), edges = new Map();
  const addEdge = (a, b) => {
    const forward = a < b;
    const key = forward ? a + ':' + b : b + ':' + a;
    const direction = forward ? 1 : -1;
    const first = edges.get(key);
    if (first !== undefined && first !== -direction) return false;
    edges.set(key, first === undefined ? direction : 0);
    return true;
  };
  if (indices.length === 0) return false;
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i], b = indices[i + 1], c = indices[i + 2];
    const area = triangle.setFromAttributeAndIndices(positions, a, b, c).getArea();
    if (!(area > 0) || !addEdge(a, b) || !addEdge(b, c) || !addEdge(c, a)) return false;
  }
  for (const direction of edges.values()) if (direction !== 0) return false;
  return true;
}

// Extrude a profile drawn in the X-Z plane along Y (centred), e.g. roofs and wedges.
function extrudeXZ(points, length, holes = []) {
  const g = extrude([shapeFromPoints(points, holes)], length);
  g.rotateX(Math.PI / 2);
  return g;
}

function circlePts(r, n, cx = 0, cy = 0, a0 = 0, a1 = TAU) {
  const pts = [];
  const full = Math.abs(a1 - a0 - TAU) < 1e-9;
  const count = full ? n : n + 1;
  for (let i = 0; i < count; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

function roundedRectPts(w, h, r, n = 6) {
  const hw = w / 2, hh = h / 2;
  r = clamp(r, 0, Math.min(hw, hh));
  if (r < 0.001) return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
  return [
    ...circlePts(r, n, hw - r, -hh + r, -Math.PI / 2, 0),
    ...circlePts(r, n, hw - r, hh - r, 0, Math.PI / 2),
    ...circlePts(r, n, -hw + r, hh - r, Math.PI / 2, Math.PI),
    ...circlePts(r, n, -hw + r, -hh + r, Math.PI, Math.PI * 1.5),
  ];
}

// Tube swept along a polyline whose tangent is never vertical-only (used by the spring).
function sweep(path, radius, radial) {
  const pos = [];
  const rings = [];
  const Z = new THREE.Vector3(0, 0, 1);
  for (let i = 0; i < path.length; i++) {
    const prev = path[Math.max(0, i - 1)], next = path[Math.min(path.length - 1, i + 1)];
    const T = next.clone().sub(prev).normalize();
    const U = new THREE.Vector3().crossVectors(T, Z).normalize();
    const V = new THREE.Vector3().crossVectors(T, U);
    const ring = [];
    for (let j = 0; j < radial; j++) {
      const a = (j / radial) * TAU;
      ring.push(path[i].clone().addScaledVector(U, Math.cos(a) * radius).addScaledVector(V, Math.sin(a) * radius));
    }
    rings.push(ring);
  }
  const tri = (a, b, c) => pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  for (let i = 0; i < rings.length - 1; i++) {
    for (let j = 0; j < radial; j++) {
      const k = (j + 1) % radial;
      tri(rings[i][j], rings[i][k], rings[i + 1][k]);
      tri(rings[i][j], rings[i + 1][k], rings[i + 1][j]);
    }
  }
  const last = rings.length - 1;
  for (let j = 0; j < radial; j++) {
    const k = (j + 1) % radial;
    tri(path[0], rings[0][k], rings[0][j]);
    tri(path[last], rings[last][j], rings[last][k]);
  }
  return fromTriangles(pos);
}

function gearPts(teeth, outer, root) {
  const pts = [];
  for (let i = 0; i < teeth; i++) {
    const a = (i / teeth) * TAU, step = TAU / teeth;
    for (const [f, r] of [[0, root], [0.22, root], [0.32, outer], [0.58, outer], [0.68, root]]) {
      pts.push([r * Math.cos(a + f * step), r * Math.sin(a + f * step)]);
    }
  }
  return pts;
}

function starPts(points, outer, innerRatio) {
  const pts = [];
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outer : outer * innerRatio;
    const a = Math.PI / 2 + (i / (points * 2)) * TAU;
    pts.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  return pts;
}

function heartPts() {
  const pts = [];
  for (let i = 0; i < 72; i++) {
    const t = (i / 72) * TAU;
    pts.push([10 * Math.sin(t) ** 3, (10 / 16) * (13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t))]);
  }
  return pts;
}

function moonPts() {
  const a = (50 * Math.PI) / 180;
  const px = 10 * Math.cos(a), py = 10 * Math.sin(a), c = 4;
  const r2 = Math.hypot(px - c, py), b = Math.atan2(py, px - c);
  return [...circlePts(10, 40, 0, 0, a, TAU - a), ...circlePts(r2, 30, c, 0, TAU - b, b)];
}

function stairsPts(steps) {
  const pts = [[-10, 0], [10, 0], [10, 20]];
  const run = 20 / steps, rise = 20 / steps;
  for (let i = 1; i <= steps; i++) {
    pts.push([10 - i * run, 20 - (i - 1) * rise]);
    if (i < steps) pts.push([10 - i * run, 20 - i * rise]);
  }
  return pts;
}

function squigglePts() {
  const top = [], bottom = [];
  for (let i = 0; i <= 40; i++) {
    const x = -12 + (24 * i) / 40, y = 5 * Math.sin(x / 2.6);
    top.push([x, y + 2.2]);
    bottom.push([x, y - 2.2]);
  }
  return [...bottom, ...top.reverse()];
}

const R = (key, label, min, max, step, def) => ({ key, label, type: 'range', min, max, step, def });

// ------------------------------------------------------------------ builders
export const KINDS = {
  box: {
    name: 'Box',
    params: [R('radius', 'Radius', 0, 10, 0.1, 0), R('steps', 'Steps', 1, 20, 1, 10)],
    build: (p) => (p.radius > 0.01
      ? new RoundedBoxGeometry(20, 20, 20, Math.round(clamp(p.steps, 1, 20)), clamp(p.radius, 0, 9.99))
      : new THREE.BoxGeometry(20, 20, 20)),
  },
  cylinder: {
    name: 'Cylinder',
    params: [R('sides', 'Sides', 3, 96, 1, 48), R('bevel', 'Bevel', 0, 9, 0.1, 0), R('segments', 'Segments', 1, 12, 1, 4)],
    build: (p) => revolve(cylinderProfile(10, 20, p.bevel, Math.round(p.segments)), Math.round(p.sides)),
  },
  sphere: {
    name: 'Sphere',
    params: [R('steps', 'Steps', 6, 96, 1, 40)],
    build: (p) => revolve(arc(0, 10, 10, -Math.PI / 2, Math.PI / 2, Math.max(3, Math.round(p.steps / 2))).map(([r, z]) => [Math.max(0, r), z]), Math.round(p.steps)),
  },
  cone: {
    name: 'Cone',
    params: [R('top', 'Top Radius', 0, 20, 0.1, 0), R('base', 'Base Radius', 0.1, 20, 0.1, 10), R('sides', 'Sides', 3, 96, 1, 48)],
    build: (p) => revolve([[0, 0], [p.base, 0], [p.top, 20], [0, 20]], Math.round(p.sides)),
  },
  pyramid: {
    name: 'Pyramid',
    params: [R('sides', 'Sides', 3, 24, 1, 4)],
    build: (p) => {
      const n = Math.round(p.sides);
      return revolve([[0, 0], [n === 4 ? 10 * Math.SQRT2 : 10, 0], [0, 20]], n, false, n === 4 ? Math.PI / 4 : Math.PI / 2 - Math.PI / n);
    },
  },
  roof: { name: 'Roof', params: [], build: () => extrudeXZ([[-10, 0], [10, 0], [0, 20]], 20) },
  roundroof: {
    name: 'Round Roof',
    params: [R('sides', 'Sides', 4, 64, 1, 32)],
    build: (p) => extrudeXZ(circlePts(10, Math.round(p.sides), 0, 0, 0, Math.PI), 20),
  },
  wedge: { name: 'Wedge', params: [], build: () => extrudeXZ([[-10, 0], [10, 0], [-10, 20]], 20) },
  halfsphere: {
    name: 'Half Sphere',
    params: [R('steps', 'Steps', 6, 96, 1, 40)],
    build: (p) => revolve([[0, 0], ...arc(0, 0, 10, 0, Math.PI / 2, Math.max(2, Math.round(p.steps / 4))).map(([r, z]) => [Math.max(0, r), z])], Math.round(p.steps)),
  },
  polygon: {
    name: 'Polygon',
    params: [R('sides', 'Sides', 3, 24, 1, 6), R('bevel', 'Bevel', 0, 9, 0.1, 0), R('segments', 'Segments', 1, 12, 1, 3)],
    build: (p) => {
      const n = Math.round(p.sides);
      return revolve(cylinderProfile(10, 20, p.bevel, Math.round(p.segments)), n, false, Math.PI / 2 - Math.PI / n);
    },
  },
  paraboloid: {
    name: 'Paraboloid',
    params: [R('steps', 'Steps', 6, 96, 1, 40)],
    build: (p) => {
      const n = Math.max(4, Math.round(p.steps / 2));
      const prof = [[0, 0]];
      for (let i = 0; i <= n; i++) prof.push([10 * Math.sqrt(Math.max(0, 1 - i / n)), (20 * i) / n]);
      return revolve(prof, Math.round(p.steps));
    },
  },
  torus: {
    name: 'Torus',
    params: [R('radius', 'Radius', 2, 20, 0.1, 7.5), R('tube', 'Tube', 0.5, 10, 0.1, 2.5), R('sides', 'Sides', 3, 96, 1, 48), R('steps', 'Steps', 3, 48, 1, 24)],
    build: (p) => {
      const t = Math.min(p.tube, p.radius - 0.01);
      return revolve(circlePts(t, Math.round(p.steps), p.radius, 0), Math.round(p.sides), true);
    },
  },
  tube: {
    name: 'Tube',
    params: [R('wall', 'Wall Thickness', 0.2, 9.8, 0.1, 2.5), R('sides', 'Sides', 3, 96, 1, 48), R('bevel', 'Bevel', 0, 2, 0.05, 0)],
    build: (p) => {
      const ri = 10 - clamp(p.wall, 0.1, 9.9), b = clamp(p.bevel, 0, Math.min((10 - ri) / 2 - 0.01, 9));
      const prof = b > 0.001
        ? [[ri + b, 0], [10 - b, 0], [10, b], [10, 20 - b], [10 - b, 20], [ri + b, 20], [ri, 20 - b], [ri, b]]
        : [[ri, 0], [10, 0], [10, 20], [ri, 20]];
      return revolve(prof, Math.round(p.sides), true);
    },
  },
  ring: {
    name: 'Ring',
    params: [R('wall', 'Thickness', 0.3, 5, 0.1, 1.2), R('sides', 'Sides', 3, 96, 1, 64)],
    build: (p) => {
      const t = clamp(p.wall, 0.2, 6), h = 5;
      const prof = [...arc(10 - t / 2, t / 2, t / 2, -Math.PI, 0, 6), ...arc(10 - t / 2, h - t / 2, t / 2, 0, Math.PI, 6)];
      return revolve(prof, Math.round(p.sides), true);
    },
  },
  heart: { name: 'Heart', params: [], build: () => extrude([shapeFromPoints(heartPts())], 10) },
  star: {
    name: 'Star',
    params: [R('points', 'Points', 3, 24, 1, 5), R('inner', 'Inner Radius', 0.1, 0.95, 0.01, 0.5)],
    build: (p) => extrude([shapeFromPoints(starPts(Math.round(p.points), 10, p.inner))], 10),
  },
  icosahedron: { name: 'Icosahedron', params: [], build: () => new THREE.IcosahedronGeometry(10, 0) },
  dodecahedron: { name: 'Dodecahedron', params: [], build: () => new THREE.DodecahedronGeometry(10, 0) },
  octahedron: { name: 'Octahedron', params: [], build: () => new THREE.OctahedronGeometry(10, 0) },
  tetrahedron: {
    name: 'Tetrahedron', params: [],
    build: () => revolve([[0, 0], [11.547, 0], [0, 16.33]], 3, false, Math.PI / 2),
  },
  diamond: {
    name: 'Diamond',
    params: [R('sides', 'Sides', 4, 24, 1, 8)],
    build: (p) => revolve([[0, 0], [10, 13], [6, 18], [0, 18]], Math.round(p.sides)),
  },
  capsule: {
    name: 'Capsule',
    params: [R('steps', 'Steps', 6, 96, 1, 40)],
    build: (p) => {
      const n = Math.max(2, Math.round(p.steps / 4));
      const prof = [...arc(0, 6, 6, -Math.PI / 2, 0, n), ...arc(0, 18, 6, 0, Math.PI / 2, n)].map(([r, z]) => [Math.max(0, r), z]);
      return revolve(prof, Math.round(p.steps));
    },
  },
  egg: {
    name: 'Egg',
    params: [R('steps', 'Steps', 6, 96, 1, 40)],
    build: (p) => {
      const n = Math.max(6, Math.round(p.steps / 2));
      const prof = [];
      for (let i = 0; i <= n; i++) {
        const t = -Math.PI / 2 + (Math.PI * i) / n;
        const z = 12 * Math.sin(t);
        prof.push([Math.max(0, 8.5 * Math.cos(t) * (1 - 0.18 * Math.sin(t))), z]);
      }
      return revolve(prof, Math.round(p.steps));
    },
  },
  bowl: {
    name: 'Bowl',
    params: [R('wall', 'Wall Thickness', 0.4, 6, 0.1, 1.5), R('steps', 'Steps', 8, 96, 1, 48)],
    build: (p) => {
      const t = clamp(p.wall, 0.2, 9), n = Math.max(4, Math.round(p.steps / 4));
      const outer = arc(0, 10, 10, -Math.PI / 2, 0, n).map(([r, z]) => [Math.max(0, r), z]);
      const inner = arc(0, 10, 10 - t, 0, -Math.PI / 2, n).map(([r, z]) => [Math.max(0, r), z]);
      return revolve([...outer, ...inner], Math.round(p.steps), true);
    },
  },
  cup: {
    name: 'Cup',
    params: [R('wall', 'Wall Thickness', 0.4, 6, 0.1, 1.5), R('sides', 'Sides', 3, 96, 1, 48)],
    build: (p) => {
      const t = clamp(p.wall, 0.2, 8);
      return revolve([[0, 0], [8, 0], [10, 20], [10 - t, 20], [8 - t, t], [0, t]], Math.round(p.sides), true);
    },
  },
  hollowbox: {
    name: 'Open Box',
    params: [R('wall', 'Wall Thickness', 0.4, 8, 0.1, 1.6)],
    build: (p) => {
      const t = clamp(p.wall, 0.2, 9), s = 10 * Math.SQRT2;
      const g = revolve([[0, 0], [s, 0], [s, 20], [s - t * Math.SQRT2, 20], [s - t * Math.SQRT2, t], [0, t]], 4, true, Math.PI / 4);
      return g;
    },
  },
  gear: {
    name: 'Gear',
    params: [R('teeth', 'Teeth', 6, 48, 1, 12), R('depth', 'Tooth Depth', 0.5, 4, 0.1, 2), R('bore', 'Bore', 0, 6, 0.1, 2.5)],
    build: (p) => {
      const teeth = Math.round(p.teeth), root = 10 - p.depth;
      // keep the bore inside the root circle's chords, or the hole cuts through the rim
      const bore = Math.min(p.bore, root * Math.cos((0.32 * Math.PI) / teeth) - 0.5);
      const holes = bore > 0.05 ? [circlePts(bore, 32).reverse()] : [];
      return extrude([shapeFromPoints(gearPts(teeth, 10, root), holes)], 6);
    },
  },
  spring: {
    name: 'Spring',
    params: [R('turns', 'Turns', 1, 12, 0.5, 4), R('wire', 'Wire Radius', 0.4, 2.5, 0.1, 1), R('radius', 'Coil Radius', 3, 12, 0.1, 8)],
    build: (p) => {
      const path = [];
      const n = Math.round(p.turns * 28);
      for (let i = 0; i <= n; i++) {
        const a = (i / n) * p.turns * TAU;
        path.push(new THREE.Vector3(p.radius * Math.cos(a), p.radius * Math.sin(a), (20 * i) / n));
      }
      return sweep(path, Math.min(p.wire, (20 / p.turns) * 0.45), 12);
    },
  },
  stairs: {
    name: 'Stairs',
    params: [R('steps', 'Steps', 2, 20, 1, 5)],
    build: (p) => extrudeXZ(stairsPts(Math.round(p.steps)), 20),
  },
  arch: {
    name: 'Arch',
    params: [R('opening', 'Opening Radius', 2, 9, 0.1, 6)],
    build: (p) => extrudeXZ([[-10, 0], ...circlePts(p.opening, 24, 0, 0, Math.PI, 0), [10, 0], [10, 14], [-10, 14]], 8),
  },
  profile: {
    name: 'Profile',
    params: [{ key: 'shape', label: 'Profile', type: 'select', options: ['L', 'U', 'T', 'I', 'Z'], def: 'L' }, R('wall', 'Wall Thickness', 0.5, 6, 0.1, 3)],
    build: (p) => {
      const t = clamp(p.wall, 0.2, 9);
      const shapes = {
        L: [[-10, 0], [10, 0], [10, t], [-10 + t, t], [-10 + t, 20], [-10, 20]],
        U: [[-10, 0], [10, 0], [10, 20], [10 - t, 20], [10 - t, t], [-10 + t, t], [-10 + t, 20], [-10, 20]],
        T: [[-t / 2, 0], [t / 2, 0], [t / 2, 20 - t], [10, 20 - t], [10, 20], [-10, 20], [-10, 20 - t], [-t / 2, 20 - t]],
        I: [[-10, 0], [10, 0], [10, t], [t / 2, t], [t / 2, 20 - t], [10, 20 - t], [10, 20], [-10, 20], [-10, 20 - t], [-t / 2, 20 - t], [-t / 2, t], [-10, t]],
        Z: [[-t / 2, 0], [10, 0], [10, t], [t / 2, t], [t / 2, 20], [-10, 20], [-10, 20 - t], [-t / 2, 20 - t]],
      };
      return extrudeXZ(shapes[p.shape] || shapes.L, 20);
    },
  },
  flat: {
    name: 'Flat Shape',
    params: [{
      key: 'shape', label: 'Shape', type: 'select',
      options: ['arrow', 'cross', 'moon', 'bolt', 'drop', 'slot', 'trapezoid', 'parallelogram', 'bubble', 'hexnut', 'washer', 'semicircle', 'quarter'],
      def: 'arrow',
    }],
    build: (p) => {
      let pts, holes = [];
      switch (p.shape) {
        case 'cross': pts = [[-3, -10], [3, -10], [3, -3], [10, -3], [10, 3], [3, 3], [3, 10], [-3, 10], [-3, 3], [-10, 3], [-10, -3], [-3, -3]]; break;
        case 'moon': pts = moonPts(); break;
        case 'bolt': pts = [[3, 10], [-6, -1], [-1, -1], [-4, -10], [6, 2], [1, 2], [5, 10]]; break;
        case 'drop': {
          // Arc around the bottom of the circle between the tangent points seen from the tip.
          const t = Math.acos(7 / 13);
          pts = [...circlePts(7, 36, 0, -3, Math.PI / 2 + t, Math.PI * 2.5 - t), [0, 10]];
          break;
        }
        case 'slot': pts = roundedRectPts(20, 10, 5, 12); break;
        case 'trapezoid': pts = [[-10, -6], [10, -6], [6, 6], [-6, 6]]; break;
        case 'parallelogram': pts = [[-10, -6], [6, -6], [10, 6], [-6, 6]]; break;
        case 'bubble': {
          const rr = roundedRectPts(20, 14, 3, 6).map(([x, y]) => [x, y + 3]);
          pts = [...rr.slice(0, 0), [-4, -4], [-7, -10], [0, -4], ...rr];
          break;
        }
        case 'hexnut': pts = circlePts(10, 6); holes = [circlePts(5, 32).reverse()]; break;
        case 'washer': pts = circlePts(10, 48); holes = [circlePts(5, 32).reverse()]; break;
        case 'semicircle': pts = circlePts(10, 32, 0, 0, 0, Math.PI); break;
        case 'quarter': pts = [[0, 0], ...circlePts(20, 24, 0, 0, 0, Math.PI / 2)]; break;
        default: pts = [[-10, -3], [2, -3], [2, -8], [10, 0], [2, 8], [2, 3], [-10, 3]];
      }
      return extrude([shapeFromPoints(pts, holes)], 5);
    },
  },
  knot: {
    name: 'Torus Knot',
    params: [R('p', 'P', 1, 6, 1, 2), R('q', 'Q', 1, 8, 1, 3), R('tube', 'Tube', 0.5, 3, 0.1, 1.6)],
    build: (p) => {
      // When p and q share a factor the curve is traced several times over itself; reduce
      // them so the same knot is drawn once and the mesh stays watertight.
      const pp = Math.max(1, Math.round(p.p)), qq = Math.max(1, Math.round(p.q));
      const gcd = (a, b) => (b ? gcd(b, a % b) : a);
      const g = gcd(pp, qq);
      return new THREE.TorusKnotGeometry(7, p.tube, 140, 14, pp / g, qq / g);
    },
  },
  text: {
    name: 'Text',
    params: [
      { key: 'text', label: 'Text', type: 'text', def: 'TEXT' },
      { key: 'font', label: 'Font', type: 'font', def: 'Sans Bold' },
      { key: 'align', label: 'Align', type: 'select', options: ['left', 'center', 'right'], def: 'left' },
      R('bevel', 'Bevel', 0, 1.5, 0.05, 0), R('segments', 'Segments', 1, 8, 1, 2),
    ],
    build: (p) => {
      const shapes = textShapes(p.text && p.text.length ? p.text : ' ', p.font, 14, p.align);
      if (!shapes.length) return new THREE.BoxGeometry(6, 14, 6);
      // Deep insets can collapse narrow strokes or the gap between counters.
      const depth = 6;
      for (let bevel = clamp(p.bevel, 0, depth / 2 - 0.01); bevel > 0;) {
        const geometry = extrude(shapes, depth, { bevel, bevelSegments: p.segments, curveSegments: 6 });
        if (hasClosedTextMesh(geometry)) return geometry;
        geometry.dispose();
        const next = Math.max(0.01, bevel / 2);
        if (next >= bevel) break;
        bevel = next;
      }
      return extrude(shapes, depth, { curveSegments: 6 });
    },
  },
  extrusion: {
    name: 'Scribble',
    params: [],
    build: (p) => {
      const shapes = (p.polys || []).map((poly) => shapeFromPoints(poly.outer, poly.holes || []));
      if (!shapes.length) return new THREE.BoxGeometry(10, 10, p.depth || 10);
      return extrude(shapes, p.depth || 10);
    },
  },
  mesh: {
    name: 'Imported Mesh',
    params: [],
    build: (p) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(p.mesh.positions, 3));
      return g;
    },
  },
};

export function defaultParams(kind) {
  const out = {};
  for (const p of KINDS[kind].params) out[p.key] = p.def;
  return out;
}

export function kindName(node) {
  if (node.type === 'group') return node.mode === 'bundle' ? 'Bundle' : node.mode === 'intersect' ? 'Intersect Group' : 'Group';
  if (node.kind === 'flat' || node.kind === 'profile') return KINDS[node.kind].name;
  return KINDS[node.kind] ? KINDS[node.kind].name : 'Shape';
}

// ------------------------------------------------------------------ catalog
const C = (id, kind, name, cat, color, params = {}, extra = {}) => ({ id, kind, name, cat, color, params, ...extra });

const move = (node, x, y, z) => { node.matrix[12] = x; node.matrix[13] = y; node.matrix[14] = z; return node; };
const scaled = (node, sx, sy, sz, x = 0, y = 0, z = 0) => {
  node.matrix = [sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0, x, y, z, 1];
  return node;
};
const prim = (kind, color, params = {}) => makeShape(kind, { ...defaultParams(kind), ...params }, color);
const holeOf = (node) => { node.hole = true; return node; };

// Starters are ready-made groups built from the same primitives the user has.
const STARTERS = {
  bolt: () => makeGroup([
    scaled(prim('polygon', '#90a4ae', { sides: 6 }), 0.9, 0.9, 0.3),
    scaled(prim('cylinder', '#90a4ae'), 0.45, 0.45, 1.3, 0, 0, 5.5),
  ]),
  dice: () => {
    const pips = [[0, 0, 20], [-5, -10, 15], [5, -10, 5], [10, -5, 15], [10, 0, 10], [10, 5, 5]];
    return makeGroup([
      prim('box', '#ffffff', { radius: 2.5, steps: 6 }),
      ...pips.map(([x, y, z]) => holeOf(scaled(prim('sphere', '#212121', { steps: 16 }), 0.22, 0.22, 0.22, x, y, z - 2.2))),
    ]);
  },
  mug: () => makeGroup([
    scaled(prim('cylinder', '#1e88e5'), 1, 1, 1.1),
    scaled(prim('torus', '#1e88e5', { radius: 6, tube: 1.6 }), 1, 1, 1, 0, 0, 0),
    holeOf(scaled(prim('cylinder', '#1e88e5'), 0.85, 0.85, 1.1, 0, 0, 2)),
  ].map((n, i) => (i === 1 ? Object.assign(n, { matrix: [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 11, 1.6, 11, 1] }) : n))),
  nametag: () => makeGroup([
    scaled(prim('box', '#fdd835', { radius: 1.5, steps: 5 }), 2.6, 1, 0.15),
    holeOf(scaled(prim('cylinder', '#fdd835'), 0.2, 0.2, 0.5, -21, 0, -1)),
    scaled(prim('text', '#212121', { text: 'NAME', align: 'center' }), 0.75, 0.75, 0.4, 3, 0, 2.5),
  ], 'union'),
  house: () => {
    const g = makeGroup([
      scaled(prim('box', '#fb8c00'), 1.5, 1, 0.8),
      scaled(prim('roof', '#6d4c41'), 1.6, 1.1, 0.5, 0, 0, 16),
      holeOf(scaled(prim('box', '#fb8c00'), 0.3, 0.2, 0.5, 0, -10, 0)),
    ]);
    g.multicolor = true;
    return g;
  },
  table: () => makeGroup([
    scaled(prim('box', '#a1887f', { radius: 0.8, steps: 4 }), 2, 1.2, 0.1, 0, 0, 14),
    ...[[-17, -9], [17, -9], [17, 9], [-17, 9]].map(([x, y]) => scaled(prim('cylinder', '#6d4c41'), 0.12, 0.12, 0.7, x, y, 0)),
  ]),
  rocket: () => {
    const g = makeGroup([
      scaled(prim('cylinder', '#eceff1'), 0.6, 0.6, 1.2, 0, 0, 4),
      scaled(prim('paraboloid', '#e53935'), 0.6, 0.6, 0.5, 0, 0, 28),
      ...[0, 1, 2].map((i) => {
        const a = (i / 3) * TAU, c = Math.cos(a), s = Math.sin(a);
        const fin = prim('wedge', '#e53935');
        fin.matrix = [0.35 * c, 0.35 * s, 0, 0, -0.08 * s, 0.08 * c, 0, 0, 0, 0, 0.5, 0, 9 * c, 9 * s, 0, 1];
        return fin;
      }),
    ]);
    g.multicolor = true;
    return g;
  },
  keyring: () => makeGroup([
    scaled(prim('flat', '#00acc1', { shape: 'slot' }), 2, 1.4, 0.6),
    holeOf(scaled(prim('cylinder', '#00acc1'), 0.25, 0.25, 0.5, -14, 0, -2)),
  ]),
  snowman: () => {
    const g = makeGroup([
      scaled(prim('sphere', '#ffffff'), 1, 1, 0.9),
      scaled(prim('sphere', '#ffffff'), 0.72, 0.72, 0.66, 0, 0, 15),
      scaled(prim('sphere', '#ffffff'), 0.5, 0.5, 0.46, 0, 0, 26),
      scaled(prim('cone', '#fb8c00'), 0.1, 0.1, 0.25, 0, 0, 0),
      scaled(prim('cylinder', '#212121'), 0.45, 0.45, 0.25, 0, 0, 34),
    ]);
    // nose: the cone's tip axis points out of the face (-Y)
    g.children[3].matrix = [0.1, 0, 0, 0, 0, 0, 0.1, 0, 0, -0.25, 0, 0, 0, -4.5, 31, 1];
    g.multicolor = true;
    return g;
  },
};

export function buildStarter(id) {
  const g = STARTERS[id]();
  g.id = uid();
  return g;
}

export const CATEGORIES = [
  { id: 'basic', name: 'Basic Shapes' },
  { id: 'more', name: 'More Shapes' },
  { id: 'flat', name: 'Symbols & Flat Shapes' },
  { id: 'structural', name: 'Structural & Hardware' },
  { id: 'text', name: 'Text & Numbers' },
  { id: 'starters', name: 'Design Starters' },
  { id: 'mine', name: 'Your Creations' },
  { id: 'all', name: 'All Shapes' },
];

export const CATALOG = [
  C('box', 'box', 'Box', 'basic', '#3fa7a3'),
  C('cylinder', 'cylinder', 'Cylinder', 'basic', '#e07a5f'),
  C('box-hole', 'box', 'Box Hole', 'basic', '#b0bec5', {}, { hole: true }),
  C('cylinder-hole', 'cylinder', 'Cylinder Hole', 'basic', '#b0bec5', {}, { hole: true }),
  C('sphere', 'sphere', 'Sphere', 'basic', '#f2b134'),
  C('scribble', 'extrusion', 'Scribble', 'basic', '#7c8cf8', { polys: [{ outer: squigglePts(), holes: [] }], depth: 8, pid: 'squiggle' }, { special: 'scribble' }),
  C('roof', 'roof', 'Roof', 'basic', '#7a6fd6'),
  C('cone', 'cone', 'Cone', 'basic', '#4c9f70'),
  C('roundroof', 'roundroof', 'Round Roof', 'basic', '#d9658f'),
  C('text', 'text', 'Text', 'basic', '#5b8def'),
  C('wedge', 'wedge', 'Wedge', 'basic', '#c98b3c'),
  C('pyramid', 'pyramid', 'Pyramid', 'basic', '#8f5bbd'),
  C('halfsphere', 'halfsphere', 'Half Sphere', 'basic', '#2f9bd6'),
  C('polygon', 'polygon', 'Polygon', 'basic', '#e2725b'),
  C('paraboloid', 'paraboloid', 'Paraboloid', 'basic', '#57a773'),
  C('torus', 'torus', 'Torus', 'basic', '#d4a017'),
  C('tube', 'tube', 'Tube', 'basic', '#5f7adb'),
  C('heart', 'heart', 'Heart', 'basic', '#cf5c78'),
  C('star', 'star', 'Star', 'basic', '#3aa6b9'),
  C('ring', 'ring', 'Ring', 'basic', '#b08d57'),
  C('icosahedron', 'icosahedron', 'Icosahedron', 'basic', '#9a6fb0'),
  C('diamond', 'diamond', 'Diamond', 'basic', '#6cc5b0'),
  C('dodecahedron', 'dodecahedron', 'Dodecahedron', 'basic', '#dd8452'),
  C('octahedron', 'octahedron', 'Octahedron', 'basic', '#4f8fc0'),
  C('tetrahedron', 'tetrahedron', 'Tetrahedron', 'basic', '#a3b34d'),

  C('capsule', 'capsule', 'Capsule', 'more', '#43a047'),
  C('egg', 'egg', 'Egg', 'more', '#fff3e0'),
  C('bowl', 'bowl', 'Bowl', 'more', '#00acc1'),
  C('cup', 'cup', 'Cup', 'more', '#1e88e5'),
  C('hollowbox', 'hollowbox', 'Open Box', 'more', '#fb8c00'),
  C('spring', 'spring', 'Spring', 'more', '#90a4ae'),
  C('knot', 'knot', 'Torus Knot', 'more', '#8e24aa'),
  C('star6', 'star', '6-Point Star', 'more', '#fb8c00', { points: 6, inner: 0.58 }),
  C('burst', 'star', 'Burst', 'more', '#e53935', { points: 14, inner: 0.72 }),
  C('hexprism', 'polygon', 'Hexagonal Prism', 'more', '#00897b', { sides: 6 }),
  C('triprism', 'polygon', 'Triangular Prism', 'more', '#3949ab', { sides: 3 }),
  C('frustum', 'cone', 'Truncated Cone', 'more', '#d81b60', { top: 5 }),
  C('roundbox', 'box', 'Rounded Box', 'more', '#7cb342', { radius: 3 }),
  C('pill', 'cylinder', 'Rounded Cylinder', 'more', '#f4511e', { bevel: 3, segments: 6 }),

  C('arrow', 'flat', 'Arrow', 'flat', '#e53935', { shape: 'arrow' }),
  C('cross', 'flat', 'Plus', 'flat', '#43a047', { shape: 'cross' }),
  C('moon', 'flat', 'Moon', 'flat', '#fdd835', { shape: 'moon' }),
  C('bolt-sym', 'flat', 'Lightning', 'flat', '#fb8c00', { shape: 'bolt' }),
  C('drop', 'flat', 'Drop', 'flat', '#039be5', { shape: 'drop' }),
  C('bubble', 'flat', 'Speech Bubble', 'flat', '#eceff1', { shape: 'bubble' }),
  C('slot', 'flat', 'Rounded Slot', 'flat', '#8e24aa', { shape: 'slot' }),
  C('trapezoid', 'flat', 'Trapezoid', 'flat', '#00897b', { shape: 'trapezoid' }),
  C('parallelogram', 'flat', 'Parallelogram', 'flat', '#3949ab', { shape: 'parallelogram' }),
  C('semicircle', 'flat', 'Semicircle', 'flat', '#d81b60', { shape: 'semicircle' }),
  C('quarter', 'flat', 'Quarter Circle', 'flat', '#6d4c41', { shape: 'quarter' }),

  C('gear', 'gear', 'Gear', 'structural', '#90a4ae'),
  C('hexnut', 'flat', 'Hex Nut', 'structural', '#90a4ae', { shape: 'hexnut' }),
  C('washer', 'flat', 'Washer', 'structural', '#b0bec5', { shape: 'washer' }),
  C('stairs', 'stairs', 'Stairs', 'structural', '#a1887f'),
  C('arch', 'arch', 'Arch', 'structural', '#fb8c00'),
  C('lbeam', 'profile', 'L Bracket', 'structural', '#546e7a', { shape: 'L' }),
  C('ubeam', 'profile', 'U Channel', 'structural', '#546e7a', { shape: 'U' }),
  C('tbeam', 'profile', 'T Beam', 'structural', '#546e7a', { shape: 'T' }),
  C('ibeam', 'profile', 'I Beam', 'structural', '#546e7a', { shape: 'I' }),
  C('zbeam', 'profile', 'Z Profile', 'structural', '#546e7a', { shape: 'Z' }),

  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('').map((ch) =>
    C('char-' + ch, 'text', ch, 'text', /\d/.test(ch) ? '#1e88e5' : '#e53935', { text: ch })),

  C('st-bolt', 'starter', 'Bolt', 'starters', '#90a4ae', {}, { starter: 'bolt' }),
  C('st-dice', 'starter', 'Dice', 'starters', '#ffffff', {}, { starter: 'dice' }),
  C('st-mug', 'starter', 'Mug', 'starters', '#1e88e5', {}, { starter: 'mug' }),
  C('st-nametag', 'starter', 'Name Tag', 'starters', '#fdd835', {}, { starter: 'nametag' }),
  C('st-house', 'starter', 'House', 'starters', '#fb8c00', {}, { starter: 'house' }),
  C('st-table', 'starter', 'Table', 'starters', '#a1887f', {}, { starter: 'table' }),
  C('st-rocket', 'starter', 'Rocket', 'starters', '#e53935', {}, { starter: 'rocket' }),
  C('st-keyring', 'starter', 'Key Tag', 'starters', '#00acc1', {}, { starter: 'keyring' }),
  C('st-snowman', 'starter', 'Snowman', 'starters', '#ffffff', {}, { starter: 'snowman' }),
];

/** Create a fresh node (shape or starter group) for a catalog entry. */
export function nodeFromCatalog(entry) {
  if (entry.starter) {
    const g = buildStarter(entry.starter);
    g.name = entry.name;
    return g;
  }
  if (entry.node) {
    // user-saved creation
    return cloneNode(entry.node, true);
  }
  const node = makeShape(entry.kind, { ...defaultParams(entry.kind), ...entry.params }, entry.color);
  if (entry.hole) node.hole = true;
  return node;
}
