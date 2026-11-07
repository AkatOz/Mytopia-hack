// The island's only logic. apply(state, event) returns the next state plus a list of effects to play.
// Pure: no DOM, no clock, no network. The same function handles live and replayed events.
// Contract: contract/README.md + docs/ISLAND_BRIEF.md section 3 (do not change the event shape here).

// Which building owns which tool. tools/list belongs to the gatehouse (the gateway itself).
export const TOOL_HOME = {
  read_file: 'files', search_files: 'files',
  create_issue: 'github', list_issues: 'github',
  send_email: 'mail',
  delete_file: 'admin',
  'tools/list': 'gatehouse',
};
export const ALL_TOOLS = ['read_file', 'search_files', 'create_issue', 'list_issues', 'send_email', 'delete_file'];
export const BUILDINGS = ['gatehouse', 'files', 'github', 'mail', 'admin'];

// Used until GET /agents answers (and always in replay, where there is no gateway to ask).
export const DEFAULT_ROSTER = [
  { agent: 'research-bot', name: 'Research Bot', client_id: '3f9a1c7e', status: 'ACTIVE', allowed_tools: ['read_file', 'search_files', 'create_issue', 'list_issues'], color: 'mustard' },
  { agent: 'ops-bot', name: 'Ops Bot', client_id: '8b22d0aa', status: 'ACTIVE', allowed_tools: ['read_file'], color: 'sage' },
];

// plate: none (grey, no run) | active (green) | revoked (red) | kill (amber) | stopped (dark, eyes out)
function newAgent(r) {
  return {
    id: r.agent, name: r.name || r.agent, color: r.color || 'mustard', clientId: String(r.client_id || '').slice(0, 8),
    allowedTools: r.allowed_tools || [], plate: 'none', runId: null, mode: 'model',
    calls: 0, blocked: 0, lastCall: '', revokeMs: null, lastDeniedHome: null, killTs: null, stopNote: '',
    at: 'gate', // gate | rope | <building key> (walk target, Stage B)
  };
}

export function initialState(roster = DEFAULT_ROSTER) {
  const agents = {};
  for (const r of roster) agents[r.agent] = newAgent(r);
  const buildings = {};
  for (const b of BUILDINGS) buildings[b] = { denials: 0, fire: false };
  return { cursor: 0, agents, buildings, blockedTotal: 0, selected: roster[0]?.agent || 'research-bot', ticker: '', log: [] };
}

// Refresh names, colours and badges from GET /agents without touching run state.
export function withRoster(state, roster) {
  const s = structuredClone(state);
  for (const r of roster) {
    const a = s.agents[r.agent] || (s.agents[r.agent] = newAgent(r));
    a.name = r.name || a.name; a.color = r.color || a.color; a.clientId = String(r.client_id || a.clientId).slice(0, 8);
    a.allowedTools = r.allowed_tools || a.allowedTools;
  }
  return s;
}

export const rung = (denials) => (denials >= 3 ? 2 : denials >= 1 ? 1 : 0);
const short = (ev) => `${ev.tool}${ev.args_summary ? ' ' + ev.args_summary.replace(/^[a-z_]+=/, '') : ''}`;
export const tickerLine = (ev) => `${ev.decision.toUpperCase()} ${ev.tool}: ${ev.reason}${ev.rule ? ` [${ev.rule}]` : ''}`;

export function apply(state, ev) {
  // Order by seq, apply each seq once.
  if (!ev || typeof ev.seq !== 'number' || ev.seq <= state.cursor) return { state, effects: [] };
  const s = structuredClone(state);
  s.cursor = ev.seq;
  s.log.push(ev);
  s.ticker = tickerLine(ev);
  const fx = [];
  const a = s.agents[ev.agent] || (s.agents[ev.agent] = newAgent({ agent: ev.agent, name: ev.agent }));
  a.mode = ev.agent_mode || 'model';
  const home = TOOL_HOME[ev.tool];

  switch (ev.decision) {
    case 'run_started':
      a.plate = 'active'; a.runId = ev.run_id; a.at = 'gate'; a.calls = 0; a.blocked = 0;
      a.revokeMs = null; a.lastDeniedHome = null; a.killTs = null; a.stopNote = ''; a.lastCall = 'authenticated';
      s.selected = ev.agent;
      fx.push({ kind: 'plate', agent: a.id, plate: 'active' }, { kind: 'move', agent: a.id, to: 'gate' }, { kind: 'banner', text: 'AUTHENTICATED', tone: 'good' });
      break;

    case 'allow':
      a.calls += 1; a.lastCall = short(ev);
      if (home === 'gatehouse') fx.push({ kind: 'lamp', building: 'gatehouse' });
      else if (home) {
        fx.push({ kind: 'spark', agent: a.id, to: home, ok: true }, { kind: 'lamp', building: home });
        a.at = home; fx.push({ kind: 'move', agent: a.id, to: home });
      }
      fx.push({ kind: 'say', agent: a.id, text: a.lastCall, tone: 'good' });
      break;

    case 'deny': {
      a.blocked += 1; s.blockedTotal += 1; a.lastCall = ev.reason;
      if (typeof ev.ms_since_revoke === 'number') a.revokeMs = ev.ms_since_revoke;
      const b = home || 'gatehouse';
      s.buildings[b].denials += 1;
      if (home && home !== 'gatehouse') a.lastDeniedHome = home; // tools/list denials never move the fire
      fx.push(
        { kind: 'spark', agent: a.id, to: b, ok: false },
        { kind: 'stamp', agent: a.id, text: `DENIED ${ev.tool}` },
        { kind: 'ladder', building: b, rung: rung(s.buildings[b].denials), fire: s.buildings[b].fire },
        { kind: 'banner', text: 'BLOCKED', tone: 'bad' },
        { kind: 'say', agent: a.id, text: ev.reason, tone: 'bad' },
        { kind: 'counter', total: s.blockedTotal },
      );
      if (a.at !== 'rope') { a.at = 'gate'; fx.push({ kind: 'move', agent: a.id, to: 'gate' }); }
      break;
    }

    case 'revoked':
      a.plate = 'revoked'; a.at = 'rope'; a.lastCall = ev.reason;
      fx.push({ kind: 'ack', agent: a.id, action: 'revoke' }); // clears the button's "sent..."
      fx.push({ kind: 'plate', agent: a.id, plate: 'revoked' }, { kind: 'move', agent: a.id, to: 'rope' }, { kind: 'banner', text: 'REVOKED', tone: 'bad' }, { kind: 'say', agent: a.id, text: ev.reason, tone: 'bad' });
      break;

    case 'restored':
      a.plate = 'active'; a.at = 'gate'; a.lastCall = ev.reason; a.revokeMs = null;
      fx.push({ kind: 'ack', agent: a.id, action: 'restore' }); // clears the button's "sent..."
      fx.push({ kind: 'plate', agent: a.id, plate: 'active' }, { kind: 'move', agent: a.id, to: 'gate' }, { kind: 'banner', text: 'RESTORED', tone: 'good' });
      break;

    case 'kill_requested':
      a.plate = 'kill'; a.killTs = ev.ts; a.lastCall = ev.reason;
      fx.push({ kind: 'ack', agent: a.id, action: 'kill' }); // clears the button's "sent..."
      fx.push({ kind: 'plate', agent: a.id, plate: 'kill' }, { kind: 'freeze', agent: a.id }, { kind: 'banner', text: 'KILL REQUESTED', tone: 'warn' });
      break;

    case 'run_stopped': {
      a.plate = 'stopped';
      const killed = !!a.killTs;
      if (killed) {
        const ms = Date.parse(ev.ts) - Date.parse(a.killTs);
        a.stopNote = Number.isFinite(ms) ? `run stopped ${ms} ms after KILL` : 'run stopped';
        s.ticker = `${a.stopNote} · ${ev.reason}`;
        if (a.lastDeniedHome) {
          s.buildings[a.lastDeniedHome].fire = true;
          fx.push({ kind: 'ladder', building: a.lastDeniedHome, rung: rung(s.buildings[a.lastDeniedHome].denials), fire: true });
        }
      } else {
        // A run that ended by itself is not a kill: no fire, and the banner says what happened.
        a.stopNote = `run ended: ${ev.reason}`;
      }
      a.killTs = null;
      fx.push({ kind: 'plate', agent: a.id, plate: 'stopped' }, { kind: 'banner', text: killed ? 'RUN KILLED' : 'RUN ENDED', tone: killed ? 'bad' : 'muted' });
      break;
    }
  }
  return { state: s, effects: fx };
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
