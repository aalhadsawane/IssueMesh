'use strict';

// Shared test support for the mesh CLI: an in-memory GitHub and a harness.
// (No tests here; node --test just loads it.)

const fs = require('fs');
const os = require('os');
const path = require('path');
const { main } = require('../lib/cli/main');
const { createGh } = require('../lib/gh');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; this.name = 'GhError'; }
}

class FakeGitHub {
  constructor({ repo = 'o/r', user = 'aalhad-gh', clock }) {
    this.repo = repo;
    this.user = user;
    this.clock = clock;
    this.issues = new Map();
    this.comments = [];
    this.labelDefs = new Map();
    this.reactions = [];
    this.graphqlCalls = [];
    this.log = [];
    this.nextComment = 100;
    this.nextIssue = 1;
    this.version = 1; // bumped by every mutation; its ETag is `W/"v<version>"`
    this.conditionalLog = [];
    this.conditionalFails = false;
    this.transport = this.transport.bind(this);
    this.conditional = this.conditional.bind(this);
  }

  /** Bump the ETag after mutating state directly (tests poking `issues`). */
  touch() { this.version += 1; }

  /** Simulated `gh api -i -H 'If-None-Match: ...'` (200 with an ETag, or 304 when unchanged). */
  async conditional(rawPath, etag) {
    this.conditionalLog.push({ path: rawPath, etag });
    if (this.conditionalFails) throw new HttpError(500, 'conditional requests unavailable');
    const cur = `W/"v${this.version}"`;
    if (etag === cur) return { status: 304, etag: cur, data: null };
    return { status: 200, etag: cur, data: [] };
  }

  iso() { return this.clock().toISOString().replace(/\.\d{3}Z$/, 'Z'); }

  addIssue({ title = 'Issue', labels = [], assignees = [], state = 'open', pr = false, body = '', createdAt } = {}) {
    const number = this.nextIssue++;
    this.version += 1;
    const t = createdAt || this.iso();
    this.issues.set(number, {
      number, title, body, state, labels: [...labels], assignees: [...assignees], pr,
      created_at: t, updated_at: t, node_id: `NODE_${number}`, user: { login: 'someone' },
    });
    return number;
  }

  addComment(n, body, { login = 'someone', id, createdAt } = {}) {
    const t = createdAt || this.iso();
    this.version += 1;
    const c = { id: id || this.nextComment++, issue_number: n, body, user: { login }, created_at: t, updated_at: t };
    if (id && id >= this.nextComment) this.nextComment = id + 1;
    this.comments.push(c);
    return c;
  }

  commentsOf(n) { return this.comments.filter((c) => c.issue_number === n).sort((a, b) => a.id - b.id); }
  labelsOf(n) { return [...this.issues.get(n).labels]; }
  assigneesOf(n) { return [...this.issues.get(n).assignees]; }

  view(i) {
    const o = {
      number: i.number, title: i.title, body: i.body, state: i.state, node_id: i.node_id, user: i.user,
      labels: i.labels.map((name) => ({ name })), assignees: i.assignees.map((login) => ({ login })),
      created_at: i.created_at, updated_at: i.updated_at, html_url: `https://github.com/${this.repo}/issues/${i.number}`,
    };
    if (i.pr) o.pull_request = { url: 'x' };
    return o;
  }

  async transport(method, rawPath, body) {
    this.log.push({ method, path: rawPath, body });
    if (method !== 'GET') this.version += 1;
    const u = new URL(rawPath, 'https://api.test/');
    const p = u.pathname.replace(/^\//, '');
    const q = u.searchParams;
    const paged = (arr) => {
      const per = Number(q.get('per_page') || 30);
      const page = Number(q.get('page') || 1);
      return arr.slice((page - 1) * per, page * per);
    };
    let m;
    if (method === 'GET' && p === 'user') return { login: this.user };
    if (p === 'graphql') {
      this.graphqlCalls.push(body);
      return { data: { pinIssue: { issue: { id: body.variables.id } } } };
    }
    const R = `repos/${this.repo}`;
    if (!p.startsWith(R)) throw new HttpError(404, `bad repo path ${p}`);
    const rest = p.slice(R.length);

    if (method === 'GET' && rest === '/issues') {
      let list = [...this.issues.values()];
      const state = q.get('state') || 'open';
      if (state !== 'all') list = list.filter((i) => i.state === state);
      if (q.get('labels')) { const need = q.get('labels').split(','); list = list.filter((i) => need.every((l) => i.labels.includes(l))); }
      if (q.get('assignee')) list = list.filter((i) => i.assignees.map((a) => a.toLowerCase()).includes(q.get('assignee').toLowerCase()));
      list.sort((a, b) => (q.get('direction') === 'asc' ? a.number - b.number : b.number - a.number));
      return paged(list).map((i) => this.view(i));
    }
    if (method === 'POST' && rest === '/issues') {
      const n = this.addIssue({ title: body.title, body: body.body, labels: body.labels || [] });
      return this.view(this.issues.get(n));
    }
    if ((m = /^\/issues\/(\d+)$/.exec(rest))) {
      const i = this.issues.get(Number(m[1]));
      if (!i) throw new HttpError(404, 'Not Found');
      if (method === 'GET') return this.view(i);
      if (method === 'PATCH') { Object.assign(i, body); return this.view(i); }
    }
    if ((m = /^\/issues\/(\d+)\/comments$/.exec(rest))) {
      const n = Number(m[1]);
      if (!this.issues.has(n)) throw new HttpError(404, 'Not Found');
      if (method === 'GET') {
        let list = this.commentsOf(n);
        if (q.get('since')) list = list.filter((c) => Date.parse(c.updated_at) >= Date.parse(q.get('since')));
        return paged(list).map((c) => ({ ...c }));
      }
      if (method === 'POST') return { ...this.addComment(n, body.body, { login: this.user }), html_url: `https://github.com/${this.repo}/issues/${n}#c` };
    }
    if (method === 'PATCH' && (m = /^\/issues\/comments\/(\d+)$/.exec(rest))) {
      const c = this.comments.find((x) => x.id === Number(m[1]));
      if (!c) throw new HttpError(404, 'Not Found');
      c.body = body.body;
      c.updated_at = this.iso();
      return { ...c };
    }
    if ((m = /^\/issues\/(\d+)\/labels(?:\/(.+))?$/.exec(rest))) {
      const i = this.issues.get(Number(m[1]));
      if (!i) throw new HttpError(404, 'Not Found');
      if (method === 'POST') {
        for (const l of body.labels) if (!i.labels.includes(l)) i.labels.push(l);
        return i.labels.map((name) => ({ name }));
      }
      if (method === 'DELETE') {
        const name = decodeURIComponent(m[2]);
        if (!i.labels.includes(name)) throw new HttpError(404, 'Label does not exist');
        i.labels = i.labels.filter((l) => l !== name);
        return i.labels.map((n2) => ({ name: n2 }));
      }
    }
    if ((m = /^\/issues\/(\d+)\/assignees$/.exec(rest))) {
      const i = this.issues.get(Number(m[1]));
      if (method === 'POST') { for (const a of body.assignees) if (!i.assignees.includes(a)) i.assignees.push(a); return this.view(i); }
      if (method === 'DELETE') { i.assignees = i.assignees.filter((a) => !body.assignees.map((x) => x.toLowerCase()).includes(a.toLowerCase())); return this.view(i); }
    }
    if (method === 'POST' && (m = /^\/issues\/(\d+)\/reactions$/.exec(rest))) {
      this.reactions.push({ issue: Number(m[1]), content: body.content });
      return { id: this.reactions.length };
    }
    if (method === 'GET' && rest === '/labels') return paged([...this.labelDefs.values()]);
    if (method === 'POST' && rest === '/labels') { this.labelDefs.set(body.name, { ...body }); return body; }
    if (method === 'PATCH' && (m = /^\/labels\/(.+)$/.exec(rest))) {
      const name = decodeURIComponent(m[1]);
      Object.assign(this.labelDefs.get(name), body);
      return this.labelDefs.get(name);
    }
    throw new HttpError(404, `fake: unhandled ${method} ${rawPath}`);
  }
}

const T0 = Date.parse('2026-11-06T12:00:00Z');

const TEAM = {
  version: 1,
  members: [
    { handle: 'aalhad', github: 'aalhad-gh', agent: { enabled: true, wip: 2 } },
    { handle: 'ben', github: 'ben-gh', agent: { enabled: true, wip: 2 } },
    { handle: 'chen', github: 'chen-gh', agent: { enabled: false } },
  ],
  triage: { rotation: ['aalhad', 'ben'], period: 'daily' },
  board_issue: null,
};

/** Create a temp repo dir (with .git and team.json) and a fake GitHub. */
function makeEnv({ team = TEAM, user = 'aalhad-gh', writeTeam = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-test-'));
  fs.mkdirSync(path.join(dir, '.git'));
  if (writeTeam) {
    fs.mkdirSync(path.join(dir, '.issuemesh'));
    fs.writeFileSync(path.join(dir, '.issuemesh', 'team.json'), JSON.stringify(team, null, 2));
  }
  const clock = { t: T0 };
  const now = () => new Date(clock.t);
  const fake = new FakeGitHub({ user, clock: now });
  const sleeps = [];
  const env = {
    dir, fake, clock, now, sleeps,
    onSleep: null,
    async run(argv, over = {}) {
      let out = '';
      let err = '';
      const gh = createGh(fake.transport, { dryRun: argv.includes('--dry-run'), log: (s) => { err += `${s}\n`; }, conditional: fake.conditional });
      env.gh = gh;
      const code = await main(argv, {
        gh,
        cwd: dir,
        now,
        repo: 'o/r',
        rand: () => 0.5,
        isTTY: false,
        sleep: async (ms) => { sleeps.push(ms); if (env.onSleep) await env.onSleep(ms); },
        stdout: (s) => { out += s; },
        stderr: (s) => { err += s; },
        env: {},
        ...over,
      });
      return { code, out, err, json: () => JSON.parse(out) };
    },
    cleanup() { fs.rmSync(dir, { recursive: true, force: true }); },
  };
  return env;
}

const claimBody = (handle, lease, extra = '') => `<!-- issuemesh v1 from=${handle} actor=agent type=claim lease=${lease}${extra} -->\n**Claimed** by ${handle}'s agent.\n\n<sub>🤖 ${handle}'s agent · IssueMesh</sub>`;

module.exports = { FakeGitHub, makeEnv, T0, TEAM, claimBody, HttpError };
