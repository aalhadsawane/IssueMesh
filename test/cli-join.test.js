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
  const r = await env.run(['join'], { login: 'Jarj_LOL' });
  assert.equal(r.code, 0, r.err);
  const m = read(env).members[1];
  assert.deepEqual([m.handle, m.github, m.agents[0].name, m.agents[0].runtime], ['jarj-lol', 'Jarj_LOL', 'claude', 'claude-code']);
  assert.match(r.out, /git switch -c chore\/join-jarj-lol/);
});

test('join: custom handle and several agents; idempotent; handle clash; dry-run', async () => {
  const env = makeEnv({ team: TEAM, user: 'ben-gh' });
  test.after(() => env.cleanup());
  let r = await env.run(['join', '--dry-run', '--handle', 'ben'], { login: 'ben-gh' });
  assert.equal(read(env).members.length, 1);
  r = await env.run(['join', '--handle', 'ben', '--agents', 'claude,codex'], { login: 'ben-gh' });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(read(env).members[1].agents.map((a) => [a.name, a.runtime]), [['claude', 'claude-code'], ['codex', 'codex']]);
  r = await env.run(['join'], { login: 'ben-gh' });
  assert.match(r.out, /Already a member/);
  assert.equal(read(env).members.length, 2);
  r = await env.run(['join', '--handle', 'aalhad'], { login: 'eve-gh' });
  assert.notEqual(r.code, 0);
  assert.match(r.err, /taken/);
  r = await env.run(['join', '--handle', 'eve', '--agents', 'Bad Name'], { login: 'eve-gh' });
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

const asContents = (obj) => ({ content: Buffer.from(JSON.stringify(obj)).toString('base64'), encoding: 'base64' });
const serveContents = (env, obj) => {
  const orig = env.fake.transport;
  env.fake.transport = async (m, p, b) => (m === 'GET' && p === 'repos/o/r/contents/.issuemesh/team.json' ? asContents(obj) : orig(m, p, b));
};

test('a branch without team.json falls back to the default branch copy', async () => {
  const env = makeEnv({ team: TEAM, writeTeam: false });
  test.after(() => env.cleanup());
  let r = await env.run(['whoami', '--json'], { login: 'aalhad-gh' });
  assert.notEqual(r.code, 0); // nothing local, nothing remote
  serveContents(env, TEAM);
  r = await env.run(['whoami', '--json'], { login: 'aalhad-gh' });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json().handle, 'aalhad');
});

test('doctor warns when the checked-out team.json differs from the default branch', async () => {
  const env = makeEnv({ team: TEAM, user: 'aalhad-gh' });
  test.after(() => env.cleanup());
  const newer = { ...TEAM, members: [...TEAM.members, { handle: 'ben', github: 'ben-gh', agents: [{ name: 'claude', runtime: 'claude-code' }] }] };
  serveContents(env, newer);
  let r = await env.run(['doctor', '--json'], { login: 'aalhad-gh' });
  const c = r.json().checks.find((x) => x.name === 'team.json matches the default branch');
  assert.ok(c && !c.ok && !c.required);
  serveContents(env, TEAM);
  r = await env.run(['doctor', '--json'], { login: 'aalhad-gh' });
  assert.ok(!r.json().checks.find((x) => x.name === 'team.json matches the default branch'));
});
