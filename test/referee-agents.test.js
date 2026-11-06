'use strict';

// Referee behaviour for agent ids (F1), author-verified markers (F2) and agent-aware wake.

const test = require('node:test');
const assert = require('node:assert/strict');

const referee = require('../referee/index.js');
const { wakeActions } = require('../referee/wake');
const P = require('../lib/protocol');
const { normalizeConfig } = require('../lib/config');
const { NOW, iso, makeFake, makeCore, ctx, issuePayload, user } = require('./referee-fake');

const mkConfig = (policy = {}) => normalizeConfig({
  version: 1,
  members: [
    { handle: 'aalhad', github: 'aalhadsawane', agents: [{ name: 'claude' }, { name: 'codex' }] },
    { handle: 'ben', github: 'ben-gh' },
    { handle: 'chen', github: 'chen-gh', agent: { enabled: false } },
  ],
  board_issue: 1,
  policy,
});
const config = mkConfig();
const run = (github, eventName, payload, opts = {}) =>
  referee({ github, context: ctx(eventName, payload), core: opts.core || makeCore() }, { config: opts.config || config, now: NOW });
const labelsOf = (g, n) => [...g.issues.get(n).labels].sort();
const sender = (login) => ({ sender: user(login) });
const msg = (from, type, extra = {}) => P.composeMessage({ from, type, body: 'x', ...extra });

let nextCid = 2000;
async function comment(g, n, login, body, { action = 'created', id, opts } = {}) {
  const issue = g.issues.get(n);
  let c = id && issue.comments.find((x) => x.id === id);
  if (!c) {
    c = { id: id || nextCid++, body, user: user(login), created_at: iso(0) };
    issue.comments.push(c);
  } else c.body = body;
  return run(g, 'issue_comment', { action, issue: issuePayload(g, n), comment: c, ...sender(login) }, opts);
}
const dispatches = (g) => g.named('repos.createDispatchEvent').map((c) => c.p.client_payload);

/* ------------------------------------------------------- slash commands */

test('/route accepts handles, agent ids and logins; single-agent ids collapse; unknown agents are ignored', async () => {
  const g = makeFake({ issues: [{ number: 3, labels: ['status:triage'] }] });
  await comment(g, 3, 'ben-gh', '/route aalhad/codex');
  assert.deepEqual(labelsOf(g, 3), ['status:ready', 'to:aalhad/codex']);
  await comment(g, 3, 'ben-gh', '/route aalhad');
  assert.deepEqual(labelsOf(g, 3), ['status:ready', 'to:aalhad']);
  await comment(g, 3, 'ben-gh', '/route @aalhad/claude');
  assert.deepEqual(labelsOf(g, 3), ['status:ready', 'to:aalhad/claude']);
  await comment(g, 3, 'ben-gh', '/route aalhad/ghost');
  assert.deepEqual(labelsOf(g, 3), ['status:ready', 'to:aalhad/claude'], 'unknown agent: unchanged');
  await comment(g, 3, 'ben-gh', '/route ben/claude');
  assert.deepEqual(labelsOf(g, 3), ['status:ready', 'to:ben']);
  await comment(g, 3, 'ben-gh', '/route aalhadsawane');
  assert.deepEqual(labelsOf(g, 3), ['status:ready', 'to:aalhad']);
  await comment(g, 3, 'ben-gh', '/route chen/x');
  assert.deepEqual(labelsOf(g, 3), ['status:ready', 'to:aalhad']);
});

test('/ping targets: agent ids, handles, logins; members without agents and unknown agents are skipped; all is member level', async () => {
  const g = makeFake({ issues: [{ number: 3 }, { number: 4 }] });
  await comment(g, 3, 'ben-gh', '/ping aalhad/codex aalhad/ghost chen ben-gh');
  assert.deepEqual(labelsOf(g, 3), ['ping:aalhad/codex', 'ping:ben']);
  await comment(g, 4, 'ben-gh', '/ping all');
  assert.deepEqual(labelsOf(g, 4), ['ping:aalhad']); // not ben (sender), not chen (no agent): the member-level mailbox
  await comment(g, 4, 'aalhadsawane', '/ping aalhad/claude');
  assert.deepEqual(labelsOf(g, 4), ['ping:aalhad', 'ping:aalhad/claude']);
});

test('/handoff to an agent id releases the claim, routes and pings that agent', async () => {
  const claim = P.composeMessage({ from: 'aalhad/claude', type: 'claim', lease: iso(60), to: 'any' });
  const g = makeFake({ issues: [{ number: 3, labels: ['status:claimed'], assignees: ['aalhadsawane'], comments: [{ id: 1, body: claim, user: user('aalhadsawane'), created_at: iso(-10) }] }] });
  await comment(g, 3, 'aalhadsawane', '/handoff aalhad/codex');
  assert.equal(P.parseMarker(g.issues.get(3).comments[0].body).type, 'released');
  assert.deepEqual(labelsOf(g, 3), ['ping:aalhad/codex', 'status:ready', 'to:aalhad/codex']);
  assert.deepEqual(g.issues.get(3).assignees, []);
  await comment(g, 3, 'aalhadsawane', '/handoff aalhad/ghost');
  assert.deepEqual(labelsOf(g, 3), ['ping:aalhad/codex', 'status:ready', 'to:aalhad/codex']);
});

test('mentions stay member-level: @login adds ping:<handle> (the primary agent\'s mailbox)', async () => {
  const g = makeFake({ issues: [{ number: 3 }] });
  await comment(g, 3, 'ben-gh', 'cc @aalhadsawane and @chen-gh');
  assert.deepEqual(labelsOf(g, 3), ['ping:aalhad']);
});

/* ------------------------------------------------- verified attribution */

test('claim by an agent id verifies against the member login and sets assignment/status', async () => {
  const g = makeFake({ issues: [{ number: 3, labels: ['status:ready'] }] });
  await comment(g, 3, 'aalhadsawane', msg('aalhad/codex', 'claim', { lease: iso(60) }));
  assert.deepEqual(labelsOf(g, 3), ['status:claimed']);
  assert.deepEqual(g.issues.get(3).assignees, ['aalhadsawane']);
});

test('a forged claim (marker names another member) does nothing', async () => {
  const g = makeFake({ issues: [{ number: 3, labels: ['status:ready'] }] });
  await comment(g, 3, 'ben-gh', msg('aalhad/claude', 'claim', { lease: iso(60) }));
  assert.equal(g.mutations().length, 0);
  // ...and an edit that turns a comment into a forged claim is not a claim either
  const ok = { id: 7, body: 'hello', user: user('ben-gh'), created_at: iso(0) };
  g.issues.get(3).comments.push(ok);
  g.calls.length = 0;
  await comment(g, 3, 'ben-gh', msg('aalhad', 'claim', { lease: iso(60) }), { action: 'edited', id: 7 });
  assert.equal(g.mutations().length, 0);
});

test('a forged claim with a lower id cannot beat a real claim', async () => {
  const g = makeFake({ issues: [{ number: 3, labels: ['status:ready'], comments: [
    { id: 10, body: msg('aalhad/claude', 'claim', { lease: iso(60) }), user: user('ben-gh'), created_at: iso(-5) }, // forged by ben
  ] }] });
  await comment(g, 3, 'ben-gh', msg('ben', 'claim', { lease: iso(60) }), { id: 20 });
  assert.deepEqual(g.issues.get(3).assignees, ['ben-gh']);
  assert.deepEqual(labelsOf(g, 3), ['status:claimed']);
  assert.equal(P.parseMarker(g.issues.get(3).comments.find((c) => c.id === 10).body).type, 'claim', 'the forgery is left alone, not "released"');
});

test('two agents of one member race: lowest id wins; the loser is released but the shared assignee stays', async () => {
  const g = makeFake({ issues: [{ number: 3, labels: ['status:claimed'], assignees: ['aalhadsawane'], comments: [
    { id: 25, body: msg('aalhad/claude', 'claim', { lease: iso(60) }), user: user('aalhadsawane'), created_at: iso(-1) },
  ] }] });
  await comment(g, 3, 'aalhadsawane', msg('aalhad/codex', 'claim', { lease: iso(60) }), { id: 30 });
  const loser = P.parseMarker(g.issues.get(3).comments.find((c) => c.id === 30).body);
  assert.deepEqual([loser.from, loser.type, loser.reason], ['aalhad/codex', 'released', 'lost-race']);
  assert.equal(P.parseMarker(g.issues.get(3).comments.find((c) => c.id === 25).body).type, 'claim');
  assert.deepEqual(g.issues.get(3).assignees, ['aalhadsawane']);
  assert.equal(g.named('issues.removeAssignees').length, 0);
});

test('a /claim by a human still loses to an earlier agent-id claim, with the winner named by agent id', async () => {
  const g = makeFake({ issues: [{ number: 3, labels: ['status:claimed'], assignees: ['aalhadsawane'], comments: [
    { id: 25, body: msg('aalhad/claude', 'claim', { lease: iso(60) }), user: user('aalhadsawane'), created_at: iso(-1) },
  ] }] });
  await comment(g, 3, 'ben-gh', '/claim', { id: 30 });
  const note = g.issues.get(3).comments.at(-1);
  assert.match(note.body, /lost the race to aalhad\/claude/);
});

test('loop guard: two agents of ONE member can trip it; one owner mention', async () => {
  const cfg = mkConfig({ max_agent_streak: 4 });
  const comments = [1, 2, 3].map((i) => ({ id: i, body: msg(i % 2 ? 'aalhad/claude' : 'aalhad/codex', 'note'), user: user('aalhadsawane'), created_at: iso(-10 + i) }));
  const g = makeFake({ issues: [{ number: 3, labels: ['status:claimed'], comments }] });
  await comment(g, 3, 'aalhadsawane', msg('aalhad/claude', 'note'), { opts: { config: cfg } });
  assert.deepEqual(labelsOf(g, 3), ['status:needs-human']);
  const last = g.issues.get(3).comments.at(-1);
  assert.match(last.body, /aalhad\/claude, aalhad\/codex/);
  assert.equal((last.body.match(/@aalhadsawane/g) || []).length, 1);
});

test('loop guard: forged markers do not fill the streak, and the referee\'s own comments count', async () => {
  const cfg = mkConfig({ max_agent_streak: 3 });
  // ben forges "aalhad" notes: they are human comments, so the streak is broken
  const forged = [1, 2, 3].map((i) => ({ id: i, body: msg(i % 2 ? 'aalhad/claude' : 'aalhad/codex', 'note'), user: user('ben-gh'), created_at: iso(-10 + i) }));
  const g = makeFake({ issues: [{ number: 3, labels: ['status:claimed'], comments: forged }] });
  await comment(g, 3, 'aalhadsawane', msg('aalhad/claude', 'note'), { opts: { config: cfg } });
  assert.equal(g.mutations().length, 0);

  const mixed = [
    { id: 1, body: msg('aalhad/claude', 'note'), user: user('aalhadsawane'), created_at: iso(-3) },
    { id: 2, body: msg('referee', 'escalate'), user: { login: 'github-actions[bot]', type: 'Bot' }, created_at: iso(-2) },
  ];
  const h = makeFake({ issues: [{ number: 4, labels: ['status:claimed'], comments: mixed }] });
  await comment(h, 4, 'ben-gh', msg('ben', 'note'), { opts: { config: cfg } });
  assert.deepEqual(labelsOf(h, 4), ['status:needs-human']);
});

test('assigned: a recent agent-id claim by that member is recognized (no extra human-claim record)', async () => {
  const g = makeFake({ issues: [{ number: 3, labels: ['status:ready'], assignees: ['aalhadsawane'], comments: [
    { id: 1, body: msg('aalhad/codex', 'claim', { lease: iso(-1) }), user: user('aalhadsawane'), created_at: iso(-1) },
  ] }] });
  await run(g, 'issues', { action: 'assigned', assignee: user('aalhadsawane'), issue: issuePayload(g, 3), ...sender('ben-gh') });
  assert.equal(g.named('issues.createComment').length, 0);
});

test('referee-recorded human claims (github-actions[bot], from=<member>) verify and are released by unassign', async () => {
  const rec = P.formatMarker({ from: 'ben', actor: 'human', type: 'claim', lease: iso(60) }) + '\nClaimed by ben';
  const g = makeFake({ issues: [{ number: 3, labels: ['status:claimed'], assignees: ['ben-gh'], comments: [
    { id: 1, body: rec, user: { login: 'github-actions[bot]', type: 'Bot' }, created_at: iso(-10) },
  ] }] });
  await run(g, 'issues', { action: 'unassigned', assignee: user('ben-gh'), issue: issuePayload(g, 3), ...sender('ben-gh') });
  assert.equal(P.parseMarker(g.issues.get(3).comments[0].body).type, 'released');
  assert.deepEqual(labelsOf(g, 3), ['status:ready']);
});

/* ---------------------------------------------------------------- wake */

const wakeCfg = mkConfig({ wake: true });

test('wake payload names the agent: explicit agent ids, ping:<handle> of a multi-agent member (primary), none for to:<handle>', async () => {
  const g = makeFake({ issues: [{ number: 3, labels: ['status:triage'] }] });
  await comment(g, 3, 'ben-gh', '/ping aalhad/codex', { opts: { config: wakeCfg } });
  await comment(g, 3, 'ben-gh', '/ping aalhad', { opts: { config: wakeCfg } });
  await comment(g, 3, 'ben-gh', '/route aalhad', { opts: { config: wakeCfg } });
  assert.deepEqual(dispatches(g), [
    { handle: 'aalhad', agent: 'codex', issue: 3 },
    { handle: 'aalhad', agent: 'claude', issue: 3 },
    { handle: 'aalhad', issue: 3 },
  ]);
  const h = makeFake({ issues: [{ number: 4, labels: ['status:ready'] }] });
  await comment(h, 4, 'aalhadsawane', '/route ben\n/ping ben', { opts: { config: wakeCfg } });
  assert.deepEqual(dispatches(h), [{ handle: 'ben', issue: 4 }]);
});

test('wakeActions: agent ids, dedupe, sender rules, unknown agents', () => {
  const w = (added, sender) => wakeActions(added.map(([issue, label]) => ({ issue, label })), wakeCfg, sender);
  assert.deepEqual(w([[1, 'to:aalhad/claude'], [1, 'ping:aalhad/claude']], null), [{ type: 'dispatch', handle: 'aalhad', agent: 'claude', issue: 1 }]);
  // to:<handle> + ping:<handle> of a multi-agent member: one wake, for the primary agent
  assert.deepEqual(w([[1, 'to:aalhad'], [1, 'ping:aalhad']], null), [{ type: 'dispatch', handle: 'aalhad', agent: 'claude', issue: 1 }]);
  assert.deepEqual(w([[1, 'to:aalhad']], null), [{ type: 'dispatch', handle: 'aalhad', issue: 1 }]);
  // two specific agents of the same member are two wakes
  assert.deepEqual(w([[1, 'ping:aalhad/claude'], [1, 'ping:aalhad/codex']], null).map((a) => a.agent), ['claude', 'codex']);
  // the sender's own member is not woken member-level, but a sibling agent addressed explicitly is
  assert.deepEqual(w([[1, 'ping:aalhad'], [1, 'to:aalhad']], 'aalhadsawane'), []);
  assert.deepEqual(w([[1, 'ping:aalhad/codex']], 'aalhadsawane').map((a) => a.agent), ['codex']);
  assert.deepEqual(w([[1, 'ping:ben/claude']], 'ben-gh'), [], 'single-agent member: its own agent is never woken by itself');
  // unknown agent, unknown handle, no-agent member, non-addressing labels
  assert.deepEqual(w([[1, 'ping:aalhad/ghost'], [1, 'ping:zed'], [1, 'ping:chen'], [1, 'to:any'], [1, 'status:ready'], [1, 'ping:a/b/c']], null), []);
  // single-agent member addressed by its agent name
  assert.deepEqual(w([[2, 'to:ben/claude']], null), [{ type: 'dispatch', handle: 'ben', agent: 'claude', issue: 2 }]);
  assert.deepEqual(w([[2, 'ping:ben']], null), [{ type: 'dispatch', handle: 'ben', issue: 2 }]);
});

/* --------------------------------------------------------------- setup */

test('setup creates handle labels for all members and agent labels only for multi-agent members', async () => {
  const g = makeFake();
  await run(g, 'workflow_dispatch', { inputs: { task: 'setup' } }, { config: normalizeConfig({ ...config, board_issue: null }) });
  const names = new Set(g.repoLabels.map((l) => l.name));
  for (const n of ['to:aalhad', 'to:aalhad/claude', 'to:aalhad/codex', 'ping:aalhad/codex', 'ping:ben', 'ping:chen', 'to:ben']) assert.ok(names.has(n), n);
  assert.ok(![...names].some((n) => /^(to|ping):(ben|chen)\//.test(n)));
  assert.equal(g.repoLabels.length, P.standardLabels(config.members).length);
});
