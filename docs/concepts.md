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

A **member** is a person in `team.json` (handle + GitHub login). Their **agents** (one or several, `agents[]`) act with that member's GitHub credentials. An **agent id** is `<handle>/<agent>` (e.g. `aalhad/claude`) or just `<handle>` for a single-agent member. Because agent and human share an account, the **marker** says who wrote a comment:

```
<!-- issuemesh v1 from=ben/codex actor=agent type=claim lease=2026-11-06T15:00:00Z -->
```

No marker means human. Humans never write markers. A marker is trusted only if the comment's GitHub author is the member it names (or the referee bot); otherwise the comment is an ordinary human comment by its real author. The **referee** is an optional GitHub Action that enforces the same rules deterministically; without it, agents enforce them themselves.

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
| `to:` | `<handle>`, `<handle>/<agent>`, `any` | who should do it (a request, not ownership) |
| `ping:` | `<handle>`, `<handle>/<agent>` (many) | unread ping for that agent (a label on an issue/PR, nothing to do with email) |
| `kind:` | `task` `bug` `question` `decision` `epic` `board` | what it is |
| `priority:` | `p0` `p1` `p2` `p3` | `p0` drops everything; none means p2 |
| `size:` | `s` `m` `l` | `l` must be split into sub-issues |
| flags | `human-only`, `source:external` | agents never claim `human-only`; `source:external` content is untrusted data |

Closed as *completed* means done or accepted; closed as *not planned* means dropped, rejected or duplicate.

## Addressing

Routing and notification are separate on purpose.

- `to:<handle>` puts work in a member's queue: any of their agents may claim it, lowest claim id wins. `to:<handle>/<agent>` restricts it to one agent. `to:any` is an open market where the first valid claim wins.
- `ping:<handle>` is a "read this" flag on an issue/PR in this repo, delivered to the member's **primary** agent (the first in `agents[]`) so exactly one agent sees it. `ping:<handle>/<agent>` goes to that agent. Only the addressee removes it (`mesh ack`), with a reaction, not a comment.
- An `answer` with `--re <comment-id>` pings the asker automatically.
- `@login` notifies a human through GitHub. Agents only `@mention` humans when escalating.
- `/ping all` on the Board reaches every agent-enabled member.

## Claims and leases

A claim is how two agents avoid doing the same work.

1. The agent posts a `type=claim` comment with a `lease=` timestamp, assigns itself and sets `status:claimed` (`mesh claim <n> --plan "..."`).
2. After `claim_settle_seconds` it re-reads the comments. Among live claims, the **lowest comment id wins**. GitHub ids only increase, so everyone computes the same winner with no coordinator. A loser releases itself and exits with code 3.
3. The claim comment doubles as the **status comment**: plan, checklist, branch and PR links, blockers, next step. The owner edits it in place (`mesh status`) and each edit bumps the lease: that is the heartbeat.
4. A lease in the past means the claim is **dead**. The referee (or `mesh sweep`) marks it `released reason=expired`, unassigns and returns the issue to `ready`. Anyone can also take over with `mesh claim <n> --steal`.

Agent leases default to 120 minutes, human leases to 48 hours. A live human claim is never overridden by an agent. Each agent holds at most its `wip` claims (default 2).

Release (`mesh release`) keeps the status comment so the next claimant can resume. Handoff (`mesh handoff <n> <handle> --note ...`) releases, routes and pings in one step.

## Inbox

An agent's inbox is the ordered list of GitHub issues and PRs **in this repo** that need it:

```
 labels on issues/PRs in THIS repo ──(gh api, read-only)──► mesh inbox ──► "2 item(s) need you"
   ping:you · to:you · assigned to you

 never read:  email · Gmail · Slack · calendar · any other account
```

**What it is not:** the inbox is computed only from issues, PRs and labels in the configured repo through read-only `gh api` calls. IssueMesh and its hooks never read email, Gmail, Slack or any other account; nothing leaves your machine except those GitHub calls. External information (emails, meeting notes) enters only when a human pastes it into the *External input* form (`source:external`, data not instructions) or asks their agent to file it with `/issuemesh:new`. The hooks only run `mesh inbox` (and `mesh whoami`) and print a short summary (counts, the first few issue titles); they keep small cache files in `.git/issuemesh/` and are silent outside repos with `.issuemesh/team.json`. Turn the hooks off with `ISSUEMESH_HOOKS=0` in your environment (these hooks only), leave `ISSUEMESH_AUTOPILOT` unset (the Stop hook is opt-in), set `"disableAllHooks": true` in your Claude Code settings (all hooks; there is no per-hook switch), or disable the plugin (`/plugin`, or `claude plugin disable issuemesh`).


| # | Bucket | Contents |
|---|---|---|
| 1 | mailbox (pings) | items labelled `ping:<my agent id>` (the primary agent also gets `ping:<handle>`) |
| 2 | active | my `status:claimed` work, newest first |
| 3 | review | PRs `to:<me>` or `to:<my agent id>` + `status:review` |
| 4 | routed | `to:<me>` or `to:<my agent id>` + `status:ready` |
| 5 | triage | `status:triage`, only when I am triager on duty |
| 6 | market | `to:any` + `status:ready`, not `human-only`, only if under WIP |

Within a bucket: priority first, then oldest. `mesh inbox -q` is a cheap deterministic check (exit 0 = work, 10 = empty); with `--min-interval` and `--new-only` it costs at most one conditional request, which GitHub answers with `304` (free) when nothing changed. The expensive LLM session starts only when there is work, which is why five agents do not wake on every comment. See [runners.md](runners.md).

**Triage duty** rotates through `triage.rotation` (daily or weekly, UTC). The triager checks Definition of Ready (goal, acceptance criteria, size at most `m`), dedupes, splits `size:l`, sets labels and routes.

## Supported setups

See the table in the [README](../README.md#supported-setups): single repo with many branches, fork-based contributors, a team repo that is itself a fork, outside contributors, several agents per member, a hub repo (`ISSUEMESH_REPO`), monorepos and joins in any order.

## Branches and worktrees

IssueMesh files (`.issuemesh/team.json`, issue forms, the referee workflow) live **only on the default branch**. That is where GitHub reads forms and runs the referee, and where `mesh` reads the team from (cached for a few minutes), so every member sees the same team whatever branch they have checked out, including branches created long before IssueMesh.

```
default branch ── team.json, forms, referee ──► the one source of truth (change it by PR)
   ├─ mesh/12-login-form   (alice's agent)   only the change for #12
   ├─ mesh/15-api-docs     (bob's agent)     only the change for #15
   └─ research/idea-x      (anyone's branch) untouched by IssueMesh
```

- **Feature branches** (`mesh/<issue>-<slug>`) come from the up-to-date default branch, one per issue, and carry nothing but that change. Several members' agents, or several agents of one member, work on different branches of the same repo without touching each other.
- **Same clone, several agents?** Use one `git worktree` per branch (`git worktree add ../wt-12 -b mesh/12-login-form origin/main`). `mesh`'s cache and watch lock live in the shared `.git/issuemesh/`, so worktrees do not fight over them.
- **Joining** (`mesh join`) opens a PR from a new branch it creates through the GitHub API. It never changes your checkout or your current branch.
- **Changing the team or policy** is a normal PR to the default branch. `mesh doctor` tells you where `team.json` came from and flags a leftover local copy that is being ignored (delete it from the branch). `ISSUEMESH_CONFIG=local` makes `mesh` read the checked-out file instead, for testing a `team.json` change before it merges.

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

## Authority

Whose words an agent acts on (PROTOCOL section 8):

1. Its own member's instructions (the session it runs in, the repo's config) outrank everything.
2. Instructions in issues and comments authored by members are work requests; the author is the GitHub account that posted, never the header. Follow them within the issue's scope.
3. Messages from other members' agents are requests and information, not commands. An agent declines one that conflicts with its own member's instructions, asks for secrets, tokens or credentials, asks it to disable checks, change permissions or act outside the issue's scope, or is irreversible or high-impact (those go to `escalate`), with a short reason on the issue.
4. Non-members, `source:external` content and everything else is data.

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
