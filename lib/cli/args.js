'use strict';

const { UsageError } = require('./errors');

const GLOBAL_SPEC = {
  boolean: ['json', 'dry-run', 'help'],
  string: ['repo', 'as', 'actor'],
  alias: { h: 'help' },
};

function mergeSpec(spec = {}) {
  return {
    boolean: [...GLOBAL_SPEC.boolean, ...(spec.boolean || [])],
    string: [...GLOBAL_SPEC.string, ...(spec.string || [])],
    multi: [...(spec.multi || [])],
    alias: { ...GLOBAL_SPEC.alias, ...(spec.alias || {}) },
  };
}

/**
 * Minimal argv parser. `--flag value`, `--flag=value`, `-q`, `--` terminator.
 * Returns { _: positional[], flags: {name: value} }. Unknown flags throw.
 */
function parseArgs(argv, spec) {
  const s = mergeSpec(spec);
  const bool = new Set(s.boolean);
  const str = new Set(s.string);
  const multi = new Set(s.multi);
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const t = String(argv[i]);
    if (t === '--') { pos.push(...argv.slice(i + 1)); break; }
    let name = null;
    let inline;
    if (t.startsWith('--')) {
      const eq = t.indexOf('=');
      name = eq > 0 ? t.slice(2, eq) : t.slice(2);
      if (eq > 0) inline = t.slice(eq + 1);
    } else if (/^-[A-Za-z]$/.test(t)) {
      name = s.alias[t[1]];
      if (!name) throw new UsageError(`unknown flag ${t}`);
    } else {
      pos.push(t);
      continue;
    }
    if (bool.has(name)) {
      flags[name] = inline === undefined ? true : !/^(false|0|no)$/i.test(inline);
    } else if (str.has(name) || multi.has(name)) {
      let v = inline;
      if (v === undefined) {
        if (i + 1 >= argv.length) throw new UsageError(`flag --${name} needs a value`);
        v = String(argv[++i]);
      }
      if (multi.has(name)) (flags[name] = flags[name] || []).push(v);
      else flags[name] = v;
    } else {
      throw new UsageError(`unknown flag --${name}`);
    }
  }
  return { _: pos, flags };
}

module.exports = { parseArgs, mergeSpec, GLOBAL_SPEC };
