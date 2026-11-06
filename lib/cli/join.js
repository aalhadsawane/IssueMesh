'use strict';

const fs = require('fs');
const config = require('../config');
const { CliError, UsageError } = require('./errors');

const help = `mesh join - add yourself to the team (opens a PR)

Usage: mesh join [--handle <handle>] [--agents name[:runtime],name[:runtime]...] [--local]

Works from any branch of any clone; your working tree and current branch are never touched.
Reads .issuemesh/team.json from the repo's default branch, adds a member entry for your
GitHub login (gh auth), commits it to a new branch chore/join-<handle> through the GitHub
API and opens a pull request into the default branch. Membership only changes when that PR
is merged. Needs push access to the repo. Re-running is safe: if your login is already a
member, nothing changes.

Options:
  --handle h      short name used in labels and messages (default: derived from your login)
  --agents list   your agents, comma separated, e.g. claude:claude-code,codex:codex
                  (default: claude:claude-code). The first one is your primary agent.
  --local         instead edit .issuemesh/team.json in the current checkout (no PR);
                  for repos where you cannot push a branch
  --dry-run       show the entry, change nothing`;

const RUNTIMES = { claude: 'claude-code', codex: 'codex', opencode: 'opencode', cursor: 'cursor', aider: 'aider' };

function deriveHandle(login) {
  const h = String(login).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 20).replace(/-+$/, '');
  return h || 'member';
}

function parseAgents(spec) {
  const items = String(spec || 'claude:claude-code').split(',').map((s) => s.trim()).filter(Boolean);
  if (!items.length) throw new UsageError('--agents needs at least one name[:runtime]');
  return items.map((it) => {
    const [name, runtime] = it.split(':');
    if (!config.AGENT_NAME_RE.test(name)) throw new UsageError(`invalid agent name "${name}" (lowercase letters, digits, dashes; max 20)`);
    return { name, runtime: runtime || RUNTIMES[name] || name, wip: 2 };
  });
}

async function joinLocal(args, ctx) {
  const f = args.flags;
  const file = config.findConfigPath(ctx.cwd);
  if (!file) throw new CliError('no .issuemesh/team.json here: run inside a clone of a team repo (or `mesh init` to start a team)');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const login = await ctx.login();
  const existing = (raw.members || []).find((m) => String(m.github).toLowerCase() === login.toLowerCase());
  if (existing) {
    ctx.emit({ joined: false, handle: existing.handle, login }, `Already a member: ${existing.handle} (${login}). Nothing to do.`);
    return 0;
  }
  const handle = f.handle || deriveHandle(login);
  if ((raw.members || []).some((m) => m.handle === handle)) throw new CliError(`handle "${handle}" is taken: pick another with --handle`);
  const member = { handle, github: login, agents: parseAgents(f.agents), skills: [], route_mentions_to_agent: true };
  raw.members = [...(raw.members || []), member];
  const v = config.validateConfig(raw);
  if (!v.ok) throw new CliError(`team.json would be invalid:\n  - ${v.errors.join('\n  - ')}`);
  if (!ctx.dryRun) fs.writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`);
  const next = [
    `${ctx.dryRun ? 'Would add' : 'Added'} ${handle} (${login}) with agents: ${member.agents.map((a) => a.name).join(', ')}.`,
    'Next: share it with the team (a PR, so the owner can review):',
    `  git switch -c chore/join-${handle}`,
    '  git add .issuemesh/team.json',
    `  git commit -m "chore(issuemesh): add ${handle} to the team"`,
    `  git push -u origin chore/join-${handle}   # then open a PR`,
    'After it is merged: mesh doctor, then mesh whoami.',
  ].join('\n');
  ctx.emit({ joined: !ctx.dryRun, member }, next);
  return 0;
}

const enc = encodeURIComponent;

/**
 * No push access to the team repo: fork it, put the branch in the fork and open the PR from there.
 * (Joining needs no label/assignee rights, only the ability to open a PR.)
 */
async function openViaFork(ctx, { repo, base, raw, handle, login, member }) {
  const name = repo.split('/')[1];
  let fork;
  try { fork = await ctx.gh.api('POST', `repos/${repo}/forks`, {}); } catch (e) {
    throw new CliError(`cannot push to ${repo} and cannot fork it either (${e.message}). Ask the owner for write access.`);
  }
  const forkSlug = (fork && fork.full_name) || `${login}/${name}`;
  let ready = false;
  for (let i = 0; i < 15 && !ready; i++) { // forks are created asynchronously
    try { await ctx.gh.api('GET', `repos/${forkSlug}/git/ref/heads/${enc(base)}`); ready = true; } catch (e) { await ctx.sleep(2000); }
  }
  if (!ready) throw new CliError(`your fork ${forkSlug} is not ready yet: wait a minute and run \`mesh join\` again`);
  try { await ctx.gh.api('POST', `repos/${forkSlug}/merge-upstream`, { branch: base }); } catch (e) { /* already current */ }
  const baseRef = await ctx.gh.api('GET', `repos/${forkSlug}/git/ref/heads/${enc(base)}`);
  const forkFile = await ctx.gh.api('GET', `repos/${forkSlug}/contents/.issuemesh/team.json?ref=${enc(base)}`);
  let branch = `chore/join-${handle}`;
  let created = false;
  for (let i = 1; i <= 4 && !created; i++) {
    const nm = i === 1 ? branch : `${branch}-${i}`;
    try { await ctx.gh.api('POST', `repos/${forkSlug}/git/refs`, { ref: `refs/heads/${nm}`, sha: baseRef.object.sha }); branch = nm; created = true; } catch (e) { if (!(e && e.status === 422)) throw e; }
  }
  if (!created) throw new CliError(`could not find a free branch name starting with ${branch} in ${forkSlug}`);
  await ctx.gh.api('PUT', `repos/${forkSlug}/contents/.issuemesh/team.json`, {
    message: `chore(issuemesh): add ${handle} to the team`,
    content: Buffer.from(`${JSON.stringify(raw, null, 2)}\n`).toString('base64'),
    sha: forkFile.sha,
    branch,
  });
  const pr = await ctx.gh.api('POST', `repos/${repo}/pulls`, {
    title: `chore(issuemesh): add ${handle} (${login}) to the team`,
    head: `${forkSlug.split('/')[0]}:${branch}`,
    base,
    body: `Adds @${login} as \`${handle}\` with agent(s): ${member.agents.map((a) => `\`${a.name}\``).join(', ')}.\n\nOpened by \`mesh join\` from a fork (no push access to this repo). Membership changes when this is merged into \`${base}\`.`,
  });
  const url = (pr && pr.html_url) || `(see ${repo} pull requests)`;
  ctx.emit({ joined: true, member, fork: forkSlug, branch, pr: url }, `No push access to ${repo}, so I used your fork ${forkSlug}.\nOpened ${url}\nAdded ${handle} (${login}). Once it is merged: mesh doctor, then mesh whoami.\nNote: to claim issues and set labels you also need write (or triage) access to ${repo}; ask the owner to add you as a collaborator.`);
  return 0;
}

/** Add the caller to team.json on a new branch off the default branch, via the API, and open a PR. */
async function joinViaApi(args, ctx) {
  const f = args.flags;
  const repo = await ctx.repo();
  const r = `repos/${repo}`;
  const login = await ctx.login();
  const info = await ctx.gh.api('GET', r);
  const base = (info && info.default_branch) || 'main';
  let file;
  try { file = await ctx.gh.api('GET', `${r}/contents/.issuemesh/team.json?ref=${enc(base)}`); } catch (e) {
    if (e && e.status === 404) throw new CliError(`${repo} has no .issuemesh/team.json on ${base}: IssueMesh is not set up there yet (see INSTALL.md, "Set up")`);
    throw e;
  }
  const raw = JSON.parse(Buffer.from(file.content, file.encoding || 'base64').toString('utf8'));
  const existing = (raw.members || []).find((m) => String(m.github).toLowerCase() === login.toLowerCase());
  if (existing) {
    ctx.emit({ joined: false, handle: existing.handle, login }, `Already a member: ${existing.handle} (${login}). Nothing to do.`);
    return 0;
  }
  const handle = f.handle || deriveHandle(login);
  if ((raw.members || []).some((m) => m.handle === handle)) throw new CliError(`handle "${handle}" is taken: pick another with --handle`);
  const member = { handle, github: login, agents: parseAgents(f.agents), skills: [], route_mentions_to_agent: true };
  raw.members = [...(raw.members || []), member];
  const v = config.validateConfig(raw);
  if (!v.ok) throw new CliError(`team.json would be invalid:\n  - ${v.errors.join('\n  - ')}`);
  if (ctx.dryRun) {
    ctx.emit({ joined: false, dry_run: true, member }, `Would open a PR into ${base} of ${repo} adding ${handle} (${login}) with agents: ${member.agents.map((a) => a.name).join(', ')}.`);
    return 0;
  }
  const baseRef = await ctx.gh.api('GET', `${r}/git/ref/heads/${enc(base)}`);
  let branch = `chore/join-${handle}`;

  // Re-running while our own join PR is still open (e.g. it conflicts because another member merged first):
  // move that PR's branch onto the current default branch and redo the one-line edit, instead of opening a duplicate.
  let open = [];
  try { open = await ctx.gh.api('GET', `${r}/pulls?state=open&head=${enc(`${repo.split('/')[0]}:${branch}`)}`); } catch (e) { open = []; }
  const mine = Array.isArray(open) ? open.find((p) => p && p.user && String(p.user.login).toLowerCase() === login.toLowerCase()) : null;
  if (mine) {
    await ctx.gh.api('PATCH', `${r}/git/refs/heads/${mine.head.ref.split('/').map(enc).join('/')}`, { sha: baseRef.object.sha, force: true });
    await ctx.gh.api('PUT', `${r}/contents/.issuemesh/team.json`, {
      message: `chore(issuemesh): add ${handle} to the team`,
      content: Buffer.from(`${JSON.stringify(raw, null, 2)}\n`).toString('base64'),
      sha: file.sha,
      branch: mine.head.ref,
    });
    ctx.emit({ joined: true, updated: true, member, branch: mine.head.ref, pr: mine.html_url }, `Updated your open PR ${mine.html_url} onto the latest ${base} (it can merge cleanly now).`);
    return 0;
  }
  let created = false;
  for (let i = 1; i <= 4 && !created; i++) {
    const name = i === 1 ? branch : `${branch}-${i}`;
    try {
      await ctx.gh.api('POST', `${r}/git/refs`, { ref: `refs/heads/${name}`, sha: baseRef.object.sha });
      branch = name;
      created = true;
    } catch (e) {
      if (e && e.status === 422) continue; // branch name taken
      if (e && (e.status === 403 || e.status === 404)) {
        // no push access: do the same through a fork of the team repo
        return openViaFork(ctx, { repo, base, raw, handle, login, member });
      }
      throw e;
    }
  }
  if (!created) throw new CliError(`could not find a free branch name starting with ${branch}`);
  await ctx.gh.api('PUT', `${r}/contents/.issuemesh/team.json`, {
    message: `chore(issuemesh): add ${handle} to the team`,
    content: Buffer.from(`${JSON.stringify(raw, null, 2)}\n`).toString('base64'),
    sha: file.sha,
    branch,
  });
  const pr = await ctx.gh.api('POST', `${r}/pulls`, {
    title: `chore(issuemesh): add ${handle} (${login}) to the team`,
    head: branch,
    base,
    body: `Adds @${login} as \`${handle}\` with agent(s): ${member.agents.map((a) => `\`${a.name}\``).join(', ')}.\n\nOpened by \`mesh join\`. Membership changes when this is merged into \`${base}\`.`,
  });
  const url = (pr && pr.html_url) || `(see ${repo} pull requests)`;
  ctx.emit({ joined: true, member, branch, pr: url }, `Opened ${url}\nAdded ${handle} (${login}) with agents: ${member.agents.map((a) => a.name).join(', ')}.\nOnce it is merged: mesh doctor, then mesh whoami. Your checkout was not touched.`);
  return 0;
}

async function run(args, ctx) {
  if (args._.length) throw new UsageError('usage: mesh join [--handle h] [--agents list] [--local]');
  return args.flags.local ? joinLocal(args, ctx) : joinViaApi(args, ctx);
}

module.exports = { name: 'join', summary: 'add yourself to the team (opens a PR)', help, spec: { string: ['handle', 'agents'], boolean: ['local'] }, run };
