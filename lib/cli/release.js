'use strict';

const P = require('../protocol');
const U = require('./util');
const { PreconditionError, UsageError } = U;
const { agentsOf } = require('../config');

const STATUSES = ['ready', 'blocked', 'needs-human', 'review'];

const help = `mesh release - give up your claim (PROTOCOL section 4.4)

Usage: mesh release <n> [--to-status ready|blocked|needs-human|review] [--reason r]

Edits your claim comment to type=released (content stays so the next claimant
can resume), unassigns you and sets the status (default ready). A claim held by
another agent of your member is not yours to release (exit 3). When going to
ready or blocked the originally recorded to: routing is restored.

Options:
  --to-status S   ready (default), blocked, needs-human or review
  --reason r      recorded as reason= in the marker (default "released")

Exit codes: 0 ok; 3 you hold no claim on the issue.`;

/**
 * Shared by release and handoff. Returns { origTo, hadClaim }.
 * opts: { toStatus, reason, labelSet, labelAdd, restoreTo, requireClaim }
 */
async function releaseClaim(ctx, n, opts = {}) {
  const { toStatus = 'ready', reason = 'released', labelSet = {}, labelAdd = [], restoreTo = true, requireClaim = true } = opts;
  const me = await ctx.me();
  const issue = await U.getIssue(ctx, n);
  const cfg = await ctx.config();
  const comments = await U.getComments(ctx, n);
  const mine = U.findClaimComment(comments, me, cfg);
  const assignedToMember = U.assigneeLogins(issue).some((a) => a.toLowerCase() === me.login.toLowerCase());
  // the assignee is the member's login: with several agents, a sibling's claim is not mine to release
  const siblingHolds = !mine && assignedToMember && agentsOf(me.member).length > 1
    && P.liveClaims(comments, U.claimOpts(ctx, cfg)).some((c) => c.handle === me.handle && !U.claimIsMine(c, me));
  const assigned = assignedToMember && !siblingHolds;
  if (!mine && !assigned && requireClaim) throw new PreconditionError(`you hold no claim on #${n}${siblingHolds ? ' (another agent of your member holds it)' : ''}`);

  let origTo = null;
  if (mine) {
    origTo = P.parseMarker(mine.body).to || null;
    const parts = U.splitBody(P.replaceMarker(mine.body, { type: 'released', reason: U.sanitizeValue(reason), lease: null }));
    parts.content += `\n\n**Released** (${reason}).`;
    await U.editComment(ctx, mine.id, U.joinBody(parts, me.from));
  }
  if (assigned) await U.removeAssignees(ctx, n, [me.login]);

  const names = U.labelNames(issue);
  const L = P.parseLabels(names);
  const set = { status: toStatus, ...labelSet };
  if (restoreTo && origTo && !('to' in labelSet) && !L.to && (toStatus === 'ready' || toStatus === 'blocked')) set.to = origTo;
  await U.updateLabels(ctx, n, names, U.applyLabelOps(names, { set, add: labelAdd }));
  return { origTo, hadClaim: !!mine };
}

async function run(args, ctx) {
  U.needPositional(args, 1, 1, 'mesh release <n> [--to-status S] [--reason r]');
  const n = U.parseNumber(args._[0]);
  const toStatus = args.flags['to-status'] || 'ready';
  if (!STATUSES.includes(toStatus)) throw new UsageError(`--to-status must be one of ${STATUSES.join(', ')}`);
  const reason = args.flags.reason || 'released';
  await releaseClaim(ctx, n, { toStatus, reason });
  ctx.emit({ issue: n, released: true, status: toStatus }, `Released #${n} (status:${toStatus}).`);
  return 0;
}

module.exports = { name: 'release', summary: 'release your claim and set the next status', help, spec: { string: ['to-status', 'reason'] }, run, releaseClaim };
