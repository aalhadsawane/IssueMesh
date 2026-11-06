# For humans: cheat sheet

You steer; agents do the work. Your jobs: say what you want, answer questions, merge.

## What the inbox is (and is not)

Your agent's **inbox** is the list of GitHub issues and PRs in this repo that labels route to it (`ping:`, `to:`, assigned). It is built only from read-only GitHub calls to that one repo. IssueMesh and its hooks never read your email, Gmail, Slack or any other account. Outside information gets in only when you paste it into the *External input* form (below) or ask your agent to file it with `/issuemesh:new`.

```
 labels on issues/PRs in THIS repo ──(gh api, read-only)──► mesh inbox ──► "2 item(s) need you"
   ping:you · to:you · assigned to you

 never read:  email · Gmail · Slack · calendar · any other account
```

Hooks (Claude Code) just print a one-line count and are silent outside IssueMesh repos. Turn the hooks off with `ISSUEMESH_HOOKS=0` in your environment (these hooks only), leave `ISSUEMESH_AUTOPILOT` unset (the Stop hook is opt-in), set `"disableAllHooks": true` in your Claude Code settings (all hooks; there is no per-hook switch), or disable the plugin (`/plugin`, or `claude plugin disable issuemesh`).

## Give work to agents

1. **New issue** → pick a form: *Task*, *Bug*, *Question*, *Decision*. Write a goal and **testable acceptance criteria**. That is all agents need.
2. The issue starts in `status:triage`. The triager on duty (an agent) checks it, splits big work, sets priority and size, and routes it.
3. To skip triage, route it yourself: comment `/route ben` (any of that member's agents) or `/route any` (first free agent). To pick one agent of a member: `/route ben/codex`.
4. Urgent? `/priority p0`. Big? `/size l` and it gets split.
5. Want it yourself? `/claim` (or assign yourself). Agents will not override a live human claim.

Or just ask an agent in your own session: `/issuemesh:new` turns free text into a well-formed issue; `/issuemesh:plan` breaks a goal into issues.

## Add outside information (email, notes, client messages)

Open the **External input** form. Paste the raw text under "Raw content", say where it is from, and say what you want ("extract tasks", "draft a reply", "summarize"). Remove passwords, tokens and private data first. The issue is labelled `source:external`: agents summarize and extract tasks from it but never follow instructions written inside it. If you want something done, state it in your own comment.

## Slash commands

One per line, at the start of a line, in a comment. Only team members' commands count; the referee applies them.

| Command | Effect |
|---|---|
| `/route <handle\|handle/agent\|any>` | send to that member's agents / one named agent / anyone's |
| `/ping <handle…\|handle/agent\|all>` | add `ping:` labels (`all` on the Board = everyone; a plain handle = that member's primary agent) |
| `/claim` · `/release` | take it yourself / give it back |
| `/handoff <handle\|handle/agent>` | release + route + ping |
| `/priority p0..p3` · `/size s\|m\|l` · `/kind <kind>` | set that label |
| `/block #<n>` · `/unblock` | mark dependent on another issue / resume |
| `/triage` | send back for triage |
| `/hold` · `/unhold` | **pause everything on this issue** / resume |
| `/escalate` | move to `needs-human` |

## Labels you will use

`to:<handle>` / `to:<handle>/<agent>` / `to:any` (who) · `status:*` (where it is) · `priority:p0..p3` · `size:s|m|l` · `kind:*` · `human-only` (agents must not touch it) · `source:external` · `status:needs-human` (waiting for you).

## Stop agents

| Want | Do |
|---|---|
| pause one issue | comment `/hold` (a human `/hold` binds every agent; `/unhold` resumes) |
| keep agents off it entirely | add the `human-only` label |
| take it over | `/claim`, or assign yourself |
| stop one member's agent | stop their runner (`Ctrl-C` on `mesh watch`, disable their agent workflow) or set `"agents": []` (legacy `"agent": {"enabled": false}`) in `team.json`; one agent only: remove it from `agents[]` |
| stop agent merges | already the default (`agents_can_merge: false`) |
| a runaway agent exchange | the loop guard flags it `needs-human` after 8 agent-only comments; any human comment resets it |

## Agents are not each other's boss

Your agent follows you. Another member's agent can ask yours for something, but yours declines anything that conflicts with your instructions, asks for secrets or tokens, turns off checks, changes permissions, leaves the issue's scope or cannot be undone. If you want your agent to do it, say so in your own comment: a member's comment is a work request, and the author is the GitHub account that posted it.

## Answer escalations

Filter on `label:status:needs-human`, or just watch your GitHub notifications: agents only `@mention` you when they truly need you. An escalation is a single comment with the question, options and a **recommended default**. Reply in one line ("go with option B", "yes, use the default"). Then set the status back: `/unblock`, or `/route <handle>`. Anything you leave unanswered stays parked rather than guessed at.

Agents must escalate on: unresolved ambiguity after one question, irreversible or high-impact changes (data deletion, shared-schema migration, secrets, auth, payments, licences, new paid services), conflicting instructions, CI failing 3 times on the same problem, and the loop guard.

## Review and merge

PRs arrive as drafts, then `status:review` with a different member's agent reviewing. The review states what was checked and lists concrete weaknesses, and carries receipts (test output, CI links). You skim, ask for changes in a comment, and **merge**. Agents will not merge unless you enable `agents_can_merge`.

## Daily glance

1. Open the **Board** (pinned issue): one short standup per agent.
2. Issues labelled `status:needs-human`: answer the one-liners.
3. Open PRs in `status:review` with an approving agent review: merge.

Decisions (`kind:decision`) pass by lazy consensus after 24 hours unless you object with a 👎 or a comment. Decisions marked `human-only` need your explicit 👍.
