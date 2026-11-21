// Depth Map Studio check: node tools/run.js --smoke=tools/smoke-depth.js --shots=<folder>
const app = window.dabble, ed = app.editor, ws = app.laser;
const lib = window.dabbleLib, D = lib.laser.depthmap;
const { CATALOG, nodeFromCatalog } = lib.shapes;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (name) => { await wait(250); await window.dabbleNative.smokeShot(window.__shotDir + '/' + name + '.png'); };
const out = {}; const fails = [];
const check = (name, cond, info) => { if (!cond) fails.push(name + (info !== undefined ? ' -> ' + JSON.stringify(info) : '')); };
const near = (a, b, eps) => Math.abs(a - b) <= eps;
const add = (id, x, y) => { const n = nodeFromCatalog(CATALOG.find((c) => c.id === id)); ed.placeAt(n, x, y); ed.addNode(n); return n; };

// a dome on a plinth in the 3D workspace
const base = add('cylinder', 0, 0); ed.select([base.id]); ed.setSize('x', 60); ed.setSize('y', 60); ed.setSize('z', 4); ed.setPosition('x', -30); ed.setPosition('y', -30);
const dome = add('halfsphere', 0, 0); ed.select([dome.id]); ed.setSize('x', 40); ed.setSize('y', 40); ed.setSize('z', 16); ed.setPosition('x', -20); ed.setPosition('y', -20); ed.setPosition('z', 4);
const star = add('star', 0, 0); ed.select([star.id]); ed.setSize('z', 3); ed.setPosition('x', 14); ed.setPosition('y', 14); ed.setPosition('z', 4); ed.setSize('x', 12, false); ed.setSize('y', 12, false);

check('tabs-under-brand', !!document.querySelector('.workspace-bar .ws-tab[data-mode="laser"]') && document.querySelector('.workspace-bar').previousElementSibling.classList.contains('topbar'));
document.querySelector('.ws-tab[data-mode="laser"]').click(); await wait(300);
check('laser-tab', ws.active && document.querySelector('.ws-tab[data-mode="laser"]').classList.contains('active'));

// raw rasteriser: a unit pyramid seen from the top peaks at 1 in the middle
const pyr = new Float32Array([0, 0, 0, 10, 0, 0, 5, 5, 10, 10, 0, 0, 10, 10, 0, 5, 5, 10, 10, 10, 0, 0, 10, 0, 5, 5, 10, 0, 10, 0, 0, 0, 0, 5, 5, 10]);
const hp = D.heightFromTriangles(pyr, 'top', 101);
check('raster-size', hp.w === 101 && hp.h === 101 && near(hp.widthMM, 10, 1e-6) && near(hp.depthMM, 10, 1e-6), [hp.w, hp.h]);
check('raster-peak', near(hp.data[50 * 101 + 50], 1, 0.02) && near(hp.data[50 * 101 + 25], 0.5, 0.03) && hp.data[0] < 0.03, [hp.data[50 * 101 + 50], hp.data[50 * 101 + 25]]);
// levels: black 25 / white 75 maps 0.5 -> 0.5, clips ends; invert flips; output range squeezes
const base0 = { black: 25, white: 75, gamma: 1, outMin: 0, outMax: 100, invert: false, smooth: 0, background: 'low', posterize: false, slices: 4 };
let p = D.processHeight(hp, base0);
check('levels', near(p[50 * 101 + 25], 0.5, 0.04) && p[50 * 101 + 50] === 1 && p[50 * 101 + 5] === 0, [p[50 * 101 + 25], p[50 * 101 + 50], p[50 * 101 + 5]]);
p = D.processHeight(hp, { ...base0, black: 0, white: 100, invert: true, outMin: 20, outMax: 80 });
check('invert-output', near(p[50 * 101 + 50], 0.2, 0.02) && near(p[0], 0.8, 0.03), [p[50 * 101 + 50], p[0]]);
p = D.processHeight(hp, { ...base0, black: 0, white: 100, posterize: true, slices: 4 });
check('posterize', new Set(Array.from(p).map((v) => v.toFixed(3))).size === 4);
// 16-bit PNG: valid signature, IHDR depth 16, decodes in the browser to the same size
const png = D.encodeGrayPNG(D.processHeight(hp, { ...base0, black: 0, white: 100 }), 101, 101, 16, false);
check('png16-header', png[0] === 137 && png[1] === 80 && png[24] === 16 && png[25] === 0, [png[24], png[25]]);
const bmp = await createImageBitmap(new Blob([png], { type: 'image/png' }));
const cv = document.createElement('canvas'); cv.width = 101; cv.height = 101; const cx = cv.getContext('2d'); cx.drawImage(bmp, 0, 0);
const mid = cx.getImageData(50, 50, 1, 1).data[0], q = cx.getImageData(25, 50, 1, 1).data[0];
check('png16-decodes', bmp.width === 101 && mid >= 250 && Math.abs(q - 128) < 8, [bmp.width, mid, q]);

// studio from the 3D design
const studio = D.depthMapStudio(ws); await wait(200);
studio.useDesign(); await wait(300);
const src = studio.getSource(), pr = studio.getProcessed();
check('design-source', src && near(src.widthMM, 60, 0.5) && near(src.depthMM, 20, 0.3), src && [src.widthMM, src.depthMM]);
const c = Math.floor(src.h / 2) * src.w + Math.floor(src.w / 2);
check('dome-top', near(pr[c], 1, 0.03) && pr[2] === 0 && near(pr[Math.floor(src.h / 2) * src.w + Math.round(src.w * 0.06)], 0.2, 0.03), [pr[c], pr[Math.floor(src.h / 2) * src.w + Math.round(src.w * 0.06)]]);
await shot('dm-map');
// scroll wheel: zooms the flat view about the pointer, the badge resets it
{
  const stage = document.querySelector('.dm-stage'), cvs = stage.querySelector('.dm-canvas'), badge = stage.querySelector('.dm-zoom'), r = stage.getBoundingClientRect();
  const at = { clientX: r.left + r.width / 2 + 60, clientY: r.top + r.height / 2 - 40, bubbles: true, cancelable: true };
  const under = () => { const b = cvs.getBoundingClientRect(); return [(at.clientX - b.left) / b.width, (at.clientY - b.top) / b.height]; };
  const u0 = under();
  for (let i = 0; i < 4; i++) stage.dispatchEvent(new WheelEvent('wheel', { ...at, deltaY: -300 }));
  const z = studio.getZoom(), u1 = under();
  check('wheel-zoom-in', z.s > 1.5 && cvs.style.transform.includes('scale') && !badge.hidden && near(u0[0], u1[0], 0.01) && near(u0[1], u1[1], 0.01), [z, u0, u1]);
  await shot('dm-zoomed');
  for (let i = 0; i < 12; i++) stage.dispatchEvent(new WheelEvent('wheel', { ...at, deltaY: 300 }));
  check('wheel-zoom-out', studio.getZoom().s === 1 && cvs.style.transform === '' && badge.hidden, studio.getZoom());
  stage.dispatchEvent(new WheelEvent('wheel', { ...at, deltaY: -300 })); badge.click();
  check('zoom-reset', studio.getZoom().s === 1 && badge.hidden, studio.getZoom());
}
studio.setTab('slices'); await shot('dm-slices');
studio.setTab('3d'); [...document.querySelectorAll('.modal .segmented .btn')].find((b) => b.textContent === '3D preview').click(); await wait(400); await shot('dm-3d');
{
  const stage = document.querySelector('.dm-stage'), d0 = studio.getZoom().dist;
  stage.dispatchEvent(new WheelEvent('wheel', { deltaY: -300, bubbles: true, cancelable: true }));
  check('wheel-zoom-3d', studio.getZoom().dist < d0, [d0, studio.getZoom().dist]);
  await shot('dm-3d-zoomed');
  stage.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  check('zoom-reset-3d', studio.getZoom().dist === d0, studio.getZoom().dist);
}
out.advice = document.querySelector('.dm-advice').textContent.slice(0, 90);
// STL route: export the design as STL and load it into the studio
const stl = await lib.io.exportModel(ed, 'stl', {});
await studio.loadFile({ name: 'part.stl', data: stl.data.buffer }); await wait(300);
check('stl-source', near(studio.getSource().widthMM, 60, 0.5) && document.querySelector('.modal .insp-note').textContent.includes('part.stl'), studio.getSource().widthMM);
// PNG route
const g = document.createElement('canvas'); g.width = 64; g.height = 32; const gx = g.getContext('2d'); const gr = gx.createLinearGradient(0, 0, 64, 0); gr.addColorStop(0, '#000'); gr.addColorStop(1, '#fff'); gx.fillStyle = gr; gx.fillRect(0, 0, 64, 32);
const blob = await new Promise((r) => g.toBlob(r, 'image/png'));
await studio.loadFile({ name: 'ramp.png', data: await blob.arrayBuffer() }); await wait(300);
const rs = studio.getSource(); check('png-source', rs.w === 64 && rs.h === 32 && rs.data[16 * 64 + 2] < 0.1 && rs.data[16 * 64 + 61] > 0.9, [rs.w, rs.h]);
// back to the design and add it to the laser bed
studio.useDesign(); await wait(200);
const before = ws.doc.shapes.length;
[...document.querySelectorAll('.modal .btn')].find((b) => b.textContent === 'Add to laser workspace').click(); await wait(500);
const im = ws.doc.shapes[ws.doc.shapes.length - 1];
check('added-image', ws.doc.shapes.length === before + 1 && im.type === 'image' && near(im.w, 60, 0.5) && lib.laser.model.layerOf(ws.doc, im.layer).image.mode === 'grayscale', im && [im.type, im.w]);
const plan = ws.plan(); const powers = new Set(plan.moves.filter((mv) => mv.s > 0).map((mv) => mv.s.toFixed(2)));
check('grayscale-gcode', powers.size > 8 && plan.bounds && near(plan.bounds.w, 60, 1.5), [powers.size, plan.bounds && plan.bounds.w]);
ws.zoomToBed(); ws._draw(); await shot('dm-on-bed');
// slice passes: one mask per pass, each on its own layer, engraved in layer order
{
  const st = D.depthMapStudio(ws); await wait(200);
  st.useDesign(); await wait(300);
  st.options.slices = 5;
  const before = ws.doc.shapes.length;
  await st.addSlices(); await wait(300);
  const grp = ws.doc.shapes[ws.doc.shapes.length - 1];
  const layers = grp && grp.children ? grp.children.map((c) => c.layer) : [];
  check('slice-passes', ws.doc.shapes.length === before + 1 && layers.length === 4 && new Set(layers).size === 4, layers);
  const plan = lib.laser.gcode.planJob(ws.doc, ws.machine, ws.getImage);
  const g = lib.laser.gcode.toGcode(plan, ws.doc, ws.machine);
  out.sliceGcodeLines = g.split('\n').length;
  check('slice-gcode', out.sliceGcodeLines > 500 && layers.every((li) => g.includes('Layer ' + String(li + 1).padStart(2, '0')) || g.includes('layer ' + (li + 1))), out.sliceGcodeLines);
  await shot('dm-slice-job');
}
out.fails = fails;
return out;
