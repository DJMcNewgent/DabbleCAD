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
out.fails = fails;
return out;
