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
            // Threshold enforcement is per-file, scoped to files listed in `include`.
            // Global threshold numbers are intentionally absent so that files outside
            // `include` (e.g. shared utilities with partial test coverage) do not
            // fail the suite. Agents add their owned files to the `include` array;
            // the per-file 95%/90% bar applies only to those files.
            thresholds: {
                perFile: true,
                include: [
                    // Each tier-agent adds their owned files here.
                    // src/extractors/cycles/**
                    // src/extractors/di/filter-chain/**
                    // src/extractors/typeorm/relations/**
                    // src/extractors/imports/cjs/**
                    'src/extractors/di/filter-chain.ts',
                    'src/mapper/di-to-graph.ts',
                ],
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
            },
        },
    },
});
