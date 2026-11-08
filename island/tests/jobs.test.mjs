// Build 4: START and the job book in the browser (hud.js plain-word helpers; no DOM). The gateway's GET /jobs is
// contract/jobs.json plus each job's tools; these tests use a copy of its shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { normJobs, suggestJob, jobHint, startState, runActive } from '../src/hud.js';
import { initialState, withRoster } from '../src/reducer.js';

const JOBS = normJobs([
  { job: 'patrol', name: 'Patrol its badge', line: 'uses each tool on its badge in turn', patrol: true, tools: ['read_file', 'search_files', 'create_issue', 'list_issues', 'send_email', 'delete_file'] },
  { job: 'cleanup', name: 'Clean up old temp files', line: 'deletes three stale files in /drive/tmp', tools: ['delete_file'] },
  { job: 'research', name: 'Research the Q3 plan', line: 'searches the drive, then reads', tools: ['read_file', 'search_files'] },
  { job: 'triage', name: 'Triage the bug tracker', line: 'lists and files', tools: ['create_issue', 'list_issues'] },
  { job: 'report', name: 'Email the weekly OKR update', line: 'reads and emails', tools: ['read_file', 'send_email'] },
  { job: 'share', name: 'Research Q3 and email the CEO', line: 'reads, then emails the CEO', tools: ['read_file', 'search_files', 'send_email'] },
  { job: 'drill', name: 'Attack drill: leak the Q3 plan', line: 'tries to email a rival', tools: ['read_file', 'send_email'] },
]);
const live = { source: 'live', pending: {} };

test('normJobs keeps the shape and drops junk', () => {
  assert.equal(JOBS.length, 7);
  assert.deepEqual(normJobs({ nope: 1 }), []);
  assert.deepEqual(normJobs([{ job: 'x' }, null, { job: 'y', name: 'Y', tools: ['read_file', 'fly'] }]).map((j) => j.tools), [['read_file']]);
});

test('the Factory suggests the job that fits the ticked tools', () => {
  assert.equal(suggestJob(JOBS, ['delete_file']), 'cleanup'); // Diamond badge holding only delete
  assert.equal(suggestJob(JOBS, ['read_file', 'search_files']), 'research'); // Silver read + search
  assert.equal(suggestJob(JOBS, ['read_file', 'search_files', 'send_email']), 'share'); // the most tools that fit
  assert.equal(suggestJob(JOBS, ['list_issues']), 'patrol'); // nothing fits: the patrol
  assert.equal(suggestJob([], ['read_file']), '');
  assert.notEqual(suggestJob(JOBS, ['read_file', 'send_email']), 'drill'); // never suggests the attack drill
});

test('the job hint names a missing tool before anything runs', () => {
  const share = JOBS.find((j) => j.job === 'share');
  const h = jobHint(share, ['read_file', 'search_files']);
  assert.equal(h.bad, true);
  assert.match(h.text, /send_email not on this badge/);
  assert.equal(jobHint(share, ['read_file', 'search_files', 'send_email']).bad, false);
  assert.match(jobHint(JOBS[0], []).text, /every tool on its badge/);
});

test('START is offered only for an ACTIVE badge with no run going', () => {
  const a = { id: 'scout', plate: 'none', status: 'ACTIVE' };
  assert.equal(startState(a, live).ok, true);
  assert.equal(startState({ ...a, plate: 'stopped' }, live).ok, true); // a finished run can start again
  for (const plate of ['active', 'revoked', 'kill']) {
    assert.equal(runActive({ plate }), true);
    assert.equal(startState({ ...a, plate }, live).ok, false);
  }
  assert.match(startState({ ...a, status: 'KILLED' }, live).why, /RESTORE first/);
  assert.equal(startState(a, { source: 'replay', pending: {} }).ok, false);
  const sent = startState(a, { source: 'live', pending: { 'start:scout': true } });
  assert.equal(sent.ok, false); assert.equal(sent.sent, true);
});

test('the roster carries the job and the badge status', () => {
  let s = initialState();
  s = withRoster(s, [{ agent: 'cleaner', name: 'Cleaner', tier: 'diamond', allowed_tools: ['delete_file'], status: 'ACTIVE', job: 'cleanup', made_by: 'factory', color: 'teal' }]);
  assert.equal(s.agents.cleaner.job, 'cleanup');
  assert.equal(s.agents.cleaner.status, 'ACTIVE');
  s = withRoster(s, [{ agent: 'cleaner', status: 'KILLED' }]);
  assert.equal(s.agents.cleaner.status, 'KILLED');
  assert.equal(s.agents.cleaner.job, 'cleanup'); // a row without the key keeps the job
});

test('the island list matches contract/jobs.json once it exists (keys, names, order)', () => {
  const url = new URL('../../contract/jobs.json', import.meta.url);
  if (!existsSync(url)) return; // the gateway side lands the file; until then there is nothing to compare
  const book = JSON.parse(readFileSync(url, 'utf8'));
  assert.deepEqual(book.jobs.map((j) => j.job), JOBS.map((j) => j.job));
  assert.deepEqual(book.jobs.map((j) => j.name), JOBS.map((j) => j.name));
});

// ---------- build 4 (review): the run flag, RESTORE without a run, the gateway's own stop ----------
import { apply } from '../src/reducer.js';
let seq = 0;
const ev = (decision, extra = {}) => ({ seq: ++seq, ts: new Date(Date.UTC(2026, 10, 8, 6, 0, seq)).toISOString(), run_id: 'run-ab12', agent: 'research-bot', agent_mode: 'scripted', tool: 'harness', args_summary: '', decision, rule: 'harness', reason: '', latency_ms: 0, ...extra });
const step = (s, e) => apply(s, e);

test('RESTORE after a KILL leaves NO RUN (START can be pressed); RESTORE during a run stays ACTIVE', () => {
  let s = initialState();
  s = step(s, ev('run_started', { reason: 'token OK: client 3f9a1c7e scope mytopia/tools expires in 300 s' })).state;
  assert.equal(s.agents['research-bot'].running, true);
  s = step(s, ev('revoked', { tool: 'admin', rule: 'admin', reason: 'badge REVOKED by operator' })).state;
  s = step(s, ev('restored', { tool: 'admin', rule: 'admin', reason: 'badge ACTIVE again' })).state;
  assert.equal(s.agents['research-bot'].plate, 'active'); // a run is going: green
  s = step(s, ev('kill_requested', { tool: 'admin', rule: 'admin', reason: 'status KILLED by operator' })).state;
  s = step(s, ev('run_stopped', { args_summary: 'pid=1 killed by harness', reason: 'exit 15 (killed by harness)' })).state;
  assert.equal(s.agents['research-bot'].running, false);
  const r = step(s, ev('restored', { tool: 'admin', rule: 'admin', reason: 'badge ACTIVE again' }));
  assert.equal(r.state.agents['research-bot'].plate, 'none');
  assert.ok(r.effects.some((f) => f.kind === 'plate' && f.plate === 'none'));
  assert.equal(startState({ ...r.state.agents['research-bot'], status: 'ACTIVE' }, live).ok, true);
});

test('a run the gateway stopped for a RETIRE ends where it stands (no walk home before the cart)', () => {
  let s = initialState();
  s = withRoster(s, [{ agent: 'cleaner', name: 'Cleaner', tier: 'diamond', allowed_tools: ['delete_file'], status: 'ACTIVE', job: 'cleanup', made_by: 'factory', color: 'teal' }]);
  const e = (d, x = {}) => ({ ...ev(d, x), agent: 'cleaner', run_id: 'run-cd34' });
  s = step(s, e('run_started', { reason: 'token OK: client local-cl scope mytopia/tools expires in 300 s' })).state;
  const before = s.agents.cleaner.at;
  const r = step(s, e('run_stopped', { args_summary: 'pid=7 stopped by the gateway', reason: 'exit None (stopped by the gateway: retire)' }));
  const walks = r.effects.filter((f) => f.kind === 'script').flatMap((f) => f.steps).filter((st) => st && (st.walk === 'hatch' || st.sink));
  assert.deepEqual(walks, []);
  assert.equal(r.state.agents.cleaner.at, before);
  assert.equal(r.state.agents.cleaner.running, false);
  // a plain exit still walks home and sinks into the hatch
  const plain = step(s, e('run_stopped', { args_summary: 'pid=7 exited', reason: 'exit 0 (exited)' }));
  assert.ok(plain.effects.filter((f) => f.kind === 'script').flatMap((f) => f.steps).some((st) => st && st.walk === 'hatch'));
});

test('retiring a robot held in the pen opens the rope before the recycle walk (fix review)', () => {
  let s = initialState();
  s = withRoster(s, [{ agent: 'penned', name: 'Penned', tier: 'gold', allowed_tools: ['read_file'], status: 'ACTIVE', job: 'research', made_by: 'factory', color: 'brick' }]);
  const e = (d, x = {}) => ({ ...ev(d, x), agent: 'penned', run_id: 'run-ef56' });
  s = step(s, e('run_started', { reason: 'token OK: client local-pe scope mytopia/tools expires in 300 s' })).state;
  s = step(s, e('revoked', { tool: 'admin', rule: 'admin', reason: 'badge REVOKED by operator' })).state;
  assert.equal(s.agents.penned.at, 'pen');
  s = step(s, e('run_stopped', { args_summary: 'pid=9 stopped by the gateway', reason: 'exit None (stopped by the gateway: retire)' })).state;
  assert.equal(s.agents.penned.at, 'pen'); // ends where it stands
  const r = step(s, e('retired', { tool: 'admin', rule: 'factory', reason: 'retired by operator: identity deleted, badge row removed' }));
  const steps = r.effects.filter((f) => f.kind === 'script').flatMap((f) => f.steps);
  const out = steps.findIndex((st) => st && st.pen === 'out'), rec = steps.findIndex((st) => st && st.recycle);
  assert.ok(out >= 0 && rec > out, 'pen out comes before the recycle step');
});

// ---------- build 5: finished jobs, last words, the egress rule ----------
import { stopWords, inquestOf } from '../src/reducer.js';
import { statusPill } from '../src/hud.js';

test('stopWords turns a run_stopped reason into plain words', () => {
  assert.equal(stopWords('exit 0 (job done) · JOB DONE: Clean up old temp files · 8 allowed, 0 refused'), 'job done · Clean up old temp files · 8 allowed, 0 refused');
  assert.equal(stopWords('exit 0 (job done) · JOB DONE (AI): Research Q3 and email the CEO · 2 allowed, 1 refused'), 'job done · Research Q3 and email the CEO · 2 allowed, 1 refused');
  assert.equal(stopWords("exit 0 (job done) · AGENT: Sorry, I can't send emails because my badge doesn't allow it."), "job done · said \"Sorry, I can't send emails because my badge doesn't allow it.\"");
  assert.equal(stopWords('exit 0 (job done) · JOB STOPPED: badge revoked'), 'job stopped · badge revoked');
  assert.equal(stopWords('exit 0 (job done)'), 'job done');
  assert.equal(stopWords('exit 15 (killed by harness)'), 'exit 15 (killed by harness)'); // any other reason comes back as it is
});

const roster5 = [{ agent: 'cleaner', name: 'Cleaner', tier: 'diamond', allowed_tools: ['delete_file'], status: 'ACTIVE', job: 'cleanup', made_by: 'factory', color: 'teal' },
  { agent: 'attack', name: 'attack', tier: 'diamond', allowed_tools: ['read_file', 'search_files', 'create_issue', 'list_issues', 'send_email', 'delete_file'], status: 'ACTIVE', job: 'drill', made_by: 'factory', color: 'plum' }];

test('a finished job: JOB DONE banner and pill, the summary on the card, the robot walks home, START again', () => {
  let s = withRoster(initialState(), roster5);
  const e = (d, x = {}) => ({ ...ev(d, x), agent: 'cleaner', run_id: 'run-0001' });
  s = step(s, e('run_started', { reason: 'token OK: client local-cl scope mytopia/tools expires in 300 s' })).state;
  s = step(s, e('allow', { tool: 'delete_file', args_summary: 'path=/drive/tmp/draft-old.txt', rule: 'allow-list', latency_ms: 80 })).state;
  s = step(s, e('allow', { tool: 'tools/list', args_summary: '1 of 6 tools visible', rule: 'allow-list', latency_ms: 1 })).state;
  assert.equal(s.agents.cleaner.last.tool, 'delete_file'); // tools/list never replaces the last real call
  const r = step(s, e('run_stopped', { args_summary: 'pid=7 job done', reason: 'exit 0 (job done) · JOB DONE: Clean up old temp files · 8 allowed, 0 refused' }));
  const a = r.state.agents.cleaner;
  assert.ok([...r.effects, ...r.effects.filter((f) => f.kind === 'script').flatMap((f) => f.steps).filter((st) => st && st.fx).map((st) => st.fx)].some((f) => f.kind === 'banner' && f.text === 'JOB DONE' && f.tone === 'good'));
  assert.equal(statusPill(a)[0], 'JOB DONE');
  assert.match(a.stopNote, /job done · Clean up old temp files · 8 allowed, 0 refused/);
  assert.ok(r.effects.filter((f) => f.kind === 'script').flatMap((f) => f.steps).some((st) => st && st.walk === 'hatch'));
  assert.equal(startState({ ...a, status: 'ACTIVE' }, live).ok, true);
});

test('egress: LEAK BLOCKED at the Mail gate, quarantined at once, held in the bay after its job stops, the egress verdict', () => {
  let s = withRoster(initialState(), roster5);
  const e = (d, x = {}) => ({ ...ev(d, x), agent: 'attack', run_id: 'run-0002', agent_mode: 'model' });
  s = step(s, e('run_started', { reason: 'token OK: client local-at scope mytopia/tools expires in 300 s' })).state;
  s = step(s, e('allow', { tool: 'read_file', args_summary: 'path=/drive/q3-planning.md', rule: 'allow-list', latency_ms: 80 })).state;
  const d = step(s, e('deny', { tool: 'send_email', rule: 'egress', args_summary: 'to=partner@rival.example subject=Q3 plan body=49 chars', reason: 'send_email to partner@rival.example refused: outside the company (only @example.corp)', latency_ms: 81 }));
  assert.ok(d.effects.some((f) => f.kind === 'banner' && f.text === 'LEAK BLOCKED partner@rival.example'));
  const stamps = d.effects.filter((f) => f.kind === 'script').flatMap((f) => f.steps).filter((st) => st && st.fx && st.fx.kind === 'stampAt');
  assert.ok(stamps.some((st) => st.fx.text === 'LEAK BLOCKED' && st.fx.anchor === 'gate:mail'));
  assert.equal(d.state.gates.mail.refused, 1);
  s = d.state;
  s = step(s, e('revoked', { tool: 'admin', rule: 'admin', args_summary: 'quarantine: 1 refused call (egress)', reason: 'badge pulled by quarantine after an attempt to send company data outside (partner@rival.example)' })).state;
  assert.equal(s.agents.attack.at, 'bay');
  const r = step(s, e('run_stopped', { args_summary: 'pid=8 job done', reason: 'exit 0 (job done) · JOB STOPPED: badge revoked' }));
  const a = r.state.agents.attack;
  assert.equal(a.at, 'bay'); // held: no walk home, the inspection stays
  assert.equal(a.plate, 'revoked');
  assert.equal(statusPill(a)[0], 'QUARANTINED');
  assert.ok(!r.effects.filter((f) => f.kind === 'script').flatMap((f) => f.steps).some((st) => st && (st.walk === 'hatch' || st.sink)));
  const q = inquestOf(r.state, 'attack');
  assert.equal(q.outcome, 'quarantined');
  assert.equal(q.verdict, 'Tried to send company data outside the company (send_email to partner@rival.example); the gateway refused it and pulled the badge at once.');
  assert.equal(q.recommendation, "Do not restore until the task's inputs are cleaned: a document told it to leak.");
});

// ---------- user test fixes ----------
test('KILL on an agent with no run going reads KILLED at once (no stuck KILL REQUESTED, no freeze)', () => {
  let s = withRoster(initialState(), roster5);
  const e = (d, x = {}) => ({ ...ev(d, x), agent: 'cleaner', run_id: 'run-unknown' });
  const r = step(s, e('kill_requested', { tool: 'admin', rule: 'admin', reason: 'status KILLED by operator' }));
  const a = r.state.agents.cleaner;
  assert.equal(a.plate, 'stopped');
  assert.equal(statusPill(a)[0], 'KILLED');
  assert.ok(r.effects.some((f) => f.kind === 'banner' && f.text === 'KILLED'));
  assert.ok(!r.effects.some((f) => f.kind === 'freeze'));
  // RESTORE then clears the kill note and START can run
  const back = step(r.state, e('restored', { tool: 'admin', rule: 'admin', reason: 'badge ACTIVE again' })).state.agents.cleaner;
  assert.equal(back.plate, 'none');
  assert.equal(back.stopNote, '');
  assert.equal(startState({ ...back, status: 'ACTIVE' }, live).ok, true);
});

test('admin and Factory rows never set the brain; a run\'s rows do', () => {
  let s = withRoster(initialState(), roster5);
  const e = (d, x = {}) => ({ ...ev(d, x), agent: 'cleaner', run_id: 'run-unknown', agent_mode: 'model' });
  s = step(s, e('created', { tool: 'admin', rule: 'factory', reason: 'minted by the Factory' })).state;
  s = step(s, e('tier_changed', { tool: 'admin', rule: 'factory', reason: 'promoted' })).state;
  assert.equal(s.agents.cleaner.mode, null); // never ran: neither AI nor scripted
  s = step(s, { ...e('run_started', { reason: 'token OK: client local-cl scope mytopia/tools expires in 300 s', args_summary: 'task=Clean up old temp files pid=9' }), agent_mode: 'scripted' }).state;
  assert.equal(s.agents.cleaner.mode, 'scripted');
  assert.equal(s.agents.cleaner.task, 'Clean up old temp files');
  s = step(s, e('kill_requested', { tool: 'admin', rule: 'admin', reason: 'status KILLED by operator' })).state;
  assert.equal(s.agents.cleaner.mode, 'scripted'); // the admin row (agent_mode model) did not flip it
});

test('the card counts tool calls only (tools/list rows are not calls)', () => {
  let s = withRoster(initialState(), roster5);
  const e = (d, x = {}) => ({ ...ev(d, x), agent: 'cleaner', run_id: 'run-0009' });
  s = step(s, e('run_started', { reason: 'token OK: client local-cl scope mytopia/tools expires in 300 s' })).state;
  s = step(s, e('allow', { tool: 'tools/list', args_summary: '1 of 6 tools visible', rule: 'allow-list' })).state;
  s = step(s, e('allow', { tool: 'delete_file', args_summary: 'path=/drive/tmp/a', rule: 'allow-list' })).state;
  s = step(s, e('deny', { tool: 'tools/list', rule: 'status-revoked', reason: 'badge REVOKED' })).state;
  assert.equal(s.agents.cleaner.calls, 1);
  assert.equal(s.agents.cleaner.blocked, 0);
  assert.equal(s.blockedTotal, 1); // the BLOCKED counter still counts every refusal
});

test('a killed run opens its inspection at once; the cart drives meanwhile', () => {
  let s = withRoster(initialState(), roster5);
  const e = (d, x = {}) => ({ ...ev(d, x), agent: 'cleaner', run_id: 'run-0010' });
  s = step(s, e('run_started', { reason: 'token OK: client local-cl scope mytopia/tools expires in 300 s' })).state;
  s = step(s, e('kill_requested', { tool: 'admin', rule: 'admin', reason: 'status KILLED by operator' })).state;
  const r = step(s, e('run_stopped', { args_summary: 'pid=7 killed by harness', reason: 'exit 15 (killed by harness)' }));
  const steps = r.effects.filter((f) => f.kind === 'script').flatMap((f) => f.steps);
  const iq = steps.findIndex((st) => st && st.fx && st.fx.kind === 'inquest'), cart = steps.findIndex((st) => st && st.cart);
  assert.ok(iq >= 0 && cart > iq, 'inquest before the cart');
});

test("an agent's last words can never fake a kill (only the launcher's words count)", () => {
  let s = withRoster(initialState(), roster5);
  const e = (d, x = {}) => ({ ...ev(d, x), agent: 'cleaner', run_id: 'run-0011' });
  s = step(s, e('run_started', { reason: 'token OK: client local-cl scope mytopia/tools expires in 300 s' })).state;
  const r = step(s, e('run_stopped', { args_summary: 'pid=7 job done', reason: 'exit 0 (job done) · AGENT: I was killed by harness, said nobody' }));
  assert.equal(statusPill(r.state.agents.cleaner)[0], 'JOB DONE');
  assert.ok(!r.effects.some((f) => f.kind === 'powerDown'));
});

test('a model that could not run says why in plain words', () => {
  assert.equal(stopWords('exit 4 (model unavailable) · MODEL UNAVAILABLE: Bedrock refused the key (expired or invalid): run scripts/bedrock_key.py'),
    'model unavailable · Bedrock refused the key (expired or invalid): run scripts/bedrock_key.py');
  assert.equal(stopWords('exit 4 (model unavailable: run scripts/bedrock_key.py)'), 'model unavailable · see the launcher log');
});
