// Regression checks for defects found in review: 3D group editing, laser G-code and SVG import, CNC design and machine control.
// Run: node tools/run.js --smoke=tools/smoke-regress.js --shots=<folder>
const app = window.dabble, ws = app.cnc, panel = ws.machinePanel, dev = ws.device;
const L = window.dabbleLib.laser, C = window.dabbleLib.cnc;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
const check = (name, cond, info) => { if (!cond) fails.push(name + (info !== undefined ? ' -> ' + JSON.stringify(info) : '')); };
const near = (a, b, eps = 0.02) => Math.abs(a - b) <= eps;
const errors = [];
window.addEventListener('error', (e) => errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => errors.push('rejection: ' + String(e.reason && e.reason.message ? e.reason.message : e.reason)));

// ---------------- 3D editor: a group left open is put back together before the design is left
{
  const ed = app.editor, S = window.dabbleLib.doc;
  const a = S.makeShape('box', { w: 20, d: 20, h: 20 }), b = S.makeShape('box', { w: 20, d: 20, h: 20 });
  b.matrix[12] = 10;
  ed.addNode(a, { select: false, commit: false }); ed.addNode(b, { select: false, commit: false });
  ed.selection = new Set([a.id, b.id]); ed.sync(); ed.commit();
  await ed.group('union');
  const g = ed.selectedNodes()[0];
  check('3d-grouped', g && g.type === 'group');
  g.round = 2; g.roundEdges = 'top'; g.shader = 'glossy'; ed.sync(); ed.commit();
  ed.enterGroup(g);
  check('3d-editing', !!ed.editing && ed.doc.nodes.length === 2);
  await ed.exitGroup();
  const g2 = ed.doc.nodes.find((n) => n.type === 'group');
  check('3d-group-keeps-rounding', g2 && g2.round === 2 && g2.roundEdges === 'top' && g2.shader === 'glossy', g2 && [g2.round, g2.roundEdges, g2.shader]);
  ed.enterGroup(g2);
  app._markDirty();
  check('3d-leave-closes-group', (await app.confirmLeave()) === true && !ed.editing);
  const saved = JSON.parse(await window.dabbleNative.loadDesign(app.designId));
  check('3d-saved-as-group', saved.nodes.length === 1 && saved.nodes[0].type === 'group', saved.nodes.map((n) => n.type));
  // align to one shape: the anchor stays put, is outlined, and the banner says so
  {
    const p = S.makeShape('box', { w: 10, d: 10, h: 10 }), q = S.makeShape('box', { w: 10, d: 10, h: 10 });
    p.matrix[12] = -80; q.matrix[12] = -50; q.matrix[13] = 30;
    ed.addNode(p, { select: false, commit: false }); ed.addNode(q, { select: false });
    ed.select([p.id, q.id]); ed.setTool('align');
    const px = ed.bounds([p]).min.x;
    ed.alignAnchor = p.id; ed.refreshOutlines(); ed.emit('selection');
    check('align-anchor-outlined', ed.meshes.get(p.id).userData.line.material.color.getHex() === 0xff8f1f && /orange/.test(app.banner.textContent), app.banner.textContent);
    ed.align('x', 'min');
    check('align-to-anchor', near(ed.bounds([p]).min.x, px, 1e-6) && near(ed.bounds([q]).min.x, px, 1e-6), [ed.bounds([p]).min.x, ed.bounds([q]).min.x]);
    ed.setTool('select');
    check('align-anchor-cleared', ed.alignAnchor === null && ed.meshes.get(p.id).userData.line.material.color.getHex() !== 0xff8f1f);
    ed.replaceNodes([p.id, q.id], [], { select: false });
  }
  // a new shape dropped on another lands on the face under the pointer; the height bar is drawn
  {
    ed.setFrame(null); ed.clearSelection();
    const base = S.makeShape('box', { w: 30, d: 30, h: 20 });
    ed.addNode(base, { select: false });
    const vp = ed.viewport, rect = vp.canvas.getBoundingClientRect();
    const bb = ed.bounds([base]);
    const at = (x, y, z) => vp.project(bb.max.clone().set(x, y, z), {});
    let lit = 0;
    const drop = (pt) => {
      const n = S.makeShape('box', { w: 10, d: 10, h: 10 });
      ed.beginPlace(n);
      const opt = { clientX: rect.left + pt.x, clientY: rect.top + pt.y, bubbles: true, button: 0, pointerId: 1 };
      window.dispatchEvent(new PointerEvent('pointermove', opt));
      const hl = ed._faceHL;
      lit = !!hl && hl.group.visible && hl.region.tris.size;
      vp.canvas.dispatchEvent(new PointerEvent('pointerdown', opt));
      return ed.doc.nodes.includes(n) ? n : null;
    };
    const top = drop(at((bb.min.x + bb.max.x) / 2, (bb.min.y + bb.max.y) / 2, bb.max.z));
    check('drop-face-highlighted', lit >= 1 && !ed._faceHL.group.visible, lit);
    check('drop-on-top-face', top && near(ed.bounds([top]).min.z, bb.max.z, 0.05), top && ed.bounds([top]).min.z);
    ed.select([base.id]); app.gizmo.layout();
    check('height-bar-shown', app.gizmo.hbar.style.display !== 'none' && parseFloat(app.gizmo.hbar.style.width) > 14, [app.gizmo.hbar.style.display, app.gizmo.hbar.style.width]);
    // Ctrl keeps a drop on the workplane even over a shape
    const n2 = S.makeShape('box', { w: 10, d: 10, h: 10 });
    ed.clearSelection(); app.gizmo.layout();
    ed.beginPlace(n2);
    const c2 = at((bb.min.x + bb.max.x) / 2, (bb.min.y + bb.max.y) / 2, bb.max.z);
    const o2 = { clientX: rect.left + c2.x, clientY: rect.top + c2.y, bubbles: true, button: 0, pointerId: 1, ctrlKey: true };
    window.dispatchEvent(new PointerEvent('pointermove', o2));
    vp.canvas.dispatchEvent(new PointerEvent('pointerdown', o2));
    const onPlate = ed.doc.nodes.includes(n2);
    check('drop-ctrl-on-workplane', onPlate && near(ed.bounds([n2]).min.z, 0, 0.05), onPlate && ed.bounds([n2]).min.z);
    ed.replaceNodes([base.id, ...(top ? [top.id] : []), ...(onPlate ? [n2.id] : [])], [], { select: false });
  }
  // generators at awkward sizes: a small thick-walled lid stays a lid, a short clip's hook stays on its arm
  {
    const Geo = window.dabbleLib.geometry;
    const size = (kind, params) => { const n = S.makeShape(kind, params); const g = Geo.getGeometry(n); g.computeBoundingBox(); return [g.boundingBox.max.x - g.boundingBox.min.x, g.boundingBox.max.y - g.boundingBox.min.y, g.boundingBox.max.z - g.boundingBox.min.z]; };
    const lid = size('lidbox', { width: 20, depth: 20, height: 20, wall: 5, radius: 0, lip: 4, clearance: 0.2, part: 'lid' });
    check('lidbox-thick-wall', near(lid[0], 20, 0.1) && near(lid[1], 20, 0.1), lid);
    const clip = size('snapclip', { length: 5, width: 6, thickness: 1.6, hook: 6, base: 0 });
    check('snapclip-short-arm', near(clip[0], 5, 0.1), clip);
  }
  // undo right after opening a group brings the whole group back: it is drawn solid, not as a ghost
  const g3 = ed.doc.nodes.find((n) => n.type === 'group');
  ed.enterGroup(g3); ed.undo();
  check('3d-undone-group-not-ghost', !!ed.node(g3.id) && ed.meshes.get(g3.id).userData.solidMaterial.opacity === 1, ed.node(g3.id) && ed.meshes.get(g3.id).userData.solidMaterial.opacity);
  await ed.exitGroup();
  // mesh mode: a separated piece comes and goes with its step, and Cancel leaves no copy behind
  const bx = S.makeShape('box', { w: 20, d: 20, h: 20 });
  bx.matrix[12] = 60;
  ed.addNode(bx);
  const mode = app.meshMode;
  const pickFace = () => { mode.refine(); mode.refine(); mode.generateGroups(30); mode.sel[0] = 1; mode._refreshOverlays(); mode.selectGroups(); return mode.selCount; };
  ed.select([bx.id]); app.meshPanel.enter('select'); await wait(80);
  check('mesh-mode-entered', mode.active);
  if (mode.active) {
    const n0 = ed.doc.nodes.length, face = pickFace();
    check('mesh-separate', face > 0 && !!mode.extract(0, true) && ed.doc.nodes.length === n0 + 1, [face, ed.doc.nodes.length - n0]);
    mode.undo(); check('mesh-separate-undo', ed.doc.nodes.length === n0, ed.doc.nodes.length - n0);
    mode.redo(); check('mesh-separate-redo', ed.doc.nodes.length === n0 + 1, ed.doc.nodes.length - n0);
    mode.selectAll(); check('mesh-separate-everything-refused', mode.extract(0, true) === null && ed.doc.nodes.length === n0 + 1);
    mode.exit(false); check('mesh-separate-cancel', ed.doc.nodes.length === n0 && !!ed.node(bx.id), ed.doc.nodes.length - n0);
    // reducing part of a mesh keeps its face groups, and leaves the reduced faces selected
    ed.select([bx.id]); app.meshPanel.enter('select'); await wait(80);
    const sc = pickFace(), nt = mode.M.t.length / 3;
    check('mesh-reduce-part', mode.reduce(50) === true && mode.M.t.length / 3 < nt && !!mode.M.g && mode.M.g.length === mode.M.t.length / 3 && mode.selCount > 0 && mode.selCount < sc, [sc, mode.selCount, nt, mode.M.t.length / 3, !!mode.M.g]);
    mode.exit(false);
  }
}

// ---------------- laser
{
  const G = L.gcode, M = L.model;
  const doc = M.newLaserDoc();
  doc.shapes.push(M.makeRect(1, 10, 10, 20, 20), M.makeRect(2, 50, 10, 20, 20));
  Object.assign(M.layerOf(doc, 1), { zOffset: -3 }); M.layerOf(doc, 2);
  const machine = G.machineOf({ zEnabled: true });
  const text = G.toGcode(G.planJob(doc, machine, () => null, {}), doc, machine);
  const zs = text.split('\n').filter((l) => /\bZ-?\d/.test(l));
  check('laser-z-restored', zs.length >= 2 && /Z-3/.test(zs[0]) && /Z0(\.0+)?\b/.test(zs[1]), zs);
  const plasma = G.machineOf({ flavor: 'plasma', framePower: 5 });
  const frame = G.frameGcode(G.planJob(doc, plasma, () => null, {}), doc, plasma, false);
  check('plasma-frame-no-torch', !/M3/.test(frame), frame);
  const laserFrame = G.frameGcode(G.planJob(doc, G.machineOf({ framePower: 5 }), () => null, {}), doc, G.machineOf({ framePower: 5 }), false);
  check('laser-frame-still-lit', /M3 S/.test(laserFrame));
  const IO = L.io;
  const s1 = IO.importSVG('<svg xmlns="http://www.w3.org/2000/svg" stroke-width="2" width="100mm" height="50mm" viewBox="0 0 1000 500"><rect x="0" y="0" width="1000" height="500" fill="none" stroke="black"/></svg>');
  const b1 = M.boundsOf(s1);
  check('svg-width-not-stroke-width', s1.length === 1 && near(b1.w, 100, 0.01) && near(b1.h, 50, 0.01), b1);
  const s2 = IO.importSVG('<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="0 0 100 100"><rect x="1" y="1" width="10" height="10" stroke="black" fill="none"/><rect display="none" x="20" y="1" width="10" height="10" stroke="black" fill="none"/><g style="display:none"><rect x="40" y="1" width="10" height="10" stroke="black" fill="none"/></g></svg>');
  check('svg-hidden-skipped', s2.length === 1, s2.length);
  const s3 = IO.importSVG('<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="0 0 100 100"><polyline points="0,0 10,0 10,10" stroke="red"/><polyline points="20,0 30,0 30,10" stroke="red" fill="blue"/><path d="M40 0h10v10z"/></svg>');
  // DXF: our own layer names come back onto the same layers
  const d2 = M.newLaserDoc();
  d2.shapes.push(M.makeRect(3, 10, 10, 20, 20), M.makeRect(7, 50, 10, 20, 20));
  const back = IO.importDXF(IO.exportDXF(d2, machine));
  check('dxf-keeps-layers', back.map((s) => s.layer).sort((a, b) => a - b).join() === '3,7', back.map((s) => s.layer));
  // a <symbol> nobody uses is not part of the drawing
  const s4 = IO.importSVG('<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="0 0 100 100"><symbol id="s"><rect x="1" y="1" width="10" height="10" stroke="black" fill="none"/></symbol><rect x="30" y="1" width="10" height="10" stroke="black" fill="none"/></svg>');
  check('svg-symbol-template-skipped', s4.length === 1, s4.length);
  // engraving at the edge: the overscan run-up leaves the work area, and that is said
  const edge = (x) => { const d = M.newLaserDoc(); d.shapes.push(M.makeRect(1, x, 10, 20, 20)); Object.assign(M.layerOf(d, 1), { mode: 'fill', overscan: 5 }); return G.planJob(d, G.machineOf({}), () => null, {}).warnings; };
  check('overscan-off-bed-warned', edge(0).some((w) => /overscan/i.test(w)), edge(0));
  check('overscan-inside-quiet', !edge(60).some((w) => /overscan|outside/i.test(w)), edge(60));
  check('svg-open-line-stays-open', s3.length === 3 && s3[0].subs[0].closed === false && s3[1].subs[0].closed === true && s3[2].subs[0].closed === true, s3.map((s) => s.subs[0].closed));
}

// ---------------- CNC design
document.querySelector('.btn[data-mode="cnc"]').click();
await wait(400);
const r1 = L.model.makeRect(0, 30, 30, 40, 30), r2 = L.model.makeRect(0, 100, 30, 40, 30);
ws.add([r1, r2]); ws.select([r1.id, r2.id]);
let tp = ws.addToolpath('profile');
ws._compute();
const count = () => ((ws.computed.get(tp.id) || {}).sections || []).reduce((n, s) => n + s.paths.length, 0);
check('cnc-two-paths', tp.shapes.length === 2 && count() === 2);
ws.group(); ws._compute();
check('cnc-group-keeps-toolpath', tp.shapes.length === 2 && count() === 2, [tp.shapes.length, count()]);
const gid = ws.sel[0];
ws.select([gid]); const tg = ws.addToolpath('pocket'); ws._compute();
ws.transform(L.model.translate(20, 10)); ws.commit(); ws._compute();
{
  const sec = ws.computed.get(tp.id).sections[0]; let x0 = 1e9; for (const p of sec.paths) for (const q of p.pts) x0 = Math.min(x0, q[0]);
  check('cnc-grouped-shapes-follow-group', near(x0, 50 - 3.175), x0);
}
ws.ungroup(); ws._compute();
check('cnc-ungroup-keeps-toolpaths', tp.shapes.length === 2 && count() === 2 && tg.shapes.length === 2 && ws.computed.get(tg.id).sections.length === 1, [tp.shapes, tg.shapes]);
ws.select([r1.id, r2.id]);
ws.transform(L.model.translate(0, 0)); // no-op, keeps selection
ws.doc.shapes.find((s) => s.id === r2.id).m = L.model.translate(60, 40); ws.commit(); // overlap the two
L.tools.boolean(ws, 'union'); ws._compute();
check('cnc-weld-keeps-toolpath', tp.shapes.length === 1 && tp.shapes[0] === ws.sel[0] && count() === 1, [tp.shapes, ws.sel, count()]);
ws.select(tp.shapes); ws.remove(); ws._compute();
check('cnc-delete-empties-toolpath', tp.shapes.length === 0 && count() === 0);
ws.undo(); ws._compute();
tp = ws.doc.toolpaths.find((t) => t.id === tp.id);
check('cnc-undo-restores', tp.shapes.length === 1 && count() === 1);
// property bar follows the units
ws.select(tp.shapes); ws.job.units = 'in'; ws.commit(); ws.anchor = 6; ws._renderProps();
{
  const b = L.model.boundsOf(ws.selected());
  const inputs = [...ws.propBar.querySelectorAll('input')];
  check('cnc-props-in-inches', near(parseFloat(inputs[2].value), b.w / 25.4, 0.001), [inputs[2].value, b.w]);
  inputs[2].value = '2'; inputs[2].dispatchEvent(new Event('change'));
  check('cnc-props-typed-inches', near(L.model.boundsOf(ws.selected()).w, 50.8, 0.01), L.model.boundsOf(ws.selected()).w);
}
ws.job.units = 'mm'; ws.commit();
// align to the shape picked last: it stays put and the other moves to it
{
  const keep = [...ws.sel];
  const k1 = L.model.makeRect(0, 10, 200, 20, 20), k2 = L.model.makeRect(0, 150, 240, 30, 30);
  ws.add([k1, k2]); ws.select([k1.id, k2.id]); ws.alignKey = k2.id;
  ws.align('x', 0);
  const b1 = L.model.boundsOf([ws.doc.shapes.find((s) => s.id === k1.id)]), b2 = L.model.boundsOf([ws.doc.shapes.find((s) => s.id === k2.id)]);
  check('2d-align-to-last-picked', near(b2.x0, 150) && near(b1.x0, 150), [b1.x0, b2.x0]);
  ws.select([k1.id, k2.id]); ws.align('x', 1);
  check('2d-box-selection-meets-at-edges', near(L.model.boundsOf([ws.doc.shapes.find((s) => s.id === k1.id)]).x0, 160), L.model.boundsOf([ws.doc.shapes.find((s) => s.id === k1.id)]).x0);
  ws.select([k1.id, k2.id]); ws.remove(); ws.select(keep);
}
// X and Y count from the job's XY zero, the rulers' units follow the job, and undo covers variable text
{
  const was = ws.job.xyZero, unitsWere = ws.job.units;
  ws.job.units = 'in'; ws.job.xyZero = 'c'; ws.commit(); ws.anchor = 6; ws._renderProps();
  const b = L.model.boundsOf(ws.selected()), [jx, jy] = ws.toJob([b.x0, b.y1]);
  const inputs = [...ws.propBar.querySelectorAll('input')];
  check('cnc-props-from-xy-zero', near(parseFloat(inputs[0].value), jx / 25.4, 0.001) && near(parseFloat(inputs[1].value), jy / 25.4, 0.001), [inputs[0].value, inputs[1].value, jx / 25.4, jy / 25.4]);
  inputs[0].value = '0'; inputs[0].dispatchEvent(new Event('change'));
  check('cnc-props-typed-from-xy-zero', near(L.model.boundsOf(ws.selected()).x0, ws.job.w / 2, 0.01), L.model.boundsOf(ws.selected()).x0);
  ws.machine.gridSnap = 2.54; ws.refresh();
  check('cnc-snap-in-job-units', /snap 0\.1 in/.test(ws.statusBar.textContent), ws.statusBar.textContent);
  ws.machine.gridSnap = 0;
  ws.job.xyZero = was; ws.job.units = unitsWere; ws.commit();
  ws.doc.variables = { serial: 5, step: 1, autoAdvance: true, csv: null, row: 0 }; ws.commit();
  ws.doc.variables.serial = 6; ws.commit();
  ws.undo();
  check('undo-covers-variable-text', ws.doc.variables && ws.doc.variables.serial === 5, ws.doc.variables);
  ws.undo();
  check('undo-removes-variable-text', !ws.doc.variables, ws.doc.variables);
}
// typed-but-not-entered text survives a redraw, and a pressed button is not pulled out from under the mouse
await wait(50);
{
  const f = ws.jobPanel.querySelector('[data-key="job-t"]');
  f.focus(); f.value = '45'; f.dispatchEvent(new Event('input', { bubbles: true }));
  ws._renderLayers(); await wait(40);
  const f2 = ws.jobPanel.querySelector('[data-key="job-t"]');
  check('cnc-typed-text-survives', f2.value === '45' && document.activeElement === f2, f2.value);
  f2.dispatchEvent(new FocusEvent('blur')); await wait(40);
  check('cnc-typed-text-commits', ws.job.t === 45, ws.job.t);
  ws.job.t = 18; ws.commit(); await wait(40);
  const btn = ws.outPanel.querySelector('.btn-primary');
  ws.side.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  ws._renderLayers(); await wait(40);
  check('cnc-button-survives-press', btn.isConnected);
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); await wait(160);
  check('cnc-redraw-after-release', !btn.isConnected);
}
// "More options" stays open
ws.tpSel = tp.id; ws.refresh(); await wait(40);
{
  const det = ws.tpPanel.querySelector('.cnc-more'); det.open = true; det.dispatchEvent(new Event('toggle'));
  ws._renderLayers(); await wait(40);
  check('cnc-more-stays-open', ws.tpPanel.querySelector('.cnc-more').open === true);
}
// Escape closes the preview even with the slider focused
ws.openPreview(); await wait(300);
ws.preview.slider.focus();
ws.preview.slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
check('cnc-escape-from-slider', !ws.previewEl.classList.contains('open'));
// a design loaded while the tab is closed is fitted when the tab opens
document.querySelector('.btn[data-mode="workspace-3d"]').click(); await wait(200);
{
  const d = JSON.parse(JSON.stringify(ws.getDoc())); d.job.w = 1200; d.job.h = 1200;
  ws.load(d);
  document.querySelector('.btn[data-mode="cnc"]').click(); await wait(300);
  const c = ws.toScreen([1200, 1200]);
  check('cnc-refit-on-open', c[0] < ws.w && c[1] < ws.h && c[0] > 0, [c, ws.w, ws.h]);
  d.job.w = 300; d.job.h = 300; ws.load(d); ws._compute();
}

// ---------------- CNC machine
ws.job.zZero = 'bed'; ws.job.units = 'in'; ws.commit(); ws._compute();
ws.sendToMachine(); await wait(400);
check('machine-stock-follows-z-zero', panel.program.stock.zTop === 18 && near(panel.program.parsed.stats.min[2], -0.3, 0.01), [panel.program.stock, panel.program.parsed.stats.min]);
const machine = new C.GrblSim({ speed: 1e9 });
await panel.connect(machine); await wait(1000);
check('queried-once', panel.consoleLog.textContent.split('[VER:').length === 2, panel.consoleLog.textContent.split('[VER:').length - 1);
// an inch job leaves the controller in inches; probing must still work in millimetres and then hand inches back
await dev.send('G20');
machine.probeAt = { x: null, y: null, z: -20 };
check('probe-in-inch-mode', !!(await C.wizards.probeZ(panel)));
await wait(500);
check('probe-mm-distances', near(dev.status.wco[2], -35) && near(dev.status.wpos[2], 20), [dev.status.wco, dev.status.wpos]);
await dev.send('$G', { echo: false });
check('inches-handed-back', /G20/.test(dev.modal) && /G90/.test(dev.modal), dev.modal);
await C.wizards.runMacro(panel, 'G91 G0 Z10\nG90'); await dev.idle(5000);
check('macro-in-mm', near(dev.status.wpos[2], 30), dev.status.wpos);
await dev.send('G21');
// a failed probe, then Home: absolute mode is restored there too
await dev.send('$22=1');
machine.probeAt.z = -999;
check('probe-fails', (await C.wizards.probeZ(panel)) === null); await wait(400);
await panel.home(); await wait(600);
await dev.send('$G', { echo: false });
check('home-restores-absolute', dev.status.state === 'Idle' && /G90/.test(dev.modal), [dev.status.state, dev.modal]);
// the same failed probe, cleared by typing $X in the console
machine.probeAt.z = -999;
check('probe-fails-again', (await C.wizards.probeZ(panel)) === null); await wait(400);
panel.consoleInput.value = '$X';
panel.consoleInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await wait(700);
await dev.send('$G', { echo: false });
check('console-unlock-restores-absolute', dev.status.state === 'Idle' && /G90/.test(dev.modal), [dev.status.state, dev.modal]);
machine.probeAt.z = -20;
// check mode: a job finishes
await dev.send('$C'); await wait(400);
panel.loadProgram({ name: 'check.gcode', text: 'G21 G90\nG1 X5 F100\nG1 X0\n' });
const checked = await Promise.race([panel.start({ confirm: false }), wait(4000).then(() => 'timeout')]);
check('check-mode-job-finishes', checked && checked.done === true, checked);
await dev.send('$C'); await wait(400);
// jogging: nothing may start by itself later, and a held key does not pile up moves
machine.speed = 1;
const homing = dev.send('$H');
await wait(150);
panel.step = 0; panel.jogStart([1, 0, 0]); panel.jogEnd();
check('no-jog-queued-behind-homing', !dev.manual.some((m) => m.line.startsWith('$J=')), dev.manual.map((m) => m.line));
await homing; await wait(600);
check('still-after-homing', dev.status.state === 'Idle' && near(dev.status.mpos[0], -1), [dev.status.state, dev.status.mpos]);
panel.step = 10; panel._renderSteps();
for (let i = 0; i < 40; i++) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', repeat: i > 0, bubbles: true, cancelable: true }));
check('key-repeat-does-not-pile-up', dev.manual.length + dev.inflight.length <= 2, [dev.manual.length, dev.inflight.length]);
dev.jogCancel(); await wait(500);
check('jog-cancel-leaves-sender-working', (await Promise.race([dev.send('G90'), wait(1500).then(() => 'timeout')])) === 'ok');
// soft limits on: a held jog asks only for the room there is
await dev.send('$20=1'); await dev.send('$$', { echo: false }); await wait(300);
panel.step = 0;
panel.jogStart([-1, 0, 0]); await wait(700);
check('hold-jog-with-soft-limits', dev.status.state === 'Jog', dev.status.state);
panel.jogEnd(); await wait(500);
check('hold-jog-stops', dev.status.state === 'Idle', dev.status.state);
await dev.send('$20=0');
// Stop waits until the machine has really stopped before resetting it (a reset while slowing down loses position: ALARM:3)
panel.loadProgram({ name: 'stop.gcode', text: 'G21 G90\nG1 X-300 F600\nG1 X-1\n' });
const halted = panel.start({ confirm: false });
await wait(800);
check('running-before-stop', dev.status.state === 'Run', dev.status.state);
dev.alarm = null;
await dev.stop(); await halted; await wait(500);
check('stop-waits-for-standstill', !(dev.alarm && dev.alarm.code === 3), dev.alarm);
if (dev.status.state === 'Alarm') await dev.send('$X');
await wait(300);
// disconnecting in the middle of a job stops the machine first
panel.loadProgram({ name: 'long.gcode', text: 'G21 G90\nG1 X-300 F600\nG1 X-1\n' });
const running = panel.start({ confirm: false });
await wait(800);
check('running', dev.status.state === 'Run', dev.status.state);
await panel.disconnect();
const ended = await running;
check('disconnect-stops-machine', ended && !ended.done && !machine.moving && machine.modal.spindle === 5, [ended, machine.moving]);
if (errors.length) fails.push('errors: ' + JSON.stringify(errors.slice(0, 6)));
return { fails };
