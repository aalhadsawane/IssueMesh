'use strict';

const P = require('../protocol');
const U = require('./util');
const { UsageError } = U;

const help = `mesh ping - put an issue in other members' mailboxes

Usage: mesh ping <n> <handle...|all> [--body "text"]

Adds ping:<handle> for each handle (all = every agent-enabled member except
you). With --body, also posts a note comment.

Options:
  --body "text"   optional note to leave with the ping

Exit codes: 0 ok; 2 unknown handle.`;

async function run(args, ctx) {
  if (args._.length < 2) throw new UsageError('usage: mesh ping <n> <handle...|all> [--body "text"]');
  const n = U.parseNumber(args._[0]);
  const me = await ctx.me();
  const cfg = await ctx.config();
  let handles = U.splitList(args._.slice(1));
  if (handles.includes('all')) {
    handles = cfg.members.filter((m) => m.agent.enabled !== false && m.handle !== me.handle).map((m) => m.handle);
  } else {
    for (const h of handles) U.requireMember(ctx, cfg, h);
  }
  handles = [...new Set(handles)];
  if (args.flags.body) await U.postComment(ctx, n, await U.compose(ctx, { type: 'note', body: args.flags.body }));
  if (handles.length) await U.changeLabels(ctx, n, { add: handles.map(P.pingLabel) });
  ctx.emit({ issue: n, pinged: handles }, `Pinged ${handles.join(', ') || 'nobody'} on #${n}.`);
  return 0;
}

module.exports = { name: 'ping', summary: 'add ping:<handle> labels (mailbox)', help, spec: { string: ['body'] }, run };
