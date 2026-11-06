'use strict';

// Tests for lib/protocol.js. Spec: PROTOCOL.md sections 2-6 and 8.

const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../lib/protocol');
const { normalizeConfig } = require('../lib/config');

const NOW = new Date('2026-11-06T12:00:00Z');
const iso = (min) => new Date(NOW.getTime() + min * 60000).toISOString().replace(/\.\d{3}Z$/, 'Z');

let nextId = 100;
function agentC(handle, type, extra = {}, id = nextId++) {
  return { id, user: { login: handle + '-gh' }, created_at: iso(-id % 50), updated_at: iso(0), body: P.composeMessage({ from: handle, type, body: 'x', ...extra }) };
}
function humanC(login, body, id = nextId++, created = iso(-10)) {
  return { id, user: { login }, created_at: created, updated_at: created, body };
}

test('label helpers', () => {
  assert.equal(P.statusLabel('ready'), 'status:ready');
  assert.equal(P.toLabel('bob'), 'to:bob');
  assert.equal(P.pingLabel('bob'), 'ping:bob');
  assert.equal(P.kindLabel('bug'), 'kind:bug');
  assert.equal(P.priorityLabel('p0'), 'priority:p0');
  assert.equal(P.sizeLabel('m'), 'size:m');
});

test('parseLabels basics, pings, flags, other', () => {
  const r = P.parseLabels(['status:ready', 'to:bob', 'ping:a', 'ping:b', 'ping:a', 'kind:bug', 'priority:p1', 'size:s', 'human-only', 'source:external', 'good first issue']);
  assert.equal(r.status, 'ready');
  assert.equal(r.to, 'bob');
  assert.deepEqual(r.pings, ['a', 'b']);
  assert.equal(r.kind, 'bug');
  assert.equal(r.priority, 'p1');
  assert.equal(r.size, 's');
  assert.equal(r.humanOnly, true);
  assert.equal(r.external, true);
  assert.deepEqual(r.other, ['good first issue']);
  assert.deepEqual(r.conflicts, {});
});

test('parseLabels empty and conflicts (last wins)', () => {
  const e = P.parseLabels([]);
  assert.equal(e.status, null);
  assert.equal(e.humanOnly, false);
  const r = P.parseLabels(['status:ready', 'status:claimed', 'to:a', 'to:b', 'priority:p0']);
  assert.equal(r.status, 'claimed');
  assert.equal(r.to, 'b');
  assert.deepEqual(r.conflicts, { status: ['ready', 'claimed'], to: ['a', 'b'] });
});

test('parseLabels leaves unknown status values in other', () => {
  const r = P.parseLabels(['status:weird']);
  assert.equal(r.status, null);
  assert.deepEqual(r.other, ['status:weird']);
});

test('setNamespace replaces, removes and does not mutate', () => {
  const orig = ['status:ready', 'kind:task', 'status:review'];
  const r = P.setNamespace(orig, 'status', 'claimed');
  assert.deepEqual(r, ['kind:task', 'status:claimed']);
  assert.deepEqual(orig, ['status:ready', 'kind:task', 'status:review']);
  assert.deepEqual(P.setNamespace(['to:a', 'x'], 'to', null), ['x']);
  assert.deepEqual(P.setNamespace([], 'size', 'm'), ['size:m']);
});

test('standardLabels covers the full set with valid colors', () => {
  const ls = P.standardLabels(['aalhad', 'bob']);
  const names = ls.map((l) => l.name);
  for (const s of P.STATUS) assert.ok(names.includes('status:' + s));
  for (const n of ['to:aalhad', 'to:bob', 'to:any', 'ping:aalhad', 'ping:bob', 'human-only', 'source:external', 'kind:board', 'priority:p3', 'size:l']) {
    assert.ok(names.includes(n), n);
  }
  assert.equal(new Set(names).size, names.length);
  for (const l of ls) {
    assert.match(l.color, /^[0-9a-f]{6}$/);
    assert.ok(l.description.length > 0);
  }
});

test('formatMarker key order and extras sorted', () => {
  assert.equal(
    P.formatMarker({ type: 'claim', from: 'aalhad', zeta: '1', lease: '2026-11-06T15:00:00Z' }),
    '<!-- issuemesh v1 from=aalhad actor=agent type=claim lease=2026-11-06T15:00:00Z zeta=1 -->'
  );
  assert.match(P.formatMarker({ from: 'a', actor: 'human', type: 'note' }), /actor=human/);
});

test('formatMarker rejects bad values and missing fields; skips null extras', () => {
  assert.throws(() => P.formatMarker({ from: 'a', type: 'note', reason: 'two words' }));
  assert.throws(() => P.formatMarker({ from: 'a', type: 'note', reason: 'x-->y' }));
  assert.throws(() => P.formatMarker({ from: 'a', type: 'note', reason: '' }));
  assert.throws(() => P.formatMarker({ type: 'note' }));
  assert.throws(() => P.formatMarker({ from: 'a' }));
  assert.equal(P.formatMarker({ from: 'a', type: 'note', re: null }), '<!-- issuemesh v1 from=a actor=agent type=note -->');
});

test('marker round trip', () => {
  const fields = { from: 'chen', actor: 'agent', type: 'ask', to: 'bob,eli' };
  const m = P.parseMarker(P.formatMarker(fields) + '\nhello');
  assert.deepEqual(m, { version: 'v1', ...fields });
});

test('parseMarker: only first non-empty line, tolerant of leading blanks and CRLF', () => {
  const mk = P.formatMarker({ from: 'a', type: 'note' });
  assert.ok(P.parseMarker(`\n\n  ${mk}\r\nbody`));
  assert.equal(P.parseMarker(`some text\n${mk}`), null);
  assert.equal(P.parseMarker(''), null);
  assert.equal(P.parseMarker(null), null);
  assert.equal(P.parseMarker('plain human comment'), null);
});

test('parseMarker: actor defaults to agent; unknown keys retained', () => {
  const m = P.parseMarker('<!-- issuemesh v1 from=a type=note foo=bar -->');
  assert.equal(m.actor, 'agent');
  assert.equal(m.foo, 'bar');
});

test('parseMarker: malformed markers return null', () => {
  assert.equal(P.parseMarker('<!-- issuemesh v1 actor=agent type=note -->'), null); // no from
  assert.equal(P.parseMarker('<!-- issuemesh v1 from=a actor=agent -->'), null); // no type
  assert.equal(P.parseMarker('<!-- issuemesh v1 from=a type=note garbage -->'), null);
  assert.equal(P.parseMarker('<!-- issuemesh v1 from=a type=note'), null); // unterminated
  assert.equal(P.parseMarker('<!-- issuemesh from=a type=note -->'), null); // no version
  assert.equal(P.parseMarker('<!-- something else v1 from=a type=note -->'), null);
});

test('parseMarker: unknown major versions are ignored', () => {
  assert.equal(P.parseMarker('<!-- issuemesh v2 from=a actor=agent type=claim -->'), null);
  assert.equal(P.parseMarker('<!-- issuemesh v10 from=a actor=agent type=claim -->'), null);
  assert.equal(P.actorOf('<!-- issuemesh v2 from=a actor=agent type=claim -->'), 'human');
});

test('actorOf', () => {
  assert.equal(P.actorOf('hello'), 'human');
  assert.equal(P.actorOf(P.composeMessage({ from: 'a', type: 'note', body: 'x' })), 'agent');
  assert.equal(P.actorOf('<!-- issuemesh v1 from=a actor=human type=note -->'), 'human');
});

test('signature and composeMessage', () => {
  assert.equal(P.signature('aalhad'), "<sub>🤖 aalhad's agent · IssueMesh</sub>");
  const msg = P.composeMessage({ from: 'aalhad', type: 'claim', body: '**Claimed**\n\n', lease: '2026-11-06T15:00:00Z' });
  assert.equal(
    msg,
    "<!-- issuemesh v1 from=aalhad actor=agent type=claim lease=2026-11-06T15:00:00Z -->\n**Claimed**\n\n<sub>🤖 aalhad's agent · IssueMesh</sub>"
  );
  assert.equal(P.parseMarker(msg).lease, '2026-11-06T15:00:00Z');
});

test('replaceMarker updates, adds and removes keys; preserves the body', () => {
  const body = P.composeMessage({ from: 'a', type: 'claim', body: 'plan\n- [ ] step', lease: iso(10) });
  const rel = P.replaceMarker(body, { type: 'released', reason: 'lost-race', lease: null });
  const m = P.parseMarker(rel);
  assert.equal(m.type, 'released');
  assert.equal(m.reason, 'lost-race');
  assert.equal(m.lease, undefined);
  assert.ok(rel.includes('plan\n- [ ] step'));
  assert.ok(rel.endsWith(P.signature('a')));
  const bumped = P.replaceMarker(body, { lease: '2030-01-01T00:00:00Z' });
  assert.equal(P.parseMarker(bumped).lease, '2030-01-01T00:00:00Z');
  assert.throws(() => P.replaceMarker('no marker', { type: 'x' }));
});

test('parseCommands: basics, args, @ and # stripping', () => {
  const body = '/route @bob\n/ping alice @bob\n/block #12\n/priority p0\nsome prose\n/claim';
  assert.deepEqual(P.parseCommands(body), [
    { name: 'route', args: ['bob'] },
    { name: 'ping', args: ['alice', 'bob'] },
    { name: 'block', args: ['12'] },
    { name: 'priority', args: ['p0'] },
    { name: 'claim', args: [] },
  ]);
});

test('parseCommands: ignores code fences, quotes, mid-line and unknown commands', () => {
  const body = [
    '> /claim',
    '```',
    '/release',
    '```',
    '~~~sh',
    '/hold',
    '~~~',
    'text /escalate',
    '/claimed',
    '/unknown x',
    '/triage',
  ].join('\n');
  assert.deepEqual(P.parseCommands(body), [{ name: 'triage', args: [] }]);
});

test('parseCommands: unclosed fence hides the rest; fence closes properly; CRLF', () => {
  assert.deepEqual(P.parseCommands('/hold\n```\n/release'), [{ name: 'hold', args: [] }]);
  assert.deepEqual(P.parseCommands('````\n```\n/release\n````\n/unhold'), [{ name: 'unhold', args: [] }]);
  assert.deepEqual(P.parseCommands('/size m\r\n/kind bug\r\n'), [{ name: 'size', args: ['m'] }, { name: 'kind', args: ['bug'] }]);
  assert.deepEqual(P.parseCommands(''), []);
  assert.deepEqual(P.parseCommands(undefined), []);
});

test('parseCommands: command with trailing whitespace and distinguishes block/unblock/hold/unhold', () => {
  assert.deepEqual(P.parseCommands('/unblock   \n/unhold'), [{ name: 'unblock', args: [] }, { name: 'unhold', args: [] }]);
  assert.deepEqual(P.parseCommands('/handoff chen'), [{ name: 'handoff', args: ['chen'] }]);
});

test('parseMentions: dedupe, lowercase, code and quote exclusion', () => {
  const body = 'hi @Alice and @alice, also @bob-gh.\n> @quoted\n`@inline`\n```\n@fenced\n```\nmail me@example.com or @team/core\n@last';
  assert.deepEqual(P.parseMentions(body), ['alice', 'bob-gh', 'last']);
});

test('parseMentions: edge cases', () => {
  assert.deepEqual(P.parseMentions('(@a) [@b] @c-'), ['a', 'b', 'c']);
  assert.deepEqual(P.parseMentions('no mentions'), []);
  assert.deepEqual(P.parseMentions(null), []);
  assert.deepEqual(P.parseMentions('@@x'), []);
});

test('leaseUntil / isExpired', () => {
  assert.equal(P.leaseUntil(new Date('2026-11-06T13:00:00.789Z'), 120), '2026-11-06T15:00:00Z');
  assert.equal(P.leaseUntil(NOW, 0.5), '2026-11-06T12:00:30Z');
  assert.equal(P.isExpired({ lease: new Date(NOW.getTime() + 1) }, NOW), false);
  assert.equal(P.isExpired({ lease: new Date(NOW.getTime()) }, NOW), true);
  assert.equal(P.isExpired({ lease: null }, NOW), true);
});

test('extractClaims: markers, released, human /claim; ignores others', () => {
  const comments = [
    agentC('a', 'claim', { lease: iso(30) }, 5),
    agentC('b', 'released', { reason: 'done' }, 6),
    agentC('c', 'note', {}, 7),
    humanC('dan', '/claim', 8, '2026-11-06T10:00:00Z'),
    humanC('eve', 'just chatting', 9),
    humanC('fay', '> /claim', 10),
  ];
  const cl = P.extractClaims(comments, { humanLeaseMinutes: 60 });
  assert.equal(cl.length, 3);
  assert.deepEqual(cl.map((c) => [c.commentId, c.handle, c.actor, c.type]), [
    [5, 'a', 'agent', 'claim'],
    [6, 'b', 'agent', 'released'],
    [8, 'dan', 'human', 'claim'],
  ]);
  assert.equal(cl[0].lease.toISOString(), new Date(iso(30)).toISOString());
  assert.equal(cl[0].login, 'a-gh');
  assert.equal(cl[2].lease.toISOString(), '2026-11-06T11:00:00.000Z');
  const mapped = P.extractClaims(comments, { resolveHandle: (l) => (l === 'dan' ? 'daniel' : null) });
  assert.equal(mapped[2].handle, 'daniel');
});

test('extractClaims: claim marker without lease has null lease and is never live', () => {
  const c = { id: 1, user: { login: 'x' }, created_at: iso(-5), body: '<!-- issuemesh v1 from=a actor=agent type=claim -->' };
  assert.equal(P.extractClaims([c])[0].lease, null);
  assert.deepEqual(P.liveClaims([c], { now: NOW }), []);
});

test('arbitrate: no claims', () => {
  assert.deepEqual(P.arbitrate([], { now: NOW }), { winner: null, losers: [] });
});

test('arbitrate: lowest comment id wins a race regardless of array order', () => {
  const comments = [agentC('bob', 'claim', { lease: iso(60) }, 30), agentC('aalhad', 'claim', { lease: iso(60) }, 20), agentC('chen', 'claim', { lease: iso(60) }, 25)];
  const r = P.arbitrate(comments, { now: NOW });
  assert.equal(r.winner.handle, 'aalhad');
  assert.deepEqual(r.losers.map((l) => l.handle), ['chen', 'bob']);
});

test('arbitrate: expired lease does not win even with lower id', () => {
  const comments = [agentC('old', 'claim', { lease: iso(-1) }, 1), agentC('new', 'claim', { lease: iso(60) }, 2)];
  const r = P.arbitrate(comments, { now: NOW });
  assert.equal(r.winner.handle, 'new');
  assert.equal(r.losers.length, 0);
});

test('arbitrate: released claims are not live; lost-race edit promotes next', () => {
  const lost = P.replaceMarker(agentC('a', 'claim', { lease: iso(60) }, 1).body, { type: 'released', reason: 'lost-race' });
  const comments = [{ id: 1, user: { login: 'a' }, created_at: iso(-3), body: lost }, agentC('b', 'claim', { lease: iso(60) }, 2)];
  assert.equal(P.arbitrate(comments, { now: NOW }).winner.handle, 'b');
});

test('arbitrate: claim lease bump (edit) keeps the original id', () => {
  const a = agentC('a', 'claim', { lease: iso(1) }, 1);
  a.body = P.replaceMarker(a.body, { lease: iso(120) });
  assert.equal(P.arbitrate([agentC('b', 'claim', { lease: iso(60) }, 2), a], { now: NOW }).winner.handle, 'a');
});

test('human /claim is live within window, dead after, and loses to nothing older', () => {
  const live = humanC('dan', '/claim', 3, iso(-60));
  assert.equal(P.arbitrate([live], { now: NOW, humanLeaseMinutes: 120 }).winner.login, 'dan');
  assert.equal(P.arbitrate([live], { now: NOW, humanLeaseMinutes: 30 }).winner, null);
});

test('human claim older than an agent claim wins (agents cannot override)', () => {
  const comments = [humanC('dan', '/claim', 3, iso(-5)), agentC('a', 'claim', { lease: iso(60) }, 4)];
  const r = P.arbitrate(comments, { now: NOW, humanLeaseMinutes: 2880 });
  assert.equal(r.winner.actor, 'human');
  assert.equal(r.losers[0].handle, 'a');
});

test('human /release by same login kills the earlier /claim only', () => {
  const comments = [
    humanC('dan', '/claim', 3, iso(-50)),
    humanC('eve', '/claim', 4, iso(-40)),
    humanC('dan', 'done for now\n/release', 5, iso(-30)),
  ];
  const live = P.liveClaims(comments, { now: NOW, humanLeaseMinutes: 2880 });
  assert.deepEqual(live.map((c) => c.login), ['eve']);
});

test('re-claiming after /release is live again; /release is case-insensitive on login', () => {
  const comments = [humanC('Dan', '/claim', 3), humanC('dan', '/release', 4), humanC('DAN', '/claim', 5)];
  const live = P.liveClaims(comments, { now: NOW, humanLeaseMinutes: 2880 });
  assert.deepEqual(live.map((c) => c.commentId), [5]);
});

test('/release inside a code fence does not release', () => {
  const comments = [humanC('dan', '/claim', 3), humanC('dan', '```\n/release\n```', 4)];
  assert.equal(P.liveClaims(comments, { now: NOW, humanLeaseMinutes: 2880 }).length, 1);
});

test('liveClaims honours releasedHandles', () => {
  const comments = [agentC('a', 'claim', { lease: iso(60) }, 1), agentC('b', 'claim', { lease: iso(60) }, 2)];
  const live = P.liveClaims(comments, { now: NOW, releasedHandles: ['a'] });
  assert.deepEqual(live.map((c) => c.handle), ['b']);
});

test('agentStreak counts trailing agent comments until a human', () => {
  const c = [
    humanC('h', 'hi', 1),
    agentC('a', 'note', {}, 2),
    agentC('b', 'note', {}, 3),
    agentC('a', 'note', {}, 4),
  ];
  const s = P.agentStreak(c);
  assert.equal(s.length, 3);
  assert.deepEqual([...s.handles].sort(), ['a', 'b']);
  assert.equal(P.agentStreak([]).length, 0);
  assert.equal(P.agentStreak([agentC('a', 'note', {}, 9), humanC('h', 'stop', 10)]).length, 0);
});

test('loopGuardTripped: threshold, two handles, human reset', () => {
  const mk = (handles, start = 1) => handles.map((h, i) => agentC(h, 'note', {}, start + i));
  assert.equal(P.loopGuardTripped(mk(['a', 'b', 'a', 'b']), 4), true);
  assert.equal(P.loopGuardTripped(mk(['a', 'b', 'a']), 4), false); // below threshold
  assert.equal(P.loopGuardTripped(mk(['a', 'a', 'a', 'a']), 4), false); // one handle only
  const withHuman = [...mk(['a', 'b', 'a', 'b']), humanC('h', 'ok', 50)];
  assert.equal(P.loopGuardTripped(withHuman, 4), false);
  const humanThenAgents = [humanC('h', 'ok', 1), ...mk(['a', 'b', 'a', 'b'], 2)];
  assert.equal(P.loopGuardTripped(humanThenAgents, 4), true);
  assert.equal(P.loopGuardTripped(humanThenAgents, 5), false);
});

test('loopGuardTripped: referee comments count as a second handle', () => {
  const c = [agentC('a', 'note', {}, 1), agentC('a', 'note', {}, 2), agentC('referee', 'escalate', {}, 3)];
  assert.equal(P.loopGuardTripped(c, 3), true);
});

/* ------------------------------------------------------------------ inbox */

const config = normalizeConfig({
  version: 1,
  members: [
    { handle: 'aalhad', github: 'AalhadS' },
    { handle: 'bob', github: 'bob-gh' },
    { handle: 'chen', github: 'chen-gh', agent: { enabled: false } },
  ],
  triage: { rotation: ['bob', 'aalhad'], period: 'daily' },
});
// unix_days for NOW = 20763 (odd) -> rotation[1] = aalhad on duty today, bob tomorrow
const me = config.members[0];
const ME2 = config.members[1];

let n = 0;
function item(labels, extra = {}) {
  n++;
  return { number: n, title: 't' + n, labels, assignees: [], isPR: false, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-02T00:00:00Z', url: 'u' + n, ...extra };
}
const ctx = (extra = {}) => ({ me, config, now: NOW, myLiveClaimCount: 0, ...extra });

test('triage fixture sanity: aalhad on duty today', () => {
  assert.equal(require('../lib/config').triagerOnDuty(config, NOW), 'aalhad');
});

test('classifyInbox: every bucket, ordered, with names and reasons', () => {
  const items = [
    item(['status:ready', 'to:any']),
    item(['status:triage']),
    item(['status:ready', 'to:aalhad']),
    item(['status:review', 'to:aalhad'], { isPR: true }),
    item(['status:claimed'], { assignees: ['aalhads'] }),
    item(['ping:aalhad']),
  ];
  const r = P.classifyInbox(items, ctx());
  assert.deepEqual(r.map((x) => x.bucketName), ['mailbox', 'active', 'review', 'routed', 'triage', 'market']);
  assert.deepEqual(r.map((x) => x.bucket), [1, 2, 3, 4, 5, 6]);
  for (const x of r) assert.ok(x.reason);
  assert.equal(r[0].number, items[5].number);
  assert.equal(r[0].url, items[5].url);
});

test('classifyInbox: dedupe to lowest bucket', () => {
  const both = item(['ping:aalhad', 'status:claimed', 'to:aalhad'], { assignees: ['AalhadS'] });
  const r = P.classifyInbox([both], ctx());
  assert.equal(r.length, 1);
  assert.equal(r[0].bucketName, 'mailbox');
});

test('classifyInbox: review bucket requires a PR; issues with to:me + review are skipped', () => {
  const issue = item(['status:review', 'to:aalhad']);
  assert.deepEqual(P.classifyInbox([issue], ctx()), []);
});

test('classifyInbox: priority then oldest first; active newest activity first', () => {
  const a = item(['status:ready', 'to:aalhad'], { createdAt: '2026-11-03T00:00:00Z' });
  const b = item(['status:ready', 'to:aalhad', 'priority:p0'], { createdAt: '2026-11-04T00:00:00Z' });
  const c = item(['status:ready', 'to:aalhad', 'priority:p3'], { createdAt: '2026-11-01T00:00:00Z' });
  const d = item(['status:ready', 'to:aalhad', 'priority:p2'], { createdAt: '2026-11-02T00:00:00Z' });
  assert.deepEqual(P.classifyInbox([a, b, c, d], ctx()).map((x) => x.number), [b.number, d.number, a.number, c.number]);

  const act = (u, extra = []) => item(['status:claimed', ...extra], { assignees: ['aalhads'], updatedAt: u });
  const x1 = act('2026-11-05T00:00:00Z');
  const x2 = act('2026-11-06T00:00:00Z');
  const x3 = act('2026-11-04T00:00:00Z', ['priority:p1']);
  assert.deepEqual(P.classifyInbox([x1, x2, x3], ctx()).map((x) => x.number), [x3.number, x2.number, x1.number]);
});

test('classifyInbox: ties break by issue number', () => {
  const a = item(['status:ready', 'to:aalhad']);
  const b = item(['status:ready', 'to:aalhad']);
  assert.deepEqual(P.classifyInbox([b, a], ctx()).map((x) => x.number), [a.number, b.number]);
});

test('classifyInbox: market gated by WIP and human-only', () => {
  const m = item(['status:ready', 'to:any']);
  const ho = item(['status:ready', 'to:any', 'human-only']);
  assert.deepEqual(P.classifyInbox([m, ho], ctx({ myLiveClaimCount: 1 })).map((x) => x.number), [m.number]);
  assert.deepEqual(P.classifyInbox([m, ho], ctx({ myLiveClaimCount: 2 })), []);
  const custom = { ...me, agents: [{ ...me.agents[0], wip: 3 }] };
  assert.equal(P.classifyInbox([m], ctx({ me: custom, myLiveClaimCount: 2 })).length, 1);
});

test('classifyInbox: market ignores items not ready; routed to others never shown', () => {
  const items = [item(['status:claimed', 'to:any']), item(['status:ready', 'to:bob']), item(['status:ready'])];
  assert.deepEqual(P.classifyInbox(items, ctx()), []);
});

test('classifyInbox: triage only for the triager on duty', () => {
  const t = item(['status:triage']);
  assert.equal(P.classifyInbox([t], ctx()).length, 1);
  assert.deepEqual(P.classifyInbox([t], ctx({ me: ME2 })), []);
  const tomorrow = new Date(NOW.getTime() + 86400000);
  assert.equal(P.classifyInbox([t], ctx({ me: ME2, now: tomorrow }))[0].bucketName, 'triage');
  assert.deepEqual(P.classifyInbox([t], ctx({ now: tomorrow })), []);
});

test('classifyInbox: mailbox of another member does not leak; others\' active work excluded', () => {
  const items = [item(['ping:bob']), item(['status:claimed'], { assignees: ['bob-gh'] })];
  assert.deepEqual(P.classifyInbox(items, ctx()), []);
});

test('classifyInbox: accepts label objects, empty inputs, disabled agent', () => {
  const objLabels = item([{ name: 'ping:aalhad' }]);
  assert.equal(P.classifyInbox([objLabels], ctx()).length, 1);
  assert.deepEqual(P.classifyInbox([], ctx()), []);
  assert.deepEqual(P.classifyInbox(undefined, ctx()), []);
  const off = { ...me, agents: [] };
  assert.deepEqual(P.classifyInbox([objLabels], ctx({ me: off })), []);
});

test('classifyInbox does not mutate its input or leak helper fields', () => {
  const it = item(['ping:aalhad']);
  const copy = JSON.parse(JSON.stringify(it));
  const r = P.classifyInbox([it], ctx());
  assert.deepEqual(it, copy);
  assert.equal(Object.keys(r[0]).includes('_prio'), false);
});

/* ============================================ agent ids, attribution (F1/F2) */

const mcfg = normalizeConfig({
  version: 1,
  members: [
    { handle: 'aalhad', github: 'AalhadS', agents: [{ name: 'claude', wip: 2 }, { name: 'codex', wip: 1 }] },
    { handle: 'bob', github: 'bob-gh' },
    { handle: 'chen', github: 'chen-gh', agent: { enabled: false } },
  ],
  triage: { rotation: ['bob', 'aalhad'] }, // aalhad on duty on NOW
});
const [AAL, BOB, CHEN] = mcfg.members;
const authored = (login, from, type, extra = {}, id = nextId++, actor = 'agent') => ({
  id, user: { login }, created_at: iso(-10), body: P.composeMessage({ from, actor, type, body: 'x', ...extra }),
});

test('labels with agent ids: slash values parse as to:/ping: values and survive setNamespace', () => {
  const L = P.parseLabels(['to:aalhad/claude', 'ping:aalhad/codex', 'ping:bob', 'status:ready']);
  assert.equal(L.to, 'aalhad/claude');
  assert.deepEqual(L.pings, ['aalhad/codex', 'bob']);
  assert.deepEqual(L.other, []);
  assert.equal(P.parseLabels(['to:aalhad', 'to:aalhad/codex']).conflicts.to.length, 2);
  assert.deepEqual(P.setNamespace(['to:aalhad/claude', 'status:ready'], 'to', 'aalhad/codex'), ['status:ready', 'to:aalhad/codex']);
  assert.deepEqual(P.setNamespace(['to:aalhad/claude', 'ping:aalhad/claude'], 'to', null), ['ping:aalhad/claude']);
  assert.equal(P.toLabel('aalhad/claude'), 'to:aalhad/claude');
  assert.equal(P.pingLabel('aalhad/codex'), 'ping:aalhad/codex');
});

test('standardLabels: handle labels for all members, agent labels only for members with >1 agent', () => {
  const names = P.standardLabels(mcfg.members).map((l) => l.name);
  for (const n of ['to:aalhad', 'to:bob', 'to:chen', 'ping:aalhad', 'ping:bob', 'ping:chen', 'to:any']) assert.ok(names.includes(n), n);
  for (const n of ['to:aalhad/claude', 'to:aalhad/codex', 'ping:aalhad/claude', 'ping:aalhad/codex']) assert.ok(names.includes(n), n);
  assert.ok(!names.some((n) => n.startsWith('to:bob/') || n.startsWith('ping:bob/') || n.startsWith('ping:chen/')));
  assert.equal(new Set(names).size, names.length);
  // strings: handles and agent ids still work
  const viaStrings = P.standardLabels(['aalhad', 'aalhad/claude']).map((l) => l.name);
  assert.ok(viaStrings.includes('ping:aalhad/claude') && viaStrings.includes('to:aalhad'));
  for (const l of P.standardLabels(mcfg.members)) assert.ok(l.name.length <= 50 && l.description.length <= 100, l.name);
  assert.equal(P.standardLabels(['bob']).find((l) => l.name === 'ping:bob').description, "Unread message for bob's agent");
});

test('fromHandle, senderName and signature for agent ids', () => {
  assert.equal(P.fromHandle('aalhad/claude'), 'aalhad');
  assert.equal(P.fromHandle('aalhad'), 'aalhad');
  assert.equal(P.fromHandle(undefined), '');
  assert.equal(P.senderName('aalhad/claude'), 'aalhad/claude');
  assert.equal(P.senderName('bob'), "bob's agent");
  assert.equal(P.signature('aalhad/claude'), '<sub>🤖 aalhad/claude · IssueMesh</sub>');
  assert.equal(P.signature('bob'), "<sub>🤖 bob's agent · IssueMesh</sub>");
  const msg = P.composeMessage({ from: 'aalhad/codex', type: 'note', body: 'hi' });
  assert.equal(P.parseMarker(msg).from, 'aalhad/codex');
  assert.ok(msg.endsWith('<sub>🤖 aalhad/codex · IssueMesh</sub>'));
  assert.equal(P.actorOf(msg), 'agent');
});

test('targetsAgent: the mailbox rule and to: routing', () => {
  // to:<handle> reaches every agent; to:<handle/agent> only that agent
  assert.equal(P.targetsAgent('aalhad', AAL, 'claude', 'to'), true);
  assert.equal(P.targetsAgent('aalhad', AAL, 'codex', 'to'), true);
  assert.equal(P.targetsAgent('aalhad/codex', AAL, 'codex', 'to'), true);
  assert.equal(P.targetsAgent('aalhad/codex', AAL, 'claude', 'to'), false);
  // ping:<handle> is the primary agent's only
  assert.equal(P.targetsAgent('aalhad', AAL, 'claude', 'ping'), true);
  assert.equal(P.targetsAgent('aalhad', AAL, 'codex', 'ping'), false);
  assert.equal(P.targetsAgent('aalhad/codex', AAL, 'codex', 'ping'), true);
  assert.equal(P.targetsAgent('Aalhad/Claude', AAL, 'claude', 'ping'), true);
  assert.equal(P.targetsAgent('bob', AAL, 'claude', 'to'), false);
  assert.equal(P.targetsAgent('bob/claude', AAL, 'claude', 'to'), false);
  assert.equal(P.targetsAgent('bob', BOB, 'claude', 'ping'), true);
  assert.equal(P.targetsAgent('bob/claude', BOB, 'claude', 'ping'), true);
  assert.equal(P.targetsAgent('chen', CHEN, null, 'ping'), true);
});

/* ---- verifyComment (F2) ---- */

test('verifyComment: own marker, case-insensitive login, agent id', () => {
  const v = P.verifyComment(authored('aalhads', 'aalhad/claude', 'claim', { lease: iso(60) }), mcfg);
  assert.equal(v.verified, true);
  assert.equal(v.handle, 'aalhad');
  assert.equal(v.agentId, 'aalhad/claude');
  assert.equal(v.actor, 'agent');
  assert.equal(v.marker.type, 'claim');
  const plain = P.verifyComment(authored('bob-gh', 'bob', 'note'), mcfg);
  assert.deepEqual([plain.verified, plain.handle, plain.agentId], [true, 'bob', 'bob']);
});

test('verifyComment: a marker whose from= is another member is unverified (treated as a human comment by the author)', () => {
  const v = P.verifyComment(authored('bob-gh', 'aalhad', 'claim', { lease: iso(60) }), mcfg);
  assert.equal(v.verified, false);
  assert.equal(v.marker, null);
  assert.equal(v.actor, 'human');
  assert.equal(v.handle, 'bob'); // its real author
  assert.equal(v.agentId, null);
  assert.equal(P.verifyComment(authored('bob-gh', 'aalhad/claude', 'note'), mcfg).verified, false);
});

test('verifyComment: non-members never verify; github-actions[bot] verifies any from', () => {
  const stranger = P.verifyComment(authored('stranger', 'aalhad', 'note'), mcfg);
  assert.deepEqual([stranger.verified, stranger.handle, stranger.actor], [false, null, 'human']);
  const strangerOwn = P.verifyComment(authored('stranger', 'stranger', 'note'), mcfg);
  assert.equal(strangerOwn.verified, false);
  for (const login of ['github-actions[bot]', 'GitHub-Actions[bot]']) {
    const bot = P.verifyComment(authored(login, 'referee', 'escalate'), mcfg);
    assert.deepEqual([bot.verified, bot.handle, bot.agentId], [true, 'referee', 'referee']);
    assert.equal(P.verifyComment(authored(login, 'aalhad', 'claim', { actor: 'human' }, 5, 'human'), mcfg).actor, 'human');
  }
  // a member cannot pose as the referee
  assert.equal(P.verifyComment(authored('aalhads', 'referee', 'escalate'), mcfg).verified, false);
});

test('verifyComment: no marker, malformed marker, missing user, actor=human', () => {
  assert.deepEqual(P.verifyComment({ id: 1, body: 'plain', user: { login: 'bob-gh' } }, mcfg), { verified: false, handle: 'bob', agentId: null, actor: 'human', marker: null, login: 'bob-gh' });
  assert.equal(P.verifyComment({ id: 1, body: '<!-- issuemesh v1 type=claim -->', user: { login: 'bob-gh' } }, mcfg).verified, false);
  assert.equal(P.verifyComment({ id: 1, body: '<!-- issuemesh v2 from=bob actor=agent type=note -->' , user: { login: 'bob-gh' } }, mcfg).verified, false);
  const noUser = P.verifyComment({ id: 1, body: P.composeMessage({ from: 'bob', type: 'note' }) }, mcfg);
  assert.deepEqual([noUser.verified, noUser.handle], [false, null]);
  const human = P.verifyComment(authored('bob-gh', 'bob', 'note', {}, 7, 'human'), mcfg);
  assert.deepEqual([human.verified, human.actor], [true, 'human']);
});

/* ---- claims, arbitration, streak with opts.config (F2) ---- */

const live = (comments, extra = {}) => P.liveClaims(comments, { now: NOW, humanLeaseMinutes: 2880, config: mcfg, ...extra });

test('extractClaims: records carry handle (member) and agentId (full from)', () => {
  const [c] = P.extractClaims([authored('aalhads', 'aalhad/codex', 'claim', { lease: iso(60) }, 3)], { config: mcfg });
  assert.deepEqual([c.handle, c.agentId, c.actor, c.type], ['aalhad', 'aalhad/codex', 'agent', 'claim']);
  const [h] = P.extractClaims([humanC('bob-gh', '/claim', 4)], { config: mcfg, resolveHandle: () => 'bob' });
  assert.deepEqual([h.handle, h.agentId, h.actor], ['bob', 'bob', 'human']);
  // without config nothing is verified: legacy behaviour
  const [legacy] = P.extractClaims([agentC('zed', 'claim', { lease: iso(60) }, 9)]);
  assert.deepEqual([legacy.handle, legacy.agentId], ['zed', 'zed']);
});

test('forged claim (from=other member) is ignored; it cannot win arbitration', () => {
  const forged = authored('bob-gh', 'aalhad/claude', 'claim', { lease: iso(60) }, 5); // lowest id, but bob did not write for aalhad
  const real = authored('aalhads', 'aalhad/claude', 'claim', { lease: iso(60) }, 9);
  const r = P.arbitrate([real, forged], { now: NOW, config: mcfg });
  assert.equal(r.winner.commentId, 9);
  assert.equal(r.losers.length, 0);
  // without verification the forgery would have won
  assert.equal(P.arbitrate([real, forged], { now: NOW }).winner.commentId, 5);
});

test('forged claim from a non-member, and /claim from a non-member, are ignored', () => {
  assert.equal(live([authored('stranger', 'stranger', 'claim', { lease: iso(60) }, 1)]).length, 0);
  assert.equal(live([humanC('stranger', '/claim', 2)]).length, 0);
  assert.equal(live([humanC('stranger', '/claim', 2)], { config: undefined }).length, 1); // legacy path
});

test('an unverified marker is an ordinary human comment: a /claim line inside it counts as the author\'s human claim', () => {
  const sneaky = { id: 4, user: { login: 'bob-gh' }, created_at: iso(-5), body: '<!-- issuemesh v1 from=aalhad actor=agent type=note -->\n/claim' };
  const claims = P.extractClaims([sneaky], { config: mcfg, resolveHandle: () => 'bob', humanLeaseMinutes: 60 });
  assert.deepEqual(claims.map((c) => [c.handle, c.actor]), [['bob', 'human']]);
});

test('referee-authored (github-actions[bot]) human-claim records verify for the member named in from', () => {
  const rec = authored('github-actions[bot]', 'bob', 'claim', { lease: iso(60), actor: 'human' }, 6, 'human');
  const claims = live([rec]);
  assert.equal(claims.length, 1);
  assert.deepEqual([claims[0].handle, claims[0].actor, claims[0].login], ['bob', 'human', 'github-actions[bot]']);
});

test('liveClaims: only a member\'s own /release releases; a non-member cannot', () => {
  const claim = humanC('bob-gh', '/claim', 3);
  assert.equal(live([claim, humanC('stranger', '/release', 4)]).length, 1);
  assert.equal(live([claim, humanC('bob-gh', '/release', 4)]).length, 0);
  // a forged-marker /release does not hide behind the marker: it is the author's own human comment
  const forgedRelease = { id: 5, user: { login: 'bob-gh' }, created_at: iso(-1), body: '<!-- issuemesh v1 from=aalhad actor=agent type=note -->\n/release' };
  assert.equal(live([claim, forgedRelease]).length, 0);
});

test('claims by two agents of one member race like any two claimants (lowest id wins)', () => {
  const a = authored('aalhads', 'aalhad/codex', 'claim', { lease: iso(60) }, 12);
  const b = authored('aalhads', 'aalhad/claude', 'claim', { lease: iso(60) }, 11);
  const r = P.arbitrate([a, b], { now: NOW, config: mcfg });
  assert.equal(r.winner.agentId, 'aalhad/claude');
  assert.deepEqual(r.losers.map((l) => l.agentId), ['aalhad/codex']);
});

test('agentStreak/loopGuard: forged markers neither extend nor hide the streak; ids count as distinct senders', () => {
  const real = [
    authored('aalhads', 'aalhad/claude', 'note', {}, 1),
    authored('aalhads', 'aalhad/codex', 'note', {}, 2),
    authored('bob-gh', 'bob', 'note', {}, 3),
  ];
  const s = P.agentStreak(real, { config: mcfg });
  assert.equal(s.length, 3);
  assert.deepEqual([...s.handles].sort(), ['aalhad/claude', 'aalhad/codex', 'bob']);
  assert.equal(P.loopGuardTripped(real, 3, { config: mcfg }), true);
  // two agents of ONE member are two senders: they can loop with each other
  assert.equal(P.loopGuardTripped(real.slice(0, 2), 2, { config: mcfg }), true);
  assert.equal(P.loopGuardTripped([real[0], authored('aalhads', 'aalhad/claude', 'note', {}, 4)], 2, { config: mcfg }), false);

  // a forged agent marker (bob writing as aalhad) is a human comment: it resets the streak
  const forged = authored('bob-gh', 'aalhad/claude', 'note', {}, 4);
  const withForged = [...real, forged];
  assert.equal(P.agentStreak(withForged, { config: mcfg }).length, 0);
  assert.equal(P.loopGuardTripped(withForged, 3, { config: mcfg }), false);
  // ...and a forged marker in the middle cannot extend a streak either
  const spaced = [authored('aalhads', 'aalhad/claude', 'note', {}, 11), authored('bob-gh', 'aalhad/claude', 'note', {}, 12), authored('aalhads', 'aalhad/codex', 'note', {}, 13), authored('bob-gh', 'bob', 'note', {}, 14)];
  assert.equal(P.agentStreak(spaced, { config: mcfg }).length, 2);
  // legacy (no config): markers are trusted as written
  assert.equal(P.agentStreak(withForged).length, 4);
});

test('agentStreak: the referee bot\'s escalation counts as an agent comment', () => {
  const ref = authored('github-actions[bot]', 'referee', 'escalate', {}, 8);
  assert.equal(P.agentStreak([authored('aalhads', 'aalhad/claude', 'note', {}, 7), ref], { config: mcfg }).length, 2);
});

/* ---- classifyInbox with several agents (F1) ---- */

const cctx = (agent, extra = {}) => ({ me: AAL, config: mcfg, now: NOW, myLiveClaimCount: 0, agent, ...extra });

test('classifyInbox: mailbox rule - ping:<handle> goes to the primary agent only', () => {
  const bare = item(['ping:aalhad']);
  const toCodex = item(['ping:aalhad/codex']);
  const toClaude = item(['ping:aalhad/claude']);
  const all = [bare, toCodex, toClaude];
  const primary = P.classifyInbox(all, cctx(undefined));
  assert.deepEqual(primary.map((x) => x.number), [bare.number, toClaude.number]);
  assert.deepEqual(P.classifyInbox(all, cctx('claude')).map((x) => x.number), [bare.number, toClaude.number]);
  const codex = P.classifyInbox(all, cctx('codex'));
  assert.deepEqual(codex.map((x) => x.number), [toCodex.number]);
  assert.equal(codex[0].reason, 'labelled ping:aalhad/codex');
  assert.deepEqual(P.classifyInbox(all, cctx('ghost')), []);
});

test('classifyInbox: to:<handle> is claimable by any agent, to:<handle/agent> by that agent only', () => {
  const any = item(['status:ready', 'to:aalhad']);
  const onlyCodex = item(['status:ready', 'to:aalhad/codex']);
  const reviewCodex = item(['status:review', 'to:aalhad/codex'], { isPR: true });
  const all = [any, onlyCodex, reviewCodex];
  assert.deepEqual(P.classifyInbox(all, cctx('claude')).map((x) => x.number), [any.number]);
  const codex = P.classifyInbox(all, cctx('codex'));
  assert.deepEqual(codex.map((x) => x.bucketName), ['review', 'routed', 'routed']);
  assert.deepEqual(codex.map((x) => x.number), [reviewCodex.number, any.number, onlyCodex.number]);
  assert.equal(codex[0].reason, 'review requested (to:aalhad/codex)');
});

test('classifyInbox: triage duty goes to the primary agent only; WIP is per agent', () => {
  const t = item(['status:triage']);
  assert.equal(P.classifyInbox([t], cctx('claude')).length, 1);
  assert.deepEqual(P.classifyInbox([t], cctx('codex')), []);
  const m = item(['status:ready', 'to:any']);
  // codex wip is 1, claude wip is 2
  assert.equal(P.classifyInbox([m], cctx('claude', { myLiveClaimCount: 1 })).length, 1);
  assert.equal(P.classifyInbox([m], cctx('codex', { myLiveClaimCount: 1 })).length, 0);
  assert.match(P.classifyInbox([m], cctx('codex', { myLiveClaimCount: 0 }))[0].reason, /0\/1 claims held/);
});

test('classifyInbox: a single-agent member answers to both its handle and handle/agent', () => {
  const bobItems = [item(['ping:bob/claude']), item(['status:ready', 'to:bob/claude']), item(['ping:bob'])];
  assert.equal(P.classifyInbox(bobItems, { me: BOB, config: mcfg, now: NOW }).length, 3);
  assert.deepEqual(P.classifyInbox(bobItems, { me: CHEN, config: mcfg, now: NOW }), []);
});
