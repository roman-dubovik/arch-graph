/**
 * Unit tests for src/cli/semantic-commands.ts — arg parsing and table-mode
 * output behaviour.
 *
 * Coverage note: semantic-commands.ts is excluded from the per-file coverage
 * gate (vitest.config.ts). Tests here verify correctness of F3/F4/F5 fixes
 * from round-2 PR review.
 *
 * Process.exit is mocked so the parser is exercisable without killing the
 * test runner.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseSemanticArgs, runSemanticSearch, runSemanticBuild } from './semantic-commands.js';

// ---------------------------------------------------------------------------
// Test directory lifecycle (for runSemanticSearch integration tests)
// ---------------------------------------------------------------------------

let testDir: string;

beforeEach(async () => {
    testDir = join(
        tmpdir(),
        `arch-graph-semcli-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(testDir, { recursive: true });
    await mkdir(join(testDir, 'semantic'), { recursive: true });
});

afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
    vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// F4 — --k NaN guard
// ---------------------------------------------------------------------------

describe('parseSemanticArgs — --k validation (F4)', () => {
    it('calls process.exit(1) and writes to stderr for NaN --k value', () => {
        const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
            throw new Error('process.exit');
        }) as never);

        expect(() => parseSemanticArgs(['search', 'query', '--k', 'abc'])).toThrow('process.exit');
        expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("invalid --k value 'abc'"));
        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('calls process.exit(1) for --k=abc (equals-sign form)', () => {
        const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
            throw new Error('process.exit');
        }) as never);

        expect(() => parseSemanticArgs(['search', 'query', '--k=abc'])).toThrow('process.exit');
        expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("invalid --k value 'abc'"));
        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('calls process.exit(1) for --k=0 (non-positive)', () => {
        const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
            throw new Error('process.exit');
        }) as never);

        expect(() => parseSemanticArgs(['search', 'query', '--k=0'])).toThrow('process.exit');
        expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("must be greater than 0"));
        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('calls process.exit(1) for negative --k', () => {
        const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
            throw new Error('process.exit');
        }) as never);

        expect(() => parseSemanticArgs(['search', 'query', '--k=-5'])).toThrow('process.exit');
        expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("must be greater than 0"));
        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('accepts a valid positive --k value', () => {
        const args = parseSemanticArgs(['search', 'my query', '--k', '5']);
        expect(args.k).toBe(5);
    });

    it('accepts valid --k= form', () => {
        const args = parseSemanticArgs(['search', 'my query', '--k=10']);
        expect(args.k).toBe(10);
    });
});

// ---------------------------------------------------------------------------
// F5 — --kinds validation
// ---------------------------------------------------------------------------

describe('parseSemanticArgs — --kinds validation (F5)', () => {
    it('calls process.exit(1) for unknown kind', () => {
        const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
            throw new Error('process.exit');
        }) as never);

        expect(() => parseSemanticArgs(['search', 'q', '--kinds=banana'])).toThrow('process.exit');
        expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('banana'));
        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('calls process.exit(1) for partially unknown kinds list', () => {
        const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
            throw new Error('process.exit');
        }) as never);

        expect(() => parseSemanticArgs(['search', 'q', '--kinds=service,banana'])).toThrow('process.exit');
        expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('banana'));
        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('accepts valid kinds', () => {
        const args = parseSemanticArgs(['search', 'q', '--kinds=service,lib']);
        expect(args.kinds).toEqual(['service', 'lib']);
    });

    it('accepts --kinds space-separated form', () => {
        const args = parseSemanticArgs(['search', 'q', '--kinds', 'service,db-table']);
        expect(args.kinds).toEqual(['service', 'db-table']);
    });
});

// ---------------------------------------------------------------------------
// F3 — table mode: embedError branch is shown before "No results found"
// ---------------------------------------------------------------------------

describe('runSemanticSearch — embedError in table mode (F3)', () => {
    it('writes embedError to stderr in table mode instead of "No results found"', async () => {
        // Write a valid sidecar
        const { SEMANTIC_MODEL, SEMANTIC_DIM, SEMANTIC_SCHEMA_VERSION } = await import('../semantic/types.js');
        const manifestContent = JSON.stringify({
            schemaVersion: SEMANTIC_SCHEMA_VERSION,
            model: SEMANTIC_MODEL,
            dim: SEMANTIC_DIM,
            builtAt: '2026-05-16T00:00:00.000Z',
            graphHash: 'a'.repeat(64),
            nodeCount: 0,
        });
        await writeFile(join(testDir, 'semantic', 'manifest.json'), manifestContent, 'utf8');
        await writeFile(join(testDir, 'semantic', 'embeddings.jsonl'), '', 'utf8');
        // graph.json with matching hash (but we use a placeholder — hash check will fail, stale warning)
        await writeFile(join(testDir, 'graph.json'), '{}', 'utf8');

        const stderrLines: string[] = [];
        const stdoutLines: string[] = [];
        const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((s) => {
            stderrLines.push(String(s));
            return true;
        });
        const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
            stdoutLines.push(String(s));
            return true;
        });
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
            throw new Error('process.exit');
        }) as never);

        // Use a search module mock to return embedError without needing a real embedder
        const searchModule = await import('../semantic/search.js');
        const searchSpy = vi.spyOn(searchModule, 'semanticSearch').mockResolvedValue({
            output: {
                query: 'q',
                results: [],
                model: SEMANTIC_MODEL,
                dim: SEMANTIC_DIM,
                indexBuiltAt: '2026-05-16T00:00:00.000Z',
                graphHashMatches: false,
                embedError: 'model unavailable',
            },
            exitCode: 1,
            stderrWarning: undefined,
        });

        try {
            await runSemanticSearch({
                sub: 'search',
                config: './arch-graph.config.ts',
                out: testDir,
                query: 'q',
                format: 'table',
                k: undefined,
                kinds: undefined,
            });
        } catch {
            // process.exit throws
        }

        const stderrOutput = stderrLines.join('');
        const stdoutOutput = stdoutLines.join('');

        expect(stderrOutput).toContain('embedding failed');
        expect(stderrOutput).toContain('model unavailable');
        // Must NOT say "No results found" in stdout
        expect(stdoutOutput).not.toContain('No results found');

        stderrSpy.mockRestore();
        stdoutSpy.mockRestore();
        exitSpy.mockRestore();
        searchSpy.mockRestore();
    });
});

// ---------------------------------------------------------------------------
// P1-3 — validateSnippetRecall is wired into runSemanticBuild
// ---------------------------------------------------------------------------

describe('runSemanticBuild — validateSnippetRecall wiring (P1-3)', () => {
    it('calls validateSnippetRecall after a successful build and prints recall lines', async () => {
        // Arrange: write a minimal config, graph.json, and sidecar so runSemanticBuild
        // can load and succeed without needing real source files.
        const { SEMANTIC_MODEL, SEMANTIC_DIM, SEMANTIC_SCHEMA_VERSION } = await import('../semantic/types.js');

        // Write a minimal arch-graph.config.ts (loadConfig will require it).
        // We mock loadConfig and buildSemanticIndex to avoid real I/O.
        const configModule = await import('../core/config.js');
        const configSpy = vi.spyOn(configModule, 'loadConfig').mockResolvedValue({
            id: 'test-repo',
            root: testDir,
            appsGlob: 'apps/**',
            libsGlob: undefined,
            excludeGlobs: undefined,
        });

        const builderModule = await import('../semantic/builder.js');
        const manifest = {
            schemaVersion: SEMANTIC_SCHEMA_VERSION,
            model: SEMANTIC_MODEL,
            dim: SEMANTIC_DIM,
            builtAt: '2026-05-16T00:00:00.000Z',
            graphHash: 'a'.repeat(64),
            nodeCount: 1,
        };
        const buildSpy = vi.spyOn(builderModule, 'buildSemanticIndex').mockResolvedValue({
            manifest,
            diagnostics: {
                model: SEMANTIC_MODEL,
                dim: SEMANTIC_DIM,
                schemaVersion: SEMANTIC_SCHEMA_VERSION,
                counts: { indexed: 1, skipped: 0, fileReadErrors: 0, transformerErrors: 0, labelErrors: 0 },
                skippedNodes: [],
                skippedNodesTruncated: false,
                indexSizeBytes: 100,
            },
        });

        // Write graph.json so readFile doesn't fail
        await writeFile(join(testDir, 'graph.json'), JSON.stringify({
            version: '1', buildAt: '', root: testDir, nodes: [], edges: [],
        }), 'utf8');

        // Mock validateSnippetRecall in the validator module
        const validatorModule = await import('../validation/snippet-recall-validator.js');
        const recallSpy = vi.spyOn(validatorModule, 'validateSnippetRecall').mockResolvedValue({
            passed: true,
            byKind: [{ kind: 'provider', total: 10, filled: 10, fillRate: 1.0, floor: 0.95, passed: true }],
            totalNodes: 10,
            totalFilled: 10,
            aggregateFillRate: 1.0,
            failures: [],
            malformedLines: 0,
        });

        const stdoutLines: string[] = [];
        vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
            stdoutLines.push(String(s));
            return true;
        });
        vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

        await runSemanticBuild({
            sub: 'build',
            config: join(testDir, 'arch-graph.config.ts'),
            out: testDir,
            format: 'json',
        });

        // validateSnippetRecall must have been called
        expect(recallSpy).toHaveBeenCalledWith(join(testDir, 'semantic'));
        // stdout should contain a recall line
        const stdoutOutput = stdoutLines.join('');
        expect(stdoutOutput).toContain('recall:');
        expect(stdoutOutput).toContain('provider');

        configSpy.mockRestore();
        buildSpy.mockRestore();
        recallSpy.mockRestore();
    });
});
