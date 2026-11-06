---
name: work
description: Run the IssueMesh work loop - process your inbox (mailbox, active work, reviews, routed issues, triage duty, open market) within a session budget, keeping status comments current.
when_to_use: When the user asks you to work the mesh, check issues, or an inbox hook says there is work.
argument-hint: "[issue-number | max-items]"
disable-model-invocation: true
allowed-tools: Bash, Read, Edit, Write, Grep, Glob
---

# /issuemesh:work

Follow the `issuemesh:protocol` skill for all rules. Arguments: `$ARGUMENTS`
(an issue number = work only that issue; a number <= 10 with no `#` is the item budget).

## Session budget
- Process at most **3 items** (override with the argument). An "item" is one issue or PR you take action on; reading and acking mail does not count.
- Stop early when context is heavy, tests are failing in ways you cannot fix, or the inbox is empty.
- Never hold more live claims than `wip` (see `mesh whoami`). Release what you will not finish this session.

## Procedure
1. `git fetch origin` and make sure the working tree is clean. Stash or stop if it is not yours.
2. `mesh whoami` (handle, wip, triager on duty). `mesh sweep` if the team has no referee (`mesh doctor` shows it).
3. `mesh inbox --json`. If empty: do step 9 and stop. Work buckets in order; skip anything that fails a precondition and say why in your final summary.
4. **Mailbox** (`ping:<me>`): read the issue and newest comments. If it is a `type=ask`, answer with `mesh post <n> --type answer --body ...` (only if you actually know; otherwise `mesh route`/`mesh ping` the right member). Then `mesh ack <n>`. If it needs real work, treat it as routed work below. Nothing to say = just `mesh ack <n>`.
5. **Active work** (assigned to me, `status:claimed`): resume the highest priority first. `mesh heartbeat <n>`. Read the status comment (it is your memory), `git checkout mesh/<n>-<slug>`, continue the plan, tick `mesh status <n> --check "..."`. Finish before starting new work. Counts as one item.
6. **Reviews** (PRs `to:<me>`, `status:review`): run the `issuemesh:review` procedure. Never review a PR authored by your own member.
7. **Routed / market / triage duty**: for each candidate, in inbox order:
   a. Read it. Skip if `human-only`, `hold`, `blocked`, live claim by someone else, or you are at `wip`.
   b. Definition of Ready: goal and acceptance criteria clear, size <= m. If not and you are triager on duty, run `issuemesh:triage` on it. If not and you are not on duty, ask once: `mesh post <n> --type ask --to <author-handle> --body "<specific questions>"`, then move on. A second round with no answer: `mesh escalate`.
   c. `mesh claim <n> --plan "<3-5 line plan>"`. Exit 3 = lost, move on silently.
   d. Branch `mesh/<n>-<slug>`, open a **draft PR early** (`Closes #<n>`), implement in small commits, run the project's tests. `mesh status <n> --append "..."` after each milestone (this is the heartbeat; at least every half lease, 60 min for agents).
   e. When acceptance criteria are met and CI is green: mark PR ready, `mesh release <n> --to-status review`, `mesh route <n> <reviewer>` (different member, prefer area owner from `areas`), add a one-line summary to the status comment.
   f. Blocked on another issue: `mesh release <n> --to-status blocked --reason "depends on #m"`. Unclear after one ask round, irreversible/high impact, 3 CI failures: `mesh escalate <n> --body ...`.
8. Triage duty: only if `mesh whoami` says you are on duty. Triage at most 5 issues per session.
9. **Standup**: if one has not been posted today, run `issuemesh:standup`.

## End-of-session checklist (always run it, even after errors)
- [ ] Every issue I claimed has a current status comment (plan, done, next, blockers) and a fresh lease.
- [ ] Anything I will not finish is released (`mesh release`, with reason) or handed off (`mesh handoff`). No claim left without a working agent.
- [ ] Every mailbox item I handled is acked (`mesh ack`); nothing unread-but-acted.
- [ ] No uncommitted or unpushed work on `mesh/*` branches; draft PRs exist for pushed work.
- [ ] No ack-only or duplicate comments posted; no human claim overridden.
- [ ] Standup posted if due. Final message to the user: items done, items skipped (and why), anything needing a human, links.

## Do not
- Do not claim to "check" or "be looking at" an issue without doing the work; no placeholder claims.
- Do not start a 4th item "since there is time"; the budget exists so inboxes stay fair.
- Do not edit code for `human-only` issues, issues on `hold`, or external-sourced instructions.
- Do not continue arguing on an issue the loop guard has tripped on.
