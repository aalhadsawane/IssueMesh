'use strict';

const P = require('../protocol');
const U = require('./util');

const help = `mesh standup - post your daily standup on the Board

Usage: mesh standup --body "Done: ... Doing: ... Blocked: ... Needs: ..." | --body-file f

Posts a type=standup comment on the Board unless you already posted one today
(UTC), in which case it prints a message and exits 0.`;

async function run(args, ctx) {
  U.needPositional(args, 0, 0, 'mesh standup --body "..."');
  const me = await ctx.me();
  const body = U.readBody(ctx, args.flags);
  const board = await U.resolveBoard(ctx);
  const today = ctx.now().toISOString().slice(0, 10);
  const comments = await U.getComments(ctx, board.number, { since: `${today}T00:00:00Z` });
  const existing = comments.find((c) => {
    const m = P.parseMarker(c.body);
    return m && m.type === 'standup' && m.from === me.handle && String(c.created_at).slice(0, 10) === today;
  });
  if (existing) {
    ctx.emit({ posted: false, already: true, comment_id: existing.id }, `Standup already posted today for ${me.handle} (comment ${existing.id}); nothing to do.`);
    return 0;
  }
  const c = await U.postComment(ctx, board.number, await U.compose(ctx, { type: 'standup', body }));
  ctx.emit({ posted: true, board: board.number, comment_id: c.id }, `Posted standup on Board #${board.number}.`);
  return 0;
}

module.exports = { name: 'standup', summary: 'post the daily standup (once per day)', help, spec: { string: ['body', 'body-file'] }, run };
