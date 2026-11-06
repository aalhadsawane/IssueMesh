'use strict';

const U = require('./util');
const { heartbeatClaim } = require('./status');

const help = `mesh heartbeat - extend your claim lease without changing the comment

Usage: mesh heartbeat <n>

Bumps lease= in your claim comment to now + policy.lease_minutes. Call at least
every lease/2.

Exit codes: 0 ok; 3 no active claim by you on the issue.`;

async function run(args, ctx) {
  U.needPositional(args, 1, 1, 'mesh heartbeat <n>');
  const n = U.parseNumber(args._[0]);
  const res = await heartbeatClaim(ctx, n, null);
  ctx.emit(res, `Heartbeat on #${n}: lease until ${res.lease}.`);
  return 0;
}

module.exports = { name: 'heartbeat', summary: 'bump the lease of your claim', help, spec: {}, run };
