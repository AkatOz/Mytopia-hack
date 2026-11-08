// The island in three.js: puts the pieces together and gives main.js one small API. It only knows HOW to draw; the
// reducer decides WHAT. Replaces v1's single-file scene (docs/ISLAND_V2.md section 7):
//   world.js      islands, bridges, gates, booths, dock, pen, bin, clouds, gulls, reeds
//   buildings.js  the FILES tower, studio, cottage, courthouse, gatehouse
//   factory.js    build 3: the Factory island's arch, hall, yard, inspection bay, cart home
//   rooms.js      build 3 (builder B2): every building's interior in 3D (the gatehouse is the ledger room)
//   ledger.js     the hash-chain check (verifyChain)
//   actors.js     robots, guards, the cart, scripts        effects.js  slips, packets, lamps, smoke
// Pre-existing: v1's sky, framing and toScreen(); everything else here is new wiring from today.
// Build 3 (docs/BUILD3.md section 4): addRobot/removeRobot/setTier, the cart/build/recycle steps, enterRoom/leaveRoom/
// roomKey, pickBuilding, buildRobot, bayScreen, bayScanning, factorySmoke, tamperTest, roomsRefresh, setRoomHooks.
// setRoom(on)/inRoom()/drawLedger/panels/onChain/onLedgerRow/nearGate stay for the main.js of build 2.
import { makeKit } from './kit.js';
import * as L from './layout.js';
import { buildWorld } from './world.js';
import { buildBuildings } from './buildings.js';
import { buildFactory } from './factory.js';
import * as Ledger from './ledger.js';
import { createActors } from './actors.js';
import { createEffects } from './effects.js';

export const ROOM_KEYS = ['gatehouse', 'files', 'github', 'mail', 'admin', 'factory_office', 'factory_floor'];

export async function createScene(stage, hooksIn = {}) {
  const { THREE } = await stage.ready;
  const kit = makeKit(THREE);
  const ctx = { THREE, kit, L, stage };

  // ---------- build ----------
  const W = buildWorld(ctx);              // { world: Group, gates, pen, bin, dock, clouds, tick, groundY }
  const places = buildBuildings(ctx, W);  // { files, github, mail, admin, gatehouse }: door, roof, lampMat, labelAnchor...
  const F = buildFactory(ctx, W);         // the Factory: hall, floorSign, bay, screenAnchor, chimneyTops, openDoors...
  places.factory = { key: 'factory', g: F.hall, door: F.door, roof: F.roof, lampMat: F.lampMat, labelAnchor: F.labelAnchor };
  // the framing for this screen's shape (layout.FRAMING; `narrow` below 1.6:1), applied again when the shape crosses it
  const framingFor = () => {
    const n = L.FRAMING.narrow, a = (stage.clientWidth || innerWidth) / Math.max(1, stage.clientHeight || innerHeight);
    return n && a < n.below ? n : L.FRAMING;
  };
  let framing = framingFor();
  stage.setObject(W.world, { target: framing.target, radius: framing.radius });
  const ctl = stage._controls;
  // Build 4: the island camera. Left drag turns it, the wheel zooms, and only a held MIDDLE button (the wheel pressed
  // down) slides it sideways over the ground; the right button does nothing. recenter() (key C) puts the framing back.
  // Rooms keep their own rules (rooms.js saves these and turns panning off inside).
  const islandControls = () => {
    ctl.enablePan = true; ctl.screenSpacePanning = false; // pan along the ground plane, like dragging a map
    ctl.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: null };
    ctl.minZoom = L.FRAMING.minZoom; ctl.maxZoom = L.FRAMING.maxZoom;
  };
  islandControls();

  // the sky (v1): pale blue at the top to warm paper at the horizon
  const sky = document.createElement('canvas'); sky.width = 96; sky.height = 256;
  const sg = sky.getContext('2d'), gr = sg.createLinearGradient(0, 0, 0, 256);
  gr.addColorStop(0, '#bfe0ec'); gr.addColorStop(0.42, '#e9ecdc'); gr.addColorStop(0.7, '#f6e8cf'); gr.addColorStop(1, '#f4cfae');
  sg.fillStyle = gr; sg.fillRect(0, 0, 96, 256);
  const skyTex = new THREE.CanvasTexture(sky); skyTex.colorSpace = THREE.SRGBColorSpace;
  stage._scene.background = skyTex;

  const effects = createEffects(ctx, W, places);
  effects.setChimneys(F.chimneyTops);
  const actors = createActors(ctx, W, places, { lamp: effects.lamp, puff: effects.puff, onFx: null, idCard: null, factory: F });

  // ---------- callbacks main.js sets ----------
  let onChain = null, onRow = null, lastLog = [], lastSource = 'live', lastChainId = '';
  const roomHooks = { getLog: null, getRoster: null, getInquest: null, onRow: null, ...hooksIn };
  const hooks = { // what rooms.js calls; each falls back to what the build-2 main.js already gives the scene
    getLog: () => (roomHooks.getLog ? roomHooks.getLog() : lastLog) || [],
    getRoster: () => (roomHooks.getRoster ? roomHooks.getRoster() : []) || [],
    getInquest: (id) => (roomHooks.getInquest ? roomHooks.getInquest(id) : null),
    onRow: (seq) => { if (roomHooks.onRow) roomHooks.onRow(seq); else if (onRow) onRow(seq); },
    getChain: () => (roomHooks.getChain ? roomHooks.getChain() : lastChainId) || '', // the chain id in the ledger board's header
  };

  // ---------- the interiors (rooms.js, builder B2). If it is missing or throws, the build-2 ledger room stands in. ----------
  let rooms = null, legacy = null;
  try {
    const mod = await import('./rooms.js');
    rooms = mod.createRooms(ctx, hooks);
    if (rooms && rooms.group && !rooms.group.parent) stage._scene.add(rooms.group);
    if (rooms && rooms.group) rooms.group.visible = false;
  } catch (e) {
    console.info('scene: rooms.js not available, using the build-2 ledger room', e && e.message);
    rooms = null;
  }
  if (!rooms) {
    try {
      const { createRoom } = await import('./room.js');
      const room = createRoom(ctx);
      stage._scene.add(room.room); room.room.visible = false;
      const panels = typeof Ledger.createLedgerPanels === 'function'
        ? Ledger.createLedgerPanels(ctx, room, { onChange: (v) => onChain && onChain(v), onRow: (seq) => hooks.onRow(seq) })
        : null;
      legacy = { room, panels };
    } catch (e) { console.info('scene: no room available', e && e.message); }
  }

  // the chain check for the gateway strip (with rooms.js the DOM ledger panels are gone; the result is the same)
  function chainCheck() {
    let result = null, key = '';
    const verified = () => (!result || !result.verified ? 'unverified' : result.ok ? 'ok' : `broken:#${result.brokenAt}`);
    return {
      draw(log) {
        const k = `${log.length}:${log.length ? log[log.length - 1].hash : ''}`;
        if (k === key) return;
        key = k;
        Promise.resolve(Ledger.verifyChain(log.slice())).then((r) => {
          if (k !== key) return;
          result = r; if (onChain) onChain(verified());
          if (rooms && typeof rooms.refresh === 'function') rooms.refresh();
        }).catch(() => { result = null; });
      },
      follow() {}, verified, result: () => result,
    };
  }
  const panels = legacy && legacy.panels ? legacy.panels : chainCheck();

  // ---------- anchors: names in the effects -> points in the world ----------
  const up = (v, dy) => (v ? v.clone().add(new THREE.Vector3(0, dy, 0)) : null);
  function anchorPoint(key) { // where a DENIED stamp goes
    if (key === 'pen') return W.pen.stampAnchor;
    if (key === 'bay') return F.stampAnchor;
    if (key === 'gatehouse') return places.gatehouse.stampAnchor || up(places.gatehouse.windowAnchor, 1.5);
    if (key.startsWith('gate:')) return W.gates[key.slice(5)]?.stampAnchor || null;
    return null;
  }
  function slipFrom(key) { // where a slip takes off
    if (key === 'bay') return F.slipFrom;
    if (key.startsWith('door:')) return up(places[key.slice(5)]?.door, 2.4);
    if (key.startsWith('gate:')) return up(W.gates[key.slice(5)]?.stampAnchor, -1.2);
    if (key === 'pen') return up(W.pen.stampAnchor, -1.4);
    if (key === 'gatehouse') return places.gatehouse.windowAnchor || places.gatehouse.roof;
    return null;
  }
  function lampOf(target) {
    if (target === 'bay') return F.bayLamp;
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
  const vane = places.gatehouse?.vane;
  const failed = new Set();
  const parts = [['world', W.tick], ['factory', F.tick], ['actors', actors.tick], ['effects', effects.tick],
    ['vane', (t) => { if (vane) vane.rotation.y = 0.6 + Math.sin(t * 0.13) * 0.5 + Math.sin(t * 0.71) * 0.08; }],
    ['rooms', (t, dt) => { if (rooms && typeof rooms.tick === 'function') rooms.tick(t, dt); else if (legacy) legacy.room.tick(t, dt); }]];
  stage.onTick = (t, dt) => {
    for (const [name, fn] of parts) {
      if (typeof fn !== 'function') continue;
      try { fn(t, dt); } catch (e) { if (!failed.has(name)) { failed.add(name); console.error(`scene: ${name}.tick failed`, e); } }
    }
  };

  // ---------- rooms: enter / leave (the world is hidden while one is open, the camera saved and restored) ----------
  let current = null;
  // build 4: the look-at point may wander only over the archipelago (islets at x -29..29, the Factory to z 34), never
  // the open sea; a middle-drag past the edge stops there (registered here, after `current` exists)
  const PAN_BOX = { x0: -30, x1: 30, z0: -24, z1: 36 };
  ctl.addEventListener('change', () => {
    if (current) return; // a room owns the camera
    const t = ctl.target;
    const x = Math.min(PAN_BOX.x1, Math.max(PAN_BOX.x0, t.x)), z = Math.min(PAN_BOX.z1, Math.max(PAN_BOX.z0, t.z));
    if (x === t.x && z === t.z) return;
    cam.position.x += x - t.x; cam.position.z += z - t.z; t.x = x; t.z = z;
  });
  function enterRoom(key) {
    if (!ROOM_KEYS.includes(key)) return false;
    if (current === key) return true;
    { const damp = ctl.enableDamping; ctl.enableDamping = false; ctl.update(); ctl.enableDamping = damp; } // build 4 (review): spend the island's glide first
    if (rooms) {
      if (current) { try { rooms.leave(); } catch (e) { console.error('scene: rooms.leave failed', e); } }
      try { rooms.enter(key); } catch (e) { console.error('scene: rooms.enter failed', e); W.world.visible = true; current = null; return false; }
      W.world.visible = false; if (rooms.group) rooms.group.visible = true;
      current = key;
    } else if (legacy && key === 'gatehouse') {
      legacy.room.setRoom(true); W.world.visible = false; legacy.room.room.visible = true; current = key;
    } else return false;
    cam.updateProjectionMatrix(); ctl.update();
    return true;
  }
  function leaveRoom() {
    if (!current) return;
    { const damp = ctl.enableDamping; ctl.enableDamping = false; ctl.update(); ctl.enableDamping = damp; } // user test: a room's leftover turn stays in the room
    if (rooms) {
      try { rooms.leave(); } catch (e) { console.error('scene: rooms.leave failed', e); }
      if (rooms.group) rooms.group.visible = false;
    } else if (legacy) { legacy.room.setRoom(false); legacy.room.room.visible = false; }
    W.world.visible = true; current = null;
    cam.updateProjectionMatrix(); ctl.update();
  }
  const setRoom = (on) => (on ? enterRoom('gatehouse') : leaveRoom());
  function reframe() {
    if (current) return; // a room owns the camera; leaving it restores the island's, and the next resize reframes
    const f = framingFor(); if (f === framing) return;
    framing = f; stage.setObject(W.world, { target: f.target, radius: f.radius });
    islandControls();
  }
  // key C: the opening view again (target, distance, angle, zoom), after any pan, turn or zoom; inside a room, nothing
  function recenter() {
    if (current) return false;
    // the controls glide on after a drag (damping): spend that leftover turn/slide first, or it carries the fresh view off
    const damp = ctl.enableDamping; ctl.enableDamping = false; ctl.update(); ctl.enableDamping = damp;
    framing = framingFor(); stage.setObject(W.world, { target: framing.target, radius: framing.radius });
    islandControls();
    return true;
  }
  addEventListener('resize', () => { try { reframe(); } catch (e) { console.error('scene: reframe failed', e); } });

  let lastRows = 0;
  function drawLedger(log, source, chain) {
    lastLog = log || []; lastSource = source || lastSource; lastChainId = chain || lastChainId;
    panels.draw(lastLog, lastSource, lastChainId);
    if (rooms && typeof rooms.refresh === 'function') { try { rooms.refresh(); } catch (e) { console.error('scene: rooms.refresh failed', e); } }
    if (lastLog.length > lastRows) { // the clerk stamps each new row
      if (rooms && typeof rooms.stamp === 'function') rooms.stamp();
      else if (legacy && typeof legacy.room.stamp === 'function') legacy.room.stamp();
    }
    lastRows = lastLog.length;
  }

  // ---------- clicks on buildings: a raycast against each building's own group ----------
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  const PICK = [['factory_floor', F.floorSign], ['factory_office', F.hall], ['files', places.files?.g], ['github', places.github?.g],
    ['mail', places.mail?.g], ['admin', places.admin?.g], ['gatehouse', places.gatehouse?.g], ['gatehouse', W.world.getObjectByName('booth_chief')]].filter(([, o]) => o);
  function pickBuilding(x, y) {
    if (current) return null;
    const r = canvas.getBoundingClientRect();
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) return null;
    ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, cam);
    let best = null, bd = Infinity;
    for (const [key, obj] of PICK) {
      const hit = ray.intersectObject(obj, true)[0];
      if (!hit || hit.distance >= bd) continue;
      bd = hit.distance; best = key;
      for (let o = hit.object; o; o = o.parent) if (o.userData && o.userData.pick) { best = o.userData.pick; break; } // the hall's door and FLOOR plaque -> the floor
    }
    return best;
  }

  const LABELS = ['files', 'github', 'mail', 'admin', 'gatehouse', 'factory'].filter((k) => places[k]);

  return {
    // robots and their scripts
    addRobot(id, color, slot) { actors.addAgent(id, color, slot); },
    removeRobot: (id) => actors.removeRobot(id),
    setTier: (id, tier) => actors.setTier(id, tier),
    hasRobot: (id) => actors.has(id),
    run: (id, steps, opts) => actors.run(id, steps, opts),
    halt: (id) => actors.halt(id),
    freeze: (id) => actors.freeze(id),
    setPlate: (id, plate) => actors.setPlate(id, plate),
    powerDown: (id) => actors.powerDown(id),
    // true while any robot still has a script to play, a guard is walking one back or the cart is out (replay waits)
    busy: () => Object.keys(actors.agents).some((id) => actors.busy(id)) || Object.values(actors.guards).some((gd) => gd.attachedTo) || actors.cartBusy(),
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
    factorySmoke: (fast = true) => effects.factorySmoke(fast), // the chimneys puff every 0.3 s for 8 s
    bayScanning: (on) => F.bayScanning(on),                 // the bay's scanner arm sweeps while an inquest runs
    // screen positions for the overlay
    stampAnchor: (key) => toScreen(anchorPoint(key)),
    robotScreen: (id) => toScreen(actors.screenOf(id)),
    placeScreen: (key) => toScreen(places[key]?.labelAnchor || up(places[key]?.roof, 1.3)),
    binScreen: () => toScreen(W.bin.anchor),
    bayScreen: () => (current ? null : toScreen(F.screenAnchor)), // the top edge of the bay's screen (the inquest panel)
    toScreen,
    places: () => Object.keys(places),
    labels: () => LABELS,
    // the camera (build 4): key C
    recenter,
    // the interiors
    enterRoom, leaveRoom, roomKey: () => current, rooms: () => rooms,
    pickBuilding,
    buildRobot: (spec) => (rooms && typeof rooms.buildRobot === 'function' ? rooms.buildRobot(spec) : Promise.resolve()),
    tamperTest: () => (rooms && typeof rooms.tamperTest === 'function' ? rooms.tamperTest() : undefined),
    roomsRefresh: () => { if (rooms && typeof rooms.refresh === 'function') rooms.refresh(); },
    setRoomHooks(h) { Object.assign(roomHooks, h || {}); },
    // the build-2 ledger room API (main.js of build 2 still uses it): G = the gatehouse room
    drawLedger, setRoom, inRoom: () => !!current, panels,
    onChain(fn) { onChain = fn; },                    // called when the hash-chain check finishes
    onLedgerRow(fn) { onRow = fn; },                  // fn(seq) when a ledger row is clicked
    nearGate: (x, y) => pickBuilding(x, y) === 'gatehouse',
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
      actors.reset(); effects.reset(); F.reset();
      for (const g of Object.values(W.gates)) { g.counter?.set(0); g.padlock?.set(false); }
      lastRows = 0;
    },
  };
}
