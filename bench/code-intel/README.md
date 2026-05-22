# arch-graph code-intel self questions

This folder contains 10 real LLM-facing questions about arch-graph's own code.
They are designed to exercise the CodeQL-like `code-intel` sidecar, not semantic
search.

## How to run manually

```bash
arch-graph code-intel build --config ./arch-graph.config.ts --out ./arch-graph-out
```

Then ask the LLM the `question` text from `questions-arch-graph.json`. The LLM
should choose the listed `tool` / `cli` shape and verify that the answer contains
the `expectedContains` strings.

Latest manual run: `results-arch-graph-2026-05-22.md`.

## Coverage

| ID | Capability | Question focus |
|----|------------|----------------|
| CI1 | symbol | `runBuild` declaration and signature |
| CI2 | call-graph | `runBuild` internal pipeline order |
| CI3 | data-flow | `cfg` propagation inside `runBuild` |
| CI4 | control-flow | `semanticSearch` `minScore` filter |
| CI5 | symbol | MCP semantic handler factory |
| CI6 | control-flow | MCP graph loader corrupt-write fallback |
| CI7 | data-flow | CLI args into `explainDataFlow` |
| CI8 | impact | `SemanticManifest` contract references |
| CI9 | symbol | `SearchResponse` fields |
| CI10 | control-flow | TypeORM ManyToMany join-table materialization |
