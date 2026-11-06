'use strict';

// F4: fast inbox gate (ETag / 304), --min-interval and --new-only. PROTOCOL.md section 6 "Fast check".

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeEnv } = require('./cli-helpers');
const { cacheFile } = require('../lib/cli/inbox');

function setup(opts) {
  const env = makeEnv(opts);
  test.after(() => env.cleanup());
  const dir = path.join(env.dir, '.git', 'issuemesh');
  const api = {
    env,
    f: env.fake,
    file: (id = 'aalhad') => path.join(dir, `inbox-${id.replace(/\//g, '_')}.json`),
    cache: (id) => JSON.parse(fs.readFileSync(api.file(id), 'utf8')),
    writeCache: (c, id) => fs.writeFileSync(api.file(id), JSON.stringify(c)),
    requests: () => env.fake.log.filter((e) => !/\/contents\//.test(e.path)).length, // team.json lookups are cached separately
    probes: () => env.fake.conditionalLog.length,
    advance: (ms) => { env.clock.t += ms; },
  };
  return api;
}

const PROBE = 'repos/o/r/issues?state=open&sort=updated&direction=desc&per_page=1';

/* -------------------------------------------------------------- ETag gate */

test('-q gate: first run probes (no etag) and caches; 304 + empty + fresh => exit 10 with one free request', async () => {
  const t = setup();
  let r = await t.env.run(['inbox', '-q']);
  assert.equal(r.code, 10);
  assert.equal(r.out.trim(), '0');
  assert.equal(t.probes(), 1);
  assert.deepEqual(t.f.conditionalLog[0], { path: PROBE, etag: null });
  const c = t.cache();
  assert.equal(c.count, 0);
  assert.equal(c.etag, `W/"v${t.f.version}"`);
  assert.match(c.dutyKey, /^ben@2026-11-06$/);
  assert.equal(c.checkedAt, '2026-11-06T12:00:00.000Z');
  assert.deepEqual(c.surfaced, []);

  const before = t.requests();
  t.advance(5000);
  r = await t.env.run(['inbox', '-q']);
  assert.equal(r.code, 10);
  assert.equal(r.out.trim(), '0');
  assert.equal(t.requests(), before, 'no REST request besides the conditional probe (not even GET user)');
  assert.equal(t.probes(), 2);
  assert.equal(t.f.conditionalLog[1].etag, c.etag);
});

test('-q gate: a change (200) runs the full inbox; non-empty cached inbox is never short-circuited', async () => {
  const t = setup();
  await t.env.run(['inbox', '-q']);
  const n = t.f.addIssue({ title: 'mine', labels: ['status:ready', 'to:aalhad'] }); // bumps the ETag
  let before = t.requests();
  let r = await t.env.run(['inbox', '-q']);
  assert.equal(r.code, 0);
  assert.equal(r.out.trim(), '1');
  assert.ok(t.requests() > before, 'full inbox ran');
  assert.equal(t.cache().count, 1);
  assert.equal(t.cache().etag, `W/"v${t.f.version}"`);

  // unchanged (304) but the cached inbox is not empty: still a full run
  before = t.requests();
  r = await t.env.run(['inbox', '-q']);
  assert.equal(r.code, 0);
  assert.ok(t.requests() > before);

  // the work disappears: next run sees an empty inbox, the one after is gated again
  t.f.issues.get(n).state = 'closed';
  t.f.touch();
  assert.equal((await t.env.run(['inbox', '-q'])).code, 10);
  before = t.requests();
  assert.equal((await t.env.run(['inbox', '-q'])).code, 10);
  assert.equal(t.requests(), before);
});

test('-q gate: the etag stored is the one from the probe made BEFORE the full run', async () => {
  const t = setup();
  const realList = t.f.transport;
  let bumped = false;
  t.f.transport = async (method, p, body) => {
    // a change lands while the full inbox is being computed
    if (!bumped && method === 'GET' && /\/issues\?state=open&sort=created/.test(p)) { bumped = true; t.f.touch(); }
    return realList(method, p, body);
  };
  await t.env.run(['inbox', '-q']);
  const stored = t.cache().etag;
  assert.notEqual(stored, `W/"v${t.f.version}"`, 'stale etag, so the next probe reports the change');
  t.f.transport = realList;
  const before = t.requests();
  await t.env.run(['inbox', '-q']);
  assert.ok(t.requests() > before, 'probe returned 200, full run again');
});

test('-q gate: cache older than 10 minutes or from another triage-duty day is not trusted', async () => {
  const t = setup();
  await t.env.run(['inbox', '-q']);
  t.advance(9 * 60000);
  let before = t.requests();
  await t.env.run(['inbox', '-q']);
  assert.equal(t.requests(), before, '9 minutes: still gated');

  t.advance(2 * 60000); // 11 minutes since the full run (a 304 does not refresh it)
  before = t.requests();
  assert.equal((await t.env.run(['inbox', '-q'])).code, 10);
  assert.ok(t.requests() > before, '11 minutes: full run');
  assert.equal(t.cache().checkedAt, new Date(t.env.clock.t).toISOString());

  before = t.requests();
  await t.env.run(['inbox', '-q']);
  assert.equal(t.requests(), before, 'gated again after the refresh');

  const c = t.cache();
  c.dutyKey = 'chen@2026-11-05'; // duty key differs (another day / triager)
  t.writeCache(c);
  before = t.requests();
  await t.env.run(['inbox', '-q']);
  assert.ok(t.requests() > before, 'different triage-duty key: full run');
  assert.equal(t.cache().dutyKey, 'ben@2026-11-06');
});

test('-q gate across midnight UTC: the duty key changes with the date', async () => {
  const t = setup();
  t.env.clock.t = Date.parse('2026-11-06T23:55:00Z');
  await t.env.run(['inbox', '-q']);
  assert.equal(t.cache().dutyKey, 'ben@2026-11-06');
  t.advance(6 * 60000); // 00:01 next day, within the 10 minutes
  const before = t.requests();
  await t.env.run(['inbox', '-q']);
  assert.ok(t.requests() > before, 'new day: the triager rotates, so the cached "empty" is void');
  assert.match(t.cache().dutyKey, /@2026-11-07$/);
});

test('-q gate: a failing conditional request falls back to the full run', async () => {
  const t = setup();
  await t.env.run(['inbox', '-q']);
  t.f.conditionalFails = true;
  const before = t.requests();
  const r = await t.env.run(['inbox', '-q']);
  assert.equal(r.code, 10);
  assert.ok(t.requests() > before);
  assert.equal(t.cache().etag, null);
});

test('plain mesh inbox and --dry-run never touch the cache or the probe; a corrupt cache is ignored', async () => {
  const t = setup();
  t.f.addIssue({ labels: ['ping:aalhad'] });
  assert.equal((await t.env.run(['inbox'])).code, 0);
  assert.equal(t.probes(), 0);
  assert.ok(!fs.existsSync(t.file()));
  assert.equal((await t.env.run(['inbox', '-q', '--dry-run'])).code, 0);
  assert.ok(!fs.existsSync(t.file()));
  fs.mkdirSync(path.dirname(t.file()), { recursive: true });
  fs.writeFileSync(t.file(), '{not json');
  assert.equal((await t.env.run(['inbox', '-q'])).code, 0);
  assert.equal(t.cache().count, 1);
});

/* ---------------------------------------------------------- --min-interval */

test('--min-interval: a young cache answers with zero API calls (also --json and -q); expiry refreshes', async () => {
  const t = setup();
  t.f.addIssue({ title: 'work', labels: ['ping:aalhad'] });
  let r = await t.env.run(['inbox', '-q', '--min-interval', '30']);
  assert.equal(r.out.trim(), '1');
  const reqs = t.requests();
  const probes = t.probes();

  t.advance(10000);
  t.f.addIssue({ title: 'new work', labels: ['ping:aalhad'] }); // not visible inside the interval
  const reqsAfterAdd = t.requests();
  r = await t.env.run(['inbox', '-q', '--min-interval', '30']);
  assert.equal(r.code, 0);
  assert.equal(r.out.trim(), '1');
  r = await t.env.run(['inbox', '--min-interval', '30', '--json']);
  assert.equal(r.json().total, 1);
  assert.equal(r.json().items[0].title, 'work');
  assert.equal(r.json().agent_id, 'aalhad');
  assert.equal(t.requests(), reqsAfterAdd, 'zero API calls');
  assert.equal(t.probes(), probes);
  assert.ok(reqsAfterAdd >= reqs);

  t.advance(25000); // 35s since the check
  r = await t.env.run(['inbox', '-q', '--min-interval', '30']);
  assert.equal(r.out.trim(), '2');
  assert.ok(t.requests() > reqsAfterAdd);
});

test('--min-interval counts a 304 probe as a check, and 0 always refreshes; bad values are usage errors', async () => {
  const t = setup();
  await t.env.run(['inbox', '-q']); // empty inbox, etag cached
  t.advance(60000);
  await t.env.run(['inbox', '-q']); // 304 gate at +60s
  const before = t.requests();
  const probes = t.probes();
  const r = await t.env.run(['inbox', '-q', '--min-interval', '30']);
  assert.equal(r.code, 10);
  assert.equal(t.requests(), before);
  assert.equal(t.probes(), probes, 'answered from the cache without any request');

  await t.env.run(['inbox', '-q', '--min-interval', '0']);
  assert.ok(t.probes() > probes);

  assert.equal((await t.env.run(['inbox', '--min-interval', 'abc'])).code, 2);
  assert.equal((await t.env.run(['inbox', '--min-interval', '-5'])).code, 2);
});

test('--min-interval without a usable identity cache resolves identity first (one GET user), then caches it', async () => {
  const t = setup();
  const userCalls = () => t.f.log.filter((l) => l.path === 'user').length;
  await t.env.run(['inbox', '-q', '--min-interval', '60']);
  assert.equal(userCalls(), 1);
  await t.env.run(['inbox', '-q', '--min-interval', '60']);
  assert.equal(userCalls(), 1, 'identity cached');
  t.advance(61 * 60000);
  await t.env.run(['inbox', '-q', '--min-interval', '60']);
  assert.equal(userCalls(), 2, 'identity cache expires after an hour');
});

test('--as works without any identity call; the repo slug comes from the cache', async () => {
  const t = setup();
  await t.env.run(['inbox', '-q', '--as', 'aalhad']);
  assert.equal(t.f.log.filter((l) => l.path === 'user').length, 0);
  const before = t.requests();
  await t.env.run(['inbox', '-q', '--as', 'aalhad']);
  assert.equal(t.requests(), before);
});

/* -------------------------------------------------------------- --new-only */

test('--new-only: one summary line for items not surfaced before; exit 10 otherwise; persists', async () => {
  const t = setup();
  const a = t.f.addIssue({ title: 'a', labels: ['ping:aalhad'] });
  const b = t.f.addIssue({ title: 'b', labels: ['status:review', 'to:aalhad'], pr: true });
  let r = await t.env.run(['inbox', '-q', '--new-only']);
  assert.equal(r.code, 0);
  assert.equal(r.out, `2 new: #${a} mailbox, #${b} review\n`);
  assert.deepEqual(t.cache().surfaced.sort(), [`${a}@${t.f.issues.get(a).updated_at}`, `${b}@${t.f.issues.get(b).updated_at}`].sort());

  r = await t.env.run(['inbox', '-q', '--new-only']);
  assert.equal(r.code, 10);
  assert.equal(r.out, '');

  // an update of the item makes it new again
  t.f.issues.get(a).updated_at = '2026-11-06T13:30:00Z';
  t.f.touch();
  r = await t.env.run(['inbox', '-q', '--new-only']);
  assert.equal(r.code, 0);
  assert.equal(r.out, `1 new: #${a} mailbox\n`);
  assert.equal((await t.env.run(['inbox', '-q', '--new-only'])).code, 10);

  // a plain -q still reports the whole inbox
  assert.equal((await t.env.run(['inbox', '-q'])).out.trim(), '2');

  // --json
  const c = t.f.addIssue({ title: 'c', labels: ['status:ready', 'to:aalhad'] });
  r = await t.env.run(['inbox', '-q', '--new-only', '--json']);
  const j = r.json();
  assert.deepEqual([j.count, j.new.map((i) => i.number), j.summary], [3, [c], `1 new: #${c} routed`]);
});

test('--new-only requires -q; empty inbox is exit 10 and silent', async () => {
  const t = setup();
  assert.equal((await t.env.run(['inbox', '--new-only'])).code, 2);
  const r = await t.env.run(['inbox', '-q', '--new-only']);
  assert.equal(r.code, 10);
  assert.equal(r.out, '');
  assert.equal((await t.env.run(['inbox', '-q', '--new-only'])).out, '', 'the 304 gate is silent too');
});

test('--new-only caps the surfaced set at 500 keys, newest kept', async () => {
  const t = setup();
  t.f.addIssue({ labels: ['ping:aalhad'] });
  await t.env.run(['inbox', '-q']);
  const c = t.cache();
  c.surfaced = Array.from({ length: 600 }, (_, i) => `${1000 + i}@x`);
  t.writeCache(c);
  const n = t.f.addIssue({ title: 'late', labels: ['ping:aalhad'] });
  const r = await t.env.run(['inbox', '-q', '--new-only']);
  assert.equal(r.code, 0);
  const s = t.cache().surfaced;
  assert.equal(s.length, 500);
  assert.equal(s[s.length - 1], `${n}@${t.f.issues.get(n).updated_at}`);
  assert.equal(s[0], '1102@x'); // 602 keys (the first issue is new too): oldest 102 dropped
});

test('--new-only with --min-interval reads the cache: zero calls, new items appear after expiry', async () => {
  const t = setup();
  t.f.addIssue({ title: 'a', labels: ['ping:aalhad'] });
  assert.equal((await t.env.run(['inbox', '-q', '--new-only', '--min-interval', '10'])).code, 0);
  const d = t.f.addIssue({ title: 'd', labels: ['ping:aalhad'] });
  const before = t.requests();
  assert.equal((await t.env.run(['inbox', '-q', '--new-only', '--min-interval', '10'])).code, 10);
  assert.equal(t.requests(), before);
  t.advance(11000);
  const r = await t.env.run(['inbox', '-q', '--new-only', '--min-interval', '10']);
  assert.equal(r.out, `1 new: #${d} mailbox\n`);
});

/* ------------------------------------------------------------- state files */

test('state is kept per agent id (/ -> _): separate caches and surfaced sets', async () => {
  const multi = {
    version: 1,
    members: [{ handle: 'aalhad', github: 'aalhad-gh', agents: [{ name: 'claude' }, { name: 'codex' }] }],
    triage: { rotation: ['aalhad'] },
  };
  const t = setup({ team: multi });
  const n = t.f.addIssue({ labels: ['ping:aalhad/codex', 'ping:aalhad'] });
  let r = await t.env.run(['inbox', '-q', '--new-only', '--agent', 'codex']);
  assert.equal(r.out, `1 new: #${n} mailbox\n`);
  assert.ok(fs.existsSync(t.file('aalhad/codex')));
  assert.ok(!fs.existsSync(t.file('aalhad/claude')));
  assert.match(t.file('aalhad/codex'), /inbox-aalhad_codex\.json$/);
  // claude has not surfaced it yet (ping:aalhad is the primary's mailbox)
  r = await t.env.run(['inbox', '-q', '--new-only']);
  assert.equal(r.out, `1 new: #${n} mailbox\n`);
  assert.ok(fs.existsSync(t.file('aalhad/claude')));
  assert.equal((await t.env.run(['inbox', '-q', '--new-only', '--agent', 'codex'])).code, 10);
});

test('without a git dir the state falls back to os.tmpdir()', async () => {
  const t = setup();
  fs.rmSync(path.join(t.env.dir, '.git'), { recursive: true });
  t.f.addIssue({ labels: ['ping:aalhad'] });
  const r = await t.env.run(['inbox', '-q']);
  assert.equal(r.code, 0, r.err);
  const file = cacheFile({ cwd: t.env.dir }, 'aalhad');
  assert.ok(file.startsWith(os.tmpdir()));
  assert.match(file, /inbox-aalhad\.json$/);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).count, 1);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
  assert.equal(cacheFile({ cwd: t.env.dir }, 'aalhad/codex').endsWith('inbox-aalhad_codex.json'), true);
});
