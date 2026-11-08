// The island's only logic. apply(state, event) returns the next state plus a list of effects to play.
// Pure: no DOM, no clock, no network. The same function handles live and replayed events.
// Contract: contract/README.md (do not change the event shape here).
// v1 (this morning): plates, lamps, the smoke ladder, the ack rule, the badge rule, fresh(), the kill-vs-exit rule.
// v2 (2026-11-07 afternoon, docs/ISLAND_V2.md section 4): each event now becomes a SCRIPT for the robot (walk to a gate,
// show the ID card, the gate says yes or no, a guard escorts it back...) plus a few instant effects. Fire is gone: a
// refused call never burns a building, because the building did nothing. Refusals are counted per gate.
//
// Effect kinds (main.js plays them; scene.js draws them):
//   { kind: 'script', agent, steps }            the robot's script (steps are listed in actors.js)
//   { kind: 'plate', agent, plate }             chest plate: none | active | revoked | kill | stopped
//   { kind: 'banner', text, tone }              the 2 s banner at the top
//   { kind: 'stampAt', anchor, text }           DENIED stamp over 'gate:<key>' | 'pen' | 'gatehouse'
//   { kind: 'slip', from, ok }                  a paper slip flies from 'door:<key>' | 'gate:<key>' | 'pen' | 'gatehouse' to the ledger
//   { kind: 'packet' }                          one red packet drops into the BLOCKED bin
//   { kind: 'lamp', target, tone }              'door:<key>' | 'booth:<key>' | 'pen' | 'chief', tone ok | bad
//   { kind: 'smoke', gate, rung }               the trouble ladder over a gate's booth (rung 1 or 2)
//   { kind: 'counter', gate, n }                the REFUSED plate on a booth
//   { kind: 'powerDown', agent }                eyes out, sinks, tilts
//   { kind: 'halt', agent }                     stop where you are (revoke)
//   { kind: 'freeze', agent }                   stop where you are and stay stopped (kill)
//   { kind: 'ack', action }                     clears a button's "sent..." ('revoke' | 'restore' | 'kill' | 'tool:<name>')
//   { kind: 'padlock', gate, on }               the padlock plate on a gate's booth (round two: a tool pulled from a badge)
// Steps inside a script may carry an effect as { fx: effect }: it plays at that moment of the walk.
// A { showId: true } step carries card: { at, lines }: the DOM ID card shown over that anchor while the robot raises it.
//
// Round two (docs/ISLAND_V2_ADDITIONS.md, Sat 4 PM): per-tool revoke/restore (a revoked/restored event whose tool is one
// of the six), quarantine (a revoked event the gateway itself made after repeated refusals), the ID card's three real
// lines, and the three-state mode badge text.

// Which islet owns which tool. tools/list belongs to the gatehouse (the gateway itself).
export const TOOL_HOME = {
  read_file: 'files', search_files: 'files',
  create_issue: 'github', list_issues: 'github',
  send_email: 'mail',
  delete_file: 'admin',
  'tools/list': 'gatehouse',
};
export const ALL_TOOLS = ['read_file', 'search_files', 'create_issue', 'list_issues', 'send_email', 'delete_file'];
export const BUILDINGS = ['gatehouse', 'files', 'github', 'mail', 'admin'];
export const GATES = ['files', 'github', 'mail', 'admin']; // one gate per islet, at the main-island end of its bridge

// Used until GET /agents answers (and always in replay, where there is no gateway to ask).
export const DEFAULT_ROSTER = [
  { agent: 'research-bot', name: 'Research Bot', client_id: '3f9a1c7e', status: 'ACTIVE', allowed_tools: ['read_file', 'search_files', 'create_issue', 'list_issues'], color: 'mustard' },
  { agent: 'ops-bot', name: 'Ops Bot', client_id: '8b22d0aa', status: 'ACTIVE', allowed_tools: ['read_file'], color: 'sage' },
];

// plate: none (grey, no run) | active (green) | revoked (red) | kill (amber) | stopped (dark, eyes out)
// at: where the robot stands when its scripts finish, as a waypoint name from layout.js:
//     hatch | plaza | gh_window | door_files | door_github | door_mail | door_admin | pen
// known: true for agents in the roster (they get a robot); an event from an unknown agent is drawn at the gatehouse only.
// mode: the agent_mode of its last event (model | scripted | replay), null before any event: the badge never guesses.
// pulled: tools an operator took off this badge (per-tool revoke); they show struck red "pulled", not grey.
// quarantined: the badge was pulled by the gateway itself (repeated refusals), not by the operator.
// revokeTool: set when the last measured revoke was a per-tool one (the note then says "after the tool was pulled").
// token, scope: the ID card's lines, from the last event that mentioned them (never invented).
function newAgent(r, known) {
  return {
    id: r.agent, name: r.name || r.agent, color: r.color || 'mustard', clientId: String(r.client_id || '').slice(0, 8),
    allowedTools: r.allowed_tools || [], known, plate: 'none', runId: null, mode: null,
    calls: 0, blocked: 0, lastCall: '', last: null, revokeMs: null, killTs: null, stopNote: '',
    at: 'hatch', pulled: [], quarantined: false, revokeTool: null, token: '', scope: '',
  };
}

export function initialState(roster = DEFAULT_ROSTER) {
  const agents = {};
  for (const r of roster) agents[r.agent] = newAgent(r, true);
  const buildings = {};
  for (const b of BUILDINGS) buildings[b] = { denials: 0 };
  const gates = {};
  for (const g of GATES) gates[g] = { refused: 0, locked: false }; // locked: some agent has one of this islet's tools pulled
  return { cursor: 0, agents, buildings, gates, blockedTotal: 0, selected: roster[0]?.agent || 'research-bot', ticker: '', log: [] };
}

// Refresh names, colours and badges from GET /agents without touching run state.
export function withRoster(state, roster) {
  const s = structuredClone(state);
  for (const r of roster) {
    const a = s.agents[r.agent] || (s.agents[r.agent] = newAgent(r, true));
    a.known = true;
    a.name = r.name || a.name; a.color = r.color || a.color; a.clientId = String(r.client_id || a.clientId).slice(0, 8);
    a.allowedTools = r.allowed_tools || a.allowedTools;
  }
  return s;
}

// The trouble ladder over a gate's booth: rung 1 (3 puffs) after 2 refusals at that gate, rung 2 (6 puffs) after 4.
export const rung = (refusals) => (refusals >= 4 ? 2 : refusals >= 2 ? 1 : 0);
const short = (ev) => `${ev.tool}${ev.args_summary ? ' ' + ev.args_summary.replace(/^[a-z_]+=/, '') : ''}`;
// A quarantine is a whole-badge revoke the gateway made itself (contract: reason "badge pulled by quarantine ...",
// args_summary "quarantine: <n> refused calls in <s> s"). It is drawn like a revoke, under its own name.
export const isQuarantine = (ev) => ev.decision === 'revoked'
  && (/^badge pulled by quarantine/i.test(ev.reason || '') || /^quarantine:/i.test(ev.args_summary || ''));
// An allow-list deny that carries ms_since_revoke was measured from a per-tool revoke; any other from a badge revoke.
const sinceWhat = (ev) => (ev.rule === 'allow-list' ? 'the tool was pulled' : 'REVOKE');
export const tickerLine = (ev) => `${isQuarantine(ev) ? 'QUARANTINED' : ev.decision.toUpperCase()} ${ev.tool}: ${ev.reason}${ev.rule ? ` [${ev.rule}]` : ''}`
  + (typeof ev.ms_since_revoke === 'number' ? ` · ${ev.ms_since_revoke} ms after ${sinceWhat(ev)}` : '');

// The ID card's token line, from the gateway's own words: run_started says "token OK: client .. expires in 300 s",
// a status refusal says "(token: signature OK, expires in 243 s)". Anything else carries no token news (null).
export function tokenLine(reason) {
  const r = String(reason || '');
  let m = /token OK\b.*?expires in (\d+) s/i.exec(r);
  if (m) return `token OK · expires in ${m[1]} s`;
  m = /signature OK, expires in (\d+) s/i.exec(r);
  return m ? `signature OK · expires in ${m[1]} s` : null;
}
// The three lines of the DOM ID card (docs/ISLAND_V2_ADDITIONS.md section 3). Without a real expiry, no number.
export const idLines = (a) => [`client ${a.clientId || '—'}`, `scope ${a.scope || 'mytopia/tools'}`, a.token || 'token: checked by the gateway'];
const idStep = (a, at) => ({ showId: true, card: { at, lines: idLines(a) } });

// The mode badge's words: LIVE · model, LIVE · scripted, REPLAY, STALE. The second word is the selected agent's
// agent_mode, so a judge always sees whether a model or a fixed script drives the calls. No event yet: just LIVE.
export function badgeText(mode, agentMode) {
  return mode === 'LIVE' && (agentMode === 'model' || agentMode === 'scripted') ? `LIVE · ${agentMode}` : mode;
}

// A gate is locked (padlock on its booth) while any agent has one of that islet's tools pulled from its badge.
function lockGates(s) {
  for (const g of GATES) s.gates[g].locked = Object.values(s.agents).some((x) => (x.pulled || []).some((t) => TOOL_HOME[t] === g));
}
// A per-tool revoked/restored (tool is one of the six; contract: args_summary "badge=<tools now on the badge>").
// The badge loses or regains that one tool; the plate, the pen and the chief are not involved.
function toolChange(s, a, ev, back, out) {
  const t = ev.tool, listed = /^badge=(.*)$/.exec(ev.args_summary || '');
  // the gateway's own list wins when the event carries one; the changed tool is then made to agree with the event
  let tools = listed ? listed[1].split(',').filter((x) => ALL_TOOLS.includes(x)) : a.allowedTools.slice();
  tools = back ? ALL_TOOLS.filter((x) => x === t || tools.includes(x)) : tools.filter((x) => x !== t);
  a.allowedTools = tools;
  a.pulled = back ? a.pulled.filter((x) => x !== t) : [...a.pulled.filter((x) => x !== t), t];
  if (back && a.revokeTool === t) { a.revokeMs = null; a.revokeTool = null; }
  a.lastCall = ev.reason;
  lockGates(s);
  const gate = TOOL_HOME[t];
  out.push({ kind: 'ack', action: 'tool:' + t }, // clears that chip's "sent..."
    { kind: 'padlock', gate, on: s.gates[gate].locked },
    { kind: 'lamp', target: `booth:${gate}`, tone: back ? 'ok' : 'bad' },
    { kind: 'banner', text: `${back ? 'RETURNED' : 'PULLED'} ${t}`, tone: back ? 'good' : 'bad' });
}

// The gateway strip and the ledger header: how many decisions, and the gateway's own latency (p50, p95, nearest rank)
// over the allow and deny rows. Admin and harness rows are not gateway decisions and carry latency 0, so they are left out.
export function percentile(sorted, q) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}
export function gatewayStats(log) {
  const rows = (log || []).filter((e) => e.decision === 'allow' || e.decision === 'deny');
  const ms = rows.map((e) => e.latency_ms).filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((x, y) => x - y);
  const blocked = rows.filter((e) => e.decision === 'deny').length;
  return { decisions: rows.length, allowed: rows.length - blocked, blocked, p50: percentile(ms, 0.5), p95: percentile(ms, 0.95) };
}

// ---------- small step builders (plain data, so the tests can read them) ----------
const fx = (effect) => ({ fx: effect });
const leavePen = (a) => (a.at === 'pen' ? [{ pen: 'out' }] : []);
const OUT_AND_ABOUT = ['plaza', 'gh_window', ...GATES.map((g) => `door_${g}`)];
// The robot walks on its own only when it is out and about (not held in the pen, not frozen, not down in the hatch).
const free = (a) => a.known && OUT_AND_ABOUT.includes(a.at) && a.plate !== 'kill' && a.plate !== 'stopped';

export function apply(state, ev) {
  // Order by seq, apply each seq once.
  if (!ev || typeof ev.seq !== 'number' || ev.seq <= state.cursor) return { state, effects: [] };
  const s = structuredClone(state);
  s.cursor = ev.seq;
  s.log.push(ev);
  s.ticker = tickerLine(ev);
  const out = [];
  const agentId = ev.agent || 'unknown';
  const a = s.agents[agentId] || (s.agents[agentId] = newAgent({ agent: agentId, name: agentId }, false));
  a.mode = ev.agent_mode || a.mode;
  // the ID card shows what the last event said about the token and the scope
  const tk = tokenLine(ev.reason), sc = /\bscope (\S+)/.exec(ev.reason || '');
  if (tk) a.token = tk;
  if (sc) a.scope = sc[1];
  const id = a.id;
  const home = TOOL_HOME[ev.tool];
  const script = (steps) => { if (steps.length) out.push({ kind: 'script', agent: id, steps }); };

  switch (ev.decision) {
    case 'run_started': {
      a.plate = 'active'; a.runId = ev.run_id; a.calls = 0; a.blocked = 0; a.last = null;
      a.revokeMs = null; a.revokeTool = null; a.quarantined = false; a.killTs = null; a.stopNote = ''; a.lastCall = 'authenticated';
      const cid = /client (\S+)/.exec(ev.reason || '');
      if (cid) a.clientId = cid[1].slice(0, 8);
      s.selected = id;
      // rise out of the dock hatch, show the ID card at the gatehouse window, plate turns green, go to the plaza
      const steps = [fx({ kind: 'plate', agent: id, plate: 'none' }), { dismiss: 'chief' }];
      if (a.at === 'hatch') steps.push({ spawn: true }); else steps.push(...leavePen(a));
      steps.push({ walk: 'gh_window' }, { wait: 0.2 }, idStep(a, 'gatehouse'),
        fx({ kind: 'lamp', target: 'chief', tone: 'ok' }), fx({ kind: 'plate', agent: id, plate: 'active' }),
        fx({ kind: 'banner', text: 'AUTHENTICATED', tone: 'good' }), { wait: 0.3 }, { walk: 'plaza' });
      script(steps);
      a.at = 'plaza';
      break;
    }

    case 'allow': {
      a.calls += 1; a.lastCall = short(ev); a.last = { decision: 'allow', tool: ev.tool, ms: ev.latency_ms };
      if (home && home !== 'gatehouse') {
        // walk to the islet's gate, show the card, the barrier lifts, cross the bridge; the door lamp and a slip
        const steps = [];
        if (a.at !== `door_${home}`) {
          steps.push(...leavePen(a), { walk: `gate_${home}` }, { wait: 0.3 }, idStep(a, `gate:${home}`), { gate: home, lamp: 'ok' }, { walk: `door_${home}` });
        }
        steps.push(fx({ kind: 'lamp', target: `door:${home}`, tone: 'ok' }), fx({ kind: 'slip', from: `door:${home}`, ok: true }));
        script(steps);
        a.at = `door_${home}`;
      } else {
        // tools/list (or a tool the island does not know): the gatehouse window
        const steps = [...leavePen(a)];
        if (a.at !== 'gh_window') steps.push({ walk: 'gh_window' });
        steps.push(idStep(a, 'gatehouse'), fx({ kind: 'lamp', target: 'chief', tone: 'ok' }), fx({ kind: 'slip', from: 'gatehouse', ok: true }));
        script(steps);
        a.at = 'gh_window';
      }
      break;
    }

    case 'deny': {
      a.blocked += 1; s.blockedTotal += 1; a.lastCall = ev.reason; a.last = { decision: 'deny', tool: ev.tool, ms: ev.latency_ms };
      const rule = String(ev.rule || '');
      // the gateway puts ms_since_revoke on the first refusal after a revoke (after a per-tool one: an allow-list deny)
      if (typeof ev.ms_since_revoke === 'number') { a.revokeMs = ev.ms_since_revoke; a.revokeTool = rule === 'allow-list' ? ev.tool : null; }
      const b = home || 'gatehouse';
      if (s.buildings[b]) s.buildings[b].denials += 1;
      const text = `DENIED ${ev.tool}`;

      if (rule.startsWith('status-')) {
        // revoked or killed: the robot is held in the pen; it shows its card there and is refused there
        const inPen = a.at === 'pen';
        const anchor = inPen ? 'pen' : 'gatehouse';
        script([
          ...(a.plate === 'revoked' && inPen ? [idStep(a, 'pen')] : []),
          fx({ kind: 'lamp', target: inPen ? 'pen' : 'chief', tone: 'bad' }),
          fx({ kind: 'stampAt', anchor, text }),
          fx({ kind: 'slip', from: anchor, ok: false }),
          fx({ kind: 'packet' }),
        ]);
      } else if (rule === 'allow-list' && home && home !== 'gatehouse') {
        // not on the badge: refused at the islet's gate, and the booth guard walks the robot back to the plaza
        const g = s.gates[home]; g.refused += 1;
        const walks = free(a);
        const steps = walks
          ? [{ walk: `gate_${home}` }, { wait: 0.3 }, idStep(a, `gate:${home}`), { gate: home, lamp: 'bad' }]
          : [fx({ kind: 'lamp', target: `booth:${home}`, tone: 'bad' })];
        steps.push(fx({ kind: 'stampAt', anchor: `gate:${home}`, text }), fx({ kind: 'counter', gate: home, n: g.refused }),
          fx({ kind: 'slip', from: `gate:${home}`, ok: false }), fx({ kind: 'packet' }));
        if (rung(g.refused) > 0) steps.push(fx({ kind: 'smoke', gate: home, rung: rung(g.refused) }));
        if (walks) { steps.push({ wait: 0.4 }, { escort: { by: `booth:${home}`, to: 'plaza' } }); a.at = 'plaza'; }
        script(steps);
      } else {
        // token, registry-unavailable, header-mismatch, unknown tools: refused at the gatehouse window
        const walks = free(a);
        script([
          ...(walks && a.at !== 'gh_window' ? [{ walk: 'gh_window' }] : []),
          ...(walks ? [idStep(a, 'gatehouse')] : []),
          fx({ kind: 'lamp', target: 'chief', tone: 'bad' }),
          fx({ kind: 'stampAt', anchor: 'gatehouse', text }),
          fx({ kind: 'slip', from: 'gatehouse', ok: false }),
          fx({ kind: 'packet' }),
        ]);
        if (walks) a.at = 'gh_window';
      }
      break;
    }

    case 'revoked': {
      if (ALL_TOOLS.includes(ev.tool)) { toolChange(s, a, ev, false, out); break; } // one tool off the badge
      const quarantine = isQuarantine(ev);
      a.plate = 'revoked'; a.quarantined = quarantine; a.lastCall = ev.reason;
      // only the operator's own revoke clears the REVOKE button's "sent..." (a quarantine is the gateway's, not a click)
      if (/\bby operator\b/i.test(ev.reason || '')) out.push({ kind: 'ack', action: 'revoke' });
      out.push({ kind: 'halt', agent: id }, { kind: 'plate', agent: id, plate: 'revoked' },
        { kind: 'banner', text: quarantine ? 'QUARANTINED' : 'REVOKED', tone: 'bad' });
      // the chief guard walks to the robot wherever it stopped and escorts it into the pen
      if (a.known && a.at !== 'pen' && a.at !== 'hatch') { script([{ escort: { by: 'chief', to: 'pen_gate' } }, { pen: 'in' }]); a.at = 'pen'; }
      break;
    }

    case 'restored':
      if (ALL_TOOLS.includes(ev.tool)) { toolChange(s, a, ev, true, out); break; } // one tool back on the badge
      a.plate = 'active'; a.lastCall = ev.reason; a.revokeMs = null; a.revokeTool = null; a.quarantined = false;
      out.push({ kind: 'ack', action: 'restore' }); // clears the button's "sent..."
      out.push({ kind: 'plate', agent: id, plate: 'active' }, { kind: 'banner', text: 'RESTORED', tone: 'good' });
      if (a.at === 'pen') {
        script([{ summon: 'chief', to: 'pen_gate', wait: true }, { pen: 'out' }, { walk: 'plaza' }, { dismiss: 'chief' }]);
        a.at = 'plaza';
      }
      break;

    case 'kill_requested':
      a.plate = 'kill'; a.killTs = ev.ts; a.lastCall = ev.reason;
      out.push({ kind: 'ack', action: 'kill' }); // clears the button's "sent..."
      out.push({ kind: 'freeze', agent: id }, { kind: 'plate', agent: id, plate: 'kill' }, { kind: 'banner', text: 'KILL REQUESTED', tone: 'warn' });
      script([{ summon: 'chief', to: 'agent' }]);
      break;

    case 'run_stopped': {
      a.plate = 'stopped';
      // A kill is a run_stopped after this agent's kill_requested, or one the launcher marks "killed by harness".
      // A run that exited on its own ("exited", "task complete") is never shown as killed.
      const killed = !!a.killTs || /killed by harness/i.test(`${ev.reason} ${ev.args_summary}`);
      if (killed) {
        const ms = a.killTs ? Date.parse(ev.ts) - Date.parse(a.killTs) : NaN;
        a.stopNote = Number.isFinite(ms) ? `run stopped ${ms} ms after KILL` : 'run stopped';
        s.ticker = `${a.stopNote} · ${ev.reason}`;
        out.push({ kind: 'freeze', agent: id }, { kind: 'plate', agent: id, plate: 'stopped' }, { kind: 'powerDown', agent: id },
          { kind: 'banner', text: 'RUN KILLED', tone: 'bad' });
        script([{ summon: 'chief', to: 'agent' }]);
      } else {
        // A run that ended by itself: the robot walks back to the dock and sinks into the hatch.
        a.stopNote = `run ended: ${ev.reason}`;
        out.push({ kind: 'banner', text: 'RUN ENDED', tone: 'muted' });
        const steps = [fx({ kind: 'plate', agent: id, plate: 'none' })];
        if (a.at !== 'hatch') steps.push(...leavePen(a), { walk: 'hatch' }, { sink: true });
        script(steps);
        a.at = 'hatch';
      }
      a.killTs = null;
      break;
    }
  }
  return { state: s, effects: out };
}

// The mode badge is not an event: it is recomputed every second from the source and the poll health.
export function badge({ source, now, lastGoodPoll, staleAfterMs = 3000 }) {
  if (source === 'replay') return 'REPLAY';
  return lastGoodPoll != null && now - lastGoodPoll < staleAfterMs ? 'LIVE' : 'STALE';
}

// Events from a poll: ascending by seq, only the ones after the cursor, each seq once.
export function fresh(events, cursor) {
  const seen = new Set();
  return (events || []).filter((e) => e && typeof e.seq === 'number' && e.seq > cursor && !seen.has(e.seq) && seen.add(e.seq)).sort((x, y) => x.seq - y.seq);
}
