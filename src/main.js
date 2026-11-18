import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createWFC } from './wfc.js';
import { createWorld } from './world.js';
import { createInput } from './input.js';
import { createTraveller } from './traveller.js';
import { createCameraRig } from './cameraRig.js';
import { createLook } from './look.js';
import { createAudio } from './audio.js';

const params = new URLSearchParams(location.search);
const seed = Number(params.get('seed') ?? 1);

const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, Number(params.get('dpr') ?? 1.5)));
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(28, 1, 0.5, 200);

const [gltf, tilesJson] = await Promise.all([
  new GLTFLoader().loadAsync('./assets/tiles.glb').catch(() => null),
  fetch('./assets/tiles.json').then((r) => r.json()).catch(() => null),
]);

const audio = createAudio();
const wfc = createWFC(tilesJson, seed);
const world = createWorld({ scene, gltf, tilesJson, wfc, audio });
const input = createInput(renderer.domElement, camera);
const traveller = createTraveller({ scene, gltf, world, audio });
const rig = createCameraRig(camera);
const look = createLook({ renderer, scene, camera });
if (params.get('auto')) input.setAuto(true);
addEventListener('pointerdown', () => audio.resume(), { once: true });
addEventListener('keydown', () => audio.resume(), { once: true });

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  look.resize(w, h);
}
addEventListener('resize', resize);
resize();

const frames = [];
let last = performance.now();
function frame(now) {
  const raw = now - last;
  last = now;
  frames.push(raw);
  if (frames.length > 600) frames.shift();
  const dt = Math.min(raw / 1000, 1 / 20);
  input.update(dt, traveller.position);
  traveller.update(dt, input);
  world.update(dt, traveller.position, traveller.heading);
  rig.update(dt, traveller);
  audio.setListener(traveller.position.x, traveller.position.z);
  look.setFocus(rig.focusPoint ?? traveller.position);
  look.render(dt);
}
// ?manual=1: the capture tools drive time themselves through __atlas.step(ms) for exact frame spacing.
const manual = params.get('manual');
let manualNow = last;
if (!manual) renderer.setAnimationLoop(frame);

window.__atlas = {
  world, input, look, traveller, renderer,
  teleport(x, z) { traveller.position.set(x, 0, z); },
  stats() {
    const s = [...frames].sort((a, b) => a - b);
    const avg = s.reduce((a, b) => a + b, 0) / (s.length || 1);
    return { fps: 1000 / avg, p95: s[Math.floor(s.length * 0.95)] ?? 0, calls: renderer.info.render.calls,
      tris: renderer.info.render.triangles, ...world.stats() };
  },
  resetStats() { frames.length = 0; },
  step(ms = 1000 / 60, n = 1) { for (let i = 0; i < n; i++) { manualNow += ms; frame(manualNow); } },
};
