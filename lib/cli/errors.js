'use strict';

class CliError extends Error {
  constructor(message, code = 1) { super(message); this.name = 'CliError'; this.code = code; }
}
/** exit 2 */
class UsageError extends CliError {
  constructor(message) { super(message, 2); this.name = 'UsageError'; }
}
/** exit 3: lost claim race / precondition failed */
class PreconditionError extends CliError {
  constructor(message) { super(message, 3); this.name = 'PreconditionError'; }
}

module.exports = { CliError, UsageError, PreconditionError };
