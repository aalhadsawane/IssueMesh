'use strict';

/** workflow_dispatch(task=setup): sync labels, create + pin a Board if none is open. */

const P = require('../../lib/protocol');
const { findBoard, createBoardActions } = require('./board');

module.exports = async function setup({ api, config }) {
  const actions = [{ type: 'syncLabels', labels: P.standardLabels(config.members.map((m) => m.handle)) }];
  const board = await findBoard(api, config);
  if (board) {
    actions.push({ type: 'log', level: 'info', message: `Board exists: #${board.number}` });
  } else {
    actions.push(...createBoardActions(
      'Created by `IssueMesh Referee` setup. Set `board_issue` in `.issuemesh/team.json` to this issue\'s number.',
      (created) => [{ type: 'log', level: 'notice', message: `Created Board #${created.number}: set "board_issue": ${created.number} in .issuemesh/team.json` }],
    ));
  }
  return actions;
};
