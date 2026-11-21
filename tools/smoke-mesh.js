// Mesh tools check, run inside the app:  node tools/run.js --smoke=tools/smoke-mesh.js
const app = window.dabble, ed = app.editor, vp = app.viewport;
const lib = window.dabbleLib, O = lib.meshops, A = lib.meshanalysis;
const { CATALOG, nodeFromCatalog } = lib.shapes;
const out = {}; const fails = [];
const near = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;
const check = (name, cond, info) => { if (!cond) fails.push(name + (info !== undefined ? ' -> ' + JSON.stringify(info) : '')); };
const add = (id, x, y) => { const n = nodeFromCatalog(CATALOG.find((c) => c.id === id)); ed.placeAt(n, x, y); ed.addNode(n); return n; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const V3 = vp.target.constructor;
const time = async (name, fn) => { const t0 = performance.now(); const r = await fn(); (out.ms ||= {})[name] = Math.round(performance.now() - t0); return r; };

// ---- conversion and inspection
const box = add('box', 0, 0);
const B = O.nodeToMesh(box);
let info = A.inspectMesh(B);
check('box-mesh', B.v.length === 24 && B.t.length === 36 && info.closed && near(info.volume, 8000, 0.01) && info.shells === 1 && info.genus === 0 && info.problems === 0, info);
const ball = add('sphere', 40, 0);
const S = O.nodeToMesh(ball);
const sphere = A.inspectMesh(S);
check('sphere-mesh', sphere.closed && sphere.genus === 0 && sphere.volume > 3800, sphere);
out.sphereTris = sphere.triangles;

// ---- subdivide, reduce, remesh, smooth
const sub = O.subdivide(B).mesh;
check('subdivide', sub.t.length === 144 && near(A.inspectMesh(sub).volume, 8000, 0.01) && A.inspectMesh(sub).closed, sub.t.length);
const half = await time('decimate', () => O.decimate(S, Math.round(sphere.triangles / 2)));
info = A.inspectMesh(half);
check('reduce', info.closed && info.triangles <= sphere.triangles / 2 + 2 && Math.abs(info.volume - sphere.volume) / sphere.volume < 0.06, [info.triangles, info.volume, sphere.volume]);
check('reduce-keeps-flat', near(A.inspectMesh(O.decimate(O.subdivide(sub).mesh, 12)).volume, 8000, 1) && O.decimate(O.subdivide(sub).mesh, 12).t.length / 3 <= 14, O.decimate(O.subdivide(sub).mesh, 12).t.length / 3);
const rem = await time('remesh', () => O.remesh(S, 2.5));
info = A.inspectMesh(rem);
check('remesh', info.closed && Math.abs(info.volume - sphere.volume) / sphere.volume < 0.08, [info.triangles, info.volume]);
const sm = O.smooth(O.subdivide(O.subdivide(B).mesh).mesh, { iterations: 6 });
info = A.inspectMesh(sm);
check('smooth', info.closed && Math.abs(info.volume - 8000) < 400, info.volume);
check('smooth-shrinks', A.inspectMesh(O.smooth(O.subdivide(O.subdivide(B).mesh).mesh, { iterations: 6, keepVolume: false })).volume < 7600);

// ---- holes, repair, cracks, orientation
const holed = O.subMesh(S, Uint8Array.from({ length: S.t.length / 3 }, (_, i) => (i % 40 === 0 ? 0 : 1)));
info = A.inspectMesh(holed);
check('holes-found', !info.closed && info.holes.length > 3, info.holes.length);
const filled = O.fillHoles(holed);
info = A.inspectMesh(filled.mesh);
check('fill-holes', info.closed && filled.filled > 3 && Math.abs(info.volume - sphere.volume) / sphere.volume < 0.02, [filled.filled, info.volume]);
const broken = O.flipNormals(holed, Uint8Array.from({ length: holed.t.length / 3 }, (_, i) => (i % 7 === 0 ? 1 : 0)));
const fixed = A.autoRepair(broken);
info = A.inspectMesh(fixed.mesh);
check('auto-repair', info.closed && !info.insideOut && info.problems === 0 && Math.abs(info.volume - sphere.volume) / sphere.volume < 0.02, [fixed.log, info.problems, info.volume]);
out.repairLog = fixed.log;
const soup = O.meshToSoup(B);
const cracked = O.soupToMesh(soup.positions.map((x, i) => (i < 9 ? x + 0.004 : x)), null, null, 1e-5);
check('crack-open', !A.inspectMesh(cracked).closed);
check('close-cracks', A.inspectMesh(O.closeCracks(cracked, 0.02).mesh).closed);
check('separate-shells', O.separateShells(O.mergeMeshes([B, S])).length === 2);
check('inside-out', A.inspectMesh(O.flipNormals(B)).insideOut === true && A.inspectMesh(O.orientConsistent(O.flipNormals(B)).mesh).insideOut === false);
check('face-groups', O.faceGroupsByAngle(B, 30).count === 6 && O.faceGroupsByAngle(S, 180).count === 1, O.faceGroupsByAngle(B, 30).count);

// ---- plane cut, mirror, extrude
const cut = O.planeCut(B, [0, 0, 1], 5, { keep: 'both' });
check('plane-cut', cut.length === 2 && near(A.inspectMesh(cut[0]).volume, 6000, 0.5) && near(A.inspectMesh(cut[1]).volume, 2000, 0.5) && A.inspectMesh(cut[0]).closed, cut.map((m) => A.inspectMesh(m).volume));
const openCut = O.planeCut(holed, [1, 0, 0], 40, { keep: 'above' });
check('plane-cut-open-mesh', openCut.length === 1 && openCut[0].t.length > 30 && O.meshBounds(openCut[0]).min[0] > 39.99, openCut.length);
info = A.inspectMesh(O.symmetrize(S, 0, true));
check('mirror', info.closed && Math.abs(info.volume - sphere.volume) / sphere.volume < 0.01, info.volume);
const top = Uint8Array.from({ length: 12 }, (_, i) => ([0, 1, 2].every((k) => B.v[B.t[i * 3 + k] * 3 + 2] > 19.9) ? 1 : 0));
const ext = O.extrudeFaces(B, top, 5);
info = A.inspectMesh(ext.mesh);
check('extrude', info.closed && near(info.volume, 10000, 0.5) && near(O.meshBounds(ext.mesh).max[2], 25, 1e-4), info.volume);
info = A.inspectMesh(O.thicken(O.subMesh(B, top), 2));
check('thicken', info.closed && near(info.volume, 800, 0.5), info.volume);

// ---- make solid, hollow, offset, tube, patterns, slices
const pos2 = O.cloneMesh(B); for (let i = 0; i < pos2.v.length; i += 3) pos2.v[i] += 10;
const both = O.mergeMeshes([B, pos2]);
const solid = await time('makeSolid', () => O.makeSolid(both, { resolution: 64 }));
info = A.inspectMesh(solid);
check('make-solid', info.closed && info.shells === 1 && Math.abs(info.volume - 12000) < 500, [info.volume, info.shells, info.triangles]);
const grown = O.makeSolid(B, { resolution: 48, offset: 2 });
check('offset', A.inspectMesh(grown).closed && O.meshBounds(grown).size.every((s) => Math.abs(s - 24) < 1), O.meshBounds(grown).size);
const shell = await time('hollow', () => O.hollow(B, { wall: 2, resolution: 48 }));
info = A.inspectMesh(shell);
check('hollow', info.closed && info.shells === 2 && Math.abs(info.volume - (8000 - 4096)) < 450, [info.volume, info.shells]);
info = A.inspectMesh(O.hollow(B, { wall: 2, resolution: 48, drains: 1, drainRadius: 2 }));
check('hollow-drain', info.closed && info.shells === 1 && info.genus === 0, [info.shells, info.genus]);
const drilled = O.addTube(B, [0, 0, 20], [0, 0, 0], 2, 2, 'cut');
info = A.inspectMesh(drilled);
check('tube-channel', info.closed && info.genus === 1 && Math.abs(info.volume - (8000 - Math.PI * 4 * 20)) < 8, [info.volume, info.genus]);
check('tube-rod', A.inspectMesh(O.addTube(B, [0, 0, 20], [0, 0, 35], 2, 1, 'add')).volume > 8050);
for (const [type] of O.PATTERNS) {
  const src = type === 'edges' || type === 'dual' ? S : B;
  let pat = null, err = null;
  try { pat = await time('pattern-' + type, () => O.makePattern(src, type, { size: 5, thickness: 1.5 })); } catch (e) { err = e.message; }
  info = pat ? A.inspectMesh(pat) : null;
  check('pattern-' + type, !!info && info.closed && info.triangles > 100 && info.volume > 20, err || info);
}
const slabs = O.makeSlices(B, { thickness: 5, axis: 2 });
check('slices', slabs.length === 4 && slabs.every((m) => near(A.inspectMesh(m).volume, 2000, 0.5)), slabs.length);
check('slices-x', O.makeSlices(B, { thickness: 4, axis: 0 }).length === 5 && near(O.meshBounds(O.makeSlices(B, { thickness: 4, axis: 0 })[0]).size[0], 4, 1e-3));

// ---- analysis
const th = A.thicknessField(shell, 10);
check('thickness', th.min > 1.3 && th.min < 2.7, th.min);
const ov = A.overhangFaces(S, 45);
check('overhangs', ov.area > 100 && ov.area < sphere.area / 2 && A.overhangFaces(B, 45).area === 0, ov.area);
const sup = await time('supports', () => A.buildSupports(S, { angle: 45, spacing: 4 }));
check('supports', !!sup && sup.count > 3 && A.inspectMesh(sup.mesh).volume > 5 && O.meshBounds(sup.mesh).min[2] > -0.01, sup && sup.count);
check('supports-none', A.buildSupports(B, { angle: 45, spacing: 4 }) === null);
const st = A.stability(B);
check('stability', st.stable && near(st.com[2], 10, 0.01) && near(st.volume, 8000, 0.01) && near(st.margin, 10, 0.01), st);
const lean = O.cloneMesh(B); for (let i = 0; i < lean.v.length; i += 3) lean.v[i] += lean.v[i + 2] * 1.5; // sheared far to one side
check('stability-tips', A.stability(lean).stable === false, A.stability(lean).margin);
const cone = O.nodeToMesh(nodeFromCatalog(CATALOG.find((c) => c.id === 'cone')));
const tip = O.cloneMesh(cone); for (let i = 2; i < tip.v.length; i += 3) tip.v[i] = -tip.v[i];
const best = A.bestOrientation(O.flipNormals(tip));
check('orientation', best.down[2] > 0.9 && best.contact > 300 && best.current.contact < 1, best);
check('orientation-keeps-good', A.bestOrientation(B).down[2] === -1);
const far = O.cloneMesh(B); for (let i = 0; i < far.v.length; i += 3) far.v[i] += 35;
check('clearance', near(A.clearance(B, far).distance, 15, 1e-3), A.clearance(B, far).distance);
const dev = A.deviation(S, half);
check('deviation', dev.max > 0 && dev.max < 1.2 && dev.mean < dev.max, dev);
const xs = O.crossSections(B, 20);
check('cross-sections', xs.length === 20 && xs.every((s) => near(s.area, 400, 0.01)), xs && xs[0]);
const packed = A.packRows([{ w: 50, d: 20 }, { w: 60, d: 30 }, { w: 80, d: 10 }], 120, 100, 5);
check('layout-pack', packed.fits && packed.pos.length === 3 && packed.width <= 120, packed);

// ---- painted meshes survive saving, and the panel commands go through undo
{
  const M = O.cloneMesh(S); M.c = new Float32Array(M.v.length).fill(0.25); M.g = new Int32Array(M.t.length / 3).fill(3);
  const node = O.meshNode(M, ball, { smooth: true });
  ed.addNode(node);
  const geo = lib.geometry.getGeometry(node);
  check('painted-geometry', !!geo.attributes.color && near(geo.attributes.color.getX(5), 0.25, 1e-6) && lib.doc.ownColors(node));
  const back = lib.doc.deserializeDoc(lib.doc.serializeDoc(ed.doc)).nodes.find((n) => n.id === node.id);
  check('painted-roundtrip', !!back && back.params.mesh.colors.length === node.params.mesh.colors.length && back.params.mesh.groups[0] === 3 && back.params.mesh.smooth === true && near(back.params.mesh.colors[10], 0.25, 1e-6));
  const again = O.nodeToMesh(back);
  check('painted-reload', !!again.c && !!again.g && again.g.length === again.t.length / 3 && again.t.length === M.t.length, [!!again.c, !!again.g]);
  const b0 = ed.bounds([node], true);
  check('mesh-node-placement', near(b0.min.z, O.meshBounds(S).min[2], 1e-3) && near(b0.max.x, O.meshBounds(S).max[0], 1e-3), [b0.min.z, b0.max.x]);
  ed.select([node.id]); ed.setColor('#00ff00');
  check('plain-colour-unpaints', !lib.doc.ownColors(ed.node(node.id)) && ed.node(node.id).params.mesh.groups.length > 0);
  ed.deleteSelection();
}
{
  ed.select([box.id]);
  const size0 = ed.bounds([box], true).getSize(new V3());
  const ok = await app.meshPanel.run((M) => O.subdivide(M).mesh, {});
  const now = ed.node(box.id), size1 = ed.bounds([now], true).getSize(new V3());
  check('panel-run', ok && now.kind === 'mesh' && now.params.mesh.positions.length === 48 * 9 && size0.distanceTo(size1) < 1e-3 && ed.selection.has(box.id), [now.kind, size1]);
  ed.undo(); check('panel-undo', ed.node(box.id).kind === 'box');
  ed.redo(); check('panel-redo', ed.node(box.id).kind === 'mesh');
  ed.undo();
  ed.select([box.id, ball.id]);
  await app.meshPanel.combine();
  check('combine', ed.selectedNodes().length === 1 && O.separateShells(O.nodeToMesh(ed.selectedNodes()[0])).length === 2);
  await app.meshPanel.separate();
  check('separate', ed.selectedNodes().length === 2, ed.selectedNodes().length);
  ed.undo(); ed.undo();
  check('undo-to-shapes', ed.node(box.id).kind === 'box' && ed.node(ball.id).kind === 'sphere');
  // shaders are a display setting only
  ed.select([box.id]); ed.patchSelection({ shader: 'wire' });
  check('shader', ed.meshes.get(box.id).material.wireframe === true && lib.doc.geomKey(ed.node(box.id)) === lib.doc.geomKey({ ...ed.node(box.id), shader: undefined }));
  ed.patchSelection({ shader: 'normals' }); check('shader-normals', ed.meshes.get(box.id).material.isMeshNormalMaterial === true);
  ed.patchSelection({ shader: undefined }); check('shader-default', ed.meshes.get(box.id).material.wireframe === false && !ed.meshes.get(box.id).material.isMeshNormalMaterial);
}

// ---- the panel
app.showSideTab('mesh'); await wait(50);
const labels = [...document.querySelectorAll('.mesh-pane .btn-label')].map((x) => x.textContent);
out.panelButtons = labels.length;
for (const want of ['Sculpt', 'Select faces', 'Mirror', 'Plane cut', 'Close cracks', 'Make solid', 'Hollow', 'Make pattern', 'Make slices', 'Separate shells', 'Add tube', 'Reduce', 'Remesh', 'Inspector', 'Measure', 'Stability', 'Strength', 'Thickness', 'Overhangs', 'Supports', 'Orientation', 'Layout', 'Deviation', 'Clearance']) check('panel-has-' + want, labels.includes(want));
check('panel-shaders', !!document.querySelector('.mesh-pane select[aria-label="Shader"]'));
ed.select([ball.id]);
await app.meshPanel.inspect(); await wait(50);
check('inspector-result', !!document.querySelector('.mesh-result') && /no problems/.test(document.querySelector('.mesh-result b').textContent), document.querySelector('.mesh-result') && document.querySelector('.mesh-result b').textContent);
app.meshPanel.setSlice(true, 8); check('slice-view', vp.renderer.clippingPlanes.length === 1 && vp.renderer.clippingPlanes[0].constant === 8);
app.meshPanel.setSlice(false); check('slice-view-off', vp.renderer.clippingPlanes.length === 0);
// measuring: two clicks on the workplane 30 mm apart
{
  vp.home(); await wait(450); vp.renderNow();
  const rect = vp.canvas.getBoundingClientRect();
  const scr = (x, y, z) => { const p = vp.project(new V3(x, y, z), {}); return { clientX: rect.left + p.x, clientY: rect.top + p.y }; };
  const click = (pt) => { for (const type of ['pointerdown', 'pointerup']) vp.canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 21, button: 0, buttons: 1, ...pt })); };
  const pending = app.meshPanel.measure(); await wait(30);
  check('measure-banner', /Measure/.test(document.querySelector('.mode-banner').textContent), document.querySelector('.mode-banner').textContent);
  click(scr(-60, -60, 0)); await wait(20); click(scr(-30, -60, 0)); await pending; await wait(30);
  const row = [...document.querySelectorAll('.mesh-result .stat-grid span')].map((x) => x.textContent);
  out.measure = row[1];
  check('measure', row[0] === 'Distance' && Math.abs(parseFloat(row[1]) - 30) < 0.6 && ed.tool === 'select', row.slice(0, 2));
  app.meshPanel.result = null; app.meshPanel.clearOverlay();
}
// orientation and layout act on the design
{
  const tipped = add('cone', -60, 60); ed.select([tipped.id]); ed.rotateSelection('x', 180); ed.dropToWorkplane();
  await app.meshPanel.orientation();
  const apex = O.nodeToMesh(ed.node(tipped.id)); let hi = -1, wide = 0;
  for (let i = 0; i < apex.v.length; i += 3) if (apex.v[i + 2] < 0.01) wide += 1; else hi = Math.max(hi, apex.v[i + 2]);
  check('orientation-applied', wide > 8 && near(O.meshBounds(apex).min[2], 0, 1e-3), [wide, hi]);
  ed.select([box.id, ball.id, tipped.id]);
  const res = A.packRows(ed.selectedNodes().map((n) => { const b = ed.bounds([n], true); return { w: b.max.x - b.min.x, d: b.max.y - b.min.y }; }), 200, 200, 4);
  check('layout-fits', res.fits);
  ed.select([tipped.id]); ed.deleteSelection();
}

// ---- sculpt mode
{
  ed.select([ball.id]);
  const mode = app.meshMode;
  app.meshPanel.enter('sculpt'); await wait(60);
  check('sculpt-enter', mode.active && ed.disabled && ed.selection.size === 0 && document.getElementById('app').classList.contains('mesh-mode') && ed.meshes.get(ball.id).visible === false);
  check('sculpt-banner', /Sculpting/.test(document.querySelector('.mode-banner').textContent));
  check('sculpt-ui', document.querySelectorAll('.brush').length === 13 && !!document.querySelector('.mesh-done'));
  mode.refine();
  const tris = mode.M.t.length / 3;
  check('sculpt-refine', tris === sphere.triangles * 4, tris);
  const bb0 = O.meshBounds(mode.M), topPt = [bb0.center[0], bb0.center[1], bb0.max[2]];
  mode.setBrush({ type: 'draw', size: 5, strength: 1, symmetry: false });
  mode.strokeAt([topPt, topPt, topPt]);
  const raised = O.meshBounds(mode.M).max[2];
  check('sculpt-draw', raised > bb0.max[2] + 0.5 && mode.dirty && mode.canUndo, [bb0.max[2], raised]);
  mode.undo(); check('sculpt-undo', near(O.meshBounds(mode.M).max[2], bb0.max[2], 1e-5) && mode.canRedo);
  mode.redo(); check('sculpt-redo', near(O.meshBounds(mode.M).max[2], raised, 1e-5));
  mode.strokeAt([topPt], { sign: -1 }); check('sculpt-invert', O.meshBounds(mode.M).max[2] < raised);
  const before = O.meshBounds(mode.M).max[2];
  mode.strokeAt([[topPt[0], topPt[1], before], [topPt[0], topPt[1], before]], { type: 'smooth' });
  check('sculpt-smooth', O.meshBounds(mode.M).max[2] <= before + 1e-6);
  for (const [type] of [['draw2'], ['inflate'], ['flatten'], ['pinch'], ['spike'], ['shrink'], ['bubble'], ['attract'], ['drag']]) {
    const v0 = Float32Array.from(mode.M.v);
    mode.strokeAt([[bb0.max[0], bb0.center[1], bb0.center[2]], [bb0.max[0], bb0.center[1] + 1, bb0.center[2] + 1]], { type });
    let moved = 0; for (let i = 0; i < v0.length; i++) if (Math.abs(v0[i] - mode.M.v[i]) > 1e-6) moved += 1;
    check('brush-' + type, (type === 'attract' ? moved >= 0 : moved > 0) && mode.M.v.every((x) => isFinite(x)), moved);
  }
  // symmetry: a dab on the right is repeated on the left
  mode.setBrush({ symmetry: true, type: 'inflate', size: 4 });
  const left0 = O.meshBounds(mode.M).min[0];
  mode.strokeAt([[bb0.max[0], bb0.center[1], bb0.center[2]], [bb0.max[0], bb0.center[1], bb0.center[2]]]);
  check('sculpt-symmetry', O.meshBounds(mode.M).min[0] < left0 - 0.05, [left0, O.meshBounds(mode.M).min[0]]);
  mode.setBrush({ symmetry: false });
  // painting
  mode.setBrush({ type: 'paint', color: '#0000ff', strength: 1, size: 6 });
  mode.strokeAt([topPt, topPt]);
  check('sculpt-paint', mode.colored === true);
  // a real pointer stroke across the middle of the view
  vp.fit(ed.worldBounds([ed.node(ball.id)])); await wait(450); vp.renderNow();
  const rect = vp.canvas.getBoundingClientRect();
  const scr = (x, y, z) => { const p = vp.project(new V3(x, y, z), {}); return { clientX: rect.left + p.x, clientY: rect.top + p.y }; };
  const fire = (type, pt, extra = {}) => vp.canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 31, button: 0, buttons: 1, ...pt, ...extra }));
  mode.setBrush({ type: 'draw', size: 4, strength: 0.8 });
  const c = bb0.center, undoCount = mode.undoStack.length, vBefore = Float32Array.from(mode.M.v);
  const p0 = scr(c[0], c[1], c[2] + 2), p1 = scr(c[0], c[1], c[2] - 4);
  fire('pointerdown', p0); fire('pointermove', { clientX: (p0.clientX + p1.clientX) / 2, clientY: (p0.clientY + p1.clientY) / 2 }); fire('pointermove', p1); fire('pointerup', p1);
  let moved = 0; for (let i = 0; i < vBefore.length; i++) if (Math.abs(vBefore[i] - mode.M.v[i]) > 1e-6) moved += 1;
  check('sculpt-pointer-stroke', moved > 10 && mode.undoStack.length === undoCount + 1, [moved, mode.undoStack.length - undoCount]);
  fire('pointerdown', p0, { button: 0 }); fire('pointerup', p0);
  // keyboard: Ctrl+Z belongs to the brush strokes, not to the design
  const docNodes = ed.doc.nodes.length, stack = mode.undoStack.length;
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
  check('sculpt-key-undo', mode.undoStack.length === stack - 1 && ed.doc.nodes.length === docNodes);
  if (window.__shotDir && window.dabbleNative) { vp.renderNow(); await wait(300); await window.dabbleNative.smokeShot(window.__shotDir + '/sculpt.png'); }
  await app.exitMeshMode(true); await wait(40);
  const done = ed.node(ball.id);
  check('sculpt-done', !mode.active && !ed.disabled && done.kind === 'mesh' && done.params.mesh.smooth === true && !!done.params.mesh.colors && ed.selection.has(ball.id) && ed.meshes.get(ball.id).visible && !document.getElementById('app').classList.contains('mesh-mode'), done.kind);
  check('sculpt-result-closed', A.inspectMesh(O.nodeToMesh(done)).closed);
  ed.undo(); check('sculpt-design-undo', ed.node(ball.id).kind === 'sphere');
}

// ---- face selection mode
{
  ed.select([box.id]);
  const mode = app.meshMode;
  app.meshPanel.enter('select'); await wait(60);
  check('select-enter', mode.active && mode.sub === 'select' && document.querySelectorAll('.mesh-pane .segmented').length >= 2);
  mode.refine(); mode.refine();
  check('select-refined', mode.M.t.length / 3 === 192);
  mode.setBrush({ size: 4 });
  const topTri = (() => { for (let i = 0; i < mode.M.t.length / 3; i++) if ([0, 1, 2].every((k) => mode.M.v[mode.M.t[i * 3 + k] * 3 + 2] > 19.9)) return i; return -1; })();
  mode.selectTriangles(new V3(0, 0, 20), topTri, 1);
  check('select-brush', mode.selCount > 0 && mode.selCount < 192 && mode.selMesh.visible, mode.selCount);
  const few = mode.selCount;
  mode.selectGrow(false); check('select-grow', mode.selCount > few, mode.selCount);
  mode.selectGrow(true); check('select-shrink', mode.selCount <= few && mode.selCount >= 0, mode.selCount);
  mode.selectAll(); check('select-all', mode.selCount === 192);
  mode.selectInvert(); check('select-invert', mode.selCount === 0);
  mode.generateGroups(30); check('select-groups-made', !!mode.M.g && mode.showGroups && mode.groupMesh.visible);
  mode.sel[topTri] = 1; mode._refreshOverlays(); mode.selectGroups();
  check('select-to-groups', mode.selCount === 32, mode.selCount);
  check('select-extrude', mode.extrude(5) === true && near(O.meshBounds(mode.M).max[2], 25, 1e-4) && near(A.inspectMesh(mode.M).volume, 10000, 0.5) && mode.selCount === 32, [O.meshBounds(mode.M).max[2], mode.selCount]);
  mode.undo(); check('select-edit-undo', near(O.meshBounds(mode.M).max[2], 20, 1e-4));
  mode.redo();
  check('select-transform', mode.transformFaces({ move: [0, 0, 3] }) && near(O.meshBounds(mode.M).max[2], 28, 1e-4));
  check('select-soft-transform', mode.transformFaces({ move: [0, 0, 2], soft: 8 }) && near(O.meshBounds(mode.M).max[2], 30, 1e-4) && A.inspectMesh(mode.M).closed);
  const nodesBefore = ed.doc.nodes.length;
  const part = mode.extract(1, false);
  check('select-extract', !!part && ed.doc.nodes.length === nodesBefore + 1 && A.inspectMesh(O.nodeToMesh(part)).closed && ed.meshes.get(box.id).visible === false, ed.doc.nodes.length - nodesBefore);
  check('select-discard', mode.discard() === true && !A.inspectMesh(mode.M).closed);
  check('select-fill', mode.fillHoles() === true && A.inspectMesh(mode.M).closed);
  mode.selectNone(); mode.selectTriangles(new V3(10, 0, 10), (() => { for (let i = 0; i < mode.M.t.length / 3; i++) if ([0, 1, 2].every((k) => mode.M.v[mode.M.t[i * 3 + k] * 3] > 9.9)) return i; return 0; })(), 1);
  mode.selectGrow(false);
  const cnt = mode.selCount;
  check('select-erase-fill', cnt > 3 && mode.eraseAndFill() === true && A.inspectMesh(mode.M).closed && mode.selCount > 0, [cnt, mode.selCount]);
  mode.selectNone();
  const n0 = mode.M.t.length / 3;
  check('select-reduce-all', mode.reduce(50) && mode.M.t.length / 3 <= n0 / 2 + 2 && A.inspectMesh(mode.M).closed, [n0, mode.M.t.length / 3]);
  mode.refine(); mode.selectTriangles(new V3(0, -10, 10), (() => { for (let i = 0; i < mode.M.t.length / 3; i++) if ([0, 1, 2].every((k) => mode.M.v[mode.M.t[i * 3 + k] * 3 + 1] < -9.9)) return i; return 0; })(), 1);
  mode.selectGrow(false);
  const n1 = mode.M.t.length / 3, picked = mode.selCount;
  check('select-reduce-part', picked > 4 && mode.reduce(40) && mode.M.t.length / 3 < n1 && A.inspectMesh(mode.M).closed, [picked, n1, mode.M.t.length / 3, A.inspectMesh(mode.M).boundaryEdges]);
  // lasso over the whole view takes every front-facing triangle
  vp.renderNow();
  mode.selectNone(); mode.selectInPolygon([[0, 0], [vp.width, 0], [vp.width, vp.height], [0, vp.height]], 1); mode._refreshOverlays();
  check('select-lasso', mode.selCount > 4 && mode.selCount < mode.M.t.length / 3, [mode.selCount, mode.M.t.length / 3]);
  check('select-flip', mode.flip() === true);
  mode.undo();
  if (window.__shotDir && window.dabbleNative) { vp.renderNow(); await wait(300); await window.dabbleNative.smokeShot(window.__shotDir + '/select.png'); }
  // Esc with unsaved changes asks first; here the answer is to discard
  const leaving = app.exitMeshMode(false); await wait(80);
  const confirmBtn = [...document.querySelectorAll('.modal .btn-danger')].find((b) => /Discard/.test(b.textContent));
  check('cancel-asks', !!confirmBtn);
  if (confirmBtn) confirmBtn.click();
  await leaving; await wait(40);
  check('select-cancel', !mode.active && ed.node(box.id).kind === 'box' && ed.meshes.get(box.id).visible === true, ed.node(box.id).kind);
}

out.nodes = ed.doc.nodes.length; out.fails = fails;
return out;
