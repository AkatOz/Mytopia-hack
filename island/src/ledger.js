// The ledger room's text, as crisp DOM (docs/ISLAND_V2.md section 6), plus the hash-chain check done in the browser.
// New today. v1 painted the ledger on a canvas texture; the half-resolution render blurred it to mush, so now two DOM
// panels sit exactly over the two boards of the 3D room (room.js): THE LEDGER over the chalkboard, HASH CHAIN over
// the paper beside it. Every frame follow() projects each board's four corners with the camera and moves its panel.
//
// verifyChain(log) recomputes every row's SHA-256 the way the gateway does (gateway/events.py record_hash):
//   sha256( json.dumps(row without "hash", sort_keys=True, separators=(",", ":")) )   Python's default ensure_ascii
// and checks each row's prev_hash against the previous row's hash ("genesis" for row #1). It says the chain is
// tamper-EVIDENT: a changed row no longer matches its hash, and a removed row breaks the link after it.
import { gatewayStats } from './reducer.js';

// ---------- the check ----------
const HEX64 = /^[0-9a-f]{64}$/;
// JSON exactly as Python writes it with ensure_ascii: every character above 0x7f becomes \uXXXX
const asciiJson = (v) => JSON.stringify(v).replace(/[\u0080-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
function canon(v) {
  if (v === null || typeof v !== 'object') return asciiJson(v);
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  return '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => asciiJson(k) + ':' + canon(v[k])).join(',') + '}';
}
// the canonical JSON of a row: keys sorted, no spaces, the hash field removed
export function canonicalJson(row) {
  const body = { ...row };
  delete body.hash;
  return canon(body);
}
const digests = new Map(); // canonical JSON -> hex digest (rows never change, so each is hashed once)
async function sha256Hex(text) {
  if (digests.has(text)) return digests.get(text);
  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  digests.set(text, hex);
  return hex;
}

// -> { ok, brokenAt: seq | null, verified, links: { seq: 'ok' | 'bad' } }
// verified is false when there is nothing real to check: placeholder hashes (the replay fixture) or no crypto.subtle.
export async function verifyChain(log) {
  const rows = log || [];
  if (!rows.length) return { ok: true, brokenAt: null, verified: false, links: {} };
  if (rows.some((r) => !HEX64.test(String(r.hash || '')))) return { ok: false, brokenAt: null, verified: false, links: {} };
  if (!globalThis.crypto || !globalThis.crypto.subtle) return { ok: false, brokenAt: null, verified: false, links: {} };
  const links = {};
  // the island reads the log from seq 1, so the first row links to "genesis"; a log that starts later is checked from there
  let prev = rows[0].seq === 1 ? 'genesis' : rows[0].prev_hash;
  for (const r of rows) {
    const good = r.prev_hash === prev && (await sha256Hex(canonicalJson(r))) === r.hash;
    links[r.seq] = good ? 'ok' : 'bad';
    if (!good) return { ok: false, brokenAt: r.seq, verified: true, links };
    prev = r.hash;
  }
  return { ok: true, brokenAt: null, verified: true, links };
}

// ---------- the two panels ----------
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
const DECISION = { allow: 'ALLOW', deny: 'DENY', revoked: 'REVOKED', restored: 'RESTORED', kill_requested: 'KILL', run_started: 'START', run_stopped: 'STOP' };
const toneOf = (e) => (e.decision === 'allow' ? 'allow' : e.decision === 'deny' ? 'deny' : e.rule === 'harness' || e.tool === 'harness' ? 'harness' : 'admin');
const LEDGER_ROWS = 12, CHAIN_LINKS = 8;
// percent; they add up to 100. Integrator: at 94 characters the hash column cut "3292d823 ← e9613b5f" short by a
// few pixels; 100 characters across and a wider hash column fit every column's longest value.
const COLS = [4.9, 13.1, 9, 9, 13.1, 15.2, 4.9, 9, 21.8];
const LEDGER_CHARS = 100;                                 // characters across one ledger row, padding included

export function createLedgerPanels(ctx, roomApi, opts = {}) {
  const { THREE, stage } = ctx;
  const make = (cls) => { const el = document.createElement('div'); el.className = 'room-panel ' + cls; el.style.display = 'none'; document.body.appendChild(el); return el; };
  const ledgerEl = make('ledger-panel'), chainEl = make('chain-panel');
  let log = [], source = 'live', chainId = '', result = null, checking = false, checkedKey = '';

  function statusWord() {
    if (!log.length) return { cls: 'dim', text: 'no rows yet' };
    if (checking && !result) return { cls: 'dim', text: 'checking the chain…' };
    if (!result || !result.verified) return { cls: 'dim', text: source === 'replay' ? 'not verified (replay fixture)' : 'not verified' };
    return result.ok ? { cls: 'ok', text: '✓ chain verified' } : { cls: 'bad', text: `✗ broken at #${result.brokenAt}` };
  }

  function drawLedger() {
    const st = gatewayStats(log), sw = statusWord();
    const ms = (v) => (v == null ? '—' : `${v} ms`);
    const head = [chainId ? `chain ${esc(chainId)}` : null, `${log.length} rows`, `p50 ${ms(st.p50)}`, `p95 ${ms(st.p95)}`, `blocked ${st.blocked}`]
      .filter(Boolean).join(' · ');
    const rows = log.slice(-LEDGER_ROWS).map((e, i, all) => {
      const gw = e.decision === 'allow' || e.decision === 'deny' ? (e.latency_ms ?? '') : '';
      const since = typeof e.ms_since_revoke === 'number' ? `${e.ms_since_revoke} ms` : '';
      const h8 = String(e.hash || '').slice(0, 8), p8 = String(e.prev_hash || '').slice(0, 8);
      return `<tr class="t-${toneOf(e)}${i === all.length - 1 ? ' newest' : ''}">`
        + `<td>#${e.seq}</td><td>${esc(String(e.ts || '').slice(11, 23))}</td><td>${esc(String(e.agent || '').replace(/-bot$/, ''))}</td>`
        + `<td class="dec">${esc(DECISION[e.decision] || String(e.decision).toUpperCase())}</td><td>${esc(e.tool)}</td><td>${esc(e.rule)}</td>`
        + `<td class="num">${gw}</td><td class="num">${since}</td><td class="hash">${esc(h8)} ← ${esc(p8)}</td></tr>`;
    }).join('');
    ledgerEl.innerHTML = `<div class="lp-title"><b>THE LEDGER</b><span>${source === 'replay' ? 'recorded rows' : 'the gateway log, live'}</span></div>`
      + `<div class="lp-strip">${head} · <span class="${sw.cls}">${esc(sw.text)}</span></div>`
      // column widths follow the longest value of each column, in characters: #123, 21:40:03.060, research, RESTORED,
      // search_files, status-revoked, 178, 1840 ms, 7457fa6c ← genesis
      + `<table><colgroup>${COLS.map((w) => `<col style="width:${w}%">`).join('')}</colgroup>`
      + `<thead><tr><th>#</th><th>time</th><th>agent</th><th>decision</th><th>tool</th><th>rule</th><th>gw ms</th><th>after revoke</th><th>hash ← prev</th></tr></thead>`
      + `<tbody>${rows || '<tr><td colspan="9" class="empty">no calls yet</td></tr>'}</tbody></table>`;
  }

  function drawChain() {
    const links = result && result.verified ? result.links : {};
    const items = log.slice(-CHAIN_LINKS).reverse().map((e) => {
      const mark = links[e.seq] === 'ok' ? '<span class="ok">✓</span>' : links[e.seq] === 'bad' ? '<span class="bad">✗</span>' : '<span class="dim">·</span>';
      const back = e.prev_hash === 'genesis' ? 'genesis' : `#${e.seq - 1} ${esc(String(e.prev_hash || '').slice(0, 4))}…`;
      return `<li>${mark}<b>#${e.seq}</b> ${esc(String(e.hash || '').slice(0, 4))}…<span class="arrow">←</span>${back}</li>`;
    }).join('');
    const sw = statusWord();
    chainEl.innerHTML = `<div class="cp-title">HASH CHAIN</div><div class="cp-sub">each row names the hash of the row before it</div>`
      + `<ul>${items || '<li class="dim">empty</li>'}</ul>`
      + `<div class="cp-foot ${sw.cls}">${esc(sw.text)}${result && result.verified ? ' · SHA-256 in this browser' : ''}</div>`;
  }

  // draw(log, source, chainId): fills both panels now, then checks the chain in the background and fills them again
  function draw(newLog, newSource = 'live', newChain = '') {
    log = newLog || []; source = newSource; chainId = newChain || chainId;
    const key = `${log.length}:${log.length ? log[log.length - 1].hash : ''}`;
    if (key !== checkedKey) {
      checkedKey = key; checking = true;
      const snapshot = log.slice();
      verifyChain(snapshot).then((r) => {
        if (key !== checkedKey) return; // a newer draw started its own check
        result = r; checking = false; drawLedger(); drawChain();
        if (opts.onChange) opts.onChange(verified());
      }).catch(() => { checking = false; result = null; });
    }
    drawLedger(); drawChain();
  }

  function verified() {
    if (!result || !result.verified) return 'unverified';
    return result.ok ? 'ok' : `broken:#${result.brokenAt}`;
  }

  // put a panel over a board: project its four world corners, take their bounding box, scale the font with its size
  const v = new THREE.Vector3();
  function place(el, corners, lines, charsPerLine) {
    if (!corners || corners.length !== 4) { el.style.display = 'none'; return; }
    const r = stage._renderer.domElement.getBoundingClientRect(), cam = stage._camera;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const c of corners) {
      v.copy(c).project(cam);
      const sx = r.left + (v.x + 1) / 2 * r.width, sy = r.top + (1 - v.y) / 2 * r.height;
      x0 = Math.min(x0, sx); x1 = Math.max(x1, sx); y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
    }
    const w = x1 - x0, h = y1 - y0;
    if (!(w > 40 && h > 30)) { el.style.display = 'none'; return; }
    el.style.display = 'block';
    el.style.left = `${Math.round(x0)}px`; el.style.top = `${Math.round(y0)}px`;
    el.style.width = `${Math.round(w)}px`; el.style.height = `${Math.round(h)}px`;
    // VT323 is 0.4 em wide per character (measured) and the panels use line-height 1.12: fit the lines and the widest line
    const px = Math.max(9, Math.min(44, Math.min(h / (lines * 1.12), w / (charsPerLine * 0.4))));
    el.style.fontSize = `${px.toFixed(1)}px`;
  }
  function follow() {
    const open = roomApi && roomApi.room && roomApi.room.visible;
    if (!open || !roomApi.boards) { ledgerEl.style.display = 'none'; chainEl.style.display = 'none'; return; }
    place(ledgerEl, roomApi.boards.ledger, LEDGER_ROWS + 5.6, LEDGER_CHARS); // + title, strip, a two-line header
    place(chainEl, roomApi.boards.chain, CHAIN_LINKS + 4.4, 30); // 30: '✓ #123 a97b… ← #122 8bf8…' with three-digit seqs (26 clipped #12)
  }

  return { draw, follow, verified };
}
