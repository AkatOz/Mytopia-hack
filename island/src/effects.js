// Things that fly, fall, blink or smoke in the 3D world: the paper slips that carry each decision to the ledger, the red
// packets that land in the BLOCKED bin, the lamps that blink for 2.5 s, the smoke ladder over a booth, the grey puff of
// a robot powering down. It only knows HOW to draw; the reducer decides WHEN (docs/ISLAND_V2.md section 4).
// Pre-existing: the blocky smoke puffs and the falling packets come from v1's scene.js (Mytopia's smoke recipe). New
// today: slips on a raised arc, lamps on any material with a timeout, the ladder moved from buildings to gate booths.
export function createEffects(ctx, world, places) {
  const { THREE, kit, L } = ctx;
  const { M, gBox, put } = kit;
  const root = world.world;
  let clock = 0; // seconds, from tick()

  const shade = (o) => { o.traverse((m) => { if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } }); return o; };
  const edgeOk = M.slip_edge_ok || kit.mat('slip_edge_ok', 0x3f8a56); // sage edge on an allowed slip
  const edgeBad = M.stripe_red;                                        // brick edge on a refused slip

  // ---------- slips: a sheet of paper flies from where the decision happened to the gatehouse roof ----------
  // The brief says 0.3 x 0.4; at the half-resolution render that is 3 pixels, so the sheet is drawn 1.6x bigger.
  const slips = [];
  function slip(from, to, ok) {
    return new Promise((resolve) => {
      if (!from || !to) { resolve(); return; }
      const g = new THREE.Group(); g.name = ok ? 'slip_ok' : 'slip_bad';
      put(g, gBox(0.48, 0.04, 0.64), ok ? edgeOk : edgeBad, 'slip_edge', 0, 0, 0);
      put(g, gBox(0.38, 0.05, 0.54), ok ? M.slip_ok : M.slip_bad, 'slip_paper', 0, 0.01, 0);
      put(g, gBox(0.26, 0.055, 0.04), M.ink, 'slip_line', 0, 0.02, -0.12);
      put(g, gBox(0.2, 0.055, 0.04), M.ink, 'slip_line', 0, 0.02, 0.0);
      g.position.copy(from); root.add(shade(g));
      const mid = from.clone().lerp(to, 0.5);
      mid.y = Math.max(from.y, to.y) + 2.5 + from.distanceTo(to) * 0.08;
      slips.push({ g, from: from.clone(), mid, to: to.clone(), t: 0, dur: 1.0, resolve });
    });
  }
  const bez = (a, b, c, u) => (1 - u) * (1 - u) * a + 2 * (1 - u) * u * b + u * u * c;
  function tickSlips(dt) {
    for (let i = slips.length - 1; i >= 0; i--) {
      const s = slips[i];
      s.t = Math.min(1, s.t + dt / s.dur);
      const u = s.t < 0.5 ? 2 * s.t * s.t : 1 - 2 * (1 - s.t) * (1 - s.t); // ease in and out
      s.g.position.set(bez(s.from.x, s.mid.x, s.to.x, u), bez(s.from.y, s.mid.y, s.to.y, u), bez(s.from.z, s.mid.z, s.to.z, u));
      s.g.rotation.set(Math.sin(u * 6) * 0.35, u * 5, Math.cos(u * 5) * 0.25); // a sheet of paper flutters
      if (s.t >= 1) { root.remove(s.g); slips.splice(i, 1); s.resolve(); }
    }
  }

  // ---------- packets: one red packet per refusal drops into the BLOCKED bin (3 x 2 per layer, two layers, 12 max) ----------
  const stack = world.bin.stack;
  function packet(quiet = false) {
    if (stack.length >= 12) return false; // the bin is full; the DOM count keeps counting
    const i = stack.length, layer = Math.floor(i / 6), col = i % 3, row = Math.floor(i / 3) % 2;
    const d = world.bin.dropPoint;
    const restY = d.y + 0.1 + layer * 0.2;
    const p = put(root, gBox(0.28, 0.2, 0.28), M.packet, 'packet', d.x - 0.36 + col * 0.36, quiet ? restY : restY + 3.2, d.z - 0.18 + row * 0.36);
    p.castShadow = true;
    p.userData.restY = restY;
    if (!quiet) p.userData.vy = 0; // it falls in
    stack.push(p);
    return true;
  }
  function tickPackets(dt) {
    for (const p of stack) {
      const u = p.userData; if (u.vy === undefined) continue;
      u.vy -= 14 * dt; p.position.y += u.vy * dt; p.rotation.y += dt * 4;
      if (p.position.y <= u.restY) { p.position.y = u.restY; p.rotation.y = 0; delete u.vy; }
    }
  }

  // ---------- lamps: any lamp material shows ok (green) or bad (red) for a while, then goes back to off (grey) ----------
  const lampOff = new Map(); // material -> clock time to switch off
  function paint(mat, kind) {
    const src = M['lamp_' + kind] || M.lamp_off;
    mat.color.copy(src.color); mat.emissive.copy(src.emissive); mat.emissiveIntensity = src.emissiveIntensity;
  }
  function lamp(mat, kind, ms = 2500) {
    if (!mat || !mat.color) return;
    paint(mat, kind);
    if (kind === 'off') lampOff.delete(mat); else lampOff.set(mat, clock + ms / 1000);
  }
  function tickLamps() {
    for (const [mat, until] of lampOff) if (clock >= until) { paint(mat, 'off'); lampOff.delete(mat); }
  }

  // ---------- the smoke ladder over a gate's booth (repeated refusals at the same gate) ----------
  const SMOKE = ['#5d5650', '#8a837b', '#b3aca2', '#ddd6ca'];
  const ladders = {}; // gate key -> { rung, base: Vector3, puffs: [{ p, ph }] }
  function ladderFor(key) {
    if (ladders[key]) return ladders[key];
    const b = L.GATES[key].booth;
    const lad = ladders[key] = { rung: 0, base: new THREE.Vector3(b[0], 2.7, b[1]), puffs: [] };
    for (let i = 0; i < 6; i++) {
      const m = new THREE.MeshStandardMaterial({ color: SMOKE[2], roughness: 1, flatShading: true, transparent: true, opacity: 0.85 });
      const p = put(root, gBox(1, 1, 1), m, 'smoke_puff'); p.visible = false;
      lad.puffs.push({ p, ph: i / 6 });
    }
    return lad;
  }
  function smoke(gateKey, rung) { if (L.GATES[gateKey]) ladderFor(gateKey).rung = Math.max(0, Math.min(2, rung | 0)); }
  function clearSmoke() { for (const lad of Object.values(ladders)) lad.rung = 0; }
  function tickSmoke(t) {
    for (const lad of Object.values(ladders)) {
      const n = lad.rung === 2 ? 6 : lad.rung === 1 ? 3 : 0;
      lad.puffs.forEach((pf, i) => {
        const on = i < n; pf.p.visible = on; if (!on) return;
        const u = (t * 0.28 + pf.ph) % 1, sz = 0.16 + u * (lad.rung === 2 ? 0.5 : 0.3);
        pf.p.position.set(lad.base.x + Math.sin(u * 5 + i) * 0.35 + u * 0.6, lad.base.y + u * 2.6, lad.base.z + Math.cos(u * 4 + i) * 0.3);
        pf.p.scale.setScalar(Math.round(sz / 0.08) * 0.08); // snapped sizes: blocky, Mytopia style
        pf.p.material.color.set(SMOKE[lad.rung === 2 ? Math.min(3, Math.floor(u * 4)) : 2 + Math.floor(u * 2)]);
        pf.p.material.opacity = 0.9 * (1 - u);
      });
    }
  }

  // ---------- one grey puff (a robot powering down) ----------
  const puffs = [];
  function puff(at) {
    if (!at) return;
    for (let i = 0; i < 4; i++) {
      const m = new THREE.MeshStandardMaterial({ color: SMOKE[1 + (i % 2)], roughness: 1, flatShading: true, transparent: true, opacity: 0.9 });
      const p = put(root, gBox(1, 1, 1), m, 'power_puff', at.x, at.y, at.z);
      puffs.push({ p, t: 0, dx: Math.cos(i * 1.7) * 0.3, dz: Math.sin(i * 1.7) * 0.3, delay: i * 0.12 });
    }
  }
  function tickPuffs(dt) {
    for (let i = puffs.length - 1; i >= 0; i--) {
      const f = puffs[i]; f.t += dt;
      const u = Math.max(0, f.t - f.delay) / 1.3;
      f.p.position.x += f.dx * dt; f.p.position.z += f.dz * dt; f.p.position.y += (u > 0 ? 1.4 : 0) * dt;
      f.p.scale.setScalar(Math.round((0.2 + u * 0.4) / 0.08) * 0.08);
      f.p.material.opacity = 0.9 * Math.max(0, 1 - u);
      if (u >= 1) { root.remove(f.p); f.p.material.dispose(); puffs.splice(i, 1); }
    }
  }

  // ---------- reset (page reload does this anyway; kept for a new chain) ----------
  function reset() {
    for (const s of slips.splice(0)) { root.remove(s.g); s.resolve(); }
    for (const p of stack.splice(0)) root.remove(p);
    for (const f of puffs.splice(0)) root.remove(f.p);
    for (const mat of [...lampOff.keys()]) paint(mat, 'off');
    lampOff.clear();
    clearSmoke();
  }

  function tick(t, dt) {
    clock = t;
    tickSlips(dt); tickPackets(dt); tickLamps(); tickSmoke(t); tickPuffs(dt);
  }

  return { slip, packet, lamp, smoke, clearSmoke, puff, reset, tick };
}
