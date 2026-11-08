// The Factory island's buildings (docs/BUILD3.md section 4): the iron FACTORY arch over the bridge's south end, the brick
// hall (sawtooth roof of three north-lit teeth, two rust-iron chimneys at its south-east corner, the big double door on
// its east face, the FACTORY signboard, a clock, the loading ramp with crates), the yard's four painted parking squares
// and its lamp, the inspection bay (an open shed: four posts, a slate roof, the round lift, a gantry whose scanner arm
// sweeps while an inquest runs, the tall screen above it facing the camera) and the cart's parking spot.
// New tonight (build 3). Recipes follow the rest of the island: flat-shaded boxes, Mytopia's palette, pixel-font signs
// (world.js pixelSign), no neon, no glow. Every coordinate comes from layout.FACTORY.
// buildFactory(ctx, W) adds everything to W.world and returns the handles scene.js, actors.js and effects.js use.
import { pixelSign, signBoard } from './world.js';

const PI = Math.PI;
const TOP = 0.07; // the paving top (world.js DECK_TOP)

export function buildFactory(ctx, W) {
  const { THREE, kit, L } = ctx, { box, cyl, put, grp, gBox, gCyl, M } = kit;
  const F = L.FACTORY, root = W.world;
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const g = grp(root, 'factory');

  // ---------- the arch: two iron pillars, a lintel, FACTORY on a board both ways ----------
  {
    const [ax, az] = F.arch, a = grp(g, 'factory_arch', ax, 0, az);
    for (const s of [-1, 1]) {
      box(a, 'stone_dark', 'arch_foot', 0.5, 0.25, 0.5, s * 1.25, 0, 0);
      box(a, 'iron', 'arch_pillar', 0.26, 3.9, 0.26, s * 1.25, 0.25, 0);
      for (const y of [1.0, 2.2, 3.4]) box(a, 'rust', 'arch_band', 0.32, 0.08, 0.32, s * 1.25, y, 0);
      box(a, 'iron', 'arch_finial', 0.16, 0.3, 0.16, s * 1.25, 4.15, 0);
    }
    box(a, 'iron', 'arch_lintel', 2.9, 0.18, 0.22, 0, 4.0, 0);
    box(a, 'iron', 'arch_tie', 2.6, 0.08, 0.12, 0, 2.95, 0);
    const sign = pixelSign(ctx, [{ text: 'FACTORY', color: '#3a312b' }], { bg: '#f3ead7', border: '#f2892b', pad: 2 });
    signBoard(ctx, a, 'arch_sign', sign, 2.4, 0.08, 0, 3.05, 0, 0, true, 'iron');
  }

  // ---------- the hall ----------
  const H = F.hall, hx = H.x, hz = H.z, hw = H.w / 2, hd = H.d / 2, P = 0.25, WH = H.h;
  const hall = grp(g, 'factory_hall', hx, 0, hz);
  box(hall, 'stone_dark', 'hall_plinth', H.w + 0.4, P, H.d + 0.4);
  box(hall, 'brick', 'hall_walls', H.w, WH, H.d, 0, P, 0);
  for (const y of [P + 1.1, P + 2.2]) box(hall, 'brick_dark', 'hall_course', H.w + 0.04, 0.06, H.d + 0.04, 0, y, 0);
  box(hall, 'brick_dark', 'hall_cornice', H.w + 0.24, 0.2, H.d + 0.24, 0, P + WH - 0.1, 0);
  // pilasters on the two faces the camera sees (east and south)
  for (const z of [-hd, 2.3, 4.6, hd]) box(hall, 'brick_dark', 'hall_pilaster', 0.22, WH, 0.34, hw + 0.06, P, z);
  for (const x of [-hw, -1.2, 1.2]) box(hall, 'brick_dark', 'hall_pilaster', 0.34, WH, 0.22, x, P, hd + 0.06);
  const win = (x, z, ry, w = 1.1, h = 1.3) => {
    const wg = grp(hall, 'hall_window', x, P + 1.25, z, ry);
    box(wg, 'window', 'hall_glass', w, h, 0.05); box(wg, 'stone', 'hall_sill', w + 0.24, 0.08, 0.16, 0, -0.08, 0.04);
    box(wg, 'stone', 'hall_lintel', w + 0.24, 0.14, 0.12, 0, h, 0.03);
    box(wg, 'iron', 'hall_mullion', 0.05, h, 0.07, 0, 0, 0.03); box(wg, 'iron', 'hall_transom', w, 0.05, 0.07, 0, h * 0.5, 0.03);
  };
  win(hw + 0.01, 3.45, PI / 2); // (the north end of this face carries the FLOOR plaque and the clock)
  for (const x of [-2.4, 0.0]) win(x, hd + 0.01, 0);
  // the big double door on the east face: a dark inside, a stone frame, two leaves that swing inward
  const dz = F.door[1] - hz, DW = 2.6, DH = 2.8;
  box(hall, 'ink', 'hall_door_dark', 0.12, DH, DW, hw - 0.04, P, dz);
  box(hall, 'stone', 'hall_door_head', 0.24, 0.3, DW + 0.5, hw + 0.06, P + DH, dz);
  for (const s of [-1, 1]) box(hall, 'stone', 'hall_door_jamb', 0.24, DH, 0.25, hw + 0.06, P, dz + s * (DW / 2 + 0.12));
  const leaves = [-1, 1].map((s) => {
    const hinge = grp(hall, 'hall_door_hinge', hw + 0.04, P, dz + s * DW / 2);
    const leaf = grp(hinge, 'hall_door_leaf', 0, 0, -s * DW / 4);
    box(leaf, 'wood_dark', 'hall_door_leaf', 0.1, DH, DW / 2 - 0.04);
    for (const y of [0.5, 1.4, 2.3]) box(leaf, 'iron', 'hall_door_strap', 0.12, 0.08, DW / 2 - 0.1, 0, y, 0);
    box(leaf, 'brass', 'hall_door_handle', 0.14, 0.16, 0.08, 0.06, 1.3, s * (DW / 4 - 0.15));
    return { hinge, s };
  });
  // the door lamp over the door (for lamp effects, like the islet buildings)
  const lampMat = M.lamp_off.clone(); lampMat.name = 'door_lamp_factory'; lampMat.emissiveIntensity = 0.7;
  box(hall, 'ink', 'door_lamp_bracket', 0.22, 0.06, 0.1, hw + 0.15, P + DH + 0.45, dz - DW / 2 - 0.45);
  box(hall, lampMat, 'door_lamp', 0.28, 0.28, 0.28, hw + 0.28, P + DH + 0.5, dz - DW / 2 - 0.45);
  // the loading ramp with its roller shutter and crates (south end of the east face)
  const rz = H.ramp - hz;
  box(hall, 'roof_slate', 'hall_shutter', 0.08, 2.2, 1.9, hw + 0.02, P, rz);
  for (let y = 0.3; y < 2.2; y += 0.28) box(hall, 'stone_dark', 'hall_shutter_slat', 0.1, 0.04, 1.9, hw + 0.03, P + y, rz);
  box(hall, 'stone', 'ramp_dock', 1.0, 0.9, 2.1, hw + 0.5, 0, rz);
  const ramp = put(hall, gBox(1.35, 0.12, 1.8), 'wood', 'ramp_deck', hw + 1.6, 0.45, rz); ramp.rotation.z = -0.72;
  for (const [x, z, s, r] of [[hw + 0.4, rz - 0.55, 0.55, 0.2], [hw + 0.42, rz + 0.5, 0.5, -0.3], [hw + 0.4, rz - 0.5, 0.4, 0.5]]) {
    const c = grp(hall, 'crate', x, 0.9 + (s < 0.5 ? 0.6 : 0), z, r);
    box(c, 'wood', 'crate_box', s, s, s); box(c, 'wood_dark', 'crate_band', s + 0.02, 0.07, s + 0.02, 0, s * 0.45, 0);
  }
  // the sawtooth roof: three teeth, each a slope falling south from a north-facing strip of glass
  const n = 3, tooth = H.d / n, rise = 1.5, roofY = P + WH;
  const slopeLen = Math.hypot(tooth, rise), th = Math.atan2(rise, tooth);
  for (let k = 0; k < n; k++) {
    const zN = -hd + k * tooth, zS = zN + tooth;
    const pl = put(hall, gBox(H.w + 0.3, 0.16, slopeLen + 0.05), 'roof_slate', 'saw_slope', 0, roofY + rise / 2 + 0.08, (zN + zS) / 2);
    pl.rotation.x = th;
    for (let u = -slopeLen / 2 + 0.3; u < slopeLen / 2 - 0.1; u += 0.45) put(pl, gBox(H.w + 0.3, 0.05, 0.08), 'roof_slate', 'saw_row', 0, 0.1, u);
    box(hall, 'window', 'saw_glass', H.w - 0.2, rise - 0.1, 0.06, 0, roofY, zN + 0.02);
    for (let x = -hw + 0.7; x < hw; x += 0.9) box(hall, 'iron', 'saw_mullion', 0.06, rise, 0.1, x, roofY, zN + 0.04);
    const tri = new THREE.Shape(); tri.moveTo(-zN, 0); tri.lineTo(-zS, 0); tri.lineTo(-zN, rise); tri.closePath();
    const tg = new THREE.ExtrudeGeometry(tri, { depth: 0.14, bevelEnabled: false });
    for (const sx of [-1, 1]) { const e = put(hall, tg, 'brick', 'saw_gable', sx > 0 ? hw - 0.14 : -hw, roofY, 0); e.rotation.y = PI / 2; }
  }
  // two tall rust-iron chimneys at the south-east corner, rising through the last tooth
  const chimneyTops = F.chimneys.map(([cx, cz], i) => {
    const lx = cx - hx, lz = cz - hz, top = 7.6 + i * 0.5;
    box(hall, 'rust', 'chimney', 0.7, top, 0.7, lx, 0, lz);
    for (let y = 2.0; y < top - 0.4; y += 1.3) box(hall, 'iron', 'chimney_band', 0.78, 0.1, 0.78, lx, y, lz);
    box(hall, 'iron', 'chimney_cap', 0.86, 0.16, 0.86, lx, top, lz);
    box(hall, 'ink', 'chimney_mouth', 0.5, 0.02, 0.5, lx, top + 0.16, lz);
    return V(cx, top + 0.3, cz);
  });
  // the FACTORY signboard, standing on the east wall above the door, turned to the camera; the clock beside it
  {
    const sign = pixelSign(ctx, [{ text: 'FACTORY', size: 2, color: '#f3ead7' }], { bg: '#3a312b', border: '#f2892b', pad: 2 });
    const sb = signBoard(ctx, hall, 'factory_sign', sign, 3.2, 0.1, hw - 0.3, roofY + 1.35, dz + 0.2, PI / 4, false, 'ink');
    for (const s of [-1, 1]) box(sb.g, 'iron', 'factory_sign_leg', 0.1, 1.4, 0.1, s * 1.2, -1.4, -0.08);
    const clock = kit.canvasTex(32, 32, drawClock);
    const cg = grp(hall, 'factory_clock', hw + 0.07, P + 2.85, -4.4, PI / 2);
    const rim = put(cg, gCyl(0.42, 0.42, 0.06, 16), 'stone_dark', 'clock_rim', 0, 0, 0); rim.rotation.x = PI / 2;
    put(cg, new THREE.CircleGeometry(0.36, 16), kit.signMat(clock), 'clock_face', 0, 0, 0.04);
  }

  // ---------- the FLOOR plaque beside the door. A click on it, or on the big door, enters the Factory floor room
  // (scene.pickBuilding reads userData.pick); a click anywhere else on the hall enters the office ----------
  let floorSign;
  {
    const [fx, fz] = F.floorSign, fsg = grp(g, 'floor_sign', fx, 0, fz, PI / 2);
    const sign = pixelSign(ctx, [{ text: 'FLOOR', size: 2, color: '#3a312b' }, { text: 'SEE THE LINE', color: '#b4553e' }], { bg: '#fbf7ee', border: '#3a312b', pad: 2 });
    floorSign = signBoard(ctx, fsg, 'floor_sign_board', sign, 1.4, 0.06, 0, 1.25, 0, 0, false, 'ink').g;
    fsg.traverse((o) => { o.userData.pick = 'factory_floor'; });
    hall.traverse((o) => { if (/^hall_door/.test(o.name)) o.userData.pick = 'factory_floor'; });
  }

  // ---------- the yard: four painted squares and a lamp ----------
  for (const [sx, sz] of F.yard.spots) {
    const sq = grp(g, 'yard_spot', sx, TOP + 0.005, sz);
    for (const s of [-1, 1]) { box(sq, 'mustard', 'yard_line', 1.4, 0.015, 0.1, 0, 0, s * 0.66); box(sq, 'mustard', 'yard_line', 0.1, 0.015, 1.4, s * 0.66, 0, 0); }
    box(sq, 'ink', 'yard_mark', 0.36, 0.016, 0.1, 0, 0, 0.45);
  }
  {
    const [lx, lz] = F.yard.lamp, lp = grp(g, 'yard_lamp', lx, 0, lz);
    box(lp, 'stone_dark', 'lamp_base', 0.3, 0.2, 0.3); cyl(lp, 'iron', 'lamp_post', 0.05, 0.065, 2.4, 0, 0.2, 0, 8);
    box(lp, 'iron', 'lamp_arm', 0.6, 0.06, 0.06, -0.25, 2.55, 0);
    box(lp, 'lamp_glow', 'lamp_lantern', 0.26, 0.3, 0.26, -0.5, 2.25, 0); kit.pyramid(lp, 'iron', 'lamp_roof', 0.26, 0.2, -0.5, 2.55, 0);
  }

  // ---------- the inspection bay ----------
  const B = F.bay, bw = B.w / 2, bay = grp(g, 'inspection_bay', B.x, 0, B.z);
  box(bay, 'stone', 'bay_floor', B.w + 0.4, 0.04, B.d + 0.4, 0, TOP - 0.02, 0);
  for (let i = 0; i < 6; i++) box(bay, i % 2 ? 'ink' : 'mustard', 'bay_hazard', 0.5, 0.012, 0.16, -1.25 + i * 0.5, TOP + 0.02, bw + 0.08);
  for (const [px, pz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    box(bay, 'stone_dark', 'bay_post_foot', 0.34, 0.16, 0.34, px * bw, TOP, pz * bw);
    box(bay, 'iron', 'bay_post', 0.18, B.roofY + (pz < 0 ? 0.4 : 0), 0.18, px * bw, 0, pz * bw);
  }
  // the roof: one slate slab falling toward the camera (south), fascia boards, tile rows
  const rf = grp(bay, 'bay_roof', 0, B.roofY + 0.2, 0); rf.rotation.x = Math.atan2(0.4, B.d);
  box(rf, 'roof_slate', 'bay_roof_slab', B.w + 0.6, 0.14, B.d + 0.6, 0, 0, 0);
  for (let u = -B.d / 2; u < B.d / 2 + 0.2; u += 0.42) box(rf, 'roof_slate', 'bay_roof_row', B.w + 0.6, 0.05, 0.08, 0, 0.14, u);
  box(rf, 'wood_dark', 'bay_fascia', B.w + 0.7, 0.24, 0.08, 0, -0.12, B.d / 2 + 0.3);

  // the round lift: a steel disc with mustard bolts, raised a little
  const LIFT_Y = 0.24;
  const lift = grp(bay, 'bay_lift', B.lift[0] - B.x, 0, B.lift[1] - B.z);
  cyl(lift, 'stone_dark', 'lift_well', 1.05, 1.05, 0.1, 0, TOP, 0, 16);
  const disc = cyl(lift, 'metal', 'lift_disc', 0.92, 0.92, LIFT_Y - TOP, 0, TOP, 0, 16);
  for (let i = 0; i < 6; i++) { const a = (i * PI) / 3; box(lift, 'mustard', 'lift_bolt', 0.12, 0.03, 0.12, Math.cos(a) * 0.75, LIFT_Y, Math.sin(a) * 0.75); }
  // the gantry across the lift (its beam runs across the camera's view, so the robot stays in sight), the scanner arm
  const gan = grp(bay, 'bay_gantry', B.lift[0] - B.x, 0, B.lift[1] - B.z, PI / 4);
  const GH = 4.3, GS = 1.35;
  for (const s of [-1, 1]) { box(gan, 'iron', 'gantry_leg', 0.16, GH, 0.16, s * GS, TOP, 0); box(gan, 'stone_dark', 'gantry_foot', 0.3, 0.12, 0.3, s * GS, TOP, 0); }
  box(gan, 'iron', 'gantry_beam', 2 * GS + 0.3, 0.18, 0.2, 0, GH, 0);
  const carriage = grp(gan, 'gantry_carriage', 0, GH - 0.06, 0);
  box(carriage, 'rust', 'carriage', 0.36, 0.2, 0.3, 0, 0, 0);
  const arm = grp(carriage, 'scanner_arm', 0, 0, 0);
  box(arm, 'iron', 'scanner_rod', 0.06, 0.5, 0.06, 0, -0.5, 0);
  const head = grp(arm, 'scanner_head', 0, -0.62, 0);
  box(head, 'mustard', 'scanner_box', 0.34, 0.16, 0.26, 0, -0.08, 0);
  box(head, 'ink', 'scanner_slit', 0.26, 0.02, 0.2, 0, -0.09, 0);
  // the lamp on the front-right post (for lamp effects at the bay)
  const bayLamp = M.lamp_off.clone(); bayLamp.name = 'bay_lamp'; bayLamp.emissiveIntensity = 0.7;
  box(bay, bayLamp, 'bay_lamp', 0.3, 0.3, 0.3, bw, B.roofY - 0.9, bw + 0.2);
  box(bay, 'ink', 'bay_lamp_cap', 0.36, 0.05, 0.36, bw, B.roofY - 0.6, bw + 0.2);
  // the tall screen on two masts behind the shed, facing the camera; its top edge is the inquest panel's anchor
  const [scx, scz] = B.screen, SA = B.screenAnchor, SW = 3.0, SHt = 1.8;
  const scr = grp(g, 'bay_screen', scx, 0, scz, PI / 4);
  for (const s of [-1, 1]) { box(scr, 'iron', 'screen_mast', 0.14, SA[1], 0.14, s * (SW / 2 + 0.05), 0, -0.04); box(scr, 'stone_dark', 'screen_mast_foot', 0.3, 0.14, 0.3, s * (SW / 2 + 0.05), 0, -0.04); }
  box(scr, 'iron', 'screen_frame', SW + 0.3, SHt + 0.2, 0.12, 0, SA[1] - SHt - 0.1, -0.02);
  const screenMat = M.screen_dark;
  const screen = put(scr, new THREE.PlaneGeometry(SW, SHt), screenMat, 'bay_screen_face', 0, SA[1] - SHt / 2, 0.05);
  // three faint ruled lines so the screen reads as a display even before the panel opens, and its name under it
  for (let i = 0; i < 3; i++) box(scr, 'stone_dark', 'screen_rule', SW - 0.6, 0.04, 0.02, -0.2, SA[1] - 0.5 - i * 0.45, 0.06);
  {
    const sign = pixelSign(ctx, [{ text: 'INSPECTION', color: '#f3ead7' }], { bg: '#3a312b', border: '#f2892b', pad: 1 });
    signBoard(ctx, scr, 'bay_sign', sign, 2.2, 0.06, 0, SA[1] - SHt - 0.62, 0.02, 0, false, 'ink');
  }
  const screenAnchor = V(SA[0], SA[1], SA[2]);

  // ---------- the cart's parking spot: a painted bay with a stop block ----------
  {
    const [cx, cz] = F.cartHome, cp = grp(g, 'cart_home', cx, TOP + 0.005, cz);
    for (const s of [-1, 1]) box(cp, 'mustard', 'cart_home_line', 0.08, 0.015, 1.7, s * 0.65, 0, 0);
    box(cp, 'mustard', 'cart_home_line', 1.38, 0.015, 0.08, 0, 0, 0.85);
    box(cp, 'stone_dark', 'cart_stop', 1.0, 0.14, 0.18, 0, 0, 1.0);
  }

  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });

  // robots on the lift stand on its disc: wrap the world's ground height
  const baseGround = W.groundY;
  W.groundY = (x, z) => (Math.hypot(x - B.lift[0], z - B.lift[1]) < 0.95 ? LIFT_Y : baseGround(x, z));

  // ---------- animation ----------
  let doorUntil = 0, scanning = false, clock = 0, scanT = 0;
  function tick(t, dt) {
    clock = t;
    const open = doorUntil > t;
    for (const { hinge, s } of leaves) hinge.rotation.y += ((open ? s * 1.45 : 0) - hinge.rotation.y) * Math.min(1, dt * 5);
    if (scanning) scanT += dt;
    const k = Math.min(1, dt * 4);
    carriage.position.x += ((scanning ? Math.sin(scanT * 1.6) * (GS - 0.35) : 0) - carriage.position.x) * k;
    head.position.y += ((scanning ? -0.62 - 0.35 - Math.sin(scanT * 3.1) * 0.35 : -0.62) - head.position.y) * k;
    arm.rotation.z += ((scanning ? Math.sin(scanT * 1.6 + 0.6) * 0.2 : 0) - arm.rotation.z) * k;
  }

  hall.updateMatrixWorld(true);
  const roof = V(hx, roofY + rise + 0.2, hz);
  return {
    g, hall, floorSign, bay, lift, screen, screenAnchor, chimneyTops,
    door: V(F.door[0], 0, F.door[1]), roof, labelAnchor: roof.clone().add(V(0, 1.6, 0)), lampMat, bayLamp,
    stampAnchor: V(B.lift[0] + 0.4, B.roofY + 0.9, B.lift[1] + 0.4),
    slipFrom: V(B.lift[0], 3.2, B.lift[1]),
    liftY: LIFT_Y,
    openDoors(seconds = 2.0) { doorUntil = Math.max(doorUntil, clock + seconds); },
    bayScanning(on) { scanning = !!on; if (!on) scanT = 0; },
    scanning: () => scanning,
    reset() { doorUntil = 0; scanning = false; scanT = 0; },
    tick,
  };
}

// a 32 x 32 pixel clock face (the gatehouse's recipe), hands at ten to two: the Factory keeps its own time
function drawClock(g) {
  g.fillStyle = '#3a312b'; g.fillRect(0, 0, 32, 32);
  g.fillStyle = '#fbf7ee'; g.beginPath(); g.arc(16, 16, 14, 0, PI * 2); g.fill();
  g.fillStyle = '#3a312b';
  for (let h = 0; h < 12; h++) { const a = (h / 12) * PI * 2, big = h % 3 === 0 ? 2 : 1; g.fillRect(Math.round(16 + Math.sin(a) * 11.5) - 1, Math.round(16 - Math.cos(a) * 11.5) - 1, 1 + big, 1 + big); }
  const hand = (a, len, w, col) => { g.fillStyle = col; for (let t = 0; t <= 1; t += 0.05) g.fillRect(Math.round(16 + Math.sin(a) * len * t - w / 2), Math.round(16 - Math.cos(a) * len * t - w / 2), w, w); };
  hand((1.83 / 12) * PI * 2, 7, 3, '#3a312b');
  hand((10 / 12) * PI * 2, 11, 2, '#b4553e');
  g.fillStyle = '#3a312b'; g.fillRect(15, 15, 3, 3);
}
