'use strict';

const P = require('../protocol');
const U = require('./util');
const { UsageError } = U;

const help = `mesh ping - put an issue in other members' mailboxes

Usage: mesh ping <n> <handle|handle/agent...|all> [--body "text"]

Adds ping:<target> for each target (all = every agent-enabled member except
you). A bare handle (ping:<handle>) lands in that member's primary agent's
mailbox; <handle>/<agent> (ping:<handle>/<agent>) in that agent's mailbox. With
--body, also posts a note comment.

Options:
  --body "text"   optional note to leave with the ping

Exit codes: 0 ok; 2 unknown handle or agent.`;

async function run(args, ctx) {
  if (args._.length < 2) throw new UsageError('usage: mesh ping <n> <handle|handle/agent...|all> [--body "text"]');
  const n = U.parseNumber(args._[0]);
  const me = await ctx.me();
  const cfg = await ctx.config();
  let handles = U.splitList(args._.slice(1));
  if (handles.includes('all')) {
    handles = cfg.members.filter((m) => m.agents.length > 0 && m.handle !== me.handle).map((m) => m.handle);
  } else {
    handles = handles.map((h) => U.requireTarget(cfg, h).address);
  }
  handles = [...new Set(handles)];
  if (args.flags.body) await U.postComment(ctx, n, await U.compose(ctx, { type: 'note', body: args.flags.body }));
  if (handles.length) await U.changeLabels(ctx, n, { add: handles.map(P.pingLabel) });
  ctx.emit({ issue: n, pinged: handles }, `Pinged ${handles.join(', ') || 'nobody'} on #${n}.`);
  return 0;
}

module.exports = { name: 'ping', summary: 'add ping:<handle[/agent]> labels (mailbox)', help, spec: { string: ['body'] }, run };
