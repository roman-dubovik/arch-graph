/**
 * Unit tests for src/cli/hooks.ts — hook install with semantic build integration.
 *
 * Covers:
 *   1. Default install (no flag): hook body contains `arch-graph semantic build --quiet || true`.
 *   2. --no-include-semantic: hook body does NOT contain `arch-graph semantic build`.
 *   3. parseHookArgs: --no-include-semantic parsed correctly.
 *   4. Re-install is idempotent.
 *   5. Switching semantic mode on re-install updates the hook body.
 */
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { hookInstall, parseHookArgs, preCommitHookPath, postCommitHookPath } from './hooks.js';

// ---------------------------------------------------------------------------
// Test directory lifecycle
// ---------------------------------------------------------------------------

let testDir: string;

beforeEach(async () => {
    testDir = join(
        tmpdir(),
        `arch-graph-hooks-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    // Set up a fake git repo.
    await mkdir(join(testDir, '.git', 'hooks'), { recursive: true });
});

afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// parseHookArgs — --no-include-semantic
// ---------------------------------------------------------------------------

describe('parseHookArgs', () => {
    it('no flags → noIncludeSemantic is falsy', () => {
        const { args } = parseHookArgs(['install', '--repo', testDir]);
        expect(args.noIncludeSemantic).toBeFalsy();
    });

    it('--no-include-semantic → noIncludeSemantic = true', () => {
        const { args } = parseHookArgs(['install', '--repo', testDir, '--no-include-semantic']);
        expect(args.noIncludeSemantic).toBe(true);
    });

    it('--mode and --no-include-semantic coexist', () => {
        const { args } = parseHookArgs(['install', '--mode', 'post-commit', '--no-include-semantic', '--repo', testDir]);
        expect(args.mode).toBe('post-commit');
        expect(args.noIncludeSemantic).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// hookInstall — default (semantic included)
// ---------------------------------------------------------------------------

describe('hookInstall — default (semantic build included)', () => {
    it('pre-commit hook body contains semantic build invocation', async () => {
        await hookInstall({ repo: testDir, mode: 'pre-commit' });

        const hookPath = preCommitHookPath(testDir);
        const body = await readFile(hookPath, 'utf8');

        expect(body).toContain('arch-graph semantic build --quiet || true');
        expect(body).toContain('arch-graph-out/semantic/manifest.json');
        expect(body).toContain('arch-graph-out/semantic/embeddings.jsonl');
    });

    it('post-commit hook body contains semantic build invocation', async () => {
        await hookInstall({ repo: testDir, mode: 'post-commit' });

        const hookPath = postCommitHookPath(testDir);
        const body = await readFile(hookPath, 'utf8');

        expect(body).toContain('arch-graph semantic build --quiet || true');
    });
});

// ---------------------------------------------------------------------------
// hookInstall — --no-include-semantic
// ---------------------------------------------------------------------------

describe('hookInstall — --no-include-semantic', () => {
    it('pre-commit hook body does NOT contain semantic build', async () => {
        await hookInstall({ repo: testDir, mode: 'pre-commit', noIncludeSemantic: true });

        const hookPath = preCommitHookPath(testDir);
        const body = await readFile(hookPath, 'utf8');

        expect(body).not.toContain('arch-graph semantic build');
        // But structural build is still present.
        expect(body).toContain('arch-graph build --quiet || exit 1');
    });

    it('post-commit hook body does NOT contain semantic build', async () => {
        await hookInstall({ repo: testDir, mode: 'post-commit', noIncludeSemantic: true });

        const hookPath = postCommitHookPath(testDir);
        const body = await readFile(hookPath, 'utf8');

        expect(body).not.toContain('arch-graph semantic build');
        expect(body).toContain('arch-graph build --quiet || true');
    });
});

// ---------------------------------------------------------------------------
// Re-install idempotency and mode-switching
// ---------------------------------------------------------------------------

describe('hookInstall — re-install', () => {
    it('re-installing with same args is idempotent (replaces block in-place)', async () => {
        await hookInstall({ repo: testDir, mode: 'pre-commit' });
        await hookInstall({ repo: testDir, mode: 'pre-commit' });

        const hookPath = preCommitHookPath(testDir);
        const body = await readFile(hookPath, 'utf8');

        // Marker block appears exactly once.
        const startMatches = body.match(/# >>> arch-graph >>>/g) ?? [];
        expect(startMatches).toHaveLength(1);
    });

    it('switching from default (semantic) to --no-include-semantic removes semantic block', async () => {
        // Install with semantic enabled (default).
        await hookInstall({ repo: testDir, mode: 'pre-commit' });
        let body = await readFile(preCommitHookPath(testDir), 'utf8');
        expect(body).toContain('arch-graph semantic build');

        // Re-install with --no-include-semantic.
        await hookInstall({ repo: testDir, mode: 'pre-commit', noIncludeSemantic: true });
        body = await readFile(preCommitHookPath(testDir), 'utf8');
        expect(body).not.toContain('arch-graph semantic build');
    });

    it('switching from --no-include-semantic to default re-adds semantic block', async () => {
        // Install without semantic.
        await hookInstall({ repo: testDir, mode: 'pre-commit', noIncludeSemantic: true });
        let body = await readFile(preCommitHookPath(testDir), 'utf8');
        expect(body).not.toContain('arch-graph semantic build');

        // Re-install with semantic enabled.
        await hookInstall({ repo: testDir, mode: 'pre-commit' });
        body = await readFile(preCommitHookPath(testDir), 'utf8');
        expect(body).toContain('arch-graph semantic build --quiet || true');
    });
});
