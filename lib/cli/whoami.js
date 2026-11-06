'use strict';

const { triagerOnDuty } = require('../config');
const { rp, enc, labelNames, assigneeLogins, UsageError } = require('./util');

const help = `mesh whoami - show who you are in the mesh

Usage: mesh whoami [--json]

Prints handle, GitHub login, actor, whether you are triager on duty, live
claims held (open issues assigned to you with status:claimed) and your WIP limit.

JSON keys: handle, login, actor, repo, triager_on_duty (bool), on_duty_handle,
live_claims, wip.`;

async function run(args, ctx) {
  if (args._.length) throw new UsageError('usage: mesh whoami [--json]');
  const me = await ctx.me();
  const cfg = await ctx.config();
  const repo = await ctx.repo();
  const onDuty = triagerOnDuty(cfg, ctx.now());
  const mine = await ctx.gh.paginate(`${await rp(ctx)}/issues?state=open&labels=${enc('status:claimed')}&assignee=${enc(me.login)}`);
  const live = mine.filter((i) => !i.pull_request && labelNames(i).includes('status:claimed') && assigneeLogins(i).some((a) => a.toLowerCase() === me.login.toLowerCase())).length;
  const data = {
    handle: me.handle,
    login: me.login,
    actor: ctx.actor,
    repo,
    triager_on_duty: onDuty === me.handle,
    on_duty_handle: onDuty,
    live_claims: live,
    wip: me.member.agent.wip,
  };
  ctx.emit(data, [
    `handle:         ${data.handle}`,
    `login:          ${data.login}`,
    `actor:          ${data.actor}`,
    `repo:           ${data.repo}`,
    `triage on duty: ${data.on_duty_handle || '-'}${data.triager_on_duty ? ' (you)' : ''}`,
    `live claims:    ${data.live_claims}/${data.wip}`,
  ].join('\n'));
  return 0;
}

module.exports = { name: 'whoami', summary: 'show handle, login, actor, triage duty, claims/WIP', help, spec: {}, run };
