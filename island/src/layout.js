// Every coordinate of the archipelago in one place (docs/ISLAND_V2.md section 1), plus the waypoint graph the robots
// and guards walk on. x is screen-right, z is toward the camera (south), y is up. Scene units: one terrain tile = 1.
// world.js and buildings.js build FROM these numbers; actors.js walks ON them. Change a number here, nothing else.

// ---------- islands ----------
export const ISLANDS = {
  main:   { x: 0,   z: 0,   r: 10,  noise: 0.9, name: 'the harbour' },
  files:  { x: -23, z: 0,   r: 6.5, noise: 0.6, name: 'Files' },
  admin:  { x: 23,  z: 0,   r: 5.5, noise: 0.6, name: 'Admin' },
  mail:   { x: -19, z: -16, r: 5.5, noise: 0.6, name: 'Mail' },
  github: { x: 20,  z: -16, r: 5.5, noise: 0.6, name: 'GitHub' },
  // build 3 (docs/BUILD3.md section 4): the Factory island, due south, reached by a bridge with no gate
  // (the brief said (0, 27); measured at 1280x720 with the build-3 HUD, (6, 25) keeps the whole Factory clear of the
  // agent card bottom-left at a 15 percent closer zoom than (0, 27) allows; everything on it is placed relative to this)
  factory: { x: 6,  z: 25,  r: 9.5, noise: 0.5, name: 'Factory' },
};

// ---------- bridges: from the main island to each islet, along the line between the centres ----------
// deck endpoints are the two shore points inset by `inset` so the planks overlap the land.
const unit = (ax, az, bx, bz) => { const L = Math.hypot(bx - ax, bz - az); return [(bx - ax) / L, (bz - az) / L, L]; };
function shore(a, b, inset = 0.4) {
  const [ux, uz] = unit(a.x, a.z, b.x, b.z);
  return { from: [a.x + ux * (a.r - inset), a.z + uz * (a.r - inset)], to: [b.x - ux * (b.r - inset), b.z - uz * (b.r - inset)], dir: [ux, uz] };
}
export const BRIDGES = {};
for (const key of ['files', 'admin', 'mail', 'github']) {
  const s = shore(ISLANDS.main, ISLANDS[key]);
  const mid = [(s.from[0] + s.to[0]) / 2, (s.from[1] + s.to[1]) / 2];
  BRIDGES[key] = { key, from: s.from, to: s.to, mid, dir: s.dir, width: 1.6, length: Math.hypot(s.to[0] - s.from[0], s.to[1] - s.from[1]) };
}
// the Factory bridge: from the main island's south shore straight south to the Factory's north shore; no gate (the
// Factory is the operator's own ground), an iron arch reading FACTORY at its south end instead
{
  const s = shore(ISLANDS.main, ISLANDS.factory);
  BRIDGES.factory = { key: 'factory', from: s.from, to: s.to, mid: [(s.from[0] + s.to[0]) / 2, (s.from[1] + s.to[1]) / 2], dir: s.dir, width: 1.6,
    length: Math.hypot(s.to[0] - s.from[0], s.to[1] - s.from[1]), noGate: true };
}
export const TOOL_ISLETS = ['files', 'admin', 'mail', 'github']; // the four islets that hold tools (each has a gate)

// ---------- gates: at the main-island end of each bridge, one unit inland of the shore ----------
// `side` is the perpendicular (to the right of the walking direction, seen from above) on which the booth stands;
// the pen and the bin sit south of the W/E bridges, so those booths go north (W) and south (E) to stay clear.
const perp = ([ux, uz]) => [-uz, ux]; // rotate the direction 90° (right-hand side when walking outward)
export const GATES = {};
for (const key of TOOL_ISLETS) {
  const b = BRIDGES[key], [ux, uz] = b.dir, [px, pz] = perp(b.dir);
  const boothSide = { files: 1, admin: -1, mail: -1, github: 1 }[key]; // files: north; admin: south; mail: west; github: east (all away from the pen, the bin and the gatehouse)
  const gx = b.from[0] - ux * 1.0, gz = b.from[1] - uz * 1.0;         // the barrier line, one unit inland
  GATES[key] = {
    key, x: gx, z: gz, dir: [ux, uz], perp: [px * boothSide, pz * boothSide],
    stop: [gx - ux * 1.3, gz - uz * 1.3],                                 // where a robot halts to show its ID
    queue: [gx - ux * 2.6, gz - uz * 2.6],                                // a second robot waits here
    booth: [gx + px * boothSide * 1.7, gz + pz * boothSide * 1.7],         // booth centre (1.2 x 1.2 footprint)
    boothDoor: [gx + px * boothSide * 1.0, gz + pz * boothSide * 1.0],     // where the guard steps out
    sign: [gx - px * boothSide * 1.1, gz - pz * boothSide * 1.1],          // the tool signboard, on the far post
  };
}
// which gate guards which tool (tools/list is the gatehouse window)
export const GATE_OF_TOOL = { read_file: 'files', search_files: 'files', create_issue: 'github', list_issues: 'github', send_email: 'mail', delete_file: 'admin' };

// ---------- the main island's furniture ----------
// Integrator: chiefBooth was [-4.8, -2.9]; a booth there stood across the walk from plaza_w to the Mail gate, so world.js
// builds it at [-6.6, -2.3] (CHIEF_BOOTH). The number here now says where it really is.
export const GATEHOUSE = { x: 0, z: -5.5, w: 7.2, d: 4.5, h: 4.2, window: [0, -2.3], chiefBooth: [-6.6, -2.3], chiefDoor: [-4.0, -2.2], roofTop: [0, 7.3, -5.5] };
// build 3: the dock moved to the south-west shore (the south shore now belongs to the Factory bridge). The pier points
// south-west along `dir`; `root` is where it leaves the land, the hatch sits near its outer end.
export const DOCK = { x: -6.5, z: 9, hatch: [-7.2, 9.8], root: [-5.5, 7.8], dir: [-Math.SQRT1_2, Math.SQRT1_2], pierLength: 3.2 };
export const PEN = { x: 6.5, z: 4, w: 3.0, d: 3.0, gate: [5.0, 4.0], spots: [[6.0, 3.4], [7.1, 4.6], [7.1, 3.4], [6.0, 4.6]], lamp: [6.5, 2.3] };
export const BIN = { x: -6.5, z: 4 };
// six agents now (build 3): the first two keep their old spots, four more stand a step behind them
export const PLAZA = { spots: [[-1.6, 1.4], [1.6, 1.4], [-1.7, 3.0], [1.7, 3.0], [-3.1, 2.1], [3.1, 2.1]] };

// door spots: 2.7 units from each islet's centre toward its bridge (the buildings face their bridge)
export const DOORS = {};
for (const key of TOOL_ISLETS) {
  const isl = ISLANDS[key], [ux, uz] = BRIDGES[key].dir; // dir points from main toward the islet; the door faces back (-dir)
  const dist = key === 'files' ? 3.4 : 2.7;
  DOORS[key] = { x: isl.x - ux * dist, z: isl.z - uz * dist, facing: [-ux, -uz] };
}

// ---------- the Factory (build 3, docs/BUILD3.md section 4) ----------
// The camera looks from the south-east: a face pointing north is never seen, and anything tall hides what stands
// north-west of it (up to about 1.5 times its height away). Measured in screenshots, so: the hall stands on the
// island's west side with its big double door facing EAST (the brief said north; a north door, and a yard north of the
// hall, would both be hidden by the hall itself); the yard lies between the door and the bridge; the inspection bay
// (tall: its roof and its screen) is at the south-east corner where only the hall's far end is behind it, never the
// door, the yard or the bridge; the two chimneys rise at the hall's south-east corner, behind which is only the hall.
//   hall:  the brick hall's footprint (x0..x1, z0..z1), door on its east face at `door`, the loading ramp south of it
//   yard:  four painted parking squares; the robot of slot n waits on spots[n % 4]
//   bay:   the open shed; lift = the round platform (one robot), beside = a second robot outside, gate = the approach,
//          screenAnchor = the top edge of the tall screen (scene.bayScreen() turns it into a screen point)
//   cartHome: where the cart parks, by the ramp; arch: the FACTORY arch over the bridge's south end
const FC = [ISLANDS.factory.x, ISLANDS.factory.z];             // the Factory island's centre
const fp = (dx, dz) => [FC[0] + dx, FC[1] + dz];                // a point on it, relative to the centre
const FB = BRIDGES.factory, alongFB = (d) => [FB.to[0] + FB.dir[0] * d, FB.to[1] + FB.dir[1] * d]; // along the bridge, past its south end
export const FACTORY = {
  hall: (() => { const [x, z] = fp(-3.6, 0.6); return { x, z, w: 7, d: 11, x0: x - 3.5, x1: x + 3.5, z0: z - 5.5, z1: z + 5.5, h: 3.6, ramp: z + 0.6 }; })(),
  door: fp(-0.1, -2.0),                     // the middle of the double door, on the hall's east face
  floorSign: fp(0.04, -3.9),                // the FLOOR plaque on the east wall, north of the door (click -> the Factory floor room)
  yard: { ...(([x, z]) => ({ x, z }))(fp(3.4, -4.5)), w: 4.4, d: 3.8, spots: [fp(2.4, -5.4), fp(4.0, -5.4), fp(2.8, -3.6), fp(4.4, -3.6)], lamp: fp(1.4, -6.9) },
  bay: { ...(([x, z]) => ({ x, z }))(fp(2.0, 6.0)), w: 3.4, d: 3.4, lift: fp(2.0, 6.0), beside: fp(4.6, 5.4), gate: fp(3.6, 1.2),
    screen: fp(1.2, 5.2), screenAnchor: [FC[0] + 1.2, 9.0, FC[1] + 5.2], roofY: 6.1 },
  cartHome: fp(1.5, 3.4),
  arch: alongFB(0.4),
  chimneys: [fp(-0.9, 5.2), fp(-2.1, 5.4)],
};

// ---------- the waypoint graph ----------
// nodes: [x, z]; edges: undirected. Robots only ever walk along edges, so they never cut through a building or off a bridge.
export const NODES = {
  hatch: DOCK.hatch, dock: [-4.9, 7.2], plaza_s: [0, 6.0], plaza: [0, 1.6],
  gh_window: GATEHOUSE.window, chief_door: GATEHOUSE.chiefDoor,
  pen_gate: [PEN.gate[0] - 0.8, PEN.gate[1]], pen_in: [PEN.x - 0.4, PEN.z],
  bin: [BIN.x + 1.2, BIN.z],
  plaza_w: [-4.6, -0.6], plaza_e: [4.6, -0.6], // past the gatehouse's front corners, on the way to the two north gates
};
export const EDGES = [['hatch', 'dock'], ['dock', 'plaza_s'], ['plaza_s', 'plaza'], ['plaza', 'gh_window'], ['gh_window', 'chief_door'],
  ['plaza_s', 'pen_gate'], ['pen_gate', 'pen_in'], ['plaza_s', 'bin'], ['plaza', 'pen_gate'], ['plaza', 'plaza_w'], ['plaza', 'plaza_e'], ['chief_door', 'plaza_w']];
// the Factory: plaza_s -> over the bridge -> under the arch -> the yard; from the yard to the hall door, the bay, the cart
Object.assign(NODES, {
  bridge_factory: BRIDGES.factory.mid, arch: alongFB(0.8), shore_factory: alongFB(1.9), yard: fp(1.2, -5.2),
  factory_door: [FACTORY.door[0] + 1.1, FACTORY.door[1]], bay_gate: FACTORY.bay.gate, bay_lift: FACTORY.bay.lift,
  cart_home: FACTORY.cartHome,
});
EDGES.push(['plaza_s', 'bridge_factory'], ['bridge_factory', 'arch'], ['arch', 'shore_factory'], ['shore_factory', 'yard'],
  ['yard', 'factory_door'], ['factory_door', 'bay_gate'], ['bay_gate', 'bay_lift'], ['cart_home', 'bay_gate']);
FACTORY.yard.spots.forEach((p, i) => { NODES[`yard_${i}`] = p; EDGES.push(['yard', `yard_${i}`]); });
for (const key of Object.keys(GATES)) {
  const g = GATES[key], b = BRIDGES[key], d = DOORS[key];
  NODES[`gate_${key}`] = g.stop;
  NODES[`bar_${key}`] = [g.x + g.dir[0] * 0.6, g.z + g.dir[1] * 0.6];          // just past the barrier
  NODES[`bridge_${key}`] = b.mid;
  NODES[`shore_${key}`] = [b.to[0] + b.dir[0] * 0.8, b.to[1] + b.dir[1] * 0.8];
  NODES[`door_${key}`] = [d.x, d.z];
  NODES[`booth_${key}`] = g.booth;
  NODES[`boothdoor_${key}`] = g.boothDoor;
  const hub = { files: 'plaza', admin: 'plaza', mail: 'plaza_w', github: 'plaza_e' }[key];
  EDGES.push([hub, `gate_${key}`], [`gate_${key}`, `bar_${key}`], [`bar_${key}`, `bridge_${key}`], [`bridge_${key}`, `shore_${key}`], [`shore_${key}`, `door_${key}`],
    [`booth_${key}`, `boothdoor_${key}`], [`boothdoor_${key}`, `gate_${key}`]);
}
// (no chief_booth node: the chief walks home from chief_door to the booth's own point, see actors.js; a node inside the
// booth would let nearestNode() route a robot that stopped nearby straight through the booth's walls)

const ADJ = {};
for (const [a, b] of EDGES) { (ADJ[a] ||= new Set()).add(b); (ADJ[b] ||= new Set()).add(a); }

// Shortest path (by node count, then by length) between two node keys; returns node keys including both ends.
export function route(fromKey, toKey) {
  if (fromKey === toKey) return [fromKey];
  const prev = { [fromKey]: null }, q = [fromKey];
  while (q.length) {
    const n = q.shift();
    for (const m of ADJ[n] || []) if (!(m in prev)) { prev[m] = n; if (m === toKey) { const out = [m]; let c = m; while (prev[c]) { c = prev[c]; out.unshift(c); } return out; } q.push(m); }
  }
  return [fromKey, toKey]; // unknown nodes: walk straight (should not happen)
}
export const pointOf = (key) => NODES[key];
export const nearestNode = (x, z) => { let best = null, bd = Infinity; for (const [k, [nx, nz]] of Object.entries(NODES)) { const d = Math.hypot(nx - x, nz - z); if (d < bd) { bd = d; best = k; } } return best; };

// Agents share every place; slot 0 (Research Bot) and slot 1 (Ops Bot) stand side by side, never on top of each other.
// Build 3: up to six agents (slots 0..5); slots 2..5 stand a row behind the first two.
// 'bay' / 'bay_lift': the lift holds one robot, a second stands beside it. Without `liftTaken` slot 0 gets the lift;
// actors.js passes liftTaken (is another robot already on the lift?) so whoever arrives first stands on it.
export function spotOf(slot, place, liftTaken = null) {
  const s2 = slot % 2, row = Math.floor((slot % 6) / 2); // side (0 left, 1 right) and row (0, 1, 2)
  if (place === 'plaza') return PLAZA.spots[slot % PLAZA.spots.length];
  if (place === 'pen') return PEN.spots[slot % PEN.spots.length];
  if (place === 'yard') return FACTORY.yard.spots[slot % 4];
  if (place === 'bay' || place === 'bay_lift') return (liftTaken === null ? slot === 0 : !liftTaken) ? FACTORY.bay.lift : FACTORY.bay.beside;
  if (place === 'hatch') { // across the pier (perpendicular to DOCK.dir), further rows along the pier
    const [ux, uz] = DOCK.dir, side = s2 ? 0.9 : -0.9, out = [0, -1.3, 1.3][row];
    return [DOCK.hatch[0] - uz * side + ux * out, DOCK.hatch[1] + ux * side + uz * out];
  }
  if (place.startsWith('door_')) {
    const d = DOORS[place.slice(5)]; if (!d) return NODES[place] || [0, 0];
    const [fx, fz] = d.facing, side = s2 ? 0.7 : -0.7, back = [0, 1.3, 2.4][row];
    return [d.x + fz * side + fx * back, d.z - fx * side + fz * back];
  }
  if (place.startsWith('gate_')) { const g = GATES[place.slice(5)]; if (!g) return NODES[place] || [0, 0]; return slot ? g.queue : g.stop; }
  if (place === 'gh_window') return [GATEHOUSE.window[0] + [-1.0, 1.0, -2.3, 2.3, -1.0, 1.0][slot % 6], GATEHOUSE.window[1] + (slot % 6 >= 4 ? 1.3 : 0)];
  return NODES[place] || [0, 0];
}

// camera framing for the whole archipelago (docs/ISLAND_V2.md section 1)
// Integrator, 2026-11-07: radius 29 / target [0,-1.5,-3] cut the FILES tower top and the Mail islet off the top of a
// 1280x720 screen. Measured in the browser: radius 34 aimed at [1, 2, -6] keeps the tower tip (y 26), the Mail cottage,
// the GitHub islet's edge and the Admin islet's near cliff on screen, with no door or gate under a HUD panel.
// Build 3: a screen narrower than 1.6:1 (800x600, 1024x768) has the same pixel-sized HUD panels over a bigger share of
// the picture, so scene.js switches to `narrow` there (measured at 800x600 the same way).
export const FRAMING = { target: [4, 2, 2], radius: 45, minZoom: 0.7, maxZoom: 3, narrow: { below: 1.6, target: [-5, 2, 2], radius: 50 } }; // build 3, measured with the build-3 HUD at 1280x720 (scratchpad frame.mjs + screenshots): every gate, door, yard spot, the bay and the cart clear of the panels
