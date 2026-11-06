'use strict';

/** issues.opened / issues.reopened: default status, flag non-member input. */

const C = require('../../lib/config');
const { Plan } = require('../plan');
const { labelNames } = require('../util');

module.exports = async function onOpened({ payload, config, api }) {
  const issue = payload.issue;
  const labels = await api.listLabels(issue.number);
  const plan = new Plan(issue.number, labels.length ? labels : labelNames(issue.labels));
  if (plan.state.kind === 'board') return [];
  if (issue.state === 'closed') return [];
  if (!plan.state.status) plan.addLabel('status:triage');
  const author = issue.user && issue.user.login;
  if (author && !C.isMember(config, author)) plan.addLabel('source:external');
  return plan.actions;
};
