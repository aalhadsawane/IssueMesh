'use strict';

const fs = require('fs');
const config = require('../config');
const { CliError, UsageError } = require('./errors');

const help = `mesh join - add yourself to .issuemesh/team.json

Usage: mesh join [--handle <handle>] [--agents name[:runtime],name[:runtime]...]

Run inside a clone of a team repo that already has IssueMesh set up. Looks up your
GitHub login (gh auth), then appends a member entry to .issuemesh/team.json.
Nothing is pushed: commit the change on a branch and open a PR (the output shows how).
Re-running is safe: if your login is already a member, nothing changes.

Options:
  --handle h      short name used in labels and messages (default: derived from your login)
  --agents list   your agents, comma separated, e.g. claude:claude-code,codex:codex
                  (default: claude:claude-code). The first one is your primary agent.
  --dry-run       print the entry, write nothing`;

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

async function run(args, ctx) {
  if (args._.length) throw new UsageError('usage: mesh join [--handle h] [--agents list]');
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

module.exports = { name: 'join', summary: 'add yourself to team.json (then PR it)', help, spec: { string: ['handle', 'agents'] }, run };
