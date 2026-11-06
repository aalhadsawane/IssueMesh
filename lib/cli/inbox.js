'use strict';

const P = require('../protocol');
const { triagerOnDuty } = require('../config');
const { rp, labelNames, assigneeLogins, UsageError } = require('./util');

const help = `mesh inbox - list what needs your agent (PROTOCOL section 6)

Usage: mesh inbox [-q] [--limit N] [--json]

Buckets, in order: mailbox, active, review, routed, triage, market.
Within a bucket: priority (p0 first), then oldest first.

Options:
  -q, --quiet     print only the item count; exit 0 if work, 10 if empty
  --limit N       show at most N items
  --json          {"handle","total","items":[{number,title,url,isPR,bucket,bucketName,reason,labels,...}]}

Exit codes: 0 ok (or work found with -q); 10 empty (only with -q).`;

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

function countClaims(items, login) {
  const l = login.toLowerCase();
  return items.filter((i) => !i.isPR && i.labels.includes('status:claimed') && i.assignees.some((a) => a.toLowerCase() === l)).length;
}

async function computeInbox(ctx) {
  const me = await ctx.me();
  const cfg = await ctx.config();
  const items = await fetchOpenItems(ctx);
  const held = countClaims(items, me.login);
  const ranked = P.classifyInbox(items, { me: me.member, config: cfg, now: ctx.now(), myLiveClaimCount: held });
  return { me, items: ranked, held };
}

async function run(args, ctx) {
  if (args._.length) throw new UsageError('usage: mesh inbox [-q] [--limit N] [--json]');
  const f = args.flags;
  let limit = Infinity;
  if (f.limit !== undefined) {
    limit = Number(f.limit);
    if (!Number.isInteger(limit) || limit < 1) throw new UsageError('--limit must be a positive integer');
  }
  const { me, items } = await computeInbox(ctx);
  const shown = items.slice(0, limit);
  if (f.quiet) {
    ctx.emit({ count: items.length }, String(items.length));
    return items.length ? 0 : 10;
  }
  const human = [];
  if (!items.length) human.push(`Inbox empty for ${me.handle}.`);
  else {
    human.push(`Inbox for ${me.handle}: ${items.length} item(s)${shown.length < items.length ? `, showing ${shown.length}` : ''}`);
    for (const it of shown) {
      human.push(`  ${String(it.bucket)} ${it.bucketName.padEnd(7)} ${it.isPR ? 'PR ' : ''}#${it.number}  ${it.title}`);
      human.push(`      ${it.reason}  ${it.url || ''}`.trimEnd());
    }
  }
  ctx.emit({ handle: me.handle, total: items.length, items: shown }, human.join('\n'));
  return 0;
}

module.exports = {
  name: 'inbox',
  summary: 'list items that need your agent, ranked',
  help,
  spec: { boolean: ['quiet'], string: ['limit'], alias: { q: 'quiet' } },
  run,
  computeInbox,
  fetchOpenItems,
  countClaims,
  toItem,
  triagerOnDuty,
};
