// Input: WASD / arrows (screen-aligned), click/tap-to-walk on the page plane, and an unattended auto-wander mode.
// Contract: createInput(dom, camera) -> { dir: Vector2 (world xz, len <= 1), update(dt, travellerPos), setAuto(bool) }.
// Extras read by traveller.js / tools: target, markerPos, markerAge, walkable (set by the traveller), camera.
import * as THREE from 'three';

const ARRIVE_RADIUS = 0.03; // click target counts as reached (spec: stop within 0.08)
const SLOW_RADIUS = 0.2; // start easing off inside this distance so the stop does not overshoot
const KEYMAP = {
  KeyW: [0, -1], ArrowUp: [0, -1], KeyS: [0, 1], ArrowDown: [0, 1],
  KeyA: [-1, 0], ArrowLeft: [-1, 0], KeyD: [1, 0], ArrowRight: [1, 0],
};

export function createInput(dom, camera) {
  const dir = new THREE.Vector2();
  const keys = new Set();
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const hit = new THREE.Vector3();
  const page = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const markerPos = new THREE.Vector3();
  const targetVec = new THREE.Vector3();
  let pointerDown = false;
  let pointerId = -1;
  let stuckTime = 0;
  let lastDist = Infinity;

  const api = {
    dir, camera, markerPos,
    target: null, // Vector3 on the page while a click-walk is active
    markerAge: Infinity, // seconds since the pencil mark was placed
    held: false, // pointer is down, the target follows it
    onPath: null, // (x, z) => bool, installed by the traveller: is this spot on a printed path
    walkable: null, // (x, z) => bool, installed by the traveller
    auto: false,
    setAuto(v) { api.auto = !!v; auto.fresh = true; },
    planMs: 0, // duration of the last auto-route search, for perf checks
    update,
  };

  function pick() {
    camera.updateMatrixWorld();
    raycaster.setFromCamera(ndc, camera);
    if (!raycaster.ray.intersectPlane(page, hit)) return false;
    targetVec.copy(hit);
    api.target = targetVec;
    return true;
  }
  function setNdc(e) {
    const r = dom.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }
  function placeMarker() {
    markerPos.copy(targetVec);
    api.markerAge = 0;
  }
  function clearTarget() {
    api.target = null;
    stuckTime = 0;
    lastDist = Infinity;
  }

  dom.style.touchAction = 'none';
  dom.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button > 0) return;
    pointerDown = true;
    pointerId = e.pointerId;
    try { dom.setPointerCapture(e.pointerId); } catch { /* synthetic events have no capture */ }
    setNdc(e);
    stuckTime = 0;
    lastDist = Infinity;
    if (pick()) placeMarker();
  });
  dom.addEventListener('pointermove', (e) => {
    if (pointerDown && e.pointerId === pointerId) setNdc(e);
  });
  const release = (e) => {
    if (!pointerDown || e.pointerId !== pointerId) return;
    pointerDown = false;
    if (api.target) placeMarker();
  };
  dom.addEventListener('pointerup', release);
  dom.addEventListener('pointercancel', release);
  dom.addEventListener('contextmenu', (e) => e.preventDefault());

  addEventListener('keydown', (e) => {
    if (!(e.code in KEYMAP) || e.metaKey || e.ctrlKey || e.altKey) return;
    e.preventDefault();
    keys.add(e.code);
    clearTarget();
    pointerDown = false;
  });
  addEventListener('keyup', (e) => keys.delete(e.code));
  addEventListener('blur', () => { keys.clear(); pointerDown = false; });

  // ---- auto wander -------------------------------------------------------------------------------------------
  // A goal point swings ahead of the traveller (the meander). Every half second a Dijkstra search over a 0.5-unit
  // grid finds the reachable node nearest that goal, so rivers are crossed at bridges and nothing traps the route.
  const STEP = 0.5, HALF = 24, SIZE = HALF * 2 + 1; // search window: 24 x 24 units around the traveller
  const dist = new Float32Array(SIZE * SIZE), parent = new Int32Array(SIZE * SIZE), crowd = new Int8Array(SIZE * SIZE);
  const heap = [];
  const cache = new Map(); // walkability on a 0.25 grid: grid nodes and the midpoints between them
  const pathCache = new Map(); // printed-path flag per grid node
  const CRUISE_TURN = (35 * Math.PI) / 180; // heading change rate with nothing in the way, rad/s
  const AVOID_TURN = 3.5; // heading change rate when an obstacle is right ahead, rad/s
  const NBX = [1, -1, 0, 0, 1, 1, -1, -1], NBZ = [0, 0, 1, -1, 1, -1, 1, -1];
  const QSIZE = SIZE * 2 + 4, local = new Int8Array(QSIZE * QSIZE);
  const auto = {
    t: 0, angle: 0, base: 0, path: [], index: 0, planT: 1,
    explore: 0, exploreLeft: 0, exploreLen: 0, flips: 0, best: 0, bestT: 0, bx: 0, bz: 0,
    probeT: 0, probeX: 0, probeZ: 0, panic: 0, omega: 0, fresh: true, lastX: 0, lastZ: 0,
  };

  function free(qx, qz) { // quarter-unit grid indices
    const w = api.walkable;
    if (!w) return true;
    const key = ((qx & 0xffff) * 0x10000) + (qz & 0xffff);
    let v = cache.get(key);
    if (v === undefined) {
      if (cache.size > 60000) cache.clear();
      v = w(qx * 0.25, qz * 0.25);
      cache.set(key, v);
    }
    return v;
  }

  function onPath(qx, qz) {
    const f = api.onPath;
    if (!f) return false;
    const key = ((qx & 0xffff) * 0x10000) + (qz & 0xffff);
    let v = pathCache.get(key);
    if (v === undefined) {
      if (pathCache.size > 60000) pathCache.clear();
      v = f(qx * 0.25, qz * 0.25);
      if (v !== null) pathCache.set(key, v); // null: the tile table is not loaded yet, ask again later
    }
    return v === true;
  }

  function sight(ax, az, bx, bz) {
    const w = api.walkable;
    if (!w) return true;
    const dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz);
    if (len < 1e-6) return true;
    const nx = (-dz / len) * 0.12, nz = (dx / len) * 0.12;
    for (let d = 0.15; d < len; d += 0.15) {
      const x = ax + (dx / len) * d, z = az + (dz / len) * d;
      if (!w(x, z) || !w(x + nx, z + nz) || !w(x - nx, z - nz)) return false;
    }
    return true;
  }

  function plan(p, gx, gz) {
    const ox = Math.round(p.x / STEP) - HALF, oz = Math.round(p.z / STEP) - HALF;
    // Window-local copy of the map on the quarter grid, filled on first touch: (2, 2) is node (0, 0).
    local.fill(-1);
    const at = (qx, qz) => {
      const k = (qz + 2) * QSIZE + qx + 2;
      if (local[k] < 0) local[k] = free(ox * 2 + qx, oz * 2 + qz) ? 1 : 0;
      return local[k] === 1;
    };
    const ok = (ix, iz) => at(ix * 2, iz * 2);
    // Start from the free node nearest the traveller.
    let start = -1, startD = Infinity;
    for (let iz = HALF - 1; iz <= HALF + 1; iz++) {
      for (let ix = HALF - 1; ix <= HALF + 1; ix++) {
        const d = Math.hypot((ox + ix) * STEP - p.x, (oz + iz) * STEP - p.z);
        if (d < startD && ok(ix, iz)) { startD = d; start = iz * SIZE + ix; }
      }
    }
    auto.path = [];
    auto.index = 0;
    if (start < 0) return;
    dist.fill(Infinity);
    crowd.fill(-1);
    dist[start] = 0;
    parent[start] = -1;
    heap.length = 0;
    heap.push(start);
    let best = start, bestScore = -Infinity;
    while (heap.length) {
      // pop the nearest node (binary heap keyed by dist)
      const node = heap[0], last = heap.pop();
      if (heap.length) {
        let i = 0;
        for (;;) {
          let c = i * 2 + 1;
          if (c >= heap.length) break;
          if (c + 1 < heap.length && dist[heap[c + 1]] < dist[heap[c]]) c++;
          if (dist[heap[c]] >= dist[last]) break;
          heap[i] = heap[c];
          i = c;
        }
        heap[i] = last;
      }
      const ix = node % SIZE, iz = (node - ix) / SIZE, d0 = dist[node];
      const score = -Math.hypot((ox + ix) * STEP - gx, (oz + iz) * STEP - gz) - 0.1 * d0;
      if (score > bestScore) { bestScore = score; best = node; }
      for (let n = 0; n < 8; n++) {
        const dx = NBX[n], dz = NBZ[n], len = n < 4 ? 1 : Math.SQRT2;
        const jx = ix + dx, jz = iz + dz;
        if (jx < 0 || jz < 0 || jx >= SIZE || jz >= SIZE || !ok(jx, jz)) continue;
        if (!at(ix * 2 + dx, iz * 2 + dz)) continue; // midpoint
        if (dx && dz && (!ok(jx, iz) || !ok(ix, jz))) continue; // no cutting corners
        const next = jz * SIZE + jx;
        if (crowd[next] < 0) {
          crowd[next] = (ok(jx + 1, jz) ? 0 : 1) + (ok(jx - 1, jz) ? 0 : 1) + (ok(jx, jz + 1) ? 0 : 1) + (ok(jx, jz - 1) ? 0 : 1);
        }
        // Prefer open ground to squeezing past things, and printed paths (bridges are paths) to open ground.
        const nd = d0 + len * STEP * (1 + 0.8 * crowd[next]) * (onPath((ox + jx) * 2, (oz + jz) * 2) ? 0.45 : 1);
        if (nd < dist[next]) {
          dist[next] = nd;
          parent[next] = node;
          let i = heap.push(next) - 1;
          while (i > 0) {
            const up = (i - 1) >> 1;
            if (dist[heap[up]] <= nd) break;
            heap[i] = heap[up];
            i = up;
          }
          heap[i] = next;
        }
      }
    }
    for (let n = best; n >= 0 && n !== start; n = parent[n]) {
      const ix = n % SIZE;
      auto.path.push([(ox + ix) * STEP, (oz + (n - ix) / SIZE) * STEP]);
    }
    auto.path.reverse();
  }

  function updateAuto(dt, p) {
    const a = auto;
    a.t += dt;
    // Start of a run, or the traveller was moved by hand: forget the route, the progress marks and the map cache.
    if (a.fresh || Math.hypot(p.x - a.lastX, p.z - a.lastZ) > 2) {
      a.fresh = false; a.path = []; a.index = 0; a.planT = 1; a.explore = 0; a.best = 0; a.bestT = a.t;
      a.bx = p.x; a.bz = p.z; a.probeT = 0; a.probeX = p.x; a.probeZ = p.z; a.panic = 0;
      a.omega = 0;
      cache.clear();
      pathCache.clear();
    }
    a.lastX = p.x; a.lastZ = p.z;
    const fx = Math.sin(a.base), fz = -Math.cos(a.base); // angle 0 = -Z (away from the camera), positive towards +X

    // No forward progress for a while: a river is in the way. Walk along it until a crossing comes into the window.
    const forward = (p.x - a.bx) * fx + (p.z - a.bz) * fz;
    if (forward > a.best + 2) { a.best = forward; a.bestT = a.t; a.explore = 0; }
    if (!a.explore && a.t - a.bestT > 8) {
      a.explore = Math.sin(a.t * 7.3) > 0 ? 1 : -1; a.exploreLen = 20; a.exploreLeft = 20; a.flips = 0;
    }
    if (a.explore) {
      a.exploreLeft -= dt;
      if (a.exploreLeft <= 0) {
        a.flips++;
        if (a.flips >= 2) { // nothing either way: call another direction forward
          a.base += a.explore * Math.PI / 2; a.explore = 0; a.best = 0; a.bestT = a.t; a.bx = p.x; a.bz = p.z;
        } else { a.explore = -a.explore; a.exploreLen *= 2; a.exploreLeft = a.exploreLen; }
      }
    }

    a.planT += dt;
    if (a.planT >= 0.5 || a.index >= a.path.length - 2) {
      a.planT = 0;
      // Meander: two slow incommensurate sines, mostly forward; the goal swings at 13 degrees per second at most.
      const m = 0.6 * Math.sin(a.t * 0.17 + 0.4) + 0.3 * Math.sin(a.t * 0.41 + 1.9);
      const want = a.base + (a.explore ? a.explore * 1.25 + 0.3 * m : m);
      const t0 = performance.now();
      plan(p, p.x + Math.sin(want) * 9, p.z - Math.cos(want) * 9);
      api.planMs = performance.now() - t0;
    }

    // Follow the path: aim at the farthest of the next few points that is in plain sight.
    while (a.index < a.path.length && Math.hypot(a.path[a.index][0] - p.x, a.path[a.index][1] - p.z) < 0.3) a.index++;
    let aim = null;
    for (let j = Math.min(a.path.length - 1, a.index + 12); j >= a.index; j--) {
      if (j === a.index || sight(p.x, p.z, a.path[j][0], a.path[j][1])) { aim = a.path[j]; break; }
    }

    // Last resort: no movement for a second -> turn hard and commit briefly.
    a.probeT += dt;
    if (a.probeT >= 1) {
      if (Math.hypot(p.x - a.probeX, p.z - a.probeZ) < 0.3) {
        a.panic = 0.8;
        a.angle += (Math.sin(a.t * 3.1) > 0 ? 1 : -1) * (1.6 + Math.abs(Math.sin(a.t * 5.7)));
      }
      a.probeT = 0; a.probeX = p.x; a.probeZ = p.z;
    }
    if (a.panic > 0) a.panic -= dt;
    else if (aim) {
      let diff = Math.atan2(aim[0] - p.x, -(aim[1] - p.z)) - a.angle;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      // Turn slowly while the way ahead is clear, faster the nearer an obstacle is, so the camera pans gently.
      const sx = Math.sin(a.angle), sz = -Math.cos(a.angle), w = api.walkable;
      let clear = 2.2;
      for (let d = 0.2; w && d <= 2.2; d += 0.2) {
        const x = p.x + sx * d, z = p.z + sz * d;
        if (!w(x, z) || !w(x - sz * 0.14, z + sx * 0.14) || !w(x + sz * 0.14, z - sx * 0.14)) { clear = d - 0.2; break; }
      }
      const urgency = Math.min(1, Math.max(0, (2.2 - clear) / 1.4));
      let limit = CRUISE_TURN + (AVOID_TURN - CRUISE_TURN) * urgency;
      if (Math.abs(diff) > 1.3) limit = Math.max(limit, 1.6); // the route doubles back
      const wantOmega = Math.max(-limit, Math.min(limit, diff * 3));
      a.omega += Math.max(-10 * dt, Math.min(10 * dt, wantOmega - a.omega));
      a.angle += a.omega * dt;
    }
    dir.set(Math.sin(a.angle), -Math.cos(a.angle));
  }

  function update(dt, p) {
    if (api.markerAge < 100) api.markerAge += dt;

    let kx = 0, kz = 0;
    for (const code of keys) { kx += KEYMAP[code][0]; kz += KEYMAP[code][1]; }
    if (kx || kz) {
      dir.set(kx, kz).normalize();
      return;
    }

    api.held = pointerDown;
    if (pointerDown) pick(); // the camera moves, so the point under a held pointer moves too
    if (api.target) {
      const dx = api.target.x - p.x, dz = api.target.z - p.z;
      const dist = Math.hypot(dx, dz);
      // Give up on a target the traveller cannot make progress towards (blocked cell).
      if (dist < lastDist - 0.02) { lastDist = dist; stuckTime = 0; } else stuckTime += dt;
      if (dist <= ARRIVE_RADIUS || (stuckTime > 0.6 && !pointerDown)) {
        if (!pointerDown) clearTarget();
        dir.set(0, 0);
        return;
      }
      const k = Math.min(1, 0.85 * Math.sqrt(dist / SLOW_RADIUS));
      dir.set((dx / dist) * k, (dz / dist) * k);
      return;
    }

    if (api.auto) { updateAuto(dt, p); return; }
    dir.set(0, 0);
  }

  return api;
}
