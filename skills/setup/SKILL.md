---
name: setup
description: Guided IssueMesh setup for a repo owner - scaffold team.json, labels, Board, issue templates and AGENTS.md block, then run doctor.
when_to_use: When the user wants to adopt IssueMesh in a repository or fix a failing `mesh doctor`.
argument-hint: "[handle:login ...]"
disable-model-invocation: true
allowed-tools: Bash, Read, Edit, Write
---

# /issuemesh:setup

Run in the repo root, on a clean branch (or main if the owner agrees). Prerequisites: `gh`
installed and authenticated with write access, Node >= 18. This changes shared state
(labels, a pinned issue); confirm the plan with the user before step 4.

1. `mesh doctor`. Note what is already in place; do not redo it.
2. **Team**: if `.issuemesh/team.json` is missing, collect members (`handle:github-login`, from `$ARGUMENTS` or ask the user). Handles match `^[a-z0-9][a-z0-9-]{0,19}$`, unique, not `referee`. Ask who is on triage rotation and whether any member has no agent (`agent.enabled: false`). Do not guess logins.
3. Run `mesh init --member aalhad:aalhadsawane --member ben:ben-github ...` (one `--member` per person). Add `--all` to also create labels, templates, Board and AGENTS.md/CLAUDE.md blocks. Never pass `--force` unless the user approves overwriting.
4. Verify: `mesh labels sync`, then `mesh doctor` must pass. Fix what it reports (usually: gh auth, missing labels, `board_issue`).
5. Optional referee (recommended, no secrets needed): confirm `.github/workflows/issuemesh-referee.yml` exists; if not, tell the user to copy it from the IssueMesh repo `templates/.github/workflows/` (or `mesh init --templates`). Explain it enforces claims, slash commands and lease expiry; without it agents enforce the rules themselves (`mesh sweep`).
6. Optional CI agent runner: describe `templates/.github/workflows/issuemesh-agent.yml`, mark it advanced; do not install it unless asked. It needs per-member secrets, which you never create.
7. Show the user the diff (`git status`, `git diff --stat`), commit only if asked, and tell each member to install the plugin: `/plugin marketplace add aalhadsawane/issuemesh` then `/plugin install issuemesh@issuemesh`, and to run `/issuemesh:work`.

## Do not
- Do not push, commit or merge without being asked.
- Do not put tokens or API keys anywhere in the repo.
- Do not overwrite existing issue templates, workflows or team.json without `--force` and consent.
