// Traveller: a flat paper puppet that hop-walks over the page.
// Contract: createTraveller({scene, gltf, world, audio}) -> { position: Vector3, heading: Vector3, update(dt, input) }.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const SPEED = 2.2; // units per second
const ACCEL = SPEED / 0.12; // reaches full speed, or stops, in ~0.12 s
const STEP_RATE = 3.6; // footfalls per second at full speed
const HOP = 0.06; // hop apex height
const SQUASH = 0.055; // landing squash (spec: <= 6 %)
const LEG_SWING = 0.55; // radians at the hip
const LEAN = 0.14; // radians of lean into the direction of travel at full speed
const LEAN_OMEGA = 15, LEAN_ZETA = 0.2; // under-damped: the card wobbles on its tab when it stops
const YAW_OMEGA = 28, YAW_ZETA = 0.5; // springy flip, reaches the new facing in ~0.09 s
const MAX_YAW = (Math.PI / 180) * 40; // the card never turns edge-on to the camera
const TILT_BACK = 0.3; // the card rests leaning away from the reader, so its face reads from the high camera
const THICK = 0.015;

// ---- procedural fallback figure (used when tiles.glb has no `traveller` node) -----------------------------------
const EDGE = new THREE.Color(0xf6efe0); // lighter paper core on the cut edges
const paperMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 });

// One flat card piece: extruded outline, face colour on both sides, paper-core colour on the cut edge.
function cardGeo(shape, color, z) {
  const geo = new THREE.ExtrudeGeometry(shape, { depth: THICK, bevelEnabled: false, curveSegments: 10 });
  geo.translate(0, 0, z - THICK / 2);
  const face = new THREE.Color(color);
  const colors = new Float32Array(geo.attributes.position.count * 3);
  for (const grp of geo.groups) {
    const c = grp.materialIndex === 0 ? face : EDGE;
    for (let i = grp.start; i < grp.start + grp.count; i++) c.toArray(colors, i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.clearGroups();
  return geo;
}

function cardMesh(geos, name) {
  const mesh = new THREE.Mesh(geos.length > 1 ? mergeGeometries(geos) : geos[0], paperMat);
  mesh.name = name;
  mesh.castShadow = true;
  return mesh;
}

function polygon(points) {
  const s = new THREE.Shape();
  s.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) s.lineTo(points[i][0], points[i][1]);
  s.closePath();
  return s;
}

function limbShape(len, wTop, wEnd, foot) {
  const s = new THREE.Shape();
  s.absarc(0, 0, wTop / 2, 0, Math.PI, false);
  s.lineTo(-wEnd / 2, -len + wEnd / 2);
  if (foot) {
    s.lineTo(-wEnd / 2, -len);
    s.lineTo(foot - 0.012, -len);
    s.quadraticCurveTo(foot, -len, foot, -len + 0.016);
    s.quadraticCurveTo(foot - 0.004, -len + 0.03, wEnd / 2, -len + 0.036);
  } else {
    s.absarc(0, -len + wEnd / 2, wEnd / 2, Math.PI, Math.PI * 2, false);
  }
  s.closePath();
  return s;
}

function buildFallback() {
  const fig = new THREE.Group();
  const step = THICK + 0.001;

  const coat = new THREE.Shape();
  coat.moveTo(-0.082, 0.165);
  coat.lineTo(0.086, 0.165);
  coat.quadraticCurveTo(0.07, 0.27, 0.05, 0.372);
  coat.lineTo(-0.042, 0.372);
  coat.quadraticCurveTo(-0.07, 0.27, -0.082, 0.165);
  const head = new THREE.Shape();
  head.absarc(0.004, 0.428, 0.058, 0.25, Math.PI * 2 - 0.25, false);
  head.lineTo(0.078, 0.424); // nose, the figure looks towards +X
  head.closePath();
  const hat = polygon([[-0.098, 0.452], [0.104, 0.462], [0.1, 0.476], [0.045, 0.482], [0.012, 0.55], [-0.03, 0.535],
    [-0.046, 0.478], [-0.096, 0.468]]);
  const scarf = polygon([[0.05, 0.366], [0.054, 0.39], [-0.044, 0.392], [-0.12, 0.372], [-0.135, 0.34], [-0.1, 0.352],
    [-0.046, 0.366]]);
  const pack = new THREE.Shape();
  pack.moveTo(-0.118, 0.22);
  pack.lineTo(-0.03, 0.22);
  pack.lineTo(-0.03, 0.352);
  pack.lineTo(-0.1, 0.352);
  pack.quadraticCurveTo(-0.124, 0.345, -0.124, 0.32);
  pack.closePath();
  const roll = new THREE.Shape();
  roll.absellipse(-0.078, 0.366, 0.05, 0.02, 0, Math.PI * 2, false, 0);
  fig.add(cardMesh([cardGeo(coat, 0xb5452c, 0), cardGeo(head, 0xf0dcc0, 0), cardGeo(hat, 0x3d5a5b, step),
    cardGeo(scarf, 0xe9c46a, step), cardGeo(pack, 0xd9a441, -2 * step), cardGeo(roll, 0x8a9a5b, -2 * step)], 'body'));

  const leg = limbShape(0.165, 0.044, 0.032, 0.062);
  const arm = limbShape(0.12, 0.036, 0.034, 0);
  const limbs = [['legL', leg, 0x5b3a29, 0.012, 0.186, step], ['legR', leg, 0x4a2f22, -0.012, 0.186, -step],
    ['armL', arm, 0x9c3b26, 0.004, 0.338, step], ['armR', arm, 0x8a3422, -0.004, 0.338, -step]];
  for (const [name, shape, color, x, y, z] of limbs) {
    const mesh = cardMesh([cardGeo(shape, color, z)], name);
    mesh.position.set(x, y, 0);
    fig.add(mesh);
  }

  const tab = new THREE.Shape();
  tab.absellipse(0, 0, 0.15, 0.075, 0, Math.PI * 2, false, 0);
  const standGeo = cardGeo(tab, 0xefe6d2, THICK / 2);
  standGeo.rotateX(-Math.PI / 2);
  fig.add(cardMesh([standGeo], 'stand'));
  return fig;
}

// Faint pencil cross that lies on the page where the reader pointed, then fades. Not UI: no ring, no glow.
function buildMarker() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.lineCap = 'round';
  const stroke = (x0, y0, x1, y1) => {
    for (let pass = 0; pass < 5; pass++) {
      g.strokeStyle = `rgba(58,50,44,${0.3 + 0.1 * Math.sin(pass * 2.1)})`;
      g.lineWidth = 3 + 1.5 * Math.sin(pass * 1.3);
      g.beginPath();
      g.moveTo(x0 + 3 * Math.sin(pass * 3.7), y0 + 3 * Math.cos(pass * 2.9));
      g.quadraticCurveTo(64 + 5 * Math.sin(pass * 1.9 + x0), 64 + 5 * Math.cos(pass * 2.3 + y0),
        x1 + 3 * Math.cos(pass * 3.1), y1 + 3 * Math.sin(pass * 4.3));
      g.stroke();
    }
  };
  stroke(30, 26, 100, 104);
  stroke(102, 30, 28, 98);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.34), new THREE.MeshBasicMaterial({
    map: tex, transparent: true, opacity: 0, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4,
  }));
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.012;
  mesh.visible = false;
  mesh.renderOrder = 2;
  return mesh;
}

export function createTraveller({ scene, gltf, world, audio }) {
  const position = new THREE.Vector3();
  const heading = new THREE.Vector3(0, 0, -1);
  const vel = new THREE.Vector2();

  // root (page position + hop) -> lean (wobble about the tab) -> yaw (facing + squash) -> figure
  const root = new THREE.Group();
  const lean = new THREE.Group();
  const yawG = new THREE.Group();
  const standYaw = new THREE.Group();
  lean.position.y = THICK;
  yawG.position.y = -THICK;
  root.add(standYaw, lean);
  lean.add(yawG);
  scene.add(root);

  const src = gltf?.scene?.getObjectByName?.('traveller');
  let figure = src ? src.clone(true) : buildFallback();
  const axis = new THREE.Vector3(0, 0, 1); // card normal in the figure frame; limbs swing about it
  figure.position.set(0, 0, 0);
  figure.rotation.set(0, 0, 0);
  figure.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(figure);
  const size = box.getSize(new THREE.Vector3());
  const fit = new THREE.Group();
  if (src) {
    if (size.x < size.z) { axis.set(1, 0, 0); fit.rotation.y = -Math.PI / 2; } // card modelled in the YZ plane
    const s = size.y > 0.45 && size.y < 0.68 ? 1 : 0.55 / (size.y || 0.55);
    fit.scale.setScalar(s);
    fit.position.y = -box.min.y * s;
  }
  fit.add(figure);
  yawG.add(fit);
  // The tab stays flat under the figure while the card above it leans and wobbles.
  const stand = figure.getObjectByName('stand');
  if (stand) {
    const fit2 = new THREE.Group();
    fit2.position.copy(fit.position); fit2.rotation.copy(fit.rotation); fit2.scale.copy(fit.scale);
    standYaw.add(fit2);
    fit2.add(stand);
  }
  root.traverse((o) => { if (o.isMesh) o.castShadow = true; });

  const limbs = ['legL', 'legR', 'armL', 'armR'].map((name) => {
    const node = figure.getObjectByName(name);
    if (!node) return null;
    const base = node.quaternion.clone();
    return { node, base, axis: axis.clone().applyQuaternion(base.clone().invert()) };
  });
  const q = new THREE.Quaternion();
  const swing = (limb, angle) => {
    if (limb) limb.node.quaternion.copy(limb.base).multiply(q.setFromAxisAngle(limb.axis, angle));
  };

  const marker = buildMarker();
  scene.add(marker);

  let phase = 0; // counts footfalls; the fraction is the position inside the current hop
  let hopAmp = 0;
  let speedNow = 0;
  let yaw = 0, yawVel = 0, facing = 1;
  let leanX = 0, leanZ = 0, leanVX = 0, leanVZ = 0;
  let slideSide = 1, contactAge = 1;
  const normal = new THREE.Vector2(), scratch = new THREE.Vector2();
  let steps = 0;
  let lightAge = 10, lightSide = 0;
  let markerOpacity = 0;

  const ok = (x, z) => world.isWalkable(x, z);

  // Blocked samples on a ring around the traveller: count, and the direction pointing away from them.
  function ring(radius, n, out) {
    let count = 0, nx = 0, nz = 0;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2, cx = Math.cos(a), cz = Math.sin(a);
      if (!ok(position.x + cx * radius, position.z + cz * radius)) { count++; nx -= cx; nz -= cz; }
    }
    const len = Math.hypot(nx, nz);
    out.set(len > 1e-6 ? nx / len : 0, len > 1e-6 ? nz / len : 0);
    return count;
  }

  // Move by (dx, dz) without entering a blocked position; slide along whatever is in the way.
  function move(dx, dz, dt) {
    contactAge += dt;
    if (ok(position.x + dx, position.z + dz)) { position.x += dx; position.z += dz; return; }
    // Go flush against the obstacle, so no gap is left to creep into.
    let lo = 0, hi = 1;
    for (let i = 0; i < 5; i++) {
      const mid = (lo + hi) / 2;
      if (ok(position.x + dx * mid, position.z + dz * mid)) lo = mid; else hi = mid;
    }
    position.x += dx * lo; position.z += dz * lo;
    dx *= 1 - lo; dz *= 1 - lo;
    // Axis slide: handles walls and cell edges.
    const px = position.x, pz = position.z, ax = Math.abs(dx), az = Math.abs(dz);
    const xFree = ax > 1e-7 && ok(px + dx, pz), zFree = az > 1e-7 && ok(px, pz + dz);
    if (xFree && (!zFree || ax >= az)) { position.x += dx; return; }
    if (zFree) { position.z += dz; return; }
    // Tangent slide: handles round obstacles and corners met at an angle.
    if (!ring(0.12, 48, normal)) return;
    const tx = -normal.y, tz = normal.x, along = dx * tx + dz * tz, len = Math.hypot(dx, dz);
    // The normal is an estimate, so a tangent step may graze the obstacle: retry tilted a little away from it.
    const slide = (d) => {
      for (const lift of [0, 0.3, 0.7]) {
        const sx = tx * d + normal.x * Math.abs(d) * lift, sz = tz * d + normal.y * Math.abs(d) * lift;
        if (ok(px + sx, pz + sz)) { position.x += sx; position.z += sz; return true; }
      }
      return false;
    };
    if (Math.abs(along) > 0.2 * len) { slide(along); return; }
    // Met head-on. Step around a convex obstacle; stand still against a wall or in a concave corner.
    if (ring(0.45, 24, scratch) > 10) return;
    if (contactAge > 0.25 && along !== 0) slideSide = Math.sign(along);
    contactAge = 0;
    if (!slide(slideSide * len * 0.8) && slide(-slideSide * len * 0.8)) slideSide = -slideSide;
  }

  // Spawned or teleported into a blocked spot: step out to the nearest free one.
  function escape() {
    for (let r = 0.2; r <= 6; r += 0.2) {
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        const x = position.x + Math.cos(a) * r, z = position.z + Math.sin(a) * r;
        if (ok(x, z)) { position.x = x; position.z = z; return; }
      }
    }
  }

  function update(dt, input) {
    if (!input.walkable) input.walkable = ok; // the auto wanderer looks ahead through this
    if (dt <= 0) return;
    if (!ok(position.x, position.z)) escape();

    // --- locomotion: accelerate the velocity towards the wanted one at a fixed rate
    const wantX = input.dir.x * SPEED, wantZ = input.dir.y * SPEED;
    const ex = wantX - vel.x, ez = wantZ - vel.y;
    const err = Math.hypot(ex, ez), maxDv = ACCEL * dt;
    if (err <= maxDv) vel.set(wantX, wantZ); else vel.set(vel.x + (ex / err) * maxDv, vel.y + (ez / err) * maxDv);
    const bx = position.x, bz = position.z;
    if (vel.lengthSq() > 1e-8) move(vel.x * dt, vel.y * dt, dt);
    const moved = Math.hypot(position.x - bx, position.z - bz) / dt;
    speedNow += (moved - speedNow) * (1 - Math.exp(-dt * 30));
    if (vel.lengthSq() > 0.09) heading.set(vel.x, 0, vel.y).normalize();
    const sf = Math.min(1, speedNow / SPEED);

    // --- hop cycle: one hop per footfall, finish the hop in the air before resting
    const before = Math.floor(phase + 1e-6);
    if (sf > 0.08) phase += STEP_RATE * Math.max(sf, 0.5) * dt;
    else if (phase - Math.floor(phase) > 1e-3) phase = Math.min(Math.ceil(phase), phase + STEP_RATE * dt);
    if (Math.floor(phase + 1e-6) > before && hopAmp > 0.15) { steps++; audio?.step?.(); }
    hopAmp += (Math.sqrt(sf) - hopAmp) * (1 - Math.exp(-dt * 14));
    const frac = phase - Math.floor(phase);
    const air = Math.sin(Math.PI * frac);
    const land = Math.pow(Math.abs(Math.cos(Math.PI * frac)), 8); // 1 at the footfall, 0 in the air
    const sq = SQUASH * hopAmp * land - 0.02 * hopAmp * air; // squash on landing, slight stretch in the air
    yawG.scale.set(1 + sq * 0.5, 1 - sq, 1);
    root.position.set(position.x, position.y + HOP * hopAmp * air, position.z);

    const stride = Math.sin(Math.PI * phase) * LEG_SWING * hopAmp; // legs meet at each footfall
    swing(limbs[0], stride);
    swing(limbs[1], -stride);
    swing(limbs[2], -stride * 0.8);
    swing(limbs[3], stride * 0.8);

    // --- springs, in small fixed steps so they behave the same at any frame rate
    lightAge += dt;
    if (lightAge > 1.5) { // the look module owns the lights and may be created later, so look again now and then
      lightAge = 0;
      let key = null;
      scene.traverse((o) => { if (o.isDirectionalLight && (!key || o.intensity > key.intensity)) key = o; });
      lightSide = key ? Math.sign(key.position.x - key.target.position.x) : 0;
    }
    if (vel.x > 0.3 * SPEED) facing = 1; else if (vel.x < -0.3 * SPEED) facing = -1;
    // Walking straight up or down the page, either side may show: pick the one that turns towards the key light.
    else if (lightSide && Math.abs(vel.y) > 0.6 * SPEED) facing = (vel.y < 0 ? 1 : -1) * lightSide;
    let yawGoal = facing > 0 ? 0 : Math.PI;
    if (vel.lengthSq() > 0.09) {
      const full = Math.atan2(-vel.y, vel.x * facing); // angle away from the facing side's rest pose
      yawGoal += THREE.MathUtils.clamp(full, -Math.PI / 2, Math.PI / 2) * (MAX_YAW / (Math.PI / 2)) * facing;
    }
    const goalLX = (vel.x / SPEED) * LEAN, goalLZ = (vel.y / SPEED) * LEAN;
    for (let left = dt; left > 1e-6;) {
      const h = Math.min(left, 1 / 240);
      left -= h;
      const d = Math.atan2(Math.sin(yawGoal - yaw), Math.cos(yawGoal - yaw));
      yawVel += (YAW_OMEGA * YAW_OMEGA * d - 2 * YAW_ZETA * YAW_OMEGA * yawVel) * h;
      yaw += yawVel * h;
      leanVX += (LEAN_OMEGA * LEAN_OMEGA * (goalLX - leanX) - 2 * LEAN_ZETA * LEAN_OMEGA * leanVX) * h;
      leanVZ += (LEAN_OMEGA * LEAN_OMEGA * (goalLZ - leanZ) - 2 * LEAN_ZETA * LEAN_OMEGA * leanVZ) * h;
      leanX += leanVX * h;
      leanZ += leanVZ * h;
    }
    yawG.rotation.y = yaw;
    standYaw.rotation.y = yaw;
    lean.rotation.set(leanZ - TILT_BACK, 0, -leanX);

    // --- pencil mark: stays while the walk is on, then fades
    const shown = input.target && !input.held && (input.markerAge ?? Infinity) < 6;
    markerOpacity += ((shown ? 0.7 : 0) - markerOpacity) * (1 - Math.exp(-dt * (shown ? 12 : 4)));
    marker.visible = markerOpacity > 0.01;
    if (shown) marker.position.set(input.markerPos.x, 0.012, input.markerPos.z);
    marker.material.opacity = markerOpacity;
  }

  return { position, heading, update, get speed() { return speedNow; }, get yaw() { return yaw; },
    get steps() { return steps; }, get hop() { return root.position.y - position.y; }, get squash() { return 1 - yawG.scale.y; } };
}
