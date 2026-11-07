// Wiring: the event feed (live polling or replay) -> apply() -> effects queue -> scene + HUD.
// The buttons only POST. Nothing on screen changes because of a click; it changes when the gateway's event arrives.
import { createScene } from './scene.js';
import { apply, initialState, withRoster, badge, fresh, DEFAULT_ROSTER, ALL_TOOLS } from './reducer.js';

const cfg = Object.assign({ api: '', adminToken: '', pollMs: 1000, staleAfterMs: 3000 }, window.MYTOPIA || {});
const params = new URLSearchParams(location.search);
const replayPath = params.get('replay');
const source = replayPath ? 'replay' : 'live';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));

let roster = DEFAULT_ROSTER;
let state = initialState(roster);
let lastGoodPoll = null, uiSel = null, recordedOn = '';
const scene = await createScene(document.querySelector('three-d-stage'));
const ensureRobots = () => Object.values(state.agents).forEach((a, i) => scene.addRobot(a.id, a.color, i));
ensureRobots();

// ---------- effects: instant ones apply at once; timed ones queue, at most three at a time ----------
const MAX_AT_ONCE = 3, queue = []; let playing = 0;
const bubbles = {}; // agent -> { text, tone }
const pendingBtn = {}; // action -> true while "sent..."
function instant(f) {
  switch (f.kind) {
    case 'plate': scene.setPlate(f.agent, f.plate); break;
    case 'move': scene.move(f.agent, f.to); break;
    case 'freeze': scene.freeze(f.agent); break;
    case 'lamp': scene.lamp(f.building); break;
    case 'ladder': scene.ladder(f.building, f.rung, f.fire); break;
    case 'say': bubbles[f.agent] = { text: f.text, tone: f.tone, at: performance.now() }; break;
    case 'ack': delete pendingBtn[f.action]; break;
    case 'counter': break; // the count is read from state in render()
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function timed(f) {
  if (f.kind === 'spark') return scene.spark(f.agent, f.to, f.ok).then(() => { if (!f.ok) scene.dropPacket(); });
  if (f.kind === 'banner') { const b = $('banner'); b.textContent = f.text; b.className = `hud paper on ${f.tone}`; return sleep(2000).then(() => { if (b.textContent === f.text) b.classList.remove('on'); }); }
  if (f.kind === 'stamp') { const p = scene.robotScreen(f.agent); if (!p) return Promise.resolve(); const el = document.createElement('div'); el.className = 'stamp'; el.textContent = f.text; el.style.left = p[0] + 60 + 'px'; el.style.top = p[1] + 40 + 'px'; $('overlay').appendChild(el); return sleep(1600).then(() => el.remove()); }
  return Promise.resolve();
}
const TIMED = new Set(['spark', 'banner', 'stamp']);
function pump() { while (playing < MAX_AT_ONCE && queue.length) { const f = queue.shift(); playing++; timed(f).finally(() => { playing--; pump(); }); } }
function play(effects, quiet = false) {
  for (const f of effects) { if (TIMED.has(f.kind)) { if (!quiet) queue.push(f); } else instant(f); }
  pump();
}

// ---------- apply events (one code path for live and replay) ----------
function ingest(events) {
  events.forEach((ev, i) => {
    const r = apply(state, ev);
    state = r.state;
    ensureRobots();
    play(r.effects, events.length > 4 && i < events.length - 2); // catching up on a backlog: no fireworks for old rows
    if (['revoked', 'restored', 'kill_requested', 'run_started'].includes(ev.decision) && source === 'live') loadAgents();
    if (ev.decision === 'run_started') uiSel = null;
  });
  render();
}

// ---------- HUD ----------
const PLACE_NAME = { gatehouse: 'GATEWAY', files: 'Files', github: 'GitHub', mail: 'Mail', admin: 'Admin' };
const PLATE_LABEL = { none: 'NO RUN', active: 'ACTIVE', revoked: 'REVOKED', kill: 'KILL REQUESTED', stopped: 'KILLED' };
const selected = () => uiSel || state.selected;
function render() {
  const a = state.agents[selected()] || Object.values(state.agents)[0];
  $('tabs').innerHTML = Object.values(state.agents).map((x) => `<button data-agent="${esc(x.id)}" class="${x.id === a.id ? 'sel' : ''}">${esc(x.name)}</button>`).join('');
  $('c-name').textContent = a.name;
  $('c-sub').textContent = `client ${a.clientId || '—'}${a.mode !== 'model' ? ` · ${a.mode === 'scripted' ? 'scripted client' : 'replay'}` : ''}`;
  const plate = a.plate === 'stopped' && !a.stopNote.startsWith('run stopped') ? 'stopped' : a.plate;
  $('c-status').textContent = a.plate === 'stopped' && !a.stopNote.startsWith('run stopped') ? 'RUN ENDED' : PLATE_LABEL[plate];
  $('c-status').className = `status st-${plate}`;
  $('c-badge').textContent = `${a.allowedTools.length} of ${ALL_TOOLS.length} tools`;
  $('c-calls').textContent = a.calls; $('c-blocked').textContent = a.blocked;
  $('c-note').textContent = a.revokeMs != null ? `blocked ${a.revokeMs} ms after REVOKE` : a.stopNote;
  $('c-note').style.color = a.revokeMs != null || a.stopNote.startsWith('run stopped') ? 'var(--bad)' : 'var(--dim)';
  $('o-count').textContent = state.blockedTotal;
  $('o-for').textContent = `acts on: ${a.id}`;
  for (const b of document.querySelectorAll('#ops button')) {
    const act = b.dataset.act;
    b.disabled = source === 'replay' || !!pendingBtn[act];
    b.textContent = pendingBtn[act] ? 'sent...' : act.toUpperCase();
  }
  const last = state.log[state.log.length - 1];
  $('ticker').innerHTML = last ? `<span class="seq">#${last.seq}</span><span class="line">${esc(state.ticker)}</span>` : `<span class="line">${source === 'replay' ? 'loading the recording…' : 'waiting for the gateway…'}</span>`;
  if ($('table').classList.contains('on')) renderTable();
}
function renderTable() {
  $('t-body').innerHTML = state.log.map((e) => `<tr><td>${e.seq}</td><td title="${esc(e.ts)}">${esc(String(e.ts || '').slice(11, 23))}</td><td>${esc(e.agent)}</td><td>${esc(e.tool)}</td><td class="${esc(e.decision)}">${esc(e.decision)}</td><td>${esc(e.rule)}</td><td>${esc(e.reason)}</td><td>${e.latency_ms ?? ''}</td></tr>`).join('');
}
function renderBadge() {
  const m = badge({ source, now: Date.now(), lastGoodPoll, staleAfterMs: cfg.staleAfterMs });
  const el = $('mode'); el.className = `hud paper ${m}`;
  const sub = m === 'REPLAY' ? `recorded ${recordedOn || '—'}` : m === 'LIVE' ? 'gateway answering' : lastGoodPoll ? `no answer for ${Math.round((Date.now() - lastGoodPoll) / 1000)} s` : 'no gateway yet';
  el.innerHTML = `${m}<small>${esc(sub)}</small>`;
}
setInterval(renderBadge, 1000); renderBadge();

// name tags, speech bubbles and the BLOCKED bin count follow the 3D scene every frame
const tags = {};
function follow() {
  const ov = $('overlay');
  for (const a of Object.values(state.agents)) {
    const p = scene.robotScreen(a.id); if (!p) continue;
    const t = tags[a.id] ||= Object.assign(ov.appendChild(document.createElement('div')), { className: 'tag' });
    t.textContent = a.name; t.style.left = p[0] + 'px'; t.style.top = p[1] + 62 + 'px';
    const b = bubbles[a.id];
    const bu = tags[a.id + ':b'] ||= Object.assign(ov.appendChild(document.createElement('div')), { className: 'bubble' });
    const showB = b && (performance.now() - b.at < 7000 || a.id === selected());
    bu.style.display = showB ? 'block' : 'none';
    if (showB) { bu.textContent = b.text; bu.className = `bubble ${b.tone || ''}`; bu.style.left = p[0] + 'px'; bu.style.top = p[1] + 'px'; }
  }
  for (const k of scene.places()) {
    const p = scene.placeScreen(k); const t = tags['p:' + k] ||= Object.assign(ov.appendChild(document.createElement('div')), { className: 'tag place' });
    t.textContent = PLACE_NAME[k]; t.style.left = p[0] + 'px'; t.style.top = Math.max(80, p[1]) + 'px';
  }
  const bp = scene.binScreen(); const bc = tags.bin ||= Object.assign(ov.appendChild(document.createElement('div')), { className: 'bincount' });
  bc.textContent = `BLOCKED ${state.blockedTotal}`; bc.style.left = bp[0] - 30 + 'px'; bc.style.top = bp[1] + 'px';
  requestAnimationFrame(follow);
}
requestAnimationFrame(follow);

// ---------- live: poll the gateway ----------
async function loadAgents() {
  try { const r = await fetch(`${cfg.api}/agents`, { cache: 'no-store' }); if (r.ok) { roster = await r.json(); state = withRoster(state, roster); ensureRobots(); render(); } } catch {}
}
async function poll() {
  try {
    const r = await fetch(`${cfg.api}/events?since_seq=${state.cursor}`, { cache: 'no-store' });
    if (r.ok) { const j = await r.json(); lastGoodPoll = Date.now(); renderBadge(); ingest(fresh(j.events, state.cursor)); }
  } catch {}
  setTimeout(poll, cfg.pollMs);
}

// ---------- replay: one event every 1.5 s, same apply() ----------
async function replay(path) {
  let events = [];
  try { const j = await (await fetch(path, { cache: 'no-store' })).json(); events = Array.isArray(j) ? j : j.events || []; }
  catch (e) { $('ticker').innerHTML = `<span class="line">could not load ${esc(path)}</span>`; return; }
  events = events.slice().sort((x, y) => x.seq - y.seq);
  recordedOn = events[0]?.ts ? events[0].ts.slice(0, 10) : ''; renderBadge();
  for (const ev of events) { ingest([ev]); await sleep(1500); }
}

// ---------- the four buttons: POST and wait for the event ----------
async function press(act) {
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
$('tabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-agent]'); if (b) { uiSel = b.dataset.agent; render(); } });

// ---------- keyboard and robot click ----------
addEventListener('keydown', (e) => {
  if (e.key === 't' || e.key === 'T') { $('json').classList.remove('on'); $('table').classList.toggle('on'); renderTable(); }
  else if (e.key === 'r' || e.key === 'R') { const p = replayPath || 'fixture.json'; location.search = `?replay=${encodeURIComponent(p)}`; }
  else if (e.key === 'Escape') { $('table').classList.remove('on'); $('json').classList.remove('on'); }
});
document.querySelector('three-d-stage').addEventListener('click', (e) => {
  const id = scene.pickRobot(e.clientX, e.clientY); if (!id) return;
  uiSel = id; render();
  const ev = [...state.log].reverse().find((x) => x.agent === id);
  $('j-title').textContent = `${state.agents[id]?.name || id}: latest event`;
  $('j-body').textContent = ev ? JSON.stringify(ev, null, 2) : 'no event yet';
  $('table').classList.remove('on'); $('json').classList.add('on');
});

render();
if (source === 'replay') replay(replayPath);
else { loadAgents(); poll(); }
