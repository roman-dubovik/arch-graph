# Code-Intel Stabilization And AI Setup Review

Status: draft plan after review of the current `codex-code-intel-v1` work.
Purpose: stabilize the CodeQL-like code-intel layer before merge, then clean up
the installation / hook / skill / agent setup story so the feature is useful
without surprising users.

## Executive Summary

The direction is strong: `arch-graph` now has a deterministic TypeScript/NestJS
code-intelligence sidecar for symbols, calls, flows, branches, impacts,
diagnostics, and early project policies. This is the right product shape for
token-efficient LLM work: agents ask compact CLI/MCP tools for proof packets
instead of reading large source files.

The current implementation is not merge-ready because several P1 issues can
produce stale or incorrect answers:

1. Sidecar schema changed but schema version and read compatibility did not.
2. Symbol identity is too short for monorepos and can silently drop duplicate
   class/method names.
3. MCP code-intel loader does not reload after `arch-graph code-intel build`.
4. The targeted code-intel test gate is red.
5. Branch artifacts currently include real reference-project names, domain
   symbols, and local paths. These are not secrets, but they are project
   fingerprints and must be sanitized before merge.

Fix these first. Then do cleanup, docs alignment, and installation-flow
optimization.

## Privacy / Sanitization Gate

Review result:

- No real secrets were found in the current scan (`TOKEN`, `SECRET`,
  `PASSWORD`, real API keys, e-mails).
- Synthetic test usage such as `process.env.API_KEY` is acceptable.
- Real project fingerprints were found and must not be merged as-is.

Findings:

- Real reference project names appear in bench fixtures, scripts, and plan docs:
  `project-alpha`, `project-beta`, `project-gamma`, `project-gamma-2.0`.
- Domain-specific symbols from those projects appear in benchmark fixtures and
  reports, including examples like:
  - controller/DTO names;
  - cron/scheduler service names;
  - payment/webhook-related names;
  - specific enum/constant names;
  - persistence/executor sink names.
- Local machine paths appear in generated reports and scripts:
  - `/Users/.../Documents/Projects/...`;
  - `<tmp>

Files requiring action before merge:

- `bench/code-intel/questions-project-alpha.json`
- `bench/code-intel/questions-project-beta.json`
- `bench/code-intel/questions-project-gamma.json`
- `bench/code-intel/quality-questions-projects.json`
- `bench/code-intel/results-test-projects-2026-05-22.md`
- `bench/code-intel/snapshot-2026-05-22-current.md`
- `bench/code-intel/quality-eval-2026-05-22-current.md`
- `scripts/run-ci-snapshot.js`
- `scripts/run-code-intel-quality-eval.js`
- `docs/plans/2026-05-21-codeql-like-code-intelligence.md`

Required remediation:

- Replace project names with neutral identifiers:
  - `project-alpha` -> `project-alpha`;
  - `project-beta` -> `project-beta`;
  - `project-gamma` / `project-gamma-2.0` -> `project-gamma`.
- Replace domain-specific symbols with neutral fixture-like names, or move the
  real-project eval fixtures out of the public repo entirely.
- Remove absolute local paths from committed reports. Use placeholders such as
  `<tmp>/arch-graph-code-intel-snapshot/*` and
  `<reference-project-root>/...`.
- Make benchmark scripts configurable through env vars or a local ignored config
  file instead of hardcoding project names and `/private/tmp` paths.
- Add `.gitignore` coverage for local benchmark outputs if they are not meant
  to be committed.

Recommended public shape:

- Commit synthetic quality fixtures that live inside this repo.
- Keep private/reference-project benchmark configs local-only.
- If a report is useful publicly, commit only aggregate metrics and neutralized
  examples.

Merge gate:

```sh
git diff <merge-base>...HEAD -- . \
  | rg -n "project-alpha|project-beta|project-gamma|/Users/|/private/tmp|Documents/Projects"
```

The command should return no matches except intentional synthetic examples or
documented placeholders.

## P1 Remediation Plan

### P1.1 Sidecar Schema Versioning And Tolerant Reads

Problem:

- `CodeIntelFlow` gained `toParam`, `sinkKind`, new `sourceKind` values.
- `CodeIntelCall` gained `conditions`.
- `CodeIntelSymbolKind` gained `db-entity`.
- `policies.jsonl` was added.
- `CODE_INTEL_SCHEMA_VERSION` is still `1`.
- `readCodeIntelIndex()` now unconditionally reads `policies.jsonl`, so older
  sidecars with schema `1` can fail with `ENOENT` instead of a clear rebuild
  instruction.

Plan:

- Bump `CODE_INTEL_SCHEMA_VERSION` to `2`.
- Add a manifest compatibility test proving old schema is rejected with a clear
  `arch-graph code-intel build` message.
- Add tolerant read helper for optional collections only if we intentionally
  support missing files within the same schema.
- Include `policies` in manifest counts or explicitly document it as advisory
  sidecar data outside counts.
- Rebuild reference-project sidecars and update quality reports after the bump.

Acceptance:

- Old schema fails clearly.
- Same-schema optional empty `policies.jsonl` round-trips.
- `src/code-intel/io.test.ts` is green.

### P1.2 File-Qualified Symbol Identity

Problem:

- `addSymbol()` dedupes by `symbol.fqn`.
- `fqn` is currently short: `CreateDto`, `UsersService.find`, `normalizeItem`.
- In large monorepos, duplicate names are normal. The second symbol is silently
  dropped, and downstream `resolve_symbol`, `trace_scenario`, `impact_contract`,
  call links, and flow links can point to the wrong file.

Plan:

- Keep human-readable `fqn` for display.
- Add stable unique identity that includes file and local range, for example:
  - `id: symbol:<relative-file>#<kind>:<fqn>:<line>:<column>`
  - or `symbol:<relative-file>#<exported-name>`.
- Replace `symbolByFqn` with:
  - `symbolsByFqn: Map<string, CodeIntelSymbol[]>`
  - `symbolsById: Map<string, CodeIntelSymbol>`
  - resolver helpers that use caller file/import context where possible.
- Update call resolution so a local `ItemsService.create` resolves in the same
  import/module context before falling back to ambiguous FQN matches.
- Update `resolveSymbol()` to return all matching duplicate symbols, ranked by
  exact FQN, path, kind, and quality.
- Add tests with two files exporting `CreateItemDto` and two services with the
  same method name.

Acceptance:

- No symbol is dropped because of duplicate short FQN.
- Ambiguous queries return multiple matches instead of silently choosing one.
- Calls resolve to the symbol in the imported/local file when that context is
  available.

### P1.3 MCP Code-Intel Reload

Problem:

- `makeGraphLoader()` reloads `graph.json` by mtime.
- `makeCodeIntelLoader()` caches once forever.
- After `arch-graph code-intel build`, MCP clients keep receiving stale facts
  until the MCP process restarts.

Plan:

- Add a code-intel loader that stats `code-intel/manifest.json` and reloads on
  mtime change.
- Mirror the graph loader's corrupt-write behavior: if a rebuild is mid-write,
  keep serving the last good index and log once.
- Add an MCP/unit test using a temporary sidecar, first returning one symbol,
  then rewriting sidecar and verifying the loader returns the new symbol.

Acceptance:

- MCP code-intel tools observe fresh sidecars after rebuild without restart.
- Torn writes do not crash sessions if a previous valid index exists.

### P1.4 Red Test Gate

Current failing gate:

```sh
npm test -- src/code-intel/diagnostics.test.ts src/code-intel/extractor.test.ts src/code-intel/io.test.ts src/code-intel/queries.test.ts src/mcp/code-intel.test.ts src/cli/index.test.ts
```

Observed failures:

- `extractor.test.ts`: expected placement policy `DTO location: src/*/*.ts`,
  implementation returns `DTO location: src/dto/*.ts`.
- `io.test.ts`: round-trip expected no `policies`, reader returns
  `policies: []`.

Plan:

- Decide intended policy generalization:
  - If exact directory is desired, update the test to `src/dto/*.ts`.
  - If generalized `src/*/*.ts` is desired, change the inference algorithm.
- Update IO fixture to include `policies: []`, or preserve undefined when the
  collection is absent by design.
- Run the targeted gate and `git diff --check`.

Acceptance:

- Targeted code-intel suite is green.
- Failure mode is not hidden by relaxing assertions too far.

## Cleanup Plan After P1

### C1 API Surface Freeze For v1

The CLI/MCP surface has grown beyond the originally documented five tools:

- `outline`
- `blueprint`
- `policies`
- `suggest-placement`
- `validate-proposal`
- `summary`
- `self-check`

Plan:

- Split commands into two tiers:
  - Stable v1: `build`, `resolve-symbol`, `explain-flow`, `explain-branch`,
    `trace-scenario`, `impact-contract`, `diagnostics`, `outline`,
    `summary/self-check`.
  - Experimental: `blueprint`, `policies`, `suggest-placement`,
    `validate-proposal`.
- Add `experimental: true` wording in docs/help for policy/blueprint commands
  until they have stronger fixtures.
- Align README, website, `claude-md.template.md`, and `skill/SKILL.md` with
  the same tool count and names.

### C2 CLI UX Consistency

Problems:

- `arch-graph code-intel build --help` currently runs a build instead of
  printing help.
- Some skill docs mention `--json` / `--table`, but code-intel commands always
  emit JSON and do not parse these flags.
- `suggest-placement <name> --symbol <kind>` is awkward; `--kind` is clearer.

Plan:

- Add `--help` handling for `code-intel` and every subcommand.
- Either implement `--json` / `--table` or remove those options from docs.
- Rename `--symbol` to `--kind` for placement/proposal commands, preserving
  `--symbol` as a deprecated alias if needed.
- Add CLI parse tests for each public subcommand.

### C3 Query Correctness And Ranking

Plan:

- Add deterministic ranking tests for:
  - duplicate symbols;
  - exact FQN vs path match;
  - sink-bearing data-flow facts before low-signal local facts;
  - `traceScenario` excludes external/framework calls.
- Keep proof packets small by default and include `maxResults` in all expensive
  query surfaces.

### C4 Bench Discipline

Plan:

- Keep `bench/code-intel/quality-questions-projects.json` as the quality gate.
- Add “expected current status” to the report header:
  - `8/8 PASS` is the target after Control Flow v2.
  - Current known failing category: branch lookup by line.
- Add a benchmark runner mode that rebuilds sidecars before evaluating, so old
  sidecar facts cannot make a new code change look worse or better.
- Do not commit generated `arch-graph-out/`; commit only question fixtures and
  markdown reports that document intentional baselines.

## Installation / Init / Hook / Skill Review

### Current Installation Flow

Current behavior:

1. `scripts/install.sh`
   - installs or updates `~/.arch-graph`;
   - installs dependencies;
   - asks for a global AI environment;
   - symlinks `arch-graph`;
   - offers to run `arch-graph init` in the original directory.
2. `arch-graph init`
   - writes `arch-graph.config.ts`;
   - asks project AI environments;
   - can install Claude integration and git hook;
   - can run structural/semantic build.
3. `arch-graph claude install --skill`
   - writes marker-delimited CLAUDE.md block;
   - installs skill.
4. `arch-graph hook install`
   - pre-commit validates structural graph only;
   - post-commit can rebuild structural graph and semantic sidecar.

Assessment:

- The overall shape is good: global installer should stay thin, project setup
  belongs in `init`.
- Re-opening `/dev/tty` in installer is the correct fix for `curl | sh`.
- Marker-delimited CLAUDE updates are the right idempotency model.
- Keeping generated `arch-graph-out/` local and gitignored is correct.

Risks:

- The installer now asks a global AI question before project init. This can feel
  like two setup systems: global AI setup and per-project AI setup.
- `claude-md.template.md` currently instructs agents to run experimental
  commands as mandatory (`policies`) before coding. That is too strong until
  policy inference is stabilized.
- The skill says pre-commit keeps graph coherent, but current pre-commit only
  runs `arch-graph build --quiet` and does not build `code-intel`. Therefore
  code-intel can be stale even when structural graph is fresh.
- Agent hook `SessionStart.sh` runs `arch-graph code-intel summary --json`, but
  code-intel summary does not parse `--json`; harmless today, but sloppy and
  confusing.

### Recommended Setup Model

Use three layers:

1. Global install:
   - install binary;
   - no project writes;
   - optional global agent preference only if it materially changes future
     defaults.
2. Project init:
   - writes config;
   - writes `.gitignore`;
   - installs CLAUDE/skill/cursor/gemini snippets;
   - installs hook;
   - runs initial structural build;
   - optionally runs semantic and code-intel builds.
3. Maintenance hooks:
   - pre-commit: fast validation only;
   - post-commit or manual: heavier sidecars (`semantic`, `code-intel`);
   - MCP reloads sidecars by mtime.

### Hook Strategy

Recommended defaults:

- Pre-commit:
  - run `arch-graph build --quiet`;
  - do not stage generated files;
  - do not run semantic by default;
  - optionally run `arch-graph code-intel build --quiet` only behind
    `--include-code-intel` because large projects can add seconds.
- Post-commit:
  - run `arch-graph build --quiet || true`;
  - run `arch-graph code-intel build --quiet || true`;
  - optionally run incremental `semantic build --quiet || true`.
- Manual:
  - `arch-graph code-intel build` remains the explicit source of truth before
    deep code-intel questions.

Rationale:

- Structural graph is fast enough and already part of the product contract.
- Code-intel is useful but heavier and currently advisory.
- Semantic model download/build is too expensive for pre-commit.

### Skill / Plugin Optimization

Current skill is useful but too assertive in places.

Plan:

- Update `skill/SKILL.md` and `claude-md.template.md` to say:
  - Run `arch-graph code-intel self-check` or `summary` first when code-intel
    is needed.
  - If stale/missing, run `arch-graph code-intel build` or fall back to
    structural graph/grep with an explicit caveat.
  - `policies` and `blueprint` are experimental advisory tools, not mandatory
    gates for all coding.
- Add a short “tool choice” flow:
  - architecture dependency question -> structural graph commands;
  - fuzzy discovery -> semantic search;
  - method/DTO/data-flow question -> code-intel;
  - implementation style question -> blueprint/policies, experimental.
- Keep the skill installed by `arch-graph claude install --skill`, but avoid
  writing separate snippet files by default if `CLAUDE.md` can be safely updated
  between markers.

Plugin packaging:

- Today the “plugin” is effectively a Claude skill plus MCP server docs.
- A true plugin should be considered only after code-intel schema and MCP tool
  names stabilize.
- Until then, ship as:
  - CLI;
  - MCP server;
  - Claude skill;
  - marker-delimited CLAUDE.md block.

## Proposed Execution Order

1. Fix P1.4 red tests first so the suite tells the truth.
2. Fix P1.1 schema version/read compatibility.
3. Fix P1.2 symbol identity.
4. Fix P1.3 MCP reload.
5. Rebuild reference sidecars and rerun:
   - targeted code-intel tests;
   - smoke snapshot;
   - quality eval;
   - `git diff --check`.
6. Cleanup CLI/help/docs/skill wording.
7. Decide hook defaults for `code-intel build`:
   - likely post-commit default, pre-commit opt-in.
8. Only then continue Control Flow v2.

## Merge Gate

Do not merge this branch until:

- Targeted code-intel suite is green.
- Old sidecar schema fails with a clear rebuild message.
- Duplicate symbol fixture passes.
- MCP reload fixture passes.
- README / docs site / CLAUDE template / skill agree on:
  - number and names of MCP tools;
  - which commands are stable vs experimental;
  - hook behavior for structural graph, semantic sidecar, and code-intel
    sidecar.
