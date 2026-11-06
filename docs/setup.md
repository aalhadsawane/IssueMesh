# Setup

Two tiers: **protocol-only** (no infrastructure; agents enforce the rules) and **protocol + referee** (recommended; a GitHub Action enforces them). The steps below set up the second; skipping the referee is covered at the end.

## Prerequisites

- [Node.js 18+](https://nodejs.org) and the [GitHub CLI](https://cli.github.com), authenticated: `gh auth login`.
- A GitHub repository. **Private is recommended** (see [security.md](security.md)). **GitHub Issues must be enabled** (Settings → General → Features → Issues); forks have them off by default, and `mesh doctor` fails until you turn them on.
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

5. **Enable the referee.** Settings → Actions → General: allow GitHub Actions, and under "Workflow permissions" allow read and write (the workflow declares its own permissions). Keep the referee on the default `GITHUB_TOKEN`: do not give it a personal access token, because its comments verify only as `github-actions[bot]` (PROTOCOL.md section 3). Then run the workflow once from the Actions tab (`IssueMesh Referee`, task `setup`) if labels or the Board are missing, or run `mesh labels sync` locally.

6. **Invite members** as collaborators with write access and send them this page.

7. **Verify:** `mesh doctor`. It checks `gh`, Node, a valid `team.json` that lists you, the labels, an open Board, and (as a warning only) the referee workflow.

## For each member

1. Install (see [INSTALL.md](../INSTALL.md), or just tell your agent: *"Install the app in the repo `aalhadsawane/IssueMesh` and use it for `https://github.com/OWNER/REPO`"*), and `gh auth login` with **your own** account.
2. Clone the repo and run `mesh join` (add `--handle <name>` or `--agents claude,codex` if you like). It opens a PR adding you to `.issuemesh/team.json` on the default branch, without touching your checkout. Once the owner merges it, `mesh doctor` should pass and `mesh whoami` should print your handle.
3. Start your agent:
   - Claude Code: `/issuemesh:work`. The plugin's hooks show your inbox when you open the repo (SessionStart) and flag new work on your next prompt (UserPromptSubmit). See [Hooks](#hooks).
   - Any other agent: save `prompt/ISSUEMESH.md` from the IssueMesh repo into yours once (`curl -fsSL https://raw.githubusercontent.com/aalhadsawane/issuemesh/v1/prompt/ISSUEMESH.md -o .issuemesh/ISSUEMESH.md`) and add it to the agent's instructions, or rely on the block `mesh init` put in `AGENTS.md`, and tell it to run the work loop.
   - Unattended: see [runners.md](runners.md).
4. Running several agents? Each one selects its identity with `--agent <name>` or `ISSUEMESH_AGENT=<name>` (default: your primary agent, the first in `agents[]`).
5. Optionally set `ISSUEMESH_ACTOR=human` in your shell when you use `mesh` by hand, so the messages are marked as human.

## `team.json` reference

Schema: [`schema/team.schema.json`](../schema/team.schema.json). Unknown fields are ignored.

```json
{
  "version": 1,
  "members": [
    { "handle": "aalhad", "github": "aalhadsawane",
      "agents": [
        { "name": "claude", "runtime": "claude-code", "wip": 2 },
        { "name": "codex", "runtime": "codex", "wip": 1 }
      ],
      "skills": ["backend"], "route_mentions_to_agent": true },
    { "handle": "ben", "github": "ben-github",
      "agent": { "enabled": true, "runtime": "claude-code", "wip": 2 } }
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
| `members[].agents[]` | the member's named agents; the first is the primary. Wins over `agent` if both are present | one agent |
| `members[].agents[].name` | `^[a-z0-9][a-z0-9-]{0,19}$`, unique per member; the agent id is `<handle>/<name>` | required |
| `members[].agents[].runtime` | free-form (`claude-code`, `codex`, ...); reviews prefer a different runtime than the author | `claude-code` |
| `members[].agents[].wip` | max claims that agent holds at once | `2` |
| `members[].agent` | legacy single agent `{enabled, runtime, wip}`; equals one entry in `agents` (none when `enabled: false`) | `{enabled: true}` |
| `members[].skills` | free-form routing tags | `[]` |
| `members[].route_mentions_to_agent` | an `@login` mention also adds a ping for the agent | `true` |
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

## Hooks

The Claude Code plugin registers three hooks. All of them exit 0, stay silent outside IssueMesh repos and never block a session on error.

| Hook | When | What |
|---|---|---|
| SessionStart | session opens | prints your GitHub queue summary |
| UserPromptSubmit | each prompt | runs `mesh inbox -q --new-only --min-interval 10`; if an item you have not been told about exists, adds one line of context ("IssueMesh: 2 new: #12 ping, #15 review (GitHub issues/PRs in this repo that need you: pings, reviews, assigned work). Finish your current task, then run /issuemesh:work."). At most one conditional request every 10 seconds, free when nothing changed. |
| Stop | Claude is about to stop | **Opt-in autopilot**, off unless `ISSUEMESH_AUTOPILOT=1`. If the same check finds new work, it blocks the stop once with "Run /issuemesh:work" so the session keeps going, at most `ISSUEMESH_AUTOPILOT_MAX` times per session (default 3; counter in `.git/issuemesh/`). It does nothing when Claude is already continuing because of a stop hook (`stop_hook_active`). |

The hooks read only GitHub (issues, PRs, labels of this repo) through `mesh inbox`; they never touch email or any other account. Turn them off with `ISSUEMESH_HOOKS=0` (all three IssueMesh hooks), unset `ISSUEMESH_AUTOPILOT` (Stop hook only), `"disableAllHooks": true` in Claude Code settings (every hook, no per-hook switch) or `/plugin` / `claude plugin disable issuemesh`.

Autopilot trade-off: each continuation spends model tokens (a full `/issuemesh:work` turn, with the context already loaded) in exchange for not waiting for you to type the command. Leave it off for interactive use; use it for long unattended sessions, and keep `ISSUEMESH_AUTOPILOT_MAX` low. Claude Code also caps consecutive stop-hook continuations itself.

## Optional: wake and a CI-hosted agent

Most teams do not need this; interactive sessions and `mesh watch` are simpler ([runners.md](runners.md)). To run an agent unattended on GitHub Actions:

1. Set `"wake": true` in `policy`. The referee then sends an `issuemesh-wake` `repository_dispatch` (payload `{handle, agent?, issue}`; `agent` is set for `to:<handle>/<agent>` and `ping:<handle>/<agent>`, and for `ping:<handle>` of a member with several agents, where it names the primary agent; `to:<handle>` names no agent) when a `to:` or `ping:` label is added for an agent-enabled member. The referee workflow needs `contents: write` for this; it ships with `contents: read`, so change that line when you turn wake on.
2. Each member who wants a CI agent runs `mesh init --with-agent-runner`, copies `.github/workflows/issuemesh-agent.yml` to `issuemesh-agent-<handle>.yml` (one file per agent for members with several), and replaces `HANDLE` (lowercase in the `if:`/`--as`/concurrency group, uppercase in secret names); the file's header says where to add `--agent`.
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
