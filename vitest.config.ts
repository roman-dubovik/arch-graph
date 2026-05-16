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
            // 95% line coverage on files listed in thresholds.include.
            // Global thresholds are intentionally unset — perFile is enforced only
            // on the files listed below, keeping the gate scoped to agent-owned files.
            thresholds: {
                perFile: true,
                include: [
                    // Each tier-agent adds their owned files here.
                    // src/extractors/cycles/**
                    // src/extractors/di/filter-chain/**
                    // src/extractors/typeorm/relations/**
                    // src/extractors/imports/cjs/**
                    'src/extractors/typeorm/relations.ts',
                    'src/mapper/typeorm-to-graph.ts',
                ],
                // Per-file thresholds for owned files:
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
            },
        },
    },
});
