// The people of the island: the agent robots, the five guards, and the script runner that walks them around.
// Pre-existing: the robot body (treads, body, neck, cream head, eyes with glints, antenna) is Mytopia's small robot from
// campus.js, as used by v1's scene.js. New today (docs/ISLAND_V2.md section 3): the chest plate pop, two arms and the
// ID card, the guard uniform (peaked cap, brass star, no antenna), walking on the waypoint graph of layout.js, the
// script queue with fast-forward, the escort, the pen, power-down.
//
// A script is a list of steps (the reducer writes them):
//   { walk: nodeKey | [x, z] }   walk along layout.route to that node (to this robot's own spot there, see layout.spotOf)
//   { wait: seconds }
//   { showId: true, card }       raise the ID card for 0.7 s (card: { at, lines } goes to hooks.idCard for the DOM card)
//   { gate: key, lamp }          the booth lamp turns 'ok' or 'bad'; on 'ok' the barrier lifts
//   { escort: { by, to } }       the guard ('booth:<key>' or 'chief') walks to the robot, both walk to `to`, the guard goes home
//   { pen: 'in' | 'out' }        the rope gate opens, the robot walks into (or out of) the pen, the rope closes
//   { summon: 'chief', to: nodeKey | 'agent', wait }   the guard walks there; the robot waits for it when wait is true
//   { dismiss: 'chief' }         the guard walks back to its booth
//   { spawn: true }              rise out of the dock hatch (0.4 s)
//   { sink: true }               sink into the dock hatch and hide
//   { fx: effect }               hand an effect to the player at this moment (hooks.onFx)
//   { say: fn } / { call: fn }   call a function at this moment
// Each actor keeps a queue of scripts. A new script waits for the one playing; while scripts wait, the one playing runs
// faster (x1.75 with one waiting, x2.5 with two); with more than two waiting, the oldest jumps to its end state. So the
// picture never falls far behind the log, and replay and live use the same code.

const PI = Math.PI;
const REST = PI / 4;                 // at rest a robot faces the camera (south-east)
// units per second; seconds to speed up and slow down. Integrator: the brief's 3.0 / 3.4 were v1's speeds; the
// archipelago is 2.3x wider, so a round trip to an islet took 13 s at 3.0 and the robot fell three events behind the
// log in the demo replay (the send_email refusal was skipped). 5.5 / 6.0 keep it within about one event.
const AGENT_SPEED = 5.5, GUARD_SPEED = 6.0, RAMP = 0.3;
const PLATE = { none: 0x8a8278, active: 0x3f8a56, revoked: 0xb4553e, kill: 0xd9a032, stopped: 0x2b221e };
const SCALE = 3;                     // the robot recipe is 1.05 units tall; drawn at scale 3 like v1
const HEAD_TOP = 3.4;                // world height of the name-tag anchor above a robot's feet

const dist = (ax, az, bx, bz) => Math.hypot(bx - ax, bz - az);
const angleTo = (from, to) => { let d = (to - from) % (2 * PI); if (d > PI) d -= 2 * PI; if (d < -PI) d += 2 * PI; return d; };

export function createActors(ctx, world, places, hooks = {}) {
  const { THREE, kit, L } = ctx;
  const { M, box, cyl, ball, grp } = kit;
  const root = world.world;
  const agents = {}, guards = {};
  let clock = 0;                     // seconds, from tick()
  const gateLift = {};               // gate key -> clock time until which the barrier stays up
  let penOpen = false;

  // ---------- bodies ----------
  function makeBody(name, look) {
    const g = new THREE.Group(); g.name = name; g.userData.actor = true; root.add(g);
    for (const s of [-1, 1]) { box(g, look.tread, 'robot_tread', 0.13, 0.18, 0.46, s * 0.2, 0, 0); box(g, 'ink', 'robot_tread_grip', 0.14, 0.04, 0.47, s * 0.2, 0.07, 0); }
    const rig = grp(g, 'robot_rig');
    box(rig, look.body, 'robot_body', 0.42, 0.34, 0.4, 0, 0.14, 0);
    box(rig, 'robot_grey', 'robot_neck', 0.07, 0.14, 0.07, 0, 0.48, 0);
    const head = grp(rig, 'robot_head', 0, 0.6, 0);
    box(head, 'robot_cream', 'robot_head', 0.38, 0.2, 0.22);
    const eyeMat = M.eye.clone(); const glints = [];
    for (const s of [-1, 1]) {
      box(head, eyeMat, 'robot_eye', 0.12, 0.12, 0.03, s * 0.09, 0.04, 0.115);
      glints.push(box(head, 'eye_glint', 'robot_eye_glint', 0.035, 0.035, 0.02, s * 0.09 - 0.025, 0.11, 0.13));
    }
    // two arms hanging from the shoulders; +x is the robot's left hand (it faces +z)
    const arms = [1, -1].map((s) => {
      const arm = grp(rig, s > 0 ? 'robot_arm_left' : 'robot_arm_right', s * 0.245, 0.44, 0);
      box(arm, look.arm, 'robot_arm', 0.07, 0.26, 0.07, 0, -0.26, 0);
      box(arm, look.hand, 'robot_hand', 0.09, 0.07, 0.09, 0, -0.32, 0);
      return arm;
    });
    g.scale.setScalar(SCALE);
    return { g, rig, head, eyeMat, glints, armL: arms[0], armR: arms[1] };
  }

  function newActor(id, kind, body, slot) {
    return {
      id, kind, slot, ...body, speed: kind === 'agent' ? AGENT_SPEED : GUARD_SPEED,
      lastNode: null, queue: [], path: null, heading: REST, want: REST, walking: false,
      frozen: false, powered: true, hidden: false, attachedTo: null, escortedBy: null,
      armLTarget: 0, armRTarget: 0, plateBounce: 0, faceUntil: 0, faceAt: null,
    };
  }

  function addAgent(id, color, slot) {
    if (agents[id]) return agents[id];
    const look = { tread: 'robot_grey', body: M['robot_' + color] || M.robot_mustard, arm: 'robot_grey', hand: 'robot_grey' };
    const b = makeBody('robot_' + id, look);
    const plateMat = new THREE.MeshStandardMaterial({ name: 'plate_' + id, color: PLATE.none, emissive: PLATE.none, emissiveIntensity: 0.25, flatShading: true });
    const plate = box(b.rig, plateMat, 'robot_plate', 0.3, 0.2, 0.04, 0, 0.2, 0.21);
    cyl(b.rig, 'ink', 'robot_antenna', 0.012, 0.012, 0.2, 0.12, 0.8, -0.04, 4);
    const tipMat = M.fl_red.clone();
    ball(b.rig, tipMat, 'robot_antenna_tip', 0.035, 0.12, 1.02, -0.04, 0);
    // the ID card in the left hand: paper with a stripe in the robot's own colour; shown only during an ID check
    const card = grp(b.armL, 'id_card', 0, -0.34, 0.03);
    box(card, 'paper', 'id_card', 0.2, 0.14, 0.02, 0, -0.16, 0);
    box(card, M['robot_' + color] || M.robot_mustard, 'id_card_stripe', 0.205, 0.04, 0.026, 0, -0.07, 0);
    box(card, 'ink', 'id_card_photo', 0.05, 0.05, 0.028, -0.05, -0.13, 0);
    card.visible = false;
    const a = newActor(id, 'agent', { ...b, plateMat, plate, tipMat, card }, slot);
    shade(a.g);
    agents[id] = a;
    placeAtHatch(a);
    return a;
  }

  // Guards: the same recipe as a police uniform (navy body, cream head, peaked cap, brass star, black treads, no antenna).
  function addGuard(key, home, homeNode, homeHeading) {
    const b = makeBody('guard_' + key.replace(':', '_'), { tread: 'tread_black', body: 'uniform', arm: 'uniform', hand: 'robot_cream' });
    box(b.rig, 'brass', 'guard_star', 0.09, 0.09, 0.03, -0.1, 0.32, 0.21);
    box(b.head, 'uniform', 'guard_cap', 0.42, 0.1, 0.3, 0, 0.2, -0.02);
    box(b.head, 'uniform_dark', 'guard_cap_band', 0.43, 0.04, 0.31, 0, 0.2, -0.02);
    box(b.head, 'uniform_dark', 'guard_cap_brim', 0.4, 0.03, 0.13, 0, 0.2, 0.17);
    box(b.head, 'brass', 'guard_cap_badge', 0.07, 0.05, 0.02, 0, 0.24, 0.135);
    const gd = newActor(key, 'guard', b, 0);
    gd.home = { point: home, node: homeNode, heading: homeHeading };
    shade(gd.g);
    guards[key] = gd;
    sendHome(gd, true);
    return gd;
  }
  function shade(o) { o.traverse((m) => { if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } }); }

  // ---------- ground height: world.js knows how much each bridge deck sags; elsewhere it is the paving top ----------
  const groundY = (x, z) => (world.groundY ? world.groundY(x, z) : 0.07);
  function setXZ(a, x, z) { a.g.position.x = x; a.g.position.z = z; a.g.position.y = groundY(x, z) - (a.powered ? 0 : 0.15); }

  // ---------- walking ----------
  const pos = (a) => a.g.position;
  function startNode(a) {
    const p = pos(a);
    if (a.lastNode && L.NODES[a.lastNode] && dist(p.x, p.z, ...L.NODES[a.lastNode]) < 3.0) return a.lastNode;
    return L.nearestNode(p.x, p.z);
  }
  // the point this actor stands on at a node: agents have their own spot (two robots side by side), guards the node
  function spot(a, key) { return a.kind === 'agent' ? L.spotOf(a.slot, key) : (L.NODES[key] || L.spotOf(0, key)); }

  // A path is a list of points { x, z, key }: from here along layout.route to the destination node, ending on `final`.
  function makePath(a, destKey, final) {
    const p = pos(a);
    const keys = L.route(startNode(a), destKey);
    const pts = keys.filter((k) => L.NODES[k]).map((k) => ({ x: L.NODES[k][0], z: L.NODES[k][1], key: k }));
    // already past the first node (standing beside it, toward the next one): skip it
    if (pts.length >= 2 && dist(p.x, p.z, pts[1].x, pts[1].z) < dist(pts[0].x, pts[0].z, pts[1].x, pts[1].z)) pts.shift();
    // the destination spot comes before the bare node (a robot waiting behind another at a gate): skip the node
    if (pts.length >= 2) { const pr = pts[pts.length - 2], la = pts[pts.length - 1]; if (dist(pr.x, pr.z, final[0], final[1]) < dist(pr.x, pr.z, la.x, la.z) - 0.05) pts.pop(); }
    pts.push({ x: final[0], z: final[1], key: destKey });
    pts.unshift({ x: p.x, z: p.z, key: null });
    const clean = [];
    for (const q of pts) {
      const last = clean[clean.length - 1];
      if (last && dist(last.x, last.z, q.x, q.z) < 0.02) { last.key = last.key || q.key; continue; }
      clean.push(q);
    }
    const seg = [];
    let total = 0;
    for (let i = 1; i < clean.length; i++) { const d = dist(clean[i - 1].x, clean[i - 1].z, clean[i].x, clean[i].z); seg.push(d); total += d; }
    const v = a.speed;
    // Straight segments with ease at both ends: speed up over RAMP seconds, cruise at v, slow down over RAMP seconds
    // ('ramp'). A walk too short to reach full speed uses a plain half-cosine instead ('short').
    const short = total < v * RAMP;
    const T = short ? Math.max(0.25, 2 * Math.sqrt(total * RAMP / v)) : total / v + RAMP;
    return { pts: clean, seg, total, T, v, mode: short ? 'short' : 'ramp', t: 0, i: 0, destKey, final };
  }
  // how far along the path we are after t seconds
  function distanceAt(path, t) {
    const { total, T, v } = path;
    if (total <= 0) return 0;
    if (path.mode === 'short') return total * (1 - Math.cos(PI * Math.min(1, t / T))) / 2;
    if (t < RAMP) return 0.5 * (v / RAMP) * t * t;                    // speeding up
    if (t < T - RAMP) return 0.5 * v * RAMP + v * (t - RAMP);        // cruising
    const r = Math.max(0, T - t); return total - 0.5 * (v / RAMP) * r * r; // slowing down
  }
  // move along the path by `dt`; returns true on arrival
  function advance(a, dt) {
    const path = a.path; if (!path) return true;
    path.t = Math.min(path.T, path.t + dt);
    let s = Math.min(path.total, distanceAt(path, path.t)), i = 0;
    while (i < path.seg.length - 1 && s > path.seg[i]) { s -= path.seg[i]; i++; }
    const A = path.pts[i], B = path.pts[i + 1] || A, len = path.seg[i] || 1;
    const u = Math.min(1, s / len);
    for (let k = path.i + 1; k <= i; k++) if (path.pts[k].key) a.lastNode = path.pts[k].key; // passed these nodes
    path.i = i;
    setXZ(a, A.x + (B.x - A.x) * u, A.z + (B.z - A.z) * u);
    if (B !== A && len > 0.01) a.want = Math.atan2(B.x - A.x, B.z - A.z);
    a.walking = true;
    if (path.t >= path.T) { finishPath(a); return true; }
    return false;
  }
  function finishPath(a) {
    const path = a.path; if (!path) return;
    setXZ(a, path.final[0], path.final[1]);
    a.lastNode = path.destKey; a.path = null; a.walking = false;
  }
  function walkTo(a, target) {
    if (Array.isArray(target)) a.path = makePath(a, L.nearestNode(target[0], target[1]), target);
    else a.path = makePath(a, target, spot(a, target));
  }
  function teleport(a, target) {
    const final = Array.isArray(target) ? target : spot(a, target);
    setXZ(a, final[0], final[1]);
    a.lastNode = Array.isArray(target) ? L.nearestNode(final[0], final[1]) : target;
    a.path = null; a.walking = false;
  }

  // ---------- guards going home, being summoned, escorting ----------
  function sendHome(gd, instant = false) {
    gd.queue = []; gd.attachedTo = null; gd.armRTarget = 0;
    if (instant) { setXZ(gd, gd.home.point[0], gd.home.point[1]); gd.lastNode = gd.home.node; gd.path = null; gd.heading = gd.want = gd.home.heading; gd.g.rotation.y = gd.heading; return; }
    gd.queue.push({ steps: [{ home: true }], i: 0 });
  }
  const atHome = (gd) => dist(pos(gd).x, pos(gd).z, gd.home.point[0], gd.home.point[1]) < 0.3 && !gd.queue.length && !gd.path;
  // a point 1.4 units from the agent, on the side the guard comes from
  function besidePoint(agent, gd) {
    const ap = pos(agent), gp = pos(gd);
    let dx = gp.x - ap.x, dz = gp.z - ap.z; const d = Math.hypot(dx, dz) || 1;
    dx /= d; dz /= d;
    return [ap.x + dx * 1.4, ap.z + dz * 1.4];
  }
  function callGuard(gd, target) { gd.queue = []; gd.path = null; gd.queue.push({ steps: [{ walk: target }], i: 0 }); }
  const guardIdle = (gd) => !gd.queue.length && !gd.path && !gd.attachedTo;
  // An escort that stops early sends its guard home, but only if the guard was already working for THIS robot
  // (while it waits its turn, the guard may still be walking another robot back).
  function releaseGuard(a, st, instant) {
    const gd = st.gd; if (!gd) return;
    if (st.phase !== 'approach' && st.phase !== 'walk') return;
    if (gd.attachedTo === a) gd.attachedTo = null;
    sendHome(gd, instant);
  }

  // ---------- the barrier and the rope ----------
  const liftGate = (key, seconds) => { gateLift[key] = Math.max(gateLift[key] || 0, clock + seconds); };
  // Any actor walking next to a barrier toward or from its bridge lifts it (robots leaving an islet, guards crossing).
  function liftNear(a) {
    const path = a.attachedTo ? a.attachedTo.path : a.path; if (!path) return;
    const k1 = path.pts[path.i]?.key, k2 = path.pts[path.i + 1]?.key;
    for (const key of Object.keys(L.GATES)) {
      if (k1 !== 'bar_' + key && k2 !== 'bar_' + key) continue;
      const G = L.GATES[key], p = pos(a);
      if (dist(p.x, p.z, G.x, G.z) < 2.2) liftGate(key, 1.0);
    }
  }

  // ---------- the steps ----------
  const STEPS = {
    walk: {
      start(a, st) { if (a.frozen || a.hidden) st.skip = true; else walkTo(a, st.step.walk); },
      update(a, st, dt) { return st.skip || advance(a, dt); },
      ff(a, st) { if (!a.frozen) teleport(a, st.step.walk); },
    },
    home: { // guards only: back to the booth, facing the road
      start(a) { a.path = makePath(a, a.home.node, a.home.point); },
      update(a, st, dt) { const done = advance(a, dt); if (done) a.want = a.home.heading; return done; },
      ff(a) { sendHome(a, true); },
    },
    wait: {
      update(a, st, dt) { st.t = (st.t || 0) + dt; return st.t >= st.step.wait; },
      ff() {},
    },
    showId: {
      // round two: the step may carry card: { at, lines }; the HUD shows it as a DOM ID card while the arm is up
      start(a, st) {
        if (a.frozen || !a.powered || !a.card) { st.skip = true; return; }
        a.card.visible = true; a.armLTarget = -2.3;
        if (st.step.card && hooks.idCard) hooks.idCard(a.id, st.step.card);
      },
      update(a, st, dt) {
        if (st.skip) return true;
        st.t = (st.t || 0) + dt;
        if (st.t >= 0.7) { a.card.visible = false; a.armLTarget = 0; return true; }
        return false;
      },
      ff(a) { if (a.card) a.card.visible = false; a.armLTarget = 0; },
    },
    gate: {
      start(a, st) {
        const key = st.step.gate, gt = world.gates?.[key];
        if (gt && hooks.lamp) hooks.lamp(gt.lampMat, st.step.lamp, 2500);
        if (st.step.lamp === 'ok') liftGate(key, 1.6);
        const gd = guards['booth:' + key]; if (gd) { gd.faceAt = a; gd.faceUntil = clock + 1.5; }
      },
      update(a, st, dt) { st.t = (st.t || 0) + dt; return st.t >= 0.35; },
      ff() {},
    },
    escort: {
      start(a, st) { st.gd = guards[st.step.escort.by]; st.phase = st.gd && !a.frozen && !a.hidden ? 'wait_guard' : 'skip'; },
      update(a, st, dt) {
        const gd = st.gd;
        if (st.phase === 'skip') return true;
        if (st.phase === 'wait_guard') { // the guard may still be walking another robot back
          if (gd.attachedTo) return false;
          callGuard(gd, besidePoint(a, gd)); st.phase = 'approach'; return false;
        }
        if (st.phase === 'approach') {
          a.want = Math.atan2(pos(gd).x - pos(a).x, pos(gd).z - pos(a).z); // look at the guard coming
          if (!guardIdle(gd)) return false;
          walkTo(a, st.step.escort.to); gd.attachedTo = a; a.escortedBy = gd; gd.armRTarget = -1.35; st.phase = 'walk';
          return false;
        }
        if (!advance(a, dt)) return false;
        a.escortedBy = null; sendHome(gd); // the robot is delivered; the guard walks back to its booth
        return true;
      },
      ff(a, st) {
        releaseGuard(a, st, true);
        a.escortedBy = null;
        if (!a.frozen && !a.hidden) teleport(a, st.step.escort.to);
      },
    },
    pen: {
      start(a, st) { penOpen = true; st.t = 0; st.phase = 'open'; },
      update(a, st, dt) {
        if (st.phase === 'open') {
          st.t += dt; if (st.t < 0.35) return false;
          if (a.frozen) { penOpen = false; return true; }
          walkTo(a, st.step.pen === 'in' ? 'pen' : 'pen_gate'); st.phase = 'walk'; return false;
        }
        if (st.phase === 'walk') { if (!advance(a, dt)) return false; st.phase = 'close'; st.t = 0; return false; }
        st.t += dt; if (st.t < 0.2) return false;
        penOpen = false; return true;
      },
      ff(a, st) { penOpen = false; if (!a.frozen) teleport(a, st.step.pen === 'in' ? 'pen' : 'pen_gate'); },
    },
    summon: {
      start(a, st) {
        const gd = st.gd = guards[st.step.summon];
        if (!gd) { st.done = true; return; }
        callGuard(gd, st.step.to === 'agent' ? besidePoint(a, gd) : st.step.to);
        st.done = !st.step.wait;
      },
      update(a, st) { return st.done || guardIdle(st.gd); },
      ff(a, st) {
        const gd = guards[st.step.summon]; if (!gd || gd.attachedTo) return;
        gd.queue = []; teleport(gd, st.step.to === 'agent' ? besidePoint(a, gd) : st.step.to);
      },
    },
    dismiss: {
      start(a, st) { const gd = guards[st.step.dismiss]; if (gd && !atHome(gd) && !gd.attachedTo) sendHome(gd); },
      update() { return true; },
      ff(a, st) { const gd = guards[st.step.dismiss]; if (gd && !gd.attachedTo) sendHome(gd, true); },
    },
    spawn: {
      start(a, st) {
        powerUp(a);
        st.fromBelow = a.hidden;
        if (a.hidden) { teleport(a, 'hatch'); a.hidden = false; a.g.visible = true; }
        st.t = 0;
      },
      update(a, st, dt) {
        st.t += dt; const u = Math.min(1, st.t / 0.4);
        const base = groundY(pos(a).x, pos(a).z);
        a.g.position.y = st.fromBelow ? base - 1.2 * (1 - u) * (1 - u) : base + Math.sin(u * PI) * 0.35; // rise, or a hop out of the hatch
        return u >= 1;
      },
      ff(a) { powerUp(a); if (a.hidden) teleport(a, 'hatch'); a.hidden = false; a.g.visible = true; setXZ(a, pos(a).x, pos(a).z); },
    },
    sink: {
      start(a, st) { st.t = 0; st.base = pos(a).y; },
      update(a, st, dt) {
        st.t += dt; const u = Math.min(1, st.t / 0.6);
        a.g.position.y = st.base - 1.4 * u * u;
        if (u >= 1) { a.hidden = true; a.g.visible = false; return true; }
        return false;
      },
      ff(a) { a.hidden = true; a.g.visible = false; },
    },
    fx: {
      start(a, st) { if (hooks.onFx) hooks.onFx(st.step.fx, false); },
      update() { return true; },
      ff(a, st) { if (hooks.onFx) hooks.onFx(st.step.fx, st.quiet ?? true); },
    },
    say: { start(a, st) { if (typeof st.step.say === 'function') st.step.say(false); }, update() { return true; }, ff() {} },
    call: { start(a, st) { if (typeof st.step.call === 'function') st.step.call(false); }, update() { return true; }, ff(a, st) { if (typeof st.step.call === 'function') st.step.call(true); } },
  };
  const kindOf = (step) => Object.keys(STEPS).find((k) => k in step);

  // ---------- the script runner ----------
  // st = the state of the step playing: { step, ...whatever the step keeps }
  function runQueue(a, dt) {
    if (a.attachedTo) return; // a guard on an escort is moved by the robot it walks with
    const speedUp = Math.min(2.5, 1 + 0.75 * (a.queue.length - 1));
    for (let guard = 0; guard < 40; guard++) {
      const sc = a.queue[0]; if (!sc) return;
      const step = sc.steps[sc.i];
      if (!step) { a.queue.shift(); continue; }
      const kind = kindOf(step);
      if (!kind) { sc.i++; continue; } // an unknown step is skipped, never fatal
      if (!sc.st) { sc.st = { step, age: 0 }; STEPS[kind].start?.(a, sc.st); }
      sc.st.age += dt;
      let done = STEPS[kind].update(a, sc.st, dt * speedUp);
      if (!done && sc.st.age > 25) { STEPS[kind].ff(a, sc.st); done = true; } // a stuck step (should not happen) jumps to its end
      if (!done) return;
      sc.i++; sc.st = null;
    }
  }
  // Jump a whole script to its end state (no animation). Its effects still reach the player, marked quiet:
  //   quiet = true       catching up on a backlog: only the state lands (plates, counters, packets, smoke)
  //   quiet = 'skipped'  skipped to keep up with the log: the state lands and the DENIED stamps still show
  function fastForward(a, sc, quiet) {
    for (let i = sc.i; i < sc.steps.length; i++) {
      const step = sc.steps[i], kind = kindOf(step); if (!kind) continue;
      const st = i === sc.i && sc.st ? sc.st : { step };
      st.quiet = quiet;
      STEPS[kind].ff(a, st);
    }
    sc.i = sc.steps.length; sc.st = null;
  }
  // stop where you are: what is left of every script is dropped, except its effects (plates, counters, stamps...)
  // which still reach the player, so the picture's state matches the log
  function halt(id) {
    const a = agents[id]; if (!a) return;
    for (const sc of a.queue) {
      for (let i = sc.i; i < sc.steps.length; i++) {
        const step = sc.steps[i];
        if (step.fx && hooks.onFx && !(i === sc.i && sc.st)) hooks.onFx(step.fx, 'skipped');
        if (step.call && typeof step.call === 'function') step.call(true);
        if (step.pen) penOpen = false;
      }
      if (sc.st && sc.st.step.escort) releaseGuard(a, sc.st, false);
    }
    a.queue = []; a.path = null; a.walking = false; a.escortedBy = null;
    if (a.card) a.card.visible = false; a.armLTarget = 0;
    a.lastNode = L.nearestNode(pos(a).x, pos(a).z);
  }

  function run(id, steps, opts = {}) {
    const a = agents[id] || guards[id];
    if (!a) { // no robot for this agent (an unknown client): play the effects at once, nothing walks
      for (const step of steps || []) if (step.fx && hooks.onFx) hooks.onFx(step.fx, !!opts.instant);
      return;
    }
    const sc = { steps: steps || [], i: 0, st: null };
    if (opts.instant) { for (const old of a.queue) fastForward(a, old, true); a.queue = []; fastForward(a, sc, true); return; }
    a.queue.push(sc);
    while (a.queue.length > 3) { fastForward(a, a.queue[0], 'skipped'); a.queue.shift(); }
  }

  // ---------- plates, power, freeze ----------
  function setPlate(id, plate) {
    const a = agents[id]; if (!a) return;
    const c = PLATE[plate] ?? PLATE.none;
    if (a.plateMat.color.getHex() !== c) a.plateBounce = 0.2;
    a.plateMat.color.setHex(c); a.plateMat.emissive.setHex(c);
    if (plate !== 'stopped' && !a.powered) powerUp(a);
    if (plate === 'none' || plate === 'active') a.frozen = false;
  }
  function powerUp(a) {
    if (a.powered) return;
    a.powered = true; a.eyeMat.color.copy(M.eye.color); a.glints.forEach((gl) => (gl.visible = true));
    if (a.tipMat) a.tipMat.color.copy(M.fl_red.color);
    a.rig.rotation.z = 0; setXZ(a, pos(a).x, pos(a).z);
  }
  function powerDown(id) {
    const a = agents[id]; if (!a || !a.powered) return;
    halt(id); a.frozen = true; a.powered = false;
    a.eyeMat.color.copy(M.eye_off.color); a.glints.forEach((gl) => (gl.visible = false));
    if (a.tipMat) a.tipMat.color.copy(M.lamp_off.color);
    setXZ(a, pos(a).x, pos(a).z); // sinks 0.15 (setXZ lowers a powered-down robot)
    setPlate(id, 'stopped');
    if (hooks.puff) hooks.puff(pos(a).clone().add(new THREE.Vector3(0, 2.6, 0)));
  }
  function freeze(id) { const a = agents[id]; if (!a) return; halt(id); a.frozen = true; }

  function placeAtHatch(a) {
    a.hidden = false; a.g.visible = true; teleport(a, 'hatch'); a.heading = a.want = REST; a.g.rotation.y = REST;
  }
  function reset() {
    for (const a of Object.values(agents)) {
      halt(a.id); a.frozen = false; powerUp(a); setPlate(a.id, 'none'); a.plateBounce = 0; placeAtHatch(a);
    }
    for (const gd of Object.values(guards)) sendHome(gd, true);
    for (const k of Object.keys(gateLift)) delete gateLift[k];
    penOpen = false;
  }

  // ---------- per frame ----------
  function tickActor(a, dt) {
    a.walking = false;
    runQueue(a, dt);
    // facing: travel direction while walking, else the camera (guards: the road, from their booth)
    if (!a.walking && !a.path && !a.attachedTo && !a.queue.length && !a.frozen) {
      if (a.faceUntil > clock && a.faceAt) a.want = Math.atan2(pos(a.faceAt).x - pos(a).x, pos(a.faceAt).z - pos(a).z);
      else if (a.kind === 'guard') a.want = atHome(a) ? a.home.heading : REST;
      else a.want = REST;
    }
    if (!a.frozen || a.attachedTo) a.heading += angleTo(a.heading, a.want) * Math.min(1, dt * 10);
    a.g.rotation.y = a.heading;
  }
  function tickPose(a, t, dt) {
    const moving = a.walking || (a.attachedTo && a.attachedTo.walking);
    a.rig.position.y = moving && a.powered ? Math.abs(Math.sin(t * 9 + (a.slot || 0))) * 0.025 : 0;
    a.armL.rotation.x += (a.armLTarget - a.armL.rotation.x) * Math.min(1, dt * 14);
    a.armR.rotation.x += (a.armRTarget - a.armR.rotation.x) * Math.min(1, dt * 10);
    if (a.plate) { a.plateBounce = Math.max(0, a.plateBounce - dt); a.plate.scale.setScalar(1 + Math.sin((a.plateBounce / 0.2) * PI) * 0.35); }
    if (!a.powered) a.rig.rotation.z += (0.105 - a.rig.rotation.z) * Math.min(1, dt * 6); // a 6 degree slump
  }
  // The guard on an escort walks half a unit behind the robot and a little to its side, arm out toward it.
  // (Both robots are 1.2 deep, so "half a unit behind" is 1.35 between centres.) It eases into place, never jumps.
  function tickEscort(gd, dt) {
    const a = gd.attachedTo; if (!a) return;
    const h = a.heading, p = pos(a), q = pos(gd), k = Math.min(1, dt * 6);
    const tx = p.x - Math.sin(h) * 1.35 + Math.cos(h) * 0.5, tz = p.z - Math.cos(h) * 1.35 - Math.sin(h) * 0.5;
    setXZ(gd, q.x + (tx - q.x) * k, q.z + (tz - q.z) * k);
    gd.want = h; gd.heading += angleTo(gd.heading, h) * Math.min(1, dt * 8); gd.g.rotation.y = gd.heading;
    gd.lastNode = a.lastNode;
  }
  function tick(t, dt) {
    clock = t;
    for (const a of Object.values(agents)) tickActor(a, dt);
    for (const gd of Object.values(guards)) tickActor(gd, dt);
    for (const gd of Object.values(guards)) tickEscort(gd, dt);
    for (const a of [...Object.values(agents), ...Object.values(guards)]) { tickPose(a, t, dt); if (a.walking || a.attachedTo) liftNear(a); }
    // barriers ease up and down (rotation.z: 0 down, -1.25 lifted); the rope gate swings open and shut
    for (const key of Object.keys(L.GATES)) {
      const bar = world.gates?.[key]?.barrier; if (!bar) continue;
      const target = (gateLift[key] || 0) > clock ? -1.25 : 0;
      bar.rotation.z += (target - bar.rotation.z) * Math.min(1, dt * 7);
    }
    const rope = world.pen?.gate;
    if (rope) rope.rotation.y += ((penOpen ? -1.5 : 0) - rope.rotation.y) * Math.min(1, dt * 6); // world.js: 0 shut, -1.5 open
  }

  function screenOf(id) {
    const a = agents[id] || guards[id]; if (!a || a.hidden) return null;
    return new THREE.Vector3(pos(a).x, pos(a).y + HEAD_TOP, pos(a).z);
  }

  // four booth guards (facing the road through the open side of the booth) and the chief at the gatehouse
  // (created last: they use the walking helpers above)
  for (const key of Object.keys(L.GATES)) {
    const G = L.GATES[key];
    const home = world.gates?.[key]?.guardHome || G.booth;
    addGuard('booth:' + key, home, 'booth_' + key, Math.atan2(-G.perp[0], -G.perp[1]));
  }
  // the chief's booth faces chief_door (buildings.js), so that is the node the chief leaves from and comes back to
  addGuard('chief', places?.gatehouse?.chiefBooth?.guardHome || L.GATEHOUSE.chiefBooth, 'chief_door', 0);

  return {
    addAgent, has: (id) => !!agents[id], agents, guards,
    run, halt, freeze, setPlate, powerDown, reset, tick, screenOf,
    busy: (id) => !!(agents[id] && (agents[id].queue.length || agents[id].path)),
    hooks,
  };
}
