// 3D viewport: renderer, cameras, navigation, workplane and lighting. World space is Z-up, millimetres.
import * as THREE from 'three';

THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

const FOV = 38;
const DEG = Math.PI / 180;
export const HOME_VIEW = { theta: -68 * DEG, phi: 60 * DEG };

const THEMES = {
  dark: { bg: 0x16181d, plane: 0x242a35, minor: 0x343d4c, major: 0x4c5a70, border: 0x6b7c96, label: '#5d6c84', temp: 0x7c6fe0 },
  light: { bg: 0xf1f4f8, plane: 0xe6e8ec, minor: 0xcfd3da, major: 0xaeb4bf, border: 0x8a919e, label: '#9aa1ad', temp: 0x7c6fe0 },
};

const GRID_VERT = /* glsl */`
  varying vec2 vPos;
  void main() {
    vPos = position.xy;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

const GRID_FRAG = /* glsl */`
  uniform vec3 uPlane; uniform vec3 uMinor; uniform vec3 uMajor; uniform vec3 uBorder;
  uniform vec2 uHalf; uniform float uOpacity; uniform float uStep; uniform float uMajorEvery;
  varying vec2 vPos;
  float gridLine(vec2 p, float size, float width) {
    vec2 g = abs(fract(p / size - 0.5) - 0.5) * size;
    vec2 fw = fwidth(p);
    vec2 a = 1.0 - smoothstep(fw * width * 0.5, fw * (width * 0.5 + 1.0), g);
    return max(a.x, a.y);
  }
  void main() {
    vec2 fw = fwidth(vPos);
    float density = max(fw.x, fw.y) / uStep;              // grid cells per pixel
    float minorFade = 1.0 - smoothstep(0.12, 0.45, density);
    float majorFade = 1.0 - smoothstep(0.12, 0.45, density / uMajorEvery);
    float minor = gridLine(vPos, uStep, 1.0) * minorFade;
    float major = gridLine(vPos, uStep * uMajorEvery, 1.4) * majorFade;
    vec3 col = mix(uPlane, uMinor, minor);
    col = mix(col, uMajor, major);
    vec2 edge = (uHalf - abs(vPos)) / fw;
    float border = 1.0 - smoothstep(1.0, 2.5, min(edge.x, edge.y));
    col = mix(col, uBorder, border);
    gl_FragColor = vec4(col, uOpacity);
    #include <colorspace_fragment>
  }`;

function gridMaterial(opacity) {
  return new THREE.ShaderMaterial({
    vertexShader: GRID_VERT,
    fragmentShader: GRID_FRAG,
    uniforms: {
      uPlane: { value: new THREE.Color() }, uMinor: { value: new THREE.Color() }, uMajor: { value: new THREE.Color() },
      uBorder: { value: new THREE.Color() }, uHalf: { value: new THREE.Vector2(100, 100) },
      uOpacity: { value: opacity }, uStep: { value: 1 }, uMajorEvery: { value: 10 },
    },
    transparent: true, side: THREE.DoubleSide, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
  });
}

export class Viewport {
  constructor(container, settings) {
    this.container = container;
    this.settings = settings;
    this.theme = settings.theme === 'light' ? 'light' : 'dark';
    this.handlers = {}; // leftDown, hover, contextMenu, dblclick, leave
    this.renderListeners = [];
    this.navigating = false;

    this.renderer = new THREE.WebGLRenderer({
      antialias: settings.antialias !== false,
      powerPreference: settings.gpu === 'off' ? 'default' : 'high-performance',
      alpha: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.canvas = this.renderer.domElement;
    this.canvas.setAttribute('aria-label', '3D design view');
    this.canvas.setAttribute('role', 'img');
    this.canvas.className = 'viewport-canvas';
    container.appendChild(this.canvas);

    this.scene = new THREE.Scene();
    this.objects = new THREE.Group(); // model meshes
    this.helpers = new THREE.Group(); // gizmo helpers, ghosts
    this.scene.add(this.objects, this.helpers);

    this.persp = new THREE.PerspectiveCamera(FOV, 1, 1, 10000);
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 20000);
    this.camera = settings.projection === 'orthographic' ? this.ortho : this.persp;
    this.target = new THREE.Vector3(0, 0, 0);
    this.theta = HOME_VIEW.theta;
    this.phi = HOME_VIEW.phi;
    this.radius = 330;

    // lights: soft sky fill, a headlight that follows the camera and a fixed sun for shadows
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x8d939c, 1.25);
    this.hemi.position.set(0, 0, 1);
    this.head = new THREE.DirectionalLight(0xffffff, 1.55);
    this.sun = new THREE.DirectionalLight(0xffffff, 0.75);
    this.sun.position.set(-120, -160, 320);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.6;
    this.scene.add(this.hemi, this.head, this.head.target, this.sun, this.sun.target);

    // workplane
    this.frame = new THREE.Matrix4(); // active workplane frame (world)
    this.workplane = { width: 200, length: 200 };
    this.gridMat = gridMaterial(0.92);
    this.grid = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.gridMat);
    this.grid.renderOrder = -2;
    this.shadowCatcher = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: 0.22, depthWrite: false, polygonOffset: true, polygonOffsetFactor: 0.5, polygonOffsetUnits: 0.5 }));
    this.shadowCatcher.receiveShadow = true;
    this.shadowCatcher.renderOrder = -1;
    this.label = new THREE.Mesh(new THREE.PlaneGeometry(64, 12.8), new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: 0.2, polygonOffsetUnits: 0.2 }));
    this.label.renderOrder = -1;
    this.tempMat = gridMaterial(0.38);
    this.tempGrid = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.tempMat);
    this.tempGrid.matrixAutoUpdate = false;
    this.tempGrid.visible = false;
    this.tempGrid.renderOrder = -1;
    this.scene.add(this.grid, this.shadowCatcher, this.label, this.tempGrid);

    this.raycaster = new THREE.Raycaster();
    this.raycaster.firstHitOnly = false;
    this._ndc = new THREE.Vector2();
    this._needsRender = true;
    this._anim = null;

    this.setWorkplaneSize(200, 200);
    this.setTheme(this.theme);
    this.setShadows(settings.shadows !== false);
    this._bindEvents();
    this.resize();
    new ResizeObserver(() => this.resize()).observe(container);
    // the CSS size can stay the same when the window moves to a monitor with different scaling
    const watchDpr = () => matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
      .addEventListener('change', () => { this.resize(); watchDpr(); }, { once: true });
    watchDpr();
    const loop = () => {
      requestAnimationFrame(loop);
      this._tick();
    };
    requestAnimationFrame(loop);
  }

  // ---------------------------------------------------------------- appearance
  setTheme(theme) {
    this.theme = theme === 'light' ? 'light' : 'dark';
    const t = THEMES[this.theme];
    this.scene.background = new THREE.Color(t.bg);
    const u = this.gridMat.uniforms;
    u.uPlane.value.set(t.plane); u.uMinor.value.set(t.minor); u.uMajor.value.set(t.major); u.uBorder.value.set(t.border);
    const v = this.tempMat.uniforms;
    v.uPlane.value.set(t.temp); v.uMinor.value.set(0xffffff); v.uMajor.value.set(0xffffff); v.uBorder.value.set(0xffffff);
    this._drawLabel(t.label);
    this.hemi.intensity = this.theme === 'light' ? 1.3 : 1.2;
    this.requestRender();
  }

  _drawLabel(color) {
    const c = document.createElement('canvas');
    c.width = 640; c.height = 128;
    const ctx = c.getContext('2d');
    ctx.fillStyle = color;
    ctx.font = '600 92px "Segoe UI", system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText('Workplane', 8, 70);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    if (this.label.material.map) this.label.material.map.dispose();
    this.label.material.map = tex;
    this.label.material.needsUpdate = true;
  }

  setShadows(on) {
    this.sun.castShadow = !!on;
    this.shadowCatcher.visible = !!on;
    this.requestRender();
  }

  setWorkplaneSize(width, length) {
    this.workplane = { width, length };
    this.grid.scale.set(width, length, 1);
    this.shadowCatcher.scale.set(width * 3, length * 3, 1);
    this.gridMat.uniforms.uHalf.value.set(0.5, 0.5); // plane geometry is unit sized; shader works in mm below
    this.grid.geometry.dispose();
    this.grid.geometry = new THREE.PlaneGeometry(width, length);
    this.grid.scale.set(1, 1, 1);
    this.gridMat.uniforms.uHalf.value.set(width / 2, length / 2);
    const scale = Math.min(1, width / 150);
    this.label.scale.set(scale, scale, 1);
    this.label.position.set(-width / 2 + 34 * scale, -length / 2 + 8.5 * scale, 0.02);
    const d = Math.max(width, length);
    const cam = this.sun.shadow.camera;
    cam.left = -d; cam.right = d; cam.top = d; cam.bottom = -d; cam.near = 1; cam.far = d * 6 + 800;
    cam.updateProjectionMatrix();
    this.sun.position.set(-0.45 * d - 60, -0.6 * d - 80, 1.4 * d + 150);
    this.requestRender();
  }

  setGridStep(step, majorEvery = 10) {
    for (const m of [this.gridMat, this.tempMat]) {
      m.uniforms.uStep.value = step;
      m.uniforms.uMajorEvery.value = majorEvery;
    }
    this.requestRender();
  }

  /** frame = Matrix4 of the temporary workplane, or null for the base workplane. */
  setFrame(frame) {
    if (frame) {
      this.frame.copy(frame);
      this.tempGrid.geometry.dispose();
      this.tempGrid.geometry = new THREE.PlaneGeometry(120, 120);
      this.tempMat.uniforms.uHalf.value.set(60, 60);
      this.tempGrid.matrix.copy(frame);
      this.tempGrid.visible = true;
    } else {
      this.frame.identity();
      this.tempGrid.visible = false;
    }
    this.requestRender();
  }

  setProjection(mode) {
    this.camera = mode === 'orthographic' ? this.ortho : this.persp;
    this.requestRender();
  }

  get isOrtho() { return this.camera === this.ortho; }

  // ---------------------------------------------------------------- render loop
  requestRender() { this._needsRender = true; }
  onRender(fn) { this.renderListeners.push(fn); }

  resize() {
    if (!this.container.clientWidth || !this.container.clientHeight) return; // hidden while another workspace shows
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (this.renderer.getPixelRatio() !== dpr) this.renderer.setPixelRatio(dpr); // moved to a monitor with other scaling
    const w = Math.max(1, this.container.clientWidth), h = Math.max(1, this.container.clientHeight);
    this.width = w; this.height = h;
    this.renderer.setSize(w, h, false);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.requestRender();
  }

  _updateCamera() {
    const sp = Math.sin(this.phi), dir = new THREE.Vector3(sp * Math.cos(this.theta), sp * Math.sin(this.theta), Math.cos(this.phi));
    const aspect = this.width / this.height;
    const halfH = this.radius * Math.tan((FOV * DEG) / 2);
    this.persp.aspect = aspect;
    this.persp.near = Math.max(0.5, this.radius / 200);
    this.persp.far = this.radius * 20 + 6000;
    this.persp.position.copy(this.target).addScaledVector(dir, this.radius);
    this.persp.up.set(0, 0, 1);
    this.persp.lookAt(this.target);
    this.persp.updateProjectionMatrix();
    const dist = Math.max(this.radius, 3000);
    this.ortho.left = -halfH * aspect; this.ortho.right = halfH * aspect; this.ortho.top = halfH; this.ortho.bottom = -halfH;
    this.ortho.near = 0.1; this.ortho.far = dist * 2 + 6000;
    this.ortho.position.copy(this.target).addScaledVector(dir, dist);
    this.ortho.up.set(0, 0, 1);
    this.ortho.lookAt(this.target);
    this.ortho.updateProjectionMatrix();
    this.persp.updateMatrixWorld();
    this.ortho.updateMatrixWorld();
    // headlight from the upper left of the viewer
    const cam = this.camera;
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
    this.head.position.copy(this.target).addScaledVector(dir, 1000).addScaledVector(right, -450).addScaledVector(up, 520);
    this.head.target.position.copy(this.target);
    this.head.target.updateMatrixWorld();
  }

  _tick() {
    if (this._anim) {
      const a = this._anim;
      const t = Math.min(1, (performance.now() - a.start) / a.duration);
      const e = 1 - (1 - t) ** 3;
      this.theta = a.from.theta + (a.to.theta - a.from.theta) * e;
      this.phi = a.from.phi + (a.to.phi - a.from.phi) * e;
      this.radius = a.from.radius + (a.to.radius - a.from.radius) * e;
      this.target.lerpVectors(a.from.target, a.to.target, e);
      if (t >= 1) this._anim = null;
      this._needsRender = true;
    }
    if (!this._needsRender) return;
    this._needsRender = false;
    this._updateCamera();
    this.renderer.render(this.scene, this.camera);
    for (const fn of this.renderListeners) fn();
  }

  renderNow() {
    this._updateCamera();
    this.renderer.render(this.scene, this.camera);
    for (const fn of this.renderListeners) fn();
  }

  // ---------------------------------------------------------------- camera moves
  animateTo(to, duration = 320) {
    let dTheta = (to.theta ?? this.theta) - this.theta;
    dTheta = ((dTheta + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    this._anim = {
      start: performance.now(), duration,
      from: { theta: this.theta, phi: this.phi, radius: this.radius, target: this.target.clone() },
      to: {
        theta: this.theta + dTheta, phi: to.phi ?? this.phi, radius: to.radius ?? this.radius,
        target: (to.target || this.target).clone(),
      },
    };
    this.requestRender();
  }

  home() {
    const d = Math.max(this.workplane.width, this.workplane.length);
    this.animateTo({ ...HOME_VIEW, radius: d * 1.65, target: new THREE.Vector3(0, 0, 0) });
  }

  fit(box) {
    if (!box || box.isEmpty()) return this.home();
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const r = Math.max(sphere.radius, 2);
    const aspect = Math.min(1, this.width / this.height);
    this.animateTo({ target: sphere.center, radius: (r / Math.sin((FOV * DEG) / 2) / aspect) * 1.12 });
  }

  viewFrom(theta, phi) {
    this.animateTo({ theta, phi: Math.min(Math.PI - 0.0006, Math.max(0.0006, phi)) });
  }

  zoomBy(factor) {
    this.animateTo({ radius: Math.min(60000, Math.max(1, this.radius * factor)) }, 160);
  }

  // ---------------------------------------------------------------- picking helpers
  _setNdc(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    this._ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    return this._ndc;
  }

  rayFromClient(clientX, clientY) {
    this.raycaster.setFromCamera(this._setNdc(clientX, clientY), this.camera);
    return this.raycaster.ray.clone();
  }

  /** Intersections of a screen point with a list of meshes, nearest first. */
  pick(clientX, clientY, meshes) {
    this.raycaster.setFromCamera(this._setNdc(clientX, clientY), this.camera);
    return this.raycaster.intersectObjects(meshes, false);
  }

  /** World point -> container pixel coordinates. */
  project(v, out = {}) {
    const p = v.clone().project(this.camera);
    out.x = (p.x * 0.5 + 0.5) * this.width;
    out.y = (-p.y * 0.5 + 0.5) * this.height;
    out.behind = p.z > 1 || p.z < -1;
    return out;
  }

  /** World units covered by one pixel at a world point. */
  unitsPerPixel(point) {
    if (this.isOrtho) return (this.ortho.top - this.ortho.bottom) / this.height;
    const dist = Math.max(0.001, point.clone().sub(this.persp.position).dot(this.viewDirection()));
    return (2 * dist * Math.tan((FOV * DEG) / 2)) / this.height;
  }

  viewDirection() {
    return new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 2).negate();
  }

  // ---------------------------------------------------------------- navigation
  _bindEvents() {
    const el = this.canvas;
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('pointerdown', (e) => this._pointerDown(e));
    el.addEventListener('pointermove', (e) => { if (!this.navigating && this.handlers.hover) this.handlers.hover(e); });
    el.addEventListener('pointerleave', (e) => { if (this.handlers.leave) this.handlers.leave(e); });
    el.addEventListener('dblclick', (e) => { if (this.handlers.dblclick) this.handlers.dblclick(e); });
    el.addEventListener('wheel', (e) => this._wheel(e), { passive: false });
  }

  _pointerDown(e) {
    const el = this.canvas;
    let mode = null;
    if (e.button === 2) mode = e.shiftKey ? 'pan' : 'orbit';
    else if (e.button === 1) mode = 'pan';
    else if (e.button === 0 && e.ctrlKey) mode = e.shiftKey ? 'pan' : 'orbit';
    if (!mode) {
      if (e.button === 0 && this.handlers.leftDown) this.handlers.leftDown(e);
      return;
    }
    e.preventDefault();
    this._anim = null;
    try { el.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    this.navigating = true;
    let lastX = e.clientX, lastY = e.clientY, moved = 0;
    const speed = this.settings.orbitSpeed || 1;
    const move = (ev) => {
      const dx = ev.clientX - lastX, dy = ev.clientY - lastY;
      lastX = ev.clientX; lastY = ev.clientY;
      moved += Math.abs(dx) + Math.abs(dy);
      const m = e.button === 2 ? (ev.shiftKey ? 'pan' : 'orbit') : mode;
      if (m === 'orbit') {
        this.theta -= dx * 0.0085 * speed;
        this.phi = Math.min(Math.PI - 0.0006, Math.max(0.0006, this.phi - dy * 0.0085 * speed));
      } else {
        const upp = this.unitsPerPixel(this.target);
        const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
        const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
        this.target.addScaledVector(right, -dx * upp).addScaledVector(up, dy * upp);
      }
      this.requestRender();
    };
    const up = (ev) => {
      try { el.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      this.navigating = false;
      if (e.button === 2 && moved < 5 && this.handlers.contextMenu) this.handlers.contextMenu(ev);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  _wheel(e) {
    e.preventDefault();
    this._anim = null;
    let delta = e.deltaY;
    if (e.deltaMode === 1) delta *= 32;
    if (this.settings.zoomInvert) delta = -delta;
    const k = (e.ctrlKey ? 0.012 : 0.0016) * (this.settings.zoomSpeed || 1);
    const f = Math.exp(Math.max(-1.2, Math.min(1.2, delta * k)));
    const next = Math.min(60000, Math.max(1, this.radius * f));
    const scale = next / this.radius;
    // keep the point under the cursor fixed
    const ray = this.rayFromClient(e.clientX, e.clientY);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(this.viewDirection(), this.target);
    const hit = ray.intersectPlane(plane, new THREE.Vector3());
    if (hit) this.target.sub(hit).multiplyScalar(scale).add(hit);
    this.radius = next;
    this.requestRender();
  }

  // ---------------------------------------------------------------- snapshots
  snapshot(width = 480, height = 360, mime = 'image/jpeg') {
    this.renderNow();
    const out = document.createElement('canvas');
    out.width = width; out.height = height;
    const ctx = out.getContext('2d');
    const sw = this.canvas.width, sh = this.canvas.height;
    const scale = Math.max(width / sw, height / sh);
    const dw = sw * scale, dh = sh * scale;
    ctx.drawImage(this.canvas, (width - dw) / 2, (height - dh) / 2, dw, dh);
    return out.toDataURL(mime, 0.82);
  }

  screenshot() {
    this.renderNow();
    return this.canvas.toDataURL('image/png');
  }

  gpuName() {
    const gl = this.renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  }
}
