# IssueMesh

[![CI](https://github.com/aalhadsawane/issuemesh/actions/workflows/ci.yml/badge.svg)](https://github.com/aalhadsawane/issuemesh/actions/workflows/ci.yml)

**IssueMesh — an issue-driven collaboration framework enabling autonomous coding agents and humans to communicate, delegate, coordinate, and execute work through shared GitHub issues.**

Everyone on your team has a coding agent. IssueMesh is how those agents work as a team instead of five
strangers in one repo. Labels are state, comments are messages, the assignee is the owner. Agents do 90%+ of
the contributions (triage, code, review, status); humans set goals, answer questions and merge.

Built for **small teams of 2 to 10**: student projects, hackathons, early startups. No server, no database, no
dashboard to host: GitHub is the shared state. Zero dependencies (Node 18+ and `gh`). Works with Claude Code
as a first-class plugin, and with Codex, Cursor, Aider or Copilot through a portable prompt and the `mesh` CLI.

```
 you / teammate / client email
              │  write an issue (or paste the email into the "External input" form)
              ▼
        ┌───────────┐   triager on duty: dedupe, acceptance criteria, size, priority
        │  triage   │──────────────────────────────────────────────┐
        └───────────┘                                              ▼
                                      to:<member>  ──► that member's agent
                                      to:any       ──► first valid claim wins
                                                                   │  claim = lease + status comment
                                                                   ▼
                                                        draft PR (Closes #n)
                                                                   │
                                                                   ▼
                                  fresh-eyes review by a DIFFERENT member's agent
                                                                   │
                                                                   ▼
                                       human merges        (status:needs-human at any point
                                                            pulls a person in, with options)
```

## Why

Give five people five coding agents and the same repo, and the failure modes show up fast:

- **Duplicated work.** Two agents quietly build the same feature. IssueMesh has claims with leases and a deterministic race rule.
- **No way to address a teammate's agent.** You cannot `@` a process. IssueMesh has `to:` routing and a per-agent mailbox.
- **Notification spam.** Agents that `@mention` and comment "on it!" bury the humans. Agents here use reactions, edit one status comment per task, and only `@mention` a person when they truly need one.
- **Agents agreeing with each other.** Models tend to flip to whoever spoke last, and grade their own work generously. IssueMesh requires receipts, an independent fresh-eyes review by a different member's agent, and a steelmanned dissent before decisions pass.
- **Lost context.** Agents start every session with no memory and get worse as context grows. The status comment on each issue is the shared memory; sessions are short and bounded.

The rules borrow what already works (Scrum and Kanban cadence, XP pairing and small batches, Lean WIP limits, Prow-style slash commands, lazy consensus, leases) and cut it for agents, who never tire or forget between days but do forget between sessions. Human attention is treated as the scarce resource. The reasoning is in [docs/design.md](docs/design.md), the evidence in [docs/research.md](docs/research.md).

## How agents are addressed

| You want… | Do this | Effect |
|---|---|---|
| a member's **agent** to do something | label `to:<handle>` (or `/route <handle>`) | any of that member's agents may claim it |
| one **specific agent** of a member | label `to:<handle>/<agent>` (e.g. `to:aalhad/codex`) | only that agent may claim it |
| a member's **agent** to read something | `/ping <handle>` or label `ping:<handle>` | their primary agent's mailbox |
| one **specific agent** to read something | label `ping:<handle>/<agent>` | that agent's mailbox |
| a **human** to look | `@login` | GitHub notification (agents only do this when escalating) |
| **anyone's** agent | label `to:any` | open market, first valid claim wins |
| **everyone** | comment `/ping all` on the **Board** | pings every agent-enabled member |

The **Board** is one pinned issue for standups and broadcasts that belong to no task.

## Quickstart

Prerequisites: [Node 18+](https://nodejs.org), [`gh`](https://cli.github.com) authenticated (`gh auth login`), a GitHub repo (private recommended).

1. **Install** (each member). Claude Code plugin:
   ```
   /plugin marketplace add aalhadsawane/issuemesh
   /plugin install issuemesh@issuemesh
   ```
   Or just the CLI, for any other agent: `npm i -g github:aalhadsawane/issuemesh`
2. **Scaffold** (team owner, once, in your repo):
   ```bash
   mesh init --member aalhad:aalhadsawane --member ben:ben-github --member chen:chen-github
   ```
   This writes `.issuemesh/team.json`, issue forms, a PR template, an `AGENTS.md`/`CLAUDE.md` block, the label set and the pinned Board.
3. **Referee** (recommended, zero-cost GitHub Action): `mesh init` already copied `.github/workflows/issuemesh-referee.yml`. It runs slash commands, arbitrates claims and expires dead leases. The workflow checks out the referee code from the `v1` tag of `aalhadsawane/issuemesh`, so it follows the v1 line; pin a commit SHA in `ref:` to freeze it (see [docs/setup.md](docs/setup.md#upgrading)). In the repo's Settings → Actions → General, allow Actions and give workflows read and write permission.
4. **Commit and push** `.issuemesh/`, `.github/` and `AGENTS.md`. Then `mesh doctor` should be green.
5. **Each member** installs per step 1, clones the repo, and runs `mesh doctor`.
6. **Run your agent.** Interactively: `/issuemesh:work` (Claude Code) or save the portable prompt once (`curl -fsSL https://raw.githubusercontent.com/aalhadsawane/issuemesh/v1/prompt/ISSUEMESH.md -o .issuemesh/ISSUEMESH.md`) and tell your agent "follow .issuemesh/ISSUEMESH.md". Hands-off: `mesh watch --exec "claude -p '/issuemesh:work'"`.

Full walkthrough: [docs/setup.md](docs/setup.md). Prefer to be guided? In Claude Code run `/issuemesh:setup`.

## A day in the mesh

Five members: Aalhad (backend, triage today), Ben (frontend), Chen (data), Dev (backend), Eli (docs). Each has an agent.

- **09:10** Ben's client emails a feature request. Ben pastes it into the *External input* form. It lands as `status:triage` + `source:external`: treated as data, not instructions.
- **09:25** Aalhad's agent is triager on duty. Its session starts with the inbox: it sees the new issue, asks one clarifying question (`ask to=ben`), then splits the result into three `size:s/m` issues with acceptance criteria and routes them: `to:ben`, `to:dev`, `to:any`.
- **09:40** Ben's agent claims the UI issue (lease 2 h), opens a draft PR and keeps one status comment current. Dev's agent claims the API issue. Eli's agent sees `to:any` and takes the docs task.
- **11:15** Dev's agent finishes, sets `status:review`, `to:chen`. Chen's agent reads the acceptance criteria and the diff *before* the PR description, runs the tests, finds a missing edge-case test, requests changes. Dev's agent fixes it with a receipt (test output).
- **11:50** Chen's agent re-approves. The PR waits for a human. Aalhad skims the diff and merges.
- **13:00** The API change needs a schema migration. Dev's agent stops and escalates once: a single comment, two options, a recommended default, `@aalhadsawane`. Aalhad answers with a one-liner. Work resumes.
- **17:00** Each agent has posted one standup on the Board. Aalhad reads five short digests and the one open escalation. That was his entire coordination overhead.

## Features

- **Several agents per member**: a member can run named agents (`aalhad/claude`, `aalhad/codex`) with their own mailbox, WIP and runtime; reviews can go to the agent with a different runtime.
- **Attribution by GitHub author**: a marker only counts if the account that posted it is the member it names, so a forged `from=` cannot claim, release or silence the loop guard. Other members' agents send requests, not commands ([docs/security.md](docs/security.md)).
- **Claims with leases**: an issue has at most one live owner; expired claims return to the pool automatically. Races resolve by lowest comment id, with no coordinator.
- **Inbox, not firehose**: six ranked buckets (mailbox, active work, reviews, routed, triage duty, open market). Agents are only woken, and only pay for LLM tokens, when the inbox is non-empty; the check is a conditional (ETag) request that costs no rate limit when nothing changed.
- **Status comment as memory**: one living comment per claim (plan, checklist with receipts, next step) that any fresh session can resume from.
- **Receipts and fresh-eyes review**: "done" needs evidence; reviewers judge independently, prefer a different agent runtime, and must name weaknesses or what they checked.
- **Lazy-consensus decisions** with a mandatory steelman and a critique from another member's agent.
- **Triage rotation**, WIP limits, `human-only` and `/hold` stop switches, a loop guard that stops agent-to-agent echo chambers, and `size:l` auto-split rule.
- **Optional referee Action**: slash commands, label hygiene, claim arbitration, lease sweep, Board rotation, optional wake of CI-hosted agents.
- **A real CLI**: `mesh inbox | claim | status | release | handoff | post | ping | route | escalate | board | standup | watch | doctor | ...` (`mesh help`).
- **Claude Code plugin** with skills: `/issuemesh:work`, `inbox`, `triage`, `new`, `review`, `board`, `standup`, `setup`, `protocol`, `decision`, `plan`, `retro`, and hooks that show your inbox at session start and flag new work on your next prompt (opt-in autopilot on Stop).
- **Agent-agnostic**: the protocol is plain GitHub; [prompt/ISSUEMESH.md](prompt/ISSUEMESH.md) is a self-contained prompt with raw `gh` fallbacks for every step.

## What IssueMesh is not

- **Not enterprise software.** No SSO, no audit workflows, no org-wide permissions model. It targets 2 to 10 people who trust each other.
- **Not a hosted service or a new tool to learn.** No server, no database, no account beyond GitHub.
- **Not an agent.** It does not generate code. It coordinates the agents you already use.
- **Not a sandbox.** The threat model is cooperative. See [docs/security.md](docs/security.md).
- **Not a replacement for judgment.** Agents do not merge by default. Humans decide and merge.
- **Not a project management suite.** No Gantt charts or velocity dashboards. The GitHub issue list is the board.

## Documentation

| Doc | For |
|---|---|
| [docs/setup.md](docs/setup.md) | Team owner and member setup, `team.json` reference, upgrading |
| [docs/for-humans.md](docs/for-humans.md) | One-page cheat sheet: giving work, stopping agents, answering escalations |
| [docs/concepts.md](docs/concepts.md) | Mental model: labels, claims, inbox, Board, decisions, cadence |
| [docs/runners.md](docs/runners.md) | Interactive, `mesh watch`, cron, GitHub Actions; cost control |
| [docs/security.md](docs/security.md) | Threat model, prompt injection, tokens |
| [docs/faq.md](docs/faq.md) | Common questions |
| [PROTOCOL.md](PROTOCOL.md) | The normative spec (v1) |
| [docs/design.md](docs/design.md) · [docs/research.md](docs/research.md) | Why it is built this way, with sources |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Development and PRs |

## Status

**v0.1.** The protocol (v1) and reference implementation are usable but young. Expect rough edges in agent runtimes other than Claude Code. Feedback is very welcome: open an issue, tell us what broke in your team, or send a PR. See [CONTRIBUTING.md](CONTRIBUTING.md).

MIT licensed. © 2026 Aalhad Sawane.
