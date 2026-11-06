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
