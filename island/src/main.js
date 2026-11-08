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
import { createHud, normTiers, normJobs, rowSummary } from './hud.js';
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
if (source === 'replay') { $('mode').className = 'hud paper REPLAY'; $('mode').innerHTML = 'REPLAY<small>loading · R or click: LIVE</small>'; }

let roster = DEFAULT_ROSTER;
let state = initialState(roster);
let tiers = TIERS;
let jobs = []; // build 4: GET /jobs
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
  selected: () => selected(), inRoom: () => !!curRoom(), tiers: () => tiers, rawInquest: (id, report) => rawInquest(id, report), mint: (spec, opts) => mint(spec, opts),
  jobs: () => jobs, rerender: () => render(), // build 4
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
    case 'banner': if (!quiet) { bannerQ.push(f); if (bannerQ.length > 3) bannerQ.shift(); pumpBanner(); } break;
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
// banners one at a time, in order, at most three waiting (the newest kept)
const bannerQ = []; let bannerBusy = false;
function pumpBanner() { if (bannerBusy || !bannerQ.length) return; const f = bannerQ.shift(); bannerBusy = true; hud.banner(f.text, f.tone).finally(() => { bannerBusy = false; pumpBanner(); }); }
scene.onFx((f, quiet) => play(f, quiet));
// a robot raised its ID card: the DOM card over that gate (window, pen) for 1.2 s, in the robot's colour
scene.onIdCard((id, card) => hud.idCard(card.at, card.lines, state.agents[id]?.color));

// ---------- apply events (one code path for live and replay) ----------
const ADMIN = ['revoked', 'restored', 'kill_requested', 'run_started', 'created', 'tier_changed', 'retired'];
function ingest(events) {
  events.forEach((ev, i) => {
    const r = apply(state, ev);
    state = r.state; state.tickerLocal = false; // a row arrived: the ticker shows it again
    ensureRobots();
    const quiet = events.length > 4 && i < events.length - 2; // catching up on a backlog: no fireworks for old rows
    for (const f of r.effects) play(f, quiet);
    if (ADMIN.includes(ev.decision) && source === 'live') loadAgents(); // the roster follows every badge change
    // build 4 (review): a run_started no longer drops the operator's own tab choice (KILL could hit the agent that just
    // started); with no choice made, the card follows the newest run (state.selected); START and BUILD select their agent
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
// build 4: the job book (GET /jobs, contract/jobs.json); empty until it answers, so the job controls stay hidden
// on a gateway without it and in replay
async function loadJobs() {
  try { const r = await fetch(`${cfg.api}/jobs`, { cache: 'no-store' }); if (r.ok) { jobs = normJobs(await r.json()); hud.jobsChanged(); render(); } } catch {}
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
function refused(text) { state = { ...state, ticker: text, tickerLocal: true }; hud.toast(text); render(); }

// Save replay: every event seen, as a file the island can play back with ?replay=<file>
function saveReplay() {
  const blob = new Blob([JSON.stringify({ chain: chainId || undefined, events: state.log }, null, 1)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = `mytopia-replay-${(state.log[0]?.ts || 'empty').slice(0, 19).replace(/[:T]/g, '-')}.json`;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
// forId (build 4): the agent sheet's own robot; the card and the operator panel act on the selected agent
async function press(act, forId = null) {
  if (act === 'save') return saveReplay();
  if (act === 'start') { const id = forId || selected(), c = hud.workChoice(id); return startAgent(id, c.job, c.brain); }
  if (source === 'replay' || pendingBtn[act]) return;
  const id = forId || selected();
  const url = act === 'reset' ? `${cfg.api}/demo/reset` : `${cfg.api}/agents/${encodeURIComponent(id)}/${act}`;
  pendingBtn[act] = true; render();
  const { res, body, ok } = await post(url);
  if (act === 'reset') { location.reload(); return; }
  if (!ok) { delete pendingBtn[act]; refused(`${act.toUpperCase()} refused: ${errText(res, body)}`); return; }
  // user test: a repeat click (already KILLED, already ACTIVE) changes nothing and logs no row: say so, never wait for one
  if (body && body.changed === false) { delete pendingBtn[act]; state = { ...state, ticker: body.note || `${act.toUpperCase()}: nothing changed`, tickerLocal: true }; hud.toast(body.note || `${act.toUpperCase()}: nothing changed`); render(); }
  // on 2xx the label stays "sent..." until the matching event (revoked / restored / kill_requested) arrives
}
// START (build 4): POST /agents/{id}/start {job, brain}. The gateway starts the launcher (which mints the token,
// starts the agent's program and owns it, so KILL still kills); "sent..." stays until that run's run_started arrives
// (ack 'start:<id>'), or 25 s if it never does (the launcher's log says why).
async function startAgent(id, job, brain = 'scripted') {
  const key = 'start:' + id;
  if (source === 'replay' || pendingBtn[key] || !id) return;
  const selAtPress = uiSel; // user test: the answer can take seconds; never jump away from a tab picked meanwhile
  const token = {}; // build 4 (fix review): one per press, so an older press's 25 s timer never fires on a newer one
  pendingBtn[key] = token; render();
  const { res, body, ok } = await post(`${cfg.api}/agents/${encodeURIComponent(id)}/start`, { job, brain });
  if (!ok) { delete pendingBtn[key]; refused(`START refused: ${errText(res, body)}`); return; }
  const j = jobs.find((x) => x.job === (body && body.job) || x.job === job);
  if (uiSel === selAtPress) uiSel = id; // the card follows the agent just started, unless another was picked meanwhile
  if ($('agent').classList.contains('on') && hud.sheetAgent() === id) openSheet(null); // build 4 (review): the sheet must not hide its walk, an escort or the inquest
  state = { ...state, ticker: `START ${state.agents[id]?.name || id}: ${j ? j.name : job} (${brain === 'model' ? 'AI · Nova 2 Lite' : 'scripted'}), launcher pid ${body && body.pid}` };
  render();
  // build 4 (review): a launcher that dies after the gateway's start check never posts run_started: say so, don't just go quiet
  setTimeout(() => { if (pendingBtn[key] === token) { delete pendingBtn[key]; refused(`START ${state.agents[id]?.name || id}: the program did not report in 25 s (the gateway console and launcher/logs say why)`); } }, 25000);
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
async function pressTool(tool, act, locked, forId = null) {
  const key = 'tool:' + tool, id = forId || selected();
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
async function pressTier(to, forId = null) {
  const id = forId || selected();
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
  // build 4: a button in the agent sheet acts on the sheet's own robot, even when another agent's run_started has
  // moved the card meanwhile (two agents working at once made "the selected agent" the wrong target)
  const forId = e.currentTarget.id === 'agent' ? (hud.sheetAgent() || null) : null;
  if (b.dataset.tool) pressTool(b.dataset.tool, b.dataset.act, !!b.dataset.locked, forId);
  else if ('tier' in b.dataset) pressTier(b.dataset.tier, forId);
  else if (b.dataset.retire) pressRetire(b.dataset.retire);
  else if (b.dataset.ui === 'inspect') { const id = forId || selected(); openSheet(null); hud.showInquest(id, inquestOf(state, id, chain.verified)); }
  else if (b.dataset.act && e.currentTarget.id === 'agent') press(b.dataset.act, forId);
}
for (const id of ['card', 'agent', 'office']) $(id).addEventListener('click', onPanelClick);

// NEW AGENT: POST /agents. On 201 from this browser the sheet closes, the island irises into the Factory floor where
// the line builds the robot (scene.buildRobot), then irises back; the created event's exterior script (the robot
// rolls from the Factory door to the yard) plays meanwhile or after, so the robot ends in the yard either way.
// Build 4: opts.start -> once the badge exists, START it right away with its job (opts.brain), so the robot rolls out
// of the Factory and goes straight to work.
async function mint(spec, opts = {}) {
  if (source === 'replay') return { ok: false, error: 'This is a recording: the Factory is read-only.' };
  const { res, body, ok } = await post(`${cfg.api}/agents`, spec);
  if (!ok) return { ok: false, error: errText(res, body) };
  mintColor[spec.agent] = spec.color;
  loadAgents();
  openSheet(null);
  const built = buildFlow({ id: spec.agent, name: spec.name, color: spec.color, tier: spec.tier, tools: spec.tools });
  // build 4 (review): START once the line has built it and the iris is back on the island, so the robot is seen rolling
  // out and walking to work (started at once, its first calls played while the island was hidden in the floor room)
  if (opts.start && spec.job) { uiSel = spec.agent; built.finally(() => startAgent(spec.agent, spec.job, opts.brain)); }
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
  status: a.plate === 'revoked' ? (a.quarantined ? 'QUARANTINED' : 'REVOKED') : a.plate === 'kill' || (a.plate === 'stopped' && String(a.stopNote || '').startsWith('run stopped')) ? 'KILLED'
    : (a.status && a.status !== 'ACTIVE' ? a.status : 'ACTIVE'), plate: a.plate, at: a.at, // user test: a finished job read KILLED on the boards
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

// ---------- R: the recording and back (build 4: it used to be a one-way door into replay) ----------
// live -> the recording (?replay=...); replay -> the live island (the replay parameter dropped, any other kept).
// A click on the grey REPLAY badge does the same as R.
function toggleReplay() {
  const p = new URLSearchParams(location.search);
  if (source === 'replay') p.delete('replay'); else p.set('replay', replayPath || 'fixture.json');
  const q = p.toString();
  location.href = location.pathname + (q ? `?${q}` : '') + location.hash;
}
$('mode').addEventListener('click', () => { if (source === 'replay') toggleReplay(); });

// ---------- hide panels (H) ----------
function naked(on) { document.body.classList.toggle('naked', on); hud.relayout(); }
$('pill').addEventListener('click', () => naked(false));

// ---------- keyboard, robot and building clicks ----------
addEventListener('keydown', (e) => {
  if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) {
    if (e.key === 'Escape' && e.target.tagName === 'SELECT') e.target.blur(); // build 4 (review): Esc still closes a sheet from the job dropdown
    else return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key;
  if (/^[tTaAfF?]$/.test(k) && document.body.classList.contains('naked')) naked(false); // user test: sheets opened invisibly while hidden
  if (k === 't' || k === 'T') { toggleSheet('table'); hud.renderTable(state); }
  else if (k === 'a' || k === 'A') { if (!$('arch').innerHTML) $('arch').innerHTML = ARCH_SHEET; toggleSheet('arch'); }
  else if (k === 'r' || k === 'R') toggleReplay();
  else if (k === 'c' || k === 'C') { if (scene.recenter?.()) state = { ...state, ticker: 'camera back to the centre (C)' }; render(); }
  else if (k === 'g' || k === 'G') { if (curRoom()) leaveRoom(); else enterRoom('gatehouse'); }
  else if (k === 'h' || k === 'H') naked(!document.body.classList.contains('naked'));
  else if (k === 'f' || k === 'F') toggleSheet('office');
  else if (k === '?' || (k === '/' && e.shiftKey)) toggleSheet('help');
  else if (k === 'Escape') {
    const open = SHEETS.some((s) => $(s).classList.contains('on'));
    if (open) openSheet(null);
    else if (curRoom()) leaveRoom(); // user test: a room hides the inquest panel, so Esc leaves the room first
    else if (hud.inquestOpen()) { hud.closeInquest(); render(); } // the agent card comes back
    else if (document.body.classList.contains('naked')) naked(false);
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
else { loadTiers(); loadJobs(); loadAgents(); loadMode(); poll(); }
