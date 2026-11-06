'use strict';

const P = require('../protocol');
const { memberByLogin, triagerOnDuty } = require('../config');
const U = require('./util');
const { PreconditionError, UsageError } = U;
const { countClaims, fetchOpenItems } = require('./inbox');

const help = `mesh claim - claim an issue (PROTOCOL section 4.1-4.2)

Usage: mesh claim <n> [--plan "text"] [--steal] [--settle SECONDS]

Preconditions (exit 3 with reasons if any fail): issue open and not a PR;
status:ready (or status:triage and you are triager on duty); no live claim by
someone else (a live human claim is never overridden); to: is you, any or
absent; not human-only (agents); fewer than wip live claims (agents).

Steps: post the claim comment with a lease (records the original routing as
to=<value> so a sweep can restore it), assign you, set status:claimed (removes
status:ready/triage and to:any), wait the settle time, re-read comments and
arbitrate (lowest comment id among live claims wins). If you lose, the claim
comment is released (reason=lost-race), you are unassigned and the exit code is 3.

Options:
  --plan "text"      plan shown in the claim/status comment
  --steal            take over an issue with status:claimed but no live claim
                     (expired lease or UI assignment); posts a takeover note
  --settle SECONDS   override policy.claim_settle_seconds (0 = no wait)

Exit codes: 0 claimed; 3 precondition failed or lost the race.`;

async function run(args, ctx) {
  U.needPositional(args, 1, 1, 'mesh claim <n> [--plan "text"] [--steal] [--settle SECONDS]');
  const n = U.parseNumber(args._[0]);
  const f = args.flags;
  const me = await ctx.me();
  const cfg = await ctx.config();
  const now = ctx.now();
  const agent = ctx.actor === 'agent';

  const issue = await U.getIssue(ctx, n);
  const comments = await U.getComments(ctx, n);
  const names = U.labelNames(issue);
  const L = P.parseLabels(names);
  const opts = U.claimOpts(ctx, cfg);
  const live = P.liveClaims(comments, opts);
  const mine = live.find((c) => c.handle === me.handle);
  const others = live.filter((c) => c.handle !== me.handle);

  if (mine && !others.length && issue.state === 'open') {
    ctx.emit({ issue: n, claimed: true, already: true, comment_id: mine.commentId }, `#${n} is already claimed by ${me.handle}.`);
    return 0;
  }

  const reasons = [];
  if (issue.pull_request) reasons.push(`#${n} is a pull request, not a work item`);
  if (issue.state !== 'open') reasons.push('issue is closed');
  if (agent && me.member.agent.enabled === false) reasons.push(`agent is disabled for ${me.handle} in team.json`);
  if (agent && L.humanOnly) reasons.push('labelled human-only: agents must not claim it');
  for (const c of others) {
    const until = c.lease ? c.lease.toISOString().replace(/\.\d{3}Z$/, 'Z') : 'unknown';
    reasons.push(`already claimed by ${c.handle} (${c.actor}${c.actor === 'human' ? ' claim: agents never override it' : ''}), lease until ${until}`);
  }
  if (L.status === 'triage') {
    const duty = triagerOnDuty(cfg, now);
    if (duty !== me.handle) reasons.push(`status:triage and you are not the triager on duty (${duty || 'nobody'})`);
  } else if (L.status === 'claimed') {
    if (!others.length && !f.steal) {
      const who = U.assigneeLogins(issue).join(', ') || 'nobody';
      reasons.push(`status:claimed but no live claim (expired lease or UI assignment to ${who}); use --steal to take over or run \`mesh sweep\``);
    }
  } else if (L.status !== 'ready') {
    reasons.push(`status is ${L.status || 'unset'}; only status:ready (or triage for the triager on duty) can be claimed`);
  }
  if (L.to && L.to !== me.handle && L.to !== 'any') reasons.push(`routed to ${L.to} (to:${L.to}); route it to yourself or any first`);
  if (agent) {
    const held = countClaims(await fetchOpenItems(ctx), me.login);
    const wip = me.member.agent.wip;
    if (held >= wip) reasons.push(`WIP limit reached (${held}/${wip} claims held)`);
  }
  if (reasons.length) throw new PreconditionError(`cannot claim #${n}:\n  - ${reasons.join('\n  - ')}`);

  // Recorded routing, so a sweep or release can restore it.
  let origTo = L.to;
  if (!origTo) {
    const prev = [...comments].sort((a, b) => b.id - a.id).map((c) => P.parseMarker(c.body)).find((m) => m && m.type === 'claim' && m.to);
    if (prev) origTo = prev.to;
  }

  if (L.status === 'claimed' && f.steal) {
    const prevOwner = U.assigneeLogins(issue).join(', ') || 'an expired claim';
    await U.postComment(ctx, n, await U.compose(ctx, { type: 'note', body: `Taking over expired claim of ${prevOwner}.` }));
  }

  const lease = P.leaseUntil(now, cfg.policy.lease_minutes[ctx.actor]);
  const extra = { lease };
  if (origTo) extra.to = origTo;
  const who = agent ? `${me.handle}'s agent` : me.handle;
  let text = `**Claimed** by ${who}.`;
  if (f.plan) text += `\n\n**Plan:** ${f.plan}`;
  const posted = await U.postComment(ctx, n, await U.compose(ctx, { type: 'claim', body: text, ...extra }));
  await U.addAssignees(ctx, n, [me.login]);
  await U.updateLabels(ctx, n, names, U.applyLabelOps(names, { set: { status: 'claimed' }, remove: ['to:any'] }));

  if (ctx.dryRun) {
    ctx.emit({ issue: n, dry_run: true, lease }, `[dry-run] would settle, arbitrate and finish claiming #${n} (lease until ${lease}).`);
    return 0;
  }

  const settle = f.settle !== undefined ? Number(f.settle) : cfg.policy.claim_settle_seconds;
  if (!(settle >= 0)) throw new UsageError('--settle must be a number >= 0');
  if (settle > 0) await ctx.sleep(settle * 1000);

  const after = await U.getComments(ctx, n);
  const { winner } = P.arbitrate(after, U.claimOpts(ctx, cfg));
  if (winner && winner.commentId === posted.id) {
    ctx.emit({ issue: n, claimed: true, comment_id: posted.id, lease }, `Claimed #${n} (lease until ${lease}).`);
    return 0;
  }

  // Lost: release immediately.
  const mineNow = after.find((c) => c.id === posted.id) || { body: posted.body };
  await U.editComment(ctx, posted.id, P.replaceMarker(mineNow.body, { type: 'released', reason: 'lost-race', lease: null }));
  if (!winner || winner.login.toLowerCase() !== me.login.toLowerCase()) {
    await U.removeAssignees(ctx, n, [me.login]);
  }
  const wl = winner ? `${winner.handle} (comment ${winner.commentId}, lower than ${posted.id})` : 'another claim';
  throw new PreconditionError(`lost the claim race on #${n} to ${wl}; released.`);
}

module.exports = { name: 'claim', summary: 'claim an issue with a lease and arbitrate races', help, spec: { boolean: ['steal'], string: ['plan', 'settle'] }, run, memberByLogin };
