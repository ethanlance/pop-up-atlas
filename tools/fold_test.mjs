// Fold-motion and world test. Part 1 runs src/fold.js in Node; part 2 drives the real page in Chrome (GPU).
// Usage: node tools/fold_test.mjs [--port 5183] [--seed 7] [--top captures/world_top.png] [--strip captures/world_r2_strip]
import { chromium } from 'playwright';
import fs from 'node:fs';
import * as Fold from '../src/fold.js';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const port = arg('port', 5183), seed = arg('seed', 7), topOut = arg('top', 'captures/world_top.png');
const fails = [];
const check = (ok, msg) => { if (!ok) fails.push(msg); return ok; };
// Angle (degrees up from flat) every 100 ms through a trace.
const every100 = (samples) => { const out = []; for (let t = 0; t <= 1.0001; t += 0.1) { const k = samples.findIndex((q) => q.t >= t - 1e-6); out.push(k < 0 ? NaN : Math.round(90 - samples[k].x * 90)); } return out; };
const fmt = (r) => `rise ${r.rise.toFixed(3)} s, overshoot ${r.overshoot.toFixed(1)} %, wobbles ${r.wobbles} ` +
  `[${r.extrema.map((x) => (x * 100).toFixed(1)).join(', ')}], settle ${r.settle.toFixed(3)} s`;
function gate(r, label) {
  check(!r.nan, `${label}: NaN in trace`);
  check(r.max <= 1.000001, `${label}: flap went below flat (x max ${r.max})`);
  check(r.rise >= 0.5 && r.rise <= 0.6, `${label}: rise ${r.rise.toFixed(3)} outside 0.5-0.6 s`);
  check(r.overshoot >= 10 && r.overshoot <= 14, `${label}: overshoot ${r.overshoot.toFixed(1)} % outside 10-14`);
  check(r.extrema[1] >= 0.04, `${label}: first back-swing ${((r.extrema[1] ?? 0) * 100).toFixed(1)} % < 4 %`);
  check(r.steps >= 4, `${label}: only ${r.steps} intermediate angles at 100 ms spacing`);
  check(r.wobbles >= 3 && r.wobbles <= 4, `${label}: ${r.wobbles} extrema of 1 % or more, want overshoot plus 2-3 swings`);
  check(r.settle < 1.4, `${label}: settle ${r.settle.toFixed(3)} s >= 1.4`);
}

// ---------------------------------------------------------------- part 1: the spring alone, in Node
console.log('== fold.js in Node (fixed substep %s ms)', (Fold.SUBSTEP * 1000).toFixed(2));
function simulate(mass, frameDt) {
  const pool = Fold.createFoldPool(1);
  Fold.initFlap(pool, 0, mass);
  Fold.startRise(pool, 0);
  const trace = [{ t: 0, x: 1 }];
  let acc = 0, t = 0;
  while (t < 2.5) {
    acc += frameDt;
    const n = Math.floor(acc / Fold.SUBSTEP + 1e-9);
    acc -= n * Fold.SUBSTEP;
    for (let k = 0; k < n; k++) { Fold.step(pool, 0, Fold.SUBSTEP); t += Fold.SUBSTEP; trace.push({ t, x: pool.x[0] }); }
  }
  const r = Fold.measureRise(trace);
  r.steps = every100(trace).filter((d) => d > 5 && d < 85).length;
  return { r, pool };
}
let prevOs = 0, prevRise = 0;
for (const mass of [0.5, 0.75, 1, 1.5, 2]) {
  const { r, pool } = simulate(mass, Fold.SUBSTEP);
  console.log(`mass ${mass}: ${fmt(r)}`);
  gate(r, `node mass ${mass}`);
  check(r.overshoot > prevOs && r.rise > prevRise, `node mass ${mass}: heavier must be slower with more overshoot`);
  prevOs = r.overshoot; prevRise = r.rise;
  // fold down
  Fold.startFall(pool, 0);
  let land = 0, rest = 0, bounce = 0, maxX = 0, minAfter = 1;
  for (let k = 1; k <= 480; k++) {
    const ev = Fold.step(pool, 0, Fold.SUBSTEP);
    if (ev === Fold.EV_LANDED) land = k * Fold.SUBSTEP;
    if (land && pool.x[0] < minAfter) minAfter = pool.x[0];
    if (pool.x[0] > maxX) maxX = pool.x[0];
    if (!rest && pool.mode[0] === Fold.FLAT) rest = k * Fold.SUBSTEP;
  }
  bounce = (1 - minAfter) * 100;
  console.log(`   fall: lands ${land.toFixed(3)} s, rests ${rest.toFixed(3)} s, bounce ${bounce.toFixed(2)} %, max x ${maxX}`);
  check(maxX <= 1, `node mass ${mass}: fall went through the page`);
  check(land > 0 && land < 0.45, `node mass ${mass}: fall should land quicker than the rise`);
  check(bounce < 3, `node mass ${mass}: fall bounce too large`);
}
{
  const ref = simulate(1, 1 / 240).r;
  for (const hz of [30, 60, 144]) {
    const r = simulate(1, 1 / hz).r;
    const d = Math.abs(r.overshoot - ref.overshoot);
    console.log(`frame rate ${hz} Hz: ${fmt(r)}`);
    check(d < 0.2 && Math.abs(r.rise - ref.rise) < 0.02, `frame-rate dependence at ${hz} Hz`);
  }
}

// ---------------------------------------------------------------- part 2: the real page
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu',
  '--ignore-gpu-blocklist', '--disable-frame-rate-limit=false'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error' && !/404/.test(m.text())) errors.push(m.text()); });
await page.goto(`http://localhost:${port}/?auto=1&seed=${seed}`);
await page.waitForFunction(() => window.__atlas?.world?.debugState, null, { timeout: 30000 });
await page.waitForTimeout(500);
const tilesJson = JSON.parse(fs.readFileSync(new URL('../public/assets/tiles.json', import.meta.url)));

async function traceRise(opts, nudge, where) {
  await page.evaluate(({ opts, nudge, where }) => {
    const w = window.__atlas.world;
    window.__atlas.input.setAuto(false); // stand still: the traced flap must not be folded away mid-measurement
    w.debugSet({ nudge });
    // Stand one cell below a tile that owns a flap of the wanted mass (tiles far from any earlier test spot).
    let spot = null;
    for (let cz = where[1]; cz < where[1] + 40 && !spot; cz++) {
      for (let cx = where[0]; cx < where[0] + 40 && !spot; cx++) {
        const t = w.debugTile(cx, cz);
        if (!t.inWindow && window.__protoMass?.[t.id] === undefined) { /* masses are learnt from tiles seen in the window */ }
        const masses = window.__protoMass?.[t.id];
        if (opts.name ? /hill/.test(t.id) : masses && masses.some((m) => m >= (opts.minMass ?? 0) && m <= (opts.maxMass ?? 9))) spot = [cx * 2, cz * 2 + 1.2];
      }
    }
    window.__atlas.teleport(...(spot ?? [where[0] * 2, where[1] * 2]));
  }, { opts, nudge, where });
  // Tiles in frame snap up after a teleport. Lay them flat and let them rise again, and trace one flap of that rise.
  await page.waitForTimeout(700);
  await page.evaluate((opts) => { const w = window.__atlas.world; w.debugFlapTrace({ ...opts, maxDist: 1.6 }); w.debugReplay(); }, opts);
  await page.waitForFunction(() => window.__atlas.world.debugTraceResult()?.done, null, { timeout: 15000 });
  const res = await page.evaluate(() => window.__atlas.world.debugTraceResult());
  const r = Fold.measureRise(res.samples);
  r.steps = every100(res.samples).filter((d) => d > 5 && d < 85).length;
  return { ...res, r, deg: every100(res.samples) };
}

console.log('== browser: first 4 s (start + walking)');
await page.waitForTimeout(3500);
// Flap masses per tile id, learnt from the window around the start.
await page.evaluate(() => {
  const w = window.__atlas.world, p = window.__atlas.traveller.position, m = {};
  for (let dz = -5; dz <= 5; dz++) for (let dx = -6; dx <= 6; dx++) {
    const t = w.debugTile(Math.round(p.x / 2) + dx, Math.round(p.z / 2) + dz);
    if (t.inWindow) m[t.id] = t.pieces.filter((q) => q.fa !== 0).map((q) => q.mass);
  }
  window.__protoMass = m;
});
const burst = await page.evaluate(() => window.__atlas.world.debugState());
console.log(`first 4 s: ${burst.audioRise} rise + ${burst.audioLand} land flap sounds, peak ${burst.maxAudioPer100ms} per 100 ms; ` +
  `${burst.geometries} source geometries, window ${burst.window.join('x')} cells, ${burst.indices / 3} triangles in one mesh, ` +
  `${burst.bufferMB.toFixed(1)} MB buffers, live blocks peak ${burst.liveBlocksMax}/${burst.liveBlocksCap}, page ${burst.pageColor}`);

console.log('== browser: sampled flap traces (sympathetic nudge off)');
let spot = 200;
for (const [label, opts] of [['light', { maxMass: 0.7 }], ['medium', { minMass: 0.8, maxMass: 1.3 }], ['hill layer', { name: '^flap_hill' }]]) {
  spot += 50;
  const t = await traceRise(opts, false, [spot, 40]).catch(() => null);
  if (!t || !t.started) { console.log(`${label}: no flap of that mass rose (skipped)`); continue; }
  console.log(`${label} ${t.name} mass ${t.mass} foldAngle ${t.foldAngle.toFixed(3)} (${t.samples.length} samples): ${fmt(t.r)}`);
  console.log(`   angle every 100 ms: ${t.deg.join(' ')} degrees`);
  gate(t.r, `browser ${label}`);
}
{
  const t = await traceRise({ minMass: 0.8 }, true, [spot + 50, 40]).catch(() => null);
  if (t?.started) console.log(`with nudge on, ${t.name} mass ${t.mass}: ${fmt(t.r)} (later neighbour kicks count as motion)`);
}

console.log('== browser: 30 s of auto walking (cell constancy, mid-rotation count, perf)');
await page.evaluate(() => {
  const A = window.__atlas, w = A.world, cam = A.input.camera, tr = A.traveller;
  w.debugSet({ nudge: true });
  A.input.setAuto(true);
  A.teleport(0, 0);
  window.__arm = () => {
    w.debugReset();
    const orig = w.update, cost = [];
    w.update = (dt, f, h) => { const t0 = performance.now(); orig(dt, f, h); cost.push(performance.now() - t0); };
    const R = { cost, frames: 0, cells: new Map(), changed: [], missing: [], moving: [], band: [], audit: {}, maxCells: 0, ponds: new Map() };
    const v = tr.position.clone();
    const render = A.look.render;
    // After every rendered frame: every cell inside the camera footprint must hold the same tile as before and be drawn.
    A.look.render = (dt) => {
      render(dt);
      R.frames++;
      let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
      for (const [nx, ny] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        v.set(nx, ny, 0.5).unproject(cam);
        const ox = cam.position.x, oy = cam.position.y, oz = cam.position.z, t = oy / (oy - v.y);
        const gx = ox + (v.x - ox) * t, gz = oz + (v.z - oz) * t;
        x0 = Math.min(x0, gx); x1 = Math.max(x1, gx); z0 = Math.min(z0, gz); z1 = Math.max(z1, gz);
      }
      let n = 0;
      for (let cz = Math.round(z0 / 2); cz <= Math.round(z1 / 2); cz++) {
        for (let cx = Math.round(x0 / 2); cx <= Math.round(x1 / 2); cx++) {
          n++;
          const c = w.debugCell(cx, cz), key = cx + ',' + cz, sig = c.id + ':' + c.rot + ':' + c.drawnRot, was = R.cells.get(key);
          if (was === undefined) R.cells.set(key, sig);
          else if (was !== sig && R.changed.length < 20) R.changed.push({ key, was, now: sig, frame: R.frames });
          if (!c.drawn && R.missing.length < 20) R.missing.push({ key, why: c.why, frame: R.frames });
          if (c.id === 'pond') { const p = R.ponds.get(key) ?? { first: R.frames, last: R.frames }; p.last = R.frames; R.ponds.set(key, p); }
        }
      }
      R.maxCells = Math.max(R.maxCells, n);
      if (R.frames % 6 === 0) {
        const m = w.debugMoving(cam, tr.position); R.moving.push(m.inFrame); R.band.push(m.inBand);
        const b = w.debugBand(cam, tr.position); for (const k in b) R.audit[k] = (R.audit[k] ?? 0) + b[k];
        // The same audit for stretches of steady walking only (heading within 15 degrees for the last 1.5 s):
        // right after a turn, cards that were ahead of the rise line are suddenly beside the traveller.
        const hd = Math.atan2(tr.heading.z, tr.heading.x), now = performance.now();
        if (R.hd === undefined || Math.abs(Math.atan2(Math.sin(hd - R.hd), Math.cos(hd - R.hd))) > 0.26) { R.hd = hd; R.hdSince = now; }
        if (now - R.hdSince > 1500) { R.audit.steadyTotal = (R.audit.steadyTotal ?? 0) + b.levelTotal; R.audit.steadyNotUp = (R.audit.steadyNotUp ?? 0) + b.levelNotUp; }
      }
    };
    window.__R = R;
    A.resetStats();
  };
});
await page.waitForTimeout(4000);
await page.evaluate(() => window.__arm());
await page.waitForTimeout(30000);
const walk = await page.evaluate(() => {
  const A = window.__atlas, R = window.__R;
  const c = [...R.cost].sort((a, b) => a - b);
  const q = (a, p) => [...a].sort((x, y) => x - y)[Math.floor(a.length * p)];
  // Re-ask the WFC for every cell that was on screen: the answer must not have changed (cache eviction included).
  let requery = 0;
  for (const [key, sig] of R.cells) { const [cx, cz] = key.split(',').map(Number); const d = A.world.debugCell(cx, cz); if (d.id + ':' + d.rot + ':' + d.drawnRot !== sig) requery++; }
  return { state: A.world.debugState(), frame: A.stats(), frames: R.frames, cells: R.cells.size, maxCells: R.maxCells, changed: R.changed, missing: R.missing, requery,
    ponds: [...R.ponds].map(([k, p]) => k + ' frames ' + p.first + '-' + p.last),
    moving: { p10: q(R.moving, 0.1), p50: q(R.moving, 0.5), p90: q(R.moving, 0.9), zero: R.moving.filter((m) => m === 0).length / R.moving.length,
      in2to6: R.moving.filter((m) => m >= 2 && m <= 6).length / R.moving.length, ge2: R.moving.filter((m) => m >= 2).length / R.moving.length,
      band50: q(R.band, 0.5), bandShare: R.band.reduce((a, b) => a + b, 0) / Math.max(1, R.moving.reduce((a, b) => a + b, 0)) },
    cpu: { n: c.length, avg: c.reduce((a, b) => a + b, 0) / c.length, p95: c[Math.floor(c.length * 0.95)], max: c[c.length - 1] },
    audit: R.audit, programs: A.world.debugPrograms(A.renderer), slivers: A.world.debugSlivers(), nearSlivers: A.world.debugSlivers(0.35),
    pos: [A.traveller.position.x, A.traveller.position.z] };
});
const s = walk.state;
console.log(`cells: ${walk.frames} frames, ${walk.cells} distinct cells crossed the camera footprint (up to ${walk.maxCells} at once); ` +
  `tile changed in view: ${walk.changed.length}, not drawn in view: ${walk.missing.length}, changed on re-query: ${walk.requery}`);
if (walk.changed.length) console.log('  changed:', JSON.stringify(walk.changed.slice(0, 5)));
if (walk.missing.length) console.log('  missing:', JSON.stringify(walk.missing.slice(0, 5)));
console.log(`pond cells seen in the footprint (each a different cell entering and leaving): ${walk.ponds.join('; ') || 'none'}`);
console.log(`cards mid-rotation on screen (size >= 0.45, fold 10-90 %): p10 ${walk.moving.p10}, median ${walk.moving.p50}, p90 ${walk.moving.p90}; ` +
  `>= 2 in ${(walk.moving.ge2 * 100).toFixed(0)} % of samples, 2-6 in ${(walk.moving.in2to6 * 100).toFixed(0)} %, none in ${(walk.moving.zero * 100).toFixed(0)} %; ` +
  `${(walk.moving.bandShare * 100).toFixed(0)} % of them inside the sharp band`);
const au = walk.audit, pct = (a, b) => (b ? (100 * a / b).toFixed(2) : '0.00');
console.log(`rest poses: of ${au.total} flap samples on screen in the sharp band, ${pct(au.notUp, au.total)} % were not fully up ` +
  `(${pct(au.halfOpen, au.total)} % between 10 and 70 degrees); middle 70 % of the width: ${pct(au.coreNotUp, au.coreTotal)} %; ` +
  `whole screen: ${pct(au.screenNotUp, au.screenTotal)} % not up (the leading edge)`);
console.log(`level with or behind the traveller, on screen: ${pct(au.levelNotUp, au.levelTotal)} % of ${au.levelTotal} flap samples not fully up; ` +
  `in steady walking (same heading for 1.5 s): ${pct(au.steadyNotUp ?? 0, au.steadyTotal ?? 0)} % of ${au.steadyTotal ?? 0}`);
check((au.steadyTotal ?? 0) > 0 && au.steadyNotUp / au.steadyTotal < 0.02, `steady walking: flaps level with or behind the traveller not fully up: ${pct(au.steadyNotUp ?? 0, au.steadyTotal ?? 0)} %`);
console.log(`fold shader programs: ${walk.programs.join(', ')}`);
console.log(`edge-on pieces at drawable rotations: ${walk.slivers.length ? walk.slivers.map((t) => `${t.id}@${t.rot}[${t.pieces.join(', ')}]`).join('; ') : 'none'}`);
console.log(`facing under 35 % (thin on screen): ${walk.nearSlivers.map((t) => `${t.id}@${t.rot}[${t.pieces.join(', ')}]`).join('; ') || 'none'}`);
console.log(`flap sounds while walking: ${s.audioRise} rise + ${s.audioLand} land, peak ${s.maxAudioPer100ms} per 100 ms (engine limit 28)`);
console.log(`world.update CPU: avg ${walk.cpu.avg.toFixed(3)} ms, p95 ${walk.cpu.p95.toFixed(3)} ms, max ${walk.cpu.max.toFixed(3)} ms over ${walk.cpu.n} frames`);
console.log(`frame: ${walk.frame.fps.toFixed(0)} fps avg, p95 ${walk.frame.p95.toFixed(2)} ms, ${walk.frame.calls} draw calls, ${walk.frame.tris} tris; ` +
  `tiles mesh ${s.indices / 3} triangles, buffers ${s.bufferMB.toFixed(1)} MB, window ${s.window.join('x')}`);
console.log(`live blocks peak ${s.liveBlocksMax}/${s.liveBlocksCap}; tiles raised ${s.tileUps}, folded back ${s.tileDowns}, ` +
  `changed state twice within 0.75 s: ${s.flickers}`);
console.log(`tilesUp ${s.tilesUp}, x range [${s.minX.toFixed(4)}, ${s.maxX.toFixed(4)}], NaN ${s.nan}, below flat ${s.belowFlat}`);
check(walk.changed.length === 0, 'a cell in view changed its tile or rotation');
check(walk.missing.length === 0, 'a cell in view was not drawn');
check(walk.requery === 0, 'WFC answer changed on re-query');
check(walk.programs.length >= 2, 'fold patch missing from the shadow or main program');
check(s.nan === 0 && s.vbNan === 0, 'NaN flap angle or vertex');
check(s.belowFlat === 0 && s.maxX <= 1.000001, 'flap below flat');
check(s.minX > -0.25, 'flap overshoot beyond 25 %');
check(s.maxAudioPer100ms <= 28, `audio rate ${s.maxAudioPer100ms} per 100 ms while walking`);
check(s.tileDowns > 20, 'tiles behind do not fold back');
check(s.flickers <= s.tileUps * 0.05, `boundary flicker: ${s.flickers} quick reversals`);
check(s.tilesUp >= 4 && s.tilesUp < 60, `tilesUp ${s.tilesUp} out of expected range`);
check(walk.frame.calls <= 250, 'draw calls > 250');
check(walk.frame.tris <= 400000, 'triangles > 400k');
check(walk.frame.p95 <= 8, `frame p95 ${walk.frame.p95.toFixed(2)} ms > 8`);

console.log('== browser: heightAt over a bridge');
const hres = await page.evaluate(async () => {
  const A = window.__atlas, w = A.world;
  let cell = null;
  for (let r = 0; r < 60 && !cell; r++) for (let cz = -r; cz <= r && !cell; cz++) for (let cx = -r; cx <= r && !cell; cx++) if (w.debugTile(cx, cz).id === 'bridge') cell = [cx, cz];
  if (!cell) return null;
  A.input.setAuto(false);
  const flat = w.heightAt(cell[0] * 2, cell[1] * 2); // bridge not in the window yet, or flat
  A.teleport(cell[0] * 2, cell[1] * 2);
  await new Promise((r) => setTimeout(r, 800));
  const prof = (dx, dz) => Array.from({ length: 9 }, (_, i) => +w.heightAt(cell[0] * 2 + dx * (i - 4) / 4, cell[1] * 2 + dz * (i - 4) / 4).toFixed(3));
  return { cell, tile: w.debugTile(cell[0], cell[1]).drawnRot, flat, alongX: prof(1, 0), alongZ: prof(0, 1), page: w.heightAt(cell[0] * 2 + 6, cell[1] * 2) };
});
if (hres) {
  console.log(`bridge at ${hres.cell} (drawn rot ${hres.tile}): before arrival ${hres.flat}; popped, edge to edge along x ${hres.alongX.join(' ')}; along z ${hres.alongZ.join(' ')}; page ${hres.page}`);
  const top = Math.max(...hres.alongX, ...hres.alongZ);
  check(hres.flat === 0 && hres.page === 0, 'heightAt must be 0 on the page and over a flat bridge');
  check(top > 0.08 && top < 0.5, `bridge deck height ${top} looks wrong`);
} else console.log('no bridge within 60 cells (skipped)');

console.log('== browser: isWalkable');
const walkRes = await page.evaluate(({ tiles }) => {
  const w = window.__atlas.world, byId = new Map(tiles.map((t) => [t.id, t]));
  let blockedCells = 0, blockedBad = 0, obs = 0, obsBad = 0, free = 0, freeBad = 0;
  for (let cz = 60; cz < 100; cz++) {
    for (let cx = -20; cx < 20; cx++) { // far from the traveller: these tiles are not even in the window
      const info = w.debugTile(cx, cz), def = byId.get(info.id);
      if (def.blocked) { blockedCells++; if (w.isWalkable(cx * 2 + 0.3, cz * 2 - 0.4)) blockedBad++; continue; }
      for (const o of def.obstacles) {
        let x = o.x, z = o.z;
        for (let r = 0; r < info.drawnRot; r++) { const nx = -z; z = x; x = nx; }
        obs++;
        if (w.isWalkable(cx * 2 + x, cz * 2 + z)) obsBad++;
        if (w.isWalkable(cx * 2 + x + (o.r + 0.1), cz * 2 + z)) { /* inside the 0.12 margin: must be blocked */ obsBad++; }
      }
      if (!def.obstacles.length) { free++; if (!w.isWalkable(cx * 2, cz * 2)) freeBad++; }
    }
  }
  return { blockedCells, blockedBad, obs, obsBad, free, freeBad };
}, { tiles: tilesJson.tiles });
console.log(JSON.stringify(walkRes));
check(walkRes.blockedBad === 0, 'blocked tile is walkable');
check(walkRes.obsBad === 0, 'obstacle circle is walkable');
check(walkRes.freeBad === 0, 'free tile centre is not walkable');

// Top-down picture for the line-up check (paths and rivers must be continuous across cells).
const p = walk.pos;
const url = await page.evaluate(({ x, z }) => window.__atlas.world.debugTopDown(window.__atlas.renderer, { x, z, span: 22 }), { x: p[0], z: p[1] });
fs.writeFileSync(topOut, Buffer.from(url.split(',')[1], 'base64'));
console.log('top-down picture:', topOut);

// Optional: 12-frame strips of a steady walk, to judge the fold motion by eye (--strip captures/name -> name_e.jpg ...).
const stripOut = arg('strip', '');
if (stripOut) {
  const { execFileSync } = await import('node:child_process');
  for (const [dir, key] of [['e', 'd'], ['n', 'w'], ['s', 's']]) {
    const sp = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
    await sp.goto(`http://localhost:${port}/?seed=${seed}`);
    await sp.waitForFunction(() => window.__atlas?.world?.debugState);
    await sp.waitForTimeout(1500);
    // Start at the head of a lane that is walkable for 18 units, so the walk is straight and steady.
    const lane = await sp.evaluate((dir) => {
      const A = window.__atlas, w = A.world, d = { e: [1, 0], n: [0, -1], s: [0, 1] }[dir];
      for (let r = 0; r < 60000; r++) {
        const x = ((r * 37) % 161 - 80) * 2 + ((r % 5) - 2) * 0.4, z = ((r * 53) % 163 - 80) * 2 + ((r % 7) - 3) * 0.28;
        let ok = true;
        for (let t = -0.3; t <= 10 && ok; t += 0.12) for (const o of [-0.16, 0, 0.16]) if (!w.isWalkable(x + d[0] * t + d[1] * o, z + d[1] * t + d[0] * o)) ok = false;
        if (ok) { A.teleport(x, z); return [x, z]; }
      }
      return null;
    }, dir);
    await sp.waitForTimeout(600);
    await sp.keyboard.down(key);
    await sp.waitForTimeout(2000);
    const tmp = `${stripOut}_${dir}_frames`; fs.mkdirSync(tmp, { recursive: true });
    // Frames are grabbed inside the page right after a render, every 100 ms of GAME time (the sum of the loop's dt:
    // grabbing a frame stalls the page, and the loop caps dt, so wall-clock spacing would be too close).
    const shots = await sp.evaluate(() => new Promise((resolve) => {
      const A = window.__atlas, render = A.look.render, out = [];
      let acc = 0.1;
      A.look.render = (dt) => {
        render(dt);
        acc += dt;
        if (acc < 0.1 || out.length >= 12) return;
        acc -= 0.1;
        const m = A.world.debugMoving(A.input.camera, A.traveller.position, 0.3), b = A.world.debugBand(A.input.camera, A.traveller.position);
        out.push({ url: A.renderer.domElement.toDataURL('image/jpeg', 0.9), info: `${m.inFrame}/${b.notUp}`, z: A.traveller.position.z, x: A.traveller.position.x });
        if (out.length === 12) { A.look.render = render; resolve(out); }
      };
    }));
    await sp.keyboard.up(key);
    shots.forEach((sh, f) => fs.writeFileSync(`${tmp}/f_${String(f).padStart(2, '0')}.jpg`, Buffer.from(sh.url.split(',')[1], 'base64')));
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '1', '-i', `${tmp}/f_%02d.jpg`, '-vf', 'scale=640:360,tile=4x3', '-frames:v', '1', '-q:v', '3', `${stripOut}_${dir}.jpg`]);
    const moved = Math.hypot(shots[11].x - shots[0].x, shots[11].z - shots[0].z);
    console.log(`strip ${stripOut}_${dir}.jpg (100 ms apart, lane ${lane}, walked ${moved.toFixed(2)} u in 1.1 s): cards mid-rotation on screen / in-band flaps not up: ${shots.map((sh) => sh.info).join(' ')}`);
    await sp.close();
  }
}

if (errors.length) { console.log('page errors:', errors); fails.push('page errors'); }
await browser.close();
if (fails.length) { console.log('\nFAIL\n - ' + fails.join('\n - ')); process.exit(1); }
console.log('\nPASS');
