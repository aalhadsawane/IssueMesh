'use strict';

// Tests for lib/gh.js conditional requests (PROTOCOL.md section 6 "Fast check").
// The real parsing path is exercised with a stub `gh` executable on PATH that
// prints what `gh api -i` prints (verified live: a 304 prints the status line and
// headers on stdout, then `gh: HTTP 304` on stderr, exit code 1).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createGh, createConditional, parseHttpResponse, GhError } = require('../lib/gh');

const sh = (s) => s.replace(/'/g, "'\\''");

/** Create a dir containing a `gh` stub that logs its args and replays STUB_* behaviour. */
function makeStub() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-ghstub-'));
  const log = path.join(dir, 'calls.log');
  const script = `#!/bin/sh
printf '%s\\n' "$*" >> '${sh(log)}'
case "$STUB_MODE" in
  200)
    printf 'HTTP/2.0 200 OK\\r\\nContent-Type: application/json; charset=utf-8\\r\\nEtag: W/"abc123"\\r\\nX-Ratelimit-Remaining: 4990\\r\\n\\r\\n[{"number":7,"title":"top"}]'
    exit 0 ;;
  304)
    # only a matching If-None-Match yields 304; otherwise behave like a fresh 200
    case "$*" in
      *'If-None-Match: W/"abc123"'*)
        printf 'HTTP/2.0 304 Not Modified\\r\\nEtag: W/"abc123"\\r\\nX-Ratelimit-Remaining: 4990\\r\\n\\r\\n'
        echo 'gh: HTTP 304' >&2
        exit 1 ;;
      *)
        printf 'HTTP/2.0 200 OK\\r\\nEtag: W/"abc123"\\r\\n\\r\\n[]'
        exit 0 ;;
    esac ;;
  404)
    printf 'HTTP/2.0 404 Not Found\\r\\nContent-Type: application/json\\r\\n\\r\\n{"message":"Not Found"}'
    echo 'gh: Not Found (HTTP 404)' >&2
    exit 1 ;;
  auth)
    echo 'To get started with GitHub CLI, please run:  gh auth login' >&2
    exit 4 ;;
  lowercase)
    printf 'HTTP/1.1 200 OK\\netag: "lower"\\n\\n{"ok":true}'
    exit 0 ;;
  empty200)
    printf 'HTTP/2.0 200 OK\\r\\nEtag: "e"\\r\\n\\r\\n'
    exit 0 ;;
  badjson)
    printf 'HTTP/2.0 200 OK\\r\\n\\r\\n<html>'
    exit 0 ;;
esac
exit 99
`;
  const bin = path.join(dir, 'gh');
  fs.writeFileSync(bin, script, { mode: 0o755 });
  const env = (mode) => ({ ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}`, STUB_MODE: mode });
  return { dir, env, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []) };
}

test('parseHttpResponse: status, lower-cased headers, body; CRLF and LF', () => {
  const r = parseHttpResponse('HTTP/2.0 200 OK\r\nETag: W/"x"\r\nLink: <u>; rel="next"\r\n\r\n[1,2]');
  assert.deepEqual([r.status, r.headers.etag, r.body], [200, 'W/"x"', '[1,2]']);
  assert.equal(r.headers.link, '<u>; rel="next"');
  const lf = parseHttpResponse('HTTP/1.1 304 Not Modified\netag: "q"\n\n');
  assert.deepEqual([lf.status, lf.headers.etag, lf.body], [304, '"q"', '']);
  assert.equal(parseHttpResponse('not http'), null);
  assert.equal(parseHttpResponse(''), null);
  assert.equal(parseHttpResponse(null), null);
  assert.deepEqual(parseHttpResponse('HTTP/2 200').body, ''); // no headers at all
});

test('conditional (stub gh on PATH): 200 returns etag and parsed JSON', async () => {
  const stub = makeStub();
  test.after(() => fs.rmSync(stub.dir, { recursive: true, force: true }));
  const cond = createConditional({ env: stub.env('200') });
  const res = await cond('repos/o/r/issues?state=open&per_page=1', null);
  assert.deepEqual(res, { status: 200, etag: 'W/"abc123"', data: [{ number: 7, title: 'top' }] });
  const [line] = stub.calls();
  assert.match(line, /^api -i /);
  assert.match(line, /repos\/o\/r\/issues\?state=open&per_page=1$/);
  assert.ok(!/If-None-Match/.test(line), 'no etag, no conditional header');
});

test('conditional (stub gh on PATH): exit 1 + HTTP 304 is success with the cached etag', async () => {
  const stub = makeStub();
  test.after(() => fs.rmSync(stub.dir, { recursive: true, force: true }));
  const cond = createConditional({ env: stub.env('304') });
  const res = await cond('repos/o/r/issues?per_page=1', 'W/"abc123"');
  assert.deepEqual(res, { status: 304, etag: 'W/"abc123"', data: null });
  assert.match(stub.calls()[0], /-H If-None-Match: W\/"abc123"/);
  // a different etag: the stub answers with a fresh 200
  const fresh = await cond('repos/o/r/issues?per_page=1', 'W/"stale"');
  assert.deepEqual([fresh.status, fresh.etag, fresh.data], [200, 'W/"abc123"', []]);
});

test('conditional via createGh().conditional uses the PATH gh by default (injectable transport otherwise)', async () => {
  const stub = makeStub();
  test.after(() => fs.rmSync(stub.dir, { recursive: true, force: true }));
  const saved = process.env.PATH;
  const savedMode = process.env.STUB_MODE;
  process.env.PATH = `${stub.dir}${path.delimiter}${saved}`;
  process.env.STUB_MODE = '304';
  try {
    const gh = createGh(async () => { throw new Error('transport must not be used'); });
    assert.equal((await gh.conditional('repos/o/r/issues', 'W/"abc123"')).status, 304);
  } finally {
    process.env.PATH = saved;
    if (savedMode === undefined) delete process.env.STUB_MODE; else process.env.STUB_MODE = savedMode;
  }
  const calls = [];
  const injected = createGh(async () => null, { conditional: async (p, e) => { calls.push([p, e]); return { status: 304, etag: e, data: null }; } });
  assert.deepEqual(await injected.conditional('p', 'e1'), { status: 304, etag: 'e1', data: null });
  await injected.conditional('p2');
  assert.deepEqual(calls, [['p', 'e1'], ['p2', null]]);
});

test('conditional (stub): lower-case etag header, LF line endings, empty and invalid bodies', async () => {
  const stub = makeStub();
  test.after(() => fs.rmSync(stub.dir, { recursive: true, force: true }));
  assert.deepEqual(await createConditional({ env: stub.env('lowercase') })('p', null), { status: 200, etag: '"lower"', data: { ok: true } });
  assert.deepEqual(await createConditional({ env: stub.env('empty200') })('p', null), { status: 200, etag: '"e"', data: null });
  await assert.rejects(createConditional({ env: stub.env('badjson') })('p', null), /unparsable/);
});

test('conditional (stub): HTTP errors and a gh failure without a response are GhErrors', async () => {
  const stub = makeStub();
  test.after(() => fs.rmSync(stub.dir, { recursive: true, force: true }));
  await assert.rejects(createConditional({ env: stub.env('404') })('p', null), (e) => e instanceof GhError && e.status === 404 && /Not Found/.test(e.message));
  await assert.rejects(createConditional({ env: stub.env('auth') })('p', null), (e) => e instanceof GhError && /gh auth login/.test(e.message));
});

test('conditional: gh missing from PATH is a clear GhError', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-nogh-'));
  test.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  await assert.rejects(createConditional({ env: { PATH: empty } })('p', null), (e) => e instanceof GhError && e.code === 'ENOENT');
});

test('parseRemoteSlug handles https, ssh, scp-style and .git suffixes', () => {
  const { parseRemoteSlug } = require('../lib/gh');
  for (const [u, want] of [
    ['https://github.com/jarjlol/diffullama', 'jarjlol/diffullama'],
    ['https://github.com/jarjlol/diffullama.git\n', 'jarjlol/diffullama'],
    ['git@github.com:aalhadsawane/IssueMesh.git', 'aalhadsawane/IssueMesh'],
    ['ssh://git@github.com/o/r.name.git', 'o/r.name'],
    ['https://x-access-token:abc@github.com/o/r/', 'o/r'],
  ]) assert.equal(parseRemoteSlug(u), want, u);
  assert.equal(parseRemoteSlug('https://gitlab.com/o/r'), null);
  assert.equal(parseRemoteSlug(''), null);
});
