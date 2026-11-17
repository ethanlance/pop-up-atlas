// STUB — replaced by the look agent.
import * as THREE from 'three';
export function createLook({ renderer, scene, camera }) {
  scene.background = new THREE.Color(0x1b140f);
  const key = new THREE.DirectionalLight(0xffc98a, 2.6); key.position.set(6, 10, 4); key.castShadow = true; scene.add(key, key.target);
  scene.add(new THREE.HemisphereLight(0x9fb4d8, 0x3a2a1c, 0.7)); renderer.shadowMap.enabled = true;
  return { render() { renderer.render(scene, camera); }, resize() {}, setFocus(p) { key.target.position.copy(p); key.position.set(p.x + 6, 10, p.z + 4); } };
}
