'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const U = require('./util');
const { UsageError, CliError } = U;
const { computeInbox } = require('./inbox');

const help = `mesh watch - poll the inbox and run a command when there is work

Usage: mesh watch [--agent <name>] --exec "<cmd>" [--interval 300] [--max-interval 1800] [--once]

Loop: check the inbox (like \`mesh inbox -q\`); if non-empty run <cmd> in a shell
with ISSUEMESH_HANDLE, ISSUEMESH_AGENT (the agent name) and ISSUEMESH_ACTOR=agent
set, then wait --interval. While the inbox is empty the wait doubles each time up
to --max-interval. Every wait is jittered by +/-15%. Single-flight per agent: a
pid lock at .git/issuemesh/watch.lock (watch-<handle>_<agent>.lock for members with
several agents) stops a second watcher for the same agent; run one watch loop per
agent (--agent <name>). Stale locks are taken over. Ctrl-C exits cleanly.

Options:
  --exec "<cmd>"       command to run when there is work (required)
  --interval SECONDS   base wait (default 300)
  --max-interval SEC   back-off ceiling (default 1800)
  --once               check once, run the command if there is work, exit`;

/**
 * Pure scheduling step.
 * @param {{delay:number, interval:number, maxInterval:number, hadWork:boolean, rand?:()=>number}} s  (seconds)
 * @returns {{sleepMs:number, nextDelay:number}}
 */
function scheduleNext({ delay, interval, maxInterval, hadWork, rand = Math.random }) {
  const base = hadWork ? interval : delay;
  const factor = 1 + (rand() * 2 - 1) * 0.15;
  const sleepMs = Math.max(0, Math.round(base * 1000 * factor));
  const nextDelay = hadWork ? interval : Math.min(maxInterval, delay * 2);
  return { sleepMs, nextDelay };
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function acquireLock(file, info) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, JSON.stringify(info), { flag: 'wx' });
      return () => { try { fs.unlinkSync(file); } catch (_) { /* gone */ } };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let held = null;
      try { held = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { /* corrupt = stale */ }
      if (held && held.pid && pidAlive(held.pid)) throw new CliError(`another mesh watch is running (pid ${held.pid}); lock ${file}`);
      try { fs.unlinkSync(file); } catch (_) { /* raced */ }
    }
  }
  throw new CliError(`cannot acquire ${file}`);
}

function runShell(cmd, env) {
  return new Promise((resolve) => {
    const child = spawn(cmd, { shell: true, stdio: 'inherit', env });
    child.on('error', () => resolve(1));
    child.on('exit', (code) => resolve(code === null ? 1 : code));
  });
}

/**
 * The loop, with injectable dependencies (used by tests).
 * deps: { check():Promise<number>, exec():Promise<number>, sleep(ms):Promise, rand, log(s), shouldStop():bool, maxIterations }
 */
async function watchLoop({ interval, maxInterval }, deps) {
  let delay = interval;
  let iterations = 0;
  while (!deps.shouldStop() && iterations < (deps.maxIterations || Infinity)) {
    iterations += 1;
    let count = 0;
    try { count = await deps.check(); } catch (e) { deps.log(`inbox check failed: ${e.message}`); }
    const hadWork = count > 0;
    if (hadWork) {
      deps.log(`inbox has ${count} item(s); running command`);
      const code = await deps.exec();
      deps.log(`command exited ${code}`);
    }
    if (deps.once) break;
    const step = scheduleNext({ delay, interval, maxInterval, hadWork, rand: deps.rand });
    delay = step.nextDelay;
    deps.log(`next check in ${Math.round(step.sleepMs / 1000)}s`);
    await deps.sleep(step.sleepMs);
  }
  return iterations;
}

async function run(args, ctx) {
  U.needPositional(args, 0, 0, 'mesh watch --exec "<cmd>"');
  const f = args.flags;
  if (!f.exec) throw new UsageError('missing --exec "<cmd>"');
  const interval = f.interval === undefined ? 300 : Number(f.interval);
  const maxInterval = f['max-interval'] === undefined ? 1800 : Number(f['max-interval']);
  if (!(interval > 0) || !(maxInterval >= interval)) throw new UsageError('--interval must be > 0 and --max-interval >= --interval');
  const me = await ctx.me();
  const lockFile = path.join(U.stateDir(ctx), me.agentId.includes('/') ? `watch-${me.agentId.replace(/\//g, '_')}.lock` : 'watch.lock');
  const release = ctx.dryRun ? () => {} : acquireLock(lockFile, { pid: process.pid, handle: me.handle, agent: me.agentName, started: ctx.now().toISOString() });
  let stop = false;
  let wake = null;
  const onSig = () => { stop = true; if (wake) wake(); };
  process.once('SIGINT', onSig);
  process.once('SIGTERM', onSig);
  try {
    await watchLoop({ interval, maxInterval }, {
      once: !!f.once,
      maxIterations: f['max-iterations'] ? Number(f['max-iterations']) : undefined,
      rand: ctx.rand,
      shouldStop: () => stop,
      log: (s) => ctx.err(`[watch] ${s}`),
      check: async () => (await computeInbox(ctx)).items.length,
      exec: () => runShell(f.exec, { ...ctx.env, ISSUEMESH_HANDLE: me.handle, ...(me.agentName ? { ISSUEMESH_AGENT: me.agentName } : {}), ISSUEMESH_ACTOR: 'agent' }),
      sleep: (ms) => new Promise((resolve) => {
        const t = setTimeout(() => { wake = null; resolve(); }, ms);
        wake = () => { clearTimeout(t); wake = null; resolve(); };
      }),
    });
  } finally {
    process.removeListener('SIGINT', onSig);
    process.removeListener('SIGTERM', onSig);
    release();
  }
  return 0;
}

module.exports = {
  name: 'watch',
  summary: 'poll inbox with jitter + back-off, run a command on work',
  help,
  spec: { boolean: ['once'], string: ['exec', 'interval', 'max-interval', 'max-iterations'] },
  run,
  scheduleNext,
  watchLoop,
  acquireLock,
};
