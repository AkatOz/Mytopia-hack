// The HUD: every piece of text a person reads, as crisp DOM over the canvas (docs/ISLAND_V2.md section 5).
// Panels: the agent card (left), the operator panel with the gateway strip (right), the banner, the mode badge, the
// ticker, the T table. Overlay (follows the 3D scene every frame): robot name tags, DENIED stamps anchored to the gate,
// pen or gatehouse that refused, islet labels and the BLOCKED bin count, then one collision pass so nothing overlaps.
// Pre-existing: the paper look and v1's render()/renderBadge()/ticker/table from main.js. New today: the six tool chips,
// the last-decision line, the gateway strip, anchored stamps (no speech bubbles any more) and the collision pass.
// Round two (docs/ISLAND_V2_ADDITIONS.md): the chips are buttons when live (per-tool revoke and restore), a pulled
// tool is struck red "pulled", the QUARANTINED pill, the DOM ID card over a gate, the mode badge's second word.
// Build 3 (docs/BUILD3.md section 6): the tier medal and PROMOTE / DEMOTE on the card; six chips with five states
// (on, grant, locked with its padlock and hint, held, pulled); the agent sheet (sentences, not JSON); the Factory office
// sheet with the NEW AGENT form; the inquest panel over the bay screen; the plain one-line summary over a ledger row's
// JSON; hide panels (H) and the help sheet (?) are DOM in index.html, toggled by main.js.
import { badge, badgeText, ALL_TOOLS, TOOL_HOME } from './reducer.js';
import { TIERS, TIER_ORDER, ROBOT_COLORS } from './tiers.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Write markup only when it changed: live, render() runs on every poll (300 ms), and a button replaced between
// mousedown and mouseup never receives its click (checker, round two: the tool chips and the tabs).
const setHtml = (el, html) => { if (el && el._html !== html) { el._html = html; el.innerHTML = html; } };
const PLATE_LABEL = { none: 'NO RUN', active: 'ACTIVE', revoked: 'REVOKED', kill: 'KILL REQUESTED', stopped: 'KILLED' };
const PLACE_NAME = { gatehouse: 'GATEWAY', files: 'FILES', github: 'GITHUB', mail: 'MAIL', admin: 'ADMIN', factory: 'FACTORY' };
const PRIORITY = { inquest: 5, stamp: 4, card: 4, tag: 3, label: 2, bin: 1 }; // who keeps its place when two overlap
const ID_CARD_MS = 1200;

// ---------- plain words (no DOM: the tests read them) ----------
// what a tool does, as "did it" and "to do it"
export const DID = { read_file: 'read a document', search_files: 'searched the drive', create_issue: 'filed a ticket', list_issues: 'listed the tickets', send_email: 'sent an email', delete_file: 'deleted a file', 'tools/list': 'asked which tools it may use' };
export const TO_DO = { read_file: 'read a document', search_files: 'search the drive', create_issue: 'file a ticket', list_issues: 'list the tickets', send_email: 'send an email', delete_file: 'delete a file', 'tools/list': 'see which tools it may use' };
// where a robot stands, in words
export const WHERE = {
  hatch: 'below the dock (no run yet)', plaza: 'on the plaza', gh_window: 'at the gatehouse window',
  door_files: 'at the FILES tower', door_github: 'at the GitHub studio', door_mail: 'at the Mail cottage', door_admin: 'at the Admin courthouse',
  pen: 'in the pen', bay: 'in the inspection bay', yard: 'in the Factory yard', factory: 'inside the Factory',
};
const RULE_WORDS = { 'allow-list': 'not on the badge', 'status-revoked': 'badge revoked', 'status-killed': 'run killed', token: 'bad token', 'registry-unavailable': 'badge store unreachable', 'header-mismatch': 'wrong agent header' };
const HOME_WORDS = { files: 'FILES gate', github: 'GitHub gate', mail: 'Mail gate', admin: 'Admin gate', gatehouse: 'gatehouse window' };

// the tier table: GET /tiers answers [{tier, rank, name, line, ceiling}]; the medal colours always come from tiers.js
export function normTiers(json) {
  const out = {};
  const rows = Array.isArray(json) ? json : json && typeof json === 'object' ? Object.entries(json).map(([k, v]) => ({ tier: k, ...v })) : [];
  for (const r of rows) {
    const key = r && (r.tier || r.key); if (!key || !Array.isArray(r.ceiling)) continue;
    const base = TIERS[key] || {};
    out[key] = { rank: r.rank ?? base.rank ?? 0, name: r.name || base.name || key, line: r.line || base.line || '', hex: base.hex || '#9a9a92', ceiling: r.ceiling.filter((t) => ALL_TOOLS.includes(t)) };
  }
  return Object.keys(out).length ? out : TIERS;
}
const orderOf = (tiers) => Object.keys(tiers).sort((x, y) => tiers[x].rank - tiers[y].rank);
// the lowest tier that may hold this tool: "Diamond only" for the top tier, else "Gold+"
export function tierHint(tool, tiers = TIERS) {
  const order = orderOf(tiers);
  const key = order.find((k) => tiers[k].ceiling.includes(tool));
  if (!key) return 'no tier';
  return key === order[order.length - 1] ? `${tiers[key].name} only` : `${tiers[key].name}+`;
}
export const tierLine = (a, tiers = TIERS) => { const t = tiers[a.tier] || TIERS[a.tier]; return t ? `${t.name} badge · ${t.line}` : 'badge tier unknown'; };
// the next tier up or down, or null at either end
export function nextTier(tier, dir, tiers = TIERS) {
  const order = orderOf(tiers), i = order.indexOf(tier);
  if (i < 0) return null;
  return order[i + (dir === 'up' ? 1 : -1)] || null;
}

const endedOnItsOwn = (a) => a.plate === 'stopped' && !a.stopNote.startsWith('run stopped');
// the status pill: [text, css suffix]
export function statusPill(a) {
  if (endedOnItsOwn(a)) return ['RUN ENDED', 'ended'];
  if (a.plate === 'revoked' && a.quarantined) return ['QUARANTINED', 'revoked'];
  return [PLATE_LABEL[a.plate] || a.plate, a.plate];
}
// One chip of the badge (build 3: five states).
//   on      on the badge                      act 'revoke' (pull it)
//   grant   not on the badge, under the tier's ceiling             act 'restore' (the restore route now also grants)
//   pulled  an operator took it off, under the ceiling             act 'restore'
//   locked  above the tier's ceiling: a padlock and hint "Gold+"   act '' (a click still asks; the gateway answers 403
//           with the sentence the island shows)
//   held    on the badge, but the whole badge is revoked or killed act ''
// sent: "sent..." until the event comes back, only for the agent it acts on.
export function chipState(a, tool, pending = {}, tiers = TIERS) {
  const held = a.plate === 'revoked' || a.plate === 'kill' || (a.plate === 'stopped' && !endedOnItsOwn(a));
  const t = tiers[a.tier] || TIERS[a.tier];
  const ceil = t ? t.ceiling : a.ceiling || ALL_TOOLS;
  const sent = pending['tool:' + tool] === a.id;
  if (a.allowedTools.includes(tool)) return { state: held ? 'held' : 'on', act: held ? '' : 'revoke', sent, hint: '' };
  if (!ceil.includes(tool)) return { state: 'locked', act: '', sent, hint: tierHint(tool, tiers) };
  if ((a.pulled || []).includes(tool)) return { state: 'pulled', act: 'restore', sent, hint: '' };
  return { state: 'grant', act: 'restore', sent, hint: '' };
}
// the note: how fast a revoke bit (a badge revoke or one pulled tool), and how the run ended
export function cardNote(a) {
  const bit = a.revokeMs == null ? '' : a.revokeTool ? `blocked ${a.revokeMs} ms after the tool was pulled` : `blocked ${a.revokeMs} ms after REVOKE`;
  return { lines: [bit, a.stopNote].filter(Boolean), bad: a.revokeMs != null || a.stopNote.startsWith('run stopped') };
}
// "read a document · allowed · 86 ms" / "tried to delete a file · refused · 9 ms"
export function lastAction(a) {
  const l = a.last; if (!l) return 'nothing yet';
  const ms = typeof l.ms === 'number' ? ` · ${l.ms} ms` : '';
  return l.decision === 'allow' ? `${DID[l.tool] || l.tool} · allowed${ms}` : `tried to ${TO_DO[l.tool] || l.tool} · refused${ms}`;
}
// one plain sentence over a ledger row's raw JSON
export function rowSummary(ev, state) {
  const who = (state && state.agents[ev.agent] && state.agents[ev.agent].name) || ev.agent;
  const ms = typeof ev.latency_ms === 'number' && (ev.decision === 'allow' || ev.decision === 'deny') ? ` in ${ev.latency_ms} ms` : '';
  const tool = ALL_TOOLS.includes(ev.tool);
  switch (ev.decision) {
    case 'allow': return `${who} asked to ${TO_DO[ev.tool] || ev.tool}; the gateway allowed it${ms}.`;
    case 'deny': return `${who} asked to ${TO_DO[ev.tool] || ev.tool}; the gateway refused it${ms} (${RULE_WORDS[ev.rule] || ev.rule}).`;
    case 'run_started': return `${who} started a run and showed its token; the gateway let it in.`;
    case 'run_stopped': return `${who}'s program stopped: ${ev.reason}.`;
    case 'revoked':
      if (tool) return `The operator took ${ev.tool} off ${who}'s badge.`;
      return /quarantine/i.test(`${ev.reason} ${ev.args_summary}`) ? `The gateway pulled ${who}'s badge itself after repeated refusals (quarantine).` : `The operator took ${who}'s badge away (REVOKE).`;
    case 'restored': return tool ? `The operator gave ${ev.tool} to ${who}'s badge.` : `The operator gave ${who}'s badge back (RESTORE).`;
    case 'kill_requested': return `The operator pressed KILL for ${who}.`;
    case 'created': return `The Factory made a new agent, ${who}: ${ev.reason}.`;
    case 'tier_changed': return `${who}'s badge changed rank: ${ev.reason}.`;
    case 'retired': return `${who} was retired: ${ev.reason}.`;
    default: return `${who}: ${ev.decision} ${ev.tool}.`;
  }
}
// the inquest report as the panel's lines: { ok: true | false | null, text }
export function inquestLines(q) {
  if (!q) return [];
  const t = TIERS[q.tier];
  const L = [{ ok: true, text: `identity: client ${q.client || '—'} · ${t ? t.name : q.tier} badge` },
    { ok: true, text: `calls allowed: ${q.calls.allowed}` },
    { ok: q.calls.refused === 0, text: `calls refused: ${q.calls.refused}` }];
  for (const g of q.refused_by_tool) L.push({ ok: false, text: `refused ${g.tool} ×${g.n} (${RULE_WORDS[g.rule] || g.rule}${g.rule === 'allow-list' ? `, ${HOME_WORDS[g.home] || g.home}` : ''})` });
  const tr = q.trigger;
  if (!tr) L.push({ ok: true, text: 'trigger: none' });
  else if (tr.kind === 'quarantine') L.push({ ok: false, text: `badge pulled by the gateway at ${String(tr.ts || '').slice(11, 19)} · ${tr.detail}` });
  else if (tr.kind === 'kill') L.push({ ok: false, text: `stopped by the operator (KILL) at ${String(tr.ts || '').slice(11, 19)}` });
  else L.push({ ok: false, text: `badge taken by the operator (REVOKE) at ${String(tr.ts || '').slice(11, 19)}` });
  const tm = q.timings, bits = [];
  if (tm.revoke_to_first_deny_ms != null) bits.push(`revoke to refusal ${tm.revoke_to_first_deny_ms} ms`);
  if (tm.kill_to_stopped_ms != null) bits.push(`kill to stop ${tm.kill_to_stopped_ms} ms`);
  if (tm.decision_p50_ms != null) bits.push(`gateway p50 ${tm.decision_p50_ms} ms`);
  if (bits.length) L.push({ ok: true, text: bits.join(' · ') });
  const v = q.chain.verified;
  L.push({ ok: v === true ? true : v === false ? false : null, text: v === true ? `${q.chain.rows} rows hash-verified` : v === false ? `${q.chain.rows} rows: the chain does not verify` : `${q.chain.rows} rows · chain not checked (no real hashes)` });
  return L;
}
// "Billing Bot" -> "billing-bot" (the gateway checks ^[a-z][a-z0-9-]{2,23}$)
export const slugify = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^[^a-z]+/, '').replace(/-+$/, '').slice(0, 24).replace(/-+$/, '');

const medal = (tier, size = '') => `<span class="medal${size}" style="--m:${(TIERS[tier] || {}).hex || '#9a9a92'}" title="${esc((TIERS[tier] || {}).name || tier)}"></span>`;
const squares = (a) => `<span class="squares">${ALL_TOOLS.map((t) => `<i class="${a.allowedTools.includes(t) ? 'on' : ''}" title="${t}"></i>`).join('')}</span>`;

// io: { source, staleAfterMs, lastGoodPoll(), recordedOn(), getState(), selected(), inRoom(), tiers(), rawInquest(id) }
export function createHud(scene, io) {
  const tiersNow = () => (io.tiers && io.tiers()) || TIERS;

  // ---------- chips (the card and the agent sheet share them) ----------
  function chipsHtml(a, ui) {
    const live = ui.source !== 'replay', tiers = tiersNow();
    return ALL_TOOLS.map((t) => {
      const c = chipState(a, t, ui.pending, tiers);
      const sub = c.sent ? 'sent...' : c.state === 'pulled' ? 'pulled' : c.state === 'grant' ? '+ grant' : c.state === 'locked' ? c.hint : '';
      const inner = `<span class="nm">${c.state === 'locked' ? '<span class="lock"></span>' : ''}${esc(t)}</span>${sub ? `<small>${esc(sub)}</small>` : ''}`;
      if (!live || c.state === 'held') return `<span class="chip ${c.state}" data-chip="${esc(t)}">${inner}</span>`;
      const act = c.state === 'locked' ? 'restore' : c.act;
      const tip = c.state === 'on' ? `pull ${t} from this badge` : c.state === 'locked' ? `${t} is above the ${tiers[a.tier]?.name || a.tier} ceiling (${c.hint})` : `give ${t} to this badge`;
      return `<button class="chip ${c.state}" data-chip="${esc(t)}" data-tool="${esc(t)}" data-act="${act}"${c.state === 'locked' ? ' data-locked="1"' : ''} title="${esc(tip)}"${c.sent ? ' disabled' : ''}>${inner}</button>`;
    }).join('');
  }
  function tierHtml(a, ui) {
    const live = ui.source !== 'replay', tiers = tiersNow(), up = nextTier(a.tier, 'up', tiers), down = nextTier(a.tier, 'down', tiers);
    const busy = !!ui.pending.tier;
    const btn = (dir, to, glyph, word) => `<button data-tier="${to || ''}" title="${to ? `${word} to ${esc(tiers[to].name)}` : `already the ${dir === 'up' ? 'top' : 'lowest'} tier`}"${!live || !to || busy ? ' disabled' : ''}>${glyph}</button>`;
    return `${medal(a.tier)}<span class="tl">${esc(busy ? 'sent...' : tierLine(a, tiers))}</span>`
      + `<span class="arrows">${btn('up', up, '▲', 'PROMOTE')}${btn('down', down, '▼', 'DEMOTE')}</span>`;
  }

  // ---------- the agent card ----------
  function renderCard(state, a, ui) {
    setHtml($('tabs'), Object.values(state.agents).filter((x) => x.known).map((x) => `<button data-agent="${esc(x.id)}" class="${x.id === a.id ? 'sel' : ''}">${esc(x.name)}</button>`).join(''));
    $('c-name').textContent = a.name;
    setHtml($('c-tier'), tierHtml(a, ui));
    $('c-sub').textContent = `client ${a.clientId || '—'}${a.mode === 'scripted' ? ' · scripted client' : a.mode === 'replay' ? ' · replay' : ''}`;
    const [pillText, pill] = statusPill(a);
    $('c-status').textContent = pillText;
    $('c-status').className = `status st-${pill}`;
    const n = a.allowedTools.length, held = chipState(a, a.allowedTools[0] || 'read_file', {}, tiersNow()).state === 'held';
    const ceil = (tiersNow()[a.tier] || {}).ceiling || a.ceiling || [];
    $('c-badge').textContent = `${n} of ${ALL_TOOLS.length} tools · ceiling ${ceil.length}${held && n ? ' · suspended' : ''}`;
    setHtml($('c-chips'), chipsHtml(a, ui));
    $('c-calls').innerHTML = `calls allowed <b>${a.calls}</b> · blocked <b>${a.blocked}</b>`;
    const last = a.last;
    $('c-last').innerHTML = last ? `last: <span class="${last.decision === 'allow' ? 'good' : 'bad'}">${last.decision.toUpperCase()} ${esc(last.tool)}</span>${typeof last.ms === 'number' ? ` · ${last.ms} ms` : ''}` : 'last: —';
    const note = cardNote(a);
    $('c-note').innerHTML = note.lines.map(esc).join('<br>');
    $('c-note').className = `note ${note.bad ? 'bad' : 'dim'}`;
  }

  // ---------- the operator panel ----------
  const BTN_WORD = { revoke: 'REVOKE', restore: 'RESTORE', kill: 'KILL', reset: 'RESET' };
  function renderOps(state, a, ui) {
    $('o-count').textContent = state.blockedTotal;
    $('o-for').textContent = `acts on: ${a.name}`;
    for (const b of document.querySelectorAll('#ops button[data-act]')) {
      const act = b.dataset.act;
      if (act === 'save') { b.disabled = !state.log.length; continue; }
      b.disabled = ui.source === 'replay' || !!ui.pending[act];
      b.textContent = ui.pending[act] ? 'sent...' : BTN_WORD[act] || act.toUpperCase();
    }
  }
  // decisions · p50 · p95 · chain status, from gatewayStats(log) and the chain check
  function setGatewayStrip(st) {
    $('g-dec').textContent = st.decisions;
    $('g-lat').textContent = st.p50 == null ? '— · —' : `${st.p50} · ${st.p95} ms`;
    const c = st.chain || 'unverified', el = $('g-chain');
    el.textContent = c === 'ok' ? '✓ verified' : c.startsWith('broken') ? `✗ broken ${c.slice(7)}` : 'not verified';
    el.className = c === 'ok' ? 'good' : c.startsWith('broken') ? 'bad' : 'dim';
  }

  // ---------- ticker and table ----------
  function renderTicker(state, ui) {
    const last = state.log[state.log.length - 1];
    $('ticker').innerHTML = last
      ? `<span class="seq">#${last.seq}</span><span class="line t-${last.decision === 'allow' ? 'allow' : last.decision === 'deny' ? 'deny' : 'admin'}">${esc(state.ticker)}</span>`
      : `<span class="line">${ui.source === 'replay' ? 'loading the recording…' : 'waiting for the gateway…'}</span>`;
  }
  function renderTable(state) {
    $('t-body').innerHTML = state.log.map((e) => `<tr><td>${e.seq}</td><td title="${esc(e.ts)}">${esc(String(e.ts || '').slice(11, 23))}</td><td>${esc(e.agent)}</td><td>${esc(e.tool)}</td><td class="${esc(e.decision)}">${esc(e.decision)}</td><td>${esc(e.rule)}</td><td>${esc(e.reason)}</td><td>${e.latency_ms ?? ''}</td><td>${e.ms_since_revoke ?? ''}</td></tr>`).join('');
  }

  // ---------- the agent sheet (a robot click): sentences; the raw JSON only behind <details> ----------
  let sheetAgent = null;
  function openAgentSheet(id) { sheetAgent = id; $('a-raw').open = false; }
  function renderAgentSheet(state, ui) {
    const a = state.agents[sheetAgent]; if (!a || !$('agent').classList.contains('on')) return;
    const [pillText, pill] = statusPill(a);
    const note = cardNote(a), live = ui.source !== 'replay';
    const mine = state.log.filter((e) => e.agent === a.id);
    const count = (t, d) => mine.filter((e) => e.tool === t && e.decision === d).length;
    const ceil = (tiersNow()[a.tier] || {}).ceiling || [];
    const rows = ALL_TOOLS.map((t) => `<tr><td>${esc(t)}</td><td>${esc(TO_DO[t])}</td><td>${a.allowedTools.includes(t) ? '<span class="good">on the badge</span>' : ceil.includes(t) ? '<span class="dim">not on the badge</span>' : `<span class="dim">above the tier (${esc(tierHint(t, tiersNow()))})</span>`}</td><td class="num">${count(t, 'allow')}</td><td class="num">${count(t, 'deny')}</td></tr>`).join('');
    const btn = (act, word, sub) => `<div class="act"><button data-act="${act}"${!live || ui.pending[act] ? ' disabled' : ''}>${ui.pending[act] ? 'sent...' : word}</button><span>${sub}</span></div>`;
    setHtml($('a-body'), `<h3><span>${esc(a.name)} <span class="status st-${pill}">${esc(pillText)}</span></span><span class="dim">Esc closes</span></h3>`
      + `<div class="tierline">${tierHtml(a, ui)}</div>`
      + `<dl class="facts"><dt>role</dt><dd>${esc(a.role || 'no role written yet')}</dd>`
      + `<dt>where it is</dt><dd>${esc(WHERE[a.at] || a.at)}</dd>`
      + `<dt>last action</dt><dd>${esc(lastAction(a))}</dd>`
      + `<dt>calls</dt><dd>allowed ${a.calls} · refused ${a.blocked}</dd>`
      + (note.lines.length ? `<dt>note</dt><dd class="${note.bad ? 'bad' : ''}">${note.lines.map(esc).join('<br>')}</dd>` : '')
      + `<dt>identity</dt><dd>client ${esc(a.clientId || '—')} · made by ${a.madeBy === 'factory' ? 'the Factory' : 'the seed (demo badge)'}</dd></dl>`
      + `<div class="lbl">the badge: click a tool to give it or take it away</div><div class="chips">${chipsHtml(a, ui)}</div>`
      + `<table class="verbs"><thead><tr><th>tool</th><th>what it does</th><th>this badge</th><th>allowed</th><th>refused</th></tr></thead><tbody>${rows}</tbody></table>`
      + `<div class="acts">${btn('revoke', 'REVOKE', 'take the badge away now')}${btn('restore', 'RESTORE', 'give the badge back')}${btn('kill', 'KILL', 'stop the running program')}</div>`);
    const ev = [...state.log].reverse().find((x) => x.agent === a.id);
    const raw = ev ? JSON.stringify(ev, null, 2) : 'no event yet';
    if ($('a-json').textContent !== raw) $('a-json').textContent = raw;
  }

  // ---------- the Factory office sheet: the roster and the NEW AGENT form ----------
  const form = { name: '', tier: 'gold', tools: null, color: 'teal', role: '', err: '', busy: false };
  function renderOffice(state, ui) {
    if (!$('office').classList.contains('on')) return;
    const live = ui.source !== 'replay', tiers = tiersNow();
    const agents = Object.values(state.agents).filter((x) => x.known);
    setHtml($('f-roster'), `<table class="roster"><thead><tr><th>agent</th><th>tier</th><th>status</th><th>badge</th><th>made by</th><th></th></tr></thead><tbody>`
      + agents.map((a) => {
        const [pt, pc] = statusPill(a);
        const retire = a.madeBy === 'factory' ? `<button data-retire="${esc(a.id)}"${!live || ui.pending['retire:' + a.id] ? ' disabled' : ''} title="delete this identity: its Cognito client and its badge row">${ui.pending['retire:' + a.id] ? 'sent...' : 'RETIRE'}</button>` : '';
        return `<tr><td class="who"><span class="dot" style="background:${ROBOT_COLORS[a.color] || '#e0b347'}"></span>${esc(a.name)}<br><small class="dim">${esc(a.id)}</small></td><td>${medal(a.tier)} ${esc((tiers[a.tier] || {}).name || a.tier)}</td><td><span class="status st-${pc}">${esc(pt)}</span></td><td>${squares(a)}</td><td>${esc(a.madeBy)}</td><td>${retire}</td></tr>`;
      }).join('') + '</tbody></table>');
    // the form is drawn once per open (and on a tier change): a re-draw every poll would eat the typing
    if (!$('f-form')._drawn || $('f-form')._live !== live) drawForm(live);
  }
  function drawForm(live) {
    const tiers = tiersNow(), ceil = (tiers[form.tier] || {}).ceiling || [];
    if (!form.tools) form.tools = new Set(ceil);
    for (const t of [...form.tools]) if (!ceil.includes(t)) form.tools.delete(t);
    const dis = live && !form.busy ? '' : ' disabled';
    const el = $('f-form'); el._drawn = true; el._live = live;
    el.innerHTML = `<h4>NEW AGENT</h4>${live ? '' : '<p class="dim">replay: the Factory is read-only (no gateway to ask)</p>'}`
      + `<label>name <input id="f-name" maxlength="24" value="${esc(form.name)}" placeholder="Billing Bot"${dis}></label><div class="slug" id="f-slug">id: ${esc(slugify(form.name) || '—')}</div>`
      + `<div class="lbl">tier: the most this badge may ever hold</div><div class="tiers">${orderOf(tiers).map((k) => `<button type="button" data-ftier="${k}" class="${k === form.tier ? 'sel' : ''}"${dis}>${medal(k)} <b>${esc(tiers[k].name)}</b><small>${esc(tiers[k].line)}</small></button>`).join('')}</div>`
      + `<div class="lbl">tools (the ${esc((tiers[form.tier] || {}).name || form.tier)} ceiling is ticked)</div><div class="ftools">${ALL_TOOLS.map((t) => {
        const ok = ceil.includes(t);
        return `<label class="${ok ? '' : 'locked'}" title="${ok ? esc(TO_DO[t]) : esc(`${t} is above the ${(tiers[form.tier] || {}).name} ceiling`)}"><input type="checkbox" data-ftool="${t}"${form.tools.has(t) ? ' checked' : ''}${ok ? dis : ' disabled'}>${ok ? '' : '<span class="lock"></span>'}${t}${ok ? '' : ` <small>${esc(tierHint(t, tiers))}</small>`}</label>`;
      }).join('')}</div>`
      + `<div class="lbl">colour</div><div class="swatches">${Object.entries(ROBOT_COLORS).map(([k, hex]) => `<button type="button" data-fcolor="${k}" class="${k === form.color ? 'sel' : ''}" style="background:${hex}" title="${k}"${dis}></button>`).join('')}<span class="dim" id="f-cname">${esc(form.color)}</span></div>`
      + `<label>role <input id="f-role" maxlength="60" value="${esc(form.role)}" placeholder="reads invoices and emails customers"${dis}></label>`
      + `<div class="buildrow"><button type="button" id="f-build"${dis}>${form.busy ? 'sent...' : 'BUILD'}</button><span class="err" id="f-err">${esc(form.err)}</span></div>`;
  }
  // the form's own clicks and typing (main.js calls io.mint(spec) on BUILD)
  function wireOffice() {
    const el = $('f-form');
    el.addEventListener('input', (e) => {
      if (e.target.id === 'f-name') { form.name = e.target.value; $('f-slug').textContent = `id: ${slugify(form.name) || '—'}`; }
      if (e.target.id === 'f-role') form.role = e.target.value;
      if (e.target.dataset.ftool) { if (e.target.checked) form.tools.add(e.target.dataset.ftool); else form.tools.delete(e.target.dataset.ftool); }
    });
    el.addEventListener('click', async (e) => {
      const b = e.target.closest('button'); if (!b || b.disabled) return;
      if (b.dataset.ftier) { form.tier = b.dataset.ftier; form.tools = null; drawForm(el._live); return; }
      if (b.dataset.fcolor) { form.color = b.dataset.fcolor; for (const s of el.querySelectorAll('[data-fcolor]')) s.classList.toggle('sel', s === b); $('f-cname').textContent = form.color; return; }
      if (b.id === 'f-build') {
        const spec = { agent: slugify(form.name), name: form.name.trim(), tier: form.tier, tools: ALL_TOOLS.filter((t) => form.tools.has(t)), color: form.color, role: form.role.trim() };
        if (!spec.name) { form.err = 'Give the agent a name first.'; drawForm(el._live); return; }
        if (!/^[a-z][a-z0-9-]{2,23}$/.test(spec.agent)) { form.err = 'The name needs at least three letters or digits, starting with a letter.'; drawForm(el._live); return; }
        if (!spec.tools.length) { form.err = 'Tick at least one tool.'; drawForm(el._live); return; }
        form.busy = true; form.err = ''; drawForm(el._live);
        const r = await io.mint(spec);
        form.busy = false;
        if (r && r.ok) { form.name = ''; form.role = ''; form.tools = null; form.err = ''; } else form.err = (r && r.error) || 'The gateway did not answer.';
        drawForm(el._live);
      }
    });
  }
  wireOffice();
  function openOffice() { $('f-form')._drawn = false; }

  // ---------- render ----------
  // render(state, ui): ui = { selected, pending: { act: true }, source }
  function render(state, ui) {
    const a = state.agents[ui.selected] && state.agents[ui.selected].known ? state.agents[ui.selected] : Object.values(state.agents).find((x) => x.known) || Object.values(state.agents)[0];
    if (!a) return;
    renderCard(state, a, ui); renderOps(state, a, ui); renderTicker(state, ui);
    if ($('table').classList.contains('on')) renderTable(state);
    renderAgentSheet(state, ui); renderOffice(state, ui);
    // the inquest stays while its agent stands in the bay
    if (inq && (!state.agents[inq.id] || state.agents[inq.id].at !== 'bay')) closeInquest();
  }

  function renderBadge() {
    const now = Date.now(), lastGood = io.lastGoodPoll();
    const m = badge({ source: io.source, now, lastGoodPoll: lastGood, staleAfterMs: io.staleAfterMs });
    const el = $('mode'); el.className = `hud paper ${m}`;
    const sub = m === 'REPLAY' ? `recorded ${io.recordedOn() || '—'}` : m === 'LIVE' ? 'gateway answering' : lastGood ? `no answer for ${Math.round((now - lastGood) / 1000)} s` : 'no gateway yet';
    // LIVE · model or LIVE · scripted: who drives the selected agent's calls, from its last event's agent_mode
    const sel = io.getState().agents[io.selected()];
    el.innerHTML = `${esc(badgeText(m, sel && sel.mode))}<small>${esc(sub)}</small>`;
  }

  // ---------- the banner (2 s) ----------
  function banner(text, tone) {
    const b = $('banner'); b.textContent = text; b.className = `hud paper on ${tone}`;
    panelsAt = 0; // the banner counts as a panel while it shows: labels under it step aside (see offPanels)
    return sleep(2000).then(() => { if (b.textContent === text) { b.classList.remove('on'); panelsAt = 0; } });
  }
  // a locked chip that was clicked shakes for 0.3 s (on the card and in the agent sheet)
  function shakeChip(tool) {
    for (const el of document.querySelectorAll(`[data-chip="${tool}"]`)) { el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake'); }
  }

  // ---------- the inquest panel over the bay screen ----------
  let inq = null; // { id, lines, shown, timer }
  function drawInquest() {
    if (!inq) return;
    const el = $('inquest'), { lines, report } = inq;
    el.querySelector('ul').innerHTML = lines.slice(0, inq.shown).map((l) => `<li class="${l.ok === true ? 'ok' : l.ok === false ? 'no' : 'na'}"><span>${l.ok === true ? '✓' : l.ok === false ? '✗' : '–'}</span>${esc(l.text)}</li>`).join('');
    el.querySelector('.verdict').textContent = inq.shown > lines.length ? report.verdict : '';
    el.querySelector('.rec').textContent = inq.shown > lines.length + 1 ? report.recommendation : '';
    el._w = el.offsetWidth; el._h = el.offsetHeight;
  }
  function showInquest(id, report) {
    closeInquest();
    if (!report) return;
    inq = { id, report, lines: inquestLines(report), shown: 0, timer: null };
    const el = $('inquest');
    el.innerHTML = `<h4>INSPECTION · ${esc(report.name)}</h4><ul></ul><p class="verdict"></p><p class="rec"></p><a href="#" id="iq-raw">raw report</a>`;
    el.style.display = 'block';
    const step = () => { if (!inq) return; inq.shown += 1; drawInquest(); if (inq.shown > inq.lines.length + 1) clearInterval(inq.timer); };
    step();
    inq.timer = setInterval(step, 400);
  }
  // the same report with newer facts (the chain check finished): the lines already typed change in place
  function refreshInquest(report) {
    if (!inq || !report || report.agent !== inq.id) return;
    inq.report = report; inq.lines = inquestLines(report); drawInquest();
  }
  function closeInquest() {
    if (inq) clearInterval(inq.timer);
    inq = null;
    const el = $('inquest'); if (el) { el.style.display = 'none'; el.innerHTML = ''; }
  }
  $('inquest').addEventListener('click', (e) => { if (e.target.id === 'iq-raw') { e.preventDefault(); if (inq) io.rawInquest(inq.id, inq.report); } });

  // ---------- the overlay ----------
  const ov = $('overlay');
  const pool = {}; // key -> element, made once
  function node(key, cls) {
    let el = pool[key];
    if (!el) { el = pool[key] = document.createElement('div'); el.className = cls; ov.appendChild(el); }
    return el;
  }
  // text changes rarely; measure only then (reading sizes every frame would force a layout every frame)
  function setText(el, text) {
    if (el._text === text) return;
    el._text = text; el.textContent = text; el.style.visibility = 'hidden'; el.style.display = 'block';
    el._w = el.offsetWidth; el._h = el.offsetHeight; el.style.visibility = '';
  }

  // the pixel fonts may arrive after the first measure: measure everything again once they are in
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { for (const el of Object.values(pool)) el._text = null; });

  // DENIED stamps and ID cards share the anchors: one piece per anchor, the newest replaces the old one
  // (an ID card raised at a gate replaces that gate's stamp; the refusal's stamp then replaces the card)
  const stamps = {}; // anchor -> { el, kind: 'stamp' | 'card' }
  function pin(anchor, el, kind, ms) {
    const old = stamps[anchor]; if (old) old.el.remove();
    ov.appendChild(el);
    stamps[anchor] = { el, kind };
    return sleep(ms).then(() => { if (stamps[anchor] && stamps[anchor].el === el) { el.remove(); delete stamps[anchor]; } });
  }
  function stampAt(anchor, text) {
    const el = document.createElement('div'); el.className = 'stamp';
    const done = pin(anchor, el, 'stamp', 1600);
    el._text = null; setText(el, text);
    return done;
  }
  // The ID card (round two, section 3): paper, 220 px, 1.2 s, above the gate (or window, or pen) where the robot shows
  // it; three lines the reducer took from the gateway's events (idLines). The stripe is the robot's own colour.
  function idCard(anchor, lines, color) {
    const el = document.createElement('div'); el.className = 'idcard'; el.style.borderTopColor = ROBOT_COLORS[color] || ROBOT_COLORS.mustard;
    const part = (l) => String(l).split(' · ').map((p) => `<span class="nw">${esc(p)}</span>`).join(' · ');
    el.innerHTML = lines.map((l, i) => `<div class="${i === 2 && /\bOK\b/.test(l) ? 'good' : ''}">${part(l)}</div>`).join('');
    const done = pin(anchor, el, 'card', ID_CARD_MS);
    el.style.visibility = 'hidden'; el.style.display = 'block'; el._w = el.offsetWidth; el._h = el.offsetHeight; el.style.visibility = '';
    return done;
  }

  // Every frame: place each element at its anchor, then push lower-priority ones down where two overlap.
  function follow() {
    if (io.inRoom ? io.inRoom() : scene.inRoom()) return;
    const state = io.getState();
    const items = []; // { el, kind, left, top, w, h }
    const add = (el, kind, p, centred = false) => {
      if (!p) { el.style.display = 'none'; return; }
      el.style.display = 'block';
      const w0 = el._w || 60, h0 = el._h || 22;
      let w = w0, h = h0;
      // a stamp is drawn turned 6 degrees and lands from 1.15x: its box for the collision pass is the turned, landing one
      if (kind === 'stamp') { w = (w0 + h0 * 0.11) * 1.15; h = (h0 + w0 * 0.11) * 1.15; }
      // pad: from the corner of that box to the corner of the element itself
      items.push({ el, kind, left: p[0] - w / 2, top: centred ? p[1] - h / 2 : p[1] - h, w, h, pad: (w - w0) / 2, padY: (h - h0) / 2 });
    };
    const shown = new Set();
    for (const a of Object.values(state.agents)) {
      if (!a.known || !scene.hasRobot(a.id)) continue;
      const el = node('tag:' + a.id, 'tag');
      setText(el, a.name);
      el.dataset.plate = a.plate;
      shown.add('tag:' + a.id);
      add(el, 'tag', scene.robotScreen(a.id));
    }
    // a retired robot's tag goes with it
    for (const [k, el] of Object.entries(pool)) if (k.startsWith('tag:') && !shown.has(k)) el.style.display = 'none';
    for (const k of scene.labels()) {
      const el = node('label:' + k, 'tag place');
      setText(el, PLACE_NAME[k] || k.toUpperCase());
      const p = scene.placeScreen(k); // a tall roof can be above the top of the screen: keep its label on screen
      add(el, 'label', p && [Math.min(innerWidth - 40, Math.max(40, p[0])), Math.max((el._h || 26) + 4, p[1])]);
    }
    const bin = node('bin', 'bincount');
    setText(bin, `BLOCKED ${state.blockedTotal}`);
    add(bin, 'bin', scene.binScreen());
    // a stamp is centred on its anchor; an ID card stands just above it
    for (const [anchor, s] of Object.entries(stamps)) add(s.el, s.kind, scene.stampAnchor(anchor), s.kind === 'stamp');
    // the inquest panel stands on the bay screen's top edge (before the bay exists: beside the agent card)
    if (inq) {
      const el = $('inquest');
      const p = (scene.bayScreen && scene.bayScreen()) || scene.stampAnchor('bay');
      // kept on screen first (the bay can sit near an edge), so the panel pass can then slide it off the HUD panels
      if (p) {
        // to the right of the bay, over the water (integrator): its left edge 60 px right of the bay screen and its
        // bottom just above the ticker, so it never covers the plaza, the pen or the robot on the lift
        const w = el._w || 300, h = el._h || 220;
        add(el, 'inquest', [Math.min(innerWidth - w / 2 - 8, p[0] + 60 + w / 2), Math.min(innerHeight - 68, Math.max(h + 8, p[1] + 110))]);
      }
      else { el.style.display = 'block'; el.style.left = `${Math.min(innerWidth - (el._w || 300) - 12, ($('card').getBoundingClientRect().right || 332) + 12)}px`; el.style.top = `${Math.max(56, innerHeight - 60 - (el._h || 200))}px`; }
    }

    // the collision pass: highest priority first; a lower one that overlaps (4 px margin) moves down by the overlap + 6 px
    items.sort((x, y) => PRIORITY[y.kind] - PRIORITY[x.kind]);
    for (const it of items) offPanels(it);
    for (let pass = 0; pass < 3; pass++) {
      let moved = false;
      for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
        const A = items[i], B = items[j];
        if (!overlaps(A.left, A.top, A.w, A.h, B.left, B.top, B.w, B.h)) continue;
        B.top += (A.top + A.h + 4 - B.top) + 6; offPanels(B); moved = true;
      }
      if (!moved) break;
    }
    for (const it of items) { it.el.style.left = `${Math.round(it.left + it.pad)}px`; it.el.style.top = `${Math.round(it.top + it.padY)}px`; }
  }
  const overlaps = (ax, ay, aw, ah, bx, by, bw, bh) => ax - 4 < bx + bw && bx - 4 < ax + aw && ay - 4 < by + bh && by - 4 < ay + ah;

  // A label that would hide under a HUD panel slides just off its nearest edge instead (the panels never move).
  // The panels' rectangles are read twice a second, not every frame.
  const PANELS = ['brand', 'mode', 'card', 'ops', 'strip', 'ticker', 'banner'];
  let panels = [], panelsAt = 0;
  function panelRects() {
    const now = performance.now();
    if (now - panelsAt < 500) return panels;
    panelsAt = now;
    // (getClientRects is empty for a hidden panel; offsetParent cannot tell, it is always null for position: fixed)
    // (the banner is always laid out, only faded: it counts while it has the class 'on')
    panels = PANELS.map((id) => $(id)).filter((el) => el && el.getClientRects().length && (el.id !== 'banner' || el.classList.contains('on'))).map((el) => el.getBoundingClientRect());
    return panels;
  }
  addEventListener('resize', () => { panelsAt = 0; });
  function offPanels(it) {
    for (const r of panelRects()) {
      if (!overlaps(it.left, it.top, it.w, it.h, r.left, r.top, r.width, r.height)) continue;
      const moves = [
        { dx: r.right + 6 - it.left, dy: 0 }, { dx: r.left - 6 - (it.left + it.w), dy: 0 },
        { dx: 0, dy: r.bottom + 6 - it.top }, { dx: 0, dy: r.top - 6 - (it.top + it.h) },
      ].filter((m) => it.left + m.dx >= 0 && it.left + m.dx + it.w <= innerWidth && it.top + m.dy >= 0 && it.top + m.dy + it.h <= innerHeight);
      if (!moves.length) continue;
      moves.sort((a, b) => Math.abs(a.dx) + Math.abs(a.dy) - Math.abs(b.dx) - Math.abs(b.dy));
      it.left += moves[0].dx; it.top += moves[0].dy;
    }
  }
  const relayout = () => { panelsAt = 0; };

  return { render, renderBadge, renderTable, follow, stampAt, idCard, banner, setGatewayStrip, shakeChip, showInquest, refreshInquest, closeInquest, openAgentSheet, openOffice, relayout, inquestOpen: () => (inq ? inq.id : null) };
}
export { TIER_ORDER };
