// The HUD: every piece of text a person reads, as crisp DOM over the canvas (docs/ISLAND_V2.md section 5).
// Panels: the agent card (left), the operator panel with the gateway strip (right), the banner, the mode badge, the
// ticker, the T table. Overlay (follows the 3D scene every frame): robot name tags, DENIED stamps anchored to the gate,
// pen or gatehouse that refused, islet labels and the BLOCKED bin count, then one collision pass so nothing overlaps.
// Pre-existing: the paper look and v1's render()/renderBadge()/ticker/table from main.js. New today: the six tool chips,
// the last-decision line, the gateway strip, anchored stamps (no speech bubbles any more) and the collision pass.
// Round two (docs/ISLAND_V2_ADDITIONS.md): the chips are buttons when live (per-tool revoke and restore), a pulled
// tool is struck red "pulled", the QUARANTINED pill, the DOM ID card over a gate, the mode badge's second word.
import { badge, badgeText, ALL_TOOLS } from './reducer.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Write markup only when it changed: live, render() runs on every poll (300 ms), and a button replaced between
// mousedown and mouseup never receives its click (checker, round two: the tool chips and the tabs).
const setHtml = (el, html) => { if (el._html !== html) { el._html = html; el.innerHTML = html; } };
const PLATE_LABEL = { none: 'NO RUN', active: 'ACTIVE', revoked: 'REVOKED', kill: 'KILL REQUESTED', stopped: 'KILLED' };
const PLACE_NAME = { gatehouse: 'GATEWAY', files: 'FILES', github: 'GITHUB', mail: 'MAIL', admin: 'ADMIN' };
const PRIORITY = { stamp: 4, card: 4, tag: 3, label: 2, bin: 1 }; // who keeps its place when two overlap
const ID_CARD_MS = 1200;

// ---------- the card's words, as plain functions (no DOM: tests/additions.test.mjs reads them) ----------
const endedOnItsOwn = (a) => a.plate === 'stopped' && !a.stopNote.startsWith('run stopped');
// the status pill: [text, css suffix]
export function statusPill(a) {
  if (endedOnItsOwn(a)) return ['RUN ENDED', 'ended'];
  if (a.plate === 'revoked' && a.quarantined) return ['QUARANTINED', 'revoked'];
  return [PLATE_LABEL[a.plate] || a.plate, a.plate];
}
// One chip of the badge. state: on (allowed) | held (allowed, but the whole badge is revoked or killed) | pulled (an
// operator took it off) | off (never on this badge). act: what a click asks the gateway for ('' = not a button: a tool
// that was never on the badge stays off, the island does not hand out new tools). sent: "sent..." until the event.
export function chipState(a, tool, pending = {}) {
  const held = a.plate === 'revoked' || a.plate === 'kill' || (a.plate === 'stopped' && !endedOnItsOwn(a));
  const on = a.allowedTools.includes(tool), pulled = !on && (a.pulled || []).includes(tool);
  return {
    state: on ? (held ? 'held' : 'on') : pulled ? 'pulled' : 'off',
    act: on ? 'revoke' : pulled ? 'restore' : '',
    sent: pending['tool:' + tool] === a.id,
  };
}
// the note: how fast a revoke bit (a badge revoke or one pulled tool), and how the run ended
export function cardNote(a) {
  const bit = a.revokeMs == null ? '' : a.revokeTool ? `blocked ${a.revokeMs} ms after the tool was pulled` : `blocked ${a.revokeMs} ms after REVOKE`;
  return { lines: [bit, a.stopNote].filter(Boolean), bad: a.revokeMs != null || a.stopNote.startsWith('run stopped') };
}

// io: { source, staleAfterMs, lastGoodPoll(), recordedOn(), getState(), selected() }
export function createHud(scene, io) {
  // ---------- the agent card ----------
  function renderCard(state, a, ui) {
    setHtml($('tabs'), Object.values(state.agents).filter((x) => x.known).map((x) => `<button data-agent="${esc(x.id)}" class="${x.id === a.id ? 'sel' : ''}">${esc(x.name)}</button>`).join(''));
    $('c-name').textContent = a.name;
    $('c-sub').textContent = `client ${a.clientId || '—'}${a.mode === 'scripted' ? ' · scripted client' : a.mode === 'replay' ? ' · replay' : ''}`;
    const [pillText, pill] = statusPill(a);
    $('c-status').textContent = pillText;
    $('c-status').className = `status st-${pill}`;
    // the badge as six chips: allowed green, pulled ones struck red, the rest grey; a revoked or killed badge holds nothing
    const chips = ALL_TOOLS.map((t) => ({ t, ...chipState(a, t, ui.pending) }));
    const n = a.allowedTools.length;
    $('c-badge').textContent = chips.some((c) => c.state === 'held') ? `${n} of ${ALL_TOOLS.length} tools · suspended` : `${n} of ${ALL_TOOLS.length} tools`;
    // live, an allowed or pulled chip is a button: it only POSTs; the chip changes when the gateway's event arrives
    const live = ui.source !== 'replay';
    setHtml($('c-chips'), chips.map((c) => {
      const extra = c.sent ? '<small>sent...</small>' : c.state === 'pulled' ? '<small>pulled</small>' : '';
      const inner = `<span class="nm">${esc(c.t)}</span>${extra}`;
      if (!live || !c.act) return `<span class="chip ${c.state}">${inner}</span>`;
      const tip = c.act === 'revoke' ? `pull ${c.t} from this badge` : `return ${c.t} to this badge`;
      return `<button class="chip ${c.state}" data-tool="${esc(c.t)}" data-act="${c.act}" title="${esc(tip)}"${c.sent ? ' disabled' : ''}>${inner}</button>`;
    }).join(''));
    $('c-calls').innerHTML = `calls allowed <b>${a.calls}</b> · blocked <b>${a.blocked}</b>`;
    const last = a.last;
    $('c-last').innerHTML = last ? `last: <span class="${last.decision === 'allow' ? 'good' : 'bad'}">${last.decision.toUpperCase()} ${esc(last.tool)}</span>${typeof last.ms === 'number' ? ` · ${last.ms} ms` : ''}` : 'last: —';
    // the note, one per line (a revoked run that was then killed has both)
    const note = cardNote(a);
    $('c-note').innerHTML = note.lines.map(esc).join('<br>');
    $('c-note').className = `note ${note.bad ? 'bad' : 'dim'}`;
  }

  // ---------- the operator panel ----------
  function renderOps(state, a, ui) {
    $('o-count').textContent = state.blockedTotal;
    $('o-for').textContent = `acts on: ${a.id}`;
    for (const b of document.querySelectorAll('#ops button[data-act]')) {
      const act = b.dataset.act;
      if (act === 'save') { b.disabled = !state.log.length; continue; }
      b.disabled = ui.source === 'replay' || !!ui.pending[act];
      b.textContent = ui.pending[act] ? 'sent...' : act.toUpperCase();
    }
  }
  // decisions · p50 · p95 · chain status, from gatewayStats(log) and the ledger panels' check
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

  // render(state, ui): ui = { selected, pending: { act: true }, source }
  function render(state, ui) {
    const a = state.agents[ui.selected] || Object.values(state.agents).find((x) => x.known) || Object.values(state.agents)[0];
    if (!a) return;
    renderCard(state, a, ui); renderOps(state, a, ui); renderTicker(state, ui);
    if ($('table').classList.contains('on')) renderTable(state);
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
    const el = document.createElement('div'); el.className = 'idcard'; el.dataset.color = color || 'mustard';
    const part = (l) => String(l).split(' · ').map((p) => `<span class="nw">${esc(p)}</span>`).join(' · ');
    el.innerHTML = lines.map((l, i) => `<div class="${i === 2 && /\bOK\b/.test(l) ? 'good' : ''}">${part(l)}</div>`).join('');
    const done = pin(anchor, el, 'card', ID_CARD_MS);
    el.style.visibility = 'hidden'; el.style.display = 'block'; el._w = el.offsetWidth; el._h = el.offsetHeight; el.style.visibility = '';
    return done;
  }

  // Every frame: place each element at its anchor, then push lower-priority ones down where two overlap.
  function follow() {
    if (scene.inRoom()) return;
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
    for (const a of Object.values(state.agents)) {
      if (!a.known || !scene.hasRobot(a.id)) continue;
      const el = node('tag:' + a.id, 'tag');
      setText(el, a.name);
      el.dataset.plate = a.plate;
      add(el, 'tag', scene.robotScreen(a.id));
    }
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

  return { render, renderBadge, renderTable, follow, stampAt, idCard, banner, setGatewayStrip };
}
