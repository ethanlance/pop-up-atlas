// Traveller / input / camera acceptance test. Run: node tools/trav_test.mjs [--throttle 4] [--auto 40] [--shots] [--shots-only] [--real]
// Uses the installed Google Chrome on the GPU against the running dev server (port 5183).
import { chromium } from 'playwright';
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? (process.argv[i + 1] ?? '1') : d; };
const has = (k) => process.argv.includes('--' + k);
const port = arg('port', 5183), throttle = Number(arg('throttle', 1)), autoSecs = Number(arg('auto', 40));
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu'] });
const results = [];
const check = (name, value, pass, note = '') => { results.push({ name, value, pass, note }); };
const r3 = (v) => Math.round(v * 1000) / 1000;

async function open(scale = 1, w = 1440, h = 810) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: scale });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  // Other agents edit files while this runs; stub the Vite client so a hot reload cannot restart the page mid-test.
  await page.route('**/@vite/client', (route) => route.fulfill({ contentType: 'text/javascript', body:
    'export const createHotContext=()=>({accept(){},dispose(){},prune(){},on(){},off(){},invalidate(){},send(){}});'
    + 'export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;' }));
  await page.goto(`http://localhost:${port}/?dpr=${scale}`);
  await page.waitForFunction(() => window.__atlas, null, { timeout: 30000 });
  if (throttle > 1) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
  }
  await page.evaluate(() => {
    const a = window.__atlas, cam = a.input.camera;
    window.__rec = [];
    window.__on = false;
    window.__realWalkable = a.world.isWalkable;
    const loop = (t) => {
      if (window.__on) {
        window.__rec.push([t, a.traveller.position.x, a.traveller.position.z, cam.position.x, cam.position.y,
          cam.position.z, a.traveller.yaw, a.traveller.hop, a.traveller.squash]);
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    window.__start = () => { window.__rec = []; window.__on = true; };
    window.__stop = () => { window.__on = false; return window.__rec; };
    // Synthetic terrain: rivers every 6 rows with a bridge every 5 columns, round obstacles in ~25 % of cells.
    window.__fake = (x, z) => {
      const cx = Math.round(x / 2), cz = Math.round(z / 2);
      const m = (n, k) => ((n % k) + k) % k;
      if (cx === 0 && cz === 0) return true;
      if (m(cz, 6) === 3) return m(cx, 5) === 0 && Math.abs(x - cx * 2) < 0.5;
      const hash = m(Math.imul(cx * 73856093 ^ cz * 19349663, 2654435761) >>> 8, 100);
      if (hash < 25) return Math.hypot(x - cx * 2, z - cz * 2) > 0.3 + (hash % 5) * 0.12;
      return true;
    };
    window.__setWorld = (mode) => {
      a.world.isWalkable = mode === 'open' ? () => true : mode === 'fake' ? window.__fake : window.__realWalkable;
    };
  });
  return { page, errors };
}

if (!has('shots-only')) {
const { page, errors } = await open();
const rest = async (ms = 700) => page.waitForTimeout(ms);
const reset = async (mode = 'open') => {
  await page.evaluate((m) => { window.__setWorld(m); window.__atlas.teleport(0, 0); }, mode);
  await rest(1500);
};
const pathLen = (rec) => rec.slice(1).reduce((s, r, i) => s + Math.hypot(r[1] - rec[i][1], r[2] - rec[i][2]), 0);

// ---- 1. keys: direction, speed, acceleration ------------------------------------------------------------------
await reset();
for (const [key, ax, sign] of [['KeyW', 2, -1], ['ArrowDown', 2, 1], ['KeyA', 1, -1], ['ArrowRight', 1, 1]]) {
  await page.evaluate(() => window.__start());
  await page.keyboard.down(key);
  await page.waitForTimeout(500);
  await page.keyboard.up(key);
  await rest(400);
  const rec = await page.evaluate(() => window.__stop());
  const d = rec.at(-1)[ax] - rec[0][ax], other = rec.at(-1)[3 - ax] - rec[0][3 - ax];
  check(`key ${key} moves ${sign > 0 ? '+' : '-'}${ax === 1 ? 'X' : 'Z'}`, r3(d), Math.sign(d) === sign && Math.abs(other) < 1e-6);
}
await reset();
await page.evaluate(() => window.__start());
const steps0 = await page.evaluate(() => window.__atlas.traveller.steps);
await page.keyboard.down('KeyD');
await page.waitForTimeout(5000);
const steps1 = await page.evaluate(() => window.__atlas.traveller.steps);
await page.keyboard.up('KeyD');
await rest(1200);
let rec = await page.evaluate(() => window.__stop());
{
  const t0 = rec.find((r) => r[1] > 1e-6)[0];
  const cruise = rec.filter((r) => r[0] > t0 + 500 && r[0] < t0 + 4500);
  const speed = (cruise.at(-1)[1] - cruise[0][1]) / ((cruise.at(-1)[0] - cruise[0][0]) / 1000);
  check('walk speed u/s (2.0-2.4)', r3(speed), speed >= 2.0 && speed <= 2.4);
  // time to reach 95 % of cruise speed, from per-frame velocity
  let tAcc = NaN;
  for (let i = 1; i < rec.length; i++) {
    const v = (rec[i][1] - rec[i - 1][1]) / ((rec[i][0] - rec[i - 1][0]) / 1000);
    if (rec[i][0] > t0 && v >= 0.95 * speed) { tAcc = (rec[i][0] - t0) / 1000; break; }
  }
  check('time to 95 % speed s (~0.12)', r3(tAcc), tAcc > 0.06 && tAcc < 0.2);
  const stepsPerSec = (steps1 - steps0) / 5;
  check('footfalls per s at full speed (~3.6)', r3(stepsPerSec), stepsPerSec > 3.3 && stepsPerSec < 3.9);
  const hop = Math.max(...cruise.map((r) => r[7])), sq = Math.max(...rec.map((r) => r[8]));
  check('hop apex u (~0.06)', r3(hop), hop > 0.05 && hop < 0.07);
  check('max landing squash (<= 0.06)', r3(sq), sq <= 0.06 && sq > 0.02);

  // camera smoothness in the steady part (look-ahead settled): per-frame velocity and second difference
  const steady = rec.filter((r) => r[0] > t0 + 3000 && r[0] < t0 + 4800);
  const vs = [], dts = [];
  for (let i = 1; i < steady.length; i++) {
    const dt = (steady[i][0] - steady[i - 1][0]) / 1000;
    if (dt <= 0) continue;
    dts.push(dt * 1000);
    vs.push((steady[i][3] - steady[i - 1][3]) / dt);
  }
  const mean = vs.reduce((a, b) => a + b, 0) / vs.length;
  const dev = Math.max(...vs.map((v) => Math.abs(v - mean))) / mean;
  let d2 = 0;
  for (let i = 2; i < steady.length; i++) d2 = Math.max(d2, Math.abs(steady[i][3] - 2 * steady[i - 1][3] + steady[i - 2][3]
    - mean * ((steady[i][0] - 2 * steady[i - 1][0] + steady[i - 2][0]) / 1000)));
  dts.sort((a, b) => a - b);
  check('camera velocity deviation while walking (< 2 %)', r3(dev * 100) + ' %', dev < 0.02,
    `frame dt ms min/med/max ${r3(dts[0])}/${r3(dts[dts.length >> 1])}/${r3(dts.at(-1))}, frames ${dts.length}`);
  check('camera 2nd difference, dt-corrected, max u (< 0.002)', d2.toExponential(2), d2 < 0.002);
  const zJit = Math.max(...steady.map((r) => r[5])) - Math.min(...steady.map((r) => r[5]));
  check('camera cross-axis wander while walking u (< 0.01)', zJit.toExponential(2), zJit < 0.01);
  const lead = steady.at(-1)[3] - steady.at(-1)[1];
  check('camera lead over traveller when cruising u', r3(lead), true, 'look-ahead 1.3 minus follow lag 2v/omega');
  // wobble after stopping: count sign changes of the stop transient is not observable here; see LOG
}

// ---- 2. turn flip ---------------------------------------------------------------------------------------------
await reset();
await page.keyboard.down('KeyD');
await page.waitForTimeout(900);
await page.evaluate(() => window.__start());
await page.keyboard.up('KeyD');
await page.keyboard.down('KeyA');
await page.waitForTimeout(900);
await page.keyboard.up('KeyA');
rec = await page.evaluate(() => window.__stop());
{
  const y0 = rec[0][6];
  const moved = rec.find((r) => Math.abs(r[6] - y0) > 0.02);
  const done = rec.find((r) => Math.abs(r[6] - y0) >= Math.PI * 0.95);
  const t = (done[0] - moved[0]) / 1000;
  const over = Math.max(...rec.map((r) => Math.abs(r[6] - y0))) / Math.PI - 1;
  check('turn flip time s (< 0.2)', r3(t), t < 0.2, `overshoot ${r3(over * 100)} %`);
}

// ---- 3. click-to-walk -----------------------------------------------------------------------------------------
await reset();
for (const [sx, sy] of [[1100, 250], [300, 650], [760, 380], [1300, 700]]) {
  await page.evaluate(() => window.__start());
  await page.mouse.click(sx, sy);
  const target = await page.evaluate(() => { const t = window.__atlas.input.target; return t && [t.x, t.z]; });
  await page.waitForFunction(() => !window.__atlas.input.target && window.__atlas.traveller.speed < 0.01, null, { timeout: 15000 });
  await rest(300);
  rec = await page.evaluate(() => window.__stop());
  const end = rec.at(-1), start = rec[0];
  const err = Math.hypot(end[1] - target[0], end[2] - target[1]);
  const len = Math.hypot(target[0] - start[1], target[1] - start[2]);
  const off = Math.max(...rec.map((r) => Math.abs((r[1] - start[1]) * (target[1] - start[2]) - (r[2] - start[2]) * (target[0] - start[1])) / len));
  check(`click (${sx},${sy}) arrival error u (< 0.1)`, r3(err), err < 0.1, `distance ${r3(len)}, off-line max ${off.toExponential(1)}`);
}
// a key press cancels the click target
await page.mouse.click(1300, 150);
await page.waitForTimeout(300);
await page.keyboard.down('KeyS');
await page.waitForTimeout(100);
const cancelled = await page.evaluate(() => window.__atlas.input.target === null);
await page.keyboard.up('KeyS');
check('key press cancels click target', cancelled, cancelled);
// holding the pointer keeps walking (the target follows the pointer as the camera follows the traveller)
await reset();
await page.evaluate(() => window.__start());
await page.mouse.move(1100, 405);
await page.mouse.down();
await page.waitForTimeout(3000);
const heldTarget = await page.evaluate(() => !!window.__atlas.input.target);
await page.mouse.up();
await page.waitForFunction(() => window.__atlas.traveller.speed < 0.01, null, { timeout: 15000 });
rec = await page.evaluate(() => window.__stop());
check('pointer held 3 s keeps walking: distance u (> 5)', r3(pathLen(rec)), heldTarget && pathLen(rec) > 5);

// ---- 4. camera step response ----------------------------------------------------------------------------------
await reset();
await page.evaluate(() => { window.__start(); const p = window.__atlas.traveller.position; window.__atlas.teleport(p.x + 4, p.z); });
await rest(2500);
rec = await page.evaluate(() => window.__stop());
{
  const c0 = rec[0][3], c1 = rec.at(-1)[3], tj = rec.find((r) => r[1] > 3.9)[0];
  const at = (f) => (rec.find((r) => (r[3] - c0) / (c1 - c0) >= f)[0] - tj) / 1000;
  const t63 = at(0.632);
  const over = Math.max(...rec.map((r) => (r[3] - c0) / (c1 - c0))) - 1;
  check('camera step response, 63 % time s (0.25-0.4)', r3(t63), t63 >= 0.25 && t63 <= 0.4,
    `50 % ${r3(at(0.5))} s, 90 % ${r3(at(0.9))} s, overshoot ${r3(over * 100)} %, travel ${r3(c1 - c0)}`);
}
{
  const view = await page.evaluate(() => {
    const a = window.__atlas, cam = a.input.camera, p = a.traveller.position;
    const dx = cam.position.x - p.x, dy = cam.position.y, dz = cam.position.z - p.z;
    const dist = Math.hypot(dx, dy - 0.3, dz);
    return { pitch: Math.atan2(dy - 0.3, Math.hypot(dx, dz)) * 180 / Math.PI, fov: cam.fov,
      width: 2 * dist * Math.tan(cam.fov * Math.PI / 360) * cam.aspect, aspect: cam.aspect };
  });
  check('camera pitch deg (50-60)', r3(view.pitch), view.pitch >= 50 && view.pitch <= 60, `fov ${view.fov}`);
  check('units across screen at 16:9 (18-22)', r3(view.width), view.width >= 18 && view.width <= 22, `aspect ${r3(view.aspect)}`);
}

// ---- 5. collision: never inside a blocked position, slides, no sticking ----------------------------------------
async function drive(name, setup, keys, ms, judge) {
  await page.evaluate(setup);
  await rest(300);
  await page.evaluate(() => window.__start());
  for (const k of keys) await page.keyboard.down(k);
  await page.waitForTimeout(ms);
  for (const k of keys) await page.keyboard.up(k);
  await rest(300);
  const out = await page.evaluate(() => {
    const rec = window.__stop(), w = window.__atlas.world.isWalkable;
    return { rec, inside: rec.filter((r) => !w(r[1], r[2])).length };
  });
  const [value, pass, note] = judge(out.rec);
  check(name, value, pass && out.inside === 0, `${note ?? ''} frames inside blocked: ${out.inside}`);
}
// diagonal into an axis-aligned wall at x >= 2: must slide along -Z at the full z component
await drive('slide along wall: z travel u (> 2.5), x <= 2', () => {
  window.__atlas.world.isWalkable = (x) => x < 2; window.__atlas.teleport(0, 0);
}, ['KeyD', 'KeyW'], 2500, (rec) => {
  const e = rec.at(-1); const zs = rec.filter((r) => r[1] > 1.95).map((r) => r[2]);
  let rev = 0; for (let i = 2; i < zs.length; i++) if ((zs[i] - zs[i - 1]) * (zs[i - 1] - zs[i - 2]) < 0) rev++;
  return [r3(-e[2]), -e[2] > 2.5 && e[1] < 2, `end x ${r3(e[1])}, direction reversals ${rev}.`];
});
// head-on into a round obstacle: must get around it and keep going
await drive('round obstacle head-on: x progress u (> 4)', () => {
  window.__atlas.world.isWalkable = (x, z) => Math.hypot(x - 2, z) > 0.6; window.__atlas.teleport(0, 0);
}, ['KeyD'], 3000, (rec) => {
  const e = rec.at(-1); let rev = 0;
  for (let i = 2; i < rec.length; i++) if ((rec[i][2] - rec[i - 1][2]) * (rec[i - 1][2] - rec[i - 2][2]) < 0) rev++;
  return [r3(e[1]), e[1] > 4, `side-step ${r3(e[2])}, z reversals ${rev}.`];
});
// into a concave corner: stops cleanly, then leaves at once
await drive('concave corner: holds still without jitter', () => {
  window.__atlas.world.isWalkable = (x, z) => x < 1 && z > -1; window.__atlas.teleport(0, 0);
}, ['KeyD', 'KeyW'], 1500, (rec) => {
  const tail = rec.filter((r) => r[0] > rec[0][0] + 900 && r[0] < rec[0][0] + 1400); // pressed into the corner
  let rev = 0, maxStep = 0;
  for (let i = 1; i < tail.length; i++) {
    maxStep = Math.max(maxStep, Math.hypot(tail[i][1] - tail[i - 1][1], tail[i][2] - tail[i - 1][2]));
    if (i > 1 && ((tail[i][1] - tail[i - 1][1]) * (tail[i - 1][1] - tail[i - 2][1]) < 0
      || (tail[i][2] - tail[i - 1][2]) * (tail[i - 1][2] - tail[i - 2][2]) < 0)) rev++;
  }
  return [maxStep.toExponential(1), maxStep < 1e-3 && rev === 0, `max frame step u, reversals ${rev}, rest at ${r3(tail.at(-1)[1])},${r3(tail.at(-1)[2])}.`];
});
await drive('leaves the corner immediately: distance u (> 1.5)', () => {}, ['KeyA'], 1000,
  (rec) => [r3(pathLen(rec)), pathLen(rec) > 1.5]);
// outward corner: walking along a wall that ends must not snag
await drive('convex corner: clears it, x progress u (> 4)', () => {
  window.__atlas.world.isWalkable = (x, z) => !(x > 1.5 && x < 3 && z > -2 && z < 5); window.__atlas.teleport(0, 0);
}, ['KeyD', 'KeyW'], 4500, (rec) => [r3(rec.at(-1)[1]), rec.at(-1)[1] > 4]);
// click on a blocked spot: gives up instead of pushing forever
await page.evaluate(() => { window.__atlas.world.isWalkable = (x) => x < 2; window.__atlas.teleport(0, 0); });
await rest(1200);
await page.mouse.click(1200, 405);
const gaveUp = await page.waitForFunction(() => !window.__atlas.input.target && window.__atlas.traveller.speed < 0.01, null,
  { timeout: 8000 }).then(() => true, () => false);
check('click on blocked spot gives up', gaveUp, gaveUp);

// ---- 6. auto wander -------------------------------------------------------------------------------------------
async function autoRun(mode, secs) {
  await reset(mode);
  await page.evaluate(() => {
    window.__planMs = [];
    clearInterval(window.__planTimer);
    window.__planTimer = setInterval(() => window.__planMs.push(window.__atlas.input.planMs), 100);
    window.__atlas.input.setAuto(true); window.__start();
  });
  await page.waitForTimeout(secs * 1000);
  const out = await page.evaluate(() => {
    const rec = window.__stop(), w = window.__atlas.world.isWalkable;
    window.__atlas.input.setAuto(false);
    let longest = 0, still = 0;
    const planMs = window.__planMs.sort((x, y) => x - y);
    for (let i = 1; i < rec.length; i++) {
      const dt = rec[i][0] - rec[i - 1][0];
      const v = Math.hypot(rec[i][1] - rec[i - 1][1], rec[i][2] - rec[i - 1][2]) / (dt / 1000);
      still = v < 0.3 ? still + dt : 0;
      longest = Math.max(longest, still);
    }
    const thin = rec.filter((_, i) => i % 200 === 0).map((r) => [r[1], r[2]]);
    return { rec: [rec[0], rec.at(-1)], thin, inside: rec.filter((r) => !w(r[1], r[2])).length, longest,
      secs: (rec.at(-1)[0] - rec[0][0]) / 1000,
      planMed: planMs[planMs.length >> 1], planMax: planMs.at(-1),
      len: rec.slice(1).reduce((s, r, i) => s + Math.hypot(r[1] - rec[i][1], r[2] - rec[i][2]), 0) };
  });
  const net = Math.hypot(out.rec[1][1] - out.rec[0][1], out.rec[1][2] - out.rec[0][2]);
  const per40 = out.len * 40 / out.secs;
  const xs = out.thin.map((p) => p[0]), zs = out.thin.map((p) => p[1]);
  check(`auto (${mode} world, ${secs} s): path per 40 s u (> 60)`, r3(per40), per40 > 60 && out.inside === 0 && out.longest < 1500,
    `net ${r3(net)} u, forward (-Z) ${r3(-(out.rec[1][2] - out.rec[0][2]))} u, x range ${r3(Math.min(...xs))}..${r3(Math.max(...xs))}, `
    + `z range ${r3(Math.min(...zs))}..${r3(Math.max(...zs))}, longest stall ${Math.round(out.longest)} ms, frames inside blocked ${out.inside}, route search ms median ${r3(out.planMed)} max ${r3(out.planMax)}`);
}
await autoRun('open', autoSecs);
await autoRun('fake', autoSecs);
if (has('real')) await autoRun('real', autoSecs);
if (errors.length) check('page errors', errors.join(' | '), false);
await page.close();

}

// ---- close-up captures for visual review ----------------------------------------------------------------------
if (has('shots') || has('shots-only')) {
  const { page: p2 } = await open(4, 1440, 810);
  const clipAt = async (what, w = 150, h = 120) => {
    const [x, y] = await p2.evaluate((k) => {
      const a = window.__atlas, cam = a.input.camera, src = k === 'marker' ? a.input.markerPos : a.traveller.position;
      cam.updateMatrixWorld();
      const v = src.clone().setY(0.25).project(cam);
      return [(v.x + 1) / 2 * innerWidth, (1 - v.y) / 2 * innerHeight];
    }, what);
    return { x: Math.max(0, x - w / 2), y: Math.max(0, y - h / 2), width: w, height: h };
  };
  await p2.waitForTimeout(1200);
  await p2.screenshot({ path: 'captures/trav_close_idle.png', clip: await clipAt('trav') });
  for (const [name, keys] of [['right', ['KeyD']], ['left', ['KeyA']], ['away', ['KeyW']], ['toward', ['KeyS']], ['diag', ['KeyW', 'KeyA']]]) {
    for (const k of keys) await p2.keyboard.down(k);
    await p2.waitForTimeout(1340);
    await p2.screenshot({ path: `captures/trav_close_${name}.png`, clip: await clipAt('trav') });
    for (const k of keys) await p2.keyboard.up(k);
    await p2.waitForTimeout(100);
    if (name === 'right') await p2.screenshot({ path: 'captures/trav_close_stopping.png', clip: await clipAt('trav') });
    await p2.waitForTimeout(700);
  }
  const near = await clipAt('trav', 0, 0); // click a short walk away, inside the sharp band, and catch the mark
  await p2.mouse.click(near.x + 70, near.y + 22);
  await p2.waitForTimeout(160);
  await p2.screenshot({ path: 'captures/trav_close_marker.png', clip: await clipAt('marker') });
  await p2.screenshot({ path: 'captures/trav_wide.png' });
  await p2.close();
}

await browser.close();
const w = Math.max(...results.map((r) => r.name.length));
for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name.padEnd(w)}  ${r.value}  ${r.note}`);
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed${throttle > 1 ? ` (cpu throttle ${throttle}x)` : ''}`);
process.exit(failed ? 1 : 0);
