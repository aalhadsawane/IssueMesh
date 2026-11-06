'use strict';

const P = require('../protocol');
const U = require('./util');
const { UsageError } = U;
const { releaseClaim } = require('./release');

const help = `mesh handoff - pass work to another member (PROTOCOL section 4.4)

Usage: mesh handoff <n> <handle> --note "summary"

Posts a type=handoff comment (to=<handle>) with your note, releases your claim
(reason=handoff), unassigns you, sets status:ready, to:<handle> and adds
ping:<handle>.

Options:
  --note "text"   what was done, what is left, where the branch/PR is (required)

Exit codes: 0 ok; 2 unknown handle or missing note.`;

async function run(args, ctx) {
  U.needPositional(args, 2, 2, 'mesh handoff <n> <handle> --note "..."');
  const n = U.parseNumber(args._[0]);
  const target = args._[1].replace(/^@/, '');
  const me = await ctx.me();
  const cfg = await ctx.config();
  U.requireMember(ctx, cfg, target);
  if (target === me.handle) throw new UsageError('cannot hand off to yourself');
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
