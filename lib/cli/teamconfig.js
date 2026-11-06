'use strict';

// Where `mesh` gets team.json from (PROTOCOL section 1).
//
//   The default branch on GitHub is the single source of truth, so a feature branch (or a stale
//   copy on one) can never change who is on the team. The answer is cached per clone in
//   .git/issuemesh/ and revalidated with a conditional request (a 304 is free), at most every
//   CONFIG_TTL_MS. A local file is used only when the default branch has none (the setup PR is
//   not merged yet), when GitHub cannot be reached, or when ISSUEMESH_CONFIG=local is set.

const fs = require('fs');
const path = require('path');
const config = require('../config');
const U = require('./util');

const CONFIG_TTL_MS = 5 * 60 * 1000;
const MISSING_TTL_MS = 30 * 1000; // "not on the default branch yet" is rechecked quickly: the setup PR may just have merged
const REMOTE_PATH = '.issuemesh/team.json';

function cacheFile(ctx, repo) {
  return path.join(U.cacheDir(ctx), `team-${String(repo).replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
}

function readCache(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch (e) { return null; }
}

function writeCache(ctx, file, obj) {
  if (ctx.dryRun) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, file);
  } catch (e) { /* a cache that cannot be written only costs one more request */ }
}

function decode(file) {
  if (!file || typeof file.content !== 'string') return null;
  try {
    const raw = JSON.parse(Buffer.from(file.content, file.encoding || 'base64').toString('utf8'));
    return config.validateConfig(raw).ok ? raw : null;
  } catch (e) { return null; }
}

/**
 * team.json (raw) as committed on the default branch, or null when the default branch has none
 * (or it is invalid). Cached; falls back to a stale cache when GitHub is unreachable.
 */
async function fetchDefaultBranchConfig(ctx, { fresh = false } = {}) {
  const repo = await ctx.repo();
  const file = cacheFile(ctx, repo);
  const cached = readCache(file);
  const now = ctx.now().getTime();
  if (!fresh && cached && cached.repo === repo && now - cached.checkedAt >= 0 && now - cached.checkedAt < (cached.missing ? MISSING_TTL_MS : CONFIG_TTL_MS)) {
    return cached.missing ? null : cached.raw;
  }
  const url = `repos/${repo}/contents/${REMOTE_PATH}`;
  try {
    const res = ctx.gh.conditional
      ? await ctx.gh.conditional(url, cached && cached.repo === repo ? cached.etag : undefined)
      : { status: 200, etag: undefined, data: await ctx.gh.api('GET', url) };
    if (res.status === 304 && cached && cached.raw) {
      writeCache(ctx, file, { ...cached, checkedAt: now });
      return cached.raw;
    }
    const raw = decode(res.data);
    writeCache(ctx, file, raw ? { repo, etag: res.etag, raw, checkedAt: now } : { repo, missing: true, checkedAt: now });
    return raw;
  } catch (e) {
    if (e && e.status === 404) { writeCache(ctx, file, { repo, missing: true, checkedAt: now }); return null; }
    return cached && cached.raw && cached.repo === repo ? cached.raw : null; // offline: last known good
  }
}

/**
 * Resolve the team config for this run.
 * @returns {Promise<{config: object, source: 'default-branch'|'local', raw: object}>}
 */
async function resolveTeamConfig(ctx) {
  const localPath = config.findConfigPath(ctx.cwd);
  const forceLocal = ctx.env.ISSUEMESH_CONFIG === 'local';
  if (!forceLocal) {
    let remote = null;
    try { remote = await fetchDefaultBranchConfig(ctx); } catch (e) { remote = null; }
    if (remote) return { config: config.normalizeConfig(remote), source: 'default-branch', raw: remote };
  }
  if (localPath) return { config: config.loadConfig(ctx.cwd), source: 'local', raw: JSON.parse(fs.readFileSync(localPath, 'utf8')) };
  return null;
}

module.exports = { CONFIG_TTL_MS, REMOTE_PATH, fetchDefaultBranchConfig, resolveTeamConfig };
