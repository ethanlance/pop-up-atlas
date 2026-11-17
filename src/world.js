// STUB — replaced by the world agent.
import * as THREE from 'three';
export function createWorld({ scene }) {
  const page = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.MeshStandardMaterial({ color: 0xe9dcc3, roughness: 0.95 }));
  page.rotation.x = -Math.PI / 2; page.receiveShadow = true; scene.add(page);
  return { update() {}, isWalkable: () => true, stats: () => ({ tilesUp: 0, flapsMoving: 0 }) };
}
