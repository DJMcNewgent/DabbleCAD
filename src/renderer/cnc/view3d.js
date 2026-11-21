// 3D view of a CNC job: the stock, the cutter path, the simulated result and the bit itself.
// Z is up. Coordinates are job coordinates (Z = 0 at the top of the material).
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

const WOOD = new THREE.Color('#dcbf8f'), CUT = new THREE.Color('#9a6a3c'), DEEP = new THREE.Color('#5d3d22');

export class PathView3D {
  constructor(container, { antialias = true } = {}) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.canvas = this.renderer.domElement;
    this.canvas.className = 'cnc-view3d-canvas';
    this.canvas.setAttribute('aria-label', '3D view of the job');
    container.appendChild(this.canvas);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(38, 1, 1, 20000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(150, -260, 240);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.target.set(150, 150, 0);
    this.controls.enableDamping = false;
    this.controls.zoomSpeed = 1.4;
    this.controls.addEventListener('change', () => this.render());
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x80858f, 1.5));
    this.sun = new THREE.DirectionalLight(0xffffff, 1.6);
    this.sun.position.set(-0.5, -0.8, 1.4);
    this.scene.add(this.sun);
    this.stockGroup = new THREE.Group();
    this.pathGroup = new THREE.Group();
    this.toolGroup = new THREE.Group();
    this.toolGroup.visible = false;
    this.scene.add(this.stockGroup, this.pathGroup, this.toolGroup);
    this.stock = { x0: 0, y0: 0, w: 300, h: 300, t: 18 };
    this.showPath = true;
    this.setTheme();
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
  }

  setTheme() {
    const light = document.documentElement.dataset.theme === 'light';
    this.scene.background = new THREE.Color(light ? '#e4e9f0' : '#14161b');
    this.render();
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.render();
  }

  render() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = null; this.renderer.render(this.scene, this.camera); });
  }

  _empty(group) {
    for (const o of [...group.children]) { group.remove(o); o.traverse((c) => { if (c.geometry) c.geometry.dispose(); if (c.material) c.material.dispose(); }); }
  }

  /** stock: { x0, y0, w, h, t }; solid = draw the block itself (off when a simulated surface is shown). */
  setStock(stock, solid = true) {
    this.stock = { ...stock };
    this._empty(this.stockGroup);
    this.surface = null;
    // zTop: where the top of the stock is in the program's coordinates (0, or the thickness when Z zero is the bed)
    const { x0, y0, w, h, t } = stock, top = stock.zTop || 0;
    const box = new THREE.BoxGeometry(w, h, t);
    box.translate(x0 + w / 2, y0 + h / 2, top - t / 2);
    if (solid) this.stockGroup.add(new THREE.Mesh(box, new THREE.MeshStandardMaterial({ color: WOOD, roughness: 0.9, transparent: true, opacity: 0.55, depthWrite: false })));
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(box), new THREE.LineBasicMaterial({ color: 0x8b98aa }));
    this.stockGroup.add(edges);
    // the machine bed under the stock
    const bed = new THREE.Mesh(new THREE.PlaneGeometry(w * 1.3, h * 1.3), new THREE.MeshStandardMaterial({ color: 0x3a3f4a, roughness: 1 }));
    bed.position.set(x0 + w / 2, y0 + h / 2, top - t - 0.05);
    this.stockGroup.add(bed);
    // XYZ zero marker
    const axis = (dir, color) => { const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), dir]); return new THREE.Line(g, new THREE.LineBasicMaterial({ color })); };
    const len = Math.max(10, Math.min(w, h) * 0.12);
    this.stockGroup.add(axis(new THREE.Vector3(len, 0, 0), 0xef5350), axis(new THREE.Vector3(0, len, 0), 0x66bb6a), axis(new THREE.Vector3(0, 0, len), 0x42a5f5));
    this.render();
  }

  /** moves: [{ x, y, z, rapid }] (x / y may be null on the very first lift). */
  setPath(moves) {
    this._empty(this.pathGroup);
    this.moveCount = 0;
    const pos = [], col = [];
    let prev = null;
    const light = document.documentElement.dataset.theme === 'light';
    const cCut = light ? [0.1, 0.35, 0.9] : [0.35, 0.72, 1], cRapid = [0.95, 0.4, 0.35], cPlunge = [0.3, 0.8, 0.45];
    this.segOfMove = new Int32Array(moves.length);
    let segs = 0;
    moves.forEach((m, i) => {
      const p = [m.x ?? (prev ? prev[0] : NaN), m.y ?? (prev ? prev[1] : NaN), m.z];
      if (prev && isFinite(prev[0]) && isFinite(p[0])) {
        pos.push(prev[0], prev[1], prev[2], p[0], p[1], p[2]);
        const c = m.rapid ? cRapid : Math.hypot(p[0] - prev[0], p[1] - prev[1]) < 1e-6 ? cPlunge : cCut;
        col.push(...c, ...c);
        segs += 1;
      }
      this.segOfMove[i] = segs;
      prev = p;
    });
    this.moveCount = moves.length;
    if (!segs) { this.render(); return; }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    this.lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85 }));
    // the part of the job that has already run, drawn over the top in a second colour
    const g2 = new THREE.BufferGeometry();
    g2.setAttribute('position', g.getAttribute('position'));
    g2.setDrawRange(0, 0);
    this.doneLines = new THREE.LineSegments(g2, new THREE.LineBasicMaterial({ color: 0xffa726, depthTest: false }));
    this.doneLines.renderOrder = 2;
    this.pathGroup.add(this.lines, this.doneLines);
    this.pathGroup.visible = this.showPath;
    this.render();
  }

  setPathVisible(on) { this.showPath = on; this.pathGroup.visible = on; this.render(); }

  /** Highlight the first n moves as done. */
  setProgress(n) {
    if (!this.doneLines) return;
    const segs = n <= 0 ? 0 : this.segOfMove[Math.min(n, this.moveCount) - 1] || 0;
    this.doneLines.geometry.setDrawRange(0, segs * 2);
    this.render();
  }

  /** Show (or refresh) the simulated surface from a Simulator. */
  setSurface(sim) {
    const { nx, ny, cell, H, stock } = sim;
    if (!this.surface || this.surface.userData.nx !== nx || this.surface.userData.ny !== ny) {
      if (this.surface) { this.stockGroup.remove(this.surface); this.surface.geometry.dispose(); this.surface.material.dispose(); }
      const g = new THREE.BufferGeometry();
      const pos = new Float32Array(nx * ny * 3), col = new Float32Array(nx * ny * 3);
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const k = (j * nx + i) * 3; pos[k] = stock.x0 + Math.min(stock.w, i * cell); pos[k + 1] = stock.y0 + Math.min(stock.h, j * cell); }
      const idx = new Uint32Array((nx - 1) * (ny - 1) * 6);
      let q = 0;
      for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) { const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1; idx[q++] = a; idx[q++] = b; idx[q++] = d; idx[q++] = a; idx[q++] = d; idx[q++] = c; }
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      g.setIndex(new THREE.BufferAttribute(idx, 1));
      this.surface = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, flatShading: true, side: THREE.DoubleSide }));
      this.surface.userData = { nx, ny };
      this.stockGroup.add(this.surface);
    }
    const pos = this.surface.geometry.getAttribute('position'), col = this.surface.geometry.getAttribute('color');
    const t = Math.max(0.01, stock.t), c = new THREE.Color();
    for (let k = 0; k < H.length; k++) {
      const z = H[k];
      pos.array[k * 3 + 2] = z;
      if (z > -1e-4) c.copy(WOOD); else c.copy(CUT).lerp(DEEP, Math.min(1, -z / t));
      col.array[k * 3] = c.r; col.array[k * 3 + 1] = c.g; col.array[k * 3 + 2] = c.b;
    }
    pos.needsUpdate = true; col.needsUpdate = true;
    this.surface.geometry.computeBoundingSphere();
    this.render();
  }

  /** Put the bit at a position (null hides it). */
  setTool(p, tool) {
    if (!p) { if (this.toolGroup.visible) { this.toolGroup.visible = false; this.render(); } return; }
    const key = tool ? [tool.type, tool.dia, tool.angle].join('|') : 'none';
    if (this.toolGroup.userData.key !== key) {
      this._empty(this.toolGroup);
      const r = tool ? tool.dia / 2 : 3, mat = new THREE.MeshStandardMaterial({ color: 0xcfd8dc, metalness: 0.6, roughness: 0.35 });
      let tipH = 0;
      if (tool && tool.type === 'vbit') {
        tipH = r / Math.tan(((tool.angle || 60) / 2) * Math.PI / 180);
        const cone = new THREE.Mesh(new THREE.ConeGeometry(r, tipH, 24), mat);
        cone.rotation.x = -Math.PI / 2; cone.position.z = tipH / 2;
        this.toolGroup.add(cone);
      } else if (tool && tool.type === 'ball') {
        tipH = r;
        const ball = new THREE.Mesh(new THREE.SphereGeometry(r, 20, 12), mat);
        ball.position.z = r;
        this.toolGroup.add(ball);
      }
      const len = Math.max(20, r * 6);
      const shank = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 24), mat);
      shank.rotation.x = Math.PI / 2; shank.position.z = tipH + len / 2;
      this.toolGroup.add(shank);
      this.toolGroup.userData.key = key;
    }
    this.toolGroup.position.set(p[0], p[1], p[2]);
    this.toolGroup.visible = true;
    this.render();
  }

  view(name = 'iso') {
    const s = this.stock, cx = s.x0 + s.w / 2, cy = s.y0 + s.h / 2, d = Math.max(s.w, s.h, 40);
    this.controls.target.set(cx, cy, (s.zTop || 0) - s.t / 2);
    if (name === 'top') this.camera.position.set(cx, cy - 0.001, d * 2);
    else if (name === 'front') this.camera.position.set(cx, cy - d * 2.2, d * 0.3);
    else this.camera.position.set(cx - d * 0.75, cy - d * 1.55, d * 1.25);
    this.camera.near = Math.max(0.5, d / 400); this.camera.far = d * 40;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.render();
  }
}
