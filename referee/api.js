'use strict';

/** Thin read-side wrapper over octokit so handlers fetch state in one place. */

const { labelNames } = require('./util');

function makeApi(github, { owner, repo }) {
  const base = { owner, repo };
  const paginate = (fn, params) => github.paginate(fn, { ...base, per_page: 100, ...params });
  return {
    async getIssue(n) {
      return (await github.rest.issues.get({ ...base, issue_number: n })).data;
    },
    async listLabels(n) {
      return labelNames(await paginate(github.rest.issues.listLabelsOnIssue, { issue_number: n }));
    },
    listComments(n) {
      return paginate(github.rest.issues.listComments, { issue_number: n });
    },
    /** Open issues (no PRs) matching a label filter, newest first. */
    async listOpenIssues(labels) {
      const all = await paginate(github.rest.issues.listForRepo, { state: 'open', labels, sort: 'created', direction: 'desc' });
      return all.filter((i) => !i.pull_request);
    },
  };
}

module.exports = { makeApi };
