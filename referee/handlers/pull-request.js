'use strict';

/**
 * pull_request.opened / ready_for_review / reopened / closed.
 *
 * Closing keywords ("Closes #N") link a PR to issues. Ready (non-draft) PRs move
 * linked issues to status:review; a PR closed unmerged reverts them; a merged PR
 * into the default branch drops the status label (the issue is closing).
 */

const P = require('../../lib/protocol');
const C = require('../../lib/config');
const { Plan } = require('../plan');
const { closingRefs, claimOpts } = require('../util');

module.exports = async function onPullRequest({ payload, config, now, api, owner, repo }) {
  const pr = payload.pull_request;
  if (!pr || !pr.user || !C.isMember(config, pr.user.login)) return []; // untrusted authors cannot move issues
  const refs = closingRefs(`${pr.title || ''}\n${pr.body || ''}`, owner, repo).filter((n) => n !== pr.number);
  const actions = [];
  const action = payload.action;

  const prPlan = new Plan(pr.number, await api.listLabels(pr.number));

  if (action === 'closed') {
    prPlan.setNs('status', null);
    actions.push(...prPlan.actions);
    const merged = !!pr.merged;
    const toDefault = pr.base && payload.repository && pr.base.ref === payload.repository.default_branch;
    for (const n of refs) {
      const issue = await safeGetIssue(api, n);
      if (!issue) continue;
      const plan = new Plan(n, await api.listLabels(n), (issue.assignees || []).map((a) => a.login));
      if (plan.state.kind === 'board') continue;
      if (merged) {
        if (toDefault) plan.setNs('status', null);
      } else if (plan.state.status === 'review' && issue.state !== 'closed') {
        const live = P.liveClaims(await api.listComments(n), claimOpts(config, now)).length > 0;
        plan.setNs('status', live ? 'claimed' : 'ready');
      }
      actions.push(...plan.actions);
    }
    return actions;
  }

  if (pr.draft) return []; // drafts are early progress, not review requests
  prPlan.setNs('status', 'review');
  actions.push(...prPlan.actions);
  for (const n of refs) {
    const issue = await safeGetIssue(api, n);
    if (!issue || issue.state === 'closed') continue;
    const plan = new Plan(n, await api.listLabels(n), (issue.assignees || []).map((a) => a.login));
    if (plan.state.kind === 'board') continue;
    if ([null, 'triage', 'ready', 'claimed'].includes(plan.state.status)) plan.setNs('status', 'review');
    actions.push(...plan.actions);
  }
  return actions;
};

async function safeGetIssue(api, n) {
  try {
    const issue = await api.getIssue(n);
    return issue.pull_request ? null : issue;
  } catch (e) {
    if (e && e.status === 404) return null;
    throw e;
  }
}
