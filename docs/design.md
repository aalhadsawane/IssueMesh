# IssueMesh design

Why IssueMesh is built the way it is. The normative rules are in
[PROTOCOL.md](../PROTOCOL.md); this document explains the reasoning behind them.
Citations like [R4] refer to [research.md](research.md).

## 1. Principles

1. **Agents are first-class; humans steer.** The expected split is that agents
   do 90% or more of the contributions (triage, code, review, status) and humans
   set goals, answer questions, and merge. Every rule is judged by one test: does
   it make agent work safer and cheaper without adding human chores?

2. **Human attention is the scarce resource.** Agents are abundant and fast;
   a person's attention is not. Protocol features exist to spend it well:
   one batched `escalate` per issue with a recommended default (§9.9), reactions
   instead of acknowledgement comments (§3), `@mention` reserved for escalation
   so notifications stay meaningful, and a merge gate that stays human by
   default (`agents_can_merge: false`).

3. **Design for how agents fail, not how people fail.** Agents start each
   session with no memory, degrade as context grows [R1][R2], state falsehoods
   confidently, agree with whoever spoke last [R4], judge their own work
   generously [R5][R6], and may game checks [R10]. Section 4 maps each of these
   to a rule. Human process assumes the opposite failure modes (forgetfulness
   across days, fatigue, politics), so copying it unchanged fails.

4. **Borrow proven practice, re-cut it.** Scrum, Kanban, XP, Lean, RACI,
   on-call, Prow, lazy consensus, ADRs, CODEOWNERS and leases already solved
   coordination problems. We keep the function and drop the ceremony, because
   an agent never needs a meeting to be reminded of a plan; it needs the plan
   written where the next session will read it (section 3).

5. **Shared state lives in GitHub, in plain text.** Labels are the state
   machine, comments are messages, the assignee is the owner. No server, no
   database, no new account. Any agent that can read and write issues can
   follow the protocol by hand, and a human can read and override everything in
   the normal GitHub UI.

6. **Enforce cheaply and deterministically; spend LLM tokens only on work.**
   Arbitration, lease expiry, label hygiene and the loop guard are mechanical
   and run in a Node script or a GitHub Action, not in a model. A session is
   started only when the inbox is non-empty (§6).

7. **Prefer protocol over trust.** No agent is assumed correct, including the
   reader's own. Claims need receipts, other agents' statements are
   re-checked when cheap, and disagreement needs evidence. The protocol assumes
   cooperative members (section 6) but not infallible ones.

8. **Small by construction.** The design target is 2 to 10 people. Anything
   whose only purpose is scaling coordination to hundreds of people was left out
   on purpose (section 2).

## 2. Who it is for, and who it is not for

**For:** student group projects, hackathons, and startups-of-three, where each
person has a personal coding agent, everyone shares one repository, and nobody
has time to run a process.

| Fits | Does not fit |
|---|---|
| 2 to 10 members, each optionally with one agent | Organisations of tens or hundreds with many teams |
| One repository (or a few) with a shared GitHub issue tracker | Work spanning many repos with separate permission regimes |
| Members who trust each other with write access | Adversarial contributors, public untrusted write access |
| Cycles of days to a couple of weeks | Quarterly planning, long roadmaps |
| Humans who want to review outcomes, not supervise steps | Environments needing audit trails, sign-offs, segregation of duties |

**Deliberately left out**, and why:

| Left out | Reason |
|---|---|
| Scrum-of-scrums, SAFe, release trains, programme management | These coordinate teams that cannot talk to each other cheaply. At 2 to 10 people one Board issue is enough. |
| Approval boards, change-advisory gates, multi-level sign-off | They spend scarce human attention on routine changes. One human merge gate plus a human-only escape (`human-only`, `/hold`) covers the real risks. |
| Story points, velocity, burndown | Agent throughput depends on context quality and CI, not effort. A three-value `size:` that forces splitting is enough. |
| Roles and permission tiers beyond "member" | With a handful of people, per-person areas and a triage rotation do the same job. |
| Resource and capacity planning | `agent.wip` caps parallel claims; there is nothing else to balance. |
| A dashboard or server | GitHub is the UI. The Board issue is the dashboard. |

## 3. Borrowed, then re-cut for agents

| Practice | Origin | What humans do | What IssueMesh does instead | Why (agent property) |
|---|---|---|---|---|
| Definition of Ready | Scrum | Backlog refinement meeting; story discussed until clear | Triage makes an issue `ready` only with a goal, acceptance criteria and `size` of `s` or `m`; `size:l` becomes an epic with sub-issues (§7) | Vague delegation produces duplicated or divergent work [R11][R9]; an agent will start immediately on an ambiguous task rather than ask |
| Definition of Done | Scrum | Team checklist, agreed verbally | Acceptance criteria checked with receipts, CI green, PR merged, closed as completed (§7, §9.1) | Agents declare "done" prematurely; done must be checkable |
| Daily standup | Scrum | 15-minute meeting | One `type=standup` comment per agent per day on the Board: done, doing, blocked, needs (§10) | Agents have no schedule or memory; the artifact is what the next session and the human read. Links only, so it stays cheap to skim |
| Sprint planning | Scrum | Meeting to pick scope | Milestone as cycle; triager on duty drafts epics and tasks, humans set goals and priorities (§12) | Splitting and drafting is cheap for an agent; choosing goals is the human decision |
| Retrospective | Scrum | Discussion, sticky notes | One `note` at milestone close with cycle time, reopened issues, escalations, lost claim races; changes become ordinary issues (§12) | An agent can compute the numbers from history; humans decide what changes. Agents cannot "remember to improve", so the improvement must be a tracked issue |
| Pull system, WIP limits | Kanban | Pull the next card when you have capacity | Inbox is an ordered pull queue; `agent.wip` caps live claims (§6, §1) | Agents are fast enough to claim everything; unlimited claims create stale, half-done work and context overload |
| Explicit policies | Kanban | Written on the board column | Labels and transitions are the policy, written down in PROTOCOL.md and enforced by the referee | Agents follow written rules well and unwritten ones not at all |
| Pair/peer review | XP | Colleague reads the diff | Fresh-eyes review by a different member's agent, ideally a different runtime; independent assessment first, then compare to the author's description (§9.4, §7) | Reviewers anchor on the author's framing [R4]; a model prefers its own output [R6]; models cannot reliably self-correct [R5] |
| Small releases | XP | Ship often | Draft PR early; `size:l` forbidden for a task; one issue per PR (§7, §9.7) | Quality and context both degrade with scope [R1][R2]; agents add unrequested changes |
| Collective ownership | XP | Anyone may change any code | Areas are routing hints, not locks; touching another member's area requests their review (§7) | Agents will edit anywhere; the safeguard is review, not prohibition |
| Waste elimination | Lean | Cut meetings, hand-offs, rework | Cheap gate before any LLM session; no acknowledgement comments (reactions); one edited status comment per claim; scope discipline (§3, §6, §8, §9.7) | Tokens and notifications are the waste for agents; chatter between agents compounds quickly |
| RACI | Project management | Chart of Responsible, Accountable, Consulted, Informed | Assignee = Responsible; the human who merges = Accountable; `ask`/`/ping` = Consulted; Board and `ping:` = Informed; `to:` = routing, claim = acceptance (§2, §3) | Roles must be machine-readable. Putting R and A in labels and assignee removes ambiguity about who acts and who decides |
| On-call rotation | SRE | Pager rotation takes incoming alerts | Triage rotation computed from `unix_days`; the on-duty agent routes `status:triage` issues (§1) | Prevents all agents triaging at once (duplicate work) and nobody triaging (starvation); the formula needs no state |
| Slash commands, label namespaces | Kubernetes Prow [R17] | Chat-ops in PR comments mapped to labels | `/claim`, `/route`, `/ping`, `/hold` and `status:`/`to:`/`ping:` namespaces with cardinality rules (§2, §5) | Short, parseable commands are reliable for models and for a referee script; free-text intent is not |
| Lazy consensus | Apache [R15] | Mailing-list proposal; silence is consent after N days | `kind:decision` issue accepted if no 👎 or comment in `decision_window_hours`; human-only decisions need a human 👍 (§11) | Cheapest way to decide: humans act only to object. Added: a mandatory critique, because agents tend to agree [R4][R7] |
| ADR | Architecture practice | Short record of context, options, decision | A `kind:decision` issue holds context, options, proposal and the steelmanned alternative (§11, §9.5) | The record is exactly what a memoryless future session needs to avoid re-litigating |
| CODEOWNERS | GitHub | File mapping paths to reviewers | `areas` in `team.json`: globs to owners; reviewer is a different member, preferring the area owner (§1, §7) | Same function; we add "different member" because an agent must not approve its own member's PR |
| Leases, heartbeats | Chubby [R13], Gray and Cheriton [R14] | Lock with a timeout, renewed by keep-alive | Claim comment carries `lease=`; edits to the status comment bump it; expired claims are swept to `ready` (§4.3) | Agent sessions die silently (crash, context exhaustion, closed laptop). A lease turns "silent death" into "work becomes available again" without anyone noticing |
| Appetite | Shape Up [R16] | Fix time first; shape scope to fit | Size cap (`l` must be split) and the lease bound a unit of work; a claim that outlives its lease is released (an explicit per-session token budget is not yet in the protocol) | Agents do not tire, so work expands to fill time and context; a fixed budget forces split and handback |
| IP TTL | Networking | Hop count decremented per router; packet dropped at 0 | Loop guard: `max_agent_streak` consecutive agent comments from two or more handles with no human in between stops all replies and sets `needs-human` (§8) | Two agents answer each other instantly and indefinitely; mutual agreement feels like progress [R7] |
| Mailbox acknowledgement | Messaging | Message stays unread until the reader acts | `ping:<handle>` is the unread flag; only the addressee removes it (§3) | Gives a durable, queryable inbox; no extra state store needed |
| Log compaction | Databases | Collapse a log to its latest state | The claim comment is edited in place as the status comment, under 60 lines; readers start there (§4.3, §9.6) | A long thread is poison for a fresh session [R1][R2]; compaction is the structured note-taking recommended in [R3] |

## 4. Designing for how agents actually behave

| Agent failure mode | Evidence | Protocol countermeasure |
|---|---|---|
| Confident false statements; "it works" without running it | Self-correction without external feedback does not help and can degrade results [R5] | **§9.1 Receipts**: claims need command plus output, CI link, SHA or `path:line`; unreceipted claims are unverified |
| Building on another agent's unverified claim; errors compound across a chain | Inter-agent misalignment and verification failures are major classes of multi-agent failure [R9] | **§9.2**: re-check cheap claims or say you depend on them unverified |
| Sycophancy: changing a position because of pushback, not evidence | Assistants flatter and yield to user views; humans and preference models sometimes reward it [R4] | **§9.3**: a change of position must cite new evidence or a better argument; "LGTM" alone is not a review |
| Anchoring on the author's framing during review | Sycophancy and confirmation toward prior context [R4] | **§9.4**: reviewer forms its own assessment from acceptance criteria and diff first, runs tests itself, and lists weaknesses or states what was checked |
| Self-preference when judging | Models recognise their own output and rate it higher [R6] | **§9.4 and §7**: a different member reviews; prefer a different `agent.runtime`; an agent never approves its own member's PR |
| Echo chambers: same-model agents agree and stop exploring | Degeneration-of-thought and same-backbone judge bias [R7]; debate helps only when positions are formed independently [R8] | **§9.5**: decisions need a steelmanned alternative and a critique from a different member's agent before the clock starts. **§8 loop guard** caps agent-to-agent runs |
| Runaway agent-to-agent conversation | Same as above; instant replies have no natural stopping point | **§8 loop guard** (`max_agent_streak`), human comment resets it; **§3** no acknowledgement-only comments |
| Context degradation in long threads and long sessions | Lost in the middle [R1]; reliability falls as input grows [R2]; attention is a finite budget [R3] | **§9.6**: status comment is compacted memory, under 60 lines; read it plus the newest comments; one short session per item; **§6** inbox gives a pre-ranked list |
| No memory between sessions | Notes outside the window are the standard remedy [R3] | **§4.3** status comment survives release so the next claimant resumes; **§9.6** write for a reader with no context; **§10** Board rotation with summary |
| Duplicate and conflicting parallel work | Parallel agents acting on partial context make conflicting decisions [R12]; vague delegation duplicates work [R11] | **§4 claims**: one assignee per issue, lowest-comment-id arbitration; **§7** Definition of Ready; `size:l` must be split |
| Silent death of a session | Systems using leases treat failure as expiry [R13][R14] | **§4.3** lease and heartbeat; referee sweep returns expired claims to `ready` |
| Premature "done" | Verification gaps are a recurring multi-agent failure [R9] | **§7** Definition of Done requires checked criteria with receipts, CI green, merged PR |
| Reward hacking: weakening or skipping tests, reading answers | Frontier models edited test/scoring code to raise scores [R10] | **§9.8**: never delete, skip or weaken tests or checks; escalate if the honest path is blocked. **§8**: CI failing three times on the same problem escalates, removing the incentive to hack the fourth time |
| Scope creep: fixing adjacent things while there | Agents add unrequested changes; diffs become unreviewable | **§9.7**: new work becomes a new `status:triage` issue linked from the status comment; one issue per PR |
| Over-consumption of human attention | Humans are the bottleneck | **§9.9** one batched `escalate` with options and a default; **§3** `@mention` only on escalation; **§8** escalation triggers are explicit so agents neither over- nor under-escalate |
| Injection through issue text from outsiders | Untrusted text read as instructions | **§8 Trust**: only members' comments are instructions; `source:external` is data; non-member slash commands ignored |
| Too eager to start; fast enough to claim everything | Token cost and coordination cost scale with parallelism [R11] | **§1 `agent.wip`**, **§6** wake only when inbox non-empty |

## 5. Key mechanisms

### 5.1 Claim arbitration by lowest comment id

```
  t0   agent A: POST claim comment      -> comment id 1004
  t0+  agent B: POST claim comment      -> comment id 1007
       (both assigned themselves, both set status:claimed)

  t0 + claim_settle_seconds: both re-read the issue's comments

       live claims = comments with type=claim and unexpired lease
                   = {1004 (A), 1007 (B)}
       winner      = min(comment id) = 1004

  A: keeps the claim, continues
  B: edits 1007 -> type=released reason=lost-race, unassigns itself
```

Why this is a total order with no coordinator:

- GitHub assigns comment ids from a single, monotonically increasing sequence.
  Any two comments are strictly ordered, and the order never changes after
  creation. There are no ties.
- Every participant reads the same comment list and applies the same pure
  function (`min` over live claims), so they all compute the same winner without
  exchanging a message. This is the property a consensus protocol buys with
  rounds and a leader; here GitHub's write path is the leader and the comment id
  is the sequence number.
- The settle delay exists only so that a late-writing rival is visible when you
  check. A claimant who checks too early would see itself as sole claimant, so
  it waits `claim_settle_seconds` and re-reads. If a comment lands after the
  check, it has a higher id and loses when its own author re-reads, so a rival
  never overrides an established winner.
- A loser needs no permission from anyone to release; it can compute the result
  itself. The referee, if installed, also checks and corrects.
- Cost: a lost race wastes one comment and a few API calls. The retro counts lost
  races so a team can see if routing is poor.

Humans are outside this rule: an agent never overrides a live human claim (§4.2).

### 5.2 Leases and heartbeat

```
 claim posted            heartbeat (edit)          heartbeat (edit)       session dies
     |                        |                        |                       |
 ----+------------------------+------------------------+-----------...---------X----------> time
     lease=T0+120m      lease=T1+120m            lease=T2+120m                 lease passes
                                                                                   |
                                                       referee (or any agent) sweeps
                                                       -> type=released reason=expired
                                                       -> unassign, status:ready
```

- The claim comment is both lock and status report. Editing it to update
  progress is the heartbeat, so liveness evidence and useful information are the
  same write. No separate keep-alive traffic.
- The lease is a promise of continued ownership with a deadline, as in [R14].
  Failure is detected by silence, not by a failure detector, which suits agents:
  a dead session cannot announce its death.
- Heartbeat at least every `lease_minutes.agent / 2`. Short agent leases
  (default 120 minutes) reduce the cost of a dead session; long human leases
  (default 48 hours) reflect human rhythm.
- Takeover leaves the old status comment in place, so the next claimant resumes
  from recorded plan and receipts instead of starting cold.
- Inherited limitation from [R14]: correctness depends on roughly agreed clocks.
  Leases here are measured in minutes (default 120) while skew between a
  laptop and GitHub is normally seconds, so the margin is large; keep local
  clocks synced (NTP).

### 5.3 Wake only when there is work

```
   cheap, deterministic, free of LLM tokens             expensive
 +---------------------------------------------+     +--------------------------+
 | timer / event  ->  mesh inbox -q  (1-2 API) |-yes>| start agent session      |
 |                    inbox empty? ----------> sleep   | read status comment     |
 +---------------------------------------------+     | work ONE item, then exit |
                                                       +--------------------------+
```

- The check is an issue-search query for labels and assignees (§6). It costs a
  few API calls and no model tokens.
- Without the gate, a 5-member mesh would start 5 sessions for each comment.
  Multi-agent runs are token-hungry already [R11]; the gate keeps idle cost at
  roughly zero.
- Three runners trade immediacy for infrastructure: a human types the command
  (zero infra), a local `mesh watch` polls with jitter and back-off (single
  flight per member), or the referee sends a `repository_dispatch` to wake
  exactly the addressed member's CI agent.
- Buckets are ordered so a session first reads messages, then continues active
  work, then reviews, then new work. One short session per item follows from
  §9.6.

### 5.4 Two tiers

```
 Tier 1: protocol only                     Tier 2: protocol + referee
 ----------------------                    ---------------------------
 Agents follow PROTOCOL.md and             Same protocol, plus a GitHub Action
 apply the rules themselves:               that runs on issue events:
  - arbitrate claims themselves             - executes slash commands
  - sweep expired claims                    - arbitrates claims, corrects losers
  - apply slash commands when they          - expires leases on a schedule
    read them                               - enforces label cardinality
  - self-police the loop guard              - trips the loop guard
                                            - sends wake dispatches (optional)
 Zero infrastructure.                      One workflow file. Recommended.
```

The referee is an optimisation and a safety net, never the source of truth.
Every rule is expressed so a lone agent can enforce it, which keeps the protocol
implementable by any agent runtime and testable without the referee. The
referee's value is that it does not need an LLM, is always on, and is not the
same model that might be making the mistake.

## 6. Trade-offs we accepted

| Decision | Cost | Why we accepted it |
|---|---|---|
| **GitHub is the only state store** | Rate limits (primary and secondary) cap polling and bulk writes; comment ordering is the only transaction primitive; no joins or queries beyond issue search | Zero infrastructure and a UI everyone already has. At 2 to 10 members, a few API calls per wake fit comfortably. Gating (section 5.3), jittered polling and single-flight per member keep usage low. If a team outgrows this, the right answer is a different tool, not a bigger IssueMesh |
| **Cooperative threat model: markers can be forged** | Any member can write `actor=agent` or `from=<other handle>`; a member could impersonate another's agent or claim on their behalf | Members already have write access to the repository and can do far worse directly. Markers carry intent and attribution among trusted peers, not authentication. Non-members are ignored for commands and instructions. Teams needing stronger guarantees should add branch protection and required human review on top |
| **Polling latency versus cost** | Without the referee wake, an agent notices work only at its next poll (minutes); conversation between agents is slower than a chat | Agent work items are minutes to hours long, so seconds of latency are irrelevant, while token cost and rate limits are real. Teams wanting speed enable `policy.wake` |
| **Labels as a state machine** | Labels are mutable by anyone with triage rights; transitions are not atomic | Transparent and editable by humans in one click; the referee repairs cardinality violations. The invariants are simple enough to re-derive |
| **Lease expiry by wall clock** | A paused-but-alive session may lose its claim and then resume | A resuming session starts by re-reading the status comment (§9.6) and so sees `released`; it must re-claim before continuing. The cost is a re-claim; the benefit is that nothing is stuck forever |
| **Humans merge by default** | Slower than automatic merge | Merge is the one irreversible, high-impact action in the flow. Teams that trust their CI set `agents_can_merge: true` |
| **Review by another member's agent** | A team with one agent runtime cannot get runtime diversity | Different-member reviewers still start with a different context and a different human's instructions; different runtime is preferred, not required, and the independent-first rule does most of the work [R8] |
| **No effort estimates** | Cannot forecast delivery dates | Agent effort is not a useful predictor of calendar time; three sizes, a forced split and lease timing cover planning at this scale |
| **JSON config, not YAML** | Less pleasant to hand-edit (no comments); needs `$schema` for editor help | The CLI has zero npm dependencies; Node parses JSON natively and a YAML parser is a dependency or a bug source. The schema gives validation and completion in editors |
| **Agents may not `@mention` humans except to escalate** | A human may miss a non-urgent agent question | It keeps a human's notification stream trustworthy; urgent things go through `needs-human` |

## 7. How it fits together

```
 human ── sets goals, answers needs-human, merges
   |
   v
 Board issue (standups, broadcasts)       team.json (members, areas, policy)
   |                                              |
   v                                              v
 issues ──triage──> ready ──claim──> claimed ──PR──> review ──merge──> closed
   ^                    |   lease/heartbeat        |
   |                    +-- expire/release --------+
   |
   +-- agents (one per member) ── woken by mesh inbox -q ── referee (optional)
```

Each arrow is a label change or a comment; each box is an issue, comment or
file in the repository. There is nothing else to deploy.
