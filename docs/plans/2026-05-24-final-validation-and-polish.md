# Final Validation & Polish — arch-graph codex-code-intel-v1

Date: 2026-05-24
Status: in-progress (team-lead orchestration)

## Goal
Close the 6 remaining gaps from honest readiness review to push branch
`codex-code-intel-v1` from ~85% confidence to 95%+ before merge.

## Context
The branch already has:
- 1538/1541 tests, tsc 0 errors, sanitization 0/26, targeted P1.4 gate 52/52
- Full install/uninstall cycle manually verified on /tmp/ag-arena
- 4 PR-review agents cleared all critical/important findings

Remaining gaps that block 95%+ confidence:
- A. Real pipeline (arch build + code-intel build + sample queries) never run on this very repo
- B. bench/run.test.ts flake unverified against main
- C. Cursor upgrade path (file with both marker pairs) untested
- D. MCP handlers (30 tools) lack behavioural smoke invocation tests
- E. manifest.warnings (ambiguousFqns + skippedFiles) not surfaced in selfCheck
- F. commands.ts (CLI handlers) lack direct smoke tests for missing-sidecar / bad args

## File-touch matrix

| Task | Files | Touches | Wave |
|------|-------|---------|------|
| A — real pipeline smoke | (read-only against current branch) | none | 1 |
| B — flake check on main | (read-only) | none | 1 |
| C — cursor upgrade path | (read-only against /tmp arena) | none | 1 |
| E — surface warnings | `src/code-intel/queries.ts`, `src/code-intel/queries.test.ts` | small additive | 2 (TDD) |
| D — MCP handler smoke | `src/mcp/code-intel.test.ts` | additive ~50 LOC | 2 |
| F — commands CLI smoke | `src/code-intel/commands.test.ts` (new file) | new test file | 2 |

**No file conflicts across tasks.** A/B/C parallel, E→D→F sequential (single shared
worktree on current branch `codex-code-intel-v1`; commits land directly there since
this is itself the feature branch).

## Acceptance Criteria

### Task A — Real pipeline smoke
- A1. `./bin/arch-graph build` returns exit 0 with no thrown exceptions.
- A2. `./bin/arch-graph code-intel build` returns exit 0; `arch-graph-out/code-intel/manifest.json` exists with `schemaVersion: 2`.
- A3. `./bin/arch-graph code-intel summary` and `code-intel resolve-symbol extractCodeIntel` return non-empty results.
- A4. If extractor's `skippedFiles` is non-empty, agent surfaces the list with reasons (not a silent count).
- A5. Report includes `node-count`, `edge-count`, `code-intel symbols count`, exit codes for each step.

### Task B — Flake check on main
- B1. `git stash && git checkout main && npm test -- src/bench/run.test.ts && git checkout codex-code-intel-v1 && git stash pop` runs cleanly.
- B2. Agent reports: PASSED on main → my branch did not regress; FAILED on main → pre-existing flake confirmed.

### Task C — Cursor upgrade path
- C1. `.cursorrules` with BOTH `<!-- arch-graph:cursor -->` AND legacy `# >>> arch-graph >>>` blocks: `arch uninstall --repo .` finds it in inventory.
- C2. After `--project --yes`, both marker pairs are stripped; user content (e.g. `# Мои правила`) survives.
- C3. `arch claude install` followed by re-install does not produce duplicate blocks.

### Task E — Surface manifest.warnings in selfCheck
- E1. `selfCheck()` return type adds `warnings?: { ambiguousFqns: string[]; skippedFiles: Array<{ file: string; error: string }> }`.
- E2. When warnings exist, status flips from `'ok'` to a new `'degraded'` value with a message describing the count.
- E3. Unit test for E1+E2 in `queries.test.ts` covering both empty and non-empty warnings.

### Task D — MCP handler smoke tests
- D1. New `describe('MCP handler smoke', …)` in `src/mcp/code-intel.test.ts`.
- D2. For each of the 16 code-intel MCP tools (`resolve_symbol`, `get_file_outline`, `get_type_definition`, `find_references`, `get_blueprint`, `get_project_policies`, `get_orientation`, `self_check`, `suggest_placement`, `validate_proposal`, `explain_data_flow`, `explain_branch`, `trace_scenario`, `trace_exceptions`, `trace_message_flow`, `impact_contract`): smoke-invoke the underlying queries.ts function with a minimal fixture index. Assert: handler doesn't throw, return shape is JSON-stringifiable.
- D3. Fixture index built inline (no temp dirs); reuse minimal CodeIntelIndex from queries.test.ts.

### Task F — CLI smoke for commands.ts
- F1. New `src/code-intel/commands.test.ts`.
- F2. Per public subcommand (`build`, `summary`, `self-check`, `outline`, `blueprint`, `policies`, `suggest-placement`, `validate-proposal`, `resolve-symbol`, `explain-flow`, `explain-branch`, `trace-scenario`, `trace-exceptions`, `trace-message-flow`, `impact-contract`, `find-references`, `get-type-definition`, `diagnostics`): smoke-invoke via `runCodeIntelCommand({ sub, out: '<missing-dir>' })` and assert it throws/reports clear error containing "run: arch-graph code-intel build".
- F3. At least one per-subcommand test that argv parse errors (missing required positional) produce exit code 2 or thrown Error with usage hint.

## Patterns to follow
- Test style: vitest, see `src/code-intel/queries.test.ts` for fixture style.
- Error messages: see P0-D ENOENT pattern in `src/code-intel/io.ts:50-56`.
- Agent reporting: paste exact CLI output, not summaries.

## Execution order
1. **Wave 1 (parallel, read-only):** A (sonnet — needs interpretation), B (haiku — mechanical), C (haiku — mechanical).
2. **Wave 2 — TDD for E, then D, then F (sequential — same branch):**
   - 2a. Team-lead writes RED tests for E (Phase 2.8).
   - 2b. Sonnet implements E to GREEN.
   - 2c. Sonnet adds D handler smoke.
   - 2d. Sonnet adds F CLI smoke.
3. **Phase 4–8.5:** typecheck + full suite, pr-review-toolkit, fix loop, advisor.

## NOT in scope
- New features beyond making warnings visible.
- Changes to MCP `inputSchema` shape (already done).
- Restructuring code-intel CLI surface (deferred per advisor).

## Risks
- A may discover real extractor bugs on full arch-graph repo — those become P1 of this session, not "separate ticket".
- D may surface zod-validation gaps in `inputSchema` — if so, fix here (same branch).
