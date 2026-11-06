'use strict';

const P = require('../protocol');
const U = require('./util');
const { UsageError } = U;

const VERDICTS = ['approve', 'changes', 'comment'];

const help = `mesh post - post a protocol message (comment with marker) on an issue or PR

Usage: mesh post <n> --type <type> [--to h1,h2] [--verdict v] [--re id] --body "md" | --body-file f

Types: ask, answer, handoff, triage, review, standup, broadcast, escalate, note.
(claim/released are managed by \`mesh claim\` / \`mesh release\`.)

Options:
  --type T          message type (required)
  --to h1,h2        ask: addressees (adds ping:<handle> to the issue); handoff: target
  --verdict V       review: approve | changes | comment (default comment)
  --re ID           answer: id of the comment being answered (re=<id>)
  --body "md"       message body
  --body-file F     read body from file ("-" = stdin)

Exit codes: 0 ok; 2 usage.`;

async function run(args, ctx) {
  U.needPositional(args, 1, 1, 'mesh post <n> --type <type> --body "..."');
  const n = U.parseNumber(args._[0]);
  const f = args.flags;
  const type = f.type;
  if (!type) throw new UsageError('missing --type');
  if (type === 'claim' || type === 'released') throw new UsageError('use `mesh claim` / `mesh release` for claim comments');
  if (!P.MESSAGE_TYPES.includes(type)) throw new UsageError(`unknown --type "${type}" (${P.MESSAGE_TYPES.filter((t) => t !== 'claim' && t !== 'released').join(', ')})`);
  const body = U.readBody(ctx, f);
  const cfg = await ctx.config();
  const extra = {};
  let targets = [];
  if (f.to !== undefined) {
    if (type !== 'ask' && type !== 'handoff') throw new UsageError('--to only applies to --type ask or handoff');
    targets = U.splitList(f.to);
    for (const h of targets) U.requireMember(ctx, cfg, h);
    if (type === 'handoff' && targets.length !== 1) throw new UsageError('handoff takes exactly one --to handle');
    extra.to = targets.join(',');
  }
  if ((type === 'ask' || type === 'handoff') && !targets.length) throw new UsageError(`--type ${type} requires --to <handle>`);
  if (f.verdict !== undefined) {
    if (type !== 'review') throw new UsageError('--verdict only applies to --type review');
    if (!VERDICTS.includes(f.verdict)) throw new UsageError(`--verdict must be one of ${VERDICTS.join(', ')}`);
  }
  if (type === 'review') extra.verdict = f.verdict || 'comment';
  if (f.re !== undefined) {
    if (type !== 'answer') throw new UsageError('--re only applies to --type answer');
    extra.re = String(U.parseNumber(f.re, 'comment id'));
  }

  const comment = await U.postComment(ctx, n, await U.compose(ctx, { type, body, ...extra }));
  if (type === 'ask') {
    await U.changeLabels(ctx, n, { add: targets.map(P.pingLabel) });
  }
  ctx.emit({ issue: n, comment_id: comment.id, url: comment.html_url, type }, `Posted ${type} on #${n}${comment.html_url ? ` ${comment.html_url}` : ''}.`);
  return 0;
}

module.exports = {
  name: 'post',
  summary: 'post a typed protocol message (ask adds ping labels)',
  help,
  spec: { string: ['type', 'to', 'verdict', 're', 'body', 'body-file'] },
  run,
};
