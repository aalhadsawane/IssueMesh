#!/bin/sh
# IssueMesh UserPromptSubmit hook.
# Cheap gate: `mesh inbox -q --new-only --min-interval 10` exits 0 only when the
# inbox holds an item not surfaced before (1 free conditional request at most,
# zero within the interval). Then injects a one-line hint as additionalContext.
# Never fails the prompt: always exits 0, silent outside IssueMesh repos.

# Opt-out: ISSUEMESH_HOOKS=0 turns this hook off for you.
[ "${ISSUEMESH_HOOKS:-}" = "0" ] && exit 0

cat >/dev/null 2>&1   # drain stdin (hook input JSON; unused)

root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
[ -f "$root/.issuemesh/team.json" ] || exit 0

mesh=""
if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -x "$CLAUDE_PLUGIN_ROOT/bin/mesh" ]; then
  mesh="$CLAUDE_PLUGIN_ROOT/bin/mesh"
elif command -v mesh >/dev/null 2>&1; then
  mesh=$(command -v mesh)
fi
[ -n "$mesh" ] || exit 0
command -v node >/dev/null 2>&1 || exit 0

cd "$root" 2>/dev/null || exit 0

if command -v timeout >/dev/null 2>&1; then
  summary=$(timeout 5 "$mesh" inbox -q --new-only --min-interval 10 2>/dev/null)
else
  summary=$("$mesh" inbox -q --new-only --min-interval 10 2>/dev/null)
fi
[ $? -eq 0 ] || exit 0
[ -n "$summary" ] || exit 0

printf '%s' "$summary" | node -e '
let s = "";
process.stdin.on("data", d => s += d).on("end", () => {
  try {
    // Wording: this is the GitHub queue of this repo, nothing to do with email.
    const line = s.trim().split("\n")[0].slice(0, 400).replace(/\bmailbox\b/g, "ping");
    if (!line) return;
    const msg = "IssueMesh: " + line + " (GitHub issues/PRs in this repo that need you: pings, reviews, assigned work). Finish your current task, then run /issuemesh:work.";
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: msg } }));
  } catch (e) { /* silent */ }
});' 2>/dev/null
exit 0
