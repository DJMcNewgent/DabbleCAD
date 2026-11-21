// Renders small isometric previews of shapes for the shape panel (lazily, with a shared offscreen renderer).
import * as THREE from 'three';
import { getGeometry, expandBox } from '../core/geometry.js';
import { mat4, ownColors } from '../core/doc.js';

let renderer = null;
let scene, camera, mesh, holeMat, solidMat;
const cache = new Map();
const queue = [];
let running = false;

function setup() {
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setSize(144, 144, false);
  renderer.setClearColor(0x000000, 0);
  scene = new THREE.Scene();
  camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 5000);
  camera.up.set(0, 0, 1);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f99, 1.35));
  const key = new THREE.DirectionalLight(0xffffff, 1.7);
  key.position.set(-0.6, -1, 1.6);
  scene.add(key);
  solidMat = new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0.03 });
  holeMat = new THREE.MeshStandardMaterial({ color: 0xc9d0d8, roughness: 0.85, transparent: true, opacity: 0.62 });
  mesh = new THREE.Mesh(new THREE.BufferGeometry(), solidMat);
  mesh.matrixAutoUpdate = false;
  scene.add(mesh);
}

function render(node) {
  if (!renderer) setup();
  const geo = getGeometry(node);
  mesh.geometry = geo;
  const multi = ownColors(node) && !!geo.attributes.color;
  solidMat.vertexColors = multi;
  solidMat.color.set(multi ? '#ffffff' : node.color);
  solidMat.needsUpdate = true;
  mesh.material = node.hole ? holeMat : solidMat;
  mesh.matrix.copy(mat4(node.matrix));
  mesh.updateMatrixWorld(true);
  const box = expandBox(new THREE.Box3(), geo, mesh.matrix);
  if (box.isEmpty()) box.set(new THREE.Vector3(-10, -10, 0), new THREE.Vector3(10, 10, 20));
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const dir = new THREE.Vector3(0.55, -0.95, 0.62).normalize();
  camera.position.copy(sphere.center).addScaledVector(dir, sphere.radius * 4 + 10);
  camera.lookAt(sphere.center);
  const r = sphere.radius * 1.04;
  camera.left = -r; camera.right = r; camera.top = r; camera.bottom = -r;
  camera.far = sphere.radius * 6 + 20;
  camera.updateProjectionMatrix();
  renderer.render(scene, camera);
  return renderer.domElement.toDataURL('image/png');
}

function pump() {
  if (running) return;
  running = true;
  const step = () => {
    const start = performance.now();
    while (queue.length && performance.now() - start < 10) {
      const job = queue.shift();
      let url = cache.get(job.key);
      if (!url) {
        try { url = render(job.make()); } catch (err) { console.warn('thumbnail failed', job.key, err); url = ''; }
        cache.set(job.key, url);
      }
      job.resolve(url);
    }
    if (queue.length) setTimeout(step, 0); else running = false;
  };
  setTimeout(step, 0);
}

/** key: cache key, make: () => node. Resolves to a PNG data URL. */
export function thumbnail(key, make) {
  if (cache.has(key)) return Promise.resolve(cache.get(key));
  return new Promise((resolve) => { queue.push({ key, make, resolve }); pump(); });
}

export const dropThumbnail = (key) => cache.delete(key);
