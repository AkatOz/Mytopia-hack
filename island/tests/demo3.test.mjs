// node --test island/tests
// The build 3 recording (replay/demo3.json: the Factory run on real AWS, Sat 2026-11-07 7:55 PM PT) through the
// reducer: every row draws something, the minted agent appears and is retired, the rogue agent's quarantine goes to
// the bay with an inquest, and the island's inquest agrees with what the gateway's GET /agents/{id}/inquest said
// for the same chain (docs/LIVE_RUN.md, seventh run).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { apply, initialState, inquestOf } from '../src/reducer.js';

const rec = JSON.parse(readFileSync(new URL('../../replay/demo3.json', import.meta.url)));
const events = rec.events;
const run = (evs, s = initialState()) => { const all = []; for (const e of evs) { const r = apply(s, e); s = r.state; all.push(r.effects); } return { s, all }; };

test('the recording is the Factory story: created first, retired last, 55 rows on one chain', () => {
  assert.equal(events[0].decision, 'created');
  assert.equal(events[0].agent, 'billing-bot');
  assert.equal(events[events.length - 1].decision, 'retired');
  assert.ok(events.length >= 50);
  assert.match(rec.chain, /^chain-/);
});

test('every row draws something', () => {
  run(events).all.forEach((fx, i) => assert.ok(fx.length > 0, `row ${events[i].seq} drew nothing`));
});

test('the minted agent is a known Gold robot that walks out to the yard, and is gone after retire', () => {
  const upToMint = run(events.slice(0, 1));
  const a = upToMint.s.agents['billing-bot'];
  assert.equal(a.known, true);
  assert.equal(a.tier, 'gold');
  assert.equal(a.at, 'yard');
  assert.deepEqual(a.allowedTools, ['read_file', 'search_files', 'create_issue', 'list_issues', 'send_email']);
  const steps = upToMint.all[0].find((f) => f.kind === 'script').steps;
  assert.ok(steps.some((st) => st.build));
  const end = run(events).s;
  assert.equal(end.agents['billing-bot'].known, false);
  // removeRobot rides at the end of the recycle script (it fires when the robot has rolled into the hall)
  const last = run(events).all[events.length - 1];
  const inScript = last.filter((f) => f.kind === 'script').some((f) => f.steps.some((st) => st.fx && st.fx.kind === 'removeRobot'));
  assert.ok(inScript || last.some((f) => f.kind === 'removeRobot'));
});

test('promote opens delete_file, demote trims the badge to the Silver ceiling', () => {
  const promoted = events.findIndex((e) => e.decision === 'tier_changed' && /Diamond/.test(e.reason));
  const demoted = events.findIndex((e) => e.decision === 'tier_changed' && /Silver/.test(e.reason));
  assert.ok(promoted > 0 && demoted > promoted);
  assert.equal(run(events.slice(0, promoted + 1)).s.agents['billing-bot'].tier, 'diamond');
  const after = run(events.slice(0, demoted + 1)).s.agents['billing-bot'];
  assert.equal(after.tier, 'silver');
  assert.deepEqual(after.allowedTools, ['read_file', 'search_files', 'create_issue', 'list_issues']);
});

test('the rogue agent is quarantined into the bay with an inquest that matches the gateway', () => {
  const q = events.findIndex((e) => e.agent === 'research-bot' && e.decision === 'revoked');
  assert.ok(q > 0);
  const { s, all } = run(events.slice(0, q + 1));
  assert.equal(s.agents['research-bot'].at, 'bay');
  const steps = all[q].find((f) => f.kind === 'script').steps;
  assert.ok(steps.some((st) => st.escort && st.escort.by === 'chief' && st.escort.to === 'bay_lift'));
  assert.ok(steps.some((st) => st.fx && st.fx.kind === 'inquest'));
  // the gateway's GET /agents/research-bot/inquest for this chain (docs/LIVE_RUN.md, seventh run)
  const stopped = events.findIndex((e) => e.agent === 'research-bot' && e.decision === 'run_stopped');
  const report = inquestOf(run(events.slice(0, stopped + 1)).s, 'research-bot', true);
  assert.equal(report.outcome, 'killed');
  assert.equal(report.calls.allowed, 3);
  assert.equal(report.calls.refused, 4);
  const mail = report.refused_by_tool.find((r) => r.tool === 'send_email');
  assert.equal(mail.n, 3);
  assert.equal(mail.rule, 'allow-list');
  assert.match(report.verdict, /Attempted send_email 3 times; its Silver badge does not hold it/);
});

test('a killed robot gets the cart and never a summon', () => {
  const stopped = events.findIndex((e) => e.agent === 'billing-bot' && e.decision === 'run_stopped');
  const fx = run(events.slice(0, stopped + 1)).all[stopped];
  const steps = fx.find((f) => f.kind === 'script').steps;
  assert.ok(steps.some((st) => st.cart && st.cart.to === 'bay_lift'));
  assert.ok(!steps.some((st) => st.summon));
  assert.ok(fx.some((f) => f.kind === 'powerDown'));
});
