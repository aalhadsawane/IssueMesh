'use strict';

// Which GitHub repo does IssueMesh coordinate in? (PROTOCOL section 1)
//
//   1. --repo, ISSUEMESH_REPO (a "hub" repo that is not the code repo you are standing in)
//   2. otherwise the clone's remotes, fork-aware: contributors who work from their own fork
//      (origin = their fork, upstream = the team repo) still talk to the TEAM repo, because
//      that is where the issues, labels, Board and team.json are. The first candidate that has
//      .issuemesh/team.json on its default branch wins: `upstream` remote, then the parent of a
//      forked origin, then origin itself. A team that works in a fork (origin has team.json and
//      its parent does not) therefore keeps using it.
//
// The answer is cached per clone for an hour.

const fs = require('fs');
const path = require('path');
const gh = require('../gh');
const U = require('./util');

const TTL_MS = 60 * 60 * 1000;
const enc = encodeURIComponent;

async function hasTeamJson(ctx, slug) {
  try {
    const f = await ctx.gh.api('GET', `repos/${slug}/contents/.issuemesh/team.json`);
    return !!(f && typeof f.content === 'string');
  } catch (e) { return false; }
}

async function resolveWorkRepo(ctx) {
  const origin = gh.remoteSlug(ctx.cwd, 'origin');
  const upstream = gh.remoteSlug(ctx.cwd, 'upstream');
  if (!origin && !upstream) return ctx.gh.repoSlug(ctx.cwd); // not a clone with a GitHub remote: ask gh
  const key = `${upstream || ''}|${origin || ''}`;
  const file = path.join(U.cacheDir(ctx), 'repo.json');
  const now = ctx.now().getTime();
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (c && c.key === key && c.repo && now - c.at >= 0 && now - c.at < TTL_MS) return c.repo;
  } catch (e) { /* no cache */ }

  const candidates = [];
  if (upstream) candidates.push(upstream);
  if (origin) {
    try {
      const info = await ctx.gh.api('GET', `repos/${origin}`);
      if (info && info.fork && info.parent && info.parent.full_name) candidates.push(info.parent.full_name);
    } catch (e) { /* offline or no access: origin alone */ }
    candidates.push(origin);
  }
  const uniq = [...new Set(candidates)];
  let pick = origin || upstream;
  for (const c of uniq) if (await hasTeamJson(ctx, c)) { pick = c; break; }

  if (!ctx.dryRun) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ key, repo: pick, at: now }));
    } catch (e) { /* cache is optional */ }
  }
  return pick;
}

module.exports = { resolveWorkRepo, hasTeamJson, enc };
