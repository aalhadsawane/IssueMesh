'use strict';

/**
 * schedule / workflow_dispatch(task=sweep): expire dead claims, rotate the Board.
 */

const P = require('../../lib/protocol');
const C = require('../../lib/config');
const { Plan } = require('../plan');
const { claimOpts, releaseClaims } = require('../util');
const { rotateBoard } = require('./board');

async function sweepIssue(issue, { config, now, api }) {
  const comments = await api.listComments(issue.number);
  const opts = claimOpts(config, now);
  if (P.liveClaims(comments, opts).length) return [];

  const plan = new Plan(issue.number, (issue.labels || []).map((l) => (typeof l === 'string' ? l : l.name)), (issue.assignees || []).map((a) => a.login));
  if (plan.state.status !== 'claimed' || plan.state.kind === 'board') return [];

  const byId = new Map(comments.map((c) => [c.id, c]));
  const dead = P.extractClaims(comments, opts).filter((c) => c.type === 'claim'); // none is live
  const logins = new Set(dead.map((c) => c.login));
  // a human claim recorded by the referee carries the bot's login: unassign the claiming member instead
  for (const c of dead) { const m = C.memberByHandle(config, c.handle); if (m) logins.add(m.github); }

  if (dead.length === 0) {
    // claimed with no claim record (label set by hand): give the human lease from last activity
    const touched = new Date(issue.updated_at);
    if (!Number.isNaN(touched.getTime()) && touched.getTime() + config.policy.lease_minutes.human * 60000 > now.getTime()) return [];
    for (const a of issue.assignees || []) if (C.isMember(config, a.login)) logins.add(a.login);
  }

  const restoreTo = releaseClaims(plan, dead, byId, 'expired');
  plan.unassign([...logins]);
  plan.setNs('status', 'ready');
  if (restoreTo && plan.state.to !== restoreTo) plan.setNs('to', restoreTo);
  plan.log('claim expired, released');
  return plan.actions;
}

module.exports = async function sweep(ctx) {
  const { api, config } = ctx;
  const actions = [];
  for (const issue of await api.listOpenIssues('status:claimed')) {
    actions.push(...await sweepIssue(issue, ctx));
  }
  actions.push(...await rotateBoard({ api, config }));
  return actions;
};
