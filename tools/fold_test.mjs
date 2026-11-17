// Fold-motion and world test. Part 1 runs src/fold.js in Node; part 2 drives the real page in Chrome (GPU).
// Usage: node tools/fold_test.mjs [--port 5183] [--seed 7] [--top captures/world_top.png]
import { chromium } from 'playwright';
import fs from 'node:fs';
import * as Fold from '../src/fold.js';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const port = arg('port', 5183), seed = arg('seed', 7), topOut = arg('top', 'captures/world_top.png');
const fails = [];
const check = (ok, msg) => { if (!ok) fails.push(msg); return ok; };
const fmt = (r) => `rise ${r.rise.toFixed(3)} s, overshoot ${r.overshoot.toFixed(1)} %, wobbles ${r.wobbles} ` +
  `[${r.extrema.map((x) => (x * 100).toFixed(1)).join(', ')}], settle ${r.settle.toFixed(3)} s`;
function gate(r, label) {
  check(!r.nan, `${label}: NaN in trace`);
  check(r.max <= 1.000001, `${label}: flap went below flat (x max ${r.max})`);
  check(r.rise >= 0.45 && r.rise <= 0.8, `${label}: rise ${r.rise.toFixed(3)} outside 0.45-0.8 s`);
  check(r.overshoot >= 8 && r.overshoot <= 18, `${label}: overshoot ${r.overshoot.toFixed(1)} % outside 8-18`);
  check(r.wobbles >= 2 && r.wobbles <= 3, `${label}: ${r.wobbles} visible wobbles, want 2-3`);
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
    for (let k = 0; k < n; k++) Fold.step(pool, 0, Fold.SUBSTEP);
    t += n * Fold.SUBSTEP;
    trace.push({ t, x: pool.x[0] });
  }
  return { r: Fold.measureRise(trace), pool };
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
    w.debugFlapTrace(opts);
    window.__atlas.teleport(where[0], where[1]);
  }, { opts, nudge, where });
  await page.waitForFunction(() => window.__atlas.world.debugTraceResult()?.done, null, { timeout: 15000 });
  const res = await page.evaluate(() => window.__atlas.world.debugTraceResult());
  return { ...res, r: Fold.measureRise(res.samples) };
}

console.log('== browser: start burst');
await page.waitForTimeout(3500);
const burst = await page.evaluate(() => window.__atlas.world.debugState());
console.log(`burst: ${burst.audioRise} rise + ${burst.audioLand} land flap sounds, peak ${burst.maxAudioPer100ms} per 100 ms; ` +
  `${burst.geometries} source geometries, window ${burst.window.join('x')} cells, ${burst.indices / 3} triangles in one mesh, ` +
  `${burst.bufferMB.toFixed(1)} MB buffers, live blocks peak ${burst.liveBlocksMax}/${burst.liveBlocksCap}, page ${burst.pageColor}`);

console.log('== browser: sampled flap traces (sympathetic nudge off)');
let spot = 400;
for (const [label, opts] of [['light', { maxMass: 0.7 }], ['medium', { minMass: 0.8, maxMass: 1.3 }], ['heavy', { minMass: 1.5 }]]) {
  spot += 60;
  const t = await traceRise(opts, false, [spot, 37]).catch(() => null);
  if (!t || !t.started) { console.log(`${label}: no flap of that mass rose (skipped)`); continue; }
  console.log(`${label} ${t.name} mass ${t.mass} foldAngle ${t.foldAngle.toFixed(3)} (${t.samples.length} samples): ${fmt(t.r)}`);
  gate(t.r, `browser ${label}`);
}
{
  const t = await traceRise({ minMass: 0.8 }, true, [spot + 60, 37]).catch(() => null);
  if (t?.started) console.log(`with nudge on, ${t.name} mass ${t.mass}: ${fmt(t.r)} (later neighbour kicks count as motion)`);
}

console.log('== browser: 12 s of auto walking');
await page.evaluate(() => {
  const w = window.__atlas.world;
  w.debugSet({ nudge: true });
  window.__atlas.input.setAuto(true);
  window.__atlas.teleport(0, 0);
});
await page.waitForTimeout(4000);
await page.evaluate(() => {
  const w = window.__atlas.world;
  w.debugReset();
  const orig = w.update, cost = [];
  w.update = (dt, f, h) => { const t0 = performance.now(); orig(dt, f, h); cost.push(performance.now() - t0); };
  window.__cost = cost;
  window.__moving = [];
  window.__iv = setInterval(() => window.__moving.push(w.stats().flapsMoving), 50);
  window.__atlas.resetStats();
});
await page.waitForTimeout(12000);
const walk = await page.evaluate(() => {
  clearInterval(window.__iv);
  const c = [...window.__cost].sort((a, b) => a - b);
  const mv = window.__moving;
  return { state: window.__atlas.world.debugState(), frame: window.__atlas.stats(),
    cpu: { n: c.length, avg: c.reduce((a, b) => a + b, 0) / c.length, p95: c[Math.floor(c.length * 0.95)], max: c[c.length - 1] },
    movingAvg: mv.reduce((a, b) => a + b, 0) / mv.length, movingMax: Math.max(...mv),
    pos: [window.__atlas.traveller.position.x, window.__atlas.traveller.position.z] };
});
const s = walk.state;
console.log(`flap sounds while walking: ${s.audioRise} rise + ${s.audioLand} land, peak ${s.maxAudioPer100ms} per 100 ms (engine limit 28)`);
console.log(`world.update CPU: avg ${walk.cpu.avg.toFixed(3)} ms, p95 ${walk.cpu.p95.toFixed(3)} ms, max ${walk.cpu.max.toFixed(3)} ms over ${walk.cpu.n} frames`);
console.log(`frame: ${walk.frame.fps.toFixed(0)} fps avg, p95 ${walk.frame.p95.toFixed(2)} ms, ${walk.frame.calls} draw calls, ${walk.frame.tris} tris`);
console.log(`live blocks peak ${s.liveBlocksMax}/${s.liveBlocksCap}; tiles raised ${s.tileUps}, folded back ${s.tileDowns}, ` +
  `changed state twice within 0.75 s: ${s.flickers}`);
console.log(`tilesUp ${s.tilesUp}, flapsMoving avg ${walk.movingAvg.toFixed(1)} max ${walk.movingMax}, x range [${s.minX.toFixed(4)}, ${s.maxX.toFixed(4)}], NaN ${s.nan}, below flat ${s.belowFlat}`);
check(s.nan === 0 && s.vbNan === 0, 'NaN flap angle or vertex');
check(s.belowFlat === 0 && s.maxX <= 1.000001, 'flap below flat');
check(s.minX > -0.25, 'flap overshoot beyond 25 %');
check(s.maxAudioPer100ms <= 28, `audio rate ${s.maxAudioPer100ms} per 100 ms while walking`);
check(s.tileDowns > 20, 'tiles behind do not fold back');
check(s.flickers <= s.tileUps * 0.05, `boundary flicker: ${s.flickers} quick reversals`);
check(s.tilesUp > 20 && s.tilesUp < 90, `tilesUp ${s.tilesUp} out of expected range`);
check(walk.frame.calls <= 250, 'draw calls > 250');
check(walk.frame.tris <= 400000, 'triangles > 400k');
check(walk.frame.p95 <= 8, `frame p95 ${walk.frame.p95.toFixed(2)} ms > 8`);

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
const url = await page.evaluate(({ x, z }) => window.__atlas.world.debugTopDown(window.__atlas.renderer, { x, z, span: 32 }), { x: p[0], z: p[1] });
fs.writeFileSync(topOut, Buffer.from(url.split(',')[1], 'base64'));
console.log('top-down picture:', topOut);

if (errors.length) { console.log('page errors:', errors); fails.push('page errors'); }
await browser.close();
if (fails.length) { console.log('\nFAIL\n - ' + fails.join('\n - ')); process.exit(1); }
console.log('\nPASS');
