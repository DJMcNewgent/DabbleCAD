// View cube: a CSS 3D cube that mirrors the camera. Click a face to snap, drag to orbit.
import * as THREE from 'three';
import { h } from '../ui/dom.js';

const D = Math.PI / 180;
const FACES = [
  { name: 'TOP', n: [0, 0, 1], r: [1, 0, 0], u: [0, 1, 0], view: [-90 * D, 0] },
  { name: 'BOTTOM', n: [0, 0, -1], r: [1, 0, 0], u: [0, -1, 0], view: [-90 * D, Math.PI] },
  { name: 'FRONT', n: [0, -1, 0], r: [1, 0, 0], u: [0, 0, 1], view: [-90 * D, 90 * D] },
  { name: 'BACK', n: [0, 1, 0], r: [-1, 0, 0], u: [0, 0, 1], view: [90 * D, 90 * D] },
  { name: 'RIGHT', n: [1, 0, 0], r: [0, 1, 0], u: [0, 0, 1], view: [0, 90 * D] },
  { name: 'LEFT', n: [-1, 0, 0], r: [0, -1, 0], u: [0, 0, 1], view: [180 * D, 90 * D] },
];
const HALF = 28;

export class ViewCube {
  constructor(viewport) {
    this.viewport = viewport;
    this.el = h('div', { class: 'viewcube', title: 'Click a face to look from that side. Drag to orbit.' });
    this.faces = FACES.map((f) => {
      const el = h('div', { class: 'viewcube-face' }, f.name);
      el.addEventListener('click', () => { if (!this._dragged) viewport.viewFrom(f.view[0], f.view[1]); });
      this.el.append(el);
      return { ...f, el, n: new THREE.Vector3(...f.n), r: new THREE.Vector3(...f.r), u: new THREE.Vector3(...f.u) };
    });
    this.el.addEventListener('pointerdown', (e) => this._down(e));
    viewport.onRender(() => this.update());
  }

  _down(e) {
    if (e.button !== 0) return;
    const vp = this.viewport;
    this._dragged = false;
    let lx = e.clientX, ly = e.clientY, total = 0;
    const move = (ev) => {
      const dx = ev.clientX - lx, dy = ev.clientY - ly;
      lx = ev.clientX; ly = ev.clientY;
      total += Math.abs(dx) + Math.abs(dy);
      if (total < 4) return;
      this._dragged = true;
      vp._anim = null;
      vp.theta -= dx * 0.012;
      vp.phi = Math.min(Math.PI - 0.0006, Math.max(0.0006, vp.phi - dy * 0.012));
      vp.requestRender();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setTimeout(() => { this._dragged = false; }, 0);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  update() {
    const e = this.viewport.camera.matrixWorldInverse.elements;
    // rotation rows of the view matrix, with Y flipped for CSS (y grows downwards)
    const ax = (v) => [e[0] * v.x + e[4] * v.y + e[8] * v.z, -(e[1] * v.x + e[5] * v.y + e[9] * v.z), e[2] * v.x + e[6] * v.y + e[10] * v.z];
    const neg = new THREE.Vector3();
    for (const f of this.faces) {
      const c0 = ax(f.r), c1 = ax(neg.copy(f.u).negate()), c2 = ax(f.n);
      const t = c2.map((v) => v * HALF);
      f.el.style.transform = `matrix3d(${c0[0]},${c0[1]},${c0[2]},0,${c1[0]},${c1[1]},${c1[2]},0,${c2[0]},${c2[1]},${c2[2]},0,${t[0]},${t[1]},${t[2]},1)`;
    }
  }
}
