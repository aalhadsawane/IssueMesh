'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const referee = require('../referee/index.js');
const { createExecutor } = require('../referee/executor');
const { wakeActions } = require('../referee/wake');
const P = require('../lib/protocol');
const { NOW, iso, makeConfig, makeFake, makeCore, ctx, issuePayload, user, claimBody } = require('./referee-fake');

const config = makeConfig();
const run = (github, eventName, payload, opts = {}) =>
  referee({ github, context: ctx(eventName, payload), core: opts.core || makeCore() }, { config: opts.config || config, now: NOW });

const labelsOf = (g, n) => [...g.issues.get(n).labels].sort();
const sender = (login) => ({ sender: user(login) });

/* ------------------------------------------------------------- entry ---- */

test('missing config: warns and does nothing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-ref-'));
  fs.mkdirSync(path.join(dir, '.git'));
  const g = makeFake();
  const core = makeCore();
  const res = await referee({ github: g, context: ctx('schedule', {}), core }, { cwd: dir });
  assert.equal(res.skipped, 'config');
  assert.equal(core.log.warning.length, 1);
  assert.equal(g.calls.length, 0);
});

test('loads .issuemesh/team.json from cwd', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-ref-'));
  fs.mkdirSync(path.join(dir, '.git'));
  fs.mkdirSync(path.join(dir, '.issuemesh'));
  fs.writeFileSync(path.join(dir, '.issuemesh', 'team.json'), JSON.stringify({ version: 1, members: [{ handle: 'aalhad', github: 'aalhadsawane' }] }));
  const g = makeFake({ issues: [{ number: 3 }] });
  const res = await referee({ github: g, context: ctx('issues', { action: 'opened', issue: issuePayload(g, 3), ...sender('aalhadsawane') }), core: makeCore() }, { cwd: dir, now: NOW });
  assert.equal(res.handler, 'opened');
  assert.deepEqual(labelsOf(g, 3), ['status:triage']);
});

test('events from bots are ignored', async () => {
  const g = makeFake({ issues: [{ number: 3 }] });
  const res = await run(g, 'issues', { action: 'opened', issue: issuePayload(g, 3), sender: { login: 'dependabot[bot]', type: 'Bot' } });
  assert.equal(res.skipped, 'bot');
  assert.equal(g.calls.length, 0);
});

test('unhandled events are skipped', async () => {
  const g = makeFake();
  assert.equal((await run(g, 'issues', { action: 'closed', ...sender('ben-gh') })).skipped, 'event');
  assert.equal((await run(g, 'push', {})).skipped, 'event');
});

/* ------------------------------------------------------------ opened ---- */

test('opened: adds status:triage; member issue is not external', async () => {
  const g = makeFake({ issues: [{ number: 3, labels: ['kind:task'] }] });
  await run(g, 'issues', { action: 'opened', issue: issuePayload(g, 3), ...sender('aalhadsawane') });
  assert.deepEqual(labelsOf(g, 3), ['kind:task', 'status:triage']);
});

test('opened: non-member author gets source:external', async () => {
  const g = makeFake({ issues: [{ number: 3, user: { login: 'stranger' } }] });
  await run(g, 'issues', { action: 'opened', issue: issuePayload(g, 3), ...sender('stranger') });
  assert.deepEqual(labelsOf(g, 3), ['source:external', 'status:triage']);
});

test('opened: keeps an existing status and ignores the Board', async () => {
  const g = makeFake({ issues: [{ number: 3, labels: ['status:ready'] }, { number: 4, labels: ['kind:board'] }] });
  await run(g, 'issues', { action: 'opened', issue: issuePayload(g, 3), ...sender('ben-gh') });
  await run(g, 'issues', { action: 'opened', issue: issuePayload(g, 4), ...sender('ben-gh') });
  assert.deepEqual(labelsOf(g, 3), ['status:ready']);
  assert.deepEqual(labelsOf(g, 4), ['kind:board']);
  assert.equal(g.mutations().length, 0);
});

test('reopened: restores a default status', async () => {
  const g = makeFake({ issues: [{ number: 3 }] });
  await run(g, 'issues', { action: 'reopened', issue: issuePayload(g, 3), ...sender('ben-gh') });
  assert.deepEqual(labelsOf(g, 3), ['status:triage']);
});

/* ----------------------------------------------------------- labeled ---- */

test('labeled: keeps the newest label of a one-per-namespace', async () => {
  const g = makeFake({ issues: [{ number: 3, labels: ['status:ready', 'to:ben', 'status:claimed', 'priority:p1'] }] });
  await run(g, 'issues', { action: 'labeled', label: { name: 'status:claimed' }, issue: issuePayload(g, 3), ...sender('ben-gh') });
  assert.deepEqual(labelsOf(g, 3), ['priority:p1', 'status:claimed', 'to:ben']);
});

test('labeled: ping and unknown labels are not exclusive', async () => {
  const g = makeFake({ issues: [{ number: 3, labels: ['ping:ben', 'ping:aalhad', 'bug-ish'] }] });
  await run(g, 'issues', { action: 'labeled', label: { name: 'ping:aalhad' }, issue: issuePayload(g, 3), ...sender('ben-gh') });
  await run(g, 'issues', { action: 'labeled', label: { name: 'bug-ish' }, issue: issuePayload(g, 3), ...sender('ben-gh') });
  assert.equal(g.mutations().length, 0);
});

test('labeled: two racing events do not delete each other (stale label skipped)', async () => {
  const g = makeFake({ issues: [{ number: 3, labels: ['status:ready', 'status:review'] }] });
  await run(g, 'issues', { action: 'labeled', label: { name: 'status:ready' }, issue: issuePayload(g, 3), ...sender('ben-gh') });
  assert.deepEqual(labelsOf(g, 3), ['status:ready']);
  // the second event's label was already removed -> no action
  await run(g, 'issues', { action: 'labeled', label: { name: 'status:review' }, issue: issuePayload(g, 3), ...sender('ben-gh') });
  assert.deepEqual(labelsOf(g, 3), ['status:ready']);
});

test('labeled: closed issues are stripped of status labels', async () => {
  const g = makeFake({ issues: [{ number: 3, state: 'closed', labels: ['status:ready', 'kind:task'] }] });
  await run(g, 'issues', { action: 'labeled', label: { name: 'status:ready' }, issue: issuePayload(g, 3), ...sender('ben-gh') });
  assert.deepEqual(labelsOf(g, 3), ['kind:task']);
});

/* ------------------------------------------------- assigned/unassigned ---- */

test('assigned: member assigning a member in the UI is a human claim', async () => {
  const g = makeFake({ issues: [{ number: 3, labels: ['status:ready'], assignees: ['ben-gh'] }] });
  await run(g, 'issues', { action: 'assigned', assignee: user('ben-gh'), issue: issuePayload(g, 3), ...sender('ben-gh') });
  assert.deepEqual(labelsOf(g, 3), ['status:claimed']);
  const body = g.issues.get(3).comments[0].body;
  const m = P.parseMarker(body);
  assert.deepEqual([m.type, m.actor, m.from, m.lease], ['claim', 'human', 'ben', iso(2880)]);
  // the recorded human claim is live
  assert.equal(P.liveClaims(g.issues.get(3).comments, { now: NOW }).length, 1);
});

test('assigned: skipped when the agent claim comment already exists', async () => {
  const g = makeFake({ issues: [{ number: 3, labels: ['status:claimed'], assignees: ['ben-gh'], comments: [{ id: 1, body: claimBody('ben', iso(60)), user: user('ben-gh'), created_at: iso(-1) }] }] });
  await run(g, 'issues', { action: 'assigned', assignee: user('ben-gh'), issue: issuePayload(g, 3), ...sender('ben-gh') });
  assert.equal(g.mutations().length, 0);
});

test('assigned: recent claim marker by that member (even expired lease) is skipped; non-member assignee ignored', async () => {
  const g = makeFake({ issues: [{ number: 3, labels: ['status:ready'], assignees: ['ben-gh'], comments: [{ id: 1, body: claimBody('ben', iso(-1)), user: user('ben-gh'), created_at: iso(-1) }] }, { number: 4, labels: ['status:ready'], assignees: ['stranger'] }] });
  await run(g, 'issues', { action: 'assigned', assignee: user('ben-gh'), issue: issuePayload(g, 3), ...sender('ben-gh') });
  await run(g, 'issues', { action: 'assigned', assignee: user('stranger'), issue: issuePayload(g, 4), ...sender('ben-gh') });
  assert.equal(g.mutations().length, 0);
});

test('assigned: does not override hold / non-member sender', async () => {
  const g = makeFake({ issues: [{ number: 3, labels: ['status:hold'], assignees: ['ben-gh'] }, { number: 4, labels: ['status:ready'], assignees: ['ben-gh'] }] });
  await run(g, 'issues', { action: 'assigned', assignee: user('ben-gh'), issue: issuePayload(g, 3), ...sender('aalhadsawane') });
  await run(g, 'issues', { action: 'assigned', assignee: user('ben-gh'), issue: issuePayload(g, 4), ...sender('stranger') });
  assert.equal(g.mutations().length, 0);
});

test('unassigned: releases the member claim and returns the issue to ready', async () => {
  const g = makeFake({ issues: [{ number: 3, labels: ['status:claimed'], assignees: [], comments: [{ id: 1, body: claimBody('ben', iso(60), ' to=ben'), user: user('ben-gh'), created_at: iso(-30) }] }] });
  await run(g, 'issues', { action: 'unassigned', assignee: user('ben-gh'), issue: issuePayload(g, 3), ...sender('aalhadsawane') });
  const m = P.parseMarker(g.issues.get(3).comments[0].body);
  assert.deepEqual([m.type, m.reason], ['released', 'unassigned']);
  assert.deepEqual(labelsOf(g, 3), ['status:ready', 'to:ben']);
});

test('unassigned: another live claim keeps the issue claimed', async () => {
  const g = makeFake({ issues: [{ number: 3, labels: ['status:claimed'], assignees: ['aalhadsawane'], comments: [
    { id: 1, body: claimBody('aalhad', iso(60)), user: user('aalhadsawane'), created_at: iso(-30) },
    { id: 2, body: claimBody('ben', iso(60)), user: user('ben-gh'), created_at: iso(-20) },
  ] }] });
  await run(g, 'issues', { action: 'unassigned', assignee: user('ben-gh'), issue: issuePayload(g, 3), ...sender('ben-gh') });
  assert.deepEqual(labelsOf(g, 3), ['status:claimed']);
  assert.equal(P.parseMarker(g.issues.get(3).comments[0].body).type, 'claim');
});

/* ----------------------------------------------------------- comments ---- */

let nextCid = 900;
/** Post a comment into fake state and fire the event for it. */
async function comment(g, n, login, body, { action = 'created', id, opts } = {}) {
  const issue = g.issues.get(n);
  let c = id && issue.comments.find((x) => x.id === id);
  if (!c) {
    c = { id: id || nextCid++, body, user: user(login), created_at: iso(0) };
    issue.comments.push(c);
  } else c.body = body;
  return run(g, 'issue_comment', { action, issue: issuePayload(g, n), comment: c, ...sender(login) }, opts);
}

test('comment: non-member and bot comments are ignored', async () => {
  const g = makeFake({ issues: [{ number: 3, labels: ['status:triage'] }] });
  await comment(g, 3, 'stranger', '/route ben\n/ping all');
  const bot = { id: 77, body: '/triage', user: { login: 'x[bot]', type: 'Bot' }, created_at: iso(0) };
  await run(g, 'issue_comment', { action: 'created', issue: issuePayload(g, 3), comment: bot, ...sender('ben-gh') });
  assert.equal(g.mutations().length, 0);
});

test('/route: sets to:, moves triage to ready; /route any', async () => {
  const g = makeFake({ issues: [{ number: 3, labels: ['status:triage', 'to:aalhad'] }] });
  await comment(g, 3, 'aalhadsawane', '/route @ben');
  assert.deepEqual(labelsOf(g, 3), ['status:ready', 'to:ben']);
  await comment(g, 3, 'aalhadsawane', '/route any');
  assert.deepEqual(labelsOf(g, 3), ['status:ready', 'to:any']);
  await comment(g, 3, 'aalhadsawane', '/route nobody');
  assert.deepEqual(labelsOf(g, 3), ['status:ready', 'to:any']);
});

test('/route keeps status when not triage', async () => {
  const g = makeFake({ issues: [{ number: 3, labels: ['status:blocked'] }] });
  await comment(g, 3, 'aalhadsawane', '/route ben');
  assert.deepEqual(labelsOf(g, 3), ['status:blocked', 'to:ben']);
});

test('/ping: named handle, login form, and all (excludes self and disabled agents)', async () => {
  const g = makeFake({ issues: [{ number: 3 }] });
  await comment(g, 3, 'aalhadsawane', '/ping ben-gh chen');
  assert.deepEqual(labelsOf(g, 3), ['ping:ben']); // chen has no agent
  await comment(g, 3, 'aalhadsawane', '/ping all');
  assert.deepEqual(labelsOf(g, 3), ['ping:ben', 'ping:dev']);
});

test('/handoff: releases the claim, routes and pings', async () => {
  const g = makeFake({ issues: [{ number: 3, labels: ['status:claimed'], assignees: ['aalhadsawane'], comments: [{ id: 1, body: claimBody('aalhad', iso(60)), user: user('aalhadsawane'), created_at: iso(-30) }] }] });
  await comment(g, 3, 'aalhadsawane', '/handoff ben');
  assert.deepEqual(labelsOf(g, 3), ['ping:ben', 'status:ready', 'to:ben']);
  assert.deepEqual(g.issues.get(3).assignees, []);
  assert.equal(P.parseMarker(g.issues.get(3).comments[0].body).reason, 'handoff');
});

test('/release: releases own claim, unassigns, back to ready; restores recorded to=', async () => {
  const g = makeFake({ issues: [{ number: 3, labels: ['status:claimed', 'to:any'], assignees: ['ben-gh'], comments: [{ id: 1, body: claimBody('ben', iso(60), ' to=ben'), user: user('ben-gh'), created_at: iso(-30) }] }] });
  await comment(g, 3, 'ben-gh', '/release');
  assert.deepEqual(labelsOf(g, 3), ['status:ready', 'to:ben']);
  assert.deepEqual(g.issues.get(3).assignees, []);
  assert.equal(P.parseMarker(g.issues.get(3).comments[0].body).type, 'released');
});

test('/release does not touch someone else\'s claim', async () => {
  const g = makeFake({ issues: [{ number: 3, labels: ['status:claimed'], assignees: ['ben-gh'], comments: [{ id: 1, body: claimBody('ben', iso(60)), user: user('ben-gh'), created_at: iso(-30) }] }] });
  await comment(g, 3, 'aalhadsawane', '/release');
  assert.deepEqual(labelsOf(g, 3), ['status:claimed']);
  assert.equal(P.parseMarker(g.issues.get(3).comments[0].body).type, 'claim');
});

test('/block #n, /unblock (ready vs claimed with live claim)', async () => {
  const g = makeFake({ issues: [{ number: 3, labels: ['status:ready'] }] });
  await comment(g, 3, 'ben-gh', '/block #12');
  assert.deepEqual(labelsOf(g, 3), ['status:blocked']);
  const note = P.parseMarker(g.issues.get(3).comments.at(-1).body);
  assert.deepEqual([note.from, note.type, note.dep], ['referee', 'note', '12']);
  await comment(g, 3, 'ben-gh', '/unblock');
  assert.deepEqual(labelsOf(g, 3), ['status:ready']);

  const h = makeFake({ issues: [{ number: 4, labels: ['status:blocked'], comments: [{ id: 1, body: claimBody('ben', iso(60)), user: user('ben-gh'), created_at: iso(-30) }] }] });
  await comment(h, 4, 'ben-gh', '/unblock');
  assert.deepEqual(labelsOf(h, 4), ['status:claimed']);
});

test('/hold by a human binds; /hold by an agent is ignored; /unhold resumes', async () => {
  const g = makeFake({ issues: [{ number: 3, labels: ['status:ready'] }] });
  await comment(g, 3, 'ben-gh', '<!-- issuemesh v1 from=ben actor=agent type=note -->\n/hold');
  assert.deepEqual(labelsOf(g, 3), ['status:ready']);
  await comment(g, 3, 'aalhadsawane', '/hold');
  assert.deepEqual(labelsOf(g, 3), ['status:hold']);
  await comment(g, 3, 'aalhadsawane', '/unhold');
  assert.deepEqual(labelsOf(g, 3), ['status:ready']);
  await comment(g, 3, 'aalhadsawane', '/unhold'); // not on hold: no-op
  assert.deepEqual(labelsOf(g, 3), ['status:ready']);
});

test('/triage /escalate /priority /size /kind', async () => {
  const g = makeFake({ issues: [{ number: 3, labels: ['status:ready', 'priority:p3', 'size:s', 'kind:task'] }] });
  await comment(g, 3, 'ben-gh', '/triage\n/priority p0\n/size l\n/kind bug');
  assert.deepEqual(labelsOf(g, 3), ['kind:bug', 'priority:p0', 'size:l', 'status:triage']);
  await comment(g, 3, 'ben-gh', '/escalate');
  assert.ok(g.issues.get(3).labels.includes('status:needs-human'));
  await comment(g, 3, 'ben-gh', '/priority p9\n/kind board\n/size xl');
  assert.deepEqual(labelsOf(g, 3), ['kind:bug', 'priority:p0', 'size:l', 'status:needs-human']);
});

test('commands in code fences and quotes are ignored; edits never replay commands', async () => {
  const g = makeFake({ issues: [{ number: 3, labels: ['status:ready'] }] });
  await comment(g, 3, 'ben-gh', '```\n/escalate\n```\n> /hold\ntext');
  assert.equal(g.mutations().length, 0);
  const first = await comment(g, 3, 'ben-gh', 'nothing yet');
  const id = g.issues.get(3).comments.at(-1).id;
  await comment(g, 3, 'ben-gh', '/escalate', { action: 'edited', id });
  assert.deepEqual(labelsOf(g, 3), ['status:ready']);
  assert.ok(first);
});

test('mentions ping the agent; skip self, non-agents and route_mentions_to_agent=false', async () => {
  const g = makeFake({ issues: [{ number: 3 }] });
  await comment(g, 3, 'aalhadsawane', 'cc @ben-gh @aalhadsawane @chen-gh @dev-gh @stranger and `@ben-gh`');
  assert.deepEqual(labelsOf(g, 3), ['ping:ben']);
});

test('mention of a member does not ping when the commenter is that member', async () => {
  const g = makeFake({ issues: [{ number: 3 }] });
  await comment(g, 3, 'ben-gh', 'note to self @ben-gh');
  assert.equal(g.mutations().length, 0);
});

test('claim: sole agent claim assigns and sets status:claimed', async () => {
  const g = makeFake({ issues: [{ number: 3, labels: ['status:ready'] }] });
  await comment(g, 3, 'ben-gh', claimBody('ben', iso(120)));
  assert.deepEqual(labelsOf(g, 3), ['status:claimed']);
  assert.deepEqual(g.issues.get(3).assignees, ['ben-gh']);
});

test('claim race: lowest comment id wins, loser comment released and unassigned', async () => {
  const g = makeFake({ issues: [{ number: 3, labels: ['status:claimed'], assignees: ['aalhadsawane', 'ben-gh'], comments: [
    { id: 100, body: claimBody('ben', iso(100)), user: user('ben-gh'), created_at: iso(-1) },
  ] }] });
  await comment(g, 3, 'aalhadsawane', claimBody('aalhad', iso(110)), { id: 101 });
  const loser = P.parseMarker(g.issues.get(3).comments.find((c) => c.id === 101).body);
  assert.deepEqual([loser.type, loser.reason], ['released', 'lost-race']);
  assert.equal(P.parseMarker(g.issues.get(3).comments.find((c) => c.id === 100).body).type, 'claim');
  assert.deepEqual(g.issues.get(3).assignees, ['ben-gh']);
  assert.deepEqual(labelsOf(g, 3), ['status:claimed']);
  // idempotent: re-running changes nothing further
  g.calls.length = 0;
  await comment(g, 3, 'aalhadsawane', g.issues.get(3).comments.find((c) => c.id === 101).body, { action: 'edited', id: 101 });
  assert.equal(g.mutations().length, 0);
});

test('claim race: an earlier-id claim arriving second displaces the first', async () => {
  const g = makeFake({ issues: [{ number: 3, labels: ['status:claimed'], assignees: ['ben-gh'], comments: [
    { id: 105, body: claimBody('ben', iso(100)), user: user('ben-gh'), created_at: iso(0) },
  ] }] });
  await comment(g, 3, 'aalhadsawane', claimBody('aalhad', iso(110)), { id: 104 });
  assert.equal(P.parseMarker(g.issues.get(3).comments.find((c) => c.id === 105).body).reason, 'lost-race');
  assert.deepEqual(g.issues.get(3).assignees, ['aalhadsawane']);
});

test('claim: an expired claim does not block a new one', async () => {
  const g = makeFake({ issues: [{ number: 3, labels: ['status:ready'], comments: [{ id: 1, body: claimBody('ben', iso(-5)), user: user('ben-gh'), created_at: iso(-200) }] }] });
  await comment(g, 3, 'aalhadsawane', claimBody('aalhad', iso(110)));
  assert.deepEqual(g.issues.get(3).assignees, ['aalhadsawane']);
  assert.equal(P.parseMarker(g.issues.get(3).comments[0].body).type, 'claim'); // expired one left alone
});

test('/claim by a human: claims; a later /claim loses with a referee note', async () => {
  const g = makeFake({ issues: [{ number: 3, labels: ['status:ready'] }] });
  await comment(g, 3, 'ben-gh', '/claim');
  assert.deepEqual(g.issues.get(3).assignees, ['ben-gh']);
  assert.deepEqual(labelsOf(g, 3), ['status:claimed']);
  await comment(g, 3, 'aalhadsawane', '/claim');
  assert.deepEqual(g.issues.get(3).assignees, ['ben-gh']);
  const note = g.issues.get(3).comments.at(-1);
  assert.equal(P.parseMarker(note.body).from, 'referee');
  assert.match(note.body, /lost the race to ben/);
});

test('claim does not override hold or review status', async () => {
  const g = makeFake({ issues: [{ number: 3, labels: ['status:hold'] }] });
  await comment(g, 3, 'ben-gh', claimBody('ben', iso(120)));
  assert.deepEqual(labelsOf(g, 3), ['status:hold']);
});

function streak(n, handles) {
  return Array.from({ length: n }, (_, k) => ({
    id: 10 + k, body: `<!-- issuemesh v1 from=${handles[k % handles.length]} actor=agent type=note -->\nping`,
    user: user(handles[k % handles.length] === 'ben' ? 'ben-gh' : 'aalhadsawane'), created_at: iso(-60 + k),
  }));
}

test('loop guard: trips once, escalates to needs-human with one comment', async () => {
  const g = makeFake({ issues: [{ number: 3, labels: ['status:claimed'], comments: streak(7, ['aalhad', 'ben']) }] });
  await comment(g, 3, 'ben-gh', '<!-- issuemesh v1 from=ben actor=agent type=note -->\nmore');
  assert.deepEqual(labelsOf(g, 3), ['status:needs-human']);
  const last = g.issues.get(3).comments.at(-1);
  const m = P.parseMarker(last.body);
  assert.deepEqual([m.from, m.type], ['referee', 'escalate']);
  assert.match(last.body, /@aalhadsawane/);
  assert.match(last.body, /@ben-gh/);
  // non-repeat: another agent comment while already needs-human adds nothing
  const before = g.issues.get(3).comments.length;
  g.calls.length = 0;
  await comment(g, 3, 'aalhadsawane', '<!-- issuemesh v1 from=aalhad actor=agent type=note -->\nstill going');
  assert.equal(g.mutations().length, 0);
  assert.equal(g.issues.get(3).comments.length, before + 1); // only the test's own comment
});

test('loop guard: not tripped with one handle or below the limit or with a human comment', async () => {
  const g = makeFake({ issues: [{ number: 3, labels: ['status:claimed'], comments: streak(7, ['ben']) }, { number: 4, labels: ['status:claimed'], comments: streak(5, ['aalhad', 'ben']) }] });
  await comment(g, 3, 'ben-gh', '<!-- issuemesh v1 from=ben actor=agent type=note -->\nmore');
  await comment(g, 4, 'ben-gh', '<!-- issuemesh v1 from=ben actor=agent type=note -->\nmore');
  assert.equal(g.mutations().length, 0);
  const h = makeFake({ issues: [{ number: 5, labels: ['status:claimed'], comments: streak(9, ['aalhad', 'ben']) }] });
  await comment(h, 5, 'ben-gh', 'a human steps in');
  assert.equal(h.mutations().length, 0);
});

/* ------------------------------------------------------ pull requests ---- */

const pr = (over = {}) => ({ number: 50, draft: false, merged: false, user: user('ben-gh'), title: 'Add thing', body: 'Closes #3', base: { ref: 'main' }, ...over });
const prEvent = (g, action, prOver, extra = {}) => run(g, 'pull_request', { action, pull_request: pr(prOver), repository: { default_branch: 'main' }, ...sender('ben-gh') }, extra);

test('pull_request opened: closing keyword moves the issue and the PR to status:review', async () => {
  const g = makeFake({ issues: [{ number: 3, labels: ['status:claimed'] }, { number: 50, labels: [], pull_request: {} }] });
  await prEvent(g, 'opened');
  assert.deepEqual(labelsOf(g, 3), ['status:review']);
  assert.deepEqual(labelsOf(g, 50), ['status:review']);
});

test('pull_request: keyword variants, same-repo only, board and closed issues untouched', async () => {
  const g = makeFake({ issues: [
    { number: 3, labels: ['status:claimed'] }, { number: 4, labels: ['status:ready'] },
    { number: 5, labels: ['status:ready'] }, { number: 6, labels: ['status:claimed'], state: 'closed' }, { number: 7, labels: ['kind:board'] },
    { number: 8, labels: ['status:blocked'] }, { number: 50, pull_request: {} },
  ] });
  await prEvent(g, 'ready_for_review', { body: 'fixes #3\nResolved: #4\nCloses other/repo#5\nclose #6 and closes #7 resolves #8' });
  assert.deepEqual(labelsOf(g, 3), ['status:review']);
  assert.deepEqual(labelsOf(g, 4), ['status:review']);
  assert.deepEqual(labelsOf(g, 5), ['status:ready']);
  assert.deepEqual(labelsOf(g, 6), ['status:claimed']);
  assert.deepEqual(labelsOf(g, 7), ['kind:board']);
  assert.deepEqual(labelsOf(g, 8), ['status:blocked']);
});

test('pull_request: draft PRs and non-member authors are ignored', async () => {
  const g = makeFake({ issues: [{ number: 3, labels: ['status:claimed'] }, { number: 50, pull_request: {} }] });
  await prEvent(g, 'opened', { draft: true });
  await prEvent(g, 'opened', { user: user('stranger') });
  assert.equal(g.mutations().length, 0);
});

test('pull_request closed unmerged: back to claimed with a live claim, else ready', async () => {
  const live = [{ id: 1, body: claimBody('ben', iso(60)), user: user('ben-gh'), created_at: iso(-30) }];
  const g = makeFake({ issues: [
    { number: 3, labels: ['status:review'], comments: live },
    { number: 4, labels: ['status:review'] },
    { number: 50, labels: ['status:review'], pull_request: {} },
  ] });
  await prEvent(g, 'closed', { body: 'Closes #3, closes #4' });
  assert.deepEqual(labelsOf(g, 3), ['status:claimed']);
  assert.deepEqual(labelsOf(g, 50), []);
  await prEvent(g, 'closed', { body: 'Closes #4' });
  assert.deepEqual(labelsOf(g, 4), ['status:ready']);
});

test('pull_request closed merged into default branch: status dropped from linked issue', async () => {
  const g = makeFake({ issues: [{ number: 3, labels: ['status:review', 'kind:task'] }, { number: 4, labels: ['status:review'] }, { number: 50, labels: ['status:review'], pull_request: {} }] });
  await prEvent(g, 'closed', { merged: true });
  assert.deepEqual(labelsOf(g, 3), ['kind:task']);
  await prEvent(g, 'closed', { merged: true, body: 'Closes #4', base: { ref: 'release' } });
  assert.deepEqual(labelsOf(g, 4), ['status:review']); // not the default branch: issue stays open
});

/* ---------------------------------------------------------------- sweep -- */

test('sweep: expired claim is released, unassigned, ready, and to= restored', async () => {
  const g = makeFake({ issues: [
    { number: 1, labels: ['kind:board'] },
    { number: 3, labels: ['status:claimed', 'to:any'], assignees: ['ben-gh'], comments: [{ id: 1, body: claimBody('ben', iso(-10), ' to=ben'), user: user('ben-gh'), created_at: iso(-300) }] },
    { number: 4, labels: ['status:claimed'], assignees: ['ben-gh'], comments: [{ id: 2, body: claimBody('ben', iso(30)), user: user('ben-gh'), created_at: iso(-30) }] },
    { number: 5, labels: ['status:claimed', 'to:ben'], assignees: ['ben-gh'], comments: [{ id: 3, body: claimBody('ben', iso(-10)), user: user('ben-gh'), created_at: iso(-300) }] },
  ] });
  await run(g, 'schedule', {});
  const m = P.parseMarker(g.issues.get(3).comments[0].body);
  assert.deepEqual([m.type, m.reason], ['released', 'expired']);
  assert.deepEqual(g.issues.get(3).assignees, []);
  assert.deepEqual(labelsOf(g, 3), ['status:ready', 'to:ben']);
  // live claim untouched
  assert.deepEqual(labelsOf(g, 4), ['status:claimed']);
  assert.deepEqual(g.issues.get(4).assignees, ['ben-gh']);
  // no recorded to= -> to: unchanged
  assert.deepEqual(labelsOf(g, 5), ['status:ready', 'to:ben']);
});

test('sweep: second run is a no-op', async () => {
  const g = makeFake({ issues: [{ number: 3, labels: ['status:claimed'], assignees: ['ben-gh'], comments: [{ id: 1, body: claimBody('ben', iso(-10)), user: user('ben-gh'), created_at: iso(-300) }] }] });
  await run(g, 'schedule', {});
  g.calls.length = 0;
  await run(g, 'workflow_dispatch', { inputs: { task: 'sweep' } });
  assert.equal(g.mutations().length, 0);
});

test('sweep: human /claim past its lease expires; within lease stays', async () => {
  const old = { id: 1, body: '/claim', user: user('ben-gh'), created_at: iso(-2880 - 5) };
  const fresh = { id: 2, body: '/claim', user: user('ben-gh'), created_at: iso(-60) };
  const g = makeFake({ issues: [
    { number: 3, labels: ['status:claimed'], assignees: ['ben-gh'], comments: [old] },
    { number: 4, labels: ['status:claimed'], assignees: ['ben-gh'], comments: [fresh] },
  ] });
  await run(g, 'schedule', {});
  assert.deepEqual(labelsOf(g, 3), ['status:ready']);
  assert.deepEqual(g.issues.get(3).assignees, []);
  assert.deepEqual(labelsOf(g, 4), ['status:claimed']);
});

test('sweep: claimed with no claim record uses issue activity for a human lease', async () => {
  const g = makeFake({ issues: [
    { number: 3, labels: ['status:claimed'], assignees: ['ben-gh'], updated_at: iso(-60) },
    { number: 4, labels: ['status:claimed'], assignees: ['ben-gh'], updated_at: iso(-3000) },
  ] });
  await run(g, 'schedule', {});
  assert.deepEqual(labelsOf(g, 3), ['status:claimed']);
  assert.deepEqual(labelsOf(g, 4), ['status:ready']);
  assert.deepEqual(g.issues.get(4).assignees, []);
});

test('sweep: rotates a Board with more than 200 comments', async () => {
  const g = makeFake({ issues: [{ number: 1, labels: ['kind:board'], comments: Array.from({ length: 201 }, (_, i) => ({ id: 1000 + i, body: 'x', user: user('ben-gh'), created_at: iso(-1) })) }] });
  await run(g, 'schedule', {});
  const created = g.named('issues.create');
  assert.equal(created.length, 1);
  assert.deepEqual(created[0].p.labels, ['kind:board']);
  assert.match(created[0].p.body, /#1/);
  const gql = g.named('graphql.graphql').map((c) => c.p);
  assert.equal(gql.length, 2);
  assert.match(gql[0], /pinIssue/);
  assert.match(gql[1], /unpinIssue/);
  const old = g.issues.get(1);
  assert.equal(old.state, 'closed');
  const note = old.comments.at(-1).body;
  assert.match(note, /rotated: continue in #100/);
  assert.equal(P.parseMarker(note).from, 'referee');
});

test('sweep: Board at or below 200 comments is left alone; closed board_issue resolves to newest open board', async () => {
  const g = makeFake({ issues: [{ number: 1, labels: ['kind:board'], comments: Array.from({ length: 200 }, (_, i) => ({ id: i, body: 'x', user: user('ben-gh'), created_at: iso(-1) })) }] });
  await run(g, 'schedule', {});
  assert.equal(g.mutations().length, 0);

  const h = makeFake({ issues: [
    { number: 1, state: 'closed', labels: ['kind:board'] },
    { number: 9, labels: ['kind:board'], comments: Array.from({ length: 250 }, (_, i) => ({ id: i, body: 'x', user: user('ben-gh'), created_at: iso(-1) })) },
  ] });
  await run(h, 'schedule', {});
  assert.equal(h.named('issues.create').length, 1);
  assert.equal(h.issues.get(9).state, 'closed');
});

/* ---------------------------------------------------------------- setup -- */

test('setup: creates every standard label and a pinned Board; second run changes nothing', async () => {
  const g = makeFake();
  await run(g, 'workflow_dispatch', { inputs: { task: 'setup' } }, { config: makeConfig({ board_issue: null }) });
  const want = P.standardLabels(['aalhad', 'ben', 'chen', 'dev']);
  assert.equal(g.repoLabels.length, want.length);
  assert.ok(g.repoLabels.some((l) => l.name === 'ping:chen'));
  const created = g.named('issues.create');
  assert.equal(created.length, 1);
  assert.deepEqual(created[0].p.labels, ['kind:board']);
  assert.match(g.named('graphql.graphql')[0].p, /pinIssue/);

  g.calls.length = 0;
  await run(g, 'workflow_dispatch', { inputs: { task: 'setup' } }, { config: makeConfig({ board_issue: null }) });
  assert.equal(g.mutations().length, 0); // labels in sync, Board exists
});

test('setup: updates drifted labels and leaves an existing Board alone', async () => {
  const g = makeFake({ issues: [{ number: 1, labels: ['kind:board'] }], repoLabels: [{ name: 'status:ready', color: '000000', description: 'old' }] });
  await run(g, 'workflow_dispatch', { inputs: { task: 'setup' } });
  assert.equal(g.named('issues.updateLabel').length, 1);
  assert.equal(g.named('issues.create').length, 0);
  assert.equal(g.named('graphql.graphql').length, 0);
});

/* ----------------------------------------------------------------- wake -- */

const wakeCfg = (on) => makeConfig({ policy: { wake: on } });
const dispatches = (g) => g.named('repos.createDispatchEvent').map((c) => c.p);

test('wake on: newly added ping:/to: labels dispatch to agent-enabled members', async () => {
  const g = makeFake({ issues: [{ number: 3, labels: ['status:triage'] }] });
  await comment(g, 3, 'aalhadsawane', '/route ben\n/ping dev chen', { opts: { config: wakeCfg(true) } });
  assert.deepEqual(dispatches(g).map((d) => [d.event_type, d.client_payload.handle, d.client_payload.issue]).sort(), [
    ['issuemesh-wake', 'ben', 3], ['issuemesh-wake', 'dev', 3],
  ]);
});

test('wake off (default): no dispatch', async () => {
  const g = makeFake({ issues: [{ number: 3, labels: ['status:triage'] }] });
  await comment(g, 3, 'aalhadsawane', '/route ben\n/ping dev', { opts: { config: wakeCfg(false) } });
  assert.equal(dispatches(g).length, 0);
  const h = makeFake({ issues: [{ number: 3 }] });
  await comment(h, 3, 'aalhadsawane', '/ping ben');
  assert.equal(dispatches(h).length, 0);
});

test('wake: label already present is not re-added and does not re-wake; self is not woken; to:any never', async () => {
  const g = makeFake({ issues: [{ number: 3, labels: ['status:ready', 'ping:ben'] }] });
  await comment(g, 3, 'aalhadsawane', '/ping ben aalhad', { opts: { config: wakeCfg(true) } });
  assert.equal(dispatches(g).length, 0);
  await comment(g, 3, 'aalhadsawane', '/route any', { opts: { config: wakeCfg(true) } });
  assert.equal(dispatches(g).length, 0);
});

test('wakeActions: dedupes per handle and issue', () => {
  const cfg = wakeCfg(true);
  const acts = wakeActions([{ issue: 1, label: 'ping:ben' }, { issue: 1, label: 'to:ben' }, { issue: 2, label: 'to:ben' }, { issue: 2, label: 'status:ready' }], cfg, null);
  assert.deepEqual(acts.map((a) => `${a.handle}#${a.issue}`), ['ben#1', 'ben#2']);
  assert.deepEqual(wakeActions([{ issue: 1, label: 'ping:ben' }], wakeCfg(false), null), []);
});

/* ------------------------------------------------------------- executor -- */

const runner = (g) => createExecutor({ github: g, context: ctx('x', {}), core: makeCore() });

test('executor: adds only missing labels, in one call per issue', async () => {
  const g = makeFake({ issues: [{ number: 3, labels: ['kind:task'] }] });
  const res = await runner(g).run([
    { type: 'addLabels', issue: 3, labels: ['kind:task', 'ping:ben'] },
    { type: 'addLabels', issue: 3, labels: ['status:ready'] },
  ]);
  const adds = g.named('issues.addLabels');
  assert.equal(adds.length, 1);
  assert.deepEqual(adds[0].p.labels, ['ping:ben', 'status:ready']);
  assert.deepEqual(res.added.map((a) => a.label), ['ping:ben', 'status:ready']);
});

test('executor: removes only present labels; tolerates 404 on removeLabel', async () => {
  const g = makeFake({ issues: [{ number: 3, labels: ['status:ready'] }] });
  const res = await runner(g).run([
    { type: 'removeLabel', issue: 3, label: 'status:ready' },
    { type: 'removeLabel', issue: 3, label: 'status:review' },
  ]);
  assert.equal(g.named('issues.removeLabel').length, 1);
  assert.equal(res.errors.length, 0);

  const h = makeFake({ issues: [{ number: 3, labels: ['status:ready'] }] });
  const orig = h.rest.issues.removeLabel;
  h.rest.issues.removeLabel = async (p) => { h.issues.get(3).labels = []; return orig(p); }; // raced away: real call 404s
  const res2 = await runner(h).run([{ type: 'removeLabel', issue: 3, label: 'status:ready' }]);
  assert.equal(res2.errors.length, 0);
});

test('executor: add then remove of the same label is a no-op; running twice is idempotent', async () => {
  const g = makeFake({ issues: [{ number: 3, labels: [] }] });
  await runner(g).run([{ type: 'addLabels', issue: 3, labels: ['ping:ben'] }, { type: 'removeLabel', issue: 3, label: 'ping:ben' }]);
  assert.equal(g.mutations().length, 0);
  const acts = [{ type: 'addLabels', issue: 3, labels: ['status:ready'] }, { type: 'removeLabel', issue: 3, label: 'status:triage' }];
  await runner(g).run(acts);
  g.calls.length = 0;
  await runner(g).run(acts);
  assert.equal(g.mutations().length, 0);
});

test('executor: case-insensitive label matching; failures warn and continue', async () => {
  const g = makeFake({ issues: [{ number: 3, labels: ['Status:Ready'] }] });
  await runner(g).run([{ type: 'addLabels', issue: 3, labels: ['status:ready'] }]);
  assert.equal(g.mutations().length, 0);

  const h = makeFake({ issues: [{ number: 3 }], failures: { addAssignees: new Error('boom') } });
  const core = makeCore();
  const res = await createExecutor({ github: h, context: ctx('x', {}), core }).run([
    { type: 'addAssignees', issue: 3, assignees: ['ben-gh'] },
    { type: 'createComment', issue: 3, body: 'still runs' },
  ]);
  assert.equal(res.errors.length, 1);
  assert.equal(core.log.warning.length, 1);
  assert.equal(h.issues.get(3).comments.length, 1);
});

test('executor: createIssue chains follow-up actions with the created issue', async () => {
  const g = makeFake({ issues: [{ number: 1 }] });
  await runner(g).run([{ type: 'createIssue', title: 't', body: 'b', labels: ['kind:board'], then: (c) => [{ type: 'createComment', issue: 1, body: `see #${c.number}` }, { type: 'pinIssue', nodeId: c.node_id }] }]);
  assert.equal(g.issues.get(1).comments[0].body, 'see #100');
  assert.match(g.named('graphql.graphql')[0].p, /pinIssue/);
});
