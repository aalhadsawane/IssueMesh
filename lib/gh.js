'use strict';

/**
 * Thin wrapper around the `gh` CLI.
 *
 *   transport(method, path, body) -> parsed JSON      (the injectable runner)
 *   createGh(transport, opts)     -> { api, get, paginate, graphql, conditional, exec, calls }
 *   conditional(path, etag)       -> { status: 200|304, etag, data }   (ETag / If-None-Match GET)
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

/**
 * Run `gh <args>` and resolve with `{code, stdout, stderr}` even when it exits
 * non-zero (`gh api -i` exits 1 on a 304 but still prints the response).
 */
function execGhRaw(args, { bin = 'gh', env } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(bin, args, { maxBuffer: 64 * 1024 * 1024, env: env || process.env }, (err, stdout, stderr) => {
      if (err && err.code === 'ENOENT') return reject(new GhError('`gh` is not installed or not on PATH (https://cli.github.com)', { code: 'ENOENT' }));
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: stdout || '', stderr: stderr || '' });
    });
    if (child.stdin) child.stdin.end();
  });
}

/**
 * Parse the output of `gh api -i`: status line, headers, blank line, body.
 * Header names are lower-cased. Returns null when there is no HTTP status line.
 * @param {string} text
 * @returns {?{status: number, headers: Object<string,string>, body: string}}
 */
function parseHttpResponse(text) {
  const s = String(text || '').replace(/^\s+/, '');
  const m = /^HTTP\/[\d.]+ (\d{3})[^\r\n]*(?:\r?\n|$)/.exec(s);
  if (!m) return null;
  const rest = s.slice(m[0].length);
  const sep = /\r?\n\r?\n/.exec(rest);
  const head = sep ? rest.slice(0, sep.index) : rest;
  const body = sep ? rest.slice(sep.index + sep[0].length) : '';
  const headers = {};
  for (const line of head.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return { status: Number(m[1]), headers, body };
}

/**
 * Real conditional GET: `gh api -i -H 'If-None-Match: <etag>' <path>`. A 304
 * makes gh exit 1 with the headers still on stdout; that is a success here. A
 * 304 does not count against the rate limit.
 */
function createConditional({ bin = 'gh', env } = {}) {
  return async function conditional(path, etag) {
    const args = ['api', '-i', '-H', 'Accept: application/vnd.github+json'];
    if (etag) args.push('-H', `If-None-Match: ${etag}`);
    args.push(path);
    const { code, stdout, stderr } = await execGhRaw(args, { bin, env });
    const res = parseHttpResponse(stdout);
    if (!res) throw new GhError(`gh api ${path}: ${(stderr || stdout || `exit ${code}`).trim()}`, { stderr, code });
    const newTag = res.headers.etag || null;
    if (res.status === 304) return { status: 304, etag: newTag || etag || null, data: null };
    if (res.status >= 200 && res.status < 300) {
      let data = null;
      if (res.body.trim()) {
        try { data = JSON.parse(res.body); } catch (e) { throw new GhError(`gh api ${path}: unparsable response body`, { status: res.status, stderr }); }
      }
      return { status: 200, etag: newTag, data };
    }
    let msg = '';
    try { msg = JSON.parse(res.body).message || ''; } catch (_) { msg = res.body.trim(); }
    throw new GhError(`gh api ${path}: HTTP ${res.status}${msg ? ` ${msg}` : ''}`, { status: res.status, stderr });
  };
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
 * @param {{dryRun?:boolean, log?:(s:string)=>void, execFn?:Function, conditional?:(path:string, etag:?string)=>Promise<{status:number, etag:?string, data:*}>}} [opts]
 *   `conditional` is the injectable transport for ETag requests (default: `gh api -i`).
 */
function createGh(transport, opts = {}) {
  const { dryRun = false, log = () => {}, execFn = execGh } = opts;
  let conditionalFn = opts.conditional;
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
    /**
     * Conditional GET with `If-None-Match: <etag>`. Resolves `{status: 200, etag, data}`
     * or `{status: 304, etag, data: null}` (nothing changed; free of rate limit).
     */
    conditional(path, etag) {
      if (!conditionalFn) conditionalFn = createConditional();
      return conditionalFn(path, etag || null);
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

module.exports = { GhError, execGh, execGhRaw, createTransport, createConditional, parseHttpResponse, createGh };
