'use strict';

const P = require('../protocol');
const U = require('./util');
const { PreconditionError, UsageError } = U;

const help = `mesh status - edit your claim's status comment (also the heartbeat)

Usage: mesh status <n> [--set "markdown"] [--append "line"]... [--check "item"]...

Edits your claim comment in place (marker kept) and bumps the lease. Applied in
order: --set, --append, --check.

Options:
  --set "markdown"   replace the comment body (plan, progress, links, next step)
  --append "line"    append a line (repeatable)
  --check "item"     tick the first unchecked "- [ ]" line containing item
                     (case-insensitive), or append "- [x] item" (repeatable)

Exit codes: 0 ok; 3 you hold no claim comment on the issue, or it was superseded.`;

/** Locate and validate your own claim comment. */
async function loadMyClaim(ctx, n) {
  const me = await ctx.me();
  const cfg = await ctx.config();
  const comments = await U.getComments(ctx, n);
  const mine = U.findClaimComment(comments, me, cfg);
  if (!mine) throw new PreconditionError(`no active claim comment by ${me.handle} on #${n}`);
  const { winner } = P.arbitrate(comments, U.claimOpts(ctx, cfg));
  if (winner && winner.commentId !== mine.id && !U.claimIsMine(winner, me)) {
    throw new PreconditionError(`your claim on #${n} was superseded by ${winner.agentId} (comment ${winner.commentId})`);
  }
  return { me, cfg, comments, mine };
}

function tick(content, item) {
  const needle = item.toLowerCase();
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*[-*]\s*)\[ \](.*)$/.exec(lines[i]);
    if (m && m[2].toLowerCase().includes(needle)) { lines[i] = `${m[1]}[x]${m[2]}`; return lines.join('\n'); }
  }
  return `${content}${content ? '\n' : ''}- [x] ${item}`;
}

async function heartbeatClaim(ctx, n, edit) {
  const { me, cfg, mine } = await loadMyClaim(ctx, n);
  const lease = P.leaseUntil(ctx.now(), cfg.policy.lease_minutes[ctx.actor]);
  const bumped = P.replaceMarker(mine.body, { lease });
  const parts = U.splitBody(bumped);
  if (edit) parts.content = edit(parts.content);
  await U.editComment(ctx, mine.id, U.joinBody(parts, me.from));
  return { issue: n, comment_id: mine.id, lease };
}

async function run(args, ctx) {
  U.needPositional(args, 1, 1, 'mesh status <n> [--set md] [--append line] [--check item]');
  const n = U.parseNumber(args._[0]);
  const f = args.flags;
  const list = (v) => (v === undefined ? [] : v);
  if (f.set === undefined && !list(f.append).length && !list(f.check).length) {
    throw new UsageError('nothing to do: pass --set, --append or --check (use `mesh heartbeat` to bump the lease only)');
  }
  const res = await heartbeatClaim(ctx, n, (content) => {
    let c = f.set !== undefined ? String(f.set).replace(/\s+$/, '') : content;
    for (const line of list(f.append)) c += `${c ? '\n' : ''}${line}`;
    for (const item of list(f.check)) c = tick(c, item);
    return c;
  });
  ctx.emit(res, `Updated status comment on #${n} (lease until ${res.lease}).`);
  return 0;
}

module.exports = {
  name: 'status',
  summary: 'edit your claim status comment and bump the lease',
  help,
  spec: { string: ['set'], multi: ['append', 'check'] },
  run,
  loadMyClaim,
  heartbeatClaim,
  tick,
};
