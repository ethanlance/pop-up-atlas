// Camera rig: fixed high-angle long-lens view with a critically damped, frame-rate independent follow.
// Contract: createCameraRig(camera) -> { update(dt, traveller), focusPoint: Vector3 }.
import * as THREE from 'three';

const PITCH = THREE.MathUtils.degToRad(55); // degrees below the horizon
const DISTANCE = 21; // FOV 28 at 16:9 -> ~18.6 units (9.3 cells) across the screen at the focus point
const OMEGA = 7; // follow spring: ramp lag 2/OMEGA = 0.29 s, 63 % step time 2.15/OMEGA = 0.31 s
const LOOK_AHEAD = 1.3; // units the view leads in the heading direction
const LOOK_OMEGA = 2.2; // slow, so reversing direction pans gently
const TELEPORT_SPEED = 8; // target speed above this is a jump, not motion

// Exact critically damped step; `goal` is the value at the end of the step, `u` its velocity during it (0 for a jump).
function damp(state, goal, u, omega, dt) {
  const e = Math.exp(-omega * dt);
  const y = state.x - (goal - u * dt) + (2 * u) / omega; // offset from the moving equilibrium, which trails by 2u/omega
  const w = state.v - u;
  const tmp = (w + omega * y) * dt;
  state.x = goal - (2 * u) / omega + (y + tmp) * e;
  state.v = u + (w - omega * tmp) * e;
}

export function createCameraRig(camera) {
  const focusPoint = new THREE.Vector3(0, 0.3, 0);
  const offset = new THREE.Vector3(0, Math.sin(PITCH) * DISTANCE, Math.cos(PITCH) * DISTANCE);
  const fx = { x: 0, v: 0 }, fz = { x: 0, v: 0 }; // followed point on the page
  const lx = { x: 0, v: 0 }, lz = { x: 0, v: 0 }; // look-ahead offset
  const prev = new THREE.Vector2();
  let started = false;
  let time = 0;

  camera.fov = 28;
  camera.updateProjectionMatrix();
  camera.position.copy(offset);
  camera.lookAt(0, 0.3, 0); // orientation never changes afterwards, so there is no rotational jitter

  function update(dt, traveller) {
    const p = traveller.position, h = traveller.heading;
    if (!started) {
      started = true;
      lx.x = h.x * LOOK_AHEAD; lz.x = h.z * LOOK_AHEAD;
      fx.x = p.x + lx.x; fz.x = p.z + lz.x;
      prev.set(fx.x, fz.x);
    }
    if (dt > 0) {
      time += dt;
      damp(lx, h.x * LOOK_AHEAD, 0, LOOK_OMEGA, dt);
      damp(lz, h.z * LOOK_AHEAD, 0, LOOK_OMEGA, dt);
      const gx = p.x + lx.x, gz = p.z + lz.x;
      let ux = (gx - prev.x) / dt, uz = (gz - prev.y) / dt;
      if (Math.hypot(ux, uz) > TELEPORT_SPEED) { ux = 0; uz = 0; }
      damp(fx, gx, ux, OMEGA, dt);
      damp(fz, gz, uz, OMEGA, dt);
      prev.set(gx, gz);
    }
    // Slow breathing drift: a few centimetres, far below the follow motion.
    const bx = 0.05 * Math.sin(time * 0.31), by = 0.04 * Math.sin(time * 0.23 + 1.3);
    camera.position.set(fx.x + offset.x + bx, offset.y + by, fz.x + offset.z);
    focusPoint.set(p.x, 0.3, p.z);
  }

  return { update, focusPoint };
}
