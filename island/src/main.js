// Wiring: the event feed (live polling or replay) -> apply() -> effects -> scene + HUD.
// The buttons only POST. Nothing on screen changes because of a click; it changes when the gateway's event arrives.
// Pre-existing (v1, this morning): polling with a cursor, the four buttons, R/T/G/Esc, robot click -> JSON, Save
// replay, the iris into the ledger room. New today (docs/ISLAND_V2.md section 7): robot scripts go to the actors,
// replay keeps the recording's own rhythm (real gaps between events, clamped to 0.6..3.5 s, and each robot beat is
// allowed to finish before the next row), the speech bubbles are gone, the gateway strip, and a new chain (someone pressed RESET elsewhere) resets the picture.
// Round two (docs/ISLAND_V2_ADDITIONS.md): the tool chips POST per-tool revoke/restore, the ID card, ledger rows open
// their raw JSON, and A opens the architecture sheet (src/arch.js).
// Build 3 (docs/BUILD3.md section 6): GET /tiers; the Factory's POSTs (mint, tier, retire; a chip's grant uses the
// restore route); a mint from this browser irises into the Factory floor for the production line; the new effects
// (built, inquest, removeRobot, setTier, factorySmoke); a click on a building enters its room; keys H, F, ?; the
// agent sheet replaces the robot click's raw JSON; the chain check runs here (ledger.js verifyChain) for the strip
// and the inquest. Scene calls that builder B1 adds tonight are guarded (scene.x?.()) so the page runs on either scene.
import { createScene } from './scene.js';
import { createHud, normTiers, rowSummary } from './hud.js';
import { ARCH_SHEET } from './arch.js';
import { verifyChain } from './ledger.js';
import { TIERS } from './tiers.js';
import { apply, initialState, withRoster, fresh, gatewayStats, inquestOf, DEFAULT_ROSTER } from './reducer.js';

const cfg = Object.assign({ api: '', adminToken: '', pollMs: 1000, staleAfterMs: 3000 }, window.MYTOPIA || {});
const params = new URLSearchParams(location.search);
const replayPath = params.get('replay');
const source = replayPath ? 'replay' : 'live';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// the scene takes a few seconds to load; a recording must never read STALE (or LIVE) meanwhile
if (source === 'replay') { $('mode').className = 'hud paper REPLAY'; $('mode').innerHTML = 'REPLAY<small>loading the recording</small>'; }

let roster = DEFAULT_ROSTER;
let state = initialState(roster);
let tiers = TIERS;
let lastGoodPoll = null, uiSel = null, recordedOn = '', chainId = '', gwMode = '';
let chain = { verified: null, brokenAt: null, n: -1 }; // the browser's own hash-chain check (verified null: nothing real to check)
// action -> truthy while "sent...": the four buttons hold true; a tool chip holds 'tool:<name>' -> the agent id it acts on;
// 'tier' -> the agent id; 'retire:<id>' -> true
const pendingBtn = {};
const scene = await createScene(document.querySelector('three-d-stage'));
// build 3 scene (B1): robots can leave, the Factory exists. On the scene of this afternoon the new script steps are
// mapped to old ones so the story still reads (build -> spawn, recycle -> sink, cart -> nothing).
const hasFactory = typeof scene.removeRobot === 'function';
const hud = createHud(scene, {
  source, staleAfterMs: cfg.staleAfterMs, lastGoodPoll: () => lastGoodPoll, recordedOn: () => recordedOn, getState: () => state,
  selected: () => selected(), inRoom: () => !!curRoom(), tiers: () => tiers, rawInquest: (id, report) => rawInquest(id, report), mint: (spec) => mint(spec),
});

// one robot per agent in the roster (an unknown client gets no robot: its refusals are drawn at the gatehouse)
const added = new Set(), slots = {}, mintColor = {};
let nextSlot = 0;
function ensureRobots() {
  for (const a of Object.values(state.agents)) {
    if (!a.known || added.has(a.id)) continue;
    if (!(a.id in slots)) slots[a.id] = nextSlot++;
    scene.addRobot(a.id, mintColor[a.id] || a.color, slots[a.id]);
    scene.setTier?.(a.id, a.tier);
    added.add(a.id);
  }
}
// after a new chain: robots whose agent is no longer on the roster (Factory agents retired by RESET) leave
function pruneRobots() {
  for (const id of [...added]) if (!state.agents[id] || !state.agents[id].known) { scene.removeRobot?.(id); added.delete(id); }
}
ensureRobots();

// ---------- effects ----------
// Instant ones apply at once. A 'script' goes to the robot's queue (actors.js plays it step by step; the effects inside
// it come back here through scene.onFx when their moment comes). Banners and stamps are timed DOM pieces: at most three
// play at a time, the rest wait.
// quiet = true: catching up on a backlog, only the state lands (plates, counters, packets, smoke), nothing animates.
// quiet = 'skipped': a robot skipped a script to keep up with the log: the state lands and stamps and lamps still show.
const OLD_STEP = (st) => (st.build ? { spawn: true } : st.recycle ? { sink: true } : st.cart ? null : st);
const MAX_AT_ONCE = 3, queue = []; let playing = 0;
function play(f, quiet = false) {
  const backlog = quiet === true;
  switch (f.kind) {
    case 'script': scene.run(f.agent, hasFactory ? f.steps : f.steps.map(OLD_STEP).filter(Boolean), { instant: backlog }); break;
    case 'plate': scene.setPlate(f.agent, f.plate); break;
    case 'halt': scene.halt(f.agent); break;
    case 'freeze': scene.freeze(f.agent); break;
    case 'powerDown': scene.powerDown(f.agent); break;
    case 'counter': scene.counter(f.gate, f.n); break;
    case 'padlock': scene.padlock(f.gate, f.on); break;
    case 'smoke': scene.smoke(f.gate, f.rung); break;
    case 'packet': scene.packet(backlog); break;
    case 'ack': delete pendingBtn[f.action]; break;
    case 'lamp': if (!backlog) scene.lamp(f.target, f.tone); break;
    case 'slip': if (!quiet) scene.slip(f.from, f.ok); break;
    case 'banner': if (!quiet) { queue.push(f); pump(); } break;
    case 'stampAt': if (!backlog) { queue.push(f); pump(); } break;
    // build 3
    case 'setTier': scene.setTier?.(f.agent, f.tier); break;
    case 'factorySmoke': if (!backlog) scene.factorySmoke?.(true); break;
    case 'built': scene.roomsRefresh?.(); break; // the exterior script plays on its own; this browser's own mint also irises into the floor (mint())
    case 'removeRobot': scene.removeRobot?.(f.agent); added.delete(f.agent); break;
    case 'inquest': hud.showInquest(f.agent, inquestOf(state, f.agent, chain.verified)); break;
  }
}
function timed(f) {
  if (f.kind === 'banner') return hud.banner(f.text, f.tone);
  if (f.kind === 'stampAt') return hud.stampAt(f.anchor, f.text);
  return Promise.resolve();
}
function pump() { while (playing < MAX_AT_ONCE && queue.length) { const f = queue.shift(); playing++; timed(f).finally(() => { playing--; pump(); }); } }
scene.onFx((f, quiet) => play(f, quiet));
// a robot raised its ID card: the DOM card over that gate (window, pen) for 1.2 s, in the robot's colour
scene.onIdCard((id, card) => hud.idCard(card.at, card.lines, state.agents[id]?.color));

// ---------- apply events (one code path for live and replay) ----------
const ADMIN = ['revoked', 'restored', 'kill_requested', 'run_started', 'created', 'tier_changed', 'retired'];
function ingest(events) {
  events.forEach((ev, i) => {
    const r = apply(state, ev);
    state = r.state;
    ensureRobots();
    const quiet = events.length > 4 && i < events.length - 2; // catching up on a backlog: no fireworks for old rows
    for (const f of r.effects) play(f, quiet);
    if (ADMIN.includes(ev.decision) && source === 'live') loadAgents(); // the roster follows every badge change
    if (ev.decision === 'run_started') uiSel = null;
  });
  if (events.length) { scene.drawLedger?.(state.log, source, chainId); scene.roomsRefresh?.(); strip(); checkChain(); hud.renderBadge(); } // the badge names the agent_mode
  render();
}

// ---------- HUD ----------
const selected = () => (uiSel && state.agents[uiSel]?.known ? uiSel : state.selected);
let scanning = null;
function render() {
  hud.render(state, { selected: selected(), pending: pendingBtn, source });
  // the bay's scanner arm sweeps while an inquest panel is open (B1: scene.bayScanning)
  const open = hud.inquestOpen(); if (open !== scanning) { scanning = open; scene.bayScanning?.(!!open); }
}
const chainWord = () => (chain.verified === true ? 'ok' : chain.verified === false ? `broken #${chain.brokenAt}` : 'unverified');
function strip() { hud.setGatewayStrip({ ...gatewayStats(state.log), chain: chainWord() }); }
// the hash chain, checked here in the browser (the same check the ledger room shows) whenever the log grows
async function checkChain() {
  const n = state.log.length; if (n === chain.n) return;
  chain.n = n;
  try {
    const r = await verifyChain(state.log.slice());
    if (n !== state.log.length) return;
    chain = { verified: r.verified ? r.ok : null, brokenAt: r.brokenAt, n }; strip();
    const open = hud.inquestOpen(); if (open) hud.refreshInquest(inquestOf(state, open, chain.verified)); // the panel's "rows hash-verified" line
  } catch {}
}
setInterval(hud.renderBadge, 1000); hud.renderBadge();
// the overlay (name tags, stamps, labels, bin count, the inquest) and the ledger panels follow the 3D scene every frame
function frame() { hud.follow(); scene.panels?.follow?.(); requestAnimationFrame(frame); }
requestAnimationFrame(frame);

// ---------- live: poll the gateway ----------
async function loadAgents() {
  try { const r = await fetch(`${cfg.api}/agents`, { cache: 'no-store' }); if (r.ok) { roster = await r.json(); state = withRoster(state, roster); ensureRobots(); render(); scene.roomsRefresh?.(); } } catch {}
}
// the tier table (GET /tiers); tiers.js until it answers, and in replay when no gateway serves the page
async function loadTiers() {
  try { const r = await fetch(`${cfg.api}/tiers`, { cache: 'no-store' }); if (r.ok) { tiers = normTiers(await r.json()); render(); } } catch {}
}
// local or aws: only an aws gateway keeps the durable copy in DynamoDB (the ledger row sheet says which)
async function loadMode() {
  try { const r = await fetch(`${cfg.api}/healthz`, { cache: 'no-store' }); if (r.ok) gwMode = (await r.json()).mode || ''; } catch {}
}
// GET /events carries the chain id, which changes only on POST /demo/reset: a new id means a fresh log from seq 1
function newChain(id) {
  if (!id) return false;
  const changed = chainId && id !== chainId;
  chainId = id;
  if (!changed) return false;
  // RESET retired every Factory agent: start from the two seed badges, then ask the gateway for the roster again
  state = withRoster(initialState(DEFAULT_ROSTER), roster.filter((r) => r.made_by !== 'factory')); uiSel = null;
  for (const k of Object.keys(pendingBtn)) delete pendingBtn[k];
  scene.reset(); pruneRobots(); hud.closeInquest(); chain = { verified: null, brokenAt: null, n: -1 };
  scene.drawLedger?.(state.log, source, chainId); scene.roomsRefresh?.(); strip(); render(); loadAgents();
  return true;
}
async function poll() {
  try {
    const r = await fetch(`${cfg.api}/events?since_seq=${state.cursor}`, { cache: 'no-store' });
    if (r.ok) {
      const j = await r.json(); lastGoodPoll = Date.now(); hud.renderBadge();
      if (newChain(j.chain)) { setTimeout(poll, 0); return; } // read the new chain from seq 1 right away
      ingest(fresh(j.events, state.cursor));
    }
  } catch {}
  setTimeout(poll, cfg.pollMs);
}

// ---------- replay: the recording's own rhythm, same apply() ----------
async function replay(path) {
  let events = [];
  try {
    const j = await (await fetch(path, { cache: 'no-store' })).json();
    events = Array.isArray(j) ? j : j.events || [];
    chainId = (!Array.isArray(j) && j.chain) || '';
  } catch (e) { $('ticker').innerHTML = `<span class="line">could not load ${esc(path)}</span>`; return; }
  events = events.slice().sort((x, y) => x.seq - y.seq);
  recordedOn = events[0]?.ts ? events[0].ts.slice(0, 10) : ''; hud.renderBadge();
  await sleep(800); // let the first frame settle
  for (let i = 0; i < events.length; i++) {
    ingest([events[i]]);
    const next = events[i + 1]; if (!next) break;
    const gap = (Date.parse(next.ts) - Date.parse(events[i].ts)) / 1000;
    await sleep(1000 * Math.min(3.5, Math.max(0.6, Number.isFinite(gap) ? gap : 1.5)));
    // A recording is watched as a story: let the robots finish this beat on screen (a walk across a bridge, a guard's
    // escort) before the next row lands, at most 12 s more. Live never waits: there the robots speed up instead.
    for (let waited = 0; scene.busy() && waited < 12000; waited += 100) await sleep(100);
  }
}

// ---------- the buttons: POST and wait for the event ----------
const admin = (extra = {}) => ({ 'X-Admin-Token': cfg.adminToken || '', ...extra });
// the gateway's own sentence for a refusal: {"error": ...} (the 403 above the ceiling), or FastAPI's {"detail": ...}
function errText(res, body) {
  if (!res) return 'no answer from the gateway';
  const d = body && (body.error || (body.detail && (body.detail.error || (typeof body.detail === 'string' ? body.detail : Array.isArray(body.detail) && body.detail[0]?.msg))));
  return d || `HTTP ${res.status}`;
}
async function post(url, json) {
  let res = null, body = null;
  try {
    res = await fetch(url, { method: 'POST', headers: admin(json ? { 'Content-Type': 'application/json' } : {}), body: json ? JSON.stringify(json) : undefined });
    body = await res.json().catch(() => null);
  } catch {}
  return { res, body, ok: !!(res && res.ok) };
}
function refused(text) { state = { ...state, ticker: text }; hud.banner(text, 'bad'); render(); }

// Save replay: every event seen, as a file the island can play back with ?replay=<file>
function saveReplay() {
  const blob = new Blob([JSON.stringify({ chain: chainId || undefined, events: state.log }, null, 1)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = `mytopia-replay-${(state.log[0]?.ts || 'empty').slice(0, 19).replace(/[:T]/g, '-')}.json`;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
async function press(act) {
  if (act === 'save') return saveReplay();
  if (source === 'replay' || pendingBtn[act]) return;
  const id = selected();
  const url = act === 'reset' ? `${cfg.api}/demo/reset` : `${cfg.api}/agents/${encodeURIComponent(id)}/${act}`;
  pendingBtn[act] = true; render();
  const { res, body, ok } = await post(url);
  if (act === 'reset') { location.reload(); return; }
  if (!ok) { delete pendingBtn[act]; refused(`${act.toUpperCase()} refused: ${errText(res, body)}`); }
  // on 2xx the label stays "sent..." until the matching event (revoked / restored / kill_requested) arrives
}
function ui(what) {
  if (what === 'factory') toggleSheet('office');
  else if (what === 'help') toggleSheet('help');
  else if (what === 'hide') naked(true);
}
$('ops').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.act) press(b.dataset.act); else if (b.dataset.ui) ui(b.dataset.ui);
});
$('tabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-agent]'); if (b) { uiSel = b.dataset.agent; render(); hud.renderBadge(); } });

// The tool chips: an allowed chip asks for the per-tool revoke; a paper (grant) or pulled one for the restore, which
// now also grants a tool that was never on the badge. A padlocked chip asks too: the gateway answers 403 with its
// sentence ("delete_file is above the Gold ceiling"), shown as a banner while the chip shakes. A chip shows "sent..."
// until the gateway's revoked/restored event for that tool comes back (ack 'tool:<name>'); changed:false logs nothing.
async function pressTool(tool, act, locked) {
  const key = 'tool:' + tool, id = selected();
  if (source === 'replay' || pendingBtn[key]) return;
  if (!locked) { pendingBtn[key] = id; render(); }
  const { res, body, ok } = await post(`${cfg.api}/agents/${encodeURIComponent(id)}/tools/${encodeURIComponent(tool)}/${act}`);
  if (ok && !(body && body.changed === false)) return; // wait for the event
  delete pendingBtn[key];
  if (!ok) { hud.shakeChip(tool); refused(locked || (res && res.status === 403) ? errText(res, body) : `${act.toUpperCase()} ${tool} refused: ${errText(res, body)}`); return; }
  state = { ...state, ticker: `${act.toUpperCase()} ${tool}: ${(body && body.note) || 'nothing changed'}` };
  render();
}
// PROMOTE / DEMOTE: POST /agents/{id}/tier {tier}; the medal changes when the tier_changed event arrives
async function pressTier(to) {
  const id = selected();
  if (source === 'replay' || pendingBtn.tier || !to) return;
  pendingBtn.tier = id; render();
  const { res, body, ok } = await post(`${cfg.api}/agents/${encodeURIComponent(id)}/tier`, { tier: to });
  if (ok && !(body && body.changed === false)) return;
  delete pendingBtn.tier;
  if (!ok) refused(`tier change refused: ${errText(res, body)}`); else render();
}
// RETIRE (Factory office): factory-made agents only; the gateway deletes the client and the row, then logs retired
async function pressRetire(id) {
  const key = 'retire:' + id;
  if (source === 'replay' || pendingBtn[key]) return;
  pendingBtn[key] = true; render();
  const { res, body, ok } = await post(`${cfg.api}/agents/${encodeURIComponent(id)}/retire`);
  if (!ok) { delete pendingBtn[key]; refused(`RETIRE refused: ${errText(res, body)}`); }
}
// the card, the agent sheet and the office share one click handler: chips, tier arrows, the three buttons, RETIRE
function onPanelClick(e) {
  const b = e.target.closest('button'); if (!b || b.disabled) return;
  if (b.dataset.tool) pressTool(b.dataset.tool, b.dataset.act, !!b.dataset.locked);
  else if ('tier' in b.dataset) pressTier(b.dataset.tier);
  else if (b.dataset.retire) pressRetire(b.dataset.retire);
  else if (b.dataset.ui === 'inspect') { const id = selected(); openSheet(null); hud.showInquest(id, inquestOf(state, id, chain.verified)); }
  else if (b.dataset.act && e.currentTarget.id === 'agent') press(b.dataset.act);
}
for (const id of ['card', 'agent', 'office']) $(id).addEventListener('click', onPanelClick);

// NEW AGENT: POST /agents. On 201 from this browser the sheet closes, the island irises into the Factory floor where
// the line builds the robot (scene.buildRobot), then irises back; the created event's exterior script (the robot
// rolls from the Factory door to the yard) plays meanwhile or after, so the robot ends in the yard either way.
async function mint(spec) {
  if (source === 'replay') return { ok: false, error: 'This is a recording: the Factory is read-only.' };
  const { res, body, ok } = await post(`${cfg.api}/agents`, spec);
  if (!ok) return { ok: false, error: errText(res, body) };
  mintColor[spec.agent] = spec.color;
  loadAgents();
  openSheet(null);
  buildFlow({ id: spec.agent, name: spec.name, color: spec.color, tier: spec.tier, tools: spec.tools });
  return { ok: true };
}
async function buildFlow(spec) {
  if (typeof scene.buildRobot !== 'function' || typeof scene.enterRoom !== 'function') return;
  await enterRoom('factory_floor');
  try { await Promise.race([scene.buildRobot(spec), sleep(12000)]); } catch (e) { console.warn('buildRobot', e); }
  if (curRoom() === 'factory_floor') await leaveRoom();
}

// ---------- rooms: every building has an interior (rooms.js, builder B2), entered through an iris wipe ----------
const ROOM_WORDS = {
  gatehouse: ['GATEHOUSE', '· the ledger and the hash chain: every call, in order'],
  files: ['FILES TOWER', '· read and search the company drive'],
  github: ['GITHUB STUDIO', '· file tickets and list them'],
  mail: ['MAIL COTTAGE', '· send email for the company'],
  admin: ['ADMIN COURTHOUSE', '· delete files: Diamond badges only'],
  factory_office: ['FACTORY OFFICE', '· badges are made, ranked and retired here'],
  factory_floor: ['FACTORY FLOOR', '· the production line that builds robots'],
};
// the room on screen: the build 3 scene names it; this afternoon's scene only had the gatehouse
const curRoom = () => (typeof scene.roomKey === 'function' ? scene.roomKey() : scene.inRoom() ? 'gatehouse' : null) || null;
let irisBusy = false;
async function iris(change) {
  irisBusy = true; $('iris').classList.add('shut'); await sleep(380);
  try { change(); } catch (e) { console.warn('room change', e); }
  $('iris').classList.remove('shut'); await sleep(380); irisBusy = false;
}
function titleRoom(key) {
  const [name, sub] = ROOM_WORDS[key] || [String(key).toUpperCase(), ''];
  $('r-name').textContent = name; $('r-sub').textContent = sub;
  $('r-tamper').style.display = key === 'gatehouse' ? '' : 'none';
  $('r-office').style.display = key === 'factory_office' ? '' : 'none';
}
async function enterRoom(key) {
  if (irisBusy || !key || curRoom() === key) return;
  if (typeof scene.enterRoom !== 'function' && key !== 'gatehouse') return; // no interiors on this scene yet
  await iris(() => {
    if (typeof scene.enterRoom === 'function') scene.enterRoom(key); else scene.setRoom(true);
    titleRoom(key); document.body.classList.add('room');
    scene.drawLedger?.(state.log, source, chainId); scene.roomsRefresh?.();
  });
  if (key === 'factory_office') openSheet('office');
}
async function leaveRoom() {
  if (irisBusy || !curRoom()) return;
  await iris(() => {
    if (typeof scene.leaveRoom === 'function') scene.leaveRoom(); else scene.setRoom(false);
    document.body.classList.remove('room'); hud.relayout();
  });
}
$('back').addEventListener('click', () => leaveRoom());
$('r-tamper').addEventListener('click', () => scene.tamperTest?.());
$('r-office').addEventListener('click', () => toggleSheet('office'));

// ---------- the sheets: T table, one row's raw JSON, A architecture, the agent, the Factory office, the help ----------
const SHEETS = ['table', 'json', 'arch', 'agent', 'office', 'help'];
function openSheet(id) {
  for (const s of SHEETS) $(s).classList.toggle('on', s === id);
  if (id === 'office') hud.openOffice();
  render();
}
function toggleSheet(id) { openSheet($(id).classList.contains('on') ? null : id); }
function showJson(title, ev, foot = '', summary = '') {
  $('j-title').textContent = title;
  $('j-sum').textContent = summary;
  $('j-body').textContent = ev ? JSON.stringify(ev, null, 2) : 'no event yet';
  $('j-foot').textContent = foot;
  openSheet('json');
}
// A ledger row opens the row exactly as the gateway stored it, with one plain sentence above it and where its durable copy lives
function onRow(seq) {
  const ev = state.log.find((x) => x.seq === seq); if (!ev) return;
  const where = source === 'replay' ? (chainId ? `recorded chain ${chainId}, seq ${ev.seq}` : 'a recording without a chain id')
    : gwMode === 'local' ? `local mode: the row sits in the gateway's memory log and JSONL file, chain ${chainId || '—'}, seq ${ev.seq}`
      : `the same row sits in DynamoDB mytopia_events, pk ${chainId || '—'}, seq ${ev.seq}`;
  showJson(`#${ev.seq} · ${ev.decision} ${ev.tool} · the row as the gateway stored it`, ev, where, rowSummary(ev, state));
}
scene.onLedgerRow?.(onRow);
// the rooms read the island's state through these (B2: createRooms(ctx, hooks))
const rosterRows = () => Object.values(state.agents).filter((a) => a.known).map((a) => ({
  agent: a.id, id: a.id, name: a.name, tier: a.tier, ceiling: a.ceiling, role: a.role, made_by: a.madeBy, madeBy: a.madeBy, color: a.color,
  status: a.plate === 'revoked' ? 'REVOKED' : a.plate === 'stopped' || a.plate === 'kill' ? 'KILLED' : 'ACTIVE', plate: a.plate, at: a.at,
  allowed_tools: a.allowedTools.slice(), allowedTools: a.allowedTools.slice(), client_id: a.clientId,
}));
scene.setRoomHooks?.({ getLog: () => state.log, getRoster: rosterRows, getInquest: (id) => inquestOf(state, id, chain.verified), onRow, getChain: () => chainId });
// the inquest's raw report: live, the gateway's own GET /agents/{id}/inquest; in replay, the island's computed copy
async function rawInquest(id, report) {
  if (source === 'live') {
    try {
      const r = await fetch(`${cfg.api}/agents/${encodeURIComponent(id)}/inquest`, { cache: 'no-store', headers: admin() });
      if (r.ok) { showJson(`Inquest · ${id} · from the gateway`, await r.json(), `GET /agents/${id}/inquest, computed from the chain in the gateway's memory`); return; }
    } catch {}
  }
  showJson(`Inquest · ${id} · computed in this browser`, report, source === 'replay' ? 'replay: computed from the recording by inquestOf() (the gateway computes the same from its chain)' : 'the gateway did not answer GET /agents/{id}/inquest: computed in this browser from the same rows');
}

// ---------- hide panels (H) ----------
function naked(on) { document.body.classList.toggle('naked', on); hud.relayout(); }
$('pill').addEventListener('click', () => naked(false));

// ---------- keyboard, robot and building clicks ----------
addEventListener('keydown', (e) => {
  if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key;
  if (k === 't' || k === 'T') { toggleSheet('table'); hud.renderTable(state); }
  else if (k === 'a' || k === 'A') { if (!$('arch').innerHTML) $('arch').innerHTML = ARCH_SHEET; toggleSheet('arch'); }
  else if (k === 'r' || k === 'R') { const p = replayPath || 'fixture.json'; location.search = `?replay=${encodeURIComponent(p)}`; }
  else if (k === 'g' || k === 'G') { if (curRoom()) leaveRoom(); else enterRoom('gatehouse'); }
  else if (k === 'h' || k === 'H') naked(!document.body.classList.contains('naked'));
  else if (k === 'f' || k === 'F') toggleSheet('office');
  else if (k === '?' || (k === '/' && e.shiftKey)) toggleSheet('help');
  else if (k === 'Escape') {
    const open = SHEETS.some((s) => $(s).classList.contains('on'));
    if (open) openSheet(null);
    else if (hud.inquestOpen()) { hud.closeInquest(); render(); } // the agent card comes back
    else if (document.body.classList.contains('naked')) naked(false); else leaveRoom();
  }
});
// a click (not the end of a drag that turned the camera): a robot first, then a building
const stage = document.querySelector('three-d-stage');
let down = null;
stage.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
stage.addEventListener('click', (e) => {
  if (down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 6) return;
  if (curRoom()) return; // inside a room, the room's own boards take the clicks (rooms.js)
  const id = scene.pickRobot(e.clientX, e.clientY);
  if (id && state.agents[id]?.known) { uiSel = id; hud.openAgentSheet(id); openSheet('agent'); hud.renderBadge(); return; }
  const key = typeof scene.pickBuilding === 'function' ? scene.pickBuilding(e.clientX, e.clientY) : scene.nearGate(e.clientX, e.clientY) ? 'gatehouse' : null;
  if (key) enterRoom(key);
});

render(); strip();
if (source === 'replay') replay(replayPath); // replay keeps tiers.js: the same table, and no gateway to ask
else { loadTiers(); loadAgents(); loadMode(); poll(); }
