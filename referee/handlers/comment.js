'use strict';

/**
 * issue_comment.created / edited.
 *
 * created: slash commands, mentions -> ping labels, claim arbitration, loop guard.
 * edited:  claim arbitration only (heartbeat edits must not replay commands).
 * Comments from non-members and bots are ignored.
 */

const P = require('../../lib/protocol');
const C = require('../../lib/config');
const { Plan } = require('../plan');
const { claimOpts, agentMembers, resolveMember, refereeMessage, releaseClaims } = require('../util');

/** Statuses a fresh claim may move to `claimed`. */
const CLAIMABLE = [null, 'triage', 'ready', 'claimed'];

module.exports = async function onComment({ payload, config, now, api }) {
  const issue = payload.issue;
  const comment = payload.comment;
  const author = comment && comment.user;
  if (!author || author.type === 'Bot' || issue.state === 'closed') return [];
  const member = C.memberByLogin(config, author.login);
  if (!member) return [];

  const created = payload.action !== 'edited';
  const marker = P.parseMarker(comment.body);
  const commands = created ? P.parseCommands(comment.body) : [];
  const isClaim = marker ? marker.type === 'claim' : P.parseCommands(comment.body).some((c) => c.name === 'claim');
  if (!created && !isClaim) return [];

  const [labels, fetched] = await Promise.all([api.listLabels(issue.number), api.listComments(issue.number)]);
  const comments = fetched.filter((c) => c.id !== comment.id).concat([comment]);
  const byId = new Map(comments.map((c) => [c.id, c]));
  const plan = new Plan(issue.number, labels, (issue.assignees || []).map((a) => a.login));
  const opts = claimOpts(config, now);
  const asHuman = P.actorOf(comment.body) === 'human';

  const releaseMine = (reason) => {
    const mine = P.liveClaims(comments, opts).filter((c) => c.handle === member.handle || c.login.toLowerCase() === author.login.toLowerCase());
    const restoreTo = releaseClaims(plan, mine, byId, reason);
    plan.unassign([author.login]);
    const remaining = P.liveClaims(comments, { ...opts, releasedHandles: [member.handle] });
    if (plan.state.status === 'claimed' && remaining.length === 0) {
      plan.setNs('status', 'ready');
      if (restoreTo && plan.state.to !== restoreTo) plan.setNs('to', restoreTo);
    }
  };
  const resumeStatus = () => {
    const live = P.liveClaims(comments, opts).length > 0;
    plan.setNs('status', live ? 'claimed' : 'ready');
  };

  /* ---- slash commands ---- */
  for (const { name, args } of commands) {
    const st = plan.state.status;
    switch (name) {
      case 'claim': break; // handled by arbitration below
      case 'release': releaseMine('released'); break;
      case 'route': {
        const target = (args[0] || '').toLowerCase();
        const m = target === 'any' ? null : resolveMember(config, target);
        if (target !== 'any' && !m) { plan.log(`/route: unknown handle "${target}"`); break; }
        plan.setNs('to', m ? m.handle : 'any');
        if (st === 'triage') plan.setNs('status', 'ready');
        break;
      }
      case 'ping': {
        const targets = args.some((a) => a.toLowerCase() === 'all')
          ? agentMembers(config).filter((m) => m.handle !== member.handle)
          : args.map((a) => resolveMember(config, a)).filter((m) => m && agentMembers(config).includes(m));
        for (const m of targets) plan.addLabel(P.pingLabel(m.handle));
        break;
      }
      case 'handoff': {
        const m = resolveMember(config, args[0]);
        if (!m) { plan.log(`/handoff: unknown handle "${args[0]}"`); break; }
        releaseMine('handoff');
        plan.setNs('to', m.handle);
        if (agentMembers(config).includes(m)) plan.addLabel(P.pingLabel(m.handle));
        break;
      }
      case 'block': {
        plan.setNs('status', 'blocked');
        const dep = args.find((a) => /^\d+$/.test(a));
        if (dep) plan.comment(refereeMessage('note', `Blocked by #${dep} (requested by @${author.login}). \`/unblock\` when it is resolved.`, { dep }));
        break;
      }
      case 'unblock':
        if (st === 'blocked' || st === 'needs-human') resumeStatus();
        break;
      case 'hold':
        if (asHuman) plan.setNs('status', 'hold');
        else plan.log('/hold from an agent ignored: only a human /hold binds agents');
        break;
      case 'unhold':
        if (st === 'hold') resumeStatus();
        break;
      case 'triage': plan.setNs('status', 'triage'); break;
      case 'escalate': plan.setNs('status', 'needs-human'); break;
      case 'priority':
        if (P.PRIORITIES.includes((args[0] || '').toLowerCase())) plan.setNs('priority', args[0].toLowerCase());
        break;
      case 'size':
        if (P.SIZES.includes((args[0] || '').toLowerCase())) plan.setNs('size', args[0].toLowerCase());
        break;
      case 'kind': {
        const k = (args[0] || '').toLowerCase();
        if (P.KINDS.includes(k) && k !== 'board') plan.setNs('kind', k);
        break;
      }
      default: break;
    }
  }

  /* ---- mentions -> mailbox ---- */
  if (created) {
    for (const login of P.parseMentions(comment.body)) {
      const m = C.memberByLogin(config, login);
      if (!m || m.handle === member.handle || m.route_mentions_to_agent === false) continue;
      if (agentMembers(config).includes(m)) plan.addLabel(P.pingLabel(m.handle));
    }
  }

  /* ---- claim arbitration (PROTOCOL.md 4.2) ---- */
  if (isClaim) {
    const { winner, losers } = P.arbitrate(comments, opts);
    if (winner) {
      plan.assign([winner.login]);
      if (CLAIMABLE.includes(plan.state.status)) plan.setNs('status', 'claimed');
    }
    for (const loser of losers) {
      const lm = byId.get(loser.commentId);
      if (P.parseMarker(lm.body)) {
        plan.updateComment(lm.id, P.replaceMarker(lm.body, { type: 'released', reason: 'lost-race' }));
      } else if (loser.commentId === comment.id) {
        plan.comment(refereeMessage('note', `@${loser.login} your \`/claim\` lost the race to ${winner.handle} (earlier claim comment). Nothing to do.`, { re: String(loser.commentId) }));
      }
      if (winner && loser.login.toLowerCase() !== winner.login.toLowerCase()) plan.unassign([loser.login]);
    }
  }

  /* ---- loop guard (PROTOCOL.md section 8) ---- */
  if (created && P.loopGuardTripped(comments, config.policy.max_agent_streak) && plan.state.status !== 'needs-human') {
    const { length, handles } = P.agentStreak(comments);
    const owners = [...handles].map((h) => C.memberByHandle(config, h)).filter(Boolean).map((m) => `@${m.github}`);
    plan.setNs('status', 'needs-human');
    plan.comment(refereeMessage('escalate',
      `Loop guard: the last ${length} comments are all from agents (${[...handles].join(', ')}) with no human in between. `
      + `Agents must stop replying here. ${owners.join(' ')} please look and comment to resume.`));
  }

  return plan.actions;
};
