// Shared drawing kit for the island: Mytopia's palette, materials, primitives, the vertex-colour Batch, the seeded RNG
// and a canvas-texture helper. Pre-existing recipes (materials, box/cyl/ball/grp/pyramid, Batch, the RNG) come from
// Mytopia's campus.js (see ASSETS.md); gathered here on 2026-11-07 so world.js, buildings.js, actors.js and room.js
// share one copy. Nothing in this file knows about events.
const PI = Math.PI;

export function makeKit(THREE, seed0 = 20261107) {
  // deterministic randomness, so the island looks the same on every load
  let seed = seed0;
  const rnd = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const rr = (a, b) => a + rnd() * (b - a);
  const pick = (a) => a[Math.floor(rnd() * a.length)];

  // ---------- materials (Mytopia palette; flat, matte, no neon) ----------
  const M = {};
  const mat = (name, color, o = {}) => (M[name] = new THREE.MeshStandardMaterial({
    name, color, roughness: o.r ?? 0.85, metalness: o.m ?? 0, flatShading: true, emissive: o.e ?? 0x000000, emissiveIntensity: o.ei ?? 1,
    transparent: o.op !== undefined, opacity: o.op ?? 1, vertexColors: !!o.vc,
  }));
  mat('terrain', 0xffffff, { vc: true, r: 0.95 });
  mat('wood', 0xc08a55); mat('wood_dark', 0x8a5a36); mat('wood_light', 0xdcb07a); mat('plank', 0xcf9a62);
  mat('roof_tile', 0xc4583d, { r: 0.8 }); mat('roof_slate', 0x63738a, { r: 0.8 });
  mat('brick', 0xb4553e); mat('brick_dark', 0x8c3f2f);
  mat('stone', 0xdcd2ba); mat('stone_dark', 0xa49b89); mat('rock', 0x8d8579);
  mat('plaster', 0xf4e7c9); mat('copper', 0x86b9a4, { r: 0.6 }); mat('mustard', 0xe7b94e); mat('paper', 0xfbf7ee);
  mat('window', 0x9fd0e1, { r: 0.2, e: 0x3d7a90, ei: 0.15 });
  mat('window_lit', 0xffd27a, { e: 0xffb347, ei: 0.5, r: 0.5 });
  mat('window_dark', 0x4e5f6b, { r: 0.3 });
  mat('ink', 0x3a312b, { r: 0.6 }); mat('metal', 0xc5c8c6, { r: 0.4, m: 0.3 });
  mat('lamp_glow', 0xffe2a0, { e: 0xffb84a, ei: 1.1 });
  mat('leaf_a', 0x5f9f47); mat('leaf_b', 0x4b8a3d); mat('leaf_c', 0x7cb856); mat('leaf_d', 0x3f7b3c); mat('trunk', 0x7a5232);
  mat('ivy', 0x4f8c3a); mat('grass_top', 0x7fbc5c); mat('soil', 0x6b4a32);
  mat('robot_grey', 0x6f6b66, { r: 0.5, m: 0.2 }); mat('robot_cream', 0xeadfc6, { r: 0.4 });
  mat('robot_mustard', 0xe0b347, { r: 0.4 }); mat('robot_sage', 0x9cc29c, { r: 0.4 }); mat('robot_sky', 0x9fc6dc, { r: 0.4 }); mat('robot_orange', 0xf2892b, { r: 0.3 });
  mat('uniform', 0x2f3b55, { r: 0.6 }); mat('uniform_dark', 0x1f2738, { r: 0.6 }); mat('tread_black', 0x2a2724, { r: 0.6 });
  mat('eye', 0x141110, { r: 0.2 }); mat('eye_glint', 0xffffff, { e: 0xffffff, ei: 0.6 }); mat('eye_off', 0x4a4440, { r: 0.4 });
  mat('fl_pink', 0xf2a0b8); mat('fl_yellow', 0xf6d65e); mat('fl_white', 0xfbf5e6); mat('fl_red', 0xe2594b);
  mat('stripe_red', 0xc4483a); mat('stripe_white', 0xf6efe0); mat('velvet', 0x8e2b3a); mat('brass', 0xd9a032, { r: 0.4, m: 0.3 });
  mat('mailbox', 0x3b6fa8); mat('rope', 0xd8c39a, { r: 0.9 }); mat('cloud', 0xfbf7ee, { r: 1 });
  mat('slip_ok', 0xeaf5e6, { r: 0.9 }); mat('slip_bad', 0xf6dfd8, { r: 0.9 });
  mat('packet', 0xea7a6b, { e: 0xd8432f, ei: 0.35 });
  mat('lamp_off', 0x8a8278, { r: 0.7 }); mat('lamp_ok', 0x7fd49a, { e: 0x3fbf6a, ei: 0.7 }); mat('lamp_bad', 0xea7a6b, { e: 0xd8432f, ei: 0.7 });

  // ---------- primitives ----------
  const GC = {};
  const gBox = (x, y, z) => GC[`b${x},${y},${z}`] ||= new THREE.BoxGeometry(x, y, z);
  const gCyl = (a, b, h, s = 12) => GC[`c${a},${b},${h},${s}`] ||= new THREE.CylinderGeometry(a, b, h, s);
  const gCone = (r, h, s = 4) => GC[`k${r},${h},${s}`] ||= new THREE.ConeGeometry(r, h, s);
  const gIco = (d = 1) => GC['i' + d] ||= new THREE.IcosahedronGeometry(1, d);
  const put = (p, geo, m, name, x = 0, y = 0, z = 0) => { const o = new THREE.Mesh(geo, typeof m === 'string' ? M[m] : m); o.name = name; o.position.set(x, y, z); p.add(o); return o; };
  const box = (p, m, n, sx, sy, sz, x = 0, y = 0, z = 0) => put(p, gBox(sx, sy, sz), m, n, x, y + sy / 2, z);
  const cyl = (p, m, n, r1, r2, h, x = 0, y = 0, z = 0, s = 12) => put(p, gCyl(r1, r2, h, s), m, n, x, y + h / 2, z);
  const ball = (p, m, n, r, x, y, z, d = 1) => { const o = put(p, gIco(d), m, n, x, y, z); o.scale.setScalar(r); return o; };
  const grp = (p, name, x = 0, y = 0, z = 0, ry = 0) => { const g = new THREE.Group(); g.name = name; g.position.set(x, y, z); g.rotation.y = ry; p.add(g); return g; };
  const pyramid = (p, m, n, r, h, x, y, z) => { const o = put(p, gCone(r, h, 4), m, n, x, y + h / 2, z); o.rotation.y = PI / 4; return o; };
  const CC = {}; const C = (hex) => CC[hex] ||= new THREE.Color(hex);

  // vertex-coloured box batches (the terrain)
  class Batch {
    constructor() { this.p = []; this.c = []; }
    quad(a, b, c, d, col) { for (const v of [a, b, c, a, c, d]) { this.p.push(v[0], v[1], v[2]); this.c.push(col.r, col.g, col.b); } }
    box(x0, y0, z0, x1, y1, z1, top, side, bottom = side) {
      this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], top);
      this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], bottom);
      this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], side);
      this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], side);
      this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], side);
      this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], side);
    }
    mesh(parent, name, m = 'terrain') {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
      g.computeVertexNormals();
      const o = new THREE.Mesh(g, M[m]); o.name = name; parent.add(o); return o;
    }
  }

  // a 2D canvas as a texture, for signboards and the clock face (big letters only: the half-resolution render blurs small text)
  const canvasTex = (w, h, draw) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d');
    draw(g, c); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.magFilter = THREE.NearestFilter; t.minFilter = THREE.LinearFilter;
    return { c, g, t, redraw: (f) => { f(g, c); t.needsUpdate = true; } };
  };
  const signMat = (tex) => new THREE.MeshBasicMaterial({ map: tex.t, toneMapped: false });

  return { PI, rnd, rr, pick, M, mat, GC, gBox, gCyl, gCone, gIco, put, box, cyl, ball, grp, pyramid, C, Batch, canvasTex, signMat };
}
