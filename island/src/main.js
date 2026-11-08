// Wiring: the event feed (live polling or replay) -> apply() -> effects -> scene + HUD.
// The buttons only POST. Nothing on screen changes because of a click; it changes when the gateway's event arrives.
// Pre-existing (v1, this morning): polling with a cursor, the four buttons, R/T/G/Esc, robot click -> JSON, Save
// replay, the iris into the ledger room. New today (docs/ISLAND_V2.md section 7): robot scripts go to the actors,
// replay keeps the recording's own rhythm (real gaps between events, clamped to 0.6..3.5 s, and each robot beat is
// allowed to finish before the next row), the speech bubbles are gone, the gateway strip, and a new chain (someone pressed RESET elsewhere) resets the picture.
// Round two (docs/ISLAND_V2_ADDITIONS.md): the tool chips POST per-tool revoke/restore, the ID card, ledger rows open
// their raw JSON, and A opens the architecture sheet (src/arch.js).
import { createScene } from './scene.js';
import { createHud } from './hud.js';
import { ARCH_SHEET } from './arch.js';
import { apply, initialState, withRoster, fresh, gatewayStats, DEFAULT_ROSTER } from './reducer.js';

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
let lastGoodPoll = null, uiSel = null, recordedOn = '', chainId = '', gwMode = '';
// action -> truthy while "sent...": the four buttons hold true; a tool chip holds 'tool:<name>' -> the agent id it acts on
const pendingBtn = {};
const scene = await createScene(document.querySelector('three-d-stage'));
const hud = createHud(scene, { source, staleAfterMs: cfg.staleAfterMs, lastGoodPoll: () => lastGoodPoll, recordedOn: () => recordedOn, getState: () => state, selected: () => selected() });

// one robot per agent in the roster (an unknown client gets no robot: its refusals are drawn at the gatehouse)
function ensureRobots() {
  let slot = 0;
  for (const a of Object.values(state.agents)) if (a.known) scene.addRobot(a.id, a.color, slot++);
}
ensureRobots();

// ---------- effects ----------
// Instant ones apply at once. A 'script' goes to the robot's queue (actors.js plays it step by step; the effects inside
// it come back here through scene.onFx when their moment comes). Banners and stamps are timed DOM pieces: at most three
// play at a time, the rest wait.
// quiet = true: catching up on a backlog, only the state lands (plates, counters, packets, smoke), nothing animates.
// quiet = 'skipped': a robot skipped a script to keep up with the log: the state lands and stamps and lamps still show.
const MAX_AT_ONCE = 3, queue = []; let playing = 0;
function play(f, quiet = false) {
  const backlog = quiet === true;
  switch (f.kind) {
    case 'script': scene.run(f.agent, f.steps, { instant: backlog }); break;
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
function ingest(events) {
  events.forEach((ev, i) => {
    const r = apply(state, ev);
    state = r.state;
    ensureRobots();
    const quiet = events.length > 4 && i < events.length - 2; // catching up on a backlog: no fireworks for old rows
    for (const f of r.effects) play(f, quiet);
    if (['revoked', 'restored', 'kill_requested', 'run_started'].includes(ev.decision) && source === 'live') loadAgents();
    if (ev.decision === 'run_started') uiSel = null;
  });
  if (events.length) { scene.drawLedger(state.log, source, chainId); strip(); hud.renderBadge(); } // the badge names the agent_mode
  render();
}

// ---------- HUD ----------
const selected = () => uiSel || state.selected;
function render() { hud.render(state, { selected: selected(), pending: pendingBtn, source }); }
function strip() { hud.setGatewayStrip({ ...gatewayStats(state.log), chain: scene.panels.verified() }); }
scene.onChain(strip);
setInterval(hud.renderBadge, 1000); hud.renderBadge();
// the overlay (name tags, stamps, labels, bin count) and the ledger panels follow the 3D scene every frame
function frame() { hud.follow(); scene.panels.follow(); requestAnimationFrame(frame); }
requestAnimationFrame(frame);

// ---------- live: poll the gateway ----------
async function loadAgents() {
  try { const r = await fetch(`${cfg.api}/agents`, { cache: 'no-store' }); if (r.ok) { roster = await r.json(); state = withRoster(state, roster); ensureRobots(); render(); } } catch {}
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
  state = withRoster(initialState(roster), roster); uiSel = null;
  for (const k of Object.keys(pendingBtn)) delete pendingBtn[k];
  scene.reset(); scene.drawLedger(state.log, source, chainId); strip(); render();
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
  let res = null;
  try { res = await fetch(url, { method: 'POST', headers: { 'X-Admin-Token': cfg.adminToken || '' } }); } catch {}
  if (act === 'reset') { location.reload(); return; }
  if (!res || !res.ok) {
    delete pendingBtn[act];
    state = { ...state, ticker: `${act.toUpperCase()} refused: ${res ? 'HTTP ' + res.status : 'no answer from the gateway'}` };
    render();
  } // on 2xx the label stays "sent..." until the matching event (revoked / restored / kill_requested) arrives
}
$('ops').addEventListener('click', (e) => { const b = e.target.closest('button[data-act]'); if (b) press(b.dataset.act); });
$('tabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-agent]'); if (b) { uiSel = b.dataset.agent; render(); hud.renderBadge(); } });

// The tool chips (round two, section 1): an allowed chip asks for the per-tool revoke, a pulled one for the restore.
// The chip shows "sent..." until the gateway's revoked/restored event for that tool comes back (ack 'tool:<name>').
// The gateway answers changed:false (and logs nothing) when the badge already says so: then no event will come.
async function pressTool(tool, act) {
  const key = 'tool:' + tool, id = selected();
  if (source === 'replay' || pendingBtn[key]) return;
  pendingBtn[key] = id; render();
  let res = null, body = null;
  try {
    res = await fetch(`${cfg.api}/agents/${encodeURIComponent(id)}/tools/${encodeURIComponent(tool)}/${act}`, { method: 'POST', headers: { 'X-Admin-Token': cfg.adminToken || '' } });
    body = await res.json().catch(() => null);
  } catch {}
  if (res && res.ok && !(body && body.changed === false)) return; // wait for the event
  delete pendingBtn[key];
  const why = res && res.ok ? (body && body.note) || 'nothing changed' : `refused: ${res ? 'HTTP ' + res.status : 'no answer from the gateway'}`;
  state = { ...state, ticker: `${act.toUpperCase()} ${tool}: ${why}` };
  render();
}
$('c-chips').addEventListener('click', (e) => { const b = e.target.closest('button[data-tool]'); if (b && b.dataset.act) pressTool(b.dataset.tool, b.dataset.act); });

// ---------- the gatehouse ledger room, entered through an iris wipe ----------
let irisBusy = false;
async function room(on) {
  if (irisBusy || scene.inRoom() === on) return;
  irisBusy = true; $('iris').classList.add('shut'); await sleep(380);
  scene.setRoom(on); document.body.classList.toggle('room', on); scene.drawLedger(state.log, source, chainId);
  $('iris').classList.remove('shut'); await sleep(380); irisBusy = false;
}
$('back').addEventListener('click', () => room(false));

// ---------- the sheets: T table, the raw JSON of one row, A architecture (one open at a time) ----------
const SHEETS = ['table', 'json', 'arch'];
function openSheet(id) { for (const s of SHEETS) $(s).classList.toggle('on', s === id); }
function showJson(title, ev, foot = '') {
  $('j-title').textContent = title;
  $('j-body').textContent = ev ? JSON.stringify(ev, null, 2) : 'no event yet';
  $('j-foot').textContent = foot;
  openSheet('json');
}
// A ledger row opens the row exactly as the gateway stored it, and says where its durable copy lives
scene.onLedgerRow((seq) => {
  const ev = state.log.find((x) => x.seq === seq); if (!ev) return;
  const where = source === 'replay' ? (chainId ? `recorded chain ${chainId}, seq ${ev.seq}` : 'a recording without a chain id')
    : gwMode === 'local' ? `local mode: the row sits in the gateway's memory log and JSONL file, chain ${chainId || '—'}, seq ${ev.seq}`
      : `the same row sits in DynamoDB mytopia_events, pk ${chainId || '—'}, seq ${ev.seq}`;
  showJson(`#${ev.seq} · ${ev.decision} ${ev.tool} · the row as the gateway stored it`, ev, where);
});

// ---------- keyboard and robot click ----------
addEventListener('keydown', (e) => {
  if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
  if (e.key === 't' || e.key === 'T') { openSheet($('table').classList.contains('on') ? null : 'table'); hud.renderTable(state); }
  else if (e.key === 'a' || e.key === 'A') { if (!$('arch').innerHTML) $('arch').innerHTML = ARCH_SHEET; openSheet($('arch').classList.contains('on') ? null : 'arch'); }
  else if (e.key === 'r' || e.key === 'R') { const p = replayPath || 'fixture.json'; location.search = `?replay=${encodeURIComponent(p)}`; }
  else if (e.key === 'g' || e.key === 'G') room(!scene.inRoom());
  else if (e.key === 'Escape') { const open = SHEETS.some((s) => $(s).classList.contains('on')); openSheet(null); if (!open) room(false); }
});
document.querySelector('three-d-stage').addEventListener('click', (e) => {
  if (scene.inRoom()) return;
  const id = scene.pickRobot(e.clientX, e.clientY);
  if (!id) { if (scene.nearGate(e.clientX, e.clientY)) room(true); return; }
  uiSel = id; render(); hud.renderBadge();
  const ev = [...state.log].reverse().find((x) => x.agent === id);
  showJson(`${state.agents[id]?.name || id}: latest event`, ev);
});

render(); strip();
if (source === 'replay') replay(replayPath);
else { loadAgents(); loadMode(); poll(); }
