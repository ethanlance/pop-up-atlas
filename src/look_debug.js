// Test cards for tuning the look before the real world lands. Only built with `?lookdebug=1`.
import * as THREE from 'three';

const PAL = { cream: 0xeadfc6, ochre: 0xc9994f, terracotta: 0xb05a40, moss: 0x6e7d46, sage: 0x9fae84, teal: 0x5a9292,
  brown: 0x74492f };
const T = 0.016;

export function addDebugCards(scene) {
  const group = new THREE.Group();
  const mats = {};
  const mat = (name) => (mats[name] ??= new THREE.MeshStandardMaterial({ color: PAL[name], roughness: 0.92 }));
  const card = (shape, name, x, y, z, ry = 0, rx = 0) => {
    const geo = new THREE.ExtrudeGeometry(shape, { depth: T, bevelEnabled: false, curveSegments: 24 });
    const m = new THREE.Mesh(geo, mat(name));
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, 0);
    m.castShadow = m.receiveShadow = true;
    group.add(m);
    return m;
  };
  const hill = (w, h, bumps, phase) => {
    const s = new THREE.Shape();
    s.moveTo(-w / 2, 0);
    for (let i = 0; i <= 40; i++) {
      const u = i / 40;
      const env = Math.sin(Math.PI * u) ** 0.8;
      s.lineTo(-w / 2 + w * u, h * env * (0.72 + 0.28 * Math.sin(u * Math.PI * bumps + phase)));
    }
    s.lineTo(w / 2, 0);
    return s;
  };
  const leaf = (w, h) => {
    const s = new THREE.Shape();
    s.moveTo(0, 0);
    s.bezierCurveTo(w, h * 0.2, w * 0.8, h * 0.9, 0, h);
    s.bezierCurveTo(-w * 0.8, h * 0.9, -w, h * 0.2, 0, 0);
    return s;
  };
  const rect = (w, h) => {
    const s = new THREE.Shape();
    s.moveTo(-w / 2, 0); s.lineTo(w / 2, 0); s.lineTo(w / 2, h); s.lineTo(-w / 2, h);
    return s;
  };
  // Layered hill ranges, front layer lowest, 0.22 apart, like concept_04.
  const ranges = [[-3.2, -4.2], [3.6, -3.0], [-6.5, 1.5], [6.2, 2.6]];
  ranges.forEach(([x, z], r) => {
    const names = ['sage', 'moss', 'ochre', 'terracotta'];
    names.forEach((n, i) => card(hill(4.2 - i * 0.5, 0.45 + i * 0.26, 2 + i, r + i * 1.7), n, x + (i - 1.5) * 0.35, 0,
      z - i * 0.24, (r % 2 ? 0.12 : -0.08)));
  });
  // Trees: trunk card + leaf card.
  const trees = [[-1.6, 1.4, 'moss'], [1.9, 0.9, 'terracotta'], [3.1, 1.7, 'ochre'], [-3.4, 2.4, 'sage'], [0.6, -1.6, 'moss'],
    [-0.8, 3.2, 'ochre'], [5.0, -0.4, 'moss'], [-5.2, -1.2, 'terracotta'], [2.4, 4.2, 'sage'], [-2.2, -1.2, 'ochre']];
  trees.forEach(([x, z, n], i) => {
    const h = 0.7 + (i % 4) * 0.2;
    card(rect(0.06, h * 0.45), 'brown', x, 0, z, 0.1 * (i % 3 - 1));
    card(leaf(0.3 + (i % 3) * 0.06, h * 0.7), n, x, h * 0.35, z + 0.02, 0.1 * (i % 3 - 1));
  });
  // House: four walls and a two-card roof.
  const house = (x, z, ry, wall, roof) => {
    const g = new THREE.Group();
    const add = (shape, name, px, py, pz, rry, rrx = 0) => {
      const m = card(shape, name, px, py, pz, rry, rrx);
      group.remove(m); g.add(m);
    };
    add(rect(1.0, 0.6), wall, 0, 0, 0.35, 0);
    add(rect(1.0, 0.6), wall, 0, 0, -0.35, 0);
    add(rect(0.7, 0.6), wall, 0.5, 0, 0, Math.PI / 2);
    add(rect(0.7, 0.6), wall, -0.5, 0, 0, Math.PI / 2);
    add(rect(1.16, 0.6), roof, 0, 0.6, 0.42, 0, -Math.PI / 3.6);
    add(rect(1.16, 0.6), roof, 0, 0.6, -0.42, Math.PI, -Math.PI / 3.6);
    g.position.set(x, 0, z); g.rotation.y = ry;
    group.add(g);
  };
  house(-3.6, 0.3, 0.15, 'cream', 'terracotta');
  house(2.6, -1.0, -0.2, 'ochre', 'brown');
  house(4.6, 1.6, 0.3, 'cream', 'teal');
  // Printed river strip and path strip on the page.
  const strip = (w, d, name, x, z) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat(name));
    m.rotation.x = -Math.PI / 2; m.position.set(x, 0.003, z); m.receiveShadow = true;
    group.add(m);
  };
  strip(1.2, 30, 'teal', 7.6, 0);
  // Bridge arcs over the river.
  const arc = new THREE.Shape();
  arc.absarc(0, 0, 1.0, 0, Math.PI, false);
  arc.absarc(0, 0, 0.8, Math.PI, 0, true);
  card(arc, 'terracotta', 7.6, -0.25, 0.6, 0);
  card(arc, 'terracotta', 7.6, -0.25, 1.3, 0);
  scene.add(group);
  return group;
}
