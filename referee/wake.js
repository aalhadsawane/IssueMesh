'use strict';

/** Wake: turn newly added ping:/to: labels into repository_dispatch actions (policy.wake). */

const C = require('../lib/config');
const { agentMembers } = require('./util');

/**
 * @param {{issue:number,label:string}[]} added labels actually added by this run
 * @param {object} config
 * @param {?string} senderLogin whose own agent is not woken
 * @returns {object[]} dispatch actions (deduped by handle+issue)
 */
function wakeActions(added, config, senderLogin) {
  if (!config.policy || config.policy.wake !== true) return [];
  const agents = agentMembers(config);
  const sender = senderLogin ? C.memberByLogin(config, senderLogin) : null;
  const seen = new Set();
  const out = [];
  for (const { issue, label } of added) {
    const m = /^(?:ping|to):(.+)$/.exec(label);
    if (!m) continue;
    const member = agents.find((a) => a.handle === m[1].toLowerCase());
    if (!member || (sender && sender.handle === member.handle)) continue;
    const key = `${member.handle}#${issue}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ type: 'dispatch', handle: member.handle, issue });
  }
  return out;
}

module.exports = { wakeActions };
