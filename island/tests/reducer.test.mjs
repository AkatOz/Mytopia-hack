// node --test island/tests
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { apply, initialState, badge, fresh, rung } from '../src/reducer.js';

const fixture = JSON.parse(readFileSync(new URL('../../contract/fixture.json', import.meta.url))).events;
const run = (events, s = initialState()) => { const all = []; for (const e of events) { const r = apply(s, e); s = r.state; all.push(r.effects); } return { s, all }; };

test('every one of the 21 fixture events draws something', () => {
  const { all } = run(fixture);
  assert.equal(all.length, 21);
  all.forEach((fx, i) => assert.ok(fx.length > 0, `event seq ${i + 1} drew nothing`));
});

test('the demo story ends in the right state', () => {
  const { s } = run(fixture);
  const rb = s.agents['research-bot'], ob = s.agents['ops-bot'];
  assert.equal(s.cursor, 21);
  assert.equal(s.blockedTotal, 7);
  assert.equal(rb.plate, 'active');            // restored at seq 17
  assert.equal(rb.revokeMs, null);             // cleared on restore
  assert.equal(ob.plate, 'stopped');           // exit 0
  assert.equal(s.buildings.files.fire, true);  // last denied tool call before the kill: read_file (seq 13)
  assert.equal(s.buildings.github.fire, false);// ops-bot ended on its own: no fire
  assert.equal(s.buildings.mail.denials, 1);
  assert.equal(s.buildings.gatehouse.denials, 2); // two tools/list denials, never moves the fire
  assert.equal(s.buildings.gatehouse.fire, false);
});

test('revoke shows the measured ms and the plate turns red', () => {
  const { s } = run(fixture.slice(0, 10));
  assert.equal(s.agents['research-bot'].plate, 'revoked');
  assert.equal(s.agents['research-bot'].revokeMs, 1840);
});

test('kill then run_stopped: RUN KILLED and the ms after KILL', () => {
  let s = initialState(), last;
  for (const e of fixture.slice(0, 16)) { last = apply(s, e); s = last.state; }
  assert.ok(last.effects.some((f) => f.kind === 'banner' && f.text === 'RUN KILLED'));
  assert.equal(s.agents['research-bot'].stopNote, 'run stopped 1160 ms after KILL');
});

test('a run that ends by itself is not shown as killed', () => {
  const { all } = run(fixture);
  assert.ok(all[20].some((f) => f.kind === 'banner' && f.text === 'RUN ENDED'));
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
  apply(s0, fixture[0]);
  assert.equal(JSON.stringify(s0), snap);
});

test('badge: LIVE, STALE, REPLAY', () => {
  assert.equal(badge({ source: 'replay', now: 0, lastGoodPoll: 0 }), 'REPLAY');
  assert.equal(badge({ source: 'live', now: 5000, lastGoodPoll: 3000 }), 'LIVE');
  assert.equal(badge({ source: 'live', now: 6001, lastGoodPoll: 3000 }), 'STALE');
  assert.equal(badge({ source: 'live', now: 10, lastGoodPoll: null }), 'STALE');
});

test('ladder rungs', () => { assert.deepEqual([0, 1, 2, 3, 9].map(rung), [0, 1, 1, 2, 2]); });

test('buttons only acknowledge on the matching event', () => {
  const { all } = run(fixture);
  assert.ok(all[8].some((f) => f.kind === 'ack' && f.action === 'revoke'));
  assert.ok(all[13].some((f) => f.kind === 'ack' && f.action === 'kill'));
  assert.ok(all[16].some((f) => f.kind === 'ack' && f.action === 'restore'));
});

test('run_stopped marked "killed by harness" counts as a kill even without the kill_requested row', () => {
  let s = initialState();
  for (const e of fixture.slice(0, 13)) s = apply(s, e).state; // up to the tampered-token deny, no kill_requested
  const r = apply(s, { ...fixture[15], seq: 14 });            // run_stopped: exit 1 (killed by harness)
  assert.ok(r.effects.some((f) => f.kind === 'banner' && f.text === 'RUN KILLED'));
  assert.equal(r.state.buildings.files.fire, true);
  assert.equal(r.state.agents['research-bot'].stopNote, 'run stopped');
});

test('a gateway "exit 0 (exited)" run_stopped is RUN ENDED with no fire', () => {
  let s = initialState();
  for (const e of fixture.slice(17, 20)) s = apply(s, e).state;
  const r = apply(s, { ...fixture[20], reason: 'exit 0 (exited)', args_summary: 'pid=5210 exited' });
  assert.ok(r.effects.some((f) => f.kind === 'banner' && f.text === 'RUN ENDED'));
  assert.equal(r.state.buildings.github.fire, false);
});
