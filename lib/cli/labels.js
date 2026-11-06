'use strict';

const P = require('../protocol');
const { rp, enc, UsageError } = require('./util');

const help = `mesh labels - manage the standard IssueMesh label set

Usage: mesh labels sync

Creates missing labels (status:*, to:*, ping:*, kind:*, priority:*, size:*,
human-only, source:external) for every member handle and updates the color and
description of existing ones. Never deletes labels.`;

async function syncLabels(ctx) {
  const cfg = await ctx.config();
  const r = await rp(ctx);
  const existing = await ctx.gh.paginate(`${r}/labels`);
  const byName = new Map(existing.map((l) => [l.name.toLowerCase(), l]));
  const out = { created: [], updated: [], unchanged: 0 };
  for (const want of P.standardLabels(cfg.members.map((m) => m.handle))) {
    const have = byName.get(want.name.toLowerCase());
    if (!have) {
      await ctx.gh.api('POST', `${r}/labels`, want);
      out.created.push(want.name);
    } else if ((have.color || '').toLowerCase() !== want.color.toLowerCase() || (have.description || '') !== want.description) {
      await ctx.gh.api('PATCH', `${r}/labels/${enc(have.name)}`, { color: want.color, description: want.description });
      out.updated.push(want.name);
    } else out.unchanged += 1;
  }
  return out;
}

async function run(args, ctx) {
  if (args._[0] !== 'sync' || args._.length !== 1) throw new UsageError('usage: mesh labels sync');
  const res = await syncLabels(ctx);
  ctx.emit(res, `Labels: ${res.created.length} created, ${res.updated.length} updated, ${res.unchanged} unchanged.`);
  return 0;
}

module.exports = { name: 'labels', summary: 'labels sync: create/update the standard label set', help, spec: {}, run, syncLabels };
