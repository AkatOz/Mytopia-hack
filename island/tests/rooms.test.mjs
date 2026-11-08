// node --test island/tests/rooms.test.mjs
// The interiors' pure parts (rooms.js): the lines each 3D board draws, without WebGL or a DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { verifyChain } from '../src/ledger.js';
import {
  linesForLedger, lineText, rowAt, layoutY, LEDGER_ROWS, LEDGER_TEX, chainExhibit, tamperCopy, linesForCaption, CAPTION,
  linesForWorkshop, linesForWhiteboard, linesForFloor, WHITEBOARD_CAPTION, toolCounts, holdersOf, lowestTierLine, normRoster,
} from '../src/rooms.js';

const demo = JSON.parse(readFileSync(new URL('../../replay/demo.json', import.meta.url)));
const log = demo.events;
const ROSTER = [
  { agent: 'research-bot', name: 'Research Bot', tier: 'silver', status: 'ACTIVE', allowed_tools: ['read_file', 'search_files', 'create_issue', 'list_issues'], made_by: 'seed' },
  { agent: 'ops-bot', name: 'Ops Bot', status: 'ACTIVE', allowed_tools: ['read_file'], made_by: 'seed' }, // no tier: inferred bronze
  { agent: 'billing-bot', name: 'Billing Bot', tier: 'gold', status: 'REVOKED', allowed_tools: ['read_file', 'search_files', 'send_email'], made_by: 'factory', color: 'teal' },
];

test('THE LEDGER board: title, header with chain id and stats, column header, the last 12 rows, newest last', async () => {
  const r = await verifyChain(log);
  const { lines, rows } = linesForLedger(demo, r);
  const text = lines.map(lineText);
  assert.equal(text.length, 3 + LEDGER_ROWS);
  assert.match(text[0], /THE LEDGER/);
  assert.match(text[1], new RegExp(`chain ${demo.chain} · ${log.length} rows · p50 \\d+ ms · p95 \\d+ ms · blocked \\d+ · ✓ chain verified`));
  assert.match(text[2], /# · time · agent · decision · tool · rule · gw ms · after revoke/);
  const shown = log.slice(-LEDGER_ROWS);
  assert.deepEqual(rows.map((x) => x && x.seq), shown.map((e) => e.seq));
  assert.ok(lines[3 + LEDGER_ROWS - 1].newest, 'the newest row is highlighted');
  assert.ok(text[3].startsWith(`#${shown[0].seq} · ${shown[0].ts.slice(11, 23)}`));
  // a deny row carries its gateway ms; every line fits the board (no cell longer than its column)
  const deny = shown.findIndex((e) => e.decision === 'deny');
  assert.ok(deny >= 0 && text[3 + deny].includes('DENY') && text[3 + deny].includes(String(shown[deny].latency_ms)));
});

test('the ledger status word: checking, not verified for placeholder hashes, broken at #k', async () => {
  assert.match(lineText(linesForLedger(log, null).lines[1]), /checking the chain/);
  const fixture = JSON.parse(readFileSync(new URL('../../contract/fixture.json', import.meta.url))).events;
  assert.match(lineText(linesForLedger(fixture, await verifyChain(fixture)).lines[1]), /not verified/);
  const bad = log.map((e) => ({ ...e })); bad[4].reason += '!';
  assert.match(lineText(linesForLedger(bad, await verifyChain(bad)).lines[1]), /✗ broken at #5/);
  assert.match(lineText(linesForLedger([], null).lines[3]), /no calls yet/);
});

test('rowAt: a uv on the chalkboard maps to the row slot under it', () => {
  const lay = layoutY(linesForLedger(log, null).lines, LEDGER_TEX.h, LEDGER_TEX.pad);
  const mid = (i) => ({ x: 0.5, y: 1 - (lay[3 + i].y0 + lay[3 + i].y1) / 2 / LEDGER_TEX.h });
  for (const i of [0, 5, LEDGER_ROWS - 1]) assert.equal(rowAt(mid(i)), i);
  assert.equal(rowAt({ x: 0.5, y: 0.99 }), -1, 'the title is not a row');
  assert.equal(rowAt(null), -1);
});

test('HASH CHAIN exhibit: the last 8 rows as receipts, every link sage on the real demo chain', async () => {
  const r = await verifyChain(log);
  const ex = chainExhibit(log, r);
  assert.equal(ex.length, 8);
  assert.deepEqual(ex.map((x) => x.seq), log.slice(-8).map((e) => e.seq));
  for (const x of ex) {
    assert.equal(x.link, 'ok');
    assert.equal(x.h6, log.find((e) => e.seq === x.seq).hash.slice(0, 6));
    assert.equal(x.back, `#${x.seq - 1}`);
  }
  assert.equal(chainExhibit(log.slice(0, 1), r)[0].back, 'genesis');
  assert.equal(chainExhibit(log, null)[0].link, 'unchecked');
});

test('TAMPER TEST: one character of a middle receipt changes; the copy breaks there and everything after fails', async () => {
  const { copy, seq } = tamperCopy(log);
  const shown = log.slice(-8).map((e) => e.seq);
  assert.ok(shown.includes(seq) && seq !== shown[0] && seq !== shown[7], 'a middle receipt');
  const i = copy.findIndex((e) => e.seq === seq);
  const a = log[i].reason, b = copy[i].reason;
  assert.equal(a.length, b.length);
  assert.equal([...a].filter((c, k) => c !== b[k]).length, 1, 'exactly one character');
  assert.equal(log[i].reason, a, 'the real log is untouched');
  const r = await verifyChain(copy);
  assert.equal(r.verified, true); assert.equal(r.ok, false); assert.equal(r.brokenAt, seq);
  const ex = chainExhibit(copy, r);
  for (const x of ex) assert.equal(x.link, x.seq < seq ? 'ok' : 'bad', `#${x.seq}`);
  assert.equal(lineText(linesForCaption(log, r, { seq })[2]), `a changed receipt: #${seq} and everything after it fails`);
  assert.equal(lineText(linesForCaption(log, await verifyChain(log), false)[2]), 'the real ledger is untouched · ✓ chain verified');
  assert.deepEqual(linesForCaption(log, null, null).slice(0, 2).map(lineText), CAPTION);
});

test('workshop boards: tool, plain line, who may do this here with tier, lowest tier, today counts', () => {
  const files = linesForWorkshop('files', ROSTER, log).map(lineText);
  assert.match(files[0], /FILES TOWER/);
  const i = files.indexOf('read_file');
  assert.equal(files[i + 1], 'read a document from the company drive');
  const who = files.slice(i + 1, files.findIndex((l, k) => k > i && l.startsWith('Bronze and up'))).join(' ');
  assert.match(who, /who may do this here: +Research Bot \(Silver\)/);
  assert.match(who, /Ops Bot \(Bronze\)/);
  assert.match(who, /Billing Bot \(Gold\) revoked/);
  const n = toolCounts(log, 'read_file');
  assert.ok(files.includes(`Bronze and up · today: ${n.allowed} allowed · ${n.refused} refused`));
  const admin = linesForWorkshop('admin', ROSTER, log).map(lineText);
  assert.ok(admin.some((l) => l.includes('nobody holds it right now')));
  assert.ok(admin.some((l) => l.startsWith('Diamond only · today:')));
  const mail = linesForWorkshop('mail', ROSTER, log).map(lineText);
  const sent = toolCounts(log, 'send_email');
  assert.ok(sent.refused > 0, 'the demo refuses send_email');
  assert.ok(mail.includes(`Gold and up · today: ${sent.allowed} allowed · ${sent.refused} refused`));
  assert.deepEqual(holdersOf(ROSTER, 'send_email').map((a) => a.name), ['Billing Bot']);
  assert.equal(lowestTierLine('create_issue'), 'Silver and up');
});

test('the Factory office whiteboard: every agent with tier, status, six tool squares, made_by', () => {
  const lines = linesForWhiteboard(ROSTER).map(lineText);
  assert.match(lines[0], /EVERY AGENT/);
  assert.equal(lines.length, 2 + ROSTER.length);
  assert.equal(lines[2], 'Research Bot · Silver · ACTIVE · ■■■■□□ · seed');
  assert.equal(lines[3], 'Ops Bot · Bronze · ACTIVE · ■□□□□□ · seed');
  assert.equal(lines[4], 'Billing Bot · Gold · REVOKED · ■■□□■□ · factory');
  assert.equal(WHITEBOARD_CAPTION, 'Badges are made and changed here. The form is on the right.');
  // the reducer's agent shape works too
  assert.equal(normRoster({ x: { id: 'x', name: 'X', allowedTools: ['read_file'], known: true } })[0].tier, 'bronze');
});

test('the Factory floor board: BUILDING during a build, line idle at rest', () => {
  assert.equal(lineText(linesForFloor({ id: 'billing-bot', name: 'Billing Bot', tier: 'gold', tools: ['a', 'b', 'c', 'd', 'e'] })[0]), 'BUILDING: Billing Bot · Gold · 5 tools');
  assert.equal(lineText(linesForFloor(null)[0]), 'line idle');
});
