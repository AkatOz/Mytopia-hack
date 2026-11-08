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
//   { kind: 'factorySmoke' }                    build 3: the Factory chimneys puff fast for 8 s (a robot was minted)
//   { kind: 'built', agent, spec }              build 3: a robot was minted; spec { id, name, color, tier, tools } (main plays
//                                               the Factory floor line only if this browser asked for the build)
//   { kind: 'setTier', agent, tier }            build 3: the tier medal on the robot's chest
//   { kind: 'removeRobot', agent }              build 3: a retired robot leaves the world (carried as the last step of its
//                                               recycle script, so it vanishes once it has rolled into the Factory)
//   { kind: 'inquest', agent }                  build 3: the inspection panel over the bay screen (main computes inquestOf)
// Build 3 script steps (docs/BUILD3.md section 4): { build: true } (appear at the Factory door), { cart: { to } } (the
// Factory cart carries a powered-down robot), { recycle: true } (roll into the Factory and vanish).
// Build 3 acks: 'tier' (PROMOTE / DEMOTE), 'retire:<agent>' (RETIRE). Anchors gain 'bay' (stamps over the inspection bay).
// Steps inside a script may carry an effect as { fx: effect }: it plays at that moment of the walk.
// A { showId: true } step carries card: { at, lines }: the DOM ID card shown over that anchor while the robot raises it.
//
// Round two (docs/ISLAND_V2_ADDITIONS.md, Sat 4 PM): per-tool revoke/restore (a revoked/restored event whose tool is one
// of the six), quarantine (a revoked event the gateway itself made after repeated refusals), the ID card's three real
// lines, and the three-state mode badge text.
//
// Build 3 (docs/BUILD3.md section 6, Sat 7 PM): tiers on every agent (tier, role, madeBy, ceiling); the Factory's
// created / tier_changed / retired events; quarantine and kill go to the inspection bay (not the pen) and end in the
// inquest; a killed run no longer summons the chief (no guard stands behind a killed robot); inquestOf().
import { TIERS, ROBOT_COLORS, inferTier, ceiling as ceilingOf } from './tiers.js';

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
export { TIERS, TIER_ORDER, ROBOT_COLORS, inferTier, tierFor } from './tiers.js';

// Used until GET /agents answers (and always in replay, where there is no gateway to ask).
export const DEFAULT_ROSTER = [
  { agent: 'research-bot', name: 'Research Bot', client_id: '3f9a1c7e', status: 'ACTIVE', allowed_tools: ['read_file', 'search_files', 'create_issue', 'list_issues'], color: 'mustard', tier: 'silver', role: 'reads documents and files tickets', made_by: 'seed' },
  { agent: 'ops-bot', name: 'Ops Bot', client_id: '8b22d0aa', status: 'ACTIVE', allowed_tools: ['read_file'], color: 'sage', tier: 'bronze', role: 'reads the drive, changes nothing', made_by: 'seed' },
];

// plate: none (grey, no run) | active (green) | revoked (red) | kill (amber) | stopped (dark, eyes out)
// at: where the robot stands when its scripts finish, as a waypoint name from layout.js:
//     hatch | plaza | gh_window | door_files | door_github | door_mail | door_admin | pen | yard | bay | factory
// tier: bronze | silver | gold | diamond (from the roster; inferTier(allowed_tools) for a row written before tiers);
// ceiling: the tools that tier may ever hold; role: one plain line; madeBy: seed | factory.
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
    ...tierFields(r),
  };
}
function tierFields(r) {
  const tier = TIERS[r.tier] ? r.tier : inferTier(r.allowed_tools || []);
  return { tier, ceiling: ceilingOf(tier), role: String(r.role || ''), madeBy: r.made_by || 'seed' };
}
// 'billing-bot' -> 'Billing Bot' (a created event carries no name; the roster's name wins when it arrives)
export const nameFromId = (id) => String(id || '').split('-').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');

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
    if (r.tier || !a.tier) Object.assign(a, tierFields({ ...r, allowed_tools: a.allowedTools }));
    if (r.role != null) a.role = String(r.role);
    if (r.made_by) a.madeBy = r.made_by;
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
// key=value pairs of an args_summary (the Factory's rows: "tier=gold tools=a,b color=teal", "tier=silver was=gold badge=a,b")
export function kv(summary) {
  const o = {};
  for (const m of String(summary || '').matchAll(/([a-z_]+)=(\S*)/g)) o[m[1]] = m[2];
  return o;
}
const rankOf = (t) => (TIERS[t] ? TIERS[t].rank : 0);
const tierName = (t) => (TIERS[t] ? TIERS[t].name : String(t || ''));
// PROMOTED or DEMOTED, from tier= and was= (a row without was= reads its reason)
export function tierMove(ev) {
  const k = kv(ev.args_summary);
  if (k.was && k.tier) return rankOf(k.tier) >= rankOf(k.was) ? 'PROMOTED' : 'DEMOTED';
  return /demoted/i.test(ev.reason || '') ? 'DEMOTED' : 'PROMOTED';
}
const FACTORY_WORD = { created: 'BUILT', retired: 'RETIRED' };
export const tickerLine = (ev) => {
  if (FACTORY_WORD[ev.decision]) return `${FACTORY_WORD[ev.decision]} ${ev.agent}: ${ev.reason}`;
  if (ev.decision === 'tier_changed') return `${tierMove(ev)} ${ev.agent}: ${ev.reason}`;
  return `${isQuarantine(ev) ? 'QUARANTINED' : ev.decision.toUpperCase()} ${ev.tool}: ${ev.reason}${ev.rule ? ` [${ev.rule}]` : ''}`
    + (typeof ev.ms_since_revoke === 'number' ? ` · ${ev.ms_since_revoke} ms after ${sinceWhat(ev)}` : '');
};

// The spec a created row describes. args_summary is cut at 80 characters, so a long tool list can lose its colour or
// the end of its last tool name: a cut word is taken only when it is the start of exactly one name it could be.
export function specOf(ev, a) {
  const k = kv(ev.args_summary), cut = String(ev.args_summary || '').length >= 80;
  const tier = TIERS[k.tier] ? k.tier : (a && a.tier) || 'bronze';
  const unique = (word, names) => { const hits = names.filter((n) => n.startsWith(word)); return word && hits.length === 1 ? hits[0] : null; };
  let tools = [];
  const words = String(k.tools || '').split(',').filter(Boolean);
  words.forEach((w, i) => {
    const t = ALL_TOOLS.includes(w) ? w : cut && i === words.length - 1 ? unique(w, ALL_TOOLS.filter((x) => !tools.includes(x))) : null;
    if (t && !tools.includes(t)) tools.push(t);
  });
  // "Gold badge, 5 tools": when the count is the whole ceiling, the badge is the ceiling
  const n = Number((/(\d+) tools?\b/.exec(ev.reason || '') || [])[1]);
  if (Number.isFinite(n) && n > tools.length && n === ceilingOf(tier).length) tools = ceilingOf(tier);
  tools = ALL_TOOLS.filter((t) => tools.includes(t) && ceilingOf(tier).includes(t));
  const names = Object.keys(ROBOT_COLORS);
  const color = names.includes(k.color) ? k.color : unique(k.color || '', names);
  return { id: ev.agent, name: (a && a.known && a.name !== a.id && a.name) || nameFromId(ev.agent), color, tier, tools };
}

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
    { kind: 'banner', text: `${back ? (/added to badge/i.test(ev.reason || '') ? 'GRANTED' : 'RETURNED') : 'PULLED'} ${t}`, tone: back ? 'good' : 'bad' });
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
      // build 3: a robot that waits in the Factory yard (or stands in the bay) walks over the south bridge, no hatch
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
        // build 3: a quarantined or killed robot stands in the inspection bay: the stamp lands over the bay
        const inPen = a.at === 'pen', inBay = a.at === 'bay';
        const anchor = inPen ? 'pen' : inBay ? 'bay' : 'gatehouse';
        script([
          ...(a.plate === 'revoked' && (inPen || inBay) ? [idStep(a, anchor)] : []),
          fx({ kind: 'lamp', target: inPen ? 'pen' : 'chief', tone: 'bad' }),
          fx({ kind: 'stampAt', anchor, text }),
          fx({ kind: 'slip', from: inBay ? 'gatehouse' : anchor, ok: false }),
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
      if (quarantine) {
        // build 3: the gateway pulled the badge itself: the chief escorts the robot over the south bridge into the
        // inspection bay, where the inquest runs (the escort sends him home at once)
        if (a.known && !['bay', 'hatch', 'factory'].includes(a.at)) { script([{ escort: { by: 'chief', to: 'bay_lift' } }, fx({ kind: 'inquest', agent: id })]); a.at = 'bay'; }
        else if (a.known && a.at === 'bay') out.push({ kind: 'inquest', agent: id });
        break;
      }
      // an operator's REVOKE: the chief guard walks to the robot wherever it stopped and escorts it into the pen
      if (a.known && !['pen', 'hatch', 'bay', 'factory'].includes(a.at)) { script([{ escort: { by: 'chief', to: 'pen_gate' } }, { pen: 'in' }]); a.at = 'pen'; }
      break;
    }

    case 'restored': {
      if (ALL_TOOLS.includes(ev.tool)) { toolChange(s, a, ev, true, out); break; } // one tool back on the badge
      a.plate = 'active'; a.lastCall = ev.reason; a.revokeMs = null; a.revokeTool = null; a.quarantined = false;
      out.push({ kind: 'ack', action: 'restore' }); // clears the button's "sent..."
      out.push({ kind: 'plate', agent: id, plate: 'active' }, { kind: 'banner', text: 'RESTORED', tone: 'good' });
      if (a.at === 'pen') {
        script([{ summon: 'chief', to: 'pen_gate', wait: true }, { pen: 'out' }, { walk: 'plaza' }, { dismiss: 'chief' }]);
        a.at = 'plaza';
      } else if (a.at === 'bay') {
        // build 3: out of the inspection bay and back over the bridge to the plaza (the graph routes it)
        script([{ walk: 'plaza' }]);
        a.at = 'plaza';
      }
      break;
    }

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
        // build 3: no summon any more (no guard stands behind a killed robot): the chief goes home, the Factory cart
        // collects the robot and sets it on the inspection bay's lift, and the inquest runs
        if (a.known && !['hatch', 'factory'].includes(a.at)) {
          script([{ dismiss: 'chief' }, ...(a.at === 'bay' ? [] : [{ cart: { to: 'bay_lift' } }]), fx({ kind: 'inquest', agent: id })]);
          a.at = 'bay';
        } else script([{ dismiss: 'chief' }]);
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

    // ---------- build 3: the Factory (tool admin, rule factory) ----------
    case 'created': {
      // a badge was minted: the robot appears at the Factory door and walks to its spot in the yard
      const spec = specOf(ev, a);
      const cid = /client (\S+)/.exec(ev.reason || '');
      Object.assign(a, { known: true, name: spec.name, tier: spec.tier, ceiling: ceilingOf(spec.tier), allowedTools: spec.tools,
        madeBy: 'factory', plate: 'none', pulled: [], quarantined: false, lastCall: ev.reason });
      if (spec.color) a.color = spec.color;
      else { // the colour was cut off the row: the first colour no other robot wears
        const used = Object.values(s.agents).filter((x) => x.known && x.id !== id).map((x) => x.color);
        a.color = Object.keys(ROBOT_COLORS).find((c) => !used.includes(c)) || 'mustard';
      }
      if (cid) a.clientId = cid[1].slice(0, 8);
      lockGates(s);
      out.push({ kind: 'factorySmoke' }, { kind: 'built', agent: id, spec: { ...spec, color: a.color } },
        { kind: 'setTier', agent: id, tier: a.tier }, { kind: 'banner', text: `BUILT ${a.name}`, tone: 'good' });
      script([{ build: true }, { walk: 'yard' }]);
      a.at = 'yard';
      break;
    }

    case 'tier_changed': {
      // promoted or demoted: the medal changes; a demotion trims the badge to the new ceiling (badge= says what is left)
      const k = kv(ev.args_summary), move = tierMove(ev);
      const tier = TIERS[k.tier] ? k.tier : a.tier;
      const cut = String(ev.args_summary || '').length >= 80;
      const listed = 'badge' in k && !cut ? k.badge.split(',').filter((x) => ALL_TOOLS.includes(x)) : null;
      a.tier = tier; a.ceiling = ceilingOf(tier);
      a.allowedTools = ALL_TOOLS.filter((t) => (listed || a.allowedTools).includes(t) && a.ceiling.includes(t));
      a.pulled = a.pulled.filter((t) => a.ceiling.includes(t) && !a.allowedTools.includes(t));
      a.lastCall = ev.reason;
      lockGates(s);
      out.push({ kind: 'ack', action: 'tier' }, { kind: 'setTier', agent: id, tier },
        { kind: 'banner', text: `${move} TO ${tierName(tier).toUpperCase()}`, tone: move === 'PROMOTED' ? 'good' : 'warn' });
      break;
    }

    case 'retired': {
      // the identity is deleted: the robot is wheeled into the Factory and the roster forgets it
      out.push({ kind: 'ack', action: 'retire:' + id }, { kind: 'banner', text: 'RETIRED', tone: 'muted' });
      if (a.known) script([fx({ kind: 'plate', agent: id, plate: 'none' }), { recycle: true }, fx({ kind: 'removeRobot', agent: id })]);
      else out.push({ kind: 'removeRobot', agent: id });
      a.known = false; a.at = 'factory'; a.plate = 'none'; a.pulled = []; a.lastCall = ev.reason;
      lockGates(s);
      if (s.selected === id) s.selected = Object.values(s.agents).find((x) => x.known)?.id || s.selected;
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

// ---------- build 3: the inquest (docs/BUILD3.md section 2.4; the gateway's GET /agents/{id}/inquest says the same) ----------
// Computed only from this agent's rows in the log: nothing in it is invented. The run is the newest one (the rows from
// this agent's last run_started on; every row when it never started a run). chainVerified comes from the ledger's
// verifyChain (true, false, or null when there was nothing real to check, as with a fixture's placeholder hashes).
//   outcome      active | revoked | quarantined | killed | ended (from the agent's plate)
//   calls        allow and deny rows of the run
//   refused_by_tool  the deny rows grouped by tool and rule, in the order they first happened
//   trigger      the last whole-badge revoked (quarantine by the gateway, or revoke by the operator) or kill_requested
//   timings      revoke_to_first_deny_ms (the first ms_since_revoke), kill_to_stopped_ms, decision_p50_ms (null if not measured)
//   verdict      allow-list refusals: "Attempted X n times; its T badge does not hold it; the gateway refused every
//                attempt" (+ ", and pulled the badge itself" after a quarantine); a status refusal after an operator
//                REVOKE: "Kept calling after REVOKE: refused within N ms"; neither: "No badge violations; the run was
//                stopped by the operator." (or "No badge violations." while nothing stopped it)
//   recommendation  quarantined: "Keep the badge at T. Restore only after the task is fixed; do not grant X."; killed:
//                "The identity stays; the next run starts clean."; revoked: "Restore the badge only after the task is
//                fixed."; active or ended: "Nothing to do."
export function inquestOf(state, id, chainVerified = null) {
  const a = state && state.agents && state.agents[id];
  if (!a) return null; // unknown agent (the gateway answers 404)
  const rows = (state.log || []).filter((e) => e.agent === id);
  let from = -1;
  rows.forEach((e, i) => { if (e.decision === 'run_started') from = i; });
  const run = from >= 0 ? rows.slice(from) : rows;
  const runId = from >= 0 ? rows[from].run_id || null : null;
  const denies = run.filter((e) => e.decision === 'deny');
  const decided = run.filter((e) => e.decision === 'allow' || e.decision === 'deny');

  const groups = [];
  for (const e of denies) {
    const g = groups.find((x) => x.tool === e.tool && x.rule === e.rule);
    if (g) g.n += 1; else groups.push({ tool: e.tool, n: 1, rule: e.rule, home: TOOL_HOME[e.tool] || 'gatehouse' });
  }
  const first = denies[0] ? { tool: denies[0].tool, ts: denies[0].ts, reason: denies[0].reason } : null;

  let trig = null;
  for (const e of run) {
    if (e.decision === 'kill_requested') trig = { kind: 'kill', ts: e.ts, by: 'operator', detail: e.reason || '' };
    else if (e.decision === 'revoked' && !ALL_TOOLS.includes(e.tool)) {
      trig = isQuarantine(e)
        ? { kind: 'quarantine', ts: e.ts, by: 'gateway', detail: String(e.args_summary || '').replace(/^quarantine:\s*/i, '') || e.reason || '' }
        : { kind: 'revoke', ts: e.ts, by: 'operator', detail: e.reason || '' };
    }
  }
  const quarantined = run.some((e) => isQuarantine(e));

  const firstMs = run.find((e) => e.decision === 'deny' && typeof e.ms_since_revoke === 'number');
  const kill = [...run].reverse().find((e) => e.decision === 'kill_requested');
  const stop = kill && run.find((e) => e.decision === 'run_stopped' && e.seq > kill.seq);
  const killMs = stop ? Date.parse(stop.ts) - Date.parse(kill.ts) : NaN;
  const ms = decided.map((e) => e.latency_ms).filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((x, y) => x - y);

  const ended = a.plate === 'stopped' && !String(a.stopNote || '').startsWith('run stopped');
  const outcome = a.plate === 'revoked' ? (a.quarantined ? 'quarantined' : 'revoked')
    : a.plate === 'kill' || (a.plate === 'stopped' && !ended) ? 'killed' : ended ? 'ended' : 'active';

  // the tier the badge had when it was refused: the was= of the first tier change after the first refusal, else today's
  const tierAt = (seq) => { const c = rows.find((e) => e.decision === 'tier_changed' && e.seq > seq); return (c && kv(c.args_summary).was) || a.tier; };
  const offBadge = groups.filter((g) => g.rule === 'allow-list' && ALL_TOOLS.includes(g.tool));
  const parts = [];
  if (offBadge.length) {
    const firstOff = denies.find((e) => e.rule === 'allow-list');
    const T = TIERS[tierAt(firstOff.seq)] ? TIERS[tierAt(firstOff.seq)].name : tierAt(firstOff.seq);
    const what = offBadge.map((g) => `${g.tool} ${g.n} time${g.n === 1 ? '' : 's'}`).join(' and ');
    parts.push(`Attempted ${what}; its ${T} badge does not hold ${offBadge.length === 1 ? 'it' : 'them'}; the gateway refused every attempt${quarantined ? ', and pulled the badge itself' : ''}`);
  }
  const afterRevoke = run.find((e) => e.decision === 'deny' && String(e.rule || '').startsWith('status-') && typeof e.ms_since_revoke === 'number');
  if (afterRevoke) parts.push(`Kept calling after REVOKE: refused within ${afterRevoke.ms_since_revoke} ms`);
  const stopped = outcome === 'killed' || outcome === 'revoked';
  const verdict = parts.length ? parts.join('. ') + '.' : stopped ? 'No badge violations; the run was stopped by the operator.' : 'No badge violations.';
  const tierName = TIERS[a.tier] ? TIERS[a.tier].name : a.tier;
  const recommendation = outcome === 'quarantined'
    ? `Keep the badge at ${tierName}. Restore only after the task is fixed${offBadge.length ? `; do not grant ${offBadge.map((g) => g.tool).join(' or ')}` : ''}.`
    : outcome === 'killed' ? 'The identity stays; the next run starts clean.'
      : outcome === 'revoked' ? 'Restore the badge only after the task is fixed.' : 'Nothing to do.';

  return {
    agent: a.id, name: a.name, tier: a.tier, run_id: runId, client: a.clientId || null,
    outcome,
    calls: { allowed: decided.length - denies.length, refused: denies.length },
    refused_by_tool: groups,
    first_refusal: first,
    trigger: trig,
    timings: {
      revoke_to_first_deny_ms: firstMs ? firstMs.ms_since_revoke : null,
      kill_to_stopped_ms: Number.isFinite(killMs) ? killMs : null,
      decision_p50_ms: percentile(ms, 0.5),
    },
    chain: { rows: rows.length, verified: chainVerified },
    verdict,
    recommendation,
  };
}
