---
name: decision
description: Run an IssueMesh decision - open a kind:decision issue with a steelmanned alternative, act as the required critic on someone else's decision, or close one by lazy consensus after the window.
when_to_use: When a choice affects more than one member, when a kind:decision issue is routed to you for critique, or when a decision's window has elapsed.
argument-hint: "new <topic> | critique <issue> | close <issue>"
disable-model-invocation: true
allowed-tools: Bash, Read, Grep, Glob
---

# /issuemesh:decision

Follow `issuemesh:protocol` and PROTOCOL §9.5 and §11. Arguments: `$ARGUMENTS`
(`new <topic>`, `critique <n>`, `close <n>`; none = infer from the inbox).

## new: propose
1. Search first: `gh issue list --state all --label kind:decision --search "<terms>" --limit 10`. Do not duplicate.
2. Gather facts you can verify (code, benchmarks, docs) and keep receipts (`path:line`, command + output).
3. Create the issue (`gh issue create --label kind:decision,status:triage --title "[Decision] ..." --body-file f`) with these sections:
   - **Context**: the problem that forces a decision now.
   - **Options**: 2-3 realistic ones with trade-offs.
   - **Proposal**: which option and why.
   - **Strongest alternative (steelman)**: the best case for the option you did not choose, argued as its advocate would. If you cannot write it well, you do not understand the decision yet.
   - **What evidence would change this decision**: concrete, observable.
   - **Deadline** (optional) and the window (`decision_window_hours`).
4. Ask a *different* member's agent for the critique: `mesh route <n> <handle>` (or `mesh ping <n> <handle>`; add `/<agent>` to target one agent). You are not the critic of your own proposal. The window is only meaningful after the critique is posted.

## critique: be the required critic
Only if you are a different member from the proposer. Read the issue body, then the code/facts it relies on yourself (do not trust its assertions; PROTOCOL §9.2).
Post one comment: `mesh post <n> --type review --verdict comment --body "..."` containing:
- **Weakest assumption**: the one most likely to be wrong, and how to check it.
- **Likeliest failure mode**: how this proposal fails in practice, with a scenario.
- **Disconfirming evidence**: what you looked for that would sink it, and what you found (receipts). Or what evidence would change your mind.
- **Verdict**: support, support with changes, or object (and why). Object with 👎 only for new evidence or a real flaw, not taste.
If the proposal has no steelman or no change-criteria, say so and ask for them (`type=ask`) before the window counts down. `mesh ack <n>` afterwards.

## close: lazy consensus
1. Preconditions: critique exists; `decision_window_hours` have passed since the last edit of the proposal (check timestamps, not your clock); the issue is not `human-only`/`hold`. `human-only` decisions need an explicit human 👍 first; otherwise stop.
2. Count objections: any member 👎 or objecting comment since the proposal => not accepted. Read `gh api repos/{owner}/{repo}/issues/<n>/reactions` and the comments.
3. No objection: `mesh post <n> --type note --body "Accepted by lazy consensus. Decision: <one line>. Critique addressed: <how>."`, then `gh issue close <n> --reason completed`. Create follow-up task issues for implementation (`issuemesh:new`).
4. Objection: do not close. Summarise the disagreement in one comment, tag the two positions' owners with `mesh ping`, and extend only if new evidence appears. Unresolved after one round: `mesh escalate <n> --body "<options + recommended default>"`.
5. Rejected or superseded: `gh issue close <n> --reason "not planned"` with a one-line reason.

## Do not
- Do not accept without a critique, or close your own proposal alone if anyone objected.
- Do not flip your recommendation because the critic pushed; only for new evidence, and say which.
- Do not make a decision for things one member can decide alone; use a normal issue.
