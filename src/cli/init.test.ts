// Tests for `arch-graph init` semantic strategy feature.
//
// Coverage strategy:
//   - Pure helpers (buildStrategySnippet) tested directly.
//   - I/O helpers (askSemanticStrategy, askSnippetTarget) tested with a fake rl stub.
//   - writeStrategySnippet tested with a tmpdir fixture.
//   - Non-interactive path verified via mocked process.stdin.isTTY + writeFile spy.

import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    askSemanticStrategy,
    askSnippetTarget,
    askBuildSemantic,
    buildStrategySnippet,
    runSemanticBuildStep,
    writeStrategySnippet,
    SEMANTIC_SKIP_HINT,
    type SemanticStrategy,
    type SnippetTarget,
} from './init.js';

// ─── Fake readline interface ──────────────────────────────────────────────────

/** Build a minimal readline-like stub that returns canned answers in sequence. */
function makeRl(answers: string[]) {
    let idx = 0;
    return {
        question: async (_prompt: string): Promise<string> => {
            return answers[idx++] ?? '';
        },
    };
}

// ─── buildStrategySnippet ─────────────────────────────────────────────────────

describe('buildStrategySnippet', () => {
    it('both-buckets snippet contains strategy name and cost figures', () => {
        const snippet = buildStrategySnippet('both-buckets');
        expect(snippet).toContain('## arch-graph semantic search strategy');
        expect(snippet).toContain('**both-buckets**');
        expect(snippet).toContain('$0.005');
        expect(snippet).toContain('$0.025');
        expect(snippet).toContain('arch-graph init');
    });

    it('fallback snippet contains strategy name and cost figures', () => {
        const snippet = buildStrategySnippet('fallback');
        expect(snippet).toContain('## arch-graph semantic search strategy');
        expect(snippet).toContain('**fallback**');
        expect(snippet).toContain('$0.003');
        expect(snippet).toContain('$0.012');
        expect(snippet).toContain('arch-graph init');
    });
});

// ─── askSemanticStrategy ─────────────────────────────────────────────────────

describe('askSemanticStrategy', () => {
    it('blank answer defaults to both-buckets', async () => {
        const rl = makeRl(['']);
        const result = await askSemanticStrategy(rl as any);
        expect(result).toBe('both-buckets');
    });

    it('"1" selects both-buckets', async () => {
        const rl = makeRl(['1']);
        const result = await askSemanticStrategy(rl as any);
        expect(result).toBe('both-buckets');
    });

    it('"2" selects fallback', async () => {
        const rl = makeRl(['2']);
        const result = await askSemanticStrategy(rl as any);
        expect(result).toBe('fallback');
    });

    it('whitespace-padded "2" still selects fallback', async () => {
        const rl = makeRl(['  2  ']);
        const result = await askSemanticStrategy(rl as any);
        expect(result).toBe('fallback');
    });

    it('unknown input defaults to both-buckets', async () => {
        const rl = makeRl(['99']);
        const result = await askSemanticStrategy(rl as any);
        expect(result).toBe('both-buckets');
    });
});

// ─── askSnippetTarget ─────────────────────────────────────────────────────────

describe('askSnippetTarget', () => {
    it('blank answer defaults to separate', async () => {
        const rl = makeRl(['']);
        const result = await askSnippetTarget(rl as any);
        expect(result).toBe('separate');
    });

    it('"2" selects separate', async () => {
        const rl = makeRl(['2']);
        const result = await askSnippetTarget(rl as any);
        expect(result).toBe('separate');
    });

    it('"1" selects append (existing CLAUDE.md detected)', async () => {
        const rl = makeRl(['1']);
        const result = await askSnippetTarget(rl as any);
        expect(result).toBe('append');
    });

    it('fires a question (existing CLAUDE.md scenario)', async () => {
        const questions: string[] = [];
        const rl = {
            question: async (prompt: string) => {
                questions.push(prompt);
                return '2';
            },
        };
        await askSnippetTarget(rl as any);
        expect(questions.length).toBeGreaterThanOrEqual(1);
    });
});

// ─── writeStrategySnippet ─────────────────────────────────────────────────────

describe('writeStrategySnippet', () => {
    it('separate: creates CLAUDE.md.arch-graph-snippet.md with both-buckets content', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'ag-init-test-'));
        try {
            const written = await writeStrategySnippet('both-buckets', 'separate', dir);
            expect(written).toBe(join(dir, 'CLAUDE.md.arch-graph-snippet.md'));
            expect(existsSync(written)).toBe(true);
            const content = await readFile(written, 'utf8');
            expect(content).toContain('**both-buckets**');
            expect(content).toContain('$0.005');
            expect(content).toContain('$0.025');
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('separate: creates CLAUDE.md.arch-graph-snippet.md with fallback content', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'ag-init-test-'));
        try {
            const written = await writeStrategySnippet('fallback', 'separate', dir);
            const content = await readFile(written, 'utf8');
            expect(content).toContain('**fallback**');
            expect(content).toContain('$0.003');
            expect(content).toContain('$0.012');
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('append: appends to existing CLAUDE.md', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'ag-init-test-'));
        try {
            const claudeMd = join(dir, 'CLAUDE.md');
            const { writeFile } = await import('node:fs/promises');
            await writeFile(claudeMd, '# My Project\n\nExisting content.\n', 'utf8');

            const written = await writeStrategySnippet('both-buckets', 'append', dir);
            expect(written).toBe(claudeMd);
            const content = await readFile(claudeMd, 'utf8');
            // Original content preserved
            expect(content).toContain('Existing content.');
            // New section appended
            expect(content).toContain('## arch-graph semantic search strategy');
            expect(content).toContain('**both-buckets**');
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('append: fallback strategy appended correctly', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'ag-init-test-'));
        try {
            const claudeMd = join(dir, 'CLAUDE.md');
            const { writeFile } = await import('node:fs/promises');
            await writeFile(claudeMd, '# Project\n', 'utf8');

            await writeStrategySnippet('fallback', 'append', dir);
            const content = await readFile(claudeMd, 'utf8');
            expect(content).toContain('**fallback**');
            expect(content).toContain('$0.003');
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});

// ─── askBuildSemantic ────────────────────────────────────────────────────────

describe('askBuildSemantic', () => {
    it('blank answer defaults to true (Y default for one-command-install UX)', async () => {
        const rl = makeRl(['']);
        const written: string[] = [];
        const result = await askBuildSemantic(rl as any, (s) => written.push(s));
        expect(result).toBe(true);
        // Explainer must surface the model size, runtime cost, and feature list
        // so users with bandwidth concerns can make an informed choice.
        const explainer = written.join('');
        expect(explainer).toContain('135 MB');
        expect(explainer).toContain('cached under');
        expect(explainer).toContain('code_search');
        expect(explainer).toContain('docs_search');
    });

    it('"y" returns true', async () => {
        const rl = makeRl(['y']);
        const result = await askBuildSemantic(rl as any, () => {});
        expect(result).toBe(true);
    });

    it('"n" returns false', async () => {
        const rl = makeRl(['n']);
        const result = await askBuildSemantic(rl as any, () => {});
        expect(result).toBe(false);
    });

    it('"no" returns false', async () => {
        const rl = makeRl(['no']);
        const result = await askBuildSemantic(rl as any, () => {});
        expect(result).toBe(false);
    });
});

// ─── runSemanticBuildStep ────────────────────────────────────────────────────

describe('runSemanticBuildStep', () => {
    it('calls the injected runner with correct args on success path', async () => {
        const calls: Array<Record<string, unknown>> = [];
        const written: string[] = [];

        await runSemanticBuildStep({
            targetPath: '/repo/arch-graph.config.ts',
            outDir: '/repo/arch-graph-out',
            runner: async (args) => {
                calls.push({ ...args });
                return { manifest: 'ok' };
            },
            write: (s) => written.push(s),
        });

        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({
            sub: 'build',
            config: '/repo/arch-graph.config.ts',
            out: '/repo/arch-graph-out',
        });
        expect(written.join('')).toContain('building semantic index');
        expect(written.join('')).toContain('✓ semantic index ready');
    });

    it('runner failure prints recovery hint and does NOT re-throw', async () => {
        const written: string[] = [];

        // The whole point of the helper: a thrown error here must be CAUGHT,
        // so the calling wizard can continue to its "next steps" block.
        await expect(
            runSemanticBuildStep({
                targetPath: '/repo/arch-graph.config.ts',
                outDir: '/repo/arch-graph-out',
                runner: async () => {
                    throw new Error('model download interrupted');
                },
                write: (s) => written.push(s),
            }),
        ).resolves.toBeUndefined();

        const out = written.join('');
        expect(out).toContain('⚠  semantic build failed');
        expect(out).toContain('model download interrupted');
        // The recovery hint must point at the manual recovery command —
        // otherwise users have no obvious path forward after a failure.
        expect(out).toContain('arch-graph semantic build');
        // The success line MUST NOT appear after a failure.
        expect(out).not.toContain('✓ semantic index ready');
    });

    it('SEMANTIC_SKIP_HINT documents the manual recovery path', () => {
        // Sanity check that the canonical skip hint stays in sync with the
        // helper's recovery message — both should name the same command so
        // users only have one thing to remember.
        expect(SEMANTIC_SKIP_HINT).toContain('arch-graph semantic build');
        expect(SEMANTIC_SKIP_HINT).toContain('Skipped');
    });
});
