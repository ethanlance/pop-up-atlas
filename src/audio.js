// Procedural paper sounds for Pop-up Atlas. No samples, no network.
// createEngine(ctx) accepts any BaseAudioContext, so tools/audio_test.mjs renders the same graph offline.

export const MAX_VOICES = 12;
const CEILING = 0.84; // Hard output ceiling of the soft clipper (-1.5 dBFS).
const BURST_CAP = 28; // Most voice starts accepted in any 100 ms window.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Gritty noise: white noise with a fast random amplitude, like fibres that rub.
function makeGritBuffer(ctx, rng, seconds, grit) {
  const n = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let hold = 0;
  let amp = 1;
  for (let i = 0; i < n; i++) {
    if (hold-- <= 0) {
      hold = Math.floor(ctx.sampleRate * (0.0002 + rng() * 0.0025));
      amp = 1 - grit + grit * rng() * rng() * 2.2;
    }
    d[i] = (rng() * 2 - 1) * amp;
  }
  return buf;
}

// Short warm room: a few early reflections and a dark 90 ms tail.
function makeRoomBuffer(ctx, rng) {
  const sr = ctx.sampleRate;
  const n = Math.floor(sr * 0.11);
  const buf = ctx.createBuffer(2, n, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      lp += 0.28 * ((rng() * 2 - 1) - lp);
      d[i] = t < 0.004 ? 0 : lp * 0.5 * Math.exp(-t / 0.022);
    }
    for (let k = 0; k < 6; k++) {
      const t = 0.006 + k * 0.0065 + rng() * 0.005;
      const i = Math.floor(t * sr);
      const a = 0.5 * Math.exp(-t / 0.03) * (rng() < 0.5 ? -1 : 1);
      d[i] += a;
      d[i + 1] += a * 0.6;
      d[i + 2] += a * 0.25;
    }
  }
  return buf;
}

function makeClipCurve() {
  const n = 4097;
  const knee = 0.5;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const a = Math.abs(x);
    const y = a <= knee ? a : knee + (CEILING - knee) * Math.tanh((a - knee) / (CEILING - knee));
    curve[i] = Math.sign(x) * y;
  }
  return curve;
}

export function createEngine(ctx, { rng = Math.random, room = true } = {}) {
  const noise = [0.55, 0.75, 0.35].map((grit) => makeGritBuffer(ctx, rng, 1.5, grit));

  // Master chain: bus -> (dry + room) -> warm EQ -> compressor -> soft clip -> out.
  const bus = ctx.createGain();
  const sum = ctx.createGain();
  bus.connect(sum);
  if (room) {
    const conv = ctx.createConvolver();
    conv.normalize = false;
    conv.buffer = makeRoomBuffer(ctx, rng);
    const wet = ctx.createGain();
    wet.gain.value = 0.3;
    bus.connect(conv).connect(wet).connect(sum);
  }
  const lowCut = ctx.createBiquadFilter();
  lowCut.type = 'highpass';
  lowCut.frequency.value = 55;
  const warm = ctx.createBiquadFilter();
  warm.type = 'highshelf';
  warm.frequency.value = 6500;
  warm.gain.value = -4;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -20;
  comp.knee.value = 14;
  comp.ratio.value = 5;
  comp.attack.value = 0.002;
  comp.release.value = 0.12;
  const post = ctx.createGain();
  post.gain.value = 0.5;
  const clip = ctx.createWaveShaper();
  clip.curve = makeClipCurve();
  sum.connect(lowCut).connect(warm).connect(comp).connect(post).connect(clip).connect(ctx.destination);

  let lx = 0;
  let lz = 0;
  let lastSemis = 99;
  let lastBuf = -1;
  let stepSide = 1;
  let maxVoices = 0;
  let voices = [];
  let starts = [];

  // Frees a slot when all 12 are busy. It fades the voice with the least audible energy left.
  function admit(now) {
    voices = voices.filter((v) => v.end > now);
    starts = starts.filter((t) => t > now - 0.1);
    if (starts.length >= BURST_CAP) return false;
    while (voices.length >= MAX_VOICES) {
      let pick = 0;
      let best = Infinity;
      voices.forEach((v, i) => {
        const left = clamp((v.end - now) / (v.end - v.start), 0, 1);
        if (v.level * left < best) {
          best = v.level * left;
          pick = i;
        }
      });
      const v = voices.splice(pick, 1)[0];
      v.out.gain.cancelScheduledValues(now);
      v.out.gain.setTargetAtTime(0, now, 0.004);
      for (const s of v.sources) s.stop(now + 0.03);
    }
    starts.push(now);
    return true;
  }

  function track(out, sources, start, end, level) {
    voices.push({ out, sources, start, end, level });
    maxVoices = Math.max(maxVoices, voices.length);
    sources[0].onended = () => out.disconnect();
  }

  function flap({ size = 1, intensity = 1, x = 0, z = 0 } = {}, when = ctx.currentTime) {
    if (!admit(when)) return null;
    size = clamp(size, 0.3, 3);
    intensity = clamp(intensity, 0.05, 2);

    // Random pitch within +-4 semitones. It always moves at least 0.6 semitones from the last flap.
    let semis = rng() * 8 - 4;
    if (Math.abs(semis - lastSemis) < 0.6) semis = semis > 0 ? semis - 1.3 : semis + 1.3;
    lastSemis = semis;
    let bufIdx = Math.floor(rng() * noise.length);
    if (bufIdx === lastBuf) bufIdx = (bufIdx + 1) % noise.length;
    lastBuf = bufIdx;

    const pf = Math.pow(2, semis / 12) / Math.sqrt(size);
    const bright = 0.7 + 0.3 * intensity;
    const dur = clamp(0.125 * Math.pow(size, 0.65) * (0.85 + rng() * 0.3), 0.08, 0.22);
    const t = when + 0.004 + rng() * 0.025;
    const atk = 0.002 + rng() * 0.004;
    const crowd = 1 / Math.sqrt(1 + 0.3 * (starts.length - 1));
    const dist = Math.hypot(x - lx, z - lz);
    const level = 0.5 * Math.pow(intensity, 1.2) * crowd / (1 + dist / 9);

    const out = ctx.createGain();
    out.gain.value = level;
    const pan = ctx.createStereoPanner();
    pan.pan.value = clamp((x - lx) / 9, -1, 1) * 0.8;
    out.connect(pan).connect(bus);

    const src = ctx.createBufferSource();
    src.buffer = noise[bufIdx];
    src.loop = true;
    src.playbackRate.value = 0.8 + rng() * 0.45;

    // "Fwip": band-passed noise that sweeps while the card pushes air.
    const fc = 2700 * pf * bright;
    const down = rng() < 0.25;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.6 + rng() * 0.9;
    bp.frequency.setValueAtTime(fc * (down ? 1.8 : 0.4), t);
    bp.frequency.exponentialRampToValueAtTime(fc * (down ? 0.7 : 1.7), t + dur * 0.55);
    bp.frequency.exponentialRampToValueAtTime(fc * (down ? 0.45 : 1.1), t + dur);
    const fwip = ctx.createGain();
    fwip.gain.setValueAtTime(0, t);
    fwip.gain.linearRampToValueAtTime(0.7, t + atk);
    fwip.gain.linearRampToValueAtTime(1, t + dur * 0.4);
    fwip.gain.setTargetAtTime(0, t + dur * 0.55, dur * 0.1);
    src.connect(bp).connect(fwip).connect(out);
    // Air: a quiet wide band under the sweep, so the burst is not a narrow whistle.
    const air = ctx.createBiquadFilter();
    air.type = 'highpass';
    air.frequency.value = 1100 * pf;
    const airGain = ctx.createGain();
    airGain.gain.value = 0.2;
    src.connect(air).connect(airGain).connect(fwip);

    // Crinkle: random micro-grains, plus one tick when the card hits its stop.
    const stopAt = t + dur * (0.6 + rng() * 0.08);
    const grains = [];
    const count = 3 + Math.floor(rng() * 4) + Math.round(size - 1);
    for (let i = 0; i < count; i++) {
      grains.push({ t: t + dur * (0.08 + rng() * 0.62), a: (0.45 + rng() * 0.6) * bright, len: 0.0015 + rng() * 0.004 });
    }
    grains.push({ t: stopAt, a: 1.0, len: 0.007 });
    grains.sort((a, b) => a.t - b.t);
    const hi = ctx.createBiquadFilter();
    hi.type = 'bandpass';
    hi.Q.value = 0.8;
    hi.frequency.value = 5200 * Math.sqrt(pf) * bright;
    const crinkle = ctx.createGain();
    crinkle.gain.setValueAtTime(0.0001, t);
    let free = t;
    for (const g of grains) {
      if (g.t < free) continue;
      crinkle.gain.setValueAtTime(0.0001, g.t);
      crinkle.gain.linearRampToValueAtTime(g.a, g.t + 0.0004);
      crinkle.gain.exponentialRampToValueAtTime(0.0001, g.t + g.len);
      free = g.t + g.len + 0.001;
    }
    src.connect(hi).connect(crinkle).connect(out);

    // Thud: a short low knock at the stop.
    const f0 = 165 * Math.sqrt(pf) * (0.9 + rng() * 0.2);
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(f0, stopAt);
    osc.frequency.exponentialRampToValueAtTime(f0 * 0.55, stopAt + 0.035);
    const thud = ctx.createGain();
    thud.gain.setValueAtTime(0, stopAt);
    thud.gain.linearRampToValueAtTime(0.07 * Math.sqrt(size), stopAt + 0.002);
    thud.gain.setTargetAtTime(0, stopAt + 0.004, 0.008);
    osc.connect(thud).connect(out);

    const end = t + dur + 0.05;
    src.start(t, rng() * 1.2);
    src.stop(end);
    osc.start(stopAt);
    osc.stop(end);
    track(out, [src, osc], when, end, level);
    return { t, dur, semis, bufIdx, grainTimes: grains.map((g) => g.t - t), level };
  }

  // Footstep: a very soft paper tap, far below the level of a flap.
  function step(when = ctx.currentTime) {
    if (!admit(when)) return null;
    const t = when + 0.002;
    const level = 0.16 * (0.8 + rng() * 0.4);
    stepSide = -stepSide;
    const out = ctx.createGain();
    out.gain.value = level;
    const pan = ctx.createStereoPanner();
    pan.pan.value = stepSide * 0.12;
    out.connect(pan).connect(bus);

    const src = ctx.createBufferSource();
    src.buffer = noise[Math.floor(rng() * noise.length)];
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.2;
    bp.frequency.value = (stepSide > 0 ? 1250 : 1050) * (0.88 + rng() * 0.24);
    const tap = ctx.createGain();
    tap.gain.setValueAtTime(0, t);
    tap.gain.linearRampToValueAtTime(1, t + 0.002);
    tap.gain.setTargetAtTime(0, t + 0.003, 0.009);
    src.connect(bp).connect(tap).connect(out);

    const osc = ctx.createOscillator();
    const f0 = 120 * (0.9 + rng() * 0.2);
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(f0 * 0.6, t + 0.03);
    const thump = ctx.createGain();
    thump.gain.setValueAtTime(0, t);
    thump.gain.linearRampToValueAtTime(0.06, t + 0.002);
    thump.gain.setTargetAtTime(0, t + 0.003, 0.01);
    osc.connect(thump).connect(out);

    const end = t + 0.08;
    src.start(t, rng() * 1.2);
    src.stop(end);
    osc.start(t);
    osc.stop(end);
    track(out, [src, osc], when, end, level);
    return { t, level };
  }

  return {
    flap,
    step,
    setListener(x, z) {
      lx = x;
      lz = z;
    },
    stats: () => ({ maxVoices, active: voices.length }),
  };
}

export function createAudio() {
  let ctx = null;
  let engine = null;
  let lx = 0;
  let lz = 0;
  const live = () => engine !== null && ctx.state === 'running';
  return {
    // Call from a user gesture. Calls before the context runs are dropped.
    resume() {
      if (!ctx) {
        const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
        if (!AC) return;
        try {
          ctx = new AC({ latencyHint: 'interactive' });
          engine = createEngine(ctx);
          engine.setListener(lx, lz);
        } catch {
          ctx = null;
          engine = null;
          return;
        }
      }
      if (ctx.state !== 'running') ctx.resume().catch(() => {});
    },
    flap(opts) {
      if (live()) engine.flap(opts);
    },
    step() {
      if (live()) engine.step();
    },
    setListener(x, z) {
      lx = x;
      lz = z;
      if (engine) engine.setListener(x, z);
    },
    stats: () => (engine ? engine.stats() : { maxVoices: 0, active: 0 }),
  };
}
