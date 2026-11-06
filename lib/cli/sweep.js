'use strict';

const P = require('../protocol');
const U = require('./util');

const help = `mesh sweep - expire dead claims (same sweep the referee runs)

Usage: mesh sweep [--json]

For each open issue with status:claimed and no live claim: edit the expired
claim comment to type=released reason=expired, unassign the claimant, set
status:ready and restore the to: routing recorded in the claim marker. Issues
with no claim comment at all (e.g. UI assignments) are skipped and reported.

Exit codes: 0 ok.`;

async function sweepIssues(ctx) {
  const cfg = await ctx.config();
  const r = await U.rp(ctx);
  const issues = (await ctx.gh.paginate(`${r}/issues?state=open&labels=${U.enc('status:claimed')}`)).filter((i) => !i.pull_request);
  const result = { released: [], skipped: [] };
  for (const issue of issues) {
    const n = issue.number;
    const comments = await U.getComments(ctx, n);
    const opts = U.claimOpts(ctx, cfg);
    if (P.liveClaims(comments, opts).length) continue;
    const claims = P.extractClaims(comments, opts);
    if (!claims.length) { result.skipped.push({ number: n, reason: 'no claim comment' }); continue; }

    const dead = claims.filter((c) => c.type === 'claim');
    let origTo = null;
    for (const c of dead.sort((a, b) => a.commentId - b.commentId)) {
      if (c.actor === 'human') continue;
      const comment = comments.find((x) => x.id === c.commentId);
      const m = P.parseMarker(comment.body);
      if (m.to) origTo = m.to;
      await U.editComment(ctx, c.commentId, P.replaceMarker(comment.body, { type: 'released', reason: 'expired', lease: null }));
    }
    const assignees = U.assigneeLogins(issue);
    const drop = [...new Set(dead.map((c) => c.login.toLowerCase()))].filter((l) => assignees.some((a) => a.toLowerCase() === l));
    const toRemove = assignees.filter((a) => drop.includes(a.toLowerCase()));
    if (toRemove.length) await U.removeAssignees(ctx, n, toRemove);

    const names = U.labelNames(issue);
    const set = { status: 'ready' };
    if (origTo && !P.parseLabels(names).to) set.to = origTo;
    await U.updateLabels(ctx, n, names, U.applyLabelOps(names, { set }));
    result.released.push({ number: n, unassigned: toRemove, restored_to: set.to || null });
  }
  return result;
}

async function run(args, ctx) {
  U.needPositional(args, 0, 0, 'mesh sweep');
  const res = await sweepIssues(ctx);
  const lines = [`Sweep: ${res.released.length} expired claim(s) released, ${res.skipped.length} skipped.`];
  for (const x of res.released) lines.push(`  #${x.number} -> status:ready${x.restored_to ? ` to:${x.restored_to}` : ''}`);
  for (const x of res.skipped) lines.push(`  #${x.number} skipped (${x.reason})`);
  ctx.emit(res, lines.join('\n'));
  return 0;
}

module.exports = { name: 'sweep', summary: 'release expired claims (no-referee fallback)', help, spec: {}, run, sweepIssues };
