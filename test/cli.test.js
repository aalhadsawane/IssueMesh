'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const P = require('../lib/protocol');
const { makeEnv, claimBody } = require('./cli-helpers');
const { scheduleNext, watchLoop } = require('../lib/cli/watch');
const { injectSnippet, BEGIN, END } = require('../lib/cli/init');
const { parseArgs } = require('../lib/cli/args');
const { createGh } = require('../lib/gh');

function setup(opts) {
  const env = makeEnv(opts);
  test.after(() => env.cleanup());
  return env;
}

/* -------------------------------------------------------------- basics */

test('help, unknown command and usage exit codes', async () => {
  const env = setup();
  const h = await env.run(['--help']);
  assert.equal(h.code, 0);
  assert.match(h.out, /Exit codes:/);
  assert.match((await env.run(['claim', '-h'])).out, /mesh claim - claim an issue/);
  assert.match((await env.run(['help', 'inbox'])).out, /mesh inbox/);
  assert.equal((await env.run(['nope'])).code, 2);
  assert.equal((await env.run(['claim'])).code, 2);
  assert.equal((await env.run(['claim', 'abc'])).code, 2);
  assert.equal((await env.run(['claim', '1', '--bogus'])).code, 2);
  assert.equal((await env.run(['inbox', '--actor', 'robot'])).code, 2);
});

test('parseArgs: forms, multi, terminator', () => {
  const a = parseArgs(['5', '--body=x y', '--append', 'a', '--append', 'b', '-q', '--', '--lit'], { string: ['body'], multi: ['append'], boolean: ['quiet'], alias: { q: 'quiet' } });
  assert.deepEqual(a._, ['5', '--lit']);
  assert.equal(a.flags.body, 'x y');
  assert.deepEqual(a.flags.append, ['a', 'b']);
  assert.equal(a.flags.quiet, true);
  assert.throws(() => parseArgs(['--body'], { string: ['body'] }), /needs a value/);
});

test('gh.paginate walks pages and dry-run records mutations but allows GET', async () => {
  const env = setup();
  for (let i = 0; i < 5; i++) env.fake.addIssue({ title: `i${i}` });
  const gh = createGh(env.fake.transport, { dryRun: true, log: () => {} });
  const all = await gh.paginate('repos/o/r/issues?state=open', { perPage: 2 });
  assert.equal(all.length, 5);
  await gh.api('POST', 'repos/o/r/issues/1/labels', { labels: ['x'] });
  assert.equal(gh.calls.length, 1);
  assert.ok(!env.fake.labelsOf(1).includes('x'));
});

test('whoami json shape', async () => {
  const env = setup();
  env.fake.addIssue({ labels: ['status:claimed'], assignees: ['aalhad-gh'] });
  const r = await env.run(['whoami', '--json']);
  const j = r.json();
  assert.equal(j.handle, 'aalhad');
  assert.equal(j.login, 'aalhad-gh');
  assert.equal(j.actor, 'agent');
  assert.equal(j.triager_on_duty, false);
  assert.equal(j.on_duty_handle, 'ben');
  assert.equal(j.live_claims, 1);
  assert.equal(j.wip, 2);
});

/* --------------------------------------------------------------- inbox */

test('inbox buckets, ordering, json shape and -q exit codes', async () => {
  const env = setup();
  const f = env.fake;
  const market = f.addIssue({ title: 'market', labels: ['status:ready', 'to:any'] });
  const routed = f.addIssue({ title: 'routed', labels: ['status:ready', 'to:aalhad'] });
  const routedP0 = f.addIssue({ title: 'routed-p0', labels: ['status:ready', 'to:aalhad', 'priority:p0'] });
  const active = f.addIssue({ title: 'active', labels: ['status:claimed'], assignees: ['aalhad-gh'] });
  const review = f.addIssue({ title: 'review', labels: ['status:review', 'to:aalhad'], pr: true });
  const mailbox = f.addIssue({ title: 'mailbox', labels: ['ping:aalhad', 'status:ready', 'to:aalhad'] });
  f.addIssue({ title: 'triage-not-on-duty', labels: ['status:triage'] });
  f.addIssue({ title: 'others', labels: ['status:ready', 'to:ben'] });
  f.addIssue({ title: 'humanonly', labels: ['status:ready', 'to:any', 'human-only'] });
  const r = await env.run(['inbox', '--json']);
  const j = r.json();
  assert.equal(j.handle, 'aalhad');
  assert.equal(j.total, 6);
  assert.deepEqual(j.items.map((i) => i.number), [mailbox, active, review, routedP0, routed, market]);
  assert.deepEqual(j.items.map((i) => i.bucket), [1, 2, 3, 4, 4, 6]);
  assert.equal(j.items[0].bucketName, 'mailbox');
  assert.equal(j.items[2].isPR, true);
  assert.ok(j.items[0].url && j.items[0].reason && Array.isArray(j.items[0].labels));

  const lim = (await env.run(['inbox', '--json', '--limit', '2'])).json();
  assert.equal(lim.items.length, 2);
  assert.equal(lim.total, 6);

  const q = await env.run(['inbox', '-q']);
  assert.equal(q.code, 0);
  assert.equal(q.out.trim(), '6');
  assert.match((await env.run(['inbox'])).out, /1 mailbox\s+#\d+\s+mailbox/);
});

test('inbox: empty -> exit 10 with -q; WIP gates the market; triage on duty', async () => {
  const env = setup({ user: 'ben-gh' }); // ben is on duty today
  const q = await env.run(['inbox', '-q']);
  assert.equal(q.code, 10);
  assert.match((await env.run(['inbox'])).out, /Inbox empty/);

  const t = env.fake.addIssue({ labels: ['status:triage'] });
  const m = env.fake.addIssue({ labels: ['status:ready', 'to:any'] });
  let j = (await env.run(['inbox', '--json'])).json();
  assert.deepEqual(j.items.map((i) => [i.number, i.bucketName]), [[t, 'triage'], [m, 'market']]);
  env.fake.addIssue({ labels: ['status:claimed'], assignees: ['ben-gh'] });
  env.fake.addIssue({ labels: ['status:claimed'], assignees: ['ben-gh'] });
  j = (await env.run(['inbox', '--json'])).json();
  assert.ok(!j.items.some((i) => i.bucketName === 'market'));
});

/* ------------------------------------------------ status / release / handoff */

async function claimed(env, labels = ['status:ready', 'to:any']) {
  const n = env.fake.addIssue({ labels });
  const r = await env.run(['claim', String(n), '--settle', '0', '--plan', 'p']);
  assert.equal(r.code, 0, r.err);
  return n;
}

test('status edit bumps lease; set/append/check; heartbeat', async () => {
  const env = setup();
  const n = await claimed(env);
  env.clock.t += 60 * 60000; // +1h
  let r = await env.run(['status', String(n), '--set', '- [ ] write tests\n- [ ] ship', '--append', 'branch: mesh/1-x', '--check', 'write tests']);
  assert.equal(r.code, 0, r.err);
  let c = env.fake.commentsOf(n)[0];
  const m = P.parseMarker(c.body);
  assert.equal(m.lease, '2026-11-06T15:00:00Z');
  assert.equal(m.to, 'any');
  assert.match(c.body, /- \[x\] write tests\n- \[ \] ship\nbranch: mesh\/1-x/);
  assert.match(c.body, /<sub>🤖 aalhad's agent · IssueMesh<\/sub>$/);
  assert.equal(env.fake.commentsOf(n).length, 1);

  env.clock.t += 30 * 60000;
  r = await env.run(['heartbeat', String(n)]);
  assert.equal(r.code, 0);
  c = env.fake.commentsOf(n)[0];
  assert.equal(P.parseMarker(c.body).lease, '2026-11-06T15:30:00Z');
  assert.match(c.body, /branch: mesh\/1-x/); // content untouched

  assert.equal((await env.run(['status', String(n)])).code, 2);
  const other = env.fake.addIssue({ labels: ['status:ready'] });
  assert.equal((await env.run(['status', String(other), '--append', 'x'])).code, 3);
});

test('release restores routing, unassigns, and respects --to-status', async () => {
  const env = setup();
  const n = await claimed(env);
  const r = await env.run(['release', String(n), '--reason', 'out of time']);
  assert.equal(r.code, 0, r.err);
  const m = P.parseMarker(env.fake.commentsOf(n)[0].body);
  assert.equal(m.type, 'released');
  assert.equal(m.reason, 'out-of-time');
  assert.equal(m.lease, undefined);
  assert.deepEqual(env.fake.assigneesOf(n), []);
  const labels = env.fake.labelsOf(n);
  assert.ok(labels.includes('status:ready') && labels.includes('to:any') && !labels.includes('status:claimed'));
  assert.equal((await env.run(['release', String(n)])).code, 3); // nothing to release

  const n2 = await claimed(env);
  assert.equal((await env.run(['release', String(n2), '--to-status', 'review'])).code, 0);
  assert.ok(env.fake.labelsOf(n2).includes('status:review'));
  assert.equal((await env.run(['release', String(n2), '--to-status', 'nope'])).code, 2);
});

test('handoff releases, routes, pings and posts a handoff comment', async () => {
  const env = setup();
  const n = await claimed(env);
  const r = await env.run(['handoff', String(n), 'ben', '--note', 'half done, see branch']);
  assert.equal(r.code, 0, r.err);
  const cs = env.fake.commentsOf(n);
  const ho = cs.map((c) => P.parseMarker(c.body)).find((m) => m.type === 'handoff');
  assert.equal(ho.to, 'ben');
  assert.equal(P.parseMarker(cs[0].body).type, 'released');
  assert.equal(P.parseMarker(cs[0].body).reason, 'handoff');
  const labels = env.fake.labelsOf(n);
  assert.ok(labels.includes('to:ben') && labels.includes('ping:ben') && labels.includes('status:ready'));
  assert.ok(!labels.includes('to:any'));
  assert.deepEqual(env.fake.assigneesOf(n), []);
  assert.equal((await env.run(['handoff', String(n), 'zed', '--note', 'x'])).code, 2);
  assert.equal((await env.run(['handoff', String(n), 'ben'])).code, 2);
});

/* ------------------------------------------------------ post / ping / ack */

test('post ask adds ping labels; review verdict; answer re; validation', async () => {
  const env = setup();
  const n = env.fake.addIssue({ labels: ['status:claimed'] });
  let r = await env.run(['post', String(n), '--type', 'ask', '--to', 'ben,chen', '--body', 'which db?']);
  assert.equal(r.code, 0, r.err);
  let c = env.fake.commentsOf(n)[0];
  const m = P.parseMarker(c.body);
  assert.deepEqual([m.type, m.from, m.actor, m.to], ['ask', 'aalhad', 'agent', 'ben,chen']);
  assert.ok(env.fake.labelsOf(n).includes('ping:ben') && env.fake.labelsOf(n).includes('ping:chen'));

  r = await env.run(['post', String(n), '--type', 'review', '--verdict', 'approve', '--body', 'lgtm']);
  assert.equal(P.parseMarker(env.fake.commentsOf(n)[1].body).verdict, 'approve');
  r = await env.run(['post', String(n), '--type', 'answer', '--re', '101', '--body', 'pg']);
  assert.equal(P.parseMarker(env.fake.commentsOf(n)[2].body).re, '101');

  const human = await env.run(['post', String(n), '--type', 'note', '--body', 'hi', '--actor', 'human']);
  assert.equal(P.parseMarker(env.fake.commentsOf(n)[3].body).actor, 'human');
  assert.equal(human.code, 0);

  assert.equal((await env.run(['post', String(n), '--type', 'ask', '--body', 'x'])).code, 2);
  assert.equal((await env.run(['post', String(n), '--type', 'claim', '--body', 'x'])).code, 2);
  assert.equal((await env.run(['post', String(n), '--type', 'review', '--verdict', 'meh', '--body', 'x'])).code, 2);
  assert.equal((await env.run(['post', String(n), '--type', 'note'])).code, 2);
});

test('post --body-file', async () => {
  const env = setup();
  const n = env.fake.addIssue({});
  fs.writeFileSync(path.join(env.dir, 'msg.md'), 'from file');
  assert.equal((await env.run(['post', String(n), '--type', 'note', '--body-file', 'msg.md'])).code, 0);
  assert.match(env.fake.commentsOf(n)[0].body, /from file/);
});

test('ping adds labels (all = other agent-enabled members); ack removes and reacts', async () => {
  const env = setup();
  const n = env.fake.addIssue({});
  assert.equal((await env.run(['ping', String(n), 'ben', '--body', 'look'])).code, 0);
  assert.ok(env.fake.labelsOf(n).includes('ping:ben'));
  assert.equal(P.parseMarker(env.fake.commentsOf(n)[0].body).type, 'note');
  assert.equal((await env.run(['ping', String(n), 'all'])).code, 0);
  assert.ok(!env.fake.labelsOf(n).includes('ping:aalhad') && !env.fake.labelsOf(n).includes('ping:chen'));
  assert.equal((await env.run(['ping', String(n), 'zed'])).code, 2);

  env.fake.issues.get(n).labels.push('ping:aalhad');
  const r = await env.run(['ack', String(n)]);
  assert.equal(r.code, 0, r.err);
  assert.ok(!env.fake.labelsOf(n).includes('ping:aalhad'));
  assert.deepEqual(env.fake.reactions, [{ issue: n, content: 'eyes' }]);
  await env.run(['ack', String(n)]); // idempotent, no second reaction
  assert.equal(env.fake.reactions.length, 1);
});

test('route and label', async () => {
  const env = setup();
  const n = env.fake.addIssue({ labels: ['status:triage', 'to:any'] });
  assert.equal((await env.run(['route', String(n), 'ben'])).code, 0);
  let l = env.fake.labelsOf(n);
  assert.ok(l.includes('to:ben') && !l.includes('to:any') && l.includes('status:ready') && !l.includes('status:triage'));
  assert.equal((await env.run(['route', String(n), 'zed'])).code, 2);
  assert.equal((await env.run(['label', String(n), '--priority', 'p1', '--size', 'm', '--kind', 'task'])).code, 0);
  l = env.fake.labelsOf(n);
  assert.ok(['priority:p1', 'size:m', 'kind:task'].every((x) => l.includes(x)));
  assert.equal((await env.run(['label', String(n), '--size', 'xl'])).code, 2);
  assert.equal((await env.run(['label', String(n)])).code, 2);
});

test('escalate mentions assignees and sets needs-human', async () => {
  const env = setup();
  const n = env.fake.addIssue({ labels: ['status:claimed'], assignees: ['aalhad-gh'] });
  const r = await env.run(['escalate', String(n), '--body', 'schema migration needs sign-off']);
  assert.equal(r.code, 0, r.err);
  const c = env.fake.commentsOf(n)[0];
  assert.equal(P.parseMarker(c.body).type, 'escalate');
  assert.match(c.body, /cc @aalhad-gh/);
  assert.ok(env.fake.labelsOf(n).includes('status:needs-human'));
  assert.ok(!env.fake.labelsOf(n).includes('status:claimed'));
  await env.run(['escalate', String(n), '--body', 'x', '--notify', 'ben-gh,chen-gh']);
  assert.match(env.fake.commentsOf(n)[1].body, /cc @ben-gh @chen-gh/);
});

/* --------------------------------------------------------------- board */

test('board resolution, cursor, post and standup once per day', async () => {
  const env = setup();
  const old = env.fake.addIssue({ labels: ['kind:board'], state: 'closed' });
  const b = env.fake.addIssue({ labels: ['kind:board'] });
  env.fake.addComment(b, 'plain human note', { login: 'ben-gh' });

  let r = await env.run(['board', '--json']);
  let rows = r.json();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actor, 'human');
  assert.equal((await env.run(['board', '--json'])).json().length, 0); // cursor advanced

  r = await env.run(['board', 'post', '--type', 'broadcast', '--body', 'release at 5']);
  assert.equal(r.code, 0, r.err);
  rows = (await env.run(['board', '--json'])).json();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, 'broadcast');
  assert.equal(rows[0].body, 'release at 5');
  assert.equal((await env.run(['board', 'post', '--type', 'note', '--body', 'x'])).code, 2);
  assert.equal(env.fake.issues.get(old).state, 'closed');

  // config.board_issue wins when open
  const cfgFile = path.join(env.dir, '.issuemesh', 'team.json');
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  cfg.board_issue = old;
  fs.writeFileSync(cfgFile, JSON.stringify(cfg));
  r = await env.run(['board', '--since', '2020-01-01T00:00:00Z', '--json']);
  assert.ok(r.json().length >= 2, 'closed board_issue falls back to newest open kind:board');

  const s1 = await env.run(['standup', '--body', 'Done: a']);
  assert.equal(s1.code, 0, s1.err);
  const s2 = await env.run(['standup', '--body', 'Done: b']);
  assert.equal(s2.code, 0);
  assert.match(s2.out, /already posted today/);
  assert.match((await env.run(['standup'])).out, /already posted today/);
  const standups = env.fake.commentsOf(b).filter((c) => (P.parseMarker(c.body) || {}).type === 'standup');
  assert.equal(standups.length, 1);
  env.clock.t += 24 * 3600000;
  assert.match((await env.run(['standup', '--body', 'Done: c'])).out, /Posted standup/);
  assert.equal(env.fake.commentsOf(b).filter((c) => (P.parseMarker(c.body) || {}).type === 'standup').length, 2);
});

test('board: no board -> exit 1', async () => {
  const env = setup();
  const r = await env.run(['board']);
  assert.equal(r.code, 1);
  assert.match(r.err, /no open Board/);
});

/* --------------------------------------------------------------- sweep */

test('sweep releases expired agent claims, restores to:, leaves live and human UI claims', async () => {
  const env = setup();
  const dead = env.fake.addIssue({ labels: ['status:claimed'], assignees: ['ben-gh'] });
  env.fake.addComment(dead, claimBody('ben', '2026-11-06T10:00:00Z', ' to=any'), { login: 'ben-gh' });
  const live = env.fake.addIssue({ labels: ['status:claimed'], assignees: ['ben-gh'] });
  env.fake.addComment(live, claimBody('ben', '2026-11-06T13:00:00Z'), { login: 'ben-gh' });
  const ui = env.fake.addIssue({ labels: ['status:claimed'], assignees: ['chen-gh'] });
  const pr = env.fake.addIssue({ labels: ['status:claimed'], pr: true });

  const r = await env.run(['sweep', '--json']);
  assert.equal(r.code, 0, r.err);
  const j = r.json();
  assert.deepEqual(j.released.map((x) => x.number), [dead]);
  assert.deepEqual(j.skipped.map((x) => x.number), [ui]);
  const m = P.parseMarker(env.fake.commentsOf(dead)[0].body);
  assert.deepEqual([m.type, m.reason], ['released', 'expired']);
  const l = env.fake.labelsOf(dead);
  assert.ok(l.includes('status:ready') && l.includes('to:any') && !l.includes('status:claimed'));
  assert.deepEqual(env.fake.assigneesOf(dead), []);
  assert.ok(env.fake.labelsOf(live).includes('status:claimed'));
  assert.ok(env.fake.labelsOf(pr).includes('status:claimed'));
  assert.deepEqual(env.fake.assigneesOf(live), ['ben-gh']);
});

test('sweep: expired human /claim is unassigned and made ready', async () => {
  const env = setup();
  const n = env.fake.addIssue({ labels: ['status:claimed'], assignees: ['ben-gh'] });
  env.fake.addComment(n, '/claim', { login: 'ben-gh', createdAt: '2026-11-01T00:00:00Z' });
  await env.run(['sweep']);
  assert.ok(env.fake.labelsOf(n).includes('status:ready'));
  assert.deepEqual(env.fake.assigneesOf(n), []);
});

/* --------------------------------------------------------------- watch */

test('watch scheduling: jitter bounds, back-off doubling, reset on work', () => {
  const base = { interval: 300, maxInterval: 1800 };
  let s = scheduleNext({ ...base, delay: 300, hadWork: false, rand: () => 0.5 });
  assert.deepEqual(s, { sleepMs: 300000, nextDelay: 600 });
  s = scheduleNext({ ...base, delay: 600, hadWork: false, rand: () => 0.5 });
  assert.equal(s.nextDelay, 1200);
  s = scheduleNext({ ...base, delay: 1200, hadWork: false, rand: () => 0.5 });
  assert.equal(s.nextDelay, 1800); // capped
  s = scheduleNext({ ...base, delay: 1800, hadWork: false, rand: () => 0.5 });
  assert.equal(s.nextDelay, 1800);
  s = scheduleNext({ ...base, delay: 1800, hadWork: true, rand: () => 0.5 });
  assert.deepEqual(s, { sleepMs: 300000, nextDelay: 300 }); // reset
  assert.equal(scheduleNext({ ...base, delay: 300, hadWork: false, rand: () => 0 }).sleepMs, 255000); // -15%
  assert.equal(scheduleNext({ ...base, delay: 300, hadWork: false, rand: () => 1 }).sleepMs, 345000); // +15%
});

test('watchLoop: runs command on work, backs off when idle, resets after work', async () => {
  const counts = [0, 0, 2, 0];
  const sleeps = [];
  const execs = [];
  let i = 0;
  const n = await watchLoop({ interval: 10, maxInterval: 40 }, {
    maxIterations: 4,
    rand: () => 0.5,
    shouldStop: () => false,
    log: () => {},
    check: async () => counts[i++],
    exec: async () => { execs.push(i); return 0; },
    sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.equal(n, 4);
  assert.deepEqual(execs, [3]);
  assert.deepEqual(sleeps, [10000, 20000, 10000, 10000]);
});

test('watchLoop: check failure is treated as idle; --once stops', async () => {
  const sleeps = [];
  let calls = 0;
  await watchLoop({ interval: 10, maxInterval: 40 }, {
    maxIterations: 2, rand: () => 0.5, shouldStop: () => false, log: () => {},
    check: async () => { calls++; throw new Error('boom'); }, exec: async () => 0, sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [10000, 20000]);
  const it = await watchLoop({ interval: 10, maxInterval: 40 }, {
    once: true, rand: () => 0.5, shouldStop: () => false, log: () => {}, check: async () => 1, exec: async () => 0, sleep: async () => { throw new Error('no sleep'); },
  });
  assert.equal(it, 1);
});

/* ---------------------------------------------------------------- init */

test('injectSnippet is idempotent and replaces in place', () => {
  const snip = `${BEGIN}\nhello\n${END}\n`;
  const once = injectSnippet('# Project\n', snip);
  assert.equal(once, `# Project\n\n${BEGIN}\nhello\n${END}\n`);
  assert.equal(injectSnippet(once, snip), once);
  const updated = injectSnippet(once, `${BEGIN}\nnew text\n${END}\n`);
  assert.match(updated, /new text/);
  assert.ok(!/hello/.test(updated));
  assert.equal((updated.match(new RegExp(BEGIN, 'g')) || []).length, 1);
  assert.equal(injectSnippet('', snip), `${BEGIN}\nhello\n${END}\n`);
  assert.equal(injectSnippet('a $& b\n', 'x $& y'), `a $& b\n\n${BEGIN}\nx $& y\n${END}\n`);
});

function writeTemplates(dir) {
  const t = path.join(dir, 'tpl');
  fs.mkdirSync(path.join(t, '.issuemesh'), { recursive: true });
  fs.mkdirSync(path.join(t, '.github', 'ISSUE_TEMPLATE'), { recursive: true });
  fs.mkdirSync(path.join(t, '.github', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(t, '.issuemesh', 'team.json'), JSON.stringify({ $schema: 'x', version: 1, members: [{ handle: 'tpl', github: 'tpl' }], triage: { rotation: ['tpl'], period: 'daily' }, areas: {}, policy: { wake: false } }));
  fs.writeFileSync(path.join(t, '.github', 'ISSUE_TEMPLATE', 'task.yml'), 'name: Task\n');
  fs.writeFileSync(path.join(t, '.github', 'workflows', 'issuemesh-referee.yml'), 'name: ref\n');
  fs.writeFileSync(path.join(t, '.github', 'workflows', 'issuemesh-agent.yml'), 'name: agent\n');
  fs.writeFileSync(path.join(t, 'AGENTS.snippet.md'), `${BEGIN}\n## IssueMesh\nrules\n${END}\n`);
  return t;
}

test('init: scaffolds, is idempotent, snippet fenced once, board pinned, labels synced', async () => {
  const env = setup({ writeTeam: false });
  const tpl = writeTemplates(env.dir);
  fs.writeFileSync(path.join(env.dir, 'AGENTS.md'), '# Agents\n');
  fs.writeFileSync(path.join(env.dir, 'CLAUDE.md'), '# Claude\n');
  const args = ['init', '--member', 'aalhad:aalhad-gh', '--member', 'ben:ben-gh'];

  const r = await env.run(args, { templatesDir: tpl });
  assert.equal(r.code, 0, r.err);
  const cfg = JSON.parse(fs.readFileSync(path.join(env.dir, '.issuemesh', 'team.json'), 'utf8'));
  assert.deepEqual(cfg.members.map((m) => m.handle), ['aalhad', 'ben']);
  assert.equal(cfg.triage.rotation, undefined);
  assert.equal(cfg.board_issue, 1);
  assert.ok(fs.existsSync(path.join(env.dir, '.github', 'ISSUE_TEMPLATE', 'task.yml')));
  assert.ok(fs.existsSync(path.join(env.dir, '.github', 'workflows', 'issuemesh-referee.yml')));
  assert.ok(!fs.existsSync(path.join(env.dir, '.github', 'workflows', 'issuemesh-agent.yml')));
  for (const f of ['AGENTS.md', 'CLAUDE.md']) {
    const txt = fs.readFileSync(path.join(env.dir, f), 'utf8');
    assert.equal(txt.split(BEGIN).length - 1, 1);
    assert.equal(txt.split(END).length - 1, 1);
  }
  assert.ok(env.fake.labelDefs.has('status:ready') && env.fake.labelDefs.has('ping:ben'));
  assert.equal(env.fake.issues.size, 1);
  assert.ok(env.fake.issues.get(1).labels.includes('kind:board'));
  assert.equal(env.fake.graphqlCalls.length, 1);
  assert.match(env.fake.graphqlCalls[0].query, /pinIssue\(input: \{issueId: \$id\}\)/);
  assert.equal(env.fake.graphqlCalls[0].variables.id, 'NODE_1');

  const before = fs.readFileSync(path.join(env.dir, 'AGENTS.md'), 'utf8');
  fs.writeFileSync(path.join(env.dir, '.github', 'ISSUE_TEMPLATE', 'task.yml'), 'customized\n');
  const r2 = await env.run(args, { templatesDir: tpl });
  assert.equal(r2.code, 0, r2.err);
  assert.equal(fs.readFileSync(path.join(env.dir, 'AGENTS.md'), 'utf8'), before);
  assert.equal(fs.readFileSync(path.join(env.dir, '.github', 'ISSUE_TEMPLATE', 'task.yml'), 'utf8'), 'customized\n');
  assert.equal(env.fake.issues.size, 1, 'board is not recreated');
  assert.equal(env.fake.graphqlCalls.length, 1);

  await env.run(['init', '--templates', '--force', '--with-agent-runner'], { templatesDir: tpl });
  assert.equal(fs.readFileSync(path.join(env.dir, '.github', 'ISSUE_TEMPLATE', 'task.yml'), 'utf8'), 'name: Task\n');
  assert.ok(fs.existsSync(path.join(env.dir, '.github', 'workflows', 'issuemesh-agent.yml')));
});

test('init: missing templates warn but succeed; requires --member without TTY; creates AGENTS.md', async () => {
  const env = setup({ writeTeam: false });
  assert.equal((await env.run(['init'])).code, 2);
  assert.equal((await env.run(['init', '--member', 'bad'])).code, 2);
  const r = await env.run(['init', '--member', 'a:a-gh', '--templates'], { templatesDir: path.join(env.dir, 'nope') });
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /templates directory not found/);
  assert.ok(fs.existsSync(path.join(env.dir, '.issuemesh', 'team.json')));
});

test('init --dry-run writes nothing', async () => {
  const env = setup({ writeTeam: false });
  const tpl = writeTemplates(env.dir);
  const r = await env.run(['init', '--member', 'a:a-gh', '--dry-run'], { templatesDir: tpl });
  assert.equal(r.code, 0, r.err);
  assert.ok(!fs.existsSync(path.join(env.dir, '.issuemesh')));
  assert.ok(!fs.existsSync(path.join(env.dir, '.github')));
  assert.equal(env.fake.issues.size, 0);
  assert.equal(env.fake.labelDefs.size, 0);
});

test('labels sync creates then updates drifted labels', async () => {
  const env = setup();
  assert.equal((await env.run(['labels', 'sync'])).code, 0);
  const total = env.fake.labelDefs.size;
  assert.ok(total >= 29);
  env.fake.labelDefs.get('status:ready').color = 'ffffff';
  const r = await env.run(['labels', 'sync', '--json']);
  assert.deepEqual(r.json().updated, ['status:ready']);
  assert.equal(r.json().created.length, 0);
  assert.equal(env.fake.labelDefs.size, total);
});

test('doctor reports failures with exit 1 and ok with 0', async () => {
  const env = setup();
  let r = await env.run(['doctor', '--json']);
  assert.equal(r.code, 1); // labels/board missing
  assert.equal(r.json().ok, false);
  await env.run(['labels', 'sync']);
  env.fake.addIssue({ labels: ['kind:board'] });
  r = await env.run(['doctor', '--json']);
  assert.equal(r.code, 0, r.out);
  assert.ok(r.json().checks.some((c) => c.name === 'referee workflow present' && !c.ok && !c.required));
});

test('--as selects another member; unknown login errors', async () => {
  const env = setup({ user: 'stranger' });
  const r = await env.run(['whoami']);
  assert.equal(r.code, 1);
  assert.match(r.err, /not a member/);
  const ok = await env.run(['whoami', '--as', 'ben', '--json']);
  assert.equal(ok.json().handle, 'ben');
  assert.equal((await env.run(['whoami', '--as', 'zed'])).code, 2);
});
