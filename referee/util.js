'use strict';

/** Shared helpers for referee handlers. Pure: no I/O. */

const P = require('../lib/protocol');
const C = require('../lib/config');

/** Namespaces with at most one label per issue (PROTOCOL.md section 2). */
const ONE_NAMESPACES = ['status', 'to', 'kind', 'priority', 'size'];

/** Label names from an octokit label array (strings or {name}). */
function labelNames(labels) {
  return (labels || []).map((l) => (typeof l === 'string' ? l : l && l.name)).filter(Boolean);
}

/** Options for protocol claim functions. */
function claimOpts(config, now) {
  return {
    now,
    humanLeaseMinutes: config.policy.lease_minutes.human,
    resolveHandle: (login) => {
      const m = C.memberByLogin(config, login);
      return m ? m.handle : null;
    },
  };
}

/** Members whose agent is enabled. */
function agentMembers(config) {
  return config.members.filter((m) => !m.agent || m.agent.enabled !== false);
}

/**
 * Resolve a command argument (handle or GitHub login) to a member.
 * @returns {?object}
 */
function resolveMember(config, arg) {
  const a = String(arg || '').toLowerCase();
  return C.memberByHandle(config, a) || C.memberByLogin(config, a) || null;
}

/** A comment written by the referee: marker from=referee actor=agent. */
function refereeMessage(type, body, extra = {}) {
  return `${P.formatMarker({ from: 'referee', type, ...extra })}\n${String(body).replace(/\s+$/, '')}\n\n<sub>IssueMesh referee</sub>`;
}

/** Issue numbers closed by a PR text: "Closes #1", "fixes owner/repo#2". Same-repo only. */
function closingRefs(text, owner, repo) {
  const re = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b\s*:?\s+(?:([\w.-]+\/[\w.-]+))?#(\d+)/gi;
  const out = [];
  for (const m of String(text || '').matchAll(re)) {
    if (m[1] && m[1].toLowerCase() !== `${owner}/${repo}`.toLowerCase()) continue;
    const n = Number(m[2]);
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/**
 * End the given claims. Marker claims have their comment edited to
 * `type=released`; unmarked human claims need no edit (a later `/release` or
 * their lease kills them).
 * @param {object} plan
 * @param {object[]} claims from protocol.extractClaims/liveClaims
 * @param {Map<number, object>} byId comments by id
 * @param {string} reason
 * @returns {?string} the `to` value recorded in the newest released marker, if any
 */
function releaseClaims(plan, claims, byId, reason) {
  let restoreTo = null;
  for (const cl of [...claims].sort((a, b) => a.commentId - b.commentId)) {
    const c = byId.get(cl.commentId);
    const marker = c && P.parseMarker(c.body);
    if (!marker) continue;
    if (marker.to) restoreTo = marker.to;
    if (marker.type === 'claim') plan.updateComment(c.id, P.replaceMarker(c.body, { type: 'released', reason }));
  }
  return restoreTo;
}

module.exports = { ONE_NAMESPACES, labelNames, claimOpts, agentMembers, resolveMember, refereeMessage, closingRefs, releaseClaims };
