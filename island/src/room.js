// The ledger room: the gatehouse interior, opened with G or a click on the gatehouse (docs/ISLAND_V2.md section 6).
// Pre-existing: the cutaway room idea (Mytopia's dollhouse rooms) and v1's room (floor, two walls, desk, the clerk
// robot who stamps each new row, the camera swap in setRoom). New today: bigger boards left PLAIN (chalk green and
// paper) because the text is now crisp DOM laid over them (builder B's section below), their four world corners for
// that overlay, a straight-on camera so the boards are true rectangles on screen, a desk sign, rug, cabinet, plant.
// The room lives at the scene origin, hidden; setRoom(true) hides the island and shows the room instead.
import { pixelSign, signBoard } from './world.js';

const PI = Math.PI;
const RW = 13, RD = 8, RH = 6.2;                 // room width (x), depth (z), wall height
const BACK = -RD / 2 + 0.15;                      // z of the board planes, just in front of the back wall
const LEDGER = { x: 1.7, y: 3.15, w: 8.6, h: 4.4 }; // the chalkboard (THE LEDGER overlay goes here)
const CHAIN = { x: -4.6, y: 3.15, w: 2.8, h: 4.4 }; // the paper board (HASH CHAIN overlay goes here)
const PITCH = (15 * PI) / 180;                    // the camera looks 15 degrees down, straight at the back wall
const SPAN_W = 12.8, SPAN_H = 7.5;                // world units the view must hold: both boards across, board top to desk front

export function createRoom(ctx) {
  const { THREE, kit, stage } = ctx, { box, cyl, ball, grp, put, gBox, gCone } = kit;
  const room = new THREE.Group(); room.name = 'ledger_room'; room.visible = false;

  // ---------- shell: floor, back wall, left wall ----------
  box(room, 'wood', 'room_floor', RW, 0.3, RD, 0, -0.3, 0);
  for (let x = -RW / 2 + 0.55; x < RW / 2; x += 0.55) box(room, 'wood_dark', 'floor_line', 0.03, 0.01, RD, x, 0, 0);
  box(room, 'plaster', 'room_back_wall', RW, RH, 0.3, 0, -0.3, -RD / 2 - 0.15);
  box(room, 'plaster', 'room_left_wall', 0.3, RH, RD, -RW / 2 - 0.15, -0.3, 0);
  box(room, 'wood_dark', 'skirting', RW, 0.25, 0.08, 0, 0, -RD / 2 + 0.04); box(room, 'wood_dark', 'skirting', 0.08, 0.25, RD, -RW / 2 + 0.04, 0, 0);
  box(room, 'wood_dark', 'wall_beam', RW, 0.2, 0.12, 0, RH - 0.6, -RD / 2 + 0.06);
  box(room, 'window', 'left_window', 0.06, 1.4, 2.0, -RW / 2 + 0.02, 1.8, 1.4);
  box(room, 'wood_light', 'left_window_frame', 0.1, 0.1, 2.2, -RW / 2 + 0.05, 1.7, 1.4);

  // ---------- the two boards: frames, plain planes, chalk tray ----------
  const chalk = new THREE.MeshStandardMaterial({ name: 'chalkboard', color: 0x2f3a33, roughness: 0.95, flatShading: true });
  const plane = (b, mat, name) => put(room, new THREE.PlaneGeometry(b.w, b.h), mat, name, b.x, b.y, BACK);
  box(room, 'wood_dark', 'board_frame', LEDGER.w + 0.3, LEDGER.h + 0.3, 0.14, LEDGER.x, LEDGER.y - LEDGER.h / 2 - 0.15, -RD / 2 + 0.07);
  plane(LEDGER, chalk, 'ledger_board');
  box(room, 'wood_light', 'chalk_tray', LEDGER.w + 0.1, 0.08, 0.25, LEDGER.x, LEDGER.y - LEDGER.h / 2 - 0.2, -RD / 2 + 0.2);
  box(room, 'wood_dark', 'chain_frame', CHAIN.w + 0.3, CHAIN.h + 0.3, 0.12, CHAIN.x, CHAIN.y - CHAIN.h / 2 - 0.15, -RD / 2 + 0.06);
  plane(CHAIN, 'paper', 'chain_paper');

  // ---------- the clerk's desk, a stamp, papers, the BLOCKED tray, a sign on the front ----------
  const dz = 2.6;
  const d = grp(room, 'clerk_desk', 0.6, 0, dz, 0);
  box(d, 'wood', 'desk_top', 3.4, 0.12, 1.3, 0, 0.73, 0); box(d, 'wood_dark', 'desk_front', 3.4, 0.73, 0.1, 0, 0, 0.6);
  for (const s of [-1, 1]) box(d, 'wood_dark', 'desk_side', 0.1, 0.73, 1.2, s * 1.65, 0, 0);
  box(d, 'paper', 'paper_stack', 0.6, 0.18, 0.45, -1.0, 0.85, -0.1); box(d, 'paper', 'paper_sheet', 0.55, 0.02, 0.4, 0.2, 0.85, 0.1);
  box(d, 'stripe_red', 'blocked_tray', 0.7, 0.14, 0.5, 1.15, 0.85, -0.05);
  const sign = pixelSign(ctx, [{ text: 'GATEWAY LEDGER', color: '#3a312b' }], { bg: '#fbf7ee', border: '#3a312b', pad: 2 });
  signBoard(ctx, d, 'desk_sign', sign, 2.6, 0.04, 0, 0.12, 0.66, 0, false, 'paper');

  // the clerk: Mytopia's robot recipe on a stool behind the desk, facing the camera, stamping arm on its right
  const c = grp(room, 'clerk', 0.6, 0.25, dz - 1.0, 0); c.scale.setScalar(2.4);
  box(room, 'wood_dark', 'clerk_stool', 0.7, 0.25, 0.7, 0.6, 0, dz - 1.0);
  box(c, 'robot_orange', 'clerk_body', 0.42, 0.34, 0.4, 0, 0.14, 0);
  box(c, 'robot_grey', 'clerk_neck', 0.07, 0.14, 0.07, 0, 0.48, 0);
  const head = grp(c, 'clerk_head', 0, 0.6, 0); box(head, 'robot_cream', 'clerk_head', 0.38, 0.2, 0.22);
  for (const s of [-1, 1]) box(head, 'eye', 'clerk_eye', 0.12, 0.12, 0.03, s * 0.09, 0.04, 0.115);
  box(head, 'ink', 'clerk_visor', 0.4, 0.04, 0.12, 0, 0.2, 0.06);
  const arm = grp(c, 'clerk_arm', 0.26, 0.42, 0.05);
  box(arm, 'robot_grey', 'arm', 0.07, 0.07, 0.34, 0, 0, 0.17); box(arm, 'wood_dark', 'stamp_handle', 0.08, 0.14, 0.08, 0, -0.06, 0.34); box(arm, 'stripe_red', 'stamp_head', 0.14, 0.05, 0.14, 0, -0.14, 0.34);
  const ARM_REST = -0.5; arm.rotation.x = ARM_REST; // stamp raised; 0 = pressed on the paper

  // ---------- a few things on the floor, all in front of the boards so the overlay never hides them ----------
  box(room, 'velvet', 'rug', 5.0, 0.02, 2.6, 0.6, 0, dz - 0.4);
  const cab = grp(room, 'filing_cabinet', 5.2, 0, 2.2, -0.3);
  box(cab, 'metal', 'cabinet_body', 0.9, 1.3, 0.7); for (const y of [0.25, 0.7]) box(cab, 'ink', 'cabinet_handle', 0.3, 0.05, 0.04, 0, y + 0.2, 0.36);
  const pot = grp(room, 'plant', -5.4, 0, 2.4);
  cyl(pot, 'brick', 'plant_pot', 0.3, 0.24, 0.5, 0, 0, 0, 8); ball(pot, 'leaf_a', 'plant_leaves', 0.45, 0, 0.9, 0); ball(pot, 'leaf_c', 'plant_leaves', 0.3, 0.25, 1.15, 0.1);
  put(room, gCone(0.25, 0.5, 6), 'leaf_b', 'plant_tip', -5.4, 1.45, 2.4);
  put(room, gBox(0.5, 0.5, 0.5), 'wood', 'crate', -4.2, 0.25, 3.0).rotation.y = 0.4;

  room.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });

  // ---------- board corners in world space (top-left, top-right, bottom-right, bottom-left) ----------
  room.updateMatrixWorld(true);
  const corners = (b) => [[-1, 1], [1, 1], [1, -1], [-1, -1]].map(([sx, sy]) => room.localToWorld(new THREE.Vector3(b.x + (sx * b.w) / 2, b.y + (sy * b.h) / 2, BACK)));
  const boards = { ledger: corners(LEDGER), chain: corners(CHAIN) };

  // ---------- animation: the stamp swing (0.45 s) and a slow look around ----------
  let stampT = 0;
  const STAMP = 0.45;
  const stamp = () => { stampT = STAMP; };
  function tick(t, dt) {
    if (!room.visible) return;
    if (stampT > 0) stampT = Math.max(0, stampT - dt);
    arm.rotation.x = ARM_REST * (1 - Math.sin(((STAMP - stampT) / STAMP) * PI) * (stampT > 0 ? 1 : 0));
    head.rotation.y = Math.sin(t * 0.7) * 0.15;
  }

  // ---------- the camera swap (v1's setRoom): look at the back wall straight on, zoomed to hold both boards ----------
  const alsoHide = [];  // scene.js may push actor groups that live outside the world group
  const CTR = new THREE.Vector3(0, 2.85, 0), VIEW = new THREE.Vector3(0, Math.sin(PITCH), Math.cos(PITCH));
  let saved = null;
  function setRoom(on) {
    const cam = stage._camera, ctl = stage._controls;
    if (on && !saved) {
      saved = { pos: cam.position.clone(), target: ctl.target.clone(), zoom: cam.zoom, bg: stage._scene.background, minZoom: ctl.minZoom, maxZoom: ctl.maxZoom, rotate: ctl.enableRotate, hidden: [] };
      for (const o of [stage._object, ...alsoHide]) if (o && o.visible) { o.visible = false; saved.hidden.push(o); }
      const len = cam.position.distanceTo(ctl.target);
      ctl.target.copy(CTR); cam.position.copy(CTR).addScaledVector(VIEW, len);
      if (cam.isOrthographicCamera) cam.zoom = Math.min((0.94 * (cam.right - cam.left)) / SPAN_W, (0.94 * (cam.top - cam.bottom)) / SPAN_H);
      ctl.minZoom = cam.zoom * 0.85; ctl.maxZoom = cam.zoom * 1.8; ctl.enableRotate = false; // keeps the boards rectangles under the overlay
      stage._scene.background = new THREE.Color('#f3ead7');
      room.visible = true;
    } else if (!on && saved) {
      cam.position.copy(saved.pos); ctl.target.copy(saved.target); cam.zoom = saved.zoom; stage._scene.background = saved.bg;
      ctl.minZoom = saved.minZoom; ctl.maxZoom = saved.maxZoom; ctl.enableRotate = saved.rotate;
      for (const o of saved.hidden) o.visible = true;
      room.visible = false; saved = null;
    }
    cam.updateProjectionMatrix(); ctl.update();
  }
  const inRoom = () => !!saved;

  return { room, boards, stamp, tick, setRoom, inRoom, alsoHide };
}

// ---- DOM ledger panels (builder B) ----
// They live in ledger.js (room.js did not exist yet when they were written). Re-exported here so the interface
// "room.js exports createRoom, createLedgerPanels, verifyChain" holds; scene.js imports them from ledger.js directly.
export { createLedgerPanels, verifyChain } from './ledger.js';
