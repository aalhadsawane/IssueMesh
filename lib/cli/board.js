'use strict';

const P = require('../protocol');
const U = require('./util');
const { UsageError } = U;

const help = `mesh board - read or post on the Board (PROTOCOL section 10)

Usage:
  mesh board [--since ISO|auto] [--json]
  mesh board post --type broadcast|standup --body "md" | --body-file f

Reading shows Board comments newer than your cursor (stored in
.git/issuemesh/state.json) and advances the cursor. The Board is board_issue if
it is open, else the newest open kind:board issue.

Options:
  --since ISO|auto   ISO-8601 time to read from; "auto" (default) uses the cursor.
                     An explicit time does not move the cursor.
  --type T           post: broadcast or standup
  --body / --body-file   post: message body
  --json             read: array of {id,user,actor,type,from,created_at,body}`;

function display(c) {
  const { content } = U.splitBody(c.body);
  return P.parseMarker(c.body) ? content : String(c.body).trim();
}

async function readBoard(args, ctx) {
  const f = args.flags;
  const board = await U.resolveBoard(ctx);
  const repo = await ctx.repo();
  const state = U.readState(ctx);
  const cur = state.board && state.board[repo] && state.board[repo].issue === board.number ? state.board[repo] : null;
  const since = f.since || 'auto';
  let sinceIso = null;
  let lastId = 0;
  if (since === 'auto') {
    if (cur) { sinceIso = cur.last_at || null; lastId = cur.last_id || 0; }
  } else {
    if (Number.isNaN(Date.parse(since))) throw new UsageError('--since must be an ISO-8601 time or "auto"');
    sinceIso = new Date(since).toISOString();
  }
  const all = await U.getComments(ctx, board.number, { since: sinceIso });
  const fresh = all.filter((c) => c.id > lastId).sort((a, b) => a.id - b.id);
  const rows = fresh.map((c) => {
    const m = P.parseMarker(c.body);
    return { id: c.id, user: c.user && c.user.login, actor: P.actorOf(c.body), type: m ? m.type : null, from: m ? m.from : null, created_at: c.created_at, body: display(c) };
  });
  if (since === 'auto' && fresh.length && !ctx.dryRun) {
    state.board = state.board || {};
    state.board[repo] = {
      issue: board.number,
      last_id: Math.max(lastId, ...fresh.map((c) => c.id)),
      last_at: fresh.map((c) => c.updated_at || c.created_at).sort().pop(),
    };
    U.writeState(ctx, state);
  }
  const lines = [`Board #${board.number}: ${rows.length} new comment(s)`];
  for (const r of rows) {
    lines.push(`-- ${r.id} ${r.created_at} @${r.user}${r.type ? ` [${r.type} from ${r.from}]` : ''}`);
    const text = r.body.length > 600 ? `${r.body.slice(0, 600)}...` : r.body;
    for (const l of text.split('\n')) lines.push(`   ${l}`);
  }
  ctx.emit(rows, lines.join('\n'));
  return 0;
}

async function postBoard(args, ctx) {
  const f = args.flags;
  if (!['broadcast', 'standup'].includes(f.type)) throw new UsageError('board post needs --type broadcast|standup');
  const body = U.readBody(ctx, f);
  const board = await U.resolveBoard(ctx);
  const c = await U.postComment(ctx, board.number, await U.compose(ctx, { type: f.type, body }));
  ctx.emit({ board: board.number, comment_id: c.id, type: f.type }, `Posted ${f.type} on Board #${board.number}.`);
  return 0;
}

async function run(args, ctx) {
  if (args._[0] === 'post') {
    if (args._.length !== 1) throw new UsageError('usage: mesh board post --type broadcast|standup --body "..."');
    return postBoard(args, ctx);
  }
  if (args._.length) throw new UsageError('usage: mesh board [--since ISO|auto] | mesh board post --type T --body "..."');
  return readBoard(args, ctx);
}

module.exports = {
  name: 'board',
  summary: 'read new Board comments; board post to broadcast/standup',
  help,
  spec: { string: ['since', 'type', 'body', 'body-file'] },
  run,
};
