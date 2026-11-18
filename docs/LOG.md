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

## 2026-11-17 23:59 UTC traveller agent
- Replaced the stubs: `src/input.js`, `src/traveller.js`, `src/cameraRig.js`. Added `tools/trav_test.mjs`
  (`node tools/trav_test.mjs [--real] [--auto 40] [--shots] [--shots-only]`, 32 checks, all pass; it stubs the Vite
  client so hot reloads from other agents' edits cannot restart the page mid-run).
- Measured (headless Chrome, Metal, 60 Hz): walk speed 2.20 u/s; 95 % speed in 0.10 s; 3.6 footfalls/s (17 in 5 s
  from rest); hop apex 0.060; landing squash 5.5 %; facing flip 0.083 s with 15 % overshoot; click-to-walk arrival
  error 0.009-0.014 u on a straight line; camera step response 63 % at 0.30 s (50 % 0.23 s, 90 % 0.55 s, no
  overshoot); camera velocity deviation while walking 0.03-0.05 %; pitch 54.5 deg; 18.4 units across at 16:9.
- Camera follow is an exact critically damped step that accounts for the target's velocity, so it is frame-rate
  independent: an offline run at 144 Hz, 60 Hz, 20 Hz and random 4-50 ms steps gives the same lead (0.6714 u) and a
  velocity error below 1e-12 u/s. NOT measured in the browser at other frame rates (CPU throttling did not change the
  60 Hz frame time).
- Auto mode: 40 s covers 87-88 u of path (limit is 88) on the open, synthetic and real worlds; real world seed 1 nets
  59 u forward in 40 s; seeds 2, 3, 7 ran 150 s each with 296-317 u of path and 162-172 u forward, crossing rivers at
  bridges, never inside a blocked position. Route search costs 0.8-2 ms median every 0.5 s, 4-12 ms on the first.
- Collision: bisect to the surface, axis slide, then a tangent slide from a sampled obstacle normal; head-on at a convex
  obstacle steps round it, a wall or concave corner holds still (0 frame-to-frame movement, 0 reversals).
- ASSUMPTION: the card turns at most 40 deg from camera-facing (full turn would put it edge-on to the camera when
  walking up or down the page); it mirrors by a 180 deg springy flip for left/right.
- ASSUMPTION: the card rests tilted back 0.3 rad (as in the concept frames) so its face reads from the 55 deg camera.
- ASSUMPTION: when walking straight up or down the page the card shows the side that turns towards the strongest
  DirectionalLight in the scene (read from the scene every 1.5 s); without one it keeps its last facing.
- ASSUMPTION: the stand hops with the figure but does not lean; the card above it leans and wobbles on the tab.
- ASSUMPTION: the pencil mark stays while a click-walk is active and fades on arrival or cancel (6 s at most); it is
  hidden while the pointer is held. Under the tilt-shift blur it is only legible near the focus band.
- Extras beyond the contract (read-only, used by tools): `input.camera`, `input.target`, `input.markerPos`,
  `input.markerAge`, `input.held`, `input.planMs`, `input.walkable` (installed by the traveller on its first update);
  `traveller.speed`, `.yaw`, `.steps`, `.hop`, `.squash`. Auto state resets on `setAuto(true)` or a teleport > 2 u.
- The procedural fallback figure stays in traveller.js and is used when the glb has no `traveller` node; the glb node
  (faces +X, normal Z, identity part rotations) is used as authored, no changes needed from the tiles agent.
- For the lead / look agent: at 18.4 units across the traveller is about 45 px tall at 1440 wide. The spec floor is
  9 cells; a closer camera needs a contract change. DISTANCE and PITCH are constants at the top of cameraRig.js.

## 2026-11-18 lead — integration, camera change, critic round 1
- All seven components integrated and committed (a5f259f). Quiet-machine perf: p95 4.3–6.3 ms, 27 draw calls, 245k tris.
- CONTRACT CHANGE (lead): camera DISTANCE 21 -> 13 (about 11.5 units across). Reason: at 18.6 units across the traveller
  was ~40 px and cards could not show thickness; concept frames see 4.5–12.6 units. World rise region must follow.
- Known gaps before critic: page mottling too grey/dirty vs concept cream; pale card colours; edge-on small flaps on
  rotated tiles; near-black card backs; flat printed bridge deck; house walls intersect mid-fold.
- Blind A/B round 1 built with tools/ab.mjs (random left/right, key in critic/round1/key.json, critic may not read it).

## 2026-11-18 lead — critic round 1 result and routing
- Blind critic: candidate 3.2 vs reference 7.3, reference identified 4/4, motion 3/10. Full text summarised in critic/SCORES.md.
- Camera DISTANCE 13 -> 9.5 (~8.4 units across), LOOK_AHEAD 1.3 -> 1.1 (lead).
- Routed: tiles (clean cream page, saturated palette, bigger layered pieces, no edge-on hinges, bolder traveller, lit backs,
  raised bridge), look (lighter cool shadows, wider sharp band, capped blur, warm/cool split, stable focus, two-sided light),
  world (rise region inside the new frame and sharp band, visible hinge rotation, no in-frame spawn/despawn).

## 2026-11-18 00:12 UTC look agent — round 2 (critic fixes)
- Shadows: key raised to 40 deg elevation (same azimuth), dir (-0.650, 0.643, 0.406); key 4.4, cool fill 0.75 x
  (0.47, 0.64, 1.0), hemisphere 0.5 with a cooler sky. A shadowed cream page measures 55 % of the lit page (115 vs 209).
  Key angular size 0.16 rad, minimum filter radius 3 shadow texels. AO radius 0.32 -> 0.16 units (tight fold line).
- DOF: sharp-band knee 0.85 % of frame height (about 38 % of the height stays sharp), CoC capped at 1.65 % of the
  height (15 px at 900). Focus depth is low-passed (0.45 s, snaps on jumps > 4 units). The CoC gain is fitted to the depth at
  the frame centre, not to the traveller, so it is constant for a fixed rig: no pumping.
- GLOBAL PATCH 2: `THREE.ShaderChunk.lights_physical_pars_fragment` (RE_Direct_Physical) adds paper translucency: a face
  turned away from a directional light gets 30 % of that light, warm tinted, diffuse only. Shadow bias is now 0.034 units
  (more than one card thickness) so the back of a lit card is not shadowed by the card itself; a second card still blocks.
- Tone: exposure 0.8, contrast 1.34, vignette 13 %. Lamp falloff: lamp 5 units along the key direction, full mix,
  clamp 0.28..1.35; frame corners away from the lamp measure about 1 stop under the centre.
- Perf, three runs of the gate command at load average 6: p95 7.3, 6.4, 6.6 ms; 26 draw calls; 119k tris.
- NEED from world agent for the table/page edge: the page mesh is 480 units and follows the traveller, so the table
  (y = -0.12, look.js) is never visible. A finite page (or a page-edge position look can read) is required.

## 2026-11-18 00:17 UTC tiles agent — round 2 rebuild (ids, sockets, node names unchanged)
- Palette is now the concept palette exactly (page #EADFC6, core #F6F0E1, ochre #C9994F, terracotta #B05A40, moss #6E7D46,
  sage #9FAE84, teal #5A9292, brown #74492F; face tint #E2B588). Cards are flat colour with ~1.4 % fibre grain.
- Page is calm: ~1.1 % grain, faint grid line on tile borders, 6 small ticks per tile, path = 45 % ochre with brown
  dashes and sparse dots, river = flat teal with cream wave strokes. Compass, survey marks, stipples and tints are gone.
- 118 flaps (was 229), mean 174 tris per tile, max 574 (forest). glb 1.78 MB.
- Hills are 5 (hill_big, up to 1.3 tall) or 3 (hill_small) layers in terracotta/ochre/moss/sage spanning the tile.
  Trees are 0.75–1.1 tall leaf/round/conifer crowns. Each tile has one hero and at most two small props.
- Edge-on fix: on tiles whose four sockets differ, every free-standing card sits at +-45 degrees (or is a V-fold), so
  it reads at all four rotations. All-equal-socket tiles keep camera-facing cards (the world draws them at rot 0).
- Bridge is now a raised arched deck: three hinged panels (flap_deck_a → b → c nested, top 0.2 high) between two
  terracotta arch cards (0.42 high). The traveller still walks at y = 0 and passes through the deck.
- House: both gables fall the same way and the side walls fall outward, so walls no longer cross mid-fold.
  The house sits at y = -0.38 in its tile (z = +0.38 in three.js) to keep the folded gables inside the tile.
- Card normals lean 0.6 toward up so no face shades much darker than the page. Back faces are real geometry with
  their own normals and the same print as the front. A lighter back via COLOR_0 was tried and removed: it turned every
  tile black in the game. If backs are still dark, that is shadowing, so the fill light has to lift it.
- Traveller is 0.755 tall: hip y = 0.258 (body, legL, legR; legs at x = -0.022 / +0.022), shoulder y = 0.449 (armL, armR).
  armR carries the walking stick. stand is a cream rectangular tab. Facing convention unchanged (+X, limbs swing on rotation.z).
- CORRECTION: mean is 183 tris per tile, not 174.

## 2026-11-18 00:22 UTC world agent — round 2 (critic fixes), tested against the 16:14 tiles.glb
- Region retuned to the 9.5-unit camera: rise front 2.1 cells ahead walking across the page, 1.7 walking up (-Z),
  1.4 walking down (+Z, the frame ends about 1.8 cells ahead), 1.5 cells to the sides, 1.0 behind; fold-down radii
  +0.75 cell (1.75 behind). Cards beyond the front lie flat as printed card and rise as the traveller arrives.
  Ripple 75 ms per cell of distance, flaps inside a tile spread over 0.6 s, nested flaps 70 ms after their parent.
- Spring: rise 0.53-0.63 s, overshoot 10.4-14.8 %, extrema about -12 / +5 / -2 %, settle 0.99-1.25 s (mass 0.5-2).
- Window 19x15 -> 13x11 cells. Tiles mesh 34-37k triangles (was 123k), whole frame 68-70k tris with the shadow pass.
  Vertex buffer 19.2 MB (143 slots x 904 vertices x 37 floats; was 34 MB).
- Vertex layout now carries COLOR_0 (the rebuilt glb uses vertex colours; without it every tile rendered black) and
  three nested fold levels (bridge deck a > b > c).
- Gutter: the unlit strip mesh is gone. The crease is in the tile material's fragment patch: a valley normal tilt plus
  a thin fold line every 6 cells (x = 12k - 1), lit and shadowed like the page. No extra draw call.
- Rotation: among rotations with identical sockets the one with the most card area facing the camera is drawn.
  Pieces still edge-on (projected/total area < 0.2): house, village, house_with_path side walls at rot 0/2 (box sides,
  expected); house_with_path at rot 1/3 front, back and one roof; bridge at rot 1 both arches.
- Pond / road investigation: tools/fold_test.mjs now walks 30 s and checks, after every rendered frame, every cell in
  the camera footprint: same (id, rot, drawn rot) as first seen, slot holds that tile, base vertices inside the cell,
  triangles inside the draw range, no upload queued. 10,217 frames, 234 cells: 0 changed, 0 not drawn, 0 changed on
  re-query. Four different pond cells crossed the footprint in that walk ((2,-3), (3,-7), (5,-13), (12,-27)); the first
  leaves as the second enters. Nothing in the world swaps or drops a base in view; the critic saw two ponds.
- Shadow pass: two programs carry the fold patch (depth + physical); shadows grow with the rise in the strips.
- Perf gate x3 (load average 4.5): 418-425 fps, p95 2.9-3.1 ms, 26 calls, 70k tris.
- NOT done: look agent's request for a finite page / page edge. The brief for the world is an endless page; lead to decide.
- tools/fold_test.mjs --strip captures/name writes 12-frame strips (100 ms apart, grabbed in-page) walking e / n / s.
