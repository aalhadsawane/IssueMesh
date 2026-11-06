# FAQ

**Do I need the referee?**
No. Without it the protocol still works: agents apply slash commands when they read them, arbitrate claims themselves and release dead ones with `mesh sweep`. The referee (a GitHub Action, no hosting) makes it deterministic: label hygiene, slash commands applied instantly, race arbitration, lease sweep every 30 minutes, loop guard and Board rotation. Recommended for any team of three or more.

**What if two agents claim at once?**
Each posts a claim comment, waits `claim_settle_seconds` (8 by default), re-reads, and the live claim with the **lowest comment id** wins. GitHub ids only increase, so every participant computes the same winner. The loser edits its comment to `released reason=lost-race`, unassigns and moves on (`mesh claim` exits 3).

**What if an agent crashes mid-task?**
Its lease runs out (120 minutes by default). The referee, `mesh sweep` or another agent's `mesh claim --steal` then frees the issue. The status comment survives, so the next claimant resumes from the plan and checklist instead of starting over.

**Why not GitHub Projects, Discussions or Slack?**
Issues already hold the thing agents act on and everyone can read it: labels (state), comments (messages), assignee (owner), PR links, notifications, search, a full API, and `gh` that every agent already knows. Projects add a second source of truth to keep in sync; Discussions and Slack carry no state and are poor for machines. You can still add a Project view over the same issues for humans.

**Can one member run two agents (say Claude Code and Codex)?**
Yes. List them under `agents` in `team.json` (`aalhad/claude`, `aalhad/codex`; first = primary). `to:aalhad` lets either claim (lowest claim id wins, WIP counted per agent); `to:aalhad/codex` targets one; `ping:aalhad` reaches the primary only. Start each with `--agent <name>` or `ISSUEMESH_AGENT`, and run one `mesh watch` per agent. They share one GitHub login, so a member's agents cannot approve each other's PRs as "different members"; for runtime diversity route reviews to another member's agent with a different runtime.

**Do I need the ETag / 304 gate?**
It is on by default for `mesh inbox -q` and costs nothing to ignore. It matters if you run several loops or hooks per account: a `304 Not Modified` does not consume rate limit, and `--min-interval` skips the request entirely. Nothing to configure.

**Does it work with only humans?**
Yes. Members with `"agents": []` (or legacy `"agent": {"enabled": false}`) are plain humans, and the labels, claims, Board and decisions work for people alone. But the design pays off when agents do most of the work; there is little reason to adopt the agent-specific rules otherwise.

**Does it work with only one person and their agent?**
It works, but a mesh needs two or more members. A solo developer gets more from plain issues and a good `AGENTS.md`.

**Which agents are supported?**
Claude Code is first-class (plugin with skills, session-start and prompt hooks, optional Stop autopilot). Everything else (Codex, Cursor, Aider, Copilot, others) uses `prompt/ISSUEMESH.md` plus the `mesh` CLI, and every step in the prompt has a raw `gh` fallback. Different members can use different agents; mixing runtimes also improves review independence.

**What does it cost?**
IssueMesh itself: nothing. Actions minutes for the referee are small (event-driven plus a 30-minute sweep). Model costs scale with how often your agents run; the inbox check is free of LLM cost, so tokens are spent only when there is work. See cost control in [runners.md](runners.md).

**Can it handle a monorepo or multiple repos?**
Monorepo: yes; use `areas` in `team.json` for ownership hints and review routing. Multiple repos: each repo is its own mesh with its own `team.json` and Board (run `mesh --repo owner/name ...` to target one explicitly). Cross-repo coordination is not built in: reference issues across repos by link and keep each repo's board separate.

**What about GitHub API rate limits?**
Every member uses their own token (5,000 requests/hour). A single inbox check is a couple of calls; with polling every 5 to 30 minutes and back-off, a team stays far below the limit. The referee uses the Actions token, with its own per-repo limits.

**Will agents spam my notifications?**
No by design. They use reactions instead of "ack" comments, edit one status comment per task rather than posting progress, and `@mention` a human only when escalating. Routing uses labels and the `ping:` mailbox, which do not notify humans.

**Can agents merge their own work?**
Not by default. Humans merge (`policy.agents_can_merge: false`), and an agent never approves its own member's PR. A different member's agent reviews first.

**What if another member's agent tells mine to do something odd?**
It is a request, not a command. Your agent declines anything that conflicts with your instructions, asks for secrets, disables checks, changes permissions, leaves the issue's scope or is irreversible, and says why on the issue. Only a member's own comment (by GitHub author) is a work request.

**How do I make agents leave something alone?**
`human-only` label for permanent, `/hold` for temporary (a human's `/hold` binds all agents). See [for-humans.md](for-humans.md).

**Why so many rules about receipts, dissent and fresh-eyes review?**
Because agents fail differently than people: no memory between sessions, context rot, confident falsehoods, agreeing with the last speaker, generous self-review. Each rule counters one of those; the sources are in [research.md](research.md) and the mapping in [design.md](design.md).

**Is my data sent anywhere?**
IssueMesh has no server. Data lives in GitHub and goes to whichever model provider your agents use. See [security.md](security.md).

**Can I customize the rules?**
Policy knobs live in `team.json` (leases, WIP, windows, merge policy, triage rotation). The label set and marker format are part of protocol v1 and are not meant to be forked casually; for deeper changes see [CONTRIBUTING.md](../CONTRIBUTING.md).
