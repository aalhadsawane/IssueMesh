#!/bin/sh
# IssueMesh Stop hook: OPT-IN autopilot (ISSUEMESH_AUTOPILOT=1).
# When Claude is about to stop and the inbox holds a new item, block the stop once
# so the session keeps working, at most ISSUEMESH_AUTOPILOT_MAX (default 3) times
# per session. Never fails the session: always exits 0, silent when off.

input=$(cat 2>/dev/null)

# Opt-out: ISSUEMESH_HOOKS=0 turns this hook off for you.
[ "${ISSUEMESH_HOOKS:-}" = "0" ] && exit 0

[ "${ISSUEMESH_AUTOPILOT:-}" = "1" ] || exit 0
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

# stop_hook_active=true: Claude is already continuing because of a stop hook.
active=$(printf '%s' "$input" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);
process.stdout.write(j.stop_hook_active===true?"1":"0")}catch(e){process.stdout.write("0")}})' 2>/dev/null)
[ "$active" = "1" ] && exit 0

sid=$(printf '%s' "$input" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);
process.stdout.write(String(j.session_id||"").replace(/[^A-Za-z0-9_-]/g,"_").slice(0,64))}catch(e){}})' 2>/dev/null)
[ -n "$sid" ] || exit 0

cd "$root" 2>/dev/null || exit 0
gitdir=$(git rev-parse --git-dir 2>/dev/null) || exit 0
dir="$gitdir/issuemesh"
mkdir -p "$dir" 2>/dev/null || exit 0
file="$dir/autopilot-$sid"

max="${ISSUEMESH_AUTOPILOT_MAX:-3}"
case "$max" in ''|*[!0-9]*) max=3 ;; esac
count=$(cat "$file" 2>/dev/null)
case "$count" in ''|*[!0-9]*) count=0 ;; esac
[ "$count" -lt "$max" ] || exit 0

if command -v timeout >/dev/null 2>&1; then
  summary=$(timeout 5 "$mesh" inbox -q --new-only --min-interval 10 2>/dev/null)
else
  summary=$("$mesh" inbox -q --new-only --min-interval 10 2>/dev/null)
fi
[ $? -eq 0 ] || exit 0
[ -n "$summary" ] || exit 0

printf '%s\n' $((count + 1)) >"$file" 2>/dev/null

printf '%s' "$summary" | node -e '
let s = "";
process.stdin.on("data", d => s += d).on("end", () => {
  try {
    const line = s.trim().split("\n")[0].slice(0, 400).replace(/\bmailbox\b/g, "ping");
    if (!line) return;
    const reason = "IssueMesh: " + line + " (GitHub issues/PRs in this repo that need you: pings, reviews, assigned work). Run /issuemesh:work (stay within the session budget).";
    process.stdout.write(JSON.stringify({ decision: "block", reason }));
  } catch (e) { /* silent */ }
});' 2>/dev/null
exit 0
