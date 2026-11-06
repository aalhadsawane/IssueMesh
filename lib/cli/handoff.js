'use strict';

const P = require('../protocol');
const U = require('./util');
const { UsageError } = U;
const { releaseClaim } = require('./release');

const help = `mesh handoff - pass work to another member (PROTOCOL section 4.4)

Usage: mesh handoff <n> <handle|handle/agent> --note "summary"

Posts a type=handoff comment (to=<target>) with your note, releases your claim
(reason=handoff), unassigns you, sets status:ready, to:<target> and adds
ping:<target>. <target> is a member handle (any of its agents may claim; its
primary agent gets the ping) or <handle>/<agent> (one specific agent, which may
be a sibling agent of your own member).

Options:
  --note "text"   what was done, what is left, where the branch/PR is (required)

Exit codes: 0 ok; 2 unknown handle or agent, handoff to yourself, or missing note.`;

async function run(args, ctx) {
  U.needPositional(args, 2, 2, 'mesh handoff <n> <handle|handle/agent> --note "..."');
  const n = U.parseNumber(args._[0]);
  const me = await ctx.me();
  const cfg = await ctx.config();
  const resolved = U.requireTarget(cfg, args._[1]);
  const target = resolved.address;
  if (resolved.handle === me.handle && (!resolved.explicit || resolved.id === me.agentId)) {
    throw new UsageError('cannot hand off to yourself (use <handle>/<agent> to hand off to another agent of your member)');
  }
  const note = args.flags.note;
  if (!note || !String(note).trim()) throw new UsageError('missing --note "summary"');

  await U.postComment(ctx, n, await U.compose(ctx, { type: 'handoff', to: target, body: note }));
  await releaseClaim(ctx, n, {
    toStatus: 'ready',
    reason: 'handoff',
    labelSet: { to: target },
    labelAdd: [P.pingLabel(target)],
    restoreTo: false,
    requireClaim: false,
  });
  ctx.emit({ issue: n, to: target }, `Handed off #${n} to ${target}.`);
  return 0;
}

module.exports = { name: 'handoff', summary: 'release + route + ping another member', help, spec: { string: ['note'] }, run };
