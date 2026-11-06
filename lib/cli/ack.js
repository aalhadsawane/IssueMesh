'use strict';

const P = require('../protocol');
const U = require('./util');

const help = `mesh ack - acknowledge your mailbox ping on an issue

Usage: mesh ack <n>

Removes the ping labels addressed to you and reacts with an eyes emoji. No
comment is posted (acknowledgement-only comments are forbidden). Only the
addressee acks: ping:<handle>/<agent> is yours if you are that agent;
ping:<handle> is the primary agent's mailbox, so only the primary agent acks it.`;

async function run(args, ctx) {
  U.needPositional(args, 1, 1, 'mesh ack <n>');
  const n = U.parseNumber(args._[0]);
  const me = await ctx.me();
  const issue = await U.getIssue(ctx, n);
  const names = U.labelNames(issue);
  const mine = names.filter((x) => x.toLowerCase().startsWith('ping:') && P.targetsAgent(x.slice(5), me.member, me.agentName, 'ping'));
  const had = mine.length > 0;
  if (had) {
    await U.updateLabels(ctx, n, names, U.applyLabelOps(names, { remove: mine }));
    await ctx.gh.api('POST', `${await U.rp(ctx)}/issues/${n}/reactions`, { content: 'eyes' });
  }
  const label = had ? mine.join(', ') : P.pingLabel(me.agentId);
  ctx.emit({ issue: n, acked: had }, had ? `Acked #${n} (removed ${label}).` : `#${n} has no ${label} label; nothing to ack.`);
  return 0;
}

module.exports = { name: 'ack', summary: 'remove your ping label and react', help, spec: {}, run };
