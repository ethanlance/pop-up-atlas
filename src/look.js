// Look: lights, soft shadows, tilt-shift depth of field, bloom, AgX tone map, vignette and grain.
// Contract: createLook({renderer, scene, camera}) -> { render(dt), resize(w,h), setFocus(Vector3) }.
// Frame: shadow map -> scene (HDR, MSAA, depth) -> AO (half res) -> CoC prep -> bokeh gather -> bloom -> composite.
import * as THREE from 'three';
import { addDebugCards } from './look_debug.js';
import { patchShadowChunk, patchTranslucency, SHADOW_RANGE } from './look_shadow.js';
import * as SH from './look_shaders.js';

// Direction from the focus to each light (three.js axes), from the concept frames.
const KEY_DIR = new THREE.Vector3(-0.668, 0.616, 0.417).normalize(); // concept azimuth, raised to 38 degrees
const FILL_DIR = new THREE.Vector3(0.360, 0.883, -0.302).normalize();
const KEY_COLOR = new THREE.Color().setRGB(1.0, 0.78, 0.52); // 3000 K seen at a 3900 K white balance, a little lifted
const FILL_COLOR = new THREE.Color().setRGB(0.44, 0.58, 1.0); // #7E90B8 at full value
const BOUNCE_DIR = new THREE.Vector3(0.80, 0.14, -0.50).normalize(); // light off the page onto card backs
const BOUNCE_COLOR = new THREE.Color().setRGB(1.0, 0.78, 0.55);
const TABLE_COLOR = new THREE.Color(0x3b2416);
const MAX_HEIGHT = 1.7; // tallest pop-up in world units; bounds the shadow volume
const CORNERS = [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, 1], [0, -1]]; // last two calibrate the CoC

export function createLook({ renderer, scene, camera }) {
  const params = new URLSearchParams(location.search);
  const low = params.get('q') === 'low';
  const num = (k, d) => (params.has(k) ? Number(params.get(k)) : d);
  const keyAngle = num('soft', 0.10); // angular diameter of the key in radians; sets the penumbra width

  // ---- lights -------------------------------------------------------------------------------------------------
  patchShadowChunk({ blockerTaps: num('btaps', low ? 8 : 16), filterTaps: num('ftaps', low ? 8 : 16) });
  patchTranslucency(num('through', 0.3));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.BasicShadowMap; // raw depth; the patched chunk does the PCSS filter
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.info.autoReset = false; // count the draw calls of all passes in one frame

  const key = new THREE.DirectionalLight(KEY_COLOR, num('key', 4.4));
  key.castShadow = true;
  const mapSize = num('smap', low ? 1024 : 2048);
  key.shadow.mapSize.set(mapSize, mapSize);
  key.shadow.bias = -0.034 / SHADOW_RANGE; // more than one card thickness: light reaches the back of a lit card
  key.shadow.normalBias = 0.003;
  key.shadow.camera.near = 0.1;
  key.shadow.camera.far = SHADOW_RANGE;
  const fill = new THREE.DirectionalLight(FILL_COLOR, num('fill', 0.27));
  const hemi = new THREE.HemisphereLight(new THREE.Color().setRGB(0.62, 0.50, 0.46),
    new THREE.Color().setRGB(0.95, 0.72, 0.50), num('amb', 0.62));
  const bounce = new THREE.DirectionalLight(BOUNCE_COLOR, num('bounce', 0.8));
  scene.add(key, key.target, fill, fill.target, bounce, bounce.target, hemi);

  // The page is endless, so nothing shows beyond it: a dark warm backdrop only.
  scene.background = TABLE_COLOR.clone().multiplyScalar(0.25);

  if (params.get('lookdebug')) addDebugCards(scene);

  // ---- render targets -----------------------------------------------------------------------------------------
  const hdr = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false };
  const rtScene = new THREE.WebGLRenderTarget(4, 4, { ...hdr, depthBuffer: true, samples: num('msaa', low ? 2 : 4) });
  rtScene.depthTexture = new THREE.DepthTexture(4, 4, THREE.UnsignedIntType);
  rtScene.depthTexture.minFilter = rtScene.depthTexture.magFilter = THREE.NearestFilter;
  const rtAo = new THREE.WebGLRenderTarget(4, 4, { depthBuffer: false });
  const rtPrep = new THREE.WebGLRenderTarget(4, 4, hdr);
  const rtGather = new THREE.WebGLRenderTarget(4, 4, hdr);
  const rtDof = new THREE.WebGLRenderTarget(4, 4, hdr);
  const rtBloom = [0, 1, 2].map(() => new THREE.WebGLRenderTarget(4, 4, hdr));

  // ---- full-screen passes -------------------------------------------------------------------------------------
  const fsGeo = new THREE.BufferGeometry();
  fsGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  const fsMesh = new THREE.Mesh(fsGeo);
  fsMesh.frustumCulled = false;
  const fsScene = new THREE.Scene();
  fsScene.add(fsMesh);
  const fsCam = new THREE.Camera();
  const pass = (fragmentShader, uniforms, extra = {}) => new THREE.ShaderMaterial({ vertexShader: SH.VERT,
    fragmentShader, uniforms, depthTest: false, depthWrite: false, toneMapped: false, ...extra });
  const U = (value) => ({ value });
  const lens = U(new THREE.Vector4(0.5, 200, 20, 100)); // near, far, focus depth, CoC gain in full-res pixels
  const cocLimit = U(new THREE.Vector2(1.2, 30)); // sharp-band knee and largest CoC, full-res pixels
  const texel = U(new THREE.Vector2()); // one full-res pixel in uv
  const projInfo = U(new THREE.Vector4()); // tan(fov/2)*aspect, tan(fov/2), AO radius, AO strength
  const aoTint = U(new THREE.Vector3(0.24, 0.21, 0.23)); // colour of a fully occluded crease (blue-violet)

  const aoMat = pass(SH.AO, { tDepth: U(rtScene.depthTexture), lens, cocLimit, texel, projInfo });
  const prepMat = pass(SH.PREP, { tScene: U(rtScene.texture), tDepth: U(rtScene.depthTexture), tAo: U(rtAo.texture),
    lens, cocLimit, texel, aoTint });
  const gatherMat = pass(SH.GATHER, { tPrep: U(rtPrep.texture), texel, cocLimit }, { defines: { TAPS: num('dtaps', low ? 28 : 44) } });
  const fillMat = pass(SH.FILL, { tMap: U(rtGather.texture), texel });
  const bloomDownMat = pass(SH.BLOOM_DOWN, { tMap: U(null), srcTexel: U(new THREE.Vector2()), threshold: U(0) });
  const bloomUpMat = pass(SH.BLOOM_UP, { tMap: U(null), srcTexel: U(new THREE.Vector2()) },
    { blending: THREE.AdditiveBlending, transparent: true });
  const finalMat = pass(SH.FINAL, { tScene: U(rtScene.texture), tDepth: U(rtScene.depthTexture), tAo: U(rtAo.texture),
    tDof: U(rtDof.texture), tBloom: U(rtBloom[0].texture), lens, cocLimit, texel, aoTint,
    exposure: U(num('exp', 1.05)), contrast: U(num('con', 1.34)), saturation: U(num('sat', 1.08)),
    bloom: U(new THREE.Vector4(1.0, 0.72, 0.5, num('bloom', 0.14))), vignette: U(num('vig', 0.27)),
    grain: U(num('grain', 0.022)), time: U(0), aspect: U(1), projInfo, camWorld: U(camera.matrixWorld),
    lantern: U(new THREE.Vector4()), pool: U(num('pool', 1.0)), aoDebug: U(num('aodbg', 0)) });
  const lampHeight = num('lamp', 2.6); // lamp above the page; lower = tighter pool
  const lampLead = num('lead', 1.0); // hot spot offset from the traveller toward the key, world units
  const useAo = !low && num('ao', 1) > 0;
  const dofOn = num('dof', 1) > 0;

  function blit(material, target) {
    fsMesh.material = material;
    renderer.setRenderTarget(target);
    renderer.render(fsScene, fsCam);
  }

  // ---- shadow frustum and CoC fit -----------------------------------------------------------------------------
  const focus = new THREE.Vector3(0, 0.3, 0);
  const lightX = new THREE.Vector3(), lightY = new THREE.Vector3(), camZ = new THREE.Vector3();
  const v = new THREE.Vector3(), dir = new THREE.Vector3();
  const size = new THREE.Vector2(4, 4);
  const clearColor = new THREE.Color();
  let shadowSize = 0;

  // Fits the shadow camera to the visible page. Returns |1 - centreDepth/depth| at the top/bottom of the page.
  function fitToView(centreDepth) {
    // Light basis that three.js builds from `up`: x = up x z, y = z x x, with z toward the light.
    v.set(0, 1, 0).applyQuaternion(camera.quaternion);
    key.shadow.camera.up.copy(v);
    lightX.crossVectors(v, KEY_DIR).normalize();
    lightY.crossVectors(KEY_DIR, lightX);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    let edgeDepth = 0;
    for (let i = 0; i < CORNERS.length; i++) {
      dir.set(CORNERS[i][0], CORNERS[i][1], 0.5).unproject(camera).sub(camera.position).normalize();
      for (let h = 0; h <= MAX_HEIGHT; h += MAX_HEIGHT) {
        const t = dir.y < -0.05 ? Math.min((h - camera.position.y) / dir.y, 90) : 90;
        if (i >= 4) {
          if (h === 0) edgeDepth = Math.max(edgeDepth, Math.abs(1 - centreDepth / (dir.dot(camZ) * t)));
          continue;
        }
        v.copy(camera.position).addScaledVector(dir, t);
        const lx = v.dot(lightX), ly = v.dot(lightY), lz = v.dot(KEY_DIR);
        x0 = Math.min(x0, lx); x1 = Math.max(x1, lx); y0 = Math.min(y0, ly); y1 = Math.max(y1, ly);
        z0 = Math.min(z0, lz); z1 = Math.max(z1, lz);
      }
    }
    // Square frustum in steps of 2 units, so the texel size stays constant while walking.
    const want = Math.min(Math.ceil((Math.max(x1 - x0, y1 - y0) + 1.5) / 2) * 2, 60);
    const cam = key.shadow.camera;
    if (want !== shadowSize) {
      shadowSize = want;
      cam.left = cam.bottom = -want / 2;
      cam.right = cam.top = want / 2;
      cam.updateProjectionMatrix();
      key.shadow.radius = (SHADOW_RANGE * keyAngle * 0.5) / want; // penumbra radius in uv per unit of depth
    }
    // Snap the centre to shadow texels and the depth to whole units: shadows do not swim.
    const tx = shadowSize / key.shadow.mapSize.x;
    const cx = Math.round((x0 + x1) / 2 / tx) * tx, cy = Math.round((y0 + y1) / 2 / tx) * tx;
    const cz = Math.round((z0 + z1) / 2);
    key.target.position.set(0, 0, 0).addScaledVector(lightX, cx).addScaledVector(lightY, cy).addScaledVector(KEY_DIR, cz);
    key.position.copy(key.target.position).addScaledVector(KEY_DIR, SHADOW_RANGE / 2);
    fill.target.position.copy(focus);
    fill.position.copy(focus).addScaledVector(FILL_DIR, 30);
    bounce.target.position.copy(focus);
    bounce.position.copy(focus).addScaledVector(BOUNCE_DIR, 30);
    return edgeDepth;
  }

  let time = 0;
  let focusDepth = -1;
  function render(dt = 0) {
    time += dt;
    renderer.info.reset();
    camera.updateMatrixWorld();
    camZ.set(0, 0, -1).applyQuaternion(camera.quaternion);
    // Focus distance: the traveller point, low-passed (0.45 s), so hops and camera lag do not pump the blur.
    const wantDepth = Math.max(v.copy(focus).sub(camera.position).dot(camZ), camera.near + 0.01);
    const jump = focusDepth < 0 || Math.abs(wantDepth - focusDepth) > 4;
    focusDepth = jump ? wantDepth : focusDepth + (wantDepth - focusDepth) * (1 - Math.exp(-dt / 0.45));
    // The gain is fitted to the depth at the frame centre, which is constant for a fixed rig: no pumping.
    dir.set(0, 0, 0.5).unproject(camera).sub(camera.position).normalize();
    const centreDepth = dir.y < -0.05 ? ((focus.y - camera.position.y) / dir.y) * dir.dot(camZ) : focusDepth;
    const edgeDepth = fitToView(centreDepth);
    // CoC in pixels = gain * (1 - focusDepth / depth); `blur` is the uncapped CoC at the top/bottom page edge.
    const edgeBlur = num('blur', 0.019) * size.y;
    const gain = dofOn ? Math.min(edgeBlur / Math.max(edgeDepth, 0.02), size.y * 0.5) : 0;
    lens.value.set(camera.near, camera.far, focusDepth, gain);
    cocLimit.value.set(num('band', 0.0075) * size.y, num('maxblur', 0.0085) * size.x); // cap 12 px at 1440 wide
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    projInfo.value.set(tanHalf * camera.aspect, tanHalf, num('aor', 0.07), num('ao', 1.0));
    finalMat.uniforms.time.value = time;
    const kh = Math.hypot(KEY_DIR.x, KEY_DIR.z);
    v.set(focus.x + (KEY_DIR.x / kh) * lampLead, lampHeight, focus.z + (KEY_DIR.z / kh) * lampLead);
    finalMat.uniforms.lantern.value.set(v.x, v.y, v.z, Math.hypot(lampLead, lampHeight));

    renderer.setRenderTarget(rtScene);
    renderer.render(scene, camera);
    if (useAo) blit(aoMat, rtAo);
    blit(prepMat, rtPrep);
    blit(gatherMat, rtGather);
    blit(fillMat, rtDof);
    // Bloom: three thresholded downsamples, then add each back up the chain.
    let src = rtDof;
    for (let i = 0; i < 3; i++) {
      bloomDownMat.uniforms.tMap.value = src.texture;
      bloomDownMat.uniforms.srcTexel.value.set(1 / src.width, 1 / src.height);
      bloomDownMat.uniforms.threshold.value = i === 0 ? num('bloomthr', 0.4) : 0;
      blit(bloomDownMat, rtBloom[i]);
      src = rtBloom[i];
    }
    renderer.autoClear = false; // the up passes add onto the level below
    for (let i = 2; i > 0; i--) {
      bloomUpMat.uniforms.tMap.value = rtBloom[i].texture;
      bloomUpMat.uniforms.srcTexel.value.set(1 / rtBloom[i].width, 1 / rtBloom[i].height);
      blit(bloomUpMat, rtBloom[i - 1]);
    }
    renderer.autoClear = true;
    blit(finalMat, null);
  }

  function resize() {
    renderer.getDrawingBufferSize(size);
    const w = Math.max(2, size.x), h = Math.max(2, size.y);
    const hw = Math.ceil(w / 2), hh = Math.ceil(h / 2);
    rtScene.setSize(w, h);
    rtAo.setSize(w, h);
    for (const rt of [rtPrep, rtGather, rtDof]) rt.setSize(hw, hh);
    rtBloom.forEach((rt, i) => rt.setSize(Math.max(1, hw >> (i + 1)), Math.max(1, hh >> (i + 1))));
    if (!useAo) { // AO off: the AO target stays white
      const alpha = renderer.getClearAlpha();
      renderer.getClearColor(clearColor);
      renderer.setRenderTarget(rtAo);
      renderer.setClearColor(0xffffff, 1);
      renderer.clear();
      renderer.setRenderTarget(null);
      renderer.setClearColor(clearColor, alpha);
    }
    texel.value.set(1 / w, 1 / h);
    finalMat.uniforms.aspect.value = h / w;
  }
  resize();

  return { render, resize, setFocus(p) { focus.copy(p); } };
}
