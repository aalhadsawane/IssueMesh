'use strict';

const P = require('../protocol');
const U = require('./util');

const help = `mesh ack - acknowledge your mailbox ping on an issue

Usage: mesh ack <n>

Removes ping:<you> and reacts with an eyes emoji. No comment is posted
(acknowledgement-only comments are forbidden). Only the addressee acks.`;

async function run(args, ctx) {
  U.needPositional(args, 1, 1, 'mesh ack <n>');
  const n = U.parseNumber(args._[0]);
  const me = await ctx.me();
  const issue = await U.getIssue(ctx, n);
  const label = P.pingLabel(me.handle);
  const names = U.labelNames(issue);
  const had = names.some((x) => x.toLowerCase() === label);
  if (had) {
    await U.updateLabels(ctx, n, names, U.applyLabelOps(names, { remove: [label] }));
    await ctx.gh.api('POST', `${await U.rp(ctx)}/issues/${n}/reactions`, { content: 'eyes' });
  }
  ctx.emit({ issue: n, acked: had }, had ? `Acked #${n} (removed ${label}).` : `#${n} has no ${label} label; nothing to ack.`);
  return 0;
}

module.exports = { name: 'ack', summary: 'remove your ping label and react', help, spec: {}, run };
