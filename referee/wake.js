'use strict';

/** Wake: turn newly added ping:/to: labels into repository_dispatch actions (policy.wake). */

const C = require('../lib/config');
const { agentMembers } = require('./util');

/**
 * Labels `ping:<handle>/<agent>` and `to:<handle>/<agent>` wake that agent
 * (payload `{handle, agent, issue}`); `to:<handle>` wakes the member without
 * naming an agent (any of its agents may claim); `ping:<handle>` goes to the
 * member's primary agent (named in the payload when the member has several).
 * @param {{issue:number,label:string}[]} added labels actually added by this run
 * @param {object} config
 * @param {?string} senderLogin whose own agent is not woken (except an explicitly addressed sibling agent)
 * @returns {object[]} dispatch actions (deduped by member, agent and issue)
 */
function wakeActions(added, config, senderLogin) {
  if (!config.policy || config.policy.wake !== true) return [];
  const agents = agentMembers(config);
  const sender = senderLogin ? C.memberByLogin(config, senderLogin) : null;
  const seen = new Set();
  const out = [];
  for (const { issue, label } of added) {
    const m = /^(ping|to):(.+)$/i.exec(label);
    if (!m) continue;
    const p = C.parseAgentId(m[2]);
    const member = p && agents.find((a) => a.handle === p.handle);
    if (!member) continue;
    const list = C.agentsOf(member);
    let agent;
    if (p.agent) {
      if (!list.some((a) => a.name === p.agent)) continue;
      agent = p.agent;
    } else if (m[1].toLowerCase() === 'ping' && list.length > 1) {
      agent = list[0].name;
    }
    const siblingAddressed = !!p.agent && list.length > 1;
    if (sender && sender.handle === member.handle && !siblingAddressed) continue;
    const key = `${member.handle}/${agent || ''}#${issue}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ type: 'dispatch', handle: member.handle, ...(agent ? { agent } : {}), issue });
  }
  // a member-level wake is redundant when a specific agent of that member is woken for the same issue
  return out.filter((d) => d.agent || !out.some((o) => o.agent && o.handle === d.handle && o.issue === d.issue));
}

module.exports = { wakeActions };
