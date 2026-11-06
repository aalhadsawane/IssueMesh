'use strict';

const { parseArgs, GLOBAL_SPEC } = require('./args');
const { CliError, UsageError } = require('./errors');
const { createGh, createTransport } = require('../gh');
const config = require('../config');

const COMMANDS = [
  'init', 'labels', 'doctor', 'whoami', 'inbox', 'claim', 'status', 'heartbeat', 'release', 'handoff',
  'post', 'ping', 'ack', 'route', 'label', 'escalate', 'board', 'standup', 'sweep', 'watch',
].map((n) => require(`./${n}`));

const byName = new Map(COMMANDS.map((c) => [c.name, c]));

/** Commands that change issues, labels or comments (everything but the read-only ones). */
const MUTATING = new Set(['init', 'labels', 'claim', 'status', 'heartbeat', 'release', 'handoff', 'post', 'ping', 'ack', 'route', 'label', 'escalate', 'board', 'standup', 'sweep']);
const { invalidateCache } = require('./inbox');

const MAIN_HELP = `mesh - IssueMesh CLI: coordinate coding agents and humans through GitHub issues

Usage: mesh [global flags] <command> [args]

Commands:
${COMMANDS.map((c) => `  ${c.name.padEnd(10)} ${c.summary}`).join('\n')}

Global flags:
  --repo owner/name   target repository (default: gh repo view)
  --json              machine-readable output
  --as <id>           act as this member, or as one agent: <handle> or <handle>/<agent>
                      (default: the member whose login matches gh auth)
  --agent <name>      act as this agent of the member (default: its primary agent;
                      env ISSUEMESH_AGENT)
  --actor agent|human marker actor for messages (default agent; env ISSUEMESH_ACTOR)
  --dry-run           print the gh calls that would mutate, change nothing
  -h, --help          help (mesh <command> -h for a command)

Exit codes:
  0 ok   1 error   2 usage   3 lost claim race / precondition failed
  10 inbox empty or nothing new (only with \`inbox -q\`)

Docs: https://github.com/aalhadsawane/issuemesh`;

function memo(fn) {
  let p;
  return () => (p || (p = Promise.resolve().then(fn)));
}

/**
 * Build the execution context. `o` holds test/embedding overrides:
 * gh, cwd, now, sleep, rand, stdout, stderr, env, repo, login, isTTY, templatesDir.
 */
function buildContext(flags, o = {}) {
  const env = o.env || process.env;
  const write = (stream, fallback) => o[stream] || ((s) => fallback.write(s));
  const stdout = write('stdout', process.stdout);
  const stderr = write('stderr', process.stderr);
  const actor = flags.actor || env.ISSUEMESH_ACTOR || 'agent';
  if (actor !== 'agent' && actor !== 'human') throw new UsageError(`--actor must be agent or human (got "${actor}")`);
  const dryRun = !!flags['dry-run'];
  const cwd = o.cwd || process.cwd();

  const ctx = {
    opts: flags,
    json: !!flags.json,
    dryRun,
    actor,
    cwd,
    env,
    isTTY: o.isTTY !== undefined ? o.isTTY : !!(process.stdin.isTTY && process.stdout.isTTY),
    templatesDir: o.templatesDir,
    now: o.now || (() => new Date()),
    sleep: o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms))),
    rand: o.rand || Math.random,
    out: (s) => stdout(`${s}\n`),
    err: (s) => stderr(`${s}\n`),
    emit(data, human) {
      ctx.out(ctx.json ? JSON.stringify(data, null, 2) : human);
    },
  };
  ctx.gh = o.gh || createGh(createTransport(), { dryRun, log: ctx.err });

  let cfgOverride = null;
  const loadCfg = memo(() => (cfgOverride ? config.normalizeConfig(cfgOverride) : config.loadConfig(cwd)));
  ctx.config = () => (cfgOverride ? Promise.resolve(config.normalizeConfig(cfgOverride)) : loadCfg());
  ctx.setConfig = (raw) => { cfgOverride = raw; };

  ctx.repo = memo(async () => flags.repo || o.repo || env.GITHUB_REPOSITORY_OVERRIDE || ctx.repoHint || ctx.gh.repoSlug());
  ctx.login = memo(async () => o.login || (await ctx.gh.api('GET', 'user')).login);
  ctx.repoHint = null; // a cached slug (inbox fast path) used before asking gh
  ctx.resolveMe = async (loginOverride) => {
    const cfg = await ctx.config();
    let member;
    let asAgent = null;
    if (flags.as) {
      const p = config.parseAgentId(flags.as);
      member = p && config.memberByHandle(cfg, p.handle);
      if (!member) throw new UsageError(`--as ${flags.as}: no such handle in team.json`);
      asAgent = p.agent;
    } else {
      const login = loginOverride || (await ctx.login());
      member = config.memberByLogin(cfg, login);
      if (!member) throw new CliError(`GitHub user "${login}" is not a member in .issuemesh/team.json (use --as <handle>)`);
    }
    const agents = config.agentsOf(member);
    // precedence: --as <handle>/<agent> > --agent > ISSUEMESH_AGENT > primary. Only the two flags can conflict;
    // the environment is a default, so an explicit --as <id> overrides it.
    if (flags.agent && asAgent && flags.agent !== asAgent) throw new UsageError(`--agent ${flags.agent} conflicts with --as ${flags.as}`);
    let want = asAgent || flags.agent || env.ISSUEMESH_AGENT || null;
    // the environment names the default identity's agent; for `--as <other member>` it is not applicable
    if (want && want === env.ISSUEMESH_AGENT && !asAgent && !flags.agent && flags.as && !agents.some((a) => a.name === want)) want = null;
    let agent = agents[0] || null;
    if (want) {
      agent = agents.find((a) => a.name === want);
      if (!agent) {
        const known = agents.map((a) => a.name).join(', ') || 'none';
        throw new UsageError(`${member.handle} has no agent "${want}" in team.json (agents: ${known})`);
      }
    }
    const id = config.agentId(member, agent);
    return {
      member,
      handle: member.handle,
      login: member.github,
      agent,
      agentName: agent ? agent.name : null,
      agentId: id,
      isPrimary: !agent || agent === agents[0],
      from: actor === 'agent' ? id : member.handle,
    };
  };
  ctx.me = memo(() => ctx.resolveMe());
  return ctx;
}

/** Split `mesh [globals] <command> ...` into command name and the remaining args. */
function splitCommand(argv) {
  const valued = new Set(GLOBAL_SPEC.string.map((s) => `--${s}`));
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith('-')) return { name: t, rest: [...argv.slice(0, i), ...argv.slice(i + 1)] };
    if (valued.has(t)) i += 1; // skip its value
  }
  return { name: null, rest: argv };
}

async function main(argv, overrides = {}) {
  const out = overrides.stdout || ((s) => process.stdout.write(s));
  const errOut = overrides.stderr || ((s) => process.stderr.write(s));
  try {
    const { name, rest } = splitCommand(argv);
    if (!name) {
      out(`${MAIN_HELP}\n`);
      return argv.includes('-h') || argv.includes('--help') || argv.length === 0 ? 0 : 2;
    }
    if (name === 'help') {
      const target = rest.find((a) => !a.startsWith('-'));
      if (!target) { out(`${MAIN_HELP}\n`); return 0; }
      const c = byName.get(target);
      if (!c) throw new UsageError(`unknown command "${target}"`);
      out(`${c.help}\n`);
      return 0;
    }
    const cmd = byName.get(name);
    if (!cmd) throw new UsageError(`unknown command "${name}" (try \`mesh --help\`)`);
    const args = parseArgs(rest, { ...cmd.spec, alias: { ...(cmd.spec.alias || {}) } });
    if (args.flags.help) { out(`${cmd.help}\n`); return 0; }
    const ctx = buildContext(args.flags, overrides);
    let code;
    try {
      code = await cmd.run(args, ctx);
    } finally {
      // own mutations make the inbox caches (--min-interval, ETag gate) stale: reset them
      if (MUTATING.has(name)) invalidateCache(ctx);
    }
    return typeof code === 'number' ? code : 0;
  } catch (e) {
    if (e instanceof CliError) {
      errOut(`mesh: ${e.message}\n`);
      return e.code;
    }
    if (e && e.name === 'ConfigError') { errOut(`mesh: ${e.message}\n`); return 1; }
    if (e && e.name === 'GhError') { errOut(`mesh: ${e.message}\n`); return 1; }
    errOut(`mesh: ${(process.env.ISSUEMESH_DEBUG && e.stack) || (e && e.message) || e}\n`);
    return 1;
  }
}

module.exports = { main, buildContext, splitCommand, COMMANDS, MAIN_HELP };
