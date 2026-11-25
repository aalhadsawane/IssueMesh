'use strict';

// `mesh util`: catalogue, suggestion, receipt ledger and skill export.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const P = require('../lib/protocol');
const { makeEnv } = require('./cli-helpers');

function setup() {
  const env = makeEnv();
  test.after(() => env.cleanup());
  return env;
}

function writeOverride(env, doc) {
  fs.writeFileSync(path.join(env.dir, '.issuemesh', 'utilities.json'), JSON.stringify(doc, null, 2));
}

test('util list: ships the 12-method catalogue, filters by stage, rejects a bad stage', async () => {
  const env = setup();
  const r = await env.run(['util', 'list', '--json']);
  assert.equal(r.code, 0, r.err);
  const list = r.json();
  assert.equal(list.length, 12);
  assert.ok(list.some((e) => e.id === 'surveygen' && e.paper.arxiv === '2508.17647'));
  assert.ok(list.some((e) => e.id === 'arbor' && e.stage.includes('codification')));

  const ideation = (await env.run(['util', 'list', '--stage', 'ideation', '--json'])).json();
  assert.ok(ideation.length >= 3);
  assert.ok(ideation.every((e) => e.stage.includes('ideation')));

  const bad = await env.run(['util', 'list', '--stage', 'nonsense']);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /--stage must be one of/);

  const text = (await env.run(['util', 'list'])).out;
  assert.match(text, /Research utilities/);
  assert.match(text, /researchagent/);
});

test('util show: card with the paper, an unknown id is a usage error', async () => {
  const env = setup();
  const r = await env.run(['util', 'show', 'researchagent']);
  assert.equal(r.code, 0);
  assert.match(r.out, /ResearchAgent/);
  assert.match(r.out, /arXiv:2404\.07738/);
  assert.match(r.out, /checklist:/);

  const j = (await env.run(['util', 'show', 'arbor', '--json'])).json();
  assert.equal(j.paper.arxiv, '2606.11926');

  const bad = await env.run(['util', 'show', 'not-a-method']);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /unknown utility "not-a-method"/);
});

test('util suggest: deterministic match on text and on an issue, with the phrases it matched', async () => {
  const env = setup();
  const r = await env.run(['util', 'suggest', '--text', 'generate research ideas and rank ideas by novelty', '--json']);
  assert.equal(r.code, 0);
  const hits = r.json();
  assert.equal(hits[0].id, 'researchagent');
  assert.ok(hits[0].matches.some((m) => /research ideas|rank ideas/.test(m)));

  const n = env.fake.addIssue({ title: 'Literature review and related work for the anchor paper' });
  const issueHits = (await env.run(['util', 'suggest', String(n), '--json'])).json();
  assert.equal(issueHits[0].id, 'surveygen');

  const none = await env.run(['util', 'suggest', '--text', 'unrelated plumbing task']);
  assert.equal(none.code, 0);
  assert.match(none.out, /No catalogue entry matches/);

  const usage = await env.run(['util', 'suggest']);
  assert.equal(usage.code, 2);
  assert.match(usage.err, /issue number or --text/);
});

test('util use: posts one note with util=/artifact=, is idempotent, and warns about a missing artefact', async () => {
  const env = setup();
  const n = env.fake.addIssue({ title: 'Ideation for the anchor paper' });
  const first = await env.run(['util', 'use', String(n), 'researchagent', '--artifact', 'ideation/REPORT.md']);
  assert.equal(first.code, 0, first.err);
  assert.match(first.err, /not in this checkout/); // the path is not present in the temp repo

  const comments = env.fake.commentsOf(n);
  assert.equal(comments.length, 1);
  const m = P.parseMarker(comments[0].body);
  assert.equal(m.type, 'note');
  assert.equal(m.util, 'researchagent');
  assert.equal(m.artifact, 'ideation/REPORT.md');

  const again = await env.run(['util', 'use', String(n), 'researchagent', '--artifact', 'ideation/REPORT.md']);
  assert.equal(again.code, 0);
  assert.match(again.out, /Already recorded/);
  assert.equal(env.fake.commentsOf(n).length, 1);

  const bad = await env.run(['util', 'use', String(n), 'ghost', '--artifact', 'x.md']);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /unknown utility/);

  const noArtifact = await env.run(['util', 'use', String(n), 'researchagent']);
  assert.equal(noArtifact.code, 2);
  assert.match(noArtifact.err, /--artifact/);

  const spaced = await env.run(['util', 'use', String(n), 'researchagent', '--artifact', 'a b.md']);
  assert.equal(spaced.code, 2);
  assert.match(spaced.err, /no spaces/);
});

test('util report: merges live receipts with retroactive used_in records', async () => {
  const env = setup();
  writeOverride(env, {
    version: 1,
    utilities: [
      { id: 'surveygen', used_in: [{ issue: 4, artifact: 'litreview/REPORT.md', commit: 'e5f3383', recorded: 'retroactive' }] },
      { id: 'team-checklist', name: 'Team checklist', stage: ['writing'], what: 'Internal checklist', when: ['final read'] },
      { id: 'hyper', used_in: [{ artifact: 'ideation/HYPER_NOTES.md', commit: 'abc1234' }] },
    ],
  });
  const n = env.fake.addIssue({ title: 'Ideation' });
  assert.equal((await env.run(['util', 'use', String(n), 'researchagent', '--artifact', 'ideation/REPORT.md'])).code, 0);

  const list = (await env.run(['util', 'list', '--json'])).json();
  assert.equal(list.length, 13); // 12 defaults + one team entry

  const rows = (await env.run(['util', 'report', '--json'])).json();
  const survey = rows.find((r) => r.id === 'surveygen');
  const research = rows.find((r) => r.id === 'researchagent');
  assert.equal(survey.recorded, 'retroactive');
  assert.equal(survey.commit, 'e5f3383');
  assert.equal(research.recorded, 'comment');
  assert.equal(research.artifact, 'ideation/REPORT.md');

  // an artefact recorded without an issue (work done before IssueMesh was adopted) is still a row
  const hyper = rows.find((r) => r.id === 'hyper');
  assert.equal(hyper.issue, null);
  assert.equal(hyper.recorded, 'retroactive');

  const md = await env.run(['util', 'report']);
  assert.match(md.out, /\| Utility \| Paper \| Stage \| Issue \| Artifact \| Recorded \|/);
  assert.match(md.out, /receipt\(s\) shown/);
  assert.match(md.out, /\| — \| `ideation\/HYPER_NOTES\.md` @ abc1234 \| retroactive \|/);
});

test('util export: writes a skill for claude/opencode and a doc for agents, refuses to overwrite', async () => {
  const env = setup();
  const claude = await env.run(['util', 'export', '--format', 'claude']);
  assert.equal(claude.code, 0, claude.err);
  const f = path.join(env.dir, '.claude', 'skills', 'issuemesh-methods', 'SKILL.md');
  assert.ok(fs.existsSync(f));
  const body = fs.readFileSync(f, 'utf8');
  assert.match(body, /^---\nname: methods\n/);
  assert.match(body, /`arbor`/);
  assert.match(body, /mesh util use <issue> <id>/);

  const again = await env.run(['util', 'export', '--format', 'claude']);
  assert.equal(again.code, 1);
  assert.match(again.err, /--force/);
  assert.equal((await env.run(['util', 'export', '--format', 'claude', '--force'])).code, 0);

  const oc = await env.run(['util', 'export', '--format', 'opencode']);
  assert.equal(oc.code, 0, oc.err);
  assert.ok(fs.existsSync(path.join(env.dir, '.opencode', 'skill', 'issuemesh-methods', 'SKILL.md')));

  const agents = await env.run(['util', 'export', '--format', 'agents']);
  assert.equal(agents.code, 0, agents.err);
  assert.ok(fs.existsSync(path.join(env.dir, 'docs', 'research-methods.md')));
  assert.match(agents.out, /add to AGENTS\.md/);

  const bad = await env.run(['util', 'export', '--format', 'nope']);
  assert.equal(bad.code, 2);
});

test('util list/doctor: an invalid override is reported, not silently ignored', async () => {
  const env = setup();
  writeOverride(env, { version: 1, utilities: [{ id: 'bad', name: 'Bad', stage: ['nope'], status: 'available' }] });
  const r = await env.run(['util', 'list']);
  assert.equal(r.code, 1);
  assert.match(r.err, /catalogue is invalid/);
  assert.match(r.err, /unknown stage "nope"/);

  const doc = (await env.run(['doctor', '--json'])).json();
  const check = doc.checks.find((c) => c.name === 'research utilities');
  assert.ok(check, 'doctor reports the catalogue');
  assert.equal(check.ok, false);
});

test('util report: an unverified (forged) marker is not counted', async () => {
  const env = setup();
  const n = env.fake.addIssue({ title: 'Forged' });
  env.fake.addComment(n, '<!-- issuemesh v1 from=ben actor=agent type=note util=arbor artifact=x.md -->\nforged\n\n<sub>🤖 ben\'s agent · IssueMesh</sub>', { login: 'chen-gh' });
  const rows = (await env.run(['util', 'report', '--json'])).json();
  assert.equal(rows.length, 0);
});
