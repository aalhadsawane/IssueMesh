'use strict';

// Tests for lib/config.js. Spec: PROTOCOL.md section 1.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('../lib/config');

const valid = () => ({
  version: 1,
  members: [
    { handle: 'aalhad', github: 'aalhadsawane', agent: { enabled: true, runtime: 'claude-code', wip: 2 }, skills: ['backend'] },
    { handle: 'bob', github: 'Bob-GH', agent: { enabled: false } },
    { handle: 'chen', github: 'chen-gh' },
  ],
  triage: { rotation: ['aalhad', 'chen'] },
});

test('DEFAULTS match PROTOCOL section 1 and are frozen', () => {
  assert.deepEqual(C.DEFAULTS.policy, {
    lease_minutes: { agent: 120, human: 2880 },
    claim_settle_seconds: 8,
    max_agent_streak: 8,
    decision_window_hours: 24,
    standup: 'daily',
    agents_can_merge: false,
    wake: false,
  });
  assert.equal(C.DEFAULTS.agent.wip, 2);
  assert.equal(C.DEFAULTS.agent.enabled, true);
  assert.throws(() => { C.DEFAULTS.policy.wake = true; });
});

test('validateConfig accepts a valid config', () => {
  assert.deepEqual(C.validateConfig(valid()), { ok: true, errors: [] });
});

test('validateConfig accepts the PROTOCOL example verbatim', () => {
  const ex = {
    version: 1,
    members: [{ handle: 'aalhad', github: 'aalhadsawane', agent: { enabled: true, runtime: 'claude-code', wip: 2 }, skills: ['backend', 'infra'], route_mentions_to_agent: true }],
    areas: { backend: ['server/**'], frontend: ['web/**'] },
    triage: { rotation: ['aalhad'], period: 'daily' },
    board_issue: 1,
    policy: { lease_minutes: { agent: 120, human: 2880 }, claim_settle_seconds: 8, max_agent_streak: 8, decision_window_hours: 24, standup: 'daily', agents_can_merge: false, wake: false },
  };
  assert.deepEqual(C.validateConfig(ex), { ok: true, errors: [] });
});

test('validateConfig ignores unknown fields', () => {
  const c = valid();
  c.future = { x: 1 };
  c.members[0].extra = true;
  c.policy = { novel: 1 };
  assert.equal(C.validateConfig(c).ok, true);
});

function errorsFor(mutate) {
  const c = valid();
  mutate(c);
  const r = C.validateConfig(c);
  assert.equal(r.ok, false);
  return r.errors.join('\n');
}

test('validateConfig: non-object / bad version / members', () => {
  assert.equal(C.validateConfig(null).ok, false);
  assert.equal(C.validateConfig([]).ok, false);
  assert.equal(C.validateConfig('x').ok, false);
  assert.match(errorsFor((c) => { c.version = 2; }), /version/);
  assert.match(errorsFor((c) => { delete c.version; }), /version/);
  assert.match(errorsFor((c) => { c.members = []; }), /members/);
  assert.match(errorsFor((c) => { delete c.members; }), /members/);
  assert.match(errorsFor((c) => { c.members = [5]; }), /members\[0\]/);
});

test('validateConfig: handle rules', () => {
  assert.match(errorsFor((c) => { c.members[0].handle = 'Bad Handle'; }), /members\[0\]\.handle/);
  assert.match(errorsFor((c) => { c.members[0].handle = '-x'; }), /handle/);
  assert.match(errorsFor((c) => { c.members[0].handle = 'a'.repeat(21); }), /handle/);
  assert.match(errorsFor((c) => { c.members[0].handle = 'UPPER'; }), /handle/);
  assert.match(errorsFor((c) => { delete c.members[0].handle; }), /handle/);
  assert.match(errorsFor((c) => { c.members[1].handle = 'aalhad'; }), /duplicate handle/);
  assert.match(errorsFor((c) => { c.members[0].handle = 'referee'; }), /reserved/);
  const ok = valid();
  ok.members[0].handle = 'a'.repeat(20);
  ok.triage = {};
  assert.equal(C.validateConfig(ok).ok, true);
});

test('validateConfig: github login rules (unique case-insensitive)', () => {
  assert.match(errorsFor((c) => { c.members[0].github = ''; }), /github/);
  assert.match(errorsFor((c) => { delete c.members[0].github; }), /github/);
  assert.match(errorsFor((c) => { c.members[2].github = 'BOB-gh'; }), /duplicate login/);
});

test('validateConfig: agent, skills, route_mentions_to_agent', () => {
  assert.match(errorsFor((c) => { c.members[0].agent = 'yes'; }), /agent/);
  assert.match(errorsFor((c) => { c.members[0].agent.wip = 0; }), /wip/);
  assert.match(errorsFor((c) => { c.members[0].agent.wip = 1.5; }), /wip/);
  assert.match(errorsFor((c) => { c.members[0].agent.enabled = 'true'; }), /enabled/);
  assert.match(errorsFor((c) => { c.members[0].skills = 'backend'; }), /skills/);
  assert.match(errorsFor((c) => { c.members[0].skills = [1]; }), /skills/);
  assert.match(errorsFor((c) => { c.members[0].route_mentions_to_agent = 'no'; }), /route_mentions/);
});

test('validateConfig: areas, triage, board_issue', () => {
  assert.match(errorsFor((c) => { c.areas = []; }), /areas/);
  assert.match(errorsFor((c) => { c.areas = { x: 'server/**' }; }), /areas\.x/);
  assert.match(errorsFor((c) => { c.triage.rotation = ['ghost']; }), /triage\.rotation\[0\].*ghost/);
  assert.match(errorsFor((c) => { c.triage.rotation = 'aalhad'; }), /rotation/);
  assert.match(errorsFor((c) => { c.triage.period = 'monthly'; }), /period/);
  assert.match(errorsFor((c) => { c.triage = 3; }), /triage/);
  assert.match(errorsFor((c) => { c.board_issue = 0; }), /board_issue/);
  assert.match(errorsFor((c) => { c.board_issue = 1.5; }), /board_issue/);
  assert.match(errorsFor((c) => { c.board_issue = '1'; }), /board_issue/);
  const ok = valid();
  ok.board_issue = null;
  assert.equal(C.validateConfig(ok).ok, true);
});

test('validateConfig: policy', () => {
  assert.match(errorsFor((c) => { c.policy = 1; }), /policy/);
  assert.match(errorsFor((c) => { c.policy = { lease_minutes: { agent: -5 } }; }), /lease_minutes\.agent/);
  assert.match(errorsFor((c) => { c.policy = { lease_minutes: { human: 'x' } }; }), /lease_minutes\.human/);
  assert.match(errorsFor((c) => { c.policy = { lease_minutes: 5 }; }), /lease_minutes/);
  assert.match(errorsFor((c) => { c.policy = { claim_settle_seconds: -1 }; }), /claim_settle_seconds/);
  assert.match(errorsFor((c) => { c.policy = { max_agent_streak: 1 }; }), /max_agent_streak/);
  assert.match(errorsFor((c) => { c.policy = { decision_window_hours: 0 }; }), /decision_window_hours/);
  assert.match(errorsFor((c) => { c.policy = { agents_can_merge: 'no' }; }), /agents_can_merge/);
  assert.match(errorsFor((c) => { c.policy = { wake: 1 }; }), /wake/);
  assert.match(errorsFor((c) => { c.policy = { standup: 3 }; }), /standup/);
  const ok = valid();
  ok.policy = { claim_settle_seconds: 0, wake: true };
  assert.equal(C.validateConfig(ok).ok, true);
});

test('validateConfig reports all errors at once', () => {
  const r = C.validateConfig({ version: 3, members: [{ handle: 'BAD' }] });
  assert.ok(r.errors.length >= 3);
});

test('normalizeConfig fills defaults and does not mutate', () => {
  const raw = valid();
  const frozen = JSON.stringify(raw);
  const n = C.normalizeConfig(raw);
  assert.equal(JSON.stringify(raw), frozen);

  assert.deepEqual(n.members[0].agent, { enabled: true, runtime: 'claude-code', wip: 2 });
  assert.deepEqual(n.members[1].agent, { enabled: false, runtime: 'claude-code', wip: 2 });
  assert.deepEqual(n.members[2].agent, { enabled: true, runtime: 'claude-code', wip: 2 });
  assert.deepEqual(n.members[1].skills, []);
  assert.equal(n.members[0].route_mentions_to_agent, true);
  assert.deepEqual(n.areas, {});
  assert.equal(n.board_issue, null);
  assert.equal(n.triage.period, 'daily');
  assert.deepEqual(n.triage.rotation, ['aalhad', 'chen']);
  assert.deepEqual(n.policy, C.DEFAULTS.policy);
  assert.equal(n.policy.wake, false);
});

test('normalizeConfig: partial policy merges, explicit values kept', () => {
  const raw = valid();
  raw.policy = { lease_minutes: { agent: 30 }, wake: true };
  raw.members[0].route_mentions_to_agent = false;
  raw.members[2].agent = { wip: 5 };
  raw.board_issue = 7;
  raw.extra = { keep: 1 };
  const n = C.normalizeConfig(raw);
  assert.deepEqual(n.policy.lease_minutes, { agent: 30, human: 2880 });
  assert.equal(n.policy.wake, true);
  assert.equal(n.policy.max_agent_streak, 8);
  assert.equal(n.members[0].route_mentions_to_agent, false);
  assert.deepEqual(n.members[2].agent, { enabled: true, runtime: 'claude-code', wip: 5 });
  assert.equal(n.board_issue, 7);
  assert.deepEqual(n.extra, { keep: 1 });
});

test('normalizeConfig: default rotation is agent-enabled members; explicit kept', () => {
  const raw = valid();
  delete raw.triage;
  assert.deepEqual(C.normalizeConfig(raw).triage.rotation, ['aalhad', 'chen']);
  raw.triage = { period: 'weekly' };
  const n = C.normalizeConfig(raw);
  assert.equal(n.triage.period, 'weekly');
  assert.deepEqual(n.triage.rotation, ['aalhad', 'chen']);
  raw.triage = { rotation: ['bob'] };
  assert.deepEqual(C.normalizeConfig(raw).triage.rotation, ['bob']);
});

test('normalizeConfig of defaults does not share references with DEFAULTS', () => {
  const n = C.normalizeConfig(valid());
  n.policy.lease_minutes.agent = 1;
  n.members[2].agent.wip = 9;
  assert.equal(C.DEFAULTS.policy.lease_minutes.agent, 120);
  assert.equal(C.DEFAULTS.agent.wip, 2);
});

test('member lookups', () => {
  const n = C.normalizeConfig(valid());
  assert.equal(C.memberByHandle(n, 'bob').github, 'Bob-GH');
  assert.equal(C.memberByHandle(n, 'nobody'), undefined);
  assert.equal(C.memberByLogin(n, 'bob-gh').handle, 'bob');
  assert.equal(C.memberByLogin(n, 'BOB-GH').handle, 'bob');
  assert.equal(C.memberByLogin(n, 'nobody'), undefined);
  assert.equal(C.memberByLogin(n, undefined), undefined);
  assert.equal(C.isMember(n, 'AalhadSawane'), true);
  assert.equal(C.isMember(n, 'stranger'), false);
  assert.equal(C.isMember(n, null), false);
});

test('triagerOnDuty daily rotation math', () => {
  const n = C.normalizeConfig(valid()); // rotation aalhad, chen
  const day = (d, h = 0) => new Date(d * 86400000 + h * 3600000);
  assert.equal(C.triagerOnDuty(n, day(0)), 'aalhad');
  assert.equal(C.triagerOnDuty(n, day(1)), 'chen');
  assert.equal(C.triagerOnDuty(n, day(2)), 'aalhad');
  assert.equal(C.triagerOnDuty(n, day(1, 23.99)), 'chen'); // UTC boundary
  assert.equal(C.triagerOnDuty(n, day(2, 0)), 'aalhad');
  assert.equal(C.triagerOnDuty(n, new Date('2026-11-06T12:00:00Z')), 'chen'); // day 20763 (odd)
});

test('triagerOnDuty weekly rotation and 3-way rotation', () => {
  const raw = valid();
  raw.triage = { rotation: ['aalhad', 'bob', 'chen'], period: 'weekly' };
  const n = C.normalizeConfig(raw);
  const day = (d) => new Date(d * 86400000);
  assert.equal(C.triagerOnDuty(n, day(0)), 'aalhad');
  assert.equal(C.triagerOnDuty(n, day(6)), 'aalhad');
  assert.equal(C.triagerOnDuty(n, day(7)), 'bob');
  assert.equal(C.triagerOnDuty(n, day(14)), 'chen');
  assert.equal(C.triagerOnDuty(n, day(21)), 'aalhad');
  assert.equal(C.triagerOnDuty(n, day(21 * 1000 + 8)), 'bob');
});

test('triagerOnDuty: empty rotation -> null; pre-1970 does not go negative', () => {
  const raw = valid();
  raw.triage = { rotation: [] };
  assert.equal(C.triagerOnDuty(C.normalizeConfig(raw), new Date()), null);
  const n = C.normalizeConfig(valid());
  assert.ok(['aalhad', 'chen'].includes(C.triagerOnDuty(n, new Date('1969-06-01T00:00:00Z'))));
});

test('triagerOnDuty works on a raw (un-normalized) config', () => {
  assert.equal(C.triagerOnDuty(valid(), new Date(0)), 'aalhad');
  assert.equal(C.triagerOnDuty({ members: [{ handle: 'x', github: 'x' }] }, new Date(0)), 'x');
});

test('loadConfig finds team.json walking up to the git root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issuemesh-'));
  try {
    fs.mkdirSync(path.join(root, '.git'));
    fs.mkdirSync(path.join(root, '.issuemesh'));
    fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
    fs.writeFileSync(path.join(root, '.issuemesh', 'team.json'), JSON.stringify(valid()));
    const c = C.loadConfig(path.join(root, 'a', 'b'));
    assert.equal(c.members.length, 3);
    assert.equal(c.policy.wake, false);
    assert.equal(C.findConfigPath(root), path.join(root, '.issuemesh', 'team.json'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('loadConfig errors: missing, unparsable, invalid', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issuemesh-'));
  try {
    fs.mkdirSync(path.join(root, '.git'));
    assert.throws(() => C.loadConfig(root), (e) => e instanceof C.ConfigError && /mesh init/.test(e.message));
    fs.mkdirSync(path.join(root, '.issuemesh'));
    fs.writeFileSync(path.join(root, '.issuemesh', 'team.json'), '{ nope');
    assert.throws(() => C.loadConfig(root), (e) => e instanceof C.ConfigError && /Cannot parse/.test(e.message));
    fs.writeFileSync(path.join(root, '.issuemesh', 'team.json'), JSON.stringify({ version: 1, members: [{ handle: 'referee', github: 'x' }] }));
    assert.throws(() => C.loadConfig(root), (e) => e instanceof C.ConfigError && /reserved/.test(e.message) && e.errors.length === 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('loadConfig does not search above the git root', () => {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'issuemesh-'));
  try {
    fs.mkdirSync(path.join(outer, '.issuemesh'));
    fs.writeFileSync(path.join(outer, '.issuemesh', 'team.json'), JSON.stringify(valid()));
    fs.mkdirSync(path.join(outer, 'repo', '.git'), { recursive: true });
    assert.throws(() => C.loadConfig(path.join(outer, 'repo')), C.ConfigError);
  } finally {
    fs.rmSync(outer, { recursive: true, force: true });
  }
});

/* ------------------------------------------------- multiple agents (F1) --- */

const multi = () => ({
  version: 1,
  members: [
    { handle: 'aalhad', github: 'aalhadsawane', agents: [{ name: 'claude', runtime: 'claude-code', wip: 2 }, { name: 'codex', runtime: 'codex', wip: 1 }] },
    { handle: 'bob', github: 'bob-gh', agent: { runtime: 'codex', wip: 3 } },
    { handle: 'chen', github: 'chen-gh', agent: { enabled: false } },
    { handle: 'dev', github: 'dev-gh' },
    { handle: 'eli', github: 'eli-gh', agents: [] },
  ],
});

test('normalizeConfig: agents array is kept, defaulted per agent, and primary first', () => {
  const raw = multi();
  raw.members[0].agents[0] = { name: 'claude' };
  const n = C.normalizeConfig(raw);
  assert.deepEqual(n.members[0].agents, [
    { name: 'claude', runtime: 'claude-code', wip: 2 },
    { name: 'codex', runtime: 'codex', wip: 1 },
  ]);
  assert.deepEqual(n.members[0].agent, { enabled: true, runtime: 'claude-code', wip: 2 }); // derived view of the primary
});

test('normalizeConfig: legacy agent becomes a one-element agents array (name derived from runtime)', () => {
  const n = C.normalizeConfig(multi());
  assert.deepEqual(n.members[1].agents, [{ name: 'codex', runtime: 'codex', wip: 3 }]);
  assert.deepEqual(n.members[3].agents, [{ name: 'claude', runtime: 'claude-code', wip: 2 }]);
  assert.deepEqual(n.members[2].agents, []); // enabled: false
  assert.deepEqual(n.members[4].agents, []); // explicit empty array
  assert.equal(n.members[4].agent.enabled, false);
  assert.ok(n.members.every((m) => Array.isArray(m.agents)));
});

test('normalizeConfig: agents wins over the legacy agent object', () => {
  const raw = multi();
  raw.members[0].agent = { enabled: false, runtime: 'cursor', wip: 9 };
  const n = C.normalizeConfig(raw);
  assert.equal(n.members[0].agents.length, 2);
  assert.deepEqual(n.members[0].agent, { enabled: true, runtime: 'claude-code', wip: 2 });
});

test('normalizeConfig: default triage rotation is every member with an agent', () => {
  assert.deepEqual(C.normalizeConfig(multi()).triage.rotation, ['aalhad', 'bob', 'dev']);
});

test('legacyAgentName: runtime-derived names fall back to "main"', () => {
  assert.equal(C.legacyAgentName('claude-code'), 'claude');
  assert.equal(C.legacyAgentName('codex'), 'codex');
  assert.equal(C.legacyAgentName('Cursor Agent'), 'cursor-agent');
  assert.equal(C.legacyAgentName(''), 'main');
  assert.equal(C.legacyAgentName('***'), 'main');
});

test('validateConfig: agents shape, names, uniqueness, wip', () => {
  assert.equal(C.validateConfig(multi()).ok, true);
  assert.match(multiErrors((c) => { c.members[0].agents = 'x'; }, multi), /agents: must be an array/);
  assert.match(multiErrors((c) => { c.members[0].agents = [7]; }, multi), /agents\[0\]: must be an object/);
  assert.match(multiErrors((c) => { c.members[0].agents = [{ runtime: 'x' }]; }, multi), /agents\[0\]\.name/);
  assert.match(multiErrors((c) => { c.members[0].agents[0].name = 'Claude'; }, multi), /agents\[0\]\.name/);
  assert.match(multiErrors((c) => { c.members[0].agents[0].name = 'a/b'; }, multi), /agents\[0\]\.name/);
  assert.match(multiErrors((c) => { c.members[0].agents[1].name = 'claude'; }, multi), /duplicate agent name "claude"/);
  assert.match(multiErrors((c) => { c.members[0].agents[0].wip = 0; }, multi), /agents\[0\]\.wip/);
  assert.match(multiErrors((c) => { c.members[0].agents[0].runtime = 5; }, multi), /agents\[0\]\.runtime/);
  // same name under different members is fine
  const ok = multi();
  ok.members[1].agents = [{ name: 'claude' }];
  assert.equal(C.validateConfig(ok).ok, true);
});

function multiErrors(mutate, base) {
  const raw = base();
  mutate(raw);
  return C.validateConfig(raw).errors.join('\n');
}

test('agentsOf / hasAgent / primaryAgent work on raw and normalized members', () => {
  const raw = multi();
  assert.deepEqual(C.agentsOf(raw.members[1]).map((a) => a.name), ['codex']);
  assert.deepEqual(C.agentsOf(raw.members[2]), []);
  assert.deepEqual(C.agentsOf(null), []);
  assert.equal(C.hasAgent(raw.members[3]), true);
  assert.equal(C.hasAgent(raw.members[4]), false);
  assert.equal(C.primaryAgent(raw.members[0]).name, 'claude');
  assert.equal(C.primaryAgent(raw.members[4]), null);
});

test('agentId is canonical: slash form only for members with several agents', () => {
  const n = C.normalizeConfig(multi());
  assert.equal(C.agentId(n.members[0], 'codex'), 'aalhad/codex');
  assert.equal(C.agentId(n.members[0], n.members[0].agents[0]), 'aalhad/claude');
  assert.equal(C.agentId(n.members[1], 'codex'), 'bob');
  assert.equal(C.agentId(n.members[2], null), 'chen');
});

test('parseAgentId and resolveAgent', () => {
  assert.deepEqual(C.parseAgentId('Aalhad/Claude'), { handle: 'aalhad', agent: 'claude' });
  assert.deepEqual(C.parseAgentId('aalhad'), { handle: 'aalhad', agent: null });
  for (const bad of ['', 'a/b/c', '/x', 'a/', 'A B', 'a/b c']) assert.equal(C.parseAgentId(bad), null, bad);

  const n = C.normalizeConfig(multi());
  let r = C.resolveAgent(n, 'aalhad');
  assert.deepEqual([r.id, r.address, r.explicit, r.agent.name], ['aalhad/claude', 'aalhad', false, 'claude']);
  r = C.resolveAgent(n, 'aalhad/codex');
  assert.deepEqual([r.id, r.address, r.explicit, r.agent.name], ['aalhad/codex', 'aalhad/codex', true, 'codex']);
  r = C.resolveAgent(n, 'bob/codex'); // sole agent: canonical id collapses to the handle
  assert.deepEqual([r.id, r.address], ['bob', 'bob']);
  assert.equal(C.resolveAgent(n, 'bob/claude'), null);
  assert.equal(C.resolveAgent(n, 'nobody'), null);
  assert.equal(C.resolveAgent(n, 'aalhad/ghost'), null);
  r = C.resolveAgent(n, 'chen');
  assert.deepEqual([r.agent, r.id], [null, 'chen']);
  assert.equal(C.resolveAgent(n, 'chen/claude'), null);
});

test('triagerOnDuty default rotation counts members with agents (raw config)', () => {
  const raw = multi();
  const seen = new Set();
  for (let d = 0; d < 6; d++) seen.add(C.triagerOnDuty(raw, new Date(Date.UTC(2026, 10, 1 + d))));
  assert.deepEqual([...seen].sort(), ['aalhad', 'bob', 'dev']);
});

test('the shipped template team.json validates and shows two agents for aalhad', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'templates', '.issuemesh', 'team.json'), 'utf8'));
  assert.equal(C.validateConfig(raw).ok, true);
  const n = C.normalizeConfig(raw);
  assert.deepEqual(n.members[0].agents.map((a) => a.name), ['claude', 'codex']);
  assert.ok(n.members.slice(1).every((m) => m.agents.length === 1));
});

test('the JSON schema allows agents and the legacy agent object', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'schema', 'team.schema.json'), 'utf8'));
  const props = schema.properties.members.items.properties;
  assert.equal(props.agents.type, 'array');
  assert.deepEqual(props.agents.items.required, ['name']);
  assert.equal(props.agents.items.properties.name.pattern, '^[a-z0-9][a-z0-9-]{0,19}$');
  assert.equal(props.agent.type, 'object');
});
