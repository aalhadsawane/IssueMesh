'use strict';

const fs = require('fs');
const path = require('path');
const P = require('../protocol');
const { memberByHandle } = require('../config');
const { CliError, UsageError, PreconditionError } = require('./errors');

const enc = encodeURIComponent;

function parseNumber(s, what = 'issue number') {
  const m = /^#?(\d+)$/.exec(String(s === undefined || s === null ? '' : s));
  if (!m || Number(m[1]) < 1) throw new UsageError(`expected ${what}, got ${JSON.stringify(s)}`);
  return Number(m[1]);
}

function needPositional(args, min, max, usage) {
  if (args._.length < min || args._.length > max) throw new UsageError(`usage: ${usage}`);
}

async function rp(ctx) { return `repos/${await ctx.repo()}`; }

async function getIssue(ctx, n) { return ctx.gh.api('GET', `${await rp(ctx)}/issues/${n}`); }

async function getComments(ctx, n, { since } = {}) {
  const q = since ? `?since=${enc(since)}` : '';
  return ctx.gh.paginate(`${await rp(ctx)}/issues/${n}/comments${q}`);
}

function postComment(ctx, n, body) {
  return rp(ctx).then((r) => ctx.gh.api('POST', `${r}/issues/${n}/comments`, { body }));
}

function editComment(ctx, id, body) {
  return rp(ctx).then((r) => ctx.gh.api('PATCH', `${r}/issues/comments/${id}`, { body }));
}

function labelNames(issue) {
  return ((issue && issue.labels) || []).map((l) => (typeof l === 'string' ? l : l && l.name)).filter(Boolean);
}

function assigneeLogins(issue) {
  return ((issue && issue.assignees) || []).map((a) => (typeof a === 'string' ? a : a && a.login)).filter(Boolean);
}

/**
 * Pure label transformation.
 * ops: { set: {status:'ready', to:'ben', priority:null}, add: [names], remove: [names] }
 */
function applyLabelOps(current, ops = {}) {
  let next = [...current];
  for (const [ns, v] of Object.entries(ops.set || {})) next = P.setNamespace(next, ns, v);
  for (const r of ops.remove || []) next = next.filter((x) => x.toLowerCase() !== r.toLowerCase());
  for (const a of ops.add || []) if (!next.some((x) => x.toLowerCase() === a.toLowerCase())) next.push(a);
  return next;
}

/** Apply the diff between current and next label sets. */
async function updateLabels(ctx, n, current, next) {
  const cur = new Set(current.map((x) => x.toLowerCase()));
  const nxt = new Set(next.map((x) => x.toLowerCase()));
  const add = next.filter((x) => !cur.has(x.toLowerCase()));
  const remove = current.filter((x) => !nxt.has(x.toLowerCase()));
  const r = await rp(ctx);
  if (add.length) await ctx.gh.api('POST', `${r}/issues/${n}/labels`, { labels: add });
  for (const name of remove) {
    try {
      await ctx.gh.api('DELETE', `${r}/issues/${n}/labels/${enc(name)}`);
    } catch (e) {
      if (!(e && e.status === 404)) throw e;
    }
  }
  return next;
}

async function changeLabels(ctx, n, ops, issue) {
  const iss = issue || (await getIssue(ctx, n));
  const cur = labelNames(iss);
  return updateLabels(ctx, n, cur, applyLabelOps(cur, ops));
}

async function addAssignees(ctx, n, logins) {
  return ctx.gh.api('POST', `${await rp(ctx)}/issues/${n}/assignees`, { assignees: logins });
}
async function removeAssignees(ctx, n, logins) {
  return ctx.gh.api('DELETE', `${await rp(ctx)}/issues/${n}/assignees`, { assignees: logins });
}

function requireMember(ctx, config, handle) {
  const m = memberByHandle(config, handle);
  if (!m) throw new UsageError(`unknown member handle "${handle}" (see .issuemesh/team.json)`);
  return m;
}

/** Compose a protocol message authored by the current identity. */
async function compose(ctx, { type, body = '', ...extra }) {
  const me = await ctx.me();
  return P.composeMessage({ from: me.handle, actor: ctx.actor, type, body, ...extra });
}

/** Highest-id claim comment (type=claim) written for `handle`. */
function findClaimComment(comments, handle) {
  let best = null;
  for (const c of comments) {
    const m = P.parseMarker(c.body);
    if (m && m.type === 'claim' && m.from === handle && (!best || c.id > best.id)) best = c;
  }
  return best;
}

function claimOpts(ctx, config) {
  return {
    now: ctx.now(),
    humanLeaseMinutes: config.policy.lease_minutes.human,
    resolveHandle: (login) => {
      const l = String(login).toLowerCase();
      const m = config.members.find((x) => String(x.github).toLowerCase() === l);
      return m ? m.handle : login;
    },
  };
}

function sanitizeValue(s) {
  return String(s).trim().replace(/-->/g, '->').replace(/\s+/g, '-') || 'unspecified';
}

/** Split a comment into marker line, content and signature. */
function splitBody(body) {
  const lines = String(body).split(/\r?\n/);
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  const marker = lines[i];
  let rest = lines.slice(i + 1);
  while (rest.length && rest[rest.length - 1].trim() === '') rest.pop();
  let sig = null;
  if (rest.length && /^<sub>.*IssueMesh<\/sub>$/.test(rest[rest.length - 1].trim())) {
    sig = rest.pop();
    while (rest.length && rest[rest.length - 1].trim() === '') rest.pop();
  }
  return { marker, content: rest.join('\n'), signature: sig };
}

function joinBody({ marker, content, signature }, handle) {
  return `${marker}\n${content}\n\n${signature || P.signature(handle)}`;
}

/* ------------------------------------------------------------ git / state */

function findGitDir(cwd) {
  let dir = path.resolve(cwd);
  for (;;) {
    const g = path.join(dir, '.git');
    if (fs.existsSync(g)) {
      const st = fs.statSync(g);
      if (st.isDirectory()) return g;
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(g, 'utf8'));
      if (m) return path.resolve(dir, m[1].trim());
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function repoRoot(cwd) {
  let dir = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(cwd);
    dir = parent;
  }
}

function stateDir(ctx) {
  const g = findGitDir(ctx.cwd);
  if (!g) throw new CliError('not inside a git repository (needed for .git/issuemesh state)');
  return path.join(g, 'issuemesh');
}

function readState(ctx) {
  try { return JSON.parse(fs.readFileSync(path.join(stateDir(ctx), 'state.json'), 'utf8')); } catch (e) {
    if (e instanceof CliError) throw e;
    return {};
  }
}

function writeState(ctx, state) {
  if (ctx.dryRun) return;
  const dir = stateDir(ctx);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state, null, 2) + '\n');
}

/* ------------------------------------------------------------------ board */

async function resolveBoard(ctx) {
  const cfg = await ctx.config();
  const r = await rp(ctx);
  if (cfg.board_issue) {
    try {
      const issue = await ctx.gh.api('GET', `${r}/issues/${cfg.board_issue}`);
      if (issue && issue.state === 'open') return issue;
    } catch (e) {
      if (!(e && e.status === 404)) throw e;
    }
  }
  const list = await ctx.gh.api('GET', `${r}/issues?labels=${enc('kind:board')}&state=open&sort=created&direction=desc&per_page=10`);
  const board = (Array.isArray(list) ? list : []).find((i) => !i.pull_request);
  if (!board) throw new CliError('no open Board found (no open board_issue and no open kind:board issue). Run `mesh init --board`.');
  return board;
}

/** Read --body / --body-file. */
function readBody(ctx, flags, { required = true } = {}) {
  if (flags.body !== undefined && flags['body-file'] !== undefined) throw new UsageError('use either --body or --body-file, not both');
  let body;
  if (flags.body !== undefined) body = flags.body;
  else if (flags['body-file'] !== undefined) {
    body = flags['body-file'] === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(path.resolve(ctx.cwd, flags['body-file']), 'utf8');
  }
  if (required && (body === undefined || String(body).trim() === '')) throw new UsageError('missing --body "markdown" (or --body-file <file>)');
  return body === undefined ? '' : String(body);
}

function splitList(v) {
  return (Array.isArray(v) ? v : [v]).filter((x) => x !== undefined).flatMap((x) => String(x).split(',')).map((s) => s.trim().replace(/^@/, '')).filter(Boolean);
}

function writeFileSafe(ctx, file, content) {
  if (ctx.dryRun) { ctx.err(`[dry-run] write ${file}`); return; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

module.exports = {
  CliError, UsageError, PreconditionError,
  enc, parseNumber, needPositional, rp, getIssue, getComments, postComment, editComment,
  labelNames, assigneeLogins, applyLabelOps, updateLabels, changeLabels, addAssignees, removeAssignees,
  requireMember, compose, findClaimComment, claimOpts, sanitizeValue, splitBody, joinBody,
  findGitDir, repoRoot, stateDir, readState, writeState, resolveBoard, readBody, splitList, writeFileSafe,
};
