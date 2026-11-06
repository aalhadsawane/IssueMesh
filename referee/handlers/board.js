'use strict';

/** Board lookup and rotation (PROTOCOL.md section 9). */

const { Plan } = require('../plan');
const { refereeMessage } = require('../util');

const ROTATE_AFTER = 200;

/**
 * The current Board: `board_issue` if it is open, else the newest open
 * `kind:board` issue, else null.
 */
async function findBoard(api, config) {
  if (config.board_issue) {
    try {
      const issue = await api.getIssue(config.board_issue);
      if (issue.state === 'open' && !issue.pull_request) return issue;
    } catch (e) {
      if (!e || e.status !== 404) throw e;
    }
  }
  const open = await api.listOpenIssues('kind:board');
  return open[0] || null;
}

const boardBody = (intro) => `${intro}

The Board is for standups, broadcasts and questions that belong to no single issue.
Anything that needs tracking becomes its own issue; link it here.

- \`/ping all\` in a comment wakes every agent.
- Agents read only comments newer than their last read and post at most one standup a day.
- When the Board passes ${ROTATE_AFTER} comments the referee rotates it.

Protocol: https://github.com/aalhadsawane/issuemesh/blob/main/PROTOCOL.md`;

/** Actions that create a Board and pin it. */
function createBoardActions(intro, onCreated) {
  return [{
    type: 'createIssue',
    title: 'IssueMesh Board',
    body: boardBody(intro),
    labels: ['kind:board'],
    then: (created) => [{ type: 'pinIssue', nodeId: created.node_id }, ...(onCreated ? onCreated(created) : [])],
  }];
}

/** Rotate the Board when it has more than 200 comments. */
async function rotateBoard({ api, config }) {
  const board = await findBoard(api, config);
  if (!board || (board.comments || 0) <= ROTATE_AFTER) return [];
  const old = board;
  return createBoardActions(
    `Continues #${old.number} (${old.comments} comments), rotated by the referee. Set \`board_issue\` in \`.issuemesh/team.json\` to this issue's number; until then \`mesh\` resolves the newest open \`kind:board\` issue.`,
    (created) => {
      const plan = new Plan(old.number, []);
      plan.comment(refereeMessage('broadcast', `Board rotated: continue in #${created.number}.`));
      return [
        ...plan.actions,
        ...(old.node_id ? [{ type: 'unpinIssue', nodeId: old.node_id }] : []),
        { type: 'closeIssue', issue: old.number, reason: 'completed' },
      ];
    },
  );
}

module.exports = { findBoard, rotateBoard, createBoardActions, ROTATE_AFTER };
