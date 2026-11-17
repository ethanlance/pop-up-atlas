// STUB — replaced by the traveller agent.
import * as THREE from 'three';
export function createTraveller({ scene }) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.55, 0.02), new THREE.MeshStandardMaterial({ color: 0xb5452c, roughness: 0.9 }));
  m.castShadow = true; scene.add(m);
  const position = new THREE.Vector3(), heading = new THREE.Vector3(0, 0, -1);
  return { position, heading, update(dt, input) { position.x += input.dir.x * 2.2 * dt; position.z += input.dir.y * 2.2 * dt;
    if (input.dir.lengthSq() > 0.01) heading.set(input.dir.x, 0, input.dir.y).normalize(); m.position.set(position.x, 0.275, position.z); } };
}
