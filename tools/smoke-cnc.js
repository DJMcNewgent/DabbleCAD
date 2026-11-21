// CNC workspace check: node tools/run.js --smoke=tools/smoke-cnc.js --shots=<folder>
const app = window.dabble, ws = app.cnc, panel = ws.machinePanel, dev = ws.device;
const L = window.dabbleLib.laser, C = window.dabbleLib.cnc;
const dir = window.__shotDir;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (name) => { await wait(350); await window.dabbleNative.smokeShot(dir + '/' + name + '.png'); };
const out = {}; const fails = [];
const check = (name, cond, info) => { if (!cond) fails.push(name + (info !== undefined ? ' -> ' + JSON.stringify(info) : '')); };
const near = (a, b, eps = 0.02) => Math.abs(a - b) <= eps;
const extent = (sections) => { const e = { x0: 1e9, x1: -1e9, y0: 1e9, y1: -1e9, z0: 1e9, z1: -1e9 }; for (const s of sections) for (const p of s.paths) for (const q of p.pts) { e.x0 = Math.min(e.x0, q[0]); e.x1 = Math.max(e.x1, q[0]); e.y0 = Math.min(e.y0, q[1]); e.y1 = Math.max(e.y1, q[1]); e.z0 = Math.min(e.z0, q[2]); e.z1 = Math.max(e.z1, q[2]); } return e; };

document.querySelector('.btn[data-mode="cnc"]').click();
await wait(400);
check('cnc-mode', document.getElementById('app').classList.contains('cnc-mode') && ws.active && !app.laser.active);
check('laser-hidden', getComputedStyle(app.laserRoot).display === 'none' && getComputedStyle(app.cncRoot).display !== 'none');
check('job-defaults', ws.job.w === 300 && ws.job.t === 18 && ws.job.xyZero === 'bl');

// ---- draw: a plate with a pocket, two holes, some text, and a star from the shape library
const plate = L.model.makeRect(0, 50, 50, 100, 60), pocket = L.model.makeRect(0, 70, 65, 40, 30);
const hole1 = L.model.makeEllipse(0, 125, 60, 6, 6), hole2 = L.model.makeEllipse(0, 125, 94, 6, 6);
const text = L.model.makeText(0, 60, 150, 'CNC', 'Sans Bold', 28);
ws.add([plate, pocket, hole1, hole2, text]);
C.dialogs.insertShape(ws, 'star');
const star = ws.doc.shapes[ws.doc.shapes.length - 1];
check('shape-library', star.type === 'path' && near(L.model.boundsOf([star]).cx, 150, 0.5), L.model.boundsOf([star]));
star.m = L.model.mul(L.model.translate(60, -40), star.m);
ws.commit();

// ---- toolpaths
ws.select([pocket.id]); const tpPocket = ws.addToolpath('pocket');
ws.select([hole1.id, hole2.id]); const tpDrill = ws.addToolpath('drill');
ws.select([text.id]); const tpV = ws.addToolpath('vcarve');
ws.select([star.id]); const tpStar = ws.addToolpath('pocket'); tpStar.strategy = 'raster'; tpStar.depth = 2; tpStar.name = 'Star';
ws.select([plate.id]); const tpCut = ws.addToolpath('profile');
ws.commit();
ws._compute();
check('five-toolpaths', ws.doc.toolpaths.length === 5 && ws.doc.toolpaths.every((t) => ws.computed.get(t.id) && ws.computed.get(t.id).sections.length), ws.doc.toolpaths.map((t) => [t.type, (ws.computed.get(t.id) || {}).warnings]));
{
  // the plate is at x 50..150, y 190..250 in job coordinates (zero at the front left)
  const e = extent(ws.computed.get(tpCut.id).sections), r = 6.35 / 2;
  check('profile-outside', near(e.x0, 50 - r) && near(e.x1, 150 + r) && near(e.y0, 190 - r) && near(e.y1, 250 + r) && near(e.z0, -18.3), e);
  const pts = ws.computed.get(tpCut.id).sections[0].paths[0].pts;
  check('profile-tabs', pts.some((q) => near(q[2], -16.3, 1e-6)), 'no tab height');
  const p = extent(ws.computed.get(tpPocket.id).sections);
  check('pocket-inside', near(p.x0, 70 + r) && near(p.x1, 110 - r) && near(p.z0, -5), p);
  const d = ws.computed.get(tpDrill.id).sections[0];
  check('drill-centres', d.paths.length === 2 && d.paths.every((q) => near(q.pts[0][0], 128)) && near(extent([d]).z0, -18.3), d.paths.map((q) => q.pts[0]));
  const v = extent(ws.computed.get(tpV.id).sections);
  check('vcarve-depth', v.z0 < -1 && v.z0 > -12 && near(v.z1, 0), v);
  out.vcarve = v;
}
// automatic feeds follow the material
const softFeed = ws.resolve(tpPocket).feed;
ws.job.material = 'aluminium'; ws.commit();
check('auto-feeds', ws.resolve(tpPocket).feed < softFeed / 2 && ws.resolve(tpPocket).passDepth < 1, [softFeed, ws.resolve(tpPocket)]);
ws.job.material = 'softwood'; ws.commit();
// units: inches only change what is shown and written
ws.job.units = 'in'; ws.commit(); await wait(60);
check('inch-fields', near(parseFloat(ws.jobPanel.querySelector('[data-key="job-w"]').value), 11.811, 0.001), ws.jobPanel.querySelector('[data-key="job-w"]').value);
check('inch-gcode', ws.gcode(true).text.includes('G20'));
ws.job.units = 'mm'; ws.commit();
// XY zero in the centre moves the job coordinates, not the drawing
ws.job.xyZero = 'c'; ws.commit(); ws._compute();
check('zero-centre', near(extent(ws.computed.get(tpCut.id).sections).x0, 50 - 150 - 3.175), extent(ws.computed.get(tpCut.id).sections));
ws.job.xyZero = 'bl'; ws.commit(); ws._compute();
// a bit that cannot fit is reported instead of cutting nonsense
tpPocket.tool = { type: 'end', dia: 60, name: 'Too big' }; ws.commit(); ws._compute();
check('too-big-warning', ws.computed.get(tpPocket.id).warnings.length === 1 && !ws.computed.get(tpPocket.id).sections.length, ws.computed.get(tpPocket.id).warnings);
ws.undo(); ws._compute();
check('undo-toolpath', ws.doc.toolpaths.find((t) => t.id === tpPocket.id).tool.dia === 6.35 && ws.computed.get(tpPocket.id).sections.length === 1);
// deleting a shape drops it from its toolpath
ws.select([hole2.id]); ws.remove(); ws._compute();
check('shape-removed-from-toolpath', ws.doc.toolpaths.find((t) => t.type === 'drill').shapes.length === 1 && ws.computed.get(tpDrill.id).sections[0].paths.length === 1);
ws.undo(); ws._compute();
// round corners keeps the toolpath attached
ws.select([pocket.id]);
check('round-corners', C.dialogs.roundCorners(ws, 5) === 1 && ws.doc.shapes.find((s) => s.id === pocket.id).type === 'path');
ws._compute();
check('rounded-still-cut', ws.computed.get(tpPocket.id).sections.length === 1);

ws.select([plate.id]); ws.tpSel = ws.doc.toolpaths.find((t) => t.type === 'profile').id; ws.refresh();
await wait(150);
check('editor-shown', !!ws.tpPanel.querySelector('.cnc-tp-editor') && ws.tpPanel.querySelectorAll('.cnc-tp-row').length === 5);
await shot('cnc-design');

// ---- G-code
const g = ws.gcode(true);
const lines = g.text.split('\n');
check('gcode-header', lines.some((l) => l === 'G21 G90 G17 G94') && lines.some((l) => /^M3 S\d+/.test(l)) && lines[lines.length - 2] === 'M30', lines.slice(0, 8));
check('gcode-bits', g.tools.length === 3 && lines.filter((l) => l === 'M0').length >= 2, [g.tools.map((t) => t.tool.name), lines.filter((l) => l === 'M0').length]);
check('gcode-bounds', near(g.stats.min[2], -18.3) && g.stats.time > 30, g.stats);
const parsed = C.gcode.parseGcode(g.text);
check('gcode-roundtrip', near(parsed.stats.cut, g.stats.cut, 1) && near(parsed.stats.min[0], g.stats.min[0], 0.01), [parsed.stats.cut, g.stats.cut]);
ws.job.zZero = 'bed'; ws.commit();
check('z-zero-bed', near(C.gcode.parseGcode(ws.gcode(true).text).stats.min[2], -0.3), C.gcode.parseGcode(ws.gcode(true).text).stats.min);
ws.job.zZero = 'top'; ws.commit();
out.gcodeLines = lines.length; out.minutes = +(g.stats.time / 60).toFixed(1);

// ---- 3D preview with material removal
ws.openPreview();
for (let i = 0; i < 80 && ws.preview.sim.done < ws.preview.events.length; i++) await wait(250);
const sim = ws.preview.sim;
let lowest = 0, cut = 0;
for (const v of sim.H) { if (v < lowest) lowest = v; if (v < -0.01) cut++; }
check('preview-open', ws.previewEl.classList.contains('open') && sim.done === ws.preview.events.length, [sim.done, ws.preview.events.length]);
check('preview-carved', near(lowest, -18, 0.01) && cut > 200, [lowest, cut]);
// the pocket floor is 5 mm down in the middle of the pocket (job x 90, y 220)
const cellAt = (x, y) => sim.H[Math.round((y - sim.stock.y0) / sim.cell) * sim.nx + Math.round((x - sim.stock.x0) / sim.cell)];
check('preview-pocket-floor', near(cellAt(90, 220), -5, 0.05) && near(cellAt(20, 20), 0, 1e-6), [cellAt(90, 220), cellAt(20, 20)]);
await shot('cnc-preview');
ws.preview.slider.value = 300; ws.preview.slider.dispatchEvent(new Event('input'));
await wait(300);
check('preview-scrub', sim.done < ws.preview.events.length && sim.done > 0, sim.done);
ws.closePreview();
check('preview-closed', !ws.previewEl.classList.contains('open'));

// ---- machine tab with the demo machine
ws.sendToMachine();
await wait(500);
check('machine-mode', ws.mode === 'machine' && getComputedStyle(ws.machineRoot).display !== 'none' && getComputedStyle(ws.designRoot).display === 'none');
check('program-loaded', panel.program && panel.program.lines.length > 100 && panel.program.parsed.moves.length > 100, panel.program && panel.program.lines.length);
const machine = new C.GrblSim({ speed: 1e9 });
check('connect', await panel.connect(machine));
await wait(1200);
check('idle', dev.status.state === 'Idle' && panel.stateEl.textContent === 'Ready', [dev.status.state, panel.stateEl.textContent]);
check('firmware-read', dev.settings[100] === '80' && /1\.1/.test(panel.fwEl.textContent), [dev.settings[100], panel.fwEl.textContent]);
// jog with the keyboard, then make that spot zero
panel.step = 10; panel._renderSteps();
document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
document.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true, cancelable: true }));
await dev.idle(5000);
check('key-jog', near(dev.status.mpos[0], 10) && near(dev.status.mpos[1], 10) && near(dev.status.mpos[2], -10), dev.status.mpos);
await panel.zero('XYZ'); await wait(500);
check('zero', dev.status.wpos.every((v) => near(v, 0)) && panel.dro.X.work.textContent === '0.000', [dev.status.wpos, panel.dro.X.work.textContent]);
// probing: Z plate, then a corner plate
machine.probeAt = { x: 8, y: 6, z: -30 };
check('probe-z', !!(await C.wizards.probeZ(panel)));
await wait(500);
check('probe-z-zero', near(dev.status.wco[2], -30 - 15) && near(dev.status.wpos[2], 20), [dev.status.wco, dev.status.wpos]);
check('probe-corner', (await C.wizards.probeCorner(panel)) === true);
await wait(500);
// the bit's edge met the plate at machine x 8, y 6: the corner is one plate edge and one bit radius further on
check('probe-corner-zero', near(dev.status.wco[0], 8 + 10 + 3.175) && near(dev.status.wco[1], 6 + 10 + 3.175) && near(dev.status.wpos[0], 0) && near(dev.status.wpos[1], 0), [dev.status.wco, dev.status.wpos]);
machine.probeAt = { x: [15, 30], y: [12, 28], z: -999 };
const centre = await C.wizards.probeCentre(panel);
await wait(400);
check('probe-centre', centre && near(centre[0], 22.5) && near(centre[1], 20) && near(dev.status.wpos[0], 0) && near(dev.status.wpos[1], 0), [centre, dev.status.wpos]);
// a probe that finds nothing raises an alarm, which is explained and can be cleared
check('probe-miss', (await C.wizards.probeZ(panel)) === null);
await wait(500);
check('alarm-banner', dev.status.state === 'Alarm' && panel.banner.classList.contains('alarm') && /probe/i.test(panel.banner.textContent), panel.banner.textContent);
await panel.unlock(); await wait(500);
check('unlocked', dev.status.state === 'Idle' && !panel.banner.classList.contains('open'), dev.status.state);
await panel.cmd('G0 X0 Y0 Z20'); await dev.idle(5000);
check('absolute-after-unlock', near(dev.status.wpos[2], 20) && near(dev.status.wpos[0], 0), dev.status.wpos);

// run the job: it pauses for each bit change and carries on when told
let pauses = 0;
dev.on('jobpause', () => { pauses += 1; setTimeout(() => { out.banner = panel.banner.textContent; panel.pauseResume(); }, 150); });
machine.cutLength = 0;
const res = await panel.start({ confirm: false });
check('job-done', res && res.done && !res.errors.length && res.sent === res.total, res);
check('job-pauses', pauses === lines.filter((l) => l === 'M0').length && /Change the bit|waiting/.test(out.banner || ''), [pauses, out.banner]);
check('job-cut-length', near(machine.cutLength, g.stats.cut, 1), [machine.cutLength, g.stats.cut]);
check('job-progress', panel.bar.firstChild.style.width === '100%' && /Finished/.test(panel.jobInfo.textContent), panel.jobInfo.textContent);
await wait(300);
await shot('cnc-machine');

// feed hold and stop at real speed
machine.speed = 1;
panel.loadProgram({ name: 'slow.gcode', text: 'G21 G90\nG1 X150 F900\nG1 X0\n' });
const slow = panel.start({ confirm: false });
await wait(900);
check('running', dev.status.state === 'Run', dev.status.state);
panel.pauseResume(); await wait(500);
check('hold', dev.status.state === 'Hold' && panel.banner.classList.contains('wait'), dev.status.state);
panel.pauseResume(); await wait(500);
check('resumed', dev.status.state === 'Run', dev.status.state);
await panel.stop();
const stopped = await slow; await wait(700);
check('stopped', stopped && !stopped.done && /Stopped/.test(panel.jobInfo.textContent), [stopped, panel.jobInfo.textContent]);
if (dev.status.state === 'Alarm') { await panel.unlock(); await wait(400); }
machine.speed = 1e9;

// wizards and panes
panel.showTab('tools');
panel.tabBody.querySelector('.cm-card .btn-primary').click();
check('surfacing', panel.program.name === 'Surfacing' && panel.program.parsed.stats.max[0] === 300 && near(panel.program.parsed.stats.min[2], -0.5), panel.program.parsed.stats);
panel.showTab('firmware');
const rows = panel.tabBody.querySelectorAll('.cm-fw-row');
check('firmware-table', rows.length >= 30 && /steps per mm/i.test(panel.tabBody.textContent), rows.length);
const inp = [...rows].find((r) => r.querySelector('code').textContent === '$110').querySelector('input');
inp.value = '4000'; inp.dispatchEvent(new Event('input'));
panel.tabBody.querySelector('.cm-fw-actions .btn-primary').click();
await wait(900);
check('firmware-saved', machine.settings[110] === 4000 && dev.settings[110] === '4000', [machine.settings[110], dev.settings[110]]);
panel.showTab('macros');
check('macros', panel.tabBody.querySelectorAll('.cm-macros .btn').length === 5);
await panel.cmd('G0 X25 Y25'); await dev.idle(5000);
await C.wizards.runMacro(panel, 'G90 G0 X0 Y0'); await dev.idle(5000);
check('macro-ran', near(dev.status.wpos[0], 0) && near(dev.status.wpos[1], 0), dev.status.wpos);
panel.showTab('pins');
check('pins', panel.tabBody.querySelectorAll('.cm-lamp').length === 8);
panel.showTab('console');
check('console-log', panel.consoleLog.children.length > 5);
await dev.disconnect(); await wait(200);
check('disconnected', panel.stateEl.textContent === 'Not connected');

// ---- the remaining toolpath kinds, each on its own shape
ws.setMode('design'); await wait(200);
const before = ws.doc.toolpaths.length;
const box = L.model.makeRect(0, 180, 190, 60, 40);
const line = L.model.makePath(0, [{ closed: false, nodes: [{ x: 30, y: 250 }, { x: 120, y: 270 }] }]);
const cvs = document.createElement('canvas'); cvs.width = 64; cvs.height = 48;
{ const c2 = cvs.getContext('2d'); const grad = c2.createRadialGradient(32, 24, 2, 32, 24, 30); grad.addColorStop(0, '#fff'); grad.addColorStop(1, '#000'); c2.fillStyle = grad; c2.fillRect(0, 0, 64, 48); }
const pic = L.model.makeImage(0, 30, 190, 64, 48, cvs.toDataURL('image/png'), 64, 48);
ws.add([box, line, pic]);
for (let i = 0; i < 40 && !ws.images.has(pic.id); i++) await wait(100);
const made = {};
for (const [type, shape, tweak] of [['engrave', line, (t) => { t.flute = 10; }], ['chamfer', box, null], ['inlay', box, (t) => { t.part = 'plug'; }], ['texture', box, null], ['relief', pic, (t) => { t.depth = 4; }], ['relief', pic, (t) => { t.mode = 'rough'; t.tool = { type: 'end', dia: 6.35, name: '1/4" end mill' }; }]]) {
  ws.select([shape.id]);
  const t = ws.addToolpath(type);
  if (tweak) tweak(t);
  made[type + (t.mode === 'rough' ? '-rough' : '')] = t;
}
ws.commit(); ws._compute();
for (const [k, t] of Object.entries(made)) { const c = ws.computed.get(t.id); check('extra-' + k, c && c.sections.length === 1 && c.sections[0].paths.length > 0 && !c.warnings.length, c && c.warnings); }
{
  const e = extent(ws.computed.get(made.relief.id).sections);
  // the picture is 64 x 48 mm at x 30..94; the bright centre stays high, the dark edge goes to full depth
  check('relief-extent', near(e.x0, 30, 0.2) && near(e.x1, 94, 0.3) && near(e.z0, -4, 0.01) && e.z1 > -0.6, e);
  const eng = ws.computed.get(made.engrave.id).sections[0].paths[0].pts;
  check('engrave-flute', near(eng[0][2], 0, 1e-6) && near(Math.min(...eng.map((q) => q[2])), -0.5, 1e-6), eng[0]);
  const ch = extent(ws.computed.get(made.chamfer.id).sections);
  check('chamfer-depth', near(ch.z0, -2, 1e-6), ch); // 1.5 wide + 0.5 tip offset with a 90 degree bit
}
check('relief-needs-picture', (() => { ws.select([box.id]); const n = ws.doc.toolpaths.length; ws.addToolpath('relief'); return ws.doc.toolpaths.length === n; })());
// nesting keeps parts on the material
ws.select([box.id, plate.id]);
const nested = C.dialogs.nest(ws, 10, 10);
const nb = L.model.boundsOf([ws.doc.shapes.find((s) => s.id === box.id), ws.doc.shapes.find((s) => s.id === plate.id)]);
check('nest', nested.placed === 2 && nested.missed === 0 && near(nb.x0, 10) && near(nb.y1, 290), [nested, nb]);
ws.undo();
// Alt+P opens the preview, Escape closes it
document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', altKey: true, bubbles: true, cancelable: true }));
for (let i = 0; i < 80 && (!ws.preview.open || ws.preview.sim.done < ws.preview.events.length); i++) await wait(250);
check('alt-p-preview', ws.previewEl.classList.contains('open'));
await shot('cnc-preview-all');
document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
check('escape-closes-preview', !ws.previewEl.classList.contains('open'));
// set-up dialog: machine settings and the bit library
C.dialogs.settingsDialog(ws, 'bits'); await wait(100);
const bitRows = document.querySelectorAll('.cnc-bit-row:not(.head)').length;
check('bits-dialog', bitRows === C.tooldb.DEFAULT_TOOLS.length, bitRows);
[...document.querySelectorAll('.modal .lz-row .btn')].find((b) => /Add a bit/.test(b.textContent)).click(); await wait(100);
check('bit-added', ws.bits().length === bitRows + 1 && app.settings.cnc.tools.length === bitRows + 1);
[...document.querySelectorAll('.modal .segmented .btn')].find((b) => /Machine/.test(b.textContent)).click(); await wait(100);
check('machine-settings', /Safe height/.test(document.querySelector('.cnc-setup-body').textContent) && document.querySelectorAll('.cnc-setup-body select').length >= 6);
document.querySelector('.modal-actions .btn-primary').click(); await wait(100);
check('dialog-closed', !document.querySelector('.modal-backdrop'));
ws.saveCfg({ post: 'linuxcnc' });
check('post-linuxcnc', /T1 M6/.test(ws.gcode(true).text) && ws.gcode(true).extension === 'ngc' && !/^M0$/m.test(ws.gcode(true).text));
ws.saveCfg({ post: 'grbl', tools: null });
// the pre-flight checklist stands between "Start" and the spindle
ws.sendToMachine(); await wait(300);
check('reconnect', await panel.connect(new C.GrblSim({ speed: 1e9 }))); await wait(900);
const pending = panel.start();
await wait(300);
check('preflight-shown', /Ready to cut/.test((document.querySelector('.modal-title') || {}).textContent || '') && document.querySelectorAll('.cm-checklist li').length === 4);
[...document.querySelectorAll('.modal-actions .btn')].find((b) => /Not yet/.test(b.textContent)).click();
check('preflight-declined', (await pending) === null && !dev.job);
await dev.disconnect(); await wait(200);
for (const t of Object.values(made)) ws.doc.toolpaths = ws.doc.toolpaths.filter((x) => x.id !== t.id);
ws.doc.shapes = ws.doc.shapes.filter((s) => ![box.id, line.id, pic.id].includes(s.id));
ws.commit();
check('extras-removed', ws.doc.toolpaths.length === before);

// ---- saved with the design, restored on load
ws.setMode('design'); await wait(200);
const saved = JSON.parse(JSON.stringify(ws.getDoc()));
ws.load(null);
check('cleared', ws.doc.shapes.length === 0 && ws.doc.toolpaths.length === 0);
ws.load(saved); ws._compute();
check('reloaded', ws.doc.toolpaths.length === 5 && ws.doc.shapes.length === 6 && ws.computed.size === 5 && [...ws.computed.values()].every((c) => c.sections.length), [ws.doc.toolpaths.length, ws.doc.shapes.length]);
app._markDirty(); await app.flushSave(true);
const text2 = await window.dabbleNative.loadDesign(app.designId);
check('in-design-file', JSON.parse(text2).cnc && JSON.parse(text2).cnc.toolpaths.length === 5);
// the other workspaces are untouched
document.querySelector('.btn[data-mode="laser"]').click(); await wait(300);
check('laser-still-works', app.laser.active && !ws.active && getComputedStyle(app.cncRoot).display === 'none' && app.laser.doc.shapes.length === 0);
document.querySelector('.btn[data-mode="workspace-3d"]').click(); await wait(300);
check('3d-still-works', app.viewMode === 'design' && !document.getElementById('app').classList.contains('cnc-mode'));
return { fails, out };
