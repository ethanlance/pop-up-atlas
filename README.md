# Pop-up Atlas

A small paper traveller walks across an endless open pop-up book. Terrain ahead folds up out of the flat page on
springs; terrain behind folds back flat. Three.js, Blender-built tiles, procedural Web Audio.

## Run

```bash
npm install
npm run dev        # http://localhost:5183
```

Production build:

```bash
npm run build      # writes dist/
npm run preview    # serves dist/ on http://localhost:5184
```

Controls: **WASD / arrow keys** or **click / tap** to walk. Sound starts on the first key or click.
URL options: `?seed=7` (world seed), `?auto=1` (the traveller wanders by himself), `?q=low` (cheaper look).

## Rebuild assets (optional, needs Blender 5.x)

```bash
blender -b -P blender/build_tiles.py                     # public/assets/tiles.glb + tiles.json
blender -b -P blender/concept_scene.py -- --frame 1      # reference/concept/concept_01.png (target frames)
```

## Tools

- `node tools/shot.mjs --out captures/x.png --url '?auto=1&seed=7' --perf 10` — screenshot + frame-time probe (uses installed Chrome)
- `node tools/capture.mjs --seconds 30 --seed 7` — frame-exact gameplay capture to `captures/gameplay.mp4` (silent)
- `node tools/ab.mjs <round>` — blind A/B pairs vs the concept frames into `critic/round<N>/`
- `node tools/wfc_test.mjs`, `node tools/fold_test.mjs`, `node tools/trav_test.mjs --real`, `node tools/audio_test.mjs` — component checks

## Where things are

- `docs/ARCHITECTURE.md` contract, `docs/CHECKLIST.md` targets, `docs/LOG.md` append-only log with assumptions
- `critic/SCORES.md` blind-critic scores per round; `critic/round*/` pairs, keys and strips
- `reference/concept/` path-traced target frames; `reference/photos/` real photos with sources and licences
