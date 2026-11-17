// Offline render + measurement of src/audio.js. Needs the dev server on :5183. Run: node tools/audio_test.mjs
// Writes tools/audio_render/flaps.wav, spec.png, report.json. Exit code 1 when a check fails.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const port = process.env.PORT ?? 5183;
const outDir = join(dirname(fileURLToPath(import.meta.url)), 'audio_render');
mkdirSync(outDir, { recursive: true });
const SR = 48000;
const GAP = 0.35; // Seconds between isolated flaps.
const N_A = 40; // Default-parameter flaps: only the built-in randomness varies.
const N_B = 12; // Flaps with a size / intensity / position sweep.
const T_B = N_A * GAP;
const T_BURST = T_B + N_B * GAP + 0.3;
const T_STEPS = T_BURST + 1.0;
const N_STEPS = 8;
const TOTAL = T_STEPS + N_STEPS * GAP + 0.3;

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.route('**/__audio_test.html', (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>audio test</title>' }));
await page.goto(`http://localhost:${port}/__audio_test.html`);

const res = await page.evaluate(async (c) => {
  const made = { n: 0 };
  const Real = window.AudioContext;
  window.AudioContext = class extends Real { constructor(...a) { super(...a); made.n++; } };
  const { createEngine, createAudio } = await import('/src/audio.js');

  const ctx = new OfflineAudioContext(2, Math.ceil(c.TOTAL * c.SR), c.SR);
  const eng = createEngine(ctx);
  const meta = { a: [], b: [], burst: [], steps: [] };
  for (let i = 0; i < c.N_A; i++) meta.a.push(eng.flap({}, i * c.GAP));
  for (let i = 0; i < c.N_B; i++) {
    const opts = { size: 0.5 + (i % 4) * 0.5, intensity: [0.4, 1, 1.6][i % 3], x: (i - 5.5) * 1.6, z: (i % 5) * 2 };
    meta.b.push({ opts, ...eng.flap(opts, c.T_B + i * c.GAP) });
  }
  for (let i = 0; i < 30; i++) {
    const r = eng.flap({ size: 0.7 + Math.random() * 0.8, intensity: 0.7 + Math.random() * 0.6, x: (i % 10 - 4.5) * 2, z: -4 - Math.floor(i / 10) * 2 }, c.T_BURST + i * 0.005);
    if (r) meta.burst.push(r);
  }
  for (let i = 0; i < c.N_STEPS; i++) meta.steps.push(eng.step(c.T_STEPS + i * c.GAP));
  const buf = await ctx.startRendering();
  const b64 = (f32) => {
    const u8 = new Uint8Array(f32.buffer);
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  };

  // Live path: calls before resume() must do nothing and must not make a context.
  const audio = createAudio();
  for (let i = 0; i < 5; i++) audio.flap({ x: i });
  audio.step();
  audio.setListener(1, 2);
  const madeBeforeResume = made.n;
  audio.resume();
  await new Promise((r) => setTimeout(r, 400));
  const t0 = performance.now();
  for (let i = 0; i < 60; i++) audio.flap({ x: (i % 9) - 4, z: -3 });
  const ms60 = performance.now() - t0;
  audio.step();
  await new Promise((r) => setTimeout(r, 500));
  return { L: b64(buf.getChannelData(0)), R: b64(buf.getChannelData(1)), meta, offline: eng.stats(),
    live: { madeBeforeResume, madeAfterResume: made.n, ms60, ...audio.stats() } };
}, { SR, GAP, N_A, N_B, T_B, T_BURST, T_STEPS, N_STEPS, TOTAL });
await browser.close();

const f32 = (s) => { const b = Buffer.from(s, 'base64'); return new Float32Array(b.buffer, b.byteOffset, b.length / 4); };
const L = f32(res.L);
const R = f32(res.R);
const db = (v) => 20 * Math.log10(Math.max(v, 1e-9));
const r1 = (v) => Math.round(v * 10) / 10;

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k), wi = Math.sin(ang * k);
        const a = i + k, b = a + len / 2;
        const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
      }
    }
  }
}

function analyse(t0, t1) {
  const i0 = Math.floor(t0 * SR), i1 = Math.floor(t1 * SR);
  let peak = 0, sq = 0;
  const win = SR / 1000;
  const env = [];
  for (let i = i0; i < i1; i += win) {
    let m = 0;
    for (let j = i; j < i + win && j < i1; j++) {
      const a = Math.max(Math.abs(L[j]), Math.abs(R[j]));
      m = Math.max(m, a);
      sq += (L[j] * L[j] + R[j] * R[j]) / 2;
    }
    env.push(m);
    peak = Math.max(peak, m);
  }
  const span = (thr) => { const on = env.findIndex((v) => v > thr); return on < 0 ? 0 : env.findLastIndex((v) => v > thr) - on + 1; };
  const N = 16384;
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < N && i0 + i < i1; i++) re[i] = (L[i0 + i] + R[i0 + i]) / 2;
  fft(re, im);
  let num = 0, den = 0, mid = 0, low = 0, top = 0;
  for (let k = 1; k < N / 2; k++) {
    const f = (k * SR) / N, p = re[k] * re[k] + im[k] * im[k];
    if (f < 20 || f > 20000) continue;
    num += f * p; den += p;
    if (f >= 800 && f <= 8000) mid += p;
    if (f < 300) low += p;
    if (f > 8000) top += p;
  }
  const activeMs = span(0.001);
  return { peakDb: db(peak), rmsDb: db(Math.sqrt(sq / Math.max(1, activeMs * win))), ms60dBFS: activeMs, ms40rel: span(peak * 0.01),
    centroid: num / den, mid: mid / den, low: low / den, top: top / den };
}
const stat = (xs) => {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return { min: r1(Math.min(...xs)), max: r1(Math.max(...xs)), mean: r1(m), sd: r1(Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length)) };
};
const summary = (rows) => ({ peakDb: stat(rows.map((r) => r.peakDb)), rmsDb: stat(rows.map((r) => r.rmsDb)),
  ms_to_minus60dBFS: stat(rows.map((r) => r.ms60dBFS)), ms_to_minus40dB_rel_peak: stat(rows.map((r) => r.ms40rel)),
  centroidHz: stat(rows.map((r) => r.centroid)), frac_800_8k: stat(rows.map((r) => r.mid * 100)),
  frac_below_300: stat(rows.map((r) => r.low * 100)), frac_above_8k: stat(rows.map((r) => r.top * 100)) });

const A = res.meta.a.map((m, i) => analyse(i * GAP, (i + 1) * GAP));
const B = res.meta.b.map((m, i) => ({ ...m.opts, voiceMs: Math.round(m.dur * 1000), ...analyse(T_B + i * GAP, T_B + (i + 1) * GAP) }));
const burst = analyse(T_BURST, T_BURST + 0.8);
const steps = res.meta.steps.map((m, i) => analyse(T_STEPS + i * GAP, T_STEPS + (i + 1) * GAP));
let peakAll = 0;
for (let i = 0; i < L.length; i++) peakAll = Math.max(peakAll, Math.abs(L[i]), Math.abs(R[i]));

const semis = res.meta.a.map((m) => m.semis);
const cents = A.map((a) => a.centroid);
const consecutive = res.meta.a.slice(1).map((m, i) => ({ dSemis: Math.abs(m.semis - res.meta.a[i].semis),
  sameGrains: JSON.stringify(m.grainTimes) === JSON.stringify(res.meta.a[i].grainTimes),
  dCentroid: Math.abs(cents[i + 1] - cents[i]) }));

const report = {
  overallPeakDbFS: r1(db(peakAll)),
  flaps40: { ...summary(A), voiceMs: stat(res.meta.a.map((m) => m.dur * 1000)), semitones: stat(semis),
    centroidSpreadSemitones: r1(12 * Math.log2(Math.max(...cents) / Math.min(...cents))),
    minConsecutiveSemitoneStep: r1(Math.min(...consecutive.map((c) => c.dSemis)) * 10) / 10,
    minConsecutiveCentroidStepHz: r1(Math.min(...consecutive.map((c) => c.dCentroid))),
    consecutiveIdenticalGrainTimings: consecutive.filter((c) => c.sameGrains).length },
  sizeIntensitySweep: B.map((b) => ({ size: b.size, intensity: b.intensity, x: r1(b.x), voiceMs: b.voiceMs, peakDb: r1(b.peakDb),
    rmsDb: r1(b.rmsDb), centroidHz: Math.round(b.centroid) })),
  burst30in150ms: { accepted: res.meta.burst.length, peakDb: r1(burst.peakDb), rmsDb: r1(burst.rmsDb), ms_to_minus60dBFS: burst.ms60dBFS,
    centroidHz: Math.round(burst.centroid), frac_800_8k: r1(burst.mid * 100) },
  steps: summary(steps),
  stepVsFlapRmsDb: r1(stat(steps.map((s) => s.rmsDb)).mean - stat(A.map((a) => a.rmsDb)).mean),
  offlineVoices: res.offline, live: res.live, pageErrors: errors,
};
const checks = {
  'peak <= -1 dBFS (no clipping)': report.overallPeakDbFS <= -1,
  'max voices <= 12 (offline and live)': res.offline.maxVoices <= 12 && res.live.maxVoices <= 12,
  'semitones within +-4': Math.max(...semis.map(Math.abs)) <= 4,
  'no two consecutive flaps identical': report.flaps40.minConsecutiveSemitoneStep >= 0.5 && report.flaps40.consecutiveIdenticalGrainTimings === 0,
  'voice length 80-220 ms': [...res.meta.a, ...res.meta.b, ...res.meta.burst].every((m) => m.dur >= 0.08 && m.dur <= 0.22),
  'energy mostly 800 Hz-8 kHz': report.flaps40.frac_800_8k.mean > 60,
  'steps at least 10 dB below flaps': report.stepVsFlapRmsDb <= -10,
  'no AudioContext before resume()': res.live.madeBeforeResume === 0 && res.live.madeAfterResume === 1,
  'no page errors': errors.length === 0,
};
report.checks = checks;

const pcm = Buffer.alloc(44 + L.length * 4);
pcm.write('RIFF', 0); pcm.writeUInt32LE(36 + L.length * 4, 4); pcm.write('WAVEfmt ', 8); pcm.writeUInt32LE(16, 16);
pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(2, 22); pcm.writeUInt32LE(SR, 24); pcm.writeUInt32LE(SR * 4, 28);
pcm.writeUInt16LE(4, 32); pcm.writeUInt16LE(16, 34); pcm.write('data', 36); pcm.writeUInt32LE(L.length * 4, 40);
for (let i = 0; i < L.length; i++) {
  pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[i])) * 32767), 44 + i * 4);
  pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[i])) * 32767), 46 + i * 4);
}
writeFileSync(join(outDir, 'flaps.wav'), pcm);
writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 1));
const ff = (args) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { cwd: outDir });
ff(['-i', 'flaps.wav', '-lavfi', 'showspectrumpic=s=1200x500', 'spec.png']);
// Zooms: three single flaps, and the burst, on a log frequency axis.
ff(['-ss', '0', '-t', '1.05', '-i', 'flaps.wav', '-lavfi', 'showspectrumpic=s=1200x500:fscale=log:win_func=hann', 'spec_zoom_flaps.png']);
ff(['-ss', String(T_BURST - 0.1), '-t', '0.6', '-i', 'flaps.wav', '-lavfi', 'showspectrumpic=s=1200x500:fscale=log:win_func=hann', 'spec_zoom_burst.png']);
console.log(JSON.stringify(report, null, 1));
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
