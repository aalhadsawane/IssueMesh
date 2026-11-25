'use strict';

/**
 * Research utilities: a small catalogue of published methods that map onto the
 * stages of a research item (literature review, gaps, ideation, codification,
 * writing), plus the helpers behind `mesh util`.
 *
 * The catalogue ships with the package (`defaults.json`); a repository may add
 * or override entries in `.issuemesh/utilities.json`. Overrides are partial:
 * `{ "id": "researchagent", "used_in": [...] }` only records usage and inherits
 * the rest. Usage itself is recorded in issue comments (`util=<id>
 * artifact=<path>`), not in a local file, so the ledger is attributable and
 * timestamped by GitHub.
 */

const fs = require('fs');
const path = require('path');
const P = require('../protocol');

const STAGES = ['literature-review', 'gaps', 'ideation', 'codification', 'writing'];
const STATUSES = ['used', 'available', 'not-applicable'];
const DEFAULTS_FILE = path.join(__dirname, 'defaults.json');
const OVERRIDE_REL = path.join('.issuemesh', 'utilities.json');

// Words that indicate the lifecycle stage of an item. Deliberately crude:
// a suggestion that can be explained beats a classifier that cannot.
const STAGE_HINTS = {
  'literature-review': ['literature review', 'related work', 'survey', 'state of the art', 'retrieval', 'bibliography'],
  gaps: ['research gap', 'gap', 'limitation', 'open problem', 'weakness', 'critique', 'novelty check'],
  ideation: ['idea', 'ideation', 'hypothesis', 'brainstorm', 'research problem', 'proposal'],
  codification: ['implement', 'implementation', 'experiment', 'baseline', 'benchmark', 'reproduce', 'codify', 'ablation'],
  writing: ['paper', 'abstract', 'introduction', 'conclusion', 'camera ready', 'submission'],
};

function arr(v) {
  if (v === undefined || v === null) return undefined;
  return Array.isArray(v) ? v.filter((x) => x !== undefined && x !== null) : [v];
}

function repoRoot(cwd) {
  let dir = path.resolve(cwd || '.');
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(cwd || '.');
    dir = parent;
  }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return e; }
}

/**
 * Validate one catalogue document.
 * @param {object} doc
 * @param {string} source  file name used in messages
 * @param {{partial?: boolean}} [opts] partial: fields may be omitted (an override entry)
 */
function validate(doc, source, { partial = false } = {}) {
  const errors = [];
  const warnings = [];
  const entries = [];
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { entries, errors: [`${source}: expected a JSON object`], warnings };
  }
  if (doc.version !== 1) errors.push(`${source}: "version" must be 1`);
  if (!Array.isArray(doc.utilities)) {
    errors.push(`${source}: "utilities" must be an array`);
    return { entries, errors, warnings };
  }
  const seen = new Set();
  for (const raw of doc.utilities) {
    if (!raw || typeof raw !== 'object') { errors.push(`${source}: entry is not an object`); continue; }
    const id = String(raw.id || '');
    if (!/^[a-z][a-z0-9-]*$/.test(id)) { errors.push(`${source}: id must be lower-case letters, digits and dashes (got ${JSON.stringify(raw.id)})`); continue; }
    if (seen.has(id)) { errors.push(`${source}: duplicate id "${id}"`); continue; }
    seen.add(id);

    const e = { id };
    if (raw.name !== undefined) e.name = String(raw.name);
    if (raw.stage !== undefined) {
      e.stage = arr(raw.stage) || [];
      if (!e.stage.length) errors.push(`${source}: ${id}: "stage" is empty`);
      for (const s of e.stage) if (!STAGES.includes(s)) errors.push(`${source}: ${id}: unknown stage "${s}" (allowed: ${STAGES.join(', ')})`);
    } else if (!partial) {
      errors.push(`${source}: ${id}: "stage" is required`);
    }
    if (raw.status !== undefined) {
      e.status = String(raw.status);
      if (!STATUSES.includes(e.status)) errors.push(`${source}: ${id}: unknown status "${e.status}" (allowed: ${STATUSES.join(', ')})`);
    }
    if (raw.paper !== undefined) {
      if (!raw.paper || typeof raw.paper !== 'object') errors.push(`${source}: ${id}: "paper" must be an object`);
      else {
        e.paper = { ...raw.paper };
        const arxiv = raw.paper.arxiv === undefined ? '' : String(raw.paper.arxiv);
        if (arxiv && !/^\d{4}\.\d{4,5}$/.test(arxiv)) warnings.push(`${source}: ${id}: unusual arXiv id "${arxiv}"`);
        e.paper.arxiv = arxiv;
      }
    }
    for (const k of ['what', 'cost']) if (raw[k] !== undefined) e[k] = String(raw[k]);
    for (const k of ['when', 'inputs', 'outputs', 'checklist']) if (raw[k] !== undefined) e[k] = (arr(raw[k]) || []).map(String);
    if (raw.used_in !== undefined) {
      e.used_in = (arr(raw.used_in) || []).filter((u) => {
        if (!u || typeof u !== 'object' || !Number.isInteger(Number(u.issue))) { errors.push(`${source}: ${id}: used_in needs {"issue": <number>, "artifact": "<path>"}`); return false; }
        return true;
      }).map((u) => ({ ...u, issue: Number(u.issue) }));
    }
    entries.push(e);
  }
  return { entries, errors, warnings };
}

/** Fill the fields every consumer can rely on. */
function finalize(e) {
  return {
    ...e,
    name: e.name || e.id,
    stage: e.stage || [],
    status: e.status || 'available',
    paper: { title: '', ...(e.paper || {}), arxiv: (e.paper && e.paper.arxiv) || '' },
    what: e.what || '',
    when: e.when || [],
    inputs: e.inputs || [],
    outputs: e.outputs || [],
    checklist: e.checklist || [],
    used_in: e.used_in || [],
    cost: e.cost || 'cpu',
  };
}

/**
 * Load the merged catalogue for a checkout: package defaults, overridden
 * field-by-field by `.issuemesh/utilities.json` by id.
 * @param {string} cwd
 * @returns {{entries: object[], errors: string[], warnings: string[], overrideFile: ?string}}
 */
function loadCatalogue(cwd) {
  const root = repoRoot(cwd);
  const defDoc = readJson(DEFAULTS_FILE);
  const def = defDoc instanceof Error
    ? { entries: [], errors: [`${DEFAULTS_FILE}: ${defDoc.message}`], warnings: [] }
    : validate(defDoc, 'defaults.json');

  const overrideFile = path.join(root, OVERRIDE_REL);
  const hasOverride = fs.existsSync(overrideFile);
  const ovDoc = hasOverride ? readJson(overrideFile) : { version: 1, utilities: [] };
  const ov = ovDoc instanceof Error
    ? { entries: [], errors: [`${OVERRIDE_REL}: ${ovDoc.message}`], warnings: [] }
    : validate(ovDoc, OVERRIDE_REL, { partial: true });

  const merged = new Map(def.entries.map((e) => [e.id, e]));
  for (const o of ov.entries) {
    const base = merged.get(o.id);
    if (!base) { merged.set(o.id, o); continue; }
    const next = { ...base };
    for (const [k, v] of Object.entries(o)) {
      if (v === undefined) continue;
      if (k === 'paper') next.paper = { ...(base.paper || {}), ...v };
      else if (k === 'used_in') next.used_in = [...(base.used_in || []), ...v];
      else next[k] = v;
    }
    merged.set(o.id, next);
  }

  const entries = [];
  const errors = [...def.errors, ...ov.errors];
  const warnings = [...def.warnings, ...ov.warnings];
  for (const e of merged.values()) {
    const f = finalize(e);
    if (!f.stage.length) { errors.push(`${OVERRIDE_REL}: ${f.id}: "stage" is required for an entry that is not in the package catalogue`); continue; }
    if (!f.paper.arxiv) warnings.push(`${f.id}: no arXiv id`);
    entries.push(f);
  }
  entries.sort((a, b) => (STAGES.indexOf(a.stage[0]) - STAGES.indexOf(b.stage[0])) || a.id.localeCompare(b.id));
  return { entries, errors, warnings, overrideFile: hasOverride ? overrideFile : null };
}

/** Stages mentioned in a piece of text, in catalogue order. */
function inferStages(text) {
  const t = String(text || '').toLowerCase();
  return STAGES.filter((s) => STAGE_HINTS[s].some((w) => t.includes(w)));
}

/**
 * Rank catalogue entries against an item's text. Deterministic, explainable:
 * each hit contributes its phrase to `matches`.
 * @param {object[]} entries
 * @param {{text?: string, stage?: string, limit?: number}} opts
 * @returns {{entry: object, score: number, matches: string[]}[]}
 */
function suggest(entries, { text = '', stage = null, limit = 3 } = {}) {
  const t = String(text || '').toLowerCase();
  const inferred = stage ? [stage] : inferStages(t);
  const scored = [];
  for (const e of entries) {
    let score = 0;
    const matches = [];
    const st = e.stage.filter((s) => inferred.includes(s));
    if (st.length) { score += 4; matches.push(`stage:${st[0]}`); }
    for (const phrase of e.when) {
      if (phrase && t.includes(phrase.toLowerCase())) { score += 2; matches.push(`"${phrase}"`); }
    }
    if (t.includes(e.name.toLowerCase()) || t.includes(e.id)) { score += 2; matches.push(`name:${e.name}`); }
    if (score > 0) scored.push({ entry: e, score, matches: matches.slice(0, 4) });
  }
  scored.sort((a, b) => (b.score - a.score) || a.entry.id.localeCompare(b.entry.id));
  return scored.slice(0, Math.max(1, Number(limit) || 3));
}

/**
 * Usage comments on issues: verified `type=note` markers carrying `util=`.
 * @param {{gh: object, repo: string, config: ?object, all?: boolean}} o
 */
async function collectLedger({ gh, repo, config, all = false }) {
  const issues = await gh.paginate(`repos/${repo}/issues?state=${all ? 'all' : 'open'}&sort=updated&direction=desc&per_page=100`);
  const rows = [];
  for (const iss of issues) {
    if (iss.pull_request || iss.comments === 0) continue;
    const comments = await gh.paginate(`repos/${repo}/issues/${iss.number}/comments?per_page=100`);
    for (const c of comments) {
      const v = config ? P.verifyComment(c, config) : { marker: P.parseMarker(c.body), verified: true };
      if (config && !v.verified) continue;
      const m = v.marker;
      if (!m || m.type !== 'note' || !m.util) continue;
      rows.push({
        issue: iss.number,
        id: m.util,
        artifact: m.artifact || null,
        from: m.from,
        comment_id: c.id,
        created_at: c.created_at,
      });
    }
  }
  return rows;
}

module.exports = {
  STAGES,
  STATUSES,
  STAGE_HINTS,
  DEFAULTS_FILE,
  OVERRIDE_REL,
  repoRoot,
  validate,
  loadCatalogue,
  inferStages,
  suggest,
  collectLedger,
};
