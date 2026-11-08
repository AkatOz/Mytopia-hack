// The interiors (docs/BUILD3.md section 5, builder B2): every building opens into a cutaway room in 3D that the camera
// orbits freely. room.js (the ledger room of build 2) folds in here: its shell, clerk, desk, stamp and the camera
// save/restore are kept; its DOM overlays are gone. All text in the rooms is painted on hi-res canvas textures
// (2048 px wide boards, VT323 and Pixelify Sans, drawn after document.fonts.ready) so it stays readable at any angle.
//
// Two halves:
//   1. pure line builders (no DOM, no three.js): linesForLedger, chainExhibit, tamperCopy, linesForWorkshop,
//      linesForWhiteboard, linesForFloor, rowAt. node --test reads these (island/tests/rooms.test.mjs).
//   2. createRooms(ctx, hooks): the 3D rooms; paint() draws the lines on canvases.
//
// Rooms: gatehouse | files | github | mail | admin | factory_office | factory_floor. Nothing here decides anything:
// every board is drawn from hooks.getLog() (rows of GET /events) and hooks.getRoster() (GET /agents).
import { verifyChain } from './ledger.js';
import { gatewayStats, ALL_TOOLS, DEFAULT_ROSTER } from './reducer.js';
import { TIERS, TIER_ORDER, inferTier, tierFor, ROBOT_COLORS } from './tiers.js';

export const ROOM_KEYS = ['gatehouse', 'files', 'github', 'mail', 'admin', 'factory_office', 'factory_floor'];

// ---------- palette (Mytopia: chalk and paper, sage ok, brick bad, mustard highlight; no neon) ----------
const CHALK = { bg: '#2f3a33', ink: '#efe6cf', dim: '#a9a28f', ok: '#a9d0a0', bad: '#e8a08c', hi: '#e7c56a', admin: '#e7c56a' };
const PAPER = { bg: '#fbf7ee', ink: '#3a312b', dim: '#8a7d70', ok: '#5f8f5a', bad: '#b4553e', hi: '#c8962c', admin: '#c8962c' };
const VT = '"VT323", monospace', PX = '"Pixelify Sans", "VT323", monospace';

// ---------- small helpers ----------
const hexOf = (t) => (TIERS[t] ? TIERS[t].hex : '#9a9a92');
const tierName = (t) => (TIERS[t] ? TIERS[t].name : 'Bronze');
const short = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
export const lineText = (l) => (typeof l === 'string' ? l : l.text != null ? l.text : (l.cols || l.segs || []).map((c) => c.s || '').filter(Boolean).join(l.cols ? ' · ' : ''));
function rowsOf(log) { if (Array.isArray(log)) return log; if (log && Array.isArray(log.events)) return log.events; return []; }
function chainIdOf(log) { return log && !Array.isArray(log) && log.chain ? String(log.chain) : ''; }

// a roster row from GET /agents, or an agent of the reducer's state: the same few fields
export function normAgent(r) {
  const tools = r.allowed_tools || r.allowedTools || [];
  const tier = TIERS[r.tier] ? r.tier : inferTier(tools);
  const status = String(r.status || (r.plate === 'revoked' ? 'REVOKED' : r.plate === 'stopped' ? 'KILLED' : 'ACTIVE')).toUpperCase();
  return { id: r.agent || r.id, name: r.name || r.agent || r.id || '?', tier, tools: ALL_TOOLS.filter((t) => tools.includes(t)), status, madeBy: r.made_by || r.madeBy || 'seed', color: r.color || 'mustard' };
}
export function normRoster(roster) {
  const list = Array.isArray(roster) ? roster : roster && typeof roster === 'object' ? Object.values(roster) : DEFAULT_ROSTER;
  return list.filter((r) => r && (r.known !== false)).map(normAgent);
}

// ================= THE LEDGER (gatehouse chalkboard) =================
export const LEDGER_ROWS = 12;
export const LEDGER_TEX = { w: 2048, h: 1048, pad: 30 };
const DECISION = { allow: 'ALLOW', deny: 'DENY', revoked: 'REVOKED', restored: 'RESTORED', kill_requested: 'KILL', run_started: 'START', run_stopped: 'STOP', created: 'CREATED', tier_changed: 'TIER', retired: 'RETIRED' };
const RULE = { 'status-revoked': 'revoked', 'status-killed': 'killed', 'registry-unavailable': 'registry', 'header-mismatch': 'header' };
const toneOf = (e) => (e.decision === 'allow' ? 'ok' : e.decision === 'deny' ? 'bad' : e.rule === 'harness' || e.tool === 'harness' ? 'dim' : 'admin');
// column starts as a fraction of the inner width (measured: 52 px VT323 is 20.8 px a character; every column fits its
// longest value: #123 · 21:40:03.060 · research · RESTORED · search_files · allow-list · 1234 · 1840 ms)
const LEDGER_COLS = [0, 0.065, 0.215, 0.34, 0.47, 0.635, 0.775, 0.87];
const LEDGER_HEAD = ['#', 'time', 'agent', 'decision', 'tool', 'rule', 'gw ms', 'after revoke'];
// line sizes (px glyph, line pitch factor): title, strip, column header, 12 rows; fixed, so rowAt() is pure
const LEDGER_SIZES = [{ size: 72, lh: 1.15 }, { size: 46, lh: 1.25 }, { size: 42, lh: 1.3 }, ...Array(LEDGER_ROWS).fill({ size: 52, lh: 1.23 })];

// the chain status word, from verifyChain(log)'s result (null while it runs)
export function chainWord(log, result) {
  const rows = rowsOf(log);
  if (!rows.length) return { tone: 'dim', text: 'no rows yet' };
  if (!result) return { tone: 'dim', text: 'checking the chain…' };
  if (!result.verified) return { tone: 'dim', text: 'not verified (placeholder hashes)' };
  return result.ok ? { tone: 'ok', text: '✓ chain verified' } : { tone: 'bad', text: `✗ broken at #${result.brokenAt}` };
}

// -> { lines: [title, strip, header, ...12 rows], rows: [{ seq } | null] (slot -> seq, for clicks) }
export function linesForLedger(log, result, opts = {}) {
  const all = rowsOf(log), chain = opts.chainId || chainIdOf(log);
  const st = gatewayStats(all), sw = chainWord(all, result);
  const ms = (v) => (v == null ? '—' : `${v} ms`);
  const head = [chain ? `chain ${chain}` : null, `${all.length} rows`, `p50 ${ms(st.p50)}`, `p95 ${ms(st.p95)}`, `blocked ${st.blocked}`].filter(Boolean).join(' · ');
  const lines = [
    { font: PX, weight: 600, segs: [{ s: 'THE LEDGER', c: 'ink' }, { s: '   the gateway log · click a row for its JSON', c: 'dim', f: VT, k: 0.55 }], text: 'THE LEDGER' },
    { font: VT, segs: [{ s: head + ' · ', c: 'ink' }, { s: sw.text, c: sw.tone }] },
    { font: VT, cols: LEDGER_HEAD.map((s, i) => ({ x: LEDGER_COLS[i], s, c: 'hi' })) },
  ];
  const shown = all.slice(-LEDGER_ROWS), rows = [];
  for (let i = 0; i < LEDGER_ROWS; i++) {
    const e = shown[i];
    if (!e) { lines.push({ font: VT, segs: [{ s: i === 0 && !all.length ? 'no calls yet' : '', c: 'dim' }] }); rows.push(null); continue; }
    const gw = e.decision === 'allow' || e.decision === 'deny' ? String(e.latency_ms ?? '') : '';
    const since = typeof e.ms_since_revoke === 'number' ? `${e.ms_since_revoke} ms` : '';
    const cells = [`#${e.seq}`, String(e.ts || '').slice(11, 23), short(String(e.agent || '').replace(/-bot$/, ''), 10),
      DECISION[e.decision] || String(e.decision || '').toUpperCase(), short(e.tool, 13), short(RULE[e.rule] || e.rule || '', 11), gw, since];
    const tone = toneOf(e), newest = i === shown.length - 1;
    lines.push({ font: VT, newest, cols: cells.map((s, k) => ({ x: LEDGER_COLS[k], s, c: k === 3 || newest ? tone === 'dim' ? 'ink' : tone : 'ink' })) });
    rows.push({ seq: e.seq });
  }
  LEDGER_SIZES.forEach((z, i) => Object.assign(lines[i], z));
  return { lines, rows };
}

// pitch of each line in canvas px, scaled down together when they do not fit (pure: no measuring)
export function layoutY(lines, H, pad = 30, grow = 1) {
  const pitch = lines.map((l) => (l.size || 44) * (l.lh || 1.25) + (l.gap || 0));
  const total = pitch.reduce((a, b) => a + b, 0), k = Math.min(Math.max(1, grow), (H - 2 * pad) / total);
  let y = pad; const out = [];
  for (const p of pitch) { out.push({ y0: y, y1: y + p * k, k }); y += p * k; }
  return out;
}
const LEDGER_LAYOUT = layoutY(LEDGER_SIZES, LEDGER_TEX.h, LEDGER_TEX.pad);
// uv on the ledger board (three.js: v = 0 at the bottom) -> the row slot under it (0 = oldest shown), or -1
export function rowAt(uv) {
  if (!uv) return -1;
  const y = (1 - uv.y) * LEDGER_TEX.h;
  for (let i = 0; i < LEDGER_ROWS; i++) { const r = LEDGER_LAYOUT[3 + i]; if (y >= r.y0 && y < r.y1) return i; }
  return -1;
}

// ================= THE HASH CHAIN exhibit =================
export const CHAIN_N = 8;
// -> the last 8 rows as receipts, oldest first: { seq, h6, back, link: 'ok' | 'bad' | 'unchecked' }
// verifyChain stops at the first broken row; every row after it can no longer be trusted, so it is drawn broken too.
export function chainExhibit(log, result, n = CHAIN_N) {
  const links = (result && result.verified && result.links) || {};
  const broken = result && result.verified && !result.ok ? result.brokenAt : null;
  return rowsOf(log).slice(-n).map((e) => ({
    seq: e.seq, h6: String(e.hash || '').slice(0, 6),
    back: e.prev_hash === 'genesis' ? 'genesis' : `#${e.seq - 1}`,
    link: links[e.seq] === 'ok' ? 'ok' : links[e.seq] === 'bad' || (broken != null && e.seq > broken) ? 'bad' : 'unchecked',
  }));
}
export const receiptLine = (r) => `#${r.seq} ${r.h6} ← ${r.back} ${r.link}`;
// the TAMPER TEST: a copy of the log with one character of a middle receipt's reason changed -> { copy, seq }
export function tamperCopy(log, n = CHAIN_N) {
  const rows = rowsOf(log);
  if (!rows.length) return { copy: [], seq: null };
  const shown = Math.min(n, rows.length), idx = rows.length - shown + Math.floor((shown - 1) / 2);
  const copy = rows.map((e) => ({ ...e }));
  const r = String(copy[idx].reason || ''), c = r[0] || ' ';
  copy[idx].reason = (c === 'x' ? 'y' : 'x') + r.slice(1); // one character, nothing else
  return { copy, seq: copy[idx].seq };
}
export const CAPTION = ['Every receipt carries the fingerprint of the one before it.', 'Change one and every link after it breaks.'];
export function linesForCaption(log, result, tamper) {
  const sw = chainWord(log, result);
  const status = tamper ? { s: `a changed receipt: #${tamper.seq} and everything after it fails`, c: 'bad' }
    : tamper === false ? { s: `the real ledger is untouched · ${sw.text}`, c: sw.tone } : { s: sw.text + (result && result.verified ? ' · SHA-256, checked in this browser' : ''), c: sw.tone };
  return [
    { font: PX, size: 68, lh: 1.2, segs: [{ s: CAPTION[0], c: 'ink' }] },
    { font: PX, size: 68, lh: 1.2, segs: [{ s: CAPTION[1], c: 'ink' }] },
    { font: VT, size: 72, lh: 1.25, gap: 8, segs: [status] },
  ];
}

// ================= the four islet workshops =================
export const TOOL_PLAIN = {
  read_file: 'read a document from the company drive',
  search_files: 'search the company drive for a word',
  create_issue: 'file a new ticket for the team',
  list_issues: 'read the list of open tickets',
  send_email: "send an email in the company's name",
  delete_file: 'delete a file from the company drive',
};
export const TOOL_CODE = { read_file: 'RDF', search_files: 'SRC', create_issue: 'TKT', list_issues: 'LST', send_email: 'EML', delete_file: 'DEL' };
export const WORKSHOPS = {
  files: { title: 'THE FILES TOWER', sub: 'the company drive: documents to read and search', tools: ['read_file', 'search_files'] },
  github: { title: 'THE GITHUB STUDIO', sub: "the team's tickets: filed and read here", tools: ['create_issue', 'list_issues'] },
  mail: { title: 'THE MAIL COTTAGE', sub: 'letters that leave in the company name', tools: ['send_email'] },
  admin: { title: 'THE ADMIN COURTHOUSE', sub: 'the one room where things are deleted', tools: ['delete_file'] },
};
export const lowestTierLine = (tool) => { const t = tierFor(tool); return t === 'diamond' ? 'Diamond only' : `${tierName(t)} and up`; };
export function toolCounts(log, tool) {
  let allowed = 0, refused = 0;
  for (const e of rowsOf(log)) if (e.tool === tool) { if (e.decision === 'allow') allowed++; else if (e.decision === 'deny') refused++; }
  return { allowed, refused };
}
// who may do this here: every roster agent whose badge holds the tool (name + tier medal)
export function holdersOf(roster, tool) { return normRoster(roster).filter((a) => a.tools.includes(tool)); }

export function linesForWorkshop(key, roster, log) {
  const w = WORKSHOPS[key]; if (!w) return [];
  const lines = [
    { font: PX, weight: 600, size: 92, lh: 1.15, segs: [{ s: w.title, c: 'ink' }] },
    { font: VT, size: 54, lh: 1.25, gap: 4, segs: [{ s: w.sub, c: 'dim' }] },
  ];
  for (const tool of w.tools) {
    const hs = holdersOf(roster, tool), n = toolCounts(log, tool);
    lines.push({ font: VT, size: 70, lh: 1.1, gap: 22, rule: true, segs: [{ s: tool, c: 'hi' }] });
    lines.push({ font: VT, size: 60, lh: 1.2, segs: [{ s: TOOL_PLAIN[tool], c: 'ink' }] });
    lines.push({ font: VT, size: 60, lh: 1.2, segs: [{ s: 'who may do this here:', c: 'dim' }] });
    if (!hs.length) lines.push({ font: VT, size: 60, lh: 1.2, segs: [{ s: '  nobody holds it right now', c: 'dim' }] });
    for (let i = 0; i < hs.length; i += 2) {
      const segs = [{ s: '  ', c: 'dim' }];
      hs.slice(i, i + 2).forEach((a, j, g) => {
        segs.push({ medal: hexOf(a.tier) }, { s: `${a.name} (${tierName(a.tier)})${a.status !== 'ACTIVE' ? ' ' + a.status.toLowerCase() : ''}${j < g.length - 1 ? ',  ' : ''}`, c: a.status === 'ACTIVE' ? 'ink' : 'bad' });
      });
      lines.push({ font: VT, size: 60, lh: 1.2, segs });
    }
    lines.push({ font: VT, size: 60, lh: 1.2, segs: [{ s: `${lowestTierLine(tool)} · today: `, c: 'dim' }, { s: `${n.allowed} allowed`, c: 'ok' }, { s: ' · ', c: 'dim' }, { s: `${n.refused} refused`, c: n.refused ? 'bad' : 'dim' }] });
  }
  return lines;
}

// ================= the Factory office whiteboard =================
export const WHITEBOARD_CAPTION = 'Badges are made and changed here. The form is on the right.';
const WB_COLS = [0, 0.3, 0.43, 0.57, 0.86];
export function linesForWhiteboard(roster) {
  const list = normRoster(roster);
  const lines = [
    { font: PX, weight: 600, size: 72, lh: 1.15, segs: [{ s: 'EVERY AGENT AND ITS BADGE', c: 'ink' }] },
    { font: VT, size: 44, lh: 1.3, gap: 6, cols: [{ x: WB_COLS[0], s: 'name', c: 'dim' }, { x: WB_COLS[1], s: 'tier', c: 'dim' }, { x: WB_COLS[2], s: 'status', c: 'dim' },
      { x: WB_COLS[3], s: ALL_TOOLS.map((t) => TOOL_CODE[t]).join(' '), c: 'dim', labels: ALL_TOOLS.map((t) => TOOL_CODE[t]) }, { x: WB_COLS[4], s: 'made by', c: 'dim' }] },
  ];
  if (!list.length) lines.push({ font: VT, size: 50, lh: 1.25, segs: [{ s: 'no agents yet', c: 'dim' }] });
  for (const a of list) {
    lines.push({ font: VT, size: 60, lh: 1.25, cols: [
      { x: WB_COLS[0], s: short(a.name, 16), c: 'ink', medal: hexOf(a.tier) },
      { x: WB_COLS[1], s: tierName(a.tier), c: 'ink' },
      { x: WB_COLS[2], s: a.status, c: a.status === 'ACTIVE' ? 'ok' : 'bad' },
      { x: WB_COLS[3], s: ALL_TOOLS.map((t) => (a.tools.includes(t) ? '■' : '□')).join(''), c: 'ink', squares: ALL_TOOLS.map((t) => a.tools.includes(t)) },
      { x: WB_COLS[4], s: a.madeBy, c: a.madeBy === 'factory' ? 'hi' : 'dim' },
    ] });
  }
  return lines;
}

// ================= the Factory floor wall board =================
export function linesForFloor(build) {
  const head = build ? `BUILDING: ${build.name || build.id} · ${tierName(build.tier)} · ${(build.tools || []).length} tool${(build.tools || []).length === 1 ? '' : 's'}` : 'line idle';
  return [
    { font: PX, weight: 600, size: 104, lh: 1.2, segs: [{ s: head, c: build ? 'hi' : 'ink' }] },
    { font: VT, size: 52, lh: 1.3, segs: [{ s: 'press · head · paint · badge and tools · out to the yard', c: 'dim' }] },
  ];
}

// ======================================================================================================================
// 2. the 3D rooms
// ======================================================================================================================
const PI = Math.PI;
const COLOR_HEX = { mustard: 0xe0b347, sage: 0x9cc29c, teal: 0x4f8a8b, plum: 0x7a4e6d, brick: 0xb4553e, slate: 0x63738a };
const TOKEN_HEX = { read_file: '#9cc29c', search_files: '#9cc29c', create_issue: '#9fc6dc', list_issues: '#9fc6dc', send_email: '#e0b347', delete_file: '#b4553e' };

// fonts: index.html declares them; ask for each face explicitly (a face no DOM text uses is never fetched otherwise)
let fontsP = null;
function fontsReady() {
  if (fontsP) return fontsP;
  const d = globalThis.document;
  if (!d || !d.fonts) return (fontsP = Promise.resolve());
  const faces = ['52px "VT323"', '400 52px "Pixelify Sans"', '600 52px "Pixelify Sans"'];
  const t = new Promise((r) => setTimeout(r, 2500)); // never wait forever for a font
  return (fontsP = Promise.race([Promise.all(faces.map((f) => d.fonts.load(f).catch(() => null))).then(() => d.fonts.ready), t]));
}

// paint(g, W, H, lines, pal, pad): draws board lines on a 2D canvas (layout from layoutY, widths measured here)
export function paint(g, W, H, lines, pal, pad = 30, grow = 1) {
  g.fillStyle = pal.bg; g.fillRect(0, 0, W, H);
  const inner = W - 2 * pad;
  if (grow > 1) { // never grow a line past the board's width
    for (const l of lines) {
      if (!l.segs) continue;
      const w = l.segs.reduce((a, sg) => { if (sg.medal) return a + (l.size || 44) * 0.85; g.font = `${sg.f ? 400 : l.weight || 400} ${Math.round((l.size || 44) * (sg.k || 1))}px ${sg.f || l.font || VT}`; return a + g.measureText(sg.s || '').width; }, 0);
      if (w > 0) grow = Math.min(grow, inner / w);
    }
  }
  const lay = layoutY(lines, H, pad, grow);
  lines.forEach((l, i) => {
    const { y0, y1, k } = lay[i], size = (l.size || 44) * k, mid = (y0 + (l.gap || 0) * k + y1) / 2;
    const font = (f, s, w) => `${w || l.weight || 400} ${Math.round(s)}px ${f || l.font || VT}`;
    g.textBaseline = 'middle';
    if (l.newest) { g.fillStyle = 'rgba(231,197,106,0.20)'; g.fillRect(pad - 14, y0 + 2, inner + 28, y1 - y0 - 2); g.fillStyle = pal.hi; g.fillRect(pad - 14, y0 + 2, 6, y1 - y0 - 2); }
    if (l.rule) { g.fillStyle = pal.dim; g.globalAlpha = 0.35; g.fillRect(pad, y0 + 4, inner, 3); g.globalAlpha = 1; }
    if (l.cols) {
      for (const c of l.cols) {
        let x = pad + c.x * inner;
        g.font = font(c.f, size); g.fillStyle = pal[c.c] || c.c || pal.ink;
        if (c.medal) { g.fillStyle = c.medal; g.fillRect(x, mid - size * 0.3, size * 0.6, size * 0.6); g.strokeStyle = pal.ink; g.lineWidth = 3; g.strokeRect(x, mid - size * 0.3, size * 0.6, size * 0.6); x += size * 0.85; g.fillStyle = pal[c.c] || pal.ink; }
        const SQ = 64 * k; // square pitch, shared by the squares and their labels
        if (c.squares) { c.squares.forEach((on, j) => { const s = 42 * k, xx = x + j * SQ + (SQ - s) / 2; g.strokeStyle = pal.ink; g.lineWidth = 4; g.strokeRect(xx, mid - s / 2, s, s); if (on) { g.fillStyle = pal.ok; g.fillRect(xx + 6, mid - s / 2 + 6, s - 12, s - 12); } }); continue; }
        if (c.labels) { g.font = font(c.f, 36 * k); g.textAlign = 'center'; c.labels.forEach((t, j) => g.fillText(t, x + j * SQ + SQ / 2, mid)); g.textAlign = 'left'; continue; }
        g.fillText(c.s, x, mid);
      }
      return;
    }
    // segments in a row; shrink the whole line if it would overflow the board
    const segs = l.segs || [];
    const widthAt = (s) => segs.reduce((w, sg) => { if (sg.medal) return w + s * 0.85; g.font = font(sg.f, s * (sg.k || 1), sg.f ? 400 : undefined); return w + g.measureText(sg.s || '').width; }, 0);
    let s = size; const wNeed = widthAt(s); if (wNeed > inner) s *= inner / wNeed;
    let x = l.align === 'center' ? pad + (inner - widthAt(s)) / 2 : pad;
    for (const sg of segs) {
      if (sg.medal) { g.fillStyle = sg.medal; g.fillRect(x, mid - s * 0.3, s * 0.6, s * 0.6); g.strokeStyle = pal.ink; g.lineWidth = 3; g.strokeRect(x, mid - s * 0.3, s * 0.6, s * 0.6); x += s * 0.85; continue; }
      g.font = font(sg.f, s * (sg.k || 1), sg.f ? 400 : undefined); g.fillStyle = pal[sg.c] || sg.c || pal.ink;
      g.fillText(sg.s || '', x, mid); x += g.measureText(sg.s || '').width;
    }
  });
}

export function createRooms(ctx, hooks = {}) {
  const { THREE, kit, stage } = ctx, { box, cyl, ball, grp, put, gBox, gCone, M } = kit;
  const group = new THREE.Group(); group.name = 'rooms';
  const boards = {}; for (const k of ROOM_KEYS) boards[k] = {};
  const rooms = {};          // key -> { g, fit: Box3, view: { theta, pitch }, onEnter?, tick? }
  const renderer = stage && stage._renderer;
  const aniso = renderer && renderer.capabilities ? renderer.capabilities.getMaxAnisotropy() : 1;
  const getLog = () => { try { return hooks.getLog?.() || []; } catch { return []; } };
  const getRoster = () => { try { return hooks.getRoster?.() || DEFAULT_ROSTER; } catch { return DEFAULT_ROSTER; } };

  // ---------- materials of our own (flat, matte; the lamps blink sage / brick) ----------
  const std = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: o.r ?? 0.85, metalness: 0, flatShading: true, emissive: o.e ?? 0, emissiveIntensity: o.ei ?? 1 });
  const MAT = {
    chalk: std(0x2f3a33, { r: 0.95 }), overall: std(0x8d8f8c), overall_dark: std(0x6c6e6b), primer: std(0x9a958c, { r: 0.6 }),
    lampOff: std(0x8a8278, { r: 0.7 }), lampOk: std(0x9cc29c, { e: 0x5f8f5a, ei: 0.45 }), lampBad: std(0xb4553e, { e: 0x7a2a1a, ei: 0.45 }),
    linkOk: std(0x9cc29c, { r: 0.5 }), linkBad: std(0xb4553e, { r: 0.5 }), linkDim: std(0xa49b89, { r: 0.6 }),
    amber: std(0xe7b94e, { e: 0xd08a2a, ei: 0.6 }), eyeLit: std(0xfbf2d8, { e: 0xe7c56a, ei: 0.5 }), belt: std(0x4a4440, { r: 0.9 }),
    cork: std(0xc9a46e, { r: 1 }), vault: std(0x9aa0a0, { r: 0.45 }),
  };

  // ---------- a board: a plane with a 2048-px canvas texture; draw(lines) records the lines and paints after fonts ----------
  function board(parent, roomKey, name, w, h, pal, x, y, z, ry = 0, texW = 2048, pad = 30, grow = 1) {
    const W = texW, H = Math.round((texW * h) / w);
    const c = globalThis.document ? document.createElement('canvas') : null;
    let tex = null;
    if (c) {
      c.width = W; c.height = H;
      tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter;
      tex.generateMipmaps = false; tex.anisotropy = aniso;
      const g0 = c.getContext('2d'); g0.fillStyle = pal.bg; g0.fillRect(0, 0, W, H);
    }
    const mat = new THREE.MeshBasicMaterial({ map: tex, color: tex ? 0xffffff : pal.bg, toneMapped: false });
    const mesh = put(parent, new THREE.PlaneGeometry(w, h), mat, `${roomKey}_${name}_board`, x, y, z); mesh.rotation.y = ry;
    let last = '';
    const draw = (lines) => {
      const key = JSON.stringify(lines);
      boards[roomKey][name] = lines.map(lineText);
      if (key === last || !c) return; last = key;
      fontsReady().then(() => { if (last !== key) return; paint(c.getContext('2d'), W, H, lines, pal, pad, grow); tex.needsUpdate = true; });
    };
    return { mesh, draw, W, H };
  }
  // a framed board on a wall (frame behind, board in front)
  function framed(parent, roomKey, name, w, h, pal, x, yBottom, z, frameMat = 'wood_dark', grow = 1) {
    box(parent, frameMat, `${name}_frame`, w + 0.3, h + 0.3, 0.12, x, yBottom - 0.15, z - 0.02);
    return board(parent, roomKey, name, w, h, pal, x, yBottom + h / 2, z + 0.05, 0, 2048, 30, grow);
  }
  // a painted name sign (Pixelify on a dark board, the Mytopia sign colours)
  function sign(parent, roomKey, text, w, x, y, z, ry = 0) {
    const h = w * 0.16;
    box(parent, 'wood_dark', 'sign_back', w + 0.16, h + 0.16, 0.08, x, y - h / 2 - 0.08, z - 0.05).rotation.y = ry;
    const b = board(parent, roomKey, 'sign', w, h, { ...CHALK, bg: '#3a312b', ink: '#f3ead7' }, x, y, z, ry, 1024, 14);
    b.draw([{ font: PX, weight: 600, size: 110, lh: 1, align: 'center', segs: [{ s: text, c: 'ink' }] }]);
    return b;
  }
  const meshes = (g) => g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });

  // ---------- a cutaway shell: floor, back wall, left wall (with a window), skirting, a door with its sign ----------
  function shell(g, key, W, D, H, o = {}) {
    box(g, o.floor || 'wood', 'room_floor', W, 0.3, D, 0, -0.3, 0);
    for (let x = -W / 2 + 0.55; x < W / 2; x += 0.55) box(g, 'wood_dark', 'floor_line', 0.03, 0.01, D, x, 0, 0);
    box(g, o.wall || 'plaster', 'room_back_wall', W, H, 0.3, 0, -0.3, -D / 2 - 0.15);
    box(g, o.wall || 'plaster', 'room_left_wall', 0.3, H, D, -W / 2 - 0.15, -0.3, 0);
    box(g, 'wood_dark', 'skirting', W, 0.25, 0.08, 0, 0, -D / 2 + 0.04); box(g, 'wood_dark', 'skirting', 0.08, 0.25, D, -W / 2 + 0.04, 0, 0);
    box(g, 'wood_dark', 'wall_beam', W, 0.2, 0.12, 0, H - 0.6, -D / 2 + 0.06);
    if (o.window !== false) box(g, 'window', 'left_window', 0.06, 1.4, 2.0, -W / 2 + 0.02, 2.0, 0.8); if (o.window !== false) box(g, 'wood_light', 'left_window_sill', 0.14, 0.1, 2.2, -W / 2 + 0.07, 1.95, 0.8);
    // the door: back wall, left end; the room's name over it
    const dx = -W / 2 + 1.1;
    box(g, 'wood_dark', 'door_frame', 1.5, 2.55, 0.1, dx, 0, -D / 2 + 0.05); box(g, o.door || 'wood', 'door', 1.25, 2.4, 0.08, dx, 0, -D / 2 + 0.1);
    box(g, 'brass', 'door_knob', 0.1, 0.1, 0.08, dx + 0.42, 1.15, -D / 2 + 0.17);
    sign(g, key, o.title || key.toUpperCase(), 1.9, dx, 3.15, -D / 2 + 0.12);
  }
  const lamp = (g, name, x, y, z, h = 0.5) => { cyl(g, 'ink', `${name}_post`, 0.04, 0.04, h, x, y, z, 6); return put(g, gBox(0.26, 0.26, 0.26), MAT.lampOff, `${name}_lamp`, x, y + h + 0.12, z); };
  const plant = (g, x, z, s = 1) => { const p = grp(g, 'plant', x, 0, z); p.scale.setScalar(s); cyl(p, 'brick', 'pot', 0.3, 0.24, 0.5, 0, 0, 0, 8); ball(p, 'leaf_a', 'leaves', 0.45, 0, 0.9, 0); ball(p, 'leaf_c', 'leaves', 0.3, 0.25, 1.15, 0.1); put(p, gCone(0.25, 0.5, 6), 'leaf_b', 'tip', 0, 1.45, 0); return p; };
  const desk = (g, name, x, z, w = 2.2, d = 0.9, ry = 0) => { const k = grp(g, name, x, 0, z, ry); box(k, 'wood', 'top', w, 0.1, d, 0, 0.74, 0); for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(k, 'wood_dark', 'leg', 0.09, 0.74, 0.09, sx * (w / 2 - 0.1), 0, sz * (d / 2 - 0.1)); return k; };

  // a small robot (Mytopia's recipe): used by the clerk, the workers and the line
  function robot(parent, name, bodyMat, s = 1) {
    const r = grp(parent, name); r.scale.setScalar(s);
    const treads = grp(r, 'treads'); for (const sx of [-1, 1]) box(treads, 'tread_black', 'tread', 0.12, 0.14, 0.42, sx * 0.15, 0, 0);
    const torso = grp(r, 'torso', 0, 0.14, 0);
    const body = box(torso, bodyMat, 'body', 0.42, 0.34, 0.4, 0, 0, 0);
    box(torso, 'robot_grey', 'neck', 0.07, 0.14, 0.07, 0, 0.34, 0);
    const head = grp(r, 'head', 0, 0.6, 0); box(head, 'robot_cream', 'head_box', 0.38, 0.2, 0.22);
    const eyes = [-1, 1].map((sx) => box(head, 'eye', 'eye', 0.1, 0.1, 0.03, sx * 0.09, 0.05, 0.115));
    box(head, 'ink', 'visor', 0.4, 0.04, 0.12, 0, 0.2, 0.06);
    return { r, treads, torso, body, head, eyes };
  }

  // ===================================== gatehouse =====================================
  const ledger = {};
  {
    const g = grp(group, 'room_gatehouse'); g.visible = false;
    const RH = 6.2, BZ = -4, AX = -2.4, RX = 7.8, FZ = 4.2;     // back wall z, splayed wall corner x, right edge, front
    const SPLAY = (40 * PI) / 180, LW = 7.6;                    // the HASH CHAIN wall: 40 degrees off the back wall, 7.6 long
    const dir = [Math.cos(SPLAY), -Math.sin(SPLAY)];            // from its far end B to the corner A
    const B = [AX - LW * dir[0], BZ - LW * dir[1]];
    const slope = Math.tan(SPLAY);                              // wall line: z = BZ + (AX - x) * slope, for x < AX
    // floor: a trapezoid that follows the splayed wall
    const zAt = (x) => (x >= AX ? BZ : BZ + (AX - x) * slope);
    const LX = B[0] - 0.3, shape = new THREE.Shape();
    [[AX, BZ], [RX, BZ], [RX, FZ], [LX, FZ], [LX, zAt(LX)]].forEach(([x, z], i) => (i ? shape.lineTo(x, -z) : shape.moveTo(x, -z)));
    const fl = put(g, new THREE.ExtrudeGeometry(shape, { depth: 0.3, bevelEnabled: false }), 'wood', 'room_floor', 0, 0, 0); fl.rotation.x = -PI / 2; fl.position.y = -0.3;
    for (let x = LX + 0.5; x < RX; x += 0.55) { const z0 = zAt(x), len = FZ - z0; box(g, 'wood_dark', 'floor_line', 0.03, 0.01, len, x, 0, z0 + len / 2); }
    // the back wall (THE LEDGER) and the splayed wall (THE HASH CHAIN)
    box(g, 'plaster', 'room_back_wall', RX - AX, RH, 0.3, (AX + RX) / 2, -0.3, BZ - 0.15);
    box(g, 'wood_dark', 'skirting', RX - AX, 0.25, 0.08, (AX + RX) / 2, 0, BZ + 0.04);
    box(g, 'wood_dark', 'wall_beam', RX - AX, 0.2, 0.12, (AX + RX) / 2, RH - 0.6, BZ + 0.06);
    box(g, 'wood_dark', 'corner_post', 0.36, RH, 0.36, AX, -0.3, BZ);
    const sw = grp(g, 'chain_wall', B[0], 0, B[1], SPLAY);     // local x runs from B (0) to A (LW); local +z faces the room
    box(sw, 'plaster', 'splay_wall', LW, RH, 0.3, LW / 2, -0.3, -0.15);
    box(sw, 'wood_dark', 'skirting', LW, 0.25, 0.08, LW / 2, 0, 0.04);
    box(sw, 'wood_dark', 'wall_beam', LW, 0.2, 0.12, LW / 2, RH - 0.6, 0.06);

    // THE LEDGER chalkboard
    const LB = { x: 2.7, w: 9.4, h: 4.8, y0: 0.95 };
    box(g, 'wood_dark', 'board_frame', LB.w + 0.3, LB.h + 0.3, 0.14, LB.x, LB.y0 - 0.15, BZ + 0.07);
    ledger.board = board(g, 'gatehouse', 'ledger', LB.w, LB.h, CHALK, LB.x, LB.y0 + LB.h / 2, BZ + 0.15, 0, LEDGER_TEX.w, LEDGER_TEX.pad);
    box(g, 'wood_light', 'chalk_tray', LB.w + 0.1, 0.08, 0.25, LB.x, LB.y0 - 0.2, BZ + 0.2);
    for (const [cx, col] of [[-2.2, 'plaster'], [-1.9, 'paper'], [3.6, 'mustard']]) box(g, col, 'chalk_stick', 0.18, 0.05, 0.05, LB.x + cx, LB.y0 - 0.12, BZ + 0.22);

    // HASH CHAIN: title, cord, 8 receipts, the links between them, the caption board
    const tb = board(sw, 'gatehouse', 'chain_title', 3.6, 0.5, { ...CHALK, bg: '#3a312b', ink: '#f3ead7' }, LW / 2, 5.32, 0.06, 0, 1024, 10);
    tb.draw([{ font: PX, weight: 600, size: 100, lh: 1, align: 'center', segs: [{ s: 'THE HASH CHAIN', c: 'ink' }] }]);
    // two cords of four receipts (oldest top left, newest bottom right); a link before each receipt says whether it
    // names the receipt before it. Four to a cord so each receipt is big enough to read its hash from the default view.
    const PER = CHAIN_N / 2, step = (LW - 0.5) / PER, RW = 1.45, RHt = 0.98, CORDS = [4.95, 3.55];
    for (const cy of CORDS) box(sw, 'rope', 'cord', LW - 0.3, 0.04, 0.04, LW / 2, cy - 0.02, 0.1);
    ledger.receipts = []; ledger.links = [];
    for (let i = 0; i < CHAIN_N; i++) {
      const cy = CORDS[Math.floor(i / PER)], cx = 0.35 + 0.15 + step * ((i % PER) + 0.5);
      const hang = grp(sw, 'receipt', cx, cy, 0.14);
      for (const px of [-0.5, 0.5]) box(hang, 'wood_light', 'peg', 0.08, 0.16, 0.06, px, -0.1, 0.02);
      const rb = board(hang, 'gatehouse', `receipt_${i}`, RW, RHt, PAPER, 0, -0.06 - RHt / 2, 0.05, 0, 768, 16);
      ledger.receipts.push({ hang, b: rb });
      const lk = grp(sw, 'link', cx - RW / 2 - 0.14, cy - 0.06 - RHt / 2, 0.18);
      const parts = [];
      for (const [ox, oy] of [[-0.075, 0], [0.075, 0.0]]) {
        for (const [w, h, x, y] of [[0.18, 0.04, 0, 0.065], [0.18, 0.04, 0, -0.065], [0.04, 0.17, -0.07, 0], [0.04, 0.17, 0.07, 0]]) parts.push(put(lk, gBox(w, h, 0.05), MAT.linkDim, 'link_part', ox + x, oy + y, ox < 0 ? 0 : 0.03));
      }
      ledger.links.push(parts);
    }
    ledger.caption = board(sw, 'gatehouse', 'caption', LW - 0.7, 1.2, PAPER, LW / 2, 1.55, 0.08, 0, 2048, 24, 1.4);
    box(sw, 'wood_dark', 'caption_frame', LW - 0.5, 1.4, 0.08, LW / 2, 1.55 - 0.7, 0.02);

    // the clerk's desk, a stamp, papers, the BLOCKED tray, a sign on the front (room.js)
    const dz = 2.4, DX = LB.x - 0.4;
    const d = grp(g, 'clerk_desk', DX, 0, dz, 0);
    box(d, 'wood', 'desk_top', 3.4, 0.12, 1.3, 0, 0.73, 0); box(d, 'wood_dark', 'desk_front', 3.4, 0.73, 0.1, 0, 0, 0.6);
    for (const s of [-1, 1]) box(d, 'wood_dark', 'desk_side', 0.1, 0.73, 1.2, s * 1.65, 0, 0);
    box(d, 'paper', 'paper_stack', 0.6, 0.18, 0.45, -1.0, 0.85, -0.1); box(d, 'paper', 'paper_sheet', 0.55, 0.02, 0.4, 0.2, 0.85, 0.1);
    box(d, 'stripe_red', 'blocked_tray', 0.7, 0.14, 0.5, 1.15, 0.85, -0.05);
    const ds = board(d, 'gatehouse', 'desk_sign', 2.6, 0.42, PAPER, 0, 0.38, 0.66, 0, 1024, 8);
    ds.draw([{ font: PX, weight: 600, size: 120, lh: 1, align: 'center', segs: [{ s: 'GATEWAY LEDGER', c: 'ink' }] }]);
    // the clerk on a stool behind the desk, stamping arm on its right
    box(g, 'wood_dark', 'clerk_stool', 0.7, 0.25, 0.7, DX, 0, dz - 1.0);
    const c = grp(g, 'clerk', DX, 0.25, dz - 1.0, 0); c.scale.setScalar(2.4);
    box(c, 'robot_orange', 'clerk_body', 0.42, 0.34, 0.4, 0, 0.14, 0);
    box(c, 'robot_grey', 'clerk_neck', 0.07, 0.14, 0.07, 0, 0.48, 0);
    const head = grp(c, 'clerk_head', 0, 0.6, 0); box(head, 'robot_cream', 'clerk_head', 0.38, 0.2, 0.22);
    for (const s of [-1, 1]) box(head, 'eye', 'clerk_eye', 0.12, 0.12, 0.03, s * 0.09, 0.04, 0.115);
    box(head, 'ink', 'clerk_visor', 0.4, 0.04, 0.12, 0, 0.2, 0.06);
    const arm = grp(c, 'clerk_arm', 0.26, 0.42, 0.05);
    box(arm, 'robot_grey', 'arm', 0.07, 0.07, 0.34, 0, 0, 0.17); box(arm, 'wood_dark', 'stamp_handle', 0.08, 0.14, 0.08, 0, -0.06, 0.34); box(arm, 'stripe_red', 'stamp_head', 0.14, 0.05, 0.14, 0, -0.14, 0.34);
    const ARM_REST = -0.5; arm.rotation.x = ARM_REST;
    box(g, 'velvet', 'rug', 5.0, 0.02, 2.6, DX, 0, dz - 0.4);
    const cab = grp(g, 'filing_cabinet', 7.0, 0, 2.6, -0.3);
    box(cab, 'metal', 'cabinet_body', 0.9, 1.3, 0.7); for (const y of [0.25, 0.7]) box(cab, 'ink', 'cabinet_handle', 0.3, 0.05, 0.04, 0, y + 0.2, 0.36);
    plant(g, -3.4, 3.2);
    put(g, gBox(0.5, 0.5, 0.5), 'wood', 'crate', -1.6, 0.25, 3.4).rotation.y = 0.4;
    meshes(g);

    let stampT = 0; const STAMP = 0.45;
    ledger.stamp = () => { stampT = STAMP; };
    ledger.tick = (t, dt) => {
      if (stampT > 0) stampT = Math.max(0, stampT - dt);
      arm.rotation.x = ARM_REST * (1 - Math.sin(((STAMP - stampT) / STAMP) * PI) * (stampT > 0 ? 1 : 0));
      head.rotation.y = Math.sin(t * 0.7) * 0.15;
      ledger.receipts.forEach((r, i) => { r.hang.rotation.z = Math.sin(t * 0.9 + i * 0.8) * 0.025; });
    };
    rooms.gatehouse = { g, view: { theta: 0.08, pitch: 0.27 }, fit: new THREE.Box3(new THREE.Vector3(B[0] - 0.1, -0.2, BZ), new THREE.Vector3(LB.x + LB.w / 2 + 0.25, 5.75, dz + 0.7)) };
  }

  // ledger state: the last log drawn, its chain check, the slot -> seq map for clicks, the tamper overlay
  const L = { key: '', result: null, rows: [], tamper: null, healed: null, nRows: 0 };
  function paintReceipt(rb, r, tamper) {
    if (!r) { rb.draw([{ font: VT, size: 80, lh: 1.2, align: 'center', segs: [{ s: '', c: 'dim' }] }]); return; }
    const changed = tamper && r.seq === tamper.seq, after = tamper && r.seq > tamper.seq;
    const mark = changed ? { s: '✗ changed', c: 'bad' } : after || r.link === 'bad' ? { s: '✗ broken', c: 'bad' } : r.link === 'ok' ? { s: '✓ linked', c: 'ok' } : { s: '· unchecked', c: 'dim' };
    rb.draw([
      { font: PX, weight: 600, size: 104, lh: 1.1, align: 'center', segs: [{ s: `#${r.seq}`, c: 'ink' }] },
      { font: VT, size: 200, lh: 0.95, align: 'center', segs: [{ s: r.h6 || '——————', c: changed ? 'bad' : 'ink' }] },
      { font: VT, size: 96, lh: 1.15, align: 'center', segs: [{ s: `← ${r.back}  `, c: 'dim' }, mark] },
    ]);
  }
  function drawGatehouse(log) {
    const rows = rowsOf(log), real = L.tamper ? L.tamper.copy : rows, result = L.tamper ? L.tamper.result : L.result;
    const { lines, rows: slots } = linesForLedger(log, L.result, { chainId: chainIdOf(log) || (() => { try { return hooks.getChain?.() || ''; } catch { return ''; } })() });
    L.rows = slots; ledger.board.draw(lines);
    const ex = chainExhibit(real, result);
    for (let i = 0; i < CHAIN_N; i++) {
      const r = ex[i - (CHAIN_N - ex.length)] || null;
      paintReceipt(ledger.receipts[i].b, r, L.tamper);
      const m = !r ? MAT.linkDim : (L.tamper && r.seq >= L.tamper.seq) || r.link === 'bad' ? MAT.linkBad : r.link === 'ok' ? MAT.linkOk : MAT.linkDim;
      for (const p of ledger.links[i]) p.material = m;
      ledger.receipts[i].hang.visible = !!r; for (const p of ledger.links[i]) p.visible = !!r; // an empty slot shows nothing
    }
    boards.gatehouse.chain = ex.map((r) => receiptLine(L.tamper && r.seq >= L.tamper.seq ? { ...r, link: 'bad' } : r));
    ledger.caption.draw(linesForCaption(rows, L.result, L.tamper ? L.tamper : L.healed ? false : null));
  }
  function checkChain(log) {
    const rows = rowsOf(log), key = `${rows.length}:${rows.length ? rows[rows.length - 1].hash : ''}`;
    if (key === L.key) return;
    L.key = key; L.result = null;
    verifyChain(rows.slice()).then((r) => { if (L.key !== key) return; L.result = r; drawGatehouse(getLog()); }).catch(() => {});
  }

  // ===================================== the four workshops: one template =====================================
  const workshops = {};
  function workshopRoom(key, spec) {
    const g = grp(group, `room_${key}`); g.visible = false;
    const W = 13, D = 8, H = 6.2;
    shell(g, key, W, D, H, { title: spec.sign, wall: spec.wall, floor: spec.floor });
    const BW = 7.2, BH = 4.3;
    const bd = framed(g, key, 'board', BW, BH, PAPER, 0.9, 1.15, -D / 2 + 0.15, 'wood_dark', 1.9);
    const lamps = {};
    spec.props(g, lamps);
    meshes(g);
    workshops[key] = { bd, lamps, blink: {} };
    rooms[key] = { g, view: { theta: 0.26, pitch: 0.34 }, fit: new THREE.Box3(new THREE.Vector3(-W / 2 - 0.3, -0.3, -D / 2), new THREE.Vector3(W / 2, H - 0.6, D / 2 - 1.2)) };
  }
  // props per islet; each station gets a lamp (lamps[tool])
  workshopRoom('files', { sign: 'FILES', props(g, lamps) {
    for (const [sx, sz, ry] of [[5.5, -3.55, 0], [-6.05, 3.0, PI / 2]]) { // a tall shelf right of the board, one on the left wall
      const sh = grp(g, 'shelf', sx, 0, sz, ry); sh.scale.set(0.75, 1, 0.75);
      box(sh, 'wood_dark', 'shelf_side', 0.1, 3.4, 0.7, -1.05, 0, 0); box(sh, 'wood_dark', 'shelf_side', 0.1, 3.4, 0.7, 1.05, 0, 0);
      for (let k = 0; k < 5; k++) { box(sh, 'wood', 'shelf_plank', 2.1, 0.08, 0.7, 0, k * 0.8, 0); if (k < 4) for (let b = 0; b < 8; b++) box(sh, ['mustard', 'brick', 'copper', 'paper', 'roof_slate'][(b + k) % 5], 'book', 0.18, 0.5 + ((b * 7 + k) % 3) * 0.08, 0.5, -0.85 + b * 0.24, k * 0.8 + 0.08, 0); }
    }
    const rd = desk(g, 'reading_desk', -1.6, 1.6, 2.4, 1.0); box(rd, 'paper', 'open_book', 0.8, 0.05, 0.55, -0.2, 0.84, 0); box(rd, 'wood_dark', 'book_spine', 0.06, 0.07, 0.55, -0.2, 0.84, 0);
    box(rd, 'wood_dark', 'chair', 0.6, 0.45, 0.6, 0, 0, 0.9);
    lamps.read_file = lamp(rd, 'read_file', 0.85, 0.79, -0.25);
    const ci = grp(g, 'card_index', 2.6, 0, 1.4, -0.2); box(ci, 'wood', 'index_body', 1.4, 1.1, 0.8);
    for (let r = 0; r < 3; r++) for (let q = 0; q < 4; q++) { box(ci, 'wood_light', 'drawer', 0.3, 0.26, 0.04, -0.5 + q * 0.33, 0.12 + r * 0.32, 0.41); box(ci, 'brass', 'pull', 0.08, 0.04, 0.03, -0.5 + q * 0.33, 0.22 + r * 0.32, 0.44); }
    lamps.search_files = lamp(ci, 'search_files', 0.5, 1.1, 0);
    plant(g, -5.6, 1.4);
  } });
  workshopRoom('github', { sign: 'GITHUB', props(g, lamps) {
    const dt = grp(g, 'drafting_table', -1.4, 0, 1.4, 0.15);
    for (const sx of [-1, 1]) box(dt, 'wood_dark', 'leg', 0.09, 1.0, 0.09, sx * 0.9, 0, 0);
    const top = box(dt, 'wood_light', 'table_top', 2.2, 0.08, 1.3, 0, 1.0, 0); top.rotation.x = 0.35;
    const sheet = box(dt, 'paper', 'drawing', 1.4, 0.02, 0.9, 0, 1.09, 0); sheet.rotation.x = 0.35;
    box(dt, 'wood_dark', 'stool', 0.5, 0.65, 0.5, 0, 0, 0.95);
    lamps.create_issue = lamp(dt, 'create_issue', 1.35, 0, -0.3, 1.3);
    // the ticket wall: cork on the left wall... kept on the floor-standing easel so the default camera reads it
    const tw = grp(g, 'ticket_wall', 4.6, 0, 0.6, -0.35);
    for (const sx of [-1, 1]) box(tw, 'wood_dark', 'post', 0.1, 2.6, 0.1, sx * 1.1, 0, 0);
    box(tw, MAT.cork, 'cork', 2.2, 1.6, 0.08, 0, 0.9, 0);
    const TC = ['paper', 'mustard', 'slip_ok', 'paper', 'slip_bad', 'paper', 'mustard', 'paper', 'slip_ok'];
    TC.forEach((m, i) => { const p = box(tw, m, 'ticket', 0.5, 0.36, 0.02, -0.7 + (i % 3) * 0.7, 1.1 + Math.floor(i / 3) * 0.48, 0.06); p.rotation.z = ((i * 37) % 7 - 3) * 0.03; });
    lamps.list_issues = lamp(tw, 'list_issues', 1.5, 0, 0.25, 1.3);
    plant(g, -5.6, 3.0);
  } });
  workshopRoom('mail', { sign: 'MAIL', wall: 'plaster', props(g, lamps) {
    const wd = desk(g, 'writing_desk', -1.2, 1.5, 2.2, 0.95);
    box(wd, 'paper', 'letter', 0.5, 0.02, 0.35, -0.3, 0.8, 0.05); box(wd, 'slip_ok', 'envelope', 0.5, 0.05, 0.3, 0.4, 0.8, -0.1); cyl(wd, 'ink', 'inkpot', 0.08, 0.1, 0.16, 0.8, 0.79, -0.2, 8);
    box(wd, 'wood_dark', 'chair', 0.6, 0.45, 0.6, 0, 0, 0.9);
    lamps.send_email = lamp(wd, 'send_email', 1.35, 0, 0, 1.3);
    const ph = grp(g, 'pigeonholes', 4.6, 0, 0.2, -0.3);
    box(ph, 'wood_dark', 'case', 2.4, 2.2, 0.6);
    for (let r = 0; r < 4; r++) for (let q = 0; q < 5; q++) { box(ph, 'wood', 'cubby', 0.4, 0.4, 0.04, -0.92 + q * 0.46, 0.15 + r * 0.5, 0.29); if ((r * 5 + q) % 3 !== 1) box(ph, (r + q) % 2 ? 'paper' : 'slip_ok', 'envelope', 0.3, 0.2, 0.04, -0.92 + q * 0.46, 0.22 + r * 0.5, 0.32); }
    put(g, gBox(0.7, 0.9, 0.7), 'mailbox', 'mail_sack', -4.6, 0.45, 2.8).rotation.y = 0.3;
    plant(g, -5.6, 1.4);
  } });
  workshopRoom('admin', { sign: 'ADMIN', wall: 'stone', floor: 'wood_dark', props(g, lamps) {
    const bn = grp(g, 'bench', -1.2, 0, 1.0);
    box(bn, 'wood_dark', 'bench_front', 3.2, 1.3, 0.9); box(bn, 'wood', 'bench_top', 3.4, 0.12, 1.0, 0, 1.3, 0); box(bn, 'brass', 'bench_trim', 3.2, 0.08, 0.04, 0, 1.0, 0.46);
    box(bn, 'velvet', 'bench_cloth', 1.0, 0.7, 0.04, 0, 0.35, 0.46);
    const v = grp(g, 'vault', 5.6, 0, -3.65);
    box(v, 'stone_dark', 'vault_frame', 1.7, 2.3, 0.3);
    const door = cyl(v, MAT.vault, 'vault_door', 0.7, 0.7, 0.2, 0, 1.15, 0.2, 16); door.rotation.x = PI / 2; door.position.set(0, 1.15, 0.2);
    for (let i = 0; i < 3; i++) { const sp = box(v, 'metal', 'spoke', 0.07, 0.9, 0.06, 0, 0, 0.36); sp.rotation.z = (i * PI) / 3; sp.position.set(0, 1.15, 0.36); }
    const sh = grp(g, 'shredder', 2.4, 0, 1.6, -0.2);
    box(sh, 'metal', 'shredder_bin', 0.8, 0.9, 0.6); box(sh, 'ink', 'shredder_head', 0.84, 0.18, 0.64, 0, 0.9, 0); box(sh, 'eye', 'slot', 0.6, 0.03, 0.06, 0, 1.08, 0);
    for (let i = 0; i < 5; i++) box(sh, 'paper', 'strip', 0.05, 0.3, 0.02, -0.2 + i * 0.1, 0.6, 0.31);
    lamps.delete_file = lamp(sh, 'delete_file', 0.65, 0, 0, 1.3);
    plant(g, -5.6, 3.0);
  } });
  function drawWorkshop(key, roster, log) { workshops[key].bd.draw(linesForWorkshop(key, roster, log)); }

  // ===================================== factory_office =====================================
  let office;
  {
    const g = grp(group, 'room_factory_office'); g.visible = false;
    const W = 13, D = 8, H = 6.2;
    shell(g, 'factory_office', W, D, H, { title: 'FACTORY OFFICE', wall: 'plaster', window: false });
    const wb = framed(g, 'factory_office', 'whiteboard', 8.2, 4.2, PAPER, 1.6, 1.2, -D / 2 + 0.15, 'metal', 1.35);
    box(g, 'metal', 'marker_tray', 8.0, 0.06, 0.2, 1.6, 1.0, -D / 2 + 0.2);
    for (const [x, m] of [[-1.5, 'stripe_red'], [-1.2, 'ink'], [-0.9, 'roof_slate']]) box(g, m, 'marker', 0.22, 0.05, 0.05, 1.6 + x, 1.06, -D / 2 + 0.22);
    const cap = board(g, 'factory_office', 'caption', 6.4, 0.5, PAPER, 1.6, 0.62, -D / 2 + 0.2, 0, 2048, 10);
    cap.draw([{ font: PX, size: 92, lh: 1, align: 'center', segs: [{ s: WHITEBOARD_CAPTION, c: 'ink' }] }]);
    // the window onto the floor (left wall): the line seen through glass
    box(g, 'wood_dark', 'floor_window_frame', 0.1, 2.1, 3.1, -W / 2 + 0.05, 1.65, -1.6);
    box(g, 'window', 'floor_window', 0.06, 1.8, 2.8, -W / 2 + 0.11, 1.8, -1.6);
    box(g, 'wood_dark', 'floor_window_bar', 0.08, 1.8, 0.08, -W / 2 + 0.14, 1.8, -1.6);
    const k = desk(g, 'office_desk', -2.2, 1.8, 2.4, 1.0, 0.2);
    box(k, 'paper', 'forms', 0.6, 0.1, 0.4, -0.5, 0.79, 0); box(k, 'brass', 'stamp', 0.16, 0.2, 0.16, 0.4, 0.79, -0.1); box(k, 'tread_black', 'phone', 0.4, 0.15, 0.3, 0.8, 0.79, 0.15);
    box(k, 'wood_dark', 'chair', 0.6, 0.5, 0.6, 0, 0, -0.9);
    plant(g, 5.6, 3.0, 1.2); plant(g, -5.6, 3.2);
    put(g, gBox(0.8, 1.2, 0.6), 'metal', 'cabinet', 6.0, 0.6, -3.2);
    meshes(g);
    office = { wb };
    rooms.factory_office = { g, view: { theta: 0.3, pitch: 0.34 }, fit: new THREE.Box3(new THREE.Vector3(-W / 2 - 0.3, -0.3, -D / 2), new THREE.Vector3(W / 2, H - 0.5, D / 2)) };
  }

  // ===================================== factory_floor: the production line =====================================
  const floor = {};
  {
    const g = grp(group, 'room_factory_floor'); g.visible = false;
    const W = 17, D = 8, H = 6.6;
    shell(g, 'factory_floor', W, D, H, { title: 'FACTORY FLOOR', wall: 'brick', floor: 'stone_dark' });
    // a big roller door at the right end of the back wall, where finished robots leave for the yard
    floor.doorX = W / 2 - 1.7;
    box(g, 'eye', 'door_dark', 2.6, 3.2, 0.06, floor.doorX, 0, -D / 2 + 0.04);
    floor.roller = grp(g, 'roller', floor.doorX, 0, -D / 2 + 0.1);
    box(floor.roller, 'metal', 'roller_door', 2.6, 3.2, 0.1, 0, 0, 0);
    for (let y = 0.3; y < 3.2; y += 0.32) box(floor.roller, 'robot_grey', 'door_slat', 2.6, 0.03, 0.04, 0, y, 0.06);
    box(g, 'stripe_red', 'door_stripe', 2.8, 0.14, 0.12, floor.doorX, 3.2, -D / 2 + 0.1);
    floor.wall = framed(g, 'factory_floor', 'wall', 9.0, 1.5, CHALK, 0.6, 4.0, -D / 2 + 0.15, 'wood_dark', 1.5);
    // the conveyor: frame, rollers, planks that scroll
    const BY = 0.7, BX0 = -7.2, BX1 = 7.6, BZ = 0.6, BL = BX1 - BX0;
    box(g, 'robot_grey', 'belt_frame', BL, 0.12, 1.3, (BX0 + BX1) / 2, BY - 0.2, BZ);
    for (let x = BX0 + 0.4; x < BX1; x += 1.6) for (const sz of [-1, 1]) box(g, 'robot_grey', 'belt_leg', 0.1, BY - 0.2, 0.1, x, 0, BZ + sz * 0.55);
    for (let x = BX0 + 0.2; x < BX1; x += 0.5) { const r = cyl(g, 'metal', 'roller', 0.07, 0.07, 1.2, x, BY - 0.1, BZ, 8); r.rotation.x = PI / 2; r.position.y = BY - 0.08; }
    floor.planks = [];
    const PL = 0.45;
    for (let x = BX0; x < BX1 - 0.01; x += PL) floor.planks.push(box(g, (floor.planks.length % 2) ? 'plank' : 'wood', 'belt_plank', PL - 0.04, 0.05, 1.1, x + PL / 2, BY - 0.04, BZ));
    floor.belt = { BY, BX0, BX1, BZ, PL, off: 0 };
    // four stations with robot arms
    const ST = [-4.5, -1.5, 1.5, 4.5];
    floor.ST = ST;
    const gantry = (x, name, color) => {
      const s = grp(g, name, x, 0, BZ);
      for (const sz of [-1, 1]) box(s, color, 'post', 0.16, 3.0, 0.16, 0, 0, sz * 0.85);
      box(s, color, 'beam', 0.3, 0.2, 1.9, 0, 3.0, 0);
      const arm = grp(s, 'arm', 0, 2.95, 0); box(arm, 'robot_grey', 'piston', 0.12, 0.9, 0.12, 0, -0.9, 0);
      return { s, arm };
    };
    // 1 press: the torso drops
    const press = gantry(ST[0], 'press', 'mustard'); box(press.arm, 'ink', 'press_head', 0.6, 0.12, 0.6, 0, -1.02, 0);
    floor.press = press; floor.weld = put(press.s, gBox(0.12, 0.12, 0.12), MAT.amber, 'weld_blink', 0.35, 1.1, -0.55); floor.weld.visible = false;
    // 2 head: the arm carries a head down; the eyes light
    floor.headSt = gantry(ST[1], 'head_station', 'roof_slate'); box(floor.headSt.arm, 'robot_grey', 'claw', 0.5, 0.08, 0.3, 0, -0.98, 0);
    // 3 paint booth: a spray box
    const pb = grp(g, 'paint_booth', ST[2], 0, BZ);
    box(pb, 'plaster', 'booth_back', 1.9, 2.6, 0.1, 0, 0, -0.85); box(pb, 'plaster', 'booth_side', 0.1, 2.6, 1.8, -0.95, 0, 0); box(pb, 'plaster', 'booth_side', 0.1, 2.6, 1.8, 0.95, 0, 0);
    box(pb, 'roof_slate', 'booth_roof', 2.1, 0.12, 1.9, 0, 2.6, 0); box(pb, 'brick', 'booth_band', 1.9, 0.18, 0.04, 0, 2.3, -0.8);
    const nozzle = grp(pb, 'nozzle', 0, 2.1, -0.4); box(nozzle, 'robot_grey', 'nozzle_body', 0.2, 0.2, 0.3); floor.nozzle = nozzle;
    floor.spray = []; for (let i = 0; i < 6; i++) { const p = put(pb, gBox(0.12, 0.12, 0.12), new THREE.MeshStandardMaterial({ color: 0xd8d2c4, flatShading: true, transparent: true, opacity: 0.8 }), 'spray', 0, 1.6, 0); p.visible = false; floor.spray.push(p); }
    // 4 badge desk: a stamp press and the rack robot with the tool tokens
    floor.stampSt = gantry(ST[3], 'stamp_press', 'brick'); box(floor.stampSt.arm, 'stripe_red', 'stamp_head', 0.3, 0.14, 0.3, 0, -1.0, 0.18);
    const rack = grp(g, 'token_rack', ST[3] + 0.6, 0, BZ - 1.9);
    box(rack, 'wood_dark', 'rack', 1.6, 1.2, 0.5);
    floor.rackSpot = new THREE.Vector3(ST[3] + 0.6, 1.35, BZ - 1.9);
    const rr = robot(g, 'rack_robot', 'robot_sky', 1.6); rr.r.position.set(ST[3] - 0.7, 0, BZ - 1.7); floor.rackRobot = rr;
    // the tool tokens: one cube per tool with a 3-letter stencil
    floor.tokenMat = {};
    for (const t of ALL_TOOLS) {
      let map = null;
      if (globalThis.document) {
        const c = document.createElement('canvas'); c.width = c.height = 128;
        const tx = new THREE.CanvasTexture(c); tx.colorSpace = THREE.SRGBColorSpace; tx.generateMipmaps = false; tx.minFilter = THREE.LinearFilter; map = tx;
        const draw = () => { const q = c.getContext('2d'); q.fillStyle = TOKEN_HEX[t]; q.fillRect(0, 0, 128, 128); q.strokeStyle = '#3a312b'; q.lineWidth = 8; q.strokeRect(4, 4, 120, 120); q.fillStyle = '#3a312b'; q.font = `600 46px ${PX}`; q.textAlign = 'center'; q.textBaseline = 'middle'; q.fillText(TOOL_CODE[t], 64, 68); tx.needsUpdate = true; };
        draw(); fontsReady().then(draw);
      }
      floor.tokenMat[t] = new THREE.MeshStandardMaterial({ map, color: map ? 0xffffff : TOKEN_HEX[t], roughness: 0.8, flatShading: true });
    }
    for (let i = 0; i < 6; i++) put(rack, gBox(0.2, 0.2, 0.2), floor.tokenMat[ALL_TOOLS[i]], 'rack_token', -0.6 + i * 0.24, 1.3, 0.05);
    // two workers in grey overalls
    floor.workers = [[-3.0, -1.2], [3.0, -1.3]].map(([x, z], i) => {
      const w = robot(g, `worker_${i}`, MAT.overall, 2.2); w.r.position.set(x, 0, z);
      box(w.torso, MAT.overall_dark, 'overall_strap', 0.44, 0.08, 0.42, 0, 0.26, 0); box(w.torso, MAT.overall_dark, 'overall_pocket', 0.16, 0.1, 0.02, 0, 0.1, 0.205);
      box(w.head, 'mustard', 'hard_hat', 0.42, 0.08, 0.26, 0, 0.22, 0);
      return w;
    });
    // the robot on the line (built fresh for each spec)
    floor.bot = null;
    put(g, gBox(0.7, 0.7, 0.7), 'wood', 'crate', -7.4, 0.35, 3.0).rotation.y = 0.3;
    put(g, gBox(0.6, 0.6, 0.6), 'wood_light', 'crate', -6.6, 0.3, 3.3).rotation.y = -0.2;
    meshes(g);
    rooms.factory_floor = { g, view: { theta: 0.28, pitch: 0.38 }, fit: new THREE.Box3(new THREE.Vector3(-W / 2 - 0.3, -0.3, -D / 2), new THREE.Vector3(W / 2, H - 0.4, D / 2)) };
    floor.g = g;
  }

  // ---------- the build: about 8.2 s, a pose for every moment (so an interruption simply jumps to the end) ----------
  const T = { press: [0, 1.4], move1: [1.4, 2.0], head: [2.0, 3.2], move2: [3.2, 3.8], paint: [3.8, 5.0], move3: [5.0, 5.6], badge: [5.6, 7.3], out: [7.3, 8.8] };
  const BUILD_S = 8.8;
  const queue = []; let cur = null;
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const seg = (bt, [a, b]) => clamp01((bt - a) / (b - a));
  const ease = (u) => u * u * (3 - 2 * u);
  function makeBot(spec) {
    if (floor.bot) { floor.g.remove(floor.bot.r); }
    const bodyMat = MAT.primer.clone();
    const b = robot(floor.g, 'line_robot', bodyMat, 2.2);
    b.bodyMat = bodyMat;
    b.color = typeof spec.color === 'number' ? new THREE.Color(spec.color) : /^#/.test(String(spec.color)) ? new THREE.Color(spec.color) : new THREE.Color(COLOR_HEX[spec.color] ?? 0xe0b347);
    b.medal = box(b.torso, new THREE.MeshStandardMaterial({ color: new THREE.Color(hexOf(spec.tier)), roughness: 0.4, flatShading: true }), 'tier_medal', 0.1, 0.1, 0.03, -0.11, 0.2, 0.2); b.medal.visible = false;
    b.tokens = (spec.tools || []).filter((t) => ALL_TOOLS.includes(t)).map((t, i, all) => { const m = put(floor.g, gBox(0.26, 0.26, 0.26), floor.tokenMat[t], 'token', 0, 0, 0); m.visible = false; m.userData.slot = i; m.userData.n = all.length; return m; });
    meshes(b.r);
    floor.bot = b;
    return b;
  }
  function pose(bt) {
    const b = floor.bot; if (!b) return;
    const { BY, BZ } = floor.belt, ST = floor.ST;
    // where the robot rides on the belt
    let x = ST[0];
    const uo = seg(bt, T.out), DX = floor.doorX;
    x += (ST[1] - ST[0]) * ease(seg(bt, T.move1)) + (ST[2] - ST[1]) * ease(seg(bt, T.move2)) + (ST[3] - ST[2]) * ease(seg(bt, T.move3)) + (DX - ST[3]) * ease(clamp01(uo / 0.4));
    const hop = clamp01((uo - 0.4) / 0.15), drive = ease(clamp01((uo - 0.55) / 0.45));
    b.r.position.set(x, BY * (1 - hop) + Math.sin(hop * PI) * 0.35, BZ + (-3.3 - BZ) * drive);
    b.r.visible = uo < 0.97;
    floor.roller.position.y = Math.sin(clamp01((uo - 0.3) / 0.7) * PI) * 2.6;
    // press: the torso drops from the press head
    const up = seg(bt, [0, 1.0]);
    b.torso.position.y = 0.14 + (1 - ease(up)) * 1.1; b.treads.visible = true;
    floor.press.arm.position.y = 2.95 - Math.sin(clamp01(bt / 1.3) * PI) * 0.75;
    floor.weld.visible = bt > 1.0 && bt < 1.35 && Math.floor(bt * 12) % 2 === 0;
    // head: lowered by the arm, eyes light at the end
    const hd = seg(bt, [2.1, 2.9]);
    b.head.visible = bt >= 1.95; b.head.position.y = 0.6 + (1 - ease(hd)) * 0.9;
    floor.headSt.arm.position.y = 2.95 - (bt > 1.9 && bt < 3.2 ? Math.sin(seg(bt, [1.9, 3.2]) * PI) * 0.8 : 0);
    const lit = bt >= 3.0;
    for (const e of b.eyes) e.material = lit ? MAT.eyeLit : M.eye;
    // paint: primer -> the agent's colour, a little spray while it happens
    const pu = seg(bt, [3.95, 4.85]);
    b.bodyMat.color.copy(MAT.primer.color).lerp(b.color, pu);
    floor.spray.forEach((p, i) => { const on = bt > 3.9 && bt < 4.9; p.visible = on; if (on) { const u = (bt * 2 + i / 6) % 1; p.position.set(Math.sin(i * 2.1) * 0.25 * u, 1.9 - u * 0.8, -0.3 + u * 0.5); p.material.opacity = 0.8 * (1 - u); } });
    floor.nozzle.rotation.y = bt > 3.9 && bt < 4.9 ? Math.sin(bt * 9) * 0.4 : 0;
    // badge desk: the stamp press stamps the medal, the rack robot hands one token per tool
    const sp = seg(bt, [5.6, 6.2]);
    floor.stampSt.arm.position.y = 2.95 - Math.sin(sp * PI) * 0.62;
    b.medal.visible = bt >= 5.9;
    const n = b.tokens.length, t0 = 6.1, t1 = 7.25;
    b.tokens.forEach((m, i) => {
      const a = t0 + ((t1 - t0) * i) / Math.max(1, n), u = ease(seg(bt, [a, a + (t1 - t0) / Math.max(1, n)]));
      m.visible = bt >= a;
      // from the rack to a row on the robot's back, then it rides along
      const dst = new THREE.Vector3(x + ((i % 3) - 1) * 0.3, b.r.position.y + 1.3 + Math.floor(i / 3) * 0.3, b.r.position.z - 0.62);
      m.position.copy(floor.rackSpot).lerp(dst, u); m.position.y += Math.sin(u * PI) * 0.8;
      if (!b.r.visible) m.visible = false;
    });
    floor.rackRobot.head.rotation.y = bt > 6 && bt < 7.3 ? Math.sin(bt * 6) * 0.3 : 0;
    // the belt scrolls the whole build, faster while the robot moves
    const moving = [T.move1, T.move2, T.move3, T.out].some(([a, z]) => bt > a && bt < z);
    floor.belt.speed = bt < BUILD_S ? (moving ? 2.2 : 0.35) : 0;
    // the workers watch it go by
    floor.workers.forEach((w) => { w.head.rotation.y = Math.max(-1, Math.min(1, (x - w.r.position.x) * -0.25)); });
  }
  function startNext() {
    if (cur || !queue.length) return;
    cur = queue.shift(); cur.t = 0;
    makeBot(cur.spec); pose(0);
    floor.wall.draw(linesForFloor(cur.spec));
    cur.fallback = setTimeout(() => finish(), (BUILD_S + 6) * 1000); // a hidden tab stops tick(); the promise still settles
  }
  function finish() {
    if (!cur) return;
    clearTimeout(cur.fallback);
    pose(BUILD_S + 1);
    if (floor.bot) { for (const m of floor.bot.tokens) floor.g.remove(m); floor.g.remove(floor.bot.r); floor.bot = null; }
    floor.belt.speed = 0; floor.weld.visible = false; floor.spray.forEach((p) => (p.visible = false));
    floor.press.arm.position.y = floor.headSt.arm.position.y = floor.stampSt.arm.position.y = 2.95; floor.roller.position.y = 0;
    const done = cur; cur = null;
    floor.wall.draw(linesForFloor(null));
    done.resolve(done.spec);
    startNext();
  }
  function buildRobot(spec) {
    if (!spec) return Promise.resolve(null);
    return new Promise((resolve) => { queue.push({ spec: { ...spec, tools: spec.tools || [] }, resolve }); startNext(); });
  }
  const cancelBuild = () => { finish(); };
  floor.wall.draw(linesForFloor(null));

  // ===================================== refresh, lamps =====================================
  let lastSeq = null, lastLen = 0;
  function blinkNew(log) {
    const rows = rowsOf(log), maxSeq = rows.length ? rows[rows.length - 1].seq : 0;
    if (lastSeq == null || maxSeq < lastSeq) { lastSeq = maxSeq; return; } // first look (or a new chain): no history blinks
    for (const e of rows) {
      if (e.seq <= lastSeq || (e.decision !== 'allow' && e.decision !== 'deny')) continue;
      for (const k of Object.keys(workshops)) { const lp = workshops[k].lamps[e.tool]; if (lp) workshops[k].blink[e.tool] = { until: now() + 2500, ok: e.decision === 'allow' }; }
    }
    lastSeq = maxSeq;
  }
  const now = () => (globalThis.performance ? performance.now() : Date.now());
  function refresh() {
    const log = getLog(), roster = getRoster(), rows = rowsOf(log);
    checkChain(log);
    if (rows.length > lastLen && lastLen > 0 && currentKey === 'gatehouse') ledger.stamp();
    lastLen = rows.length;
    drawGatehouse(log);
    for (const k of Object.keys(workshops)) drawWorkshop(k, roster, log);
    office.wb.draw(linesForWhiteboard(roster));
    blinkNew(log);
  }

  // ===================================== tamper test =====================================
  let tamperP = null;
  function tamperTest() {
    if (tamperP) return tamperP;
    const log = getLog(), { copy, seq } = tamperCopy(log);
    if (seq == null) return Promise.resolve({ seq: null, brokenAt: null });
    tamperP = verifyChain(copy).then(async (r) => {
      L.tamper = { copy, seq, result: r }; L.healed = null; drawGatehouse(getLog());
      await new Promise((res) => setTimeout(res, 3000));
      L.tamper = null; L.healed = true; L.key = ''; checkChain(getLog()); drawGatehouse(getLog());
      setTimeout(() => { if (!L.tamper) { L.healed = null; drawGatehouse(getLog()); } }, 6000);
      return { seq, brokenAt: r.brokenAt, verified: r.verified };
    }).finally(() => { tamperP = null; });
    return tamperP;
  }

  // ===================================== tick =====================================
  let currentKey = null;
  function tick(t, dt) {
    if (cur) { cur.t += dt; pose(cur.t); if (cur.t >= BUILD_S) finish(); }
    if (floor.belt.speed) { const { BX0, BX1 } = floor.belt, len = BX1 - BX0; floor.belt.off = (floor.belt.off + floor.belt.speed * dt) % len; floor.planks.forEach((p, i) => { p.position.x = BX0 + ((i * floor.belt.PL + floor.belt.off) % len) + floor.belt.PL / 2; }); }
    if (!currentKey) return;
    if (currentKey === 'gatehouse') ledger.tick(t, dt);
    if (workshops[currentKey]) {
      const ws = workshops[currentKey], tn = now();
      for (const [tool, lp] of Object.entries(ws.lamps)) { const b = ws.blink[tool]; lp.material = b && tn < b.until ? (Math.floor((b.until - tn) / 250) % 2 ? (b.ok ? MAT.lampOk : MAT.lampBad) : MAT.lampOff) : MAT.lampOff; }
    }
    if (currentKey === 'factory_floor' && !cur) floor.workers.forEach((w, i) => { w.head.rotation.y = Math.sin(t * 0.5 + i * 2) * 0.35; });
  }

  // ===================================== enter / leave: the camera swap (room.js), now with rotation =====================================
  const alsoHide = [];
  let saved = null;
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  let down = null;
  function onDown(e) { down = { x: e.clientX, y: e.clientY, t: now() }; }
  function onUp(e) {
    if (!down || currentKey !== 'gatehouse') return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y), dtm = now() - down.t; down = null;
    if (moved > 6 || dtm > 600) return; // a drag rotates the room; only a click picks a row
    const seq = seqAt(e.clientX, e.clientY);
    if (seq != null) hooks.onRow?.(seq);
  }
  function seqAt(clientX, clientY) {
    const el = renderer.domElement, r = el.getBoundingClientRect();
    ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, stage._camera);
    const hit = ray.intersectObject(ledger.board.mesh, false)[0];
    if (!hit || !hit.uv) return null;
    const slot = rowAt(hit.uv);
    return slot >= 0 && L.rows[slot] ? L.rows[slot].seq : null;
  }
  function fitCamera(key) {
    const cam = stage._camera, ctl = stage._controls, rm = rooms[key];
    const { theta, pitch } = rm.view;
    const view = new THREE.Vector3(Math.sin(theta) * Math.cos(pitch), Math.sin(pitch), Math.cos(theta) * Math.cos(pitch));
    const right = new THREE.Vector3(Math.cos(theta), 0, -Math.sin(theta)), upv = new THREE.Vector3().crossVectors(view, right);
    const ctr = rm.fit.getCenter(new THREE.Vector3());
    let w = 0, h = 0;
    for (let i = 0; i < 8; i++) {
      const p = new THREE.Vector3(i & 1 ? rm.fit.max.x : rm.fit.min.x, i & 2 ? rm.fit.max.y : rm.fit.min.y, i & 4 ? rm.fit.max.z : rm.fit.min.z).sub(ctr);
      w = Math.max(w, Math.abs(p.dot(right)) * 2); h = Math.max(h, Math.abs(p.dot(upv)) * 2);
    }
    const len = Math.max(30, cam.position.distanceTo(ctl.target));
    ctl.target.copy(ctr); cam.position.copy(ctr).addScaledVector(view, len);
    if (cam.isOrthographicCamera) cam.zoom = Math.min((0.96 * (cam.right - cam.left)) / w, (0.96 * (cam.top - cam.bottom)) / h);
    ctl.minZoom = cam.zoom * 0.85; ctl.maxZoom = cam.zoom * 1.8;
    ctl.enableRotate = true; ctl.enablePan = false;
    ctl.minPolarAngle = 0.15; ctl.maxPolarAngle = 1.42;                   // never under the floor
    ctl.minAzimuthAngle = key === 'gatehouse' ? -0.6 : -0.35; ctl.maxAzimuthAngle = 1.2; // stay on the open side of the cutaway
    cam.updateProjectionMatrix(); ctl.update();
  }
  function enter(key) {
    if (!rooms[key]) return false;
    const cam = stage._camera, ctl = stage._controls;
    if (!saved) {
      saved = { pos: cam.position.clone(), target: ctl.target.clone(), zoom: cam.zoom, bg: stage._scene.background, minZoom: ctl.minZoom, maxZoom: ctl.maxZoom,
        rotate: ctl.enableRotate, pan: ctl.enablePan, px: stage._px, minPolar: ctl.minPolarAngle, maxPolar: ctl.maxPolarAngle, minAz: ctl.minAzimuthAngle, maxAz: ctl.maxAzimuthAngle, hidden: [] };
      for (const o of [stage._object, ...alsoHide]) if (o && o.visible) { o.visible = false; saved.hidden.push(o); }
      stage._scene.background = new THREE.Color('#f3ead7');
      renderer.domElement.addEventListener('pointerdown', onDown);
      renderer.domElement.addEventListener('pointerup', onUp);
      stage.setPixel?.(1);
    }
    for (const k of ROOM_KEYS) rooms[k].g.visible = k === key;
    group.visible = true;
    currentKey = key;
    refresh();
    fitCamera(key);
    return true;
  }
  function leave() {
    if (!saved) return;
    const cam = stage._camera, ctl = stage._controls;
    cam.position.copy(saved.pos); ctl.target.copy(saved.target); cam.zoom = saved.zoom; stage._scene.background = saved.bg;
    ctl.minZoom = saved.minZoom; ctl.maxZoom = saved.maxZoom; ctl.enableRotate = saved.rotate; ctl.enablePan = saved.pan;
    ctl.minPolarAngle = saved.minPolar; ctl.maxPolarAngle = saved.maxPolar; ctl.minAzimuthAngle = saved.minAz; ctl.maxAzimuthAngle = saved.maxAz;
    for (const o of saved.hidden) o.visible = true;
    for (const k of ROOM_KEYS) rooms[k].g.visible = false;
    renderer.domElement.removeEventListener('pointerdown', onDown);
    renderer.domElement.removeEventListener('pointerup', onUp);
    stage.setPixel?.(saved.px || 2);
    saved = null; currentKey = null;
    cam.updateProjectionMatrix(); ctl.update();
  }

  refresh();
  return {
    group, boards, alsoHide,
    enter, leave, current: () => currentKey, tick, refresh,
    stamp: () => ledger.stamp(), tamperTest, buildRobot, cancelBuild,
    seqAt, // (clientX, clientY) -> the ledger row's seq under that screen point, or null (the click handler uses it)
  };
}

// ---- compatibility: build 2's scene.js calls createRoom(ctx) and createLedgerPanels(ctx, room, opts) ----
// Until scene.js imports createRooms itself, this adapter keeps G (the gatehouse) working: the ledger.js shim hands it
// the log through setLog(), and setRoom(on) enters/leaves the gatehouse.
export function createRoom(ctx) {
  let log = [], chain = '', onRow = null;
  const api = createRooms(ctx, { getLog: () => (chain ? { events: log, chain } : log), onRow: (seq) => onRow && onRow(seq) });
  return {
    room: api.group, rooms: api, boards: api.boards, alsoHide: api.alsoHide, stamp: api.stamp, tick: api.tick,
    setRoom(on) { if (on) api.enter('gatehouse'); else api.leave(); },
    inRoom: () => api.current() != null,
    setLog(l, _source, c) { log = l || []; chain = c || chain; api.refresh(); },
    setOnRow(fn) { onRow = fn; },
  };
}
