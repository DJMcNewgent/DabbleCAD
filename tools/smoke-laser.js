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
// plasma torch height, Z moves, sub-layers, start points, rotary, print-and-cut
{
  const G = L.gcode, M = L.model, X = L.extras;
  const cutLen = (plan) => { let c = 0, prev = null; for (const m of plan.moves) { if (m.x == null) continue; if (prev && !m.rapid && m.s > 0) c += Math.hypot(m.x - prev.x, m.y - prev.y); prev = m; } return c; };
  const li = 16;
  const reset = (extra = {}) => Object.assign(M.layerOf(ws.doc, li), { mode: 'line', speed: 20, powerMax: 100, powerMin: 0, passes: 1, kerf: 0, tabs: 0, leadIn: 0, leadOut: 0, pierce: 0, overcut: 0, perforate: false, zOffset: 0, zStep: 0, subs: [] }, extra);
  const sq = () => M.makeRect(li, 10, 10, 40, 40);
  const docOf = (shapes, more = {}) => ({ ...ws.doc, registration: null, startFrom: 'absolute', shapes, ...more });

  // torch height: touch off, pierce height, fire, dwell, cut height, THC on ... THC off, torch off, safe height
  reset({ pierce: 500 });
  const pm = { ...ws.machine, flavor: 'plasma', zEnabled: true, plasma: { touchOff: true, probeDist: 30, probeFeed: 300, switchOffset: 1.2, pierceHeight: 4, cutHeight: 1.5, safeHeight: 12, plungeFeed: 600, thcOn: 'M62 P0', thcOff: 'M63 P0' } };
  const d1 = docOf([sq(), M.makeRect(li, 100, 10, 20, 20)]);
  const pg = G.toGcode(G.planJob(d1, pm, ws.getImage), d1, pm);
  const seq = /G38\.2 Z-30 F300 ; touch off\nG92 Z-1\.2 ; material surface is Z0\nG0 Z4 ; pierce height\nM3 S1000\nG4 P0\.5 ; pierce\nG1 Z1\.5 F600 ; cut height\nM62 P0\n/g;
  check('plasma-height-sequence', (pg.match(seq) || []).length === 2 && (pg.match(/M63 P0\nM5\nG0 Z12/g) || []).length === 2, pg.slice(0, 420));
  let z = null, lowTravel = 0;
  for (const line of pg.split('\n')) { const mz = /^G[01] Z(-?[\d.]+)/.exec(line); if (mz) z = +mz[1]; if (/^G0 X/.test(line) && z !== 12) lowTravel += 1; }
  check('plasma-travel-at-safe-height', lowTravel === 0 && pg.includes('G92.1 ; clear the touch-off offset'), lowTravel);
  // without a Z axis the plasma output is unchanged from before
  check('plasma-no-z', !/ Z/.test(G.toGcode(G.planJob(d1, { ...pm, zEnabled: false }, ws.getImage), d1, { ...pm, zEnabled: false })));

  // laser focus: offset, stepping down each pass, back to zero at the end
  reset({ passes: 3, zOffset: 2, zStep: 0.5 });
  const zm = { ...ws.machine, zEnabled: true };
  const d2 = docOf([sq()]);
  const zg = G.toGcode(G.planJob(d2, zm, ws.getImage), d2, zm);
  const zs = zg.split('\n').filter((l) => /^G0 Z/.test(l));
  check('laser-z-steps', zs.join('|') === 'G0 Z2|G0 Z1.5|G0 Z1|G0 Z0', zs);
  check('laser-z-off-by-default', !/ Z/.test(G.toGcode(G.planJob(d2, ws.machine, ws.getImage), d2, ws.machine)));

  // sub-layers: a second operation on the same shapes
  reset({ subs: [{ mode: 'line', speed: 50, powerMax: 20, passes: 1 }] });
  const sp = G.planJob(d2, ws.machine, ws.getImage), sg = G.toGcode(sp, d2, ws.machine);
  check('sub-layer-runs', near(cutLen(sp), 320, 0.05) && sg.includes('F1200') && sg.includes('F3000') && sg.includes('S200'), cutLen(sp));
  reset();

  // hand-picked start point and direction
  const a = sq(); a.cutStart = [40, 40];
  const p1 = G.planJob(docOf([a]), ws.machine, ws.getImage).moves.filter((m) => m.x != null);
  check('cut-start-point', near(p1[0].x, 50) && near(p1[0].y, 50), [p1[0].x, p1[0].y]);
  const b = sq(); b.cutStart = [40, 40]; b.cutReverse = true;
  const p2 = G.planJob(docOf([b]), ws.machine, ws.getImage).moves.filter((m) => m.x != null);
  check('cut-direction-reversed', near(p2[0].x, 50) && near(p2[0].y, 50) && (p1[1].x !== p2[1].x || p1[1].y !== p2[1].y), [[p1[1].x, p1[1].y], [p2[1].x, p2[1].y]]);

  // rotary: travel around the object is scaled onto the driven axis
  const rm = { ...ws.machine, rotary: { enabled: true, type: 'chuck', mmPerRotation: 360, rollerDiameter: 60, objectDiameter: 100, axis: 'A' } };
  check('rotary-scale', near(G.rotaryScale(rm), 360 / (Math.PI * 100), 1e-9) && near(G.rotaryScale({ rotary: { ...rm.rotary, type: 'roller' } }), 360 / (Math.PI * 60), 1e-9) && G.rotaryScale(ws.machine) === 1);
  const rg = G.toGcode(G.planJob(d2, rm, ws.getImage), d2, rm);
  const firstA = /X10 A([\d.]+)/.exec(rg);
  out.rotaryA = firstA && +firstA[1];
  check('rotary-gcode', !!firstA && !/ Y\d/.test(rg) && near(+firstA[1], (ws.machine.bedH - 10) * 360 / (Math.PI * 100), 0.01) || (!!firstA && near(+firstA[1], (ws.machine.bedH - 50) * 360 / (Math.PI * 100), 0.01)), out.rotaryA);

  // print and cut: two marks a quarter turn away from where the design has them
  const reg = { enabled: true, scale: true, d1: [100, 100], d2: [200, 100], m1: [50, 50], m2: [50, 150] };
  const map = G.registrationMap({ registration: reg }, ws.machine);
  const D1 = G.toMachine(ws.machine, 100, 100), mid = map(D1[0] + 50, D1[1]);
  check('print-cut-map', !!map && near(map(D1[0], D1[1])[0], 50) && near(mid[0], 50) && near(mid[1], 100) && near(map.angle, 90, 1e-6) && near(map.scale, 1, 1e-9), [mid, map && map.angle]);
  const lineShape = M.makePath(li, [{ closed: false, nodes: [{ x: 100, y: 100 }, { x: 200, y: 100 }] }]);
  const d3 = docOf([lineShape], { registration: reg, startFrom: 'current' });
  const pcg = G.toGcode(G.planJob(d3, ws.machine, ws.getImage), d3, ws.machine);
  check('print-cut-gcode', /X50 Y50\b/.test(pcg) && /X50 Y150\b/.test(pcg) && !pcg.includes('G92'), pcg.slice(0, 260));
  check('print-cut-off', G.registrationMap({ registration: { ...reg, enabled: false } }, ws.machine) === null);
  const pcd = X.printCutDialog(ws); await wait(100);
  check('print-cut-dialog', pcd.el.querySelectorAll('.pc-item').length === 2);
  pcd.close(); ws.doc.registration = null;
}
// variable text, text on a path, image modes and masks, camera overlay, new settings screens
{
  const G = L.gcode, M = L.model, X = L.extras;
  M.setTextVariables({ serial: 7, step: 1, csv: [['Ada', 'Lovelace'], ['Alan', 'Turing']], row: 1 });
  check('variable-text', M.resolveText('SN-{serial:4}') === 'SN-0007' && M.resolveText('{csv:1} {csv:2}') === 'Alan Turing' && /^\d{4}-\d{2}-\d{2}$/.test(M.resolveText('{date}')) && M.resolveText('plain') === 'plain', M.resolveText('SN-{serial:4} {csv:1}'));
  check('csv-parse', JSON.stringify(X.parseCsv('a,b\n"x, y",z\n')) === '[["a","b"],["x, y","z"]]', X.parseCsv('a,b\n"x, y",z\n'));
  ws.doc.variables = { serial: 7, step: 2, autoAdvance: true, csv: null, row: 0 };
  const vt = M.makeText(17, 20, 200, 'No {serial:3}', 'Sans Bold', 8); ws.add([vt]);
  const w7 = M.boundsOf([vt]).w;
  check('variable-advance', X.advanceVariables(ws) === true && ws.doc.variables.serial === 9 && M.resolveText('{serial}') === '9' && M.boundsOf([vt]).w > 0 && w7 > 0, ws.doc.variables.serial);
  const vd = X.variableTextDialog(ws); await wait(80); check('variable-dialog', vd.el.querySelectorAll('.var-tokens button').length === 6); vd.close();

  // bending outlines along a line that runs straight down the bed
  const bent = X.bendAlong([{ closed: false, pts: [[0, 10], [10, 10], [10, 5]] }], [[0, 0], [0, 100]]);
  const bp = bent[0].pts, lastB = bp[bp.length - 1], onLine = bp.find((q) => near(q[1], 10, 0.01) && near(q[0], 0, 0.01));
  check('bend-along', !!onLine && near(lastB[0], 5, 0.01) && near(lastB[1], 10, 0.01), [onLine, lastB]);
  const tx = M.makeText(17, 20, 250, 'CURVE', 'Sans Bold', 8), arc = M.makeEllipse(17, 60, 220, 80, 80);
  ws.add([tx, arc]); ws.select([tx.id, arc.id]);
  const onPath = X.textOnPath(ws);
  check('text-on-path', !!onPath && onPath.type === 'path' && onPath.subs.length >= 5 && !ws.doc.shapes.includes(tx), onPath && onPath.subs.length);

  // halftone: dot coverage follows the tone
  const tone = (v) => { const d = new ImageData(200, 200); for (let i = 0; i < d.data.length; i += 4) { d.data[i] = d.data[i + 1] = d.data[i + 2] = v; d.data[i + 3] = 255; } const o = L.ops.processImage(d, { mode: 'halftone', pxPerMM: 10 }); let n = 0; for (const q of o) if (q) n += 1; return n / o.length; };
  out.halftone = [tone(191), tone(128), tone(64)].map((v) => +v.toFixed(2));
  check('halftone-coverage', near(out.halftone[1], 0.5, 0.04) && out.halftone[0] > 0.12 && out.halftone[0] < 0.36 && out.halftone[2] > 0.64 && out.halftone[2] < 0.88 && tone(255) === 0 && tone(0) === 1, out.halftone);

  // image mask: only the half inside the mask is engraved
  const cvs = document.createElement('canvas'); cvs.width = 40; cvs.height = 40; const c2 = cvs.getContext('2d'); c2.fillStyle = '#000'; c2.fillRect(0, 0, 40, 40);
  const im = M.makeImage(18, 300, 200, 20, 20, cvs.toDataURL(), 40, 40);
  Object.assign(M.layerOf(ws.doc, 18), { mode: 'line', speed: 100, powerMax: 50, interval: 0.5, overscan: 0 }); M.layerOf(ws.doc, 18).image.mode = 'threshold';
  const getImg = (s) => (s.id === im.id ? cvs : ws.getImage(s));
  const burnX = (shape) => { const pl = G.planJob({ ...ws.doc, shapes: [shape] }, ws.machine, getImg); let lo = Infinity, hi = -Infinity, prev = null; for (const m of pl.moves) { if (m.x == null) continue; if (prev && !m.rapid && m.s > 0) { lo = Math.min(lo, prev.x, m.x); hi = Math.max(hi, prev.x, m.x); } prev = m; } return [lo, hi]; };
  const full = burnX(im);
  im.mask = [[[0, 0], [10, 0], [10, 20], [0, 20]]];
  const half = burnX(im);
  out.maskX = [full.map((v) => +v.toFixed(1)), half.map((v) => +v.toFixed(1))];
  check('image-mask', near(full[0], 300, 0.6) && near(full[1], 320, 0.6) && near(half[0], 300, 0.6) && near(half[1], 310, 0.6), out.maskX);

  // camera: a photo taken at an angle is flattened onto the bed
  const Hm = X.homography([[0, 0], [10, 0], [10, 10], [0, 10]], [[5, 5], [25, 8], [28, 30], [3, 26]]);
  const pc = X.project(Hm, 10, 10), p0 = X.project(Hm, 0, 0);
  check('homography', near(pc[0], 28, 1e-6) && near(pc[1], 30, 1e-6) && near(p0[0], 5, 1e-6), [pc, p0]);
  const photo = document.createElement('canvas'); photo.width = 200; photo.height = 100; const pc2 = photo.getContext('2d');
  pc2.fillStyle = '#f00'; pc2.fillRect(0, 0, 100, 100); pc2.fillStyle = '#00f'; pc2.fillRect(100, 0, 100, 100);
  const cam = X.cameraDialog(ws); await wait(80);
  cam.el.__camera.setFrame(photo, 200, 100); cam.el.__camera.setCorners([[0, 0], [200, 0], [200, 100], [0, 100]]); cam.el.__camera.apply(); await wait(50);
  const ov = ws.overlay && ws.overlay.canvas.getContext('2d').getImageData(0, 0, ws.overlay.canvas.width, ws.overlay.canvas.height);
  const px = (fx) => { const x = Math.floor(ov.width * fx), y = Math.floor(ov.height / 2), i = (y * ov.width + x) * 4; return [ov.data[i], ov.data[i + 2]]; };
  check('camera-overlay', !!ov && px(0.25)[0] > 200 && px(0.25)[1] < 50 && px(0.75)[1] > 200 && px(0.75)[0] < 50, ov && [px(0.25), px(0.75)]);
  await shot('l-camera'); cam.close(); ws.overlay = null; ws.app.patchSettings({ laserCamera: null });

  // settings screens: device groups save, sub-layer row works
  const before = JSON.stringify(ws.machine);
  L.tools.deviceDialog(ws); await wait(120);
  const dm = document.querySelector('.modal');
  check('device-groups', dm.querySelectorAll('details.dev-group').length === 2);
  [...dm.querySelectorAll('button')].find((b2) => b2.textContent === 'Save').click(); await wait(120);
  check('device-save', !!ws.machine.plasma && !!ws.machine.rotary && ws.machine.zEnabled === false && ws.machine.rotary.enabled === false && JSON.parse(before).flavor === ws.machine.flavor, Object.keys(ws.machine));
  ws.selectedLayer = 17; ws.refresh(); await wait(60);
  const plus = [...document.querySelectorAll('.le-subs button')].find((b2) => b2.textContent === '+');
  check('sub-layer-row', !!plus);
  if (plus) { plus.click(); await wait(60); check('sub-layer-added', M.layerOf(ws.doc, 17).subs.length === 1 && ws.subIndex === 1 && !!document.querySelector('.le-subs .btn-ghost'), M.layerOf(ws.doc, 17).subs.length); M.layerOf(ws.doc, 17).subs = []; ws.subIndex = 0; }
  M.setTextVariables(null); ws.doc.variables = null; ws.select([]);
}
// LightBurn project import (structure taken from real .lbrn2 and .lbrn files)
{
  const M = L.model;
  const lb2 = `<?xml version="1.0" encoding="UTF-8"?>
<LightBurnProject AppVersion="1.3.01" FormatVersion="1" MaterialHeight="0" MirrorX="False" MirrorY="False">
  <CutSetting type="Cut"><index Value="0"/><name Value="Outline"/><maxPower Value="80"/><minPower Value="10"/><speed Value="12"/><numPasses Value="2"/><kerf Value="0.1"/><runBlower Value="1"/></CutSetting>
  <CutSetting type="Scan"><index Value="3"/><name Value="Engrave"/><maxPower Value="30"/><speed Value="150"/><interval Value="0.08"/><crossHatch Value="1"/><bidir Value="0"/></CutSetting>
  <Shape Type="Rect" CutIndex="0" W="100" H="50" Cr="4"><XForm>1 0 0 1 100 75</XForm></Shape>
  <Shape Type="Group"><XForm>1 0 0 1 10 20</XForm><Children>
    <Shape Type="Ellipse" CutIndex="3" Rx="5" Ry="5"><XForm>1 0 0 1 60 60</XForm></Shape>
    <Shape Type="Path" CutIndex="0" VertID="2" PrimID="1"><XForm>2 0 0 2 0 0</XForm>
      <VertList>V10 5c0x12c0y5c1x8c1y5V15 10c0x15c0y12c1x15c1y8V10 15c0x8c0y15c1x12c1y15V5 10c0x5c0y8c1x5c1y12</VertList>
      <PrimList>B0 1B1 2B2 3B3 0</PrimList></Shape>
    <Shape Type="Path" CutIndex="3" VertID="2" PrimID="1"><XForm>1 0 0 1 100 0</XForm></Shape>
  </Children></Shape>
  <Shape Type="Path" CutIndex="0"><XForm>1 0 0 1 0 0</XForm><VertList>V200 10V220 10V220 30V200 30</VertList><PrimList>LineClosed</PrimList></Shape>
  <Shape Type="Path" CutIndex="0"><XForm>1 0 0 1 0 0</XForm><VertList>V300 10V320 10V320 30</VertList><PrimList>L0 1L1 2</PrimList></Shape>
  <Shape Type="Hatch" CutIndex="0"><XForm>1 0 0 1 0 0</XForm></Shape>
</LightBurnProject>`;
  const r = L.io.importLBRN(lb2, ws.machine);
  const kinds = {}; M.walkShapes(r.shapes, (s) => { kinds[s.type] = (kinds[s.type] || 0) + 1; });
  check('lbrn-shapes', r.shapes.length === 4 && kinds.rect === 1 && kinds.ellipse === 1 && kinds.path === 4 && kinds.group === 1, kinds);
  // Y is flipped onto the bed: a rectangle centred at (100, 75) from the bottom sits 75 mm above the bed's lower edge
  const rb = M.boundsOf([r.shapes[0]]);
  check('lbrn-rect-place', near(rb.x0, 50) && near(rb.w, 100) && near(rb.h, 50) && near(rb.cy, ws.machine.bedH - 75), [rb.x0, rb.cy, rb.w, rb.h]);
  const grp = r.shapes[1], circ = grp.children[1], copy = grp.children[2];
  const cb = M.boundsOf([{ ...grp, children: [circ] }]), kb = M.boundsOf([{ ...grp, children: [copy] }]);
  // four curves make a circle of radius 5 at (10, 10), drawn at twice the size inside a group moved by (10, 20)
  check('lbrn-curves', circ.subs.length === 1 && circ.subs[0].closed && circ.subs[0].nodes.length === 4 && circ.subs[0].nodes.every((n) => n.ox != null && n.ix != null) && near(cb.w, 20, 0.2) && near(cb.cx, 30, 0.1) && near(cb.cy, ws.machine.bedH - 40, 0.1), [cb.w, cb.cx, cb.cy]);
  check('lbrn-shared-points', copy.layer === 3 && copy.subs[0].nodes.length === 4 && near(kb.w, 10, 0.1) && near(kb.cx, 120, 0.1), [kb.w, kb.cx]);
  check('lbrn-line-paths', r.shapes[2].subs[0].closed && r.shapes[2].subs[0].nodes.length === 4 && !r.shapes[3].subs[0].closed && r.shapes[3].subs[0].nodes.length === 3);
  check('lbrn-layers', r.layers[0].mode === 'line' && r.layers[0].speed === 12 && r.layers[0].powerMax === 80 && r.layers[0].passes === 2 && r.layers[0].air === true && r.layers[3].mode === 'fill' && r.layers[3].interval === 0.08 && r.layers[3].crosshatch === true && r.layers[3].bidirectional === false, r.layers);
  check('lbrn-notes', r.notes.some((n) => n.includes('Hatch')), r.notes);
  const v1 = `<?xml version="1.0"?><LightBurnProject MaterialHeight="0"><CutSetting type="Cut"><index Value="2"/><speed Value="10"/><maxPower Value="100"/></CutSetting>
  <Shape Type="Path" CutIndex="2"><XForm>1 0 0 1 50 50</XForm><V vx="0" vy="0" c0x="1" c0y="0" c1x="1" c1y="0" sm="0"/><V vx="10" vy="0" c0x="1" c0y="0" c1x="1" c1y="0" sm="0"/><V vx="5" vy="8" c0x="1" c0y="0" c1x="1" c1y="0" sm="0"/><P T="L" p0="0" p1="1"/><P T="L" p0="1" p1="2"/><P T="L" p0="2" p1="0"/></Shape></LightBurnProject>`;
  const r1 = L.io.importLBRN(v1, ws.machine), tb = M.boundsOf(r1.shapes);
  check('lbrn-v1', r1.shapes.length === 1 && r1.shapes[0].layer === 2 && r1.shapes[0].subs[0].closed && r1.shapes[0].subs[0].nodes.length === 3 && r1.shapes[0].subs[0].nodes.every((n) => n.ox == null) && near(tb.w, 10) && near(tb.h, 8) && near(tb.x0, 50), tb && [tb.w, tb.h, tb.x0]);
  let threw = false; try { L.io.importLBRN('<svg/>', ws.machine); } catch { threw = true; }
  check('lbrn-rejects-other-xml', threw);
  const n0 = ws.doc.shapes.length;
  await L.tools.importFiles(ws, [{ name: 'box.lbrn2', data: new TextEncoder().encode(lb2).buffer }]); await wait(150);
  check('lbrn-import-file', ws.doc.shapes.length === n0 + 4 && M.layerOf(ws.doc, 3).mode === 'fill' && M.layerOf(ws.doc, 3).speed === 150, ws.doc.shapes.length - n0);
}
// layer panel: names, lock, copy / paste settings, visibility, cut order, moving shapes, kerf and focus tests
{
  const M = L.model, G = L.gcode;
  const generate = async () => { await wait(100); [...document.querySelectorAll('.modal .btn')].find((x) => x.textContent === 'Generate').click(); await wait(200); };
  ws.doc.shapes = []; ws.doc.layerOrder = []; ws.sel = [];
  const a = M.makeRect(5, 20, 20, 30, 20), b = M.makeRect(6, 80, 20, 30, 20), c = M.makeRect(7, 140, 20, 30, 20);
  for (const i of [5, 6, 7]) Object.assign(M.layerOf(ws.doc, i), M.defaultLayer(i));
  Object.assign(M.layerOf(ws.doc, 5), { speed: 12, powerMax: 77 });
  Object.assign(M.layerOf(ws.doc, 6), { mode: 'fill', speed: 150, powerMax: 20 });
  ws.add([a, b, c]); await wait(50);
  check('layer-rows', document.querySelectorAll('.ll-row').length === 3 && !!document.querySelector('.ll-head .btn'));
  M.layerOf(ws.doc, 5).name = 'Cut outline'; ws.commit();
  check('layer-name', [...document.querySelectorAll('.ll-row .ll-mode')].some((e) => e.textContent.startsWith('Cut outline')) && ws.layerShapeCount(5) === 1);
  const nameInput = document.querySelector('.laser-layer-editor input[aria-label="Layer name"]');
  check('layer-name-field', !!nameInput);
  // a locked layer cannot be clicked, box-selected, selected by Ctrl+A or picked from code
  ws.select([a.id]);
  const hitBefore = ws.hit([35, 20]);
  ws.lockLayer(5, true);
  const hitLocked = ws.hit([35, 20]);
  ws.selectAll(); const allLocked = ws.sel.length;
  ws.select([a.id]); const pickLocked = ws.sel.length;
  ws.select([]); dragTo(at(10, 10), at(190, 60)); const boxLocked = ws.sel.length;
  check('layer-lock', hitBefore && hitBefore.id === a.id && hitLocked === null && allLocked === 2 && pickLocked === 0 && boxLocked === 2, [!!hitBefore, hitLocked, allLocked, pickLocked, boxLocked]);
  ws.lockLayer(5, false); ws.select([a.id]);
  check('layer-unlock', ws.sel.length === 1 && ws.hit([35, 20]) !== null);
  // copy and paste settings, reset
  ws.copyLayerSettings(5); ws.pasteLayerSettings(6);
  const L6 = M.layerOf(ws.doc, 6);
  check('layer-paste', L6.mode === 'line' && L6.speed === 12 && L6.powerMax === 77 && !L6.name && L6.index === 6, L6);
  ws.resetLayer(6);
  check('layer-reset', M.layerOf(ws.doc, 6).speed === 100 && M.layerOf(ws.doc, 6).powerMax === 30 && M.layerOf(ws.doc, 5).name === 'Cut outline');
  // show / hide / output
  const shown = () => [5, 6, 7].map((i) => (M.layerOf(ws.doc, i).show !== false ? 1 : 0)).join('');
  ws.soloLayer(6); const solo = shown();
  ws.invertVisibleLayers(); const inv = shown();
  ws.showAllLayers();
  check('layer-visibility', solo === '010' && inv === '101' && shown() === '111', [solo, inv, shown()]);
  ws.setAllOutput(false); const noOut = ws.plan().bounds;
  ws.setAllOutput(true);
  check('layer-output-all', !noOut && !!ws.plan().bounds);
  // cut order
  M.layerOf(ws.doc, 6).mode = 'fill'; ws.doc.layerOrder = [5, 6, 7]; ws.sortCutsLast();
  const sorted = G.usedLayers(ws.doc).join();
  ws.moveLayerTo(7, 0);
  check('layer-order', sorted === '6,5,7' && G.usedLayers(ws.doc).join() === '7,6,5', [sorted, G.usedLayers(ws.doc).join()]);
  // right-click menu
  document.querySelector('.ll-row').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 600, clientY: 200 }));
  await wait(60);
  const items = [...document.querySelectorAll('.menu .menu-label')].map((e) => e.textContent);
  check('layer-menu', items.includes('Rename…') && items.includes('Copy settings') && items.includes('Lock layer') && items.includes('Sort cut layers last'), items);
  await shot('l-layers');
  key('Escape'); await wait(30);
  check('layer-menu-closes', !document.querySelector('.menu'));
  // move and delete a layer's shapes
  const moved = ws.moveLayerShapes(7, 5);
  check('layer-move-shapes', moved === 1 && ws.layerShapeCount(5) === 2 && G.usedLayers(ws.doc).length === 2);
  const deleted = ws.deleteLayerShapes(5);
  check('layer-delete-shapes', deleted === 2 && ws.doc.shapes.length === 1);
  ws.undo();
  check('layer-delete-undo', ws.doc.shapes.length === 3);
  // LightBurn layer names come across, but not the default colour codes
  const named = L.io.importLBRN('<LightBurnProject><CutSetting type="Cut"><index Value="0"/><name Value="Outline"/></CutSetting><CutSetting type="Cut"><index Value="1"/><name Value="C01"/></CutSetting><Shape Type="Rect" CutIndex="0" W="10" H="10"><XForm>1 0 0 1 20 20</XForm></Shape></LightBurnProject>', ws.machine);
  check('lbrn-layer-names', named.layers[0].name === 'Outline' && named.layers[1].name === undefined, named.layers);

  // kerf test: six squares, each on its own layer with a stepped kerf offset, labels engraved first
  ws.doc.shapes = []; ws.doc.layerOrder = []; ws.sel = []; ws.commit();
  L.tools.kerfTestDialog(ws); await generate();
  const kg = ws.selected()[0], squares = kg ? kg.children.filter((x) => x.type === 'rect') : [];
  const kerfs = squares.map((x) => M.layerOf(ws.doc, x.layer).kerf);
  const labelLayer = kg ? kg.children.find((x) => x.type === 'text').layer : -1;
  check('kerf-test', squares.length === 6 && near(kerfs[0], 0) && near(kerfs[5], 0.25) && near(kerfs[2], 0.1) && new Set(squares.map((x) => x.layer)).size === 6 && G.usedLayers(ws.doc)[0] === labelLayer && M.layerOf(ws.doc, squares[5].layer).name === 'Kerf 0.25', [kerfs, G.usedLayers(ws.doc), labelLayer]);
  // the planned outline of the last square really is 0.25 mm bigger all round
  {
    const plan = ws.plan();
    const big = plan.paths ? plan.paths : null; void big;
    const code = G.toGcode(plan, ws.doc, ws.machine);
    check('kerf-test-gcode', code.length > 200 && /G1/.test(code));
  }
  // focus test: refuses without a Z axis, otherwise one line per Z offset
  ws.doc.shapes = []; ws.doc.layerOrder = []; ws.sel = []; ws.commit();
  const hadZ = ws.machine.zEnabled;
  ws.machine.zEnabled = false;
  L.tools.focusTestDialog(ws); await wait(80);
  check('focus-test-needs-z', !document.querySelector('.modal'));
  ws.machine.zEnabled = true;
  L.tools.focusTestDialog(ws); await generate();
  const fg = ws.selected()[0], lines = fg ? fg.children.filter((x) => x.type === 'path') : [];
  const zs = lines.map((x) => M.layerOf(ws.doc, x.layer).zOffset);
  const fcode = fg ? G.toGcode(ws.plan(), ws.doc, ws.machine) : '';
  check('focus-test', lines.length === 9 && near(zs[0], -4) && near(zs[4], 0) && near(zs[8], 4) && /Z-4/.test(fcode) && /Z4/.test(fcode), [zs, fcode.length]);
  ws.machine.zEnabled = hadZ;
  ws.doc.shapes = []; ws.doc.layerOrder = []; ws.sel = []; ws.commit();
}

// downloads folder: exports can go straight to a chosen folder, never overwriting
if (window.dabbleNative && dir) {
  const N = window.dabbleNative;
  const before = await N.downloadsInfo();
  await N.setSettings({ downloadDir: dir, askWhereToSave: false });
  const info = await N.downloadsInfo();
  const p1 = await N.saveDialog({ defaultName: 'download-test.txt', data: 'one' });
  const p2 = await N.saveDialog({ defaultName: 'download-test.txt', data: 'two' });
  const norm = (p) => String(p).replace(/\\/g, '/').toLowerCase();
  check('downloads-folder', norm(info.chosen) === norm(dir) && norm(p1).startsWith(norm(dir)) && norm(p1).endsWith('/download-test.txt') && norm(p2).endsWith('/download-test (2).txt'), [info, p1, p2]);
  await N.setSettings({ downloadDir: 'Z:/no/such/folder/anywhere', askWhereToSave: true });
  const bad = await N.downloadsInfo();
  check('downloads-folder-missing', bad.chosen === '' && !!bad.folder, bad);
  await N.setSettings({ downloadDir: before.chosen || '', askWhereToSave: true });
}
out.fails = fails;
return out;
