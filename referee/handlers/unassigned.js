'use strict';

/**
 * issues.unassigned: end the unassigned member's claims; if no live claim
 * remains and the issue is still `status:claimed`, return it to `ready`.
 */

const P = require('../../lib/protocol');
const C = require('../../lib/config');
const { Plan } = require('../plan');
const { claimOpts, releaseClaims } = require('../util');

module.exports = async function onUnassigned({ payload, config, now, api }) {
  const issue = payload.issue;
  if (issue.state === 'closed') return [];
  const login = payload.assignee && payload.assignee.login;
  const member = login && C.memberByLogin(config, login);

  const [labels, comments] = await Promise.all([api.listLabels(issue.number), api.listComments(issue.number)]);
  const plan = new Plan(issue.number, labels, (issue.assignees || []).map((a) => a.login));
  if (plan.state.kind === 'board') return [];
  const opts = claimOpts(config, now);
  const byId = new Map(comments.map((c) => [c.id, c]));

  let restoreTo = null;
  if (member) {
    const mine = P.liveClaims(comments, opts).filter((c) => c.handle === member.handle || c.login.toLowerCase() === login.toLowerCase());
    restoreTo = releaseClaims(plan, mine, byId, 'unassigned');
  }
  const remaining = P.liveClaims(comments, { ...opts, releasedHandles: member ? [member.handle] : [] })
    .filter((c) => !(login && c.login.toLowerCase() === login.toLowerCase()));
  if (plan.state.status === 'claimed' && remaining.length === 0) {
    plan.setNs('status', 'ready');
    if (restoreTo && plan.state.to !== restoreTo) plan.setNs('to', restoreTo);
  }
  return plan.actions;
};
