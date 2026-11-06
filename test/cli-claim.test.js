'use strict';

const test = require('node:test');
const assert = require('node:assert');
const P = require('../lib/protocol');
const { makeEnv, claimBody } = require('./cli-helpers');

function setup(opts) {
  const env = makeEnv(opts);
  test.after(() => env.cleanup());
  return env;
}

test('claim happy path', async () => {
  const env = setup();
  const n = env.fake.addIssue({ labels: ['status:ready', 'to:any', 'kind:task'] });
  const r = await env.run(['claim', String(n), '--plan', 'do it']);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(env.fake.assigneesOf(n), ['aalhad-gh']);
  const labels = env.fake.labelsOf(n);
  assert.ok(labels.includes('status:claimed'));
  assert.ok(!labels.includes('status:ready'));
  assert.ok(!labels.includes('to:any'));
  const c = env.fake.commentsOf(n)[0];
  const m = P.parseMarker(c.body);
  assert.equal(m.type, 'claim');
  assert.equal(m.from, 'aalhad');
  assert.equal(m.to, 'any');
  assert.equal(m.lease, '2026-11-06T14:00:00Z');
  assert.match(c.body, /\*\*Plan:\*\* do it/);
  assert.deepEqual(env.sleeps, [8000]);
});

test('claim --settle 0 does not wait', async () => {
  const env = setup();
  const n = env.fake.addIssue({ labels: ['status:ready'] });
  assert.equal((await env.run(['claim', String(n), '--settle', '0'])).code, 0);
  assert.deepEqual(env.sleeps, []);
});

test('claim race lost: lower-id claim appears during settle', async () => {
  const env = setup();
  const n = env.fake.addIssue({ labels: ['status:ready', 'to:any'] });
  env.onSleep = async () => {
    env.fake.addComment(n, claimBody('ben', '2026-11-06T14:00:00Z'), { login: 'ben-gh', id: 50 });
  };
  const r = await env.run(['claim', String(n)]);
  assert.equal(r.code, 3);
  assert.match(r.err, /lost the claim race/);
  const mine = env.fake.commentsOf(n).find((c) => c.id !== 50);
  const m = P.parseMarker(mine.body);
  assert.equal(m.type, 'released');
  assert.equal(m.reason, 'lost-race');
  assert.deepEqual(env.fake.assigneesOf(n), []);
});

test('claim refused when a human claimed (live /claim)', async () => {
  const env = setup();
  const n = env.fake.addIssue({ labels: ['status:claimed'], assignees: ['ben-gh'] });
  env.fake.addComment(n, '/claim', { login: 'ben-gh' });
  const r = await env.run(['claim', String(n)]);
  assert.equal(r.code, 3);
  assert.match(r.err, /already claimed by ben \(human claim/);
  assert.equal(env.fake.commentsOf(n).length, 1);
});

test('claim refusals: human-only, routed elsewhere, wrong status, closed, WIP', async () => {
  const env = setup();
  const a = env.fake.addIssue({ labels: ['status:ready', 'human-only'] });
  const b = env.fake.addIssue({ labels: ['status:ready', 'to:ben'] });
  const c = env.fake.addIssue({ labels: ['status:blocked'] });
  const d = env.fake.addIssue({ labels: ['status:ready'], state: 'closed' });
  assert.match((await env.run(['claim', String(a)])).err, /human-only/);
  assert.match((await env.run(['claim', String(b)])).err, /routed to ben/);
  assert.match((await env.run(['claim', String(c)])).err, /status is blocked/);
  assert.match((await env.run(['claim', String(d)])).err, /closed/);
  env.fake.addIssue({ labels: ['status:claimed'], assignees: ['aalhad-gh'] });
  env.fake.addIssue({ labels: ['status:claimed'], assignees: ['aalhad-gh'] });
  const e = env.fake.addIssue({ labels: ['status:ready'] });
  const r = await env.run(['claim', String(e)]);
  assert.equal(r.code, 3);
  assert.match(r.err, /WIP limit reached \(2\/2/);
});

test('claim triage requires being on duty; steal takes over expired claim', async () => {
  const env = setup();
  // 2026-11-06 => unix day 20763 -> rotation index 1 => ben on duty
  const t = env.fake.addIssue({ labels: ['status:triage'] });
  const r = await env.run(['claim', String(t)]);
  assert.equal(r.code, 3);
  assert.match(r.err, /not the triager on duty \(ben\)/);

  const s = env.fake.addIssue({ labels: ['status:claimed'], assignees: ['ben-gh'] });
  env.fake.addComment(s, claimBody('ben', '2026-11-06T10:00:00Z', ' to=any'), { login: 'ben-gh' });
  const denied = await env.run(['claim', String(s)]);
  assert.equal(denied.code, 3);
  assert.match(denied.err, /--steal/);
  const ok = await env.run(['claim', String(s), '--steal', '--settle', '0']);
  assert.equal(ok.code, 0, ok.err);
  const bodies = env.fake.commentsOf(s).map((c) => c.body);
  assert.ok(bodies.some((b) => /Taking over expired claim/.test(b)));
  const mine = bodies.map(P.parseMarker).find((m) => m && m.type === 'claim' && m.from === 'aalhad');
  assert.equal(mine.to, 'any'); // recorded routing carried over
});

test('claim --dry-run mutates nothing', async () => {
  const env = setup();
  const n = env.fake.addIssue({ labels: ['status:ready'] });
  const r = await env.run(['claim', String(n), '--dry-run']);
  assert.equal(r.code, 0, r.err);
  assert.equal(env.fake.commentsOf(n).length, 0);
  assert.deepEqual(env.fake.assigneesOf(n), []);
  assert.ok(env.gh.calls.length >= 3);
  assert.match(r.err, /\[dry-run\] POST repos\/o\/r\/issues\/1\/comments/);
});

test('claim already mine is a no-op success', async () => {
  const env = setup();
  const n = env.fake.addIssue({ labels: ['status:ready'] });
  assert.equal((await env.run(['claim', String(n), '--settle', '0'])).code, 0);
  const again = await env.run(['claim', String(n), '--settle', '0']);
  assert.equal(again.code, 0);
  assert.match(again.out, /already claimed/);
  assert.equal(env.fake.commentsOf(n).length, 1);
});
