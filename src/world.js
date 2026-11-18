// World: endless page of WFC tiles whose pop-up flaps rise ahead of the traveller and fold flat behind.
// Contract: createWorld({scene, gltf, tilesJson, wfc, audio}) -> { update(dt, focus, heading), isWalkable(x,z), stats() }.
//
// Rendering: ONE Mesh holds every tile in the window: one real draw call per pass, atlas material with a small vertex
// patch. Vertices are stored once, in the popped pose, with the hinge line(s) they fold about. The vertex shader folds
// them by a per-flap fraction read from two small uniform arrays: a rest state per window slot (flat / up) and the
// live spring values of the few tiles that are in motion. So a frame with hundreds of moving flaps uploads no vertex
// or texture data at all; buffers change only when the window scrolls by a cell.
// (Measured first, and rejected: BatchedMesh and CPU-transformed vertices. On ANGLE/Metal their per-frame
// texSubImage2D / bufferSubData calls blocked the main thread for most of the frame and made frame pacing bursty.)
import * as THREE from 'three';
import * as Fold from './fold.js';

const HALF_X = 6; // window half size in cells: 13 x 11 cells = 26 x 22 units (the camera sees about 9.5 x 6)
const HALF_Z = 5;
const WIN_W = HALF_X * 2 + 1;
const WIN_H = HALF_Z * 2 + 1;

const RISE_AHEAD = 2.1; // cells, along the heading when walking across the page: the rise front is inside the frame
const RISE_AHEAD_UP = 1.7; // walking up the page (-Z): nearer, so the rise is close to the sharp band
const RISE_AHEAD_DOWN = 1.4; // walking down the page (+Z): the frame ends about 1.8 cells ahead of the traveller
const RISE_SIDE = 1.5; // cells, sideways
const RISE_BEHIND = 1.0; // cells, behind (only matters at the start and in turns)
const HYSTERESIS = 0.75; // fold-down radii are this much larger (1.75 cells behind)
const HEADING_TAU = 0.45; // s, low-pass on the heading so the region swings instead of jumping
const REACH_TIME = 0.8; // s for the region to grow from the traveller to full size (start / teleport ripple)
const TELEPORT_DIST = 3; // units in one frame

const RIPPLE_PER_CELL = 0.075; // s of extra rise delay per cell of distance from the traveller
const TILE_JITTER = 0.03; // s, per-tile random delay so a row does not pop in unison
const INTRA_RISE = 0.6; // s spanned by the `delay` extra inside one tile
const INTRA_FALL = 0.16;
const NEST_LAG = 0.07; // s a nested flap starts after its parent
const RISE_RATE = 160; // flap starts per second (token bucket): keeps audio under 28 starts per 100 ms
const FALL_RATE = 70;
const BUCKET = 2;
const NUDGE_SPEED = 0.28; // fold fractions / s given to resting neighbours (about 1 % wobble)

const BASE_TOP = 0.004;
const LAYER_STEP = 0.004; // vertical spacing between stacked flat flaps (no z-fighting)
const WALK_MARGIN = 0.12;
const GUTTER_EVERY = 6; // cells between book gutters (valley creases along z, on a cell edge)
const CAM_DIR = [0, -Math.sin(55 * Math.PI / 180), -Math.cos(55 * Math.PI / 180)]; // fixed camera view direction
const PAGE_SIZE = 480;
const MAX_SUBSTEPS = 16;

const MAX_FOLDS = 3; // nested fold levels the shader animates

const PEND_NONE = 0;
const PEND_RISE = 1;
const PEND_FALL = 2;

function mod(n, m) { return ((n % m) + m) % m; }
function hash2(x, z) {
  let h = (x * 374761393 + z * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function createWorld({ scene, gltf, tilesJson, wfc, audio }) {
  const CELL = tilesJson?.cell ?? 2;
  const group = new THREE.Group();
  group.name = 'world';
  scene.add(group);

  // ------------------------------------------------------------------------------------------------ prototypes
  // A piece is any node under a tile root. fa = fold angle (0 = rigid). Mesh pieces carry their source vertices.
  const protos = new Map(); // tile id -> { pieces, vCount, indices, uv4, flat }
  let srcMaterial = null;
  let maxPieces = 1;
  let geometries = 0;
  const seenGeom = new Set();

  function collect(node, parent, depth, pieces) {
    for (const child of node.children) {
      child.updateMatrix();
      const isBase = depth === 0 && child.name.startsWith('base');
      const isFlap = child.name.startsWith('flap');
      const ud = child.userData || {};
      const piece = {
        name: child.name, parent, isBase, geometry: null,
        local: child.matrix.clone(),
        fa: isFlap && !isBase ? Number(ud.foldAngle ?? 0) || 0 : 0,
        delay: THREE.MathUtils.clamp(Number(ud.delay ?? 0.5) || 0, 0, 1),
        mass: Number(ud.mass ?? 1) || 1,
        moves: false, lift: 0, layer: 0, size: 1, px: 0, pz: 0,
        vOff: 0, vCount: 0, pos: null, nrm: null, hasMesh: false, hinge: null, folds: null,
      };
      const g = child.isMesh ? child.geometry : null;
      if (g && g.attributes.position && g.attributes.normal && g.attributes.uv && g.index) {
        if (!srcMaterial) srcMaterial = child.material;
        if (!seenGeom.has(g)) { seenGeom.add(g); geometries++; }
        piece.geometry = g;
      } else if (g) console.warn('world: mesh skipped (needs position, normal, uv and an index):', child.name);
      piece.moves = piece.fa !== 0 || (parent >= 0 && pieces[parent].moves);
      pieces.push(piece);
      collect(child, pieces.length - 1, depth + 1, pieces);
    }
  }

  let VCAP = 4; // vertices reserved per window slot
  let ICAP = 6;
  if (gltf?.scene) {
    const chain = [];
    const box = new THREE.Box3();
    const m = new THREE.Matrix4();
    const rx = new THREE.Matrix4();
    const v = new THREE.Vector3();
    const n3 = new THREE.Matrix3();
    for (const root of gltf.scene.children) {
      if (!root.name.startsWith('tile_')) continue;
      const pieces = [];
      collect(root, -1, 0, pieces); // the root's own transform is ignored: tiles are authored about their centre
      if (pieces.length > maxPieces) maxPieces = pieces.length;

      // Vertex layout of the tile and its static attributes.
      let vCount = 0, iCount = 0;
      for (const p of pieces) if (p.geometry) { p.vOff = vCount; p.vCount = p.geometry.attributes.position.count; vCount += p.vCount; iCount += p.geometry.index.count; }
      const proto = { pieces, vCount, indices: new Uint32Array(iCount), uv4: new Float32Array(vCount * 4), up: new Float32Array(vCount * 6),
        col: new Float32Array(vCount * 4).fill(1) };
      let io = 0;
      const rects = [];
      pieces.forEach((p, i) => {
        // Rest (up) and flat chains in tile-local space.
        const up = new THREE.Matrix4().copy(p.local);
        if (p.parent >= 0) up.premultiply(chain[p.parent].up);
        const flat = new THREE.Matrix4().copy(p.local).multiply(rx.makeRotationX(p.fa));
        if (p.parent >= 0) flat.premultiply(chain[p.parent].flat);
        chain[i] = { up, flat };
        p.px = up.elements[12];
        p.pz = up.elements[14];
        const g = p.geometry;
        if (!g) return;
        const pos = g.attributes.position, nrm = g.attributes.normal, uv = g.attributes.uv, uv1 = g.attributes.uv1 ?? uv, col = g.attributes.color;
        p.pos = new Float32Array(p.vCount * 3);
        p.nrm = new Float32Array(p.vCount * 3);
        p.hasMesh = true;
        for (let k = 0; k < p.vCount; k++) {
          p.pos[k * 3] = pos.getX(k); p.pos[k * 3 + 1] = pos.getY(k); p.pos[k * 3 + 2] = pos.getZ(k);
          p.nrm[k * 3] = nrm.getX(k); p.nrm[k * 3 + 1] = nrm.getY(k); p.nrm[k * 3 + 2] = nrm.getZ(k);
          const o = (p.vOff + k) * 4;
          proto.uv4[o] = uv.getX(k); proto.uv4[o + 1] = uv.getY(k); proto.uv4[o + 2] = uv1.getX(k); proto.uv4[o + 3] = uv1.getY(k);
          if (col) { proto.col[o] = col.getX(k); proto.col[o + 1] = col.getY(k); proto.col[o + 2] = col.getZ(k); if (col.itemSize > 3) proto.col[o + 3] = col.getW(k); }
        }
        for (let k = 0; k < g.index.count; k++) proto.indices[io++] = g.index.getX(k) + p.vOff;

        // Stacking layer: overlapping flat flaps never share a plane. The lift puts the flat top face at its layer height.
        if (p.moves) {
          if (!g.boundingBox) g.computeBoundingBox();
          const bb = g.boundingBox;
          p.size = THREE.MathUtils.clamp(bb.getSize(v).length() * 1.2, 0.3, 3);
          box.makeEmpty();
          for (let c = 0; c < 8; c++) {
            v.set(c & 1 ? bb.max.x : bb.min.x, c & 2 ? bb.max.y : bb.min.y, c & 4 ? bb.max.z : bb.min.z).applyMatrix4(flat);
            box.expandByPoint(v);
          }
          let layer = 1;
          for (const r of rects) {
            if (r.x0 < box.max.x && r.x1 > box.min.x && r.z0 < box.max.z && r.z1 > box.min.z && r.layer >= layer) layer = r.layer + 1;
          }
          rects.push({ x0: box.min.x, x1: box.max.x, z0: box.min.z, z1: box.max.z, layer });
          p.lift = BASE_TOP + layer * LAYER_STEP - box.max.y;
          p.layer = layer;
        }

        // Popped pose baked in tile-local space (position, normal interleaved).
        n3.setFromMatrix4(up);
        for (let k = 0; k < p.vCount; k++) {
          const o = (p.vOff + k) * 6;
          v.fromArray(p.pos, k * 3).applyMatrix4(up).toArray(proto.up, o);
          v.fromArray(p.nrm, k * 3).applyMatrix3(n3).toArray(proto.up, o + 3);
        }

        // The folds that move this piece, innermost first: its own hinge, then its folding ancestors (three levels).
        // Each is a line in the popped pose: origin + axis, the axis scaled by the fold angle.
        p.hinge = new Float32Array(MAX_FOLDS * 6);
        p.folds = [-1, -1, -1];
        let level = 0;
        for (let q = i; q >= 0; q = pieces[q].parent) {
          if (pieces[q].fa === 0) continue;
          if (level === MAX_FOLDS) { console.warn(`world: more than ${MAX_FOLDS} nested folds, outer ones ignored for`, p.name); break; }
          const e = chain[q].up.elements;
          v.set(e[0], e[1], e[2]).normalize().multiplyScalar(pieces[q].fa);
          p.hinge.set([e[12], e[13], e[14], v.x, v.y, v.z], level * 6);
          p.folds[level] = q;
          level++;
        }
      });
      // Card area projected towards the camera for each quarter-turn, per tile and per moving piece.
      proto.facing = [0, 0, 0, 0];
      for (const p of pieces) {
        if (!p.hasMesh || !p.moves) continue;
        p.facing = [0, 0, 0, 0];
        let total = 0;
        const idx = p.geometry.index;
        for (let k = 0; k < idx.count; k += 3) {
          const a = (p.vOff + idx.getX(k)) * 6, b = (p.vOff + idx.getX(k + 1)) * 6, c = (p.vOff + idx.getX(k + 2)) * 6;
          const u = proto.up;
          const e1x = u[b] - u[a], e1y = u[b + 1] - u[a + 1], e1z = u[b + 2] - u[a + 2];
          const e2x = u[c] - u[a], e2y = u[c + 1] - u[a + 1], e2z = u[c + 2] - u[a + 2];
          let nx = e1y * e2z - e1z * e2y, nz = e1x * e2y - e1y * e2x;
          const ny = e1z * e2x - e1x * e2z;
          total += Math.hypot(nx, ny, nz) / 2;
          for (let r = 0; r < 4; r++) {
            p.facing[r] += Math.abs(nx * CAM_DIR[0] + ny * CAM_DIR[1] + nz * CAM_DIR[2]) / 2;
            const t = -nz; nz = nx; nx = t; // next quarter-turn: (x, z) -> (-z, x)
          }
        }
        p.area = total;
        for (let r = 0; r < 4; r++) proto.facing[r] += p.facing[r];
      }
      protos.set(root.name.slice(5), proto);
      if (vCount > VCAP) VCAP = vCount;
      if (iCount > ICAP) ICAP = iCount;
    }
  }

  // ------------------------------------------------------------------------------------------------ tiles.json
  const defs = new Map(); // id -> { blocked, obs: [Float32Array x4 rotations] of (x, z, r), canon }
  for (const t of tilesJson?.tiles ?? []) {
    const obs = [];
    for (let k = 0; k < 4; k++) {
      const a = new Float32Array((t.obstacles?.length ?? 0) * 3);
      (t.obstacles ?? []).forEach((o, i) => {
        let x = o.x, z = o.z;
        for (let r = 0; r < k; r++) { const nx = -z; z = x; x = nx; } // rotation.y = -PI/2: (x, z) -> (-z, x), n -> e
        a[i * 3] = x; a[i * 3 + 1] = z; a[i * 3 + 2] = o.r + WALK_MARGIN;
      });
      obs.push(a);
    }
    // Drawn rotation: among the rotations with the same sockets, the one that turns most card area towards the
    // camera (ties go to the smallest). Symmetric tiles then never stand edge-on for no socket reason.
    const sk = t.sockets ? [t.sockets.n, t.sockets.e, t.sockets.s, t.sockets.w] : null;
    const canon = [0, 1, 2, 3];
    const facing = protos.get(t.id)?.facing ?? [0, 0, 0, 0];
    if (sk) {
      for (let k = 0; k < 4; k++) {
        let best = k;
        for (let c = 0; c < 4; c++) {
          let same = true;
          for (let d = 0; d < 4; d++) if (sk[(d - k + 4) % 4] !== sk[(d - c + 4) % 4]) same = false;
          if (!same) continue;
          if (facing[c] > facing[best] * 1.02 || (c < best && facing[c] >= facing[best] * 0.98)) best = c;
        }
        canon[k] = best;
      }
    }
    defs.set(t.id, { blocked: !!t.blocked, obs, canon });
  }
  function tileRot(t) { const d = defs.get(t.id); return d ? d.canon[t.rot & 3] : t.rot & 3; }

  // ------------------------------------------------------------------------------------------------ the one mesh
  const STRIDE = maxPieces;
  const NSLOT = WIN_W * WIN_H;
  const NPIECE = NSLOT * STRIDE;
  const ready = protos.size > 0 && !!srcMaterial;
  let pageColor = new THREE.Color(0xe9dcc3);
  let fibreScale = 0.5;

  // Vertex layout (floats): position 3, normal 3, uv 2, uv1 2, color 4, then per fold level A/B/C (innermost first)
  // hinge origin 3 + axis 3 (axis length = fold angle), with the flat-pose lift in hingeA.w,
  // and fold 4 = (window slot, flap index of fold A, B, C or -1).
  const VS = 37;
  const vbData = new Float32Array(ready ? NSLOT * VCAP * VS : VS);
  const ibData = new Uint32Array(ready ? NSLOT * ICAP : 3);
  const vb = new THREE.InterleavedBuffer(vbData, VS).setUsage(THREE.DynamicDrawUsage);
  const ib = new THREE.BufferAttribute(ibData, 1).setUsage(THREE.DynamicDrawUsage);
  const tilesGeo = new THREE.BufferGeometry();
  tilesGeo.setAttribute('position', new THREE.InterleavedBufferAttribute(vb, 3, 0));
  tilesGeo.setAttribute('normal', new THREE.InterleavedBufferAttribute(vb, 3, 3));
  tilesGeo.setAttribute('uv', new THREE.InterleavedBufferAttribute(vb, 2, 6));
  tilesGeo.setAttribute('uv1', new THREE.InterleavedBufferAttribute(vb, 2, 8));
  tilesGeo.setAttribute('color', new THREE.InterleavedBufferAttribute(vb, 4, 10));
  tilesGeo.setAttribute('hingeA', new THREE.InterleavedBufferAttribute(vb, 4, 14));
  tilesGeo.setAttribute('axisA', new THREE.InterleavedBufferAttribute(vb, 3, 18));
  tilesGeo.setAttribute('hingeB', new THREE.InterleavedBufferAttribute(vb, 3, 21));
  tilesGeo.setAttribute('axisB', new THREE.InterleavedBufferAttribute(vb, 3, 24));
  tilesGeo.setAttribute('hingeC', new THREE.InterleavedBufferAttribute(vb, 3, 27));
  tilesGeo.setAttribute('axisC', new THREE.InterleavedBufferAttribute(vb, 3, 30));
  tilesGeo.setAttribute('fold', new THREE.InterleavedBufferAttribute(vb, 4, 33));
  tilesGeo.setIndex(ib);
  tilesGeo.setDrawRange(0, 0);

  // Fold state for the shader. tileState[slot]: 0 = every flap up, 1 = every flap flat, 2 + k = live block k.
  // liveX[k * STRIDE + flap] = spring value of that flap. Both are plain uniform arrays (no buffer or texture upload).
  const ACTIVE_MAX = Math.max(8, Math.min(64, Math.floor(1920 / STRIDE)));
  const tileState = new Float32Array(Math.ceil(NSLOT / 4) * 4).fill(1);
  const liveX = new Float32Array(Math.ceil(ACTIVE_MAX * STRIDE / 4) * 4);
  const uTile = { value: tileState };
  const uLive = { value: liveX };
  const POP_PARS = /* glsl */`
    attribute vec4 hingeA;
    attribute vec3 axisA;
    attribute vec3 hingeB;
    attribute vec3 axisB;
    attribute vec3 hingeC;
    attribute vec3 axisC;
    attribute vec4 fold;
    varying vec3 popW;
    uniform vec4 popTile[${tileState.length / 4}];
    uniform vec4 popLive[${liveX.length / 4}];
    float popX(float flap) {
      if (flap < -0.5) return 0.0;
      int s = int(fold.x + 0.5);
      float v = popTile[s >> 2][s & 3];
      if (v < 1.5) return v;
      int k = (int(v + 0.5) - 2) * ${STRIDE} + int(flap + 0.5);
      return popLive[k >> 2][k & 3];
    }
    void popRot(inout vec3 p, inout vec3 n, vec3 o, vec3 ax, float x) {
      float len = length(ax);
      if (len < 1e-5) return;
      vec3 d = ax / len;
      float a = len * x, c = cos(a), s = sin(a);
      vec3 q = p - o;
      p = o + q * c + cross(d, q) * s + d * (dot(d, q) * (1.0 - c));
      n = n * c + cross(d, n) * s + d * (dot(d, n) * (1.0 - c));
    }
    void popApply(inout vec3 p, inout vec3 n) {
      float xa = popX(fold.y), xb = popX(fold.z), xc = popX(fold.w);
      popRot(p, n, hingeA.xyz, axisA, xa);
      popRot(p, n, hingeB, axisB, xb);
      popRot(p, n, hingeC, axisC, xc);
      float f = clamp(max(xa, max(xb, xc)), 0.0, 1.0);
      p.y += hingeA.w * f * f;
    }
  `;
  const GUTTER_PARS = /* glsl */`
    varying vec3 popW;
    // x = signed distance to the nearest gutter line, y = 1 on the page surface fading to 0 above it.
    vec2 popGutter() {
      float period = ${(GUTTER_EVERY * CELL).toFixed(1)};
      float gx = mod( popW.x + ${(CELL / 2).toFixed(1)} + period * 0.5, period ) - period * 0.5;
      return vec2( gx, 1.0 - smoothstep( 0.03, 0.10, popW.y ) );
    }
    float popValley( float gx ) {
      float w = 1.0 - smoothstep( 0.0, 0.4, abs( gx ) );
      return w * w;
    }
  `;
  function patchMaterial(material) {
    material.onBeforeCompile = (shader) => {
      shader.uniforms.popTile = uTile;
      shader.uniforms.popLive = uLive;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\n' + POP_PARS)
        .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n{ vec3 popP = position; popApply(popP, objectNormal); }')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n{ vec3 popN = vec3(0.0, 1.0, 0.0); popApply(transformed, popN); }\npopW = transformed;');
      // Book gutter: a lit valley crease in the page every GUTTER_EVERY cells (normal tilt + a thin dark fold line).
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\n' + GUTTER_PARS)
        .replace('#include <map_fragment>', '#include <map_fragment>\n{ vec2 pg = popGutter(); diffuseColor.rgb *= 1.0 - pg.y * ( 0.26 * exp( - pg.x * pg.x / 0.0012 ) + 0.05 * popValley( pg.x ) ); }')
        .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n{ vec2 pg = popGutter(); vec3 gx = normalize( ( viewMatrix * vec4( 1.0, 0.0, 0.0, 0.0 ) ).xyz ); normal = normalize( normal - gx * sign( pg.x ) * 0.38 * pg.y * popValley( pg.x ) ); }');
    };
    material.customProgramCacheKey = () => `popup-${STRIDE}-${ACTIVE_MAX}`;
    return material;
  }

  let tilesMesh = null;
  if (ready) {
    tilesMesh = new THREE.Mesh(tilesGeo, patchMaterial(srcMaterial.clone()));
    tilesMesh.customDepthMaterial = patchMaterial(new THREE.MeshDepthMaterial()); // shadow pass folds the same way
    tilesMesh.name = 'tiles';
    tilesMesh.frustumCulled = false; // the window always surrounds the camera target
    tilesMesh.castShadow = true;
    tilesMesh.receiveShadow = true;
    group.add(tilesMesh);

    // Page colour and fibre scale from a meadow base, so the plain page beyond the window matches.
    try {
      const proto = protos.get('meadow_a') ?? protos.values().next().value;
      const base = proto.pieces.find((p) => p.isBase && p.geometry);
      const img = srcMaterial.map?.image;
      const N = 256;
      if (img && base) {
        const cv = document.createElement('canvas');
        cv.width = cv.height = N;
        const ctx = cv.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, N, N);
        const px = ctx.getImageData(0, 0, N, N).data;
        // Mean colour of the base's atlas rectangle (the print is mottled, so a single texel is not representative).
        let u0 = 1, u1 = 0, v0 = 1, v1 = 0;
        for (let k = 0; k < base.vCount; k++) {
          const u = proto.uv4[(base.vOff + k) * 4], vv = proto.uv4[(base.vOff + k) * 4 + 1];
          const v = srcMaterial.map.flipY ? 1 - vv : vv;
          u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
        }
        let r = 0, g = 0, b = 0, n = 0;
        for (let y = Math.ceil(v0 * N); y < Math.floor(v1 * N); y++) {
          for (let x = Math.ceil(u0 * N); x < Math.floor(u1 * N); x++) {
            const o = (y * N + x) * 4;
            r += px[o]; g += px[o + 1]; b += px[o + 2]; n++;
          }
        }
        if (n > 0 && (r + g + b) / n > 120) pageColor = new THREE.Color().setRGB(r / n / 255, g / n / 255, b / n / 255, THREE.SRGBColorSpace);
      }
      if (base) {
        let a0 = Infinity, a1 = -Infinity, x0 = Infinity, x1 = -Infinity;
        for (let k = 0; k < base.vCount; k++) {
          const u = proto.uv4[(base.vOff + k) * 4 + 2], x = base.pos[k * 3];
          a0 = Math.min(a0, u); a1 = Math.max(a1, u); x0 = Math.min(x0, x); x1 = Math.max(x1, x);
        }
        if (x1 > x0 && a1 > a0) fibreScale = (a1 - a0) / (x1 - x0);
      }
    } catch (e) { console.warn('world: page colour probe failed', e); }
  }

  // Plain page beyond the tile window: a frame of four quads around the window (the tile bases cover the inside, so a
  // full plane there would only be shaded twice). It moves with the window in whole cells.
  const pageGeo = new THREE.BufferGeometry();
  {
    const ix = ready ? (HALF_X + 0.5) * CELL - 0.02 : 0, iz = ready ? (HALF_Z + 0.5) * CELL - 0.02 : 0, o = PAGE_SIZE / 2;
    const rects = [[-o, -o, o, -iz], [-o, iz, o, o], [-o, -iz, -ix, iz], [ix, -iz, o, iz]]; // x0, z0, x1, z1
    const pos = [], nrm = [], uv1 = [], index = [];
    for (const [x0, z0, x1, z1] of rects) {
      const k = pos.length / 3;
      pos.push(x0, 0, z0, x1, 0, z0, x1, 0, z1, x0, 0, z1);
      nrm.push(0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0);
      uv1.push(x0 * fibreScale, z0 * fibreScale, x1 * fibreScale, z0 * fibreScale, x1 * fibreScale, z1 * fibreScale, x0 * fibreScale, z1 * fibreScale);
      index.push(k, k + 2, k + 1, k, k + 3, k + 2);
    }
    pageGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    pageGeo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    pageGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uv1, 2));
    pageGeo.setAttribute('uv1', new THREE.Float32BufferAttribute(uv1, 2));
    pageGeo.setIndex(index);
  }
  const pageMat = new THREE.MeshStandardMaterial({ color: pageColor, roughness: srcMaterial?.roughness ?? 0.92, metalness: 0 });
  if (srcMaterial?.normalMap && srcMaterial.normalMap.channel === 1) {
    pageMat.normalMap = srcMaterial.normalMap;
    pageMat.normalScale.copy(srcMaterial.normalScale);
  }
  const page = new THREE.Mesh(pageGeo, pageMat);
  page.name = 'page';
  page.position.y = BASE_TOP - 0.001;
  page.receiveShadow = true;
  page.frustumCulled = false;
  group.add(page);

  // ------------------------------------------------------------------------------------------------ runtime state
  const slotCx = new Int32Array(NSLOT).fill(0x7fffffff);
  const slotCz = new Int32Array(NSLOT).fill(0x7fffffff);
  const slotRot = new Uint8Array(NSLOT);
  const slotUp = new Uint8Array(NSLOT);
  const slotActive = new Uint8Array(NSLOT); // in activeSlots
  const slotProto = new Array(NSLOT).fill(null);
  const activeSlots = new Int32Array(NSLOT);
  let nActive = 0;

  const pool = Fold.createFoldPool(NPIECE);
  const pend = new Uint8Array(NPIECE);
  const timer = new Float32Array(NPIECE);

  const slotIdxStart = new Int32Array(NSLOT).fill(-1); // where the slot's triangles sit in the index buffer
  const slotBlock = new Int16Array(NSLOT).fill(-1); // live block of an active slot
  const freeBlocks = new Int16Array(ACTIVE_MAX);
  let nFree = ACTIVE_MAX;
  for (let k = 0; k < ACTIVE_MAX; k++) freeBlocks[k] = ACTIVE_MAX - 1 - k;
  const flapMsg = { size: 1, intensity: 1, x: 0, z: 0 };
  const hw = new Float32Array(MAX_FOLDS * 6);

  // Pooled upload ranges (three keeps the objects we push; nothing is allocated after start-up).
  const vbRanges = [];
  let nVbRange = 0;
  function markVb(start, count) {
    if (nVbRange === vbRanges.length) vbRanges.push({ start: 0, count: 0 });
    const r = vbRanges[nVbRange++];
    r.start = start; r.count = count;
    vb.updateRanges.push(r);
  }

  let tilesUp = 0;
  let flapsMoving = 0;
  let acc = 0;
  let simTime = 0;
  let started = false;
  let winCx = 0x7fffffff, winCz = 0x7fffffff;
  let lastFx = 0, lastFz = 0;
  let hx = 0, hz = -1; // smoothed heading (not normalised)
  let reach = 0;
  let nudgeOn = true;
  let riseTokens = BUCKET, fallTokens = BUCKET;

  // Debug counters (tools/fold_test.mjs).
  const dbg = { audioCalls: 0, audioRise: 0, audioLand: 0, maxPer100ms: 0, winStart: 0, winCount: 0, minX: 1, maxX: 0, nan: 0,
    blocksMax: 0, tileUps: 0, tileDowns: 0, flickers: 0 };
  const slotToggled = new Float32Array(NSLOT).fill(-10); // sim time of the last up/down decision (debug)
  let trace = null;

  // Point a window slot at cell (cx, cz): its vertices in the popped pose with their hinges, all flaps flat at rest.
  function assignSlot(slot, cx, cz) {
    const off = slot * STRIDE;
    if (slotUp[slot]) { slotUp[slot] = 0; tilesUp--; }
    const old = slotProto[slot];
    if (old) {
      for (let i = 0; i < old.pieces.length; i++) {
        const m = pool.mode[off + i];
        if (m === Fold.RISING || m === Fold.FALLING) flapsMoving--;
        pend[off + i] = PEND_NONE;
      }
    }
    if (slotBlock[slot] >= 0) { freeBlocks[nFree++] = slotBlock[slot]; slotBlock[slot] = -1; }
    tileState[slot] = 1;
    slotToggled[slot] = -10;
    const t = wfc.get(cx, cz);
    const proto = protos.get(t.id) ?? null;
    const rot = tileRot(t);
    slotCx[slot] = cx; slotCz[slot] = cz; slotRot[slot] = rot; slotProto[slot] = proto;
    if (!proto) return;
    const pieces = proto.pieces;
    for (let i = 0; i < pieces.length; i++) Fold.initFlap(pool, off + i, pieces[i].mass, false);
    // Tile-local -> world is a quarter-turn about Y (rotation.y = -rot * PI/2) plus a translation.
    const c = rot === 0 ? 1 : rot === 2 ? -1 : 0;
    const s = rot === 1 ? -1 : rot === 3 ? 1 : 0;
    const tx = cx * CELL, tz = cz * CELL;
    const src = proto.up, uv = proto.uv4, col = proto.col;
    let o = slot * VCAP * VS;
    for (let i = 0; i < pieces.length; i++) {
      const p = pieces[i];
      if (!p.hasMesh) continue;
      const h = p.hinge;
      for (let l = 0; l < MAX_FOLDS; l++) { // hinges of this piece, turned into world space
        const b = l * 6;
        hw[b] = c * h[b] + s * h[b + 2] + tx; hw[b + 1] = h[b + 1]; hw[b + 2] = c * h[b + 2] - s * h[b] + tz;
        hw[b + 3] = c * h[b + 3] + s * h[b + 5]; hw[b + 4] = h[b + 4]; hw[b + 5] = c * h[b + 5] - s * h[b + 3];
      }
      const lift = p.moves ? p.lift : 0;
      const f0 = p.folds[0], f1 = p.folds[1], f2 = p.folds[2];
      for (let k = p.vOff, e = p.vOff + p.vCount; k < e; k++) {
        const a = k * 6, u = k * 4;
        const x = src[a], z = src[a + 2], nx = src[a + 3], nz = src[a + 5];
        vbData[o] = c * x + s * z + tx;
        vbData[o + 1] = src[a + 1];
        vbData[o + 2] = c * z - s * x + tz;
        vbData[o + 3] = c * nx + s * nz;
        vbData[o + 4] = src[a + 4];
        vbData[o + 5] = c * nz - s * nx;
        vbData[o + 6] = uv[u]; vbData[o + 7] = uv[u + 1]; vbData[o + 8] = uv[u + 2]; vbData[o + 9] = uv[u + 3];
        vbData[o + 10] = col[u]; vbData[o + 11] = col[u + 1]; vbData[o + 12] = col[u + 2]; vbData[o + 13] = col[u + 3];
        vbData[o + 14] = hw[0]; vbData[o + 15] = hw[1]; vbData[o + 16] = hw[2]; vbData[o + 17] = lift;
        vbData[o + 18] = hw[3]; vbData[o + 19] = hw[4]; vbData[o + 20] = hw[5];
        vbData[o + 21] = hw[6]; vbData[o + 22] = hw[7]; vbData[o + 23] = hw[8];
        vbData[o + 24] = hw[9]; vbData[o + 25] = hw[10]; vbData[o + 26] = hw[11];
        vbData[o + 27] = hw[12]; vbData[o + 28] = hw[13]; vbData[o + 29] = hw[14];
        vbData[o + 30] = hw[15]; vbData[o + 31] = hw[16]; vbData[o + 32] = hw[17];
        vbData[o + 33] = slot; vbData[o + 34] = f0; vbData[o + 35] = f1; vbData[o + 36] = f2;
        o += VS;
      }
    }
    markVb(slot * VCAP * VS, proto.vCount * VS);
  }

  // The index buffer stays compact (only real triangles are drawn); it is rebuilt when the window moves.
  function rebuildIndex() {
    let n = 0;
    for (let slot = 0; slot < NSLOT; slot++) {
      const proto = slotProto[slot];
      slotIdxStart[slot] = n;
      if (!proto) continue;
      const src = proto.indices, base = slot * VCAP;
      for (let k = 0; k < src.length; k++) ibData[n++] = src[k] + base;
    }
    tilesGeo.setDrawRange(0, n);
    ib.clearUpdateRanges();
    ib.addUpdateRange(0, n);
    ib.needsUpdate = true;
  }

  function activate(slot) {
    if (slotActive[slot]) return;
    slotActive[slot] = 1;
    activeSlots[nActive++] = slot;
  }

  function trigger(slot, up, dist) {
    const proto = slotProto[slot];
    slotUp[slot] = up ? 1 : 0;
    tilesUp += up ? 1 : -1;
    if (up) dbg.tileUps++; else dbg.tileDowns++;
    if (simTime - slotToggled[slot] < 0.75) dbg.flickers++; // changed its mind within 0.75 s
    slotToggled[slot] = simTime;
    if (!proto) return;
    const off = slot * STRIDE;
    const pieces = proto.pieces;
    const jitter = hash2(slotCx[slot], slotCz[slot]);
    const base = up ? Math.max(0, dist - 1) * RIPPLE_PER_CELL + jitter * TILE_JITTER : jitter * 0.05;
    let any = false;
    for (let i = 0; i < pieces.length; i++) {
      const p = pieces[i];
      if (p.fa === 0) continue;
      let t = base + (up ? p.delay * INTRA_RISE : (1 - p.delay) * INTRA_FALL);
      if (up && p.parent >= 0 && pieces[p.parent].fa !== 0 && t < timer[off + p.parent] + NEST_LAG) t = timer[off + p.parent] + NEST_LAG;
      pend[off + i] = up ? PEND_RISE : PEND_FALL;
      timer[off + i] = t;
      any = true;
    }
    if (any) activate(slot);
  }

  function emitFlap(slot, p, intensity) {
    dbg.audioCalls++;
    if (intensity > 0.9) dbg.audioRise++; else dbg.audioLand++;
    if (simTime - dbg.winStart >= 0.1) { dbg.winStart = simTime; dbg.winCount = 0; }
    if (++dbg.winCount > dbg.maxPer100ms) dbg.maxPer100ms = dbg.winCount;
    if (!audio?.flap) return;
    const rot = slotRot[slot];
    let x = p.px, z = p.pz;
    for (let r = 0; r < rot; r++) { const nx = -z; z = x; x = nx; }
    flapMsg.size = p.size;
    flapMsg.intensity = intensity;
    flapMsg.x = slotCx[slot] * CELL + x;
    flapMsg.z = slotCz[slot] * CELL + z;
    audio.flap(flapMsg);
  }

  // Faint sympathetic wobble: resting upright flaps of the four neighbours get a small kick.
  function nudgeNeighbours(slot) {
    if (nFree < 8) return; // keep live blocks for real pops
    const cx = slotCx[slot], cz = slotCz[slot];
    for (let d = 0; d < 4; d++) {
      const nx = cx + (d === 0 ? 1 : d === 1 ? -1 : 0), nz = cz + (d === 2 ? 1 : d === 3 ? -1 : 0);
      const s = mod(nx, WIN_W) + mod(nz, WIN_H) * WIN_W;
      if (slotCx[s] !== nx || slotCz[s] !== nz || !slotUp[s] || !slotProto[s]) continue;
      const pieces = slotProto[s].pieces, off = s * STRIDE;
      let any = false;
      for (let i = 0; i < pieces.length; i++) {
        if (pieces[i].fa === 0) continue;
        const sign = hash2(nx * 31 + i, nz * 17 + d) < 0.5 ? -1 : 1;
        if (Fold.nudge(pool, off + i, sign * NUDGE_SPEED / Math.sqrt(pieces[i].mass))) { flapsMoving++; any = true; }
      }
      if (any) activate(s);
    }
  }

  function stepTile(slot, nSub, elapsed) {
    const proto = slotProto[slot];
    if (!proto) return false;
    const pieces = proto.pieces;
    const off = slot * STRIDE;
    // A tile in motion needs a live block. When all are taken it waits; that only happens in a start burst.
    let blk = slotBlock[slot];
    if (blk < 0) {
      if (nFree === 0) return true;
      blk = freeBlocks[--nFree];
      slotBlock[slot] = blk;
      for (let i = 0; i < pieces.length; i++) liveX[blk * STRIDE + i] = pool.x[off + i];
      tileState[slot] = 2 + blk;
      if (ACTIVE_MAX - nFree > dbg.blocksMax) dbg.blocksMax = ACTIVE_MAX - nFree;
    }
    const live = blk * STRIDE;
    let busy = false, firstRise = false;
    for (let i = 0; i < pieces.length; i++) {
      const p = pieces[i];
      if (p.fa === 0) continue;
      const id = off + i;
      if (pend[id] !== PEND_NONE) {
        timer[id] -= elapsed;
        const rising = pend[id] === PEND_RISE;
        const parentWaits = rising && p.parent >= 0 && pend[off + p.parent] === PEND_RISE;
        if (timer[id] <= 0 && !parentWaits && (rising ? riseTokens : fallTokens) >= 1) {
          const before = pool.mode[id];
          if (rising) {
            if (before === Fold.FLAT || before === Fold.FALLING) riseTokens--;
            Fold.startRise(pool, id);
            if (before === Fold.FLAT || before === Fold.FALLING) {
              if (before === Fold.FLAT) { flapsMoving++; firstRise = true; }
              emitFlap(slot, p, 1);
              if (trace && trace.id < 0 && before === Fold.FLAT && p.mass >= trace.minMass && p.mass <= trace.maxMass) {
                trace.id = id; trace.mass = p.mass; trace.name = p.name; trace.fa = p.fa;
                trace.t0 = simTime - elapsed; // this frame's substeps are part of the rise
                trace.samples.push({ t: 0, x: pool.x[id] });
              }
            }
          } else {
            Fold.startFall(pool, id);
            if (before === Fold.UP || before === Fold.RISING) fallTokens--;
            if (before === Fold.UP) flapsMoving++;
          }
          pend[id] = PEND_NONE;
        } else busy = true;
      }
      const mode = pool.mode[id];
      if (mode === Fold.RISING || mode === Fold.FALLING) {
        for (let k = 0; k < nSub; k++) {
          const ev = Fold.step(pool, id, Fold.SUBSTEP);
          if (ev === Fold.EV_NONE) continue;
          if (ev === Fold.EV_LANDED) emitFlap(slot, p, 0.4);
          if (pool.mode[id] === Fold.UP || pool.mode[id] === Fold.FLAT) { flapsMoving--; break; }
        }
        const x = pool.x[id];
        if (x !== x) { dbg.nan++; Fold.initFlap(pool, id, p.mass, slotUp[slot] === 1); }
        if (x < dbg.minX) dbg.minX = x;
        if (x > dbg.maxX) dbg.maxX = x;
        liveX[live + i] = pool.x[id];
        if (pool.mode[id] === Fold.RISING || pool.mode[id] === Fold.FALLING) busy = true;
      }
    }
    if (firstRise && nudgeOn) nudgeNeighbours(slot);
    return busy;
  }

  // A tile whose flaps all rest in the same pose gives its live block back. Returns false while poses are mixed.
  function settle(slot) {
    const proto = slotProto[slot];
    if (!proto || slotBlock[slot] < 0) return true;
    const off = slot * STRIDE;
    let up = 0, flat = 0;
    for (let i = 0; i < proto.pieces.length; i++) {
      if (proto.pieces[i].fa === 0) continue;
      if (pool.mode[off + i] === Fold.UP) up++; else flat++;
    }
    if (up > 0 && flat > 0) return false;
    tileState[slot] = up > 0 ? 0 : 1;
    freeBlocks[nFree++] = slotBlock[slot];
    slotBlock[slot] = -1;
    return true;
  }

  function update(dt, focus, heading) {
    if (!ready) return;
    const fx = focus.x, fz = focus.z;
    const jumped = !started || Math.hypot(fx - lastFx, fz - lastFz) > TELEPORT_DIST;
    lastFx = fx; lastFz = fz;
    // Ranges still queued mean the mesh was not drawn last frame: keep them, or fall back to one full upload.
    if (vb.updateRanges.length === 0) nVbRange = 0;
    else if (nVbRange > 2048) { vb.updateRanges.length = 0; nVbRange = 0; vb.needsUpdate = true; }

    // Heading low-pass. Its length drops through a reversal, which shrinks the forward reach instead of flipping it.
    const hl = heading ? Math.hypot(heading.x, heading.z) : 0;
    if (hl > 0.1) {
      const k = started ? 1 - Math.exp(-dt / HEADING_TAU) : 1;
      hx += (heading.x / hl - hx) * k;
      hz += (heading.z / hl - hz) * k;
    }
    if (jumped) reach = 0.12;
    reach = Math.min(1, reach + dt / REACH_TIME);
    started = true;

    // Window of tiles around the focus.
    const fcx = Math.round(fx / CELL), fcz = Math.round(fz / CELL);
    if (fcx !== winCx || fcz !== winCz) {
      winCx = fcx; winCz = fcz;
      for (let cz = fcz - HALF_Z; cz <= fcz + HALF_Z; cz++) {
        for (let cx = fcx - HALF_X; cx <= fcx + HALF_X; cx++) {
          const slot = mod(cx, WIN_W) + mod(cz, WIN_H) * WIN_W;
          if (slotCx[slot] !== cx || slotCz[slot] !== cz) assignSlot(slot, cx, cz);
        }
      }
      rebuildIndex();
      vb.needsUpdate = true;
      page.position.x = fcx * CELL;
      page.position.z = fcz * CELL;
    }

    // Rise / fold decisions: an egg-shaped region, longer ahead, with hysteresis.
    const hlen = Math.hypot(hx, hz);
    const ux = hlen > 1e-4 ? hx / hlen : 0, uz = hlen > 1e-4 ? hz / hlen : -1;
    const aheadFull = uz < 0 ? RISE_AHEAD + (RISE_AHEAD_UP - RISE_AHEAD) * -uz : RISE_AHEAD + (RISE_AHEAD_DOWN - RISE_AHEAD) * uz;
    const ahead = RISE_BEHIND + (aheadFull - RISE_BEHIND) * Math.min(1, hlen);
    const riseA = ahead * reach, riseS = RISE_SIDE * reach, riseB = RISE_BEHIND * reach;
    const foldA = riseA + HYSTERESIS, foldS = riseS + HYSTERESIS, foldB = riseB + HYSTERESIS;
    for (let slot = 0; slot < NSLOT; slot++) {
      const dx = slotCx[slot] - fx / CELL, dz = slotCz[slot] - fz / CELL;
      const a = dx * ux + dz * uz, s = dz * ux - dx * uz;
      if (slotUp[slot]) {
        const ra = a > 0 ? foldA : foldB;
        if ((a * a) / (ra * ra) + (s * s) / (foldS * foldS) > 1) trigger(slot, false, 0);
      } else {
        const ra = a > 0 ? riseA : riseB;
        if ((a * a) / (ra * ra) + (s * s) / (riseS * riseS) <= 1) trigger(slot, true, Math.sqrt(dx * dx + dz * dz));
      }
    }

    // Fixed-substep springs.
    acc += dt;
    let nSub = Math.floor(acc / Fold.SUBSTEP);
    acc -= nSub * Fold.SUBSTEP;
    if (nSub > MAX_SUBSTEPS) nSub = MAX_SUBSTEPS;
    const elapsed = nSub * Fold.SUBSTEP;
    simTime += elapsed;
    riseTokens = Math.min(BUCKET, riseTokens + elapsed * RISE_RATE);
    fallTokens = Math.min(BUCKET, fallTokens + elapsed * FALL_RATE);
    if (nSub > 0) {
      for (let k = nActive - 1; k >= 0; k--) {
        const slot = activeSlots[k];
        if (!stepTile(slot, nSub, elapsed) && settle(slot)) {
          slotActive[slot] = 0;
          activeSlots[k] = activeSlots[--nActive];
        }
      }
      if (trace && trace.id >= 0 && !trace.done) {
        const t = simTime - trace.t0;
        if (t <= trace.duration) trace.samples.push({ t, x: pool.x[trace.id] });
        else trace.done = true;
      }
    }
  }

  function isWalkable(x, z) {
    const bx = Math.round(x / CELL), bz = Math.round(z / CELL);
    const lx = x - bx * CELL, lz = z - bz * CELL;
    const homeTile = wfc.get(bx, bz);
    const home = defs.get(homeTile.id);
    if (home?.blocked) return false;
    // Obstacles can overhang a cell edge, so also test the neighbours on the near sides.
    const sx = lx > 0 ? 1 : -1, sz = lz > 0 ? 1 : -1;
    const nearX = Math.abs(lx) > CELL / 2 - 0.5 ? 1 : 0, nearZ = Math.abs(lz) > CELL / 2 - 0.5 ? 1 : 0;
    for (let j = 0; j <= nearZ; j++) {
      for (let i = 0; i <= nearX; i++) {
        const cx = bx + i * sx, cz = bz + j * sz;
        const t = i || j ? wfc.get(cx, cz) : homeTile;
        const def = defs.get(t.id);
        if (!def) continue;
        const o = def.obs[def.canon[t.rot & 3]];
        const px = x - cx * CELL, pz = z - cz * CELL;
        for (let k = 0; k < o.length; k += 3) {
          const ex = px - o[k], ez = pz - o[k + 1];
          if (ex * ex + ez * ez < o[k + 2] * o[k + 2]) return false;
        }
      }
    }
    return true;
  }

  function stats() { return { tilesUp, flapsMoving }; }

  // ------------------------------------------------------------------------------------------------ debug (tests)
  /** Arm a recorder: the next flap that starts rising from flat with mass in [minMass, maxMass] is sampled every frame. */
  function debugFlapTrace({ minMass = 0, maxMass = 9, duration = 2.2 } = {}) {
    trace = { id: -1, t0: 0, minMass, maxMass, duration, samples: [], done: false, mass: 0, name: '', fa: 0 };
  }
  function debugTraceResult() {
    return trace ? { done: trace.done, started: trace.id >= 0, mass: trace.mass, name: trace.name, foldAngle: trace.fa, samples: trace.samples } : null;
  }
  function debugState() {
    let nan = dbg.nan, below = 0, mnx = 1, mxx = 0, up = 0, flat = 0, moving = 0, vbNan = 0;
    for (let slot = 0; slot < NSLOT; slot++) {
      const proto = slotProto[slot];
      if (!proto) continue;
      for (let k = 0; k < proto.pieces.length; k++) {
        if (proto.pieces[k].fa === 0) continue;
        const i = slot * STRIDE + k;
        const x = pool.x[i];
        if (x !== x) nan++;
        if (x > 1.0000001) below++;
        if (x < mnx) mnx = x;
        if (x > mxx) mxx = x;
        const m = pool.mode[i];
        if (m === Fold.UP) up++; else if (m === Fold.FLAT) flat++; else moving++;
      }
      for (let k = slot * VCAP * VS, e = k + proto.vCount * VS; k < e; k++) if (vbData[k] !== vbData[k]) vbNan++;
    }
    return { nan, vbNan, belowFlat: below, minX: Math.min(mnx, dbg.minX), maxX: Math.max(mxx, dbg.maxX), up, flat, moving,
      activeTiles: nActive, tilesUp, flapsMoving, audioCalls: dbg.audioCalls, audioRise: dbg.audioRise, audioLand: dbg.audioLand,
      maxAudioPer100ms: dbg.maxPer100ms, tileUps: dbg.tileUps, tileDowns: dbg.tileDowns, flickers: dbg.flickers, simTime, reach, window: [WIN_W, WIN_H], geometries, stride: STRIDE,
      vertsPerSlot: VCAP, indices: tilesGeo.drawRange.count, liveBlocks: ACTIVE_MAX - nFree, liveBlocksMax: dbg.blocksMax,
      liveBlocksCap: ACTIVE_MAX, bufferMB: (vbData.byteLength + ibData.byteLength) / 1048576,
      pageColor: '#' + pageColor.getHexString(), fibreScale };
  }
  function debugReset() {
    dbg.audioCalls = dbg.audioRise = dbg.audioLand = dbg.maxPer100ms = dbg.winCount = dbg.blocksMax = dbg.tileUps = dbg.tileDowns = dbg.flickers = 0;
    dbg.minX = 1; dbg.maxX = 0;
  }
  function debugSet({ nudge, visible } = {}) {
    if (nudge !== undefined) nudgeOn = !!nudge;
    if (visible !== undefined) group.visible = !!visible;
  }
  function debugTile(cx, cz) {
    const t = wfc.get(cx, cz), slot = mod(cx, WIN_W) + mod(cz, WIN_H) * WIN_W;
    const inWin = slotCx[slot] === cx && slotCz[slot] === cz;
    return { id: t.id, rot: t.rot, drawnRot: tileRot(t), inWindow: inWin, up: inWin ? !!slotUp[slot] : false,
      x: inWin && slotProto[slot] ? Array.from(pool.x.subarray(slot * STRIDE, slot * STRIDE + slotProto[slot].pieces.length)) : [],
      pieces: inWin && slotProto[slot] ? slotProto[slot].pieces.map((p) => ({ name: p.name, fa: p.fa, mass: p.mass, size: p.size, layer: p.layer, lift: p.lift, parent: p.parent })) : [] };
  }
  /**
   * Is cell (cx, cz) really in the draw data right now? Checks the slot, its base vertices (inside the cell), its
   * triangles in the index buffer and that no upload is still queued. Call after the frame has rendered.
   */
  function debugCell(cx, cz) {
    const t = wfc.get(cx, cz), slot = mod(cx, WIN_W) + mod(cz, WIN_H) * WIN_W;
    const out = { id: t.id, rot: t.rot, drawnRot: tileRot(t), drawn: false, why: '' };
    const proto = slotProto[slot];
    if (slotCx[slot] !== cx || slotCz[slot] !== cz) { out.why = 'cell not in window'; return out; }
    if (!proto) { out.why = 'no prototype for ' + t.id; return out; }
    if (proto !== protos.get(t.id) || slotRot[slot] !== out.drawnRot) { out.why = 'slot holds another tile or rotation'; return out; }
    const base = proto.pieces.find((q) => q.isBase && q.hasMesh);
    if (!base) { out.why = 'tile has no base mesh'; return out; }
    for (let k = base.vOff; k < base.vOff + base.vCount; k++) {
      const o = (slot * VCAP + k) * VS;
      if (Math.abs(vbData[o] - cx * CELL) > CELL / 2 + 0.01 || Math.abs(vbData[o + 2] - cz * CELL) > CELL / 2 + 0.01 || vbData[o + 33] !== slot) {
        out.why = 'base vertex outside its cell'; return out;
      }
    }
    const i0 = slotIdxStart[slot], n = proto.indices.length;
    if (i0 < 0 || i0 + n > tilesGeo.drawRange.count) { out.why = 'triangles outside the draw range'; return out; }
    for (let k = 0; k < n; k += 97) if (ibData[i0 + k] !== proto.indices[k] + slot * VCAP) { out.why = 'index buffer mismatch'; return out; }
    if (vb.updateRanges.length > 0 || ib.updateRanges.length > 0) { out.why = 'upload still queued'; return out; }
    if (!tilesMesh.visible || !group.visible) { out.why = 'mesh hidden'; return out; }
    out.drawn = true;
    return out;
  }
  /** Flaps caught mid-rotation (fold fraction 0.1..0.9, bounding size >= minSize) on screen and in the sharp band. */
  const dv = new THREE.Vector3();
  function debugMoving(camera, focus, minSize = 0.45, band = 0.4) {
    dv.copy(focus).project(camera);
    const fy = dv.y;
    let inFrame = 0, inBand = 0, rising = 0, falling = 0;
    for (let k = 0; k < nActive; k++) {
      const slot = activeSlots[k], proto = slotProto[slot];
      if (!proto) continue;
      for (let i = 0; i < proto.pieces.length; i++) {
        const p = proto.pieces[i], id = slot * STRIDE + i, m = pool.mode[id], x = pool.x[id];
        if (p.fa === 0 || !p.hasMesh || p.size < minSize || !(m === Fold.RISING || m === Fold.FALLING) || x < 0.1 || x > 0.9) continue;
        let px = p.px, pz = p.pz;
        for (let r = 0; r < slotRot[slot]; r++) { const nx = -pz; pz = px; px = nx; }
        dv.set(slotCx[slot] * CELL + px, 0.2, slotCz[slot] * CELL + pz).project(camera);
        if (Math.abs(dv.x) > 0.96 || Math.abs(dv.y) > 0.96) continue;
        inFrame++;
        if (m === Fold.RISING) rising++; else falling++;
        if (Math.abs(dv.y - fy) <= band) inBand++;
      }
    }
    return { inFrame, inBand, rising, falling };
  }
  /** Pieces that still stand edge-on to the camera at a rotation the world can draw (projected / total area < 0.2). */
  function debugSlivers(limit = 0.2, minSize = 0.35) {
    const out = [];
    for (const [id, def] of defs) {
      const proto = protos.get(id);
      if (!proto) continue;
      for (const rot of new Set(def.canon)) {
        const names = proto.pieces.filter((q) => q.facing && q.size >= minSize && q.facing[rot] / q.area < limit)
          .map((q) => q.name + ' ' + (q.facing[rot] / q.area).toFixed(2));
        if (names.length) out.push({ id, rot, pieces: names });
      }
    }
    return out;
  }
  function debugPrograms(renderer) {
    return renderer.info.programs.filter((q) => q.cacheKey.includes('popup')).map((q) => (q.cacheKey.split(',')[0] || '?') + ' x' + q.usedTimes);
  }
  /** Plain top-down orthographic render of the scene (no post), returned as a PNG data URL. For alignment checks. */
  function debugTopDown(renderer, { x = 0, z = 0, span = 24 } = {}) {
    const size = renderer.getSize(new THREE.Vector2());
    const h = span * size.y / size.x;
    const cam = new THREE.OrthographicCamera(-span / 2, span / 2, h / 2, -h / 2, 0.1, 100);
    cam.position.set(x, 40, z);
    cam.up.set(0, 0, -1);
    cam.lookAt(x, 0, z);
    cam.updateMatrixWorld();
    const target = renderer.getRenderTarget();
    renderer.setRenderTarget(null);
    renderer.render(scene, cam);
    const url = renderer.domElement.toDataURL('image/png');
    renderer.setRenderTarget(target);
    return url;
  }

  return { update, isWalkable, stats, debugGroup: group, debugCell, debugMoving, debugSlivers, debugPrograms, debugTopDown, debugFlapTrace, debugTraceResult, debugState, debugReset,
    debugSet, debugTile };
}
