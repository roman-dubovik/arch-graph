import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['src/**/*.test.ts'],
        exclude: ['node_modules', 'dist', 'arch-graph-out', 'poc', '.worktrees'],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json-summary', 'html'],
            reportsDirectory: './coverage',
            exclude: [
                'node_modules/**',
                'dist/**',
                'arch-graph-out/**',
                'poc/**',
                // NOTE: '.worktrees/**' is intentionally omitted here — picomatch
                // with `contains:true` would exclude source files when vitest runs
                // *from inside* a worktree (path contains `.worktrees/`).
                '**/*.test.ts',
                '**/__fixtures__/**',
                // Per-file: leave src/cli/ files OUT of coverage by default;
                // include the ones with dedicated test files explicitly via the
                // perFile thresholds map below (uninstall.ts is one).
                'src/cli/index.ts',
                'src/cli/init.ts',
                'src/cli/claude.ts',
                'src/cli/hooks.ts',
                'src/cli/compare-command.ts',
                'src/cli/query-commands.ts',
                'src/cli/build-tips.ts',
                'src/cli/skill.ts',
                'src/cli/marker-block.ts',
                'src/cli/semantic-commands.ts',
                // project-registry.ts is INCLUDED in coverage (per-file threshold below)
                'src/mcp/**',
                'src/compare/**',
                'bench/**',
                'scripts/**',
                'skill/**',
                'configs/**',
                'docs/**',
                'vitest.config.ts',
            ],
            // Per-file thresholds: each tier-agent's owned files are gated at
            // 95% lines / 95% statements / 95% functions / 90% branches.
            // Global thresholds are intentionally absent so unrelated files
            // (shared utilities, legacy code) don't fail the suite.
            thresholds: {
                perFile: true,
                'src/detectors/cycles.ts': {
                    lines: 95,
                    statements: 95,
                    functions: 95,
                    branches: 90,
                },
                'src/output/graph-mermaid.ts': {
                    lines: 95,
                    statements: 95,
                    functions: 95,
                    branches: 90,
                },
                'src/extractors/di/filter-chain.ts': {
                    lines: 95,
                    statements: 95,
                    functions: 95,
                    branches: 90,
                },
                'src/mapper/di-to-graph.ts': {
                    lines: 95,
                    statements: 95,
                    functions: 95,
                    branches: 90,
                },
                'src/extractors/typeorm/relations.ts': {
                    lines: 95,
                    statements: 95,
                    functions: 95,
                    branches: 90,
                },
                'src/mapper/typeorm-to-graph.ts': {
                    lines: 95,
                    statements: 95,
                    functions: 95,
                    branches: 90,
                },
                'src/extractors/imports/extractor.ts': {
                    lines: 95,
                    statements: 95,
                    functions: 95,
                    branches: 90,
                },
                'src/mapper/imports-to-graph.ts': {
                    lines: 95,
                    statements: 95,
                    functions: 95,
                    branches: 90,
                },
                'src/cli/project-registry.ts': {
                    // Lower than the standard 95/95/95/90 by a couple of points:
                    // a secondary-catch branch (rename-also-failed when the bad
                    // file can't even be moved aside) is defensive and not
                    // exercised in tests — that path requires a filesystem in
                    // a half-broken state we can't easily simulate hermetically.
                    lines: 90,
                    statements: 90,
                    functions: 95,
                    branches: 80,
                },
                'src/cli/uninstall.ts': {
                    // Lower than the standard 95/95/95/90 floor: the TTY-only
                    // `askForScopes` + `askYesNo` paths (readline prompts) are
                    // not unit-tested — they'd require stubbing process.stdin's
                    // TTY mode and mocking `node:readline/promises`. Those
                    // branches are exercised manually + by the integration test
                    // (which covers the non-TTY scope-flag paths).
                    lines: 80,
                    statements: 80,
                    functions: 85,
                    branches: 70,
                },
                // Task 3 — Semantic search CLI (standard gate: 95/95/95/90)
                'src/semantic/search.ts': {
                    lines: 95,
                    statements: 95,
                    functions: 95,
                    branches: 90,
                },
                // Task 2 — Semantic build CLI (standard gate: 95/95/95/90)
                'src/semantic/builder.ts': {
                    lines: 95,
                    statements: 95,
                    functions: 95,
                    branches: 90,
                },
                // Task 1 — Semantic foundation (standard gate: 95/95/95/90)
                'src/semantic/types.ts': {
                    lines: 95,
                    statements: 95,
                    functions: 95,
                    branches: 90,
                },
                'src/semantic/embedder.ts': {
                    lines: 95,
                    statements: 95,
                    functions: 95,
                    branches: 90,
                },
                'src/semantic/snippet.ts': {
                    lines: 95,
                    statements: 95,
                    functions: 95,
                    branches: 90,
                },
                'src/semantic/io.ts': {
                    lines: 95,
                    statements: 95,
                    functions: 95,
                    branches: 90,
                },
                // Track A — FE Level 1 (standard gate: 95/95/95/90)
                'src/extractors/fe/react-patterns.ts': {
                    lines: 95,
                    statements: 95,
                    functions: 95,
                    branches: 90,
                },
                'src/extractors/fe/router-patterns.ts': {
                    lines: 95,
                    statements: 95,
                    functions: 95,
                    branches: 90,
                },
                'src/extractors/fe/extractor.ts': {
                    lines: 95,
                    statements: 95,
                    functions: 95,
                    branches: 90,
                },
                'src/mapper/fe-to-graph.ts': {
                    lines: 95,
                    statements: 95,
                    functions: 95,
                    branches: 90,
                },
                'src/validation/fe-validator.ts': {
                    lines: 95,
                    statements: 95,
                    functions: 95,
                    branches: 90,
                },
            },
        },
    },
});
