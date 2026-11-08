// The five buildings: the FILES tower, the GitHub studio, the Mail cottage, the Admin courthouse and the gatehouse
// (docs/ISLAND_V2.md section 2). Each islet building faces its bridge (layout.DOORS[key].facing) and has a door lamp.
// Pre-existing (Mytopia's campus.js, via v1 scene.js): windowOn, door, archWindow, gableRoof and the studio, cottage
// and courthouse shapes (here at scale 1.15). New today: the FILES skyscraper with its pixel-letter blade sign, the
// two-storey gatehouse (authentication window, GATEWAY sign, clock at 9:15, ledger tube, pennant), the chief's booth
// and the door lamps. buildBuildings(ctx, world) returns PLACES: the points and materials the actors and effects use.
import { buildBooth, pixelSign, signBoard, CHIEF_BOOTH } from './world.js';

const PI = Math.PI;

// ---------- recipes from Mytopia's campus.js ----------
function makeRecipes(ctx) {
  const { THREE, kit } = ctx, { GC, put, box, grp, gBox } = kit;
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
      const pl = put(g, gBox(W + 2 * ov, 0.16, L), m, 'roof_plane', 0, rise - (hd * Math.tan(th)) / 2 + 0.08 / Math.cos(th), (s * hd) / 2);
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
  // new today: a door lamp on a short ink bracket; returns its own material so effects can light it
  function doorLamp(p, key, x, y, z) {
    const m = kit.M.lamp_off.clone(); m.name = 'door_lamp_' + key; m.emissiveIntensity = 0.7;
    box(p, 'ink', 'door_lamp_bracket', 0.1, 0.06, 0.22, x, y, z - 0.08);
    box(p, m, 'door_lamp', 0.28, 0.28, 0.28, x, y + 0.06, z);
    box(p, 'ink', 'door_lamp_cap', 0.34, 0.05, 0.34, x, y + 0.34, z);
    return m;
  }
  return { windowOn, door, archWindow, gableRoof, doorLamp };
}

// A group on islet `key`, turned so its local +z faces the bridge, set back `reach` world units behind the door spot.
function placeOnIslet(ctx, parent, key, reach, name, scale = 1) {
  const { kit, L } = ctx, d = L.DOORS[key], [fx, fz] = d.facing;
  const g = kit.grp(parent, name, d.x - fx * reach, 0, d.z - fz * reach, Math.atan2(fx, fz));
  g.scale.setScalar(scale);
  return g;
}

// ---------- FILES: the skyscraper (new today) ----------
// Stone base (two floors, arched windows, columns at the door), seven brick floors with a seeded lit-window grid,
// a stone setback of two floors, flat roof with parapet, water tank, antenna, and the F I L E S blade sign.
function filesTower(ctx, g, R) {
  const { kit } = ctx, { box, cyl, ball, put, gCone, rnd } = kit;
  box(g, 'stone_dark', 'tower_plinth', 5.8, 0.2, 5.8);
  box(g, 'stone', 'tower_base', 5.4, 2.2, 5.4, 0, 0.2, 0);
  for (const y of [0.75, 1.3, 1.85]) box(g, 'stone_dark', 'tower_rustication', 5.44, 0.05, 5.44, 0, y, 0);
  box(g, 'stone_dark', 'tower_base_cornice', 5.7, 0.2, 5.7, 0, 2.4, 0);
  for (const x of [-1.75, 1.75]) R.archWindow(g, 0.7, 1.1, x, 0.65, 2.7, 0, 'window_lit');
  for (const s of [1, -1]) for (const z of [-1.6, 0, 1.6]) R.archWindow(g, 0.7, 1.1, s * 2.7, 0.65, z, (s * PI) / 2);
  for (const x of [-1.6, 0, 1.6]) R.archWindow(g, 0.7, 1.1, x, 0.65, -2.7, PI);
  // the entrance: double door, two columns, portico slab, one broad step, the door lamp on the slab
  box(g, 'stone', 'tower_step', 2.8, 0.2, 0.9, 0, 0, 3.15);
  R.door(g, 1.3, 1.8, 0, 0.2, 2.7, 0, 'wood_dark', 'stone');
  box(g, 'ink', 'tower_door_split', 0.05, 1.8, 0.08, 0, 0.2, 2.75);
  for (const x of [-0.95, 0.95]) { cyl(g, 'stone', 'tower_column', 0.16, 0.18, 2.1, x, 0.2, 3.15, 12); box(g, 'stone', 'tower_column_cap', 0.42, 0.1, 0.42, x, 2.2, 3.15); }
  box(g, 'stone', 'tower_portico', 2.8, 0.2, 0.95, 0, 2.3, 3.12);
  const lampMat = R.doorLamp(g, 'files', 0, 2.5, 3.35);
  // the brick shaft: seven floors of 1.0, a dark band per floor, 4 windows per face per floor, ~40% lit (seeded)
  const y0 = 2.6;
  box(g, 'brick', 'tower_shaft', 4.6, 7.0, 4.6, 0, y0, 0);
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) box(g, 'brick_dark', 'tower_pier', 0.32, 7.0, 0.32, sx * 2.3, y0, sz * 2.3);
  for (let k = 0; k < 7; k++) {
    if (k) box(g, 'brick_dark', 'tower_floor_band', 4.66, 0.08, 4.66, 0, y0 + k - 0.04, 0);
    windowRow(kit, g, 2.3, [-1.6, -0.55, 0.55, 1.6], y0 + k + 0.25, 0.6, rnd);
  }
  // setback: two stone floors 3.6 wide on a terrace, roof slab, parapet
  box(g, 'stone_dark', 'tower_terrace', 4.8, 0.15, 4.8, 0, 9.6, 0);
  box(g, 'stone', 'tower_setback', 3.6, 2.0, 3.6, 0, 9.75, 0);
  box(g, 'stone_dark', 'tower_setback_band', 3.66, 0.08, 3.66, 0, 10.71, 0);
  for (let k = 0; k < 2; k++) windowRow(kit, g, 1.8, [-1.05, 0, 1.05], 9.95 + k, 0.55, rnd);
  box(g, 'stone_dark', 'tower_roof', 3.8, 0.12, 3.8, 0, 11.75, 0);
  for (const s of [-1, 1]) { box(g, 'stone', 'tower_parapet', 3.8, 0.35, 0.16, 0, 11.87, s * 1.82); box(g, 'stone', 'tower_parapet', 0.16, 0.35, 3.5, s * 1.82, 11.87, 0); }
  // water tank on legs
  const tx = 0.7, tz = -0.6, ty = 11.87;
  for (const [lx, lz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) box(g, 'wood_dark', 'tank_leg', 0.08, 0.9, 0.08, tx + lx * 0.35, ty, tz + lz * 0.35);
  box(g, 'wood_dark', 'tank_platform', 0.95, 0.08, 0.95, tx, ty + 0.9, tz);
  cyl(g, 'wood', 'water_tank', 0.5, 0.5, 0.9, tx, ty + 0.98, tz, 10);
  for (const y of [1.1, 1.6]) cyl(g, 'ink', 'tank_hoop', 0.52, 0.52, 0.05, tx, ty + y, tz, 10);
  put(g, gCone(0.58, 0.4, 10), 'wood_dark', 'tank_cap', tx, ty + 2.08, tz);
  // antenna with a red tip
  cyl(g, 'ink', 'antenna_mast', 0.04, 0.05, 2.6, -1.0, ty, 0.9, 6);
  for (const y of [1.0, 1.6]) box(g, 'ink', 'antenna_bar', 0.6, 0.04, 0.04, -1.0, ty + y, 0.9);
  ball(g, 'fl_red', 'antenna_tip', 0.12, -1.0, ty + 2.7, 0.9, 0);
  // the blade sign: F I L E S stacked on a board standing out from the front face's south corner.
  // Font pixel = 0.148 units, about 1.6 screen pixels at the default zoom, so the letters read.
  const letters = ['F', 'I', 'L', 'E', 'S'].map((t) => ({ text: t, color: '#f3ead7' }));
  const sign = pixelSign(ctx, letters, { bg: '#3a312b', border: '#f2892b', pad: 1, gap: 2 });
  const bw = sign.w * 0.148;
  signBoard(ctx, g, 'files_blade_sign', sign, bw, 0.14, -2.3, y0 + 0.02, 2.3 + bw / 2 + 0.04, PI / 2, true, 'ink');
  for (const y of [y0 + 0.6, y0 + 6.3]) box(g, 'ink', 'sign_bracket', 0.1, 0.1, 0.14, -2.3, y, 2.3);
  return { lampMat, roofY: ty + 2.5 };
}
// one floor of window boxes on all four faces of a square block (half = half its width)
function windowRow(kit, g, half, offsets, y, w, rnd) {
  const lit = () => (rnd() < 0.4 ? 'window_lit' : 'window');
  for (const o of offsets) {
    kit.box(g, lit(), 'tower_window', w, 0.55, 0.06, o, y, half + 0.02);
    kit.box(g, lit(), 'tower_window', w, 0.55, 0.06, o, y, -half - 0.02);
    kit.box(g, lit(), 'tower_window', 0.06, 0.55, w, half + 0.02, y, o);
    kit.box(g, lit(), 'tower_window', 0.06, 0.55, w, -half - 0.02, y, o);
  }
}

// ---------- GitHub = the glass studio (Mytopia's Swing Studio, plus a door and a door lamp) ----------
function githubStudio(ctx, g, R) {
  const { box, ball } = ctx.kit;
  const W = 5.4, D = 4, H = 2.8, B = 0.25;
  box(g, 'stone_dark', 'studio_slab', W + 0.4, B, D + 0.4);
  box(g, 'wood_dark', 'studio_body', W, H, D, 0, B, 0);
  for (const s of [1, -1]) for (let z = -D / 2 + 0.3; z < D / 2; z += 0.38) box(g, 'wood', 'studio_cladding', 0.03, H - 0.1, 0.05, s * (W / 2 + 0.015), B + 0.05, z);
  const pw = (W - 0.6) / 4;
  for (let i = 0; i < 4; i++) box(g, i === 1 || i === 2 ? 'window_lit' : 'window', 'studio_glass_pane', pw - 0.02, H - 0.45, 0.04, -W / 2 + 0.3 + pw * (i + 0.5), B + 0.15, D / 2 + 0.01);
  for (let i = 0; i <= 4; i++) box(g, 'ink', 'studio_mullion', 0.07, H - 0.4, 0.1, -W / 2 + 0.3 + pw * i, B + 0.13, D / 2 + 0.03);
  box(g, 'ink', 'studio_transom', W - 0.5, 0.07, 0.1, 0, B + H - 0.32, D / 2 + 0.03);
  R.door(g, 0.9, 1.9, 0, B, D / 2 + 0.06, 0, 'window_dark', 'ink');
  box(g, 'stone', 'studio_roof', W + 0.6, 0.22, D + 0.6, 0, B + H, 0);
  const ry = B + H + 0.22;
  box(g, 'grass_top', 'roof_lawn', W - 0.4, 0.06, D - 0.4, 0, ry, 0);
  for (const [x, z] of [[-1.6, -1.1], [1.6, -1.1]]) { box(g, 'wood', 'roof_planter', 1.3, 0.3, 0.5, x, ry, z); ball(g, 'leaf_c', 'roof_plant', 0.3, x, ry + 0.45, z); }
  box(g, 'wood', 'studio_deck', W, 0.16, 1.1, 0, 0, D / 2 + 0.75);
  const lampMat = R.doorLamp(g, 'github', 0, ry, D / 2 + 0.12);
  return { lampMat, roofY: ry + 0.8 };
}

// ---------- Mail = the cottage with flower boxes (Mytopia's Welcome Center) + a mailbox ----------
function mailCottage(ctx, g, R) {
  const { box, pick } = ctx.kit;
  const W = 4, D = 3.4, H = 2.3, B = 0.25;
  box(g, 'stone', 'cottage_base', W + 0.4, B, D + 0.4);
  box(g, 'plaster', 'cottage_walls', W, H, D, 0, B, 0);
  for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) box(g, 'wood_dark', 'timber_post', 0.2, H, 0.2, (x * W) / 2, B, (z * D) / 2);
  box(g, 'wood_dark', 'timber_beam', W + 0.04, 0.14, D + 0.04, 0, B + H - 0.14, 0);
  for (const s of [1, -1]) {
    R.windowOn(g, 0.6, 0.65, s * 1.35, B + 1.2, D / 2, 0, true, 'wood_dark');
    box(g, 'wood', 'flower_box', 0.9, 0.2, 0.25, s * 1.35, B + 0.82, D / 2 + 0.14);
    for (let i = 0; i < 4; i++) box(g, pick(['fl_pink', 'fl_yellow', 'fl_red', 'fl_white']), 'flower', 0.13, 0.13, 0.13, s * 1.35 - 0.33 + i * 0.22, B + 1.02, D / 2 + 0.14);
    R.windowOn(g, 0.6, 0.65, s * (W / 2), B + 1.2, 0, (s * PI) / 2, false, 'wood_dark');
  }
  R.door(g, 0.9, 1.75, 0, B, D / 2, 0, 'mustard', 'wood_dark');
  R.gableRoof(g, W, D, 1.5, 0.35, B + H, 'roof_tile', 'plaster');
  box(g, 'stone', 'cottage_chimney', 0.5, 1.4, 0.5, -1.2, B + H + 0.6, -0.7);
  const mb = ctx.kit.grp(g, 'mailbox', 1.9, 0, D / 2 + 1.2);
  box(mb, 'wood_dark', 'mailbox_post', 0.12, 1.0, 0.12); box(mb, 'mailbox', 'mailbox_box', 0.4, 0.34, 0.6, 0, 1.0, 0); box(mb, 'fl_red', 'mailbox_flag', 0.04, 0.3, 0.14, 0.22, 1.15, 0.1);
  const lampMat = R.doorLamp(g, 'mail', 0, B + 1.95, D / 2 + 0.12);
  return { lampMat, roofY: B + H + 1.7 };
}

// ---------- Admin = the columned courthouse (Mytopia's Quality Court) ----------
function adminCourt(ctx, g, R) {
  const { THREE, kit } = ctx, { box, cyl, grp, put } = kit;
  const W = 4.4, D = 3.2, H = 2.6;
  box(g, 'stone', 'court_stylobate', W + 1.0, 0.24, D + 1.6, 0, 0, 0.3);
  box(g, 'stone', 'court_step', W + 1.0, 0.12, 0.4, 0, 0, D / 2 + 1.2);
  box(g, 'stone', 'court_body', W, H, D, 0, 0.24, -0.2);
  for (const x of [-1.4, 1.4]) R.windowOn(g, 0.6, 1.2, x, 0.85, D / 2 - 0.19, 0, true, 'stone', false);
  for (const s of [1, -1]) R.windowOn(g, 0.6, 1.2, s * (W / 2), 0.85, -0.2, (s * PI) / 2, false, 'stone', false);
  R.door(g, 0.9, 1.7, 0, 0.24, D / 2 - 0.19, 0, 'wood_dark', 'stone');
  for (let i = 0; i < 4; i++) { const x = -1.65 + i * 1.1; cyl(g, 'stone', 'court_column', 0.16, 0.19, H - 0.1, x, 0.24, D / 2 + 0.55, 12); box(g, 'stone', 'column_cap', 0.42, 0.12, 0.42, x, H + 0.1, D / 2 + 0.55); }
  box(g, 'stone', 'court_entablature', W + 0.5, 0.3, D + 1.0, 0, H + 0.22, 0.25);
  const sh = new THREE.Shape(); sh.moveTo(-(W + 0.5) / 2, 0); sh.lineTo((W + 0.5) / 2, 0); sh.lineTo(0, 0.9); sh.closePath();
  put(g, new THREE.ExtrudeGeometry(sh, { depth: D + 1.0, bevelEnabled: false }), 'stone', 'court_pediment', 0, H + 0.52, 0.25 - (D + 1.0) / 2);
  const cup = grp(g, 'court_cupola', 0, H + 1.3, -0.2); cyl(cup, 'plaster', 'cupola_drum', 0.45, 0.45, 0.6, 0, 0, 0, 10);
  put(cup, new THREE.SphereGeometry(0.5, 8, 4, 0, PI * 2, 0, PI / 2), 'copper', 'cupola_dome', 0, 0.6, 0);
  const lampMat = R.doorLamp(g, 'admin', 0, H - 0.4, D / 2 + 0.55);
  return { lampMat, roofY: H + 2.3 };
}

// ---------- the gatehouse: the gateway's HQ (new today) ----------
// Two storeys of stone 7.2 x 4.5, slate roof with a front cross-gable holding the clock (9:15), the authentication
// window in the middle of the front (agents show their badge here), the GATEWAY sign above it, the door on the right,
// a brass tube on the ridge where the log slips drop in (it leads to the ledger room), a pennant, two chimneys.
function gatehouse(ctx, g, R) {
  const { THREE, kit, L } = ctx, { box, cyl, put, grp, gCyl, gBox } = kit;
  const W = L.GATEHOUSE.w, D = L.GATEHOUSE.d, H = L.GATEHOUSE.h, P = 0.3, F = D / 2;
  box(g, 'stone_dark', 'gh_plinth', W + 0.4, P, D + 0.4);
  box(g, 'stone', 'gh_body', W, H, D, 0, P, 0);
  for (const y of [P + 0.7, P + 1.4]) box(g, 'stone_dark', 'gh_rustication', W + 0.04, 0.04, D + 0.04, 0, y, 0);
  box(g, 'stone_dark', 'gh_string_course', W + 0.12, 0.16, D + 0.12, 0, P + 2.1, 0);
  box(g, 'stone', 'gh_cornice', W + 0.3, 0.22, D + 0.3, 0, P + H, 0);
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) for (let i = 0, y = P; y < P + H - 0.3; i++, y += 0.42) box(g, 'stone_dark', 'gh_quoin', i % 2 ? 0.34 : 0.5, 0.36, i % 2 ? 0.5 : 0.34, (sx * W) / 2, y, (sz * D) / 2);
  // the authentication window: dark opening, brass bars, stone counter, striped awning
  const AW = 2.4;
  box(g, 'window_dark', 'auth_opening', AW, 1.05, 0.06, 0, P + 0.95, F);
  box(g, 'stone_dark', 'auth_frame', AW + 0.3, 0.14, 0.14, 0, P + 2.0, F);
  for (const s of [-1, 1]) box(g, 'stone_dark', 'auth_frame', 0.14, 1.05, 0.14, s * (AW / 2 + 0.07), P + 0.95, F);
  for (let i = 1; i < 6; i++) box(g, 'brass', 'auth_bar', 0.04, 1.05, 0.04, -AW / 2 + (i * AW) / 6, P + 0.95, F + 0.07);
  box(g, 'stone', 'auth_counter', AW + 0.3, 0.1, 0.34, 0, P + 0.85, F + 0.12);
  const awning = grp(g, 'auth_awning', 0, P + 2.15, F + 0.34); awning.rotation.x = 0.35;
  for (let i = 0; i < 6; i++) put(awning, gBox(0.46, 0.05, 0.72), i % 2 ? 'stripe_white' : 'stripe_red', 'awning_strip', -1.15 + i * 0.46, 0, 0);
  const sign = pixelSign(ctx, [{ text: 'GATEWAY', color: '#f3ead7' }], { bg: '#3a312b', border: '#f2892b', pad: 2 });
  signBoard(ctx, g, 'gateway_sign', sign, 3.4, 0.08, 0, P + 2.35, F + 0.05, 0, false, 'ink');
  // ground floor: window on the left, the door on the right with its lamp; upper floor windows; side windows
  R.windowOn(g, 0.8, 0.95, -2.7, P + 0.75, F, 0, true, 'stone');
  box(g, 'stone', 'gh_step', 1.4, P, 0.5, 2.7, 0, F + 0.25);
  R.door(g, 1.0, 1.85, 2.7, P, F, 0, 'wood_dark', 'stone');
  const lampMat = R.doorLamp(g, 'gatehouse', 2.7, P + 1.98, F + 0.12);
  for (const x of [-2.65, 2.65]) R.windowOn(g, 0.8, 1.1, x, P + 2.75, F, 0, x > 0, 'stone');
  for (const s of [1, -1]) for (const z of [-1.0, 1.0]) { R.windowOn(g, 0.7, 0.9, (s * W) / 2, P + 0.8, z, (s * PI) / 2, false, 'stone'); R.windowOn(g, 0.7, 1.0, (s * W) / 2, P + 2.75, z, (s * PI) / 2, z > 0, 'stone'); }
  // roofs: the main slate gable (ridge along x) and the front cross-gable that carries the clock
  const ry = P + H + 0.22;
  R.gableRoof(g, W, D, 2.1, 0.35, ry, 'roof_slate', 'stone');
  const gw = 3.0, gr = 1.9;
  const tri = new THREE.Shape(); tri.moveTo(-gw / 2, 0); tri.lineTo(gw / 2, 0); tri.lineTo(0, gr); tri.closePath();
  put(g, new THREE.ExtrudeGeometry(tri, { depth: 0.52, bevelEnabled: false }), 'stone', 'gh_front_gable', 0, ry, F - 0.4);
  R.gableRoof(grp(g, 'gh_front_gable_roof', 0, ry, F - 1.2, PI / 2), 2.6, gw, gr, 0.18, 0, 'roof_slate', null);
  const clock = kit.canvasTex(32, 32, drawClock);
  const rim = put(g, gCyl(0.64, 0.64, 0.06, 16), 'stone_dark', 'clock_rim', 0, ry + 0.72, F + 0.15); rim.rotation.x = PI / 2;
  put(g, new THREE.CircleGeometry(0.55, 16), kit.signMat(clock), 'clock_face', 0, ry + 0.72, F + 0.19);
  // chimneys, the ledger tube intake on the ridge, the pennant
  for (const x of [-2.7, 2.7]) { box(g, 'stone', 'gh_chimney', 0.55, 1.6, 0.55, x, ry + 0.7, -0.9); box(g, 'stone_dark', 'gh_chimney_cap', 0.65, 0.12, 0.65, x, ry + 2.3, -0.9); }
  const ridge = ry + 2.1 + 0.24;
  cyl(g, 'brass', 'ledger_tube', 0.1, 0.1, 0.55, 1.9, ridge - 0.1, 0, 8);
  cyl(g, 'brass', 'ledger_funnel', 0.38, 0.14, 0.35, 1.9, ridge + 0.4, 0, 10);
  cyl(g, 'metal', 'pennant_pole', 0.04, 0.05, 1.7, -3.0, ridge - 0.1, 0, 6);
  box(g, 'robot_orange', 'pennant', 0.7, 0.4, 0.04, -2.6, ridge + 1.1, 0);
  box(g, 'robot_orange', 'pennant', 0.36, 0.24, 0.04, -2.07, ridge + 1.18, 0);
  box(g, 'robot_orange', 'pennant', 0.2, 0.1, 0.04, -1.8, ridge + 1.25, 0);
  return { lampMat, roofY: ridge, ledgerDrop: new THREE.Vector3(1.9, ridge + 0.75, 0), windowY: P + 1.4, signY: P + 2.85 };
}

// a 32 x 32 pixel clock face, hands fixed at 9:15
function drawClock(g) {
  g.fillStyle = '#3a312b'; g.fillRect(0, 0, 32, 32);
  g.fillStyle = '#fbf7ee'; g.beginPath(); g.arc(16, 16, 14, 0, PI * 2); g.fill();
  g.fillStyle = '#3a312b';
  for (let h = 0; h < 12; h++) { const a = (h / 12) * PI * 2, big = h % 3 === 0 ? 2 : 1; g.fillRect(Math.round(16 + Math.sin(a) * 11.5) - 1, Math.round(16 - Math.cos(a) * 11.5) - 1, 1 + big, 1 + big); }
  const hand = (a, len, w, col) => { g.fillStyle = col; for (let t = 0; t <= 1; t += 0.05) g.fillRect(Math.round(16 + Math.sin(a) * len * t - w / 2), Math.round(16 - Math.cos(a) * len * t - w / 2), w, w); };
  hand((9.25 / 12) * PI * 2, 7, 3, '#3a312b');  // hour hand just past nine
  hand(PI / 2, 11, 2, '#b4553e');               // minute hand at three
  g.fillStyle = '#3a312b'; g.fillRect(15, 15, 3, 3);
}

// ---------- build all five, return PLACES ----------
export function buildBuildings(ctx, world) {
  const { THREE, kit, L } = ctx;
  const parent = world && world.world ? world.world : world; // accepts buildWorld's result or a bare Group
  const R = makeRecipes(ctx);
  const PLACES = {};
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const register = (key, g, built, extra = {}) => {
    g.updateMatrixWorld(true);
    const roof = g.localToWorld(V(0, built.roofY, 0));
    const d = L.DOORS[key];
    PLACES[key] = { key, g, door: d ? V(d.x, 0, d.z) : null, roof, lampMat: built.lampMat, labelAnchor: roof.clone().add(V(0, 1.3, 0)), ...extra };
  };
  // islet buildings: `reach` = world distance from the door spot back to the building's centre, so the robot
  // standing at layout.DOORS[key] is just in front of the steps (columns and glass stay clear of its body)
  { const g = placeOnIslet(ctx, parent, 'files', 3.95, 'files_tower'); register('files', g, filesTower(ctx, g, R)); }
  { const g = placeOnIslet(ctx, parent, 'github', 3.1, 'github_studio', 1.15); register('github', g, githubStudio(ctx, g, R)); }
  { const g = placeOnIslet(ctx, parent, 'mail', 2.8, 'mail_cottage', 1.15); register('mail', g, mailCottage(ctx, g, R)); }
  { const g = placeOnIslet(ctx, parent, 'admin', 3.45, 'admin_court', 1.15); register('admin', g, adminCourt(ctx, g, R)); }
  // the gatehouse, facing south; the chief's booth beside it (see CHIEF_BOOTH in world.js for why it moved)
  {
    const GH = L.GATEHOUSE, g = kit.grp(parent, 'gatehouse', GH.x, 0, GH.z, 0);
    const built = gatehouse(ctx, g, R);
    const toDoor = [L.NODES.chief_door[0] - CHIEF_BOOTH[0], L.NODES.chief_door[1] - CHIEF_BOOTH[1]], n = Math.hypot(...toDoor);
    const chief = buildBooth(ctx, parent, 'booth_chief', CHIEF_BOOTH, [toDoor[0] / n, toDoor[1] / n]);
    g.updateMatrixWorld(true);
    const front = GH.z + GH.d / 2;
    register('gatehouse', g, built, {
      door: V(GH.x + 2.7, 0, front + 0.75),
      windowAnchor: V(GH.x, built.windowY, front + 0.2),
      chiefBooth: { lampMat: chief.lampMat, guardHome: chief.guardHome },
      stampAnchor: V(GH.x, built.signY + 0.6, front + 0.3),
      ledgerDrop: g.localToWorld(built.ledgerDrop),
    });
  }
  const shadows = (o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } };
  for (const p of Object.values(PLACES)) p.g.traverse(shadows);
  parent.getObjectByName('booth_chief').traverse(shadows);
  return PLACES;
}
