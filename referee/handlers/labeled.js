'use strict';

/**
 * issues.labeled: enforce one label per single-valued namespace (keep the label
 * just added) and keep closed issues free of status labels.
 */

const { Plan } = require('../plan');
const { ONE_NAMESPACES } = require('../util');

module.exports = async function onLabeled({ payload, api }) {
  const issue = payload.issue;
  const added = payload.label && payload.label.name;
  if (!added) return [];
  // Live labels, not the payload: two quick label events must not delete each other's label.
  const plan = new Plan(issue.number, await api.listLabels(issue.number));

  if (issue.state === 'closed') {
    plan.setNs('status', null);
    return plan.actions;
  }
  if (!plan.has(added)) return []; // already removed by a newer event
  const i = added.indexOf(':');
  const ns = i > 0 ? added.slice(0, i).toLowerCase() : '';
  if (!ONE_NAMESPACES.includes(ns)) return [];
  for (const l of [...plan.labels]) {
    if (l.toLowerCase().startsWith(`${ns}:`) && l.toLowerCase() !== added.toLowerCase()) plan.removeLabel(l);
  }
  return plan.actions;
};
