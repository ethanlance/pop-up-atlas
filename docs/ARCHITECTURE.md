# Pop-up Atlas — architecture contract (all agents must follow; do not change without logging in docs/LOG.md)

Run: `npm run dev` (Vite, port 5183, already running — do NOT start another, do NOT kill it). Build: `npm run build`.
Screenshots / perf: `node tools/shot.mjs --out captures/x.png [--url '?auto=1&seed=7'] [--wait 6000] [--perf 10]`
(uses installed Google Chrome with GPU; perf prints fps avg / p95 frame ms / draw calls as JSON).

## Units and axes (three.js, Y up)
- Grid cell = 2 world units. Cell (cx,cz) centre = (cx*2, 0, cz*2). Page surface is y = 0.
- Edges: n = -Z, e = +X, s = +Z, w = -X. Rotation k (0..3) = rotation.y = -k*PI/2; sockets shift n→e→s→w.
- Traveller is ~0.55 units tall. A house is ~1.1 tall, trees 0.7–1.4, hills up to 1.2.

## Assets (owner: tiles agent) — `public/assets/tiles.glb`, `public/assets/tiles.json`
tiles.glb root nodes:
- `tile_<id>`: children `base` (flat printed page mesh, 2x2 on XZ, y in [0,0.004]) and `flap_*` nodes.
- `flap_*`: node ORIGIN lies on its hinge line on the parent surface; local +X = hinge axis; mesh modelled in the
  UP (popped) pose. glTF extras: `foldAngle` (radians about local X that lays it flat on its parent, usually ±PI/2),
  `delay` (0..1 rise order inside the tile), `mass` (0.5..2, heavier = slower, more overshoot). Flaps may nest.
- `traveller`: root with children `body`, `legL`, `legR`, `armL`, `armR`, `stand` (paper tab base), origins at joints.
- Materials: MeshStandardMaterial-compatible, baseColor atlas + normal map embedded, roughness >= 0.85, metal 0.
  Card has real thickness (0.012–0.02) so cut edges show a lighter paper core.
tiles.json: `{ "cell": 2, "sockets": ["g","p","r"], "tiles": [ { "id", "sockets": {"n","e","s","w"},
  "weight", "rotations": [0,1,2,3], "blocked": false, "obstacles": [{"x","z","r"}] (tile-local, rot 0) } ] }`
Sockets: g = grass/page, p = path, r = river. River tiles are `blocked` except bridges.

## Modules (src/), one owner each. Factories only, no globals except `window.__atlas` (main.js).
- `wfc.js` (wfc agent): `createWFC(tilesJson, seed)` → `{ get(cx,cz) → {id, rot} }` lazy, deterministic per seed,
  neighbours always socket-match, never throws. Pure JS, no three.js. Test: `node tools/wfc_test.mjs`.
- `world.js` + `fold.js` (world agent): `createWorld({scene, gltf, tilesJson, wfc, audio})` →
  `{ update(dt, focus: Vector3, heading: Vector3), isWalkable(x,z) → bool, stats() → {tilesUp, flapsMoving} }`.
  Raises tiles near/ahead of focus, folds tiles behind flat. Calls `audio.flap({size, intensity, x, z})` per flap.
- `traveller.js`, `input.js`, `cameraRig.js` (traveller agent):
  `createInput(dom, camera)` → `{ dir: Vector2 (world xz, len<=1), update(dt, travellerPos), setAuto(bool) }` (WASD + click-to-walk);
  `createTraveller({scene, gltf, world, audio})` → `{ position: Vector3, heading: Vector3, update(dt, input) }`;
  `createCameraRig(camera)` → `{ update(dt, traveller), focusPoint: Vector3 }`.
- `look.js` (look agent): `createLook({renderer, scene, camera})` → `{ render(dt), resize(w,h), setFocus(Vector3) }`.
  Owns lights, shadows, background/table, tone mapping, tilt-shift DOF + post. No visible UI.
- `audio.js` (audio agent): `createAudio()` → `{ resume(), flap({size=1,intensity=1,x=0,z=0}), step(), setListener(x,z) }`.
- `main.js`, `index.html`, `tools/`, `docs/` (lead). `window.__atlas = { stats(), teleport(x,z), look, world, input }`.

## Rules
- Touch only files you own. Need a contract change? Append the request to docs/LOG.md and tell the lead in your report.
- Append-only log: add `## <UTC time> <agent>` entries to docs/LOG.md (never edit older entries). Log assumptions.
- Budget: 60 fps on an M-series / mid-range laptop at 1440x900: frame p95 <= 16.7 ms, <= 250 draw calls, <= 400k tris.
- No UI chrome, no brand assets, no network assets at runtime. three.js r187 only (plus three/addons).
