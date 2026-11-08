// node --test island/tests
// Round two (docs/ISLAND_V2_ADDITIONS.md): per-tool revoke and restore, quarantine, the ID card's lines, the
// three-state mode badge, and the agent card's words. tests/additions.json is a hand-written recording of those
// events in the gateway's shapes (contract/README.md); it also plays in the browser: ?replay=tests/additions.json
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { apply, initialState, badge, badgeText, idLines, tickerLine, isQuarantine, tokenLine } from '../src/reducer.js';
import { chipState, cardNote, statusPill } from '../src/hud.js';

const rec = JSON.parse(readFileSync(new URL('./additions.json', import.meta.url))).events;
const fixture = JSON.parse(readFileSync(new URL('../../contract/fixture.json', import.meta.url))).events;
const demo = JSON.parse(readFileSync(new URL('../../replay/demo.json', import.meta.url))).events;
const run = (events, s = initialState()) => { const all = []; for (const e of events) { const r = apply(s, e); s = r.state; all.push(r.effects); } return { s, all }; };
const upTo = (seq) => run(rec.filter((e) => e.seq <= seq));
const scriptOf = (effects) => effects.find((f) => f.kind === 'script');
const idCards = (effects) => (scriptOf(effects)?.steps || []).filter((st) => st.showId).map((st) => st.card);

test('every event of the additions recording draws something', () => {
  run(rec).all.forEach((fx, i) => assert.ok(fx.length > 0, `event seq ${i + 1} drew nothing`));
});

test('a per-tool revoked takes that tool off the badge, acks tool:<name>, locks the gate; no plate, pen or chief', () => {
  const { s, all } = upTo(4);
  const a = s.agents['research-bot'], fx = all[3];
  assert.deepEqual(a.allowedTools, ['read_file', 'search_files', 'list_issues']);
  assert.deepEqual(a.pulled, ['create_issue']);
  assert.equal(a.plate, 'active');
  assert.equal(a.at, 'door_files');                      // where it was: nobody escorted it anywhere
  assert.equal(s.gates.github.locked, true);
  assert.equal(s.gates.files.locked, false);
  assert.ok(fx.some((f) => f.kind === 'ack' && f.action === 'tool:create_issue'));
  assert.ok(fx.some((f) => f.kind === 'padlock' && f.gate === 'github' && f.on === true));
  assert.ok(!fx.some((f) => f.kind === 'ack' && f.action === 'revoke'));
  assert.ok(!fx.some((f) => ['halt', 'plate', 'script', 'freeze'].includes(f.kind)));
  assert.ok(!fx.some((f) => f.kind === 'banner' && f.text === 'REVOKED'));
  assert.equal(tickerLine(rec[3]), 'REVOKED create_issue: create_issue pulled from badge research-bot by operator [admin]');
});

test('the next call of the pulled tool is refused at its gate with the escort, and the note measures from the pull', () => {
  const { s, all } = upTo(5);
  const a = s.agents['research-bot'], steps = scriptOf(all[4]).steps;
  assert.ok(steps.some((st) => st.gate === 'github' && st.lamp === 'bad'));
  assert.ok(steps.some((st) => st.fx && st.fx.kind === 'stampAt' && st.fx.anchor === 'gate:github'));
  assert.ok(steps.some((st) => st.escort && st.escort.by === 'booth:github'));
  assert.equal(a.revokeMs, 412);
  assert.equal(a.revokeTool, 'create_issue');
  assert.deepEqual(cardNote(a).lines, ['its next create_issue call was refused (0.4 s after the pull)']); // user test: the agent's timing, not an enforcement gap
  assert.equal(cardNote(a).bad, true);
  assert.match(tickerLine(rec[4]), / · 412 ms after the tool was pulled$/);
});

test('a per-tool restored puts the tool back in catalog order, acks it, unlocks the gate, clears the note', () => {
  const { s, all } = upTo(6);
  const a = s.agents['research-bot'], fx = all[5];
  assert.deepEqual(a.allowedTools, ['read_file', 'search_files', 'create_issue', 'list_issues']);
  assert.deepEqual(a.pulled, []);
  assert.equal(a.plate, 'active');
  assert.equal(s.gates.github.locked, false);
  assert.ok(fx.some((f) => f.kind === 'ack' && f.action === 'tool:create_issue'));
  assert.ok(fx.some((f) => f.kind === 'padlock' && f.gate === 'github' && f.on === false));
  assert.ok(!fx.some((f) => f.kind === 'ack' && f.action === 'restore'));
  assert.ok(!fx.some((f) => f.kind === 'banner' && f.text === 'RESTORED'));
  assert.equal(a.revokeMs, null);
});

test('without a badge= list the reducer still removes and re-adds the one tool', () => {
  const bare = (e) => ({ ...e, args_summary: 'by=operator' });
  const { s } = run([rec[0], bare(rec[3])]);
  assert.deepEqual(s.agents['research-bot'].allowedTools, ['read_file', 'search_files', 'list_issues']);
  const back = apply(s, bare(rec[5])).state;
  assert.deepEqual(back.agents['research-bot'].allowedTools, ['read_file', 'search_files', 'create_issue', 'list_issues']);
});

test('a gate stays locked while any agent has one of its tools pulled', () => {
  const pull = (seq, agent, tool) => ({ seq, ts: '2026-11-07T23:00:00.000Z', agent, agent_mode: 'scripted', tool, decision: 'revoked', rule: 'admin', reason: `${tool} pulled from badge ${agent} by operator`, args_summary: '', latency_ms: 0 });
  const put = (seq, agent, tool) => ({ ...pull(seq, agent, tool), decision: 'restored', reason: `${tool} returned to badge ${agent} by operator` });
  let { s } = run([pull(1, 'research-bot', 'read_file'), pull(2, 'ops-bot', 'read_file')]);
  s = apply(s, put(3, 'research-bot', 'read_file')).state;
  assert.equal(s.gates.files.locked, true);   // ops-bot still has it pulled
  const last = apply(s, put(4, 'ops-bot', 'read_file'));
  assert.equal(last.state.gates.files.locked, false);
  assert.ok(last.effects.some((f) => f.kind === 'padlock' && f.gate === 'files' && f.on === false));
});

// Build 3 changed this on purpose (docs/BUILD3.md section 6): a quarantine goes to the inspection bay, not the pen.
test('quarantine: drawn like a revoke (chief escort, plate red) into the inspection bay, QUARANTINED banner, no ack', () => {
  const { s, all } = upTo(11);
  const a = s.agents['research-bot'], fx = all[10];
  assert.equal(isQuarantine(rec[10]), true);
  assert.equal(a.plate, 'revoked');
  assert.equal(a.quarantined, true);
  assert.equal(a.at, 'bay');
  assert.equal(s.gates.mail.refused, 3);                // three refusals at the Mail gate first
  assert.ok(fx.some((f) => f.kind === 'banner' && f.text === 'QUARANTINED'));
  assert.ok(!fx.some((f) => f.kind === 'banner' && f.text === 'REVOKED'));
  assert.ok(!fx.some((f) => f.kind === 'ack'));
  assert.ok(fx.some((f) => f.kind === 'halt'));
  assert.deepEqual(scriptOf(fx).steps[0], { escort: { by: 'chief', to: 'bay_lift' } });
  assert.deepEqual(statusPill(a), ['QUARANTINED', 'revoked']);
  assert.match(tickerLine(rec[10]), /^QUARANTINED admin: badge pulled by quarantine/);
  // the refusal after it is drawn over the bay and carries no ms (a quarantine starts no clock)
  const after = run(rec).all[11];
  assert.ok(scriptOf(after).steps.some((st) => st.fx && st.fx.kind === 'stampAt' && st.fx.anchor === 'bay'));
  assert.equal(run(rec).s.agents['research-bot'].revokeMs, null);
});

test('an operator revoke still acks REVOKE and says REVOKED; restore clears QUARANTINED', () => {
  const { s, all } = run(fixture.slice(0, 9));
  assert.ok(all[8].some((f) => f.kind === 'ack' && f.action === 'revoke'));
  assert.ok(all[8].some((f) => f.kind === 'banner' && f.text === 'REVOKED'));
  assert.deepEqual(statusPill(s.agents['research-bot']), ['REVOKED', 'revoked']);
  const q = run(rec).s;
  const back = apply(q, { seq: 13, ts: '2026-11-07T23:11:10.000Z', agent: 'research-bot', agent_mode: 'scripted', tool: 'admin', decision: 'restored', rule: 'admin', reason: 'badge ACTIVE again', args_summary: 'by=operator', latency_ms: 0 }).state;
  assert.equal(back.agents['research-bot'].quarantined, false);
  assert.deepEqual(statusPill(back.agents['research-bot']), ['ACTIVE', 'active']);
});

test('the three-state mode badge: LIVE · model, LIVE · scripted, REPLAY; STALE stays STALE', () => {
  assert.equal(badgeText('LIVE', 'model'), 'LIVE · model');
  assert.equal(badgeText('LIVE', 'scripted'), 'LIVE · scripted');
  assert.equal(badgeText('LIVE', null), 'LIVE');           // no event yet: it does not guess
  assert.equal(badgeText('REPLAY', 'model'), 'REPLAY');
  assert.equal(badgeText('STALE', 'scripted'), 'STALE');
  assert.equal(badgeText(badge({ source: 'replay', now: 0, lastGoodPoll: 0 }), 'model'), 'REPLAY');
  assert.equal(badgeText(badge({ source: 'live', now: 5000, lastGoodPoll: 4000 }), upTo(1).s.agents['research-bot'].mode), 'LIVE · scripted');
  assert.equal(initialState().agents['research-bot'].mode, null);
});

test('ID card lines: client and expiry from run_started, signature expiry from a status-revoked reason, never invented', () => {
  assert.deepEqual(idLines(initialState([{ agent: 'x', client_id: '' }]).agents.x), ['client —', 'scope mytopia/tools', 'token: checked by the gateway']);
  const first = run(demo.slice(0, 1));
  assert.deepEqual(idCards(first.all[0]), [{ at: 'gatehouse', lines: ['client s2ch2ppk', 'scope mytopia/tools', 'token OK · expires in 300 s'] }]);
  // at the Files gate (seq 3) the card still says what run_started said
  assert.deepEqual(idCards(run(demo.slice(0, 3)).all[2])[0], { at: 'gate:files', lines: ['client s2ch2ppk', 'scope mytopia/tools', 'token OK · expires in 300 s'] });
  // in the pen after REVOKE, the status refusal's own words: signature OK, expires in 266 s
  const pen = run(demo.slice(0, 12));
  assert.deepEqual(idCards(pen.all[11])[0], { at: 'pen', lines: ['client s2ch2ppk', 'scope mytopia/tools', 'signature OK · expires in 266 s'] });
  assert.equal(pen.s.agents['research-bot'].token, 'signature OK · expires in 266 s');
  assert.equal(tokenLine('badge research-bot: 4 tools'), null);
  // a refusal at the Mail gate shows the card at that gate
  assert.equal(idCards(run(demo.slice(0, 6)).all[5])[0].at, 'gate:mail');
});

// Build 3 changed the chips on purpose: a tool never on the badge is now 'grant' (or 'locked' above the tier's ceiling,
// with a hint), and a held chip no longer acts. tests/factory.test.mjs covers all five states.
test('the chips: allowed and pulled ones act, "sent..." only for the agent it acts on', () => {
  const a = upTo(4).s.agents['research-bot'];
  assert.deepEqual(chipState(a, 'read_file'), { state: 'on', act: 'revoke', sent: false, hint: '' });
  assert.deepEqual(chipState(a, 'create_issue'), { state: 'pulled', act: 'restore', sent: false, hint: '' });
  assert.deepEqual(chipState(a, 'send_email'), { state: 'locked', act: '', sent: false, hint: 'Gold+' });  // research-bot is Silver
  assert.equal(chipState(a, 'read_file', { 'tool:read_file': 'research-bot' }).sent, true);
  assert.equal(chipState(a, 'read_file', { 'tool:read_file': 'ops-bot' }).sent, false);
  const held = run(rec).s.agents['research-bot'];                  // quarantined: allowed tools are held
  assert.equal(chipState(held, 'read_file').state, 'held');
});
