# Runners

A **runner** is whatever starts your agent when it has work. The protocol does not care which you use; mix freely across members.

The key idea ([PROTOCOL.md](../PROTOCOL.md) section 6): a cheap deterministic check decides whether to start an expensive LLM session.

```bash
mesh inbox -q     # prints the count; exit 0 = work waiting, exit 10 = empty
```

## 1. Interactive (default)

You type the work command in your agent when you sit down or between tasks.

| Agent | How |
|---|---|
| Claude Code | `/issuemesh:work` (plugin). The session-start hook already prints your inbox. Also `/issuemesh:inbox` (read-only), `/issuemesh:triage`, `/issuemesh:review`, `/issuemesh:standup` |
| Codex, Cursor, Aider, Copilot | Put `prompt/ISSUEMESH.md` in the agent's instructions (or rely on the `AGENTS.md` block from `mesh init`) and say: "Run the IssueMesh work loop." |

A session processes at most 3 items, leaves every claim with a fresh status comment, then stops. Start a new session for more.

## 2. `mesh watch` (local loop)

Polls the inbox with jitter and exponential back-off and runs your command only when there is work.

```bash
mesh watch --exec "<command>" [--interval 300] [--max-interval 1800] [--once]
```

- Runs in a shell with `ISSUEMESH_HANDLE` and `ISSUEMESH_ACTOR=agent` set.
- Waits `--interval` seconds (default 300) after work; while the inbox stays empty the wait doubles up to `--max-interval` (default 1800). Every wait is jittered by 15%.
- Single-flight: a pid lock at `.git/issuemesh/watch.lock` prevents a second watcher in the same clone.
- `--once` checks once and exits, which is what you want in cron.

Examples:

```bash
# Claude Code, headless
mesh watch --exec "claude -p '/issuemesh:work'"

# Codex CLI
mesh watch --exec "codex exec 'Follow prompt/ISSUEMESH.md and run the work loop.'"

# Any agent that takes a prompt file or text (Aider shown)
mesh watch --exec "aider --yes --message-file prompt/ISSUEMESH.md"
```

Flags differ between versions of these tools and between permission modes: check your agent's `--help`, and give the headless run only the permissions it needs (see [security.md](security.md)). An agent run unattended needs a pre-approved allowlist for `mesh`, `gh`, `git` and your test commands.

Run it in `tmux`/`screen`, or as a launchd/systemd user service. Keep it in a clean clone dedicated to the agent so it does not fight with your own working tree.

## 3. Cron

```cron
*/20 9-18 * * 1-5  cd ~/code/team-repo && mesh watch --once --exec "claude -p '/issuemesh:work'" >> ~/.issuemesh.log 2>&1
```

Add `mesh sweep` here if you run without the referee, so dead claims are released.

## 4. GitHub Actions (unattended, optional)

Wake exactly the addressed member's agent in CI. Advanced; most teams skip it.

1. `"wake": true` in `policy` makes the referee send `repository_dispatch` `issuemesh-wake` with `{handle, issue}` when a `to:` or `ping:` label is added for an agent-enabled member.
2. Each member copies `.github/workflows/issuemesh-agent.yml` (`mesh init --with-agent-runner`) to their own file and replaces `HANDLE`.
3. Secrets per member: `ANTHROPIC_API_KEY_<HANDLE>` and `ISSUEMESH_TOKEN_<HANDLE>` (that member's fine-grained PAT).

The job installs `mesh`, runs `mesh --as <handle> inbox -q`, and only then starts the agent step (the shipped template uses `anthropics/claude-code-action@v1`). Other agents work the same way: replace that step with your agent's CLI and the prompt from `prompt/ISSUEMESH.md`. It uses `concurrency` (one run per member at a time) and `timeout-minutes: 45`. Set it up per [setup.md](setup.md#optional-wake-and-a-ci-hosted-agent).

## Cost control

- **Never poll with an LLM.** The inbox check costs a couple of GitHub API calls; tokens are spent only when it exits 0.
- **Bounded sessions**: 3 items maximum, short sessions beat long ones (context rot makes long ones worse as well as dearer).
- **Back-off**: tune `--interval` / `--max-interval`; use `--once` plus cron for office hours only.
- **WIP limit** (`agent.wip`, default 2) caps how much a single agent holds at once.
- **Targeted wakes**: referee wake sends one dispatch to the addressed member, not to everyone.
- **Cheaper models for cheap roles**: triage, standups and routing rarely need your most expensive model; point a second `mesh watch` loop (a different clone) at a smaller model if you want to.
- **`timeout-minutes`** on CI runs, and `human-only` / `/hold` on anything you do not want touched.
- **Loop guard** stops agent-to-agent ping-pong from burning tokens (`max_agent_streak`).

## Rate limits

Everything is a `gh` call. A 5-member mesh polling every 5 to 30 minutes uses a small fraction of the 5,000 requests/hour authenticated limit per user, since each member has their own token. Back-off and `--once` reduce it further.
