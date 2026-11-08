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

// ---------- gates: at the main-island end of each bridge, one unit inland of the shore ----------
// `side` is the perpendicular (to the right of the walking direction, seen from above) on which the booth stands;
// the pen and the bin sit south of the W/E bridges, so those booths go north (W) and south (E) to stay clear.
const perp = ([ux, uz]) => [-uz, ux]; // rotate the direction 90° (right-hand side when walking outward)
export const GATES = {};
for (const key of Object.keys(BRIDGES)) {
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
export const DOCK = { x: 0, z: 11, hatch: [0, 11.6], pierLength: 3.2 };
export const PEN = { x: 6.5, z: 4, w: 3.0, d: 3.0, gate: [5.0, 4.0], spots: [[6.0, 3.4], [7.1, 4.6]], lamp: [6.5, 2.3] };
export const BIN = { x: -6.5, z: 4 };
export const PLAZA = { spots: [[-1.6, 1.4], [1.6, 1.4]] };

// door spots: 2.7 units from each islet's centre toward its bridge (the buildings face their bridge)
export const DOORS = {};
for (const key of Object.keys(BRIDGES)) {
  const isl = ISLANDS[key], [ux, uz] = BRIDGES[key].dir; // dir points from main toward the islet; the door faces back (-dir)
  const dist = key === 'files' ? 3.4 : 2.7;
  DOORS[key] = { x: isl.x - ux * dist, z: isl.z - uz * dist, facing: [-ux, -uz] };
}

// ---------- the waypoint graph ----------
// nodes: [x, z]; edges: undirected. Robots only ever walk along edges, so they never cut through a building or off a bridge.
export const NODES = {
  hatch: DOCK.hatch, dock: [0, 9.6], plaza_s: [0, 6.0], plaza: [0, 1.6],
  gh_window: GATEHOUSE.window, chief_door: GATEHOUSE.chiefDoor,
  pen_gate: [PEN.gate[0] - 0.8, PEN.gate[1]], pen_in: [PEN.x - 0.4, PEN.z],
  bin: [BIN.x + 1.2, BIN.z],
  plaza_w: [-4.6, -0.6], plaza_e: [4.6, -0.6], // past the gatehouse's front corners, on the way to the two north gates
};
export const EDGES = [['hatch', 'dock'], ['dock', 'plaza_s'], ['plaza_s', 'plaza'], ['plaza', 'gh_window'], ['gh_window', 'chief_door'],
  ['plaza_s', 'pen_gate'], ['pen_gate', 'pen_in'], ['plaza_s', 'bin'], ['plaza', 'pen_gate'], ['plaza', 'plaza_w'], ['plaza', 'plaza_e'], ['chief_door', 'plaza_w']];
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

// Two agents share every place; slot 0 (Research Bot) and slot 1 (Ops Bot) stand side by side, never on top of each other.
export function spotOf(slot, place) {
  if (place === 'plaza') return PLAZA.spots[slot % 2];
  if (place === 'pen') return PEN.spots[slot % 2];
  if (place === 'hatch') return [DOCK.hatch[0] + (slot ? 0.9 : -0.9), DOCK.hatch[1]];
  if (place.startsWith('door_')) { const key = place.slice(5), d = DOORS[key], [fx, fz] = d.facing; return [d.x + fz * (slot ? 0.7 : -0.7), d.z - fx * (slot ? 0.7 : -0.7)]; }
  if (place.startsWith('gate_')) { const g = GATES[place.slice(5)]; return slot ? g.queue : g.stop; }
  if (place === 'gh_window') return [GATEHOUSE.window[0] + (slot ? 1.0 : -1.0), GATEHOUSE.window[1]];
  return NODES[place] || [0, 0];
}

// camera framing for the whole archipelago (docs/ISLAND_V2.md section 1)
// Integrator, 2026-11-07: radius 29 / target [0,-1.5,-3] cut the FILES tower top and the Mail islet off the top of a
// 1280x720 screen. Measured in the browser: radius 34 aimed at [1, 2, -6] keeps the tower tip (y 26), the Mail cottage,
// the GitHub islet's edge and the Admin islet's near cliff on screen, with no door or gate under a HUD panel.
export const FRAMING = { target: [1, 2, -6], radius: 34, minZoom: 0.7, maxZoom: 3 };
