'use strict';

const fs = require('fs');
const path = require('path');
const P = require('../protocol');
const { validateConfig, findConfigPath, memberByLogin, normalizeConfig } = require('../config');
const U = require('./util');

const help = `mesh doctor - check that this repo and machine are ready

Usage: mesh doctor [--json]

Checks: gh installed and authenticated; Node >= 18; GitHub Issues enabled; .issuemesh/team.json valid
and you are a member; standard labels exist; an open Board exists; referee
workflow present (optional, reported as a warning).

Exit codes: 0 all required checks pass; 1 a required check failed.`;

async function run(args, ctx) {
  U.needPositional(args, 0, 0, 'mesh doctor');
  const checks = [];
  const add = (name, ok, detail, required = true) => checks.push({ name, ok, detail, required });

  const major = Number(process.versions.node.split('.')[0]);
  add('node >= 18', major >= 18, `node ${process.versions.node}`);

  let login = null;
  try {
    login = await ctx.login();
    add('gh installed and authenticated', true, `logged in as ${login}`);
  } catch (e) {
    add('gh installed and authenticated', false, e.message);
  }

  let cfg = null;
  const file = findConfigPath(ctx.cwd);
  try {
    cfg = await ctx.config();
    const where = ctx.configSource === 'default-branch'
      ? 'default branch on GitHub (the source of truth; a checkout of any branch can be used)'
      : `${file} (the default branch has none yet; merge the setup PR)`;
    add('team.json source', true, where);
    const v = validateConfig(ctx.configRaw || {});
    add('team.json valid', v.ok, v.ok ? `${cfg.members.length} member(s)` : v.errors.join('; '));
    if (ctx.configSource === 'default-branch' && file) {
      let localRaw = null;
      try { localRaw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { /* unreadable local copy is ignored anyway */ }
      if (!localRaw || JSON.stringify(normalizeConfig(localRaw)) !== JSON.stringify(cfg)) {
        add('local team.json ignored', false, `${file} differs from the default branch and is ignored; delete it from this branch (membership changes go through a PR to the default branch)`, false);
      }
    }
  } catch (e) {
    add('team.json present', false, e.message);
  }
  if (cfg && login) {
    const m = ctx.opts.as ? cfg.members.find((x) => x.handle === P.fromHandle(ctx.opts.as)) : memberByLogin(cfg, login);
    add('you are a team member', !!m, m ? `handle ${m.handle}` : `${login} is not in team.json (use --as <handle>)`);
  }

  if (login) {
    try {
      const repoInfo = await ctx.gh.api('GET', await U.rp(ctx));
      if (repoInfo && repoInfo.has_issues === false) {
        add('GitHub Issues enabled', false, 'Issues are disabled in this repo (forks start that way): enable Settings > General > Features > Issues');
      }
    } catch (e) { /* repo metadata unavailable: the other checks will report real problems */ }
  }
  if (cfg && login) {
    try {
      const have = new Set((await ctx.gh.paginate(`${await U.rp(ctx)}/labels`)).map((l) => l.name.toLowerCase()));
      const missing = P.standardLabels(cfg.members).map((l) => l.name).filter((n) => !have.has(n.toLowerCase()));
      add('labels exist', !missing.length, missing.length ? `${missing.length} missing (run \`mesh labels sync\`): ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', ...' : ''}` : 'all standard labels present');
    } catch (e) { add('labels exist', false, e.message); }
    try {
      const board = await U.resolveBoard(ctx);
      add('board exists', true, `#${board.number}`);
    } catch (e) { add('board exists', false, e.message); }
  }

  // the referee runs from the default branch, so look there (a feature branch need not carry it)
  const wfRel = '.github/workflows/issuemesh-referee.yml';
  let wfOnDefault = false;
  if (login) {
    try { wfOnDefault = !!(await ctx.gh.api('GET', `${await U.rp(ctx)}/contents/${wfRel}`)); } catch (e) { wfOnDefault = false; }
  }
  const wf = path.join(U.repoRoot(ctx.cwd), wfRel);
  const wfLocal = fs.existsSync(wf);
  add('referee workflow present', wfOnDefault || wfLocal, wfOnDefault ? 'on the default branch' : wfLocal ? `${wf} (not on the default branch yet)` : 'not installed (optional; agents enforce the rules themselves)', false);

  const failed = checks.filter((c) => !c.ok && c.required);
  ctx.emit({ ok: !failed.length, checks }, checks.map((c) => `${c.ok ? 'ok  ' : c.required ? 'FAIL' : 'warn'}  ${c.name}: ${c.detail}`).join('\n'));
  return failed.length ? 1 : 0;
}

module.exports = { name: 'doctor', summary: 'verify gh, config, labels, board, referee', help, spec: {}, run };
