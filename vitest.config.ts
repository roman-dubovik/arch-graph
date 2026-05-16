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
                // The `coverage.include` allowlist below precisely scopes collection.
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
            // 95% line coverage on files matched by `thresholds.include`. Agents add
            // their new files here; the threshold is enforced per-file so
            // a low-coverage existing file can't pull a new one under.
            thresholds: {
                lines: 95,
                statements: 95,
                functions: 95,
                branches: 90,
                perFile: true,
                include: [
                    // Each tier-agent adds their owned files here.
                    // src/extractors/cycles/**
                    // src/extractors/di/filter-chain/**
                    // src/extractors/typeorm/relations/**
                    // src/extractors/imports/cjs/**
                    'src/detectors/cycles.ts',
                    'src/output/graph-mermaid.ts',
                ],
            },
        },
    },
});
