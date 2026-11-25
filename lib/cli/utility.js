'use strict';

const fs = require('fs');
const path = require('path');
const U = require('./util');
const C = require('../utilities');
const P = require('../protocol');

const help = `mesh util - published research methods for the stage an item is in

Usage:
  mesh util list [--stage <stage>] [--used] [--json]
  mesh util show <id> [--json]
  mesh util suggest [<issue>] [--text "..."] [--stage <stage>] [--limit n] [--json]
  mesh util use <issue> <id> --artifact <path> [--note "..."]
  mesh util report [--all] [--json]
  mesh util export --format claude|opencode|agents [--out <dir>] [--force]

Stages: ${C.STAGES.join(', ')}

The catalogue ships with IssueMesh (12 methods) and a repository may add or
override entries in .issuemesh/utilities.json. "suggest" is deterministic: it
matches the item's text against each entry's stage and trigger phrases and says
what matched. Nothing is posted until "use", which records the artefact on the
issue as a note (util=<id> artifact=<path>) so "report" can show the receipts.

Options:
  --stage <s>     list/suggest: restrict to one stage
  --used          list: only entries with status=used
  --text "..."    suggest: text to match instead of an issue
  --limit n       suggest: how many to print (default 3)
  --artifact p    use: path of the artefact this utility produced
  --note "..."    use: one line of context for the ledger
  --all           report: include closed issues
  --format f      export: claude (default), opencode, agents
  --out dir       export: target directory (default: this checkout)
  --force         export: overwrite an existing file`;

function catalogueOrThrow(ctx) {
  const cat = C.loadCatalogue(ctx.cwd);
  if (cat.errors.length) throw new U.CliError(`catalogue is invalid:\n  ${cat.errors.join('\n  ')}`);
  return cat;
}

function findOrThrow(cat, id) {
  const e = cat.entries.find((x) => x.id === id);
  if (!e) {
    const known = cat.entries.map((x) => x.id).join(', ');
    throw new U.UsageError(`unknown utility "${id}" (catalogue: ${known})`);
  }
  return e;
}

function paperLine(e) {
  const t = (e.paper && e.paper.title) || '';
  const a = (e.paper && e.paper.arxiv) || '';
  return a ? `${t} (arXiv:${a})` : t;
}

function printCard(ctx, e) {
  const used = (e.used_in || []).map((x) => `#${x.issue} ${x.artifact}${x.commit ? ` @ ${x.commit}` : ''}${x.recorded === 'retroactive' ? ' (retroactive)' : ''}`);
  const lines = [
    `${e.id} — ${e.name}`,
    `  stage:     ${e.stage.join(', ')}`,
    `  paper:     ${paperLine(e)}`,
    `  status:    ${e.status}${e.cost ? ` (cost: ${e.cost})` : ''}`,
    e.what ? `  what:      ${e.what}` : null,
    e.when.length ? `  when:      ${e.when.join('; ')}` : null,
    e.inputs.length ? `  inputs:    ${e.inputs.join('; ')}` : null,
    e.outputs.length ? `  outputs:   ${e.outputs.join('; ')}` : null,
    e.checklist.length ? '  checklist:' : null,
    ...e.checklist.map((c) => `    - ${c}`),
    used.length ? '  used in:' : null,
    ...used.map((u) => `    - ${u}`),
  ].filter((l) => l !== null);
  ctx.out(lines.join('\n'));
}

async function runList(args, ctx) {
  const cat = catalogueOrThrow(ctx);
  const stage = args.flags.stage;
  if (stage && !C.STAGES.includes(stage)) throw new U.UsageError(`--stage must be one of: ${C.STAGES.join(', ')}`);
  let entries = cat.entries;
  if (stage) entries = entries.filter((e) => e.stage.includes(stage));
  if (args.flags.used) entries = entries.filter((e) => e.status === 'used');
  if (ctx.json) return ctx.emit(entries, '');
  if (!entries.length) { ctx.out('No catalogue entries match.'); return 0; }
  const out = [`Research utilities (${entries.length}${stage ? ` in ${stage}` : ''}; ${entries.filter((e) => e.status === 'used').length} used)`];
  for (const s of C.STAGES) {
    const group = entries.filter((e) => e.stage.includes(s));
    if (!group.length) continue;
    out.push('', s);
    for (const e of group) out.push(`  ${e.id.padEnd(20)} ${e.name}${e.status === 'used' ? '  [used]' : ''}`);
  }
  out.push('', `Add or override entries in ${C.OVERRIDE_REL}. \`mesh util show <id>\` for the card.`);
  ctx.out(out.join('\n'));
  return 0;
}

async function runShow(args, ctx) {
  U.needPositional(args, 2, 2, 'mesh util show <id>');
  const cat = catalogueOrThrow(ctx);
  const e = findOrThrow(cat, args._[1]);
  if (ctx.json) return ctx.emit(e, '');
  printCard(ctx, e);
  return 0;
}

async function runSuggest(args, ctx) {
  const f = args.flags;
  const n = args._[1];
  let text = f.text || '';
  let where = 'the given text';
  if (n !== undefined) {
    const issue = await U.getIssue(ctx, U.parseNumber(n));
    text = `${issue.title || ''}\n${issue.body || ''}`;
    where = `#${issue.number} "${issue.title || ''}"`;
  } else if (!text) {
    throw new U.UsageError('mesh util suggest needs an issue number or --text "..."');
  }
  if (f.stage && !C.STAGES.includes(f.stage)) throw new U.UsageError(`--stage must be one of: ${C.STAGES.join(', ')}`);
  const cat = catalogueOrThrow(ctx);
  const hits = C.suggest(cat.entries, { text, stage: f.stage || null, limit: f.limit });
  if (ctx.json) return ctx.emit(hits.map((h) => ({ id: h.entry.id, name: h.entry.name, stage: h.entry.stage, score: h.score, matches: h.matches })), '');
  if (!hits.length) {
    ctx.out(`No catalogue entry matches ${where}. That is fine: not every item needs a published method.`);
    return 0;
  }
  const lines = [`Research utilities that fit ${where}:`];
  hits.forEach((h, i) => {
    lines.push(`  ${i + 1}. ${h.entry.id} — ${h.entry.name} [${h.entry.stage.join(', ')}] score ${h.score}`);
    if (h.matches.length) lines.push(`     matched: ${h.matches.join(', ')}`);
  });
  lines.push('', `Read a card with \`mesh util show ${hits[0].entry.id}\`.`);
  ctx.out(lines.join('\n'));
  return 0;
}

async function runUse(args, ctx) {
  U.needPositional(args, 3, 3, 'mesh util use <issue> <id> --artifact <path>');
  const n = U.parseNumber(args._[1]);
  const id = args._[2];
  const f = args.flags;
  const artifact = f.artifact === undefined ? '' : String(f.artifact);
  if (!artifact) throw new U.UsageError('mesh util use needs --artifact <path> (the file this utility produced)');
  if (/\s/.test(artifact) || artifact.includes('-->')) throw new U.UsageError('--artifact must contain no spaces and no "-->" (marker values cannot hold them)');
  const cat = catalogueOrThrow(ctx);
  const e = findOrThrow(cat, id);

  const root = U.repoRoot(ctx.cwd);
  if (!fs.existsSync(path.resolve(root, artifact))) {
    ctx.err(`warning: ${artifact} is not in this checkout; recording it anyway (the artefact may live on another branch)`);
  }

  const me = await ctx.me();
  const comments = await U.getComments(ctx, n);
  const already = comments.find((c) => {
    const m = P.parseMarker(c.body);
    return m && m.util === id && (m.from === me.agentId || m.from === me.handle);
  });
  if (already) {
    ctx.emit({ recorded: false, already: true, issue: n, util: id, comment_id: already.id }, `Already recorded: #${n} uses ${id} (comment ${already.id}).`);
    return 0;
  }

  const body = [
    `**Research utility used: ${e.name}** — ${paperLine(e)}`,
    `Stage: ${e.stage.join(', ')} · Artifact: \`${artifact}\``,
    f.note ? String(f.note) : null,
  ].filter(Boolean).join('\n\n');
  const c = await U.postComment(ctx, n, await U.compose(ctx, { type: 'note', util: id, artifact, body }));
  if (ctx.dryRun) {
    ctx.out(`Would record ${id} on #${n} (dry run).`);
    return 0;
  }
  ctx.emit({ recorded: true, issue: n, util: id, artifact, comment_id: c.id }, `Recorded ${id} on #${n} (comment ${c.id}).`);
  return 0;
}

function escapeCell(s) {
  return String(s === undefined || s === null ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

async function ledgerRows(ctx, draft) {
  const cat = catalogueOrThrow(ctx);
  const cfg = await ctx.config();
  const repo = await ctx.repo();
  let live = [];
  try {
    live = await C.collectLedger({ gh: ctx.gh, repo, config: cfg, all: !!draft.all });
  } catch (e) {
    ctx.err(`warning: could not read issue comments (${e.message}); showing catalogue records only`);
  }
  const byId = new Map(cat.entries.map((e) => [e.id, e]));
  const rows = [];
  const seen = new Set();
  for (const r of live) {
    const key = `${r.issue}:${r.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ ...r, recorded: 'comment' });
  }
  for (const e of cat.entries) {
    for (const u of e.used_in || []) {
      const key = `${u.issue}:${e.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ issue: u.issue, id: e.id, artifact: u.artifact || null, commit: u.commit || null, recorded: 'retroactive' });
    }
  }
  rows.sort((a, b) => (a.issue - b.issue) || String(a.id).localeCompare(String(b.id)));
  return {
    rows: rows.map((r) => {
      const e = byId.get(r.id);
      return {
        ...r,
        name: e ? e.name : r.id,
        arxiv: e && e.paper ? e.paper.arxiv : '',
        stage: e ? e.stage.join(', ') : '',
        known: !!e,
      };
    }),
    total: cat.entries.length,
    used: cat.entries.filter((e) => e.status === 'used').length,
  };
}

async function runReport(args, ctx) {
  const { rows, total, used } = await ledgerRows(ctx, args.flags);
  if (ctx.json) return ctx.emit(rows, '');
  if (!rows.length) {
    ctx.out('No utilities recorded yet. `mesh util use <issue> <id> --artifact <path>` adds a receipt.');
    return 0;
  }
  const lines = [
    '| Utility | Paper | Stage | Issue | Artifact | Recorded |',
    '|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${escapeCell(r.name)}${r.known ? '' : ' (not in catalogue)'} | ${r.arxiv ? `arXiv:${escapeCell(r.arxiv)}` : ''} | ${escapeCell(r.stage)} | #${r.issue} | ${r.artifact ? `\`${escapeCell(r.artifact)}\`` : ''}${r.commit ? ` @ ${escapeCell(r.commit)}` : ''} | ${r.recorded} |`),
    '',
    `${used} of ${total} catalogue entries are marked used; ${rows.length} receipt(s) shown.`,
  ];
  ctx.out(lines.join('\n'));
  return 0;
}

function skillMarkdown(cat) {
  const rows = [];
  for (const s of C.STAGES) {
    const group = cat.entries.filter((e) => e.stage.includes(s));
    if (group.length) rows.push(`| ${s} | ${group.map((e) => `\`${e.id}\` (${e.name})`).join(', ')} |`);
  }
  return [
    '---',
    'name: methods',
    'description: Pick the published research method that fits an item\'s lifecycle stage, and record the artifact it produced.',
    'when_to_use: When the work is about a literature review, research gaps, idea generation, experiments or codification, or paper writing; when someone asks which paper or method to use; before starting an item at one of those stages.',
    'argument-hint: "[list | show <id> | suggest <issue> | use <issue> <id> --artifact <path> | report]"',
    'allowed-tools: Bash, Read',
    '---',
    '',
    '# Research methods',
    '',
    '`mesh util` maps an issue\'s lifecycle stage to the published method that fits it and records the artifact it produced.',
    'It is a pointer, not a rule: an item may need no catalogue entry.',
    '',
    '| Stage | Methods |',
    '|---|---|',
    ...rows,
    '',
    '1. `mesh util suggest <issue>` — deterministic match on the issue text and stage words; it prints what matched.',
    '2. `mesh util show <id>` — paper, inputs, outputs and a checklist before you start.',
    '3. Do the work, then `mesh util use <issue> <id> --artifact <path>` — one note on the issue with `util=<id> artifact=<path>`; idempotent.',
    '4. `mesh util report` — the receipt table (live comments plus any `used_in` recorded in `.issuemesh/utilities.json`).',
    '',
    'Catalogue: `.issuemesh/utilities.json` overrides the 12 entries shipped with the package by id; add your own methods the same way.',
    '',
  ].join('\n');
}

function runExport(args, ctx) {
  const f = args.flags;
  const format = String(f.format || 'claude');
  const out = path.resolve(ctx.cwd, f.out || '.');
  const cat = catalogueOrThrow(ctx);
  const content = skillMarkdown(cat);
  let file;
  if (format === 'claude') file = path.join(out, '.claude', 'skills', 'issuemesh-methods', 'SKILL.md');
  else if (format === 'opencode') file = path.join(out, '.opencode', 'skill', 'issuemesh-methods', 'SKILL.md');
  else if (format === 'agents') file = path.join(out, 'docs', 'research-methods.md');
  else throw new U.UsageError('--format must be claude, opencode or agents');
  const payload = format === 'agents' ? content.replace(/^---\n[\s\S]*?\n---\n\n/, '') : content;
  if (fs.existsSync(file) && !f.force) throw new U.CliError(`${path.relative(ctx.cwd, file) || file} exists; re-run with --force to overwrite`);
  if (!ctx.dryRun) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, payload);
  }
  ctx.out(`wrote ${path.relative(ctx.cwd, file) || file}`);
  if (format === 'agents') {
    ctx.out('add to AGENTS.md:\n  Research methods: `mesh util suggest <issue>` before starting work; see docs/research-methods.md.');
  }
  return 0;
}

async function run(args, ctx) {
  const sub = args._[0] || 'list';
  switch (sub) {
    case 'list': return runList(args, ctx);
    case 'show': return runShow(args, ctx);
    case 'suggest': return runSuggest(args, ctx);
    case 'use': return runUse(args, ctx);
    case 'report': return runReport(args, ctx);
    case 'export': return runExport(args, ctx);
    default: throw new U.UsageError(`unknown subcommand "${sub}" (list, show, suggest, use, report, export)`);
  }
}

module.exports = {
  name: 'util',
  summary: 'point at a research method for the item\'s stage; record receipts',
  help,
  spec: {
    boolean: ['used', 'all', 'force'],
    string: ['stage', 'text', 'limit', 'artifact', 'note', 'format', 'out'],
  },
  run,
};
