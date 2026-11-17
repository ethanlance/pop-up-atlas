// WFC acceptance test: node tools/wfc_test.mjs [--map-seed N]
// Checks socket matching, order independence, determinism, tile mix, spawn rules and timing, then prints
// an ASCII map. Runs on the built-in fallback tiles and, when present, on public/assets/tiles.json.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createWFC, FALLBACK_TILES, CHUNK } from '../src/wfc.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tilesPath = join(root, 'public/assets/tiles.json');
const SEEDS = [1, 7, 42, 1234, 987654];
const HALF = 102; // region is [-HALF, HALF)^2 = 204 x 204 = 41,616 cells per seed
const DIRS = ['n', 'e', 's', 'w'];
const argSeed = process.argv.indexOf('--map-seed');
const MAP_SEED = argSeed > 0 ? Number(process.argv[argSeed + 1]) : 7;

let failures = 0;
const check = (ok, msg) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failures++; };

// Independent reading of the contract: rotation k moves the socket at n to e, s, w in turn.
function socketsOf(tileById, t) {
  const base = tileById.get(t.id).sockets;
  const out = {};
  for (let d = 0; d < 4; d++) out[DIRS[d]] = base[DIRS[(d - t.rot + 4) % 4]] ?? 'g';
  return out;
}

function glyph(tileById, t) {
  const s = socketsOf(tileById, t);
  let p = 0, r = 0;
  for (let d = 0; d < 4; d++) { if (s[DIRS[d]] === 'p') p |= 1 << d; if (s[DIRS[d]] === 'r') r |= 1 << d; }
  if (p && r) return r === 5 ? '╫' : r === 10 ? '╪' : '#';
  if (p) return ' ╵╶└╷│┌├╴┘─┴┐┤┬┼'[p];
  if (r) return ' ~~╚~║╔╠~╝═╩╗╣╦╬'[r];
  const id = String(t.id).toLowerCase();
  if (/hill|mount|rock|cliff|peak|mound|crag/.test(id)) return '^';
  if (/forest|tree|wood|grove|pine|copse|orchard/.test(id)) return '♣';
  if (/house|cottage|village|mill|church|tower|barn|farm|hut|inn|castle|cabin|shop|chapel/.test(id)) return '⌂';
  if (/meadow|grass|field|plain|flower|blank|page|empty|lawn/.test(id)) return '·';
  return id[0] || '?';
}

function mapDump(tileById, wfc, x0, z0, w, h) {
  const lines = [];
  for (let z = z0; z < z0 + h; z++) {
    let line = '';
    for (let x = x0; x < x0 + w; x++) line += glyph(tileById, wfc.get(x, z));
    lines.push('  ' + line);
  }
  return lines.join('\n');
}

// Sizes of connected components of cells joined by `sock` sockets.
function components(tileById, grid, size, sock) {
  const seen = new Uint8Array(size * size);
  const sizes = [];
  const DXs = [0, 1, 0, -1], DZs = [-1, 0, 1, 0];
  for (let i = 0; i < size * size; i++) {
    if (seen[i]) continue;
    const s0 = socketsOf(tileById, grid[i]);
    if (!DIRS.some((d) => s0[d] === sock)) continue;
    let n = 0;
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const c = stack.pop();
      n++;
      const s = socketsOf(tileById, grid[c]);
      const x = c % size, z = (c / size) | 0;
      for (let d = 0; d < 4; d++) {
        if (s[DIRS[d]] !== sock) continue;
        const nx = x + DXs[d], nz = z + DZs[d];
        if (nx < 0 || nz < 0 || nx >= size || nz >= size) continue;
        const k = nz * size + nx;
        if (!seen[k]) { seen[k] = 1; stack.push(k); }
      }
    }
    sizes.push(n);
  }
  return sizes.sort((a, b) => b - a);
}

function shuffled(n, seed) {
  const a = Array.from({ length: n }, (_, i) => i);
  let s = seed >>> 0;
  for (let i = n - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function suite(name, tilesJson) {
  console.log(`\n=== ${name} ===`);
  const tiles = (tilesJson || FALLBACK_TILES).tiles;
  const tileById = new Map(tiles.map((t) => [t.id, t]));
  const size = HALF * 2;
  let totalCells = 0, totalMismatch = 0, totalUnknown = 0, threw = 0;
  const histAll = new Map();
  const solveTimes = [];
  let getTotalMs = 0, getCalls = 0;
  const stats = { chunks: 0, restarts: 0, relaxed: 0, bestEffort: 0 };

  for (const seed of SEEDS) {
    const wfc = createWFC(tilesJson, seed);
    const grid = new Array(size * size);
    // First pass, chunk by chunk, timing the first touch of each chunk (= one chunk solve).
    const t0 = performance.now();
    try {
      for (let cj = Math.floor((-HALF + CHUNK / 2) / CHUNK); cj * CHUNK - CHUNK / 2 < HALF; cj++) {
        for (let ci = Math.floor((-HALF + CHUNK / 2) / CHUNK); ci * CHUNK - CHUNK / 2 < HALF; ci++) {
          const a = performance.now();
          wfc.get(ci * CHUNK, cj * CHUNK);
          solveTimes.push(performance.now() - a);
        }
      }
      for (let z = -HALF; z < HALF; z++) for (let x = -HALF; x < HALF; x++) grid[(z + HALF) * size + x + HALF] = wfc.get(x, z);
    } catch (e) { threw++; console.log('  threw:', e); continue; }
    getTotalMs += performance.now() - t0;
    getCalls += size * size;

    const hist = new Map();
    let mismatch = 0;
    for (let z = 0; z < size; z++) {
      for (let x = 0; x < size; x++) {
        const t = grid[z * size + x];
        if (!t || !tileById.has(t.id) || !(t.rot >= 0 && t.rot <= 3)) { totalUnknown++; continue; }
        const rots = tileById.get(t.id).rotations;
        if (Array.isArray(rots) && rots.length && !rots.includes(t.rot)) totalUnknown++;
        hist.set(t.id, (hist.get(t.id) || 0) + 1);
        const s = socketsOf(tileById, t);
        if (x + 1 < size && s.e !== socketsOf(tileById, grid[z * size + x + 1]).w) mismatch++;
        if (z + 1 < size && s.s !== socketsOf(tileById, grid[(z + 1) * size + x]).n) mismatch++;
      }
    }
    totalCells += size * size;
    totalMismatch += mismatch;
    for (const [k, v] of hist) histAll.set(k, (histAll.get(k) || 0) + v);
    const top = [...hist].sort((a, b) => b[1] - a[1])[0];
    const st = wfc.stats();
    for (const k of Object.keys(stats)) stats[k] += st[k];

    const rc = components(tileById, grid, size, 'r');
    const pc = components(tileById, grid, size, 'p');
    const share = (c, min) => { const tot = c.reduce((a, b) => a + b, 0); return tot ? (100 * c.filter((n) => n >= min).reduce((a, b) => a + b, 0) / tot).toFixed(0) : '-'; };
    console.log(`  seed ${String(seed).padEnd(7)} cells ${size * size}  mismatches ${mismatch}  top tile ${top[0]} ${(100 * top[1] / (size * size)).toFixed(1)}%`
      + `  rivers: ${rc.length} runs, longest ${rc[0] || 0}, ${share(rc, 20)}% of river cells in runs>=20`
      + `  paths: ${pc.length} runs, longest ${pc[0] || 0}, ${share(pc, 20)}% in runs>=20`);
    check(top[1] / (size * size) <= 0.35, `seed ${seed}: no tile above 35 % (max ${top[0]} ${(100 * top[1] / (size * size)).toFixed(1)} %)`);

    // Spawn: (0,0) and its 8 neighbours walkable, a path within 2 cells.
    let blocked = 0, pathNear = false;
    for (let z = -2; z <= 2; z++) {
      for (let x = -2; x <= 2; x++) {
        const t = wfc.get(x, z);
        if (Math.abs(x) <= 1 && Math.abs(z) <= 1 && tileById.get(t.id).blocked) blocked++;
        if (Object.values(socketsOf(tileById, t)).includes('p')) pathNear = true;
      }
    }
    check(blocked === 0 && pathNear, `seed ${seed}: spawn 3x3 walkable (${blocked} blocked), path within 2 cells: ${pathNear}`);

    // Determinism + order independence: fresh instances, different request orders, cache eviction between.
    const R = 48, n = R * 2;
    const ref = (x, z) => grid[(z + HALF) * size + x + HALF];
    const same = (a, b) => a.id === b.id && a.rot === b.rot;
    let diffA = 0, diffB = 0, diffC = 0, diffD = 0;
    const w2 = createWFC(tilesJson, seed); // reverse order
    for (let i = n * n - 1; i >= 0; i--) { const x = (i % n) - R, z = ((i / n) | 0) - R; if (!same(w2.get(x, z), ref(x, z))) diffA++; }
    const w3 = createWFC(tilesJson, seed); // random order
    for (const i of shuffled(n * n, seed + 99)) { const x = (i % n) - R, z = ((i / n) | 0) - R; if (!same(w3.get(x, z), ref(x, z))) diffB++; }
    const w4 = createWFC(tilesJson, seed); // far away first, then spiral outward from a corner, column-major
    for (let k = 0; k < 700; k++) w4.get(5000 + k * CHUNK, -9000 - (k % 13) * CHUNK);
    for (let x = R - 1; x >= -R; x--) for (let z = -R; z < R; z++) if (!same(w4.get(x, z), ref(x, z))) diffC++;
    // Revisit on the first instance after its cache was flushed by a long walk.
    for (let k = 0; k < 700; k++) wfc.get(-20000 - k * CHUNK, 300 + (k % 7) * CHUNK);
    for (let z = -R; z < R; z++) for (let x = -R; x < R; x++) if (!same(wfc.get(x, z), ref(x, z))) diffD++;
    check(diffA + diffB + diffC === 0, `seed ${seed}: order independence over ${n * n} cells (reverse ${diffA}, shuffled ${diffB}, far-first column-major ${diffC} diffs)`);
    check(diffD === 0, `seed ${seed}: identical when revisited after cache eviction (${diffD} diffs)`);
  }

  // Different seeds give different worlds.
  const a = createWFC(tilesJson, 1), b = createWFC(tilesJson, 2);
  let differ = 0;
  for (let z = -20; z < 20; z++) for (let x = -20; x < 20; x++) { const p = a.get(x, z), q = b.get(x, z); if (p.id !== q.id || p.rot !== q.rot) differ++; }
  check(differ > 400, `seeds 1 and 2 differ in ${differ}/1600 cells`);

  // Odd inputs never throw.
  let odd = true;
  try {
    const w = createWFC(tilesJson, 'string-seed');
    for (const [x, z] of [[1e9, -1e9], [-0, 0], [2.7, -3.2], [NaN, 5], [Infinity, 1], [2 ** 40, -(2 ** 40)], ['3', null]]) { const t = w.get(x, z); if (!t || !tileById.has(t.id)) odd = false; }
    for (const bad of [undefined, {}, { tiles: [] }, { tiles: [{}] }, 'x']) { if (!createWFC(bad, 3).get(4, 4).id) odd = false; }
  } catch (e) { odd = false; console.log(e); }
  check(odd, 'odd coordinates, seeds and tile sets never throw');

  check(threw === 0, `never threw (${threw})`);
  check(totalCells >= 40000 * SEEDS.length && totalMismatch === 0, `${totalMismatch} socket mismatches over ${totalCells} cells, ${SEEDS.length} seeds`);
  check(totalUnknown === 0, `${totalUnknown} cells with unknown id or disallowed rotation`);
  check(stats.bestEffort === 0, `chunks solved ${stats.chunks}, restarts ${stats.restarts}, relaxed to minimal routes ${stats.relaxed}, best-effort ${stats.bestEffort}`);

  console.log('  tile histogram (all seeds):');
  for (const [k, v] of [...histAll].sort((x, y) => y[1] - x[1])) {
    const pct = 100 * v / totalCells;
    console.log(`    ${String(k).padEnd(18)} ${String(v).padStart(7)}  ${pct.toFixed(2).padStart(6)} %  ${'█'.repeat(Math.round(pct))}`);
  }
  const unused = tiles.filter((t) => !histAll.has(t.id)).map((t) => t.id);
  if (unused.length) console.log(`    never used: ${unused.join(', ')}`);

  // Timing.
  solveTimes.sort((x, y) => x - y);
  const q = (p) => solveTimes[Math.min(solveTimes.length - 1, Math.floor(p * solveTimes.length))];
  const avgSolve = solveTimes.reduce((x, y) => x + y, 0) / solveTimes.length;
  const amort = getTotalMs / getCalls;
  const hot = createWFC(tilesJson, 5);
  for (let z = -40; z < 40; z++) for (let x = -40; x < 40; x++) hot.get(x, z);
  const h0 = performance.now();
  let sink = 0;
  for (let rep = 0; rep < 20; rep++) for (let z = -40; z < 40; z++) for (let x = -40; x < 40; x++) sink += hot.get(x, z).rot;
  const hotMs = (performance.now() - h0) / (20 * 6400);
  console.log(`  timing: chunk solve avg ${avgSolve.toFixed(3)} ms, p50 ${q(0.5).toFixed(3)}, p99 ${q(0.99).toFixed(3)}, max ${q(1).toFixed(3)} ms (${solveTimes.length} chunks)`);
  console.log(`          get() amortised incl. generation ${amort.toFixed(5)} ms, cached ${hotMs.toFixed(6)} ms (${sink > 0 ? 'ok' : 'ok'})`);
  check(amort < 0.05, `amortised get() ${amort.toFixed(5)} ms < 0.05 ms`);
  check(q(0.99) < 4, `chunk solve p99 ${q(0.99).toFixed(3)} ms < 4 ms (max ${q(1).toFixed(3)} ms)`);

  console.log(`\n  map, seed ${MAP_SEED}, x -20..19 (left to right), z -12..11 (north at top), spawn (0,0) is column 21, row 13:`);
  console.log('  · meadow  ^ hill  ♣ forest  ⌂ house  ─│┌┐└┘├┤┬┴┼╴╵╶╷ path  ═║╔╗╚╝ river  ~ river end  ╫╪ bridge');
  console.log(mapDump(tileById, createWFC(tilesJson, MAP_SEED), -20, -12, 40, 24));
}

suite('built-in fallback tile set (tilesJson = null)', null);
if (existsSync(tilesPath)) {
  let json = null;
  try { json = JSON.parse(readFileSync(tilesPath, 'utf8')); } catch (e) { console.log(`\ncould not parse ${tilesPath}: ${e.message}`); failures++; }
  if (json) suite(`public/assets/tiles.json (${json.tiles?.length} tiles)`, json);
} else {
  console.log(`\n(public/assets/tiles.json not present yet: only the fallback set was tested)`);
}
console.log(failures ? `\nFAILED: ${failures} check(s)` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
