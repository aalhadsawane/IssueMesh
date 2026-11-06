'use strict';

const P = require('../protocol');
const U = require('./util');
const { UsageError } = U;

const help = `mesh label - set single-valued protocol labels

Usage: mesh label <n> [--status S] [--priority p0..p3] [--size s|m|l] [--kind K]

Each flag replaces the existing label in that namespace.
  --status    ${P.STATUS.join(' | ')}
  --priority  ${P.PRIORITIES.join(' | ')}
  --size      ${P.SIZES.join(' | ')}
  --kind      ${P.KINDS.join(' | ')}`;

async function run(args, ctx) {
  U.needPositional(args, 1, 1, 'mesh label <n> [--status S] [--priority P] [--size Z] [--kind K]');
  const n = U.parseNumber(args._[0]);
  const f = args.flags;
  const table = { status: P.STATUS, priority: P.PRIORITIES, size: P.SIZES, kind: P.KINDS };
  const set = {};
  for (const [ns, allowed] of Object.entries(table)) {
    if (f[ns] === undefined) continue;
    if (!allowed.includes(f[ns])) throw new UsageError(`--${ns} must be one of ${allowed.join(', ')}`);
    set[ns] = f[ns];
  }
  if (!Object.keys(set).length) throw new UsageError('nothing to do: pass --status, --priority, --size or --kind');
  const labels = await U.changeLabels(ctx, n, { set });
  ctx.emit({ issue: n, labels }, `Labels on #${n}: ${labels.join(', ')}`);
  return 0;
}

module.exports = { name: 'label', summary: 'set status/priority/size/kind labels', help, spec: { string: ['status', 'priority', 'size', 'kind'] }, run };
