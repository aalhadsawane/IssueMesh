'use strict';

/**
 * issues.assigned: a member assigning a member in the UI is a human claim.
 * The referee records it as a claim comment (actor=human) so the lease sweep
 * can later expire it, and sets status:claimed.
 */

const P = require('../../lib/protocol');
const C = require('../../lib/config');
const { Plan } = require('../plan');
const { claimOpts } = require('../util');

const RECENT_MS = 2 * 60 * 1000;

module.exports = async function onAssigned({ payload, config, now, api }) {
  const issue = payload.issue;
  const assignee = payload.assignee && payload.assignee.login;
  const member = assignee && C.memberByLogin(config, assignee);
  const sender = payload.sender && payload.sender.login;
  if (!member || !sender || !C.isMember(config, sender) || issue.state === 'closed') return [];

  const [labels, comments] = await Promise.all([api.listLabels(issue.number), api.listComments(issue.number)]);
  const plan = new Plan(issue.number, labels, (issue.assignees || []).map((a) => a.login));
  if (plan.state.kind === 'board') return [];
  if (![null, 'triage', 'ready', 'claimed'].includes(plan.state.status)) return [];

  if (P.liveClaims(comments, claimOpts(config, now)).length) return []; // a recorded claim exists
  const recent = P.extractClaims(comments, claimOpts(config, now)).some((c) => c.type === 'claim' && c.handle === member.handle && now - new Date(c.createdAt) < RECENT_MS);
  if (recent) return [];

  plan.setNs('status', 'claimed');
  const lease = P.leaseUntil(now, config.policy.lease_minutes.human);
  plan.comment(`${P.formatMarker({ from: member.handle, actor: 'human', type: 'claim', lease })}\nClaimed by ${member.handle} (assigned in the GitHub UI, recorded by the referee). Lease until ${lease}; comment \`/release\` to give it up.`);
  return plan.actions;
};
