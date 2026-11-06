'use strict';

const U = require('./util');

const help = `mesh escalate - hand an issue to humans (PROTOCOL section 8)

Usage: mesh escalate <n> --body "what is needed, options" [--notify login[,login]]

Posts a type=escalate comment that @mentions the relevant human(s) (the issue
assignees, or --notify logins) and sets status:needs-human. Your claim, if any,
is kept; release separately if you will not continue.

Options:
  --body "md"       what you need decided/done, with options (required)
  --body-file F     read body from a file
  --notify logins   GitHub logins to mention instead of the assignees`;

async function run(args, ctx) {
  U.needPositional(args, 1, 1, 'mesh escalate <n> --body "..." [--notify login]');
  const n = U.parseNumber(args._[0]);
  const f = args.flags;
  const body = U.readBody(ctx, f);
  const issue = await U.getIssue(ctx, n);
  const logins = f.notify !== undefined ? U.splitList(f.notify) : U.assigneeLogins(issue);
  const mention = logins.length ? `\n\ncc ${logins.map((l) => `@${l}`).join(' ')}` : '';
  const comment = await U.postComment(ctx, n, await U.compose(ctx, { type: 'escalate', body: body + mention }));
  const names = U.labelNames(issue);
  await U.updateLabels(ctx, n, names, U.applyLabelOps(names, { set: { status: 'needs-human' } }));
  if (!logins.length) ctx.err('warning: no assignee or --notify login to mention; nobody was @mentioned');
  ctx.emit({ issue: n, comment_id: comment.id, mentioned: logins }, `Escalated #${n} to needs-human${logins.length ? ` (mentioned ${logins.join(', ')})` : ''}.`);
  return 0;
}

module.exports = { name: 'escalate', summary: 'type=escalate comment, @mention humans, status:needs-human', help, spec: { string: ['body', 'body-file', 'notify'] }, run };
