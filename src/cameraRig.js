// STUB — replaced by the traveller agent.
import * as THREE from 'three';
export function createCameraRig(camera) {
  const focusPoint = new THREE.Vector3();
  return { focusPoint, update(dt, tr) { focusPoint.lerp(tr.position, 1 - Math.exp(-dt * 3));
    camera.position.set(focusPoint.x, 16, focusPoint.z + 11); camera.lookAt(focusPoint); } };
}
