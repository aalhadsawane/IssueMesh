'use strict';

const fs = require('fs');
const path = require('path');
const { validateConfig } = require('../config');
const U = require('./util');
const { UsageError, CliError } = U;
const { syncLabels } = require('./labels');

const BEGIN = '<!-- issuemesh:begin -->';
const END = '<!-- issuemesh:end -->';
const AGENT_RUNNER = '.github/workflows/issuemesh-agent.yml';

const help = `mesh init - scaffold IssueMesh in this repository

Usage: mesh init [--member handle:login]... [--all] [--templates] [--labels] [--board]
                 [--force] [--with-agent-runner]

With none of --all/--templates/--labels/--board, everything runs (--all).
Safe to re-run: existing files are never overwritten without --force.

Steps:
  team.json    create .issuemesh/team.json from --member flags (or prompts in a
               terminal); an existing team.json is kept
  --templates  copy templates/ (issue forms, PR template, referee workflow) into
               the repo; add the IssueMesh block to AGENTS.md and CLAUDE.md
               (fenced by ${BEGIN} / ${END}; replaced in place on re-run;
               AGENTS.md is created if neither file exists)
  --labels     create/update the standard labels (same as \`mesh labels sync\`)
  --board      create and pin the Board issue, write board_issue to team.json

Options:
  --member h:login      add a team member (repeatable), e.g. --member aalhad:aalhadsawane
  --force               overwrite existing template files
  --with-agent-runner   also copy the optional advanced ${AGENT_RUNNER}
  --dry-run             print what would happen; mutate nothing`;

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Pure, idempotent: insert or replace the fenced block in `text`. */
function injectSnippet(text, snippet) {
  const inner = snippet.replace(new RegExp(`${esc(BEGIN)}\\s*`, 'g'), '').replace(new RegExp(`\\s*${esc(END)}`, 'g'), '').trim();
  const block = `${BEGIN}\n${inner}\n${END}\n`;
  const re = new RegExp(`${esc(BEGIN)}[\\s\\S]*?${esc(END)}\\n?`);
  if (re.test(text)) return text.replace(re, () => block);
  if (text === '') return block;
  return `${text}${text.endsWith('\n') ? '\n' : '\n\n'}${block}`;
}

function walk(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, base));
    else out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out.sort();
}

function parseMembers(list) {
  return list.map((s) => {
    const m = /^([^:]+):(.+)$/.exec(s);
    if (!m) throw new UsageError(`--member expects handle:login, got "${s}"`);
    return { handle: m[1].trim(), github: m[2].trim() };
  });
}

async function promptMembers(ctx) {
  const rl = require('readline').createInterface({ input: process.stdin, output: process.stderr });
  const ask = (q) => new Promise((res) => rl.question(q, res));
  const out = [];
  try {
    ctx.err('Enter team members as handle:login (empty line to finish).');
    for (;;) {
      const a = (await ask('member> ')).trim();
      if (!a) break;
      out.push(...parseMembers([a]));
    }
  } finally { rl.close(); }
  return out;
}

async function run(args, ctx) {
  U.needPositional(args, 0, 0, 'mesh init [flags]');
  const f = args.flags;
  const any = f.all || f.templates || f.labels || f.board;
  const doTemplates = f.all || f.templates || !any;
  const doLabels = f.all || f.labels || !any;
  const doBoard = f.all || f.board || !any;
  const root = U.repoRoot(ctx.cwd);
  const pkgRoot = path.resolve(fs.realpathSync(__dirname), '..', '..');
  const tdir = ctx.templatesDir || path.join(pkgRoot, 'templates');
  const report = { created: [], skipped: [], warnings: [], labels: null, board: null };
  const warn = (m) => { report.warnings.push(m); ctx.err(`warning: ${m}`); };
  const cfgFile = path.join(root, '.issuemesh', 'team.json');
  const tplCfg = path.join(tdir, '.issuemesh', 'team.json');

  // 1. team.json
  let raw;
  if (fs.existsSync(cfgFile)) {
    try { raw = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch (e) { throw new CliError(`cannot parse ${cfgFile}: ${e.message}`); }
    if (f.member) warn('.issuemesh/team.json already exists; --member ignored (edit the file instead)');
    report.skipped.push('.issuemesh/team.json');
  } else {
    let members = f.member ? parseMembers(f.member) : [];
    if (!members.length && ctx.isTTY && !ctx.json) members = await promptMembers(ctx);
    if (!members.length) throw new UsageError('no .issuemesh/team.json yet: pass --member handle:login (repeatable) or run in a terminal');
    let base = { version: 1, areas: {}, board_issue: null, policy: {} };
    if (fs.existsSync(tplCfg)) {
      try { base = JSON.parse(fs.readFileSync(tplCfg, 'utf8')); } catch (e) { warn(`template team.json unreadable (${e.message}); using a minimal one`); }
    } else warn('templates/.issuemesh/team.json missing; using a minimal team.json');
    base.members = members.map((m) => ({ handle: m.handle, github: m.github, agent: { enabled: true, runtime: 'claude-code', wip: 2 }, skills: [], route_mentions_to_agent: true }));
    if (base.triage) delete base.triage.rotation;
    base.board_issue = null;
    const v = validateConfig(base);
    if (!v.ok) throw new UsageError(`generated team.json is invalid:\n  - ${v.errors.join('\n  - ')}`);
    U.writeFileSafe(ctx, cfgFile, JSON.stringify(base, null, 2) + '\n');
    raw = base;
    report.created.push('.issuemesh/team.json');
  }
  const v = validateConfig(raw);
  if (!v.ok) throw new CliError(`Invalid ${cfgFile}:\n  - ${v.errors.join('\n  - ')}`);
  ctx.setConfig(raw);

  // 2. templates + snippet
  if (doTemplates) {
    if (!fs.existsSync(tdir)) warn(`templates directory not found: ${tdir}`);
    else {
      for (const rel of walk(tdir)) {
        if (rel === '.issuemesh/team.json' || rel === 'AGENTS.snippet.md') continue;
        if (rel === AGENT_RUNNER && !f['with-agent-runner']) continue;
        const dst = path.join(root, rel);
        if (fs.existsSync(dst) && !f.force) { report.skipped.push(rel); continue; }
        U.writeFileSafe(ctx, dst, fs.readFileSync(path.join(tdir, rel)));
        report.created.push(rel);
      }
      if (!fs.existsSync(path.join(tdir, '.github'))) warn('templates/.github missing; no issue forms or workflows copied');
    }
    const snipFile = path.join(tdir, 'AGENTS.snippet.md');
    if (!fs.existsSync(snipFile)) warn('templates/AGENTS.snippet.md missing; AGENTS.md/CLAUDE.md not updated');
    else {
      const snippet = fs.readFileSync(snipFile, 'utf8');
      let targets = ['AGENTS.md', 'CLAUDE.md'].filter((n) => fs.existsSync(path.join(root, n)));
      if (!targets.length) targets = ['AGENTS.md'];
      for (const name of targets) {
        const file = path.join(root, name);
        const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
        const after = injectSnippet(before, snippet);
        if (after === before) report.skipped.push(`${name} (block up to date)`);
        else { U.writeFileSafe(ctx, file, after); report.created.push(`${name} (IssueMesh block)`); }
      }
    }
  }

  // 3. labels
  if (doLabels) report.labels = await syncLabels(ctx);

  // 4. board
  if (doBoard) {
    let board = null;
    try { board = await U.resolveBoard(ctx); } catch (e) { if (!(e instanceof CliError)) throw e; }
    if (!board) {
      const r = await U.rp(ctx);
      board = await ctx.gh.api('POST', `${r}/issues`, {
        title: 'IssueMesh Board',
        body: 'The team Board: standups, broadcasts and questions that belong to no issue. Agents read only new comments (`mesh board`); anything that needs tracking becomes its own issue linked here. Do not close while active.',
        labels: ['kind:board'],
      });
      report.created.push(`Board issue #${board.number}`);
      try {
        await ctx.gh.graphql('mutation($id: ID!) { pinIssue(input: {issueId: $id}) { issue { id } } }', { id: board.node_id });
      } catch (e) { warn(`could not pin the Board (pin it manually): ${e.message}`); }
    } else report.skipped.push(`Board issue #${board.number}`);
    report.board = board.number;
    if (raw.board_issue !== board.number) {
      raw.board_issue = board.number;
      U.writeFileSafe(ctx, cfgFile, JSON.stringify(raw, null, 2) + '\n');
      ctx.setConfig(raw);
    }
  }

  const lines = ['IssueMesh init done.'];
  for (const c of report.created) lines.push(`  created  ${c}`);
  for (const s of report.skipped) lines.push(`  kept     ${s}`);
  if (report.labels) lines.push(`  labels   ${report.labels.created.length} created, ${report.labels.updated.length} updated`);
  lines.push('Next: commit .issuemesh/ and .github/, then run `mesh doctor` and `mesh whoami`.');
  ctx.emit(report, lines.join('\n'));
  return 0;
}

module.exports = {
  name: 'init',
  summary: 'scaffold team.json, templates, labels and the Board',
  help,
  spec: { boolean: ['all', 'templates', 'labels', 'board', 'force', 'with-agent-runner'], multi: ['member'] },
  run,
  injectSnippet,
  BEGIN,
  END,
};
