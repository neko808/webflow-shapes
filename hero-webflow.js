// Webflow build of the raymonafa hero: shapes + materials + physics +
// mouse interaction only. No background, no typography, no clock — the
// script mounts a transparent canvas into whatever Webflow div carries
// the attribute data-hero-3d and sizes itself to that div.
//
// Requires an import map on the page (see the embed snippet):
//   three, three/addons/, three-mesh-bvh, three-bvh-csg, rapier3d
import * as THREE from 'three';
import RAPIER from 'rapier3d';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Brush, Evaluator, ADDITION } from 'three-bvh-csg';

// Where the .glb files live (CDN with CORS). Trailing slash required.
// e.g. 'https://cdn.jsdelivr.net/gh/<user>/<repo>@main/'
const ASSET_BASE = new URL('.', import.meta.url).href;

const container = document.querySelector('[data-hero-3d]');
if (!container) throw new Error('[hero] no element with data-hero-3d found');
if (getComputedStyle(container).position === 'static') {
  container.style.position = 'relative';
}

const canvas = document.createElement('canvas');
Object.assign(canvas.style, {
  position: 'absolute', inset: '0', width: '100%', height: '100%',
  display: 'block', pointerEvents: 'none', // clicks fall through to Webflow content
});
container.appendChild(canvas);

await RAPIER.init();
const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
world.numSolverIterations = 8;

const renderer = new THREE.WebGLRenderer({
  canvas, alpha: true, antialias: false, powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.toneMapping = THREE.ACESFilmicToneMapping;

const scene = new THREE.Scene();
scene.environment = new THREE.PMREMGenerator(renderer)
  .fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.5;

const camera = new THREE.PerspectiveCamera(22.5, 1, 1, 80);
camera.position.set(0, 0, 16);

scene.add(new THREE.AmbientLight(0xffffff, 0.25));
const key = new THREE.DirectionalLight(0xffffff, 0.8);
key.position.set(4, 8, 6);
scene.add(key);

// ---- Palette (click a shape to cycle it) -----------------------------------
const PALETTE = ['#BAF50A', '#f6ff00', '#140DD7', '#0DD775'];
let paletteIndex = 0;
const allMaterials = [];

function glassMat() {
  const m = new THREE.MeshPhysicalMaterial({
    color: PALETTE[0],
    roughness: 0.15, metalness: 0,
    transmission: 1, thickness: 1.2, ior: 1.4,
    clearcoat: 1, clearcoatRoughness: 0.1,
    envMapIntensity: 2,
  });
  allMaterials.push(m);
  return m;
}
function matteMat() {
  const m = new THREE.MeshStandardMaterial({
    color: PALETTE[0], roughness: 0.35, metalness: 0.05,
  });
  allMaterials.push(m);
  return m;
}

// ---- Shape builders ---------------------------------------------------------

function voxelU(mat) {
  const boxes = [];
  const cells = [
    [0,0],[1,0],[2,0],[3,0],
    [0,1],[3,1],[0,2],[3,2],[0,3],[3,3],
    [1.5,1],
  ];
  for (const [x, y] of cells) {
    const g = new THREE.BoxGeometry(1, 1, 1.2);
    g.translate(x - 1.5, y - 1.5, 0);
    boxes.push(g);
  }
  const mesh = new THREE.Mesh(BufferGeometryUtils.mergeGeometries(boxes), mat);
  mesh.scale.setScalar(0.81);
  return mesh;
}

function letterM(mat) {
  const D = 1.6;
  const boxes = [];
  const add = (x, y, w, h) => {
    const g = new THREE.BoxGeometry(w, h, D);
    g.translate(x + w / 2, y + h / 2, 0);
    boxes.push(g);
  };
  for (const x of [0, 2, 4]) add(x, 0, 1, 3);
  add(0, 3, 5, 1);
  for (const x of [0, 2, 4]) add(x, 4, 1, 1);
  for (const x of [1, 3]) {
    add(x, 4, 1, 0.6);
    add(x, 4.6, 0.3, 0.4);
    add(x + 0.7, 4.6, 0.3, 0.4);
  }
  const geo = BufferGeometryUtils.mergeGeometries(boxes);
  geo.center();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.scale.setScalar(0.6);
  return mesh;
}

// ---- External .glb loader ----------------------------------------------------

function splitShells(geometry) {
  const pos = geometry.attributes.position;
  const triVerts = geometry.index ? geometry.index.array : null;

  const weldId = new Uint32Array(pos.count);
  const seen = new Map();
  for (let i = 0; i < pos.count; i++) {
    const key = `${pos.getX(i).toFixed(4)},${pos.getY(i).toFixed(4)},${pos.getZ(i).toFixed(4)}`;
    let id = seen.get(key);
    if (id === undefined) { id = seen.size; seen.set(key, id); }
    weldId[i] = id;
  }

  const parent = new Uint32Array(seen.size);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  const find = (x) => { while (parent[x] !== x) x = parent[x] = parent[parent[x]]; return x; };
  const triCount = (triVerts ? triVerts.length : pos.count) / 3;
  const vertAt = (t, k) => (triVerts ? triVerts[3 * t + k] : 3 * t + k);
  for (let t = 0; t < triCount; t++) {
    const a = find(weldId[vertAt(t, 0)]);
    parent[find(weldId[vertAt(t, 1)])] = a;
    parent[find(weldId[vertAt(t, 2)])] = a;
  }

  const byRoot = new Map();
  for (let t = 0; t < triCount; t++) {
    const root = find(weldId[vertAt(t, 0)]);
    let tris = byRoot.get(root);
    if (!tris) byRoot.set(root, (tris = []));
    tris.push(vertAt(t, 0), vertAt(t, 1), vertAt(t, 2));
  }
  if (byRoot.size < 2) return [geometry];

  return [...byRoot.values()].map((tris) => {
    const part = new THREE.BufferGeometry();
    for (const name of Object.keys(geometry.attributes)) {
      part.setAttribute(name, geometry.attributes[name]);
    }
    part.setIndex(tris);
    return part;
  });
}

function unionShells(mesh) {
  const parts = splitShells(mesh.geometry);
  if (parts.length < 2) return;
  const evaluator = new Evaluator();
  evaluator.attributes = ['position', 'normal'];
  let brush = new Brush(parts[0]);
  brush.updateMatrixWorld();
  for (let i = 1; i < parts.length; i++) {
    const next = new Brush(parts[i]);
    next.updateMatrixWorld();
    brush = evaluator.evaluate(brush, next, ADDITION);
  }
  mesh.geometry = brush.geometry;
}

const gltfLoader = new GLTFLoader();
async function loadGLB(url, size = 2.7, smooth = false, union = false) {
  const gltf = await gltfLoader.loadAsync(ASSET_BASE + url);
  const template = gltf.scene;

  if (union) template.traverse((c) => { if (c.isMesh) unionShells(c); });

  if (smooth) {
    template.traverse((c) => {
      if (!c.isMesh) return;
      let g = c.geometry;
      g.deleteAttribute('normal');
      g.deleteAttribute('uv');
      g = BufferGeometryUtils.mergeVertices(g, 1e-4);
      g.computeVertexNormals();
      c.geometry = g;
    });
  }

  const box = new THREE.Box3().setFromObject(template);
  const center = box.getCenter(new THREE.Vector3());
  const dim = box.getSize(new THREE.Vector3());
  const k = size / Math.max(dim.x, dim.y, dim.z || 1);
  template.position.sub(center);

  const wrap = new THREE.Group();
  wrap.add(template);
  wrap.scale.setScalar(k);

  return (mat) => {
    const obj = wrap.clone(true);
    obj.traverse((c) => { if (c.isMesh) c.material = mat; });
    return obj;
  };
}

// ---- Physics helpers ----------------------------------------------------------

function hullPoints(obj, inflate = 1.04) {
  obj.updateMatrixWorld(true);
  const pts = [];
  const v = new THREE.Vector3();
  obj.traverse((c) => {
    if (!c.isMesh) return;
    const p = c.geometry.attributes.position;
    for (let i = 0; i < p.count; i += 2) {
      v.fromBufferAttribute(p, i).applyMatrix4(c.matrixWorld).multiplyScalar(inflate);
      pts.push(v.x, v.y, v.z);
    }
  });
  return new Float32Array(pts);
}

function makeShape(build, home, fromLeft, delay, gummy) {
  const obj = build(gummy ? glassMat() : matteMat());
  obj.scale.multiplyScalar(0.56);
  scene.add(obj);

  const startX = fromLeft ? home[0] - 30 : home[0] + 30;
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(startX, home[1], home[2])
      .setLinearDamping(1.05)
      .setAngularDamping(0.35)
      .setCcdEnabled(true)
  );
  world.createCollider(
    RAPIER.ColliderDesc.convexHull(hullPoints(obj))
      .setFriction(0.4)
      .setRestitution(0.3)
      .setMass(1),
    body
  );
  return {
    obj, body, home,
    baseScale: obj.scale.x,
    delay, started: false, intro: 0, fromLeft,
    wobble: { x: (Math.random() - 0.5) * 0.9, y: (Math.random() - 0.5) * 0.7 },
  };
}

const shapes = [
  makeShape(voxelU,        [ 8, 0, 0], true,  0,   false),
  makeShape((m) => new THREE.Mesh(new RoundedBoxGeometry(1.9, 1.9, 1.9, 6, 0.18), m),
                           [ 8, 0, 0], true,  5,   false),
  makeShape(letterM,       [ 8, 0, 0], true,  10,  false),
  makeShape((m) => new THREE.Mesh(new THREE.CapsuleGeometry(0.6, 1.55, 12, 32), m),
                           [-8, 0, 0], false, 20,  true),
];

const GLB_MODELS = [
  // Original raymonafa.com bumpy sphere (their "h" letter), replacing the
  // procedural swirl. Clean single shell with authored normals.
  { url: 'h.glb',      home: [-8, 0, 0], fromLeft: false, delay: 0,  gummy: true, size: 2.8 },
  { url: 'cross.glb',  home: [-8, 0, 0], fromLeft: false, delay: 30, gummy: true, size: 2.57 },
  { url: 'crosstube.glb', home: [-8, 0, 0], fromLeft: false, delay: 10, gummy: true, size: 2.9 },
  // Original raymonafa.com asterisk (their "e" letter), Draco-decoded to a
  // plain .glb. Single clean shell with authored normals -> no union/smooth.
  { url: 'e.glb', home: [-8, 0, 0], fromLeft: false, delay: 40, gummy: true, size: 3.45 },
];

for (const m of GLB_MODELS) {
  try {
    const build = await loadGLB(m.url, m.size, m.smooth, m.union);
    shapes.push(makeShape(build, m.home, m.fromLeft, m.delay, m.gummy));
  } catch (err) {
    console.warn(`[glb] could not load ${m.url}:`, err);
  }
}

for (const s of shapes) setTimeout(() => { s.started = true; }, s.delay);

// ---- Kinematic cursor ball -----------------------------------------------------
const cursorBody = world.createRigidBody(
  RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(99, 99, 0)
);
world.createCollider(RAPIER.ColliderDesc.ball(0.5), cursorBody);

// Mouse mapped relative to the container, not the window, so the physics
// lines up with the visuals wherever the hero sits on the Webflow page.
const mouse = new THREE.Vector2(99, 99);
const cursorPos = new THREE.Vector3(99, 99, 0);
const cursorTarget = new THREE.Vector3();
function toNDC(e, out) {
  const r = container.getBoundingClientRect();
  out.set(
    ((e.clientX - r.left) / r.width) * 2 - 1,
    -((e.clientY - r.top) / r.height) * 2 + 1
  );
  return out;
}
addEventListener('pointermove', (e) => { toNDC(e, mouse); });

const raycaster = new THREE.Raycaster();
const clickNDC = new THREE.Vector2();
addEventListener('pointerdown', (e) => {
  raycaster.setFromCamera(toNDC(e, clickNDC), camera);
  if (raycaster.intersectObjects(shapes.map((s) => s.obj), true).length) {
    paletteIndex = (paletteIndex + 1) % PALETTE.length;
    for (const m of allMaterials) m.color.set(PALETTE[paletteIndex]);
  }
});

// ---- Sizing (follows the container, not the window) -----------------------------
let halfW = 1, halfH = 1;
function resize() {
  const w = Math.max(1, container.clientWidth);
  const h = Math.max(1, container.clientHeight);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  halfH = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.position.z;
  halfW = halfH * camera.aspect;
}
new ResizeObserver(resize).observe(container);
resize();

// ---- Frame loop ------------------------------------------------------------------
const clock = new THREE.Clock();
const tmp = new THREE.Vector3();

renderer.setAnimationLoop(() => {
  const dt = Math.min(0.12, clock.getDelta());
  const t = clock.elapsedTime;

  if (mouse.x !== 99) {
    cursorTarget.set(mouse.x * halfW, mouse.y * halfH, 0);
    cursorPos.lerp(cursorTarget, 0.12);
    cursorBody.setNextKinematicTranslation(cursorPos);
  }

  for (const s of shapes) {
    if (!s.started || s.intro < 1) {
      if (s.started) s.intro = Math.min(1, s.intro + 0.6 * dt);
      const e = 1 - Math.pow(1 - s.intro, 3);
      const startX = s.fromLeft ? s.home[0] - 30 : s.home[0] + 30;
      s.body.setTranslation({ x: startX + (s.home[0] - startX) * e, y: s.home[1], z: s.home[2] }, true);
      s.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      s.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      s.obj.scale.setScalar(s.baseScale * (0.3 + 0.7 * e));
    } else {
      const wx = 0.16 * Math.sin(0.95 * t + 0.18 * s.home[0]) + s.wobble.x;
      const wy = 0.12 * Math.cos(1.15 * t + 0.11 * s.home[0]) + s.wobble.y;
      s.body.applyImpulse({ x: wx * dt * 2.4, y: wy * dt * 2, z: 0 }, true);

      const p = s.body.translation();
      tmp.set(p.x, p.y, p.z).normalize().multiplyScalar(-25 * dt);
      s.body.applyImpulse({ x: tmp.x, y: 2 * tmp.y, z: tmp.z }, true);
    }
  }

  world.timestep = dt;
  world.step();

  for (const s of shapes) {
    const p = s.body.translation();
    const q = s.body.rotation();
    s.obj.position.set(p.x, p.y, p.z);
    s.obj.quaternion.set(q.x, q.y, q.z, q.w);
  }

  renderer.render(scene, camera);
});
