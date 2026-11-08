// The hash-chain check done in the browser (docs/ISLAND_V2.md section 6). Build 3: the ledger text now lives on
// the 3D chalkboard of the gatehouse room (rooms.js); the DOM panels that used to sit over it are gone.
//
// verifyChain(log) recomputes every row's SHA-256 the way the gateway does (gateway/events.py record_hash):
//   sha256( json.dumps(row without "hash", sort_keys=True, separators=(",", ":")) )   Python's default ensure_ascii
// and checks each row's prev_hash against the previous row's hash ("genesis" for row #1). It says the chain is
// tamper-EVIDENT: a changed row no longer matches its hash, and a removed row breaks the link after it.

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

// ---------- build 2's panels, now a shim ----------
// scene.js (build 2) still calls createLedgerPanels(ctx, room, opts) and main.js reads panels.verified() for the HUD
// strip. No DOM any more: draw() checks the chain (so verified() stays truthful) and hands the log to the 3D room
// (rooms.js createRoom adapter: setLog / setOnRow). follow() has nothing to place.
export function createLedgerPanels(ctx, roomApi, opts = {}) {
  let result = null, key = '';
  if (roomApi && typeof roomApi.setOnRow === 'function' && opts.onRow) roomApi.setOnRow(opts.onRow);
  function draw(log, source = 'live', chain = '') {
    log = log || [];
    if (roomApi && typeof roomApi.setLog === 'function') roomApi.setLog(log, source, chain);
    const k = `${log.length}:${log.length ? log[log.length - 1].hash : ''}`;
    if (k === key) return;
    key = k;
    verifyChain(log.slice()).then((r) => { if (key !== k) return; result = r; if (opts.onChange) opts.onChange(verified()); }).catch(() => { result = null; });
  }
  function verified() {
    if (!result || !result.verified) return 'unverified';
    return result.ok ? 'ok' : `broken:#${result.brokenAt}`;
  }
  return { draw, follow() {}, verified };
}
