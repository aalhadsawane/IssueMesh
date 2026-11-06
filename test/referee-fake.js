'use strict';

/** Fake octokit + helpers for referee tests. Records calls; mutates in-memory state. */

const { normalizeConfig } = require('../lib/config');

const NOW = new Date('2026-11-06T12:00:00Z');
const MIN = 60000;
const iso = (offsetMin) => new Date(NOW.getTime() + offsetMin * MIN).toISOString().replace(/\.\d{3}Z$/, 'Z');

function makeConfig(extra = {}) {
  const { policy, ...rest } = extra;
  return normalizeConfig({
    version: 1,
    members: [
      { handle: 'aalhad', github: 'aalhadsawane' },
      { handle: 'ben', github: 'ben-gh' },
      { handle: 'chen', github: 'chen-gh', agent: { enabled: false } },
      { handle: 'dev', github: 'dev-gh', route_mentions_to_agent: false },
    ],
    board_issue: 1,
    policy: { ...(policy || {}) },
    ...rest,
  });
}

const READS = new Set(['get', 'listLabelsOnIssue', 'listComments', 'listForRepo', 'listLabelsForRepo']);

/**
 * @param {object} [init] { issues: [{number, state, labels, assignees, user, comments, ...}], repoLabels }
 */
function makeFake(init = {}) {
  const calls = [];
  const issues = new Map();
  let nextId = 5000;
  let nextNumber = 100;
  const repoLabels = (init.repoLabels || []).map((l) => ({ ...l }));
  const failures = init.failures || {}; // method name -> error to throw

  for (const i of init.issues || []) {
    issues.set(i.number, {
      state: 'open', labels: [], assignees: [], comments: [], user: { login: 'aalhadsawane' },
      node_id: `NODE${i.number}`, updated_at: iso(-1), ...i,
    });
  }

  const rec = (group, name, fn) => async (p) => {
    calls.push({ name: `${group}.${name}`, p });
    if (failures[name]) throw failures[name];
    return fn ? fn(p) : { data: {} };
  };
  const need = (n) => {
    const i = issues.get(n);
    if (!i) { const e = new Error('Not Found'); e.status = 404; throw e; }
    return i;
  };
  const view = (i) => ({
    ...i,
    labels: i.labels.map((name) => ({ name })),
    assignees: i.assignees.map((login) => ({ login })),
    comments: Array.isArray(i.comments) ? i.comments.length : i.comments,
  });

  const github = {
    calls,
    issues,
    repoLabels,
    paginate: async (fn, p) => (await fn(p)).data,
    graphql: rec('graphql', 'graphql', () => ({ data: {} })),
    rest: {
      issues: {
        get: rec('issues', 'get', (p) => ({ data: view(need(p.issue_number)) })),
        listLabelsOnIssue: rec('issues', 'listLabelsOnIssue', (p) => ({ data: need(p.issue_number).labels.map((name) => ({ name })) })),
        listComments: rec('issues', 'listComments', (p) => ({ data: [...need(p.issue_number).comments] })),
        listForRepo: rec('issues', 'listForRepo', (p) => ({
          data: [...issues.values()].filter((i) => i.state === p.state && (!p.labels || i.labels.includes(p.labels))).sort((a, b) => b.number - a.number).map(view),
        })),
        listLabelsForRepo: rec('issues', 'listLabelsForRepo', () => ({ data: repoLabels.map((l) => ({ ...l })) })),
        addLabels: rec('issues', 'addLabels', (p) => {
          const i = need(p.issue_number);
          for (const l of p.labels) if (!i.labels.includes(l)) i.labels.push(l);
          return { data: {} };
        }),
        removeLabel: rec('issues', 'removeLabel', (p) => {
          const i = need(p.issue_number);
          const k = i.labels.indexOf(p.name);
          if (k < 0) { const e = new Error('Label does not exist'); e.status = 404; throw e; }
          i.labels.splice(k, 1);
          return { data: {} };
        }),
        addAssignees: rec('issues', 'addAssignees', (p) => {
          const i = need(p.issue_number);
          for (const a of p.assignees) if (!i.assignees.includes(a)) i.assignees.push(a);
          return { data: {} };
        }),
        removeAssignees: rec('issues', 'removeAssignees', (p) => {
          const i = need(p.issue_number);
          i.assignees = i.assignees.filter((a) => !p.assignees.includes(a));
          return { data: {} };
        }),
        createComment: rec('issues', 'createComment', (p) => {
          const i = need(p.issue_number);
          const c = { id: nextId++, body: p.body, user: { login: 'github-actions[bot]', type: 'Bot' }, created_at: iso(0) };
          i.comments.push(c);
          return { data: c };
        }),
        updateComment: rec('issues', 'updateComment', (p) => {
          for (const i of issues.values()) {
            const c = i.comments.find((x) => x.id === p.comment_id);
            if (c) c.body = p.body;
          }
          return { data: {} };
        }),
        update: rec('issues', 'update', (p) => {
          const i = need(p.issue_number);
          if (p.state) i.state = p.state;
          return { data: {} };
        }),
        create: rec('issues', 'create', (p) => {
          const number = nextNumber++;
          const rec2 = { number, state: 'open', title: p.title, body: p.body, labels: [...(p.labels || [])], assignees: [], comments: [], user: { login: 'github-actions[bot]' }, node_id: `NODE${number}` };
          issues.set(number, rec2);
          return { data: view(rec2) };
        }),
        createLabel: rec('issues', 'createLabel', (p) => { repoLabels.push({ name: p.name, color: p.color, description: p.description }); return { data: {} }; }),
        updateLabel: rec('issues', 'updateLabel', (p) => {
          const l = repoLabels.find((x) => x.name === p.name);
          Object.assign(l, { color: p.color, description: p.description });
          return { data: {} };
        }),
      },
      repos: { createDispatchEvent: rec('repos', 'createDispatchEvent') },
    },
    /** Calls that change state (everything except reads). */
    mutations() { return calls.filter((c) => !READS.has(c.name.split('.')[1])); },
    named(name) { return calls.filter((c) => c.name === name); },
  };
  return github;
}

function makeCore() {
  const log = { info: [], warning: [], notice: [] };
  return {
    log,
    info: (m) => log.info.push(m),
    warning: (m) => log.warning.push(m),
    notice: (m) => log.notice.push(m),
  };
}

const ctx = (eventName, payload) => ({ eventName, repo: { owner: 'o', repo: 'r' }, payload });

/** Issue payload fragment built from fake state. */
function issuePayload(github, n) {
  const i = github.issues.get(n);
  return { number: n, state: i.state, user: i.user, labels: i.labels.map((name) => ({ name })), assignees: i.assignees.map((login) => ({ login })), node_id: i.node_id };
}

const user = (login) => ({ login, type: 'User' });
const claimBody = (handle, lease, extra = '') => `<!-- issuemesh v1 from=${handle} actor=agent type=claim lease=${lease}${extra} -->\n**Claimed** by ${handle}'s agent.`;

module.exports = { NOW, iso, makeConfig, makeFake, makeCore, ctx, issuePayload, user, claimBody };
