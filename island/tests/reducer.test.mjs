// node --test island/tests
// The reducer is the island's only logic, so it carries the tests: every fixture event draws something, the demo story
// ends in the right state, and the v2 scripts (docs/ISLAND_V2.md section 4) have the right shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { apply, initialState, withRoster, badge, fresh, rung, gatewayStats, percentile, DEFAULT_ROSTER } from '../src/reducer.js';

const fixture = JSON.parse(readFileSync(new URL('../../contract/fixture.json', import.meta.url))).events;
const run = (events, s = initialState()) => { const all = []; for (const e of events) { const r = apply(s, e); s = r.state; all.push(r.effects); } return { s, all }; };
const scriptOf = (effects) => effects.find((f) => f.kind === 'script');
const stepIndex = (steps, pred) => steps.findIndex(pred);
const fxIndex = (steps, kind) => steps.findIndex((st) => st.fx && st.fx.kind === kind);

test('every one of the 21 fixture events draws something', () => {
  const { all } = run(fixture);
  assert.equal(all.length, 21);
  all.forEach((fx, i) => assert.ok(fx.length > 0, `event seq ${i + 1} drew nothing`));
});

test('the demo story ends in the right state (no fire anywhere)', () => {
  const { s } = run(fixture);
  const rb = s.agents['research-bot'], ob = s.agents['ops-bot'];
  assert.equal(s.cursor, 21);
  assert.equal(s.blockedTotal, 7);
  assert.equal(rb.plate, 'active');             // restored at seq 17
  assert.equal(rb.revokeMs, null);              // cleared on restore
  assert.equal(rb.at, 'plaza');                 // walked out of the pen on restore
  assert.equal(ob.plate, 'stopped');            // exit 0
  assert.equal(ob.at, 'hatch');                 // walked back to the dock
  assert.equal(s.gates.mail.refused, 1);        // send_email refused at the Mail gate (seq 6)
  assert.equal(s.gates.github.refused, 1);      // ops-bot's create_issue refused at the GitHub gate (seq 20)
  assert.equal(s.gates.files.refused, 0);       // the read_file denies were status/token refusals, not the gate's
  assert.equal(s.gates.admin.refused, 0);
  assert.equal(s.buildings.gatehouse.denials, 2); // two tools/list denials (kept for compatibility)
  for (const b of Object.values(s.buildings)) assert.equal('fire' in b, false);
});

test('no effect ever mentions fire', () => {
  const { all } = run(fixture);
  assert.equal(JSON.stringify(all).includes('fire'), false);
});

test('revoke shows the measured ms, the plate turns red, the chief escorts the robot into the pen', () => {
  const { s, all } = run(fixture.slice(0, 10));
  assert.equal(s.agents['research-bot'].plate, 'revoked');
  assert.equal(s.agents['research-bot'].revokeMs, 1840);
  assert.equal(s.agents['research-bot'].at, 'pen');
  const rev = all[8];
  assert.ok(rev.some((f) => f.kind === 'halt' && f.agent === 'research-bot'));
  assert.ok(rev.some((f) => f.kind === 'banner' && f.text === 'REVOKED'));
  const steps = scriptOf(rev).steps;
  assert.deepEqual(steps[0], { escort: { by: 'chief', to: 'pen_gate' } });
  assert.deepEqual(steps[1], { pen: 'in' });
  // the next deny is drawn at the pen, the robot does not move
  const deny = scriptOf(all[9]).steps;
  assert.equal(stepIndex(deny, (st) => st.walk), -1);
  assert.ok(deny.some((st) => st.fx && st.fx.kind === 'stampAt' && st.fx.anchor === 'pen'));
  assert.ok(deny.some((st) => st.showId));
});

test('kill then run_stopped: RUN KILLED, power down, the ms after KILL; no summon (build 3: the chief goes home)', () => {
  let s = initialState(), last;
  for (const e of fixture.slice(0, 16)) { last = apply(s, e); s = last.state; }
  // build 3 changed this on purpose: a killed run no longer summons the chief; the Factory cart takes the robot to the bay
  const steps = scriptOf(last.effects).steps;
  assert.ok(!steps.some((st) => st.summon));
  assert.ok(steps.some((st) => st.dismiss === 'chief'));
  assert.ok(steps.some((st) => st.cart && st.cart.to === 'bay_lift'));
  assert.ok(last.effects.some((f) => f.kind === 'banner' && f.text === 'RUN KILLED'));
  assert.ok(last.effects.some((f) => f.kind === 'powerDown' && f.agent === 'research-bot'));
  assert.equal(s.agents['research-bot'].stopNote, 'run stopped 1160 ms after KILL');
  assert.equal(s.ticker, 'run stopped 1160 ms after KILL · exit 1 (killed by harness)');
});

test('kill_requested freezes the robot and sends the chief', () => {
  const { all } = run(fixture.slice(0, 14));
  const k = all[13];
  assert.ok(k.some((f) => f.kind === 'freeze' && f.agent === 'research-bot'));
  assert.ok(k.some((f) => f.kind === 'plate' && f.plate === 'kill'));
  assert.deepEqual(scriptOf(k).steps, [{ summon: 'chief', to: 'agent' }]);
});

test('a run that ends by itself is not shown as killed and walks back to the hatch', () => {
  const { all } = run(fixture);
  assert.ok(all[20].some((f) => f.kind === 'banner' && f.text === 'RUN ENDED'));
  assert.ok(!all[20].some((f) => f.kind === 'powerDown'));
  const steps = scriptOf(all[20]).steps;
  assert.ok(steps.some((st) => st.walk === 'hatch'));
  assert.ok(steps.some((st) => st.sink));
});

test('an allow: walk to the right gate, show the ID, the gate opens, walk to the door, then a green slip', () => {
  const { all } = run(fixture.slice(0, 3)); // seq 3: read_file allowed
  const steps = scriptOf(all[2]).steps;
  const walkGate = stepIndex(steps, (st) => st.walk === 'gate_files');
  const showId = stepIndex(steps, (st) => st.showId);
  const gate = stepIndex(steps, (st) => st.gate === 'files' && st.lamp === 'ok');
  const walkDoor = stepIndex(steps, (st) => st.walk === 'door_files');
  const slip = stepIndex(steps, (st) => st.fx && st.fx.kind === 'slip' && st.fx.from === 'door:files' && st.fx.ok === true);
  assert.ok(walkGate >= 0 && walkGate < showId && showId < gate && gate < walkDoor && walkDoor < slip, JSON.stringify(steps));
  // a second call to the same islet does not walk again: the robot is already at the door
  const again = scriptOf(run(fixture.slice(0, 4)).all[3]).steps; // seq 4: search_files, also Files
  assert.equal(stepIndex(again, (st) => st.walk), -1);
  assert.ok(fxIndex(again, 'slip') >= 0);
});

test('an allow-list deny: walk, show the ID, the gate refuses, a stamp over the gate, the booth guard escorts', () => {
  const { s, all } = run(fixture.slice(0, 6)); // seq 6: send_email is not on research-bot's badge
  const steps = scriptOf(all[5]).steps;
  const walkGate = stepIndex(steps, (st) => st.walk === 'gate_mail');
  const showId = stepIndex(steps, (st) => st.showId);
  const gate = stepIndex(steps, (st) => st.gate === 'mail' && st.lamp === 'bad');
  const stamp = stepIndex(steps, (st) => st.fx && st.fx.kind === 'stampAt' && st.fx.anchor === 'gate:mail' && st.fx.text === 'DENIED send_email');
  const escort = stepIndex(steps, (st) => st.escort && st.escort.by === 'booth:mail' && st.escort.to === 'plaza');
  assert.ok(walkGate >= 0 && walkGate < showId && showId < gate && gate < stamp && stamp < escort, JSON.stringify(steps));
  assert.ok(steps.some((st) => st.fx && st.fx.kind === 'counter' && st.fx.gate === 'mail' && st.fx.n === 1));
  assert.ok(steps.some((st) => st.fx && st.fx.kind === 'packet'));
  assert.ok(steps.some((st) => st.fx && st.fx.kind === 'slip' && st.fx.ok === false));
  assert.equal(s.agents['research-bot'].at, 'plaza');
  assert.equal(s.gates.mail.refused, 1);
});

test('a token deny for an agent that is held in the pen is drawn at the gatehouse, without a walk', () => {
  const { all } = run(fixture.slice(0, 13)); // seq 13: tampered token while research-bot is revoked
  const steps = scriptOf(all[12]).steps;
  assert.equal(stepIndex(steps, (st) => st.walk), -1);
  assert.ok(steps.some((st) => st.fx && st.fx.kind === 'stampAt' && st.fx.anchor === 'gatehouse'));
});

test('an unknown agent is drawn at the gatehouse and gets no robot', () => {
  const r = apply(initialState(), { seq: 1, ts: '2026-11-08T00:00:00Z', agent: 'unknown', tool: 'tools/list', decision: 'deny', rule: 'token', reason: 'invalid_token', latency_ms: 2 });
  assert.equal(r.state.agents.unknown.known, false);
  const steps = scriptOf(r.effects).steps;
  assert.equal(stepIndex(steps, (st) => st.walk || st.showId), -1);
  assert.ok(steps.some((st) => st.fx && st.fx.kind === 'stampAt' && st.fx.anchor === 'gatehouse'));
});

test('the smoke ladder over a booth: rung 1 after 2 refusals at that gate, rung 2 after 4', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 9].map(rung), [0, 0, 1, 1, 2, 2]);
  let s = initialState(); const smokes = [];
  for (let i = 1; i <= 4; i++) {
    const r = apply(s, { seq: i, ts: '2026-11-08T00:00:0' + i + 'Z', agent: 'ops-bot', tool: 'send_email', decision: 'deny', rule: 'allow-list', reason: 'not on badge', latency_ms: 9 });
    s = r.state;
    const st = (scriptOf(r.effects)?.steps || []).find((x) => x.fx && x.fx.kind === 'smoke');
    smokes.push(st ? st.fx.rung : 0);
  }
  assert.deepEqual(smokes, [0, 1, 1, 2]);
  assert.equal(s.gates.mail.refused, 4);
});

test('run_started: rise from the hatch, show the ID at the gatehouse window, AUTHENTICATED, then the plaza', () => {
  const { s, all } = run(fixture.slice(0, 1));
  const steps = scriptOf(all[0]).steps;
  const spawn = stepIndex(steps, (st) => st.spawn);
  const win = stepIndex(steps, (st) => st.walk === 'gh_window');
  const id = stepIndex(steps, (st) => st.showId);
  const banner = stepIndex(steps, (st) => st.fx && st.fx.kind === 'banner' && st.fx.text === 'AUTHENTICATED');
  const plaza = stepIndex(steps, (st) => st.walk === 'plaza');
  assert.ok(spawn >= 0 && spawn < win && win < id && id < banner && banner < plaza, JSON.stringify(steps));
  assert.equal(s.agents['research-bot'].clientId, '3f9a1c7e'); // read from "token OK: client 3f9a1c7e ..."
});

test('dedupe and ordering by seq', () => {
  let s = initialState();
  s = apply(s, fixture[2]).state;
  const again = apply(s, fixture[2]);
  assert.equal(again.effects.length, 0);
  assert.equal(again.state, s);
  assert.deepEqual(fresh([fixture[5], fixture[3], fixture[3], fixture[1]], 2).map((e) => e.seq), [4, 6]);
});

test('apply is pure', () => {
  const s0 = initialState(); const snap = JSON.stringify(s0);
  let s = s0;
  for (const e of fixture) s = apply(s, e).state;
  assert.equal(JSON.stringify(s0), snap);
});

test('withRoster keeps run state and marks the roster agents known', () => {
  const { s } = run(fixture.slice(0, 3));
  const s2 = withRoster(s, [{ ...DEFAULT_ROSTER[0], name: 'Research Bot 2' }]);
  assert.equal(s2.agents['research-bot'].name, 'Research Bot 2');
  assert.equal(s2.agents['research-bot'].calls, s.agents['research-bot'].calls);
  assert.equal(s2.agents['research-bot'].known, true);
  assert.notEqual(s2, s);
});

test('badge: LIVE, STALE, REPLAY', () => {
  assert.equal(badge({ source: 'replay', now: 0, lastGoodPoll: 0 }), 'REPLAY');
  assert.equal(badge({ source: 'live', now: 5000, lastGoodPoll: 3000 }), 'LIVE');
  assert.equal(badge({ source: 'live', now: 6001, lastGoodPoll: 3000 }), 'STALE');
  assert.equal(badge({ source: 'live', now: 10, lastGoodPoll: null }), 'STALE');
});

test('buttons only acknowledge on the matching event', () => {
  const { all } = run(fixture);
  assert.ok(all[8].some((f) => f.kind === 'ack' && f.action === 'revoke'));
  assert.ok(all[13].some((f) => f.kind === 'ack' && f.action === 'kill'));
  assert.ok(all[16].some((f) => f.kind === 'ack' && f.action === 'restore'));
  const acks = all.flat().filter((f) => f.kind === 'ack');
  assert.equal(acks.length, 3);
});

test('run_stopped marked "killed by harness" counts as a kill even without the kill_requested row', () => {
  let s = initialState();
  for (const e of fixture.slice(0, 13)) s = apply(s, e).state; // up to the tampered-token deny, no kill_requested
  const r = apply(s, { ...fixture[15], seq: 14 });            // run_stopped: exit 1 (killed by harness)
  assert.ok(r.effects.some((f) => f.kind === 'banner' && f.text === 'RUN KILLED'));
  assert.ok(r.effects.some((f) => f.kind === 'powerDown'));
  assert.equal(r.state.agents['research-bot'].stopNote, 'run stopped');
});

test('a gateway "exit 0 (exited)" run_stopped is RUN ENDED', () => {
  let s = initialState();
  for (const e of fixture.slice(17, 20)) s = apply(s, e).state;
  const r = apply(s, { ...fixture[20], reason: 'exit 0 (exited)', args_summary: 'pid=5210 exited' });
  assert.ok(r.effects.some((f) => f.kind === 'banner' && f.text === 'RUN ENDED'));
  assert.ok(!r.effects.some((f) => f.kind === 'powerDown'));
});

test('gateway strip: decisions, p50 and p95 over the allow and deny rows only', () => {
  const st = gatewayStats(fixture);
  assert.equal(st.decisions, 14);           // 21 rows minus 7 admin/harness rows
  assert.equal(st.blocked, 7);
  assert.equal(st.p50, 9);
  assert.equal(st.p95, 12);
  assert.equal(percentile([], 0.5), null);
  assert.deepEqual(gatewayStats([]), { decisions: 0, allowed: 0, blocked: 0, p50: null, p95: null });
  const demo = JSON.parse(readFileSync(new URL('../../replay/demo.json', import.meta.url))).events;
  const d = gatewayStats(demo);
  assert.equal(d.decisions, 11);   // the 4:18 PM recording: 15 rows, 11 of them allow or deny
  assert.equal(d.blocked, 4);
  assert.equal(d.p50, 86);         // nearest-rank over the 11 rows; the 271 ms is the first read after a reset
  assert.equal(d.p95, 271);
});

test('the recorded demo plays end to end and every event draws something', () => {
  const demo = JSON.parse(readFileSync(new URL('../../replay/demo.json', import.meta.url))).events;
  const { s, all } = run(demo);
  all.forEach((fx, i) => assert.ok(fx.length > 0, `demo event ${i + 1} drew nothing`));
  assert.equal(s.agents['research-bot'].revokeMs, 2829);
  assert.equal(s.agents['research-bot'].clientId, 's2ch2ppk');
  assert.equal(s.agents['research-bot'].stopNote, 'run stopped 358 ms after KILL');
  // build 3 changed this on purpose: a killed robot is carted to the inspection bay (it stayed in the pen before)
  assert.equal(s.agents['research-bot'].at, 'bay');
});
