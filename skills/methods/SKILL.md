---
name: methods
description: Pick the published research method that fits an item's lifecycle stage, and record the artifact it produced.
when_to_use: When the work is about a literature review, research gaps, idea generation, experiments or codification, or paper writing; when someone asks which paper or method to use; before starting an item at one of those stages.
argument-hint: "[list | show <id> | suggest <issue> | use <issue> <id> --artifact <path> | report]"
allowed-tools: Bash, Read
---

# Research methods

`mesh util` maps an issue's lifecycle stage to the published method that fits it and records the artifact it produced.
It is a pointer, not a rule: an item may need no catalogue entry.

| Stage | Methods |
|---|---|
| literature-review | `llm-litreview` (LLM automated literature review (evaluation)), `surveygen` (SurveyGen) |
| gaps | `bagels` (BAGELS), `limitations-multiagent` (Multi-agent limitation generation), `llm-limitations` (Can LLMs identify critical limitations?) |
| ideation | `hyper` (HypER), `hypoevolve` (HypoEvolve), `researchagent` (ResearchAgent) |
| codification | `arbor` (Arbor), `autosota` (AutoSOTA), `deepscientist` (DeepScientist), `evoscientist` (EvoScientist) |

1. `mesh util suggest <issue>` — deterministic match on the issue text and stage words; it prints what matched.
2. `mesh util show <id>` — paper, inputs, outputs and a checklist before you start.
3. Do the work, then `mesh util use <issue> <id> --artifact <path>` — one note on the issue with `util=<id> artifact=<path>`; idempotent.
4. `mesh util report` — the receipt table (live comments plus any `used_in` recorded in `.issuemesh/utilities.json`).

Catalogue: `.issuemesh/utilities.json` overrides the 12 entries shipped with the package by id; add your own methods the same way.
