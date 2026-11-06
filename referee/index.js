'use strict';

/**
 * IssueMesh referee entry point, for actions/github-script:
 *   await require('./.issuemesh-src/referee/index.js')({github, context, core})
 *
 * Reads `.issuemesh/team.json` from the checked-out user repo (process.cwd()),
 * routes the event to a handler, applies the returned actions, and optionally
 * wakes agents. Never throws for expected conditions (missing config, bots).
 */

const { loadConfig } = require('../lib/config');
const { makeApi } = require('./api');
const { createExecutor } = require('./executor');
const { wakeActions } = require('./wake');

const HANDLERS = {
  opened: require('./handlers/opened'),
  reopened: require('./handlers/opened'),
  labeled: require('./handlers/labeled'),
  assigned: require('./handlers/assigned'),
  unassigned: require('./handlers/unassigned'),
  comment: require('./handlers/comment'),
  pullRequest: require('./handlers/pull-request'),
  sweep: require('./handlers/sweep'),
  setup: require('./handlers/setup'),
};

/** Map a workflow event to a handler name, or null if we do not handle it. */
function route(eventName, payload) {
  const action = payload && payload.action;
  switch (eventName) {
    case 'issues': return ['opened', 'reopened', 'labeled', 'assigned', 'unassigned'].includes(action) ? action : null;
    case 'issue_comment': return action === 'created' || action === 'edited' ? 'comment' : null;
    case 'pull_request':
    case 'pull_request_target': return 'pullRequest';
    case 'schedule': return 'sweep';
    case 'workflow_dispatch': return payload && payload.inputs && payload.inputs.task === 'setup' ? 'setup' : 'sweep';
    default: return null;
  }
}

/**
 * @param {{github: object, context: object, core: object}} env github-script globals
 * @param {{config?: object, now?: Date, cwd?: string}} [opts] test hooks
 */
module.exports = async function referee({ github, context, core }, opts = {}) {
  let config = opts.config;
  if (!config) {
    try {
      config = loadConfig(opts.cwd || process.cwd());
    } catch (e) {
      core.warning(`IssueMesh referee: ${e.message}`);
      return { skipped: 'config' };
    }
  }

  const payload = context.payload || {};
  if (payload.sender && payload.sender.type === 'Bot') {
    core.info(`ignoring event from bot ${payload.sender.login}`);
    return { skipped: 'bot' };
  }
  const handlerName = route(context.eventName, payload);
  if (!handlerName) {
    core.info(`no handler for ${context.eventName}.${payload.action || ''}`);
    return { skipped: 'event' };
  }

  const { owner, repo } = context.repo;
  const now = opts.now || new Date();
  const api = makeApi(github, { owner, repo });
  const executor = createExecutor({ github, context, core });

  const actions = await HANDLERS[handlerName]({ payload, config, now, api, owner, repo });
  core.info(`${context.eventName}.${payload.action || ''} -> ${handlerName}: ${actions.length} action(s)`);
  const result = await executor.run(actions);

  const wake = wakeActions(result.added, config, payload.sender && payload.sender.login);
  if (wake.length) await executor.run(wake);
  return { handler: handlerName, actions: actions.length, errors: result.errors.length, woke: wake.length };
};

module.exports.route = route;
