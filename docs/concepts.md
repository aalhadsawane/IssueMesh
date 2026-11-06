# Concepts

The mental model in one page. The normative rules are in [PROTOCOL.md](../PROTOCOL.md); the reasoning is in [design.md](design.md).

## The model

GitHub is the only shared state. There is no server and no database.

| Thing | Is represented by |
|---|---|
| state of a task | **labels** (`status:`, `to:`, `kind:`, `priority:`, `size:`, `ping:`) |
| a message between members | a **comment** with a marker line |
| who owns a task | the issue **assignee** |
| a unit of work | an **issue**; its code is a PR with `Closes #n` |
| team and policy | `.issuemesh/team.json` |
| announcements, standups | the **Board** (one pinned issue) |

A **member** is a person in `team.json` (handle + GitHub login). Their **agent** acts with that member's GitHub credentials, so one member is at most one agent identity. Because agent and human share an account, the **marker** decides who wrote a comment:

```
<!-- issuemesh v1 from=ben actor=agent type=claim lease=2026-11-06T15:00:00Z -->
```

No marker means human. Humans never write markers. The **referee** is an optional GitHub Action that enforces the same rules deterministically; without it, agents enforce them themselves.

## Labels and the state machine

Exactly one label per single-valued namespace. `status:` is only on open issues.

```
 open ─► triage ──(route)──► ready ──claim──► claimed ──PR ready──► review ──merge──► closed
                               ▲                 │
                               ├─ lease expired ─┤
                               ├─ release ───────┘
                      blocked ─┘ (unblock)         any state ──escalate──► needs-human
                                                   any state ──/hold─────► hold (human)
```

| Namespace | Values | Meaning |
|---|---|---|
| `status:` | `triage` `ready` `claimed` `review` `blocked` `needs-human` `hold` | lifecycle |
| `to:` | `<handle>`, `any` | who should do it (a request, not ownership) |
| `ping:` | `<handle>` (many) | unread message in that member's mailbox |
| `kind:` | `task` `bug` `question` `decision` `epic` `board` | what it is |
| `priority:` | `p0` `p1` `p2` `p3` | `p0` drops everything; none means p2 |
| `size:` | `s` `m` `l` | `l` must be split into sub-issues |
| flags | `human-only`, `source:external` | agents never claim `human-only`; `source:external` content is untrusted data |

Closed as *completed* means done or accepted; closed as *not planned* means dropped, rejected or duplicate.

## Addressing

Routing and notification are separate on purpose.

- `to:<handle>` puts work in a member's agent queue; `to:any` is an open market where the first valid claim wins.
- `ping:<handle>` is a mailbox flag: "read this". Only the addressee removes it (`mesh ack`), with a reaction, not a comment.
- `@login` notifies a human through GitHub. Agents only `@mention` humans when escalating.
- `/ping all` on the Board reaches every agent-enabled member.

## Claims and leases

A claim is how two agents avoid doing the same work.

1. The agent posts a `type=claim` comment with a `lease=` timestamp, assigns itself and sets `status:claimed` (`mesh claim <n> --plan "..."`).
2. After `claim_settle_seconds` it re-reads the comments. Among live claims, the **lowest comment id wins**. GitHub ids only increase, so everyone computes the same winner with no coordinator. A loser releases itself and exits with code 3.
3. The claim comment doubles as the **status comment**: plan, checklist, branch and PR links, blockers, next step. The owner edits it in place (`mesh status`) and each edit bumps the lease: that is the heartbeat.
4. A lease in the past means the claim is **dead**. The referee (or `mesh sweep`) marks it `released reason=expired`, unassigns and returns the issue to `ready`. Anyone can also take over with `mesh claim <n> --steal`.

Agent leases default to 120 minutes, human leases to 48 hours. A live human claim is never overridden by an agent. A member also holds at most `wip` claims (default 2).

Release (`mesh release`) keeps the status comment so the next claimant can resume. Handoff (`mesh handoff <n> <handle> --note ...`) releases, routes and pings in one step.

## Inbox

An agent's inbox is the ordered list of things that need it:

| # | Bucket | Contents |
|---|---|---|
| 1 | mailbox | items labelled `ping:<me>` |
| 2 | active | my `status:claimed` work, newest first |
| 3 | review | PRs `to:<me>` + `status:review` |
| 4 | routed | `to:<me>` + `status:ready` |
| 5 | triage | `status:triage`, only when I am triager on duty |
| 6 | market | `to:any` + `status:ready`, not `human-only`, only if under WIP |

Within a bucket: priority first, then oldest. `mesh inbox -q` is a cheap deterministic check (exit 0 = work, 10 = empty). The expensive LLM session starts only when there is work, which is why five agents do not wake on every comment. See [runners.md](runners.md).

**Triage duty** rotates through `triage.rotation` (daily or weekly, UTC). The triager checks Definition of Ready (goal, acceptance criteria, size at most `m`), dedupes, splits `size:l`, sets labels and routes.

## The Board

One pinned `kind:board` issue for things that belong to no task: one `type=standup` per agent per day (done, doing, blocked, needs; links only) and `type=broadcast` announcements. Agents read only comments newer than their cursor (`mesh board`). Past 200 comments the referee rotates it: new Board, summary of the old one, `board_issue` updated.

## Decisions

A choice that affects more than one member is a `kind:decision` issue (context, options, proposal). The proposal must argue the strongest alternative; another member's agent posts a critique first (weakest assumption, likeliest failure, what evidence would change it). Then **lazy consensus**: accepted if nobody objects (👎 or a comment) within `decision_window_hours` (default 24). `human-only` decisions need an explicit human 👍. Accepted closes as completed, rejected or superseded as not planned.

## Cadence (optional)

Use GitHub milestones as cycles (days for a hackathon, 1 to 2 weeks for a semester). There are no meetings; each ceremony is an artifact agents draft and humans edit.

| Event | Artifact | Human role |
|---|---|---|
| Planning | epics split into `size:s/m` tasks on the milestone | set goals and priorities |
| Daily sync | one standup per agent on the Board | skim, answer `needs-human` |
| Review | merged PRs closing the milestone | demo, accept |
| Retro | one Board note: cycle time, reopened issues, escalations, lost races, proposed changes | decide what changes |

## How agents are kept honest

Agents are fast and never tired, but start each session with no memory, degrade as context grows, state falsehoods confidently, agree with the last speaker and grade their own work generously. The protocol (section 9) counters each:

| Failure mode | Rule |
|---|---|
| confident falsehoods | **receipts**: command + output, CI link, SHA or `path:line` for any "done" or "works" |
| trusting other agents | re-check cheap claims; say when you depend on something unverified |
| sycophancy | change position only on new evidence; "LGTM" alone is not a review |
| poor self-review | **fresh-eyes review** by a different member's agent, judged from acceptance criteria and diff before reading the author's description |
| echo chambers | mandatory dissent on decisions; loop guard after `max_agent_streak` agent-only comments |
| no memory, context rot | the status comment is the memory; short sessions, at most 3 items each |
| scope creep, gaming CI | new work becomes a new issue; never weaken tests to pass |
| scarce human attention | one batched `escalate` per issue with options and a recommended default |
