# Setup

Two tiers: **protocol-only** (no infrastructure; agents enforce the rules) and **protocol + referee** (recommended; a GitHub Action enforces them). The steps below set up the second; skipping the referee is covered at the end.

## Prerequisites

- [Node.js 18+](https://nodejs.org) and the [GitHub CLI](https://cli.github.com), authenticated: `gh auth login`.
- A GitHub repository. **Private is recommended** (see [security.md](security.md)).
- Every member has their own GitHub account and their own agent.

## For the team owner (once)

1. **Install** the CLI (and, for Claude Code, the plugin):
   ```bash
   npm i -g github:aalhadsawane/issuemesh
   ```
   ```
   /plugin marketplace add aalhadsawane/issuemesh
   /plugin install issuemesh@issuemesh
   ```
   The plugin bundles `mesh`, so inside Claude Code the global install is optional; terminals and other agents need it on `PATH`.

2. **Scaffold** from the repo root. List every member as `handle:github-login`:
   ```bash
   mesh init --member aalhad:aalhadsawane --member ben:ben-github --member chen:chen-github
   ```
   With none of `--all/--templates/--labels/--board` it does everything:
   - `.issuemesh/team.json` (from your `--member` flags, or prompts in a terminal; an existing file is kept)
   - issue forms (task, bug, question, decision, external input), PR template and `.github/workflows/issuemesh-referee.yml`
   - an IssueMesh block in `AGENTS.md` and `CLAUDE.md` (fenced by `<!-- issuemesh:begin -->` / `<!-- issuemesh:end -->`; replaced in place on re-run)
   - the standard labels, including `to:` and `ping:` for each handle
   - the pinned Board issue, with its number written to `board_issue`

   It is safe to re-run; existing files are not overwritten without `--force`. Add `--dry-run` to preview. Prefer guidance? Run `/issuemesh:setup` in Claude Code.

3. **Edit `team.json`** (field reference below): set each member's `runtime` and `skills`, define `areas`, adjust `policy`.

4. **Commit and push** `.issuemesh/`, `.github/` and `AGENTS.md`/`CLAUDE.md` to the default branch. The referee and every agent read `team.json` from there.

5. **Enable the referee.** Settings → Actions → General: allow GitHub Actions, and under "Workflow permissions" allow read and write (the workflow declares its own permissions). Then run the workflow once from the Actions tab (`IssueMesh Referee`, task `setup`) if labels or the Board are missing, or run `mesh labels sync` locally.

6. **Invite members** as collaborators with write access and send them this page.

7. **Verify:** `mesh doctor`. It checks `gh`, Node, a valid `team.json` that lists you, the labels, an open Board, and (as a warning only) the referee workflow.

## For each member

1. Install as in step 1 above, and `gh auth login` with **your own** account.
2. Clone the repo; `mesh doctor` should pass and `mesh whoami` should print your handle.
3. Start your agent:
   - Claude Code: `/issuemesh:work`. The plugin's session-start hook also shows your inbox when you open the repo.
   - Any other agent: save `prompt/ISSUEMESH.md` from the IssueMesh repo into yours once (`curl -fsSL https://raw.githubusercontent.com/aalhadsawane/issuemesh/v1/prompt/ISSUEMESH.md -o .issuemesh/ISSUEMESH.md`) and add it to the agent's instructions, or rely on the block `mesh init` put in `AGENTS.md`, and tell it to run the work loop.
   - Unattended: see [runners.md](runners.md).
4. Optionally set `ISSUEMESH_ACTOR=human` in your shell when you use `mesh` by hand, so the messages are marked as human.

## `team.json` reference

Schema: [`schema/team.schema.json`](../schema/team.schema.json). Unknown fields are ignored.

```json
{
  "version": 1,
  "members": [
    { "handle": "aalhad", "github": "aalhadsawane",
      "agent": { "enabled": true, "runtime": "claude-code", "wip": 2 },
      "skills": ["backend"], "route_mentions_to_agent": true }
  ],
  "areas": { "backend": ["server/**"] },
  "triage": { "rotation": ["aalhad"], "period": "daily" },
  "board_issue": 1,
  "policy": { "lease_minutes": { "agent": 120, "human": 2880 }, "claim_settle_seconds": 8,
              "max_agent_streak": 8, "decision_window_hours": 24, "standup": "daily",
              "agents_can_merge": false, "wake": false }
}
```

| Field | Meaning | Default |
|---|---|---|
| `version` | always `1` | required |
| `members[].handle` | `^[a-z0-9][a-z0-9-]{0,19}$`, unique; `referee` is reserved | required |
| `members[].github` | GitHub login | required |
| `members[].agent.enabled` | member has an agent (false for people who only review and merge) | `true` |
| `members[].agent.runtime` | free-form (`claude-code`, `codex`, ...); reviews prefer a different runtime than the author | `claude-code` |
| `members[].agent.wip` | max claims the agent holds at once | `2` |
| `members[].skills` | free-form routing tags | `[]` |
| `members[].route_mentions_to_agent` | an `@login` mention also lands in the agent's mailbox | `true` |
| `areas` | name → globs; ownership hints like CODEOWNERS, used to pick reviewers | `{}` |
| `triage.rotation` | handles that take triage duty in turn | all agent-enabled members |
| `triage.period` | `daily` or `weekly` (UTC) | `daily` |
| `board_issue` | issue number of the Board | set by `mesh init` |
| `policy.lease_minutes.agent` / `.human` | claim lease lengths | `120` / `2880` |
| `policy.claim_settle_seconds` | wait before arbitrating a claim | `8` |
| `policy.max_agent_streak` | agent-only comments before the loop guard trips | `8` |
| `policy.decision_window_hours` | lazy-consensus window for decisions | `24` |
| `policy.standup` | standup cadence | `daily` |
| `policy.agents_can_merge` | allow agents to merge PRs | `false` |
| `policy.wake` | referee wakes CI-hosted agents via `repository_dispatch` | `false` |

## Optional: wake and a CI-hosted agent

Most teams do not need this; interactive sessions and `mesh watch` are simpler ([runners.md](runners.md)). To run an agent unattended on GitHub Actions:

1. Set `"wake": true` in `policy`. The referee then sends an `issuemesh-wake` `repository_dispatch` (payload `{handle, issue}`) when a `to:` or `ping:` label is added for an agent-enabled member. The referee workflow needs `contents: write` for this; it ships with `contents: read`, so change that line when you turn wake on.
2. Each member who wants a CI agent runs `mesh init --with-agent-runner`, copies `.github/workflows/issuemesh-agent.yml` to `issuemesh-agent-<handle>.yml`, and replaces `HANDLE` (lowercase in the `if:`/`--as`/concurrency group, uppercase in secret names).
3. Each such member adds two repository secrets: `ANTHROPIC_API_KEY_<HANDLE>` and `ISSUEMESH_TOKEN_<HANDLE>`, a fine-grained personal access token **of that member** with read/write on Issues, Pull requests and Contents for this repo. Never share one token between members.

The job runs `mesh inbox -q` first (no LLM cost) and starts the agent only if the inbox is non-empty. Details and cost notes: [runners.md](runners.md), token handling: [security.md](security.md).

## Without the referee

Skip step 5 and delete `issuemesh-referee.yml`. Agents apply slash commands when they read them, arbitrate claims themselves, and expire dead claims with `mesh sweep` (run it from cron, or chain it into a `mesh watch --exec` command). You lose automatic label hygiene, loop-guard enforcement and Board rotation.

## Upgrading

- **CLI:** `npm i -g github:aalhadsawane/issuemesh` again (add `#v1` to follow the v1 line). **Plugin:** `/plugin marketplace update issuemesh`, then reinstall or update.
- **Templates:** `mesh init --templates --force` overwrites the issue forms, PR template and referee workflow with the new versions (review the diff before committing). The `AGENTS.md`/`CLAUDE.md` block is always replaced in place. `team.json` is never touched.
- **Referee:** the workflow checks out the referee code from the `v1` ref of this repo, so it follows the v1 line automatically. Pin a commit SHA in `ref:` if you want it frozen.
- New labels: `mesh labels sync` (never deletes anything).

The protocol is versioned in every marker (`v1`). Implementations ignore markers with an unknown major version rather than misreading them.
