// The island in three.js. It only knows HOW to draw; the reducer decides WHAT.
// Pre-existing: the materials, geometry helpers, windowOn/door/archWindow/gableRoof, the terrain batch, tree/bush/lamp/fence,
// the robot body and the four building shapes are copied from Mytopia's campus.js (see ASSETS.md). The layout, gatehouse,
// plates, lamps, sparks, smoke/fire and walking are new this weekend.
const PI = Math.PI;

export async function createScene(stage) {
  const { THREE } = await stage.ready;
  const world = new THREE.Group(); world.name = 'mytopia_island';

  // deterministic randomness, so the island looks the same on every load (Mytopia's seeded RNG)
  let seed = 20261107;
  const rnd = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const rr = (a, b) => a + rnd() * (b - a);
  const pick = (a) => a[Math.floor(rnd() * a.length)];

  // ---------- materials (Mytopia palette) ----------
  const M = {};
  const mat = (name, color, o = {}) => (M[name] = new THREE.MeshStandardMaterial({
    name, color, roughness: o.r ?? 0.85, metalness: o.m ?? 0, flatShading: true, emissive: o.e ?? 0x000000, emissiveIntensity: o.ei ?? 1,
    transparent: o.op !== undefined, opacity: o.op ?? 1, vertexColors: !!o.vc,
  }));
  mat('terrain', 0xffffff, { vc: true, r: 0.95 });
  mat('wood', 0xc08a55); mat('wood_dark', 0x8a5a36); mat('wood_light', 0xdcb07a);
  mat('roof_tile', 0xc4583d, { r: 0.8 }); mat('roof_slate', 0x63738a, { r: 0.8 });
  mat('brick', 0xb4553e); mat('brick_dark', 0x8c3f2f);
  mat('stone', 0xdcd2ba); mat('stone_dark', 0xa49b89); mat('rock', 0x8d8579);
  mat('plaster', 0xf4e7c9); mat('copper', 0x86b9a4, { r: 0.6 }); mat('mustard', 0xe7b94e); mat('paper', 0xfbf7ee);
  mat('window', 0x9fd0e1, { r: 0.2, e: 0x3d7a90, ei: 0.15 });
  mat('window_lit', 0xffd27a, { e: 0xffb347, ei: 0.5, r: 0.5 });
  mat('ink', 0x3a312b, { r: 0.6 }); mat('metal', 0xc5c8c6, { r: 0.4, m: 0.3 });
  mat('lamp_glow', 0xffe2a0, { e: 0xffb84a, ei: 1.1 });
  mat('leaf_a', 0x5f9f47); mat('leaf_b', 0x4b8a3d); mat('leaf_c', 0x7cb856); mat('leaf_d', 0x3f7b3c); mat('trunk', 0x7a5232);
  mat('ivy', 0x4f8c3a); mat('grass_top', 0x7fbc5c); mat('soil', 0x6b4a32);
  mat('robot_grey', 0x6f6b66, { r: 0.5, m: 0.2 }); mat('robot_cream', 0xeadfc6, { r: 0.4 });
  mat('robot_mustard', 0xe0b347, { r: 0.4 }); mat('robot_sage', 0x9cc29c, { r: 0.4 }); mat('robot_sky', 0x9fc6dc, { r: 0.4 }); mat('robot_orange', 0xf2892b, { r: 0.3 });
  mat('eye', 0x141110, { r: 0.2 }); mat('eye_glint', 0xffffff, { e: 0xffffff, ei: 0.6 });
  mat('fl_pink', 0xf2a0b8); mat('fl_yellow', 0xf6d65e); mat('fl_white', 0xfbf5e6); mat('fl_red', 0xe2594b);
  mat('stripe_red', 0xc4483a); mat('stripe_white', 0xf6efe0); mat('velvet', 0x8e2b3a); mat('brass', 0xd9a032, { r: 0.4, m: 0.3 });
  mat('mailbox', 0x3b6fa8);

  // ---------- primitives (Mytopia campus.js) ----------
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
    mesh(name, m) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
      g.computeVertexNormals();
      const o = new THREE.Mesh(g, M[m]); o.name = name; world.add(o); return o;
    }
  }

  // ---------- one island of tiles (Mytopia's terrain recipe, smaller) ----------
  const R = 11.5;
  const edgeR = (a) => R + 0.9 * Math.sin(3 * a + 0.5) + 0.6 * Math.sin(5 * a + 2) + 0.35 * Math.sin(9 * a);
  const K = (x, z) => x + ',' + z;
  const land = new Map();
  for (let x = -15; x <= 15; x++) for (let z = -15; z <= 15; z++) {
    const d = Math.hypot(x, z), e = edgeR(Math.atan2(z, x)) - d;
    if (e > 0) land.set(K(x, z), { x, z, type: 'grass', e });
  }
  function brush(pts, rad, type) {
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, az] = pts[i], [bx, bz] = pts[i + 1], L = Math.hypot(bx - ax, bz - az);
      for (let s = 0; s <= L; s += 0.2) {
        const px = ax + (bx - ax) * s / L, pz = az + (bz - az) * s / L;
        for (let x = Math.floor(px - rad); x <= Math.ceil(px + rad); x++) for (let z = Math.floor(pz - rad); z <= Math.ceil(pz + rad); z++) {
          if (Math.hypot(x - px, z - pz) <= rad) { const t = land.get(K(x, z)); if (t) t.type = type; }
        }
      }
    }
  }
  // Doors the robots walk to, and the paths that join them to the plaza.
  const SPOT = {
    gate: [0, 9.4], rope: [4.4, 9.4],
    files: [-5.2, -1.4], github: [5.2, -1.4], mail: [-3.9, 3.2], admin: [6.6, 5.0], plaza: [0, 2.2],
  };
  brush([[0, 12.5], [0, 1]], 1.05, 'stone');
  brush([[0, 1.6], [-5.2, -1.4]], 0.6, 'dirt'); brush([[0, 1.6], [5.2, -1.4]], 0.6, 'dirt');
  brush([[0, 3.2], [-3.9, 3.2]], 0.6, 'dirt'); brush([[0, 3.2], [4.2, 4.4], [6.6, 5.0]], 0.6, 'dirt');
  const grassCols = ['#6fa94f', '#79b357', '#84bd60', '#8ec668', '#99cd72'];
  const tb = new Batch(), db = new Batch();
  for (const t of land.values()) {
    const n = Math.sin(t.x * 0.35) + Math.cos(t.z * 0.31) + Math.sin((t.x + t.z) * 0.18);
    let top;
    if (t.type === 'grass') top = grassCols[Math.max(0, Math.min(4, Math.floor((n + 3) / 6 * 5 + rr(-0.9, 0.9))))];
    else top = pick(['#d4aa74', '#cb9f69', '#dbb480']);
    const topC = C(top).clone(); if ((t.x + t.z) & 1) topC.multiplyScalar(0.95);
    const depth = Math.round((1.2 + Math.min(t.e, 7) * 0.8 + rnd() * 1.4) * 2) / 2;
    const lip = t.type === 'grass' ? '#5e9541' : '#a77c4f';
    const x0 = t.x - 0.5, x1 = t.x + 0.5, z0 = t.z - 0.5, z1 = t.z + 0.5;
    tb.box(x0, -0.3, z0, x1, 0, z1, topC, C(lip));
    const dirtCol = C((t.x + t.z) & 1 ? '#8d6040' : '#835a3c');
    tb.box(x0, Math.max(-2.2, -depth), z0, x1, -0.3, z1, dirtCol, dirtCol);
    if (depth > 2.2) { const rc = C((t.x * 3 + t.z) % 2 ? '#8f877b' : '#7f776c'); tb.box(x0, -depth, z0, x1, -2.2, z1, rc, rc); }
  }
  // paving stones on the avenue
  for (const t of land.values()) if (t.type === 'stone') {
    const sc = pick(['#ddd4c0', '#d1c7b1', '#e6dfcc', '#c7bda6']);
    db.box(t.x - 0.42, 0, t.z - 0.42, t.x + 0.42, 0.07, t.z + 0.42, C(sc), C('#a99f8a'));
  }
  tb.mesh('island_tiles', 'terrain'); db.mesh('paving', 'terrain');

  // ---------- building helpers (Mytopia campus.js) ----------
  function windowOn(p, w, h, x, y, z, ry, lit = false, fm = 'wood_light', cross = true) {
    const g = grp(p, 'window', x, y, z, ry);
    box(g, lit ? 'window_lit' : 'window', 'window_glass', w, h, 0.04);
    box(g, fm, 'window_frame', w + 0.16, 0.08, 0.12, 0, -0.08, 0.02); box(g, fm, 'window_frame', w + 0.16, 0.08, 0.12, 0, h, 0.02);
    box(g, fm, 'window_frame', 0.08, h, 0.12, -w / 2 - 0.04, 0, 0.02); box(g, fm, 'window_frame', 0.08, h, 0.12, w / 2 + 0.04, 0, 0.02);
    if (cross) { box(g, fm, 'window_mullion', 0.05, h, 0.08, 0, 0, 0.02); box(g, fm, 'window_mullion', w, 0.05, 0.08, 0, h * 0.55, 0.02); }
    box(g, fm, 'window_sill', w + 0.3, 0.06, 0.2, 0, -0.14, 0.06);
    return g;
  }
  function door(p, w, h, x, y, z, ry, m = 'wood_dark', fm = 'wood_light') {
    const g = grp(p, 'door', x, y, z, ry);
    box(g, m, 'door_panel', w, h, 0.06); box(g, fm, 'door_frame', w + 0.2, 0.1, 0.12, 0, h, 0.02);
    box(g, fm, 'door_frame', 0.1, h, 0.12, -w / 2 - 0.05, 0, 0.02); box(g, fm, 'door_frame', 0.1, h, 0.12, w / 2 + 0.05, 0, 0.02);
    box(g, 'mustard', 'door_knob', 0.07, 0.07, 0.06, w / 2 - 0.15, h * 0.48, 0.05);
    return g;
  }
  function archWindow(p, w, h, x, y, z, ry, m = 'window') {
    const g = grp(p, 'arched_window', x, y, z, ry);
    box(g, m, 'arch_glass', w, h, 0.04);
    const top = put(g, GC['hd' + w] ||= new THREE.CylinderGeometry(w / 2, w / 2, 0.04, 16, 1, false, PI / 2, PI), m, 'arch_glass_top', 0, h, 0); top.rotation.x = PI / 2;
    put(g, GC['ta' + w] ||= new THREE.TorusGeometry(w / 2 + 0.05, 0.06, 4, 16, PI), 'stone', 'arch_frame', 0, h, 0.03);
    box(g, 'stone', 'arch_frame', 0.12, h, 0.12, -w / 2 - 0.05, 0, 0.02); box(g, 'stone', 'arch_frame', 0.12, h, 0.12, w / 2 + 0.05, 0, 0.02);
    box(g, 'stone', 'arch_sill', w + 0.32, 0.08, 0.22, 0, -0.1, 0.06);
    return g;
  }
  function gableRoof(p, W, D, rise, ov, y, m, endMat, rows = true) {
    const g = grp(p, 'roof', 0, y, 0);
    const th = Math.atan2(rise, D / 2), hd = D / 2 + ov, L = hd / Math.cos(th);
    for (const s of [1, -1]) {
      const pl = put(g, gBox(W + 2 * ov, 0.16, L), m, 'roof_plane', 0, rise - hd * Math.tan(th) / 2 + 0.08 / Math.cos(th), s * hd / 2);
      pl.rotation.x = s * th;
      if (rows) for (let u = -L / 2 + 0.22; u < L / 2 - 0.1; u += 0.42) put(pl, gBox(W + 2 * ov, 0.05, 0.08), m, 'roof_tile_row', 0, 0.1, u);
    }
    put(g, gBox(W + 2 * ov + 0.1, 0.16, 0.28), m === 'roof_tile' ? 'brick_dark' : 'stone_dark', 'roof_ridge', 0, rise + 0.16, 0);
    if (endMat) {
      const sh = new THREE.Shape(); sh.moveTo(-D / 2, 0); sh.lineTo(D / 2, 0); sh.lineTo(0, rise); sh.closePath();
      const eg = new THREE.ExtrudeGeometry(sh, { depth: 0.1, bevelEnabled: false });
      for (const s of [1, -1]) { const e = put(g, eg, endMat, 'gable_end', s > 0 ? W / 2 - 0.1 : -W / 2, 0, 0); e.rotation.y = PI / 2; }
    }
    return g;
  }
  function tree(x, z, s = 1) {
    const g = grp(world, 'tree', x, 0, z, rnd() * PI * 2);
    if (rnd() < 0.25) { cyl(g, 'trunk', 'pine_trunk', 0.12 * s, 0.16 * s, 0.6 * s, 0, 0, 0, 6); for (let i = 0; i < 3; i++) put(g, gCone((1.0 - i * 0.24) * s, (1.1 - i * 0.1) * s, 7), 'leaf_d', 'pine_tier', 0, (0.5 + i * 0.6 + 0.55) * s, 0); return; }
    cyl(g, 'trunk', 'trunk', 0.13 * s, 0.19 * s, 1.0 * s, 0, 0, 0, 6);
    const m1 = pick(['leaf_a', 'leaf_b', 'leaf_c']), m2 = pick(['leaf_a', 'leaf_b', 'leaf_c']);
    ball(g, m1, 'canopy', 0.95 * s, 0, 1.6 * s, 0); ball(g, m2, 'canopy', 0.62 * s, 0.55 * s, 1.25 * s, 0.25 * s); ball(g, m1, 'canopy', 0.55 * s, -0.45 * s, 1.35 * s, -0.35 * s);
  }
  function bush(x, z, s = 1, flowers = false) {
    const g = grp(world, 'bush', x, 0, z, rnd() * PI); const m = pick(['leaf_a', 'leaf_c', 'leaf_b']);
    ball(g, m, 'bush_ball', 0.48 * s, 0, 0.36 * s, 0); ball(g, m, 'bush_ball', 0.34 * s, 0.38 * s, 0.26 * s, 0.1 * s);
    if (flowers) { const fm = pick(['fl_pink', 'fl_white', 'fl_yellow']); for (let i = 0; i < 5; i++) { const a = rnd() * PI * 2; box(g, fm, 'bush_flower', 0.1, 0.1, 0.1, Math.cos(a) * 0.42 * s, rr(0.4, 0.7) * s, Math.sin(a) * 0.42 * s); } }
  }
  function lamp(x, z) {
    const g = grp(world, 'street_lamp', x, 0, z);
    box(g, 'stone_dark', 'lamp_base', 0.3, 0.2, 0.3); cyl(g, 'ink', 'lamp_post', 0.05, 0.065, 2.0, 0, 0.2, 0, 8);
    box(g, 'ink', 'lamp_collar', 0.34, 0.06, 0.34, 0, 2.18, 0); box(g, 'lamp_glow', 'lamp_lantern', 0.26, 0.34, 0.26, 0, 2.24, 0); pyramid(g, 'ink', 'lamp_roof', 0.3, 0.24, 0, 2.58, 0);
  }
  function fence(pts) {
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, az] = pts[i], [bx, bz] = pts[i + 1], L = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.round(L));
      for (let k = 0; k <= n; k++) { const x = ax + (bx - ax) * k / n, z = az + (bz - az) * k / n; box(world, 'wood', 'fence_post', 0.12, 0.72, 0.12, x, 0, z); }
      const g = grp(world, 'fence_rails', (ax + bx) / 2, 0, (az + bz) / 2, -Math.atan2(bz - az, bx - ax));
      box(g, 'wood_light', 'fence_rail', L, 0.07, 0.05, 0, 0.28, 0); box(g, 'wood_light', 'fence_rail', L, 0.07, 0.05, 0, 0.54, 0);
    }
  }

  // ---------- the five places ----------
  const PLACES = {}; // key -> { g, roof: Vector3 (top, for lamps/smoke/sparks), lampMat }
  const roofLamp = (key, g, y) => {
    const m = new THREE.MeshStandardMaterial({ name: 'roof_lamp_' + key, color: 0x8a8278, emissive: 0x000000, flatShading: true });
    const post = grp(g, 'roof_lamp', 0, y, 0); cyl(post, 'ink', 'lamp_stem', 0.04, 0.04, 0.5, 0, 0, 0, 6);
    box(post, m, 'roof_lamp_cube', 0.36, 0.36, 0.36, 0, 0.5, 0);
    return m;
  };
  const register = (key, g, roofY) => {
    g.updateMatrixWorld(true);
    const roof = new THREE.Vector3(0, roofY, 0); g.localToWorld(roof);
    PLACES[key] = { g, roof, lampMat: roofLamp(key, g, roofY) };
  };

  // Files = the brick library (Mytopia's Long-term Library, scaled down)
  {
    const g = grp(world, 'files_library', -5.2, 0, -5.0, 0);
    const W = 6, D = 4, H = 3.1, B = 0.4;
    box(g, 'stone', 'library_base', W + 0.4, B, D + 0.4);
    box(g, 'brick', 'library_walls', W, H, D, 0, B, 0);
    for (const y of [B + 1.0, B + 2.2]) box(g, 'brick_dark', 'library_brick_band', W + 0.02, 0.08, D + 0.02, 0, y, 0);
    for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) for (let i = 0, y = B; y < B + H - 0.2; i++, y += 0.36) box(g, 'stone', 'library_quoin', i % 2 ? 0.36 : 0.5, 0.3, i % 2 ? 0.5 : 0.36, x * W / 2, y, z * D / 2);
    box(g, 'stone', 'library_cornice', W + 0.35, 0.25, D + 0.35, 0, B + H, 0);
    for (const x of [-2.1, 2.1]) archWindow(g, 0.8, 1.4, x, B + 0.6, D / 2, 0, 'window_lit');
    for (const s of [1, -1]) archWindow(g, 0.8, 1.4, s * W / 2, B + 0.6, 0, s * PI / 2);
    door(g, 1.0, 1.6, 0, B, D / 2, 0, 'wood_dark', 'stone');
    for (const x of [-1.0, 1.0]) { cyl(g, 'stone', 'library_column', 0.15, 0.17, 2.2, x, B, D / 2 + 0.5, 12); }
    box(g, 'stone', 'portico_slab', 2.6, 0.2, 1.1, 0, B + 2.2, D / 2 + 0.35);
    box(g, 'stone', 'library_step', 2.6, 0.2, 0.5, 0, 0, D / 2 + 1.1);
    gableRoof(g, W, D, 1.4, 0.35, B + H + 0.25, 'roof_slate', 'brick');
    register('files', g, B + H + 0.25 + 1.6);
  }
  // GitHub = the glass studio (Mytopia's Swing Studio)
  {
    const g = grp(world, 'github_studio', 5.2, 0, -5.0, 0);
    const W = 5.4, D = 4, H = 2.8, B = 0.25;
    box(g, 'stone_dark', 'studio_slab', W + 0.4, B, D + 0.4);
    box(g, 'wood_dark', 'studio_body', W, H, D, 0, B, 0);
    for (const s of [1, -1]) for (let z = -D / 2 + 0.3; z < D / 2; z += 0.38) box(g, 'wood', 'studio_cladding', 0.03, H - 0.1, 0.05, s * (W / 2 + 0.015), B + 0.05, z);
    const pw = (W - 0.6) / 4;
    for (let i = 0; i < 4; i++) box(g, i === 1 || i === 2 ? 'window_lit' : 'window', 'studio_glass_pane', pw - 0.02, H - 0.45, 0.04, -W / 2 + 0.3 + pw * (i + 0.5), B + 0.15, D / 2 + 0.01);
    for (let i = 0; i <= 4; i++) box(g, 'ink', 'studio_mullion', 0.07, H - 0.4, 0.1, -W / 2 + 0.3 + pw * i, B + 0.13, D / 2 + 0.03);
    box(g, 'ink', 'studio_transom', W - 0.5, 0.07, 0.1, 0, B + H - 0.32, D / 2 + 0.03);
    box(g, 'stone', 'studio_roof', W + 0.6, 0.22, D + 0.6, 0, B + H, 0);
    const ry = B + H + 0.22;
    box(g, 'grass_top', 'roof_lawn', W - 0.4, 0.06, D - 0.4, 0, ry, 0);
    for (const [x, z] of [[-1.6, -1.1], [1.6, -1.1]]) { box(g, 'wood', 'roof_planter', 1.3, 0.3, 0.5, x, ry, z); ball(g, 'leaf_c', 'roof_plant', 0.3, x, ry + 0.45, z); }
    box(g, 'wood', 'studio_deck', W, 0.16, 1.1, 0, 0, D / 2 + 0.75);
    register('github', g, ry + 0.1);
  }
  // Mail = the cottage with flower boxes (Mytopia's Welcome Center) + a new mailbox
  {
    const g = grp(world, 'mail_cottage', -7.0, 0, 3.2, PI / 2);
    const W = 4, D = 3.4, H = 2.3, B = 0.25;
    box(g, 'stone', 'cottage_base', W + 0.4, B, D + 0.4);
    box(g, 'plaster', 'cottage_walls', W, H, D, 0, B, 0);
    for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) box(g, 'wood_dark', 'timber_post', 0.2, H, 0.2, x * W / 2, B, z * D / 2);
    box(g, 'wood_dark', 'timber_beam', W + 0.04, 0.14, D + 0.04, 0, B + H - 0.14, 0);
    for (const s of [1, -1]) {
      windowOn(g, 0.6, 0.65, s * 1.35, B + 1.2, D / 2, 0, true, 'wood_dark');
      box(g, 'wood', 'flower_box', 0.9, 0.2, 0.25, s * 1.35, B + 0.82, D / 2 + 0.14);
      for (let i = 0; i < 4; i++) box(g, pick(['fl_pink', 'fl_yellow', 'fl_red', 'fl_white']), 'flower', 0.13, 0.13, 0.13, s * 1.35 - 0.33 + i * 0.22, B + 1.02, D / 2 + 0.14);
    }
    door(g, 0.9, 1.75, 0, B, D / 2, 0, 'mustard', 'wood_dark');
    gableRoof(g, W, D, 1.5, 0.35, B + H, 'roof_tile', 'plaster');
    box(g, 'stone', 'cottage_chimney', 0.5, 1.4, 0.5, -1.2, B + H + 0.6, -0.7);
    const mb = grp(g, 'mailbox', 1.9, 0, D / 2 + 1.2);
    box(mb, 'wood_dark', 'mailbox_post', 0.12, 1.0, 0.12); box(mb, 'mailbox', 'mailbox_box', 0.4, 0.34, 0.6, 0, 1.0, 0); box(mb, 'fl_red', 'mailbox_flag', 0.04, 0.3, 0.14, 0.22, 1.15, 0.1);
    register('mail', g, B + H + 1.7);
  }
  // Admin = the columned courthouse (Mytopia's Quality Court)
  {
    const g = grp(world, 'admin_court', 6.6, 0, 1.6, 0);
    const W = 4.4, D = 3.2, H = 2.6;
    box(g, 'stone', 'court_stylobate', W + 1.0, 0.24, D + 1.6, 0, 0, 0.3);
    box(g, 'stone', 'court_step', W + 1.0, 0.12, 0.4, 0, 0, D / 2 + 1.2);
    box(g, 'stone', 'court_body', W, H, D, 0, 0.24, -0.2);
    for (const x of [-1.4, 1.4]) windowOn(g, 0.6, 1.2, x, 0.85, D / 2 - 0.19, 0, true, 'stone', false);
    door(g, 0.9, 1.7, 0, 0.24, D / 2 - 0.19, 0, 'wood_dark', 'stone');
    for (let i = 0; i < 4; i++) { const x = -1.65 + i * 1.1; cyl(g, 'stone', 'court_column', 0.16, 0.19, H - 0.1, x, 0.24, D / 2 + 0.55, 12); box(g, 'stone', 'column_cap', 0.42, 0.12, 0.42, x, H + 0.1, D / 2 + 0.55); }
    box(g, 'stone', 'court_entablature', W + 0.5, 0.3, D + 1.0, 0, H + 0.22, 0.25);
    const sh = new THREE.Shape(); sh.moveTo(-(W + 0.5) / 2, 0); sh.lineTo((W + 0.5) / 2, 0); sh.lineTo(0, 0.9); sh.closePath();
    put(g, new THREE.ExtrudeGeometry(sh, { depth: D + 1.0, bevelEnabled: false }), 'stone', 'court_pediment', 0, H + 0.52, 0.25 - (D + 1.0) / 2);
    const cup = grp(g, 'court_cupola', 0, H + 1.3, -0.2); cyl(cup, 'plaster', 'cupola_drum', 0.45, 0.45, 0.6, 0, 0, 0, 10);
    put(cup, new THREE.SphereGeometry(0.5, 10, 5, 0, PI * 2, 0, PI / 2), 'copper', 'cupola_dome', 0, 0.6, 0);
    register('admin', g, H + 2.3);
  }
  // The gatehouse: the gateway itself. A wide low lodge across the avenue, a striped barrier, the OFF LIMITS rope, the BLOCKED bin.
  let barrier, binCount = 0; const binStack = [];
  {
    const g = grp(world, 'gatehouse', 0, 0, 6.6, 0);
    for (const s of [1, -1]) {
      const lodge = grp(g, 'gate_lodge', s * 2.7, 0, -0.4);
      box(lodge, 'stone', 'lodge_base', 1.9, 0.2, 1.7);
      box(lodge, 'plaster', 'lodge_walls', 1.6, 1.5, 1.4, 0, 0.2, 0);
      for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) box(lodge, 'wood_dark', 'lodge_post', 0.16, 1.5, 0.16, x * 0.8, 0.2, z * 0.7);
      windowOn(lodge, 0.6, 0.5, 0, 0.8, 0.7, 0, true, 'wood_dark');
      gableRoof(lodge, 1.6, 1.4, 0.6, 0.2, 1.7, 'roof_tile', 'plaster');
    }
    // the arch over the avenue (Mytopia's welcome gate)
    for (const s of [1, -1]) box(g, 'wood_dark', 'gate_post', 0.28, 2.8, 0.28, s * 1.5, 0, 0.6);
    box(g, 'wood_dark', 'gate_beam', 3.4, 0.26, 0.34, 0, 2.8, 0.6);
    const gr = grp(g, 'gate_roof', 0, 3.06, 0.6); gableRoof(gr, 3.3, 0.8, 0.45, 0.15, 0, 'roof_tile', 'wood', false);
    box(g, 'paper', 'gate_sign', 1.8, 0.4, 0.06, 0, 2.25, 0.8);
    // the barrier arm, pivoting at the right post
    box(g, 'stone_dark', 'barrier_pivot', 0.4, 0.9, 0.4, 1.25, 0, 1.6);
    barrier = grp(g, 'barrier', 1.25, 0.85, 1.6);
    for (let i = 0; i < 6; i++) box(barrier, i % 2 ? 'stripe_white' : 'stripe_red', 'barrier_stripe', 0.42, 0.14, 0.14, -0.21 - i * 0.42, -0.07, 0);
    register('gatehouse', g, 3.6);
  }
  // OFF LIMITS rope pen, front right of the gate (where revoked robots park)
  {
    const pts = [[3.2, 8.4], [5.6, 8.4], [5.6, 10.4], [3.2, 10.4]];
    for (const [x, z] of pts) { cyl(world, 'brass', 'rope_post', 0.08, 0.1, 0.8, x, 0, z, 8); ball(world, 'brass', 'rope_knob', 0.1, x, 0.85, z, 0); }
    for (let i = 0; i < 3; i++) {
      const [ax, az] = pts[i], [bx, bz] = pts[i + 1], L = Math.hypot(bx - ax, bz - az);
      const g = grp(world, 'velvet_rope', (ax + bx) / 2, 0.62, (az + bz) / 2, -Math.atan2(bz - az, bx - ax));
      box(g, 'velvet', 'rope', L, 0.07, 0.07);
    }
    const sg = grp(world, 'off_limits_sign', 5.9, 0, 9.4, -PI / 2);
    box(sg, 'wood_dark', 'sign_post', 0.1, 0.9, 0.1); box(sg, 'stripe_red', 'off_limits_board', 1.2, 0.36, 0.06, 0, 0.9, 0);
  }
  // BLOCKED bin, front left of the gate; a crate of red packets that fills up
  const BIN = new THREE.Vector3(-3.4, 0, 8.6);
  {
    const g = grp(world, 'blocked_bin', BIN.x, 0, BIN.z);
    box(g, 'wood_dark', 'bin_body', 1.4, 0.8, 1.0); box(g, 'ink', 'bin_inside', 1.2, 0.05, 0.8, 0, 0.76, 0);
    box(g, 'stripe_red', 'bin_label', 1.1, 0.3, 0.04, 0, 0.3, 0.52);
  }
  // props
  for (const z of [4.5, 10.8]) for (const x of [-1.6, 1.6]) lamp(x, z);
  lamp(-2.0, 0.2); lamp(2.0, 0.2);
  for (const [x, z, s] of [[-9, -2, 1], [-2.2, -9.2, 0.9], [2.4, -9.0, 1.1], [9.3, -1.6, 0.9], [-8.2, 7.5, 0.8], [8.6, 7.6, 0.85], [-9.6, 1.4, 0.7], [0, -7.8, 0.75], [-6.5, 9.4, 0.7], [7.0, 9.6, 0.7]]) tree(x, z, s);
  for (const [x, z] of [[-3.0, -1.6], [3.0, -1.6], [-1.9, 5.1], [1.9, 5.1], [-9.4, 4.8], [9.4, 4.6]]) bush(x, z, 0.9, rnd() < 0.5);
  fence([[-10.2, 5.8], [-10.5, 8.0]]); fence([[10.2, 5.8], [10.5, 8.0]]);

  // ---------- robots (Mytopia's small robot, plus a chest plate) ----------
  const PLATE = { none: 0x8a8278, active: 0x3f8a56, revoked: 0xb4553e, kill: 0xd9a032, stopped: 0x2b221e };
  const robots = {}; // id -> { g, rig, plateMat, eyeMat, glints, target, path, frozen, homeX }
  function makeRobot(id, color, slot) {
    const g = grp(world, 'robot_' + id);
    const body = M['robot_' + color] || M.robot_mustard;
    for (const s of [-1, 1]) { box(g, 'robot_grey', 'robot_tread', 0.13, 0.18, 0.46, s * 0.2, 0, 0); box(g, 'ink', 'robot_tread_grip', 0.14, 0.04, 0.47, s * 0.2, 0.07, 0); }
    const rig = grp(g, 'robot_rig');
    box(rig, body, 'robot_body', 0.42, 0.34, 0.4, 0, 0.14, 0);
    const plateMat = new THREE.MeshStandardMaterial({ name: 'plate_' + id, color: PLATE.none, emissive: PLATE.none, emissiveIntensity: 0.25, flatShading: true });
    box(rig, plateMat, 'robot_plate', 0.3, 0.2, 0.04, 0, 0.2, 0.21);
    box(rig, 'robot_grey', 'robot_neck', 0.07, 0.14, 0.07, 0, 0.48, 0);
    const head = grp(rig, 'robot_head', 0, 0.6, 0);
    box(head, 'robot_cream', 'robot_head', 0.38, 0.2, 0.22);
    const eyeMat = M.eye.clone(); const glints = [];
    for (const s of [-1, 1]) { box(head, eyeMat, 'robot_eye', 0.12, 0.12, 0.03, s * 0.09, 0.04, 0.115); glints.push(box(head, 'eye_glint', 'robot_eye_glint', 0.035, 0.035, 0.02, s * 0.09 - 0.025, 0.11, 0.13)); }
    cyl(rig, 'ink', 'robot_antenna', 0.012, 0.012, 0.2, 0.12, 0.8, -0.04, 4);
    ball(rig, 'fl_red', 'robot_antenna_tip', 0.035, 0.12, 1.02, -0.04, 0);
    g.scale.setScalar(3.0);
    const homeX = slot ? 1.3 : -1.3;
    g.position.set(SPOT.gate[0] + homeX, 0.07, SPOT.gate[1]); g.rotation.y = PI;
    robots[id] = { g, rig, plateMat, eyeMat, glints, path: [], frozen: false, homeX, slot };
    return robots[id];
  }
  const spotOf = (id, to) => {
    const r = robots[id];
    if (to === 'gate') return [SPOT.gate[0] + r.homeX, SPOT.gate[1]];
    if (to === 'rope') return [SPOT.rope[0] + (r.slot ? 0.5 : -0.5), SPOT.rope[1] + (r.slot ? 0.5 : -0.3)];
    const s = SPOT[to]; return s ? [s[0] + (r.slot ? 0.6 : -0.6), s[1]] : null;
  };
  // Walk on paths: gate -> through the arch -> plaza -> door (and back). Straight segments, ease at both ends.
  function route(id, to) {
    const r = robots[id], p = r.g.position, dest = spotOf(id, to); if (!dest) return;
    const pts = [];
    const inside = p.z < 7.5, goingIn = ['files', 'github', 'mail', 'admin'].includes(to);
    if (goingIn && !inside) pts.push([0 + r.homeX * 0.4, 5.2]);
    if (goingIn) pts.push([SPOT.plaza[0] + r.homeX * 0.5, SPOT.plaza[1]]);
    if (!goingIn && inside) { pts.push([SPOT.plaza[0] + r.homeX * 0.5, SPOT.plaza[1]]); pts.push([0 + r.homeX * 0.4, 5.2]); }
    pts.push(dest);
    r.path = pts; r.frozen = false;
  }

  // ---------- roof lamps, smoke, fire ----------
  const lampUntil = {};
  const SMOKE = ['#5d5650', '#8a837b', '#b3aca2', '#ddd6ca'], FIRE = ['#7a2e1c', '#b4553e', '#e0632a', '#f2892b', '#f7c25a'];
  const trouble = {}; // key -> { rung, fire, puffs:[], flames:[] }
  for (const key of Object.keys(PLACES)) {
    const t = trouble[key] = { rung: 0, fire: false, puffs: [], flames: [] };
    for (let i = 0; i < 7; i++) {
      const m = new THREE.MeshStandardMaterial({ color: SMOKE[2], roughness: 1, flatShading: true, transparent: true, opacity: 0.85 });
      const p = put(world, gBox(1, 1, 1), m, 'smoke'); p.visible = false; t.puffs.push({ p, ph: i / 7 });
    }
    for (let i = 0; i < 6; i++) {
      const m = new THREE.MeshStandardMaterial({ color: FIRE[2 + (i % 3)], emissive: FIRE[3], emissiveIntensity: 0.9, flatShading: true });
      const f = put(world, gBox(1, 1, 1), m, 'flame'); f.visible = false; t.flames.push({ f, ph: i * 1.3 });
    }
  }
  stage.noNormal = stage.noNormal || new Set();

  // ---------- sparks ----------
  const sparks = []; // { mesh, from, mid, to, t, dur, ok, resolve, burst? }
  const sparkMat = { ok: new THREE.MeshStandardMaterial({ color: 0x7fd49a, emissive: 0x3fbf6a, emissiveIntensity: 1.2 }), bad: new THREE.MeshStandardMaterial({ color: 0xea7a6b, emissive: 0xd8432f, emissiveIntensity: 1.2 }) };
  const GATE_TOP = new THREE.Vector3(0, 3.0, 7.2), BARRIER_PT = new THREE.Vector3(0, 1.0, 7.9);

  // ---------- Stage B: the gatehouse interior, a ledger room (Mytopia's cutaway dollhouse idea) ----------
  // Only the back and left walls exist, so the iso camera looks straight in. The chalkboard is a canvas drawn from the
  // event log (allow green, deny red, admin amber); the left wall shows the hash chain. The clerk robot stamps each new row.
  const room = new THREE.Group(); room.name = 'ledger_room'; room.visible = false;
  stage._scene.add(room);
  const RW = 11, RD = 8, RH = 5.0;
  {
    box(room, 'wood', 'room_floor', RW, 0.3, RD, 0, -0.3, 0);
    for (let x = -RW / 2 + 0.55; x < RW / 2; x += 0.55) box(room, 'wood_dark', 'floor_line', 0.03, 0.01, RD, x, 0, 0);
    box(room, 'plaster', 'room_back_wall', RW, RH, 0.3, 0, -0.3, -RD / 2 - 0.15);
    box(room, 'plaster', 'room_left_wall', 0.3, RH, RD, -RW / 2 - 0.15, -0.3, 0);
    box(room, 'wood_dark', 'skirting', RW, 0.25, 0.08, 0, 0, -RD / 2 + 0.04); box(room, 'wood_dark', 'skirting', 0.08, 0.25, RD, -RW / 2 + 0.04, 0, 0);
    box(room, 'wood_dark', 'wall_beam', RW, 0.2, 0.12, 0, RH - 0.6, -RD / 2 + 0.06);
  }
  const boardTex = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return { c, g: c.getContext('2d'), t }; };
  const ledger = boardTex(1280, 720), chain = boardTex(640, 640);
  { // chalkboard on the back wall
    box(room, 'wood_dark', 'board_frame', 7.0, 4.0, 0.14, 1.6, 0.4, -RD / 2 + 0.07);
    put(room, new THREE.PlaneGeometry(6.7, 3.7), new THREE.MeshBasicMaterial({ map: ledger.t, toneMapped: false }), 'ledger_board', 1.6, 2.4, -RD / 2 + 0.16);
    box(room, 'wood_light', 'chalk_tray', 6.8, 0.08, 0.25, 1.6, 0.36, -RD / 2 + 0.2);
  }
  { // hash-chain board on the back wall, left of the chalkboard
    box(room, 'wood_dark', 'chain_frame', 2.9, 2.9, 0.12, -3.6, 1.1, -RD / 2 + 0.06);
    put(room, new THREE.PlaneGeometry(2.7, 2.7), new THREE.MeshBasicMaterial({ map: chain.t, toneMapped: false }), 'chain_paper', -3.6, 2.55, -RD / 2 + 0.14);
    box(room, 'window', 'left_window', 0.06, 1.4, 2.0, -RW / 2 + 0.02, 1.6, 0.8); box(room, 'wood_light', 'left_window_frame', 0.1, 0.1, 2.2, -RW / 2 + 0.05, 1.5, 0.8);
  }
  // the clerk's desk, a stamp, a paper stack, the BLOCKED tray
  let clerkArm, stampT = 0;
  {
    const d = grp(room, 'clerk_desk', 1.2, 0, 1.3, 0);
    box(d, 'wood', 'desk_top', 3.2, 0.12, 1.3, 0, 0.95, 0); box(d, 'wood_dark', 'desk_front', 3.2, 0.95, 0.1, 0, 0, 0.6);
    for (const s of [-1, 1]) box(d, 'wood_dark', 'desk_side', 0.1, 0.95, 1.2, s * 1.55, 0, 0);
    box(d, 'paper', 'paper_stack', 0.6, 0.18, 0.45, -0.9, 1.07, 0); box(d, 'paper', 'paper_sheet', 0.55, 0.02, 0.4, 0.15, 1.08, 0.1);
    box(d, 'stripe_red', 'blocked_tray', 0.7, 0.14, 0.5, 1.0, 1.07, 0);
    box(d, 'stripe_white', 'desk_sign', 1.5, 0.35, 0.04, 0, 0.35, 0.66);
    // the clerk: Mytopia's robot recipe, seated behind the desk, facing the camera
    const c = grp(room, 'clerk', 1.2, 0, 0.2, 0.35); c.scale.setScalar(2.4);
    box(c, 'robot_orange', 'clerk_body', 0.42, 0.34, 0.4, 0, 0.14, 0);
    box(c, 'robot_grey', 'clerk_neck', 0.07, 0.14, 0.07, 0, 0.48, 0);
    const h = grp(c, 'clerk_head', 0, 0.6, 0); box(h, 'robot_cream', 'clerk_head', 0.38, 0.2, 0.22);
    for (const s of [-1, 1]) box(h, 'eye', 'clerk_eye', 0.12, 0.12, 0.03, s * 0.09, 0.04, 0.115);
    box(h, 'ink', 'clerk_visor', 0.4, 0.04, 0.12, 0, 0.2, 0.06);
    clerkArm = grp(c, 'clerk_arm', 0.26, 0.42, 0.05);
    box(clerkArm, 'robot_grey', 'arm', 0.07, 0.07, 0.34, 0, 0, 0.17); box(clerkArm, 'wood_dark', 'stamp_handle', 0.08, 0.14, 0.08, 0, -0.06, 0.34); box(clerkArm, 'stripe_red', 'stamp_head', 0.14, 0.05, 0.14, 0, -0.14, 0.34);
  }
  room.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  const COL = { allow: '#7fd49a', deny: '#ea7a6b', admin: '#f2c46b', harness: '#cfd6d0' };
  function drawLedger(log, mode) {
    const { g, c, t } = ledger;
    g.fillStyle = '#2f3a33'; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = 'rgba(255,255,255,0.04)'; for (let i = 0; i < 40; i++) g.fillRect((i * 97) % c.width, (i * 53) % c.height, 120, 3); // chalk dust
    g.fillStyle = '#f3ead7'; g.font = '76px VT323'; g.fillText('LEDGER', 40, 82);
    g.font = '44px VT323'; g.fillStyle = '#b3aca2'; g.fillText(mode === 'replay' ? 'replay: recorded rows' : 'live: the gateway log', 330, 80);
    const rows = log.slice(-7);
    rows.forEach((e, i) => {
      const y = 175 + i * 78, kind = e.decision === 'allow' ? 'allow' : e.decision === 'deny' ? 'deny' : e.tool === 'harness' ? 'harness' : 'admin';
      if (i === rows.length - 1) { g.fillStyle = 'rgba(247,217,180,0.2)'; g.fillRect(24, y - 60, c.width - 48, 76); }
      g.font = '72px VT323'; g.fillStyle = COL[kind];
      g.fillText('#' + e.seq, 40, y);
      g.fillText(e.decision === 'kill_requested' ? 'KILL' : e.decision === 'run_started' ? 'START' : e.decision === 'run_stopped' ? 'STOP' : e.decision.toUpperCase(), 190, y);
      g.fillStyle = '#f3ead7'; g.fillText(String(e.tool).slice(0, 12), 520, y);
      g.fillStyle = '#b3aca2'; g.fillText(String(e.agent).replace('-bot', ''), 1000, y);
    });
    if (!rows.length) { g.font = '72px VT323'; g.fillStyle = '#b3aca2'; g.fillText('no calls yet', 40, 200); }
    t.needsUpdate = true;
    // the chain: each row names the hash of the row before it
    const k = chain.g, cc = chain.c;
    k.fillStyle = '#fbf7ee'; k.fillRect(0, 0, cc.width, cc.height);
    k.fillStyle = '#2b221e'; k.font = '54px VT323'; k.fillText('HASH CHAIN', 30, 64);
    k.font = '28px VT323'; k.fillStyle = '#7a6f62'; k.fillText(mode === 'replay' ? 'fixture placeholders, not verified' : 'tamper-evident: each row names the last', 30, 102);
    log.slice(-6).forEach((e, i) => {
      const y = 160 + i * 78, h8 = String(e.hash || '').slice(0, 8), p8 = String(e.prev_hash || '').slice(0, 8);
      k.fillStyle = '#efe6d2'; k.fillRect(24, y - 40, cc.width - 48, 58);
      k.fillStyle = '#2b221e'; k.font = '40px VT323'; k.fillText(`#${e.seq}  ${h8}`, 36, y);
      k.fillStyle = '#7a6f62'; k.font = '30px VT323'; k.fillText(`<- ${p8}`, 380, y);
      if (i) { k.fillStyle = '#2b221e'; k.fillRect(70, y - 52, 6, 12); }
    });
    chain.t.needsUpdate = true;
    stampT = 0.45;
  }
  document.fonts.load('40px VT323').then(() => drawLedger([], 'live'));
  let saved = null;
  function setRoom(on) {
    const cam = stage._camera, ctl = stage._controls;
    if (on && !saved) {
      saved = { pos: cam.position.clone(), target: ctl.target.clone(), zoom: cam.zoom, bg: stage._scene.background };
      // look at the back wall almost head-on so the chalkboard reads from across a room
      const len = cam.position.distanceTo(ctl.target), ctr = new THREE.Vector3(0.2, 2.1, -1.2);
      ctl.target.copy(ctr); cam.position.copy(ctr).add(new THREE.Vector3(0.16, 0.5, 1).normalize().multiplyScalar(len)); cam.zoom = 1.95;
      stage._scene.background = new THREE.Color('#f3ead7');
      world.visible = false; room.visible = true;
    } else if (!on && saved) {
      cam.position.copy(saved.pos); ctl.target.copy(saved.target); cam.zoom = saved.zoom; stage._scene.background = saved.bg;
      world.visible = true; room.visible = false; saved = null;
    }
    cam.updateProjectionMatrix(); ctl.update();
  }

  // ---------- sky + framing ----------
  const skyTex = (() => { const c = document.createElement('canvas'); c.width = 96; c.height = 256; const g = c.getContext('2d'); const gr = g.createLinearGradient(0, 0, 0, 256); gr.addColorStop(0, '#bfe0ec'); gr.addColorStop(0.42, '#e9ecdc'); gr.addColorStop(0.7, '#f6e8cf'); gr.addColorStop(1, '#f4cfae'); g.fillStyle = gr; g.fillRect(0, 0, 96, 256); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t; })();
  stage.setObject(world, { target: [0.6, -1.0, 2.2], radius: 19 });
  stage._scene.background = skyTex;
  const ctl = stage._controls; ctl.enablePan = false; ctl.minZoom = 0.8; ctl.maxZoom = 2.5;

  // ---------- per-frame ----------
  const tmp = new THREE.Vector3();
  stage.onTick = (t, dt) => {
    // Stage B: packets fall into the BLOCKED bin; the clerk stamps each new ledger row
    for (const b of binStack) { const u = b.userData; if (u.vy === undefined) continue; u.vy -= 14 * dt; b.position.y += u.vy * dt; b.rotation.y += dt * 4; if (b.position.y <= u.restY) { b.position.y = u.restY; b.rotation.y = 0; delete u.vy; } }
    if (stampT > 0) { stampT = Math.max(0, stampT - dt); clerkArm.rotation.x = Math.sin((0.45 - stampT) / 0.45 * PI) * 0.9; }
    // robots walk their path
    for (const r of Object.values(robots)) {
      if (r.frozen || !r.path.length) { r.rig.position.y = 0; continue; }
      const [tx, tz] = r.path[0], p = r.g.position, dx = tx - p.x, dz = tz - p.z, d = Math.hypot(dx, dz), step = 2.4 * dt;
      if (d <= step) { p.x = tx; p.z = tz; r.path.shift(); if (!r.path.length) r.g.rotation.y = PI; }
      else { p.x += dx / d * step; p.z += dz / d * step; r.g.rotation.y = Math.atan2(dx, dz); r.rig.position.y = Math.abs(Math.sin(t * 9)) * 0.025; }
    }
    // roof lamps
    const now = performance.now();
    for (const [k, pl] of Object.entries(PLACES)) {
      const on = (lampUntil[k] || 0) > now;
      pl.lampMat.color.set(on ? 0x7fd49a : 0x8a8278); pl.lampMat.emissive.set(on ? 0x3fbf6a : 0x000000);
    }
    // barrier lifts while a spark passes, else down
    const lift = sparks.some((s) => s.ok) ? -1.2 : 0;
    barrier.rotation.z += (lift - barrier.rotation.z) * Math.min(1, dt * 6);
    // smoke and fire (state, not effects): blocky puffs, Mytopia style
    for (const [k, tr] of Object.entries(trouble)) {
      const top = PLACES[k].roof, n = tr.fire ? 7 : tr.rung === 2 ? 6 : tr.rung === 1 ? 3 : 0;
      tr.puffs.forEach((pf, i) => {
        const on = i < n; pf.p.visible = on; if (!on) return;
        const u = (t * 0.28 + pf.ph) % 1, sz = 0.16 + u * (tr.rung === 2 || tr.fire ? 0.5 : 0.3);
        pf.p.position.set(top.x + Math.sin(u * 5 + i) * 0.35 + u * 0.6, top.y + 0.3 + u * 2.6, top.z + Math.cos(u * 4 + i) * 0.3);
        pf.p.scale.setScalar(Math.round(sz / 0.08) * 0.08);
        pf.p.material.color.set(SMOKE[tr.fire || tr.rung === 2 ? Math.min(3, Math.floor(u * 4)) : 2 + Math.floor(u * 2)]);
        pf.p.material.opacity = 0.9 * (1 - u);
      });
      tr.flames.forEach((fl, i) => {
        fl.f.visible = tr.fire; if (!tr.fire) return;
        const h = 0.3 + Math.abs(Math.sin(t * 7 + fl.ph)) * 0.6;
        fl.f.position.set(top.x + (i % 3 - 1) * 0.42, top.y - 0.6 + h / 2, top.z + (i < 3 ? -0.25 : 0.25));
        fl.f.scale.set(0.24, h, 0.24);
      });
    }
    // sparks along a raised arc
    for (let i = sparks.length - 1; i >= 0; i--) {
      const s = sparks[i]; s.t += dt / s.dur;
      if (s.burst) {
        s.burst.forEach((b, j) => { b.position.addScaledVector(b.userData.v, dt); b.scale.setScalar(Math.max(0.01, 0.16 * (1 - s.t))); });
        if (s.t >= 1) { s.burst.forEach((b) => world.remove(b)); sparks.splice(i, 1); s.resolve(); }
        continue;
      }
      const u = Math.min(1, s.t), v = 1 - u;
      tmp.set(v * v * s.from.x + 2 * v * u * s.mid.x + u * u * s.to.x, v * v * s.from.y + 2 * v * u * s.mid.y + u * u * s.to.y, v * v * s.from.z + 2 * v * u * s.mid.z + u * u * s.to.z);
      s.mesh.position.copy(tmp);
      if (u >= 1) {
        world.remove(s.mesh);
        if (!s.ok) { // fizzle: a little burst of red blocks at the barrier
          s.burst = Array.from({ length: 7 }, (_, j) => { const b = put(world, gBox(1, 1, 1), sparkMat.bad, 'fizzle', tmp.x, tmp.y, tmp.z); const a = j / 7 * PI * 2; b.userData.v = new THREE.Vector3(Math.cos(a) * 1.4, 1.2 + (j % 3) * 0.4, Math.sin(a) * 1.4); b.scale.setScalar(0.16); return b; });
          s.t = 0; s.dur = 0.6;
        } else { sparks.splice(i, 1); s.resolve(); }
      }
    }
  };

  // ---------- the API the effects layer calls ----------
  const cam = stage._camera, canvas = stage._renderer.domElement;
  const toScreen = (v) => { const r = canvas.getBoundingClientRect(); tmp.copy(v).project(cam); return [r.left + (tmp.x + 1) / 2 * r.width, r.top + (1 - tmp.y) / 2 * r.height]; };
  return {
    addRobot(id, color, slot) { if (!robots[id]) makeRobot(id, color, slot); },
    hasRobot: (id) => !!robots[id],
    setPlate(id, plate) {
      const r = robots[id]; if (!r) return;
      r.plateMat.color.set(PLATE[plate] ?? PLATE.none); r.plateMat.emissive.set(PLATE[plate] ?? PLATE.none);
      const out = plate === 'stopped';
      r.eyeMat.color.set(out ? 0x4a4440 : 0x141110); r.glints.forEach((gl) => (gl.visible = !out));
      if (out || plate === 'kill') r.frozen = true; else r.frozen = false;
    },
    move(id, to) { if (robots[id]) route(id, to); },
    freeze(id) { if (robots[id]) robots[id].frozen = true; },
    lamp(key, ms = 2000) { lampUntil[key] = performance.now() + ms; },
    ladder(key, rung, fire) { if (trouble[key]) { trouble[key].rung = rung; trouble[key].fire = !!fire; } },
    resetTrouble() { for (const tr of Object.values(trouble)) { tr.rung = 0; tr.fire = false; } },
    spark(id, to, ok) {
      return new Promise((resolve) => {
        const r = robots[id];
        const from = ok ? GATE_TOP.clone() : (r ? r.g.position.clone().add(new THREE.Vector3(0, 1.4, 0)) : GATE_TOP.clone());
        const dest = ok ? PLACES[to]?.roof.clone() : BARRIER_PT.clone();
        if (!dest) return resolve();
        const mid = from.clone().lerp(dest, 0.5); mid.y = Math.max(from.y, dest.y) + (ok ? 3.0 : 1.2);
        const mesh = put(world, gBox(0.3, 0.3, 0.3), ok ? sparkMat.ok : sparkMat.bad, 'spark', from.x, from.y, from.z);
        sparks.push({ mesh, from, mid, to: dest, t: 0, dur: ok ? 1.1 : 0.6, ok, resolve });
      });
    },
    robotScreen(id) { const r = robots[id]; if (!r) return null; return toScreen(r.g.position.clone().add(new THREE.Vector3(0, 3.3, 0))); },
    placeScreen(key) { const p = PLACES[key]; return p ? toScreen(p.roof.clone().add(new THREE.Vector3(0, 1.3, 0))) : null; },
    places: () => Object.keys(PLACES),
    binScreen() { return toScreen(BIN.clone().add(new THREE.Vector3(-0.2, -0.3, 1.2))); },
    dropPacket() { // a red packet lands in the BLOCKED bin (stacked, capped)
      if (binStack.length >= 12) return;
      const i = binStack.length, restY = 0.82 + Math.floor(i / 6) * 0.2;
      const b = put(world, gBox(0.28, 0.2, 0.28), sparkMat.bad, 'packet', BIN.x - 0.4 + (i % 3) * 0.4, restY + 3.2, BIN.z - 0.2 + (Math.floor(i / 3) % 2) * 0.4);
      b.userData.restY = restY; b.userData.vy = 0; // it drops in (Stage B)
      binStack.push(b); binCount++;
    },
    drawLedger, // (log, mode) -> redraws the chalkboard and the chain board
    setRoom, inRoom: () => !!saved,
    nearGate(clientX, clientY) { const p = toScreen(PLACES.gatehouse.roof); return Math.hypot(p[0] - clientX, p[1] + 60 - clientY) < 110; },
    pickRobot(clientX, clientY) {
      let best = null, bd = 60;
      for (const id of Object.keys(robots)) { const s = this.robotScreen(id); if (!s) continue; const d = Math.hypot(s[0] - clientX, s[1] - clientY + 40); if (d < bd) { bd = d; best = id; } }
      return best;
    },
  };
}
