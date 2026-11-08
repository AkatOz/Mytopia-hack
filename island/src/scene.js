// The island in three.js: puts the pieces together and gives main.js one small API. It only knows HOW to draw; the
// reducer decides WHAT. Replaces v1's single-file scene (docs/ISLAND_V2.md section 7):
//   world.js      islands, bridges, gates, booths, dock, pen, bin, clouds   (builder A)
//   buildings.js  the FILES tower, studio, cottage, courthouse, gatehouse    (builder A)
//   room.js       the ledger room in 3D                                    (builder A)
//   ledger.js     the ledger room's DOM panels and the hash-chain check
//   actors.js     robots, guards, scripts        effects.js  slips, packets, lamps, smoke
// Pre-existing: v1's sky, framing and toScreen(); everything else here is new wiring from today.
import { makeKit } from './kit.js';
import * as L from './layout.js';
import { buildWorld } from './world.js';
import { buildBuildings } from './buildings.js';
import { createRoom } from './room.js';
import { createLedgerPanels } from './ledger.js';
import { createActors } from './actors.js';
import { createEffects } from './effects.js';

export async function createScene(stage) {
  const { THREE } = await stage.ready;
  const kit = makeKit(THREE);
  const ctx = { THREE, kit, L, stage };

  // ---------- build ----------
  const W = buildWorld(ctx);              // { world: Group, gates, pen, bin, dock, clouds, tick, groundY }
  const places = buildBuildings(ctx, W);  // { files, github, mail, admin, gatehouse }: door, roof, lampMat, labelAnchor...
  stage.setObject(W.world, { target: L.FRAMING.target, radius: L.FRAMING.radius });
  const ctl = stage._controls;
  ctl.enablePan = false; ctl.minZoom = L.FRAMING.minZoom; ctl.maxZoom = L.FRAMING.maxZoom;

  // the sky (v1): pale blue at the top to warm paper at the horizon
  const sky = document.createElement('canvas'); sky.width = 96; sky.height = 256;
  const sg = sky.getContext('2d'), gr = sg.createLinearGradient(0, 0, 0, 256);
  gr.addColorStop(0, '#bfe0ec'); gr.addColorStop(0.42, '#e9ecdc'); gr.addColorStop(0.7, '#f6e8cf'); gr.addColorStop(1, '#f4cfae');
  sg.fillStyle = gr; sg.fillRect(0, 0, 96, 256);
  const skyTex = new THREE.CanvasTexture(sky); skyTex.colorSpace = THREE.SRGBColorSpace;
  stage._scene.background = skyTex;

  const room = createRoom(ctx);
  stage._scene.add(room.room); room.room.visible = false;
  let onChain = null;
  let onRow = null;
  const panels = createLedgerPanels(ctx, room, { onChange: (v) => onChain && onChain(v), onRow: (seq) => onRow && onRow(seq) });

  const effects = createEffects(ctx, W, places);
  const actors = createActors(ctx, W, places, { lamp: effects.lamp, puff: effects.puff, onFx: null, idCard: null });

  // ---------- anchors: names in the effects -> points in the world ----------
  const up = (v, dy) => (v ? v.clone().add(new THREE.Vector3(0, dy, 0)) : null);
  function anchorPoint(key) { // where a DENIED stamp goes
    if (key === 'pen') return W.pen.stampAnchor;
    if (key === 'gatehouse') return places.gatehouse.stampAnchor || up(places.gatehouse.windowAnchor, 1.5);
    if (key.startsWith('gate:')) return W.gates[key.slice(5)]?.stampAnchor || null;
    return null;
  }
  function slipFrom(key) { // where a slip takes off
    if (key.startsWith('door:')) return up(places[key.slice(5)]?.door, 2.4);
    if (key.startsWith('gate:')) return up(W.gates[key.slice(5)]?.stampAnchor, -1.2);
    if (key === 'pen') return up(W.pen.stampAnchor, -1.4);
    if (key === 'gatehouse') return places.gatehouse.windowAnchor || places.gatehouse.roof;
    return null;
  }
  function lampOf(target) {
    if (target.startsWith('door:')) return places[target.slice(5)]?.lampMat;
    if (target.startsWith('booth:')) return W.gates[target.slice(6)]?.lampMat;
    if (target === 'pen') return W.pen.lampMat;
    if (target === 'chief') return places.gatehouse.chiefBooth?.lampMat;
    return null;
  }

  // ---------- screen positions ----------
  const cam = stage._camera, canvas = stage._renderer.domElement, tmp = new THREE.Vector3();
  const toScreen = (v) => {
    if (!v) return null;
    const r = canvas.getBoundingClientRect();
    tmp.copy(v).project(cam);
    return [r.left + (tmp.x + 1) / 2 * r.width, r.top + (1 - tmp.y) / 2 * r.height];
  };

  // ---------- per frame: each part ticks on its own, so one broken part never stops the others ----------
  const failed = new Set();
  const parts = [['world', W.tick], ['actors', actors.tick], ['effects', effects.tick], ['room', room.tick]];
  stage.onTick = (t, dt) => {
    for (const [name, fn] of parts) {
      if (typeof fn !== 'function') continue;
      try { fn(t, dt); } catch (e) { if (!failed.has(name)) { failed.add(name); console.error(`scene: ${name}.tick failed`, e); } }
    }
  };

  // ---------- the ledger room ----------
  let inRoom = false, saved = null, lastRows = 0;
  function setRoom(on) {
    if (on === inRoom) return;
    inRoom = on;
    if (typeof room.setRoom === 'function') room.setRoom(on);
    else if (on && typeof room.enter === 'function') { saved = {}; saved = room.enter(saved) || saved; }
    else if (!on && typeof room.leave === 'function') room.leave(saved);
    W.world.visible = !on; room.room.visible = on;
    cam.updateProjectionMatrix(); ctl.update();
  }
  function drawLedger(log, source, chain) {
    panels.draw(log, source, chain);
    if (log.length > lastRows && typeof room.stamp === 'function') room.stamp(); // the clerk stamps each new row
    lastRows = log.length;
  }

  // the gatehouse's outline on screen (for the click that opens the room)
  let ghBox = null;
  function nearGate(x, y) {
    if (!places.gatehouse?.g) return false;
    ghBox = ghBox || new THREE.Box3().setFromObject(places.gatehouse.g);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < 8; i++) {
      const p = toScreen(new THREE.Vector3(i & 1 ? ghBox.max.x : ghBox.min.x, i & 2 ? ghBox.max.y : ghBox.min.y, i & 4 ? ghBox.max.z : ghBox.min.z));
      x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]);
    }
    return x >= x0 && x <= x1 && y >= y0 && y <= y1;
  }

  const LABELS = ['files', 'github', 'mail', 'admin', 'gatehouse'].filter((k) => places[k]);

  return {
    // robots and their scripts
    addRobot(id, color, slot) { actors.addAgent(id, color, slot); },
    hasRobot: (id) => actors.has(id),
    run: (id, steps, opts) => actors.run(id, steps, opts),
    halt: (id) => actors.halt(id),
    freeze: (id) => actors.freeze(id),
    setPlate: (id, plate) => actors.setPlate(id, plate),
    powerDown: (id) => actors.powerDown(id),
    // true while any robot still has a script to play or a guard is walking one back (replay waits for this)
    busy: () => Object.keys(actors.agents).some((id) => actors.busy(id)) || Object.values(actors.guards).some((gd) => gd.attachedTo),
    onFx(fn) { actors.hooks.onFx = fn; },              // effects carried inside scripts come back out through here
    onIdCard(fn) { actors.hooks.idCard = fn; },        // fn(agentId, { at, lines }) when a robot raises its ID card
    // effects
    lamp(target, tone, ms = 2500) { effects.lamp(lampOf(target), tone, ms); },
    slip(from, ok) { return effects.slip(slipFrom(from), places.gatehouse.ledgerDrop || places.gatehouse.roof, ok); },
    packet: (quiet) => effects.packet(quiet),
    smoke: (gate, rung) => effects.smoke(gate, rung),
    clearSmoke: () => effects.clearSmoke(),
    counter(gate, n) { W.gates[gate]?.counter?.set(n); },
    padlock(gate, on) { W.gates[gate]?.padlock?.set(on); }, // round two: a tool of this islet is pulled from a badge
    // screen positions for the overlay
    stampAnchor: (key) => toScreen(anchorPoint(key)),
    robotScreen: (id) => toScreen(actors.screenOf(id)),
    placeScreen: (key) => toScreen(places[key]?.labelAnchor || up(places[key]?.roof, 1.3)),
    binScreen: () => toScreen(W.bin.anchor),
    places: () => Object.keys(places),
    labels: () => LABELS,
    // the ledger room
    drawLedger, setRoom, inRoom: () => inRoom, panels,
    onChain(fn) { onChain = fn; },                    // called when the hash-chain check finishes
    onLedgerRow(fn) { onRow = fn; },                  // fn(seq) when a ledger row is clicked or Enter is pressed on it
    // clicks
    nearGate,
    pickRobot(x, y) {
      let best = null, bd = 56;
      for (const id of Object.keys(actors.agents)) {
        const head = actors.screenOf(id); if (!head) continue;
        const p = toScreen(head.clone().add(new THREE.Vector3(0, -1.8, 0))); // the middle of the body
        const d = Math.hypot(p[0] - x, p[1] - y);
        if (d < bd) { bd = d; best = id; }
      }
      return best;
    },
    // a new chain (someone pressed RESET): robots in the hatch, guards in the booths, bins empty, counters 0
    reset() {
      actors.reset(); effects.reset();
      for (const g of Object.values(W.gates)) { g.counter?.set(0); g.padlock?.set(false); }
      lastRows = 0;
    },
  };
}
