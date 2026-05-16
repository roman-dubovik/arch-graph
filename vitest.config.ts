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
                'src/cli/**',
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
            },
        },
    },
});
