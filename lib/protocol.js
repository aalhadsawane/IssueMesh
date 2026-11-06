'use strict';

/**
 * IssueMesh protocol primitives: labels, message markers, slash commands,
 * claim arbitration, loop guard and inbox classification.
 *
 * Spec: PROTOCOL.md sections 2 (labels), 3 (markers), 4 (claims), 5 (slash
 * commands), 6 (inbox) and 8 (loop guard).
 *
 * Everything here is pure and deterministic: no I/O, and the current time is
 * always passed in as `now` (a Date).
 */

const { triagerOnDuty, memberByLogin, agentsOf } = require('./config');

const MARKER_VERSION = 'v1';
const STATUS = ['triage', 'ready', 'claimed', 'review', 'blocked', 'needs-human', 'hold'];
const KINDS = ['task', 'bug', 'question', 'decision', 'epic', 'board'];
const PRIORITIES = ['p0', 'p1', 'p2', 'p3'];
const SIZES = ['s', 'm', 'l'];
const FLAG_LABELS = { humanOnly: 'human-only', external: 'source:external' };
const MESSAGE_TYPES = ['claim', 'released', 'ask', 'answer', 'handoff', 'triage', 'review', 'standup', 'broadcast', 'escalate', 'note'];

/** The login GitHub Actions comments are posted as (the referee); trusted for any `from` (verifyComment). */
const REFEREE_LOGIN = 'github-actions[bot]';

const COMMAND_NAMES = ['claim', 'release', 'route', 'ping', 'handoff', 'block', 'unblock', 'hold', 'unhold', 'triage', 'escalate', 'priority', 'size', 'kind'];

/* ------------------------------------------------------------------ labels */

/** @param {string} s @returns {string} */
const statusLabel = (s) => `status:${s}`;
/** @param {string} h @returns {string} */
const toLabel = (h) => `to:${h}`;
/** @param {string} h @returns {string} */
const pingLabel = (h) => `ping:${h}`;
/** @param {string} k @returns {string} */
const kindLabel = (k) => `kind:${k}`;
/** @param {string} p @returns {string} */
const priorityLabel = (p) => `priority:${p}`;
/** @param {string} s @returns {string} */
const sizeLabel = (s) => `size:${s}`;

/**
 * Parse label names into protocol state. For single-valued namespaces the last
 * label wins and every clash is reported in `conflicts`. Unknown values for
 * status/kind/priority/size are left in `other`.
 * @param {string[]} names
 * @returns {{status: ?string, to: ?string, pings: string[], kind: ?string, priority: ?string, size: ?string,
 *   humanOnly: boolean, external: boolean, other: string[], conflicts: Object<string,string[]>}}
 */
function parseLabels(names) {
  const out = { status: null, to: null, pings: [], kind: null, priority: null, size: null, humanOnly: false, external: false, other: [], conflicts: {} };
  const seen = { status: [], to: [], kind: [], priority: [], size: [] };
  const known = { status: STATUS, kind: KINDS, priority: PRIORITIES, size: SIZES };

  for (const raw of names || []) {
    const name = String(raw).toLowerCase();
    if (name === FLAG_LABELS.humanOnly) { out.humanOnly = true; continue; }
    if (name === FLAG_LABELS.external) { out.external = true; continue; }
    const i = name.indexOf(':');
    const ns = i > 0 ? name.slice(0, i) : '';
    const value = i > 0 ? name.slice(i + 1) : '';
    if (ns === 'ping' && value) {
      if (!out.pings.includes(value)) out.pings.push(value);
    } else if (ns === 'to' && value) {
      if (!seen.to.includes(value)) seen.to.push(value);
    } else if (known[ns] && known[ns].includes(value)) {
      if (!seen[ns].includes(value)) seen[ns].push(value);
    } else {
      out.other.push(raw);
    }
  }
  for (const ns of Object.keys(seen)) {
    const vals = seen[ns];
    if (vals.length) out[ns] = vals[vals.length - 1];
    if (vals.length > 1) out.conflicts[ns] = vals.slice();
  }
  return out;
}

/**
 * Return a new label array with every `<namespace>:*` label removed and, when
 * `value` is non-null, `<namespace>:<value>` appended.
 * @param {string[]} names
 * @param {string} namespace
 * @param {?string} value
 * @returns {string[]}
 */
function setNamespace(names, namespace, value) {
  const prefix = `${namespace}:`.toLowerCase();
  const kept = (names || []).filter((n) => !String(n).toLowerCase().startsWith(prefix));
  if (value !== null && value !== undefined) kept.push(`${namespace}:${value}`);
  return kept;
}

/**
 * The full label set a repository needs (PROTOCOL.md section 2).
 * Each entry is a handle (`aalhad`), an agent id (`aalhad/claude`), or a member
 * object from the config: a member yields its handle label plus one
 * `handle/agent` label per agent when it has more than one agent.
 * @param {(string|object)[]} entries
 * @returns {{name: string, color: string, description: string}[]}
 */
function standardLabels(entries) {
  const L = [];
  const add = (name, color, description) => L.push({ name, color, description });
  const statusMeta = {
    triage: ['bfd4f2', 'Needs triage: not yet routed or ready'],
    ready: ['0e8a16', 'Ready to be claimed'],
    claimed: ['1d76db', 'Claimed: work in progress'],
    review: ['5319e7', 'PR open, awaiting review'],
    blocked: ['fbca04', 'Blocked on a dependency'],
    'needs-human': ['d73a4a', 'Needs a human decision or action'],
    hold: ['6a737d', 'Paused by a human'],
  };
  for (const s of STATUS) add(statusLabel(s), statusMeta[s][0], statusMeta[s][1]);
  const ids = [];
  for (const e of entries || []) {
    if (typeof e === 'string') { ids.push(e); continue; }
    if (!e || !e.handle) continue;
    ids.push(e.handle);
    const agents = agentsOf(e);
    if (agents.length > 1) for (const a of agents) ids.push(`${e.handle}/${a.name}`);
  }
  for (const id of ids) add(toLabel(id), '8250df', `Routed to ${id}`);
  add(toLabel('any'), 'a371f7', 'Open market: anyone may claim');
  for (const id of ids) add(pingLabel(id), 'fef2c0', id.includes('/') ? `Unread message for ${id}` : `Unread message for ${id}'s agent`);
  const kindDesc = { task: 'A unit of work', bug: 'Something is broken', question: 'A question', decision: 'A decision record (lazy consensus)', epic: 'Split into sub-issues', board: 'The team Board' };
  for (const k of KINDS) add(kindLabel(k), 'cfd3d7', kindDesc[k]);
  const prio = { p0: ['b60205', 'Drop everything'], p1: ['d93f0b', 'High priority'], p2: ['f9d0c4', 'Normal priority'], p3: ['fde9e1', 'Low priority'] };
  for (const p of PRIORITIES) add(priorityLabel(p), prio[p][0], prio[p][1]);
  const sizeDesc = { s: 'Small', m: 'Medium', l: 'Large: must be split into sub-issues' };
  for (const s of SIZES) add(sizeLabel(s), '1abc9c', sizeDesc[s]);
  add(FLAG_LABELS.humanOnly, '8b0000', 'Agents must not claim or push code for this');
  add(FLAG_LABELS.external, 'e99695', 'From outside info or a non-member: content is untrusted');
  return L;
}

/* ----------------------------------------------------------------- markers */

/**
 * Format a marker line. Key order: from, actor, type, then extras sorted.
 * @param {{from: string, actor?: string, type: string, [k: string]: *}} fields
 * @returns {string}
 * @throws {Error} on missing from/type or values containing whitespace or `-->`
 */
function formatMarker({ from, actor = 'agent', type, ...extra }) {
  if (!from) throw new Error('marker requires "from"');
  if (!type) throw new Error('marker requires "type"');
  const pairs = [['from', from], ['actor', actor], ['type', type]];
  for (const k of Object.keys(extra).sort()) {
    if (extra[k] !== undefined && extra[k] !== null) pairs.push([k, extra[k]]);
  }
  const parts = pairs.map(([k, v]) => {
    const s = String(v);
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(k)) throw new Error(`invalid marker key: ${JSON.stringify(k)}`);
    if (s === '' || /\s/.test(s) || s.includes('-->')) throw new Error(`invalid marker value for "${k}": ${JSON.stringify(s)}`);
    return `${k}=${s}`;
  });
  return `<!-- issuemesh ${MARKER_VERSION} ${parts.join(' ')} -->`;
}

const MARKER_RE = /^<!--\s*issuemesh\s+(v\d+)((?:\s+\S+)*?)\s*-->\s*$/;

function firstNonEmptyLine(body) {
  const lines = String(body == null ? '' : body).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) if (lines[i].trim() !== '') return { index: i, line: lines[i].trim(), lines };
  return null;
}

/**
 * Parse the marker on the first non-empty line of a comment body.
 * Returns null when there is no marker, it is malformed (missing from/type or a
 * token that is not key=value), or its major version is not v1.
 * @param {string} body
 * @returns {?{version: string, from: string, actor: string, type: string, [k: string]: string}}
 */
function parseMarker(body) {
  const first = firstNonEmptyLine(body);
  if (!first) return null;
  const m = MARKER_RE.exec(first.line);
  if (!m || m[1] !== MARKER_VERSION) return null;
  const fields = {};
  for (const tok of m[2].trim().split(/\s+/).filter(Boolean)) {
    const eq = tok.indexOf('=');
    if (eq < 1) return null;
    fields[tok.slice(0, eq)] = tok.slice(eq + 1);
  }
  if (!fields.from || !fields.type) return null;
  const { from, actor, type, ...extra } = fields;
  return { version: m[1], from, actor: actor || 'agent', type, ...extra };
}

/**
 * Who wrote this comment: `agent` if it carries a valid marker, else `human`.
 * A valid marker with `actor=human` is reported as human.
 * @param {string} body
 * @returns {'agent'|'human'}
 */
function actorOf(body) {
  const m = parseMarker(body);
  if (!m) return 'human';
  return m.actor === 'human' ? 'human' : 'agent';
}

/** `aalhad/claude` -> `aalhad`; a plain handle is returned unchanged. */
function fromHandle(from) {
  return String(from === undefined || from === null ? '' : from).split('/')[0];
}

/** Human-readable sender: `aalhad/claude` for agent ids, `aalhad's agent` for plain handles. */
function senderName(from) {
  return String(from).includes('/') ? String(from) : `${from}'s agent`;
}

/** @param {string} from agent id or handle @returns {string} */
function signature(from) {
  return `<sub>🤖 ${senderName(from)} · IssueMesh</sub>`;
}

/**
 * Build a full agent comment: marker, body, signature.
 * @param {{from: string, type: string, body?: string, [k: string]: *}} msg
 * @returns {string}
 */
function composeMessage({ from, type, body = '', ...extra }) {
  return `${formatMarker({ from, type, ...extra })}\n${String(body).replace(/\s+$/, '')}\n\n${signature(from)}`;
}

/**
 * Update marker keys in place (e.g. bump `lease`, set `type=released`). A
 * `null`/`undefined` value removes the key. Throws when the body has no marker.
 * @param {string} body
 * @param {Object<string, *>} changes
 * @returns {string}
 */
function replaceMarker(body, changes) {
  const parsed = parseMarker(body);
  if (!parsed) throw new Error('replaceMarker: body has no valid issuemesh marker');
  const { version, ...fields } = parsed; // eslint-disable-line no-unused-vars
  for (const [k, v] of Object.entries(changes || {})) {
    if (v === null || v === undefined) delete fields[k];
    else fields[k] = v;
  }
  const first = firstNonEmptyLine(body);
  first.lines[first.index] = formatMarker(fields);
  return first.lines.join('\n');
}

/* ------------------------------------------------------------ attribution */

/**
 * Sender attribution (PROTOCOL.md section 3). A marker is verified iff the
 * comment author's GitHub login belongs to the member named by `fromHandle(from)`,
 * or the author is the referee (`github-actions[bot]`, trusted for any `from`).
 * An unverified marker is ignored: the comment is an ordinary human comment by
 * its real author.
 * @param {{body: string, user?: {login: string}}} comment
 * @param {object} config team config (members with `github` logins)
 * @returns {{verified: boolean, handle: ?string, agentId: ?string, actor: 'agent'|'human', marker: ?object, login: string}}
 *   `handle`/`agentId` are the verified sender (`agentId` is the marker's `from`); for an unmarked or unverified
 *   comment `handle` is the author's member handle (or null) and `agentId` is null. `marker` is non-null only when verified.
 */
function verifyComment(comment, config) {
  const login = (comment && comment.user && comment.user.login) || '';
  const author = memberByLogin(config, login);
  const marker = parseMarker(comment && comment.body);
  const human = { verified: false, handle: author ? author.handle : null, agentId: null, actor: 'human', marker: null, login };
  if (!marker) return human;
  const claimed = fromHandle(marker.from);
  const trusted = login.toLowerCase() === REFEREE_LOGIN || (author !== undefined && author.handle === claimed);
  if (!trusted) return human;
  return { verified: true, handle: claimed, agentId: marker.from, actor: marker.actor === 'human' ? 'human' : 'agent', marker, login };
}

/** The marker that counts: verified when `config` is given, plain parse otherwise (legacy callers and tests). */
function trustedMarker(comment, config) {
  return config ? verifyComment(comment, config).marker : parseMarker(comment && comment.body);
}

/* ---------------------------------------------------------- text scanning */

/**
 * Lines of `body` that are visible prose: outside ``` / ~~~ fenced code blocks
 * (an unclosed fence swallows the rest) and not block quotes.
 */
function proseLines(body) {
  const out = [];
  let fence = null; // { ch, len }
  for (const line of String(body == null ? '' : body).split(/\r?\n/)) {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (f && f[1][0] === fence.ch && f[1].length >= fence.len && line.trim() === f[1]) fence = null;
      continue;
    }
    if (f) { fence = { ch: f[1][0], len: f[1].length }; continue; }
    if (/^ {0,3}>/.test(line)) continue;
    out.push(line);
  }
  return out;
}

/* -------------------------------------------------------- slash commands */

const COMMAND_RE = new RegExp(`^/(${COMMAND_NAMES.join('|')})(?=\\s|$)(.*)$`);

/**
 * Extract slash commands: one per line, at the start of the line, ignoring
 * fenced code and quoted lines. Args are whitespace-split with leading `@` / `#`
 * stripped.
 * @param {string} body
 * @returns {{name: string, args: string[]}[]}
 */
function parseCommands(body) {
  const cmds = [];
  for (const line of proseLines(body)) {
    const m = COMMAND_RE.exec(line.replace(/\s+$/, ''));
    if (!m) continue;
    const args = m[2].split(/\s+/).filter(Boolean).map((a) => a.replace(/^[@#]+/, '')).filter(Boolean);
    cmds.push({ name: m[1], args });
  }
  return cmds;
}

const MENTION_RE = /(?<![A-Za-z0-9_@`])@([A-Za-z0-9][A-Za-z0-9-]{0,38})(?![A-Za-z0-9_@]|\/)/g;

/**
 * GitHub logins @mentioned in prose (not in code, not in quotes, not inside
 * e-mail addresses or team mentions). Lowercased and deduped, in order.
 * @param {string} body
 * @returns {string[]}
 */
function parseMentions(body) {
  const text = proseLines(body).join('\n').replace(/`[^`\n]*`/g, ' ');
  const seen = [];
  for (const m of text.matchAll(MENTION_RE)) {
    const login = m[1].replace(/-+$/, '').toLowerCase();
    if (login && !seen.includes(login)) seen.push(login);
  }
  return seen;
}

/* ----------------------------------------------------------------- claims */

/** ISO string (no ms, `Z`) for `now + minutes`. */
function leaseUntil(now, minutes) {
  return new Date(now.getTime() + minutes * 60000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function parseDate(s) {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** @returns {boolean} true when the claim has no lease or its lease is not in the future */
function isExpired(claim, now) {
  return !claim.lease || claim.lease.getTime() <= now.getTime();
}

function byId(a, b) { return a.id - b.id; }

/**
 * Claim records found in comments: marker comments of type claim/released, and
 * unmarked (human) comments containing `/claim`. A marker claim with a missing
 * or unparsable lease gets `lease: null` (never live). Human claims get
 * `lease = created_at + humanLeaseMinutes` and `handle = login` unless
 * `opts.resolveHandle(login)` maps it to a member handle. Returned in
 * comment-id order.
 *
 * `handle` is the member handle (`fromHandle(from)`); `agentId` is the marker's
 * full `from` (for human claims, the handle). With `opts.config`, markers are
 * only honoured when verified (verifyComment) and `/claim` from non-members is
 * ignored; without it the markers are trusted as written.
 * @param {{id:number, body:string, user:{login:string}, created_at:string}[]} comments
 * @param {{humanLeaseMinutes?: number, resolveHandle?: function(string): ?string, config?: object}} [opts]
 * @returns {{commentId:number, handle:string, agentId:string, actor:string, lease:?Date, type:string, login:string, createdAt:string}[]}
 */
function extractClaims(comments, opts = {}) {
  const humanMinutes = opts.humanLeaseMinutes == null ? 2880 : opts.humanLeaseMinutes;
  const out = [];
  for (const c of [...(comments || [])].sort(byId)) {
    const login = (c.user && c.user.login) || '';
    const marker = trustedMarker(c, opts.config);
    if (marker) {
      if (marker.type === 'claim' || marker.type === 'released') {
        out.push({ commentId: c.id, handle: fromHandle(marker.from), agentId: marker.from, actor: marker.actor, lease: parseDate(marker.lease), type: marker.type, login, createdAt: c.created_at });
      }
      continue;
    }
    if (opts.config && !memberByLogin(opts.config, login)) continue;
    if (parseCommands(c.body).some((x) => x.name === 'claim')) {
      const created = parseDate(c.created_at);
      const handle = (opts.resolveHandle && opts.resolveHandle(login)) || login;
      out.push({
        commentId: c.id,
        handle,
        agentId: handle,
        actor: 'human',
        lease: created ? new Date(created.getTime() + humanMinutes * 60000) : null,
        type: 'claim',
        login,
        createdAt: c.created_at,
      });
    }
  }
  return out;
}

/**
 * Claims that are live at `now`: type claim, lease in the future, and (for
 * human `/claim` comments) not followed by a later unmarked `/release` from the
 * same login. Marker claims are released by editing the marker, not by command.
 * @param {object[]} comments
 * @param {{now: Date, humanLeaseMinutes?: number, releasedHandles?: Iterable<string>,
 *   resolveHandle?: function(string): ?string, config?: object}} opts
 */
function liveClaims(comments, opts) {
  const { now, releasedHandles } = opts;
  const released = new Set(releasedHandles || []);
  const releases = [];
  for (const c of comments || []) {
    if (trustedMarker(c, opts.config)) continue;
    if (parseCommands(c.body).some((x) => x.name === 'release')) releases.push({ id: c.id, login: ((c.user && c.user.login) || '').toLowerCase() });
  }
  return extractClaims(comments, opts).filter((cl) => {
    if (cl.type !== 'claim' || isExpired(cl, now) || released.has(cl.handle)) return false;
    if (cl.actor === 'human') {
      const login = cl.login.toLowerCase();
      if (releases.some((r) => r.login === login && r.id > cl.commentId)) return false;
    }
    return true;
  });
}

/**
 * Arbitration (PROTOCOL.md 4.2): lowest comment id among live claims wins.
 * @returns {{winner: ?object, losers: object[]}}
 */
function arbitrate(comments, opts) {
  const live = liveClaims(comments, opts).sort((a, b) => a.commentId - b.commentId);
  return { winner: live[0] || null, losers: live.slice(1) };
}

/* ------------------------------------------------------------- loop guard */

/**
 * Trailing run of agent comments (newest backwards, stopping at the first human).
 * `handles` holds the senders' agent ids (`from`). With `opts.config` only
 * verified markers count as agent comments; a forged marker is a human comment.
 * @param {{id?:number, body:string, user?:{login:string}}[]} comments
 * @param {{config?: object}} [opts]
 * @returns {{length: number, handles: Set<string>}}
 */
function agentStreak(comments, opts = {}) {
  const list = [...(comments || [])];
  if (list.every((c) => typeof c.id === 'number')) list.sort(byId);
  const handles = new Set();
  let length = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    const marker = trustedMarker(list[i], opts.config);
    if (!marker || marker.actor === 'human') break;
    length++;
    handles.add(marker.from);
  }
  return { length, handles };
}

/** @returns {boolean} true when agents must stop replying (PROTOCOL.md section 8) */
function loopGuardTripped(comments, maxStreak, opts = {}) {
  const { length, handles } = agentStreak(comments, opts);
  return length >= maxStreak && handles.size >= 2;
}

/* ------------------------------------------------------------------ inbox */

const BUCKETS = ['mailbox', 'active', 'review', 'routed', 'triage', 'market'];

function labelNames(item) {
  return (item.labels || []).map((l) => (typeof l === 'string' ? l : l && l.name)).filter(Boolean);
}

function priorityRank(p) {
  const i = PRIORITIES.indexOf(p || 'p2');
  return i < 0 ? 2 : i;
}

function time(s) {
  const t = Date.parse(s);
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Does a `to:` / `ping:` label value address this agent of `member`?
 * `<handle/name>` addresses exactly that agent. A bare `<handle>` addresses
 * every agent of the member for `kind` "to" (any may claim) but only the
 * primary agent for `kind` "ping" (the mailbox rule, PROTOCOL.md section 6).
 * @param {string} value label value (after the colon)
 * @param {object} member
 * @param {?string} agentName the agent's name (null for a member without agents)
 * @param {'to'|'ping'} [kind]
 * @returns {boolean}
 */
function targetsAgent(value, member, agentName, kind = 'to') {
  const v = String(value === undefined || value === null ? '' : value).toLowerCase();
  const slash = v.indexOf('/');
  if (slash < 0) {
    if (v !== member.handle) return false;
    if (kind === 'to') return true;
    const agents = agentsOf(member);
    return agents.length === 0 || agents[0].name === agentName;
  }
  return v.slice(0, slash) === member.handle && v.slice(slash + 1) === agentName;
}

/**
 * Order the items needing an agent's attention (PROTOCOL.md section 6).
 * Buckets: 1 mailbox, 2 active, 3 review, 4 routed, 5 triage (triager on duty
 * only, primary agent only), 6 market (only under WIP and not human-only). Each
 * item appears once, in its lowest bucket. Within a bucket: priority (p0 first,
 * none = p2), then oldest first; the `active` bucket is newest-activity first
 * after priority.
 *
 * `agent` is the name of the agent the inbox is for (default: the member's
 * primary agent). Mailbox: `ping:<handle/agent>` is for that agent,
 * `ping:<handle>` for the primary agent only. Review/routed: `to:<handle>` and
 * `to:<handle/agent>` both match. WIP is the agent's own `wip`.
 * @param {object[]} items {number,title,labels,assignees,isPR,createdAt,updatedAt,url}
 * @param {{me: object, config: object, now: Date, myLiveClaimCount?: number, agent?: string}} ctx
 * @returns {object[]} items with `bucket`, `bucketName`, `reason`
 */
function classifyInbox(items, { me, config, now, myLiveClaimCount = 0, agent }) {
  const agents = agentsOf(me);
  if (!agents.length) return [];
  const mine = agent ? agents.find((a) => a.name === agent) : agents[0];
  if (!mine) return [];
  const isPrimary = mine === agents[0];
  const login = String(me.github || '').toLowerCase();
  const wip = mine.wip != null ? mine.wip : 2;
  const onDuty = isPrimary && triagerOnDuty(config, now) === me.handle;
  const out = [];

  for (const item of items || []) {
    const L = parseLabels(labelNames(item));
    const assignedToMe = (item.assignees || []).some((a) => String(a).toLowerCase() === login);
    const ping = L.pings.find((v) => targetsAgent(v, me, mine.name, 'ping'));
    const toMe = L.to && L.to !== 'any' && targetsAgent(L.to, me, mine.name, 'to');
    let bucket = 0;
    let reason = '';

    if (ping) { bucket = 1; reason = `labelled ${pingLabel(ping)}`; }
    else if (assignedToMe && L.status === 'claimed') { bucket = 2; reason = 'assigned to you with status:claimed'; }
    else if (item.isPR && toMe && L.status === 'review') { bucket = 3; reason = `review requested (${toLabel(L.to)})`; }
    else if (toMe && L.status === 'ready') { bucket = 4; reason = `routed to you (${toLabel(L.to)})`; }
    else if (L.status === 'triage' && onDuty) { bucket = 5; reason = 'triage duty: you are on duty'; }
    else if (L.to === 'any' && L.status === 'ready' && !L.humanOnly && myLiveClaimCount < wip) {
      bucket = 6;
      reason = `open market (${toLabel('any')}), ${myLiveClaimCount}/${wip} claims held`;
    }
    if (!bucket) continue;
    out.push({ ...item, bucket, bucketName: BUCKETS[bucket - 1], reason, _prio: priorityRank(L.priority) });
  }

  out.sort((a, b) => {
    if (a.bucket !== b.bucket) return a.bucket - b.bucket;
    if (a._prio !== b._prio) return a._prio - b._prio;
    if (a.bucket === 2) {
      const d = time(b.updatedAt) - time(a.updatedAt);
      if (d) return d;
    }
    return time(a.createdAt) - time(b.createdAt) || a.number - b.number;
  });
  return out.map(({ _prio, ...rest }) => rest);
}

module.exports = {
  MARKER_VERSION,
  STATUS,
  KINDS,
  PRIORITIES,
  SIZES,
  FLAG_LABELS,
  MESSAGE_TYPES,
  statusLabel,
  toLabel,
  pingLabel,
  kindLabel,
  priorityLabel,
  sizeLabel,
  parseLabels,
  setNamespace,
  standardLabels,
  formatMarker,
  parseMarker,
  actorOf,
  REFEREE_LOGIN,
  fromHandle,
  senderName,
  verifyComment,
  targetsAgent,
  signature,
  composeMessage,
  replaceMarker,
  parseCommands,
  parseMentions,
  extractClaims,
  liveClaims,
  arbitrate,
  leaseUntil,
  isExpired,
  agentStreak,
  loopGuardTripped,
  classifyInbox,
};
