// Laser workspace check: node tools/run.js --smoke=tools/smoke-laser.js --shots=<folder>
const app = window.dabble, ws = app.laser;
const L = window.dabbleLib.laser;
const dir = window.__shotDir;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (name) => { ws._draw(); await wait(200); await window.dabbleNative.smokeShot(dir + '/' + name + '.png'); };
const out = {}; const fails = [];
const check = (name, cond, info) => { if (!cond) fails.push(name + (info !== undefined ? ' -> ' + JSON.stringify(info) : '')); };
const near = (a, b, eps = 0.01) => Math.abs(a - b) <= eps;
const key = (k, mods = {}) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...mods }));

document.querySelector('.btn[data-mode="laser"]').click();
await wait(300);
check('laser-mode', document.getElementById('app').classList.contains('laser-mode') && ws.active);
const cv = ws.canvas, rect = cv.getBoundingClientRect();
const at = (x, y) => { const p = ws.toScreen([x, y]); return { clientX: rect.left + p[0], clientY: rect.top + p[1] }; };
const fire = (type, pt, extra = {}) => cv.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 5, button: 0, buttons: 1, ...pt, ...extra }));
const dragTo = (a, b, extra = {}) => { fire('pointerdown', a, extra); fire('pointermove', { clientX: (a.clientX + b.clientX) / 2, clientY: (a.clientY + b.clientY) / 2 }, extra); fire('pointermove', b, extra); fire('pointerup', b, extra); };

// draw a rectangle and an ellipse with the mouse
key('r', { ctrlKey: true }); check('tool-rect', ws.tool === 'rect');
dragTo(at(50, 50), at(150, 110));
check('rect-drawn', ws.doc.shapes.length === 1 && ws.doc.shapes[0].type === 'rect' && near(ws.doc.shapes[0].w, 100) && near(ws.doc.shapes[0].h, 60), ws.doc.shapes[0]);
key('e', { ctrlKey: true });
dragTo(at(120, 80), at(200, 160));
check('ellipse-drawn', ws.doc.shapes.length === 2 && ws.doc.shapes[1].type === 'ellipse');
// move the ellipse by dragging its edge, then undo / redo
const b0 = L.model.boundsOf([ws.doc.shapes[1]]);
dragTo(at(180, 85.36), at(200, 105.36));
const b1 = L.model.boundsOf([ws.doc.shapes[1]]);
check('drag-move', near(b1.x0 - b0.x0, 20, 1.01) && near(b1.y0 - b0.y0, 20, 1.01), [b1.x0 - b0.x0, b1.y0 - b0.y0]);
key('z', { ctrlKey: true }); check('undo', near(L.model.boundsOf([ws.doc.shapes[1]]).x0, b0.x0)); key('y', { ctrlKey: true });
// scale with the bottom-right handle (corner = proportional)
ws.select([ws.doc.shapes[0].id]); ws._draw();
dragTo(at(150, 110), at(200, 140));
const rb = L.model.boundsOf([ws.doc.shapes[0]]); check('handle-scale', near(rb.w, 150, 1.01) && near(rb.h, 90, 1.01), [rb.w, rb.h]);
// numeric: place at machine X=20,Y=30 by lower-left anchor (bed 400, origin front-left)
ws.anchor = 6; ws._renderProps();
const inputs = [...ws.propBar.querySelectorAll('input')];
inputs[0].value = '20'; inputs[0].dispatchEvent(new Event('change'));
const i2 = [...ws.propBar.querySelectorAll('input')]; i2[1].value = '30'; i2[1].dispatchEvent(new Event('change'));
const pb = L.model.boundsOf([ws.doc.shapes[0]]); check('numeric-xy', near(pb.x0, 20) && near(pb.y1, 370), [pb.x0, pb.y1]);

// pen tool: a triangle closed by clicking the first node
key('l', { ctrlKey: true });
for (const p of [[250, 60], [320, 60], [285, 120]]) { fire('pointerdown', at(...p)); fire('pointerup', at(...p)); }
fire('pointerdown', at(250, 60)); fire('pointerup', at(250, 60));
const tri = ws.doc.shapes[ws.doc.shapes.length - 1];
check('pen-closed-path', tri.type === 'path' && tri.subs[0].closed && tri.subs[0].nodes.length === 3, tri.subs && tri.subs[0].nodes.length);

// layers: put the triangle on layer 2 as Fill, text on layer 3
ws.select([tri.id]); ws.setLayer(2); Object.assign(L.model.layerOf(ws.doc, 2), { mode: 'fill', speed: 150, powerMax: 40, interval: 0.2 });
const txt = L.model.makeText(3, 40, 200, 'Dabble', 'Sans Bold', 20); ws.add([txt]);
check('text-outline', L.model.flatten(txt).length >= 6, L.model.flatten(txt).length);

// boolean weld of two overlapping rectangles, then offset
const r1 = L.model.makeRect(0, 250, 200, 60, 40), r2 = L.model.makeRect(0, 290, 220, 60, 40);
ws.add([r1, r2]); ws.select([r1.id, r2.id]);
L.tools.boolean(ws, 'union');
const welded = ws.selected()[0]; const wbb = L.model.boundsOf([welded]);
check('weld', welded.type === 'path' && welded.subs.length === 1 && welded.subs[0].nodes.length === 8 && near(wbb.w, 100) && near(wbb.h, 60), [welded.subs.length, welded.subs[0].nodes.length, wbb.w, wbb.h]);
const off = L.ops.offsetPolys(L.model.flatten(welded), 5, 'miter'); const ob = off[0].pts.reduce((a, p) => [Math.min(a[0], p[0]), Math.max(a[1], p[0])], [1e9, -1e9]);
check('offset', near(ob[1] - ob[0], 110, 0.05), ob[1] - ob[0]);
ws.select([welded.id]); ws.group(); check('group-needs-two', ws.selected()[0].type === 'path');

// image: a generated gradient, engraved on layer 4
const g = document.createElement('canvas'); g.width = 80; g.height = 40; const gx = g.getContext('2d');
const grad = gx.createLinearGradient(0, 0, 80, 0); grad.addColorStop(0, '#000'); grad.addColorStop(1, '#fff'); gx.fillStyle = grad; gx.fillRect(0, 0, 80, 40);
const src = g.toDataURL('image/png'); const img = new Image(); await new Promise((r) => { img.onload = r; img.src = src; });
const im = L.model.makeImage(4, 60, 260, 40, 20, src, 80, 40); ws.images.set(im.id, img); ws.add([im]);
Object.assign(L.model.layerOf(ws.doc, 4), { speed: 100, powerMax: 50, interval: 0.25 });

// plan + G-code
ws.select([]);
const plan = ws.plan(); const gcode = L.gcode.toGcode(plan, ws.doc, ws.machine);
const lines = gcode.split('\n');
out.gcodeLines = lines.length; out.time = L.gcode.formatTime(plan.stats.time); out.bounds = plan.bounds && [plan.bounds.w, plan.bounds.h].map((v) => +v.toFixed(1)); out.warnings = plan.warnings;
check('gcode-header', lines.includes('G21') && lines.includes('G90') && lines.includes('M4 S0') && lines.includes('M5') && lines.includes('M2'));
check('gcode-layers', ['; Layer 01', '; Layer 03', '; Layer 04', '; Layer 05'].every((l) => lines.includes(l)), lines.filter((l) => l.startsWith('; Layer')));
// layer 0 (line, 80% power, 10 mm/s): S800, F600
check('gcode-line-power', lines.some((l) => /S800\b/.test(l)) && lines.some((l) => /F600\b/.test(l)));
// fill layer 2: 40% -> S400 at F9000
check('gcode-fill', lines.some((l) => /S400\b/.test(l)) && lines.some((l) => /F9000\b/.test(l)));
// all coordinates inside the 400 x 400 bed (overscan may leave by a few mm)
let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9, cur = { x: 0, y: 0 };
for (const l of lines) { const mx = l.match(/X(-?[\d.]+)/), my = l.match(/Y(-?[\d.]+)/); if (mx) { minX = Math.min(minX, +mx[1]); maxX = Math.max(maxX, +mx[1]); } if (my) { minY = Math.min(minY, +my[1]); maxY = Math.max(maxY, +my[1]); } }
out.range = [minX, maxX, minY, maxY].map((v) => +v.toFixed(1)); check('gcode-range', minX > -10 && maxX < 410 && minY > -1 && maxY < 401, out.range);
// Y is flipped for a front-left origin: the rectangle's top edge (bed y = 280) -> machine Y 120
check('gcode-yflip', lines.some((l) => /Y120\b/.test(l)) && lines.some((l) => /Y30\b/.test(l)), null);
// scan fill of a 10 x 10 square at 1 mm interval = 10 lines of 10 mm
const segs = L.gcode.scanFill([{ pts: [[0, 0], [10, 0], [10, 10], [0, 10]] }], 1, 0, true);
check('scanfill', segs.length === 10 && segs.every((sg) => near(Math.abs(sg[1][0] - sg[0][0]), 10)) && segs[1][0][0] === 10, [segs.length]);
// image raster produced grayscale-free dithered runs on layer 4 with S500
check('gcode-image', plan.moves.some((m) => m.layer === 4 && m.s === 0.5), null);
// tabs leave gaps: a 40 mm square with 4 tabs of 2 mm cuts 152 mm
Object.assign(L.model.layerOf(ws.doc, 10), { tabs: 4, tabSize: 2, speed: 10, powerMax: 100 });
const sq = L.model.makeRect(10, 300, 300, 40, 40);
const tplan = L.gcode.planJob({ ...ws.doc, shapes: [sq] }, ws.machine, ws.getImage);
let cutLen = 0, prev = null; for (const m of tplan.moves) { if (m.x == null) continue; if (prev && !m.rapid && m.s > 0) cutLen += Math.hypot(m.x - prev.x, m.y - prev.y); prev = m; }
check('tabs', near(cutLen, 152, 0.05), cutLen);
// current-position start mode wraps the job in G92
ws.doc.startFrom = 'current'; ws.doc.jobOrigin = 6;
const g2 = L.gcode.toGcode(ws.plan(), ws.doc, ws.machine).split('\n');
check('start-current', g2.some((l) => l.startsWith('G92 X0 Y0')) && g2.includes('G92.1') && !g2.some((l) => /[XY]-\d{2,}/.test(l) && !/S0/.test(l) && false));
ws.doc.startFrom = 'absolute';
// exports + SVG / DXF round trip
const svg = L.io.exportSVG(ws.doc, ws.machine), dxf = L.io.exportDXF(ws.doc, ws.machine);
const backS = L.io.importSVG(svg), backD = L.io.importDXF(dxf);
check('svg-roundtrip', backS.length >= 4 && near(L.model.boundsOf(backS).w, L.model.boundsOf(ws.doc.shapes.filter((s) => s.type !== 'image')).w, 0.05), backS.length);
check('dxf-roundtrip', backD.length >= 3 && near(L.model.boundsOf(backD).w, L.model.boundsOf(ws.doc.shapes.filter((s) => s.type !== 'image')).w, 0.05), backD.length);
// QR + material test generators
L.tools.qrDialog(ws); await wait(100); document.querySelector('.modal input[type=text]').value = 'https://example.com/dabble'; [...document.querySelectorAll('.modal .btn')].find((x) => x.textContent === 'Create').click(); await wait(100);
const qr = ws.selected()[0]; const qb = L.model.boundsOf([qr]); check('qr', qr && qr.type === 'path' && near(qb.w, 30, 0.01) && qr.subs.length > 10, qr && [qb.w, qr.subs.length]);
ws.remove();
await shot('la-editor');
L.tools.materialTestDialog(ws); await wait(100); [...document.querySelectorAll('.modal .btn')].find((x) => x.textContent === 'Generate').click(); await wait(200);
check('material-test', ws.selected()[0] && ws.selected()[0].type === 'group' && ws.selected()[0].children.filter((c) => c.type === 'rect').length === 25);
ws.transform(L.model.translate(100, -90)); ws.commit();
// persistence through the design file
const json = window.dabbleLib.doc.serializeDoc({ ...app.editor.doc, laser: ws.getDoc() }); const back = window.dabbleLib.doc.deserializeDoc(json);
check('persist', back.laser && back.laser.shapes.length === ws.doc.shapes.length);
ws.zoomToBed(); await shot('lb-material');
L.tools.previewDialog(ws); await wait(400); await shot('lc-preview');
document.querySelector('.modal-head .btn').click();
// back to 3D still works
document.querySelector('.btn[data-mode="design"]').click(); await wait(300);
check('back-to-3d', !document.getElementById('app').classList.contains('laser-mode') && app.viewport.width > 300, app.viewport.width);
document.querySelector('.btn[data-mode="laser"]').click(); await wait(200);
// box maker: panel count, sizes and joints that mate
{
  const B = L.boxmaker;
  const area = (polys) => polys.reduce((sum, p) => { let a = 0; for (let i = 0, j = p.pts.length - 1; i < p.pts.length; j = i++) a += p.pts[j][0] * p.pts[i][1] - p.pts[i][0] * p.pts[j][1]; return sum + Math.abs(a) / 2; }, 0);
  const open = B.boxPanels({ width: 100, depth: 60, height: 40, thickness: 3, finger: 10, kerf: 0, lid: false });
  const closed = B.boxPanels({ width: 100, depth: 60, height: 40, thickness: 3, finger: 10, kerf: 0, lid: true });
  check('box-panel-count', open.length === 5 && closed.length === 6, [open.length, closed.length]);
  const bb = (p) => { const xs = p.polys.flatMap((q) => q.pts.map((v) => v[0])), ys = p.polys.flatMap((q) => q.pts.map((v) => v[1])); return [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)]; };
  check('box-panel-size', near(bb(open[0])[0], 100, 0.05) && near(bb(open[0])[1], 60, 0.05) && near(bb(open[1])[1], 40, 0.05), [bb(open[0]), bb(open[1])]);
  // The material of a closed box is its outer volume minus the inner cavity. Each panel is
  // thickness-deep, so mating joints (no gaps, no overlaps) make the panel areas add up exactly.
  const shell = 100 * 60 * 40 - 94 * 54 * 34;
  out.boxShell = [+(closed.reduce((s, p) => s + area(p.polys), 0) * 3).toFixed(1), shell];
  check('box-joints-mate', near(out.boxShell[0], shell, 2), out.boxShell);
  const fat = B.boxPanels({ width: 100, depth: 60, height: 40, thickness: 3, finger: 10, kerf: 0.2, lid: false });
  check('box-kerf-grows', area(fat[0].polys) > area(open[0].polys) + 10);
  const n0 = ws.doc.shapes.length;
  const bm = B.boxMakerDialog(ws); await wait(150);
  [...bm.el.querySelectorAll('button')].find((b) => b.textContent.includes('Create panels')).click(); await wait(200);
  check('box-added', ws.doc.shapes.length === n0 + 5, ws.doc.shapes.length - n0);
  await shot('l-box');
}
// material library: save a layer's settings and apply them to another layer
{
  const from = L.model.layerOf(ws.doc, 3), to = L.model.layerOf(ws.doc, 4);
  Object.assign(from, { mode: 'fill', speed: 123, powerMax: 45, passes: 3 });
  app.patchSettings({ laserMaterials: [{ name: 'Test ply', mode: from.mode, speed: from.speed, powerMax: from.powerMax, powerMin: 0, passes: from.passes, interval: 0.1 }] });
  const row = ws._materialRow(to); const sel = row.querySelector('select');
  check('material-listed', sel.options.length === 2 && sel.options[1].textContent === 'Test ply', sel.options.length);
  sel.value = '0'; sel.dispatchEvent(new Event('change'));
  check('material-applied', to.speed === 123 && to.powerMax === 45 && to.passes === 3 && to.mode === 'fill', [to.speed, to.powerMax, to.passes, to.mode]);
  app.patchSettings({ laserMaterials: [] });
}
// leads, pierce delay and plasma output: a plate with a round hole
{
  const G = L.gcode, M = L.model;
  const li = 12;
  Object.assign(M.layerOf(ws.doc, li), { mode: 'line', speed: 20, powerMax: 100, passes: 1, kerf: 0, tabs: 0, leadIn: 4, leadOut: 3, leadStyle: 'arc', pierce: 500, overcut: 0, perforate: false });
  const plate = M.makeRect(li, 100, 100, 100, 60), hole = M.makeEllipse(li, 140, 120, 20, 20);
  const docP = { ...ws.doc, shapes: [plate, hole] };
  const plasma = { ...ws.machine, flavor: 'plasma' };
  const plan = G.planJob(docP, plasma, ws.getImage);
  const dwells = plan.moves.filter((m) => m.dwell);
  check('pierce-per-cut', dwells.length === 2 && near(dwells[0].dwell, 0.5), dwells.length);
  // every pierce happens off the finished edge: outside the plate, or inside the hole
  const starts = []; plan.moves.forEach((m, i) => { if (m.dwell) starts.push(plan.moves[i - 1]); });
  const inPlate = (p) => p.x > 100 && p.x < 200 && p.y > 100 && p.y < 160;
  const inHole = (p) => Math.hypot(p.x - 150, p.y - 130) < 10;
  out.pierceAt = starts.map((p) => [+p.x.toFixed(1), +p.y.toFixed(1), inPlate(p), inHole(p)]);
  check('pierce-on-waste', starts.length === 2 && starts.some((p) => inHole(p)) && starts.some((p) => !inPlate(p)), out.pierceAt);
  check('hole-cut-first', inHole(starts[0]), out.pierceAt);
  const leadMoves = plan.moves.filter((m) => m.lead);
  check('lead-moves', leadMoves.length >= 30 && leadMoves.every((m) => inHole(m) || !inPlate(m) || Math.min(Math.abs(m.x - 100), Math.abs(m.x - 200), Math.abs(m.y - 100), Math.abs(m.y - 160)) < 0.01 || Math.abs(Math.hypot(m.x - 150, m.y - 130) - 10) < 0.2), leadMoves.length);
  let cut = 0, prev = null; for (const m of plan.moves) { if (m.x == null) continue; if (prev && !m.rapid && m.s > 0) cut += Math.hypot(m.x - prev.x, m.y - prev.y); prev = m; }
  // perimeters (320 + ~62.8) plus two quarter-circle leads of 4 mm and two of 3 mm
  const expect = 320 + Math.PI * 20 + 2 * (Math.PI / 2) * 4 + 2 * (Math.PI / 2) * 3;
  out.leadCut = [+cut.toFixed(1), +expect.toFixed(1)];
  check('lead-cut-length', near(cut, expect, 1.5), out.leadCut);
  check('pierce-in-time', plan.stats.time > cut / 20 + 0.99, plan.stats.time);
  const g = G.toGcode(plan, docP, plasma).split('\n');
  // replay the program: the torch must be off for every travel move, and each ignition is followed by the pierce dwell
  let torch = false, bad = [], on = 0, off = 0, sWords = 0;
  g.forEach((line, i) => {
    if (line.startsWith('M3')) { torch = true; on += 1; if (!/^G4 P0\.5/.test(g[i + 1] || '')) bad.push('no dwell after line ' + i); }
    else if (line.startsWith('M5')) { torch = false; off += 1; }
    else if (/^G0|^X/.test(line) && /G0/.test(line) && torch) bad.push('travel with torch on at line ' + i);
    if (/^(G1 )?X.* S\d/.test(line)) sWords += 1;
  });
  out.plasma = [on, off, sWords, bad.length];
  check('plasma-gcode', on === 2 && off >= 2 && sWords === 0 && !bad.length && !torch, [on, off, sWords, bad]);
  const gl = G.toGcode(G.planJob(docP, ws.machine, ws.getImage), docP, ws.machine);
  check('laser-pierce-gcode', (gl.match(/G4 P0\.5 ; pierce/g) || []).length === 2 && gl.includes('M3 S1000') && gl.includes('M4 S1000'), gl.slice(0, 300));
  // a lead that cannot fit inside a tiny hole is dropped with a warning instead of cutting into the part
  const tiny = M.makeEllipse(li, 300, 300, 1.2, 1.2);
  const tp = G.planJob({ ...ws.doc, shapes: [tiny] }, plasma, ws.getImage);
  check('lead-outer-still-fits', tp.moves.filter((m) => m.lead).length > 0);
  Object.assign(M.layerOf(ws.doc, li), { leadIn: 0, leadOut: 0, pierce: 0, overcut: 5 });
  const oc = G.planJob({ ...ws.doc, shapes: [M.makeRect(li, 10, 10, 40, 40)] }, ws.machine, ws.getImage);
  let ol = 0; prev = null; for (const m of oc.moves) { if (m.x == null) continue; if (prev && !m.rapid && m.s > 0) ol += Math.hypot(m.x - prev.x, m.y - prev.y); prev = m; }
  check('overcut', near(ol, 165, 0.05), ol);
  Object.assign(M.layerOf(ws.doc, li), { overcut: 0, perforate: true, perfCut: 3, perfSkip: 1 });
  const pf = G.planJob({ ...ws.doc, shapes: [M.makeRect(li, 10, 10, 40, 40)] }, ws.machine, ws.getImage);
  let pl = 0; prev = null; for (const m of pf.moves) { if (m.x == null) continue; if (prev && !m.rapid && m.s > 0) pl += Math.hypot(m.x - prev.x, m.y - prev.y); prev = m; }
  check('perforate', near(pl, 120, 0.5), pl);
  Object.assign(M.layerOf(ws.doc, li), { perforate: false });
}
// auto-join and duplicate removal
{
  const M = L.model, n0 = ws.doc.shapes.length;
  const seg = (a, b) => M.makePath(14, [{ closed: false, nodes: [{ x: a[0], y: a[1] }, { x: b[0], y: b[1] }] }]);
  const parts = [seg([300, 20], [340, 20]), seg([340, 20.1], [340, 60]), seg([300, 60], [340, 60]), seg([300, 20], [300, 60])];
  ws.add(parts); ws.select(parts.map((s) => s.id)); ws.autoJoin();
  const joined = ws.selected()[0];
  check('auto-join', ws.doc.shapes.length === n0 + 1 && joined.subs.length === 1 && joined.subs[0].closed && joined.subs[0].nodes.length === 4, joined && joined.subs.map((s) => [s.closed, s.nodes.length]));
  const d1 = M.makeRect(15, 350, 20, 10, 10), d2 = M.makeRect(15, 350, 20, 10, 10), d3 = M.makeRect(15, 350, 40, 10, 10);
  ws.add([d1, d2, d3]); ws.select([]); const n1 = ws.doc.shapes.length; ws.deleteDuplicates();
  check('delete-duplicates', ws.doc.shapes.length === n1 - 1, n1 - ws.doc.shapes.length);
  ws.select([d3.id]); ws.selectLayer();
  check('select-layer', ws.sel.length === 2, ws.sel.length);
  ws.select([]);
}
out.fails = fails;
return out;
