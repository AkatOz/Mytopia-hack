// The archipelago's ground and furniture: five floating islands, four plank bridges, four gates with guard booths,
// the dock, the OFF LIMITS pen, the BLOCKED bin, trees/lamps/fences and the clouds (docs/ISLAND_V2.md sections 1 and 7).
// Pre-existing (Mytopia's campus.js, via v1 scene.js): the tile terrain recipe (grass top, dirt band, rock underside),
// tree, bush, street lamp and fence. New today: several islands from layout.ISLANDS, forced stone at the bridge shores,
// bridges, gates, booths, the pixel-font signs, the dock and hatch, the pen's swinging rope, the bin label and clouds.
// Every coordinate comes from layout.js (ctx.L); this file never decides where things go on its own, except scenery.
// buildWorld(ctx) builds everything into one Group and returns handles the actors and effects animate.
// Build 3 (docs/BUILD3.md section 4): the Factory island's ground and bridge (its buildings are in factory.js), the
// dock moved to the south-west shore with two moored rowing boats, reeds at the shores, more trees and bushes on every
// islet, six gulls circling over the harbour and two more clouds.

const PI = Math.PI;
const CAM = [Math.SQRT1_2, Math.SQRT1_2]; // the default camera looks from the south-east: signs face this way (x, z)
const SAG = 0.35;                          // how far a bridge deck dips at its middle
const DECK_TOP = 0.07;                     // top of the paving and of the bridge planks at their ends

// ---------- a 5x7 pixel font for the signs (new today) ----------
// Canvas text drawn with a real font blurs in the half-resolution render; hand-made pixel letters stay crisp.
const GLYPHS = {
  A: '.###.|#...#|#...#|#####|#...#|#...#|#...#', B: '####.|#...#|#...#|####.|#...#|#...#|####.',
  C: '.###.|#...#|#....|#....|#....|#...#|.###.', D: '####.|#...#|#...#|#...#|#...#|#...#|####.',
  E: '#####|#....|#....|####.|#....|#....|#####', F: '#####|#....|#....|####.|#....|#....|#....',
  G: '.###.|#...#|#....|#.###|#...#|#...#|.####', H: '#...#|#...#|#...#|#####|#...#|#...#|#...#',
  I: '.###.|..#..|..#..|..#..|..#..|..#..|.###.', J: '..###|...#.|...#.|...#.|...#.|#..#.|.##..',
  K: '#...#|#..#.|#.#..|##...|#.#..|#..#.|#...#', L: '#....|#....|#....|#....|#....|#....|#####',
  M: '#...#|##.##|#.#.#|#.#.#|#...#|#...#|#...#', N: '#...#|#...#|##..#|#.#.#|#..##|#...#|#...#',
  O: '.###.|#...#|#...#|#...#|#...#|#...#|.###.', P: '####.|#...#|#...#|####.|#....|#....|#....',
  Q: '.###.|#...#|#...#|#...#|#.#.#|#..#.|.##.#', R: '####.|#...#|#...#|####.|#.#..|#..#.|#...#',
  S: '.####|#....|#....|.###.|....#|....#|####.', T: '#####|..#..|..#..|..#..|..#..|..#..|..#..',
  U: '#...#|#...#|#...#|#...#|#...#|#...#|.###.', V: '#...#|#...#|#...#|#...#|#...#|.#.#.|..#..',
  W: '#...#|#...#|#...#|#.#.#|#.#.#|#.#.#|.#.#.', X: '#...#|#...#|.#.#.|..#..|.#.#.|#...#|#...#',
  Y: '#...#|#...#|.#.#.|..#..|..#..|..#..|..#..', Z: '#####|....#|...#.|..#..|.#...|#....|#####',
  0: '.###.|#...#|#..##|#.#.#|##..#|#...#|.###.', 1: '..#..|.##..|..#..|..#..|..#..|..#..|.###.',
  2: '.###.|#...#|....#|...#.|..#..|.#...|#####', 3: '####.|....#|....#|.###.|....#|....#|####.',
  4: '...#.|..##.|.#.#.|#..#.|#####|...#.|...#.', 5: '#####|#....|####.|....#|....#|#...#|.###.',
  6: '..##.|.#...|#....|####.|#...#|#...#|.###.', 7: '#####|....#|...#.|..#..|.#...|.#...|.#...',
  8: '.###.|#...#|#...#|.###.|#...#|#...#|.###.', 9: '.###.|#...#|#...#|.####|....#|...#.|.##..',
  _: '.....|.....|.....|.....|.....|.....|#####', '·': '.....|.....|.....|..#..|.....|.....|.....',
  '-': '.....|.....|.....|.###.|.....|.....|.....', '.': '.....|.....|.....|.....|.....|.....|..#..',
  ':': '.....|..#..|.....|.....|.....|..#..|.....', '/': '....#|....#|...#.|..#..|.#...|#....|#....',
  ' ': '.....|.....|.....|.....|.....|.....|.....',
};
export const textWidth = (text) => (text.length ? text.length * 6 - 1 : 0); // in font pixels (5 wide + 1 gap)

function drawText(g, text, x, y, px, color) {
  g.fillStyle = color;
  [...String(text).toUpperCase()].forEach((ch, i) => {
    const rows = (GLYPHS[ch] || GLYPHS[' ']).split('|');
    rows.forEach((row, ry) => {
      for (let rx = 0; rx < 5; rx++) if (row[rx] === '#') g.fillRect(x + (i * 6 + rx) * px, y + ry * px, px, px);
    });
  });
}

// A canvas sign made of pixel letters. lines: [{ text, size (1 = 7 font pixels tall), color }].
// Returns { w, h } in font pixels (build the board at that aspect so letters stay square), the material, and
// redraw(lines) for signs that change (the REFUSED counter). Mipmaps keep it smooth when the camera zooms out.
export function pixelSign(ctx, lines, opt = {}) {
  const { THREE, kit } = ctx;
  const o = { bg: '#3a312b', border: '#f2892b', pad: 2, gap: 2, cell: 6, ...opt };
  const measure = (ls) => {
    let w = 0, h = 0;
    ls.forEach((l, i) => { const s = l.size || 1; w = Math.max(w, textWidth(l.text) * s); h += 7 * s + (i ? o.gap : 0); });
    return [w + 2 * o.pad + 2, h + 2 * o.pad + 2];
  };
  const [w, h] = measure(lines);
  const paint = (ls) => (g, c) => {
    const k = o.cell;
    g.fillStyle = o.border || o.bg; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = o.bg; g.fillRect(k, k, c.width - 2 * k, c.height - 2 * k);
    let y = 1 + o.pad + Math.floor((h - measure(ls)[1]) / 2);
    for (const l of ls) {
      const s = l.size || 1, tw = textWidth(l.text) * s;
      drawText(g, l.text, Math.floor((w - tw) / 2) * k, y * k, s * k, l.color || '#f3ead7');
      y += 7 * s + o.gap;
    }
  };
  const tex = kit.canvasTex(w * o.cell, h * o.cell, paint(lines));
  tex.t.minFilter = THREE.LinearMipmapLinearFilter;
  return { w, h, tex, mat: kit.signMat(tex), redraw: (ls) => tex.redraw(paint(ls)) };
}

// A board carrying a pixel sign on its front (+z) face, or on both faces. Height follows the sign's aspect.
// y is the board's bottom edge, like kit.box.
export function signBoard(ctx, parent, name, sign, width, depth, x, y, z, ry = 0, both = true, edgeMat = 'wood_dark') {
  const { THREE, kit } = ctx;
  const h = (width * sign.h) / sign.w, edge = kit.M[edgeMat];
  const g = kit.grp(parent, name, x, y, z, ry);
  const m = new THREE.Mesh(kit.gBox(width, h, depth), [edge, edge, edge, edge, sign.mat, both ? sign.mat : edge]);
  m.name = name + '_face'; m.position.y = h / 2; g.add(m);
  return { g, h };
}

// ---------- the guard booth (new today; also used by buildings.js for the chief's booth) ----------
// Plaster kiosk, 1.4 x 2.55 x 1.4: wider and taller than the brief's 1.2 x 1.9 so a scale-3 guard (1.26 wide,
// 2.4 tall) fits inside. The side facing (ox, oz) is an open doorway; the other three walls are open above
// waist height, so the guard stays visible from every angle. Navy band, tile roof, a status lamp cube on top, and
// (optionally) the REFUSED counter plate on the wall the default camera sees best.
export function buildBooth(ctx, parent, name, [x, z], [ox, oz], { counter = false } = {}) {
  const { kit } = ctx, { box, cyl, grp, pyramid, M } = kit;
  const ry = Math.atan2(ox, oz); // local +z = the open doorway
  const g = grp(parent, name, x, 0, z, ry);
  const S = 1.4, half = 0.65, low = 1.0, top = 2.15, H = 2.55;
  box(g, 'stone', 'booth_floor', S, 0.04, S);
  for (const [px, pz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) box(g, 'wood_dark', 'booth_post', 0.14, H, 0.14, px * half, 0, pz * half);
  box(g, 'plaster', 'booth_wall_back', S - 0.1, low, 0.1, 0, 0, -half);
  for (const s of [-1, 1]) box(g, 'plaster', 'booth_wall_side', 0.1, low, S - 0.1, s * half, 0, 0);
  box(g, 'wood_light', 'booth_sill', S + 0.06, 0.06, 0.18, 0, low, -half);
  for (const s of [-1, 1]) box(g, 'wood_light', 'booth_sill', 0.18, 0.06, S + 0.06, s * half, low, 0);
  box(g, 'plaster', 'booth_lintel', S + 0.04, H - top, S + 0.04, 0, top);
  box(g, 'uniform', 'booth_band', S + 0.1, 0.13, S + 0.1, 0, top + 0.12);
  box(g, 'wood_dark', 'booth_roof_slab', S + 0.3, 0.1, S + 0.3, 0, H);
  pyramid(g, 'roof_tile', 'booth_roof', 1.2, 0.55, 0, H + 0.1, 0);
  cyl(g, 'ink', 'booth_lamp_stem', 0.04, 0.04, 0.25, 0, H + 0.55, 0, 6);
  const lampMat = M.lamp_off.clone(); lampMat.name = name + '_lamp'; lampMat.emissiveIntensity = 0.7;
  box(g, lampMat, 'booth_lamp', 0.36, 0.36, 0.36, 0, H + 0.78, 0);
  let counterApi = null, padlockApi = null;
  if (counter) {
    const wall = cameraWall(ry);
    counterApi = addCounterPlate(ctx, g, wall, half);
    padlockApi = addPadlockPlate(ctx, g, wall, half, top);
  }
  return { g, lampMat, counter: counterApi, padlock: padlockApi, guardHome: [x, z] };
}

// Of the booth's three closed walls, the one the default camera sees best (local normal x, z).
function cameraWall(ry) {
  const walls = [[0, -1], [-1, 0], [1, 0]];
  const facing = ([nx, nz]) => (nx * Math.cos(ry) + nz * Math.sin(ry)) * CAM[0] + (-nx * Math.sin(ry) + nz * Math.cos(ry)) * CAM[1];
  return walls.reduce((best, w) => (facing(w) > facing(best) ? w : best));
}

// The REFUSED counter: two big digits on a paper plate (brief section 5: digits only, the DOM does the words).
function addCounterPlate(ctx, g, [nx, nz], half) {
  const lines = (n) => [{ text: String(Math.min(99, n)).padStart(2, '0'), size: 3, color: n ? '#b4553e' : '#a49b89' }];
  const sign = pixelSign(ctx, lines(0), { bg: '#fbf7ee', border: '#3a312b', pad: 1 });
  signBoard(ctx, g, 'refused_counter', sign, 1.12, 0.05, nx * (half + 0.07), 0.12, nz * (half + 0.07), Math.atan2(nx, nz), false, 'plaster');
  return { set: (n) => sign.redraw(lines(n)) };
}

// The padlock (round two, docs/ISLAND_V2_ADDITIONS.md section 1): shown while an operator has pulled one of this
// islet's tools from a badge. A brick-red plate with a cream pixel padlock (ink shackle), no words; big and plain on
// purpose, since the half-resolution render draws it about 7 pixels tall. Two copies per gate, both hidden until set(true):
// one hung from the booth's lintel over the counter wall (as the spec says), and one under the gate's signboard,
// because several booths stand behind the gatehouse at the default camera and the signboards are always in view.
const PADLOCK = ['..###..', '.#...#.', '.#...#.', '#######', '###.###', '###.###', '#######'];
function padlockSign(ctx) {
  const { kit } = ctx, k = 16, n = PADLOCK.length + 4; // cell size in canvas pixels; glyph plus a two-cell frame
  const tex = kit.canvasTex(n * k, n * k, (c2) => {
    c2.fillStyle = '#3a312b'; c2.fillRect(0, 0, n * k, n * k);
    c2.fillStyle = '#b4553e'; c2.fillRect(k, k, (n - 2) * k, (n - 2) * k);
    PADLOCK.forEach((row, y) => [...row].forEach((ch, x) => {
      if (ch === '#') { c2.fillStyle = y < 3 ? '#3a312b' : '#fbf7ee'; c2.fillRect((x + 2) * k, (y + 2) * k, k, k); }
    }));
  });
  return { w: n, h: n, mat: kit.signMat(tex) };
}
function addPadlockPlate(ctx, g, [nx, nz], half, lintel) {
  const plate = ctx.kit.grp(g, 'padlock', nx * (half + 0.1), 0, nz * (half + 0.1), Math.atan2(nx, nz));
  const size = 1.0;
  signBoard(ctx, plate, 'padlock_plate', padlockSign(ctx), size, 0.05, 0, lintel - 0.06 - size, 0, 0, false, 'ink');
  for (const s of [-0.3, 0.3]) ctx.kit.box(plate, 'ink', 'padlock_chain', 0.04, 0.07, 0.04, s, lintel - 0.07, 0);
  plate.visible = false;
  return { set: (on) => { plate.visible = !!on; } };
}

// ---------- scenery recipes (Mytopia campus.js, unchanged apart from taking a parent) ----------
function makeScenery(ctx) {
  const { kit } = ctx, { rnd, rr, pick, put, box, cyl, ball, grp, pyramid, gCone } = kit;
  function tree(p, x, z, s = 1) {
    const g = grp(p, 'tree', x, 0, z, rnd() * PI * 2);
    if (rnd() < 0.25) { cyl(g, 'trunk', 'pine_trunk', 0.12 * s, 0.16 * s, 0.6 * s, 0, 0, 0, 6); for (let i = 0; i < 3; i++) put(g, gCone((1.0 - i * 0.24) * s, (1.1 - i * 0.1) * s, 7), 'leaf_d', 'pine_tier', 0, (0.5 + i * 0.6 + 0.55) * s, 0); return g; }
    cyl(g, 'trunk', 'trunk', 0.13 * s, 0.19 * s, 1.0 * s, 0, 0, 0, 6);
    const m1 = pick(['leaf_a', 'leaf_b', 'leaf_c']), m2 = pick(['leaf_a', 'leaf_b', 'leaf_c']);
    ball(g, m1, 'canopy', 0.95 * s, 0, 1.6 * s, 0); ball(g, m2, 'canopy', 0.62 * s, 0.55 * s, 1.25 * s, 0.25 * s); ball(g, m1, 'canopy', 0.55 * s, -0.45 * s, 1.35 * s, -0.35 * s);
    return g;
  }
  function bush(p, x, z, s = 1, flowers = false) {
    const g = grp(p, 'bush', x, 0, z, rnd() * PI); const m = pick(['leaf_a', 'leaf_c', 'leaf_b']);
    ball(g, m, 'bush_ball', 0.48 * s, 0, 0.36 * s, 0); ball(g, m, 'bush_ball', 0.34 * s, 0.38 * s, 0.26 * s, 0.1 * s);
    if (flowers) { const fm = pick(['fl_pink', 'fl_white', 'fl_yellow']); for (let i = 0; i < 5; i++) { const a = rnd() * PI * 2; box(g, fm, 'bush_flower', 0.1, 0.1, 0.1, Math.cos(a) * 0.42 * s, rr(0.4, 0.7) * s, Math.sin(a) * 0.42 * s); } }
    return g;
  }
  function lamp(p, x, z, lanternMat = 'lamp_glow') {
    const g = grp(p, 'street_lamp', x, 0, z);
    box(g, 'stone_dark', 'lamp_base', 0.3, 0.2, 0.3); cyl(g, 'ink', 'lamp_post', 0.05, 0.065, 2.0, 0, 0.2, 0, 8);
    box(g, 'ink', 'lamp_collar', 0.34, 0.06, 0.34, 0, 2.18, 0); box(g, lanternMat, 'lamp_lantern', 0.26, 0.34, 0.26, 0, 2.24, 0); pyramid(g, 'ink', 'lamp_roof', 0.3, 0.24, 0, 2.58, 0);
    return g;
  }
  function fence(p, pts) {
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, az] = pts[i], [bx, bz] = pts[i + 1], L = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.round(L));
      for (let k = 0; k <= n; k++) { const x = ax + ((bx - ax) * k) / n, z = az + ((bz - az) * k) / n; box(p, 'wood', 'fence_post', 0.12, 0.72, 0.12, x, 0, z); }
      const g = grp(p, 'fence_rails', (ax + bx) / 2, 0, (az + bz) / 2, -Math.atan2(bz - az, bx - ax));
      box(g, 'wood_light', 'fence_rail', L, 0.07, 0.05, 0, 0.28, 0); box(g, 'wood_light', 'fence_rail', L, 0.07, 0.05, 0, 0.54, 0);
    }
  }
  // new today: small props that make the islands feel used
  function bench(p, x, z, ry) {
    const g = grp(p, 'bench', x, 0, z, ry);
    for (const s of [-0.5, 0.5]) box(g, 'ink', 'bench_leg', 0.08, 0.4, 0.36, s, 0, 0);
    box(g, 'wood', 'bench_seat', 1.3, 0.08, 0.42, 0, 0.4, 0); box(g, 'wood', 'bench_back', 1.3, 0.34, 0.07, 0, 0.5, -0.2);
    return g;
  }
  function crate(p, x, z, s = 0.6, ry = 0) {
    const g = grp(p, 'crate', x, 0, z, ry);
    box(g, 'wood', 'crate_box', s, s, s); box(g, 'wood_dark', 'crate_band', s + 0.02, 0.08, s + 0.02, 0, s * 0.45, 0);
    return g;
  }
  function barrel(p, x, z) {
    const g = grp(p, 'barrel', x, 0, z);
    cyl(g, 'wood', 'barrel_body', 0.3, 0.3, 0.72, 0, 0, 0, 10);
    for (const y of [0.12, 0.56]) cyl(g, 'ink', 'barrel_hoop', 0.315, 0.315, 0.05, 0, y, 0, 10);
    return g;
  }
  function rock(p, x, z, s = 1) {
    const r = ball(p, pick(['rock', 'stone_dark']), 'boulder', 0.45 * s, x, 0.15 * s, z, 0);
    r.scale.set(0.5 * s, 0.32 * s, 0.42 * s); r.rotation.y = rnd() * PI;
    return r;
  }
  function flowerBed(p, x, z, w = 1.6, d = 0.7) {
    const g = grp(p, 'flower_bed', x, 0, z);
    box(g, 'wood_dark', 'bed_edge', w, 0.16, d); box(g, 'soil', 'bed_soil', w - 0.1, 0.04, d - 0.1, 0, 0.16, 0);
    for (let i = 0; i < Math.round(w / 0.3); i++) box(g, pick(['fl_pink', 'fl_yellow', 'fl_red', 'fl_white', 'leaf_c']), 'bed_flower', 0.14, 0.14, 0.14, -w / 2 + 0.2 + i * 0.3, 0.2, rr(-d / 4, d / 4));
    return g;
  }
  function flagpole(p, x, z, h = 4.2) {
    const g = grp(p, 'flagpole', x, 0, z);
    box(g, 'stone', 'flag_base', 0.5, 0.2, 0.5); cyl(g, 'metal', 'flag_pole', 0.05, 0.06, h, 0, 0.2, 0, 8);
    ball(g, 'brass', 'flag_finial', 0.09, 0, h + 0.28, 0, 0);
    // the pennant, as three stepped orange boxes (pixel art, no curved cloth)
    box(g, 'robot_orange', 'pennant', 1.0, 0.52, 0.04, 0.55, h - 0.5, 0);
    box(g, 'robot_orange', 'pennant', 0.5, 0.34, 0.04, 1.3, h - 0.41, 0);
    box(g, 'robot_orange', 'pennant', 0.3, 0.16, 0.04, 1.7, h - 0.32, 0);
    return g;
  }
  return { tree, bush, lamp, fence, bench, crate, barrel, rock, flowerBed, flagpole };
}

// ---------- terrain ----------
// Edge noise per island: a sum of three sines, phases fixed by the island's centre so the shape never changes.
export function edgeRadius(isl, a) {
  const p = isl.x * 0.37 + isl.z * 0.23;
  return isl.r + isl.noise * (0.5 * Math.sin(3 * a + p) + 0.32 * Math.sin(5 * a + 2 + p * 1.7) + 0.18 * Math.sin(9 * a + p * 0.6));
}
const TYPE_RANK = { grass: 0, dirt: 1, stone: 2 };

function buildTerrain(ctx, world) {
  const { kit, L } = ctx, { C, rr, rnd, pick, Batch } = kit;
  const tiles = new Map(), K = (x, z) => x + ',' + z;
  const nearestIsland = (x, z) => Object.keys(L.ISLANDS).reduce((a, b) => {
    const da = Math.hypot(x - L.ISLANDS[a].x, z - L.ISLANDS[a].z) - L.ISLANDS[a].r, db = Math.hypot(x - L.ISLANDS[b].x, z - L.ISLANDS[b].z) - L.ISLANDS[b].r;
    return db < da ? b : a;
  });
  // 1. every island: tiles inside its noisy edge; e = how far inland (deeper rock under the middle)
  for (const [key, isl] of Object.entries(L.ISLANDS)) {
    const R = Math.ceil(isl.r + isl.noise + 1);
    for (let x = isl.x - R; x <= isl.x + R; x++) for (let z = isl.z - R; z <= isl.z + R; z++) {
      const dx = x - isl.x, dz = z - isl.z, e = edgeRadius(isl, Math.atan2(dz, dx)) - Math.hypot(dx, dz);
      if (e > 0) tiles.set(K(x, z), { x, z, isl: key, e, type: 'grass' });
    }
  }
  // 2. paint paths and paving along polylines; force=true creates land where the noise carved it away
  const paint = (pts, rad, type, force = false) => {
    const samples = pts.length === 1 ? [pts[0]] : [];
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, az] = pts[i], [bx, bz] = pts[i + 1], n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 0.25));
      for (let k = 0; k <= n; k++) samples.push([ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n]);
    }
    for (const [px, pz] of samples) for (let x = Math.floor(px - rad); x <= Math.ceil(px + rad); x++) for (let z = Math.floor(pz - rad); z <= Math.ceil(pz + rad); z++) {
      if (Math.hypot(x - px, z - pz) > rad) continue;
      let t = tiles.get(K(x, z));
      if (!t) { if (!force) continue; t = { x, z, isl: nearestIsland(x, z), e: 0.6, type: 'grass' }; tiles.set(K(x, z), t); }
      if (TYPE_RANK[type] >= TYPE_RANK[t.type]) t.type = type;
    }
  };
  paintMainIsland(L, paint);
  paintIslets(L, paint);
  // 3. draw: one batch for the tiles, one for the paving stones on top of stone tiles
  const grassCols = ['#6fa94f', '#79b357', '#84bd60', '#8ec668', '#99cd72'];
  const tb = new Batch(), pb = new Batch();
  for (const t of tiles.values()) {
    const n = Math.sin(t.x * 0.35) + Math.cos(t.z * 0.31) + Math.sin((t.x + t.z) * 0.18);
    let top;
    if (t.type === 'grass') top = grassCols[Math.max(0, Math.min(4, Math.floor(((n + 3) / 6) * 5 + rr(-0.9, 0.9))))];
    else if (t.type === 'dirt') top = pick(['#d4aa74', '#cb9f69', '#dbb480']);
    else top = pick(['#b9af98', '#b1a790']);
    const topC = C(top).clone(); if ((t.x + t.z) & 1) topC.multiplyScalar(0.95);
    const depth = Math.round((1.2 + Math.min(t.e, 7) * 0.8 + rnd() * 1.4) * 2) / 2;
    const lip = t.type === 'grass' ? '#5e9541' : t.type === 'dirt' ? '#a77c4f' : '#a99f8a';
    const x0 = t.x - 0.5, x1 = t.x + 0.5, z0 = t.z - 0.5, z1 = t.z + 0.5;
    tb.box(x0, -0.3, z0, x1, 0, z1, topC, C(lip));
    const dirtCol = C((t.x + t.z) & 1 ? '#8d6040' : '#835a3c');
    tb.box(x0, Math.max(-2.2, -depth), z0, x1, -0.3, z1, dirtCol, dirtCol);
    if (depth > 2.2) { const rc = C((t.x * 3 + t.z) % 2 ? '#8f877b' : '#7f776c'); tb.box(x0, -depth, z0, x1, -2.2, z1, rc, rc); }
    if (t.type === 'stone') pb.box(t.x - 0.42, 0, t.z - 0.42, t.x + 0.42, DECK_TOP, t.z + 0.42, C(pick(['#ddd4c0', '#d1c7b1', '#e6dfcc', '#c7bda6'])), C('#a99f8a'));
  }
  tb.mesh(world, 'island_tiles'); pb.mesh(world, 'paving');
  // 4. a few rock spikes hanging under each island, so they read as floating
  for (const isl of Object.values(L.ISLANDS)) {
    const bottom = -(1.2 + Math.min(isl.r, 7) * 0.8) + 0.4;
    for (const [dx, dz, r, h] of [[0, 0, isl.r * 0.28, isl.r * 0.42], [isl.r * 0.3, -isl.r * 0.2, isl.r * 0.16, isl.r * 0.28], [-isl.r * 0.28, isl.r * 0.18, isl.r * 0.13, isl.r * 0.22]]) {
      const spike = kit.put(world, kit.gCone(+r.toFixed(2), +h.toFixed(2), 5), 'rock', 'island_spike', isl.x + dx, bottom - h / 2, isl.z + dz);
      spike.rotation.x = PI;
    }
  }
  return tiles;
}

// main island: avenue dock -> gatehouse, the plaza, gate aprons, booth pads, pen floor, bin pad, dirt paths
function paintMainIsland(L, paint) {
  const N = L.NODES;
  const fb = L.BRIDGES.factory, [bx, bz] = fb.dir;
  paint([[0, 8.2], [0, L.GATEHOUSE.z + L.GATEHOUSE.d / 2 + 0.3]], 1.05, 'stone');                // the avenue: south shore -> gatehouse
  paint([N.plaza_s, [fb.from[0] + bx * 0.3, fb.from[1] + bz * 0.3]], 1.05, 'stone');            // avenue -> the Factory bridge
  paint([[fb.from[0] + bx * 0.3, fb.from[1] + bz * 0.3], [fb.from[0] - bx * 1.5, fb.from[1] - bz * 1.5]], 1.1, 'stone', true); // the deck rests on paving
  const root = dockRoot(L);
  paint([root, [root[0] + 1.0, root[1] - 0.6]], 1.4, 'stone', true);                             // land under the pier's root
  paint([N.dock, N.plaza_s], 0.75, 'stone');                                                      // dock -> avenue
  paint([N.plaza], 3.0, 'stone');
  paint([[-4.4, -2.5], [4.4, -2.5]], 0.9, 'stone');                                       // in front of the gatehouse
  for (const key of Object.keys(L.GATES)) {
    const g = L.GATES[key], b = L.BRIDGES[key], [ux, uz] = b.dir, hub = { files: [N.plaza], admin: [N.plaza], mail: [N.plaza, N.plaza_w], github: [N.plaza, N.plaza_e] }[key];
    paint([...hub, g.stop], 0.75, 'dirt');
    paint([[b.from[0] + ux * 0.3, b.from[1] + uz * 0.3], [b.from[0] - ux * 1.5, b.from[1] - uz * 1.5], g.stop], 1.1, 'stone', true); // the deck always rests on paving
    paint([g.booth], 1.0, 'stone', true);
  }
  paint([[L.PEN.x - 1.2, L.PEN.z], [L.PEN.x + 1.2, L.PEN.z]], 1.6, 'dirt');
  paint([N.plaza_s, N.pen_gate], 0.7, 'dirt'); paint([N.plaza_s, N.bin], 0.7, 'dirt');
  paint([[L.BIN.x, L.BIN.z]], 1.1, 'stone');
  paint([CHIEF_BOOTH, N.chief_door], 0.8, 'stone');
  paint([CHIEF_BOOTH], 1.0, 'stone', true);
}

// islets: the bridge landing (forced stone), a path to the door, and a courtyard for the tower
function paintIslets(L, paint) {
  for (const key of L.TOOL_ISLETS) {
    const b = L.BRIDGES[key], [ux, uz] = b.dir, d = L.DOORS[key];
    paint([[b.to[0] - ux * 0.3, b.to[1] - uz * 0.3], [b.to[0] + ux * 1.5, b.to[1] + uz * 1.5]], 1.1, 'stone', true);
    paint([L.NODES[`shore_${key}`], [d.x, d.z]], key === 'mail' ? 0.7 : 0.8, key === 'mail' ? 'dirt' : 'stone');
  }
  paint([[L.ISLANDS.files.x, L.ISLANDS.files.z]], 4.3, 'stone');
  paint([[L.DOORS.admin.x, L.DOORS.admin.z]], 1.6, 'stone');
  paintFactory(L, paint);
}

// the Factory island: the bridge landing, the walk under the arch to the yard, the yard's apron, the hall's pad (forced:
// the hall is big for the island and its corners must never hang over the edge), the bay's floor, the cart's lane
function paintFactory(L, paint) {
  const F = L.FACTORY, N = L.NODES, H = F.hall, b = L.BRIDGES.factory;
  paint([[b.to[0] - b.dir[0] * 0.3, b.to[1] - b.dir[1] * 0.3], [b.to[0] + b.dir[0] * 1.6, b.to[1] + b.dir[1] * 1.6]], 1.1, 'stone', true);
  paint([N.shore_factory, N.yard, N.factory_door], 0.9, 'stone');
  paint([[F.yard.x - F.yard.w / 2 + 0.6, F.yard.z], [F.yard.x + F.yard.w / 2 - 0.6, F.yard.z]], 1.9, 'stone');
  for (let x = H.x0 + 0.5; x <= H.x1 - 0.4; x += 1) paint([[x, H.z0 + 0.4], [x, H.z1 - 0.4]], 0.8, 'stone', true);
  paint([[H.x1 + 0.9, H.z0 + 1.0], [H.x1 + 0.9, H.z1 - 0.5]], 0.9, 'dirt', true);                 // the apron along the east face
  paint([F.bay.lift], 2.3, 'stone', true);
  paint([N.yard, N.bay_gate, N.bay_lift], 0.8, 'stone');
  paint([N.factory_door, N.bay_gate, N.cart_home], 0.7, 'dirt');
}

// The chief's booth. layout.GATEHOUSE.chiefBooth was [-4.8, -2.9], but a 1.4-wide booth there stands across the
// plaza_w -> gate_mail path (a robot walking to the Mail gate would pass through it). This spot keeps 0.7 clear of
// that path and of the Files gate. layout.GATEHOUSE.chiefBooth now carries the same number (integrator).
export const CHIEF_BOOTH = [-6.6, -2.3];

// ---------- bridges ----------
// The deck height at distance s along a bridge of length len: level with the paving at both ends, SAG lower mid-way.
export const deckY = (s, len) => DECK_TOP - SAG * 4 * (s / len) * (1 - s / len);

function buildBridge(ctx, parent, key, lanternMat) {
  const { kit, L } = ctx, { put, gBox, box, cyl, grp, pick } = kit;
  const b = L.BRIDGES[key], [ux, uz] = b.dir, len = b.length, hw = b.width / 2;
  const g = grp(parent, 'bridge_' + key, b.from[0], 0, b.from[1], Math.atan2(-uz, ux)); // local +x runs along the deck
  const slope = (s) => (-SAG * 4 * (1 - (2 * s) / len)) / len;
  const n = Math.round(len / 0.36), step = len / n;
  for (let i = 0; i < n; i++) {
    const s = (i + 0.5) * step;
    const p = put(g, gBox(+(step - 0.06).toFixed(3), 0.08, b.width), pick(['plank', 'plank', 'wood', 'wood_light']), 'bridge_plank', s, deckY(s, len) - 0.04, 0);
    p.rotation.z = Math.atan(slope(s));
  }
  // posts in pairs every 2 units at most, rope rails and stringers between them, following the sag
  const m = Math.ceil(len / 2), seg = len / m;
  for (let k = 0; k <= m; k++) {
    const s = k * seg, y = deckY(s, len), end = k === 0 || k === m;
    for (const side of [-1, 1]) {
      if (end) {
        box(g, 'stone_dark', 'bridge_anchor_base', 0.36, 0.2, 0.36, s, y - 0.05, side * (hw + 0.12));
        box(g, 'wood_dark', 'bridge_anchor_post', 0.2, 1.3, 0.2, s, y, side * (hw + 0.12));
        box(g, lanternMat, 'bridge_lantern', 0.2, 0.22, 0.2, s, y + 1.3, side * (hw + 0.12));
        box(g, 'ink', 'bridge_lantern_cap', 0.26, 0.06, 0.26, s, y + 1.52, side * (hw + 0.12));
      } else box(g, 'wood_dark', 'bridge_post', 0.12, 1.0, 0.12, s, y - 0.1, side * (hw + 0.06));
    }
    if (k === m) break;
    const s1 = s + seg, y1 = deckY(s1, len), tilt = Math.atan2(y1 - y, seg), chord = Math.hypot(seg, y1 - y);
    const mid = grp(g, 'bridge_span', s + seg / 2, (y + y1) / 2, 0); mid.rotation.z = tilt;
    for (const side of [-1, 1]) {
      box(mid, 'rope', 'bridge_rope', chord, 0.06, 0.06, 0, 0.82, side * (hw + 0.06));
      box(mid, 'rope', 'bridge_rope', chord, 0.05, 0.05, 0, 0.42, side * (hw + 0.06));
      box(mid, 'wood_dark', 'bridge_stringer', chord, 0.14, 0.12, 0, -0.24, side * (hw - 0.18));
    }
  }
  cyl(g, 'rope', 'rope_coil', 0.22, 0.22, 0.1, 0.4, DECK_TOP, hw + 0.45, 10);
  return g;
}

// ground height at (x, z): on a bridge deck it follows the sag, elsewhere it is the paving top.
// Not in the brief's interface; actors.js may use it so robots walk on the planks instead of floating.
export function groundY(L, x, z) {
  for (const b of Object.values(L.BRIDGES)) {
    const [ux, uz] = b.dir, dx = x - b.from[0], dz = z - b.from[1];
    const s = dx * ux + dz * uz, side = Math.abs(-dx * uz + dz * ux);
    if (s >= 0 && s <= b.length && side <= b.width / 2 + 0.4) return deckY(s, b.length);
  }
  return DECK_TOP;
}

// ---------- gates ----------
// Two posts across the path at the barrier line, the striped arm pivoting on the booth-side post, the tool sign high
// on the far post (above the robots' heads, turned to the camera), a mustard stop line, and the booth with its guard.
function buildGate(ctx, parent, key) {
  const { THREE, kit, L } = ctx, { box, put, gBox, grp } = kit;
  const G = L.GATES[key], [ux, uz] = G.dir, [px, pz] = G.perp;
  const ry = Math.atan2(-pz, px);                    // local +x points from the path toward the booth
  const g = grp(parent, 'gate_' + key, G.x, 0, G.z, ry);
  const pivotX = 0.82, farX = -1.1, armY = 0.92, armLen = pivotX - farX;
  box(g, 'stone_dark', 'barrier_housing', 0.3, 1.0, 0.3, pivotX, 0, 0);
  box(g, 'ink', 'barrier_housing_cap', 0.36, 0.06, 0.36, pivotX, 1.0, 0);
  const barrier = grp(g, 'barrier', pivotX, armY, 0);     // rotation.z: 0 = down across the path, -1.25 = lifted
  put(barrier, gBox(0.2, 0.2, 0.2), 'ink', 'barrier_hub', 0, 0, 0);
  const ns = 5, sl = +(armLen / ns).toFixed(3);
  for (let i = 0; i < ns; i++) put(barrier, gBox(sl, 0.14, 0.12), i % 2 ? 'stripe_white' : 'stripe_red', 'barrier_stripe', -(i + 0.5) * sl, 0, 0);
  // far post: the arm rests on its fork; the signboard sits on top
  box(g, 'stone_dark', 'gate_post_base', 0.34, 0.16, 0.34, farX, 0, 0);
  box(g, 'wood_dark', 'gate_post', 0.18, 3.3, 0.18, farX, 0, 0);
  box(g, 'ink', 'barrier_rest', 0.12, 0.12, 0.3, farX + 0.12, armY - 0.16, 0);
  const tools = Object.keys(L.GATE_OF_TOOL).filter((t) => L.GATE_OF_TOOL[t] === key);
  const sign = pixelSign(ctx, [{ text: L.ISLANDS[key].name, size: 2, color: '#f3ead7' }, ...tools.map((t) => ({ text: t, size: 1, color: '#e7b94e' }))], { pad: 3 });
  const board = signBoard(ctx, g, 'gate_sign', sign, 2.4, 0.1, farX, 3.3, 0, PI / 4 - ry);
  // the padlock under the sign (round two): turned to the camera like the sign, just in front of the post
  const lock = grp(g, 'gate_padlock', farX, 0, 0, PI / 4 - ry);
  signBoard(ctx, lock, 'gate_padlock_plate', padlockSign(ctx), 1.15, 0.06, 0, 2.1, 0.14, 0, true, 'ink'); // top at 3.25, under the sign
  lock.visible = false;
  // the stop line, in world coordinates, just in front of where a robot halts
  const line = grp(parent, 'stop_line_' + key, G.x - ux * 0.6, 0, G.z - uz * 0.6, ry);
  box(line, 'mustard', 'stop_line', 1.7, 0.02, 0.14, 0, DECK_TOP, 0);
  const booth = buildBooth(ctx, parent, 'booth_' + key, G.booth, [-px, -pz], { counter: true });
  g.updateMatrixWorld(true);
  const signTop = board.g.localToWorld(new THREE.Vector3(0, board.h, 0));
  return {
    key, barrier, lampMat: booth.lampMat, counter: booth.counter, guardHome: booth.guardHome,
    padlock: { set: (on) => { booth.padlock.set(on); lock.visible = !!on; } },
    stampAnchor: new THREE.Vector3(G.x, 2.9, G.z), signTop, booth: booth.g,
  };
}

// ---------- the dock: a plank pier sticking out south-west, with the round hatch the robots rise from ----------
// Build 3: the pier runs along layout.DOCK.dir from the shore; the group's local +z points out along the pier and the
// hatch sits on its centre line HATCH_AT units out, so the hatch spots of six robots (three rows) all stand on planks.
const HATCH_AT = 2.8;
export const dockRoot = (L) => [L.DOCK.hatch[0] - L.DOCK.dir[0] * HATCH_AT, L.DOCK.hatch[1] - L.DOCK.dir[1] * HATCH_AT];
function buildDock(ctx, parent) {
  const { THREE, kit, L } = ctx, { box, cyl, grp, pick } = kit;
  const D = L.DOCK, [rx, rz] = dockRoot(L), z0 = -1.2, z1 = HATCH_AT + 1.3 + 1.2, w = 4.2, h = HATCH_AT;
  const g = grp(parent, 'dock', rx, 0, rz, Math.atan2(D.dir[0], D.dir[1]));
  box(g, 'wood_dark', 'pier_frame', w, 0.3, z1 - z0, 0, -0.29, (z0 + z1) / 2);
  for (let z = z0 + 0.21; z < z1; z += 0.42) box(g, pick(['plank', 'wood', 'plank']), 'pier_plank', w, 0.06, 0.38, 0, 0.01, z);
  for (const s of [-1, 1]) {
    for (const z of [h - 1.6, z1 - 0.3]) { cyl(g, 'wood_dark', 'pier_piling', 0.17, 0.17, 2.9, s * (w / 2 - 0.15), -2.6, z, 8); cyl(g, 'ink', 'piling_cap', 0.19, 0.19, 0.06, s * (w / 2 - 0.15), 0.3, z, 8); }
    box(g, 'wood_dark', 'pier_crossbeam', 0.16, 0.18, z1 - h + 1.8, s * (w / 2 - 0.15), -1.9, (h - 1.6 + z1 - 0.3) / 2);
  }
  cyl(g, 'metal', 'hatch_ring', 1.62, 1.62, 0.05, 0, 0.07, h, 16);
  cyl(g, 'ink', 'hatch_hole', 1.46, 1.46, 0.06, 0, 0.07, h, 16);
  for (let i = 0; i < 4; i++) { const a = (i * PI) / 2 + PI / 4; box(g, 'mustard', 'hatch_bolt', 0.16, 0.06, 0.16, Math.cos(a) * 1.54, 0.07, h + Math.sin(a) * 1.54); }
  // two rowing boats moored on the pier's sides, hanging in the air like everything else here, tied to the pilings
  for (const s of [-1, 1]) {
    const b = grp(g, 'rowing_boat', s * (w / 2 + 0.95), -0.55, h + 0.3 * s, s * 0.08);
    box(b, 'wood_dark', 'boat_hull', 0.9, 0.22, 2.3, 0, 0, 0); box(b, s > 0 ? 'mailbox' : 'brick', 'boat_strake', 1.04, 0.2, 2.1, 0, 0.2, 0);
    box(b, 'wood_light', 'boat_inside', 0.78, 0.06, 1.9, 0, 0.32, 0); box(b, 'wood_dark', 'boat_bow', 0.6, 0.3, 0.3, 0, 0.12, 1.25);
    box(b, 'wood_dark', 'boat_stern', 0.8, 0.3, 0.12, 0, 0.12, -1.12);
    for (const z of [-0.45, 0.4]) box(b, 'wood', 'boat_thwart', 0.86, 0.06, 0.24, 0, 0.36, z);
    for (const o of [-1, 1]) { const oar = grp(b, 'boat_oar', o * 0.5, 0.42, 0, 0); oar.rotation.z = o * 0.25; box(oar, 'wood_light', 'oar', 0.06, 0.06, 1.7, o * 0.2, 0, -0.2); }
    box(g, 'rope', 'boat_line', 0.06, 0.06, 1.0, s * (w / 2 + 0.3), -0.1, h + 0.9 * s, 0).rotation.y = s * 0.9;
  }
  return { g, hatch: new THREE.Vector3(D.hatch[0], DECK_TOP, D.hatch[1]), end: g.localToWorld(new THREE.Vector3(0, 0, z1)) };
}

// ---------- the pen: brass posts and velvet rope; the west rope segment swings open (rotation.y 0 shut, -1.5 open) ----------
function buildPen(ctx, parent) {
  const { THREE, kit, L } = ctx, { box, cyl, ball, grp, M } = kit;
  const P = L.PEN, x0 = P.x - P.w / 2, x1 = P.x + P.w / 2, z0 = P.z - P.d / 2, z1 = P.z + P.d / 2;
  const gz0 = P.gate[1] - 0.8, gz1 = P.gate[1] + 0.8; // the gate opening on the west side
  const post = (x, z) => { cyl(parent, 'brass', 'pen_post', 0.08, 0.1, 0.85, x, 0, z, 8); ball(parent, 'brass', 'pen_knob', 0.1, x, 0.92, z, 0); };
  const rope = (ax, az, bx, bz) => { const L2 = Math.hypot(bx - ax, bz - az); const r = grp(parent, 'velvet_rope', (ax + bx) / 2, 0, (az + bz) / 2, -Math.atan2(bz - az, bx - ax)); box(r, 'velvet', 'pen_rope', L2, 0.08, 0.08, 0, 0.6, 0); };
  const ring = [[x0, gz0], [x0, z0], [P.x, z0], [x1, z0], [x1, P.z], [x1, z1], [P.x, z1], [x0, z1], [x0, gz1]];
  ring.forEach(([x, z]) => post(x, z));
  for (let i = 0; i < ring.length - 1; i++) rope(ring[i][0], ring[i][1], ring[i + 1][0], ring[i + 1][1]);
  const gate = grp(parent, 'pen_gate', x0, 0, gz0, 0);           // hinge on the north post of the opening
  box(gate, 'velvet', 'pen_gate_rope', 0.08, 0.08, gz1 - gz0 - 0.1, 0, 0.6, (gz1 - gz0) / 2);
  box(gate, 'brass', 'pen_gate_clip', 0.12, 0.12, 0.12, 0, 0.58, gz1 - gz0 - 0.08);
  // the lamp post on the north side, and the OFF LIMITS sign behind the pen (so it never hides a robot)
  const lp = grp(parent, 'pen_lamp', P.lamp[0], 0, P.lamp[1]);
  box(lp, 'stone_dark', 'pen_lamp_base', 0.3, 0.16, 0.3); cyl(lp, 'ink', 'pen_lamp_post', 0.05, 0.06, 1.7, 0, 0.16, 0, 8);
  const lampMat = M.lamp_off.clone(); lampMat.name = 'pen_lamp'; lampMat.emissiveIntensity = 0.7;
  box(lp, lampMat, 'pen_lamp_cube', 0.38, 0.38, 0.38, 0, 1.86, 0); box(lp, 'ink', 'pen_lamp_cap', 0.44, 0.06, 0.44, 0, 2.24, 0);
  const sx = x1 + 0.3, sz = z0 - 0.3;
  box(parent, 'wood_dark', 'off_limits_post', 0.12, 1.0, 0.12, sx, 0, sz);
  const sign = pixelSign(ctx, [{ text: 'OFF', color: '#fbf7ee' }, { text: 'LIMITS', color: '#fbf7ee' }], { bg: '#b4553e', border: '#fbf7ee', pad: 2 });
  signBoard(ctx, parent, 'off_limits_sign', sign, 1.4, 0.08, sx, 0.95, sz, PI / 4);
  return { gate, lampMat, stampAnchor: new THREE.Vector3(P.x, 3.3, P.z) };
}

// ---------- the BLOCKED bin: a crate that fills with red packets ----------
function buildBin(ctx, parent) {
  const { THREE, kit, L } = ctx, { box, grp } = kit;
  const B = L.BIN, g = grp(parent, 'blocked_bin', B.x, 0, B.z);
  box(g, 'wood_dark', 'bin_body', 1.4, 0.8, 1.0);
  for (const y of [0.18, 0.46]) box(g, 'wood', 'bin_slat', 1.44, 0.12, 1.04, 0, y, 0);
  box(g, 'ink', 'bin_inside', 1.2, 0.05, 0.8, 0, 0.76, 0);
  for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) box(g, 'metal', 'bin_corner', 0.1, 0.84, 0.1, x * 0.68, 0, z * 0.48);
  const sign = pixelSign(ctx, [{ text: 'BLOCKED', color: '#fbf7ee' }], { bg: '#b4553e', border: '#3a312b', pad: 1 });
  signBoard(ctx, g, 'bin_label', sign, 1.2, 0.04, 0, 0.2, 0.53, 0, false);
  signBoard(ctx, g, 'bin_label', sign, 0.9, 0.04, 0.73, 0.22, 0, PI / 2, false);
  return { g, anchor: new THREE.Vector3(B.x, 2.0, B.z), dropPoint: new THREE.Vector3(B.x, 0.81, B.z), stack: [] };
}

// ---------- scenery placement (data, so tests/layout checks can read it) ----------
// main island: [x, z, scale] trees, [x, z] lamps, [x, z, scale, flowers] bushes; kept clear of every walking edge
export const PROPS = {
  trees: [[-8.2, 3.2, 1.0], [4.4, 6.9, 0.85], [0.2, -8.5, 0.8], [-2.5, -8.4, 0.7], [2.8, -8.3, 0.75], [-8.2, 5.9, 0.8],
    [8.4, -3.6, 0.8], [-8.6, -3.8, 0.75], [6.9, 7.6, 0.7], [-3.2, 8.9, 0.7]],
  lamps: [[-1.7, 4.2], [1.7, 4.2], [-1.7, 8.0], [1.7, 8.0], [-2.3, -0.9], [2.3, -0.9]],
  bushes: [[3.7, -2.75, 0.8, true], [-2.6, 3.2, 0.8, true], [-8.4, 1.9, 0.7, false], [6.6, 6.3, 0.7, true], [9.0, 2.6, 0.7, false],
    [-2.9, 7.6, 0.7, true], [3.3, 8.7, 0.7, false], [-7.6, -1.3, 0.6, true], [5.0, -8.0, 0.7, false]],
  beds: [[2.7, 6.9]],
  flag: [-5.6, 2.0],
  fences: [[[2.5, 8.5], [4.4, 7.7]]],
};
// islets, in local coordinates: u = toward the main island (along DOORS.facing), v = to the right of that
export const ISLET_PROPS = {
  files: { trees: [[1.0, 4.4, 1.0], [-2.4, 4.3, 0.9], [-4.6, 1.6, 0.9], [1.0, -4.4, 0.95], [-2.4, -4.3, 0.85], [-4.6, -1.6, 1.0], [-5.4, 0.0, 0.8], [2.8, 4.9, 0.7], [2.8, -4.9, 0.75]],
    lamps: [[4.4, 1.4], [4.4, -1.4]], benches: [[3.4, 3.2], [3.4, -3.2]], bushes: [[4.8, 2.9, 0.6, true], [4.8, -2.9, 0.6, true], [-0.4, 5.3, 0.6, false], [-0.4, -5.3, 0.6, true]] },
  mail: { trees: [[-3.4, 1.9, 0.9], [-3.4, -1.9, 0.8], [0.4, -3.6, 0.85], [-1.8, 3.9, 0.7], [-4.3, 0.0, 0.75], [2.4, 4.1, 0.6]], lamps: [[3.7, -1.3]],
    bushes: [[1.6, 3.4, 0.8, true], [-1.2, 3.5, 0.7, true], [2.2, -3.2, 0.7, true], [-2.6, -3.5, 0.6, false], [4.2, 0.0, 0.5, true], [0.0, -4.5, 0.6, true]], fences: [[[3.4, 1.3], [3.0, 3.1]], [[3.4, -1.3], [3.0, -3.1]]] },
  github: { trees: [[-3.4, 2.0, 0.9], [-3.4, -2.0, 1.0], [1.4, 3.6, 0.8], [-4.2, 0.0, 0.7], [-1.2, -4.2, 0.75], [2.9, 3.0, 0.6]], lamps: [[3.7, 1.3], [3.7, -1.3]],
    rocks: [[2.4, -3.4, 1.2], [0.4, -3.8, 0.9], [-1.8, 3.6, 1.0]], bushes: [[-2.2, 3.9, 0.6, true], [3.6, -2.6, 0.6, false], [0.2, 4.4, 0.6, true]] },
  admin: { trees: [[-3.5, 1.9, 0.9], [-3.5, -1.9, 0.9], [-4.3, 0.0, 0.8], [-1.4, 4.0, 0.7], [-1.4, -4.0, 0.7]], lamps: [[3.8, 1.3], [3.8, -1.3]],
    bushes: [[2.2, 3.3, 0.7, false], [2.2, -3.3, 0.7, false], [0.4, 3.6, 0.7, false], [0.4, -3.6, 0.7, false], [-2.8, 3.4, 0.6, true], [-2.8, -3.4, 0.6, true]] },
};
// the Factory island, relative to its centre (it has no DOORS entry to turn local u/v into world points); kept clear of
// the hall, the yard, the bay, the cart's lane and every walking edge
export const FACTORY_PROPS = {
  trees: [[-3.0, -7.6, 0.8], [-5.6, -6.4, 0.9], [6.6, -5.4, 0.8], [7.6, -2.4, 0.7], [6.0, 2.6, 0.8], [-0.8, 7.8, 0.7], [-4.6, 8.0, 0.6], [7.2, 3.8, 0.6]],
  bushes: [[-0.2, -7.2, 0.6, true], [6.3, 4.2, 0.6, false], [-1.4, 7.6, 0.6, true], [8.3, 0.0, 0.5, true], [-8.0, 0.6, 0.6, false], [1.2, -8.4, 0.5, true]],
  lamps: [[5.2, 1.0]],
};
export function isletToWorld(L, key, u, v) {
  const isl = L.ISLANDS[key], [fx, fz] = L.DOORS[key].facing;
  return [isl.x + fx * u - fz * v, isl.z + fz * u + fx * v];
}

function placeProps(ctx, parent, S) {
  const { L } = ctx;
  PROPS.trees.forEach(([x, z, s]) => S.tree(parent, x, z, s));
  PROPS.lamps.forEach(([x, z]) => S.lamp(parent, x, z));
  PROPS.bushes.forEach(([x, z, s, f]) => S.bush(parent, x, z, s, f));
  PROPS.beds.forEach(([x, z]) => S.flowerBed(parent, x, z));
  S.flagpole(parent, PROPS.flag[0], PROPS.flag[1]);
  PROPS.fences.forEach((pts) => S.fence(parent, pts));
  // dock props, in the pier's own frame (u across the pier, w out along it from the hatch)
  const [ux, uz] = L.DOCK.dir, dockAt = (u, w) => [L.DOCK.hatch[0] - uz * u + ux * w, L.DOCK.hatch[1] + ux * u + uz * w];
  S.crate(parent, ...dockAt(1.6, 2.1), 0.6, 0.2); S.crate(parent, ...dockAt(1.55, 1.45), 0.45, -0.3); S.barrel(parent, ...dockAt(-1.6, 2.1));
  S.lamp(parent, ...dockAt(-1.75, 1.0));
  S.barrel(parent, L.BIN.x - 1.15, L.BIN.z - 0.2); S.crate(parent, L.BIN.x - 1.1, L.BIN.z + 0.7, 0.5, 0.4);
  const fc = (x, z) => [L.ISLANDS.factory.x + x, L.ISLANDS.factory.z + z];
  FACTORY_PROPS.trees.forEach(([x, z, s]) => S.tree(parent, ...fc(x, z), s));
  FACTORY_PROPS.bushes.forEach(([x, z, s, f]) => S.bush(parent, ...fc(x, z), s, f));
  FACTORY_PROPS.lamps.forEach(([x, z]) => S.lamp(parent, ...fc(x, z)));
  for (const [key, list] of Object.entries(ISLET_PROPS)) {
    const at = (u, v) => isletToWorld(L, key, u, v), face = Math.atan2(...L.DOORS[key].facing);
    (list.trees || []).forEach(([u, v, s]) => S.tree(parent, ...at(u, v), s));
    (list.lamps || []).forEach(([u, v]) => S.lamp(parent, ...at(u, v)));
    (list.bushes || []).forEach(([u, v, s, f]) => S.bush(parent, ...at(u, v), s, f));
    (list.rocks || []).forEach(([u, v, s]) => S.rock(parent, ...at(u, v), s));
    (list.benches || []).forEach(([u, v]) => S.bench(parent, ...at(u, v), face + (v > 0 ? -PI / 2 : PI / 2)));
    (list.fences || []).forEach((pts) => S.fence(parent, pts.map(([u, v]) => at(u, v))));
  }
}

// ---------- reeds: little clumps of thin stems just inside every island's edge, skipping the bridge landings ----------
function buildReeds(ctx, parent) {
  const { kit, L } = ctx, { box, grp, rr, rnd } = kit;
  const near = (x, z, pts, r) => pts.some(([px, pz]) => Math.hypot(px - x, pz - z) < r);
  const keepOut = [];
  for (const b of Object.values(L.BRIDGES)) keepOut.push(b.from, b.to);
  keepOut.push(L.DOCK.hatch, dockRoot(L));
  for (const [key, isl] of Object.entries(L.ISLANDS)) {
    const n = Math.round(isl.r * 1.6);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * PI * 2 + rr(-0.15, 0.15), r = edgeRadius(isl, a) - 0.75;
      const x = isl.x + Math.cos(a) * r, z = isl.z + Math.sin(a) * r;
      if (near(x, z, keepOut, 2.6)) continue;
      const H = L.FACTORY.hall;
      if (key === 'factory' && x < H.x0 + 0.6 && z > H.z0 - 0.6 && z < H.z1 + 0.6) continue; // under the hall's west wall
      const g = grp(parent, 'reeds', x, 0, z, rnd() * PI);
      for (let k = 0; k < 5; k++) {
        const h = +rr(0.35, 0.75).toFixed(2);
        box(g, k % 2 ? 'leaf_d' : 'ivy', 'reed', 0.05, h, 0.05, rr(-0.22, 0.22), 0, rr(-0.22, 0.22));
        if (k === 0) box(g, 'trunk', 'reed_head', 0.08, 0.16, 0.08, 0, h, 0);
      }
    }
  }
}

// ---------- gulls: six white birds of three boxes each, circling slowly over the harbour (y 9 to 12) ----------
// Their circles stay south-west of the gatehouse so they never cross a building label. Not inked (noNormal), like clouds.
function buildGulls(ctx, parent) {
  const { kit, stage } = ctx, { box, grp } = kit;
  const gulls = [];
  for (let i = 0; i < 6; i++) {
    const g = grp(parent, 'gull', 0, 0, 0);
    box(g, 'cloud', 'gull_body', 0.36, 0.26, 0.9, 0, -0.13, 0);
    box(g, 'ink', 'gull_beak', 0.1, 0.08, 0.16, 0, -0.05, 0.5);
    const wings = [-1, 1].map((s) => { const w = grp(g, 'gull_wing', s * 0.16, 0, 0); box(w, 'cloud', 'gull_wing', 1.0, 0.06, 0.4, s * 0.5, 0, -0.06); box(w, 'stone_dark', 'gull_wingtip', 0.24, 0.07, 0.4, s * 0.9, 0, -0.06); return w; });
    if (stage && stage.noNormal) stage.noNormal.add(g);
    gulls.push({ g, wings, cx: -3.0 + (i % 3) * 1.6, cz: 6.0 + (i % 2) * 2.0, r: 3.2 + (i % 3) * 0.9, y: 9 + (i * 0.6) % 3, w: (i % 2 ? -1 : 1) * (0.22 + i * 0.025), ph: i * 1.1 });
  }
  return gulls;
}

// ---------- clouds: six drift below the islands, three far behind them; never inked by the outline pass ----------
function buildClouds(ctx, parent) {
  const { kit, stage } = ctx, { box, grp, rr } = kit;
  const spots = [[-30, -10.5, -14], [-6, -11.5, 6], [18, -10, -6], [34, -12, 10], [-20, -12, 16], [8, -11, -26],
    [-26, 8.5, -40], [4, 10, -44], [30, 7.5, -38], [-40, 11, -24], [18, 12, -50]];
  return spots.map(([x, y, z], i) => {
    const g = grp(parent, 'cloud', x, y, z);
    const n = 3 + (i % 3);
    for (let k = 0; k < n; k++) box(g, 'cloud', 'cloud_block', +rr(1.6, 3.0).toFixed(1), +rr(0.6, 1.0).toFixed(1), +rr(1.0, 1.8).toFixed(1), (k - n / 2) * 1.2, rr(-0.2, 0.4), rr(-0.6, 0.6));
    if (stage && stage.noNormal) stage.noNormal.add(g);
    return { mesh: g, speed: +rr(0.18, 0.4).toFixed(2), x0: -46, x1: 46 };
  });
}

// ---------- the whole world ----------
export function buildWorld(ctx) {
  const { THREE, kit, L } = ctx;
  const world = new THREE.Group(); world.name = 'mytopia_archipelago';
  buildTerrain(ctx, world);
  const lanternMat = kit.M.lamp_glow;
  for (const key of Object.keys(L.BRIDGES)) buildBridge(ctx, world, key, lanternMat);
  const gates = {};
  for (const key of Object.keys(L.GATES)) gates[key] = buildGate(ctx, world, key);
  const dock = buildDock(ctx, world);
  const pen = buildPen(ctx, world);
  const bin = buildBin(ctx, world);
  placeProps(ctx, world, makeScenery(ctx));
  buildReeds(ctx, world);
  const clouds = buildClouds(ctx, world);
  const gulls = buildGulls(ctx, world);
  world.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  for (const c of clouds) c.mesh.traverse((o) => { o.castShadow = false; o.receiveShadow = false; });
  for (const gl of gulls) gl.g.traverse((o) => { o.castShadow = false; o.receiveShadow = false; });
  function tick(t, dt) {
    for (const c of clouds) { c.mesh.position.x += c.speed * dt; if (c.mesh.position.x > c.x1) c.mesh.position.x = c.x0; }
    for (const gl of gulls) {
      const a = gl.ph + t * gl.w;
      gl.g.position.set(gl.cx + Math.cos(a) * gl.r, gl.y + Math.sin(t * 0.7 + gl.ph) * 0.3, gl.cz + Math.sin(a) * gl.r);
      gl.g.rotation.y = -a + (gl.w > 0 ? 0 : PI);           // fly along the circle
      const flap = Math.sin(t * 5 + gl.ph * 3) * 0.45;
      gl.wings[0].rotation.z = flap; gl.wings[1].rotation.z = -flap;
    }
  }
  return {
    world, gates, pen, bin, dock: { hatch: dock.hatch }, clouds, tick,
    groundY: (x, z) => groundY(L, x, z), // extra (not in the interface): deck height on bridges, paving height elsewhere
  };
}
