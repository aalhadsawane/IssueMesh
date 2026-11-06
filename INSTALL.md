# Install IssueMesh, then join a repo or set one up

This file is written for **coding agents**. A human can follow it too.

You were probably asked something like:

> Use `aalhadsawane/IssueMesh` with `OWNER/REPO` and join as an agent.   *(the repo already uses IssueMesh)*
> Set up `aalhadsawane/IssueMesh` on `OWNER/REPO` and add me as a member.   *(the repo does not use it yet)*

Do steps 0 to 2, then **step 3 decides your path**. Stop and tell your human only where a step says **ASK**.

## 0. Check prerequisites

```bash
node --version      # needs v18 or newer
gh auth status      # must be logged in as the human you work for
git --version
```

- No Node 18+: **ASK** the human to install it (https://nodejs.org). Do not install system packages without asking.
- `gh` not logged in: **ASK** the human to run `gh auth login`. Never ask for or paste tokens in chat.

## 1. Install the `mesh` CLI

```bash
npm i -g github:aalhadsawane/issuemesh#v1
mesh --help
```

Without a global npm install: `git clone --depth 1 --branch v1 https://github.com/aalhadsawane/issuemesh ~/.issuemesh-src` and use `~/.issuemesh-src/bin/mesh`.

## 2. Add the agent instructions

- **Claude Code** (recommended): run in a shell (not inside a session)
  ```bash
  claude plugin marketplace add aalhadsawane/issuemesh
  claude plugin install issuemesh@issuemesh
  ```
  If those commands are unavailable, tell the human to run `/plugin marketplace add aalhadsawane/issuemesh` then `/plugin install issuemesh@issuemesh` inside Claude Code, and restart the session. You get `/issuemesh:work` and friends.
- **Any other agent** (Codex, Cursor, Aider, Copilot, ...): nothing to install. Save the portable prompt once, inside the repo you work on:
  ```bash
  mkdir -p .issuemesh && curl -fsSL https://raw.githubusercontent.com/aalhadsawane/issuemesh/v1/prompt/ISSUEMESH.md -o .issuemesh/ISSUEMESH.md
  ```
  Then follow `.issuemesh/ISSUEMESH.md` whenever your human says "work the mesh".

## 3. Get the repo and pick your path

```bash
gh repo clone OWNER/REPO && cd REPO      # skip if you are already inside it
gh repo view --json hasIssuesEnabled -q .hasIssuesEnabled     # must print true
test -f .issuemesh/team.json && echo "uses IssueMesh" || echo "does not use IssueMesh yet"
```

- Prints `false`: forks start with Issues off. **ASK** a repo admin to enable Settings → General → Features → Issues. Nothing works without it.
- `uses IssueMesh` → **Path A (join)**.
- `does not use IssueMesh yet` and your human asked you to set it up → **Path B (set up)**. If they only asked you to join, **ASK** who owns the setup.

## Path A: join an existing team

```bash
mesh join --dry-run          # shows the entry; handle comes from the human's GitHub login
mesh join                    # --handle <short-name>, --agents claude,codex to customize
git switch -c chore/join-<handle>
git add .issuemesh/team.json
git commit -m "chore(issuemesh): add <handle> to the team"
git push -u origin chore/join-<handle>
gh pr create --fill
```

`mesh join` only edits `.issuemesh/team.json`; the PR lets the owner review it. If you cannot push, **ASK** the human to get write access (or to have the owner add them). Then go to step 4.

## Path B: set up IssueMesh in this repo (once per repo)

Needs admin or write access. Use the real GitHub logins of everyone on the team (**ASK** the human for the list; `handle:login` pairs):

```bash
git switch -c chore/issuemesh-setup
mesh init --member alice:alice-gh --member bob:bob-gh      # include the human you work for
git add .issuemesh .github; for f in AGENTS.md CLAUDE.md; do [ -f "$f" ] && git add "$f"; done
git commit -m "chore(issuemesh): set up IssueMesh"
git push -u origin chore/issuemesh-setup && gh pr create --fill
```

`mesh init` writes `.issuemesh/team.json`, issue forms, a PR template, the referee workflow and a short block in `AGENTS.md`/`CLAUDE.md` (existing customized blocks are kept; a `CLAUDE.md` that imports `AGENTS.md` is left alone), and creates the labels and the pinned Board **when you have write access and Issues are on**.

After the PR is merged:

1. Settings → Actions → General: allow Actions, and workflow permissions "Read and write".
2. If `mesh init` could not create the labels or Board, run the referee's setup once: `gh workflow run issuemesh-referee.yml -f task=setup` (or Actions → IssueMesh Referee → Run workflow → `setup`).
3. Tell the teammates the join prompt (README → Install).

## 4. Verify

```bash
mesh doctor      # gh, Issues, config, labels, Board, referee workflow
mesh whoami      # your handle, agent, triage duty, claims
mesh inbox       # what needs you now
```

`mesh` reads `.issuemesh/team.json` from the checkout, or from the default branch on GitHub when your branch has none.

## 5. Use it

- Claude Code: `/issuemesh:work`
- Others: "follow `.issuemesh/ISSUEMESH.md`"
- Hands-off loop: `mesh watch --exec "claude -p '/issuemesh:work'"` ([docs/runners.md](docs/runners.md))

## What this touches (and does not)

Installing adds the `mesh` CLI (and, for Claude Code, the plugin with its hooks). The CLI and hooks make read-only GitHub API calls to the one team repo to compute your queue and print a short summary. They never read email or any other account, and they are silent in repos without `.issuemesh/team.json`. Details and how to switch them off: [docs/security.md](docs/security.md).

## Updating

```bash
npm i -g github:aalhadsawane/issuemesh#v1
claude plugin update issuemesh        # Claude Code plugin
```
