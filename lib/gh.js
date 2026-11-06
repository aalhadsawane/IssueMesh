'use strict';

/**
 * Thin wrapper around the `gh` CLI.
 *
 *   transport(method, path, body) -> parsed JSON      (the injectable runner)
 *   createGh(transport, opts)     -> { api, get, paginate, graphql, exec, calls }
 *
 * Tests inject a fake transport (an in-memory GitHub). Dry-run mode records
 * every non-GET call in `gh.calls` instead of sending it.
 */

const { execFile } = require('child_process');

class GhError extends Error {
  constructor(message, { status = null, stderr = '', code = null } = {}) {
    super(message);
    this.name = 'GhError';
    this.status = status;
    this.stderr = stderr;
    this.code = code;
  }
}

/** Run `gh <args>`; resolves with stdout. */
function execGh(args, { input, bin = 'gh', env } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(bin, args, { maxBuffer: 64 * 1024 * 1024, env: env || process.env }, (err, stdout, stderr) => {
      if (err) {
        if (err.code === 'ENOENT') return reject(new GhError('`gh` is not installed or not on PATH (https://cli.github.com)', { code: 'ENOENT' }));
        const text = `${stderr || ''}\n${stdout || ''}`;
        const m = /HTTP (\d{3})/.exec(text);
        let msg = (stderr || '').trim();
        if (!msg) {
          try { msg = JSON.parse(stdout).message || ''; } catch (_) { msg = (stdout || '').trim(); }
        }
        return reject(new GhError(`gh ${args.slice(0, 3).join(' ')}: ${msg || err.message}`, { status: m ? Number(m[1]) : null, stderr: stderr || '', code: err.code }));
      }
      resolve(stdout);
    });
    if (input !== undefined && input !== null) child.stdin.end(input);
    else if (child.stdin) child.stdin.end();
  });
}

/** Real transport: `gh api -X METHOD path [--input -]`. */
function createTransport({ bin = 'gh', env } = {}) {
  return async function transport(method, path, body) {
    const args = ['api', '-X', method, '-H', 'Accept: application/vnd.github+json', path];
    let input;
    if (body !== undefined && body !== null && method !== 'GET') {
      args.push('--input', '-');
      input = JSON.stringify(body);
    }
    const out = await execGh(args, { input, bin, env });
    return out.trim() === '' ? null : JSON.parse(out);
  };
}

function withQuery(path, params) {
  const sep = path.includes('?') ? '&' : '?';
  return path + sep + params;
}

/**
 * @param {(method:string, path:string, body?:any)=>Promise<any>} transport
 * @param {{dryRun?:boolean, log?:(s:string)=>void, execFn?:Function}} [opts]
 */
function createGh(transport, opts = {}) {
  const { dryRun = false, log = () => {}, execFn = execGh } = opts;
  const calls = [];
  let dryId = 0;

  function stub(method, path) {
    dryId += 1;
    return { id: -dryId, number: 0, node_id: 'DRY_RUN', html_url: '', dry_run: true, method, path };
  }

  const gh = {
    calls,
    dryRun,
    async api(method, path, body) {
      method = String(method).toUpperCase();
      if (dryRun && method !== 'GET') {
        calls.push({ method, path, body });
        log(`[dry-run] ${method} ${path}${body !== undefined ? ' ' + JSON.stringify(body) : ''}`);
        return stub(method, path);
      }
      return transport(method, path, body);
    },
    get(path) { return gh.api('GET', path); },
    /** GET every page of a list endpoint (array responses). */
    async paginate(path, { perPage = 100, maxPages = 50 } = {}) {
      const all = [];
      for (let page = 1; page <= maxPages; page++) {
        const res = await gh.api('GET', withQuery(path, `per_page=${perPage}&page=${page}`));
        const arr = Array.isArray(res) ? res : [];
        all.push(...arr);
        if (arr.length < perPage) break;
      }
      return all;
    },
    /** GraphQL; mutations are recorded (not sent) in dry-run mode. */
    async graphql(query, variables = {}) {
      const isMutation = /^\s*mutation\b/.test(query);
      if (dryRun && isMutation) {
        calls.push({ method: 'POST', path: 'graphql', body: { query, variables } });
        log(`[dry-run] graphql ${query.replace(/\s+/g, ' ').trim()} ${JSON.stringify(variables)}`);
        return { dry_run: true, data: {} };
      }
      const res = await transport('POST', 'graphql', { query, variables });
      if (res && res.errors && res.errors.length) {
        throw new GhError(`graphql: ${res.errors.map((e) => e.message).join('; ')}`);
      }
      return res && res.data !== undefined ? res.data : res;
    },
    /** Raw `gh <args>` (read-only helpers such as `repo view`). */
    exec(args, o) { return execFn(args, o); },
    async repoSlug() {
      const out = await gh.exec(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']);
      return String(out).trim();
    },
  };
  return gh;
}

module.exports = { GhError, execGh, createTransport, createGh };
