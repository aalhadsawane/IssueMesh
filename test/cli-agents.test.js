'use strict';

// Multiple named agents per member (F1), attribution (F2) and reply routing (F3), through the CLI.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const P = require('../lib/protocol');
const { makeEnv } = require('./cli-helpers');

const TEAM = {
  version: 1,
  members: [
    { handle: 'aalhad', github: 'aalhad-gh', agents: [{ name: 'claude', wip: 2 }, { name: 'codex', wip: 1 }] },
    { handle: 'ben', github: 'ben-gh', agent: { enabled: true, wip: 2 } },
    { handle: 'chen', github: 'chen-gh', agent: { enabled: false } },
  ],
  triage: { rotation: ['ben', 'aalhad'], period: 'daily' }, // aalhad on duty on the fixture date
  board_issue: null,
};

function setup(opts = {}) {
  const env = makeEnv({ team: TEAM, ...opts });
  test.after(() => env.cleanup());
  return env;
}

const msg = (from, type, extra = {}) => P.composeMessage({ from, type, body: 'x', ...extra });
const FUTURE = '2026-11-06T15:00:00Z';
const markerOf = (env, n, i = 0) => P.parseMarker(env.fake.commentsOf(n)[i].body);

/* ------------------------------------------------------------ identity */

test('whoami: agent selection by --agent, --as <id>, ISSUEMESH_AGENT; flag beats env; errors', async () => {
  const env = setup();
  let j = (await env.run(['whoami', '--json'])).json();
  assert.deepEqual([j.handle, j.agent, j.agent_id, j.wip], ['aalhad', 'claude', 'aalhad/claude', 2]);

  j = (await env.run(['whoami', '--json', '--agent', 'codex'])).json();
  assert.deepEqual([j.agent, j.agent_id, j.wip], ['codex', 'aalhad/codex', 1]);

  j = (await env.run(['whoami', '--json', '--as', 'aalhad/codex'])).json();
  assert.deepEqual([j.handle, j.agent_id], ['aalhad', 'aalhad/codex']);

  j = (await env.run(['whoami', '--json'], { env: { ISSUEMESH_AGENT: 'codex' } })).json();
  assert.equal(j.agent_id, 'aalhad/codex');
  j = (await env.run(['whoami', '--json', '--agent', 'claude'], { env: { ISSUEMESH_AGENT: 'codex' } })).json();
  assert.equal(j.agent_id, 'aalhad/claude');

  assert.equal((await env.run(['whoami', '--agent', 'ghost'])).code, 2);
  assert.match((await env.run(['whoami', '--agent', 'ghost'])).err, /no agent "ghost".*claude, codex/);
  assert.equal((await env.run(['whoami', '--as', 'aalhad/ghost'])).code, 2);
  assert.equal((await env.run(['whoami', '--as', 'aalhad/codex', '--agent', 'claude'])).code, 2);
  assert.equal((await env.run(['whoami', '--as', 'aalhad/codex', '--agent', 'codex'])).code, 0);
  assert.equal((await env.run(['whoami'], { env: { ISSUEMESH_AGENT: 'ghost' } })).code, 2);

  const text = (await env.run(['whoami'])).out;
  assert.match(text, /agent:\s+claude/);
  assert.match(text, /agent id:\s+aalhad\/claude/);
});

test('whoami: single-agent members keep the plain handle as agent id; members without agents have none', async () => {
  const env = setup();
  let j = (await env.run(['whoami', '--json', '--as', 'ben'])).json();
  assert.deepEqual([j.agent, j.agent_id, j.wip], ['claude', 'ben', 2]);
  assert.equal((await env.run(['whoami', '--json', '--as', 'ben', '--agent', 'claude'])).json().agent_id, 'ben');
  assert.equal((await env.run(['whoami', '--as', 'ben', '--agent', 'codex'])).code, 2);
  j = (await env.run(['whoami', '--json', '--as', 'chen'])).json();
  assert.deepEqual([j.agent, j.agent_id], [null, 'chen']);
  assert.equal((await env.run(['whoami', '--as', 'chen', '--agent', 'claude'])).code, 2);
});

test('global help documents --agent and agent ids', async () => {
  const env = setup();
  const h = (await env.run(['--help'])).out;
  assert.match(h, /--agent <name>/);
  assert.match(h, /--as <id>[\s\S]*<handle>\/<agent>/);
  assert.match(h, /ISSUEMESH_AGENT/);
});

/* -------------------------------------------------------------- claims */

test('claim as one agent: marker from=<agent id>, signature, text; WIP is per agent; sibling is "someone else"', async () => {
  const env = setup();
  const a = env.fake.addIssue({ labels: ['status:ready', 'to:aalhad'] });
  const b = env.fake.addIssue({ labels: ['status:ready', 'to:any'] });
  const c = env.fake.addIssue({ labels: ['status:ready', 'to:any'] });

  let r = await env.run(['claim', String(a), '--agent', 'codex', '--settle', '0', '--plan', 'p']);
  assert.equal(r.code, 0, r.err);
  const cm = env.fake.commentsOf(a)[0];
  assert.equal(P.parseMarker(cm.body).from, 'aalhad/codex');
  assert.match(cm.body, /\*\*Claimed\*\* by aalhad\/codex\./);
  assert.ok(cm.body.endsWith('<sub>🤖 aalhad/codex · IssueMesh</sub>'));
  assert.deepEqual(env.fake.assigneesOf(a), ['aalhad-gh']); // the assignee stays the member's login

  // the sibling agent cannot claim, report status, heartbeat or release it
  r = await env.run(['claim', String(a), '--agent', 'claude', '--settle', '0']);
  assert.equal(r.code, 3);
  assert.match(r.err, /already claimed by aalhad\/codex/);
  assert.equal((await env.run(['status', String(a), '--append', 'x', '--agent', 'claude'])).code, 3);
  assert.equal((await env.run(['heartbeat', String(a), '--agent', 'claude'])).code, 3);
  r = await env.run(['release', String(a), '--agent', 'claude']);
  assert.equal(r.code, 3);
  assert.match(r.err, /another agent of your member/);
  assert.deepEqual(env.fake.assigneesOf(a), ['aalhad-gh']);
  assert.equal(markerOf(env, a).type, 'claim');

  // codex wip is 1: its second claim fails; claude (wip 2) claims fine and counts separately
  r = await env.run(['claim', String(b), '--agent', 'codex', '--settle', '0']);
  assert.equal(r.code, 3);
  assert.match(r.err, /WIP limit reached \(1\/1/);
  assert.equal((await env.run(['claim', String(b), '--agent', 'claude', '--settle', '0'])).code, 0);
  assert.equal((await env.run(['claim', String(c), '--agent', 'claude', '--settle', '0'])).code, 0);
  assert.equal((await env.run(['claim', String(c), '--agent', 'claude', '--settle', '0'])).out.trim(), `#${c} is already claimed by aalhad.`);

  const codex = (await env.run(['whoami', '--json', '--agent', 'codex'])).json();
  const claude = (await env.run(['whoami', '--json', '--agent', 'claude'])).json();
  assert.deepEqual([codex.live_claims, codex.wip], [1, 1]);
  assert.deepEqual([claude.live_claims, claude.wip], [2, 2]);

  // the claimant keeps working on its own comment
  r = await env.run(['status', String(a), '--agent', 'codex', '--append', 'progress']);
  assert.equal(r.code, 0, r.err);
  assert.ok(env.fake.commentsOf(a)[0].body.endsWith('<sub>🤖 aalhad/codex · IssueMesh</sub>'));
  assert.equal((await env.run(['release', String(a), '--agent', 'codex'])).code, 0);
  assert.equal(markerOf(env, a).type, 'released');
});

test('claim routing: to:<handle/agent> only for that agent; to:<handle> for any', async () => {
  const env = setup();
  const n = env.fake.addIssue({ labels: ['status:ready', 'to:aalhad/codex'] });
  let r = await env.run(['claim', String(n), '--agent', 'claude', '--settle', '0']);
  assert.equal(r.code, 3);
  assert.match(r.err, /routed to aalhad\/codex/);
  assert.equal((await env.run(['claim', String(n), '--agent', 'codex', '--settle', '0'])).code, 0);

  const m = env.fake.addIssue({ labels: ['status:ready', 'to:aalhad'] });
  assert.equal((await env.run(['claim', String(m), '--agent', 'claude', '--settle', '0'])).code, 0);
});

test('claim race against the sibling agent: lower comment id wins, the loser keeps the shared assignee', async () => {
  const env = setup();
  const n = env.fake.addIssue({ labels: ['status:ready', 'to:aalhad'] });
  env.onSleep = async () => {
    env.fake.addComment(n, msg('aalhad/claude', 'claim', { lease: FUTURE }), { login: 'aalhad-gh', id: 50 });
  };
  const r = await env.run(['claim', String(n), '--agent', 'codex']);
  assert.equal(r.code, 3);
  assert.match(r.err, /lost the claim race on #\d+ to aalhad\/claude/);
  const mine = env.fake.commentsOf(n).find((c) => c.id !== 50);
  assert.equal(P.parseMarker(mine.body).type, 'released');
  assert.deepEqual(env.fake.assigneesOf(n), ['aalhad-gh'], 'same GitHub login: the winner still needs the assignment');
});

test('a legacy claim with a plain handle counts as the primary agent\'s', async () => {
  const env = setup();
  const n = env.fake.addIssue({ labels: ['status:claimed'], assignees: ['aalhad-gh'] });
  env.fake.addComment(n, msg('aalhad', 'claim', { lease: FUTURE }), { login: 'aalhad-gh' });
  assert.equal((await env.run(['status', String(n), '--append', 'x', '--agent', 'claude'])).code, 0);
  assert.equal((await env.run(['status', String(n), '--append', 'x', '--agent', 'codex'])).code, 3);
});

/* ------------------------------------------------------------ forgery */

test('forged claims are ignored by claim, status, release and arbitration', async () => {
  const env = setup();
  const n = env.fake.addIssue({ labels: ['status:ready', 'to:any'] });
  // chen forges a claim as ben; a stranger forges one as aalhad
  env.fake.addComment(n, msg('ben', 'claim', { lease: FUTURE }), { login: 'chen-gh', id: 10 });
  env.fake.addComment(n, msg('aalhad/claude', 'claim', { lease: FUTURE }), { login: 'stranger', id: 11 });
  let r = await env.run(['claim', String(n), '--settle', '0']);
  assert.equal(r.code, 0, r.err); // not blocked by "already claimed by ben"

  // a forged claim appearing during settle cannot beat the real one
  const m = env.fake.addIssue({ labels: ['status:ready', 'to:any'] });
  env.onSleep = async () => { env.fake.addComment(m, msg('ben', 'claim', { lease: FUTURE }), { login: 'chen-gh', id: 5 }); };
  r = await env.run(['claim', String(m)]);
  assert.equal(r.code, 0, r.err);
  env.onSleep = null;

  // status/release only see the member's own, verified claim comments
  const k = env.fake.addIssue({ labels: ['status:claimed'], assignees: ['aalhad-gh'] });
  env.fake.addComment(k, msg('aalhad/claude', 'claim', { lease: FUTURE }), { login: 'ben-gh' });
  assert.equal((await env.run(['status', String(k), '--append', 'x'])).code, 3);
  r = await env.run(['sweep', '--json']);
  assert.ok(r.json().skipped.some((x) => x.number === k && x.reason === 'no claim comment'));
});

test('a forged /claim inside an unverified marker is a human claim by its real author, and agents do not override it', async () => {
  const env = setup();
  const n = env.fake.addIssue({ labels: ['status:claimed'], assignees: ['ben-gh'] });
  env.fake.addComment(n, '<!-- issuemesh v1 from=aalhad actor=agent type=note -->\n/claim', { login: 'ben-gh' });
  const r = await env.run(['claim', String(n), '--settle', '0']);
  assert.equal(r.code, 3);
  assert.match(r.err, /already claimed by ben \(human claim/);
});

test('standup: per agent, and a forged standup marker does not count', async () => {
  const env = setup();
  const b = env.fake.addIssue({ labels: ['kind:board'] });
  env.fake.addComment(b, msg('aalhad/claude', 'standup'), { login: 'ben-gh' }); // forged
  let r = await env.run(['standup', '--body', 'claude: done', '--agent', 'claude']);
  assert.match(r.out, /Posted standup/);
  assert.match((await env.run(['standup', '--body', 'again', '--agent', 'claude'])).out, /already posted today for aalhad\/claude/);
  assert.match((await env.run(['standup', '--body', 'codex: done', '--agent', 'codex'])).out, /Posted standup/);
  assert.match((await env.run(['standup', '--body', 'again', '--agent', 'codex'])).out, /already posted today for aalhad\/codex/);
  const froms = env.fake.commentsOf(b).map((c) => (P.parseMarker(c.body) || {}).from);
  assert.deepEqual(froms, ['aalhad/claude', 'aalhad/claude', 'aalhad/codex']);
});

test('board: a marker that does not match its author reads as a human comment', async () => {
  const env = setup();
  const b = env.fake.addIssue({ labels: ['kind:board'] });
  env.fake.addComment(b, msg('aalhad', 'broadcast'), { login: 'ben-gh', id: 20 });
  env.fake.addComment(b, msg('aalhad', 'broadcast'), { login: 'aalhad-gh', id: 21 });
  const rows = (await env.run(['board', '--json'])).json();
  assert.deepEqual(rows.map((x) => [x.id, x.actor, x.type, x.from]), [[20, 'human', null, null], [21, 'agent', 'broadcast', 'aalhad']]);
  assert.match(rows[0].body, /issuemesh v1 from=aalhad/); // shown as the raw human text
});

/* --------------------------------------------------- addressing commands */

test('route/ping/post accept handles and agent ids; single-agent ids collapse to the handle', async () => {
  const env = setup();
  const n = env.fake.addIssue({ labels: ['status:triage', 'to:any'] });
  assert.equal((await env.run(['route', String(n), 'aalhad/codex'])).code, 0);
  let l = env.fake.labelsOf(n);
  assert.ok(l.includes('to:aalhad/codex') && !l.includes('to:any') && l.includes('status:ready'));
  assert.equal((await env.run(['route', String(n), 'aalhad'])).code, 0);
  assert.deepEqual(env.fake.labelsOf(n).filter((x) => x.startsWith('to:')), ['to:aalhad']);
  assert.equal((await env.run(['route', String(n), '@aalhad/claude'])).code, 0);
  assert.deepEqual(env.fake.labelsOf(n).filter((x) => x.startsWith('to:')), ['to:aalhad/claude']);
  assert.equal((await env.run(['route', String(n), 'ben/claude'])).code, 0);
  assert.deepEqual(env.fake.labelsOf(n).filter((x) => x.startsWith('to:')), ['to:ben']);
  assert.equal((await env.run(['route', String(n), 'any'])).code, 0);
  assert.equal((await env.run(['route', String(n), 'aalhad/ghost'])).code, 2);
  assert.equal((await env.run(['route', String(n), 'ben/codex'])).code, 2);
  assert.equal((await env.run(['route', String(n), 'zed'])).code, 2);

  const p = env.fake.addIssue({});
  const r = await env.run(['ping', String(p), 'aalhad/codex', 'ben', '--json']);
  assert.deepEqual(r.json().pinged, ['aalhad/codex', 'ben']);
  assert.ok(env.fake.labelsOf(p).includes('ping:aalhad/codex') && env.fake.labelsOf(p).includes('ping:ben'));
  assert.equal((await env.run(['ping', String(p), 'aalhad/ghost'])).code, 2);
  await env.run(['ping', String(p), 'all']);
  assert.deepEqual(env.fake.labelsOf(p).filter((x) => x.startsWith('ping:')).sort(), ['ping:aalhad/codex', 'ping:ben']); // not me, not chen

  const q = env.fake.addIssue({});
  assert.equal((await env.run(['post', String(q), '--type', 'ask', '--to', 'aalhad/claude,ben', '--body', 'which?'])).code, 0);
  assert.equal(markerOf(env, q).to, 'aalhad/claude,ben');
  assert.deepEqual(env.fake.labelsOf(q).sort(), ['ping:aalhad/claude', 'ping:ben']);
  assert.equal((await env.run(['post', String(q), '--type', 'ask', '--to', 'aalhad/ghost', '--body', 'x'])).code, 2);
  assert.equal((await env.run(['post', String(q), '--type', 'handoff', '--to', 'aalhad/codex,ben', '--body', 'x'])).code, 2);
});

test('handoff to a sibling agent or another member; self handoff is refused', async () => {
  const env = setup();
  const n = env.fake.addIssue({ labels: ['status:ready', 'to:aalhad'] });
  assert.equal((await env.run(['claim', String(n), '--agent', 'codex', '--settle', '0'])).code, 0);
  assert.equal((await env.run(['handoff', String(n), 'aalhad/codex', '--note', 'x', '--agent', 'codex'])).code, 2);
  assert.equal((await env.run(['handoff', String(n), 'aalhad', '--note', 'x', '--agent', 'codex'])).code, 2);
  assert.equal((await env.run(['handoff', String(n), 'aalhad/ghost', '--note', 'x', '--agent', 'codex'])).code, 2);
  const r = await env.run(['handoff', String(n), 'aalhad/claude', '--note', 'over to you', '--agent', 'codex']);
  assert.equal(r.code, 0, r.err);
  const ho = env.fake.commentsOf(n).map((c) => P.parseMarker(c.body)).find((m) => m.type === 'handoff');
  assert.deepEqual([ho.from, ho.to], ['aalhad/codex', 'aalhad/claude']);
  const l = env.fake.labelsOf(n);
  assert.ok(l.includes('to:aalhad/claude') && l.includes('ping:aalhad/claude') && l.includes('status:ready'));

  const j = (await env.run(['inbox', '--json', '--agent', 'claude'])).json();
  assert.deepEqual(j.items.map((i) => i.bucketName), ['mailbox']);
  assert.deepEqual((await env.run(['inbox', '--json', '--agent', 'codex'])).json().items, []);
});

test('ack removes only the pings addressed to this agent (ping:<handle> is the primary\'s)', async () => {
  const env = setup();
  const n = env.fake.addIssue({ labels: ['ping:aalhad', 'ping:aalhad/claude', 'ping:aalhad/codex', 'ping:ben'] });
  let r = await env.run(['ack', String(n), '--agent', 'codex']);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(env.fake.labelsOf(n).sort(), ['ping:aalhad', 'ping:aalhad/claude', 'ping:ben']);
  r = await env.run(['ack', String(n), '--agent', 'codex']);
  assert.match(r.out, /nothing to ack/);
  r = await env.run(['ack', String(n), '--agent', 'claude']);
  assert.deepEqual(env.fake.labelsOf(n), ['ping:ben']);
  assert.equal(env.fake.reactions.length, 2);

  const m = env.fake.addIssue({ labels: ['ping:ben', 'ping:ben/claude'] });
  await env.run(['ack', String(m), '--as', 'ben']);
  assert.deepEqual(env.fake.labelsOf(m), []);
});

/* -------------------------------------------------------------- inbox */

test('inbox per agent: mailbox rule, routing, triage duty, WIP, active work held by a sibling', async () => {
  const env = setup();
  const f = env.fake;
  const bare = f.addIssue({ title: 'bare ping', labels: ['ping:aalhad'] });
  const pc = f.addIssue({ title: 'ping codex', labels: ['ping:aalhad/codex'] });
  const any = f.addIssue({ title: 'to handle', labels: ['status:ready', 'to:aalhad'] });
  const onlyCodex = f.addIssue({ title: 'to codex', labels: ['status:ready', 'to:aalhad/codex'] });
  const onlyClaude = f.addIssue({ title: 'to claude', labels: ['status:ready', 'to:aalhad/claude'] });
  const tri = f.addIssue({ title: 'triage', labels: ['status:triage'] });
  const market = f.addIssue({ title: 'market', labels: ['status:ready', 'to:any'] });
  const heldByCodex = f.addIssue({ title: 'held by codex', labels: ['status:claimed'], assignees: ['aalhad-gh'] });
  f.addComment(heldByCodex, msg('aalhad/codex', 'claim', { lease: FUTURE }), { login: 'aalhad-gh' });
  const uiAssigned = f.addIssue({ title: 'ui assigned', labels: ['status:claimed'], assignees: ['aalhad-gh'] });

  const names = (j) => j.items.map((i) => `${i.number}:${i.bucketName}`);
  const claude = (await env.run(['inbox', '--json', '--agent', 'claude'])).json();
  assert.deepEqual([claude.handle, claude.agent, claude.agent_id], ['aalhad', 'claude', 'aalhad/claude']);
  assert.deepEqual(names(claude), [`${bare}:mailbox`, `${uiAssigned}:active`, `${any}:routed`, `${onlyClaude}:routed`, `${tri}:triage`, `${market}:market`]);

  const codex = (await env.run(['inbox', '--json', '--agent', 'codex'])).json();
  assert.equal(codex.agent_id, 'aalhad/codex');
  // codex: its mailbox, the issue it holds and the UI-assigned one, routing for it; the market is closed (it holds 1 of 1)
  assert.deepEqual(names(codex), [`${pc}:mailbox`, `${heldByCodex}:active`, `${uiAssigned}:active`, `${any}:routed`, `${onlyCodex}:routed`]);
  assert.match((await env.run(['inbox', '--agent', 'codex'])).out, /Inbox for aalhad\/codex: 5 item/);

  // default agent is the primary
  assert.deepEqual(names((await env.run(['inbox', '--json'])).json()), names(claude));
  // -q counts the same items
  assert.equal((await env.run(['inbox', '-q', '--agent', 'codex'])).out.trim(), '5');
});

test('inbox: a single-agent member sees ping:<handle> and ping:<handle>/<agent>', async () => {
  const env = setup({ user: 'ben-gh' });
  env.fake.addIssue({ labels: ['ping:ben'] });
  env.fake.addIssue({ labels: ['ping:ben/claude'] });
  const j = (await env.run(['inbox', '--json'])).json();
  assert.equal(j.items.length, 2);
  assert.equal(j.agent_id, 'ben');
});

test('labels sync creates agent labels only for members with several agents', async () => {
  const env = setup();
  assert.equal((await env.run(['labels', 'sync'])).code, 0);
  const have = new Set(env.fake.labelDefs.keys());
  for (const x of ['to:aalhad', 'to:aalhad/claude', 'to:aalhad/codex', 'ping:aalhad/claude', 'ping:aalhad/codex', 'ping:ben', 'to:chen']) assert.ok(have.has(x), x);
  assert.ok(![...have].some((x) => x.includes('ben/') || x.includes('chen/')));
  assert.match((await env.run(['labels', '-h'])).out, /to:<handle>\/<agent>/);
  env.fake.addIssue({ labels: ['kind:board'] });
  assert.equal((await env.run(['doctor', '--as', 'aalhad/codex'])).code, 0);
});

/* ------------------------------------------------------------- watch */

test('watch: exports ISSUEMESH_AGENT and keeps one lock per agent', async () => {
  const env = setup();
  env.fake.addIssue({ labels: ['ping:aalhad/codex', 'ping:ben'] });
  const out = path.join(env.dir, 'watch-out.txt');
  const cmd = `printf '%s|%s|%s\\n' "$ISSUEMESH_HANDLE" "$ISSUEMESH_AGENT" "$ISSUEMESH_ACTOR" > '${out}'; ls '${path.join(env.dir, '.git', 'issuemesh')}' >> '${out}'`;
  let r = await env.run(['watch', '--once', '--exec', cmd, '--agent', 'codex']);
  assert.equal(r.code, 0, r.err);
  let txt = fs.readFileSync(out, 'utf8');
  assert.match(txt, /^aalhad\|codex\|agent\n/);
  assert.match(txt, /watch-aalhad_codex\.lock/);
  assert.ok(!fs.existsSync(path.join(env.dir, '.git', 'issuemesh', 'watch-aalhad_codex.lock')), 'released');

  fs.rmSync(out);
  r = await env.run(['watch', '--once', '--exec', cmd, '--as', 'ben']);
  assert.equal(r.code, 0, r.err);
  txt = fs.readFileSync(out, 'utf8');
  assert.match(txt, /^ben\|claude\|agent\n/);
  assert.match(txt, /(^|\n)watch\.lock\n/);
  assert.match((await env.run(['watch', '-h'])).out, /--agent <name>[\s\S]*one watch loop per\s+agent/);
});

/* ------------------------------------------------------ reply routing */

test('answer --re pings the asker: verified from= (agent id), else the GitHub author; never me', async () => {
  const env = setup();
  const n = env.fake.addIssue({});
  const askBen = env.fake.addComment(n, msg('ben', 'ask', { to: 'aalhad' }), { login: 'ben-gh' });
  let r = await env.run(['post', String(n), '--type', 'answer', '--re', String(askBen.id), '--body', 'pg', '--json']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json().pinged, 'ben');
  assert.deepEqual(env.fake.labelsOf(n), ['ping:ben']);
  assert.equal(markerOf(env, n, 1).re, String(askBen.id));

  // asker is an agent id of a multi-agent member
  const asBen = setup({ user: 'ben-gh' });
  const m2 = asBen.fake.addIssue({});
  const ask2 = asBen.fake.addComment(m2, msg('aalhad/codex', 'ask', { to: 'ben' }), { login: 'aalhad-gh' });
  r = await asBen.run(['post', String(m2), '--type', 'answer', '--re', String(ask2.id), '--body', 'use pg']);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(asBen.fake.labelsOf(m2), ['ping:aalhad/codex']);
  assert.match(r.out, /\(pinged aalhad\/codex\)/);

  // forged from=: the asker is whoever really wrote the comment (ben), not the claimed sender
  const f = env.fake.addIssue({});
  const forged = env.fake.addComment(f, msg('aalhad/claude', 'ask', { to: 'aalhad' }), { login: 'ben-gh' });
  await env.run(['post', String(f), '--type', 'answer', '--re', String(forged.id), '--body', 'x']);
  assert.deepEqual(env.fake.labelsOf(f), ['ping:ben']);

  // a plain human comment by a member: ping that member
  const h = env.fake.addIssue({});
  const human = env.fake.addComment(h, 'which database?', { login: 'ben-gh' });
  await env.run(['post', String(h), '--type', 'answer', '--re', String(human.id), '--body', 'pg']);
  assert.deepEqual(env.fake.labelsOf(h), ['ping:ben']);

  // answering my own comment, a non-member's, or the referee's: no ping
  const s = env.fake.addIssue({});
  const mine = env.fake.addComment(s, msg('aalhad/claude', 'note'), { login: 'aalhad-gh' });
  const stranger = env.fake.addComment(s, 'hi', { login: 'stranger' });
  const referee = env.fake.addComment(s, msg('referee', 'escalate'), { login: 'github-actions[bot]' });
  for (const c of [mine, stranger, referee]) {
    r = await env.run(['post', String(s), '--type', 'answer', '--re', String(c.id), '--body', 'ok']);
    assert.equal(r.code, 0, r.err);
  }
  assert.deepEqual(env.fake.labelsOf(s), []);
  // a member without an agent has no mailbox to ping
  const c1 = env.fake.addIssue({});
  const chen = env.fake.addComment(c1, 'q?', { login: 'chen-gh' });
  await env.run(['post', String(c1), '--type', 'answer', '--re', String(chen.id), '--body', 'a']);
  assert.deepEqual(env.fake.labelsOf(c1), []);
});

test('answer: unknown --re comment is a usage error and nothing is posted', async () => {
  const env = setup();
  const n = env.fake.addIssue({});
  const r = await env.run(['post', String(n), '--type', 'answer', '--re', '999', '--body', 'x']);
  assert.equal(r.code, 2);
  assert.match(r.err, /no such comment/);
  assert.equal(env.fake.commentsOf(n).length, 0);
});

test('answer without --re: exactly one open ask addressed to me is used', async () => {
  const env = setup();
  const n = env.fake.addIssue({});
  // none yet
  let r = await env.run(['post', String(n), '--type', 'answer', '--body', 'x']);
  assert.equal(r.code, 2);
  assert.match(r.err, /no open ask addressed to you/);

  const ask1 = env.fake.addComment(n, msg('ben', 'ask', { to: 'aalhad' }), { login: 'ben-gh' });
  env.fake.addComment(n, msg('ben', 'ask', { to: 'aalhad/codex' }), { login: 'ben-gh' }); // for codex, not claude
  env.fake.addComment(n, msg('ben', 'ask', { to: 'chen' }), { login: 'ben-gh' }); // for someone else
  env.fake.addComment(n, msg('aalhad', 'ask', { to: 'aalhad' }), { login: 'aalhad-gh' }); // my own ask
  env.fake.addComment(n, msg('ben', 'ask', { to: 'aalhad' }), { login: 'chen-gh' }); // forged
  r = await env.run(['post', String(n), '--type', 'answer', '--body', 'pg', '--agent', 'claude']);
  assert.equal(r.code, 0, r.err);
  const answer = env.fake.commentsOf(n).pop();
  assert.equal(P.parseMarker(answer.body).re, String(ask1.id));
  assert.ok(env.fake.labelsOf(n).includes('ping:ben'));

  // answered asks no longer count -> nothing open for claude again
  r = await env.run(['post', String(n), '--type', 'answer', '--body', 'again', '--agent', 'claude']);
  assert.equal(r.code, 2);

  // codex sees its own ask (ask to a handle reaches the primary only, to a specific agent that agent)
  r = await env.run(['post', String(n), '--type', 'answer', '--body', 'for codex', '--agent', 'codex']);
  assert.equal(r.code, 0, r.err);

  // two open asks: --re is required
  const m = env.fake.addIssue({});
  env.fake.addComment(m, msg('ben', 'ask', { to: 'aalhad' }), { login: 'ben-gh' });
  env.fake.addComment(m, msg('ben', 'ask', { to: 'aalhad' }), { login: 'ben-gh' });
  r = await env.run(['post', String(m), '--type', 'answer', '--body', 'x']);
  assert.equal(r.code, 2);
  assert.match(r.err, /2 open asks/);
  assert.equal((await env.run(['post', String(m), '--type', 'note', '--re', '1', '--body', 'x'])).code, 2);
});

test('help texts mention the new surface', async () => {
  const env = setup();
  const help = async (c) => (await env.run([c, '-h'])).out;
  assert.match(await help('claim'), /agent id/);
  assert.match(await help('route'), /handle\/agent/);
  assert.match(await help('ping'), /handle\/agent/);
  assert.match(await help('handoff'), /handle\/agent/);
  assert.match(await help('post'), /Optional when exactly one open ask/);
  assert.match(await help('ack'), /primary agent/);
  assert.match(await help('whoami'), /agent_id/);
  assert.match(await help('standup'), /each agent of a member posts its/);
  assert.match(await help('board'), /verified markers only/);
  assert.match(await help('inbox'), /--min-interval SEC/);
  assert.match(await help('inbox'), /--new-only/);
});
