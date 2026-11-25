# Research toolkit: point agents at published methods, and keep the receipts

A research project moves through stages — literature review, gap finding, ideation,
codification, writing — and each stage has published methods that are easy to lose
track of once work is split across agents and issues. `mesh util` keeps a small
catalogue of those methods next to the work, suggests the one that fits an item's
stage, and records the artefact it produced on the issue itself.

It is deliberately small: a JSON catalogue, five commands, and a ledger made of
issue comments. It is not a research-agent runtime; it points at papers and asks
the agent to read their methods, not at an API.

## Quick start

```sh
mesh util list                 # the catalogue, grouped by stage
mesh util suggest 42           # what fits this issue, and why (deterministic)
mesh util show arbor           # the card: paper, inputs, outputs, checklist
mesh util use 42 arbor --artifact codification/ITERATION_2.md
mesh util report               # the receipt table
```

`suggest` prints the phrases it matched, so a wrong suggestion is visible instead
of silently steering the work:

```
Research utilities that fit #8 "Task 5: write the Introduction ...":
  1. limitations-multiagent — Multi-agent limitation generation [gaps] score 10
     matched: stage:gaps, "research gap", "limitations"
  2. bagels — BAGELS [gaps] score 6
     matched: stage:gaps, "extraction"
```

Nothing is posted until `use`. That command adds one `type=note` comment with
`util=<id> artifact=<path>` in the marker, which is what `report` reads:

```
Recorded arbor on #42 (comment 3412).
```

## The catalogue

Twelve methods ship with the package (`lib/utilities/defaults.json`), covering the
four stages above. A repository adds or overrides entries in
`.issuemesh/utilities.json`; overrides are **partial**, so recording usage of a
shipped entry needs one line:

```json
{
  "version": 1,
  "utilities": [
    {
      "id": "researchagent",
      "status": "used",
      "used_in": [{ "issue": 6, "artifact": "ideation/REPORT.md", "commit": "e5f3383", "recorded": "retroactive" }]
    },
    {
      "id": "sota-diffusion-check",
      "name": "SOTA table check",
      "stage": ["codification"],
      "paper": { "title": "…", "arxiv": "2604.05550" },
      "when": ["state of the art", "benchmark", "baseline"],
      "inputs": ["dataset", "metric"],
      "outputs": ["checked SOTA table"],
      "checklist": ["pin the split", "reproduce the baseline before comparing"]
    }
  ]
}
```

A full entry has: `id`, `name`, `stage` (one or more of `literature-review`,
`gaps`, `ideation`, `codification`, `writing`), `paper` (`title`, `arxiv`),
`what`, `when` (phrases `suggest` matches), `inputs`, `outputs`, `cost`
(`cpu` or `gpu`), `checklist`, `status` (`used`, `available`,
`not-applicable`), and `used_in`.

`mesh util list` merges the two files by id and shows which entries are marked
used. `mesh doctor` checks the merged catalogue and fails on a bad stage, a
duplicate id or malformed JSON.

## Receipts: why comments, not a file

The ledger is the set of verified `type=note` comments carrying `util=`. That
means every receipt has a GitHub author and timestamp, cannot be edited by a
later commit, and survives a fresh clone; a committed JSON ledger would drift and
could be rewritten. `mesh util report` therefore merges two sources:

- **comment** — recorded at the time with `mesh util use`;
- **retroactive** — `used_in` entries in the catalogue, for work done before the
  toolkit existed. They carry a commit where possible and are labelled, so a
  reader can tell a live receipt from a reconstruction.

`report --all` includes closed issues (the default scans open issues only).
Markers whose `from=` does not match the comment's GitHub author are ignored, as
everywhere in IssueMesh.

## Worked example

A course project used four of these methods across its four assignments. The team
catalogue recorded them retrospectively, with the artefact each one produced:

| Utility | Stage | Artefact | Recorded |
|---|---|---|---|
| SurveyGen | literature review | `litreview/REPORT.md` | retroactive |
| Multi-agent limitation generation | gaps | `limitations/REPORT.md` | retroactive |
| ResearchAgent | ideation | `ideation/REPORT.md` | retroactive |
| Arbor | codification | `codification/ITERATION_1.md` | retroactive |

`mesh util report` prints exactly that table, plus a `used / total` line. Rows
recorded with `use` appear as `comment` instead.

## Exporting the skill

The same catalogue can be dropped into an agent runtime as a skill:

```sh
mesh util export --format claude   # .claude/skills/issuemesh-methods/SKILL.md
mesh util export --format opencode # .opencode/skill/issuemesh-methods/SKILL.md
mesh util export --format agents   # docs/research-methods.md + an AGENTS.md pointer
```

The Claude Code plugin already ships the skill as `methods`; the export is for
repos and runtimes that do not use the plugin. `--force` overwrites.

## Design notes

- **Deterministic, no model call.** `suggest` matches stage words and the `when`
  phrases of each entry, and prints what matched. No API key, no cost, and a bad
  suggestion is explainable.
- **No protocol change.** Usage is a normal `note` with two extra marker keys,
  which the spec already allows ("unknown keys are ignored").
- **Not a rule.** An item may need no catalogue entry; `suggest` says so.
- **Stage, not topic.** The catalogue maps methods to the *kind of work*, which
  is what makes it reusable across projects; the paper metadata is only a pointer
  to the method's details.
