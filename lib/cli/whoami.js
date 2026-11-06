'use strict';

const { triagerOnDuty } = require('../config');
const { rp, enc, UsageError } = require('./util');
const { countAgentClaims, toItem } = require('./inbox');

const help = `mesh whoami - show who you are in the mesh

Usage: mesh whoami [--json]

Prints handle, agent, agent id, GitHub login, actor, whether you are triager on
duty, live claims held (open issues assigned to you with status:claimed; with
several agents, only those claimed by this agent) and the agent's WIP limit.
The agent is --agent / ISSUEMESH_AGENT / the part after the slash in --as, else
the member's primary agent; the agent id is <handle>/<agent> for members with
more than one agent and the plain handle otherwise.

JSON keys: handle, agent (name or null), agent_id, login, actor, repo,
triager_on_duty (bool), on_duty_handle, live_claims, wip.`;

async function run(args, ctx) {
  if (args._.length) throw new UsageError('usage: mesh whoami [--json]');
  const me = await ctx.me();
  const cfg = await ctx.config();
  const repo = await ctx.repo();
  const onDuty = triagerOnDuty(cfg, ctx.now());
  const mine = await ctx.gh.paginate(`${await rp(ctx)}/issues?state=open&labels=${enc('status:claimed')}&assignee=${enc(me.login)}`);
  const live = await countAgentClaims(ctx, me, mine.map(toItem));
  const data = {
    handle: me.handle,
    agent: me.agentName,
    agent_id: me.agentId,
    login: me.login,
    actor: ctx.actor,
    repo,
    triager_on_duty: onDuty === me.handle,
    on_duty_handle: onDuty,
    live_claims: live,
    wip: me.agent ? me.agent.wip : me.member.agent.wip,
  };
  ctx.emit(data, [
    `handle:         ${data.handle}`,
    `agent:          ${data.agent || '-'}`,
    `agent id:       ${data.agent_id}`,
    `login:          ${data.login}`,
    `actor:          ${data.actor}`,
    `repo:           ${data.repo}`,
    `triage on duty: ${data.on_duty_handle || '-'}${data.triager_on_duty ? ' (you)' : ''}`,
    `live claims:    ${data.live_claims}/${data.wip}`,
  ].join('\n'));
  return 0;
}

module.exports = { name: 'whoami', summary: 'show handle, agent, login, actor, triage duty, claims/WIP', help, spec: {}, run };
