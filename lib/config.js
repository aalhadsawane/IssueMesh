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

/**
 * Fill defaults. Does not validate and never mutates its input.
 * @param {object} raw parsed team.json
 * @returns {object} normalized config
 */
function normalizeConfig(raw) {
  const src = isObj(raw) ? raw : {};
  const members = (Array.isArray(src.members) ? src.members : []).map((m) => {
    const mem = isObj(m) ? clone(m) : {};
    mem.agent = merge(DEFAULTS.agent, mem.agent);
    if (!Array.isArray(mem.skills)) mem.skills = [];
    if (typeof mem.route_mentions_to_agent !== 'boolean') mem.route_mentions_to_agent = true;
    return mem;
  });

  const triage = merge(DEFAULTS.triage, src.triage);
  if (!Array.isArray(triage.rotation)) {
    triage.rotation = members.filter((m) => m.agent.enabled).map((m) => m.handle);
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
    : ((config && config.members) || []).filter((m) => !m.agent || m.agent.enabled !== false).map((m) => m.handle);
  if (rotation.length === 0) return null;
  const P = PERIODS[triage.period] || 1;
  const unixDays = Math.floor(now.getTime() / 86400000);
  const idx = ((Math.floor(unixDays / P) % rotation.length) + rotation.length) % rotation.length;
  return rotation[idx];
}

module.exports = {
  DEFAULTS,
  HANDLE_RE,
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
