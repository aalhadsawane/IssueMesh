---
name: retro
description: Draft the IssueMesh milestone retro on the Board from gh data (cycle time, reopened issues, escalations, lost claim races, loop-guard trips, CI attempts) and propose changes as new triage issues; humans decide.
when_to_use: At milestone close, when a human asks for a retro, or when you are triager on duty and a milestone has no open issues left.
argument-hint: "<milestone title or number>"
disable-model-invocation: true
allowed-tools: Bash, Read, Grep, Glob
---

# /issuemesh:retro

Follow `issuemesh:protocol` and PROTOCOL §12. Milestone: `$ARGUMENTS` (if empty, the most
recently closed or fully-closed milestone: `gh api repos/{owner}/{repo}/milestones?state=all`). Only the triager on
duty drafts it (`mesh whoami`), unless a human asks. The retro is data plus proposals;
humans decide what changes.

## Gather (numbers with receipts, not impressions)
Let `M` be the milestone title. Use `--json` and compute with `jq`; keep the commands you ran.
1. Issues: `gh issue list --milestone "$M" --state all --limit 200 --json number,title,state,stateReason,createdAt,closedAt,labels`.
   - **Cycle time** per closed issue = `closedAt - createdAt`; report median and the 3 slowest.
   - **Dropped**: closed as not planned.
2. **Reopened**: for each issue, `gh api repos/{owner}/{repo}/issues/<n>/events --jq '[.[]|select(.event=="reopened")]|length'`.
3. For each issue read comments (`gh api repos/{owner}/{repo}/issues/<n>/comments --paginate`) and count markers:
   - **Escalations**: `type=escalate`; **lost-race claims**: `reason=lost-race`; **expired claims**: `reason=expired`.
   - **Loop-guard trips**: referee/agent notes mentioning the guard or `needs-human` set with 8 agent comments in a row.
   - **CI attempts**: the final `CI attempts: n` in the status comment; list issues with n >= 2.
   - **Ping-pong**: issues where the last 5 comments are all agent. Review rounds per PR (`type=review verdict=changes`).
4. Merged PRs: `gh pr list --search "milestone:\"$M\" is:merged" --json number,title`.

## Draft
Post one Board comment (`board_issue` from team.json; `mesh board post` only takes broadcast/standup, so use note): `mesh post <board_issue> --type note --body-file retro.md`, <= 60 lines:
- **Shipped** (links) and **dropped** (why).
- **Numbers**: the metrics above, each with its count and example issue links.
- **What went well / badly**: only claims you can back with a number or a link.
- **Proposals**: at most 5, each concrete (e.g. "raise `lease_minutes.agent` to 180: 4 expired claims on long test suites (#12 #15 ...)", "add criteria template line X to task.yml", "rotate triage weekly: 9 triage issues waited > 1 day"). Say what evidence would show it worked.

## Then
For each proposal create a normal issue: `gh issue create --label status:triage,kind:task --title "Retro: <change>" --body "From retro <link>. Evidence: ... Acceptance: ..."` (use `kind:decision` and `issuemesh:decision` when it changes team policy). Do not edit `team.json` or templates yourself. Do not `@mention` humans; ask for decisions in the retro comment's last line.

## Do not
- Do not invent metrics or smooth over bad numbers; no data = say "not measured".
- Do not blame members or agents by name; describe the process.
- Do not act on retro proposals before a human or lazy consensus approves them.
