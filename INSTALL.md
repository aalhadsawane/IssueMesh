# Install IssueMesh and join a team repo

This file is written for **coding agents**. A human can also follow it top to bottom.
Typical request: *"install the app in the repo aalhadsawane/IssueMesh and use it for https://github.com/OWNER/REPO"*.

Do the steps in order. Stop and tell your human only where a step says **ASK**.

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

Without a global npm install, clone and run in place: `git clone --depth 1 --branch v1 https://github.com/aalhadsawane/issuemesh ~/.issuemesh-src` then use `~/.issuemesh-src/bin/mesh`.

## 2. Add the agent instructions

- **Claude Code** (recommended): install the plugin. Run in a shell (not inside a session):
  ```bash
  claude plugin marketplace add aalhadsawane/issuemesh
  claude plugin install issuemesh@issuemesh
  ```
  If those commands are unavailable, tell the human to run `/plugin marketplace add aalhadsawane/issuemesh` and `/plugin install issuemesh@issuemesh` inside Claude Code, then restart the session. You get `/issuemesh:work` and friends.
- **Any other agent** (Codex, Cursor, Aider, Copilot, ...): nothing to install. Once you are inside the team repo (step 3), its `AGENTS.md` already points at the rules. Save the full portable prompt once:
  ```bash
  mkdir -p .issuemesh && curl -fsSL https://raw.githubusercontent.com/aalhadsawane/issuemesh/v1/prompt/ISSUEMESH.md -o .issuemesh/ISSUEMESH.md
  ```
  Then follow `.issuemesh/ISSUEMESH.md` whenever your human says "work the mesh".

## 3. Get the team repo

```bash
gh repo clone OWNER/REPO && cd REPO      # skip if you are already inside it
test -f .issuemesh/team.json && echo "IssueMesh is set up here"
```

Check Issues are on: `gh repo view --json hasIssuesEnabled -q .hasIssuesEnabled` must print `true`. If it prints `false` (forks start that way), **ASK** the repo owner to enable Settings → General → Features → Issues; nothing in IssueMesh works without it.

No `.issuemesh/team.json`: the team has not set IssueMesh up yet. Setup is a one-time job for the repo owner, see [docs/setup.md](docs/setup.md) (`mesh init --member handle:login ...`). **ASK** the human whether you should do it.

## 4. Join the team

```bash
mesh join --dry-run          # shows the entry (handle derived from the human's GitHub login)
mesh join                    # add --handle <short-name> or --agents claude,codex to customize
```

`mesh join` only edits `.issuemesh/team.json`. Share it as a PR so the owner can review:

```bash
git switch -c chore/join-<handle>
git add .issuemesh/team.json
git commit -m "chore(issuemesh): add <handle> to the team"
git push -u origin chore/join-<handle>
gh pr create --fill
```

If you cannot push to the repo, **ASK** the human to get write access (or to have the owner add them to `team.json`).

## 5. Verify

After the PR is merged (or on your branch for a quick check):

```bash
mesh doctor      # gh, config, labels, Board, referee workflow
mesh whoami      # your handle, agent, triage duty, claims
mesh inbox       # what needs you now
```

## 6. Use it

- Claude Code: `/issuemesh:work`
- Others: "follow `.issuemesh/ISSUEMESH.md`"
- Hands-off loop: `mesh watch --exec "claude -p '/issuemesh:work'"` ([docs/runners.md](docs/runners.md))

## What this touches (and does not)

Installing adds the `mesh` CLI (and, for Claude Code, the plugin with its hooks). The CLI and hooks make read-only GitHub API calls to the one team repo to compute your queue and print a short summary; they never read email or any other account, and they are silent in repos without `.issuemesh/team.json`. Details and how to switch them off: [docs/security.md](docs/security.md).

## Updating

```bash
npm i -g github:aalhadsawane/issuemesh#v1
claude plugin update issuemesh        # Claude Code plugin
```
