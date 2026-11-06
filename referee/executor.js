'use strict';

/**
 * Executor: applies actions with octokit.
 *
 * Action types:
 *   addLabels {issue, labels[]}        removeLabel {issue, label}
 *   addAssignees / removeAssignees {issue, assignees[]}
 *   createComment {issue, body}        updateComment {commentId, body}
 *   createIssue {title, body, labels[], then(created) -> actions[]}
 *   closeIssue {issue, reason}         pinIssue / unpinIssue {nodeId}
 *   syncLabels {labels[{name,color,description}]}
 *   dispatch {handle, issue}           log {level, message}
 *
 * Label changes are coalesced per issue and diffed against the issue's live
 * labels: labels already present are not re-added, absent ones are not removed,
 * and a 404 on removal is tolerated. One addLabels call per issue at most.
 */

const EVENT_TYPE = 'issuemesh-wake';

function createExecutor({ github, context, core }) {
  const { owner, repo } = context.repo;
  const base = { owner, repo };
  const liveLabels = new Map(); // issue -> Map(lower -> name)

  async function labelsOf(issue) {
    if (!liveLabels.has(issue)) {
      const data = await github.paginate(github.rest.issues.listLabelsOnIssue, { ...base, issue_number: issue, per_page: 100 });
      liveLabels.set(issue, new Map(data.map((l) => [l.name.toLowerCase(), l.name])));
    }
    return liveLabels.get(issue);
  }

  /** Merge label actions of one issue into a single `labelBatch` at the first one's position. */
  function coalesce(actions) {
    const batches = new Map();
    const out = [];
    for (const a of actions) {
      if (a.type !== 'addLabels' && a.type !== 'removeLabel') { out.push(a); continue; }
      let b = batches.get(a.issue);
      if (!b) {
        b = { type: 'labelBatch', issue: a.issue, ops: [] };
        batches.set(a.issue, b);
        out.push(b);
      }
      if (a.type === 'addLabels') a.labels.forEach((l) => b.ops.push(['add', l]));
      else b.ops.push(['remove', a.label]);
    }
    return out;
  }

  async function labelBatch(a, result) {
    const current = await labelsOf(a.issue);
    const final = new Map(current);
    for (const [op, name] of a.ops) {
      if (op === 'add') final.set(name.toLowerCase(), name);
      else final.delete(name.toLowerCase());
    }
    const add = [...final].filter(([k]) => !current.has(k)).map(([, v]) => v);
    const remove = [...current].filter(([k]) => !final.has(k)).map(([, v]) => v);
    if (add.length) {
      await github.rest.issues.addLabels({ ...base, issue_number: a.issue, labels: add });
      add.forEach((l) => { current.set(l.toLowerCase(), l); result.added.push({ issue: a.issue, label: l }); });
    }
    for (const name of remove) {
      try {
        await github.rest.issues.removeLabel({ ...base, issue_number: a.issue, name });
      } catch (e) {
        if (!e || e.status !== 404) throw e;
      }
      current.delete(name.toLowerCase());
      result.removed.push({ issue: a.issue, label: name });
    }
  }

  async function syncLabels(a) {
    const existing = await github.paginate(github.rest.issues.listLabelsForRepo, { ...base, per_page: 100 });
    const byName = new Map(existing.map((l) => [l.name.toLowerCase(), l]));
    for (const want of a.labels) {
      const description = (want.description || '').slice(0, 100);
      const have = byName.get(want.name.toLowerCase());
      if (!have) {
        await github.rest.issues.createLabel({ ...base, name: want.name, color: want.color, description });
      } else if ((have.color || '').toLowerCase() !== want.color.toLowerCase() || (have.description || '') !== description) {
        await github.rest.issues.updateLabel({ ...base, name: have.name, color: want.color, description });
      }
    }
  }

  async function execute(a, result, queue) {
    switch (a.type) {
      case 'labelBatch': return labelBatch(a, result);
      case 'addAssignees': await github.rest.issues.addAssignees({ ...base, issue_number: a.issue, assignees: a.assignees }); return undefined;
      case 'removeAssignees': await github.rest.issues.removeAssignees({ ...base, issue_number: a.issue, assignees: a.assignees }); return undefined;
      case 'createComment': await github.rest.issues.createComment({ ...base, issue_number: a.issue, body: a.body }); return undefined;
      case 'updateComment': await github.rest.issues.updateComment({ ...base, comment_id: a.commentId, body: a.body }); return undefined;
      case 'closeIssue': await github.rest.issues.update({ ...base, issue_number: a.issue, state: 'closed', state_reason: a.reason || 'completed' }); return undefined;
      case 'createIssue': {
        const { data } = await github.rest.issues.create({ ...base, title: a.title, body: a.body, labels: a.labels || [] });
        result.created.push(data);
        if (typeof a.then === 'function') queue.unshift(...coalesce(a.then(data) || []));
        return undefined;
      }
      case 'pinIssue':
        await github.graphql('mutation($id: ID!) { pinIssue(input: {issueId: $id}) { issue { id } } }', { id: a.nodeId });
        return undefined;
      case 'unpinIssue':
        await github.graphql('mutation($id: ID!) { unpinIssue(input: {issueId: $id}) { issue { id } } }', { id: a.nodeId });
        return undefined;
      case 'syncLabels': return syncLabels(a);
      case 'dispatch':
        await github.rest.repos.createDispatchEvent({ ...base, event_type: EVENT_TYPE, client_payload: { handle: a.handle, issue: a.issue } });
        return undefined;
      case 'log': (core[a.level] || core.info).call(core, a.message); return undefined;
      default: throw new Error(`unknown action type: ${a.type}`);
    }
  }

  /**
   * Apply actions in order. Failures are reported with core.warning and do not
   * stop the remaining actions.
   * @returns {Promise<{added: {issue:number,label:string}[], removed: object[], created: object[], errors: Error[]}>}
   */
  async function run(actions) {
    const result = { added: [], removed: [], created: [], errors: [] };
    const queue = coalesce(actions);
    while (queue.length) {
      const a = queue.shift();
      try {
        await execute(a, result, queue);
      } catch (e) {
        result.errors.push(e);
        // a failed pin/unpin (e.g. 3-pin limit, no permission) is not worth failing a run over
        core.warning(`issuemesh referee: ${a.type}${a.issue ? ` #${a.issue}` : ''} failed: ${e && e.message}`);
      }
    }
    return result;
  }

  return { run };
}

module.exports = { createExecutor, EVENT_TYPE };
