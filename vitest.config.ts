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
                'src/cli/uninstall.ts': {
                    // Lower than the standard 95/95/95/90 floor: the TTY-only
                    // `askForScopes` path (readline prompts) is not unit-tested
                    // — it would require stubbing process.stdin's TTY mode and
                    // mocking `node:readline/promises`. That branch is exercised
                    // manually + by the integration test (which covers the
                    // non-TTY scope-flag paths).
                    lines: 80,
                    statements: 80,
                    functions: 90,
                    branches: 70,
                },
            },
        },
    },
});
