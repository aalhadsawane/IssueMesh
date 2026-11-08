'use strict';

/** issues.closed: a closed issue carries no status label (PROTOCOL section 2). Boards are left alone. */

const { Plan } = require('../plan');

module.exports = async function onClosed({ payload, api }) {
  const issue = payload.issue;
  const plan = new Plan(issue.number, await api.listLabels(issue.number));
  if (plan.state.kind === 'board') return [];
  plan.setNs('status', null);
  return plan.actions;
};
