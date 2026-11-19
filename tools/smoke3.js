// Functional check, run inside the app:  node tools/run.js --smoke=tools/smoke3.js
const app = window.dabble, ed = app.editor, vp = app.viewport;
const lib = window.dabbleLib;
const { CATALOG, nodeFromCatalog } = lib.shapes;
const out = {}; const fails = [];
const near = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;
const check = (name, cond, info) => { if (!cond) fails.push(name + (info !== undefined ? ' -> ' + JSON.stringify(info) : '')); };
const add = (id, x, y) => { const n = nodeFromCatalog(CATALOG.find((c) => c.id === id)); ed.placeAt(n, x, y); ed.addNode(n); return n; };
const bb = () => { const b = ed.bounds(ed.selectedNodes()); return [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z].map((v) => Math.round(v * 1000) / 1000); };

add('box', 0, 0);
check('place', JSON.stringify(bb()) === '[-10,-10,0,10,10,20]', bb());
ed.setSize('x', 40); check('setSize', JSON.stringify(bb()) === '[-10,-10,0,30,10,20]', bb());
ed.nudge(1, 0, 0); check('nudge', bb()[0] === -9, bb());
ed.rotateSelection('z', 90); const b = bb(); check('rotate', near(b[3] - b[0], 20) && near(b[4] - b[1], 40), b);
ed.mirror('x'); const b2 = bb(); check('mirror', JSON.stringify(b) === JSON.stringify(b2), b2);
ed.nudge(0, 0, 5); ed.dropToWorkplane(); check('drop', bb()[2] === 0, bb());
ed.duplicate(); ed.nudge(30, 0, 0); ed.duplicate(); check('dup-repeat', near(bb()[0] - b2[0], 60), [bb(), b2]);
check('count3', ed.doc.nodes.length === 3, ed.doc.nodes.length);
ed.undo(); ed.undo(); ed.undo(); check('undo', ed.doc.nodes.length === 1, ed.doc.nodes.length);
ed.redo(); ed.redo(); ed.redo(); check('redo', ed.doc.nodes.length === 3, ed.doc.nodes.length);
ed.selectAll(); ed.deleteSelection(); check('delete', ed.doc.nodes.length === 0);

// boolean: box minus a centred cylinder hole of radius 5
const b1 = add('box', 0, 0);
const cy = add('cylinder-hole', 0, 0);
ed.select([cy.id]); ed.setSize('x', 10); ed.setSize('y', 10); ed.setPosition('x', -5); ed.setPosition('y', -5); ed.setPosition('z', -1); ed.setSize('z', 22);
ed.select([b1.id, cy.id]); await ed.group('union');
const vol = ed.measureNodes(ed.selectedNodes()).volume;
out.volume = Math.round(vol); check('csg-volume', Math.abs(vol - (8000 - 1566)) < 15, vol);
// intersect of two overlapping boxes -> 10 x 20 x 20
const i1 = add('box', 60, 0), i2 = add('box', 70, 0);
ed.select([i1.id, i2.id]); await ed.group('intersect');
check('intersect', near(ed.measureNodes(ed.selectedNodes()).volume, 4000, 2), ed.measureNodes(ed.selectedNodes()).volume);
ed.ungroup(); check('ungroup', ed.selection.size === 2);
await ed.group('bundle'); check('bundle', ed.selectedNodes()[0].mode === 'bundle');
// align two shapes
const a1 = add('box', -60, -60), a2 = add('sphere', -30, -20);
ed.select([a1.id, a2.id]); ed.align('x', 'min'); ed.align('y', 'center');
const ba = ed.bounds([a1]), bs = ed.bounds([a2]);
check('align', near(ba.min.x, bs.min.x) && near((ba.min.y + ba.max.y) / 2, (bs.min.y + bs.max.y) / 2), [ba.min.x, bs.min.x]);
// text
const t = add('text', -60, 60);
out.textVerts = lib.geometry.getGeometry(t).attributes.position.count; check('text', out.textVerts > 200, out.textVerts);
ed.select([t.id]); ed.pattern({ type: 'linear', count: 3, dx: 0, dy: -20, dz: 0 }); check('pattern', ed.selection.size === 3);
// round trip
const json = lib.doc.serializeDoc(ed.doc); const back = lib.doc.deserializeDoc(json);
check('roundtrip', back.nodes.length === ed.doc.nodes.length && back.nodes.every((n, i) => lib.doc.geomKey(n) === lib.doc.geomKey(ed.doc.nodes[i])));
// exports + re-import
out.exports = {};
for (const f of ['stl', 'obj', '3mf', 'glb', 'svg']) {
  try { const r = await lib.io.exportModel(ed, f, {}); out.exports[f] = r.data.length || r.data.byteLength; check('export-' + f, out.exports[f] > 200); }
  catch (e) { fails.push('export-' + f + ': ' + e.message); }
}
ed.select([b1.id].filter((id) => ed.node(id)).length ? [b1.id] : [ed.doc.nodes[0].id]);
const stl = await lib.io.exportModel(ed, 'stl', { selectedOnly: true });
const imp = await lib.io.importFiles([{ name: 'part.stl', data: stl.data.buffer }], { fitTo: 200 });
check('import-stl', imp.nodes.length === 1 && imp.nodes[0].params.mesh.positions.length > 100, imp.messages);
if (imp.nodes.length) { ed.placeAt(imp.nodes[0], 60, 60); ed.addNode(imp.nodes[0]); }
const glb = await lib.io.exportModel(ed, 'glb', { selectedOnly: true });
const impG = await lib.io.importFiles([{ name: 'part.glb', data: glb.data.buffer }], { fitTo: 200 });
check('import-glb', impG.nodes.length === 1, impG.messages);
if (impG.nodes.length) { const gb = ed.bounds([impG.nodes[0]]); check('glb-scale', near(gb.max.z - gb.min.z, 20, 0.05), [gb.max.z - gb.min.z]); }
const mf = await lib.io.exportModel(ed, '3mf', { selectedOnly: true });
const impM = await lib.io.importFiles([{ name: 'part.3mf', data: mf.data.buffer }], { fitTo: 200 });
check('import-3mf', impM.nodes.length === 1, impM.messages);
const svgText = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M10 10h80v80h-80z M30 30v40h40v-40z" fill-rule="evenodd" fill="#000"/><circle cx="50" cy="50" r="8" fill="red"/></svg>';
const simp = await lib.io.importFiles([{ name: 'logo.svg', data: new TextEncoder().encode(svgText).buffer }], {});
check('import-svg', simp.nodes.length === 1, simp.messages);
if (simp.nodes.length) { ed.placeAt(simp.nodes[0], 60, -60); ed.addNode(simp.nodes[0]); }

// simulated mouse: drag a box 30 mm along +X on the workplane
const d1 = add('box', 0, -70);
ed.clearSelection(); vp.renderNow();
const rect = vp.canvas.getBoundingClientRect();
const V3 = vp.target.constructor;
const scr = (x, y, z) => { const p = vp.project(new V3(x, y, z), {}); return { clientX: rect.left + p.x, clientY: rect.top + p.y }; };
const fire = (el, type, pt, extra = {}) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, button: 0, buttons: 1, ...pt, ...extra }));
const p0 = scr(0, -70, 20), p1 = scr(30, -70, 20);
fire(vp.canvas, 'pointerdown', p0);
fire(vp.canvas, 'pointermove', { clientX: (p0.clientX + p1.clientX) / 2, clientY: (p0.clientY + p1.clientY) / 2 });
fire(vp.canvas, 'pointermove', p1); fire(vp.canvas, 'pointerup', p1);
let bd = ed.bounds([d1]); check('mouse-move', ed.selection.has(d1.id) && near(bd.min.x, 20, 1.01) && near(bd.min.y, -80, 1.01), [bd.min.x, bd.min.y]);
// top handle: raise the height by 20 mm, then lift by 10 mm
vp.renderNow();
const topEl = document.querySelector('.gz-top'), liftEl = document.querySelector('.gz-lift');
const c = bd.getCenter(new V3());
const t0 = scr(c.x, c.y, 20), t1 = scr(c.x, c.y, 40);
fire(topEl, 'pointerdown', t0); fire(topEl, 'pointermove', t1); fire(topEl, 'pointerup', t1);
bd = ed.bounds([d1]); check('handle-height', near(bd.max.z, 40, 1.01), bd.max.z);
vp.renderNow();
fire(liftEl, 'pointerdown', t1); fire(liftEl, 'pointermove', scr(c.x, c.y, 50)); fire(liftEl, 'pointerup', scr(c.x, c.y, 50));
bd = ed.bounds([d1]); check('handle-lift', near(bd.min.z, 10, 1.01), bd.min.z);
// corner resize (+10 in X, +5 in Y)
vp.renderNow();
const corners = [...document.querySelectorAll('.gz-corner:not(.gz-top)')];
const cmax = corners[3];
const k0 = scr(bd.max.x, bd.max.y, bd.min.z), k1 = scr(bd.max.x + 10, bd.max.y + 5, bd.min.z);
fire(cmax, 'pointerdown', k0); fire(cmax, 'pointermove', k1); fire(cmax, 'pointerup', k1);
bd = ed.bounds([d1]); check('handle-corner', near(bd.max.x - bd.min.x, 30, 1.01) && near(bd.max.y - bd.min.y, 25, 1.01), [bd.max.x - bd.min.x, bd.max.y - bd.min.y]);
// rotate about Z with Shift (45 degree steps)
vp.renderNow();
const rz = document.querySelector('.gz-rot-z');
const cc = bd.getCenter(new V3());
const r0 = scr(cc.x + 30, cc.y, cc.z), r1 = scr(cc.x + 21, cc.y + 21, cc.z);
fire(rz, 'pointerdown', r0); fire(rz, 'pointermove', r1, { shiftKey: true }); fire(rz, 'pointerup', r1, { shiftKey: true });
const m = ed.node(d1.id).matrix; out.rotAngle = Math.round(Math.atan2(m[1], m[0]) * 180 / Math.PI); check('handle-rotate', out.rotAngle === 45, out.rotAngle);
// marquee
ed.clearSelection();
fire(vp.canvas, 'pointerdown', { clientX: rect.left + 130, clientY: rect.top + 40 });
fire(vp.canvas, 'pointermove', { clientX: rect.left + 600, clientY: rect.top + 500 });
fire(vp.canvas, 'pointermove', { clientX: rect.right - 320, clientY: rect.bottom - 20 }); fire(vp.canvas, 'pointerup', { clientX: rect.right - 320, clientY: rect.bottom - 20 });
out.marquee = ed.selection.size; check('marquee', ed.selection.size >= 5, ed.selection.size);
// navigation: right-drag orbits, middle-drag pans, wheel zooms, Alt-drag copies
const nav = (button, from, to, extra = {}) => {
  vp.canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 11, button, ...from, ...extra }));
  vp.canvas.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 11, button, ...to, ...extra }));
  vp.canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 11, button, ...to, ...extra }));
};
const mid = { clientX: rect.left + 500, clientY: rect.top + 400 }, off = { clientX: rect.left + 560, clientY: rect.top + 430 };
let th = vp.theta, ph = vp.phi; nav(2, mid, off); check('orbit-right-drag', vp.theta !== th && vp.phi !== ph);
th = vp.theta; nav(0, mid, off, { ctrlKey: true }); check('orbit-ctrl-drag', vp.theta !== th);
let tg = vp.target.clone(); nav(1, mid, off); check('pan-middle-drag', vp.target.distanceTo(tg) > 1 && vp.theta === vp.theta);
tg = vp.target.clone(); th = vp.theta; nav(2, mid, off, { shiftKey: true }); check('pan-shift-right', vp.target.distanceTo(tg) > 1 && vp.theta === th);
const rad = vp.radius; vp.canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -240, ...mid })); check('wheel-zoom', vp.radius < rad, [rad, vp.radius]);
vp.home(); await new Promise((r) => setTimeout(r, 500)); vp.renderNow();
const before = ed.doc.nodes.length;
const q = add('cone', -70, -70); ed.clearSelection(); vp.renderNow();
const q0 = scr(-70, -70, 8), q1 = scr(-40, -70, 8);
fire(vp.canvas, 'pointerdown', q0, { altKey: true }); fire(vp.canvas, 'pointermove', q1, { altKey: true }); fire(vp.canvas, 'pointerup', q1, { altKey: true });
check('alt-drag-copy', ed.doc.nodes.length === before + 2 && ed.doc.nodes.filter((n) => n.kind === 'cone').length === 2, ed.doc.nodes.length - before);
// right-click opens the context menu
vp.canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 12, button: 2, ...q1 }));
vp.canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 12, button: 2, ...q1 }));
check('context-menu', !!document.querySelector('.menu') && document.querySelectorAll('.menu-item').length > 10);
document.querySelectorAll('.menu').forEach((m) => m.remove());
ed.select([d1.id]);
// round / bevel edges keep the size and stay closed; generators are closed solids
{
  const rb = add('star', 260, -200); const size0 = ed.bounds([rb]);
  ed.select([rb.id]); ed.patchSelection({ round: 1 });
  const rg = lib.geometry.getGeometry(ed.node(rb.id)); const ri = lib.solid.inspectSolid(rg); const size1 = ed.bounds([ed.node(rb.id)]);
  check('round-edges', ri.closed && Math.abs((size1.max.x - size1.min.x) - (size0.max.x - size0.min.x)) < 0.05 && rg.attributes.position.count > 200, [ri, rg.attributes.position.count]);
  ed.patchSelection({ round: 1, roundStyle: 'bevel' });
  check('bevel-edges', lib.solid.inspectSolid(lib.geometry.getGeometry(ed.node(rb.id))).closed);
  ed.deleteSelection();
  for (const c of CATALOG.filter((c) => c.cat === 'generators')) {
    const gi = lib.solid.inspectSolid(lib.geometry.getGeometry(nodeFromCatalog(c)));
    check('generator-' + c.id, gi.closed && gi.volume > 50, gi);
  }
}
// bevelled text must stay a closed, printable solid
{
  const tn = nodeFromCatalog(CATALOG.find((c) => c.id === 'text')); tn.params = { ...tn.params, text: 'Wiggly & 8', bevel: 0.8, segments: 3 };
  const info = lib.solid.inspectSolid(lib.geometry.getGeometry(tn));
  check('bevel-text-closed', info.closed === true && info.parts === 9, info);
}
// edit the parts of a group without ungrouping
{
  const p1 = add('box', -200, 200), p2 = add('cylinder', -190, 200);
  ed.select([p1.id, p2.id]); await ed.group('union');
  const grp = ed.selectedNodes()[0]; grp.name = 'Bracket'; const before = ed.doc.nodes.length;
  check('enter-group', ed.enterGroup(grp) === true && ed.doc.nodes.length === before + 1 && !!ed.editing);
  const extra = add('sphere', -180, 200);
  await ed.exitGroup();
  const again = ed.selectedNodes()[0];
  check('exit-group', !ed.editing && ed.doc.nodes.length === before && again && again.type === 'group' && again.children.length === 3 && again.name === 'Bracket', again && [again.type, again.children && again.children.length, again.name]);
  ed.deleteSelection();
}
// regression: flush, overlapping holes used to explode the mesh and crash the window
{
  const bb = add('box', 200, 200); ed.select([bb.id]); ed.setSize('x', 80); ed.setSize('y', 60);
  const h1 = add('cylinder-hole', 194, 200), h2 = add('cylinder-hole', 206, 200);
  ed.select([bb.id, h1.id, h2.id]); await ed.group('union');
  const gv = lib.geometry.getGeometry(ed.selectedNodes()[0]).attributes.position.count;
  out.flushHoleVerts = gv; check('flush-holes-mesh-size', gv > 100 && gv < 6000, gv);
  ed.deleteSelection();
}

// Thin strokes and counters must stay closed in the exported beveled mesh.
for (const label of ['IOB', 'g']) {
  const text = add('text', 200, 200);
  text.params.text = label;
  text.params.font = 'Sans';
  text.params.bevel = 1.5;
  ed.select([text.id]);
  const { data } = await lib.io.exportModel(ed, 'stl', { selectedOnly: true });
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const triangles = view.getUint32(80, true);
  const edges = new Map(), layers = new Set();
  let degenerate = 0;
  for (let i = 0; i < triangles; i++) {
    const offset = 84 + i * 50;
    if ([0, 4, 8].every((axis) => view.getFloat32(offset + axis, true) === 0)) degenerate++;
    const vertices = [12, 24, 36].map((vertex) => {
      const point = [0, 4, 8].map((axis) => view.getFloat32(offset + vertex + axis, true));
      layers.add(point[2]);
      return point.join(',');
    });
    for (let j = 0; j < 3; j++) {
      const a = vertices[j], b = vertices[(j + 1) % 3];
      const key = a < b ? a + ';' + b : b + ';' + a;
      const counts = edges.get(key) || [0, 0];
      counts[a < b ? 0 : 1]++;
      edges.set(key, counts);
    }
  }
  const openEdges = [...edges.values()].filter(([forward, reverse]) => forward !== 1 || reverse !== 1).length;
  check('beveled-text-stl-is-closed-' + label, triangles > 0 && openEdges === 0 && degenerate === 0, { openEdges, degenerate });
  check('beveled-text-stl-size-' + label, data.byteLength === 84 + triangles * 50);
  check('beveled-text-keeps-a-bevel-' + label, layers.size > 2, layers.size);
  ed.deleteSelection();
}

out.nodes = ed.doc.nodes.length; out.fails = fails; out.csg = lib.geometry.stats;
return out;
