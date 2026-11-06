'use strict';

/**
 * Plan: accumulates actions for one issue while tracking the label set that
 * would result, so later steps (and several slash commands in one comment) see
 * earlier ones. The executor still re-checks live state, so a Plan may emit
 * redundant label actions safely.
 */

const P = require('../lib/protocol');

class Plan {
  /**
   * @param {number} issue issue (or PR) number
   * @param {string[]} labels current label names
   * @param {string[]} [assignees] current assignee logins
   */
  constructor(issue, labels, assignees = []) {
    this.issue = issue;
    this.labels = new Set(labels);
    this.assignees = new Set(assignees.map((a) => a.toLowerCase()));
    this.actions = [];
  }

  /** Parsed protocol view of the working label set. */
  get state() { return P.parseLabels([...this.labels]); }

  has(label) {
    const l = label.toLowerCase();
    return [...this.labels].some((x) => x.toLowerCase() === l);
  }

  addLabel(label) {
    if (this.has(label)) return this;
    this.labels.add(label);
    this.actions.push({ type: 'addLabels', issue: this.issue, labels: [label] });
    return this;
  }

  removeLabel(label) {
    const l = label.toLowerCase();
    const found = [...this.labels].find((x) => x.toLowerCase() === l);
    if (!found) return this;
    this.labels.delete(found);
    this.actions.push({ type: 'removeLabel', issue: this.issue, label: found });
    return this;
  }

  /** Make `<ns>:<value>` the only label of its namespace (value null removes all). */
  setNs(ns, value) {
    const prefix = `${ns}:`;
    const target = value == null ? null : `${ns}:${value}`;
    for (const l of [...this.labels]) {
      if (l.toLowerCase().startsWith(prefix) && (target === null || l.toLowerCase() !== target.toLowerCase())) this.removeLabel(l);
    }
    if (target) this.addLabel(target);
    return this;
  }

  assign(logins) {
    const add = logins.filter((l) => !this.assignees.has(l.toLowerCase()));
    if (add.length) {
      add.forEach((l) => this.assignees.add(l.toLowerCase()));
      this.actions.push({ type: 'addAssignees', issue: this.issue, assignees: add });
    }
    return this;
  }

  unassign(logins) {
    const rem = logins.filter((l) => this.assignees.has(l.toLowerCase()));
    if (rem.length) {
      rem.forEach((l) => this.assignees.delete(l.toLowerCase()));
      this.actions.push({ type: 'removeAssignees', issue: this.issue, assignees: rem });
    }
    return this;
  }

  comment(body) {
    this.actions.push({ type: 'createComment', issue: this.issue, body });
    return this;
  }

  updateComment(commentId, body) {
    this.actions.push({ type: 'updateComment', issue: this.issue, commentId, body });
    return this;
  }

  log(message) {
    this.actions.push({ type: 'log', level: 'info', message: `#${this.issue}: ${message}` });
    return this;
  }
}

module.exports = { Plan };
