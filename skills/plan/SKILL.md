---
name: plan
description: Turn human goals into an IssueMesh cycle - a milestone with epics split into size s/m tasks, each with testable acceptance criteria, routed to members.
when_to_use: When a human gives goals for a new cycle (hackathon, sprint, semester milestone) or asks to plan the next cycle. Triager on duty only, unless a human asks.
argument-hint: "<goals, or milestone title>"
disable-model-invocation: true
allowed-tools: Bash, Read, Grep, Glob
---

# /issuemesh:plan

Follow `issuemesh:protocol` and PROTOCOL §12. Goals: `$ARGUMENTS` (or the human's message).
Humans set goals and priorities; you propose the breakdown. Keep it short: fewer, clearer issues beat a long backlog.

1. **Read the goals, don't invent them.** Restate them in <= 5 lines with the cycle length and deadline. If a goal is ambiguous, ask the requesting human one batched question (in the conversation or on the issue they wrote), with options and a recommended default; otherwise proceed.
2. **Check what exists**: `gh issue list --state open --limit 100 --json number,title,labels` and the Board (`mesh board`). Reuse or re-label existing issues; do not duplicate.
3. **Create the milestone**: `gh api repos/{owner}/{repo}/milestones -f title="<name>" -f due_on=<ISO-8601> -f description="<goals>"`.
4. **Epics**: one `kind:epic` issue per goal (`gh issue create --milestone "<name>" --label kind:epic,status:triage`), body = goal, why, a checklist of child issues, and a "done when" in observable terms.
5. **Tasks**: split each epic into `size:s`/`size:m` tasks (`issuemesh:triage` rules): goal, testable acceptance criteria (command/test/URL), "Part of #<epic>", "Depends on #m" where order matters. Anything bigger than `m` splits again. Aim for 3-7 tasks per epic and put an explicit buffer of unscheduled capacity in.
6. **Route and prioritise**: `mesh label <n> --priority p1..p3 --size s|m`, then `mesh route <n> <handle|any>` using `areas`, member `skills` and `wip` (do not route more than about `wip` tasks at once to one member; leave the rest `to:any`). `p0` only if the human said so. Issues needing human judgement get `human-only`.
7. **Post the plan** as one Board comment: `mesh post <board_issue> --type note --body "<milestone, goals, epics with links, per-member load, risks, what is deliberately out of scope>"`, <= 40 lines. Humans edit priorities there; adjust labels when they do.

## Do not
- Do not put more work in the cycle than the team can finish; cut scope first, say what was cut.
- Do not create tasks without testable acceptance criteria or with size `l`.
- Do not `@mention` humans; the plan is reviewed from the Board.
