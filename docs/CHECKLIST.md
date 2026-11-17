# Component checklist with measurable targets (from reference study)

| # | Component | Owner files | Measurable target |
|---|---|---|---|
| 1 | Concept frames (target look) | blender/concept_*.py, reference/concept/ | 5 Cycles frames, 1600x900, tilt-shift DOF, warm key ~3000K + cool fill, open book visible |
| 2 | Tiles + traveller models | blender/build_tiles.py, public/assets/tiles.* | >= 16 tile types (hill, tree, house, bridge, river, path sets); every flap has hinge origin + extras; card thickness 0.012–0.02; glb <= 6 MB |
| 3 | Paper material | (in 2) | roughness >= 0.85; fibre visible at 200 px crop; palette <= 8 hues, warm; lighter cut-edge core visible; printed details on base pages |
| 4 | WFC | src/wfc.js, tools/wfc_test.mjs | 0 socket mismatches over 40k cells, 5 seeds; deterministic; get() avg < 0.05 ms; no single tile > 35 % |
| 5 | Fold motion | src/world.js, src/fold.js | rise 0.45–0.8 s; overshoot 8–18 %; 2–3 visible wobbles; settle < 1.4 s; staggered by delay; fold-back behind; no popping |
| 6 | Traveller + controls + camera | src/traveller.js, input.js, cameraRig.js | WASD + click-to-walk; speed ~2.2 u/s; hop cycle synced to steps; turn < 0.2 s; camera lag 0.25–0.4 s, no jitter; cannot enter blocked cells |
| 7 | Look: light, shadow, DOF | src/look.js | high-angle 50–60 deg; focus band ~25 % of frame height sharp, blur radius >= 8 px at top/bottom edges; warm key + cool fill; soft contact shadows between layers |
| 8 | Audio | src/audio.js | one flap sound per flap, pitch varies +-4 semitones, no two consecutive identical; <= 12 voices; no clipping; footsteps soft |
| 9 | Performance | all | 1440x900: avg >= 60 fps, p95 frame <= 16.7 ms, draw calls <= 250 |
| 10 | Blind A/B vs reference | critic/ | critic picks the reference <= 60 % of trials and rates wow >= 8/10 |
