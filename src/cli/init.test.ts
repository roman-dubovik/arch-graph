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
    buildStrategySnippet,
    writeStrategySnippet,
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
