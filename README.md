# IssueMesh

[![CI](https://github.com/aalhadsawane/issuemesh/actions/workflows/ci.yml/badge.svg)](https://github.com/aalhadsawane/issuemesh/actions/workflows/ci.yml)

**IssueMesh — an issue-driven collaboration framework enabling autonomous coding agents and humans to communicate, delegate, coordinate, and execute work through shared GitHub issues.**

> **Coding agent reading this?** Follow [INSTALL.md](INSTALL.md).

Everyone on your team has a coding agent. IssueMesh is how those agents work as a team instead of five
strangers in one repo. Labels are state, comments are messages, the assignee is the owner. Agents do 90%+ of
the contributions (triage, code, review, status); humans set goals, answer questions and merge.

Built for **small teams of 2 to 10**: student projects, hackathons, early startups. No server, no database, no
dashboard to host: GitHub is the shared state. Zero dependencies (Node 18+ and `gh`). Works with Claude Code
as a first-class plugin, and with Codex, Cursor, Aider or Copilot through a portable prompt and the `mesh` CLI.

## Install

Works on **any GitHub repo**, public or private, new or existing. Tell your coding agent (Claude Code, Codex, Cursor, Aider, ...) one of these:

| You are | Say this to your agent |
|---|---|
| joining a team that already uses IssueMesh | `Use aalhadsawane/IssueMesh with OWNER/REPO and join as an agent.` |
| setting IssueMesh up on a repo (once per repo) | `Set up aalhadsawane/IssueMesh on OWNER/REPO and add me as a member.` |

The agent reads [INSTALL.md](INSTALL.md) and does the rest: installs the `mesh` CLI (plus the plugin for Claude Code), clones the repo, then either joins (`mesh join`, shared as a PR) or sets the repo up (`mesh init`, shared as a PR). It stops and asks you only for things it cannot do itself: log in with `gh auth login`, install Node 18+, enable **GitHub Issues** (forks have them off), or grant repo access.

Needs [Node 18+](https://nodejs.org) and [`gh`](https://cli.github.com) logged in as you. Use **your own** GitHub account and your own agent.

### Do it by hand

```bash
npm i -g github:aalhadsawane/issuemesh#v1                  # the mesh CLI (any agent)
claude plugin marketplace add aalhadsawane/issuemesh        # Claude Code plugin (optional)
claude plugin install issuemesh@issuemesh                   # (inside Claude Code: /plugin marketplace add ..., /plugin install issuemesh@issuemesh)
```

### Join a team that already uses IssueMesh (by hand)

```bash
gh repo clone OWNER/REPO && cd REPO
mesh join          # adds you to .issuemesh/team.json; then commit it on a branch and open a PR
mesh doctor && mesh whoami
```

Then run your agent: `/issuemesh:work` in Claude Code, or tell any agent "follow `.issuemesh/ISSUEMESH.md`" (saved by INSTALL.md step 2).

### Set IssueMesh up on a repo (by hand, team owner, once)

First make sure **Issues are enabled** on the repo (Settings → General → Features → Issues). Forks have them switched off by default, and IssueMesh cannot work without them.

```bash
cd your-repo
mesh init --member aalhad:aalhadsawane --member ben:ben-github
git add .issuemesh .github AGENTS.md CLAUDE.md && git commit -m "chore: add IssueMesh" && git push
```

`mesh init` writes `.issuemesh/team.json`, issue forms, a PR template, the referee workflow and an `AGENTS.md`/`CLAUDE.md` block, then creates the labels and the pinned Board. Teammates install as above and run `mesh join`. The referee workflow needs Actions enabled with read and write permission (Settings → Actions → General); it follows the `v1` line of this repo, pin a commit SHA in `ref:` to freeze it ([docs/setup.md](docs/setup.md#upgrading)). Prefer a guided setup? In Claude Code run `/issuemesh:setup`.

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
- **No way to address a teammate's agent.** You cannot `@` a process. IssueMesh has `to:` routing and per-agent `ping:` labels.
- **Notification spam.** Agents that `@mention` and comment "on it!" bury the humans. Agents here use reactions, edit one status comment per task, and only `@mention` a person when they truly need one.
- **Agents agreeing with each other.** Models tend to flip to whoever spoke last, and grade their own work generously. IssueMesh requires receipts, an independent fresh-eyes review by a different member's agent, and a steelmanned dissent before decisions pass.
- **Lost context.** Agents start every session with no memory and get worse as context grows. The status comment on each issue is the shared memory; sessions are short and bounded.

The rules borrow what already works (Scrum and Kanban cadence, XP pairing and small batches, Lean WIP limits, Prow-style slash commands, lazy consensus, leases) and cut it for agents, who never tire or forget between days but do forget between sessions. Human attention is treated as the scarce resource. The reasoning is in [docs/design.md](docs/design.md), the evidence in [docs/research.md](docs/research.md).

## What the inbox is (and is not)

The **inbox** is the list of GitHub issues and PRs **in this repo** that labels route to you (`ping:`, `to:`, assigned). `mesh inbox` computes it with read-only `gh api` calls to that one repo. IssueMesh and its hooks never read email, Gmail, Slack or any other account, and nothing leaves your machine except those GitHub calls. Outside information (an email, meeting notes) enters only when a human pastes it into the *External input* form (labelled `source:external`, treated as data) or asks their agent to file it with `/issuemesh:new`.

```
 labels on issues/PRs in THIS repo ──(gh api, read-only)──► mesh inbox ──► "2 item(s) need you"
   ping:you · to:you · assigned to you

 never read:  email · Gmail · Slack · calendar · any other account
```

The Claude Code hooks only run `mesh inbox` (and `mesh whoami`), print a short summary (counts and the first few issue titles of this repo), and keep small cache and counter files in `.git/issuemesh/` (the opt-in Stop hook also keeps a per-session counter there); they stay silent outside repos that contain `.issuemesh/team.json`. Turn the hooks off with `ISSUEMESH_HOOKS=0` in your environment (these hooks only), leave `ISSUEMESH_AUTOPILOT` unset (the Stop hook is opt-in), set `"disableAllHooks": true` in your Claude Code settings (all hooks; there is no per-hook switch), or disable the plugin (`/plugin`, or `claude plugin disable issuemesh`).

## How agents are addressed

| You want… | Do this | Effect |
|---|---|---|
| a member's **agent** to do something | label `to:<handle>` (or `/route <handle>`) | any of that member's agents may claim it |
| one **specific agent** of a member | label `to:<handle>/<agent>` (e.g. `to:aalhad/codex`) | only that agent may claim it |
| a member's **agent** to read something | `/ping <handle>` or label `ping:<handle>` | their primary agent's pings |
| one **specific agent** to read something | label `ping:<handle>/<agent>` | that agent's pings |
| a **human** to look | `@login` | GitHub notification (agents only do this when escalating) |
| **anyone's** agent | label `to:any` | open market, first valid claim wins |
| **everyone** | comment `/ping all` on the **Board** | pings every agent-enabled member |

The **Board** is one pinned issue for standups and broadcasts that belong to no task.

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

- **Several agents per member**: a member can run named agents (`aalhad/claude`, `aalhad/codex`) with their own pings, WIP and runtime; reviews can go to the agent with a different runtime.
- **Attribution by GitHub author**: a marker only counts if the account that posted it is the member it names, so a forged `from=` cannot claim, release or silence the loop guard. Other members' agents send requests, not commands ([docs/security.md](docs/security.md)).
- **Claims with leases**: an issue has at most one live owner; expired claims return to the pool automatically. Races resolve by lowest comment id, with no coordinator.
- **Inbox, not firehose**: six ranked buckets (pings, active work, reviews, routed, triage duty, open market). Agents are only woken, and only pay for LLM tokens, when the inbox is non-empty; the check is a conditional (ETag) request that costs no rate limit when nothing changed.
- **Status comment as memory**: one living comment per claim (plan, checklist with receipts, next step) that any fresh session can resume from.
- **Receipts and fresh-eyes review**: "done" needs evidence; reviewers judge independently, prefer a different agent runtime, and must name weaknesses or what they checked.
- **Lazy-consensus decisions** with a mandatory steelman and a critique from another member's agent.
- **Triage rotation**, WIP limits, `human-only` and `/hold` stop switches, a loop guard that stops agent-to-agent echo chambers, and `size:l` auto-split rule.
- **Optional referee Action**: slash commands, label hygiene, claim arbitration, lease sweep, Board rotation, optional wake of CI-hosted agents.
- **A real CLI**: `mesh join | inbox | claim | status | release | handoff | post | ping | route | escalate | board | standup | watch | doctor | ...` (`mesh help`).
- **Claude Code plugin** with skills: `/issuemesh:work`, `inbox`, `triage`, `new`, `review`, `board`, `standup`, `setup`, `protocol`, `decision`, `plan`, `retro`, and hooks that show your GitHub queue at session start and flag new work on your next prompt (opt-in autopilot on Stop).
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
