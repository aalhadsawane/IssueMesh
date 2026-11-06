'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const P = require('../protocol');
const { triagerOnDuty, agentsOf } = require('../config');
const U = require('./util');
const { rp, labelNames, assigneeLogins, UsageError } = U;

const help = `mesh inbox - list what needs your agent (PROTOCOL section 6)

Usage: mesh inbox [-q] [--limit N] [--min-interval SEC] [--new-only] [--agent <name>] [--json]

Buckets, in order: mailbox, active, review, routed, triage, market.
Within a bucket: priority (p0 first), then oldest first.
The inbox is for one agent: --agent <name> / --as <handle>/<agent> / ISSUEMESH_AGENT,
default the member's primary agent. Mailbox: ping:<handle>/<agent> is yours;
ping:<handle> is the primary agent's only. Work routed with to:<handle> may be
claimed by any agent of the member; to:<handle>/<agent> by that agent only.
Triage duty goes to the primary agent. WIP is the agent's own wip.

Options:
  -q, --quiet         print only the item count; exit 0 if work, 10 if empty.
                      Conditional-request gate: one cheap probe of the repo's newest
                      updated issue with If-None-Match; on 304 with a cached empty
                      inbox (younger than 10 minutes, same triage-duty day) exit 10
                      without listing anything. The state is kept in
                      .git/issuemesh/inbox-<agent id, / as _>.json (os.tmpdir() outside git).
  --min-interval SEC  if the last check was less than SEC seconds ago, answer from the
                      cache with zero API calls (also works with -q and --new-only)
                      Your own mesh commands that mutate GitHub (claim, release, ack, ...)
                      reset the cached timestamps, so you never read a stale result.
  --new-only          with -q: exit 0 only if the inbox holds an item (number@updatedAt)
                      not surfaced by an earlier --new-only call; print ONE line
                      ("2 new: #12 mailbox, #15 review"). Exit 10 otherwise.
  --limit N           show at most N items
  --json              {"handle","agent","agent_id","total","items":[{number,title,url,isPR,bucket,bucketName,reason,labels,...}]}
                      (--new-only --json: {"count","new":[...],"summary"})

Exit codes: 0 ok (or work found with -q); 10 empty / nothing new (only with -q).`;

const GATE_MAX_AGE_MS = 10 * 60 * 1000;
const IDENTITY_MAX_AGE_MS = 3600 * 1000;
const SURFACED_CAP = 500;
const CACHE_ITEMS_CAP = 200;

function toItem(i) {
  return {
    number: i.number,
    title: i.title,
    labels: labelNames(i),
    assignees: assigneeLogins(i),
    isPR: !!i.pull_request,
    createdAt: i.created_at,
    updatedAt: i.updated_at,
    url: i.html_url,
  };
}

/** Open items (one paginated list call per 100 issues/PRs). */
async function fetchOpenItems(ctx) {
  const raw = await ctx.gh.paginate(`${await rp(ctx)}/issues?state=open&sort=created&direction=asc`);
  return raw.map(toItem);
}

/** Open claimed issues assigned to this login (member level; ignores which agent claimed). */
function countClaims(items, login) {
  const l = login.toLowerCase();
  return items.filter((i) => !i.isPR && i.labels.includes('status:claimed') && i.assignees.some((a) => a.toLowerCase() === l)).length;
}

/**
 * Live claims held by this agent. The assignee is the member's login, so for a
 * member with one agent that is `countClaims`; with several agents the claim
 * comments decide which agent holds each assigned issue.
 * @param {object[]} items inbox-shaped items (toItem)
 */
async function countAgentClaims(ctx, me, items) {
  const l = me.login.toLowerCase();
  const assigned = items.filter((i) => !i.isPR && i.labels.includes('status:claimed') && i.assignees.some((a) => a.toLowerCase() === l));
  if (agentsOf(me.member).length <= 1) return assigned.length;
  const cfg = await ctx.config();
  let held = 0;
  for (const i of assigned) {
    const live = P.liveClaims(await U.getComments(ctx, i.number), U.claimOpts(ctx, cfg));
    if (live.some((c) => c.actor !== 'human' && c.handle === me.handle && U.fromIsMe(c.agentId, me))) held++;
  }
  return held;
}

async function computeInbox(ctx, knownMe) {
  const me = knownMe || (await ctx.me());
  const cfg = await ctx.config();
  const items = await fetchOpenItems(ctx);
  const held = await countAgentClaims(ctx, me, items);
  let ranked = P.classifyInbox(items, { me: me.member, config: cfg, now: ctx.now(), myLiveClaimCount: held, agent: me.agentName || undefined });
  if (agentsOf(me.member).length > 1) {
    // the active bucket is keyed by the shared assignee: drop issues a sibling agent holds
    const keep = [];
    for (const it of ranked) {
      if (it.bucketName === 'active') {
        const live = P.liveClaims(await U.getComments(ctx, it.number), U.claimOpts(ctx, cfg)).filter((c) => c.handle === me.handle);
        if (live.length && !live.some((c) => U.claimIsMine(c, me))) continue;
      }
      keep.push(it);
    }
    ranked = keep;
  }
  return { me, items: ranked, held };
}

/* ------------------------------------------------------- cache (fast path) */

const cacheDir = (ctx) => U.cacheDir(ctx);

const cacheFile = (ctx, agentId) => path.join(cacheDir(ctx), `inbox-${String(agentId).replace(/\//g, '_')}.json`);

/** Parsed JSON object, or null when missing, corrupt or not a plain object (a hand-edited cache must not crash the hook). */
function readJson(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch (_) { return null; }
}

function writeJson(ctx, file, data) {
  if (ctx.dryRun) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  } catch (_) { /* a cache that cannot be written only costs requests */ }
}

/**
 * Forget what the inbox caches know about "when we last looked": called after a
 * command that mutates GitHub (claim, release, ack, ...), so that `--min-interval`
 * cannot answer with a result from before your own change and the next gate probe
 * runs for real. Every agent's cache in this checkout is reset (a sibling agent's
 * claim changes your inbox too). The surfaced set is kept, so nothing is re-announced.
 */
function invalidateCache(ctx) {
  if (ctx.dryRun) return;
  try {
    const dir = cacheDir(ctx);
    for (const name of fs.readdirSync(dir)) {
      if (!/^inbox-.*\.json$/.test(name)) continue;
      const file = path.join(dir, name);
      const c = readJson(file);
      if (!c) continue;
      c.etag = null;
      c.checkedAt = new Date(0).toISOString();
      delete c.probedAt;
      writeJson(ctx, file, c);
    }
  } catch (_) { /* no cache dir: nothing to invalidate */ }
}

/**
 * Who am I, answered from the local identity cache (no API call); null when
 * unknown or stale. Also seeds the repo slug so no `gh repo view` is needed.
 */
async function peekMe(ctx) {
  const idc = readJson(path.join(cacheDir(ctx), 'identity.json'));
  const fresh = idc && ctx.now().getTime() - Date.parse(idc.at) < IDENTITY_MAX_AGE_MS;
  if (fresh && idc.repo) ctx.repoHint = idc.repo;
  if (ctx.opts.as) return ctx.me();
  if (!fresh || !idc.login) return null;
  try { return await ctx.resolveMe(idc.login); } catch (_) { return null; }
}

async function rememberIdentity(ctx) {
  try {
    writeJson(ctx, path.join(cacheDir(ctx), 'identity.json'), {
      ...(ctx.opts.as ? {} : { login: await ctx.login() }),
      repo: await ctx.repo(),
      at: ctx.now().toISOString(),
    });
  } catch (_) { /* best effort */ }
}

const dutyKey = (cfg, now) => `${triagerOnDuty(cfg, now) || '-'}@${now.toISOString().slice(0, 10)}`;
const itemKey = (i) => `${i.number}@${i.updatedAt}`;

function trimItem(i) {
  return { number: i.number, title: i.title, labels: i.labels, assignees: i.assignees, isPR: i.isPR, createdAt: i.createdAt, updatedAt: i.updatedAt, url: i.url, bucket: i.bucket, bucketName: i.bucketName, reason: i.reason };
}

function summarize(fresh) {
  return `${fresh.length} new: ${fresh.map((i) => `#${i.number} ${i.bucketName}`).join(', ')}`;
}

async function run(args, ctx) {
  if (args._.length) throw new UsageError('usage: mesh inbox [-q] [--limit N] [--min-interval SEC] [--new-only] [--json]');
  const f = args.flags;
  let limit = Infinity;
  if (f.limit !== undefined) {
    limit = Number(f.limit);
    if (!Number.isInteger(limit) || limit < 1) throw new UsageError('--limit must be a positive integer');
  }
  let minInterval = null;
  if (f['min-interval'] !== undefined) {
    minInterval = Number(f['min-interval']);
    if (!(minInterval >= 0)) throw new UsageError('--min-interval must be a number of seconds >= 0');
  }
  if (f['new-only'] && !f.quiet) throw new UsageError('--new-only requires -q');

  const cached = f.quiet || minInterval !== null;
  const now = ctx.now();
  const nowMs = now.getTime();
  let me = null;
  let peeked = false;
  let cache = null;
  let probeEtag = null;
  let result = null; // { handle, agent, agent_id, items }

  if (cached) {
    me = await peekMe(ctx);
    peeked = !!me && !ctx.opts.as;
    if (!me) me = await ctx.me();
    cache = readJson(cacheFile(ctx, me.agentId));
    // the cache belongs to one repository (a checkout can be used with --repo for another one)
    if (cache && cache.repo !== undefined && cache.repo !== (await ctx.repo())) cache = null;
    if (cache && !Array.isArray(cache.surfaced)) cache.surfaced = [];
    const lastCheck = cache ? Math.max(Date.parse(cache.checkedAt) || 0, Date.parse(cache.probedAt) || 0) : 0;

    // 1. --min-interval: answer from the cache, zero API calls
    if (cache && minInterval !== null && Array.isArray(cache.items) && lastCheck <= nowMs && nowMs - lastCheck < minInterval * 1000) {
      result = { handle: me.handle, agent: me.agentName, agent_id: me.agentId, items: cache.items };
    }

    // 2. -q: ETag gate. One conditional probe; 304 + empty + fresh + same duty day => nothing to do.
    if (!result && f.quiet) {
      try {
        const cfg = await ctx.config();
        const probe = await ctx.gh.conditional(`${await rp(ctx)}/issues?state=open&sort=updated&direction=desc&per_page=1`, cache && cache.etag);
        probeEtag = probe.etag || null;
        const age = nowMs - Date.parse(cache && cache.checkedAt); // NaN (corrupt) and negative (clock moved back) both fail
        if (probe.status === 304 && cache && cache.count === 0 && age >= 0 && age < GATE_MAX_AGE_MS && cache.dutyKey === dutyKey(cfg, now)) {
          cache.probedAt = now.toISOString();
          writeJson(ctx, cacheFile(ctx, me.agentId), cache);
          if (!peeked) await rememberIdentity(ctx);
          if (!f['new-only']) ctx.emit({ count: 0 }, '0');
          return 10;
        }
      } catch (_) { probeEtag = null; /* the gate is an optimization: fall through to the full run */ }
    }
  }

  // 3. full run
  if (!result) {
    const full = await computeInbox(ctx, cached ? me : undefined);
    me = full.me;
    result = { handle: me.handle, agent: me.agentName, agent_id: me.agentId, items: full.items };
    if (cached) {
      const cfg = await ctx.config();
      cache = {
        repo: await ctx.repo(),
        etag: probeEtag, // taken from the probe made BEFORE the full run
        count: full.items.length,
        checkedAt: now.toISOString(),
        dutyKey: dutyKey(cfg, now),
        surfaced: (cache && cache.surfaced) || [],
        items: full.items.slice(0, CACHE_ITEMS_CAP).map(trimItem),
      };
      writeJson(ctx, cacheFile(ctx, me.agentId), cache);
      if (!peeked) await rememberIdentity(ctx);
    }
  }
  const items = result.items;

  if (f['new-only']) {
    const seen = new Set(cache ? cache.surfaced : []);
    const fresh = items.filter((i) => !seen.has(itemKey(i)));
    if (!fresh.length) return 10;
    if (cache) {
      cache.surfaced = [...cache.surfaced, ...fresh.map(itemKey)].slice(-SURFACED_CAP);
      writeJson(ctx, cacheFile(ctx, me.agentId), cache);
    }
    const summary = summarize(fresh);
    ctx.emit({ count: items.length, new: fresh.map(trimItem), summary }, summary);
    return 0;
  }

  const shown = items.slice(0, limit);
  if (f.quiet) {
    ctx.emit({ count: items.length }, String(items.length));
    return items.length ? 0 : 10;
  }
  const human = [];
  if (!items.length) human.push(`Inbox empty for ${result.agent_id}.`);
  else {
    human.push(`Inbox for ${result.agent_id}: ${items.length} item(s)${shown.length < items.length ? `, showing ${shown.length}` : ''}`);
    for (const it of shown) {
      human.push(`  ${String(it.bucket)} ${it.bucketName.padEnd(7)} ${it.isPR ? 'PR ' : ''}#${it.number}  ${it.title}`);
      human.push(`      ${it.reason}  ${it.url || ''}`.trimEnd());
    }
  }
  ctx.emit({ handle: result.handle, agent: result.agent, agent_id: result.agent_id, total: items.length, items: shown }, human.join('\n'));
  return 0;
}

module.exports = {
  name: 'inbox',
  summary: 'list items that need your agent, ranked',
  help,
  spec: { boolean: ['quiet', 'new-only'], string: ['limit', 'min-interval'], alias: { q: 'quiet' } },
  run,
  computeInbox,
  fetchOpenItems,
  countClaims,
  countAgentClaims,
  toItem,
  triagerOnDuty,
  cacheFile,
  invalidateCache,
};
