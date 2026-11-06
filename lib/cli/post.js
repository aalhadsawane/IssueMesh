'use strict';

const P = require('../protocol');
const U = require('./util');
const { resolveAgent } = require('../config');
const { UsageError } = U;

const VERDICTS = ['approve', 'changes', 'comment'];

const help = `mesh post - post a protocol message (comment with marker) on an issue or PR

Usage: mesh post <n> --type <type> [--to h1,h2] [--verdict v] [--re id] --body "md" | --body-file f

Types: ask, answer, handoff, triage, review, standup, broadcast, escalate, note.
(claim/released are managed by \`mesh claim\` / \`mesh release\`.)

Options:
  --type T          message type (required)
  --to h1,h2        ask: addressees (adds ping:<target> to the issue); handoff: target.
                    A target is a member handle or <handle>/<agent>.
  --verdict V       review: approve | changes | comment (default comment)
  --re ID           answer: id of the comment being answered (re=<id>). The asker is
                    found from that comment (its verified marker's from=, else its
                    GitHub author) and gets ping:<asker> automatically (not when the
                    asker is you). Optional when exactly one open ask addressed to
                    you exists on the issue; otherwise required.
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
    targets = [...new Set(U.splitList(f.to).map((h) => U.requireTarget(cfg, h).address))];
    if (type === 'handoff' && targets.length !== 1) throw new UsageError('handoff takes exactly one --to handle');
    extra.to = targets.join(',');
  }
  if ((type === 'ask' || type === 'handoff') && !targets.length) throw new UsageError(`--type ${type} requires --to <handle>`);
  if (f.verdict !== undefined) {
    if (type !== 'review') throw new UsageError('--verdict only applies to --type review');
    if (!VERDICTS.includes(f.verdict)) throw new UsageError(`--verdict must be one of ${VERDICTS.join(', ')}`);
  }
  if (type === 'review') extra.verdict = f.verdict || 'comment';
  if (f.re !== undefined && type !== 'answer') throw new UsageError('--re only applies to --type answer');

  let askerPing = null;
  if (type === 'answer') {
    const me = await ctx.me();
    const comments = await U.getComments(ctx, n);
    let reId;
    if (f.re !== undefined) reId = U.parseNumber(f.re, 'comment id');
    else {
      const open = openAsksTo(comments, me, cfg);
      if (open.length !== 1) {
        throw new UsageError(open.length
          ? `answer needs --re <commentId>: ${open.length} open asks are addressed to you on #${n} (comments ${open.map((c) => c.id).join(', ')})`
          : `answer needs --re <commentId>: no open ask addressed to you on #${n}`);
      }
      reId = open[0].id;
    }
    const asked = comments.find((c) => c.id === reId);
    if (!asked) throw new UsageError(`--re ${reId}: no such comment on #${n}`);
    extra.re = String(reId);
    askerPing = askerAddress(asked, cfg, me);
  }

  const comment = await U.postComment(ctx, n, await U.compose(ctx, { type, body, ...extra }));
  if (type === 'ask') {
    await U.changeLabels(ctx, n, { add: targets.map(P.pingLabel) });
  }
  if (askerPing) await U.changeLabels(ctx, n, { add: [P.pingLabel(askerPing)] });
  ctx.emit(
    { issue: n, comment_id: comment.id, url: comment.html_url, type, ...(type === 'answer' ? { re: Number(extra.re), pinged: askerPing } : {}) },
    `Posted ${type} on #${n}${comment.html_url ? ` ${comment.html_url}` : ''}${askerPing ? ` (pinged ${askerPing})` : ''}.`,
  );
  return 0;
}

/**
 * The ping target for an answer: the verified sender of the answered comment
 * (agent id or handle), else its GitHub author's member handle. Null when the
 * sender is not a member, has no agent, or is you.
 */
function askerAddress(comment, cfg, me) {
  const v = P.verifyComment(comment, cfg);
  const src = v.verified ? v.agentId : v.handle;
  const r = src ? resolveAgent(cfg, src) : null;
  if (!r || !r.agent || r.id === me.agentId) return null;
  return r.address;
}

/** Open (unanswered) asks on the issue that are addressed to `me` and not written by `me`. */
function openAsksTo(comments, me, cfg) {
  const answered = new Set();
  for (const c of comments) {
    const m = P.verifyComment(c, cfg).marker;
    if (m && m.type === 'answer' && m.re) answered.add(m.re);
  }
  return comments.filter((c) => {
    const m = P.verifyComment(c, cfg).marker;
    if (!m || m.type !== 'ask' || answered.has(String(c.id)) || U.fromIsMe(m.from, me)) return false;
    return String(m.to || '').split(',').filter(Boolean).some((t) => P.targetsAgent(t, me.member, me.agentName, 'ping'));
  }).sort((a, b) => a.id - b.id);
}

module.exports = {
  name: 'post',
  summary: 'post a typed protocol message (ask/answer add ping labels)',
  help,
  spec: { string: ['type', 'to', 'verdict', 're', 'body', 'body-file'] },
  run,
};
