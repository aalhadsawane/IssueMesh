'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { makeEnv } = require('./cli-helpers');

const TEAM = { version: 1, members: [{ handle: 'aalhad', github: 'aalhad-gh', agents: [{ name: 'claude', runtime: 'claude-code' }] }], board_issue: null };
const read = (env) => JSON.parse(fs.readFileSync(path.join(env.dir, '.issuemesh', 'team.json'), 'utf8'));

test('join: appends the caller with default agent, derived handle, valid config', async () => {
  const env = makeEnv({ team: TEAM, user: 'Jarj_LOL' });
  test.after(() => env.cleanup());
  const r = await env.run(['join', '--local'], { login: 'Jarj_LOL' });
  assert.equal(r.code, 0, r.err);
  const m = read(env).members[1];
  assert.deepEqual([m.handle, m.github, m.agents[0].name, m.agents[0].runtime], ['jarj-lol', 'Jarj_LOL', 'claude', 'claude-code']);
  assert.match(r.out, /git switch -c chore\/join-jarj-lol/);
});

test('join: custom handle and several agents; idempotent; handle clash; dry-run', async () => {
  const env = makeEnv({ team: TEAM, user: 'ben-gh' });
  test.after(() => env.cleanup());
  let r = await env.run(['join', '--local', '--dry-run', '--handle', 'ben'], { login: 'ben-gh' });
  assert.equal(read(env).members.length, 1);
  r = await env.run(['join', '--local', '--handle', 'ben', '--agents', 'claude,codex'], { login: 'ben-gh' });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(read(env).members[1].agents.map((a) => [a.name, a.runtime]), [['claude', 'claude-code'], ['codex', 'codex']]);
  r = await env.run(['join', '--local'], { login: 'ben-gh' });
  assert.match(r.out, /Already a member/);
  assert.equal(read(env).members.length, 2);
  r = await env.run(['join', '--local', '--handle', 'aalhad'], { login: 'eve-gh' });
  assert.notEqual(r.code, 0);
  assert.match(r.err, /taken/);
  r = await env.run(['join', '--local', '--handle', 'eve', '--agents', 'Bad Name'], { login: 'eve-gh' });
  assert.equal(r.code, 2);
});

test('doctor: fails clearly when Issues are disabled on the repo (forks)', async () => {
  const env = makeEnv({ team: TEAM, user: 'aalhad-gh' });
  test.after(() => env.cleanup());
  const orig = env.fake.transport;
  env.fake.transport = async (method, p, body) => (method === 'GET' && p === 'repos/o/r' ? { has_issues: false } : orig(method, p, body));
  const r = await env.run(['doctor', '--json'], { login: 'aalhad-gh' });
  const c = r.json().checks.find((x) => x.name === 'GitHub Issues enabled');
  assert.ok(c && !c.ok);
  assert.match(c.detail, /Settings > General/);
  assert.equal(r.code, 1);
});

test('init: keeps a customized IssueMesh block and skips a CLAUDE.md that imports AGENTS.md', async () => {
  const env = makeEnv({ team: TEAM });
  test.after(() => env.cleanup());
  const agents = path.join(env.dir, 'AGENTS.md');
  const claude = path.join(env.dir, 'CLAUDE.md');
  const pointer = '# Agents\n\n<!-- issuemesh:begin -->\nSee docs/issuemesh.md\n<!-- issuemesh:end -->\n';
  fs.writeFileSync(agents, pointer);
  fs.writeFileSync(claude, '@AGENTS.md\n\n## Claude only\n');
  let r = await env.run(['init', '--templates']);
  assert.equal(r.code, 0, r.err);
  assert.equal(fs.readFileSync(agents, 'utf8'), pointer);
  assert.equal(fs.readFileSync(claude, 'utf8'), '@AGENTS.md\n\n## Claude only\n');
  r = await env.run(['init', '--templates', '--force']);
  assert.notEqual(fs.readFileSync(agents, 'utf8'), pointer); // --force replaces the block
  assert.equal(fs.readFileSync(claude, 'utf8'), '@AGENTS.md\n\n## Claude only\n'); // still skipped
});

const asContents = (obj) => ({ content: Buffer.from(JSON.stringify(obj)).toString('base64'), encoding: 'base64', sha: 'filesha' });
const serveContents = (env, obj) => {
  const orig = env.fake.transport;
  env.fake.transport = async (m, p, b) => (m === 'GET' && p.startsWith('repos/o/r/contents/.issuemesh/team.json') ? asContents(obj) : orig(m, p, b));
};
const withBen = (team) => ({ ...team, members: [...team.members, { handle: 'ben', github: 'ben-gh', agents: [{ name: 'claude', runtime: 'claude-code' }] }] });

test('config source: a branch without team.json uses the default branch copy', async () => {
  const env = makeEnv({ team: TEAM, writeTeam: false });
  test.after(() => env.cleanup());
  let r = await env.run(['whoami', '--json'], { login: 'aalhad-gh' });
  assert.notEqual(r.code, 0); // nothing local, nothing on the default branch
  serveContents(env, TEAM);
  env.clock.t += 60 * 1000; // a missing copy is rechecked after 30 s (the setup PR may just have merged)
  r = await env.run(['whoami', '--json'], { login: 'aalhad-gh' });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json().handle, 'aalhad');
});

test('config source: the default branch wins over a stale local copy; ISSUEMESH_CONFIG=local opts out', async () => {
  const env = makeEnv({ team: TEAM, user: 'ben-gh' }); // stale local copy: ben is not a member
  test.after(() => env.cleanup());
  serveContents(env, withBen(TEAM));
  let r = await env.run(['whoami', '--json'], { login: 'ben-gh' });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json().handle, 'ben');
  r = await env.run(['whoami', '--json'], { login: 'ben-gh', env: { ISSUEMESH_CONFIG: 'local' } });
  assert.notEqual(r.code, 0); // local says ben is nobody
});

test('config source: cached for a few minutes, revalidated with the etag, stale cache survives an outage', async () => {
  const env = makeEnv({ team: TEAM, writeTeam: false });
  test.after(() => env.cleanup());
  serveContents(env, TEAM);
  await env.run(['whoami', '--json'], { login: 'aalhad-gh' });
  const n = () => (env.fake.contentsLog || []).length;
  const after1 = n();
  await env.run(['whoami', '--json'], { login: 'aalhad-gh' });
  assert.equal(n(), after1, 'fresh cache: no lookup');
  env.clock.t += 6 * 60 * 1000;
  await env.run(['whoami', '--json'], { login: 'aalhad-gh' });
  assert.equal(n(), after1 + 1, 'expired: one conditional lookup');
  assert.equal(env.fake.contentsLog[env.fake.contentsLog.length - 1].etag !== undefined, true, 'sent the stored etag');
  env.clock.t += 6 * 60 * 1000;
  env.fake.transport = async (m, p) => { if (/\/contents\//.test(p)) throw new Error('offline'); return {}; };
  const r = await env.run(['whoami', '--json'], { login: 'aalhad-gh' });
  assert.notEqual(r.json && r.out.includes('"handle"') ? 0 : 1, 1, 'last known good config is used while offline');
});

test('doctor: says where team.json came from and warns about a differing local copy', async () => {
  const env = makeEnv({ team: TEAM, user: 'aalhad-gh' });
  test.after(() => env.cleanup());
  serveContents(env, withBen(TEAM));
  let r = await env.run(['doctor', '--json'], { login: 'aalhad-gh' });
  let checks = r.json().checks;
  assert.match(checks.find((x) => x.name === 'team.json source').detail, /default branch/);
  const drift = checks.find((x) => x.name === 'local team.json ignored');
  assert.ok(drift && !drift.ok && !drift.required);
  serveContents(env, TEAM);
  env.clock.t += 6 * 60 * 1000; // past the cache lifetime
  r = await env.run(['doctor', '--json'], { login: 'aalhad-gh' });
  assert.ok(!r.json().checks.find((x) => x.name === 'local team.json ignored'));
});


function apiRepo(env, team, { push = true } = {}) {
  const calls = [];
  const orig = env.fake.transport;
  env.fake.transport = async (m, p, b) => {
    if (p === 'repos/o/r') return { default_branch: 'main' };
    if (m === 'GET' && p.startsWith('repos/o/r/contents/.issuemesh/team.json')) return asContents(team);
    if (m === 'GET' && p === 'repos/o/r/git/ref/heads/main') return { object: { sha: 'basesha' } };
    if (m === 'POST' && p === 'repos/o/r/git/refs') {
      calls.push([m, p, b]);
      if (!push) { const e = new Error('forbidden'); e.status = 403; throw e; }
      if (b.ref === 'refs/heads/chore/join-ben' && !apiRepo.taken) { apiRepo.taken = true; const e = new Error('exists'); e.status = 422; throw e; }
      return {};
    }
    if (m === 'PUT' && p === 'repos/o/r/contents/.issuemesh/team.json') { calls.push([m, p, b]); return {}; }
    if (m === 'POST' && p === 'repos/o/r/pulls') { calls.push([m, p, b]); return { html_url: 'https://github.com/o/r/pull/9' }; }
    return orig(m, p, b);
  };
  return calls;
}

test('join (default): commits to a new branch off the default branch and opens a PR; the checkout is untouched', async () => {
  const env = makeEnv({ team: TEAM, writeTeam: false });
  test.after(() => env.cleanup());
  apiRepo.taken = false;
  const calls = apiRepo(env, TEAM);
  const r = await env.run(['join', '--handle', 'ben'], { login: 'ben-gh' });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /pull\/9/);
  const refs = calls.filter(([, p]) => p.endsWith('/git/refs')).map(([, , b]) => [b.ref, b.sha]);
  assert.deepEqual(refs, [['refs/heads/chore/join-ben', 'basesha'], ['refs/heads/chore/join-ben-2', 'basesha']], 'taken branch name gets a suffix, branched from the default branch tip');
  const put = calls.find(([m]) => m === 'PUT')[2];
  assert.equal(put.branch, 'chore/join-ben-2');
  assert.equal(put.sha, 'filesha');
  const written = JSON.parse(Buffer.from(put.content, 'base64').toString());
  assert.deepEqual(written.members.map((m) => m.handle), ['aalhad', 'ben']);
  const pr = calls.find(([, p]) => p.endsWith('/pulls'))[2];
  assert.equal(pr.base, 'main');
  assert.equal(pr.head, 'chore/join-ben-2');
  assert.ok(!fs.existsSync(path.join(env.dir, '.issuemesh')), 'no file written in the working tree');
});

test('join (default): already a member is a no-op; dry-run changes nothing; no push access is explained', async () => {
  const env = makeEnv({ team: TEAM, writeTeam: false });
  test.after(() => env.cleanup());
  let calls = apiRepo(env, TEAM);
  let r = await env.run(['join'], { login: 'aalhad-gh' });
  assert.match(r.out, /Already a member/);
  assert.equal(calls.length, 0);
  r = await env.run(['join', '--dry-run', '--handle', 'ben'], { login: 'ben-gh' });
  assert.match(r.out, /Would open a PR/);
  assert.equal(calls.length, 0);
  calls = apiRepo(env, TEAM, { push: false });
  r = await env.run(['join', '--handle', 'ben'], { login: 'ben-gh' });
  assert.notEqual(r.code, 0);
  assert.match(r.err, /write access/);
});
