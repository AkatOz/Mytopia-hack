// node --test island/tests
// The browser's chain check must agree with the gateway's own hashing (gateway/events.py record_hash).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { verifyChain, canonicalJson } from '../src/ledger.js';

const demo = JSON.parse(readFileSync(new URL('../../replay/demo.json', import.meta.url))).events;
const fixture = JSON.parse(readFileSync(new URL('../../contract/fixture.json', import.meta.url))).events;

test('the recorded gateway chain verifies in the browser code', async () => {
  const r = await verifyChain(demo);
  assert.equal(r.verified, true);
  assert.equal(r.ok, true, `broken at ${r.brokenAt}`);
  assert.equal(r.brokenAt, null);
  assert.equal(Object.values(r.links).every((x) => x === 'ok'), true);
});

test('a changed row breaks the chain at that row', async () => {
  const tampered = demo.map((e) => ({ ...e }));
  tampered[5].decision = 'allow'; // seq 6: send_email "allowed" after the fact
  const r = await verifyChain(tampered);
  assert.equal(r.verified, true);
  assert.equal(r.ok, false);
  assert.equal(r.brokenAt, 6);
});

test('a removed row breaks the link after it', async () => {
  const r = await verifyChain(demo.filter((e) => e.seq !== 4));
  assert.equal(r.ok, false);
  assert.equal(r.brokenAt, 5);
});

test('the fixture placeholders are reported as not verified', async () => {
  const r = await verifyChain(fixture);
  assert.equal(r.verified, false);
  assert.equal(r.ok, false);
});

test('canonical JSON: keys sorted, no spaces, no hash, non-ASCII escaped like Python', () => {
  assert.equal(canonicalJson({ b: 1, a: 'x', hash: 'h', c: null }), '{"a":"x","b":1,"c":null}');
  assert.equal(canonicalJson({ a: 'café' }), '{"a":"caf\\u00e9"}');
});
