# Pop-up Atlas — append-only log

## 2026-11-17 lead — kickoff, assumptions
- Project lives at ~/Work/pop-up-atlas (own repo, not inside t3).
- ASSUMPTION: Codex CLI is not installed and no image-generation key is present. The only other generator reachable
  (Figma AI) is a paid, company-plan feature the brief did not name, so it is not used. Concept frames are instead
  path-traced in Blender Cycles from the brief (tilt-shift papercraft, paper traveller, open book, lantern light).
  Paper textures and printed details are generated procedurally and baked in Blender.
- Reference photos: 12 freely licensed images from Wikimedia Commons, sources in reference/photos/SOURCES.md.
  Useful ones: ref01 (layered city pop-up), ref03 (cream paper box fold, visible hinge), ref07 (ship, paper edges),
  ref08 (layered floral cut silhouettes), ref11 (paper village from high angle), ref12 (tunnel-book layers).
- ASSUMPTION: "endless book" = one endless page surface with a gutter/crease motif; tiles are 2x2 units.
- ASSUMPTION: traveller walks on the flat page; pop-ups are obstacles or scenery; rivers block except at bridges.
- Playwright drives the installed Google Chrome (GPU) for captures and fps; no browser download.

## 2026-11-17 lead — phase A launched
- Stub verified in headless Chrome on the GPU (ANGLE Metal, Apple M3 Pro); frame rate there is uncapped.
- ASSUMPTION: this machine is faster than a "mid-range laptop", so the perf gate here is p95 frame <= 8 ms
  (2x headroom over the 16.7 ms budget) at 1440x900, plus <= 250 draw calls.
- Phase A sub-agents (own files each): concept frames, tiles+traveller glTF, WFC, audio, traveller/input/camera.
- Phase B (after tiles + WFC land): world/fold springs, look (light, shadow, tilt-shift). Then blind critic loops.

## 2026-11-17 22:54 UTC audio agent
- src/audio.js replaced: procedural Web Audio, contract unchanged. Extra exports for tests only: `createEngine(ctx, {rng, room})`
  (any BaseAudioContext; `flap(opts, when)`, `step(when)`), `MAX_VOICES`; `createAudio().stats()` → `{maxVoices, active}`.
- Flap = one looped grit-noise source → swept band-pass "fwip" + quiet wide "air" band + 3–6 random crinkle grains + stop tick,
  plus a small sine thud; 80–220 ms by size; ±4 semitones, never < 0.6 semitones from the previous flap; 0–25 ms start jitter.
- Master: bus → dry + 110 ms generated room (wet 0.3) → 55 Hz low cut → -4 dB high shelf → compressor → soft clip (ceiling -1.5 dBFS).
- Limits: 12 voices (steals lowest level x time-left), at most 28 starts per 100 ms (extra calls dropped), level falls with crowding.
- ASSUMPTION: pan and distance use a 9-unit scale (full pan at 9 units sideways, -6 dB at 9 units away).
- ASSUMPTION: main.js keeps calling `audio.resume()` from a pointer/key gesture; calls before that make no AudioContext.
- Test: `node tools/audio_test.mjs` (needs dev server) → tools/audio_render/{flaps.wav,spec*.png,report.json}; all checks pass.
  40 flaps: peak -10.6 dBFS max, RMS -28.1 dB mean, centroid 2793–4144 Hz (sd 306), 92 % of energy in 800 Hz–8 kHz.
  Burst of 30 in 150 ms: peak -10.7 dBFS, max 12 voices. Steps 16 dB below flaps.

## 2026-11-17T23:02Z wfc agent
- src/wfc.js replaced (was a stub); tools/wfc_test.mjs added. `node tools/wfc_test.mjs [--map-seed N]` passes on the built-in
  fallback tile set: 0 socket mismatches over 208,080 cells (5 seeds x 204x204), order-independent, identical after
  cache eviction, max tile 30.6 % (meadow), chunk solve avg 0.08 ms / p99 0.12 ms / max 0.7 ms, get() amortised 0.003 ms.
- Algorithm: 8x8 chunks, cell (0,0) in the middle of chunk (0,0). Chunk-border sockets = contour crossings of seeded
  low-frequency noise sampled at chunk corners (one field for rivers, one for paths), so rivers/roads are long curves and
  every chunk has 0/2/4 crossings. Inside a chunk: seeded meandering routes join the crossings (paths cross rivers only
  on a bridge, extra roads join at T junctions, short spurs end in path_end), then WFC (min-domain cell, weighted pick,
  propagation, backtracking, up to 6 restarts with a derived seed) fills all cells with border + route edges fixed.
  Weights are biased by biome noise (hill / forest / meadow regions, houses beside roads in village patches).
- ASSUMPTION: public/assets/tiles.json did not exist during this work. The test runs a second suite on it automatically
  once it exists; rerun it then. Histogram and the 35 % cap depend on the real weights.
- ASSUMPTION: socket 'g' = grass, 'p' = path, 'r' = river; a missing `weight` = 1, missing `rotations` = [0,1,2,3];
  `weight` is per tile and split evenly over its rotations. Tiles with weight <= 0 are never used.
- ASSUMPTION: biome bias classifies all-grass tiles by id substring (hill|mount|rock.., forest|tree|wood.., house|cottage|mill..,
  meadow|grass|field..; anything else is neutral). Tiles agent: keep those words in ids, or tell me the names.
- Needs from the tile set for full features: an all-grass tile; river straight + corner (else no rivers); path straight +
  corner + end (else no paths); bridge with r on two opposite sides and p on the other two (else roads stop at rivers);
  path T (else no junctions/spurs). Missing pieces switch that feature off for the whole world instead of failing.
- Relaxation differs from the brief on purpose: a chunk that fails 6 times falls back to minimal routes with the SAME
  border sockets (always solvable when the pieces above exist), not to grass borders, because a neighbour cannot know
  that this chunk relaxed without solving it. Border sockets go to grass only world-wide, when the tile set lacks the pieces.
- get() returns shared frozen objects ({id, rot}); do not mutate them. Extra debug method `stats()` on the returned object.
- createWFC solves the 3x3 chunks around spawn up front (about 1 ms). Spawn chunk has no river; a road runs through (0,0).

## 2026-11-17 23:10 UTC tiles agent — v0 READY (contract-valid, look still being refined)
- `public/assets/tiles.glb` (2.6 MB) + `tiles.json` written by `blender -b -P blender/build_tiles.py` (5 s, re-runnable).
- 34 tiles: every one of the 24 g/p/r socket necklaces has at least one tile, so WFC can never dead-end.
  Ids and sockets will stay stable; only art and flap detail change from here.
- Each `tile_<id>` has `base` + `flap_*` children (nested where real: roofs on side walls, struts on hill layers).
  Flap extras: foldAngle (mostly +-PI/2; roofs +-PI/4, struts -PI/6), delay, mass. Rest pose = popped.
- ASSUMPTION (traveller): card figure faces local +X, card normal is local Z, so limbs swing with rotation.z.
  All traveller part nodes have identity rotation; origins: body = hip (y 0.235), legL/legR = hip, armL/armR = shoulder
  (y 0.385), stand = ground. To face a heading (hx, hz): root.rotation.y = atan2(-hz, hx). Paper-Mario style
  (keep the card facing the camera, flip scale.x) also works.
- ASSUMPTION (walkability): tiles with both river and path sockets are bridge-class: `blocked: false` with obstacle
  circles along the water. Pure river tiles are `blocked: true`. The bridge deck is printed on the page between two
  pop-up parapets, so the traveller crosses at y = 0.
- One material, two UV sets: TEXCOORD_0 = albedo atlas, TEXCOORD_1 = tiling fibre normal map (three sets texture.channel).

## 2026-11-17 23:15 UTC concept agent
- Wrote `blender/concept_scene.py` (one script, `blender -b -P blender/concept_scene.py -- --frame N [--draft]`) and
  rendered `reference/concept/concept_01.png` … `concept_05.png` (1600x900, Cycles on Metal GPU, 320 samples + OIDN,
  about 30–60 s each). Low-sample drafts of the last round are in `reference/concept/drafts/`.
- Three draft rounds were critiqued against ref01/03/07/08/11/12. Fixes: exposure -1 EV and muted ochre/terracotta
  (first round was pastel and overexposed), traveller leaned back 20 deg so it reads from a 50 deg camera, printed
  ink lines on hills/roofs/bridge, lighter cut-edge core, hero reframed to show gutter + page edge + table.
- ASSUMPTION: 1 world unit is about 3 cm (traveller 1.65 cm). Depth of field uses Blender f-stops 0.05–0.5 at
  1 unit = 1 m, which equals f/1.7–f/17 on a 100 mm macro lens at that scale.
- ASSUMPTION: camera white balance 3900 K, so the 3000 K key renders warm amber and not full orange.
- ASSUMPTION: the concept book is 8 x 6 tiles (16.8 x 12.8 units with margin), gutter at x = 0. The layout is hand
  placed, not WFC output. Printed river, path, tufts, contour lines and tile score lines are one 4096 px page image.
- ASSUMPTION: a face tint `#E2B588` (light ochre) is used for the traveller; it is the ochre hue, not a ninth hue.
- Blender axes are Z up; Blender (x, y, z) = three.js (x, z, -y). Numbers for the look agent are in the report.
- Known gaps: pop-ups carry only simple printed lines, no fold struts or V-fold mechanics, card is too flat and
  clean compared with the photos, and an upright traveller cannot be fully sharp with true DOF at this pitch.

## 2026-11-17 23:20 UTC tiles agent — v1 (ids, sockets and node layout unchanged from v0)
- CORRECTION to the v0 note: traveller joints moved. body/legL/legR origin y = 0.19 (hip), armL/armR origin y = 0.33
  (shoulder), legs offset x = -0.016 / +0.016, total height 0.552. Read the node translations, do not hard-code.
- 34 tiles, 229 flaps, max 710 tris per tile, glb 2.58 MB (2 JPEG textures). Roofs now fold 3*PI/4 onto their wall.
- Each hinge is shifted by its flat-stack offset, so popped cards stand exactly on their design line and the fully
  folded tile is a clean stack (highest stack 0.11 on the house tiles). Mid-fold, house walls pass through each other.
- Checks: `python3 blender/tiles_validate.py` (contract, tris, 24/24 socket necklaces) and
  `blender -b -P blender/preview_tiles.py -- --fold 0|0.5|1 [--neighbours] [--tiles a,b]` (renders the glb re-imported).
  `node tools/wfc_test.mjs` passes on the real tiles.json. Debug atlas: blender/tiles_out/atlas.png.
- Not checked: the look in the real three.js scene (world.js was still a stub), and fibre visibility at a 200 px crop there.

## 2026-11-17 23:50 UTC look agent
- `src/look.js` replaced; new files `src/look_shadow.js` (PCSS), `src/look_shaders.js` (passes), `src/look_debug.js`
  (test cards, only with `?lookdebug=1`). Contract unchanged: `createLook({renderer, scene, camera})` → `{render, resize, setFocus}`.
- Frame: shadow map 2048 → scene into an HDR half-float target (MSAA 4, depth texture) → half-res AO from depth →
  half-res colour + signed CoC → 44-tap golden-angle bokeh gather → 3x3 tent → 3-level bloom → composite (3x3 tent on
  the sharp image, lamp falloff, AgX + contrast 1.22, sRGB, vignette 20 %, grain sigma 0.011 at 24 Hz). 10 full-screen draws.
- Lights: key directional 5.6 x (1.0, 0.77, 0.50) from (-0.719, 0.530, 0.449), shadows; fill 0.10 x (0.27, 0.443, 1.0)
  from (0.360, 0.883, -0.302); low warm bounce 0.8 from (0.80, 0.14, -0.50) so card backs are not black; hemisphere 0.22.
- GLOBAL PATCH: `THREE.ShaderChunk.shadowmap_pars_fragment` — the BasicShadowMap `getShadow` is replaced by PCSS
  (16-tap blocker search, 16-tap filter interleaved over 2x2 pixels, receiver-plane depth bias). `renderer.shadowMap.type`
  is BasicShadowMap on purpose. `shadow.radius` carries the penumbra scale. Every lit material gets it; no material edits.
- Shadow camera: square ortho fitted to the visible page (0..1.7 high), size in 2-unit steps, centre snapped to texels.
- CoC = gain x (1 - focusDepth/depth), plane through the `setFocus` point, perpendicular to the view axis. The gain is
  calibrated each frame so the page at the top/bottom frame edge gets 3 % of frame height (27 px at 900); a knee keeps
  about 20 % of the height sharp. This holds for any camera pitch/FOV/distance the camera agent picks.
- `renderer.info.autoReset = false`; look resets it once per frame, so `stats().calls` counts all passes (27 now).
- ASSUMPTION: the key lamp falloff is a post term (inverse square from a lamp 14 units along the key direction, clamp
  0.3..1.6, 80 % mix), not a real point light. It dims ambient and key alike.
- ASSUMPTION: the table (procedural wood, y = -0.12) only shows where the world leaves the page open; today the page
  covers the view, so the table is never seen. Fog 45..110 to the table colour.
- URL tuning params (debug, no UI): q=low, key, fill, bounce, amb, soft, exp, con, sat, blur, band, bloom, bloomthr, vig,
  grain, pool, lamp, ao, aor, dof, msaa, smap, btaps, ftaps, dtaps, lookdebug.
- Perf (1440x900, `?auto=1&seed=7`, machine load average 6–12 from other agents): avg 150–390 fps; p95 6.7 ms in the best
  run, 13–32 ms in others. Standing still: p50 2.8 ms, p95 6.0 ms. The walking spikes stay at 360x225 (p95 13.8 ms) and
  with q=low, and drop with a 256 px shadow map (p95 7.4 ms): they follow the 245k triangles drawn twice (shadow + main)
  with dynamic buffer uploads, not the post passes. The 8 ms gate is NOT proven; measure again on a quiet machine.

## 2026-11-17 23:54 UTC world agent
- `src/world.js`, `src/fold.js` replaced; `tools/fold_test.mjs` added (`node tools/fold_test.mjs`, needs the dev server; PASS).
  Contract unchanged. Extra debug-only members on the world object: `debugState()`, `debugFlapTrace()`,
  `debugTraceResult()`, `debugTile(cx,cz)`, `debugSet({nudge, visible})`, `debugReset()`, `debugTopDown(renderer, {x,z,span})`, `debugGroup`.
- Rendering: all tiles of a 19 x 15 cell window are ONE Mesh (1 draw call per pass, about 123k triangles), plus a page
  frame beyond the window and a gutter strip (crease every 8 cells, on the cell edge x = 16k - 1). Vertices are stored
  once in the popped pose with their hinge lines; a small vertex-shader patch (`onBeforeCompile`, and a patched
  `customDepthMaterial` for the shadow pass) folds them from two uniform arrays. No vertex or texture upload per frame.
  LOOK AGENT: the mesh named `tiles` only folds with its own material / customDepthMaterial. A `scene.overrideMaterial`
  pass would draw every flap popped. Tell me if you need one and I will expose the patch.
- Rejected after measuring: BatchedMesh (per-frame matrix texture) and CPU-transformed vertices. On ANGLE/Metal the
  per-frame texSubImage2D / bufferSubData blocked the main thread (80 % and 68 % of profile time) and made rAF pacing
  bursty (p95 10-35 ms, p99 45-140 ms at the same average). The uniform version paces like a static scene.
- Fold spring (fold.js): fixed 1/240 s substeps. Rise = stiff lightly damped spring following a target that
  accelerates flat -> up and stops dead; fall = softer spring aimed just under the page, clamped at flat, one small bounce.
  A plain step-driven spring cannot give rise >= 0.45 s, 2-3 wobbles and settle < 1.4 s together.
  Measured in the page: mass 0.53 rise 0.46 s / overshoot 9.6 % / 3 wobbles / settle 0.89 s; mass 1.06 0.54 s / 12.8 % / 3 / 1.06 s;
  mass 2 0.61 s / 16.1 % / 3 / 1.25 s. Fall lands in 0.19-0.27 s with a 1.1-1.2 % bounce. Same numbers at 30/60/144 Hz.
- Region: egg shape, 5.5 cells ahead / 3 cells side and behind, fold-down radii +1 cell; heading low-passed (0.45 s);
  region grows from the traveller over 1.3 s after start or teleport. Flap starts are rate limited (160 rises/s,
  70 falls/s) so audio stays under 28 starts per 100 ms: measured peak 26-27 while walking, 17-19 in the start burst.
- ASSUMPTION (rotation): WFC rotations that give the same sockets are drawn at the smallest such rotation (all-grass
  tiles always rot 0, straights 0 or 1). Sockets still match; pop-ups then face the fixed camera instead of standing
  edge-on. isWalkable uses the same drawn rotation. Rotation k is rotation.y = -k*PI/2, (x,z) -> (-z,x) per step.
- ASSUMPTION: a tile root's own transform is ignored; node names are matched by prefix (`tile_`, `base`, `flap`)
  because GLTFLoader renames duplicates (`base_1`, `flap_tuft_0_9`). At most two nested fold levels are animated.
- ASSUMPTION: flat flaps are lifted by 4 mm per overlap layer (per-tile bounding-box test) so stacked flat cards never
  share a plane; the lift fades out as the flap rises.
- Perf at 1440x900 with the current look: 250-273 fps avg, p95 6.3-6.5 ms, 27 calls, 244k tris; world.update CPU avg 0.03 ms.
  The p95 gate is sensitive to other GPU jobs on this machine (same build read 8.4-9.5 ms while other agents rendered).
- TILES AGENT: on tiles drawn at rot 1 or 3 (east-west paths and rivers, corners) every flap stands edge-on to the
  camera, because hinges are along local X. Free-standing props on those tiles (flowers, tufts, milestones, reeds) would
  read better with hinges authored at 45 degrees or as V-folds. Card back faces render almost black when lit from behind.
