# Contributing

Thanks for helping. IssueMesh is small on purpose; changes that keep it small, boring and dependency-free are the easiest to merge.

## Ground rules

- **Zero runtime dependencies.** Node 18+ standard library and the `gh` CLI only. No `npm install` is needed to run or test anything.
- **GitHub is the only state.** No servers, databases or hosted components.
- **[PROTOCOL.md](PROTOCOL.md) is normative.** The CLI (`bin/`, `lib/`), the referee (`referee/`), the skills (`skills/`), the portable prompt (`prompt/ISSUEMESH.md`) and the templates implement it. A behavior change starts with a protocol change, in the same PR, and keeps all implementations in agreement.
- **Small teams first.** Features aimed at enterprise scale (SSO, audit, org-wide policy) are out of scope; see "What IssueMesh is not" in the README.
- **Design for agent failure modes.** New rules should name the failure they counter. [docs/design.md](docs/design.md) explains the approach; [docs/research.md](docs/research.md) holds sources.

## Layout

| Path | Contents |
|---|---|
| `bin/mesh`, `lib/` | the `mesh` CLI |
| `referee/` | the GitHub Action (runs via `actions/github-script`) |
| `skills/`, `hooks/`, `.claude-plugin/` | the Claude Code plugin |
| `prompt/ISSUEMESH.md` | portable prompt for other agents |
| `templates/` | files `mesh init` copies into a team repo |
| `schema/` | JSON schema for `team.json` |
| `test/` | tests (`node:test`, with fake `gh` and fake GitHub for the referee) |
| `docs/` | user and design documentation |

## Develop

```bash
git clone https://github.com/aalhadsawane/issuemesh && cd issuemesh
node --test               # whole suite (do not pass a directory argument)
node bin/mesh help        # try the CLI
node bin/mesh --dry-run claim 12   # --dry-run prints the gh calls it would make
```

CI runs `node --test` on Node 18, 20 and 22, checks that every JSON file parses and runs `bash -n hooks/session-start.sh`. Please run the first locally before opening a PR.

## Pull requests

- One logical change per PR, with tests for new behavior. Tests must not touch the network or a real GitHub repo.
- Update the docs, the prompt, the skills and `PROTOCOL.md` together when behavior changes, and document the real CLI surface only (check `mesh <cmd> -h`).
- Keep docs concise and technical, with terminology matching PROTOCOL.md. No decision histories in docs.
- Commit messages: short imperative subject; explain the *why* in the body.

## Reporting bugs and proposing changes

Open an issue. For bugs include versions (`node --version`, `gh --version`), the command, and output; redact tokens. For protocol changes describe the failure you saw in a real team and what the rule would change. Security reports: see [docs/security.md](docs/security.md).

## Dogfooding

This repo can use IssueMesh itself. If you contribute with an agent, follow the same rules the agents in your team do: receipts, scope discipline, no weakened tests.

## License

By contributing you agree your work is licensed under the [MIT License](LICENSE).
