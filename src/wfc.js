// Wave-function-collapse tile picker for Pop-up Atlas. Pure JS, no dependencies.
//
// createWFC(tilesJson, seed) -> { get(cx, cz) -> { id, rot } }
//
// The world is an infinite grid cut into CHUNK x CHUNK chunks. A chunk's content depends only on
// (seed, chunk coordinate), never on request order:
//   1. Chunk-border sockets come from seeded noise sampled at chunk corners. A river (or path) crosses a
//      chunk side when the two corners of that side have different signs, i.e. rivers and paths are the
//      contour lines of a low-frequency noise field, so they are long connected curves (or closed loops)
//      and every chunk has an even number of crossings. All other border edges are grass.
//   2. Inside the chunk the crossings are joined by seeded meandering routes (rivers first, then paths,
//      which may cross a river only at a bridge). Short path spurs branch off the roads.
//   3. Real WFC (lowest-entropy cell first, weighted choice, constraint propagation, backtracking, restarts
//      with a derived seed) fills every cell, with border and route edges as fixed constraints and tile
//      weights biased by low-frequency biome noise.
// Solved chunks are kept in a bounded LRU cache.

export const CHUNK = 8;
const N = CHUNK;
const NN = N * N;
const OFF = N >> 1; // cell (0,0) sits in the middle of chunk (0,0)
const DX = [0, 1, 0, -1]; // n, e, s, w   (n = -Z, e = +X, s = +Z, w = -X)
const DZ = [-1, 0, 1, 0];
const DIRN = ['n', 'e', 's', 'w'];
const PERP = [10, 5, 10, 5]; // edge mask (bit d = 1 << d) perpendicular to travel direction d
const MAX_CHUNKS = 512;

const C_MEADOW = 0, C_HILL = 1, C_FOREST = 2, C_HOUSE = 3, C_OTHER = 4, C_ROUTE = 5, NCLS = 6;

// Used when tilesJson is null or unusable. Same schema as public/assets/tiles.json.
export const FALLBACK_TILES = {
  cell: 2,
  sockets: ['g', 'p', 'r'],
  tiles: [
    { id: 'meadow', sockets: { n: 'g', e: 'g', s: 'g', w: 'g' }, weight: 10, rotations: [0, 1, 2, 3], blocked: false, obstacles: [] },
    { id: 'hill', sockets: { n: 'g', e: 'g', s: 'g', w: 'g' }, weight: 5, rotations: [0, 1, 2, 3], blocked: false, obstacles: [{ x: 0, z: 0, r: 0.7 }] },
    { id: 'forest', sockets: { n: 'g', e: 'g', s: 'g', w: 'g' }, weight: 6, rotations: [0, 1, 2, 3], blocked: false, obstacles: [{ x: -0.4, z: -0.3, r: 0.3 }, { x: 0.4, z: 0.35, r: 0.3 }] },
    { id: 'house', sockets: { n: 'g', e: 'g', s: 'g', w: 'g' }, weight: 2, rotations: [0, 1, 2, 3], blocked: false, obstacles: [{ x: 0, z: 0, r: 0.6 }] },
    { id: 'path_straight', sockets: { n: 'p', e: 'g', s: 'p', w: 'g' }, weight: 4, rotations: [0, 1], blocked: false, obstacles: [] },
    { id: 'path_corner', sockets: { n: 'p', e: 'p', s: 'g', w: 'g' }, weight: 3, rotations: [0, 1, 2, 3], blocked: false, obstacles: [] },
    { id: 'path_t', sockets: { n: 'g', e: 'p', s: 'p', w: 'p' }, weight: 1, rotations: [0, 1, 2, 3], blocked: false, obstacles: [] },
    { id: 'path_cross', sockets: { n: 'p', e: 'p', s: 'p', w: 'p' }, weight: 0.5, rotations: [0], blocked: false, obstacles: [] },
    { id: 'path_end', sockets: { n: 'p', e: 'g', s: 'g', w: 'g' }, weight: 1, rotations: [0, 1, 2, 3], blocked: false, obstacles: [] },
    { id: 'river_straight', sockets: { n: 'r', e: 'g', s: 'r', w: 'g' }, weight: 3, rotations: [0, 1], blocked: true, obstacles: [] },
    { id: 'river_corner', sockets: { n: 'r', e: 'r', s: 'g', w: 'g' }, weight: 2, rotations: [0, 1, 2, 3], blocked: true, obstacles: [] },
    { id: 'river_end', sockets: { n: 'r', e: 'g', s: 'g', w: 'g' }, weight: 1, rotations: [0, 1, 2, 3], blocked: true, obstacles: [] },
    { id: 'bridge', sockets: { n: 'r', e: 'p', s: 'r', w: 'p' }, weight: 1, rotations: [0, 1], blocked: false, obstacles: [] },
  ],
};

function hash3(seed, a, b, c) {
  let h = (seed ^ Math.imul(a | 0, 0x9e3779b1)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) ^ Math.imul(b | 0, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 13), 0x27d4eb2f) ^ Math.imul(c | 0, 0x165667b1);
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15; h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

function seedToInt(seed) {
  if (typeof seed === 'number' && Number.isFinite(seed)) return hash3(0x51ed270b, Math.floor(seed), Math.floor(seed / 4294967296), 1);
  const s = String(seed ?? 'atlas');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return hash3(h, s.length, 7, 2);
}

function classify(id) {
  const s = String(id).toLowerCase();
  if (/hill|mount|rock|cliff|peak|mound|crag/.test(s)) return C_HILL;
  if (/forest|tree|wood|grove|pine|copse|orchard/.test(s)) return C_FOREST;
  if (/house|cottage|village|mill|church|tower|barn|farm|hut|inn|castle|cabin|shop|chapel/.test(s)) return C_HOUSE;
  if (/meadow|grass|field|plain|flower|blank|page|empty|lawn/.test(s)) return C_MEADOW;
  return C_OTHER;
}

function popcount(v) {
  v -= (v >>> 1) & 0x55555555;
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (Math.imul((v + (v >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24);
}

// Turns a tiles.json object into flat variant tables. Returns null when the object is unusable.
function compile(json) {
  if (!json || !Array.isArray(json.tiles)) return null;
  const names = [];
  const index = new Map();
  const sock = (s) => {
    const k = String(s);
    let i = index.get(k);
    if (i === undefined) { i = names.length; names.push(k); index.set(k, i); }
    return i;
  };
  sock('g'); // grass is always socket 0
  if (Array.isArray(json.sockets)) json.sockets.forEach(sock);

  const vSock = [], vW = [], vCls = [], vBlocked = [], results = [];
  for (const t of json.tiles) {
    if (!t || t.id === undefined || t.id === null || !t.sockets || typeof t.sockets !== 'object') continue;
    const weight = t.weight === undefined || t.weight === null ? 1 : Number(t.weight);
    if (!(weight > 0)) continue;
    const base = DIRN.map((k) => sock(t.sockets[k] ?? 'g'));
    let rots = Array.isArray(t.rotations)
      ? [...new Set(t.rotations.map((r) => ((Math.round(Number(r)) % 4) + 4) % 4).filter((r) => r === r))]
      : [];
    if (!rots.length) rots = [0, 1, 2, 3];
    const allG = base.every((s) => s === 0);
    const cls = allG ? classify(t.id) : C_ROUTE;
    for (const k of rots) {
      // Rotation k moves the socket at n to e, s, w in turn: rotated[d] = base[d - k].
      for (let d = 0; d < 4; d++) vSock.push(base[(d - k + 4) & 3]);
      vW.push(weight / rots.length);
      vCls.push(cls);
      vBlocked.push(t.blocked ? 1 : 0);
      results.push(Object.freeze({ id: t.id, rot: k }));
    }
  }
  const V = results.length;
  if (!V) return null;
  const S = names.length;
  const W = (V + 31) >>> 5;
  const has = new Uint32Array(4 * S * W); // has[(d * S + s) * W + word]: variants with socket s on side d
  const patterns = new Map(); // exact 4-socket pattern -> variant mask
  const code = (a, b, c, d) => ((a * S + b) * S + c) * S + d;
  const nonBlocked = new Uint32Array(W);
  for (let v = 0; v < V; v++) {
    const bit = 1 << (v & 31), word = v >>> 5;
    for (let d = 0; d < 4; d++) has[(d * S + vSock[v * 4 + d]) * W + word] |= bit;
    const c = code(vSock[v * 4], vSock[v * 4 + 1], vSock[v * 4 + 2], vSock[v * 4 + 3]);
    let m = patterns.get(c);
    if (!m) { m = new Uint32Array(W); patterns.set(c, m); }
    m[word] |= bit;
    if (!vBlocked[v]) nonBlocked[word] |= bit;
  }
  const P = index.has('p') ? index.get('p') : -1;
  const R = index.has('r') ? index.get('r') : -1;
  const pat = (a, b, c, d) => patterns.has(code(a, b, c, d));
  const line = (X) => X >= 0 && pat(0, 0, 0, 0)
    && pat(X, 0, X, 0) && pat(0, X, 0, X)
    && pat(X, X, 0, 0) && pat(0, X, X, 0) && pat(0, 0, X, X) && pat(X, 0, 0, X);
  const riverOK = line(R);
  const pathOK = line(P) && pat(P, 0, 0, 0) && pat(0, P, 0, 0) && pat(0, 0, P, 0) && pat(0, 0, 0, P);
  const bridgeOK = riverOK && pathOK && pat(R, P, R, P) && pat(P, R, P, R);
  const tOK = pathOK && pat(0, P, P, P) && pat(P, 0, P, P) && pat(P, P, 0, P) && pat(P, P, P, 0);
  return {
    V, S, W, P, R, has, patterns, nonBlocked, results, riverOK, pathOK, bridgeOK, tOK,
    vSock: Uint8Array.from(vSock), vW: Float64Array.from(vW), vCls: Uint8Array.from(vCls),
  };
}

export function createWFC(tilesJson, seed) {
  let T = null;
  try { T = compile(tilesJson); } catch { T = null; }
  if (!T) T = compile(FALLBACK_TILES);
  const { V, S, W, P, R, has, patterns, nonBlocked, results, vSock, vW, vCls, riverOK, pathOK, bridgeOK, tOK } = T;
  const SEED = seedToInt(seed);
  const SPAWN = OFF * N + OFF;
  // Unplanned river/path pieces compete with terrain tiles, so heavy route weights must not flood the map.
  let terrainW = 0, routeW = 0;
  for (let v = 0; v < V; v++) { if (vCls[v] === C_ROUTE) routeW += vW[v]; else terrainW += vW[v]; }
  const wildScale = routeW > 0 ? Math.min(1, terrainW / routeW) : 1;
  const stat = { chunks: 0, restarts: 0, relaxed: 0, bestEffort: 0 };

  // ---- seeded noise -------------------------------------------------------------------------------------
  function vnoise(salt, x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const fx = x - xi, fy = y - yi;
    const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
    const a = hash3(SEED, xi, yi, salt), b = hash3(SEED, xi + 1, yi, salt);
    const c = hash3(SEED, xi, yi + 1, salt), d = hash3(SEED, xi + 1, yi + 1, salt);
    return ((a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v) / 4294967296;
  }
  const fbm = (salt, x, y) => (vnoise(salt, x, y) * 2 + vnoise(salt + 1, x * 2.03 + 17.3, y * 2.03 - 9.1)) / 3;
  const sstep = (a, b, x) => { const t = x <= a ? 0 : x >= b ? 1 : (x - a) / (b - a); return t * t * (3 - 2 * t); };

  // ---- chunk-border portals -----------------------------------------------------------------------------
  // Corner (i, j) is the north-west corner of chunk (i, j). The four corners of chunk (0,0) are forced so
  // that no river enters the spawn chunk and a path crosses it from north to south.
  const near0 = (i, j) => (i === 0 || i === 1) && (j === 0 || j === 1);
  const cornerR = (i, j) => near0(i, j) || fbm(101, i / 2.9 + 3.7, j / 2.9 - 1.3) > 0.5;
  const cornerP = (i, j) => (near0(i, j) ? i === 1 : fbm(131, i / 2.3 - 5.1, j / 2.3 + 8.9) > 0.5);
  const side = { r: -1, p: -1 };
  // horizontal = 1: north side of chunk (i, j). horizontal = 0: west side of chunk (i, j).
  function readSide(horizontal, i, j) {
    const i2 = horizontal ? i + 1 : i, j2 = horizontal ? j : j + 1;
    side.r = riverOK && cornerR(i, j) !== cornerR(i2, j2) ? 1 + (hash3(SEED, i, j, 201 + horizontal) % (N - 2)) : -1;
    side.p = pathOK && cornerP(i, j) !== cornerP(i2, j2) ? 1 + (hash3(SEED, i, j, 211 + horizontal) % (N - 2)) : -1;
    if (side.p >= 0 && side.p === side.r) side.p = ((side.p - 1 + ((N - 2) >> 1)) % (N - 2)) + 1;
  }

  // ---- scratch state shared by all chunk solves -----------------------------------------------------------
  let rs = 1;
  const rng = () => {
    rs = (rs + 0x6d2b79f5) | 0;
    let t = Math.imul(rs ^ (rs >>> 15), 1 | rs);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const riverM = new Uint8Array(NN), pathM = new Uint8Array(NN), net = new Uint8Array(NN);
  const blk = new Uint8Array(NN), tgt = new Uint8Array(NN), near = new Uint8Array(NN);
  const cost = new Float64Array(NN), rimCell = new Uint8Array(NN);
  const NS = NN * 5;
  const dist = new Float64Array(NS), prev = new Int16Array(NS), closed = new Uint8Array(NS);
  const open = new Int16Array(NS * 4 + 8), buf = new Int16Array(NS);
  const req = new Int8Array(NN * 4);
  const cf = new Float32Array(NN * NCLS);
  const dom = new Uint32Array(NN * W), cnt = new Uint8Array(NN), tie = new Float32Array(NN);
  const snap = new Uint32Array((NN + 1) * NN * W), stCell = new Int16Array(NN + 1), stVar = new Int16Array(NN + 1);
  const queue = new Int16Array(NN), inQ = new Uint8Array(NN);
  const allowed = new Uint32Array(W);
  let qn = 0;
  const pCells = new Int16Array(4), rCells = new Int16Array(4), rInner = new Int16Array(4), rSide = new Uint8Array(4);

  // ---- routing ------------------------------------------------------------------------------------------
  // Dijkstra over (cell, direction of entry). mode 0 = river (blk decides everything), mode 1 = path
  // (may cross a straight river at right angles when a bridge tile exists, may end on a path cell).
  // target >= 0 is one cell; target < 0 means any cell flagged in tgt. Writes the cells to buf.
  function route(mode, start, target) {
    dist.fill(Infinity);
    closed.fill(0);
    let on = 0;
    const s0 = start * 5 + 4;
    dist[s0] = 0; prev[s0] = -1; open[on++] = s0;
    while (on > 0) {
      let bi = 0, bd = dist[open[0]];
      for (let i = 1; i < on; i++) { const di = dist[open[i]]; if (di < bd) { bd = di; bi = i; } }
      const st = open[bi];
      open[bi] = open[--on];
      if (closed[st]) continue;
      closed[st] = 1;
      const c = (st / 5) | 0, din = st - c * 5;
      if (target >= 0 ? c === target : tgt[c] === 1) {
        let len = 0;
        for (let s = st; s >= 0; s = prev[s]) buf[len++] = (s / 5) | 0;
        for (let a = 0, b = len - 1; a < b; a++, b--) { const t = buf[a]; buf[a] = buf[b]; buf[b] = t; }
        return len;
      }
      const cx = c % N, cz = (c / N) | 0;
      const onRiver = mode === 1 && riverM[c] !== 0;
      for (let d = 0; d < 4; d++) {
        if (din < 4 && d === (din ^ 2)) continue;
        if (onRiver && d !== din) continue;
        const nx = cx + DX[d], nz = cz + DZ[d];
        if (nx < 0 || nz < 0 || nx >= N || nz >= N) continue;
        const n = nz * N + nx;
        if (blk[n]) continue;
        let w = cost[n];
        if (mode === 1) {
          if (riverM[n]) {
            if (!bridgeOK || riverM[n] !== PERP[d]) continue;
            w += 4;
          } else if (pathM[n] && n !== target && !(target < 0 && tgt[n])) continue;
        }
        const ns = n * 5 + d, nd = bd + w;
        if (nd < dist[ns]) { dist[ns] = nd; prev[ns] = st; open[on++] = ns; }
      }
    }
    return 0;
  }

  function applyRoute(mask, len, markNet) {
    for (let i = 0; i < len; i++) {
      const a = buf[i];
      if (i + 1 < len) {
        const diff = buf[i + 1] - a;
        const d = diff === 1 ? 1 : diff === -1 ? 3 : diff === N ? 2 : 0;
        mask[a] |= 1 << d;
        mask[buf[i + 1]] |= 1 << (d ^ 2);
      }
      if (markNet && !riverM[a]) net[a] = 1;
    }
  }

  const patternOf = (rm, pm) => {
    let c = 0;
    for (let d = 0; d < 4; d++) c = c * S + ((rm >> d) & 1 ? R : (pm >> d) & 1 ? P : 0);
    return c;
  };

  // level 0: full routes + spurs. level 1: no spurs. level 2: minimal (rivers hug the rim, paths end at once).
  function buildRoutes(ci, cj, level, attempt) {
    pathM.fill(0); net.fill(0);
    let nr = 0, np = 0;
    for (let s = 0; s < 4; s++) {
      if (s === 0) readSide(1, ci, cj); else if (s === 2) readSide(1, ci, cj + 1);
      else if (s === 3) readSide(0, ci, cj); else readSide(0, ci + 1, cj);
      for (let kind = 0; kind < 2; kind++) {
        const pos = kind ? side.p : side.r;
        if (pos < 0) continue;
        const cell = s === 0 ? pos : s === 2 ? (N - 1) * N + pos : s === 3 ? pos * N : pos * N + N - 1;
        if (kind) { pathM[cell] |= 1 << s; pCells[np++] = cell; } else {
          rCells[nr] = cell; rSide[nr] = s; rInner[nr++] = cell + DX[s ^ 2] + DZ[s ^ 2] * N;
        }
      }
    }

    // Rivers: join portals pairwise through the interior. A portal cell is a straight piece that points
    // inward, so the rim holds no other river. The two possible pairings (0,1)(2,3) and (0,3)(1,2) never cross.
    let riversDone = false;
    for (let t = 0; t < (level === 2 ? 2 : 1) && !riversDone; t++) {
      riverM.fill(0);
      for (let k = 0; k < nr; k++) {
        riverM[rCells[k]] |= (1 << rSide[k]) | (1 << (rSide[k] ^ 2));
        riverM[rInner[k]] |= 1 << rSide[k];
      }
      const alt = nr === 4 && ((hash3(SEED, ci, cj, 221) + attempt + t) & 1) === 1;
      riversDone = true;
      for (let pair = 0; pair < nr >> 1 && riversDone; pair++) {
        const a = nr === 2 ? 0 : alt ? pair : pair * 2;
        const b = nr === 2 ? 1 : alt ? 3 - pair : pair * 2 + 1;
        const start = rInner[a], target = rInner[b];
        const shared = start === target;
        // An inner cell that also serves a portal of the other pair cannot be routed.
        if (popcount(riverM[start]) !== (shared ? 2 : 1) || popcount(riverM[target]) !== (shared ? 2 : 1)) { riversDone = false; break; }
        if (shared) continue;
        for (let c = 0; c < NN; c++) {
          const x = c % N, z = (c / N) | 0;
          const rim = x === 0 || z === 0 || x === N - 1 || z === N - 1;
          blk[c] = rim || (riverM[c] !== 0 && c !== start && c !== target) ? 1 : 0;
          const ring = x === 1 || z === 1 || x === N - 2 || z === N - 2;
          cost[c] = level === 2 ? (ring ? 1 : 60) : 1 + 5 * rng();
        }
        const len = route(0, start, target);
        if (!len) { riversDone = false; break; }
        applyRoute(riverM, len, false);
      }
    }
    if (!riversDone) {
      if (level < 2) return false;
      riverM.fill(0); // not reachable with a valid tile set: leave bare stubs on the border
      for (let k = 0; k < nr; k++) riverM[rCells[k]] |= 1 << rSide[k];
    }

    // Paths.
    blk.fill(0);
    if (np >= 2 && level < 2) {
      // Roads keep off the chunk rim, so two chunks do not lay lanes side by side along their shared border.
      for (let c = 0; c < NN; c++) {
        const x = c % N, z = (c / N) | 0;
        rimCell[c] = x === 0 || z === 0 || x === N - 1 || z === N - 1 ? 1 : 0;
        cost[c] = 1 + 3 * rng() + 4 * rimCell[c];
      }
      if (np === 4 && rng() < 0.5) { const t = pCells[1]; pCells[1] = pCells[2]; pCells[2] = t; }
      if (ci === 0 && cj === 0) {
        // The trunk road runs through the spawn cell.
        let len = route(1, pCells[0], SPAWN);
        if (!len) return false;
        applyRoute(pathM, len, true);
        for (let i = 0; i < len - 1; i++) blk[buf[i]] = 1;
        len = route(1, SPAWN, pCells[1]);
        blk.fill(0);
        if (!len) return false;
        applyRoute(pathM, len, true);
      } else {
        const len = route(1, pCells[0], pCells[1]);
        if (!len) return false;
        applyRoute(pathM, len, true);
      }
      if (np === 4) {
        if (tOK) { // the other two roads join the trunk at a junction
          for (let k = 2; k < 4; k++) {
            tgt.set(net);
            const len = route(1, pCells[k], -1);
            if (!len) return false;
            applyRoute(pathM, len, true);
          }
        } else {
          const len = route(1, pCells[2], pCells[3]);
          if (!len) return false;
          applyRoute(pathM, len, true);
        }
      }
      // Spurs: short lanes from a free cell to the nearest road.
      if (level === 0 && tOK) {
        const u = rng();
        const spurs = u < 0.45 ? 1 : u < 0.6 ? 2 : 0;
        for (let k = 0; k < spurs; k++) {
          for (let tries = 0; tries < 5; tries++) {
            const start = (rng() * NN) | 0;
            if (riverM[start] || pathM[start] || rimCell[start]) continue;
            for (let c = 0; c < NN; c++) cost[c] = 1 + 2 * rng() + 4 * rimCell[c];
            tgt.set(net);
            const len = route(1, start, -1);
            if (len < 3 || len > 6) continue;
            const j = buf[len - 1], diff = j - buf[len - 2];
            const d = diff === 1 ? 1 : diff === -1 ? 3 : diff === N ? 2 : 0;
            if (!patterns.has(patternOf(0, pathM[j] | (1 << (d ^ 2))))) continue;
            applyRoute(pathM, len, true);
            break;
          }
        }
      }
    }

    // Every route cell needs a tile with exactly its sockets (grass on its other sides).
    if (level < 2) {
      for (let c = 0; c < NN; c++) {
        if ((riverM[c] | pathM[c]) && !patterns.has(patternOf(riverM[c], pathM[c]))) return false;
      }
    }
    return true;
  }

  // ---- WFC ----------------------------------------------------------------------------------------------
  function setCount(c) {
    let n = 0;
    for (let w = 0; w < W; w++) n += popcount(dom[c * W + w]);
    cnt[c] = n;
    return n;
  }

  function propagate() {
    while (qn > 0) {
      const c = queue[--qn];
      inQ[c] = 0;
      const cx = c % N, cz = (c / N) | 0;
      for (let d = 0; d < 4; d++) {
        const nx = cx + DX[d], nz = cz + DZ[d];
        if (nx < 0 || nz < 0 || nx >= N || nz >= N) continue;
        const n = nz * N + nx, od = d ^ 2;
        for (let w = 0; w < W; w++) allowed[w] = 0;
        for (let s = 0; s < S; s++) {
          const hb = (d * S + s) * W;
          let any = 0;
          for (let w = 0; w < W; w++) any |= dom[c * W + w] & has[hb + w];
          if (any) { const ob = (od * S + s) * W; for (let w = 0; w < W; w++) allowed[w] |= has[ob + w]; }
        }
        let changed = 0;
        for (let w = 0; w < W; w++) {
          const before = dom[n * W + w], after = (before & allowed[w]) >>> 0;
          if (after !== before) { dom[n * W + w] = after; changed = 1; }
        }
        if (changed) {
          if (setCount(n) === 0) {
            while (qn > 0) inQ[queue[--qn]] = 0;
            return false;
          }
          if (!inQ[n]) { inQ[n] = 1; queue[qn++] = n; }
        }
      }
    }
    return true;
  }

  // Weight of variant v in cell c: tile weight x biome factor x penalty for river/path on an unplanned edge.
  function weightOf(c, v) {
    const cls = vCls[v];
    let w = vW[v] * cf[c * NCLS + cls];
    if (cls === C_HOUSE) w *= near[c] ? 7 : 0.2;
    else if (cls === C_ROUTE) {
      let wild = 1;
      for (let d = 0; d < 4; d++) {
        if (req[c * 4 + d] < 0) { const s = vSock[v * 4 + d]; if (s !== 0) wild *= s === R ? 0.05 : 0.006; }
      }
      if (wild < 1) w *= wild * wildScale;
    }
    return w;
  }

  function pickVariant(c) {
    let total = 0;
    for (let w = 0; w < W; w++) {
      let m = dom[c * W + w];
      while (m) { const b = 31 - Math.clz32(m & -m); m &= m - 1; total += weightOf(c, w * 32 + b); }
    }
    let r = rng() * total, last = -1;
    for (let w = 0; w < W; w++) {
      let m = dom[c * W + w];
      while (m) {
        const b = 31 - Math.clz32(m & -m); m &= m - 1;
        last = w * 32 + b;
        r -= weightOf(c, last);
        if (r <= 0) return last;
      }
    }
    return last;
  }

  function initDomains(spawnChunk, hard) {
    for (let c = 0; c < NN; c++) {
      const x = c % N, z = (c / N) | 0;
      const spawn = spawnChunk && Math.abs(x - OFF) <= 1 && Math.abs(z - OFF) <= 1;
      let exact = null;
      if (hard) {
        let code = 0;
        for (let d = 0; d < 4; d++) code = code * S + (req[c * 4 + d] < 0 ? 0 : req[c * 4 + d]);
        exact = patterns.get(code);
        if (!exact) return false;
      }
      let any = 0, anyFree = 0;
      for (let w = 0; w < W; w++) {
        let m = exact ? exact[w] : 0xffffffff;
        if (!exact) {
          if (w === W - 1 && (V & 31)) m = (1 << (V & 31)) - 1;
          for (let d = 0; d < 4; d++) { const r = req[c * 4 + d]; if (r >= 0) m &= has[(d * S + r) * W + w]; }
        }
        dom[c * W + w] = m;
        any |= m; anyFree |= m & nonBlocked[w];
      }
      if (!any) return false;
      if (spawn && anyFree) for (let w = 0; w < W; w++) dom[c * W + w] &= nonBlocked[w];
      setCount(c);
      tie[c] = rng();
    }
    return true;
  }

  function runWFC(spawnChunk, hard, out) {
    if (!initDomains(spawnChunk, hard)) return false;
    qn = 0;
    for (let c = 0; c < NN; c++) { inQ[c] = 1; queue[qn++] = c; }
    if (!propagate()) return false;
    let depth = 0, backtracks = 0;
    for (;;) {
      let best = -1, bestScore = Infinity;
      for (let c = 0; c < NN; c++) {
        if (cnt[c] > 1) { const sc = cnt[c] + tie[c]; if (sc < bestScore) { bestScore = sc; best = c; } }
      }
      if (best < 0) break;
      const v = pickVariant(best);
      snap.set(dom, depth * NN * W);
      stCell[depth] = best; stVar[depth] = v; depth++;
      for (let w = 0; w < W; w++) dom[best * W + w] = 0;
      dom[best * W + (v >>> 5)] = (1 << (v & 31)) >>> 0;
      cnt[best] = 1;
      inQ[best] = 1; queue[qn++] = best;
      while (!propagate()) {
        if (++backtracks > 48) return false;
        let recovered = false;
        while (depth > 0) {
          depth--;
          dom.set(snap.subarray(depth * NN * W, (depth + 1) * NN * W));
          const c = stCell[depth], bad = stVar[depth];
          dom[c * W + (bad >>> 5)] &= ~(1 << (bad & 31));
          for (let k = 0; k < NN; k++) setCount(k);
          if (cnt[c] === 0) continue;
          inQ[c] = 1; queue[qn++] = c;
          recovered = true;
          break;
        }
        if (!recovered) return false;
      }
    }
    for (let c = 0; c < NN; c++) {
      let v = 0;
      for (let w = 0; w < W; w++) if (dom[c * W + w]) { v = w * 32 + 31 - Math.clz32(dom[c * W + w]); break; }
      out[c] = v;
    }
    return true;
  }

  // Last resort, cannot fail: each cell takes the heaviest variant that matches the most fixed edges.
  function bestEffort(out) {
    for (let c = 0; c < NN; c++) {
      let best = 0, bestScore = -1;
      for (let v = 0; v < V; v++) {
        let sc = 0;
        for (let d = 0; d < 4; d++) { const r = req[c * 4 + d] < 0 ? 0 : req[c * 4 + d]; if (vSock[v * 4 + d] === r) sc += 1000; }
        sc += Math.min(999, vW[v]);
        if (sc > bestScore) { bestScore = sc; best = v; }
      }
      out[c] = best;
    }
  }

  function solveChunk(ci, cj) {
    const out = V > 255 ? new Uint16Array(NN) : new Uint8Array(NN);
    const spawnChunk = ci === 0 && cj === 0;
    // Biome factors per cell and tile class, from noise on global cell coordinates.
    for (let c = 0; c < NN; c++) {
      const x = ci * N - OFF + (c % N), z = cj * N - OFF + ((c / N) | 0);
      const aH = sstep(0.5, 0.58, fbm(301, x / 12.7, z / 12.7));
      const aF = sstep(0.47, 0.55, fbm(311, x / 10.3, z / 10.3)) * (1 - aH);
      const aM = 1 - aH - aF;
      const o = c * NCLS;
      cf[o + C_MEADOW] = 0.25 + 0.75 * aM;
      cf[o + C_HILL] = 0.12 + 2.0 * aH + 0.25 * aF;
      cf[o + C_FOREST] = 0.12 + 2.0 * aF + 0.3 * aH;
      cf[o + C_HOUSE] = 0.1 + sstep(0.38, 0.62, fbm(321, x / 7.1, z / 7.1));
      cf[o + C_OTHER] = 0.5;
      cf[o + C_ROUTE] = 1;
    }
    stat.chunks++;
    for (let attempt = 0; attempt < 8; attempt++) {
      if (attempt > 0) stat.restarts++;
      if (attempt === 6) stat.relaxed++;
      const level = attempt < 4 ? 0 : attempt < 6 ? 1 : 2;
      rs = hash3(SEED, ci, cj, 401 + attempt) | 0;
      if (!buildRoutes(ci, cj, level, attempt)) continue;
      for (let c = 0; c < NN; c++) {
        const x = c % N, z = (c / N) | 0;
        let np = 0;
        for (let d = 0; d < 4; d++) {
          const bit = 1 << d, nx = x + DX[d], nz = z + DZ[d];
          const inside = nx >= 0 && nz >= 0 && nx < N && nz < N;
          req[c * 4 + d] = riverM[c] & bit ? R : pathM[c] & bit ? P : inside ? -1 : 0;
          if (inside && pathM[nz * N + nx]) np = 1;
        }
        near[c] = np && !riverM[c] && !pathM[c] ? 1 : 0;
      }
      // The minimal level also bans unplanned river/path edges, so its cells are independent and it cannot
      // fail when the route patterns exist.
      if (runWFC(spawnChunk, level === 2, out)) return out;
    }
    stat.bestEffort++;
    bestEffort(out);
    return out;
  }

  // ---- chunk cache (LRU: Map keeps insertion order) -----------------------------------------------------
  const cache = new Map();
  let lastI = NaN, lastJ = NaN, lastChunk = null;
  function getChunk(ci, cj) {
    const small = ci > -33554432 && ci < 33554432 && cj > -33554432 && cj < 33554432;
    const key = small ? (ci + 33554432) * 67108864 + (cj + 33554432) : ci + ',' + cj;
    let ch = cache.get(key);
    if (ch) {
      cache.delete(key);
    } else {
      try { ch = solveChunk(ci, cj); } catch { ch = new Uint8Array(NN); }
      if (cache.size >= MAX_CHUNKS) cache.delete(cache.keys().next().value);
    }
    cache.set(key, ch);
    lastI = ci; lastJ = cj; lastChunk = ch;
    return ch;
  }

  function get(cx, cz) {
    let x = Math.floor(cx), z = Math.floor(cz);
    if (!Number.isFinite(x)) x = 0;
    if (!Number.isFinite(z)) z = 0;
    const ci = Math.floor((x + OFF) / N), cj = Math.floor((z + OFF) / N);
    const ch = ci === lastI && cj === lastJ ? lastChunk : getChunk(ci, cj);
    return results[ch[(z + OFF - cj * N) * N + (x + OFF - ci * N)]] || results[0];
  }

  // Solve the 3 x 3 chunks around spawn up front: they are on screen at once, and this warms the JIT.
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) get(i * N, j * N);
  // stats() is a debug extra for tools/wfc_test.mjs; the contract is get() only.
  return { get, stats: () => ({ ...stat, cached: cache.size }) };
}
