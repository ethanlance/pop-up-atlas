// STUB — replaced by the traveller agent.
import * as THREE from 'three';
export function createInput() {
  const dir = new THREE.Vector2(); const keys = {}; let auto = false, t = 0;
  addEventListener('keydown', (e) => (keys[e.code] = 1)); addEventListener('keyup', (e) => (keys[e.code] = 0));
  return { dir, setAuto(v) { auto = v; }, update(dt) { t += dt;
    if (auto) return dir.set(Math.cos(t * 0.3), -Math.abs(Math.sin(t * 0.3)) - 0.3).normalize();
    dir.set((keys.KeyD || 0) - (keys.KeyA || 0), (keys.KeyS || 0) - (keys.KeyW || 0)); if (dir.lengthSq() > 1) dir.normalize(); } };
}
