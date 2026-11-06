'use strict';

// Which repo does mesh coordinate in: forks, upstream remote, hub override.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { resolveWorkRepo } = require('../lib/cli/repo');

function clone(remotes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-repo-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  for (const [n, u] of Object.entries(remotes)) execFileSync('git', ['remote', 'add', n, u], { cwd: dir });
  return dir;
}

function ctxFor(dir, sites, now = new Date('2026-11-06T12:00:00Z')) {
  const calls = [];
  return {
    cwd: dir, dryRun: false, now: () => now, calls,
    gh: {
      repoSlug: async () => 'fallback/repo',
      async api(method, p) {
        calls.push(p);
        let m = /^repos\/([^/]+\/[^/]+)\/contents\/\.issuemesh\/team\.json$/.exec(p);
        if (m) { if (sites.teams.includes(m[1])) return { content: 'x' }; const e = new Error('404'); e.status = 404; throw e; }
        m = /^repos\/([^/]+\/[^/]+)$/.exec(p);
        if (m && sites.repos[m[1]]) return sites.repos[m[1]];
        const e = new Error('404'); e.status = 404; throw e;
      },
    },
  };
}

test('a fork clone (origin = my fork) resolves to the parent that has team.json', async () => {
  const dir = clone({ origin: 'https://github.com/me/proj.git' });
  const ctx = ctxFor(dir, { teams: ['team/proj', 'me/proj'], repos: { 'me/proj': { fork: true, parent: { full_name: 'team/proj' } } } });
  assert.equal(await resolveWorkRepo(ctx), 'team/proj');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an upstream remote with team.json wins over origin', async () => {
  const dir = clone({ origin: 'https://github.com/me/proj.git', upstream: 'git@github.com:team/proj.git' });
  const ctx = ctxFor(dir, { teams: ['team/proj'], repos: { 'me/proj': { fork: true, parent: { full_name: 'someone/else' } } } });
  assert.equal(await resolveWorkRepo(ctx), 'team/proj');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a team that works in a fork keeps it (origin has team.json, its parent does not)', async () => {
  const dir = clone({ origin: 'https://github.com/team/diffullama' });
  const ctx = ctxFor(dir, { teams: ['team/diffullama'], repos: { 'team/diffullama': { fork: true, parent: { full_name: 'paper/DiffuLLaMA' } } } });
  assert.equal(await resolveWorkRepo(ctx), 'team/diffullama');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('nothing set up anywhere: origin; result is cached for an hour (no more API calls)', async () => {
  const dir = clone({ origin: 'https://github.com/team/new.git' });
  const ctx = ctxFor(dir, { teams: [], repos: {} });
  assert.equal(await resolveWorkRepo(ctx), 'team/new');
  const n = ctx.calls.length;
  assert.equal(await resolveWorkRepo(ctx), 'team/new');
  assert.equal(ctx.calls.length, n);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('no GitHub remote: asks gh', async () => {
  const dir = clone({});
  assert.equal(await resolveWorkRepo(ctxFor(dir, { teams: [], repos: {} })), 'fallback/repo');
  fs.rmSync(dir, { recursive: true, force: true });
});
