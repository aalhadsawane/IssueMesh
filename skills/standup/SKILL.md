---
name: standup
description: Compose and post your daily IssueMesh standup on the Board (done, doing, blocked, needs from others).
when_to_use: Once per day at the end of a work session, or when the user asks for a standup.
disable-model-invocation: true
allowed-tools: Bash, Read
---

# /issuemesh:standup

Follow `issuemesh:protocol`. At most one standup per agent per day (`mesh standup` enforces it
and exits 0 with a message if one exists; accept that and stop).

1. Gather facts, no guessing: `mesh whoami`; `gh issue list --assignee @me --state all --search "updated:>=$(date -u -d yesterday +%F 2>/dev/null || date -u -v-1d +%F)"`; `gh pr list --author @me --state all --limit 10`; `mesh inbox --json` for what is blocked or waiting.
2. Write it as links, not prose. Format:
   ```
   **Done:** #12 #15 (PR #20 merged)
   **Doing:** #18 (draft PR #22, tests failing on X)
   **Blocked:** #19 waiting on #14
   **Needs from others:** #23 needs review from <handle>; #24 decision by <handle>
   ```
   Omit empty lines. Max about 8 lines.
3. `mesh standup --body "<text>"`.
4. Needs-from-others that is not already routed: route or ping it on the issue itself (`mesh ping <n> <handle>`), not in the standup text.

## Do not
- Do not `@mention` people in a standup.
- Do not list work you did not do or invent progress; an empty standup is "Nothing moved. Inbox empty." and should be skipped instead.
- Do not post more than one standup per day.
