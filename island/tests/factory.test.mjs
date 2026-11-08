// node --test island/tests/*.test.mjs
// Build 3 (docs/BUILD3.md section 6 "Tests"): the Factory's events (created, tier_changed, retired), quarantine and kill
// into the inspection bay, the inquest, and the chips' five states. tests/factory.json is a hand-written recording in
// the gateway's shapes (contract/README.md); it also plays in the browser: ?replay=tests/factory.json
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { apply, initialState, withRoster, inquestOf, tickerLine, specOf, DEFAULT_ROSTER } from '../src/reducer.js';
import { chipState, tierHint, inquestLines, rowSummary, slugify, lastAction, normTiers } from '../src/hud.js';
import { TIERS } from '../src/tiers.js';

const rec = JSON.parse(readFileSync(new URL('./factory.json', import.meta.url))).events;
const additions = JSON.parse(readFileSync(new URL('./additions.json', import.meta.url))).events;
const fixture = JSON.parse(readFileSync(new URL('../../contract/fixture.json', import.meta.url))).events;
const demo = JSON.parse(readFileSync(new URL('../../replay/demo.json', import.meta.url))).events;
const run = (events, s = initialState()) => { const all = []; for (const e of events) { const r = apply(s, e); s = r.state; all.push(r.effects); } return { s, all }; };
const upTo = (seq) => run(rec.filter((e) => e.seq <= seq));
const scriptOf = (effects) => effects.find((f) => f.kind === 'script');
const stepsOf = (effects) => scriptOf(effects)?.steps || [];
const fxIn = (effects) => [...effects, ...stepsOf(effects).filter((st) => st.fx).map((st) => st.fx)];
const BB = 'billing-bot';

test('every event of the factory recording draws something', () => {
  run(rec).all.forEach((fx, i) => assert.ok(fx.length > 0, `event seq ${i + 1} drew nothing`));
});

test('created: the robot appears at the Factory door and walks to the yard, smoke, BUILT banner, the spec', () => {
  const { s, all } = upTo(1);
  const a = s.agents[BB], fx = all[0];
  assert.equal(a.known, true);
  assert.equal(a.at, 'yard');
  assert.equal(a.name, 'Billing Bot');
  assert.equal(a.tier, 'gold');
  assert.equal(a.madeBy, 'factory');
  assert.equal(a.clientId, '3f9a1c7e');
  assert.deepEqual(a.ceiling, TIERS.gold.ceiling);
  assert.deepEqual(a.allowedTools, ['read_file', 'search_files', 'create_issue', 'list_issues', 'send_email']);
  assert.equal(a.color, 'teal');      // the row was cut before its colour: the first colour no robot wears is teal
  assert.deepEqual(stepsOf(fx), [{ build: true }, { walk: 'yard' }]);
  assert.ok(fx.some((f) => f.kind === 'factorySmoke'));
  assert.ok(fx.some((f) => f.kind === 'banner' && f.text === 'BUILT Billing Bot'));
  assert.ok(fx.some((f) => f.kind === 'setTier' && f.agent === BB && f.tier === 'gold'));
  const built = fx.find((f) => f.kind === 'built');
  assert.deepEqual(built.spec, { id: BB, name: 'Billing Bot', color: 'teal', tier: 'gold', tools: a.allowedTools });
  assert.match(tickerLine(rec[0]), /^BUILT billing-bot: minted by the Factory/);
});

test('the spec parser reads an uncut row, a colour cut to a prefix, and a cut tool name', () => {
  const ev = (args, reason = 'minted by the Factory') => ({ agent: 'x-bot', args_summary: args, reason });
  assert.deepEqual(specOf(ev('tier=silver tools=read_file,create_issue color=plum')), { id: 'x-bot', name: 'X Bot', color: 'plum', tier: 'silver', tools: ['read_file', 'create_issue'] });
  const cut = 'tier=gold tools=read_file,search_files,create_issue,list_issues,send_email color=br';
  assert.equal(specOf(ev(cut)).color, 'brick');
  const diamond = 'tier=diamond tools=read_file,search_files,create_issue,list_issues,send_email,de'; // 80 characters
  assert.equal(diamond.length, 80);
  assert.deepEqual(specOf(ev(diamond, 'minted by the Factory: Diamond badge, 6 tools, client 1')).tools, TIERS.diamond.ceiling);
});

test('run_started from the yard walks over the bridge to the gatehouse window: no hatch spawn', () => {
  const { s, all } = upTo(2);
  const steps = stepsOf(all[1]);
  assert.equal(steps.findIndex((st) => st.spawn), -1);
  assert.ok(steps.findIndex((st) => st.walk === 'gh_window') >= 0);
  assert.ok(steps.some((st) => st.showId));
  assert.equal(s.agents[BB].at, 'plaza');
  assert.equal(s.agents[BB].plate, 'active');
});

test('quarantine: the chief escorts the robot to the bay lift, then the inquest; no pen', () => {
  const { s, all } = upTo(7);
  const a = s.agents[BB], fx = all[6];
  assert.equal(a.at, 'bay');
  assert.equal(a.plate, 'revoked');
  assert.equal(a.quarantined, true);
  const steps = stepsOf(fx);
  assert.deepEqual(steps[0], { escort: { by: 'chief', to: 'bay_lift' } });
  assert.ok(!steps.some((st) => st.pen));
  assert.deepEqual(steps[steps.length - 1], { fx: { kind: 'inquest', agent: BB } });
  assert.ok(fx.some((f) => f.kind === 'banner' && f.text === 'QUARANTINED'));
  assert.equal(s.gates.admin.refused, 3);
});

test('a status refusal in the bay is stamped over the bay', () => {
  const { all } = upTo(8);
  const steps = stepsOf(all[7]);
  assert.ok(steps.some((st) => st.fx && st.fx.kind === 'stampAt' && st.fx.anchor === 'bay'));
  assert.ok(!steps.some((st) => st.walk));
});

test('inquestOf at the quarantine: calls, refused_by_tool, trigger, verdict, recommendation', () => {
  const q = inquestOf(upTo(7).s, BB, null);
  assert.deepEqual(Object.keys(q), ['agent', 'name', 'tier', 'run_id', 'client', 'outcome', 'calls', 'refused_by_tool', 'first_refusal', 'trigger', 'timings', 'chain', 'verdict', 'recommendation']);
  assert.equal(q.run_id, 'run-b001');
  assert.equal(q.client, '3f9a1c7e');
  assert.equal(q.outcome, 'quarantined');
  assert.deepEqual(q.calls, { allowed: 1, refused: 3 });
  assert.deepEqual(q.refused_by_tool, [{ tool: 'delete_file', n: 3, rule: 'allow-list', home: 'admin' }]);
  assert.deepEqual(q.first_refusal, { tool: 'delete_file', ts: '2026-11-08T01:00:26.200Z', reason: 'delete_file is not on badge billing-bot' });
  assert.deepEqual(q.trigger, { kind: 'quarantine', ts: '2026-11-08T01:00:32.215Z', by: 'gateway', detail: '3 refused calls in 6 s' });
  assert.deepEqual(q.timings, { revoke_to_first_deny_ms: null, kill_to_stopped_ms: null, decision_p50_ms: 9 });
  assert.deepEqual(q.chain, { rows: 7, verified: null });
  assert.equal(q.verdict, 'Attempted delete_file 3 times; its Gold badge does not hold it; the gateway refused every attempt, and pulled the badge itself.');
  assert.equal(q.recommendation, 'Keep the badge at Gold. Restore only after the task is fixed; do not grant delete_file.');
  const lines = inquestLines(q);
  assert.ok(lines.some((l) => l.ok === false && l.text.startsWith('refused delete_file ×3')));
  assert.equal(inquestOf(upTo(7).s, 'nobody'), null);
});

test('restore from the bay walks back to the plaza; demotion trims the badge, the chips and the ceiling', () => {
  const r9 = upTo(9);
  assert.deepEqual(stepsOf(r9.all[8]), [{ walk: 'plaza' }]);
  assert.equal(r9.s.agents[BB].at, 'plaza');
  const { s, all } = upTo(11);
  const a = s.agents[BB], fx = all[10];
  assert.equal(a.tier, 'silver');
  assert.deepEqual(a.ceiling, TIERS.silver.ceiling);
  assert.deepEqual(a.allowedTools, ['read_file', 'search_files', 'create_issue', 'list_issues']);
  assert.ok(fx.some((f) => f.kind === 'banner' && f.text === 'DEMOTED TO SILVER'));
  assert.ok(fx.some((f) => f.kind === 'setTier' && f.tier === 'silver'));
  assert.ok(fx.some((f) => f.kind === 'ack' && f.action === 'tier'));
  assert.equal(chipState(a, 'send_email').state, 'locked');
  assert.equal(chipState(a, 'send_email').hint, 'Gold+');
  assert.match(tickerLine(rec[10]), /^DEMOTED billing-bot: Billing Bot demoted to Silver/);
  // a promotion back up keeps the badge as it is and only opens the padlock
  const up = apply(s, { ...rec[10], seq: 12, args_summary: 'tier=gold was=silver badge=read_file,search_files,create_issue,list_issues', reason: 'promoted to Gold by operator' });
  assert.ok(up.effects.some((f) => f.kind === 'banner' && f.text === 'PROMOTED TO GOLD'));
  assert.equal(chipState(up.state.agents[BB], 'send_email').state, 'grant');
});

test('kill: power down, the cart takes the robot to the bay, the inquest; no summon of the chief', () => {
  const { s, all } = upTo(13);
  const a = s.agents[BB], fx = all[12];
  assert.equal(a.at, 'bay');
  assert.ok(fx.some((f) => f.kind === 'powerDown' && f.agent === BB));
  assert.ok(fx.some((f) => f.kind === 'banner' && f.text === 'RUN KILLED'));
  const steps = stepsOf(fx);
  assert.ok(steps.some((st) => st.cart && st.cart.to === 'bay_lift'));
  assert.ok(steps.some((st) => st.fx && st.fx.kind === 'inquest' && st.fx.agent === BB));
  assert.ok(!steps.some((st) => st.summon), 'no guard stands behind a killed robot');
  assert.equal(a.stopNote, 'run stopped 358 ms after KILL');
  const q = inquestOf(s, BB, true);
  assert.equal(q.outcome, 'killed');
  assert.equal(q.tier, 'silver');
  assert.deepEqual(q.calls, { allowed: 2, refused: 4 });
  assert.deepEqual(q.refused_by_tool.map((g) => [g.tool, g.n, g.rule]), [['delete_file', 3, 'allow-list'], ['read_file', 1, 'status-revoked']]);
  assert.equal(q.trigger.kind, 'kill');
  assert.equal(q.timings.kill_to_stopped_ms, 358);
  assert.deepEqual(q.chain, { rows: 13, verified: true });
  // the badge was Gold when it was refused (the demotion came later)
  assert.equal(q.verdict, 'Attempted delete_file 3 times; its Gold badge does not hold it; the gateway refused every attempt, and pulled the badge itself.');
  assert.equal(q.recommendation, 'The identity stays; the next run starts clean.');
});

test('retire: the robot is recycled into the Factory, removeRobot, the roster forgets it', () => {
  const { s, all } = run(rec);
  const a = s.agents[BB], fx = all[13];
  assert.equal(a.known, false);
  assert.equal(a.at, 'factory');
  const steps = stepsOf(fx);
  assert.ok(steps.some((st) => st.recycle));
  assert.ok(fxIn(fx).some((f) => f.kind === 'removeRobot' && f.agent === BB));
  assert.ok(fx.some((f) => f.kind === 'banner' && f.text === 'RETIRED'));
  assert.ok(fx.some((f) => f.kind === 'ack' && f.action === 'retire:' + BB));
  assert.notEqual(s.selected, BB);
  assert.match(tickerLine(rec[13]), /^RETIRED billing-bot: retired by operator/);
});

test('chipState: on, grant, locked with the hint tier, pulled, held', () => {
  const s = initialState();
  const rb = s.agents['research-bot']; // silver: read_file, search_files, create_issue, list_issues
  const ob = s.agents['ops-bot'];      // bronze: read_file
  assert.deepEqual(chipState(rb, 'read_file'), { state: 'on', act: 'revoke', sent: false, hint: '' });
  assert.deepEqual(chipState(ob, 'search_files'), { state: 'grant', act: 'restore', sent: false, hint: '' });
  assert.deepEqual(chipState(ob, 'create_issue'), { state: 'locked', act: '', sent: false, hint: 'Silver+' });
  assert.deepEqual(chipState(rb, 'delete_file'), { state: 'locked', act: '', sent: false, hint: 'Diamond only' });
  assert.equal(chipState(rb, 'send_email').hint, 'Gold+');
  const pulled = run(additions.slice(0, 4)).s.agents['research-bot'];
  assert.deepEqual(chipState(pulled, 'create_issue'), { state: 'pulled', act: 'restore', sent: false, hint: '' });
  const held = run(additions).s.agents['research-bot'];
  assert.deepEqual(chipState(held, 'read_file'), { state: 'held', act: '', sent: false, hint: '' });
  assert.equal(tierHint('read_file'), 'Bronze+');
});

test('tiers: the roster carries tier, role, made_by; a row without a tier gets inferTier; GET /tiers is normalised', () => {
  const s = initialState();
  assert.equal(s.agents['research-bot'].tier, 'silver');
  assert.equal(s.agents['ops-bot'].tier, 'bronze');
  const s2 = withRoster(s, [{ agent: 'old-bot', name: 'Old Bot', allowed_tools: ['read_file', 'send_email'], color: 'slate' }, { ...DEFAULT_ROSTER[1], tier: 'gold', role: 'checks the books', made_by: 'seed' }]);
  assert.equal(s2.agents['old-bot'].tier, 'gold');
  assert.equal(s2.agents['old-bot'].madeBy, 'seed');
  assert.equal(s2.agents['ops-bot'].tier, 'gold');
  assert.equal(s2.agents['ops-bot'].role, 'checks the books');
  const t = normTiers([{ tier: 'bronze', rank: 1, name: 'Bronze', line: 'looks', ceiling: ['read_file'] }]);
  assert.deepEqual(t.bronze.ceiling, ['read_file']);
  assert.equal(t.bronze.hex, TIERS.bronze.hex);
  assert.equal(normTiers(null), TIERS);
});

test('plain words: the slug, the last action, a ledger row summary', () => {
  assert.equal(slugify('Billing Bot'), 'billing-bot');
  assert.equal(slugify('  9 Lives!! Bot '), 'lives-bot');
  const { s } = upTo(4);
  assert.equal(lastAction(s.agents[BB]), 'tried to delete a file · refused · 9 ms');
  assert.equal(lastAction(upTo(3).s.agents[BB]), 'read a document · allowed · 171 ms');
  assert.equal(rowSummary(rec[3], s), 'Billing Bot asked to delete a file; the gateway refused it in 9 ms (not on the badge).');
  assert.equal(rowSummary(rec[6], s), "The gateway pulled Billing Bot's badge itself after repeated refusals (quarantine).");
});

test('the contract fixture, the recorded demo and the additions recording still play with the build 3 reducer', () => {
  for (const events of [fixture, demo, additions]) run(events).all.forEach((fx, i) => assert.ok(fx.length > 0, `event ${i + 1} drew nothing`));
  const s = run(demo).s;
  assert.equal(s.agents['research-bot'].at, 'bay'); // killed: carted to the inspection bay (it was in the pen before build 3)
});
