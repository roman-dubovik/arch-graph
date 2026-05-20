# Design: arch-graph init wizard — `.gitignore` integration

Date: 2026-05-20

## Goal

`arch-graph init` should offer to add `arch-graph-out/` to the project's `.gitignore` so the user doesn't have to remember the README hint. Idempotent, TTY-prompted, non-TTY auto-added with `--yes`.

## File-touch matrix

| Task | Files (exact paths) | Touches |
|------|---------------------|---------|
| 1 — gitignore helper + wizard integration | `/Users/romandubovik/Documents/Projects/arch-graph/src/cli/init.ts` | new helper `ensureArchGraphOutGitignored()` + call between semantic-build step and "Next steps" hint |
| 2 — tests | `/Users/romandubovik/Documents/Projects/arch-graph/src/cli/init.test.ts` | new `describe('ensureArchGraphOutGitignored', ...)` block |

No other files. No package.json changes. No README rewrites in this PR (the README's existing reminder line at line 68 stays — it remains accurate when the user declines or runs init in a stripped-down env).

## Patterns to follow

- Match the existing helper style: `askYesNo` for prompts (line 215 of init.ts), `existsSync` + `readFile`/`writeFile` from `node:fs/promises` (already imported pattern in test file).
- Non-TTY detection mirrors existing logic — there's an `isTTY` shape used elsewhere; reuse the same idiom.
- Atomic write: `writeFile(path + '.tmp', content)` then `rename(path + '.tmp', path)`.
- Test pattern from `src/cli/init.test.ts`: pure helpers tested directly via `mkdtemp` tmpdir fixture; prompt helpers tested with a fake `rl` stub via `makeRl(['y'])`/`makeRl(['n'])`.

## External constraints

- Must NOT break the existing `Use .gitignore when scanning .md?` prompt at line 387 — that's a separate concern (controls scanner inclusion) and lives in `askDocs()`.
- Must NOT use `git add -A` or otherwise touch git state.
- TypeScript: pass `npx tsc --noEmit 2>&1 | grep -v __fixtures__ | grep -cE 'error TS'` at the existing 5-error baseline.
- Vitest: 1433 passing baseline + the new tests should add ~6-10 tests; final count expected ~1440.

## Acceptance Criteria

### Task 1 — helper + integration

- **AC1.1** New exported helper: `ensureArchGraphOutGitignored(opts: { repoRoot: string; rl?: Rl; nonInteractive?: boolean; write?: (s: string) => void }): Promise<{ action: 'added' | 'created' | 'already-present' | 'declined' | 'no-gitignore-declined' }>`.
  - `repoRoot` = absolute path to the project being initialized.
  - `rl` = readline interface for prompts; when `nonInteractive=true`, `rl` is unused and the answer is implicitly "yes".
  - `write` = output sink (matches existing wizard pattern).
- **AC1.2** Pattern detection — the helper considers `arch-graph-out` already-gitignored if `.gitignore` contains ANY line (after stripping leading/trailing whitespace) matching one of:
  - `arch-graph-out`
  - `arch-graph-out/`
  - `/arch-graph-out`
  - `/arch-graph-out/`
  - `**/arch-graph-out`
  - `**/arch-graph-out/`
  Comment-only lines (starting with `#`) and blank lines are skipped. Lines containing `arch-graph-out` as a substring of a longer pattern (e.g. `arch-graph-out-backup`) MUST NOT count as a match.
- **AC1.3** When `.gitignore` exists and `arch-graph-out` is already ignored → return `{ action: 'already-present' }`, no prompt, no write, no output.
- **AC1.4** When `.gitignore` exists and `arch-graph-out` is NOT ignored:
  - Interactive: prompt `Add 'arch-graph-out/' to .gitignore? [Y/n] ` (default Y). On Y → append `arch-graph-out/` to the file with a leading newline if the existing file doesn't end with `\n`. Return `{ action: 'added' }`. On N → return `{ action: 'declined' }`, no write.
  - Non-interactive (`nonInteractive=true`): append (same write logic). Return `{ action: 'added' }`.
- **AC1.5** When `.gitignore` does NOT exist:
  - Interactive: prompt `No .gitignore found. Create one with 'arch-graph-out/'? [Y/n] ` (default Y). On Y → create file containing `arch-graph-out/\n`. Return `{ action: 'created' }`. On N → return `{ action: 'no-gitignore-declined' }`.
  - Non-interactive: create. Return `{ action: 'created' }`.
- **AC1.6** Atomic write — use `writeFile(path + '.tmp', content)` then `rename(path + '.tmp', path)`. Partial writes on Ctrl-C must not leave a broken `.gitignore`.
- **AC1.7** Wizard integration point: call `ensureArchGraphOutGitignored` in `runInitWizard` AFTER the semantic-build step (after lines ~700-715 that handle `askBuildSemantic` + `runSemanticBuildStep`) and BEFORE the `Next steps:` block. Pass `repoRoot=targetPath`, the wizard's `rl`, `write: (s) => output.write(s)`, and `nonInteractive` derived from existing isTTY/--yes detection.
- **AC1.8** When the action is `added` or `created`, print a single confirmation line to output: `  ✓ added arch-graph-out/ to .gitignore` (or `  ✓ created .gitignore with arch-graph-out/`).
- **AC1.9** Tests — unit tests for the new code, covering happy path + at least one error/edge branch, must be added in the same commit. The tests must run as part of the project's `test` target and pass.
- **AC1.10** No regression — `npx tsc --noEmit 2>&1 | grep -v __fixtures__ | grep -cE 'error TS'` stays at 5; `pnpm test` total goes UP (new tests added), 0 failing, 1 skipped flake preserved.

### Test coverage required (Task 2)

- **T1** `arch-graph-out/` already present in non-empty `.gitignore` → `{ action: 'already-present' }`, file unchanged (byte-equal).
- **T2** `.gitignore` exists without entry, TTY user answers Y → file gains `arch-graph-out/` on its own line with proper newline handling (file ends with `\n`).
- **T3** `.gitignore` exists without entry, TTY user answers N → `{ action: 'declined' }`, file byte-equal.
- **T4** No `.gitignore` file, TTY user answers Y → file created with exactly `arch-graph-out/\n`.
- **T5** No `.gitignore` file, TTY user answers N → `{ action: 'no-gitignore-declined' }`, file does NOT exist.
- **T6** Non-interactive (`nonInteractive: true`) with missing `.gitignore` → file created automatically, no prompt called.
- **T7** Substring false-positive: `.gitignore` containing only `arch-graph-out-backup/` → helper still adds `arch-graph-out/` (substring NOT a match).
- **T8** Comment false-positive: `.gitignore` containing only `# arch-graph-out/` → helper still adds `arch-graph-out/` (comments don't count).
- **T9** Idempotency: run helper twice on same tmpdir — second run returns `already-present` and doesn't duplicate the line.
- **T10** Pattern variants: each of the 6 detection patterns from AC1.2 individually triggers `already-present`.

## Out of scope (explicit)

- Symmetric removal in `arch-graph uninstall` — separate task, not part of this PR. Could be future-work.
- Editing existing README reminder line — stays as-is; remains accurate as a fallback for declined / stripped-down environments.
- Multi-level / nested `.gitignore` walking — only the top-level `.gitignore` at `repoRoot` is considered.
- Honoring `core.excludesfile` (global gitignore) — out of scope; if a user has it set up, the helper's "not already present" path may add a redundant line. Acceptable trade-off.
- Adding to existing `git ls-files --check-ignore` based detection — simpler to keep with plain pattern-match.
