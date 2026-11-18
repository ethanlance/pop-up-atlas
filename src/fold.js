// Fold springs for pop-up flaps. Pure JS (no three.js), so tools/fold_test.mjs can run it in Node.
// A flap angle is a fraction x: 1 = flat on its parent, 0 = upright (popped), x < 0 = past upright (overshoot).
// The rendered angle is foldAngle * x. Integration is semi-implicit Euler at a fixed substep (world.js owns the clock).
//
// Rise: a stiff spring follows a target that creeps off the page and then snaps upright (1 - u^7 over `riseT`) and
// stops dead. The card spends about 0.4 s lifting its first 10 degrees, swings from 10 to 70 degrees in about 120 ms
// (it is never seen hanging half open), overshoots upright by about 12 % and wobbles back once or twice.
// Fall: a softer, well damped spring aims slightly below the page, so the flap lands with a little speed, is clamped
// at flat and bounces once, very small (the "slap").

export const SUBSTEP = 1 / 240;

export const FLAT = 0; // at rest, x = 1
export const RISING = 1; // driven up, then free wobble about 0
export const UP = 2; // at rest, x = 0
export const FALLING = 3; // going down, then tiny bounce at 1

// Events returned by step().
export const EV_NONE = 0;
export const EV_LANDED = 1; // first contact with the page on the way down
export const EV_REST_UP = 2;
export const EV_REST_FLAT = 3;

const FLOOR_BOUNCE = 0.4;
const FALL_AIM = 1.06;
const REST_X = 0.002;
const REST_V = 0.03;

/** Spring constants for a flap of the given `mass` extra (0.5..2). Heavier = slower rise, more overshoot. */
export function flapParams(mass) {
  const m = Math.min(2, Math.max(0.5, mass || 1));
  const k = Math.log2(m); // -1..1
  return {
    riseT: 0.52 + 0.03 * k, // target ramp duration, s
    omega: 37 - 2 * k, // wobble spring, rad/s
    zeta: 0.37 - 0.015 * k,
    ramp: 7, // ramp exponent: higher = faster arrival = more overshoot
    fallOmega: 15 - 2.5 * k,
    fallZeta: 0.8,
  };
}

/** Typed-array pool of `n` flap springs. */
export function createFoldPool(n) {
  return {
    n,
    x: new Float32Array(n).fill(1),
    v: new Float32Array(n),
    tau: new Float32Array(n), // time on the rise ramp
    mode: new Uint8Array(n),
    landed: new Uint8Array(n),
    riseT: new Float32Array(n),
    omega: new Float32Array(n),
    zeta: new Float32Array(n),
    ramp: new Float32Array(n),
    fallOmega: new Float32Array(n),
    fallZeta: new Float32Array(n),
  };
}

export function initFlap(pool, i, mass, up = false) {
  const p = flapParams(mass);
  pool.riseT[i] = p.riseT;
  pool.omega[i] = p.omega;
  pool.zeta[i] = p.zeta;
  pool.ramp[i] = p.ramp;
  pool.fallOmega[i] = p.fallOmega;
  pool.fallZeta[i] = p.fallZeta;
  pool.x[i] = up ? 0 : 1;
  pool.v[i] = 0;
  pool.tau[i] = 0;
  pool.landed[i] = 0;
  pool.mode[i] = up ? UP : FLAT;
}

/** Start (or resume, from any pose) the rise. */
export function startRise(pool, i) {
  if (pool.mode[i] === UP || pool.mode[i] === RISING) return;
  // Enter the ramp where its target equals the current pose, so an interrupted fall does not snap back down first.
  const x = Math.min(1, Math.max(0, pool.x[i]));
  pool.tau[i] = pool.riseT[i] * Math.pow(1 - x, 1 / pool.ramp[i]);
  pool.mode[i] = RISING;
}

/** Start the fold-down from any pose. */
export function startFall(pool, i) {
  if (pool.mode[i] === FLAT || pool.mode[i] === FALLING) return;
  pool.mode[i] = FALLING;
  pool.landed[i] = 0;
}

/** Small velocity kick on a resting upright flap (neighbour popped). Returns true if the flap started to move. */
export function nudge(pool, i, dv) {
  if (pool.mode[i] !== UP) return false;
  pool.mode[i] = RISING;
  pool.tau[i] = pool.riseT[i];
  pool.v[i] += dv;
  return true;
}

/** Advance flap `i` by one substep `h`. Returns an EV_* code. */
export function step(pool, i, h) {
  const mode = pool.mode[i];
  if (mode === RISING) {
    const T = pool.riseT[i];
    const tau = pool.tau[i] + h;
    pool.tau[i] = tau;
    const g = tau < T ? 1 - Math.pow(tau / T, pool.ramp[i]) : 0;
    const w = pool.omega[i];
    let v = pool.v[i];
    let x = pool.x[i];
    v += (-w * w * (x - g) - 2 * pool.zeta[i] * w * v) * h;
    x += v * h;
    if (x > 1) { x = 1; if (v > 0) v = -v * FLOOR_BOUNCE; }
    pool.x[i] = x;
    pool.v[i] = v;
    if (tau >= T && Math.abs(x) < REST_X && Math.abs(v) < REST_V) {
      pool.x[i] = 0; pool.v[i] = 0; pool.mode[i] = UP;
      return EV_REST_UP;
    }
    return EV_NONE;
  }
  if (mode === FALLING) {
    const w = pool.fallOmega[i];
    const aim = pool.landed[i] ? 1 : FALL_AIM;
    let v = pool.v[i];
    let x = pool.x[i];
    v += (-w * w * (x - aim) - 2 * pool.fallZeta[i] * w * v) * h;
    if (pool.landed[i]) v += 4 * h; // light gravity keeps the bounce short
    x += v * h;
    let ev = EV_NONE;
    if (x >= 1) {
      x = 1;
      if (!pool.landed[i]) { pool.landed[i] = 1; ev = EV_LANDED; }
      v = v > 0.35 ? -v * FLOOR_BOUNCE : 0;
      if (v === 0) {
        pool.x[i] = 1; pool.v[i] = 0; pool.mode[i] = FLAT;
        return ev === EV_LANDED ? EV_LANDED : EV_REST_FLAT;
      }
    }
    pool.x[i] = x;
    pool.v[i] = v;
    return ev;
  }
  return EV_NONE;
}

/**
 * Measure a sampled angle trace `[{t, x}]` (t = seconds since the flap started to rise, x = fold fraction).
 * Returns rise time, overshoot %, visible wobble count (extrema past upright or back with |x| >= 1 %), settle time
 * and `dwell`, the time spent between 10 and 70 degrees of lift (half-open).
 */
export function measureRise(trace) {
  let rise = NaN, overshoot = 0, settle = 0, min = Infinity, max = -Infinity, nan = false, t10 = NaN, t70 = NaN;
  const extrema = [];
  for (let k = 0; k < trace.length; k++) {
    const { t, x } = trace[k];
    if (!Number.isFinite(x)) nan = true;
    if (x < min) min = x;
    if (x > max) max = x;
    if (Number.isNaN(t10) && x < 8 / 9) t10 = t; // 10 degrees up
    if (Number.isNaN(t70) && x < 2 / 9) t70 = t; // 70 degrees up
    if (Number.isNaN(rise) && x <= 0) {
      const a = trace[k - 1];
      rise = a ? a.t + (t - a.t) * (a.x / (a.x - x)) : t;
    }
    if (Math.abs(x) >= 0.005) settle = t;
    if (!Number.isNaN(rise) && k > 0 && k < trace.length - 1) {
      const p = trace[k - 1].x, n = trace[k + 1].x;
      if ((x < p && x <= n) || (x > p && x >= n)) {
        if (Math.abs(x) >= 0.01 && (!extrema.length || Math.sign(extrema[extrema.length - 1]) !== Math.sign(x))) extrema.push(x);
      }
    }
  }
  if (min < 0) overshoot = -min * 100;
  return { rise, overshoot, wobbles: extrema.length, extrema, settle, min, max, nan, dwell: t70 - t10 };
}
