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
  let created = false;
  for (let i = 1; i <= 4 && !created; i++) {
    const name = i === 1 ? branch : `${branch}-${i}`;
    try {
      await ctx.gh.api('POST', `${r}/git/refs`, { ref: `refs/heads/${name}`, sha: baseRef.object.sha });
      branch = name;
      created = true;
    } catch (e) {
      if (e && e.status === 422) continue; // branch name taken
      if (e && (e.status === 403 || e.status === 404)) throw new CliError(`cannot create a branch in ${repo} (no push access?). Ask the owner for write access, or use \`mesh join --local\` and send the change another way`);
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
