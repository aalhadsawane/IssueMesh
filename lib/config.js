'use strict';

/**
 * IssueMesh team configuration (`.issuemesh/team.json`).
 *
 * Spec: PROTOCOL.md section 1 (Configuration). Parsing, defaulting and
 * validation are pure; only `loadConfig` / `findConfigPath` touch the disk.
 * Unknown fields are preserved and otherwise ignored (forward compatibility).
 */

const fs = require('fs');
const path = require('path');

const HANDLE_RE = /^[a-z0-9][a-z0-9-]{0,19}$/;
/** Agent names follow the handle grammar; an agent id is `<handle>` or `<handle>/<name>`. */
const AGENT_NAME_RE = HANDLE_RE;
const RESERVED_HANDLES = ['referee'];
const CONFIG_REL_PATH = path.join('.issuemesh', 'team.json');
const PERIODS = { daily: 1, weekly: 7 };

/** Defaults from PROTOCOL.md section 1. */
const DEFAULTS = deepFreeze({
  agent: { enabled: true, runtime: 'claude-code', wip: 2 },
  triage: { period: 'daily' },
  policy: {
    lease_minutes: { agent: 120, human: 2880 },
    claim_settle_seconds: 8,
    max_agent_streak: 8,
    decision_window_hours: 24,
    standup: 'daily',
    agents_can_merge: false,
    wake: false,
  },
});

/** Error thrown by `loadConfig`; `errors` holds individual validation messages. */
class ConfigError extends Error {
  constructor(message, errors = []) {
    super(message);
    this.name = 'ConfigError';
    this.errors = errors;
  }
}

function deepFreeze(o) {
  for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(o);
}

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

/** Merge `over` onto `base` one level of objects deep (recursively for plain objects). */
function merge(base, over) {
  const out = clone(base);
  if (!isObj(over)) return out;
  for (const [k, v] of Object.entries(over)) {
    out[k] = isObj(v) && isObj(out[k]) ? merge(out[k], v) : clone(v);
  }
  return out;
}

/** Agent name derived from a runtime string for legacy `agent: {...}` configs ("claude-code" -> "claude"). */
function legacyAgentName(runtime) {
  const base = String(runtime || '').toLowerCase().replace(/-code$/, '').replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20).replace(/-+$/, '');
  return AGENT_NAME_RE.test(base) ? base : 'main';
}

/**
 * The agents of a member (raw or normalized), primary first. `agents` wins over
 * the legacy `agent` object; `agent.enabled === false` means none.
 * @param {object} member
 * @returns {{name: string, runtime: string, wip: number}[]}
 */
function agentsOf(member) {
  if (!member) return [];
  if (Array.isArray(member.agents)) {
    return member.agents.filter(isObj).map((a) => ({
      ...a,
      runtime: a.runtime === undefined ? DEFAULTS.agent.runtime : a.runtime,
      wip: a.wip === undefined ? DEFAULTS.agent.wip : a.wip,
    }));
  }
  const legacy = merge(DEFAULTS.agent, member.agent);
  if (legacy.enabled === false) return [];
  return [{ name: legacyAgentName(legacy.runtime), runtime: legacy.runtime, wip: legacy.wip }];
}

/** @returns {boolean} whether the member has at least one agent */
function hasAgent(member) {
  return agentsOf(member).length > 0;
}

/** @returns {?object} the member's primary (first) agent */
function primaryAgent(member) {
  return agentsOf(member)[0] || null;
}

/**
 * Canonical agent id of a member's agent: `<handle>/<name>` when the member has
 * more than one agent, else the plain `<handle>`. With no agent, the handle.
 * @param {object} member
 * @param {?(string|object)} agent agent name or agent object
 * @returns {string}
 */
function agentId(member, agent) {
  const name = agent && typeof agent === 'object' ? agent.name : agent;
  return name && agentsOf(member).length > 1 ? `${member.handle}/${name}` : member.handle;
}

/**
 * Split `<handle>` / `<handle>/<agent>` (no lookup).
 * @returns {?{handle: string, agent: ?string}} null when malformed
 */
function parseAgentId(id) {
  const parts = String(id === undefined || id === null ? '' : id).trim().toLowerCase().split('/');
  if (parts.length > 2 || !parts.every((x) => AGENT_NAME_RE.test(x))) return null;
  return { handle: parts[0], agent: parts[1] || null };
}

/**
 * Resolve a handle or agent id against the config. A bare handle means the
 * member's primary agent; `handle/name` must name one of the member's agents.
 * The returned `id` is the canonical agent id (see agentId); `address` is the
 * value to use in `to:` / `ping:` labels: the bare handle when the input was a
 * bare handle (member-level), else the canonical id.
 * @param {object} config
 * @param {string} str
 * @returns {?{member: object, agent: ?object, id: string, address: string, handle: string, explicit: boolean}}
 */
function resolveAgent(config, str) {
  const p = parseAgentId(str);
  if (!p) return null;
  const member = ((config && config.members) || []).find((m) => m.handle === p.handle);
  if (!member) return null;
  const agents = agentsOf(member);
  if (p.agent) {
    const agent = agents.find((a) => a.name === p.agent);
    if (!agent) return null;
    const id = agentId(member, agent);
    return { member, agent, id, address: id, handle: member.handle, explicit: true };
  }
  const agent = agents[0] || null;
  return { member, agent, id: agentId(member, agent), address: member.handle, handle: member.handle, explicit: false };
}

/**
 * Fill defaults. Does not validate and never mutates its input.
 * @param {object} raw parsed team.json
 * @returns {object} normalized config
 */
function normalizeConfig(raw) {
  const src = isObj(raw) ? raw : {};
  const members = (Array.isArray(src.members) ? src.members : []).map((m) => {
    const mem = isObj(m) ? clone(m) : {};
    const agents = agentsOf(mem);
    if (Array.isArray(mem.agents)) {
      // `agents` wins: `agent` becomes a derived view of the primary agent
      mem.agent = { enabled: agents.length > 0, runtime: agents.length ? agents[0].runtime : DEFAULTS.agent.runtime, wip: agents.length ? agents[0].wip : DEFAULTS.agent.wip };
    } else {
      mem.agent = merge(DEFAULTS.agent, mem.agent);
    }
    mem.agents = agents;
    if (!Array.isArray(mem.skills)) mem.skills = [];
    if (typeof mem.route_mentions_to_agent !== 'boolean') mem.route_mentions_to_agent = true;
    return mem;
  });

  const triage = merge(DEFAULTS.triage, src.triage);
  if (!Array.isArray(triage.rotation)) {
    triage.rotation = members.filter((m) => m.agents.length > 0).map((m) => m.handle);
  }

  return {
    ...clone(src),
    version: src.version === undefined ? 1 : src.version,
    members,
    areas: isObj(src.areas) ? clone(src.areas) : {},
    triage,
    board_issue: src.board_issue === undefined ? null : src.board_issue,
    policy: merge(DEFAULTS.policy, src.policy),
  };
}

/**
 * Validate a raw (un-normalized) config.
 * @param {*} raw parsed team.json
 * @returns {{ok: boolean, errors: string[]}}
 */
function validateConfig(raw) {
  const errors = [];
  const err = (m) => errors.push(m);
  if (!isObj(raw)) return { ok: false, errors: ['config must be a JSON object'] };

  if (raw.version !== 1) err(`version: must be 1 (got ${JSON.stringify(raw.version)})`);

  const handles = new Set();
  const logins = new Set();
  if (!Array.isArray(raw.members) || raw.members.length === 0) {
    err('members: must be a non-empty array');
  } else {
    raw.members.forEach((m, i) => {
      const at = `members[${i}]`;
      if (!isObj(m)) return err(`${at}: must be an object`);
      if (typeof m.handle !== 'string' || !HANDLE_RE.test(m.handle)) {
        err(`${at}.handle: must match ${HANDLE_RE} (got ${JSON.stringify(m.handle)})`);
      } else if (RESERVED_HANDLES.includes(m.handle)) {
        err(`${at}.handle: "${m.handle}" is a reserved handle`);
      } else if (handles.has(m.handle)) {
        err(`${at}.handle: duplicate handle "${m.handle}"`);
      } else {
        handles.add(m.handle);
      }
      if (typeof m.github !== 'string' || m.github.trim() === '') {
        err(`${at}.github: must be a non-empty string`);
      } else if (logins.has(m.github.toLowerCase())) {
        err(`${at}.github: duplicate login "${m.github}"`);
      } else {
        logins.add(m.github.toLowerCase());
      }
      if (m.agent !== undefined) {
        if (!isObj(m.agent)) err(`${at}.agent: must be an object`);
        else {
          if (m.agent.enabled !== undefined && typeof m.agent.enabled !== 'boolean') err(`${at}.agent.enabled: must be boolean`);
          if (m.agent.runtime !== undefined && typeof m.agent.runtime !== 'string') err(`${at}.agent.runtime: must be a string`);
          if (m.agent.wip !== undefined && !(Number.isInteger(m.agent.wip) && m.agent.wip >= 1)) err(`${at}.agent.wip: must be an integer >= 1`);
        }
      }
      if (m.agents !== undefined) {
        if (!Array.isArray(m.agents)) err(`${at}.agents: must be an array`);
        else {
          const names = new Set();
          m.agents.forEach((a, j) => {
            const aat = `${at}.agents[${j}]`;
            if (!isObj(a)) return err(`${aat}: must be an object`);
            if (typeof a.name !== 'string' || !AGENT_NAME_RE.test(a.name)) err(`${aat}.name: must match ${AGENT_NAME_RE} (got ${JSON.stringify(a.name)})`);
            else if (names.has(a.name)) err(`${aat}.name: duplicate agent name "${a.name}"`);
            else names.add(a.name);
            if (a.runtime !== undefined && typeof a.runtime !== 'string') err(`${aat}.runtime: must be a string`);
            if (a.wip !== undefined && !(Number.isInteger(a.wip) && a.wip >= 1)) err(`${aat}.wip: must be an integer >= 1`);
          });
        }
      }
      if (m.skills !== undefined && !(Array.isArray(m.skills) && m.skills.every((s) => typeof s === 'string'))) {
        err(`${at}.skills: must be an array of strings`);
      }
      if (m.route_mentions_to_agent !== undefined && typeof m.route_mentions_to_agent !== 'boolean') {
        err(`${at}.route_mentions_to_agent: must be boolean`);
      }
    });
  }

  if (raw.areas !== undefined) {
    if (!isObj(raw.areas)) err('areas: must be an object of name -> glob list');
    else {
      for (const [name, globs] of Object.entries(raw.areas)) {
        if (!(Array.isArray(globs) && globs.every((g) => typeof g === 'string'))) err(`areas.${name}: must be an array of glob strings`);
      }
    }
  }

  if (raw.triage !== undefined) {
    if (!isObj(raw.triage)) err('triage: must be an object');
    else {
      const { rotation, period } = raw.triage;
      if (rotation !== undefined) {
        if (!Array.isArray(rotation)) err('triage.rotation: must be an array of handles');
        else {
          rotation.forEach((h, i) => {
            if (typeof h !== 'string' || !handles.has(h)) err(`triage.rotation[${i}]: unknown handle ${JSON.stringify(h)}`);
          });
        }
      }
      if (period !== undefined && !Object.prototype.hasOwnProperty.call(PERIODS, period)) {
        err(`triage.period: must be "daily" or "weekly" (got ${JSON.stringify(period)})`);
      }
    }
  }

  const bi = raw.board_issue;
  if (bi !== undefined && bi !== null && !(Number.isInteger(bi) && bi >= 1)) {
    err('board_issue: must be a positive integer or null');
  }

  if (raw.policy !== undefined) {
    if (!isObj(raw.policy)) err('policy: must be an object');
    else {
      const p = raw.policy;
      if (p.lease_minutes !== undefined) {
        if (!isObj(p.lease_minutes)) err('policy.lease_minutes: must be an object');
        else {
          for (const k of ['agent', 'human']) {
            const v = p.lease_minutes[k];
            if (v !== undefined && !(typeof v === 'number' && Number.isFinite(v) && v > 0)) err(`policy.lease_minutes.${k}: must be a positive number`);
          }
        }
      }
      if (p.claim_settle_seconds !== undefined && !(typeof p.claim_settle_seconds === 'number' && p.claim_settle_seconds >= 0)) {
        err('policy.claim_settle_seconds: must be a number >= 0');
      }
      if (p.max_agent_streak !== undefined && !(Number.isInteger(p.max_agent_streak) && p.max_agent_streak >= 2)) {
        err('policy.max_agent_streak: must be an integer >= 2');
      }
      if (p.decision_window_hours !== undefined && !(typeof p.decision_window_hours === 'number' && p.decision_window_hours > 0)) {
        err('policy.decision_window_hours: must be a positive number');
      }
      if (p.standup !== undefined && typeof p.standup !== 'string') err('policy.standup: must be a string');
      for (const k of ['agents_can_merge', 'wake']) {
        if (p[k] !== undefined && typeof p[k] !== 'boolean') err(`policy.${k}: must be boolean`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Walk up from `cwd` to the git root (inclusive) looking for team.json.
 * @param {string} [cwd]
 * @returns {string|null} absolute path or null
 */
function findConfigPath(cwd = process.cwd()) {
  let dir = path.resolve(cwd);
  for (;;) {
    const candidate = path.join(dir, CONFIG_REL_PATH);
    if (fs.existsSync(candidate)) return candidate;
    if (fs.existsSync(path.join(dir, '.git'))) return null; // reached repo root
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Locate, parse, validate and normalize `.issuemesh/team.json`.
 * @param {string} [cwd]
 * @returns {object} normalized config
 * @throws {ConfigError}
 */
function loadConfig(cwd = process.cwd()) {
  const file = findConfigPath(cwd);
  if (!file) {
    throw new ConfigError(`No ${CONFIG_REL_PATH} found from ${cwd} up to the repository root. Run \`mesh init\`.`);
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new ConfigError(`Cannot parse ${file}: ${e.message}`);
  }
  const { ok, errors } = validateConfig(raw);
  if (!ok) throw new ConfigError(`Invalid ${file}:\n  - ${errors.join('\n  - ')}`, errors);
  return normalizeConfig(raw);
}

/** @returns {object|undefined} member with this handle */
function memberByHandle(config, handle) {
  return ((config && config.members) || []).find((m) => m.handle === handle);
}

/** @returns {object|undefined} member with this GitHub login (case-insensitive) */
function memberByLogin(config, login) {
  if (typeof login !== 'string') return undefined;
  const l = login.toLowerCase();
  return ((config && config.members) || []).find((m) => typeof m.github === 'string' && m.github.toLowerCase() === l);
}

/** @returns {boolean} whether this login belongs to a team member */
function isMember(config, login) {
  return memberByLogin(config, login) !== undefined;
}

/**
 * Handle of the triager on duty: `rotation[floor(unix_days / P) mod len]`.
 * @param {object} config normalized (or raw) config
 * @param {Date} now
 * @returns {string|null}
 */
function triagerOnDuty(config, now) {
  const triage = (config && config.triage) || {};
  const rotation = Array.isArray(triage.rotation)
    ? triage.rotation
    : ((config && config.members) || []).filter(hasAgent).map((m) => m.handle);
  if (rotation.length === 0) return null;
  const P = PERIODS[triage.period] || 1;
  const unixDays = Math.floor(now.getTime() / 86400000);
  const idx = ((Math.floor(unixDays / P) % rotation.length) + rotation.length) % rotation.length;
  return rotation[idx];
}

module.exports = {
  DEFAULTS,
  HANDLE_RE,
  AGENT_NAME_RE,
  legacyAgentName,
  agentsOf,
  hasAgent,
  primaryAgent,
  agentId,
  parseAgentId,
  resolveAgent,
  RESERVED_HANDLES,
  ConfigError,
  normalizeConfig,
  validateConfig,
  findConfigPath,
  loadConfig,
  memberByHandle,
  memberByLogin,
  isMember,
  triagerOnDuty,
};
