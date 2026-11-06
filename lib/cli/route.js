'use strict';

const U = require('./util');
const { UsageError } = U;

const help = `mesh route - set the to: label (who should do it)

Usage: mesh route <n> <handle|any>

Sets to:<handle> (or to:any), replacing any other to: label. If the issue is
status:triage it moves to status:ready. Routing is a request, not ownership.

Exit codes: 0 ok; 2 unknown handle.`;

async function run(args, ctx) {
  U.needPositional(args, 2, 2, 'mesh route <n> <handle|any>');
  const n = U.parseNumber(args._[0]);
  const target = args._[1].replace(/^@/, '');
  if (target !== 'any') U.requireMember(ctx, await ctx.config(), target);
  const issue = await U.getIssue(ctx, n);
  const names = U.labelNames(issue);
  const set = { to: target };
  if (names.includes('status:triage')) set.status = 'ready';
  await U.updateLabels(ctx, n, names, U.applyLabelOps(names, { set }));
  ctx.emit({ issue: n, to: target, status: set.status || null }, `Routed #${n} to ${target}${set.status ? ' (status:ready)' : ''}.`);
  return 0;
}

module.exports = { name: 'route', summary: 'set to:<handle|any> (triage -> ready)', help, spec: {}, run };
